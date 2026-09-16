<#
.SYNOPSIS
    [ENV: LOCAL -> CLOUD] 增量部署【后端代码 app/server】到线上服务器并重启 API（在本机执行，作用于服务器）。

.DESCRIPTION
    为什么需要它：deploy-dist.ps1 只更新前端静态产物；改了 app/server 必须把源码送上去并重启后端。
    真实架构（2026-09-16 实测，见 deploy/ENVIRONMENTS.md）：
      * 仓库 /home/ubuntu/app（不是 /opt/ddayup）
      * 后端由 systemd 服务 ddayup-api 托管，监听 8792；nginx 反代 /api/ 与 /ws/
      * 重启方式：systemctl restart ddayup-api
        （⛔ 禁止再用 pm2 / pkill+nohup 拉起，会与 systemd 抢 8792 端口）
    步骤：1) 打包 app/server → 2) scp → 3) 远端备份并覆盖 → 4) 重启服务 + 健康断言
          5) 可选 -VerifyRuntime：真实触发运行时安装，轮询 configured=true，并验证二进制可执行。

.PARAMETER Server   服务器地址（默认 43.139.15.112）
.PARAMETER User     SSH 用户（默认 root，需已配置免密）
.PARAMETER RepoDir  远端仓库目录（默认 /home/ubuntu/app）
.PARAMETER Service  后端 systemd 服务名（默认 ddayup-api）
.PARAMETER RuntimeKeys  要校验的运行时（空格分隔，默认 ytdlp；可传 "ytdlp aria2 ffmpeg"）
.PARAMETER VerifyRuntime  部署完成后执行运行时安装闭环验证（-VerifyYtDlp 为向后兼容别名）

.EXAMPLE
    powershell -File deploy/deploy-server.ps1
    powershell -File deploy/deploy-server.ps1 -VerifyRuntime
    powershell -File deploy/deploy-server.ps1 -VerifyRuntime -RuntimeKeys 'ytdlp aria2 ffmpeg'
#>
param(
    [string]$Server = '43.139.15.112',
    [string]$User = 'root',
    [string]$RepoDir = '/home/ubuntu/app',
    [string]$Service = 'ddayup-api',
    [string]$RuntimeKeys = 'ytdlp',
    [Alias('VerifyYtDlp')][switch]$VerifyRuntime
)

$ErrorActionPreference = 'Stop'
$LocalRoot = 'f:\Work\HMDAODAO'
$App = Join-Path $LocalRoot 'app'
$Log = Join-Path $LocalRoot '.deploy-server-log.txt'

function L($m) { $m | Tee-Object -Append -FilePath $Log; Write-Host $m }

L "=== deploy-server start $(Get-Date) ==="
if (-not (Test-Path (Join-Path $App 'server'))) { L "未找到 $App\server"; exit 1 }

# 1) 打包后端代码（排除 node_modules：Windows 的依赖在 Linux 上不可用）
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$tarName = "ddayup-server-$ts.tar.gz"
$tar = Join-Path $LocalRoot $tarName
L '打包 app/server ...'
Push-Location $App
tar -czf $tar --exclude=node_modules server
$tarOk = $LASTEXITCODE
Pop-Location
if ($tarOk -ne 0) { L '打包失败'; exit 1 }
L ("打包完成: {0} ({1} bytes)" -f $tarName, (Get-Item $tar).Length)

# 2) 上传
L '上传中...'
scp $tar "${User}@${Server}:/tmp/"
if ($LASTEXITCODE -ne 0) { L '上传失败（请确认 SSH 免密可用）'; exit 1 }

# 3) 远端：备份旧 server 目录 → 覆盖式合并（不清空，保留线上独有文件）
$backup = "$RepoDir/server.bak-$ts"
$remoteCmd = "set -e; cd /tmp; rm -rf dsrv; mkdir -p dsrv; tar -xzf $tarName -C dsrv; " +
             "cp -r $RepoDir/server $backup; " +
             "cp -rf dsrv/server/. $RepoDir/server/; " +
             "chown -R ubuntu:ubuntu $RepoDir/server >/dev/null 2>&1 || true; " +
             "echo SERVER_CODE_DEPLOYED"
L '远端覆盖后端代码...'
$out = ssh "${User}@${Server}" $remoteCmd 2>&1
L "远端输出: $out"
if ("$out" -notmatch 'SERVER_CODE_DEPLOYED') { L '远端覆盖失败，已中止（未重启服务）'; exit 1 }

# 4) 重启后端 + 健康断言
L "重启后端服务 $Service ..."
$pre = ssh "${User}@${Server}" "systemctl cat $Service >/dev/null 2>&1 && echo SERVICE_OK || echo SERVICE_MISSING" 2>&1
L "服务探测: $pre"
if ("$pre" -notmatch 'SERVICE_OK') {
    L "未找到 systemd 服务 $Service —— 请先确认线上服务名（deploy/ENVIRONMENTS.md），本步骤未执行重启。"
    exit 1
}
$restart = "systemctl restart $Service; sleep 3; curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8792/api/health"
$code = ssh "${User}@${Server}" $restart 2>&1
L "本机健康检查 HTTP: $code"
if ("$code" -notmatch '200') { L '后端健康检查未通过（未继续做 yt-dlp 验证）'; exit 1 }

# 4.1) 公网健康检查
try {
    $pub = Invoke-RestMethod -Uri 'https://mingmingchuangyi.cn/api/health' -TimeoutSec 25
    $pubYt = $pub.capabilities.localPostBackends.ytdlp
    L ("公网 health OK；ytdlp.configured={0}" -f $pubYt.configured)
} catch {
    L "公网 health 查询异常（不阻断部署）: $($_.Exception.Message)"
}

# 5) 运行时安装闭环验证（泛化：yt-dlp / aria2 / ffmpeg …）
if ($VerifyRuntime) {
    L ''
    L '--- 运行时闭环验证：上传并执行服务器端泛化校验脚本 ---'
    # 说明：JSON body 若经 PowerShell→ssh→bash 三层拼装，引号极易被吞掉（curl 会把 -H 的值
    # 当 URL 解析，报 "Could not resolve host: application"）。故改为上传 deploy/verify-runtime-install.sh
    # 由远端 bash 直接执行，彻底规避嵌套转义（该脚本已覆盖 yt-dlp，取代旧的专用版）。
    $verifySh = Join-Path $PSScriptRoot 'verify-runtime-install.sh'
    if (-not (Test-Path $verifySh)) { L "缺少校验脚本 $verifySh"; exit 1 }
    scp $verifySh "${User}@${Server}:/tmp/verify-runtime-install.sh"
    if ($LASTEXITCODE -ne 0) { L '校验脚本上传失败'; exit 1 }

    $vOut = ssh "${User}@${Server}" "bash /tmp/verify-runtime-install.sh $RuntimeKeys" 2>&1
    foreach ($line in ($vOut -split "`r?`n")) { if ("$line".Trim()) { L "  $line" } }

    if ("$vOut" -match 'RESULT=PASS') {
        L '✅ 闭环验证通过：configured=true 且二进制可执行'
    } else {
        L '❌ 闭环验证未通过（详见上方服务器输出）'
        L '   常见原因：服务器无法访问 GitHub Releases（境内网络）→ 需镜像/离线兜底，'
        L '   或手工放置二进制到托管目录后设置 HMDAO_YT_DLP_PATH（见 deploy/ENVIRONMENTS.md）'
        exit 1
    }
}

L "=== end $(Get-Date) ==="
L "后端备份位于服务器 $backup"
