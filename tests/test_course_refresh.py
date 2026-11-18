"""RG-10：课程内容指纹刷新、单请求一致与运行任务快照。"""

from __future__ import annotations

import json
import shutil
import threading
import time
from pathlib import Path

from backend.infra.config import load_settings
from backend.service import run as run_mod
from backend.service.course import course_payload, load_course
from backend.tutor import mock
from backend.tutor.engine import Decision
from tests.helpers import ROOT, simple_program, submit


def _settings(tmp_path: Path):
    target = tmp_path / "demo-loop"
    shutil.copytree(ROOT / "content" / "demo-loop", target)
    return (
        load_settings(
            {
                "CMK_COURSE_DIR": str(target),
                "CMK_LOG_DIR": str(tmp_path / "logs"),
                "CMK_TUTOR_MODE": "mock",
            }
        ),
        target,
    )


def test_fingerprint_changes_after_content_update(tmp_path) -> None:
    settings, root = _settings(tmp_path)
    first = load_course(settings, refresh=True)
    again = load_course(settings)
    assert again is first

    path = root / "tutor.replies.json"
    payload = json.loads(path.read_text(encoding="utf-8"))
    payload["replies"].append(
        {
            "taskId": "main",
            "errorPattern": "default",
            "learnerChoice": "hint",
            "level": 1,
            "action": "hint",
            "message": "新的回复内容。",
            "nextStep": "试试新的下一步",
            "uncertainty": "还不确定。",
        }
    )
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    second = load_course(settings)
    assert second.content_fingerprint != first.content_fingerprint
    assert any(item["message"] == "新的回复内容。" for item in second.replies)

    context = {"task_id": "main", "learner_choice": "hint", "evidence_types": ["run_result"]}
    reply = mock.reply(settings, context, Decision("hint", 1, "default", "test"), second)
    assert reply["message"] == "新的回复内容。"


def test_same_request_uses_same_bundle(tmp_path) -> None:
    settings, _root = _settings(tmp_path)
    bundle = load_course(settings, refresh=True)
    payload = course_payload(settings, "demo-loop", bundle)
    context = {"task_id": "main", "learner_choice": "hint", "evidence_types": []}
    reply = mock.reply(settings, context, Decision("hint", 1, "default", "test"), bundle)
    assert payload["contentVersion"] == bundle.content_version
    assert reply["mode"] == "mock"


def test_run_uses_task_snapshot(tmp_path, monkeypatch) -> None:
    settings, _root = _settings(tmp_path)
    from fastapi.testclient import TestClient

    from backend.app import create_app

    app = create_app(settings)
    release = threading.Event()
    captured = {"objective": ""}

    def slow_runner(program, limits, request_id, cancel_event, on_frame, log_event=None):
        captured["objective"] = ""
        release.wait(2.0)
        return {
            "protocolVersion": 1,
            "requestId": request_id,
            "status": "completed",
            "stdout": "",
            "stderr": "",
            "error": None,
            "events": [],
            "durationMs": 1,
            "truncated": False,
            "objects": [{"id": "stage", "x": 0, "y": 0, "heading": 0, "said": "", "steps": 2}],
            "memoryLimitMode": "unavailable",
        }

    monkeypatch.setattr(run_mod, "run_program", slow_runner)
    with TestClient(app) as client:
        client.post("/api/v1/session/prediction", json={"taskId": "main", "value": 2})
        bundle = load_course(settings, refresh=True)
        original_objective = bundle.tasks["main"]["objective"]
        response = submit(client, simple_program(), "run-snapshot-iso")
        assert response.status_code == 200
        time.sleep(0.05)
        bundle.tasks["main"]["objective"] = "被修改后的目标"
        context = app.state.runs._runs["run-snapshot-iso"]
        assert context.task_snapshot["objective"] == original_objective
        release.set()
        deadline = time.time() + 3
        while time.time() < deadline and not context.finished:
            time.sleep(0.02)
        assert context.finished is True