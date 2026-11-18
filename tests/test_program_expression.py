"""表达式字段与节点契约：无 fieldName 通过、额外字段被拒、端口缺口按现状记录。"""

from __future__ import annotations

import pytest

from backend.domain.program import ProgramError, validate_program


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


def number(block_id: str = "b-num", value: int = 3) -> dict:
    return node(block_id, "value.number", {"value": value})


def test_expression_field_clean_passes() -> None:
    root = node("b-print", "text.print", {"value": number()})
    stats = validate_program(program(root))
    assert stats.node_count == 2


def test_nested_calc_passes() -> None:
    calc = node(
        "b-calc",
        "value.calc",
        {"left": number("b-left", 1), "op": "+", "right": number("b-right", 2)},
    )
    root = node("b-print", "text.print", {"value": calc})
    stats = validate_program(program(root))
    assert stats.node_count == 4


def test_expression_field_with_field_name_rejected() -> None:
    expression = number()
    expression["fieldName"] = "value"
    root = node("b-print", "text.print", {"value": expression})
    with pytest.raises(ProgramError) as exc:
        validate_program(program(root))
    assert exc.value.code == "PROGRAM_SCHEMA_INVALID"


def test_empty_required_expression_rejected() -> None:
    """模型层允许编辑中间态为空；后端按 required 拒绝运行。"""
    root = node("b-print", "text.print", {"value": None})
    with pytest.raises(ProgramError) as exc:
        validate_program(program(root))
    assert exc.value.code == "PROGRAM_SCHEMA_INVALID"


def test_expression_node_in_next_is_currently_accepted() -> None:
    """存量缺口：后端未校验 next 端口类型，前端由 canConnect() 保证。

    本用例只固定当前行为，不代表这是正确行为。
    """
    root = node(
        "b-print",
        "text.print",
        {"value": number()},
        nxt=node("b-stray", "value.number", {"value": 5}),
    )
    stats = validate_program(program(root))
    assert stats.node_count == 3