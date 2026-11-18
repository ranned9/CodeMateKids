"""注入给目标程序的受控运行时：限制的内置函数、舞台对象与输出缓冲。"""

from __future__ import annotations

import builtins
from typing import Any, Callable

SAFE_BUILTIN_NAMES = (
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
)

BANNED_BUILTIN_NAMES = (
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
)


class Stage:
    """受控舞台对象：只暴露移动、转向与说话。"""

    def __init__(self) -> None:
        self.x = 0
        self.y = 0
        self.heading = 0
        self.said = ""
        self.steps = 0
        self.moves = 0

    def move(self, steps: Any) -> None:
        amount = int(steps)
        if amount < 0 or amount > 1000:
            raise ValueError("步数需要在 0 到 1000 之间")
        if self.heading == 0:
            self.x += amount
        elif self.heading == 90:
            self.y += amount
        elif self.heading == 180:
            self.x -= amount
        else:
            self.y -= amount
        self.steps += amount
        self.moves += 1

    def turn(self, degrees: Any) -> None:
        self.heading = (self.heading + int(degrees)) % 360

    def say(self, text: Any) -> None:
        self.said = str(text)[:40]

    def snapshot(self) -> dict[str, Any]:
        return {
            "id": "stage",
            "x": self.x,
            "y": self.y,
            "heading": self.heading,
            "said": self.said,
            "steps": self.steps,
            "moves": self.moves,
        }


class OutputBuffer:
    def __init__(self, limit_bytes: int) -> None:
        self.limit_bytes = limit_bytes
        self.parts: list[str] = []
        self.byte_count = 0
        self.truncated = False

    def append(self, text: str) -> str:
        if self.truncated:
            return ""
        encoded = text.encode("utf-8")
        remaining = self.limit_bytes - self.byte_count
        if remaining <= 0:
            self.truncated = True
            return ""
        if len(encoded) > remaining:
            accepted = encoded[:remaining].decode("utf-8", errors="ignore")
            self.truncated = True
            self.byte_count = self.limit_bytes
            self.parts.append(accepted)
            return accepted
        self.byte_count += len(encoded)
        self.parts.append(text)
        return text

    def value(self) -> str:
        return "".join(self.parts)


def safe_builtins() -> dict[str, Any]:
    result: dict[str, Any] = {}
    for name in SAFE_BUILTIN_NAMES:
        result[name] = getattr(builtins, name)
    return result


def make_globals(stage: Stage, printer: Callable[..., None]) -> dict[str, Any]:
    return {
        "__builtins__": safe_builtins(),
        "__name__": "__cmk_program__",
        "stage": stage,
        "print": printer,
    }