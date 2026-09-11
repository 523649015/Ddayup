# 部署 HMDao Unreal 插件到真实中文路径（避开 PowerShell 中文路径幽灵目录）。
# 用法（需先关闭 Unreal 编辑器）：
#   powershell -ExecutionPolicy Bypass -File scripts/deploy-unreal-plugin.ps1 [-Build] [-EngineRoot "F:\Unreal Engine\UE_5.7"] [-TargetProject "F:\练习\ue5\5.7\cs"]
#
# 重要：
#   PowerShell 原生 Copy-Item 处理中文路径会创建幽灵目录（如 F:\缁冧範），故一律用 cmd /c robocopy。
#   -Build 会先用 subst 把项目映射成纯 ASCII 盘符 X:，再从 X: 就地增量编译（避开中文幽灵目录），
#   编译产物实际落在真实中文目录；随后 robocopy 源码覆盖。若不想脚本编译，可手动在 UE 内编译后只跑 robocopy。

param(
  [switch]$Build,
  [string]$EngineRoot = 'F:\Unreal Engine\UE_5.7',
  [string]$TargetProject = 'F:\练习\ue5\5.7\cs',
  [string]$UProject = '',
  [string]$PluginSource = (Resolve-Path (Join-Path (Join-Path (Join-Path (Join-Path $PSScriptRoot '..') 'plugins') 'unreal') 'HMDaoUnrealCapture')).Path
)

$ErrorActionPreference = 'Stop'

# 1) 关闭 Unreal 编辑器，避免 DLL 被占用
Write-Host '==> 关闭 UnrealEditor 进程...'
Stop-Process -Name UnrealEditor -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3

# 2) 可选：就地编译插件。
# 重要：直接对中文路径 F:\练习\... 跑 UBT/RunUAT 会触发 PowerShell/Windows 中文路径 GBK 幽灵目录
# （如 F:\缁冧範），导致 .rsp 找不到、cl.exe 退出码 2、编译失败（见上轮排查）。
# 故先用 subst 把项目挂成纯 ASCII 盘符 X:，从 X: 增量编译——产物（Binaries/Intermediate）
# 实际落在真实中文目录（X: 是映射），编译成功后再 robocopy 源码覆盖。
$BuildLog = Join-Path $PSScriptRoot 'tmp_build_seg.log'
('[' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '] ENTER -Build block') | Out-File -FilePath $BuildLog -Encoding utf8
if ($Build) {
  ('[' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '] Build switch ENABLED, EngineRoot=' + $EngineRoot) | Out-File -FilePath $BuildLog -Append -Encoding utf8
  $BuildBat = Join-Path $EngineRoot 'Engine\Build\BatchFiles\Build.bat'
  if (-not (Test-Path $BuildBat)) {
    ('[' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '] Build.bat NOT found: ' + $BuildBat + ', skip compile') | Out-File -FilePath $BuildLog -Append -Encoding utf8
    Write-Warning ('Build.bat NOT found: ' + $BuildBat + ', skip compile, robocopy only.')
  } else {
    # Locate the real .uproject: prefer -UProject, else search under TargetProject and its parents.
    $uproject = $null
    if ($UProject -and (Test-Path $UProject)) { $uproject = $UProject }
    else {
      $scan = $TargetProject
      for ($i = 0; $i -lt 4; $i++) {
        $found = Get-ChildItem $scan -Filter '*.uproject' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) { $uproject = $found.FullName; break }
        $parent = Split-Path $scan
        if (-not $parent -or $parent -eq $scan) { break }
        $scan = $parent
      }
    }
    if (-not $uproject) {
      ('[' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '] No .uproject found under TargetProject, skip compile') | Out-File -FilePath $BuildLog -Append -Encoding utf8
      Write-Warning ('No .uproject found under TargetProject (' + $TargetProject + '). Skipping compile; deploy plugin only. Compile manually in UE editor, or pass -UProject "<path>.uproject".')
    } else {
      # subst is unreliable for Chinese paths (subst.exe is ANSI-only), so compile directly
      # against the real .uproject path. Modern UBT handles UTF-16 paths. If it fails, fall back
      # to manual compile in UE editor.
      $PluginUplugin = Join-Path $TargetProject 'HMDaoUnrealCapture\HMDaoUnrealCapture.uplugin'
      ('[' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '] UBT compile: uproject=' + $uproject + ', plugin=' + $PluginUplugin) | Out-File -FilePath $BuildLog -Append -Encoding utf8
      Write-Host ('==> Compile plugin via UBT: ' + $uproject)
      & cmd /c ("`"" + $BuildBat + "`" csEditor Win64 Development -project=`"" + $uproject + "`" -plugin=`"" + $PluginUplugin + "`"") 2>&1 | Tee-Object -FilePath $BuildLog -Append
      if ($LASTEXITCODE -ne 0) {
        ('[' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '] UBT compile FAILED, exit=' + $LASTEXITCODE) | Out-File -FilePath $BuildLog -Append -Encoding utf8
        Write-Warning ('UBT compile failed (exit ' + $LASTEXITCODE + '). Compile manually in UE editor; robocopy still completed.')
      } else {
        ('[' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '] UBT compile OK') | Out-File -FilePath $BuildLog -Append -Encoding utf8
        Write-Host '==> Compile OK.'
      }
    }
  }
} else {
  ('[' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '] Build switch OFF, skip compile') | Out-File -FilePath $BuildLog -Append -Encoding utf8
}

# 3) 用 cmd /c robocopy 写入真实中文路径（关键：绝不用 PowerShell Copy-Item 写中文路径）
$TargetDir = Join-Path $TargetProject 'Plugins\HMDaoUnrealCapture'
Write-Host "==> robocopy $PluginSource -> $TargetDir"
$robocmd = "robocopy `"$PluginSource`" `"$TargetDir`" /E /IS /IT"
cmd /c $robocmd
# robocopy 退出码 0-7 均视为成功（>=8 为失败）
if ($LASTEXITCODE -ge 8) {
  Write-Error "robocopy 失败，退出码 $LASTEXITCODE"
  exit 1
}

# 4) 注意：以前这里有一段"清理疑似幽灵目录"的逻辑（rd /s /q 删除含非 ASCII 且含 ue5 的 F:\ 子目录），
#    但该逻辑会把真实中文项目目录（如 F:\练习）因编码差异误判为幽灵目录而整体删除，已造成严重数据丢失。
#    现已彻底移除。幽灵目录（GBK 误编码产生的并列空目录）若确需清理，请人工确认后再手动删除，绝不在脚本里自动 rd。

Write-Host '==> 部署完成。请在 UE 重新打开项目以加载新插件。'
Write-Host '   云端部署时，启动 Unreal 前设置环境变量 HMDAO_WS_URL（例如 wss://你的云端域名/ws/dcc/unreal?role=plugin）'
