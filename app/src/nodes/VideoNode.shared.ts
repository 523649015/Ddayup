// Shared types, constants and pure helpers extracted from VideoNode.tsx.
// Moved verbatim — no behavior change.
import { relaySourceLabel } from '@/components/SourceBadge';
import {
  collectConnectedReferenceInputs,
  type ReferenceRole,
  type ReferenceRoleOption,
  type ReferenceSettingsValue,
} from '@/lib/nodeReferenceGraph';
import type { LocalVideoAudioMixConfig } from '@/services/ffmpegPipeline';
import {
  buildVideoModelCapabilityRequirements,
  evaluateModelCapabilitySupport,
} from '@/services/workflowGraph';
import { isLocalMediaHandle } from '@/services/localMediaRegistry';
import { findProviderKeyState, isUnusableProviderKeyStatus, providerKeyMatchesModel, type ProviderKeyState } from '@/store/useApiKeyStore';
import type { MediaInput, ModelCapabilityMatrix, NodeData } from '@/types';

export function stopCanvasInteraction(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

export type VideoTool = 'clip' | 'crop' | 'hd' | 'parse' | 'removeSubtitle' | 'audioSplit';
export type VideoUploadTarget = 'main' | 'sourceImage' | 'firstFrame' | 'lastFrame' | 'referenceImage' | 'referenceVideo';
export const MAX_DEBUG_VIDEO_NODE_SNAPSHOTS = 24;

export function mergeBoundedVideoDebugSnapshots(
  currentSnapshots: Record<string, unknown> | undefined,
  nodeId: string,
  snapshot: Record<string, unknown>,
) {
  const orderedEntries = Object.entries(currentSnapshots || {}).filter(([key]) => key !== nodeId);
  orderedEntries.push([nodeId, snapshot]);
  const trimmedEntries = orderedEntries.slice(-MAX_DEBUG_VIDEO_NODE_SNAPSHOTS);
  return Object.fromEntries(trimmedEntries);
}
export type CropResizeHandle = 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ClipSegment {
  id: string;
  startTime: number;
  endTime: number;
  label: string;
}

export function modelMatchesLocalKey(
  model: { id: string; name: string; provider: string; upstreamModel?: string },
  keyState: Pick<ProviderKeyState, 'mode' | 'model' | 'status' | 'apiKey' | 'metadataOnly'> | undefined,
  mode: 'image' | 'video',
) {
  return Boolean(
    keyState
    // 任务 AL：invalid 与 expired 同为不可用（统一判定）。
    && !isUnusableProviderKeyStatus(keyState.status)
    && keyState.mode === mode
    && (keyState.apiKey || keyState.metadataOnly)
    && providerKeyMatchesModel(keyState, model.upstreamModel || model.id, { allowProviderOnlyFallback: false }),
  );
}

export const CONTRACT_IMAGE_ROLE_OPTIONS: ReferenceRoleOption[] = [
  { value: 'subject', label: '主体参考' },
  { value: 'element', label: '元素参考' },
  { value: 'style', label: '风格参考' },
  { value: 'composition', label: '构图参考' },
  { value: 'lighting', label: '光影参考' },
  { value: 'omni', label: '全能参考' },
];

export const CONTRACT_VIDEO_ROLE_OPTIONS: ReferenceRoleOption[] = [
  { value: 'motion', label: '运镜参考' },
  { value: 'rhythm', label: '节奏参考' },
  { value: 'style', label: '风格参考' },
  { value: 'omni', label: '全能参考' },
];

export function normalizeContractReferenceRole(value: unknown, fallback: ReferenceRole): ReferenceRole {
  const next = String(value || '').trim();
  if (
    next === 'primary'
    || next === 'style'
    || next === 'subject'
    || next === 'element'
    || next === 'composition'
    || next === 'lighting'
    || next === 'motion'
    || next === 'rhythm'
    || next === 'omni'
  ) {
    return next;
  }
  return fallback;
}

export function buildContractConnectedInput(
  input: MediaInput,
  settings: Record<string, ReferenceSettingsValue>,
): ReturnType<typeof collectConnectedReferenceInputs>[number] {
  const key = String(input.id || `region-contract:${input.sourceNodeId || 'source'}:${input.handleId || 'default'}:${input.type}`);
  const roleOptions = input.channel === 'video-reference' ? CONTRACT_VIDEO_ROLE_OPTIONS : CONTRACT_IMAGE_ROLE_OPTIONS;
  const fallbackRole = input.channel === 'primary'
    ? 'primary'
    : normalizeContractReferenceRole(input.role, input.channel === 'video-reference' ? 'motion' : 'style');
  const setting = settings[key] || {};
  const role = input.channel === 'primary'
    ? 'primary'
    : normalizeContractReferenceRole(setting.role, fallbackRole);
  return {
    id: String(input.id || key),
    type: input.type,
    url: input.url,
    label: String(input.label || input.sourceNodeId || '打标签参考'),
    metadata: input.metadata,
    sourceNodeId: String(input.sourceNodeId || ''),
    sourceNodeLabel: String(input.label || input.sourceNodeId || '打标签参考'),
    sourceNodeType: input.sourceNodeType || (input.type === 'video' ? 'video' : input.type === 'audio' ? 'audio' : input.type === 'text' ? 'text' : 'image'),
    edgeId: `region-contract:${input.sourceNodeId || 'source'}:${input.handleId || 'default'}`,
    key,
    channel: input.channel === 'video-reference' ? 'video-reference' : input.channel === 'primary' ? 'primary' : 'image-reference',
    handleId: String(input.handleId || ''),
    role,
    weight: Math.max(0, Math.min(100, Math.round(Number(setting.weight ?? input.weight ?? (input.channel === 'primary' ? 100 : 80))))),
    enabled: setting.enabled === undefined ? (input.enabled === undefined ? true : Boolean(input.enabled)) : Boolean(setting.enabled),
    roleOptions: input.channel === 'primary' ? [{ value: 'primary', label: '主素材' }] : roleOptions,
    isManualBinding: false,
  };
}

export interface VideoModelOption {
  id: string;
  name: string;
  description: string;
  cost: number;
  currency?: string;
  latency?: string;
  provider: string;
  providerLabel?: string;
  upstreamModel?: string;
  activated?: boolean;
  discountLabel?: string;
  maskedKey?: string;
  activationModelMatched?: boolean;
  activationModel?: string;
  activationRelaySource?: string | null;
  capabilities?: ModelCapabilityMatrix | null;
  supportedForCurrentRequest?: boolean;
  unsupportedReason?: string | null;
}

export function videoModelActivationSourceLabel(model: Pick<VideoModelOption, 'activationRelaySource' | 'activated'>) {
  if (!model.activated || !model.activationRelaySource) return null;
  return relaySourceLabel(model.activationRelaySource);
}

export interface VideoMeta {
  width: number;
  height: number;
  duration: number;
}

export interface VideoSourceConstraint {
  supported: boolean;
  reason: string;
}

export interface ParsedStoryboardShot {
  id: string;
  startTime: number;
  endTime: number;
  duration: number;
  shotNumber: number;
  subjectCount?: number;
  subjectSummary?: string;
  subjectTraits?: string;
  actionSummary?: string;
  sceneSetting?: string;
  storyboardPurpose?: string;
  lensSuggestion?: string;
  frameDescription: string;
  narrativeBeat: string;
  sceneType: string;
  cameraAngle: string;
  cameraMovement: string;
  focusDepth: string;
  lighting: string;
  soundDesign: string;
  cameraPrompt: string;
  imagePrompt: string;
  keyframePrompt: string;
  keyframeTime: number;
  visualKeywords: string[];
  styleDescription?: string;
  lightingMood?: string;
  atmosphere?: string;
  subjectMotion?: string;
  cameraMotionDetail?: string;
  compositionDetail?: string;
  colorPalette?: string[];
  keyframeImageBase64?: string;
  keyframeMimeType?: string;
  keyframeWidth?: number;
  keyframeHeight?: number;
  metrics?: Record<string, number>;
}

export interface WindowWithPicker extends Window {
  showOpenFilePicker?: (options?: {
    multiple?: boolean;
    excludeAcceptAllOption?: boolean;
    types?: Array<{
      description?: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<Array<{
    getFile: () => Promise<File>;
  }>>;
}

export interface ToolModelHelpEntry {
  label: string;
  role: string;
  advantage: string;
}

export const PARSE_SCENE_ENGINE_HELP: Record<string, ToolModelHelpEntry> = {
  auto: {
    label: '自动',
    role: '先走免费本地切镜链路，再根据本机可用模型自动升级。',
    advantage: '默认最稳，不需要额外安装就能先跑通。',
  },
  scenedetect: {
    label: 'PySceneDetect',
    role: '按画面变化做基础镜头切分，适合先快速拆整段视频。',
    advantage: '启动快、资源占用低、免费开源，适合粗分镜。',
  },
  transnetv2: {
    label: 'TransNetV2',
    role: '用深度学习做镜头切点检测，适合切换频繁、节奏强的视频。',
    advantage: '切点更准，对广告、MV、综艺类视频更稳。',
  },
};

export const PARSE_SEMANTIC_ENGINE_HELP: Record<string, ToolModelHelpEntry> = {
  'custom-api': {
    label: '国内多模态优先',
    role: '优先调用已激活的聚合平台视频视觉模型（智谱 GLM-4V / 阿里 Qwen-VL / 字节豆包视觉 / 腾讯混元视觉等）。',
    advantage: '最适合详细分析运镜、主体、风格与镜头语言，并整理中文分镜脚本。',
  },
  'qwen35-vl': {
    label: '阿里 Qwen3-VL',
    role: '阿里最新一代视觉大模型，原生支持视频理解，逐帧抽取做运镜拆解与主体识别。',
    advantage: '国内模型、中文镜头语言友好，适合复杂镜头语义与风格分析。',
  },
  auto: {
    label: '自动',
    role: '默认先用本地轻量语义，检测到更强模型或云端视觉链后自动切换。',
    advantage: '兼顾速度和稳定性，适合多数本地工作流。',
  },
  'local-heuristic': {
    label: '本地轻量语义',
    role: '基于本地规则和抽样帧做主体、动作、场景的基础描述。',
    advantage: '完全免费、速度快，适合先看视频大意和分镜骨架。',
  },
  internvideo: {
    label: 'InternVideo',
    role: '视频理解专用模型，更强地理解主体、动作关系和场景变化。',
    advantage: '动作分析更细，适合要反推镜头意图的场景。',
  },
  'video-llava': {
    label: 'Video-LLaVA',
    role: '输出更丰富的画面语义、镜头语言和文本描述。',
    advantage: '更适合生成详细分镜脚本和提示词草稿。',
  },
};

export const SUBTITLE_ENGINE_HELP: Record<string, ToolModelHelpEntry> = {
  auto: {
    label: '自动',
    role: '优先尝试更强的时序修复方案，不可用时自动回退到轻量本地链路。',
    advantage: '最省心，能根据本机能力自动选稳妥路径。',
  },
  'opencv-telea': {
    label: 'OpenCV Telea',
    role: '对字幕区域做经典图像修补，适合固定底部字幕和简单水印。',
    advantage: '无需额外安装、响应快，适合先快速出结果。',
  },
  'video-subtitle-remover': {
    label: 'video-subtitle-remover',
    role: '更适合标准字幕区域的自动检测和修补。',
    advantage: '比纯 OpenCV 更省手，批量去字幕更实用。',
  },
  propainter: {
    label: 'ProPainter',
    role: '用更强的时序一致性修复复杂字幕、水印和遮挡。',
    advantage: '复杂背景下更自然，跨帧闪烁更少。',
  },
};

export const AUDIO_SPLIT_MODEL_HELP: Record<string, ToolModelHelpEntry> = {
  'Demucs-v4': {
    label: 'Demucs-v4',
    role: '做人声、伴奏、混合轨的综合分离，适合大多数视频素材。',
    advantage: '免费开源里综合效果最好，默认推荐先选它。',
  },
  'UVR5-MDX-Net': {
    label: 'UVR5-MDX-Net',
    role: '偏向人声提取和常规伴奏分离，适合对白或配音较明显的内容。',
    advantage: '社区成熟、兼容性高，做人声提取比较稳。',
  },
  MDX23C: {
    label: 'MDX23C',
    role: '针对复杂音乐混音做更细的分离，适合 BGM 较重的素材。',
    advantage: '复杂音乐场景下伴奏保真更好，适合广告、MV、混剪。',
  },
};

export const FALLBACK_MODELS: VideoModelOption[] = [
  { id: 'kling-v3-omni', name: 'Kling V3 Omni', description: '主视频保运镜、多参考换角与全能参考优先模型', cost: 3, currency: 'CNY', latency: '60s', provider: 'kling', providerLabel: 'Kling AI', upstreamModel: 'kling-v3-omni' },
  { id: 'kling-o3', name: 'Kling O3', description: '强主体锁定与主视频运镜保留，适合全能参考视频', cost: 3, currency: 'CNY', latency: '60s', provider: 'kling', providerLabel: 'Kling AI', upstreamModel: 'kling-v3' },
  { id: 'happyhorse-11', name: 'HappyHorse 1.1', description: '兼容 T2V / I2V / 多参考视频编辑的中转优先模型', cost: 1.6, currency: 'CNY', latency: '70s', provider: 'bailian', providerLabel: '阿里云百炼 / Relay', upstreamModel: 'happyhorse-1.1' },
  { id: 'seedance-v2', name: 'Seedance V2', description: '保留 doubao-seedance-2.0 目录映射，适合主视频参考与镜头控制', cost: 2.8, currency: 'CNY', latency: '22s', provider: 'fal', providerLabel: 'fal.ai', upstreamModel: 'doubao-seedance-2.0' },
  { id: 'wan22-i2v-a14b', name: 'Wan 2.2 图生视频', description: '硅基流动 Wan2.2 图生视频，适合首尾帧和参考图动画', cost: 0.29, currency: 'USD', latency: '95s', provider: 'siliconflow', providerLabel: '硅基流动', upstreamModel: 'Wan-AI/Wan2.2-I2V-A14B' },
  { id: 'wan22-t2v-a14b', name: 'Wan 2.2 文生视频', description: '硅基流动 Wan2.2 文生视频，适合广告短片和镜头预演', cost: 0.29, currency: 'USD', latency: '88s', provider: 'siliconflow', providerLabel: '硅基流动', upstreamModel: 'Wan-AI/Wan2.2-T2V-A14B' },
  { id: 'bailian-wan22-i2v-plus', name: '百炼 Wan 2.2 图生视频', description: '阿里云百炼 Wan2.2 图生视频，余额不足时可切回硅基流动', cost: 1.8, currency: 'CNY', latency: '100s', provider: 'bailian', providerLabel: '阿里云百炼', upstreamModel: 'wan2.2-i2v-plus' },
  { id: 'bailian-wan22-t2v-plus', name: '百炼 Wan 2.2 文生视频', description: '阿里云百炼 Wan2.2 文生视频，适合广告短片和镜头预演', cost: 1.4, currency: 'CNY', latency: '90s', provider: 'bailian', providerLabel: '阿里云百炼', upstreamModel: 'wan2.2-t2v-plus' },
];

export const TOOL_LABELS: Record<VideoTool, string> = {
  clip: '剪辑',
  crop: '裁剪',
  hd: '高清',
  parse: '解析',
  removeSubtitle: '去字幕',
  audioSplit: '音频分离',
};

export const TOOL_FEEDBACK: Record<VideoTool, string> = {
  clip: '已连接无损剪辑链路，调整起止时间会实时写入当前视频节点。',
  crop: '已连接像素裁剪链路，裁剪框会实时反映当前节点的输出区域。',
  hd: '已连接高清增强链路，超分、补帧和细节增强会随生成请求提交。',
  parse: '选择支持视频的分析模型即可开始解析。',
  removeSubtitle: '已连接字幕/水印移除链路，识别模式和羽化参数会同步到当前节点。',
  audioSplit: '已连接音频分离链路，人声保留和工作流导出会同步到当前节点。',
};

export const OUTPUT_COUNT_OPTIONS = [1, 2, 3, 4] as const;
export const PROMPT_ASSIST_PROVIDER_ORDER = ['siliconflow', 'deepseek', 'openai', 'bailian', 'zhipu', 'modelscope', 'minimax'] as const;

export const VIDEO_TOOL_OPERATIONS: Record<VideoTool, string> = {
  clip: 'ffmpeg_lossless_trim_wavesurfer',
  crop: 'ffmpeg_pixel_crop_cropper',
  hd: 'real_cugan_rife_codeformer_enhance',
  parse: 'opencv_scenedetect_keyframe_parse',
  removeSubtitle: 'opencv_telea_subtitle_remove',
  audioSplit: 'demucs_v4_audio_split',
};

export const VIDEO_MODE_OPTIONS = [
  { value: 'textToVideo', label: '文生视频' },
  { value: 'imageToVideo', label: '图生视频' },
  { value: 'firstLastFrame', label: '首尾帧' },
  { value: 'referenceVideo', label: '参考生成' },
] as const;

export const VIDEO_ASPECT_OPTIONS = ['16:9', '9:16', '1:1', '4:3', '3:4'] as const;
export const VIDEO_QUALITY_OPTIONS = ['480p', '720p', '1080p', '1440p'] as const;

export function computeAllowedQualityOptions(model: Pick<VideoModelOption, 'id' | 'upstreamModel'>): string[] {
  // seedance-v2 模型仅支持 480p/720p（根据文档及实测验证）
  const modelId = String(model.id || model.upstreamModel || '');
  if (/seedance/i.test(modelId)) return ['480p', '720p'];
  return VIDEO_QUALITY_OPTIONS as unknown as string[];
}

export const VIDEO_MODE_BLUEPRINTS: Record<string, { title: string; description: string; technique: string }> = {
  textToVideo: {
    title: '文生视频创作',
    description: '纯文本驱动镜头、风格、景别与动作，适合广告短片、概念片和脚本预演。',
    technique: '提示词优化 + 原生视频模型参数注入 + 运动预设控制',
  },
  imageToVideo: {
    title: '单图生视频',
    description: '上传一张首帧或产品图，锁定主体与风格后生成自然延展的视频。',
    technique: '参考图锁定 + 运动幅度控制 + 色域与一致性约束',
  },
  firstLastFrame: {
    title: '首尾帧生成',
    description: '同时约束起始与结束画面，中间过程由模型补全，适合转场和剧情镜头。',
    technique: '首尾帧双条件 + 光流对齐 + 结尾一致性约束',
  },
  referenceVideo: {
    title: '参考素材生成',
    description: '用参考图或参考视频复刻风格、构图、动作与镜头语言，可局部参考。',
    technique: '视频条件控制 + 关键帧抽取 + 局部参考区域注入',
  },
};

export const VIDEO_STYLE_PRESETS = ['电影感', '电商精修', '真实纪实', '赛博霓虹', '柔光人像', '产品广告'] as const;

export function isImageConditionedGenerationMode(mode: string) {
  return mode === 'imageToVideo' || mode === 'firstLastFrame' || mode === 'referenceVideo';
}

export function normalizeVideoModelIdentifier(value: string | undefined | null) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return '';
  if (/doubao[\-_/ ]?seedance[\-_/ ]?2(?:\.0)?/.test(normalized)) return 'seedance-v2';
  if (/seedance[\-_/ ]?(?:2(?:\.0)?|v2)/.test(normalized)) return 'seedance-v2';
  return normalized;
}

export function videoModelMatchesIdentifier(
  model: Pick<VideoModelOption, 'id' | 'upstreamModel' | 'name'>,
  identifier: string | undefined | null,
) {
  const normalizedIdentifier = normalizeVideoModelIdentifier(identifier);
  if (!normalizedIdentifier) return false;
  const candidates = [
    model.id,
    model.upstreamModel,
    model.name,
  ]
    .map((value) => normalizeVideoModelIdentifier(String(value || '')))
    .filter(Boolean);
  return candidates.includes(normalizedIdentifier);
}

export function shouldPreservePinnedVideoModelIdentifier(
  model: Pick<VideoModelOption, 'id' | 'upstreamModel' | 'name'>,
  identifier: string | undefined | null,
  pinnedByUser: boolean,
) {
  if (!pinnedByUser) return false;
  const normalizedIdentifier = normalizeVideoModelIdentifier(identifier);
  if (!normalizedIdentifier) return false;
  if (normalizedIdentifier === 'kling-v3-omni') return true;
  const normalizedModelId = normalizeVideoModelIdentifier(model.id);
  if (normalizedIdentifier === normalizedModelId) return false;
  return videoModelMatchesIdentifier(model, identifier);
}

export function isI2vModel(model: Pick<VideoModelOption, 'id' | 'upstreamModel' | 'name'>) {
  const target = `${model.id} ${model.upstreamModel || ''} ${model.name}`.toLowerCase();
  return target.includes('i2v') || target.includes('图生');
}

export function isT2vModel(model: Pick<VideoModelOption, 'id' | 'upstreamModel' | 'name'>) {
  const target = `${model.id} ${model.upstreamModel || ''} ${model.name}`.toLowerCase();
  return target.includes('t2v') || target.includes('文生');
}

export function isVideoStyleTransferModel(model: Pick<VideoModelOption, 'id' | 'upstreamModel' | 'name' | 'provider'>) {
  const target = `${model.id} ${model.upstreamModel || ''} ${model.name} ${model.provider}`.toLowerCase();
  return model.provider === 'kling'
    || model.provider === 'fal'
    || model.provider === 'replicate'
    || target.includes('seedance')
    || target.includes('video-to-video')
    || target.includes('v2v');
}

export function videoBestForText(model: Pick<VideoModelOption, 'capabilities'>) {
  const tags = Array.isArray(model.capabilities?.bestFor)
    ? [...model.capabilities.bestFor]
    : [];
  if (model.capabilities?.supportsActionTransfer) tags.push('动作迁移');
  if (model.capabilities?.supportsPrimaryVideoMotionLock) tags.push('主视频运镜保留');
  if (model.capabilities?.supportsIdentityController) tags.push('主体锁定');
  if (model.capabilities?.supportsVideoStyleTransfer) tags.push('风格迁移');
  if (model.capabilities?.supportsReferenceVideo) tags.push('参考视频');
  return Array.from(new Set(tags.map((item) => String(item || '').trim()).filter(Boolean))).join(' ').toLowerCase();
}

export function videoRoutingHintText(model: Pick<VideoModelOption, 'id' | 'name' | 'provider' | 'upstreamModel' | 'description' | 'capabilities'>) {
  return [
    model.id,
    model.name,
    model.provider,
    model.upstreamModel,
    model.description,
    videoBestForText(model),
    Array.isArray(model.capabilities?.limitations) ? model.capabilities.limitations.join(' ') : '',
  ].join(' ').toLowerCase();
}

export function readNumericMediaMeta(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function readPrimaryVideoConstraint(primaryInputs: ReturnType<typeof collectConnectedReferenceInputs>): VideoSourceConstraint | null {
  const primaryVideo = primaryInputs.find((item) => item.enabled !== false && item.type === 'video');
  if (!primaryVideo) return null;
  const meta = primaryVideo.metadata && typeof primaryVideo.metadata === 'object'
    ? primaryVideo.metadata
    : null;
  const width = readNumericMediaMeta(meta && 'width' in meta ? meta.width : 0);
  const height = readNumericMediaMeta(meta && 'height' in meta ? meta.height : 0);
  if (height > 0 && height < 700) {
    return {
      supported: false,
      reason: `当前主视频源分辨率约为 ${width > 0 ? `${width}×${height}` : `${height}px`}，Kling omni 上游通常要求主视频高度至少 700px。建议先换成 720p 以上主视频，或临时改走 Wan 2.2 I2V 这类图生视频路线。`,
    };
  }
  return null;
}

export function resolvePreferredConditionedVideoModel(
  models: VideoModelOption[],
  selectedModel: VideoModelOption,
  requirements: ReturnType<typeof buildVideoModelCapabilityRequirements>,
  options: {
    needsVideoStyleTransfer: boolean;
    hasSubjectImageReference: boolean;
    hasOmniImageReference: boolean;
    hasOmniVideoReference: boolean;
    hasVideoReference: boolean;
    hasPrimaryVideo: boolean;
    hasPrimaryImage: boolean;
    referenceRoleCount: number;
  },
) {
  const ranked = models
    .filter((item) => item.activated)
    .map((item) => {
      const support = evaluateModelCapabilitySupport(item.capabilities || undefined, requirements);
      const tags = videoBestForText(item);
      const hints = videoRoutingHintText(item);
      let score = 0;
      if (support.supported) score += 500;
      else score -= 500;
      if (videoModelMatchesIdentifier(item, selectedModel.id) || videoModelMatchesIdentifier(item, selectedModel.upstreamModel)) score += 70;
      if (item.provider === selectedModel.provider) score += 30;
      if (options.hasPrimaryVideo && item.capabilities?.supportsPrimaryVideoMotionLock) score += 140;
      if (options.hasPrimaryVideo && options.hasVideoReference && item.capabilities?.supportsActionTransfer) score += 220;
      if (options.hasSubjectImageReference && item.capabilities?.supportsIdentityController) score += 120;
      if (options.needsVideoStyleTransfer && isVideoStyleTransferModel(item)) score += 180;
      if (options.hasPrimaryVideo && options.hasVideoReference && tags.includes('动作迁移')) score += 220;
      if (options.hasPrimaryVideo && tags.includes('主视频运镜保留')) score += 180;
      if (options.needsVideoStyleTransfer && tags.includes('风格迁移')) score += 120;
      if (options.hasSubjectImageReference && tags.includes('主体锁定')) score += 180;
      if (options.hasSubjectImageReference && tags.includes('高要求参考视频编辑')) score += 120;
      if ((options.hasOmniImageReference || options.hasOmniVideoReference) && tags.includes('全能参考')) score += 220;
      if (options.referenceRoleCount >= 3 && tags.includes('多参考视频生成')) score += 140;
      if (options.referenceRoleCount >= 3 && tags.includes('高要求参考视频编辑')) score += 90;
      if (options.hasPrimaryImage && tags.includes('图生视频')) score += 80;
      if (options.hasPrimaryImage && tags.includes('首尾帧')) score += 40;
      if (options.hasPrimaryVideo && options.hasSubjectImageReference) {
        if (tags.includes('主体锁定')) score += 120;
        if (tags.includes('高要求参考视频编辑')) score += 140;
        if (tags.includes('主视频运镜保留')) score += 80;
        if (tags.includes('全能参考')) score += 70;
      }
      if (options.hasOmniImageReference || options.hasOmniVideoReference) {
        if (tags.includes('全能参考')) score += 230;
        if (tags.includes('多参考视频生成')) score += 120;
      }
      if (options.referenceRoleCount >= 4) {
        if (tags.includes('全能参考')) score += 100;
        if (tags.includes('多参考视频生成')) score += 80;
      }
      if (options.hasPrimaryVideo && hints.includes('不支持主视频运镜锁定')) score -= 260;
      if (options.needsVideoStyleTransfer && hints.includes('不支持视频风格迁移')) score -= 240;
      return { item, score };
    })
    .sort((left, right) => right.score - left.score);
  return ranked[0]?.item || selectedModel;
}

// 各生成模式下「效果公认最好 + 最性价比」的国内平台模型推荐排序。
// 越靠前优先级越高；可灵 V3 Omni 质量标杆，豆包 Seedance 综合性价比最高，Wan 2.2 仅作开源兜底。
export const VIDEO_RECOMMEND_ORDER = [
  'kling-v3-omni',
  'kling-video-omni',
  'kling-o3',
  'seedance-v2',
  'doubao-seedance-2-0',
  'kling-video',
  'happyhorse',
  'wan22',
  'wan2',
  'veo3',
  'runway',
  'grok',
];

export function videoModelRecommendRank(model: Pick<VideoModelOption, 'id' | 'upstreamModel' | 'name' | 'provider'>) {
  const hay = [
    model.id,
    model.upstreamModel,
    model.name,
    model.provider,
  ]
    .map((value) => normalizeVideoModelIdentifier(String(value || '')))
    .filter(Boolean)
    .join(' ');
  for (let index = 0; index < VIDEO_RECOMMEND_ORDER.length; index += 1) {
    if (hay.includes(VIDEO_RECOMMEND_ORDER[index])) return index;
  }
  return VIDEO_RECOMMEND_ORDER.length;
}

export function choosePreferredVideoModel(models: VideoModelOption[], generationMode: string) {
  const matcher = isImageConditionedGenerationMode(generationMode) ? isI2vModel : isT2vModel;
  const matching = models.filter(matcher);
  const isExactActivated = (item: VideoModelOption) => item.activated && item.activationModelMatched !== false;
  if (matching.length === 0) {
    return models.find(isExactActivated) || models[0] || FALLBACK_MODELS[0];
  }
  const activated = matching.filter(isExactActivated);
  const pool = activated.length ? activated : matching;
  return [...pool].sort((left, right) => videoModelRecommendRank(left) - videoModelRecommendRank(right))[0];
}

export function resolveProviderCompatibleVideoModel(
  models: VideoModelOption[],
  selectedModel: VideoModelOption,
  provider: string,
  generationMode: string,
) {
  if (selectedModel.provider === provider) return selectedModel;
  const matcher = isI2vModel(selectedModel)
    ? isI2vModel
    : isT2vModel(selectedModel)
      ? isT2vModel
      : isImageConditionedGenerationMode(generationMode)
        ? isI2vModel
        : isT2vModel;
  const pool = [...models, ...FALLBACK_MODELS];
  return pool.find((item) => item.provider === provider && matcher(item)) || selectedModel;
}

export function recordFrom(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function defaultVideoToolConfig(tool: VideoTool, params: Record<string, unknown>, meta: VideoMeta | null): Record<string, unknown> {
  const existing = recordFrom(params.videoToolConfig);
  if (existing.tool === tool) return existing;
  const duration = Math.max(1, Number(params.duration || meta?.duration || 5));
  if (tool === 'clip') {
    return {
      tool,
      startTime: 0,
      endTime: Math.min(duration, 4),
      rippleDelete: false,
      waveform: true,
      waveformZoom: 1,
      snapToKeyframes: true,
      selectedSegmentIndex: 0,
      clipSegments: [{
        id: 'segment-1',
        startTime: 0,
        endTime: Math.min(duration, 4),
        label: '片段 1',
      }],
    };
  }
  if (tool === 'crop') {
    return { tool, x: 8, y: 8, widthPercent: 84, heightPercent: 72, lockAspect: true, aspectRatio: '16:9' };
  }
  if (tool === 'hd') {
    return { tool, scale: 2, mode: 'quality', detailStrength: 0.58, sharpen: 0.36, interpolate60fps: true, faceRestore: true };
  }
  if (tool === 'parse') {
    return {
      tool,
      sceneDetect: true,
      sampleFps: 2,
      extractPrompt: true,
      cameraLanguage: true,
      model: 'local-semantic',
      sceneEngine: 'auto',
      semanticEngine: 'auto',
    };
  }
  if (tool === 'removeSubtitle') {
    return {
      tool,
      subtitleEngine: 'auto',
      detectionMode: 'auto',
      targets: ['subtitle', 'watermark'],
      maskFeather: 8,
      temporalConsistency: true,
      previewFrame: 1,
      regionX: 12,
      regionY: 80,
      regionWidth: 76,
      regionHeight: 12,
    };
  }
  return { tool, mode: 'fullTracks', keepVocalInVideo: false, exportToWorkflow: true, stemModel: 'Demucs-v4', sampleRate: 48000 };
}

export function mediaKindFromFile(file: File): 'image' | 'video' | 'unknown' {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  return 'unknown';
}

export function createMediaDescriptor(file: File, url: string, kind: 'image' | 'video', role: VideoUploadTarget) {
  return {
    type: kind,
    url,
    thumbnail: kind === 'video' ? url : '',
    folderId: 'root',
    size: file.size,
    tags: [role],
    smartCategories: [],
    source: 'upload' as const,
    name: file.name,
  };
}

export function clampCount(value: unknown, fallback = 1) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(1, Math.min(4, Math.round(next)));
}

export function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(min, Math.min(max, next));
}

export function toggleArrayValue(values: unknown, value: string) {
  const current = Array.isArray(values) ? values.filter((item) => typeof item === 'string').map(String) : [];
  return current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
}

export function parseLatencySeconds(value: string | undefined) {
  const match = String(value || '').trim().toLowerCase().match(/(\\d+(?:\\.\\d+)?)s/);
  return match ? Number(match[1]) : 0;
}

export function formatEta(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '未知';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remain = Math.round(seconds % 60);
  return remain > 0 ? `${minutes}m ${remain}s` : `${minutes}m`;
}

export function formatCurrency(value: number, currency = 'CNY') {
  if (!Number.isFinite(value)) return '未知';
  if (currency === 'CNY') return `¥${value >= 100 ? value.toFixed(0) : value.toFixed(2)}`;
  return `${currency} ${value.toFixed(2)}`;
}

// 视频模型费用统一折算为人民币：上游以 USD 计价的模型在列表与预估中按汇率换算展示。
export const USD_TO_CNY_RATE = 7.3;
export function normalizeVideoCost(cost: number, currency?: string): { cost: number; currency: string } {
  if ((currency || 'CNY') === 'CNY') return { cost, currency: 'CNY' };
  return { cost: Number((cost * USD_TO_CNY_RATE).toFixed(2)), currency: 'CNY' };
}

// 同一类模型只保留一个：去掉供应商前缀后按名称归类，避免「备选 / 备份」重复占用空间。
export function videoModelFamilyKey(name: string): string {
  return name
    .replace(/^(阿里云百炼|百炼|硅基流动)\s*/g, '')
    .replace(/\s*\(.*?\)\s*$/g, '')
    .trim()
    .toLowerCase();
}

export function dedupeVideoModels(options: VideoModelOption[]): VideoModelOption[] {
  const byFamily = new Map<string, VideoModelOption[]>();
  for (const option of options) {
    const key = videoModelFamilyKey(option.name);
    const bucket = byFamily.get(key);
    if (bucket) bucket.push(option);
    else byFamily.set(key, [option]);
  }
  const result: VideoModelOption[] = [];
  for (const group of byFamily.values()) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }
    const activated = group.find((model) => model.activated);
    if (activated) {
      result.push(activated);
      continue;
    }
    const cny = group.find((model) => (model.currency || 'CNY') === 'CNY');
    result.push(cny || group[0]);
  }
  return result;
}

export function formatHdValue(value: number, digits = 2) {
  if (!Number.isFinite(value)) return '0.00';
  return value.toFixed(digits);
}

export function deriveLinkedAudioMixConfig(params: Record<string, unknown>): LocalVideoAudioMixConfig | null {
  const linkedAudioSourceUrl = typeof params.linkedAudioSourceUrl === 'string' ? params.linkedAudioSourceUrl.trim() : '';
  if (!linkedAudioSourceUrl) return null;
  const linkedAudioMode = typeof params.linkedAudioMode === 'string' ? params.linkedAudioMode.trim() : '';
  const requestedMixMode = typeof params.linkedAudioMixMode === 'string' ? params.linkedAudioMixMode.trim() : '';
  const audioMixMode = (requestedMixMode || (
    linkedAudioMode === 'voiceover'
      ? 'voiceover-dub'
      : linkedAudioMode === 'bgm'
        ? 'bgm-under'
        : linkedAudioMode === 'sfx'
          ? 'bgm-under'
          : 'replace'
  )) as LocalVideoAudioMixConfig['audioMixMode'];
  const audioGain = clampNumber(
    params.linkedAudioGain,
    0,
    2,
    linkedAudioMode === 'voiceover' ? 1.15 : linkedAudioMode === 'bgm' ? 0.84 : 1,
  );
  const videoGain = clampNumber(
    params.linkedVideoGain,
    0,
    2,
    linkedAudioMode === 'voiceover' ? 0.3 : linkedAudioMode === 'bgm' ? 0.74 : 0.92,
  );
  return {
    linkedAudioSourceUrl,
    linkedAudioAssetId: typeof params.linkedAudioAssetId === 'string' ? params.linkedAudioAssetId : '',
    linkedAudioLabel: typeof params.linkedAudioLabel === 'string' ? params.linkedAudioLabel : '',
    linkedAudioMode,
    linkedAudioBackend: typeof params.linkedAudioBackend === 'string' ? params.linkedAudioBackend : '',
    audioMixMode,
    audioGain,
    videoGain,
  };
}

export function videoQualityCostMultiplier(quality: string) {
  switch (String(quality || '').toLowerCase()) {
    case '480p': return 1;
    case '720p': return 1.55;
    case '1080p': return 2.6;
    case '1440p': return 4.2;
    default: return 1.55;
  }
}

export function videoModelQualityCostMultiplier(model: VideoModelOption, quality: string) {
  const upstream = String(model.upstreamModel || model.id);
  if (model.provider === 'siliconflow' && upstream.includes('Wan2.2')) return 1;
  return videoQualityCostMultiplier(quality);
}

export function classifyFriendlyFailureReason(reason: string, category = '') {
  const normalized = String(reason || '').trim().toLowerCase();
  const normalizedCategory = String(category || '').trim().toLowerCase();

  if (!normalized && !normalizedCategory) {
    return { summary: '未知原因', detail: '系统没有返回更具体的失败说明。' };
  }

  if (
    normalized.includes('hmdao_real_api')
    || normalized.includes('real api')
    || normalized.includes('真实上游代理')
    || normalized.includes('真实生成')
    || normalized.includes('real-api-disabled')
  ) {
    return { summary: '真实链路未开启', detail: '当前 HMDao 后端没有启用真实上游代理，结果已回退为本地占位结果。请先以 HMDAO_REAL_API=1 重启后端。' };
  }

  if (
    normalized.includes('base url')
    || normalized.includes('missing-base-url')
    || normalized.includes('中转地址')
    || normalized.includes('上游地址')
  ) {
    return { summary: 'Base URL 缺失', detail: '当前 provider 没有可用的 Base URL 或中转地址，真实上游请求没有发出。' };
  }

  if (
    normalized.includes('balance is insufficient')
    || normalized.includes('insufficient balance')
    || normalized.includes('余额不足')
    || normalized.includes('quota exceeded')
  ) {
    return { summary: '余额不足', detail: '当前平台账户余额或额度不足，真实上游生成未完成。' };
  }

  if (
    normalizedCategory === 'auth'
    || normalized.includes('invalid api key')
    || normalized.includes('incorrect api key')
    || normalized.includes('unauthorized')
    || normalized.includes('authentication')
    || normalized.includes('forbidden')
    || normalized.includes('无权限')
    || normalized.includes('鉴权')
    || normalized.includes('api key')
  ) {
    return { summary: 'API Key 无效', detail: '当前平台的 API Key 无效、缺失或没有对应模型权限。' };
  }

  if (
    normalizedCategory === 'timeout'
    || normalized.includes('timed out')
    || normalized.includes('timeout')
    || normalized.includes('超时')
  ) {
    return { summary: '请求超时', detail: '真实上游在规定时间内没有返回结果。' };
  }

  if (
    normalizedCategory === 'routing'
    || normalized.includes('model not found')
    || normalized.includes('not found')
    || normalized.includes('does not exist')
    || normalized.includes('unavailable model')
    || normalized.includes('model is disabled')
    || normalized.includes('模型不可用')
    || normalized.includes('模型不存在')
  ) {
    return { summary: '模型不可用', detail: '当前选择的模型不可用、未开通，或该工具没有路由到可用模型。' };
  }

  if (
    normalized.includes('rate limit')
    || normalized.includes('too many requests')
    || normalized.includes('429')
    || normalized.includes('频率限制')
  ) {
    return { summary: '请求过于频繁', detail: '平台触发了频控或并发限制，请稍后重试。' };
  }

  if (normalizedCategory === 'upstream' || normalized.includes('upstream')) {
    return { summary: '上游服务异常', detail: '模型平台服务端异常，真实生成链路未成功完成。' };
  }

  if (normalizedCategory === 'validation') {
    return { summary: '参数配置无效', detail: '当前参数或工具配置不符合模型要求。' };
  }

  return {
    summary: '请求失败',
    detail: reason.trim() || '真实上游请求失败，但系统没有返回更明确的分类。',
  };
}

export function createGeneratedVideoDescriptor(
  name: string,
  url: string,
  size: number,
  width: number,
  height: number,
  duration: number,
  localTool: 'crop' | 'clip' | 'hd' | 'removeSubtitle' | 'audioSplit' | 'audioMix',
) {
  return {
    name,
    type: 'video' as const,
    url,
    thumbnail: url,
    folderId: 'root',
    size,
    width,
    height,
    duration,
    tags: [`local-${localTool}`],
    smartCategories: [],
    source: 'generate' as const,
  };
}

export function createGeneratedAudioDescriptor(
  name: string,
  url: string,
  size: number,
  duration: number,
  localTool: 'audioSplit',
  branchLabel = '音频',
) {
  return {
    name,
    type: 'audio' as const,
    url,
    thumbnail: '',
    folderId: 'root',
    size,
    duration,
    tags: [`local-${localTool}`],
    smartCategories: [branchLabel],
    source: 'generate' as const,
  };
}

export function createGeneratedImageDescriptor(
  name: string,
  url: string,
  size: number,
  width: number,
  height: number,
  tags: string[],
) {
  return {
    name,
    type: 'image' as const,
    url,
    thumbnail: url,
    folderId: 'root',
    size,
    width,
    height,
    tags,
    smartCategories: [],
    source: 'generate' as const,
  };
}

export function base64ToBlob(base64: string, mimeType: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

export function normalizeParsedStoryboardShots(
  analysis: Record<string, unknown>,
  videoMeta: VideoMeta | null,
): ParsedStoryboardShot[] {
  const parseRows = Array.isArray(analysis.parseRows)
    ? analysis.parseRows.filter((item) => item && typeof item === 'object') as Array<Record<string, unknown>>
    : [];
  if (parseRows.length > 0) {
    return parseRows.map((row, index) => ({
      id: String(row.id || `parsed-shot-${index + 1}`),
      shotNumber: Math.max(1, Number(row.shotNumber || index + 1)),
      startTime: Number(row.startTime || 0),
      endTime: Number(row.endTime || 0),
      duration: Number(row.duration || 0),
      frameDescription: String(row.frameDescription || ''),
      subjectCount: Number(row.subjectCount || 0),
      subjectSummary: String(row.subjectSummary || ''),
      subjectTraits: String(row.subjectTraits || ''),
      actionSummary: String(row.actionSummary || ''),
      sceneSetting: String(row.sceneSetting || ''),
      storyboardPurpose: String(row.storyboardPurpose || ''),
      lensSuggestion: String(row.lensSuggestion || ''),
      narrativeBeat: String(row.narrativeBeat || ''),
      sceneType: String(row.sceneType || ''),
      cameraAngle: String(row.cameraAngle || ''),
      cameraMovement: String(row.cameraMovement || ''),
      focusDepth: String(row.focusDepth || ''),
      lighting: String(row.lighting || ''),
      soundDesign: String(row.soundDesign || ''),
      cameraPrompt: String(row.cameraPrompt || ''),
      imagePrompt: String(row.imagePrompt || ''),
      keyframePrompt: String(row.keyframePrompt || ''),
      keyframeTime: Number(row.keyframeTime || 0),
      visualKeywords: Array.isArray(row.visualKeywords)
        ? row.visualKeywords.map((item) => String(item))
        : [],
      styleDescription: String(row.styleDescription || ''),
      lightingMood: String(row.lightingMood || ''),
      atmosphere: String(row.atmosphere || ''),
      subjectMotion: String(row.subjectMotion || ''),
      cameraMotionDetail: String(row.cameraMotionDetail || ''),
      compositionDetail: String(row.compositionDetail || ''),
      colorPalette: Array.isArray(row.colorPalette)
        ? row.colorPalette.map((item) => String(item))
        : [],
      keyframeImageBase64: String(row.keyframeImageBase64 || ''),
      keyframeMimeType: String(row.keyframeMimeType || ''),
      keyframeWidth: Number(row.keyframeWidth || 0),
      keyframeHeight: Number(row.keyframeHeight || 0),
      metrics: row.metrics && typeof row.metrics === 'object'
        ? Object.fromEntries(Object.entries(row.metrics).map(([key, value]) => [key, Number(value || 0)]))
        : undefined,
    }));
  }
  const sceneCuts = Array.isArray(analysis.sceneCuts)
    ? analysis.sceneCuts.map((item) => Number(item)).filter((item) => Number.isFinite(item) && item >= 0)
    : [];
  const sampleFps = Math.max(1, Number(analysis.sampleFps || 2));
  const totalDuration = Math.max(
    0.1,
    Number(analysis.duration || videoMeta?.duration || 0) || 0.1,
  );
  const suggestedShots = Array.isArray(analysis.suggestedShots)
    ? analysis.suggestedShots.filter((item) => item && typeof item === 'object') as Array<Record<string, unknown>>
    : [];
  const breakpoints = [0, ...sceneCuts.filter((item) => item > 0 && item < totalDuration), totalDuration]
    .sort((left, right) => left - right)
    .filter((item, index, list) => index === 0 || Math.abs(item - list[index - 1]) > 0.02);

  const sceneTypePool = ['近景', '中景', '全景'];
  const anglePool = ['平视', '低机位', '俯视', '三分之二侧面'];
  const movementPool = ['固定', '缓慢推近', '横移跟拍', '轻微环绕'];
  const depthPool = ['浅景深', '中景深', '深景深'];
  const lightingPool = ['柔光主照明', '高对比侧光', '冷暖混合氛围光', '轮廓逆光'];
  const soundPool = ['环境底噪与音乐铺垫', '动作节奏点强化', '空间氛围音延展', '情绪收束音效'];

  const shots: ParsedStoryboardShot[] = [];
  for (let index = 0; index < Math.max(1, breakpoints.length - 1); index += 1) {
    const startTime = Number(breakpoints[index].toFixed(3));
    const endTime = Number(Math.max(startTime + 0.08, breakpoints[index + 1] ?? totalDuration).toFixed(3));
    const duration = Number(Math.max(0.08, endTime - startTime).toFixed(3));
    const suggested = suggestedShots[index] || suggestedShots.find((item) => Number(item.time || 0) >= startTime && Number(item.time || 0) <= endTime) || null;
    const label = suggested ? String(suggested.label || `镜头 ${index + 1}`) : `镜头 ${index + 1}`;
    const sceneType = sceneTypePool[index % sceneTypePool.length];
    const cameraAngle = anglePool[index % anglePool.length];
    const cameraMovement = String(suggested?.cameraPrompt || movementPool[index % movementPool.length]).replace(/，[^，]*$/, '');
    const focusDepth = depthPool[index % depthPool.length];
    const lighting = lightingPool[index % lightingPool.length];
    const cameraPrompt = String(suggested?.cameraPrompt || `${movementPool[index % movementPool.length]}，${cameraAngle}，${sceneType}，保持主体与原构图稳定。`);
    const imagePrompt = String(suggested?.imagePrompt || `主体保持原构图不变，${sceneType}，${cameraAngle}，${focusDepth}，${lighting}，细节真实。`);
    const keyframePrompt = String(suggested?.keyframePrompt || `关键帧 ${index + 1}：保留主体姿态与画面重心，强化 ${lighting} 和 ${movementPool[index % movementPool.length]} 的视觉提示。`);
    shots.push({
      id: String(suggested?.id || `parsed-shot-${index + 1}`),
      shotNumber: index + 1,
      startTime,
      endTime,
      duration,
      frameDescription: `${label}：围绕当前片段主体，保留原有构图、运动方向与空间层次，抽样 ${sampleFps}fps 做本地镜头解析，并可直接转成画面提示词或关键帧。`,
      subjectCount: 0,
      subjectSummary: '未启用语义角色解析',
      subjectTraits: '建议接入本地多模态模型补充角色特征',
      actionSummary: '当前为基础镜头统计描述',
      sceneSetting: '当前为基础场景推断',
      storyboardPurpose: index === 0 ? '建立镜头' : '承接镜头',
      lensSuggestion: '建议结合本地多模态解析补充镜头建议',
      narrativeBeat: index === 0 ? '建立主体与空间关系。' : index === breakpoints.length - 2 ? '完成段落收束与情绪落点。' : '承接上一镜并推进当前动作与叙事。' ,
      sceneType,
      cameraAngle,
      cameraMovement,
      focusDepth,
      lighting,
      soundDesign: soundPool[index % soundPool.length],
      cameraPrompt,
      imagePrompt,
      keyframePrompt,
      keyframeTime: Number((startTime + duration * 0.5).toFixed(3)),
      visualKeywords: [sceneType, cameraAngle, cameraMovement, focusDepth, lighting],
    });
  }

  return shots;
}

export async function fileToDataUrl(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Failed to read local file.'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });
}

export function getVideoOutcomeLabel(data: Partial<NodeData> | undefined, currentParams: Record<string, unknown>) {
  const outputs = Array.isArray(data?.outputs) ? data.outputs : [];
  const firstOutput = outputs[0]?.metadata && typeof outputs[0].metadata === 'object'
    ? outputs[0].metadata as Record<string, unknown>
    : undefined;
  const localTool = String(firstOutput?.localTool || currentParams.localVideoEditTool || '').trim();
  const localDerivedNodeId = String(currentParams.localVideoDerivedNodeId || '').trim();
  const localDerivedTool = String(currentParams.localVideoDerivedTool || '').trim();
  const localDerivedLabel = String(currentParams.localVideoDerivedLabel || '').trim();
  const workflowFallback = Boolean(
    currentParams.workflowFallbackReason
      || firstOutput?.workflowFallback
      || firstOutput?.workflowFallbackReason
      || firstOutput?.fallback,
  );
  const fallbackReason = String(currentParams.workflowFallbackReason || firstOutput?.workflowFallbackReason || '').trim();
  const fallbackCategory = String(firstOutput?.fallbackCategory || firstOutput?.category || currentParams.lastErrorCategory || '').trim();
  const requestFailed = data?.status === 'error' || Boolean(currentParams.lastError || currentParams.lastErrorStage);
  const requestReason = String(currentParams.lastError || data?.error || '').trim();
  const requestCategory = String(currentParams.lastErrorCategory || '').trim();

  if (requestFailed) {
    const friendly = classifyFriendlyFailureReason(requestReason, requestCategory);
    return {
      tone: 'error' as const,
      label: `上游请求失败 · ${friendly.summary}`,
      reason: friendly.detail,
    };
  }

  if (workflowFallback || fallbackReason) {
    const friendly = classifyFriendlyFailureReason(fallbackReason, fallbackCategory);
    return {
      tone: 'warning' as const,
      label: `本地兜底结果 · ${friendly.summary}`,
      reason: friendly.detail,
    };
  }

  if (localDerivedNodeId && localDerivedTool === 'crop') {
    return {
      tone: 'success' as const,
      label: '已生成裁剪结果节点',
      reason: `${localDerivedLabel || '裁剪结果节点'}已创建，原视频素材保持不变，可继续在新节点上预览、生成或导出。`,
    };
  }

  if (localDerivedNodeId && localDerivedTool === 'clip') {
    return {
      tone: 'success' as const,
      label: '已生成剪辑结果节点',
      reason: `${localDerivedLabel || '剪辑结果节点'}已创建，原视频素材保持不变，可继续在新节点上预览、生成或导出。`,
    };
  }

  if (localDerivedNodeId && localDerivedTool === 'hd') {
    return {
      tone: 'success' as const,
      label: '已生成高清增强结果节点',
      reason: `${localDerivedLabel || '高清结果节点'}已创建，原视频素材保持不变，可继续在新节点上预览、生成或导出。`,
    };
  }

  if (localDerivedNodeId && localDerivedTool === 'removeSubtitle') {
    const engineLabel = String(currentParams.localVideoProcessingEngine || '').trim();
    return {
      tone: 'success' as const,
      label: '已生成去字幕结果节点',
      reason: `${localDerivedLabel || '去字幕结果节点'}已创建，原视频素材保持不变，可继续在新节点上预览、生成或导出。${engineLabel ? `当前引擎：${engineLabel}。` : ''}`,
    };
  }

  if (localDerivedNodeId && localDerivedTool === 'parse') {
    // 解析结果已完整承载在生成的解析分镜节点里，视频节点本体不再展示解析提示。
    return null;
  }

  if (localDerivedNodeId && localDerivedTool === 'audioSplit') {
    const engineLabel = String(currentParams.localVideoProcessingEngine || '').trim();
    return {
      tone: 'success' as const,
      label: '已生成音频分离结果节点',
      reason: `${localDerivedLabel || '音频分离结果节点'}已创建，原视频素材保持不变，同时完整音轨、人声和伴奏结果可继续在新节点中预览或下载。${engineLabel ? `当前引擎：${engineLabel}。` : ''}`,
    };
  }

  if (localTool === 'crop') {
    return {
      tone: 'success' as const,
      label: '本地裁剪已应用',
      reason: '裁剪已完成，原视频素材保持不变，结果已输出到新的结果节点。',
    };
  }

  if (localTool === 'clip') {
    return {
      tone: 'success' as const,
      label: '本地剪辑已应用',
      reason: '剪辑已完成，原视频素材保持不变，结果已输出到新的结果节点。',
    };
  }

  if (localTool === 'hd') {
    return {
      tone: 'success' as const,
      label: '本地高清增强已应用',
      reason: '高清增强已完成，原视频素材保持不变，结果已输出到新的结果节点。',
    };
  }

  if (localTool === 'removeSubtitle') {
    const engineLabel = String(currentParams.localVideoProcessingEngine || '').trim();
    return {
      tone: 'success' as const,
      label: '本地去字幕已应用',
      reason: `去字幕已完成，原视频素材保持不变，结果已输出到新的结果节点。${engineLabel ? `当前引擎：${engineLabel}。` : ''}`,
    };
  }

  if (localTool === 'audioSplit') {
    const engineLabel = String(currentParams.localVideoProcessingEngine || '').trim();
    return {
      tone: 'success' as const,
      label: '本地音频分离已应用',
      reason: `当前视频素材已完成本地音频分离，独立音频结果已写入素材库。${engineLabel ? `当前引擎：${engineLabel}。` : ''}`,
    };
  }

  if (String(currentParams.localVideoEditTool || '') === 'parse' && String(currentParams.localVideoAnalysisSummary || '').trim()) {
    // 解析摘要只在解析分镜节点上展示，视频节点保持原始状态。
    return null;
  }

  if (data?.status === 'completed' && data.videoUrl) {
    return null;
  }

  return null;
}

export function pickPromptAssistProvider(provider: string, apiKeys: Record<string, ProviderKeyState>) {
  if (PROMPT_ASSIST_PROVIDER_ORDER.includes(provider as typeof PROMPT_ASSIST_PROVIDER_ORDER[number]) && findProviderKeyState(apiKeys, provider)?.apiKey) {
    return provider;
  }
  const available = PROMPT_ASSIST_PROVIDER_ORDER.find((item) => Boolean(findProviderKeyState(apiKeys, item)?.apiKey));
  return available || 'deepseek';
}

export function workflowHandleStorage(value: string) {
  if (!value) return 'inline' as const;
  return isLocalMediaHandle(value) ? 'local-handle' as const : /^https?:\/\//i.test(value) ? 'remote-url' as const : 'inline' as const;
}
