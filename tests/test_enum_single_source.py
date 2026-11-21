"""DV-AI-01：七组枚举单一真源，Python / Schema / 前端夹具三方一致。"""

from __future__ import annotations

import json
from pathlib import Path

from backend.service.content_validation import ERROR_PATTERNS
from backend.tutor import enums

ROOT = Path(__file__).resolve().parent.parent


def _fixture() -> dict:
    return json.loads((ROOT / "tests" / "fixtures" / "enums-expected.json").read_text(encoding="utf-8"))


def test_pattern_teaching_and_non_teaching_split() -> None:
    fixture = _fixture()
    assert list(enums.TEACHING_PATTERNS) == fixture["PATTERN_TEACHING"]
    assert list(enums.NON_TEACHING_PATTERNS) == fixture["PATTERN_NON_TEACHING"]
    assert list(enums.all_patterns()) == fixture["PATTERN_TEACHING"] + fixture["PATTERN_NON_TEACHING"]
    assert len(enums.TEACHING_PATTERNS) == 10, "design 2.3.3 文字写 9，清单为 10，以清单为准"


def test_content_validation_uses_single_source() -> None:
    assert set(ERROR_PATTERNS) == set(enums.all_patterns())
    assert "unknown" in ERROR_PATTERNS
    assert "default" in ERROR_PATTERNS


def test_remaining_enums_match_fixture() -> None:
    fixture = _fixture()
    assert list(enums.outcome_values()) == fixture["OUTCOME"]
    assert list(enums.trace_quality_values()) == fixture["TRACE_QUALITY"]
    assert list(enums.prediction_match_values()) == fixture["PREDICTION_MATCH"]
    assert list(enums.support_values()) == fixture["SUPPORT"]
    assert list(enums.transfer_status_values()) == fixture["TRANSFER_STATUS"]
    assert list(enums.next_action_values()) == fixture["NEXT_ACTION"]
    assert len(fixture["NEXT_ACTION"]) == 8


def test_tutor_protocol_schema_matches_when_extended() -> None:
    schema = json.loads((ROOT / "schemas" / "tutor_protocol.v1.json").read_text(encoding="utf-8"))
    decision = schema["$defs"]["tutorRequest"]["properties"].get("teachingDecision")
    if decision is None:
        return
    assert set(decision["properties"]["pattern"]["enum"]) == set(enums.TEACHING_PATTERNS)
    assert set(decision["properties"]["nextAction"]["enum"]) == set(enums.next_action_values())


def test_frontend_mirror_matches_fixture() -> None:
    source = (ROOT / "frontend" / "js" / "ux" / "enums.js").read_text(encoding="utf-8")
    fixture = _fixture()
    for value in fixture["NEXT_ACTION"]:
        assert f'"{value}"' in source, f"前端缺少 nextAction {value}"
    for value in fixture["SUPPORT"]:
        assert value in source, f"前端缺少 support {value}"
    assert "PATTERN" not in source, "前端不得导出判定用 pattern 集合"