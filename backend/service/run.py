"""运行编排：门禁受理、终态收敛、SSE、取消、快照、证据与日志。"""

from __future__ import annotations

import json
import re
import threading
import time
from threading import Thread
import uuid
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any, Iterator

from backend.domain.program import ProgramError, evaluate_criteria, validate_program
from backend.infra.config import Settings
from backend.infra.errors import ApiError, error_object
from backend.infra.logging import write_log
from backend.runner.supervisor import run_program
from backend.service.course import load_course
from backend.service.gate import evaluate_run_gate
from backend.service.startup import check_startup
from backend.session.store import SessionStore

RUN_RETENTION_S = 300
IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
OUTCOME_BY_STATUS = {
    "completed": "succeeded",
    "failed": "failed",
    "timeout": "timeout",
    "resource_exceeded": "resource",
    "cancelled": "cancelled",
    "crashed": "crashed",
}


def validate_request_id(value: Any) -> str:
    if not isinstance(value, str) or not IDENTIFIER_PATTERN.match(value):
        raise ApiError("RUN_REQUEST_INVALID")
    return value


def validate_run_identifiers(payload: dict[str, Any]) -> tuple[str, str]:
    request_id = validate_request_id(payload.get("requestId"))
    cancel_token = validate_request_id(payload.get("cancelToken"))
    return request_id, cancel_token


@dataclass
class RunContext:
    request_id: str
    cancel_token: str
    task_id: str
    task_snapshot: dict[str, Any] = field(default_factory=dict)
    cancel_event: threading.Event = field(default_factory=threading.Event)
    frames: list[dict[str, Any]] = field(default_factory=list)
    condition: threading.Condition = field(default_factory=threading.Condition)
    finished: bool = False
    created_at: float = field(default_factory=time.time)
    result: dict[str, Any] | None = None
    stderr_summary: str = ""
    last_block_id: str | None = None

    def publish(self, event_name: str, data: dict[str, Any]) -> None:
        with self.condition:
            self.frames.append({"id": len(self.frames) + 1, "event": event_name, "data": data})
            self.condition.notify_all()

    def finish(self) -> None:
        with self.condition:
            self.finished = True
            self.condition.notify_all()


class RunManager:
    def __init__(self, settings: Settings, session: SessionStore) -> None:
        self.settings = settings
        self.session = session
        self._lock = threading.Lock()
        self._runs: dict[str, RunContext] = {}
        self._active_id: str | None = None

    def _cleanup(self) -> None:
        now = time.time()
        with self._lock:
            stale = [
                run_id
                for run_id, context in self._runs.items()
                if context.finished and now - context.created_at > RUN_RETENTION_S
            ]
            for run_id in stale:
                self._runs.pop(run_id, None)

    def submit(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._cleanup()
        request_id, cancel_token = validate_run_identifiers(payload)
        task_id = str(payload.get("taskId") or "")

        startup = check_startup(self.settings)
        bundle = load_course(self.settings)
        task = bundle.tasks.get(task_id)
        if task is None:
            raise ApiError("PROGRAM_SCHEMA_INVALID")
        task_enterable = task_id not in bundle.blocked
        decision = evaluate_run_gate(
            startup,
            task_id,
            task_enterable,
            self.session.has_prediction(task_id),
        )
        if not decision.allowed:
            raise ApiError(str(decision.code))

        target = payload.get("target") or {}
        if target.get("language") != "python" or target.get("version") != "3.12":
            raise ApiError("PYTHON_VERSION_MISMATCH")

        program = payload.get("program")
        try:
            validate_program(program, bundle.registry, expected_task_id=task_id)
        except ProgramError as exc:
            raise ApiError(exc.code, exc.block_id, exc.message) from exc

        limits = self._clamp_limits(payload.get("limits"))

        with self._lock:
            if request_id in self._runs:
                raise ApiError("RUN_ID_CONFLICT")
            if self._active_id is not None:
                active = self._runs.get(self._active_id)
                if active is not None and not active.finished:
                    raise ApiError("RUN_IN_PROGRESS")
            context = RunContext(
                request_id=request_id,
                cancel_token=cancel_token,
                task_id=task_id,
                task_snapshot=deepcopy(task),
            )
            self._runs[request_id] = context
            self._active_id = request_id

        thread = Thread(target=self._execute, args=(context, program, limits), daemon=True)
        try:
            thread.start()
        except Exception as exc:  # noqa: BLE001 - 线程启动失败必须回滚
            with self._lock:
                self._runs.pop(request_id, None)
                if self._active_id == request_id:
                    self._active_id = None
            context.finish()
            self._diagnose(context, "run_start_failed", type(exc).__name__)
            raise ApiError("RUN_START_FAILED") from exc
        return {"requestId": request_id, "cancelToken": cancel_token, "status": "accepted"}

    def _clamp_limits(self, requested: dict[str, Any] | None) -> dict[str, Any]:
        requested = requested or {}

        def clamp(name: str, maximum: int, default: int) -> int:
            try:
                value = int(requested.get(name, default))
            except (TypeError, ValueError):
                value = default
            return max(1, min(value, maximum))

        return {
            "wallTimeMs": clamp("wallTimeMs", self.settings.run_wall_ms, self.settings.run_wall_ms),
            "memoryMb": clamp("memoryMb", self.settings.run_memory_mb, self.settings.run_memory_mb),
            "maxOutputBytes": clamp(
                "maxOutputBytes", self.settings.run_output_bytes, self.settings.run_output_bytes
            ),
            "maxRecursionDepth": clamp(
                "maxRecursionDepth", self.settings.run_recursion_depth, self.settings.run_recursion_depth
            ),
        }

    def _execute(self, context: RunContext, program: dict[str, Any], limits: dict[str, Any]) -> None:
        started = time.perf_counter()
        context.publish("started", {"requestId": context.request_id, "taskId": context.task_id})

        def on_frame(frame: dict[str, Any]) -> None:
            frame_type = frame.get("type")
            if frame_type == "event":
                if frame.get("blockId"):
                    context.last_block_id = str(frame.get("blockId"))
                context.publish(
                    "event",
                    {
                        "seq": frame.get("seq"),
                        "blockId": frame.get("blockId"),
                        "kind": frame.get("kind"),
                        "timestampMs": frame.get("timestampMs"),
                    },
                )
            elif frame_type == "stdout":
                context.publish("stdout", {"seq": frame.get("seq"), "text": frame.get("text")})

        def on_diagnostic(event_name: str, payload: dict[str, Any]) -> None:
            summary = payload.get("stderrSummary")
            if isinstance(summary, str) and summary:
                context.stderr_summary = summary

        try:
            result = run_program(
                program,
                limits,
                context.request_id,
                context.cancel_event,
                on_frame,
                on_diagnostic,
            )
            success, failures = evaluate_criteria(context.task_snapshot, result.get("objects", []))
            result["success"] = bool(success and result.get("status") == "completed")
            result["failures"] = failures
            result["memoryLimitMode"] = result.get("memoryLimitMode", "unavailable")
            self._publish_terminal_once(context, result)
        except Exception as exc:  # noqa: BLE001 - 编排异常必须收敛为崩溃终态
            if context.result is None:
                self._publish_terminal_once(context, self._crash_result(context, started, type(exc).__name__))
            else:
                self._diagnose(context, "run_finalize_error", type(exc).__name__)
        finally:
            self._finalize_run(context, started)

    def _publish_terminal_once(self, context: RunContext, result: dict[str, Any]) -> bool:
        with context.condition:
            if context.result is not None:
                return False
            context.result = result
            context.frames.append(
                {"id": len(context.frames) + 1, "event": "result", "data": result}
            )
            if result.get("status") != "completed":
                context.frames.append(
                    {
                        "id": len(context.frames) + 1,
                        "event": "error",
                        "data": result.get("error") or {},
                    }
                )
            context.condition.notify_all()
            return True

    def _crash_result(self, context: RunContext, started: float, cause: str) -> dict[str, Any]:
        return {
            "protocolVersion": 1,
            "requestId": context.request_id,
            "status": "crashed",
            "stdout": "",
            "stderr": "",
            "error": error_object("RUNNER_CRASHED", context.last_block_id),
            "events": [],
            "durationMs": int((time.perf_counter() - started) * 1000),
            "truncated": False,
            "objects": [],
            "success": False,
            "failures": ["运行意外中断"],
            "memoryLimitMode": "unavailable",
            "cause": cause,
        }

    def _finalize_run(self, context: RunContext, started: float) -> None:
        if context.result is not None:
            self._record_outcome_safely(context)
        self._log_finished_safely(context, started)
        context.finish()
        with self._lock:
            if self._active_id == context.request_id:
                self._active_id = None

    def _record_outcome_safely(self, context: RunContext) -> None:
        try:
            self._record_outcome(context)
        except Exception as exc:  # noqa: BLE001 - 证据失败不得影响终态
            self._diagnose(context, "run_finalize_error", type(exc).__name__)

    def _record_outcome(self, context: RunContext) -> None:
        result = context.result or {}
        status = str(result.get("status", "crashed"))
        outcome = OUTCOME_BY_STATUS.get(status, "crashed")
        if outcome == "succeeded" and not result.get("success"):
            outcome = "failed"
        task = context.task_snapshot
        task_id = context.task_id
        self.session.record_attempt(task_id, context.request_id, outcome)
        objects = result.get("objects") or []
        steps = 0
        for item in objects:
            if isinstance(item, dict) and item.get("id") == "stage":
                steps = int(item.get("steps", 0))
        if outcome in ("cancelled", "timeout"):
            observed = f"本次运行未完成（{status}），没有产生成功结果"
            interpretation = "这次没有拿到完整结果，不能据此判断孩子是否理解"
            confidence = 1.0
        elif outcome == "succeeded":
            observed = f"本次运行角色累计走了 {steps} 步，达到任务成功标准"
            interpretation = "孩子在这一次任务中达成了可见目标"
            confidence = 0.9
        else:
            observed = f"本次运行角色累计走了 {steps} 步，未达到任务成功标准"
            interpretation = "这一次的结果与目标不一致，原因可能是循环次数或动作位置"
            confidence = 0.8
        source_type = "transfer_task" if task.get("type") == "variant" else "run_result"
        self.session.add_evidence(
            task_id=task_id,
            source_type=source_type,
            observed_fact=observed,
            interpretation_text=interpretation,
            confidence=confidence,
            alternatives=["操作还不熟练", "可能没看清任务目标", "可能只是这次数错了"],
            follow_up="下一次换一个步数，再先预测再运行",
            request_id=context.request_id,
        )

    def _log_finished_safely(self, context: RunContext, started: float) -> None:
        try:
            result = context.result or {}
            write_log(
                self.settings,
                {
                    "event": "run_finished",
                    "requestId": context.request_id,
                    "protocolVersion": 1,
                    "schemaVersion": "1.0.0",
                    "category": str((result.get("error") or {}).get("category", "ok")),
                    "durationMs": int((time.perf_counter() - started) * 1000),
                    "matrixCaseId": "TC-RUN-01",
                    "pythonVersion": "3.12",
                    "appVersion": self.settings.app_version,
                    "stderrSummary": context.stderr_summary[:160],
                },
            )
        except Exception as exc:  # noqa: BLE001 - 日志失败不得影响终态
            self._diagnose(context, "run_finalize_error", type(exc).__name__)

    def _diagnose(self, context: RunContext, event: str, reason: str) -> None:
        try:
            write_log(
                self.settings,
                {
                    "event": event,
                    "requestId": context.request_id,
                    "category": "finalize",
                    "matrixCaseId": "TC-RUN-FINALIZE",
                    "appVersion": self.settings.app_version,
                    "stderrSummary": reason[:160],
                },
            )
        except Exception:
            pass

    def snapshot(self, request_id: str) -> dict[str, Any] | None:
        with self._lock:
            context = self._runs.get(request_id)
        if context is None:
            return None
        result = context.result or {}
        if context.finished and not result:
            status = "crashed"
        else:
            status = str(result.get("status") or "running")
        return {
            "requestId": request_id,
            "finished": context.finished,
            "status": status,
            "errorCategory": (result.get("error") or {}).get("category"),
        }

    def stream(self, request_id: str, last_event_id: int = 0) -> Iterator[str]:
        with self._lock:
            context = self._runs.get(request_id)
        if context is None:
            raise ApiError("RUN_NOT_FOUND")

        def generator() -> Iterator[str]:
            index = 0
            while True:
                with context.condition:
                    while index >= len(context.frames) and not context.finished:
                        context.condition.wait(timeout=0.2)
                    frames = context.frames[index:]
                    finished = context.finished
                for frame in frames:
                    index += 1
                    if frame["id"] <= last_event_id:
                        continue
                    payload = json.dumps(frame["data"], ensure_ascii=False)
                    yield (
                        f"id: {frame['id']}\n"
                        f"event: {frame['event']}\n"
                        f"data: {payload}\n\n"
                    )
                if finished and index >= len(context.frames):
                    break

        return generator()

    def cancel(self, request_id: str, cancel_token: str) -> dict[str, Any]:
        validate_request_id(request_id)
        with self._lock:
            context = self._runs.get(request_id)
        if context is None:
            raise ApiError("RUN_NOT_FOUND")
        if context.cancel_token != cancel_token:
            raise ApiError("CANCEL_TOKEN_MISMATCH")
        if context.finished:
            return {"requestId": request_id, "status": "already_finished"}
        context.cancel_event.set()
        return {"requestId": request_id, "status": "cancelling"}

    def new_request_id(self) -> tuple[str, str]:
        return (f"run-{uuid.uuid4().hex[:12]}", uuid.uuid4().hex)