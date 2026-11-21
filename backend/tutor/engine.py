"""辅导决策引擎：证据驱动升级、孩子选择优先、禁止能力诊断。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

TUTOR_ACTIONS = (
    "ask_question",
    "hint",
    "point_to_block",
    "show_execution",
    "analogy",
    "partial_example",
    "break_down",
    "explain",
    "offer_variant",
)

LEARNER_CHOICES = ("hint", "more_hint", "example", "self_try", "skip", "none")

PERSONAL_TOKENS = ("密码", "住址", "家庭地址", "电话", "手机号", "联系方式", "学校", "班级", "身份证")
DIRECT_ANSWER_TOKENS = ("答案", "直接告诉", "直接给", "帮我写")
TASK_KEYWORDS = (
    "循环",
    "重复",
    "步",
    "角色",
    "积木",
    "运行",
    "走",
    "几",
    "次",
    "海龟",
    "为什么",
    "怎么",
    "正方形",
    "转弯",
    "直角",
)


@dataclass
class Decision:
    action: str
    level: int
    error_pattern: str
    reason: str


def _contains_any(text: str, tokens: tuple[str, ...]) -> bool:
    return any(token in text for token in tokens)


def _select_error_pattern(context: dict[str, Any]) -> str:
    redirected = redirect_pattern(context)
    if redirected:
        return redirected
    summary = str(context.get("program_summary", ""))
    if not context.get("program_valid", True):
        return "action_outside_loop"
    last_status = context.get("last_run_status")
    if last_status and last_status != "completed":
        return "loop_count_mismatch"
    if context.get("last_success") is False:
        if "重复" not in summary:
            return "action_outside_loop"
        return "loop_count_mismatch"
    if "重复" not in summary:
        return "action_outside_loop"
    return "default"


def redirect_pattern(context: dict[str, Any]) -> str | None:
    message = str(context.get("message", ""))
    if _contains_any(message, PERSONAL_TOKENS):
        return "personal_info"
    if _contains_any(message, DIRECT_ANSWER_TOKENS):
        return "ask_answer"
    if message.strip() and not _contains_any(message, TASK_KEYWORDS):
        return "off_topic"
    return None


def decide(context: dict[str, Any]) -> Decision:
    choice = str(context.get("learner_choice", "hint"))
    if choice not in LEARNER_CHOICES:
        choice = "hint"
    highest = int(context.get("highest_hint", 0))
    error_pattern = _select_error_pattern(context)

    if choice == "self_try":
        return Decision("hint", 0, "default", "孩子想自己试，停止追加提示")
    if choice == "skip":
        return Decision("offer_variant", 0, "default", "孩子选择跳过，保留回到任务的入口")
    if choice == "example":
        return Decision("analogy", 1, "default", "孩子换了表达方式，使用类比")

    if error_pattern in ("personal_info", "off_topic"):
        return Decision("hint", 1, error_pattern, "先转回学习任务")

    if choice == "more_hint":
        level = min(3, highest + 1)
        if level < 2:
            level = 2
    else:
        level = 1 if highest == 0 else min(3, highest + 1)

    if level >= 3 and highest >= 3:
        return Decision("break_down", 3, error_pattern, "多轮提示后改成分步澄清")

    if level >= 2:
        if error_pattern == "loop_count_mismatch":
            return Decision("show_execution", level, error_pattern, "同类困难重复，改用执行过程")
        if error_pattern == "action_outside_loop":
            return Decision("point_to_block", level, error_pattern, "同类困难重复，改为指向积木")
        if error_pattern == "move_steps_mismatch":
            return Decision("break_down", level, error_pattern, "同类困难重复，改为拆分步骤")

    ladder_action = {
        1: "ask_question" if error_pattern in ("default", "loop_count_mismatch") else "hint",
        2: "hint",
        3: "partial_example",
    }[level]
    return Decision(ladder_action, level, error_pattern, "按提示阶梯选择动作")


PATTERN_ACTIONS = {
    "program_invalid": "point_to_block",
    "run_incomplete": "hint",
    "not_run": "ask_question",
    "square_loop_structure": "point_to_block",
    "action_outside_loop": "point_to_block",
    "loop_count_mismatch": "show_execution",
    "move_steps_mismatch": "break_down",
    "prediction_mismatch": "ask_question",
    "goal_met": "explain",
    "unknown": "hint",
}


def decide_with_facts(facts: Any, context: dict[str, Any]) -> Decision:
    """按教学事实决策；0 级语义与孩子选择优先保持不变。"""
    from backend.tutor.diagnosis import classify

    choice = str(context.get("learner_choice", "hint"))
    if choice not in LEARNER_CHOICES:
        choice = "hint"
    if choice == "self_try":
        return Decision("hint", 0, "default", "孩子想自己试，停止追加提示")
    if choice == "skip":
        return Decision("offer_variant", 0, "default", "孩子选择跳过，保留回到任务的入口")

    pattern = redirect_pattern(context)
    if pattern:
        return Decision("hint", 1, pattern, "先转回学习任务")
    pattern = context.get("pattern") or classify(facts)
    highest = int(context.get("highest_hint", 0))
    if choice == "example":
        return Decision("analogy", 1, pattern, "换一种说法")
    if pattern == "goal_met":
        return Decision("explain", 1, pattern, "目标已达成，说出本次观察")

    if choice == "more_hint":
        level = 3 if highest >= 2 else 2
    else:
        level = 2 if context.get("repeated_pattern") else 1
    action = PATTERN_ACTIONS.get(pattern, "hint")
    if pattern == "loop_count_mismatch" and (level == 1 or not context.get("replay_available")):
        action = "ask_question" if level == 1 else "point_to_block"
    if pattern == "move_steps_mismatch":
        action = "show_execution" if level == 2 and context.get("replay_available") else "point_to_block"
    if level == 3:
        action = "partial_example"
    return Decision(action, level, pattern, "按事实与提示阶梯选择动作")


def is_diagnostic_text(text: str) -> bool:
    tokens = ("你不会", "已掌握", "已经掌握", "不擅长", "能力不足", "学习障碍", "做不好")
    return any(token in text for token in tokens)
