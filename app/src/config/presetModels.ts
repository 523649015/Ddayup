/**
 * 模型/插件下载清单（集中配置）
 *
 * 所有可在「模型下载」面板安装/下载的预设模型与扩展包统一定义在此，
 * 便于全局引用、避免循环依赖，并支持 Phase 7 持续扩展本地开源插件。
 *
 * 字段说明：
 *  - node：该模型/插件主要服务于哪个编辑器节点（用于标注作用节点）
 *  - purpose：一句话主要用途
 *  - localOnly：是否纯本地（浏览器端 ONNX / WASM），无需远端 API Key
 *  - category：面板分组与筛选分类
 */

export type PresetModelCategory = 'image-node' | 'video' | 'audio' | 'search' | 'system' | 'post-fx' | 'backend-dep' | 'asset';

export interface PresetModel {
  id: string;
  name: string;
  version: string;
  size: string;
  desc: string;
  url: string;
  /** 作用节点：该模型/插件主要服务于哪个编辑器节点 */
  node?: string;
  /** 主要用途：一句话说明 */
  purpose?: string;
  /** 是否纯本地（浏览器端 ONNX / WASM），无需远端 API Key */
  localOnly?: boolean;
  /** 面板分组分类 */
  category?: PresetModelCategory;
  /** 浏览器端本地推理类型；有则该模型走真实 ONNX/@imgly 推理而非仅占位 */
  localRunner?: 'esrgan' | 'lama' | 'imgly' | 'depth-anything-v2' | 'depth-anything-v3' | 'rmbg' | 'raft';
  /** 浏览器端非 ORT 推理运行时（如 Transformers.js 的 NLLB 翻译）；有则该模型走专属加载器而非 ORT */
  browserRuntime?: 'nllb';
  /** 被哪个更新版本取代（用于面板「有更新」提示，如 Depth V2 → V3） */
  supersededBy?: string;
  /** 外部权重文件（拆分式 onnx，如 Depth Anything V3 的 model.onnx_data），需与主文件一同下载/缓存 */
  extraFiles?: { name: string; url: string }[];
  /** 是否为受限(gated)模型，需要 HF 令牌/接受许可才能下载（如 RMBG-2.0） */
  gated?: boolean;
  /** 后端 pip 依赖包名（用于 curator 后端服务安装） */
  pipPackage?: string;
  /** pip 安装命令（可选，默认 pip install {pipPackage}） */
  pipInstallCmd?: string;
  /** 是否为可选依赖（安装失败不影响核心功能） */
  pipOptional?: boolean;
  /** 依赖对应的 curator 服务功能说明 */
  curatorFeature?: string;
  /** 插件链路状态：available=可用；pending=声明占位但后端路由/安装链路未打通，暂不可用（待后续完善） */
  status?: 'available' | 'pending';
}

// 浏览器端模型（缓存进 IndexedDB，刷新/重登后仍判定为已安装）
export const PRESET_MODELS: PresetModel[] = [
  {
    id: 'real-esrgan-x4',
    name: 'Real-ESRGAN x4',
    version: '1.0.0',
    size: '~30 MB',
    desc: '本地图片放大模型，适合离线预览和基础清晰度增强。',
    url: '/api/hf-proxy/AXERA-TECH/Real-ESRGAN/resolve/main/onnx/realesrgan-x4.onnx',
    node: '图片节点',
    purpose: '离线高清放大（Real-ESRGAN x4），无 API Key 也能用',
    localOnly: true,
    localRunner: 'esrgan',
    category: 'image-node',
  },
  {
    id: 'lora-sd-style',
    name: 'LoRA 风格权重',
    version: '1.0.0',
    size: '~15 MB',
    desc: 'Stable Diffusion 风格 LoRA，适合快速做本地风格试验。',
    url: '/api/models/lora-style.safetensors',
    node: '图片节点',
    purpose: '本地风格 LoRA 试验',
    localOnly: true,
    category: 'image-node',
  },
  {
    id: 'whisper-tiny',
    name: 'Whisper Tiny',
    version: '1.0.0',
    size: '~40 MB',
    desc: '本地语音识别模型，适合转写和调试验证。',
    url: '/api/models/whisper-tiny.onnx',
    node: '视频节点',
    purpose: '本地语音识别转写',
    localOnly: true,
    category: 'video',
  },
  {
    id: 'lama-inpaint',
    name: 'LaMa 局部修复',
    version: '1.0.0',
    size: '~50 MB',
    desc: '本地图像修复/去水印/去瑕疵模型（LaMa），用于图片节点「局部编辑」笔刷。',
    url: '/api/hf-proxy/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx',
    node: '图片节点',
    purpose: '局部编辑/去瑕疵（笔刷修复），无 API Key 也能用',
    localOnly: true,
    localRunner: 'lama',
    category: 'image-node',
  },
  {
    id: 'imgly-bgremoval',
    name: '@imgly 智能去背',
    version: '1.0.0',
    size: '运行时按需下载(~40MB)',
    desc: '浏览器端智能抠图模型（@imgly/background-removal），一键去除图片背景。',
    url: '',
    node: '图片节点',
    purpose: '智能去背景（一键抠图）',
    localOnly: true,
    localRunner: 'imgly',
    category: 'image-node',
  },
  {
    id: 'depth-anything-v3-base',
    name: 'Depth Anything V3 深度估计',
    version: '2.0.0',
    size: '~413 MB',
    desc: '字节 2025 开源的新一代深度估计（DA3，Apache-2.0），深度精度与多视图一致性更强。用于后期节点「智能景深（主体锐利/背景模糊）」与多角度真实 3D 旋转。已作为默认深度引擎（原 V2 已下架）。权重拆分为 model.onnx + model.onnx_data，本地下载时会一并拉取。',
    url: '/api/hf-proxy/onnx-community/depth-anything-v3-base/resolve/main/onnx/model.onnx',
    node: '图片节点 / 后期节点',
    purpose: '深度估计 → 智能景深 + 真实 3D 旋转（DA3）',
    localOnly: true,
    localRunner: 'depth-anything-v3',
    category: 'image-node',
    extraFiles: [
      { name: 'model.onnx_data', url: '/api/hf-proxy/onnx-community/depth-anything-v3-base/resolve/main/onnx/model.onnx_data' },
    ],
  },
  {
    id: 'depth-anything-v2-small',
    name: 'Depth Anything V2（小模型兜底）',
    version: '1.0.0',
    size: '~27 MB',
    desc: '字节 Depth Anything V2 Small（320² 输入，Apache-2.0）。作为深度引擎的轻量兜底：当 V3 在浏览器端因显存/算子限制无法加载时，「一键电影感」会自动下载并切换到本模型，确保景深功能始终可用（精度略低于 V3，但体积极小、ORT Web 兼容性最佳）。',
    url: '/api/hf-proxy/onnx-community/depth-anything-v2-small/resolve/main/onnx/model.onnx',
    node: '图片节点 / 后期节点',
    purpose: '深度估计兜底引擎（V3 不可用时的自动回退）',
    localOnly: true,
    localRunner: 'depth-anything-v2',
    category: 'post-fx',
  },
  {
    id: 'birefnet-matting',
    name: 'BiRefNet 智能抠像（SOTA，本机暂不可用）',
    version: '1.4.0',
    size: '~1.0 GB',
    desc: '开源 SOTA 前景分割模型（BiRefNet，Apache-2.0，发丝与镂空细节最强），用于后期节点「一键智能抠像」与「逐帧视频抠像」。⚠️ 本机当前暂不可用：对该 927MB 模型做 int8 量化时，静态量化(quantize_static QDQ/QOperator)在本机 ORT 下确定性卡死、动态量化会产出 1GB 坏模型（原 fp32 权重未移除+无 DequantizeLinear 桥接），且 HuggingFace 仅提供 fp32/fp16 无现成 int8 可下载——故该引擎已临时禁用。当前「智能抠像」实际由 @imgly 的 ISNet(quint8) 兜底（小巧、浏览器原生支持、已验证可用）。如需启用 BiRefNet，需在有更强算力的机器上量化出真正的小体积 int8 模型后，将后端 LOCAL_MODEL_SOURCES 指回该文件。',
    url: '/api/local-model/birefnet-matting',
    node: '后期节点',
    purpose: '高精度 AI 智能抠像（本机暂由 @imgly 兜底）',
    localOnly: true,
    localRunner: 'rmbg',
    category: 'post-fx',
  },
  {
    id: 'raft-optical-flow',
    name: 'RAFT 光流估计',
    version: '1.0.0',
    size: '~64 MB',
    desc: '免费开源（Meta / OpenCV Zoo, MIT）光流模型，输出相邻帧运动矢量，用于后期节点「一键电影感·视频」的逐帧方向性真实运动模糊（物体越动越糊、静止越清）。',
    url: '/api/hf-proxy/opencv/optical_flow_estimation_raft/resolve/main/optical_flow_estimation_raft_2023aug.onnx',
    node: '后期节点',
    purpose: '运动模糊光流（RAFT）',
    localOnly: true,
    localRunner: 'raft',
    category: 'post-fx',
  },
  {
    id: 'rife-frame-interpolation',
    name: 'RIFE 帧插值（framegen）',
    version: '1.0.0',
    size: '运行时按需下载(~70MB)',
    desc: 'RIFE（Real-Time Intermediate Flow Estimation）光流插帧模型，用于「客户端 GPU 运动模糊管线」的 framegen 环节：在相邻帧间合成运动补偿的中间帧，再与首尾帧一起在 WebGPU 着色器里求均值，得到比线性光流采样更真实的快门拖影（物体越动越糊、静止越清）。它是「一键电影感·视频」的默认客户端运动模糊（WebGPU + RAFT 光流）的可选增强：勾选 useRife 时优先用「先插帧、再模糊」，RIFE 缺失/加载失败时自动回退 RAFT 光流，保证一键可用。如该默认地址不可用，可在面板改为其它 RIFE ONNX（需 3 输入：image0/image1/timestep）。',
    url: '/api/hf-proxy/TensorStack/RIFE/resolve/main/model.onnx',
    node: '后期节点',
    purpose: '运动模糊 / 插帧（framegen，可选增强）',
    localOnly: true,
    category: 'post-fx',
  },
  {
    id: 'webgpu-video-motion-blur',
    name: 'WebGPU 运动模糊管线（RAFT/RIFE + WebCodecs）',
    version: '1.0.0',
    size: '构建集成（npm: webm-muxer）',
    desc: '客户端 GPU 真实运动模糊管线（已落地，为一键电影感·视频的默认客户端运动模糊来源）。以 WebGPU 着色器实现「运动补偿的方向性模糊」：RAFT 光流路径（默认）沿光流把相邻帧回退多个子样本取均值；RIFE 插帧路径（可选增强）先合成中间帧再求均值。编码用 WebCodecs VideoEncoder + webm-muxer（即 WebAV 的编码内核）。优先级高于服务端 ffmpeg 模糊，且零服务端依赖；无 WebGPU 时自动回退服务端 ffmpeg 或客户端 RAFT JS 模糊。需 WebGPU 与 VideoEncoder 支持（Chrome/Edge）。',
    url: '',
    node: '后期节点',
    purpose: '客户端 GPU 真实运动模糊（默认路径）',
    localOnly: true,
    category: 'post-fx',
  },
  {
    id: 'novel-view-gen',
    name: '高保真新视角（生成式）',
    version: '1.0.0',
    size: '~1.2 GB（可选）',
    desc: '生成式新视角模型（Stable Zero123 / Zero123++ / 轻量 LCM 蒸馏 inpaint 的 ONNX 导出），用于大幅角度（侧面/背视角）补全被遮挡区域，输出完整图、无破损。按需下载，非必装。',
    url: '/api/hf-proxy/stability-ai/stable-zero123/resolve/main/onnx/model.onnx',
    node: '图片节点',
    purpose: '大幅角度新视角生成（T2 生成式补全，可选插件）',
    localOnly: true,
    category: 'image-node',
  },
  {
    id: 'nllb-200-translation',
    name: 'NLLB-200 翻译模型',
    version: '1.0.0',
    size: '~600MB',
    desc: '自动翻译提示词（中↔英），无需 API Key；首次下载后缓存于浏览器（Transformers.js）。',
    url: '',
    node: '提示词',
    purpose: '本地提示词翻译（中↔英，零 Key）',
    localOnly: true,
    browserRuntime: 'nllb',
    category: 'system',
  },

  // ===== 资产采集器后端依赖（pip 安装，服务端运行） =====
  {
    id: 'curator-dep-materialsearch',
    name: 'MaterialSearch 语义检索',
    version: '1.0.0',
    size: '~200 MB（含模型）',
    desc: '后端语义检索引擎：自然语言搜图/搜视频、以图搜图、画面风格识别（中式美学/赛博朋克/电影镜头等）。依赖 Chinese CLIP 模型，首次运行自动下载。',
    url: '',
    node: '资产库',
    purpose: '语义检索：文字搜图/以图搜图/风格识别',
    localOnly: true,
    category: 'backend-dep',
    pipPackage: 'materialsearch-core',
    pipOptional: true,
    curatorFeature: 'MaterialSearch 语义检索（/api/semantic/*）',
    status: 'pending',
  },
  {
    id: 'curator-dep-audiotagger',
    name: 'AudioTagger 音频智能打标',
    version: '1.0.0',
    size: '~1.5 GB（PyTorch + 模型）',
    desc: '后端音频智能分析：音色识别、氛围标签、音效类型分类、音质打分。基于 EfficientAT CNN14 + AudioSet 527 类标签，含启发式回退。',
    url: '',
    node: '资产库',
    purpose: '音频打标：音色/氛围/音效类型/音质打分',
    localOnly: true,
    category: 'backend-dep',
    pipPackage: 'torch torchaudio',
    pipInstallCmd: 'pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu',
    pipOptional: true,
    curatorFeature: 'AudioTagger 音频打标（/api/audio/*）',
    status: 'pending',
  },
  {
    id: 'curator-dep-model3d',
    name: '3D 模型分类器',
    version: '1.0.0',
    size: '~50 MB（trimesh + numpy）',
    desc: '后端 3D 模型自动分类：道具/场景/角色/材质/风格识别。基于 trimesh 几何分析 + 文件名推断，支持 OBJ/FBX/GLTF/STL/USD 等格式。',
    url: '',
    node: '资产库',
    purpose: '3D 分类：道具/场景/角色/材质/风格',
    localOnly: true,
    category: 'backend-dep',
    pipPackage: 'trimesh numpy pillow',
    pipOptional: true,
    curatorFeature: 'Model3DClassifier 3D 分类（/api/model3d/*）',
    status: 'pending',
  },
  {
    id: 'curator-dep-localmgr',
    name: '本地素材管理增强基座',
    version: '1.0.0',
    size: '纯 Python 标准库',
    desc: '后端本地素材管理增强：文件夹监听、MD5 去重、自动分类归档、批量操作（标签/移动/删除）。Billfish/零泉 内核魔改，与现有 archiver 协同。',
    url: '',
    node: '资产库',
    purpose: '本地素材管理：扫描/去重/归档/批量操作',
    localOnly: true,
    category: 'backend-dep',
    pipPackage: '',
    pipOptional: false,
    curatorFeature: 'LocalAssetManager 素材管理（/api/assets/*）',
  },
];

// 搜索插件/扩展包（内置，默认已安装）
export const SEARCH_EXTENSIONS: PresetModel[] = [
  {
    id: 'hmdao-free-search-pack',
    name: '免费搜图扩展包',
    version: '1.0.0',
    size: '内置',
    desc: '整合 Unsplash、Pexels、Pixabay、Openverse 等免费图库 API，支持关键词搜索和以图搜图。',
    url: '/api/extensions/free-search-pack',
    node: '资产库',
    purpose: '免费图库聚合搜索',
    category: 'search',
  },
  {
    id: 'hmdao-asset-search-engine',
    name: '智能搜索引擎',
    version: '1.0.0',
    size: '内置',
    desc: '增强本地搜索：模糊匹配 + 拼音搜索 + 布尔语法(tag:/type:/category:/-排除/"精确")，搜索范围覆盖 AI 分析结果。',
    url: '/api/extensions/asset-search-engine',
    node: '资产库',
    purpose: '本地增强搜索（模糊/拼音/布尔）',
    category: 'search',
  },
  {
    id: 'hmdao-ai-analysis-pack',
    name: 'AI 深度分析扩展包',
    version: '1.0.0',
    size: '内置',
    desc: '对接 Qwen3.7-Plus / GPT-4o / Qwen2.5-VL-72B 等视觉大模型，实现图片深度分析、提示词精准提取与相似图自动生成。',
    url: '/api/extensions/ai-analysis-pack',
    node: '图片节点',
    purpose: '图片深度分析与提示词提取',
    category: 'system',
  },
  {
    id: 'hmdao-asset-curator',
    name: '资产库智能归纳插件',
    version: '1.0.0',
    size: '内置',
    desc: '指定任意本地资产路径，自动识别、打标签、分类归纳并去重入库；一键联网补充检索相似素材，统一收敛分散的“相似搜索”能力。',
    url: '/api/extensions/asset-curator',
    node: '资产库',
    purpose: '本地资产批量识别/标签/归纳/去重 + 联网补充',
    category: 'asset',
  },
];
