param(
  [switch]$StopInterferers,
  [switch]$Json,
  [string]$BlenderExecutable = '',
  [int]$BlenderProbeTimeoutSeconds = 10
)

$ErrorActionPreference = 'Stop'

function Test-ProcessMatch {
  param(
    [object]$Process,
    [object]$Rule
  )

  $name = [string]$Process.Name
  $commandLine = [string]$Process.CommandLine
  if (-not $Rule.NamePattern.IsMatch($name)) {
    return $false
  }
  if ($Rule.CommandLinePattern -and -not $Rule.CommandLinePattern.IsMatch($commandLine)) {
    return $false
  }
  return $true
}

function Get-KnownStartupInterferers {
  $rules = @(
    @{
      Key = 'qqpc'
      Label = 'Tencent PC Manager / QQPC runtime'
      NamePattern = [regex]::new('^(?:QQPCTray|QQPCRTP|QQPCPatch|qmbsrv)(?:\.exe)?$', 'IgnoreCase')
      CommandLinePattern = $null
    },
    @{
      Key = 'nvidia-shadowplay'
      Label = 'NVIDIA ShadowPlay / In-Game Overlay'
      NamePattern = [regex]::new('^nvcontainer(?:\.exe)?$', 'IgnoreCase')
      CommandLinePattern = [regex]::new('\\NvContainer\\plugins\\SPUser\b', 'IgnoreCase')
    },
    @{
      Key = 'rtss'
      Label = 'RivaTuner Statistics Server'
      NamePattern = [regex]::new('^rtss(?:64)?(?:\.exe)?$', 'IgnoreCase')
      CommandLinePattern = $null
    },
    @{
      Key = 'afterburner'
      Label = 'MSI Afterburner'
      NamePattern = [regex]::new('^msiafterburner(?:\.exe)?$', 'IgnoreCase')
      CommandLinePattern = $null
    },
    @{
      Key = 'discord'
      Label = 'Discord overlay host'
      NamePattern = [regex]::new('^discord(?:\.exe)?$', 'IgnoreCase')
      CommandLinePattern = $null
    }
  )

  $processes = Get-CimInstance Win32_Process | Select-Object ProcessId, Name, CommandLine
  $matches = New-Object System.Collections.Generic.List[object]
  foreach ($process in $processes) {
    foreach ($rule in $rules) {
      if (-not (Test-ProcessMatch -Process $process -Rule $rule)) {
        continue
      }
      $matches.Add([pscustomobject]@{
        Key = $rule.Key
        Label = $rule.Label
        ProcessId = [int]$process.ProcessId
        Name = [string]$process.Name
        CommandLine = [string]$process.CommandLine
      })
      break
    }
  }
  return $matches
}

function Get-SecurityHardeningState {
  try {
    $deviceGuard = Get-CimInstance -Namespace 'root\Microsoft\Windows\DeviceGuard' -ClassName Win32_DeviceGuard |
      Select-Object VirtualizationBasedSecurityStatus, CodeIntegrityPolicyEnforcementStatus, UsermodeCodeIntegrityPolicyEnforcementStatus
    return [pscustomobject]@{
      Available = $true
      VbsStatus = [int]$deviceGuard.VirtualizationBasedSecurityStatus
      KernelCiStatus = [int]$deviceGuard.CodeIntegrityPolicyEnforcementStatus
      UserCiStatus = [int]$deviceGuard.UsermodeCodeIntegrityPolicyEnforcementStatus
    }
  } catch {
    return [pscustomobject]@{
      Available = $false
      VbsStatus = 0
      KernelCiStatus = 0
      UserCiStatus = 0
    }
  }
}

function Resolve-BlenderExecutablePath {
  param(
    [string]$RequestedPath
  )

  if (-not [string]::IsNullOrWhiteSpace($RequestedPath) -and (Test-Path -LiteralPath $RequestedPath)) {
    return $RequestedPath
  }

  $command = Get-Command blender.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command -and (Test-Path -LiteralPath $command.Source)) {
    return $command.Source
  }

  $candidates = @(
    'C:\Program Files\Blender Foundation\Blender\blender.exe',
    'C:\Program Files\Blender Foundation\Blender 4.5\blender.exe',
    'C:\Program Files\Blender Foundation\Blender 4.4\blender.exe',
    'C:\Program Files\Blender Foundation\Blender 4.3\blender.exe',
    'C:\Program Files\Blender Foundation\Blender 4.2\blender.exe',
    'C:\Program Files\Blender Foundation\Blender 4.1\blender.exe',
    'C:\Program Files\Blender Foundation\Blender 4.0\blender.exe',
    'C:\Program Files\Blender Foundation\Blender 3.6\blender.exe',
    'C:\Program Files\Blender Foundation\Blender 3.3\blender.exe'
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      return $candidate
    }
  }

  foreach ($root in @('E:\', 'D:\')) {
    if (-not (Test-Path -LiteralPath $root)) {
      continue
    }
    $rootExecutable = Join-Path $root 'blender.exe'
    if (Test-Path -LiteralPath $rootExecutable) {
      return $rootExecutable
    }
    $topLevelMatches = Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match 'blender' -or $_.FullName -match 'blender' }
    foreach ($directory in $topLevelMatches) {
      $directExecutable = Join-Path $directory.FullName 'blender.exe'
      if (Test-Path -LiteralPath $directExecutable) {
        return $directExecutable
      }
      $nestedExecutable = Get-ChildItem -LiteralPath $directory.FullName -Filter blender.exe -Recurse -Depth 2 -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty FullName
      if ($nestedExecutable) {
        return $nestedExecutable
      }
    }
    $firstLevelExecutables = Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      $candidate = Join-Path $_.FullName 'blender\blender.exe'
      if (Test-Path -LiteralPath $candidate) {
        $candidate
      }
    } | Select-Object -First 1
    if ($firstLevelExecutables) {
      return $firstLevelExecutables
    }
  }

  return $RequestedPath
}

function Invoke-BlenderVersionProbe {
  param(
    [string]$ExecutablePath,
    [int]$TimeoutSeconds
  )

  if ([string]::IsNullOrWhiteSpace($ExecutablePath) -or -not (Test-Path -LiteralPath $ExecutablePath)) {
    return [pscustomobject]@{
      ExecutablePath = $ExecutablePath
      Exists = $false
      Ok = $false
      Reason = 'Blender executable was not found.'
    }
  }

  $stdoutPath = Join-Path $env:TEMP 'hmdao_blender_probe.stdout.txt'
  $stderrPath = Join-Path $env:TEMP 'hmdao_blender_probe.stderr.txt'
  Remove-Item -LiteralPath $stdoutPath, $stderrPath -ErrorAction SilentlyContinue
  $process = Start-Process -FilePath $ExecutablePath `
    -ArgumentList '--version' `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru

  $exited = $null -ne (Wait-Process -Id $process.Id -Timeout $TimeoutSeconds -ErrorAction SilentlyContinue)
  if (-not $exited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    return [pscustomobject]@{
      ExecutablePath = $ExecutablePath
      Exists = $true
      Ok = $false
      Reason = "Blender did not complete a basic --version probe within ${TimeoutSeconds}s."
    }
  }

  $stdout = Get-Content -LiteralPath $stdoutPath -Raw -ErrorAction SilentlyContinue
  $stderr = Get-Content -LiteralPath $stderrPath -Raw -ErrorAction SilentlyContinue
  return [pscustomobject]@{
    ExecutablePath = $ExecutablePath
    Exists = $true
    Ok = $process.ExitCode -eq 0
    ExitCode = [int]$process.ExitCode
    Reason = if ($process.ExitCode -eq 0) { 'ok' } else { ($stderr.Trim(), $stdout.Trim() | Where-Object { $_ })[0] }
  }
}

function Stop-StartupInterferers {
  param(
    [object[]]$Matches
  )

  $stopped = New-Object System.Collections.Generic.List[object]
  foreach ($match in $Matches) {
    try {
      Stop-Process -Id $match.ProcessId -Force -ErrorAction Stop
      $stopped.Add([pscustomobject]@{
        Label = $match.Label
        ProcessId = $match.ProcessId
        Name = $match.Name
        Stopped = $true
      })
    } catch {
      $stopped.Add([pscustomobject]@{
        Label = $match.Label
        ProcessId = $match.ProcessId
        Name = $match.Name
        Stopped = $false
        Error = $_.Exception.Message
      })
    }
  }
  return $stopped
}

$interferers = @(Get-KnownStartupInterferers)
$security = Get-SecurityHardeningState
$resolvedBlenderExecutable = Resolve-BlenderExecutablePath -RequestedPath $BlenderExecutable
$blenderProbe = Invoke-BlenderVersionProbe -ExecutablePath $resolvedBlenderExecutable -TimeoutSeconds $BlenderProbeTimeoutSeconds
$stopped = @()
if ($StopInterferers -and $interferers.Count -gt 0) {
  $stopped = @(Stop-StartupInterferers -Matches $interferers)
}

$result = [pscustomobject]@{
  Timestamp = (Get-Date).ToString('s')
  Interferers = $interferers
  Security = $security
  BlenderProbe = $blenderProbe
  StopInterferersRequested = [bool]$StopInterferers
  StoppedInterferers = $stopped
  NextSteps = @(
    'For Unreal, close or uninstall QQPC / ShadowPlay overlays before retrying Connect.',
    'Whitelist UnrealEditor.exe and ShaderCompileWorker.exe in antivirus or security tools when VBS / KernelCI is enabled.',
    'For Blender, if --version cannot complete within the timeout, test a clean portable or LTS install before touching the HMDao add-on again.'
  )
}

if ($Json) {
  $result | ConvertTo-Json -Depth 6
  exit 0
}

Write-Output 'HMDao DCC Host Preparation'
Write-Output ('=' * 40)
Write-Output "Timestamp: $($result.Timestamp)"
Write-Output ''
Write-Output '[Interferers]'
if ($interferers.Count -eq 0) {
  Write-Output 'No known Unreal startup interferers detected.'
} else {
  foreach ($item in $interferers) {
    Write-Output "- $($item.Label): $($item.Name) (PID $($item.ProcessId))"
  }
}

if ($StopInterferers) {
  Write-Output ''
  Write-Output '[Stop results]'
  if ($stopped.Count -eq 0) {
    Write-Output 'No interferers were stopped.'
  } else {
    foreach ($item in $stopped) {
      if ($item.Stopped) {
        Write-Output "- Stopped $($item.Name) (PID $($item.ProcessId))"
      } else {
        Write-Output "- Failed to stop $($item.Name) (PID $($item.ProcessId)): $($item.Error)"
      }
    }
  }
}

Write-Output ''
Write-Output '[Security]'
if ($security.Available) {
  Write-Output "VBS: $($security.VbsStatus)"
  Write-Output "KernelCI: $($security.KernelCiStatus)"
  Write-Output "UserCI: $($security.UserCiStatus)"
} else {
  Write-Output 'DeviceGuard / VBS state unavailable.'
}

Write-Output ''
Write-Output '[Blender]'
Write-Output "Executable: $($blenderProbe.ExecutablePath)"
Write-Output "Probe: $($blenderProbe.Reason)"

Write-Output ''
Write-Output '[Next steps]'
foreach ($step in $result.NextSteps) {
  Write-Output "- $step"
}
