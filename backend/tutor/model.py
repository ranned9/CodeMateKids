"""可选模型适配：证据字段显式映射，任何适配异常立即转本地预置回复。"""

from __future__ import annotations

import json
import urllib.request
from typing import Any

from backend.infra.config import Settings
from backend.tutor.evidence import to_model_evidence


class ModelUnavailable(RuntimeError):
    pass


OBSERVATION_LABELS = {
    "targetSteps": "目标累计步数", "actualSteps": "实际累计步数", "moves": "实际前进次数",
    "repeatTimes": "当前重复次数", "stepsPerMove": "当前每次前进步数",
}


def numeric_observations(context: dict[str, Any]) -> dict[str, int]:
    facts = context.get("facts") or {}
    return {name: facts[name] for name in OBSERVATION_LABELS if type(facts.get(name)) is int}


def build_model_request(context: dict[str, Any], decision: Any) -> dict[str, Any]:
    evidence, _diagnostics = to_model_evidence(context.get("evidence") or [])
    evidence = [item for item in evidence if item["type"] != "self_feedback"]
    payload = {
        "protocolVersion": 1,
        "requestId": context.get("request_id"),
        "mode": "model",
        "locale": "zh-CN",
        "taskContext": {
            "courseId": context.get("course_id", "demo-loop"),
            "taskId": context.get("task_id", "main"),
            "objective": str(context.get("objective", ""))[:120],
        },
        "programSummary": {
            "valid": bool(context.get("program_valid", True)),
            "summary": "",
            "lastRunStatus": context.get("last_run_status") if context.get("enhanced") else None,
        },
        "evidence": evidence,
        "learnerChoice": context.get("learner_choice", "hint"),
        "safety": {"demoDataOnly": True},
    }
    if context.get("enhanced") and decision is not None:
        observations = numeric_observations(context)
        payload["programSummary"]["summary"] = "，".join(
            f"{OBSERVATION_LABELS[name]} {observations[name]}"
            for name in ("repeatTimes", "stepsPerMove") if name in observations
        )
        payload["evidence"] = [
            {"type": "run_result", "fact": f"{OBSERVATION_LABELS[name]} {value}", "confidence": 1.0}
            for name, value in observations.items()
        ]
        payload["teachingDecision"] = {
            "action": decision.action,
            "allowedLevel": decision.level,
            "pattern": decision.error_pattern,
            "factIds": list(observations),
            "nextAction": context["next_action"],
        }
    return payload


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
