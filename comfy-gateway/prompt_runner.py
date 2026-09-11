"""工作流执行编排 + 任务进度追踪。

流程图：
    1. 注入 provider 密钥 -> 解析远程输入 -> 选实例 -> 串行提交 /prompt
    2. 提交成功立即返回 prompt_id（不阻塞），后台 _track 跟踪进度
    3. _track 通过 ComfyUI WebSocket 实时更新进度，并以 /history 完成判定为准收集成片
    4. 前端轮询 GET /tasks/{prompt_id} 获取 queued/running/done/error 与进度
"""
from __future__ import annotations

import asyncio
import json
import time
import traceback
from typing import Any

import websockets

from config import GATEWAY_PUBLIC_URL, GATEWAY_TASK_TTL_SECONDS, SUBMIT_QUEUE_TIMEOUT
from comfy_pool import global_semaphore, pool
from key_broker import broker_keys, inject_keys
from quota import check_and_count
from tempfiles import resolve_remote_inputs

POLL_INTERVAL = 2.0
HISTORY_TIMEOUT = 1800.0
WS_TIMEOUT = 1800.0

# prompt_id -> 任务状态（进程内字典，配合 GATEWAY_TASK_TTL_SECONDS 清理）。
TASKS: dict[str, dict] = {}
TASKS_LOCK = asyncio.Lock()


def _new_task(pid: str) -> dict:
    return {
        "prompt_id": pid,
        "status": "queued",  # queued -> running -> done | error
        "progress": {"value": 0, "max": 0, "node": None, "percent": 0.0},
        "current_node": None,
        "outputs": [],
        "error": None,
        "created_at": time.time(),
        "updated_at": time.time(),
    }


def _build_output_urls(inst, history_entry: dict) -> list[dict]:
    outputs: list[dict] = []
    nodes = (history_entry or {}).get("outputs", {})
    base = GATEWAY_PUBLIC_URL.rstrip("/") if GATEWAY_PUBLIC_URL else ""
    for node_id, node_out in nodes.items():
        if not isinstance(node_out, dict):
            continue
        for key, items in node_out.items():
            if not isinstance(items, list):
                continue
            for item in items:
                if not isinstance(item, dict) or "filename" not in item:
                    continue
                kind = "image"
                if key in ("gifs", "videos"):
                    kind = "video"
                elif key == "audio":
                    kind = "audio"
                params = (
                    f"filename={item['filename']}"
                    f"&subfolder={item.get('subfolder', '')}"
                    f"&type={item.get('type', '')}"
                )
                url = f"{base}/view/{inst.index}?{params}" if base else f"/view/{inst.index}?{params}"
                outputs.append(
                    {
                        "type": kind,
                        "url": url,
                        "metadata": {"node_id": node_id, "filename": item.get("filename")},
                    }
                )
    return outputs


async def get_task(pid: str) -> dict | None:
    async with TASKS_LOCK:
        return dict(TASKS[pid]) if pid in TASKS else None


async def sweep_tasks() -> None:
    """清理已过期的已完成/失败任务记录。"""
    now = time.time()
    async with TASKS_LOCK:
        expired = [
            k
            for k, t in TASKS.items()
            if t["status"] in ("done", "error") and now - t["updated_at"] > GATEWAY_TASK_TTL_SECONDS
        ]
        for k in expired:
            del TASKS[k]


async def _wait_history(inst, pid: str) -> dict | None:
    elapsed = 0.0
    while elapsed < HISTORY_TIMEOUT:
        try:
            r = await inst.get(f"/history/{pid}")
            if r.status_code == 200:
                data = r.json()
                if pid in data:
                    return data[pid]
        except Exception:
            pass
        await asyncio.sleep(POLL_INTERVAL)
        elapsed += POLL_INTERVAL
    return None


async def _apply_ws_message(pid: str, msg: dict) -> None:
    t = msg.get("type")
    data = msg.get("data") or {}
    # 过滤非本 prompt 的消息（同一个 client WS 会收到所有 prompt 的进度）。
    if data.get("prompt_id") not in (None, pid):
        return
    async with TASKS_LOCK:
        task = TASKS.get(pid)
        if task is None:
            return
        if t == "executing":
            node = data.get("node")
            task["current_node"] = node
            task["status"] = "running"
        elif t == "progress":
            v = int(data.get("value", 0))
            m = int(data.get("max", 0))
            task["progress"] = {
                "value": v,
                "max": m,
                "node": data.get("node"),
                "percent": round((v / m) * 100, 1) if m else 0.0,
            }
            task["status"] = "running"
        elif t == "execution_error":
            task["status"] = "error"
            task["error"] = str(
                data.get("exception_message") or data.get("message") or "execution error"
            )
        elif t == "execution_success":
            task["status"] = "running"
        task["updated_at"] = time.time()


async def _finalize(inst, pid: str, history: dict | None) -> None:
    outputs = _build_output_urls(inst, history) if history else []
    async with TASKS_LOCK:
        task = TASKS.get(pid)
        if task is None:
            return
        if task["status"] == "error":
            pass  # 保留错误态
        elif history is None:
            task["status"] = "error"
            task["error"] = task["error"] or "timeout waiting for comfy history"
        else:
            task["status"] = "done"
            task["outputs"] = outputs
            task["progress"] = {"value": 1, "max": 1, "node": None, "percent": 100.0}
        task["updated_at"] = time.time()


async def _track(inst, pid: str, client_id: str | None) -> None:
    """后台协程：订阅 ComfyUI WS 进度，并以 /history 完成判定收集成片。"""
    ws_url = inst.ws_url
    if client_id:
        ws_url += f"?clientId={client_id}"
    stop = asyncio.Event()

    async def _ws_consume() -> None:
        try:
            async with websockets.connect(ws_url, max_size=None, open_timeout=5) as ws:
                while not stop.is_set():
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=2.0)
                    except asyncio.TimeoutError:
                        continue
                    except Exception:
                        break
                    try:
                        msg = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    await _apply_ws_message(pid, msg)
        except Exception:
            # WS 不可用（老版本 / 网络）时降级为仅 history 轮询。
            traceback.print_exc()

    ws_task = asyncio.create_task(_ws_consume())
    try:
        history = await _wait_history(inst, pid)
    finally:
        stop.set()
        ws_task.cancel()
    await _finalize(inst, pid, history)


async def run_prompt(
    prompt: dict[str, Any],
    client_id: str | None,
    provider_keys: dict[str, str],
    provider_base_urls: dict[str, str],
    user_id: str = "anonymous",
    instance: str | None = None,
) -> dict:
    # 用户配额（每日提交上限）。超限直接返回，不进入队列。
    allowed, used, quota = await check_and_count(user_id)
    if not allowed:
        return {
            "success": False,
            "error": f"user daily quota exceeded: {used}/{quota}",
            "quota_exceeded": True,
            "used": used,
            "quota": quota,
        }

    keys, bases = broker_keys(provider_keys, provider_base_urls)
    injected = inject_keys(prompt, keys, bases)
    await resolve_remote_inputs(prompt)

    inst = None
    if instance:
        inst = pool().get(instance) or pool().get_by_url(instance)
    if inst is None:
        inst = pool().pick()
    payload: dict[str, Any] = {"prompt": prompt}
    if client_id:
        payload["client_id"] = client_id

    try:
        # 有界队列等待：超过 SUBMIT_QUEUE_TIMEOUT 直接返回 queue_full，
        # 避免 HTTP 请求在满并发下无限悬挂。
        try:
            await asyncio.wait_for(global_semaphore.acquire(), timeout=SUBMIT_QUEUE_TIMEOUT)
        except asyncio.TimeoutError:
            return {
                "success": False,
                "error": f"comfy gateway queue full, retry later (>{int(SUBMIT_QUEUE_TIMEOUT)}s)",
                "queue_full": True,
            }
        try:
            async with inst.lock:
                r = await inst.post("/prompt", json=payload)
                if r.status_code != 200:
                    return {"success": False, "error": f"comfy rejected: {r.status_code} {r.text[:300]}"}
                data = r.json()
                pid = data.get("prompt_id")
                if not pid:
                    return {"success": False, "error": f"no prompt_id: {str(data)[:300]}"}
        finally:
            global_semaphore.release()
        async with TASKS_LOCK:
            TASKS[pid] = _new_task(pid)
        asyncio.create_task(_track(inst, pid, client_id))
        return {"success": True, "promptId": pid, "injected": injected}
    except Exception as e:  # noqa: BLE001
        return {"success": False, "error": str(e)}
