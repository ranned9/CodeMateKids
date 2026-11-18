"""能力矩阵路由。"""

from __future__ import annotations

from fastapi import APIRouter

from backend.infra.errors import ApiError, ok
from backend.service.matrix import MatrixInvalid, load_matrix, matrix_payload

router = APIRouter(tags=["matrix"])


@router.get("/matrix")
def get_matrix() -> dict:
    try:
        view = load_matrix()
    except MatrixInvalid as exc:
        raise ApiError("MATRIX_INVALID") from exc
    return ok(matrix_payload(view))