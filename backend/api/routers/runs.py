"""运行路由：提交、事件流、运行摘要与取消。"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from backend.api.dto import CancelRequest, RunSubmitRequest
from backend.api.student_context import classroom_session
from backend.infra.errors import ApiError, ok
from backend.service.run import validate_request_id

router = APIRouter(tags=["runs"])


@router.post("/runs")
def create_run(body: RunSubmitRequest, request: Request) -> dict:
    manager = request.app.state.runs
    student_id, session = classroom_session(request)
    return ok(manager.submit(body.model_dump(), student_id=student_id, session=session))


@router.get("/runs/{request_id}")
def get_run(request_id: str, request: Request) -> dict:
    validate_request_id(request_id)
    manager = request.app.state.runs
    student_id, _ = classroom_session(request)
    snapshot = manager.snapshot(request_id, student_id=student_id)
    if snapshot is None:
        raise ApiError("RUN_NOT_FOUND")
    return ok(snapshot)


@router.get("/runs/{request_id}/events")
def stream_run_events(request_id: str, request: Request, studentId: str | None = None) -> StreamingResponse:
    validate_request_id(request_id)
    manager = request.app.state.runs
    raw_last = request.headers.get("Last-Event-ID", "0")
    try:
        last_event_id = int(raw_last)
    except (TypeError, ValueError):
        last_event_id = 0
    student_id, _ = classroom_session(request, stream_id=studentId)
    generator = manager.stream(request_id, last_event_id, student_id=student_id)
    return StreamingResponse(
        generator,
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/runs/{request_id}/cancel")
def cancel_run(request_id: str, body: CancelRequest, request: Request) -> dict:
    validate_request_id(request_id)
    manager = request.app.state.runs
    student_id, _ = classroom_session(request)
    return ok(manager.cancel(request_id, body.cancelToken, student_id=student_id))
