function Test-HMDaoContainsNonAscii {
  param([string]$Value)
  return [regex]::IsMatch([string]$Value, '[^\u0000-\u007F]')
}

function Test-HMDaoNeedsPathAlias {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) {
    return $false
  }
  $resolvedPath = [System.IO.Path]::GetFullPath($Path)
  return $resolvedPath.Contains(' ') -or (Test-HMDaoContainsNonAscii $resolvedPath)
}

function Get-HMDaoFreeSubstDrive {
  $used = @(Get-PSDrive -PSProvider FileSystem | ForEach-Object { $_.Name.ToUpperInvariant() })
  foreach ($candidate in @('Z', 'Y', 'X', 'W', 'V', 'U', 'T', 'S', 'R', 'Q', 'P')) {
    if ($used -notcontains $candidate) {
      return "${candidate}:"
    }
  }
  throw 'No free drive letter was available for a temporary Unreal path alias.'
}

function New-HMDaoTemporaryPathAlias {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [string]$Label = 'path'
  )

  $resolvedPath = if (Test-Path -LiteralPath $Path) {
    (Resolve-Path -LiteralPath $Path).Path
  } else {
    [System.IO.Path]::GetFullPath($Path)
  }

  $context = [pscustomobject]@{
    Label = $Label
    OriginalPath = $Path
    ResolvedPath = $resolvedPath.TrimEnd('\')
    AliasRoot = $resolvedPath.TrimEnd('\')
    Drive = ''
    UsedAlias = $false
  }

  if (-not (Test-HMDaoNeedsPathAlias $resolvedPath)) {
    return $context
  }

  $drive = Get-HMDaoFreeSubstDrive
  & cmd.exe /c "subst $drive `"$resolvedPath`""
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to create a temporary Unreal path alias for ${Label}: $resolvedPath"
  }

  $context.Drive = $drive
  $context.AliasRoot = $drive
  $context.UsedAlias = $true
  return $context
}

function Convert-HMDaoPathToAlias {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    $AliasContext
  )

  if ([string]::IsNullOrWhiteSpace($Path)) {
    return $Path
  }

  $resolvedPath = if (Test-Path -LiteralPath $Path) {
    (Resolve-Path -LiteralPath $Path).Path
  } else {
    [System.IO.Path]::GetFullPath($Path)
  }

  if (-not $AliasContext -or -not $AliasContext.UsedAlias) {
    return $resolvedPath
  }

  $resolvedRoot = [string]$AliasContext.ResolvedPath
  if ($resolvedPath.Equals($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    return [string]$AliasContext.AliasRoot
  }

  $rootPrefix = $resolvedRoot.TrimEnd('\') + '\'
  if ($resolvedPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    return ([string]$AliasContext.AliasRoot) + $resolvedPath.Substring($resolvedRoot.TrimEnd('\').Length)
  }

  return $resolvedPath
}

function Remove-HMDaoTemporaryPathAlias {
  param($AliasContext)

  if (-not $AliasContext -or -not $AliasContext.UsedAlias -or [string]::IsNullOrWhiteSpace($AliasContext.Drive)) {
    return
  }

  & cmd.exe /c "subst $($AliasContext.Drive) /d" | Out-Null
}

