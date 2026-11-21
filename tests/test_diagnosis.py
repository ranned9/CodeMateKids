"""DV-AI-04 / DV-AI-05：九类 pattern 优先级与教学索引边界。"""

from __future__ import annotations

from backend.session.teaching_store import MAX_SEEN_HINTS, TeachingStore
from backend.tutor.diagnosis import Facts, build_facts, classify
from backend.tutor.enums import Pattern


def _facts(**overrides) -> Facts:
    base = Facts(
        runStatus="completed",
        programValid=True,
        targetSteps=6,
        actualSteps=4,
        moves=2,
        repeatTimes=2,
        stepsPerMove=2,
        suggestedStepsPerMove=2,
        predictionMatch="exact",
        predictionValue=2,
        routeMet=False,
    )
    for key, value in overrides.items():
        setattr(base, key, value)
    return base


def test_t01_loop_count_mismatch() -> None:
    assert classify(_facts()) == Pattern.LOOP_COUNT_MISMATCH.value


def test_t02_action_outside_loop() -> None:
    facts = _facts(actualSteps=4, moves=1, repeatTimes=None, stepsPerMove=None, outsideMoves=1, loopBodyHasMove=False)
    assert classify(facts) == Pattern.ACTION_OUTSIDE_LOOP.value


def test_t03_move_steps_mismatch() -> None:
    facts = _facts(actualSteps=3, moves=3, repeatTimes=3, stepsPerMove=1)
    assert classify(facts) == Pattern.MOVE_STEPS_MISMATCH.value


def test_t04_prediction_mismatch_when_goal_met_and_prediction_conflicts() -> None:
    facts = _facts(actualSteps=6, moves=3, repeatTimes=3, routeMet=True, predictionMatch="exact", predictionValue=6)
    assert classify(facts) == Pattern.PREDICTION_MISMATCH.value, "Q-AI-04 建议值，标注待定稿"


def test_goal_met_without_conflict() -> None:
    facts = _facts(actualSteps=6, moves=3, repeatTimes=3, routeMet=True, predictionMatch="exact", predictionValue=3)
    assert classify(facts) == Pattern.GOAL_MET.value


def test_not_run_and_incomplete() -> None:
    assert classify(_facts(runStatus=None, actualSteps=None, moves=None)) == Pattern.NOT_RUN.value
    assert classify(_facts(runStatus="failed")) == Pattern.RUN_INCOMPLETE.value
    assert classify(_facts(programValid=False)) == Pattern.PROGRAM_INVALID.value


def test_square_structure_pattern() -> None:
    facts = _facts(goalKind="square", actualSteps=8, routeMet=True, structureMet=False)
    assert classify(facts) == Pattern.SQUARE_LOOP_STRUCTURE.value


def test_unknown_when_evidence_is_ambiguous() -> None:
    facts = _facts(actualSteps=2, moves=2, repeatTimes=None, stepsPerMove=None)
    assert classify(facts) == Pattern.UNKNOWN.value


def test_carried_prediction_never_used_for_diagnosis() -> None:
    facts = _facts(actualSteps=6, moves=3, repeatTimes=3, routeMet=True, predictionMatch="carried", predictionValue=9)
    assert classify(facts) == Pattern.GOAL_MET.value


def test_build_facts_keeps_unknown_as_null() -> None:
    task = {"successCriteria": [{"check": {"object": "stage", "field": "steps", "op": "eq", "value": 4}}]}
    facts = build_facts(run_status=None, program_valid=True, objects=None, task=task)
    assert facts.actualSteps is None
    assert facts.moves is None
    assert facts.targetSteps == 4


def test_teaching_store_scopes_and_limits() -> None:
    store = TeachingStore()
    key = TeachingStore.scope_key({"contentVersion": "1.2.1", "taskId": "main", "workspaceId": "ws-1"})
    store.put_prediction(key, "pred-1", 4)
    assert store.get_prediction(key, "pred-1")["value"] == 4
    assert store.get_prediction("other", "pred-1") is None

    for index in range(MAX_SEEN_HINTS + 2):
        store.add_seen_hint(key, f"h-{index}")
    seen = store.seen_hints(key)
    assert len(seen) == MAX_SEEN_HINTS
    assert seen[-1] == f"h-{MAX_SEEN_HINTS + 1}"
    assert store.add_seen_hint(key, seen[-1]) is False

    store.put_run(key, "run-1", {"pattern": "goal_met"})
    assert store.get_run(key, "run-1")["pattern"] == "goal_met"
    store.put_structure(key, {"structure_met": True})
    assert store.get_structure(key)["structure_met"] is True
    assert store.snapshot()["scopes"] == 2