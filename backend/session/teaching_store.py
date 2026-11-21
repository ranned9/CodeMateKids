"""教学会话索引：按 scope 隔离、锁内只做内存更新、各类索引有界。"""

from __future__ import annotations

import threading
from collections import OrderedDict
from typing import Any

MAX_SCOPES = 256
MAX_ENTRIES_PER_SCOPE = 256
MAX_SEEN_HINTS = 8


class TeachingStore:
    def __init__(self, max_scopes: int = MAX_SCOPES) -> None:
        self._lock = threading.Lock()
        self._max_scopes = max_scopes
        self._scopes: OrderedDict[str, dict[str, Any]] = OrderedDict()

    def _scope(self, key: str) -> dict[str, Any]:
        scope = self._scopes.get(key)
        if scope is None:
            scope = {
                "predictions": OrderedDict(),
                "runs": OrderedDict(),
                "issuedHints": OrderedDict(),
                "confirmedLevel": 0,
                "seenHints": [],
                "structure": None,
            }
            self._scopes[key] = scope
            while len(self._scopes) > self._max_scopes:
                self._scopes.popitem(last=False)
        else:
            self._scopes.move_to_end(key)
        return scope

    @staticmethod
    def scope_key(scope: dict[str, Any] | None) -> str:
        scope = scope or {}
        parts = (
            str(scope.get("courseId") or "demo-loop"),
            str(scope.get("contentVersion") or ""),
            str(scope.get("taskId") or ""),
            str(scope.get("workspaceId") or ""),
        )
        return "|".join(parts)

    def put_prediction(self, key: str, prediction_id: str, value: int, digest: str | None = None) -> None:
        with self._lock:
            store = self._scope(key)["predictions"]
            store[prediction_id] = {"value": int(value), "digest": digest}
            _trim(store)

    def get_prediction(self, key: str, prediction_id: str) -> dict[str, Any] | None:
        with self._lock:
            item = self._scope(key)["predictions"].get(prediction_id)
            return dict(item) if item else None

    def put_run(self, key: str, run_id: str, payload: dict[str, Any]) -> None:
        with self._lock:
            store = self._scope(key)["runs"]
            store[run_id] = dict(payload)
            _trim(store)

    def recent_runs(self, key: str, limit: int = 2) -> list[dict[str, Any]]:
        with self._lock:
            runs = self._scopes.get(key, {}).get("runs", {})
            return [dict(item) for item in list(runs.values())[-limit:]]

    def issue_hint(self, key: str, hint_id: str, payload: dict[str, Any]) -> None:
        with self._lock:
            hints = self._scope(key)["issuedHints"]
            hints[hint_id] = {**payload, "hintId": hint_id}
            _trim(hints)

    def confirm_hints(self, key: str, ids: list[str] | None) -> tuple[list[dict[str, Any]], list[str]]:
        with self._lock:
            scope = self._scopes.get(key)
            if scope is None:
                return [], []
            hints = scope["issuedHints"]
            resolved = []
            newly_seen = []
            for hint_id in dict.fromkeys(ids or []):
                if hint_id not in hints:
                    continue
                hint = hints[hint_id]
                if not hint.get("seen"):
                    hint["seen"] = True
                    scope["confirmedLevel"] = max(scope["confirmedLevel"], hint["level"])
                    newly_seen.append(hint_id)
                resolved.append(dict(hint))
            return resolved, newly_seen

    def confirmed_level(self, key: str) -> int:
        with self._lock:
            return self._scopes.get(key, {}).get("confirmedLevel", 0)

    def get_run(self, key: str, run_id: str) -> dict[str, Any] | None:
        with self._lock:
            item = self._scope(key)["runs"].get(run_id)
            return dict(item) if item else None

    def add_seen_hint(self, key: str, hint_id: str) -> bool:
        with self._lock:
            seen = self._scope(key)["seenHints"]
            if hint_id in seen:
                return False
            seen.append(hint_id)
            if len(seen) > MAX_SEEN_HINTS:
                del seen[: len(seen) - MAX_SEEN_HINTS]
            return True

    def seen_hints(self, key: str) -> list[str]:
        with self._lock:
            return list(self._scope(key)["seenHints"])

    def put_structure(self, key: str, report: dict[str, Any]) -> None:
        with self._lock:
            self._scope(key)["structure"] = dict(report)

    def get_structure(self, key: str) -> dict[str, Any] | None:
        with self._lock:
            report = self._scope(key)["structure"]
            return dict(report) if report else None

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "scopes": len(self._scopes),
                "entries": sum(
                    len(scope["predictions"]) + len(scope["runs"]) for scope in self._scopes.values()
                ),
            }


def _trim(store: OrderedDict[str, Any]) -> None:
    while len(store) > MAX_ENTRIES_PER_SCOPE:
        store.popitem(last=False)
