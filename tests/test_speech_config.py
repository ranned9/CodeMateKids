"""0.8.0 P0 语音配置矩阵：四组合启动、可用性三态、启动投影与凭证泄露。"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.infra.config import load_settings
from backend.service.speech import SpeechService

SIS_CREDENTIALS = {
    "CMK_SIS_REGION": "cn-north-4",
    "CMK_SIS_PROJECT_ID": "proj-123",
    "CMK_SIS_AK": "ak-test-value",
    "CMK_SIS_SK": "sk-test-value",
}


def _env_with_sis(tmp_path: dict, **overrides) -> dict:
    env = {
        "CMK_LOG_DIR": str(tmp_path / "logs"),
        "CMK_LEARNING_DB_PATH": str(tmp_path / "data" / "learning.sqlite3"),
        "CMK_COURSE_DIR": str(tmp_path / "content"),
    }
    env.update(SIS_CREDENTIALS)
    env.update(overrides)
    return env


def test_all_missing_credentials_disable_speech(tmp_path) -> None:
    service = SpeechService(load_settings({}))
    assert service.available is False
    assert service.disabled_reason == "incomplete_credentials"


@pytest.mark.parametrize(
    "drop",
    ["CMK_SIS_PROJECT_ID", "CMK_SIS_AK", "CMK_SIS_SK"],
)
def test_partial_credentials_equal_unconfigured(tmp_path, drop) -> None:
    env = _env_with_sis(tmp_path)
    env.pop(drop)
    service = SpeechService(load_settings(env))
    assert service.available is False
    assert service.disabled_reason == "incomplete_credentials"


def test_unsupported_region_disables_speech(tmp_path) -> None:
    env = _env_with_sis(tmp_path, CMK_SIS_REGION="cn-south-1")
    service = SpeechService(load_settings(env))
    assert service.available is False
    assert service.disabled_reason == "region_unsupported"


def test_client_init_failure_disables_but_starts(tmp_path, monkeypatch) -> None:
    env = _env_with_sis(tmp_path)

    def broken(_self):
        raise RuntimeError("sdk exploded")

    monkeypatch.setattr(SpeechService, "_build_client", broken)
    settings = load_settings(env)
    app = create_app(settings)
    assert app.state.speech.available is False
    assert app.state.speech.disabled_reason == "client_init_failed"


def test_complete_credentials_enable_speech(tmp_path) -> None:
    settings = load_settings(_env_with_sis(tmp_path))
    app = create_app(settings)
    assert app.state.speech.available is True
    assert app.state.speech.disabled_reason == ""
    with TestClient(app) as client:
        data = client.get("/api/v1/startup/check").json()["data"]
        assert data["tutorChatEnabled"] is True
        assert data["tutorSpeechEnabled"] is True


def test_unconfigured_startup_projects_false(tmp_path) -> None:
    settings = load_settings(
        {
            "CMK_LOG_DIR": str(tmp_path / "logs"),
            "CMK_LEARNING_DB_PATH": str(tmp_path / "data" / "learning.sqlite3"),
            "CMK_COURSE_DIR": str(tmp_path / "content"),
        }
    )
    with TestClient(create_app(settings)) as client:
        data = client.get("/api/v1/startup/check").json()["data"]
        assert data["tutorSpeechEnabled"] is False
        assert data["tutorChatEnabled"] is True


def test_chat_disabled_forces_speech_projection_false(tmp_path) -> None:
    env = _env_with_sis(tmp_path, CMK_TUTOR_CHAT_ENABLED="0")
    settings = load_settings(env)
    with TestClient(create_app(settings)) as client:
        data = client.get("/api/v1/startup/check").json()["data"]
        assert data["tutorChatEnabled"] is False
        assert data["tutorSpeechEnabled"] is False


def test_no_credential_leakage_in_state_or_response(tmp_path) -> None:
    settings = load_settings(_env_with_sis(tmp_path))
    app = create_app(settings)
    service = app.state.speech
    leak_sources = (
        repr(service),
        str(service),
        str(service.disabled_reason),
        str(service.available),
    )
    for source in leak_sources:
        assert "ak-test-value" not in source
        assert "sk-test-value" not in source
        assert "proj-123" not in source
    with TestClient(app) as client:
        body = client.get("/api/v1/startup/check").text
        assert "ak-test-value" not in body
        assert "sk-test-value" not in body


def test_region_mapping_defaults_to_north4(tmp_path) -> None:
    env = _env_with_sis(tmp_path)
    env.pop("CMK_SIS_REGION")
    settings = load_settings(env)
    assert settings.sis_region == "cn-north-4"
    service = SpeechService(settings)
    assert service.available is True


@pytest.mark.parametrize(
    ("env", "voice"),
    [
        ({}, "chinese_huaxiaorui_common"),
        ({"CMK_SIS_TTS_VOICE": " chinese_xiaoyan_common "}, "chinese_xiaoyan_common"),
        ({"CMK_SIS_TTS_VOICE": " "}, "chinese_huaxiaorui_common"),
    ],
)
def test_tts_request_uses_configured_voice_and_classroom_pace(env, voice) -> None:
    service = SpeechService(load_settings(env))
    request = service._build_synthesize_request("先试着让海龟走一步。")
    assert request.body.config._property == voice
    assert request.body.config.sample_rate == "16000"
    assert request.body.config.speed == -40
    assert request.body.config.pitch is None
