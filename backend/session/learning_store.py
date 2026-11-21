"""本机学生档案和可复查的学习观察。"""

from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from pathlib import Path

from backend.infra.errors import ApiError


class LearningStore:
    def __init__(self, path: Path):
        self.path = path
        self._schema_lock = threading.Lock()
        self._initialized = False

    @contextmanager
    def _transaction(self):
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with closing(sqlite3.connect(self.path, timeout=0.5)) as connection:
                connection.row_factory = sqlite3.Row
                connection.execute("PRAGMA foreign_keys = ON")
                with self._schema_lock:
                    if not self._initialized:
                        self._initialize(connection)
                        self._initialized = True
                with connection:
                    yield connection
        except (sqlite3.Error, OSError) as exc:
            raise ApiError("LEARNING_STORE_UNAVAILABLE") from exc

    @staticmethod
    def _initialize(connection):
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version == 1:
            return
        if version != 0:
            raise ApiError("LEARNING_STORE_UNAVAILABLE")
        connection.executescript("""
            BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS students (
                student_id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS learning_observations (
                id INTEGER PRIMARY KEY,
                student_id TEXT NOT NULL REFERENCES students(student_id),
                course_id TEXT NOT NULL,
                content_version TEXT NOT NULL,
                task_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                knowledge_point_id TEXT NOT NULL,
                source_type TEXT NOT NULL,
                source_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                details_json TEXT NOT NULL,
                observed_at TEXT NOT NULL,
                UNIQUE (student_id, course_id, task_id, workspace_id, knowledge_point_id, source_type, source_id, kind)
            );
            CREATE INDEX IF NOT EXISTS observations_by_student
            ON learning_observations(student_id, course_id, knowledge_point_id, observed_at DESC, id DESC);
            PRAGMA user_version = 1;
            COMMIT;
        """)

    def list_students(self) -> list[dict]:
        with self._transaction() as connection:
            return [dict(row) for row in connection.execute(
                """SELECT student_id AS studentId, display_name AS displayName
                   FROM students ORDER BY created_at, student_id"""
            )]

    def create_student(self, display_name: str) -> dict:
        student_id = f"student-{uuid.uuid4().hex}"
        with self._transaction() as connection:
            connection.execute("INSERT INTO students VALUES (?, ?, ?)", (student_id, display_name, _now()))
        return {"studentId": student_id, "displayName": display_name}

    def has_student(self, student_id: str) -> bool:
        with self._transaction() as connection:
            return connection.execute("SELECT 1 FROM students WHERE student_id = ?", (student_id,)).fetchone() is not None

    def observe(self, student_id: str, scope: str, points: list[str], source: str, source_id: str,
                kind: str, details: dict) -> None:
        if not points:
            return
        course, version, task, workspace = scope.split("|")
        payload = json.dumps(details, ensure_ascii=False, separators=(",", ":"))
        now = _now()
        with self._transaction() as connection:
            connection.executemany(
                """INSERT INTO learning_observations (
                     student_id, course_id, content_version, task_id, workspace_id, knowledge_point_id,
                     source_type, source_id, kind, details_json, observed_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT (student_id, course_id, task_id, workspace_id, knowledge_point_id,
                                source_type, source_id, kind) DO NOTHING""",
                [(student_id, course, version, task, workspace, point, source, source_id, kind, payload, now)
                 for point in points],
            )

    def observations(self, student_id: str, course_id: str, *,
                     point: str | None = None, limit: int = 100) -> list[dict]:
        conditions = "student_id = ? AND course_id = ?"
        parameters = [student_id, course_id]
        if point is not None:
            conditions += " AND knowledge_point_id = ?"
            parameters.append(point)
        with self._transaction() as connection:
            rows = connection.execute(
                f"""SELECT task_id AS taskId, content_version AS contentVersion, workspace_id AS workspaceId,
                           knowledge_point_id AS knowledgePointId, source_type AS sourceType, source_id AS sourceId,
                           kind, details_json, observed_at AS observedAt
                    FROM learning_observations WHERE {conditions}
                    ORDER BY observed_at DESC, id DESC LIMIT ?""",
                [*parameters, limit],
            ).fetchall()
        observations = []
        for row in rows:
            item = dict(row)
            item["details"] = json.loads(item.pop("details_json"))
            observations.append(item)
        return observations


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
