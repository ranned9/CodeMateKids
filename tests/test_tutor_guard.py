"""辅导四重校验、安全文案与固定场景回归。"""

from __future__ import annotations

from backend.tutor.guard import validate_response

GOOD = {
    "action": "hint",
    "message": "看看重复次数和目标步数是不是一样。",
    "nextStep": "把重复次数改成 4 试试",
    "uncertainty": "我还不知道你数出来是几步。",
    "answerLevel": 1,
    "mode": "mock",
    "evidenceUsed": ["run_result"],
}


def test_good_response_passes() -> None:
    assert validate_response(GOOD)[0] is True


def test_message_too_long_rejected() -> None:
    bad = {**GOOD, "message": "很长的提示" * 30}
    assert validate_response(bad) == (False, "message_too_long")


def test_action_out_of_enum_rejected() -> None:
    assert validate_response({**GOOD, "action": "give_answer"})[0] is False


def test_diagnostic_claim_rejected() -> None:
    assert validate_response({**GOOD, "message": "你不会循环，需要多练。"})[0] is False


def test_path_and_stack_rejected() -> None:
    assert validate_response({**GOOD, "message": "看看 C:\\tmp\\demo.py 的报错。"})[0] is False


def test_personal_info_request_rejected() -> None:
    assert validate_response({**GOOD, "message": "请告诉我你的学校班级。"})[0] is False


def test_full_solution_too_early_rejected() -> None:
    bad = {**GOOD, "message": "for i in range(4): stage.move(1)", "answerLevel": 1}
    assert validate_response(bad)[0] is False
    assert validate_response({**GOOD, "answerLevel": 3})[0] is False
    assert validate_response({**GOOD, "answerLevel": 3}, allow_full_solution=True)[0] is True


def test_hint_api_returns_mock_and_first_level(client) -> None:
    response = client.post(
        "/api/v1/tutor/hints",
        json={
            "taskId": "main",
            "learnerChoice": "hint",
            "programSummary": "重复 2 次（向前走 1 步）",
            "programValid": True,
        },
    )
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["mode"] == "mock"
    assert data["showAsDemo"] is True
    assert data["answerLevel"] == 1
    assert data["action"] in {
        "ask_question",
        "hint",
        "point_to_block",
        "show_execution",
        "analogy",
        "partial_example",
        "break_down",
        "explain",
        "offer_variant",
    }
    assert len(data["message"]) <= 120
    assert data["nextStep"]
    assert data["uncertainty"]


def test_repeated_hint_changes_representation(client) -> None:
    first = client.post("/api/v1/tutor/hints", json={"taskId": "main", "learnerChoice": "hint"}).json()["data"]
    second = client.post("/api/v1/tutor/hints", json={"taskId": "main", "learnerChoice": "more_hint"}).json()["data"]
    assert second["answerLevel"] > first["answerLevel"] or second["action"] != first["action"]
    assert second["message"] != first["message"]


def test_direct_answer_request_gets_guidance_not_solution(client) -> None:
    data = client.post(
        "/api/v1/tutor/hints",
        json={"taskId": "main", "learnerChoice": "hint", "message": "直接告诉我答案吧"},
    ).json()["data"]
    assert data["answerLevel"] <= 2
    assert "for " not in data["message"]
    assert "range(" not in data["message"]


def test_personal_info_input_is_redirected(client) -> None:
    data = client.post(
        "/api/v1/tutor/hints",
        json={"taskId": "main", "learnerChoice": "none", "message": "我住在阳光小区，电话是 123"},
    ).json()["data"]
    assert "个人信息" in data["message"]
    assert "密码" not in data["message"]


def test_self_try_and_skip_respect_choice(client) -> None:
    self_try = client.post(
        "/api/v1/tutor/hints", json={"taskId": "main", "learnerChoice": "self_try"}
    ).json()["data"]
    assert "自己" in self_try["message"]
    skip = client.post(
        "/api/v1/tutor/hints", json={"taskId": "main", "learnerChoice": "skip"}
    ).json()["data"]
    assert skip["action"] == "offer_variant"


def test_guard_falls_back_on_bad_model_output(client, monkeypatch) -> None:
    from backend.api.routers import tutor as tutor_router

    def bad_reply(settings, context, decision, bundle=None):
        return {
            "action": "give_answer",
            "message": "答案：for i in range(4)",
            "nextStep": "",
            "uncertainty": "",
            "answerLevel": 3,
            "evidenceUsed": [],
            "mode": "mock",
            "showAsDemo": True,
        }

    monkeypatch.setattr(tutor_router.mock, "reply", bad_reply)
    data = client.post("/api/v1/tutor/hints", json={"taskId": "main"}).json()["data"]
    assert data["action"] == "hint"
    assert data["showAsDemo"] is True
    assert "range(" not in data["message"]