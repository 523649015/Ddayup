@echo off
setlocal EnableExtensions
set "REPO_ROOT=%~dp0..\.."
for %%I in ("%REPO_ROOT%") do set "REPO_ROOT=%%~fI"
cd /d "%REPO_ROOT%"
"C:\Program Files\nodejs\node.exe" scripts\dcc\hmdao-stack-daemon.mjs