#!/usr/bin/env bash
# 在【服务器本机】执行：配置 HMDAO_GITHUB_MIRROR（GitHub 加速镜像）并重启后端。
#
# 背景：线上直连 github.com 实测被重置（http=000），导致 aria2 / ffmpeg 等大体积运行时安装失败。
#       app/server/runtime-download.mjs 已内置 buildMirrorCandidates()，读取该环境变量做多镜像回退，
#       只是线上一直没配。本脚本把实测可用的前缀写入 .env（幂等：已存在则替换）。
#
# 用法：bash set-github-mirror.sh [镜像前缀列表]
set -u

ENV_FILE=/home/ubuntu/app/.env
MIRRORS="${1:-https://gh-proxy.com/,https://ghproxy.net/,https://ghfast.top/}"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: 未找到 $ENV_FILE"
  exit 1
fi

if grep -q '^HMDAO_GITHUB_MIRROR=' "$ENV_FILE"; then
  sed -i "s#^HMDAO_GITHUB_MIRROR=.*#HMDAO_GITHUB_MIRROR=${MIRRORS}#" "$ENV_FILE"
  echo "已更新 HMDAO_GITHUB_MIRROR"
else
  printf '\n# GitHub 加速镜像（多个用逗号分隔，按顺序回退）——2026-09-16 实测直连被重置后添加\nHMDAO_GITHUB_MIRROR=%s\n' "$MIRRORS" >> "$ENV_FILE"
  echo "已追加 HMDAO_GITHUB_MIRROR"
fi

chown ubuntu:ubuntu "$ENV_FILE" 2>/dev/null || true
echo "当前 HMDAO_GITHUB_MIRROR 条数: $(grep -c '^HMDAO_GITHUB_MIRROR=' "$ENV_FILE")"

systemctl restart ddayup-api
sleep 5
echo -n '本机健康检查: '
curl -s -o /dev/null -w 'http=%{http_code}\n' http://127.0.0.1:8792/api/health

echo '（后端启动时会自行 load-env 读取 .env；若镜像生效，安装日志中的下载地址将带镜像前缀）'
