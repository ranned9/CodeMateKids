"""脱敏运行日志：白名单字段投影后按行写入 logs/run.jsonl。"""

from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from backend.infra.config import Settings

ALLOWED_FIELDS: tuple[str, ...] = (
    "ts",
    "event",
    "requestId",
    "protocolVersion",
    "schemaVersion",
    "contentVersion",
    "category",
    "durationMs",
    "matrixCaseId",
    "appVersion",
    "pythonVersion",
    "stderrSummary",
    "level",
)

_WRITE_LOCK = threading.Lock()


def project_record(record: dict[str, Any]) -> dict[str, Any]:
    return {key: record[key] for key in ALLOWED_FIELDS if key in record}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_log(settings: Settings, record: dict[str, Any]) -> dict[str, Any]:
    payload = project_record(record)
    payload.setdefault("ts", utc_now_iso())
    payload.setdefault("level", "info")
    line = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    try:
        log_dir = Path(settings.log_dir)
        log_dir.mkdir(parents=True, exist_ok=True)
        with _WRITE_LOCK:
            with open(log_dir / "run.jsonl", "a", encoding="utf-8", newline="\n") as handle:
                handle.write(line + "\n")
    except OSError:
        pass
    return payload


def tail_logs(settings: Settings, tail: int) -> list[dict[str, Any]]:
    path = Path(settings.log_dir) / "run.jsonl"
    if not path.exists():
        return []
    with open(path, "r", encoding="utf-8") as handle:
        lines = handle.readlines()
    selected: Iterable[str] = lines[-tail:] if tail > 0 else []
    records: list[dict[str, Any]] = []
    for line in selected:
        try:
            records.append(project_record(json.loads(line)))
        except json.JSONDecodeError:
            continue
    return records


def timed(settings: Settings, event: str, started_at: float, **extra: Any) -> dict[str, Any]:
    record: dict[str, Any] = {
        "event": event,
        "durationMs": int((time.perf_counter() - started_at) * 1000),
    }
    record.update(extra)
    return write_log(settings, record)