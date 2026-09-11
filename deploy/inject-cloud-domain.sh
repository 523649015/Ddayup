#!/usr/bin/env bash
# =============================================================================
# 扩展打包时「一行注入」云端域名 —— 让分发版默认连接云端，用户无需手填 options。
#
# 用法：
#   bash deploy/inject-cloud-domain.sh https://ddayup.example.com
#   bash deploy/inject-cloud-domain.sh https://1.2.3.4:3000
#   bash deploy/inject-cloud-domain.sh reset        # 恢复默认本机 127.0.0.1:3000
#
# 作用：把扩展配置默认地址从 http://127.0.0.1:3000 改为你的云端地址。
#   - extension/config-runtime.js 的 DEFAULT_API_BASE（唯一真源）
#   - extension/config.js 的回退字符串（全局未就绪时的兜底）
# 注入后正常打包扩展（含此 config）分发即可。
#
# 注意：仅改默认值；用户在 options 页手动填写的地址仍优先（存于 chrome.storage）。
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RT="$SCRIPT_DIR/../extension/config-runtime.js"
CFG="$SCRIPT_DIR/../extension/config.js"

DEFAULT_HOST='http://127.0.0.1:3000'

if [[ $# -lt 1 ]]; then
  echo "用法: bash $0 <云端地址 https://...> | reset" >&2; exit 1
fi

if [[ "$1" == "reset" ]]; then
  NEW="$DEFAULT_HOST"
else
  NEW="$1"
  if [[ ! "$NEW" =~ ^https?:// ]]; then
    echo "地址必须以 http:// 或 https:// 开头: $NEW" >&2; exit 1
  fi
fi

# 去掉结尾斜杠，保持与既有格式一致
NEW="${NEW%/}"

# config-runtime.js: 唯一真源 DEFAULT_API_BASE（第 5 行附近）
if [[ -f "$RT" ]]; then
  # 仅替换 DEFAULT_API_BASE 赋值行，不匹配其它引用
  sed -i -E "s#(const DEFAULT_API_BASE = )'[^']*';#\1'$NEW';#" "$RT"
  echo "已更新 $RT -> $NEW"
else
  echo "未找到 $RT" >&2; exit 1
fi

# config.js: 两处回退字符串（第 24、32 行 'http://127.0.0.1:3000'）
if [[ -f "$CFG" ]]; then
  sed -i -E "s#'http://127\.0\.0\.1:3000'#'$NEW'#g" "$CFG"
  echo "已更新 $CFG -> $NEW"
fi

echo ""
echo "注入完成。打包扩展前请确认："
echo "  grep DEFAULT_API_BASE $RT"
echo "重新打包扩展（chrome 加载已解压 / 上架商店）即可分发默认连云端的版本。"
