#!/usr/bin/env bash
# Ddayup 原生主机安装器（macOS / Linux）
# 作用：将 com.ddayup.host 注册到 Chrome/Chromium 的 NativeMessagingHosts 目录。
# 边界：仅写本地 manifest JSON + 用户配置目录，不联网、不修改浏览器。
#
# 用法：
#   ./install-host.sh <EXTENSION_ID> [chrome|chromium|edge|all]
#
# 说明：
#   - EXTENSION_ID 在 chrome://extensions 开启「开发者模式」后可见。
#   - 本脚本用于 macOS / Linux。该平台没有提供 pkg 打包的 exe，
#     本机需已安装 Node.js（用于运行 ddayup-host.js）。
#     Windows 用户请使用 install-host.ps1（支持 ddayup-host.exe 免 Node）。

set -euo pipefail

EXTENSION_ID="${1:-}"
BROWSER="${2:-all}"

if [[ -z "$EXTENSION_ID" ]]; then
  echo "用法: $0 <EXTENSION_ID> [chrome|chromium|edge|all]" >&2
  exit 1
fi
if ! [[ "$EXTENSION_ID" =~ ^[a-p]{32}$ ]]; then
  echo "扩展 ID 格式错误：必须是 32 位小写字母（a-p）。" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_JS="$SCRIPT_DIR/ddayup-host.js"
MANIFEST_SRC="$SCRIPT_DIR/com.ddayup.host.json"
[[ -f "$HOST_JS" ]] || { echo "缺失 ddayup-host.js：$HOST_JS" >&2; exit 1; }
[[ -f "$MANIFEST_SRC" ]] || { echo "缺失 com.ddayup.host.json" >&2; exit 1; }

# 非 Windows 平台仅 js 路径：必须依赖本机 Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js。macOS/Linux 平台需安装 Node.js（https://nodejs.org）以运行 ddayup-host.js。" >&2
  exit 1
fi
echo "[OK] 检测到 node: $(command -v node)"

MANIFEST_OUT="$SCRIPT_DIR/com.ddayup.host.installed.json"
# 用 node 做 JSON 改写，避免 awk/sed 转义问题
node -e "
const fs=require('fs');
const o=JSON.parse(fs.readFileSync('$MANIFEST_SRC','utf8'));
o.allowed_origins=['chrome-extension://$EXTENSION_ID/'];
o.path='$HOST_JS';
fs.writeFileSync('$MANIFEST_OUT', JSON.stringify(o));
"
echo "[OK] 已生成主机 manifest: $MANIFEST_OUT"

install_to() {
  local dir="$1"
  mkdir -p "$dir"
  cp "$MANIFEST_OUT" "$dir/com.ddayup.host.json"
  echo "[OK] 注册: $dir/com.ddayup.host.json"
}

case "$BROWSER" in
  chrome)   install_to "$HOME/.config/google-chrome/NativeMessagingHosts" ;;
  chromium) install_to "$HOME/.config/chromium/NativeMessagingHosts" ;;
  edge)     install_to "$HOME/.config/microsoft-edge/NativeMessagingHosts" ;;
  all)
    install_to "$HOME/.config/google-chrome/NativeMessagingHosts"
    install_to "$HOME/.config/chromium/NativeMessagingHosts"
    install_to "$HOME/.config/microsoft-edge/NativeMessagingHosts"
    ;;
esac

echo ""
echo "安装完成。重新加载扩展后，侧栏即可通过原生主机使用本机 yt-dlp。"
echo "卸载：删除对应的 NativeMessagingHosts/com.ddayup.host.json 文件。"
