"""本地模型配置及连接测试状态。

前端镜像见 `frontend/js/ux/modelConfigState.js`；枚举一致性由测试强制。
"""

from __future__ import annotations

import json
import secrets
import tempfile
import threading
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

from backend.infra.config import Settings
from backend.infra.net_policy import ModelTargetError, validate_target

SOURCE_DEFAULT = "default"
SOURCE_ENVIRONMENT = "environment"
SOURCE_WEB = "web"
SOURCES = (SOURCE_DEFAULT, SOURCE_ENVIRONMENT, SOURCE_WEB)

EFFECTIVE_MODE_MOCK = "mock"
EFFECTIVE_MODE_MODEL = "model"
EFFECTIVE_MODES = (EFFECTIVE_MODE_MOCK, EFFECTIVE_MODE_MODEL)

ADAPTER_NONE = "none"
ADAPTER_LEGACY = "legacy"
ADAPTER_CHAT = "chat"
ADAPTERS = (ADAPTER_NONE, ADAPTER_LEGACY, ADAPTER_CHAT)

FAILURE_CATEGORIES = (
    "invalid",
    "forbidden",
    "conflict",
    "expired",
    "auth",
    "endpoint",
    "rate_limit",
    "timeout",
    "refusal",
    "invalid_response",
    "storage",
)

ALLOWED_ACTIONS = (
    "ask_question",
    "point_to_block",
    "show_execution",
    "hint",
    "offer_variant",
)

TARGET_REFS = (
    "loopBlock",
    "moveBlock",
    "outsideMoveBlock",
    "verifiedReplay",
    "nextTask",
)

PENDING_TTL_SECONDS = 600

CATEGORY_TO_EXISTING_CODE = {
    "invalid": "PROGRAM_SCHEMA_INVALID",
    "forbidden": "FORBIDDEN",
    "conflict": "RUN_ID_CONFLICT",
    "expired": "COURSE_VERSION_UNSUPPORTED",
    "failed": "TUTOR_UNAVAILABLE",
}


@dataclass(frozen=True)
class ConfigSnapshot:
    effectiveMode: str
    source: str
    revision: int
    baseUrl: str | None
    model: str | None
    apiKeyConfigured: bool
    testedConfig: dict[str, str] | None = None

    def public_view(self) -> dict[str, Any]:
        view = {
            "effectiveMode": self.effectiveMode,
            "source": self.source,
            "revision": self.revision,
            "baseUrl": self.baseUrl,
            "model": self.model,
            "apiKeyConfigured": self.apiKeyConfigured,
        }
        if self.testedConfig is not None:
            view["testedConfig"] = self.testedConfig
        return view


@dataclass
class PendingTest:
    testId: str
    revision: int
    baseUrl: str
    model: str
    apiKey: str = field(repr=False)
    sequence: int
    startedAt: float
    expiresAt: str

    def public_view(self, latency_ms: int) -> dict[str, Any]:
        return {
            "testId": self.testId,
            "revision": self.revision,
            "model": self.model,
            "latencyMs": int(latency_ms),
            "expiresAt": self.expiresAt,
        }


class ModelConfigError(Exception):
    """配置失败类别；路由映射到既有错误码，不新增错误码。"""

    def __init__(self, category: str) -> None:
        self.category = category if category in FAILURE_CATEGORIES else "invalid"
        super().__init__(self.category)


def _utc_expiry(ttl: float) -> str:
    now = datetime.now(timezone.utc)
    return (now + timedelta(seconds=ttl)).isoformat().replace("+00:00", "Z")


@dataclass(frozen=True)
class ActiveModel:
    revision: int
    adapter: str
    base_url: str | None
    model: str | None
    api_key: str | None = field(repr=False)


@dataclass(frozen=True)
class SavedModel:
    baseUrl: str
    model: str
    apiKey: str = field(repr=False)
    testId: str | None = None

    @classmethod
    def from_disk(cls, data: Any) -> SavedModel | None:
        if not isinstance(data, dict):
            return None
        base_url, model, key = (data.get(name) for name in ("baseUrl", "model", "apiKey"))
        if not all(isinstance(value, str) and value for value in (base_url, model, key)):
            return None
        if len(model) > 160 or len(key) > 2048 or any(not 33 <= ord(char) <= 126 for char in key):
            return None
        test_id = data.get("testId")
        if test_id is not None and (not isinstance(test_id, str) or not 1 <= len(test_id) <= 128):
            return None
        try:
            target = validate_target(base_url, resolve=False)
        except ModelTargetError:
            return None
        return cls(target.baseUrl, model, key, test_id)


class ModelConfigStore:
    def __init__(
        self,
        settings: Settings,
        clock: Callable[[], float] | None = None,
        token_factory: Callable[[], str] | None = None,
        *,
        persist_path: Path | None = None,
    ) -> None:
        self._settings = settings
        self._persist_path = persist_path
        self._clock = clock or time.monotonic
        self._token = token_factory or (lambda: f"t-{secrets.token_hex(8)}")
        self._lock = threading.Lock()
        self._revision = 0
        self._source = SOURCE_DEFAULT
        self._mode = EFFECTIVE_MODE_MOCK
        self._adapter = ADAPTER_NONE
        self._web: SavedModel | None = None
        self._tested: SavedModel | None = None
        self._pending: PendingTest | None = None
        self._expiry: threading.Timer | None = None
        self._latest_sequence = 0
        self._sequence = 0
        self._apply_environment()
        self._restore()

    def _apply_environment(self) -> None:
        settings = self._settings
        if settings.tutor_mode == "model" and settings.model_endpoint and settings.model_key:
            self._source = SOURCE_ENVIRONMENT
            self._adapter = ADAPTER_LEGACY
            self._mode = EFFECTIVE_MODE_MODEL if settings.tutor_mode == "model" else EFFECTIVE_MODE_MOCK
            return
        self._source = SOURCE_DEFAULT
        self._adapter = ADAPTER_NONE
        self._mode = EFFECTIVE_MODE_MOCK

    def _restore(self) -> None:
        if self._persist_path is None:
            return
        try:
            data = json.loads(self._persist_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        if not isinstance(data, dict):
            return
        active = data.get("active", data)
        web = SavedModel.from_disk(active)
        if web is not None and type(active.get("enabled")) is bool:
            self._set_web(web, active["enabled"])
        tested = SavedModel.from_disk(data.get("tested"))
        if tested is not None and tested.testId is not None:
            self._tested = tested

    def _set_web(self, config: SavedModel, enabled: bool) -> None:
        self._source = SOURCE_WEB
        self._mode = EFFECTIVE_MODE_MODEL if enabled else EFFECTIVE_MODE_MOCK
        self._adapter = ADAPTER_CHAT if enabled else ADAPTER_NONE
        self._web = config

    def _save(self, web: SavedModel | None, tested: SavedModel | None, *, enabled: bool) -> None:
        if self._persist_path is None:
            return
        temporary = None
        try:
            self._persist_path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self._persist_path.parent,
                                             suffix=".local.json", delete=False) as output:
                temporary = Path(output.name)
                json.dump({
                    "active": {**asdict(web), "enabled": enabled} if web is not None else None,
                    "tested": asdict(tested) if tested is not None else None,
                }, output, ensure_ascii=False)
            temporary.replace(self._persist_path)
        except OSError as exc:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass
            raise ModelConfigError("storage") from exc

    def snapshot(self) -> ConfigSnapshot:
        with self._lock:
            return self._snapshot_locked()

    def _snapshot_locked(self) -> ConfigSnapshot:
        tested = self._tested
        return ConfigSnapshot(
            effectiveMode=self._mode,
            source=self._source,
            revision=self._revision,
            baseUrl=self._web.baseUrl if self._web else None,
            model=self._web.model if self._web else None,
            apiKeyConfigured=bool(self._web or tested or (self._adapter == ADAPTER_LEGACY and self._settings.model_key)),
            testedConfig={"baseUrl": tested.baseUrl, "model": tested.model, "testId": tested.testId}
            if tested and tested.testId else None,
        )

    def active(self) -> ActiveModel:
        with self._lock:
            web = self._web
            return ActiveModel(self._revision, self._adapter, web.baseUrl if web else None,
                               web.model if web else None, web.apiKey if web else None)

    def current_revision(self) -> int:
        with self._lock:
            return self._revision

    def saved_key(self, base_url: str, model: str) -> str | None:
        with self._lock:
            matches = [config for config in (self._tested, self._web) if config and config.baseUrl == base_url.rstrip("/")]
            for config in matches:
                if config.model == model:
                    return config.apiKey
            return matches[0].apiKey if matches else None

    def begin_test(self, expected_revision: int) -> int:
        with self._lock:
            if expected_revision != self._revision:
                raise ModelConfigError("conflict")
            self._sequence += 1
            self._latest_sequence = self._sequence
            self._drop_pending()
            return self._sequence

    def finish_test(
        self,
        sequence: int,
        *,
        base_url: str,
        model: str,
        api_key: str,
        failed: bool = False,
    ) -> PendingTest | None:
        with self._lock:
            if sequence != self._latest_sequence:
                return None
            if failed:
                self._drop_pending()
                return None
            now = self._clock()
            pending = PendingTest(
                testId=self._token(),
                revision=self._revision,
                baseUrl=base_url,
                model=model,
                apiKey=api_key,
                sequence=sequence,
                startedAt=now,
                expiresAt=_utc_expiry(PENDING_TTL_SECONDS),
            )
            if self._persist_path is not None:
                tested = SavedModel(base_url, model, api_key, pending.testId)
                self._save(self._web, tested, enabled=self._mode == EFFECTIVE_MODE_MODEL)
                self._tested = tested
                return pending
            self._drop_pending()
            self._pending = pending
            self._expiry = threading.Timer(PENDING_TTL_SECONDS, self._expire, args=(pending,))
            self._expiry.daemon = True
            self._expiry.start()
            return pending

    def activate(self, expected_revision: int, test_id: str | None) -> ConfigSnapshot:
        with self._lock:
            if expected_revision != self._revision:
                raise ModelConfigError("conflict")
            tested = self._tested
            if test_id is None:
                if self._web is None:
                    raise ModelConfigError("expired")
                if self._mode == EFFECTIVE_MODE_MODEL:
                    return self._snapshot_locked()
                web = self._web
            elif tested is not None and tested.testId == test_id:
                web = SavedModel(tested.baseUrl, tested.model, tested.apiKey)
                tested = None
            else:
                pending = self._pending
                if pending is None or pending.testId != test_id:
                    raise ModelConfigError("expired")
                if self._clock() - pending.startedAt >= PENDING_TTL_SECONDS:
                    self._drop_pending()
                    raise ModelConfigError("expired")
                web = SavedModel(pending.baseUrl, pending.model, pending.apiKey)
            self._save(web, tested, enabled=True)
            self._set_web(web, enabled=True)
            self._tested = tested
            self._drop_pending()
            self._latest_sequence = 0
            self._revision += 1
            return self._snapshot_locked()

    def disable(self, expected_revision: int) -> ConfigSnapshot:
        with self._lock:
            if expected_revision != self._revision:
                raise ModelConfigError("conflict")
            if self._mode == EFFECTIVE_MODE_MOCK and self._latest_sequence == 0:
                return self._snapshot_locked()
            if self._web:
                self._save(self._web, self._tested, enabled=False)
            self._drop_pending()
            self._latest_sequence = 0
            self._mode = EFFECTIVE_MODE_MOCK
            self._adapter = ADAPTER_NONE
            self._source = SOURCE_WEB
            self._revision += 1
            return self._snapshot_locked()

    def _drop_pending(self) -> None:
        if self._expiry is not None:
            self._expiry.cancel()
            self._expiry = None
        if self._pending is not None:
            self._pending.apiKey = ""
        self._pending = None

    def _expire(self, pending: PendingTest) -> None:
        with self._lock:
            if self._pending is pending:
                self._drop_pending()

    def __repr__(self) -> str:
        with self._lock:
            return (
                f"ModelConfigStore(source={self._source!r}, mode={self._mode!r}, "
                f"revision={self._revision}, apiKeyConfigured={self._snapshot_locked().apiKeyConfigured})"
            )
