"""运行 worker：单次运行一个短生命周期 Python 3.12 子进程。

启动先输出 ready 帧；stdin 读单条 run 指令；stdout 只输出 JSONL 帧；
用户 print 经受控函数接管为 stdout 帧，绝不污染事件通道。
"""

from __future__ import annotations

import json
import os
import queue
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any

BASE_DIR = Path(__file__).resolve().parents[2]
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from backend.domain.blocks import load_blocks  # noqa: E402
from backend.domain.program import ProgramError, validate_program  # noqa: E402
from backend.infra.errors import error_object  # noqa: E402
from backend.runner.compiler import TARGET_FILENAME, CompilationError, compile_program  # noqa: E402
from backend.runner.policy import check_module  # noqa: E402
from backend.runner.protocol import MAX_EVENTS, PROTOCOL_VERSION, validate_run_frame  # noqa: E402
from backend.runner.runtime_api import OutputBuffer, Stage, make_globals  # noqa: E402

DEFAULT_LIMITS = {
    "wallTimeMs": 3000,
    "memoryMb": 128,
    "maxOutputBytes": 16384,
    "maxRecursionDepth": 200,
}


class _Cancelled(Exception):
    pass


class _StepLimit(Exception):
    pass


def send(frame: dict[str, Any]) -> None:
    try:
        sys.stdout.write(json.dumps(frame, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    except (BrokenPipeError, OSError):
        pass


class LineTracer:
    def __init__(
        self, line_map: dict[int, str], cancel_event: threading.Event,
        stage: Stage, steps: queue.Queue[int] | None,
    ) -> None:
        self.line_map = line_map
        self.cancel_event = cancel_event
        self.stage = stage
        self.steps = steps
        self.paused_seconds = 0.0
        self.started = time.perf_counter()
        self.seq = 0
        self.events: list[dict[str, Any]] = []
        self.last_block: str | None = None
        self._cleanup = lambda: None  # noqa: E731

    def _emit(self, kind: str, block_id: str) -> None:
        if len(self.events) >= MAX_EVENTS:
            return
        self.seq += 1
        event = {
            "seq": self.seq,
            "blockId": block_id,
            "kind": kind,
            "timestampMs": int((time.perf_counter() - self.started) * 1000),
        }
        self.events.append(event)
        frame = {"type": "event", **event}
        if self.steps is not None and kind == "block_exit":
            frame["stage"] = self.stage.snapshot()
        send(frame)

    def on_line(self, filename: str, line_number: int) -> None:
        if filename != TARGET_FILENAME:
            return
        if self.cancel_event.is_set():
            raise _Cancelled()
        block_id = self.line_map.get(line_number)
        if not block_id or (self.steps is None and block_id == self.last_block):
            return
        if self.last_block:
            self._emit("block_exit", self.last_block)
            self.last_block = None
        if self.steps is not None and len(self.events) >= MAX_EVENTS - 1:
            raise _StepLimit()
        self._emit("block_enter", block_id)
        if self.steps is not None:
            self._wait_for_step(self.steps)
        self.last_block = block_id

    def _wait_for_step(self, steps: queue.Queue[int]) -> None:
        started = time.perf_counter()
        try:
            while not self.cancel_event.is_set():
                try:
                    seq = steps.get(timeout=0.05)
                except queue.Empty:
                    continue
                if seq == self.seq and not self.cancel_event.is_set():
                    return
            raise _Cancelled()
        finally:
            self.paused_seconds += time.perf_counter() - started

    def install(self) -> None:
        if self.steps is not None:
            self._install_settrace()
            return
        try:
            self._install_monitoring()
        except Exception:
            self._install_settrace()

    def _install_monitoring(self) -> None:
        monitoring = sys.monitoring
        tool_id = 3
        monitoring.use_tool_id(tool_id, "codematekids")
        monitoring.register_callback(tool_id, monitoring.events.LINE, self._on_monitor_line)
        monitoring.set_events(tool_id, monitoring.events.LINE)

        def cleanup() -> None:
            monitoring.set_events(tool_id, monitoring.events.NO_EVENTS)
            monitoring.free_tool_id(tool_id)

        self._cleanup = cleanup

    def _on_monitor_line(self, code: Any, line_number: int) -> None:
        self.on_line(code.co_filename, line_number)

    def _install_settrace(self) -> None:
        def local_trace(frame: Any, event: str, arg: Any) -> Any:
            if event == "line":
                self.on_line(frame.f_code.co_filename, frame.f_lineno)
            return local_trace

        def global_trace(frame: Any, event: str, arg: Any) -> Any:
            if frame.f_code.co_filename == TARGET_FILENAME:
                return local_trace
            return None

        sys.settrace(global_trace)

        def cleanup() -> None:
            sys.settrace(None)

        self._cleanup = cleanup

    def uninstall(self) -> None:
        try:
            self._cleanup()
        except Exception:
            pass
        if self.last_block:
            self._emit("block_exit", self.last_block)
            self.last_block = None


def _result(
    request_id: str,
    status: str,
    stdout: str,
    truncated: bool,
    duration_ms: int,
    objects: list[dict[str, Any]],
    events: list[dict[str, Any]],
    error: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "type": "result",
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id,
        "status": status,
        "stdout": stdout,
        "stderr": "",
        "error": error,
        "events": events,
        "durationMs": max(0, duration_ms),
        "truncated": truncated,
        "objects": objects,
    }


def _error_block(exc: BaseException, line_map: dict[int, str]) -> str | None:
    tb = exc.__traceback__
    block_id: str | None = None
    while tb is not None:
        if tb.tb_frame.f_code.co_filename == TARGET_FILENAME:
            block_id = line_map.get(int(tb.tb_lineno)) or block_id
        tb = tb.tb_next
    return block_id


def execute(
    frame: dict[str, Any], cancel_event: threading.Event, steps: queue.Queue[int] | None = None,
) -> dict[str, Any]:
    request_id = str(frame.get("requestId", ""))
    limits = dict(DEFAULT_LIMITS)
    limits.update(frame.get("limits") or {})
    started = time.perf_counter()
    registry = load_blocks()
    program = frame.get("program")

    try:
        validate_program(program, registry)
    except ProgramError as exc:
        return _result(
            request_id,
            "failed",
            "",
            False,
            int((time.perf_counter() - started) * 1000),
            [],
            [],
            error_object(exc.code, exc.block_id, exc.message),
        )

    try:
        compiled = compile_program(program, registry)
    except CompilationError as exc:
        return _result(
            request_id,
            "failed",
            "",
            False,
            int((time.perf_counter() - started) * 1000),
            [],
            [],
            error_object("PYTHON_COMPILE_ERROR", exc.block_id, exc.message),
        )

    violations = check_module(compiled.module, compiled.line_map)
    if violations:
        first = violations[0]
        return _result(
            request_id,
            "failed",
            "",
            False,
            int((time.perf_counter() - started) * 1000),
            [],
            [],
            error_object("PYTHON_FEATURE_BLOCKED", first.block_id),
        )

    try:
        code = compile(compiled.module, TARGET_FILENAME, "exec")
    except SyntaxError:
        return _result(
            request_id,
            "failed",
            "",
            False,
            int((time.perf_counter() - started) * 1000),
            [],
            [],
            error_object("PYTHON_COMPILE_ERROR", None),
        )

    buffer = OutputBuffer(int(limits["maxOutputBytes"]))
    stage = Stage()
    # 调试只在积木的首行停下，空循环生成的占位 pass 不单独执行一步。
    line_map = compiled.line_map if steps is None else {
        begin: block_id for block_id, (begin, _) in compiled.block_lines.items()
    }
    tracer = LineTracer(line_map, cancel_event, stage, steps)
    stdout_seq = {"value": 0}

    def printer(*args: Any, sep: str = " ", end: str = "\n", **kwargs: Any) -> None:
        text = sep.join(str(item) for item in args) + end
        accepted = buffer.append(text)
        if accepted:
            stdout_seq["value"] += 1
            send(
                {
                    "type": "stdout",
                    "seq": stdout_seq["value"],
                    "text": accepted,
                    "timestampMs": int((time.perf_counter() - started) * 1000),
                }
            )

    globals_map = make_globals(stage, printer)
    status = "completed"
    error_code: str | None = None
    error_message: str | None = None
    block_id: str | None = None
    original_recursion_limit = sys.getrecursionlimit()
    sys.setrecursionlimit(max(50, int(limits["maxRecursionDepth"]) + 20))

    tracer.install()
    try:
        exec(code, globals_map)  # noqa: S102 - 目标程序由结构化模型生成
    except _Cancelled:
        status = "cancelled"
        error_code = "RUN_CANCELLED"
    except _StepLimit:
        status = "resource_exceeded"
        error_code = "RUN_RESOURCE_LIMIT"
        error_message = "这次调试的积木步数太多啦。"
    except RecursionError:
        status = "resource_exceeded"
        error_code = "RUN_RESOURCE_LIMIT"
    except MemoryError:
        status = "resource_exceeded"
        error_code = "RUN_RESOURCE_LIMIT"
    except Exception as exc:  # noqa: BLE001 - 运行时错误需分类映射
        status = "failed"
        error_code = "PYTHON_RUNTIME_ERROR"
        block_id = _error_block(exc, compiled.line_map)
        if os.environ.get("CMK_WORKER_DEBUG") == "1":
            traceback.print_exc(file=sys.stderr)
    finally:
        tracer.uninstall()
        sys.setrecursionlimit(original_recursion_limit)

    duration_ms = int((time.perf_counter() - started - tracer.paused_seconds) * 1000)
    return _result(
        request_id,
        status,
        buffer.value(),
        buffer.truncated,
        duration_ms,
        [stage.snapshot()],
        tracer.events,
        error_object(error_code, block_id, error_message) if error_code else None,
    )


def watch_commands(cancel_event: threading.Event, steps: queue.Queue[int] | None) -> None:
    for line in sys.stdin:
        stripped = line.strip()
        if not stripped:
            continue
        try:
            frame = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        if frame.get("type") == "cancel":
            cancel_event.set()
        elif steps is not None and frame.get("type") == "step":
            steps.put(frame["seq"])
    if steps is not None:
        cancel_event.set()


def main() -> int:
    send(
        {
            "type": "ready",
            "protocolVersion": PROTOCOL_VERSION,
            "python": {
                "major": sys.version_info.major,
                "minor": sys.version_info.minor,
                "patch": sys.version_info.micro,
            },
        }
    )
    first = sys.stdin.readline()
    if not first.strip():
        return 0
    try:
        frame = json.loads(first)
    except json.JSONDecodeError:
        return 1
    if frame.get("type") == "probe":
        return 0
    if frame.get("type") != "run":
        return 1
    if (sys.version_info.major, sys.version_info.minor) != (3, 12):
        send(
            _result(
                str(frame.get("requestId", "")),
                "failed",
                "",
                False,
                0,
                [],
                [],
                error_object("PYTHON_VERSION_MISMATCH"),
            )
        )
        return 0
    try:
        validate_run_frame(frame)
    except ValueError:
        send(
            _result(
                str(frame.get("requestId", "")),
                "failed",
                "",
                False,
                0,
                [],
                [],
                error_object("PROGRAM_SCHEMA_INVALID"),
            )
        )
        return 0

    cancel_event = threading.Event()
    steps = queue.Queue() if frame.get("debug") else None
    reader = threading.Thread(target=watch_commands, args=(cancel_event, steps), daemon=True)
    reader.start()
    result = execute(frame, cancel_event, steps)
    send(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
