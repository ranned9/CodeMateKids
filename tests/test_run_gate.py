"""RG-05：运行门禁单一真源与 runCapability 一致性。"""

from __future__ import annotations

import copy

from backend.service import run as run_mod
from backend.service.course import load_course
from backend.service.gate import build_run_capability, evaluate_run_gate
from backend.service.startup import check_startup
from tests.helpers import drain, simple_program, submit


def _report(worker_status: str = "passed", course_status: str = "passed") -> dict:
    return {
        "status": "degraded" if worker_status != "passed" or course_status != "passed" else "ready",
        "checks": [
            {"name": "os", "status": "passed"},
            {"name": "python", "status": "passed"},
            {"name": "worker", "status": worker_status},
            {"name": "schema", "status": "passed"},
            {"name": "course", "status": course_status},
        ],
    }


def test_worker_unavailable_rejected_before_slot(client, app, monkeypatch) -> None:
    client.post("/api/v1/session/prediction", json={"taskId": "main", "value": 2})
    monkeypatch.setattr(run_mod, "check_startup", lambda settings: _report(worker_status="failed"))
    response = submit(client, simple_program(), "run-gate-1")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "RUNNER_UNAVAILABLE"
    assert app.state.runs._runs == {}
    assert app.state.runs._active_id is None


def test_blocked_task_rejected_but_other_task_allowed(client, app, monkeypatch, settings) -> None:
    client.post("/api/v1/session/prediction", json={"taskId": "variant", "value": 2})
    client.post("/api/v1/session/prediction", json={"taskId": "main", "value": 2})
    real_bundle = load_course(settings)
    fake_bundle = copy.copy(real_bundle)
    fake_bundle.blocked = {"variant": "这节课需要的积木暂不支持"}
    monkeypatch.setattr(run_mod, "load_course", lambda settings: fake_bundle)
    monkeypatch.setattr(run_mod, "check_startup", lambda settings: _report())

    blocked = submit(client, simple_program("variant"), "run-gate-2")
    assert blocked.status_code == 409
    assert blocked.json()["error"]["code"] == "TASK_NOT_RUNNABLE"

    accepted = submit(client, simple_program("main"), "run-gate-3")
    assert accepted.status_code == 200
    _, result = drain(client, "run-gate-3")
    assert result["status"] == "completed"


def test_run_capability_matches_gate(settings) -> None:
    report = check_startup(settings, refresh=True)
    capability = report["runCapability"]
    decision = evaluate_run_gate(report, "main", True, True)
    assert decision.allowed is True
    assert capability["canRun"] is True
    assert capability["workerReady"] is True
    assert capability["blockedTaskIds"] == []

    degraded = _report(worker_status="failed")
    blocked = evaluate_run_gate(degraded, "main", True, True)
    capability_blocked = build_run_capability(degraded, [], "1.0.0")
    assert blocked.allowed is False
    assert blocked.code == "RUNNER_UNAVAILABLE"
    assert capability_blocked["canRun"] is False
    assert capability_blocked["reasonCode"] == "RUNNER_UNAVAILABLE"


def test_prediction_still_has_priority(client, app) -> None:
    response = submit(client, simple_program(), "run-gate-4")
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "PREDICTION_REQUIRED"