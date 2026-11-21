"""解析本机工作台请求的学生与课堂会话。"""

import re
import threading

from fastapi import Request

from backend.api.security import require_local, require_local_same_origin
from backend.infra.errors import ApiError
from backend.session.store import SessionStore


STUDENT_HEADER = "X-CMK-Student-Id"


class StudentSessions:
    def __init__(self, memory):
        self.memory = memory
        self._lock = threading.Lock()
        self._sessions: dict[str, SessionStore] = {}

    def get(self, identity: str) -> SessionStore:
        with self._lock:
            session = self._sessions.get(identity)
            if session is None:
                if re.fullmatch(r"guest-[a-f0-9]{32}", identity):
                    session = SessionStore()
                elif re.fullmatch(r"student-[a-f0-9]{32}", identity) and self.memory.has_student(identity):
                    session = SessionStore(identity, self.memory)
                else:
                    raise ApiError("STUDENT_NOT_FOUND")
                self._sessions[identity] = session
            return session


def classroom_session(request: Request, *, stream_id: str | None = None) -> tuple[str | None, SessionStore]:
    header = request.headers.get(STUDENT_HEADER)
    if stream_id is not None and header is not None and header != stream_id:
        raise ApiError("RUN_NOT_FOUND")
    identity = stream_id if stream_id is not None else header
    if identity is None:
        return None, request.app.state.session
    if request.method == "POST":
        require_local_same_origin(request)
    else:
        require_local(request)
    return identity, request.app.state.student_sessions.get(identity)
