#!/usr/bin/env bash
# 在【服务器本机】执行：探测可用的 GitHub 加速镜像前缀，结果用于配置 HMDAO_GITHUB_MIRROR。
# 背景：线上直连 github.com 经常超时/被重置，导致 aria2 / ffmpeg 等大体积运行时下载失败。
# 用法：bash probe-github-mirrors.sh
set -u

# 用一个小资产做探针（只取前 1KB，快速判断连通性与速度）
ASSET='https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp_linux.zip'
CANDS='https://gh-proxy.com/ https://ghfast.top/ https://ghproxy.net/ https://gh.llkk.cc/ https://github.moeyy.xyz/ https://ghproxy.cc/ https://gh.ddlc.top/'

echo '直连对照（预期：超时或 000）：'
direct=$(curl -s -o /dev/null -w '%{http_code} bytes=%{size_download} speed=%{speed_download}B/s' --max-time 12 -r 0-1023 "$ASSET" 2>/dev/null || echo '000')
echo "  direct -> $direct"

echo
echo '镜像候选（期望 http=200/206 且 bytes>0）：'
for prefix in $CANDS; do
  url="${prefix%/}/$ASSET"
  result=$(curl -s -o /dev/null -w '%{http_code} bytes=%{size_download} speed=%{speed_download}B/s' --max-time 15 -r 0-1023 "$url" 2>/dev/null || echo '000')
  echo "  $prefix -> $result"
done
