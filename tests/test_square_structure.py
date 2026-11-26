"""DV-AI-06：正方形结构判定（不含 success 门控）。"""

from __future__ import annotations

import pytest

from backend.tutor.square import inspect
from tests.helpers import node


def _square(times=4, steps=2, degrees=90, body_extra=None) -> dict:
    body = [node("b-move", "motion.move", {"steps": steps}), node("b-turn", "motion.turn", {"degrees": degrees})]
    body.extend(body_extra or [])
    return node(
        "b-start",
        "event.start",
        {},
        nxt=node("b-repeat", "control.repeat", {"times": times}, body=body),
    )


def test_correct_loop_structure_met() -> None:
    report = inspect(_square())
    assert report.structure_met is True
    assert report.single_repeat is True
    assert report.repeat_times == 4
    assert report.steps_per_move == 2
    assert report.turn_degrees == 90
    assert report.outside_moves == 0


@pytest.mark.parametrize(("degrees", "normalized", "met"), [
    (-90, 270, True), (450, 90, True), (-450.0, 270, True), (90.5, 90.5, False), (270.5, 270.5, False),
])
def test_turn_structure_uses_the_same_angle_as_the_stage(degrees, normalized, met) -> None:
    report = inspect(_square(degrees=degrees))
    assert report.turn_degrees == normalized
    assert report.structure_met is met


def test_removing_turn_breaks_structure() -> None:
    root = node(
        "b-start",
        "event.start",
        {},
        nxt=node("b-repeat", "control.repeat", {"times": 4}, body=[node("b-move", "motion.move", {"steps": 2})]),
    )
    report = inspect(root)
    assert report.structure_met is False
    assert "loop_body_not_square" in report.reasons


def test_four_handwritten_moves_are_not_structure_met() -> None:
    chain = None
    for index in range(4):
        chain = node(f"b-move-{index}", "motion.move", {"steps": 2}, nxt=chain)
        chain = node(f"b-turn-{index}", "motion.turn", {"degrees": 90}, nxt=chain)
    root = node("b-start", "event.start", {}, nxt=chain)
    report = inspect(root)
    assert report.structure_met is False
    assert "no_repeat" in report.reasons
    assert report.outside_moves == 8


def test_numeric_blocks_and_270_are_supported() -> None:
    root = node(
        "b-start",
        "event.start",
        {},
        nxt=node(
            "b-repeat",
            "control.repeat",
            {"times": node("b-times", "value.number", {"value": 4})},
            body=[
                node("b-move", "motion.move", {"steps": node("b-steps", "value.number", {"value": 2})}),
                node("b-turn", "motion.turn", {"degrees": 270}),
            ],
        ),
    )
    report = inspect(root)
    assert report.structure_met is True
    assert report.repeat_times == 4
    assert report.steps_per_move == 2
    assert report.turn_degrees == 270


def test_harmless_outside_actions_do_not_break_structure() -> None:
    root = node(
        "b-start",
        "event.start",
        {},
        nxt=node(
            "b-repeat",
            "control.repeat",
            {"times": 4},
            body=[
                node("b-move", "motion.move", {"steps": 2}),
                node("b-turn", "motion.turn", {"degrees": 90}),
            ],
        ),
    )
    root["next"]["next"] = node("b-say", "look.say", {"text": "你好"})
    report = inspect(root)
    assert report.outside_moves == 0
    assert report.structure_met is True


def test_move_outside_loop_breaks_structure() -> None:
    root = _square()
    root["next"]["next"] = node("b-extra", "motion.move", {"steps": 2})
    report = inspect(root)
    assert report.outside_moves == 1
    assert report.structure_met is False
    assert "moves_outside_loop" in report.reasons


def test_multiple_repeats_and_nesting_are_rejected() -> None:
    root = _square()
    root["next"]["next"] = node(
        "b-repeat-2",
        "control.repeat",
        {"times": 2},
        body=[node("b-move-2", "motion.move", {"steps": 1})],
    )
    report = inspect(root)
    assert report.structure_met is False
    assert "multiple_repeats" in report.reasons

    nested = node(
        "b-start",
        "event.start",
        {},
        nxt=node(
            "b-repeat",
            "control.repeat",
            {"times": 4},
            body=[
                node(
                    "b-inner",
                    "control.repeat",
                    {"times": 2},
                    body=[node("b-move", "motion.move", {"steps": 1})],
                )
            ],
        ),
    )
    assert inspect(nested).structure_met is False
    assert "nested_repeat" in inspect(nested).reasons


def test_empty_program_is_not_structure_met() -> None:
    assert inspect(None).structure_met is False
    assert inspect(None).reasons == ["empty_program"]
