"""RG-17：模型辅导证据字段映射与适配异常安全降级。"""

from __future__ import annotations

import copy

import pytest

from backend.api.routers import tutor as tutor_router
from backend.infra.config import load_settings
from backend.service.course import load_course
from backend.tutor.evidence import to_model_evidence
from backend.tutor.model import ModelUnavailable, build_model_request, call_model
from tests.helpers import ROOT


def _evidence(source_type: str, fact: str = "观察到的事实") -> dict:
    return {
        "sourceType": source_type,
        "observedFact": fact,
        "confidence": 0.8,
        "interpretation": {"text": "解释", "confidence": 0.8, "basedOn": [source_type]},
    }


def test_mapping_run_and_hint_evidence() -> None:
    mapped, diagnostics = to_model_evidence([_evidence("run_result"), _evidence("hint_usage")])
    assert [item["type"] for item in mapped] == ["run_result", "hint_usage"]
    assert mapped[0]["fact"] == "观察到的事实"
    assert diagnostics == []


def test_empty_evidence() -> None:
    mapped, diagnostics = to_model_evidence([])
    assert mapped == []
    assert diagnostics == []


def test_bad_evidence_is_skipped() -> None:
    bad = [
        {"sourceType": "unknown", "observedFact": "x", "confidence": 0.5},
        {"sourceType": "run_result", "observedFact": "", "confidence": 0.5},
        {"sourceType": "run_result", "observedFact": "x", "confidence": "high"},
        "not-a-dict",
    ]
    mapped, diagnostics = to_model_evidence(bad)
    assert mapped == []
    assert len(diagnostics) >= 3


def test_model_request_uses_mapped_fields() -> None:
    context = {
        "request_id": "tutor-x",
        "task_id": "main",
        "objective": "让角色走四步",
        "program_summary": "重复 2 次",
        "program_valid": True,
        "last_run_status": "completed",
        "learner_choice": "hint",
        "evidence": [_evidence("run_result", "走了 2 步")],
    }
    request = build_model_request(context, None)
    assert request["evidence"] == [
        {"type": "run_result", "fact": "走了 2 步", "confidence": 0.8}
    ]


def test_call_model_wraps_adapter_exception(monkeypatch) -> None:
    settings = load_settings(
        {
            "CMK_TUTOR_MODE": "model",
            "CMK_MODEL_ENDPOINT": "https://example.invalid/model",
            "CMK_MODEL_KEY": "key",
        }
    )

    def boom(context, decision):
        raise TypeError("构造失败")

    monkeypatch.setattr("backend.tutor.model.build_model_request", boom)
    with pytest.raises(ModelUnavailable):
        call_model(settings, {}, None)


def test_route_falls_back_when_model_unavailable(tmp_path, monkeypatch) -> None:
    from fastapi.testclient import TestClient

    from backend.app import create_app

    settings = load_settings(
        {
            "CMK_LOG_DIR": str(tmp_path / "logs"),
            "CMK_COURSE_DIR": str(ROOT / "content" / "demo-loop"),
            "CMK_TUTOR_MODE": "model",
            "CMK_MODEL_ENDPOINT": "https://example.invalid/model",
            "CMK_MODEL_KEY": "key",
        }
    )
    app = create_app(settings)

    def unavailable(settings_arg, context, decision):
        raise ModelUnavailable("network_error")

    monkeypatch.setattr(tutor_router, "call_model", unavailable)
    with TestClient(app) as client:
        client.post("/api/v1/session/prediction", json={"taskId": "main", "value": 2})
        response = client.post("/api/v1/tutor/hints", json={"taskId": "main", "learnerChoice": "hint"})
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["mode"] == "mock"
        assert data["showAsDemo"] is True
        assert data.get("fallbackReason")


def test_bundle_with_bad_evidence_does_not_crash_route(client, app, monkeypatch, settings) -> None:
    store = app.state.session
    store.add_evidence(
        task_id="main",
        source_type="run_result",
        observed_fact="走了 2 步",
        interpretation_text="解释",
        confidence=0.8,
        alternatives=["其它"],
        follow_up="再试一次",
    )
    mapped, diagnostics = to_model_evidence(store.recent_evidence("main"))
    assert mapped
    assert diagnostics == []