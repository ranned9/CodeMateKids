"""辅导输出四重校验：结构、长度、动作枚举与儿童安全规则。"""

from __future__ import annotations

from typing import Any

from backend.infra.errors import child_message_is_safe
from backend.tutor.engine import TUTOR_ACTIONS, is_diagnostic_text

MAX_MESSAGE_CHARS = 120
PERSONAL_SOLICIT_TOKENS = ("密码", "住址", "电话", "联系方式", "学校", "班级", "身份证")
FULL_SOLUTION_TOKENS = ("for ", "range(", "stage.", "print(", "=")


def validate_response(
    response: dict[str, Any],
    allow_full_solution: bool = False,
) -> tuple[bool, str]:
    for key in ("action", "message", "nextStep", "uncertainty", "answerLevel", "mode"):
        if key not in response:
            return False, f"missing:{key}"
    if response.get("action") not in TUTOR_ACTIONS:
        return False, "action_out_of_enum"
    message = response.get("message")
    if not isinstance(message, str) or not message.strip():
        return False, "message_empty"
    if len(message) > MAX_MESSAGE_CHARS:
        return False, "message_too_long"
    if not isinstance(response.get("nextStep"), str) or not response["nextStep"].strip():
        return False, "next_step_missing"
    answer_level = response.get("answerLevel")
    if answer_level not in (0, 1, 2, 3):
        return False, "answer_level_invalid"
    if response.get("mode") not in ("mock", "model"):
        return False, "mode_invalid"
    if not isinstance(response.get("evidenceUsed", []), list):
        return False, "evidence_used_invalid"

    if not child_message_is_safe(message):
        return False, "unsafe_reference"
    if is_diagnostic_text(message):
        return False, "diagnostic_claim"
    if any(token in message for token in PERSONAL_SOLICIT_TOKENS):
        return False, "personal_info_request"
    if answer_level >= 3 and not allow_full_solution:
        return False, "full_solution_too_early"
    if not allow_full_solution and any(token in message for token in FULL_SOLUTION_TOKENS):
        return False, "full_solution_too_early"
    return True, "ok"