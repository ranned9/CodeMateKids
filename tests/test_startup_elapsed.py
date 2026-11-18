"""RG-07：启动检查耗时语义、缓存标记与源码检索。"""

from __future__ import annotations

import time
from pathlib import Path

from backend.service import startup as startup_mod
from backend.service.startup import check_startup


def _clear() -> None:
    startup_mod._CACHE.clear()


def test_elapsed_does_not_grow_with_process_uptime(settings) -> None:
    _clear()
    time.sleep(0.3)
    data = check_startup(settings)
    assert data["cached"] is False
    assert data["elapsedMs"] < 2000


def test_cached_flag_and_same_elapsed(settings) -> None:
    _clear()
    first = check_startup(settings)
    second = check_startup(settings)
    assert first["cached"] is False
    assert second["cached"] is True
    assert second["elapsedMs"] == first["elapsedMs"]


def test_refresh_recomputes(settings) -> None:
    _clear()
    first = check_startup(settings)
    refreshed_one = check_startup(settings, refresh=True)
    refreshed_two = check_startup(settings, refresh=True)
    assert refreshed_one["cached"] is False
    assert refreshed_two["cached"] is False
    assert refreshed_one is not first
    assert refreshed_two is not refreshed_one
    assert refreshed_one["elapsedMs"] < 2000


def test_process_start_constant_removed() -> None:
    source = Path("backend/service/startup.py").read_text(encoding="utf-8")
    assert "PROCESS_START" not in source