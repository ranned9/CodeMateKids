"""SIS 配置自检：读环境变量与本机配置文件，可选一次真实合成探针。

值来源优先级：进程环境变量 > ``logs/sis.env.local``。凭证只用于构造客户端，
不打印、不写入任何文件；``--probe`` 仅把合成音频写到 ``logs/sis-probe.mp3``。
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

ENV_FILE = ROOT / "logs" / "sis.env.local"
PROBE_FILE = ROOT / "logs" / "sis-probe.mp3"
REQUIRED = ("CMK_SIS_PROJECT_ID", "CMK_SIS_AK", "CMK_SIS_SK")
OPTIONAL = ("CMK_SIS_REGION",)
DEFAULT_PROBE_TEXT = "先点运行，看看小海龟走到哪里。"


def load_env_file(path: Path) -> dict[str, str]:
    """解析 KEY=VALUE 行，忽略空行与 # 注释；值不做引号处理。"""
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    try:
        text = path.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError:
        text = path.read_text(encoding="gbk", errors="replace")
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip()
    return values


def merged_config() -> dict[str, str]:
    merged = load_env_file(ENV_FILE)
    for key in REQUIRED + OPTIONAL:
        if os.environ.get(key):
            merged[key] = os.environ[key]
    return merged


def main(argv: list[str]) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    config = merged_config()
    missing = [key for key in REQUIRED if not config.get(key)]
    if missing:
        print("[CodeMateKids] SIS 配置不完整，缺少：" + "、".join(missing))
        print("[CodeMateKids] 来源：环境变量，或 " + str(ENV_FILE))
        print("[CodeMateKids] 模板：" + str(ROOT / "scripts" / "sis.env.example"))
        return 1

    from backend.infra.config import SIS_REGION_ENDPOINTS, load_settings
    from backend.service.speech import SpeechService, SpeechServiceError

    settings = load_settings(config)
    service = SpeechService(settings)
    if not service.available:
        print("[CodeMateKids] 语音未启用，原因：" + (service.disabled_reason or "unknown"))
        if service.disabled_reason == "region_unsupported":
            print("[CodeMateKids] 仅支持 region：" + "、".join(SIS_REGION_ENDPOINTS))
        return 2

    endpoint = SIS_REGION_ENDPOINTS.get(settings.sis_region, "?")
    print(f"[CodeMateKids] 客户端就绪：region={settings.sis_region} endpoint={endpoint}")

    if "--probe" not in argv:
        print("[CodeMateKids] 未发起云端调用。加 --probe 会真实合成一次并保存到 logs\\sis-probe.mp3（会计费）。")
        return 0

    try:
        audio = service.synthesize(DEFAULT_PROBE_TEXT)
    except SpeechServiceError as exc:
        print("[CodeMateKids] 合成失败，category=" + exc.category)
        print("[CodeMateKids] 401/403 多为 AK/SK 与项目不匹配、子用户未授权或服务未开通；404 多为项目 ID 与区域不一致。")
        return 3

    target = PROBE_FILE
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(audio)
    except OSError:
        target = Path(tempfile.gettempdir()) / "sis-probe.mp3"
        try:
            target.write_bytes(audio)
        except OSError as exc:
            print("[CodeMateKids] 合成成功但音频写盘失败：" + str(exc))
            return 4
    print(f"[CodeMateKids] 合成成功：{len(audio)} 字节 → {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
