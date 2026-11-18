"""环境预检：解释器版本与依赖可用性，退出码 0/1/2。"""

from __future__ import annotations

import importlib.metadata as metadata
import importlib.util
import sys

REQUIRED = (
    "fastapi",
    "uvicorn",
    "pydantic",
    "pytest",
    "httpx",
)


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    if sys.version_info[:2] != (3, 12):
        print(f"[CodeMateKids] 需要 Python 3.12，当前为 {sys.version.split()[0]}")
        return 1

    missing: list[str] = []
    versions: list[str] = []
    for name in REQUIRED:
        if importlib.util.find_spec(name) is None:
            missing.append(name)
            continue
        try:
            versions.append(f"{name}=={metadata.version(name)}")
        except metadata.PackageNotFoundError:
            versions.append(name)

    if missing:
        print("[CodeMateKids] 缺少依赖：" + ", ".join(missing))
        print("[CodeMateKids] 安装命令：python -m pip install -r requirements.lock.txt")
        print("[CodeMateKids] 或运行：scripts\\bootstrap_env.cmd")
        return 2

    print("[CodeMateKids] 依赖检查通过：" + ", ".join(versions))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())