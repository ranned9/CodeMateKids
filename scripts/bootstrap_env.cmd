@echo off
setlocal
cd /d "%~dp0.."

where py >nul 2>nul
if errorlevel 1 (
  echo [CodeMateKids] 找不到 py 启动器，请先安装 Python 3.12。
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo [CodeMateKids] 正在创建虚拟环境 .venv ...
  py -3.12 -m venv .venv
  if errorlevel 1 (
    echo [CodeMateKids] 虚拟环境创建失败，请检查 Python 3.12 安装。
    exit /b 1
  )
)

echo [CodeMateKids] 正在安装锁定依赖 ...
call ".venv\Scripts\activate.bat"
python -m pip install --upgrade pip
python -m pip install -r requirements.lock.txt
if errorlevel 1 (
  echo [CodeMateKids] 依赖安装失败，请检查网络或 pip 源。
  exit /b 1
)

echo.
echo [CodeMateKids] 环境准备完成。
echo 激活命令：.venv\Scripts\activate.bat
echo 启动 Demo：run_demo.cmd
endlocal