"""worker 输出流消费：可打断的帧队列读取与标准错误脱敏摘要。"""

from __future__ import annotations

import json
import queue
import re
import threading
from typing import Any, TextIO

FRAME_QUEUE_SIZE = 512
DIGEST_LIMIT = 160

_DRIVE_PATH = re.compile(r"[A-Za-z]:\\[^\s\"']+")
_UNIX_PATH = re.compile(r"(?<![\w])/(?:[\w.\-]+/)*[\w.\-]+")
_ENV_SECRET = re.compile(r"CMK_[A-Z0-9_]+(?:=\S+)?")
_TOKEN = re.compile(r"[0-9a-f]{32,}")


class FrameReader:
    """stdout JSONL 帧读取：daemon 线程 + 有界队列，支持带超时取帧。"""

    def __init__(self, stream: TextIO, queue_size: int = FRAME_QUEUE_SIZE) -> None:
        self.stream = stream
        self.queue: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=queue_size)
        self.closed = threading.Event()
        self.thread = threading.Thread(target=self._loop, daemon=True, name="cmk-frame-reader")

    def start(self) -> None:
        self.thread.start()

    def _put(self, frame: dict[str, Any]) -> None:
        while not self.closed.is_set():
            try:
                self.queue.put(frame, timeout=0.1)
                return
            except queue.Full:
                continue

    def _loop(self) -> None:
        try:
            for line in self.stream:
                stripped = line.strip()
                if not stripped:
                    continue
                try:
                    frame = json.loads(stripped)
                except json.JSONDecodeError:
                    frame = {"type": "_invalid_json"}
                if not isinstance(frame, dict):
                    frame = {"type": "_invalid_json"}
                self._put(frame)
                if self.closed.is_set():
                    return
        except (OSError, ValueError):
            pass
        finally:
            self._put({"type": "_eof"})

    def next_frame(self, timeout: float) -> dict[str, Any] | None:
        try:
            return self.queue.get(timeout=max(0.0, timeout))
        except queue.Empty:
            return None

    def close(self) -> None:
        if self.closed.is_set():
            return
        self.closed.set()
        try:
            self.stream.close()
        except (OSError, ValueError):
            pass
        if self.thread.is_alive() and self.thread is not threading.current_thread():
            self.thread.join(timeout=1.0)


def sanitize_text(text: str, cancel_token: str = "") -> str:
    cleaned = _DRIVE_PATH.sub("<path>", text)
    cleaned = _UNIX_PATH.sub("<path>", cleaned)
    cleaned = _ENV_SECRET.sub("CMK_<redacted>", cleaned)
    cleaned = _TOKEN.sub("<token>", cleaned)
    if cancel_token:
        cleaned = cleaned.replace(cancel_token, "<token>")
    cleaned = " ".join(cleaned.split())
    return cleaned[:DIGEST_LIMIT]


class StderrDigest:
    """持续消费 stderr，仅保留首个非空行的脱敏摘要，防止管道写满。"""

    def __init__(self, stream: TextIO | None, cancel_token: str = "") -> None:
        self.stream = stream
        self.cancel_token = cancel_token
        self.total_bytes = 0
        self.first_line = ""
        self.closed = threading.Event()
        self.thread = threading.Thread(target=self._loop, daemon=True, name="cmk-stderr-reader")

    def start(self) -> None:
        if self.stream is not None:
            self.thread.start()

    def _loop(self) -> None:
        if self.stream is None:
            return
        try:
            for line in self.stream:
                if self.closed.is_set():
                    return
                self.total_bytes += len(line.encode("utf-8", errors="ignore"))
                if not self.first_line and line.strip():
                    self.first_line = line.strip()
        except (OSError, ValueError):
            pass

    def summary(self) -> str:
        if not self.first_line:
            return ""
        text = sanitize_text(self.first_line, self.cancel_token)
        return f"{text} [stderr {self.total_bytes}B]"[:DIGEST_LIMIT]

    def close(self) -> None:
        if self.closed.is_set():
            return
        self.closed.set()
        try:
            if self.stream is not None:
                self.stream.close()
        except (OSError, ValueError):
            pass
        if self.stream is not None and self.thread.is_alive() and self.thread is not threading.current_thread():
            self.thread.join(timeout=1.0)