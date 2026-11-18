"""能力矩阵加载、字段完整性校验与汇总计数。"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from backend.infra.config import BASE_DIR

MATRIX_PATH = BASE_DIR / "schemas" / "feature_matrix.v1.json"
STATUS_VALUES = (
    "not_started",
    "implemented",
    "tested",
    "limited",
    "rejected_by_policy",
    "blocked",
)
SANDBOX_CLASSES = ("allowed", "limited", "rejected")
REQUIRED_FIELDS = (
    "featureId",
    "category",
    "pythonConstruct",
    "grammarSupported",
    "runtimeSupported",
    "sandboxClass",
    "positiveTests",
    "negativeTests",
    "pythonReference",
    "status",
    "knownLimitations",
    "owner",
    "reviewedAt",
)


class MatrixInvalid(ValueError):
    pass


@dataclass
class MatrixView:
    schema_version: str
    entries: list[dict[str, Any]]
    counts: dict[str, int]
    total: int


def load_matrix(path: Path | None = None) -> MatrixView:
    target = Path(path) if path is not None else MATRIX_PATH
    try:
        with open(target, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise MatrixInvalid("能力矩阵无法读取") from exc
    if not isinstance(payload, dict):
        raise MatrixInvalid("能力矩阵结构错误")
    entries = payload.get("entries")
    if not isinstance(entries, list) or not entries:
        raise MatrixInvalid("能力矩阵为空")
    seen: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise MatrixInvalid("矩阵条目结构错误")
        for field in REQUIRED_FIELDS:
            if field not in entry:
                raise MatrixInvalid(f"矩阵条目缺少字段 {field}")
        feature_id = str(entry["featureId"])
        if feature_id in seen:
            raise MatrixInvalid("能力标识重复")
        seen.add(feature_id)
        if entry["status"] not in STATUS_VALUES:
            raise MatrixInvalid("能力状态越界")
        if entry["sandboxClass"] not in SANDBOX_CLASSES:
            raise MatrixInvalid("安全分类越界")
        if not isinstance(entry["positiveTests"], list) or not entry["positiveTests"]:
            raise MatrixInvalid("缺少正向用例")
        if not isinstance(entry["negativeTests"], list) or not entry["negativeTests"]:
            raise MatrixInvalid("缺少负向用例")
        if entry["status"] == "tested":
            raise MatrixInvalid("本期没有能力可标记 tested：需四项测试全通过后人工确认")
    counts = {status: 0 for status in STATUS_VALUES}
    for entry in entries:
        counts[str(entry["status"])] += 1
    return MatrixView(
        schema_version=str(payload.get("schemaVersion", "")),
        entries=entries,
        counts=counts,
        total=len(entries),
    )


def matrix_payload(view: MatrixView) -> dict[str, Any]:
    return {
        "schemaVersion": view.schema_version,
        "rule": "仅当正向、负向、运行语义与安全测试全部通过才可标记 tested",
        "entries": view.entries,
        "counts": view.counts,
        "total": view.total,
        "incompleteCount": view.counts["not_started"] + view.counts["blocked"],
        "limitedCount": view.counts["limited"] + view.counts["implemented"],
        "rejectedCount": view.counts["rejected_by_policy"],
        "testedCount": view.counts["tested"],
        "claim": "不代表已完整支持 Python 3.12",
    }