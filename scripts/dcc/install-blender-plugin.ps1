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

  # 安装即启用：复制后自动启用 add-on，避免"装了却连不上"的手动步骤
  # （与 Unreal 的"安装即写入 .uproject 启用项"对齐）。
  $blenderExe = $null
  try { $blenderExe = (Get-Command blender -ErrorAction SilentlyContinue).Source } catch {}
  if (-not $blenderExe) {
    $cand = Get-ChildItem "C:\Program Files\Blender Foundation" -Recurse -Filter blender.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cand) { $blenderExe = $cand.FullName }
  }
  if ($blenderExe) {
    $enablePy = 'import bpy; bpy.ops.preferences.addon_enable(module="hmdao_blender_capture"); bpy.ops.wm.save_userpref()'
    try {
      & $blenderExe -b --python-expr $enablePy 2>&1 | Out-Null
      Write-Host "Auto-enabled HMDao Blender Capture add-on for Blender $($version.Name)."
    } catch {
      Write-Host "Could not auto-enable the add-on (Blender may be running). Enable it manually in Preferences > Add-ons."
    }
  } else {
    Write-Host "Blender executable not found; enable HMDao Blender Capture manually in Preferences > Add-ons."
  }
}

Write-Host ""
Write-Host "Next steps:"
Write-Host "1. Restart Blender, or disable and re-enable HMDao Blender Capture in Preferences > Add-ons."
Write-Host "2. Restart Blender, then open View3D > Sidebar > HMDao and confirm the service shows 127.0.0.1:8766 / v1.3.4."
Write-Host "3. Run: node scripts/dcc/diagnose-dcc.mjs --engine=blender"
Write-Host "4. The canvas will show the real camera only after the diagnostic reports mode=real."
