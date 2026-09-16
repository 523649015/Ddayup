#!/usr/bin/env bash
# 在【服务器本机】执行：验证运行时安装接口的鉴权闸门（2026-09-16 收紧后）。
#
# 为什么跑在服务器上：公网域名与 127.0.0.1 直连两条路径的"真实客户端 IP"不同，
# 正好用来验证「反代后不得把公网请求误判为本机」这一安全前提。
#
# 用法：
#   scp deploy/verify-install-gate.sh root@<server>:/tmp/
#   ssh root@<server> 'bash /tmp/verify-install-gate.sh'
set -u

API=http://127.0.0.1:8792
PUB=https://mingmingchuangyi.cn
LIC=/home/ubuntu/app/.hmdao-data/extension-licenses.json
PY=$(command -v python3)

# 用一个"不受支持的运行时"做探针：闸门放行后才会走到参数校验并返回 400，
# 这样既能证明闸门放行，又不会真的触发一次安装任务。
PROBE='{"runtimeKey":"gate-probe-not-a-runtime"}'

echo '=== 1) 匿名（无 deviceId，经公网域名）==='
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$PUB/api/health/local-post/runtime/install" \
  -H 'Content-Type: application/json' -d "$PROBE")
echo "http=$CODE   期望 401 (NO_DEVICE)"

echo '=== 2) 伪造 deviceId（未试用 / 未付费）==='
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$PUB/api/health/local-post/runtime/install" \
  -H 'Content-Type: application/json' -d '{"runtimeKey":"gate-probe-not-a-runtime","deviceId":"gate-probe-not-registered"}')
echo "http=$CODE   期望 402 (LICENSE_REQUIRED)"

echo '=== 3) 本机回环（服务器直连 8792，无任何身份）==='
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/health/local-post/runtime/install" \
  -H 'Content-Type: application/json' -d "$PROBE")
echo "http=$CODE   期望 400（已放行到参数校验 → 说明回环放行生效）"

echo '=== 4) 已授权设备（取授权库中一个 trial/paid 设备；只输出状态码，不回显 deviceId）==='
DEV=$("$PY" -c "import json;d=json.load(open('$LIC'));ks=[k for k,v in (d.get('devices') or {}).items() if isinstance(v,dict) and (v.get('trialStart') or v.get('licenseKey'))];print(ks[0] if ks else '')" 2>/dev/null || true)
if [ -z "$DEV" ]; then
  echo 'skip: 授权库中没有可用的已授权设备'
else
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$PUB/api/health/local-post/runtime/install" \
    -H 'Content-Type: application/json' -d "{\"runtimeKey\":\"gate-probe-not-a-runtime\",\"deviceId\":\"$DEV\"}")
  echo "http=$CODE   期望 400（已授权设备通过闸门）"
fi

echo '=== 5) 运维 Key 通道状态 ==='
if [ -n "${HMDAO_API_KEY:-}" ]; then
  echo 'HMDAO_API_KEY 已配置（脚本环境可见）'
else
  echo '本 shell 未见 HMDAO_API_KEY（服务端可能未配置该变量 → 运维 Key 通道不参与判定，符合当前部署）'
fi
