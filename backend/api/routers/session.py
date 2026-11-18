"""会话路由：预测、自评/跳过、总结。"""

from __future__ import annotations

from fastapi import APIRouter, Request

from backend.api.dto import FeedbackRequest, PredictionRequest
from backend.infra.errors import ApiError, ok
from backend.service.course import find_task

router = APIRouter(tags=["session"])


@router.post("/session/prediction")
def submit_prediction(body: PredictionRequest, request: Request) -> dict:
    settings = request.app.state.settings
    store = request.app.state.session
    find_task(settings, body.taskId)
    attempts = store.add_prediction(body.taskId, body.value)
    return ok(
        {
            "taskId": body.taskId,
            "value": body.value,
            "runUnlocked": True,
            "attempts": attempts,
        }
    )


@router.post("/session/feedback")
def submit_feedback(body: FeedbackRequest, request: Request) -> dict:
    settings = request.app.state.settings
    store = request.app.state.session
    find_task(settings, body.taskId)
    skipped = False
    if body.kind == "skip":
        store.mark_skipped(body.taskId)
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
    store = request.app.state.session
    return ok(store.summary(settings))


@router.get("/session/state")
def get_state(request: Request) -> dict:
    store = request.app.state.session
    counts = store.snapshot_counts()
    return ok({"counts": counts, "skipped": sorted(store.skipped)})