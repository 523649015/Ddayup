@echo off
setlocal EnableExtensions

set "REPO_ROOT=%~dp0..\.."
for %%I in ("%REPO_ROOT%") do set "REPO_ROOT=%%~fI"
set "INFRA_DIR=%REPO_ROOT%\tools\PixelStreamingInfrastructure-UE5.7\SignallingWebServer"
set "NODE_EXE=C:\Program Files\nodejs\node.exe"

if not exist "%NODE_EXE%" (
  echo [HMDao] Node.js not found: %NODE_EXE%
  exit /b 1
)
if not exist "%INFRA_DIR%\dist\index.js" (
  echo [HMDao] SignallingWebServer is not built: %INFRA_DIR%\dist\index.js
  exit /b 1
)

set "CLEAN_PATH=C:\WINDOWS\system32;C:\WINDOWS;C:\WINDOWS\System32\Wbem;C:\WINDOWS\System32\WindowsPowerShell\v1.0\;C:\WINDOWS\System32\OpenSSH\;C:\Program Files\Git\cmd;C:\Program Files\dotnet\;C:\ProgramData\chocolatey\bin;C:\Program Files\Docker\Docker\resources\bin;C:\Program Files\nodejs\;C:\FFMPEG\bin;C:\Users\123\AppData\Local\Microsoft\WindowsApps"
set "Path=%CLEAN_PATH%"
set "PATH=%CLEAN_PATH%"
set "PLAYER_PORT=1025"
set "STREAMER_PORT=8888"
set "SFU_PORT=8889"
set "LOG_DIR=%TEMP%\hmdao-pixelstreaming-logs"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

echo [HMDao] Starting Pixel Streaming SignallingWebServer...
echo [HMDao] Player   : http://127.0.0.1:%PLAYER_PORT%/player.html
echo [HMDao] Streamer : ws://127.0.0.1:%STREAMER_PORT%
echo [HMDao] REST API : http://127.0.0.1:%PLAYER_PORT%/api/status
echo [HMDao] Log dir  : %LOG_DIR%

title HMDao Pixel Streaming Infrastructure
cd /d "%INFRA_DIR%"
"%NODE_EXE%" dist\index.js --serve --player_port %PLAYER_PORT% --streamer_port %STREAMER_PORT% --sfu_port %SFU_PORT% --http_root www --homepage player.html --rest_api --log_folder "%LOG_DIR%" --log_config --console_messages basic