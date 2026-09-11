"""临时文件管理：下载远程输入 + 定时清理。"""
from __future__ import annotations

import asyncio
import os
import tempfile
import time
from pathlib import Path

import httpx

from config import CLEANUP_INTERVAL_SECONDS, GATEWAY_TMP_DIR, TMP_TTL_SECONDS

_TMP = Path(GATEWAY_TMP_DIR)
_TMP.mkdir(parents=True, exist_ok=True)


async def download_to_tmp(url: str) -> str:
    """下载远程 URL 到本地临时文件，返回本地路径。"""
    suffix = os.path.splitext(url.split("?")[0])[1] or ".bin"
    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0)) as c:
        r = await c.get(url)
        r.raise_for_status()
        fd, path = tempfile.mkstemp(suffix=suffix, dir=str(_TMP))
        with os.fdopen(fd, "wb") as f:
            f.write(r.content)
    return path


async def resolve_remote_inputs(prompt: dict) -> None:
    """将节点 inputs 中的 http(s) URL 替换为本地临时文件路径（ComfyUI loader 支持绝对路径）。"""
    cache: dict[str, str] = {}  # 同一次提交内相同 URL 不重复下载
    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        for k, v in list(inputs.items()):
            if isinstance(v, str) and (v.startswith("http://") or v.startswith("https://")):
                if v in cache:
                    inputs[k] = cache[v]
                    continue
                try:
                    local = await download_to_tmp(v)
                    cache[v] = local
                    inputs[k] = local
                except Exception:
                    # 下载失败则保留原值，交由 ComfyUI 自行拉取。
                    pass


async def cleanup_loop() -> None:
    while True:
        await asyncio.sleep(CLEANUP_INTERVAL_SECONDS)
        now = time.time()
        for p in _TMP.iterdir():
            try:
                if now - p.stat().st_mtime > TMP_TTL_SECONDS:
                    p.unlink()
            except OSError:
                pass
