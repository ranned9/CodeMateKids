"""DV-AI-02：程序摘要稳定、剔除布局/元数据、保留结构与执行顺序。"""

from __future__ import annotations

import copy

import pytest

from backend.service.program_digest import DigestError, digest_program
from tests.helpers import node, program


def _v2() -> dict:
    return {
        "format": "codematekids.program",
        "formatVersion": 2,
        "target": {"language": "python", "version": "3.12"},
        "courseRef": {"courseId": "demo-loop", "version": 1, "taskId": "main"},
        "stacks": [
            {
                "x": 10,
                "y": 20,
                "legacy": False,
                "root": node("b-start", "event.start", {}, nxt=node("b-move", "motion.move", {"steps": 1})),
            }
        ],
    }


def test_digest_is_stable_for_same_program() -> None:
    payload = _v2()
    assert digest_program(payload) == digest_program(copy.deepcopy(payload))


def test_layout_and_metadata_do_not_change_digest() -> None:
    payload = _v2()
    baseline = digest_program(payload)
    moved = copy.deepcopy(payload)
    moved["stacks"][0]["x"] = 300
    moved["stacks"][0]["y"] = 400
    assert digest_program(moved) == baseline

    with_metadata = copy.deepcopy(payload)
    with_metadata["metadata"] = {"createdAt": "2026-01-01", "updatedAt": "2026-11-20"}
    assert digest_program(with_metadata) == baseline


def test_structural_changes_do_change_digest() -> None:
    payload = _v2()
    baseline = digest_program(payload)

    changed_times = copy.deepcopy(payload)
    changed_times["stacks"][0]["root"]["next"]["inputs"]["steps"] = 2
    assert digest_program(changed_times) != baseline

    changed_id = copy.deepcopy(payload)
    changed_id["stacks"][0]["root"]["next"]["blockId"] = "b-move-2"
    assert digest_program(changed_id) != baseline

    changed_legacy = copy.deepcopy(payload)
    changed_legacy["stacks"][0]["legacy"] = True
    assert digest_program(changed_legacy) != baseline


def test_stack_order_changes_digest() -> None:
    payload = _v2()
    second = copy.deepcopy(payload["stacks"][0])
    second["root"] = node("b-start-2", "event.start", {}, nxt=node("b-move-2", "motion.move", {"steps": 4}))
    payload["stacks"].append(second)
    baseline = digest_program(payload)
    payload["stacks"].reverse()
    assert digest_program(payload) != baseline


def test_v1_program_supported() -> None:
    assert len(digest_program(program(node("b-start", "event.start", {})))) == 64


def test_invalid_program_raises_digest_error() -> None:
    with pytest.raises(DigestError):
        digest_program({"format": "other", "formatVersion": 1})
    with pytest.raises(DigestError):
        digest_program({"format": "codematekids.program", "formatVersion": 3})
    with pytest.raises(DigestError):
        digest_program({"format": "codematekids.program", "formatVersion": 2, "stacks": "bad"})
    with pytest.raises(DigestError):
        digest_program(None)