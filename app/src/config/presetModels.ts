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

export type PresetModelCategory = 'image-node' | 'video' | 'audio' | 'search' | 'system';

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
  localRunner?: 'esrgan' | 'lama' | 'imgly';
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
];
