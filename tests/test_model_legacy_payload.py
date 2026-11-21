"""WM-RG-09：旧网关载荷零变更基线。"""

from __future__ import annotations

import json
import re
from pathlib import Path

from backend.tutor.model import build_model_request

ROOT = Path(__file__).resolve().parent.parent
LEGACY_KEYS = {
    "protocolVersion",
    "requestId",
    "mode",
    "locale",
    "taskContext",
    "programSummary",
    "evidence",
    "learnerChoice",
    "safety",
}


def _request() -> dict:
    return build_model_request(
        {
            "request_id": "tutor-1",
            "task_id": "main",
            "objective": "让角色走四步",
            "program_summary": "重复 2 次",
            "evidence": [],
        },
        None,
    )


def test_legacy_payload_has_exactly_nine_keys() -> None:
    assert set(_request()) == LEGACY_KEYS
    assert set(_request()["taskContext"]) == {"courseId", "taskId", "objective"}
    assert set(_request()["programSummary"]) == {"valid", "summary", "lastRunStatus"}
    assert set(_request()["safety"]) == {"demoDataOnly"}


def test_extra_key_is_detected() -> None:
    payload = _request()
    payload["teachingDecision"] = {"action": "hint"}
    assert set(payload) != LEGACY_KEYS


def test_schema_still_forbids_extra_properties() -> None:
    schema = json.loads((ROOT / "schemas" / "tutor_protocol.v1.json").read_text(encoding="utf-8"))
    assert schema["$defs"]["tutorRequest"]["additionalProperties"] is False
    assert schema["$defs"]["tutorResponse"]["additionalProperties"] is False


def test_model_module_has_no_web_adapter_code() -> None:
    source = (ROOT / "backend" / "tutor" / "model.py").read_text(encoding="utf-8")
    assert "chat/completions" not in source
    assert "response_format" not in source
    assert re.search(r"def\s+build_model_request\(", source)