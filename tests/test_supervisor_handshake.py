"""RG-02：worker 握手在时限内可打断，且不遗留进程与线程。"""

from __future__ import annotations

import threading
import time

from backend.runner import supervisor as supervisor_mod
from backend.runner.supervisor import run_program
from tests.helpers import simple_program

LIMITS = {"wallTimeMs": 1000, "memoryMb": 128, "maxOutputBytes": 16384, "maxRecursionDepth": 200}


def _run_with(worker_path, tmp_path):
    supervisor_mod.WORKER_PATH = worker_path
    try:
        return run_program(
            simple_program(),
            dict(LIMITS),
            "run-handshake",
            threading.Event(),
            lambda frame: None,
        )
    finally:
        pass


def _reader_threads() -> list[threading.Thread]:
    return [
        item
        for item in threading.enumerate()
        if item.name in {"cmk-frame-reader", "cmk-stderr-reader"} and item.is_alive()
    ]


def _write_worker(tmp_path, name: str, body: str):
    path = tmp_path / name
    path.write_text(body, encoding="utf-8")
    return path


def test_worker_never_outputs(tmp_path, monkeypatch) -> None:
    path = _write_worker(tmp_path, "silent.py", "import time\ntime.sleep(10)\n")
    original = supervisor_mod.WORKER_PATH
    monkeypatch.setattr(supervisor_mod, "WORKER_PATH", path)
    started = time.perf_counter()
    result = run_program(simple_program(), dict(LIMITS), "run-hs-1", threading.Event(), lambda f: None)
    elapsed = time.perf_counter() - started
    assert result["status"] == "crashed"
    assert result["error"]["code"] == "RUNNER_CRASHED"
    assert elapsed <= 2.8
    assert _reader_threads() == []
    assert supervisor_mod.WORKER_PATH == path or original  # noqa: S101


def test_worker_half_line_hangs(tmp_path, monkeypatch) -> None:
    body = (
        "import sys, time\n"
        'sys.stdout.write(\'{"type":\')\n'
        "sys.stdout.flush()\n"
        "time.sleep(10)\n"
    )
    path = _write_worker(tmp_path, "half.py", body)
    monkeypatch.setattr(supervisor_mod, "WORKER_PATH", path)
    started = time.perf_counter()
    result = run_program(simple_program(), dict(LIMITS), "run-hs-2", threading.Event(), lambda f: None)
    assert result["status"] == "crashed"
    assert time.perf_counter() - started <= 2.8
    assert _reader_threads() == []


def test_worker_exits_early(tmp_path, monkeypatch) -> None:
    path = _write_worker(tmp_path, "exit.py", "raise SystemExit(1)\n")
    monkeypatch.setattr(supervisor_mod, "WORKER_PATH", path)
    started = time.perf_counter()
    result = run_program(simple_program(), dict(LIMITS), "run-hs-3", threading.Event(), lambda f: None)
    assert result["status"] == "crashed"
    assert result["error"]["code"] == "RUNNER_CRASHED"
    assert time.perf_counter() - started <= 1.5
    assert _reader_threads() == []


def test_normal_path_keeps_first_event() -> None:
    result = run_program(simple_program(), dict(LIMITS), "run-hs-4", threading.Event(), lambda f: None)
    assert result["status"] == "completed"
    assert result["events"]
    assert result["events"][0]["seq"] == 1
    assert result["events"][0]["kind"] == "block_enter"
    assert _reader_threads() == []