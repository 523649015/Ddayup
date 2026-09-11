# 端到端实测：提交最小工作流并轮询进度，验证「提交 -> queued -> running -> done -> 成片 URL」全链路。
# 前置：网关已启动（见 ../run-gateway.ps1），且 COMFY_INSTANCES 指向一个可达的 ComfyUI。
#
# 用法:
#   .\e2e-check.ps1                          # 默认 http://127.0.0.1:8000
#   .\e2e-check.ps1 -Gateway http://host:8000 -GatewayKey xxx
param(
  [string]$Gateway = "http://127.0.0.1:8000",
  [string]$GatewayKey = $env:HMDAO_COMFYUI_GATEWAY_KEY,
  [string]$Workflow = "$PSScriptRoot\minimal_workflow.json",
  [string]$UserId = "e2e-test",
  [int]$MaxWaitSec = 1800
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path $Workflow)) { throw "找不到工作流样例: $Workflow" }

$headers = @{ 'Content-Type' = 'application/json' }
if ($GatewayKey) { $headers['x-hmdao-gateway-key'] = $GatewayKey }
$headers['x-hmdao-user-id'] = $UserId

$body = @{ prompt = (Get-Content $Workflow -Raw | ConvertFrom-Json) } | ConvertTo-Json -Depth 20 -Compress

Write-Host "提交工作流 -> $Gateway/prompt" -ForegroundColor Cyan
$submit = Invoke-RestMethod -Uri "$Gateway/prompt" -Method Post -Headers $headers -Body $body
if (-not $submit.success -or -not $submit.promptId) {
  Write-Host "提交失败: $($submit | ConvertTo-Json -Compress)" -ForegroundColor Red
  exit 1
}
$pid = $submit.promptId
Write-Host "已提交 prompt_id=$pid  injected=$($submit.hint)" -ForegroundColor Green

$deadline = (Get-Date).AddSeconds($MaxWaitSec)
$last = ''
while ((Get-Date) -lt $deadline) {
  $t = Invoke-RestMethod -Uri "$Gateway/tasks/$pid" -Headers $headers
  $p = $t.progress
  $line = "$(Get-Date -Format 'HH:mm:ss') status=$($t.status) node=$($t.current_node) progress=$($p.value)/$($p.max) ($($p.percent)%)"
  if ($line -ne $last) { Write-Host $line; $last = $line }
  if ($t.status -eq 'done' -or $t.status -eq 'error') { break }
  Start-Sleep -Seconds 2
}

if ($t.status -eq 'done') {
  Write-Host "完成 ✅ 成片:" -ForegroundColor Green
  foreach ($o in $t.outputs) { Write-Host "  [$($o.type)] $($o.url)" -ForegroundColor White }
  exit 0
} elseif ($t.status -eq 'error') {
  Write-Host "执行错误 ❌ $($t.error)" -ForegroundColor Red
  exit 2
} else {
  Write-Host "超时未结束（status=$($t.status)）" -ForegroundColor Yellow
  exit 3
}
