"""
HMDao ComfyUI 中转网关 (daydayupAPI)

运行（开发）：
    pip install -r requirements.txt
    uvicorn main:app --host 0.0.0.0 --port 8000 --reload

生产 / HTTPS（传输安全）：
    GATEWAY_SSL_CERTFILE=/path/fullchain.pem GATEWAY_SSL_KEYFILE=/path/privkey.pem \
    GATEWAY_PORT=8443 python main.py
    # 此时 hmdao-api.mjs 侧把 HMDAO_COMFYUI_GATEWAY_URL 设为 https://... 即可。

然后在前端 hmdao-api.mjs 侧设置：
    HMDAO_COMFYUI_GATEWAY_URL=http://127.0.0.1:8000
    HMDAO_COMFYUI_GATEWAY_KEY=<与 GATEWAY_KEY 一致>

端点：
    GET  /health            健康检查（hmdao-api 轮询）
    GET  /config            下发可配置项（ALLOW_CLIENT_KEYS / MARKERS 等）供前端暴露
    GET  /plugins           返回已安装节点 class_type 列表
    POST /prompt            接收 {prompt:<graph>}，执行并返回成片 URL
    GET  /tasks/{prompt_id} 任务进度
    GET  /view/{index}      代理转发到对应 ComfyUI 实例的 /view 取成片
"""
from __future__ import annotations

import asyncio
import os
import re
import shutil
import subprocess
import urllib.request
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from auth import require_gateway_key
from comfy_pool import pool
from config import ALLOW_CLIENT_KEYS, GATEWAY_KEY, PROVIDER_KEYS
from health import comfyui_guidance, health_summary, list_plugins
from key_broker import BASE_URL_FIELDS, KEY_FIELDS, MARKERS
from prompt_runner import get_task, run_prompt, sweep_tasks
from schemas import (
    ConfigResponse,
    HealthResponse,
    MissingNodeEntry,
    PluginsResponse,
    PromptRequest,
    PromptResponse,
    SubmitOutput,
    TaskStatus,
    ValidateRequest,
    ValidateResponse,
)
from tempfiles import cleanup_loop


@asynccontextmanager
async def lifespan(app: FastAPI):
    cleanup = asyncio.create_task(cleanup_loop())
    sweep = asyncio.create_task(_sweep_loop())
    try:
        yield
    finally:
        cleanup.cancel()
        sweep.cancel()


async def _sweep_loop() -> None:
    while True:
        await asyncio.sleep(600)
        try:
            await sweep_tasks()
        except Exception:
            pass


app = FastAPI(title="HMDao ComfyUI Gateway (daydayupAPI)", lifespan=lifespan)

# HMDao 前端跨域拉取成片所需。
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    summary = await health_summary()
    reachable = any(s["reachable"] for s in summary)
    return HealthResponse(
        configured=True,
        reachable=reachable,
        instances=summary,
        detail="ok" if reachable else "no reachable comfy instance",
        guidance=comfyui_guidance(),
    )


@app.get("/config")
async def config():
    """下发可配置项：是否允许客户端密钥、支持的 marker 映射、服务端已配置的 provider。"""
    providers: list[dict] = []
    for _, pid in MARKERS:
        if any(p["id"] == pid for p in providers):
            continue
        providers.append({"id": pid, "serverKeyConfigured": bool(PROVIDER_KEYS.get(pid))})
    tls = bool(os.getenv("GATEWAY_SSL_CERTFILE") and os.getenv("GATEWAY_SSL_KEYFILE"))
    return ConfigResponse(
        allowClientKeys=ALLOW_CLIENT_KEYS,
        markers=[{"marker": m, "provider": p} for m, p in MARKERS],
        keyFields=KEY_FIELDS,
        baseUrlFields=BASE_URL_FIELDS,
        providers=providers,
        gatewayKeyRequired=bool(GATEWAY_KEY and GATEWAY_KEY != "changeme-gateway-key"),
        tls=tls,
        version="daydayupAPI/1.0",
    )


@app.get("/plugins")
async def plugins():
    try:
        pl = await list_plugins()
        return PluginsResponse(configured=True, reachable=len(pl) > 0, plugins=pl)
    except Exception:
        return PluginsResponse(configured=True, reachable=False, plugins=[], success=False)


# 常见的「class_type -> 自定义节点插件目录名」启发式映射（仅用于指引，非权威）。
_PLUGIN_GUESS = [
    ("ComfyUI-", None),  # 直接以 ComfyUI- 开头的节点通常来自同名插件
]


def _guess_plugin_for_class(class_type: str) -> str | None:
    """根据节点 class_type 启发式推断其所属自定义节点插件目录名。"""
    if not class_type:
        return None
    # 已知核心节点（ComfyUI 内置）无需插件。
    known_core = {
        "CheckpointLoaderSimple", "CheckpointLoader", "UNETLoader", "CLIPLoader",
        "VAELoader", "LoraLoader", "LoraLoaderModelOnly", "ModelLoader",
        "EmptyLatentImage", "EmptyLatentSD3", "EmptyLatentFlux", "EmptyLatentAuraFlow",
        "CLIPTextEncode", "CLIPTextEncodeSDXL", "CLIPTextEncodeFlux",
        "CLIPTextEncodeSDXLRefiner", "ConditioningZeroOut", "ConditioningAverage",
        "VAEDecode", "VAEDecodeTiled", "VAEEncode", "VAEEncodeForInpaint",
        "SaveImage", "PreviewImage", "LoadImage", "LoadImageMask",
        "KSampler", "KSamplerAdvanced", "KSamplerSelect", "EulerAncestralSampler",
        "SamplerCustom", "SamplerCustomAdvanced", "BasicScheduler", "KarrasScheduler",
        "SplitSigmas", "SplitSigmasDenoise", "CFGGuider", "DualCLIPLoader",
        "UNETLoader", "ModelSamplingDiscrete", "ModelSamplingSD3", "ModelSamplingFlux",
        "Note", "PrimitiveNode", "Reroute", "PrimitiveBool", "PrimitiveInt",
        "PrimitiveFloat", "PrimitiveString", "StringLiteral", "StringConcat",
    }
    if class_type in known_core:
        return None
    # ComfyUI 内置插件（comfy_extras / nodes_*.py）同样无需额外安装。
    if class_type in {
        "ImageScale", "ImageScaleBy", "ImageUpscaleWithModel", "ImageBlur",
        "ImageSharpen", "ImageInvert", "ImagePadForOutpaint", "ImageCrop",
        "ImageFromBatch", "ImageToDevice", "ImageBatch", "ImageCompositeMasked",
        "SolidMask", "ImageToMask", "MaskToImage", "BitwiseAndMask",
        "BitwiseOrMask", "FeatherMask", "CropMask", "MaskToImage",
        "ModelMergeSimple", "ModelMergeBlocks", "ModelMergeAdd", "ModelSubtract",
        "ModelMultiply", "ModelDiffusionModelLoader", "UNETLoader",
        "ControlNetLoader", "ControlNetApply", "ControlNetApplyAdvanced",
        "DiffControlNetLoader", "ControlNetLoaderAdvanced",
    }:
        return None
    # 常见自定义节点家族 → 插件目录（ComfyUI-Manager 安装标识）启发式映射。
    family_map = {
        "ipadapter": "ComfyUI-IPAdapter-Plus",
        "controlnet": "ComfyUI-Advanced-ControlNet",
        "animatediff": "ComfyUI-AnimateDiff-Evolved",
        "frameinterp": "ComfyUI-VFI",
        "rife": "ComfyUI-RIFE",
        "birefnet": "ComfyUI-BiRefNet",
        "ultimatesdupscale": "ComfyUI-UltimateSDUpscale",
        "sag": "ComfyUI-SAG",
        "freeu": "FreeU_Advanced",
        "tileddiffusion": "ComfyUI-TiledDiffusion",
        "tiledvae": "ComfyUI-TiledVAE",
        "fooocus": "ComfyUI-Fooocus-Nodes",
        "layerdiffuse": "ComfyUI-LayerDiffuse",
        "impactpack": "ComfyUI-Impact-Pack",
        "segs": "ComfyUI-Impact-Pack",
        "maskeditor": "ComfyUI-Impact-Pack",
        "facedetailer": "ComfyUI-Impact-Pack",
        "kj": "ComfyUI-KJNodes",
        "was": "was-node-suite-comfyui",
        "crystools": "ComfyUI-Crystools",
        "efficiency": "ComfyUI-Efficiency-Nodes",
        "powerloraloader": "ComfyUI-Advanced-LoRA",
        "tooncrafter": "ComfyUI-ToonCrafter",
        "liveportrait": "ComfyUI-LivePortrait",
        "supir": "ComfyUI-SUPIR",
        "inspire": "ComfyUI-Inspire-Pack",
        "comfyroll": "ComfyUI_Comfyroll_CustomNodes",
        "easy": "ComfyUI-Easy-Use",
        "ade": "ComfyUI-AnimateDiff-Evolved",
    }
    low = class_type.lower()
    for prefix, plugin in family_map.items():
        if low.startswith(prefix):
            return plugin
    # 启发式：以 ComfyUI- 开头的节点，插件目录即同名。
    if class_type.startswith("ComfyUI") or class_type.startswith("ComfyUI_"):
        return class_type
    return None


# ---------------------------------------------------------------------------
# 本地实例专属检查：缺失模型文件检测 / ComfyUI-Manager 检测 / 磁盘空间
# （仅当网关与 ComfyUI 同机时，文件系统路径才有意义）
# ---------------------------------------------------------------------------

# 精确映射：class_type -> (models 子目录, 输入键名)
CORE_LOADER_MAP: dict[str, tuple[str, str]] = {
    "CheckpointLoaderSimple": ("checkpoints", "ckpt_name"),
    "CheckpointLoader": ("checkpoints", "ckpt_name"),
    "VAELoader": ("vae", "vae_name"),
    "UNETLoader": ("unet", "unet_name"),
    "LoraLoader": ("loras", "lora_name"),
    "LoraLoaderModelOnly": ("loras", "lora_name"),
}

# 通用兜底：输入键名 -> models 子目录
KEY_SUBDIR: dict[str, str] = {
    "ckpt_name": "checkpoints", "vae_name": "vae", "unet_name": "unet",
    "lora_name": "loras", "model": "checkpoints", "ckpt": "checkpoints",
    "vae": "vae", "unet": "unet", "lora": "loras", "model_path": "checkpoints",
    "dit_path": "unet", "diffusion_model": "diffusion_models",
}

# 常见模型子目录（兜底查找用）
MODEL_SUBDIRS = [
    "checkpoints", "vae", "unet", "loras", "diffusion_models",
    "controlnet", "clip", "upscale_models", "embeddings",
]


def _resolve_model_file(comfy_dir: str, subdir: str, filename: str) -> bool:
    return os.path.isfile(os.path.join(comfy_dir, "models", subdir, filename))


def _detect_missing_models(
    nodes: dict, comfy_dir: str, local: bool
) -> list:
    """扫描工作流中引用了模型文件的加载节点，确认本地是否存在该文件。"""
    from schemas import MissingModelEntry

    # 仅把看起来像模型权重的文件名当作模型文件，避免把普通字符串输入误报为缺失模型。
    MODEL_EXT = (".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".sft", ".onnx")

    def looks_like_model(name: str) -> bool:
        return name.lower().endswith(MODEL_EXT)

    result = []
    for nid, node in nodes.items():
        if not isinstance(node, dict):
            continue
        ct = node.get("class_type")
        inputs = node.get("inputs", {}) or {}
        subdir: str | None = None
        filename: str | None = None
        if ct in CORE_LOADER_MAP:
            subdir, key = CORE_LOADER_MAP[ct]
            filename = inputs.get(key)
        else:
            # 通用兜底：仅当输入键疑似模型且值以模型扩展名结尾时才视为模型引用。
            for k, v in inputs.items():
                if k in KEY_SUBDIR and isinstance(v, str) and looks_like_model(v):
                    subdir = KEY_SUBDIR[k]
                    filename = v
                    break
        if not filename or not isinstance(filename, str):
            continue
        if not local:
            result.append(MissingModelEntry(
                node_id=str(nid), class_type=ct or "?", file=filename,
                subdir=None,
                note="远程实例，无法本地确认模型文件，请在对应 ComfyUI 上检查。",
            ))
            continue
        candidates = [subdir] if subdir else MODEL_SUBDIRS
        found = any(
            _resolve_model_file(comfy_dir, s, filename)
            for s in candidates if s
        )
        if not found:
            result.append(MissingModelEntry(
                node_id=str(nid), class_type=ct or "?", file=filename,
                subdir=subdir,
                note=(
                    f"模型文件缺失，请下载后放入 ComfyUI 的 models/"
                    f"{subdir or '对应子目录'} 目录，刷新本节点即可运行。"
                ),
            ))
    return result


def _check_comfy_manager(comfy_dir: str, local: bool) -> bool | None:
    if not local:
        return None
    return os.path.isdir(os.path.join(comfy_dir, "custom_nodes", "ComfyUI-Manager"))


def _disk_free_gb(comfy_dir: str, local: bool) -> float | None:
    if not local:
        return None
    try:
        return round(shutil.disk_usage(comfy_dir).free / (1024 ** 3), 1)
    except OSError:
        return None


@app.post("/validate")
async def validate(req: ValidateRequest):
    """校验工作流所需节点类型是否均已安装；返回缺失的自定义节点（插件）。"""
    try:
        inst = pool().pick()
        if inst is None:
            return ValidateResponse(
                success=False, configured=False, reachable=False,
                valid=False, error="未配置任何 ComfyUI 实例",
            )
        obj = await inst.get("/object_info")
        data = obj.json()
        available = set(data.keys()) if isinstance(data, dict) else set()

        nodes = req.prompt if isinstance(req.prompt, dict) else {}
        used: list[str] = []
        by_class: dict[str, list[str]] = {}
        for nid, node in nodes.items():
            if not isinstance(node, dict):
                continue
            ct = node.get("class_type")
            if not ct:
                continue
            used.append(ct)
            by_class.setdefault(ct, []).append(str(nid))

        seen = set()
        used_unique = []
        for ct in used:
            if ct not in seen:
                seen.add(ct)
                used_unique.append(ct)

        missing: list[MissingNodeEntry] = []
        missing_plugins: list[str] = []
        for ct in used_unique:
            if ct in available:
                continue
            guess = _guess_plugin_for_class(ct)
            missing.append(MissingNodeEntry(
                class_type=ct,
                node_ids=by_class.get(ct, []),
                guess_plugin=guess,
            ))
            if guess and guess not in missing_plugins:
                missing_plugins.append(guess)

        # 仅本地实例（网关与 ComfyUI 同机）可做文件系统检查；
        # 远程实例无法确认本地文件，跳过 Manager / 模型 / 磁盘检查。
        local = bool(inst) and (
            "127.0.0.1" in inst.base_url or "localhost" in inst.base_url
        )
        # 文件级检查必须用「正在运行的这份」ComfyUI 目录，否则会扫错目录
        # （例如用户用的是自己装的、模型齐全的 ComfyUI，而 COMFY_DIR 指向
        # 网关自带的空模型目录），从而出现“能出图却报缺 VAE”的误报。
        comfy_dir = _resolve_comfy_dir_for_instance(inst.base_url) if inst else COMFY_DIR
        missing_models = _detect_missing_models(nodes, comfy_dir, local) if local else []
        comfy_manager_installed = _check_comfy_manager(comfy_dir, local)
        disk_free = _disk_free_gb(comfy_dir, local)
        disk_warning = bool(disk_free) and disk_free < 20

        return ValidateResponse(
            success=True,
            configured=True,
            reachable=True,
            valid=len(used_unique) > 0,
            used_classes=used_unique,
            available_classes=len(available),
            missing=missing,
            missing_plugins=missing_plugins,
            comfy_manager_installed=comfy_manager_installed,
            missing_models=missing_models,
            disk_free_gb=disk_free,
            disk_warning=disk_warning,
            instance_url=inst.base_url if inst else None,
        )
    except Exception as e:  # noqa: BLE001
        return ValidateResponse(
            success=False, configured=True, reachable=False,
            valid=False, error=f"校验失败：{e}",
        )


# ---------------------------------------------------------------------------
# 运维端点：重启 ComfyUI / 将 checkpoint 直接落盘到 ComfyUI models 目录
# （均在 localhost 同一台机器上，网关按文件系统路径管理 ComfyUI）
# ---------------------------------------------------------------------------
COMFY_DIR = os.getenv("COMFY_DIR") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "ComfyUI"
)


def _find_comfy_install_dir_via_port(base_url: str) -> str | None:
    """本地实例时，根据监听端口反查真正在跑的 ComfyUI 安装目录。

    默认 COMFY_DIR 指向网关自带的 ComfyUI，但用户实际出图的往往是另一份
    ComfyUI（比如在 127.0.0.1:8188 上自己装的、已下好模型的那份）。文件级
    的模型/Manager/磁盘检查必须用「正在运行的这份」目录，否则会出现
    “能出图却报缺 VAE” 的误报。这里通过端口 -> PID -> 进程命令行反查出目录。
    """
    import re
    import subprocess

    m = re.search(r":(\d+)", base_url or "")
    port = m.group(1) if m else "8188"

    pid = None
    try:
        if os.name == "nt":
            out = subprocess.run(
                ["netstat", "-ano", "-p", "TCP"],
                capture_output=True, text=True, timeout=8,
            ).stdout
            for line in out.splitlines():
                if f":{port}" in line and "LISTENING" in line:
                    cols = line.split()
                    pid = cols[-1]
                    break
        else:
            out = subprocess.run(
                ["lsof", "-ti", f"tcp:{port}"],
                capture_output=True, text=True, timeout=8,
            ).stdout.strip()
            pid = out.splitlines()[0] if out else None
    except Exception:  # noqa: BLE001
        pid = None

    if not pid:
        return None

    cmdline = ""
    try:
        if os.name == "nt":
            out = subprocess.run(
                ["wmic", "process", "where", f"ProcessId={pid}",
                 "get", "CommandLine", "/value"],
                capture_output=True, text=True, timeout=8,
            ).stdout
            for line in out.splitlines():
                if line.strip().lower().startswith("commandline="):
                    cmdline = line.split("=", 1)[1]
                    break
        else:
            out = subprocess.run(
                ["ps", "-p", pid, "-o", "args="],
                capture_output=True, text=True, timeout=8,
            ).stdout
            cmdline = out
    except Exception:  # noqa: BLE001
        cmdline = ""

    if not cmdline:
        return None

    # 1) 直接命中 main.py -> 取其所在目录
    for tok in re.split(r'\s+', cmdline):
        if tok.endswith("main.py"):
            d = os.path.dirname(os.path.abspath(tok))
            if os.path.isdir(os.path.join(d, "models")):
                return d
    # 2) 命令行里含有 ComfyUI 路径段 -> 取其目录
    mm = re.search(r'["\']?([^"\'\s]*[\\/]ComfyUI)(?:[\\/]|["\']|\s|$)', cmdline)
    if mm:
        d = mm.group(1)
        if os.path.isdir(os.path.join(d, "models")):
            return d
    return None


def _resolve_comfy_dir_for_instance(base_url: str) -> str:
    """本地实例优先用端口反查出的真实目录，失败再回退 COMFY_DIR。"""
    if base_url and ("127.0.0.1" in base_url or "localhost" in base_url):
        detected = _find_comfy_install_dir_via_port(base_url)
        if detected:
            return detected
    return COMFY_DIR
COMFY_INSTALL_SCRIPT = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "install-comfyui.ps1"
)


def _kill_comfyui() -> None:
    """结束本机 ComfyUI 进程（按命令行匹配，避免 Get-NetTCPConnection 需要管理员权限）。

    仅匹配命令行包含 'ComfyUI' 且 'main.py' 的进程，避免误杀网关自身。
    """
    try:
        subprocess.run(
            [
                "powershell", "-NoProfile", "-Command",
                "$procs = Get-CimInstance Win32_Process | Where-Object { "
                "$_.CommandLine -match 'ComfyUI' -and $_.CommandLine -match 'main\\.py' }; "
                "if ($procs) { $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }",
            ],
            check=False, capture_output=True, timeout=30,
        )
    except Exception:  # noqa: BLE001
        pass


def _launch_comfyui() -> None:
    """以 --cpu 后台拉起 ComfyUI（与 install-comfyui.ps1 -Start 一致）。"""
    py = os.path.join(COMFY_DIR, ".venv", "Scripts", "python.exe")
    if not os.path.exists(py):
        py = "python"
    subprocess.Popen(
        [
            "powershell", "-NoProfile", "-Command",
            f"Start-Process -FilePath '{py}' -ArgumentList 'main.py','--cpu' "
            f"-WorkingDirectory '{COMFY_DIR}' -WindowStyle Hidden",
        ],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )


@app.post("/install-manager")
async def install_manager() -> dict:
    """把 ComfyUI-Manager 克隆进「真正在跑的」ComfyUI 的 custom_nodes。

    与 /validate 同理，文件操作必须针对端口反查出的真实 ComfyUI 目录，
    否则会装到网关自带的空模型 ComfyUI 里，而用户在浏览器打开的那台
    （127.0.0.1:8188，已下好模型）依然看不到 Manager 按钮。
    """
    import shutil
    import subprocess

    inst = pool().pick()
    comfy_dir = _resolve_comfy_dir_for_instance(inst.base_url) if inst else COMFY_DIR
    custom_nodes = os.path.join(comfy_dir, "custom_nodes")
    target = os.path.join(custom_nodes, "ComfyUI-Manager")
    os.makedirs(custom_nodes, exist_ok=True)
    if os.path.isdir(target) and os.listdir(target):
        return {
            "success": True,
            "already_installed": True,
            "path": target,
            "hint": "ComfyUI-Manager 已存在于正在运行的 ComfyUI，重启 ComfyUI 后顶部菜单即出现 Manager 按钮。",
        }
    git = shutil.which("git")
    if not git:
        return {
            "success": False,
            "no_git": True,
            "manual_steps": [
                f'cd "{custom_nodes}"',
                "git clone https://github.com/ltdrdata/ComfyUI-Manager.git",
                "重启 ComfyUI，顶部菜单即出现 Manager 按钮",
            ],
            "manualUrl": "https://github.com/ltdrdata/ComfyUI-Manager",
            "hint": "未检测到 git，请手动执行上述命令把 ComfyUI-Manager 安装到正在运行的 ComfyUI。",
        }
    try:
        proc = subprocess.run(
            [git, "clone", "https://github.com/ltdrdata/ComfyUI-Manager.git", target],
            cwd=custom_nodes, env=os.environ, capture_output=True, text=True, timeout=180,
        )
        if proc.returncode == 0:
            return {
                "success": True,
                "cloned": True,
                "path": target,
                "hint": "ComfyUI-Manager 已克隆到正在运行的 ComfyUI。请在模型下载面板点「重启 ComfyUI」，重启后顶部菜单即出现 Manager 按钮。",
            }
        return {
            "success": False,
            "error": f"git clone 失败({proc.returncode}): {proc.stderr[:300]}",
            "manualUrl": "https://github.com/ltdrdata/ComfyUI-Manager",
        }
    except Exception as e:  # noqa: BLE001
        return {"success": False, "error": str(e), "manualUrl": "https://github.com/ltdrdata/ComfyUI-Manager"}


@app.post("/restart", dependencies=[Depends(require_gateway_key)])
async def restart_comfyui() -> dict:
    """重启本机 ComfyUI：结束 8188 进程后后台拉起，立即返回，由客户端轮询 /health。

    采用非阻塞设计，避免 --cpu 启动较慢时网关 worker 长时间被占用或代理超时。
    """
    try:
        _kill_comfyui()
        await asyncio.sleep(2)
        _launch_comfyui()
    except Exception as e:  # noqa: BLE001
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})
    return {"success": True, "status": "restarting"}


@app.post("/checkpoint", dependencies=[Depends(require_gateway_key)])
async def download_checkpoint(request: Request) -> dict:
    """将给定 URL 的模型文件直接下载到 ComfyUI 的 models/<subdir>（默认 checkpoints）。"""
    try:
        data = await request.json()
    except Exception:  # noqa: BLE001
        data = {}
    url = (data.get("url") or "").strip()
    if not url or not url.lower().startswith("http"):
        return JSONResponse(status_code=400, content={"success": False, "error": "invalid-url"})
    subdir = (data.get("subdir") or "checkpoints").strip().strip("/")
    if not subdir or ".." in subdir or subdir.startswith("/") or subdir.startswith("\\"):
        return JSONResponse(status_code=400, content={"success": False, "error": "invalid-subdir"})

    def _download() -> dict:
        dest_dir = os.path.join(COMFY_DIR, "models", subdir)
        os.makedirs(dest_dir, exist_ok=True)
        raw_name = os.path.basename(url.split("?")[0].split("#")[0]) or "model.bin"
        safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", raw_name) or "model.bin"
        dest = os.path.join(dest_dir, safe_name)
        try:
            with urllib.request.urlopen(url, timeout=600) as resp, open(dest, "wb") as out:  # noqa: S310
                written = 0
                while True:
                    chunk = resp.read(1024 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
                    written += len(chunk)
            return {"success": True, "path": dest, "bytes": written, "subdir": subdir}
        except Exception as e:  # noqa: BLE001
            if os.path.exists(dest):
                try:
                    os.remove(dest)
                except Exception:  # noqa: BLE001
                    pass
            return {"success": False, "error": str(e)}

    # 下载是阻塞 IO，放到线程里执行，避免卡死 uvicorn 事件循环
    result = await asyncio.to_thread(_download)
    if result.get("success"):
        return result
    return JSONResponse(status_code=500, content=result)


@app.post("/prompt", dependencies=[Depends(require_gateway_key)])
async def prompt(req: PromptRequest, request: Request):
    # 用户标识用于配额；缺失时按 anonymous（共用一份配额）。
    user_id = (request.headers.get("x-hmdao-user-id") or "anonymous").strip() or "anonymous"
    try:
        result = await run_prompt(
            req.prompt, req.client_id, req.provider_keys, req.provider_base_urls, user_id, req.instance
        )
    except Exception as e:  # noqa: BLE001
        return JSONResponse(
            status_code=500,
            content=PromptResponse(success=False, error=str(e)).model_dump(),
        )
    if not result.get("success"):
        # 配额超限 -> 429；队列满 -> 503；其他 -> 502。
        status = 502
        if result.get("quota_exceeded"):
            status = 429
        elif result.get("queue_full"):
            status = 503
        return JSONResponse(
            status_code=status,
            content=PromptResponse(
                success=False,
                error=result.get("error"),
                quotaExceeded=result.get("quota_exceeded", False),
                used=result.get("used"),
                quota=result.get("quota"),
            ).model_dump(),
        )
    # 非阻塞：提交成功即返回 prompt_id，进度请轮询 /tasks/{prompt_id}。
    return PromptResponse(
        success=True,
        promptId=result.get("promptId"),
        outputs=[],
        hint="injected: " + ",".join(result.get("injected", [])),
    )


@app.get("/tasks/{prompt_id}", dependencies=[Depends(require_gateway_key)])
async def task_status(prompt_id: str):
    task = await get_task(prompt_id)
    if task is None:
        raise HTTPException(status_code=404, detail="unknown or expired task")
    return TaskStatus(**task)


@app.get("/view/{instance_index}")
async def view(instance_index: str, request: Request):
    inst = pool().get(instance_index)
    if not inst:
        raise HTTPException(status_code=404, detail="unknown instance")
    qs = request.url.query
    r = await inst.get(f"/view?{qs}")
    headers = {"Content-Type": r.headers.get("content-type", "application/octet-stream")}
    if r.headers.get("content-length"):
        headers["Content-Length"] = r.headers["content-length"]
    # 成片可缓存，减少重复拉取。
    headers["Cache-Control"] = "public, max-age=3600"
    return Response(content=r.content, status_code=r.status_code, headers=headers)


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("GATEWAY_PORT", "8000"))
    ssl_kw: dict = {}
    cert = os.getenv("GATEWAY_SSL_CERTFILE")
    key = os.getenv("GATEWAY_SSL_KEYFILE")
    if cert and key:
        ssl_kw = {"ssl_certfile": cert, "ssl_keyfile": key}
    uvicorn.run(app, host="0.0.0.0", port=port, **ssl_kw)
