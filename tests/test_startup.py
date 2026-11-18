"""启动门禁：五项检查、fatal/degraded 分支、版本来源与凭据降级。"""

from __future__ import annotations

import pytest

from backend.domain.blocks import BlockSchemaError
from backend.infra.config import load_settings
from backend.infra.errors import ApiError
from backend.service import startup as startup_mod
from backend.service.startup import check_startup


@pytest.fixture(autouse=True)
def clear_startup_cache():
    startup_mod._CACHE.clear()
    yield
    startup_mod._CACHE.clear()


def test_startup_ready_uses_worker_probe(settings) -> None:
    data = check_startup(settings)
    assert data["status"] == "ready"
    assert data["python"]["source"] == "worker_probe"
    assert (data["python"]["major"], data["python"]["minor"]) == (3, 12)
    assert {item["name"] for item in data["checks"]} == {"os", "python", "worker", "schema", "course"}
    assert data["tutorMode"] == "mock"
    assert data["elapsedMs"] >= 0
    assert data["schemaVersion"] == "1.0.0"
    assert data["courseVersion"] == 1


def test_python_mismatch_is_fatal(settings, monkeypatch) -> None:
    monkeypatch.setattr(
        startup_mod,
        "probe_worker_python",
        lambda: {"major": 3, "minor": 11, "patch": 9, "source": "worker_probe"},
    )
    data = check_startup(settings, refresh=True)
    assert data["status"] == "fatal"
    python_check = next(item for item in data["checks"] if item["name"] == "python")
    assert python_check["status"] == "failed"


def test_unsupported_os_is_fatal(settings, monkeypatch) -> None:
    monkeypatch.setattr(startup_mod.sys, "platform", "linux")
    data = check_startup(settings, refresh=True)
    assert data["status"] == "fatal"
    os_check = next(item for item in data["checks"] if item["name"] == "os")
    assert os_check["status"] == "failed"


def test_broken_schema_is_fatal(settings, monkeypatch) -> None:
    def broken():
        raise BlockSchemaError("schema broken")

    monkeypatch.setattr(startup_mod, "load_blocks", broken)
    data = check_startup(settings, refresh=True)
    assert data["status"] == "fatal"
    schema_check = next(item for item in data["checks"] if item["name"] == "schema")
    assert schema_check["status"] == "failed"


def test_worker_unavailable_degrades(settings, monkeypatch) -> None:
    monkeypatch.setattr(
        startup_mod,
        "probe_worker_python",
        lambda: {"major": 0, "minor": 0, "patch": 0, "source": "unavailable"},
    )
    data = check_startup(settings, refresh=True)
    assert data["status"] == "degraded"
    python_check = next(item for item in data["checks"] if item["name"] == "python")
    worker_check = next(item for item in data["checks"] if item["name"] == "worker")
    assert python_check["status"] == "warn"
    assert worker_check["status"] == "failed"


def test_course_unavailable_degrades(settings, monkeypatch) -> None:
    def broken(settings_arg, refresh=False):
        raise ApiError("COURSE_VERSION_UNSUPPORTED")

    monkeypatch.setattr(startup_mod.course_service, "load_course", broken)
    data = check_startup(settings, refresh=True)
    assert data["status"] == "degraded"
    course_check = next(item for item in data["checks"] if item["name"] == "course")
    assert course_check["status"] == "failed"


def test_cache_and_refresh(settings) -> None:
    first = check_startup(settings)
    second = check_startup(settings)
    assert first["cached"] is False
    assert second["cached"] is True
    assert second["elapsedMs"] == first["elapsedMs"]
    refreshed = check_startup(settings, refresh=True)
    assert refreshed["cached"] is False
    assert refreshed is not first


def test_missing_credentials_force_mock() -> None:
    settings = load_settings({"CMK_TUTOR_MODE": "model", "CMK_MODEL_ENDPOINT": "", "CMK_MODEL_KEY": ""})
    assert settings.tutor_mode == "mock"
    configured = load_settings(
        {
            "CMK_TUTOR_MODE": "model",
            "CMK_MODEL_ENDPOINT": "https://example.invalid/model",
            "CMK_MODEL_KEY": "secret-key",
        }
    )
    assert configured.tutor_mode == "model"