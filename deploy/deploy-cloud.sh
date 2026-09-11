#!/usr/bin/env bash
# =============================================================================
# Ddayup 后端一键云端部署（Linux · pm2 常驻 + 鉴权 Key + 输出扩展配置）
#
# 用法：
#   bash deploy-cloud.sh [--domain ddayup.example.com] [--key <API_KEY>]
#
# 示例：
#   bash deploy-cloud.sh --domain ddayup.example.com
#   bash deploy-cloud.sh --domain 1.2.3.4 --key "你的强随机Key"
#
# 完成的动作：
#   1. 生成/使用 HMDAO_API_KEY（保护 yt-dlp 安装接口，防匿名滥用）
#   2. 用 pm2 启动两个进程：
#        - ddayup-backend   (8792 API，仅监听 127.0.0.1)
#        - ddayup-web-proxy (3000 Web UI，仅监听 127.0.0.1，反代到 8792)
#      注意：8792/3000 均不暴露公网。公网仅经 deploy/Caddyfile(443) 反代进入。
#   3. 注册开机自启（pm2 startup + save；若已注册会提示，可忽略）
#   4. 提示启动 Caddy（443 → 3000），并输出「扩展 options / 打包注入」需填写的 https 地址
#
# 前置（HTTPS 必做）：
#   - 将域名 A 记录指向本机公网 IP。
#   - 安装 Caddy：curl -fsSL https://get.caddy.sh | bash，然后
#     caddy start --config deploy/Caddyfile --adapter caddyfile
#   - 防火墙只放行 443（与 80 用于 ACME 验证），不要放行 3000/8792。
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/app"
ECO="$ROOT/deploy/ecosystem.config.cjs"

DOMAIN=""
APIKEY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --key)    APIKEY="${2:-}"; shift 2 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

if [[ ! -d "$APP" ]]; then
  echo "未找到 $APP，请在仓库根目录运行。" >&2; exit 1
fi

# 1) 生成或确认 ApiKey
if [[ -z "$APIKEY" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    APIKEY="$(openssl rand -hex 32)"
  else
    APIKEY="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
fi

# 2) 确保 pm2 全局可用
if ! command -v pm2 >/dev/null 2>&1; then
  echo "未检测到 pm2，正在全局安装..."
  npm install -g pm2 --registry=https://registry.npmmirror.com
fi

# 3) 启动/重启 pm2（production env 含 0.0.0.0 + HMDAO_API_KEY）
export HMDAO_API_KEY="$APIKEY"
cd "$APP"
pm2 delete ddayup-backend ddayup-web-proxy 2>/dev/null || true
pm2 start "$ECO" --env production --update-env
pm2 save

# 4) 注册开机自启（已注册则忽略提示）
echo ""
echo "尝试注册 pm2 开机自启（如已注册会提示，可忽略）："
pm2 startup 2>/dev/null || true

# 5) 输出扩展配置
if [[ -n "$DOMAIN" ]]; then
  EXT_ADDR="https://$DOMAIN"
else
  EXT_ADDR="（未提供 --domain，请先配置 Caddy 域名后再填写 https://你的域名）"
fi

echo ""
echo "==================== 部署完成 ===================="
echo "后端进程: ddayup-backend(127.0.0.1:8792) + ddayup-web-proxy(127.0.0.1:3000)"
echo "公网入口: 仅 Caddy 443（deploy/Caddyfile）→ 反代到本机 3000 → 8792"
echo ""
echo "★ 下一步：启动 Caddy 提供 HTTPS（替换 example.com 为你的域名）"
echo "  caddy start --config deploy/Caddyfile --adapter caddyfile"
echo "  防火墙只需放行 443（和 80 用于证书验证）；切勿放行 3000/8792 到公网。"
echo ""
echo "★ 运维 API Key（请保存，扩展「选项」页填同一值才能自助安装 yt-dlp）:"
echo "  $APIKEY"
echo ""
echo "★ 扩展端需填写的云端 API 地址（必须是 https）："
echo "  $EXT_ADDR"
echo "  或通过打包注入（无需用户手填）：bash deploy/inject-cloud-domain.sh $EXT_ADDR"
echo "=================================================="
