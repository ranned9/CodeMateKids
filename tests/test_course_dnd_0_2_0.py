"""0.2.0 课程内容收窄：两个任务只保留 5 个有落点的语句积木。"""

from __future__ import annotations

import json
import re
from pathlib import Path

from backend.domain.blocks import load_blocks

ROOT = Path(__file__).resolve().parents[1]
COURSE_PATH = ROOT / "content" / "demo-loop" / "course.json"
EXPECTED_KINDS = {
    "event.start",
    "control.repeat",
    "motion.move",
    "motion.turn",
    "look.say",
}


def course() -> dict:
    return json.loads(COURSE_PATH.read_text(encoding="utf-8"))


def tasks() -> list[dict]:
    return course()["tasks"]


def test_allowed_kinds_narrowed() -> None:
    for task in tasks():
        kinds = set(task["allowedBlockKinds"])
        assert kinds == EXPECTED_KINDS, task["taskId"]
        assert not any(kind.startswith("value.") for kind in kinds), task["taskId"]


def test_allowed_kinds_all_runnable() -> None:
    registry = load_blocks(ROOT / "schemas" / "blocks.v1.json")
    for task in tasks():
        for kind in task["allowedBlockKinds"]:
            definition = registry.get(kind)
            assert definition is not None, kind
            assert definition.runnable, kind


def test_content_version_incremented() -> None:
    value = course()["contentVersion"]
    assert re.match(r"^\d+\.\d+\.\d+$", value)
    parts = tuple(int(item) for item in value.split("."))
    assert parts > (1, 0, 0)


def test_value_blocks_definition_retained() -> None:
    registry = load_blocks(ROOT / "schemas" / "blocks.v1.json")
    number = registry.get("value.number")
    calc = registry.get("value.calc")
    assert number is not None and number.output_type == "expression"
    assert calc is not None and calc.output_type == "expression"
    assert {field["name"] for field in number.fields} == {"value"}
    assert {field["name"] for field in calc.fields} == {"left", "op", "right"}