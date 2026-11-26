"""课程与积木 schema 路由。"""

from __future__ import annotations

from fastapi import APIRouter, Request

from backend.domain.blocks import load_blocks
from backend.infra.errors import ok
from backend.service.course import course_payload

router = APIRouter(tags=["course"])


@router.get("/course")
@router.get("/course/{course_id}")
def get_course(request: Request, course_id: str | None = None) -> dict:
    settings = request.app.state.settings
    payload = course_payload(settings, course_id)
    payload["agentMode"] = request.app.state.model_config.snapshot().effectiveMode
    return ok(payload)


@router.get("/blocks/schema")
def get_block_schema() -> dict:
    registry = load_blocks()
    return ok(registry.as_response())
