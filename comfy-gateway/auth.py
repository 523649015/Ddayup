"""网关鉴权依赖。

hmdao-api.mjs 通过 header `x-hmdao-gateway-key` 携带共享密钥。
GATEWAY_KEY 为空时视为开发模式，关闭鉴权。
"""
from __future__ import annotations

from fastapi import Header, HTTPException

from config import GATEWAY_KEY


def require_gateway_key(x_hmdao_gateway_key: str | None = Header(default=None)) -> None:
    if not GATEWAY_KEY:
        return
    if x_hmdao_gateway_key != GATEWAY_KEY:
        raise HTTPException(status_code=401, detail="invalid gateway key")
