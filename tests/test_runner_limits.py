"""受限运行：超时、输出截断、取消、崩溃恢复、环境隔离与可复现。"""

from __future__ import annotations

import threading
import time

from backend.runner import supervisor as supervisor_mod
from backend.runner import worker as worker_mod
from backend.runner.compiler import CompiledProgram, TARGET_FILENAME
from backend.runner.supervisor import minimal_env, run_program

LIMITS = {"wallTimeMs": 1500, "memoryMb": 128, "maxOutputBytes": 16384, "maxRecursionDepth": 200}


def node(block_id: str, kind: str, inputs: dict, body=None, nxt=None) -> dict:
    return {"blockId": block_id, "kind": kind, "inputs": inputs, "body": body or [], "next": nxt}


def program(root: dict) -> dict:
    return {
        "format": "codematekids.program",
        "formatVersion": 1,
        "target": {"language": "python", "version": "3.12"},
        "courseRef": {"courseId": "demo-loop", "version": 1, "taskId": "main"},
        "root": root,
        "metadata": {"createdAt": "2026-11-14T00:00:00Z", "updatedAt": "2026-11-14T00:00:00Z"},
    }


def simple_program() -> dict:
    return program(
        node(
            "b-start",
            "event.start",
            {},
            nxt=node(
                "b-repeat",
                "control.repeat",
                {"times": 2},
                body=[node("b-move", "motion.move", {"steps": 1})],
            ),
        )
    )


def slow_program() -> dict:
    inner = node("b-move", "motion.move", {"steps": 1})
    current = inner
    for depth in range(5):
        current = node(f"b-slow-{depth}", "control.repeat", {"times": 100}, body=[current])
    return program(node("b-start", "event.start", {}, nxt=current))


def loud_program() -> dict:
    return program(
        node(
            "b-start",
            "event.start",
            {},
            nxt=node(
                "b-repeat",
                "control.repeat",
                {"times": 100},
                body=[node("b-print", "text.print", {"value": node("b-number", "value.number", {"value": 1})})],
            ),
        )
    )


def _run(program_payload, limits=None, cancel_event=None):
    return run_program(
        program_payload,
        dict(limits or LIMITS),
        f"run-{time.time_ns()}",
        cancel_event or threading.Event(),
        lambda frame: None,
    )


def test_timeout_kills_and_returns_quickly() -> None:
    started = time.perf_counter()
    result = _run(slow_program(), {**LIMITS, "wallTimeMs": 1500})
    elapsed = time.perf_counter() - started
    assert result["status"] == "timeout"
    assert result["error"]["code"] == "RUN_TIMEOUT"
    assert elapsed <= 3.0


def test_output_truncation() -> None:
    result = _run(loud_program(), {**LIMITS, "maxOutputBytes": 64})
    assert result["status"] == "completed"
    assert result["truncated"] is True
    assert len(result["stdout"].encode("utf-8")) <= 64


def test_cancel_then_rerun_immediately() -> None:
    cancel_event = threading.Event()
    box = {}

    def worker() -> None:
        box["result"] = _run(slow_program(), {**LIMITS, "wallTimeMs": 5000}, cancel_event)

    thread = threading.Thread(target=worker)
    thread.start()
    time.sleep(0.15)
    cancel_event.set()
    thread.join(timeout=4)
    assert box["result"]["status"] == "cancelled"
    assert box["result"]["error"]["code"] == "RUN_CANCELLED"

    again = _run(simple_program())
    assert again["status"] == "completed"


class _EofReader:
    def __init__(self) -> None:
        self.done = False

    def next_frame(self, timeout):
        if not self.done:
            self.done = True
            return {"type": "_eof"}
        return None

    def close(self) -> None:
        return None


def test_crash_then_recover(monkeypatch) -> None:
    monkeypatch.setattr(supervisor_mod, "_start_frame_reader", lambda stream: _EofReader())
    crashed = _run(simple_program())
    assert crashed["status"] == "crashed"
    assert crashed["error"]["code"] == "RUNNER_CRASHED"

    monkeypatch.undo()
    recovered = _run(simple_program())
    assert recovered["status"] == "completed"


def test_worker_env_excludes_model_key(monkeypatch) -> None:
    monkeypatch.setenv("CMK_MODEL_KEY", "top-secret")
    env = minimal_env()
    assert "CMK_MODEL_KEY" not in env
    assert not any(key.startswith("CMK_") for key in env)


def test_same_program_is_deterministic() -> None:
    first = _run(simple_program())
    second = _run(simple_program())
    assert first["status"] == second["status"] == "completed"
    assert first["objects"] == second["objects"]
    signature = [(event["kind"], event["blockId"]) for event in first["events"]]
    again = [(event["kind"], event["blockId"]) for event in second["events"]]
    assert signature == again


def test_recursion_limit_maps_to_resource(monkeypatch) -> None:
    source = "def deep(n):\n    return deep(n + 1)\ndeep(0)\n"
    fake = CompiledProgram(
        source=source,
        module=__import__("ast").parse(source, filename=TARGET_FILENAME),
        line_map={1: "b-rec"},
        block_lines={"b-rec": (1, 2)},
    )
    monkeypatch.setattr(worker_mod, "compile_program", lambda program, registry=None: fake)
    monkeypatch.setattr(worker_mod, "check_module", lambda module, line_map=None: [])
    frame = {
        "type": "run",
        "protocolVersion": 1,
        "requestId": "run-recursion",
        "program": simple_program(),
        "limits": {**LIMITS, "maxRecursionDepth": 50},
        "target": {"language": "python", "version": "3.12"},
    }
    result = worker_mod.execute(frame, threading.Event())
    assert result["status"] == "resource_exceeded"
    assert result["error"]["code"] == "RUN_RESOURCE_LIMIT"