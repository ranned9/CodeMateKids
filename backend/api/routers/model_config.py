"""本机模型配置，先验证候选，再原子启用。"""

from __future__ import annotations

import time
import uuid

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from backend.api.dto import ModelConfigActivateRequest, ModelConfigDisableRequest, ModelConfigTestRequest
from backend.api.security import require_local, require_local_same_origin
from backend.infra.errors import ApiError, fail, ok
from backend.infra.logging import write_log
from backend.infra.net_policy import ModelTargetError, validate_target
from backend.tutor import chat_adapter, model_config

router = APIRouter(tags=["model-config"])

NO_STORE_HEADERS = {"Cache-Control": "no-store", "Pragma": "no-cache"}
CATEGORY_TO_CODE = model_config.CATEGORY_TO_EXISTING_CODE


def _error_response(category: str, message: str | None = None) -> JSONResponse:
    code = CATEGORY_TO_CODE.get(category, "TUTOR_UNAVAILABLE")
    error = ApiError(code)
    spec = error.spec
    payload = fail(code, message=message)
    payload["error"]["category"] = category
    if category == "storage":
        status = 500
    else:
        status = spec.http_status if category in ("invalid", "forbidden", "conflict", "expired") else 502
    return JSONResponse(status_code=status, content=payload, headers=NO_STORE_HEADERS)


def _config_request_id() -> str:
    return f"cfg-{uuid.uuid4().hex[:12]}"


def _store(request: Request) -> model_config.ModelConfigStore:
    return request.app.state.model_config


@router.get("/tutor/model-config", dependencies=[Depends(require_local)])
def get_model_config(request: Request) -> JSONResponse:
    snapshot = _store(request).snapshot()
    return JSONResponse(content=ok(snapshot.public_view()), headers=NO_STORE_HEADERS)


@router.post("/tutor/model-config/test", dependencies=[Depends(require_local_same_origin)])
def test_model_config(body: ModelConfigTestRequest, request: Request) -> JSONResponse:
    store = _store(request)
    request_id = _config_request_id()
    try:
        sequence = store.begin_test(body.expectedRevision)
    except model_config.ModelConfigError as exc:
        _log(request, request_id, "model_config_conflict", exc.category, store)
        return _error_response(exc.category)

    started = time.perf_counter()
    model = body.model.strip()
    key = (body.apiKey or "").strip() or store.saved_key(body.baseUrl.strip(), model) or ""

    def probe():
        if not model or not key or any(ord(char) < 33 or ord(char) > 126 for char in key):
            raise chat_adapter.ChatAdapterError("invalid")
        target = validate_target(body.baseUrl, resolver=request.app.state.model_resolver)
        remaining = 10.0 - (time.perf_counter() - started)
        if remaining <= 0:
            raise chat_adapter.ChatAdapterError("timeout")
        custom_probe = request.app.state.model_probe
        parsed = custom_probe(target, model, key, remaining) if custom_probe else chat_adapter.request_connection_test(
            target, model, key, remaining, transport=request.app.state.model_transport,
        )
        chat_adapter.validate_connection_test(parsed)
        return target

    try:
        target = chat_adapter.within_deadline(10.0, probe)
    except (chat_adapter.ChatAdapterError, ModelTargetError) as exc:
        store.finish_test(sequence, base_url="", model="", api_key="", failed=True)
        category = chat_adapter.classify_error(exc)
        reason = exc.reason if isinstance(exc, ModelTargetError) else ""
        _log(request, request_id, "model_config_test_failed", category, store)
        message = {
            "deepseek_public_dns_unavailable": "本机 DNS 返回了代理虚拟地址，暂时无法取得 DeepSeek 的公网地址。请将 api.deepseek.com 加入代理的 Fake-IP 过滤，再测试连接。",
            "resolved_private": "这个域名解析到了非公网地址。请检查本机 DNS 或代理配置。",
        }.get(reason)
        return _error_response(category, message)
    latency_ms = int((time.perf_counter() - started) * 1000)
    try:
        pending = store.finish_test(sequence, base_url=target.baseUrl, model=model, api_key=key)
    except model_config.ModelConfigError as exc:
        _log(request, request_id, "model_config_test_failed", exc.category, store)
        return _error_response(exc.category)
    if pending is None:
        _log(request, request_id, "model_config_conflict", "conflict", store)
        return _error_response("conflict")
    _log(request, request_id, "model_config_test_passed", "", store)
    return JSONResponse(content=ok(pending.public_view(latency_ms)), headers=NO_STORE_HEADERS)


@router.post("/tutor/model-config/activate", dependencies=[Depends(require_local_same_origin)])
def activate_model_config(body: ModelConfigActivateRequest, request: Request) -> JSONResponse:
    store = _store(request)
    try:
        snapshot = store.activate(body.expectedRevision, body.testId)
    except model_config.ModelConfigError as exc:
        _log(request, _config_request_id(), "model_config_conflict", exc.category, store)
        return _error_response(exc.category)
    return JSONResponse(content=ok(snapshot.public_view()), headers=NO_STORE_HEADERS)


@router.post("/tutor/model-config/disable", dependencies=[Depends(require_local_same_origin)])
def disable_model_config(body: ModelConfigDisableRequest, request: Request) -> JSONResponse:
    store = _store(request)
    try:
        snapshot = store.disable(body.expectedRevision)
    except model_config.ModelConfigError as exc:
        _log(request, _config_request_id(), "model_config_conflict", exc.category, store)
        return _error_response(exc.category)
    return JSONResponse(content=ok(snapshot.public_view()), headers=NO_STORE_HEADERS)


def _log(request: Request, request_id: str, event: str, category: str, store) -> None:
    try:
        snapshot = store.snapshot()
        write_log(
            request.app.state.settings,
            {
                "event": event,
                "requestId": request_id,
                "category": category or "ok",
                "modelSource": snapshot.source,
                "modelRevision": snapshot.revision,
                "modelCategory": category,
                "appVersion": request.app.state.settings.app_version,
            },
        )
    except Exception:  # noqa: BLE001 - 日志失败不得影响主流程
        pass
