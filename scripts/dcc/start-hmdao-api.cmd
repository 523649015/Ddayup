@echo off
setlocal EnableExtensions

set "REPO_ROOT=%~dp0..\.."
for %%I in ("%REPO_ROOT%") do set "REPO_ROOT=%%~fI"
set "APP_DIR=%REPO_ROOT%\app"
set "NODE_EXE=C:\Program Files\nodejs\node.exe"

if not exist "%NODE_EXE%" (
  echo [HMDao] Node.js not found: %NODE_EXE%
  exit /b 1
)
if not exist "%APP_DIR%\server\hmdao-api.mjs" (
  echo [HMDao] Backend entry not found: %APP_DIR%\server\hmdao-api.mjs
  exit /b 1
)

set "CLEAN_PATH=C:\WINDOWS\system32;C:\WINDOWS;C:\WINDOWS\System32\Wbem;C:\WINDOWS\System32\WindowsPowerShell\v1.0\;C:\WINDOWS\System32\OpenSSH\;C:\Program Files\Git\cmd;C:\Program Files\dotnet\;C:\ProgramData\chocolatey\bin;C:\Program Files\Docker\Docker\resources\bin;C:\Program Files\nodejs\;C:\FFMPEG\bin;C:\Users\123\AppData\Local\Microsoft\WindowsApps"
set "Path=%CLEAN_PATH%"
set "PATH=%CLEAN_PATH%"

echo [HMDao] Starting backend API on http://127.0.0.1:8787

title HMDao API 8787
cd /d "%APP_DIR%"
"%NODE_EXE%" server\hmdao-api.mjs