"""辅导路由：单一课程 Bundle、证据映射、兜底与提示账本语义。"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Request

from backend.api.dto import TutorHintRequest
from backend.infra.errors import ok
from backend.infra.logging import write_log
from backend.service.course import find_task, load_course
from backend.tutor import mock
from backend.tutor.engine import decide
from backend.tutor.guard import validate_response
from backend.tutor.model import ModelUnavailable, call_model

router = APIRouter(tags=["tutor"])

LAST_RUN_STATUS = {
    "succeeded": "completed",
    "failed": "failed",
    "timeout": "timeout",
    "resource": "resource_exceeded",
    "cancelled": "cancelled",
    "crashed": "crashed",
}
HINT_LEDGER_CHOICES = {"hint", "more_hint", "example"}
SAFE_FALLBACK = {
    "action": "hint",
    "message": "我们先回到这一步，看看角色走了几步。",
    "nextStep": "运行一次，观察角色位置",
    "uncertainty": "我还没有看到结果。",
    "answerLevel": 1,
    "evidenceUsed": ["run_result"],
    "mode": "mock",
    "showAsDemo": True,
}


def _build_context(request: Request, body: TutorHintRequest, bundle) -> dict:
    store = request.app.state.session
    task = find_task(request.app.state.settings, body.taskId, bundle)
    attempts = store.attempts_for(body.taskId)
    last_attempt = attempts[-1] if attempts else None
    last_status = LAST_RUN_STATUS.get(last_attempt["outcome"]) if last_attempt else None
    evidence = store.recent_evidence(body.taskId, limit=5)
    evidence_types = []
    for item in evidence:
        if item["sourceType"] not in evidence_types:
            evidence_types.append(item["sourceType"])
    return {
        "request_id": f"tutor-{uuid.uuid4().hex[:12]}",
        "task_id": body.taskId,
        "objective": task["objective"],
        "program_summary": body.programSummary,
        "program_valid": body.programValid,
        "last_run_status": body.lastRunStatus or last_status,
        "last_success": last_attempt is not None and last_attempt["outcome"] == "succeeded",
        "learner_choice": body.learnerChoice,
        "message": body.message,
        "highest_hint": store.highest_hint(body.taskId),
        "evidence": evidence,
        "evidence_types": evidence_types,
    }


@router.post("/tutor/hints")
def create_hint(body: TutorHintRequest, request: Request) -> dict:
    settings = request.app.state.settings
    store = request.app.state.session
    bundle = load_course(settings)
    context = _build_context(request, body, bundle)
    decision = decide(context)

    fallback_reason = ""
    response: dict | None = None
    allowed = int(context.get("highest_hint", 0)) >= 2 and body.learnerChoice == "more_hint"

    if settings.tutor_mode == "model":
        try:
            candidate = call_model(settings, context, decision)
            valid, reason = validate_response(candidate, allow_full_solution=allowed)
            if valid:
                response = candidate
            else:
                fallback_reason = f"guard:{reason}"
        except ModelUnavailable as exc:
            fallback_reason = f"model:{exc}"
        except Exception as exc:  # noqa: BLE001 - 适配异常不得穿透为 500
            fallback_reason = "model:adapter_error"
            write_log(
                settings,
                {
                    "event": "tutor_adapter_error",
                    "requestId": context["request_id"],
                    "category": "TUTOR_UNAVAILABLE",
                    "matrixCaseId": "TC-TUTOR-ADAPTER",
                    "appVersion": settings.app_version,
                    "stderrSummary": type(exc).__name__,
                },
            )

    if response is None:
        response = mock.reply(settings, context, decision, bundle)
        valid, reason = validate_response(response, allow_full_solution=allowed)
        if not valid:
            response = dict(SAFE_FALLBACK)
        if settings.tutor_mode == "model":
            if not fallback_reason:
                fallback_reason = "model:empty"
            write_log(
                settings,
                {
                    "event": "tutor_fallback",
                    "requestId": context["request_id"],
                    "category": "TUTOR_UNAVAILABLE",
                    "matrixCaseId": "TC-TUTOR-FALLBACK",
                    "appVersion": settings.app_version,
                },
            )

    response = dict(response)
    response["requestId"] = context["request_id"]
    if fallback_reason:
        response["fallbackReason"] = fallback_reason
    response.setdefault("showAsDemo", response.get("mode") == "mock")

    level = int(response.get("answerLevel", 1))
    if level >= 1 and body.learnerChoice in HINT_LEDGER_CHOICES:
        store.note_hint(body.taskId, level)
        store.add_evidence(
            task_id=body.taskId,
            source_type="hint_usage",
            observed_fact=f"孩子选择「{body.learnerChoice}」，看到第 {level} 级提示",
            interpretation_text="这是一次提示使用记录，用于决定下一次帮助方式",
            confidence=0.9,
            alternatives=["孩子可能只是随手点的"],
            follow_up="看孩子是否根据提示修改并再次运行",
        )
    return ok(response)