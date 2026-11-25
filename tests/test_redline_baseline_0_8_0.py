"""0.8.0 红线基线：32+3 键码表、16+1 字段白名单、协议 schema 与依赖增量边界。

基线取自 2026-11-25 当前工作树。P1 语音增量后按 D-02/D-06 放行口径更新为
32+3（语音错误码）与 16+1（cloudTraceId），并在 decisions-ai-voice-0.8.0.md 登记。
"""

from __future__ import annotations

import json
from pathlib import Path

from backend.infra.errors import ERROR_SPECS
from backend.infra.logging import ALLOWED_FIELDS

ROOT = Path(__file__).resolve().parent.parent

BASELINE_ERROR_CODES = {
    "BAD_TAIL",
    "CANCEL_TOKEN_MISMATCH",
    "COURSE_VERSION_UNSUPPORTED",
    "DEMO_LIMIT_REACHED",
    "EDITOR_INVALID_CONNECTION",
    "FORBIDDEN",
    "LEARNING_STORE_UNAVAILABLE",
    "MATRIX_INVALID",
    "PREDICTION_INVALID",
    "PREDICTION_REQUIRED",
    "PROGRAM_MIGRATION_FAILED",
    "PROGRAM_SCHEMA_INVALID",
    "PROGRAM_TOO_LARGE",
    "PYTHON_COMPILE_ERROR",
    "PYTHON_FEATURE_BLOCKED",
    "PYTHON_RUNTIME_ERROR",
    "PYTHON_VERSION_MISMATCH",
    "RUNNER_CRASHED",
    "RUNNER_UNAVAILABLE",
    "RUN_CANCELLED",
    "RUN_ID_CONFLICT",
    "RUN_IN_PROGRESS",
    "RUN_NOT_FOUND",
    "RUN_REQUEST_INVALID",
    "RUN_RESOURCE_LIMIT",
    "RUN_START_FAILED",
    "RUN_TIMEOUT",
    "STUDENT_NOT_FOUND",
    "TASK_NOT_RUNNABLE",
    "TUTOR_TURN_BUSY",
    "TUTOR_TURN_CONFLICT",
    "TUTOR_UNAVAILABLE",
}

SPEECH_ERROR_CODES = {
    "SPEECH_UNAVAILABLE",
    "SPEECH_PAYLOAD_TOO_LARGE",
    "SPEECH_AUDIO_INVALID",
}

BASELINE_ALLOWED_FIELDS = {
    "ts",
    "event",
    "requestId",
    "protocolVersion",
    "schemaVersion",
    "contentVersion",
    "category",
    "durationMs",
    "matrixCaseId",
    "appVersion",
    "pythonVersion",
    "stderrSummary",
    "level",
    "modelSource",
    "modelRevision",
    "modelCategory",
}

BASELINE_REQUIREMENTS = {"fastapi", "httpx", "pydantic", "pytest", "uvicorn", "huaweicloudsdksis"}


def _requirement_names() -> set[str]:
    names: set[str] = set()
    for raw in (ROOT / "requirements.txt").read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        name = line.split(";")[0].split("=")[0].split("<")[0].split(">")[0].split("[")[0]
        names.add(name.strip().lower())
    return names


def test_error_codes_final_baseline() -> None:
    assert set(ERROR_SPECS) == BASELINE_ERROR_CODES | SPEECH_ERROR_CODES
    assert len(BASELINE_ERROR_CODES) == 32
    assert len(SPEECH_ERROR_CODES) == 3


def test_speech_codes_never_used_outside_speech_module() -> None:
    speech_router = (ROOT / "backend" / "api" / "routers" / "speech.py").read_text(encoding="utf-8")
    speech_service = (ROOT / "backend" / "service" / "speech.py").read_text(encoding="utf-8")
    for name in sorted(SPEECH_ERROR_CODES):
        for path in ROOT.glob("backend/**/*.py"):
            if "speech" in str(path) or path.name == "errors.py":
                continue
            text = path.read_text(encoding="utf-8")
            assert name not in text, f"{name} leaked into {path}"
    assert "SPEECH_UNAVAILABLE" in speech_router
    assert "SPEECH_UNAVAILABLE" in speech_service or "SpeechServiceError" in speech_service


def test_logging_whitelist_final_baseline() -> None:
    assert set(ALLOWED_FIELDS) == BASELINE_ALLOWED_FIELDS | {"cloudTraceId"}
    assert len(BASELINE_ALLOWED_FIELDS) == 16


def test_run_protocol_schema_unchanged() -> None:
    schema = json.loads((ROOT / "schemas" / "run_protocol.v1.json").read_text(encoding="utf-8"))
    assert set(schema) == {"$defs", "$id", "$schema", "title", "type"}
    assert set(schema.get("$defs", {})) == {"runRequest", "runResult"}


def test_requirements_only_sis_increment() -> None:
    assert _requirement_names() == BASELINE_REQUIREMENTS


def test_lock_file_pins_sis_version() -> None:
    lock_lines = (ROOT / "requirements.lock.txt").read_text(encoding="utf-8").splitlines()
    sis_lines = [line for line in lock_lines if line.strip().startswith("huaweicloudsdksis==")]
    assert len(sis_lines) == 1