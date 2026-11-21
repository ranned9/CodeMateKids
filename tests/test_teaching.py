"""教学增强编排：learning 结构、fail-open 与决策函数。"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import replace
import json

import pytest

from backend.service.teaching import build_learning
from backend.tutor.diagnosis import Facts
from backend.tutor.engine import decide_with_facts
from backend.tutor.model import build_model_request
from tests.helpers import drain, node, program


def _task(*, square=False) -> dict:
    task = {
        "taskId": "main",
        "successCriteria": [{"check": {"object": "stage", "field": "steps", "op": "eq", "value": 4}}],
    }
    if square:
        task["taskId"] = "transfer-square"
        task["teaching"] = {"goalKind": "square", "suggestedStepsPerMove": 2}
        task["successCriteria"] = [{"check": {"object": "stage", "field": "steps", "op": "eq", "value": 8}}]
    return task


def _square_program() -> dict:
    root = node(
        "b-start",
        "event.start",
        {},
        nxt=node(
            "b-repeat",
            "control.repeat",
            {"times": 4},
            body=[node("b-move", "motion.move", {"steps": 2}), node("b-turn", "motion.turn", {"degrees": 90})],
        ),
    )
    return program(root, "transfer-square")


def _events() -> list[dict]:
    return [
        {"seq": 1, "blockId": "b-start", "kind": "block_enter"},
        {"seq": 2, "blockId": "b-start", "kind": "block_exit"},
        {"seq": 3, "blockId": "b-repeat", "kind": "block_enter"},
        {"seq": 4, "blockId": "b-repeat", "kind": "block_exit"},
        {"seq": 5, "blockId": "b-move", "kind": "block_enter"},
        {"seq": 6, "blockId": "b-move", "kind": "block_exit"},
        {"seq": 7, "blockId": "b-turn", "kind": "block_enter"},
        {"seq": 8, "blockId": "b-turn", "kind": "block_exit"},
    ]


def _stage(x=2, y=0, heading=0, steps=2, moves=1) -> list[dict]:
    return [{"id": "stage", "x": x, "y": y, "heading": heading, "said": "", "steps": steps, "moves": moves}]


def test_learning_has_six_keys_and_degrades_cleanly() -> None:
    learning = build_learning(
        program=program(node("b-start", "event.start", {})),
        task=_task(),
        run_result={"status": "completed", "objects": _stage(), "events": []},
        prediction={"match": "none", "value": 1},
    )
    assert learning is not None
    assert set(learning) == {"outcome", "pattern", "facts", "predictionMatch", "traceQuality", "replay"}
    assert learning["traceQuality"] == "unavailable"
    assert learning["replay"] is None


def test_learning_reports_verified_replay_for_square() -> None:
    learning = build_learning(
        program=_square_program(),
        task=_task(square=True),
        run_result={"status": "completed", "objects": _stage(2, 0, 90, 2, 1), "events": _events()},
        prediction={"match": "exact", "value": 1},
    )
    assert learning is not None
    assert learning["traceQuality"] == "verified"
    assert learning["replay"]["actions"][0]["steps"] == 2


def test_learning_fail_open_on_broken_program() -> None:
    learning = build_learning(
        program={"formatVersion": 2, "stacks": "bad"},
        task={"successCriteria": "bad"},
        run_result={"status": "completed", "objects": [], "events": []},
    )
    assert learning is None, "编排异常必须静默降级，不抛异常"


def test_decide_with_facts_keeps_level_zero() -> None:
    facts = Facts(runStatus="completed", targetSteps=4, actualSteps=2, moves=2)
    decision = decide_with_facts(facts, {"learner_choice": "self_try"})
    assert decision.level == 0
    assert decision.action == "hint"

    decision = decide_with_facts(facts, {"learner_choice": "skip"})
    assert decision.level == 0
    assert decision.action == "offer_variant"


def test_decide_with_facts_maps_patterns_to_actions() -> None:
    facts = Facts(
        runStatus="completed",
        targetSteps=6,
        actualSteps=4,
        moves=2,
        repeatTimes=2,
        stepsPerMove=2,
        suggestedStepsPerMove=2,
    )
    assert decide_with_facts(facts, {"learner_choice": "hint"}).error_pattern == "loop_count_mismatch"

    goal = Facts(runStatus="completed", targetSteps=4, actualSteps=4, moves=4, routeMet=True)
    decision = decide_with_facts(goal, {"learner_choice": "hint"})
    assert decision.action == "explain"
    assert decision.error_pattern == "goal_met"


def _learning_scope(client, task, workspace="ws-lesson") -> dict:
    course = client.get("/api/v1/course/demo-loop").json()["data"]
    return {"courseId": "demo-loop", "contentVersion": course["contentVersion"], "taskId": task, "workspaceId": workspace}


def _post(client, path, body) -> dict:
    response = client.post(f"/api/v1/{path}", json=body)
    assert response.status_code == 200, response.json()
    return response.json()["data"]


def _predict(client, scope, payload, value) -> str:
    return _post(client, "session/prediction", {
        "taskId": scope["taskId"], "value": value, "learningContext": {"scope": scope, "program": payload},
    })["predictionId"]


def _run(client, scope, payload, run_id, prediction_id, seen=()) -> dict:
    _post(client, "runs", {
        "requestId": run_id, "cancelToken": f"token-{run_id}", "taskId": scope["taskId"],
        "target": payload["target"], "courseRef": payload["courseRef"], "program": payload,
        "learningContext": {"scope": scope, "predictionId": prediction_id, "workspaceSource": "task", "seenHintIds": list(seen)},
    })
    frames, result = drain(client, run_id)
    assert sum(name == "result" for name, _ in frames) == 1
    assert result is not None
    return result


def _hint(client, scope, payload, run_id=None, choice="hint", seen=()) -> dict:
    return _post(client, "tutor/hints", {
        "taskId": scope["taskId"], "learnerChoice": choice,
        "learningContext": {"scope": scope, "program": payload, "runRequestId": run_id, "seenHintIds": list(seen)},
    })


def _distance_program(times, steps, outside=False) -> dict:
    move = node("b-move", "motion.move", {"steps": steps})
    repeat = node("b-repeat", "control.repeat", {"times": times}, [] if outside else [move], move if outside else None)
    return program(node("b-start", "event.start", {}, nxt=repeat), "variant")


def test_api_tutors_with_current_run_and_updates_after_edit(client, app) -> None:
    scope = _learning_scope(client, "variant")
    attempt = _distance_program(2, 2)
    prediction = _predict(client, scope, attempt, 2)
    run = _run(client, scope, attempt, "run-lesson-first", prediction)
    assert run["learning"]["pattern"] == "loop_count_mismatch"
    assert run["learning"]["predictionMatch"] == "exact"
    assert [(action["round"], action["totalSteps"]) for action in run["learning"]["replay"]["actions"]] == [(1, 2), (2, 4)]

    first = _hint(client, scope, attempt, run["requestId"])
    assert first["answerLevel"] == 1 and first["action"] == "ask_question"
    again = _hint(client, scope, attempt, run["requestId"], seen=[first["requestId"]])
    assert again["answerLevel"] == 1
    more = _hint(client, scope, attempt, run["requestId"], "more_hint", [first["requestId"]])
    assert more["learning"]["nextAction"] == "replay" and more["answerLevel"] == 2

    updated = deepcopy(attempt)
    updated["root"]["next"]["inputs"]["times"] = 3
    stale = _hint(client, scope, updated, run["requestId"])
    assert stale["learning"]["pattern"] == "not_run" and stale["learning"]["runRequestId"] is None
    finished = _run(client, scope, updated, "run-lesson-carried", prediction, [more["requestId"]])
    assert finished["success"] is True
    assert finished["learning"]["predictionMatch"] == "carried"
    assert any(item["sourceType"] == "edit_trace" for item in app.state.session.evidence_for("variant"))
    assert sum(item["requestId"] == first["requestId"] for item in app.state.session.evidence_for("variant")) == 1
    new_prediction = _predict(client, scope, updated, 6)
    finished = _run(client, scope, updated, "run-lesson-exact", new_prediction)
    assert finished["learning"]["pattern"] == "prediction_mismatch"


@pytest.mark.parametrize("times,steps,outside,pattern", [
    (2, 4, True, "action_outside_loop"),
    (3, 1, False, "move_steps_mismatch"),
])
def test_api_distinguishes_other_loop_errors(client, times, steps, outside, pattern) -> None:
    scope = _learning_scope(client, "variant")
    attempt = _distance_program(times, steps, outside)
    prediction = _predict(client, scope, attempt, 1)
    result = _run(client, scope, attempt, "run-loop-case", prediction)
    assert result["learning"]["pattern"] == pattern
    reply = _hint(client, scope, attempt, result["requestId"])
    assert reply["learning"]["anchorBlockId"] == "b-move"
    assert reply["learning"]["nextAction"] == "locate_block"


def test_api_square_checks_structure_and_summarizes_help(client) -> None:
    scope = _learning_scope(client, "transfer-square")
    attempt = _square_program()
    chain = None
    for index in range(4):
        turn = node(f"turn-{index}", "motion.turn", {"degrees": 90}, nxt=chain)
        chain = node(f"move-{index}", "motion.move", {"steps": 2}, nxt=turn)
    unrolled = program(node("b-start", "event.start", {}, nxt=chain), "transfer-square")
    result = _run(client, scope, unrolled, "run-square-unrolled", _predict(client, scope, unrolled, 4))
    assert result["success"] is False
    assert result["learning"]["routeMet"] is True and result["learning"]["structureMet"] is False
    assert result["learning"]["pattern"] == "square_loop_structure"
    hint = _hint(client, scope, unrolled, result["requestId"])

    result = _run(client, scope, attempt, "run-square-assisted", _predict(client, scope, attempt, 4), [hint["requestId"]])
    assert result["success"] is True and result["learning"]["structureMet"] is True
    assert len(result["learning"]["replay"]["actions"]) == 8
    summary = client.get("/api/v1/session/summary").json()["data"]
    assert summary["transfer"]["status"] == "completed" and summary["transfer"]["support"] == "assisted"

    fresh_scope = {**scope, "workspaceId": "ws-fresh-square"}
    result = _run(client, fresh_scope, attempt, "run-square-independent", _predict(client, fresh_scope, attempt, 4))
    assert result["success"] is True
    summary = client.get("/api/v1/session/summary").json()["data"]
    assert summary["transfer"]["support"] == "none"
    assert summary["transfer"]["runRequestId"] == result["requestId"]


def test_model_wording_cannot_replace_decision_or_invent_numeric_facts(client, app, monkeypatch) -> None:
    scope = _learning_scope(client, "variant")
    attempt = _distance_program(2, 2)
    result = _run(client, scope, attempt, "run-model-facts", _predict(client, scope, attempt, 2))
    from backend.tutor.model_config import ModelConfigStore
    app.state.settings = replace(app.state.settings, tutor_mode="model", model_endpoint="https://provider.example/tutor", model_key="test-key")
    app.state.model_config = ModelConfigStore(app.state.settings)
    model_text = "这次走了 99 步。再走一轮会怎样？"

    def model(settings, context, decision):
        payload = build_model_request(context, decision)
        assert payload["teachingDecision"]["pattern"] == "loop_count_mismatch"
        assert payload["teachingDecision"]["action"] == "ask_question"
        assert "actualSteps" in payload["teachingDecision"]["factIds"]
        assert all("program" not in item for item in payload["evidence"])
        return {
            "action": "ask_question", "message": model_text, "nextStep": "试着只改重复次数",
            "uncertainty": "", "answerLevel": 1, "mode": "model", "factIdsUsed": ["actualSteps"],
            "evidenceUsed": ["run_result"],
        }

    monkeypatch.setattr("backend.api.routers.tutor.call_model", model)
    rejected = _hint(client, scope, attempt, result["requestId"])
    assert rejected["mode"] == "mock" and rejected["fallbackReason"] == "guard:unsupported_number"
    model_text = "这次走了 4 步。再走一轮会怎样？"
    accepted = _hint(client, scope, attempt, result["requestId"])
    assert accepted["mode"] == "model"
    assert accepted["learning"] == rejected["learning"]


def _browser_headers(app):
    host = f"127.0.0.1:{app.state.settings.port}"
    return {"Host": host, "Origin": f"http://{host}"}


def _enable_web_model(client, app, transport):
    app.state.model_transport = transport
    app.state.model_resolver = lambda host: ["93.184.216.34"]
    headers = _browser_headers(app)
    test = client.post("/api/v1/tutor/model-config/test", headers=headers, json={
        "expectedRevision": 0, "baseUrl": "https://provider.example/v1", "model": "demo-model", "apiKey": "fixture-key",
    })
    assert test.status_code == 200, test.text
    candidate = test.json()["data"]
    enabled = client.post("/api/v1/tutor/model-config/activate", headers=headers, json={
        "expectedRevision": candidate["revision"], "testId": candidate["testId"],
    })
    assert enabled.status_code == 200, enabled.text
    assert enabled.json()["data"]["effectiveMode"] == "model"
    assert "fixture-key" not in enabled.text


def _completion(message, next_step, facts=(), **action):
    data = {"message": message, "nextStep": next_step, "uncertainty": "", "factIdsUsed": list(facts), **action}
    return json.dumps({"choices": [{"message": {"content": json.dumps(data)}, "finish_reason": "stop"}]}).encode()


def _browser_hint(client, app, scope, program, run_id, turn_id, message="", reply_to=None, status=200):
    response = client.post("/api/v1/tutor/hints", headers=_browser_headers(app), json={
        "taskId": scope["taskId"], "learnerChoice": "none" if message else "hint", "message": message,
        "learningContext": {"scope": scope, "program": program, "runRequestId": run_id,
                            "turnId": turn_id, "replyToTurnId": reply_to},
    })
    assert response.status_code == status, response.text
    return response.json().get("data")


def test_web_model_config_drives_classroom_reply_and_fallback(client, app) -> None:
    from backend.tutor.chat_adapter import ChatAdapterError

    upstream = []
    def transport(request, target, key, timeout):
        assert key == "fixture-key" and target.addresses == ("93.184.216.34",)
        assert request["model"] == "demo-model" and request["response_format"] == {"type": "json_object"}
        upstream.append(json.loads(request["messages"][1]["content"]))
        if upstream[-1].get("connectionTest"):
            return json.dumps({"choices": [{"message": {"content": '{"status":"ok"}'}, "finish_reason": "stop"}]}).encode()
        if len(upstream) == 3:
            return _completion("海龟动了四次、走了两步。", "看看刚才的积木。")
        if len(upstream) == 4:
            raise ChatAdapterError("rate_limit")
        if len(upstream) == 5:
            app.state.model_config.disable(1)
        return _completion("{{moves}}，{{actualSteps}}。再走一轮会怎样？", "看看重复次数。", ("moves", "actualSteps"))

    _enable_web_model(client, app, transport)
    scope = _learning_scope(client, "variant")
    attempt = _distance_program(2, 2)
    result = _run(client, scope, attempt, "run-web-model", _predict(client, scope, attempt, 2))
    reply = _browser_hint(client, app, scope, attempt, result["requestId"], "turn-web")
    assert reply["mode"] == "model" and reply["showAsDemo"] is False
    assert "前进了 2 次" in reply["message"] and "走了 4 步" in reply["message"]
    assert "{{" not in reply["message"]
    assert upstream[1]["facts"]["moves"].endswith("2 次")
    for index, reason in enumerate(("invalid_response", "rate_limit", "configuration_changed")):
        reply = _browser_hint(client, app, scope, attempt, result["requestId"], f"turn-fallback-{index}")
        assert reply["mode"] == "mock" and reply["fallbackReason"] == f"model:{reason}"
    reply = _browser_hint(client, app, scope, attempt, result["requestId"], "turn-disabled")
    assert reply["mode"] == "mock" and not reply.get("fallbackReason")
    assert len(upstream) == 5


def test_web_agent_changes_action_for_two_learner_answers(client, app) -> None:
    app.state.settings = replace(app.state.settings, tutor_agent_enabled=True)
    agent_calls = []

    def transport(request, target, key, timeout):
        data = json.loads(request["messages"][1]["content"])
        agent = data.get("agent")
        if agent is None:
            return _completion("{{moves}}，{{actualSteps}}。再走一轮会怎样？", "看看重复次数。", ("moves", "actualSteps"))
        agent_calls.append(agent)
        if not agent["answer"]:
            return _completion("你数的是前进次数，还是总步数？", "说说你刚才怎么数的。",
                               action="ask_question", targetRef=None, awaitingAnswer=True)
        if "每一步" in agent["answer"]:
            return _completion("看看回放。{{firstMove}}。", "比较前进和走过的距离。", ("firstMove",),
                               action="show_execution", targetRef="verifiedReplay", awaitingAnswer=False)
        return _completion("看看这块重复积木的数字。", "先核对你看到的重复次数。",
                           action="point_to_block", targetRef="loopBlock", awaitingAnswer=False)

    _enable_web_model(client, app, transport)
    for index, (answer, action) in enumerate((("我把每一步都算成一次移动。", "show_execution"), ("我以为这里是 4。", "point_to_block"))):
        scope = _learning_scope(client, "variant", f"agent-ws-{index}")
        attempt = _distance_program(2, 2)
        result = _run(client, scope, attempt, f"run-agent-{index}", _predict(client, scope, attempt, 4))
        run_id = result["requestId"]
        question = _browser_hint(client, app, scope, attempt, run_id, "turn-question")
        assert question["learning"]["awaitingAnswer"] is True
        reply = _browser_hint(client, app, scope, attempt, run_id, "turn-answer", answer, "turn-question")
        assert reply["action"] == action and reply["mode"] == "model"
        assert reply["learning"]["nextAction"] == ("replay" if index == 0 else "locate_block")
        if index == 1:
            assert reply["learning"]["anchorBlockId"] == "b-repeat"
        assert _browser_hint(client, app, scope, attempt, run_id, "turn-answer", answer, "turn-question") == reply
        _browser_hint(client, app, scope, attempt, run_id, "turn-conflict", answer, "turn-question", status=409)
    assert len(agent_calls) == 4 and agent_calls[-1]["history"][0]["action"] == "ask_question"
