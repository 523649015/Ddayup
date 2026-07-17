// LEGACY NOTICE:
// Unreal Pixel Streaming proxy, player.html rewrite, and frontend bootstrap are kept only for explicit legacy compatibility.
// The normal Unreal path should stay on HMDao Unreal Capture + /ws/dcc/unreal editor-direct bridging.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import {
  promises as fs,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import Busboy from 'busboy';
import { unzipSync } from 'fflate';
import { createDccEnvironmentManager } from './dcc-plugin-manager.mjs';
import { createUnrealPixelStreamingLegacyModule } from './dcc/unreal-pixel-streaming-legacy.mjs';

const PORT = Number(process.env.HMDAO_API_PORT || 8792);
const APP_DIR = process.cwd();
const REPO_ROOT = path.resolve(APP_DIR, '..');
const DATA_DIR = path.resolve(APP_DIR, '.hmdao-data');
const LOCAL_VIDEO_EDIT_DIR = path.join(DATA_DIR, 'local-video-edits');
const LOCAL_VIDEO_RESULT_DIR = path.join(DATA_DIR, 'local-video-results');
const LOCAL_AUDIO_EDIT_DIR = path.join(DATA_DIR, 'local-audio-edits');
const LOCAL_AUDIO_RESULT_DIR = path.join(DATA_DIR, 'local-audio-results');
const LOCAL_IMAGE_ANALYSIS_DIR = path.join(DATA_DIR, 'local-image-analysis');
const LOCAL_POST_EDIT_DIR = path.join(DATA_DIR, 'local-post-edits');
const LOCAL_POST_RESULT_DIR = path.join(DATA_DIR, 'local-post-results');
const LOCAL_VIDEO_PARSE_SCRIPT = path.resolve(APP_DIR, 'server', 'local_video_parse.py');
const LOCAL_VIDEO_REMOVE_SUBTITLE_SCRIPT = path.resolve(APP_DIR, 'server', 'local_video_remove_subtitle.py');
const DEFAULT_ASSET_LIBRARY_STORAGE_DIR = process.env.HMDAO_ASSET_LIBRARY_DIR
  ? path.resolve(APP_DIR, process.env.HMDAO_ASSET_LIBRARY_DIR)
  : path.join(DATA_DIR, 'asset-library-files');
const ASSET_LIBRARY_SETTINGS_FILE = path.join(DATA_DIR, 'asset-library-settings.json');
const ASSET_LIBRARY_CATALOG_FILE = path.join(DATA_DIR, 'asset-library-catalog.json');

// Free image search API base URLs
const UNSPLASH_BASE = 'https://api.unsplash.com';
const PEXELS_BASE = 'https://api.pexels.com';
const PIXABAY_BASE = 'https://pixabay.com/api';
const OPENVERSE_BASE = 'https://api.openverse.org/v1';
const WIKIMEDIA_BASE = 'https://commons.wikimedia.org/w/api.php';
const ASSET_LIBRARY_TEMP_DIR = path.join(DATA_DIR, 'asset-library-imports');
const APIMART_CONDITIONING_DIR = path.join(DATA_DIR, 'apimart-conditioning');
const ACTIVATED_PROVIDERS_FILE = path.join(DATA_DIR, 'activated-providers.json');
const RELAY_HTTP_TEMP_DIR = path.join(DATA_DIR, 'relay-http');
const OPERATION_DISPATCH_CONFIG_FILE = process.env.HMDAO_OPERATION_DISPATCH_CONFIG
  ? path.resolve(APP_DIR, process.env.HMDAO_OPERATION_DISPATCH_CONFIG)
  : path.resolve(APP_DIR, 'server', 'operation-dispatch.config.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const UNREAL_CONFIG_FILE = path.join(DATA_DIR, 'unreal-config.json');
const sessions = new Map();
const activatedProviders = new Map();
let activatedProvidersHydrated = false;
const workflowRuns = new Map();
const workflowSocketSubscriptions = new Map();
const catalogSocketSubscriptions = new Map();
const ENABLE_UNREAL_PIXEL_STREAMING_LEGACY = process.env.HMDAO_ENABLE_UNREAL_PIXEL_STREAMING_LEGACY === '1';

const providers = [
  { id: 'deepseek', name: 'DeepSeek', domestic: true, modes: ['llm'] },
  { id: 'siliconflow', name: '硅基流动', domestic: true, modes: ['llm', 'image', 'video'] },
  { id: 'zhipu', name: 'Zhipu AI', domestic: true, modes: ['llm', 'image', 'video'] },
  { id: 'bailian', name: 'Bailian', domestic: true, modes: ['llm', 'image', 'video'] },
  { id: 'minimax', name: 'MiniMax', domestic: true, modes: ['llm', 'audio'] },
  { id: 'volcengine', name: '火山方舟', domestic: true, modes: ['image', 'video', 'audio'] },
  { id: 'kling', name: 'Kling AI', domestic: true, modes: ['image', 'video'] },
  { id: 'modelscope', name: 'ModelScope', domestic: true, modes: ['llm', 'image', 'video'] },
  { id: 'openai', name: 'OpenAI', domestic: false, modes: ['llm', 'image'] },
  { id: 'fal', name: 'fal.ai', domestic: false, modes: ['image', 'video'] },
  { id: 'replicate', name: 'Replicate', domestic: false, modes: ['image', 'video'] },
];

const PROVIDER_BASE_URLS = {
  deepseek: 'https://api.deepseek.com/v1',
  siliconflow: 'https://api.siliconflow.cn/v1',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  bailian: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  minimax: 'https://api.minimax.chat/v1',
  openai: 'https://api.openai.com/v1',
  kling: 'https://api.klingai.com/v1',
  volcengine: 'https://ark.cn-beijing.volces.com/api/v3',
  modelscope: 'https://api-inference.modelscope.cn/v1',
  fal: 'https://fal.run',
  replicate: 'https://api.replicate.com/v1',
};

function createImageCapabilities(overrides = {}) {
  return {
    generationModes: ['textToImage', 'imageToImage', 'inpaint', 'outpaint'],
    referenceRoles: ['style', 'subject', 'element', 'composition', 'lighting', 'omni'],
    toolOperations: [
      'panorama_720',
      'multi_angle_view',
      'pbr_relight',
      'storyboard_grid',
      'hd_toolbox_enhance',
      'hd_upscale',
      'hd_outpaint',
      'hd_inpaint',
      'hd_erase',
      'hd_cutout',
      'hd_crop',
      'hd_restore',
      'smart_grid_split',
      'cinematic_camera_simulation',
    ],
    supportsMultiReference: false,
    supportsOmniReference: false,
    supportsSubjectLock: false,
    supportsCompositionLock: false,
    supportsLightingControl: false,
    supportsConsistencyEnhancement: false,
    supportsIdentityController: false,
    supportsLocalEditing: false,
    supportsRemoteEditing: true,
    supportsStageValidation: true,
    bestFor: [],
    limitations: [],
    ...overrides,
  };
}

function createVideoCapabilities(overrides = {}) {
  return {
    generationModes: [],
    referenceRoles: [],
    toolOperations: [
      'ffmpeg_lossless_trim_wavesurfer',
      'ffmpeg_pixel_crop_cropper',
      'real_cugan_rife_codeformer_enhance',
      'opencv_scenedetect_keyframe_parse',
      'opencv_telea_subtitle_remove',
      'demucs_v4_audio_split',
    ],
    supportsMultiReference: false,
    supportsOmniReference: false,
    supportsSubjectLock: false,
    supportsCompositionLock: false,
    supportsLightingControl: false,
    supportsConsistencyEnhancement: false,
    supportsCameraMotionLockEnhancement: false,
    supportsIdentityController: false,
    supportsTextToVideo: false,
    supportsImageToVideo: false,
    supportsFirstLastFrame: false,
    supportsReferenceVideo: false,
    supportsReferenceImage: false,
    supportsVideoStyleTransfer: false,
    supportsPrimaryVideoMotionLock: false,
    supportsActionTransfer: false,
    supportsLocalEditing: false,
    supportsRemoteEditing: true,
    supportsStageValidation: true,
    bestFor: [],
    limitations: [],
    ...overrides,
  };
}

const MODEL_CATALOG = [
  {
    id: 'deepseek-chat',
    name: 'DeepSeek Chat',
    provider: 'deepseek',
    mode: 'llm',
    nodeTypes: ['text', 'script', 'storyboard', 'aiapp'],
    description: 'General text generation and reasoning.',
    latency: '2s',
    price: 0.02,
    currency: 'CNY',
    discountLabel: 'New user 9x',
    discountPercent: 10,
  },
  {
    id: 'gemini-31',
    name: 'Gemini 3.1',
    provider: 'openai',
    mode: 'llm',
    nodeTypes: ['text', 'script', 'storyboard', 'aiapp'],
    description: 'OpenAI-compatible multimodal reasoning model routed through relay endpoints.',
    latency: '3s',
    price: 0.08,
    currency: 'USD',
    upstreamModel: 'gemini-3.1',
  },
  {
    id: 'lib-image',
    name: 'Qwen 图片',
    provider: 'siliconflow',
    mode: 'image',
    nodeTypes: ['image'],
    description: '硅基流动托管的 Qwen 原生图片生成',
    latency: '12s',
    price: 0.28,
    currency: 'CNY',
    discountLabel: 'Limited 85x',
    discountPercent: 15,
    upstreamModel: 'Qwen/Qwen-Image',
    capabilities: createImageCapabilities({
      supportsMultiReference: true,
      supportsOmniReference: true,
      supportsSubjectLock: true,
      supportsLightingControl: true,
      supportsConsistencyEnhancement: true,
      supportsIdentityController: true,
      bestFor: ['中文海报', '多参考图像生成', '参考主体锁定', '保构图换主体', '全能参数'],
      limitations: ['严格构图锁死弱于专用编辑模型'],
    }),
  },
  {
    id: 'doubao-seedream-5-0-lite',
    name: 'Seedream 5.0 Lite',
    provider: 'volcengine',
    mode: 'image',
    nodeTypes: ['image'],
    description: 'High quality product and scene images with stronger edit routing for multi-reference work.',
    latency: '18s',
    price: 0.36,
    currency: 'CNY',
    upstreamModel: 'doubao-seedream-5.0-lite',
    capabilities: createImageCapabilities({
      supportsMultiReference: true,
      supportsOmniReference: true,
      supportsSubjectLock: true,
      supportsCompositionLock: true,
      supportsLightingControl: true,
      supportsConsistencyEnhancement: true,
      toolOperations: ['multi_angle_view', 'pbr_relight', 'storyboard_grid', 'hd_toolbox_enhance', 'cinematic_camera_simulation'],
      bestFor: ['商品图', '高质感场景', '打光强化', '构图细化', '保构图换主体', '全能参数'],
    }),
  },
  {
    id: 'doubao-seedream-5-0-pro',
    name: 'Seedream 5.0 Pro',
    provider: 'volcengine',
    mode: 'image',
    nodeTypes: ['image'],
    description: '火山方舟 Seedream 5.0 旗舰图片模型，最高质感与最强语义理解，适合品牌 KV、广告大片与复杂多参考工作流。',
    latency: '22s',
    price: 0.6,
    currency: 'CNY',
    upstreamModel: 'doubao-seedream-5.0-pro',
    capabilities: createImageCapabilities({
      supportsMultiReference: true,
      supportsOmniReference: true,
      supportsSubjectLock: true,
      supportsCompositionLock: true,
      supportsLightingControl: true,
      supportsConsistencyEnhancement: true,
      supportsIdentityController: true,
      toolOperations: ['multi_angle_view', 'pbr_relight', 'storyboard_grid', 'hd_toolbox_enhance', 'cinematic_camera_simulation'],
      bestFor: ['品牌 KV', '广告大片', '高质感商品图', '复杂多参考', '保构图换主体', '全能参考'],
    }),
  },
  {
    id: 'doubao-seedance-2-0',
    name: '豆包 Seedance 2.0',
    provider: 'volcengine',
    mode: 'video',
    nodeTypes: ['video'],
    description: '火山方舟 Seedance 2.0 视频生成模型，支持文生视频、图生视频与首尾帧控制，适合中文商业片、角色参考与镜头延展。',
    latency: '60s',
    price: 2.8,
    currency: 'CNY',
    upstreamModel: 'doubao-seedance-2.0',
    capabilities: createVideoCapabilities({
      generationModes: ['textToVideo', 'imageToVideo', 'firstLastFrame'],
      referenceRoles: ['style', 'subject', 'composition', 'lighting', 'omni'],
      supportsMultiReference: true,
      supportsOmniReference: true,
      supportsSubjectLock: true,
      supportsCompositionLock: true,
      supportsLightingControl: true,
      supportsConsistencyEnhancement: true,
      supportsIdentityController: true,
      supportsTextToVideo: true,
      supportsImageToVideo: true,
      supportsFirstLastFrame: true,
      supportsReferenceImage: true,
      supportsReferenceVideo: false,
      supportsVideoStyleTransfer: false,
      supportsPrimaryVideoMotionLock: false,
      supportsActionTransfer: false,
      bestFor: ['中文商业片', '图生视频', '首尾帧控制', '角色参考', '镜头延展'],
    }),
  },
  {
    id: 'doubao-audio-1-0',
    name: '豆包 音频生成 1.0',
    provider: 'volcengine',
    mode: 'audio',
    nodeTypes: ['audio'],
    description: '火山方舟 豆包音频生成 1.0，支持 TTS 语音合成、配音与 BGM 生成，适合中文有声内容、配音与短视频音轨。',
    latency: '8s',
    price: 0.12,
    currency: 'CNY',
    upstreamModel: 'doubao-audio-1.0',
    capabilities: {
      generationModes: ['textToAudio', 'voiceClone'],
      supportsTextToAudio: true,
      supportsVoiceClone: true,
      supportsBgm: true,
      bestFor: ['中文 TTS', '配音', '短视频音轨', '有声内容'],
      limitations: ['不支持视频生成'],
    },
  },
  {
    id: 'gpt-image-2',
    name: 'GPT Image 2',
    provider: 'openai',
    mode: 'image',
    nodeTypes: ['image'],
    description: 'OpenAI-compatible image generation and editing through relay endpoints.',
    latency: '14s',
    price: 0.45,
    currency: 'USD',
    upstreamModel: 'gpt-image-2',
    capabilities: createImageCapabilities({
      supportsMultiReference: true,
      supportsOmniReference: true,
      supportsSubjectLock: true,
      supportsCompositionLock: true,
      supportsLightingControl: true,
      supportsConsistencyEnhancement: true,
      supportsIdentityController: true,
      bestFor: ['商品图', '局部改图', '保构图换主体', '多模态图片编辑', '全能参数'],
    }),
  },
  {
    id: 'grok-imagine-1.5-edit-apimart',
    name: 'Grok Imagine 1.5 Edit',
    provider: 'openai',
    mode: 'image',
    nodeTypes: ['image'],
    description: 'Relay-edit image model optimized for instruction-heavy and multi-reference image editing.',
    latency: '18s',
    price: 0.52,
    currency: 'USD',
    upstreamModel: 'grok-imagine-1.5-edit-apimart',
    capabilities: createImageCapabilities({
      supportsMultiReference: true,
      supportsOmniReference: true,
      supportsSubjectLock: true,
      supportsCompositionLock: true,
      supportsLightingControl: true,
      supportsConsistencyEnhancement: true,
      supportsIdentityController: true,
      bestFor: ['复杂编辑', '保构图换主体', '多参考改图', '全能参数'],
    }),
  },
  {
    id: 'gemini-3-pro-image-preview',
    name: 'Gemini 3 Pro Image Preview',
    provider: 'openai',
    mode: 'image',
    nodeTypes: ['image'],
    description: 'OpenAI-compatible relay preview model for multimodal image understanding and draft editing.',
    latency: '15s',
    price: 0.32,
    currency: 'USD',
    upstreamModel: 'gemini-3-pro-image-preview',
    capabilities: createImageCapabilities({
      supportsMultiReference: true,
      supportsOmniReference: true,
      supportsSubjectLock: true,
      supportsLightingControl: true,
      supportsConsistencyEnhancement: true,
      bestFor: ['多模态预览', '结构理解', '参考分析', '草案编辑'],
      limitations: ['严格构图锁死弱于专用编辑模型'],
    }),
  },
  {
    id: 'midjourney-relax',
    name: 'Midjourney Relax',
    provider: 'openai',
    mode: 'image',
    nodeTypes: ['image'],
    description: 'Relay-based Midjourney image generation candidate.',
    latency: '20s',
    price: 0.5,
    currency: 'USD',
    upstreamModel: 'midjourney-relax',
    capabilities: createImageCapabilities({
      bestFor: ['风格化创作', '概念图', '海报初稿'],
      limitations: ['多参考主体锁定较弱'],
    }),
  },
  {
    id: 'nano-banana2',
    name: 'Nano Banana 2',
    provider: 'openai',
    mode: 'image',
    nodeTypes: ['image'],
    description: 'Creative relay image model for lightweight visual ideation.',
    latency: '12s',
    price: 0.22,
    currency: 'USD',
    upstreamModel: 'nano-banana2',
    capabilities: createImageCapabilities({
      bestFor: ['创意草图', '轻量商品图', '风格探索'],
    }),
  },
  {
    id: 'flux-pro',
    name: 'FLUX Pro',
    provider: 'fal',
    mode: 'image',
    nodeTypes: ['image'],
    description: 'Poster and photorealistic generation.',
    latency: '20s',
    price: 0.38,
    currency: 'CNY',
    discountLabel: 'Member 88x',
    discountPercent: 12,
    capabilities: createImageCapabilities({
      supportsMultiReference: true,
      supportsOmniReference: true,
      supportsSubjectLock: true,
      supportsCompositionLock: true,
      supportsLightingControl: true,
      supportsConsistencyEnhancement: true,
      supportsIdentityController: true,
      bestFor: ['海报', '写实图像', '角色一致性', '保构图换主体', '全能参数'],
    }),
  },
  {
    id: 'wanx-v1',
    name: '通义万相',
    provider: 'bailian',
    mode: 'image',
    nodeTypes: ['image'],
    description: 'Chinese prompt image generation.',
    latency: '15s',
    price: 0.3,
    currency: 'CNY',
    capabilities: createImageCapabilities({
      toolOperations: ['storyboard_grid', 'hd_toolbox_enhance', 'smart_grid_split'],
      bestFor: ['中文文生图', '轻量图片生成'],
      limitations: ['复杂多参考控制较弱', '严格保构图换主体能力有限'],
    }),
  },
  {
    id: 'qwen3.7-plus',
    name: 'Qwen3.7-Plus',
    provider: 'bailian',
    mode: 'llm',
    nodeTypes: ['text', 'script', 'storyboard', 'aiapp'],
    description: '百炼最新旗舰多模态模型，支持图片/视频深度分析、提示词反推、光影构图风格解析，中文理解领先。',
    latency: '3s',
    price: 0.008,
    currency: 'CNY',
    upstreamModel: 'qwen3.7-plus',
    discountLabel: '新用户免费',
    discountPercent: 100,
  },
  {
    id: 'wan22-t2v-a14b',
    name: 'Wan 2.2 文生视频',
    provider: 'siliconflow',
    mode: 'video',
    nodeTypes: ['video'],
    description: '硅基流动 Wan2.2 文生视频模型，适合广告短片与镜头预演',
    latency: '88s',
    price: 0.29,
    currency: 'USD',
    upstreamModel: 'Wan-AI/Wan2.2-T2V-A14B',
    capabilities: createVideoCapabilities({
      generationModes: ['textToVideo'],
      supportsTextToVideo: true,
      bestFor: ['文生视频预览', '广告分镜预演'],
      limitations: ['不支持主视频运镜锁定', '不支持身份控制器'],
    }),
  },
  {
    id: 'wan22-i2v-a14b',
    name: 'Wan 2.2 图生视频',
    provider: 'siliconflow',
    mode: 'video',
    nodeTypes: ['video'],
    description: '硅基流动 Wan2.2 图生视频模型，适合首尾帧、参考图和风格延展',
    latency: '95s',
    price: 0.29,
    currency: 'USD',
    upstreamModel: 'Wan-AI/Wan2.2-I2V-A14B',
    capabilities: createVideoCapabilities({
      generationModes: ['imageToVideo', 'firstLastFrame'],
      referenceRoles: ['style', 'subject', 'composition', 'lighting'],
      supportsMultiReference: true,
      supportsSubjectLock: true,
      supportsCompositionLock: true,
      supportsLightingControl: true,
      supportsConsistencyEnhancement: true,
      supportsImageToVideo: true,
      supportsFirstLastFrame: true,
      supportsReferenceImage: true,
      bestFor: ['图生视频', '首尾帧过渡', '风格延展'],
      limitations: ['不支持主视频运镜锁定', '不支持视频风格迁移'],
    }),
  },
  {
    id: 'bailian-wan22-t2v-plus',
    name: '百炼 Wan 2.2 文生视频',
    provider: 'bailian',
    mode: 'video',
    nodeTypes: ['video'],
    description: '阿里云百炼 Wan 2.2 文生视频模型，余额不足时自动回退到硅基流动 Wan2.2',
    latency: '90s',
    price: 1.4,
    currency: 'CNY',
    upstreamModel: 'wan2.2-t2v-plus',
    capabilities: createVideoCapabilities({
      generationModes: ['textToVideo'],
      supportsTextToVideo: true,
      bestFor: ['文生视频预览', '中文商业片草稿'],
      limitations: ['不支持主视频运镜锁定', '不支持身份控制器'],
    }),
  },
  {
    id: 'bailian-wan22-i2v-plus',
    name: '百炼 Wan 2.2 图生视频',
    provider: 'bailian',
    mode: 'video',
    nodeTypes: ['video'],
    description: '阿里云百炼 Wan 2.2 图生视频模型，支持参考图/首帧驱动视频生成',
    latency: '100s',
    price: 1.8,
    currency: 'CNY',
    upstreamModel: 'wan2.2-i2v-plus',
    capabilities: createVideoCapabilities({
      generationModes: ['imageToVideo', 'firstLastFrame'],
      referenceRoles: ['style', 'subject', 'composition', 'lighting'],
      supportsMultiReference: true,
      supportsSubjectLock: true,
      supportsCompositionLock: true,
      supportsLightingControl: true,
      supportsConsistencyEnhancement: true,
      supportsImageToVideo: true,
      supportsFirstLastFrame: true,
      supportsReferenceImage: true,
      bestFor: ['中文图生视频', '首尾帧生成'],
      limitations: ['不支持主视频运镜锁定', '不支持视频风格迁移'],
    }),
  },
  {
    id: 'seedance-v2',
    name: 'Seedance V2',
    provider: 'fal',
    mode: 'video',
    nodeTypes: ['video'],
    description: 'Image-to-video and camera motion.',
    latency: '55s',
    price: 2.8,
    currency: 'CNY',
    upstreamModel: 'doubao-seedance-2.0',
    capabilities: createVideoCapabilities({
      // 实测验证：APIMart relay 的 doubao-seedance-2.0 不支持 video_urls（HTTP 400）
      // 仅支持 imageToVideo / firstLastFrame (image_with_roles)
      generationModes: ['imageToVideo', 'firstLastFrame'],
      referenceRoles: ['style', 'subject', 'composition', 'lighting', 'omni'],
      supportsMultiReference: true,
      supportsOmniReference: true,
      supportsSubjectLock: true,
      supportsCompositionLock: true,
      supportsLightingControl: true,
      supportsConsistencyEnhancement: true,
      supportsCameraMotionLockEnhancement: false,
      supportsIdentityController: true,
      supportsImageToVideo: true,
      supportsFirstLastFrame: true,
      supportsReferenceVideo: false,
      supportsReferenceImage: true,
      supportsVideoStyleTransfer: false,
      supportsPrimaryVideoMotionLock: false,
      supportsActionTransfer: false,
      bestFor: ['图生视频', '首尾帧控制', '主体一致性', '角色参考'],
    }),
  },
  {
    id: 'happyhorse-11',
    name: 'HappyHorse 1.1',
    provider: 'bailian',
    mode: 'video',
    nodeTypes: ['video'],
    description: 'Unified APIMart/Bailian video model that supports T2V, I2V, R2V, and edit style routing.',
    latency: '70s',
    price: 1.6,
    currency: 'CNY',
    upstreamModel: 'happyhorse-1.1',
    capabilities: createVideoCapabilities({
      generationModes: ['textToVideo', 'imageToVideo', 'referenceVideo', 'videoStyleTransfer'],
      referenceRoles: ['subject', 'style', 'composition', 'motion', 'omni'],
      supportsMultiReference: true,
      supportsOmniReference: true,
      supportsSubjectLock: true,
      supportsCompositionLock: true,
      supportsConsistencyEnhancement: true,
      supportsCameraMotionLockEnhancement: true,
      supportsTextToVideo: true,
      supportsImageToVideo: true,
      supportsReferenceVideo: true,
      supportsReferenceImage: true,
      supportsVideoStyleTransfer: true,
      supportsPrimaryVideoMotionLock: true,
      supportsActionTransfer: true,
      bestFor: ['多模态视频参考', '动作迁移', '视频编辑', '首帧驱动', '全能参数'],
    }),
  },
  {
    id: 'kling-v3-omni',
    name: 'Kling V3 Omni',
    provider: 'kling',
    mode: 'video',
    nodeTypes: ['video'],
    description: 'Primary-video-preserving multi-reference video editing with omni conditioning.',
    latency: '60s',
    price: 3,
    currency: 'CNY',
    upstreamModel: 'kling-v3-omni',
    discountLabel: 'Limited 9x',
    discountPercent: 10,
    capabilities: createVideoCapabilities({
      generationModes: ['textToVideo', 'imageToVideo', 'firstLastFrame', 'referenceVideo', 'videoStyleTransfer'],
      referenceRoles: ['style', 'subject', 'composition', 'lighting', 'motion', 'rhythm', 'omni'],
      supportsMultiReference: true,
      supportsOmniReference: true,
      supportsSubjectLock: true,
      supportsCompositionLock: true,
      supportsLightingControl: true,
      supportsConsistencyEnhancement: true,
      supportsCameraMotionLockEnhancement: true,
      supportsIdentityController: true,
      supportsTextToVideo: true,
      supportsImageToVideo: true,
      supportsFirstLastFrame: true,
      supportsReferenceVideo: true,
      supportsReferenceImage: true,
      supportsVideoStyleTransfer: true,
      supportsPrimaryVideoMotionLock: true,
      supportsActionTransfer: true,
      bestFor: ['主体锁定', '主视频运镜保持', '动作迁移', '多参考换角', '全能参数'],
    }),
  },
  {
    id: 'kling-o3',
    name: 'Kling O3',
    provider: 'kling',
    mode: 'video',
    nodeTypes: ['video'],
    description: 'Realistic motion and first-last frame video.',
    latency: '60s',
    price: 3,
    currency: 'CNY',
    upstreamModel: 'kling-v3',
    discountLabel: 'Limited 9x',
    discountPercent: 10,
    capabilities: createVideoCapabilities({
      generationModes: ['textToVideo', 'imageToVideo', 'firstLastFrame', 'referenceVideo', 'videoStyleTransfer'],
      referenceRoles: ['style', 'subject', 'composition', 'lighting', 'motion', 'rhythm', 'omni'],
      supportsMultiReference: true,
      supportsOmniReference: true,
      supportsSubjectLock: true,
      supportsCompositionLock: true,
      supportsLightingControl: true,
      supportsConsistencyEnhancement: true,
      supportsCameraMotionLockEnhancement: true,
      supportsIdentityController: true,
      supportsTextToVideo: true,
      supportsImageToVideo: true,
      supportsFirstLastFrame: true,
      supportsReferenceVideo: true,
      supportsReferenceImage: true,
      supportsVideoStyleTransfer: true,
      supportsPrimaryVideoMotionLock: true,
      supportsActionTransfer: true,
      bestFor: ['主体锁定', '主视频运镜保持', '动作迁移', '高要求参考视频编辑', '全能参数'],
    }),
  },
];
const IMAGE_OPERATION_DISPATCH = {
  panorama_720: {
    label: '720 panorama generation',
    latestTechnique: 'Single-image spherical panorama using geometry-aware scene extension and seam-constrained diffusion outpainting.',
    candidates: ['flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'lib-image'],
  },
  multi_angle_view: {
    label: 'consistent multi-angle generation',
    latestTechnique: 'Geometry-consistent multi-view diffusion with identity locking, camera-conditioned view synthesis, and reference feature anchoring.',
    candidates: ['flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'lib-image'],
  },
  pbr_relight: {
    label: 'PBR relighting',
    latestTechnique: 'Relightable representation with intrinsic decomposition, normal-aware shading reconstruction, and material-preserving highlight transfer.',
    candidates: ['doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'flux-pro', 'gpt-image-2', 'lib-image'],
  },
  storyboard_grid: {
    label: 'cinematic storyboard batching',
    latestTechnique: 'Reference-consistent storyboard generation with shot-language prompting and panel-level composition control.',
    candidates: ['doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'flux-pro', 'gpt-image-2', 'lib-image', 'wanx-v1'],
  },
  hd_toolbox_enhance: {
    label: 'HD toolbox enhance',
    latestTechnique: 'Hybrid super-resolution and restoration using detail hallucination control with face-preserving refinement.',
    candidates: ['flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'lib-image'],
  },
  hd_upscale: {
    label: 'HD upscale',
    latestTechnique: 'Super-resolution with face-aware detail preservation and texture-consistent sharpening.',
    candidates: ['flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'lib-image'],
  },
  hd_outpaint: {
    label: 'HD outpaint',
    latestTechnique: 'Composition-aware outpainting with boundary extrapolation and perspective continuity control.',
    candidates: ['flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'lib-image'],
  },
  hd_inpaint: {
    label: 'HD inpaint',
    latestTechnique: 'Localized inpainting with context-aware fill and subject boundary recovery.',
    candidates: ['flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'lib-image'],
  },
  hd_erase: {
    label: 'HD erase',
    latestTechnique: 'Object removal with semantic masking and background completion.',
    candidates: ['flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'lib-image'],
  },
  hd_cutout: {
    label: 'HD cutout',
    latestTechnique: 'Foreground extraction with matting refinement and edge fidelity recovery.',
    candidates: ['flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'lib-image'],
  },
  hd_crop: {
    label: 'HD crop',
    latestTechnique: 'Cropping and reframing with composition-preserving subject alignment.',
    candidates: ['flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'lib-image'],
  },
  hd_restore: {
    label: 'HD restore',
    latestTechnique: 'Restoration-first enhancement with denoise, deblur, and artifact suppression.',
    candidates: ['flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'lib-image'],
  },
  smart_grid_split: {
    label: 'subject-aware grid split',
    latestTechnique: 'Subject-aware composition analysis with face-safe cut line planning and export-ready tile layout.',
    candidates: ['lib-image', 'gpt-image-2', 'flux-pro', 'wanx-v1'],
  },
  cinematic_camera_simulation: {
    label: 'cinematic camera simulation',
    latestTechnique: 'Lens-character post-simulation with depth-aware bokeh, optical aberration shaping, and filmic color-science LUT mapping.',
    candidates: ['flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'lib-image'],
  },
  preserveCompositionReplaceSubject: {
    label: 'preserve composition replace subject',
    latestTechnique: 'Reference-conditioned image editing that locks composition, framing, and perspective while replacing only the hero subject using stronger identity and layout control.',
    candidates: ['flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'grok-imagine-1.5-edit-apimart', 'lib-image'],
  },
};

let operationDispatchConfigCache = null;
let operationDispatchConfigCacheMtime = 0;

function buildDefaultOperationDispatchConfig() {
  return {
    version: 1,
    global: {
      weights: {
        activation: 1200,
        preferredModel: 260,
        preferredProvider: 140,
        regionMatch: 90,
        regionMismatch: -80,
        cost: -22,
        latency: -9,
        disabled: -100000,
        referenceRole: 180,
        generationMode: 260,
      },
      referenceRouting: {
        image: {
          style: { preferredProviders: ['fal', 'openai', 'volcengine', 'siliconflow'], preferredModels: ['flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'Qwen/Qwen-Image'] },
          subject: { preferredProviders: ['fal', 'openai', 'volcengine', 'siliconflow'], preferredModels: ['flux-pro', 'gpt-image-2', 'grok-imagine-1.5-edit-apimart', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'Qwen/Qwen-Image'] },
          element: { preferredProviders: ['volcengine', 'openai', 'fal', 'siliconflow'], preferredModels: ['doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'gpt-image-2', 'flux-pro', 'Qwen/Qwen-Image'] },
          composition: { preferredProviders: ['fal', 'openai', 'volcengine', 'siliconflow'], preferredModels: ['flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'Qwen/Qwen-Image'] },
          lighting: { preferredProviders: ['volcengine', 'fal', 'openai', 'siliconflow'], preferredModels: ['doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'flux-pro', 'gpt-image-2', 'Qwen/Qwen-Image'] },
        },
        video: {
          style: { preferredProviders: ['kling', 'bailian', 'fal', 'siliconflow'], preferredModels: ['kling-v3-omni', 'seedance-v2', 'kling-o3', 'happyhorse-11', 'wan2.2-i2v-plus', 'Wan-AI/Wan2.2-I2V-A14B'] },
          subject: { preferredProviders: ['kling', 'bailian', 'fal', 'siliconflow'], preferredModels: ['kling-v3-omni', 'seedance-v2', 'kling-o3', 'happyhorse-11', 'wan2.2-i2v-plus', 'Wan-AI/Wan2.2-I2V-A14B'] },
          composition: { preferredProviders: ['kling', 'bailian', 'fal', 'siliconflow'], preferredModels: ['kling-v3-omni', 'seedance-v2', 'kling-o3', 'happyhorse-11', 'wan2.2-i2v-plus', 'Wan-AI/Wan2.2-I2V-A14B'] },
          lighting: { preferredProviders: ['kling', 'bailian', 'fal', 'siliconflow'], preferredModels: ['kling-v3-omni', 'seedance-v2', 'kling-o3', 'happyhorse-11', 'wan2.2-i2v-plus', 'Wan-AI/Wan2.2-I2V-A14B'] },
          motion: { preferredProviders: ['kling', 'bailian', 'fal', 'siliconflow'], preferredModels: ['kling-v3-omni', 'seedance-v2', 'kling-o3', 'happyhorse-11', 'wan2.2-i2v-plus', 'Wan-AI/Wan2.2-I2V-A14B'] },
          rhythm: { preferredProviders: ['kling', 'bailian', 'fal', 'siliconflow'], preferredModels: ['kling-v3-omni', 'seedance-v2', 'kling-o3', 'happyhorse-11', 'wan2.2-i2v-plus', 'Wan-AI/Wan2.2-I2V-A14B'] },
        },
        videoGenerationModes: {
          textToVideo: { preferredProviders: ['siliconflow', 'bailian', 'kling', 'fal'], preferredModels: ['Wan-AI/Wan2.2-T2V-A14B', 'wan2.2-t2v-plus', 'kling-o3'] },
          imageToVideo: { preferredProviders: ['kling', 'bailian', 'fal', 'siliconflow'], preferredModels: ['kling-o3', 'happyhorse-11', 'seedance-v2', 'wan2.2-i2v-plus', 'Wan-AI/Wan2.2-I2V-A14B'] },
          firstLastFrame: { preferredProviders: ['kling', 'bailian', 'fal', 'siliconflow'], preferredModels: ['kling-o3', 'happyhorse-11', 'seedance-v2', 'wan2.2-i2v-plus', 'Wan-AI/Wan2.2-I2V-A14B'] },
          referenceVideo: { preferredProviders: ['kling', 'bailian', 'fal', 'siliconflow'], preferredModels: ['kling-v3-omni', 'seedance-v2', 'kling-o3', 'happyhorse-11', 'wan2.2-i2v-plus', 'Wan-AI/Wan2.2-I2V-A14B'] },
          videoStyleTransfer: { preferredProviders: ['kling', 'bailian', 'fal', 'replicate'], preferredModels: ['kling-v3-omni', 'seedance-v2', 'kling-o3', 'happyhorse-11'] },
        },
      },
      regionPreference: {
        CN: {
          preferredProviders: ['siliconflow', 'volcengine', 'bailian', 'kling'],
          secondaryProviders: ['openai', 'fal', 'replicate'],
        },
        US: {
          preferredProviders: ['openai', 'fal', 'replicate'],
          secondaryProviders: ['siliconflow', 'volcengine', 'bailian', 'kling'],
        },
        OTHER: {
          preferredProviders: ['openai', 'fal', 'replicate', 'siliconflow'],
          secondaryProviders: ['volcengine', 'bailian', 'kling'],
        },
      },
      disabledModels: [],
    },
    operations: Object.fromEntries(
      Object.entries(IMAGE_OPERATION_DISPATCH).map(([operation, strategy]) => [
        operation,
        {
          ...strategy,
          candidates: [...(strategy.candidates || [])],
          preferredProviders: [],
          disabledModels: [],
        },
      ]),
    ),
  };
}

function normalizeOperationDispatchConfig(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const defaults = buildDefaultOperationDispatchConfig();
  const sourceGlobal = source.global && typeof source.global === 'object' && !Array.isArray(source.global) ? source.global : {};
  const sourceOperations = source.operations && typeof source.operations === 'object' && !Array.isArray(source.operations) ? source.operations : {};

  const operations = { ...defaults.operations };

  for (const [operation, strategy] of Object.entries(sourceOperations)) {
    const normalizedStrategy = strategy && typeof strategy === 'object' && !Array.isArray(strategy) ? strategy : {};
    const baseStrategy = defaults.operations[operation] || {
      label: operation,
      latestTechnique: '',
      candidates: [],
      preferredProviders: [],
      disabledModels: [],
    };

    operations[operation] = {
      ...baseStrategy,
      ...normalizedStrategy,
      candidates: Array.isArray(normalizedStrategy.candidates)
        ? normalizedStrategy.candidates.filter(Boolean)
        : [...(baseStrategy.candidates || [])],
      preferredProviders: Array.isArray(normalizedStrategy.preferredProviders)
        ? normalizedStrategy.preferredProviders.filter(Boolean)
        : [...(baseStrategy.preferredProviders || [])],
      disabledModels: Array.isArray(normalizedStrategy.disabledModels)
        ? normalizedStrategy.disabledModels.filter(Boolean)
        : [...(baseStrategy.disabledModels || [])],
    };
  }

  return {
    version: Number(source.version || defaults.version) || defaults.version,
    global: {
      weights: {
        ...defaults.global.weights,
        ...(sourceGlobal.weights && typeof sourceGlobal.weights === 'object' && !Array.isArray(sourceGlobal.weights) ? sourceGlobal.weights : {}),
      },
      referenceRouting: {
        ...defaults.global.referenceRouting,
        ...(sourceGlobal.referenceRouting && typeof sourceGlobal.referenceRouting === 'object' && !Array.isArray(sourceGlobal.referenceRouting) ? sourceGlobal.referenceRouting : {}),
      },
      regionPreference: {
        ...defaults.global.regionPreference,
        ...(sourceGlobal.regionPreference && typeof sourceGlobal.regionPreference === 'object' && !Array.isArray(sourceGlobal.regionPreference) ? sourceGlobal.regionPreference : {}),
      },
      disabledModels: Array.isArray(sourceGlobal.disabledModels)
        ? sourceGlobal.disabledModels.filter(Boolean)
        : [...defaults.global.disabledModels],
    },
    operations,
  };
}

async function loadOperationDispatchConfig({ force = false } = {}) {
  let stat = null;
  try {
    stat = await fs.stat(OPERATION_DISPATCH_CONFIG_FILE);
  } catch {
    stat = null;
  }

  if (!force && operationDispatchConfigCache) {
    const currentMtime = stat?.mtimeMs || 0;
    if (currentMtime === operationDispatchConfigCacheMtime) {
      return operationDispatchConfigCache;
    }
  }

  try {
    const raw = await fs.readFile(OPERATION_DISPATCH_CONFIG_FILE, 'utf8');
    const normalized = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = JSON.parse(normalized);
    operationDispatchConfigCache = normalizeOperationDispatchConfig(parsed);
    operationDispatchConfigCacheMtime = stat?.mtimeMs || Date.now();
    return operationDispatchConfigCache;
  } catch {
    operationDispatchConfigCache = buildDefaultOperationDispatchConfig();
    operationDispatchConfigCacheMtime = stat?.mtimeMs || 0;
    return operationDispatchConfigCache;
  }
}

async function saveOperationDispatchConfig(config) {
  const normalized = normalizeOperationDispatchConfig(config);
  const payload = JSON.stringify(normalized, null, 2);
  await fs.mkdir(path.dirname(OPERATION_DISPATCH_CONFIG_FILE), { recursive: true });
  await fs.writeFile(OPERATION_DISPATCH_CONFIG_FILE, payload, 'utf8');
  const stat = await fs.stat(OPERATION_DISPATCH_CONFIG_FILE).catch(() => null);
  operationDispatchConfigCache = normalized;
  operationDispatchConfigCacheMtime = stat?.mtimeMs || Date.now();
  return normalized;
}

function sanitizeAssetFileBaseName(value = 'asset') {
  return String(value || 'asset')
    .replace(/\.[^.]+$/, '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .slice(0, 80)
    .trim() || 'asset';
}

function inferAssetTypeFromMime(mimeType = '', fallback = 'image') {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.startsWith('video/')) return 'video';
  if (normalized.startsWith('audio/')) return 'audio';
  if (normalized.startsWith('text/') || normalized.includes('json') || normalized.includes('csv') || normalized.includes('pdf')) return 'text';
  if (normalized.startsWith('image/')) return 'image';
  return fallback;
}

function inferAssetTypeFromPath(filePath = '', fallback = 'image') {
  const mimeType = mediaMimeTypeFromExtension(filePath, '');
  return inferAssetTypeFromMime(mimeType, fallback);
}

const ASSET_IMPORT_CATEGORY_RULES = [
  { keywords: ['landscape', 'mountain', 'forest', 'ocean', 'nature', '风景', '自然', '风光', '山水'], category: '风景' },
  { keywords: ['portrait', 'person', 'model', 'people', '人像', '人物', '模特'], category: '人物' },
  { keywords: ['city', 'building', 'architecture', 'interior', '城市', '建筑', '室内'], category: '建筑' },
  { keywords: ['night', 'nightscape', 'neon', '夜景', '霓虹'], category: '夜景' },
  { keywords: ['car', 'vehicle', 'auto', 'automobile', '汽车', '车辆'], category: '汽车' },
  { keywords: ['product', 'commerce', 'electric', 'watch', 'phone', '产品', '电商', '静物'], category: '产品' },
  { keywords: ['tech', 'technology', 'digital', '芯片', '科技'], category: '科技' },
  { keywords: ['fashion', 'beauty', 'clothes', '时尚', '美妆'], category: '时尚' },
  { keywords: ['food', 'drink', 'cafe', 'coffee', '美食', '饮品'], category: '美食' },
  { keywords: ['audio', 'bgm', 'voice', 'music', '音频', '音乐', '旁白'], category: '音频' },
  { keywords: ['video', 'film', 'cinema', '镜头', '视频'], category: '视频' },
];

function inferSupportedImportAssetType(filePath = '', mimeType = '') {
  const type = inferAssetTypeFromMime(mimeType, inferAssetTypeFromPath(filePath, ''));
  return ['image', 'video', 'audio', 'text'].includes(String(type || '')) ? type : null;
}

function normalizeAssetImportToken(value = '') {
  return String(value || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyAssetImportText(text = '') {
  const normalized = String(text || '').toLowerCase();
  return uniqueStrings(
    ASSET_IMPORT_CATEGORY_RULES
      .filter((rule) => rule.keywords.some((keyword) => normalized.includes(String(keyword).toLowerCase())))
      .map((rule) => rule.category),
  ).slice(0, 6);
}

function inferAssetImportFolderSegments(relativePath = '') {
  return uniqueStrings(
    String(relativePath || '')
      .split(/[\\/]+/)
      .slice(0, -1)
      .map((segment) => normalizeAssetImportToken(segment))
      .filter((segment) => segment.length >= 2),
  ).slice(-4);
}

function inferAssetImportHints(filePath = '', type = 'image', rootPath = '') {
  const relativePath = rootPath ? path.relative(rootPath, filePath) : path.basename(filePath);
  const folderSegments = inferAssetImportFolderSegments(relativePath);
  const semanticCategories = classifyAssetImportText([path.basename(filePath), relativePath].join(' '));
  const smartCategories = uniqueStrings([
    ...semanticCategories,
    ...folderSegments.slice(0, 2),
  ]).slice(0, 6);
  const nameParts = sanitizeAssetFileBaseName(path.basename(filePath))
    .split(/[\s_.-]+/)
    .map((part) => String(part || '').trim())
    .filter((part) => part.length >= 2)
    .slice(0, 3);
  const typeLabel = type === 'video' ? '视频' : type === 'audio' ? '音频' : type === 'text' ? '文档' : '图片';
  const tags = uniqueStrings([
    ...folderSegments,
    ...smartCategories,
    ...nameParts,
    typeLabel,
  ]).slice(0, 8);
  return {
    relativePath,
    smartCategories,
    tags,
  };
}

function buildAssetLibraryContentUrl(assetId) {
  return `/api/assets/content/${encodeURIComponent(String(assetId || ''))}`;
}

function normalizeAssetLibraryItem(source = {}) {
  const assetId = String(source.id || source.backendAssetId || crypto.randomUUID());
  const type = ['image', 'video', 'audio', 'text'].includes(String(source.type || ''))
    ? String(source.type)
    : inferAssetTypeFromPath(String(source.filePath || ''), 'image');
  const createdAt = Number(source.createdAt || Date.now());
  const updatedAt = Number(source.updatedAt || createdAt || Date.now());
  const tags = Array.isArray(source.tags) ? source.tags.map((item) => String(item || '').trim()).filter(Boolean) : [];
  const smartCategories = Array.isArray(source.smartCategories) ? source.smartCategories.map((item) => String(item || '').trim()).filter(Boolean) : [];
  const filePath = path.resolve(String(source.filePath || ''));
  const contentUrl = buildAssetLibraryContentUrl(assetId);
  const storageLabel = String(source.storageLabel || '').trim().toLowerCase() === 'reference'
    ? 'reference'
    : 'disk';
  return {
    id: assetId,
    backendAssetId: assetId,
    name: String(source.name || `${assetId}`),
    type,
    url: contentUrl,
    thumbnail: type === 'audio' ? '' : String(source.thumbnail || contentUrl),
    folderId: String(source.folderId || 'root'),
    size: Math.max(0, Number(source.size || 0)),
    width: Number(source.width || 0) || undefined,
    height: Number(source.height || 0) || undefined,
    duration: Number(source.duration || 0) || undefined,
    tags,
    smartCategories,
    prompt: typeof source.prompt === 'string' ? source.prompt : undefined,
    sourceUrl: String(source.sourceUrl || ''),
    filePath,
    persisted: true,
    storageLabel,
    duplicateOf: typeof source.duplicateOf === 'string' ? String(source.duplicateOf).trim() : undefined,
    contentHash: typeof source.contentHash === 'string' ? String(source.contentHash).trim() : undefined,
    source: ['upload', 'web', 'crawl', 'generate'].includes(String(source.source || '')) ? String(source.source) : 'upload',
    createdAt,
    updatedAt,
  };
}

function normalizeAssetDuplicateValue(value = '') {
  const normalized = String(value || '').trim().replace(/\//g, '\\');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function buildAssetDuplicateFingerprint({
  type = 'image',
  filePath = '',
  sourceUrl = '',
  name = '',
  size = 0,
  width = 0,
  height = 0,
  duration = 0,
  storageLabel = '',
  source = '',
  contentHash = '',
}) {
  const normalizedContentHash = String(contentHash || '').trim();
  if (normalizedContentHash) {
    return `content:${type}:${normalizedContentHash}`;
  }
  const normalizedStorageLabel = String(storageLabel || '').trim().toLowerCase();
  const normalizedFilePath = normalizeAssetDuplicateValue(filePath);
  const normalizedSourceUrl = normalizeAssetDuplicateValue(sourceUrl);
  const normalizedSource = String(source || '').trim().toLowerCase();
  if (normalizedStorageLabel === 'reference' && normalizedFilePath) {
    return `reference:${type}:${normalizedFilePath}`;
  }
  if (
    normalizedSourceUrl
    && ['crawl', 'web', 'generate'].includes(normalizedSource)
  ) {
    return `source:${type}:${normalizedSourceUrl}:${Math.max(0, Number(size || 0))}`;
  }
  return [
    'content',
    type,
    normalizeAssetDuplicateValue(name),
    Math.max(0, Number(size || 0)),
    Math.max(0, Number(width || 0)),
    Math.max(0, Number(height || 0)),
    Math.max(0, Number(duration || 0)),
  ].join(':');
}

function findDuplicateAssetLibraryItem(items = [], candidate = {}) {
  const fingerprint = buildAssetDuplicateFingerprint(candidate);
  if (!fingerprint) return null;
  return items.find((item) => buildAssetDuplicateFingerprint(item) === fingerprint) || null;
}

function mergeUniqueStringList(...lists) {
  return Array.from(
    new Set(
      lists
        .flatMap((list) => Array.isArray(list) ? list : [])
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    ),
  );
}

function mergeDuplicateAssetCandidate(existingItem, candidate = {}) {
  const updatedAt = Date.now();
  return normalizeAssetLibraryItem({
    ...existingItem,
    folderId: String(candidate.folderId || existingItem.folderId || 'root').trim() || 'root',
    width: Number(existingItem.width || 0) || Number(candidate.width || 0) || undefined,
    height: Number(existingItem.height || 0) || Number(candidate.height || 0) || undefined,
    duration: Number(existingItem.duration || 0) || Number(candidate.duration || 0) || undefined,
    prompt: typeof existingItem.prompt === 'string' && existingItem.prompt.trim()
      ? existingItem.prompt
      : (typeof candidate.prompt === 'string' ? candidate.prompt.trim() : undefined),
    sourceUrl: String(existingItem.sourceUrl || candidate.sourceUrl || '').trim(),
    tags: mergeUniqueStringList(existingItem.tags, candidate.tags),
    smartCategories: mergeUniqueStringList(existingItem.smartCategories, candidate.smartCategories),
    updatedAt,
  });
}

async function readAssetLibrarySettings() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(ASSET_LIBRARY_SETTINGS_FILE, 'utf8');
    const normalized = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = JSON.parse(normalized);
    const storagePath = String(parsed?.storagePath || '').trim();
    return {
      storagePath: storagePath ? path.resolve(storagePath) : DEFAULT_ASSET_LIBRARY_STORAGE_DIR,
    };
  } catch {
    return {
      storagePath: DEFAULT_ASSET_LIBRARY_STORAGE_DIR,
    };
  }
}

async function writeAssetLibrarySettings(storagePath) {
  const resolvedPath = path.resolve(String(storagePath || DEFAULT_ASSET_LIBRARY_STORAGE_DIR));
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(resolvedPath, { recursive: true });
  await fs.writeFile(ASSET_LIBRARY_SETTINGS_FILE, JSON.stringify({
    storagePath: resolvedPath,
    updatedAt: Date.now(),
  }, null, 2), 'utf8');
  return {
    storagePath: resolvedPath,
  };
}

async function pickLocalDirectory(initialPath = '', autoSelectPath = '') {
  if (process.platform !== 'win32') {
    throw new Error('Native directory picker is currently only available on Windows.');
  }
  const automationPath = String(autoSelectPath || '').trim();
  if (automationPath) {
    return {
      canceled: false,
      path: path.resolve(automationPath),
    };
  }
  const preferredPath = String(initialPath || '').trim();
  const inlineAutomationMatch = preferredPath.match(/^__HMDAO_AUTO_PICK__:(.+)$/);
  if (inlineAutomationMatch?.[1]) {
    return {
      canceled: false,
      path: path.resolve(String(inlineAutomationMatch[1]).trim()),
    };
  }
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$utf8NoBom = New-Object System.Text.UTF8Encoding($false)',
    '[Console]::InputEncoding = $utf8NoBom',
    '[Console]::OutputEncoding = $utf8NoBom',
    '$OutputEncoding = $utf8NoBom',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    '$dialog.Description = "选择资产库存储目录',
    '$dialog.ShowNewFolderButton = $true',
    `$initialPath = '${escapePowerShellSingleQuoted(preferredPath)}'`,
    'if ($initialPath -and (Test-Path -LiteralPath $initialPath -PathType Container)) {',
    '  $resolved = (Resolve-Path -LiteralPath $initialPath | Select-Object -First 1).Path',
    '  if ($resolved) { $dialog.SelectedPath = $resolved }',
    '}',
    '$result = $dialog.ShowDialog()',
    '$payload = if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) {',
    '  @{ success = $true; canceled = $false; path = $dialog.SelectedPath }',
    '} else {',
    '  @{ success = $true; canceled = $true; path = "" }',
    '}',
    '$dialog.Dispose()',
    '$payload | ConvertTo-Json -Compress',
  ].join('; ');

  const { stdout } = await runCommand('powershell', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script]);
  const parsed = JSON.parse(String(stdout || '{}').trim() || '{}');
  return {
    canceled: Boolean(parsed?.canceled),
    path: parsed?.path ? path.resolve(String(parsed.path)) : '',
  };
}

async function readAssetLibraryCatalog() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(ASSET_LIBRARY_CATALOG_FILE, 'utf8');
    const normalized = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = JSON.parse(normalized);
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    return items.map((item) => normalizeAssetLibraryItem(item));
  } catch {
    return [];
  }
}

async function writeAssetLibraryCatalog(items) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(ASSET_LIBRARY_CATALOG_FILE, JSON.stringify({
    version: 1,
    updatedAt: Date.now(),
    items,
  }, null, 2), 'utf8');
  return items;
}

async function upsertAssetLibraryItem(item) {
  const nextItem = normalizeAssetLibraryItem(item);
  const items = await readAssetLibraryCatalog();
  const nextItems = [...items.filter((entry) => entry.id !== nextItem.id), nextItem]
    .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
  await writeAssetLibraryCatalog(nextItems);
  return nextItem;
}

// 资产回收站：删除时把物理文件移入 trash 目录（而非直接销毁），
// 供撤销时通过 /api/assets/restore 找回，实现「云端文件找回」。
const ASSET_LIBRARY_TRASH_DIR = path.join(DATA_DIR, 'asset-trash');
// 去重结果持久化缓存文件：服务端去重分组在此落盘，供去重看板常驻视图读取。
const ASSET_LIBRARY_DUPLICATES_FILE = path.join(DATA_DIR, 'asset-duplicates.json');

// 将去重分组写入缓存文件（覆盖式）。分组结构：{ canonicalId, type, name, contentHash, duplicateIds }。
async function writeAssetLibraryDuplicates(groups = []) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(
    ASSET_LIBRARY_DUPLICATES_FILE,
    JSON.stringify({ version: 1, updatedAt: Date.now(), groups: Array.isArray(groups) ? groups : [] }, null, 2),
    'utf8',
  );
}

async function readAssetLibraryDuplicates() {
  try {
    const text = await fs.readFile(ASSET_LIBRARY_DUPLICATES_FILE, 'utf8');
    const parsed = JSON.parse(text);
    return Array.isArray(parsed?.groups) ? parsed.groups : [];
  } catch {
    return [];
  }
}

// 探测素材媒体是否可被解码：文件缺失/损坏返回对应状态，正常返回可转码标记。
function resolveFfprobePath() {
  const base = String(process.env.HMDAO_FFMPEG_PATH || 'ffmpeg').trim() || 'ffmpeg';
  if (base.endsWith('ffmpeg')) return `${base.slice(0, -'ffmpeg'.length)}ffprobe`;
  return 'ffprobe';
}

async function probeAssetMedia(filePath) {
  const source = String(filePath || '');
  if (!source) return { ok: false, state: 'missing' };
  try {
    await fs.access(source, fs.constants.F_OK);
  } catch {
    return { ok: false, state: 'missing' };
  }
  const ffprobe = resolveFfprobePath();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const child = spawn(ffprobe, [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name',
      '-of', 'json',
      source,
    ]);
    child.stderr.on('data', () => {});
    child.on('error', () => finish({ ok: false, state: 'corrupted', detail: 'probe-spawn-failed' }));
    child.on('close', (code) => {
      if (code !== 0) return finish({ ok: false, state: 'corrupted', detail: `ffprobe-exit-${code}` });
      finish({ ok: true, state: 'ok', canTranscode: true });
    });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish({ ok: false, state: 'corrupted', detail: 'probe-timeout' });
    }, 20000);
    if (timer.unref) timer.unref();
  });
}

// 修复（转码）：把不可在浏览器直接预览、但可被解码的素材转成标准格式
// （视频→H.264/AAC 的 mp4，图片→png），原地替换文件并更新目录元数据。
async function repairAssetLibraryItem(item) {
  const filePath = String(item.filePath || '');
  if (!filePath) throw new Error('asset-has-no-file');
  const type = String(item.type || '');
  const dir = path.dirname(filePath);
  const ext = type === 'video' ? 'mp4' : 'png';
  const outPath = path.join(dir, `${item.backendAssetId || item.id}-repaired.${ext}`);
  const ffmpegPath = String(process.env.HMDAO_FFMPEG_PATH || 'ffmpeg').trim() || 'ffmpeg';
  const args = type === 'video'
    ? ['-y', '-i', filePath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-c:a', 'aac', '-movflags', '+faststart', outPath]
    : ['-y', '-i', filePath, outPath];
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (!settled) {
        settled = true;
        if (error) reject(error);
        else resolve();
      }
    };
    const child = spawn(ffmpegPath, args);
    child.stderr.on('data', () => {});
    child.on('error', () => finish(new Error('ffmpeg-spawn-failed')));
    child.on('close', (code) => finish(code === 0 ? null : new Error(`ffmpeg-exit-${code}`)));
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish(new Error('ffmpeg-timeout'));
    }, 120000);
    if (timer.unref) timer.unref();
  });
  const probe = await probeAssetMedia(outPath);
  if (!probe.ok) throw new Error('repaired-file-invalid');
  // 仅在转码产物验证通过后，用新文件覆盖原文件（先 copy 成功再替换，避免原文件丢失）
  try {
    await fs.rename(outPath, filePath);
  } catch {
    await fs.copyFile(outPath, filePath);
    await fs.rm(outPath, { force: true }).catch(() => {});
  }
  const stat = await fs.stat(filePath).catch(() => null);
  const size = stat ? stat.size : Number(item.size || 0);
  const contentHash = await computeAssetContentHash(filePath, {
    type,
    duration: Number(item.duration || 0) || 0,
  });
  return { filePath, size, contentHash };
}

async function moveFileToTrash(filePath, assetId) {
  const source = String(filePath || '');
  if (!source) return;
  const base = path.basename(source);
  const trashDir = path.join(ASSET_LIBRARY_TRASH_DIR, String(assetId || ''));
  await fs.mkdir(trashDir, { recursive: true });
  const target = path.join(trashDir, base);
  try {
    await fs.rename(source, target);
  } catch {
    // 跨盘/占用时回退 copy + unlink
    await fs.copyFile(source, target).catch(() => {});
    await fs.rm(source, { force: true }).catch(() => {});
  }
}

async function deleteAssetLibraryItems(assetIds = []) {
  const ids = new Set(assetIds.map((item) => String(item || '').trim()).filter(Boolean));
  if (!ids.size) return [];
  const items = await readAssetLibraryCatalog();
  const deletedItems = items.filter((item) => ids.has(String(item.id || '')));
  await fs.mkdir(ASSET_LIBRARY_TRASH_DIR, { recursive: true }).catch(() => {});
  await Promise.all(
    deletedItems.map(async (item) => {
      // 引用型素材未复制原文件，删除时不动物理文件
      if (String(item.storageLabel || '').trim().toLowerCase() === 'reference') {
        return;
      }
      const filePath = String(item.filePath || '');
      if (!filePath) return;
      try {
        await moveFileToTrash(filePath, String(item.id || ''));
      } catch {
        // 软删除失败时回退硬删除，保证删除语义不被破坏
        await fs.rm(filePath, { force: true }).catch(() => {});
      }
    }),
  );
  const nextItems = items.filter((item) => !ids.has(String(item.id || '')));
  await writeAssetLibraryCatalog(nextItems);
  return deletedItems.map((item) => String(item.id || ''));
}

// 撤销找回：把回收站里的文件移回原路径，并将目录项写回 catalog。
async function restoreAssetLibraryItems(inputItems = []) {
  const list = Array.isArray(inputItems) ? inputItems : [];
  if (!list.length) return [];
  const catalog = await readAssetLibraryCatalog();
  const byId = new Map(catalog.map((item) => [String(item.id || ''), item]));
  const restored = [];
  for (const raw of list) {
    const id = String(raw?.id || '').trim();
    if (!id) continue;
    const label = String(raw?.storageLabel || '').trim().toLowerCase();
    const filePath = String(raw?.filePath || '');
    if (label !== 'reference' && filePath) {
      const base = path.basename(filePath);
      const trashPath = path.join(ASSET_LIBRARY_TRASH_DIR, id, base);
      try {
        await fs.access(trashPath);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        try {
          await fs.rename(trashPath, filePath);
        } catch {
          await fs.copyFile(trashPath, filePath).catch(() => {});
          await fs.rm(trashPath, { force: true }).catch(() => {});
        }
        await fs.rm(path.join(ASSET_LIBRARY_TRASH_DIR, id), { recursive: true, force: true }).catch(() => {});
      } catch {
        // 回收站中无对应文件（可能已被清理），仅恢复目录项
      }
    }
    try {
      byId.set(id, normalizeAssetLibraryItem(raw));
      restored.push(id);
    } catch {
      // 跳过无法规范化的条目
    }
  }
  const nextItems = Array.from(byId.values()).sort(
    (left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0),
  );
  await writeAssetLibraryCatalog(nextItems);
  return restored;
}

async function findAssetLibraryItem(assetId) {
  const items = await readAssetLibraryCatalog();
  return items.find((item) => String(item.id || '') === String(assetId || '')) || null;
}

async function collectLocalAssetImportFiles(directoryPath) {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const fullPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...await collectLocalAssetImportFiles(fullPath));
      continue;
    }
    if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

async function probeAssetImportMeta(filePath, type) {
  try {
    if (type === 'video') return await probeVideoFile(filePath);
    if (type === 'image') return await probeImageFile(filePath);
    if (type === 'audio') {
      const audioMeta = await inspectAudioFile(filePath);
      return {
        width: 0,
        height: 0,
        duration: Number(audioMeta.duration || 0) || 0,
      };
    }
  } catch {
    // Ignore probe failures and fall back to a metadata-light import.
  }
  return {
    width: 0,
    height: 0,
    duration: 0,
  };
}

async function processAssetLibraryImportDirectory(options = {}) {
  const folderId = String(options.folderId || 'root').trim() || 'root';
  const initialPath = String(options.initialPath || '').trim();
  const autoSelectPath = String(options.autoSelectPath || '').trim();
  const settings = await readAssetLibrarySettings();
  const picked = await pickLocalDirectory(initialPath || settings.storagePath || DEFAULT_ASSET_LIBRARY_STORAGE_DIR, autoSelectPath);
  if (picked.canceled || !picked.path) {
    return {
      canceled: true,
      path: '',
      items: [],
      report: {
        importedCount: 0,
        failedCount: 0,
        skippedCount: 0,
        duplicateCount: 0,
        folderImport: true,
        imageCount: 0,
        videoCount: 0,
        audioCount: 0,
        textCount: 0,
        autoTaggedCount: 0,
        autoClassifiedCount: 0,
      },
    };
  }

  const importFiles = await collectLocalAssetImportFiles(picked.path);
  const items = [];
  const report = {
    importedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    duplicateCount: 0,
    folderImport: true,
    imageCount: 0,
    videoCount: 0,
    audioCount: 0,
    textCount: 0,
    autoTaggedCount: 0,
    autoClassifiedCount: 0,
  };

  for (const filePath of importFiles) {
    const type = inferSupportedImportAssetType(filePath, mediaMimeTypeFromExtension(filePath, ''));
    if (!type) {
      report.skippedCount += 1;
      continue;
    }
    try {
      const hints = inferAssetImportHints(filePath, type, picked.path);
      const meta = await probeAssetImportMeta(filePath, type);
      const result = await processAssetLibraryImportRequest({
        name: path.basename(filePath),
        originalName: path.basename(filePath),
        folderId,
        type,
        tags: hints.tags,
        smartCategories: hints.smartCategories,
        sourceUrl: hints.relativePath || path.basename(filePath),
        inputPath: filePath,
        inputMimeType: mediaMimeTypeFromExtension(filePath, 'application/octet-stream'),
        width: Number(meta.width || 0) || 0,
        height: Number(meta.height || 0) || 0,
        duration: Number(meta.duration || 0) || 0,
        referenceSourceFile: true,
      });
      items.push(result.item);
      if (result.duplicate) {
        report.duplicateCount += 1;
      } else {
        report.importedCount += 1;
      }
      report.autoTaggedCount += hints.tags.length > 0 ? 1 : 0;
      report.autoClassifiedCount += hints.smartCategories.length > 0 ? 1 : 0;
      if (type === 'image') report.imageCount += 1;
      if (type === 'video') report.videoCount += 1;
      if (type === 'audio') report.audioCount += 1;
      if (type === 'text') report.textCount += 1;
    } catch {
      report.failedCount += 1;
    }
  }

  return {
    canceled: false,
    path: picked.path,
    items,
    report,
  };
}

const DCC_ENGINES = {
  blender: { id: 'blender', label: 'Blender', port: 8766, pluginName: 'HMDao Blender Capture Plugin' },
  unreal: { id: 'unreal', label: 'Unreal Engine', port: 8792, pluginName: 'HMDao Unreal Capture Plugin', wsPath: '/ws/dcc/unreal', previewProvider: 'editor-direct' },
};

const DEFAULT_UNREAL_PIXEL_URL = process.env.HMDAO_UNREAL_PIXEL_URL || 'http://127.0.0.1:1025/player.html';
const DEFAULT_UNREAL_REMOTE_URL = process.env.HMDAO_UNREAL_REMOTE_URL || 'http://127.0.0.1:30010';

const DCC_CAMERA_SETS = {
  blender: ['Main Camera', 'Product Closeup', 'Orbit Camera'],
  unreal: ['CineCameraActor_01', 'CineCameraActor_02', 'Sequencer_Camera'],
};

const DCC_RECORDING_LOCK = { engine: null };
const UNREAL_DIRECT_BRIDGE = {
  pluginSocket: null,
  pluginInfo: null,
  browsers: new Map(),
  lastCameraList: null,
  lastTimeline: null,
};
const DCC_LOCAL_ARTIFACTS = new Map();

function isSyntheticUnrealDirectPluginSession() {
  return String(UNREAL_DIRECT_BRIDGE.pluginInfo?.pluginVersion || '').trim().toLowerCase() === 'verify';
}

function isUnrealDirectBridgeOnline() {
  if (isSyntheticUnrealDirectPluginSession()) return false;
  return Boolean(UNREAL_DIRECT_BRIDGE.pluginSocket && !UNREAL_DIRECT_BRIDGE.pluginSocket.destroyed);
}

function getUnrealDirectBridgeCameraCount() {
  const cameraList = UNREAL_DIRECT_BRIDGE.lastCameraList;
  if (Array.isArray(cameraList?.camera_list)) return cameraList.camera_list.length;
  if (Array.isArray(cameraList?.cameras)) return cameraList.cameras.length;
  return 0;
}

function registerDccLocalArtifactUrl(filePath, mimeType = 'application/octet-stream') {
  const normalizedPath = path.resolve(String(filePath || '').trim());
  if (!normalizedPath) return '';
  const now = Date.now();
  const token = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.createHash('sha1').update(`${mimeType}:${normalizedPath}:${now}:${Math.random()}`).digest('hex');
  DCC_LOCAL_ARTIFACTS.set(token, {
    filePath: normalizedPath,
    mimeType: String(mimeType || 'application/octet-stream') || 'application/octet-stream',
    updatedAt: now,
  });
  for (const [existingToken, entry] of DCC_LOCAL_ARTIFACTS.entries()) {
    if ((now - Number(entry?.updatedAt || 0)) > 6 * 60 * 60 * 1000) {
      DCC_LOCAL_ARTIFACTS.delete(existingToken);
    }
  }
  return `/api/dcc/local-artifacts/${token}`;
}

function getDccLocalArtifact(token = '') {
  return DCC_LOCAL_ARTIFACTS.get(String(token || '').trim()) || null;
}

function getRequestOrigin(req) {
  const forwardedProto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  const forwardedHost = String(req?.headers?.['x-forwarded-host'] || '').split(',')[0].trim();
  const protocol = forwardedProto || (req?.socket?.encrypted ? 'https' : 'http');
  const host = forwardedHost || String(req?.headers?.host || `127.0.0.1:${PORT}`).split(',')[0].trim() || `127.0.0.1:${PORT}`;
  return `${protocol}://${host}`;
}

function summarizeCurrentUnrealEnvironment(pluginEngine) {
  if (!pluginEngine) return null;
  const hostProcessRunning = Boolean(pluginEngine?.host?.hostProcessRunning);
  const targetProjectRunning = Boolean(pluginEngine?.host?.targetProjectRunning);
  const directBridgeReadyForTargetProject = Boolean(pluginEngine?.plugin?.directBridgeReadyForTargetProject);
  const adapterSummary = String(pluginEngine?.summary || '').trim();
  if (pluginEngine?.integration?.recommendedMode === 'official-sequencer-capture') {
    return {
      level: pluginEngine.level,
      summary: pluginEngine.summary,
      recommendedAction: pluginEngine.recommendedAction,
      adapter: pluginEngine.adapter || null,
      runtimeState: pluginEngine.runtimeState || null,
      integration: pluginEngine.integration || null,
      official: pluginEngine.official || null,
      guidance: pluginEngine.guidance || null,
    };
  }
  if (!targetProjectRunning) {
    return {
      level: 'warning',
      summary: hostProcessRunning
        ? (adapterSummary || 'Unreal is already running and HMDao is still waiting to identify the current editor session. Confirm the visible main window is fully open, then click Connect again.')
        : 'The target Unreal project is not open in the current running editor session yet. Open the matching project from Epic Games Launcher, wait for the visible editor window, then click Connect again in HMDao.',
      recommendedAction: 'connect',
      adapter: pluginEngine.adapter || null,
      runtimeState: pluginEngine.runtimeState || null,
    };
  }
  const prerequisitesReady = Boolean(
    pluginEngine?.plugin?.installed
    && pluginEngine?.plugin?.enabledInProject
    && pluginEngine?.plugin?.buildArtifactsPresent,
  );
  if (!prerequisitesReady) {
    return {
      level: pluginEngine.level,
      summary: pluginEngine.summary,
      recommendedAction: pluginEngine.recommendedAction,
      adapter: pluginEngine.adapter || null,
      runtimeState: pluginEngine.runtimeState || null,
    };
  }
  if (!directBridgeReadyForTargetProject || !isUnrealDirectBridgeOnline()) {
    return {
      level: 'warning',
      summary: 'The plugin is ready, but Unreal has not bridged the editor back to HMDao yet.',
      recommendedAction: 'connect',
      adapter: pluginEngine.adapter || null,
      runtimeState: pluginEngine.runtimeState || null,
    };
  }
  if (getUnrealDirectBridgeCameraCount() <= 0) {
    return {
      level: 'warning',
      summary: 'Unreal is connected back to HMDao, but no viewport or camera source has been reported yet. Even without an explicit camera, it should normally fall back to Editor Viewport.',
      recommendedAction: 'connect',
      adapter: pluginEngine.adapter || null,
    };
  }
  return {
    level: 'ready',
    summary: 'Unreal plugin install, project enablement, and direct bridge are all ready.',
    recommendedAction: 'ready',
    adapter: pluginEngine.adapter || null,
    runtimeState: pluginEngine.runtimeState || null,
    integration: pluginEngine.integration || null,
    official: pluginEngine.official || null,
    guidance: pluginEngine.guidance || null,
  };
}

function logUnrealBridgeEvent(event, details = null) {
  if (!details || typeof details !== 'object') {
    console.log(`[HMDao Unreal Bridge] ${event}`);
    return;
  }
  try {
    console.log(`[HMDao Unreal Bridge] ${event} ${JSON.stringify(details)}`);
  } catch {
    console.log(`[HMDao Unreal Bridge] ${event}`);
  }
}

const DCC_ENVIRONMENT_MANAGER = createDccEnvironmentManager({
  repoRoot: REPO_ROOT,
  dataDir: DATA_DIR,
  getUnrealBridgeState: () => ({
    directBridgeOnline: isUnrealDirectBridgeOnline(),
    clientCount: UNREAL_DIRECT_BRIDGE.browsers.size,
    pluginInfo: isSyntheticUnrealDirectPluginSession() ? null : UNREAL_DIRECT_BRIDGE.pluginInfo,
    cameraList: UNREAL_DIRECT_BRIDGE.lastCameraList,
  }),
});

function engineConfig(engine) {
  return DCC_ENGINES[engine === 'unreal' ? 'unreal' : 'blender'];
}

function escapeXml(value) {
  return String(value || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

function dccFrameDataUrl({ engine, cameraName, width, height, frameIndex, recording }) {
  const config = engineConfig(engine);
  const hue = engine === 'unreal' ? '#2563eb' : '#0f766e';
  const accent = engine === 'unreal' ? '#f97316' : '#22d3ee';
  const tick = frameIndex % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#050505"/>
        <stop offset="0.52" stop-color="${hue}"/>
        <stop offset="1" stop-color="#111827"/>
      </linearGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#bg)"/>
    <circle cx="${Math.round(width * (0.18 + (tick % 80) / 400))}" cy="${Math.round(height * 0.34)}" r="${Math.round(Math.min(width, height) * 0.14)}" fill="${accent}" opacity="0.24"/>
    <rect x="${Math.round(width * 0.08)}" y="${Math.round(height * 0.16)}" width="${Math.round(width * 0.84)}" height="${Math.round(height * 0.58)}" rx="18" fill="rgba(0,0,0,0.26)" stroke="rgba(255,255,255,0.26)" stroke-width="2"/>
    <text x="${Math.round(width * 0.11)}" y="${Math.round(height * 0.28)}" fill="#ffffff" font-family="Arial, sans-serif" font-size="${Math.max(24, Math.round(width / 24))}" font-weight="700">${escapeXml(config.label)} Camera Preview</text>
    <text x="${Math.round(width * 0.11)}" y="${Math.round(height * 0.38)}" fill="#d1fae5" font-family="Arial, sans-serif" font-size="${Math.max(18, Math.round(width / 38))}">${escapeXml(cameraName)}</text>
    <text x="${Math.round(width * 0.11)}" y="${Math.round(height * 0.48)}" fill="#cbd5e1" font-family="Arial, sans-serif" font-size="${Math.max(16, Math.round(width / 48))}">Frame ${frameIndex} · ${width} x ${height}${recording ? ' · REC' : ''}</text>
    <text x="${Math.round(width * 0.11)}" y="${Math.round(height * 0.62)}" fill="#e5e7eb" font-family="Arial, sans-serif" font-size="${Math.max(14, Math.round(width / 58))}">DCC bridge mock frame. Connect the real plugin to capture live camera output.</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function wsAcceptKey(key) {
  return crypto.createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
}

function encodeWsFrame(payload, { masked = false, opcode = 1 } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const header = [];
  header.push(0x80 | opcode);
  if (data.length < 126) {
    header.push((masked ? 0x80 : 0) | data.length);
  } else if (data.length < 65536) {
    header.push((masked ? 0x80 : 0) | 126, (data.length >> 8) & 255, data.length & 255);
  } else {
    header.push((masked ? 0x80 : 0) | 127, 0, 0, 0, 0, (data.length / 2 ** 24) & 255, (data.length / 2 ** 16) & 255, (data.length / 2 ** 8) & 255, data.length & 255);
  }
  if (!masked) return Buffer.concat([Buffer.from(header), data]);
  const mask = crypto.randomBytes(4);
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([Buffer.from(header), mask, out]);
}

function createFrameParser(onMessage, onClose, onPing) {
  let buffer = Buffer.alloc(0);
  let fragmentedOpcode = 0;
  let fragmentedChunks = [];

  const emitMessage = (opcode, payload) => {
    if (opcode === 0x1 || opcode === 0x2) onMessage(payload.toString('utf8'));
  };

  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const first = buffer[0];
      const second = buffer[1];
      const fin = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const high = buffer.readUInt32BE(2);
        const low = buffer.readUInt32BE(6);
        length = high * 2 ** 32 + low;
        offset = 10;
      }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      let payload = buffer.subarray(offset, offset + length);
      if (masked) {
        const mask = buffer.subarray(maskOffset, maskOffset + 4);
        const unmasked = Buffer.allocUnsafe(payload.length);
        for (let index = 0; index < payload.length; index += 1) {
          unmasked[index] = payload[index] ^ mask[index % 4];
        }
        payload = unmasked;
      }
      buffer = buffer.subarray(offset + length);
      if (opcode === 0x8) {
        onClose?.();
        return;
      }
      if (opcode === 0x9) {
        onPing?.(payload);
        continue;
      }
      if (opcode === 0xA) continue;

      if (opcode === 0x0) {
        if (!fragmentedOpcode) continue;
        fragmentedChunks.push(payload);
        if (fin) {
          emitMessage(fragmentedOpcode, Buffer.concat(fragmentedChunks));
          fragmentedOpcode = 0;
          fragmentedChunks = [];
        }
        continue;
      }

      if (!fin) {
        fragmentedOpcode = opcode;
        fragmentedChunks = [payload];
        continue;
      }

      emitMessage(opcode, payload);
    }
  };
}

function sendWs(socket, payload) {
  if (!socket.destroyed) socket.write(encodeWsFrame(JSON.stringify(payload)));
}

function nextWorkflowId() {
  return `wf-${crypto.randomUUID()}`;
}

function nextMessageId() {
  return `msg-${crypto.randomUUID()}`;
}

function probeTcp(port, timeoutMs = 350) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function normalizeHttpUrl(value, fallback) {
  const raw = String(value || '').trim() || fallback;
  const normalized = raw.replace(/\/$/, '');
  if (normalized === 'http://127.0.0.1' || normalized === 'http://localhost') return fallback;
  if (normalized === 'http://127.0.0.1:1025' || normalized === 'http://localhost:1025') return fallback;
  return normalized;
}

function inferMediaContentType(targetUrl, upstreamType = '', kind = '') {
  const normalizedType = String(upstreamType || '').split(';')[0].trim().toLowerCase();
  if (normalizedType && normalizedType !== 'application/octet-stream') {
    return upstreamType;
  }

  const pathname = (() => {
    try {
      return new URL(targetUrl).pathname.toLowerCase();
    } catch {
      return String(targetUrl || '').toLowerCase();
    }
  })();

  if (pathname.endsWith('.png')) return 'image/png';
  if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
  if (pathname.endsWith('.webp')) return 'image/webp';
  if (pathname.endsWith('.gif')) return 'image/gif';
  if (pathname.endsWith('.bmp')) return 'image/bmp';
  if (pathname.endsWith('.svg')) return 'image/svg+xml';
  if (pathname.endsWith('.avif')) return 'image/avif';
  if (pathname.endsWith('.heic')) return 'image/heic';
  if (pathname.endsWith('.heif')) return 'image/heif';
  if (pathname.endsWith('.tif') || pathname.endsWith('.tiff')) return 'image/tiff';
  if (pathname.endsWith('.hdr')) return 'image/vnd.radiance';
  if (pathname.endsWith('.exr')) return 'image/x-exr';
  if (pathname.endsWith('.dng')) return 'image/x-adobe-dng';
  if (pathname.endsWith('.jxl')) return 'image/jxl';
  if (pathname.endsWith('.mp4')) return 'video/mp4';
  if (pathname.endsWith('.webm')) return 'video/webm';
  if (pathname.endsWith('.mov')) return 'video/quicktime';
  if (pathname.endsWith('.m4v')) return 'video/x-m4v';
  if (pathname.endsWith('.mkv')) return 'video/x-matroska';
  if (pathname.endsWith('.avi')) return 'video/x-msvideo';
  if (pathname.endsWith('.mp3')) return 'audio/mpeg';
  if (pathname.endsWith('.wav')) return 'audio/wav';
  if (pathname.endsWith('.m4a')) return 'audio/mp4';
  if (pathname.endsWith('.aac')) return 'audio/aac';

  if (kind === 'image') return 'image/png';
  if (kind === 'video') return 'video/mp4';
  if (kind === 'audio') return 'audio/mpeg';
  return upstreamType || 'application/octet-stream';
}

function readHeaderValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') {
    return String(headers.get(name) || '').trim();
  }
  const lowered = String(name || '').toLowerCase();
  return String(extractFirstString(headers[lowered] ?? headers[name]) || '').trim();
}

function sanitizeForwardHeaderValue(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function parseAwsSignedAt(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) return 0;
  const [, year, month, day, hour, minute, second] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
}

function getRemoteSignedUrlExpiry(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    const host = parsed.hostname.toLowerCase();
    const signedAt = parseAwsSignedAt(parsed.searchParams.get('X-Amz-Date'));
    const expiresInSeconds = Number(parsed.searchParams.get('X-Amz-Expires'));
    if (!signedAt || !Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) return null;
    const expiresAt = signedAt + expiresInSeconds * 1000;
    return {
      host,
      provider: host.includes('siliconflow.cn') ? 'siliconflow' : '',
      signedAt,
      expiresAt,
      expired: Date.now() > expiresAt,
    };
  } catch {
    return null;
  }
}

function createMediaProxyErrorPayload(status, category, provider, message) {
  return {
    success: false,
    error: {
      status,
      category,
      provider,
      message,
    },
  };
}

function sendMediaProxyError(res, status, category, provider, message) {
  return send(
    res,
    status,
    createMediaProxyErrorPayload(status, category, provider, message),
    {
      'Cache-Control': 'no-store',
      'X-HMDAO-Media-Error': sanitizeForwardHeaderValue(category),
      ...(provider ? { 'X-HMDAO-Media-Provider': sanitizeForwardHeaderValue(provider) } : {}),
    },
  );
}

function detectRemoteMediaUpstreamIssue(targetUrl, upstream) {
  const signedUrl = getRemoteSignedUrlExpiry(targetUrl);
  if (signedUrl?.provider === 'siliconflow' && signedUrl.expired) {
    return {
      status: 410,
      category: 'remote-asset-expired',
      provider: 'siliconflow',
      message: 'SiliconFlow temporary asset URL has expired and must be regenerated or re-uploaded.',
    };
  }

  const contentType = readHeaderValue(upstream.headers, 'content-type').toLowerCase();
  const bodyText = upstream.body?.length
    ? upstream.body.toString('utf8').trim()
    : '';
  const looksJson = contentType.includes('application/json')
    || contentType.includes('+json')
    || bodyText.startsWith('{')
    || bodyText.startsWith('[');
  let payload = null;
  if (looksJson && bodyText) {
    try {
      payload = JSON.parse(bodyText);
    } catch {
      payload = null;
    }
  }
  const message = String(
    payload?.message
    || payload?.error?.message
    || bodyText
    || `Remote media request failed with HTTP ${Number(upstream.status || 0)}.`,
  ).trim();

  if (
    (signedUrl?.provider === 'siliconflow' || signedUrl?.host?.includes('siliconflow.cn'))
    && (
      Number(payload?.code) === 60000
      || /token\s+has\s+invalid\s+claims/i.test(message)
      || /token\s+is\s+expired/i.test(message)
    )
  ) {
    return {
      status: 410,
      category: 'remote-asset-expired',
      provider: 'siliconflow',
      message: 'SiliconFlow temporary asset URL has expired and must be regenerated or re-uploaded.',
    };
  }

  if (Number(upstream.status || 0) >= 400 || looksJson) {
    return {
      status: Number(upstream.status || 502) >= 400 ? Number(upstream.status || 502) : 502,
      category: 'remote-media-fetch-failed',
      provider: signedUrl?.provider || '',
      message,
    };
  }

  return null;
}

async function requestRemoteBinaryAsset(targetUrl, {
  method = 'GET',
  headers = {},
  timeoutMs = 45000,
} = {}) {
  const normalizedMethod = String(method || 'GET').toUpperCase();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  try {
    const upstream = await fetch(targetUrl, {
      method: normalizedMethod,
      headers,
      redirect: 'follow',
      signal: controller.signal,
    });
    const body = normalizedMethod === 'HEAD'
      ? Buffer.alloc(0)
      : Buffer.from(await upstream.arrayBuffer());
    return {
      status: upstream.status,
      headers: upstream.headers,
      body,
      transport: 'fetch',
    };
  } catch (fetchError) {
    const fallback = await nativeHttpRequest(targetUrl, {
      method: normalizedMethod,
      timeoutMs,
      headers,
      responseType: 'buffer',
    });
    if (!fallback.ok && !fallback.status) {
      throw fetchError instanceof Error ? fetchError : new Error(String(fetchError));
    }
    return {
      status: Number(fallback.status || 0),
      headers: fallback.headers || {},
      body: normalizedMethod === 'HEAD' ? Buffer.alloc(0) : Buffer.from(fallback.bodyBuffer || Buffer.alloc(0)),
      transport: 'native-http',
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function proxyRemoteMediaAsset(req, res, mediaUrl, kind = '') {
  const targetUrl = String(mediaUrl || '').trim();
  const isHttpTarget = /^https?:\/\//i.test(targetUrl);
  const isFileUrlTarget = /^file:\/\//i.test(targetUrl);
  const isWindowsPathTarget = /^[a-zA-Z]:[\\/]/.test(targetUrl) || targetUrl.startsWith('\\\\');
  if (!isHttpTarget && !isFileUrlTarget && !isWindowsPathTarget) {
    return send(res, 400, { success: false, error: { message: 'Media proxy requires an absolute http(s) URL or local file path.' } });
  }

  if (isFileUrlTarget || isWindowsPathTarget) {
    let filePath = targetUrl;
    if (isFileUrlTarget) {
      try {
        filePath = fileURLToPath(targetUrl);
      } catch {
        filePath = decodeURIComponent(targetUrl.replace(/^file:\/\/\/?/i, ''));
      }
    }
    const resolvedPath = path.resolve(String(filePath || '').trim());
    if (!resolvedPath) {
      return send(res, 400, { success: false, error: { message: 'invalid-local-media-path' } });
    }
    try {
      await sendLocalFileStream(req, res, resolvedPath, {
        mimeType: mediaMimeTypeFromExtension(resolvedPath, inferMediaContentType(resolvedPath, '', kind)),
        contentDisposition: buildSafeInlineContentDisposition(resolvedPath),
      });
      return;
    } catch (error) {
      return send(res, 404, {
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'local-media-not-found',
        },
      });
    }
  }
  const signedUrl = getRemoteSignedUrlExpiry(targetUrl);
  if (signedUrl?.provider === 'siliconflow' && signedUrl.expired) {
    return sendMediaProxyError(
      res,
      410,
      'remote-asset-expired',
      'siliconflow',
      'SiliconFlow temporary asset URL has expired and must be regenerated or re-uploaded.',
    );
  }

  const upstreamHeaders = {
    Accept: req.headers.accept || '*/*',
    'User-Agent': req.headers['user-agent'] || 'HMDao-MediaProxy/1.0',
  };
  if (req.headers.range) {
    upstreamHeaders.Range = req.headers.range;
  }

  try {
    const upstream = await requestRemoteBinaryAsset(targetUrl, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: upstreamHeaders,
      timeoutMs: 45000,
    });
    const upstreamIssue = detectRemoteMediaUpstreamIssue(targetUrl, upstream);
    if (upstreamIssue) {
      return sendMediaProxyError(
        res,
        upstreamIssue.status,
        upstreamIssue.category,
        upstreamIssue.provider,
        upstreamIssue.message,
      );
    }
    const body = upstream.body;
    const contentType = inferMediaContentType(targetUrl, readHeaderValue(upstream.headers, 'content-type'), kind);
    const contentDisposition = sanitizeForwardHeaderValue(readHeaderValue(upstream.headers, 'content-disposition'));
    const contentLengthHeader = readHeaderValue(upstream.headers, 'content-length');
    const responseContentLength = req.method === 'HEAD'
      ? String(Number(contentLengthHeader || 0))
      : String(body.length);
    const headers = {
      'Content-Type': contentType,
      'Content-Length': responseContentLength,
      'Cache-Control': 'private, max-age=300',
      'Accept-Ranges': readHeaderValue(upstream.headers, 'accept-ranges') || 'bytes',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      // CORS 由 sendRaw() 统一处理，不再硬编码 *
      ...(readHeaderValue(upstream.headers, 'content-range') ? { 'Content-Range': readHeaderValue(upstream.headers, 'content-range') } : {}),
      ...(readHeaderValue(upstream.headers, 'etag') ? { ETag: readHeaderValue(upstream.headers, 'etag') } : {}),
      ...(readHeaderValue(upstream.headers, 'last-modified') ? { 'Last-Modified': readHeaderValue(upstream.headers, 'last-modified') } : {}),
      ...(contentDisposition ? { 'Content-Disposition': contentDisposition.replace(/attachment/ig, 'inline') } : {}),
    };
    return sendRaw(res, upstream.status, body, headers);
  } catch (error) {
    return send(res, 502, {
      success: false,
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

/**
 * 后端 Hugging Face Hub 代理（用于本地 NLLB 翻译模型下载）
 *
 * 浏览器端 Transformers.js 从 huggingface.co 下载 ~600MB 模型文件，
 * 在当前网络环境下该域名对 Node 进程不可达（连接超时），而镜像源
 * hf-mirror.com 可由 Node 直连。此路由将请求经后端转发到镜像源
 * （huggingface.co 作为兜底），绕开浏览器直连限制。
 *
 * 路由：GET/HEAD /api/hf-proxy/{model}/resolve/{revision}/{path...}
 * 转发：https://hf-mirror.com/{model}/resolve/{revision}/{path...}
 * 采用流式转发，避免把 600MB 模型整体缓冲进内存。
 */
async function proxyHuggingFace(req, res, url) {
  const prefix = '/api/hf-proxy/';
  const suffix = String(url.pathname || '').startsWith(prefix)
    ? String(url.pathname || '').slice(prefix.length)
    : '';
  if (!suffix || suffix.includes('..') || suffix.startsWith('/')) {
    return send(res, 400, { success: false, error: { message: 'invalid-hf-proxy-path' } });
  }

  const origin = res._hmdaoOrigin || '';
  const corsHeaders = origin
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true' }
    : { 'Access-Control-Allow-Origin': '*' };

  const upstreamHeaders = {
    Accept: req.headers.accept || '*/*',
    'User-Agent': req.headers['user-agent'] || 'HMDao-HFProxy/1.0',
    // 关键：强制上游不压缩，避免 Node fetch 自动解压后 Content-Length（压缩长度）
    // 与真实明文 body 不一致，导致浏览器按压缩长度截断模型文件 → offset is out of bounds。
    'Accept-Encoding': 'identity',
  };
  if (req.headers.range) upstreamHeaders.Range = req.headers.range;

  // 镜像源优先（Node 可直连），huggingface.co 兜底
  const hosts = ['https://hf-mirror.com', 'https://huggingface.co'];
  let lastError = null;

  for (const host of hosts) {
    const target = `${host}/${suffix}${url.search || ''}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('hf-proxy-timeout')), 30 * 60 * 1000);
    let upstream;
    try {
      upstream = await fetch(target, {
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        headers: upstreamHeaders,
        redirect: 'follow',
        signal: controller.signal,
      });

      if (upstream.status === 404) {
        // 文件在两个源都一致不存在，直接返回 404，便于前端准确报错
        try { upstream.body?.cancel?.(); } catch { /* noop */ }
        const fh = { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
        res.writeHead(404, fh);
        res.end(JSON.stringify({ success: false, error: { message: 'model-file-not-found', path: suffix } }));
        return;
      }
      if (!upstream.ok && upstream.status !== 206) {
        // 其它非 2xx，尝试下一个源
        try { upstream.body?.cancel?.(); } catch { /* noop */ }
        lastError = new Error(`upstream ${upstream.status} from ${host}`);
        continue;
      }

      // Node fetch 默认自动解压响应体；若上游仍返回压缩内容（兜底场景），
      // 透传的 Content-Encoding/Content-Length 是「压缩后」口径，而本转发 body 已是解压明文，
      // 直接透传 Content-Length 会让浏览器按压缩长度截断 → 模型二进制损坏。
      // 因此：压缩响应不转发 Content-Length（改 chunked 真实长度）；未压缩才透传。
      const upstreamEncoding = upstream.headers.get('content-encoding');
      const isCompressed =
        !!upstreamEncoding && !/identity/i.test(upstreamEncoding);
      const forwardHeaders = {
        ...corsHeaders,
        'Access-Control-Allow-Headers': 'content-type, authorization, range',
        'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified',
        'Cache-Control': 'public, max-age=3600',
        'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
        'Accept-Ranges': upstream.headers.get('accept-ranges') || 'bytes',
      };
      const contentLength = upstream.headers.get('content-length');
      if (!isCompressed && contentLength) forwardHeaders['Content-Length'] = contentLength;
      const contentRange = upstream.headers.get('content-range');
      if (contentRange) forwardHeaders['Content-Range'] = contentRange;
      const etag = upstream.headers.get('etag');
      if (etag) forwardHeaders['ETag'] = etag;
      const lastModified = upstream.headers.get('last-modified');
      if (lastModified) forwardHeaders['Last-Modified'] = lastModified;

      res.writeHead(upstream.status, forwardHeaders);

      if (req.method === 'HEAD' || upstream.status === 204 || !upstream.body) {
        res.end();
        return;
      }

      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) {
          if (!res.write(Buffer.from(value))) {
            await new Promise((resolve) => res.once('drain', resolve));
          }
        }
      }
      res.end();
      return;
    } catch (error) {
      lastError = error;
      continue;
    } finally {
      clearTimeout(timeout);
      try { upstream?.body?.cancel?.(); } catch { /* noop */ }
    }
  }

  // 所有源都失败
  if (!res.headersSent) {
    return send(res, 502, {
      success: false,
      error: {
        message: `hf-proxy-failed: ${lastError instanceof Error ? lastError.message : String(lastError || 'all-upstreams-failed')}`,
      },
    });
  }
  // 已写出响应头，优雅关闭
  try { res.end(); } catch { /* noop */ }
}

/**
 * 路由：GET/HEAD /api/transformers/{file}
 * 同源提供 @xenova/transformers 的浏览器预构建包（含 onnxruntime-web 的 wasm），
 * 使本地翻译模型在无法访问外国 CDN（jsdelivr / cloudflare）的网络环境下也能加载。
 * 该目录同时包含 transformers.min.js 与各 ort-wasm-*.wasm，因此代码与 wasm 同源提供。
 */
async function serveTransformersModule(req, res, url) {
  const prefix = '/api/transformers/';
  if (!String(url.pathname || '').startsWith(prefix)) return false;
  const rel = decodeURIComponent(String(url.pathname || '').slice(prefix.length));
  if (
    !rel ||
    rel.includes('..') ||
    rel.startsWith('/') ||
    rel.includes('\\') ||
    rel.includes('\0')
  ) {
    send(res, 400, { success: false, error: { message: 'invalid-transformers-path' } });
    return true;
  }

  const baseDir = path.resolve(APP_DIR, 'node_modules/@xenova/transformers/dist');
  const filePath = path.resolve(baseDir, rel);
  if (filePath !== baseDir && !filePath.startsWith(baseDir + path.sep)) {
    send(res, 400, { success: false, error: { message: 'invalid-transformers-path' } });
    return true;
  }

  try {
    const st = await fs.stat(filePath);
    if (!st.isFile()) {
      send(res, 404, { success: false, error: { message: 'transformers-file-not-found' } });
      return true;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime =
      ext === '.wasm' ? 'application/wasm'
      : ext === '.js' || ext === '.mjs' ? 'application/javascript'
      : ext === '.map' ? 'application/json'
      : 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    const stream = createReadStream(filePath);
    stream.on('error', () => {
      try { res.destroy(); } catch { /* noop */ }
    });
    stream.pipe(res);
    return true;
  } catch {
    send(res, 404, { success: false, error: { message: 'transformers-file-not-found' } });
    return true;
  }
}

async function downloadRemoteMediaBuffer(targetUrl) {
  const upstream = await requestRemoteBinaryAsset(targetUrl, {
    method: 'GET',
    headers: {
      Accept: '*/*',
      'User-Agent': 'HMDao-LocalVideoEdit/1.0',
    },
    timeoutMs: 45000,
  });
  if (!(upstream.status >= 200 && upstream.status < 300)) {
    throw new Error(`remote-media-fetch-failed:${upstream.status}`);
  }
  const mimeType = readHeaderValue(upstream.headers, 'content-type');
  const bytes = upstream.body;
  return {
    bytes,
    mimeType,
  };
}

async function probeAnalyzeImageFile(filePath) {
  const { stdout } = await runCommand('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-of',
    'json',
    filePath,
  ]);
  const parsed = JSON.parse(stdout || '{}');
  return {
    width: Math.max(0, Number(parsed?.streams?.[0]?.width || 0)),
    height: Math.max(0, Number(parsed?.streams?.[0]?.height || 0)),
  };
}

function uniqueStrings(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)));
}

function classifyAssetKeyword(text, map, fallback) {
  const lowered = String(text || '').toLowerCase();
  for (const [label, tokens] of map) {
    if (tokens.some((token) => lowered.includes(token))) {
      return label;
    }
  }
  return fallback;
}

function inferImageAnalysisFallback(payload) {
  const width = Math.max(0, Number(payload?.width || 0));
  const height = Math.max(0, Number(payload?.height || 0));
  const orientation = width > 0 && height > 0
    ? width > height
      ? 'landscape'
      : width < height
        ? 'portrait'
        : 'square'
    : 'unlabeled';
  const text = [
    String(payload?.name || ''),
    String(payload?.sourceUrl || ''),
    ...parseStringArrayField(payload?.tags),
    ...parseStringArrayField(payload?.smartCategories),
  ].join(' ').toLowerCase();

  const subject = classifyAssetKeyword(text, [
    ['人物主体', ['portrait', 'person', 'people', 'face', 'woman', 'man', '人物', '人像', '模特']],
    ['产品主体', ['product', 'watch', 'phone', 'laptop', 'bag', 'product-shot', '产品', '静物']],
    ['建筑场景', ['building', 'architecture', 'city', 'interior', '建筑', '城市', '室内']],
    ['自然风景', ['landscape', 'mountain', 'forest', 'ocean', 'nature', '风景', '风光', '山水', '自然']],
    ['车辆主体', ['car', 'vehicle', 'auto', '汽车', '车辆']],
  ], '主体待确认');

  const scene = classifyAssetKeyword(text, [
    ['户外真实场景', ['outdoor', 'street', 'travel', 'mountain', 'forest', '风光', '山水', '自然', '户外']],
    ['室内棚拍场景', ['studio', 'indoor', 'interior', 'room', '棚拍', '室内']],
    ['商业产品展示场景', ['product', 'commerce', 'ecommerce', '广告', '海报', '展示']],
    ['城市叙事场景', ['city', 'urban', 'building', 'street', '城市', '街道']],
  ], '场景信息有限');

  const style = classifyAssetKeyword(text, [
    ['电影感写实', ['cinematic', 'film', 'moody', '电影', '叙事']],
    ['商业广告风', ['poster', 'ad', 'campaign', 'commercial', '广告', '海报']],
    ['极简产品风', ['minimal', 'clean', 'product', '极简', '产品']],
    ['写实摄影风', ['photo', 'photography', 'realistic', '写实', '摄影']],
    ['插画概念风', ['illustration', 'concept', 'art', '插画', '概念']],
  ], '写实参考风格');

  const lighting = classifyAssetKeyword(text, [
    ['柔和自然光', ['soft light', 'window', 'daylight', 'natural light', '柔光', '自然光']],
    ['高反差戏剧光', ['dramatic', 'hard light', 'contrast', 'rim', '戏剧', '高反差']],
    ['棚拍商业布光', ['studio', 'beauty light', 'commercial light', '棚拍', '商业布光']],
    ['氛围霓虹光', ['neon', 'cyberpunk', 'night', '霓虹', '夜景']],
  ], '光影信息有限');

  const composition = `${orientation}${width > 0 && height > 0 ? `，分辨率为${width} × ${height}` : ''}`;
  const camera = classifyAssetKeyword(text, [
    ['中近景镜头', ['close', 'portrait', 'mid-shot', '特写', '近景', '人像']],
    ['广角环境镜头', ['wide', 'landscape', 'environment', '全景', '广角', '风景']],
    ['产品特写镜头', ['macro', 'detail', 'product', '特写', '细节', '产品']],
  ], '镜头语言待补充');
  const mood = classifyAssetKeyword(text, [
    ['高级商业风', ['luxury', 'premium', 'commercial', '高级', '商业']],
    ['安静自然风', ['nature', 'soft', 'daylight', '安静', '自然']],
    ['戏剧张力感', ['dramatic', 'contrast', 'night', '张力', '戏剧']],
  ], '氛围信息有限');

  const keywords = uniqueStrings([
    subject,
    scene,
    style,
    lighting,
    camera,
    mood,
    ...parseStringArrayField(payload?.tags),
    ...parseStringArrayField(payload?.smartCategories),
  ]).slice(0, 12);

  return {
    engine: 'local-heuristic-fallback',
    summary: subject + ', ' + scene + ', ' + style + ', ' + lighting + ', ' + camera + '.',
    subject,
    scene,
    style,
    lighting,
    composition,
    camera,
    mood,
    keywords,
    promptZh: 'Keep ' + subject + ' in a ' + composition + ' layout, place it in ' + scene + ', render it with ' + style + ', ' + lighting + ', ' + camera + ', and a ' + mood + ' mood.',
    promptEn: 'Keep the original ' + orientation + ' framing, emphasize ' + subject + ', place it in ' + scene + ', render it in a ' + style + ' look with ' + lighting + ', use ' + camera + ', and preserve a ' + mood + ' mood with clean details for poster-ready image generation.',
    warnings: [
      '当前未接入本地多模态模型，结果由本地启发式链路生成',
      '如需更强解析，建议优先配置 CLIP Interrogator、Florence-2 或 Qwen 视觉的 wrapper',
    ],
    runtime: {
      wrapperConfigured: Boolean(String(process.env.HMDAO_IMAGE_ANALYSIS_COMMAND || '').trim()),
      wrapperCommand: String(process.env.HMDAO_IMAGE_ANALYSIS_COMMAND || '').trim() ? 'custom' : '',
      recommendedModels: ['CLIP Interrogator', 'Florence-2', 'Qwen Vision'],
    },
    metadata: {
      width,
      height,
      orientation,
      sourceKind: payload?.inputPath ? 'upload' : /^https?:\/\//i.test(String(payload?.sourceUrl || '')) ? 'remote-url' : 'unknown',
    },
    analyzedAt: Date.now(),
  };
}

function normalizeImageAnalysisResult(raw, fallback) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    ...fallback,
    engine: String(source.engine || fallback.engine),
    summary: String(source.summary || fallback.summary),
    subject: String(source.subject || fallback.subject),
    scene: String(source.scene || fallback.scene),
    style: String(source.style || fallback.style),
    lighting: String(source.lighting || fallback.lighting),
    composition: String(source.composition || fallback.composition),
    camera: String(source.camera || fallback.camera),
    mood: String(source.mood || fallback.mood),
    keywords: uniqueStrings(Array.isArray(source.keywords) ? source.keywords : fallback.keywords).slice(0, 16),
    promptZh: String(source.promptZh || source.prompt_zh || fallback.promptZh),
    promptEn: String(source.promptEn || source.prompt_en || fallback.promptEn),
    palette: uniqueStrings(Array.isArray(source.palette) ? source.palette : fallback.palette || []).slice(0, 8),
    warnings: uniqueStrings(Array.isArray(source.warnings) ? source.warnings : fallback.warnings || []).slice(0, 8),
    runtime: {
      ...(fallback.runtime || {}),
      ...(source.runtime && typeof source.runtime === 'object' && !Array.isArray(source.runtime) ? source.runtime : {}),
    },
    metadata: {
      ...(fallback.metadata || {}),
      ...(source.metadata && typeof source.metadata === 'object' && !Array.isArray(source.metadata) ? source.metadata : {}),
    },
    analyzedAt: Date.now(),
  };
}

function getConfiguredImageAnalysisCommands() {
  const genericCommand = String(process.env.HMDAO_IMAGE_ANALYSIS_COMMAND || '').trim();
  return {
    genericCommand,
    clipInterrogator: resolveLocalImageWrapperCommand({
      envCommand: 'HMDAO_CLIP_INTERROGATOR_COMMAND',
      envPath: 'HMDAO_CLIP_INTERROGATOR_PATH',
    }).commandLine || genericCommand,
    florence2: resolveLocalImageWrapperCommand({
      envCommand: 'HMDAO_FLORENCE2_COMMAND',
      envPath: 'HMDAO_FLORENCE2_PATH',
      wrapperKey: 'florence2',
    }).commandLine || genericCommand,
    qwen35vl: resolveLocalImageWrapperCommand({
      envCommand: 'HMDAO_QWEN35_VL_COMMAND',
      envPath: 'HMDAO_QWEN35_VL_PATH',
      wrapperKey: 'qwen35-vl',
    }).commandLine,
    qwen25vl: resolveLocalImageWrapperCommand({
      envCommand: 'HMDAO_QWEN25_VL_COMMAND',
      envPath: 'HMDAO_QWEN25_VL_PATH',
    }).commandLine,
    customApi: resolveLocalImageWrapperCommand({
      envCommand: 'HMDAO_IMAGE_ANALYSIS_API_COMMAND',
      envPath: 'HMDAO_IMAGE_ANALYSIS_API_PATH',
    }).commandLine,
  };
}

function buildDirectImageAnalysisCommandFromPath(runtimePath = '') {
  const normalized = String(runtimePath || '').trim();
  if (!normalized) return '';
  const resolvedPath = path.resolve(normalized);
  const shellSafePath = resolvedPath.replace(/\\/g, '/');
  const ext = path.extname(resolvedPath).toLowerCase();
  if (ext === '.py') return 'py -3 "' + shellSafePath + '" --payload {{payloadPath}}';
  if (ext === '.ps1') return 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + shellSafePath + '" --payload {{payloadPath}}';
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'node "' + shellSafePath + '" --payload {{payloadPath}}';
  return '"' + shellSafePath + '" --payload {{payloadPath}}';
}

function resolveLocalImageWrapperCommand({ envCommand = '', envPath = '', wrapperKey = '' } = {}) {
  let commandLine = envCommand ? String(process.env[envCommand] || '').trim() : '';
  const detectedPath = envPath ? String(process.env[envPath] || '').trim() : '';
  const wrapperScript = wrapperKey ? LOCAL_IMAGE_ANALYSIS_BACKEND_WRAPPERS[wrapperKey] : '';
  if (!commandLine && detectedPath && wrapperScript) {
    const relativeWrapperScript = path.relative(APP_DIR, wrapperScript).replace(/\\/g, '/');
    commandLine = 'node ./' + relativeWrapperScript;
  }
  if (!commandLine && detectedPath && !wrapperScript) {
    commandLine = buildDirectImageAnalysisCommandFromPath(detectedPath);
  }
  return {
    commandLine,
    detectedPath,
  };
}

function getConfiguredImageAnalysisRuntimes() {
  const commands = getConfiguredImageAnalysisCommands();
  const preferredQwenCommand = String(commands.qwen35vl || commands.qwen25vl || commands.genericCommand || '').trim();
  const configured = [
    { id: 'clip-interrogator', commandLine: commands.clipInterrogator || commands.genericCommand, priority: 10 },
    { id: 'florence2', commandLine: commands.florence2 || commands.genericCommand, priority: 20 },
    { id: 'qwen35-vl', commandLine: preferredQwenCommand, priority: 30 },
    { id: 'custom-api', commandLine: commands.customApi, priority: 40 },
  ]
    .filter((item) => String(item.commandLine || '').trim())
    .sort((left, right) => left.priority - right.priority);
  return configured.filter((item, index, list) => list.findIndex((entry) => entry.id === item.id) === index);
}

function resolveImageAnalysisRuntime(requestedEngine = 'auto', preferred = null) {
  const requested = String(requestedEngine || 'auto').trim().toLowerCase() || 'auto';
  const commands = getConfiguredImageAnalysisCommands();
  const configuredRuntimes = getConfiguredImageAnalysisRuntimes();
  const activatedCloudImageAnalysis = pickActivatedCloudImageAnalysisRuntime();
  // 用户显式选择的 provider 若已激活（严格匹配）且未配置本地 custom-api 命令时，优先走该云端模型（模型选择生效）；
  // 未激活则不强制远程，保持免 Key 本地链路（可预期、忠实于用户所选）。
  const preferredProvider = preferred && String(preferred.provider || '').trim().toLowerCase();
  if (preferredProvider && !String(commands.customApi || '').trim()) {
    const preferredCloud = pickActivatedCloudImageAnalysisRuntime(preferred);
    if (preferredCloud && String(preferredCloud.provider || '').trim().toLowerCase() === preferredProvider) {
      // 用户在前端显式选择的模型优先（让面板选中的具体视觉模型真正生效），否则用激活记录中的模型
      const resolvedModel = String(preferred?.model || '').trim() || String(preferredCloud.model || '').trim();
      return {
        requested,
        resolved: 'custom-api',
        commandLine: '',
        chain: ['custom-api'],
        mode: 'remote',
        remoteProvider: String(preferredCloud.provider || '').trim(),
        remoteModel: resolvedModel,
        remoteEndpoint: String(preferredCloud.endpoint || '').trim(),
        remoteApiKey: String(preferredCloud.apiKey || '').trim(),
      };
    }
  }
  const preferredQwenCommand = String(commands.qwen35vl || commands.qwen25vl || commands.genericCommand || '').trim();
  const preferredQwenResolved = commands.qwen35vl
    ? 'qwen35-vl'
    : commands.qwen25vl
      ? 'qwen25-vl'
      : 'local-heuristic';
  const fusionChain = configuredRuntimes
    .filter((item) => ['clip-interrogator', 'qwen35-vl', 'florence2', 'custom-api'].includes(item.id))
    .map((item) => item.id);
  const autoPreferred = fusionChain.length >= 2
    ? {
        envCommand: '__HMDAO_PROMPT_FUSION__',
        resolved: 'prompt-fusion',
        chain: fusionChain,
        mode: 'fusion',
      }
    : configuredRuntimes[0]
      ? {
          envCommand: configuredRuntimes[0].commandLine,
          resolved: configuredRuntimes[0].id,
          chain: [configuredRuntimes[0].id],
          mode: 'single',
        }
      : {
          envCommand: '',
          resolved: 'local-heuristic',
          chain: [],
          mode: 'fallback',
        };
  const engineConfig = {
    auto: autoPreferred,
    'local-heuristic': {
      envCommand: '',
      resolved: 'local-heuristic',
      chain: [],
      mode: 'fallback',
    },
    'prompt-fusion': {
      envCommand: fusionChain.length > 0 ? '__HMDAO_PROMPT_FUSION__' : '',
      resolved: fusionChain.length > 0 ? 'prompt-fusion' : 'local-heuristic',
      chain: fusionChain,
      mode: fusionChain.length > 0 ? 'fusion' : 'fallback',
    },
    'clip-interrogator': {
      envCommand: commands.clipInterrogator || commands.genericCommand,
      resolved: 'clip-interrogator',
      chain: commands.clipInterrogator || commands.genericCommand ? ['clip-interrogator'] : [],
      mode: commands.clipInterrogator || commands.genericCommand ? 'single' : 'fallback',
    },
    florence2: {
      envCommand: commands.florence2 || commands.genericCommand,
      resolved: 'florence2',
      chain: commands.florence2 || commands.genericCommand ? ['florence2'] : [],
      mode: commands.florence2 || commands.genericCommand ? 'single' : 'fallback',
    },
    'qwen25-vl': {
      envCommand: preferredQwenCommand,
      resolved: preferredQwenResolved,
      chain: preferredQwenCommand ? [preferredQwenResolved] : [],
      mode: preferredQwenCommand ? 'single' : 'fallback',
    },
    'qwen35-vl': {
      envCommand: preferredQwenCommand,
      resolved: preferredQwenResolved,
      chain: preferredQwenCommand ? [preferredQwenResolved] : [],
      mode: preferredQwenCommand ? 'single' : 'fallback',
    },
    'custom-api': {
      envCommand: commands.customApi,
      resolved: 'custom-api',
      chain: commands.customApi
        ? ['custom-api']
        : activatedCloudImageAnalysis
          ? ['custom-api']
          : [],
      mode: commands.customApi
        ? 'single'
        : activatedCloudImageAnalysis
          ? 'remote'
          : 'fallback',
      remoteProvider: activatedCloudImageAnalysis?.provider || '',
      remoteModel: activatedCloudImageAnalysis?.model || '',
      remoteEndpoint: activatedCloudImageAnalysis?.endpoint || '',
      remoteApiKey: activatedCloudImageAnalysis?.apiKey || '',
    },
  };
  const selected = engineConfig[requested] || engineConfig.auto;
  return {
    requested,
    resolved: selected.resolved,
    commandLine: String(selected.envCommand || '').trim(),
    chain: Array.isArray(selected.chain) ? selected.chain : [],
    mode: String(selected.mode || (String(selected.envCommand || '').trim() ? 'single' : 'fallback')),
    remoteProvider: String(selected.remoteProvider || '').trim(),
    remoteModel: String(selected.remoteModel || '').trim(),
    remoteEndpoint: String(selected.remoteEndpoint || '').trim(),
    remoteApiKey: String(selected.remoteApiKey || '').trim(),
  };
}

function pickActivatedCloudImageAnalysisRuntime(preferred = null) {
  const rankedProviders = ['openai', 'siliconflow', 'bailian', 'modelscope', 'zhipu', 'volcengine', 'deepseek', 'minimax'];
  const candidates = listActivatedProviderRecords()
    .filter((record) => (
      // 只选 LLM 模式模型做分析；图像/视频生成模型（wanx/flux/seedance）不能用于图片分析
      String(record?.mode || '').trim().toLowerCase() === 'llm'
      && String(record?.apiKey || '').trim()
      && String(record?.model || '').trim()
      && String(record?.endpoint || PROVIDER_BASE_URLS[record?.provider] || '').trim()
    ))
    .sort((left, right) => {
      const leftProvider = rankedProviders.indexOf(String(left?.provider || '').trim());
      const rightProvider = rankedProviders.indexOf(String(right?.provider || '').trim());
      const leftRank = leftProvider === -1 ? rankedProviders.length : leftProvider;
      const rightRank = rightProvider === -1 ? rankedProviders.length : rightProvider;
      if (leftRank !== rightRank) return leftRank - rightRank;
      // 优先选择真正具备视觉理解能力的模型
      const leftVision = isVisionModelId(left?.model) ? 1 : 0;
      const rightVision = isVisionModelId(right?.model) ? 1 : 0;
      if (leftVision !== rightVision) return rightVision - leftVision;
      return Number(right?.activatedAt || 0) - Number(left?.activatedAt || 0);
    });
  // 用户在前端显式选择的 provider 优先；未匹配则回退到默认排序首位
  const preferredProvider = preferred && String(preferred.provider || '').trim().toLowerCase();
  const target = (preferredProvider
    ? candidates.find((record) => String(record?.provider || '').trim().toLowerCase() === preferredProvider)
    : null) || candidates[0];
  if (!target) return null;
  return {
    provider: String(target.provider || '').trim(),
    model: String(target.model || '').trim(),
    endpoint: String(target.endpoint || PROVIDER_BASE_URLS[target.provider] || '').trim().replace(/\/$/, ''),
    apiKey: String(target.apiKey || '').trim(),
    mode: 'llm',
  };
}

function buildImageAnalysisRemotePrompt(payload = {}) {
  const tags = parseStringArrayField(payload?.tags).slice(0, 12);
  const smartCategories = parseStringArrayField(payload?.smartCategories).slice(0, 12);
  const sizeHint = [
    Number(payload?.width || 0) > 0 ? 'width ' + Number(payload.width) + ' px' : '',
    Number(payload?.height || 0) > 0 ? 'height ' + Number(payload.height) + ' px' : '',
  ].filter(Boolean).join(' x ');
  return [
    'Analyze this image into structured prompt fields for image or video generation, and return JSON only.',
    'Required JSON fields: engine, summary, subject, scene, style, lighting, composition, camera, mood, keywords, promptZh, promptEn, palette.',
    'keywords and palette must be string arrays.',
    'promptZh should be a concise generation prompt focused on subject consistency, style, lighting, composition, and camera language.',
    'promptEn should be the English version suitable for image and video generation models.',
    tags.length ? 'Known tags: ' + tags.join(', ') + '.' : '',
    smartCategories.length ? 'Known categories: ' + smartCategories.join(', ') + '.' : '',
    sizeHint ? 'Size reference: ' + sizeHint + '.' : '',
  ].filter(Boolean).join('\n');
}

function extractJsonObjectFromText(value = '') {
  const text = String(value || '').trim();
  if (!text) return null;
  const stripped = text.startsWith('```json') ? text.slice(7) : (text.startsWith('```') ? text.slice(3) : text);
  const normalizedStripped = stripped.endsWith('```') ? stripped.slice(0, -3).trim() : stripped.trim();
  const directCandidates = [
    text,
    normalizedStripped,
  ];
  for (const candidate of directCandidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // try next
    }
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

async function buildImageDataUrl(inputPath = '', mimeType = 'image/jpeg') {
  const bytes = await fs.readFile(inputPath);
  return `data:${String(mimeType || 'image/jpeg').trim() || 'image/jpeg'};base64,${bytes.toString('base64')}`;
}

async function runRemoteImageAnalysis(runtime, normalizedPayload, fallback) {
  const endpoint = String(runtime?.remoteEndpoint || '').trim().replace(/\/$/, '');
  const model = String(runtime?.remoteModel || '').trim();
  const apiKey = String(runtime?.remoteApiKey || '').trim();
  if (!endpoint || !model || !apiKey) {
    return {
      ...fallback,
      warnings: uniqueStrings([
        ...(Array.isArray(fallback?.warnings) ? fallback.warnings : []),
        '自定义 API 未检测到可用的云端视觉模型，已回退到本地链路',
      ]).slice(0, 12),
    };
  }

  const imageUrl = normalizedPayload?.inputPath
    ? await buildImageDataUrl(normalizedPayload.inputPath, normalizedPayload.inputMimeType || 'image/jpeg')
    : String(normalizedPayload?.sourceUrl || '').trim();
  if (!imageUrl) {
    return {
      ...fallback,
      warnings: uniqueStrings([
        ...(Array.isArray(fallback?.warnings) ? fallback.warnings : []),
        '自定义 API 缺少可分析的图片输入，已回退到本地链路',
      ]).slice(0, 12),
    };
  }

  const requestBody = {
    model,
    temperature: 0.2,
    max_tokens: 1200,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: 'You are a multimodal creative director. Return only valid JSON.',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: buildImageAnalysisRemotePrompt(normalizedPayload) },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
    ],
  };

  try {
    const response = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!response.ok) {
      const remoteMessage = extractFirstString(data?.error?.message) || extractFirstString(data?.message) || `HTTP ${response.status}`;
      return {
        ...fallback,
        warnings: uniqueStrings([
          ...(Array.isArray(fallback?.warnings) ? fallback.warnings : []),
          `自定义 API 调用失败，已回退到本地链路：${remoteMessage}`,
        ]).slice(0, 12),
        runtime: {
          ...(fallback?.runtime || {}),
          provider: String(runtime?.remoteProvider || '').trim(),
          model,
          endpoint,
        },
      };
    }

    const content = extractFirstString(data?.choices?.[0]?.message?.content)
      || extractFirstString(data?.choices?.[0]?.text)
      || extractFirstString(data?.output_text)
      || extractFirstString(data?.content)
      || extractFirstString(data?.text);
    const parsed = extractJsonObjectFromText(content);
    if (!parsed || typeof parsed !== 'object') {
      return {
        ...fallback,
        warnings: uniqueStrings([
          ...(Array.isArray(fallback?.warnings) ? fallback.warnings : []),
          '自定义 API 返回了非结构化结果，已回退到本地链路',
        ]).slice(0, 12),
        runtime: {
          ...(fallback?.runtime || {}),
          provider: String(runtime?.remoteProvider || '').trim(),
          model,
          endpoint,
        },
      };
    }

    return normalizeImageAnalysisResult({
      ...parsed,
      warnings: uniqueStrings([
        ...(Array.isArray(parsed?.warnings) ? parsed.warnings : []),
        '已通过自定义 API 云端模型完成视觉反推',
      ]).slice(0, 8),
    }, {
      ...fallback,
      engine: `custom-api:${String(runtime?.remoteProvider || 'remote').trim()}/${model}`,
      runtime: {
        ...(fallback?.runtime || {}),
        wrapperConfigured: true,
        wrapperCommand: 'custom-api',
        requestedEngine: String(runtime?.requested || 'custom-api'),
        resolvedEngine: 'custom-api',
        provider: String(runtime?.remoteProvider || '').trim(),
        model,
        endpoint,
      },
      metadata: {
        ...(fallback?.metadata || {}),
        requestedEngine: String(runtime?.requested || 'custom-api'),
        resolvedEngine: 'custom-api',
        provider: String(runtime?.remoteProvider || '').trim(),
        model,
        endpoint,
      },
    });
  } catch (error) {
    return {
      ...fallback,
      warnings: uniqueStrings([
        ...(Array.isArray(fallback?.warnings) ? fallback.warnings : []),
        `自定义 API 调用异常，已回退到本地链路：${error instanceof Error ? error.message : String(error)}`,
      ]).slice(0, 12),
      runtime: {
        ...(fallback?.runtime || {}),
        provider: String(runtime?.remoteProvider || '').trim(),
        model,
        endpoint,
      },
    };
  }
}

function isMeaningfulImageAnalysisText(value = '') {
  const normalized = String(value || '').trim();
  if (!normalized) return false;
  const lowered = normalized.toLowerCase();
  const placeholders = [
    'main subject',
    'scene context',
    'visual style',
    'lighting mood',
    'composition layout',
    'camera language',
    'overall atmosphere',
    '主体待确认',
    '场景信息有限',
    '写实参考风格',
    '光影信息有限',
    '镜头语言待补充',
    '氛围信息有限',
  ];
  return !placeholders.includes(lowered) && !placeholders.includes(normalized);
}

function pickPreferredImageAnalysisField(...values) {
  for (const value of values) {
    if (isMeaningfulImageAnalysisText(value)) return String(value).trim();
  }
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized) return normalized;
  }
  return '';
}

function buildMergedImagePromptZh(fields = {}, fallback = {}) {
  const subject = pickPreferredImageAnalysisField(fields.subject, fallback.subject, '主体');
  const scene = pickPreferredImageAnalysisField(fields.scene, fallback.scene, '场景');
  const style = pickPreferredImageAnalysisField(fields.style, fallback.style, '风格');
  const lighting = pickPreferredImageAnalysisField(fields.lighting, fallback.lighting, '光影');
  const composition = pickPreferredImageAnalysisField(fields.composition, fallback.composition, '原始构图');
  const camera = pickPreferredImageAnalysisField(fields.camera, fallback.camera, '镜头语言');
  const mood = pickPreferredImageAnalysisField(fields.mood, fallback.mood, '整体氛围');
  return 'Preserve ' + composition + ', keep the subject placement centered on ' + subject + ', place it in ' + scene + ', render it with ' + style + ', shape the scene with ' + lighting + ', emphasize ' + camera + ', and maintain a ' + mood + ' atmosphere with stronger detail.';
}

function buildMergedImagePromptEn(fields = {}, fallback = {}) {
  const subject = pickPreferredImageAnalysisField(fields.subject, fallback.subject, 'main subject');
  const scene = pickPreferredImageAnalysisField(fields.scene, fallback.scene, 'scene');
  const style = pickPreferredImageAnalysisField(fields.style, fallback.style, 'visual style');
  const lighting = pickPreferredImageAnalysisField(fields.lighting, fallback.lighting, 'lighting');
  const composition = pickPreferredImageAnalysisField(fields.composition, fallback.composition, 'original composition');
  const camera = pickPreferredImageAnalysisField(fields.camera, fallback.camera, 'camera language');
  const mood = pickPreferredImageAnalysisField(fields.mood, fallback.mood, 'overall mood');
  return `Preserve the ${composition}, keep the subject placement and framing locked, center the image around ${subject}, place it in ${scene}, render it with ${style}, shape the scene with ${lighting}, emphasize ${camera}, and maintain a ${mood} atmosphere with stronger texture, material, and color detail.`;
}

function mergeImageAnalysisResults(fallback, results = [], runtime = null) {
  const validResults = results.filter((item) => item && typeof item === 'object');
  if (!validResults.length) return fallback;
  const preferredOrder = ['qwen35-vl', 'qwen2.5-omni', 'qwen25-vl', 'qwen2.5-vl', 'florence2', 'clip-interrogator'];
  const sorted = [...validResults].sort((left, right) => {
    const leftEngine = String(left?.metadata?.resolvedEngine || left?.engine || '').toLowerCase();
    const rightEngine = String(right?.metadata?.resolvedEngine || right?.engine || '').toLowerCase();
    const leftIndex = preferredOrder.findIndex((item) => leftEngine.includes(item));
    const rightIndex = preferredOrder.findIndex((item) => rightEngine.includes(item));
    return (leftIndex === -1 ? 99 : leftIndex) - (rightIndex === -1 ? 99 : rightIndex);
  });
  const detailFirst = sorted[0] || fallback;
  const styleFirst = sorted.find((item) => String(item?.engine || '').toLowerCase().includes('clip-interrogator')) || detailFirst;
  const merged = {
    ...fallback,
    engine: runtime?.resolved === 'prompt-fusion'
      ? `prompt-fusion:${(runtime?.chain || []).join('+') || 'local'}`
      : String(detailFirst.engine || fallback.engine),
    summary: pickPreferredImageAnalysisField(detailFirst.summary, styleFirst.summary, fallback.summary),
    subject: pickPreferredImageAnalysisField(detailFirst.subject, styleFirst.subject, fallback.subject),
    scene: pickPreferredImageAnalysisField(detailFirst.scene, styleFirst.scene, fallback.scene),
    style: pickPreferredImageAnalysisField(styleFirst.style, detailFirst.style, fallback.style),
    lighting: pickPreferredImageAnalysisField(styleFirst.lighting, detailFirst.lighting, fallback.lighting),
    composition: pickPreferredImageAnalysisField(detailFirst.composition, styleFirst.composition, fallback.composition),
    camera: pickPreferredImageAnalysisField(detailFirst.camera, styleFirst.camera, fallback.camera),
    mood: pickPreferredImageAnalysisField(styleFirst.mood, detailFirst.mood, fallback.mood),
    keywords: uniqueStrings([
      ...(Array.isArray(detailFirst.keywords) ? detailFirst.keywords : []),
      ...(Array.isArray(styleFirst.keywords) ? styleFirst.keywords : []),
      ...(Array.isArray(fallback.keywords) ? fallback.keywords : []),
    ]).slice(0, 20),
    palette: uniqueStrings([
      ...(Array.isArray(styleFirst.palette) ? styleFirst.palette : []),
      ...(Array.isArray(detailFirst.palette) ? detailFirst.palette : []),
      ...(Array.isArray(fallback.palette) ? fallback.palette : []),
    ]).slice(0, 8),
    warnings: uniqueStrings([
      ...(Array.isArray(fallback.warnings) ? fallback.warnings : []),
      ...validResults.flatMap((item) => Array.isArray(item?.warnings) ? item.warnings : []),
    ]).slice(0, 12),
    runtime: {
      ...(fallback.runtime || {}),
      wrapperConfigured: true,
      wrapperCommand: runtime?.resolved || 'prompt-fusion',
      requestedEngine: runtime?.requested || fallback?.runtime?.requestedEngine || 'auto',
      resolvedEngine: runtime?.resolved || 'prompt-fusion',
      fusionEngines: Array.isArray(runtime?.chain) ? runtime.chain : [],
      recommendedModels: ['CLIP Interrogator', 'Florence-2', 'Qwen Vision'],
    },
    metadata: {
      ...(fallback.metadata || {}),
      fusionEngines: Array.isArray(runtime?.chain) ? runtime.chain : [],
    },
  };
  merged.promptZh = buildMergedImagePromptZh(merged, fallback);
  merged.promptEn = pickPreferredImageAnalysisField(
    validResults.find((item) => isMeaningfulImageAnalysisText(item?.promptEn))?.promptEn,
    buildMergedImagePromptEn(merged, fallback),
    fallback.promptEn,
  );
  return merged;
}

async function runSingleImageAnalysisEngine(runtime, normalizedPayload, fallback, cleanupPaths = []) {
  if (!runtime?.commandLine) {
    return fallback;
  }
  const wrapperPayloadPath = path.join(
    LOCAL_IMAGE_ANALYSIS_DIR,
    `${String(normalizedPayload?.requestId || crypto.randomUUID())}-${String(runtime.resolved || 'analysis')}-payload.json`,
  );
  cleanupPaths.push(wrapperPayloadPath);
  const wrapperResult = await runJsonWrapperCommand(runtime.commandLine, normalizedPayload, {
    cwd: APP_DIR,
    payloadPath: wrapperPayloadPath,
    env: {
      HMDAO_IMAGE_ANALYSIS_INPUT: String(normalizedPayload?.inputPath || ''),
      HMDAO_IMAGE_ANALYSIS_ENGINE: String(runtime.resolved || ''),
    },
  });
  return normalizeImageAnalysisResult(wrapperResult.parsed, {
    ...fallback,
    metadata: {
      ...(fallback?.metadata || {}),
      requestedEngine: runtime.requested,
      resolvedEngine: runtime.resolved,
    },
  });
}

async function runFusedImageAnalysis(runtime, normalizedPayload, fallback, cleanupPaths = []) {
  const chain = Array.isArray(runtime?.chain) ? runtime.chain : [];
  const results = [];
  const warnings = [];
  for (const engineId of chain) {
    const engineRuntime = resolveImageAnalysisRuntime(engineId);
    if (!engineRuntime.commandLine) continue;
    try {
      const result = await runSingleImageAnalysisEngine(
        {
          ...engineRuntime,
          requested: runtime?.requested || engineRuntime.requested,
        },
        {
          ...normalizedPayload,
          engine: engineId,
        },
        fallback,
        cleanupPaths,
      );
      results.push(result);
    } catch (error) {
      warnings.push(`${engineId} wrapper failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!results.length) {
    return {
      ...fallback,
      warnings: uniqueStrings([
        ...(Array.isArray(fallback?.warnings) ? fallback.warnings : []),
        ...warnings,
        '提示词融合链未拿到有效结果，已回退到本地启发式分析',
      ]).slice(0, 12),
      runtime: {
        ...(fallback?.runtime || {}),
        wrapperConfigured: false,
        fusionEngines: chain,
      },
      metadata: {
        ...(fallback?.metadata || {}),
        fusionEngines: chain,
      },
    };
  }

  const merged = mergeImageAnalysisResults(fallback, results, runtime);
  merged.warnings = uniqueStrings([
    ...(Array.isArray(merged?.warnings) ? merged.warnings : []),
    ...warnings,
  ]).slice(0, 12);
  return merged;
}

async function processLocalImageAnalyzeRequest(payload) {
  await fs.mkdir(LOCAL_IMAGE_ANALYSIS_DIR, { recursive: true });
  const requestId = crypto.randomUUID();
  const cleanupPaths = Array.isArray(payload?.cleanupPaths) ? [...payload.cleanupPaths] : [];
  let inputPath = String(payload?.inputPath || '').trim();
  let inputMimeType = String(payload?.inputMimeType || '').trim() || 'image/jpeg';
  let width = Math.max(0, Number(payload?.width || 0));
  let height = Math.max(0, Number(payload?.height || 0));

  try {
    const sourceUrl = String(payload?.sourceUrl || '').trim();
    if (!inputPath && /^https?:\/\//i.test(sourceUrl)) {
      const remote = await downloadRemoteMediaBuffer(sourceUrl);
      inputMimeType = remote.mimeType || inputMimeType;
      const ext = imageExtensionFromMimeType(inputMimeType);
      inputPath = path.join(LOCAL_IMAGE_ANALYSIS_DIR, `${requestId}-remote.${ext}`);
      cleanupPaths.push(inputPath);
      await fs.writeFile(inputPath, remote.bytes);
    }

    if (inputPath && (!width || !height)) {
      const probed = await probeAnalyzeImageFile(inputPath).catch(() => ({ width: 0, height: 0 }));
      width = width || probed.width;
      height = height || probed.height;
    }

    const normalizedPayload = {
      ...payload,
      requestId,
      inputPath,
      inputMimeType,
      width,
      height,
      engine: String(payload?.engine || 'auto'),
      tags: parseStringArrayField(payload?.tags),
      smartCategories: parseStringArrayField(payload?.smartCategories),
    };
    const fallback = inferImageAnalysisFallback(normalizedPayload);
    const preferredRuntime = {
      provider: String(payload?.provider || '').trim(),
      model: String(payload?.model || '').trim(),
    };
    const runtime = resolveImageAnalysisRuntime(
      normalizedPayload.engine,
      preferredRuntime.provider ? preferredRuntime : null,
    );
    fallback.runtime = {
      ...(fallback.runtime || {}),
      requestedEngine: runtime.requested,
      resolvedEngine: runtime.resolved,
      wrapperConfigured: Boolean(runtime.commandLine) || runtime.mode === 'remote',
      wrapperCommand: runtime.commandLine ? runtime.resolved : runtime.mode === 'remote' ? 'custom-api' : '',
      provider: String(runtime.remoteProvider || '').trim(),
      model: String(runtime.remoteModel || '').trim(),
      endpoint: String(runtime.remoteEndpoint || '').trim(),
    };
    fallback.metadata = {
      ...(fallback.metadata || {}),
      requestedEngine: runtime.requested,
      resolvedEngine: runtime.resolved,
    };

    if (!runtime.commandLine) {
      if (runtime.mode === 'remote') {
        return await runRemoteImageAnalysis(runtime, normalizedPayload, fallback);
      }
      return fallback;
    }

    if (runtime.mode === 'fusion') {
      return await runFusedImageAnalysis(runtime, normalizedPayload, fallback, cleanupPaths);
    }

    return await runSingleImageAnalysisEngine(runtime, normalizedPayload, fallback, cleanupPaths);
  } finally {
    await Promise.all(cleanupPaths.map((filePath) => fs.rm(filePath, { force: true }).catch(() => {})));
  }
}

function configuredUnrealCameras() {
  const raw = String(process.env.HMDAO_UNREAL_CAMERAS || '').trim();
  if (!raw) return DCC_CAMERA_SETS.unreal.map((name, index) => ({ name, label: name, active: index === 0, engine: 'unreal' }));
  return raw.split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name, index) => ({ name, label: name, active: index === 0, engine: 'unreal' }));
}

async function readUnrealConfig() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(UNREAL_CONFIG_FILE, 'utf8');
    const normalized = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = JSON.parse(normalized);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeUnrealConfig(config) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(UNREAL_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

async function getUnrealControlConfig() {
  const stored = await readUnrealConfig();
  const controlObjectPath = String(process.env.HMDAO_UNREAL_CONTROL_OBJECT_PATH || stored.controlObjectPath || '').trim();
  const cameraFunction = String(process.env.HMDAO_UNREAL_CAMERA_FUNCTION || stored.cameraFunction || 'SetHMDaoCamera').trim() || 'SetHMDaoCamera';
  const signalUrl = String(process.env.HMDAO_UNREAL_SIGNAL_URL || stored.signalUrl || 'ws://127.0.0.1:8888').trim();
  return {
    controlObjectPath,
    cameraFunction,
    signalUrl,
    configured: Boolean(controlObjectPath),
    source: process.env.HMDAO_UNREAL_CONTROL_OBJECT_PATH ? 'env' : stored.controlObjectPath ? 'file' : 'unset',
  };
}

function requestModuleFor(protocol) {
  return protocol === 'https:' ? https : http;
}

function nativeHttpRequest(url, { method = 'GET', timeoutMs = 2500, headers = {}, responseType = 'text' } = {}) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      resolve({ ok: false, status: 0, error: 'invalid-url' });
      return;
    }

    const requestLib = requestModuleFor(parsed.protocol);
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
    const req = requestLib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port,
        path: `${parsed.pathname || '/'}${parsed.search || ''}`,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          if (responseType === 'buffer') {
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 500,
              status: res.statusCode || 0,
              bodyBuffer: body,
              headers: res.headers,
            });
            return;
          }
          if (responseType === 'json') {
            try {
              const data = JSON.parse(body.toString('utf8'));
              resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode || 0, data, headers: res.headers });
            } catch {
              resolve({ ok: false, status: res.statusCode || 0, error: 'invalid-json', data: null, headers: res.headers });
            }
            return;
          }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 500, status: res.statusCode || 0, body: body.toString('utf8'), headers: res.headers });
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (error) => {
      resolve({ ok: false, status: 0, error: error instanceof Error ? error.message : String(error), code: error?.code || '' });
    });
    req.end();
  });
}

const UNREAL_PIXEL_STREAMING_LEGACY = createUnrealPixelStreamingLegacyModule({
  repoRoot: REPO_ROOT,
  getControlConfig: getUnrealControlConfig,
  nativeHttpRequest,
  probeTcp,
  normalizeHttpUrl,
  configuredUnrealCameras,
  defaultPixelUrl: DEFAULT_UNREAL_PIXEL_URL,
  defaultRemoteUrl: DEFAULT_UNREAL_REMOTE_URL,
  send,
  sendRaw,
});

async function callUnrealCameraSwitch(remoteUrl, cameraName) {
  const controlConfig = await getUnrealControlConfig();
  const objectPath = controlConfig.controlObjectPath;
  const functionName = controlConfig.cameraFunction;
  if (!objectPath) return { called: false, reason: 'HMDAO_UNREAL_CONTROL_OBJECT_PATH is required.' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${remoteUrl}/remote/object/call`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        objectPath,
        functionName,
        parameters: { CameraName: cameraName, cameraName },
        generateTransaction: false,
      }),
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    return { called: response.ok, status: response.status, data };
  } catch (error) {
    return { called: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

function connectUpstreamWebSocket(config, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: config.port });
    const key = crypto.randomBytes(16).toString('base64');
    let handshake = Buffer.alloc(0);
    let settled = false;
    let parserReady = false;
    const timeout = setTimeout(() => fail(new Error('DCC connection timed out.')), timeoutMs);

    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      reject(error);
    }

    socket.once('error', fail);
    socket.once('timeout', () => fail(new Error('DCC socket timeout.')));
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      socket.write([
        'GET /ws/dcc-capture HTTP/1.1',
        `Host: 127.0.0.1:${config.port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '\r\n',
      ].join('\r\n'));
    });

    socket.on('data', (chunk) => {
      if (parserReady) return;
      handshake = Buffer.concat([handshake, chunk]);
      const headerEnd = handshake.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = handshake.subarray(0, headerEnd).toString('utf8');
      if (!/^HTTP\/1\.1 101/i.test(header)) return fail(new Error('DCC websocket handshake failed.'));
      settled = true;
      parserReady = true;
      clearTimeout(timeout);
      socket.setTimeout(0);
      socket.removeAllListeners('error');
      const rest = handshake.subarray(headerEnd + 4);
      resolve({ socket, rest });
    });
  });
}

class DccMockSession {
  constructor(socket, engine) {
    this.socket = socket;
    this.engine = engine;
    this.config = engineConfig(engine);
    this.width = 1280;
    this.height = 720;
    this.fps = 15;
    this.frameIndex = 1;
    this.selectedCamera = DCC_CAMERA_SETS[engine][0];
    this.previewTimer = null;
    this.recording = false;
  }

  close() {
    if (this.previewTimer) clearInterval(this.previewTimer);
    this.previewTimer = null;
    if (DCC_RECORDING_LOCK.engine === this.engine) DCC_RECORDING_LOCK.engine = null;
  }

  send(payload) {
    sendWs(this.socket, payload);
  }

  cameras() {
    return DCC_CAMERA_SETS[this.engine].map((name) => ({ name, label: name, active: name === this.selectedCamera, engine: this.engine }));
  }

  sendCameraList() {
    this.send({ type: 'camera_list', camera_list: this.cameras(), selected_camera: this.selectedCamera });
  }

  sendTimeline() {
    this.send({ type: 'animation_range', start_frame: 1, end_frame: this.engine === 'unreal' ? 144 : 120, current_frame: this.frameIndex, fps: this.engine === 'unreal' ? 30 : 24 });
  }

  sendFrame() {
    const url = dccFrameDataUrl({
      engine: this.engine,
      cameraName: this.selectedCamera,
      width: this.width,
      height: this.height,
      frameIndex: this.frameIndex++,
      recording: this.recording,
    });
    this.send({
      type: 'frame',
      url,
      width: this.width,
      height: this.height,
      camera_name: this.selectedCamera,
      latency_ms: 6,
      mock: true,
      source: 'mock',
    });
  }

  startPreview(payload = {}) {
    this.width = Number(payload.w || payload.width || this.width);
    this.height = Number(payload.h || payload.height || this.height);
    this.fps = Math.min(30, Math.max(8, Number(payload.fps || this.fps)));
    if (payload.camera_name) this.selectedCamera = String(payload.camera_name);
    if (this.previewTimer) clearInterval(this.previewTimer);
    this.sendFrame();
    this.previewTimer = setInterval(() => this.sendFrame(), Math.round(1000 / this.fps));
  }

  capture(payload = {}) {
    const width = Number(payload.w || payload.width || this.width);
    const height = Number(payload.h || payload.height || this.height);
    const cameraName = String(payload.camera_name || this.selectedCamera);
    const url = dccFrameDataUrl({ engine: this.engine, cameraName, width, height, frameIndex: this.frameIndex++, recording: false });
    this.send({
      type: 'capture_done',
      url,
      width,
      height,
      camera_name: cameraName,
      size_bytes: Buffer.byteLength(url),
      mock: true,
      source: 'mock',
    });
  }

  startRecording(payload = {}) {
    if (DCC_RECORDING_LOCK.engine && DCC_RECORDING_LOCK.engine !== this.engine) {
      this.send({ type: 'error', message: `${engineConfig(DCC_RECORDING_LOCK.engine).label} is already recording. Stop that session before starting ${this.config.label}.` });
      return;
    }
    DCC_RECORDING_LOCK.engine = this.engine;
    this.recording = true;
    this.width = Number(payload.w || payload.width || this.width);
    this.height = Number(payload.h || payload.height || this.height);
    if (payload.camera_name) this.selectedCamera = String(payload.camera_name);
    this.startPreview({ ...payload, fps: payload.fps || this.fps });
    this.send({ type: 'recording_started', camera_name: this.selectedCamera, start_frame: payload.start_frame, end_frame: payload.end_frame, fps: payload.fps, mock: true });
  }

  stopRecording() {
    this.recording = false;
    if (DCC_RECORDING_LOCK.engine === this.engine) DCC_RECORDING_LOCK.engine = null;
    this.send({ type: 'recording_stopped', camera_name: this.selectedCamera, mock: true });
  }

  handle(payload) {
    const type = String(payload.type || '');
    if (payload.engine) {
      this.engine = payload.engine === 'unreal' ? 'unreal' : 'blender';
      this.config = engineConfig(this.engine);
      if (!DCC_CAMERA_SETS[this.engine].includes(this.selectedCamera)) this.selectedCamera = DCC_CAMERA_SETS[this.engine][0];
    }
    if (type === 'connect') {
      this.send({ type: 'connected', engine: this.engine, mode: 'mock', message: `${this.config.label} mock session is active. Install or connect ${this.config.pluginName} to enable real-time capture.` });
      this.sendCameraList();
      this.sendTimeline();
      return;
    }
    if (type === 'query_camera') return this.sendCameraList();
    if (type === 'query_animation_range') return this.sendTimeline();
    if (type === 'set_camera') {
      if (payload.camera_name) this.selectedCamera = String(payload.camera_name);
      this.sendCameraList();
      this.sendTimeline();
      this.sendFrame();
      return;
    }
    if (type === 'start_preview') return this.startPreview(payload);
    if (type === 'stop_preview') {
      if (this.previewTimer) clearInterval(this.previewTimer);
      this.previewTimer = null;
      return;
    }
    if (type === 'capture_by_camera') return this.capture(payload);
    if (type === 'start_recording') return this.startRecording(payload);
    if (type === 'stop_recording') return this.stopRecording();
  }
}

function normalizeUnrealDirectFromPlugin(payload) {
  const type = String(payload.type || '');
  if (type === 'hello') {
    return {
      type: 'connected',
      engine: 'unreal',
      mode: 'real',
      message: 'HMDao Unreal Capture connected to Unreal Editor.',
      plugin: payload.plugin || 'HMDao Unreal Capture',
      pluginVersion: payload.pluginVersion || payload.plugin_version || '',
      previewProvider: 'editor-direct',
    };
  }
  if (type === 'state') {
    return {
      ...payload,
      type: 'connected',
      engine: 'unreal',
      mode: 'real',
      message: payload.message || 'Unreal Editor connected.',
    };
  }
  if (type === 'preview_frame') {
    return {
      type: 'frame',
      url: payload.url || (payload.payload ? `data:${payload.mimeType || payload.mime_type || 'image/jpeg'};base64,${payload.payload}` : ''),
      width: Number(payload.width || 1280),
      height: Number(payload.height || 720),
      camera_name: payload.cameraName || payload.camera_name || payload.selectedCameraName || 'Unreal Camera',
      latency_ms: Number(payload.latencyMs || payload.latency_ms || 0),
      source: 'editor-direct',
      mock: false,
    };
  }
  if (type === 'capture_done' && payload.asset && typeof payload.asset === 'object') {
  const asset = payload.asset;
  const filePath = asset.filePath || asset.file_path || '';
  const mimeType = asset.mimeType || asset.mime_type || 'image/png';
  const thumbnailFilePath = asset.thumbnailFilePath || asset.thumbnail_file_path || '';
  const thumbnailMimeType = asset.thumbnailMimeType || asset.thumbnail_mime_type || 'image/jpeg';
  const assetUrl = asset.url
    || (asset.payload ? `data:${mimeType};base64,${asset.payload}` : '')
    || (filePath ? registerDccLocalArtifactUrl(filePath, mimeType) : '');
  const thumbnailUrl = asset.thumbnailUrl
    || asset.thumbnail_url
    || (asset.thumbnailPayload ? `data:${thumbnailMimeType};base64,${asset.thumbnailPayload}` : '')
    || (thumbnailFilePath ? registerDccLocalArtifactUrl(thumbnailFilePath, thumbnailMimeType) : '');
  return {
    type: 'capture_done',
    url: assetUrl,
    width: Number(asset.width || payload.width || 1920),
    height: Number(asset.height || payload.height || 1080),
    camera_name: asset.cameraName || asset.camera_name || payload.cameraName || 'Unreal Camera',
    size_bytes: Number(asset.sizeBytes || asset.size_bytes || 0),
    file_path: filePath,
    mime_type: mimeType,
    managed_url: Boolean(asset.managedUrl || asset.managed_url || assetUrl.startsWith('/api/')),
    thumbnail_url: thumbnailUrl || assetUrl,
    thumbnail_file_path: thumbnailFilePath,
    source: 'editor-direct',
    mock: false,
  };
}
  if (type === 'recording_done' && payload.asset && typeof payload.asset === 'object') {
  const asset = payload.asset;
  const filePath = asset.filePath || asset.file_path || '';
  const mimeType = asset.mimeType || asset.mime_type || 'video/webm';
  const thumbnailFilePath = asset.thumbnailFilePath || asset.thumbnail_file_path || '';
  const thumbnailMimeType = asset.thumbnailMimeType || asset.thumbnail_mime_type || 'image/jpeg';
  const assetUrl = asset.url
    || (asset.payload ? `data:${mimeType};base64,${asset.payload}` : '')
    || (filePath ? registerDccLocalArtifactUrl(filePath, mimeType) : '');
  const thumbnailUrl = asset.thumbnailUrl
    || asset.thumbnail_url
    || (asset.thumbnailPayload ? `data:${thumbnailMimeType};base64,${asset.thumbnailPayload}` : '')
    || (thumbnailFilePath ? registerDccLocalArtifactUrl(thumbnailFilePath, thumbnailMimeType) : '');
  return {
    type: 'recording_done',
    url: assetUrl,
    width: Number(asset.width || payload.width || 1920),
    height: Number(asset.height || payload.height || 1080),
    camera_name: asset.cameraName || asset.camera_name || payload.cameraName || 'Unreal Camera',
    size_bytes: Number(asset.sizeBytes || asset.size_bytes || 0),
    file_path: filePath,
    mime_type: mimeType,
    managed_url: Boolean(asset.managedUrl || asset.managed_url || assetUrl.startsWith('/api/')),
    duration_ms: Number(asset.durationMs || asset.duration_ms || payload.durationMs || payload.duration_ms || 0),
    thumbnail_url: thumbnailUrl,
    thumbnail_file_path: thumbnailFilePath,
    source: 'editor-direct',
    mock: false,
  };
}
  return payload;
}

function normalizeUnrealCommandForPlugin(payload) {
  const type = String(payload.type || '');
  if (type === 'connect') return { type: 'query_state', engine: 'unreal' };
  if (type === 'query_camera') return { type: 'query_cameras' };
  if (type === 'query_animation_range') return { type: 'query_timeline', cameraName: payload.camera_name || payload.cameraName || '' };
  if (type === 'set_camera') return { type: 'set_camera', cameraName: payload.camera_name || payload.cameraName || '', cameraId: payload.camera_id || payload.cameraId || '' };
  if (type === 'start_preview') {
    return {
      type: 'start_preview',
      cameraName: payload.camera_name || payload.cameraName || '',
      width: Number(payload.w || payload.width || 1280),
      height: Number(payload.h || payload.height || 720),
      fps: Number(payload.fps || 30),
      quality: Number(payload.quality || 82),
      format: payload.format || 'jpeg',
    };
  }
  if (type === 'capture_by_camera') {
    return {
      type: 'capture',
      requestId: `cap-${Date.now()}`,
      cameraName: payload.camera_name || payload.cameraName || '',
      width: Number(payload.w || payload.width || 1920),
      height: Number(payload.h || payload.height || 1080),
      format: payload.format || 'png',
      quality: Number(payload.quality || 95),
    };
  }
  if (type === 'start_recording') {
    // The Unreal plugin's playback-driven recording path (HMDaoUnrealCaptureModule.cpp)
    // reads the recording resolution from `captureWidth`/`captureHeight` (fallback
    // `recordWidth`/`recordHeight`), NOT from `width`/`height` (those only drive the
    // live preview). If we only forward width/height, the user's panel resolution is
    // silently ignored and every recording renders at the 1920x1080 default. Mirror
    // the chosen resolution into the captureWidth/Height + recordWidth/Height fields so
    // the recording output actually matches the DCC panel selection.
    const recordWidth = Number(payload.w || payload.width || 1920);
    const recordHeight = Number(payload.h || payload.height || 1080);
    return {
      type: 'start_recording',
      requestId: `rec-${Date.now()}`,
      cameraName: payload.camera_name || payload.cameraName || '',
      startFrame: Number((payload.start_frame ?? payload.startFrame) ?? 1),
      endFrame: Number((payload.end_frame ?? payload.endFrame) ?? 120),
      fps: Number(payload.fps || 24),
      width: recordWidth,
      height: recordHeight,
      captureWidth: recordWidth,
      captureHeight: recordHeight,
      recordWidth,
      recordHeight,
      format: payload.format || 'webm',
    };
  }
  if (type === 'stop_recording') return { type: 'stop_recording', cameraName: payload.camera_name || payload.cameraName || '' };
  return payload;
}

function sendUnrealDirectToBrowsers(payload) {
  const message = normalizeUnrealDirectFromPlugin(payload);
  if (message.type === 'camera_list') UNREAL_DIRECT_BRIDGE.lastCameraList = message;
  if (message.type === 'animation_range' || message.type === 'timeline' || message.type === 'scene_info') UNREAL_DIRECT_BRIDGE.lastTimeline = message;
  for (const browser of UNREAL_DIRECT_BRIDGE.browsers.values()) {
    if (!browser.socket.destroyed) sendWs(browser.socket, message);
  }
}

function handleUnrealPluginUpgrade(req, socket, head) {
  if (UNREAL_DIRECT_BRIDGE.pluginSocket && !UNREAL_DIRECT_BRIDGE.pluginSocket.destroyed) {
    logUnrealBridgeEvent('plugin-session-replaced', {
      previousPlugin: UNREAL_DIRECT_BRIDGE.pluginInfo?.plugin || 'unknown',
      browserCount: UNREAL_DIRECT_BRIDGE.browsers.size,
    });
    sendWs(UNREAL_DIRECT_BRIDGE.pluginSocket, { type: 'error', message: 'A newer HMDao Unreal Capture plugin session has connected.' });
    UNREAL_DIRECT_BRIDGE.pluginSocket.destroy();
  }
  UNREAL_DIRECT_BRIDGE.pluginSocket = socket;
  UNREAL_DIRECT_BRIDGE.pluginInfo = { connectedAt: Date.now() };
  UNREAL_DIRECT_BRIDGE.lastCameraList = null;
  UNREAL_DIRECT_BRIDGE.lastTimeline = null;
  logUnrealBridgeEvent('plugin-connected', {
    browserCount: UNREAL_DIRECT_BRIDGE.browsers.size,
  });
  sendUnrealDirectToBrowsers({ type: 'connected', engine: 'unreal', mode: 'real', message: 'HMDao Unreal Capture connected.' });
  let helloAckSent = false;
  const sendHelloAck = () => {
    if (helloAckSent || socket.destroyed) return;
    helloAckSent = true;
    sendWs(socket, {
      type: 'hello_ack',
      sessionId: `dcc-unreal-${Date.now()}`,
      accepted: true,
      heartbeatIntervalMs: 5000,
      uploadBaseUrl: `${getRequestOrigin(req)}/api/dcc/assets/upload`,
    });
  };

  const parser = createFrameParser((text) => {
    let payload;
    try { payload = JSON.parse(text); } catch { return; }
    if (payload.type === 'ping') {
      sendHelloAck();
      sendWs(socket, {
        type: 'pong',
        ts: Number(payload.ts || Date.now()),
        serverTs: Date.now(),
      });
      return;
    }
    if (payload.type === 'hello') {
      sendHelloAck();
      UNREAL_DIRECT_BRIDGE.pluginInfo = { ...UNREAL_DIRECT_BRIDGE.pluginInfo, ...payload, connectedAt: UNREAL_DIRECT_BRIDGE.pluginInfo?.connectedAt || Date.now() };
      logUnrealBridgeEvent('plugin-hello', {
        plugin: payload.plugin || 'unknown',
        pluginVersion: payload.pluginVersion || '',
        previewProvider: payload.previewProvider || '',
      });
    }
    if (payload.type !== 'pong' && payload.type !== 'hello_ack') {
      sendWs(socket, {
        type: 'pong',
        ts: Number(payload.ts || Date.now()),
        serverTs: Date.now(),
      });
    }
    sendUnrealDirectToBrowsers(payload);
  }, () => socket.destroy(), (payload) => {
    if (!socket.destroyed) socket.write(encodeWsFrame(payload, { opcode: 0xA }));
  });

  socket.on('data', parser);
  socket.on('close', () => {
    if (UNREAL_DIRECT_BRIDGE.pluginSocket === socket) {
      UNREAL_DIRECT_BRIDGE.pluginSocket = null;
      UNREAL_DIRECT_BRIDGE.pluginInfo = null;
      UNREAL_DIRECT_BRIDGE.lastCameraList = null;
      UNREAL_DIRECT_BRIDGE.lastTimeline = null;
      sendUnrealDirectToBrowsers({ type: 'error', message: 'HMDao Unreal Capture disconnected.' });
    }
    logUnrealBridgeEvent('plugin-disconnected', {
      browserCount: UNREAL_DIRECT_BRIDGE.browsers.size,
    });
  });
  socket.on('error', (error) => {
    logUnrealBridgeEvent('plugin-socket-error', {
      message: error instanceof Error ? error.message : String(error || ''),
    });
    socket.destroy();
  });
  if (head?.length) parser(head);
}

function handleUnrealBrowserUpgrade(socket, head) {
  const browserId = crypto.randomUUID();
  const mockSession = new DccMockSession(socket, 'unreal');
  const browserSession = {
    socket,
    mockSession,
    requireReal: false,
    sawReal: false,
  };
  UNREAL_DIRECT_BRIDGE.browsers.set(browserId, browserSession);

  const rejectMockFallback = (message) => {
    sendWs(socket, {
      type: browserSession.sawReal ? 'error' : 'connect_error',
      message,
    });
  };

  const parser = createFrameParser((text) => {
    let payload;
    try { payload = JSON.parse(text); } catch {
      sendWs(socket, { type: 'error', message: 'Unreal direct bridge received an invalid message.' });
      return;
    }
    if (String(payload.type || '') === 'connect') {
      browserSession.requireReal = payload.require_real === true || payload.allow_mock === false || browserSession.requireReal;
    }
    const plugin = UNREAL_DIRECT_BRIDGE.pluginSocket;
    if (plugin && !plugin.destroyed) {
      browserSession.sawReal = true;
      if (String(payload.type || '') === 'connect') {
        sendWs(socket, { type: 'connected', engine: 'unreal', mode: 'real', message: 'HMDao Unreal Capture is online.' });
        if (UNREAL_DIRECT_BRIDGE.lastCameraList) sendWs(socket, UNREAL_DIRECT_BRIDGE.lastCameraList);
        if (UNREAL_DIRECT_BRIDGE.lastTimeline) sendWs(socket, UNREAL_DIRECT_BRIDGE.lastTimeline);
      }
      plugin.write(encodeWsFrame(JSON.stringify(normalizeUnrealCommandForPlugin(payload))));
      return;
    }
    if (browserSession.requireReal || browserSession.sawReal) {
      rejectMockFallback(browserSession.sawReal
        ? 'HMDao Unreal Capture disconnected.'
        : 'HMDao Unreal Capture is not online. Open Unreal Editor with the HMDao Unreal Capture plugin before connecting.');
      return;
    }
    mockSession.handle(payload);
  }, () => socket.destroy(), (payload) => {
    if (!socket.destroyed) socket.write(encodeWsFrame(payload, { opcode: 0xA }));
  });

  socket.on('data', parser);
  socket.on('close', () => {
    mockSession.close();
    UNREAL_DIRECT_BRIDGE.browsers.delete(browserId);
  });
  socket.on('error', () => {
    mockSession.close();
    UNREAL_DIRECT_BRIDGE.browsers.delete(browserId);
  });
  if (head?.length) parser(head);
}

async function handleDccUpgrade(req, socket, head) {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const directUnreal = url.pathname === '/ws/dcc/unreal';
  if (url.pathname !== '/ws/dcc-capture' && !directUnreal) {
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  const rawProtocols = typeof req.headers['sec-websocket-protocol'] === 'string'
    ? req.headers['sec-websocket-protocol']
    : Array.isArray(req.headers['sec-websocket-protocol'])
      ? req.headers['sec-websocket-protocol'].join(',')
      : '';
  const selectedProtocol = rawProtocols
    .split(',')
    .map((item) => item.trim())
    .find(Boolean) || '';

  if (directUnreal) {
    logUnrealBridgeEvent('upgrade-request', {
      role: String(url.searchParams.get('role') || 'browser').toLowerCase(),
      protocol: selectedProtocol,
      userAgent: req.headers['user-agent'] || '',
    });
  }

  const upgradeResponseHeaders = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${wsAcceptKey(key)}`,
    'Sec-WebSocket-Version: 13',
  ];
  if (selectedProtocol) {
    upgradeResponseHeaders.push(`Sec-WebSocket-Protocol: ${selectedProtocol}`);
  }
  upgradeResponseHeaders.push('\r\n');
  socket.write(upgradeResponseHeaders.join('\r\n'));

  if (directUnreal) {
    const role = String(url.searchParams.get('role') || 'browser').toLowerCase();
    if (role === 'plugin') handleUnrealPluginUpgrade(req, socket, head);
    else handleUnrealBrowserUpgrade(socket, head);
    return;
  }

  let engine = directUnreal ? 'unreal' : url.searchParams.get('engine') === 'unreal' ? 'unreal' : 'blender';
  const allowReal = !directUnreal && process.env.HMDAO_DCC_MOCK_ONLY !== '1';
  const allowMockFallback = process.env.HMDAO_DCC_MOCK_ONLY === '1'
    || engine === 'unreal'
    || process.env.HMDAO_ALLOW_BLENDER_MOCK === '1';
  let mode = allowReal ? 'connecting' : 'mock';
  let mockSession = new DccMockSession(socket, engine);
  let upstream = null;
  const pendingBrowserPayloads = [];

  const browserParser = createFrameParser(async (text) => {
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      sendWs(socket, { type: 'error', message: 'DCC gateway received an invalid message.' });
      return;
    }
    if (payload.engine) engine = payload.engine === 'unreal' ? 'unreal' : 'blender';
    if (mode === 'connecting') {
      pendingBrowserPayloads.push(payload);
      return;
    }
    if (mode === 'real' && upstream?.socket && !upstream.socket.destroyed) {
      upstream.socket.write(encodeWsFrame(JSON.stringify(payload), { masked: true }));
      return;
    }
    mockSession.handle(payload);
  }, () => socket.destroy());

  socket.on('data', browserParser);
  socket.on('close', () => {
    mockSession.close();
    upstream?.socket?.destroy();
  });
  socket.on('error', () => {
    mockSession.close();
    upstream?.socket?.destroy();
  });

  if (head?.length) browserParser(head);

  const config = engineConfig(engine);
  if (allowReal) {
    try {
      upstream = await connectUpstreamWebSocket(config);
      mode = 'real';
      mockSession.close();
      sendWs(socket, { type: 'connected', engine, mode: 'real', message: `${config.pluginName} connected. HMDao DCC is now streaming live ${config.label} data.` });
      const upstreamParser = createFrameParser((message) => {
        if (!socket.destroyed) socket.write(encodeWsFrame(message));
      }, () => {
        if (!socket.destroyed) sendWs(socket, { type: 'error', message: `${config.pluginName} disconnected. Switching browser client back to mock ${config.label} mode.` });
        mode = 'mock';
        mockSession = new DccMockSession(socket, engine);
      });
      upstream.socket.on('data', upstreamParser);
      upstream.socket.on('close', () => {
        mode = 'mock';
        mockSession = new DccMockSession(socket, engine);
      });
      upstream.socket.on('error', () => {
        mode = 'mock';
        mockSession = new DccMockSession(socket, engine);
      });
      if (upstream.rest?.length) upstreamParser(upstream.rest);
      for (const payload of pendingBrowserPayloads.splice(0)) {
        if (upstream?.socket && !upstream.socket.destroyed) {
          upstream.socket.write(encodeWsFrame(JSON.stringify(payload), { masked: true }));
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (allowMockFallback) {
        mode = 'mock';
        sendWs(socket, {
          type: 'connected',
          engine,
          mode: 'mock',
          message: `${config.pluginName} ?? ${config.port} ??? HMDao WebSocket ???${reason}?????????????? ${config.label} ????????`,
        });
        mockSession.sendCameraList();
        mockSession.sendTimeline();
        for (const payload of pendingBrowserPayloads.splice(0)) mockSession.handle(payload);
      } else {
        mode = 'error';
        sendWs(socket, {
          type: 'error',
          engine,
          message: `${config.pluginName} ?????????????????${reason}??? ${config.label} ????????????????`,
        });
      }
    }
  } else {
    sendWs(socket, { type: 'connected', engine, mode: 'mock', message: `${config.label} mock DCC mode is active because no live upstream connection is enabled.` });
    mockSession.sendCameraList();
    mockSession.sendTimeline();
  }
}

async function handleWorkflowUpgrade(req, socket, head) {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  if (url.pathname !== '/ws/workflow') {
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${wsAcceptKey(key)}`,
    '\r\n',
  ].join('\r\n'));

  const socketId = crypto.randomUUID();
  workflowSocketSubscriptions.set(socketId, socket);

  const parser = createFrameParser(async (text) => {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      sendWs(socket, {
        msg_id: nextMessageId(),
        msg_type: 'error',
        payload: { error: 'Workflow WebSocket message is not valid JSON.' },
        ts: Date.now(),
      });
      return;
    }

    const msgType = String(message.msg_type || '');
    const requestId = String(message.msg_id || nextMessageId());
    const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};

    if (msgType === 'ping') {
      sendWs(socket, { msg_id: requestId, msg_type: 'pong', payload: {}, ts: Date.now() });
      return;
    }

    if (msgType === 'workflow:create') {
      const workflow = payload.workflow;
      if (!workflow || !Array.isArray(workflow.nodes) || workflow.nodes.length === 0) {
        sendWs(socket, {
          msg_id: requestId,
          msg_type: 'error',
          payload: { request_id: requestId, error: 'workflow.nodes cannot be empty.' },
          ts: Date.now(),
        });
        return;
      }

      const workflowId = nextWorkflowId();
      const run = {
        workflowId,
        requestId,
        name: String(workflow.name || workflowId),
        nodes: workflow.nodes.map((node) => ({
          node_id: String(node.node_id || crypto.randomUUID()),
          nodeType: node.nodeType,
          provider: String(node.provider || ''),
          model: String(node.model || ''),
          prompt: String(node.prompt || ''),
          endpoint: String(node.endpoint || ''),
          body: node.body && typeof node.body === 'object' ? node.body : {},
          apiKey: typeof node.apiKey === 'string' ? node.apiKey : '',
          timeout: Number(node.timeout || 90_000),
          depends_on: Array.isArray(node.depends_on) ? node.depends_on.map((item) => String(item)) : [],
          metadata: node.metadata && typeof node.metadata === 'object' ? node.metadata : {},
        })),
        status: 'accepted',
        error: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        nodeResults: new Map(),
        subscribers: new Set([socket]),
      };

      workflowRuns.set(workflowId, run);
      sendWs(socket, {
        msg_id: requestId,
        msg_type: 'workflow:accepted',
        payload: workflowStatusSnapshot(run),
        ts: Date.now(),
      });
      void executeWorkflowRun(run);
      return;
    }

    if (msgType === 'status:query') {
      const workflowId = String(payload.workflow_id || '');
      const run = workflowRuns.get(workflowId);
      if (!run) {
        sendWs(socket, {
          msg_id: requestId,
          msg_type: 'error',
          payload: { request_id: requestId, workflow_id: workflowId, error: 'Workflow not found.' },
          ts: Date.now(),
        });
        return;
      }
      if (payload.subscribe !== false) run.subscribers.add(socket);
      sendWs(socket, {
        msg_id: requestId,
        msg_type: 'status:result',
        payload: workflowStatusSnapshot(run),
        ts: Date.now(),
      });
      return;
    }

    if (msgType === 'workflow:control') {
      const workflowId = String(payload.workflow_id || '');
      const action = String(payload.action || '');
      const run = workflowRuns.get(workflowId);
      if (!run) {
        sendWs(socket, {
          msg_id: requestId,
          msg_type: 'error',
          payload: { request_id: requestId, workflow_id: workflowId, error: 'Workflow not found.' },
          ts: Date.now(),
        });
        return;
      }
      run.subscribers.add(socket);
      if (action === 'cancel') {
        run.status = 'cancelled';
        run.updatedAt = Date.now();
        publishWorkflowEvent(run, 'workflow:cancelled');
        return;
      }
      sendWs(socket, {
        msg_id: requestId,
        msg_type: 'status:result',
        payload: workflowStatusSnapshot(run),
        ts: Date.now(),
      });
      return;
    }

    sendWs(socket, {
      msg_id: requestId,
      msg_type: 'error',
      payload: { request_id: requestId, error: `Unsupported DCC message type: ${msgType}` },
      ts: Date.now(),
    });
  }, () => {
    workflowSocketSubscriptions.delete(socketId);
    for (const run of workflowRuns.values()) {
      run.subscribers.delete(socket);
    }
    socket.destroy();
  });

  socket.on('data', parser);
  socket.on('close', () => {
    workflowSocketSubscriptions.delete(socketId);
    for (const run of workflowRuns.values()) {
      run.subscribers.delete(socket);
    }
  });
  socket.on('error', () => {
    workflowSocketSubscriptions.delete(socketId);
    for (const run of workflowRuns.values()) {
      run.subscribers.delete(socket);
    }
  });

  if (head?.length) parser(head);
}

async function handleCatalogUpgrade(req, socket, head) {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  if (url.pathname !== '/ws/catalog') {
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${wsAcceptKey(key)}`,
    '\r\n',
  ].join('\r\n'));

  const socketId = crypto.randomUUID();
  catalogSocketSubscriptions.set(socketId, socket);

  const parser = createFrameParser((text) => {
    let message = {};
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    const msgType = String(message.msg_type || '');
    const requestId = String(message.msg_id || nextMessageId());
    if (msgType === 'ping') {
      sendWs(socket, { msg_id: requestId, msg_type: 'pong', payload: {}, ts: Date.now() });
      return;
    }
    if (msgType === 'catalog:subscribe') {
      sendWs(socket, {
        msg_id: requestId,
        msg_type: 'catalog:updated',
        payload: {
          reason: 'initial-sync',
          updated_at: Date.now(),
          models: modelCatalogPayload(),
        },
        ts: Date.now(),
      });
    }
  }, () => {
    catalogSocketSubscriptions.delete(socketId);
    socket.destroy();
  });

  socket.on('data', parser);
  socket.on('close', () => catalogSocketSubscriptions.delete(socketId));
  socket.on('error', () => catalogSocketSubscriptions.delete(socketId));
  if (head?.length) parser(head);
}

function send(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  const origin = res._hmdaoOrigin || '';
  const corsHeaders = origin
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Credentials': 'true',
      }
    : {
        'Access-Control-Allow-Origin': '*',
      };
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...corsHeaders,
    'Access-Control-Allow-Headers': 'content-type, authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Expose-Headers': 'Content-Type, X-HMDAO-Media-Error, X-HMDAO-Media-Provider',
    ...headers,
  });
  res.end(body);
}

function sendRaw(res, status, body, headers = {}) {
  const origin = res._hmdaoOrigin || '';
  const corsHeaders = origin
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Credentials': 'true',
      }
    : {
        'Access-Control-Allow-Origin': '*',
      };
  res.writeHead(status, {
    ...corsHeaders,
    'Access-Control-Allow-Headers': 'content-type, authorization, range',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified, X-HMDAO-Media-Error, X-HMDAO-Media-Provider',
    ...headers,
  });
  res.end(body);
}

function mediaMimeTypeFromExtension(filePath, fallback = 'application/octet-stream') {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.avif') return 'image/avif';
  if (ext === '.heic') return 'image/heic';
  if (ext === '.heif') return 'image/heif';
  if (ext === '.tif' || ext === '.tiff') return 'image/tiff';
  if (ext === '.hdr') return 'image/vnd.radiance';
  if (ext === '.exr') return 'image/x-exr';
  if (ext === '.dng') return 'image/x-adobe-dng';
  if (ext === '.jxl') return 'image/jxl';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.m4v') return 'video/x-m4v';
  if (ext === '.mkv') return 'video/x-matroska';
  if (ext === '.avi') return 'video/x-msvideo';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.ogg') return 'audio/ogg';
  if (ext === '.flac') return 'audio/flac';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.aac') return 'audio/aac';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.csv') return 'text/csv; charset=utf-8';
  return fallback;
}

function buildSafeInlineContentDisposition(filename = '') {
  const rawName = path.basename(String(filename || '').trim()) || 'file';
  const asciiName = rawName
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]+/g, '_')
    .replace(/["\\;]/g, '_')
    .replace(/\s+/g, ' ')
    .trim() || 'file';
  const encodedName = encodeURIComponent(rawName)
    .replace(/['()]/g, escape)
    .replace(/\*/g, '%2A');
  return `inline; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;
}

async function sendLocalFileStream(req, res, filePath, options = {}) {
  const stat = await fs.stat(filePath);
  const total = Number(stat.size || 0);
  const mimeType = String(options.mimeType || mediaMimeTypeFromExtension(filePath));
  const origin = res._hmdaoOrigin || '';
  const corsHeaders = origin
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Credentials': 'true',
      }
    : {
        'Access-Control-Allow-Origin': '*',
      };
  const baseHeaders = {
    ...corsHeaders,
    'Access-Control-Allow-Headers': 'content-type, authorization, range',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified',
    'Content-Type': mimeType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=86400',
    'Last-Modified': stat.mtime.toUTCString(),
    ...(options.contentDisposition ? { 'Content-Disposition': String(options.contentDisposition) } : {}),
    ...(options.headers && typeof options.headers === 'object' ? options.headers : {}),
  };

  const range = String(req.headers.range || '').trim();
  if (!range) {
    res.writeHead(200, {
      ...baseHeaders,
      'Content-Length': String(total),
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(filePath).pipe(res);
    return;
  }

  const match = /^bytes=(\d*)-(\d*)$/i.exec(range);
  if (!match) {
    res.writeHead(416, {
      ...baseHeaders,
      'Content-Range': `bytes */${total}`,
    });
    res.end();
    return;
  }

  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : total - 1;
  if (!match[1] && match[2]) {
    const suffixLength = Number(match[2]);
    start = Math.max(0, total - suffixLength);
    end = total - 1;
  }
  start = Math.max(0, start);
  end = Math.min(total - 1, end);

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
    res.writeHead(416, {
      ...baseHeaders,
      'Content-Range': `bytes */${total}`,
    });
    res.end();
    return;
  }

  res.writeHead(206, {
    ...baseHeaders,
    'Content-Length': String(end - start + 1),
    'Content-Range': `bytes ${start}-${end}/${total}`,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(filePath, { start, end }).pipe(res);
}

function sanitizeLocalAssetId(value) {
  const assetId = String(value || '').trim();
  if (!assetId || assetId.includes('..') || assetId.includes('/') || assetId.includes('\\')) {
    return '';
  }
  return assetId;
}

async function persistLocalPostResultFile(sourcePath, requestId, mediaKind) {
  await fs.mkdir(LOCAL_POST_RESULT_DIR, { recursive: true });
  const extension = mediaKind === 'video' ? 'webm' : 'png';
  const assetId = `${requestId}.${extension}`;
  const persistedPath = path.join(LOCAL_POST_RESULT_DIR, assetId);
  await fs.rename(sourcePath, persistedPath).catch(async () => {
    await fs.copyFile(sourcePath, persistedPath);
    await fs.rm(sourcePath, { force: true }).catch(() => {});
  });
  return {
    assetId,
    persistedPath,
    outputUrl: `/api/local-post/result/${encodeURIComponent(assetId)}`,
  };
}

async function persistLocalResultFile(resultDir, sourcePath, requestId, extension) {
  await fs.mkdir(resultDir, { recursive: true });
  const normalizedExtension = String(extension || '').replace(/^\.+/, '') || 'bin';
  const assetId = `${requestId}.${normalizedExtension}`;
  const persistedPath = path.join(resultDir, assetId);
  await fs.rename(sourcePath, persistedPath).catch(async () => {
    await fs.copyFile(sourcePath, persistedPath);
    await fs.rm(sourcePath, { force: true }).catch(() => {});
  });
  return {
    assetId,
    persistedPath,
  };
}

async function persistLocalBufferResult(resultDir, sourceOrBuffer, requestId, extension) {
  await fs.mkdir(resultDir, { recursive: true });
  const normalizedExtension = String(extension || '').replace(/^\.+/, '') || 'bin';
  const assetId = `${requestId}.${normalizedExtension}`;
  const persistedPath = path.join(resultDir, assetId);
  if (Buffer.isBuffer(sourceOrBuffer)) {
    await fs.writeFile(persistedPath, sourceOrBuffer);
  } else {
    await fs.rename(sourceOrBuffer, persistedPath).catch(async () => {
      await fs.copyFile(sourceOrBuffer, persistedPath);
      await fs.rm(sourceOrBuffer, { force: true }).catch(() => {});
    });
  }
  return {
    assetId,
    persistedPath,
  };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function sanitizeMultipartFieldName(value = 'field') {
  return String(value || 'field')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '') || 'field';
}

async function readLocalPostMultipart(req) {
  await fs.mkdir(LOCAL_POST_EDIT_DIR, { recursive: true });
  const uploadId = crypto.randomUUID();
  const createdPaths = [];
  const fieldValues = new Map();
  const uploadedFiles = new Map();

  const busboy = Busboy({
    headers: req.headers,
    limits: {
      files: 24,
      fields: 128,
      fileSize: Number(process.env.HMDAO_LOCAL_POST_MAX_BYTES || 1024 * 1024 * 1024),
    },
  });

  try {
    await new Promise((resolve, reject) => {
      const pendingWrites = [];
      let aborted = false;

      busboy.on('field', (name, value) => {
        fieldValues.set(String(name), String(value));
      });

      busboy.on('file', (name, file, info = {}) => {
        const fieldName = String(name || '').trim();
        if (!fieldName) {
          file.resume();
          return;
        }
        const ext = extensionFromMimeType(info.mimeType || 'application/octet-stream');
        const safeFieldName = sanitizeMultipartFieldName(fieldName);
        const filePath = path.join(LOCAL_POST_EDIT_DIR, `${uploadId}-${safeFieldName}.${ext}`);
        createdPaths.push(filePath);
        const writePromise = pipeline(file, createWriteStream(filePath))
          .then(() => {
            uploadedFiles.set(fieldName, {
              fieldName,
              filePath,
              filename: String(info.filename || ''),
              mimeType: String(info.mimeType || 'application/octet-stream'),
            });
          });
        pendingWrites.push(writePromise);
      });

      busboy.once('error', reject);
      busboy.once('partsLimit', () => reject(new Error('local-post-multipart-too-many-parts')));
      busboy.once('filesLimit', () => reject(new Error('local-post-multipart-too-many-files')));
      busboy.once('fieldsLimit', () => reject(new Error('local-post-multipart-too-many-fields')));
      busboy.once('finish', async () => {
        if (aborted) return;
        try {
          await Promise.all(pendingWrites);
          resolve();
        } catch (error) {
          reject(error);
        }
      });

      req.once('aborted', () => {
        aborted = true;
        reject(new Error('local-post-multipart-aborted'));
      });

      req.pipe(busboy);
    });

    const manifestText = fieldValues.get('manifest');
    if (!manifestText) {
      throw new Error('local-post-manifest-missing');
    }
    const manifest = JSON.parse(manifestText);
    const sourceField = String(manifest?.sourceField || 'source');
    const sourceFile = uploadedFiles.get(sourceField);

    return {
      mediaKind: manifest?.mediaKind === 'video' ? 'video' : 'image',
      inputMimeType: sourceFile?.mimeType || manifest?.inputMimeType || '',
      inputPath: sourceFile?.filePath || '',
      sourceUrl: String(manifest?.sourceUrl || '').trim(),
      effects: manifest?.effects && typeof manifest.effects === 'object' ? manifest.effects : {},
      assets: Array.isArray(manifest?.assets)
        ? manifest.assets.map((asset) => {
            const fieldName = String(asset?.fieldName || '');
            const uploaded = fieldName ? uploadedFiles.get(fieldName) : null;
            return {
              key: String(asset?.key || ''),
              kind: asset?.kind === 'video' ? 'video' : 'image',
              sourceUrl: String(asset?.sourceUrl || '').trim(),
              inputMimeType: uploaded?.mimeType || asset?.inputMimeType || '',
              uploadedPath: uploaded?.filePath || '',
              originalName: String(asset?.originalName || '').trim(),
            };
          })
        : [],
    };
  } catch (error) {
    await Promise.all(createdPaths.map((filePath) => fs.rm(filePath, { force: true }).catch(() => {})));
    throw error;
  }
}

function imageExtensionFromMimeType(mimeType = 'image/jpeg') {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.includes('png')) return 'png';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('gif')) return 'gif';
  if (normalized.includes('bmp')) return 'bmp';
  if (normalized.includes('svg')) return 'svg';
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg';
  return 'jpg';
}

function parseStringArrayField(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item || '').trim()).filter(Boolean);
    }
  } catch {
    // ignore json parse failure
  }
  return trimmed.split(',').map((item) => item.trim()).filter(Boolean);
}

async function readLocalImageAnalyzeMultipart(req) {
  await fs.mkdir(LOCAL_IMAGE_ANALYSIS_DIR, { recursive: true });
  const uploadId = crypto.randomUUID();
  const fieldValues = new Map();
  let uploadedFile = null;
  const createdPaths = [];
  const busboy = Busboy({
    headers: req.headers,
    limits: {
      files: 1,
      fields: 32,
      fileSize: Number(process.env.HMDAO_LOCAL_IMAGE_ANALYSIS_MAX_BYTES || 128 * 1024 * 1024),
    },
  });

  try {
    await new Promise((resolve, reject) => {
      const pendingWrites = [];
      let aborted = false;

      busboy.on('field', (name, value) => {
        fieldValues.set(String(name), String(value));
      });

      busboy.on('file', (name, file, info = {}) => {
        if (String(name || '').trim() !== 'file') {
          file.resume();
          return;
        }
        const ext = imageExtensionFromMimeType(info.mimeType || 'image/jpeg');
        const filePath = path.join(LOCAL_IMAGE_ANALYSIS_DIR, `${uploadId}-source.${ext}`);
        createdPaths.push(filePath);
        const writePromise = pipeline(file, createWriteStream(filePath)).then(() => {
          uploadedFile = {
            filePath,
            filename: String(info.filename || ''),
            mimeType: String(info.mimeType || 'image/jpeg'),
          };
        });
        pendingWrites.push(writePromise);
      });

      busboy.once('error', reject);
      busboy.once('partsLimit', () => reject(new Error('local-image-analysis-too-many-parts')));
      busboy.once('filesLimit', () => reject(new Error('local-image-analysis-too-many-files')));
      busboy.once('fieldsLimit', () => reject(new Error('local-image-analysis-too-many-fields')));
      busboy.once('finish', async () => {
        if (aborted) return;
        try {
          await Promise.all(pendingWrites);
          resolve();
        } catch (error) {
          reject(error);
        }
      });

      req.once('aborted', () => {
        aborted = true;
        reject(new Error('local-image-analysis-aborted'));
      });

      req.pipe(busboy);
    });

    return {
      itemId: String(fieldValues.get('itemId') || '').trim(),
      name: String(fieldValues.get('name') || uploadedFile?.filename || '').trim(),
      width: Number(fieldValues.get('width') || 0) || 0,
      height: Number(fieldValues.get('height') || 0) || 0,
      sourceUrl: String(fieldValues.get('sourceUrl') || '').trim(),
      engine: String(fieldValues.get('engine') || 'auto').trim() || 'auto',
      provider: String(fieldValues.get('provider') || '').trim(),
      model: String(fieldValues.get('model') || '').trim(),
      tags: parseStringArrayField(fieldValues.get('tags')),
      smartCategories: parseStringArrayField(fieldValues.get('smartCategories')),
      inputPath: uploadedFile?.filePath || '',
      inputMimeType: uploadedFile?.mimeType || 'image/jpeg',
      cleanupPaths: createdPaths,
    };
  } catch (error) {
    await Promise.all(createdPaths.map((filePath) => fs.rm(filePath, { force: true }).catch(() => {})));
    throw error;
  }
}

async function readAssetLibraryImportMultipart(req) {
  await fs.mkdir(ASSET_LIBRARY_TEMP_DIR, { recursive: true });
  const uploadId = crypto.randomUUID();
  const fieldValues = new Map();
  let uploadedFile = null;
  const createdPaths = [];
  const busboy = Busboy({
    headers: req.headers,
    limits: {
      files: 1,
      fields: 48,
      fileSize: Number(process.env.HMDAO_ASSET_IMPORT_MAX_BYTES || 2 * 1024 * 1024 * 1024),
    },
  });

  try {
    await new Promise((resolve, reject) => {
      const pendingWrites = [];
      let aborted = false;

      busboy.on('field', (name, value) => {
        fieldValues.set(String(name), String(value));
      });

      busboy.on('file', (name, file, info = {}) => {
        if (String(name || '').trim() !== 'file') {
          file.resume();
          return;
        }
        const ext = extensionFromMimeType(info.mimeType || 'application/octet-stream');
        const filePath = path.join(ASSET_LIBRARY_TEMP_DIR, `${uploadId}-source.${ext}`);
        createdPaths.push(filePath);
        const writePromise = pipeline(file, createWriteStream(filePath)).then(() => {
          uploadedFile = {
            filePath,
            filename: String(info.filename || ''),
            mimeType: String(info.mimeType || 'application/octet-stream'),
          };
        });
        pendingWrites.push(writePromise);
      });

      busboy.once('error', reject);
      busboy.once('partsLimit', () => reject(new Error('asset-import-too-many-parts')));
      busboy.once('filesLimit', () => reject(new Error('asset-import-too-many-files')));
      busboy.once('fieldsLimit', () => reject(new Error('asset-import-too-many-fields')));
      busboy.once('finish', async () => {
        if (aborted) return;
        try {
          await Promise.all(pendingWrites);
          resolve();
        } catch (error) {
          reject(error);
        }
      });

      req.once('aborted', () => {
        aborted = true;
        reject(new Error('asset-import-aborted'));
      });

      req.pipe(busboy);
    });

    return {
      name: String(fieldValues.get('name') || uploadedFile?.filename || '').trim(),
      folderId: String(fieldValues.get('folderId') || 'root').trim() || 'root',
      type: String(fieldValues.get('type') || '').trim(),
      tags: parseStringArrayField(fieldValues.get('tags')),
      smartCategories: parseStringArrayField(fieldValues.get('smartCategories')),
      width: Number(fieldValues.get('width') || 0) || 0,
      height: Number(fieldValues.get('height') || 0) || 0,
      duration: Number(fieldValues.get('duration') || 0) || 0,
      sourceUrl: String(fieldValues.get('sourceUrl') || uploadedFile?.filename || '').trim(),
      inputPath: uploadedFile?.filePath || '',
      inputMimeType: uploadedFile?.mimeType || 'application/octet-stream',
      originalName: String(uploadedFile?.filename || '').trim(),
      cleanupPaths: createdPaths,
    };
  } catch (error) {
    await Promise.all(createdPaths.map((filePath) => fs.rm(filePath, { force: true }).catch(() => {})));
    throw error;
  }
}

async function processAssetLibraryImportRequest(body = {}) {
  const settings = await readAssetLibrarySettings();
  const storagePath = path.resolve(String(settings.storagePath || DEFAULT_ASSET_LIBRARY_STORAGE_DIR));
  const assetId = crypto.randomUUID();
  const sourceUrl = String(body.sourceUrl || '').trim();
  const inputPath = String(body.inputPath || '').trim();
  const explicitType = String(body.type || '').trim();
  const copySourceFile = Boolean(body.copySourceFile);
  const referenceSourceFile = Boolean(body.referenceSourceFile) && Boolean(inputPath);
  let sourceMimeType = String(body.inputMimeType || '').trim();
  let tempPath = inputPath;

  if (!tempPath && sourceUrl) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), Number(process.env.HMDAO_ASSET_IMPORT_TIMEOUT_MS || 120000));
    try {
      const response = await fetch(sourceUrl, {
        signal: controller.signal,
        headers: {
          Accept: '*/*',
          'User-Agent': 'DDUp Asset Import',
        },
      });
      if (!response.ok) {
        throw new Error(`asset-import-fetch-failed:${response.status}`);
      }
      sourceMimeType = sourceMimeType || String(response.headers.get('content-type') || '').trim();
      const ext = extensionFromMimeType(sourceMimeType || sourceUrl || 'application/octet-stream');
      tempPath = path.join(ASSET_LIBRARY_TEMP_DIR, `${assetId}-remote.${ext}`);
      await fs.mkdir(ASSET_LIBRARY_TEMP_DIR, { recursive: true });
      const buffer = Buffer.from(await response.arrayBuffer());
      await fs.writeFile(tempPath, buffer);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  if (!tempPath) {
    throw new Error('asset-import-source-missing');
  }

  const type = ['image', 'video', 'audio', 'text'].includes(explicitType)
    ? explicitType
    : inferAssetTypeFromMime(sourceMimeType, inferAssetTypeFromPath(tempPath, 'image'));
  const rawName = String(body.name || body.originalName || sourceUrl || path.basename(tempPath)).trim();
  const baseName = sanitizeAssetFileBaseName(rawName);
  const ext = path.extname(rawName).replace(/^\.+/, '') || extensionFromMimeType(sourceMimeType || tempPath || 'application/octet-stream');
  const fileName = `${assetId}-${baseName}.${String(ext || 'bin').replace(/^\.+/, '')}`;
  const tempResolvedPath = path.resolve(tempPath);
  const tempStat = await fs.stat(tempResolvedPath);
  const contentHash = await computeAssetContentHash(tempResolvedPath, {
    type,
    duration: Number(body.duration || 0) || 0,
  });
  const existingItems = await readAssetLibraryCatalog();
  const duplicateMatch = referenceSourceFile
    ? (
      existingItems.find((item) => (
        String(item?.storageLabel || '').trim().toLowerCase() === 'reference'
        && String(item?.type || '') === type
        && normalizeAssetDuplicateValue(item?.filePath || '') === normalizeAssetDuplicateValue(tempResolvedPath)
      )) || null
    )
    : findDuplicateAssetLibraryItem(existingItems, {
      type,
      filePath: '',
      sourceUrl: sourceUrl || String(body.originalName || rawName || '').trim(),
      name: rawName || fileName,
      size: Number(tempStat.size || 0),
      width: Number(body.width || 0) || 0,
      height: Number(body.height || 0) || 0,
      duration: Number(body.duration || 0) || 0,
      storageLabel: 'disk',
      source: sourceUrl ? 'crawl' : 'upload',
      contentHash,
    });
  if (duplicateMatch) {
    const mergedDuplicate = mergeDuplicateAssetCandidate(duplicateMatch, {
      folderId: String(body.folderId || duplicateMatch.folderId || 'root'),
      width: Number(body.width || 0) || undefined,
      height: Number(body.height || 0) || undefined,
      duration: Number(body.duration || 0) || undefined,
      sourceUrl: sourceUrl || String(body.originalName || rawName || '').trim(),
      tags: parseStringArrayField(body.tags),
      smartCategories: parseStringArrayField(body.smartCategories),
      prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
      contentHash,
    });
    await upsertAssetLibraryItem(mergedDuplicate);
    if (!referenceSourceFile && tempResolvedPath.startsWith(path.resolve(ASSET_LIBRARY_TEMP_DIR))) {
      await fs.rm(tempResolvedPath, { force: true }).catch(() => {});
    }
    return {
      item: mergedDuplicate,
      storagePath,
      duplicate: true,
    };
  }
  let targetPath = tempResolvedPath;
  if (!referenceSourceFile) {
    await fs.mkdir(storagePath, { recursive: true });
    const targetDir = path.join(storagePath, type);
    await fs.mkdir(targetDir, { recursive: true });
    targetPath = path.join(targetDir, fileName);
    if (copySourceFile) {
      await fs.copyFile(tempPath, targetPath);
    } else {
      await fs.rename(tempPath, targetPath).catch(async () => {
        await fs.copyFile(tempPath, targetPath);
        await fs.rm(tempPath, { force: true }).catch(() => {});
      });
    }
  }
  const stat = await fs.stat(targetPath);

  const item = await upsertAssetLibraryItem({
    id: assetId,
    backendAssetId: assetId,
    name: rawName || fileName,
    type,
    thumbnail: type === 'audio' ? '' : buildAssetLibraryContentUrl(assetId),
    folderId: String(body.folderId || 'root'),
    size: Number(stat.size || 0),
    width: Number(body.width || 0) || undefined,
    height: Number(body.height || 0) || undefined,
    duration: Number(body.duration || 0) || undefined,
    tags: parseStringArrayField(body.tags),
    smartCategories: parseStringArrayField(body.smartCategories),
    sourceUrl: sourceUrl || String(body.originalName || rawName || '').trim(),
    filePath: targetPath,
    persisted: true,
    storageLabel: referenceSourceFile ? 'reference' : 'disk',
    source: referenceSourceFile ? 'upload' : (sourceUrl ? 'crawl' : 'upload'),
    contentHash,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  return {
    item,
    storagePath,
    duplicate: false,
  };
}

function extensionFromMimeType(mimeType = 'video/mp4') {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.includes('.cube') || normalized.includes('cube')) return 'cube';
  if (normalized.includes('.3dl') || normalized.includes('3dl')) return '3dl';
  if (normalized.includes('plain')) return 'txt';
  if (normalized.includes('png')) return 'png';
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('gif')) return 'gif';
  if (normalized.includes('bmp')) return 'bmp';
  if (normalized.includes('svg')) return 'svg';
  if (normalized.includes('avif')) return 'avif';
  if (normalized.includes('heic')) return 'heic';
  if (normalized.includes('heif')) return 'heif';
  if (normalized.includes('tiff') || normalized.includes('tif')) return 'tiff';
  if (normalized.includes('radiance') || normalized.includes('hdr')) return 'hdr';
  if (normalized.includes('exr')) return 'exr';
  if (normalized.includes('adobe-dng') || normalized.includes('dng')) return 'dng';
  if (normalized.includes('jxl')) return 'jxl';
  if (normalized.includes('webm')) return 'webm';
  if (normalized.includes('quicktime')) return 'mov';
  if (normalized.includes('x-m4v') || normalized.includes('m4v')) return 'm4v';
  if (normalized.includes('x-matroska') || normalized.includes('mkv')) return 'mkv';
  if (normalized.includes('avi')) return 'avi';
  if (normalized.includes('mpeg')) return 'mp3';
  if (normalized.includes('wav')) return 'wav';
  if (normalized.includes('flac')) return 'flac';
  if (normalized.includes('audio/mp4') || normalized.includes('m4a')) return 'm4a';
  if (normalized.includes('aac')) return 'aac';
  return 'mp4';
}

async function runCommand(command, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = stderr.trim().split(/\r?\n/).slice(-8).join(' | ');
      reject(new Error(`${command} exited ${code}: ${detail || 'unknown-error'}`));
    });
  });
}

function powershellSingleQuote(value) {
  return "'" + String(value || '').replace(/'/g, "''") + "'";
}

function shouldUsePowerShellRelayFallback(baseUrl = '', error = null) {
  const normalizedBaseUrl = String(baseUrl || '').trim().toLowerCase();
  if (!normalizedBaseUrl.includes('apimart.ai')) return false;
  const errorName = String(error?.name || '').trim().toLowerCase();
  const message = String(error?.message || '').toLowerCase();
  const causeMessage = String(error?.cause?.message || '').toLowerCase();
  const causeCode = String(error?.cause?.code || error?.code || '').trim().toUpperCase();
  const abortedByController = errorName === 'aborterror'
    || message.includes('aborted')
    || causeMessage.includes('aborted');
  return causeCode === 'UND_ERR_CONNECT_TIMEOUT'
    || causeCode === 'UND_ERR_CONNECT'
    || abortedByController
    || message.includes('fetch failed')
    || causeMessage.includes('connect timeout');
}

async function executePowerShellRelayRequest({
  url,
  method = 'POST',
  headers = {},
  body = {},
  timeoutMs = 90000,
}) {
  await fs.mkdir(RELAY_HTTP_TEMP_DIR, { recursive: true });
  const requestId = crypto.randomUUID();
  const headersPath = path.join(RELAY_HTTP_TEMP_DIR, `${requestId}-headers.json`);
  const bodyPath = path.join(RELAY_HTTP_TEMP_DIR, `${requestId}-body.json`);
  const payloadText = typeof body === 'string' ? body : JSON.stringify(body || {});
  const normalizedMethod = String(method || 'POST').toUpperCase();
  const shouldSendJsonBody = normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD' && payloadText !== '' && payloadText !== '{}';
  await fs.writeFile(headersPath, JSON.stringify(headers || {}), 'utf8');
  await fs.writeFile(bodyPath, payloadText, 'utf8');
  const timeoutSec = Math.max(15, Math.ceil(Number(timeoutMs || 90000) / 1000));
  const invokeLine = shouldSendJsonBody
    ? `  $resp = Invoke-WebRequest -Uri ${powershellSingleQuote(url)} -Method ${powershellSingleQuote(normalizedMethod)} -Headers $headers -Body $body -ContentType 'application/json' -TimeoutSec ${timeoutSec} -ErrorAction Stop`
    : `  $resp = Invoke-WebRequest -Uri ${powershellSingleQuote(url)} -Method ${powershellSingleQuote(normalizedMethod)} -Headers $headers -TimeoutSec ${timeoutSec} -ErrorAction Stop`;
  const script = [
    `$headersJson = Get-Content -Raw -LiteralPath ${powershellSingleQuote(headersPath)} | ConvertFrom-Json`,
    '$headers = @{}',
    '$headersJson.PSObject.Properties | ForEach-Object { $headers[$_.Name] = [string]$_.Value }',
    `$body = Get-Content -Raw -LiteralPath ${powershellSingleQuote(bodyPath)}`,
    'try {',
    invokeLine,
    "  $contentType = if ($resp.Headers['Content-Type']) { [string]$resp.Headers['Content-Type'] } else { 'application/json' }",
    '  $result = @{ ok = $true; status = [int]$resp.StatusCode; contentType = $contentType; body = [string]$resp.Content }',
    '} catch {',
    '  $response = $_.Exception.Response',
    '  $statusCode = if ($response) { [int]$response.StatusCode } else { 0 }',
    "  $contentType = if ($response -and $response.Headers -and $response.Headers['Content-Type']) { [string]$response.Headers['Content-Type'] } else { 'application/json' }",
    "  $content = ''",
    '  if ($response) {',
    '    try {',
    '      $reader = New-Object System.IO.StreamReader($response.GetResponseStream())',
    '      $content = $reader.ReadToEnd()',
    '      $reader.Dispose()',
    '    } catch {}',
    '  }',
    '  $result = @{ ok = $false; status = $statusCode; contentType = $contentType; body = $content; message = $_.Exception.Message }',
    '}',
    '$result | ConvertTo-Json -Compress -Depth 8',
  ].join('\n');
  try {
    const { stdout } = await runCommand('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
    const parsed = JSON.parse(String(stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '{}');
    return {
      ok: Boolean(parsed?.ok),
      status: Number(parsed?.status || 0),
      contentType: String(parsed?.contentType || 'application/json'),
      body: String(parsed?.body || ''),
      message: String(parsed?.message || ''),
    };
  } finally {
    await Promise.allSettled([
      fs.rm(headersPath, { force: true }),
      fs.rm(bodyPath, { force: true }),
    ]);
  }
}

function isApimartBaseUrl(baseUrl = '') {
  try {
    const url = new URL(String(baseUrl || '').trim());
    return /(^|\.)(apimart\.ai|suanliai\.top|comfly\.org)$/i.test(url.hostname);
  } catch {
    return false;
  }
}

function isApimartAsyncGenerationRequest(baseUrl = '', endpoint = '', mode = '', payload = {}, provider = '') {
  if (!isApimartBaseUrl(baseUrl)) return false;
  if (mode !== 'image' && mode !== 'video') return false;
  const normalizedEndpoint = String(endpoint || '').trim();
  if (/\/(?:images|videos)\/generations\/?$/i.test(normalizedEndpoint)) return true;
  if (mode !== 'video') return false;
  if (!/\/video\/?$/i.test(normalizedEndpoint)) return false;
  const requestedModel = extractFirstString(payload?.model) || String(provider || '').trim();
  return Boolean(apimartVideoModelKind(requestedModel));
}

function extractApimartTaskId(payload = {}) {
  return (
    extractFirstString(payload?.task_id)
    || extractFirstString(payload?.task?.id)
    || extractFirstString(payload?.task?.task_id)
    || extractFirstString(payload?.data?.[0]?.task_id)
    || extractFirstString(payload?.data?.[0]?.id)
    || extractFirstString(payload?.result?.task_id)
    || ''
  );
}

function normalizeApimartTaskPhase(value = '') {
  const status = String(value || '').trim().toLowerCase();
  if (!status) return 'pending';
  if (['submitted', 'queued', 'pending', 'created', 'running', 'processing', 'generating', 'in_progress'].includes(status)) {
    return 'pending';
  }
  if (['success', 'succeed', 'succeeded', 'completed', 'done', 'finished'].includes(status)) {
    return 'success';
  }
  if (['failed', 'failure', 'error', 'cancelled', 'canceled', 'expired'].includes(status)) {
    return 'failed';
  }
  return 'pending';
}

function apimartTaskStatusCandidates(baseUrl = '', endpoint = '', taskId = '') {
  const normalizedTaskId = String(taskId || '').trim();
  if (!normalizedTaskId) return [];
  const normalizedBaseUrl = String(baseUrl || '').trim().replace(/\/$/, '');
  const normalizedEndpoint = String(endpoint || '').trim().replace(/\/$/, '');
  const candidates = [
    `${normalizedBaseUrl}/tasks/${normalizedTaskId}`,
    `${normalizedBaseUrl}${normalizedEndpoint}/${normalizedTaskId}`,
  ];
  return candidates.filter((value, index, array) => value && array.indexOf(value) === index);
}

async function sleepWithSignal(ms, signal) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    }, { once: true });
  });
}

async function requestJsonWithOptionalPowerShellRelay({
  baseUrl = '',
  url,
  method = 'POST',
  headers = {},
  body = undefined,
  signal,
  timeoutMs = 90000,
}) {
  const requestUrls = relayRequestUrlCandidates(baseUrl, url);
  let response;
  let lastFetchError = null;
  for (const requestUrl of requestUrls) {
    try {
      response = await fetch(requestUrl, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
      break;
    } catch (fetchError) {
      lastFetchError = fetchError;
      if (!shouldUsePowerShellRelayFallback(requestUrl, fetchError) && !shouldUsePowerShellRelayFallback(baseUrl, fetchError)) {
        throw fetchError;
      }
    }
  }
  if (!response) {
    let lastFallback = null;
    for (const requestUrl of requestUrls) {
      const fallback = await executePowerShellRelayRequest({
        url: requestUrl,
        method,
        headers,
        body: body === undefined ? {} : body,
        timeoutMs,
      });
      lastFallback = fallback;
      if (!(fallback.ok || fallback.status > 0 || String(fallback.body || fallback.message || '').trim())) continue;
      let data = null;
      try {
        data = fallback.body ? JSON.parse(fallback.body) : null;
      } catch {
        data = { raw: fallback.body };
      }
      return {
        ok: fallback.ok,
        status: Number(fallback.status || 0),
        contentType: String(fallback.contentType || 'application/json'),
        data,
        fallback: true,
      };
    }
    if (lastFetchError) throw lastFetchError;
    if (lastFallback?.message) throw new Error(lastFallback.message);
    throw new Error('relay-request-failed');
  }

  const contentType = response.headers.get('content-type') || 'application/json';
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return {
    ok: response.ok,
    status: response.status,
    contentType,
    data,
    fallback: false,
  };
}

function relayConnectivityCacheKey(baseUrl = '') {
  return String(baseUrl || '').trim().toLowerCase().replace(/\/$/, '');
}

async function probeRelayConnectivity(baseUrl = '', timeoutMs = 8000) {
  const normalizedBaseUrl = normalizeRelayEndpointInput(baseUrl);
  if (!normalizedBaseUrl) {
    return {
      ok: false,
      code: 'missing-base-url',
      message: '当前 provider 没有可用 Base URL',
    };
  }

  const cacheKey = relayConnectivityCacheKey(normalizedBaseUrl);
  const now = Date.now();
  const cached = RELAY_CONNECTIVITY_CACHE.get(cacheKey);
  if (cached && Number(cached.expiresAt || 0) > now) {
    return cached.value;
  }

  const candidates = relayModelsEndpointCandidates(normalizedBaseUrl);
  let lastFailure = {
    ok: false,
    code: 'connectivity-check-failed',
    message: `Unable to reach ${normalizedBaseUrl}.`,
  };

  for (const candidateUrl of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(candidateUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      const result = {
        ok: true,
        url: candidateUrl,
        status: Number(response.status || 0),
      };
      RELAY_CONNECTIVITY_CACHE.set(cacheKey, {
        value: result,
        expiresAt: now + RELAY_CONNECTIVITY_SUCCESS_TTL_MS,
      });
      return result;
    } catch (error) {
      clearTimeout(timer);
      const rawMessage = error instanceof Error ? error.message : String(error);
      const timeoutLike = error?.name === 'AbortError' || /aborted/i.test(rawMessage);
      const message = timeoutLike
        ? 'Connection to ' + candidateUrl + ' timed out. Check whether the current network can reach that endpoint.'
        : rawMessage;
      lastFailure = {
        ok: false,
        url: candidateUrl,
        code: timeoutLike
          ? 'CONNECT_TIMEOUT'
          : (String(error?.cause?.code || error?.code || '').trim().toUpperCase() || 'fetch-failed'),
        message,
      };
      if (!shouldUsePowerShellRelayFallback(candidateUrl, error) && !shouldUsePowerShellRelayFallback(normalizedBaseUrl, error)) {
        continue;
      }
      const fallback = await executePowerShellRelayRequest({
        url: candidateUrl,
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
        timeoutMs,
      });
      if (Number(fallback.status || 0) > 0) {
        const result = {
          ok: true,
          url: candidateUrl,
          status: Number(fallback.status || 0),
          fallback: true,
        };
        RELAY_CONNECTIVITY_CACHE.set(cacheKey, {
          value: result,
          expiresAt: now + RELAY_CONNECTIVITY_SUCCESS_TTL_MS,
        });
        return result;
      }
      lastFailure = {
        ok: false,
        url: candidateUrl,
        code: String(fallback.message || lastFailure.code || 'powershell-fallback-failed').trim(),
        message: String(fallback.message || lastFailure.message || `Unable to reach ${candidateUrl}.`).trim(),
      };
    }
  }

  RELAY_CONNECTIVITY_CACHE.set(cacheKey, {
    value: lastFailure,
    expiresAt: now + RELAY_CONNECTIVITY_FAILURE_TTL_MS,
  });
  return lastFailure;
}

function parseInlineDataUrl(value = '') {
  const source = String(value || '').trim();
  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,([a-z0-9+/=\s]+)$/i.exec(source);
  if (!match) return null;
  return {
    mimeType: String(match[1] || 'application/octet-stream').trim().toLowerCase(),
    buffer: Buffer.from(match[2].replace(/\s+/g, ''), 'base64'),
  };
}

async function executePowerShellRelayMultipartUpload({
  url,
  headers = {},
  filePath,
  timeoutMs = 90000,
}) {
  await fs.mkdir(RELAY_HTTP_TEMP_DIR, { recursive: true });
  const requestId = crypto.randomUUID();
  const headersPath = path.join(RELAY_HTTP_TEMP_DIR, `${requestId}-multipart-headers.json`);
  await fs.writeFile(headersPath, JSON.stringify(headers || {}), 'utf8');
  const timeoutSec = Math.max(15, Math.ceil(Number(timeoutMs || 90000) / 1000));
  const script = [
    'Add-Type -AssemblyName System.Net.Http',
    `$headersJson = Get-Content -Raw -LiteralPath ${powershellSingleQuote(headersPath)} | ConvertFrom-Json`,
    `$filePath = ${powershellSingleQuote(filePath)}`,
    `$fileName = [System.IO.Path]::GetFileName($filePath)`,
    '$bytes = [System.IO.File]::ReadAllBytes($filePath)',
    '$mime = [string][System.Web.MimeMapping]::GetMimeMapping($fileName)',
    '$client = [System.Net.Http.HttpClient]::new()',
    `$client.Timeout = [TimeSpan]::FromSeconds(${timeoutSec})`,
    '$headersJson.PSObject.Properties | ForEach-Object { [void]$client.DefaultRequestHeaders.TryAddWithoutValidation($_.Name, [string]$_.Value) }',
    '$form = [System.Net.Http.MultipartFormDataContent]::new()',
    '$fileContent = [System.Net.Http.ByteArrayContent]::new($bytes)',
    '$fileContent.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse($mime)',
    "$form.Add($fileContent, 'file', $fileName)",
    'try {',
    `  $resp = $client.PostAsync(${powershellSingleQuote(url)}, $form).GetAwaiter().GetResult()`,
    '  $body = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()',
    "  $contentType = if ($resp.Content.Headers.ContentType) { [string]$resp.Content.Headers.ContentType } else { 'application/json' }",
    '  $result = @{ ok = $resp.IsSuccessStatusCode; status = [int]$resp.StatusCode; contentType = $contentType; body = $body }',
    '} catch {',
    '  $result = @{ ok = $false; status = 0; contentType = "application/json"; body = ""; message = $_.Exception.Message }',
    '} finally {',
    '  $form.Dispose()',
    '  $fileContent.Dispose()',
    '  $client.Dispose()',
    '}',
    '$result | ConvertTo-Json -Compress -Depth 8',
  ];
  try {
    const { stdout } = await runCommand('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script.join('\n')]);
    const parsed = JSON.parse(String(stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '{}');
    return {
      ok: Boolean(parsed?.ok),
      status: Number(parsed?.status || 0),
      contentType: String(parsed?.contentType || 'application/json'),
      body: String(parsed?.body || ''),
      message: String(parsed?.message || ''),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      contentType: 'application/json',
      body: '',
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await fs.rm(headersPath, { force: true }).catch(() => {});
  }
}

function extractManagedLocalRoutePath(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('/api/')) return raw;
  try {
    const url = new URL(raw);
    if (!isPrivateOrLocalHostname(url.hostname) && !isManagedPublicRelayAssetUrl(raw)) return '';
    return `${url.pathname}${url.search}`;
  } catch {
    return '';
  }
}

function isManagedPublicRelayAssetUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return (
      url.pathname.startsWith('/api/assets/content/')
      || url.pathname.startsWith('/api/media-proxy')
      || url.pathname.startsWith('/api/local-video/result/')
      || url.pathname.startsWith('/api/local-post/result/')
    );
  } catch {
    return false;
  }
}

function isTemporaryTunnelHost(hostname = '') {
  const normalized = String(hostname || '').trim().toLowerCase();
  return (
    normalized.endsWith('.loca.lt')
    || normalized.endsWith('.localtunnel.me')
    || normalized.endsWith('.lhr.life')
    || normalized.endsWith('.localhost.run')
    || normalized.endsWith('.trycloudflare.com')
  );
}

async function resolveManagedLocalMediaFile(value = '', kind = '') {
  const managedPath = extractManagedLocalRoutePath(value);
  if (!managedPath) return null;

  if (managedPath.startsWith('/api/assets/content/')) {
    const assetId = sanitizeLocalAssetId(managedPath.slice('/api/assets/content/'.length).split(/[?#]/, 1)[0]);
    if (!assetId) return null;
    const item = await findAssetLibraryItem(assetId);
    if (!item?.filePath) return null;
    return {
      filePath: path.resolve(String(item.filePath || '').trim()),
      mimeType: mediaMimeTypeFromExtension(String(item.filePath || ''), inferMediaContentType(String(item.filePath || ''), '', kind)),
      originalName: String(item.name || `${assetId}`),
      cleanupPaths: [],
    };
  }

  const routeMap = [
    ['/api/local-video/result/', LOCAL_VIDEO_RESULT_DIR, 'video'],
    ['/api/local-audio/result/', LOCAL_AUDIO_RESULT_DIR, 'audio'],
    ['/api/local-post/result/', LOCAL_POST_RESULT_DIR, kind || 'video'],
  ];
  for (const [prefix, baseDir, inferredKind] of routeMap) {
    if (!managedPath.startsWith(prefix)) continue;
    const assetId = sanitizeLocalAssetId(managedPath.slice(prefix.length).split(/[?#]/, 1)[0]);
    if (!assetId) return null;
    const filePath = path.join(baseDir, assetId);
    return {
      filePath,
      mimeType: mediaMimeTypeFromExtension(filePath, inferMediaContentType(filePath, '', inferredKind)),
      originalName: path.basename(filePath),
      cleanupPaths: [],
    };
  }

  return null;
}

async function materializeMediaSourceToLocalFile(value = '', kind = '') {
  const source = String(value || '').trim();
  if (!source) return null;

  const inline = parseInlineDataUrl(source);
  if (inline?.buffer?.length) {
    const extension = extensionFromMimeType(inline.mimeType || (kind === 'video' ? 'video/mp4' : 'image/png'));
    const tempPath = path.join(APIMART_CONDITIONING_DIR, `${crypto.randomUUID()}.${extension}`);
    await fs.mkdir(APIMART_CONDITIONING_DIR, { recursive: true });
    await fs.writeFile(tempPath, inline.buffer);
    return {
      filePath: tempPath,
      mimeType: inline.mimeType || (kind === 'video' ? 'video/mp4' : 'image/png'),
      originalName: path.basename(tempPath),
      cleanupPaths: [tempPath],
    };
  }

  const managed = await resolveManagedLocalMediaFile(source, kind);
  if (managed) return managed;

  if (/^file:\/\//i.test(source)) {
    const filePath = fileURLToPath(source);
    return {
      filePath,
      mimeType: mediaMimeTypeFromExtension(filePath, inferMediaContentType(filePath, '', kind)),
      originalName: path.basename(filePath),
      cleanupPaths: [],
    };
  }

  if (/^[a-zA-Z]:[\\/]/.test(source) || source.startsWith('\\\\')) {
    return {
      filePath: path.resolve(source),
      mimeType: mediaMimeTypeFromExtension(source, inferMediaContentType(source, '', kind)),
      originalName: path.basename(source),
      cleanupPaths: [],
    };
  }

  if (/^https?:\/\//i.test(source)) {
    const remote = await downloadRemoteMediaBuffer(source);
    const extension = extensionFromMimeType(remote.mimeType || source || (kind === 'video' ? 'video/mp4' : 'image/png'));
    const tempPath = path.join(APIMART_CONDITIONING_DIR, `${crypto.randomUUID()}.${extension}`);
    await fs.mkdir(APIMART_CONDITIONING_DIR, { recursive: true });
    await fs.writeFile(tempPath, remote.bytes);
    return {
      filePath: tempPath,
      mimeType: remote.mimeType || mediaMimeTypeFromExtension(source, inferMediaContentType(source, '', kind)),
      originalName: path.basename(new URL(source).pathname) || path.basename(tempPath),
      cleanupPaths: [tempPath],
    };
  }

  return null;
}

function shouldUploadApimartImageConditioningValue(value = '') {
  const source = String(value || '').trim();
  if (!source) return false;
  if (source.startsWith('data:image/')) return true;
  if (source.startsWith('/api/')) return true;
  if (/^[a-zA-Z]:[\\/]/.test(source) || source.startsWith('\\\\') || /^file:\/\//i.test(source)) return true;
  if (isManagedPublicRelayAssetUrl(source)) return true;
  try {
    const url = new URL(source);
    return isPrivateOrLocalHostname(url.hostname) || isTemporaryTunnelHost(url.hostname);
  } catch {
    return false;
  }
}

async function transcodeVideoToMp4(inputPath, outputPath, minimumDurationSeconds = 0) {
  const sourceMeta = await probeVideoFile(inputPath).catch(() => ({ duration: 0 }));
  const padSeconds = Math.max(0, Number(minimumDurationSeconds || 0) - Number(sourceMeta?.duration || 0));
  const videoFilters = ['scale=trunc(iw/2)*2:trunc(ih/2)*2'];
  if (padSeconds > 0.01) {
    videoFilters.push(`tpad=stop_mode=clone:stop_duration=${padSeconds.toFixed(3)}`);
  }
  const videoEncoder = await resolvePreferredMp4VideoEncoder();
  const videoEncoderArgs = videoEncoder === 'mpeg4'
    ? ['-c:v', 'mpeg4', '-q:v', '2']
    : ['-c:v', videoEncoder, '-b:v', '4M'];
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await runCommand('ffmpeg', [
    '-y',
    '-i',
    inputPath,
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-vf',
    videoFilters.join(','),
    ...videoEncoderArgs,
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    outputPath,
  ]);
  return outputPath;
}

function tmpfilesDirectDownloadUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.hostname !== 'tmpfiles.org') return raw;
    if (url.pathname.startsWith('/dl/')) return raw;
    url.pathname = `/dl${url.pathname}`;
    return url.toString();
  } catch {
    return raw;
  }
}

async function uploadTmpfilesPublicAsset(filePath, timeoutMs = 90000) {
  const upload = await executePowerShellRelayMultipartUpload({
    url: 'https://tmpfiles.org/api/v1/upload',
    headers: {
      Accept: 'application/json',
    },
    filePath,
    timeoutMs,
  });
  let data = null;
  try {
    data = upload.body ? JSON.parse(upload.body) : null;
  } catch {
    data = { raw: upload.body };
  }
  if (!upload.ok) {
    const message = extractFirstString(data?.message) || upload.message || `tmpfiles upload failed with HTTP ${upload.status}.`;
    throw new Error(message);
  }
  const publishedUrl = extractFirstString(data?.data?.url) || extractFirstString(data?.url);
  if (!publishedUrl) {
    throw new Error('tmpfiles upload succeeded without a public URL.');
  }
  return tmpfilesDirectDownloadUrl(publishedUrl);
}

async function ensureStablePublicVideoUrl(value = '', timeoutMs = 90000) {
  const source = String(value || '').trim();
  if (!source) return source;
  if (isPublicRemoteMediaUrl(source) && /\.mp4(?:[?#]|$)/i.test(source)) {
    try {
      const url = new URL(source);
      if (!isManagedPublicRelayAssetUrl(source) && !isTemporaryTunnelHost(url.hostname)) {
        return source;
      }
    } catch {
      return source;
    }
  }

  const materialized = await materializeMediaSourceToLocalFile(source, 'video');
  if (!materialized?.filePath) return source;

  const cleanupPaths = [...(materialized.cleanupPaths || [])];
  try {
    const inputPath = path.resolve(materialized.filePath);
    const sourceMeta = await probeVideoFile(inputPath).catch(() => ({ duration: 0 }));
    const durationTooShort = Number(sourceMeta?.duration || 0) > 0 && Number(sourceMeta.duration) < 3;
    const alreadyMp4 = /\.mp4$/i.test(inputPath) && String(materialized.mimeType || '').toLowerCase().includes('video/mp4');
    const publishPath = alreadyMp4
      ? (durationTooShort ? path.join(APIMART_CONDITIONING_DIR, `${crypto.randomUUID()}.mp4`) : inputPath)
      : path.join(APIMART_CONDITIONING_DIR, `${crypto.randomUUID()}.mp4`);
    if (!alreadyMp4 || durationTooShort) {
      await transcodeVideoToMp4(inputPath, publishPath, 3);
      cleanupPaths.push(publishPath);
    }
    if (PUBLIC_MEDIA_BASE_URL) {
      const sourceName = String(materialized.originalName || path.basename(inputPath)).trim();
      const publishedNameBase = path.basename(sourceName || crypto.randomUUID(), path.extname(sourceName || ''));
      const publishedName = `${publishedNameBase || crypto.randomUUID()}.mp4`;
      const imported = await processAssetLibraryImportRequest({
        name: publishedName,
        originalName: publishedName,
        type: 'video',
        sourceUrl: source || sourceName || publishedName,
        inputPath: publishPath,
        inputMimeType: 'video/mp4',
        duration: Math.max(3, Number(sourceMeta?.duration || 0)),
        copySourceFile: true,
      });
      const publishedUrl = materializePublicRelayMediaUrl(
        buildAssetLibraryContentUrl(imported?.item?.id || imported?.item?.backendAssetId || ''),
      );
      if (isPublicRemoteMediaUrl(publishedUrl)) {
        return publishedUrl;
      }
    }
    return await uploadTmpfilesPublicAsset(publishPath, timeoutMs);
  } finally {
    await Promise.all(cleanupPaths.map((entry) => fs.rm(entry, { force: true }).catch(() => {})));
  }
}

async function uploadApimartImageAsset({
  baseUrl,
  apiKey,
  value,
  timeoutMs = 90000,
  signal,
}) {
  const source = String(value || '').trim();
  if (!source || !shouldUploadApimartImageConditioningValue(source)) return source;
  const materialized = await materializeMediaSourceToLocalFile(source, 'image');
  if (!materialized?.filePath) return source;
  try {
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
    const uploadUrls = relayRequestUrlCandidates(baseUrl, `${baseUrl}/uploads/images`);
    let lastError = null;
    for (const uploadUrl of uploadUrls) {
      try {
        const bytes = await fs.readFile(materialized.filePath);
        const form = new FormData();
        form.append('file', new Blob([bytes], { type: materialized.mimeType || 'image/png' }), path.basename(materialized.filePath));
        const response = await fetch(uploadUrl, {
          method: 'POST',
          headers,
          body: form,
          signal,
        });
        const contentType = response.headers.get('content-type') || 'application/json';
        const text = await response.text();
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = { raw: text };
        }
        if (!response.ok) {
          const message = extractFirstString(data?.error?.message) || extractFirstString(data?.message) || `Image upload failed with HTTP ${response.status}.`;
          throw Object.assign(new Error(message), { status: response.status, payload: data });
        }
        return extractFirstString(data?.data?.url) || extractFirstString(data?.url) || source;
      } catch (error) {
        lastError = error;
        // APIMart /uploads/images 多数情况不可用 → 不阻止 fallback
      }
    }
    // 直接走 tmpfiles.org 兜底（与视频上传完全相同）
    try {
      const tmpfilesUrl = await uploadTmpfilesPublicAsset(materialized.filePath, timeoutMs);
      if (tmpfilesUrl && /^https?:\/\//i.test(tmpfilesUrl)) {
        return tmpfilesUrl;
      }
    } catch (tmpfilesError) {
      // tmpfiles.org 也不可用，继续回退
    }
    // 所有上传路径都失败 — 回退到原始 URL（外部服务可能可以直接访问）
    return source;
  } finally {
    await Promise.all((materialized.cleanupPaths || []).map((entry) => fs.rm(entry, { force: true }).catch(() => {})));
  }
}

async function materializeApimartImageConditioningPayload(payload = {}, baseUrl = '', apiKey = '', timeoutMs = 90000, signal) {
  if (!payload || typeof payload !== 'object') return payload;
  const next = { ...payload };
  const sourceMediaType = String(next.source_media_type || payload.source_media_type || '').trim().toLowerCase();
  const imageUrlFields = [
    'image',
    'image_url',
    'reference_image',
    'reference_image_url',
    'first_frame_image',
    'first_frame_image_url',
    'last_frame_image',
    'last_frame_image_url',
  ];
  if (sourceMediaType !== 'video') {
    imageUrlFields.push('source_url');
  }
  for (const field of imageUrlFields) {
    if (typeof next[field] === 'string') {
      next[field] = await uploadApimartImageAsset({
        baseUrl,
        apiKey,
        value: next[field],
        timeoutMs,
        signal,
      });
    }
  }
  if (Array.isArray(next.image_urls)) {
    next.image_urls = await Promise.all(next.image_urls.map((item) => (
      typeof item === 'string'
        ? uploadApimartImageAsset({ baseUrl, apiKey, value: item, timeoutMs, signal })
        : item
    )));
  }
  if (Array.isArray(next.image_with_roles)) {
    next.image_with_roles = await Promise.all(next.image_with_roles.map(async (item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
      const entry = { ...item };
      const sharedImageValue = typeof entry.url === 'string' && entry.url.startsWith('data:image/')
        ? entry.url
        : typeof entry.image_url === 'string' && entry.image_url.startsWith('data:image/')
          ? entry.image_url
          : typeof entry.image === 'string' && entry.image.startsWith('data:image/')
            ? entry.image
            : '';
      if (sharedImageValue) {
        const uploaded = await uploadApimartImageAsset({
          baseUrl,
          apiKey,
          value: sharedImageValue,
          timeoutMs,
          signal,
        });
        entry.url = uploaded;
        entry.image_url = uploaded;
        if (typeof entry.image === 'string') entry.image = uploaded;
      } else {
        for (const field of ['url', 'image_url', 'image']) {
          if (typeof entry[field] === 'string') {
            const uploaded = await uploadApimartImageAsset({
              baseUrl,
              apiKey,
              value: entry[field],
              timeoutMs,
              signal,
            });
            entry[field] = uploaded;
          }
        }
      }
      if (!entry.url && typeof entry.image_url === 'string') entry.url = entry.image_url;
      if (!entry.image_url && typeof entry.url === 'string') entry.image_url = entry.url;
      return entry;
    }));
  }
  return next;
}

async function materializeApimartVideoConditioningPayload(payload = {}, timeoutMs = 90000) {
  if (!payload || typeof payload !== 'object') return payload;
  const next = { ...payload };
  const videoUrlFields = ['source_url', 'reference_video_url', 'video_url'];
  for (const field of videoUrlFields) {
    if (typeof next[field] === 'string') {
      next[field] = await ensureStablePublicVideoUrl(next[field], timeoutMs);
    }
  }
  if (Array.isArray(next.video_urls)) {
    next.video_urls = await Promise.all(next.video_urls.map((item) => (
      typeof item === 'string' ? ensureStablePublicVideoUrl(item, timeoutMs) : item
    )));
  }
  if (Array.isArray(next.video_list)) {
    next.video_list = await Promise.all(next.video_list.map(async (item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
      if (typeof item.video_url !== 'string') return item;
      return {
        ...item,
        video_url: await ensureStablePublicVideoUrl(item.video_url, timeoutMs),
      };
    }));
  }
  return next;
}

function apimartVideoSize(payload = {}) {
  const quality = String(payload.quality || '').trim().toLowerCase();
  if (/^\d+p$/.test(quality)) return quality;

  const resolution = String(payload.resolution || '').trim().toLowerCase();
  if (/^\d+p$/.test(resolution)) return resolution;

  const width = Number(payload.width);
  const height = Number(payload.height);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    const key = `${Math.round(width)}x${Math.round(height)}`;
    const known = {
      '854x480': '480p',
      '960x720': '720p',
      '1024x1024': '720p',
      '1280x720': '720p',
      '1440x1080': '1080p',
      '1920x1080': '1080p',
    };
    return known[key] || key;
  }

  const aspectRatio = normalizeAspectRatio(payload.aspect_ratio || payload.aspectRatio || '16:9', '16:9');
  const fallback = {
    '16:9': '720p',
    '9:16': '720p',
    '1:1': '720p',
    '4:3': '720p',
    '3:4': '720p',
  };
  return fallback[aspectRatio] || '720p';
}

function apimartVideoAspectRatio(payload = {}) {
  return normalizeAspectRatio(
    payload.aspect_ratio || payload.aspectRatio || payload.size || rawAspectRatioFromResolution(payload.width, payload.height) || '16:9',
    '16:9',
  );
}

function rawAspectRatioFromResolution(width, height) {
  const normalizedWidth = Number(width);
  const normalizedHeight = Number(height);
  if (!Number.isFinite(normalizedWidth) || !Number.isFinite(normalizedHeight) || normalizedWidth <= 0 || normalizedHeight <= 0) {
    return '';
  }
  if (Math.abs((normalizedWidth / normalizedHeight) - (16 / 9)) < 0.04) return '16:9';
  if (Math.abs((normalizedWidth / normalizedHeight) - (9 / 16)) < 0.04) return '9:16';
  if (Math.abs((normalizedWidth / normalizedHeight) - 1) < 0.04) return '1:1';
  if (Math.abs((normalizedWidth / normalizedHeight) - (4 / 3)) < 0.04) return '4:3';
  if (Math.abs((normalizedWidth / normalizedHeight) - (3 / 4)) < 0.04) return '3:4';
  return '';
}

function apimartKlingMode(payload = {}) {
  const explicitMode = String(payload.mode || '').trim().toLowerCase();
  if (['std', 'pro', '4k'].includes(explicitMode)) return explicitMode;
  const quality = String(payload.quality || payload.resolution || '').trim().toLowerCase();
  if (quality === '4k' || quality === '2160p') return '4k';
  if (quality === '1080p') return 'pro';
  return 'std';
}

function apimartVideoModelKind(model = '') {
  const normalized = normalizeCatalogIdentifier(model);
  if (!normalized) return '';
  const catalogItem = catalogModelByIdentifier(model);
  const candidates = [
    catalogItem?.id,
    catalogItem?.upstreamModel,
    relayAliasCatalogId(model),
    model,
  ]
    .map((value) => normalizeCatalogIdentifier(value))
    .filter(Boolean);
  if (candidates.some((value) => value === 'seedance-v2' || value.includes('seedance'))) return 'seedance-v2';
  if (candidates.some((value) => value.includes('happyhorse'))) return 'happyhorse';
  if (candidates.some((value) => value.includes('kling-v3-omni'))) return 'kling-v3-omni';
  if (candidates.some((value) => value.includes('kling-v3-motion-control'))) return 'kling-v3-motion-control';
  if (candidates.some((value) => value.includes('kling-video-o1'))) return 'kling-video-o1';
  if (candidates.some((value) => value === 'kling-o3')) return 'kling-o3';
  if (candidates.some((value) => value.includes('kling-v3'))) return 'kling-v3';
  if (candidates.some((value) => value.includes('kling'))) return 'kling';
  return '';
}

function isApimartKlingVideoModelKind(modelKind = '') {
  return /^kling(?:-|$)/.test(String(modelKind || '').trim().toLowerCase());
}

function shouldRouteApimartVideoEditToHappyhorse(rawPayload = {}, normalizedPayload = {}) {
  const fallbackEnabled = ['1', 'true', 'yes'].includes(String(process.env.HMDAO_ENABLE_HAPPYHORSE_VIDEO_EDIT_FALLBACK || '').trim().toLowerCase());
  if (!fallbackEnabled) return false;
  const model = extractFirstString(normalizedPayload?.model) || extractFirstString(rawPayload?.model);
  if (!isApimartKlingVideoModelKind(apimartVideoModelKind(model))) return false;
  const sourceMediaType = String(rawPayload?.source_media_type || normalizedPayload?.source_media_type || '').trim().toLowerCase();
  if (sourceMediaType !== 'video') return false;
  const imageRoleEntries = buildApimartImageRoleEntries(rawPayload || {}, normalizedPayload || {});
  return imageRoleEntries.length > 0;
}

function isPrivateOrLocalHostname(hostname = '') {
  const normalized = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!normalized) return true;
  if (
    normalized === 'localhost'
    || normalized === '0.0.0.0'
    || normalized === '::1'
    || normalized.endsWith('.local')
    || normalized.endsWith('.lan')
    || normalized.endsWith('.internal')
  ) {
    return true;
  }
  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) {
    if (normalized.startsWith('10.')) return true;
    if (normalized.startsWith('127.')) return true;
    if (normalized.startsWith('192.168.')) return true;
    if (normalized.startsWith('169.254.')) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(normalized)) return true;
    return false;
  }
  if (ipVersion === 6) {
    if (normalized === '::1') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    if (normalized.startsWith('fe80:')) return true;
    return false;
  }
  return false;
}

function resolvePublicMediaBaseUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (isPrivateOrLocalHostname(url.hostname)) return '';
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return String(url.toString() || '').replace(/\/$/, '');
  } catch {
    return '';
  }
}

const PUBLIC_MEDIA_BASE_URL = resolvePublicMediaBaseUrl(
  process.env.HMDAO_PUBLIC_BASE_URL || process.env.HMDAO_REAL_PUBLIC_BASE_URL || '',
);

function isPublicRemoteMediaUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (/^(data:|blob:|file:|hmdao-local:\/\/)/i.test(raw)) return false;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return !isPrivateOrLocalHostname(url.hostname);
  } catch {
    return false;
  }
}

function materializePublicRelayMediaUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw || !PUBLIC_MEDIA_BASE_URL) return raw;
  if (
    raw.startsWith('/api/assets/content/')
    || raw.startsWith('/api/media-proxy?')
    || raw.startsWith('/api/local-video/result/')
    || raw.startsWith('/api/local-post/result/')
  ) {
    return new URL(raw, `${PUBLIC_MEDIA_BASE_URL}/`).toString();
  }
  try {
    const url = new URL(raw);
    if (
      isPrivateOrLocalHostname(url.hostname)
      && (
        url.pathname.startsWith('/api/assets/content/')
        || url.pathname.startsWith('/api/media-proxy')
        || url.pathname.startsWith('/api/local-video/result/')
        || url.pathname.startsWith('/api/local-post/result/')
      )
    ) {
      return new URL(`${url.pathname}${url.search}`, `${PUBLIC_MEDIA_BASE_URL}/`).toString();
    }
  } catch {
    return raw;
  }
  return raw;
}

function materializePublicRelayPayload(payload = {}) {
  if (!PUBLIC_MEDIA_BASE_URL || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }
  const next = { ...payload };
  for (const field of ['source_url', 'reference_video_url', 'image_url', 'reference_image_url', 'first_frame_url', 'last_frame_url']) {
    if (typeof next[field] === 'string') {
      next[field] = materializePublicRelayMediaUrl(next[field]);
    }
  }
  if (Array.isArray(next.video_urls)) {
    next.video_urls = next.video_urls.map((item) => (
      typeof item === 'string' ? materializePublicRelayMediaUrl(item) : item
    ));
  }
  if (Array.isArray(next.image_urls)) {
    next.image_urls = next.image_urls.map((item) => (
      typeof item === 'string' ? materializePublicRelayMediaUrl(item) : item
    ));
  }
  if (Array.isArray(next.video_list)) {
    next.video_list = next.video_list.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
      if (typeof item.video_url !== 'string') return item;
      return {
        ...item,
        video_url: materializePublicRelayMediaUrl(item.video_url),
      };
    });
  }
  if (Array.isArray(next.image_with_roles)) {
    next.image_with_roles = next.image_with_roles.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
      const mapped = { ...item };
      for (const field of ['url', 'image_url', 'image']) {
        if (typeof mapped[field] === 'string') {
          mapped[field] = materializePublicRelayMediaUrl(mapped[field]);
        }
      }
      return mapped;
    });
  }
  for (const field of ['primary_assets', 'reference_assets']) {
    if (!Array.isArray(next[field])) continue;
    next[field] = next[field].map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
      const mapped = { ...item };
      if (typeof mapped.url === 'string') {
        mapped.url = materializePublicRelayMediaUrl(mapped.url);
      }
      for (const nestedField of ['image_url', 'video_url', 'thumbnail']) {
        if (typeof mapped[nestedField] === 'string') {
          mapped[nestedField] = materializePublicRelayMediaUrl(mapped[nestedField]);
        }
      }
      return mapped;
    });
  }
  return next;
}

function canMaterializeApimartStableVideoSource(value = '') {
  const source = String(value || '').trim();
  if (!source) return false;
  if (isPublicRemoteMediaUrl(source)) return true;
  if (Boolean(parseInlineDataUrl(source)?.buffer?.length)) return true;
  if (extractManagedLocalRoutePath(source)) return true;
  if (/^file:\/\//i.test(source)) return true;
  if (/^[a-zA-Z]:[\\/]/.test(source) || source.startsWith('\\\\')) return true;
  try {
    const url = new URL(source);
    if (isManagedPublicRelayAssetUrl(source)) return true;
    return isPrivateOrLocalHostname(url.hostname) || isTemporaryTunnelHost(url.hostname);
  } catch {
    return false;
  }
}
function buildApimartAsyncRequestConstraint({
  provider,
  mode,
  rawPayload = {},
  payload = {},
}) {
  if (String(mode || '').trim().toLowerCase() !== 'video') return null;
  const requestedModel = extractFirstString(payload?.model) || extractFirstString(rawPayload?.model) || provider;
  const model = shouldRouteApimartVideoEditToHappyhorse(rawPayload || {}, payload || {})
    ? 'happyhorse-1.0'
    : requestedModel;
  const modelKind = apimartVideoModelKind(model || provider);
  if (!isApimartKlingVideoModelKind(modelKind)) return null;

  const sourceMediaType = String(rawPayload?.source_media_type || payload?.source_media_type || '').trim().toLowerCase();
  if (sourceMediaType !== 'video') return null;

  const primaryVideoUrl = extractFirstString(payload?.source_url)
    || extractFirstString(rawPayload?.source_url)
    || extractFirstString(payload?.reference_video_url)
    || extractFirstString(rawPayload?.reference_video_url)
    || extractFirstString(Array.isArray(payload?.video_urls) ? payload.video_urls[0] : '')
    || extractFirstString(Array.isArray(payload?.video_list) ? payload.video_list[0]?.video_url : '');

  const diagnosticUrls = uniqueStrings([
    extractFirstString(payload?.source_url),
    extractFirstString(rawPayload?.source_url),
    extractFirstString(payload?.reference_video_url),
    extractFirstString(rawPayload?.reference_video_url),
    ...(Array.isArray(payload?.video_urls) ? payload.video_urls.map((item) => extractFirstString(item)) : []),
    ...(Array.isArray(payload?.video_list) ? payload.video_list.map((item) => extractFirstString(item?.video_url)) : []),
  ].filter(Boolean));

  if (!primaryVideoUrl) {
    return {
      category: 'request',
      code: 'apimart-kling-source-video-missing',
      message: 'APIMart/Kling 视频请求缺少可用的 source/reference video URL，当前不会发起真实上游请求',
      detail: {
        provider,
        mode,
        modelKind,
        sourceMediaType,
        diagnosticUrls,
      },
    };
  }

  if (canMaterializeApimartStableVideoSource(primaryVideoUrl)) return null;

  return {
    category: 'request',
    code: 'apimart-kling-source-video-public-url-required',
    message: 'APIMart/Kling 的 source video 只支持公网可访问 video URL。当前仍是本地句柄、data URL、文本 URL 或 localhost/局域网地址，已在请求层拦截以避免浪费真实生成次数',
    detail: {
      provider,
      mode,
      modelKind,
      sourceMediaType,
      primaryVideoUrl,
      diagnosticUrls,
    },
  };
}

function apimartImageModelKind(model = '') {
  const normalized = normalizeCatalogIdentifier(model);
  if (!normalized) return '';
  const catalogItem = catalogModelByIdentifier(model);
  const catalogId = normalizeCatalogIdentifier(catalogItem?.id || relayAliasCatalogId(model) || model);
  if (catalogId === 'qwen-image-2-0' || normalized.includes('qwen-image')) return 'qwen-image';
  if (catalogId === 'gpt-image-2' || normalized.includes('gpt-image-2')) return 'gpt-image-2';
  return 'generic-image';
}

function isStrictImageSubjectSwapOperation(operation = '') {
  return String(operation || '').trim() === 'preserveCompositionReplaceSubject';
}

function apimartImageSize(payload = {}) {
  const explicitSize = extractFirstString(payload.size);
  if (explicitSize) return explicitSize;

  const aspectRatio = normalizeAspectRatio(
    payload.aspect_ratio || payload.aspectRatio || rawAspectRatioFromResolution(payload.width, payload.height) || '1:1',
    '1:1',
  );
  const supported = new Set(['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3']);
  return supported.has(aspectRatio) ? aspectRatio : '1:1';
}

function apimartImageResolution(payload = {}, modelKind = '') {
  const explicitResolution = String(payload.resolution || '').trim().toLowerCase();
  if (explicitResolution === '1k' || explicitResolution === '2k' || explicitResolution === '4k') {
    if (modelKind === 'qwen-image' && explicitResolution === '4k') return '2K';
    return modelKind === 'qwen-image' ? explicitResolution.toUpperCase() : explicitResolution;
  }

  const quality = String(payload.quality || '').trim().toLowerCase();
  if (quality === '2k' || quality === 'hd' || quality === '1080p' || quality === '1440p') {
    return modelKind === 'qwen-image' ? '2K' : '2k';
  }
  if (quality === '4k' || quality === '2160p') {
    return modelKind === 'qwen-image' ? '2K' : '4k';
  }

  const width = Number(payload.width);
  const height = Number(payload.height);
  const maxEdge = Math.max(
    Number.isFinite(width) ? width : 0,
    Number.isFinite(height) ? height : 0,
  );
  if (maxEdge >= 2300) return modelKind === 'qwen-image' ? '2K' : '4k';
  if (maxEdge >= 1400) return modelKind === 'qwen-image' ? '2K' : '2k';
  return modelKind === 'qwen-image' ? '1K' : '1k';
}

function assetCoverageRoles(asset = {}, options = {}) {
  const explicitCoverage = Array.isArray(asset?.coverageRoles)
    ? asset.coverageRoles
    : Array.isArray(asset?.coverage_roles)
      ? asset.coverage_roles
      : [];
  const normalizedExplicitCoverage = Array.from(new Set(
    explicitCoverage
      .map((entry) => String(entry || '').trim().toLowerCase())
      .filter(Boolean),
  ));
  if (normalizedExplicitCoverage.length > 0) return normalizedExplicitCoverage;

  const normalizedRole = String(asset?.role || '').trim().toLowerCase();
  if (!normalizedRole) return ['reference'];
  if (normalizedRole === 'primary') return ['composition'];
  if (normalizedRole !== 'omni') return [normalizedRole];
  if (String(asset?.type || '').trim().toLowerCase() === 'video') return ['motion', 'rhythm', 'style'];
  if (isStrictImageSubjectSwapOperation(options?.imageStrategyOperation)) return ['style', 'lighting'];
  return ['subject', 'style', 'composition', 'lighting'];
}

function apimartExpandedImageRoles(asset = {}, options = {}) {
  return assetCoverageRoles(asset, options);
}

function buildApimartImageRoleEntries(rawPayload = {}, normalizedPayload = {}) {
  const entries = [];
  const seen = new Set();
  const push = (url, role, weight = 0, source = '') => {
    const normalizedUrl = extractFirstString(url);
    const normalizedRole = String(role || '').trim().toLowerCase();
    if (!normalizedUrl || !normalizedRole) return;
    const key = `${normalizedRole}::${normalizedUrl}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(compactObject({
      url: normalizedUrl,
      image_url: normalizedUrl,
      role: normalizedRole,
      weight: Number.isFinite(Number(weight)) && Number(weight) > 0 ? Math.max(0.05, Math.min(1, Number(weight) > 1 ? Number(weight) / 100 : Number(weight))) : undefined,
      source,
    }));
  };

  const sourceMediaType = String(rawPayload.source_media_type || normalizedPayload.source_media_type || '').trim().toLowerCase();
  const imageStrategyOperation = String(
    rawPayload?.conditioning_strategy?.operation
    || normalizedPayload?.conditioning_strategy?.operation
    || '',
  ).trim();
  const primaryAssets = normalizeReferenceAssets(rawPayload.primary_assets);
  const referenceAssets = normalizeReferenceAssets(rawPayload.reference_assets);

  if (sourceMediaType !== 'video') {
    const primarySourceUrl = extractFirstString(normalizedPayload.first_frame_url)
      || extractFirstString(normalizedPayload.source_url);
    if (primarySourceUrl) {
      push(primarySourceUrl, 'composition', 1, 'primary-source');
      push(primarySourceUrl, 'first_frame', 1, 'primary-source');
    }
  }

  const lastFrameUrl = extractFirstString(normalizedPayload.last_frame_url);
  if (lastFrameUrl) push(lastFrameUrl, 'last_frame', 1, 'last-frame');

  for (const asset of primaryAssets) {
    if (asset.type !== 'image') continue;
    for (const role of apimartExpandedImageRoles(asset, { imageStrategyOperation })) {
      push(asset.url, role === 'primary' ? 'composition' : role, asset.weight, 'primary-asset');
    }
  }

  for (const asset of referenceAssets) {
    if (asset.type !== 'image') continue;
    for (const role of apimartExpandedImageRoles(asset, { imageStrategyOperation })) {
      push(asset.url, role, asset.weight, 'reference-asset');
    }
  }

  const fallbackReferenceImageUrl = extractFirstString(normalizedPayload.reference_image_url);
  if (fallbackReferenceImageUrl) {
    push(fallbackReferenceImageUrl, 'subject', Number(rawPayload.reference_weight || 0.7), 'reference-image-url');
  }

  return entries;
}

function buildApimartOrderedImageUrls(imageRoleEntries = []) {
  const priority = new Map([
    ['composition', 0],
    ['first_frame', 1],
    ['subject', 2],
    ['style', 3],
    ['lighting', 4],
    ['reference', 5],
    ['last_frame', 6],
  ]);
  return imageRoleEntries
    .map((item, index) => ({
      url: extractFirstString(item?.url),
      order: priority.get(String(item?.role || '').trim().toLowerCase()) ?? 99,
      index,
    }))
    .filter((item) => item.url)
    .sort((left, right) => left.order - right.order || left.index - right.index)
    .reduce((accumulator, item) => {
      if (!accumulator.includes(item.url)) accumulator.push(item.url);
      return accumulator;
    }, [])
    .slice(0, 16);
}

function buildApimartImagePromptContract(prompt = '', imageRoleEntries = [], strategyOperation = '') {
  const basePrompt = String(prompt || '').trim();
  if (!imageRoleEntries.length) return basePrompt;

  const hasComposition = imageRoleEntries.some((item) => item.role === 'composition' || item.role === 'first_frame');
  const hasSubject = imageRoleEntries.some((item) => item.role === 'subject');
  const hasStyle = imageRoleEntries.some((item) => item.role === 'style' || item.role === 'lighting');
  const lines = [basePrompt];

  lines.push('');
  lines.push('[HMDAO upstream image_urls role contract]');
  if (hasComposition) {
    lines.push('- image_urls[0] is the locked composition anchor. Preserve its camera angle, framing, crop, perspective, subject scale, depth and scene layout.');
  }
  if (hasSubject) {
    lines.push('- The next subject reference image is the only authority for the replacement hero product or object. Replace only the original hero subject with that reference.');
    lines.push('- This is an object or product replacement task, not portrait or character generation. Do not introduce people or human faces unless the prompt explicitly asks for them.');
    lines.push('- Do not modernize, redesign, or substitute the requested subject with a different generation, class, era, or product family than the explicit subject reference.');
  }
  if (hasStyle) {
    lines.push('- Remaining reference images refine only style palette, lighting mood, material finish and atmosphere. They must not override the locked composition or the explicit subject replacement.');
    lines.push('- If any style, lighting, or background reference contains another vehicle, product, animal, or person, ignore that foreground identity completely. Use only its atmosphere, palette, reflections, and environment lighting.');
    lines.push('- If any non-subject reference conflicts with the explicit subject reference, discard the non-subject foreground identity and keep only atmosphere-level cues.');
  }
  if (isStrictImageSubjectSwapOperation(strategyOperation)) {
    lines.push('- Keep the original composition from image_urls[0], replace only the main subject, and preserve the rest of the scene structure.');
  }
  return lines.join('\n');
}

function buildApimartVideoRoleEntries(rawPayload = {}, normalizedPayload = {}) {
  const entries = [];
  const seen = new Set();
  const push = (url, role, source = '') => {
    const normalizedUrl = extractFirstString(url);
    const normalizedRole = String(role || '').trim().toLowerCase();
    if (!normalizedUrl || !normalizedRole) return;
    const key = `${normalizedRole}::${normalizedUrl}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ url: normalizedUrl, role: normalizedRole, source });
  };

  const sourceMediaType = String(rawPayload.source_media_type || normalizedPayload.source_media_type || '').trim().toLowerCase();
  const primaryAssets = normalizeReferenceAssets(rawPayload.primary_assets);
  const referenceAssets = normalizeReferenceAssets(rawPayload.reference_assets);
  if (sourceMediaType === 'video') {
    const sourceUrl = extractFirstString(normalizedPayload.source_url);
    if (sourceUrl) push(sourceUrl, 'composition', 'primary-source-video');
  }

  for (const asset of primaryAssets) {
    if (asset.type !== 'video') continue;
    push(asset.url, asset.role === 'primary' ? 'composition' : asset.role, 'primary-asset-video');
  }

  for (const asset of referenceAssets) {
    if (asset.type !== 'video') continue;
    const roles = String(asset.role || '').trim().toLowerCase() === 'omni'
      ? ['motion', 'rhythm', 'style']
      : [asset.role];
    for (const role of roles) {
      push(asset.url, role, 'reference-asset-video');
    }
  }

  const fallbackReferenceVideoUrl = extractFirstString(normalizedPayload.reference_video_url);
  if (fallbackReferenceVideoUrl) push(fallbackReferenceVideoUrl, 'motion', 'reference-video-url');

  return entries;
}

function buildApimartAudioUrls(rawPayload = {}) {
  const values = [
    extractFirstString(rawPayload.linked_audio_url),
    ...(Array.isArray(rawPayload.reference_assets)
      ? rawPayload.reference_assets
        .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
        .filter((item) => String(item.type || '').trim().toLowerCase() === 'audio')
        .map((item) => extractFirstString(item.url))
      : []),
  ].filter(Boolean);
  return uniqueStrings(values);
}

function normalizeApimartAsyncGenerationPayload({
  provider,
  mode,
  endpoint,
  rawPayload = {},
  payload = {},
}) {
  const normalizedEndpoint = String(endpoint || '').trim();
  if (mode === 'image' && /\/images\/generations\/?$/i.test(normalizedEndpoint)) {
    const imageRoleEntries = buildApimartImageRoleEntries(rawPayload, payload);
    const orderedImageUrls = buildApimartOrderedImageUrls(imageRoleEntries);
    const model = extractFirstString(payload.model) || extractFirstString(rawPayload.model);
    const modelKind = apimartImageModelKind(model || provider);
    const prompt = buildApimartImagePromptContract(
      extractFirstString(payload.prompt) || extractFirstString(rawPayload.prompt),
      imageRoleEntries,
      rawPayload?.conditioning_strategy?.operation || payload?.conditioning_strategy?.operation || '',
    );
    const count = Number(payload.n ?? payload.count ?? rawPayload.n ?? rawPayload.count);
    const explicitNegativePrompt = extractFirstString(payload.negative_prompt) || extractFirstString(rawPayload.negative_prompt);

    return compactObject({
      model,
      prompt,
      size: apimartImageSize({ ...rawPayload, ...payload }),
      resolution: apimartImageResolution({ ...rawPayload, ...payload }, modelKind),
      n: Number.isFinite(count) ? Math.max(1, Math.min(modelKind === 'qwen-image' ? 6 : 16, Math.round(count))) : undefined,
      negative_prompt: explicitNegativePrompt || (isStrictImageSubjectSwapOperation(rawPayload?.conditioning_strategy?.operation || payload?.conditioning_strategy?.operation || '')
        ? 'people, person, woman, man, portrait, selfie, human face, character'
        : undefined),
      image_urls: orderedImageUrls.length ? orderedImageUrls : undefined,
      official_fallback: typeof payload.official_fallback === 'boolean'
        ? payload.official_fallback
        : typeof rawPayload.official_fallback === 'boolean'
          ? rawPayload.official_fallback
          : undefined,
    });
  }

  if (mode !== 'video' || !/\/videos\/generations\/?$/i.test(normalizedEndpoint)) {
    return payload;
  }

  const imageRoleEntries = buildApimartImageRoleEntries(rawPayload, payload);
  const videoRoleEntries = buildApimartVideoRoleEntries(rawPayload, payload);
  const imageUrls = uniqueStrings(imageRoleEntries.map((item) => extractFirstString(item.url)).filter(Boolean));
  const videoUrls = uniqueStrings(videoRoleEntries.map((item) => extractFirstString(item.url)).filter(Boolean));
  const audioUrls = buildApimartAudioUrls(rawPayload);
  const sourceMediaType = String(rawPayload.source_media_type || payload.source_media_type || '').trim().toLowerCase();
  const requestedModel = extractFirstString(payload.model) || extractFirstString(rawPayload.model);
  const useHappyhorseVideoEditRoute = shouldRouteApimartVideoEditToHappyhorse(rawPayload, payload);
  const model = useHappyhorseVideoEditRoute ? 'happyhorse-1.0' : requestedModel;
  const modelKind = apimartVideoModelKind(model || provider);
  const normalizedModel = normalizeCatalogIdentifier(model || '');
  const firstFrameImage = extractFirstString(payload.first_frame_url)
    || imageRoleEntries.find((item) => item.role === 'first_frame')?.url
    || imageRoleEntries.find((item) => item.role === 'composition')?.url
    || '';
  const lastFrameImage = extractFirstString(payload.last_frame_url)
    || imageRoleEntries.find((item) => item.role === 'last_frame')?.url
    || '';
  const subjectReferenceImage = imageRoleEntries.find((item) => item.role === 'subject')?.url
    || imageRoleEntries.find((item) => item.role === 'style')?.url
    || extractFirstString(payload.reference_image_url)
    || '';
  const referenceVideo = videoRoleEntries.find((item) => item.role === 'motion')?.url
    || extractFirstString(payload.reference_video_url)
    || '';
  const durationMin = isApimartKlingVideoModelKind(modelKind) ? 3 : 1;
  const durationMax = isApimartKlingVideoModelKind(modelKind) ? 15 : 30;
  const duration = Number.isFinite(Number(payload.duration))
    ? Math.max(durationMin, Math.min(durationMax, Math.round(Number(payload.duration))))
    : 5;
  const resolution = apimartVideoSize({ ...rawPayload, ...payload });
  const aspectRatio = apimartVideoAspectRatio({ ...rawPayload, ...payload });
  const referenceStrength = Number(rawPayload.reference_weight || rawPayload.consistency_strength || payload.reference_weight || payload.consistency_strength);
  const generateAudio = Boolean(audioUrls.length || rawPayload.generate_audio || payload.generate_audio || rawPayload.audio || payload.audio);

  const common = compactObject({
    model,
    prompt: extractFirstString(payload.prompt) || extractFirstString(rawPayload.prompt),
    duration,
    aspect_ratio: aspectRatio,
    seed: Number.isFinite(Number(payload.seed)) ? Math.round(Number(payload.seed)) : undefined,
    negative_prompt: extractFirstString(payload.negative_prompt),
    generate_audio: generateAudio,
    image_urls: imageUrls.length ? imageUrls : undefined,
    video_urls: videoUrls.length ? videoUrls : undefined,
    audio_urls: audioUrls.length ? audioUrls : undefined,
    reference_strength: Number.isFinite(referenceStrength) ? Math.max(0.05, Math.min(1, referenceStrength > 1 ? referenceStrength / 100 : referenceStrength)) : undefined,
  });

  if (modelKind === 'happyhorse') {
    const primaryVideoUrl = sourceMediaType === 'video'
      ? extractFirstString(payload.source_url) || videoUrls[0] || referenceVideo
      : '';
    return compactObject({
      model,
      prompt: extractFirstString(payload.prompt) || extractFirstString(rawPayload.prompt),
      duration,
      resolution,
      aspect_ratio: aspectRatio,
      seed: Number.isFinite(Number(payload.seed)) ? Math.round(Number(payload.seed)) : undefined,
      negative_prompt: extractFirstString(payload.negative_prompt),
      prompt_optimizer: typeof payload.prompt_optimizer === 'boolean'
        ? payload.prompt_optimizer
        : typeof rawPayload.prompt_optimizer === 'boolean'
          ? rawPayload.prompt_optimizer
          : undefined,
      camera_fixed: typeof payload.camera_fixed === 'boolean'
        ? payload.camera_fixed
        : typeof rawPayload.camera_fixed === 'boolean'
          ? rawPayload.camera_fixed
          : sourceMediaType === 'video'
            ? true
            : undefined,
      image_url: sourceMediaType === 'video' ? undefined : firstFrameImage || undefined,
      image_urls: imageUrls.length ? imageUrls.slice(0, 5) : undefined,
      video_url: primaryVideoUrl || undefined,
    });
  }

  if (modelKind === 'seedance-v2') {
    // APIMart doubao-seedance-2.0 合约（参考 docs.apimart.ai）：
    //   - 不支持 negative_prompt
    //   - 首帧/尾帧/参考人像 应在 image_with_roles[] 数组中（{url, role: first_frame|last_frame|reference_image}）
    //   - image_urls 与 image_with_roles 互斥
    //   - 使用 image_with_roles 时 video_urls 和 audio_urls 不可用
    //   - video_urls: 最多 3 个，1.8s-15.2s，480P-720P
    const hasFrameImage = sourceMediaType !== 'video' && (firstFrameImage || lastFrameImage);
    const useImageWithRoles = hasFrameImage; // 有首尾帧则用 image_with_roles 形式

    const imageWithRoles = [];
    if (firstFrameImage) imageWithRoles.push({ url: firstFrameImage, role: 'first_frame' });
    if (lastFrameImage)  imageWithRoles.push({ url: lastFrameImage,  role: 'last_frame' });
    // 把 reference role 的人物参考放进 image_with_roles（reference_image）
    for (const entry of imageRoleEntries) {
      if (entry.role === 'subject' || entry.role === 'style' || entry.role === 'composition' || entry.role === 'lighting') {
        if (!imageWithRoles.some((e) => e.url === entry.url)) {
          imageWithRoles.push({ url: entry.url, role: 'reference_image' });
        }
      }
    }

    // 互斥规则：使用 image_with_roles 时不能同时用 video_urls 和 audio_urls
    const canUseVideoUrls = !useImageWithRoles && videoUrls.length > 0;
    const canUseAudioUrls = !useImageWithRoles && audioUrls.length > 0;

    return compactObject({
      model,
      prompt: extractFirstString(payload.prompt) || extractFirstString(rawPayload.prompt),
      duration,
      resolution,
      size: aspectRatio,
      seed: Number.isFinite(Number(payload.seed)) ? Math.round(Number(payload.seed)) : undefined,
      // 注意：seedance-v2 不支持 negative_prompt
      generate_audio: generateAudio || undefined,
      // 互斥：image_urls 与 image_with_roles 二选一
      image_urls: useImageWithRoles ? undefined : (imageUrls.length ? imageUrls : undefined),
      image_with_roles: useImageWithRoles && imageWithRoles.length ? imageWithRoles : undefined,
      video_urls: canUseVideoUrls ? videoUrls : undefined,
      audio_urls: canUseAudioUrls ? audioUrls : undefined,
    });
  }

  if (isApimartKlingVideoModelKind(modelKind)) {
    const klingImageWithRoles = [];
    if (sourceMediaType !== 'video' && firstFrameImage) {
      klingImageWithRoles.push({ image_url: firstFrameImage, role: 'first_frame' });
    }
    if (lastFrameImage) {
      klingImageWithRoles.push({ image_url: lastFrameImage, role: 'last_frame' });
    }
    const klingReferenceImages = uniqueStrings(
      imageRoleEntries
        .filter((item) => item.role !== 'first_frame' && item.role !== 'last_frame' && item.role !== 'composition')
        .map((item) => item.url)
        .filter(Boolean),
    );
    klingReferenceImages.forEach((url) => {
      klingImageWithRoles.push({ image_url: url, role: 'reference' });
    });
    const klingVideoList = [];
    const primaryVideoUrl = sourceMediaType === 'video'
      ? extractFirstString(payload.source_url) || videoUrls[0] || referenceVideo
      : '';
    if (primaryVideoUrl) {
      klingVideoList.push({
        video_url: primaryVideoUrl,
        refer_type: 'base',
        keep_original_sound: generateAudio ? 'yes' : 'no',
      });
    }
    if (modelKind === 'kling-v3-omni' || normalizedModel.includes('kling-v3-omni')) {
      return compactObject({
        model,
        prompt: extractFirstString(payload.prompt) || extractFirstString(rawPayload.prompt),
        duration,
        mode: apimartKlingMode({ ...rawPayload, ...payload }),
        aspect_ratio: aspectRatio,
        negative_prompt: extractFirstString(payload.negative_prompt),
        audio: generateAudio || undefined,
        image_with_roles: klingImageWithRoles.length ? klingImageWithRoles : undefined,
        video_list: klingVideoList.length ? klingVideoList : undefined,
      });
    }
    return compactObject({
      model,
      prompt: extractFirstString(payload.prompt) || extractFirstString(rawPayload.prompt),
      duration,
      mode: apimartKlingMode({ ...rawPayload, ...payload }),
      aspect_ratio: aspectRatio,
      negative_prompt: extractFirstString(payload.negative_prompt),
      audio: generateAudio || undefined,
      image_urls: imageUrls.length ? imageUrls.slice(0, 2) : undefined,
      image_url: sourceMediaType === 'video' ? undefined : firstFrameImage || undefined,
      video_url: referenceVideo || undefined,
    });
  }

  return compactObject({
    ...common,
    first_frame_image: firstFrameImage || undefined,
    last_frame_image: lastFrameImage || undefined,
    reference_image: subjectReferenceImage || undefined,
    reference_video: referenceVideo || undefined,
  });
}

function buildApimartTaskResultPayload(taskPayload = {}, submitPayload = null) {
  const task = taskPayload?.task && typeof taskPayload.task === 'object' ? taskPayload.task : {};
  const taskData = taskPayload?.data && typeof taskPayload.data === 'object' && !Array.isArray(taskPayload.data) ? taskPayload.data : {};
  const result = task?.result && typeof task.result === 'object' ? task.result : {};
  const response = task?.response && typeof task.response === 'object' ? task.response : {};
  const taskDataResult = taskData?.result && typeof taskData.result === 'object' ? taskData.result : {};
  const taskDataImages = Array.isArray(taskDataResult?.images)
    ? taskDataResult.images.flatMap((item) => {
      const urls = Array.isArray(item?.url) ? item.url : [item?.url];
      return urls
        .map((value) => extractFirstString(value))
        .filter(Boolean)
        .map((url) => ({ url }));
    })
    : [];
  const taskDataVideos = Array.isArray(taskDataResult?.videos)
    ? taskDataResult.videos.flatMap((item) => {
      const urls = Array.isArray(item?.url) ? item.url : [item?.url];
      return urls
        .map((value) => extractFirstString(value))
        .filter(Boolean)
        .map((url) => ({ url }));
    })
    : [];
  const mergedData = Array.isArray(result?.data)
    ? result.data
    : Array.isArray(response?.data)
      ? response.data
      : taskDataImages.length > 0
        ? taskDataImages
        : taskDataVideos.length > 0
          ? taskDataVideos
          : Array.isArray(taskPayload?.data)
            ? taskPayload.data
            : undefined;
  const mergedVideoResults = Array.isArray(result?.results?.videos)
    ? result.results.videos
    : Array.isArray(response?.results?.videos)
      ? response.results.videos
      : taskDataVideos.length > 0
        ? taskDataVideos
        : undefined;
  const mergedOutput = Array.isArray(result?.output)
    ? result.output
    : Array.isArray(response?.output)
      ? response.output
      : undefined;
  return compactObject({
    ...(submitPayload && typeof submitPayload === 'object' ? { submit: submitPayload } : {}),
    task_id: extractApimartTaskId(taskPayload) || extractApimartTaskId(submitPayload || {}),
    status: task?.status || taskData?.status || taskPayload?.status,
    ...response,
    ...result,
    ...taskDataResult,
    data: mergedData,
    output: mergedOutput,
    results: mergedVideoResults ? { videos: mergedVideoResults } : undefined,
  });
}

function apimartTaskStatusValue(taskPayload = {}) {
  return (
    taskPayload?.task?.status
    || taskPayload?.data?.status
    || taskPayload?.status
    || taskPayload?.data?.[0]?.status
    || taskPayload?.result?.status
    || taskPayload?.response?.status
    || ''
  );
}

function extractApimartAsyncFailureMessage(taskPayload = {}, fallback = 'Generation failed upstream.') {
  const parts = [
    extractFirstString(taskPayload?.task?.error?.message),
    extractFirstString(taskPayload?.task?.error_message),
    extractFirstString(taskPayload?.task?.reason),
    extractFirstString(taskPayload?.task?.message),
    extractFirstString(taskPayload?.error?.message),
    extractFirstString(taskPayload?.error_message),
    extractFirstString(taskPayload?.reason),
    extractFirstString(taskPayload?.message),
    extractFirstString(taskPayload?.data?.message),
    extractFirstString(taskPayload?.data?.reason),
    extractFirstString(taskPayload?.result?.message),
    extractFirstString(taskPayload?.response?.message),
  ].filter(Boolean);
  if (parts.length > 0) return parts[0];
  const status = String(apimartTaskStatusValue(taskPayload) || '').trim();
  const taskId = extractApimartTaskId(taskPayload);
  const detail = [status ? `status=${status}` : '', taskId ? `task_id=${taskId}` : ''].filter(Boolean).join(', ');
  return detail ? `${fallback} (${detail})` : fallback;
}

async function executeApimartAsyncGenerationRequest({
  provider,
  mode,
  baseUrl,
  endpoint,
  apiKey,
  payload,
  rawPayload = null,
  timeoutMs = 180000,
  signal,
}) {
  // 标准化不同 relay 平台的端点路径
  // suanliai.top / comfly.org 使用 /video/generations（单数），非 /videos/generations（复数）
  let normalizedEndpoint = String(endpoint || '/videos/generations');
  if (/(suanliai\.top|comfly\.org)/i.test(baseUrl || '')) {
    normalizedEndpoint = normalizedEndpoint.replace('/videos/generations', '/video/generations');
  }
  endpoint = normalizedEndpoint;

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'x-hmdao-provider': provider,
    'x-hmdao-mode': mode,
  };
  const normalizedPayload = normalizeApimartAsyncGenerationPayload({
    provider,
    mode,
    endpoint,
    rawPayload: rawPayload && typeof rawPayload === 'object' ? rawPayload : payload,
    payload: payload || {},
  });
  const imageMaterializedPayload = await materializeApimartImageConditioningPayload(
    normalizedPayload || {},
    baseUrl,
    apiKey,
    timeoutMs,
    signal,
  );
  const submitPayload = await materializeApimartVideoConditioningPayload(
    imageMaterializedPayload || {},
    timeoutMs,
  );
  const submit = await requestJsonWithOptionalPowerShellRelay({
    baseUrl,
    url: `${baseUrl}${endpoint}`,
    method: 'POST',
    headers,
    body: submitPayload,
    signal,
    timeoutMs,
  });
  const submitData = submit.data || {};
  if (!submit.ok) {
    const message = extractFirstString(submitData?.error?.message) || extractFirstString(submitData?.message) || `Upstream request failed with HTTP ${submit.status}.`;
    return {
      success: false,
      provider,
      mode,
      error: {
        message,
        status: submit.status,
        provider,
        category: classifyProxyError({ status: submit.status, message }),
        code: extractFirstString(submitData?.error?.code) || '',
      },
      raw: {
        submitData,
        submitPayload,
      },
    };
  }

  const taskId = extractApimartTaskId(submitData);
  if (!taskId) {
    return normalizeUpstreamPayload({
      provider,
      mode,
      data: submitData,
      contentType: submit.contentType,
      status: submit.status || 200,
    });
  }

  const startedAt = Date.now();
  let lastTaskData = submitData;
  const statusCandidates = apimartTaskStatusCandidates(baseUrl, endpoint, taskId);
  while (Date.now() - startedAt < timeoutMs) {
    let pollingFailure = null;
    let sawPendingResponse = false;
    for (const statusUrl of statusCandidates) {
      const statusResponse = await requestJsonWithOptionalPowerShellRelay({
        baseUrl,
        url: statusUrl,
        method: 'GET',
        headers,
        signal,
        timeoutMs,
      });
      const statusData = statusResponse.data || {};
      lastTaskData = statusData;

      if (!statusResponse.ok) {
        const message = extractFirstString(statusData?.error?.message) || extractFirstString(statusData?.message) || `Task polling failed with HTTP ${statusResponse.status}.`;
        pollingFailure = {
          success: false,
          provider,
          mode,
          error: {
            message,
            status: statusResponse.status,
            provider,
            category: classifyProxyError({ status: statusResponse.status, message }),
            code: extractFirstString(statusData?.error?.code) || '',
          },
          raw: {
            ...statusData,
            taskId,
            statusUrl,
            statusCandidates,
            submitData,
          },
        };
        continue;
      }

      const phase = normalizeApimartTaskPhase(apimartTaskStatusValue(statusData));
      if (phase === 'success') {
        return normalizeUpstreamPayload({
          provider,
          mode,
          data: buildApimartTaskResultPayload(statusData, submitData),
          contentType: statusResponse.contentType || 'application/json',
          status: statusResponse.status || 200,
        });
      }
      if (phase === 'failed') {
        const message = extractApimartAsyncFailureMessage(statusData);
        return {
          success: false,
          provider,
          mode,
          error: {
            message,
            status: statusResponse.status || 502,
            provider,
            category: classifyProxyError({ status: statusResponse.status || 502, message }),
            code: extractFirstString(statusData?.task?.error?.code) || '',
          },
          raw: {
            ...statusData,
            taskId,
            statusUrl,
            statusCandidates,
            submitData,
          },
        };
      }
      sawPendingResponse = true;
    }

    if (pollingFailure && !sawPendingResponse) {
      return pollingFailure;
    }

    await sleepWithSignal(4000, signal);
  }

  return {
    success: false,
    provider,
    mode,
    error: {
      message: `Upstream request timed out after ${timeoutMs}ms.`,
      status: 0,
      provider,
      code: 'timeout',
      category: 'timeout',
    },
    raw: {
      ...(lastTaskData && typeof lastTaskData === 'object' ? lastTaskData : {}),
      taskId,
      statusCandidates,
      submitData,
    },
  };
}

async function runShellCommandWithInput(commandLine, inputText, cwd = APP_DIR, extraEnv = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', commandLine], {
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...extraEnv,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = stderr.trim().split(/\r?\n/).slice(-8).join(' | ');
      reject(new Error(`wrapper command exited ${code}: ${detail || 'unknown-error'}`));
    });
    child.stdin.write(String(inputText || ''));
    child.stdin.end();
  });
}

function shellQuotePath(value) {
  return `"${String(value || '').replace(/"/g, '\\"')}"`;
}

function interpolateWrapperCommand(commandLine, context = {}) {
  const replacements = {
    payloadPath: shellQuotePath(context.payloadPath || ''),
    inputPath: shellQuotePath(context.inputPath || ''),
    outputPath: shellQuotePath(context.outputPath || ''),
    requestId: String(context.requestId || ''),
    mediaKind: String(context.mediaKind || ''),
    route: String(context.route || ''),
  };
  return String(commandLine || '').replace(/\{\{\s*(payloadPath|inputPath|outputPath|requestId|mediaKind|route)\s*\}\}/g, (_, key) => replacements[key] ?? '');
}

function parseWrapperStdout(stdout, fallbackOutputPath = '') {
  const trimmed = String(stdout || '').trim();
  if (!trimmed) return {};
  const candidates = [trimmed, ...trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse()];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      if (candidate && (candidate.includes(path.sep) || candidate.startsWith('./') || candidate.startsWith('../')) && !candidate.startsWith('{')) {
        return { outputPath: candidate };
      }
    }
  }
  return fallbackOutputPath ? { outputPath: fallbackOutputPath } : {};
}

async function runJsonWrapperCommand(commandLine, payload, {
  cwd = APP_DIR,
  payloadPath = '',
  fallbackOutputPath = '',
  env = {},
} = {}) {
  const serialized = JSON.stringify(payload);
  let wrapperPayloadPath = payloadPath;
  if (!wrapperPayloadPath) {
    wrapperPayloadPath = path.join(LOCAL_POST_EDIT_DIR, `${String(payload?.requestId || crypto.randomUUID())}-wrapper-payload.json`);
  }
  await fs.writeFile(wrapperPayloadPath, serialized, 'utf8');
  const resolvedCommand = interpolateWrapperCommand(commandLine, {
    payloadPath: wrapperPayloadPath,
    inputPath: payload?.inputPath,
    outputPath: payload?.outputPath,
    requestId: payload?.requestId,
    mediaKind: payload?.mediaKind,
    route: payload?.route,
  });
  const wrapperEnv = {
    HMDAO_WRAPPER_PAYLOAD: wrapperPayloadPath,
    HMDAO_WRAPPER_INPUT: String(payload?.inputPath || ''),
    HMDAO_WRAPPER_OUTPUT: String(payload?.outputPath || ''),
    HMDAO_WRAPPER_REQUEST_ID: String(payload?.requestId || ''),
    HMDAO_WRAPPER_MEDIA_KIND: String(payload?.mediaKind || ''),
    HMDAO_WRAPPER_ROUTE: String(payload?.route || ''),
    ...env,
  };
  const { stdout, stderr } = await runShellCommandWithInput(resolvedCommand, serialized, cwd, wrapperEnv);
  return {
    parsed: parseWrapperStdout(stdout, fallbackOutputPath),
    stdout,
    stderr,
    payloadPath: wrapperPayloadPath,
  };
}

async function runLocalPython(commandArgs, { scriptPath, args = [], cwd = APP_DIR, timeoutMs = 0 } = {}) {
  const executable = commandArgs[0];
  const prefixArgs = commandArgs.slice(1);
  const finalArgs = scriptPath ? [...prefixArgs, scriptPath, ...args] : [...prefixArgs, ...args];
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, finalArgs, {
      cwd,
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let timedOut = false;
    const timeoutHandle = Number(timeoutMs) > 0
      ? setTimeout(() => {
          timedOut = true;
          try {
            child.kill();
          } catch {
            // noop
          }
        }, Number(timeoutMs))
      : null;
    child.stdout.on('data', (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      if (timedOut) {
        reject(new Error(`${executable} timed out after ${Number(timeoutMs)}ms`));
        return;
      }
      const detail = stderr.trim().split(/\r?\n/).slice(-10).join(' | ');
      reject(new Error(`${executable} exited ${code}: ${detail || 'unknown-error'}`));
    });
  });
}

async function runPreferredLocalPython({ scriptPath, args = [], cwd = APP_DIR, timeoutMs = 0 } = {}) {
  const candidates = [
    ['py', '-3.13'],
  ];
  let lastError = null;
  for (const candidate of candidates) {
    try {
      return await runLocalPython(candidate, { scriptPath, args, cwd, timeoutMs });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('preferred-local-python-unavailable');
}

async function runJsonPythonScript(scriptPath, args = []) {
  const { stdout } = await runPreferredLocalPython({ scriptPath, args });
  const text = String(stdout || '').trim();
  if (!text) {
    throw new Error(`python-script-empty-output:${path.basename(scriptPath)}`);
  }
  return JSON.parse(text);
}

async function probeVideoFile(filePath) {
  const { stdout } = await runCommand('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height:format=duration',
    '-of',
    'json',
    filePath,
  ]);
  const parsed = JSON.parse(stdout || '{}');
  return {
    width: Math.max(2, Number(parsed?.streams?.[0]?.width || 0)),
    height: Math.max(2, Number(parsed?.streams?.[0]?.height || 0)),
    duration: Math.max(0, Number(parsed?.format?.duration || 0)),
  };
}

async function probeImageFile(filePath) {
  const { stdout } = await runCommand('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-of',
    'json',
    filePath,
  ]);
  const parsed = JSON.parse(stdout || '{}');
  return {
    width: Math.max(2, Number(parsed?.streams?.[0]?.width || 0)),
    height: Math.max(2, Number(parsed?.streams?.[0]?.height || 0)),
    duration: 0,
  };
}

async function probeMediaStreams(filePath) {
  const { stdout } = await runCommand('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type',
    '-of',
    'json',
    filePath,
  ]);
  const parsed = JSON.parse(stdout || '{}');
  const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
  return {
    hasVideo: streams.some((stream) => String(stream?.codec_type || '').toLowerCase() === 'video'),
    hasAudio: streams.some((stream) => String(stream?.codec_type || '').toLowerCase() === 'audio'),
  };
}

function normalizeClipSegments(segments, sourceDuration) {
  return (Array.isArray(segments) ? segments : [])
    .map((segment) => {
      const startTime = Math.max(0, Math.min(Number(segment?.startTime || 0), Math.max(0, sourceDuration - 0.05)));
      const endTime = Math.max(startTime + 0.05, Math.min(Number(segment?.endTime || sourceDuration), sourceDuration));
      return {
        startTime: Number(startTime.toFixed(3)),
        endTime: Number(endTime.toFixed(3)),
      };
    })
    .filter((segment) => segment.endTime > segment.startTime + 0.01)
    .sort((left, right) => left.startTime - right.startTime);
}

function clampNumber(value, min, max, fallback) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(min, Math.min(max, next));
}

function evenSize(value, fallback = 2) {
  const rounded = Math.max(2, Math.round(Number(value) || fallback));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function buildWebmEncodeArgs(outputPath, { includeAudio = false } = {}) {
  const args = [
    '-c:v',
    'libvpx',
    '-deadline',
    'good',
    '-cpu-used',
    '4',
    '-crf',
    '18',
    '-b:v',
    '0',
    '-pix_fmt',
    'yuv420p',
  ];
  if (includeAudio) {
    args.push('-c:a', 'libopus', '-b:a', '128k');
  } else {
    args.push('-an');
  }
  args.push(outputPath);
  return args;
}

function buildMp4EncodeArgs(outputPath, { includeAudio = true } = {}) {
  const args = [
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-vf',
    'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
  ];
  if (includeAudio) {
    args.push('-c:a', 'aac', '-b:a', '128k');
  } else {
    args.push('-an');
  }
  args.push(outputPath);
  return args;
}

let preferredMp4VideoEncoderPromise = null;

async function resolvePreferredMp4VideoEncoder() {
  if (!preferredMp4VideoEncoderPromise) {
    preferredMp4VideoEncoderPromise = runCommand('ffmpeg', ['-hide_banner', '-encoders'])
      .then(({ stdout }) => {
        const text = String(stdout || '').toLowerCase();
        const candidates = ['libopenh264', 'h264_mf', 'h264_nvenc', 'h264_qsv', 'mpeg4'];
        return candidates.find((item) => text.includes(item.toLowerCase())) || 'mpeg4';
      })
      .catch(() => 'mpeg4');
  }
  return preferredMp4VideoEncoderPromise;
}

function buildIntermediateVideoArgs(outputPath) {
  return [
    '-an',
    '-c:v',
    'libvpx',
    '-deadline',
    'good',
    '-cpu-used',
    '4',
    '-crf',
    '18',
    '-b:v',
    '0',
    '-pix_fmt',
    'yuv420p',
    outputPath,
  ];
}

function buildIntermediateImageArgs(outputPath) {
  return [
    '-frames:v',
    '1',
    '-c:v',
    'png',
    outputPath,
  ];
}

function bloomBlendMode(value) {
  if (value === 'add') return 'addition';
  if (value === 'softlight') return 'softlight';
  return 'screen';
}

function audioExtensionFromMimeType(mimeType = 'audio/mpeg') {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.includes('wav')) return 'wav';
  if (normalized.includes('ogg')) return 'ogg';
  if (normalized.includes('flac')) return 'flac';
  return 'mp3';
}

function escapePowerShellSingleQuoted(value) {
  return String(value || '').replace(/'/g, "''");
}

function clampAudioSample(value) {
  return Math.max(-1, Math.min(1, value));
}

function hashString(value = '') {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function floatSamplesToWavBuffer(channels, sampleRate = 44100) {
  const safeChannels = Array.isArray(channels) ? channels : [];
  const channelCount = Math.max(1, safeChannels.length);
  const frameCount = safeChannels[0]?.length || 0;
  const blockAlign = channelCount * 2;
  const byteRate = sampleRate * blockAlign;
  const dataSize = frameCount * blockAlign;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channelCount, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const sample = clampAudioSample(Number(safeChannels[channel]?.[frame] || 0));
      const pcm = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
      buffer.writeInt16LE(pcm, offset);
      offset += 2;
    }
  }
  return buffer;
}

const LOCAL_AUDIO_BACKEND_META = {
  'fallback-local': {
    label: '本地预览',
    envCommand: '',
    supportedModes: ['bgm', 'sfx', 'voiceover'],
  },
  audioldm2: {
    label: 'AudioLDM 2',
    envCommand: 'HMDAO_AUDIOLDM2_COMMAND',
    envPath: 'HMDAO_AUDIOLDM2_PATH',
    supportedModes: ['bgm', 'sfx'],
  },
  voxcpm: {
    label: 'VoxCPM',
    envCommand: 'HMDAO_VOXCPM_COMMAND',
    envPath: 'HMDAO_VOXCPM_PATH',
    supportedModes: ['voiceover'],
  },
};

const LOCAL_AUDIO_BACKEND_WRAPPERS = {
  audioldm2: path.resolve(APP_DIR, 'server', 'local_audioldm2_wrapper.mjs'),
  voxcpm: path.resolve(APP_DIR, 'server', 'local_voxcpm_wrapper.mjs'),
};

const LOCAL_IMAGE_ANALYSIS_BACKEND_WRAPPERS = {
  florence2: path.resolve(APP_DIR, 'server', 'local_image_florence2_wrapper.mjs'),
  'qwen35-vl': path.resolve(APP_DIR, 'server', 'local_image_qwen35_vl_wrapper.mjs'),
};

const LOCAL_POST_BACKEND_WRAPPERS = {
  'fsr-preview': path.resolve(APP_DIR, 'server', 'local_post_fsr_wrapper.mjs'),
  realbasicvsr: path.resolve(APP_DIR, 'server', 'local_post_realbasicvsr_wrapper.mjs'),
  supir: path.resolve(APP_DIR, 'server', 'local_post_supir_wrapper.mjs'),
  ocio: path.resolve(APP_DIR, 'server', 'local_post_ocio_wrapper.mjs'),
  'ocio-managed': path.resolve(APP_DIR, 'server', 'local_post_ocio_managed_wrapper.mjs'),
  oiio: path.resolve(APP_DIR, 'server', 'local_post_oiio_wrapper.mjs'),
  gmic: path.resolve(APP_DIR, 'server', 'local_post_gmic_wrapper.mjs'),
  depth: path.resolve(APP_DIR, 'server', 'local_post_depth_anything_wrapper.mjs'),
};

const LOCAL_POST_RUNTIME_GUIDES = {
  ocio: {
    runtimeName: 'OpenColorIO Runtime',
    envPath: 'HMDAO_POST_OCIO_PATH',
    envCommand: 'HMDAO_POST_OCIO_COMMAND',
    docsUrl: 'https://opencolorio.org/',
    downloadUrl: 'https://opencolorio.org/downloads.html',
    installHint: '安装 OpenColorIO 后，把可执行脚本或运行时入口写入 HMDAO_POST_OCIO_PATH；如需自定义启动命令可改为 HMDAO_POST_OCIO_COMMAND',
    successHint: '探测成功后，后期节点里的 OCIO Runtime 状态会切换为"外部 Wrapper 已配置"，生成结果会显示真实 OCIO 链路',
    commonInstallPaths: [
      'C:\\Program Files\\OpenColorIO\\bin\\ocioconvert.exe',
      'C:\\Program Files\\OpenColorIO\\bin\\python.exe',
    ],
    supportsImage: true,
    supportsVideo: true,
  },
  oiio: {
    runtimeName: 'OpenImageIO oiiotool',
    envPath: 'HMDAO_POST_OIIO_PATH',
    envCommand: 'HMDAO_POST_OIIO_COMMAND',
    docsUrl: 'https://openimageio.readthedocs.io/en/latest/oiiotool.html',
    downloadUrl: 'https://github.com/OpenImageIO/oiio/releases',
    installHint: '安装 oiiotool 后，将 oiiotool.exe 路径写入 HMDAO_POST_OIIO_PATH。若需要固定 OCIO Config，可额外设置 HMDAO_POST_OIIO_OCIO_CONFIG 的 OCIO',
    successHint: '探测成功后，后期节点里的 OIIO 严格图片调色会显示"已可接管图片调色"，图片调色会优先走 OIIO + OpenColorIO',
    commonInstallPaths: [
      'C:\\Program Files\\OpenImageIO\\bin\\oiiotool.exe',
      'C:\\Users\\<用户名>\\AppData\\Local\\Programs\\OpenImageIO\\bin\\oiiotool.exe',
    ],
    supportsImage: true,
    supportsVideo: false,
  },
  gmic: {
    runtimeName: 'G\'MIC CLI',
    envPath: 'HMDAO_POST_GMIC_PATH',
    envCommand: 'HMDAO_POST_GMIC_COMMAND',
    docsUrl: 'https://gmic.eu/reference.shtml',
    downloadUrl: 'https://gmic.eu/download.html',
    installHint: '安装 G\'MIC CLI 后，优先将 gmic.exe 路径写入 HMDAO_POST_GMIC_PATH；如需自定义前置命令可改为 HMDAO_POST_GMIC_COMMAND',
    successHint: '探测成功后，后期节点里的 G\'MIC Runtime 状态会切换到"图片真实处理已接入"，Bloom / Grain / 细节修复会优先走 G\'MIC',
    commonInstallPaths: [
      'C:\\Program Files\\G-MIC\\gmic.exe',
      'C:\\Program Files\\GMIC\\gmic.exe',
      'C:\\Users\\<用户名>\\AppData\\Local\\Programs\\GMIC\\gmic.exe',
    ],
    supportsImage: true,
    supportsVideo: false,
  },
  'fsr-preview': {
    runtimeName: 'FSR Preview Wrapper',
    envPath: 'HMDAO_POST_FSR_PATH',
    envCommand: 'HMDAO_POST_FSR_COMMAND',
    docsUrl: 'https://gpuopen.com/fidelityfx-superresolution-1/',
    downloadUrl: '',
    installHint: '优先把可执行运行时入口写入 HMDAO_POST_FSR_PATH；如果已有自定义包装命令，可改写 HMDAO_POST_FSR_COMMAND',
    successHint: '探测成功后，后期节点里的高清 Runtime 状态会显示对应 Wrapper 已配置，预览放大可优先走外部链路',
    commonInstallPaths: [],
    supportsImage: true,
    supportsVideo: true,
  },
  realbasicvsr: {
    runtimeName: 'RealBasicVSR Wrapper',
    envPath: 'HMDAO_POST_REALBASICVSR_PATH',
    envCommand: 'HMDAO_POST_REALBASICVSR_COMMAND',
    docsUrl: 'https://github.com/ckkelvinchan/RealBasicVSR',
    downloadUrl: '',
    installHint: '将 RealBasicVSR 的运行入口写入 HMDAO_POST_REALBASICVSR_PATH，或通过 HMDAO_POST_REALBASICVSR_COMMAND 指向你自己的封装命令',
    successHint: '探测成功后，视频高清增强会优先走 RealBasicVSR Wrapper，结果区会显示真实高清链路',
    commonInstallPaths: [],
    supportsImage: false,
    supportsVideo: true,
  },
  supir: {
    runtimeName: 'SUPIR Wrapper',
    envPath: 'HMDAO_POST_SUPIR_PATH',
    envCommand: 'HMDAO_POST_SUPIR_COMMAND',
    docsUrl: 'https://github.com/Fanghua-Yu/SUPIR',
    downloadUrl: '',
    installHint: '将 SUPIR 运行入口写入 HMDAO_POST_SUPIR_PATH，或改用 HMDAO_POST_SUPIR_COMMAND 挂自定义启动命令',
    successHint: '探测成功后，图片高清增强会优先走 SUPIR Wrapper，结果区会显示真实高清链路',
    commonInstallPaths: [],
    supportsImage: true,
    supportsVideo: false,
  },
};

const EXECUTABLE_DETECTION_CACHE = new Map();
const LOCAL_POST_RELEASE_CACHE = new Map();
const LOCAL_POST_RELEASE_TTL_MS = 1000 * 60 * 30;
const LOCAL_POST_MANAGED_RUNTIME_DIR = path.join(DATA_DIR, 'local-post-runtimes');
const LOCAL_POST_MANAGED_RUNTIME_DOWNLOAD_DIR = path.join(LOCAL_POST_MANAGED_RUNTIME_DIR, 'downloads');
const LOCAL_POST_MANAGED_RUNTIME_MANIFEST_FILE = path.join(LOCAL_POST_MANAGED_RUNTIME_DIR, 'manifest.json');
const LOCAL_POST_RUNTIME_INSTALL_JOBS = new Map();
const LOCAL_POST_RUNTIME_INSTALL_JOBS_BY_KEY = new Map();
const LOCAL_POST_RUNTIME_INSTALL_MAX_HISTORY = 18;

const LOCAL_POST_INSTALLABLE_RUNTIMES = {
  gmic: {
    runtimeKey: 'gmic',
    runtimeName: LOCAL_POST_RUNTIME_GUIDES.gmic.runtimeName,
    sourceLabel: 'gmic.eu',
  },
  oiio: {
    runtimeKey: 'oiio',
    runtimeName: LOCAL_POST_RUNTIME_GUIDES.oiio.runtimeName,
    sourceLabel: 'PyPI / OpenImageIO',
  },
  ocio: {
    runtimeKey: 'ocio',
    runtimeName: LOCAL_POST_RUNTIME_GUIDES.ocio.runtimeName,
    sourceLabel: 'PyPI / OpenColorIO',
  },
};
const LOCAL_POST_SELF_CHECK_TIMEOUT_MS = 12000;

function normalizeLocalAudioBackend(value) {
  const requested = String(value || 'fallback-local').trim().toLowerCase();
  return requested in LOCAL_AUDIO_BACKEND_META ? requested : 'fallback-local';
}

function resolveLocalAudioBackend(requestedBackend, mode) {
  const requested = normalizeLocalAudioBackend(requestedBackend);
  const requestedMeta = LOCAL_AUDIO_BACKEND_META[requested];
  if (!requestedMeta.supportedModes.includes(mode)) {
    return {
      requestedBackend: requested,
      backend: 'fallback-local',
      backendLabel: LOCAL_AUDIO_BACKEND_META['fallback-local'].label,
      backendAvailable: false,
      fallbackUsed: requested !== 'fallback-local',
      fallbackReason: 'mode-not-supported',
      commandLine: '',
      detectedPath: '',
    };
  }
  if (requested === 'fallback-local') {
    return {
      requestedBackend: requested,
      backend: requested,
      backendLabel: requestedMeta.label,
      backendAvailable: true,
      fallbackUsed: false,
      fallbackReason: '',
      commandLine: '',
      detectedPath: '',
    };
  }

  let commandLine = String(process.env[requestedMeta.envCommand] || '').trim();
  const detectedPath = String(process.env[requestedMeta.envPath] || '').trim();
  if (!commandLine && detectedPath && LOCAL_AUDIO_BACKEND_WRAPPERS[requested]) {
    commandLine = `node "${LOCAL_AUDIO_BACKEND_WRAPPERS[requested]}"`;
  }
  const backendAvailable = Boolean(commandLine);
  return {
    requestedBackend: requested,
    backend: backendAvailable ? requested : 'fallback-local',
    backendLabel: requestedMeta.label,
    backendAvailable,
    fallbackUsed: !backendAvailable,
    fallbackReason: backendAvailable ? '' : 'backend-not-configured',
    commandLine,
    detectedPath,
  };
}

async function runConfiguredLocalAudioBackend(resolvedBackend, payload) {
  if (!resolvedBackend.commandLine) return null;
  const requestId = crypto.randomUUID();
  const requestPayload = {
    requestId,
    mode: payload.mode,
    prompt: payload.prompt,
    duration: payload.duration,
    intensity: payload.intensity,
    voicePreset: payload.voicePreset,
    speechRate: payload.speechRate,
    language: payload.language,
    outputDir: LOCAL_AUDIO_EDIT_DIR,
  };
  const { stdout } = await runShellCommandWithInput(
    resolvedBackend.commandLine,
    JSON.stringify(requestPayload),
    APP_DIR,
  );
  const parsed = JSON.parse(String(stdout || '{}'));
  const outputPath = String(parsed.outputPath || '').trim();
  const outputBase64 = String(parsed.outputBase64 || '').trim();
  const mimeType = String(parsed.mimeType || 'audio/wav');
  const format = String(parsed.format || audioExtensionFromMimeType(mimeType));
  let persisted = null;
  let meta = {
    duration: Math.max(0, Number(parsed.duration || 0)),
    sampleRate: Math.max(0, Number(parsed.sampleRate || 0)),
    channels: Math.max(0, Number(parsed.channels || 0)),
  };

  if (outputPath) {
    meta = await probeAudioFile(outputPath);
    persisted = await persistLocalBufferResult(LOCAL_AUDIO_RESULT_DIR, outputPath, requestId, format);
  } else if (outputBase64) {
    persisted = await persistLocalBufferResult(LOCAL_AUDIO_RESULT_DIR, Buffer.from(outputBase64, 'base64'), requestId, format);
  }

  if (!persisted?.persistedPath) {
    throw new Error(`local-audio-backend-empty:${resolvedBackend.requestedBackend}`);
  }
  const stat = await fs.stat(persisted.persistedPath);

  return {
    mode: payload.mode,
    engine: String(parsed.engine || resolvedBackend.requestedBackend),
    voiceName: String(parsed.voiceName || ''),
    format,
    mimeType,
    outputAssetId: persisted.assetId,
    outputUrl: `/api/local-audio/result/${encodeURIComponent(persisted.assetId)}`,
    size: Number(stat.size || 0),
    duration: meta.duration,
    sampleRate: meta.sampleRate || 44100,
    channels: meta.channels || 2,
    requestedBackend: resolvedBackend.requestedBackend,
    backend: resolvedBackend.requestedBackend,
    backendLabel: resolvedBackend.backendLabel,
    backendAvailable: true,
    fallbackUsed: false,
    fallbackReason: '',
  };
}

function generateProceduralBgmBuffer(prompt, duration, intensity = 0.6) {
  const sampleRate = 44100;
  const seconds = clampNumber(duration, 2, 30, 8);
  const totalFrames = Math.max(1, Math.round(seconds * sampleRate));
  const left = new Float32Array(totalFrames);
  const right = new Float32Array(totalFrames);
  const hash = hashString(prompt);
  const rootPool = [110, 123.47, 130.81, 146.83, 164.81, 174.61, 196, 220];
  const root = rootPool[hash % rootPool.length];
  const moodMinor = /夜|暗|悬|雨|压迫|myst|dark|suspense|noir/i.test(prompt);
  const intervals = moodMinor ? [1, 1.2, 1.5, 1.8] : [1, 1.25, 1.5, 2];
  const barDuration = 1.6;
  const padGain = 0.08 + intensity * 0.06;
  const pulseGain = 0.035 + intensity * 0.05;
  const noiseGain = 0.004 + intensity * 0.01;

  for (let frame = 0; frame < totalFrames; frame += 1) {
    const time = frame / sampleRate;
    const barIndex = Math.floor(time / barDuration);
    const chordIndex = barIndex % intervals.length;
    const base = root * intervals[chordIndex];
    const swell = 0.58 + 0.42 * Math.sin((Math.PI * 2 * time) / barDuration - Math.PI / 2);
    const pulse = Math.max(0, Math.sin((Math.PI * 2 * time) / (barDuration / 2)));
    const detune = 1 + (((hash >> (barIndex % 8)) & 3) - 1.5) * 0.0025;
    const pad =
      Math.sin(Math.PI * 2 * base * detune * time) * 0.55 +
      Math.sin(Math.PI * 2 * base * 0.5 * time + 0.6) * 0.3 +
      Math.sin(Math.PI * 2 * base * 1.5 * time + 1.2) * 0.15;
    const sparkle = Math.sin(Math.PI * 2 * (base * 2.01) * time + 0.5) * pulse;
    const noise = (Math.sin(Math.PI * 2 * 53 * time + hash * 0.0001) + Math.sin(Math.PI * 2 * 97 * time)) * 0.5;
    const mono = pad * swell * padGain + sparkle * pulseGain + noise * noiseGain;
    left[frame] = mono * 0.96;
    right[frame] = mono * 0.9 + Math.sin(Math.PI * 2 * (base * 0.25) * time) * 0.01;
  }

  return {
    buffer: floatSamplesToWavBuffer([left, right], sampleRate),
    sampleRate,
    channels: 2,
    duration: seconds,
    engine: 'procedural-bgm-synth',
  };
}

function generateProceduralSfxBuffer(prompt, duration, intensity = 0.65) {
  const sampleRate = 44100;
  const seconds = clampNumber(duration, 0.4, 8, 2.4);
  const totalFrames = Math.max(1, Math.round(seconds * sampleRate));
  const left = new Float32Array(totalFrames);
  const right = new Float32Array(totalFrames);
  const normalized = String(prompt || '').toLowerCase();
  const hash = hashString(prompt);
  const kind = /爆|炸|impact|hit|boom|thump/i.test(normalized)
    ? 'impact'
    : /呼|风|whoosh|sweep|swish/i.test(normalized)
      ? 'whoosh'
      : /激光|电|laser|zap|sci/i.test(normalized)
        ? 'laser'
        : /滴|点|click|ui|通知|beep/i.test(normalized)
          ? 'ui'
          : 'rise';

  for (let frame = 0; frame < totalFrames; frame += 1) {
    const time = frame / sampleRate;
    const progress = time / seconds;
    const seedNoise = Math.sin(Math.PI * 2 * (37 + (hash % 19)) * time) + Math.sin(Math.PI * 2 * (81 + (hash % 13)) * time);
    let mono = 0;

    if (kind === 'impact') {
      const envelope = Math.exp(-6.5 * progress);
      const body = Math.sin(Math.PI * 2 * 68 * time) * envelope;
      const crunch = seedNoise * 0.08 * envelope;
      mono = body * 0.7 + crunch;
    } else if (kind === 'whoosh') {
      const sweep = 280 + progress * 1600;
      const envelope = Math.sin(Math.PI * progress);
      mono = Math.sin(Math.PI * 2 * sweep * time) * 0.12 * envelope + seedNoise * 0.03 * envelope;
    } else if (kind === 'laser') {
      const sweep = 980 - progress * 720;
      const envelope = Math.exp(-3.8 * progress);
      mono = Math.sin(Math.PI * 2 * sweep * time) * 0.16 * envelope + Math.sin(Math.PI * 2 * sweep * 0.5 * time) * 0.06 * envelope;
    } else if (kind === 'ui') {
      const envelope = Math.exp(-10 * progress);
      mono = Math.sin(Math.PI * 2 * 880 * time) * 0.16 * envelope + Math.sin(Math.PI * 2 * 1320 * time) * 0.08 * envelope;
    } else {
      const envelope = Math.sin(Math.PI * progress) ** 1.5;
      const sweep = 220 + progress * 540;
      mono = Math.sin(Math.PI * 2 * sweep * time) * 0.15 * envelope + seedNoise * 0.02 * envelope;
    }

    const stereoDrift = Math.sin(Math.PI * 2 * 0.4 * time) * 0.08;
    left[frame] = mono * (0.82 + stereoDrift) * (0.7 + intensity * 0.5);
    right[frame] = mono * (0.82 - stereoDrift) * (0.7 + intensity * 0.5);
  }

  return {
    buffer: floatSamplesToWavBuffer([left, right], sampleRate),
    sampleRate,
    channels: 2,
    duration: seconds,
    engine: `procedural-sfx-${kind}`,
  };
}

function generateProceduralVoiceoverBuffer(prompt, duration, speechRate = 0) {
  const sampleRate = 22050;
  const normalized = String(prompt || '').trim();
  const glyphs = Array.from(normalized.replace(/\s+/g, '')).slice(0, 160);
  const tokenCount = Math.max(glyphs.length, 1);
  const speakingRate = Math.max(0.7, Math.min(1.5, 1 + (clampNumber(speechRate, -6, 6, 0) * 0.08)));
  const seconds = Math.max(1, Math.min(20, Number(duration || 0) || Math.max(3, tokenCount / 3.2 / speakingRate)));
  const totalFrames = Math.max(1, Math.floor(sampleRate * seconds));
  const mono = new Float32Array(totalFrames);
  const segmentDuration = seconds / tokenCount;

  for (let tokenIndex = 0; tokenIndex < tokenCount; tokenIndex += 1) {
    const glyph = glyphs[tokenIndex] || normalized[tokenIndex] || 'A';
    const code = glyph.codePointAt(0) || 65;
    const startTime = tokenIndex * segmentDuration;
    const voicedDuration = Math.max(0.06, segmentDuration * 0.82);
    const endTime = Math.min(seconds, startTime + voicedDuration);
    const startFrame = Math.max(0, Math.floor(startTime * sampleRate));
    const endFrame = Math.min(totalFrames, Math.ceil(endTime * sampleRate));
    const contour = Math.sin((tokenIndex / Math.max(tokenCount - 1, 1)) * Math.PI);
    const baseFreq = 155 + (code % 9) * 12 + contour * 28;

    for (let frame = startFrame; frame < endFrame; frame += 1) {
      const time = frame / sampleRate;
      const local = time - startTime;
      const voicedProgress = local / Math.max(voicedDuration, 1e-3);
      const attack = Math.min(1, voicedProgress / 0.12);
      const release = Math.min(1, (1 - voicedProgress) / 0.18);
      const envelope = Math.max(0, Math.min(attack, release)) ** 0.72;
      const vibrato = 1 + Math.sin(Math.PI * 2 * (4.2 + (code % 3) * 0.6) * local) * 0.014;
      const freq = baseFreq * vibrato;
      const harmonicA = Math.sin(Math.PI * 2 * freq * local);
      const harmonicB = Math.sin(Math.PI * 2 * freq * 2.08 * local) * 0.42;
      const harmonicC = Math.sin(Math.PI * 2 * freq * 3.14 * local) * 0.18;
      const aspiration = (Math.sin(Math.PI * 2 * (800 + (code % 11) * 55) * local) * 0.015) + (Math.sin(Math.PI * 2 * 1200 * local) * 0.008);
      mono[frame] += (harmonicA * 0.78 + harmonicB + harmonicC + aspiration) * envelope * 0.22;
    }
  }

  return {
    buffer: floatSamplesToWavBuffer([mono], sampleRate),
    sampleRate,
    channels: 1,
    duration: seconds,
    engine: 'procedural-voiceover-fallback',
  };
}

async function synthesizeNarrationToFile({ outputPath, text, voicePreset = 'narrator', speechRate = 0 }) {
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    `$voicePreset = '${escapePowerShellSingleQuoted(voicePreset)}'`,
    '$voices = $speaker.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }',
    '$selected = $null',
    'if ($voicePreset -eq "female" -or $voicePreset -eq "gentle" -or $voicePreset -eq "calm") { $selected = $voices | Where-Object { $_ -match "Female|女|Xiaoxiao|Huihui|Zira|Jenny" } | Select-Object -First 1 }',
    'elseif ($voicePreset -eq "male" -or $voicePreset -eq "documentary") { $selected = $voices | Where-Object { $_ -match "Male|男|Yunxi|David|Mark|Haohao" } | Select-Object -First 1 }',
    'elseif ($voicePreset -eq "warm" -or $voicePreset -eq "friendly") { $selected = $voices | Where-Object { $_ -match "Huihui|Zira|Hazel|Jenny|Xiaoyi" } | Select-Object -First 1 }',
    'elseif ($voicePreset -eq "energetic" -or $voicePreset -eq "commercial") { $selected = $voices | Where-Object { $_ -match "David|Mark|Yunxi|Xiaoxiao|Zira" } | Select-Object -First 1 }',
    'else { $selected = $voices | Select-Object -First 1 }',
    'if ($selected) { $speaker.SelectVoice($selected) }',
    `$speaker.Rate = ${Math.round(clampNumber(speechRate, -6, 6, 0))}`,
    '$speaker.Volume = 100',
    `$speaker.SetOutputToWaveFile('${escapePowerShellSingleQuoted(outputPath)}')`,
    `$speaker.Speak('${escapePowerShellSingleQuoted(text)}')`,
    '$voiceName = if ($selected) { $selected } else { "" }',
    '$speaker.Dispose()',
    'Write-Output $voiceName',
  ].join('; ');

  const { stdout } = await runCommand('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
  return String(stdout || '').trim();
}

async function processLocalAudioGenerateRequest(payload) {
  const mode = String(payload?.mode || '').trim().toLowerCase();
  if (!['bgm', 'sfx', 'voiceover'].includes(mode)) {
    throw new Error(`unsupported-local-audio-mode:${mode || 'unknown'}`);
  }

  const prompt = String(payload?.prompt || '').trim();
  if (!prompt) {
    throw new Error('local-audio-prompt-missing');
  }

  const duration = clampNumber(payload?.duration, mode === 'voiceover' ? 1 : 0.4, 30, mode === 'voiceover' ? 8 : 6);
  const intensity = clampNumber(payload?.intensity, 0, 1, 0.6);
  const speechRate = clampNumber(payload?.speechRate, -6, 6, 0);
  const resolvedBackend = resolveLocalAudioBackend(payload?.backend, mode);

  if (resolvedBackend.backend !== 'fallback-local' && resolvedBackend.commandLine) {
    try {
      await fs.mkdir(LOCAL_AUDIO_EDIT_DIR, { recursive: true });
      return await runConfiguredLocalAudioBackend(resolvedBackend, {
        mode,
        prompt,
        duration,
        intensity,
        voicePreset: String(payload?.voicePreset || 'narrator'),
        speechRate,
        language: String(payload?.language || ''),
      });
    } catch (error) {
      resolvedBackend.backend = 'fallback-local';
      resolvedBackend.fallbackUsed = true;
      resolvedBackend.fallbackReason = error instanceof Error ? error.message : 'backend-exec-failed';
      resolvedBackend.backendAvailable = false;
    }
  }

  if (mode === 'voiceover') {
    await fs.mkdir(LOCAL_AUDIO_EDIT_DIR, { recursive: true });
    const requestId = crypto.randomUUID();
    const outputPath = path.join(LOCAL_AUDIO_EDIT_DIR, `${requestId}-voice.wav`);
    try {
      const voiceName = await synthesizeNarrationToFile({
        outputPath,
        text: prompt,
        voicePreset: String(payload?.voicePreset || 'narrator'),
        speechRate,
      });
      const meta = await probeAudioFile(outputPath);
      const persisted = await persistLocalBufferResult(LOCAL_AUDIO_RESULT_DIR, outputPath, requestId, 'wav');
      const stat = await fs.stat(persisted.persistedPath);
      const hasUsableNarration = Number(stat.size || 0) > 1024 && Number(meta.duration || 0) > 0.2;
      if (!hasUsableNarration) {
        const generated = generateProceduralVoiceoverBuffer(prompt, duration, speechRate);
        const fallbackPersisted = await persistLocalBufferResult(LOCAL_AUDIO_RESULT_DIR, generated.buffer, requestId, 'wav');
        const fallbackStat = await fs.stat(fallbackPersisted.persistedPath);
        return {
          mode,
          engine: generated.engine,
          voiceName,
          format: 'wav',
          mimeType: 'audio/wav',
          outputAssetId: fallbackPersisted.assetId,
          outputUrl: `/api/local-audio/result/${encodeURIComponent(fallbackPersisted.assetId)}`,
          size: Number(fallbackStat.size || 0),
          duration: generated.duration,
          sampleRate: generated.sampleRate,
          channels: generated.channels,
          requestedBackend: resolvedBackend.requestedBackend,
          backend: 'fallback-local',
          backendLabel: LOCAL_AUDIO_BACKEND_META[resolvedBackend.requestedBackend]?.label || LOCAL_AUDIO_BACKEND_META['fallback-local'].label,
          backendAvailable: resolvedBackend.requestedBackend === 'fallback-local',
          fallbackUsed: true,
          fallbackReason: 'voice-sapi-empty-output',
        };
      }
      return {
        mode,
        engine: 'windows-sapi',
        voiceName,
        format: 'wav',
        mimeType: 'audio/wav',
        outputAssetId: persisted.assetId,
        outputUrl: `/api/local-audio/result/${encodeURIComponent(persisted.assetId)}`,
        size: Number(stat.size || 0),
        duration: meta.duration,
        sampleRate: meta.sampleRate,
        channels: meta.channels,
        requestedBackend: resolvedBackend.requestedBackend,
        backend: 'fallback-local',
        backendLabel: LOCAL_AUDIO_BACKEND_META[resolvedBackend.requestedBackend]?.label || LOCAL_AUDIO_BACKEND_META['fallback-local'].label,
        backendAvailable: resolvedBackend.requestedBackend === 'fallback-local',
        fallbackUsed: resolvedBackend.requestedBackend !== 'fallback-local',
        fallbackReason: resolvedBackend.fallbackReason || (resolvedBackend.requestedBackend === 'fallback-local' ? '' : 'backend-not-configured'),
      };
    } finally {
      await fs.rm(outputPath, { force: true }).catch(() => {});
    }
  }

  const generated = mode === 'sfx'
    ? generateProceduralSfxBuffer(prompt, duration, intensity)
    : generateProceduralBgmBuffer(prompt, duration, intensity);
  const requestId = crypto.randomUUID();
  const persisted = await persistLocalBufferResult(LOCAL_AUDIO_RESULT_DIR, generated.buffer, requestId, 'wav');
  const stat = await fs.stat(persisted.persistedPath);

  return {
    mode,
    engine: generated.engine,
    format: 'wav',
    mimeType: 'audio/wav',
    outputAssetId: persisted.assetId,
    outputUrl: `/api/local-audio/result/${encodeURIComponent(persisted.assetId)}`,
    size: Number(stat.size || 0),
    duration: generated.duration,
    sampleRate: generated.sampleRate,
    channels: generated.channels,
    requestedBackend: resolvedBackend.requestedBackend,
    backend: 'fallback-local',
    backendLabel: LOCAL_AUDIO_BACKEND_META[resolvedBackend.requestedBackend]?.label || LOCAL_AUDIO_BACKEND_META['fallback-local'].label,
    backendAvailable: resolvedBackend.requestedBackend === 'fallback-local',
    fallbackUsed: resolvedBackend.requestedBackend !== 'fallback-local',
    fallbackReason: resolvedBackend.fallbackReason || (resolvedBackend.requestedBackend === 'fallback-local' ? '' : 'backend-not-configured'),
  };
}

async function probeAudioFile(filePath) {
  const { stdout } = await runCommand('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'a:0',
    '-show_entries',
    'stream=sample_rate,channels:format=duration',
    '-of',
    'json',
    filePath,
  ]);
  const parsed = JSON.parse(stdout || '{}');
  return {
    duration: Math.max(0, Number(parsed?.format?.duration || 0)),
    sampleRate: Math.max(0, Number(parsed?.streams?.[0]?.sample_rate || 0)),
    channels: Math.max(0, Number(parsed?.streams?.[0]?.channels || 0)),
  };
}

async function createSilentAudioFile(filePath, durationSeconds, {
  sampleRate = 48000,
  channels = 2,
} = {}) {
  const safeDuration = Math.max(0.1, Number.isFinite(durationSeconds) ? Number(durationSeconds) : 0.1);
  const channelLayout = channels === 1 ? 'mono' : 'stereo';
  await runCommand('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `anullsrc=channel_layout=${channelLayout}:sample_rate=${sampleRate}`,
    '-t',
    safeDuration.toFixed(3),
    '-acodec',
    'pcm_s16le',
    filePath,
  ]);
}

async function downloadOrWriteAudioInput(requestId, payload) {
  const inputBase64 = String(payload?.linkedAudioBase64 || '').trim();
  const sourceUrl = String(payload?.linkedAudioSourceUrl || '').trim();
  if (!inputBase64 && !/^https?:\/\//i.test(sourceUrl)) return null;
  const mimeType = String(payload?.linkedAudioMimeType || 'audio/wav').trim() || 'audio/wav';
  const inputExt = audioExtensionFromMimeType(mimeType);
  const inputPath = path.join(LOCAL_VIDEO_EDIT_DIR, `${requestId}-linked-audio.${inputExt}`);
  if (inputBase64) {
    await fs.writeFile(inputPath, Buffer.from(inputBase64, 'base64'));
  } else {
    const remote = await downloadRemoteMediaBuffer(sourceUrl);
    await fs.writeFile(inputPath, remote.bytes);
  }
  return inputPath;
}

async function mixExternalAudioIntoVideo({
  videoPath,
  audioPath,
  outputPath,
  mixMode = 'bgm-under',
  audioGain = 1,
  videoGain = 1,
}) {
  const normalizedMixMode = ['replace', 'bgm-under', 'voiceover-dub'].includes(String(mixMode || ''))
    ? String(mixMode)
    : 'bgm-under';
  const safeAudioGain = clampNumber(audioGain, 0, 2, 1);
  const safeVideoGain = clampNumber(videoGain, 0, 2, normalizedMixMode === 'voiceover-dub' ? 0.3 : 0.74);
  const streams = await probeMediaStreams(videoPath);

  if (!streams.hasAudio || normalizedMixMode === 'replace') {
    await runCommand('ffmpeg', [
      '-y',
      '-i',
      videoPath,
      '-i',
      audioPath,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c:v',
      'copy',
      '-c:a',
      'libopus',
      '-b:a',
      '128k',
      '-shortest',
      outputPath,
    ]);
    return `external-audio:${normalizedMixMode}`;
  }

  await runCommand('ffmpeg', [
    '-y',
    '-i',
    videoPath,
    '-i',
    audioPath,
    '-filter_complex',
    `[0:a]volume=${safeVideoGain}[va];[1:a]volume=${safeAudioGain}[ea];[va][ea]amix=inputs=2:duration=first:normalize=0[aout]`,
    '-map',
    '0:v:0',
    '-map',
    '[aout]',
    '-c:v',
    'copy',
    '-c:a',
    'libopus',
    '-b:a',
    '128k',
    '-shortest',
    outputPath,
  ]);
  return `external-audio:${normalizedMixMode}`;
}

function localVideoEditStatusCode(message) {
  const normalized = String(message || '').toLowerCase();
  if (
    normalized.includes('unsupported-local-video-operation')
    || normalized.includes('local-video-input-missing')
    || normalized.includes('local-video-source-metadata-missing')
    || normalized.includes('local-video-clip-segments-empty')
    || normalized.includes('local-video-linked-audio-missing')
  ) {
    return 400;
  }
  if (normalized.includes('local-video-audio-track-missing')) {
    return 422;
  }
  return 500;
}

async function runLocalParseAnalysis(inputPath, sampleFps, options = {}) {
  return await runJsonPythonScript(LOCAL_VIDEO_PARSE_SCRIPT, [
    '--input',
    inputPath,
    '--sample-fps',
    String(sampleFps),
    '--scene-threshold',
    '24',
    '--max-scenes',
    '12',
    '--scene-engine',
    String(options.sceneEngine || 'auto'),
    '--semantic-engine',
    String(options.semanticEngine || 'auto'),
  ]);
}

function shouldEnhanceVideoParseWithImageInterrogation(requestedSemanticEngine) {
  const requested = String(requestedSemanticEngine || 'auto').trim().toLowerCase();
  if (['clip-interrogator', 'prompt-fusion', 'qwen25-vl', 'qwen35-vl', 'florence2'].includes(requested)) return true;
  if (requested === 'auto') {
    return resolveImageAnalysisRuntime('auto').mode !== 'fallback';
  }
  return false;
}

function buildEnhancedVideoParseSummary(summary, rows, engineLabel) {
  const subjects = uniqueStrings(rows.map((row) => String(row?.subjectSummary || row?.subjectTraits || '')).filter(Boolean)).slice(0, 3);
  const styles = uniqueStrings(rows.map((row) => String(row?.styleDescription || '')).filter(Boolean)).slice(0, 3);
  const settings = uniqueStrings(rows.map((row) => String(row?.sceneSetting || '')).filter(Boolean)).slice(0, 3);
  const base = String(summary || '').trim();
  return [
    base,
    subjects.length ? 'Subjects: ' + subjects.join(' / ') : '',
    settings.length ? 'Settings: ' + settings.join(' / ') : '',
    styles.length ? 'Styles: ' + styles.join(' / ') : '',
    'Semantic enhancement engine: ' + engineLabel,
  ].filter(Boolean).join(' ');
}

async function enhanceVideoParseWithImageAnalysis(summary, options = {}) {
  const rows = Array.isArray(summary?.parseRows) ? summary.parseRows : [];
  if (!rows.length) return summary;
  const runtime = resolveImageAnalysisRuntime(String(options.semanticEngine || 'clip-interrogator'));
  if (!runtime.commandLine) return summary;

  const enhancedRows = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] && typeof rows[index] === 'object' ? rows[index] : {};
    const base64 = String(row.keyframeImageBase64 || '').trim();
    if (!base64) {
      enhancedRows.push(row);
      continue;
    }
    const mimeType = String(row.keyframeMimeType || 'image/jpeg').trim() || 'image/jpeg';
    const ext = imageExtensionFromMimeType(mimeType);
    const framePath = path.join(LOCAL_IMAGE_ANALYSIS_DIR, `${crypto.randomUUID()}-video-keyframe.${ext}`);
    try {
      await fs.mkdir(LOCAL_IMAGE_ANALYSIS_DIR, { recursive: true });
      await fs.writeFile(framePath, Buffer.from(base64, 'base64'));
      const imageAnalysis = await processLocalImageAnalyzeRequest({
        name: `video-shot-${index + 1}.${ext}`,
        inputPath: framePath,
        inputMimeType: mimeType,
        width: Number(row.keyframeWidth || summary.width || 0) || 0,
        height: Number(row.keyframeHeight || summary.height || 0) || 0,
        sourceUrl: '',
        tags: Array.isArray(row.visualKeywords) ? row.visualKeywords : [],
        smartCategories: [],
        engine: runtime.resolved,
      });
      enhancedRows.push({
        ...row,
        frameDescription: [
          String(imageAnalysis.subject || ''),
          String(imageAnalysis.scene || ''),
          String(imageAnalysis.style || ''),
          String(imageAnalysis.lighting || ''),
          String(row.frameDescription || ''),
        ].filter(Boolean).join(' '),
        imagePrompt: String(imageAnalysis.promptZh || row.imagePrompt || ''),
        keyframePrompt: String(imageAnalysis.promptZh || row.keyframePrompt || ''),
        styleDescription: String(imageAnalysis.style || row.styleDescription || ''),
        lighting: String(imageAnalysis.lighting || row.lighting || ''),
        lightingMood: String(imageAnalysis.lighting || row.lightingMood || ''),
        sceneSetting: String(imageAnalysis.scene || row.sceneSetting || ''),
        subjectSummary: String(imageAnalysis.subject || row.subjectSummary || ''),
        subjectTraits: String(imageAnalysis.summary || row.subjectTraits || ''),
        colorPalette: Array.isArray(imageAnalysis.palette) && imageAnalysis.palette.length ? imageAnalysis.palette : row.colorPalette,
        visualKeywords: uniqueStrings([
          ...(Array.isArray(row.visualKeywords) ? row.visualKeywords : []),
          ...(Array.isArray(imageAnalysis.keywords) ? imageAnalysis.keywords : []),
        ]).slice(0, 12),
      });
    } catch {
      enhancedRows.push(row);
    } finally {
      await fs.rm(framePath, { force: true }).catch(() => {});
    }
  }

  const engineLabel = `keyframe-image-analysis:${runtime.resolved}`;
  return {
    ...summary,
    parseRows: enhancedRows,
    suggestedShots: enhancedRows.map((row, index) => ({
      id: String(row.id || `shot-${index + 1}`),
      time: Number(row.keyframeTime || row.time || 0),
      label: `镜头 ${Number(row.shotNumber || index + 1)}`,
      shotSize: String(row.sceneType || row.shotSize || ''),
      cameraPrompt: String(row.cameraPrompt || ''),
      imagePrompt: String(row.imagePrompt || ''),
      keyframePrompt: String(row.keyframePrompt || ''),
    })),
    summary: buildEnhancedVideoParseSummary(summary?.summary, enhancedRows, engineLabel),
    analysisEngine: `${String(summary?.analysisEngine || '')}|semantic-upgrade:${runtime.resolved}`,
  };
}

async function runLocalSubtitleRemoval({
  inputPath,
  tempOutputPath,
  detectionMode,
  manualX,
  manualY,
  manualWidth,
  manualHeight,
  feather,
}) {
  await runPreferredLocalPython({
    scriptPath: LOCAL_VIDEO_REMOVE_SUBTITLE_SCRIPT,
    timeoutMs: Number(process.env.HMDAO_LOCAL_SUBTITLE_TIMEOUT_MS || 20000),
    args: [
      '--input',
      inputPath,
      '--output',
      tempOutputPath,
      '--mode',
      detectionMode,
      '--x',
      String(manualX),
      '--y',
      String(manualY),
      '--width',
      String(manualWidth),
      '--height',
      String(manualHeight),
      '--feather',
      String(feather),
    ],
  });
}

async function runDemucsAudioSplit({
  inputPath,
  requestId,
  outputPath,
  audioOutputPath,
  vocalOutputPath,
  accompanimentOutputPath,
  keepAudioInVideo,
}) {
  const demucsInputPath = path.join(LOCAL_VIDEO_EDIT_DIR, `${requestId}-demucs-input.wav`);
  const demucsOutputDir = path.join(LOCAL_VIDEO_EDIT_DIR, `${requestId}-demucs`);
  await fs.rm(demucsOutputDir, { recursive: true, force: true }).catch(() => {});
  await runCommand('ffmpeg', [
    '-y',
    '-i',
    inputPath,
    '-vn',
    '-ac',
    '2',
    '-ar',
    '44100',
    demucsInputPath,
  ]);
  await runPreferredLocalPython({
    scriptPath: null,
    args: [
      '-m',
      'demucs.separate',
      '-n',
      'htdemucs',
      '--two-stems',
      'vocals',
      '-o',
      demucsOutputDir,
      demucsInputPath,
    ],
  });
  const demucsBaseName = path.parse(demucsInputPath).name;
  const demucsStemDir = path.join(demucsOutputDir, 'htdemucs', demucsBaseName);
  const vocalWavPath = path.join(demucsStemDir, 'vocals.wav');
  const accompanimentWavPath = path.join(demucsStemDir, 'no_vocals.wav');
  await Promise.all([
    runCommand('ffmpeg', ['-y', '-i', demucsInputPath, '-acodec', 'pcm_s16le', audioOutputPath]),
    runCommand('ffmpeg', ['-y', '-i', vocalWavPath, '-acodec', 'pcm_s16le', vocalOutputPath]),
    runCommand('ffmpeg', ['-y', '-i', accompanimentWavPath, '-acodec', 'pcm_s16le', accompanimentOutputPath]),
  ]);
  await runCommand('ffmpeg', [
    '-y',
    '-i',
    inputPath,
    ...(keepAudioInVideo ? ['-i', vocalOutputPath] : []),
    ...(keepAudioInVideo ? ['-map', '0:v:0', '-map', '1:a:0'] : []),
    ...(keepAudioInVideo ? [] : ['-an']),
    ...buildWebmEncodeArgs(outputPath, { includeAudio: keepAudioInVideo }),
  ]);
  return {
    engine: 'demucs-v4',
    source: 'local-demucs',
  };
}

async function detectSceneCuts(filePath, threshold = 0.24, maxCount = 10) {
  try {
    const { stderr } = await runCommand('ffmpeg', [
      '-hide_banner',
      '-i',
      filePath,
      '-filter:v',
      `select='gt(scene,${threshold})',showinfo`,
      '-vsync',
      'vfr',
      '-f',
      'null',
      '-',
    ]);
    const matches = [...String(stderr || '').matchAll(/pts_time:([0-9.]+)/g)];
    const values = matches
      .map((match) => Number(match[1]))
      .filter((value) => Number.isFinite(value) && value >= 0);
    return [...new Set(values.map((value) => Number(value.toFixed(3))))].slice(0, maxCount);
  } catch {
    return [];
  }
}

function buildParseSummary(sceneCuts, meta, sampleFps) {
  const sceneCount = sceneCuts.length + 1;
  const summaryParts = [
    `分辨率${meta.width}x${meta.height}`,
    `时长 ${meta.duration.toFixed(2)}s`,
    `抽样 ${sampleFps}fps`,
    sceneCuts.length > 0 ? 'Detected ' + sceneCuts.length + ' cut point(s)' : 'No obvious cut points detected',
  ];
  const breakpoints = [0, ...sceneCuts.filter((item) => item > 0 && item < meta.duration), meta.duration]
    .sort((left, right) => left - right)
    .filter((item, index, list) => index === 0 || Math.abs(item - list[index - 1]) > 0.02);
  const shotSizePool = ['特写', '近景', '中景', '全景', '大全景'];
  const anglePool = ['平视', '低机位', '俯视', '三分之二侧面', '肩后视角'];
  const movementPool = ['固定镜头', '缓慢推近', '轻微横移', '环绕主体', '跟随推进'];
  const focusPool = ['浅景深', '中景深', '深景深'];
  const lightingPool = ['柔和主光 + 辅光补面', '高对比侧光塑造', '冷暖混合氛围光', '轮廓逆光强化主体', '均匀漫反射商业布光'];
  const beatPool = ['建立主体与空间关系', '承接上一镜并推进动作', '强化情绪与视觉节奏', '突出关键信息与主体变化', '完成段落收束与记忆点'];
  const soundPool = ['环境底噪 + 氛围音乐铺垫', '动作节奏+ 轻微环境音', '空间混响 + 情绪音乐推进', '镜头转场音效 + 主体 Foley', '收束音效 + 背景音乐尾音'];
  const parseRows = [];
  for (let index = 0; index < Math.max(1, breakpoints.length - 1); index += 1) {
    const startTime = Number(breakpoints[index].toFixed(3));
    const endTime = Number(Math.max(startTime + 0.08, breakpoints[index + 1] ?? meta.duration).toFixed(3));
    const duration = Number(Math.max(0.08, endTime - startTime).toFixed(3));
    const shotSize = shotSizePool[index % shotSizePool.length];
    const cameraAngle = anglePool[index % anglePool.length];
    const cameraMovement = movementPool[index % movementPool.length];
    const focusDepth = focusPool[index % focusPool.length];
    const lighting = lightingPool[index % lightingPool.length];
    const narrativeBeat = beatPool[index % beatPool.length];
    const soundDesign = soundPool[index % soundPool.length];
    const keyframeTime = Number((startTime + duration * 0.5).toFixed(3));
    const frameDescription = 'Shot ' + (index + 1) + ': keep the current subject and composition relationship stable while carrying the action and spatial perspective forward.';
    const cameraPrompt = cameraMovement + ', ' + cameraAngle + ', ' + shotSize + ', keep the subject motion direction and original framing stable.';
    const imagePrompt = 'Keep the original composition stable, ' + shotSize + ', ' + cameraAngle + ', ' + focusDepth + ', ' + lighting + ', with clear background depth.';
    const keyframePrompt = 'Keyframe ' + (index + 1) + ': preserve pose and center of interest, strengthen ' + lighting + ' and ' + cameraMovement + ' cues for downstream generation.';
    parseRows.push({
      id: `shot-${index + 1}`,
      shotNumber: index + 1,
      startTime,
      endTime,
      duration,
      frameDescription,
      narrativeBeat,
      sceneType: shotSize,
      cameraAngle,
      cameraMovement,
      focusDepth,
      lighting,
      soundDesign,
      cameraPrompt,
      imagePrompt,
      keyframePrompt,
      keyframeTime,
      visualKeywords: [shotSize, cameraAngle, cameraMovement, focusDepth, lighting],
    });
  }
  return {
    sceneCount,
    sceneCuts,
    sampleFps,
    summary: summaryParts.join(' | '),
    suggestedShots: parseRows.map((row) => ({
      id: row.id,
      time: row.keyframeTime,
      label: `镜头 ${row.shotNumber}`,
      shotSize: row.sceneType,
      cameraPrompt: row.cameraPrompt,
      imagePrompt: row.imagePrompt,
      keyframePrompt: row.keyframePrompt,
    })),
    parseRows,
  };
}

function postTempPath(baseDir, requestId, stepIndex, mediaKind) {
  return path.join(baseDir, `${requestId}-step-${stepIndex}.${mediaKind === 'video' ? 'webm' : 'png'}`);
}

function escapeFfmpegFilterPath(filePath) {
  return String(filePath || '')
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'");
}

function isSupportedLutFile(filePath) {
  return /\.(cube|3dl)$/i.test(String(filePath || '').trim());
}

function isSupportedOcioConfigFile(filePath) {
  return /\.(ocio|yaml|yml|json|cfg|txt)$/i.test(String(filePath || '').trim());
}

async function inspectOcioConfigFile(filePath) {
  const normalizedPath = String(filePath || '').trim();
  if (!normalizedPath) {
    return {
      structurallyValid: false,
      executable: false,
      profileVersion: '',
      detectedSections: [],
      formatLabel: 'OCIO Config',
      message: '未提供可读的 OCIO Config 路径',
    };
  }
  const ext = path.extname(normalizedPath).toLowerCase();
  const formatLabel = ext === '.json'
    ? 'JSON Config'
    : ext === '.yaml' || ext === '.yml'
      ? 'YAML Config'
      : ext === '.cfg' || ext === '.txt'
        ? '文本 Config'
        : 'OCIO Config';
  let text = '';
  try {
    text = await fs.readFile(normalizedPath, 'utf8');
  } catch (error) {
    return {
      structurallyValid: false,
      executable: false,
      profileVersion: '',
      detectedSections: [],
      formatLabel,
      message: `读取 OCIO Config 失败{error instanceof Error ? error.message : 'unknown-read-error'}`,
    };
  }
  if (!text.trim()) {
    return {
      structurallyValid: false,
      executable: false,
      profileVersion: '',
      detectedSections: [],
      formatLabel,
      message: '当前 OCIO Config 文件为空',
    };
  }

  const sectionLabels = ['roles', 'displays', 'views', 'looks', 'colorspaces'];
  let profileVersion = '';
  let detectedSections = [];
  if (ext === '.json') {
    try {
      const parsed = JSON.parse(text);
      const readField = (value) => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
      profileVersion = readField(parsed?.ocio_profile_version ?? parsed?.ocioProfileVersion);
      detectedSections = sectionLabels.filter((key) => {
        const value = parsed?.[key];
        if (Array.isArray(value)) return value.length > 0;
        if (value && typeof value === 'object') return Object.keys(value).length > 0;
        return false;
      });
    } catch (error) {
      return {
        structurallyValid: false,
        executable: false,
        profileVersion: '',
        detectedSections: [],
        formatLabel,
        message: `JSON 结构解析失败{error instanceof Error ? error.message : 'json-parse-failed'}`,
      };
    }
  } else {
    const sectionRegex = {
      roles: /^\s*roles\s*:/im,
      displays: /^\s*displays\s*:/im,
      views: /^\s*views\s*:/im,
      looks: /^\s*looks\s*:/im,
      colorspaces: /^\s*colorspaces\s*:/im,
    };
    const versionMatch = text.match(/^\s*ocio_profile_version\s*:\s*("?)([0-9A-Za-z._-]+)\1/im);
    profileVersion = versionMatch?.[2] || '';
    detectedSections = sectionLabels.filter((key) => sectionRegex[key].test(text));
  }

  const structurallyValid = Boolean(profileVersion) && detectedSections.includes('colorspaces');
  const executable = structurallyValid && detectedSections.some((item) => item === 'roles' || item === 'displays' || item === 'views');
  let message = 'Current OCIO config structure is complete and ready for execution.';
  if (!structurallyValid) {
    message = !profileVersion
      ? 'ocio_profile_version was not detected.'
      : 'colorspaces were not detected, so color-space mapping cannot be established.';
  } else if (!executable) {
    message = 'Base color spaces were detected, but one of roles / displays / views is still missing.';
  }
  return {
    structurallyValid,
    executable,
    profileVersion,
    detectedSections,
    formatLabel,
    message,
  };
}

function isSupportedBokehFile(filePath) {
  return /\.(png|webp)$/i.test(String(filePath || '').trim());
}

function hexToRgbUnit(value, fallback = { r: 0.5, g: 0.5, b: 0.5 }) {
  const normalized = String(value || '').trim();
  const match = /^#?([0-9a-f]{6})$/i.exec(normalized);
  if (!match) return fallback;
  const hex = match[1];
  return {
    r: parseInt(hex.slice(0, 2), 16) / 255,
    g: parseInt(hex.slice(2, 4), 16) / 255,
    b: parseInt(hex.slice(4, 6), 16) / 255,
  };
}

function normalizeCurvePointList(points, fallbackPreset = 'linear', channel = 'master') {
  if (!Array.isArray(points) || points.length < 2) {
    return null;
  }
  const normalized = points
    .map((point, index, list) => ({
      x: clampNumber(Number(point?.x), 0, 1, index === 0 ? 0 : index === list.length - 1 ? 1 : 0.5),
      y: clampNumber(Number(point?.y), 0, 1, index === 0 ? 0 : index === list.length - 1 ? 1 : 0.5),
    }))
    .sort((left, right) => left.x - right.x);
  normalized[0] = { x: 0, y: 0 };
  normalized[normalized.length - 1] = { x: 1, y: 1 };
  for (let index = 1; index < normalized.length - 1; index += 1) {
    const prev = normalized[index - 1];
    const next = normalized[index + 1];
    normalized[index].x = clampNumber(normalized[index].x, prev.x + 0.02, next.x - 0.02, normalized[index].x);
  }
  if (normalized.length < 2) {
    return normalizeCurvePointList(null, fallbackPreset, channel);
  }
  return normalized;
}

function curvePointsToFfmpeg(points) {
  return points.map((point) => `${point.x.toFixed(3)}/${point.y.toFixed(3)}`).join(' ');
}

function buildCurvePoints(preset, channel = 'master', points = null) {
  const normalizedPoints = normalizeCurvePointList(points, preset, channel);
  if (normalizedPoints) {
    return curvePointsToFfmpeg(normalizedPoints);
  }
  const normalized = String(preset || 'linear').trim();
  if (normalized === 'soft-contrast') return '0/0 0.20/0.14 0.76/0.88 1/1';
  if (normalized === 'film-s') return '0/0 0.18/0.10 0.40/0.44 0.74/0.88 1/1';
  if (normalized === 'lifted-matte') return '0/0.06 0.22/0.20 0.78/0.84 1/0.97';
  if (normalized === 'film-warm') return channel === 'red' ? '0/0.01 0.45/0.48 0.82/0.90 1/1' : '0/0 1/1';
  if (normalized === 'teal-shadows') return channel === 'blue' ? '0/0.07 0.30/0.34 1/1' : channel === 'red' ? '0/0 0.28/0.22 1/1' : '0/0 1/1';
  if (normalized === 'crisp-highlights') return '0/0 0.60/0.62 0.86/0.92 1/1';
  if (normalized === 'film-balance') return channel === 'green' ? '0/0 0.22/0.20 0.70/0.74 1/1' : '0/0 1/1';
  if (normalized === 'lift-shadows') return '0/0.05 0.16/0.18 1/1';
  if (normalized === 'cool-highlights') return channel === 'blue' ? '0/0 0.66/0.72 1/1' : '0/0 1/1';
  return '0/0 1/1';
}

function buildColorWheelFilter(config = {}) {
  const lift = hexToRgbUnit(config.liftColor, { r: 0.5, g: 0.5, b: 0.5 });
  const gamma = hexToRgbUnit(config.gammaColor, { r: 0.5, g: 0.5, b: 0.5 });
  const gain = hexToRgbUnit(config.gainColor, { r: 0.5, g: 0.5, b: 0.5 });
  const liftPower = clampNumber(Math.abs(config.lift) * clampNumber(config.liftAmount, 0, 1, 0.18), 0, 1, 0);
  const gammaPower = clampNumber(Math.abs(config.gamma - 1) * clampNumber(config.gammaAmount, 0, 1, 0.14), 0, 1, 0);
  const gainPower = clampNumber(Math.abs(config.gain - 1) * clampNumber(config.gainAmount, 0, 1, 0.16), 0, 1, 0);
  return `colorbalance=rs=${((lift.r - 0.5) * liftPower).toFixed(3)}:gs=${((lift.g - 0.5) * liftPower).toFixed(3)}:bs=${((lift.b - 0.5) * liftPower).toFixed(3)}:rm=${((gamma.r - 0.5) * gammaPower).toFixed(3)}:gm=${((gamma.g - 0.5) * gammaPower).toFixed(3)}:bm=${((gamma.b - 0.5) * gammaPower).toFixed(3)}:rh=${((gain.r - 0.5) * gainPower).toFixed(3)}:gh=${((gain.g - 0.5) * gainPower).toFixed(3)}:bh=${((gain.b - 0.5) * gainPower).toFixed(3)}`;
}

function buildCurveFilter(config = {}) {
  return `curves=all='${buildCurvePoints(config.masterCurve, 'master', config.masterCurvePoints)}':r='${buildCurvePoints(config.redCurve, 'red', config.redCurvePoints)}':g='${buildCurvePoints(config.greenCurve, 'green', config.greenCurvePoints)}':b='${buildCurvePoints(config.blueCurve, 'blue', config.blueCurvePoints)}'`;
}

function buildOcioLikeFilter(config = {}) {
  const inputSpace = String(config.colorSpaceIn || 'sRGB').trim();
  const outputSpace = String(config.colorSpaceOut || 'Rec.709').trim();
  const ocioConfig = String(config.ocioConfig || 'builtin').trim();
  const ocioDisplay = String(config.ocioDisplay || 'rec709-monitor').trim();
  const ocioStrength = clampNumber(config.ocioLookStrength, 0, 1, 0.72);
  const filters = [];
  if (ocioConfig === 'aces-1.3' || inputSpace !== 'sRGB' || outputSpace !== 'Rec.709' || ocioDisplay !== 'rec709-monitor') {
    const ocioContrast = 1 + ocioStrength * 0.06;
    const ocioOutMin = clampNumber(0.5 - ocioContrast * 0.5, 0, 0.05, 0);
    const ocioOutMax = clampNumber(0.5 + ocioContrast * 0.5, 0.95, 1, 1);
    filters.push(`colorlevels=romin=${ocioOutMin.toFixed(3)}:gomin=${ocioOutMin.toFixed(3)}:bomin=${ocioOutMin.toFixed(3)}:romax=${ocioOutMax.toFixed(3)}:gomax=${ocioOutMax.toFixed(3)}:bomax=${ocioOutMax.toFixed(3)}`);
    filters.push(`hue=s=${(1 + ocioStrength * 0.04).toFixed(3)}`);
    if (inputSpace === 'ACEScg' || ocioConfig === 'aces-1.3') {
      filters.push(`curves=all='0/0 0.18/0.12 0.70/0.82 1/1'`);
    }
    if (outputSpace === 'DCI-P3' || ocioDisplay === 'p3-cinema') {
      const p3Mid = clampNumber(0.5 + ocioStrength * 0.012, 0.48, 0.56, 0.5);
      filters.push(`hue=s=${(1 + ocioStrength * 0.05).toFixed(3)}`);
      filters.push(`curves=all='0/0 0.50/${p3Mid.toFixed(3)} 1/1'`);
    } else if (ocioDisplay === 'web-srgb') {
      const webGamma = 1 + ocioStrength * 0.03;
      const webMid = clampNumber(Math.pow(0.5, 1 / webGamma), 0.46, 0.56, 0.5);
      filters.push(`curves=all='0/0 0.50/${webMid.toFixed(3)} 1/1'`);
    }
  }
  return filters;
}

function resolvePostUpscaleRoute(config = {}) {
  const routePolicy = String(config.routePolicy || 'auto').trim();
  const model = String(config.model || 'realesrgan-balanced').trim();
  if (routePolicy !== 'auto') return routePolicy;
  if (model === 'supir-detail') return 'supir';
  if (model === 'fsr-fast') return 'fsr-preview';
  if (model === 'realbasicvsr-video') return 'realbasicvsr';
  return 'realbasicvsr';
}

function resolveLocalPostWrapperCommand({ envCommand = '', envPath = '', wrapperKey = '' } = {}) {
  let commandLine = envCommand ? String(process.env[envCommand] || '').trim() : '';
  const detectedPath = envPath ? String(process.env[envPath] || '').trim() : '';
  const wrapperScript = wrapperKey ? LOCAL_POST_BACKEND_WRAPPERS[wrapperKey] : '';
  if (!commandLine && detectedPath && wrapperScript) {
    commandLine = `node "${wrapperScript}"`;
  }
  return {
    commandLine,
    detectedPath,
  };
}

function detectExecutablePath(cacheKey, names = [], preferredPaths = []) {
  if (EXECUTABLE_DETECTION_CACHE.has(cacheKey)) {
    return EXECUTABLE_DETECTION_CACHE.get(cacheKey) || '';
  }
  const normalizedPreferred = preferredPaths
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  const preferredHit = normalizedPreferred.find((item) => existsSync(item));
  if (preferredHit) {
    EXECUTABLE_DETECTION_CACHE.set(cacheKey, preferredHit);
    return preferredHit;
  }

  const lookupCommand = process.platform === 'win32' ? 'where' : 'which';
  for (const name of names.map((item) => String(item || '').trim()).filter(Boolean)) {
    const lookup = spawnSync(lookupCommand, [name], {
      cwd: APP_DIR,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (lookup.status === 0) {
      const hit = String(lookup.stdout || '')
        .split(/\r?\n/)
        .map((item) => item.trim())
        .find(Boolean);
      if (hit) {
        EXECUTABLE_DETECTION_CACHE.set(cacheKey, hit);
        return hit;
      }
    }
  }
  EXECUTABLE_DETECTION_CACHE.set(cacheKey, '');
  return '';
}

function buildManagedRuntimePaths(runtimeKey) {
  const rootDir = path.join(LOCAL_POST_MANAGED_RUNTIME_DIR, runtimeKey);
  const currentDir = path.join(rootDir, 'current');
  const stagingDir = path.join(rootDir, 'staging');
  return {
    rootDir,
    currentDir,
    stagingDir,
    downloadDir: path.join(LOCAL_POST_MANAGED_RUNTIME_DOWNLOAD_DIR, runtimeKey),
  };
}

function isPathInsideDir(baseDir, targetPath) {
  const relative = path.relative(path.resolve(baseDir), path.resolve(targetPath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function readManagedRuntimeManifest() {
  try {
    if (!existsSync(LOCAL_POST_MANAGED_RUNTIME_MANIFEST_FILE)) return {};
    const parsed = JSON.parse(readFileSync(LOCAL_POST_MANAGED_RUNTIME_MANIFEST_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeManagedRuntimeManifestSync(manifest) {
  mkdirSync(LOCAL_POST_MANAGED_RUNTIME_DIR, { recursive: true });
  writeFileSync(LOCAL_POST_MANAGED_RUNTIME_MANIFEST_FILE, JSON.stringify(manifest, null, 2), 'utf8');
}

function getManagedRuntimeManifestEntry(runtimeKey) {
  const manifest = readManagedRuntimeManifest();
  const entry = manifest?.[runtimeKey];
  return entry && typeof entry === 'object' ? entry : null;
}

function readManagedRuntimeFile(runtimeKey, field) {
  const entry = getManagedRuntimeManifestEntry(runtimeKey);
  const value = String(entry?.[field] || '').trim();
  if (!value) return '';
  const resolved = path.resolve(value);
  return existsSync(resolved) ? resolved : '';
}

function findFileRecursively(rootDir, fileName, maxDepth = 6) {
  const normalizedRoot = path.resolve(rootDir);
  if (!existsSync(normalizedRoot)) return '';
  const queue = [{ dir: normalizedRoot, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    let entries = [];
    try {
      entries = readdirSync(current.dir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const entryPath = path.join(current.dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
        return entryPath;
      }
      if (entry.isDirectory() && current.depth < maxDepth) {
        queue.push({ dir: entryPath, depth: current.depth + 1 });
      }
    }
  }
  return '';
}

function detectManagedLocalPostGmicPath() {
  return readManagedRuntimeFile('gmic', 'executablePath')
    || findFileRecursively(buildManagedRuntimePaths('gmic').currentDir, 'gmic.exe');
}

function detectManagedLocalPostOiioPath() {
  return readManagedRuntimeFile('oiio', 'executablePath')
    || findFileRecursively(buildManagedRuntimePaths('oiio').currentDir, 'oiiotool.exe');
}

function detectManagedLocalPostOcioPath() {
  return readManagedRuntimeFile('ocio', 'runtimePath')
    || findFileRecursively(buildManagedRuntimePaths('ocio').currentDir, 'ocioconvert.exe');
}

function detectManagedLocalPostOcioConfigPath() {
  return readManagedRuntimeFile('ocio', 'configPath');
}

function detectLocalPostOcioRuntimePath() {
  const configuredPath = String(process.env.HMDAO_POST_OCIO_PATH || '').trim();
  if (configuredPath) return configuredPath;
  const candidates = [
    detectManagedLocalPostOcioPath(),
    process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'OpenColorIO', 'bin', 'ocioconvert.exe') : '',
    process.platform === 'win32' ? path.join(process.env.LocalAppData || '', 'Programs', 'OpenColorIO', 'bin', 'ocioconvert.exe') : '',
  ].filter(Boolean);
  return detectExecutablePath('post:ocio', ['ocioconvert', 'ocioconvert.exe'], candidates);
}

function detectLocalPostGmicPath() {
  const configuredPath = String(process.env.HMDAO_POST_GMIC_PATH || '').trim();
  if (configuredPath) return configuredPath;
  const candidates = [
    detectManagedLocalPostGmicPath(),
    process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'GMIC', 'gmic.exe') : '',
    process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'G-MIC', 'gmic.exe') : '',
    process.platform === 'win32' ? path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'GMIC', 'gmic.exe') : '',
    process.platform === 'win32' ? path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'G-MIC', 'gmic.exe') : '',
    process.platform === 'win32' ? path.join(process.env.LocalAppData || '', 'Programs', 'GMIC', 'gmic.exe') : '',
  ].filter(Boolean);
  return detectExecutablePath('post:gmic', ['gmic', 'gmic.exe'], candidates);
}

function detectLocalPostOiioPath() {
  const configuredPath = String(process.env.HMDAO_POST_OIIO_PATH || '').trim();
  if (configuredPath) return configuredPath;
  const candidates = [
    detectManagedLocalPostOiioPath(),
    process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'OpenImageIO', 'bin', 'oiiotool.exe') : '',
    process.platform === 'win32' ? path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'OpenImageIO', 'bin', 'oiiotool.exe') : '',
    process.platform === 'win32' ? path.join(process.env.LocalAppData || '', 'Programs', 'OpenImageIO', 'bin', 'oiiotool.exe') : '',
  ].filter(Boolean);
  return detectExecutablePath('post:oiio', ['oiiotool', 'oiiotool.exe'], candidates);
}

function detectLocalPostOiioConfigPath() {
  const configured = String(process.env.HMDAO_POST_OIIO_OCIO_CONFIG || process.env.HMDAO_POST_OCIO_CONFIG || process.env.OCIO || '').trim();
  if (configured && existsSync(configured)) return configured;
  return detectManagedLocalPostOcioConfigPath();
}

function clearLocalPostRuntimeDetectionCache() {
  EXECUTABLE_DETECTION_CACHE.clear();
}

function trimRuntimeInstallJobs() {
  const jobs = Array.from(LOCAL_POST_RUNTIME_INSTALL_JOBS.values())
    .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
  for (const job of jobs.slice(LOCAL_POST_RUNTIME_INSTALL_MAX_HISTORY)) {
    LOCAL_POST_RUNTIME_INSTALL_JOBS.delete(job.id);
    const linked = LOCAL_POST_RUNTIME_INSTALL_JOBS_BY_KEY.get(job.runtimeKey);
    if (linked === job.id) {
      LOCAL_POST_RUNTIME_INSTALL_JOBS_BY_KEY.delete(job.runtimeKey);
    }
  }
}

function toRuntimeInstallJobResponse(job) {
  if (!job) return null;
  return {
    id: job.id,
    runtimeKey: job.runtimeKey,
    runtimeName: job.runtimeName,
    requestedAction: job.requestedAction,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    message: job.message,
    error: job.error,
    targetVersion: job.targetVersion,
    installedVersion: job.installedVersion,
    sourceLabel: job.sourceLabel,
    downloadUrl: job.downloadUrl,
    releaseUrl: job.releaseUrl,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    verified: Boolean(job.verified),
    doctor: job.doctor || null,
  };
}

function updateRuntimeInstallJob(job, patch = {}) {
  Object.assign(job, patch, { updatedAt: Date.now() });
  LOCAL_POST_RUNTIME_INSTALL_JOBS.set(job.id, job);
  LOCAL_POST_RUNTIME_INSTALL_JOBS_BY_KEY.set(job.runtimeKey, job.id);
  trimRuntimeInstallJobs();
  return job;
}

function getRuntimeInstallJob(jobId) {
  return LOCAL_POST_RUNTIME_INSTALL_JOBS.get(jobId) || null;
}

function getLatestRuntimeInstallJob(runtimeKey) {
  const jobId = LOCAL_POST_RUNTIME_INSTALL_JOBS_BY_KEY.get(runtimeKey);
  return jobId ? getRuntimeInstallJob(jobId) : null;
}

async function downloadFileWithProgress(url, targetPath, onProgress, headers = {}) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'HMDAO Runtime Installer',
      ...headers,
    },
  });
  if (!response.ok || !response.body) {
    throw new Error(`download-failed:${response.status}`);
  }
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const contentLength = Number(response.headers.get('content-length') || 0);
  const fileHandle = await fs.open(targetPath, 'w');
  let receivedBytes = 0;
  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      receivedBytes += value.byteLength;
      await fileHandle.write(Buffer.from(value));
      onProgress?.({
        receivedBytes,
        totalBytes: contentLength,
        percent: contentLength > 0 ? Math.min(100, Math.round((receivedBytes / contentLength) * 100)) : 0,
      });
    }
  } finally {
    await fileHandle.close().catch(() => {});
  }
  return {
    receivedBytes,
    totalBytes: contentLength,
  };
}

async function extractZipArchiveToDirectory(archivePath, targetDir) {
  const resolvedTargetDir = path.resolve(targetDir);
  await fs.mkdir(resolvedTargetDir, { recursive: true });
  const archiveBuffer = await fs.readFile(archivePath);
  const extracted = unzipSync(new Uint8Array(archiveBuffer));
  for (const [entryName, entryBytes] of Object.entries(extracted)) {
    const normalizedEntry = String(entryName || '').replace(/\\/g, '/');
    if (!normalizedEntry || normalizedEntry.endsWith('/')) continue;
    const safeSegments = normalizedEntry.split('/').filter(Boolean);
    if (!safeSegments.length || safeSegments.some((segment) => segment === '.' || segment === '..')) continue;
    const outputPath = path.resolve(resolvedTargetDir, ...safeSegments);
    if (!isPathInsideDir(resolvedTargetDir, outputPath)) {
      throw new Error(`archive-path-outside-target:${normalizedEntry}`);
    }
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, Buffer.from(entryBytes));
  }
}

async function replaceDirectoryContents(targetDir, stagingDir) {
  const resolvedTargetDir = path.resolve(targetDir);
  const resolvedStagingDir = path.resolve(stagingDir);
  const rootDir = path.dirname(resolvedTargetDir);
  if (!isPathInsideDir(rootDir, resolvedTargetDir) || !isPathInsideDir(rootDir, resolvedStagingDir)) {
    throw new Error('managed-runtime-path-outside-root');
  }
  await fs.rm(resolvedTargetDir, { recursive: true, force: true }).catch(() => {});
  await fs.rename(resolvedStagingDir, resolvedTargetDir);
}

async function persistManagedRuntimeManifestEntry(runtimeKey, nextEntry) {
  const manifest = readManagedRuntimeManifest();
  manifest[runtimeKey] = nextEntry;
  writeManagedRuntimeManifestSync(manifest);
}

async function resolvePypiWheelAsset(packageName, preferredVersion = '') {
  const normalizedVersion = String(preferredVersion || '').trim();
  const urlsToTry = normalizedVersion
    ? [
      `https://pypi.org/pypi/${encodeURIComponent(packageName)}/${encodeURIComponent(normalizedVersion)}/json`,
      `https://pypi.org/pypi/${encodeURIComponent(packageName)}/json`,
    ]
    : [`https://pypi.org/pypi/${encodeURIComponent(packageName)}/json`];
  let payload = null;
  let lastError = '';
  for (const target of urlsToTry) {
    try {
      const response = await fetch(target, {
        headers: {
          'User-Agent': 'HMDAO Runtime Installer',
          Accept: 'application/json',
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      payload = await response.json().catch(() => null);
      if (payload) break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  if (!payload) {
    throw new Error(`pypi-metadata-failed:${packageName}:${lastError || 'unknown-error'}`);
  }
  const files = Array.isArray(payload?.urls) ? payload.urls : [];
  const ranked = files
    .filter((item) => item?.packagetype === 'bdist_wheel' && /win_amd64\.whl$/i.test(String(item.filename || '')))
    .sort((left, right) => {
      const leftName = String(left?.filename || '');
      const rightName = String(right?.filename || '');
      const leftScore = /cp313/i.test(leftName) ? 2 : /cp31/i.test(leftName) ? 1 : 0;
      const rightScore = /cp313/i.test(rightName) ? 2 : /cp31/i.test(rightName) ? 1 : 0;
      return rightScore - leftScore;
    });
  const selected = ranked[0] || null;
  if (!selected?.url) {
    throw new Error(`wheel-not-found:${packageName}`);
  }
  return {
    version: String(payload?.info?.version || '').trim() || normalizedVersion,
    downloadUrl: String(selected.url || '').trim(),
    fileName: String(selected.filename || '').trim() || `${packageName}.whl`,
    releaseUrl: `https://pypi.org/project/${encodeURIComponent(packageName)}/${encodeURIComponent(String(payload?.info?.version || normalizedVersion || '').trim() || 'latest')}/`,
  };
}

async function resolveLatestGmicInstallAsset() {
  const response = await fetch('https://gmic.eu/download.html', {
    headers: {
      'User-Agent': 'HMDAO Runtime Installer',
    },
  });
  if (!response.ok) {
    throw new Error(`gmic-download-page-failed:${response.status}`);
  }
  const text = await response.text();
  const match = text.match(/get_file\.php\?file=(windows\/gmic_([0-9.]+)_cli_win64\.zip)/i);
  if (!match?.[1] || !match?.[2]) {
    throw new Error('gmic-download-link-not-found');
  }
  return {
    version: match[2],
    downloadUrl: `https://gmic.eu/get_file.php?file=${match[1]}`,
    fileName: path.basename(match[1]),
    releaseUrl: 'https://gmic.eu/download.html',
  };
}

async function resolveLatestOcioConfigAsset() {
  const response = await fetch('https://api.github.com/repos/AcademySoftwareFoundation/OpenColorIO-Config-ACES/releases/latest', {
    headers: {
      'User-Agent': 'HMDAO Runtime Installer',
      Accept: 'application/vnd.github+json',
    },
  });
  if (!response.ok) {
    throw new Error(`ocio-config-release-failed:${response.status}`);
  }
  const payload = await response.json().catch(() => null);
  const assets = Array.isArray(payload?.assets) ? payload.assets : [];
  const matched = assets.find((asset) => /^cg-config-.*_ocio-v2\.5\.ocio$/i.test(String(asset?.name || '').trim()));
  if (!matched?.browser_download_url) {
    throw new Error('ocio-config-asset-not-found');
  }
  return {
    version: String(payload?.tag_name || '').replace(/^v/i, '').trim(),
    downloadUrl: String(matched.browser_download_url || '').trim(),
    fileName: String(matched.name || '').trim() || 'cg-config.ocio',
    releaseUrl: String(payload?.html_url || '').trim(),
  };
}

async function resolveInstallableRuntimeAsset(runtimeKey) {
  if (runtimeKey === 'gmic') {
    const asset = await resolveLatestGmicInstallAsset();
    return {
      runtimeKey,
      runtimeName: LOCAL_POST_RUNTIME_GUIDES.gmic.runtimeName,
      sourceLabel: LOCAL_POST_INSTALLABLE_RUNTIMES.gmic.sourceLabel,
      archiveType: 'zip',
      ...asset,
    };
  }
  if (runtimeKey === 'oiio') {
    const latest = await fetchLatestLocalPostRuntimeVersion('oiio');
    const asset = await resolvePypiWheelAsset('OpenImageIO', latest.latestVersion || '');
    return {
      runtimeKey,
      runtimeName: LOCAL_POST_RUNTIME_GUIDES.oiio.runtimeName,
      sourceLabel: LOCAL_POST_INSTALLABLE_RUNTIMES.oiio.sourceLabel,
      archiveType: 'wheel',
      ...asset,
    };
  }
  if (runtimeKey === 'ocio') {
    const latest = await fetchLatestLocalPostRuntimeVersion('ocio');
    const runtimeAsset = await resolvePypiWheelAsset('opencolorio', latest.latestVersion || '');
    const configAsset = await resolveLatestOcioConfigAsset();
    return {
      runtimeKey,
      runtimeName: LOCAL_POST_RUNTIME_GUIDES.ocio.runtimeName,
      sourceLabel: LOCAL_POST_INSTALLABLE_RUNTIMES.ocio.sourceLabel,
      archiveType: 'wheel',
      ...runtimeAsset,
      configAsset,
    };
  }
  throw new Error(`unsupported-runtime:${runtimeKey}`);
}

async function verifyManagedRuntimeInstall(runtimeKey, details = {}) {
  if (runtimeKey === 'gmic') {
    const version = await detectInstalledRuntimeVersion(String(details.executablePath || ''), [{ args: ['version'] }, { args: ['--version'] }, { args: ['-version'] }]);
    return {
      ok: Boolean(version?.ok),
      installedVersion: String(version?.version || '').trim(),
      probe: version,
      configPath: '',
    };
  }
  if (runtimeKey === 'oiio') {
    const version = await detectInstalledRuntimeVersion(String(details.executablePath || ''), [{ args: ['--version'] }]);
    return {
      ok: Boolean(version?.ok),
      installedVersion: String(version?.version || '').trim(),
      probe: version,
      configPath: String(details.configPath || '').trim(),
    };
  }
  if (runtimeKey === 'ocio') {
    const version = await detectOcioRuntimeInstallation(String(details.runtimePath || ''));
    return {
      ok: Boolean(version?.ok) && Boolean(String(details.configPath || '').trim() && existsSync(String(details.configPath || '').trim())),
      installedVersion: String(version?.version || '').trim(),
      probe: version,
      configPath: String(details.configPath || '').trim(),
    };
  }
  return {
    ok: false,
    installedVersion: '',
    probe: null,
    configPath: '',
  };
}

async function installManagedLocalPostRuntime(runtimeKey, job) {
  const runtimeMeta = LOCAL_POST_INSTALLABLE_RUNTIMES[runtimeKey];
  if (!runtimeMeta) {
    throw new Error(`unsupported-runtime:${runtimeKey}`);
  }
  const layout = buildManagedRuntimePaths(runtimeKey);
  await fs.mkdir(layout.downloadDir, { recursive: true });
  await fs.mkdir(layout.rootDir, { recursive: true });
  await fs.rm(layout.stagingDir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(layout.stagingDir, { recursive: true });

  updateRuntimeInstallJob(job, {
    status: 'running',
    stage: 'resolve',
    progress: 5,
    runtimeName: runtimeMeta.runtimeName,
    message: '正在解析最新版安装包',
  });
  const asset = await resolveInstallableRuntimeAsset(runtimeKey);
  updateRuntimeInstallJob(job, {
    sourceLabel: asset.sourceLabel,
    targetVersion: String(asset.version || '').trim(),
    releaseUrl: String(asset.releaseUrl || '').trim(),
    downloadUrl: String(asset.downloadUrl || '').trim(),
  });

  const archivePath = path.join(layout.downloadDir, asset.fileName);
  updateRuntimeInstallJob(job, {
    stage: 'download',
    progress: 10,
    message: '正在下载安装包',
  });
  await downloadFileWithProgress(asset.downloadUrl, archivePath, ({ percent }) => {
    updateRuntimeInstallJob(job, {
      stage: 'download',
      progress: percent > 0 ? Math.min(48, 10 + Math.round(percent * 0.38)) : 18,
      message: percent > 0 ? `正在下载安装包 ${percent}%` : '正在下载安装包',
    });
  });

  updateRuntimeInstallJob(job, {
    stage: 'extract',
    progress: 55,
    message: '正在解压运行时',
  });
  await extractZipArchiveToDirectory(archivePath, layout.stagingDir);

  let manifestEntry = null;
  if (runtimeKey === 'gmic') {
    const executablePath = findFileRecursively(layout.stagingDir, 'gmic.exe');
    if (!executablePath) throw new Error('gmic-executable-missing-after-extract');
    manifestEntry = {
      runtimeKey,
      runtimeName: runtimeMeta.runtimeName,
      sourceLabel: asset.sourceLabel,
      version: asset.version,
      executablePath: path.resolve(layout.currentDir, path.relative(layout.stagingDir, executablePath)),
      installedAt: new Date().toISOString(),
      releaseUrl: asset.releaseUrl,
      downloadUrl: asset.downloadUrl,
    };
  } else if (runtimeKey === 'oiio') {
    const executablePath = findFileRecursively(layout.stagingDir, 'oiiotool.exe');
    if (!executablePath) throw new Error('oiio-executable-missing-after-extract');
    manifestEntry = {
      runtimeKey,
      runtimeName: runtimeMeta.runtimeName,
      sourceLabel: asset.sourceLabel,
      version: asset.version,
      executablePath: path.resolve(layout.currentDir, path.relative(layout.stagingDir, executablePath)),
      installedAt: new Date().toISOString(),
      releaseUrl: asset.releaseUrl,
      downloadUrl: asset.downloadUrl,
    };
  } else if (runtimeKey === 'ocio') {
    const runtimePath = findFileRecursively(layout.stagingDir, 'ocioconvert.exe');
    if (!runtimePath) throw new Error('ocio-executable-missing-after-extract');
    const configDir = path.join(layout.rootDir, 'configs');
    const configAsset = asset.configAsset || null;
    if (!configAsset?.downloadUrl) throw new Error('ocio-config-download-missing');
    await fs.mkdir(configDir, { recursive: true });
    const configPath = path.join(configDir, configAsset.fileName);
    updateRuntimeInstallJob(job, {
      stage: 'config',
      progress: 70,
      message: '正在下载官方 ACES 配置',
    });
    await downloadFileWithProgress(configAsset.downloadUrl, configPath, ({ percent }) => {
      updateRuntimeInstallJob(job, {
        stage: 'config',
        progress: percent > 0 ? Math.min(84, 70 + Math.round(percent * 0.14)) : 74,
        message: percent > 0 ? `正在下载官方 ACES 配置 ${percent}%` : '正在下载官方 ACES 配置',
      });
    });
    manifestEntry = {
      runtimeKey,
      runtimeName: runtimeMeta.runtimeName,
      sourceLabel: asset.sourceLabel,
      version: asset.version,
      runtimePath: path.resolve(layout.currentDir, path.relative(layout.stagingDir, runtimePath)),
      executablePath: path.resolve(layout.currentDir, path.relative(layout.stagingDir, runtimePath)),
      configPath,
      configVersion: String(configAsset.version || '').trim(),
      configReleaseUrl: String(configAsset.releaseUrl || '').trim(),
      installedAt: new Date().toISOString(),
      releaseUrl: asset.releaseUrl,
      downloadUrl: asset.downloadUrl,
    };
  }

  updateRuntimeInstallJob(job, {
    stage: 'switch',
    progress: 86,
    message: '正在切换到新版本',
  });
  await replaceDirectoryContents(layout.currentDir, layout.stagingDir);
  await persistManagedRuntimeManifestEntry(runtimeKey, manifestEntry);
  clearLocalPostRuntimeDetectionCache();

  updateRuntimeInstallJob(job, {
    stage: 'verify',
    progress: 92,
    message: '正在执行安装后一键自检',
  });
  const verifyResult = await verifyManagedRuntimeInstall(runtimeKey, manifestEntry);
  if (!verifyResult.ok) {
    throw new Error(`runtime-verify-failed:${runtimeKey}`);
  }
  const doctorReport = await buildLocalPostDoctorReport({ forceRelease: true }).catch(() => null);
  updateRuntimeInstallJob(job, {
    status: 'succeeded',
    stage: 'done',
    progress: 100,
    message: '安装完成，并已通过本机自检',
    verified: true,
    installedVersion: verifyResult.installedVersion || manifestEntry?.version || '',
    doctor: doctorReport?.runtimes?.[runtimeKey] || null,
    completedAt: Date.now(),
  });
}

async function startRuntimeInstallJob(runtimeKey, { requestedAction = 'install' } = {}) {
  const normalizedKey = String(runtimeKey || '').trim();
  if (!LOCAL_POST_INSTALLABLE_RUNTIMES[normalizedKey]) {
    throw new Error(`unsupported-runtime:${normalizedKey}`);
  }
  const existing = getLatestRuntimeInstallJob(normalizedKey);
  if (existing && (existing.status === 'pending' || existing.status === 'running')) {
    return existing;
  }
  const runtimeMeta = LOCAL_POST_INSTALLABLE_RUNTIMES[normalizedKey];
  const job = {
    id: crypto.randomUUID(),
    runtimeKey: normalizedKey,
    runtimeName: runtimeMeta.runtimeName,
    requestedAction,
    status: 'pending',
    stage: 'queued',
    progress: 0,
    message: '安装任务已排队',
    error: '',
    sourceLabel: runtimeMeta.sourceLabel,
    targetVersion: '',
    installedVersion: '',
    verified: false,
    doctor: null,
    releaseUrl: '',
    downloadUrl: '',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: 0,
  };
  updateRuntimeInstallJob(job);
  queueMicrotask(async () => {
    try {
      await installManagedLocalPostRuntime(normalizedKey, job);
    } catch (error) {
      updateRuntimeInstallJob(job, {
        status: 'failed',
        stage: 'failed',
        progress: Math.max(1, Number(job.progress || 0)),
        error: trimDiagnosticText(error instanceof Error ? error.message : String(error), 320),
        message: '安装失败，请查看错误信息后重试',
        completedAt: Date.now(),
      });
      await fs.rm(buildManagedRuntimePaths(normalizedKey).stagingDir, { recursive: true, force: true }).catch(() => {});
    }
  });
  return job;
}

function trimDiagnosticText(value, maxLength = 220) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength - 1) + '...';
}

function firstSemverToken(value) {
  const matched = String(value || '').match(/\bv?\d+(?:\.\d+){1,4}(?:[-+._][0-9A-Za-z.-]+)?\b/);
  return matched ? matched[0].replace(/^v/i, '') : '';
}

function versionParts(value) {
  return String(value || '')
    .replace(/^v/i, '')
    .split(/[^0-9A-Za-z]+/)
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part.toLowerCase()));
}

function compareVersionStrings(left, right) {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  const maxLength = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < maxLength; index += 1) {
    const a = leftParts[index];
    const b = rightParts[index];
    if (a === undefined && b === undefined) return 0;
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (typeof a === 'number' && typeof b === 'number') {
      if (a > b) return 1;
      if (a < b) return -1;
      continue;
    }
    const nextA = String(a);
    const nextB = String(b);
    if (nextA > nextB) return 1;
    if (nextA < nextB) return -1;
  }
  return 0;
}

async function runLocalPostDiagnosticCommand(command, args = [], {
  cwd = APP_DIR,
  extraEnv = {},
  timeoutMs = LOCAL_POST_SELF_CHECK_TIMEOUT_MS,
} = {}) {
  return await new Promise((resolve) => {
    const stdout = [];
    const stderr = [];
    let finished = false;
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...extraEnv,
      },
    });
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill('SIGTERM');
      resolve({
        ok: false,
        timedOut: true,
        exitCode: null,
        stdout: trimDiagnosticText(Buffer.concat(stdout).toString('utf8'), 600),
        stderr: trimDiagnosticText(Buffer.concat(stderr).toString('utf8'), 600),
        elapsedMs: Date.now() - startedAt,
      });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        timedOut: false,
        exitCode: null,
        stdout: trimDiagnosticText(Buffer.concat(stdout).toString('utf8'), 600),
        stderr: trimDiagnosticText(error instanceof Error ? error.message : String(error), 600),
        elapsedMs: Date.now() - startedAt,
      });
    });
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        timedOut: false,
        exitCode: code,
        stdout: trimDiagnosticText(Buffer.concat(stdout).toString('utf8'), 600),
        stderr: trimDiagnosticText(Buffer.concat(stderr).toString('utf8'), 600),
        elapsedMs: Date.now() - startedAt,
      });
    });
  });
}

async function detectInstalledRuntimeVersion(runtimePath, attempts = []) {
  for (const attempt of attempts) {
    const probe = await runLocalPostDiagnosticCommand(runtimePath, attempt.args, {
      cwd: path.dirname(runtimePath),
      extraEnv: attempt.extraEnv || {},
    });
    const combined = `${probe.stdout}\n${probe.stderr}`.trim();
    const version = firstSemverToken(combined);
    if (probe.ok || version) {
      return {
        ok: probe.ok,
        version,
        probe,
        commandArgs: attempt.args,
      };
    }
  }
  return {
    ok: false,
    version: '',
    probe: {
      ok: false,
      timedOut: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      elapsedMs: 0,
    },
    commandArgs: [],
  };
}

async function detectOcioRuntimeInstallation(runtimePath) {
  const normalizedPath = String(runtimePath || '').trim();
  if (!normalizedPath) {
    return {
      ok: false,
      version: '',
      probe: null,
      commandArgs: [],
    };
  }
  const probe = await runLocalPostDiagnosticCommand(normalizedPath, ['--help'], {
    cwd: path.dirname(normalizedPath),
  });
  const combinedOutput = `${String(probe?.stdout || '')}\n${String(probe?.stderr || '')}`;
  const managedVersion = String(getManagedRuntimeManifestEntry('ocio')?.version || '').trim();
  const version = managedVersion || firstSemverToken(combinedOutput);
  const ok = /ocioconvert -- apply colorspace transform to an image/i.test(combinedOutput);
  return {
    ok,
    version,
    probe: {
      ...probe,
      ok,
    },
    commandArgs: ['--help'],
  };
}

const LOCAL_POST_LATEST_VERSION_SOURCES = {
  ocio: {
    sourceLabel: 'GitHub Releases',
    apiUrl: 'https://api.github.com/repos/AcademySoftwareFoundation/OpenColorIO/releases/latest',
  },
  oiio: {
    sourceLabel: 'GitHub Releases',
    apiUrl: 'https://api.github.com/repos/AcademySoftwareFoundation/OpenImageIO/releases/latest',
  },
  gmic: {
    sourceLabel: 'gmic.eu',
    pageUrl: 'https://gmic.eu/download.html',
    versionPatterns: [
      /Latest stable version[^0-9]*([0-9]+(?:\.[0-9]+){1,4})/i,
      /G'MIC[^0-9]*([0-9]+(?:\\.[0-9]+){1,4})/i,
    ],
  },
};

async function fetchLatestLocalPostRuntimeVersion(key, { force = false } = {}) {
  const source = LOCAL_POST_LATEST_VERSION_SOURCES[key];
  if (!source) {
    return {
      supported: false,
      checkedAt: new Date().toISOString(),
      latestVersion: '',
      releaseUrl: '',
      sourceLabel: '',
      error: '',
    };
  }
  const cached = LOCAL_POST_RELEASE_CACHE.get(key);
  if (!force && cached && Date.now() - cached.cachedAt < LOCAL_POST_RELEASE_TTL_MS) {
    return cached.payload;
  }

  const result = {
    supported: true,
    checkedAt: new Date().toISOString(),
    latestVersion: '',
    releaseUrl: '',
    sourceLabel: String(source.sourceLabel || '').trim(),
    error: '',
  };

  try {
    if (source.apiUrl) {
      const response = await fetch(source.apiUrl, {
        headers: {
          'User-Agent': 'HMDAO Runtime Checker',
          Accept: 'application/vnd.github+json',
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json().catch(() => null);
      result.latestVersion = firstSemverToken(payload?.tag_name || payload?.name || '');
      result.releaseUrl = String(payload?.html_url || '').trim();
      if (!result.latestVersion) {
        throw new Error('latest-version-not-found');
      }
    } else if (source.pageUrl) {
      const response = await fetch(source.pageUrl, {
        headers: {
          'User-Agent': 'HMDAO Runtime Checker',
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const text = await response.text();
      const matched = source.versionPatterns
        .map((pattern) => text.match(pattern))
        .find((item) => item?.[1]);
      result.latestVersion = matched?.[1] || '';
      result.releaseUrl = source.pageUrl;
      if (!result.latestVersion) {
        throw new Error('latest-version-not-found');
      }
    }
  } catch (error) {
    result.error = trimDiagnosticText(error instanceof Error ? error.message : String(error), 220);
  }

  if (result.error && cached?.payload?.latestVersion) {
    return {
      ...cached.payload,
      checkedAt: new Date().toISOString(),
      error: '',
    };
  }

  LOCAL_POST_RELEASE_CACHE.set(key, {
    cachedAt: Date.now(),
    payload: result,
  });
  return result;
}

async function buildRuntimeUpdateStatus(key, installedVersion = '', options = {}) {
  const latest = await fetchLatestLocalPostRuntimeVersion(key, options);
  const latestVersion = String(latest.latestVersion || '').trim();
  const normalizedInstalled = String(installedVersion || '').trim();
  const updateAvailable = Boolean(latestVersion && normalizedInstalled && compareVersionStrings(normalizedInstalled, latestVersion) < 0);
  return {
    supported: Boolean(latest.supported),
    checkedAt: latest.checkedAt,
    sourceLabel: String(latest.sourceLabel || '').trim(),
    releaseUrl: String(latest.releaseUrl || '').trim(),
    latestVersion,
    installedVersion: normalizedInstalled,
    updateAvailable,
    status: latest.error
      ? 'error'
      : latestVersion
        ? updateAvailable
          ? 'update-available'
          : normalizedInstalled
            ? 'up-to-date'
            : 'latest-known'
        : 'unknown',
    summary: latest.error
      ? `最新版检查失败：${latest.error}`
      : latestVersion
        ? normalizedInstalled
          ? updateAvailable
            ? 'Detected latest version ' + latestVersion + ', current version is ' + normalizedInstalled + '.'
            : 'Current version ' + normalizedInstalled + ' already matches latest version ' + latestVersion + '.'
          : 'Latest version ' + latestVersion + ' is available; compare again after local installation is detected.'
        : '暂未获取到最新版信息',
    error: String(latest.error || '').trim(),
  };
}

async function buildLocalPostDoctorReport({ forceRelease = false } = {}) {
  clearLocalPostRuntimeDetectionCache();
  const checkedAt = new Date().toISOString();
  const resolvedOcioBackend = resolveLocalPostOcioBackend({ ocioExecutionMode: 'auto' });
  const resolvedOiioBackend = resolveLocalPostOiioBackend({ ocioExecutionMode: 'auto' }, 'image', '');
  const resolvedGmicBackend = resolveLocalPostGmicBackend();
  const ocioConfigPath = String(resolvedOiioBackend.detectedConfigPath || detectLocalPostOiioConfigPath()).trim();

  const gmicDetectedPath = String(resolvedGmicBackend.detectedPath || '').trim();
  const oiioDetectedPath = String(resolvedOiioBackend.detectedPath || '').trim();
  const ocioRuntimePath = String(detectLocalPostOcioRuntimePath() || resolvedOcioBackend.detectedPath || '').trim();

  const [gmicVersion, oiioVersion, ocioVersion] = await Promise.all([
    gmicDetectedPath
      ? detectInstalledRuntimeVersion(gmicDetectedPath, [{ args: ['version'] }, { args: ['--version'] }, { args: ['-version'] }])
      : Promise.resolve(null),
    oiioDetectedPath
      ? detectInstalledRuntimeVersion(oiioDetectedPath, [{ args: ['--version'] }])
      : Promise.resolve(null),
    ocioRuntimePath
      ? detectOcioRuntimeInstallation(ocioRuntimePath)
      : Promise.resolve(null),
  ]);

  const ocioConfigReadable = ocioConfigPath
    ? await fs.access(ocioConfigPath).then(() => true).catch(() => false)
    : false;
  const ocioConfigProbe = ocioConfigReadable && oiioDetectedPath
    ? await runLocalPostDiagnosticCommand(oiioDetectedPath, ['--colorconfig', ocioConfigPath, '--colorconfiginfo'], {
      cwd: path.dirname(oiioDetectedPath),
      extraEnv: { OCIO: ocioConfigPath },
    })
    : null;

  const [gmicUpdate, oiioUpdate, ocioUpdate] = await Promise.all([
    buildRuntimeUpdateStatus('gmic', gmicVersion?.version || '', { force: forceRelease }),
    buildRuntimeUpdateStatus('oiio', oiioVersion?.version || '', { force: forceRelease }),
    buildRuntimeUpdateStatus('ocio', ocioVersion?.version || '', { force: forceRelease }),
  ]);

  return {
    checkedAt,
    runtimes: {
      gmic: {
        runtimeKey: 'gmic',
        runtimeName: LOCAL_POST_RUNTIME_GUIDES.gmic.runtimeName,
        status: gmicDetectedPath
          ? gmicVersion?.ok
            ? 'ok'
            : 'error'
          : 'error',
        summary: gmicDetectedPath
          ? gmicVersion?.ok
            ? 'gmic.exe passed self-check via ' + (Array.isArray(gmicVersion?.commandArgs) ? gmicVersion.commandArgs.join(' ') : '--version') + '.'
            : 'gmic.exe was found, but self-check failed.'
          : 'gmic.exe was not detected.',
        detectedPath: gmicDetectedPath,
        executableVerified: Boolean(gmicVersion?.ok),
        installedVersion: String(gmicVersion?.version || '').trim(),
        checkedCommand: gmicVersion?.commandArgs || [],
        stdout: gmicVersion?.probe?.stdout || '',
        stderr: gmicVersion?.probe?.stderr || '',
        elapsedMs: Number(gmicVersion?.probe?.elapsedMs || 0),
        suggestions: gmicDetectedPath
          ? gmicVersion?.ok
            ? ['如刚升级版本，可点"刷新运行时"让节点重新识别']
            : ['确认 gmic.exe 可在命令行直接执行', '如果是便携版，请把真实 exe 路径写入 HMDAO_POST_GMIC_PATH']
          : ['先安装 G\'MIC CLI，再点"一键自检"', 'Windows 常见路径见运行时卡片'],
        update: gmicUpdate,
      },
      oiio: {
        runtimeKey: 'oiio',
        runtimeName: LOCAL_POST_RUNTIME_GUIDES.oiio.runtimeName,
        status: oiioDetectedPath
          ? oiioVersion?.ok
            ? 'ok'
            : 'error'
          : 'error',
        summary: oiioDetectedPath
          ? oiioVersion?.ok
            ? 'oiiotool.exe passed the --version self-check.'
            : 'oiiotool.exe was found, but self-check failed.'
          : 'oiiotool.exe was not detected.',
        detectedPath: oiioDetectedPath,
        executableVerified: Boolean(oiioVersion?.ok),
        installedVersion: String(oiioVersion?.version || '').trim(),
        checkedCommand: oiioVersion?.commandArgs || [],
        stdout: oiioVersion?.probe?.stdout || '',
        stderr: oiioVersion?.probe?.stderr || '',
        elapsedMs: Number(oiioVersion?.probe?.elapsedMs || 0),
        detectedConfigPath: ocioConfigPath,
        configVerified: Boolean(ocioConfigProbe?.ok),
        configSummary: ocioConfigPath
          ? ocioConfigProbe
            ? ocioConfigProbe.ok
              ? 'The current OCIO config passed deep validation through oiiotool.'
              : 'An OCIO config was detected, but oiiotool validation did not pass.'
            : ocioConfigReadable
              ? 'An OCIO config was detected, but oiiotool could not deep-validate it in the current environment.'
              : 'An OCIO config path was detected, but the file is not readable.'
          : 'No OCIO config was detected.',
        configStdout: ocioConfigProbe?.stdout || '',
        configStderr: ocioConfigProbe?.stderr || '',
        suggestions: oiioDetectedPath
          ? oiioVersion?.ok
            ? ['如需严格图片色彩管理，再确认 HMDAO_POST_OIIO_OCIO_CONFIG 的 OCIO 指向正确配置']
            : ['确认 oiiotool.exe 可在命令行直接执行', '检查安装目录是否缺少依赖 DLL']
          : ['先安装 OpenImageIO oiiotool，再点"一键自检"', '安装完成后可设置 HMDAO_POST_OIIO_PATH 指向 oiiotool.exe'],
        update: oiioUpdate,
      },
      ocio: {
        runtimeKey: 'ocio',
        runtimeName: LOCAL_POST_RUNTIME_GUIDES.ocio.runtimeName,
        status: ocioRuntimePath
          ? ocioVersion?.ok
            ? ocioConfigPath
              ? ocioConfigProbe
                ? ocioConfigProbe.ok
                  ? 'ok'
                  : 'warn'
                : ocioConfigReadable
                  ? 'warn'
                  : 'error'
              : 'warn'
            : 'error'
          : 'error',
        summary: ocioRuntimePath
          ? ocioVersion?.ok
            ? ocioConfigPath
              ? ocioConfigProbe
                ? ocioConfigProbe.ok
                  ? 'OpenColorIO Runtime and the current config passed real-chain validation.'
                  : 'OpenColorIO Runtime is installed, but the current config still needs validation.'
                : ocioConfigReadable
                  ? 'OpenColorIO Runtime is installed and waiting for OIIO to deep-validate the current config.'
                  : 'OpenColorIO Runtime is installed, but the current config file is not readable.'
              : 'OpenColorIO Runtime is installed, but no usable config was detected.'
            : 'OpenColorIO Runtime was detected, but self-check failed.'
          : 'OpenColorIO Runtime was not detected.',
        detectedPath: ocioRuntimePath,
        executableVerified: Boolean(ocioVersion?.ok),
        installedVersion: String(ocioVersion?.version || '').trim(),
        runtimeConfigured: Boolean(resolvedOcioBackend.configured),
        commandConfigured: Boolean(resolvedOcioBackend.commandLine),
        detectedConfigPath: ocioConfigPath,
        configVerified: Boolean(ocioConfigProbe?.ok),
        configReadable: ocioConfigReadable,
        checkedCommand: ocioConfigProbe
          ? ['oiiotool', '--colorconfig', ocioConfigPath, '--colorconfiginfo']
          : ocioVersion?.commandArgs || [],
        stdout: ocioConfigProbe?.stdout || ocioVersion?.probe?.stdout || '',
        stderr: ocioConfigProbe?.stderr || ocioVersion?.probe?.stderr || '',
        elapsedMs: Number(ocioConfigProbe?.elapsedMs || ocioVersion?.probe?.elapsedMs || 0),
        suggestions: ocioRuntimePath
          ? ocioVersion?.ok
            ? ocioConfigPath
              ? ocioConfigProbe?.ok
                ? ['如更改 config 文件，点"刷新运行时"后再重新自检']
                : ['当前 OpenColorIO Runtime 已安装。若需深度校验，请继续安装 OpenImageIO oiiotool', '确认 OCIO config 指向官方或可执行的配置文件']
              : ['先安装或同步官方 ACES config，再点"一键自检"']
            : ['确认 ocioconvert.exe 可在命令行直接执行', '检查 OpenColorIO 安装目录是否完整']
          : ['先安装 OpenColorIO Runtime，再点"一键自检"'],
        update: ocioUpdate,
      },
    },
  };
}

function buildLocalPostBackendStatus(key, resolvedBackend, exampleRuntimePath = '') {
  const guide = LOCAL_POST_RUNTIME_GUIDES[key] || {};
  return {
    configured: Boolean(resolvedBackend?.configured),
    commandConfigured: Boolean(resolvedBackend?.commandLine),
    detectedPath: String(resolvedBackend?.detectedPath || '').trim(),
    wrapperScript: LOCAL_POST_BACKEND_WRAPPERS[key] || '',
    exampleRuntimePath,
    runtimeName: String(guide.runtimeName || '').trim(),
    envPath: String(guide.envPath || '').trim(),
    envCommand: String(guide.envCommand || '').trim(),
    docsUrl: String(guide.docsUrl || '').trim(),
    downloadUrl: String(guide.downloadUrl || '').trim(),
    installHint: String(guide.installHint || '').trim(),
    successHint: String(guide.successHint || '').trim(),
    commonInstallPaths: Array.isArray(guide.commonInstallPaths) ? guide.commonInstallPaths.map((item) => String(item || '').trim()).filter(Boolean) : [],
    supportsImage: guide.supportsImage !== false,
    supportsVideo: Boolean(guide.supportsVideo),
    detectedConfigPath: String(resolvedBackend?.detectedConfigPath || '').trim(),
  };
}

function resolveLocalPostUpscaleBackend(config = {}, mediaKind = 'image') {
  const resolvedRoute = resolvePostUpscaleRoute(config);
  const executionMode = String(config.executionMode || 'auto').trim();
  const commandMap = {
    'fsr-preview': { envCommand: 'HMDAO_POST_FSR_COMMAND', envPath: 'HMDAO_POST_FSR_PATH', label: 'FSR' },
    realbasicvsr: { envCommand: 'HMDAO_POST_REALBASICVSR_COMMAND', envPath: 'HMDAO_POST_REALBASICVSR_PATH', label: 'RealBasicVSR' },
    supir: { envCommand: 'HMDAO_POST_SUPIR_COMMAND', envPath: 'HMDAO_POST_SUPIR_PATH', label: 'SUPIR' },
  };
  const routeMeta = commandMap[resolvedRoute] || null;
  const { commandLine, detectedPath } = routeMeta
    ? resolveLocalPostWrapperCommand({
      envCommand: routeMeta.envCommand,
      envPath: routeMeta.envPath,
      wrapperKey: resolvedRoute,
    })
    : { commandLine: '', detectedPath: '' };
  return {
    resolvedRoute,
    label: routeMeta?.label || resolvedRoute,
    commandLine,
    detectedPath,
    wrapperAllowed: executionMode !== 'fallback-only',
    fallbackAllowed: executionMode !== 'wrapper-only',
    mediaKind,
    configured: Boolean(commandLine),
  };
}

function resolveLocalPostOcioBackend(config = {}) {
  const executionMode = String(config.ocioExecutionMode || 'auto').trim();
  const envCommand = String(process.env.HMDAO_POST_OCIO_COMMAND || '').trim();
  const envPath = String(process.env.HMDAO_POST_OCIO_PATH || '').trim();
  const managedRuntimePath = detectManagedLocalPostOcioPath();
  const wrapperScript = LOCAL_POST_BACKEND_WRAPPERS.ocio;
  const managedWrapperScript = LOCAL_POST_BACKEND_WRAPPERS['ocio-managed'];
  const commandLine = envCommand
    || (envPath && wrapperScript ? `node "${wrapperScript}"` : '')
    || (managedRuntimePath && managedWrapperScript ? `node "${managedWrapperScript}"` : '');
  const detectedPath = envPath || managedRuntimePath || '';
  return {
    label: 'OCIO',
    commandLine,
    detectedPath,
    detectedConfigPath: detectLocalPostOiioConfigPath(),
    managedRuntime: Boolean(!envCommand && !envPath && managedRuntimePath),
    wrapperAllowed: executionMode !== 'fallback-only',
    fallbackAllowed: executionMode !== 'wrapper-only',
    configured: Boolean(commandLine),
  };
}

function resolveLocalPostOiioBackend(config = {}, mediaKind = 'image', ocioConfigPath = '') {
  const executionMode = String(config.ocioExecutionMode || 'auto').trim();
  const commandLineFromEnv = String(process.env.HMDAO_POST_OIIO_COMMAND || '').trim();
  const detectedPath = detectLocalPostOiioPath();
  const detectedConfigPath = String(ocioConfigPath || detectLocalPostOiioConfigPath()).trim();
  const commandLine = commandLineFromEnv || (detectedPath ? `node "${LOCAL_POST_BACKEND_WRAPPERS.oiio}"` : '');
  return {
    label: 'OIIO + OCIO',
    commandLine,
    detectedPath,
    detectedConfigPath,
    wrapperAllowed: mediaKind === 'image' && executionMode !== 'fallback-only',
    fallbackAllowed: executionMode !== 'wrapper-only',
    configured: Boolean(commandLine && detectedConfigPath),
    runtimeConfigured: Boolean(commandLine),
    mediaKind,
  };
}

function resolveLocalPostGmicBackend() {
  const commandLineFromEnv = String(process.env.HMDAO_POST_GMIC_COMMAND || '').trim();
  const detectedPath = detectLocalPostGmicPath();
  const wrapperScript = LOCAL_POST_BACKEND_WRAPPERS.gmic;
  const commandLine = commandLineFromEnv || (detectedPath && wrapperScript ? `node "${wrapperScript}"` : '');
  return {
    label: 'G\'MIC',
    commandLine,
    detectedPath,
    wrapperAllowed: true,
    fallbackAllowed: true,
    configured: Boolean(commandLine),
  };
}

async function runConfiguredPostUpscaleBackend(resolvedBackend, payload) {
  if (!resolvedBackend.commandLine) return null;
  const requestPayload = {
    requestId: payload.requestId,
    route: resolvedBackend.resolvedRoute,
    mediaKind: payload.mediaKind,
    inputPath: payload.inputPath,
    outputPath: payload.outputPath,
    scale: payload.scale,
    denoise: payload.denoise,
    sharpen: payload.sharpen,
    tileSize: payload.tileSize,
    seamFix: payload.seamFix,
    temporalStability: payload.temporalStability,
    gpuTier: payload.gpuTier,
  };
  const { parsed } = await runJsonWrapperCommand(resolvedBackend.commandLine, requestPayload, {
    cwd: APP_DIR,
    fallbackOutputPath: payload.outputPath,
    payloadPath: path.join(LOCAL_POST_EDIT_DIR, `${payload.requestId}-upscale-wrapper.json`),
  });
  const outputPath = String(parsed.outputPath || payload.outputPath || '').trim();
  const outputBase64 = String(parsed.outputBase64 || '').trim();
  if (outputBase64) {
    await fs.writeFile(payload.outputPath, Buffer.from(outputBase64, 'base64'));
  } else if (outputPath && outputPath !== payload.outputPath) {
    await fs.copyFile(outputPath, payload.outputPath);
  }
  if (!(await fileExists(payload.outputPath))) {
    throw new Error(`local-post-upscale-empty:${resolvedBackend.resolvedRoute}`);
  }
  return {
    outputPath: payload.outputPath,
    engine: String(parsed.engine || resolvedBackend.label),
    meta: parsed?.meta && typeof parsed.meta === 'object' ? parsed.meta : {},
  };
}

async function runConfiguredDepthBackend(commandLine, payload) {
  if (!commandLine) return null;
  const { parsed } = await runJsonWrapperCommand(commandLine, payload, {
    cwd: APP_DIR,
    fallbackOutputPath: payload.outputPath,
    payloadPath: path.join(LOCAL_POST_EDIT_DIR, `${payload.requestId}-depth-wrapper.json`),
  });
  const outputPath = String(parsed.outputPath || payload.outputPath || '').trim();
  const outputBase64 = String(parsed.outputBase64 || '').trim();
  if (outputBase64) {
    await fs.writeFile(payload.outputPath, Buffer.from(outputBase64, 'base64'));
  } else if (outputPath && outputPath !== payload.outputPath) {
    await fs.copyFile(outputPath, payload.outputPath);
  }
  if (!(await fileExists(payload.outputPath))) {
    throw new Error('local-post-depth-empty');
  }
  return {
    outputPath: payload.outputPath,
    engine: String(parsed.engine || 'Depth Anything V2'),
  };
}

async function runConfiguredPostOcioBackend(resolvedBackend, payload) {
  if (!resolvedBackend.commandLine) return null;
  const requestPayload = {
    ...payload,
    runtimePath: resolvedBackend.detectedPath,
    defaultOcioConfigPath: resolvedBackend.detectedConfigPath,
  };
  const { parsed } = await runJsonWrapperCommand(resolvedBackend.commandLine, requestPayload, {
    cwd: APP_DIR,
    fallbackOutputPath: payload.outputPath,
    payloadPath: path.join(LOCAL_POST_EDIT_DIR, `${payload.requestId}-ocio-wrapper.json`),
  });
  const outputPath = String(parsed.outputPath || payload.outputPath || '').trim();
  const outputBase64 = String(parsed.outputBase64 || '').trim();
  if (outputBase64) {
    await fs.writeFile(payload.outputPath, Buffer.from(outputBase64, 'base64'));
  } else if (outputPath && outputPath !== payload.outputPath) {
    await fs.copyFile(outputPath, payload.outputPath);
  }
  if (!(await fileExists(payload.outputPath))) {
    throw new Error('local-post-ocio-empty');
  }
  return {
    outputPath: payload.outputPath,
    engine: String(parsed.engine || resolvedBackend.label),
    meta: parsed?.meta && typeof parsed.meta === 'object' ? parsed.meta : {},
    warnings: Array.isArray(parsed?.warnings) ? parsed.warnings.map((item) => String(item)) : [],
  };
}

async function runConfiguredPostOiioBackend(resolvedBackend, payload) {
  if (!resolvedBackend.commandLine) return null;
  const requestPayload = {
    ...payload,
    runtimePath: resolvedBackend.detectedPath,
    defaultOcioConfigPath: resolvedBackend.detectedConfigPath,
  };
  const { parsed } = await runJsonWrapperCommand(resolvedBackend.commandLine, requestPayload, {
    cwd: APP_DIR,
    fallbackOutputPath: payload.outputPath,
    payloadPath: path.join(LOCAL_POST_EDIT_DIR, `${payload.requestId}-oiio-wrapper.json`),
  });
  const outputPath = String(parsed.outputPath || payload.outputPath || '').trim();
  const outputBase64 = String(parsed.outputBase64 || '').trim();
  if (outputBase64) {
    await fs.writeFile(payload.outputPath, Buffer.from(outputBase64, 'base64'));
  } else if (outputPath && outputPath !== payload.outputPath) {
    await fs.copyFile(outputPath, payload.outputPath);
  }
  if (!(await fileExists(payload.outputPath))) {
    throw new Error('local-post-oiio-empty');
  }
  return {
    outputPath: payload.outputPath,
    engine: String(parsed.engine || resolvedBackend.label),
    meta: parsed?.meta && typeof parsed.meta === 'object' ? parsed.meta : {},
    warnings: Array.isArray(parsed?.warnings) ? parsed.warnings.map((item) => String(item)) : [],
  };
}

async function runConfiguredPostGmicBackend(resolvedBackend, payload) {
  if (!resolvedBackend.commandLine) return null;
  const requestPayload = {
    ...payload,
    runtimePath: resolvedBackend.detectedPath,
  };
  const { parsed } = await runJsonWrapperCommand(resolvedBackend.commandLine, requestPayload, {
    cwd: APP_DIR,
    fallbackOutputPath: payload.outputPath,
    payloadPath: path.join(LOCAL_POST_EDIT_DIR, `${payload.requestId}-gmic-wrapper.json`),
  });
  const outputPath = String(parsed.outputPath || payload.outputPath || '').trim();
  const outputBase64 = String(parsed.outputBase64 || '').trim();
  if (outputBase64) {
    await fs.writeFile(payload.outputPath, Buffer.from(outputBase64, 'base64'));
  } else if (outputPath && outputPath !== payload.outputPath) {
    await fs.copyFile(outputPath, payload.outputPath);
  }
  if (!(await fileExists(payload.outputPath))) {
    throw new Error('local-post-gmic-empty');
  }
  return {
    outputPath: payload.outputPath,
    engine: String(parsed.engine || resolvedBackend.label),
    meta: parsed?.meta && typeof parsed.meta === 'object' ? parsed.meta : {},
    warnings: Array.isArray(parsed?.warnings) ? parsed.warnings.map((item) => String(item)) : [],
  };
}

function buildPostColorFilter(config = {}, lutPath = '') {
  const exposure = clampNumber(config.exposure, -1, 1, 0);
  const contrast = 1 + clampNumber(config.contrast, -0.8, 1.2, 0.08) * 0.6;
  const saturation = clampNumber(config.saturation, 0, 2.5, 1);
  const hue = clampNumber(config.hue, -180, 180, 0);
  const vibrance = clampNumber(config.vibrance, -1, 1, 0.12);
  const temperature = clampNumber(config.temperature, -1, 1, 0);
  const tint = clampNumber(config.tint, -1, 1, 0);
  const lift = clampNumber(config.lift, -1, 1, 0);
  const gain = clampNumber(config.gain, 0.2, 2.6, 1);
  const gamma = clampNumber(config.gamma, 0.2, 3, 1);
  const secondaryHueCenter = clampNumber(config.secondaryHueCenter, 0, 360, 180);
  const secondaryHueRange = clampNumber(config.secondaryHueRange, 5, 180, 60);
  const secondarySaturationBias = clampNumber(config.secondarySaturationBias, -1, 1, 0);
  const secondaryLumaBias = clampNumber(config.secondaryLumaBias, -1, 1, 0);
  const offset = clampNumber(config.offset, -1, 1, 0);
  const offsetColor = hexToRgbUnit(config.offsetColor, { r: 0.5, g: 0.5, b: 0.5 });
  const offsetAmount = clampNumber(config.offsetAmount, 0, 1, 0.08);
  const outMin = clampNumber(0.5 - contrast * 0.5 + exposure * 0.18 + lift * 0.08, 0, 0.45, 0);
  const outMax = clampNumber(0.5 + contrast * 0.5 + exposure * 0.18, 0.55, 1, 1);
  const midInput = 0.5;
  const midOutput = clampNumber(Math.pow(midInput, 1 / gamma), 0.18, 0.82, 0.5);
  const filters = [
    `colorlevels=romin=${outMin.toFixed(3)}:gomin=${outMin.toFixed(3)}:bomin=${outMin.toFixed(3)}:romax=${outMax.toFixed(3)}:gomax=${outMax.toFixed(3)}:bomax=${outMax.toFixed(3)}`,
    buildColorWheelFilter(config),
    `colorbalance=rs=${(temperature * 0.12).toFixed(3)}:bs=${(-temperature * 0.12).toFixed(3)}:gm=${(-tint * 0.08).toFixed(3)}:bm=${(tint * 0.08).toFixed(3)}:rh=${((offsetColor.r - 0.5) * Math.abs(offset) * offsetAmount).toFixed(3)}:gh=${((offsetColor.g - 0.5) * Math.abs(offset) * offsetAmount).toFixed(3)}:bh=${((offsetColor.b - 0.5) * Math.abs(offset) * offsetAmount).toFixed(3)}`,
    `hue=h=${hue.toFixed(2)}:s=${gain.toFixed(3)}`,
    `vibrance=intensity=${vibrance.toFixed(3)}`,
    `curves=all='0/0 ${midInput.toFixed(2)}/${midOutput.toFixed(2)} 1/1'`,
    buildCurveFilter(config),
  ];
  const filmPrint = String(config.filmPrint || 'none').trim();
  if (filmPrint === 'kodak-2383') {
    filters.push('curves=all=\'0/0 0.45/0.42 1/1\'');
  } else if (filmPrint === 'kodak-5219') {
    filters.push('curves=all=\'0/0 0.48/0.44 1/1\'');
  } else if (filmPrint === 'fuji-3513') {
    filters.push('curves=all=\'0/0 0.52/0.56 1/1\'');
  }
  if (Math.abs(saturation - 1) > 0.01) {
    filters.push(`hue=s=${saturation.toFixed(3)}`);
  }
  if (Math.abs(secondarySaturationBias) > 0.01 || Math.abs(secondaryLumaBias) > 0.01) {
    const qualifierWeight = clampNumber(secondaryHueRange / 180, 0.1, 1, 0.33);
    const secondaryMid = clampNumber(0.5 + secondaryLumaBias * qualifierWeight * 0.05, 0.42, 0.58, 0.5);
    filters.push(`hue=s=${clampNumber(1 + secondarySaturationBias * qualifierWeight * 0.22, 0.6, 1.6, 1).toFixed(3)}`);
    filters.push(`curves=all='0/0 0.50/${secondaryMid.toFixed(3)} 1/1'`);
  }
  const ocioView = String(config.ocioView || 'default').trim();
  if (ocioView === 'filmic') {
    filters.push(`curves=all='0/0 0.18/0.12 0.75/0.84 1/1'`);
  } else if (ocioView === 'aces') {
    filters.push('colorlevels=romin=0.000:gomin=0.000:bomin=0.000:romax=1.000:gomax=1.000:bomax=1.000');
    filters.push('hue=s=1.030');
    filters.push("curves=all='0/0 0.50/0.520 1/1'");
  }
  filters.push(...buildOcioLikeFilter(config));
  if (lutPath && isSupportedLutFile(lutPath)) {
    filters.push(`lut3d=file='${escapeFfmpegFilterPath(lutPath)}'`);
  }
  return filters.join(',');
}

function buildPostUpscaleFilter(config = {}, meta = { width: 0, height: 0 }, mediaKind = 'image') {
  const scale = clampNumber(config.scale, 1, 8, 2);
  const denoise = clampNumber(config.denoise, 0, 1, 0.18);
  const sharpen = clampNumber(config.sharpen, 0, 1, 0.34);
  const resolvedRoute = resolvePostUpscaleRoute(config);
  const tileSize = clampNumber(config.tileSize, 256, 2048, 768);
  const seamFix = Boolean(config.seamFix);
  const temporalStability = clampNumber(config.temporalStability, 0, 1, 0.65);
  const outWidth = evenSize((meta.width || 2) * scale, meta.width || 2);
  const outHeight = evenSize((meta.height || 2) * scale, meta.height || 2);
  const scaleFlags = resolvedRoute === 'fsr-preview' ? 'bicubic' : resolvedRoute === 'supir' ? 'spline' : 'lanczos';
  const filters = [`scale=${outWidth}:${outHeight}:flags=${scaleFlags}`];
  if (denoise > 0.01) {
    // 当前本机 ffmpeg 构建不包含 hqdn3d，回退到稳定可用的 gblur 轻降噪
    const sigmaBase = resolvedRoute === 'supir' ? 1.2 : resolvedRoute === 'fsr-preview' ? 0.8 : 1;
    filters.push(`gblur=sigma=${clampNumber(denoise * 1.6 * sigmaBase, 0.05, 2.4, 0.24).toFixed(2)}`);
  }
  if (sharpen > 0.01) {
    const sharpenBoost = resolvedRoute === 'supir' ? 2.8 : resolvedRoute === 'fsr-preview' ? 1.9 : 2.4;
    filters.push(`unsharp=7:7:${(0.25 + sharpen * sharpenBoost).toFixed(2)}:7:7:0`);
  }
  if (seamFix && tileSize < 900) {
    // Keep seam smoothing on a filter that exists in the stock ffmpeg builds we ship against.
    filters.push('gblur=sigma=0.28:steps=1');
  }
  if (mediaKind === 'video' && temporalStability > 0.55) {
    filters.push(`tmix=frames=2:weights='${(1 - temporalStability * 0.18).toFixed(2)} ${(temporalStability * 0.18).toFixed(2)}'`);
  }
  if (resolvedRoute === 'supir') {
    filters.push('colorlevels=romin=0.000:gomin=0.000:bomin=0.000:romax=1.000:gomax=1.000:bomax=1.000');
    filters.push('hue=s=1.030');
    filters.push("curves=all='0/0 0.50/0.515 1/1'");
  }
  return filters.join(',');
}

function buildPostBloomFilterComplex(config = {}) {
  const threshold = Math.round(clampNumber(config.threshold, 0.1, 1, 0.76) * 255);
  const radius = clampNumber(config.radius, 1, 64, 16);
  const intensity = clampNumber(config.intensity, 0, 1.4, 0.34);
  const rgbShift = clampNumber(config.rgbSplit, 0, 0.2, 0.04);
  const shift = Math.max(0, Math.round(rgbShift * 12));
  return [
    `[0:v]split=2[base][glow]`,
    `[glow]lutyuv=y='if(gte(val,${threshold}),val,0)',gblur=sigma=${radius.toFixed(2)},rgbashift=rh=${shift}:rv=0:gh=0:gv=0:bh=${-shift}:bv=0,colorchannelmixer=aa=${clampNumber(intensity * 0.9, 0, 1, 0.3).toFixed(3)}[bloom]`,
    `[base][bloom]blend=all_mode=${bloomBlendMode(String(config.blendMode || 'screen'))}:all_opacity=${clampNumber(intensity, 0, 1, 0.34).toFixed(3)}[vout]`,
  ].join(';');
}

function buildPostDofFilterComplex(config = {}, meta = { width: 0, height: 0 }, depthMaskPath = '') {
  const focusWidth = Math.max(8, Math.round((clampNumber(config.focusWidth, 4, 100, 48) / 100) * meta.width));
  const focusHeight = Math.max(8, Math.round((clampNumber(config.focusHeight, 4, 100, 42) / 100) * meta.height));
  const focusX = Math.max(0, Math.min(meta.width - focusWidth, Math.round((clampNumber(config.focusX, 0, 100, 50) / 100) * meta.width) - Math.round(focusWidth / 2)));
  const focusY = Math.max(0, Math.min(meta.height - focusHeight, Math.round((clampNumber(config.focusY, 0, 100, 50) / 100) * meta.height) - Math.round(focusHeight / 2)));
  const blurStrength = clampNumber(config.blurStrength, 0, 1.4, 0.4);
  const depthBlend = clampNumber(config.depthBlend, 0, 1, 0.72);
  const tiltShift = Boolean(config.tiltShift);
  const transitionPreset = String(config.transitionPreset || 'soft').trim();
  const transitionBoost = transitionPreset === 'hard' ? 0.82 : transitionPreset === 'cinematic' ? 1.28 : 1;
  const effectiveFocusHeight = tiltShift ? Math.max(6, Math.round(focusHeight * 0.6)) : focusHeight;
  const effectiveFocusY = tiltShift ? Math.max(0, Math.min(meta.height - effectiveFocusHeight, focusY + Math.round((focusHeight - effectiveFocusHeight) / 2))) : focusY;
  const blurSigma = Math.max(0.8, blurStrength * (8 + depthBlend * 12) * transitionBoost);
  if (depthMaskPath) {
    return [
      `[0:v]gblur=sigma=${blurSigma.toFixed(2)}[blurred]`,
      `[1:v]format=gray,scale=${meta.width}:${meta.height}[mask]`,
      `[blurred][0:v][mask]maskedmerge[vout]`,
    ].join(';');
  }
  return [
    `[0:v]gblur=sigma=${blurSigma.toFixed(2)}[blurred]`,
    `[0:v]crop=${focusWidth}:${effectiveFocusHeight}:${focusX}:${effectiveFocusY}[sharp]`,
    `[blurred][sharp]overlay=${focusX}:${effectiveFocusY}[vout]`,
  ].join(';');
}

function buildPostGrainFilter(config = {}, mediaKind = 'image') {
  const iso = clampNumber(config.iso, 100, 6400, 800);
  const amount = clampNumber(config.amount, 0, 1, 0.24);
  const size = clampNumber(config.size, 0.5, 4, 1.4);
  const chroma = clampNumber(config.chroma, 0, 1, 0.18);
  const shadowBoost = clampNumber(config.shadowBoost, 0, 1, 0.2);
  const distribution = String(config.distribution || 'poisson').trim();
  const flags = mediaKind === 'video' ? 't+u' : 'u';
  const distributionBoost = distribution === 'lognormal' ? 0.92 : distribution === 'gaussian' ? 0.86 : 1;
  const strength = Math.max(1, Math.round((iso / 200) * (amount * 14 + size * 3.5 + chroma * 4.2 + shadowBoost * 3.8) * distributionBoost));
  return `noise=alls=${strength}:allf=${flags}`;
}

async function writePostAssetInput(baseDir, requestId, asset) {
  const key = String(asset?.key || '').trim();
  if (!key) return null;
  const uploadedPath = String(asset?.uploadedPath || '').trim();
  if (uploadedPath) return uploadedPath;
  const sourceUrl = String(asset?.sourceUrl || '').trim();
  const inputBase64 = String(asset?.inputBase64 || '').trim();
  if (!sourceUrl && !inputBase64) return null;
  const ext = extensionFromMimeType(
    asset?.inputMimeType
      || asset?.originalName
      || (asset?.kind === 'video' ? 'video/mp4' : 'image/png'),
  );
  const filePath = path.join(baseDir, `${requestId}-${key}.${ext}`);
  if (inputBase64) {
    await fs.writeFile(filePath, Buffer.from(inputBase64, 'base64'));
  } else {
    const remote = await downloadRemoteMediaBuffer(sourceUrl);
    await fs.writeFile(filePath, remote.bytes);
  }
  return filePath;
}

async function runPostStep({
  mediaKind,
  inputPath,
  outputPath,
  filter,
  filterComplex,
  extraInputs = [],
  map = '[vout]',
  stage = 'post-step',
}) {
  const args = ['-y', '-i', inputPath];
  for (const extraInput of extraInputs) {
    args.push('-i', extraInput);
  }
  if (filterComplex) {
    args.push('-filter_complex', filterComplex, '-map', map);
  } else if (filter) {
    args.push('-vf', filter);
  }
  args.push(...(mediaKind === 'video' ? buildIntermediateVideoArgs(outputPath) : buildIntermediateImageArgs(outputPath)));
  try {
    await runCommand('ffmpeg', args);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error || 'unknown-error');
    throw new Error(`${stage} failed: ${detail}`);
  }
  if (!(await fileExists(outputPath))) {
    throw new Error(`${stage} produced no output: ${outputPath}; ffmpegArgs=${args.join(' ')}`);
  }
}

async function finalizePostVideo(processedPath, originalInputPath, outputPath) {
  await runCommand('ffmpeg', [
    '-y',
    '-i',
    processedPath,
    '-i',
    originalInputPath,
    '-map',
    '0:v:0',
    '-map',
    '1:a?',
    ...buildWebmEncodeArgs(outputPath, { includeAudio: true }),
  ]);
}

async function processLocalPostRequest(payload) {
  const mediaKind = payload?.mediaKind === 'video' ? 'video' : 'image';
  const uploadedInputPath = String(payload?.inputPath || '').trim();
  const inputBase64 = String(payload?.inputBase64 || '').trim();
  const sourceUrl = String(payload?.sourceUrl || '').trim();
  if (!uploadedInputPath && !inputBase64 && !/^https?:\/\//i.test(sourceUrl)) {
    throw new Error('local-post-input-missing');
  }

  await fs.mkdir(LOCAL_POST_EDIT_DIR, { recursive: true });
  const requestId = crypto.randomUUID();
  const inputExt = extensionFromMimeType(payload?.inputMimeType || (mediaKind === 'video' ? 'video/mp4' : 'image/png'));
  const inputPath = uploadedInputPath || path.join(LOCAL_POST_EDIT_DIR, `${requestId}-input.${inputExt}`);
  const finalPath = path.join(LOCAL_POST_EDIT_DIR, `${requestId}-final.${mediaKind === 'video' ? 'webm' : 'png'}`);
  const tempPaths = [];
  const assetPaths = [];
  const warnings = [];
  const processingMeta = {
    appliedStages: [],
  };
  let persistedResultPath = '';

  try {
    if (uploadedInputPath) {
      // File already landed on disk during multipart upload.
    } else if (inputBase64) {
      await fs.writeFile(inputPath, Buffer.from(inputBase64, 'base64'));
    } else {
      const remote = await downloadRemoteMediaBuffer(sourceUrl);
      await fs.writeFile(inputPath, remote.bytes);
    }

    const assetsByKey = new Map();
    for (const asset of Array.isArray(payload?.assets) ? payload.assets : []) {
      const filePath = await writePostAssetInput(LOCAL_POST_EDIT_DIR, requestId, asset);
      if (filePath) {
        assetsByKey.set(String(asset.key), filePath);
        assetPaths.push(filePath);
      }
    }

    let currentPath = inputPath;
    let currentMeta = mediaKind === 'video' ? await probeVideoFile(inputPath) : await probeImageFile(inputPath);
    const effects = payload?.effects && typeof payload.effects === 'object' ? payload.effects : {};
    let stepIndex = 0;

    const color = effects.color && typeof effects.color === 'object' ? effects.color : null;
    if (color?.enabled) {
      const colorLutPath = assetsByKey.get('color-lut') || '';
      let ocioConfigPath = assetsByKey.get('color-ocio-config') || '';
      const resolvedOcioBackend = resolveLocalPostOcioBackend(color);
      let ocioConfigInspection = null;
      if (color.lutAssetUrl && !colorLutPath) {
        warnings.push('已选择 LUT，但当前没有可读取的 LUT 文件，已跳过 LUT 应用');
      } else if (colorLutPath && !isSupportedLutFile(colorLutPath)) {
        warnings.push('当前仅支持 .cube / .3dl LUT 文件，已跳过不支持的 LUT');
      }
      if (String(color.ocioConfig || '').trim() === 'custom-file') {
        if (!ocioConfigPath) {
          if (String(color.ocioExecutionMode || '').trim() === 'wrapper-only') {
            throw new Error('当前已切换到"仅 Wrapper + 自定义 .ocio"，但没有上传可读取的 OCIO 配置文件');
          }
          warnings.push('已切换到自定义 OCIO Config，但当前没有可读取的 config 文件，已回退到默认 OCIO 策略');
        } else if (!isSupportedOcioConfigFile(ocioConfigPath)) {
          if (String(color.ocioExecutionMode || '').trim() === 'wrapper-only') {
            throw new Error('当前自定义 OCIO Config 文件格式不在支持范围内，且执行模式为 Wrapper');
          }
          warnings.push('当前自定义 OCIO Config 文件扩展名不在支持范围内，已回退到默认 OCIO 策略');
          ocioConfigPath = '';
        } else {
          ocioConfigInspection = await inspectOcioConfigFile(ocioConfigPath);
          if (!ocioConfigInspection.structurallyValid) {
            if (String(color.ocioExecutionMode || '').trim() === 'wrapper-only') {
              throw new Error(`当前自定义 OCIO Config 不可执行{ocioConfigInspection.message}`);
            }
            warnings.push(`当前自定义 OCIO Config 结构不可执行，已回退到默认 OCIO 策略{ocioConfigInspection.message}`);
            ocioConfigPath = '';
          } else if (!ocioConfigInspection.executable) {
            if (String(color.ocioExecutionMode || '').trim() === 'wrapper-only') {
              throw new Error(`当前自定义 OCIO Config 缺少完整执行路由{ocioConfigInspection.message}`);
            }
            warnings.push(`当前自定义 OCIO Config 缺少完整执行路由{ocioConfigInspection.message}`);
          }
        }
      } else if (ocioConfigPath && !isSupportedOcioConfigFile(ocioConfigPath)) {
        warnings.push('检测到附带的 OCIO Config 文件扩展名不在支持范围，当前已忽略');
        ocioConfigPath = '';
      }
      const resolvedOiioBackend = resolveLocalPostOiioBackend(color, mediaKind, ocioConfigPath);
      if (String(color.ocioExecutionMode || '').trim() === 'fallback-only' && String(color.ocioConfig || '').trim() === 'custom-file' && ocioConfigPath) {
        warnings.push('当前执行模式为仅本地回退，自定义 .ocio 不会调用外部 Wrapper，只会保留近似调色风格');
      }
      if (String(color.ocioExecutionMode || '').trim() === 'wrapper-only' && !resolvedOcioBackend.configured && !resolvedOiioBackend.configured) {
        throw new Error('当前 OCIO 执行模式为仅 Wrapper，但后端没有检测到可用的 OIIO / OCIO Runtime');
      }
      const nextPath = postTempPath(LOCAL_POST_EDIT_DIR, requestId, stepIndex++, mediaKind);
      let oiioApplied = false;
      let oiioWrapperResult = null;
      let ocioWrapperApplied = false;
      let ocioWrapperResult = null;
      if (resolvedOiioBackend.wrapperAllowed && resolvedOiioBackend.configured) {
        try {
          oiioWrapperResult = await runConfiguredPostOiioBackend(resolvedOiioBackend, {
            requestId,
            mediaKind,
            route: 'oiio',
            inputPath: currentPath,
            outputPath: nextPath,
            lutPath: colorLutPath,
            ocioConfigPath,
            colorConfig: color,
          });
          oiioApplied = true;
          warnings.push(...(oiioWrapperResult?.warnings || []));
        } catch (error) {
          if (!resolvedOiioBackend.fallbackAllowed && !resolvedOcioBackend.configured) {
            throw error;
          }
          warnings.push('OIIO 严格图片调色执行失败，当前已继续尝试 OCIO wrapper / 本地调色链路');
        }
      } else if (resolvedOiioBackend.wrapperAllowed && resolvedOiioBackend.runtimeConfigured && !resolvedOiioBackend.configured) {
        warnings.push('已检测到 oiiotool，但缺少可用的 OCIO Config，当前先继续尝试 OCIO wrapper / 本地调色链路');
      }
      if (!oiioApplied && resolvedOcioBackend.wrapperAllowed && resolvedOcioBackend.configured) {
        try {
          ocioWrapperResult = await runConfiguredPostOcioBackend(resolvedOcioBackend, {
            requestId,
            mediaKind,
            route: 'ocio',
            inputPath: currentPath,
            outputPath: nextPath,
            lutPath: colorLutPath,
            ocioConfigPath,
            colorConfig: color,
          });
          ocioWrapperApplied = true;
          warnings.push(...(ocioWrapperResult?.warnings || []));
        } catch (error) {
          if (!resolvedOcioBackend.fallbackAllowed) {
            throw error;
          }
          warnings.push('OCIO wrapper 执行失败，当前已自动回退到本地调色链路');
        }
      } else if (!oiioApplied && resolvedOcioBackend.wrapperAllowed && !resolvedOcioBackend.configured && !resolvedOcioBackend.fallbackAllowed) {
        throw new Error('OCIO wrapper 未配置，且当前执行模式禁止回退');
      } else if (!oiioApplied && resolvedOcioBackend.wrapperAllowed && !resolvedOcioBackend.configured) {
        warnings.push('OCIO wrapper 未配置，当前先走本地调色链路');
      }
      if (!oiioApplied && !ocioWrapperApplied) {
        await runPostStep({
          mediaKind,
          inputPath: currentPath,
          outputPath: nextPath,
          filter: buildPostColorFilter(color, colorLutPath),
          stage: 'post-color',
        });
      }
      processingMeta.ocioBackendLabel = oiioApplied
        ? String(oiioWrapperResult?.engine || resolvedOiioBackend.label)
        : ocioWrapperApplied
          ? String(ocioWrapperResult?.engine || resolvedOcioBackend.label)
        : 'ffmpeg-post-fallback';
      processingMeta.ocioWrapperConfigured = Boolean(resolvedOcioBackend.configured || resolvedOiioBackend.configured);
      processingMeta.ocioWrapperApplied = Boolean(oiioApplied || ocioWrapperApplied);
      processingMeta.oiioBackendLabel = oiioApplied ? String(oiioWrapperResult?.engine || resolvedOiioBackend.label) : '';
      processingMeta.oiioWrapperConfigured = Boolean(resolvedOiioBackend.runtimeConfigured);
      processingMeta.oiioWrapperApplied = oiioApplied;
      processingMeta.oiioDetectedPath = resolvedOiioBackend.detectedPath || '';
      processingMeta.oiioDetectedConfigPath = resolvedOiioBackend.detectedConfigPath || '';
      processingMeta.oiioWrapperMeta = oiioWrapperResult?.meta || {};
      processingMeta.ocioConfigMode = String(color.ocioConfig || 'builtin');
      processingMeta.ocioExecutionMode = String(color.ocioExecutionMode || 'auto');
      processingMeta.ocioConfigPath = ocioConfigPath || '';
      processingMeta.ocioConfigName = ocioConfigPath ? path.basename(ocioConfigPath) : '';
      processingMeta.ocioConfigFormat = ocioConfigInspection?.formatLabel || '';
      processingMeta.ocioConfigProfileVersion = ocioConfigInspection?.profileVersion || '';
      processingMeta.ocioConfigDetectedSections = ocioConfigInspection?.detectedSections || [];
      processingMeta.ocioConfigStructurallyValid = Boolean(ocioConfigInspection?.structurallyValid);
      processingMeta.ocioConfigExecutable = Boolean(ocioConfigInspection?.executable);
      processingMeta.ocioConfigValidationMessage = ocioConfigInspection?.message || '';
      processingMeta.ocioWrapperMeta = ocioWrapperResult?.meta || {};
      processingMeta.appliedStages.push({
        id: 'color',
        route: oiioApplied ? 'oiio-wrapper' : ocioWrapperApplied ? 'ocio-wrapper' : 'ffmpeg-color-fallback',
        engine: oiioApplied
          ? String(oiioWrapperResult?.engine || resolvedOiioBackend.label)
          : ocioWrapperApplied
            ? String(ocioWrapperResult?.engine || resolvedOcioBackend.label)
            : 'ffmpeg-post-stack',
      });
      tempPaths.push(nextPath);
      currentPath = nextPath;
      currentMeta = mediaKind === 'video' ? await probeVideoFile(currentPath) : await probeImageFile(currentPath);
    }

    const upscale = effects.upscale && typeof effects.upscale === 'object' ? effects.upscale : null;
    if (upscale?.enabled) {
      const nextPath = postTempPath(LOCAL_POST_EDIT_DIR, requestId, stepIndex++, mediaKind);
      const resolvedBackend = resolveLocalPostUpscaleBackend(upscale, mediaKind);
      let upscaleWrapperResult = null;
      let upscaleFallbackReason = '';
      let wrapperApplied = false;
      if (resolvedBackend.wrapperAllowed && resolvedBackend.configured) {
        try {
          upscaleWrapperResult = await runConfiguredPostUpscaleBackend(resolvedBackend, {
            requestId,
            mediaKind,
            inputPath: currentPath,
            outputPath: nextPath,
            scale: clampNumber(upscale.scale, 1, 8, 2),
            denoise: clampNumber(upscale.denoise, 0, 1, 0.18),
            sharpen: clampNumber(upscale.sharpen, 0, 1, 0.34),
            tileSize: clampNumber(upscale.tileSize, 256, 2048, 768),
            seamFix: Boolean(upscale.seamFix),
            temporalStability: clampNumber(upscale.temporalStability, 0, 1, 0.65),
            gpuTier: String(upscale.gpuTier || '8g-safe').trim(),
          });
          wrapperApplied = true;
        } catch (error) {
          upscaleFallbackReason = error instanceof Error ? error.message : 'upscale-wrapper-failed';
          if (!resolvedBackend.fallbackAllowed) {
            throw error;
          }
          warnings.push(resolvedBackend.label + ' wrapper failed, automatically fell back to the local FFmpeg enhancement path.');
        }
      } else if (resolvedBackend.wrapperAllowed && !resolvedBackend.configured && !resolvedBackend.fallbackAllowed) {
        throw new Error(resolvedBackend.label + ' wrapper is not configured, and fallback is disabled in the current execution mode.');
      } else if (resolvedBackend.wrapperAllowed && !resolvedBackend.configured) {
        upscaleFallbackReason = 'wrapper-not-configured';
        warnings.push(resolvedBackend.label + ' wrapper is not configured, so the local FFmpeg enhancement path is being used first.');
      }
      if (!wrapperApplied) {
        await runPostStep({
          mediaKind,
          inputPath: currentPath,
          outputPath: nextPath,
          filter: buildPostUpscaleFilter(upscale, currentMeta, mediaKind),
          stage: 'post-upscale',
        });
      }
      tempPaths.push(nextPath);
      currentPath = nextPath;
      currentMeta = mediaKind === 'video' ? await probeVideoFile(currentPath) : await probeImageFile(currentPath);
      processingMeta.upscaleBackendLabel = wrapperApplied
        ? String(upscaleWrapperResult?.engine || resolvedBackend.label)
        : 'ffmpeg-post-stack';
      processingMeta.upscaleWrapperConfigured = Boolean(resolvedBackend.configured);
      processingMeta.upscaleWrapperApplied = wrapperApplied;
      processingMeta.upscaleResolvedRoute = String(resolvedBackend.resolvedRoute || '');
      processingMeta.upscaleExecutionMode = String(upscale.executionMode || 'auto');
      processingMeta.upscaleRoutePolicy = String(upscale.routePolicy || 'auto');
      processingMeta.upscaleModel = String(upscale.model || 'realesrgan-balanced');
      processingMeta.upscaleScale = clampNumber(upscale.scale, 1, 8, 2);
      processingMeta.upscaleTileSize = clampNumber(upscale.tileSize, 256, 2048, 768);
      processingMeta.upscaleGpuTier = String(upscale.gpuTier || '8g-safe').trim();
      processingMeta.upscaleFallbackReason = upscaleFallbackReason;
      processingMeta.upscaleWrapperMeta = upscaleWrapperResult?.meta || {};
      processingMeta.appliedStages.push({
        id: 'upscale',
        route: wrapperApplied ? `${resolvedBackend.resolvedRoute}-wrapper` : 'ffmpeg-upscale-fallback',
        engine: wrapperApplied ? String(upscaleWrapperResult?.engine || resolvedBackend.label) : 'ffmpeg-post-stack',
      });
    }

    const dof = effects.dof && typeof effects.dof === 'object' ? effects.dof : null;
    if (dof?.enabled) {
      let dofDepthMaskPath = assetsByKey.get('dof-depth-mask') || '';
      if (!dofDepthMaskPath && dof.engine === 'depth-anything-v2-small') {
        const { commandLine: depthCommand } = resolveLocalPostWrapperCommand({
          envCommand: 'HMDAO_POST_DEPTH_ANYTHING_COMMAND',
          envPath: 'HMDAO_POST_DEPTH_ANYTHING_PATH',
          wrapperKey: 'depth',
        });
        if (depthCommand) {
          const generatedDepthPath = path.join(LOCAL_POST_EDIT_DIR, `${requestId}-depth-mask.png`);
          try {
            const depthResult = await runConfiguredDepthBackend(depthCommand, {
              requestId,
              inputPath: currentPath,
              outputPath: generatedDepthPath,
              mediaKind,
              strength: clampNumber(dof.autoDepthStrength, 0, 1, 0.68),
            });
            dofDepthMaskPath = depthResult?.outputPath || generatedDepthPath;
            assetPaths.push(generatedDepthPath);
          } catch (error) {
            warnings.push('自动深度估计执行失败，当前回退到手动焦区链路');
          }
        } else {
          warnings.push('Depth Anything 本地 wrapper 未配置，当前回退到手动焦区链路');
        }
      }
      if (dof.bokehAssetUrl && !assetsByKey.get('dof-bokeh')) {
        warnings.push('已选择自定义 Bokeh，但当前没有可读取的光圈贴图，已回退到基础散景形状');
      } else if (assetsByKey.get('dof-bokeh') && !isSupportedBokehFile(assetsByKey.get('dof-bokeh'))) {
        warnings.push('当前仅支持 PNG / WebP Bokeh 贴图，已回退到基础散景形状');
      }
      const nextPath = postTempPath(LOCAL_POST_EDIT_DIR, requestId, stepIndex++, mediaKind);
      const extraInputs = dofDepthMaskPath ? [dofDepthMaskPath] : [];
      await runPostStep({
        mediaKind,
        inputPath: currentPath,
        outputPath: nextPath,
        extraInputs,
        filterComplex: buildPostDofFilterComplex(dof, currentMeta, dofDepthMaskPath),
        stage: 'post-dof',
      });
      tempPaths.push(nextPath);
      currentPath = nextPath;
      currentMeta = mediaKind === 'video' ? await probeVideoFile(currentPath) : await probeImageFile(currentPath);
    }

    const bloom = effects.bloom && typeof effects.bloom === 'object' ? effects.bloom : null;
    const grain = effects.grain && typeof effects.grain === 'object' ? effects.grain : null;
    const resolvedGmicBackend = resolveLocalPostGmicBackend();
    const gmicDetailEnabled = mediaKind === 'image' && upscale?.enabled && (
      clampNumber(upscale.denoise, 0, 1, 0.18) > 0.01
      || clampNumber(upscale.sharpen, 0, 1, 0.34) > 0.01
      || String(upscale.mode || 'balanced').trim() === 'detail'
      || String(upscale.model || '').trim() === 'supir-detail'
    );
    const shouldTryGmic = mediaKind === 'image' && resolvedGmicBackend.configured && (
      Boolean(bloom?.enabled)
      || Boolean(grain?.enabled)
      || gmicDetailEnabled
    );
    let gmicHandledBloom = false;
    let gmicHandledGrain = false;
    if ((bloom?.enabled || grain?.enabled) && mediaKind !== 'image') {
      warnings.push('G\'MIC 当前只接入图片后期链路；视频上的 Bloom / Grain 继续走 FFmpeg 回退');
    }
    if (shouldTryGmic) {
      const nextPath = postTempPath(LOCAL_POST_EDIT_DIR, requestId, stepIndex++, mediaKind);
      let gmicFallbackReason = '';
      let gmicResult = null;
      try {
        gmicResult = await runConfiguredPostGmicBackend(resolvedGmicBackend, {
          requestId,
          mediaKind,
          route: 'gmic',
          inputPath: currentPath,
          outputPath: nextPath,
          bloomConfig: bloom?.enabled ? bloom : { enabled: false },
          grainConfig: grain?.enabled ? grain : { enabled: false },
          detailConfig: {
            enabled: gmicDetailEnabled,
            denoise: clampNumber(upscale?.denoise, 0, 1, 0.18),
            sharpen: clampNumber(upscale?.sharpen, 0, 1, 0.34),
            mode: String(upscale?.mode || 'balanced').trim(),
          },
        });
        warnings.push(...(gmicResult?.warnings || []));
        gmicHandledBloom = Boolean(bloom?.enabled);
        gmicHandledGrain = Boolean(grain?.enabled);
        tempPaths.push(nextPath);
        currentPath = nextPath;
        currentMeta = await probeImageFile(currentPath);
      } catch (error) {
        gmicFallbackReason = error instanceof Error ? error.message : 'gmic-wrapper-failed';
        warnings.push('G\'MIC 真实处理执行失败，当前已回退到 FFmpeg Bloom / Grain 链路');
      }
      processingMeta.gmicBackendLabel = gmicResult
        ? String(gmicResult.engine || resolvedGmicBackend.label)
        : 'ffmpeg-post-fallback';
      processingMeta.gmicWrapperConfigured = Boolean(resolvedGmicBackend.configured);
      processingMeta.gmicWrapperApplied = Boolean(gmicResult);
      processingMeta.gmicFallbackReason = gmicFallbackReason;
      processingMeta.gmicDetectedPath = resolvedGmicBackend.detectedPath || '';
      processingMeta.gmicStagesApplied = Array.isArray(gmicResult?.meta?.stagesApplied)
        ? gmicResult.meta.stagesApplied
        : [];
      processingMeta.gmicWrapperMeta = gmicResult?.meta || {};
      if (gmicResult) {
        processingMeta.appliedStages.push({
          id: 'gmic',
          route: 'gmic-wrapper',
          engine: String(gmicResult.engine || resolvedGmicBackend.label),
        });
      }
    } else {
      processingMeta.gmicBackendLabel = resolvedGmicBackend.configured ? resolvedGmicBackend.label : 'ffmpeg-post-fallback';
      processingMeta.gmicWrapperConfigured = Boolean(resolvedGmicBackend.configured);
      processingMeta.gmicWrapperApplied = false;
      processingMeta.gmicFallbackReason = resolvedGmicBackend.configured ? '' : 'wrapper-not-configured';
      processingMeta.gmicDetectedPath = resolvedGmicBackend.detectedPath || '';
      processingMeta.gmicStagesApplied = [];
      processingMeta.gmicWrapperMeta = {};
    }

    if (bloom?.enabled && !gmicHandledBloom) {
      const nextPath = postTempPath(LOCAL_POST_EDIT_DIR, requestId, stepIndex++, mediaKind);
      await runPostStep({
        mediaKind,
        inputPath: currentPath,
        outputPath: nextPath,
        filterComplex: buildPostBloomFilterComplex(bloom),
        stage: 'post-bloom',
      });
      tempPaths.push(nextPath);
      currentPath = nextPath;
      currentMeta = mediaKind === 'video' ? await probeVideoFile(currentPath) : await probeImageFile(currentPath);
    }

    if (grain?.enabled && !gmicHandledGrain) {
      const nextPath = postTempPath(LOCAL_POST_EDIT_DIR, requestId, stepIndex++, mediaKind);
      await runPostStep({
        mediaKind,
        inputPath: currentPath,
        outputPath: nextPath,
        filter: buildPostGrainFilter(grain, mediaKind),
        stage: 'post-grain',
      });
      tempPaths.push(nextPath);
      currentPath = nextPath;
      currentMeta = mediaKind === 'video' ? await probeVideoFile(currentPath) : await probeImageFile(currentPath);
    }

    const matting = effects.matting && typeof effects.matting === 'object' ? effects.matting : null;
    if (matting?.enabled) {
      const maskPath = assetsByKey.get('matting-mask');
      const backgroundPath = assetsByKey.get('matting-background');
      if (!maskPath) {
        warnings.push('抠像已启用，但当前没有可执行的蒙版素材，已跳过');
      } else {
        const nextPath = postTempPath(LOCAL_POST_EDIT_DIR, requestId, stepIndex++, mediaKind);
        const bgPath = backgroundPath || null;
        const baseInputs = bgPath ? [bgPath, maskPath] : [maskPath];
        const fillColor = 'black';
        const baseGraph = bgPath
          ? [
              `[1:v]scale=${currentMeta.width}:${currentMeta.height}[bg]`,
              `[2:v]format=gray,scale=${currentMeta.width}:${currentMeta.height}[mask]`,
              `[bg][0:v][mask]maskedmerge[vout]`,
            ]
          : [
              `color=c=${fillColor}:s=${currentMeta.width}x${currentMeta.height}[bg]`,
              `[1:v]format=gray,scale=${currentMeta.width}:${currentMeta.height}[mask]`,
              `[bg][0:v][mask]maskedmerge[vout]`,
            ];
        await runPostStep({
          mediaKind,
          inputPath: currentPath,
          outputPath: nextPath,
          extraInputs: baseInputs,
          filterComplex: baseGraph.join(';'),
          stage: 'post-matting',
        });
        tempPaths.push(nextPath);
        currentPath = nextPath;
        currentMeta = mediaKind === 'video' ? await probeVideoFile(currentPath) : await probeImageFile(currentPath);
        if (matting.engine !== 'upload-mask') {
          warnings.push('Matting is currently using the uploaded-mask path first; the ' + String(matting.engine) + ' wrapper entry is reserved but not mounted locally yet.');
        }
      }
    }

    const tracking = effects.tracking && typeof effects.tracking === 'object' ? effects.tracking : null;
    if (tracking?.enabled && Array.isArray(tracking.tracks) && tracking.tracks.length > 0) {
      const usableTracks = tracking.tracks
        .map((track) => ({ track, path: assetsByKey.get(`tracking-${track.id}`) }))
        .filter((item) => item.path);
      if (!usableTracks.length) {
        warnings.push('运动跟踪已启用，但当前没有可叠加的素材，已跳过');
      } else {
        const nextPath = postTempPath(LOCAL_POST_EDIT_DIR, requestId, stepIndex++, mediaKind);
        const filterLines = ['[0:v]setpts=PTS-STARTPTS[base0]'];
        const extraInputs = [];
        let inputIndex = 1;
        usableTracks.forEach((item, index) => {
          extraInputs.push(item.path);
          const scale = clampNumber(item.track.scale, 0.1, 4, 1);
          const rotation = clampNumber(item.track.rotation, -180, 180, 0);
          const opacity = clampNumber(item.track.opacity, 0, 1, 1);
          filterLines.push(
            `[${inputIndex}:v]scale=iw*${scale.toFixed(3)}:ih*${scale.toFixed(3)},rotate=${rotation.toFixed(4)}*PI/180:c=none:ow=rotw(${rotation.toFixed(4)}*PI/180):oh=roth(${rotation.toFixed(4)}*PI/180),format=rgba,colorchannelmixer=aa=${opacity.toFixed(3)}[ov${index}]`,
          );
          const overlayX = `(W-w)*${(clampNumber(item.track.x, 0, 100, 50) / 100).toFixed(4)}`;
          const overlayY = `(H-h)*${(clampNumber(item.track.y, 0, 100, 50) / 100).toFixed(4)}`;
          const enable = mediaKind === 'video'
            ? `:enable='between(t,${clampNumber(item.track.startTime, 0, 9999, 0).toFixed(3)},${clampNumber(item.track.endTime, 0, 9999, Math.max(item.track.startTime || 0, 5)).toFixed(3)})'`
            : '';
          filterLines.push(`[base${index}][ov${index}]overlay=x=${overlayX}:y=${overlayY}:format=auto${enable}[base${index + 1}]`);
          inputIndex += 1;
          if (item.track.tracker === 'cotracker3-wrapper') {
            warnings.push('Tracking lane ' + (item.track.label || item.track.id) + ' is currently using manual overlay first; the CoTracker3 wrapper entry is reserved.');
          }
        });
        await runPostStep({
          mediaKind,
          inputPath: currentPath,
          outputPath: nextPath,
          extraInputs,
          filterComplex: filterLines.join(';'),
          map: `[base${usableTracks.length}]`,
          stage: 'post-tracking',
        });
        tempPaths.push(nextPath);
        currentPath = nextPath;
        currentMeta = mediaKind === 'video' ? await probeVideoFile(currentPath) : await probeImageFile(currentPath);
      }
    }

    if (mediaKind === 'video') {
      await finalizePostVideo(currentPath, inputPath, finalPath);
    } else {
      await fs.copyFile(currentPath, finalPath);
    }

    const outputMeta = mediaKind === 'video' ? await probeVideoFile(finalPath) : await probeImageFile(finalPath);
    const persisted = await persistLocalPostResultFile(finalPath, requestId, mediaKind);
    persistedResultPath = persisted.persistedPath;
    const outputStat = await fs.stat(persistedResultPath);
    return {
      format: mediaKind === 'video' ? 'webm' : 'png',
      mimeType: mediaKind === 'video' ? 'video/webm' : 'image/png',
      outputAssetId: persisted.assetId,
      outputUrl: persisted.outputUrl,
      size: Number(outputStat.size || 0),
      width: outputMeta.width,
      height: outputMeta.height,
      duration: outputMeta.duration,
      processingEngine: Array.isArray(processingMeta.appliedStages) && processingMeta.appliedStages.length > 0
        ? processingMeta.appliedStages.map((item) => String(item.engine || item.route || 'post-stage')).join(' + ')
        : 'ffmpeg-post-stack',
      warnings,
      processingMeta,
    };
  } finally {
    const cleanupPaths = [inputPath, finalPath, ...tempPaths, ...assetPaths]
      .filter((cleanupPath) => cleanupPath && cleanupPath !== persistedResultPath);
    for (const cleanupPath of cleanupPaths) {
      await fs.rm(cleanupPath, { force: true }).catch(() => {});
    }
  }
}

async function processLocalVideoEditRequest(payload) {
  const operation = String(payload?.operation || '').trim();
  if (!['crop', 'clip', 'hd', 'parse', 'removeSubtitle', 'audioSplit', 'audioMix'].includes(operation)) {
    throw new Error(`unsupported-local-video-operation:${operation || 'unknown'}`);
  }

  const inputBase64 = String(payload?.inputBase64 || '').trim();
  const sourceUrl = String(payload?.sourceUrl || '').trim();
  if (!inputBase64 && !/^https?:\/\//i.test(sourceUrl)) {
    throw new Error('local-video-input-missing');
  }

  await fs.mkdir(LOCAL_VIDEO_EDIT_DIR, { recursive: true });
  const requestId = crypto.randomUUID();
  const inputExt = extensionFromMimeType(payload?.inputMimeType || 'video/mp4');
  const inputPath = path.join(LOCAL_VIDEO_EDIT_DIR, `${requestId}-input.${inputExt}`);
  const outputPath = path.join(LOCAL_VIDEO_EDIT_DIR, `${requestId}-output.webm`);
  const mixedOutputPath = path.join(LOCAL_VIDEO_EDIT_DIR, `${requestId}-mixed.webm`);
  const tempVideoOutputPath = path.join(LOCAL_VIDEO_EDIT_DIR, `${requestId}-output.mp4`);
  const audioOutputPath = path.join(LOCAL_VIDEO_EDIT_DIR, `${requestId}-audio.wav`);
  const vocalOutputPath = path.join(LOCAL_VIDEO_EDIT_DIR, `${requestId}-vocal.wav`);
  const accompanimentOutputPath = path.join(LOCAL_VIDEO_EDIT_DIR, `${requestId}-accompaniment.wav`);
  let linkedAudioPath = null;
  const persistedResultPaths = [];

  try {
    linkedAudioPath = await downloadOrWriteAudioInput(requestId, payload);
    if (inputBase64) {
      await fs.writeFile(inputPath, Buffer.from(inputBase64, 'base64'));
    } else {
      const remote = await downloadRemoteMediaBuffer(sourceUrl);
      await fs.writeFile(inputPath, remote.bytes);
    }
    const sourceMeta = await probeVideoFile(inputPath);
    if (!sourceMeta.width || !sourceMeta.height) {
      throw new Error('local-video-source-metadata-missing');
    }
    const linkedAudioMixMode = String(payload?.audioMixMode || payload?.linkedAudioMixMode || '').trim();
    const linkedAudioGain = clampNumber(payload?.audioGain ?? payload?.linkedAudioGain, 0, 2, 1);
    const linkedVideoGain = clampNumber(payload?.videoGain ?? payload?.linkedVideoGain, 0, 2, linkedAudioMixMode === 'voiceover-dub' ? 0.3 : 0.74);
    let processingEngine = '';

    if (operation === 'crop') {
      const rect = payload?.rect || {};
      const cropX = Math.max(0, Math.min(sourceMeta.width - 2, Math.round((Number(rect.x || 0) / 100) * sourceMeta.width)));
      const cropY = Math.max(0, Math.min(sourceMeta.height - 2, Math.round((Number(rect.y || 0) / 100) * sourceMeta.height)));
      const cropWidth = Math.max(2, Math.round((Number(rect.width || 100) / 100) * sourceMeta.width));
      const cropHeight = Math.max(2, Math.round((Number(rect.height || 100) / 100) * sourceMeta.height));
      const outputWidth = Math.max(2, Math.min(cropWidth, sourceMeta.width - cropX));
      const outputHeight = Math.max(2, Math.min(cropHeight, sourceMeta.height - cropY));

      await runCommand('ffmpeg', [
        '-y',
        '-i',
        inputPath,
        '-vf',
        `crop=${outputWidth}:${outputHeight}:${cropX}:${cropY}`,
        ...buildWebmEncodeArgs(outputPath, { includeAudio: true }),
      ]);
    } else if (operation === 'clip') {
      const normalizedSegments = normalizeClipSegments(payload?.segments, sourceMeta.duration);
      if (!normalizedSegments.length) {
        throw new Error('local-video-clip-segments-empty');
      }

      const args = normalizedSegments.length === 1
        ? [
          '-y',
          '-i',
          inputPath,
          '-ss',
          String(normalizedSegments[0].startTime),
          '-t',
          String(Number((normalizedSegments[0].endTime - normalizedSegments[0].startTime).toFixed(3))),
          ...buildWebmEncodeArgs(outputPath, { includeAudio: true }),
        ]
        : [
          '-y',
          '-i',
          inputPath,
          '-filter_complex',
          [
            ...normalizedSegments.map(
              (segment, index) => `[0:v]trim=start=${segment.startTime}:end=${segment.endTime},setpts=PTS-STARTPTS[v${index}]`,
            ),
            `${normalizedSegments.map((_, index) => `[v${index}]`).join('')}concat=n=${normalizedSegments.length}:v=1:a=0[vout]`,
          ].join(';'),
          '-map',
          '[vout]',
          ...buildWebmEncodeArgs(outputPath),
        ];
      await runCommand('ffmpeg', args);
    } else if (operation === 'hd') {
      const scale = clampNumber(payload?.scale, 1, 4, 2);
      const detailStrength = clampNumber(payload?.detailStrength, 0, 1, 0.58);
      const sharpen = clampNumber(payload?.sharpen, 0, 1, 0.36);
      const targetFps = payload?.interpolate60fps ? 60 : 24;
      const outputWidth = evenSize(sourceMeta.width * scale, sourceMeta.width);
      const outputHeight = evenSize(sourceMeta.height * scale, sourceMeta.height);
      const lumaAmount = Number((0.35 + sharpen * 2.6).toFixed(2));
      const filterChain = [
        `scale=${outputWidth}:${outputHeight}:flags=lanczos`,
        `unsharp=7:7:${lumaAmount}:7:7:0`,
        `fps=${targetFps}`,
      ].join(',');
      await runCommand('ffmpeg', [
        '-y',
        '-i',
        inputPath,
        '-vf',
        filterChain,
        ...buildWebmEncodeArgs(outputPath, { includeAudio: true }),
      ]);
    } else if (operation === 'removeSubtitle') {
      const feather = clampNumber(payload?.maskFeather, 0, 32, 8);
      const detectionMode = String(payload?.detectionMode || 'auto').trim();
      const requestedSubtitleEngine = String(payload?.subtitleEngine || 'auto').trim().toLowerCase();
      const rawRegion = payload?.region && typeof payload.region === 'object' ? payload.region : {};
      const manualX = clampNumber(rawRegion?.x ?? payload?.regionX ?? 12, 0, 95, 12);
      const manualY = clampNumber(rawRegion?.y ?? payload?.regionY ?? 80, 0, 95, 80);
      const manualWidth = clampNumber(rawRegion?.width ?? payload?.regionWidth ?? 76, 4, 100 - manualX, 76);
      const manualHeight = clampNumber(rawRegion?.height ?? payload?.regionHeight ?? 12, 4, 100 - manualY, 12);
      let subtitleEngine = 'opencv-telea';
      if (requestedSubtitleEngine === 'video-subtitle-remover') {
        subtitleEngine = 'video-subtitle-remover-requested -> opencv-telea';
      } else if (requestedSubtitleEngine === 'propainter') {
        subtitleEngine = 'propainter-requested -> opencv-telea';
      }
      try {
        await runLocalSubtitleRemoval({
          inputPath,
          tempOutputPath: tempVideoOutputPath,
          detectionMode,
          manualX,
          manualY,
          manualWidth,
          manualHeight,
          feather,
        });
        await runCommand('ffmpeg', [
          '-y',
          '-i',
          tempVideoOutputPath,
          '-i',
          inputPath,
          '-map',
          '0:v:0',
          '-map',
          '1:a?',
          ...buildWebmEncodeArgs(outputPath, { includeAudio: true }),
        ]);
      } catch (pythonRemoveError) {
        subtitleEngine = subtitleEngine.includes('requested')
          ? `${subtitleEngine} -> ffmpeg-patch-blend`
          : 'ffmpeg-patch-blend';
        const autoHeightPercent = 14;
        const regionPercent = detectionMode === 'manual'
          ? { x: manualX, y: manualY, width: manualWidth, height: manualHeight }
          : { x: 0, y: 100 - autoHeightPercent, width: 100, height: autoHeightPercent };
        const expandPx = Math.max(2, Math.round(feather));
        const regionX = Math.max(0, Math.round((regionPercent.x / 100) * sourceMeta.width) - expandPx);
        const regionY = Math.max(0, Math.round((regionPercent.y / 100) * sourceMeta.height) - expandPx);
        const regionWidth = Math.max(16, Math.min(sourceMeta.width - regionX, Math.round((regionPercent.width / 100) * sourceMeta.width) + expandPx * 2));
        const regionHeight = Math.max(16, Math.min(sourceMeta.height - regionY, Math.round((regionPercent.height / 100) * sourceMeta.height) + expandPx * 2));
        const patchSourceY = regionY > regionHeight + expandPx
          ? Math.max(0, regionY - regionHeight)
          : Math.min(Math.max(0, sourceMeta.height - regionHeight), regionY + regionHeight);
        const patchSourceX = Math.max(0, Math.min(sourceMeta.width - regionWidth, regionX));
        const blurSigma = Number(Math.max(0.6, feather / 4).toFixed(2));
        const filterChain = [
          `[0:v]split=2[base][fillsrc]`,
          `[fillsrc]crop=${regionWidth}:${regionHeight}:${patchSourceX}:${patchSourceY},gblur=sigma=${blurSigma}[fill]`,
          `[base][fill]overlay=${regionX}:${regionY}:format=auto[vout]`,
        ].join(';');
        await runCommand('ffmpeg', [
          '-y',
          '-i',
          inputPath,
          '-filter_complex',
          filterChain,
          '-map',
          '[vout]',
          '-map',
          '0:a?',
          ...buildWebmEncodeArgs(outputPath, { includeAudio: true }),
        ]);
      }
      const outputMeta = await probeVideoFile(outputPath);
      const persistedVideo = await persistLocalResultFile(LOCAL_VIDEO_RESULT_DIR, outputPath, requestId, 'webm');
      persistedResultPaths.push(persistedVideo.persistedPath);
      const videoStat = await fs.stat(persistedVideo.persistedPath);
      return {
        format: 'webm',
        mimeType: 'video/webm',
        outputAssetId: persistedVideo.assetId,
        outputUrl: `/api/local-video/result/${encodeURIComponent(persistedVideo.assetId)}`,
        size: Number(videoStat.size || 0),
        width: outputMeta.width,
        height: outputMeta.height,
        duration: outputMeta.duration,
        processingEngine: subtitleEngine,
      };
    } else if (operation === 'audioSplit') {
      const keepAudioInVideo = Boolean(payload?.keepVocalInVideo);
      const sourceStreams = await probeMediaStreams(inputPath);
      let splitEngine = 'demucs-v4';
      let processingNotice = '';
      if (!sourceStreams.hasAudio) {
        splitEngine = 'silent-audio-fallback';
        processingNotice = 'source-video-has-no-audio-track';
        await runCommand('ffmpeg', [
          '-y',
          '-i',
          inputPath,
          ...buildWebmEncodeArgs(outputPath, { includeAudio: false }),
        ]);
        await createSilentAudioFile(audioOutputPath, sourceMeta.duration, { sampleRate: 48000, channels: 2 });
        await fs.copyFile(audioOutputPath, vocalOutputPath);
        await fs.copyFile(audioOutputPath, accompanimentOutputPath);
      } else {
        try {
          await runDemucsAudioSplit({
            inputPath,
            requestId,
            outputPath,
            audioOutputPath,
            vocalOutputPath,
            accompanimentOutputPath,
            keepAudioInVideo,
          });
        } catch {
          splitEngine = 'ffmpeg-approximate';
          await runCommand('ffmpeg', [
            '-y',
            '-i',
            inputPath,
            '-vn',
            '-acodec',
            'pcm_s16le',
            audioOutputPath,
          ]);
          await runCommand('ffmpeg', [
            '-y',
            '-i',
            inputPath,
            '-vn',
            '-af',
            'pan=mono|c0=0.5*c0+0.5*c1,highpass=f=180',
            '-acodec',
            'pcm_s16le',
            vocalOutputPath,
          ]);
          await runCommand('ffmpeg', [
            '-y',
            '-i',
            inputPath,
            '-vn',
            '-af',
            'pan=stereo|c0=c0|c1=c1,lowpass=f=220,volume=0.9',
            '-acodec',
            'pcm_s16le',
            accompanimentOutputPath,
          ]);
          await runCommand('ffmpeg', [
            '-y',
            '-i',
            inputPath,
            ...(keepAudioInVideo ? [] : ['-an']),
            ...buildWebmEncodeArgs(outputPath, { includeAudio: keepAudioInVideo }),
          ]);
        }
      }
      const [outputMeta, audioMeta, vocalMeta, accompanimentMeta] = await Promise.all([
        probeVideoFile(outputPath),
        probeAudioFile(audioOutputPath),
        probeAudioFile(vocalOutputPath),
        probeAudioFile(accompanimentOutputPath),
      ]);
      const persistedVideo = await persistLocalResultFile(LOCAL_VIDEO_RESULT_DIR, outputPath, `${requestId}-video`, 'webm');
      const persistedAudio = await persistLocalResultFile(LOCAL_AUDIO_RESULT_DIR, audioOutputPath, `${requestId}-audio`, 'wav');
      const persistedVocal = await persistLocalResultFile(LOCAL_AUDIO_RESULT_DIR, vocalOutputPath, `${requestId}-vocal`, 'wav');
      const persistedAccompaniment = await persistLocalResultFile(LOCAL_AUDIO_RESULT_DIR, accompanimentOutputPath, `${requestId}-accompaniment`, 'wav');
      persistedResultPaths.push(
        persistedVideo.persistedPath,
        persistedAudio.persistedPath,
        persistedVocal.persistedPath,
        persistedAccompaniment.persistedPath,
      );
      const [videoStat, audioStat, vocalStat, accompanimentStat] = await Promise.all([
        fs.stat(persistedVideo.persistedPath),
        fs.stat(persistedAudio.persistedPath),
        fs.stat(persistedVocal.persistedPath),
        fs.stat(persistedAccompaniment.persistedPath),
      ]);
      return {
        kind: 'audioSplit',
        format: 'webm',
        mimeType: 'video/webm',
        outputAssetId: persistedVideo.assetId,
        outputUrl: `/api/local-video/result/${encodeURIComponent(persistedVideo.assetId)}`,
        size: Number(videoStat.size || 0),
        width: outputMeta.width,
        height: outputMeta.height,
        duration: outputMeta.duration,
        audioFormat: 'wav',
        audioMimeType: 'audio/wav',
        audioOutputAssetId: persistedAudio.assetId,
        audioOutputUrl: `/api/local-audio/result/${encodeURIComponent(persistedAudio.assetId)}`,
        audioSize: Number(audioStat.size || 0),
        audioDuration: audioMeta.duration,
        audioSampleRate: audioMeta.sampleRate,
        audioChannels: audioMeta.channels,
        vocalFormat: 'wav',
        vocalMimeType: 'audio/wav',
        vocalOutputAssetId: persistedVocal.assetId,
        vocalOutputUrl: `/api/local-audio/result/${encodeURIComponent(persistedVocal.assetId)}`,
        vocalSize: Number(vocalStat.size || 0),
        vocalDuration: vocalMeta.duration,
        vocalSampleRate: vocalMeta.sampleRate,
        vocalChannels: vocalMeta.channels,
        accompanimentFormat: 'wav',
        accompanimentMimeType: 'audio/wav',
        accompanimentOutputAssetId: persistedAccompaniment.assetId,
        accompanimentOutputUrl: `/api/local-audio/result/${encodeURIComponent(persistedAccompaniment.assetId)}`,
        accompanimentSize: Number(accompanimentStat.size || 0),
        accompanimentDuration: accompanimentMeta.duration,
        accompanimentSampleRate: accompanimentMeta.sampleRate,
        accompanimentChannels: accompanimentMeta.channels,
        processingEngine: splitEngine,
        processingNotice,
      };
    } else if (operation === 'parse') {
      const sampleFps = clampNumber(payload?.sampleFps, 1, 10, 2);
      let summary = null;
      try {
        summary = await runLocalParseAnalysis(inputPath, sampleFps, {
          sceneEngine: payload?.sceneEngine,
          semanticEngine: payload?.semanticEngine,
        });
        if (shouldEnhanceVideoParseWithImageInterrogation(payload?.semanticEngine)) {
          summary = await enhanceVideoParseWithImageAnalysis(summary, {
            semanticEngine: payload?.semanticEngine || 'clip-interrogator',
          });
        }
      } catch {
        const sceneCuts = await detectSceneCuts(inputPath, 0.24, 12);
        summary = buildParseSummary(sceneCuts, sourceMeta, sampleFps);
      }
      return {
        kind: 'analysis',
        analysis: {
          ...summary,
          width: sourceMeta.width,
          height: sourceMeta.height,
          duration: sourceMeta.duration,
        },
      };
    } else if (operation === 'audioMix') {
      if (!linkedAudioPath) {
        throw new Error('local-video-linked-audio-missing');
      }
      processingEngine = await mixExternalAudioIntoVideo({
        videoPath: inputPath,
        audioPath: linkedAudioPath,
        outputPath,
        mixMode: linkedAudioMixMode || 'bgm-under',
        audioGain: linkedAudioGain,
        videoGain: linkedVideoGain,
      });
    }

    if (linkedAudioPath && ['crop', 'clip', 'hd', 'removeSubtitle'].includes(operation)) {
      processingEngine = await mixExternalAudioIntoVideo({
        videoPath: outputPath,
        audioPath: linkedAudioPath,
        outputPath: mixedOutputPath,
        mixMode: linkedAudioMixMode || 'bgm-under',
        audioGain: linkedAudioGain,
        videoGain: linkedVideoGain,
      });
      await fs.rename(mixedOutputPath, outputPath).catch(async () => {
        await fs.copyFile(mixedOutputPath, outputPath);
        await fs.rm(mixedOutputPath, { force: true }).catch(() => {});
      });
    }

    const outputMeta = await probeVideoFile(outputPath);
    const persistedVideo = await persistLocalResultFile(LOCAL_VIDEO_RESULT_DIR, outputPath, requestId, 'webm');
    persistedResultPaths.push(persistedVideo.persistedPath);
    const videoStat = await fs.stat(persistedVideo.persistedPath);
    return {
      format: 'webm',
      mimeType: 'video/webm',
      outputAssetId: persistedVideo.assetId,
      outputUrl: `/api/local-video/result/${encodeURIComponent(persistedVideo.assetId)}`,
      size: Number(videoStat.size || 0),
      width: outputMeta.width,
      height: outputMeta.height,
      duration: outputMeta.duration,
      processingEngine,
    };
  } finally {
    await fs.rm(inputPath, { force: true }).catch(() => {});
    if (!persistedResultPaths.includes(outputPath)) {
      await fs.rm(outputPath, { force: true }).catch(() => {});
    }
    await fs.rm(mixedOutputPath, { force: true }).catch(() => {});
    if (!persistedResultPaths.includes(audioOutputPath)) {
      await fs.rm(audioOutputPath, { force: true }).catch(() => {});
    }
    if (!persistedResultPaths.includes(vocalOutputPath)) {
      await fs.rm(vocalOutputPath, { force: true }).catch(() => {});
    }
    if (!persistedResultPaths.includes(accompanimentOutputPath)) {
      await fs.rm(accompanimentOutputPath, { force: true }).catch(() => {});
    }
    if (linkedAudioPath) {
      await fs.rm(linkedAudioPath, { force: true }).catch(() => {});
    }
  }
}

async function readUsers() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(USERS_FILE, 'utf8');
    const normalized = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    return JSON.parse(normalized);
  } catch {
    return [];
  }
}

async function writeUsers(users) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

function normalizeLocalEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidLocalEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeLocalEmail(value));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex');
  return { salt, hash };
}

function verifyPassword(password, user) {
  return hashPassword(password, user.salt).hash === user.passwordHash;
}

function deleteSessionsForUser(userId) {
  for (const [refreshToken, session] of sessions.entries()) {
    if (session?.userId === userId) {
      sessions.delete(refreshToken);
    }
  }
}

function createSession(user) {
  const accessToken = crypto.randomBytes(24).toString('hex');
  const refreshToken = crypto.randomBytes(24).toString('hex');
  const expiresAt = Date.now() + 2 * 60 * 60 * 1000;
  sessions.set(refreshToken, { userId: user.id, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 });
  return { access_token: accessToken, refresh_token: refreshToken, expires_at: expiresAt };
}

function publicUser(user) {
  return { id: user.id, email: user.email, created_at: user.createdAt };
}

function sendAuthError(res, status, code, message, extra = {}) {
  return send(res, status, {
    success: false,
    error: {
      code,
      message,
      ...extra,
    },
  });
}

function maskKey(apiKey = '') {
  if (apiKey.length <= 8) return '****';
  return `${apiKey.slice(0, 4)}****${apiKey.slice(-4)}`;
}

function inferMode(endpoint = '') {
  if (endpoint.includes('video')) return 'video';
  if (endpoint.includes('image')) return 'image';
  if (endpoint.includes('audio') || endpoint.includes('tts')) return 'audio';
  return 'llm';
}

function inferNodeTypesFromMode(mode) {
  if (mode === 'image') return ['image'];
  if (mode === 'video') return ['video'];
  if (mode === 'audio') return ['audio'];
  return ['text', 'script', 'storyboard', 'aiapp'];
}

function normalizeCatalogIdentifier(value) {
  return String(value || '').trim().toLowerCase();
}

function relayAliasCatalogId(identifier) {
  const source = String(identifier || '').trim();
  if (!source) return '';
  const matched = RELAY_MODEL_MATCHERS.find((matcher) => matcher.aliases.some((pattern) => pattern.test(source)));
  return String(matched?.catalogId || '').trim();
}

function modelMatchesActivation(record, item) {
  if (!record || !item) return false;
  if (record.mode && record.mode !== item.mode) return false;

  const explicitModels = [
    ...(Array.isArray(record.catalogModelIds) ? record.catalogModelIds : []),
    ...(Array.isArray(record.availableModels)
      ? record.availableModels.flatMap((entry) => [entry?.catalogModelId, entry?.upstreamModel, entry?.id])
      : []),
  ]
    .map((value) => normalizeCatalogIdentifier(value))
    .filter(Boolean);
  if (explicitModels.length) {
    const candidateIds = [item.id, item.upstreamModel, item.model, item.name]
      .map((value) => normalizeCatalogIdentifier(value))
      .filter(Boolean);
    if (candidateIds.some((candidate) => explicitModels.includes(candidate))) return true;
  }

  const requestedModel = normalizeCatalogIdentifier(record.model);
  if (!requestedModel) return true;

  const aliasCatalogId = normalizeCatalogIdentifier(relayAliasCatalogId(record.model));
  const candidateIds = [
    item.id,
    item.upstreamModel,
    item.model,
    item.name,
    aliasCatalogId,
  ]
    .map((value) => normalizeCatalogIdentifier(value))
    .filter(Boolean);
  return candidateIds.includes(requestedModel);
}

function resolveActivatedRelayModel(record, requestedModel = '') {
  const requested = String(requestedModel || '').trim();
  if (!record || !requested) return requested;
  const availableModels = Array.isArray(record.availableModels) ? record.availableModels : [];
  const normalizedRequested = normalizeCatalogIdentifier(requested);
  const normalizedRequestedAlias = normalizeCatalogIdentifier(relayAliasCatalogId(requested));
  const matchScore = (entry = {}) => {
    const upstreamModel = normalizeCatalogIdentifier(entry?.upstreamModel || '');
    const rawId = normalizeCatalogIdentifier(entry?.id || '');
    const rawName = normalizeCatalogIdentifier(entry?.name || '');
    const catalogModelId = normalizeCatalogIdentifier(entry?.catalogModelId || '');
    if (normalizedRequested && [upstreamModel, rawId, rawName].includes(normalizedRequested)) return 4;
    if (normalizedRequestedAlias && [upstreamModel, rawId, rawName].includes(normalizedRequestedAlias)) return 3;
    if (normalizedRequested && catalogModelId === normalizedRequested) return 2;
    if (normalizedRequestedAlias && catalogModelId === normalizedRequestedAlias) return 1;
    return 0;
  };
  const matched = availableModels
    .map((entry) => ({ entry, score: matchScore(entry) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)[0]?.entry || null;
  if (matched) {
    // suanliai.top 的 seedance 有多个分辨率变体。优先选 720p。
    const matchedId = String(matched.upstreamModel || matched.id || '').trim();
    if (/suanliai\.top/i.test(record.endpoint || '') && /seedance/i.test(matchedId)) {
      const preferred = availableModels.find((m) => (m?.id || '').includes('-720p'));
      if (preferred?.id) return String(preferred.id).trim();
    }
    return matchedId;
  }
  const requestedCatalogModel = catalogModelByIdentifier(requested);
  if (
    requestedCatalogModel
    && (!record.provider || requestedCatalogModel.provider === record.provider)
    && (!record.mode || requestedCatalogModel.mode === record.mode)
  ) {
    const upstream = String(requestedCatalogModel.upstreamModel || requestedCatalogModel.id || requested).trim();
    // suanliai.top 的 seedance 有多个分辨率变体（720p/480p/1080p）。
    // 如果用户指定了 resolution=720p，优先匹配对应分辨率的 relay 模型变体。
    const availableModels = Array.isArray(record.availableModels) ? record.availableModels : [];
    if (availableModels.length > 0 && /suanliai\.top/i.test(record.endpoint || '') && /seedance/i.test(upstream)) {
      const preferredModelId = availableModels.find((m) => m?.id?.includes('-720p'))?.id;
      if (preferredModelId) return preferredModelId;
    }
    return upstream;
  }
  return String(record.model || requested).trim();
}

function providerActivationKey(providerId, mode = '') {
  return mode ? `${providerId}::${mode}` : providerId;
}

// 视觉/多模态模型识别：用于图片分析链路优先选择真正具备视觉理解能力的模型，
// 避免把图像/视频生成模型（如 wanx / flux / gpt-image / seedance）误当作视觉分析模型调用。
const VISION_MODEL_PATTERNS = [
  /qwen[-\w]*vl/i,
  /qwen2\.5-vl/i,
  /qwen3[-\w]*vl/i,
  /qwen[-]?omni/i,
  /gpt-4[o1]/i,
  /gpt-4\.1/i,
  /gemini[-\w]*flash/i,
  /gemini[-\w]*pro/i,
  /claude/i,
  /llava/i,
  /moondream/i,
  /minicpm-v/i,
  /phi-?3[-\w]*vision/i,
  /glm-?4v/i,
  /deepseek-vl/i,
  /doubao-vision/i,
  /abab.*v/i,
  /qwen3[-\w\.]*/i,         // qwen3.7-plus, qwen3.7-vl 等最新系列
  /qwen[-\w]*plus/i,        // qwen-plus, qwen3.7-plus 等
  /qwen[-\w]*max/i,         // qwen-max, qwen-vl-max 等
];

function isVisionModelId(modelId) {
  const value = String(modelId || '').trim();
  if (!value) return false;
  // 显式排除纯图像/视频生成模型，避免误判为视觉分析模型
  if (/(wanx|flux|wan2|stable-diffusion|sd3|sdxl|midjourney|\bdalle\b|gpt-image|seedance|kling|veo|runway|hunyuan-video|wan21|wan22|imagen|dall-e)/i.test(value)) return false;
  return VISION_MODEL_PATTERNS.some((pattern) => pattern.test(value));
}


function hydrateActivatedProviderRecordsFromDisk(force = false) {
  if (activatedProvidersHydrated && !force) return;
  activatedProvidersHydrated = true;
  try {
    if (!existsSync(ACTIVATED_PROVIDERS_FILE)) return;
    const raw = readFileSync(ACTIVATED_PROVIDERS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const records = Array.isArray(parsed) ? parsed : [];
    activatedProviders.clear();
    for (const record of records) {
      if (!record || typeof record !== 'object') continue;
      const provider = String(record.provider || '').trim();
      const mode = String(record.mode || '').trim();
      if (!provider) continue;
      activatedProviders.set(providerActivationKey(provider, mode), {
        ...record,
        provider,
        mode,
      });
    }
  } catch {
    // ignore broken activation cache and rebuild from fresh runtime state
  }
}

function persistActivatedProviderRecordsToDisk() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(
      ACTIVATED_PROVIDERS_FILE,
      JSON.stringify(Array.from(activatedProviders.values()), null, 2),
      'utf8',
    );
  } catch {
    // best-effort persistence only
  }
}

function listActivatedProviderRecords() {
  hydrateActivatedProviderRecordsFromDisk();
  const records = new Map();
  for (const [key, value] of activatedProviders.entries()) {
    if (!value?.provider) continue;
    const recordKey = providerActivationKey(value.provider, value.mode || '');
    if (!records.has(recordKey) || key === recordKey) {
      records.set(recordKey, value);
    }
  }
  return Array.from(records.values());
}

function publicActivatedProviderRecord(record) {
  if (!record || typeof record !== 'object') return null;
  return {
    ...record,
    apiKey: undefined,
  };
}

function publicImageAnalysisRuntime(runtime) {
  if (!runtime || typeof runtime !== 'object') return null;
  return {
    ...runtime,
    apiKey: undefined,
  };
}

function providerLabelFor(providerId) {
  return providers.find((provider) => provider.id === providerId)?.name || providerId;
}

function buildFallbackRuntimeCandidate(record) {
  if (!record || typeof record !== 'object') return null;
  const catalogModel = catalogModelByIdentifier(String(record.model || '').trim());
  const mode = String(record.mode || catalogModel?.mode || 'llm').trim().toLowerCase();
  if (!['llm', 'image', 'video', 'audio'].includes(mode)) return null;
  return {
    id: String(catalogModel?.id || record.model || `${record.provider}-${mode}`).trim(),
    provider: String(record.provider || '').trim(),
    providerLabel: providerLabelFor(String(record.provider || '').trim()),
    mode,
    model: String(record.model || catalogModel?.upstreamModel || catalogModel?.id || '').trim(),
    title: String(catalogModel?.name || record.model || 'Untitled model').trim(),
    description: String(catalogModel?.description || '').trim() || null,
    relaySource: String(record.relaySource || '').trim() || null,
    price: Number.isFinite(Number(record.primaryPrice)) ? Number(record.primaryPrice) : (Number.isFinite(Number(catalogModel?.price)) ? Number(catalogModel.price) : null),
    currency: String(record.primaryCurrency || catalogModel?.currency || '').trim() || null,
    priceUnit: null,
    pricingSummary: null,
    recommendation: null,
    recommendationScore: Number(record.relaySource ? 65 : 52),
    activatedAt: Number(record.activatedAt || 0),
    supportedOnCanvas: Boolean(catalogModel),
  };
}

function flattenActivatedRuntimeCandidates() {
  return listActivatedProviderRecords()
    .flatMap((record) => {
      const availableModels = Array.isArray(record?.availableModels) ? record.availableModels : [];
      if (availableModels.length === 0) {
        const fallback = buildFallbackRuntimeCandidate(record);
        return fallback ? [fallback] : [];
      }
      return availableModels.map((entry) => {
        const catalogModel = catalogModelByIdentifier(String(entry?.catalogModelId || entry?.upstreamModel || entry?.id || '').trim());
        const mode = String(entry?.mode || record?.mode || catalogModel?.mode || '').trim().toLowerCase();
        return {
          id: String(entry?.id || catalogModel?.id || '').trim(),
          provider: String(record?.provider || '').trim(),
          providerLabel: providerLabelFor(String(record?.provider || '').trim()),
          mode,
          model: String(entry?.upstreamModel || catalogModel?.upstreamModel || entry?.id || '').trim(),
          title: String(entry?.name || catalogModel?.name || entry?.upstreamModel || entry?.id || 'Untitled model').trim(),
          description: String(catalogModel?.description || '').trim() || null,
          relaySource: String(record?.relaySource || '').trim() || null,
          price: Number.isFinite(Number(entry?.price)) ? Number(entry.price) : null,
          currency: String(entry?.currency || '').trim() || null,
          priceUnit: String(entry?.priceUnit || '').trim() || null,
          pricingSummary: String(entry?.pricingSummary || '').trim() || null,
          recommendation: String(entry?.recommendation || '').trim() || null,
          recommendationScore: Number.isFinite(Number(entry?.recommendationScore)) ? Number(entry.recommendationScore) : 0,
          activatedAt: Number(record?.activatedAt || 0),
          supportedOnCanvas: Boolean(catalogModel),
          catalogModelId: String(entry?.catalogModelId || catalogModel?.id || '').trim() || null,
        };
      });
    })
    .filter((item) => item && ['llm', 'image', 'video', 'audio'].includes(String(item.mode || '').trim()));
}

function sortRuntimeCandidates(candidates = [], preferredModels = []) {
  const normalizedPreferred = new Set(preferredModels.map((value) => normalizeCatalogIdentifier(value)).filter(Boolean));
  return candidates.slice().sort((left, right) => {
    const leftPreferred = normalizedPreferred.has(normalizeCatalogIdentifier(left?.id))
      || normalizedPreferred.has(normalizeCatalogIdentifier(left?.model))
      || normalizedPreferred.has(normalizeCatalogIdentifier(left?.catalogModelId));
    const rightPreferred = normalizedPreferred.has(normalizeCatalogIdentifier(right?.id))
      || normalizedPreferred.has(normalizeCatalogIdentifier(right?.model))
      || normalizedPreferred.has(normalizeCatalogIdentifier(right?.catalogModelId));
    if (leftPreferred !== rightPreferred) return rightPreferred ? 1 : -1;
    const recommendedDelta = Number(right?.recommendationScore || 0) - Number(left?.recommendationScore || 0);
    if (recommendedDelta !== 0) return recommendedDelta;
    const canvasDelta = Number(Boolean(right?.supportedOnCanvas)) - Number(Boolean(left?.supportedOnCanvas));
    if (canvasDelta !== 0) return canvasDelta;
    const relayDelta = Number(Boolean(right?.relaySource)) - Number(Boolean(left?.relaySource));
    if (relayDelta !== 0) return relayDelta;
    return Number(right?.activatedAt || 0) - Number(left?.activatedAt || 0);
  });
}

function publicRuntimeRecommendationCandidate(candidate) {
  if (!candidate) return null;
  return {
    id: String(candidate.id || '').trim(),
    provider: String(candidate.provider || '').trim(),
    providerLabel: String(candidate.providerLabel || '').trim() || providerLabelFor(String(candidate.provider || '').trim()),
    mode: String(candidate.mode || 'llm').trim(),
    model: String(candidate.model || '').trim(),
    title: String(candidate.title || candidate.model || candidate.id || '').trim(),
    description: String(candidate.description || '').trim() || null,
    relaySource: String(candidate.relaySource || '').trim() || null,
    price: Number.isFinite(Number(candidate.price)) ? Number(candidate.price) : null,
    currency: String(candidate.currency || '').trim() || null,
    priceUnit: String(candidate.priceUnit || '').trim() || null,
    pricingSummary: String(candidate.pricingSummary || '').trim() || null,
    recommendation: String(candidate.recommendation || '').trim() || null,
    recommendationScore: Number.isFinite(Number(candidate.recommendationScore)) ? Number(candidate.recommendationScore) : null,
  };
}

function buildRuntimeRecommendationSummary(key, candidate, options = {}) {
  if (!candidate) return null;
  const candidates = Array.isArray(options.candidates)
    ? options.candidates.map((item) => publicRuntimeRecommendationCandidate(item)).filter(Boolean)
    : [];
  const primary = publicRuntimeRecommendationCandidate(candidate);
  return {
    key,
    title: String(options.title || '').trim(),
    summary: String(options.summary || candidate.recommendation || '').trim(),
    provider: String(candidate.provider || '').trim(),
    providerLabel: String(candidate.providerLabel || '').trim() || providerLabelFor(String(candidate.provider || '').trim()),
    mode: String(candidate.mode || 'llm').trim(),
    model: String(candidate.model || '').trim(),
    relaySource: String(candidate.relaySource || '').trim() || null,
    price: Number.isFinite(Number(candidate.price)) ? Number(candidate.price) : null,
    currency: String(candidate.currency || '').trim() || null,
    priceUnit: String(candidate.priceUnit || '').trim() || null,
    pricingSummary: String(candidate.pricingSummary || '').trim() || null,
    recommendation: String(candidate.recommendation || '').trim() || null,
    tags: Array.isArray(options.tags) ? options.tags.map((item) => String(item || '').trim()).filter(Boolean) : [],
    primary,
    alternates: candidates.filter((item) => item.id !== primary?.id || item.model !== primary?.model).slice(0, 2),
    candidates,
    tasks: Array.isArray(options.tasks) ? options.tasks.filter(Boolean) : [],
  };
}

function buildRuntimeTaskRecommendation(id, options = {}) {
  const candidates = Array.isArray(options.candidates)
    ? options.candidates.map((item) => publicRuntimeRecommendationCandidate(item)).filter(Boolean)
    : [];
  const primary = candidates[0] || null;
  if (!primary) return null;
  return {
    id: String(id || '').trim(),
    title: String(options.title || '').trim(),
    summary: String(options.summary || primary.recommendation || '').trim(),
    tags: Array.isArray(options.tags) ? options.tags.map((item) => String(item || '').trim()).filter(Boolean) : [],
    primary,
    alternates: candidates.slice(1, 3),
    candidates,
  };
}

function buildRuntimeRecommendations() {
  const allCandidates = flattenActivatedRuntimeCandidates();
  const imageCandidates = allCandidates.filter((item) => item.mode === 'image');
  const videoCandidates = allCandidates.filter((item) => item.mode === 'video');
  const audioCandidates = allCandidates.filter((item) => item.mode === 'audio');
  const analysisCandidates = allCandidates.filter((item) => item.mode === 'llm' || item.mode === 'image');

  const imageGenerationCandidates = sortRuntimeCandidates(imageCandidates, ['flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'grok-imagine-1.5-edit-apimart', 'Qwen/Qwen-Image', 'lib-image']);
  const videoGenerationCandidates = sortRuntimeCandidates(videoCandidates, ['kling-o3', 'happyhorse-11', 'doubao-seedance-2-0', 'seedance-v2', 'wan22-i2v-a14b', 'wan22-t2v-a14b']);
  const audioGenerationCandidates = sortRuntimeCandidates(audioCandidates, ['doubao-audio-1-0', 'suno_music']);

  const imageAnalysisRuntime = publicImageAnalysisRuntime(pickActivatedCloudImageAnalysisRuntime());
  const matchedAnalysisCandidate = imageAnalysisRuntime
    ? sortRuntimeCandidates(
      analysisCandidates.filter((item) => (
        String(item.provider || '').trim() === String(imageAnalysisRuntime.provider || '').trim()
        || normalizeCatalogIdentifier(item.model) === normalizeCatalogIdentifier(imageAnalysisRuntime.model)
        || normalizeCatalogIdentifier(item.id) === normalizeCatalogIdentifier(imageAnalysisRuntime.model)
      )),
      [String(imageAnalysisRuntime.model || '')],
    )[0] || null
    : null;
  const analysisFallbackCandidate = imageAnalysisRuntime
    ? {
        id: String(imageAnalysisRuntime.model || 'analysis-runtime').trim(),
        provider: String(imageAnalysisRuntime.provider || '').trim(),
        providerLabel: providerLabelFor(String(imageAnalysisRuntime.provider || '').trim()),
        mode: String(imageAnalysisRuntime.mode || 'llm').trim(),
        model: String(imageAnalysisRuntime.model || '').trim(),
        title: String(imageAnalysisRuntime.model || 'Cloud runtime model').trim(),
        description: null,
        relaySource: null,
        price: null,
        currency: null,
        priceUnit: null,
        pricingSummary: null,
        recommendation: '已激活的云端多模态运行时，可直接用于图片解析与视频语义理解',
        recommendationScore: 88,
        activatedAt: 0,
        supportedOnCanvas: false,
      }
    : null;
  const analysisPrimary = matchedAnalysisCandidate || analysisFallbackCandidate;
  const analysisTopCandidates = sortRuntimeCandidates(
    analysisCandidates,
    [String(imageAnalysisRuntime?.model || ''), 'qwen35-vl', 'florence2', 'clip-interrogator'],
  ).slice(0, 3);
  const imageSubjectReplaceCandidates = sortRuntimeCandidates(
    imageCandidates,
    ['flux-pro', 'gpt-image-2', 'grok-imagine-1.5-edit-apimart', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'Qwen/Qwen-Image', 'lib-image'],
  ).slice(0, 3);
  const imageOmniCandidates = sortRuntimeCandidates(
    imageCandidates,
    ['flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'Qwen/Qwen-Image', 'lib-image'],
  ).slice(0, 3);
  const imageMultiReferenceCandidates = sortRuntimeCandidates(
    imageCandidates,
    ['doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'flux-pro', 'gpt-image-2', 'Qwen/Qwen-Image', 'lib-image'],
  ).slice(0, 3);
  const imageStyleCandidates = sortRuntimeCandidates(
    imageCandidates,
    ['flux-pro', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'gpt-image-2', 'Qwen/Qwen-Image', 'lib-image'],
  ).slice(0, 3);
  const imagePromptInterrogationCandidates = sortRuntimeCandidates(
    analysisCandidates,
    [String(imageAnalysisRuntime?.model || ''), 'clip-interrogator', 'florence2', 'qwen35-vl'],
  ).slice(0, 3);
  const imageCompositionAnalysisCandidates = sortRuntimeCandidates(
    analysisCandidates,
    [String(imageAnalysisRuntime?.model || ''), 'qwen35-vl', 'florence2', 'clip-interrogator'],
  ).slice(0, 3);
  const videoSubjectReplaceCandidates = sortRuntimeCandidates(
    videoCandidates,
    ['kling-o3', 'happyhorse-11', 'seedance-v2', 'wan22-i2v-a14b', 'wan22-t2v-a14b'],
  ).slice(0, 3);
  const videoOmniKeepMotionCandidates = sortRuntimeCandidates(
    videoCandidates,
    ['kling-o3', 'happyhorse-11', 'seedance-v2', 'wan22-i2v-a14b', 'wan22-t2v-a14b'],
  ).slice(0, 3);
  const videoMotionStyleCandidates = sortRuntimeCandidates(
    videoCandidates,
    ['kling-o3', 'seedance-v2', 'happyhorse-11', 'wan22-i2v-a14b', 'wan22-t2v-a14b'],
  ).slice(0, 3);
  const videoImageToVideoCandidates = sortRuntimeCandidates(
    videoCandidates,
    ['kling-o3', 'happyhorse-11', 'seedance-v2', 'wan22-i2v-a14b', 'wan22-t2v-a14b'],
  ).slice(0, 3);
  const videoSemanticParseCandidates = sortRuntimeCandidates(
    analysisCandidates,
    [String(imageAnalysisRuntime?.model || ''), 'qwen35-vl', 'internvideo', 'video-llava'],
  ).slice(0, 3);
  const videoShotBreakdownCandidates = sortRuntimeCandidates(
    analysisCandidates,
    [String(imageAnalysisRuntime?.model || ''), 'qwen35-vl', 'video-llava', 'internvideo'],
  ).slice(0, 3);
  const audioBgmCandidates = sortRuntimeCandidates(audioCandidates, ['suno_music']).slice(0, 3);
  const audioSfxCandidates = sortRuntimeCandidates(audioCandidates, ['suno_music']).slice(0, 3);
  const audioVoiceCandidates = sortRuntimeCandidates(audioCandidates, ['suno_music']).slice(0, 3);

  return {
    imageGeneration: buildRuntimeRecommendationSummary('imageGeneration', imageGenerationCandidates[0], {
      title: '图片节点首推模型',
      summary: '优先用于主素材+ 参考素材的图片生成、编辑与保构图换主体',
      tags: ['图片生成', '主素材', '参考素材'],
      candidates: imageGenerationCandidates.slice(0, 3),
      tasks: [
        buildRuntimeTaskRecommendation('subjectReplaceKeepComposition', {
          title: '保构图换主体',
          summary: '保持主素材的机位、构图与画面布局，优先替换主体到参考素材目标',
          tags: ['composition', 'subject', '主体替换', '保构图'],
          candidates: imageSubjectReplaceCandidates,
        }),
        buildRuntimeTaskRecommendation('omniReference', {
          title: '全能参考融合',
          summary: '同时吸收主体、材质、风格与氛围信息，更适合多条件强约束出图',
          tags: ['omni', '多模态', '强条件'],
          candidates: imageOmniCandidates,
        }),
        buildRuntimeTaskRecommendation('multiReferenceBlend', {
          title: '多参考融合',
          summary: '多张参考图混合时优先保持主体和风格的平衡，减少参考互相打架',
          tags: ['multi-reference', 'blend', '风格融合'],
          candidates: imageMultiReferenceCandidates,
        }),
        buildRuntimeTaskRecommendation('styleReference', {
          title: '风格参考增强',
          summary: '更偏向风格、光影和质感迁移，适合单参考快速增强',
          tags: ['style', 'lighting', 'texture'],
          candidates: imageStyleCandidates,
        }),
      ],
    }),
    imageAnalysis: buildRuntimeRecommendationSummary('imageAnalysis', analysisPrimary, {
      title: '图片解析首推模型',
      summary: '优先用于图片解析、反推提示词、风格光影和主体构图理解',
      tags: ['图片解析', '提示词反推'],
      candidates: analysisTopCandidates,
      tasks: [
        buildRuntimeTaskRecommendation('promptInterrogation', {
          title: '提示词反推',
          summary: '优先提取主体、风格、镜头、光影和氛围词，适合写回图片与视频节点参数区',
          tags: ['prompt', 'style', 'lighting'],
          candidates: imagePromptInterrogationCandidates,
        }),
        buildRuntimeTaskRecommendation('subjectLightingComposition', {
          title: '主体 / 光影 / 构图理解',
          summary: '更适合拆解主素材构图、主体层级和画面光影，辅助保构图换主体',
          tags: ['composition', 'subject', 'lighting'],
          candidates: imageCompositionAnalysisCandidates,
        }),
      ],
    }),
    videoGeneration: buildRuntimeRecommendationSummary('videoGeneration', videoGenerationCandidates[0], {
      title: '视频节点首推模型',
      summary: '优先用于视频生成、多模态参考、全能参考和保运镜换主体',
      tags: ['视频生成', '多模态参考'],
      candidates: videoGenerationCandidates.slice(0, 3),
      tasks: [
        buildRuntimeTaskRecommendation('subjectReplaceKeepMotion', {
          title: '保运镜换主体',
          summary: '锁定主视频的运镜、节奏和镜头结构，优先替换为参考主体',
          tags: ['motion', 'subject', 'video-edit'],
          candidates: videoSubjectReplaceCandidates,
        }),
        buildRuntimeTaskRecommendation('omniReferenceKeepMotion', {
          title: '主视频锁定+ 全能参数',
          summary: '在保留主视频镜头调度的同时融合主体、风格和场景参考',
          tags: ['motion', 'omni', 'all-in-one'],
          candidates: videoOmniKeepMotionCandidates,
        }),
        buildRuntimeTaskRecommendation('motionStyleBlend', {
          title: '运镜与风格融合',
          summary: '强调视频运动轨迹与视觉风格的同步迁移，适合广告或 MV 类镜头',
          tags: ['motion', 'style', 'blend'],
          candidates: videoMotionStyleCandidates,
        }),
        buildRuntimeTaskRecommendation('subjectReferenceImageToVideo', {
          title: '主体参考图生视频',
          summary: '以主体参考图为核心驱动视频生成，兼顾动作连贯和造型一致',
          tags: ['image-to-video', 'subject', 'consistency'],
          candidates: videoImageToVideoCandidates,
        }),
        buildRuntimeTaskRecommendation('omniReferenceVideoGeneration', {
          title: '全能参考视频生成',
          summary: '适合从多张参考中统一生成视频结果，兼顾主体、风格和镜头意图',
          tags: ['omni', 'video-generation', 'multi-reference'],
          candidates: videoOmniKeepMotionCandidates,
        }),
        buildRuntimeTaskRecommendation('referenceDrivenVideoGeneration', {
          title: '参考驱动视频生成',
          summary: '当参考约束较弱时优先保证视频可生成性，再逐步叠加主体和风格控制',
          tags: ['reference', 'fallback', 'robust'],
          candidates: videoGenerationCandidates.slice(0, 3),
        }),
      ],
    }),
    videoAnalysis: buildRuntimeRecommendationSummary('videoAnalysis', analysisPrimary, {
      title: '视频解析首推模型',
      summary: '优先用于关键帧语义解析、镜头语言整理和视频提示词反推',
      tags: ['视频解析', '语义理解'],
      candidates: analysisTopCandidates,
      tasks: [
        buildRuntimeTaskRecommendation('semanticParse', {
          title: '视频语义解析',
          summary: '优先理解镜头内容、时序语义和场景变化，适合驱动全能参考与视频解析',
          tags: ['semantic', 'timeline', 'scene'],
          candidates: videoSemanticParseCandidates,
        }),
        buildRuntimeTaskRecommendation('promptInterrogation', {
          title: '视频提示词反推',
          summary: '适合从关键帧和时序摘要中整理出可写回节点的提示词、风格和运动描述',
          tags: ['prompt', 'style', 'motion'],
          candidates: videoSemanticParseCandidates,
        }),
        buildRuntimeTaskRecommendation('shotBreakdown', {
          title: '分镜 / 运镜拆解',
          summary: '更适合提取镜头节奏、运镜方向和镜头切换结构，辅助保运镜换主体',
          tags: ['shot', 'camera', 'motion'],
          candidates: videoShotBreakdownCandidates,
        }),
      ],
    }),
    audioGeneration: buildRuntimeRecommendationSummary('audioGeneration', audioGenerationCandidates[0], {
      title: '音频节点首推模型',
      summary: '优先用于后续远程 BGM、音效和旁白生成链路',
      tags: ['音频生成'],
      candidates: audioGenerationCandidates.slice(0, 3),
      tasks: [
        buildRuntimeTaskRecommendation('bgm', {
          title: 'BGM 生成',
          summary: '适合氛围配乐、节奏铺底和音乐片段草图生成',
          tags: ['bgm', 'music'],
          candidates: audioBgmCandidates,
        }),
        buildRuntimeTaskRecommendation('sfx', {
          title: '音效生成',
          summary: '适合短音效、环境声与事件音频生成',
          tags: ['sfx', 'foley'],
          candidates: audioSfxCandidates,
        }),
        buildRuntimeTaskRecommendation('voiceover', {
          title: '旁白生成',
          summary: '适合后续真人感旁白、口播和语气化语音链路',
          tags: ['voice', 'narration'],
          candidates: audioVoiceCandidates,
        }),
      ],
    }),
  };
}

function getActivatedProviderRecord(providerId, mode = '') {
  hydrateActivatedProviderRecordsFromDisk();
  if (mode) {
    const exact = activatedProviders.get(providerActivationKey(providerId, mode));
    if (exact) return exact;
  }
  const legacy = activatedProviders.get(providerId);
  if (legacy && (!mode || legacy.mode === mode)) return legacy;
  return listActivatedProviderRecords().find((record) => (
    record.provider === providerId && (!mode || record.mode === mode)
  )) || null;
}

function setActivatedProviderRecord(providerId, mode, record) {
  hydrateActivatedProviderRecordsFromDisk();
  activatedProviders.set(providerActivationKey(providerId, mode), {
    ...record,
    provider: providerId,
    mode,
  });
  persistActivatedProviderRecordsToDisk();
}

function isRealApiProxyEnabled() {
  if (process.env.HMDAO_REAL_API === '1') return true;
  hydrateActivatedProviderRecordsFromDisk();
  if (String(process.env.HMDAO_LITELLM_API_KEY || '').trim()) return true;
  for (const record of activatedProviders.values()) {
    if (String(record?.apiKey || '').trim()) return true;
  }
  return false;
}

function deleteActivatedProviderRecord(providerId, mode = '') {
  hydrateActivatedProviderRecordsFromDisk();
  if (mode) {
    activatedProviders.delete(providerActivationKey(providerId, mode));
    const legacy = activatedProviders.get(providerId);
    if (legacy?.mode === mode) activatedProviders.delete(providerId);
    persistActivatedProviderRecordsToDisk();
    return;
  }
  for (const key of Array.from(activatedProviders.keys())) {
    if (key === providerId || key.startsWith(`${providerId}::`)) {
      activatedProviders.delete(key);
    }
  }
  persistActivatedProviderRecordsToDisk();
}

function activatedProviderPayload(providerId, catalogItem = null) {
  const record = getActivatedProviderRecord(providerId, catalogItem?.mode || '');
  const providerActivated = Boolean(record);
  const activationModelMatched = catalogItem ? modelMatchesActivation(record, catalogItem) : providerActivated;
  const matchedAvailableModel = providerActivated && catalogItem && Array.isArray(record?.availableModels)
    ? record.availableModels.find((entry) => modelMatchesActivation({
      mode: record.mode,
      model: entry?.upstreamModel || entry?.catalogModelId || entry?.id,
      catalogModelIds: [entry?.catalogModelId, entry?.upstreamModel, entry?.id].filter(Boolean),
    }, catalogItem))
    : null;
  return {
    activated: providerActivated,
    activationModelMatched,
    activatedAt: providerActivated ? (record?.activatedAt || null) : null,
    activationMode: providerActivated ? (record?.mode || null) : null,
    activationModel: providerActivated ? (record?.model || null) : null,
    maskedKey: providerActivated ? (record?.maskedKey || '') : '',
    activationPrice: providerActivated ? (matchedAvailableModel?.price ?? record?.primaryPrice ?? null) : null,
    activationCurrency: providerActivated ? (matchedAvailableModel?.currency || record?.primaryCurrency || null) : null,
    activationRelaySource: providerActivated ? (record?.relaySource || null) : null,
    activationAvailableModelCount: providerActivated ? (Array.isArray(record?.availableModels) ? record.availableModels.length : 0) : 0,
  };
}

function isCatalogModelActivated(item) {
  return activatedProviderPayload(item.provider, item).activated;
}

function modelCatalogPayload({ mode, nodeType } = {}) {
  return MODEL_CATALOG
    .filter((item) => {
      const providerMeta = providers.find((provider) => provider.id === item.provider);
      const providerSupportsMode = providerMeta ? providerMeta.modes.includes(item.mode) : true;
      return providerSupportsMode && (!mode || item.mode === mode) && (!nodeType || item.nodeTypes.includes(nodeType));
    })
    .map((item) => {
      const activationState = activatedProviderPayload(item.provider, item);
      const hasActivationPrice = activationState.activationPrice !== null
        && activationState.activationPrice !== undefined
        && Number.isFinite(Number(activationState.activationPrice));
      return {
        ...item,
        model: item.upstreamModel || item.id,
        price: hasActivationPrice ? Number(activationState.activationPrice) : item.price,
        currency: activationState.activationCurrency || item.currency,
        ...activationState,
        providerMeta: providers.find((provider) => provider.id === item.provider) || null,
      };
    });
}

function activatedModelIds() {
  return new Set(
    listActivatedProviderRecords()
      .flatMap((item) => {
        const matched = catalogModelByIdentifier(item?.model);
        return [
          item?.model,
          ...(Array.isArray(item?.catalogModelIds) ? item.catalogModelIds : []),
          ...(Array.isArray(item?.availableModels)
            ? item.availableModels.flatMap((entry) => [entry?.catalogModelId, entry?.upstreamModel, entry?.id])
            : []),
          ...(matched ? [matched.id, matched.upstreamModel] : []),
        ].filter(Boolean);
      }),
  );
}

function modelMatchesIdentifier(item, identifier) {
  const normalizedIdentifier = normalizeCatalogIdentifier(identifier);
  if (!normalizedIdentifier) return false;
  const resolvedCatalogId = normalizeCatalogIdentifier(relayAliasCatalogId(identifier));
  const candidateIds = [
    item?.id,
    item?.name,
    item?.model,
    item?.upstreamModel,
  ]
    .map((value) => normalizeCatalogIdentifier(value))
    .filter(Boolean);
  return candidateIds.includes(normalizedIdentifier) || (resolvedCatalogId ? candidateIds.includes(resolvedCatalogId) : false);
}

function defaultProviderModeModel(provider, mode, items = []) {
  if (provider === 'siliconflow' && mode === 'video') {
    return items.find((item) => modelMatchesIdentifier(item, 'Wan-AI/Wan2.2-T2V-A14B'))
      || items.find((item) => modelMatchesIdentifier(item, 'Wan-AI/Wan2.2-I2V-A14B'))
      || null;
  }
  if (provider === 'siliconflow' && mode === 'image') {
    return items.find((item) => modelMatchesIdentifier(item, 'Qwen/Qwen-Image')) || null;
  }
  return null;
}

function normalizeRelayEndpointInput(endpoint = '') {
  const raw = String(endpoint || '').trim();
  if (!raw) return '';
  let normalized = raw.replace(/\/models\/?$/i, '').replace(/\/$/, '');
  try {
    const url = new URL(normalized);
    if (url.hostname === 'www.apimart.ai') {
      url.hostname = 'api.apimart.ai';
    }
    if (/^\/(?:zh|en|cn|ja|ko|ru|fr|de|es|pt)(?:-[a-z]{2})?\/v1\/?$/i.test(url.pathname)) {
      url.pathname = '/v1';
    }
    if (/(^|\.)apimart\.ai$/i.test(url.hostname) && url.hostname !== 'api.apimart.ai') {
      url.hostname = 'api.apimart.ai';
    }
    if (/(^|\.)apimart\.ai$/i.test(url.hostname) && (!url.pathname || url.pathname === '/')) {
      url.pathname = '/v1';
    }
    normalized = url.toString().replace(/\/$/, '');
  } catch {
    normalized = normalized.replace(/\/$/, '');
  }
  return normalized;
}

function relayBaseUrlCandidates(baseUrl = '') {
  const candidates = [];
  const push = (value) => {
    const normalized = String(value || '').trim().replace(/\/$/, '');
    if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
  };
  push(baseUrl);
  try {
    const url = new URL(baseUrl);
    if (/(^|\.)apimart\.ai$/i.test(url.hostname) && url.hostname !== 'api.apimart.ai') {
      const apiUrl = new URL(url.toString());
      apiUrl.hostname = 'api.apimart.ai';
      if (!apiUrl.pathname || apiUrl.pathname === '/') apiUrl.pathname = '/v1';
      push(apiUrl.toString());
    }
  } catch {
    // ignore malformed URL here; validation happens at request time
  }
  return candidates;
}

function relayRequestUrlCandidates(baseUrl = '', requestUrl = '') {
  const candidates = [];
  const push = (value) => {
    const normalized = String(value || '').trim();
    if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
  };
  push(requestUrl);
  try {
    const target = new URL(requestUrl);
    for (const candidateBaseUrl of relayBaseUrlCandidates(baseUrl)) {
      const candidateBase = new URL(candidateBaseUrl);
      if (candidateBase.origin === target.origin) continue;
      const next = new URL(target.toString());
      next.protocol = candidateBase.protocol;
      next.hostname = candidateBase.hostname;
      next.port = candidateBase.port;
      push(next.toString());
    }
  } catch {
    // ignore malformed URL here; validation happens at request time
  }
  return candidates;
}

function relayModelsEndpointCandidates(baseUrl = '') {
  const candidates = [];
  const push = (value) => {
    const normalized = String(value || '').trim().replace(/\/$/, '');
    if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
  };
  push(baseUrl);
  try {
    const url = new URL(baseUrl);
    if (/^\/(?:zh|en|cn|ja|ko|ru|fr|de|es|pt)(?:-[a-z]{2})?\/v1$/i.test(url.pathname)) {
      const stripped = new URL(url.toString());
      stripped.pathname = '/v1';
      push(stripped.toString());
    }
    if (/(^|\.)apimart\.ai$/i.test(url.hostname) && url.hostname !== 'api.apimart.ai') {
      const apiUrl = new URL(url.toString());
      apiUrl.hostname = 'api.apimart.ai';
      if (!apiUrl.pathname || apiUrl.pathname === '/') apiUrl.pathname = '/v1';
      push(apiUrl.toString());
    }
  } catch {
    // ignore malformed URL here; validation happens at request time
  }
  return candidates.map((value) => `${value}/models`);
}

function relayEndpointHelpMessage(baseUrl = '') {
  try {
    const url = new URL(baseUrl);
    if (/(^|\.)apimart\.ai$/i.test(url.hostname)) {
      return '检测到你填写的 APIMart 地址。请优先使用 OpenAI 兼容根地址，例如 https://apimart.ai/v1 或 https://api.apimart.ai/v1，而不是官网语言页地址';
    }
  } catch {
    // ignore
  }
  return '请确认填写的 OpenAI 兼容 Base URL，而不是官网介绍页或文档页面地址';
}

const RELAY_PRESET_META = {
  comfly: {
    id: 'comfly',
    name: 'Comfly',
  },
  suanliai: {
    id: 'suanliai',
    name: 'Suanliai',
  },
  apimart: {
    id: 'apimart',
    name: 'APIMart',
  },
  'generic-openai-relay': {
    id: 'generic-openai-relay',
    name: 'OpenAI Relay',
  },
};

const RELAY_CONNECTIVITY_CACHE = new Map();
const RELAY_CONNECTIVITY_SUCCESS_TTL_MS = 5 * 60 * 1000;
const RELAY_CONNECTIVITY_FAILURE_TTL_MS = 60 * 1000;

const RELAY_MODEL_MATCHERS = [
  {
    catalogId: 'lib-image',
    aliases: [/qwen[\/\-_ ]?qwen[\/\-_ ]?image/i, /qwen[\/\-_ ]?image(?:[\/\-_ ]?edit)?/i],
    score: 100,
    recommendation: '多参考主体控制、保构图换主体、文字与商品图表现稳定',
  },
  {
    catalogId: 'gpt-image-2',
    aliases: [/gpt[\/\-_ ]?image(?:[\/\-_ ]?(?:1|1\.0|1\.5|2))?/i, /gpt[\/\-_ ]?4o[\/\-_ ]?image/i],
    score: 92,
    recommendation: '适合作为通用图片生成与编辑候选，尤其适合保构图换主体与多参考改图',
  },
  {
    aliases: [/image\s*2/i, /imagen\s*2/i],
    score: 82,
    recommendation: 'Google 图片家族，适合作为聚合平台里的高质量图片候选',
    mode: 'image',
    providerLabel: 'Google',
    displayName: 'Imagen 2 / image2',
  },
  {
    catalogId: 'flux-pro',
    aliases: [/flux[\/\-_ ]?pro/i],
    score: 90,
    recommendation: '写实海报和高质感商业图更稳，适合作为图片备选',
  },
  {
    catalogId: 'doubao-seedream-5-0-lite',
    aliases: [/seedream[\/\-_ ]?4(?:\.0)?/i, /doubao[\/\-_ ]?seedream[\/\-_ ]?4(?:\.0)?/i, /seedream[\/\-_ ]?5(?:\.0)?(?:[\/\-_ ]?lite)?/i, /doubao[\/\-_ ]?seedream[\/\-_ ]?5(?:\.0)?(?:[\/\-_ ]?lite)?/i],
    score: 88,
    recommendation: '商品图、打光和高质感场景表现强',
  },
  {
    catalogId: 'grok-imagine-1.5-edit-apimart',
    aliases: [/grok[\/\-_ ]?imagine[\/\-_ ]?1\.5[\/\-_ ]?edit/i],
    score: 90,
    recommendation: '复杂编辑指令和多参考改图适配更好，可作为强编辑备选',
  },
  {
    catalogId: 'gemini-3-pro-image-preview',
    aliases: [/gemini[\/\-_ ]?3(?:\.0|\.1)?[\/\-_ ]?pro[\/\-_ ]?image[\/\-_ ]?preview/i],
    score: 84,
    recommendation: '适合多模态预览、参考分析和结构理解',
  },
  {
    catalogId: 'kling-v3-omni',
    aliases: [/kling[\/\-_ ]?v3[\/\-_ ]?omni/i],
    score: 100,
    recommendation: '主视频保运镜、多参考换角和全能参考视频编辑优先推荐',
  },
  {
    catalogId: 'kling-o3',
    aliases: [/kling[\/\-_ ]?(?:o3|v3|video)/i],
    score: 100,
    recommendation: '全能参考、主体一致性和多模态视频编辑优先推荐',
  },
  {
    catalogId: 'seedance-v2',
    aliases: [/seedance[\/\-_ ]?(?:2(?:\.0)?|v2)/i],
    score: 96,
    recommendation: '参考图/参考视频参考音频混合输入能力强，适合多模态视频链路',
  },
  {
    catalogId: 'wan22-i2v-a14b',
    aliases: [/wan[^a-z0-9]*2(?:\.|_)?2[^a-z0-9]*(?:i2v|image[^a-z0-9]*to[^a-z0-9]*video)/i],
    score: 84,
    recommendation: '图生视频与首尾帧控制能力稳定，适合轻量预演',
  },
  {
    catalogId: 'wan22-t2v-a14b',
    aliases: [/wan[^a-z0-9]*2(?:\.|_)?2[^a-z0-9]*(?:t2v|text[^a-z0-9]*to[^a-z0-9]*video)/i],
    score: 80,
    recommendation: '文生视频预览成本更低，适合先做草案',
  },
  {
    catalogId: 'deepseek-chat',
    aliases: [/deepseek[\/\-_ ]?chat/i, /deepseek[\/\-_ ]?v?3/i, /deepseek[\/\-_ ]?r1/i],
    score: 86,
    recommendation: '用于文案、调度和 agent 辅助较稳',
  },
  {
    aliases: [/grok[\/\-_ ]?1(?:\.5)?[\/\-_ ]?video/i, /grok[\/\-_ ]?video/i],
    score: 83,
    recommendation: '更适合作为平台侧的视频多模态候选，后续可扩成强语义视频理解与生成路由',
    mode: 'video',
    providerLabel: 'xAI',
    displayName: 'Grok 1.5 Video',
  },
  {
    aliases: [/veo[\/\-_ ]?3(?:\.1)?/i, /veo3(?:\.1)?/i],
    score: 92,
    recommendation: '高质量视频生成家族，适合列为 Comfly 平台级主流视频候选',
    mode: 'video',
    providerLabel: 'Google',
    displayName: 'Veo 3.1',
  },
  {
    aliases: [/\bomni\b/i],
    score: 89,
    recommendation: '适合作为全能参考多模态理解类入口展示，便于后续接强条件控制链路',
    mode: 'llm',
    providerLabel: 'Multimodal',
    displayName: 'Omni',
  },
  {
    aliases: [/nano[\/\-_ ]?banana[\/\-_ ]?pro/i],
    score: 78,
    recommendation: '更适合作为轻量创意图片候选，当前可先展示为平台可用模型',
    mode: 'image',
    providerLabel: 'Creative',
    displayName: 'Nano Banana Pro',
  },
  {
    catalogId: 'nano-banana2',
    aliases: [/nano[\/\-_ ]?banana[\/\-_ ]?2/i, /nano[\/\-_ ]?banana[\/\-_ ]?v?2/i],
    score: 80,
    recommendation: '轻量创意图片与参考图改写候选，适合聚合平台侧快速出图',
  },
  {
    catalogId: 'gemini-31',
    aliases: [/gemini[\/\-_ ]?3(?:\.1)?/i, /gemini[\/\-_ ]?3[\/\-_ ]?pro/i, /gemini[\/\-_ ]?3[\/\-_ ]?flash/i],
    score: 88,
    recommendation: '适合作为多模态理解与 agent 路由候选，后续可扩到更深的视频/图像分析工作流',
  },
  {
    catalogId: 'midjourney-relax',
    aliases: [/mj[\/\-_ ]?relax/i, /midjourney[\/\-_ ]?relax/i, /\bmidjourney\b/i],
    score: 80,
    recommendation: '适合作为平台级图片创作候选展示，后续可补更精细的风格与计费提示',
    displayName: 'MJ Relax',
  },
  {
    catalogId: 'happyhorse-11',
    aliases: [/happyhorse(?:[\/\-_ ]?1(?:\.0|\.1)?)?/i],
    score: 94,
    recommendation: '统一视频入口，适合文本、首帧、参考图与视频编辑混合链路',
  },
  {
    aliases: [/suno[\/\-_ ]?music/i, /\bsuno\b/i],
    score: 87,
    recommendation: '适合作为音频/BGM 平台模型展示，后续可继续打通到音频节点',
    mode: 'audio',
    providerLabel: 'Suno',
    displayName: 'Suno Music',
  },
  {
    aliases: [/\brunway\b/i],
    score: 90,
    recommendation: 'Runway 视频家族适合作为平台级视频候选，后续可扩成强编辑路线',
    mode: 'video',
    providerLabel: 'Runway',
    displayName: 'Runway',
  },
];

function firstFiniteNumber(values = []) {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function fallbackRelayModelsRequestViaPowerShell(url, apiKey, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const seconds = Math.max(5, Math.ceil(Number(timeoutMs || 15000) / 1000));
    const script = `
$ProgressPreference = 'SilentlyContinue'
$uri = '${escapePowerShellSingleQuoted(url)}'
$headers = @{
  Accept = 'application/json'
  Authorization = 'Bearer ${escapePowerShellSingleQuoted(String(apiKey || '').trim())}'
}
try {
  $resp = Invoke-WebRequest -Uri $uri -Method GET -Headers $headers -TimeoutSec ${seconds} -ErrorAction Stop
  [Console]::Out.Write([int]$resp.StatusCode)
  [Console]::Out.Write([Environment]::NewLine)
  [Console]::Out.Write(($resp.Headers['Content-Type'] -join ','))
  [Console]::Out.Write([Environment]::NewLine)
  [Console]::Out.Write([string]$resp.Content)
} catch {
  $resp = $_.Exception.Response
  if ($resp) {
    $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
    $content = $reader.ReadToEnd()
    [Console]::Out.Write([int]$resp.StatusCode)
    [Console]::Out.Write([Environment]::NewLine)
    [Console]::Out.Write(($resp.Headers['Content-Type'] -join ','))
    [Console]::Out.Write([Environment]::NewLine)
    [Console]::Out.Write([string]$content)
    exit 0
  }
  throw
}
`.trim();

    const child = spawn('powershell', ['-NoProfile', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk || ''); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk || ''); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(stderr.trim() || `PowerShell request failed with code ${code}.`));
        return;
      }
      const [statusLine = '', contentTypeLine = '', ...bodyLines] = stdout.split(/\r?\n/);
      resolve({
        status: Number(statusLine) || 500,
        ok: Number(statusLine) >= 200 && Number(statusLine) < 300,
        contentType: String(contentTypeLine || '').trim().toLowerCase(),
        text: bodyLines.join('\n'),
      });
    });
  });
}

async function requestRelayModelsEndpoint(url, apiKey, signal, timeoutMs = 15000) {
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${String(apiKey).trim()}`,
  };
  const requestUrls = relayRequestUrlCandidates(url.replace(/\/models\/?$/i, ''), url);
  let lastError = null;
  for (const requestUrl of requestUrls) {
    try {
      const response = await fetch(requestUrl, {
        method: 'GET',
        headers,
        signal,
      });
      return {
        status: response.status,
        ok: response.ok,
        contentType: String(response.headers.get('content-type') || '').toLowerCase(),
        text: await response.text(),
      };
    } catch (error) {
      lastError = error;
      const code = error?.cause?.code || error?.code || '';
      if (!(process.platform === 'win32' && ['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT', 'ENETUNREACH', 'ECONNRESET', 'ECONNREFUSED'].includes(String(code)))) {
        throw error;
      }
    }
  }
  if (process.platform === 'win32') {
    for (const requestUrl of requestUrls) {
      const fallback = await fallbackRelayModelsRequestViaPowerShell(requestUrl, apiKey, timeoutMs);
      if (fallback.ok || fallback.status > 0 || String(fallback.text || '').trim()) {
        return fallback;
      }
    }
  }
  throw lastError || new Error('relay-model-request-failed');
}

function parseRelayPricing(item = {}) {
  const pricing = item?.pricing && typeof item.pricing === 'object' && !Array.isArray(item.pricing)
    ? item.pricing
    : null;
  const directPrice = firstFiniteNumber([
    item?.price,
    item?.unit_price,
    item?.cost,
    item?.pricing,
  ]);
  const pricingPrice = pricing
    ? firstFiniteNumber([
      pricing.price,
      pricing.unit_price,
      pricing.image,
      pricing.video,
      pricing.input,
      pricing.output,
      pricing.per_call,
      pricing.per_second,
      pricing.per_image,
    ])
    : null;
  const price = directPrice ?? pricingPrice;
  const currency = extractFirstString([
    item?.currency,
    pricing?.currency,
    pricing?.unit,
  ]) || null;
  const pricingUnit = extractFirstString([
    pricing?.price_unit,
    pricing?.billing_unit,
    pricing?.unit_label,
    item?.price_unit,
    item?.billing_unit,
  ]) || null;
  const pricingSummary = pricing
    ? Object.entries(pricing)
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .slice(0, 5)
      .map(([key, value]) => `${key}:${value}`)
      .join(' | ')
    : '';
  return {
    price,
    currency,
    pricingUnit,
    pricingSummary: pricingSummary || null,
  };
}

function guessRelayModelMode(modelId = '', modelName = '') {
  const source = `${modelId} ${modelName}`.toLowerCase();
  if (/\b(tts|speech|voice|audio|music|sound)\b/.test(source)) return 'audio';
  if (/\b(video|i2v|t2v|ti2v|reference-to-video|img2video|image-to-video)\b/.test(source)) return 'video';
  if (/\b(image|edit|flux|seedream|wanx|qwen-image|poster|photo)\b/.test(source)) return 'image';
  return 'llm';
}

function matchRelayCatalogModel(modelId = '', modelName = '') {
  const source = `${modelId} ${modelName}`.trim();
  for (const matcher of RELAY_MODEL_MATCHERS) {
    if (matcher.aliases.some((pattern) => pattern.test(source))) {
      const catalogModel = matcher.catalogId ? catalogModelByIdentifier(matcher.catalogId) : null;
      return {
        catalogModel,
        recommendationScore: matcher.score,
        recommendation: matcher.recommendation,
        mode: matcher.mode || catalogModel?.mode || null,
        providerLabel: matcher.providerLabel || '',
        displayName: matcher.displayName || '',
      };
    }
  }

  const normalizedSource = normalizeCatalogIdentifier(source);
  const exactCatalogModel = MODEL_CATALOG.find((item) => (
    [item.id, item.name, item.upstreamModel]
      .map((value) => normalizeCatalogIdentifier(value))
      .filter(Boolean)
      .includes(normalizedSource)
  ));

  return exactCatalogModel
    ? {
        catalogModel: exactCatalogModel,
        recommendationScore: 72,
        recommendation: '已匹配到当前画布模型目录，可直接同步到节点菜单',
        mode: exactCatalogModel.mode,
        providerLabel: '',
        displayName: '',
      }
    : null;
}

function normalizeRelayDiscoveredModel(item = {}) {
  const modelId = extractFirstString([item?.id, item?.model, item?.name]);
  if (!modelId) return null;
  const modelName = extractFirstString([item?.name, item?.display_name, item?.label, modelId]);
  const matched = matchRelayCatalogModel(modelId, modelName);
  const catalogModel = matched?.catalogModel || null;
  const pricing = parseRelayPricing(item);
  const mode = matched?.mode || catalogModel?.mode || guessRelayModelMode(modelId, modelName);
  const providerMeta = catalogModel ? providers.find((provider) => provider.id === catalogModel.provider) : null;
  return {
    id: modelId,
    name: matched?.displayName || modelName,
    mode,
    provider: catalogModel?.provider || '',
    providerLabel: matched?.providerLabel || providerMeta?.name || extractFirstString([item?.owned_by, item?.provider, item?.organization]) || '',
    catalogModelId: catalogModel?.id || null,
    upstreamModel: modelId,
    supportedOnCanvas: Boolean(catalogModel),
    recommended: Boolean(matched),
    recommendationScore: matched?.recommendationScore || 0,
    recommendation: matched?.recommendation || '',
    description: catalogModel?.description || extractFirstString(item?.description) || '',
    price: pricing.price ?? (Number.isFinite(Number(catalogModel?.price)) ? Number(catalogModel.price) : null),
    currency: pricing.currency || catalogModel?.currency || null,
    priceUnit: pricing.pricingUnit || null,
    pricingSummary: pricing.pricingSummary || null,
  };
}

function summarizeRelayRecommendations(models = []) {
  return ['image', 'video', 'llm', 'audio'].reduce((acc, mode) => {
    acc[mode] = models
      .filter((item) => item.mode === mode && item.recommended)
      .sort((left, right) => (
        Number(right.recommendationScore || 0) - Number(left.recommendationScore || 0)
      ))
      .slice(0, mode === 'video' ? 3 : 2);
    return acc;
  }, {});
}

async function fetchRelayModelIndex({ endpoint = '', apiKey = '', relayPresetId = 'generic-openai-relay' } = {}) {
  const baseUrl = normalizeRelayEndpointInput(endpoint);
  if (!baseUrl) {
    return {
      success: false,
      status: 400,
      endpoint: '',
      message: '中转站 Base URL 不能为空',
      models: [],
      recommended: summarizeRelayRecommendations([]),
    };
  }
  if (!apiKey || String(apiKey).trim().length < 8) {
    return {
      success: false,
      status: 400,
      endpoint: baseUrl,
      message: 'API Key 至少需 8 位',
      models: [],
      recommended: summarizeRelayRecommendations([]),
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const modelEndpoints = relayModelsEndpointCandidates(baseUrl);
    let lastFailure = null;

    for (const candidate of modelEndpoints) {
      const response = await requestRelayModelsEndpoint(candidate, apiKey, controller.signal, 15000);
      const text = response.text;
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }
      const contentType = String(response.contentType || '').toLowerCase();

      if (!response.ok) {
        const message = extractFirstString([payload?.error?.message, payload?.message])
          || 'Relay model list request failed (HTTP ' + response.status + ').';
        lastFailure = {
          status: response.status,
          endpoint: candidate.replace(/\/models$/i, ''),
          contentType,
          payload,
          message,
          text,
        };
        const shouldRetryCandidate = (
          [404, 405].includes(response.status)
          || contentType.includes('text/html')
          || /^<!doctype html>/i.test(String(text || '').trim())
        );
        if (shouldRetryCandidate) {
          continue;
        }
        return {
          success: false,
          status: response.status,
          endpoint: candidate.replace(/\/models$/i, ''),
          message,
          models: [],
          recommended: summarizeRelayRecommendations([]),
        };
      }

      const rawModels = Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.models)
          ? payload.models
          : [];
      const normalizedModels = rawModels
        .map((entry) => normalizeRelayDiscoveredModel(entry))
        .filter(Boolean)
        .sort((left, right) => {
          const recommendedDelta = Number(right.recommendationScore || 0) - Number(left.recommendationScore || 0);
          if (recommendedDelta !== 0) return recommendedDelta;
          return String(left.name || '').localeCompare(String(right.name || ''));
        });
      const recommended = summarizeRelayRecommendations(normalizedModels);
      const relayPreset = RELAY_PRESET_META[relayPresetId] || RELAY_PRESET_META['generic-openai-relay'];
      return {
        success: true,
        status: response.status,
        endpoint: candidate.replace(/\/models$/i, ''),
        relayPresetId: relayPreset.id,
        relayName: relayPreset.name,
        message: normalizedModels.length
          ? 'Discovered ' + normalizedModels.length + ' model(s) and filtered mainstream multimodal recommendations.'
          : '模型列表已返回，但暂未匹配到当前画布可直接使用的模型',
        models: normalizedModels,
        recommended,
      };
    }

    return {
      success: false,
      status: lastFailure?.status || 400,
      endpoint: lastFailure?.endpoint || baseUrl,
      message: lastFailure?.message
        ? `${lastFailure.message} ${relayEndpointHelpMessage(baseUrl)}`
        : relayEndpointHelpMessage(baseUrl),
      models: [],
      recommended: summarizeRelayRecommendations([]),
    };
  } catch (error) {
    return {
      success: false,
      status: 500,
      endpoint: baseUrl,
      message: error?.name === 'AbortError'
        ? 'Relay model list request timed out. Please try again later.'
        : (error instanceof Error ? error.message : String(error)),
      models: [],
      recommended: summarizeRelayRecommendations([]),
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildRelayActivationRecords(discoveredModels = []) {
  const groups = new Map();
  for (const item of discoveredModels) {
    if (!item?.supportedOnCanvas || !item.provider || !item.mode) continue;
    const key = providerActivationKey(item.provider, item.mode);
    if (!groups.has(key)) {
      groups.set(key, {
        provider: item.provider,
        mode: item.mode,
        items: [],
      });
    }
    groups.get(key).items.push(item);
  }

  return Array.from(groups.values()).map((group) => {
    const items = group.items
      .slice()
      .sort((left, right) => Number(right.recommendationScore || 0) - Number(left.recommendationScore || 0));
    const primary = items[0];
    const availableModels = items.map((item) => ({
      id: item.id,
      name: item.name,
      mode: item.mode,
      catalogModelId: item.catalogModelId,
      upstreamModel: item.upstreamModel,
      price: item.price,
      currency: item.currency,
      priceUnit: item.priceUnit || null,
      pricingSummary: item.pricingSummary || null,
      recommended: item.recommended,
      recommendationScore: item.recommendationScore,
      recommendation: item.recommendation,
    }));
    return {
      provider: group.provider,
      mode: group.mode,
      model: primary?.upstreamModel || primary?.id || '',
      catalogModelIds: Array.from(new Set(
        availableModels
          .flatMap((item) => [item.catalogModelId, item.upstreamModel, item.id])
          .filter(Boolean),
      )),
      availableModels,
      primaryModelName: primary?.name || '',
      primaryPrice: primary?.price ?? null,
      primaryCurrency: primary?.currency || null,
    };
  });
}

async function validateByokProvider({ provider, apiKey, model, mode = 'llm', endpoint = '' }) {
  const baseUrl = normalizeRelayEndpointInput(endpoint || PROVIDER_BASE_URLS[provider] || '');
  const isRelayEndpoint = Boolean(String(endpoint || '').trim());
  if (!baseUrl) {
    return {
      success: true,
      validated: false,
      model: model || '',
      message: '已保存 API Key，但当前平台尚未接入远程校验',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await requestRelayModelsEndpoint(`${baseUrl}/models`, apiKey, controller.signal, 15000);
    const text = response.text;
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    const contentType = String(response.contentType || '').toLowerCase();

    if (!response.ok) {
      if (isRelayEndpoint && ![401, 403].includes(response.status)) {
        return {
          success: true,
          validated: false,
          model: model || '',
          message: '中转站未返回标准 /models 列表，已按中转站模式保存，首次真实请求时再确认可用性',
        };
      }
      const message = extractFirstString(payload?.error?.message)
        || extractFirstString(payload?.message)
        || ('远程校验失败（HTTP ' + response.status + '）。');
      return {
        success: false,
        validated: true,
        message,
      };
    }

    const items = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : [];

    if (!items.length) {
      const looksLikeHtml = contentType.includes('text/html') || /^<!doctype html>/i.test(text.trim());
      if (looksLikeHtml || !payload) {
        return {
          success: true,
          validated: true,
          model: model || '',
          message: '该平台未暴露标准模型列表，已按当前模式保存 API Key（远程返回 200，密钥有效）。生成时会继续按真实模型归属平台路由',
        };
      }
      // 返回了合法 JSON 但模型列表为空（如火山方舟需先在控制台创建并部署推理端点）
      return {
        success: true,
        validated: true,
        model: model || '',
        message: '远程返回了空模型列表，已保存 API Key（密钥有效）。若该平台需要先部署推理端点（如火山方舟），请先在控制台创建端点后再生成。',
      };
    }
    const requestedModel = String(model || '').trim();
    const matchedModel = requestedModel
      ? items.find((item) => modelMatchesIdentifier(item, requestedModel))
      : null;
    const defaultModel = !requestedModel ? defaultProviderModeModel(provider, mode, items) : null;

    if (requestedModel && !matchedModel) {
      // 官方直连场景下，所选模型是平台内部目录 ID（如 seedream-4），而火山方舟等平台的
      // /models 只返回「已部署的推理端点」，不会暴露目录 ID，无法用名称比对。
      // 只要远程返回了 200 且可解析模型列表，即说明 API Key 有效，应视为校验通过。
      if (isRelayEndpoint) {
        return {
          success: false,
          validated: true,
          message: '所选模型「' + requestedModel + '」未在远程模型列表中找到（' + provider + '）。请确认模型名称是否正确。',
        };
      }
      return {
        success: true,
        validated: true,
        model: requestedModel,
        message: (providers.find((item) => item.id === provider)?.name || provider)
          + ' 远程校验通过（已返回模型列表）。所选模型「' + requestedModel
          + '」未直接出现在平台返回的列表中；部分平台（如火山方舟）需先在控制台创建并部署对应推理端点，生成时会按该平台实际模型路由。',
      };
    }

    return {
      success: true,
      validated: true,
      model: extractFirstString(matchedModel?.id) || extractFirstString(defaultModel?.id) || requestedModel,
      message: (providers.find((item) => item.id === provider)?.name || provider) + ' 远程校验通过。',
    };
  } catch (error) {
    return {
      success: false,
      validated: true,
      message: error?.name === 'AbortError'
        ? '远程校验超时，请稍后重试。'
        : (error instanceof Error ? error.message : String(error)),
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseLatencySeconds(value) {
  const raw = String(value || '').trim().toLowerCase();
  const match = raw.match(/(\d+(?:\.\d+)?)s/);
  if (!match) return 999;
  return Number(match[1]);
}

function catalogModelByIdentifier(identifier) {
  const normalizedIdentifier = normalizeCatalogIdentifier(identifier);
  if (!normalizedIdentifier) return null;

  const exact = MODEL_CATALOG.find((item) => (
    [item.id, item.upstreamModel, item.model, item.name]
      .map((value) => normalizeCatalogIdentifier(value))
      .filter(Boolean)
      .includes(normalizedIdentifier)
  ));
  if (exact) return exact;

  const aliasCatalogId = normalizeCatalogIdentifier(relayAliasCatalogId(identifier));
  if (!aliasCatalogId) return null;
  return MODEL_CATALOG.find((item) => normalizeCatalogIdentifier(item.id) === aliasCatalogId) || null;
}

function providerRegionAffinityScore(providerId, regionPreference, weights) {
  if ((regionPreference.preferredProviders || []).includes(providerId)) {
    return Number(weights.regionMatch || 90);
  }
  if ((regionPreference.secondaryProviders || []).includes(providerId)) {
    return Number(weights.regionMismatch || -80);
  }
  return 0;
}

function normalizeReferenceAssets(value) {
  const items = Array.isArray(value) ? value : [];
  return items
    .map((item) => (item && typeof item === 'object' && !Array.isArray(item) ? item : null))
    .filter(Boolean)
    .map((item) => ({
      type: String(item.type || '').trim().toLowerCase(),
      role: String(item.role || '').trim().toLowerCase(),
      uiRole: String(item.ui_role || '').trim().toLowerCase(),
      weight: Number.isFinite(Number(item.weight)) ? Number(item.weight) : 0,
      url: extractFirstString(item.url),
      coverageRoles: Array.isArray(item.coverage_roles)
        ? Array.from(new Set(item.coverage_roles.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean)))
        : [],
      channel: String(item.channel || '').trim().toLowerCase(),
      preserve: Array.isArray(item.preserve) ? item.preserve.map((entry) => String(entry || '').trim()).filter(Boolean) : [],
      sourceMeta: item.source_meta && typeof item.source_meta === 'object' && !Array.isArray(item.source_meta)
        ? {
            width: Number.isFinite(Number(item.source_meta.width)) ? Number(item.source_meta.width) : 0,
            height: Number.isFinite(Number(item.source_meta.height)) ? Number(item.source_meta.height) : 0,
            duration: Number.isFinite(Number(item.source_meta.duration)) ? Number(item.source_meta.duration) : 0,
            provider: extractFirstString(item.source_meta.provider),
            model: extractFirstString(item.source_meta.model),
            contentType: extractFirstString(item.source_meta.contentType),
            source: extractFirstString(item.source_meta.source),
          }
        : null,
      sourceNodeType: String(item.source_node_type || '').trim().toLowerCase(),
    }))
    .filter((item) => item.type && item.role && item.url);
}

function isKlingVideoModelIdentifier(value = '') {
  const normalized = normalizeCatalogIdentifier(String(value || ''));
  return normalized.includes('kling');
}

function readVideoSourceProfile(primaryAssets = [], sourceMediaType = '') {
  if (String(sourceMediaType || '').trim().toLowerCase() !== 'video') return null;
  const primaryVideo = primaryAssets.find((item) => item?.type === 'video' && (item.channel === 'primary' || item.role === 'motion' || item.uiRole === 'primary'));
  const sourceMeta = primaryVideo?.sourceMeta && typeof primaryVideo.sourceMeta === 'object' ? primaryVideo.sourceMeta : null;
  const width = Number(sourceMeta?.width || 0);
  const height = Number(sourceMeta?.height || 0);
  const duration = Number(sourceMeta?.duration || 0);
  if (!(Number.isFinite(width) || Number.isFinite(height) || Number.isFinite(duration))) return null;
  return {
    width: Number.isFinite(width) && width > 0 ? width : 0,
    height: Number.isFinite(height) && height > 0 ? height : 0,
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
  };
}

function buildVideoSourceConstraint(primaryVideoProfile = null) {
  if (!primaryVideoProfile || !primaryVideoProfile.height) return null;
  if (primaryVideoProfile.height < 700) {
    return {
      kind: 'primary-video-min-height',
      severity: 'hard',
      reason: `Primary video height ${primaryVideoProfile.height}px is below the upstream Kling omni minimum of 700px.`,
      recommendedModels: ['seedance-v2'],
    };
  }
  return null;
}

function isApimartRelayEndpoint(value = '') {
  return /(apimart\.ai|suanliai\.top|comfly\.org)/i.test(String(value || '').trim());
}

function buildVideoRouteConstraint({
  catalogItem = null,
  sourceMediaType = '',
  activatedRecord = null,
} = {}) {
  if (String(sourceMediaType || '').trim().toLowerCase() !== 'video') return null;
  if (!catalogItem || typeof catalogItem !== 'object') return null;
  if (!isApimartRelayEndpoint(activatedRecord?.endpoint || '')) return null;
  if (normalizeCatalogIdentifier(catalogItem.id || catalogItem.upstreamModel || '').includes('seedance')) {
    return {
      kind: 'apimart-seedance-video-edit-advisory',
      severity: 'warn',
      reason: 'Current APIMart Seedance V2 routing still needs contract verification for primary-video editing and video_urls submission. Keep explicit Seedance requests intact, but verify the preview contract before spending a paid run.',
      recommendedModels: ['seedance-v2', 'kling-v3-omni', 'wan2.2-i2v-plus'],
    };
  }
  return null;
}

function shouldForceKlingOmniVideoRoute({
  requestedProvider = '',
  requestedModel = '',
  sourceMediaType = '',
  generationMode = '',
  hasImageReference = false,
  hasVideoReference = false,
  requiresAdvancedReferenceControl = false,
} = {}) {
  const normalizedProvider = String(requestedProvider || '').trim().toLowerCase();
  const normalizedRequestedModel = normalizeCatalogIdentifier(requestedModel || '');
  if (normalizedRequestedModel && !isKlingVideoModelIdentifier(normalizedRequestedModel)) return false;
  if (normalizedProvider !== 'kling') return false;
  if (String(sourceMediaType || '').trim().toLowerCase() !== 'video') return false;
  const normalizedGenerationMode = String(generationMode || '').trim();
  if (!['referenceVideo', 'videoStyleTransfer'].includes(normalizedGenerationMode)) return false;
  return Boolean(hasImageReference || hasVideoReference || requiresAdvancedReferenceControl);
}

function normalizeIdentityController(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    enabled: Boolean(input.enabled),
    identityLockMode: String(input.identityLockMode || 'off').trim(),
    fallbackPolicy: String(input.fallbackPolicy || 'reference_weight').trim(),
  };
}

function modelSupportsRequirement(item, requirement) {
  const capabilities = item?.capabilities || {};
  switch (requirement.key) {
    case 'generationMode':
      return Array.isArray(capabilities.generationModes) && capabilities.generationModes.includes(requirement.value);
    case 'referenceRole':
      return Array.isArray(capabilities.referenceRoles) && capabilities.referenceRoles.includes(requirement.value);
    case 'toolOperation':
      return Array.isArray(capabilities.toolOperations) && capabilities.toolOperations.includes(requirement.value);
    default:
      return Boolean(capabilities?.[requirement.key]);
  }
}

function capabilityPenalty(item, requirements = [], weights = {}) {
  if (!requirements.length) return 0;
  let penalty = 0;
  for (const requirement of requirements) {
    if (!modelSupportsRequirement(item, requirement)) {
      penalty += Math.abs(Number(weights.disabled || -100000));
    }
  }
  return penalty * -1;
}

function expandedReferenceRoles(asset = {}, options = {}) {
  return assetCoverageRoles(asset, options);
}

function referenceRoleRoutingScore(item, referenceAssets = [], routingConfig = {}, weights = {}, options = {}) {
  if (!referenceAssets.length) return 0;
  let score = 0;
  for (const asset of referenceAssets) {
    const weightFactor = Math.max(0, Math.min(1, Number(asset.weight || 0)));
    for (const role of expandedReferenceRoles(asset, options)) {
      const rule = routingConfig?.[role];
      if (!rule || typeof rule !== 'object') continue;
      const providerHit = (rule.preferredProviders || []).includes(item.provider);
      const modelHit = (rule.preferredModels || []).includes(item.id) || (rule.preferredModels || []).includes(item.upstreamModel);
      if (providerHit) score += Number(weights.referenceRole || 180) * Math.max(0.2, weightFactor);
      if (modelHit) score += Number(weights.referenceRole || 180) * 1.35 * Math.max(0.2, weightFactor);
    }
  }
  return score;
}

function videoGenerationModeRoutingScore(item, generationMode = '', routingConfig = {}, weights = {}) {
  const modeRule = routingConfig?.[generationMode];
  if (!modeRule || typeof modeRule !== 'object') return 0;
  let score = 0;
  if ((modeRule.preferredProviders || []).includes(item.provider)) {
    score += Number(weights.generationMode || 260);
  }
  if ((modeRule.preferredModels || []).includes(item.id) || (modeRule.preferredModels || []).includes(item.upstreamModel)) {
    score += Number(weights.generationMode || 260) * 1.35;
  }
  return score;
}

function shouldPreserveRequestedModelIdentifier(requestedModel = '', catalogItem = null) {
  const normalizedRequested = normalizeCatalogIdentifier(requestedModel || '');
  if (!normalizedRequested || !catalogItem || typeof catalogItem !== 'object') {
    return Boolean(normalizedRequested);
  }
  const normalizedCatalogId = normalizeCatalogIdentifier(catalogItem.id || '');
  const normalizedUpstream = normalizeCatalogIdentifier(catalogItem.upstreamModel || '');
  if (normalizedCatalogId && normalizedRequested === normalizedCatalogId && normalizedUpstream && normalizedUpstream !== normalizedCatalogId) {
    return false;
  }
  return true;
}

async function resolveImageOperationDispatch(body = {}, requestedProvider = '', requestedModel = '') {
  const toolOperation = String(body?.tool_operation || '').trim();
  const conditioningOperation = String(body?.conditioning_strategy?.operation || '').trim();
  const operation = toolOperation || conditioningOperation;
  const dispatchConfig = await loadOperationDispatchConfig();
  const strategy = dispatchConfig?.operations?.[operation] || IMAGE_OPERATION_DISPATCH[operation];
  if (!strategy) {
    return {
      provider: requestedProvider,
      model: requestedModel,
      operation,
      strategy: null,
      dispatchMode: 'requested',
    };
  }

  const globalWeights = dispatchConfig?.global?.weights || {};
  const regionHint = String(body?.region_hint || process.env.HMDAO_REGION_HINT || 'CN').toUpperCase();
  const regionPreference = dispatchConfig?.global?.regionPreference?.[regionHint] || dispatchConfig?.global?.regionPreference?.OTHER || {};
  const primaryAssets = normalizeReferenceAssets(body?.primary_assets);
  const referenceAssets = normalizeReferenceAssets(body?.reference_assets);
  const routingAssets = [...primaryAssets, ...referenceAssets];
  const identityController = normalizeIdentityController(body?.identity_controller);
  const referenceRouting = dispatchConfig?.global?.referenceRouting?.image || {};
  const coverageOptions = { imageStrategyOperation: conditioningOperation };
  const capabilityRequirements = [
    ...(toolOperation ? [{ key: 'toolOperation', value: toolOperation }] : []),
    ...routingAssets.flatMap((asset) => expandedReferenceRoles(asset, coverageOptions).map((role) => ({ key: 'referenceRole', value: role }))),
    ...(identityController.enabled && identityController.identityLockMode !== 'off' ? [{ key: 'supportsIdentityController', value: true }] : []),
  ];
  const disabledModels = new Set([
    ...(dispatchConfig?.global?.disabledModels || []),
    ...(strategy?.disabledModels || []),
  ]);

  const candidateModels = (strategy.candidates || [])
    .map((modelId) => catalogModelByIdentifier(modelId))
    .filter((item) => item && item.mode === 'image');
  const activatedModels = activatedModelIds();

  const exactMatch = MODEL_CATALOG.find((item) => modelMatchesIdentifier(item, requestedModel) && item.provider === requestedProvider && item.mode === 'image');
  const requested = MODEL_CATALOG.find((item) => modelMatchesIdentifier(item, requestedModel) && item.mode === 'image');
  const providerRequested = requestedProvider
    ? MODEL_CATALOG.find((item) => item.provider === requestedProvider && item.mode === 'image')
    : undefined;

  if (exactMatch) {
    const preserveRequestedModel = shouldPreserveRequestedModelIdentifier(requestedModel, exactMatch);
    return {
      provider: exactMatch.provider,
      model: preserveRequestedModel
        ? (requestedModel || exactMatch.upstreamModel || exactMatch.id)
        : (exactMatch.upstreamModel || exactMatch.id || requestedModel),
      operation,
      strategy,
      dispatchMode: 'requested',
    };
  }

  const ranked = [exactMatch, requested, providerRequested, ...candidateModels]
    .filter((item, index, array) => item && array.findIndex((entry) => entry?.id === item.id) === index)
    .map((item) => {
      const activationScore = isCatalogModelActivated(item) || activatedModels.has(item.id) || activatedModels.has(item.upstreamModel)
        ? Number(globalWeights.activation || 1200)
        : 0;
      const preferredModelScore = (strategy.candidates || []).includes(item.id) || (strategy.candidates || []).includes(item.upstreamModel)
        ? Number(globalWeights.preferredModel || 260)
        : 0;
      const preferredProviderScore = (strategy.preferredProviders || []).includes(item.provider)
        ? Number(globalWeights.preferredProvider || 140)
        : 0;
      const regionScore = providerRegionAffinityScore(item.provider, regionPreference, globalWeights);
      const referenceScore = referenceRoleRoutingScore(item, routingAssets, referenceRouting, globalWeights, coverageOptions);
      const capabilityScore = capabilityPenalty(item, capabilityRequirements, globalWeights);
      const disabledScore = disabledModels.has(item.id) || disabledModels.has(item.upstreamModel)
        ? Number(globalWeights.disabled || -100000)
        : 0;
      const costScore = Number(item.price || 0) * Number(globalWeights.cost || -22);
      const latencyScore = parseLatencySeconds(item.latency) * Number(globalWeights.latency || -9);

      return {
        item,
        score: activationScore + preferredModelScore + preferredProviderScore + regionScore + referenceScore + capabilityScore + disabledScore + costScore + latencyScore,
      };
    });

  ranked.sort((left, right) => right.score - left.score);

  const chosen = ranked[0]?.item || requested || exactMatch;
  const preserveRequestedModel = chosen && modelMatchesIdentifier(chosen, requestedModel)
    ? shouldPreserveRequestedModelIdentifier(requestedModel, chosen)
    : false;
  return {
    provider: chosen?.provider || requestedProvider,
    model: chosen && modelMatchesIdentifier(chosen, requestedModel)
      ? (preserveRequestedModel
        ? (requestedModel || chosen?.upstreamModel || chosen?.id)
        : (chosen?.upstreamModel || chosen?.id || requestedModel))
      : (chosen?.upstreamModel || chosen?.id || requestedModel),
    operation,
    strategy,
    dispatchMode: chosen && modelMatchesIdentifier(chosen, requestedModel) ? 'requested' : 'operation-dispatch',
  };
}

async function resolveVideoOperationDispatch(body = {}, requestedProvider = '', requestedModel = '') {
  const dispatchConfig = await loadOperationDispatchConfig();
  const globalWeights = dispatchConfig?.global?.weights || {};
  const regionHint = String(body?.region_hint || process.env.HMDAO_REGION_HINT || 'CN').toUpperCase();
  const regionPreference = dispatchConfig?.global?.regionPreference?.[regionHint] || dispatchConfig?.global?.regionPreference?.OTHER || {};
  const primaryAssets = normalizeReferenceAssets(body?.primary_assets);
  const referenceAssets = normalizeReferenceAssets(body?.reference_assets);
  const identityController = normalizeIdentityController(body?.identity_controller);
  const conditioningOperation = String(body?.conditioning_strategy?.operation || '').trim();
  const routingAssets = [...primaryAssets, ...referenceAssets];
  const sourceMediaType = String(body?.source_media_type || '').trim().toLowerCase();
  const generationMode = conditioningOperation
    || String(body?.generation_mode || '').trim()
    || (routingAssets.some((item) => item.type === 'video') || sourceMediaType === 'video' ? 'referenceVideo' : routingAssets.some((item) => item.type === 'image') ? 'imageToVideo' : 'textToVideo');
  const referenceRouting = dispatchConfig?.global?.referenceRouting?.video || {};
  const generationModeRouting = dispatchConfig?.global?.referenceRouting?.videoGenerationModes || {};
  const coverageOptions = { imageStrategyOperation: conditioningOperation };
  const primaryVideoProfile = readVideoSourceProfile(primaryAssets, sourceMediaType);
  const sourceConstraint = buildVideoSourceConstraint(primaryVideoProfile);
  const normalizedRequestedModel = normalizeCatalogIdentifier(requestedModel || '');
  const hasExplicitRequestedModel = Boolean(normalizedRequestedModel);
  const hasImageReference = referenceAssets.some((item) => item.type === 'image');
  const hasVideoReference = routingAssets.some((item) => item.type === 'video');
  const expandedReferenceRoleSet = new Set(routingAssets.flatMap((asset) => expandedReferenceRoles(asset, coverageOptions)));
  const hasSubjectReference = expandedReferenceRoleSet.has('subject');
  const hasCompositionReference = expandedReferenceRoleSet.has('composition');
  const hasOmniReference = referenceAssets.some((item) => String(item.role || '').trim().toLowerCase() === 'omni');
  const requiresAdvancedReferenceControl = hasOmniReference
    || (hasSubjectReference && hasCompositionReference)
    || (sourceMediaType === 'video' && hasImageReference)
    || expandedReferenceRoleSet.size >= 3;
  const forcedKlingOmniRoute = shouldForceKlingOmniVideoRoute({
    requestedProvider,
    requestedModel,
    sourceMediaType,
    generationMode,
    hasImageReference,
    hasVideoReference,
    requiresAdvancedReferenceControl,
  });
  const effectiveRequestedModel = forcedKlingOmniRoute ? 'kling-v3-omni' : requestedModel;
  const capabilityRequirements = [
    ...(generationMode ? [{ key: 'generationMode', value: generationMode }] : []),
    ...routingAssets.flatMap((asset) => expandedReferenceRoles(asset, coverageOptions).map((role) => ({ key: 'referenceRole', value: role }))),
    ...(generationMode === 'textToVideo' ? [{ key: 'supportsTextToVideo', value: true }] : []),
    ...(generationMode === 'imageToVideo' ? [{ key: 'supportsImageToVideo', value: true }] : []),
    ...(generationMode === 'firstLastFrame' ? [{ key: 'supportsFirstLastFrame', value: true }] : []),
    ...(generationMode === 'referenceVideo' || hasVideoReference ? [{ key: 'supportsReferenceVideo', value: true }] : []),
    ...(hasImageReference || generationMode === 'imageToVideo' || generationMode === 'firstLastFrame' ? [{ key: 'supportsReferenceImage', value: true }] : []),
    ...(sourceMediaType === 'video' ? [{ key: 'supportsPrimaryVideoMotionLock', value: true }] : []),
    ...(sourceMediaType === 'video' && hasVideoReference ? [{ key: 'supportsActionTransfer', value: true }] : []),
    ...(sourceMediaType === 'video' && hasImageReference ? [{ key: 'supportsVideoStyleTransfer', value: true }] : []),
    ...(requiresAdvancedReferenceControl ? [{ key: 'supportsIdentityController', value: true }] : []),
    ...(identityController.enabled && identityController.identityLockMode !== 'off' ? [{ key: 'supportsIdentityController', value: true }] : []),
  ];
  const requested = MODEL_CATALOG.find((item) => modelMatchesIdentifier(item, effectiveRequestedModel) && item.mode === 'video');
  const exactMatch = MODEL_CATALOG.find((item) => modelMatchesIdentifier(item, effectiveRequestedModel) && item.provider === requestedProvider && item.mode === 'video');
  const providerRequested = requestedProvider
    ? MODEL_CATALOG.find((item) => item.provider === requestedProvider && item.mode === 'video')
    : undefined;

  const exactMatchRouteConstraint = exactMatch
    ? buildVideoRouteConstraint({
      catalogItem: exactMatch,
      sourceMediaType,
      activatedRecord: getActivatedProviderRecord(exactMatch.provider, 'video'),
    })
    : null;

  const requestedRouteConstraint = requested
    ? buildVideoRouteConstraint({
      catalogItem: requested,
      sourceMediaType,
      activatedRecord: getActivatedProviderRecord(requested.provider, 'video'),
    })
    : null;

  if (
    exactMatch
    && !(sourceConstraint?.severity === 'hard' && isKlingVideoModelIdentifier(exactMatch.upstreamModel || exactMatch.id || effectiveRequestedModel))
    && (hasExplicitRequestedModel || !(exactMatchRouteConstraint?.severity === 'hard'))
  ) {
    const preserveRequestedModel = shouldPreserveRequestedModelIdentifier(effectiveRequestedModel, exactMatch);
    return {
      provider: exactMatch.provider,
      model: preserveRequestedModel
        ? (effectiveRequestedModel || exactMatch.upstreamModel || exactMatch.id)
        : (exactMatch.upstreamModel || exactMatch.id || effectiveRequestedModel),
      operation: generationMode,
      strategy: {
        primaryAssets,
        referenceAssets,
        routingAssets,
        generationMode,
        identityController,
        capabilityRequirements,
        sourceConstraint,
        routeConstraint: exactMatchRouteConstraint,
        primaryVideoProfile,
        forcedModel: forcedKlingOmniRoute ? 'kling-v3-omni' : '',
      },
      dispatchMode: forcedKlingOmniRoute
        ? 'forced-primary-video-kling-omni'
        : hasExplicitRequestedModel
          ? 'explicit-model'
          : 'requested',
    };
  }

  if (
    requested
    && hasExplicitRequestedModel
    && !(sourceConstraint?.severity === 'hard' && isKlingVideoModelIdentifier(requested.upstreamModel || requested.id || effectiveRequestedModel))
  ) {
    const preserveRequestedModel = shouldPreserveRequestedModelIdentifier(effectiveRequestedModel, requested);
    return {
      provider: requested.provider,
      model: preserveRequestedModel
        ? (effectiveRequestedModel || requested.upstreamModel || requested.id)
        : (requested.upstreamModel || requested.id || effectiveRequestedModel),
      operation: generationMode,
      strategy: {
        primaryAssets,
        referenceAssets,
        routingAssets,
        generationMode,
        identityController,
        capabilityRequirements,
        sourceConstraint,
        routeConstraint: requestedRouteConstraint,
        primaryVideoProfile,
        forcedModel: '',
      },
      dispatchMode: 'explicit-model',
    };
  }

  const ranked = [exactMatch, requested, providerRequested, ...MODEL_CATALOG.filter((item) => item.mode === 'video')]
    .filter((item, index, array) => item && array.findIndex((entry) => entry?.id === item.id) === index)
    .map((item) => {
      const activationScore = isCatalogModelActivated(item)
        ? Number(globalWeights.activation || 1200)
        : 0;
      const regionScore = providerRegionAffinityScore(item.provider, regionPreference, globalWeights);
      const referenceScore = referenceRoleRoutingScore(item, routingAssets, referenceRouting, globalWeights, coverageOptions);
      const generationModeScore = videoGenerationModeRoutingScore(item, generationMode, generationModeRouting, globalWeights);
      const capabilityScore = capabilityPenalty(item, capabilityRequirements, globalWeights);
      const unsupportedConditionScore = generationMode === 'videoStyleTransfer' && item.provider === 'siliconflow'
        ? Number(globalWeights.disabled || -100000)
        : 0;
      const routeConstraint = buildVideoRouteConstraint({
        catalogItem: item,
        sourceMediaType,
        activatedRecord: getActivatedProviderRecord(item.provider, 'video'),
      });
      const sourceConstraintScore = sourceConstraint?.severity === 'hard' && isKlingVideoModelIdentifier(item.upstreamModel || item.id)
        ? Number(globalWeights.disabled || -100000)
        : 0;
      const routeConstraintScore = routeConstraint?.severity === 'hard'
        ? Number(globalWeights.disabled || -100000)
        : 0;
      const costScore = Number(item.price || 0) * Number(globalWeights.cost || -22);
      const latencyScore = parseLatencySeconds(item.latency) * Number(globalWeights.latency || -9);
      return {
        item,
        routeConstraint,
        score: activationScore + regionScore + referenceScore + generationModeScore + capabilityScore + unsupportedConditionScore + sourceConstraintScore + routeConstraintScore + costScore + latencyScore,
      };
    });

  ranked.sort((left, right) => right.score - left.score);
  const chosen = ranked[0]?.item || requested || exactMatch;
  const chosenRouteConstraint = ranked[0]?.routeConstraint || buildVideoRouteConstraint({
    catalogItem: chosen,
    sourceMediaType,
    activatedRecord: chosen ? getActivatedProviderRecord(chosen.provider, 'video') : null,
  });
  const preserveRequestedModel = chosen && modelMatchesIdentifier(chosen, effectiveRequestedModel)
    ? shouldPreserveRequestedModelIdentifier(effectiveRequestedModel, chosen)
    : false;
  return {
    provider: chosen?.provider || requestedProvider,
    model: chosen && modelMatchesIdentifier(chosen, effectiveRequestedModel)
      ? (preserveRequestedModel
        ? (effectiveRequestedModel || chosen?.upstreamModel || chosen?.id)
        : (chosen?.upstreamModel || chosen?.id || effectiveRequestedModel))
      : (chosen?.upstreamModel || chosen?.id || effectiveRequestedModel),
    operation: generationMode,
    strategy: {
      primaryAssets,
      referenceAssets,
      routingAssets,
      generationMode,
      identityController,
      capabilityRequirements,
      sourceConstraint,
      routeConstraint: chosenRouteConstraint,
      primaryVideoProfile,
      forcedModel: forcedKlingOmniRoute ? 'kling-v3-omni' : '',
    },
    dispatchMode: forcedKlingOmniRoute
      ? 'forced-primary-video-kling-omni'
      : chosen && modelMatchesIdentifier(chosen, effectiveRequestedModel)
        ? 'requested'
        : sourceConstraint?.severity === 'hard'
          ? 'source-constraint-fallback'
          : 'reference-routing',
  };
}

function normalizeMediaDataUrl(buffer, contentType = 'application/octet-stream') {
  return `data:${contentType};base64,${buffer.toString('base64')}`;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

const ASSET_HASH_LARGE_FILE_BYTES = 50 * 1024 * 1024;
const ASSET_HASH_SAMPLE_BYTES = 4 * 1024 * 1024;

// 抽取视频指定时间点的单帧（缩放后）哈希，避免整文件读取造成的超大视频卡顿。
async function captureVideoFrameHash(filePath, seekSeconds = 0, maxBytes = 8 * 1024 * 1024) {
  try {
    const ffmpegPath = String(process.env.HMDAO_FFMPEG_PATH || 'ffmpeg').trim() || 'ffmpeg';
    const seek = Math.max(0, Number(seekSeconds) || 0);
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const child = spawn(ffmpegPath, [
        '-loglevel', 'error',
        '-ss', seek.toFixed(3),
        '-i', String(filePath),
        '-vf', 'scale=320:-1',
        '-frames:v', '1',
        '-f', 'rawvideo',
        '-pix_fmt', 'rgb24',
        '-',
      ]);
      const chunks = [];
      let total = 0;
      child.stdout.on('data', (chunk) => {
        if (total >= maxBytes) return;
        const take = Math.min(chunk.length, maxBytes - total);
        chunks.push(chunk.subarray(0, take));
        total += take;
        if (total >= maxBytes) {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }
      });
      child.on('error', () => finish(''));
      child.on('close', () => {
        if (chunks.length === 0) return finish('');
        try {
          finish(sha256(Buffer.concat(chunks)));
        } catch {
          finish('');
        }
      });
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }, 20000);
      if (timer.unref) timer.unref();
    });
  } catch {
    return '';
  }
}

// 视频内容级去重：多关键帧采样哈希（10% / 50% / 90% 三点），降低仅首帧相同的漏判。
// 折中方案：多帧哈希 + 尺寸 + 时长，既能区分不同视频，又把开销控制在少量帧采样范围内。
// 无有效时长时退化为首帧单点采样，保持向后兼容。
async function computeVideoFirstFrameHash(filePath, options = {}) {
  const duration = Math.max(0, Number(options?.duration) || 0);
  const maxBytes = Number(options?.maxBytes) || 8 * 1024 * 1024;
  const timepoints = duration > 1
    ? [duration * 0.1, duration * 0.5, duration * 0.9]
    : [0];
  const hashes = [];
  for (const point of timepoints) {
    // 串行采样，避免同时启动多个 ffmpeg 进程造成资源峰值
    // eslint-disable-next-line no-await-in-loop
    const frameHash = await captureVideoFrameHash(filePath, point, maxBytes);
    hashes.push(frameHash || '');
  }
  if (hashes.every((entry) => !entry)) return '';
  return sha256(hashes.join('|'));
}

// 内容指纹哈希：对大文件/视频采用折中策略，避免整文件读取。
// - 视频：首帧哈希 + 尺寸 + 时长（contentHash 优先于 URL/路径去重）
// - 大文件（>50MB）：仅取样前 4MB + 尺寸
// - 普通文件：整文件 SHA-256
async function computeAssetContentHash(filePath, options = {}) {
  const normalizedPath = String(filePath || '');
  if (!normalizedPath) return '';
  const type = String(options.type || '').trim();
  const duration = Math.max(0, Number(options.duration || 0)) || 0;
  try {
    const stat = await fs.stat(normalizedPath);
    const size = Number(stat.size || 0);
    if (type === 'video') {
      const frameHash = await computeVideoFirstFrameHash(normalizedPath, { duration });
      return sha256(`video:${size}:${duration}:${frameHash}`);
    }
    if (size > ASSET_HASH_LARGE_FILE_BYTES) {
      const fd = await fs.open(normalizedPath, 'r');
      try {
        const sample = Buffer.alloc(Math.min(ASSET_HASH_SAMPLE_BYTES, size));
        const { bytesRead } = await fd.read(sample, 0, sample.length, 0);
        return sha256(`sample:${size}:${sha256(sample.subarray(0, bytesRead))}`);
      } finally {
        await fd.close().catch(() => {});
      }
    }
    const buffer = await fs.readFile(normalizedPath);
    return sha256(buffer);
  } catch {
    return '';
  }
}

// 基于已落库目录计算重复分组（以 contentHash 优先）。
// 返回每组的规范项 canonicalId 及其所有重复项 duplicateIds。
function buildAssetLibraryDuplicateGroups(items = []) {
  const seen = new Map();
  const groups = [];
  for (const item of items) {
    const fingerprint = buildAssetDuplicateFingerprint(item);
    if (!fingerprint) continue;
    const existing = seen.get(fingerprint);
    if (existing) {
      existing.duplicateIds.push(String(item.id || ''));
    } else {
      seen.set(fingerprint, {
        canonicalId: String(item.id || ''),
        type: String(item.type || ''),
        name: String(item.name || ''),
        contentHash: String(item.contentHash || ''),
        duplicateIds: [],
      });
    }
  }
  for (const group of seen.values()) {
    if (group.duplicateIds.length > 0) groups.push(group);
  }
  return groups;
}

function svgDataUrl(prompt, provider, mode) {
  const title = mode === 'video' ? 'HMDao Video Plan' : mode === 'image' ? 'HMDao Image' : 'HMDao Result';
  const esc = (value) => String(value || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#101827"/>
        <stop offset="0.5" stop-color="#0f766e"/>
        <stop offset="1" stop-color="#1f2937"/>
      </linearGradient>
    </defs>
    <rect width="1280" height="720" fill="url(#g)"/>
    <circle cx="1020" cy="160" r="120" fill="#22d3ee" opacity="0.16"/>
    <circle cx="250" cy="560" r="170" fill="#f59e0b" opacity="0.14"/>
    <text x="80" y="130" fill="#e5f9f6" font-family="Arial, sans-serif" font-size="54" font-weight="700">${title}</text>
    <text x="80" y="198" fill="#a7f3d0" font-family="Arial, sans-serif" font-size="26">${esc(provider)} / ${esc(mode)}</text>
    <foreignObject x="80" y="260" width="1120" height="260">
      <div xmlns="http://www.w3.org/1999/xhtml" style="font: 38px Arial, sans-serif; color: #ffffff; line-height: 1.35; word-break: break-word;">${esc(prompt)}</div>
    </foreignObject>
    <text x="80" y="650" fill="#cbd5e1" font-family="Arial, sans-serif" font-size="22">Generated by local HMDao API fallback</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function extractFirstString(value) {
  if (typeof value === 'string' && value.trim()) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = extractFirstString(item);
      if (nested) return nested;
    }
    return '';
  }
  if (value && typeof value === 'object') {
    return extractFirstString(
      value.content ||
      value.text ||
      value.output_text ||
      value.url ||
      value.b64_json ||
      value.message?.content,
    );
  }
  return '';
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([, item]) => item !== undefined && item !== null && item !== ''),
  );
}

function classifyProxyError({ code = '', status = 0, message = '' } = {}) {
  const normalized = String(message || '').toLowerCase();
  if (code === 'validation_error') return 'validation';
  if (code === 'timeout' || normalized.includes('timed out') || normalized.includes('timeout')) return 'timeout';
  if (normalized.includes('insufficient balance') || normalized.includes('balance is insufficient') || normalized.includes('balance insufficient') || normalized.includes('quota exceeded') || normalized.includes('insufficient quota') || normalized.includes('token limit exceeded')) {
    return 'quota';
  }
  if (status === 401 || status === 403) return 'auth';
  if (status === 404 || normalized.includes('not found')) return 'routing';
  if (status >= 500) return 'upstream';
  return 'request';
}

function normalizeAspectRatio(value, fallback = '16:9') {
  const raw = String(value || fallback).trim();
  return /^\d+:\d+$/.test(raw) ? raw : fallback;
}

const INTERNAL_GENERATION_FIELDS = new Set([
  'base_prompt',
  'tool_prompt',
  'tool_operation',
  'tool_capability',
  'tool_config',
  'image_tool',
  'video_tool',
  'generation_mode',
  'motion_preset',
  'style_preset',
  'motion_strength',
  'consistency_strength',
  'reference_weight',
  'source_media_type',
  'primary_assets',
  'reference_assets',
  'reference_summary',
  'conditioning_strategy',
  'workflow_graph',
  'identity_controller',
  'shared_memory_ids',
  'shared_memory_layers',
  'shared_memory_context',
  'shared_memory_refs',
  'linked_audio_url',
  'linked_audio_asset_id',
  'linked_audio_mode',
  'linked_audio_label',
  'linked_audio_backend',
  'audio_mix_mode',
  'audio_gain',
  'video_gain',
  'panorama',
  'multi_angle',
  'lighting',
  'camera_control',
  'grid',
  'split',
]);

function stripInternalGenerationFields(payload = {}) {
  return Object.fromEntries(
    Object.entries(payload || {}).filter(([key]) => !INTERNAL_GENERATION_FIELDS.has(key)),
  );
}

function normalizeProviderPayload(provider, mode, body = {}) {
  const payload = body && typeof body === 'object' ? stripInternalGenerationFields(body) : {};
  const aspectRatio = normalizeAspectRatio(payload.aspect_ratio, mode === 'image' ? '1:1' : '16:9');
  const width = Number(payload.width);
  const height = Number(payload.height);
  const count = Number(payload.count);
  const sanitized = compactObject({
    ...payload,
    aspect_ratio: aspectRatio,
    width: Number.isFinite(width) ? Math.max(256, Math.min(4096, Math.round(width))) : undefined,
    height: Number.isFinite(height) ? Math.max(256, Math.min(4096, Math.round(height))) : undefined,
    steps: Number.isFinite(Number(payload.steps)) ? Math.max(1, Math.min(80, Math.round(Number(payload.steps)))) : undefined,
    fps: Number.isFinite(Number(payload.fps)) ? Math.max(8, Math.min(60, Math.round(Number(payload.fps)))) : undefined,
    duration: Number.isFinite(Number(payload.duration)) ? Math.max(1, Math.min(30, Math.round(Number(payload.duration)))) : undefined,
    count: Number.isFinite(count) ? Math.max(1, Math.min(4, Math.round(count))) : undefined,
  });

  if (provider === 'replicate') {
    return compactObject({
      ...sanitized,
      input: compactObject({
        prompt: sanitized.prompt,
        image: sanitized.source_url,
        first_frame_image: sanitized.first_frame_url || sanitized.source_url,
        last_frame_image: sanitized.last_frame_url,
        reference_image: sanitized.reference_image_url,
        reference_video: sanitized.reference_video_url,
        aspect_ratio: sanitized.aspect_ratio,
        width: sanitized.width,
        height: sanitized.height,
        num_inference_steps: sanitized.steps,
        num_frames: sanitized.duration && sanitized.fps ? sanitized.duration * sanitized.fps : undefined,
        num_outputs: mode === 'image' ? sanitized.count : undefined,
      }),
      count: undefined,
    });
  }

  if (provider === 'fal') {
    return compactObject({
      ...sanitized,
      image_url: sanitized.source_url,
      first_frame_image_url: sanitized.first_frame_url || sanitized.source_url,
      last_frame_image_url: sanitized.last_frame_url,
      reference_image_url: sanitized.reference_image_url,
      reference_video_url: sanitized.reference_video_url,
      guidance_scale: Number.isFinite(Number(payload.guidance_scale)) ? Number(payload.guidance_scale) : undefined,
      num_images: mode === 'image' ? sanitized.count : undefined,
      count: undefined,
    });
  }

  if (provider === 'openai') {
    return compactObject({
      model: sanitized.model,
      prompt: sanitized.prompt,
      size: sanitized.width && sanitized.height ? `${sanitized.width}x${sanitized.height}` : sanitized.resolution,
      quality: sanitized.quality === 'hd' || sanitized.quality === '2k' ? 'high' : sanitized.quality,
      n: sanitized.count,
    });
  }

  if (provider === 'siliconflow' || provider === 'bailian' || provider === 'zhipu' || provider === 'modelscope' || provider === 'volcengine') {
    return compactObject({
      ...sanitized,
      n: sanitized.count,
      count: undefined,
    });
  }

  if (provider === 'kling') {
    return compactObject({
      ...sanitized,
      image: sanitized.source_url,
      first_frame_image: sanitized.first_frame_url || sanitized.source_url,
      last_frame_image: sanitized.last_frame_url,
      reference_image: sanitized.reference_image_url,
      reference_video: sanitized.reference_video_url,
      mode,
      count: undefined,
    });
  }

  return sanitized;
}

function validateGenerationRequest({ provider, endpoint, method = 'POST', body = {} }) {
  if (!provider || typeof provider !== 'string') {
    return { ok: false, error: { code: 'validation_error', message: 'provider is required.' } };
  }
  if (!endpoint || typeof endpoint !== 'string' || !endpoint.startsWith('/')) {
    return { ok: false, error: { code: 'validation_error', message: 'endpoint must start with /.' } };
  }
  const mode = inferMode(endpoint);
  if (!providers.some((item) => item.id === provider)) {
    return { ok: false, error: { code: 'validation_error', message: `Unknown provider: ${provider}.` } };
  }
  if (method !== 'POST' && method !== 'GET' && method !== 'PUT' && method !== 'DELETE') {
    return { ok: false, error: { code: 'validation_error', message: `Unsupported method: ${method}.` } };
  }
  if (mode === 'llm') {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    if (!messages.length) {
      return { ok: false, error: { code: 'validation_error', message: 'LLM request requires messages.' } };
    }
  } else {
    if (!body?.model || !body?.prompt) {
      return { ok: false, error: { code: 'validation_error', message: `${mode} request requires model and prompt.` } };
    }
  }
  return { ok: true, mode };
}

function generationToolMetadata(body = {}) {
  return compactObject({
    imageTool: body?.image_tool,
    videoTool: body?.video_tool,
    generationMode: body?.generation_mode,
    motionPreset: body?.motion_preset,
    stylePreset: body?.style_preset,
    motionStrength: body?.motion_strength,
    consistencyStrength: body?.consistency_strength,
    referenceWeight: body?.reference_weight,
    firstFrameUrl: body?.first_frame_url,
    lastFrameUrl: body?.last_frame_url,
    primaryAssets: Array.isArray(body?.primary_assets) ? body.primary_assets : undefined,
    referenceImageUrl: body?.reference_image_url,
    referenceVideoUrl: body?.reference_video_url,
    referenceAssets: Array.isArray(body?.reference_assets) ? body.reference_assets : undefined,
    referenceSummary: body?.reference_summary,
    conditioningStrategy: body?.conditioning_strategy,
    workflowGraph: body?.workflow_graph,
    identityController: body?.identity_controller,
    sharedMemoryIds: Array.isArray(body?.shared_memory_ids) ? body.shared_memory_ids : undefined,
    sharedMemoryLayers: Array.isArray(body?.shared_memory_layers) ? body.shared_memory_layers : undefined,
    sharedMemoryContext: Array.isArray(body?.shared_memory_context) ? body.shared_memory_context : undefined,
    sharedMemoryRefs: Array.isArray(body?.shared_memory_refs) ? body.shared_memory_refs : undefined,
    linkedAudioUrl: body?.linked_audio_url,
    linkedAudioAssetId: body?.linked_audio_asset_id,
    linkedAudioMode: body?.linked_audio_mode,
    linkedAudioLabel: body?.linked_audio_label,
    linkedAudioBackend: body?.linked_audio_backend,
    audioMixMode: body?.audio_mix_mode,
    audioGain: body?.audio_gain,
    videoGain: body?.video_gain,
    toolOperation: body?.tool_operation,
    toolCapability: body?.tool_capability,
    toolConfig: body?.tool_config,
    basePrompt: body?.base_prompt,
  });
}

function attachGenerationToolMetadata(result, metadata = {}) {
  if (!result || !Object.keys(metadata).length || !result.asset) return result;
  return {
    ...result,
    asset: {
      ...result.asset,
      metadata: {
        ...(result.asset.metadata || {}),
        ...metadata,
      },
    },
    assets: Array.isArray(result.assets)
      ? result.assets.map((asset) => ({
          ...asset,
          metadata: {
            ...(asset?.metadata || {}),
            ...metadata,
          },
        }))
      : result.assets,
  };
}

function normalizeUpstreamPayload({ provider, mode, data, contentType, status }) {
  if (Buffer.isBuffer(data)) {
    return {
      success: true,
      provider,
      mode,
      asset: {
        id: crypto.randomUUID(),
        type: mode === 'video' ? 'video' : mode === 'audio' ? 'audio' : 'image',
        url: normalizeMediaDataUrl(data, contentType),
        metadata: {
          provider,
          upstreamStatus: status,
          bytes: data.length,
          sha256: sha256(data),
          contentType,
          chunkCount: 1,
        },
      },
    };
  }

  const content =
    extractFirstString(data?.choices?.[0]?.message?.content) ||
    extractFirstString(data?.choices?.[0]?.text) ||
    extractFirstString(data?.output_text) ||
    extractFirstString(data?.content) ||
    extractFirstString(data?.text);

  const assetUrl =
    extractFirstString(data?.data?.[0]?.url) ||
    extractFirstString(data?.output?.[0]?.url) ||
    extractFirstString(data?.results?.videos?.[0]?.url) ||
    extractFirstString(data?.result?.url) ||
    extractFirstString(data?.video?.url) ||
    extractFirstString(data?.image?.url);

  const assetBase64 =
    extractFirstString(data?.data?.[0]?.b64_json) ||
    extractFirstString(data?.image?.b64_json);

  const metadata = {
    provider,
    upstreamStatus: status,
    contentType,
    rawKeys: data && typeof data === 'object' ? Object.keys(data).slice(0, 12) : [],
  };

  const mediaType = mode === 'video' ? 'video' : mode === 'audio' ? 'audio' : 'image';
  const assetItems = [
    ...(Array.isArray(data?.data) ? data.data : []),
    ...(Array.isArray(data?.output) ? data.output : []),
    ...(Array.isArray(data?.results?.videos) ? data.results.videos : []),
  ]
    .map((item, index) => {
      const itemUrl =
        extractFirstString(item?.url) ||
        extractFirstString(item?.image?.url) ||
        extractFirstString(item?.video?.url);
      const itemBase64 =
        extractFirstString(item?.b64_json) ||
        extractFirstString(item?.image?.b64_json);
      if (!itemUrl && !itemBase64) return null;
      return {
        id: crypto.randomUUID(),
        type: mediaType,
        url: itemUrl || `data:${mediaType === 'image' ? 'image/png' : mediaType === 'video' ? 'video/mp4' : 'audio/mpeg'};base64,${itemBase64}`,
        metadata: {
          ...metadata,
          outputIndex: index,
        },
      };
    })
    .filter(Boolean);

  if (assetItems.length > 0) {
    return {
      success: true,
      provider,
      mode,
      content,
      asset: assetItems[0],
      assets: assetItems,
    };
  }

  if (assetUrl || assetBase64) {
    const normalizedUrl = assetUrl || `data:${mediaType === 'image' ? 'image/png' : mediaType === 'video' ? 'video/mp4' : 'audio/mpeg'};base64,${assetBase64}`;
    return {
      success: true,
      provider,
      mode,
      content,
      asset: {
        id: crypto.randomUUID(),
        type: mediaType,
        url: normalizedUrl,
        metadata,
      },
    };
  }

  return {
    success: true,
    provider,
    mode,
    content,
    raw: data,
  };
}

function siliconflowVideoImageSize(payload = {}) {
  const width = Number(payload.width);
  const height = Number(payload.height);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return `${Math.round(width)}x${Math.round(height)}`;
  }

  const quality = String(payload.quality || '').trim().toLowerCase();
  const aspectRatio = normalizeAspectRatio(payload.aspect_ratio || payload.aspectRatio || '16:9', '16:9');
  const presets = {
    '480p': { '16:9': '854x480', '9:16': '480x854', '1:1': '768x768', '4:3': '640x480', '3:4': '480x640' },
    '720p': { '16:9': '1280x720', '9:16': '720x1280', '1:1': '1024x1024', '4:3': '960x720', '3:4': '720x960' },
    '1080p': { '16:9': '1920x1080', '9:16': '1080x1920', '1:1': '1536x1536', '4:3': '1440x1080', '3:4': '1080x1440' },
    '1440p': { '16:9': '2560x1440', '9:16': '1440x2560', '1:1': '2048x2048', '4:3': '1920x1440', '3:4': '1440x1920' },
  };
  const qualityKey = Object.prototype.hasOwnProperty.call(presets, quality) ? quality : '720p';
  return presets[qualityKey][aspectRatio] || presets[qualityKey]['16:9'];
}

function siliconflowVideoModel(payload = {}) {
  const requestedModel = String(payload.model || '').trim();
  if (requestedModel) return requestedModel;
  const generationMode = String(payload.generation_mode || '').trim();
  if (generationMode === 'textToVideo') return 'Wan-AI/Wan2.2-T2V-A14B';
  return 'Wan-AI/Wan2.2-I2V-A14B';
}

function normalizeSiliconflowVideoSubmitBody(payload = {}) {
  const model = siliconflowVideoModel(payload);
  const sourceMediaType = String(payload.source_media_type || '').trim().toLowerCase();
  const sourceUrl = sourceMediaType === 'video' ? '' : extractFirstString(payload.source_url);
  const firstFrameUrl = sourceMediaType === 'video' ? '' : extractFirstString(payload.first_frame_url);
  const conditioningImage =
    firstFrameUrl ||
    sourceUrl ||
    extractFirstString(payload.reference_image_url);

  return compactObject({
    model,
    prompt: payload.prompt,
    image: model.includes('I2V') ? conditioningImage : undefined,
    image_size: siliconflowVideoImageSize(payload),
    num_inference_steps: Number.isFinite(Number(payload.steps)) ? Math.max(1, Math.min(80, Math.round(Number(payload.steps)))) : undefined,
    duration: Number.isFinite(Number(payload.duration)) ? Math.max(1, Math.min(30, Math.round(Number(payload.duration)))) : undefined,
    seed: Number.isFinite(Number(payload.seed)) ? Math.round(Number(payload.seed)) : undefined,
    negative_prompt: extractFirstString(payload.negative_prompt),
  });
}

async function executeSiliconflowVideoRequest({ baseUrl, apiKey, payload, timeoutMs, signal }) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };

  const submitResponse = await fetch(`${baseUrl}/video/submit`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal,
  });

  const submitText = await submitResponse.text();
  let submitData = null;
  try {
    submitData = submitText ? JSON.parse(submitText) : null;
  } catch {
    submitData = { raw: submitText };
  }

  if (!submitResponse.ok) {
    const message = extractFirstString(submitData?.error?.message) || extractFirstString(submitData?.message) || `Upstream request failed with HTTP ${submitResponse.status}.`;
    return {
      success: false,
      provider: 'siliconflow',
      mode: 'video',
      error: {
        message,
        status: submitResponse.status,
        provider: 'siliconflow',
        category: classifyProxyError({ status: submitResponse.status, message }),
        code: extractFirstString(submitData?.error?.code) || '',
      },
      raw: submitData,
    };
  }

  const requestId = extractFirstString(submitData?.requestId) || extractFirstString(submitData?.request_id);
  if (!requestId) {
    return {
      success: false,
      provider: 'siliconflow',
      mode: 'video',
      error: {
        message: 'SiliconFlow video submit did not return a requestId.',
        status: submitResponse.status,
        provider: 'siliconflow',
        category: 'upstream',
      },
      raw: submitData,
    };
  }

  const startedAt = Date.now();
  let lastStatus = null;
  while (Date.now() - startedAt < timeoutMs) {
    const statusResponse = await fetch(`${baseUrl}/video/status`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ requestId }),
      signal,
    });
    const statusText = await statusResponse.text();
    let statusData = null;
    try {
      statusData = statusText ? JSON.parse(statusText) : null;
    } catch {
      statusData = { raw: statusText };
    }
    lastStatus = statusData;

    if (!statusResponse.ok) {
      const message = extractFirstString(statusData?.error?.message) || extractFirstString(statusData?.message) || `Video status polling failed with HTTP ${statusResponse.status}.`;
      return {
        success: false,
        provider: 'siliconflow',
        mode: 'video',
        error: {
          message,
          status: statusResponse.status,
          provider: 'siliconflow',
          category: classifyProxyError({ status: statusResponse.status, message }),
          code: extractFirstString(statusData?.error?.code) || '',
        },
        raw: statusData,
      };
    }

    const statusValue = String(statusData?.status || '').trim().toLowerCase();
    if (statusValue === 'succeed' || statusValue === 'success') {
      return normalizeUpstreamPayload({
        provider: 'siliconflow',
        mode: 'video',
        data: {
          requestId,
          ...statusData,
        },
        contentType: 'application/json',
        status: 200,
      });
    }
    if (statusValue === 'failed' || statusValue === 'error') {
      const message = extractFirstString(statusData?.reason) || extractFirstString(statusData?.message) || 'Video generation failed upstream.';
      return {
        success: false,
        provider: 'siliconflow',
        mode: 'video',
        error: {
          message,
          status: 502,
          provider: 'siliconflow',
          category: classifyProxyError({ status: 502, message }),
        },
        raw: statusData,
      };
    }

    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 5000);
      if (!signal) return;
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('AbortError'));
      }, { once: true });
    }).catch((error) => {
      if (error?.message === 'AbortError') {
        throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
      }
      throw error;
    });
  }

  return {
    success: false,
    provider: 'siliconflow',
    mode: 'video',
    error: {
      message: `Upstream request timed out after ${timeoutMs}ms.`,
      status: 0,
      provider: 'siliconflow',
      code: 'timeout',
      category: 'timeout',
    },
    raw: lastStatus,
  };
}

function getRealProxyBypassReason(provider, body = {}) {
  const inferredMode = inferMode(body?.endpoint || '');
  const activatedRecord = getActivatedProviderRecord(provider, inferredMode);
  const activatedApiKey = activatedRecord?.apiKey || '';
  const requestApiKey = body.apiKey || activatedApiKey;
  const litellmBaseUrl = String(process.env.HMDAO_LITELLM_BASE_URL || '').trim().replace(/\/$/, '');
  const baseUrl = litellmBaseUrl || normalizeRelayEndpointInput(body.baseUrl || activatedRecord?.endpoint || PROVIDER_BASE_URLS[provider] || '');

  if (!isRealApiProxyEnabled()) {
    return {
      code: 'real-api-disabled',
      category: 'routing',
      provider,
      mode: inferredMode,
      message: '当前 HMDao API 服务还没有可用的真实上游代理配置。请先在 API 管理页激活可用平台或设置 HMDAO_REAL_API=1 启动后端',
      detail: {
        realApiEnabled: false,
        hasActivatedProviderRecord: Boolean(activatedRecord),
        hasProviderApiKey: Boolean(requestApiKey || process.env.HMDAO_LITELLM_API_KEY),
        hasBaseUrl: Boolean(baseUrl),
      },
    };
  }

  if (!requestApiKey && !process.env.HMDAO_LITELLM_API_KEY) {
    return {
      code: 'missing-api-key',
      category: 'auth',
      provider,
      mode: inferredMode,
      message: '当前 provider 没有可用 API Key，真实上游请求没有发出',
      detail: {
        realApiEnabled: true,
        hasActivatedProviderRecord: Boolean(activatedRecord),
        hasProviderApiKey: false,
        hasBaseUrl: Boolean(baseUrl),
      },
    };
  }

  if (!baseUrl) {
    return {
      code: 'missing-base-url',
      category: 'routing',
      provider,
      mode: inferredMode,
      message: '当前 provider 没有可用 Base URL，真实上游请求没有发出',
      detail: {
        realApiEnabled: true,
        hasActivatedProviderRecord: Boolean(activatedRecord),
        hasProviderApiKey: true,
        hasBaseUrl: false,
      },
    };
  }

  return null;
}

async function realProxy(provider, body) {
  if (getRealProxyBypassReason(provider, body)) return null;
  const inferredMode = inferMode(body?.endpoint || '');
  const activatedRecord = getActivatedProviderRecord(provider, inferredMode);
  const activatedApiKey = activatedRecord?.apiKey || '';
  const requestApiKey = body.apiKey || activatedApiKey;
  const litellmBaseUrl = String(process.env.HMDAO_LITELLM_BASE_URL || '').trim().replace(/\/$/, '');
  const baseUrl = litellmBaseUrl || normalizeRelayEndpointInput(body.baseUrl || activatedRecord?.endpoint || PROVIDER_BASE_URLS[provider] || '');
  const isApimartAsyncRequest = isApimartAsyncGenerationRequest(baseUrl, body?.endpoint, inferredMode, body, provider);
  const requestedTimeoutMs = Number(body.timeout || 90000);
  const controllerTimeoutMs = isApimartAsyncRequest
    ? Math.max(requestedTimeoutMs + 15000, 120000)
    : requestedTimeoutMs;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), controllerTimeoutMs);
  try {
    const validation = validateGenerationRequest({
      provider,
      endpoint: body.endpoint,
      method: body.method || 'POST',
      body: body.body || {},
    });
    if (!validation.ok) {
      return {
        success: false,
        provider,
        mode: inferMode(body.endpoint),
        error: {
          code: validation.error.code,
          category: 'validation',
          message: validation.error.message,
          provider,
          status: 400,
        },
      };
    }

    const rawRequestBody = body.body && typeof body.body === 'object' ? body.body : {};
    const normalizedBody = normalizeProviderPayload(provider, validation.mode, rawRequestBody);
    const upstreamBody = body.body && typeof body.body === 'object' ? normalizedBody : body.body;
    const providerApiKey = body.apiKey || getActivatedProviderRecord(provider, validation.mode)?.apiKey || '';

    if (provider === 'siliconflow' && validation.mode === 'video') {
      return await executeSiliconflowVideoRequest({
        baseUrl,
        apiKey: providerApiKey,
        payload: normalizeSiliconflowVideoSubmitBody(upstreamBody || {}),
        timeoutMs: Number(body.timeout || 180000),
        signal: controller.signal,
      });
    }

    if (isApimartAsyncRequest) {
      const resolvedRelayModel = resolveActivatedRelayModel(activatedRecord, rawRequestBody?.model || upstreamBody?.model || '');
      const apimartPayload = materializePublicRelayPayload(resolvedRelayModel
        ? {
            ...(upstreamBody && typeof upstreamBody === 'object' ? upstreamBody : {}),
            model: resolvedRelayModel,
          }
        : (upstreamBody || {}));
      const apimartRawPayload = materializePublicRelayPayload(resolvedRelayModel
        ? {
            ...(rawRequestBody && typeof rawRequestBody === 'object' ? rawRequestBody : {}),
            model: resolvedRelayModel,
          }
        : rawRequestBody);
      const requestConstraint = buildApimartAsyncRequestConstraint({
        provider,
        mode: validation.mode,
        rawPayload: apimartRawPayload || {},
        payload: apimartPayload || {},
      });
      if (requestConstraint) {
        return {
          success: false,
          provider,
          mode: validation.mode,
          error: {
            message: requestConstraint.message,
            status: 400,
            provider,
            category: requestConstraint.category,
            code: requestConstraint.code,
          },
          raw: {
            requestConstraint,
            rawPayload: apimartRawPayload,
            payload: apimartPayload,
          },
        };
      }
      return await executeApimartAsyncGenerationRequest({
        provider,
        mode: validation.mode,
        baseUrl,
        endpoint: body.endpoint,
        apiKey: providerApiKey,
        payload: apimartPayload,
        rawPayload: apimartRawPayload,
        timeoutMs: requestedTimeoutMs,
        signal: controller.signal,
      });
    }

    const requestHeaders = {
      'Content-Type': 'application/json',
      Accept: '*/*',
      Authorization: `Bearer ${litellmBaseUrl ? (process.env.HMDAO_LITELLM_API_KEY || providerApiKey) : providerApiKey}`,
      'x-hmdao-provider': provider,
      'x-hmdao-mode': inferMode(body.endpoint),
    };

    if (litellmBaseUrl && providerApiKey) {
      requestHeaders['x-hmdao-provider-key'] = providerApiKey;
    }

    let upstream;
    try {
      upstream = await fetch(`${baseUrl}${body.endpoint}`, {
        method: body.method || 'POST',
        headers: requestHeaders,
        body: JSON.stringify(upstreamBody || {}),
        signal: controller.signal,
      });
    } catch (fetchError) {
      if (!shouldUsePowerShellRelayFallback(baseUrl, fetchError)) throw fetchError;
      const fallback = await executePowerShellRelayRequest({
        url: `${baseUrl}${body.endpoint}`,
        method: body.method || 'POST',
        headers: requestHeaders,
        body: upstreamBody || {},
        timeoutMs: Number(body.timeout || 90000),
      });
      const contentType = fallback.contentType || 'application/json';
      const status = Number(fallback.status || 0);
      if (contentType.includes('application/json') || contentType.includes('text/json')) {
        let data;
        try {
          data = fallback.body ? JSON.parse(fallback.body) : null;
        } catch {
          data = { raw: fallback.body };
        }
        if (!fallback.ok) {
          const message = extractFirstString(data?.error?.message) || extractFirstString(data?.message) || fallback.message || `Upstream request failed with HTTP ${status}.`;
          return {
            success: false,
            provider,
            mode: inferMode(body.endpoint),
            error: {
              message,
              status,
              provider,
              category: classifyProxyError({ status, message }),
              code: extractFirstString(data?.error?.code) || '',
            },
            raw: data,
          };
        }
        return normalizeUpstreamPayload({ provider, mode: inferMode(body.endpoint), data, contentType, status: status || 200 });
      }
      const text = String(fallback.body || '');
      if (!fallback.ok) {
        const message = text || fallback.message || `Upstream request failed with HTTP ${status}.`;
        return {
          success: false,
          provider,
          mode: inferMode(body.endpoint),
          error: {
            message,
            status,
            provider,
            category: classifyProxyError({ status, message }),
          },
        };
      }
      return normalizeUpstreamPayload({
        provider,
        mode: inferMode(body.endpoint),
        data: { content: text },
        contentType,
        status: status || 200,
      });
    }

    const contentType = upstream.headers.get('content-type') || 'application/json';
    const status = upstream.status;

    if (contentType.includes('application/json') || contentType.includes('text/json')) {
      const text = await upstream.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
      if (!upstream.ok) {
        const message = extractFirstString(data?.error?.message) || extractFirstString(data?.message) || `Upstream request failed with HTTP ${status}.`;
        return {
          success: false,
          provider,
          mode: inferMode(body.endpoint),
          error: {
            message,
            status,
            provider,
            category: classifyProxyError({ status, message }),
            code: extractFirstString(data?.error?.code) || '',
          },
          raw: data,
        };
      }
      return normalizeUpstreamPayload({ provider, mode: inferMode(body.endpoint), data, contentType, status });
    }

    if (contentType.startsWith('text/')) {
      const text = await upstream.text();
      if (!upstream.ok) {
        const message = text || `Upstream request failed with HTTP ${status}.`;
        return {
          success: false,
          provider,
          mode: inferMode(body.endpoint),
          error: {
            message,
            status,
            provider,
            category: classifyProxyError({ status, message }),
          },
        };
      }
      return normalizeUpstreamPayload({
        provider,
        mode: inferMode(body.endpoint),
        data: { content: text },
        contentType,
        status,
      });
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (!upstream.ok) {
      return {
        success: false,
        provider,
        mode: inferMode(body.endpoint),
        error: {
          message: `Upstream binary response failed with HTTP ${status}.`,
          status,
          provider,
          category: classifyProxyError({ status, message: `Upstream binary response failed with HTTP ${status}.` }),
        },
      };
    }
    return normalizeUpstreamPayload({
      provider,
      mode: inferMode(body.endpoint),
      data: buffer,
      contentType,
      status,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const category = error?.name === 'AbortError' ? 'timeout' : classifyProxyError({ message });
    return {
      success: false,
      provider,
      mode: inferMode(body.endpoint),
      error: {
        message: error?.name === 'AbortError' ? `Upstream request timed out after ${Number(body.timeout || 90000)}ms.` : message,
        status: 0,
        provider,
        code: error?.name === 'AbortError' ? 'timeout' : 'proxy_error',
        category,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function executeGenerationRequest({ provider, endpoint, method = 'POST', body, timeout, apiKey, baseUrl }) {
  const validation = validateGenerationRequest({ provider, endpoint, method, body: body || {} });
  if (!validation.ok) {
    return {
      success: false,
      provider,
      mode: inferMode(endpoint),
      error: {
        ...validation.error,
        category: 'validation',
        provider,
        status: 400,
      },
    };
  }

  const inferredMode = inferMode(endpoint);
  const operationDispatch = inferredMode === 'image'
    ? await resolveImageOperationDispatch(body || {}, provider, body?.model || '')
    : inferredMode === 'video'
      ? await resolveVideoOperationDispatch(body || {}, provider, body?.model || '')
      : { provider, model: body?.model || '', operation: '', strategy: null, dispatchMode: 'requested' };

  const effectiveProvider = operationDispatch.provider || provider;
  const requestedModel = body && typeof body === 'object' ? extractFirstString(body.model) : '';
  const effectiveRequestModel = operationDispatch.model || requestedModel;
  const effectiveBody = body && typeof body === 'object'
    ? {
        ...body,
        model: effectiveRequestModel,
      }
    : body;

  const requestBody = { endpoint, method, body: effectiveBody, timeout, apiKey, baseUrl };
  const activatedRecord = getActivatedProviderRecord(effectiveProvider, validation.mode);
  if (!requestBody.apiKey) {
    requestBody.apiKey = activatedRecord?.apiKey || '';
  }
  if (activatedRecord?.endpoint) {
    requestBody.baseUrl = activatedRecord.endpoint;
  }

  const upstream = await realProxy(effectiveProvider, requestBody);
  if (upstream) {
    return attachGenerationToolMetadata(upstream, {
      ...generationToolMetadata(body || {}),
      requestedProvider: provider,
      requestedModel,
      dispatchedProvider: effectiveProvider,
      dispatchedModel: effectiveRequestModel,
      dispatchMode: operationDispatch.dispatchMode,
      dispatchTechnique: operationDispatch.strategy?.latestTechnique,
      dispatchGenerationMode: operationDispatch.strategy?.generationMode,
      dispatchReferenceAssets: operationDispatch.strategy?.referenceAssets,
      dispatchSourceConstraint: operationDispatch.strategy?.sourceConstraint,
      dispatchRouteConstraint: operationDispatch.strategy?.routeConstraint,
      dispatchPrimaryVideoProfile: operationDispatch.strategy?.primaryVideoProfile,
    });
  }

  const mode = inferMode(endpoint);
  const proxyBypass = getRealProxyBypassReason(effectiveProvider, requestBody);
  const prompt = effectiveBody?.prompt || effectiveBody?.messages?.map((msg) => msg.content).join('\n') || '';
  const asset = {
    id: crypto.randomUUID(),
    type: mode,
    url: mode === 'image' ? svgDataUrl(prompt, effectiveProvider, mode) : undefined,
    kind: mode === 'video' ? 'procedural-video' : undefined,
    prompt,
    metadata: {
      provider: effectiveProvider,
      model: operationDispatch.model || effectiveBody?.model,
      generatedAt: new Date().toISOString(),
      fallback: true,
      workflowFallback: true,
      workflowFallbackReason: proxyBypass?.message || '真实上游代理未返回结果，已回退到本地占位结果',
      fallbackReason: proxyBypass?.message || '真实上游代理未返回结果，已回退到本地占位结果',
      fallbackCategory: proxyBypass?.category || 'routing',
      fallbackCode: proxyBypass?.code || 'real-proxy-unavailable',
      realProxyDebug: proxyBypass?.detail || null,
      requestedProvider: provider,
      requestedModel,
      dispatchedProvider: effectiveProvider,
      dispatchedModel: effectiveRequestModel,
      dispatchMode: operationDispatch.dispatchMode,
      dispatchTechnique: operationDispatch.strategy?.latestTechnique,
      dispatchGenerationMode: operationDispatch.strategy?.generationMode,
      dispatchReferenceAssets: operationDispatch.strategy?.referenceAssets,
      dispatchSourceConstraint: operationDispatch.strategy?.sourceConstraint,
      dispatchRouteConstraint: operationDispatch.strategy?.routeConstraint,
      dispatchPrimaryVideoProfile: operationDispatch.strategy?.primaryVideoProfile,
      ...generationToolMetadata(body || {}),
    },
  };

  const content = mode === 'llm'
    ? `Generated content: ${prompt || 'No prompt provided.'}`
    : undefined;

  return {
    success: true,
    provider: effectiveProvider,
    mode,
    content,
    asset,
    fallbackReason: proxyBypass?.message || '真实上游代理未返回结果，已回退到本地占位结果',
    fallbackCategory: proxyBypass?.category || 'routing',
    fallbackCode: proxyBypass?.code || 'real-proxy-unavailable',
  };
}

async function previewGenerationRequest({ provider, endpoint, method = 'POST', body, timeout, apiKey, baseUrl }) {
  const validation = validateGenerationRequest({ provider, endpoint, method, body: body || {} });
  if (!validation.ok) {
    return {
      success: false,
      provider,
      mode: inferMode(endpoint),
      error: {
        ...validation.error,
        category: 'validation',
        provider,
        status: 400,
      },
    };
  }

  const inferredMode = inferMode(endpoint);
  const operationDispatch = inferredMode === 'image'
    ? await resolveImageOperationDispatch(body || {}, provider, body?.model || '')
    : inferredMode === 'video'
      ? await resolveVideoOperationDispatch(body || {}, provider, body?.model || '')
      : { provider, model: body?.model || '', operation: '', strategy: null, dispatchMode: 'requested' };

  const effectiveProvider = operationDispatch.provider || provider;
  const requestedModel = body && typeof body === 'object' ? extractFirstString(body.model) : '';
  const effectiveRequestModel = operationDispatch.model || requestedModel;
  const effectiveBody = body && typeof body === 'object'
    ? {
        ...body,
        model: effectiveRequestModel,
      }
    : body;

  const activatedRecord = getActivatedProviderRecord(effectiveProvider, validation.mode);
  const requestBaseUrl = normalizeRelayEndpointInput(
    baseUrl
    || activatedRecord?.endpoint
    || PROVIDER_BASE_URLS[effectiveProvider]
    || '',
  );
  const requestBody = {
    endpoint,
    method,
    body: effectiveBody,
    timeout,
    apiKey: apiKey || activatedRecord?.apiKey || '',
    baseUrl: requestBaseUrl,
  };
  const normalizedBody = normalizeProviderPayload(effectiveProvider, validation.mode, effectiveBody || {});
  const apimartAsyncRequest = isApimartAsyncGenerationRequest(requestBaseUrl, endpoint, validation.mode, effectiveBody, effectiveProvider);
  const resolvedRelayModel = apimartAsyncRequest
    ? resolveActivatedRelayModel(activatedRecord, effectiveBody?.model || normalizedBody?.model || '')
    : '';
  const previewEffectiveBody = materializePublicRelayPayload(resolvedRelayModel
    ? {
        ...(effectiveBody && typeof effectiveBody === 'object' ? effectiveBody : {}),
        model: resolvedRelayModel,
      }
    : effectiveBody);
  const previewNormalizedBody = materializePublicRelayPayload(resolvedRelayModel
    ? normalizeProviderPayload(effectiveProvider, validation.mode, previewEffectiveBody || {})
    : normalizedBody);
  const upstreamBody = apimartAsyncRequest
    ? normalizeApimartAsyncGenerationPayload({
        provider: effectiveProvider,
        mode: validation.mode,
        endpoint,
        rawPayload: previewEffectiveBody || {},
        payload: previewNormalizedBody || {},
      })
    : previewNormalizedBody;
  const requestConstraint = apimartAsyncRequest
    ? buildApimartAsyncRequestConstraint({
        provider: effectiveProvider,
        mode: validation.mode,
        rawPayload: previewEffectiveBody || {},
        payload: upstreamBody || {},
      })
    : null;
  const proxyBypass = requestConstraint || getRealProxyBypassReason(effectiveProvider, requestBody);
  const connectivityProbe = !proxyBypass && requestBaseUrl
    ? await probeRelayConnectivity(requestBaseUrl, Math.min(Math.max(Number(timeout || 8000), 2000), 8000))
    : null;
  const imageRoleEntries = apimartAsyncRequest && validation.mode === 'image'
    ? buildApimartImageRoleEntries(previewEffectiveBody || {}, previewNormalizedBody || {})
    : undefined;
  const orderedImageUrls = Array.isArray(imageRoleEntries)
    ? buildApimartOrderedImageUrls(imageRoleEntries)
    : undefined;

  return compactObject({
    success: true,
    preview: true,
    provider,
    requestedProvider: provider,
    effectiveProvider,
    mode: validation.mode,
    endpoint,
    requestedModel,
    effectiveModel: effectiveRequestModel,
    dispatchMode: operationDispatch.dispatchMode,
    dispatchTechnique: operationDispatch.strategy?.latestTechnique,
    dispatchGenerationMode: operationDispatch.strategy?.generationMode,
    dispatchRouteConstraint: operationDispatch.strategy?.routeConstraint,
    dispatchReferenceAssets: operationDispatch.strategy?.referenceAssets,
    realProxyEnabled: isRealApiProxyEnabled(),
    apimartAsyncRequest,
    requestConstraint,
    proxyBypass,
    connectivityProbe,
    requestBaseUrl: requestBaseUrl || undefined,
    inputBody: previewEffectiveBody,
    normalizedBody: previewNormalizedBody,
    upstreamBody,
    imageRoleEntries,
    orderedImageUrls,
  });
}

function workflowStatusSnapshot(run) {
  const totalNodes = run.nodes.length;
  const nodeResults = run.nodes.map((node) => run.nodeResults.get(node.node_id) || {
    node_id: node.node_id,
    nodeType: node.nodeType,
    provider: node.provider,
    model: node.model,
    prompt: node.prompt,
    status: 'pending',
  });
  const completedNodes = nodeResults.filter((item) => item.status === 'completed').length;
  const failedNodes = nodeResults.filter((item) => item.status === 'failed').length;
  const progress = totalNodes === 0 ? 100 : Math.max(0, Math.min(100, Math.round(((completedNodes + failedNodes) / totalNodes) * 100)));
  return {
    workflow_id: run.workflowId,
    request_id: run.requestId,
    status: run.status,
    name: run.name,
    total_nodes: totalNodes,
    completed_nodes: completedNodes,
    failed_nodes: failedNodes,
    progress,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
    node_results: nodeResults,
    error: run.error || '',
  };
}

function publishWorkflowEvent(run, msgType, extra = {}) {
  const status = workflowStatusSnapshot(run);
  const payload = { ...status, ...extra };
  for (const socket of run.subscribers) {
    sendWs(socket, {
      msg_id: nextMessageId(),
      msg_type: msgType,
      payload,
      ts: Date.now(),
    });
  }
}

function broadcastCatalogUpdate(reason = 'catalog-updated') {
  const payload = {
    reason,
    updated_at: Date.now(),
    models: modelCatalogPayload(),
  };
  for (const socket of catalogSocketSubscriptions.values()) {
    sendWs(socket, {
      msg_id: nextMessageId(),
      msg_type: 'catalog:updated',
      payload,
      ts: Date.now(),
    });
  }
}

async function executeWorkflowRun(run) {
  run.status = 'running';
  run.updatedAt = Date.now();
  publishWorkflowEvent(run, 'workflow:started');

  const completed = new Set();
  const cancelled = () => run.status === 'cancelled';
  const pending = new Map(run.nodes.map((node) => [node.node_id, node]));

  while (pending.size > 0) {
    if (cancelled()) {
      run.updatedAt = Date.now();
      publishWorkflowEvent(run, 'workflow:cancelled');
      return;
    }

    const ready = Array.from(pending.values()).filter((node) =>
      (node.depends_on || []).every((dep) => completed.has(dep)),
    );

    if (!ready.length) {
      run.status = 'failed';
      run.error = 'Workflow dependency cycle or missing dependency prevented execution.';
      run.updatedAt = Date.now();
      publishWorkflowEvent(run, 'workflow:failed');
      return;
    }

    for (const node of ready) {
      pending.delete(node.node_id);
      const startedAt = Date.now();
      const nodeBase = {
        node_id: node.node_id,
        nodeType: node.nodeType,
        provider: node.provider,
        model: node.model,
        prompt: node.prompt,
      };

      run.nodeResults.set(node.node_id, {
        ...nodeBase,
        status: 'running',
        metadata: {
          ...(node.metadata || {}),
          startedAt,
          stage: 'running',
          progress: 10,
        },
      });
      run.updatedAt = Date.now();
      publishWorkflowEvent(run, 'node:started', {
        node_id: node.node_id,
        nodeType: node.nodeType,
        stage: 'running',
        progress: 10,
        message: `Node ${node.node_id} started generation request.`,
      });

      try {
        const result = await executeGenerationRequest({
          provider: node.provider,
          endpoint: node.endpoint,
          method: 'POST',
          body: node.body,
          timeout: node.timeout || 90_000,
          apiKey: node.apiKey || '',
        });

        if (!result.success) {
          throw new Error(result.error?.message || 'Node execution failed. Check the current node configuration or upstream input.');
        }

        run.nodeResults.set(node.node_id, {
          ...nodeBase,
          status: 'completed',
          content: result.content,
          asset: result.asset,
          metadata: {
            ...(node.metadata || {}),
            completedAt: Date.now(),
            durationMs: Date.now() - startedAt,
            stage: 'completed',
            progress: 100,
          },
        });
        completed.add(node.node_id);
        run.updatedAt = Date.now();
        publishWorkflowEvent(run, 'node:completed', {
          node_id: node.node_id,
          nodeType: node.nodeType,
          stage: 'completed',
          progress: Math.max(1, Math.round((completed.size / run.nodes.length) * 100)),
          duration_ms: Date.now() - startedAt,
          message: `Node ${node.node_id} completed generation request.`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        run.nodeResults.set(node.node_id, {
          ...nodeBase,
          status: 'failed',
          error: { message },
          metadata: {
            ...(node.metadata || {}),
            failedAt: Date.now(),
            durationMs: Date.now() - startedAt,
            stage: 'failed',
          },
        });
        run.status = 'failed';
        run.error = message;
        run.updatedAt = Date.now();
        publishWorkflowEvent(run, 'node:failed', {
          node_id: node.node_id,
          nodeType: node.nodeType,
          error: message,
          stage: 'failed',
          progress: Math.max(1, Math.round((completed.size / run.nodes.length) * 100)),
          duration_ms: Date.now() - startedAt,
          message,
        });
        publishWorkflowEvent(run, 'workflow:failed');
        return;
      }
    }
  }

  run.status = 'completed';
  run.updatedAt = Date.now();
  publishWorkflowEvent(run, 'workflow:completed');
}

async function route(req, res) {
  // 存储请求 Origin 用于 CORS 动态回写，避免 credentials:'include' 与通配符 * 冲突
  res._hmdaoOrigin = req.headers.origin || '';
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      const ocioBackend = resolveLocalPostOcioBackend({ ocioExecutionMode: 'auto' });
      const oiioBackend = resolveLocalPostOiioBackend({ ocioExecutionMode: 'auto' }, 'image', '');
      const gmicBackend = resolveLocalPostGmicBackend();
      const fsrBackend = resolveLocalPostUpscaleBackend({ routePolicy: 'fsr-preview', executionMode: 'auto' }, 'image');
      const realbasicvsrBackend = resolveLocalPostUpscaleBackend({ routePolicy: 'realbasicvsr', executionMode: 'auto' }, 'video');
      const supirBackend = resolveLocalPostUpscaleBackend({ routePolicy: 'supir', executionMode: 'auto' }, 'image');
      return send(res, 200, {
        success: true,
        service: 'hmdao-api',
        time: new Date().toISOString(),
        realApiEnabled: isRealApiProxyEnabled(),
        realApiDiagnostics: {
          enabled: isRealApiProxyEnabled(),
          source: process.env.HMDAO_REAL_API === '1' ? 'env' : 'activated-provider',
          apiPort: PORT,
          litellmBaseUrlConfigured: Boolean(String(process.env.HMDAO_LITELLM_BASE_URL || '').trim()),
          litellmApiKeyConfigured: Boolean(String(process.env.HMDAO_LITELLM_API_KEY || '').trim()),
        },
        capabilities: {
          dccGateway: true,
          dccStatusPath: '/api/dcc/status',
          dccWsPath: '/ws/dcc-capture',
          unrealDccWsPath: '/ws/dcc/unreal',
          workflowGateway: true,
          workflowWsPath: '/ws/workflow',
          catalogWsPath: '/ws/catalog',
          localPostBackends: {
            ocio: buildLocalPostBackendStatus('ocio', ocioBackend, path.resolve(APP_DIR, 'server', 'local_post_example_ocio.py')),
            oiio: buildLocalPostBackendStatus('oiio', oiioBackend, 'oiiotool.exe'),
            gmic: buildLocalPostBackendStatus('gmic', gmicBackend, 'gmic.exe'),
            upscale: {
              'fsr-preview': buildLocalPostBackendStatus('fsr-preview', fsrBackend, path.resolve(APP_DIR, 'server', 'local_post_example_fsr.py')),
              realbasicvsr: buildLocalPostBackendStatus('realbasicvsr', realbasicvsrBackend, path.resolve(APP_DIR, 'server', 'local_post_example_realbasicvsr.py')),
              supir: buildLocalPostBackendStatus('supir', supirBackend, path.resolve(APP_DIR, 'server', 'local_post_example_supir.py')),
            },
          },
        },
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/health/local-post/refresh') {
      clearLocalPostRuntimeDetectionCache();
      const ocioBackend = resolveLocalPostOcioBackend({ ocioExecutionMode: 'auto' });
      const oiioBackend = resolveLocalPostOiioBackend({ ocioExecutionMode: 'auto' }, 'image', '');
      const gmicBackend = resolveLocalPostGmicBackend();
      const fsrBackend = resolveLocalPostUpscaleBackend({ routePolicy: 'fsr-preview', executionMode: 'auto' }, 'image');
      const realbasicvsrBackend = resolveLocalPostUpscaleBackend({ routePolicy: 'realbasicvsr', executionMode: 'auto' }, 'video');
      const supirBackend = resolveLocalPostUpscaleBackend({ routePolicy: 'supir', executionMode: 'auto' }, 'image');
      return send(res, 200, {
        success: true,
        refreshedAt: new Date().toISOString(),
        capabilities: {
          localPostBackends: {
            ocio: buildLocalPostBackendStatus('ocio', ocioBackend, path.resolve(APP_DIR, 'server', 'local_post_example_ocio.py')),
            oiio: buildLocalPostBackendStatus('oiio', oiioBackend, 'oiiotool.exe'),
            gmic: buildLocalPostBackendStatus('gmic', gmicBackend, 'gmic.exe'),
            upscale: {
              'fsr-preview': buildLocalPostBackendStatus('fsr-preview', fsrBackend, path.resolve(APP_DIR, 'server', 'local_post_example_fsr.py')),
              realbasicvsr: buildLocalPostBackendStatus('realbasicvsr', realbasicvsrBackend, path.resolve(APP_DIR, 'server', 'local_post_example_realbasicvsr.py')),
              supir: buildLocalPostBackendStatus('supir', supirBackend, path.resolve(APP_DIR, 'server', 'local_post_example_supir.py')),
            },
          },
        },
      });
    }

    if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/health/local-post/doctor') {
      let body = {};
      if (req.method === 'POST') {
        body = await readJson(req).catch(() => ({}));
      }
      const forceRelease = url.searchParams.get('force') === '1' || body?.forceRelease === true;
      const report = await buildLocalPostDoctorReport({ forceRelease });
      return send(res, 200, {
        success: true,
        ...report,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/health/local-post/runtime/install-jobs') {
      const runtimeKey = String(url.searchParams.get('runtimeKey') || '').trim();
      const jobs = Array.from(LOCAL_POST_RUNTIME_INSTALL_JOBS.values())
        .filter((job) => !runtimeKey || job.runtimeKey === runtimeKey)
        .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))
        .map((job) => toRuntimeInstallJobResponse(job));
      return send(res, 200, {
        success: true,
        jobs,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/health/local-post/runtime/install') {
      const body = await readJson(req).catch(() => ({}));
      const runtimeKey = String(body?.runtimeKey || '').trim();
      if (!LOCAL_POST_INSTALLABLE_RUNTIMES[runtimeKey]) {
        return send(res, 400, {
          success: false,
          error: { message: `unsupported-runtime:${runtimeKey || 'unknown'}` },
        });
      }
      const job = await startRuntimeInstallJob(runtimeKey, {
        requestedAction: String(body?.requestedAction || 'install').trim() || 'install',
      });
      return send(res, 200, {
        success: true,
        job: toRuntimeInstallJobResponse(job),
      });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/health/local-post/runtime/install/')) {
      const jobId = decodeURIComponent(url.pathname.slice('/api/health/local-post/runtime/install/'.length));
      const job = getRuntimeInstallJob(jobId);
      if (!job) {
        return send(res, 404, {
          success: false,
          error: { message: 'runtime-install-job-not-found' },
        });
      }
      return send(res, 200, {
        success: true,
        job: toRuntimeInstallJobResponse(job),
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/dcc/status') {
      const probeEngine = url.searchParams.get('engine') === 'blender'
        ? 'blender'
        : url.searchParams.get('engine') === 'unreal'
          ? 'unreal'
          : '';
      const pluginStatus = await DCC_ENVIRONMENT_MANAGER.getStatus({
        force: url.searchParams.get('force') === '1',
        probeEngine,
      });
      const engines = {};
      for (const [id, config] of Object.entries(DCC_ENGINES)) {
        const isUnreal = id === 'unreal';
        const pluginEngine = pluginStatus?.engines?.[id] || null;
        const currentEnvironmentSummary = isUnreal
          ? summarizeCurrentUnrealEnvironment(pluginEngine)
          : pluginEngine
            ? {
              level: pluginEngine.level,
              summary: pluginEngine.summary,
              recommendedAction: pluginEngine.recommendedAction,
              adapter: pluginEngine.adapter || null,
            }
            : null;
        engines[id] = {
          ...config,
          reachable: isUnreal
            ? Boolean(pluginEngine?.plugin?.directBridgeReadyForTargetProject)
            : pluginEngine
              ? Boolean(pluginEngine?.plugin?.serviceReachable || pluginEngine?.plugin?.readyForLiveCapture)
              : await probeTcp(config.port),
          gateway: true,
          requiredPlugin: !isUnreal,
          integration: isUnreal
            ? (pluginEngine?.integration?.activeMode || pluginEngine?.integration?.recommendedMode || 'editor-direct')
            : 'websocket',
          previewProvider: isUnreal
            ? (pluginEngine?.integration?.previewProvider || 'editor-direct')
            : 'websocket',
          wsPath: isUnreal ? '/ws/dcc/unreal' : '/ws/dcc-capture',
          directBridgeOnline: isUnreal
            ? Boolean(pluginEngine?.host?.targetProjectRunning) && Boolean(pluginEngine?.plugin?.directBridgeOnline ?? isUnrealDirectBridgeOnline())
            : undefined,
          directBridgeClientCount: isUnreal
            ? Boolean(pluginEngine?.host?.targetProjectRunning)
              ? Number(pluginEngine?.plugin?.directBridgeClientCount ?? UNREAL_DIRECT_BRIDGE.browsers.size)
              : 0
            : undefined,
          pluginInstalled: isUnreal ? Boolean(pluginEngine?.plugin?.installed) : undefined,
          pluginEnabledInProject: isUnreal ? Boolean(pluginEngine?.plugin?.enabledInProject) : undefined,
          hostProcessRunning: isUnreal ? Boolean(pluginEngine?.host?.hostProcessRunning) : undefined,
          targetProjectRunning: isUnreal ? Boolean(pluginEngine?.host?.targetProjectRunning) : undefined,
          directBridgeReadyForTargetProject: isUnreal ? Boolean(pluginEngine?.plugin?.directBridgeReadyForTargetProject) : undefined,
          cameraCount: isUnreal
            ? (Boolean(pluginEngine?.host?.targetProjectRunning) ? Number(pluginEngine?.plugin?.cameraCount || 0) : 0)
            : undefined,
          projectPath: isUnreal ? (pluginEngine?.project?.path || null) : undefined,
          directBridgePlugin: isUnreal && Boolean(pluginEngine?.host?.targetProjectRunning) ? UNREAL_DIRECT_BRIDGE.pluginInfo : undefined,
          pixelStreamingUrl: isUnreal && ENABLE_UNREAL_PIXEL_STREAMING_LEGACY ? DEFAULT_UNREAL_PIXEL_URL : undefined,
          remoteControlUrl: isUnreal ? DEFAULT_UNREAL_REMOTE_URL : undefined,
          installPath: id === 'blender'
            ? 'plugins/blender/hmdao_blender_capture'
            : pluginEngine?.plugin?.effectivePath || 'plugins/unreal/HMDaoUnrealCapture',
          environmentManager: currentEnvironmentSummary,
          runtimeState: pluginEngine?.runtimeState || currentEnvironmentSummary?.runtimeState || null,
          official: isUnreal ? pluginEngine?.official || null : undefined,
          guidance: isUnreal ? pluginEngine?.guidance || null : undefined,
          compatibility: isUnreal ? pluginEngine?.compatibility || null : undefined,
        };
      }
      return send(res, 200, {
        success: true,
        service: 'hmdao-dcc-gateway',
        wsPath: '/ws/dcc-capture',
        environmentManagerPath: '/api/dcc/environment/status',
        environmentManagerActionPath: '/api/dcc/environment/action',
        environmentManagerJobsPath: '/api/dcc/environment/jobs',
        environmentManagerLogsPath: '/api/dcc/environment/logs',
        pluginManagerPath: '/api/dcc/plugins/status',
        pluginManagerActionPath: '/api/dcc/plugins/action',
        mockFallback: true,
        features: {
          blenderWebSocketGateway: true,
          unrealEditorDirectAdapter: true,
          unrealPixelStreamingLegacyAdapter: ENABLE_UNREAL_PIXEL_STREAMING_LEGACY,
          unrealRemoteControlAdapter: true,
        },
        recordingLockedBy: DCC_RECORDING_LOCK.engine,
        engines,
      });
    }

    if (req.method === 'GET' && (url.pathname === '/api/dcc/environment/status' || url.pathname === '/api/dcc/plugins/status')) {
      const probeEngine = url.searchParams.get('engine') === 'blender'
        ? 'blender'
        : url.searchParams.get('engine') === 'unreal'
          ? 'unreal'
          : '';
      const status = await DCC_ENVIRONMENT_MANAGER.getStatus({
        force: url.searchParams.get('force') === '1',
        probeEngine,
      });
      return send(res, 200, status);
    }

    if (req.method === 'GET' && url.pathname === '/api/dcc/environment/jobs') {
      const jobs = await DCC_ENVIRONMENT_MANAGER.listJobs({
        engine: url.searchParams.get('engine') || '',
        status: url.searchParams.get('status') || '',
        limit: url.searchParams.get('limit') || '',
      });
      return send(res, 200, { success: true, jobs });
    }

    if (req.method === 'GET' && url.pathname === '/api/dcc/environment/logs') {
      const logs = await DCC_ENVIRONMENT_MANAGER.listLogs({
        engine: url.searchParams.get('engine') || '',
        jobId: url.searchParams.get('jobId') || '',
        level: url.searchParams.get('level') || '',
        limit: url.searchParams.get('limit') || '',
      });
      return send(res, 200, { success: true, logs });
    }

    if (req.method === 'POST' && (url.pathname === '/api/dcc/environment/action' || url.pathname === '/api/dcc/plugins/action')) {
      const payload = await readJson(req);
      try {
        const result = await DCC_ENVIRONMENT_MANAGER.runAction(payload);
        return send(res, 200, result);
      } catch (error) {
        return send(res, 400, {
          success: false,
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }

    if (
      (req.method === 'POST' && url.pathname === '/api/dcc/unreal/pixel-streaming/start')
      || (req.method === 'GET' && (url.pathname.startsWith('/api/dcc/unreal/pixel-proxy') || url.pathname === '/api/dcc/unreal/status'))
    ) {
      if (!ENABLE_UNREAL_PIXEL_STREAMING_LEGACY) {
        return send(res, 404, { success: false, error: { message: 'Unreal Pixel Streaming legacy path is disabled by default.' } });
      }
      if (await UNREAL_PIXEL_STREAMING_LEGACY.handle(req, res, url)) return;
    }

    if (req.method === 'GET' && url.pathname === '/api/dcc/unreal/config') {
      const controlConfig = await getUnrealControlConfig();
      return send(res, 200, { success: true, ...controlConfig });
    }

    if (req.method === 'POST' && url.pathname === '/api/dcc/unreal/config') {
      const body = await readJson(req);
      const current = await readUnrealConfig();
      const next = {
        ...current,
        controlObjectPath: String(body.controlObjectPath || body.objectPath || '').trim(),
        cameraFunction: String(body.cameraFunction || body.functionName || 'SetHMDaoCamera').trim() || 'SetHMDaoCamera',
        signalUrl: String(body.signalUrl || current.signalUrl || process.env.HMDAO_UNREAL_SIGNAL_URL || 'ws://127.0.0.1:8888').trim(),
      };
      await writeUnrealConfig(next);
      const controlConfig = await getUnrealControlConfig();
      return send(res, 200, { success: true, ...controlConfig });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/register') {
      const { email, password } = await readJson(req);
      const normalized = normalizeLocalEmail(email);
      if (!normalized || !isValidLocalEmail(normalized)) {
        return sendAuthError(res, 400, 'invalid_email', '请输入有效的邮箱地址');
      }
      if (!password || String(password).length < 8) {
        return sendAuthError(res, 400, 'weak_password', '密码至少需 8 个字符');
      }
      const users = await readUsers();
      if (users.some((user) => user.email === normalized)) {
        return sendAuthError(res, 409, 'user_already_exists', '该邮箱已注册，请直接登录或重置密码');
      }
      const passwordData = hashPassword(String(password));
      const user = {
        id: crypto.randomUUID(),
        email: normalized,
        salt: passwordData.salt,
        passwordHash: passwordData.hash,
        createdAt: new Date().toISOString(),
      };
      users.push(user);
      await writeUsers(users);
      return send(res, 200, { success: true, user: publicUser(user) });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const { email, password } = await readJson(req);
      const users = await readUsers();
      const user = users.find((item) => item.email === normalizeLocalEmail(email));
      if (!user) {
        return sendAuthError(res, 404, 'user_not_found', '该邮箱尚未注册，请先创建账号');
      }
      if (!verifyPassword(String(password || ''), user)) {
        return sendAuthError(res, 401, 'invalid_credentials', '密码错误，请重试或重置密码');
      }
      return send(res, 200, { success: true, user: publicUser(user), session: createSession(user) });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/reset-password') {
      const { email, password } = await readJson(req);
      const normalized = normalizeLocalEmail(email);
      if (!normalized || !isValidLocalEmail(normalized)) {
        return sendAuthError(res, 400, 'invalid_email', '请输入有效的邮箱地址');
      }
      if (!password || String(password).length < 8) {
        return sendAuthError(res, 400, 'weak_password', '密码至少需 8 个字符');
      }
      const users = await readUsers();
      const userIndex = users.findIndex((item) => item.email === normalized);
      if (userIndex < 0) {
        return sendAuthError(res, 404, 'user_not_found', '该邮箱尚未注册，请先创建账号');
      }
      const passwordData = hashPassword(String(password));
      users[userIndex] = {
        ...users[userIndex],
        salt: passwordData.salt,
        passwordHash: passwordData.hash,
        updatedAt: new Date().toISOString(),
      };
      await writeUsers(users);
      deleteSessionsForUser(users[userIndex].id);
      return send(res, 200, {
        success: true,
        message: '密码已更新，请使用新密码登录',
        user: publicUser(users[userIndex]),
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/refresh') {
      const { refresh_token: refreshToken } = await readJson(req);
      const session = sessions.get(refreshToken);
      if (!session || Date.now() > session.expiresAt) {
        return send(res, 401, { success: false, error: { message: 'Session expired.' } });
      }
      const users = await readUsers();
      const user = users.find((item) => item.id === session.userId);
      if (!user) return send(res, 404, { success: false, error: { message: 'User not found.' } });
      return send(res, 200, { success: true, session: createSession(user) });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      const { refresh_token: refreshToken } = await readJson(req);
      if (refreshToken) sessions.delete(refreshToken);
      return send(res, 200, { success: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/byok/providers') {
      return send(res, 200, { success: true, providers });
    }

    if (req.method === 'GET' && url.pathname === '/api/byok/runtime') {
      return send(res, 200, {
        success: true,
        activatedProviders: listActivatedProviderRecords()
          .map((record) => publicActivatedProviderRecord(record))
          .filter(Boolean),
        selectedImageAnalysisRemote: publicImageAnalysisRuntime(pickActivatedCloudImageAnalysisRuntime()),
        recommendations: buildRuntimeRecommendations(),
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/models/catalog') {
      const mode = String(url.searchParams.get('mode') || '').trim();
      const nodeType = String(url.searchParams.get('nodeType') || '').trim();
      return send(res, 200, {
        success: true,
        updatedAt: new Date().toISOString(),
        models: modelCatalogPayload({
          mode: mode || undefined,
          nodeType: nodeType || undefined,
        }),
      });
    }

    // 轻量模型清单：供前端 checkPresetUpdates 比对版本（当前返回空清单，
    // 以本地声明版本为准，避免 404 噪声）。
    if (req.method === 'GET' && url.pathname === '/api/models/manifest') {
      return send(res, 200, {});
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/media-proxy') {
      const mediaUrl = String(url.searchParams.get('url') || '').trim();
      const kind = String(url.searchParams.get('kind') || '').trim().toLowerCase();
      return proxyRemoteMediaAsset(req, res, mediaUrl, kind);
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/api/transformers/')) {
      return serveTransformersModule(req, res, url);
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/api/hf-proxy/')) {
      return proxyHuggingFace(req, res, url);
    }

    if (req.method === 'GET' && url.pathname === '/api/settings/dispatch') {
      const config = await loadOperationDispatchConfig({ force: true });
      return send(res, 200, {
        success: true,
        path: OPERATION_DISPATCH_CONFIG_FILE,
        config,
      });
    }

    if (req.method === 'PUT' && url.pathname === '/api/settings/dispatch') {
      const body = await readJson(req);
      const nextConfig = body?.config && typeof body.config === 'object' ? body.config : body;
      if (!nextConfig || typeof nextConfig !== 'object' || Array.isArray(nextConfig)) {
        return send(res, 400, { success: false, error: { message: 'Dispatch config must be an object.' } });
      }
      const config = await saveOperationDispatchConfig(nextConfig);
      return send(res, 200, {
        success: true,
        path: OPERATION_DISPATCH_CONFIG_FILE,
        config,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/settings/assets') {
      const settings = await readAssetLibrarySettings();
      return send(res, 200, {
        success: true,
        path: ASSET_LIBRARY_SETTINGS_FILE,
        catalogPath: ASSET_LIBRARY_CATALOG_FILE,
        storagePath: settings.storagePath,
        defaultStoragePath: DEFAULT_ASSET_LIBRARY_STORAGE_DIR,
      });
    }

    if (req.method === 'PUT' && url.pathname === '/api/settings/assets') {
      const body = await readJson(req);
      const storagePath = String(body?.storagePath || '').trim();
      if (!storagePath) {
        return send(res, 400, { success: false, error: { message: 'Asset library storage path is required.' } });
      }
      const settings = await writeAssetLibrarySettings(storagePath);
      return send(res, 200, {
        success: true,
        path: ASSET_LIBRARY_SETTINGS_FILE,
        catalogPath: ASSET_LIBRARY_CATALOG_FILE,
        storagePath: settings.storagePath,
        defaultStoragePath: DEFAULT_ASSET_LIBRARY_STORAGE_DIR,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/settings/assets/pick-directory') {
      const body = await readJson(req);
      const settings = await readAssetLibrarySettings();
      const picked = await pickLocalDirectory(
        String(body?.initialPath || settings.storagePath || DEFAULT_ASSET_LIBRARY_STORAGE_DIR),
        String(body?.autoSelectPath || ''),
      );
      return send(res, 200, {
        success: true,
        canceled: picked.canceled,
        path: picked.path,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/assets/library') {
      const items = await readAssetLibraryCatalog();
      return send(res, 200, {
        success: true,
        items,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/assets/duplicates') {
      const items = await readAssetLibraryCatalog();
      const groups = buildAssetLibraryDuplicateGroups(items);
      const duplicateIds = groups.flatMap((group) => group.duplicateIds);
      // 持久化：把本次计算结果写入缓存文件，供「去重看板常驻视图」直接读取，
      // 避免每次打开都重算，也使结果在多次会话间稳定可见。
      await writeAssetLibraryDuplicates(groups).catch(() => undefined);
      return send(res, 200, {
        success: true,
        groups,
        duplicateIds,
        total: duplicateIds.length,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/assets/duplicates/persisted') {
      const groups = await readAssetLibraryDuplicates().catch(() => []);
      const duplicateIds = groups.flatMap((group) => group.duplicateIds);
      return send(res, 200, {
        success: true,
        groups,
        duplicateIds,
        total: duplicateIds.length,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/assets/delete') {
      const body = await readJson(req);
      const assetIds = Array.isArray(body?.assetIds) ? body.assetIds : [];
      const deletedIds = await deleteAssetLibraryItems(assetIds);
      return send(res, 200, {
        success: true,
        deletedIds,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/assets/restore') {
      const body = await readJson(req);
      const inputItems = Array.isArray(body?.items) ? body.items : [];
      const restoredIds = await restoreAssetLibraryItems(inputItems);
      return send(res, 200, {
        success: true,
        restoredIds,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/assets/validate') {
      const body = await readJson(req);
      const assetId = String(body?.assetId || '').trim();
      const item = await findAssetLibraryItem(assetId);
      if (!item) return send(res, 404, { success: false, error: { message: 'asset-not-found' } });
      if (String(item.storageLabel || '').trim().toLowerCase() === 'reference') {
        return send(res, 200, { success: true, state: 'reference', canTranscode: false, type: item.type });
      }
      const probe = await probeAssetMedia(item.filePath);
      return send(res, 200, {
        success: true,
        state: probe.state,
        canTranscode: probe.canTranscode,
        detail: probe.detail,
        type: item.type,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/assets/repair') {
      const body = await readJson(req);
      const assetId = String(body?.assetId || '').trim();
      const items = await readAssetLibraryCatalog();
      const item = items.find((entry) => String(entry.id || '') === assetId || String(entry.backendAssetId || '') === assetId);
      if (!item) return send(res, 404, { success: false, error: { message: 'asset-not-found' } });
      if (String(item.storageLabel || '').trim().toLowerCase() === 'reference') {
        return send(res, 400, { success: false, error: { message: 'reference-cannot-repair' } });
      }
      const repaired = await repairAssetLibraryItem(item);
      const updatedItems = items.map((entry) => {
        if (String(entry.id || '') === assetId || String(entry.backendAssetId || '') === assetId) {
          return {
            ...entry,
            filePath: repaired.filePath,
            size: repaired.size,
            contentHash: repaired.contentHash,
            updatedAt: Date.now(),
          };
        }
        return entry;
      });
      await writeAssetLibraryCatalog(updatedItems);
      return send(res, 200, {
        success: true,
        url: buildAssetLibraryContentUrl(assetId),
        size: repaired.size,
        contentHash: repaired.contentHash,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/assets/import') {
      const contentType = String(req.headers['content-type'] || '').toLowerCase();
      const body = contentType.includes('multipart/form-data')
        ? await readAssetLibraryImportMultipart(req)
        : await readJson(req);
      const result = await processAssetLibraryImportRequest(body);
      return send(res, 200, {
        success: true,
        item: result.item,
        storagePath: result.storagePath,
        duplicate: Boolean(result.duplicate),
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/assets/import-directory') {
      const body = await readJson(req);
      const result = await processAssetLibraryImportDirectory(body);
      return send(res, 200, {
        success: true,
        canceled: result.canceled,
        path: result.path,
        items: result.items,
        report: result.report,
      });
    }

    // ===== 免费图片搜索代理 =====
    if (req.method === 'POST' && url.pathname === '/api/search/free-images') {
      const body = await readJson(req).catch(() => ({}));
      const query = String(body?.query || '').trim();
      const platform = String(body?.platform || 'unsplash').trim();
      const page = Math.max(1, parseInt(String(body?.page || '1'), 10) || 1);
      const perPage = Math.min(50, Math.max(1, parseInt(String(body?.perPage || '24'), 10) || 24));
      const mediaType = String(body?.type || 'image').trim() === 'video' ? 'video' : 'image';


      if (!query) {
        return send(res, 400, { success: false, error: { message: 'query is required' } });
      }

      try {
        let results = [];
        let total = 0;

        switch (platform) {
          case 'unsplash': {
            const params = new URLSearchParams({
              query,
              page: String(page),
              per_page: String(perPage),
              order_by: 'relevant',
            });
            const apiResp = await fetch(`${UNSPLASH_BASE}/search/photos?${params}`, {
              headers: { 'Accept-Version': 'v1' },
            });
            const data = await apiResp.json();
            results = (data.results || []).map((item, i) => ({
              id: `unsplash-${item.id}`,
              url: item.urls?.regular || item.urls?.full || '',
              thumb: item.urls?.thumb || '',
              title: item.description || item.alt_description || `Unsplash ${i + 1}`,
              source: 'unsplash',
              sourceName: 'Unsplash',
              type: 'image',
              width: item.width,
              height: item.height,
              author: item.user?.name || '',
              tags: (item.tags || []).map((t) => t.title),
              uploadDate: item.created_at,
            }));
            total = data.total || results.length;
            break;
          }

          case 'pexels': {
            const pexelsKey = process.env.VITE_PEXELS_API_KEY || '';
            if (!pexelsKey) {
              return send(res, 200, { results: [], total: 0, notice: 'pexels requires API key' });
            }
            if (mediaType === 'video') {
              const params = new URLSearchParams({
                query,
                page: String(page),
                per_page: String(perPage),
              });
              const apiResp = await fetch(`${PEXELS_BASE}/videos/search?${params}`, {
                headers: { Authorization: pexelsKey },
              });
              const data = await apiResp.json();
              results = (data.videos || []).map((item, i) => {
                const file = [...(item.video_files || [])].sort((a, b) => (b.width || 0) - (a.width || 0))[0] || {};
                return {
                  id: `pexels-v-${item.id}`,
                  url: file.link || '',
                  thumb: item.image || '',
                  title: item.user?.name ? `视频 by ${item.user.name}` : `Pexels ${i + 1}`,
                  source: 'pexels',
                  sourceName: 'Pexels',
                  type: 'video',
                  width: file.width,
                  height: file.height,
                  author: item.user?.name || '',
                  tags: [],
                };
              });
              total = data.total_results || results.length;
              break;
            }
            const params = new URLSearchParams({
              query,
              page: String(page),
              per_page: String(perPage),
            });
            const apiResp = await fetch(`${PEXELS_BASE}/v1/search?${params}`, {
              headers: { Authorization: pexelsKey },
            });
            const data = await apiResp.json();
            results = (data.photos || []).map((item, i) => ({
              id: `pexels-${item.id}`,
              url: item.src?.original || item.src?.large || '',
              thumb: item.src?.small || '',
              title: item.alt || `Pexels ${i + 1}`,
              source: 'pexels',
              sourceName: 'Pexels',
              type: 'image',
              width: item.width,
              height: item.height,
              author: item.photographer || '',
              tags: [],
            }));
            total = data.total_results || results.length;
            break;
          }

          case 'pixabay': {
            const pixabayKey = process.env.VITE_PIXABAY_API_KEY || '';
            if (!pixabayKey) {
              return send(res, 200, { results: [], total: 0, notice: 'pixabay requires API key' });
            }
            if (mediaType === 'video') {
              const params = new URLSearchParams({
                key: pixabayKey,
                q: query,
                page: String(page),
                per_page: String(perPage),
                video: 'true',
                safesearch: 'true',
              });
              const apiResp = await fetch(`${PIXABAY_BASE}/?${params}`);
              const data = await apiResp.json();
              results = (data.hits || []).map((item) => {
                const vid = [...(item.videos || [])].sort((a, b) => (b.width || 0) - (a.width || 0))[0] || {};
                return {
                  id: `pixabay-v-${item.id}`,
                  url: vid.url || '',
                  thumb: item.previewURL || '',
                  title: item.tags?.split(',')[0]?.trim() || `Pixabay ${item.id}`,
                  source: 'pixabay',
                  sourceName: 'Pixabay',
                  type: 'video',
                  width: vid.width,
                  height: vid.height,
                  author: item.user || '',
                  tags: (item.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
                };
              });
              total = data.total || results.length;
              break;
            }
            const params = new URLSearchParams({
              key: pixabayKey,
              q: query,
              page: String(page),
              per_page: String(perPage),
              image_type: 'photo',
              safesearch: 'true',
            });
            const apiResp = await fetch(`${PIXABAY_BASE}/?${params}`);
            const data = await apiResp.json();
            results = (data.hits || []).map((item) => ({
              id: `pixabay-${item.id}`,
              url: item.largeImageURL || item.webformatURL || '',
              thumb: item.previewURL || '',
              title: item.tags?.split(',')[0]?.trim() || `Pixabay ${item.id}`,
              source: 'pixabay',
              sourceName: 'Pixabay',
              type: 'image',
              width: item.imageWidth,
              height: item.imageHeight,
              author: item.user || '',
              tags: (item.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
            }));
            total = data.total || results.length;
            break;
          }

          case 'openverse': {
            const params = new URLSearchParams({
              q: query,
              page: String(page),
              page_size: String(Math.min(perPage, 50)),
              license: 'cc0,pdm,by',
              source: 'flickr,wikimedia,stocksnap,pexels,thingiverse',
            });
            const apiResp = await fetch(`${OPENVERSE_BASE}/images/?${params}`, {
              headers: { Accept: 'application/json' },
            });
            if (!apiResp.ok) return send(res, 200, { results: [], total: 0, notice: 'openverse unavailable' });
            const data = await apiResp.json();
            results = (data.results || []).map((item, i) => ({
              id: `openverse-${item.id}`,
              url: item.url || '',
              thumb: item.thumbnail || item.url || '',
              title: item.title || `Openverse ${i + 1}`,
              source: 'openverse',
              sourceName: 'Openverse',
              type: 'image',
              width: item.width,
              height: item.height,
              author: item.creator || '',
              license: item.license || 'CC0',
              tags: (item.tags || []).map((t) => t.name).filter(Boolean),
              uploadDate: item.created_on,
            }));
            total = data.result_count || results.length;
            break;
          }

          case 'wikimedia': {
            const params = new URLSearchParams({
              action: 'query',
              generator: 'search',
              gsrsearch: query,
              gsrnamespace: '6',
              gsrlimit: String(Math.min(perPage, 50)),
              prop: 'imageinfo',
              iiprop: 'url|size|mime|extmetadata',
              iiurlwidth: '400',
              format: 'json',
            });
            const apiResp = await fetch(`${WIKIMEDIA_BASE}?${params}`, {
              headers: { 'User-Agent': 'HMDaoAssetCollector/1.0' },
            });
            const data = await apiResp.json();
            const pages = data.query?.pages || {};
            results = Object.values(pages)
              .map((item, i) => {
                const info = (item.imageinfo && item.imageinfo[0]) || {};
                const isVideo = /video|ogg|webm/i.test(info.mime || '');
                return {
                  id: `wikimedia-${item.pageid || i}`,
                  url: info.url || '',
                  thumb: info.thumburl || info.url || '',
                  title: String(item.title || `Wikimedia ${i + 1}`).replace(/^File:/, ''),
                  source: 'wikimedia',
                  sourceName: 'Wikimedia',
                  type: isVideo ? 'video' : 'image',
                  width: info.width,
                  height: info.height,
                  author: (info.extmetadata?.Artist?.value || '').replace(/<[^>]+>/g, ''),
                  license: info.extmetadata?.LicenseShortName?.value || 'CC',
                  tags: [],
                  uploadDate: info.extmetadata?.DateTimeOriginal?.value,
                };
              })
              .filter((r) => r.url);
            total = results.length;
            break;
          }

          default:
            return send(res, 200, { results: [], total: 0, notice: `unsupported platform: ${platform}` });
        }

        return send(res, 200, { success: true, results, total, page, query });
      } catch (error) {
        console.error(`[free-search] ${platform} error:`, error.message);
        return send(res, 200, { success: true, results: [], total: 0, notice: 'search failed, try another platform' });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/byok/relay/discover') {
      const {
        endpoint = '',
        apiKey = '',
        relayPresetId = 'generic-openai-relay',
      } = await readJson(req);
      const discovery = await fetchRelayModelIndex({
        endpoint: String(endpoint || '').trim(),
        apiKey: String(apiKey || '').trim(),
        relayPresetId: String(relayPresetId || 'generic-openai-relay').trim(),
      });
      return send(res, discovery.success ? 200 : discovery.status || 400, {
        success: discovery.success,
        endpoint: discovery.endpoint || normalizeRelayEndpointInput(endpoint),
        relayPresetId: discovery.relayPresetId || String(relayPresetId || 'generic-openai-relay').trim(),
        relayName: discovery.relayName || null,
        models: discovery.models,
        recommended: discovery.recommended,
        message: discovery.message,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/byok/relay/activate') {
      const started = Date.now();
      const {
        endpoint = '',
        apiKey = '',
        relayPresetId = 'generic-openai-relay',
      } = await readJson(req);
      const normalizedEndpoint = normalizeRelayEndpointInput(endpoint);
      const normalizedKey = String(apiKey || '').trim();
      const discovery = await fetchRelayModelIndex({
        endpoint: normalizedEndpoint,
        apiKey: normalizedKey,
        relayPresetId: String(relayPresetId || 'generic-openai-relay').trim(),
      });
      if (!discovery.success) {
        return send(res, discovery.status || 400, {
          success: false,
          endpoint: discovery.endpoint || normalizedEndpoint,
          relayPresetId: discovery.relayPresetId || String(relayPresetId || 'generic-openai-relay').trim(),
          models: discovery.models,
          recommended: discovery.recommended,
          error: {
            title: 'Relay activation failed',
            message: discovery.message || '聚合平台模型激活失败',
          },
          latencyMs: Date.now() - started,
        });
      }

      const activationRecords = buildRelayActivationRecords(discovery.models);
      if (!activationRecords.length) {
        return send(res, 400, {
          success: false,
          endpoint: normalizedEndpoint,
          relayPresetId: discovery.relayPresetId,
          models: discovery.models,
          recommended: discovery.recommended,
          error: {
            title: 'No compatible models',
            message: '当前中转站模型列表已返回，但暂未匹配到可直接同步到 DDUp 画布的主流模型',
          },
          latencyMs: Date.now() - started,
        });
      }

      for (const record of activationRecords) {
        setActivatedProviderRecord(record.provider, record.mode, {
          model: record.model || null,
          apiKey: normalizedKey,
          maskedKey: maskKey(normalizedKey),
          endpoint: (discovery.endpoint || normalizedEndpoint) || undefined,
          activatedAt: Date.now(),
          relaySource: discovery.relayName || discovery.relayPresetId || 'relay',
          relayPresetId: String(relayPresetId || discovery.relayPresetId || 'generic-openai-relay').trim() || null,
          catalogModelIds: record.catalogModelIds,
          availableModels: record.availableModels,
          primaryPrice: record.primaryPrice,
          primaryCurrency: record.primaryCurrency,
        });
      }

      broadcastCatalogUpdate('relay-provider-activated');
      return send(res, 200, {
        success: true,
        endpoint: discovery.endpoint || normalizedEndpoint,
        relayPresetId: discovery.relayPresetId,
        relayName: discovery.relayName,
        models: discovery.models,
        recommended: discovery.recommended,
        activations: activationRecords.map((record) => ({
          provider: record.provider,
          mode: record.mode,
          model: record.model,
          catalogModelIds: record.catalogModelIds,
          availableModels: record.availableModels,
          primaryPrice: record.primaryPrice,
          primaryCurrency: record.primaryCurrency,
          maskedKey: maskKey(normalizedKey),
        })),
        message: 'Activated ' + activationRecords.length + ' platform capability record(s) and synced them into the canvas model list.',
        latencyMs: Date.now() - started,
      });
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/api/dcc/local-artifacts/')) {
      const token = sanitizeLocalAssetId(url.pathname.slice('/api/dcc/local-artifacts/'.length));
      if (!token) {
        return send(res, 400, { success: false, error: { message: 'invalid-dcc-artifact-token' } });
      }
      const item = getDccLocalArtifact(token);
      if (!item?.filePath) {
        return send(res, 404, { success: false, error: { message: 'dcc-artifact-not-found' } });
      }
      await sendLocalFileStream(req, res, item.filePath, {
        mimeType: String(item.mimeType || mediaMimeTypeFromExtension(item.filePath, 'application/octet-stream')),
        contentDisposition: buildSafeInlineContentDisposition(item.filePath),
        headers: { 'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache', Expires: '0' },
      });
      return;
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/api/assets/content/')) {
      const assetId = sanitizeLocalAssetId(url.pathname.slice('/api/assets/content/'.length));
      if (!assetId) {
        return send(res, 400, { success: false, error: { message: 'invalid-asset-id' } });
      }
      const item = await findAssetLibraryItem(assetId);
      if (!item?.filePath) {
        return send(res, 404, { success: false, error: { message: 'asset-not-found' } });
      }
      await sendLocalFileStream(req, res, item.filePath, {
        mimeType: mediaMimeTypeFromExtension(item.filePath, 'application/octet-stream'),
        contentDisposition: buildSafeInlineContentDisposition(item.filePath),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/byok/validate') {
      const started = Date.now();
      const {
        provider,
        apiKey,
        mode = 'llm',
        model,
        upstreamModel = '',
        endpoint = '',
      } = await readJson(req);
      const normalizedEndpoint = normalizeRelayEndpointInput(endpoint);
      const known = providers.find((item) => item.id === provider);
      if (!known) return send(res, 400, { success: false, provider, mode, maskedKey: '', error: { title: '未知平台', message: `平台 ${provider} 未配置。` } });
      if (!apiKey || String(apiKey).trim().length < 8) {
        return send(res, 400, { success: false, provider, mode, maskedKey: maskKey(apiKey), error: { title: 'API Key 无效', message: 'API Key 至少需要 8 个字符。' } });
      }
      const validationResult = await validateByokProvider({ provider, apiKey, model, mode, endpoint: normalizedEndpoint });
      if (!validationResult.success) {
        return send(res, 400, {
          success: false,
          provider,
          mode,
          model,
          maskedKey: maskKey(String(apiKey).trim()),
          error: {
            title: validationResult.validated ? '远程校验失败' : '校验失败',
            message: validationResult.message || (known.name + ' 校验失败。'),
          },
          latencyMs: Date.now() - started,
        });
      }
      setActivatedProviderRecord(provider, mode, {
        model: validationResult.model || String(upstreamModel || '').trim() || model || null,
        apiKey: String(apiKey).trim(),
        maskedKey: maskKey(String(apiKey).trim()),
        endpoint: normalizedEndpoint || undefined,
        activatedAt: Date.now(),
      });
      broadcastCatalogUpdate('provider-activated');
      return send(res, 200, {
        success: true,
        provider,
        mode,
        model: validationResult.model || model,
        maskedKey: maskKey(String(apiKey).trim()),
        endpoint: normalizedEndpoint || undefined,
        message: validationResult.message || (known.name + ' completed remote validation and activation.'),
        latencyMs: Date.now() - started,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/byok/deactivate') {
      const { provider, mode } = await readJson(req);
      if (provider) {
        deleteActivatedProviderRecord(provider, mode || '');
      } else {
        hydrateActivatedProviderRecordsFromDisk();
        activatedProviders.clear();
        persistActivatedProviderRecordsToDisk();
      }
      broadcastCatalogUpdate('provider-deactivated');
      return send(res, 200, { success: true, provider: provider || null, mode: mode || null });
    }

    if (req.method === 'POST' && url.pathname === '/api/byok/validate-all') {
      const { keys = [] } = await readJson(req);
      const results = keys.map((item) => ({
        success: Boolean(item.apiKey && String(item.apiKey).length >= 8),
        provider: item.provider,
        mode: item.mode || 'llm',
        maskedKey: maskKey(item.apiKey),
      }));
      return send(res, 200, {
        success: results.every((item) => item.success),
        results,
        summary: { total: results.length, success: results.filter((item) => item.success).length, failed: results.filter((item) => !item.success).length },
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/local-image/analyze') {
      const contentType = String(req.headers['content-type'] || '').toLowerCase();
      const body = contentType.includes('multipart/form-data')
        ? await readLocalImageAnalyzeMultipart(req)
        : await readJson(req);
      const analysis = await processLocalImageAnalyzeRequest(body);
      return send(res, 200, { success: true, analysis });
    }

    if (req.method === 'POST' && url.pathname === '/api/local-video/edit') {
      const body = await readJson(req);
      const result = await processLocalVideoEditRequest(body);
      return send(res, 200, { success: true, ...result });
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/api/local-video/result/')) {
      const assetId = sanitizeLocalAssetId(url.pathname.slice('/api/local-video/result/'.length));
      if (!assetId) {
        return send(res, 400, { success: false, error: { message: 'invalid-local-video-asset-id' } });
      }
      const filePath = path.join(LOCAL_VIDEO_RESULT_DIR, assetId);
      await sendLocalFileStream(req, res, filePath, {
        mimeType: mediaMimeTypeFromExtension(filePath, 'video/webm'),
        contentDisposition: `inline; filename="${assetId}"`,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/local-audio/generate') {
      const body = await readJson(req);
      const result = await processLocalAudioGenerateRequest(body);
      return send(res, 200, { success: true, ...result });
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/api/local-audio/result/')) {
      const assetId = sanitizeLocalAssetId(url.pathname.slice('/api/local-audio/result/'.length));
      if (!assetId) {
        return send(res, 400, { success: false, error: { message: 'invalid-local-audio-asset-id' } });
      }
      const filePath = path.join(LOCAL_AUDIO_RESULT_DIR, assetId);
      await sendLocalFileStream(req, res, filePath, {
        mimeType: mediaMimeTypeFromExtension(filePath, 'audio/wav'),
        contentDisposition: `inline; filename="${assetId}"`,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/local-post/process') {
      const contentType = String(req.headers['content-type'] || '').toLowerCase();
      const body = contentType.includes('multipart/form-data')
        ? await readLocalPostMultipart(req)
        : await readJson(req);
      const result = await processLocalPostRequest(body);
      return send(res, 200, { success: true, ...result });
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/api/local-post/result/')) {
      const assetId = sanitizeLocalAssetId(url.pathname.slice('/api/local-post/result/'.length));
      if (!assetId) {
        return send(res, 400, { success: false, error: { message: 'invalid-local-post-asset-id' } });
      }
      const filePath = path.join(LOCAL_POST_RESULT_DIR, assetId);
      await sendLocalFileStream(req, res, filePath, {
        mimeType: mediaMimeTypeFromExtension(filePath, 'application/octet-stream'),
        contentDisposition: `inline; filename="${assetId}"`,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/proxy-preview/')) {
      const provider = decodeURIComponent(url.pathname.split('/').pop() || '');
      const body = await readJson(req);
      const result = await previewGenerationRequest({
        provider,
        endpoint: body.endpoint,
        method: body.method || 'POST',
        body: body.body || {},
        timeout: body.timeout,
        apiKey: body.apiKey,
        baseUrl: body.baseUrl,
      });
      return send(res, 200, result);
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/proxy/')) {
      const provider = decodeURIComponent(url.pathname.split('/').pop() || '');
      const body = await readJson(req);
      const result = await executeGenerationRequest({
        provider,
        endpoint: body.endpoint,
        method: body.method || 'POST',
        body: body.body || {},
        timeout: body.timeout,
        apiKey: body.apiKey,
        baseUrl: body.baseUrl,
      });
      return send(res, 200, result);
    }

    // ===== 扩展包信息端点 =====
    if (req.method === 'GET' && url.pathname.startsWith('/api/extensions/')) {
      const extensionId = decodeURIComponent(url.pathname.slice('/api/extensions/'.length));
      const extensions = {
        'free-search-pack': {
          id: 'free-search-pack',
          name: '免费搜图扩展包',
          version: '1.0.0',
          description: '整合 Unsplash、Pexels、Pixabay、Openverse 等免费图库 API',
          features: ['关键词搜图', '以图搜图', '多平台聚合', '批量采集', '拖拽导入'],
          platforms: ['unsplash', 'pexels', 'pixabay', 'openverse'],
          status: 'active',
        },
        'asset-search-engine': {
          id: 'asset-search-engine',
          name: '智能搜索引擎',
          version: '1.0.0',
          description: '增强本地搜索：模糊匹配 + 拼音搜索 + 布尔语法',
          features: ['模糊匹配', '拼音搜索', '布尔搜索', '搜索历史', '实时建议', 'AI分析结果搜索'],
          status: 'active',
        },
        'ai-analysis-pack': {
          id: 'ai-analysis-pack',
          name: 'AI 深度分析扩展包',
          version: '1.0.0',
          description: '视觉大模型图片分析、提示词提取、相似图生成',
          features: ['光影分析', '风格识别', '构图解析', '运镜检测', '提示词提取', '相似图生成'],
          recommendedModels: ['qwen3.7-plus', 'gpt-4o', 'Qwen/Qwen2.5-VL-72B-Instruct'],
          status: 'active',
        },
      };

      const ext = extensions[extensionId];
      if (!ext) {
        return send(res, 404, { success: false, error: { message: `extension ${extensionId} not found` } });
      }
      return send(res, 200, { success: true, extension: ext });
    }

    return send(res, 404, { success: false, error: { message: `No route for ${req.method} ${url.pathname}` } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[HMDao API] request failed', {
      method: req.method,
      path: url.pathname,
      message,
      stack: error instanceof Error ? error.stack : undefined,
    });
    return send(res, localVideoEditStatusCode(message), { success: false, error: { message } });
  }
}

const server = http.createServer(route);
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url || '/', `http://${req.headers.host}`).pathname;
  if (pathname === '/ws/workflow') {
    void handleWorkflowUpgrade(req, socket, head);
    return;
  }
  if (pathname === '/ws/catalog') {
    void handleCatalogUpgrade(req, socket, head);
    return;
  }
  void handleDccUpgrade(req, socket, head);
});

// ===== Runtime guards =====
process.on('uncaughtException', (error) => {
  console.error('[HMDao API] uncaught exception:', error.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[HMDao API] unhandled rejection:', reason);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[HMDao API] http://127.0.0.1:${PORT}`);
});

























