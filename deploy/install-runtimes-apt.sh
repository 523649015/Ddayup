#!/usr/bin/env bash
# 在【服务器本机】执行：用系统包管理器安装 aria2 / ffmpeg（境内系统源，快且稳）。
#
# 适用场景（本项目实测）：GitHub 直连被重置（http=000），镜像虽可用但 100MB 级资产过慢，
# 于是把 apt 作为「一键安装」的兜底路径。产物落在 /usr/bin，
# 由 app/server 的 PATH 回退探测（local-post-processing.mjs 的 findInSystemPath）识别。
#
# 用法：bash install-runtimes-apt.sh
set -u

apt-get update -qq || true
apt-get install -y -qq aria2 ffmpeg

echo '--- 探测结果 ---'
aria2_path=$(command -v aria2c || true)
ffmpeg_path=$(command -v ffmpeg || true)
echo "aria2c -> ${aria2_path:-未找到}"
[ -n "$aria2_path" ] && "$aria2_path" --version 2>&1 | head -1
echo "ffmpeg -> ${ffmpeg_path:-未找到}"
[ -n "$ffmpeg_path" ] && "$ffmpeg_path" -version 2>&1 | head -1

echo '--- 后端是否已识别（PATH 回退）---'
curl -s --max-time 15 http://127.0.0.1:8792/api/health \
  | python3 -c "import json,sys;d=json.load(sys.stdin)['capabilities']['localPostBackends'];[print(k,'configured=',(d.get(k) or {}).get('configured'),(d.get(k) or {}).get('detectedPath')) for k in ('aria2','ffmpeg')]"
