param(
  [string]$EngineRoot = ""
)

$ErrorActionPreference = "Stop"

if (-not $EngineRoot) {
  $candidates = @(
    "C:\Program Files\Epic Games",
    "D:\Epic Games",
    "F:\Epic Games"
  ) | Where-Object { Test-Path $_ }

  foreach ($root in $candidates) {
    $engine = Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '^(UE_|UE)?5\.' } |
      Sort-Object Name -Descending |
      Select-Object -First 1
    if ($engine) {
      $EngineRoot = $engine.FullName
      break
    }
  }
}

if (-not $EngineRoot -or -not (Test-Path $EngineRoot)) {
  throw "Pass -EngineRoot, for example: .\scripts\dcc\find-unreal-pixel-streaming.ps1 -EngineRoot `"C:\Program Files\Epic Games\UE_5.7`""
}

$EngineRoot = (Resolve-Path -LiteralPath $EngineRoot).Path
Write-Host "Unreal Engine root: $EngineRoot"

$patterns = @(
  "Engine\Plugins\Media\PixelStreaming\Resources\WebServers\SignallingWebServer",
  "Engine\Plugins\Media\PixelStreaming2\Resources\WebServers\SignallingWebServer",
  "Engine\Plugins\Experimental\PixelStreaming\Resources\WebServers\SignallingWebServer",
  "Engine\Extras\PixelStreaming\SignallingWebServer",
  "Samples\PixelStreaming\WebServers\SignallingWebServer"
)

$found = @()
foreach ($pattern in $patterns) {
  $path = Join-Path $EngineRoot $pattern
  if (Test-Path $path) {
    $found += $path
  }
}

if ($found.Count -eq 0) {
  Write-Host ""
  Write-Host "No bundled SignallingWebServer folder was found in this Engine installation."
  Write-Host "For recent Unreal versions, install/download Epic's PixelStreamingInfrastructure package, then run its SignallingWebServer."
  Write-Host "Common repo name: EpicGamesExt/PixelStreamingInfrastructure"
  Write-Host ""
  Write-Host "After it starts, open its browser URL and put that URL into HMDao DCC node > Pixel Streaming."
  exit 2
}

foreach ($server in $found) {
  Write-Host ""
  Write-Host "Found SignallingWebServer: $server"
  $scripts = Get-ChildItem -LiteralPath $server -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^(Start|run|start|setup).*\\.(bat|cmd|ps1)$|^(Start_SignallingServer|run_local)\\.(bat|cmd|ps1)$' } |
    Select-Object -First 12
  if ($scripts.Count -eq 0) {
    Write-Host "No obvious start script was found. Check package README in this folder."
  } else {
    Write-Host "Candidate scripts:"
    foreach ($script in $scripts) {
      Write-Host "  $($script.FullName)"
    }
  }
}

Write-Host ""
Write-Host "Typical flow:"
Write-Host "1. Run setup/get_ps_servers script if present."
Write-Host "2. Run Start_SignallingServer.ps1/bat or run_local.bat."
Write-Host "3. Open the printed web URL, usually http://127.0.0.1 or http://127.0.0.1:80/8888."
Write-Host "4. Put that URL into HMDao DCC node > Pixel Streaming."
Write-Host "5. Keep Remote Control API at http://127.0.0.1:30010."
