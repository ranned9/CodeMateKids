"""项目保存与加载：只存结构，不存源码；加载按不可信输入处理。"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from backend.domain.blocks import load_blocks
from backend.domain.migrate import MigrationError, migrate_program
from backend.domain.program import MAX_BYTES, MAX_JSON_DEPTH, ProgramError, json_depth, validate_program
from backend.infra.config import Settings
from backend.infra.errors import ApiError
from backend.service.course import load_course

FORBIDDEN_KEYS = {
    "sourcecode",
    "source_code",
    "pythonsource",
    "script",
    "code",
    "execute",
    "permission",
    "permissions",
    "password",
    "secret",
    "token",
    "credential",
    "credentials",
    "identity",
    "realname",
    "phone",
    "address",
    "school",
    "class",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _scan_forbidden(value: Any, trail: str = "") -> str | None:
    if isinstance(value, dict):
        for key, child in value.items():
            name = str(key).lower()
            if name in FORBIDDEN_KEYS:
                return f"{trail}/{key}".lstrip("/")
            found = _scan_forbidden(child, f"{trail}/{key}")
            if found:
                return found
    elif isinstance(value, list):
        for index, child in enumerate(value):
            found = _scan_forbidden(child, f"{trail}[{index}]")
            if found:
                return found
    return None


def _validate_course_ref(settings: Settings, course_ref: Any) -> str:
    bundle = load_course(settings)
    if not isinstance(course_ref, dict):
        return "作品缺少课程引用"
    if course_ref.get("courseId") != bundle.course["courseId"]:
        return "这个作品对应的课程不在这台电脑上"
    if int(course_ref.get("version", 0)) != int(bundle.course["version"]):
        return "这个作品对应的课程版本不在本机"
    if str(course_ref.get("taskId", "")) not in bundle.tasks:
        return "这个作品对应的任务不在本机"
    return ""


def save_project(settings: Settings, program: Any, course_ref: Any) -> dict[str, Any]:
    if not isinstance(program, dict):
        raise ApiError("PROGRAM_SCHEMA_INVALID")
    forbidden = _scan_forbidden(program)
    if forbidden:
        raise ApiError("PROGRAM_SCHEMA_INVALID", message="作品里不能放可执行代码或个人信息。")
    read_only_reason = _validate_course_ref(settings, course_ref or program.get("courseRef"))
    if read_only_reason:
        raise ApiError("COURSE_VERSION_UNSUPPORTED", message=read_only_reason)
    program = dict(program)
    program["courseRef"] = dict(course_ref or program.get("courseRef") or {})
    now = _now()
    metadata = dict(program.get("metadata") or {})
    metadata["createdAt"] = now
    metadata["updatedAt"] = now
    program["metadata"] = metadata
    try:
        validate_program(program, enforce_runnable=False)
    except ProgramError as exc:
        raise ApiError(exc.code, exc.block_id, exc.message) from exc
    file_text = json.dumps(program, ensure_ascii=False, indent=2)
    task_id = str((program.get("courseRef") or {}).get("taskId", "task"))
    return {
        "formatVersion": 1,
        "fileName": f"codematekids-{task_id}.json",
        "fileText": file_text,
        "program": program,
    }


def load_project(settings: Settings, file_text: str) -> dict[str, Any]:
    if not isinstance(file_text, str) or not file_text.strip():
        raise ApiError("PROGRAM_SCHEMA_INVALID", message="这个文件不是我们的项目文件。")
    if len(file_text.encode("utf-8")) > MAX_BYTES + 4096:
        raise ApiError("PROGRAM_TOO_LARGE")
    try:
        raw = json.loads(file_text)
    except json.JSONDecodeError as exc:
        raise ApiError("PROGRAM_SCHEMA_INVALID", message="这个文件不是我们的项目文件。") from exc
    if not isinstance(raw, dict):
        raise ApiError("PROGRAM_SCHEMA_INVALID", message="这个文件不是我们的项目文件。")
    if "formatVersion" not in raw and "format" not in raw:
        raise ApiError("PROGRAM_SCHEMA_INVALID", message="这个文件不是我们的项目文件。")
    if json_depth(raw) > MAX_JSON_DEPTH:
        raise ApiError("PROGRAM_TOO_LARGE", message="文件层级太深啦。")
    forbidden = _scan_forbidden(raw)
    if forbidden:
        raise ApiError("PROGRAM_SCHEMA_INVALID", message="项目里不能有可执行代码或个人信息。")

    try:
        program, original_version = migrate_program(raw)
    except MigrationError as exc:
        raise ApiError("PROGRAM_MIGRATION_FAILED", message="这个作品需要更新后才能打开。") from exc

    if program.get("format") != "codematekids.program":
        raise ApiError("PROGRAM_SCHEMA_INVALID", message="这个文件不是我们的项目文件。")

    try:
        validate_program(program, enforce_runnable=False)
    except ProgramError as exc:
        raise ApiError(exc.code, exc.block_id, exc.message) from exc

    registry = load_blocks()
    unknown_blocks: list[dict[str, Any]] = []
    _mark_unknown(program.get("root"), registry, unknown_blocks)

    now = _now()
    program["metadata"] = {"createdAt": now, "updatedAt": now}
    read_only_reason = _validate_course_ref(settings, program.get("courseRef"))
    return {
        "program": program,
        "migratedFrom": original_version if original_version != 1 else None,
        "unknownBlocks": unknown_blocks,
        "runnable": not read_only_reason and not unknown_blocks,
        "readOnlyReason": read_only_reason or ("有积木还不能运行" if unknown_blocks else ""),
    }


def _mark_unknown(node: Any, registry, collected: list[dict[str, Any]]) -> None:
    if not isinstance(node, dict):
        return
    kind = str(node.get("kind", ""))
    definition = registry.get(kind)
    if definition is None or not definition.runnable:
        node["unknown"] = True
        collected.append(
            {
                "blockId": node.get("blockId"),
                "kind": kind,
                "reason": "这个积木还不能运行",
            }
        )
    for child in node.get("body") or []:
        _mark_unknown(child, registry, collected)
    if isinstance(node.get("next"), dict):
        _mark_unknown(node["next"], registry, collected)
    inputs = node.get("inputs")
    if isinstance(inputs, dict):
        for value in inputs.values():
            if isinstance(value, dict):
                _mark_unknown(value, registry, collected)