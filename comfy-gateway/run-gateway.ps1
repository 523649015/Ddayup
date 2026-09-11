# 启动 daydayupAPI 网关（HMDao ComfyUI 中转网关）
# 用法:
#   .\run-gateway.ps1                 # 默认 8000 端口
#   .\run-gateway.ps1 -Port 8000 -Reload
param(
  [int]$Port = 8000,
  [switch]$Reload
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# 创建并使用虚拟环境（首次）。
# 解析稳定版 Python（默认 python 可能是 3.15 alpha，缺少预编译轮子）。
$PyVersion = ""
if (Get-Command "py.exe" -ErrorAction SilentlyContinue) {
  foreach ($v in @("3.13", "3.12", "3.11", "3.14", "3.10")) {
    & py "-$v" --version 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $PyVersion = $v; break }
  }
}
if (-not (Test-Path .venv)) {
  Write-Host "创建虚拟环境 .venv ..." -ForegroundColor Yellow
  if ($PyVersion) { py -$PyVersion -m venv .venv } else { python -m venv .venv }
}
& .\.venv\Scripts\Activate.ps1

Write-Host "安装依赖 (requirements.txt) ..." -ForegroundColor Yellow
pip install -q -r requirements.txt

# 若未配置 .env，从示例复制。
if (-not (Test-Path .env)) {
  if (Test-Path .env.example) {
    Copy-Item .env.example .env
    Write-Host "已从 .env.example 生成 .env，请按需修改密钥与 COMFY_INSTANCES。" -ForegroundColor Green
  }
}

$uvicornArgs = @("main:app", "--host", "0.0.0.0", "--port", "$Port")
if ($Reload) { $uvicornArgs += "--reload" }

Write-Host "启动网关: http://127.0.0.1:$Port  (Ctrl+C 停止)" -ForegroundColor Green
Write-Host "健康检查: GET  $Gateway/health" -ForegroundColor DarkGray
Write-Host "提交工作流: POST $Gateway/prompt" -ForegroundColor DarkGray
Write-Host "轮询进度: GET  $Gateway/tasks/{prompt_id}" -ForegroundColor DarkGray
uvicorn @uvicornArgs
