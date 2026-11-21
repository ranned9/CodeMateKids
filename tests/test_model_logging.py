"""T-WM-11：日志白名单扩展、脱敏与事件登记。"""

from __future__ import annotations

import re
from pathlib import Path

from backend.infra.logging import ALLOWED_FIELDS, project_record, tail_logs, write_log

FORBIDDEN_FIELDS = ("fallbackReason", "message", "answer", "baseUrl", "model", "apiKey")


def test_three_model_fields_are_whitelisted() -> None:
    assert {"modelSource", "modelRevision", "modelCategory"}.issubset(set(ALLOWED_FIELDS))


def test_forbidden_fields_are_dropped() -> None:
    record = {field: "secret" for field in FORBIDDEN_FIELDS}
    record.update({"event": "tutor_fallback", "modelSource": "web", "modelRevision": 3, "modelCategory": "timeout"})
    projected = project_record(record)
    assert set(projected) == {"event", "modelSource", "modelRevision", "modelCategory"}


def test_six_events_can_be_written(settings) -> None:
    events = (
        "model_config_test_failed",
        "model_config_conflict",
        "model_test_expired",
        "tutor_fallback",
        "turn_invalidated",
        "action_rejected",
    )
    for event in events:
        write_log(settings, {"event": event, "requestId": "cfg-0123456789ab", "category": "ok"})
    records = tail_logs(settings, 20)
    assert {record["event"] for record in records} >= set(events)
    assert all(re.fullmatch(r"cfg-[0-9a-f]{12}", record["requestId"]) for record in records)


def test_log_write_failure_does_not_raise(settings, monkeypatch) -> None:
    def broken_mkdir(self, *args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(Path, "mkdir", broken_mkdir)
    payload = write_log(settings, {"event": "tutor_fallback"})
    assert payload["event"] == "tutor_fallback"