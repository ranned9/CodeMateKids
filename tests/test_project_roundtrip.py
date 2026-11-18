"""项目保存/加载：往返一致、旧版迁移、未知块保留与非法输入。"""

from __future__ import annotations

import json
from pathlib import Path

from backend.infra.config import BASE_DIR

FIXTURES = Path(__file__).resolve().parent / "fixtures"
COURSE_REF = {"courseId": "demo-loop", "version": 1, "taskId": "main"}


def _program() -> dict:
    with open(BASE_DIR / "content" / "demo-loop" / "course.json", "r", encoding="utf-8") as handle:
        course = json.load(handle)
    return course["tasks"][0]["initialProgram"]


def test_save_load_save_roundtrip(client) -> None:
    program = _program()
    first = client.post("/api/v1/projects/save", json={"program": program, "courseRef": COURSE_REF})
    assert first.status_code == 200
    payload = first.json()["data"]
    assert payload["formatVersion"] == 1
    assert payload["fileName"].endswith(".json")
    assert "metadata" in payload["program"]

    loaded = client.post("/api/v1/projects/load", json={"fileText": payload["fileText"]})
    assert loaded.status_code == 200
    data = loaded.json()["data"]
    assert data["runnable"] is True
    assert data["program"]["root"]["blockId"] == program["root"]["blockId"]
    assert data["program"]["metadata"]["createdAt"] != program["metadata"]["createdAt"]

    second = client.post("/api/v1/projects/save", json={"program": data["program"], "courseRef": COURSE_REF})
    assert second.status_code == 200
    again = json.loads(second.json()["data"]["fileText"])["root"]
    assert again == data["program"]["root"]


def test_old_version_is_migrated(client) -> None:
    text = (FIXTURES / "program_v0.json").read_text(encoding="utf-8")
    response = client.post("/api/v1/projects/load", json={"fileText": text})
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["migratedFrom"] == 0
    assert data["program"]["formatVersion"] == 1
    assert data["program"]["root"]["next"]["kind"] == "motion.move"
    assert data["program"]["root"]["next"]["inputs"]["steps"] == 3


def test_unknown_block_preserved(client) -> None:
    program = _program()
    program["root"]["next"] = None
    program["root"]["body"] = []
    program["root"]["next"] = {
        "blockId": "b-future",
        "kind": "future.block",
        "inputs": {"x": 1},
        "body": [],
        "next": None,
        "unknown": True,
    }
    saved = client.post("/api/v1/projects/save", json={"program": program, "courseRef": COURSE_REF})
    assert saved.status_code == 200
    loaded = client.post(
        "/api/v1/projects/load", json={"fileText": saved.json()["data"]["fileText"]}
    ).json()["data"]
    assert loaded["runnable"] is False
    assert loaded["unknownBlocks"]
    assert loaded["unknownBlocks"][0]["blockId"] == "b-future"
    assert loaded["program"]["root"]["next"]["kind"] == "future.block"

    again = client.post(
        "/api/v1/projects/save", json={"program": loaded["program"], "courseRef": COURSE_REF}
    )
    assert again.status_code == 200
    assert "future.block" in again.json()["data"]["fileText"]


def test_forbidden_field_rejected_on_save(client) -> None:
    program = _program()
    program["sourceCode"] = "print('hello')"
    response = client.post("/api/v1/projects/save", json={"program": program, "courseRef": COURSE_REF})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "PROGRAM_SCHEMA_INVALID"


def test_forbidden_fixture_rejected_on_load(client) -> None:
    text = (FIXTURES / "program_forbidden_field.json").read_text(encoding="utf-8")
    response = client.post("/api/v1/projects/load", json={"fileText": text})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "PROGRAM_SCHEMA_INVALID"


def test_too_large_file_rejected(client) -> None:
    giant = json.dumps({"format": "codematekids.program", "padding": "x" * (2 * 1024 * 1024 + 8192)})
    response = client.post("/api/v1/projects/load", json={"fileText": giant})
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "PROGRAM_TOO_LARGE"


def test_too_deep_fixture_rejected(client) -> None:
    text = (FIXTURES / "program_too_deep.json").read_text(encoding="utf-8")
    response = client.post("/api/v1/projects/load", json={"fileText": text})
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "PROGRAM_TOO_LARGE"


def test_too_many_nodes_fixture_rejected(client) -> None:
    text = (FIXTURES / "program_too_many.json").read_text(encoding="utf-8")
    response = client.post("/api/v1/projects/load", json={"fileText": text})
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "PROGRAM_TOO_LARGE"


def test_future_version_rejected(client) -> None:
    program = _program()
    program["formatVersion"] = 2
    text = json.dumps(program)
    response = client.post("/api/v1/projects/load", json={"fileText": text})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "PROGRAM_MIGRATION_FAILED"


def test_broken_file_rejected(client) -> None:
    response = client.post("/api/v1/projects/load", json={"fileText": "not-json"})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "PROGRAM_SCHEMA_INVALID"
    empty = client.post("/api/v1/projects/load", json={"fileText": "  "})
    assert empty.status_code == 422


def test_unknown_course_ref_is_read_only(client) -> None:
    program = _program()
    program["courseRef"] = {"courseId": "other-course", "version": 1, "taskId": "main"}
    text = json.dumps(program)
    loaded = client.post("/api/v1/projects/load", json={"fileText": text})
    assert loaded.status_code == 200
    data = loaded.json()["data"]
    assert data["runnable"] is False
    assert data["readOnlyReason"]


def test_save_requires_valid_course_ref(client) -> None:
    program = _program()
    response = client.post(
        "/api/v1/projects/save",
        json={"program": program, "courseRef": {"courseId": "other", "version": 1, "taskId": "main"}},
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "COURSE_VERSION_UNSUPPORTED"