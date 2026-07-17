param(
  [Parameter(Mandatory = $true)]
  [string]$UProject,

  [string]$EngineRoot = "",
  [string]$Map = "/Game/Main",
  [string]$LevelSequence = "/Game/NewLevelSequence.NewLevelSequence",
  [string]$OutputDir = "",
  [ValidateSet("png", "jpg")]
  [string]$ImageFormat = "png",
  [int]$Width = 960,
  [int]$Height = 540,
  [int]$StartFrame = 0,
  [int]$EndFrame = 0
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot 'unreal-path-alias.ps1')

function Resolve-UnrealEngineRoot {
  param(
    [string]$ResolvedProjectFile,
    [string]$ExplicitEngineRoot
  )

  if (-not [string]::IsNullOrWhiteSpace($ExplicitEngineRoot)) {
    return (Resolve-Path -LiteralPath $ExplicitEngineRoot).Path
  }

  $projectJson = Get-Content -LiteralPath $ResolvedProjectFile -Raw | ConvertFrom-Json
  $engineAssociation = [string]$projectJson.EngineAssociation
  if ([string]::IsNullOrWhiteSpace($engineAssociation)) {
    throw "EngineAssociation was not found in $ResolvedProjectFile"
  }

  $candidates = @(
    "F:\Unreal Engine\UE_$engineAssociation",
    "C:\Program Files\Epic Games\UE_$engineAssociation"
  )

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }

  $buildsKey = "HKCU:\Software\Epic Games\Unreal Engine\Builds"
  if (Test-Path $buildsKey) {
    $builds = Get-ItemProperty -Path $buildsKey
    foreach ($property in $builds.PSObject.Properties) {
      if ($property.Name -eq $engineAssociation -or $property.Value -like "*UE_$engineAssociation*") {
        if (Test-Path -LiteralPath $property.Value) {
          return (Resolve-Path -LiteralPath $property.Value).Path
        }
      }
    }
  }

  throw "Unable to resolve Unreal Engine root for EngineAssociation '$engineAssociation'. Pass -EngineRoot explicitly."
}

$projectFile = (Resolve-Path -LiteralPath $UProject).Path
$projectDir = Split-Path -Parent $projectFile
$projectName = [System.IO.Path]::GetFileNameWithoutExtension($projectFile)
$resolvedEngineRoot = Resolve-UnrealEngineRoot -ResolvedProjectFile $projectFile -ExplicitEngineRoot $EngineRoot
$editorCmd = Join-Path $resolvedEngineRoot "Engine\Binaries\Win64\UnrealEditor-Cmd.exe"

if (-not (Test-Path -LiteralPath $editorCmd)) {
  throw "UnrealEditor-Cmd.exe was not found: $editorCmd"
}

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $outputDir = Join-Path $projectDir ("Saved\HMDaoCapture\" + $projectName + "_" + (Get-Date -Format "yyyyMMdd-HHmmss"))
} else {
  $outputDir = [System.IO.Path]::GetFullPath($OutputDir)
}

$captureLogPath = Join-Path $projectDir ("Saved\Logs\" + $projectName + "_hmdao_capture.log")

$resolvedEndFrame = $EndFrame
if ($resolvedEndFrame -le $StartFrame) {
  $resolvedEndFrame = $StartFrame + 1
}

New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

$projectAlias = $null
$outputAlias = $null
try {
  $projectAlias = New-HMDaoTemporaryPathAlias -Path $projectDir -Label 'uproject root'
  $outputAlias = New-HMDaoTemporaryPathAlias -Path $outputDir -Label 'capture output'

  $aliasedProjectFile = Convert-HMDaoPathToAlias -Path $projectFile -AliasContext $projectAlias
  $aliasedOutputDir = Convert-HMDaoPathToAlias -Path $outputDir -AliasContext $outputAlias
  $aliasedCaptureLogPath = Convert-HMDaoPathToAlias -Path $captureLogPath -AliasContext $projectAlias

  $moviePipelineExecutorClass = '/Script/MovieRenderPipelineCore.MoviePipelinePythonHostExecutor'
  $executorPythonClass = '/Engine/PythonTypes.HMDaoValidationExecutor'
  $quotedLevelSequence = '"' + $LevelSequence + '"'
  $quotedMoviePipelineExecutorClass = '"' + $moviePipelineExecutorClass + '"'
  $quotedExecutorPythonClass = '"' + $executorPythonClass + '"'

  $args = @(
    $aliasedProjectFile,
    $Map,
    "-game",
    "-MoviePipelineLocalExecutorClass=$quotedMoviePipelineExecutorClass",
    "-ExecutorPythonClass=$quotedExecutorPythonClass",
    "-LevelSequence=$quotedLevelSequence",
    "-RenderOutputDir=$($aliasedOutputDir -replace '\\','/')",
    "-ImageFormat=$ImageFormat",
    "-RenderResX=$Width",
    "-RenderResY=$Height",
    "-StartFrame=$StartFrame",
    "-EndFrame=$resolvedEndFrame",
    "-log",
    "-forcelogflush",
    "-abslog=$($aliasedCaptureLogPath -replace '\\','/')",
    "-stdout",
    "-FullStdOutLogOutput",
    "-NoSplash",
    "-Unattended",
    "-NoSound"
  )

  Write-Host "Unreal Engine Root: $resolvedEngineRoot"
  Write-Host "Project: $projectFile"
  if ($projectAlias -and $projectAlias.UsedAlias) {
    Write-Host "Project alias: $aliasedProjectFile"
  }
  Write-Host "Map: $Map"
  Write-Host "Sequence: $LevelSequence"
  Write-Host "Executor: $moviePipelineExecutorClass"
  Write-Host "Python Executor: $executorPythonClass"
  Write-Host "Output: $outputDir"
  if ($outputAlias -and $outputAlias.UsedAlias) {
    Write-Host "Output alias: $aliasedOutputDir"
  }
  Write-Host "Log: $captureLogPath"
  Write-Host "Size: ${Width}x${Height}"
  Write-Host "Frames: $StartFrame-$resolvedEndFrame"
  Write-Host "Format: $ImageFormat"

  & $editorCmd @args
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "Unreal sequence capture failed with exit code $exitCode"
  }
} finally {
  Remove-HMDaoTemporaryPathAlias -AliasContext $outputAlias
  Remove-HMDaoTemporaryPathAlias -AliasContext $projectAlias
}

$outputs = Get-ChildItem -LiteralPath $outputDir -File | Sort-Object LastWriteTime
if (-not $outputs) {
  throw "Capture finished but no output files were found in $outputDir"
}

Write-Host "Captured files:"
$outputs | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize
