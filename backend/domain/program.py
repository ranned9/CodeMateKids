"""程序模型校验：格式、版本、字段、规模与课程兼容性。"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from backend.domain.blocks import BlockDefinition, BlocksRegistry, load_blocks

MAX_NODES = 500
MAX_DEPTH = 20
MAX_BYTES = 2 * 1024 * 1024
MAX_JSON_DEPTH = 32
MAX_STRING_LENGTH = 120
MAX_STACK_X = 4096
MAX_STACK_Y = 8192

# 旧作品和旧客户端仍可执行已保存的距离，新版积木没有这个输入。
_LEGACY_MOVE_STEPS_FIELD = {
    "name": "steps", "valueType": "integer", "acceptsNumberBlock": True,
    "required": True, "range": {"min": 1, "max": 100},
}

ALLOWED_PROGRAM_KEYS = {"format", "formatVersion", "target", "courseRef", "root", "metadata"}
ALLOWED_NODE_KEYS = {"blockId", "kind", "inputs", "body", "next", "unknown"}
ALLOWED_TARGET_KEYS = {"language", "version"}
ALLOWED_COURSE_KEYS = {"courseId", "version", "taskId"}
ALLOWED_METADATA_KEYS = {"createdAt", "updatedAt"}


class ProgramError(ValueError):
    def __init__(self, code: str, message: str, block_id: str | None = None) -> None:
        self.code = code
        self.message = message
        self.block_id = block_id
        super().__init__(message)


@dataclass
class ProgramStats:
    node_count: int
    max_depth: int
    size_bytes: int
    summary: str


def json_depth(value: Any, current: int = 1, limit: int = MAX_JSON_DEPTH + 8) -> int:
    if current > limit:
        return current
    if isinstance(value, dict):
        if not value:
            return current
        return max(json_depth(child, current + 1, limit) for child in value.values())
    if isinstance(value, list):
        if not value:
            return current
        return max(json_depth(child, current + 1, limit) for child in value)
    return current


def program_json_depth_limit(program: dict[str, Any]) -> int:
    return MAX_JSON_DEPTH + (2 if program.get("formatVersion") == 2 else 0)


def _stack_runs(stack: dict[str, Any]) -> bool:
    return stack.get("legacy", False) or stack["root"].get("kind") == "event.start"


def program_roots(program: dict[str, Any], *, runnable_only: bool = False) -> list[dict[str, Any]]:
    if program.get("formatVersion") == 2:
        return [stack["root"] for stack in program["stacks"] if not runnable_only or _stack_runs(stack)]
    root = program.get("root")
    return [root] if isinstance(root, dict) else []


def validate_program(
    program: dict[str, Any],
    registry: BlocksRegistry | None = None,
    expected_task_id: str | None = None,
    enforce_runnable: bool = True,
) -> ProgramStats:
    registry = registry or load_blocks()
    if not isinstance(program, dict):
        raise ProgramError("PROGRAM_SCHEMA_INVALID", "程序结构有问题。")
    format_version = program.get("formatVersion")
    if type(format_version) is not int or format_version not in (1, 2):
        raise ProgramError("PROGRAM_SCHEMA_INVALID", "项目文件版本不对。")
    allowed_keys = ALLOWED_PROGRAM_KEYS if format_version == 1 else ALLOWED_PROGRAM_KEYS - {"root"} | {"stacks"}
    extra_keys = set(program) - allowed_keys
    if extra_keys:
        raise ProgramError("PROGRAM_SCHEMA_INVALID", "项目里有多余的内容，不能运行。")
    missing_keys = allowed_keys - set(program)
    if missing_keys:
        raise ProgramError("PROGRAM_SCHEMA_INVALID", "项目缺少必要的信息。")
    if program.get("format") != "codematekids.program":
        raise ProgramError("PROGRAM_SCHEMA_INVALID", "这不是我们的项目文件。")

    target = program.get("target")
    if not isinstance(target, dict):
        raise ProgramError("PROGRAM_SCHEMA_INVALID", "缺少运行目标。")
    if set(target) - ALLOWED_TARGET_KEYS:
        raise ProgramError("PROGRAM_SCHEMA_INVALID", "运行目标里有多余的内容。")
    if target.get("language") != "python":
        raise ProgramError("PYTHON_VERSION_MISMATCH", "只支持 Python 目标。")
    if target.get("version") != "3.12":
        raise ProgramError("PYTHON_VERSION_MISMATCH", "运行环境版本不对，需要 Python 3.12。")

    course_ref = program.get("courseRef")
    if not isinstance(course_ref, dict):
        raise ProgramError("PROGRAM_SCHEMA_INVALID", "缺少课程引用。")
    if set(course_ref) - ALLOWED_COURSE_KEYS:
        raise ProgramError("PROGRAM_SCHEMA_INVALID", "课程引用里有多余的内容。")
    for key in ("courseId", "version", "taskId"):
        if key not in course_ref:
            raise ProgramError("PROGRAM_SCHEMA_INVALID", "课程引用不完整。")
    version = course_ref["version"]
    if type(version) is not int or version < 1:
        raise ProgramError("PROGRAM_SCHEMA_INVALID", "作品里的课程版本需要是正整数。")
    if expected_task_id and course_ref.get("taskId") != expected_task_id:
        raise ProgramError("PROGRAM_SCHEMA_INVALID", "程序和当前任务对不上。")

    counter = {"nodes": 0}
    seen_ids: set[str] = set()
    max_depth = {"value": 0}
    if format_version == 1:
        root = program["root"]
        if root is not None:
            if not isinstance(root, dict):
                raise ProgramError("PROGRAM_SCHEMA_INVALID", "根积木结构不对。")
            _validate_node(root, registry, 1, counter, seen_ids, max_depth, enforce_runnable)
    else:
        stacks = program["stacks"]
        if not isinstance(stacks, list):
            raise ProgramError("PROGRAM_SCHEMA_INVALID", "积木组结构不对。")
        for stack in stacks:
            if (
                not isinstance(stack, dict)
                or set(stack) - {"x", "y", "root", "legacy"}
                or not isinstance(stack.get("root"), dict)
                or type(stack.get("legacy", False)) is not bool
                or type(stack.get("x")) is not int or not 0 <= stack["x"] <= MAX_STACK_X
                or type(stack.get("y")) is not int or not 0 <= stack["y"] <= MAX_STACK_Y
            ):
                raise ProgramError("PROGRAM_SCHEMA_INVALID", "积木组的位置或结构不对。")
            root = stack["root"]
            kind = root.get("kind")
            definition = registry.get(kind) if isinstance(kind, str) else None
            port = "statement-next"
            if definition and definition.output_type == "expression":
                if _stack_runs(stack) or root.get("next") is not None:
                    raise ProgramError("PROGRAM_SCHEMA_INVALID", "数字和运算积木需要放进数值插口。")
                port = "expression"
            _validate_node(root, registry, 1, counter, seen_ids, max_depth, enforce_runnable and _stack_runs(stack), port)
        if enforce_runnable and not program_roots(program, runnable_only=True):
            raise ProgramError("PROGRAM_SCHEMA_INVALID", "把要运行的积木接在「当开始」下面。")

    if counter["nodes"] > MAX_NODES:
        raise ProgramError("PROGRAM_TOO_LARGE", "积木太多啦，请先删掉一些。")
    if max_depth["value"] > MAX_DEPTH:
        raise ProgramError("PROGRAM_TOO_LARGE", "积木嵌套太深啦，简化一下再试。")
    if enforce_runnable:
        for root in program_roots(program, runnable_only=True):
            _validate_branch_order([root])

    try:
        size_bytes = len(json.dumps(program, ensure_ascii=False).encode("utf-8"))
    except (TypeError, ValueError) as exc:
        raise ProgramError("PROGRAM_SCHEMA_INVALID", "程序结构有问题。") from exc
    if size_bytes > MAX_BYTES:
        raise ProgramError("PROGRAM_TOO_LARGE", "项目太大啦，先试试更小的作品。")
    if json_depth(program) > program_json_depth_limit(program):
        raise ProgramError("PROGRAM_TOO_LARGE", "文件层级太深啦。")

    return ProgramStats(
        node_count=counter["nodes"],
        max_depth=max_depth["value"],
        size_bytes=size_bytes,
        summary=summarize_program(program, registry),
    )


def _validate_node(
    node: dict[str, Any],
    registry: BlocksRegistry,
    depth: int,
    counter: dict[str, int],
    seen_ids: set[str],
    max_depth: dict[str, int],
    enforce_runnable: bool,
    target_port: str = "statement-next",
) -> None:
    if isinstance(node, dict) and node.get("unknown") is True:
        if enforce_runnable:
            raise ProgramError("PYTHON_FEATURE_BLOCKED", "这个积木现在不能运行。", node.get("blockId"))
    block_id = node.get("blockId")
    if not isinstance(block_id, str) or not block_id:
        raise ProgramError("PROGRAM_SCHEMA_INVALID", "积木缺少编号。")
    if set(node) - ALLOWED_NODE_KEYS:
        raise ProgramError("PROGRAM_SCHEMA_INVALID", "积木里有多余的内容。", block_id if isinstance(block_id, str) else None)
    if block_id in seen_ids:
        raise ProgramError("PROGRAM_SCHEMA_INVALID", "积木编号重复了。")
    seen_ids.add(block_id)

    kind = node.get("kind")
    definition = registry.get(kind) if isinstance(kind, str) else None
    if definition is None:
        if not enforce_runnable and node.get("unknown") is True:
            counter["nodes"] += 1
            max_depth["value"] = max(max_depth["value"], depth)
            body = node.get("body") or []
            if isinstance(body, list):
                for child in body:
                    if isinstance(child, dict):
                        _validate_node(
                            child,
                            registry,
                            depth + 1,
                            counter,
                            seen_ids,
                            max_depth,
                            enforce_runnable,
                            "statement-body",
                        )
            next_node = node.get("next")
            if isinstance(next_node, dict):
                _validate_node(
                    next_node,
                    registry,
                    depth + 1,
                    counter,
                    seen_ids,
                    max_depth,
                    enforce_runnable,
                )
            return
        raise ProgramError("PYTHON_FEATURE_BLOCKED", "这个积木现在不能运行。", block_id)
    if enforce_runnable and not definition.runnable:
        raise ProgramError("PYTHON_FEATURE_BLOCKED", "这个积木现在不能运行。", block_id)
    if not registry.accepts(definition.output_type, target_port):
        raise ProgramError("PROGRAM_SCHEMA_INVALID", "这个位置需要动作积木。", block_id)

    counter["nodes"] += 1
    max_depth["value"] = max(max_depth["value"], depth)

    inputs = node.get("inputs")
    if not isinstance(inputs, dict):
        raise ProgramError("PROGRAM_SCHEMA_INVALID", "积木参数结构不对。", block_id)
    fields = definition.fields
    if kind == "motion.move" and "steps" in inputs and definition.field("steps") is None:
        fields = [*fields, _LEGACY_MOVE_STEPS_FIELD]
    valid_field_names = {str(field["name"]) for field in fields}
    for key in inputs:
        if key not in valid_field_names:
            raise ProgramError("PROGRAM_SCHEMA_INVALID", "积木参数不认识。", block_id)

    for field in fields:
        name = str(field["name"])
        value = inputs.get(name)
        if field.get("required") and (value is None or value == ""):
            if not enforce_runnable and field.get("valueType") == "expression" and value is None:
                continue
            raise ProgramError("PROGRAM_SCHEMA_INVALID", "这个位置还需要填内容。", block_id)
        if value is None:
            continue
        _validate_field_value(field, value, registry, block_id, depth, counter, seen_ids, max_depth, enforce_runnable)

    body = node.get("body")
    if body is None:
        body = []
    if not isinstance(body, list):
        raise ProgramError("PROGRAM_SCHEMA_INVALID", "语句体结构不对。", block_id)
    if body:
        accepts_body = any(port.get("portType") == "statement-body" for port in definition.ports)
        if not accepts_body:
            raise ProgramError("PROGRAM_SCHEMA_INVALID", "这个积木不能装动作。", block_id)
        for child in body:
            if not isinstance(child, dict):
                raise ProgramError("PROGRAM_SCHEMA_INVALID", "语句体里有不认识的内容。", block_id)
            _validate_node(child, registry, depth + 1, counter, seen_ids, max_depth, enforce_runnable, "statement-body")

    next_node = node.get("next")
    if next_node is not None:
        if not isinstance(next_node, dict):
            raise ProgramError("PROGRAM_SCHEMA_INVALID", "积木连接结构不对。", block_id)
        _validate_node(next_node, registry, depth + 1, counter, seen_ids, max_depth, enforce_runnable)


def _validate_branch_order(heads: list[dict[str, Any]]) -> None:
    previous_kind = None
    for head in heads:
        node = head
        while node is not None:
            kind = node["kind"]
            if kind == "control.else" and previous_kind != "control.if":
                raise ProgramError("PROGRAM_SCHEMA_INVALID", "把「否则」紧接在同一层的「如果」后面。", node["blockId"])
            if node.get("body"):
                _validate_branch_order(node["body"])
            previous_kind = kind
            node = node.get("next")


def number_input_value(value: Any) -> Any:
    if not isinstance(value, dict):
        return value
    nested = (value.get("inputs") or {}).get("value")
    return int(nested) if type(nested) is float and nested.is_integer() else nested


def move_step_count(node: dict[str, Any]) -> int:
    return number_input_value((node.get("inputs") or {}).get("steps", 1))


def _validate_field_value(
    field: dict[str, Any],
    value: Any,
    registry: BlocksRegistry,
    block_id: str,
    depth: int,
    counter: dict[str, int],
    seen_ids: set[str],
    max_depth: dict[str, int],
    enforce_runnable: bool,
) -> None:
    value_type = field.get("valueType")
    if field.get("acceptsNumberBlock") and isinstance(value, dict):
        if value.get("kind") != "value.number" or value.get("next") is not None:
            raise ProgramError("PROGRAM_SCHEMA_INVALID", "这个位置只接收数字积木。", block_id)
        _validate_expression_node(value, registry, block_id, depth + 1, counter, seen_ids, max_depth, enforce_runnable)
        block_id = value["blockId"]
        value = number_input_value(value)
    if value_type in ("number", "integer"):
        if value_type == "integer" and type(value) is not int:
            raise ProgramError("PROGRAM_SCHEMA_INVALID", "这个位置需要一个整数。", block_id)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ProgramError("PROGRAM_SCHEMA_INVALID", "这个位置需要一个数字。", block_id)
        value_range = field.get("range") or {}
        if "min" in value_range and value < value_range["min"]:
            raise ProgramError("PROGRAM_SCHEMA_INVALID", "这个数字太小啦。", block_id)
        if "max" in value_range and value > value_range["max"]:
            raise ProgramError("PROGRAM_SCHEMA_INVALID", "这个数字太大啦。", block_id)
    elif value_type == "string":
        if not isinstance(value, str):
            raise ProgramError("PROGRAM_SCHEMA_INVALID", "这个位置需要文字。", block_id)
        max_length = int(field.get("maxLength", MAX_STRING_LENGTH))
        if len(value) > max_length:
            raise ProgramError("PROGRAM_SCHEMA_INVALID", "这句话太长啦。", block_id)
    elif value_type == "choice":
        if value not in field.get("choices", []):
            raise ProgramError("PROGRAM_SCHEMA_INVALID", "这个选项还不能用。", block_id)
    elif value_type == "boolean":
        if not isinstance(value, bool):
            raise ProgramError("PROGRAM_SCHEMA_INVALID", "这个位置需要一个开关。", block_id)
    elif value_type == "name":
        if not isinstance(value, str) or not value:
            raise ProgramError("PROGRAM_SCHEMA_INVALID", "这个位置需要一个名字。", block_id)
    elif value_type == "expression":
        if not isinstance(value, dict):
            raise ProgramError("PROGRAM_SCHEMA_INVALID", "这个位置需要一个值。", block_id)
        _validate_expression_node(value, registry, block_id, depth + 1, counter, seen_ids, max_depth, enforce_runnable)


def _validate_expression_node(
    node: dict[str, Any],
    registry: BlocksRegistry,
    parent_block_id: str,
    depth: int,
    counter: dict[str, int],
    seen_ids: set[str],
    max_depth: dict[str, int],
    enforce_runnable: bool,
) -> None:
    kind = node.get("kind")
    definition = registry.get(kind) if isinstance(kind, str) else None
    if definition is None or definition.output_type != "expression":
        raise ProgramError("PROGRAM_SCHEMA_INVALID", "这个位置需要一个数字或值。", parent_block_id)
    _validate_node(node, registry, depth, counter, seen_ids, max_depth, enforce_runnable, "expression")


def summarize_program(program: dict[str, Any], registry: BlocksRegistry | None = None) -> str:
    registry = registry or load_blocks()
    roots = program_roots(program, runnable_only=True)
    if roots:
        return " / ".join(_summarize_chain(root, registry) for root in roots)
    return "积木还没有接到「当开始」" if program_roots(program) else "画布还是空的"


def _summarize_chain(root: dict[str, Any], registry: BlocksRegistry) -> str:
    parts: list[str] = []
    node = root
    guard = 0
    while isinstance(node, dict) and guard < 50:
        guard += 1
        definition = registry.get(str(node.get("kind")))
        name = definition.display_name if definition else "未知积木"
        if node.get("kind") == "control.repeat":
            times = number_input_value((node.get("inputs") or {}).get("times", "?"))
            body_names = []
            for child in node.get("body") or []:
                while isinstance(child, dict) and len(body_names) < 20:
                    child_def = registry.get(str(child.get("kind")))
                    body_names.append(child_def.display_name if child_def else "未知积木")
                    child = child.get("next")
                if len(body_names) >= 20:
                    break
            inner = "、".join(body_names) if body_names else "没有动作"
            parts.append(f"重复 {times} 次（{inner}）")
        else:
            parts.append(name)
        node = node.get("next")
    return " → ".join(parts)


def evaluate_criteria(task: dict[str, Any], objects: list[dict[str, Any]]) -> tuple[bool, list[str]]:
    by_id = {str(item.get("id")): item for item in objects if isinstance(item, dict)}
    failures: list[str] = []
    for criterion in task.get("successCriteria", []):
        check = criterion.get("check") or {}
        target = by_id.get(str(check.get("object")))
        if target is None:
            failures.append(f"{criterion.get('description', '目标')}：没有读到角色状态")
            continue
        actual = target.get(str(check.get("field")))
        expected = check.get("value")
        op = check.get("op", "eq")
        try:
            okay = (
                (op == "eq" and float(actual) == float(expected))
                or (op == "ge" and float(actual) >= float(expected))
                or (op == "le" and float(actual) <= float(expected))
            )
        except (TypeError, ValueError):
            okay = False
        if not okay:
            failures.append(str(criterion.get("description", "目标还没有达到")))
    return (not failures, failures)
