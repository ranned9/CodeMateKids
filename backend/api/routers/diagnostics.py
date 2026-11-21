"""脱敏诊断日志路由：仅回环地址可访问。"""

from __future__ import annotations

from fastapi import APIRouter, Request

from backend.api.security import LOOPBACK_HOSTS
from backend.infra.errors import ApiError, ok
from backend.infra.logging import tail_logs

router = APIRouter(tags=["diagnostics"])


@router.get("/diagnostics/logs")
def get_logs(request: Request, tail: int = 50) -> dict:
    host = request.client.host if request.client else ""
    if host not in LOOPBACK_HOSTS:
        raise ApiError("FORBIDDEN")
    if tail < 1 or tail > 500:
        raise ApiError("BAD_TAIL")
    records = tail_logs(request.app.state.settings, tail)
    return ok({"records": records, "count": len(records), "tail": tail})