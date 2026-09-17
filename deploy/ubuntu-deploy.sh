#!/usr/bin/env bash
# Ddayup / HMDAODAO 一键部署（Ubuntu + Nginx）
# 在服务器上执行：bash deploy/ubuntu-deploy.sh 你的邮箱@用于 certbot
set -euo pipefail

APP=/home/ubuntu/app
WWW=/var/www/hmdao
EMAIL="${1:-}"

echo "==> [1/6] 检查 Node 版本"
node -v
NODE_MAJOR=$(node -v | sed -E 's/v([0-9]+)\..*/\1/')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node < 20，安装 Node 20 ..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "==> [2/6] 安装依赖"
cd "$APP"
# 国内镜像：规避腾讯云服务器访问 GitHub 下载 sharp/libvips 二进制被中断
npm config set registry https://registry.npmmirror.com 2>/dev/null || true
export SHARP_LIBVIPS_BASE_URL=https://registry.npmmirror.com/-/binary/sharp-libvips
npm ci

echo "==> [3/6] 构建前端"
npm run build

echo "==> [3.1/6] 复制静态文件到 $WWW"
sudo mkdir -p "$WWW"
sudo rm -rf "$WWW"/*
sudo cp -r dist/. "$WWW"/

echo "==> [4/6] 重启后端 API（systemd）"
# ★2026-09-16：后端已迁移到 systemd 单元 ddayup-api.service（单进程、开机自启、崩溃自动拉起）。
#   历史遗留的 PM2（ubuntu 用户上下文）中的 ddayup-backend 已删除并 pm2 save，
#   pm2-ubuntu.service 已停用 —— 不要再用 pm2 start，否则会与 systemd 实例抢 8792 端口。
if systemctl list-unit-files | grep -q '^ddayup-api.service'; then
  systemctl restart ddayup-api
  sleep 3
else
  echo "未检测到 ddayup-api.service，请先安装："
  echo "  cp deploy/ddayup-api.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now ddayup-api"
  exit 1
fi
# 健康检查：确认 8792 真的起来了，避免"部署完才发现 API 挂了"
API_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:8792/api/health || echo "000")
echo "API health: $API_CODE"
if [ "$API_CODE" != "200" ]; then
  echo "警告：API 健康检查未返回 200，请执行 journalctl -u ddayup-api -n 50 排查"
fi

echo "==> [5/6] 部署 Nginx 配置"
sudo cp deploy/nginx-hmdao.conf /etc/nginx/sites-available/hmdao
sudo ln -sf /etc/nginx/sites-available/hmdao /etc/nginx/sites-enabled/hmdao
sudo nginx -t
sudo nginx -s reload

echo "==> [6/6] 申请 HTTPS 证书"
if [ -z "$EMAIL" ]; then
  echo "跳过 HTTPS：未提供邮箱。稍后执行 sudo certbot --nginx -d mingmingchuangyi.cn -d www.mingmingchuangyi.cn"
elif [ -f /etc/letsencrypt/live/mingmingchuangyi.cn/fullchain.pem ]; then
  echo "证书已存在，跳过"
else
  sudo apt-get install -y certbot python3-certbot-nginx
  sudo certbot --nginx -d mingmingchuangyi.cn -d www.mingmingchuangyi.cn \
    --non-interactive --agree-tos -m "$EMAIL" || \
    echo "HTTPS 申请失败，请确认 DNS 已解析到本机且防火墙放行 80/443 后重跑此步"
fi

echo "==> 完成。验证："
echo "    pm2 status"
echo "    curl -k http://127.0.0.1/api/health"
echo "    curl -I https://mingmingchuangyi.cn"
