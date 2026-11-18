"""二次白名单：拒绝类/导入，错误优先级与 blockId 定位。"""

from __future__ import annotations

import ast
import json
import threading
from pathlib import Path

import pytest

from backend.domain.program import ProgramError, validate_program
from backend.runner import worker as worker_mod
from backend.runner.compiler import CompiledProgram, TARGET_FILENAME, compile_program
from backend.runner.policy import check_module, check_source

ROOT = Path(__file__).resolve().parents[1]


def course_program() -> dict:
    with open(ROOT / "content" / "demo-loop" / "course.json", "r", encoding="utf-8") as handle:
        course = json.load(handle)
    return course["tasks"][0]["initialProgram"]


def test_class_definition_rejected() -> None:
    violations = check_source("class Sneaky:\n    pass\n")
    assert violations
    assert violations[0].node_type == "ClassDef"


def test_import_and_from_import_rejected() -> None:
    assert check_source("import os\n")[0].node_type == "Import"
    assert check_source("from os import path\n")[0].node_type == "ImportFrom"


def test_dangerous_builtin_rejected() -> None:
    violations = check_source("exec('print(1)')\n")
    assert violations
    assert violations[0].node_type == "Call"


def test_compiled_course_is_clean() -> None:
    compiled = compile_program(course_program())
    assert compiled.source
    assert check_module(compiled.module, compiled.line_map) == []


def test_violation_carries_block_id() -> None:
    module = ast.parse("class Sneaky:\n    pass\n", filename=TARGET_FILENAME)
    violations = check_module(module, {1: "b-evil"})
    assert violations[0].block_id == "b-evil"


def test_worker_blocks_fake_class_model(monkeypatch) -> None:
    source = "class Sneaky:\n    pass\n"
    fake = CompiledProgram(
        source=source,
        module=ast.parse(source, filename=TARGET_FILENAME),
        line_map={1: "b-evil"},
        block_lines={"b-evil": (1, 2)},
    )
    monkeypatch.setattr(worker_mod, "compile_program", lambda program, registry=None: fake)
    frame = {
        "type": "run",
        "protocolVersion": 1,
        "requestId": "run-policy",
        "program": course_program(),
        "limits": {"wallTimeMs": 3000, "memoryMb": 128, "maxOutputBytes": 16384, "maxRecursionDepth": 200},
        "target": {"language": "python", "version": "3.12"},
    }
    result = worker_mod.execute(frame, threading.Event())
    assert result["status"] == "failed"
    assert result["error"]["code"] == "PYTHON_FEATURE_BLOCKED"
    assert result["error"]["blockId"] == "b-evil"


def test_validation_error_priority(monkeypatch) -> None:
    called = {"value": False}

    def should_not_run(program, registry=None):
        called["value"] = True
        raise AssertionError("策略校验不应在模型校验之前执行")

    monkeypatch.setattr(worker_mod, "compile_program", should_not_run)
    broken = course_program()
    broken["root"]["next"]["inputs"]["times"] = "两个"
    frame = {
        "type": "run",
        "protocolVersion": 1,
        "requestId": "run-priority",
        "program": broken,
        "limits": {"wallTimeMs": 3000, "memoryMb": 128, "maxOutputBytes": 16384, "maxRecursionDepth": 200},
        "target": {"language": "python", "version": "3.12"},
    }
    result = worker_mod.execute(frame, threading.Event())
    assert result["status"] == "failed"
    assert result["error"]["code"] == "PROGRAM_SCHEMA_INVALID"
    assert called["value"] is False


def test_validate_program_raises_before_policy() -> None:
    broken = course_program()
    broken["target"] = {"language": "python", "version": "3.11"}
    with pytest.raises(ProgramError) as exc:
        validate_program(broken)
    assert exc.value.code == "PYTHON_VERSION_MISMATCH"

def test_run_request_with_source_code_is_rejected(client) -> None:
    client.post("/api/v1/session/prediction", json={"taskId": "main", "value": 2})
    program = course_program()
    program["sourceCode"] = "print('hello')"
    body = {
        "protocolVersion": 1,
        "requestId": "run-source-code",
        "cancelToken": "token-source",
        "target": {"language": "python", "version": "3.12"},
        "program": program,
        "courseRef": program["courseRef"],
        "taskId": "main",
        "mode": "demo",
    }
    response = client.post("/api/v1/runs", json=body)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "PROGRAM_SCHEMA_INVALID"
