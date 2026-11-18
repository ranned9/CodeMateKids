"""本地预置回复：模型不可用时的兜底，始终标识模拟模式。"""

from __future__ import annotations

from typing import Any

from backend.infra.config import Settings
from backend.service.course import CourseBundle, load_course
from backend.tutor.engine import Decision

SAFE_FALLBACK = {
    "action": "hint",
    "message": "我们先回到任务看看：角色现在走到了第几步？",
    "nextStep": "运行一次，看看角色的位置",
    "uncertainty": "我还没有看到这次运行的结果。",
}


def _pick_reply(
    replies: list[dict[str, Any]],
    task_id: str,
    error_pattern: str,
    learner_choice: str,
    level: int,
) -> dict[str, Any] | None:
    task_replies = [item for item in replies if item.get("taskId") == task_id]

    def pick(pattern: str, choice: str, exact_level: int | None) -> dict[str, Any] | None:
        candidates = [
            item
            for item in task_replies
            if item.get("errorPattern") == pattern
            and item.get("learnerChoice") == choice
            and (exact_level is None or item.get("level") == exact_level)
        ]
        if not candidates:
            return None
        candidates.sort(key=lambda item: item.get("level", 1))
        return candidates[-1]

    if learner_choice in ("self_try", "skip", "example"):
        for pattern in ("default", error_pattern):
            for choice in (learner_choice, "none"):
                selected = pick(pattern, choice, None)
                if selected:
                    return selected
    for pattern in (error_pattern, "default"):
        for choice in (learner_choice, "hint", "none"):
            selected = pick(pattern, choice, level)
            if selected:
                return selected
        for choice in (learner_choice, "hint", "none"):
            selected = pick(pattern, choice, None)
            if selected:
                return selected
    return None


def reply(
    settings: Settings,
    context: dict[str, Any],
    decision: Decision,
    bundle: CourseBundle | None = None,
) -> dict[str, Any]:
    bundle = bundle or load_course(settings)
    task_id = str(context.get("task_id", "main"))
    selected = _pick_reply(
        bundle.replies,
        task_id,
        decision.error_pattern,
        str(context.get("learner_choice", "hint")),
        decision.level,
    )
    if selected is None:
        payload = dict(SAFE_FALLBACK)
        payload["answerLevel"] = 1
    else:
        payload = {
            "action": selected.get("action", decision.action),
            "message": str(selected.get("message", SAFE_FALLBACK["message"])),
            "nextStep": str(selected.get("nextStep", SAFE_FALLBACK["nextStep"])),
            "uncertainty": str(selected.get("uncertainty", SAFE_FALLBACK["uncertainty"])),
            "answerLevel": int(selected.get("level", decision.level)),
        }
    evidence = context.get("evidence_types") or ["run_result"]
    return {
        "action": payload["action"],
        "message": payload["message"],
        "nextStep": payload["nextStep"],
        "uncertainty": payload["uncertainty"],
        "answerLevel": payload["answerLevel"],
        "evidenceUsed": list(evidence)[:4],
        "mode": "mock",
        "showAsDemo": True,
    }