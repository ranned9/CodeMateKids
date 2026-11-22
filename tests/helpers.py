"""测试共享夹具：程序构造与 SSE 消费。"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def node(block_id: str, kind: str, inputs: dict, body=None, nxt=None) -> dict:
    return {"blockId": block_id, "kind": kind, "inputs": inputs, "body": body or [], "next": nxt}


def program(root: dict, task_id: str = "main") -> dict:
    return {
        "format": "codematekids.program",
        "formatVersion": 1,
        "target": {"language": "python", "version": "3.12"},
        "courseRef": {"courseId": "demo-loop", "version": 1, "taskId": task_id},
        "root": root,
        "metadata": {"createdAt": "2026-11-14T00:00:00Z", "updatedAt": "2026-11-14T00:00:00Z"},
    }


def simple_program(task_id: str = "main") -> dict:
    return program(
        node(
            "b-start",
            "event.start",
            {},
            nxt=node(
                "b-repeat",
                "control.repeat",
                {"times": 2},
                body=[node("b-move", "motion.move", {"steps": 1})],
            ),
        ),
        task_id,
    )


def slow_program(task_id: str = "main", depth: int = 5) -> dict:
    current = node("b-move", "motion.move", {"steps": 1})
    for index in range(depth):
        current = node(f"b-slow-{index}", "control.repeat", {"times": 100}, body=[current])
    return program(node("b-start", "event.start", {}, nxt=current), task_id)


def course_program(settings, task_id: str = "main") -> dict:
    from backend.service.course import load_course

    bundle = load_course(settings)
    return bundle.tasks[task_id]["initialProgram"]


def submit(client, payload: dict, request_id: str, cancel_token: str | None = None, *, debug: bool = False) -> dict:
    body = {
        "protocolVersion": 1,
        "requestId": request_id,
        "cancelToken": cancel_token if cancel_token is not None else f"token-{request_id}",
        "target": {"language": "python", "version": "3.12"},
        "program": payload,
        "courseRef": payload["courseRef"],
        "taskId": payload["courseRef"]["taskId"],
        "mode": "demo",
    }
    if debug:
        body["debug"] = True
    return client.post("/api/v1/runs", json=body)


def drain(client, request_id: str) -> tuple[list[tuple[str, dict]], dict | None]:
    frames: list[tuple[str, dict]] = []
    with client.stream("GET", f"/api/v1/runs/{request_id}/events") as response:
        event = None
        data_lines: list[str] = []
        for line in response.iter_lines():
            if line.startswith("event:"):
                event = line.split(":", 1)[1].strip()
            elif line.startswith("data:"):
                data_lines.append(line.split(":", 1)[1].strip())
            elif line == "":
                if event:
                    frames.append((event, json.loads("".join(data_lines) or "{}")))
                    event = None
                    data_lines = []
    results = [payload for name, payload in frames if name == "result"]
    return frames, (results[0] if results else None)
