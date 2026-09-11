@echo off
REM 运行 extension/ 的 ESLint 扁平配置（复用 app/ 已安装的 eslint 二进制，无需新增依赖）
REM 用法：scripts\lint-extension.bat
REM 注意：必须在 extension/ 目录运行（config 的 ignores 才能正确排除 vendor/scripts）
cd /d f:\Work\HMDAODAO\extension
if not exist eslint.config.js (
  echo [ERR] extension/eslint.config.js 不存在
  exit /b 1
)
f:\Work\HMDAODAO\app\node_modules\.bin\eslint .
exit /b %errorlevel%
