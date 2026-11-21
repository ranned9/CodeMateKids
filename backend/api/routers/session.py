"""会话路由：预测、自评/跳过、总结。"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Request

from backend.api.dto import FeedbackRequest, PredictionRequest, StudentCreateRequest
from backend.api.security import require_local, require_local_same_origin
from backend.api.student_context import classroom_session
from backend.domain.program import ProgramError
from backend.infra.errors import ApiError, ok
from backend.service.course import find_task, load_course
from backend.service.program_digest import digest_program
from backend.service.teaching import learning_key, validate_snapshot

router = APIRouter(tags=["session"])


@router.post("/session/prediction")
def submit_prediction(body: PredictionRequest, request: Request) -> dict:
    settings = request.app.state.settings
    _, store = classroom_session(request)
    bundle = load_course(settings)
    find_task(settings, body.taskId, bundle)
    context = body.learningContext.model_dump() if body.learningContext else {}
    key = learning_key(context, bundle, body.taskId)
    attempts = store.add_prediction(body.taskId, body.value, bundle.content_version)
    data = {"taskId": body.taskId, "value": body.value, "runUnlocked": True, "attempts": attempts}
    if key:
        program = context.get("program")
        digest = None
        if program is not None:
            try:
                validate_snapshot(program, bundle, body.taskId)
            except ProgramError:
                pass
            else:
                digest = digest_program(program)
        prediction_id = f"pred-{uuid.uuid4().hex}"
        store.teaching.put_prediction(key, prediction_id, body.value, digest)
        data["predictionId"] = prediction_id
    return ok(data)


@router.post("/session/feedback")
def submit_feedback(body: FeedbackRequest, request: Request) -> dict:
    settings = request.app.state.settings
    _, store = classroom_session(request)
    bundle = load_course(settings)
    find_task(settings, body.taskId, bundle)
    skipped = False
    if body.kind == "skip":
        store.mark_skipped(body.taskId, bundle.content_version)
        skipped = True
        observed = body.note or "孩子选择先跳过这个任务"
        store.add_evidence(
            task_id=body.taskId,
            source_type="self_feedback",
            observed_fact=observed,
            interpretation_text="孩子希望调整学习节奏，不是能力结论",
            confidence=0.8,
            alternatives=["可能只是累了", "可能想先看看别的任务"],
            follow_up="稍后提供回到该任务的入口，不施加压力",
        )
    elif body.kind == "resume":
        store.mark_resumed(body.taskId)
        store.add_evidence(
            task_id=body.taskId,
            source_type="self_feedback",
            observed_fact="孩子选择回到之前跳过的任务",
            interpretation_text="孩子愿意再次尝试",
            confidence=0.8,
            alternatives=["可能只是点错了"],
            follow_up="保持任务可编辑，不追加提示",
        )
    else:
        observed = body.note or "孩子完成了任务自评"
        store.add_evidence(
            task_id=body.taskId,
            source_type="self_feedback",
            observed_fact=observed,
            interpretation_text="孩子对自己的完成情况做了自评",
            confidence=0.7,
            alternatives=["自评可能比较笼统"],
            follow_up="在变式任务中观察是否能独立完成",
        )
    return ok({"taskId": body.taskId, "kind": body.kind, "skipped": skipped})


@router.get("/session/summary")
def get_summary(request: Request) -> dict:
    settings = request.app.state.settings
    _, store = classroom_session(request)
    return ok(store.summary(settings))


@router.get("/session/state")
def get_state(request: Request) -> dict:
    _, store = classroom_session(request)
    counts = store.snapshot_counts()
    return ok({"counts": counts, "skipped": sorted(store.skipped)})


@router.get("/students")
def list_students(request: Request) -> dict:
    require_local(request)
    return ok({"students": request.app.state.learning.list_students()})


@router.post("/students")
def create_student(body: StudentCreateRequest, request: Request) -> dict:
    require_local_same_origin(request)
    return ok(request.app.state.learning.create_student(body.displayName))


@router.get("/students/{student_id}/progress")
def student_progress(student_id: str, request: Request, courseId: str | None = None) -> dict:
    require_local(request)
    memory = request.app.state.learning
    bundle = load_course(request.app.state.settings)
    course_id = courseId or bundle.course["courseId"]
    if not memory.has_student(student_id):
        raise ApiError("STUDENT_NOT_FOUND")
    observations = memory.observations(student_id, course_id)
    return ok({
        "studentId": student_id, "courseId": course_id, "observations": observations,
        "updatedAt": observations[0]["observedAt"] if observations else None,
    })
