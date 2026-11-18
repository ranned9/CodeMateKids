"""RG-09：worker 标准错误被持续消费、摘要受限脱敏、前端不可见。"""

from __future__ import annotations

import threading
import time

from backend.runner import supervisor as supervisor_mod
from backend.runner.supervisor import run_program
from tests.helpers import simple_program

LIMITS = {"wallTimeMs": 500, "memoryMb": 128, "maxOutputBytes": 16384, "maxRecursionDepth": 200}


def test_large_stderr_is_drained_and_sanitized(tmp_path, monkeypatch) -> None:
    script = tmp_path / "noisy.py"
    script.write_text(
        "import json, sys, time\n"
        'sys.stdout.write(json.dumps({"type":"ready","python":{"major":3,"minor":12,"patch":9}})+"\\n")\n'
        "sys.stdout.flush()\n"
        "sys.stdin.readline()\n"
        "for index in range(20000):\n"
        '    sys.stderr.write("Traceback C:\\\\tmp\\\\secret.py CMK_MODEL_KEY=very-secret 0123456789abcdef0123456789abcdef\\n")\n'
        "sys.stderr.flush()\n"
        "time.sleep(6)\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(supervisor_mod, "WORKER_PATH", script)
    diagnostics: list[tuple[str, dict]] = []
    started = time.perf_counter()
    result = run_program(
        simple_program(),
        dict(LIMITS),
        "run-stderr-1",
        threading.Event(),
        lambda frame: None,
        lambda event, payload: diagnostics.append((event, payload)),
    )
    elapsed = time.perf_counter() - started
    assert result["status"] == "timeout"
    assert elapsed <= 4.0
    assert result["stderr"] == ""
    summaries = [payload.get("stderrSummary", "") for event, payload in diagnostics if payload.get("stderrSummary")]
    assert summaries
    summary = summaries[0]
    assert len(summary) <= 160
    assert "C:\\" not in summary
    assert "CMK_MODEL_KEY" not in summary
    assert "very-secret" not in summary
    assert "secret.py" not in summary