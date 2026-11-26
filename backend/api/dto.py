"""Pydantic 入参/出参模型：extra=forbid，禁止源码文本字段透传。"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints


class ApiModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


IDENTIFIER_PATTERN = r"^[A-Za-z0-9_-]{1,64}$"
CONTENT_VERSION_PATTERN = r"^[0-9]+\.[0-9]+\.[0-9]+$"
Identifier = Annotated[str, Field(pattern=IDENTIFIER_PATTERN)]


class LearningScope(ApiModel):
    """一次练习的定位四元组；全部可选，缺省走 0.4.0 原路径。"""

    courseId: Identifier | None = None
    contentVersion: str | None = Field(default=None, pattern=CONTENT_VERSION_PATTERN)
    taskId: str | None = Field(default=None, max_length=64)
    workspaceId: str | None = Field(default=None, pattern=IDENTIFIER_PATTERN)


class LearningContext(ApiModel):
    """教学增强上下文；任一字段缺省都不影响既有请求语义。"""

    scope: LearningScope | None = None
    program: dict[str, Any] | None = None
    predictionId: str | None = Field(default=None, pattern=IDENTIFIER_PATTERN)
    seenHintIds: list[Identifier] | None = Field(default=None, max_length=8)
    workspaceSource: Literal["task", "project"] | None = None
    runRequestId: str | None = Field(default=None, pattern=IDENTIFIER_PATTERN)
    turnId: Identifier | None = None
    replyToTurnId: Identifier | None = None


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
    courseId: str = ""
    schemaVersion: str
    tutorMode: Literal["mock", "model"]
    tutorChatEnabled: bool = True
    tutorSpeechEnabled: bool = False
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
    learningContext: LearningContext | None = None


class PredictionResponse(ApiModel):
    taskId: str
    value: int
    runUnlocked: bool = True
    attempts: int
    predictionId: str | None = None


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


class RunStepRequest(CancelRequest):
    seq: int = Field(ge=1)


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
    learningContext: LearningContext | None = None


class ChatLearningContext(LearningContext):
    scope: LearningScope
    turnId: Identifier


class TutorChatRequest(ApiModel):
    taskId: str = Field(min_length=1, max_length=64)
    message: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=300)]
    learningContext: ChatLearningContext
    selectedBlockId: Identifier | None = None


class SpeechRecognizeRequest(ApiModel):
    audioBase64: str = Field(max_length=1_400_000)


class SpeechSynthesizeRequest(ApiModel):
    turnId: Identifier
    scope: LearningScope


class TaskSpeechRequest(ApiModel):
    taskId: str = Field(min_length=1, max_length=64)
    contentVersion: str = Field(pattern=CONTENT_VERSION_PATTERN)
    part: int = Field(default=0, ge=0)


class StudentCreateRequest(ApiModel):
    displayName: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=24)]


class TutorLearning(ApiModel):
    pattern: str | None = None
    runRequestId: str | None = None
    anchorBlockId: str | None = None
    nextAction: str | None = None
    turnId: Identifier | None = None
    awaitingAnswer: bool | None = None


class TutorHintResponse(ApiModel):
    requestId: str | None = None
    action: str
    message: str
    nextStep: str
    evidenceUsed: list[str]
    uncertainty: str
    answerLevel: int
    mode: Literal["mock", "model"]
    showAsDemo: bool
    fallbackReason: str | None = None
    learning: TutorLearning | None = None


class TransferInfo(ApiModel):
    taskId: str
    title: str | None = None
    status: str
    support: str
    runRequestId: str | None = None


class SessionSummaryResponse(ApiModel):
    concepts: list[str]
    completedTasks: list[str]
    independentThings: list[str]
    toVerify: list[str]
    nextStep: str
    missing: list[str]
    skippedTasks: list[str]
    variantAvailable: bool
    mainCompleted: bool
    variantCompleted: bool
    note: str
    taskCount: int
    transfer: TransferInfo | None = None
    nextTaskId: str | None = None
    observation: str | None = None


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
    debug: bool = False
    learningContext: LearningContext | None = None

class ModelConfigTestRequest(ApiModel):
    expectedRevision: int = Field(ge=0)
    baseUrl: str = Field(min_length=1, max_length=512)
    model: str = Field(min_length=1, max_length=160)
    apiKey: str | None = Field(default=None, min_length=1, max_length=2048)


class ModelConfigActivateRequest(ApiModel):
    expectedRevision: int = Field(ge=0)
    testId: Identifier | None = None


class ModelConfigDisableRequest(ApiModel):
    expectedRevision: int = Field(ge=0)
