@echo off
setlocal
pushd "%~dp0.."
set "SIS_ENV=%CD%\logs\sis.env.local"

if not exist "%SIS_ENV%" (
  echo [CodeMateKids] Missing %SIS_ENV%
  echo [CodeMateKids] Copy scripts\sis.env.example to logs\sis.env.local and fill in
  echo [CodeMateKids] CMK_SIS_PROJECT_ID, CMK_SIS_AK, CMK_SIS_SK.
  popd
  exit /b 1
)

for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%SIS_ENV%") do (
  if not "%%A"=="" set "%%A=%%B"
)

if not defined CMK_SIS_PROJECT_ID goto missing
if not defined CMK_SIS_AK goto missing
if not defined CMK_SIS_SK goto missing

echo [CodeMateKids] Loaded SIS settings from logs\sis.env.local (region: %CMK_SIS_REGION%).
call run_demo.cmd
set "CODE=%errorlevel%"
popd
exit /b %CODE%

:missing
echo [CodeMateKids] logs\sis.env.local is missing CMK_SIS_PROJECT_ID / CMK_SIS_AK / CMK_SIS_SK.
popd
exit /b 1
