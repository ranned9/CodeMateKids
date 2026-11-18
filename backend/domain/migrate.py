"""项目文件显式迁移链：低版本逐级升级，任一失败整体回滚。"""

from __future__ import annotations

from copy import deepcopy
from typing import Any

CURRENT_FORMAT_VERSION = 1


class MigrationError(ValueError):
    pass


def migrate_0_to_1(program: dict[str, Any]) -> dict[str, Any]:
    migrated = deepcopy(program)
    if migrated.get("format") not in (None, "codematekids.program"):
        raise MigrationError("旧版格式标识不认识")
    migrated["format"] = "codematekids.program"
    migrated["formatVersion"] = 1
    migrated.setdefault("target", {"language": "python", "version": "3.12"})
    course = migrated.pop("course", None)
    if "courseRef" not in migrated:
        if not isinstance(course, dict):
            raise MigrationError("旧版文件缺少课程引用")
        migrated["courseRef"] = {
            "courseId": course.get("courseId", ""),
            "version": int(course.get("version", 1)),
            "taskId": course.get("taskId", ""),
        }
    migrated.setdefault("root", None)
    migrated.setdefault("metadata", {"createdAt": "", "updatedAt": ""})
    return migrated


MIGRATIONS = {
    0: migrate_0_to_1,
}


def migrate_program(program: dict[str, Any]) -> tuple[dict[str, Any], int]:
    if not isinstance(program, dict):
        raise MigrationError("项目结构不认识")
    try:
        version = int(program.get("formatVersion", 0))
    except (TypeError, ValueError) as exc:
        raise MigrationError("格式版本不对") from exc
    if version > CURRENT_FORMAT_VERSION:
        raise MigrationError("文件版本高于当前客户端")
    original = version
    current = deepcopy(program)
    guard = 0
    while version < CURRENT_FORMAT_VERSION and guard < 10:
        guard += 1
        migration = MIGRATIONS.get(version)
        if migration is None:
            raise MigrationError("缺少对应的迁移规则")
        current = migration(current)
        version = int(current.get("formatVersion", version + 1))
    return current, original