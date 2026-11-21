"""辅导回复包逐条校验：加载期发现坏条目，避免进入儿童请求路径。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from backend.tutor.enums import all_patterns

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
ERROR_PATTERNS = all_patterns()
MAX_DIAGNOSTICS = 100


@dataclass
class ReplyValidationReport:
    valid: list[dict[str, Any]] = field(default_factory=list)
    diagnostics: list[dict[str, Any]] = field(default_factory=list)

    @property
    def all_invalid(self) -> bool:
        return not self.valid


def validate_reply_entries(replies: Any, task_ids: set[str]) -> ReplyValidationReport:
    report = ReplyValidationReport()
    if not isinstance(replies, list):
        report.diagnostics.append({"index": -1, "field": "replies", "reason": "不是数组"})
        return report

    for index, item in enumerate(replies):
        reason = _single_reply_problem(item, task_ids)
        if reason is None:
            report.valid.append(item)
            continue
        if len(report.diagnostics) < MAX_DIAGNOSTICS:
            report.diagnostics.append({"index": index, "field": reason[0], "reason": reason[1]})
    return report


def _single_reply_problem(item: Any, task_ids: set[str]) -> tuple[str, str] | None:
    if not isinstance(item, dict):
        return ("entry", "不是对象")
    required = ("taskId", "errorPattern", "learnerChoice", "level", "action", "message", "nextStep", "uncertainty")
    for key in required:
        if key not in item:
            return (key, "缺少字段")

    if str(item["taskId"]) not in task_ids:
        return ("taskId", "不属于本课程")
    if item["errorPattern"] not in ERROR_PATTERNS:
        return ("errorPattern", "未知错误模式")
    if item["learnerChoice"] not in LEARNER_CHOICES:
        return ("learnerChoice", "未知帮助偏好")
    if item["action"] not in TUTOR_ACTIONS:
        return ("action", "未知动作")

    level = item["level"]
    if isinstance(level, bool) or not isinstance(level, int):
        return ("level", "等级必须是整数")
    if level not in (0, 1, 2, 3):
        return ("level", "等级越界")
    if level == 0 and item["learnerChoice"] not in ("self_try", "skip"):
        return ("level", "0 级只允许自己试或跳过")

    message = item["message"]
    if not isinstance(message, str) or not message.strip():
        return ("message", "消息为空")
    if len(message) > 120:
        return ("message", "消息超过 120 字")
    for key in ("nextStep", "uncertainty"):
        if not isinstance(item[key], str) or not item[key].strip():
            return (key, "不能为空")
    return None