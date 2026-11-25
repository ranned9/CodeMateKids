"""语音识别接口：校验链、停用语义、超时降级与零 SIS 触达全覆盖。"""

from __future__ import annotations

import base64
import binascii

import pytest

from backend.api.routers import speech as speech_router
from backend.infra.errors import ApiError
from backend.service.speech import SpeechService, SpeechServiceError
from tests.test_teaching import _browser_headers


class FakeSpeech:
    def __init__(self, *, text="你好呀", error=None, available=True):
        self.available = available
        self.calls = 0
        self.last_audio = None
        self._text = text
        self._error = error
        self.last_cloud_trace_id = "cloud-trace-1"

    def recognize(self, audio_base64):
        self.calls += 1
        self.last_audio = audio_base64
        if self._error is not None:
            raise self._error
        return self._text

    def synthesize(self, text):
        raise AssertionError("recognize route must not call synthesize")


def _headers(app):
    return _browser_headers(app)


def _recog(payload):
    return "/api/v1/speech/recognize"


def test_disabled_speech_returns_503(client, app) -> None:
    assert app.state.speech.available is False
    reply = client.post(_recog(None), headers=_headers(app), json={"audioBase64": base64.b64encode(b"hi").decode()})
    assert reply.status_code == 503
    error = reply.json()["error"]
    assert error["code"] == "SPEECH_UNAVAILABLE"
    assert "还没准备好" in error["messageForChild"]
    assert "打字" in error["messageForChild"]


def test_payload_too_large_rejected_before_parsing(client, app, monkeypatch) -> None:
    fake = FakeSpeech()
    monkeypatch.setattr(app.state, "speech", fake)
    big_body = '{"audioBase64": "' + "A" * (512 * 1024 + 10) + '"}'
    reply = client.post(
        _recog(None), headers={**_headers(app), "Content-Type": "application/json"}, data=big_body
    )
    assert reply.status_code == 413
    assert reply.json()["error"]["code"] == "SPEECH_PAYLOAD_TOO_LARGE"
    assert fake.calls == 0


@pytest.mark.parametrize(
    "payload",
    [
        {"audioBase64": ""},
        {"audioBase64": "!!!!"},
        {"audioBase64": "QQ"},
        {"audioBase64": "AAA*"},
    ],
)
def test_invalid_audio_variants_rejected_without_sis(client, app, monkeypatch, payload) -> None:
    fake = FakeSpeech()
    monkeypatch.setattr(app.state, "speech", fake)
    reply = client.post(_recog(None), headers=_headers(app), json=payload)
    assert reply.status_code == 422
    assert reply.json()["error"]["code"] == "SPEECH_AUDIO_INVALID"
    assert fake.calls == 0


def test_invalid_json_structure_maps_to_schema_error(client, app, monkeypatch) -> None:
    fake = FakeSpeech()
    monkeypatch.setattr(app.state, "speech", fake)
    reply = client.post(_recog(None), headers=_headers(app), json={"unexpected": "field"})
    assert reply.status_code == 422
    assert reply.json()["error"]["code"] == "PROGRAM_SCHEMA_INVALID"
    assert fake.calls == 0


def test_upstream_failure_maps_to_503_with_zero_retry(client, app, monkeypatch) -> None:
    fake = FakeSpeech(error=SpeechServiceError("upstream"))
    monkeypatch.setattr(app.state, "speech", fake)
    reply = client.post(
        _recog(None), headers=_headers(app), json={"audioBase64": base64.b64encode(b"hi").decode()}
    )
    assert reply.status_code == 503
    error = reply.json()["error"]
    assert error["code"] == "SPEECH_UNAVAILABLE"
    assert "没听清" in error["messageForChild"]
    assert fake.calls == 1


def test_recognize_success_returns_text_with_no_store(client, app, monkeypatch) -> None:
    fake = FakeSpeech(text="小车走了三步")
    monkeypatch.setattr(app.state, "speech", fake)
    reply = client.post(
        _recog(None), headers=_headers(app), json={"audioBase64": base64.b64encode(b"hi").decode()}
    )
    assert reply.status_code == 200
    assert reply.headers["cache-control"] == "no-store"
    data = reply.json()["data"]
    assert data["text"] == "小车走了三步"
    assert fake.calls == 1
    assert fake.last_audio == base64.b64encode(b"hi").decode()


def test_missing_student_header_uses_temporary_session(client, app, monkeypatch) -> None:
    fake = FakeSpeech()
    monkeypatch.setattr(app.state, "speech", fake)
    reply = client.post(
        _recog(None), headers=_headers(app), json={"audioBase64": base64.b64encode(b"hi").decode()}
    )
    assert reply.status_code == 200


def test_missing_origin_is_forbidden_even_without_student_header(client, app, monkeypatch) -> None:
    fake = FakeSpeech()
    monkeypatch.setattr(app.state, "speech", fake)
    headers = _headers(app)
    headers.pop("Origin")
    reply = client.post(_recog(None), headers=headers, json={"audioBase64": "aGk="})
    assert reply.status_code == 403
    assert reply.headers["cache-control"] == "no-store"
    assert fake.calls == 0


def test_valid_student_header_follows_same_path(client, app, monkeypatch) -> None:
    created = client.post("/api/v1/students", headers=_headers(app), json={"displayName": "小语"})
    student_id = created.json()["data"]["studentId"]
    fake = FakeSpeech()
    monkeypatch.setattr(app.state, "speech", fake)
    reply = client.post(
        _recog(None), headers={**_headers(app), "X-CMK-Student-Id": student_id},
        json={"audioBase64": base64.b64encode(b"hi").decode()},
    )
    assert reply.status_code == 200


def test_unknown_student_header_rejected(client, app, monkeypatch) -> None:
    fake = FakeSpeech()
    monkeypatch.setattr(app.state, "speech", fake)
    reply = client.post(
        _recog(None), headers={**_headers(app), "X-CMK-Student-Id": "student-0123456789abcdef0123456789abcdef"},
        json={"audioBase64": base64.b64encode(b"hi").decode()},
    )
    assert reply.status_code == 404
    assert reply.json()["error"]["code"] == "STUDENT_NOT_FOUND"


def test_service_timeout_converted_without_hanging(monkeypatch) -> None:
    import time as time_mod

    from backend.infra.config import load_settings
    from backend.service import speech as speech_module

    monkeypatch.setattr(speech_module, "CALL_TIMEOUT_SECONDS", 0.1)
    service = SpeechService(
        load_settings(
            {"CMK_SIS_REGION": "cn-north-4", "CMK_SIS_PROJECT_ID": "p", "CMK_SIS_AK": "a", "CMK_SIS_SK": "s"}
        )
    )
    assert service.available is True

    def slow(_request):
        time_mod.sleep(0.3)
        return object()

    monkeypatch.setattr(service, "_call_recognize", slow)
    with pytest.raises(SpeechServiceError) as exc:
        service.recognize(base64.b64encode(b"hi").decode())
    assert exc.value.category == "timeout"


def test_recognize_route_never_persists_audio() -> None:
    source = speech_router.__file__
    text = open(source, "r", encoding="utf-8").read()
    assert "open(" not in text
    assert ".write(" not in text
    assert "Path(" not in text


def test_error_specs_are_speech_namespaced() -> None:
    from backend.infra.errors import ERROR_SPECS

    assert ERROR_SPECS["SPEECH_UNAVAILABLE"].http_status == 503
    assert ERROR_SPECS["SPEECH_PAYLOAD_TOO_LARGE"].http_status == 413
    assert ERROR_SPECS["SPEECH_AUDIO_INVALID"].http_status == 422
