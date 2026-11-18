"""配置分级读取：默认安全配置 < 本地开发配置 < 受保护凭据。

模型凭据只从环境变量读取，进入进程内存后不写入任何文件、响应或日志。
"""

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
    )


DEFAULT_SETTINGS = load_settings()