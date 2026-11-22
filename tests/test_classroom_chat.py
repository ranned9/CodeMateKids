"""首版课堂对话、学生归属和跨进程记忆验收。"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from backend.app import create_app
from backend.infra.errors import ApiError
from tests.helpers import node, program
from tests.test_teaching import _browser_headers, _enable_web_model, _square_program


def _post(client, app, route, payload, student=None, status=200):
    headers = _browser_headers(app)
    if student:
        headers["X-CMK-Student-Id"] = student
    reply = client.post(f"/api/v1/{route}", headers=headers, json=payload)
    assert reply.status_code == status, reply.text
    return reply.json()["data"] if status == 200 else reply.json()["error"]


def _student(client, app, name):
    return _post(client, app, "students", {"displayName": name})["studentId"]


def _scope(client, task, workspace):
    version = client.get("/api/v1/course/demo-loop").json()["data"]["contentVersion"]
    return {"courseId": "demo-loop", "contentVersion": version, "taskId": task, "workspaceId": workspace}


def _program(task, times, steps, *, outside=False):
    move = node("move", "motion.move", {"steps": steps})
    loop = node("repeat", "control.repeat", {"times": times}, [] if outside else [move], move if outside else None)
    return program(node("start", "event.start", {}, nxt=loop), task)


def _chat(client, app, scope, snapshot, turn, message, *, student=None, reply_to=None, selected=None,
          run=None, seen=(), status=200):
    return _post(client, app, "tutor/chat", {
        "taskId": scope["taskId"], "message": message, "selectedBlockId": selected,
        "learningContext": {
            "scope": scope, "program": snapshot, "turnId": turn, "replyToTurnId": reply_to,
            "runRequestId": run, "seenHintIds": list(seen), "workspaceSource": "task",
        },
    }, student, status)


def _run(client, app, student, scope, snapshot, run_id, value, seen=()):
    prediction = _post(client, app, "session/prediction", {
        "taskId": scope["taskId"], "value": value, "learningContext": {"scope": scope, "program": snapshot},
    }, student)
    _post(client, app, "runs", {
        "requestId": run_id, "cancelToken": f"token-{run_id}", "taskId": scope["taskId"],
        "target": snapshot["target"], "courseRef": snapshot["courseRef"], "program": snapshot,
        "learningContext": {
            "scope": scope, "predictionId": prediction["predictionId"], "seenHintIds": list(seen),
            "workspaceSource": "task",
        },
    }, student)
    stream = client.get(f"/api/v1/runs/{run_id}/events", params={"studentId": student}, headers=_browser_headers(app))
    assert stream.status_code == 200, stream.text
    results = [json.loads(frame.split("data: ", 1)[1]) for frame in stream.text.split("\n\n") if "event: result\n" in frame]
    assert len(results) == 1
    return results[0]


def _progress(client, app, student):
    response = client.get(f"/api/v1/students/{student}/progress", headers=_browser_headers(app))
    assert response.status_code == 200
    return response.json()["data"]["observations"]


def test_chat_before_run_clarifies_and_continues_after_edit(client, app):
    scope = _scope(client, "main", "ws-local")
    before = _program("main", 3, 2, outside=True)
    after = _program("main", 3, 2)
    explain = _chat(client, app, scope, before, "one", "这里是什么意思？", selected="repeat")
    assert explain["action"] == "explain"
    assert "里面的动作" in explain["message"]
    assert explain["mode"] == "mock"
    _chat(client, app, scope, before, "two", "前进次数和总步数有什么区别？")
    question = _chat(client, app, scope, before, "three", "那个数字为什么不一样？")
    assert question["awaitingAnswer"]
    assert question["hintId"] is None
    assert "前进次数" in question["message"] and "总步数" in question["message"]

    answer = _chat(client, app, scope, after, "four", "后面那个", reply_to="three")
    assert answer["action"] == "explain"
    assert "总步数" in answer["message"]
    assert "这次海龟" not in answer["message"]
    assert _chat(client, app, scope, after, "four", "后面那个", reply_to="three") == answer
    conflict = _chat(client, app, scope, after, "four", "总步数", reply_to="three", status=409)
    assert conflict["code"] == "TUTOR_TURN_CONFLICT"
    edited = _chat(client, app, scope, after, "five", "这样呢？")
    assert "已经放进重复积木" in edited["message"]
    assert _chat(client, app, scope, after, "six", "我想自己试")["action"] == "stop_guidance"


def test_stuck_chat_edits_only_one_parameter_for_the_current_run(client, app):
    student = _student(client, app, "林林")
    scope = _scope(client, "main", "stuck-loop")
    snapshot = _program("main", 2, 1)
    stuck = "我卡住了，帮我改一步"
    unresolved = _chat(client, app, scope, snapshot, "unresolved", stuck, student=student)
    assert unresolved["awaitingAnswer"] and "edit" not in unresolved

    result = _run(client, app, student, scope, snapshot, "stuck-run", 2)
    assert result["learning"]["pattern"] == "loop_count_mismatch"
    explain = _chat(client, app, scope, snapshot, "explain-first", "我卡住了，先告诉我为什么",
                    student=student, run="stuck-run")
    assert "edit" not in explain
    edited = _chat(client, app, scope, snapshot, "edit-one", stuck, student=student, run="stuck-run")
    assert edited["action"] == "edit_block"
    assert edited["edit"] == {
        "blockId": "repeat", "field": "times", "before": 2, "after": 4, "previousSteps": 2, "previousMoves": 2,
    }
    assert _chat(client, app, scope, snapshot, "edit-one", stuck, student=student, run="stuck-run") == edited

    new_program = _program("main", 4, 1)
    stale = _chat(client, app, scope, new_program, "stale-run", stuck, student=student, run="stuck-run")
    assert "edit" not in stale
    result = _run(client, app, student, scope, new_program, "after-edit", 4, [edited["hintId"]])
    assert result["success"] is True
    observations = _progress(client, app, student)
    assert observations[0]["details"]["support"] == "assisted"


def test_explicit_edit_rejects_ambiguous_or_invalid_commands(client, app):
    scope = _scope(client, "main", "explicit-edit")
    snapshot = _program("main", 2, 1)
    edited = _chat(client, app, scope, snapshot, "one", "把这块的次数改成三次", selected="repeat")
    assert edited["edit"]["after"] == 3
    for turn, message, selected in (
        ("two", "把这块的次数改成三次", None),
        ("three", "把重复次数改成零", "repeat"),
        ("four", "把次数和步数改成三", "repeat"),
        ("five", "把重复次数改成三次会怎样？", "repeat"),
        ("six", "把前进步数改成三步", "move"),
    ):
        assert "edit" not in _chat(client, app, scope, snapshot, turn, message, selected=selected)


def test_model_receives_sanitized_history_across_program_versions(client, app):
    contexts = []

    def upstream(request, *_):
        context = json.loads(request["messages"][1]["content"])
        if context.get("connectionTest"):
            data = {"status": "ok"}
        else:
            contexts.append(context)
            data = {
                "message": "每执行一次前进，海龟都会走一段。你想一起看看吗？",
                "action": "explain", "targetRef": "selectedBlock", "awaitingAnswer": True,
                "factIdsUsed": ["repeatTimes"], "observation": None,
            }
        return json.dumps({"choices": [{"message": {"content": json.dumps(data)}, "finish_reason": "stop"}]}).encode()

    _enable_web_model(client, app, upstream)
    scope = _scope(client, "main", "model-edit")
    before = _program("main", 3, 2)
    after = _program("main", 2, 2)
    reply = _chat(client, app, scope, before, "a", "这里是什么意思", selected="repeat")
    assert reply["mode"] == "model"
    assert reply["awaitingAnswer"] is True
    assert reply["controls"] == []
    assert _chat(client, app, scope, after, "b", "这样呢？")["mode"] == "model"
    assert contexts[-1]["history"][0]["sameProgram"] is False
    assert contexts[-1]["hasCurrentRun"] is False
    assert contexts[-1]["history"][0]["learner"] == "这里是什么意思"
    private = _chat(client, app, scope, after, "c", "我叫小朋友")
    assert private["mode"] == "mock"
    school = _chat(client, app, scope, after, "d", "我在示例小学上学")
    assert school["mode"] == "mock"
    assert len(contexts) == 2


def test_chat_fallback_answers_the_question_when_model_repeats_or_fails(client, app):
    repeated_question = "你想先看积木，还是刚才的运行？"

    def upstream(request, *_):
        context = json.loads(request["messages"][1]["content"])
        if context.get("connectionTest"):
            data = {"status": "ok"}
        elif context["message"] == "这题要做什么？":
            data = {"message": "缺少动作字段"}
        else:
            data = {
                "message": repeated_question, "action": "ask_question", "targetRef": None,
                "awaitingAnswer": True, "factIdsUsed": [], "observation": None,
            }
        return json.dumps({"choices": [{"message": {"content": json.dumps(data)}, "finish_reason": "stop"}]}).encode()

    _enable_web_model(client, app, upstream)
    scope = _scope(client, "main", "ws-fallback")
    snapshot = _program("main", 2, 1)
    first = _chat(client, app, scope, snapshot, "first", "我能问一下吗？")
    assert first["mode"] == "model" and first["message"] == repeated_question

    second = _chat(client, app, scope, snapshot, "second", "转个弯怎么用？", reply_to="first")
    assert second["mode"] == "mock" and second["fallbackReason"] == "repeated_question"
    assert second["action"] == "explain" and "改变" in second["message"]

    third = _chat(client, app, scope, snapshot, "third", "这题要做什么？")
    assert third["mode"] == "mock" and third["fallbackReason"] == "invalid_response"
    assert third["action"] == "explain" and "累计走 4 步" in third["message"]


def test_profiles_isolate_run_evidence_and_adapt_after_restart(client, app, settings):
    helped = _student(client, app, "林林")
    independent = _student(client, app, "安安")
    main = _scope(client, "main", "same-workspace")
    variant = _scope(client, "variant", "other-exercise")
    main_program = _program("main", 2, 2)
    variant_program = _program("variant", 3, 2)

    hint = _chat(client, app, main, main_program, "same-turn", "我把每一步都算成一次移动。", student=helped)
    assert hint["hintId"]
    assert _run(client, app, helped, main, main_program, "helped-run", 2, [hint["hintId"]])["success"]
    edited_program = _program("main", 3, 2)
    stale = _chat(client, app, main, edited_program, "after-edit", "我把每一步都算成一次移动。",
                  student=helped, run="helped-run")
    assert stale["controls"] == []
    assert _run(client, app, helped, main, main_program, "helped-again", 2)["success"]
    denied = client.get("/api/v1/runs/helped-run/events", params={"studentId": independent}, headers=_browser_headers(app))
    assert denied.status_code == 404
    denied = client.get("/api/v1/runs/helped-run", headers={
        **_browser_headers(app), "X-CMK-Student-Id": independent,
    })
    assert denied.status_code == 404
    unpredicted = _post(client, app, "runs", {
        "requestId": "other-run", "cancelToken": "other-token", "taskId": "main",
        "target": main_program["target"], "courseRef": main_program["courseRef"], "program": main_program,
    }, independent, status=409)
    assert unpredicted["code"] == "PREDICTION_REQUIRED"
    assert _run(client, app, independent, main, main_program, "solo-main", 2)["success"]
    assert _run(client, app, independent, variant, variant_program, "solo-variant", 3)["success"]

    restarted = create_app(settings)
    with TestClient(restarted) as fresh:
        before = _progress(fresh, restarted, helped)
        assert {item["kind"] for item in before} == {"dialogue_signal", "hint_shown", "run_result"}
        assert all(item["details"]["support"] == "assisted" for item in before if item["kind"] == "run_result")
        assert all(item["details"]["support"] == "none" for item in _progress(fresh, restarted, independent))
        next_scope = _scope(fresh, "variant", "same-workspace-after-restart")
        prompt = "这个要怎么算？"
        first = _chat(fresh, restarted, next_scope, variant_program, "turn-a", prompt, student=helped)
        second = _chat(fresh, restarted, next_scope, variant_program, "turn-a", prompt, student=independent)
        assert "每次前进走一步" in first["message"]
        assert "用自己的方法预测" in second["message"]


def test_storage_write_failure_still_returns_reply(client, app, monkeypatch):
    student = _student(client, app, "林林")
    scope = _scope(client, "main", "storage-recovery")
    snapshot = _program("main", 2, 2)
    original = app.state.learning.observe

    def unavailable(*args):
        raise ApiError("LEARNING_STORE_UNAVAILABLE")

    monkeypatch.setattr(app.state.learning, "observe", unavailable)
    reply = _chat(client, app, scope, snapshot, "failed-write", "我把每一步都算成一次移动。", student=student)
    assert reply["memorySaved"] is False
    assert reply["message"]
    assert _progress(client, app, student) == []

    monkeypatch.setattr(app.state.learning, "observe", original)
    reply = _chat(client, app, scope, snapshot, "recovered-write", "我把每一步都算成一次移动。", student=student)
    assert reply.get("memorySaved") is not False
    assert len(_progress(client, app, student)) == 1


def test_square_chat_distinguishes_route_from_loop_structure(client, app):
    student = _student(client, app, "乐乐")
    scope = _scope(client, "transfer-square", "square-lesson")
    chain = None
    for index in range(4):
        turn = node(f"turn-{index}", "motion.turn", {"degrees": 90}, nxt=chain)
        chain = node(f"move-{index}", "motion.move", {"steps": 2}, nxt=turn)
    unrolled = program(node("start", "event.start", {}, nxt=chain), "transfer-square")
    result = _run(client, app, student, scope, unrolled, "unrolled-square", 4)
    assert result["learning"]["routeMet"] is True
    assert result["learning"]["structureMet"] is False
    reply = _chat(client, app, scope, unrolled, "unrolled", "为什么回到起点还没完成？",
                  student=student, run="unrolled-square")
    assert "路线已经走对了" in reply["message"]
    assert "同一个重复积木" in reply["message"]

    loop = _square_program()
    result = _run(client, app, student, scope, loop, "loop-square", 4, [reply["hintId"]])
    assert result["success"] is True
    reply = _chat(client, app, scope, loop, "loop", "这样呢？", student=student, run="loop-square")
    assert "达到目标了" in reply["message"]
