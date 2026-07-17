param(
  [string]$InfrastructureDir = "",
  [int]$PlayerPort = 1025,
  [int]$StreamerPort = 8888,
  [int]$SfuPort = 8889,
  [string]$LogDir = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $InfrastructureDir) {
  $InfrastructureDir = Join-Path $repoRoot "tools\PixelStreamingInfrastructure-UE5.7"
}
if (-not $LogDir) {
  $LogDir = Join-Path $env:TEMP "hmdao-pixelstreaming-logs"
}

$serverDir = Join-Path $InfrastructureDir "SignallingWebServer"
$entry = Join-Path $serverDir "dist\index.js"
$www = Join-Path $serverDir "www\player.html"

if (-not (Test-Path $entry)) {
  throw "SignallingWebServer is not built. Run .\scripts\dcc\install-pixel-streaming-infrastructure.ps1 first."
}
if (-not (Test-Path $www)) {
  throw "Pixel Streaming player page was not found: $www"
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

Write-Host "Starting HMDao Unreal Pixel Streaming SignallingWebServer..."
Write-Host "Player URL : http://127.0.0.1:$PlayerPort"
Write-Host "Streamer   : ws://127.0.0.1:$StreamerPort"
Write-Host "SFU        : ws://127.0.0.1:$SfuPort"
Write-Host "REST API   : http://127.0.0.1:$PlayerPort/api/status"
Write-Host "Log folder : $LogDir"
Write-Host ""
Write-Host "In Unreal, enable Pixel Streaming/Pixel Streaming 2, then connect the Streamer to ws://127.0.0.1:$StreamerPort."

Push-Location $serverDir
try {
  node dist/index.js `
    --serve `
    --player_port $PlayerPort `
    --streamer_port $StreamerPort `
    --sfu_port $SfuPort `
    --http_root www `
    --homepage player.html `
    --rest_api `
    --log_folder $LogDir `
    --log_config `
    --console_messages basic
} finally {
  Pop-Location
}
