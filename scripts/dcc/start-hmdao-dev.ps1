param(
  [switch]$StopExisting
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$appDir = Join-Path $repoRoot "app"

function Get-PortPids([int[]]$Ports) {
  $pattern = ($Ports | ForEach-Object { [regex]::Escape(":$_") }) -join "|"
  $lines = netstat -ano | Select-String -Pattern $pattern
  $pids = @()
  foreach ($line in $lines) {
    $parts = ($line.ToString() -split "\s+") | Where-Object { $_ }
    if ($parts.Count -ge 5 -and $parts[3] -eq "LISTENING") {
      $pids += [int]$parts[4]
    }
  }
  $pids | Sort-Object -Unique
}

if ($StopExisting) {
  $pids = Get-PortPids @(3000, 8787)
  foreach ($processId in $pids) {
    try {
      Write-Host "Stopping process on HMDao dev port: PID $processId"
      Stop-Process -Id $processId -Force
    } catch {
      Write-Host "Could not stop PID ${processId}: $($_.Exception.Message)"
    }
  }
}

Set-Location $appDir
Write-Host "Starting HMDao dev stack from $appDir"
Write-Host "Use Ctrl+C to stop."
npm.cmd run dev:full

