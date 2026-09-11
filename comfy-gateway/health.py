"""实例健康与插件探测。"""
from __future__ import annotations

from comfy_pool import pool

# ComfyUI 官方资源（用于前端"未安装"指引）。
COMFYUI_DOWNLOAD_URL = "https://github.com/comfyanonymous/ComfyUI"
COMFYUI_DOCS_URL = "https://docs.comfy.org"
COMFYUI_DEFAULT_PORT = "8188"


async def list_plugins() -> list[str]:
    """聚合首个可达实例的 /object_info，返回全部已安装节点 class_type。"""
    for inst in pool().instances:
        try:
            r = await inst.get("/object_info")
            r.raise_for_status()
            return sorted(r.json().keys())
        except Exception:
            continue
    return []


async def health_summary() -> list[dict]:
    out: list[dict] = []
    for inst in pool().instances:
        try:
            r = await inst.get("/system_stats")
            out.append({"id": str(inst.index), "url": inst.base_url, "reachable": r.status_code == 200})
        except Exception:
            out.append({"id": str(inst.index), "url": inst.base_url, "reachable": False})
    return out


def comfyui_guidance() -> dict:
    """前端"未检测到 ComfyUI"时的安装指引（静态信息）。"""
    return {
        "defaultPort": COMFYUI_DEFAULT_PORT,
        "downloadUrl": COMFYUI_DOWNLOAD_URL,
        "docsUrl": COMFYUI_DOCS_URL,
        "installHint": (
            "在本地安装并启动 ComfyUI（默认监听 "
            + COMFYUI_DEFAULT_PORT
            + "）后，本网关会自动接入，无需额外配置；"
            "若网关与 ComfyUI 不在同一台机器，请把 COMFY_INSTANCES 指向可达地址。"
        ),
        "installScript": "install-comfyui.ps1（Windows）/ install-comfyui.sh（Linux/macOS），位于网关目录。",
    }
