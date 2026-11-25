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


def test_step_result_question_uses_stage_facts_even_when_model_reply_is_invalid(client, app):
    contexts = []

    def upstream(request, *_):
        context = json.loads(request["messages"][1]["content"])
        if context.get("connectionTest"):
            data = {"status": "ok"}
        else:
            contexts.append(context)
            data = {"message": "这次海龟走了九步。"}
        return json.dumps({"choices": [{"message": {"content": json.dumps(data)}, "finish_reason": "stop"}]}).encode()

    _enable_web_model(client, app, upstream)
    student = _student(client, app, "安安")
    scope = _scope(client, "main", "step-reading")
    snapshot = _program("main", 3, 1)
    question = "怎么看这是不是走4步"
    before = _chat(client, app, scope, snapshot, "before", question, student=student)
    assert before["action"] == "explain" and before["fallbackReason"] == "invalid_response"
    assert "舞台下方" in before["message"] and "累计走了 … 步" in before["message"]
    assert "actualSteps" not in contexts[-1]["facts"]

    _run(client, app, student, scope, snapshot, "three-steps", 4)
    reply = _chat(client, app, scope, snapshot, "after", question, student=student, run="three-steps")
    assert reply["action"] == "explain" and reply["fallbackReason"] == "invalid_response"
    assert "累计走了 3 步" in reply["message"]
    assert "目标是 4 步" in reply["message"] and "还差 1 步" in reply["message"]
    assert "actualSteps" in contexts[-1]["facts"]

    edited = _program("main", 4, 1)
    stale = _chat(client, app, scope, edited, "edited", "怎么知道有没有走四步？",
                  student=student, run="three-steps")
    assert "累计走了 … 步" in stale["message"]
    assert "actualSteps" not in contexts[-1]["facts"]


def test_greeting_and_feelings_do_not_trigger_block_diagnosis(client, app):
    student = _student(client, app, "安安")
    scope = _scope(client, "main", "social-turn")
    invalid = _program("main", 0, 1)
    for index, (message, expected) in enumerate((
        ("Hello。", "你好呀！"),
        ("谢谢你！", "不客气"),
        ("我今天很累", "歇一会儿"),
    )):
        reply = _chat(client, app, scope, invalid, f"social-{index}", message, student=student, selected="repeat")
        assert reply["action"] == "conversation" and expected in reply["message"]
        assert reply["hintId"] is None and reply["controls"] == [] and "edit" not in reply
    assert _progress(client, app, student) == []

    lesson = _chat(client, app, scope, invalid, "mixed", "你好，重复积木是什么意思？", student=student)
    assert lesson["action"] == "explain"
    assert lesson["message"].startswith("你好呀！")
    assert "里面的动作" in lesson["message"]
    starter = _chat(client, app, scope, invalid, "getting-started", "我应该从哪里开始？", student=student)
    assert starter["action"] == "hint" and "累计走" in starter["message"]


def test_web_model_uses_the_same_context_for_small_talk_and_unclear_questions(client, app):
    contexts = []

    def upstream(request, *_):
        context = json.loads(request["messages"][1]["content"])
        if context.get("connectionTest"):
            message = '{"status":"ok"}'
        else:
            assert "response_format" not in request
            contexts.append(context)
            message = {
                "Hello。": "你好呀！",
                "我最喜欢蓝色。你呢？": "我也喜欢晴天那样的蓝色。",
                "那刚才那个呢？": '看舞台下方，海龟一共走了 3 步。\n@课堂 {"action":"explain"}',
            }[context["message"]]
        return json.dumps({"choices": [{"message": {"content": message}, "finish_reason": "stop"}]}).encode()

    student = _student(client, app, "宁宁")
    scope = _scope(client, "main", "social-model")
    snapshot = _program("main", 3, 1)
    practice = _scope(client, "main", "earlier-practice")
    _chat(client, app, practice, snapshot, "counting", "我把每一步都算成一次移动。", student=student)
    _run(client, app, student, scope, snapshot, "three", 4)
    _enable_web_model(client, app, upstream)
    greeting = _chat(client, app, scope, snapshot, "hello", "Hello。", student=student)
    assert greeting["message"] == "你好呀！"
    assert greeting["mode"] == "model"
    reply = _chat(client, app, scope, snapshot, "small-talk", "我最喜欢蓝色。你呢？", student=student, selected="repeat")
    assert reply["mode"] == "model" and reply["action"] == "conversation"
    assert reply["hintId"] is None
    assert contexts[-1]["history"][0]["learner"] == "Hello。"
    assert contexts[-1]["selectedBlockKind"] == "control.repeat"
    assert contexts[-1]["teachingApproach"] == "check_counts"
    continued = _chat(client, app, scope, snapshot, "continued", "那刚才那个呢？", student=student, run="three")
    assert continued["mode"] == "model" and continued["action"] == "explain"
    assert continued["message"] == "看舞台下方，海龟一共走了 3 步。"
    assert contexts[-1]["facts"]["actualSteps"] == "一共走了 3 步"
    assert [turn["learner"] for turn in contexts[-1]["history"]] == ["Hello。", "我最喜欢蓝色。你呢？"]


def test_invalid_optional_actions_keep_the_model_answer_without_controls(client, app):
    answers = {
        "这样呢？": '{"message":"这里可以先看循环里的动作。"}',
        "帮我看看": '可以先看看「重复几次」积木。\n@课堂 {"action":"edit_block","targetRef":"repeat"}',
        "能回放吗？": '你可以先运行这版积木。\n@课堂 {"action":"show_execution","targetRef":"verifiedReplay"}',
        "黄色那块呢？": '黄色的积木控制重复。\n@课堂 {未完成',
    }

    def upstream(request, *_):
        context = json.loads(request["messages"][1]["content"])
        answer = '{"status":"ok"}' if context.get("connectionTest") else answers[context["message"]]
        return json.dumps({"choices": [{"message": {"content": answer}, "finish_reason": "stop"}]}).encode()

    _enable_web_model(client, app, upstream)
    scope = _scope(client, "main", "optional-controls")
    snapshot = _program("main", 3, 1)
    for index, message in enumerate(answers):
        reply = _chat(client, app, scope, snapshot, f"optional-{index}", message, selected="repeat")
        assert reply["mode"] == "model" and reply["fallbackReason"] is None
        assert reply["controls"] == [] and "edit" not in reply
        assert "@课堂" not in reply["message"]


def test_gentle_return_to_task_only_once_per_stretch(client, app):
    states = []

    def upstream(request, *_):
        context = json.loads(request["messages"][1]["content"])
        if context.get("connectionTest"):
            answer = '{"status":"ok"}'
        elif context["message"] == "我们接着看积木吧":
            answer = '好，先看看哪块积木里面放了前进。\n@课堂 {"action":"hint"}'
        else:
            states.append(context["offTopic"])
            answer = '听起来挺有意思。\n@课堂 {"returnToTask":true}'
        return json.dumps({"choices": [{"message": {"content": answer}, "finish_reason": "stop"}]}).encode()

    _enable_web_model(client, app, upstream)
    scope = _scope(client, "main", "off-topic")
    snapshot = _program("main", 3, 1)
    invitation = "想接着试试刚才那道题吗？"
    for index in range(10):
        reply = _chat(client, app, scope, snapshot, f"casual-{index}", "我们聊聊恐龙吧")
        assert (invitation in reply["message"]) == (index == 2)
    assert states[0] == {"turns": 0, "invited": False}
    assert states[-1]["invited"] is True

    resumed = _chat(client, app, scope, snapshot, "resumed", "我们接着看积木吧")
    assert resumed["action"] == "hint"
    _chat(client, app, scope, snapshot, "casual-again", "我还喜欢猫")
    assert states[-1] == {"turns": 0, "invited": False}


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
            if context["message"] == "这样呢？":
                data = {"message": "刚才我们在看循环里的动作。现在{{repeatTimes}}，这版还没运行。"}
        return json.dumps({"choices": [{"message": {"content": json.dumps(data)}, "finish_reason": "stop"}]}).encode()

    _enable_web_model(client, app, upstream)
    scope = _scope(client, "main", "model-edit")
    before = _program("main", 3, 2)
    after = _program("main", 2, 2)
    reply = _chat(client, app, scope, before, "a", "这里是什么意思", selected="repeat")
    assert reply["mode"] == "model"
    assert reply["awaitingAnswer"] is True
    assert reply["controls"] == []
    continued = _chat(client, app, scope, after, "b", "这样呢？", reply_to="a")
    assert continued["mode"] == "model"
    assert "积木设为重复 2 次" in continued["message"] and "这版还没运行" in continued["message"]
    assert contexts[-1]["history"][0]["sameProgram"] is False
    assert contexts[-1]["hasCurrentRun"] is False
    assert contexts[-1]["history"][0]["learner"] == "这里是什么意思"
    assert contexts[-1]["history"][0]["repliedTo"] is True
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
            data = {"message": ""}
        else:
            data = {
                "message": repeated_question, "action": "ask_question", "targetRef": None,
                "awaitingAnswer": True, "factIdsUsed": [], "observation": None,
            }
        return json.dumps({"choices": [{"message": {"content": json.dumps(data)}, "finish_reason": "stop"}]}).encode()

    _enable_web_model(client, app, upstream)
    scope = _scope(client, "main", "ws-fallback")
    snapshot = _program("main", 2, 1)
    first = _chat(client, app, scope, snapshot, "first", "我该从哪块积木开始？")
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
