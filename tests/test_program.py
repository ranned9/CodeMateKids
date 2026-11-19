"""程序模型校验：格式、字段、规模、版本与深度。"""

from __future__ import annotations

import pytest

from backend.domain.program import (
    MAX_BYTES,
    ProgramError,
    json_depth,
    validate_program,
)


def node(block_id: str, kind: str, inputs: dict, body=None, nxt=None) -> dict:
    return {"blockId": block_id, "kind": kind, "inputs": inputs, "body": body or [], "next": nxt}


def program(root, **overrides) -> dict:
    data = {
        "format": "codematekids.program",
        "formatVersion": 1,
        "target": {"language": "python", "version": "3.12"},
        "courseRef": {"courseId": "demo-loop", "version": 1, "taskId": "main"},
        "root": root,
        "metadata": {"createdAt": "2026-11-14T00:00:00Z", "updatedAt": "2026-11-14T00:00:00Z"},
    }
    data.update(overrides)
    return data


def simple_root() -> dict:
    return node("b-start", "event.start", {}, nxt=node("b-move", "motion.move", {"steps": 1}))


def test_valid_program() -> None:
    stats = validate_program(program(simple_root()))
    assert stats.node_count == 2
    assert "向前走" in stats.summary


def test_missing_format_rejected() -> None:
    data = program(simple_root())
    data.pop("format")
    with pytest.raises(ProgramError) as exc:
        validate_program(data)
    assert exc.value.code == "PROGRAM_SCHEMA_INVALID"


def test_unsupported_format_version_rejected() -> None:
    with pytest.raises(ProgramError) as exc:
        validate_program(program(simple_root(), formatVersion=2))
    assert exc.value.code == "PROGRAM_SCHEMA_INVALID"


def test_target_version_locked() -> None:
    data = program(simple_root())
    data["target"] = {"language": "python", "version": "3.11"}
    with pytest.raises(ProgramError) as exc:
        validate_program(data)
    assert exc.value.code == "PYTHON_VERSION_MISMATCH"


@pytest.mark.parametrize("times", ["4", 2.5, 2.0, True])
def test_repeat_count_requires_integer(times) -> None:
    root = node(
        "b-start",
        "event.start",
        {},
        nxt=node("b-repeat", "control.repeat", {"times": times}, body=[node("b-move", "motion.move", {"steps": 1})]),
    )
    with pytest.raises(ProgramError) as exc:
        validate_program(program(root))
    assert exc.value.code == "PROGRAM_SCHEMA_INVALID"
    assert exc.value.block_id == "b-repeat"
    assert "整数" in exc.value.message


@pytest.mark.parametrize("times", [1, 100])
def test_repeat_count_accepts_integer_boundaries(times: int) -> None:
    root = node("b-repeat", "control.repeat", {"times": times})
    assert validate_program(program(root)).node_count == 1


def test_required_expression_missing_rejected() -> None:
    root = node("b-start", "event.start", {}, nxt=node("b-print", "text.print", {"value": None}))
    with pytest.raises(ProgramError) as exc:
        validate_program(program(root))
    assert exc.value.code == "PROGRAM_SCHEMA_INVALID"


def test_too_many_nodes_rejected() -> None:
    chain = node("b-many-500", "motion.move", {"steps": 1})
    for index in range(499, -1, -1):
        chain = node(f"b-many-{index}", "motion.move", {"steps": 1}, nxt=chain)
    with pytest.raises(ProgramError) as exc:
        validate_program(program(chain))
    assert exc.value.code == "PROGRAM_TOO_LARGE"


def test_too_deep_rejected() -> None:
    inner = node("b-deep-move", "motion.move", {"steps": 1})
    current = inner
    for depth in range(21):
        current = node(f"b-deep-{depth}", "control.repeat", {"times": 2}, body=[current])
    with pytest.raises(ProgramError) as exc:
        validate_program(program(current))
    assert exc.value.code == "PROGRAM_TOO_LARGE"


def test_oversized_serialization_rejected() -> None:
    data = program(simple_root())
    data["metadata"] = {"createdAt": "x" * (MAX_BYTES + 10), "updatedAt": "2026-11-14T00:00:00Z"}
    with pytest.raises(ProgramError) as exc:
        validate_program(data)
    assert exc.value.code == "PROGRAM_TOO_LARGE"


def test_json_depth_limit() -> None:
    deep: dict = {}
    cursor = deep
    for index in range(40):
        child: dict = {}
        cursor["level"] = child
        cursor = child
    assert json_depth(deep) > 32
    data = program(simple_root())
    data["metadata"] = deep
    with pytest.raises(ProgramError) as exc:
        validate_program(data)
    assert exc.value.code == "PROGRAM_TOO_LARGE"


def test_duplicate_block_id_rejected() -> None:
    root = node("b-same", "event.start", {}, nxt=node("b-same", "motion.move", {"steps": 1}))
    with pytest.raises(ProgramError) as exc:
        validate_program(program(root))
    assert exc.value.code == "PROGRAM_SCHEMA_INVALID"


def test_unknown_kind_blocked() -> None:
    root = node("b-unknown", "python.class", {})
    with pytest.raises(ProgramError) as exc:
        validate_program(program(root))
    assert exc.value.code == "PYTHON_FEATURE_BLOCKED"
    assert exc.value.block_id == "b-unknown"

def test_source_code_field_rejected() -> None:
    data = program(simple_root())
    data["sourceCode"] = "print('hello')"
    with pytest.raises(ProgramError) as exc:
        validate_program(data)
    assert exc.value.code == "PROGRAM_SCHEMA_INVALID"
