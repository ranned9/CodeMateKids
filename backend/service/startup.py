"""启动环境门禁：OS、解释器实测版本、worker、schema、课程与运行能力投影。"""

from __future__ import annotations

import json
import os
import platform
import subprocess
import sys
import time
from typing import Any

from backend.domain.blocks import BlockSchemaError, load_blocks
from backend.infra.config import BASE_DIR, Settings
from backend.infra.errors import ApiError
from backend.infra.logging import write_log
from backend.service import course as course_service
from backend.service.gate import build_run_capability

WORKER_PATH = BASE_DIR / "backend" / "runner" / "worker.py"
PROBE_TIMEOUT_S = 2.0

_CACHE: dict[str, dict[str, Any]] = {}


def _minimal_env() -> dict[str, str]:
    keep = ("PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "COMSPEC", "PATHEXT")
    env: dict[str, str] = {}
    for key in keep:
        value = os.environ.get(key)
        if value:
            env[key] = value
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return env


def probe_worker_python() -> dict[str, Any]:
    """启动 worker 并读取首帧 ready，取得实际工作进程解释器版本。"""
    if not WORKER_PATH.exists():
        return {"major": 0, "minor": 0, "patch": 0, "source": "unavailable"}
    try:
        completed = subprocess.run(
            [sys.executable, str(WORKER_PATH)],
            input='{"type":"probe"}\n',
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=PROBE_TIMEOUT_S,
            cwd=str(BASE_DIR),
            env=_minimal_env(),
        )
    except (OSError, subprocess.SubprocessError):
        return {"major": 0, "minor": 0, "patch": 0, "source": "unavailable"}

    first_line = ""
    for line in (completed.stdout or "").splitlines():
        if line.strip():
            first_line = line.strip()
            break
    if not first_line:
        return {"major": 0, "minor": 0, "patch": 0, "source": "unavailable"}
    try:
        frame = json.loads(first_line)
    except json.JSONDecodeError:
        return {"major": 0, "minor": 0, "patch": 0, "source": "unavailable"}
    if frame.get("type") != "ready":
        return {"major": 0, "minor": 0, "patch": 0, "source": "unavailable"}
    python_info = frame.get("python") or {}
    try:
        return {
            "major": int(python_info["major"]),
            "minor": int(python_info["minor"]),
            "patch": int(python_info["patch"]),
            "source": "worker_probe",
        }
    except (KeyError, TypeError, ValueError):
        return {"major": 0, "minor": 0, "patch": 0, "source": "unavailable"}


def _os_check() -> dict[str, Any]:
    if sys.platform != "win32":
        return {
            "name": "os",
            "status": "failed",
            "detailForChild": "这台电脑的系统暂时不支持演示。",
            "detailForDeveloperLogOnly": f"platform={sys.platform}",
        }
    machine = platform.machine().lower()
    is_64 = sys.maxsize > 2**32 or "64" in machine
    if not is_64:
        return {
            "name": "os",
            "status": "failed",
            "detailForChild": "需要 64 位 Windows 10 或 11。",
            "detailForDeveloperLogOnly": f"machine={machine}",
        }
    release = platform.release()
    return {
        "name": "os",
        "status": "passed",
        "detailForChild": "系统检查通过。",
        "detailForDeveloperLogOnly": f"Windows {release} {machine}",
    }


def _python_check(python_info: dict[str, Any]) -> dict[str, Any]:
    if python_info.get("source") != "worker_probe":
        return {
            "name": "python",
            "status": "warn",
            "detailForChild": "还没读到运行环境的版本，可以重试。",
            "detailForDeveloperLogOnly": "worker probe unavailable",
        }
    if (python_info["major"], python_info["minor"]) == (3, 12):
        return {
            "name": "python",
            "status": "passed",
            "detailForChild": "运行环境是 Python 3.12。",
            "detailForDeveloperLogOnly": f"python={python_info}",
        }
    return {
        "name": "python",
        "status": "failed",
        "detailForChild": "运行环境版本不对，需要 Python 3.12。",
        "detailForDeveloperLogOnly": f"python={python_info}",
    }


def _schema_check() -> tuple[dict[str, Any], str]:
    try:
        registry = load_blocks()
        from backend.service.matrix import load_matrix

        load_matrix()
    except BlockSchemaError as exc:
        return (
            {
                "name": "schema",
                "status": "failed",
                "detailForChild": "积木清单暂时读不到。",
                "detailForDeveloperLogOnly": str(exc),
            },
            "",
        )
    except Exception as exc:
        return (
            {
                "name": "schema",
                "status": "failed",
                "detailForChild": "积木清单暂时读不到。",
                "detailForDeveloperLogOnly": f"matrix_invalid={type(exc).__name__}",
            },
            "",
        )
    return (
        {
            "name": "schema",
            "status": "passed",
            "detailForChild": "积木清单检查通过。",
            "detailForDeveloperLogOnly": f"schemaVersion={registry.schema_version}",
        },
        registry.schema_version,
    )


def _course_check(settings: Settings) -> dict[str, Any]:
    try:
        bundle = course_service.load_course(settings)
    except (ApiError, OSError) as exc:
        detail = getattr(exc, "detail", "") or "course load failed"
        return {
            "check": {
                "name": "course",
                "status": "failed",
                "detailForChild": "这节课的内容暂时打不开。",
                "detailForDeveloperLogOnly": str(detail),
            },
            "course_version": 0,
            "content_version": "",
            "blocked_task_ids": [],
        }

    blocked = sorted(bundle.blocked)
    diagnostics = bundle.reply_diagnostics
    if not bundle.replies and diagnostics:
        return {
            "check": {
                "name": "course",
                "status": "failed",
                "detailForChild": "这节课的回复内容暂时不完整。",
                "detailForDeveloperLogOnly": (
                    "全部回复条目无效: "
                    + _diagnostic_text(diagnostics)
                ),
            },
            "course_version": int(bundle.course["version"]),
            "content_version": bundle.content_version,
            "blocked_task_ids": blocked,
        }
    if blocked or diagnostics:
        parts = []
        if blocked:
            parts.append(f"blocked={blocked}")
        if diagnostics:
            parts.append(_diagnostic_text(diagnostics))
        return {
            "check": {
                "name": "course",
                "status": "warn",
                "detailForChild": "部分任务或回复内容暂时受限。",
                "detailForDeveloperLogOnly": "; ".join(parts),
            },
            "course_version": int(bundle.course["version"]),
            "content_version": bundle.content_version,
            "blocked_task_ids": blocked,
        }
    return {
        "check": {
            "name": "course",
            "status": "passed",
            "detailForChild": "课程内容检查通过。",
            "detailForDeveloperLogOnly": f"contentVersion={bundle.content_version}",
        },
        "course_version": int(bundle.course["version"]),
        "content_version": bundle.content_version,
        "blocked_task_ids": [],
    }


def _diagnostic_text(diagnostics: list[dict[str, Any]]) -> str:
    return ",".join(
        f"index={item.get('index')} field={item.get('field')} reason={item.get('reason')}"
        for item in diagnostics[:3]
    )


def check_startup(settings: Settings, refresh: bool = False) -> dict[str, Any]:
    cache_key = f"{settings.course_dir}|{settings.expected_python}|{settings.log_dir}"
    if not refresh and cache_key in _CACHE:
        return {**_CACHE[cache_key], "cached": True}

    started_at = time.perf_counter()
    os_result = _os_check()
    python_info = probe_worker_python()
    python_result = _python_check(python_info)
    worker_result = {
        "name": "worker",
        "status": "passed" if python_info.get("source") == "worker_probe" else "failed",
        "detailForChild": (
            "运行小助手准备好了。"
            if python_info.get("source") == "worker_probe"
            else "运行环境没有准备好，可以重试。"
        ),
        "detailForDeveloperLogOnly": f"probe={python_info.get('source')}",
    }
    schema_result, schema_version = _schema_check()
    course_info = _course_check(settings)
    course_result = course_info["check"]

    checks = [os_result, python_result, worker_result, schema_result, course_result]
    fatal = any(item["status"] == "failed" for item in (os_result, python_result, schema_result))
    degraded = (not fatal) and any(item["status"] in ("failed", "warn") for item in (worker_result, course_result))
    status = "fatal" if fatal else ("degraded" if degraded else "ready")

    report = {
        "status": status,
        "checks": checks,
        "python": python_info,
        "courseVersion": course_info["course_version"],
        "schemaVersion": schema_version,
    }
    capability = build_run_capability(
        report,
        course_info["blocked_task_ids"],
        course_info["content_version"],
    )

    elapsed_ms = int((time.perf_counter() - started_at) * 1000)
    result = {
        "status": status,
        "checks": checks,
        "python": python_info,
        "courseVersion": course_info["course_version"],
        "schemaVersion": schema_version,
        "tutorMode": settings.tutor_mode,
        "elapsedMs": elapsed_ms,
        "appVersion": settings.app_version,
        "cached": False,
        "contentVersion": course_info["content_version"],
        "runCapability": capability,
    }
    _CACHE[cache_key] = result
    write_log(
        settings,
        {
            "event": "startup_check",
            "category": status,
            "durationMs": elapsed_ms,
            "schemaVersion": schema_version,
            "contentVersion": course_info["content_version"],
            "appVersion": settings.app_version,
            "pythonVersion": (
                f"{python_info['major']}.{python_info['minor']}.{python_info['patch']}"
                if python_info.get("source") == "worker_probe"
                else "unknown"
            ),
            "matrixCaseId": "TC-STARTUP-01",
        },
    )
    return result