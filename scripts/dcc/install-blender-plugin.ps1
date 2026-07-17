param(
  [string]$BlenderVersion = "",
  [switch]$AllVersions
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$source = Join-Path $repoRoot "plugins\blender\hmdao_blender_capture"
if (-not (Test-Path $source)) {
  throw "Plugin source folder was not found: $source"
}

$blenderRoot = Join-Path $env:APPDATA "Blender Foundation\Blender"
if (-not (Test-Path $blenderRoot)) {
  throw "Blender user config folder was not found: $blenderRoot"
}

$versions = Get-ChildItem -LiteralPath $blenderRoot -Directory |
  Where-Object { $_.Name -match '^\d+(\.\d+)?$' } |
  Sort-Object { [version]$_.Name }

if ($versions.Count -eq 0) {
  throw "No Blender version folder was found under $blenderRoot."
}

if ($AllVersions -or -not $BlenderVersion) {
  $targets = $versions
} elseif ($BlenderVersion) {
  $targets = $versions | Where-Object { $_.Name -eq $BlenderVersion }
  if (-not $targets) {
    throw "Blender $BlenderVersion was not found. Available versions: $($versions.Name -join ', ')"
  }
}

foreach ($version in $targets) {
  $addons = Join-Path $version.FullName "scripts\addons"
  $dest = Join-Path $addons "hmdao_blender_capture"
  New-Item -ItemType Directory -Force -Path $addons | Out-Null
  try {
    if (Test-Path $dest) {
      Remove-Item -LiteralPath $dest -Recurse -Force
    }
    Copy-Item -LiteralPath $source -Destination $dest -Recurse -Force
  } catch {
    $message = $_.Exception.Message
    throw "Blender $($version.Name) is using HMDao Blender Capture files. Restart Blender and retry Install/Reinstall."
  }
  $cache = Join-Path $dest "__pycache__"
  if (Test-Path $cache) {
    Remove-Item -LiteralPath $cache -Recurse -Force
  }
  Write-Host "Installed HMDao Blender Capture for Blender $($version.Name): $dest"
}

Write-Host ""
Write-Host "Next steps:"
Write-Host "1. Restart Blender, or disable and re-enable HMDao Blender Capture in Preferences > Add-ons."
Write-Host "2. Restart Blender, then open View3D > Sidebar > HMDao and confirm the service shows 127.0.0.1:8766 / v1.3.4."
Write-Host "3. Run: node scripts/dcc/diagnose-dcc.mjs --engine=blender"
Write-Host "4. The canvas will show the real camera only after the diagnostic reports mode=real."
