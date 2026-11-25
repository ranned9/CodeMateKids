"""程序模型 → Python 3.12 AST/代码装配，并记录 blockId → 行号映射。"""

from __future__ import annotations

import ast
import json
from dataclasses import dataclass, field
from typing import Any

from backend.domain.blocks import BlocksRegistry, load_blocks
from backend.domain.program import ProgramError, move_step_count, number_input_value, program_roots, validate_program

TARGET_FILENAME = "<cmk-program>"


class CompilationError(ValueError):
    def __init__(self, message: str, block_id: str | None = None) -> None:
        self.message = message
        self.block_id = block_id
        super().__init__(message)


@dataclass
class CompiledProgram:
    source: str
    module: ast.Module
    line_map: dict[int, str] = field(default_factory=dict)
    block_lines: dict[str, tuple[int, int]] = field(default_factory=dict)


class _Emitter:
    def __init__(self, registry: BlocksRegistry) -> None:
        self.registry = registry
        self.lines: list[str] = []
        self.line_map: dict[int, str] = {}
        self.block_lines: dict[str, tuple[int, int]] = {}
        self._repeat_seq = 0

    def emit_line(self, text: str, block_id: str | None) -> int:
        self.lines.append(text)
        line_number = len(self.lines)
        if block_id:
            self.line_map[line_number] = block_id
        return line_number

    def emit_chain(self, node: dict[str, Any] | None, indent: int) -> None:
        guard = 0
        while isinstance(node, dict) and guard < 200:
            guard += 1
            self.emit_statement(node, indent)
            node = node.get("next")

    def emit_statement(self, node: dict[str, Any], indent: int) -> None:
        block_id = str(node.get("blockId") or "")
        kind = str(node.get("kind") or "")
        definition = self.registry.get(kind)
        if definition is None:
            raise CompilationError("这个积木现在不能运行", block_id)
        if not definition.runnable:
            raise CompilationError("这个积木现在不能运行", block_id)
        pad = " " * (indent * 4)
        inputs = node.get("inputs") or {}
        start_line = len(self.lines) + 1

        if kind == "event.start":
            self.emit_line(f"{pad}pass", block_id)
        elif kind in ("control.repeat", "control.if", "control.else"):
            if kind == "control.repeat":
                times = int(number_input_value(inputs["times"]))
                self._repeat_seq += 1
                self.emit_line(f"{pad}for _repeat_{self._repeat_seq} in range({times}):", block_id)
            elif kind == "control.if":
                operator = inputs["operator"]
                if operator not in (">=", "==", "<"):
                    raise CompilationError("这个比较方式还不能用", block_id)
                threshold = int(number_input_value(inputs["threshold"]))
                self.emit_line(f"{pad}if stage.steps {operator} {threshold}:", block_id)
            else:
                self.emit_line(f"{pad}else:", None)
                # else 的头部不是可跟踪的 Python 指令，使用 pass 作为单步入口。
                start_line = self.emit_line(f"{pad}    pass", block_id)
            body = node.get("body") or []
            for child in body:
                self.emit_chain(child, indent + 1)
            if not body and kind != "control.else":
                self.emit_line(f"{pad}    pass", block_id)
        elif kind == "motion.move":
            self.emit_line(f"{pad}stage.move({move_step_count(node)})", block_id)
        elif kind == "motion.turn":
            degrees = number_input_value(inputs.get("degrees", 90))
            if degrees not in (90, 180, 270):
                raise CompilationError("角度还不能用", block_id)
            self.emit_line(f"{pad}stage.turn({int(degrees)})", block_id)
        elif kind == "look.say":
            text = inputs.get("text", "")
            if not isinstance(text, str):
                raise CompilationError("要说的话需要文字", block_id)
            if len(text) > 20:
                raise CompilationError("这句话太长啦", block_id)
            self.emit_line(f"{pad}stage.say({json.dumps(text, ensure_ascii=False)})", block_id)
        elif kind == "text.print":
            expression = self.emit_expression(inputs.get("value"), block_id)
            self.emit_line(f"{pad}print({expression})", block_id)
        else:
            raise CompilationError("这个积木现在不能运行", block_id)

        end_line = len(self.lines)
        self.block_lines[block_id] = (start_line, end_line)

    def emit_expression(self, node: Any, parent_block_id: str) -> str:
        if not isinstance(node, dict):
            raise CompilationError("这个位置还需要一个值", parent_block_id)
        block_id = str(node.get("blockId") or "")
        kind = str(node.get("kind") or "")
        definition = self.registry.get(kind)
        if definition is None or definition.output_type != "expression":
            raise CompilationError("这个位置需要一个数字或值", parent_block_id)
        if not definition.runnable:
            raise CompilationError("这个积木现在不能运行", block_id)
        inputs = node.get("inputs") or {}
        if kind == "value.number":
            value = inputs.get("value", 0)
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise CompilationError("这里需要一个数字", block_id)
            if not 0 <= value <= 1000:
                raise CompilationError("这个数字超出范围", block_id)
            return str(value)
        if kind == "value.calc":
            left = self.emit_expression(inputs.get("left"), block_id)
            right = self.emit_expression(inputs.get("right"), block_id)
            op = inputs.get("op", "+")
            if op not in ("+", "-", "*", "/"):
                raise CompilationError("这个运算还不能用", block_id)
            return f"({left} {op} {right})"
        raise CompilationError("这个积木现在不能运行", block_id)


def compile_program(program: dict[str, Any], registry: BlocksRegistry | None = None) -> CompiledProgram:
    registry = registry or load_blocks()
    try:
        validate_program(program, registry)
    except ProgramError as exc:
        raise CompilationError(exc.message, exc.block_id) from exc

    emitter = _Emitter(registry)
    for root in program_roots(program, runnable_only=True):
        emitter.emit_chain(root, 0)
    if not emitter.lines:
        emitter.lines.append("pass")
    source = "\n".join(emitter.lines) + "\n"
    try:
        module = ast.parse(source, filename=TARGET_FILENAME, mode="exec")
    except SyntaxError as exc:
        line_no = int(exc.lineno or 1)
        block_id = emitter.line_map.get(line_no)
        if block_id is None and emitter.line_map:
            block_id = emitter.line_map[min(emitter.line_map)]
        raise CompilationError("积木还不能变成程序", block_id) from exc
    return CompiledProgram(source=source, module=module, line_map=emitter.line_map, block_lines=emitter.block_lines)
