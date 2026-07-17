param(
  [Parameter(Mandatory = $true)]
  [string]$UProject,
  [string]$EngineRoot = "",
  [ValidateSet("project", "engine")]
  [string]$InstallScope = "project",
  [string]$PrecompiledPackage = "",
  [switch]$Build,
  [switch]$RemoveEngineInstall,
  [switch]$KeepProjectShadowCopy
)

$ErrorActionPreference = "Stop"

$projectFile = (Resolve-Path -LiteralPath $UProject).Path
$projectDir = Split-Path -Parent $projectFile
$projectName = [System.IO.Path]::GetFileNameWithoutExtension($projectFile)
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$source = Join-Path $repoRoot "plugins\unreal\HMDaoUnrealCapture"
$pathAliasHelpers = Join-Path $PSScriptRoot 'unreal-path-alias.ps1'

if (-not (Test-Path -LiteralPath $source)) {
  throw "Plugin source folder was not found: $source"
}
if (-not (Test-Path -LiteralPath $pathAliasHelpers)) {
  throw "Unreal path alias helper script was not found: $pathAliasHelpers"
}

. $pathAliasHelpers

function Get-UnrealVersionInfo {
  param([string]$ResolvedEngineRoot)

  if ([string]::IsNullOrWhiteSpace($ResolvedEngineRoot)) {
    return [pscustomobject]@{ Label = "UE-custom"; Major = $null; Minor = $null }
  }

  $buildVersionPath = Join-Path $ResolvedEngineRoot "Engine\Build\Build.version"
  if (Test-Path -LiteralPath $buildVersionPath) {
    try {
      $buildVersion = Get-Content -LiteralPath $buildVersionPath -Raw | ConvertFrom-Json
      return [pscustomobject]@{
        Label = "UE $($buildVersion.MajorVersion).$($buildVersion.MinorVersion)"
        Major = [int]$buildVersion.MajorVersion
        Minor = [int]$buildVersion.MinorVersion
      }
    } catch {
    }
  }

  if ($ResolvedEngineRoot -match 'UE[_-]?(?<major>\d+)\.(?<minor>\d+)') {
    return [pscustomobject]@{
      Label = "UE $($matches.major).$($matches.minor)"
      Major = [int]$matches.major
      Minor = [int]$matches.minor
    }
  }

  return [pscustomobject]@{ Label = (Split-Path -Leaf $ResolvedEngineRoot); Major = $null; Minor = $null }
}


function Get-EnginePluginInstallPath {
  param([string]$ResolvedEngineRoot)
  return Join-Path $ResolvedEngineRoot "Engine\Plugins\Marketplace\HMDaoUnrealCapture"
}

function Move-ProjectPluginOutOfScanPath {
  param(
    [string]$ProjectDir,
    [string]$ProjectPluginPath
  )

  if ([string]::IsNullOrWhiteSpace($ProjectPluginPath) -or -not (Test-Path -LiteralPath $ProjectPluginPath)) {
    return ''
  }

  $backupRoot = Join-Path $ProjectDir '_PluginBackups'
  New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null

  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $destination = Join-Path $backupRoot ("HMDaoUnrealCapture.project-disabled-temp-" + $timestamp)
  while (Test-Path -LiteralPath $destination) {
    $destination = Join-Path $backupRoot ("HMDaoUnrealCapture.project-disabled-temp-" + $timestamp + "-" + (Get-Random -Minimum 1000 -Maximum 9999))
  }

  Move-Item -LiteralPath $ProjectPluginPath -Destination $destination
  return $destination
}

function Get-EnginePluginBuildOutputPath {
  param([pscustomobject]$VersionInfo)

  $versionLabel = if ($VersionInfo.Major -and $VersionInfo.Minor -ge 0) {
    "UE$($VersionInfo.Major)$($VersionInfo.Minor)"
  } else {
    "UE-custom"
  }
  return Join-Path $repoRoot ("tmp\unreal-engine-plugin-build\" + $versionLabel)
}

function New-EnginePluginBuildOutputPath {
  param([pscustomobject]$VersionInfo)

  $baseRoot = Get-EnginePluginBuildOutputPath -VersionInfo $VersionInfo
  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  return "$baseRoot-build-$timestamp"
}

function Get-HMDaoUnrealBuildConfigurationPath {
  $configDir = Join-Path $env:APPDATA 'Unreal Engine\UnrealBuildTool'
  return Join-Path $configDir 'BuildConfiguration.xml'
}

function Get-HMDaoRecommendedMaxParallelActions {
  $activeEditors = @(Get-Process -Name 'UnrealEditor' -ErrorAction SilentlyContinue)
  if ($activeEditors.Count -gt 0) {
    return 2
  }

  return 4
}

function Push-HMDaoConservativeUnrealBuildConfiguration {
  param([int]$MaxParallelActions = 4)

  $configPath = Get-HMDaoUnrealBuildConfigurationPath
  $configDir = Split-Path -Parent $configPath
  $originalExists = Test-Path -LiteralPath $configPath
  $originalContent = if ($originalExists) { Get-Content -LiteralPath $configPath -Raw } else { $null }

  New-Item -ItemType Directory -Force -Path $configDir | Out-Null

  $xml = @"
<?xml version="1.0" encoding="utf-8"?>
<Configuration xmlns="https://www.unrealengine.com/BuildConfiguration">
  <BuildConfiguration>
    <MaxParallelActions>$MaxParallelActions</MaxParallelActions>
    <bAllowUBAExecutor>false</bAllowUBAExecutor>
  </BuildConfiguration>
  <WindowsPlatform>
    <bWriteSarif>false</bWriteSarif>
    <bCompilerTrace>false</bCompilerTrace>
  </WindowsPlatform>
  <SourceFileWorkingSet>
    <Provider>None</Provider>
  </SourceFileWorkingSet>
</Configuration>
"@

  Set-Content -LiteralPath $configPath -Value $xml -Encoding utf8
  return [pscustomobject]@{
    Path = $configPath
    OriginalExists = $originalExists
    OriginalContent = $originalContent
    MaxParallelActions = $MaxParallelActions
  }
}

function Pop-HMDaoConservativeUnrealBuildConfiguration {
  param($BuildConfigOverride)

  if ($null -eq $BuildConfigOverride) {
    return
  }

  if ($BuildConfigOverride.OriginalExists) {
    Set-Content -LiteralPath $BuildConfigOverride.Path -Value $BuildConfigOverride.OriginalContent -Encoding utf8
  } elseif (Test-Path -LiteralPath $BuildConfigOverride.Path) {
    Remove-Item -LiteralPath $BuildConfigOverride.Path -Force
  }
}

function Find-ReusablePrecompiledPluginPackage {
  param([pscustomobject]$VersionInfo)

  $primaryRoot = Get-EnginePluginBuildOutputPath -VersionInfo $VersionInfo
  $candidateRoots = New-Object System.Collections.Generic.List[string]
  $candidateRoots.Add($primaryRoot) | Out-Null

  $buildRootParent = Split-Path -Parent $primaryRoot
  $buildRootLeaf = Split-Path -Leaf $primaryRoot
  if (Test-Path -LiteralPath $buildRootParent) {
    Get-ChildItem -LiteralPath $buildRootParent -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like "$buildRootLeaf*" } |
      Sort-Object LastWriteTime -Descending |
      ForEach-Object {
        if (-not $candidateRoots.Contains($_.FullName)) {
          $candidateRoots.Add($_.FullName) | Out-Null
        }
      }
  }

  foreach ($candidate in $candidateRoots) {
    if (Test-PrecompiledPluginReady -PluginRoot $candidate) {
      return $candidate
    }
  }

  return ''
}

function Resolve-ProvidedPrecompiledPluginPackage {
  param([string]$ProvidedRoot)

  if ([string]::IsNullOrWhiteSpace($ProvidedRoot)) {
    return ''
  }

  $resolvedRoot = (Resolve-Path -LiteralPath $ProvidedRoot).Path
  $candidateRoots = @(
    $resolvedRoot,
    (Join-Path $resolvedRoot 'HMDaoUnrealCapture')
  )

  foreach ($candidate in $candidateRoots) {
    if ((Test-Path -LiteralPath $candidate) -and (Test-PrecompiledPluginReady -PluginRoot $candidate)) {
      return $candidate
    }
  }

  throw "The supplied precompiled plugin package was not usable: $resolvedRoot. Expected a packaged HMDaoUnrealCapture root containing Binaries\\Win64\\UnrealEditor-HMDaoUnrealCapture.dll and UnrealEditor.modules."
}

function Set-PluginInstalledFlag {
  param([string]$PluginFile)

  if (-not (Test-Path -LiteralPath $PluginFile)) {
    return
  }

  $json = Get-Content -LiteralPath $PluginFile -Raw | ConvertFrom-Json
  $json | Add-Member -NotePropertyName Installed -NotePropertyValue $true -Force
  $json | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $PluginFile -Encoding utf8
}

function Install-PluginTree {
  param(
    [Parameter(Mandatory = $true)]
    [string]$SourceRoot,
    [Parameter(Mandatory = $true)]
    [string]$DestinationRoot,
    [switch]$RemoveBuildArtifacts
  )

  if (Test-Path -LiteralPath $DestinationRoot) {
    Remove-Item -LiteralPath $DestinationRoot -Recurse -Force
  }

  Copy-Item -LiteralPath $SourceRoot -Destination $DestinationRoot -Recurse -Force
  if ($RemoveBuildArtifacts) {
    Remove-PluginBuildArtifacts -PluginRoot $DestinationRoot
  }
  Set-PluginInstalledFlag -PluginFile (Join-Path $DestinationRoot 'HMDaoUnrealCapture.uplugin')
}

function Get-HMDaoUnrealDotNetCliEnvironmentSnapshot {
  $names = @(
    'DOTNET_SKIP_FIRST_TIME_EXPERIENCE',
    'DOTNET_CLI_TELEMETRY_OPTOUT',
    'DOTNET_NOLOGO',
    'DOTNET_MULTILEVEL_LOOKUP',
    'DOTNET_CLI_HOME'
  )

  return ($names | ForEach-Object {
    "$_=$([Environment]::GetEnvironmentVariable($_, 'Process'))"
  }) -join '; '
}

function Push-HMDaoUnrealDotNetCliEnvironment {
  param([string]$WorkspaceRoot)

  $cliHome = Join-Path $WorkspaceRoot 'tmp\dotnet-cli-home'
  New-Item -ItemType Directory -Force -Path $cliHome | Out-Null

  $names = @(
    'DOTNET_SKIP_FIRST_TIME_EXPERIENCE',
    'DOTNET_CLI_TELEMETRY_OPTOUT',
    'DOTNET_NOLOGO',
    'DOTNET_MULTILEVEL_LOOKUP',
    'DOTNET_CLI_HOME'
  )

  $original = @{}
  foreach ($name in $names) {
    $current = [Environment]::GetEnvironmentVariable($name, 'Process')
    if ($null -ne $current) {
      $original[$name] = $current
    }
  }

  [Environment]::SetEnvironmentVariable('DOTNET_SKIP_FIRST_TIME_EXPERIENCE', '1', 'Process')
  [Environment]::SetEnvironmentVariable('DOTNET_CLI_TELEMETRY_OPTOUT', '1', 'Process')
  [Environment]::SetEnvironmentVariable('DOTNET_NOLOGO', '1', 'Process')
  [Environment]::SetEnvironmentVariable('DOTNET_MULTILEVEL_LOOKUP', '0', 'Process')
  [Environment]::SetEnvironmentVariable('DOTNET_CLI_HOME', $cliHome, 'Process')

  Write-Host "Applied Unreal bundled .NET CLI startup workaround (DOTNET_CLI_HOME=$cliHome)."
  Write-Host ("Bundled dotnet CLI env: " + (Get-HMDaoUnrealDotNetCliEnvironmentSnapshot))

  return [pscustomobject]@{
    Original = $original
    Names = $names
  }
}

function Pop-HMDaoUnrealDotNetCliEnvironment {
  param($EnvironmentOverride)

  if ($null -eq $EnvironmentOverride) {
    return
  }

  foreach ($name in $EnvironmentOverride.Names) {
    if ($EnvironmentOverride.Original.ContainsKey($name)) {
      [Environment]::SetEnvironmentVariable($name, $EnvironmentOverride.Original[$name], 'Process')
    } else {
      [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    }
  }
}

function Remove-PluginBuildArtifacts {
  param([string]$PluginRoot)

  foreach ($name in @('Binaries', 'Intermediate')) {
    $target = Join-Path $PluginRoot $name
    if (Test-Path -LiteralPath $target) {
      Remove-Item -LiteralPath $target -Recurse -Force
    }
  }
}

function Test-PrecompiledPluginReady {
  param([string]$PluginRoot)

  $binary = Join-Path $PluginRoot "Binaries\Win64\UnrealEditor-HMDaoUnrealCapture.dll"
  $modules = Join-Path $PluginRoot "Binaries\Win64\UnrealEditor.modules"
  return (Test-Path -LiteralPath $binary) -and (Test-Path -LiteralPath $modules)
}

function Invoke-HMDaoBuildPluginPackage {
  param(
    [string]$ResolvedEngineRoot,
    [string]$SourcePluginRoot,
    [pscustomobject]$VersionInfo
  )

  $packageRoot = New-EnginePluginBuildOutputPath -VersionInfo $VersionInfo
  New-Item -ItemType Directory -Force -Path $packageRoot | Out-Null

  $sourceAlias = $null
  $packageAlias = $null
  $buildConfigOverride = $null
  $dotnetCliOverride = $null
  $engineBuildRoot = $ResolvedEngineRoot

  try {
    $sourceAlias = New-HMDaoTemporaryPathAlias -Path $SourcePluginRoot -Label 'plugin source'
    $packageAlias = New-HMDaoTemporaryPathAlias -Path $packageRoot -Label 'plugin package output'

    $sourcePluginFile = Convert-HMDaoPathToAlias -Path (Join-Path $SourcePluginRoot 'HMDaoUnrealCapture.uplugin') -AliasContext $sourceAlias
    $packagedPluginRoot = Convert-HMDaoPathToAlias -Path $packageRoot -AliasContext $packageAlias

    if ($sourceAlias.UsedAlias) {
      Write-Host "Using temporary ASCII-like plugin source path: $($sourceAlias.AliasRoot)"
    }
    if ($packageAlias.UsedAlias) {
      Write-Host "Using temporary ASCII-like package output path: $packagedPluginRoot"
    }

    $runUat = Join-Path $engineBuildRoot 'Engine\Build\BatchFiles\RunUAT.bat'
    if (-not (Test-Path -LiteralPath $runUat)) {
      throw "Unreal RunUAT.bat was not found: $runUat"
    }

    $recommendedMaxParallelActions = Get-HMDaoRecommendedMaxParallelActions
    $activeEditors = @(Get-Process -Name 'UnrealEditor' -ErrorAction SilentlyContinue)
    if ($activeEditors.Count -gt 0) {
      Write-Warning "Detected $($activeEditors.Count) active UnrealEditor process(es). BuildPlugin will use a conservative local UBT profile with MaxParallelActions=$recommendedMaxParallelActions to reduce contention."
    } else {
      Write-Host "Applying conservative local UBT profile for BuildPlugin (MaxParallelActions=$recommendedMaxParallelActions)."
    }
    $buildConfigOverride = Push-HMDaoConservativeUnrealBuildConfiguration -MaxParallelActions $recommendedMaxParallelActions
    $dotnetCliOverride = Push-HMDaoUnrealDotNetCliEnvironment -WorkspaceRoot $repoRoot

    & $runUat BuildPlugin "-Plugin=$sourcePluginFile" "-Package=$packagedPluginRoot" -TargetPlatforms=Win64 -Rocket -Verbose | Out-Host
    if ($LASTEXITCODE -ne 0) {
      throw 'Unreal BuildPlugin packaging failed.'
    }
  } finally {
    Pop-HMDaoUnrealDotNetCliEnvironment -EnvironmentOverride $dotnetCliOverride
    Pop-HMDaoConservativeUnrealBuildConfiguration -BuildConfigOverride $buildConfigOverride
    Remove-HMDaoTemporaryPathAlias -AliasContext $packageAlias
    Remove-HMDaoTemporaryPathAlias -AliasContext $sourceAlias
  }

  if (-not (Test-PrecompiledPluginReady -PluginRoot $packageRoot)) {
    throw "BuildPlugin finished but no packaged Win64 plugin binaries were found under $packageRoot"
  }

  $hostProjectDir = Join-Path $packageRoot 'HostProject'
  if (Test-Path -LiteralPath $hostProjectDir) {
    Remove-Item -LiteralPath $hostProjectDir -Recurse -Force
  }

  Set-PluginInstalledFlag -PluginFile (Join-Path $packageRoot 'HMDaoUnrealCapture.uplugin')
  return $packageRoot
}

$engineVersion = Get-UnrealVersionInfo -ResolvedEngineRoot $EngineRoot
$providedPrecompiledPackageRoot = Resolve-ProvidedPrecompiledPluginPackage -ProvidedRoot $PrecompiledPackage
Write-Host "Detected Unreal Engine version: $($engineVersion.Label)"
if ($providedPrecompiledPackageRoot) {
  Write-Host "Using supplied precompiled HMDao Unreal Capture package: $providedPrecompiledPackageRoot"
}

if ($RemoveEngineInstall) {
  if (-not $EngineRoot) {
    throw 'Pass -EngineRoot when using -RemoveEngineInstall.'
  }
  $enginePluginCandidates = @(
    (Join-Path $EngineRoot 'Engine\Plugins\HMDaoUnrealCapture'),
    (Join-Path $EngineRoot 'Engine\Plugins\Marketplace\HMDaoUnrealCapture'),
    (Join-Path $EngineRoot 'Engine\Plugins\VirtualProduction\HMDaoUnrealCapture')
  )
  foreach ($candidate in $enginePluginCandidates) {
    if (Test-Path -LiteralPath $candidate) {
      Remove-Item -LiteralPath $candidate -Recurse -Force
      Write-Host "Removed Engine-level HMDao plugin: $candidate"
    }
  }
}

$pluginsDir = Join-Path $projectDir 'Plugins'
$projectPluginDest = Join-Path $pluginsDir 'HMDaoUnrealCapture'
$enginePluginDest = if ($EngineRoot) { Get-EnginePluginInstallPath -ResolvedEngineRoot $EngineRoot } else { '' }

if ($InstallScope -eq 'project') {
  $projectPackageRoot = $providedPrecompiledPackageRoot
  if ((-not $projectPackageRoot) -and $EngineRoot) {
    $candidatePackageRoot = Find-ReusablePrecompiledPluginPackage -VersionInfo $engineVersion
    if ($candidatePackageRoot) {
      $projectPackageRoot = $candidatePackageRoot
    }
  }

  if ($Build) {
    if ($providedPrecompiledPackageRoot) {
      throw 'Do not combine -Build with -PrecompiledPackage. Supply one packaged HMDao plugin or ask HMDao to build one, but not both at the same time.'
    }
    if (-not $EngineRoot) {
      throw 'Pass -EngineRoot when using -Build with project installs.'
    }
    Write-Host 'Packaging precompiled project-level HMDao Unreal Capture plugin...'
    $projectPackageRoot = Invoke-HMDaoBuildPluginPackage -ResolvedEngineRoot $EngineRoot -SourcePluginRoot $source -VersionInfo $engineVersion
  }

  if (-not $projectPackageRoot) {
    if (-not $EngineRoot) {
      throw 'Project-level HMDao Unreal Capture installs now require a precompiled package. Pass -EngineRoot so HMDao can locate or build a compatible package; source-only project installs are disabled to avoid missing Unreal modules and stale project pollution.'
    }

    throw "No reusable precompiled HMDao package was found for $($engineVersion.Label). Run again with -Build once, use -PrecompiledPackage, or use an engine-level install. Source-only project installs are disabled to avoid missing Unreal modules and stale project pollution."
  }

  New-Item -ItemType Directory -Force -Path $pluginsDir | Out-Null
  Install-PluginTree -SourceRoot $projectPackageRoot -DestinationRoot $projectPluginDest
  Write-Host "Installed precompiled HMDao Unreal Capture copy to project plugin folder: $projectPluginDest"

  if ($Build) {
    Write-Host 'Precompiled project-level copy complete. You can now open the project and enable HMDao Unreal Capture manually from the plugin list.'
  } else {
    Write-Host 'Project-level precompiled copy-only install completed. Enable HMDao Unreal Capture manually from the Unreal plugin list when needed.'
  }
} else {
  if (-not $EngineRoot) {
    throw 'Pass -EngineRoot when using engine-level installs.'
  }

  $packageRoot = $providedPrecompiledPackageRoot
  if ($Build) {
    if ($providedPrecompiledPackageRoot) {
      throw 'Do not combine -Build with -PrecompiledPackage. Supply one packaged HMDao plugin or ask HMDao to build one, but not both at the same time.'
    }
    Write-Host 'Packaging precompiled engine-level HMDao Unreal Capture plugin...'
    $packageRoot = Invoke-HMDaoBuildPluginPackage -ResolvedEngineRoot $EngineRoot -SourcePluginRoot $source -VersionInfo $engineVersion
  } elseif (-not $packageRoot) {
    $packageRoot = Find-ReusablePrecompiledPluginPackage -VersionInfo $engineVersion
  }
  if (-not $packageRoot) {
    throw "No reusable precompiled HMDao package was found at $packageRoot. Run again with -Build once or pass -PrecompiledPackage."
  }

  $enginePluginParent = Split-Path -Parent $enginePluginDest
  New-Item -ItemType Directory -Force -Path $enginePluginParent | Out-Null
  Install-PluginTree -SourceRoot $packageRoot -DestinationRoot $enginePluginDest

  Write-Host "Installed precompiled HMDao Unreal Capture to engine plugin folder: $enginePluginDest"
  if (Test-Path -LiteralPath $projectPluginDest) {
    if ($KeepProjectShadowCopy) {
      Write-Warning "A project-local HMDaoUnrealCapture copy still exists at $projectPluginDest. Unreal will prefer the project-local copy over the engine-level install until that older project plugin folder is removed or renamed."
    } else {
      $backupPath = Move-ProjectPluginOutOfScanPath -ProjectDir $projectDir -ProjectPluginPath $projectPluginDest
      Write-Host "Moved project-local HMDaoUnrealCapture copy out of Unreal scan paths: $backupPath"
      Write-Host 'Unreal will now resolve the engine-level precompiled HMDao plugin first, while keeping a reversible backup of the old project copy.'
    }
  }
}

