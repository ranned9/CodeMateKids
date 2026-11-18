"""会话证据 → 模型协议字段的显式映射与安全降级。"""

from __future__ import annotations

from typing import Any

from backend.session.store import SOURCE_TYPES

MAX_DIAGNOSTICS = 20
MAX_FACT_CHARS = 120


def to_model_evidence(items: list[dict[str, Any]] | None) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    mapped: list[dict[str, Any]] = []
    diagnostics: list[dict[str, Any]] = []
    for item in items or []:
        if not isinstance(item, dict):
            _diagnose(diagnostics, "entry", "不是对象")
            continue
        source_type = item.get("sourceType")
        if source_type not in SOURCE_TYPES:
            _diagnose(diagnostics, "sourceType", "来源类型越界")
            continue
        fact = item.get("observedFact")
        if not isinstance(fact, str) or not fact.strip():
            _diagnose(diagnostics, "observedFact", "观察事实缺失")
            continue
        confidence = item.get("confidence")
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
            _diagnose(diagnostics, "confidence", "置信度类型错误")
            continue
        mapped.append(
            {
                "type": source_type,
                "fact": fact[:MAX_FACT_CHARS],
                "confidence": max(0.0, min(1.0, float(confidence))),
            }
        )
    return mapped, diagnostics


def _diagnose(diagnostics: list[dict[str, Any]], field: str, reason: str) -> None:
    if len(diagnostics) < MAX_DIAGNOSTICS:
        diagnostics.append({"field": field, "reason": reason})