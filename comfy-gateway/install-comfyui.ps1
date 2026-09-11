# Install & start ComfyUI (HMDao helper)
# Usage:
#   .\install-comfyui.ps1                      # clone + venv + deps (no start)
#   .\install-comfyui.ps1 -Start               # above + launch ComfyUI (foreground)
#   .\install-comfyui.ps1 -Cuda                # install CUDA torch instead of CPU
#   .\install-comfyui.ps1 -CheckpointUrl <url> # also download a checkpoint
param(
  [string]$TargetDir = "$PSScriptRoot\ComfyUI",
  [switch]$Cuda,
  [string]$CheckpointUrl = ""
)

$ErrorActionPreference = 'Stop'

# Pick a stable Python (default 'python' may be 3.15 alpha without torch wheels).
$PyVersion = ""
if (Get-Command "py.exe" -ErrorAction SilentlyContinue) {
  foreach ($v in @("3.13", "3.12", "3.11", "3.14", "3.10")) {
    & py "-$v" --version 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $PyVersion = $v; break }
  }
}
if ($PyVersion) {
  Write-Host "Using Python $PyVersion via py launcher to create venv." -ForegroundColor Cyan
}

if (Test-Path $TargetDir) {
  Write-Host "ComfyUI already exists at $TargetDir, skip clone." -ForegroundColor Yellow
} else {
  Write-Host "Cloning ComfyUI -> $TargetDir" -ForegroundColor Cyan
  # GitHub direct clone is often reset on this host; try mirrors in order, stop on first success.
  $mirrors = @(
    $env:COMFYUI_GIT_URL,
    "https://github.com/comfyanonymous/ComfyUI.git",
    "https://gitclone.com/github.com/comfyanonymous/ComfyUI.git",
    "https://ghproxy.net/https://github.com/comfyanonymous/ComfyUI.git"
  ) | Where-Object { $_ }
  $cloned = $false
  foreach ($m in $mirrors) {
    Write-Host "Trying mirror: $m" -ForegroundColor DarkGray
    git clone "$m" "$TargetDir" --depth 1
    if ($LASTEXITCODE -eq 0 -and (Test-Path "$TargetDir/main.py")) { $cloned = $true; break }
    Write-Host "Clone failed, try next mirror..." -ForegroundColor Yellow
  }
  if (-not $cloned) { throw "ComfyUI clone failed: all mirrors unavailable. Check network or set COMFYUI_GIT_URL." }
}

Set-Location $TargetDir

if (-not (Test-Path .venv)) {
  Write-Host "Creating venv .venv ..." -ForegroundColor Yellow
  if ($PyVersion) { py -$PyVersion -m venv .venv } else { python -m venv .venv }
}
& .\.venv\Scripts\Activate.ps1

Write-Host "Installing dependencies ..." -ForegroundColor Cyan
if ($Cuda) {
  pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124
} else {
  # CPU torch (lighter, no CUDA runtime).
  pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu
}
# Install the rest. Exclude torch/torchvision/torchaudio/xformers (installed separately above)
# but KEEP torchsde and any other torch*-prefixed deps ComfyUI needs at runtime.
(Get-Content requirements.txt) | Where-Object { $_ -notmatch '^xformers$' -and $_ -notmatch '^torch$' -and $_ -notmatch '^torchvision$' -and $_ -notmatch '^torchaudio$' } | Set-Content requirements.nocuda.txt
pip install -r requirements.nocuda.txt

if ($CheckpointUrl) {
  $ckptDir = "models\checkpoints"
  New-Item -ItemType Directory -Force -Path $ckptDir | Out-Null
  $ckptName = [System.IO.Path]::GetFileName($CheckpointUrl.Split('?')[0])
  Write-Host "Downloading checkpoint -> $ckptName" -ForegroundColor Cyan
  Invoke-WebRequest -Uri $CheckpointUrl -OutFile "$ckptDir\$ckptName"
}

Write-Host "ComfyUI install complete." -ForegroundColor Green
Write-Host "Start: .\$TargetDir\.venv\Scripts\python.exe main.py   (default http://127.0.0.1:8188)" -ForegroundColor DarkGray
Write-Host "This gateway defaults COMFY_INSTANCES=http://127.0.0.1:8188, auto-connected after start." -ForegroundColor DarkGray

if ($Start) {
  Write-Host "Starting ComfyUI ..." -ForegroundColor Green
  # CPU-only torch 的 ComfyUI 必须显式 --cpu，否则 model_management 在导入期即假定 CUDA 而崩溃。
  if ($Cuda) { python main.py } else { python main.py --cpu }
}
