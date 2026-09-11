<#
.SYNOPSIS
  Ddayup 后端一键云端部署（pm2 常驻 + 鉴权 Key + 输出扩展配置）。

.DESCRIPTION
  1. 生成/使用 HMDAO_API_KEY（运维 Key，保护 yt-dlp 安装接口）
  2. 用 pm2 启动 hmdao-api.mjs（单进程同时占 8792 API + 3000 Web UI）
  3. 注册开机自启（pm2 startup + save）
  4. 输出「扩展 options 需填写的云端地址」——一键替换 3000 链接即开即用

.PARAMETER Domain
  你的云端域名或公网 IP。若用 Nginx/Caddy 反代 443，则扩展填 https://域名；
  若直接暴露端口，则填 http://域名:3000。

.PARAMETER ApiKey
  可选。不传则自动生成一个 32 字节随机 Key（请妥善保存）。

.EXAMPLE
  .\deploy-cloud.ps1 -Domain ddayup.example.com
  .\deploy-cloud.ps1 -Domain 1.2.3.4 -ApiKey "你的强随机Key"
#>
param(
  [string]$Domain = '',
  [string]$ApiKey = ''
)

$ErrorActionPreference = 'Stop'
$ROOT = Split-Path -Parent $PSScriptRoot
$APP = Join-Path $ROOT 'app'
$ECO = Join-Path $PSScriptRoot 'ecosystem.config.cjs'

if (-not (Test-Path $APP)) { Write-Error "未找到 $APP，请在仓库根目录运行。"; exit 1 }

# 1) 生成或确认 ApiKey
if (-not $ApiKey) {
  try { $ApiKey = (openssl rand -hex 32 2>$null) }
  catch { $ApiKey = '' }
  if (-not $ApiKey) {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $ApiKey = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
  }
}

# 2) 确保 pm2 全局可用
$pm2 = Get-Command pm2 -ErrorAction SilentlyContinue
if (-not $pm2) {
  Write-Host '未检测到 pm2，正在全局安装...'
  npm install -g pm2 --registry=https://registry.npmmirror.com
}

# 3) 启动/重启 pm2（production env 含 HMDAO_API_HOST=0.0.0.0 + HMDAO_API_KEY）
$env:HMDAO_API_KEY = $ApiKey
Set-Location $APP
pm2 delete ddayup-backend 2>$null
pm2 start $ECO --env production --update-env
pm2 save

# 4) 注册开机自启（若 pm2 startup 已完成会提示已存在，忽略即可）
Write-Host "`n尝试注册 pm2 开机自启（如已注册会提示，可忽略）："
pm2 startup 2>$null

# 5) 输出扩展配置
$extAddr = if ($Domain) {
  # 推荐用反代 443；否则退回直接端口
  "https://$Domain"
} else {
  '（未提供 -Domain，请在扩展「选项」填写 http://<你的公网IP>:3000）'
}

Write-Host ''
Write-Host '==================== 部署完成 ===================='
Write-Host "后端进程: ddayup-backend (pm2, 已设 autorestart)"
Write-Host "监听: 0.0.0.0:8792 (API) + 0.0.0.0:3000 (Web UI)"
Write-Host ''
Write-Host "★ 运维 API Key（请保存，扩展「选项」页需填同一值才能自助安装 yt-dlp）:"
Write-Host "  $ApiKey"
Write-Host ''
Write-Host "★ 扩展端「选项」页需填写的云端 API 地址（替换原 127.0.0.1:3000）:"
Write-Host "  $extAddr"
Write-Host ''
Write-Host "★ 云端安全组/防火墙需放行 3000（或你的 443 反代）与 8792。"
Write-Host '=================================================='
