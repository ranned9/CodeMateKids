"""pytest 夹具：临时日志目录 + TestClient。"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.app import create_app  # noqa: E402
from backend.infra.config import load_settings  # noqa: E402


@pytest.fixture()
def settings(tmp_path):
    env = {
        "CMK_LOG_DIR": str(tmp_path / "logs"),
        "CMK_COURSE_DIR": str(PROJECT_ROOT / "content" / "demo-loop"),
        "CMK_TUTOR_MODE": "mock",
    }
    return load_settings(env)


@pytest.fixture()
def app(settings):
    return create_app(settings)


@pytest.fixture()
def client(app):
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def log_dir(settings):
    path = Path(settings.log_dir)
    path.mkdir(parents=True, exist_ok=True)
    return path