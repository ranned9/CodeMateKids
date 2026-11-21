"""配置接口的同源三重校验：回环对端 + Host + Origin + JSON Content-Type。

只用于本机演示；公开部署必须重新设计（当前不引入 CSRF Token，也不启用 CORS）。
"""

from __future__ import annotations

import urllib.parse

from fastapi import Request

from backend.infra.errors import ApiError

LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost", "testclient"})
LOOPBACK_HOST_HEADER_NAMES = frozenset({"127.0.0.1", "localhost", "[::1]", "::1"})


def is_loopback(host: str) -> bool:
    value = (host or "").strip().lower()
    if value.startswith("[") and value.endswith("]"):
        value = value[1:-1]
    return value in LOOPBACK_HOSTS


def _split_host_header(value: str) -> tuple[str, int | None]:
    try:
        parts = urllib.parse.urlsplit(f"//{value}")
        if parts.username is not None or parts.path or parts.query or parts.fragment:
            raise ValueError
        return (parts.hostname or "").lower(), parts.port
    except ValueError as exc:
        raise ApiError("FORBIDDEN") from exc


def check_headers(headers, client_host: str, expected_port: int, require_origin: bool, scheme: str = "http") -> None:
    if not is_loopback(client_host):
        raise ApiError("FORBIDDEN")
    host_value = headers.get("host", "")
    host_name, host_port = _split_host_header(host_value)
    if host_name not in LOOPBACK_HOST_HEADER_NAMES:
        raise ApiError("FORBIDDEN")
    if (host_port or (443 if scheme == "https" else 80)) != expected_port:
        raise ApiError("FORBIDDEN")
    if require_origin:
        origin = headers.get("origin", "")
        if not origin or "," in origin:
            raise ApiError("FORBIDDEN")
        try:
            parsed = urllib.parse.urlsplit(origin)
            origin_port = parsed.port or (443 if parsed.scheme == "https" else 80)
        except ValueError as exc:
            raise ApiError("FORBIDDEN") from exc
        if parsed.scheme != scheme or parsed.username is not None or parsed.path or parsed.query or parsed.fragment:
            raise ApiError("FORBIDDEN")
        origin_name = (parsed.hostname or "").lower()
        local_port = host_port or (443 if scheme == "https" else 80)
        if origin_name != host_name or origin_port != local_port:
            raise ApiError("FORBIDDEN")
        content_type = headers.get("content-type", "")
        if content_type.split(";", 1)[0].strip().lower() != "application/json":
            raise ApiError("FORBIDDEN")


def _check_request(request: Request, require_origin: bool) -> None:
    settings = request.app.state.settings
    client_host = request.client.host if request.client else ""
    server = request.scope.get("server") or (None, settings.port)
    port = settings.port if client_host == "testclient" else server[1]
    check_headers(request.headers, client_host, port, require_origin, scheme=request.url.scheme)


def require_local(request: Request) -> None:
    _check_request(request, require_origin=False)


def require_local_same_origin(request: Request) -> None:
    _check_request(request, require_origin=True)
