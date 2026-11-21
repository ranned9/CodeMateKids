"""执行回放：只读消费终态事件与程序树，重建动作序列并核对末态。

不修改运行协议，不写入作品；任何不完整证据一律降级为 unavailable / inconsistent。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from backend.domain.program import number_input_value
from backend.runner.runtime_api import Stage
from backend.runner.protocol import MAX_EVENTS

DEFAULT_MAX_ACTIONS = 12
MOVE_KIND = "motion.move"
TURN_KIND = "motion.turn"
REPEAT_KIND = "control.repeat"


@dataclass
class ReplayResult:
    quality: str
    actions: list[dict[str, Any]] = field(default_factory=list)
    rounds: int = 0
    reason: str = ""
    has_more: bool = False

    @property
    def replayable(self) -> bool:
        return self.quality == "verified"


def _index_nodes(roots: list[dict[str, Any]]) -> tuple[dict[str, dict[str, Any]], dict[str, str | None]]:
    index: dict[str, dict[str, Any]] = {}
    parents: dict[str, str | None] = {}

    def walk(node: dict[str, Any] | None, parent: str | None = None) -> None:
        while isinstance(node, dict):
            block_id = node["blockId"]
            index[block_id] = node
            parents[block_id] = parent
            for child in node.get("body") or []:
                walk(child, block_id if node.get("kind") == REPEAT_KIND else parent)
            node = node.get("next")

    for root in roots:
        walk(root)
    return index, parents


def _pairs_ok(events: list[dict[str, Any]]) -> bool:
    stack: list[str] = []
    last_seq = 0
    for event in events:
        seq = event.get("seq")
        if type(seq) is not int or seq != last_seq + 1:
            return False
        last_seq = seq
        kind = event.get("kind")
        block_id = event.get("blockId")
        if not isinstance(block_id, str):
            return False
        if kind == "block_enter":
            stack.append(block_id)
        elif kind == "block_exit":
            if not stack or stack[-1] != block_id:
                return False
            stack.pop()
        else:
            return False
    return not stack


def analyze(
    root: dict[str, Any] | list[dict[str, Any]] | None,
    events: list[dict[str, Any]] | None,
    objects: list[dict[str, Any]] | None,
    max_actions: int | None = None,
) -> ReplayResult:
    events = list(events or [])
    if not events:
        return ReplayResult("unavailable", reason="empty_events")
    if len(events) >= MAX_EVENTS:
        return ReplayResult("unavailable", reason="event_limit")
    if not _pairs_ok(events):
        return ReplayResult("unavailable", reason="unpaired_or_disordered")

    roots = root if isinstance(root, list) else [root] if root else []
    index, parents = _index_nodes(roots)
    stage = next((item for item in (objects or []) if isinstance(item, dict) and item.get("id") == "stage"), None)
    fields = ("x", "y", "heading", "steps", "moves")
    if stage is None or any(type(stage.get(key)) is not int for key in fields):
        return ReplayResult("unavailable", reason="missing_stage")

    actions: list[dict[str, Any]] = []
    repeat_ids = [key for key, node in index.items() if node.get("kind") == REPEAT_KIND]
    repeat_id = repeat_ids[0] if len(repeat_ids) == 1 else None
    repeat_entries = 0
    movement = Stage()
    for event in events:
        node = index.get(event.get("blockId"))
        if node is None:
            return ReplayResult("unavailable", reason="unknown_block")
        if event.get("kind") != "block_exit":
            continue
        kind = node.get("kind")
        block_id = node["blockId"]
        if kind == REPEAT_KIND and block_id == repeat_id:
            repeat_entries += 1
            continue
        if kind not in (MOVE_KIND, TURN_KIND):
            continue
        parameter = "steps" if kind == MOVE_KIND else "degrees"
        amount = number_input_value((node.get("inputs") or {}).get(parameter))
        if type(amount) is not int:
            return ReplayResult("unavailable", reason="unknown_motion_amount")
        if kind == MOVE_KIND:
            movement.move(amount)
        else:
            movement.turn(amount)
        actions.append({
            "blockId": block_id, "kind": kind, parameter: amount,
            "round": repeat_entries if repeat_id and parents[block_id] == repeat_id else None,
            "x": movement.x, "y": movement.y, "heading": movement.heading,
            "totalSteps": movement.steps, "moves": movement.moves,
        })

    final = movement.snapshot()
    if any(final[key] != stage[key] for key in fields):
        return ReplayResult("inconsistent", reason="stage_mismatch")

    rounds = max((action["round"] or 0 for action in actions), default=0)
    limit = DEFAULT_MAX_ACTIONS if max_actions is None else max_actions
    return ReplayResult("verified", actions=actions[:limit], rounds=rounds, has_more=len(actions) > limit)
