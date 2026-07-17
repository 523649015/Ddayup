param(
  [Parameter(Mandatory = $true)]
  [string]$UProject,
  [string]$EngineRoot = '',
  [switch]$CleanRuntimeResidue,
  [switch]$LaunchEditor,
  [switch]$HMDaoConnect,
  [switch]$NoLiveCoding,
  [switch]$Json
)

<# 
  NOTE on -HMDaoConnect (important: this is OPTIONAL, NOT a hard requirement)

  -HMDaoConnect merely injects the "-HMDaoConnect" command-line flag so the editor
  auto-connects to HMDao the moment it finishes launching. It is only useful when THIS
  script is the one launching UnrealEditor.exe. It CANNOT be applied to editors opened
  through other entry points (Epic Games Launcher, a desktop shortcut, or double-clicking
  a .uproject), because those command lines are not controlled by this script.

  The canonical, launch-method-agnostic connection path does NOT need this flag at all:
  whenever the user clicks "Connect" in HMDao, the backend writes an on-demand request
  file (hmdao_unreal_capture.request.json) into the OS temp directory. The HMDao Unreal
  Capture plugin boots in a lightweight "bootstrap" mode on EVERY editor launch and polls
  that file once per second; when it sees the request it connects on its own. This works
  regardless of how the editor was started (Epic / shortcut / double-click) as long as the
  project has the plugin enabled and the editor window is open.

  Therefore: prefer letting users open the project any way they like and click Connect in
  HMDao. Only pass -HMDaoConnect when you specifically want this script to launch the editor
  AND auto-connect immediately (e.g. a one-shot validation run). Do not treat the absence of
  -HMDaoConnect as a failure mode - connections via the on-demand request file are equivalent.
#>

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$hostHelperPath = Join-Path $PSScriptRoot 'prepare-dcc-host-startup.ps1'
$pluginName = 'HMDaoUnrealCapture'
$enginePluginCandidates = @(
  'Engine\Plugins\Marketplace\HMDaoUnrealCapture',
  'Engine\Plugins\HMDaoUnrealCapture',
  'Engine\Plugins\VirtualProduction\HMDaoUnrealCapture'
)

function Test-TcpPort {
  param(
    [string]$HostName,
    [int]$Port,
    [int]$TimeoutMs = 800
  )

  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect($HostName, $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) {
      return $false
    }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Resolve-UnrealProjectFile {
  param([string]$RequestedPath)

  $resolved = (Resolve-Path -LiteralPath $RequestedPath).Path
  if (-not $resolved.EndsWith('.uproject', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Expected a .uproject file: $RequestedPath"
  }
  return $resolved
}

function Get-UnrealProjectJson {
  param([string]$ProjectFile)

  try {
    return Get-Content -LiteralPath $ProjectFile -Raw | ConvertFrom-Json
  } catch {
    return [pscustomobject]@{}
  }
}

function Get-UnrealVersionInfo {
  param([string]$ResolvedEngineRoot)

  if ([string]::IsNullOrWhiteSpace($ResolvedEngineRoot)) {
    return [pscustomobject]@{
      Label = 'UE-custom'
      Version = ''
      MajorMinor = ''
      BuildVersionPath = ''
    }
  }

  $buildVersionPath = Join-Path $ResolvedEngineRoot 'Engine\Build\Build.version'
  if (Test-Path -LiteralPath $buildVersionPath) {
    try {
      $buildVersion = Get-Content -LiteralPath $buildVersionPath -Raw | ConvertFrom-Json
      $majorMinor = "$($buildVersion.MajorVersion).$($buildVersion.MinorVersion)"
      return [pscustomobject]@{
        Label = "UE $majorMinor"
        Version = $majorMinor
        MajorMinor = $majorMinor
        BuildVersionPath = $buildVersionPath
      }
    } catch {
    }
  }

  if ($ResolvedEngineRoot -match 'UE[_-]?(?<major>\d+)\.(?<minor>\d+)') {
    $majorMinor = "$($matches.major).$($matches.minor)"
    return [pscustomobject]@{
      Label = "UE $majorMinor"
      Version = $majorMinor
      MajorMinor = $majorMinor
      BuildVersionPath = $buildVersionPath
    }
  }

  return [pscustomobject]@{
    Label = (Split-Path -Leaf $ResolvedEngineRoot)
    Version = ''
    MajorMinor = ''
    BuildVersionPath = $buildVersionPath
  }
}

function Resolve-UnrealEngineRoot {
  param(
    [string]$RequestedEngineRoot,
    [object]$ProjectJson
  )

  if (-not [string]::IsNullOrWhiteSpace($RequestedEngineRoot)) {
    $candidate = (Resolve-Path -LiteralPath $RequestedEngineRoot).Path
    if (Test-Path -LiteralPath (Join-Path $candidate 'Engine\Binaries\Win64\UnrealEditor.exe')) {
      return $candidate
    }
    throw "UnrealEditor.exe was not found under: $candidate"
  }

  $association = [string]$ProjectJson.EngineAssociation
  if ([string]::IsNullOrWhiteSpace($association)) {
    return ''
  }

  $roots = @(
    'F:\Unreal Engine',
    'C:\Program Files\Epic Games',
    'D:\Epic Games',
    'E:\Epic Games'
  )

  $candidates = New-Object System.Collections.Generic.List[string]
  $directAssociationPath = $association.Trim()
  if (Test-Path -LiteralPath $directAssociationPath) {
    $candidates.Add((Resolve-Path -LiteralPath $directAssociationPath).Path) | Out-Null
  }

  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    $candidates.Add((Join-Path $root ("UE_" + $association))) | Out-Null
    $candidates.Add((Join-Path $root ("UE" + $association))) | Out-Null
  }

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath (Join-Path $candidate 'Engine\Binaries\Win64\UnrealEditor.exe')) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }

  return ''
}

function Get-ProjectPluginState {
  param(
    [string]$ProjectDir,
    [string]$ResolvedEngineRoot
  )

  $projectPluginPath = Join-Path $ProjectDir ("Plugins\" + $pluginName)
  $projectInstalled = Test-Path -LiteralPath (Join-Path $projectPluginPath ($pluginName + '.uplugin'))

  $enginePluginPath = ''
  foreach ($candidateSuffix in $enginePluginCandidates) {
    $candidatePath = Join-Path $ResolvedEngineRoot $candidateSuffix
    if (Test-Path -LiteralPath (Join-Path $candidatePath ($pluginName + '.uplugin'))) {
      $enginePluginPath = $candidatePath
      break
    }
  }

  $shadowRoots = @(
    (Join-Path $ResolvedEngineRoot 'Engine\Plugins\_HMDaoBackups'),
    (Join-Path $ResolvedEngineRoot '_PluginBackups')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

  return [pscustomobject]@{
    ProjectPluginPath = $projectPluginPath
    ProjectInstalled = $projectInstalled
    EnginePluginPath = $enginePluginPath
    EngineInstalled = -not [string]::IsNullOrWhiteSpace($enginePluginPath)
    DuplicateInstall = $projectInstalled -and -not [string]::IsNullOrWhiteSpace($enginePluginPath)
    ShadowBackupRoots = $shadowRoots
  }
}

function Get-ProxyNoiseState {
  param([string]$MajorMinor)

  $appLogPath = if ([string]::IsNullOrWhiteSpace($MajorMinor)) {
    ''
  } else {
    Join-Path $env:LOCALAPPDATA ("UnrealEngine\" + $MajorMinor + '\\Saved\\Logs\\Unreal.log')
  }

  $timeoutLines = @()
  if ($appLogPath -and (Test-Path -LiteralPath $appLogPath)) {
    $timeoutLines = Select-String -Path $appLogPath -Pattern 'generate_204|HttpProxyAddress' -SimpleMatch:$false -ErrorAction SilentlyContinue |
      Select-Object -Last 20 -ExpandProperty Line
  }

  return [pscustomobject]@{
    HttpProxy = [Environment]::GetEnvironmentVariable('HTTP_PROXY', 'Process')
    HttpsProxy = [Environment]::GetEnvironmentVariable('HTTPS_PROXY', 'Process')
    AllProxy = [Environment]::GetEnvironmentVariable('ALL_PROXY', 'Process')
    Local7897Reachable = (Test-TcpPort -HostName '127.0.0.1' -Port 7897 -TimeoutMs 500)
    AppLogPath = $appLogPath
    RecentTimeoutLines = $timeoutLines
  }
}

function Get-CacheState {
  param([string]$ProjectDir)

  $commonDdc = Join-Path $env:LOCALAPPDATA 'UnrealEngine\Common\DerivedDataCache'
  $projectDdc = Join-Path $ProjectDir 'DerivedDataCache'
  $shaderTemp = Join-Path $env:LOCALAPPDATA 'Temp\UnrealShaderWorkingDir'
  $xgeTemp = Join-Path $env:LOCALAPPDATA 'Temp\UnrealXGEWorkingDir'
  $zenInstall = Join-Path $env:LOCALAPPDATA 'UnrealEngine\Common\Zen\Install\zenserver.exe'

  $commonStat = if (Test-Path -LiteralPath $commonDdc) { Get-Item -LiteralPath $commonDdc } else { $null }
  $projectStat = if (Test-Path -LiteralPath $projectDdc) { Get-Item -LiteralPath $projectDdc } else { $null }
  $shaderStat = if (Test-Path -LiteralPath $shaderTemp) { Get-Item -LiteralPath $shaderTemp } else { $null }

  return [pscustomobject]@{
    CommonDdcPath = $commonDdc
    CommonDdcExists = $null -ne $commonStat
    CommonDdcLastWriteTime = if ($commonStat) { $commonStat.LastWriteTime.ToString('s') } else { '' }
    ProjectDdcPath = $projectDdc
    ProjectDdcExists = $null -ne $projectStat
    ProjectDdcLastWriteTime = if ($projectStat) { $projectStat.LastWriteTime.ToString('s') } else { '' }
    ShaderTempPath = $shaderTemp
    ShaderTempExists = $null -ne $shaderStat
    ShaderTempLastWriteTime = if ($shaderStat) { $shaderStat.LastWriteTime.ToString('s') } else { '' }
    XgeTempPath = $xgeTemp
    XgeTempExists = Test-Path -LiteralPath $xgeTemp
    ZenInstallPath = $zenInstall
    ZenInstallExists = Test-Path -LiteralPath $zenInstall
    ZenPortReady = (Test-TcpPort -HostName '127.0.0.1' -Port 8558 -TimeoutMs 500)
  }
}

function Remove-SafeRuntimeResidue {
  param([string]$ProjectDir)

  $removed = New-Object System.Collections.Generic.List[string]
  $dirTargets = @(
    (Join-Path $ProjectDir 'Saved\Logs'),
    (Join-Path $ProjectDir 'Saved\Crashes'),
    (Join-Path $env:LOCALAPPDATA 'Temp\UnrealShaderWorkingDir'),
    (Join-Path $env:LOCALAPPDATA 'Temp\UnrealXGEWorkingDir')
  )

  foreach ($target in $dirTargets) {
    if (Test-Path -LiteralPath $target) {
      Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
      if (-not (Test-Path -LiteralPath $target)) {
        $removed.Add($target) | Out-Null
      }
    }
  }

  $fileTargets = @(
    (Join-Path $ProjectDir 'Intermediate\TurnkeyLog_0.log'),
    (Join-Path $ProjectDir 'Intermediate\TurnkeyLog_1.log'),
    (Join-Path $ProjectDir 'Intermediate\TurnkeyReport_0.log'),
    (Join-Path $ProjectDir 'Intermediate\TurnkeyReport_1.log')
  )

  foreach ($target in $fileTargets) {
    if (Test-Path -LiteralPath $target) {
      Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
      if (-not (Test-Path -LiteralPath $target)) {
        $removed.Add($target) | Out-Null
      }
    }
  }

  return $removed
}

function Invoke-HostHelperSnapshot {
  param([string]$HelperPath)

  if (-not (Test-Path -LiteralPath $HelperPath)) {
    return $null
  }

  try {
    $jsonText = & powershell -ExecutionPolicy Bypass -File $HelperPath -Json 2>$null
    if ([string]::IsNullOrWhiteSpace($jsonText)) {
      return $null
    }
    return $jsonText | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Ensure-VisibleUnrealEditorWindow {
  param(
    [int]$ProcessId,
    [int]$TimeoutSeconds = 90
  )

  if ($ProcessId -le 0) {
    return $null
  }

  if (-not ('HMDao.Win32WindowTools' -as [type])) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace HMDao {
  public static class Win32WindowTools {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
  }
}
"@
  }

  $deadline = (Get-Date).AddSeconds([Math]::Max($TimeoutSeconds, 1))
  do {
    $script:windowHandle = [IntPtr]::Zero
    $script:windowTitle = ''
    $script:windowVisible = $false

    $callback = [HMDao.Win32WindowTools+EnumWindowsProc]{
      param([IntPtr]$hWnd, [IntPtr]$lParam)

      $ownerPid = 0
      [void][HMDao.Win32WindowTools]::GetWindowThreadProcessId($hWnd, [ref]$ownerPid)
      if ($ownerPid -ne $ProcessId) {
        return $true
      }

      $className = New-Object System.Text.StringBuilder 256
      [void][HMDao.Win32WindowTools]::GetClassName($hWnd, $className, $className.Capacity)
      if ($className.ToString() -ne 'UnrealWindow') {
        return $true
      }

      $title = New-Object System.Text.StringBuilder 512
      [void][HMDao.Win32WindowTools]::GetWindowText($hWnd, $title, $title.Capacity)

      $script:windowHandle = $hWnd
      $script:windowTitle = $title.ToString()
      $script:windowVisible = [HMDao.Win32WindowTools]::IsWindowVisible($hWnd)
      return $false
    }

    [void][HMDao.Win32WindowTools]::EnumWindows($callback, [IntPtr]::Zero)

    if ($script:windowHandle -ne [IntPtr]::Zero) {
      $restored = $false
      if (-not $script:windowVisible) {
        [void][HMDao.Win32WindowTools]::ShowWindowAsync($script:windowHandle, 9)
        Start-Sleep -Milliseconds 250
        [void][HMDao.Win32WindowTools]::ShowWindowAsync($script:windowHandle, 5)
        Start-Sleep -Milliseconds 250
        $script:windowVisible = [HMDao.Win32WindowTools]::IsWindowVisible($script:windowHandle)
        if ($script:windowVisible) {
          [void][HMDao.Win32WindowTools]::SetForegroundWindow($script:windowHandle)
          $restored = $true
        }
      }

      return [pscustomobject]@{
        Found = $true
        Visible = [bool]$script:windowVisible
        Restored = [bool]$restored
        WindowHandle = ('0x{0:X}' -f $script:windowHandle.ToInt64())
        WindowTitle = $script:windowTitle
      }
    }

    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)

  return [pscustomobject]@{
    Found = $false
    Visible = $false
    Restored = $false
    WindowHandle = $null
    WindowTitle = $null
  }
}

function Start-CleanUnrealEditor {
  param(
    [string]$ResolvedEngineRoot,
    [string]$ProjectFile,
    [bool]$RequestBridgeConnect,
    [bool]$DisableLiveCoding
  )

  $editorExecutable = Join-Path $ResolvedEngineRoot 'Engine\Binaries\Win64\UnrealEditor.exe'
  if (-not (Test-Path -LiteralPath $editorExecutable)) {
    throw "UnrealEditor.exe was not found: $editorExecutable"
  }

  $args = New-Object System.Collections.Generic.List[string]
  $args.Add($ProjectFile) | Out-Null
  $args.Add('-NoSplash') | Out-Null
  if ($DisableLiveCoding) {
    $args.Add('-NoLiveCoding') | Out-Null
  }
  # -HMDaoConnect is OPTIONAL. It only makes this script-launched editor auto-connect on
  # startup. Connections opened via Epic Launcher / shortcuts / double-click do NOT need it:
  # HMDao writes an on-demand request file when the user clicks Connect, and the plugin
  # (always running in bootstrap mode) consumes it. So passing -HMDaoConnect is a convenience,
  # not a requirement for the bridge to work.
  if ($RequestBridgeConnect) {
    $args.Add('-HMDaoConnect') | Out-Null
  }

  $process = Start-Process -FilePath $editorExecutable -ArgumentList $args.ToArray() -WorkingDirectory (Split-Path -Parent $editorExecutable) -PassThru
  $windowState = Ensure-VisibleUnrealEditorWindow -ProcessId ([int]$process.Id)
  return [pscustomobject]@{
    EditorExecutable = $editorExecutable
    Arguments = $args.ToArray()
    ProcessId = [int]$process.Id
    StartedAt = (Get-Date).ToString('s')
    Window = $windowState
  }
}
$projectFile = Resolve-UnrealProjectFile -RequestedPath $UProject
$projectDir = Split-Path -Parent $projectFile
$projectJson = Get-UnrealProjectJson -ProjectFile $projectFile
$resolvedEngineRoot = Resolve-UnrealEngineRoot -RequestedEngineRoot $EngineRoot -ProjectJson $projectJson
$engineVersion = Get-UnrealVersionInfo -ResolvedEngineRoot $resolvedEngineRoot
$pluginState = Get-ProjectPluginState -ProjectDir $projectDir -ResolvedEngineRoot $resolvedEngineRoot
$proxyNoise = Get-ProxyNoiseState -MajorMinor $engineVersion.MajorMinor
$cacheState = Get-CacheState -ProjectDir $projectDir
$hostHelper = Invoke-HostHelperSnapshot -HelperPath $hostHelperPath
$cleanupRemoved = @()
if ($CleanRuntimeResidue) {
  $cleanupRemoved = @(Remove-SafeRuntimeResidue -ProjectDir $projectDir)
}
$launchResult = $null
if ($LaunchEditor) {
  if ([string]::IsNullOrWhiteSpace($resolvedEngineRoot)) {
    throw 'Engine root could not be resolved. Pass -EngineRoot or use a project with a resolvable EngineAssociation.'
  }
  $launchResult = Start-CleanUnrealEditor -ResolvedEngineRoot $resolvedEngineRoot -ProjectFile $projectFile -RequestBridgeConnect:$HMDaoConnect -DisableLiveCoding:$NoLiveCoding
}

$recommendations = New-Object System.Collections.Generic.List[string]
if ($pluginState.DuplicateInstall) {
  $recommendations.Add('Run the engine-level installer/reinstall path once so the project-local HMDao plugin copy is moved out of scan paths.') | Out-Null
}
if ($proxyNoise.RecentTimeoutLines.Count -gt 0) {
  $recommendations.Add('Prefer direct UnrealEditor.exe launch for validation runs; Epic/Portal background HTTP checks are still visible in the per-version Unreal app log.') | Out-Null
}
if (-not $cacheState.ZenPortReady) {
  $recommendations.Add('Let Unreal launch directly once so Zen can come up on demand before reconnect validation; do not clear Common DDC unless it is provably corrupt.') | Out-Null
}
if ($NoLiveCoding) {
  $recommendations.Add('Launch is explicitly using -NoLiveCoding to trim a late editor-initialization stage without touching project config.') | Out-Null
} else {
  $recommendations.Add('For startup validation runs, add -NoLiveCoding to trim a late editor-initialization stage without touching project config.') | Out-Null
}
if ($CleanRuntimeResidue) {
  $recommendations.Add('Only transient logs and temp shader/XGE folders were cleaned; Common DDC and project DDC were preserved to avoid throwing away good cache state.') | Out-Null
}

$result = [pscustomobject]@{
  Timestamp = (Get-Date).ToString('s')
  ProjectFile = $projectFile
  ProjectDir = $projectDir
  EngineRoot = $resolvedEngineRoot
  EngineVersion = $engineVersion
  PluginState = $pluginState
  ProxyNoise = $proxyNoise
  CacheState = $cacheState
  HostPreparation = $hostHelper
  CleanupRemoved = $cleanupRemoved
  Launch = $launchResult
  Recommendations = $recommendations
}

if ($Json) {
  $result | ConvertTo-Json -Depth 8
  exit 0
}

Write-Output 'HMDao Unreal Host Preparation'
Write-Output ('=' * 42)
Write-Output "Project: $projectFile"
Write-Output "EngineRoot: $resolvedEngineRoot"
Write-Output "EngineVersion: $($engineVersion.Label)"
Write-Output ''
Write-Output '[Plugin]'
Write-Output "Engine install: $($pluginState.EngineInstalled)"
Write-Output "Engine path: $($pluginState.EnginePluginPath)"
Write-Output "Project install: $($pluginState.ProjectInstalled)"
Write-Output "Project path: $($pluginState.ProjectPluginPath)"
Write-Output "Duplicate install: $($pluginState.DuplicateInstall)"
Write-Output ''
Write-Output '[Cache]'
Write-Output "Common DDC: $($cacheState.CommonDdcExists) ($($cacheState.CommonDdcPath))"
Write-Output "Project DDC: $($cacheState.ProjectDdcExists) ($($cacheState.ProjectDdcPath))"
Write-Output "Zen port 8558: $($cacheState.ZenPortReady)"
Write-Output "Shader temp: $($cacheState.ShaderTempExists) ($($cacheState.ShaderTempPath))"
Write-Output ''
Write-Output '[Epic Noise]'
Write-Output "127.0.0.1:7897 reachable: $($proxyNoise.Local7897Reachable)"
Write-Output "Recent app-log proxy noise lines: $($proxyNoise.RecentTimeoutLines.Count)"
if ($proxyNoise.RecentTimeoutLines.Count -gt 0) {
  $proxyNoise.RecentTimeoutLines | Select-Object -Last 3 | ForEach-Object { Write-Output ("- " + $_) }
}
if ($cleanupRemoved.Count -gt 0) {
  Write-Output ''
  Write-Output '[Cleanup]'
  foreach ($item in $cleanupRemoved) {
    Write-Output ("- " + $item)
  }
}
if ($launchResult) {
  Write-Output ''
  Write-Output '[Launch]'
  Write-Output "PID: $($launchResult.ProcessId)"
  Write-Output ("Args: " + ($launchResult.Arguments -join ' '))
}
Write-Output ''
Write-Output '[Recommendations]'
if ($recommendations.Count -eq 0) {
  Write-Output '- No additional startup-prep recommendation was generated.'
} else {
  foreach ($item in $recommendations) {
    Write-Output ("- " + $item)
  }
}







