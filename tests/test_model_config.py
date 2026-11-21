"""DV-WM-01/02：配置状态机、快照、原子变更与配置接口。"""

from __future__ import annotations

import json
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.infra.config import load_settings
from backend.infra.errors import ERROR_SPECS
from backend.tutor.chat_adapter import ParsedContent
from backend.tutor.model_config import (
    ADAPTER_CHAT,
    ADAPTER_LEGACY,
    ADAPTER_NONE,
    ALLOWED_ACTIONS,
    EFFECTIVE_MODES,
    FAILURE_CATEGORIES,
    SOURCES,
    TARGET_REFS,
    ModelConfigError,
    ModelConfigStore,
)

ROOT = Path(__file__).resolve().parent.parent


def _fixture() -> dict:
    return json.loads((ROOT / "tests" / "fixtures" / "model-config-expected.json").read_text(encoding="utf-8"))


def _settings(**env):
    base = {"CMK_LOG_DIR": str(ROOT / "logs-test"), "CMK_TUTOR_MODE": "mock"}
    base.update(env)
    return load_settings(base)


def test_constants_match_fixture() -> None:
    fixture = _fixture()
    assert list(SOURCES) == fixture["SOURCES"]
    assert list(EFFECTIVE_MODES) == fixture["EFFECTIVE_MODES"]
    assert list(FAILURE_CATEGORIES) == fixture["FAILURE_CATEGORIES"]
    assert list(ALLOWED_ACTIONS) == fixture["ALLOWED_ACTIONS"]
    assert list(TARGET_REFS) == fixture["TARGET_REFS"]


def test_default_snapshot_and_no_secret_leak() -> None:
    store = ModelConfigStore(_settings())
    snapshot = store.snapshot()
    assert snapshot.source == "default"
    assert snapshot.effectiveMode == "mock"
    assert snapshot.revision == 0
    assert snapshot.public_view() == {
        "effectiveMode": "mock",
        "source": "default",
        "revision": 0,
        "baseUrl": None,
        "model": None,
        "apiKeyConfigured": False,
    }
    assert "testId" not in snapshot.public_view()
    assert "secret" not in repr(store)


def test_environment_source_uses_legacy_adapter() -> None:
    settings = _settings(
        CMK_MODEL_ENDPOINT="https://provider.example/v1",
        CMK_MODEL_KEY="secret-key",
        CMK_TUTOR_MODE="model",
    )
    store = ModelConfigStore(settings)
    snapshot = store.snapshot()
    assert snapshot.source == "environment"
    assert snapshot.effectiveMode == "model"
    assert snapshot.apiKeyConfigured is True
    assert "secret-key" not in repr(snapshot.public_view())
    assert store._adapter == ADAPTER_LEGACY


def test_activate_flow_increments_revision_once() -> None:
    store = ModelConfigStore(_settings())
    sequence = store.begin_test(0)
    pending = store.finish_test(sequence, base_url="https://provider.example/v1", model="m1", api_key="k1")
    assert pending is not None
    assert pending.testId
    before = store.snapshot()
    snapshot = store.activate(0, pending.testId)
    assert snapshot.source == "web"
    assert snapshot.effectiveMode == "model"
    assert snapshot.revision == before.revision + 1
    assert snapshot.baseUrl == "https://provider.example/v1"
    assert snapshot.model == "m1"
    assert snapshot.apiKeyConfigured is True
    assert store._adapter == ADAPTER_CHAT
    with pytest.raises(ModelConfigError) as raised:
        store.activate(snapshot.revision, pending.testId)
    assert raised.value.category == "expired"


def test_conflict_does_not_change_state() -> None:
    store = ModelConfigStore(_settings())
    before = store.snapshot()
    with pytest.raises(ModelConfigError) as raised:
        store.begin_test(3)
    assert raised.value.category == "conflict"
    assert store.snapshot() == before


def test_pending_expires_with_monotonic_clock() -> None:
    now = {"value": 0.0}
    store = ModelConfigStore(_settings(), clock=lambda: now["value"])
    sequence = store.begin_test(0)
    pending = store.finish_test(sequence, base_url="https://h.example/v1", model="m", api_key="k")
    now["value"] = 601
    with pytest.raises(ModelConfigError) as raised:
        store.activate(0, pending.testId)
    assert raised.value.category == "expired"
    assert store.snapshot().source == "default"


def test_latest_test_wins_and_previous_is_dropped() -> None:
    store = ModelConfigStore(_settings())
    first_sequence = store.begin_test(0)
    second_sequence = store.begin_test(0)
    assert store.finish_test(first_sequence, base_url="https://a.example/v1", model="a", api_key="ka") is None, (
        "旧测试序号不得落地候选"
    )
    second = store.finish_test(second_sequence, base_url="https://b.example/v1", model="b", api_key="kb")
    assert second is not None
    with pytest.raises(ModelConfigError):
        store.activate(0, "not-a-real-test")


def test_disable_is_idempotent_when_already_mock() -> None:
    store = ModelConfigStore(_settings())
    before = store.snapshot()
    assert store.disable(0) == before


def test_concurrent_activate_only_one_succeeds() -> None:
    store = ModelConfigStore(_settings())
    pending = store.finish_test(store.begin_test(0), base_url="https://h.example/v1", model="m", api_key="k")
    results = []

    def attempt() -> None:
        try:
            store.activate(0, pending.testId)
            results.append("ok")
        except ModelConfigError:
            results.append("fail")

    threads = [threading.Thread(target=attempt) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(results) == ["fail", "ok"]


def test_error_specs_have_no_model_namespace() -> None:
    assert not [code for code in ERROR_SPECS if code.startswith("MODEL_")], "WQ-02 未放行，码表零新增"


def _headers(settings, origin: bool = True) -> dict:
    headers = {"host": f"127.0.0.1:{settings.port}"}
    if origin:
        headers["origin"] = f"http://127.0.0.1:{settings.port}"
    return headers


def test_get_requires_loopback_and_no_store(settings) -> None:
    client = TestClient(create_app(settings))
    response = client.get("/api/v1/tutor/model-config", headers=_headers(settings, origin=False))
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert len(response.json()["data"]) == 6

    denied = client.get("/api/v1/tutor/model-config")
    assert denied.status_code == 403


def test_post_requires_same_origin(settings) -> None:
    client = TestClient(create_app(settings))
    body = {"expectedRevision": 0, "baseUrl": "https://provider.example/v1", "model": "m", "apiKey": "k"}
    missing = client.post("/api/v1/tutor/model-config/test", headers=_headers(settings, origin=False), json=body)
    assert missing.status_code == 403
    cross = client.post(
        "/api/v1/tutor/model-config/test",
        headers={"host": f"127.0.0.1:{settings.port}", "origin": "http://evil.example"},
        json=body,
    )
    assert cross.status_code == 403


def test_model_config_explains_deepseek_public_dns_failure(settings, monkeypatch) -> None:
    from backend.infra import net_policy

    app = create_app(settings)
    app.state.model_resolver = lambda host: ["198.18.0.89"]
    monkeypatch.setattr(net_policy, "_resolve_deepseek_public", lambda: [])
    with TestClient(app) as client:
        response = client.post("/api/v1/tutor/model-config/test", headers=_headers(settings), json={
            "expectedRevision": 0, "baseUrl": "https://api.deepseek.com", "model": "deepseek-flash", "apiKey": "fixture-key",
        })
    assert response.status_code == 403
    assert "Fake-IP" in response.json()["error"]["messageForChild"]


def test_test_endpoint_uses_injected_probe(settings) -> None:
    app = create_app(settings)
    calls = []

    def fake_probe(target, model, api_key, timeout_s):
        calls.append((target.chatUrl, model, api_key))
        return ParsedContent(text='{"status":"ok"}')

    app.state.model_probe = fake_probe
    app.state.model_resolver = lambda host: ["93.184.216.34"]
    client = TestClient(app)
    body = {"expectedRevision": 0, "baseUrl": "https://provider.example/v1", "model": "m1", "apiKey": "k1"}
    response = client.post("/api/v1/tutor/model-config/test", headers=_headers(settings), json=body)
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert set(data) == {"testId", "revision", "model", "latencyMs", "expiresAt"}
    assert calls and calls[0][0].endswith("/chat/completions")
    assert data["expiresAt"].endswith("Z")
    assert response.headers["cache-control"] == "no-store"

    activated = client.post(
        "/api/v1/tutor/model-config/activate",
        headers=_headers(settings),
        json={"expectedRevision": 0, "testId": data["testId"]},
    )
    assert activated.status_code == 200, activated.text
    assert activated.json()["data"]["revision"] == 1

    disabled = client.post(
        "/api/v1/tutor/model-config/disable",
        headers=_headers(settings),
        json={"expectedRevision": 1},
    )
    assert disabled.status_code == 200
    assert disabled.json()["data"]["source"] == "web"
    assert disabled.json()["data"]["effectiveMode"] == "mock"
    assert disabled.json()["data"]["apiKeyConfigured"] is True


def test_web_model_survives_restart_including_demo_mode(settings):
    app = create_app(settings)

    def resolver(host):
        return ["93.184.216.34"]

    app.state.model_resolver = resolver
    probe_keys = []

    def model_probe(target, model, api_key, timeout):
        probe_keys.append(api_key)
        return ParsedContent(text='{"status":"ok"}')

    app.state.model_probe = model_probe
    headers = _headers(settings)
    body = {"expectedRevision": 0, "baseUrl": "https://provider.example", "model": "test-model"}
    with TestClient(app) as client:
        result = client.post("/api/v1/tutor/model-config/test", headers=headers, json={**body, "apiKey": "fixture-only"})
        assert result.status_code == 200
        test_id = result.json()["data"]["testId"]
        assert app.state.model_config.active().adapter == ADAPTER_NONE

    with TestClient(create_app(settings)) as client:
        snapshot = client.get("/api/v1/tutor/model-config", headers=headers)
        data = snapshot.json()["data"]
        assert data["effectiveMode"] == "mock" and data["apiKeyConfigured"] is True
        assert data["testedConfig"] == {"baseUrl": body["baseUrl"], "model": body["model"], "testId": test_id}
        assert "fixture-only" not in snapshot.text
        activated = client.post("/api/v1/tutor/model-config/activate", headers=headers, json={
            "expectedRevision": data["revision"], "testId": test_id,
        })
        assert activated.status_code == 200
        assert "testedConfig" not in activated.json()["data"]

    restarted = create_app(settings)
    restarted.state.model_probe = model_probe
    restarted.state.model_resolver = resolver
    with TestClient(restarted) as client:
        snapshot = client.get("/api/v1/tutor/model-config", headers=headers)
        assert snapshot.json()["data"]["effectiveMode"] == "model"
        assert "fixture-only" not in snapshot.text
        assert client.post("/api/v1/tutor/model-config/test", headers=headers, json={**body, "model": "other-model"}).status_code == 200
        assert restarted.state.model_config.active().model == body["model"]
        assert client.post("/api/v1/tutor/model-config/test", headers=headers, json={
            **body, "baseUrl": "https://other.example",
        }).status_code == 422
        assert client.post("/api/v1/tutor/model-config/disable", headers=headers, json={"expectedRevision": 0}).status_code == 200

    with TestClient(create_app(settings)) as client:
        snapshot = client.get("/api/v1/tutor/model-config", headers=headers).json()["data"]
        assert snapshot["effectiveMode"] == "mock" and snapshot["apiKeyConfigured"] is True
        assert snapshot["testedConfig"]["model"] == "other-model"
        resumed = client.post("/api/v1/tutor/model-config/activate", headers=headers, json={"expectedRevision": 0})
        assert resumed.status_code == 200 and resumed.json()["data"]["effectiveMode"] == "model"
        assert resumed.json()["data"]["model"] == body["model"]
    assert probe_keys == ["fixture-only", "fixture-only"]


def test_save_failure_does_not_report_credentials_saved(settings) -> None:
    unusable_path = settings.log_dir / "model-config.local.json"
    unusable_path.mkdir(parents=True)
    app = create_app(settings)
    app.state.model_resolver = lambda host: ["93.184.216.34"]
    app.state.model_probe = lambda *args: ParsedContent(text='{"status":"ok"}')
    body = {"expectedRevision": 0, "baseUrl": "https://provider.example", "model": "m", "apiKey": "fixture-only"}
    with TestClient(app) as client:
        response = client.post("/api/v1/tutor/model-config/test", headers=_headers(settings), json=body)
        assert response.status_code == 500
        assert response.json()["error"]["category"] == "storage"
        assert app.state.model_config.snapshot().apiKeyConfigured is False
        assert not list(settings.log_dir.glob("tmp*.local.json"))


def test_activation_save_failure_preserves_saved_candidate(tmp_path, monkeypatch) -> None:
    unusable_path = tmp_path / "configuration-directory"
    store = ModelConfigStore(_settings(), persist_path=unusable_path)
    pending = store.finish_test(store.begin_test(0), base_url="https://provider.example", model="m", api_key="k")

    def fail_replace(*args):
        raise OSError("fixture write failure")

    with monkeypatch.context() as patch:
        patch.setattr(Path, "replace", fail_replace)
        with pytest.raises(ModelConfigError, match="storage"):
            store.activate(0, pending.testId)
    assert store.snapshot().effectiveMode == "mock"
    assert list(tmp_path.iterdir()) == [unusable_path]
    assert store.activate(0, pending.testId).effectiveMode == "model"


def test_restores_previous_flat_config(tmp_path) -> None:
    path = tmp_path / "model-config.local.json"
    path.write_text(json.dumps({
        "baseUrl": "https://provider.example", "model": "m", "apiKey": "fixture-only", "enabled": True,
    }), encoding="utf-8")
    store = ModelConfigStore(_settings(), persist_path=path)
    assert store.active().adapter == ADAPTER_CHAT
    assert store.saved_key("https://provider.example", "m") == "fixture-only"


def test_activate_rejects_credentials_and_bad_revision(settings) -> None:
    app = create_app(settings)
    client = TestClient(app)
    bad = client.post(
        "/api/v1/tutor/model-config/activate",
        headers=_headers(settings),
        json={"expectedRevision": 0, "testId": "t-1", "apiKey": "k"},
    )
    assert bad.status_code == 422
    stale = client.post(
        "/api/v1/tutor/model-config/disable",
        headers=_headers(settings),
        json={"expectedRevision": 9},
    )
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "RUN_ID_CONFLICT"
