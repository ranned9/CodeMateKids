"""RG-01/快照：运行摘要接口与终态一致性。"""

from __future__ import annotations

from fastapi.testclient import TestClient

from backend.app import create_app
from backend.infra.config import load_settings
from tests.helpers import ROOT, drain, slow_program, submit


def _make_app(tmp_path):
    settings = load_settings(
        {
            "CMK_LOG_DIR": str(tmp_path / "logs"),
            "CMK_COURSE_DIR": str(ROOT / "content" / "demo-loop"),
            "CMK_RUN_WALL_MS": "150",
            "CMK_TUTOR_MODE": "mock",
        }
    )
    return app_factory(settings)


def app_factory(settings):
    return create_app(settings)


def test_snapshot_running_then_finished(tmp_path) -> None:
    app = _make_app(tmp_path)
    with TestClient(app) as client:
        client.post("/api/v1/session/prediction", json={"taskId": "main", "value": 2})
        accepted = submit(client, slow_program(), "run-snap-1")
        assert accepted.status_code == 200
        running = client.get("/api/v1/runs/run-snap-1").json()["data"]
        assert running["finished"] is False
        assert running["status"] in {"running", "timeout"}

        _, result = drain(client, "run-snap-1")
        assert result["status"] == "timeout"
        final = client.get("/api/v1/runs/run-snap-1").json()["data"]
        assert final["finished"] is True
        assert final["status"] == "timeout"
        assert final["errorCategory"] == "timeout"


def test_snapshot_invalid_and_missing(client) -> None:
    invalid = client.get("/api/v1/runs/bad$id")
    assert invalid.status_code == 422
    assert invalid.json()["error"]["code"] == "RUN_REQUEST_INVALID"

    missing = client.get("/api/v1/runs/run-not-exists")
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "RUN_NOT_FOUND"


def test_snapshot_is_read_only(client, app) -> None:
    response = client.get("/api/v1/runs/run-unknown")
    assert response.status_code == 404
    assert app.state.runs._runs == {}