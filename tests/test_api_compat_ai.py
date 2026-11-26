"""阶段 0 契约：DTO 可选字段、旧请求兼容、课程与辅导 Schema 增量。"""

from __future__ import annotations

import copy
import json
import shutil
from dataclasses import replace
from pathlib import Path

import pytest
from pydantic import ValidationError
from fastapi.testclient import TestClient

from backend.api.dto import (
    LearningContext,
    LearningScope,
    PredictionRequest,
    PredictionResponse,
    RunSubmitRequest,
    SessionSummaryResponse,
    TutorHintRequest,
    TutorHintResponse,
)
from backend.tutor.model import build_model_request
from backend.app import create_app
from backend.service.course import validate_course
from tests.helpers_schema import validate

ROOT = Path(__file__).resolve().parent.parent


def _json(relative: str) -> dict:
    return json.loads((ROOT / relative).read_text(encoding="utf-8"))


def _course() -> dict:
    return _json("content/demo-loop/course.json")


def _two_task_course() -> dict:
    course = copy.deepcopy(_course())
    course.pop("transferTaskId", None)
    course["tasks"] = course["tasks"][:2]
    for task in course["tasks"]:
        task.pop("teaching", None)
        task.pop("nextTaskId", None)
    return course


def test_learning_context_is_optional_and_validates_identifiers() -> None:
    assert PredictionRequest(taskId="main", value=2).learningContext is None
    context = LearningContext(
        scope=LearningScope(contentVersion="1.2.1", taskId="main", workspaceId="ws-1"),
        predictionId="pred-1",
        seenHintIds=["h-1"],
        workspaceSource="task",
        runRequestId="run-1",
    )
    assert context.scope.workspaceId == "ws-1"
    with pytest.raises(ValidationError):
        LearningScope(workspaceId="bad workspace id")
    with pytest.raises(ValidationError):
        LearningScope(contentVersion="1.2")
    with pytest.raises(ValidationError):
        PredictionRequest(taskId="main", value=2, learningContext={"unexpected": True})
    with pytest.raises(ValidationError):
        LearningContext(seenHintIds=[f"h-{index}" for index in range(9)])


def test_three_requests_accept_optional_learning_context() -> None:
    context = {"scope": {"contentVersion": "1.2.1", "workspaceId": "ws-1"}}
    assert PredictionRequest(taskId="main", value=2, learningContext=context).learningContext is not None
    assert TutorHintRequest(taskId="main", learningContext=context).learningContext is not None
    run = RunSubmitRequest(
        requestId="run-1",
        cancelToken="token-1",
        target={"language": "python", "version": "3.12"},
        program={"format": "codematekids.program"},
        courseRef={"courseId": "demo-loop", "version": 1},
        taskId="main",
        learningContext=context,
    )
    assert run.learningContext is not None


def test_new_fields_are_not_required_and_responses_serialize_optional() -> None:
    payload = PredictionResponse(taskId="main", value=2, attempts=1).model_dump(exclude_none=True)
    assert "predictionId" not in payload
    hint = TutorHintResponse(
        action="hint",
        message="先数一数",
        nextStep="运行一次",
        evidenceUsed=["run_result"],
        uncertainty="还不确定",
        answerLevel=1,
        mode="mock",
        showAsDemo=True,
    ).model_dump(exclude_none=True)
    assert "learning" not in hint
    summary = SessionSummaryResponse(
        concepts=[],
        completedTasks=[],
        independentThings=[],
        toVerify=[],
        nextStep="再试一次",
        missing=[],
        skippedTasks=[],
        variantAvailable=True,
        mainCompleted=False,
        variantCompleted=False,
        note="仅代表本次会话",
        taskCount=2,
        transfer=None,
    )
    assert summary.transfer is None
    assert "nextTaskId" not in summary.model_dump(exclude_none=True)


def test_old_prediction_request_shape_unchanged(client) -> None:
    response = client.post("/api/v1/session/prediction", json={"taskId": "main", "value": 2})
    assert response.status_code == 200
    data = response.json()["data"]
    assert set(data) == {"taskId", "value", "runUnlocked", "attempts"}


def test_old_summary_shape_unchanged(tmp_path, settings) -> None:
    course_dir = tmp_path / "legacy-course"
    shutil.copytree(ROOT / "content" / "demo-loop", course_dir)
    (course_dir / "course.json").write_text(json.dumps(_two_task_course(), ensure_ascii=False), encoding="utf-8")
    with TestClient(create_app(replace(settings, course_dir=course_dir))) as client:
        data = client.get("/api/v1/session/summary").json()["data"]
    assert "transfer" not in data
    for key in (
        "concepts",
        "completedTasks",
        "independentThings",
        "toVerify",
        "nextStep",
        "missing",
        "skippedTasks",
        "variantAvailable",
        "mainCompleted",
        "variantCompleted",
        "note",
        "taskCount",
    ):
        assert key in data


def test_old_run_request_still_blocks_without_prediction(client) -> None:
    course = client.get("/api/v1/course/demo-loop").json()["data"]
    main = next(task for task in course["tasks"] if task["taskId"] == "main")
    body = {
        "protocolVersion": 1,
        "requestId": "run-ai-compat",
        "cancelToken": "token-ai-compat",
        "target": {"language": "python", "version": "3.12"},
        "program": main["initialProgram"],
        "courseRef": main["initialProgram"]["courseRef"],
        "taskId": "main",
        "mode": "demo",
    }
    response = client.post("/api/v1/runs", json=body)
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "PREDICTION_REQUIRED"


def test_course_schema_accepts_legacy_two_task_pack() -> None:
    schema = _json("schemas/course.v1.json")
    legacy = _two_task_course()
    assert validate(legacy, schema) == []
    validate_course(legacy)
    legacy["tasks"][0]["nextTaskId"] = None
    validate_course(legacy)
    assert schema["properties"]["tasks"]["minItems"] == 2


def test_course_schema_rejects_unknown_teaching_values() -> None:
    schema = _json("schemas/course.v1.json")
    broken = copy.deepcopy(_course())
    broken["tasks"][0]["teaching"] = {"goalKind": "diagonal"}
    assert validate(broken, schema)

    broken = copy.deepcopy(_course())
    broken["tasks"][0]["programCriteria"] = ["unknown_criterion"]
    assert validate(broken, schema)

    broken = copy.deepcopy(_course())
    broken["tasks"][0]["nextTaskId"] = "main"
    assert validate(broken, schema) == [], "Schema 只校验类型，自引用由加载器校验"

    broken = copy.deepcopy(_course())
    broken["tasks"][0]["nextTaskId"] = 42
    assert validate(broken, schema)


def test_course_schema_accepts_current_pack() -> None:
    schema = _json("schemas/course.v1.json")
    assert validate(_course(), schema) == []


def test_tutor_protocol_schema_keeps_v1_and_accepts_optional_decision() -> None:
    schema = _json("schemas/tutor_protocol.v1.json")
    assert schema["$defs"]["tutorRequest"]["properties"]["protocolVersion"]["const"] == 1
    old_request = build_model_request(
        {"request_id": "tutor-1", "task_id": "main", "objective": "让角色走四步"},
        None,
    )
    assert validate(old_request, schema["$defs"]["tutorRequest"], schema) == []

    extended = copy.deepcopy(old_request)
    extended["teachingDecision"] = {
        "action": "hint",
        "allowedLevel": 1,
        "pattern": "loop_count_mismatch",
        "factIds": ["fact-1"],
        "nextAction": "run",
    }
    assert validate(extended, schema["$defs"]["tutorRequest"], schema) == []

    extended["teachingDecision"]["allowedLevel"] = 4
    assert validate(extended, schema["$defs"]["tutorRequest"], schema)
    extended["teachingDecision"]["allowedLevel"] = 1
    extended["teachingDecision"]["nextAction"] = "jump"
    assert validate(extended, schema["$defs"]["tutorRequest"], schema)


def test_tutor_response_accepts_optional_fact_ids() -> None:
    schema = _json("schemas/tutor_protocol.v1.json")
    response = {
        "requestId": "tutor-1",
        "action": "hint",
        "message": "先数一数",
        "nextStep": "运行一次",
        "evidenceUsed": ["run_result"],
        "uncertainty": "还不确定",
        "answerLevel": 1,
        "mode": "mock",
        "showAsDemo": True,
    }
    assert validate(response, schema["$defs"]["tutorResponse"], schema) == []
    response["factIdsUsed"] = ["fact-1"]
    assert validate(response, schema["$defs"]["tutorResponse"], schema) == []
