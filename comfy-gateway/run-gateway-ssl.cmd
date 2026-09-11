@echo off
set GATEWAY_PORT=8000
set GATEWAY_KEY=dev-gateway-key-2026
set COMFY_INSTANCES=http://127.0.0.1:8188
set GATEWAY_PUBLIC_URL=http://127.0.0.1:8792/api/comfyui
set GATEWAY_ALLOW_CLIENT_KEYS=true
set GATEWAY_SSL_CERTFILE=f:\Work\HMDAODAO\comfy-gateway\gateway-selfsigned.crt
set GATEWAY_SSL_KEYFILE=f:\Work\HMDAODAO\comfy-gateway\gateway-selfsigned.key
cd /d f:\Work\HMDAODAO\comfy-gateway
f:\Work\HMDAODAO\comfy-gateway\.venv\Scripts\python.exe main.py
