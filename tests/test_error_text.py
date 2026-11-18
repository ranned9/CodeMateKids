"""错误码文案：儿童可见文本不含堆栈、路径、环境变量或主机名。"""

from __future__ import annotations

import pytest

from backend.infra.errors import ERROR_SPECS, ApiError, child_message_is_safe, error_object

FORBIDDEN_TOKENS = (
    "traceback",
    "c:\\",
    "c:/",
    "/home/",
    ".py",
    "path=",
    "localhost",
    "127.0.0.1",
    "site-packages",
    "systemroot",
    "hostname",
)


@pytest.mark.parametrize("code", sorted(ERROR_SPECS))
def test_each_child_message_is_safe(code: str) -> None:
    message = ERROR_SPECS[code].message_for_child
    assert child_message_is_safe(message), code
    lowered = message.lower()
    for token in FORBIDDEN_TOKENS:
        assert token not in lowered, (code, token)


def test_unsafe_custom_message_is_replaced() -> None:
    error = ApiError("PYTHON_RUNTIME_ERROR", "b-1", "Traceback: C:\\tmp\\x.py 第 3 行")
    payload = error.to_error()
    assert "Traceback" not in payload["messageForChild"]
    assert "C:\\" not in payload["messageForChild"]
    assert payload["blockId"] == "b-1"


def test_error_object_fields_are_exact() -> None:
    payload = error_object("RUN_TIMEOUT", "b-2")
    assert set(payload) == {"code", "category", "messageForChild", "blockId", "recoverable"}
    assert "messageForDeveloper" not in payload


def test_api_errors_use_envelope_only(client) -> None:
    response = client.get("/api/v1/course/nope")
    assert response.status_code == 409
    payload = response.json()
    assert set(payload) == {"ok", "error"}
    assert payload["ok"] is False
    assert set(payload["error"]) == {"code", "category", "messageForChild", "blockId", "recoverable"}
    assert child_message_is_safe(payload["error"]["messageForChild"])


def test_categories_are_distinct() -> None:
    categories = [spec.category for spec in ERROR_SPECS.values()]
    required = {
        "editor",
        "input",
        "environment",
        "policy",
        "compile",
        "runtime",
        "timeout",
        "resource",
        "cancelled",
        "worker",
        "ai",
        "content",
    }
    assert required <= set(categories)
    non_required = [item for item in categories if item not in required]
    assert len(non_required) == len(set(non_required))