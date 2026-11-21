"""DV-WM-04：目标地址策略、受控出站与重定向禁跟随。"""

from __future__ import annotations

import urllib.error

import pytest

from backend.infra import net_policy
from backend.infra.net_policy import (
    ModelTargetError,
    build_opener,
    chat_url,
    is_forbidden_ip,
    resolve_and_check,
    validate_target,
)


def _resolver(ip: str = "93.184.216.34"):
    calls = []

    def resolve(host: str) -> list[str]:
        calls.append(host)
        return [ip]

    resolve.calls = calls
    return resolve


@pytest.mark.parametrize(
    "url,category",
    [
        ("http://provider.example/v1", "invalid"),
        ("https://u:p@provider.example/v1", "invalid"),
        ("https://provider.example/v1?q=1", "invalid"),
        ("https://provider.example/v1#f", "invalid"),
        ("https://provider.example/v1/../x", "invalid"),
        ("https://provider.example/v1/chat/completions", "invalid"),
        ("https://127.0.0.1/v1", "forbidden"),
        ("https://10.0.0.5/v1", "forbidden"),
        ("https://192.168.1.1/v1", "forbidden"),
        ("https://169.254.1.1/v1", "forbidden"),
        ("https://[::1]/v1", "forbidden"),
        ("https://[fc00::1]/v1", "forbidden"),
        ("https://[fe80::1]/v1", "forbidden"),
    ],
)
def test_rejects_dangerous_targets(url, category) -> None:
    resolver = _resolver()
    with pytest.raises(ModelTargetError) as raised:
        validate_target(url, resolver=resolver)
    assert raised.value.category == category, url
    assert resolver.calls == [], "拒绝时不得解析域名"


def test_accepts_public_https_with_any_port_and_path() -> None:
    resolver = _resolver()
    target = validate_target("https://provider.example:8443/api/v1/", resolver=resolver)
    assert chat_url(target) == "https://provider.example:8443/api/v1/chat/completions"
    assert resolver.calls == ["provider.example"]


def test_rejects_private_resolved_address() -> None:
    with pytest.raises(ModelTargetError) as raised:
        validate_target("https://provider.example/v1", resolver=_resolver("10.1.2.3"))
    assert raised.value.category == "forbidden"


def test_deepseek_replaces_fake_dns_addresses(monkeypatch) -> None:
    monkeypatch.setattr(net_policy, "_resolve_deepseek_public", lambda: ["39.174.179.5"])
    target = validate_target("https://api.deepseek.com", resolver=lambda _: ["198.18.0.89", "2001:2::59"])
    assert target.addresses == ("39.174.179.5",)
    assert chat_url(target) == "https://api.deepseek.com/chat/completions"


def test_dns_fallback_is_limited_to_the_official_deepseek_hostname(monkeypatch) -> None:
    monkeypatch.setattr(net_policy, "_resolve_deepseek_public", lambda: pytest.fail("Unexpected public DNS lookup"))
    for url, address in (("https://provider.example", "198.18.0.89"), ("https://api.deepseek.com", "10.1.2.3")):
        with pytest.raises(ModelTargetError, match="forbidden"):
            validate_target(url, resolver=_resolver(address))


def test_deepseek_still_rejects_private_fallback_addresses(monkeypatch) -> None:
    monkeypatch.setattr(net_policy, "_resolve_deepseek_public", lambda: ["39.174.179.5", "127.0.0.1"])
    with pytest.raises(ModelTargetError) as raised:
        validate_target("https://api.deepseek.com", resolver=_resolver("198.18.0.89"))
    assert raised.value.reason == "deepseek_public_dns_unavailable"


def test_deepseek_chat_uses_its_token_limit_and_disables_thinking() -> None:
    from backend.tutor.chat_adapter import build_payload

    payload = build_payload("deepseek-flash", [], host="api.deepseek.com")
    assert payload["max_tokens"] == 512
    assert payload["thinking"] == {"type": "disabled"}
    assert "max_completion_tokens" not in payload
    assert build_payload("other-model", [])["max_completion_tokens"] == 512


def test_resolve_and_check_runs_each_call() -> None:
    resolver = _resolver()
    resolve_and_check("provider.example", resolver)
    resolve_and_check("provider.example", resolver)
    assert len(resolver.calls) == 2, "每次请求必须重新解析并复验"


def test_ip_literal_and_length_limits() -> None:
    assert is_forbidden_ip("127.0.0.1") is True
    assert is_forbidden_ip("8.8.8.8") is False
    with pytest.raises(ModelTargetError):
        validate_target("https://" + "a" * 600 + ".example/v1", resolver=_resolver())
    with pytest.raises(ModelTargetError):
        validate_target("https://provider.example:0/v1", resolver=_resolver())


def test_chat_url_normalization() -> None:
    resolver = _resolver()
    assert chat_url(validate_target("https://h.example/v1", resolver=resolver)).endswith("/v1/chat/completions")
    assert chat_url(validate_target("https://h.example/v1/", resolver=resolver)).endswith("/v1/chat/completions")


def test_redirect_handler_raises_without_second_hop() -> None:
    handler = net_policy._StrictRedirectHandler()
    with pytest.raises(ModelTargetError) as raised:
        handler.redirect_request(None, None, 302, "Found", {}, "https://evil.example/")
    assert raised.value.category == "forbidden"


def test_opener_disables_proxy(monkeypatch) -> None:
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:9")
    opener = build_opener()
    handler_names = {type(handler).__name__ for handler in opener.handlers}
    assert any("StrictRedirect" in name for name in handler_names)
    assert net_policy.NO_PROXY_HANDLER.proxies == {}, "必须显式禁用系统代理"


def test_chat_transport_dials_validated_address_and_stops_on_redirect(monkeypatch) -> None:
    from types import SimpleNamespace

    from backend.tutor import chat_adapter

    opened = []
    connections = []

    class Connection:
        def __init__(self, host, port, timeout):
            self.host, self.port = host, port
            opened.append((host, port))

        def request(self, method, path, body, headers):
            self._create_connection((self.host, self.port), 1, None)
            assert method == "POST" and path == "/v1/chat/completions"
            assert headers["Authorization"] == "Bearer test-only"

        def getresponse(self):
            return SimpleNamespace(status=302)

        def close(self):
            pass

    monkeypatch.setattr(chat_adapter.http.client, "HTTPSConnection", Connection)
    monkeypatch.setattr(chat_adapter.socket, "create_connection", lambda address, *args: connections.append(address))
    target = validate_target("https://provider.example/v1", resolver=_resolver("93.184.216.34"))
    with pytest.raises(chat_adapter.ChatAdapterError) as failed:
        chat_adapter.send({}, target, "test-only", 1)
    assert failed.value.category == "forbidden"
    assert opened == [("provider.example", 443)]
    assert connections == [("93.184.216.34", 443)]
