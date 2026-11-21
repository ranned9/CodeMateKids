"""错误码唯一真源、统一包封与儿童可见文案。

错误对象只暴露 {code, category, messageForChild, blockId, recoverable}，
不存在 messageForDeveloper 与堆栈字段；开发者信息只写本地日志。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ErrorSpec:
    category: str
    http_status: int
    message_for_child: str
    recoverable: bool


ERROR_SPECS: dict[str, ErrorSpec] = {
    "EDITOR_INVALID_CONNECTION": ErrorSpec(
        "editor", 422, "这个积木不能放在这里，换一个位置试试。", True
    ),
    "PROGRAM_SCHEMA_INVALID": ErrorSpec(
        "input", 422, "程序结构有点问题，检查一下积木和参数吧。", True
    ),
    "PROGRAM_TOO_LARGE": ErrorSpec(
        "input_limit", 413, "积木太多啦，请先删掉一些再试。", True
    ),
    "COURSE_VERSION_UNSUPPORTED": ErrorSpec(
        "content", 409, "这节课的内容暂时打不开，可以稍后重试。", True
    ),
    "PYTHON_VERSION_MISMATCH": ErrorSpec(
        "environment", 503, "运行环境版本不对，需要 Python 3.12。", False
    ),
    "PYTHON_FEATURE_BLOCKED": ErrorSpec(
        "policy", 403, "这个积木现在不能运行，先换一个积木吧。", True
    ),
    "PYTHON_COMPILE_ERROR": ErrorSpec(
        "compile", 422, "积木还不能变成程序，检查一下参数吧。", True
    ),
    "PYTHON_RUNTIME_ERROR": ErrorSpec(
        "runtime", 200, "这个积木这一步出错了，看看下一步建议。", True
    ),
    "RUN_TIMEOUT": ErrorSpec(
        "timeout", 200, "程序运行太久，已安全停止，可以检查循环次数。", True
    ),
    "RUN_RESOURCE_LIMIT": ErrorSpec(
        "resource", 200, "程序占用资源太多了，已安全停止。", True
    ),
    "RUN_CANCELLED": ErrorSpec(
        "cancelled", 200, "已停止，可以修改后再运行。", True
    ),
    "RUNNER_CRASHED": ErrorSpec(
        "worker", 200, "运行意外中断，可以再试一次。", True
    ),
    "TUTOR_UNAVAILABLE": ErrorSpec(
        "ai", 200, "现在先使用演示回复继续学习。", True
    ),
    "RUN_IN_PROGRESS": ErrorSpec(
        "concurrency", 409, "程序正在运行，先等一下或点停止。", True
    ),
    "PREDICTION_INVALID": ErrorSpec(
        "prediction", 422, "先猜一猜角色会动几次，填一个数字吧。", True
    ),
    "PREDICTION_REQUIRED": ErrorSpec(
        "prediction_required", 409, "先完成预测，就可以运行啦。", True
    ),
    "PROGRAM_MIGRATION_FAILED": ErrorSpec(
        "migration", 422, "这个作品需要更新后才能打开。", True
    ),
    "MATRIX_INVALID": ErrorSpec(
        "matrix", 500, "能力清单暂时读不到，请重新启动。", False
    ),
    "RUN_NOT_FOUND": ErrorSpec(
        "run_lookup", 404, "找不到这次运行记录了。", True
    ),
    "CANCEL_TOKEN_MISMATCH": ErrorSpec(
        "cancel_token", 409, "这次停止请求对不上，请重新点停止。", True
    ),
    "FORBIDDEN": ErrorSpec(
        "access", 403, "这个操作只能在演示机上使用。", True
    ),
    "BAD_TAIL": ErrorSpec(
        "request", 400, "请求参数不太对，换一个数字试试。", True
    ),
    "DEMO_LIMIT_REACHED": ErrorSpec(
        "limit", 429, "今天先练到这里，休息一下再来吧。", True
    ),
    "RUN_START_FAILED": ErrorSpec(
        "worker_start", 503, "这次没能开始运行，休息一下再点一次运行。", True
    ),
    "RUNNER_UNAVAILABLE": ErrorSpec(
        "worker_ready", 503, "运行小助手还没有准备好，点「重新检查」或者稍后再试。", True
    ),
    "RUN_REQUEST_INVALID": ErrorSpec(
        "request_invalid", 422, "这次请求的信息不完整，刷新页面后再试。", True
    ),
    "RUN_ID_CONFLICT": ErrorSpec(
        "id_conflict", 409, "这次运行编号重复了，刷新页面后再运行。", True
    ),
    "TASK_NOT_RUNNABLE": ErrorSpec(
        "task_blocked", 409, "这个任务现在打不开，可以先试试另一个任务。", True
    ),
    "TUTOR_TURN_BUSY": ErrorSpec("tutor_busy", 409, "小老师正在回答，请稍等一下。", True),
    "TUTOR_TURN_CONFLICT": ErrorSpec("tutor_turn_conflict", 409, "请按现在的积木重新提问。", True),
    "STUDENT_NOT_FOUND": ErrorSpec("not_found", 404, "找不到这个学生，请重新选择档案。", True),
    "LEARNING_STORE_UNAVAILABLE": ErrorSpec("storage", 503, "暂时无法保存学习进度，可以继续练习。", True),
}

CHILD_SAFE_FORBIDDEN = (
    "traceback",
    "c:\\",
    "c:/",
    "/home/",
    ".py",
    "path=",
    "localhost",
    "127.0.0.1",
    "file \"",
    "site-packages",
    "systemroot",
)

_FALLBACK_MESSAGE = "这里遇到一点小问题，可以再试一次。"


def get_error_spec(code: str) -> ErrorSpec:
    spec = ERROR_SPECS.get(code)
    if spec is not None:
        return spec
    return ErrorSpec("unknown", 500, _FALLBACK_MESSAGE, True)


def child_message_is_safe(text: str) -> bool:
    lowered = text.lower()
    return not any(token in lowered for token in CHILD_SAFE_FORBIDDEN)


class ApiError(Exception):
    """业务错误：只携带儿童可见信息。"""

    def __init__(self, code: str, block_id: str | None = None, message: str | None = None) -> None:
        self.code = code
        self.block_id = block_id
        self.message = message
        super().__init__(code)

    @property
    def spec(self) -> ErrorSpec:
        return get_error_spec(self.code)

    def to_error(self) -> dict[str, Any]:
        spec = self.spec
        message = self.message or spec.message_for_child
        if not child_message_is_safe(message):
            message = spec.message_for_child
        return {
            "code": self.code,
            "category": spec.category,
            "messageForChild": message,
            "blockId": self.block_id,
            "recoverable": spec.recoverable,
        }


def ok(data: Any) -> dict[str, Any]:
    return {"ok": True, "data": data}


def fail(code: str, block_id: str | None = None, message: str | None = None) -> dict[str, Any]:
    return {"ok": False, "error": ApiError(code, block_id, message).to_error()}


def error_object(code: str, block_id: str | None = None, message: str | None = None) -> dict[str, Any]:
    return ApiError(code, block_id, message).to_error()
