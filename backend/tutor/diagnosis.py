"""教学事实与错因判定：按固定优先级取首个匹配项，证据不足时返回 unknown。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from backend.domain.program import evaluate_criteria
from backend.tutor.enums import Pattern

PRIORITY = (
    Pattern.PROGRAM_INVALID,
    Pattern.RUN_INCOMPLETE,
    Pattern.NOT_RUN,
    Pattern.SQUARE_LOOP_STRUCTURE,
    Pattern.ACTION_OUTSIDE_LOOP,
    Pattern.LOOP_COUNT_MISMATCH,
    Pattern.MOVE_STEPS_MISMATCH,
    Pattern.PREDICTION_MISMATCH,
    Pattern.GOAL_MET,
    Pattern.UNKNOWN,
)


@dataclass
class Facts:
    runStatus: str | None = None
    programValid: bool = True
    targetSteps: int | None = None
    actualSteps: int | None = None
    moves: int | None = None
    repeatTimes: int | None = None
    stepsPerMove: int | None = None
    suggestedStepsPerMove: int | None = None
    predictionMatch: str = "none"
    predictionValue: int | None = None
    goalKind: str = "distance"
    routeMet: bool | None = None
    structureMet: bool | None = None
    outsideMoves: int = 0
    loopBodyHasMove: bool | None = None
    extras: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "targetSteps": self.targetSteps,
            "actualSteps": self.actualSteps,
            "moves": self.moves,
            "repeatTimes": self.repeatTimes,
            "stepsPerMove": self.stepsPerMove,
            "predictionMatch": self.predictionMatch,
            "predictionValue": self.predictionValue if self.predictionMatch == "exact" else None,
            "goalKind": self.goalKind,
            "routeMet": self.routeMet,
            "structureMet": self.structureMet,
        }


def build_facts(
    *,
    run_status: str | None,
    program_valid: bool,
    objects: list[dict[str, Any]] | None,
    task: dict[str, Any],
    prediction_match: str = "none",
    prediction_value: int | None = None,
    structure: dict[str, Any] | None = None,
) -> Facts:
    stage = next(
        (item for item in (objects or []) if isinstance(item, dict) and item.get("id") == "stage"),
        None,
    )
    target = _target_steps(task)
    actual = stage.get("steps") if isinstance(stage, dict) else None
    moves = stage.get("moves") if isinstance(stage, dict) else None
    teaching = task.get("teaching") or {}
    goal_kind = str(teaching.get("goalKind") or "distance")
    report = structure or {}
    repeat_times = report.get("repeat_times", report.get("repeatTimes"))
    steps_per_move = report.get("steps_per_move", report.get("stepsPerMove"))
    suggested = teaching.get("suggestedStepsPerMove")
    route_met = None
    if run_status == "completed" and stage is not None:
        route_met, _ = evaluate_criteria(task, objects or [])
    return Facts(
        runStatus=run_status,
        programValid=program_valid,
        targetSteps=target,
        actualSteps=int(actual) if isinstance(actual, (int, float)) else None,
        moves=int(moves) if isinstance(moves, (int, float)) else None,
        repeatTimes=int(repeat_times) if isinstance(repeat_times, (int, float)) else None,
        stepsPerMove=int(steps_per_move) if isinstance(steps_per_move, (int, float)) else None,
        suggestedStepsPerMove=int(suggested) if isinstance(suggested, (int, float)) else None,
        predictionMatch=prediction_match,
        predictionValue=prediction_value,
        goalKind=goal_kind,
        routeMet=route_met,
        structureMet=report.get("structure_met") if "structure_met" in report else report.get("structureMet"),
        outsideMoves=int(report.get("outside_moves") or report.get("outsideMoves") or 0),
        loopBodyHasMove=report.get("loop_body_has_move"),
    )


def classify(facts: Facts) -> str:
    if not facts.programValid:
        return Pattern.PROGRAM_INVALID.value
    if not facts.runStatus:
        return Pattern.NOT_RUN.value
    if facts.runStatus != "completed":
        return Pattern.RUN_INCOMPLETE.value
    if facts.actualSteps is None:
        return Pattern.UNKNOWN.value

    if facts.goalKind == "square" and facts.routeMet and facts.structureMet is False:
        return Pattern.SQUARE_LOOP_STRUCTURE.value

    if facts.goalKind == "distance" and facts.targetSteps is not None and facts.actualSteps != facts.targetSteps:
        if facts.outsideMoves == 1 and facts.moves == 1 and facts.loopBodyHasMove is False:
            return Pattern.ACTION_OUTSIDE_LOOP.value
        suggested = facts.suggestedStepsPerMove
        if facts.repeatTimes is not None and suggested:
            current_steps = facts.stepsPerMove
            if suggested == 1 and current_steps and facts.targetSteps % current_steps == 0:
                return Pattern.LOOP_COUNT_MISMATCH.value
            expected_rounds = facts.targetSteps / suggested
            if facts.repeatTimes != expected_rounds:
                if facts.stepsPerMove == suggested:
                    return Pattern.LOOP_COUNT_MISMATCH.value
            elif facts.stepsPerMove is not None and facts.stepsPerMove != suggested:
                return Pattern.MOVE_STEPS_MISMATCH.value

    if (
        facts.predictionMatch == "exact"
        and facts.predictionValue is not None
        and facts.moves is not None
        and facts.predictionValue != facts.moves
    ):
        return Pattern.PREDICTION_MISMATCH.value

    if facts.routeMet and facts.structureMet is not False:
        return Pattern.GOAL_MET.value
    return Pattern.UNKNOWN.value


def _target_steps(task: dict[str, Any]) -> int | None:
    values = set()
    for item in task.get("successCriteria") or []:
        check = item.get("check") or {}
        if check.get("object") == "stage" and check.get("field") == "steps":
            if check.get("op") != "eq":
                return None
            value = check.get("value")
            if not isinstance(value, (int, float)):
                return None
            values.add(int(value))
    if len(values) == 1:
        return values.pop()
    return None
