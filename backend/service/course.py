"""课程内容包加载、指纹缓存、严格校验与任务可用性判定。"""

from __future__ import annotations

import hashlib
import json
import math
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
COURSE_IDENTIFIER = re.compile(r"[A-Za-z0-9_-]{1,64}")
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
    def entry_task_id(self) -> str:
        return next(task_id for task_id, task in self.tasks.items() if task["type"] == "main")

    @property
    def transfer_task_id(self) -> str | None:
        if "transferTaskId" in self.course:
            return self.course["transferTaskId"]
        return next((task_id for task_id, task in self.tasks.items()
                     if task.get("teaching", {}).get("goalKind") == "square"), None)

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
        expected_ref = {"courseId": course["courseId"], "version": course["version"], "taskId": task_id}
        if task["initialProgram"].get("courseRef") != expected_ref:
            raise _content_error("initialProgram", f"task={task_id} courseRef 不匹配")
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

    if not isinstance(course["courseId"], str) or not COURSE_IDENTIFIER.fullmatch(course["courseId"]):
        raise _content_error("course_id", str(course["courseId"]))
    if type(course["version"]) is not int or course["version"] != SUPPORTED_COURSE_VERSION:
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
    by_id: dict[str, dict[str, Any]] = {}
    known_points = {point.get("id") for point in course.get("knowledgePoints", []) if isinstance(point, dict)}
    for task in tasks:
        _validate_task(task)
        task_id = str(task["taskId"])
        points = task.get("teaching", {}).get("knowledgePointIds", [])
        if (not isinstance(points, list) or any(not isinstance(point, str) or point not in known_points for point in points)
                or len(set(points)) != len(points)):
            raise _content_error("teaching", f"task={task_id} 知识点关联无效")
        if task_id in by_id:
            raise _content_error("task_id", f"重复 {task_id}")
        by_id[task_id] = task
    mains = [task for task in tasks if task["type"] == "main"]
    variants = [task for task in tasks if task["type"] == "variant"]
    if len(mains) != 1 or not variants:
        raise _content_error("task_types", "需要一个主任务和至少一个变式任务")

    main_task = mains[0]
    variant_ids = {task["taskId"] for task in variants}
    if next_task_id(main_task) not in variant_ids:
        raise _content_error("variant_link", "主任务未指向变式任务")
    compatibility_link = main_task.get("variantTaskId")
    if compatibility_link is not None and (not isinstance(compatibility_link, str) or compatibility_link not in variant_ids):
        raise _content_error("variant_link", "主任务的兼容变式链接无效")
    if any(task.get("variantOf") != main_task["taskId"] for task in variants):
        raise _content_error("variant_link", "变式任务未指向主任务")
    transfer = course.get("transferTaskId")
    if transfer is not None and (not isinstance(transfer, str) or transfer not in variant_ids):
        raise _content_error("transfer_task", "迁移任务必须指向本课的变式任务")
    for task_id in by_id:
        visited = set()
        current = task_id
        while current:
            if not isinstance(current, str) or current not in by_id or current in visited:
                raise _content_error("next_task", f"task={task_id}")
            visited.add(current)
            current = next_task_id(by_id[current])


def next_task_id(task: dict[str, Any]) -> str | None:
    next_id = task.get("nextTaskId")
    if next_id is not None:
        return next_id
    return task.get("variantTaskId") if task["type"] == "main" else None


def _validate_task(task: dict[str, Any]) -> None:
    if not isinstance(task, dict):
        raise _content_error("task_field", "任务不是对象")
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
    if not isinstance(task["taskId"], str) or not COURSE_IDENTIFIER.fullmatch(task["taskId"]):
        raise _content_error("task_id", str(task["taskId"]))
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
        check = criterion.get("check") if isinstance(criterion, dict) else None
        if not isinstance(check, dict):
            raise _content_error("successCriteria", f"task={task['taskId']}")
        value = check.get("value")
        if (
            check.get("object") != "stage" or check.get("field") not in ("x", "y", "heading", "steps", "moves")
            or check.get("op") not in ("eq", "ge", "le")
            or not (type(value) is int or (type(value) is float and math.isfinite(value)))
        ):
            raise _content_error("successCriteria", f"task={task['taskId']}")
    _validate_execution_criteria(task)
    teaching = task.get("teaching", {})
    goal = teaching.get("goalKind", "distance") if isinstance(teaching, dict) else None
    if goal not in ("distance", "square", "route"):
        raise _content_error("teaching", f"task={task['taskId']}")
    feedback = teaching.get("feedback", {})
    if (
        teaching.get("stageView", "track") not in ("track", "path")
        or type(teaching.get("useHintLadder", False)) is not bool
        or any(key in teaching and not _short_text(teaching[key], 24) for key in ("badge", "goalLabel"))
        or not isinstance(feedback, dict)
        or any(key not in ("success", "retry", "structureMissed") or not _short_text(value)
               for key, value in feedback.items())
    ):
        raise _content_error("teaching", f"task={task['taskId']} 教学展示配置无效")
    if "stageGoal" in teaching and not _valid_stage_goal(teaching["stageGoal"]):
        raise _content_error("teaching", f"task={task['taskId']} 舞台目标配置无效")
    suggested = teaching.get("suggestedStepsPerMove")
    if suggested is not None and (type(suggested) is not int or not 1 <= suggested <= 100):
        raise _content_error("teaching", f"task={task['taskId']}")
    if goal == "distance" and suggested is not None:
        step_checks = [item["check"] for item in criteria if item["check"].get("object") == "stage"
                       and item["check"].get("field") == "steps"]
        if len(step_checks) != 1 or step_checks[0].get("op") != "eq":
            raise _content_error("teaching", f"task={task['taskId']} 缺少唯一的步数目标")
        target = step_checks[0].get("value")
        if type(target) is not int or target <= 0 or target % suggested:
            raise _content_error("teaching", f"task={task['taskId']} 步长无法整除目标")
    if task.get("programCriteria", []) not in ([], ["square_single_repeat"]):
        raise _content_error("programCriteria", f"task={task['taskId']}")
    if "nextTaskId" in task and task["nextTaskId"] is not None and (
        not isinstance(task["nextTaskId"], str) or not task["nextTaskId"]
    ):
        raise _content_error("next_task", f"task={task['taskId']}")
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


def _valid_stage_goal(goal: Any) -> bool:
    """舞台目标路线：从原点出发，相邻两点横平竖直、互不重合，坐标为 ±20 内的整数。"""
    if not isinstance(goal, dict) or set(goal) != {"scene", "route"} or goal["scene"] not in ("grid", "road", "beach"):
        return False
    route = goal["route"]
    if not isinstance(route, list) or not 2 <= len(route) <= 20:
        return False
    if not all(isinstance(point, list) and len(point) == 2
               and all(type(value) is int and -20 <= value <= 20 for value in point) for point in route):
        return False
    if route[0] != [0, 0]:
        return False
    return all((ax == bx) != (ay == by) for (ax, ay), (bx, by) in zip(route, route[1:]))


def _short_text(value: Any, limit: int = 160) -> bool:
    return isinstance(value, str) and bool(value.strip()) and len(value) <= limit


def _validate_execution_criteria(task: dict[str, Any]) -> None:
    rules = task.get("executionCriteria", [])
    if not isinstance(rules, list):
        raise _content_error("executionCriteria", f"task={task['taskId']}")
    for rule in rules:
        check = rule.get("check") if isinstance(rule, dict) else None
        required = {"kind", "inside", "atSteps"}
        if (
            not isinstance(check, dict) or not required <= check.keys() or check.keys() - required - {"only"}
            or check["kind"] != "motion.turn" or check["inside"] not in ("control.if", "control.else")
            or type(check["atSteps"]) is not int or check["atSteps"] < 0
            or type(check.get("only", False)) is not bool
            or not _short_text(rule.get("code"), 64) or not _short_text(rule.get("description"))
        ):
            raise _content_error("executionCriteria", f"task={task['taskId']}")


def course_payload(settings: Settings, course_id: str | None = None, bundle: CourseBundle | None = None) -> dict[str, Any]:
    bundle = bundle or load_course(settings)
    if course_id is not None and course_id != bundle.course["courseId"]:
        raise _content_error("course_id", course_id)
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
                "nextTaskId": next_task_id(task),
                "teaching": task.get("teaching"),
                "programCriteria": task.get("programCriteria", []),
                "executionCriteria": task.get("executionCriteria", []),
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
        "entryTaskId": bundle.entry_task_id,
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
