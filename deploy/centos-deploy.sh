#!/usr/bin/env bash
# =============================================================================
# ⛔ DEPRECATED / 已弃用（2026-09-16）：本脚本面向【CentOS + pm2 + Caddy + /opt/ddayup】，
#    与线上真实架构不符。实际服务器是 Ubuntu + Nginx，仓库 /home/ubuntu/app，静态站 /var/www/hmdao。
#    用它部署会把仓库塞到不存在的 /opt/ddayup、用 pm2 启动后端，导致与现有手动 node 进程抢端口。
#    → 全量部署请用 deploy/ubuntu-deploy.sh；仅前端更新请用 deploy/deploy-dist.ps1。
#    详见 deploy/ENVIRONMENTS.md。
# =============================================================================
# Ddayup 生产环境一键部署脚本（CentOS / Rocky / AlmaLinux）
#
# 用法（必须用 root 执行）：
#   sudo bash deploy/centos-deploy.sh
#
# 前置条件：
#   1. 把本仓库上传到服务器 /opt/ddayup（例如 scp -r）
#   2. 域名 mingmingchuangyi.cn 的 A 记录已指向本机公网 IP
#   3. 腾讯云轻量服务器控制台防火墙已放行 TCP 80、443
#   4. ICP 备案已通过（本脚本不负责备案）
#
# 本脚本完成：
#   - 安装 Node.js v20、pm2、Caddy
#   - 放行 firewalld 80/443
#   - npm install + npm run build
#   - 生成 HMDAO_API_KEY
#   - 配置 Caddy（自动 HTTPS）并启动
#   - 用 pm2 启动 ddayup-backend(127.0.0.1:8792) + ddayup-web-proxy(127.0.0.1:3000)
# =============================================================================
set -euo pipefail

DOMAIN="mingmingchuangyi.cn"
APP_DIR="/opt/ddayup"
NODE_VER="v20.17.0"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

if [[ $EUID -ne 0 ]]; then
  log "请用 root 执行：sudo bash deploy/centos-deploy.sh"
  exit 1
fi

if [[ ! -d "$APP_DIR" ]]; then
  log "未找到 $APP_DIR，请先把项目上传到该目录（示例：scp -r 本地/HMDAODAO root@$服务器IP:/opt/ddayup）"
  exit 1
fi

log "===== Ddayup CentOS 部署开始 ====="
log "域名: $DOMAIN"
log "应用目录: $APP_DIR"

# -----------------------------------------------------------------------------
# 1) 基础工具
# -----------------------------------------------------------------------------
log "安装基础工具..."
yum install -y curl wget git vim xz yum-utils

# -----------------------------------------------------------------------------
# 2) Node.js v20（二进制方式，兼容 CentOS 7/8/Stream）
# -----------------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v)" != v20.* ]]; then
  log "安装 Node.js ${NODE_VER} ..."
  curl -fsSL "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-linux-x64.tar.xz" -o /tmp/node.tar.xz
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
  rm -f /tmp/node.tar.xz
fi
log "Node.js: $(node -v)"
log "npm: $(npm -v)"

# -----------------------------------------------------------------------------
# 3) pm2 全局安装
# -----------------------------------------------------------------------------
if ! command -v pm2 >/dev/null 2>&1; then
  log "安装 pm2..."
  npm install -g pm2 --registry=https://registry.npmmirror.com
fi

# -----------------------------------------------------------------------------
# 4) Caddy 安装
# -----------------------------------------------------------------------------
if ! command -v caddy >/dev/null 2>&1; then
  log "安装 Caddy..."
  yum-config-manager --add-repo https://dl.cloudsmith.io/public/caddy/stable/rpm.config
  yum install -y caddy
fi

# -----------------------------------------------------------------------------
# 5) firewalld 放行 80/443（若存在）
# -----------------------------------------------------------------------------
if command -v firewall-cmd >/dev/null 2>&1; then
  log "放行 firewalld 80/443..."
  firewall-cmd --permanent --add-service=http
  firewall-cmd --permanent --add-service=https
  firewall-cmd --reload
fi

# -----------------------------------------------------------------------------
# 6) 安装依赖 + 构建前端
# -----------------------------------------------------------------------------
cd "$APP_DIR/app"
log "npm install..."
npm install --registry=https://registry.npmmirror.com
log "npm run build..."
npm run build

# -----------------------------------------------------------------------------
# 7) 生成/复用 HMDAO_API_KEY
# -----------------------------------------------------------------------------
if [[ -f "$APP_DIR/.apikey" ]]; then
  APIKEY="$(cat "$APP_DIR/.apikey")"
else
  if command -v openssl >/dev/null 2>&1; then
    APIKEY="$(openssl rand -hex 32)"
  else
    APIKEY="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  echo "$APIKEY" > "$APP_DIR/.apikey"
fi
export HMDAO_API_KEY="$APIKEY"

# -----------------------------------------------------------------------------
# 8) Caddy 配置并启动
# -----------------------------------------------------------------------------
log "配置 Caddy..."
cp "$APP_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable caddy
systemctl restart caddy

# -----------------------------------------------------------------------------
# 9) pm2 启动后端（127.0.0.1:8792 + 127.0.0.1:3000，均不暴露公网）
# -----------------------------------------------------------------------------
log "启动 pm2 服务..."
cd "$APP_DIR/app"
pm2 delete ddayup-backend ddayup-web-proxy 2>/dev/null || true
pm2 start "$APP_DIR/deploy/ecosystem.config.cjs" --env production --update-env
pm2 save
pm2 startup | tail -n 1 | bash || true

# -----------------------------------------------------------------------------
# 10) 完成提示
# -----------------------------------------------------------------------------
log "===== 部署完成 ====="
echo ""
echo "公网入口: https://$DOMAIN"
echo "本地验证: curl -k https://127.0.0.1/api/health"
echo ""
echo "运维 API Key（扩展「选项」页填同一值才能自助安装 yt-dlp）："
echo "  $APIKEY"
echo ""
echo "Caddy 状态: systemctl status caddy"
echo "pm2 状态:   pm2 status"
echo "pm2 日志:   pm2 logs"
echo ""
echo "如外网仍打不开，请检查："
echo "  1. DNS: ping $DOMAIN 是否解析到 $(curl -s ip.sb 2>/dev/null || echo '本机公网IP')"
echo "  2. 腾讯云控制台轻量服务器防火墙是否放行 80、443"
echo "  3. 本机 firewalld 已放行（上面已执行）"
