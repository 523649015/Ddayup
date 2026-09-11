"""ComfyUI 实例池 + 全局/实例级并发控制。

- 多实例负载均衡（round-robin）。
- 全局信号量限制总并发，避免跨卡显存/带宽打满。
- 每个实例串行锁（PER_INSTANCE_SERIAL），同一张卡不并行跑工作流。
"""
from __future__ import annotations

import asyncio
import itertools

import httpx

from config import COMFY_INSTANCES, GLOBAL_MAX_CONCURRENT, PER_INSTANCE_SERIAL


class ComfyInstance:
    def __init__(self, base_url: str, index: int):
        self.base_url = base_url.rstrip("/")
        self.index = index
        self.lock = asyncio.Semaphore(1 if PER_INSTANCE_SERIAL else 999)
        # ComfyUI WebSocket 进度端点（http->ws）。
        self.ws_url = self.base_url.replace("http://", "ws://").replace(
            "https://", "wss://"
        ) + "/ws"

    async def post(self, path: str, **kw):
        async with httpx.AsyncClient(timeout=httpx.Timeout(600.0)) as c:
            return await c.post(f"{self.base_url}{path}", **kw)

    async def get(self, path: str, **kw):
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as c:
            return await c.get(f"{self.base_url}{path}", **kw)


class ComfyPool:
    def __init__(self, urls: list[str]):
        self.instances = [ComfyInstance(u, i) for i, u in enumerate(urls)]
        self._rr = itertools.cycle(self.instances) if self.instances else []

    def pick(self) -> ComfyInstance:
        if not self.instances:
            raise RuntimeError("no comfy instances configured")
        return next(self._rr)

    def get(self, instance_index: str) -> ComfyInstance | None:
        try:
            idx = int(instance_index)
            return self.instances[idx]
        except (ValueError, IndexError):
            return None

    def get_by_url(self, url: str) -> "ComfyInstance | None":
        url = (url or "").rstrip("/")
        for inst in self.instances:
            if inst.base_url.rstrip("/") == url:
                return inst
        return None


_pool = ComfyPool(COMFY_INSTANCES)
global_semaphore = asyncio.Semaphore(GLOBAL_MAX_CONCURRENT)


def pool() -> ComfyPool:
    return _pool
