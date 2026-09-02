# Ddayup 原生主机卸载器（Windows）
# 删除 Chrome/Edge 的 NativeMessagingHosts 注册表项。不删除 ddayup-host.exe / ddayup-host.js 本身（可保留复用）。
param(
  [ValidateSet('all', 'chrome', 'edge')][string]$Browser = 'all'
)
$ErrorActionPreference = 'Stop'
if ($Browser -eq 'all' -or $Browser -eq 'chrome') {
  Remove-Item -Path 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.ddayup.host' -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "[OK] 已移除 Chrome 注册"
}
if ($Browser -eq 'all' -or $Browser -eq 'edge') {
  Remove-Item -Path 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.ddayup.host' -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "[OK] 已移除 Edge 注册"
}
Write-Host "卸载完成。"
