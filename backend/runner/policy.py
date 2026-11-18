"""二次白名单校验：拒绝类定义、导入、危险内置与危险属性调用。"""

from __future__ import annotations

import ast
from dataclasses import dataclass

from backend.runner.compiler import TARGET_FILENAME

REJECTED_NODE_TYPES = {
    "ClassDef": "类定义",
    "Import": "导入模块",
    "ImportFrom": "导入模块",
    "AsyncFunctionDef": "异步函数",
    "AsyncFor": "异步循环",
    "AsyncWith": "异步上下文",
    "Await": "异步等待",
    "Global": "全局声明",
    "Nonlocal": "非局部声明",
    "MatchClass": "类模式",
}

BANNED_NAMES = {
    "eval",
    "exec",
    "compile",
    "open",
    "__import__",
    "getattr",
    "setattr",
    "delattr",
    "globals",
    "locals",
    "vars",
    "input",
    "breakpoint",
    "memoryview",
    "object",
    "type",
    "super",
    "exit",
    "quit",
    "help",
}

ALLOWED_BUILTIN_CALLS = {
    "print",
    "len",
    "range",
    "str",
    "int",
    "float",
    "bool",
    "list",
    "tuple",
    "dict",
    "set",
    "abs",
    "min",
    "max",
    "sum",
    "sorted",
    "enumerate",
    "zip",
    "reversed",
    "round",
}

ALLOWED_STAGE_ATTRS = {"move", "turn", "say", "x", "y", "heading", "steps", "said"}


@dataclass
class PolicyViolation:
    node_type: str
    reason: str
    block_id: str | None = None
    line: int | None = None


def check_module(module: ast.Module, line_map: dict[int, str] | None = None) -> list[PolicyViolation]:
    line_map = line_map or {}
    violations: list[PolicyViolation] = []
    for node in ast.walk(module):
        node_type = type(node).__name__
        line = getattr(node, "lineno", None)
        block_id = line_map.get(line) if isinstance(line, int) else None

        if node_type in REJECTED_NODE_TYPES:
            violations.append(
                PolicyViolation(node_type, REJECTED_NODE_TYPES[node_type], block_id, line)
            )
            continue

        if isinstance(node, ast.Name):
            if node.id.startswith("__") or node.id in BANNED_NAMES:
                violations.append(PolicyViolation("Name", f"未批准名称 {node.id}", block_id, line))
            continue

        if isinstance(node, ast.Attribute):
            if node.attr.startswith("__"):
                violations.append(PolicyViolation("Attribute", "未批准属性", block_id, line))
            root = node.value
            if not (isinstance(root, ast.Name) and root.id == "stage"):
                violations.append(PolicyViolation("Attribute", "未批准属性访问", block_id, line))
            elif node.attr not in ALLOWED_STAGE_ATTRS:
                violations.append(PolicyViolation("Attribute", f"未批准属性 {node.attr}", block_id, line))
            continue

        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Name):
                if func.id not in ALLOWED_BUILTIN_CALLS:
                    violations.append(
                        PolicyViolation("Call", f"未批准调用 {func.id}", block_id, line)
                    )
            elif isinstance(func, ast.Attribute):
                if not isinstance(func.value, ast.Name) or func.value.id != "stage":
                    violations.append(PolicyViolation("Call", "未批准调用", block_id, line))
                elif func.attr not in ALLOWED_STAGE_ATTRS:
                    violations.append(
                        PolicyViolation("Call", f"未批准调用 {func.attr}", block_id, line)
                    )
            else:
                violations.append(PolicyViolation("Call", "未批准调用", block_id, line))
            continue

    return violations


def check_source(source: str) -> list[PolicyViolation]:
    module = ast.parse(source, filename=TARGET_FILENAME, mode="exec")
    return check_module(module, {})