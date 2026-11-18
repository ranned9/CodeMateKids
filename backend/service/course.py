"""课程内容包加载、指纹缓存、严格校验与任务可用性判定。"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from backend.domain.blocks import BlocksRegistry, load_blocks
from backend.domain.program import ProgramError, validate_program
from backend.infra.config import Settings
from backend.infra.errors import ApiError
from backend.service.content_validation import validate_reply_entries

SUPPORTED_COURSE_VERSION = 1
CONTENT_VERSION_PATTERN = re.compile(r"^\d+\.\d+\.\d+$")
TASK_TYPES = ("main", "variant")
TUTOR_ACTIONS = (
    "ask_question",
    "hint",
    "point_to_block",
    "show_execution",
    "analogy",
    "partial_example",
    "break_down",
    "explain",
    "offer_variant",
)
CONTENT_FILES = ("course.json", "blocks.used.json", "tutor.replies.json")


@dataclass
class CourseBundle:
    course: dict[str, Any]
    tasks: dict[str, dict[str, Any]]
    blocked: dict[str, str]
    replies: list[dict[str, Any]]
    registry: BlocksRegistry
    content_version: str
    content_fingerprint: str
    reply_diagnostics: list[dict[str, Any]]

    def task_order(self) -> list[str]:
        return [str(task["taskId"]) for task in self.course["tasks"]]

    @property
    def runnable_task_ids(self) -> list[str]:
        return [task_id for task_id in self.task_order() if task_id not in self.blocked]


_CACHE: dict[str, tuple[str, CourseBundle]] = {}


def _read_json(path: Path) -> dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise _content_error("read_failed", str(path.name)) from exc
    if not isinstance(payload, dict):
        raise _content_error("not_object", str(path.name))
    return payload


def _content_error(code: str, detail: str) -> ApiError:
    error = ApiError("COURSE_VERSION_UNSUPPORTED")
    error.detail = f"code={code} detail={detail}"
    error.content_code = code
    return error


def content_fingerprint(root: Path) -> str:
    hasher = hashlib.sha1()
    for name in CONTENT_FILES:
        path = root / name
        try:
            stat = path.stat()
        except OSError as exc:
            raise _content_error("missing_file", name) from exc
        hasher.update(f"{name}:{stat.st_size}:{stat.st_mtime_ns}".encode("utf-8"))
    return hasher.hexdigest()


def load_course(settings: Settings, refresh: bool = False) -> CourseBundle:
    root = Path(settings.course_dir)
    key = str(root)
    fingerprint = content_fingerprint(root)
    cached = _CACHE.get(key)
    if cached is not None and cached[0] == fingerprint and not refresh:
        return cached[1]

    course = _read_json(root / "course.json")
    validate_course(course)
    registry = load_blocks()
    used = _read_json(root / "blocks.used.json")
    reply_payload = _read_json(root / "tutor.replies.json")

    used_kinds = used.get("kinds", [])
    if not isinstance(used_kinds, list):
        raise _content_error("blocks_used", "kinds 不是数组")
    for kind in used_kinds:
        if not registry.is_runnable(str(kind)):
            raise _content_error("blocked_kind", str(kind))

    tasks: dict[str, dict[str, Any]] = {}
    blocked: dict[str, str] = {}
    for task in course["tasks"]:
        task_id = str(task["taskId"])
        tasks[task_id] = task
        reason = _task_block_reason(task, registry)
        if reason:
            blocked[task_id] = reason
        try:
            validate_program(
                task["initialProgram"],
                registry,
                expected_task_id=task_id,
                enforce_runnable=True,
            )
        except ProgramError as exc:
            if exc.code == "PYTHON_FEATURE_BLOCKED":
                blocked[task_id] = "这节课需要的积木暂不支持"
                continue
            raise _content_error(exc.code, f"task={task_id} block={exc.block_id or '-'}") from exc

    task_ids = set(tasks)
    raw_replies = reply_payload.get("replies", [])
    report = validate_reply_entries(raw_replies, task_ids)
    if not isinstance(raw_replies, list):
        raise _content_error("replies", "不是数组")

    bundle = CourseBundle(
        course=course,
        tasks=tasks,
        blocked=blocked,
        replies=report.valid,
        registry=registry,
        content_version=str(course["contentVersion"]),
        content_fingerprint=fingerprint,
        reply_diagnostics=report.diagnostics,
    )
    _CACHE[key] = (fingerprint, bundle)
    return bundle


def _task_block_reason(task: dict[str, Any], registry: BlocksRegistry) -> str:
    for kind in task.get("allowedBlockKinds", []):
        if not registry.is_runnable(str(kind)):
            return "这节课需要的积木暂不支持"
    return ""


def validate_course(course: dict[str, Any]) -> None:
    required = (
        "courseId",
        "version",
        "title",
        "ageBand",
        "learningObjectives",
        "prerequisites",
        "tasks",
        "reviewStatus",
        "contentVersion",
    )
    for key in required:
        if key not in course:
            raise _content_error("course_field", key)

    if course["courseId"] != "demo-loop":
        raise _content_error("course_id", str(course["courseId"]))
    if int(course["version"]) != SUPPORTED_COURSE_VERSION:
        raise _content_error("course_version", str(course["version"]))
    if not isinstance(course["title"], str) or not 1 <= len(course["title"]) <= 20:
        raise _content_error("title", "长度不合规")
    if course["ageBand"] != "小学三年级及以上":
        raise _content_error("ageBand", str(course["ageBand"]))
    objectives = course["learningObjectives"]
    if not isinstance(objectives, list) or not 1 <= len(objectives) <= 3:
        raise _content_error("learningObjectives", "数量不合规")
    if not isinstance(course["prerequisites"], list) or len(course["prerequisites"]) > 3:
        raise _content_error("prerequisites", "数量不合规")
    if course["reviewStatus"] not in ("draft", "reviewed"):
        raise _content_error("reviewStatus", str(course["reviewStatus"]))
    if not CONTENT_VERSION_PATTERN.match(str(course["contentVersion"])):
        raise _content_error("contentVersion", str(course["contentVersion"]))

    tasks = course["tasks"]
    if not isinstance(tasks, list):
        raise _content_error("tasks", "不是数组")
    task_ids: set[str] = set()
    types: set[str] = set()
    for task in tasks:
        _validate_task(task)
        task_id = str(task["taskId"])
        if task_id in task_ids:
            raise _content_error("task_id", f"重复 {task_id}")
        task_ids.add(task_id)
        types.add(str(task["type"]))
    if types != set(TASK_TYPES):
        raise _content_error("task_types", str(sorted(types)))

    main_task = next(item for item in tasks if item["type"] == "main")
    variant_task = next(item for item in tasks if item["type"] == "variant")
    if main_task.get("variantTaskId") != variant_task["taskId"]:
        raise _content_error("variant_link", "主任务未指向变式任务")
    if variant_task.get("variantOf") != main_task["taskId"]:
        raise _content_error("variant_link", "变式任务未指向主任务")


def _validate_task(task: dict[str, Any]) -> None:
    required = (
        "taskId",
        "type",
        "title",
        "objective",
        "predictionQuestion",
        "initialProgram",
        "expectedBehavior",
        "allowedBlockKinds",
        "successCriteria",
        "commonErrors",
        "hintLadder",
        "ageNote",
        "reviewStatus",
    )
    for key in required:
        if key not in task:
            raise _content_error("task_field", f"task={task.get('taskId')} field={key}")
    if task["type"] not in TASK_TYPES:
        raise _content_error("task_type", str(task["type"]))
    if not str(task["objective"]).strip():
        raise _content_error("objective", f"task={task['taskId']}")
    if not str(task["predictionQuestion"]).strip():
        raise _content_error("prediction", f"task={task['taskId']}")
    if not isinstance(task["initialProgram"], dict):
        raise _content_error("initialProgram", f"task={task['taskId']} 不是对象")
    if not isinstance(task["allowedBlockKinds"], list) or not task["allowedBlockKinds"]:
        raise _content_error("allowedBlockKinds", f"task={task['taskId']}")
    criteria = task["successCriteria"]
    if not isinstance(criteria, list) or len(criteria) < 1:
        raise _content_error("successCriteria", f"task={task['taskId']}")
    for criterion in criteria:
        check = criterion.get("check") or {}
        if not isinstance(check, dict) or "object" not in check or "field" not in check:
            raise _content_error("successCriteria", f"task={task['taskId']}")
    errors = task["commonErrors"]
    if not isinstance(errors, list) or len(errors) < 2:
        raise _content_error("commonErrors", f"task={task['taskId']}")
    ladder = task["hintLadder"]
    if not isinstance(ladder, list) or len(ladder) < 3:
        raise _content_error("hintLadder", f"task={task['taskId']}")
    levels = [int(item.get("level", 0)) for item in ladder]
    if levels != sorted(levels) or len(set(levels)) != len(levels):
        raise _content_error("hintLadder", f"task={task['taskId']} 等级不递增")
    for item in ladder:
        if item.get("action") not in TUTOR_ACTIONS:
            raise _content_error("hintLadder", f"task={task['taskId']} 动作越界")
        if not str(item.get("promptText", "")).strip():
            raise _content_error("hintLadder", f"task={task['taskId']} 提示为空")
        if not str(item.get("executableNextStep", "")).strip():
            raise _content_error("hintLadder", f"task={task['taskId']} 下一步为空")
    if task["reviewStatus"] not in ("draft", "reviewed"):
        raise _content_error("reviewStatus", f"task={task['taskId']}")


def course_payload(settings: Settings, course_id: str, bundle: CourseBundle | None = None) -> dict[str, Any]:
    if course_id != "demo-loop":
        raise _content_error("course_id", course_id)
    bundle = bundle or load_course(settings)
    tasks: list[dict[str, Any]] = []
    for task_id in bundle.task_order():
        task = bundle.tasks[task_id]
        blocked_reason = bundle.blocked.get(task_id, "")
        tasks.append(
            {
                "taskId": task_id,
                "type": task["type"],
                "title": task["title"],
                "objective": task["objective"],
                "predictionQuestion": task["predictionQuestion"],
                "durationHint": task.get("durationHint", ""),
                "enterable": not blocked_reason,
                "blockedReason": blocked_reason,
                "initialProgram": task["initialProgram"],
                "successCriteria": task["successCriteria"],
                "commonErrors": task["commonErrors"],
                "hintLadder": task["hintLadder"],
                "allowedBlockKinds": task["allowedBlockKinds"],
                "expectedBehavior": task["expectedBehavior"],
                "variantOf": task.get("variantOf"),
                "variantTaskId": task.get("variantTaskId"),
            }
        )
    course = bundle.course
    return {
        "status": "ready" if not bundle.blocked else "blocked",
        "course": {
            "courseId": course["courseId"],
            "version": course["version"],
            "title": course["title"],
            "ageBand": course["ageBand"],
            "learningObjectives": course["learningObjectives"],
            "prerequisites": course["prerequisites"],
            "reviewStatus": course["reviewStatus"],
            "contentVersion": course["contentVersion"],
        },
        "tasks": tasks,
        "otherThemes": course.get("otherThemes", []),
        "schemaVersion": bundle.registry.schema_version,
        "agentMode": settings.tutor_mode,
        "contentVersion": bundle.content_version,
    }


def find_task(settings: Settings, task_id: str, bundle: CourseBundle | None = None) -> dict[str, Any]:
    bundle = bundle or load_course(settings)
    task = bundle.tasks.get(task_id)
    if task is None:
        raise ApiError("PROGRAM_SCHEMA_INVALID")
    return task


def find_hint_levels(settings: Settings, task_id: str, bundle: CourseBundle | None = None) -> list[dict[str, Any]]:
    return list(find_task(settings, task_id, bundle).get("hintLadder", []))