"""RG-11：辅导回复包逐条校验、诊断定位与安全兜底。"""

from __future__ import annotations

import copy

from backend.service.content_validation import validate_reply_entries
from backend.service.course import load_course

BASE = {
    "taskId": "main",
    "errorPattern": "default",
    "learnerChoice": "hint",
    "level": 1,
    "action": "hint",
    "message": "看看重复次数和目标步数。",
    "nextStep": "把重复次数改成 4 试试",
    "uncertainty": "我还不确定你数出来是几。",
}


def _validate(case: dict):
    return validate_reply_entries([case], {"main", "variant"})


def test_valid_entry_passes() -> None:
    report = _validate(dict(BASE))
    assert len(report.valid) == 1
    assert report.diagnostics == []


def test_missing_field() -> None:
    case = dict(BASE)
    case.pop("action")
    report = _validate(case)
    assert report.valid == []
    assert report.diagnostics[0]["field"] == "action"


def test_level_string() -> None:
    report = _validate({**BASE, "level": "abc"})
    assert report.valid == []
    assert report.diagnostics[0]["field"] == "level"


def test_level_out_of_range() -> None:
    report = _validate({**BASE, "level": 9})
    assert report.valid == []


def test_unknown_action() -> None:
    report = _validate({**BASE, "action": "give_answer"})
    assert report.valid == []


def test_unknown_task_id() -> None:
    report = _validate({**BASE, "taskId": "other"})
    assert report.valid == []


def test_message_too_long() -> None:
    report = _validate({**BASE, "message": "长" * 121})
    assert report.valid == []


def test_level_zero_only_for_self_try_or_skip() -> None:
    report = _validate({**BASE, "level": 0})
    assert report.valid == []
    assert report.diagnostics[0]["field"] == "level"
    ok = _validate({**BASE, "level": 0, "learnerChoice": "self_try"})
    assert len(ok.valid) == 1


def test_all_invalid_report() -> None:
    report = validate_reply_entries([{"taskId": "main"}], {"main"})
    assert report.valid == []
    assert report.all_invalid is True
    assert report.diagnostics


def test_existing_content_has_no_diagnostics(settings) -> None:
    bundle = load_course(settings, refresh=True)
    assert bundle.reply_diagnostics == []
    assert bundle.replies


def test_tutor_api_survives_empty_reply_package(client, monkeypatch, settings) -> None:
    from backend.api.routers import tutor as tutor_router

    fake_bundle = copy.copy(load_course(settings))
    fake_bundle.replies = []
    monkeypatch.setattr(tutor_router, "load_course", lambda settings_arg: fake_bundle)
    response = client.post("/api/v1/tutor/hints", json={"taskId": "main", "learnerChoice": "hint"})
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["mode"] == "mock"
    assert data["message"]