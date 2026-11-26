"""课程闭环：单主题、任务可用性、预测前置与成功标准。"""

from __future__ import annotations

from dataclasses import replace
import json

from fastapi.testclient import TestClient

from backend.app import create_app
from backend.domain.blocks import load_blocks
from backend.domain.program import evaluate_criteria
from backend.service.course import _task_block_reason
from tests.helpers import ROOT, drain, simple_program, submit


def _valid_program(client) -> dict:
    course = client.get("/api/v1/course/demo-loop").json()["data"]
    main = next(task for task in course["tasks"] if task["taskId"] == "main")
    return main["initialProgram"]


def test_course_shape_and_single_theme(client) -> None:
    response = client.get("/api/v1/course/demo-loop")
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["course"]["courseId"] == "demo-loop"
    assert data["course"]["reviewStatus"] == "reviewed"
    assert 1 <= len(data["course"]["learningObjectives"]) <= 3
    assert [task["taskId"] for task in data["tasks"]] == ["main", "variant", "transfer-square", "branch-crossroad"]
    assert data["tasks"][1]["nextTaskId"] == "transfer-square"
    assert data["tasks"][2]["nextTaskId"] == "branch-crossroad"
    assert all(task["enterable"] for task in data["tasks"])
    assert all(task["initialProgram"]["root"] is None for task in data["tasks"][:3])
    assert data["tasks"][3]["initialProgram"]["root"]["next"]["kind"] == "control.repeat"
    assert {theme["status"] for theme in data["otherThemes"]} == {"coming_soon"}


def test_unknown_course_rejected(client) -> None:
    response = client.get("/api/v1/course/condition")
    assert response.status_code == 409
    payload = response.json()
    assert payload["ok"] is False
    assert payload["error"]["code"] == "COURSE_VERSION_UNSUPPORTED"


def test_configured_pack_owns_course_identity_and_task_progression(settings, tmp_path) -> None:
    source = ROOT / "content" / "demo-loop"
    course = json.loads((source / "course.json").read_text(encoding="utf-8"))
    main, variant = course["tasks"][:2]
    course.update(courseId="my-course", tasks=[variant, main], transferTaskId="try-next")
    main.update(taskId="begin", nextTaskId="try-next")
    main.pop("variantTaskId")
    variant.update(taskId="try-next", variantOf="begin", nextTaskId=None)
    for task in course["tasks"]:
        task["initialProgram"]["courseRef"].update(courseId="my-course", taskId=task["taskId"])
    pack = tmp_path / "pack"
    pack.mkdir()
    (pack / "course.json").write_text(json.dumps(course, ensure_ascii=False), encoding="utf-8")
    (pack / "blocks.used.json").write_bytes((source / "blocks.used.json").read_bytes())
    (pack / "tutor.replies.json").write_text('{"replies": []}', encoding="utf-8")
    with TestClient(create_app(replace(settings, course_dir=pack))) as other:
        report = other.get("/api/v1/startup/check").json()["data"]
        assert report["courseId"] == "my-course"
        data = other.get("/api/v1/course").json()["data"]
        assert other.get("/api/v1/course/my-course").json()["data"] == data
        assert other.get("/api/v1/course/demo-loop").status_code == 409
        assert data["entryTaskId"] == "begin"
        summary = other.get("/api/v1/session/summary").json()["data"]
        assert summary["nextTaskId"] == "begin"
        assert summary["transfer"]["title"] == variant["title"]

        attempt = simple_program("begin")
        attempt["courseRef"]["courseId"] = "my-course"
        attempt["root"]["next"]["inputs"]["times"] = 4
        scope = {"contentVersion": data["contentVersion"], "taskId": "begin", "workspaceId": "alt-workspace"}
        prediction = other.post("/api/v1/session/prediction", json={
            "taskId": "begin", "value": 4, "learningContext": {"scope": scope, "program": attempt},
        })
        assert prediction.status_code == 200 and prediction.json()["data"].get("predictionId")
        assert submit(other, attempt, "alt-course-run").status_code == 200
        _, result = drain(other, "alt-course-run")
        assert result["success"] is True
        assert other.get("/api/v1/session/summary").json()["data"]["nextTaskId"] == "try-next"


def test_run_blocked_without_prediction(client) -> None:
    program = _valid_program(client)
    body = {
        "protocolVersion": 1,
        "requestId": "run-need-prediction",
        "cancelToken": "token-1",
        "target": {"language": "python", "version": "3.12"},
        "program": program,
        "courseRef": program["courseRef"],
        "taskId": "main",
        "mode": "demo",
    }
    response = client.post("/api/v1/runs", json=body)
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "PREDICTION_REQUIRED"


def test_prediction_validation_and_unlock(client, app) -> None:
    invalid = client.post("/api/v1/session/prediction", json={"taskId": "main", "value": -1})
    assert invalid.status_code == 422
    missing = client.post("/api/v1/session/prediction", json={"taskId": "unknown", "value": 2})
    assert missing.status_code == 422

    okay = client.post("/api/v1/session/prediction", json={"taskId": "main", "value": 2})
    assert okay.status_code == 200
    data = okay.json()["data"]
    assert data["runUnlocked"] is True
    assert data["attempts"] == 1
    assert app.state.session.has_prediction("main") is True

    revised = client.post("/api/v1/session/prediction", json={"taskId": "main", "value": 4})
    assert revised.json()["data"]["attempts"] == 2
    assert app.state.session.prediction_value("main") == 4


def test_task_blocked_when_kind_not_registered() -> None:
    registry = load_blocks()
    task = {
        "allowedBlockKinds": ["motion.move", "future.block"],
        "initialProgram": {"root": None},
    }
    assert _task_block_reason(task, registry) == "这节课需要的积木暂不支持"


def test_success_criteria_evaluation() -> None:
    task = {
        "successCriteria": [
            {
                "code": "steps",
                "description": "角色累计走了 4 步",
                "check": {"object": "stage", "field": "steps", "op": "eq", "value": 4},
            }
        ]
    }
    okay, failures = evaluate_criteria(task, [{"id": "stage", "steps": 4}])
    assert okay is True
    assert failures == []
    bad, bad_failures = evaluate_criteria(task, [{"id": "stage", "steps": 2}])
    assert bad is False
    assert bad_failures


def test_common_errors_and_hint_ladder_complete(client) -> None:
    data = client.get("/api/v1/course/demo-loop").json()["data"]
    for task in data["tasks"]:
        assert len(task["commonErrors"]) >= 2
        assert len(task["hintLadder"]) >= 3
        levels = [item["level"] for item in task["hintLadder"]]
        assert levels == sorted(levels)
        assert len(task["successCriteria"]) >= 1
