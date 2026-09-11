"""请求 / 响应数据模型。"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class PromptRequest(BaseModel):
    # ComfyUI 工作流图（节点 id -> {class_type, inputs}）。
    prompt: dict[str, Any] = Field(default_factory=dict)
    client_id: str | None = None
    extra_data: dict[str, Any] = Field(default_factory=dict)
    # 可选：per-request 的 provider 密钥覆盖（需 ALLOW_CLIENT_KEYS=true）。
    provider_keys: dict[str, str] = Field(default_factory=dict)
    provider_base_urls: dict[str, str] = Field(default_factory=dict)
    # 可选：指定 ComfyUI 实例（索引字符串或完整 URL）。为空则走默认轮询。
    instance: str | None = None


class HealthResponse(BaseModel):
    success: bool = True
    configured: bool = True
    reachable: bool = True
    instances: list[dict[str, Any]] = Field(default_factory=list)
    detail: str = ""
    guidance: dict[str, Any] = Field(default_factory=dict)


class ConfigResponse(BaseModel):
    """下发到前端的网关可配置项（UI 暴露用）。"""

    success: bool = True
    # 是否允许请求体携带 per-user provider_keys 覆盖服务端密钥。
    allowClientKeys: bool = False
    # marker（节点 class_type 子串）-> provider 的映射，前端据此提示可用标记。
    markers: list[dict[str, str]] = Field(default_factory=list)
    # 密钥 / base_url 候选注入字段名，供前端构造输入表单。
    keyFields: list[str] = Field(default_factory=list)
    baseUrlFields: list[str] = Field(default_factory=list)
    # 各 provider 服务端密钥是否已配置（不泄露密钥本身）。
    providers: list[dict[str, Any]] = Field(default_factory=list)
    # 网关是否要求 server-to-server 密钥（HMDAO_COMFYUI_GATEWAY_KEY）。
    gatewayKeyRequired: bool = False
    # 网关是否以 HTTPS 提供服务（传输安全）。
    tls: bool = False
    version: str = ""


class PluginsResponse(BaseModel):
    success: bool = True
    configured: bool = True
    reachable: bool = True
    plugins: list[str] = Field(default_factory=list)


class SubmitOutput(BaseModel):
    type: str | None = None
    url: str = ""
    metadata: dict[str, Any] = Field(default_factory=dict)


class TaskProgress(BaseModel):
    value: int = 0
    max: int = 0
    node: str | None = None
    percent: float = 0.0


class TaskStatus(BaseModel):
    prompt_id: str
    status: str = "queued"  # queued | running | done | error
    progress: TaskProgress = Field(default_factory=TaskProgress)
    current_node: str | None = None
    outputs: list[SubmitOutput] = Field(default_factory=list)
    error: str | None = None
    created_at: float = 0.0
    updated_at: float = 0.0


class ValidateRequest(BaseModel):
    # ComfyUI 工作流图（节点 id -> {class_type, inputs}）。
    prompt: dict[str, Any] = Field(default_factory=dict)
    # 可选：指定 ComfyUI 实例（索引字符串或完整 URL）。为空则走默认实例。
    instance: str | None = None


class MissingNodeEntry(BaseModel):
    # 工作流引用的、但当前 ComfyUI 未安装的节点类型（class_type）。
    class_type: str
    # 在工作流中出现的节点 id 列表。
    node_ids: list[str] = Field(default_factory=list)
    # 该节点类型最可能归属的自定义节点插件目录名（启发式推断，仅供参考）。
    guess_plugin: str | None = None


class MissingModelEntry(BaseModel):
    # 引用了模型文件（checkpoint/vae/unet/lora 等）但本地缺失的节点。
    node_id: str
    class_type: str
    # 缺失的模型文件名（如 qwen_image_vae.safetensors）。
    file: str
    # 应放置到的 ComfyUI models 子目录（如 vae / checkpoints）；远程实例时为 None。
    subdir: str | None = None
    # 提示文案（说明如何补上该文件）。
    note: str = ""


class ValidateResponse(BaseModel):
    success: bool = True
    configured: bool = True
    reachable: bool = True
    # 是否为有效工作流（至少有一个节点）。
    valid: bool = False
    # 工作流中实际引用的全部 class_type（去重）。
    used_classes: list[str] = Field(default_factory=list)
    # 当前 ComfyUI 已加载的全部 class_type（来自 /object_info）。
    available_classes: int = 0
    # 缺失节点（即插件未安装）。
    missing: list[MissingNodeEntry] = Field(default_factory=list)
    # 缺失的自定义节点插件目录名（去重，供前端指引安装）。
    missing_plugins: list[str] = Field(default_factory=list)
    # ComfyUI-Manager 是否已安装（仅本地实例可检测；远程实例为 None）。
    comfy_manager_installed: bool | None = None
    # ComfyUI-Manager 仓库地址（未安装时引导用户先装 Manager）。
    manager_github_url: str = "https://github.com/ltdrdata/ComfyUI-Manager"
    # 缺失的模型/权重文件（checkpoint/vae/unet/lora 等）。
    missing_models: list[MissingModelEntry] = Field(default_factory=list)
    # ComfyUI 所在磁盘剩余空间（GB，仅本地实例；远程为 None）。
    disk_free_gb: float | None = None
    # 磁盘剩余是否偏紧（<20GB，模型文件通常数 GB~数十 GB）。
    disk_warning: bool = False
    # 命中的 ComfyUI 实例地址（用于跳转该实例的 Manager / 设置页）。
    instance_url: str | None = None
    # 通用提醒：模型/VAE 等权重文件通常较大，请规划硬盘空间。
    model_note: str = (
        "模型 / VAE / UNET 等权重文件通常较大（数 GB ~ 数十 GB），"
        "请提前规划硬盘空间；缺失文件请下载后放入 ComfyUI 的 models/<对应子目录>，"
        "刷新本节点即可运行。"
    )
    error: str | None = None


class PromptResponse(BaseModel):
    success: bool = True
    promptId: str | None = None
    outputs: list[SubmitOutput] = Field(default_factory=list)
    error: str | None = None
    hint: str | None = None
    quotaExceeded: bool = False
    used: int | None = None
    quota: int | None = None
