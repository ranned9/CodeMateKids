"""启动校验路由。"""

from __future__ import annotations

from fastapi import APIRouter, Request

from backend.infra.errors import ok

router = APIRouter(tags=["startup"])


@router.get("/startup/check")
def startup_check(request: Request, refresh: bool = False) -> dict:
    from backend.service.startup import check_startup

    settings = request.app.state.settings
    return ok(check_startup(settings, refresh=refresh))