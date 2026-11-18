"""端口矩阵：5×6 全部 30 格与三类拒绝文案。"""

from __future__ import annotations

from backend.domain.blocks import BlockDefinition, load_blocks
from backend.domain.connector import can_connect, port_matrix, reason_text


def _definition(output_type: str) -> BlockDefinition:
    return BlockDefinition(
        kind=f"fake.{output_type}",
        display_name="测试积木",
        symbol="statement" if output_type == "statement" else "expression",
        output_type=output_type,
        syntax_category="control_flow",
        definition_version=1,
        ports=[],
        fields=[],
        scope_rule="none",
        target_anchor="python.statement",
        blocked_hint="",
        runnable=True,
        test_case_refs=["POS", "NEG"],
    )


def test_full_port_matrix() -> None:
    registry = load_blocks()
    for source in ("statement", "expression", "boolean", "pattern", "handler"):
        for target in (
            "statement-next",
            "statement-body",
            "expression",
            "boolean",
            "pattern",
            "handler",
        ):
            expected = registry.port_rules[source][target]
            actual, reason = can_connect(registry, _definition(source), target)
            assert actual is expected, (source, target)
            if expected:
                assert reason is None
            else:
                assert reason in {"NEEDS_ACTION", "NEEDS_VALUE", "NOT_ALLOWED_HERE"}


def test_child_friendly_rejection_text() -> None:
    registry = load_blocks()
    expression = _definition("expression")
    statement = _definition("statement")
    boolean = _definition("boolean")

    assert can_connect(registry, expression, "statement-body") == (False, "NEEDS_ACTION")
    assert reason_text("NEEDS_ACTION") == "这里需要的是动作积木"
    assert can_connect(registry, statement, "expression") == (False, "NEEDS_VALUE")
    assert reason_text("NEEDS_VALUE") == "这个位置需要一个数字或值"
    assert can_connect(registry, boolean, "statement-next") == (False, "NEEDS_ACTION")
    assert can_connect(registry, boolean, "pattern") == (False, "NOT_ALLOWED_HERE")
    assert reason_text("NOT_ALLOWED_HERE") == "这个积木不能放在这里"


def test_port_matrix_rows() -> None:
    rows = port_matrix(load_blocks())
    assert len(rows) == 5
    assert all(len(row["targets"]) == 6 for row in rows)