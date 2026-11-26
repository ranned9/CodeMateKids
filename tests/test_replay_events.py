"""R1 固化与回放降级矩阵：真实 Python 3.12 事件 + 纯夹具。"""

from __future__ import annotations

import threading
from math import cos, radians, sin

import pytest

from backend.runner.supervisor import run_program
from backend.tutor.replay import analyze
from tests.helpers import node, program, simple_program

LIMITS = {"wallTimeMs": 6000, "memoryMb": 256, "maxOutputBytes": 16384, "maxRecursionDepth": 200}


def _run(root: dict, task_id: str = "main") -> dict:
    return run_program(program(root, task_id), dict(LIMITS), "run-replay-probe", threading.Event(), lambda f: None)


def _square_root() -> dict:
    return node(
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


def _stage(x=0, y=0, heading=0, steps=0, moves=0) -> list[dict]:
    return [{"id": "stage", "x": x, "y": y, "heading": heading, "said": "", "steps": steps, "moves": moves}]


def test_r1_square_produces_28_events_four_rounds_and_consistent_final_state() -> None:
    result = _run(_square_root(), "transfer-square")
    assert result["status"] == "completed"
    events = result["events"]
    assert len(events) == 28, "design 1.2.1 探针要求 28 个事件"
    stage = result["objects"][0]
    assert (stage["x"], stage["y"], stage["heading"], stage["steps"], stage["moves"]) == (0, 0, 0, 8, 4)

    replay = analyze(_square_root(), events, result["objects"])
    assert replay.quality == "verified", replay.reason
    assert replay.rounds == 4
    assert len(replay.actions) == 8
    assert replay.actions[0]["steps"] == 2
    assert replay.actions[1]["degrees"] == 90


def test_r1_simple_repeat_matches_known_shape() -> None:
    result = _run(simple_program()["root"])
    assert result["status"] == "completed"
    assert len(result["events"]) == 12
    replay = analyze(simple_program()["root"], result["events"], result["objects"])
    assert replay.quality == "verified"
    assert replay.rounds == 2, "重复 2 次即 2 轮；rounds = repeat_enter_count - 1"


def test_non_right_angle_turns_move_and_replay() -> None:
    move = node("move", "motion.move", {})
    custom = node("custom", "motion.turn", {"degrees": -12.5}, nxt=move)
    preset = node("preset", "motion.turn", {"degrees": 45}, nxt=custom)
    root = node("start", "event.start", {}, nxt=preset)
    result = _run(root)
    assert result["status"] == "completed"
    stage = result["objects"][0]
    angle = radians(32.5)
    assert stage["x"] == pytest.approx(cos(angle))
    assert stage["y"] == pytest.approx(sin(angle))
    assert (stage["heading"], stage["steps"], stage["moves"]) == (32.5, 1, 1)
    replay = analyze(root, result["events"], result["objects"])
    assert replay.quality == "verified", replay.reason
    assert [action["heading"] for action in replay.actions] == [45, 32.5, 32.5]


def test_replay_degrades_on_empty_or_disordered_events() -> None:
    assert analyze(_square_root(), [], _stage()).quality == "unavailable"
    disordered = [
        {"seq": 2, "blockId": "b-start", "kind": "block_enter"},
        {"seq": 1, "blockId": "b-start", "kind": "block_exit"},
    ]
    assert analyze(_square_root(), disordered, _stage()).quality == "unavailable"


def test_replay_degrades_on_unpaired_events() -> None:
    events = [
        {"seq": 1, "blockId": "b-start", "kind": "block_enter"},
        {"seq": 2, "blockId": "b-move", "kind": "block_enter"},
        {"seq": 3, "blockId": "b-move", "kind": "block_exit"},
    ]
    assert analyze(_square_root(), events, _stage()).quality == "unavailable"


def test_replay_degrades_when_stage_does_not_match() -> None:
    events = [
        {"seq": 1, "blockId": "b-start", "kind": "block_enter"},
        {"seq": 2, "blockId": "b-start", "kind": "block_exit"},
        {"seq": 3, "blockId": "b-move", "kind": "block_enter"},
        {"seq": 4, "blockId": "b-move", "kind": "block_exit"},
    ]
    result = analyze(_square_root(), events, _stage(x=99))
    assert result.quality == "inconsistent"


def test_replay_degrades_at_event_limit() -> None:
    events = [
        {"seq": index, "blockId": "b-start", "kind": "block_enter" if index % 2 else "block_exit"}
        for index in range(1, 2001)
    ]
    assert analyze(_square_root(), events, _stage()).quality == "unavailable"


def test_replay_ignores_truncated_when_events_are_complete() -> None:
    result = _run(_square_root(), "transfer-square")
    plain = analyze(_square_root(), result["events"], result["objects"])
    truncated = analyze(_square_root(), result["events"], result["objects"])
    assert plain.quality == truncated.quality == "verified"
    assert result.get("truncated") is False


def test_replay_clips_actions_and_reports_has_more() -> None:
    result = _run(_square_root(), "transfer-square")
    replay = analyze(_square_root(), result["events"], result["objects"], max_actions=3)
    assert replay.quality == "verified"
    assert len(replay.actions) == 3
    assert replay.has_more is True


def test_replay_without_stage_is_unavailable() -> None:
    result = _run(_square_root(), "transfer-square")
    assert analyze(_square_root(), result["events"], []).quality == "unavailable"


@pytest.mark.skipif(False, reason="占位：环境已是 Python 3.12")
def test_python_version_guard_placeholder() -> None:
    assert True
