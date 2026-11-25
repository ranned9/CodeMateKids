"""FastAPI 应用工厂与同源静态托管。"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.types import Scope

from backend.api.routers import build_router
from backend.api.security import require_local_same_origin
from backend.api.student_context import StudentSessions
from backend.infra.config import BASE_DIR, Settings, load_settings
from backend.infra.errors import ApiError, fail
from backend.service.run import RunManager
from backend.service.speech import SpeechService
from backend.session.store import SessionStore
from backend.session.conversations import ConversationStore
from backend.session.learning_store import LearningStore
from backend.tutor.model_config import ModelConfigStore
from backend.tutor.chat_adapter import send as send_model_request

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
    app.state.learning = LearningStore(settings.learning_db_path)
    app.state.student_sessions = StudentSessions(app.state.learning)
    app.state.conversations = ConversationStore()
    app.state.classroom_conversations = ConversationStore(classroom=True)
    app.state.runs = RunManager(settings, app.state.session)
    app.state.model_config = ModelConfigStore(settings, persist_path=settings.log_dir / "model-config.local.json")
    app.state.model_resolver = None
    app.state.model_probe = None
    app.state.model_transport = send_model_request
    try:
        app.state.speech = SpeechService(settings)
    except Exception:
        app.state.speech = None

    @app.middleware("http")
    async def guard_local_api(request: Request, call_next):
        path = request.url.path
        if path.startswith(("/api/v1/tutor/model-config", "/api/v1/speech/")):
            try:
                if request.method == "POST":
                    require_local_same_origin(request)
            except ApiError as exc:
                response = JSONResponse(status_code=exc.spec.http_status, content=fail(exc.code))
            else:
                response = await call_next(request)
            response.headers["Cache-Control"] = "no-store"
            return response
        return await call_next(request)

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
