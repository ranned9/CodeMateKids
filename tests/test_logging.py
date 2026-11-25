"""脱敏日志：白名单投影、落盘与诊断接口。"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend.infra.errors import ApiError
from backend.infra.logging import ALLOWED_FIELDS, tail_logs, write_log


def test_projection_drops_non_whitelisted_fields(settings, log_dir) -> None:
    payload = write_log(
        settings,
        {
            "requestId": "run-log-1",
            "category": "runtime",
            "durationMs": 12,
            "matrixCaseId": "TC-RUN-01",
            "childInput": "孩子说的悄悄话",
            "sourceCode": "print(1)",
        },
    )
    assert "childInput" not in payload
    assert "sourceCode" not in payload
    line = (Path(log_dir) / "run.jsonl").read_text(encoding="utf-8").splitlines()[-1]
    record = json.loads(line)
    assert set(record) <= set(ALLOWED_FIELDS)
    assert "孩子说的悄悄话" not in line


def test_tail_logs_returns_last_records(settings, log_dir) -> None:
    for index in range(6):
        write_log(settings, {"event": "run_finished", "requestId": f"r-{index}"})
    records = tail_logs(settings, 3)
    assert [item["requestId"] for item in records] == ["r-3", "r-4", "r-5"]


def test_diagnostics_endpoint_available_on_loopback(client, settings) -> None:
    write_log(settings, {"event": "run_finished", "requestId": "diag-1", "category": "ok"})
    response = client.get("/api/v1/diagnostics/logs?tail=5")
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["count"] >= 1
    assert set(data["records"][0]) <= set(ALLOWED_FIELDS)


def test_diagnostics_bad_tail(client) -> None:
    response = client.get("/api/v1/diagnostics/logs?tail=0")
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "BAD_TAIL"


def test_diagnostics_rejects_non_loopback(settings) -> None:
    from backend.api.routers.diagnostics import get_logs

    fake_request = SimpleNamespace(
        client=SimpleNamespace(host="10.0.0.8"),
        app=SimpleNamespace(state=SimpleNamespace(settings=settings)),
    )
    with pytest.raises(ApiError) as exc:
        get_logs(fake_request, 10)
    assert exc.value.code == "FORBIDDEN"


def test_run_writes_audit_record(client, settings) -> None:
    client.get("/api/v1/startup/check")
    records = tail_logs(settings, 5)
    assert any(item.get("event") == "startup_check" for item in records)
    assert all(set(item) <= set(ALLOWED_FIELDS) for item in records)

def test_speech_events_only_log_whitelisted_fields(settings, log_dir) -> None:
    payload = write_log(
        settings,
        {
            "event": "speech_recognize",
            "requestId": "speech-abc",
            "durationMs": 120,
            "category": "ok",
            "cloudTraceId": "cloud-trace-1",
            "audioBase64": "UklGRg==",
            "transcript": "孩子说的原话",
            "turnId": "turn-1",
            "projectId": "proj-123",
        },
    )
    assert "audioBase64" not in payload
    assert "transcript" not in payload
    assert "turnId" not in payload
    assert "projectId" not in payload
    assert payload["cloudTraceId"] == "cloud-trace-1"


def test_speech_events_never_log_credentials(settings, log_dir) -> None:
    payload = write_log(settings, {"event": "speech_synthesize", "cmk_sis_ak": "ak-x", "cmk_sis_sk": "sk-x"})
    assert "ak-x" not in str(payload)
    assert "sk-x" not in str(payload)
    line = (Path(log_dir) / "run.jsonl").read_text(encoding="utf-8").splitlines()[-1]
    assert "ak-x" not in line and "sk-x" not in line


def test_cloud_trace_id_requires_whitelist_registration() -> None:
    assert "cloudTraceId" in ALLOWED_FIELDS
    assert write_log(
        load_settings_for_log(), {"event": "speech_recognize", "cloudTraceId": "t-1"}
    )["cloudTraceId"] == "t-1"


def load_settings_for_log():
    from backend.infra.config import load_settings

    import tempfile

    return load_settings({"CMK_LOG_DIR": tempfile.mkdtemp()})
