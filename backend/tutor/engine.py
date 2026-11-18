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
    "角色",
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
    message = str(context.get("message", ""))
    if _contains_any(message, PERSONAL_TOKENS):
        return "personal_info"
    if _contains_any(message, DIRECT_ANSWER_TOKENS):
        return "ask_answer"
    if message.strip() and not _contains_any(message, TASK_KEYWORDS):
        return "off_topic"
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


def is_diagnostic_text(text: str) -> bool:
    tokens = ("你不会", "已掌握", "已经掌握", "不擅长", "能力不足", "学习障碍", "做不好")
    return any(token in text for token in tokens)