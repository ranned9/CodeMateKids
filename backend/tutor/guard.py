"""辅导输出四重校验：结构、长度、动作枚举与儿童安全规则。"""

from __future__ import annotations

import re
from typing import Any

from backend.infra.errors import child_message_is_safe
from backend.tutor.engine import TUTOR_ACTIONS, is_diagnostic_text
from backend.tutor.model import numeric_observations

MAX_MESSAGE_CHARS = 120
PERSONAL_SOLICIT_TOKENS = ("密码", "住址", "电话", "联系方式", "学校", "班级", "身份证")
FULL_SOLUTION_TOKENS = ("for ", "range(", "stage.", "print(", "=")


def child_text_issue(value: Any, max_chars: int = MAX_MESSAGE_CHARS) -> str | None:
    if not isinstance(value, str) or len(value) > max_chars or not child_message_is_safe(value):
        return "unsafe_reference"
    if is_diagnostic_text(value):
        return "diagnostic_claim"
    if any(token in value for token in PERSONAL_SOLICIT_TOKENS):
        return "personal_info_request"
    return None


def validate_response(
    response: dict[str, Any],
    allow_full_solution: bool = False,
    *,
    decision: Any = None,
    context: dict[str, Any] | None = None,
    enhanced_local: bool = False,
) -> tuple[bool, str]:
    for key in ("action", "message", "nextStep", "uncertainty", "answerLevel", "mode"):
        if key not in response:
            return False, f"missing:{key}"
    action = response.get("action")
    if action not in TUTOR_ACTIONS:
        return False, "action_out_of_enum"
    message = response.get("message")
    if not isinstance(message, str) or not message.strip():
        return False, "message_empty"
    if len(message) > MAX_MESSAGE_CHARS:
        return False, "message_too_long"
    if not isinstance(response.get("nextStep"), str) or not response["nextStep"].strip():
        return False, "next_step_missing"
    answer_level = response.get("answerLevel")
    if type(answer_level) is not int or answer_level not in (0, 1, 2, 3):
        return False, "answer_level_invalid"
    if response.get("mode") not in ("mock", "model"):
        return False, "mode_invalid"
    if not isinstance(response.get("evidenceUsed", []), list):
        return False, "evidence_used_invalid"

    for field in ("message", "nextStep", "uncertainty"):
        value = response[field]
        issue = child_text_issue(value)
        if issue:
            return False, issue
        if not allow_full_solution and any(token in value for token in FULL_SOLUTION_TOKENS):
            return False, "full_solution_too_early"
    if answer_level >= 3 and not (allow_full_solution or enhanced_local or decision):
        return False, "full_solution_too_early"
    if decision is not None:
        if response["action"] != decision.action or answer_level != decision.level or response["mode"] != "model":
            return False, "decision_mismatch"
        observations = numeric_observations(context or {})
        used = response.get("factIdsUsed", [])
        if not isinstance(used, list) or any(not isinstance(item, str) or item not in observations for item in used):
            return False, "unsupported_fact"
        if any(item != "run_result" for item in response.get("evidenceUsed", [])):
            return False, "unsupported_evidence"
        text = " ".join(response[field] for field in ("message", "nextStep", "uncertainty"))
        if any(int(digits) not in observations.values() for digits in re.findall(r"\d+", text)):
            return False, "unsupported_number"
        if re.search(r"(?:设为|填入|填上|改成|答案是)\s*[\d零一二两三四五六七八九十]", text):
            return False, "prescribed_answer"
    return True, "ok"
