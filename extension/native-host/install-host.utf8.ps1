# Ddayup 原生主机安装器（Windows）
# 作用：将 com.ddayup.host 注册到 Chrome/Edge 的 NativeMessagingHosts，使扩展可 connectNative。
# 边界：仅写注册表 + 本地 manifest JSON，不联网、不修改浏览器、不拦截任何页面。
#
# 用法（PowerShell）：
#   .\install-host.ps1 -ExtensionId "abcdefghijklmnopqrstuvwxyzabcdef" [-Browser all|chrome|edge]
#
# 说明：
#   - ExtensionId 在 chrome://extensions 开启「开发者模式」后可见（每个扩展独立 ID）。
#     上架 Edge 商店后，用商店分配的固定 ID 重跑本脚本即可。
#   - 优先使用 pkg 打包的 ddayup-host.exe（自带 Node 18 运行时，用户免装 Node）；
#     若 exe 缺失则回退到 ddayup-host.js（此时本机需已安装 Node.js）。

param(
  [Parameter(Mandatory = $true)][string]$ExtensionId,
  [ValidateSet('all', 'chrome', 'edge')][string]$Browser = 'all'
)

$ErrorActionPreference = 'Stop'

# 1) 校验扩展 ID 格式（32 位小写字母 a-p，Chrome/Edge 扩展 ID 规范）
if ($ExtensionId -notmatch '^[a-p]{32}$') {
  Write-Error "扩展 ID 格式错误：必须是 32 位小写字母（a-p）。从 chrome://extensions 或 Edge 加载项页面获取。"
  exit 1
}

# 2) 定位脚本目录（安装器与 ddayup-host.* / com.ddayup.host.json 同目录）
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$manifestSrc = Join-Path $scriptDir 'com.ddayup.host.json'
if (-not (Test-Path $manifestSrc)) { Write-Error "缺失 com.ddayup.host.json：$manifestSrc"; exit 1 }

# 3) 选择主机程序：优先 exe（免 Node），回退 js（需 Node）
$exePath = Join-Path $scriptDir 'ddayup-host.exe'
$jsPath = Join-Path $scriptDir 'ddayup-host.js'
$hostPath = $null
if (Test-Path $exePath) {
  $hostPath = $exePath
  Write-Host "[OK] 使用 ddayup-host.exe（自带 Node 运行时，用户免装 Node）"
} elseif (Test-Path $jsPath) {
  $nodePath = (Get-Command node -ErrorActionSilentlyContinue).Source
  if (-not $nodePath) {
    Write-Error "未检测到 Node.js，且 ddayup-host.exe 不存在。请安装 Node.js（https://nodejs.org）或重新打包 ddayup-host.exe。"
    exit 1
  }
  $hostPath = $jsPath
  Write-Host "[OK] 使用 ddayup-host.js（依赖本机 Node.js: $nodePath）".Replace('$nodePath', $nodePath)
} else {
  Write-Error "缺失 ddayup-host.exe 与 ddayup-host.js，无法安装原生主机。"
  exit 1
}

# 4) 生成本机 manifest（替换占位 ID 与绝对路径）
$manifestObj = Get-Content $manifestSrc -Raw -Encoding UTF8 | ConvertFrom-Json
$manifestObj.allowed_origins = @("chrome-extension://$ExtensionId/")
$manifestObj.path = $hostPath
$manifestOut = Join-Path $scriptDir 'com.ddayup.host.installed.json'
$manifestObj | ConvertTo-Json -Compress | Set-Content -Path $manifestOut -Encoding UTF8
Write-Host "[OK] 已生成主机 manifest: $manifestOut"

# 5) 写注册表
function Set-HostRegistry($rootKey, $subKey) {
  $full = "$rootKey\$subKey"
  New-Item -Path $full -Force | Out-Null
  New-ItemProperty -Path $full -Name '(Default)' -Value $manifestOut -PropertyType String -Force | Out-Null
  Write-Host "[OK] 注册表: $full -> $manifestOut"
}

if ($Browser -eq 'all' -or $Browser -eq 'chrome') {
  Set-HostRegistry 'HKCU:\Software\Google\Chrome\NativeMessagingHosts' 'com.ddayup.host'
}
if ($Browser -eq 'all' -or $Browser -eq 'edge') {
  Set-HostRegistry 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts' 'com.ddayup.host'
}

Write-Host ""
Write-Host "安装完成。请在浏览器中重新加载 Ddayup 扩展，侧栏即可通过原生主机使用本机 yt-dlp。"
Write-Host "卸载：删除上述注册表项，或运行 uninstall-host.ps1。"

