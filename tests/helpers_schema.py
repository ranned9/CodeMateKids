"""极简 JSON Schema 子集校验器：供课程/辅导协议断言使用，不引入第三方依赖。"""

from __future__ import annotations

import re
from typing import Any

TYPE_MAP = {
    "object": dict,
    "array": list,
    "string": str,
    "integer": int,
    "number": (int, float),
    "boolean": bool,
    "null": type(None),
}


def _resolve(schema: dict[str, Any], root: dict[str, Any]) -> dict[str, Any]:
    ref = schema.get("$ref")
    if not ref or not ref.startswith("#/"):
        return schema
    target: Any = root
    for part in ref[2:].split("/"):
        target = target[part]
    return target


def _matches_type(value: Any, expected: Any) -> bool:
    names = expected if isinstance(expected, list) else [expected]
    for name in names:
        python_type = TYPE_MAP.get(name)
        if python_type is None:
            continue
        if name == "integer" and isinstance(value, bool):
            continue
        if isinstance(value, python_type):
            return True
    return False


def validate(instance: Any, schema: dict[str, Any], root: dict[str, Any] | None = None, path: str = "$") -> list[str]:
    root = root or schema
    schema = _resolve(schema, root)
    errors: list[str] = []

    expected = schema.get("type")
    if expected is not None and not _matches_type(instance, expected):
        errors.append(f"{path}: 类型应为 {expected}，实际 {type(instance).__name__}")
        return errors

    if "enum" in schema and instance not in schema["enum"]:
        errors.append(f"{path}: {instance!r} 不在枚举 {schema['enum']} 中")

    if "const" in schema and instance != schema["const"]:
        errors.append(f"{path}: 应等于常量 {schema['const']!r}")

    if isinstance(instance, str) and "pattern" in schema:
        if re.search(schema["pattern"], instance) is None:
            errors.append(f"{path}: {instance!r} 不匹配 {schema['pattern']}")

    if isinstance(instance, (int, float)) and not isinstance(instance, bool):
        if "minimum" in schema and instance < schema["minimum"]:
            errors.append(f"{path}: {instance} 小于 {schema['minimum']}")
        if "maximum" in schema and instance > schema["maximum"]:
            errors.append(f"{path}: {instance} 大于 {schema['maximum']}")

    if isinstance(instance, dict):
        properties = schema.get("properties") or {}
        for key in schema.get("required") or []:
            if key not in instance:
                errors.append(f"{path}: 缺少必填字段 {key}")
        if schema.get("additionalProperties") is False:
            for key in instance:
                if key not in properties:
                    errors.append(f"{path}: 不允许的字段 {key}")
        for key, value in instance.items():
            if key in properties:
                errors.extend(validate(value, properties[key], root, f"{path}.{key}"))
    elif isinstance(instance, list):
        if "minItems" in schema and len(instance) < schema["minItems"]:
            errors.append(f"{path}: 元素数 {len(instance)} 小于 {schema['minItems']}")
        if "maxItems" in schema and len(instance) > schema["maxItems"]:
            errors.append(f"{path}: 元素数 {len(instance)} 大于 {schema['maxItems']}")
        item_schema = schema.get("items")
        if item_schema:
            for index, item in enumerate(instance):
                errors.extend(validate(item, item_schema, root, f"{path}[{index}]"))
    return errors