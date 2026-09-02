# Build ddayup-host.exe via Node SEA (Single Executable Application) - no third-party pkg, official support.
$ErrorActionPreference = 'Stop'
$NH = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node).Source
$nodeDir = Split-Path -Parent $node

$config = @{ main = 'ddayup-host.js'; output = 'sea-prep.blob'; disableExperimentalSEAWarning = $true } | ConvertTo-Json
Set-Content -Path (Join-Path $NH 'sea-config.json') -Value $config -Encoding UTF8

Push-Location $NH
try {
  & node --experimental-sea-config sea-config.json
  if (-not (Test-Path 'sea-prep.blob')) { throw 'blob generate failed' }

  $exe = Join-Path $NH 'ddayup-host.exe'
  Copy-Item (Join-Path $nodeDir 'node.exe') $exe -Force

  # Windows 上 node.exe 带 Authenticode 签名。官方文档：签名移除为可选步骤，
  # 仅跳过时 postject 可能输出警告但不影响注入。我们尝试不 strip（保留签名）直接用 --sentinel-fuse 注入。
  # 若注入失败，取消下行注释启用 strip：
  # & python (Join-Path $NH 'strip-sig.py') $exe

  $postject = Get-Command postject -ErrorAction SilentlyContinue
  if (-not $postject) {
    Write-Host 'installing postject ...'
    & npm i -g postject --registry=https://registry.npmmirror.com 2>&1 | Out-Null
  }
  & npx --yes postject $exe NODE_SEA_BLOB sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --overwrite
  if (-not (Test-Path $exe)) { throw 'exe generate failed' }
  $size = (Get-Item $exe).Length / 1MB
  Write-Host ('[OK] generated ' + $exe + ' (' + [math]::Round($size, 1) + ' MB) with embedded Node runtime')
} finally {
  Pop-Location
}
