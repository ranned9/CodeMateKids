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


def learning_reply(context: dict[str, Any], decision: Decision, bundle: CourseBundle | None) -> dict[str, Any]:
    pattern = decision.error_pattern
    action = decision.action
    facts = context.get("facts") or {}
    templates = bundle.replies if bundle else []
    selected = next((item for item in templates if (
        item["taskId"] == context["task_id"] and item["errorPattern"] == pattern
        and item["action"] == action and item["level"] == decision.level
        and item["learnerChoice"] in (context["learner_choice"], "none")
    )), None)
    guidance = {
        "program_invalid": ("先看有没有积木还缺数字，或还没接好。", "检查这块积木后再试"),
        "run_incomplete": ("这次没跑完。准备好时，再试着运行一次。", "检查积木并重新运行"),
        "not_run": ("先看一眼积木，猜猜前进会执行几次。", "先预测，再运行"),
        "square_loop_structure": ("每条边都会前进和转弯。它们能放进同一个重复积木吗？", "看看重复积木里有哪些动作"),
        "action_outside_loop": ("这块前进只执行了一次。放进重复积木之后，它会动几次？", "看看前进积木的位置"),
        "loop_count_mismatch": ("每一轮走的步数一样。多一轮或少一轮，会走到哪里？", "试着只改重复的次数"),
        "move_steps_mismatch": ("看看每轮走了几步。可以换用新的「向前走」，每次会走一步。", "换用新的向前走积木，再调整重复次数"),
        "prediction_mismatch": ("你刚刚数的是前进了几次，还是一共走了几步？", "对照猜想和实际移动次数"),
        "goal_met": ("这次运行达到了目标。想一想，哪些动作把海龟带到了那里？", "试试下一题，或看学习小结"),
        "personal_info": ("我们把注意力放回积木。你想先看哪个动作？", "看看当前任务"),
        "ask_answer": ("我们一起找第一步。哪块积木控制重复？", "先选一块积木观察"),
        "off_topic": ("我们先回到积木任务。海龟接下来会怎么走？", "看看目标和当前积木"),
        "unknown": ("先看海龟这次做了什么，再选一处试着改。", "只改一处，重新猜一猜并运行"),
    }
    message, next_step = guidance.get(pattern, guidance["unknown"])
    if pattern == "not_run" and context.get("goal_kind") == "square":
        message, next_step = "走完一条边后，海龟要怎么面向下一条边？", "先搭一条边的动作，再预测并运行"
    if pattern == "loop_count_mismatch" and facts.get("actualSteps") is not None:
        direction = "再走一轮" if facts["actualSteps"] < facts["targetSteps"] else "少走一轮"
        message = f"这次走了 {facts['actualSteps']} 步。{direction}，会走到哪里？"
    if action == "show_execution":
        next_step = "看看每轮走了几步，再只改一个数字"
    elif action == "analogy":
        message, next_step = "拍一下手再跺一下脚。这一组动作做很多次，就像把两个动作放进重复里。", "想想你的积木里哪组动作重复了"
    elif action == "partial_example":
        message, next_step = "举个别的例子，每次拍 3 下，拍两轮一共是 6 下。想想你的海龟每一轮做了什么。", "选一个数字改一改，再运行核对"
        if context.get("goal_kind") == "square":
            message, next_step = "想象沿着桌边走。走到每个角，要先转向下一条边。", "找出每条边都要做的两个动作"
    if decision.level == 0:
        if context["learner_choice"] == "skip":
            message, next_step = "先把这道题留在这里，想试的时候可以回来。", "回到任务列表"
        else:
            message, next_step = "好，轮到你自己试试。", "回到积木，准备好就运行"
    if selected:
        message, next_step = selected["message"], selected["nextStep"]
    return {
        "action": action,
        "message": message,
        "nextStep": next_step,
        "uncertainty": "我们可以再运行一次看看。" if pattern in ("not_run", "unknown", "run_incomplete") else "",
        "answerLevel": decision.level,
        "evidenceUsed": ["run_result"] if context.get("run_id") else [],
        "mode": "mock",
        "showAsDemo": True,
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
        "action": decision.action,
        "message": payload["message"],
        "nextStep": payload["nextStep"],
        "uncertainty": payload["uncertainty"],
        "answerLevel": int(decision.level),
        "evidenceUsed": list(evidence)[:4],
        "mode": "mock",
        "showAsDemo": True,
    }
