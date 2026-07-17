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
    value: 'auto',
    label: '自动增强',
    hint: '默认优先走免费本地链路；检测到 CLIP Interrogator、Florence-2、Qwen wrapper 或云端模型后会自动升级。',
    group: 'free-local',
    tone: 'free',
    badge: '自动',
  },
  {
    value: 'local-heuristic',
    label: '本地轻量',
    hint: '纯本地启发式，速度最快，适合先看主体、风格和构图骨架。',
    group: 'free-local',
    tone: 'local',
    badge: '免费',
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
    value: 'florence2',
    label: 'Florence-2',
    hint: '擅长更稳的图像描述、主体识别和局部语义理解。',
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
    label: '云端多模态',
    hint: '使用已激活的聚合平台视觉模型做关键帧/视频语义解析，适合更强的提示词反推和镜头语义理解。',
    group: 'recommended-api',
    tone: 'relay',
    badge: 'API',
  },
  {
    value: 'auto',
    label: '自动',
    hint: '默认先用本地轻量语义，检测到更强模型或云端视觉链后自动切换。',
    group: 'free-local',
    tone: 'free',
    badge: '自动',
  },
  {
    value: 'local-heuristic',
    label: '本地轻量语义',
    hint: '基于本地规则和抽样帧做主体、动作、场景的基础描述。',
    group: 'free-local',
    tone: 'local',
    badge: '免费',
  },
  {
    value: 'clip-interrogator',
    label: 'CLIP Interrogator',
    hint: '先抽关键帧，再用图片反推模型补主体、风格、光影和提示词。',
    group: 'more-models',
    tone: 'local',
    badge: '关键帧',
  },
  {
    value: 'internvideo',
    label: 'InternVideo',
    hint: '更强地理解主体、动作关系和场景变化。',
    group: 'more-models',
    tone: 'recommended',
    badge: '视频',
  },
  {
    value: 'video-llava',
    label: 'Video-LLaVA',
    hint: '输出更丰富的画面语义、镜头语言和文本描述。',
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
  const runtimeLabel = runtimeAnalysisLabel(runtime?.selectedImageAnalysisRemote);
  const runtimeSummary = runtime?.recommendations?.videoAnalysis;
  return VIDEO_SEMANTIC_BASE_OPTIONS.map((option) => (
    option.value === 'custom-api'
      ? {
          ...option,
          label: runtimeLabel ? '云端多模态（已激活）' : option.label,
          hint: runtimeLabel
            ? `当前将优先走 ${runtimeLabel} 做关键帧/视频语义解析。${runtimeSummary?.summary ? ` ${runtimeSummary.summary}` : ''}`
            : `${option.hint} 若暂未激活云端模型，会自动回退到本地语义链路。`,
          runtimeBadge: runtimeLabel ? `via ${runtimeLabel}` : null,
        }
      : option
  ));
}

export function findAnalysisEngineOption(options: readonly AnalysisEngineOption[], value: string) {
  return options.find((option) => option.value === value) || options[0];
}
