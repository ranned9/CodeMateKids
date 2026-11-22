"""验证调试指令确实推进 Python 执行，并逐步回传舞台状态。"""

import asyncio
import json
from queue import Empty, Queue
from threading import Event, Thread

import pytest

from backend.service import run as run_mod
from tests.helpers import drain, node, program, simple_program, submit


def test_debug_run_pauses_and_steps_through_loop(client, app):
    root = node("start", "event.start", {}, nxt=node(
        "repeat", "control.repeat", {"times": 2},
        body=[node("move", "motion.move", {"steps": 2}), node("turn", "motion.turn", {"degrees": 90})],
        nxt=node("say", "look.say", {"text": "完成啦"}),
    ))
    payload = program(root)
    request_id = "run-debug"
    token = "debug-token"
    url = f"/api/v1/runs/{request_id}"
    client.post("/api/v1/session/prediction", json={"taskId": "main", "value": 2})
    response = client.post("/api/v1/runs", json={
        "requestId": request_id, "cancelToken": token, "target": payload["target"],
        "courseRef": payload["courseRef"], "taskId": "main", "program": payload,
        "debug": True, "limits": {"wallTimeMs": 800},
    })
    assert response.status_code == 200, response.json()
    frames = Queue()

    def collect():
        for frame in app.state.runs.stream(request_id):
            if frame.startswith(":"):
                continue
            _, event, data, *_ = frame.splitlines()
            frames.put((event.removeprefix("event: "), json.loads(data.removeprefix("data: "))))

    def step(seq, cancel_token=token):
        return client.post(f"{url}/step", json={"seq": seq, "cancelToken": cancel_token}).json()

    reader = Thread(target=collect, daemon=True)
    reader.start()
    try:
        assert frames.get(timeout=5)[0] == "started"
        expected = [
            ("start", 0, 0, 0), ("repeat", 0, 0, 0), ("move", 2, 0, 0), ("turn", 2, 0, 90),
            ("repeat", 2, 0, 90), ("move", 2, 2, 90), ("turn", 2, 2, 180),
            ("repeat", 2, 2, 180), ("say", 2, 2, 180),
        ]
        for index, (block_id, x, y, heading) in enumerate(expected):
            _, enter = frames.get(timeout=5)
            assert (enter["kind"], enter["blockId"]) == ("block_enter", block_id)
            if index == 0:
                assert step(enter["seq"], "wrong-token")["error"]["code"] == "CANCEL_TOKEN_MISMATCH"
                with pytest.raises(Empty):
                    frames.get(timeout=1.35)  # 暂停时间长于常规执行超时。
            assert step(enter["seq"])["data"]["accepted"] is True
            assert step(enter["seq"])["data"]["accepted"] is False
            _, exit_event = frames.get(timeout=5)
            assert (exit_event["kind"], exit_event["blockId"]) == ("block_exit", block_id)
            stage = exit_event["stage"]
            assert (stage["x"], stage["y"], stage["heading"]) == (x, y, heading)
            assert stage["said"] == ("完成啦" if block_id == "say" else "")
        name, result = frames.get(timeout=5)
        assert (name, result["status"]) == ("result", "completed")
        assert result["objects"] == [stage]
    finally:
        client.post(f"{url}/cancel", json={"cancelToken": token})
        reader.join(timeout=5)


def test_debug_disconnect_frees_slot_before_finishing_logs(client, app, monkeypatch):
    manager = app.state.runs
    logging = Event()
    finish_logging = Event()
    original_log = manager._log_finished_safely

    def delayed_log(context, started):
        if context.request_id == "run-disconnected":
            logging.set()
            finish_logging.wait(timeout=5)
        original_log(context, started)

    monkeypatch.setattr(manager, "_log_finished_safely", delayed_log)
    client.post("/api/v1/session/prediction", json={"taskId": "main", "value": 2})
    assert submit(client, simple_program(), "run-disconnected", debug=True).status_code == 200

    async def disconnect_after_pause():
        paused = asyncio.Event()
        request_received = False

        async def send(message):
            if b"block_enter" in message.get("body", b""):
                paused.set()

        async def receive():
            nonlocal request_received
            if not request_received:
                request_received = True
                return {"type": "http.request", "body": b"", "more_body": False}
            await paused.wait()
            return {"type": "http.disconnect"}

        path = "/api/v1/runs/run-disconnected/events"
        scope = {
            "type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"},
            "method": "GET", "scheme": "http", "path": path, "query_string": b"",
            "headers": [(b"host", b"testserver")],
        }
        await asyncio.wait_for(app(scope, receive, send), timeout=5)

    try:
        asyncio.run(disconnect_after_pause())
        assert logging.wait(timeout=5)
        snapshot = client.get("/api/v1/runs/run-disconnected").json()["data"]
        assert (snapshot["finished"], snapshot["status"]) == (True, "cancelled")
        assert submit(client, simple_program(), "run-after-disconnect").status_code == 200
    finally:
        finish_logging.set()

    _, result = drain(client, "run-after-disconnect")
    assert result["status"] == "completed"


def test_debug_cancelled_if_page_leaves_before_stream_connects(client, app, monkeypatch):
    monkeypatch.setattr(run_mod, "DEBUG_CONNECT_TIMEOUT_S", 0.05)
    client.post("/api/v1/session/prediction", json={"taskId": "main", "value": 2})
    assert submit(client, simple_program(), "run-no-stream", debug=True).status_code == 200
    context = app.state.runs._runs["run-no-stream"]
    assert context.cancel_event.wait(timeout=5)
    _, result = drain(client, "run-no-stream")
    assert result["status"] == "cancelled"
