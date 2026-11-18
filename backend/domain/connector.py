"""端口连接判定纯函数：后端权威实现，与前端读取同一份注册表。"""

from __future__ import annotations

from backend.domain.blocks import BlockDefinition, BlocksRegistry

REASON_TEXT = {
    "NEEDS_ACTION": "这里需要的是动作积木",
    "NEEDS_VALUE": "这个位置需要一个数字或值",
    "NOT_ALLOWED_HERE": "这个积木不能放在这里",
}


def source_output_type(definition: BlockDefinition | None) -> str:
    if definition is None:
        return "unknown"
    return definition.output_type


def can_connect(
    registry: BlocksRegistry,
    definition: BlockDefinition | None,
    target_port_type: str,
) -> tuple[bool, str | None]:
    if definition is None:
        return False, "NOT_ALLOWED_HERE"
    output_type = definition.output_type
    if registry.accepts(output_type, target_port_type):
        return True, None
    if target_port_type in ("statement-next", "statement-body"):
        return False, "NEEDS_ACTION"
    if target_port_type == "expression":
        return False, "NEEDS_VALUE"
    return False, "NOT_ALLOWED_HERE"


def reason_text(reason: str | None) -> str:
    if reason is None:
        return ""
    return REASON_TEXT.get(reason, REASON_TEXT["NOT_ALLOWED_HERE"])


def port_matrix(registry: BlocksRegistry) -> list[dict]:
    rows: list[dict] = []
    for output_type, targets in registry.port_rules.items():
        rows.append({"source": output_type, "targets": dict(targets)})
    return rows