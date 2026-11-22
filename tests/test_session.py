"""会话证据、取消/超时不产生成功证据、总结结构无分数。"""

from __future__ import annotations

import json

from backend.app import create_app
from backend.infra.config import load_settings
from tests.helpers import simple_program


def _submit(client, program: dict, request_id: str) -> dict:
    body = {
        "protocolVersion": 1,
        "requestId": request_id,
        "cancelToken": f"token-{request_id}",
        "target": {"language": "python", "version": "3.12"},
        "program": program,
        "courseRef": program["courseRef"],
        "taskId": program["courseRef"]["taskId"],
        "mode": "demo",
    }
    response = client.post("/api/v1/runs", json=body)
    assert response.status_code == 200, response.text
    return response.json()["data"]


def _drain(client, request_id: str) -> dict:
    frames = []
    with client.stream("GET", f"/api/v1/runs/{request_id}/events") as response:
        event = None
        data_lines: list[str] = []
        for line in response.iter_lines():
            if line.startswith("event:"):
                event = line.split(":", 1)[1].strip()
            elif line.startswith("data:"):
                data_lines.append(line.split(":", 1)[1].strip())
            elif line == "":
                if event:
                    frames.append((event, json.loads("".join(data_lines) or "{}")))
                    event = None
                    data_lines = []
    results = [payload for name, payload in frames if name == "result"]
    assert results, "SSE 中缺少 result 帧"
    return results[0]


def test_summary_empty_shape(client) -> None:
    data = client.get("/api/v1/session/summary").json()["data"]
    assert data["concepts"]
    assert data["completedTasks"] == []
    assert data["independentThings"] == []
    assert "这次还没有运行记录" in data["missing"]
    assert data["nextStep"]
    assert data["note"].startswith("仅代表本次会话观察")
    assert "score" not in json.dumps(data).lower()
    assert "排名" not in json.dumps(data, ensure_ascii=False)


def test_two_runs_keep_request_ids_separate(client, app) -> None:
    client.post("/api/v1/session/prediction", json={"taskId": "main", "value": 2})
    program = simple_program()
    first = _submit(client, program, "run-session-1")
    result_one = _drain(client, first["requestId"])
    second = _submit(client, program, "run-session-2")
    result_two = _drain(client, second["requestId"])
    assert result_one["status"] == "completed"
    assert result_two["status"] == "completed"

    evidence = app.state.session.recent_evidence("main", limit=20)
    run_evidence = [item for item in evidence if item["sourceType"] == "run_result"]
    assert len(run_evidence) >= 2
    request_ids = {item["requestId"] for item in run_evidence}
    assert {"run-session-1", "run-session-2"} <= request_ids
    assert all(item["observedFact"] for item in run_evidence)
    assert all(item["interpretation"]["text"] for item in run_evidence)


def test_cancelled_attempt_is_not_success(app) -> None:
    store = app.state.session
    store.record_attempt("main", "run-cancelled", "cancelled")
    data = store.summary(app.state.settings)
    assert data["completedTasks"] == []
    assert data["mainCompleted"] is False


def test_timeout_run_only_records_unfinished_fact(tmp_path) -> None:
    env = {
        "CMK_LOG_DIR": str(tmp_path / "logs"),
        "CMK_COURSE_DIR": str((tmp_path / "missing").resolve()),
        "CMK_RUN_WALL_MS": "200",
    }
    base = load_settings({"CMK_LOG_DIR": str(tmp_path / "logs"), "CMK_TUTOR_MODE": "mock"})
    settings = load_settings({**env, "CMK_COURSE_DIR": str(base.course_dir)})
    app = create_app(settings)
    from fastapi.testclient import TestClient

    with TestClient(app) as client:
        client.post("/api/v1/session/prediction", json={"taskId": "main", "value": 2})
        program = simple_program()
        inner = {"blockId": "b-move", "kind": "motion.move", "inputs": {"steps": 1}, "body": [], "next": None}
        current = inner
        for depth in range(5):
            current = {
                "blockId": f"b-slow-{depth}",
                "kind": "control.repeat",
                "inputs": {"times": 100},
                "body": [current],
                "next": None,
            }
        program["root"] = {
            "blockId": "b-start",
            "kind": "event.start",
            "inputs": {},
            "body": [],
            "next": current,
        }
        accepted = _submit(client, program, "run-timeout-1")
        result = _drain(client, accepted["requestId"])
        assert result["status"] == "timeout"
        assert result["error"]["code"] == "RUN_TIMEOUT"
        summary = client.get("/api/v1/session/summary").json()["data"]
        assert summary["completedTasks"] == []
        evidence = app.state.session.recent_evidence("main")
        assert any("未完成" in item["observedFact"] for item in evidence)


def test_independent_completion_flag(app) -> None:
    store = app.state.session
    store.record_attempt("main", "run-independent", "succeeded", highest_hint_level=0)
    data = store.summary(app.state.settings)
    assert data["completedTasks"]
    assert data["independentThings"] == data["completedTasks"]

    store.record_attempt("variant", "run-variant-with-hint", "succeeded", highest_hint_level=2)
    data_after = store.summary(app.state.settings)
    assert "让角色走四步" in data_after["independentThings"]
    assert "小海龟走六步" not in data_after["independentThings"]


def test_skipped_task_kept_and_listed(client, app) -> None:
    response = client.post("/api/v1/session/feedback", json={"taskId": "variant", "kind": "skip"})
    assert response.json()["data"]["skipped"] is True
    summary = client.get("/api/v1/session/summary").json()["data"]
    assert summary["skippedTasks"]
    resumed = client.post("/api/v1/session/feedback", json={"taskId": "variant", "kind": "resume"})
    assert resumed.json()["data"]["skipped"] is False


def test_feedback_enum_checked(client) -> None:
    response = client.post("/api/v1/session/feedback", json={"taskId": "main", "kind": "chat"})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "PROGRAM_SCHEMA_INVALID"
