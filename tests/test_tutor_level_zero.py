"""RG-16：提示等级 0 与互动选择分离。"""

from __future__ import annotations

from fastapi.testclient import TestClient

from backend.app import create_app
from backend.infra.config import load_settings
from tests.helpers import ROOT


def test_self_try_and_skip_do_not_raise_hint_level(client, app) -> None:
    store = app.state.session
    self_try = client.post("/api/v1/tutor/hints", json={"taskId": "main", "learnerChoice": "self_try"})
    assert self_try.status_code == 200
    assert self_try.json()["data"]["answerLevel"] == 0
    skip = client.post("/api/v1/tutor/hints", json={"taskId": "main", "learnerChoice": "skip"})
    assert skip.status_code == 200
    assert skip.json()["data"]["answerLevel"] == 0
    assert skip.json()["data"]["action"] == "offer_variant"

    assert store.highest_hint("main") == 0
    evidence = store.recent_evidence("main", limit=20)
    assert not any(item["sourceType"] == "hint_usage" for item in evidence)

    store.record_attempt("main", "run-independent-1", "succeeded")
    summary = store.summary(app.state.settings)
    assert summary["independentThings"]


def test_real_hint_is_recorded(client, app) -> None:
    store = app.state.session
    response = client.post("/api/v1/tutor/hints", json={"taskId": "main", "learnerChoice": "hint"})
    data = response.json()["data"]
    assert data["answerLevel"] == 1
    assert store.highest_hint("main") == 1
    evidence = store.recent_evidence("main", limit=20)
    assert any(item["sourceType"] == "hint_usage" for item in evidence)


def test_repeated_self_try_does_not_duplicate_ledger(client, app) -> None:
    store = app.state.session
    for _ in range(3):
        client.post("/api/v1/tutor/hints", json={"taskId": "main", "learnerChoice": "self_try"})
    assert store.highest_hint("main") == 0
    assert not any(item["sourceType"] == "hint_usage" for item in store.recent_evidence("main", limit=30))


def test_no_level_zero_wording(client) -> None:
    data = client.post(
        "/api/v1/tutor/hints", json={"taskId": "main", "learnerChoice": "self_try"}
    ).json()["data"]
    assert "第 0 级" not in data["message"]
    assert data["nextStep"]


def test_model_mode_zero_level_not_raised(tmp_path, monkeypatch) -> None:
    settings = load_settings(
        {
            "CMK_LOG_DIR": str(tmp_path / "logs"),
            "CMK_COURSE_DIR": str(ROOT / "content" / "demo-loop"),
            "CMK_TUTOR_MODE": "model",
            "CMK_MODEL_ENDPOINT": "https://example.invalid/model",
            "CMK_MODEL_KEY": "test-key",
        }
    )
    app = create_app(settings)

    def fake_model(settings_arg, context, decision):
        return {
            "action": "hint",
            "message": "好呀，你自己试试。",
            "nextStep": "继续修改并运行",
            "uncertainty": "先不追加提示。",
            "answerLevel": 0,
            "evidenceUsed": [],
            "mode": "model",
            "showAsDemo": False,
        }

    monkeypatch.setattr("backend.api.routers.tutor.call_model", fake_model)
    with TestClient(app) as client:
        response = client.post("/api/v1/tutor/hints", json={"taskId": "main", "learnerChoice": "self_try"})
        data = response.json()["data"]
        assert data["answerLevel"] == 0
        assert app.state.session.highest_hint("main") == 0