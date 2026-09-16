#!/usr/bin/env bash
# 在【服务器本机】执行：泛化的「运行时安装」闭环校验（幂等）。
#
# 覆盖设计：yt-dlp / aria2 / ffmpeg / florence2 / oiio / gmic / ocio 共用同一套逻辑，
# 取代原先只服务 yt-dlp 的专用脚本（避免同一功能两份实现）。
#
# 用法：
#   bash verify-runtime-install.sh                # 默认校验 ytdlp
#   bash verify-runtime-install.sh aria2 ffmpeg   # 校验多个
#   MAX_WAIT_SEC=900 bash verify-runtime-install.sh ffmpeg
#
# 幂等：已 configured=true 时【不再触发安装】——安装失败可能触发回滚/prune，反而破坏当前可用状态。
set -u

SERVICE=ddayup-api
API=http://127.0.0.1:8792
PY=$(command -v python3)
TARGETS="${*:-ytdlp}"
MAX_WAIT_SEC="${MAX_WAIT_SEC:-600}"

if [ -z "$PY" ]; then echo 'ERROR: 需要 python3 解析 health JSON'; exit 1; fi

# 运维 API Key 只在服务器本机读取使用；此处只报"是否存在"，绝不打印值
KEY=$(systemctl show "$SERVICE" -p Environment | tr ' ' '\n' | sed -n 's/^HMDAO_API_KEY=//p' | head -1)
if [ -n "$KEY" ]; then echo 'api_key: present'; else echo 'api_key: absent（本机回环放行，无需 Key）'; fi
echo "github_mirror_set: $(grep -c '^HMDAO_GITHUB_MIRROR=' /home/ubuntu/app/.env 2>/dev/null || echo 0)"

read_field() { # $1=runtimeKey $2=field
  curl -s --max-time 15 "$API/api/health" \
    | "$PY" -c "import json,sys;d=json.load(sys.stdin);print((d['capabilities']['localPostBackends'].get('$1') or {}).get('$2',''))"
}

version_of() { # $1=runtimeKey $2=path
  case "$1" in
    ytdlp)  "$2" --version 2>&1 | head -1 ;;
    aria2)  "$2" --version 2>&1 | head -1 ;;
    ffmpeg) "$2" -version 2>&1 | head -1 ;;
    *)      echo '(该运行时无标准版本命令，跳过)' ;;
  esac
}

FAIL=0
for rt in $TARGETS; do
  echo "=== [$rt] ==="
  CONF=$(read_field "$rt" configured)
  if [ "$CONF" = 'True' ]; then
    echo '已就绪，跳过安装触发（幂等）'
  else
    echo "触发安装（configured=$CONF）..."
    curl -s --max-time 30 -X POST "$API/api/health/local-post/runtime/install" \
      -H 'Content-Type: application/json' -d "{\"runtimeKey\":\"$rt\"}" | head -c 400
    echo
    start=$(date +%s)
    while :; do
      sleep 6
      CONF=$(read_field "$rt" configured)
      waited=$(( $(date +%s) - start ))
      echo "  等待中 ${waited}s configured=$CONF"
      if [ "$CONF" = 'True' ]; then break; fi
      if [ "$waited" -ge "$MAX_WAIT_SEC" ]; then echo '  等待超时'; break; fi
    done
  fi

  P=$(read_field "$rt" detectedPath)
  echo "configured=$CONF"
  echo "detectedPath=$P"
  if [ "$CONF" = 'True' ] && [ -n "$P" ] && [ -x "$P" ]; then
    echo -n 'version: '
    version_of "$rt" "$P"
    echo '  -> PASS'
  else
    echo '  -> FAIL'
    FAIL=$((FAIL + 1))
  fi
done

echo "TOTAL_FAIL=$FAIL"
if [ "$FAIL" -eq 0 ]; then echo 'RESULT=PASS'; else echo 'RESULT=FAIL'; fi
exit "$FAIL"
