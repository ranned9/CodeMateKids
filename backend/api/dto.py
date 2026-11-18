"""Pydantic 入参/出参模型：extra=forbid，禁止源码文本字段透传。"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class ApiModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class StartupCheckItem(ApiModel):
    name: str
    status: Literal["passed", "failed", "warn"]
    detailForChild: str
    detailForDeveloperLogOnly: str = ""


class PythonVersionInfo(ApiModel):
    major: int
    minor: int
    patch: int
    source: Literal["worker_probe", "unavailable"]


class RunCapabilityInfo(ApiModel):
    canRun: bool
    reasonCode: str | None = None
    reasonForChild: str = ""
    workerReady: bool
    blockedTaskIds: list[str] = Field(default_factory=list)
    contentVersion: str = ""


class StartupCheckResponse(ApiModel):
    status: Literal["ready", "degraded", "fatal"]
    checks: list[StartupCheckItem]
    python: PythonVersionInfo
    courseVersion: int
    schemaVersion: str
    tutorMode: Literal["mock", "model"]
    elapsedMs: int
    appVersion: str
    cached: bool = False
    contentVersion: str = ""
    runCapability: RunCapabilityInfo | None = None


class RunSnapshotResponse(ApiModel):
    requestId: str
    finished: bool
    status: Literal["running", "completed", "failed", "timeout", "resource_exceeded", "cancelled", "crashed"]
    errorCategory: str | None = None


class PredictionRequest(ApiModel):
    taskId: str
    value: int = Field(ge=0, le=1000)


class PredictionResponse(ApiModel):
    taskId: str
    value: int
    runUnlocked: bool = True
    attempts: int


class FeedbackRequest(ApiModel):
    taskId: str
    kind: Literal["self_assessment", "skip", "resume"]
    note: str = Field(default="", max_length=120)


class FeedbackResponse(ApiModel):
    taskId: str
    kind: str
    skipped: bool


class CancelRequest(ApiModel):
    cancelToken: str


class SaveProjectRequest(ApiModel):
    program: dict[str, Any]
    courseRef: dict[str, Any]


class LoadProjectRequest(ApiModel):
    fileText: str = Field(max_length=4_200_000)


class TutorHintRequest(ApiModel):
    taskId: str
    learnerChoice: Literal["hint", "more_hint", "example", "self_try", "skip", "none"] = "hint"
    message: str = Field(default="", max_length=300)
    programSummary: str = Field(default="", max_length=200)
    programValid: bool = True
    lastRunStatus: str | None = Field(default=None, max_length=40)


class RunSubmitRequest(ApiModel):
    protocolVersion: int = 1
    requestId: str
    cancelToken: str
    target: dict[str, Any]
    program: dict[str, Any]
    limits: dict[str, Any] | None = None
    courseRef: dict[str, Any]
    taskId: str
    mode: Literal["demo"] = "demo"