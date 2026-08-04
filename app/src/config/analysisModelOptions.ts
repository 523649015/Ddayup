import type { ByokRuntimeResult } from '@/api/byok';

export type AnalysisEngineGroupKey = 'recommended-api' | 'free-local' | 'more-models';

export interface AnalysisEngineOption {
  value: string;
  label: string;
  hint: string;
  group: AnalysisEngineGroupKey;
  tone: 'relay' | 'free' | 'local' | 'api' | 'recommended' | 'neutral';
  badge?: string | null;
  runtimeBadge?: string | null;
}

export const ANALYSIS_ENGINE_GROUPS: Array<{
  key: AnalysisEngineGroupKey;
  label: string;
  hint: string;
}> = [
  {
    key: 'recommended-api',
    label: '推荐 API',
    hint: '优先显示已激活的聚合平台或云端多模态模型，适合高质量解析与反推。',
  },
  {
    key: 'free-local',
    label: '免费 / 本地',
    hint: '不依赖 Key，可先在本机跑通基础解析和轻量反推。',
  },
  {
    key: 'more-models',
    label: '更多模型',
    hint: '保留扩展槽位，方便后续切换更强的专业模型或兼容旧链路。',
  },
];

const IMAGE_ANALYSIS_BASE_OPTIONS: AnalysisEngineOption[] = [
  {
    value: 'custom-api',
    label: '云端多模态',
    hint: '走已激活的 API / 聚合平台视觉模型，适合更强的主体、风格、光影和构图反推。',
    group: 'recommended-api',
    tone: 'relay',
    badge: 'API',
  },
  {
    value: 'prompt-fusion',
    label: '融合反推',
    hint: '融合 CLIP Interrogator + Florence-2 / Qwen 视觉链，优先保证主体、风格、光影、构图与中文提示词更贴图。',
    group: 'recommended-api',
    tone: 'recommended',
    badge: '推荐',
  },
  {
    value: 'qwen37-vl',
    label: 'Qwen3.7-VL（云端付费）',
    hint: '阿里通义 Qwen3.7-VL 最新多模态视觉理解，最强解析与反推质量（付费方案，需已激活云端提供商）。',
    group: 'recommended-api',
    tone: 'api',
    badge: '付费',
  },
  {
    value: 'auto',
    label: '自动增强',
    hint: '默认优先走本地 Florence-2 免费视觉模型；检测到 CLIP Interrogator、Qwen wrapper 或云端模型后会自动升级。',
    group: 'free-local',
    tone: 'free',
    badge: '自动',
  },
  {
    value: 'florence2',
    label: 'Florence-2（本地免费）',
    hint: '微软开源本地视觉模型（Florence-2-large），擅长图像描述、主体识别与局部语义理解；零远程 Token，安装即可用，替代旧的占位兜底。',
    group: 'free-local',
    tone: 'recommended',
    badge: '本地免费',
  },
  {
    value: 'clip-interrogator',
    label: 'CLIP Interrogator',
    hint: '更适合反推 AI 绘画提示词，可提取主体、风格、光影、构图和氛围。',
    group: 'more-models',
    tone: 'local',
    badge: '本地',
  },
  {
    value: 'qwen35-vl',
    label: 'Qwen 视觉链',
    hint: '兼容 Qwen3.x / Qwen2.5-VL / Qwen2.5-Omni 等视觉模型，适合复杂场景、中文提示词整理和镜头语义组织。',
    group: 'more-models',
    tone: 'api',
    badge: '多模态',
  },
  {
    value: 'qwen25-vl',
    label: 'Qwen2.5-VL（旧兼容）',
    hint: '保留旧工程兼容；新项目更建议改用上面的 Qwen 视觉链槽位。',
    group: 'more-models',
    tone: 'neutral',
    badge: '兼容',
  },
];

const VIDEO_SEMANTIC_BASE_OPTIONS: AnalysisEngineOption[] = [
  {
    value: 'custom-api',
    label: '国内多模态优先',
    hint: '优先走已激活的聚合平台视频视觉模型（智谱 GLM-4V / 阿里 Qwen-VL / 字节豆包视觉 / 腾讯混元视觉等），最适合详细分析运镜、主体、风格与镜头语言。',
    group: 'recommended-api',
    tone: 'relay',
    badge: '国内',
  },
  {
    value: 'qwen35-vl',
    label: '阿里 Qwen3-VL',
    hint: '阿里最新一代视觉大模型（Qwen3-VL 系列），原生支持视频理解，擅长运镜、主体、风格与中文镜头语言分析。',
    group: 'recommended-api',
    tone: 'api',
    badge: '国内',
  },
  {
    value: 'auto',
    label: '自动',
    hint: '默认先用本地视频语义模型（InternVideo / Video-LLaVA），检测到云端视觉链后自动升级。',
    group: 'free-local',
    tone: 'free',
    badge: '自动',
  },
  {
    value: 'internvideo',
    label: 'InternVideo',
    hint: '视频理解专用模型，更强地理解主体、动作关系和场景变化（本地免费）。',
    group: 'more-models',
    tone: 'recommended',
    badge: '视频',
  },
  {
    value: 'video-llava',
    label: 'Video-LLaVA',
    hint: '输出丰富的画面语义、镜头语言和文本描述（本地免费）。',
    group: 'more-models',
    tone: 'recommended',
    badge: '视频',
  },
];

function runtimeAnalysisLabel(runtime?: ByokRuntimeResult['selectedImageAnalysisRemote'] | null) {
  if (!runtime) return null;
  const provider = String(runtime.provider || '').trim();
  const model = String(runtime.model || '').trim();
  return [provider, model].filter(Boolean).join(' / ') || null;
}

const VIDEO_CAPABLE_MODEL_PATTERNS = [
  /gemini[\/\-_ ]?(?:3|2\.5)?(?:\.1)?[\/\-_ ]?(?:pro|flash)?/i,
  /qwen[\/\-_ ]?(?:3|2\.5)?[\/\-_ ]?vl/i,
  /qwen[\/\-_ ]?(?:3|2\.5)?[\/\-_ ]?omni/i,
  /qwen[\/\-_ ]?vl[\/\-_ ]?max/i,
  /qwen[\/\-_ ]?(?:3|2\.\d)?[\/\-_ ]?(?:vl|vision)/i,
  /glm[\/\-_ ]?4[\/\-_ ]?v/i,
  /glm[\/\-_ ]?v[\/\-_ ]?plus/i,
  /internvl[\/\-_ ]?3/i,
  /doubao[\/\-_ ]?vision/i,
  /hunyuan[\/\-_ ]?(?:vision|vl|turbos)/i,
  /internvideo/i,
  /video[\/\-_ ]?llava/i,
  /abab.*v/i,
  /deepseek[\/\-_ ]?vl/i,
];

function isVideoCapableModel(identifier: string): boolean {
  const normalized = String(identifier || '').trim();
  if (!normalized) return false;
  return VIDEO_CAPABLE_MODEL_PATTERNS.some((pattern) => pattern.test(normalized));
}

function runtimeHasVideoCapability(runtime?: ByokRuntimeResult | null): boolean {
  if (!runtime) return false;
  const activated = Array.isArray(runtime.activatedProviders) ? runtime.activatedProviders : [];
  for (const record of activated) {
    if (String(record?.mode || '').trim().toLowerCase() === 'video') return true;
    const available = Array.isArray(record?.availableModels) ? record.availableModels : [];
    for (const model of available) {
      if (String(model?.mode || '').trim().toLowerCase() === 'video') return true;
      if (isVideoCapableModel(String(model?.id || model?.name || ''))) return true;
    }
    if (isVideoCapableModel(String(record?.model || ''))) return true;
  }
  const remoteModel = String(runtime.selectedImageAnalysisRemote?.model || '').trim();
  if (isVideoCapableModel(remoteModel)) return true;
  return false;
}

export function getImageAnalysisEngineOptions(runtime?: ByokRuntimeResult | null) {
  const runtimeLabel = runtimeAnalysisLabel(runtime?.selectedImageAnalysisRemote);
  const runtimeSummary = runtime?.recommendations?.imageAnalysis;
  return IMAGE_ANALYSIS_BASE_OPTIONS.map((option) => (
    option.value === 'custom-api'
      ? {
          ...option,
          label: runtimeLabel ? '云端多模态（已激活）' : option.label,
          hint: runtimeLabel
            ? `当前将优先走 ${runtimeLabel} 做图片解析与提示词反推。${runtimeSummary?.summary ? ` ${runtimeSummary.summary}` : ''}`
            : `${option.hint} 若暂未激活云端模型，会自动回退到本地轻量链路。`,
          runtimeBadge: runtimeLabel ? `via ${runtimeLabel}` : null,
        }
      : option
  ));
}

export function getVideoSemanticEngineOptions(runtime?: ByokRuntimeResult | null) {
  const videoCapable = runtimeHasVideoCapability(runtime);
  const runtimeLabel = videoCapable ? runtimeAnalysisLabel(runtime?.selectedImageAnalysisRemote) : null;
  const runtimeSummary = runtime?.recommendations?.videoAnalysis;
  return VIDEO_SEMANTIC_BASE_OPTIONS.map((option) => (
    option.value === 'custom-api'
      ? {
          ...option,
          label: runtimeLabel ? '云端多模态（已激活）' : option.label,
          hint: runtimeLabel
            ? `当前将优先走 ${runtimeLabel} 做关键帧/视频语义解析。${runtimeSummary?.summary ? ` ${runtimeSummary.summary}` : ''}`
            : `${option.hint} 若暂未激活视频语义模型，会自动回退到本地语义链路。`,
          runtimeBadge: runtimeLabel ? `via ${runtimeLabel}` : null,
        }
      : option
  ));
}

export function findAnalysisEngineOption(options: readonly AnalysisEngineOption[], value: string) {
  return options.find((option) => option.value === value) || options[0];
}
