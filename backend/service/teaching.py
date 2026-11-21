"""教学增强编排（只读派生）：把摘要/结构/事实/回放收敛为 learning 附加数据。

任何异常一律 fail-open 返回 None，不阻塞运行与辅导主流程。
"""

from __future__ import annotations

from typing import Any

from backend.domain.program import ProgramError, program_roots, validate_program
from backend.infra.errors import ApiError
from backend.service.program_digest import edit_digest
from backend.session.teaching_store import TeachingStore
from backend.tutor.diagnosis import build_facts, classify
from backend.tutor.enums import Outcome, Pattern, PredictionMatch, TraceQuality
from backend.tutor.replay import ReplayResult, analyze
from backend.tutor.square import inspect


def learning_key(context: dict[str, Any] | None, bundle, task_id: str) -> str | None:
    scope = (context or {}).get("scope") or {}
    if not scope:
        return None
    course_id = bundle.course["courseId"]
    if scope.get("contentVersion") not in (None, bundle.content_version):
        raise ApiError("COURSE_VERSION_UNSUPPORTED", message="课程内容有更新，请刷新课程再试。")
    if scope.get("taskId") not in (None, task_id) or scope.get("courseId") not in (None, course_id):
        raise ApiError("PROGRAM_SCHEMA_INVALID")
    if not scope.get("workspaceId") or not scope.get("contentVersion"):
        return None
    return TeachingStore.scope_key({**scope, "courseId": course_id, "taskId": task_id})


def validate_snapshot(program: dict[str, Any], bundle, task_id: str) -> None:
    validate_program(program, bundle.registry, expected_task_id=task_id)
    expected = {"courseId": bundle.course["courseId"], "version": bundle.course["version"], "taskId": task_id}
    if program["courseRef"] != expected:
        raise ProgramError("PROGRAM_SCHEMA_INVALID", "这组积木和当前课程对不上。")


def match_prediction(record: dict[str, Any] | None, digest: str) -> dict[str, Any]:
    if record is None:
        return {"match": PredictionMatch.NONE.value}
    match = PredictionMatch.EXACT if record.get("digest") == digest else PredictionMatch.CARRIED
    return {"match": match.value, "value": record["value"]}


def build_learning(
    *,
    program: dict[str, Any] | None,
    task: dict[str, Any],
    run_result: dict[str, Any] | None,
    prediction: dict[str, Any] | None = None,
    structure: dict[str, Any] | None = None,
    max_actions: int | None = None,
) -> dict[str, Any] | None:
    try:
        result = run_result or {}
        status = str(result.get("status") or "") or None
        objects = result.get("objects") or []
        prediction = prediction or {}
        match = str(prediction.get("match") or PredictionMatch.NONE.value)
        if match not in {item.value for item in PredictionMatch}:
            match = PredictionMatch.NONE.value
        value = prediction.get("value")
        roots = program_roots(program, runnable_only=True) if program is not None else []
        report = structure if structure is not None else structure_facts(roots, task)
        replay = (
            analyze(roots, result.get("events") or [], objects, max_actions=max_actions)
            if status == "completed" else ReplayResult(TraceQuality.UNAVAILABLE.value)
        )
        teaching_structure = dict(report)
        if replay.quality != TraceQuality.VERIFIED or not report.get("simple_move_loop"):
            teaching_structure.update(repeat_times=None, steps_per_move=None)
        if replay.quality != TraceQuality.VERIFIED or not report.get("outside_move_id"):
            teaching_structure["outside_moves"] = 0
        facts = build_facts(
            run_status=status,
            program_valid=bool(program),
            objects=objects,
            task=task,
            prediction_match=match,
            prediction_value=int(value) if isinstance(value, (int, float)) else None,
            structure=teaching_structure,
        )
        if facts.goalKind == "square" and facts.routeMet and not facts.structureMet:
            facts.routeMet = _verify_square_path(replay)
        pattern = classify(facts)
        goal_met = bool(result.get("success", facts.routeMet))
        outcome = _outcome(status, goal_met)
        actions = replay.actions
        if facts.goalKind == "distance" and report.get("simple_move_loop"):
            actions = [action for action in actions if action["round"] in (1, 2)]
        learning = {
            "outcome": outcome,
            "pattern": pattern,
            "facts": facts.as_dict(),
            "predictionMatch": match,
            "traceQuality": replay.quality,
            "replay": None
            if replay.quality != TraceQuality.VERIFIED.value or not actions
            else {
                "actions": actions,
                "rounds": replay.rounds,
                "hasMore": replay.has_more or len(actions) < len(replay.actions),
            },
        }
        if facts.goalKind == "square":
            learning.update(routeMet=facts.routeMet, structureMet=facts.structureMet)
        return learning
    except Exception:  # noqa: BLE001 - 教学增强失败必须静默降级
        return None


def _outcome(status: str | None, route_met: bool | None) -> str:
    if status != "completed":
        return Outcome.RUN_INCOMPLETE.value
    return Outcome.GOAL_MET.value if route_met else Outcome.GOAL_MISSED.value


def structure_facts(roots: list[dict[str, Any]], task: dict[str, Any]) -> dict[str, Any]:
    teaching = task.get("teaching") or {}
    square_task = "square_single_repeat" in task.get("programCriteria", [])
    report = inspect(roots, teaching.get("suggestedStepsPerMove", 2))
    return {
        "structure_met": report.structure_met if square_task else None,
        "simple_move_loop": report.simple_move_loop,
        "outside_moves": report.outside_moves,
        "repeat_times": report.repeat_times,
        "steps_per_move": report.steps_per_move,
        "loop_body_has_move": report.loop_body_has_move,
        "loop_id": report.loop_id,
        "move_id": report.move_id,
        "outside_move_id": report.outside_move_id,
    }


def teaching_anchor(pattern: str, structure: dict[str, Any]) -> str | None:
    key = {
        Pattern.ACTION_OUTSIDE_LOOP: "outside_move_id",
        Pattern.LOOP_COUNT_MISMATCH: "loop_id",
        Pattern.MOVE_STEPS_MISMATCH: "move_id",
        Pattern.SQUARE_LOOP_STRUCTURE: "loop_id",
    }.get(pattern)
    return structure.get(key) if key else None


def _verify_square_path(replay: ReplayResult) -> bool | None:
    if not replay.replayable or replay.has_more:
        return None
    edges = [action for action in replay.actions if action["kind"] == "motion.move"]
    if len(edges) != 4 or any(edge["steps"] != 2 for edge in edges):
        return False
    headings = [edge["heading"] for edge in edges]
    angle = (headings[1] - headings[0]) % 360
    return angle in (90, 270) and headings == [(headings[0] + angle * i) % 360 for i in range(4)]


def edit_signatures(program: dict[str, Any], structure: dict[str, Any]) -> dict[str, tuple]:
    signatures = {}
    candidates = (
        ("repeat", structure["loop_id"], "times", structure["repeat_times"]),
        ("distance", structure["move_id"], "steps", structure["steps_per_move"]),
        ("placement", structure["outside_move_id"] or structure["move_id"], None, bool(structure["outside_move_id"])),
    )
    for name, block, parameter, value in candidates:
        if block and value is not None:
            if name == "placement" and not structure.get("simple_move_loop") and not structure.get("outside_move_id"):
                continue
            signatures[name] = (block, edit_digest(program, block, parameter), value)
    return signatures


def described_edit(before: dict[str, Any], after: dict[str, Any]) -> str | None:
    for key, text in (
        ("repeat", "这两次运行之间改了重复次数。"),
        ("distance", "这两次运行之间改了每次前进的步数。"),
        ("placement", "这两次运行之间调整了前进积木在循环中的位置。"),
    ):
        old, new = before.get(key), after.get(key)
        if old and new and old[:2] == new[:2] and old[2] != new[2]:
            return text
    return None
