"""项目保存/加载路由。"""

from __future__ import annotations

from fastapi import APIRouter, Request

from backend.api.dto import LoadProjectRequest, SaveProjectRequest
from backend.infra.errors import ok
from backend.service.project import load_project, save_project

router = APIRouter(tags=["projects"])


@router.post("/projects/save")
def create_project_file(body: SaveProjectRequest, request: Request) -> dict:
    settings = request.app.state.settings
    return ok(save_project(settings, body.program, body.courseRef))


@router.post("/projects/load")
def open_project_file(body: LoadProjectRequest, request: Request) -> dict:
    settings = request.app.state.settings
    return ok(load_project(settings, body.fileText))