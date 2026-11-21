"""程序摘要：只读派生 SHA-256，剔除布局坐标与元数据，保留结构与执行顺序。"""

from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from typing import Any


class DigestError(ValueError):
    pass


_PAYLOAD_KEYS_V1 = {"format", "formatVersion", "target", "courseRef", "root", "metadata"}
_PAYLOAD_KEYS_V2 = {"format", "formatVersion", "target", "courseRef", "stacks", "metadata"}


def _validate(program: Any) -> None:
    if not isinstance(program, dict):
        raise DigestError("program_not_object")
    if program.get("format") != "codematekids.program":
        raise DigestError("unknown_format")
    version = program.get("formatVersion")
    if type(version) is not int or version not in (1, 2):
        raise DigestError("unsupported_format_version")
    allowed = _PAYLOAD_KEYS_V1 if version == 1 else _PAYLOAD_KEYS_V2
    if set(program) - allowed:
        raise DigestError("unexpected_payload_keys")
    if version == 1 and not isinstance(program.get("root"), (dict, type(None))):
        raise DigestError("invalid_root")
    if version == 2:
        stacks = program.get("stacks")
        if not isinstance(stacks, list):
            raise DigestError("invalid_stacks")
        for stack in stacks:
            if not isinstance(stack, dict) or not isinstance(stack.get("root"), (dict, type(None))):
                raise DigestError("invalid_stack")


def _normalize(value: Any, drop_layout: bool = False) -> Any:
    if isinstance(value, dict):
        result = {}
        for key in sorted(value):
            if key == "metadata":
                continue
            if drop_layout and key in ("x", "y"):
                continue
            result[key] = _normalize(value[key])
        return result
    if isinstance(value, list):
        return [_normalize(item) for item in value]
    return value


def normalized_payload(program: dict[str, Any]) -> dict[str, Any]:
    _validate(program)
    payload = deepcopy(program)
    payload.pop("metadata", None)
    if payload.get("formatVersion") == 2:
        payload["stacks"] = [_normalize(stack, drop_layout=True) for stack in payload["stacks"]]
    else:
        payload["root"] = _normalize(payload.get("root"))
    payload["target"] = _normalize(payload.get("target"))
    payload["courseRef"] = _normalize(payload.get("courseRef"))
    return payload


def digest_program(program: dict[str, Any]) -> str:
    payload = normalized_payload(program)
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def edit_digest(program: dict[str, Any], block_id: str, parameter: str | None) -> str:
    """Mask one numeric input or detach one movement for a before/after comparison."""
    snapshot = deepcopy(program)

    def mask(node: dict[str, Any] | None) -> dict[str, Any] | None:
        if node is None:
            return None
        if node["blockId"] == block_id:
            if parameter is None:
                return node.get("next")
            node["inputs"][parameter] = None
        node["next"] = mask(node.get("next"))
        node["body"] = [entry for child in node.get("body", []) if (entry := mask(child)) is not None]
        return node

    if snapshot["formatVersion"] == 2:
        for stack in snapshot["stacks"]:
            stack["root"] = mask(stack["root"])
    else:
        snapshot["root"] = mask(snapshot["root"])
    return digest_program(snapshot)
