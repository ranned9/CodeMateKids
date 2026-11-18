"""RG-08：运行标识长度/字符集与重复标识拒绝。"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from backend.app import create_app
from backend.infra.config import load_settings
from tests.helpers import ROOT, drain, simple_program, slow_program, submit


def _prepare(client) -> None:
    client.post("/api/v1/session/prediction", json={"taskId": "main", "value": 2})


def test_invalid_identifiers_rejected(client) -> None:
    _prepare(client)
    cases = [
        ("", "token-ok"),
        ("run-ok", ""),
        ("a" * 65, "token-ok"),
        ("bad id", "token-ok"),
        ("run-中文", "token-ok"),
        ("run-$bad", "token-ok"),
        ("run-ok", "b" * 65),
    ]
    for request_id, token in cases:
        response = submit(client, simple_program(), request_id, token)
        assert response.status_code == 422, (request_id, token)
        assert response.json()["error"]["code"] == "RUN_REQUEST_INVALID"


def test_duplicate_finished_id_is_rejected(client, app) -> None:
    _prepare(client)
    first = submit(client, simple_program(), "run-dup-1")
    assert first.status_code == 200
    _, result = drain(client, "run-dup-1")
    assert result["status"] == "completed"

    second = submit(client, simple_program(), "run-dup-1")
    assert second.status_code == 409
    assert second.json()["error"]["code"] == "RUN_ID_CONFLICT"
    snapshot = client.get("/api/v1/runs/run-dup-1").json()["data"]
    assert snapshot["status"] == "completed"
    assert snapshot["finished"] is True


def test_duplicate_running_id_does_not_override(tmp_path) -> None:
    settings = load_settings(
        {
            "CMK_LOG_DIR": str(tmp_path / "logs"),
            "CMK_COURSE_DIR": str(ROOT / "content" / "demo-loop"),
            "CMK_RUN_WALL_MS": "150",
            "CMK_TUTOR_MODE": "mock",
        }
    )
    app = create_app(settings)
    with TestClient(app) as client:
        _prepare(client)
        assert submit(client, slow_program(), "run-running-1").status_code == 200
        duplicate = submit(client, simple_program(), "run-running-1")
        assert duplicate.status_code == 409
        assert duplicate.json()["error"]["code"] == "RUN_ID_CONFLICT"
        client.post("/api/v1/runs/run-running-1/cancel", json={"cancelToken": "token-run-running-1"})
        _, result = drain(client, "run-running-1")
        assert result["status"] in {"cancelled", "timeout"}


def test_cancel_token_not_in_logs(client, settings) -> None:
    _prepare(client)
    submit(client, simple_program(), "run-log-token", "secret-cancel-token-0123456789abcdef")
    drain(client, "run-log-token")
    log_path = Path(settings.log_dir) / "run.jsonl"
    if log_path.exists():
        content = log_path.read_text(encoding="utf-8")
        assert "secret-cancel-token" not in content
        assert "cancelToken" not in content


def test_generated_ids_match_constraints(app) -> None:
    request_id, token = app.state.runs.new_request_id()
    assert 1 <= len(request_id) <= 64
    assert 1 <= len(token) <= 64
    assert all(char.isalnum() or char in "_-" for char in request_id)
    assert all(char.isalnum() or char in "_-" for char in token)