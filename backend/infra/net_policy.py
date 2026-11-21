"""模型目标地址策略与受控出站：只允许公开 HTTPS 域名，禁止私网/回环/重定向/代理。"""

from __future__ import annotations

import ipaddress
import http.client
import json
import socket
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Callable

MAX_BASE_URL_LENGTH = 512
CHAT_SUFFIX = "/chat/completions"
DEEPSEEK_API_HOST = "api.deepseek.com"
FAKE_IP_NETWORKS = (ipaddress.ip_network("198.18.0.0/15"), ipaddress.ip_network("2001:2::/48"))

FORBIDDEN_NETWORKS: tuple[ipaddress._BaseNetwork, ...] = tuple(
    ipaddress.ip_network(item)
    for item in (
        "0.0.0.0/8",
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.0.0.0/24",
        "192.0.2.0/24",
        "192.168.0.0/16",
        "198.18.0.0/15",
        "198.51.100.0/24",
        "203.0.113.0/24",
        "224.0.0.0/4",
        "240.0.0.0/4",
        "::/128",
        "::1/128",
        "fc00::/7",
        "fe80::/10",
        "ff00::/8",
        "2001:db8::/32",
    )
)


class ModelTargetError(Exception):
    def __init__(self, category: str, reason: str = "") -> None:
        self.category = category if category in ("invalid", "forbidden", "endpoint") else "invalid"
        self.reason = reason
        super().__init__(self.category)


@dataclass(frozen=True)
class ValidatedTarget:
    baseUrl: str
    chatUrl: str
    host: str
    port: int
    addresses: tuple[str, ...] = ()


def is_forbidden_ip(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return True
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        return True
    if not address.is_global or any(address in network for network in FORBIDDEN_NETWORKS):
        return True
    return bool(
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_multicast
        or address.is_reserved
        or address.is_unspecified
    )


def pinned_https(host: str, port: int, address: str, timeout: float) -> http.client.HTTPSConnection:
    connection = http.client.HTTPSConnection(host, port, timeout=timeout)
    # Dial the checked address. Keep the hostname for HTTP Host and TLS verification.
    connection._create_connection = lambda pair, wait, source: socket.create_connection((address, pair[1]), wait, source)
    return connection


def _resolve(host: str, resolver: Callable[[str], list[str]] | None) -> list[str]:
    if resolver is not None:
        return list(resolver(host))
    try:
        infos = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise ModelTargetError("endpoint", "dns_failed") from exc
    addresses: list[str] = []
    for info in infos:
        sockaddr = info[4]
        if sockaddr and sockaddr[0] not in addresses:
            addresses.append(str(sockaddr[0]))
    return addresses


def _is_fake_ip(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    return any(address in network for network in FAKE_IP_NETWORKS)


def _resolve_deepseek_public() -> list[str]:
    connection = pinned_https("cloudflare-dns.com", 443, "1.1.1.1", 3.0)
    try:
        query = urllib.parse.urlencode({"name": DEEPSEEK_API_HOST, "type": "A"})
        connection.request("GET", f"/dns-query?{query}", headers={"Accept": "application/dns-json"})
        response = connection.getresponse()
        if response.status != 200:
            return []
        data = json.loads(response.read(8192))
    except (OSError, http.client.HTTPException, ValueError):
        return []
    finally:
        connection.close()
    if not isinstance(data, dict) or data.get("Status") != 0 or data.get("TC"):
        return []
    answers = data.get("Answer")
    if not isinstance(answers, list):
        return []
    return [item["data"] for item in answers if isinstance(item, dict) and item.get("type") == 1
            and isinstance(item.get("data"), str)]


def resolve_and_check(host: str, resolver: Callable[[str], list[str]] | None = None) -> list[str]:
    addresses = _resolve(host, resolver)
    if not addresses:
        raise ModelTargetError("endpoint", "dns_empty")
    if host == DEEPSEEK_API_HOST and all(_is_fake_ip(address) for address in addresses):
        # Some local proxies return benchmark addresses as placeholders. Query the official
        # hostname without sending model credentials, and apply the same outbound IP checks.
        addresses = _resolve_deepseek_public()
        if not addresses or any(is_forbidden_ip(address) for address in addresses):
            raise ModelTargetError("forbidden", "deepseek_public_dns_unavailable")
    for address in addresses:
        if is_forbidden_ip(address):
            raise ModelTargetError("forbidden", "resolved_private")
    return addresses


def validate_target(
    base_url: str,
    resolver: Callable[[str], list[str]] | None = None,
    resolve: bool = True,
) -> ValidatedTarget:
    raw = (base_url or "").strip()
    if not raw or len(raw) > MAX_BASE_URL_LENGTH:
        raise ModelTargetError("invalid", "length")
    if any(ord(char) < 32 for char in raw):
        raise ModelTargetError("invalid", "control_chars")
    try:
        parts = urllib.parse.urlsplit(raw)
    except ValueError as exc:
        raise ModelTargetError("invalid", "url") from exc
    if parts.scheme.lower() != "https":
        raise ModelTargetError("invalid", "scheme")
    if parts.username is not None or parts.password is not None:
        raise ModelTargetError("invalid", "credentials")
    if parts.query or parts.fragment:
        raise ModelTargetError("invalid", "query_or_fragment")
    host = (parts.hostname or "").strip().lower()
    if not host or len(host) > 253:
        raise ModelTargetError("invalid", "host")
    if host.startswith("[") or host.endswith("]"):
        raise ModelTargetError("forbidden", "ip_literal")
    try:
        ipaddress.ip_address(host)
        raise ModelTargetError("forbidden", "ip_literal")
    except ValueError:
        pass
    labels = host.split(".")
    if len(labels) < 2 or any(not label or len(label) > 63 for label in labels):
        raise ModelTargetError("invalid", "host_labels")
    if not all((char.isascii() and char.isalnum()) or char == "-" for label in labels for char in label):
        raise ModelTargetError("invalid", "host_chars")
    try:
        port = parts.port
    except ValueError as exc:
        raise ModelTargetError("invalid", "port") from exc
    if port is None:
        port = 443
    if not 1 <= port <= 65535:
        raise ModelTargetError("invalid", "port")
    path = parts.path or ""
    if (path and not path.startswith("/")) or ".." in path or "\\" in path:
        raise ModelTargetError("invalid", "path")
    if path.rstrip("/").endswith(CHAT_SUFFIX):
        raise ModelTargetError("invalid", "already_chat_url")
    normalized = raw.rstrip("/")
    addresses = tuple(resolve_and_check(host, resolver)) if resolve else ()
    return ValidatedTarget(baseUrl=normalized, chatUrl=f"{normalized}{CHAT_SUFFIX}", host=host, port=port, addresses=addresses)


def chat_url(target: ValidatedTarget) -> str:
    return target.chatUrl


class _StrictRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        raise ModelTargetError("forbidden", "redirect")


def build_opener() -> urllib.request.OpenerDirector:
    return urllib.request.build_opener(
        NO_PROXY_HANDLER,
        _StrictRedirectHandler(),
    )


NO_PROXY_HANDLER = urllib.request.ProxyHandler({})
