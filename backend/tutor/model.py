"""可选模型适配：证据字段显式映射，任何适配异常立即转本地预置回复。"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any

from backend.infra.config import Settings
from backend.tutor.evidence import to_model_evidence


class ModelUnavailable(RuntimeError):
    pass


def build_model_request(context: dict[str, Any], decision: Any) -> dict[str, Any]:
    evidence, _diagnostics = to_model_evidence(context.get("evidence") or [])
    return {
        "protocolVersion": 1,
        "requestId": context.get("request_id"),
        "mode": "model",
        "locale": "zh-CN",
        "taskContext": {
            "courseId": "demo-loop",
            "taskId": context.get("task_id", "main"),
            "objective": str(context.get("objective", ""))[:120],
        },
        "programSummary": {
            "valid": bool(context.get("program_valid", True)),
            "summary": str(context.get("program_summary", ""))[:200],
            "lastRunStatus": context.get("last_run_status"),
        },
        "evidence": evidence,
        "learnerChoice": context.get("learner_choice", "hint"),
        "safety": {"demoDataOnly": True},
    }


def call_model(settings: Settings, context: dict[str, Any], decision: Any) -> dict[str, Any]:
    if not settings.model_endpoint or not settings.model_key:
        raise ModelUnavailable("missing_credentials")
    try:
        body = json.dumps(build_model_request(context, decision), ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            settings.model_endpoint,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {settings.model_key}",
            },
        )
        timeout = min(settings.tutor_timeout_ms / 1000.0, 8.0)
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - 受保护配置注入
            raw = response.read(64 * 1024)
        payload = json.loads(raw)
    except ModelUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001 - 适配期任何异常都降级
        raise ModelUnavailable("adapter_error") from exc
    if not isinstance(payload, dict):
        raise ModelUnavailable("invalid_payload")
    payload.setdefault("mode", "model")
    payload.setdefault("showAsDemo", False)
    return payload