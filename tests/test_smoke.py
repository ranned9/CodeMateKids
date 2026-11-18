"""最小启动链路冒烟测试。"""

from __future__ import annotations


def test_app_created(app) -> None:
    assert app.title.startswith("CodeMateKids")
    assert app.state.settings is not None


def test_startup_check_envelope(client) -> None:
    response = client.get("/api/v1/startup/check")
    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    data = payload["data"]
    assert data["status"] in {"ready", "degraded", "fatal"}
    assert isinstance(data["checks"], list)
    assert len(data["checks"]) == 5
    assert data["python"]["source"] in {"worker_probe", "unavailable"}
    assert data["tutorMode"] == "mock"


def test_static_index_served(client) -> None:
    response = client.get("/")
    assert response.status_code == 200
    assert "课程区" in response.text


def test_unknown_route_returns_404(client) -> None:
    response = client.get("/api/v1/not-exists")
    assert response.status_code == 404