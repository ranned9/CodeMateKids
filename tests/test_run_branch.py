"""条件分支的运行、单步和输入校验。"""

import threading

import pytest

from backend.domain.program import ProgramError, validate_program
from backend.runner.supervisor import run_program
from tests.helpers import drain, node, program, submit


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


@pytest.mark.parametrize("attempt", ["correct", "unguarded", "early", "never_taken", "extra_turn"])
def test_crossroad_lesson_checks_route_and_executed_condition(client, attempt):
    task_id = "branch-crossroad"
    body = client.get("/api/v1/course").json()["data"]
    task = next(task for task in body["tasks"] if task["taskId"] == task_id)
    payload = task["initialProgram"]
    loop = payload["root"]["next"]
    turn = node("corner-turn", "motion.turn", {"degrees": 90})
    if attempt == "unguarded":
        loop["inputs"]["times"] = 3
        loop["next"] = {**turn, "next": node("after-corner", "control.repeat", {"times": 2}, body=[
            node("after-corner-move", "motion.move", {}),
        ])}
    else:
        threshold = {"early": 2, "never_taken": 6}.get(attempt, 3)
        loop["body"].append(node("at-corner", "control.if", {"operator": "==", "threshold": threshold}, body=[turn]))
        if attempt == "extra_turn":
            loop["next"] = node("extra-spin", "motion.turn", {"degrees": 360})

    assert client.post("/api/v1/session/prediction", json={"taskId": task_id, "value": 5}).status_code == 200
    request_id = f"run-crossroad-{attempt}"
    assert submit(client, payload, request_id).status_code == 200
    _, result = drain(client, request_id)
    assert result["status"] == "completed"
    assert result["success"] is (attempt == "correct")
    learning = result["learning"]
    assert learning["traceQuality"] == "verified"
    assert learning["structureMet"] is (attempt == "correct")
    if attempt in ("correct", "unguarded", "extra_turn"):
        stage = result["objects"][0]
        assert (stage["x"], stage["y"], stage["heading"], stage["steps"]) == (3, 2, 90, 5)
        assert learning["routeMet"] is True
    if attempt == "unguarded":
        assert result["failures"] == [task["executionCriteria"][0]["description"]]
        assert learning["pattern"] == "unknown"


def test_crossroad_hint_comes_from_the_course_pack(client):
    course = client.get("/api/v1/course").json()["data"]
    task = next(task for task in course["tasks"] if task["taskId"] == "branch-crossroad")
    hint = client.post("/api/v1/tutor/hints", json={
        "taskId": task["taskId"],
        "learnerChoice": "hint",
        "learningContext": {
            "scope": {"contentVersion": course["contentVersion"], "workspaceId": "branch-hint"},
            "program": task["initialProgram"],
        },
    })
    assert hint.status_code == 200
    guidance = hint.json()["data"]
    assert guidance["message"] == task["hintLadder"][0]["promptText"]
    assert guidance["nextStep"] == task["hintLadder"][0]["executableNextStep"]
