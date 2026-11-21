"""子进程监督：可打断握手、双流消费、超时强杀、取消两段式与内存上限。"""

from __future__ import annotations

import ctypes
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable

from backend.infra.config import BASE_DIR
from backend.infra.errors import error_object
from backend.runner.protocol import PROTOCOL_VERSION, validate_result_frame
from backend.runner.stream_reader import FrameReader, StderrDigest

WORKER_PATH = BASE_DIR / "backend" / "runner" / "worker.py"
MIN_ENV_KEYS = ("PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "COMSPEC", "PATHEXT")
POLL_INTERVAL_S = 0.02
CANCEL_GRACE_S = 0.2
MEMORY_POLL_INTERVAL_S = 0.1
HANDSHAKE_TIMEOUT_S = 2.0


class SupervisorError(RuntimeError):
    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)


def minimal_env() -> dict[str, str]:
    env: dict[str, str] = {}
    for key in MIN_ENV_KEYS:
        value = os.environ.get(key)
        if value:
            env[key] = value
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return env


def _kill_tree(pid: int) -> None:
    if sys.platform == "win32":
        try:
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                capture_output=True,
                text=True,
                timeout=3,
            )
        except (OSError, subprocess.SubprocessError):
            pass
    else:
        try:
            os.kill(pid, 9)
        except OSError:
            pass


def _fast_kill(process: subprocess.Popen) -> None:
    try:
        process.kill()
    except (OSError, ProcessLookupError):
        pass
    deadline = time.perf_counter() + 0.25
    while process.poll() is None and time.perf_counter() < deadline:
        time.sleep(0.01)
    if process.poll() is None:
        _kill_tree(process.pid)


def _process_rss_mb(pid: int) -> float | None:
    if sys.platform != "win32":
        return None
    try:
        kernel32 = ctypes.windll.kernel32
        psapi = ctypes.windll.psapi

        class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
            _fields_ = [
                ("cb", ctypes.c_ulong),
                ("PageFaultCount", ctypes.c_ulong),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t),
            ]

        handle = kernel32.OpenProcess(0x0400 | 0x0010, False, int(pid))
        if not handle:
            return None
        try:
            counters = PROCESS_MEMORY_COUNTERS()
            counters.cb = ctypes.sizeof(PROCESS_MEMORY_COUNTERS)
            if not psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
                return None
            return float(counters.WorkingSetSize) / (1024 * 1024)
        finally:
            kernel32.CloseHandle(handle)
    except Exception:
        return None


def _apply_job_memory_limit(process: subprocess.Popen, memory_mb: int) -> Any:
    if sys.platform != "win32":
        return None
    try:
        kernel32 = ctypes.windll.kernel32

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [
                ("ReadOperationCount", ctypes.c_ulonglong),
                ("WriteOperationCount", ctypes.c_ulonglong),
                ("OtherOperationCount", ctypes.c_ulonglong),
                ("ReadTransferCount", ctypes.c_ulonglong),
                ("WriteTransferCount", ctypes.c_ulonglong),
                ("OtherTransferCount", ctypes.c_ulonglong),
            ]

        class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_longlong),
                ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", ctypes.c_ulong),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", ctypes.c_ulong),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", ctypes.c_ulong),
                ("SchedulingClass", ctypes.c_ulong),
            ]

        class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
                ("IoInfo", IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            return None
        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = 0x00000100
        info.ProcessMemoryLimit = int(memory_mb) * 1024 * 1024
        extended_info_class = 9
        if not kernel32.SetInformationJobObject(
            job, extended_info_class, ctypes.byref(info), ctypes.sizeof(info)
        ):
            kernel32.CloseHandle(job)
            return None
        if not kernel32.AssignProcessToJobObject(job, int(process._handle)):  # noqa: SLF001
            kernel32.CloseHandle(job)
            return None
        return job
    except Exception:
        return None


def _close_job(job: Any) -> None:
    if job is None:
        return
    try:
        ctypes.windll.kernel32.CloseHandle(job)
    except Exception:
        pass


def _start_frame_reader(stream: Any) -> FrameReader:
    reader = FrameReader(stream)
    reader.start()
    return reader


def _handshake(
    reader: FrameReader,
    process: subprocess.Popen,
    deadline: float,
    cancel_event: threading.Event,
) -> None:
    while True:
        if cancel_event.is_set():
            raise SupervisorError("handshake_cancelled")
        remaining = deadline - time.perf_counter()
        if remaining <= 0:
            raise SupervisorError("handshake_timeout")
        frame = reader.next_frame(min(0.1, remaining))
        if frame is None:
            if process.poll() is not None:
                raise SupervisorError("handshake_exited")
            continue
        frame_type = frame.get("type")
        if frame_type == "ready":
            return
        if frame_type == "_eof":
            raise SupervisorError("handshake_exited")
        raise SupervisorError("handshake_invalid")


def run_program(
    program: dict[str, Any],
    limits: dict[str, Any],
    request_id: str,
    cancel_event: threading.Event,
    on_frame: Callable[[dict[str, Any]], None],
    log_event: Callable[[str, dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    work_dir = tempfile.mkdtemp(prefix="cmk-run-")
    started = time.perf_counter()
    process: subprocess.Popen | None = None
    reader: FrameReader | None = None
    stderr_digest: StderrDigest | None = None
    job_handle: Any = None
    memory_mode = "unavailable"
    result_frame: dict[str, Any] | None = None
    collected_events: list[dict[str, Any]] = []
    collected_stdout: list[str] = []
    output_bytes = 0
    max_output = int(limits.get("maxOutputBytes", 16384))
    truncated = False
    status = "completed"
    error_code: dict[str, str | None] = {"value": None}
    forced_kill = False
    handshake_reason = ""

    try:
        if cancel_event.is_set():
            handshake_reason = "handshake_cancelled"
            raise SupervisorError(handshake_reason)
        creationflags = 0
        if sys.platform == "win32":
            creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        process = subprocess.Popen(
            [sys.executable, str(WORKER_PATH)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            cwd=work_dir,
            env=minimal_env(),
            creationflags=creationflags,
        )
        assert process.stdout is not None
        reader = _start_frame_reader(process.stdout)
        stderr_digest = StderrDigest(process.stderr)
        stderr_digest.start()

        try:
            _handshake(reader, process, started + HANDSHAKE_TIMEOUT_S, cancel_event)
        except SupervisorError as exc:
            handshake_reason = exc.reason
            raise

        job_handle = _apply_job_memory_limit(process, int(limits.get("memoryMb", 128)))
        memory_mode = "job_object" if job_handle is not None else "polling"

        run_frame = {
            "type": "run",
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": request_id,
            "target": {"language": "python", "version": "3.12"},
            "program": program,
            "limits": {
                "wallTimeMs": int(limits.get("wallTimeMs", 3000)),
                "memoryMb": int(limits.get("memoryMb", 128)),
                "maxOutputBytes": max_output,
                "maxRecursionDepth": int(limits.get("maxRecursionDepth", 200)),
            },
            "mode": "demo",
        }
        assert process.stdin is not None
        process.stdin.write(json.dumps(run_frame, ensure_ascii=False) + "\n")
        process.stdin.flush()

        deadline = started + (int(limits.get("wallTimeMs", 3000)) + 450) / 1000.0
        cancel_deadline: float | None = None
        last_memory_check = 0.0

        while True:
            frame = reader.next_frame(POLL_INTERVAL_S)
            if frame is not None:
                frame_type = frame.get("type")
                if frame_type == "event":
                    collected_events.append(frame)
                    on_frame(frame)
                elif frame_type == "stdout":
                    text = str(frame.get("text", ""))
                    output_bytes += len(text.encode("utf-8"))
                    if output_bytes > max_output:
                        truncated = True
                    collected_stdout.append(text)
                    on_frame(frame)
                elif frame_type == "result":
                    result_frame = frame
                elif frame_type == "_eof":
                    pass
                elif frame_type == "_invalid_json":
                    pass

            if result_frame is not None:
                break

            now = time.perf_counter()
            if now >= deadline:
                status = "timeout"
                error_code["value"] = "RUN_TIMEOUT"
                forced_kill = True
                _fast_kill(process)
                break

            if cancel_event.is_set():
                if cancel_deadline is None:
                    try:
                        assert process.stdin is not None
                        process.stdin.write('{"type":"cancel"}\n')
                        process.stdin.flush()
                    except (OSError, ValueError):
                        pass
                    cancel_deadline = now + CANCEL_GRACE_S
                elif now >= cancel_deadline or process.poll() is not None:
                    status = "cancelled"
                    error_code["value"] = "RUN_CANCELLED"
                    forced_kill = True
                    _fast_kill(process)
                    break

            if now - last_memory_check >= MEMORY_POLL_INTERVAL_S:
                last_memory_check = now
                rss = _process_rss_mb(process.pid)
                if rss is not None and rss > int(limits.get("memoryMb", 128)):
                    status = "resource_exceeded"
                    error_code["value"] = "RUN_RESOURCE_LIMIT"
                    forced_kill = True
                    _fast_kill(process)
                    break

            if process.poll() is not None:
                time.sleep(0.05)
                while True:
                    trailing = reader.next_frame(0.0)
                    if trailing is None:
                        break
                    if trailing.get("type") == "result":
                        result_frame = trailing
                    elif trailing.get("type") == "event":
                        collected_events.append(trailing)
                        on_frame(trailing)
                    elif trailing.get("type") == "stdout":
                        collected_stdout.append(str(trailing.get("text", "")))
                        on_frame(trailing)
                if result_frame is None:
                    status = "crashed"
                    error_code["value"] = "RUNNER_CRASHED"
                break

        if result_frame is not None:
            try:
                validate_result_frame(result_frame, request_id)
                status = str(result_frame.get("status", "completed"))
                truncated = bool(result_frame.get("truncated", truncated))
                if status == "failed":
                    error = result_frame.get("error") or {}
                    error_code["value"] = str(error.get("code") or "PYTHON_RUNTIME_ERROR")
                elif status in ("timeout", "resource_exceeded", "cancelled", "crashed"):
                    error_code["value"] = {
                        "timeout": "RUN_TIMEOUT",
                        "resource_exceeded": "RUN_RESOURCE_LIMIT",
                        "cancelled": "RUN_CANCELLED",
                        "crashed": "RUNNER_CRASHED",
                    }[status]
                else:
                    error_code["value"] = None
            except ValueError:
                status = "crashed"
                error_code["value"] = "RUNNER_CRASHED"
                result_frame = None

        duration_ms = int((time.perf_counter() - started) * 1000)
        result = {
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": request_id,
            "status": status,
            "stdout": "".join(collected_stdout),
            "stderr": "",
            "error": None,
            "events": collected_events,
            "durationMs": duration_ms,
            "truncated": truncated,
            "objects": [],
            "memoryLimitMode": memory_mode,
        }
        if result_frame is not None:
            result["objects"] = result_frame.get("objects", [])
            result["stdout"] = result_frame.get("stdout", result["stdout"])[:max_output]
            result["events"] = result_frame.get("events", collected_events)
            result["durationMs"] = int(result_frame.get("durationMs", duration_ms))
            result["error"] = result_frame.get("error")
        elif status == "completed":
            status = "crashed"
            error_code["value"] = "RUNNER_CRASHED"

        result["status"] = status
        if result.get("error") is None and error_code["value"]:
            block_id = collected_events[-1].get("blockId") if collected_events else None
            result["error"] = error_object(str(error_code["value"]), block_id)
        if log_event is not None:
            summary = stderr_digest.summary() if stderr_digest is not None else ""
            log_event(
                "run_diagnostics",
                {
                    "status": status,
                    "durationMs": duration_ms,
                    "forcedKill": forced_kill,
                    "memoryLimitMode": memory_mode,
                    "handshakeReason": handshake_reason,
                    "stderrSummary": summary,
                },
            )
        return result

    except SupervisorError:
        cancelled = handshake_reason == "handshake_cancelled"
        status = "cancelled" if cancelled else "crashed"
        if log_event is not None:
            summary = stderr_digest.summary() if stderr_digest is not None else ""
            log_event(
                "run_diagnostics",
                {
                    "status": status,
                    "handshakeReason": handshake_reason,
                    "stderrSummary": summary,
                },
            )
        return {
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": request_id,
            "status": status,
            "stdout": "".join(collected_stdout),
            "stderr": "",
            "error": error_object("RUN_CANCELLED" if cancelled else "RUNNER_CRASHED"),
            "events": collected_events,
            "durationMs": int((time.perf_counter() - started) * 1000),
            "truncated": truncated,
            "objects": [],
            "memoryLimitMode": memory_mode,
        }
    finally:
        if process is not None:
            try:
                if process.stdin is not None:
                    process.stdin.close()
            except (OSError, ValueError):
                pass
            try:
                if process.poll() is None:
                    _fast_kill(process)
            except Exception:
                pass
        if reader is not None:
            reader.close()
        if stderr_digest is not None:
            stderr_digest.close()
        if process is not None:
            for stream in (process.stdout, process.stderr):
                try:
                    if stream is not None:
                        stream.close()
                except (OSError, ValueError):
                    pass
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
        _close_job(job_handle)
        try:
            for entry in Path(work_dir).iterdir():
                if entry.is_file():
                    entry.unlink(missing_ok=True)
            Path(work_dir).rmdir()
        except OSError:
            pass
