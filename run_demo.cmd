@echo off
setlocal
cd /d "%~dp0"

python -c "import sys; sys.exit(0 if sys.version_info[:2]==(3, 12) else 1)" 2>nul
if errorlevel 1 (
  echo [CodeMateKids] 需要 Python 3.12，请安装 Python 3.12 后重试。
  echo 当前解释器版本：
  python --version
  exit /b 1
)

python scripts\check_env.py 2>nul
if errorlevel 2 (
  echo [CodeMateKids] 依赖不完整，已停止启动。
  echo 请先运行：scripts\bootstrap_env.cmd
  exit /b 2
)
if errorlevel 1 (
  echo [CodeMateKids] 环境检查未通过，请检查 Python 3.12 与依赖。
  exit /b 1
)

echo [CodeMateKids] Python 3.12 与依赖校验通过，正在启动 Demo...
echo 打开 http://127.0.0.1:8000 开始学习。
python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
endlocal