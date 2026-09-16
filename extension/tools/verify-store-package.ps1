<#
.SYNOPSIS
    Ddayup 商店包闭环校验：确认扩展包内容正确、无开发残留。
    用于每次打包/提交前自动回归，避免把调试代码、嵌套 zip、探针脚本打进商店包。
#>
param([string]$ZipPath)

$ErrorActionPreference = 'Stop'
$script:fail = 0

if (-not $ZipPath) {
    $manifestPath = Join-Path $PSScriptRoot '..\manifest.json'
    $manifestText = [System.IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8)
    $ver = ($manifestText | ConvertFrom-Json).version
    $ZipPath = Join-Path $PSScriptRoot "..\ddayup-edge-store-v$ver.zip"
}

function Check($cond, $msg) {
    if ($cond) { Write-Host "  PASS: $msg" -ForegroundColor Green }
    else { Write-Host "  FAIL: $msg" -ForegroundColor Red; $script:fail++ }
}

if (-not (Test-Path $ZipPath)) { Write-Host "FAIL: package not found: $ZipPath" -ForegroundColor Red; exit 1 }

Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
$entries = @($z.Entries | ForEach-Object { $_.FullName })
$z.Dispose()

$sizeMB = [math]::Round((Get-Item $ZipPath).Length / 1MB, 2)
Write-Host "Package : $ZipPath"
Write-Host "Entries : $($entries.Count)"
Write-Host "Size    : $sizeMB MB"
Write-Host ""

Check ($entries -contains 'manifest.json') 'contains manifest.json'
Check ($entries -contains 'background.js') 'contains background.js'
Check ($entries -contains 'sidepanel.html') 'contains sidepanel.html'
Check ($entries -contains 'sidepanel.js') 'contains sidepanel.js'
Check ($entries -contains 'privacy-policy.html') 'contains privacy-policy.html'
Check ($entries -contains 'icons/feedback-qr.png') 'contains icons/feedback-qr.png (bug feedback QR)'
# 隐私政策联系方式必须是真实渠道：防止占位文案（示例地址）再次进入商店包
if ($entries -contains 'privacy-policy.html') {
    $ppPath = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')).Path 'privacy-policy.html'
    $ppText = [System.IO.File]::ReadAllText($ppPath, [System.Text.Encoding]::UTF8)
    Check ($ppText -notmatch 'ddayup\.example') 'privacy-policy.html 无占位邮箱（示例地址）'
    Check ($ppText -match '523649015@qq\.com') 'privacy-policy.html 含真实 QQ 联系方式'
}
Check ((($entries | Where-Object { $_ -like '_locales/*' }).Count) -gt 0) 'contains _locales/'

Write-Host ""
Check ((($entries | Where-Object { $_ -like '*.zip' }).Count) -eq 0) 'no nested .zip (no old store package inside)'
Check ((($entries | Where-Object { $_ -like 'probe_jingxuan/*' }).Count) -eq 0) 'no probe_jingxuan/ (dev probes)'
Check ((($entries | Where-Object { $_ -like 'tests/*' }).Count) -eq 0) 'no tests/'
Check ((($entries | Where-Object { $_ -like 'vendor/*' }).Count) -eq 0) 'no vendor/'
Check ((($entries | Where-Object { $_ -like 'native-host/*' }).Count) -eq 0) 'no native-host/'
Check ((($entries | Where-Object { $_ -like 'store-assets/*' }).Count) -eq 0) 'no store-assets/'
Check ((($entries | Where-Object { $_ -like 'tools/*' }).Count) -eq 0) 'no tools/'
Check ((($entries | Where-Object { $_ -like '*.md' }).Count) -eq 0) 'no markdown dev docs'

$badUnder = @($entries | Where-Object { (($_ -split '/') | Where-Object { $_ -like '_*' -and $_ -ne '_locales' }).Count -gt 0 })
Check ($badUnder.Count -eq 0) 'no underscore-prefixed entries (except _locales)'

$badHidden = @($entries | Where-Object { (($_ -split '/') | Where-Object { $_ -like '.*' }).Count -gt 0 })
Check ($badHidden.Count -eq 0) 'no dot-prefixed entries'

Write-Host ""
if ($script:fail -eq 0) { Write-Host "RESULT: ALL PASS ($($entries.Count) entries, $sizeMB MB)" -ForegroundColor Green; exit 0 }
Write-Host "RESULT: $script:fail CHECK(S) FAILED" -ForegroundColor Red
exit 1
