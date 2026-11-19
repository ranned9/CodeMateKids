"""积木注册表加载与查询：前后端连接判定的唯一真源。"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

PORT_TYPES = (
    "statement-next",
    "statement-body",
    "expression",
    "boolean",
    "pattern",
    "handler",
)
OUTPUT_TYPES = ("statement", "expression", "boolean", "pattern", "handler")
FIELD_TYPES = ("number", "integer", "string", "name", "boolean", "choice", "expression")


class BlockSchemaError(ValueError):
    """积木注册表损坏。"""


@dataclass(frozen=True)
class BlockDefinition:
    kind: str
    display_name: str
    symbol: str
    output_type: str
    syntax_category: str
    definition_version: int
    ports: list[dict[str, Any]]
    fields: list[dict[str, Any]]
    scope_rule: str
    target_anchor: str
    blocked_hint: str
    runnable: bool
    test_case_refs: list[str]

    def field(self, name: str) -> dict[str, Any] | None:
        for item in self.fields:
            if item.get("name") == name:
                return item
        return None


class BlocksRegistry:
    def __init__(self, payload: dict[str, Any], path: Path) -> None:
        self.payload = payload
        self.path = path
        self.schema_version: str = payload["schemaVersion"]
        self.port_rules: dict[str, dict[str, bool]] = payload["portRules"]
        self.blocks: dict[str, BlockDefinition] = {}
        self.rejected: dict[str, dict[str, Any]] = {}
        for raw in payload["blocks"]:
            definition = BlockDefinition(
                kind=raw["kind"],
                display_name=raw["displayName"],
                symbol=raw["symbol"],
                output_type=raw["outputType"],
                syntax_category=raw["syntaxCategory"],
                definition_version=raw["definitionVersion"],
                ports=raw["ports"],
                fields=raw["fields"],
                scope_rule=raw["scopeRule"],
                target_anchor=raw["targetAnchor"],
                blocked_hint=raw["blockedHint"],
                runnable=raw["runnable"],
                test_case_refs=raw["testCaseRefs"],
            )
            self.blocks[definition.kind] = definition
        for raw in payload.get("rejectedKinds", []):
            self.rejected[raw["kind"]] = raw

    def get(self, kind: str) -> BlockDefinition | None:
        return self.blocks.get(kind)

    def is_runnable(self, kind: str) -> bool:
        definition = self.blocks.get(kind)
        return bool(definition and definition.runnable)

    def accepts(self, output_type: str, target_port: str) -> bool:
        row = self.port_rules.get(output_type)
        if row is None:
            return False
        return bool(row.get(target_port))

    def as_response(self) -> dict[str, Any]:
        return {
            "schemaVersion": self.schema_version,
            "blocks": self.payload["blocks"],
            "portRules": self.port_rules,
            "portTypes": list(PORT_TYPES),
            "rejectedKinds": self.payload.get("rejectedKinds", []),
        }


_CACHE: dict[str, BlocksRegistry] = {}


def default_blocks_path() -> Path:
    return Path(__file__).resolve().parents[2] / "schemas" / "blocks.v1.json"


def load_blocks(path: Path | None = None) -> BlocksRegistry:
    target = Path(path) if path is not None else default_blocks_path()
    key = str(target)
    cached = _CACHE.get(key)
    if cached is not None:
        return cached

    try:
        with open(target, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise BlockSchemaError("积木注册表无法读取") from exc

    validate_payload(payload)
    registry = BlocksRegistry(payload, target)
    _CACHE[key] = registry
    return registry


def validate_payload(payload: dict[str, Any]) -> None:
    required_root = ("schemaVersion", "portRules", "blocks", "rejectedKinds")
    for key in required_root:
        if key not in payload:
            raise BlockSchemaError(f"缺少字段 {key}")

    rules = payload["portRules"]
    for output_type in OUTPUT_TYPES:
        row = rules.get(output_type)
        if not isinstance(row, dict):
            raise BlockSchemaError(f"端口规则缺少源类型 {output_type}")
        for target in PORT_TYPES:
            if target not in row:
                raise BlockSchemaError(f"端口规则缺少 {output_type} -> {target}")

    seen: set[str] = set()
    for raw in payload["blocks"]:
        kind = raw.get("kind")
        if not kind or kind in seen:
            raise BlockSchemaError("积木标识缺失或重复")
        seen.add(kind)
        name = raw.get("displayName", "")
        if not name or len(name) > 8:
            raise BlockSchemaError(f"{kind} 显示名不合规")
        if raw.get("outputType") not in OUTPUT_TYPES:
            raise BlockSchemaError(f"{kind} 输出类型非法")
        if not isinstance(raw.get("ports"), list) or not raw["ports"]:
            raise BlockSchemaError(f"{kind} 端口缺失")
        for port in raw["ports"]:
            if port.get("portType") not in PORT_TYPES:
                raise BlockSchemaError(f"{kind} 端口类型非法")
        if not isinstance(raw.get("fields"), list):
            raise BlockSchemaError(f"{kind} 字段列表非法")
        for field in raw["fields"]:
            if field.get("valueType") not in FIELD_TYPES:
                raise BlockSchemaError(f"{kind} 字段类型非法")
        refs = raw.get("testCaseRefs", [])
        if not isinstance(refs, list) or len(refs) < 2:
            raise BlockSchemaError(f"{kind} 测试用例引用不足")
        if not isinstance(raw.get("runnable"), bool):
            raise BlockSchemaError(f"{kind} runnable 标记缺失")

    for raw in payload.get("rejectedKinds", []):
        if raw.get("runnable") is not False:
            raise BlockSchemaError("策略拒绝积木必须标记 runnable: false")
