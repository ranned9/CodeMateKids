"""后端 ↔ worker 的 JSONL 三帧协议校验。"""

from __future__ import annotations

from typing import Any

PROTOCOL_VERSION = 1
RUN_STATUSES = (
    "completed",
    "failed",
    "timeout",
    "resource_exceeded",
    "cancelled",
    "crashed",
)
EVENT_KINDS = ("block_enter", "block_exit", "stdout", "exception")
MAX_EVENTS = 2000


class ProtocolError(ValueError):
    pass


def validate_ready_frame(frame: dict[str, Any]) -> None:
    if frame.get("type") != "ready":
        raise ProtocolError("首帧必须是 ready")
    python_info = frame.get("python")
    if not isinstance(python_info, dict):
        raise ProtocolError("ready 帧缺少 python 版本")


def validate_run_frame(frame: dict[str, Any]) -> None:
    if frame.get("type") != "run":
        raise ProtocolError("指令类型必须是 run")
    if frame.get("protocolVersion") != PROTOCOL_VERSION:
        raise ProtocolError("协议版本不一致")
    for key in ("requestId", "program", "limits", "target"):
        if key not in frame:
            raise ProtocolError(f"run 帧缺少字段 {key}")
    target = frame["target"]
    if target.get("language") != "python":
        raise ProtocolError("目标语言必须是 python")
    if target.get("version") != "3.12":
        raise ProtocolError("目标版本必须是 3.12")
    limits = frame["limits"]
    for key in ("wallTimeMs", "memoryMb", "maxOutputBytes", "maxRecursionDepth"):
        if key not in limits:
            raise ProtocolError(f"limits 缺少字段 {key}")


def validate_result_frame(frame: dict[str, Any], request_id: str) -> None:
    if frame.get("type") != "result":
        raise ProtocolError("终止帧必须是 result")
    if frame.get("requestId") != request_id:
        raise ProtocolError("result 帧 requestId 不一致")
    status = frame.get("status")
    if status not in RUN_STATUSES:
        raise ProtocolError("result 状态越界")
    events = frame.get("events", [])
    last_seq = 0
    for event in events:
        seq = event.get("seq")
        if not isinstance(seq, int) or seq <= last_seq:
            raise ProtocolError("事件序号不单调")
        if event.get("kind") not in EVENT_KINDS:
            raise ProtocolError("事件类型越界")
        last_seq = seq


def make_event_frame(seq: int, block_id: str, kind: str, timestamp_ms: int) -> dict[str, Any]:
    return {
        "type": "event",
        "seq": seq,
        "blockId": block_id,
        "kind": kind,
        "timestampMs": timestamp_ms,
    }


def make_stdout_frame(seq: int, text: str, timestamp_ms: int) -> dict[str, Any]:
    return {"type": "stdout", "seq": seq, "text": text, "timestampMs": timestamp_ms}
