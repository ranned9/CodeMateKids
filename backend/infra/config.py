"""读取启动配置。网页模型配置由运行时存储单独管理。"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

BASE_DIR = Path(__file__).resolve().parents[2]

APP_VERSION = "0.1.0"
EXPECTED_PYTHON = "3.12"


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    expected_python: str
    run_wall_ms: int
    run_memory_mb: int
    run_output_bytes: int
    run_recursion_depth: int
    tutor_mode: str
    tutor_timeout_ms: int
    model_endpoint: str
    model_key: str
    course_dir: Path
    log_dir: Path
    app_version: str = APP_VERSION
    tutor_agent_enabled: bool = False
    tutor_chat_enabled: bool = True
    learning_db_path: Path = BASE_DIR / "data" / "learning.sqlite3"


def _int_env(env: Mapping[str, str], name: str, default: int, minimum: int = 1) -> int:
    raw = env.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    if value < minimum:
        return default
    return value


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    source = os.environ if env is None else env

    host = (source.get("CMK_HOST") or "127.0.0.1").strip()
    port = _int_env(source, "CMK_PORT", 8000)

    expected_python = (source.get("CMK_EXPECTED_PYTHON") or EXPECTED_PYTHON).strip()
    if expected_python != EXPECTED_PYTHON:
        expected_python = EXPECTED_PYTHON

    model_endpoint = (source.get("CMK_MODEL_ENDPOINT") or "").strip()
    model_key = (source.get("CMK_MODEL_KEY") or "").strip()

    requested_mode = (source.get("CMK_TUTOR_MODE") or "mock").strip().lower()
    if requested_mode not in {"mock", "model"}:
        requested_mode = "mock"
    if not model_endpoint or not model_key:
        requested_mode = "mock"

    course_dir_raw = (source.get("CMK_COURSE_DIR") or "content/demo-loop").strip()
    course_dir = Path(course_dir_raw)
    if not course_dir.is_absolute():
        course_dir = BASE_DIR / course_dir

    log_dir_raw = (source.get("CMK_LOG_DIR") or "logs").strip()
    log_dir = Path(log_dir_raw)
    if not log_dir.is_absolute():
        log_dir = BASE_DIR / log_dir

    learning_db_path = BASE_DIR / (source.get("CMK_LEARNING_DB_PATH") or "data/learning.sqlite3")

    return Settings(
        host=host,
        port=port,
        expected_python=expected_python,
        run_wall_ms=_int_env(source, "CMK_RUN_WALL_MS", 3000, 100),
        run_memory_mb=_int_env(source, "CMK_RUN_MEMORY_MB", 128, 16),
        run_output_bytes=_int_env(source, "CMK_RUN_OUTPUT_BYTES", 16384, 256),
        run_recursion_depth=_int_env(source, "CMK_RUN_RECURSION_DEPTH", 200, 10),
        tutor_mode=requested_mode,
        tutor_timeout_ms=_int_env(source, "CMK_TUTOR_TIMEOUT_MS", 8000, 500),
        model_endpoint=model_endpoint,
        model_key=model_key,
        course_dir=course_dir,
        log_dir=log_dir,
        tutor_agent_enabled=(source.get("CMK_TUTOR_AGENT_ENABLED") or "").strip() == "1",
        tutor_chat_enabled=(source.get("CMK_TUTOR_CHAT_ENABLED") or "1").strip() != "0",
        learning_db_path=learning_db_path,
    )


DEFAULT_SETTINGS = load_settings()
