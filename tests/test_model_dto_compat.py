"""T-WM-09：配置 DTO 可选性、校验边界与旧请求兼容。"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from backend.api.dto import (
    LearningContext,
    ModelConfigActivateRequest,
    ModelConfigDisableRequest,
    ModelConfigTestRequest,
    PredictionRequest,
    TutorHintRequest,
)


def test_config_test_request_limits_and_extra_forbid() -> None:
    okay = ModelConfigTestRequest(expectedRevision=0, baseUrl="https://h.example/v1", model="m", apiKey="k")
    assert okay.expectedRevision == 0
    with pytest.raises(ValidationError):
        ModelConfigTestRequest(expectedRevision=0, baseUrl="x" * 513, model="m", apiKey="k")
    with pytest.raises(ValidationError):
        ModelConfigTestRequest(expectedRevision=0, baseUrl="https://h.example", model="m" * 161, apiKey="k")
    with pytest.raises(ValidationError):
        ModelConfigTestRequest(expectedRevision=0, baseUrl="https://h.example", model="m", apiKey="k", extra="x")
    with pytest.raises(ValidationError):
        ModelConfigTestRequest(expectedRevision=-1, baseUrl="https://h.example", model="m", apiKey="k")


def test_activate_rejects_credentials_and_bad_test_id() -> None:
    with pytest.raises(ValidationError):
        ModelConfigActivateRequest(expectedRevision=0, testId="t-1", apiKey="k")
    with pytest.raises(ValidationError):
        ModelConfigActivateRequest(expectedRevision=0, testId="bad test id")
    assert ModelConfigActivateRequest(expectedRevision=0, testId="t_1").testId == "t_1"


def test_disable_requires_only_revision() -> None:
    assert ModelConfigDisableRequest(expectedRevision=2).expectedRevision == 2
    with pytest.raises(ValidationError):
        ModelConfigDisableRequest(expectedRevision=2, apiKey="k")


def test_learning_context_turn_fields_are_optional() -> None:
    context = LearningContext()
    assert context.turnId is None
    assert context.replyToTurnId is None
    with_turn = LearningContext(turnId="turn-1", replyToTurnId="turn-0")
    assert with_turn.replyToTurnId == "turn-0"
    with pytest.raises(ValidationError):
        LearningContext(turnId="bad turn id")


def test_old_requests_unchanged() -> None:
    assert PredictionRequest(taskId="main", value=2).learningContext is None
    assert TutorHintRequest(taskId="main").learningContext is None