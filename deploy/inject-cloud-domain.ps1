<#
.SYNOPSIS
  扩展打包时「一行注入」云端域名（Windows 版，对应 inject-cloud-domain.sh）。

.DESCRIPTION
  把扩展默认地址从 http://127.0.0.1:3000 改为云端地址：
    - extension/config-runtime.js 的 DEFAULT_API_BASE（唯一真源）
    - extension/config.js 的两处回退字符串
  注入后打包扩展分发即可，用户无需手填 options（手动填写仍优先）。

.PARAMETER Domain
  云端地址，如 https://ddayup.example.com 或 http://1.2.3.4:3000。
  传 'reset' 恢复默认本机地址。

.EXAMPLE
  .\inject-cloud-domain.ps1 https://ddayup.example.com
  .\inject-cloud-domain.ps1 reset
#>
param(
  [Parameter(Mandatory=$true)][string]$Domain
)

$ErrorActionPreference = 'Stop'
$SCRIPT_DIR = Split-Path -Parent $PSScriptRoot
$RT = Join-Path $SCRIPT_DIR 'extension\config-runtime.js'
$CFG = Join-Path $SCRIPT_DIR 'extension\config.js'
$DEFAULT = 'http://127.0.0.1:3000'

if ($Domain -eq 'reset') { $New = $DEFAULT }
else {
  $New = $Domain.TrimEnd('/')
  if ($New -notmatch '^https?://') { Write-Error "地址必须以 http:// 或 https:// 开头: $New"; exit 1 }
}

if (-not (Test-Path $RT)) { Write-Error "未找到 $RT"; exit 1 }

# config-runtime.js: 仅替换 DEFAULT_API_BASE 赋值行
$rtContent = Get-Content $RT -Raw -Encoding UTF8
$rtContent = $rtContent -replace "(const DEFAULT_API_BASE = )'[^']*';", "`$1'$New';"
Set-Content $RT $rtContent -Encoding UTF8 -NoNewline
Write-Host "已更新 $RT -> $New"

# config.js: 两处回退
if (Test-Path $CFG) {
  $cfgContent = Get-Content $CFG -Raw -Encoding UTF8
  $cfgContent = $cfgContent -replace "'http://127\.0\.0\.1:3000'", "'$New'"
  Set-Content $CFG $cfgContent -Encoding UTF8 -NoNewline
  Write-Host "已更新 $CFG -> $New"
}

Write-Host "`n注入完成。打包扩展前确认: grep DEFAULT_API_BASE $RT"
