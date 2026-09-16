<#
.SYNOPSIS
    [ENV: LOCAL -> CLOUD] 增量部署前端产物到线上服务器（在本机执行，作用于服务器）。

.DESCRIPTION
    真实架构（2026-09-16 实测确认，勿再按旧假设修改）：
      * 静态站点：nginx，server_name mingmingchuangyi.cn，root = /var/www/hmdao
      * 后端 API ：由 ubuntu 用户手动运行的 node /home/ubuntu/app/server/hmdao-api.mjs
                   （监听 8792；nginx 将 /api/ 与 /ws/ 反代到 127.0.0.1:8792）
      * 仓库位置：/home/ubuntu/app（注意不是 /opt/ddayup）
      * 后端由 **systemd 服务 ddayup-api** 托管（2026-09-16 迁移完成）。
        重启用 `systemctl restart ddayup-api`；旧脚本里的 pm2 / pkill+nohup 都是错的（会与 systemd 抢 8792）。
      * /opt 是空目录，/opt/ddayup 从未存在。

    本脚本只更新【前端静态产物】，步骤：
      1. 本地 npm run build（可 -SkipBuild 跳过）
      2. 打包 app/dist + 改动的前端源码
      3. scp 上传 → 服务器备份旧站点 → 覆盖式合并（不清空，保留线上独有目录如 verification/）
      4. 公网验证

    只改前端时用它；改了 app/server 需另外重启 API（用 -RestartApi，或手动）。

.PARAMETER Server   服务器（默认 43.139.15.112）
.PARAMETER User     SSH 用户（默认 root）
.PARAMETER StaticDir 静态站点目录（默认 /var/www/hmdao）
.PARAMETER RepoDir  远端仓库目录（默认 /home/ubuntu/app）
.PARAMETER SkipBuild 跳过本地构建，直接上传现有 dist
.PARAMETER RestartApi 同时重启后端 node API（仅改后端时才需要）

.EXAMPLE
    powershell -File deploy/deploy-dist.ps1
    powershell -File deploy/deploy-dist.ps1 -SkipBuild
#>
param(
    [string]$Server = '43.139.15.112',
    [string]$User = 'root',
    [string]$StaticDir = '/var/www/hmdao',
    [string]$RepoDir = '/home/ubuntu/app',
    [switch]$SkipBuild,
    [switch]$RestartApi
)

$ErrorActionPreference = 'Stop'
$LocalRoot = 'f:\Work\HMDAODAO'
$App = Join-Path $LocalRoot 'app'
$Log = Join-Path $LocalRoot '.deploy-dist-log.txt'

function L($m) { $m | Tee-Object -Append -FilePath $Log; Write-Host $m }

L "=== deploy-dist start $(Get-Date) ==="
if (-not (Test-Path $App)) { L "未找到 $App"; exit 1 }

# 1) 本地构建
if (-not $SkipBuild) {
    L '本地构建中（npm run build）...'
    Push-Location $App
    npm run build
    $buildOk = $LASTEXITCODE
    Pop-Location
    if ($buildOk -ne 0) { L '构建失败'; exit 1 }
    L '构建完成'
}
if (-not (Test-Path (Join-Path $App 'dist'))) { L 'dist 不存在'; exit 1 }

# 2) 打包（dist + 相关源码，保持远端仓库源码同步）
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$tarName = "ddayup-dist-$ts.tar.gz"
$tar = Join-Path $LocalRoot $tarName
L '打包 dist 与相关源码...'
Push-Location $App
tar -czf $tar dist src/config/environment.ts src/config/extensionStore.ts src/hooks/useExtensionPlans.ts src/components/ModelDownloadPanel.tsx src/components/AssetLibrary.tsx src/pages/LandingHome.tsx src/pages/ServicesPage.tsx
$tarOk = $LASTEXITCODE
Pop-Location
if ($tarOk -ne 0) { L '打包失败'; exit 1 }
L ("打包完成: {0} ({1} bytes)" -f $tarName, (Get-Item $tar).Length)

# 3) 上传
L '上传中...'
scp $tar "${User}@${Server}:/tmp/"
if ($LASTEXITCODE -ne 0) { L '上传失败（请确认 SSH 免密）'; exit 1 }

# 4) 远端：备份 + 覆盖式合并（不清空，保留 verification/ 等线上独有目录）
$backup = "$StaticDir.bak-$ts"
$remoteCmd = "set -e; cd /tmp; rm -rf ddist; mkdir -p ddist; tar -xzf $tarName -C ddist; " +
             "cp -r $StaticDir $backup; " +
             "cp -rf ddist/dist/. $StaticDir/; " +
             "cp -rf ddist/src/. $RepoDir/src/; " +
             "echo STATIC_DEPLOYED"
L '远端替换静态站点...'
$out = ssh "${User}@${Server}" $remoteCmd 2>&1
L "远端输出: $out"

# 5) 可选：重启后端 API（仅改后端时需要；无 pm2，用 nohup 以 ubuntu 身份拉起）
if ($RestartApi) {
    L '重启后端 API...'
    # ★2026-09-16 修复：原实现用 pkill + nohup 手工拉起后端，会与 systemd 服务 ddayup-api
    #   抢 8792 端口（表现为启动失败/反复重启）。线上已迁移到 systemd，改用服务重启。
    $apiCmd = "systemctl restart ddayup-api; sleep 3; curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8792/api/health"
    $o2 = ssh "${User}@${Server}" $apiCmd 2>&1
    L "API: $o2"
} else {
    L '未重启后端（-RestartApi 未指定）；仅前端更新无需重启。'
}

# 6) 公网验证
L '公网验证 https://mingmingchuangyi.cn ...'
try {
    $r = Invoke-WebRequest -Uri 'https://mingmingchuangyi.cn/' -UseBasicParsing -TimeoutSec 20
    L "公网 HTTP: $($r.StatusCode)"
} catch { L "公网访问异常: $_" }

L "=== end $(Get-Date) ==="
L "完成。备份在服务器 $backup ；请硬刷新（Ctrl+Shift+R）验证。"
