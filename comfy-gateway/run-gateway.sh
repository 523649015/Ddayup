#!/usr/bin/env bash
# 启动 daydayupAPI 网关（HMDao ComfyUI 中转网关）
# 用法:  ./run-gateway.sh            # 默认 8000 端口
#        PORT=9000 ./run-gateway.sh  # 指定端口
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8000}"

if [ ! -d .venv ]; then
  echo "创建虚拟环境 .venv ..."
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate

echo "安装依赖 (requirements.txt) ..."
pip install -q -r requirements.txt

if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  echo "已从 .env.example 生成 .env，请按需修改密钥与 COMFY_INSTANCES。"
fi

echo "启动网关: http://127.0.0.1:$PORT  (Ctrl+C 停止)"
exec uvicorn main:app --host 0.0.0.0 --port "$PORT"
