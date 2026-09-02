# Build ddayup-host.exe via pkg (third-party, supports stdin pipe on Windows).
$ErrorActionPreference = 'Stop'
$NH = Split-Path -Parent $MyInvocation.MyCommand.Path

Push-Location $NH
try {
  # pkg 5.8.1 supports up to node18/node20 base. Try node20 target; if it fails, fallback to node18.
  $targets = @('node20-win-x64', 'node18-win-x64')
  $ok = $false
  foreach ($t in $targets) {
    Write-Host ('[pkg] building with ' + $t + ' ...')
    & pkg ddayup-host.js --targets $t --output ddayup-host.exe 2>&1
    if (Test-Path 'ddayup-host.exe') { $ok = $true; Write-Host ('[OK] built ddayup-host.exe with ' + $t); break }
  }
  if (-not $ok) { throw 'pkg build failed for all targets' }
} finally {
  Pop-Location
}
