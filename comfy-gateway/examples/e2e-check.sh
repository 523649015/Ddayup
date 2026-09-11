#!/usr/bin/env bash
# 端到端实测：提交最小工作流并轮询进度，验证全链路。
# 前置：网关已启动（见 ../run-gateway.sh），COMFY_INSTANCES 指向可达的 ComfyUI。
#
# 用法:
#   ./e2e-check.sh
#   GATEWAY=http://host:8000 GATEWAY_KEY=xxx ./e2e-check.sh
set -euo pipefail
cd "$(dirname "$0")"

GATEWAY="${GATEWAY:-http://127.0.0.1:8000}"
GATEWAY_KEY="${GATEWAY_KEY:-$HMDAO_COMFYUI_GATEWAY_KEY}"
USER_ID="${USER_ID:-e2e-test}"
MAX_WAIT="${MAX_WAIT:-1800}"
WORKFLOW="$PWD/minimal_workflow.json"

[ -f "$WORKFLOW" ] || { echo "找不到工作流样例: $WORKFLOW" >&2; exit 1; }

HEADERS=(-H "Content-Type: application/json" -H "x-hmdao-user-id: $USER_ID")
if [ -n "$GATEWAY_KEY" ]; then HEADERS+=(-H "x-hmdao-gateway-key: $GATEWAY_KEY"); fi

echo "提交工作流 -> $GATEWAY/prompt"
SUBMIT=$(curl -s "${HEADERS[@]}" -X POST --data-binary @"$WORKFLOW" "$GATEWAY/prompt")
echo "  $SUBMIT"
PID=$(echo "$SUBMIT" | python3 -c "import sys,json,sys; print(json.load(sys.stdin).get('promptId',''))")
[ -n "$PID" ] || { echo "提交失败" >&2; exit 1; }
echo "已提交 prompt_id=$PID"

DEADLINE=$(( $(date +%s) + MAX_WAIT ))
LAST=""
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  T=$(curl -s "${HEADERS[@]}" "$GATEWAY/tasks/$PID")
  STATUS=$(echo "$T" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))")
  LINE="$(date +%H:%M:%S) status=$STATUS"
  if [ "$LINE" != "$LAST" ]; then echo "$LINE"; LAST="$LINE"; fi
  if [ "$STATUS" = "done" ] || [ "$STATUS" = "error" ]; then break; fi
  sleep 2
done

if [ "$STATUS" = "done" ]; then
  echo "完成 ✅ 成片:"
  echo "$T" | python3 -c "import sys,json; [print('  [%s] %s'%(o.get('type'),o.get('url'))) for o in json.load(sys.stdin).get('outputs',[])]"
  exit 0
elif [ "$STATUS" = "error" ]; then
  echo "执行错误 ❌"; echo "$T"; exit 2
else
  echo "超时未结束 (status=$STATUS)"; exit 3
fi
