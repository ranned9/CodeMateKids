"""表达式字段、草稿保存与连接端口校验。"""

from __future__ import annotations

import pytest

from backend.domain.program import ProgramError, validate_program
from tests.helpers import drain, submit


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


@pytest.mark.parametrize("location", ["root", "next", "body"])
def test_expression_node_rejected_in_statement_positions(location: str) -> None:
    stray = number("b-stray", 5)
    root = {
        "root": stray,
        "next": node("b-start", "event.start", {}, nxt=stray),
        "body": node("b-loop", "control.repeat", {"times": 2}, body=[stray]),
    }[location]
    with pytest.raises(ProgramError) as exc:
        validate_program(program(root))
    assert exc.value.code == "PROGRAM_SCHEMA_INVALID"
    assert exc.value.block_id == "b-stray"


def test_empty_required_expression_is_allowed_in_project_draft() -> None:
    root = node("b-print", "text.print", {"value": None})
    assert validate_program(program(root), enforce_runnable=False).node_count == 1


def test_expression_project_roundtrip_and_execution(client) -> None:
    root = node("b-print", "text.print", {"value": None})
    data = program(root)
    draft = client.post("/api/v1/projects/save", json={"program": data, "courseRef": data["courseRef"]})
    assert draft.status_code == 200
    loaded_draft = client.post("/api/v1/projects/load", json={"fileText": draft.json()["data"]["fileText"]})
    assert loaded_draft.status_code == 200
    assert loaded_draft.json()["data"]["program"]["root"]["inputs"]["value"] is None

    inner = node("b-inner", "value.calc", {"left": number("b-three", 3), "op": "+", "right": number("b-four", 4)})
    root["inputs"]["value"] = node("b-outer", "value.calc", {"left": number("b-two", 2), "op": "+", "right": inner})
    saved = client.post("/api/v1/projects/save", json={"program": data, "courseRef": data["courseRef"]})
    loaded = client.post("/api/v1/projects/load", json={"fileText": saved.json()["data"]["fileText"]})
    assert loaded.json()["data"]["program"]["root"] == root
    assert client.post("/api/v1/session/prediction", json={"taskId": "main", "value": 0}).status_code == 200
    assert submit(client, loaded.json()["data"]["program"], "run-nested-expression").status_code == 200
    _, result = drain(client, "run-nested-expression")
    assert result["status"] == "completed"
    assert result["stdout"] == "9\n"


@pytest.mark.parametrize("value", [0, 1.5, 101])
def test_number_block_in_repeat_uses_count_limits(value) -> None:
    root = node("b-loop", "control.repeat", {"times": number(value=value)})
    with pytest.raises(ProgramError) as exc:
        validate_program(program(root), enforce_runnable=False)
    assert exc.value.code == "PROGRAM_SCHEMA_INVALID"
    assert exc.value.block_id == "b-num"


@pytest.mark.parametrize(("kind", "field", "value"), [
    ("motion.move", "steps", 0),
    ("motion.move", "steps", 1.5),
    ("motion.move", "steps", 101),
    ("motion.turn", "degrees", 45),
    ("motion.turn", "degrees", 90.5),
])
def test_number_block_respects_motion_parameter_limits(kind, field, value) -> None:
    with pytest.raises(ProgramError) as exc:
        validate_program(program(node("b-action", kind, {field: number(value=value)})))
    assert exc.value.block_id == "b-num"


def test_motion_number_blocks_roundtrip_and_execution(client) -> None:
    turn = node("b-turn", "motion.turn", {"degrees": number("b-angle", 90)})
    move = node("b-move", "motion.move", {"steps": number("b-steps", 3)}, nxt=turn)
    loop = node("b-repeat", "control.repeat", {"times": number("b-times", 2)}, body=[move])
    data = program(node("b-start", "event.start", {}, nxt=loop))
    saved = client.post("/api/v1/projects/save", json={"program": data, "courseRef": data["courseRef"]})
    assert saved.status_code == 200
    loaded = client.post("/api/v1/projects/load", json={"fileText": saved.json()["data"]["fileText"]})
    assert loaded.status_code == 200
    reopened = loaded.json()["data"]["program"]
    assert reopened["root"] == data["root"]
    assert client.post("/api/v1/session/prediction", json={"taskId": "main", "value": 2}).status_code == 200
    assert submit(client, reopened, "run-motion-number-blocks").status_code == 200
    _, result = drain(client, "run-motion-number-blocks")
    assert result["status"] == "completed"
    stage = next(item for item in result["objects"] if item["id"] == "stage")
    assert (stage["x"], stage["y"], stage["moves"], stage["steps"], stage["heading"]) == (3, 3, 2, 6, 180)


def test_repeat_number_block_roundtrip_and_execution(client) -> None:
    printer = node("b-print", "text.print", {"value": number("b-output", 7)})
    loop = node("b-loop", "control.repeat", {"times": number("b-count", 3)}, body=[printer])
    root = node("b-start", "event.start", {}, nxt=loop)
    data = program(None, formatVersion=2, stacks=[{"x": 20, "y": 25, "root": root}])
    del data["root"]
    saved = client.post("/api/v1/projects/save", json={"program": data, "courseRef": data["courseRef"]})
    assert saved.status_code == 200
    loaded = client.post("/api/v1/projects/load", json={"fileText": saved.json()["data"]["fileText"]})
    assert loaded.status_code == 200
    reopened = loaded.json()["data"]["program"]
    assert reopened["stacks"] == data["stacks"]
    assert "重复 3 次" in validate_program(reopened).summary

    assert client.post("/api/v1/session/prediction", json={"taskId": "main", "value": 0}).status_code == 200
    assert submit(client, reopened, "run-number-block-repeat").status_code == 200
    _, result = drain(client, "run-number-block-repeat")
    assert result["status"] == "completed"
    assert result["stdout"] == "7\n" * 3
