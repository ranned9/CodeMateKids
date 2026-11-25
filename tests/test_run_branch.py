"""条件分支的运行、单步和输入校验。"""

import threading

import pytest

from backend.domain.program import ProgramError, validate_program
from backend.runner.supervisor import run_program
from tests.helpers import node, program


LIMITS = {"wallTimeMs": 3000, "memoryMb": 128, "maxOutputBytes": 16384, "maxRecursionDepth": 200}


@pytest.mark.parametrize("steps,heading", [(0, 270), (1, 90)])
@pytest.mark.parametrize("debug", [False, True])
def test_only_the_matching_branch_runs(steps, heading, debug):
    condition = node("if", "control.if", {"operator": ">=", "threshold": 1}, body=[
        node("left", "motion.turn", {"degrees": 90}),
    ])
    fallback = node("else", "control.else", {}, body=[node("right", "motion.turn", {"degrees": 270})])
    repeat = node("loop", "control.repeat", {"times": 1}, body=[condition, fallback, node("last", "motion.move", {})])
    entry = node("first", "motion.move", {}, nxt=repeat) if steps else repeat
    payload = program(node("start", "event.start", {}, nxt=entry))
    frames = []
    pending = None

    def on_frame(frame):
        nonlocal pending
        frames.append(frame)
        if frame.get("kind") == "block_enter":
            pending = frame["seq"]

    def advance():
        nonlocal pending
        seq, pending = pending, None
        return seq

    result = run_program(payload, LIMITS, "run-branch", threading.Event(), on_frame,
                         take_step=advance if debug else None)
    assert result["status"] == "completed", result["error"]
    stage = result["objects"][0]
    assert (stage["steps"], stage["heading"], stage["y"]) == (steps + 1, heading, 1 if steps else -1)
    branch_entries = [frame["blockId"] for frame in frames
                      if frame.get("kind") == "block_enter" and frame["blockId"] in {"if", "else", "left", "right"}]
    assert branch_entries == (["if", "left"] if steps else ["if", "else", "right"])


def test_else_needs_if_at_same_level():
    root = node("if", "control.if", {"operator": "==", "threshold": 1}, body=[node("else", "control.else", {})])
    validate_program(program(root), enforce_runnable=False)
    with pytest.raises(ProgramError) as error:
        validate_program(program(root))
    assert error.value.block_id == "else"


def test_if_rejects_an_unknown_comparison():
    root = node("if", "control.if", {"operator": "?", "threshold": 1})
    with pytest.raises(ProgramError) as error:
        validate_program(program(root))
    assert error.value.block_id == "if"
