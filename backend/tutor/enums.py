"""教学增强枚举单一真源：Python 判定、JSON Schema 与前端镜像由测试强制一致。"""

from __future__ import annotations

from enum import StrEnum


class Pattern(StrEnum):
    PROGRAM_INVALID = "program_invalid"
    RUN_INCOMPLETE = "run_incomplete"
    NOT_RUN = "not_run"
    SQUARE_LOOP_STRUCTURE = "square_loop_structure"
    ACTION_OUTSIDE_LOOP = "action_outside_loop"
    LOOP_COUNT_MISMATCH = "loop_count_mismatch"
    MOVE_STEPS_MISMATCH = "move_steps_mismatch"
    PREDICTION_MISMATCH = "prediction_mismatch"
    GOAL_MET = "goal_met"
    UNKNOWN = "unknown"


class NonTeachingPattern(StrEnum):
    DEFAULT = "default"
    PERSONAL_INFO = "personal_info"
    ASK_ANSWER = "ask_answer"
    OFF_TOPIC = "off_topic"


class Outcome(StrEnum):
    GOAL_MET = "goal_met"
    GOAL_MISSED = "goal_missed"
    RUN_INCOMPLETE = "run_incomplete"


class TraceQuality(StrEnum):
    VERIFIED = "verified"
    UNAVAILABLE = "unavailable"
    INCONSISTENT = "inconsistent"


class PredictionMatch(StrEnum):
    EXACT = "exact"
    CARRIED = "carried"
    NONE = "none"


class Support(StrEnum):
    NONE = "none"
    ASSISTED = "assisted"
    UNKNOWN = "unknown"


class TransferStatus(StrEnum):
    NOT_STARTED = "not_started"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    SKIPPED = "skipped"


class NextAction(StrEnum):
    PREDICT = "predict"
    RUN = "run"
    COMPARE = "compare"
    LOCATE_BLOCK = "locate_block"
    REPLAY = "replay"
    EDIT_ONE = "edit_one"
    OPEN_NEXT_TASK = "open_next_task"
    NONE = "none"


TEACHING_PATTERNS = tuple(item.value for item in Pattern)
NON_TEACHING_PATTERNS = tuple(item.value for item in NonTeachingPattern)


def all_patterns() -> tuple[str, ...]:
    return TEACHING_PATTERNS + NON_TEACHING_PATTERNS


def values(enum_type: type[StrEnum]) -> tuple[str, ...]:
    return tuple(item.value for item in enum_type)


def pattern_values() -> tuple[str, ...]:
    return all_patterns()


def outcome_values() -> tuple[str, ...]:
    return values(Outcome)


def trace_quality_values() -> tuple[str, ...]:
    return values(TraceQuality)


def prediction_match_values() -> tuple[str, ...]:
    return values(PredictionMatch)


def support_values() -> tuple[str, ...]:
    return values(Support)


def transfer_status_values() -> tuple[str, ...]:
    return values(TransferStatus)


def next_action_values() -> tuple[str, ...]:
    return values(NextAction)