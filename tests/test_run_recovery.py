"""RG-01：运行终态唯一、异常收尾与运行槽必然释放。"""

from __future__ import annotations

import pytest

from backend.infra.errors import ApiError
from backend.service import run as run_mod
from tests.helpers import drain, simple_program, submit


def _prepare(client) -> None:
    client.post("/api/v1/session/prediction", json={"taskId": "main", "value": 2})


def test_run_program_exception_still_publishes_one_crash(client, app) -> None:
    _prepare(client)

    def boom(*args, **kwargs):
        raise RuntimeError("编排异常")

    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(run_mod, "run_program", boom)
    try:
        accepted = submit(client, simple_program(), "run-recover-1")
        assert accepted.status_code == 200
        frames, result = drain(client, "run-recover-1")
        assert result is not None
        assert result["status"] == "crashed"
        assert result["error"]["code"] == "RUNNER_CRASHED"
        assert len([name for name, _ in frames if name == "result"]) == 1

        snapshot = client.get("/api/v1/runs/run-recover-1").json()["data"]
        assert snapshot["finished"] is True
    finally:
        monkeypatch.undo()

    again = submit(client, simple_program(), "run-recover-2")
    assert again.status_code == 200
    _, result_again = drain(client, "run-recover-2")
    assert result_again["status"] == "completed"
    assert app.state.runs._active_id is None


def test_evaluate_exception_is_crash(client, app) -> None:
    _prepare(client)
    original = run_mod.evaluate_criteria

    def boom(*args, **kwargs):
        raise ValueError("评估异常")

    run_mod.evaluate_criteria = boom
    try:
        accepted = submit(client, simple_program(), "run-eval-1")
        assert accepted.status_code == 200
        frames, result = drain(client, "run-eval-1")
        assert result["status"] == "crashed"
        assert result["error"]["code"] == "RUNNER_CRASHED"
        assert len([name for name, _ in frames if name == "result"]) == 1
    finally:
        run_mod.evaluate_criteria = original
    assert app.state.runs._active_id is None


def test_evidence_exception_keeps_published_result(client, app, monkeypatch) -> None:
    _prepare(client)

    def boom(**kwargs):
        raise RuntimeError("证据异常")

    monkeypatch.setattr(app.state.session, "add_evidence", boom)
    accepted = submit(client, simple_program(), "run-evidence-1")
    assert accepted.status_code == 200
    frames, result = drain(client, "run-evidence-1")
    assert result["status"] == "completed"
    assert len([name for name, _ in frames if name == "result"]) == 1
    snapshot = client.get("/api/v1/runs/run-evidence-1").json()["data"]
    assert snapshot["finished"] is True
    assert app.state.runs._active_id is None


def test_log_exception_does_not_block_slot(client, app, monkeypatch) -> None:
    _prepare(client)

    def boom(*args, **kwargs):
        raise OSError("日志异常")

    monkeypatch.setattr(run_mod, "write_log", boom)
    accepted = submit(client, simple_program(), "run-log-1")
    assert accepted.status_code == 200
    _, result = drain(client, "run-log-1")
    assert result["status"] == "completed"
    assert app.state.runs._active_id is None


def test_thread_start_failure_rolls_back(client, app, monkeypatch) -> None:
    _prepare(client)
    manager = app.state.runs

    class BrokenThread:
        def __init__(self, *args, **kwargs) -> None:
            pass

        def start(self) -> None:
            raise RuntimeError("无法启动线程")

    monkeypatch.setattr(run_mod, "Thread", BrokenThread)
    response = submit(client, simple_program(), "run-start-fail")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "RUN_START_FAILED"
    assert manager._runs == {}
    assert manager._active_id is None


def test_rejects_when_run_program_raises_api_error_shape(client, app) -> None:
    manager = app.state.runs
    with pytest.raises(ApiError):
        manager.submit({"requestId": "bad id", "cancelToken": "token", "taskId": "main"})
    assert manager._runs == {}
    assert manager._active_id is None