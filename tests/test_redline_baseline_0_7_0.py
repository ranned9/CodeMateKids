"""0.7.0 红线基线：既有错误码、协议、程序模型与依赖零变更。

基线取自 2026-11-21 当前工作树。TQ-02 放行并追加新错误码时，
必须同步更新本文件的 `BASELINE_ERROR_CODES` 并在
`decisions-ai-teacher-memory-0.7.0.md` 登记。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.domain import program
from backend.infra.errors import ERROR_SPECS, ErrorSpec, error_object

ROOT = Path(__file__).resolve().parent.parent

BASELINE_ERROR_CODES = {
    "BAD_TAIL",
    "CANCEL_TOKEN_MISMATCH",
    "COURSE_VERSION_UNSUPPORTED",
    "DEMO_LIMIT_REACHED",
    "EDITOR_INVALID_CONNECTION",
    "FORBIDDEN",
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
    "TASK_NOT_RUNNABLE",
    "TUTOR_UNAVAILABLE",
}

BASELINE_ERROR_OBJECT_KEYS = {
    "code",
    "category",
    "messageForChild",
    "blockId",
    "recoverable",
}

BASELINE_ERROR_SPEC_FIELDS = {
    "category",
    "http_status",
    "message_for_child",
    "recoverable",
}

BASELINE_SCHEMAS = {
    "schemas/tutor_protocol.v1.json": {
        "top": {"$defs", "$id", "$schema", "title", "type"},
        "defs": {"actions", "learnerChoices", "tutorRequest", "tutorResponse"},
        "additionalProperties": None,
        "required": None,
    },
    "schemas/run_protocol.v1.json": {
        "top": {"$defs", "$id", "$schema", "title", "type"},
        "defs": {"runRequest", "runResult"},
        "additionalProperties": None,
        "required": None,
    },
    "schemas/program.v1.json": {
        "top": {
            "$defs",
            "$id",
            "$schema",
            "additionalProperties",
            "properties",
            "required",
            "title",
            "type",
        },
        "defs": {"blockNode"},
        "additionalProperties": False,
        "required": ["format", "formatVersion", "target", "courseRef", "root", "metadata"],
    },
    "schemas/program.v2.json": {
        "top": {
            "$id",
            "$schema",
            "additionalProperties",
            "properties",
            "required",
            "title",
            "type",
        },
        "defs": set(),
        "additionalProperties": False,
        "required": [
            "format",
            "formatVersion",
            "target",
            "courseRef",
            "stacks",
            "metadata",
        ],
    },
}

BASELINE_PROGRAM_ENTRYPOINTS = {
    "ProgramError",
    "ProgramStats",
    "evaluate_criteria",
    "json_depth",
    "number_input_value",
    "program_json_depth_limit",
    "program_roots",
    "summarize_program",
    "validate_program",
}

BASELINE_REQUIREMENTS = {"fastapi", "httpx", "pydantic", "pytest", "uvicorn"}

PACKAGE_DEPENDENCY_FIELDS = {
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
}


def _schema(name: str) -> dict:
    return json.loads((ROOT / name).read_text(encoding="utf-8"))


def _requirement_names() -> set[str]:
    names: set[str] = set()
    for raw in (ROOT / "requirements.txt").read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        name = line.split(";")[0].split("=")[0].split("<")[0].split(">")[0].split("[")[0]
        names.add(name.strip().lower())
    return names


def test_error_spec_keys_unchanged() -> None:
    assert set(ERROR_SPECS) == BASELINE_ERROR_CODES | {
        "TUTOR_TURN_BUSY", "TUTOR_TURN_CONFLICT", "STUDENT_NOT_FOUND", "LEARNING_STORE_UNAVAILABLE",
    }
    assert len(BASELINE_ERROR_CODES) == 28


def test_error_object_keys_unchanged() -> None:
    payload = error_object("TUTOR_UNAVAILABLE", "b-1")
    assert set(payload) == BASELINE_ERROR_OBJECT_KEYS
    assert payload["blockId"] == "b-1"


def test_error_spec_has_no_developer_fields() -> None:
    assert set(ErrorSpec.__dataclass_fields__) == BASELINE_ERROR_SPEC_FIELDS


@pytest.mark.parametrize("name", sorted(BASELINE_SCHEMAS))
def test_schema_keys_unchanged(name: str) -> None:
    schema = _schema(name)
    baseline = BASELINE_SCHEMAS[name]
    assert set(schema) == baseline["top"]
    assert set(schema.get("$defs", {})) == baseline["defs"]
    assert schema.get("additionalProperties") == baseline["additionalProperties"]
    assert schema.get("required") == baseline["required"]


def test_program_public_entrypoints_unchanged() -> None:
    actual = {item for item in dir(program) if not item.startswith("_")}
    assert BASELINE_PROGRAM_ENTRYPOINTS <= actual


def test_requirements_have_no_new_dependency() -> None:
    assert _requirement_names() == BASELINE_REQUIREMENTS
    assert "sqlite3" not in _requirement_names()


def test_frontend_package_has_no_dependency() -> None:
    package = json.loads((ROOT / "frontend" / "package.json").read_text(encoding="utf-8"))
    assert not (PACKAGE_DEPENDENCY_FIELDS & set(package))
    assert package.get("type") == "module"
