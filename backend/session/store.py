"""会话内存证据库：观察事实与系统解释分字段，证据绑定 requestId。"""

from __future__ import annotations

import threading
import uuid
from datetime import datetime, timezone
from typing import Any

from backend.infra.errors import ApiError
from backend.service.course import load_course, next_task_id
from backend.session.learning_store import LearningStore
from backend.session.teaching_store import TeachingStore

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
    def __init__(self, student_id: str | None = None, memory: LearningStore | None = None) -> None:
        self._lock = threading.Lock()
        self.session_started_at = _now()
        self.predictions: dict[str, list[dict[str, Any]]] = {}
        self.evidence: list[dict[str, Any]] = []
        self.attempts: dict[str, list[dict[str, Any]]] = {}
        self.skipped: set[str] = set()
        self._skip_versions: dict[str, str | None] = {}
        self.hint_levels: dict[str, int] = {}
        self._evidence_seq = 0
        self.teaching = TeachingStore()
        self.student_id = student_id
        self.memory = memory
        self.memory_available = True

    def observe(self, scope: str | None, points: list[str], source: str, source_id: str,
                kind: str, details: dict) -> None:
        if self.memory is None or self.student_id is None or not scope or not points:
            return
        try:
            self.memory.observe(self.student_id, scope, points, source, source_id, kind, details)
        except ApiError:
            self.memory_available = False
        else:
            self.memory_available = True

    def learning_observations(self, course_id: str, points: list[str]) -> list[dict]:
        if self.memory is None or self.student_id is None:
            return []
        try:
            return [
                item for point in points
                for item in self.memory.observations(self.student_id, course_id, point=point, limit=12)
            ]
        except ApiError:
            self.memory_available = False
            return []

    def add_prediction(self, task_id: str, value: int, content_version: str | None = None) -> int:
        with self._lock:
            history = self.predictions.setdefault(task_id, [])
            history.append({"value": value, "at": _now(), "contentVersion": content_version})
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

    def has_prediction(self, task_id: str, content_version: str | None = None) -> bool:
        with self._lock:
            history = self.predictions.get(task_id, [])
            return any(content_version is None or item["contentVersion"] == content_version for item in history)

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

    def confirm_teaching_hints(self, scope: str, task_id: str, ids: list[str] | None) -> list[dict[str, Any]]:
        hints, newly_seen = self.teaching.confirm_hints(scope, ids)
        for hint_id in newly_seen:
            self.add_evidence(
                task_id=task_id, source_type="hint_usage", observed_fact="这一轮展示了小老师的提示。",
                interpretation_text="课堂提供过帮助。", confidence=1.0,
                alternatives=["孩子可能按自己的方法继续"],
                follow_up="看看下一次运行。", request_id=hint_id,
            )
        for hint in hints:
            if hint["hintId"] in newly_seen:
                self.observe(scope, hint.get("knowledgePoints", []), "hint", hint["hintId"], "hint_shown", {
                    "action": hint.get("action", "hint"), "level": hint["level"], "pattern": hint["pattern"],
                })
        return hints

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
        *,
        support: str | None = None,
        content_version: str | None = None,
    ) -> dict[str, Any]:
        level = self.highest_hint(task_id) if highest_hint_level is None else int(highest_hint_level)
        attempt = {
            "taskId": task_id,
            "requestId": request_id,
            "outcome": outcome,
            "highestHintLevel": level,
            "independent": outcome == "succeeded" and (support == "none" if support is not None else level == 0),
            "support": support,
            "contentVersion": content_version,
            "finishedAt": _now(),
        }
        with self._lock:
            history = self.attempts.setdefault(task_id, [])
            history.append(attempt)
            del history[:-256]
        return attempt

    def mark_skipped(self, task_id: str, content_version: str | None = None) -> None:
        with self._lock:
            self.skipped.add(task_id)
            self._skip_versions[task_id] = content_version

    def mark_resumed(self, task_id: str) -> None:
        with self._lock:
            self.skipped.discard(task_id)
            self._skip_versions.pop(task_id, None)

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
        history = {
            task_id: [item for item in self.attempts_for(task_id)
                      if item["contentVersion"] in (None, bundle.content_version)]
            for task_id in bundle.task_order()
        }
        for task_id in bundle.task_order():
            if any(item["outcome"] == "succeeded" for item in history[task_id]):
                completed.append(titles.get(task_id, task_id))
                if any(item["independent"] for item in history[task_id]):
                    independent.append(titles.get(task_id, task_id))
        main_id = next(
            (task_id for task_id in bundle.task_order() if bundle.tasks[task_id]["type"] == "main"),
            "main",
        )
        variant_id = bundle.tasks[main_id]["variantTaskId"]
        variant_completed = any(item["outcome"] == "succeeded" for item in history[variant_id])
        main_completed = any(item["outcome"] == "succeeded" for item in history[main_id])
        transfer_id = next((task_id for task_id, task in bundle.tasks.items()
                            if task.get("teaching", {}).get("goalKind") == "square"), None)
        with self._lock:
            skipped = sorted(task_id for task_id in self.skipped
                             if self._skip_versions.get(task_id) in (None, bundle.content_version))
            current_run_ids = {record["requestId"] for attempts in history.values() for record in attempts}
            observation = next((item["observedFact"] for item in reversed(self.evidence)
                                if item["sourceType"] == "edit_trace" and item["requestId"] in current_run_ids), None)
        to_verify: list[str] = []
        transfer = _transfer_summary(transfer_id, history[transfer_id], skipped) if transfer_id else None
        if transfer and transfer["support"] != "none":
            to_verify.append("下次可以试着独立完成画正方形。")
        elif not transfer and not variant_completed:
            to_verify.append("还没在新情境里独立用过循环")
        to_verify.append("这次只观察了当前会话，长期表现还需要以后再看")
        missing: list[str] = []
        if not any(history.values()):
            missing.append("这次还没有运行记录")
        if skipped:
            missing.append("有任务被暂时跳过，可以稍后回来")
        if not main_completed:
            missing.append("主任务还没完成")
        recommended_id = next_task_id(bundle.tasks[variant_id if variant_completed else main_id]) if main_completed else main_id
        if recommended_id not in bundle.runnable_task_ids or (transfer and transfer["status"] == "completed" and recommended_id == transfer_id):
            recommended_id = None
        if recommended_id and recommended_id != main_id:
            next_step = f"去试试：{titles[recommended_id]}"
        elif main_completed:
            next_step = "可以休息一下，或者再练一次变式任务"
        else:
            next_step = "先把重复次数改成目标步数，运行看看"
        data = {
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
        if transfer:
            data.update(transfer=transfer, nextTaskId=recommended_id)
            transfer_history = history[transfer_id]
            selected_index = next((i for i, record in enumerate(transfer_history)
                                   if record["requestId"] == transfer["runRequestId"]), 0)
            if transfer["support"] == "none" and any(record["support"] == "assisted" for record in transfer_history[:selected_index]):
                previous_help = "这道题的较早一次尝试看过提示，选中的完成记录来自后来一次练习。"
                observation = f"{observation or ''}{previous_help}"
            if observation:
                data["observation"] = observation
        return data

    def snapshot_counts(self) -> dict[str, int]:
        with self._lock:
            return {
                "evidence": len(self.evidence),
                "predictions": sum(len(items) for items in self.predictions.values()),
                "skipped": len(self.skipped),
            }

    def new_request_id(self) -> str:
        return f"tutor-{uuid.uuid4().hex[:12]}"


def _transfer_summary(task_id: str, attempts: list[dict[str, Any]], skipped: list[str]) -> dict[str, Any]:
    successes = [record for record in reversed(attempts) if record["outcome"] == "succeeded"]
    result = next((record for record in successes if record["support"] == "none"), None)
    if result is None:
        result = next((record for record in successes if record["support"] == "assisted"), None)
    if result is None and successes:
        result = successes[0]
    status = "completed" if result else "skipped" if task_id in skipped else "in_progress" if attempts else "not_started"
    return {
        "taskId": task_id, "status": status, "support": (result or {}).get("support") or "unknown",
        "runRequestId": result["requestId"] if result else None,
    }
