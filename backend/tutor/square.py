"""正方形结构判定纯函数：只回答"是否用单一循环表达四条边"，不接 success 门控。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from backend.domain.program import move_step_count, number_input_value as _number

MOVE_KIND = "motion.move"
TURN_KIND = "motion.turn"
REPEAT_KIND = "control.repeat"
HARMLESS_KINDS = {"look.say", "text.print", "event.start"}


@dataclass
class SquareReport:
    structure_met: bool = False
    single_repeat: bool = False
    body_ok: bool = False
    outside_moves: int = 0
    repeat_times: int | None = None
    steps_per_move: int | None = None
    turn_degrees: int | None = None
    loop_id: str | None = None
    move_id: str | None = None
    outside_move_id: str | None = None
    loop_body_has_move: bool | None = None
    simple_move_loop: bool = False
    reasons: list[str] = field(default_factory=list)


def _chain(node: dict[str, Any] | None) -> list[dict[str, Any]]:
    result = []
    guard = 0
    while isinstance(node, dict) and guard < 100:
        guard += 1
        result.append(node)
        node = node.get("next")
    return result


def inspect(root: dict[str, Any] | list[dict[str, Any]] | None, suggested_steps_per_move: int | None = 2) -> SquareReport:
    report = SquareReport()
    roots = root if isinstance(root, list) else [root] if isinstance(root, dict) else []
    if not roots:
        report.reasons.append("empty_program")
        return report

    repeats: list[dict[str, Any]] = []
    outside_moves = 0
    outside_move_ids = []
    inside_move_ids = []
    nested_repeat = False

    def walk(node: dict[str, Any] | None, inside_repeat: bool = False) -> None:
        nonlocal outside_moves, nested_repeat
        for item in _chain(node):
            kind = item.get("kind")
            if kind == REPEAT_KIND:
                repeats.append(item)
                if inside_repeat:
                    nested_repeat = True
                for child in item.get("body") or []:
                    walk(child, True)
            elif kind in (MOVE_KIND, TURN_KIND):
                if not inside_repeat:
                    outside_moves += 1
                if kind == MOVE_KIND:
                    (inside_move_ids if inside_repeat else outside_move_ids).append(item.get("blockId"))

    for entry in roots:
        walk(entry)
    report.outside_moves = outside_moves
    report.outside_move_id = outside_move_ids[0] if len(outside_move_ids) == 1 else None
    report.loop_body_has_move = bool(inside_move_ids)
    report.single_repeat = len(repeats) == 1 and not nested_repeat

    if not repeats:
        report.reasons.append("no_repeat")
        return report
    if len(repeats) > 1:
        report.reasons.append("multiple_repeats")
    if nested_repeat:
        report.reasons.append("nested_repeat")

    loop = repeats[0]
    report.loop_id = loop.get("blockId") if report.single_repeat else None
    times = _number((loop.get("inputs") or {}).get("times"))
    report.repeat_times = int(times) if isinstance(times, (int, float)) else None
    body = _flat_body(loop)
    moves = [item for item in body if item.get("kind") == MOVE_KIND]
    turns = [item for item in body if item.get("kind") == TURN_KIND]
    if len(moves) == 1:
        steps = move_step_count(moves[0])
        report.steps_per_move = int(steps) if isinstance(steps, (int, float)) else None
        report.move_id = moves[0].get("blockId")
    if len(turns) == 1:
        degrees = _number((turns[0].get("inputs") or {}).get("degrees"))
        report.turn_degrees = int(degrees) if isinstance(degrees, (int, float)) else None

    motion = [item.get("kind") for item in body if item.get("kind") not in HARMLESS_KINDS]
    report.simple_move_loop = report.single_repeat and outside_moves == 0 and motion == [MOVE_KIND]
    report.body_ok = (
        len(moves) == 1
        and len(turns) == 1
        and report.steps_per_move is not None
        and (suggested_steps_per_move is None or report.steps_per_move == suggested_steps_per_move)
        and report.turn_degrees in (90, 270)
        and report.repeat_times == 4
        and motion == [MOVE_KIND, TURN_KIND]
    )
    if not report.body_ok:
        report.reasons.append("loop_body_not_square")

    report.structure_met = (
        report.single_repeat
        and report.body_ok
        and report.outside_moves == 0
    )
    if report.outside_moves:
        report.reasons.append("moves_outside_loop")
    return report


def _flat_body(loop: dict[str, Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for child in loop.get("body") or []:
        result.extend(_chain(child))
    return result
