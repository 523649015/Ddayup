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
npm ci

echo "==> [3/6] 构建前端"
npm run build

echo "==> [3.1/6] 复制静态文件到 $WWW"
sudo mkdir -p "$WWW"
sudo rm -rf "$WWW"/*
sudo cp -r dist/. "$WWW"/

echo "==> [4/6] 停掉旧的演示服务，启动正式后端"
pm2 stop pay-api 2>/dev/null || true
pm2 restart ddayup-backend \
  || pm2 start deploy/ecosystem.config.cjs --only ddayup-backend --env production
pm2 save

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
