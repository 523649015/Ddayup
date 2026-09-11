"""Key Broker：扫描 ComfyUI 工作流中的云端大模型节点，注入对应 provider 密钥。

marker -> provider 映射与前端 comfyuiClient.ts 的 CLOUD_NODE_MARKERS 保持一致。
不同 custom node 的密钥字段名不一，这里按候选字段顺序注入；若无候选字段则补 api_key。
"""
from __future__ import annotations

from typing import Any

from config import ALLOW_CLIENT_KEYS, PROVIDER_BASE_URLS, PROVIDER_KEYS

# (class_type 子串, provider id)
MARKERS: list[tuple[str, str]] = [
    ("Kling", "kling"),
    ("Volcengine", "volcengine"),
    ("Siliconflow", "siliconflow"),
    ("OneAPI", "openai"),
]

KEY_FIELDS = ["api_key", "apiKey", "api_token", "token"]
BASE_URL_FIELDS = ["api_url", "base_url", "baseUrl", "server"]


def broker_keys(
    provider_keys: dict[str, str], provider_base_urls: dict[str, str]
) -> tuple[dict[str, str], dict[str, str]]:
    """合并服务端密钥与（可选的）per-request 覆盖。

    仅当 GATEWAY_ALLOW_CLIENT_KEYS=true 时，请求体携带的 provider_keys /
    provider_base_urls 才会覆盖服务端密钥。否则忽略，防止客户端越权注入密钥。
    """
    keys = dict(PROVIDER_KEYS)
    bases = dict(PROVIDER_BASE_URLS)
    if ALLOW_CLIENT_KEYS:
        keys.update({k: v for k, v in provider_keys.items() if v})
        bases.update({k: v for k, v in provider_base_urls.items() if v})
    return keys, bases


def inject_keys(
    prompt: dict[str, Any],
    provider_keys: dict[str, str],
    provider_base_urls: dict[str, str],
) -> list[str]:
    """扫描并注入密钥，返回被注入的 provider 列表。"""
    injected: set[str] = set()
    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        cls = str(node.get("class_type", ""))
        for marker, provider in MARKERS:
            if marker not in cls:
                continue
            key = provider_keys.get(provider)
            if not key:
                continue
            inputs = node.setdefault("inputs", {})
            placed = False
            for f in KEY_FIELDS:
                if f in inputs:
                    inputs[f] = key
                    placed = True
                    break
            if not placed:
                inputs["api_key"] = key
            base = provider_base_urls.get(provider)
            if base:
                for f in BASE_URL_FIELDS:
                    if f in inputs:
                        inputs[f] = base
                        placed = True
                        break
                if not placed:
                    inputs["api_url"] = base
            injected.add(provider)
            break
    return sorted(injected)
