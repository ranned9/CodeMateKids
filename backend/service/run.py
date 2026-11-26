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
from typing import Any, Generator

from backend.domain.program import ProgramError, evaluate_criteria, program_roots
from backend.infra.config import Settings
from backend.infra.errors import ApiError, error_object
from backend.infra.logging import write_log
from backend.runner.supervisor import run_program
from backend.service.course import load_course
from backend.service.gate import evaluate_run_gate
from backend.service.program_digest import digest_program
from backend.service.startup import check_startup
from backend.service.teaching import (
    build_learning, described_edit, edit_signatures, execution_failures, learning_key, match_prediction,
    structure_facts, validate_snapshot,
)
from backend.session.store import SessionStore
from backend.tutor.enums import Support

RUN_RETENTION_S = 300
DEBUG_CONNECT_TIMEOUT_S = 10
STREAM_KEEP_ALIVE_S = 1
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
    session: SessionStore
    student_id: str | None = None
    task_snapshot: dict[str, Any] = field(default_factory=dict)
    content_version: str | None = None
    learning_key: str | None = None
    program_digest: str | None = None
    prediction: dict[str, Any] | None = None
    support: str | None = None
    hint_level: int | None = None
    cancel_event: threading.Event = field(default_factory=threading.Event)
    frames: list[dict[str, Any]] = field(default_factory=list)
    condition: threading.Condition = field(default_factory=threading.Condition)
    finished: bool = False
    created_at: float = field(default_factory=time.time)
    result: dict[str, Any] | None = None
    stderr_summary: str = ""
    last_block_id: str | None = None
    debug: bool = False
    waiting_step: int | None = None
    pending_step: int | None = None
    stream_clients: int = 0

    def publish(self, event_name: str, data: dict[str, Any]) -> None:
        with self.condition:
            if self.debug and event_name == "event" and data["kind"] == "block_enter":
                self.waiting_step = data["seq"]
            self.frames.append({"id": len(self.frames) + 1, "event": event_name, "data": data})
            self.condition.notify_all()

    def take_step(self) -> int | None:
        with self.condition:
            if not self.stream_clients and time.time() - self.created_at >= DEBUG_CONNECT_TIMEOUT_S:
                self.cancel_event.set()
                return None
            seq, self.pending_step = self.pending_step, None
            return seq

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

    def submit(self, payload: dict[str, Any], *, student_id: str | None = None,
               session: SessionStore | None = None) -> dict[str, Any]:
        self._cleanup()
        session = self.session if session is None else session
        request_id, cancel_token = validate_run_identifiers(payload)
        task_id = str(payload.get("taskId") or "")

        startup = check_startup(self.settings)
        bundle = load_course(self.settings)
        task = bundle.tasks.get(task_id)
        if task is None:
            raise ApiError("PROGRAM_SCHEMA_INVALID")
        task_enterable = task_id not in bundle.blocked
        learning_context = payload.get("learningContext") or {}
        key = learning_key(learning_context, bundle, task_id)
        decision = evaluate_run_gate(
            startup,
            task_id,
            task_enterable,
            session.has_prediction(task_id, bundle.content_version if key else None),
        )
        if not decision.allowed:
            raise ApiError(str(decision.code))

        target = payload.get("target") or {}
        if target.get("language") != "python" or target.get("version") != "3.12":
            raise ApiError("PYTHON_VERSION_MISMATCH")

        program = payload.get("program")
        try:
            validate_snapshot(program, bundle, task_id)
            if key and payload.get("courseRef") != program["courseRef"]:
                raise ProgramError("PROGRAM_SCHEMA_INVALID", "运行和积木的课程信息对不上。")
        except ProgramError as exc:
            raise ApiError(exc.code, exc.block_id, exc.message) from exc

        limits = self._clamp_limits(payload.get("limits"))
        digest = digest_program(program) if key else None
        prediction = None
        support = Support.UNKNOWN if (key or task.get("programCriteria") or task.get("executionCriteria")) else None
        hint_level = None
        if key:
            prediction = match_prediction(
                session.teaching.get_prediction(key, learning_context.get("predictionId")), digest,
            )
            ids = learning_context.get("seenHintIds")
            session.confirm_teaching_hints(key, task_id, ids)
            confirmed = session.teaching.confirmed_level(key)
            if confirmed:
                support = Support.ASSISTED
                hint_level = confirmed
            elif ids == [] and learning_context.get("workspaceSource") == "task":
                support = Support.NONE
                hint_level = 0

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
                session=session,
                student_id=student_id,
                task_snapshot=deepcopy(task),
                content_version=bundle.content_version,
                learning_key=key,
                program_digest=digest,
                prediction=prediction,
                support=support,
                hint_level=hint_level,
                debug=bool(payload.get("debug")),
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
                event = {key: frame.get(key) for key in ("seq", "blockId", "kind", "timestampMs")}
                if context.debug and "stage" in frame:
                    event["stage"] = frame["stage"]
                context.publish("event", event)
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
                **({"take_step": context.take_step} if context.debug else {}),
            )
            success, failures = evaluate_criteria(context.task_snapshot, result.get("objects", []))
            structure = None
            task = context.task_snapshot
            if context.learning_key or task.get("programCriteria") or task.get("executionCriteria"):
                roots = program_roots(program, runnable_only=True)
                structure = structure_facts(roots, task)
                if structure["structure_met"] is False:
                    failures.append("把前进和转弯按顺序放进同一个重复积木，每次转一个直角。")
                if task.get("executionCriteria") and result.get("status") == "completed":
                    missed = execution_failures(roots, task, result)
                    structure["structure_met"] = not missed and structure["structure_met"] is not False
                    failures.extend(missed)
            result["success"] = bool(success and not failures and result.get("status") == "completed")
            result["failures"] = failures
            result["memoryLimitMode"] = result.get("memoryLimitMode", "unavailable")
            self._complete(context, program, result, structure)
        except Exception as exc:  # noqa: BLE001 - 编排异常必须收敛为崩溃终态
            if context.result is None:
                self._complete(context, program, self._crash_result(context, started, type(exc).__name__))
            else:
                self._diagnose(context, "run_finalize_error", type(exc).__name__)
        finally:
            self._finalize_run(context, started)

    def _complete(self, context: RunContext, program: dict, result: dict, structure: dict | None = None) -> None:
        if context.learning_key or context.task_snapshot.get("programCriteria") or context.task_snapshot.get("executionCriteria"):
            try:
                learning = build_learning(
                    program=program, task=context.task_snapshot, run_result=result,
                    prediction=context.prediction, structure=structure,
                )
                if learning is not None:
                    if context.learning_key:
                        signatures = edit_signatures(program, structure) if structure and result["status"] == "completed" else {}
                        recent = context.session.teaching.recent_runs(context.learning_key, limit=1)
                        edit = described_edit(recent[0]["editSignatures"], signatures) if recent else None
                        context.session.teaching.put_run(context.learning_key, context.request_id, {
                            "learning": learning, "programDigest": context.program_digest,
                            "requestId": context.request_id, "status": result["status"],
                            "errorBlockId": (result.get("error") or {}).get("blockId"),
                            "editSignatures": signatures,
                        })
                        if edit:
                            context.session.add_evidence(
                                task_id=context.task_id, source_type="edit_trace", observed_fact=edit,
                                interpretation_text="观察到一次积木调整。", confidence=1.0,
                                alternatives=["还可以再用新的任务来观察"],
                                follow_up="比较两次运行结果。", request_id=context.request_id,
                                course_id=program["courseRef"]["courseId"],
                                knowledge_point_id=next(iter(context.task_snapshot.get("teaching", {}).get(
                                    "knowledgePointIds", [])), "kp.loop"),
                            )
                    result["learning"] = learning
            except Exception as exc:  # noqa: BLE001 - 教学附加数据不阻塞终态
                self._diagnose(context, "run_teaching_error", type(exc).__name__)
        self._record_outcome_safely(context, result, program["courseRef"]["courseId"])
        self._publish_terminal_once(context, result)

    def _publish_terminal_once(self, context: RunContext, result: dict[str, Any]) -> bool:
        with self._lock, context.condition:
            if context.result is not None:
                return False
            context.result = result
            if self._active_id == context.request_id:
                self._active_id = None
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
        self._log_finished_safely(context, started)
        context.finish()
        with self._lock:
            if self._active_id == context.request_id:
                self._active_id = None

    def _record_outcome_safely(self, context: RunContext, result: dict, course_id: str) -> None:
        try:
            self._record_outcome(context, result, course_id)
        except Exception as exc:  # noqa: BLE001 - 证据失败不得影响终态
            self._diagnose(context, "run_finalize_error", type(exc).__name__)

    def _record_outcome(self, context: RunContext, result: dict, course_id: str) -> None:
        status = str(result.get("status", "crashed"))
        outcome = OUTCOME_BY_STATUS.get(status, "crashed")
        if outcome == "succeeded" and not result.get("success"):
            outcome = "failed"
        task = context.task_snapshot
        task_id = context.task_id
        context.session.record_attempt(
            task_id, context.request_id, outcome, context.hint_level,
            support=context.support, content_version=context.content_version,
        )
        objects = result.get("objects") or []
        steps = next((item.get("steps") for item in objects if isinstance(item, dict) and item.get("id") == "stage"), None)
        if status != "completed":
            observed = f"本次运行未完成（{status}），没有产生成功结果"
            interpretation = "这次没有拿到完整结果，不能据此判断孩子是否理解"
            confidence = 1.0
        elif steps is None:
            observed = "这次没有读到舞台的步数。"
            interpretation = "可以重新运行后再观察。"
            confidence = 1.0
        elif outcome == "succeeded":
            observed = f"本次运行角色累计走了 {steps} 步，达到任务成功标准"
            interpretation = "孩子在这一次任务中达成了可见目标"
            confidence = 0.9
        else:
            observed = f"本次运行角色累计走了 {steps} 步，未达到任务成功标准"
            interpretation = "这一次的结果与任务目标不一致，可以用舞台和执行记录核对原因"
            confidence = 0.8
        source_type = "transfer_task" if task.get("type") == "variant" else "run_result"
        context.session.add_evidence(
            task_id=task_id,
            source_type=source_type,
            observed_fact=observed,
            interpretation_text=interpretation,
            confidence=confidence,
            alternatives=["操作还不熟练", "可能没看清任务目标", "可能只是这次数错了"],
            follow_up="核对目标和实际动作，调整一处后再预测和运行",
            request_id=context.request_id,
            course_id=course_id,
            knowledge_point_id=next(iter(task.get("teaching", {}).get("knowledgePointIds", [])), "kp.loop"),
        )
        if context.session.student_id and context.learning_key:
            learning = result.get("learning") or {}
            facts = learning.get("facts") or {}
            match = learning.get("predictionMatch", "none")
            prediction = facts.get("predictionValue")
            moves = facts.get("moves")
            context.session.observe(
                context.learning_key, task.get("teaching", {}).get("knowledgePointIds", []),
                "run", context.request_id, "run_result",
                {
                    "status": status,
                    "outcome": outcome,
                    "pattern": learning.get("pattern"),
                    "structureMet": learning.get("structureMet"),
                    "support": context.support,
                    "predictionMatch": match,
                    "predictionCorrect": prediction == moves if (
                        status == "completed" and match == "exact" and type(prediction) is int and type(moves) is int
                    ) else None,
                },
            )
            if not context.session.memory_available:
                result["memorySaved"] = False

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

    def snapshot(self, request_id: str, *, student_id: str | None = None) -> dict[str, Any] | None:
        with self._lock:
            context = self._runs.get(request_id)
            if context is None or context.student_id != student_id:
                return None
            result = context.result or {}
            finished = context.finished or context.result is not None
        if finished and not result:
            status = "crashed"
        else:
            status = str(result.get("status") or "running")
        return {
            "requestId": request_id,
            "finished": finished,
            "status": status,
            "errorCategory": (result.get("error") or {}).get("category"),
        }

    def stream(self, request_id: str, last_event_id: int = 0, *, student_id: str | None = None) -> Generator[str, None, None]:
        with self._lock:
            context = self._runs.get(request_id)
        if context is None or context.student_id != student_id:
            raise ApiError("RUN_NOT_FOUND")

        def generator() -> Generator[str, None, None]:
            index = 0
            with context.condition:
                context.stream_clients += 1
            try:
                while True:
                    with context.condition:
                        if index >= len(context.frames) and not context.finished:
                            context.condition.wait(timeout=STREAM_KEEP_ALIVE_S)
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
                    if finished:
                        break
                    if not frames:
                        yield ": keep-alive\n\n"
            finally:
                with context.condition:
                    context.stream_clients -= 1
                    if context.debug and not context.stream_clients and context.result is None:
                        context.cancel_event.set()

        return generator()

    def _controlled_run(self, request_id: str, cancel_token: str, student_id: str | None) -> RunContext:
        validate_request_id(request_id)
        with self._lock:
            context = self._runs.get(request_id)
        if context is None or context.student_id != student_id:
            raise ApiError("RUN_NOT_FOUND")
        if context.cancel_token != cancel_token:
            raise ApiError("CANCEL_TOKEN_MISMATCH")
        return context

    def step(self, request_id: str, cancel_token: str, seq: int, *, student_id: str | None = None) -> dict[str, Any]:
        context = self._controlled_run(request_id, cancel_token, student_id)
        with context.condition:
            if context.result is not None or context.cancel_event.is_set() or context.waiting_step != seq:
                return {"accepted": False}
            context.waiting_step = None
            context.pending_step = seq
            return {"accepted": True}

    def cancel(self, request_id: str, cancel_token: str, *, student_id: str | None = None) -> dict[str, Any]:
        context = self._controlled_run(request_id, cancel_token, student_id)
        if context.finished or context.result is not None:
            return {"requestId": request_id, "status": "already_finished"}
        context.cancel_event.set()
        return {"requestId": request_id, "status": "cancelling"}

    def new_request_id(self) -> tuple[str, str]:
        return (f"run-{uuid.uuid4().hex[:12]}", uuid.uuid4().hex)
