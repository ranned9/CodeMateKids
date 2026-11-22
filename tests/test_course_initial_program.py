"""RG-12：课程初始程序完整结构校验与任务级受限分流。"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from backend.infra.config import load_settings
from backend.infra.errors import ApiError
from backend.service.course import course_payload, load_course
from tests.helpers import ROOT, node, simple_program


def _settings_for(tmp_path: Path, name: str):
    target = tmp_path / name
    shutil.copytree(ROOT / "content" / "demo-loop", target)
    return load_settings(
        {
            "CMK_COURSE_DIR": str(target),
            "CMK_LOG_DIR": str(tmp_path / "logs"),
            "CMK_TUTOR_MODE": "mock",
        }
    ), target


def _mutate(root: Path, mutator) -> None:
    path = root / "course.json"
    course = json.loads(path.read_text(encoding="utf-8"))
    mutator(course["tasks"][0]["initialProgram"], course)
    path.write_text(json.dumps(course, ensure_ascii=False, indent=2), encoding="utf-8")


def test_missing_root_fails_course(tmp_path) -> None:
    settings, root = _settings_for(tmp_path, "missing-root")
    _mutate(root, lambda program, course: program.pop("root"))
    with pytest.raises(ApiError) as exc:
        load_course(settings, refresh=True)
    assert exc.value.code == "COURSE_VERSION_UNSUPPORTED"
    assert "task=main" in getattr(exc.value, "detail", "")


def test_bad_field_type_fails_course(tmp_path) -> None:
    settings, root = _settings_for(tmp_path, "bad-field")

    def mutate(program, course):
        program["root"] = simple_program()["root"]
        program["root"]["next"]["inputs"]["times"] = "两个"

    _mutate(root, mutate)
    with pytest.raises(ApiError) as exc:
        load_course(settings, refresh=True)
    assert "task=main" in getattr(exc.value, "detail", "")


def test_course_ref_task_mismatch_fails_course(tmp_path) -> None:
    settings, root = _settings_for(tmp_path, "wrong-task")
    _mutate(root, lambda program, course: program["courseRef"].update({"taskId": "variant"}))
    with pytest.raises(ApiError) as exc:
        load_course(settings, refresh=True)
    assert "task=main" in getattr(exc.value, "detail", "")


def test_too_deep_initial_program_fails_course(tmp_path) -> None:
    settings, root = _settings_for(tmp_path, "too-deep")

    def mutate(program, course):
        current = node("b-deep-move", "motion.move", {"steps": 1})
        for depth in range(21):
            current = node(f"b-deep-{depth}", "control.repeat", {"times": 2}, body=[current])
        program["root"] = current

    _mutate(root, mutate)
    with pytest.raises(ApiError) as exc:
        load_course(settings, refresh=True)
    assert "task=main" in getattr(exc.value, "detail", "")


def test_too_many_nodes_initial_program_fails_course(tmp_path) -> None:
    settings, root = _settings_for(tmp_path, "too-many")

    def mutate(program, course):
        chain = node("b-many-500", "motion.move", {"steps": 1})
        for index in range(499, -1, -1):
            chain = node(f"b-many-{index}", "motion.move", {"steps": 1}, nxt=chain)
        program["root"] = chain

    _mutate(root, mutate)
    with pytest.raises(ApiError) as exc:
        load_course(settings, refresh=True)
    assert "task=main" in getattr(exc.value, "detail", "")


def test_unrunnable_block_blocks_only_that_task(tmp_path) -> None:
    settings, root = _settings_for(tmp_path, "blocked-task")

    def mutate(program, course):
        program["root"] = simple_program()["root"]
        program["root"]["next"]["kind"] = "python.class"
        program["root"]["next"]["unknown"] = True

    _mutate(root, mutate)
    bundle = load_course(settings, refresh=True)
    assert "main" in bundle.blocked
    assert "variant" not in bundle.blocked
    payload = course_payload(settings, "demo-loop", bundle)
    main_task = next(task for task in payload["tasks"] if task["taskId"] == "main")
    variant_task = next(task for task in payload["tasks"] if task["taskId"] == "variant")
    assert main_task["enterable"] is False
    assert main_task["blockedReason"]
    assert variant_task["enterable"] is True
    assert payload["status"] == "blocked"
