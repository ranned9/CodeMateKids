"""路由聚合入口。"""

from __future__ import annotations

from fastapi import APIRouter


def build_router() -> APIRouter:
    from backend.api.routers import (
        course,
        diagnostics,
        matrix,
        model_config,
        projects,
        runs,
        session,
        speech,
        startup,
        tutor,
    )

    router = APIRouter(prefix="/api/v1")
    router.include_router(startup.router)
    router.include_router(course.router)
    router.include_router(runs.router)
    router.include_router(tutor.router)
    router.include_router(speech.router)
    router.include_router(model_config.router)
    router.include_router(projects.router)
    router.include_router(session.router)
    router.include_router(matrix.router)
    router.include_router(diagnostics.router)
    return router