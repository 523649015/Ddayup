"""daydayupAPI —— HMDao ComfyUI 中转网关配置。

所有配置项从环境变量或同目录 .env 读取。
"""
from __future__ import annotations

import os

from dotenv import load_dotenv

load_dotenv()


def _csv(value: str) -> list[str]:
    return [v.strip() for v in (value or "").split(",") if v.strip()]


# ---- 服务端鉴权 ----
# 网关与 hmdao-api.mjs 之间的共享密钥（server-to-server 信任）。
# 为空时关闭鉴权（仅用于本地开发）。
GATEWAY_KEY = os.getenv("GATEWAY_KEY", "changeme-gateway-key")
# 是否允许请求体携带 per-user 的 provider_keys 覆盖服务端密钥。
ALLOW_CLIENT_KEYS = os.getenv("GATEWAY_ALLOW_CLIENT_KEYS", "false").lower() == "true"

# ---- ComfyUI 实例池 ----
# 逗号分隔的 ComfyUI 原生地址（每个实例自带显卡/显存）。
COMFY_INSTANCES = _csv(os.getenv("COMFY_INSTANCES", "http://127.0.0.1:8188"))

# ---- 并发 / 队列（防止显存爆） ----
GLOBAL_MAX_CONCURRENT = int(os.getenv("GLOBAL_MAX_CONCURRENT", "4"))
# 每个实例串行执行（同一张卡不并行跑多个工作流）。
PER_INSTANCE_SERIAL = os.getenv("PER_INSTANCE_SERIAL", "true").lower() == "true"
# 提交时的队列等待上限（秒）。超过则直接返回 queue_full，不再阻塞 HTTP 请求。
SUBMIT_QUEUE_TIMEOUT = float(os.getenv("SUBMIT_QUEUE_TIMEOUT", "60"))

# ---- 用户配额 ----
# 每用户每日提交上限（0 = 不限）。按 x-hmdao-user-id 头标识用户，缺失视为 anonymous。
USER_DAILY_QUOTA = int(os.getenv("USER_DAILY_QUOTA", "0"))

# ---- 临时文件 ----
GATEWAY_TMP_DIR = os.getenv("GATEWAY_TMP_DIR", "./data/gateway-tmp")
TMP_TTL_SECONDS = int(os.getenv("GATEWAY_TMP_TTL_SECONDS", "1800"))
CLEANUP_INTERVAL_SECONDS = int(os.getenv("GATEWAY_CLEANUP_INTERVAL_SECONDS", "300"))

# 任务进度记录的保留时长（已完成/失败的任务超过该时间会被清理）。
GATEWAY_TASK_TTL_SECONDS = int(os.getenv("GATEWAY_TASK_TTL_SECONDS", "3600"))

# ---- 输出 URL 对外基址 ----
# 网关对外可访问的基址（如 http://host:8000）。留空则输出相对路径 /view/{index}。
# 建议显式配置，使 HMDao 前端能跨域直接拉取成片。
GATEWAY_PUBLIC_URL = os.getenv("GATEWAY_PUBLIC_URL", "")

# ---- Provider 服务端密钥（key broker 默认来源） ----
# 当请求未携带 provider_keys 覆盖时，使用以下服务端统一密钥。
PROVIDER_KEYS: dict[str, str] = {
    "kling": os.getenv("PROVIDER_KLING_KEY", ""),
    "volcengine": os.getenv("PROVIDER_VOLCENGINE_KEY", ""),
    "siliconflow": os.getenv("PROVIDER_SILICONFLOW_KEY", ""),
    "openai": os.getenv("PROVIDER_OPENAI_KEY", ""),
}

# 部分 provider 需要自定义 base_url（如火山方舟 / OneAPI 网关地址）。
PROVIDER_BASE_URLS: dict[str, str] = {
    "volcengine": os.getenv("PROVIDER_VOLCENGINE_BASE_URL", ""),
    "openai": os.getenv("PROVIDER_OPENAI_BASE_URL", ""),
    "siliconflow": os.getenv("PROVIDER_SILICONFLOW_BASE_URL", ""),
}
