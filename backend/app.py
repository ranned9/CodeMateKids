"""FastAPI 应用工厂与同源静态托管。"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.types import Scope

from backend.api.routers import build_router
from backend.infra.config import BASE_DIR, Settings, load_settings
from backend.infra.errors import ApiError, fail
from backend.service.run import RunManager
from backend.session.store import SessionStore

FRONTEND_DIR = BASE_DIR / "frontend"


class FrontendFiles(StaticFiles):
    async def get_response(self, path: str, scope: Scope) -> Response:
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-store"
        return response


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()
    app = FastAPI(
        title="CodeMateKids AI 少儿编程教师平台",
        version=settings.app_version,
        docs_url=None,
        redoc_url=None,
    )
    app.state.settings = settings
    app.state.session = SessionStore()
    app.state.runs = RunManager(settings, app.state.session)

    @app.exception_handler(ApiError)
    def handle_api_error(request: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(status_code=exc.spec.http_status, content=fail(exc.code, exc.block_id, exc.message))

    @app.exception_handler(RequestValidationError)
    def handle_validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content=fail("PROGRAM_SCHEMA_INVALID", message="请求里有多余或缺失的信息，检查一下再试。"),
        )

    app.include_router(build_router())

    if FRONTEND_DIR.exists():
        app.mount("/assets", FrontendFiles(directory=FRONTEND_DIR), name="frontend-assets")
        app.mount("/", FrontendFiles(directory=FRONTEND_DIR, html=True), name="frontend")

    return app


app = create_app()
