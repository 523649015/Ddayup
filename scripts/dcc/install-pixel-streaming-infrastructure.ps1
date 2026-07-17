param(
  [string]$Branch = "UE5.7",
  [string]$TargetDir = "",
  [switch]$SkipClone
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $TargetDir) {
  $TargetDir = Join-Path $repoRoot "tools\PixelStreamingInfrastructure-$Branch"
}

$repoUrl = "https://github.com/EpicGamesExt/PixelStreamingInfrastructure.git"

if (-not (Test-Path $TargetDir)) {
  if ($SkipClone) {
    throw "PixelStreamingInfrastructure directory was not found: $TargetDir"
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $TargetDir) | Out-Null
  git clone --branch $Branch $repoUrl $TargetDir
} else {
  Write-Host "Using existing PixelStreamingInfrastructure: $TargetDir"
}

Push-Location $TargetDir
try {
  Write-Host "Installing npm dependencies..."
  npm.cmd install

  Write-Host "Building Common..."
  Push-Location "Common"
  npm.cmd run build
  Pop-Location

  Write-Host "Building Signalling..."
  Push-Location "Signalling"
  npm.cmd run build
  Pop-Location

  Write-Host "Building Frontend library..."
  Push-Location "Frontend\library"
  npm.cmd run build
  Pop-Location

  Write-Host "Building Frontend UI library..."
  Push-Location "Frontend\ui-library"
  npm.cmd run build
  Pop-Location

  Write-Host "Building SignallingWebServer..."
  Push-Location "SignallingWebServer"
  npm.cmd run build
  Pop-Location

  Write-Host "Building reference player page..."
  Push-Location "Frontend\implementations\typescript"
  npm.cmd run build:dev
  Pop-Location

  Write-Host ""
  Write-Host "PixelStreamingInfrastructure $Branch is ready."
  Write-Host "Start it with:"
  Write-Host ".\scripts\dcc\start-unreal-pixel-streaming.ps1"
} finally {
  Pop-Location
}
