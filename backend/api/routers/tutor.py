"""辅导路由：单一课程 Bundle、证据映射、兜底与提示账本语义。"""

from __future__ import annotations

import uuid
import hashlib
import json
import re
import time
from dataclasses import replace

from fastapi import APIRouter, Request

from backend.api.dto import TutorChatRequest, TutorHintRequest
from backend.api.security import require_local_same_origin
from backend.api.student_context import classroom_session
from backend.domain.program import ProgramError, program_roots
from backend.infra.errors import ApiError, ok
from backend.infra.logging import write_log
from backend.infra.net_policy import ModelTargetError, validate_target
from backend.service.course import find_task, load_course, next_task_id
from backend.service.program_digest import digest_program
from backend.service.teaching import learning_key, match_prediction, structure_facts, teaching_anchor, validate_snapshot
from backend.tutor import chat_adapter, classroom, mock, small_edits
from backend.tutor.diagnosis import build_facts
from backend.tutor.engine import PERSONAL_TOKENS, Decision, decide, decide_with_facts, redirect_pattern
from backend.tutor.guard import validate_response
from backend.tutor.model import ModelUnavailable, call_model
from backend.tutor.model_config import ADAPTER_CHAT, ADAPTER_LEGACY

router = APIRouter(tags=["tutor"])

LAST_RUN_STATUS = {
    "succeeded": "completed",
    "failed": "failed",
    "timeout": "timeout",
    "resource": "resource_exceeded",
    "cancelled": "cancelled",
    "crashed": "crashed",
}
HINT_LEDGER_CHOICES = {"hint", "more_hint", "example"}
SAFE_FALLBACK = {
    "action": "hint",
    "message": "我们先回到这一步，看看角色走了几步。",
    "nextStep": "运行一次，观察角色位置",
    "uncertainty": "我还没有看到结果。",
    "answerLevel": 1,
    "evidenceUsed": ["run_result"],
    "mode": "mock",
    "showAsDemo": True,
}


def _build_context(request: Request, body: TutorHintRequest, bundle, store) -> dict:
    task = find_task(request.app.state.settings, body.taskId, bundle)
    attempts = store.attempts_for(body.taskId)
    last_attempt = attempts[-1] if attempts else None
    last_status = LAST_RUN_STATUS.get(last_attempt["outcome"]) if last_attempt else None
    evidence = store.recent_evidence(body.taskId, limit=5)
    evidence_types = []
    for item in evidence:
        if item["sourceType"] not in evidence_types:
            evidence_types.append(item["sourceType"])
    return {
        "request_id": f"tutor-{uuid.uuid4().hex[:12]}",
        "task_id": body.taskId,
        "course_id": bundle.course["courseId"],
        "objective": task["objective"],
        "program_summary": body.programSummary,
        "program_valid": body.programValid,
        "last_run_status": body.lastRunStatus or last_status,
        "last_success": last_attempt["outcome"] == "succeeded" if last_attempt else None,
        "learner_choice": body.learnerChoice,
        "message": body.message,
        "highest_hint": store.highest_hint(body.taskId),
        "evidence": evidence,
        "evidence_types": evidence_types,
    }


def _scoped_context(body: TutorHintRequest | TutorChatRequest, bundle, store, key: str) -> dict:
    learning = body.learningContext
    program = learning.program
    task = bundle.tasks[body.taskId]
    digest = None
    invalid_block = None
    program_valid = getattr(body, "programValid", True)
    structure = {}
    if program is not None:
        try:
            validate_snapshot(program, bundle, body.taskId)
        except ProgramError as exc:
            invalid_block = exc.block_id
            program_valid = False
        else:
            digest = digest_program(program)
            structure = structure_facts(program_roots(program, runnable_only=True), task)
    previous = store.teaching.recent_runs(key)
    latest = previous[-1] if previous else None
    run = latest if (
        digest and latest and latest["requestId"] == learning.runRequestId and latest["programDigest"] == digest
    ) else None
    result = run["learning"] if run else {}
    pattern = "program_invalid" if not program_valid else result.get("pattern", "not_run")
    repeated = bool(
        run and len(previous) > 1 and pattern in ("loop_count_mismatch", "move_steps_mismatch", "action_outside_loop", "square_loop_structure")
        and previous[-2]["learning"]["pattern"] == pattern
    )
    hints = store.confirm_teaching_hints(key, body.taskId, learning.seenHintIds)
    return {
        "enhanced": True,
        "pattern": pattern,
        "facts": result.get("facts", {}),
        "run_id": run["requestId"] if run else None,
        "goal_kind": task.get("teaching", {}).get("goalKind", "distance"),
        "hint_ladder": task["hintLadder"] if task.get("teaching", {}).get("useHintLadder") else [],
        "program_valid": program_valid,
        "last_run_status": run["status"] if run else None,
        "highest_hint": max((hint["level"] for hint in hints if hint["pattern"] == pattern), default=0),
        "repeated_pattern": repeated,
        "replay_available": bool(result.get("replay")),
        "replay": result.get("replay"),
        "outcome": result.get("outcome"),
        "block_targets": {ref: structure.get(name) for ref, name in (
            ("loopBlock", "loop_id"), ("moveBlock", "move_id"), ("outsideMoveBlock", "outside_move_id"),
        ) if structure.get(name)},
        "program_digest": digest,
        "structure": structure,
        "prior_run": latest if latest and not run else None,
        "anchor": invalid_block or (run or {}).get("errorBlockId") or teaching_anchor(pattern, structure),
    }


@router.post("/tutor/chat")
def create_chat(body: TutorChatRequest, request: Request) -> dict:
    settings = request.app.state.settings
    if not settings.tutor_chat_enabled:
        raise ApiError("TUTOR_UNAVAILABLE")
    require_local_same_origin(request)
    bundle = load_course(settings)
    task = find_task(settings, body.taskId, bundle)
    learning = body.learningContext
    key = learning_key(learning.model_dump(), bundle, body.taskId)
    if not key:
        raise ApiError("PROGRAM_SCHEMA_INVALID")

    student_id, store = classroom_session(request)
    scope = (student_id, key)
    fingerprint = hashlib.sha256(json.dumps(body.model_dump(), sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    conversations = request.app.state.classroom_conversations
    cached, history = conversations.begin(scope, learning.turnId, fingerprint, learning.replyToTurnId)
    if cached is not None:
        return ok(cached)

    try:
        context = _scoped_context(body, bundle, store, key)
        _add_chat_context(context, body, task, store, key, history)
        points = task.get("teaching", {}).get("knowledgePointIds", [])
        context["memory"] = classroom.teaching_approach(store.learning_observations(bundle.course["courseId"], points))
        message = _classroom_answer(body.message, limit=300)
        social = classroom.social_reply(message)
        edit_reply, edit = (None, None) if social else small_edits.plan_small_edit(
            message, context, learning.program, body.selectedBlockId, bundle.registry,
        )
        reply = edit_reply or (social if social and social.action == "stop_guidance" else None)
        active = request.app.state.model_config.active()
        origin = "mock"
        fallback = None
        signal = classroom.observation_signal(message)
        invite_back = False
        started = time.monotonic()
        if active.adapter == ADAPTER_CHAT and message and reply is None:
            try:
                candidate, observation, invite = _ask_classroom_model(request, active, context, message)
                if request.app.state.model_config.current_revision() != active.revision:
                    fallback = "configuration_changed"
                else:
                    reply, signal, origin = candidate, observation or signal, "model"
                    invite_back = invite
            except Exception as exc:  # The local reply remains usable if the model fails.
                fallback = chat_adapter.classify_error(exc)
        if reply is None:
            if not message:
                reply = classroom.Reply("我们可以聊聊你正在做的事。", "conversation")
            elif social:
                reply = social
            elif classroom.is_lesson_turn(message, context):
                reply = classroom.local_reply(message, context)
                if active.adapter != ADAPTER_CHAT:
                    fallback = "unconfigured"
            else:
                reply = classroom.Reply("你可以再多说一点吗？我想确认自己理解对了。", "conversation", awaiting=True)

        off_topic = context["off_topic"]
        if reply.action != "conversation":
            off_topic = {"turns": 0, "invited": False}
        elif not social and origin == "model":
            off_topic = {**off_topic, "turns": min(off_topic["turns"] + 1, 3)}
            if invite_back and off_topic["turns"] >= 3 and not off_topic["invited"]:
                reply = replace(reply, message=reply.message + "\n\n想接着试试刚才那道题吗？", awaiting=True)
                off_topic["invited"] = True

        request_id = f"tutor-{uuid.uuid4().hex}"
        level = classroom.HELP_LEVELS[reply.action]
        controls = _chat_controls(reply, context)
        response = {
            "requestId": request_id,
            "turnId": learning.turnId,
            "message": reply.message,
            "action": reply.action,
            "awaitingAnswer": reply.awaiting,
            "supportLevel": level,
            "hintId": request_id if level else None,
            "controls": controls,
            "mode": origin,
            "fallbackReason": fallback,
        }
        if edit is not None:
            response["edit"] = edit
        if level:
            store.teaching.issue_hint(key, request_id, {
                "level": level, "pattern": context["pattern"], "action": reply.action, "knowledgePoints": points,
            })
        if signal:
            store.observe(key, points, "chat", learning.turnId, "dialogue_signal", {"signal": signal})
        if not store.memory_available:
            response["memorySaved"] = False
        conversations.finish(scope, learning.turnId, fingerprint, message, response, {
            "programDigest": context["program_digest"], "runRequestId": context["run_id"], "offTopic": off_topic,
        })
        write_log(settings, {
            "event": "tutor_chat", "requestId": request_id, "durationMs": int((time.monotonic() - started) * 1000),
            "modelSource": origin, "modelRevision": active.revision, "modelCategory": fallback or origin,
            "appVersion": settings.app_version,
        })
        return ok(response)
    finally:
        conversations.abort(scope, learning.turnId)


def _add_chat_context(context, body, task, store, key, history):
    learning = body.learningContext
    selected_kind = None
    if context["program_digest"] and body.selectedBlockId:
        for block in small_edits.snapshot_blocks(learning.program):
            if block["blockId"] == body.selectedBlockId:
                selected_kind = block["kind"]
                context["block_targets"]["selectedBlock"] = body.selectedBlockId
                break

    structure = context["structure"]
    prediction = None
    if context["program_digest"] and learning.predictionId:
        prediction = match_prediction(store.teaching.get_prediction(key, learning.predictionId), context["program_digest"])
    static_facts = build_facts(
        run_status=None, program_valid=context["program_valid"], objects=None, task=task, structure=structure,
        prediction_match=prediction["match"] if prediction else "none",
        prediction_value=prediction.get("value") if prediction else None,
    ).as_dict()
    run_facts = context["facts"] if context["last_run_status"] == "completed" else {}
    context["facts"] = {**static_facts, **{name: value for name, value in run_facts.items() if value is not None}}
    context["repeated_pattern"] = bool(context["repeated_pattern"] and len({
        row["programDigest"] for row in store.teaching.recent_runs(key)
    }) > 1)
    actions = {action: [None] for action in classroom.HELP_LEVELS if action not in (
        "stop_guidance", "point_to_block", "show_execution", "edit_block",
    )}
    if context["block_targets"]:
        actions["point_to_block"] = list(context["block_targets"])
    if context["replay_available"]:
        actions["show_execution"] = ["verifiedReplay"]
    previous = history[-1]["snapshot"] if history else {}
    context.update(
        objective=task["objective"], prediction_question=task["predictionQuestion"],
        history=history, selected_kind=selected_kind, actions=actions,
        off_topic=previous.get("offTopic", {"turns": 0, "invited": False}),
        reply_to=next((turn for turn in reversed(history) if
                       turn["turnId"] == learning.replyToTurnId and turn["awaitingAnswer"]), None),
    )


def _chat_controls(reply, context):
    if reply.action == "point_to_block" and reply.target in context["block_targets"]:
        return [{"type": "locate_block", "blockId": context["block_targets"][reply.target]}]
    if reply.action == "show_execution" and context["replay_available"] and context["run_id"]:
        return [{"type": "replay", "runRequestId": context["run_id"]}]
    return []


def _ask_classroom_model(request, active, context, message):
    budget = min(request.app.state.settings.tutor_timeout_ms / 1000.0, 8.0)
    started = time.monotonic()

    def fetch():
        target = validate_target(active.base_url, resolver=request.app.state.model_resolver)
        remaining = budget - (time.monotonic() - started)
        if remaining <= 0:
            raise chat_adapter.ChatAdapterError("timeout")
        messages = chat_adapter.classroom_messages(context, message)
        payload = chat_adapter.build_payload(active.model, messages, host=target.host, json_response=False)
        raw = request.app.state.model_transport(payload, target, active.api_key, remaining)
        return chat_adapter.classroom_reply(chat_adapter.parse(raw), context)

    return chat_adapter.within_deadline(budget, fetch)


def _next_action(decision, context: dict) -> str:
    if decision.level == 0:
        return "open_next_task" if context["learner_choice"] == "skip" else "none"
    if decision.error_pattern in ("personal_info", "off_topic", "ask_answer"):
        return "none"
    if decision.action == "show_execution":
        return "replay"
    if decision.action == "point_to_block" and context.get("anchor"):
        return "locate_block"
    if decision.action in ("analogy", "partial_example"):
        return "edit_one"
    if decision.error_pattern == "not_run" and context.get("goal_kind") == "square":
        return "edit_one"
    return {
        "not_run": "predict", "run_incomplete": "run", "goal_met": "open_next_task",
        "prediction_mismatch": "compare",
    }.get(decision.error_pattern, "edit_one")


@router.post("/tutor/hints")
def create_hint(body: TutorHintRequest, request: Request) -> dict:
    settings = request.app.state.settings
    student_id, store = classroom_session(request)
    bundle = load_course(settings)
    context = _build_context(request, body, bundle, store)
    key = learning_key(body.learningContext.model_dump() if body.learningContext else None, bundle, body.taskId)
    if key:
        context.update(_scoped_context(body, bundle, store, key))
        decision = decide_with_facts(None, context)
        context["next_action"] = _next_action(decision, context)
    else:
        decision = decide(context)

    active = request.app.state.model_config.active()
    eligible = not key or (decision.level > 0 and context["program_valid"] and context["run_id"])
    redirect = redirect_pattern(context)
    conversational = (
        bool(eligible) and bool(key) and active.adapter == ADAPTER_CHAT and settings.tutor_agent_enabled
        and body.learningContext.turnId and body.learnerChoice in ("hint", "more_hint", "none")
        and redirect not in ("personal_info", "ask_answer")
    )
    answer = ""
    if conversational and body.message:
        answer = _classroom_answer(body.message)
        if not answer:
            redirect = "personal_info"
            decision = Decision("hint", 1, redirect, "先转回学习任务")
            context["next_action"] = "none"
        conversational = bool(answer) and (redirect is None or bool(body.learningContext.replyToTurnId))
    if active.adapter == ADAPTER_CHAT and key and eligible and (not redirect or conversational):
        require_local_same_origin(request)
    if not conversational:
        return ok(_respond(
            request, body, bundle, context, key, decision, active, bool(eligible and (not key or not redirect)), store,
        ))

    learning = body.learningContext
    scope = (student_id, key, active.revision, context["program_digest"], context["run_id"])
    fingerprint = hashlib.sha256(json.dumps([body.learnerChoice, body.message, learning.replyToTurnId], ensure_ascii=False).encode()).hexdigest()
    conversations = request.app.state.conversations
    cached, history = conversations.begin(scope, learning.turnId, fingerprint, learning.replyToTurnId)
    if cached is not None:
        return ok(cached)
    try:
        if redirect == "off_topic":
            # A short answer to a verified pending question need not repeat the lesson vocabulary.
            decision = decide_with_facts(None, {**context, "message": ""})
            context["next_action"] = _next_action(decision, context)
        options = _agent_options(context, bundle, body.taskId, history, answer)
        response = _respond(request, body, bundle, context, key, decision, active, True, store, options=options)
        response["learning"]["turnId"] = learning.turnId
        response["learning"].setdefault("awaitingAnswer", False)
        conversations.finish(scope, learning.turnId, fingerprint, answer, response)
        return ok(response)
    finally:
        conversations.abort(scope, learning.turnId)


def _classroom_answer(message: str, *, limit: int = 160) -> str:
    value = message.strip()[:limit]
    if any(token in value for token in PERSONAL_TOKENS) or re.search(
        r"https?://|www\.|@|\d{4,}|sk-|地址|姓名|家住|我叫|微信|邮箱|我在.{0,18}小学", value, re.IGNORECASE,
    ):
        return ""
    return value


def _agent_options(context, bundle, task_id, history, answer) -> dict:
    actions = {"ask_question": [None], "hint": [None]}
    if context["block_targets"]:
        actions["point_to_block"] = list(context["block_targets"])
    if context["replay_available"]:
        actions["show_execution"] = ["verifiedReplay"]
    following = next_task_id(bundle.tasks[task_id])
    if context["outcome"] == "goal_met" and following in bundle.runnable_task_ids:
        actions["offer_variant"] = ["nextTask"]
    return {"actions": actions, "history": history, "answer": answer}


def _web_reply(request, active, context, decision, options) -> dict:
    settings = request.app.state.settings
    budget = min(settings.tutor_timeout_ms / 1000.0, 8.0)
    started = time.monotonic()
    if options is None and all(type(context["facts"].get(key)) is int for key in ("moves", "actualSteps")):
        context = {**context, "required_facts": ["moves", "actualSteps"]}

    def fetch():
        target = validate_target(active.base_url, resolver=request.app.state.model_resolver)
        remaining = budget - (time.monotonic() - started)
        if remaining <= 0:
            raise chat_adapter.ChatAdapterError("timeout")
        parsed = chat_adapter.request_reply(target, active.model, active.api_key, remaining, context, decision,
                                           options, request.app.state.model_transport)
        return chat_adapter.format_reply(parsed, context, decision, options)

    return chat_adapter.within_deadline(budget, fetch)


def _respond(request, body, bundle, context, key, decision, active, eligible, store, options=None) -> dict:
    settings = request.app.state.settings

    fallback_reason = ""
    response: dict | None = None
    allowed = int(context.get("highest_hint", 0)) >= 2 and body.learnerChoice == "more_hint"
    awaiting = False

    if eligible and (active.adapter == ADAPTER_LEGACY or (active.adapter == ADAPTER_CHAT and key)):
        try:
            if active.adapter == ADAPTER_CHAT:
                candidate = _web_reply(request, active, context, decision, options)
                valid, reason = True, ""
            else:
                candidate = call_model(settings, context, decision)
                valid, reason = validate_response(
                    candidate, allow_full_solution=allowed and not key, decision=decision if key else None, context=context,
                )
            if request.app.state.model_config.current_revision() != active.revision:
                fallback_reason = "model:configuration_changed"
            elif active.adapter == ADAPTER_CHAT and not _run_is_current(store, key, context["run_id"]):
                fallback_reason = "model:run_changed"
            elif valid:
                response = candidate
                if options is not None:
                    awaiting = candidate.pop("awaitingAnswer")
                    target = candidate.pop("targetRef")
                    decision = Decision(candidate["action"], decision.level, decision.error_pattern, decision.reason)
                    context["anchor"] = context["block_targets"].get(target) if target else None
                    context["next_action"] = "none" if decision.action == "ask_question" else (
                        "open_next_task" if decision.action == "offer_variant" else _next_action(decision, context)
                    )
            else:
                fallback_reason = f"guard:{reason}"
        except (chat_adapter.ChatAdapterError, ModelTargetError) as exc:
            fallback_reason = f"model:{chat_adapter.classify_error(exc)}"
        except ModelUnavailable as exc:
            fallback_reason = f"model:{exc}"
        except Exception as exc:  # noqa: BLE001 - 适配异常不得穿透为 500
            fallback_reason = "model:adapter_error"
            write_log(
                settings,
                {
                    "event": "tutor_adapter_error",
                    "requestId": context["request_id"],
                    "category": "TUTOR_UNAVAILABLE",
                    "matrixCaseId": "TC-TUTOR-ADAPTER",
                    "appVersion": settings.app_version,
                    "stderrSummary": type(exc).__name__,
                },
            )

    if response is None:
        response = mock.learning_reply(context, decision, bundle) if key else mock.reply(settings, context, decision, bundle)
        valid, reason = validate_response(response, allow_full_solution=allowed and not key, enhanced_local=bool(key))
        if not valid:
            response = mock.learning_reply(context, decision, None) if key else dict(SAFE_FALLBACK)
        if fallback_reason:
            write_log(
                settings,
                {
                    "event": "tutor_fallback",
                    "requestId": context["request_id"],
                    "category": "TUTOR_UNAVAILABLE",
                    "matrixCaseId": "TC-TUTOR-FALLBACK",
                    "modelRevision": active.revision,
                    "modelCategory": fallback_reason,
                    "appVersion": settings.app_version,
                },
            )

    response = dict(response)
    response["requestId"] = context["request_id"]
    if fallback_reason:
        response["fallbackReason"] = fallback_reason
    response.setdefault("showAsDemo", response.get("mode") == "mock")

    level = int(response.get("answerLevel", 1))
    if key:
        response["learning"] = {
            "pattern": decision.error_pattern,
            "runRequestId": context["run_id"],
            "anchorBlockId": context["anchor"] if context["next_action"] == "locate_block" else None,
            "nextAction": context["next_action"],
        }
        if options is not None:
            response["learning"]["awaitingAnswer"] = awaiting
        if level >= 1:
            points = bundle.tasks[body.taskId].get("teaching", {}).get("knowledgePointIds", [])
            store.teaching.issue_hint(key, response["requestId"], {
                "level": level, "pattern": decision.error_pattern, "action": decision.action, "knowledgePoints": points,
            })
    elif level >= 1 and body.learnerChoice in HINT_LEDGER_CHOICES:
        points = bundle.tasks[body.taskId].get("teaching", {}).get("knowledgePointIds", [])
        store.note_hint(body.taskId, level)
        store.add_evidence(
            task_id=body.taskId,
            source_type="hint_usage",
            observed_fact=f"孩子选择「{body.learnerChoice}」，看到第 {level} 级提示",
            interpretation_text="这是一次提示使用记录，用于决定下一次帮助方式",
            confidence=0.9,
            alternatives=["孩子可能只是随手点的"],
            follow_up="看孩子是否根据提示修改并再次运行",
            course_id=bundle.course["courseId"], knowledge_point_id=next(iter(points), "kp.loop"),
        )
    return response


def _run_is_current(store, key: str, run_id: str) -> bool:
    attempts = store.teaching.recent_runs(key, limit=1)
    return bool(attempts and attempts[0]["requestId"] == run_id)
