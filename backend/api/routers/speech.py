"""语音路由：识别与合成的校验链、归属核对与降级语义。

转写文字确认发送后仍走 /tutor/chat 既有筛查路径；本模块只负责录音出站 SIS
与回复、任务文本合成。音频按请求在内存处理，不落盘、不进日志。
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import time
import uuid

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from pydantic import ValidationError

from backend.api.dto import SpeechRecognizeRequest, SpeechSynthesizeRequest, TaskSpeechRequest
from backend.api.student_context import classroom_session
from backend.infra.errors import ApiError, ok
from backend.infra.logging import write_log
from backend.service.course import find_task, load_course
from backend.service.speech import SpeechServiceError
from backend.service.teaching import learning_key

router = APIRouter(tags=["speech"])

MAX_REQUEST_BYTES = 512 * 1024
MAX_SYNTH_TEXT_CHARS = 500
SPEECH_CALL_TIMEOUT_SECONDS = 11.5


def _require_speech(request: Request):
    service = request.app.state.speech
    if not request.app.state.settings.tutor_chat_enabled or not service or not service.available:
        raise ApiError("SPEECH_UNAVAILABLE", message="语音小助手还没准备好，可以先打字提问。")
    return service


def _speech_log(settings, event: str, started: float, category: str, trace_id: str) -> None:
    write_log(settings, {
        "event": event,
        "requestId": f"speech-{uuid.uuid4().hex}",
        "durationMs": int((time.monotonic() - started) * 1000),
        "category": category,
        "cloudTraceId": trace_id,
        "appVersion": settings.app_version,
    })


async def _call_sis(request, service, call, value, event, message=None):
    started = time.monotonic()
    settings = request.app.state.settings

    def invoke():
        return call(value), getattr(service, "last_cloud_trace_id", "")

    try:
        result, trace_id = await asyncio.wait_for(
            asyncio.get_running_loop().run_in_executor(None, invoke),
            timeout=SPEECH_CALL_TIMEOUT_SECONDS,
        )
    except (TimeoutError, SpeechServiceError) as exc:
        category = exc.category if isinstance(exc, SpeechServiceError) else "timeout"
        _speech_log(settings, event, started, category, "")
        raise ApiError("SPEECH_UNAVAILABLE", message=message) from exc
    _speech_log(settings, event, started, "ok", trace_id)
    return result


@router.post("/speech/recognize")
async def recognize_speech(request: Request):
    service = _require_speech(request)
    classroom_session(request)
    raw = bytearray()
    async for chunk in request.stream():
        if len(raw) + len(chunk) > MAX_REQUEST_BYTES:
            raise ApiError("SPEECH_PAYLOAD_TOO_LARGE")
        raw.extend(chunk)
    try:
        body = SpeechRecognizeRequest.model_validate(json.loads(raw))
    except (json.JSONDecodeError, UnicodeDecodeError, ValidationError):
        raise ApiError("PROGRAM_SCHEMA_INVALID", message="语音请求的信息不完整，再试一次。")
    try:
        audio = base64.b64decode(body.audioBase64, validate=True)
    except (binascii.Error, ValueError):
        raise ApiError("SPEECH_AUDIO_INVALID")
    if not audio:
        raise ApiError("SPEECH_AUDIO_INVALID")

    text = await _call_sis(
        request, service, service.recognize, body.audioBase64, "speech_recognize",
        "没听清这一句，可以再说一次或打字。",
    )
    return JSONResponse(content=ok({"text": text}))


@router.post("/speech/synthesize")
async def synthesize_speech(body: SpeechSynthesizeRequest, request: Request):
    settings = request.app.state.settings
    service = _require_speech(request)
    student_id, _store = classroom_session(request)
    bundle = load_course(settings)
    task_id = body.scope.taskId
    find_task(settings, task_id, bundle)
    key = learning_key({"scope": body.scope.model_dump()}, bundle, task_id)
    if not key:
        raise ApiError("PROGRAM_SCHEMA_INVALID")
    turn = request.app.state.classroom_conversations.peek((student_id, key), body.turnId)
    if turn is None:
        raise ApiError("RUN_NOT_FOUND")
    text = str(turn.get("message") or "")
    if len(text) > MAX_SYNTH_TEXT_CHARS:
        return JSONResponse(content=ok({"playable": False, "reasonCode": "SPEECH_TEXT_TOO_LONG"}))

    audio = await _call_sis(request, service, service.synthesize, text, "speech_synthesize")
    return Response(content=audio, media_type="audio/mpeg")


def _task_speech_parts(task: dict) -> list[str]:
    criteria = [str(item.get("description") or "").strip() for item in task["successCriteria"]]
    if not criteria[0]:
        criteria[0] = "按目标完成这一轮练习"
    completion = "；".join(item for item in criteria if item)
    title = str(task["title"]).strip()
    objective = str(task["objective"]).strip()
    sentence_ends = ("。", "？", "！", ".", "?", "!")
    title_end = "" if title.endswith(sentence_ends) else "。"
    objective_end = "" if objective.endswith(sentence_ends) else "。"
    text = f"{title}{title_end}\n{objective}{objective_end}\n完成标准：{completion}。"
    parts = []
    while len(text) > MAX_SYNTH_TEXT_CHARS:
        boundary = max(text.rfind(mark, 0, MAX_SYNTH_TEXT_CHARS) for mark in "。！？；\n") + 1
        cut = boundary if boundary >= MAX_SYNTH_TEXT_CHARS // 2 else MAX_SYNTH_TEXT_CHARS
        parts.append(text[:cut].strip())
        text = text[cut:].lstrip()
    if text:
        parts.append(text)
    return parts


@router.post("/speech/task")
async def synthesize_task(body: TaskSpeechRequest, request: Request):
    service = _require_speech(request)
    classroom_session(request)
    settings = request.app.state.settings
    bundle = load_course(settings)
    if body.contentVersion != bundle.content_version:
        raise ApiError("COURSE_VERSION_UNSUPPORTED")
    parts = _task_speech_parts(find_task(settings, body.taskId, bundle))
    if body.part >= len(parts):
        raise ApiError("PROGRAM_SCHEMA_INVALID")

    audio = await _call_sis(
        request, service, service.synthesize, parts[body.part], "speech_synthesize", "暂时读不了这个任务，可以稍后再试。",
    )
    headers = {"X-CMK-Speech-More": "1"} if body.part + 1 < len(parts) else {}
    return Response(content=audio, media_type="audio/mpeg", headers=headers)
