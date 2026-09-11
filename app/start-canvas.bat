@echo off
setlocal EnableDelayedExpansion
title Ddayup 画布启动器
cd /d "%~dp0"

echo.
echo ============================================================
echo   Ddayup 画布 - 一键启动器
echo ============================================================
echo.

REM ============================================================
REM  1. 检测 Node.js（唯一必需依赖）
REM ============================================================
where node >nul 2>&1
if errorlevel 1 goto :NO_NODE

for /f "tokens=1 delims=v." %%a in ('node -v 2^>nul') do set "NODE_MAJOR=%%a"
if not defined NODE_MAJOR set "NODE_MAJOR=0"
if !NODE_MAJOR! LSS 20 goto :NODE_LOW
echo [OK] Node.js 已就绪（v!NODE_MAJOR!）

REM ============================================================
REM  2. 检测前端依赖是否安装
REM ============================================================
if not exist "node_modules\vite\bin\vite.js" goto :NO_MODULES
echo [OK] 前端依赖已就绪

REM ============================================================
REM  3. 可选增强依赖检测（缺失不阻断，自动降级）
REM ============================================================
echo.
echo -------------------- 可选增强依赖 --------------------
call :CHECK_OPT python Python   "本地 AI 分析 / 视频超分（缺失会自动改用云端，不影响使用）"
call :CHECK_OPT ffmpeg FFmpeg   "视频合并转码，同时是 yt-dlp 下载合并的必需组件" ffmpeg ffmpeg.exe
call :CHECK_OPT yt-dlp "yt-dlp" "Ddayup 扩展视频下载功能" ytdlp yt-dlp.exe
echo.
echo 以上缺失项可在画布左侧「环境」面板一键安装，
echo 安装时支持自定义路径，建议选择空间充足的盘符。
echo.

REM ============================================================
REM  4. 磁盘空间检查
REM ============================================================
powershell -NoProfile -Command "$f=[math]::Round((Get-PSDrive (Get-Location).Drive.Name).Free/1GB,1); if($f -lt 5){Write-Host ('[警告] 当前磁盘仅剩 ' + $f + ' GB，安装运行时可能失败') -ForegroundColor Yellow; Write-Host '        请在安装依赖时选择其他盘符的自定义路径' -ForegroundColor Yellow}else{Write-Host ('[OK] 可用磁盘空间 ' + $f + ' GB')}"

REM ============================================================
REM  5. 启动服务
REM ============================================================
echo.
echo ============================================================
echo 正在启动画布服务，首次启动约需 10-30 秒，浏览器会自动打开。
echo 停止画布 - 直接关闭本窗口即可停止服务。
echo ============================================================
echo.

REM 后台轮询，服务就绪后自动打开浏览器（避免过早打开出现无法访问）
start "" /MIN powershell -NoProfile -WindowStyle Hidden -Command "$i=0; while($i -lt 120){ try{ Invoke-WebRequest 'http://127.0.0.1:3000' -UseBasicParsing -TimeoutSec 2 | Out-Null; Start-Process 'http://127.0.0.1:3000'; exit }catch{ Start-Sleep -Seconds 1; $i++ } }"

node server\dev-full.mjs

echo.
echo 画布服务已停止。
pause
exit /b 0

REM ============================================================
REM  子过程：检测单个可选依赖
REM ============================================================
:CHECK_OPT
REM 参数: %1=命令名 %2=显示名 %3=缺失说明 %4=运行时key(可选) %5=托管目录内的exe名(可选)
REM 先查系统 PATH，再查画布托管运行时目录（.hmdao-data），两者都没有才算未安装。
where %1 >nul 2>&1
if not errorlevel 1 (
    echo [OK] %~2 已安装（系统 PATH）
    exit /b 0
)
if not "%~4" == "" (
    if exist ".hmdao-data\local-post-runtimes\%~4\current\%~5" (
        echo [OK] %~2 已安装（画布托管）
        exit /b 0
    )
)
echo [--] %~2 未安装   ^|  %~3
exit /b 0

REM ============================================================
REM  错误处理
REM ============================================================
:NO_NODE
echo [缺少必要依赖] 未检测到 Node.js
echo.
echo 画布必须依赖 Node.js 20 或更高版本才能运行，这是唯一的硬性要求。
echo 请下载 LTS 版本安装后，重新运行本启动器。
echo.
echo 下载地址 - https://nodejs.org/zh-cn/download
echo.
choice /c YN /n /m "是否现在打开下载页面？Y=打开  N=退出 : "
if errorlevel 2 exit /b 1
start https://nodejs.org/zh-cn/download
echo.
pause
exit /b 1

:NODE_LOW
echo [版本过低] 检测到 Node.js v!NODE_MAJOR!，画布需要 20 或更高版本。
echo 请到 https://nodejs.org/zh-cn/download 更新后重试。
echo.
pause
exit /b 1

:NO_MODULES
echo [缺少依赖] 未找到前端依赖（node_modules）
echo.
echo 请在当前目录执行以下命令安装依赖，完成后重新运行本启动器
echo.
echo     npm install
echo.
pause
exit /b 1
