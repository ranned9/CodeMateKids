"""本机教学对话，按工作区、运行和配置版本隔离。"""

from __future__ import annotations

import threading
import time
from collections import OrderedDict
from copy import deepcopy
from dataclasses import dataclass, field

from backend.infra.errors import ApiError

TTL_SECONDS = 1800
MAX_SCOPES = 64
MAX_TURNS = 6


@dataclass
class _Conversation:
    touched: float
    pending: str | None = None
    turns: OrderedDict = field(default_factory=OrderedDict)


class ConversationStore:
    def __init__(self, clock=time.monotonic, *, classroom: bool = False):
        self._clock = clock
        self._classroom = classroom
        self._lock = threading.Lock()
        self._scopes: OrderedDict[tuple, _Conversation] = OrderedDict()

    def begin(self, scope: tuple, turn_id: str, fingerprint: str, reply_to: str | None):
        with self._lock:
            now = self._clock()
            for key, session in list(self._scopes.items()):
                if session.pending is None and now - session.touched >= TTL_SECONDS:
                    del self._scopes[key]
            session = self._scopes.get(scope)
            if session is not None and turn_id in session.turns:
                previous = session.turns[turn_id]
                if previous["fingerprint"] != fingerprint:
                    raise ApiError(
                        "TUTOR_TURN_CONFLICT" if self._classroom else "RUN_ID_CONFLICT",
                        message="这条回答已经提交，请重新提问。",
                    )
                self._scopes.move_to_end(scope)
                session.touched = now
                return deepcopy(previous["response"]), []
            if session is not None and session.pending is not None:
                raise ApiError(
                    "TUTOR_TURN_BUSY" if self._classroom else "RUN_ID_CONFLICT",
                    message="小老师还在回答上一条，请稍等。",
                )
            history = list(session.turns.values())[-MAX_TURNS:] if session else []
            if not self._classroom and reply_to and (
                not history or next(reversed(session.turns)) != reply_to or not history[-1]["awaiting"]
            ):
                raise ApiError("RUN_ID_CONFLICT", message="这条问题已经过期，请让小老师看看当前积木。")
            if session is None:
                if len(self._scopes) >= MAX_SCOPES:
                    evict = next((key for key, item in self._scopes.items() if item.pending is None), None)
                    if evict is None:
                        raise ApiError(
                            "TUTOR_TURN_BUSY" if self._classroom else "RUN_ID_CONFLICT",
                            message="小老师正在处理其他回答，请稍后再试。",
                        )
                    del self._scopes[evict]
                session = _Conversation(now)
                self._scopes[scope] = session
            self._scopes.move_to_end(scope)
            session.touched = now
            session.pending = turn_id
            return None, [item["context"].copy() for item in history]

    def finish(
        self, scope: tuple, turn_id: str, fingerprint: str, answer: str, response: dict,
        snapshot: dict | None = None,
    ) -> None:
        with self._lock:
            session = self._scopes[scope]
            session.pending = None
            session.touched = self._clock()
            turn_context = {"learner": answer, "tutor": response["message"], "action": response["action"]}
            awaiting = bool(response.get("learning", response)["awaitingAnswer"])
            if self._classroom:
                turn_context.update(turnId=turn_id, snapshot=snapshot, awaitingAnswer=awaiting)
            session.turns[turn_id] = {
                "fingerprint": fingerprint,
                "response": deepcopy(response),
                "awaiting": awaiting,
                "context": turn_context,
            }
            limit = 32 if self._classroom else MAX_TURNS
            while len(session.turns) > limit:
                session.turns.popitem(last=False)

    def abort(self, scope: tuple, turn_id: str) -> None:
        with self._lock:
            session = self._scopes.get(scope)
            if session is not None and session.pending == turn_id:
                session.pending = None
