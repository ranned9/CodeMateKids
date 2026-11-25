"""语音合成接口：peek 归属、双形态响应、no-store 与音频零落盘。"""

from __future__ import annotations

import pytest

from backend.api.routers import speech as speech_router
from backend.service.course import find_task
from backend.service.speech import SpeechServiceError
from tests.helpers import node, program
from tests.test_classroom_chat import _chat, _program, _scope
from tests.test_teaching import _browser_headers


class FakeSynth:
    def __init__(self, *, audio=b"ID3" + b"\x00" * 64, error=None):
        self.available = True
        self.calls = 0
        self.last_text = None
        self._audio = audio
        self._error = error
        self.last_cloud_trace_id = "cloud-trace-2"

    def recognize(self, audio_base64):
        raise AssertionError("synthesize route must not call recognize")

    def synthesize(self, text):
        self.calls += 1
        self.last_text = text
        if self._error is not None:
            raise self._error
        return self._audio


def _setup(client, app, monkeypatch, *, message="小车走了几步呀？"):
    scope = _scope(client, "main", "ws-local")
    snapshot = _program("main", 3, 2, outside=True)
    reply = _chat(client, app, scope, snapshot, "turn-1", message)
    fake = FakeSynth()
    monkeypatch.setattr(app.state, "speech", fake)
    return scope, reply, fake


def _headers(app):
    return _browser_headers(app)


def test_synthesize_success_returns_mp3_with_no_store(client, app, monkeypatch) -> None:
    scope, _reply, fake = _setup(client, app, monkeypatch)
    response = client.post(
        "/api/v1/speech/synthesize", headers=_headers(app), json={"turnId": "turn-1", "scope": scope}
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/mpeg"
    assert response.headers["cache-control"] == "no-store"
    assert response.content == fake._audio
    assert fake.calls == 1
    assert fake.last_text == _reply["message"]


def test_synthesize_unknown_turn_returns_404(client, app, monkeypatch) -> None:
    scope, _reply, fake = _setup(client, app, monkeypatch)
    response = client.post(
        "/api/v1/speech/synthesize", headers=_headers(app), json={"turnId": "turn-x", "scope": scope}
    )
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "RUN_NOT_FOUND"
    assert fake.calls == 0


def test_synthesize_cross_student_returns_404_without_detail(client, app, monkeypatch) -> None:
    scope, _reply, _fake = _setup(client, app, monkeypatch)
    other = "guest-0123456789abcdef0123456789abcdef"
    response = client.post(
        "/api/v1/speech/synthesize",
        headers={**_headers(app), "X-CMK-Student-Id": other},
        json={"turnId": "turn-1", "scope": scope},
    )
    assert response.status_code == 404
    body = response.json()["error"]
    assert body["code"] == "RUN_NOT_FOUND"
    assert "学生" not in body["messageForChild"]


def test_synthesize_overlong_text_returns_playable_false(client, app, monkeypatch) -> None:
    scope, _reply, fake = _setup(client, app, monkeypatch)
    monkeypatch.setattr(
        app.state.classroom_conversations,
        "peek",
        lambda scope_key, turn_id: {"message": "长" * 600},
    )
    response = client.post(
        "/api/v1/speech/synthesize", headers=_headers(app), json={"turnId": "turn-1", "scope": scope}
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    data = response.json()["data"]
    assert data["playable"] is False
    assert data["reasonCode"] == "SPEECH_TEXT_TOO_LONG"
    assert fake.calls == 0


def test_synthesize_disabled_returns_503(client, app, monkeypatch) -> None:
    scope, _reply, _fake = _setup(client, app, monkeypatch)
    monkeypatch.setattr(app.state.speech, "available", False)
    response = client.post(
        "/api/v1/speech/synthesize", headers=_headers(app), json={"turnId": "turn-1", "scope": scope}
    )
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "SPEECH_UNAVAILABLE"


def test_synthesize_scope_missing_workspace_returns_422(client, app, monkeypatch) -> None:
    scope, _reply, fake = _setup(client, app, monkeypatch)
    broken = {**scope}
    broken.pop("workspaceId")
    response = client.post(
        "/api/v1/speech/synthesize", headers=_headers(app), json={"turnId": "turn-1", "scope": broken}
    )
    assert response.status_code == 422
    assert fake.calls == 0


def test_synthesize_version_mismatch_returns_409(client, app, monkeypatch) -> None:
    scope, _reply, fake = _setup(client, app, monkeypatch)
    broken = {**scope, "contentVersion": "9.9.9"}
    response = client.post(
        "/api/v1/speech/synthesize", headers=_headers(app), json={"turnId": "turn-1", "scope": broken}
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "COURSE_VERSION_UNSUPPORTED"
    assert fake.calls == 0


def test_synthesize_upstream_failure_maps_to_503(client, app, monkeypatch) -> None:
    scope, _reply, fake = _setup(client, app, monkeypatch, message="长" * 5)
    monkeypatch.setattr(fake, "_error", SpeechServiceError("upstream"))
    response = client.post(
        "/api/v1/speech/synthesize", headers=_headers(app), json={"turnId": "turn-1", "scope": scope}
    )
    assert response.status_code == 503
    assert fake.calls == 1


def test_synthesize_audio_never_persisted(client, app, monkeypatch, settings, tmp_path) -> None:
    scope, _reply, _fake = _setup(client, app, monkeypatch)
    response = client.post(
        "/api/v1/speech/synthesize", headers=_headers(app), json={"turnId": "turn-1", "scope": scope}
    )
    assert response.status_code == 200
    log_dir = settings.log_dir
    persisted = [p.name for p in log_dir.rglob("*") if p.is_file()] if log_dir.exists() else []
    assert all(not name.endswith((".mp3", ".webm", ".ogg")) for name in persisted)


def test_task_speech_uses_current_course_text(client, app, monkeypatch) -> None:
    scope = _scope(client, "transfer-square", "task-audio")
    task = find_task(app.state.settings, scope["taskId"])
    fake = FakeSynth()
    monkeypatch.setattr(app.state, "speech", fake)
    body = {"taskId": scope["taskId"], "contentVersion": scope["contentVersion"]}

    response = client.post("/api/v1/speech/task", headers=_headers(app), json=body)
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "audio/mpeg"
    assert response.headers["cache-control"] == "no-store"
    assert "X-CMK-Speech-More" not in response.headers
    assert task["title"] in fake.last_text and task["objective"] in fake.last_text
    assert all(item["description"] in fake.last_text for item in task["successCriteria"])
    stale = client.post("/api/v1/speech/task", headers=_headers(app), json={**body, "contentVersion": "0.0.0"})
    assert stale.status_code == 409
    assert fake.calls == 1


def test_task_speech_continues_past_sis_character_limit(client, app, monkeypatch) -> None:
    scope = _scope(client, "main", "long-task-audio")
    task = {**find_task(app.state.settings, "main"), "objective": "长" * 550}
    monkeypatch.setattr(speech_router, "find_task", lambda *_: task)
    fake = FakeSynth()
    monkeypatch.setattr(app.state, "speech", fake)
    body = {"taskId": "main", "contentVersion": scope["contentVersion"]}

    first = client.post("/api/v1/speech/task", headers=_headers(app), json=body)
    assert first.status_code == 200 and first.headers["X-CMK-Speech-More"] == "1"
    start_text = fake.last_text
    second = client.post("/api/v1/speech/task", headers=_headers(app), json={**body, "part": 1})
    assert second.status_code == 200 and "X-CMK-Speech-More" not in second.headers
    assert len(start_text) <= 500 and len(fake.last_text) <= 500
    assert "长" * 550 in start_text + fake.last_text
    assert task["successCriteria"][0]["description"] in fake.last_text
