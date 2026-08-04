// Shared types, constants and pure helpers extracted from ImageNode.tsx.
// Moved verbatim — no behavior change.
import { relaySourceLabel } from '@/components/SourceBadge';
import {
  IMAGE_TOOL_PRESETS,
  getImageToolPreset,
  type ImageGenerationTool,
} from '@/config/imageToolPresets';
import {
  collectConnectedReferenceInputs,
  type ConnectedReferenceInput,
  type ReferenceRole,
  type ReferenceRoleOption,
  type ReferenceSettingsValue,
} from '@/lib/nodeReferenceGraph';
import { buildImageModelCapabilityRequirements } from '@/services/workflowGraph';
import { findProviderKeyState, isUnusableProviderKeyStatus, providerKeyMatchesModel, type ProviderKeyState } from '@/store/useApiKeyStore';
import type { MediaInput, ModelCapabilityMatrix, NodeData } from '@/types';

export function stopCanvasInteraction(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

export function pushImageSubmitTrace(stage: string, detail?: Record<string, unknown>) {
  if (typeof window === 'undefined') return;
  const target = window as typeof window & {
    __HMDAO_IMAGE_SUBMIT_TRACE__?: Array<Record<string, unknown>>;
  };
  const entries = Array.isArray(target.__HMDAO_IMAGE_SUBMIT_TRACE__)
    ? target.__HMDAO_IMAGE_SUBMIT_TRACE__
    : [];
  entries.push({
    stage,
    at: Date.now(),
    ...(detail || {}),
  });
  target.__HMDAO_IMAGE_SUBMIT_TRACE__ = entries.slice(-120);
}

export function hasUsableProviderKey(keyState: Pick<ProviderKeyState, 'status' | 'apiKey' | 'metadataOnly'> | undefined) {
  // 任务 AL：invalid 与 expired 同为不可用（统一判定，避免语义散落）。
  // 任务 AN：参数收窄为 Pick<ProviderKeyState,...>，让 status 受 ProviderKeyStatus 联合类型约束，
  // 未来新增状态时编译期即可发现遗漏，消除此前的 string 绕过。
  return Boolean(keyState && !isUnusableProviderKeyStatus(keyState.status) && (keyState.apiKey || keyState.metadataOnly));
}

export type ImageTool = ImageGenerationTool | 'brush' | 'bgRemove' | 'compare';

export const TOOL_PANEL_TOOLS = new Set<ImageTool>(['panorama', 'multiAngle', 'lighting', 'grid', 'hd', 'split', 'camera', 'brush', 'bgRemove']);

export function hasToolPanel(tool: ImageTool | null): boolean {
  return tool !== null && TOOL_PANEL_TOOLS.has(tool);
}

export function isImageGenerationTool(tool: ImageTool | null): tool is ImageGenerationTool {
  return tool === 'panorama' || tool === 'multiAngle' || tool === 'lighting' || tool === 'grid' || tool === 'hd' || tool === 'split' || tool === 'camera';
}

export function modelMatchesLocalKey(
  model: { id: string; name: string; provider: string; upstreamModel?: string },
  keyState: ProviderKeyState | undefined,
  mode: 'image' | 'video',
) {
  return Boolean(
    keyState
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
): ConnectedReferenceInput {
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

export interface ImageModelOption {
  id: string;
  name: string;
  description: string;
  latency: string;
  provider: string;
  providerLabel: string;
  upstreamModel: string;
  price: number;
  currency: string;
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

export function imageModelActivationSourceLabel(model: Pick<ImageModelOption, 'activationRelaySource' | 'activated'>) {
  if (!model.activated || !model.activationRelaySource) return null;
  return relaySourceLabel(model.activationRelaySource);
}

export interface ImageMeta {
  width: number;
  height: number;
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

export const FALLBACK_MODELS: ImageModelOption[] = [
  { id: 'flux-pro', name: 'FLUX Pro', description: '强编辑约束，适合保构图换主体与多参考融合', latency: '20s', provider: 'fal', providerLabel: 'fal.ai', upstreamModel: 'fal-ai/flux-pro/v1', price: 0.38, currency: 'CNY' },
  { id: 'gpt-image-2', name: 'GPT Image 2', description: '编辑型图片模型，适合主体替换与构图保持', latency: '16s', provider: 'openai', providerLabel: '官方直连 / 中转兼容', upstreamModel: 'gpt-image-2', price: 0.48, currency: 'USD' },
  { id: 'doubao-seedream-5-0-lite', name: 'Seedream 5.0 Lite', description: '高质感商品图与品牌场景图，适合多参考控制', latency: '18s', provider: 'volcengine', providerLabel: '火山引擎', upstreamModel: 'doubao-seedream-5.0-lite', price: 0.36, currency: 'CNY' },
  { id: 'lib-image', name: 'Qwen 图片', description: '通用多参考图片生成，适合先跑通中文链路', latency: '12s', provider: 'siliconflow', providerLabel: '硅基流动', upstreamModel: 'Qwen/Qwen-Image', price: 0.28, currency: 'CNY' },
  { id: 'grok-imagine-1.5-edit-apimart', name: 'Grok Imagine 1.5 Edit', description: '适合复杂编辑指令和多模态改图场景', latency: '18s', provider: 'openai', providerLabel: '中转兼容', upstreamModel: 'grok-imagine-1.5-edit-apimart', price: 0.52, currency: 'USD' },
  { id: 'gemini-3-pro-image-preview', name: 'Gemini 3 Pro Image Preview', description: '适合多模态预览、结构理解和方案草验', latency: '15s', provider: 'openai', providerLabel: '中转兼容', upstreamModel: 'gemini-3-pro-image-preview', price: 0.32, currency: 'USD' },
  { id: 'wanx-v1', name: '通义万相', description: '中文图片生成可用，但不建议承担严格构图锁定任务', latency: '15s', provider: 'bailian', providerLabel: '阿里云百炼', upstreamModel: 'wanx-v1', price: 0.30, currency: 'CNY' },
];

export const IMAGE_RESOLUTION_PRESETS = [
  { key: 'square-1024', label: '1:1 · 1024', width: 1024, height: 1024, aspectRatio: '1:1' },
  { key: 'portrait-1024', label: '9:16 · 1024', width: 1024, height: 1792, aspectRatio: '9:16' },
  { key: 'landscape-720p', label: '16:9 · 720p', width: 1280, height: 720, aspectRatio: '16:9' },
  { key: 'landscape-1024', label: '16:9 · 1024', width: 1792, height: 1024, aspectRatio: '16:9' },
  { key: 'landscape-2k', label: '16:9 · 2K', width: 2048, height: 1152, aspectRatio: '16:9' },
  { key: 'square-2k', label: '1:1 · 2K', width: 2048, height: 2048, aspectRatio: '1:1' },
] as const;

export const OUTPUT_COUNT_OPTIONS = [1, 2, 3, 4] as const;
export const PROMPT_ASSIST_PROVIDER_ORDER = ['siliconflow', 'deepseek', 'openai', 'bailian', 'zhipu', 'modelscope', 'minimax'] as const;
export function clampCount(value: unknown, fallback = 1) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(1, Math.min(4, Math.round(next)));
}

export function clampDimension(value: unknown, fallback: number) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(256, Math.min(4096, Math.round(next)));
}

export function parseLatencySeconds(value: string) {
  const match = String(value || '').trim().toLowerCase().match(/(\d+(?:\.\d+)?)s/);
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

export function formatImageCapabilityPreview(
  requirements: ReturnType<typeof buildImageModelCapabilityRequirements>,
  intent: string,
) {
  const roles = Array.from(new Set(
    requirements
      .filter((item) => item.key === 'referenceRole')
      .map((item) => String(item.value || '').trim())
      .filter(Boolean),
  ));
  const toolOperation = requirements.find((item) => item.key === 'toolOperation');
  return [
    `任务 ${intent}`,
    toolOperation?.value ? `工具 ${String(toolOperation.value)}` : '',
    roles.length ? `参考 ${roles.join(' / ')}` : '参考 无',
    requirements.some((item) => item.key === 'supportsIdentityController') ? '身份锁定' : '',
  ].filter(Boolean).join(' · ');
}

export function imageRoutingHintText(model: Pick<ImageModelOption, 'id' | 'name' | 'provider' | 'upstreamModel' | 'description' | 'capabilities'>) {
  return [
    model.id,
    model.name,
    model.provider,
    model.upstreamModel,
    model.description,
    Array.isArray(model.capabilities?.bestFor) ? model.capabilities.bestFor.join(' ') : '',
    Array.isArray(model.capabilities?.limitations) ? model.capabilities.limitations.join(' ') : '',
  ].join(' ').toLowerCase();
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
    return { summary: '真实链路未开启', detail: '当前 HMDao 后端没有启用真实上游代理，结果已回退为本地占位图。请先以 HMDAO_REAL_API=1 重启后端。' };
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

export function getImageOutcomeLabel(data: Partial<NodeData> | undefined, currentParams: Record<string, unknown>) {
  const outputs = Array.isArray(data?.outputs) ? data.outputs : [];
  const firstOutput = outputs[0]?.metadata && typeof outputs[0].metadata === 'object'
    ? outputs[0].metadata as Record<string, unknown>
    : undefined;
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

  if (data?.status === 'completed' && data.imageUrl) {
    return {
      tone: 'success' as const,
      label: '真实模型出图',
      reason: '当前结果来自真实生成链路。',
    };
  }

  return null;
}

export function readResolutionConfig(params: Record<string, unknown>, fallbackAspectRatio: string) {
  const raw = params.resolution;
  if (raw && typeof raw === 'object') {
    const width = clampDimension((raw as Record<string, unknown>).width, 1024);
    const height = clampDimension((raw as Record<string, unknown>).height, 1024);
    const label = String((raw as Record<string, unknown>).label || `${width}x${height}`);
    return { width, height, label, aspectRatio: reduceAspectRatio(width, height) };
  }
  const preset = IMAGE_RESOLUTION_PRESETS.find((item) => item.aspectRatio === fallbackAspectRatio)
    || IMAGE_RESOLUTION_PRESETS.find((item) => item.aspectRatio === '16:9')
    || IMAGE_RESOLUTION_PRESETS[0];
  return { width: preset.width, height: preset.height, label: preset.label, aspectRatio: preset.aspectRatio };
}

export function gcd(a: number, b: number): number {
  let x = Math.round(Math.abs(a));
  let y = Math.round(Math.abs(b));
  while (y) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1;
}

export function reduceAspectRatio(width: number, height: number) {
  const divisor = gcd(width, height);
  return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
}

export function downloadTextFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function pickPromptAssistProvider(provider: string, apiKeys: Record<string, ProviderKeyState>) {
  if (PROMPT_ASSIST_PROVIDER_ORDER.includes(provider as typeof PROMPT_ASSIST_PROVIDER_ORDER[number]) && findProviderKeyState(apiKeys, provider)?.apiKey) {
    return provider;
  }
  const available = PROMPT_ASSIST_PROVIDER_ORDER.find((item) => Boolean(findProviderKeyState(apiKeys, item)?.apiKey));
  return available || 'siliconflow';
}

export const TOOL_LABELS: Record<ImageTool, string> = {
  panorama: IMAGE_TOOL_PRESETS.panorama.label,
  multiAngle: IMAGE_TOOL_PRESETS.multiAngle.label,
  lighting: IMAGE_TOOL_PRESETS.lighting.label,
  grid: IMAGE_TOOL_PRESETS.grid.label,
  hd: IMAGE_TOOL_PRESETS.hd.label,
  split: IMAGE_TOOL_PRESETS.split.label,
  camera: IMAGE_TOOL_PRESETS.camera.label,
  brush: '局部编辑',
  bgRemove: '智能去背',
  compare: '对比',
};

export function buildImageToolParams(tool: ImageTool | null, currentParams: Record<string, unknown>) {
  const nextToolConfig = currentParams.toolConfig && typeof currentParams.toolConfig === 'object'
    ? (currentParams.toolConfig as Record<string, unknown>)
    : undefined;
  const preset = getImageToolPreset(tool);
  const wasHdTool = currentParams.imageTool === 'hd' && currentParams.quality === 'hd';
  const hdMode = String(nextToolConfig?.hdMode || currentParams.hdMode || 'upscale');
  const toolOperation = preset
    ? tool === 'hd'
      ? preset.variantOperations?.[hdMode] || preset.operation
      : preset.operation
    : undefined;

  return {
    imageTool: tool,
    toolOperation,
    toolCapability: preset?.capability,
    toolConfig: preset ? { ...preset.defaultParams, ...(nextToolConfig || {}) } : undefined,
    toolPromptInstruction: preset?.promptInstruction,
    panorama: tool === 'panorama',
    multiAngle: tool === 'multiAngle',
    lighting: tool === 'lighting',
    cameraControl: tool === 'camera',
    grid: tool === 'grid' ? '3x3' : undefined,
    split: tool === 'split' ? 'grid' : undefined,
    quality: tool === 'hd' ? 'hd' : wasHdTool ? 'standard' : currentParams.quality,
  };
}

