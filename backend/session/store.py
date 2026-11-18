"""会话内存证据库：观察事实与系统解释分字段，证据绑定 requestId。"""

from __future__ import annotations

import threading
import uuid
from datetime import datetime, timezone
from typing import Any

from backend.service.course import load_course

MAX_EVIDENCE = 500
SOURCE_TYPES = (
    "answer",
    "run_result",
    "edit_trace",
    "hint_usage",
    "transfer_task",
    "self_feedback",
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class SessionStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.session_started_at = _now()
        self.predictions: dict[str, list[dict[str, Any]]] = {}
        self.evidence: list[dict[str, Any]] = []
        self.attempts: dict[str, list[dict[str, Any]]] = {}
        self.skipped: set[str] = set()
        self.hint_levels: dict[str, int] = {}
        self._evidence_seq = 0

    def add_prediction(self, task_id: str, value: int) -> int:
        with self._lock:
            history = self.predictions.setdefault(task_id, [])
            history.append({"value": value, "at": _now()})
            attempts = len(history)
        self.add_evidence(
            task_id=task_id,
            source_type="answer",
            observed_fact=f"预测角色会动 {value} 次",
            interpretation_text="孩子给出了一个可以对照的预测",
            confidence=0.9,
            alternatives=["可能是随口猜的", "可能把次数和步数弄混了"],
            follow_up="运行后把预测和实际结果放在一起对照",
        )
        return attempts

    def has_prediction(self, task_id: str) -> bool:
        with self._lock:
            return bool(self.predictions.get(task_id))

    def prediction_value(self, task_id: str) -> int | None:
        with self._lock:
            history = self.predictions.get(task_id) or []
            if not history:
                return None
            return int(history[-1]["value"])

    def note_hint(self, task_id: str, level: int) -> None:
        if int(level) <= 0:
            return
        with self._lock:
            current = self.hint_levels.get(task_id, 0)
            self.hint_levels[task_id] = max(current, int(level))

    def highest_hint(self, task_id: str) -> int:
        with self._lock:
            return int(self.hint_levels.get(task_id, 0))

    def add_evidence(
        self,
        task_id: str,
        source_type: str,
        observed_fact: str,
        interpretation_text: str,
        confidence: float,
        alternatives: list[str],
        follow_up: str,
        request_id: str | None = None,
        knowledge_point_id: str = "kp.loop",
        correction_of: str | None = None,
    ) -> dict[str, Any]:
        if source_type not in SOURCE_TYPES:
            raise ValueError("来源类型越界")
        if not alternatives:
            alternatives = ["操作还不熟练", "可能只是这一次看错了"]
        with self._lock:
            self._evidence_seq += 1
            evidence_id = f"ev-{self._evidence_seq:04d}"
            confidence_value = max(0.0, min(1.0, float(confidence)))
            record = {
                "evidenceId": evidence_id,
                "knowledgePointId": knowledge_point_id,
                "courseId": "demo-loop",
                "taskId": task_id,
                "occurredAt": _now(),
                "sourceType": source_type,
                "requestId": request_id,
                "observedFact": observed_fact,
                "interpretation": {
                    "text": interpretation_text,
                    "confidence": confidence_value,
                    "basedOn": [source_type],
                },
                "confidence": confidence_value,
                "validityWindow": {
                    "start": self.session_started_at,
                    "end": _now(),
                    "scope": "本次会话",
                },
                "alternatives": list(alternatives),
                "followUpSuggestion": follow_up,
                "correctionOf": correction_of,
            }
            self.evidence.append(record)
            if len(self.evidence) > MAX_EVIDENCE:
                self.evidence.pop(0)
            return dict(record)

    def record_attempt(
        self,
        task_id: str,
        request_id: str,
        outcome: str,
        highest_hint_level: int | None = None,
    ) -> dict[str, Any]:
        level = self.highest_hint(task_id) if highest_hint_level is None else int(highest_hint_level)
        attempt = {
            "taskId": task_id,
            "requestId": request_id,
            "outcome": outcome,
            "highestHintLevel": level,
            "independent": outcome == "succeeded" and level == 0,
            "finishedAt": _now(),
        }
        with self._lock:
            self.attempts.setdefault(task_id, []).append(attempt)
        return attempt

    def mark_skipped(self, task_id: str) -> None:
        with self._lock:
            self.skipped.add(task_id)

    def mark_resumed(self, task_id: str) -> None:
        with self._lock:
            self.skipped.discard(task_id)

    def evidence_for(self, task_id: str) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(item) for item in self.evidence if item["taskId"] == task_id]

    def recent_evidence(self, task_id: str, limit: int = 5) -> list[dict[str, Any]]:
        with self._lock:
            items = [dict(item) for item in self.evidence if item["taskId"] == task_id]
        return items[-limit:]

    def attempts_for(self, task_id: str) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(item) for item in self.attempts.get(task_id, [])]

    def summary(self, settings) -> dict[str, Any]:
        bundle = load_course(settings)
        course = bundle.course
        titles = {task_id: bundle.tasks[task_id]["title"] for task_id in bundle.task_order()}
        completed: list[str] = []
        independent: list[str] = []
        for task_id in bundle.task_order():
            if any(item["outcome"] == "succeeded" for item in self.attempts_for(task_id)):
                completed.append(titles.get(task_id, task_id))
                if any(item["independent"] for item in self.attempts_for(task_id)):
                    independent.append(titles.get(task_id, task_id))
        variant_id = next(
            (task_id for task_id in bundle.task_order() if bundle.tasks[task_id]["type"] == "variant"),
            "variant",
        )
        main_id = next(
            (task_id for task_id in bundle.task_order() if bundle.tasks[task_id]["type"] == "main"),
            "main",
        )
        variant_completed = any(item["outcome"] == "succeeded" for item in self.attempts_for(variant_id))
        main_completed = any(item["outcome"] == "succeeded" for item in self.attempts_for(main_id))
        with self._lock:
            has_any_evidence = bool(self.evidence)
            skipped = sorted(self.skipped)
        to_verify: list[str] = []
        if not variant_completed:
            to_verify.append("还没在新情境里独立用过循环")
        to_verify.append("这次只观察了当前会话，长期表现还需要以后再看")
        missing: list[str] = []
        if not has_any_evidence:
            missing.append("这次还没有运行记录")
        if skipped:
            missing.append("有任务被暂时跳过，可以稍后回来")
        if not main_completed:
            missing.append("主任务还没完成")
        if variant_completed:
            next_step = "可以休息一下，或者再练一次变式任务"
        elif main_completed:
            next_step = "去试试变式任务：小海龟走六步"
        else:
            next_step = "先把重复次数改成目标步数，运行看看"
        return {
            "concepts": list(course["learningObjectives"]),
            "completedTasks": completed,
            "independentThings": independent,
            "toVerify": to_verify,
            "nextStep": next_step,
            "missing": missing,
            "skippedTasks": [titles.get(item, item) for item in skipped],
            "variantAvailable": variant_id in bundle.tasks and not bundle.blocked.get(variant_id),
            "mainCompleted": main_completed,
            "variantCompleted": variant_completed,
            "note": "仅代表本次会话观察，不代表长期能力结论。",
            "taskCount": len(bundle.tasks),
        }

    def snapshot_counts(self) -> dict[str, int]:
        with self._lock:
            return {
                "evidence": len(self.evidence),
                "predictions": sum(len(items) for items in self.predictions.values()),
                "skipped": len(self.skipped),
            }

    def new_request_id(self) -> str:
        return f"tutor-{uuid.uuid4().hex[:12]}"