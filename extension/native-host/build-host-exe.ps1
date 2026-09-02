# Build ddayup-host.exe (pkg) - embedded Node runtime, no Node install required for end users.
# Note: Node SEA was evaluated but rejected - on Windows SEA exe exits immediately on stdin
# redirection ("Input redirection is not supported"), which breaks Native Messaging (pipe-based).
# pkg exe only prints that warning but works correctly over stdin pipe.
$ErrorActionPreference = 'Stop'
$NH = Split-Path -Parent $MyInvocation.MyCommand.Path
# 仓库根 = extension/native-host 的祖父目录
$REPO = Split-Path -Parent (Split-Path -Parent $NH)

Push-Location $NH
try {
  # 在打包前把真实仓库根注入源码占位符（pkg 下 __dirname/process.execPath 均为虚拟路径，
  # 无法反推真实位置）。打包后还原占位符，避免污染源码。
  $src = 'ddayup-host.js'
  $bak = 'ddayup-host.js.bak'
  Copy-Item $src $bak -Force
  $content = (Get-Content $src -Raw -Encoding UTF8)
  # 仅替换第 38 行赋值语句的占位符（const BUILT_REPO_ROOT = '{{REPO_ROOT}}';），
  # 不碰第 39 行判断用的标记 {{REPO_ROOT_MARKER}}，否则判断会被破坏导致永远跳过。
  $content = $content -replace "const BUILT_REPO_ROOT = '[^']*';", "const BUILT_REPO_ROOT = '$($REPO.Replace('\', '\\'))';"
  Set-Content $src $content -Encoding UTF8 -NoNewline

  # pkg 5.8.1 ships node18 base which includes stable fetch (used by ddayup-host.js).
  & npx --yes pkg ddayup-host.js --targets node18-win-x64 --output ddayup-host.exe 2>&1
  if (-not (Test-Path 'ddayup-host.exe')) { throw 'pkg build failed' }

  # 还原源码占位符
  Move-Item $bak $src -Force
  $size = (Get-Item 'ddayup-host.exe').Length / 1MB
  Write-Host ('[OK] built ddayup-host.exe (' + [math]::Round($size, 1) + ' MB, embedded Node 18, no user Node install needed); REPO_ROOT injected=' + $REPO)
} finally {
  # 确保源码占位符被还原（即使打包失败）
  if (Test-Path 'ddayup-host.js.bak') { Move-Item 'ddayup-host.js.bak' 'ddayup-host.js' -Force }
  Pop-Location
}
