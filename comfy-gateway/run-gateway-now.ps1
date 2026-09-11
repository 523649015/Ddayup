# 临时启动脚本：本机会话验证用。
# 创建 venv（稳定版 Python）、安装依赖、以显式环境变量启动网关。
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# 解析稳定版 Python（默认 python 可能是 3.15 alpha，缺少预编译轮子）。
$PyVersion = ""
if (Get-Command "py.exe" -ErrorAction SilentlyContinue) {
  foreach ($v in @("3.13", "3.12", "3.11", "3.14", "3.10")) {
    & py "-$v" --version 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $PyVersion = $v; break }
  }
}
if (-not (Test-Path .venv)) {
  Write-Host "创建网关虚拟环境 .venv ..." -ForegroundColor Yellow
  if ($PyVersion) { py -$PyVersion -m venv .venv } else { python -m venv .venv }
}
& .\.venv\Scripts\Activate.ps1
Write-Host "安装网关依赖 ..." -ForegroundColor Cyan
pip install -q -r requirements.txt

# 本机验证用的网关密钥（与 hmdao-api.mjs 的 HMDAO_COMFYUI_GATEWAY_KEY 保持一致）。
$env:GATEWAY_KEY = 'dev-gateway-key-2026'
# ComfyUI 实例（install-comfyui.ps1 -Start 默认监听 8188）。
$env:COMFY_INSTANCES = 'http://127.0.0.1:8188'
# 成片 URL 基址：指向 hmdao-api.mjs 代理基址（默认监听 8792），浏览器 <img> 才能经 /api/comfyui/view 取到图。
$env:GATEWAY_PUBLIC_URL = 'http://127.0.0.1:8792/api/comfyui'
$env:GATEWAY_PORT = '8000'
$env:GATEWAY_ALLOW_CLIENT_KEYS = 'true'

# 必须用 `python main.py` 启动（而非 `python -m uvicorn main:app`），
# 否则 main.py 内 `if __name__ == "__main__"` 中的 SSL/GATEWAY_PORT 解析不会执行。
Write-Host "启动网关: http://127.0.0.1:8000  (Ctrl+C 停止)" -ForegroundColor Green
python main.py
