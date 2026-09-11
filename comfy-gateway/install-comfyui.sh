#!/usr/bin/env bash
# 一键安装 ComfyUI（Linux / macOS）。
# 用法:
#   ./install-comfyui.sh                 # 默认 CPU 版，安装到 ./ComfyUI
#   CUDA=1 ./install-comfyui.sh          # 使用 CUDA（需本机有 NVIDIA 显卡与驱动）
#   START=1 ./install-comfyui.sh         # 安装完成后直接启动（默认监听 8188）
#   TARGET=/opt/ComfyUI ./install-comfyui.sh
set -euo pipefail
TARGET="${TARGET:-ComfyUI}"
CUDA="${CUDA:-0}"
START="${START:-0}"

if [ -d "$TARGET/.git" ]; then
  echo "ComfyUI 已存在于 $TARGET，跳过克隆。"
else
  echo "克隆 ComfyUI -> $TARGET"
  git clone https://github.com/comfyanonymous/ComfyUI.git "$TARGET"
fi

cd "$TARGET"
python3 -m venv .venv
# shellcheck disable=SC1091
source .venv/bin/activate

echo "安装依赖 ..."
if [ "$CUDA" = "1" ]; then
  pip install -r requirements.txt
else
  pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu
  grep -viE '^(torch|xformers)' requirements.txt > requirements.nocuda.txt
  pip install -r requirements.nocuda.txt
fi

echo "ComfyUI 安装完成 ✅"
echo "启动命令: $TARGET/.venv/bin/python main.py   (默认监听 http://127.0.0.1:8188)"
echo "本网关默认 COMFY_INSTANCES=http://127.0.0.1:8188，启动后自动接入。"
[ "$START" = "1" ] && exec python main.py
