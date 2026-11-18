"""运行门禁单一真源：环境、worker、课程、任务与预测的统一判定。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from backend.infra.errors import get_error_spec


@dataclass(frozen=True)
class RunGateDecision:
    allowed: bool
    code: str | None
    message_for_child: str
    check: str


def _check_status(report: dict[str, Any], name: str) -> str:
    for item in report.get("checks", []):
        if item.get("name") == name:
            return str(item.get("status", "failed"))
    return "failed"


def evaluate_run_gate(
    report: dict[str, Any],
    task_id: str,
    task_enterable: bool,
    has_prediction: bool,
) -> RunGateDecision:
    if _check_status(report, "os") == "failed":
        spec = get_error_spec("PYTHON_VERSION_MISMATCH")
        return RunGateDecision(False, "PYTHON_VERSION_MISMATCH", spec.message_for_child, "os")
    if _check_status(report, "python") == "failed":
        spec = get_error_spec("PYTHON_VERSION_MISMATCH")
        return RunGateDecision(False, "PYTHON_VERSION_MISMATCH", spec.message_for_child, "python")
    if _check_status(report, "schema") == "failed":
        spec = get_error_spec("COURSE_VERSION_UNSUPPORTED")
        return RunGateDecision(False, "COURSE_VERSION_UNSUPPORTED", spec.message_for_child, "schema")
    if _check_status(report, "worker") != "passed":
        spec = get_error_spec("RUNNER_UNAVAILABLE")
        return RunGateDecision(False, "RUNNER_UNAVAILABLE", spec.message_for_child, "worker")
    if _check_status(report, "course") == "failed":
        spec = get_error_spec("COURSE_VERSION_UNSUPPORTED")
        return RunGateDecision(False, "COURSE_VERSION_UNSUPPORTED", spec.message_for_child, "course")
    if not task_enterable:
        spec = get_error_spec("TASK_NOT_RUNNABLE")
        return RunGateDecision(False, "TASK_NOT_RUNNABLE", spec.message_for_child, f"task:{task_id}")
    if not has_prediction:
        spec = get_error_spec("PREDICTION_REQUIRED")
        return RunGateDecision(False, "PREDICTION_REQUIRED", spec.message_for_child, "prediction")
    return RunGateDecision(True, None, "", "")


def build_run_capability(
    report: dict[str, Any],
    blocked_task_ids: list[str],
    content_version: str,
) -> dict[str, Any]:
    worker_ready = _check_status(report, "worker") == "passed"
    fatal = any(
        _check_status(report, name) == "failed" for name in ("os", "python", "schema")
    )
    course_failed = _check_status(report, "course") == "failed"

    reason_code: str | None = None
    reason_for_child = ""
    if _check_status(report, "os") == "failed" or _check_status(report, "python") == "failed":
        reason_code = "PYTHON_VERSION_MISMATCH"
    elif _check_status(report, "schema") == "failed":
        reason_code = "COURSE_VERSION_UNSUPPORTED"
    elif not worker_ready:
        reason_code = "RUNNER_UNAVAILABLE"
    elif course_failed:
        reason_code = "COURSE_VERSION_UNSUPPORTED"
    if reason_code:
        reason_for_child = get_error_spec(reason_code).message_for_child

    return {
        "canRun": not fatal and worker_ready and not course_failed,
        "reasonCode": reason_code,
        "reasonForChild": reason_for_child,
        "workerReady": worker_ready,
        "blockedTaskIds": list(blocked_task_ids),
        "contentVersion": content_version,
    }