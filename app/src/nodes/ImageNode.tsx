import { useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useCallback } from 'react';
import {
  Camera,
  ChevronDown,
  Download,
  Expand,
  FolderOpen,
  Grid3x3,
  Image,
  ImageDown,
  KeyRound,
  Languages,
  Lightbulb,
  Loader2,
  Maximize2,
  RotateCcw,
  Scissors,
  Send,
  Shapes,
  Sparkles,
  SquareSplitHorizontal,
  Type,
  Upload,
  Wand2,
  Zap,
} from 'lucide-react';
import type { ByokRuntimeRecommendationSummary, ByokRuntimeResult } from '@/api/byok';
import type { CatalogModel } from '@/api/models';
import { NodeModelBrowser } from '@/components/NodeModelBrowser';
import { SourceBadge, relaySourceLabel } from '@/components/SourceBadge';
import { ModelActivationPrompt } from '@/components/ModelActivationPrompt';
import { ImageToolPanelHost } from '@/components/image-tools/ImageToolPanelHost';
import { PostComparePreview } from '@/components/post/PostComparePreview';
import { PosterLayoutPanel, PosterOverlay } from '@/nodes/image/poster/components';
import type { PosterLayoutConfig } from '@/nodes/image/poster/types';
import { DEFAULT_POSTER_LAYOUT } from '@/nodes/image/poster/types';
import {
  buildPosterSafePrompt,
  buildPosterSvgWithEditor,
  createFreshPosterLayoutForGeneration,
  mergePosterLayoutPatch,
  normalizePosterEditorState,
  readPosterLayoutConfig,
} from '@/nodes/image/poster/utils';
import { commitPosterToLibrary } from '@/services/posterRaster';
import { removeImageBackground, LocalModelError } from '@/services/imageModelRouting';
import { ImageLightbox } from '@/components/ImageLightbox';
import { applyBrushEdit, BrushEditError } from '@/services/imageBrush';
import { resolveProviderGuideId } from '@/config/providerGuides';
import { IMAGE_TOOL_ORDER, IMAGE_TOOL_PRESETS, getImageToolPreset, type ImageGenerationTool } from '@/config/imageToolPresets';
import { useGuardedFloatingPanelInteraction, type GuardedPanelInteractionProps } from '@/hooks/useGuardedFloatingPanelInteraction';
import { useLocalTranslateProgress } from '@/hooks/useLocalTranslateProgress';
import { useNodeFloatingPanel } from '@/hooks/useNodeFloatingPanel';
import { useUILanguage } from '@/i18n/ui';
import {
  classifyRenderableAssetIssue,
  describeGenerationError,
  generateNodeOutput,
  GenerationError,
  probeRenderableAssetIssue,
  resolveImageToolModel,
  resolveGenerationAccess,
  toRenderableAssetUrl,
  type RenderableAssetIssue,
  type GenerationAccess,
} from '@/services/generation';
import {
  buildImageModelCapabilityRequirements,
  buildNodeWorkflowGraph,
  evaluateModelCapabilitySupport,
  readIdentityControllerConfig,
} from '@/services/workflowGraph';
import {
  buildRegionCapabilityRequirements,
  buildRegionContractMediaInputs,
  buildRegionContractPrompt,
  collectConnectedRegionContracts,
  readRegionContract,
} from '@/services/regionContracts';
import { buildVerboseRegionContractNotice } from '@/services/regionContractNotice';
import { ensureLocalMediaUrl, isLocalMediaHandle, isTransientBlobUrl, registerLocalMedia, revokeLocalMedia } from '@/services/localMediaRegistry';
import { enqueueLocalAssetPersistence } from '@/services/localAssetPersistenceQueue';
import {
  type ConnectedReferenceInput,
  collectConnectedReferenceInputs,
  type ReferenceRoleOption,
  type ReferenceSettingsValue,
  summarizeReferenceInputs,
  type ReferenceRole,
} from '@/lib/nodeReferenceGraph';
import { getDirectRecommendationCards } from '@/utils/directProviderRecommendationCards';
import { findRecommendationTask, summaryToRecommendationCard, taskToRecommendationCard } from '@/utils/runtimeRecommendationCards';
import { assistPrompt, type PromptAssistAction } from '@/services/promptAssist';
import { findProviderKeyState, providerKeyMatchesModel, useApiKeyStore, type ProviderKeyState } from '@/store/useApiKeyStore';
import { useAssetStore } from '@/store/useAssetStore';
import { useAuthStore } from '@/store/useAuthStore';
import { useBackendHealthStore } from '@/store/useBackendHealthStore';
import { useByokRuntimeStore } from '@/store/useByokRuntimeStore';
import { useCanvasStore } from '@/store/useCanvasStore';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import type { IdentityControllerConfig, MediaInput, ModelCapabilityMatrix, NodeData } from '@/types';
import type { AssetItem } from '@/types/assets';
import { EditableNodeTitle } from './EditableNodeTitle';
import { ErrorDetailBlock, GeneratingSkeleton, ProgressBadge, StatusBadge } from './NodeShellShared';

function stopCanvasInteraction(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

function pushImageSubmitTrace(stage: string, detail?: Record<string, unknown>) {
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

function hasUsableProviderKey(keyState: { status: string; apiKey?: string; metadataOnly?: boolean } | undefined) {
  return Boolean(keyState && keyState.status !== 'expired' && (keyState.apiKey || keyState.metadataOnly));
}

type ImageTool = ImageGenerationTool | 'brush' | 'bgRemove' | 'compare';

const TOOL_PANEL_TOOLS = new Set<ImageTool>(['panorama', 'multiAngle', 'lighting', 'grid', 'hd', 'split', 'camera', 'brush', 'bgRemove']);

function hasToolPanel(tool: ImageTool | null): boolean {
  return tool !== null && TOOL_PANEL_TOOLS.has(tool);
}

function isImageGenerationTool(tool: ImageTool | null): tool is ImageGenerationTool {
  return tool === 'panorama' || tool === 'multiAngle' || tool === 'lighting' || tool === 'grid' || tool === 'hd' || tool === 'split' || tool === 'camera';
}

function modelMatchesLocalKey(
  model: { id: string; name: string; provider: string; upstreamModel?: string },
  keyState: ProviderKeyState | undefined,
  mode: 'image' | 'video',
) {
  return Boolean(
    keyState
    && keyState.status !== 'expired'
    && keyState.mode === mode
    && (keyState.apiKey || keyState.metadataOnly)
    && providerKeyMatchesModel(keyState, model.upstreamModel || model.id, { allowProviderOnlyFallback: false }),
  );
}

const CONTRACT_IMAGE_ROLE_OPTIONS: ReferenceRoleOption[] = [
  { value: 'subject', label: '主体参考' },
  { value: 'element', label: '元素参考' },
  { value: 'style', label: '风格参考' },
  { value: 'composition', label: '构图参考' },
  { value: 'lighting', label: '光影参考' },
  { value: 'omni', label: '全能参考' },
];

const CONTRACT_VIDEO_ROLE_OPTIONS: ReferenceRoleOption[] = [
  { value: 'motion', label: '运镜参考' },
  { value: 'rhythm', label: '节奏参考' },
  { value: 'style', label: '风格参考' },
  { value: 'omni', label: '全能参考' },
];

function normalizeContractReferenceRole(value: unknown, fallback: ReferenceRole): ReferenceRole {
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

function buildContractConnectedInput(
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

interface ImageModelOption {
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

function imageModelActivationSourceLabel(model: Pick<ImageModelOption, 'activationRelaySource' | 'activated'>) {
  if (!model.activated || !model.activationRelaySource) return null;
  return relaySourceLabel(model.activationRelaySource);
}

interface ImageMeta {
  width: number;
  height: number;
}

interface WindowWithPicker extends Window {
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

const FALLBACK_MODELS: ImageModelOption[] = [
  { id: 'flux-pro', name: 'FLUX Pro', description: '强编辑约束，适合保构图换主体与多参考融合', latency: '20s', provider: 'fal', providerLabel: 'fal.ai', upstreamModel: 'fal-ai/flux-pro/v1', price: 0.38, currency: 'CNY' },
  { id: 'gpt-image-2', name: 'GPT Image 2', description: '编辑型图片模型，适合主体替换与构图保持', latency: '16s', provider: 'openai', providerLabel: '官方直连 / 中转兼容', upstreamModel: 'gpt-image-2', price: 0.48, currency: 'USD' },
  { id: 'doubao-seedream-5-0-lite', name: 'Seedream 5.0 Lite', description: '高质感商品图与品牌场景图，适合多参考控制', latency: '18s', provider: 'volcengine', providerLabel: '火山引擎', upstreamModel: 'doubao-seedream-5.0-lite', price: 0.36, currency: 'CNY' },
  { id: 'lib-image', name: 'Qwen 图片', description: '通用多参考图片生成，适合先跑通中文链路', latency: '12s', provider: 'siliconflow', providerLabel: '硅基流动', upstreamModel: 'Qwen/Qwen-Image', price: 0.28, currency: 'CNY' },
  { id: 'grok-imagine-1.5-edit-apimart', name: 'Grok Imagine 1.5 Edit', description: '适合复杂编辑指令和多模态改图场景', latency: '18s', provider: 'openai', providerLabel: '中转兼容', upstreamModel: 'grok-imagine-1.5-edit-apimart', price: 0.52, currency: 'USD' },
  { id: 'gemini-3-pro-image-preview', name: 'Gemini 3 Pro Image Preview', description: '适合多模态预览、结构理解和方案草验', latency: '15s', provider: 'openai', providerLabel: '中转兼容', upstreamModel: 'gemini-3-pro-image-preview', price: 0.32, currency: 'USD' },
  { id: 'wanx-v1', name: '通义万相', description: '中文图片生成可用，但不建议承担严格构图锁定任务', latency: '15s', provider: 'bailian', providerLabel: '阿里云百炼', upstreamModel: 'wanx-v1', price: 0.30, currency: 'CNY' },
];

const IMAGE_RESOLUTION_PRESETS = [
  { key: 'square-1024', label: '1:1 · 1024', width: 1024, height: 1024, aspectRatio: '1:1' },
  { key: 'portrait-1024', label: '9:16 · 1024', width: 1024, height: 1792, aspectRatio: '9:16' },
  { key: 'landscape-720p', label: '16:9 · 720p', width: 1280, height: 720, aspectRatio: '16:9' },
  { key: 'landscape-1024', label: '16:9 · 1024', width: 1792, height: 1024, aspectRatio: '16:9' },
  { key: 'landscape-2k', label: '16:9 · 2K', width: 2048, height: 1152, aspectRatio: '16:9' },
  { key: 'square-2k', label: '1:1 · 2K', width: 2048, height: 2048, aspectRatio: '1:1' },
] as const;

const OUTPUT_COUNT_OPTIONS = [1, 2, 3, 4] as const;
const PROMPT_ASSIST_PROVIDER_ORDER = ['siliconflow', 'deepseek', 'openai', 'bailian', 'zhipu', 'modelscope', 'minimax'] as const;
function clampCount(value: unknown, fallback = 1) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(1, Math.min(4, Math.round(next)));
}

function clampDimension(value: unknown, fallback: number) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(256, Math.min(4096, Math.round(next)));
}

function parseLatencySeconds(value: string) {
  const match = String(value || '').trim().toLowerCase().match(/(\d+(?:\.\d+)?)s/);
  return match ? Number(match[1]) : 0;
}

function formatEta(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '未知';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remain = Math.round(seconds % 60);
  return remain > 0 ? `${minutes}m ${remain}s` : `${minutes}m`;
}

function formatCurrency(value: number, currency = 'CNY') {
  if (!Number.isFinite(value)) return '未知';
  if (currency === 'CNY') return `¥${value >= 100 ? value.toFixed(0) : value.toFixed(2)}`;
  return `${currency} ${value.toFixed(2)}`;
}

function formatImageCapabilityPreview(
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

function imageRoutingHintText(model: Pick<ImageModelOption, 'id' | 'name' | 'provider' | 'upstreamModel' | 'description' | 'capabilities'>) {
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

function classifyFriendlyFailureReason(reason: string, category = '') {
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

function getImageOutcomeLabel(data: Partial<NodeData> | undefined, currentParams: Record<string, unknown>) {
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

function readResolutionConfig(params: Record<string, unknown>, fallbackAspectRatio: string) {
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

function reduceAspectRatio(width: number, height: number) {
  const divisor = gcd(width, height);
  return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
}

function downloadTextFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function pickPromptAssistProvider(provider: string, apiKeys: Record<string, ProviderKeyState>) {
  if (PROMPT_ASSIST_PROVIDER_ORDER.includes(provider as typeof PROMPT_ASSIST_PROVIDER_ORDER[number]) && findProviderKeyState(apiKeys, provider)?.apiKey) {
    return provider;
  }
  const available = PROMPT_ASSIST_PROVIDER_ORDER.find((item) => Boolean(findProviderKeyState(apiKeys, item)?.apiKey));
  return available || 'siliconflow';
}

const TOOL_LABELS: Record<ImageTool, string> = {
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

function buildImageToolParams(tool: ImageTool | null, currentParams: Record<string, unknown>) {
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

export function ImageNode({ selected, data, id }: NodeProps) {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const removeEdge = useCanvasStore((state) => state.removeEdge);
  const canvas = useCanvasStore((state) => state.canvas);
  const canvasVersion = Number(canvas?.updatedAt || 0);
  const setSelectedNodeIds = useCanvasStore((state) => state.setSelectedNodeIds);
  const selectedNodeIds = useCanvasStore((state) => state.selectedNodeIds);
  const assetItems = useAssetStore((state) => state.items);
  const addAssetItem = useAssetStore((state) => state.addItem);
  const deleteAssetItems = useAssetStore((state) => state.deleteItems);
  const syncPersistedItems = useAssetStore((state) => state.syncPersistedItems);
  const apiKeys = useApiKeyStore((state) => state.keys);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const catalogItems = useModelCatalogStore((state) => state.models);
  const byokRuntime = useByokRuntimeStore((state) => state.runtime);
  const fetchByokRuntime = useByokRuntimeStore((state) => state.fetchRuntime);
  const backendRealApiEnabled = useBackendHealthStore((state) => state.realApiEnabled);
  const backendHealthLoading = useBackendHealthStore((state) => state.loading);
  const fetchBackendHealth = useBackendHealthStore((state) => state.fetchHealth);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageAssets = useMemo(() => assetItems.filter((item) => item.type === 'image'), [assetItems]);
  const [prompt, setPrompt] = useState(String(data?.prompt || ''));
  const [activation, setActivation] = useState<GenerationAccess | null>(null);
  const [promptAssistAction, setPromptAssistAction] = useState<PromptAssistAction | null>(null);
  const [promptAssistError, setPromptAssistError] = useState<string | null>(null);
  // 记录被「优化/翻译」替换前的原提示词，用于再次点击按钮时撤销切回原文
  const [assistBaseline, setAssistBaseline] = useState<{ action: PromptAssistAction; text: string } | null>(null);
  const submitRunIdRef = useRef('');
  const batchRegenerateTokenRef = useRef('');
  const migrationPanelTokenRef = useRef('');
  const previousBlobUrlRef = useRef<string | null>(null);
  const [imageRenderError, setImageRenderError] = useState<string | null>(null);
  const [restoredImageUrl, setRestoredImageUrl] = useState('');
  const [restoringImageUrl, setRestoringImageUrl] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const mergeLatestNodeParams = useCallback((
    patch: Record<string, unknown>,
    nodePatch?: Partial<NodeData>,
  ) => {
    const latestNode = useCanvasStore.getState().getNodeById(id);
    const latestParams = latestNode?.data?.params && typeof latestNode.data.params === 'object'
      ? latestNode.data.params as Record<string, unknown>
      : {};
    updateNodeData(id, {
      ...(nodePatch || {}),
      params: {
        ...latestParams,
        ...patch,
      },
    });
  }, [id, updateNodeData]);
  const toolSelection = useMemo(
    () => IMAGE_TOOL_ORDER.map((tool) => ({ key: tool, label: IMAGE_TOOL_PRESETS[tool].label })),
    [],
  );
  const isNodeSelected = selected || selectedNodeIds.includes(id);
  const isNodeExclusivelySelected = selectedNodeIds.length === 1 && selectedNodeIds[0] === id;
  const {
    ensureFocused: ensureImageNodeFocused,
    markInteraction: markImagePanelInteraction,
    sustainInteraction: sustainImagePanelInteraction,
    stopInteraction: stopImagePanelInteraction,
    panelInteractionProps: imagePanelInteractionProps,
  } = useGuardedFloatingPanelInteraction(id);
  const {
    activeKind: activeFloatingPanelKind,
    setOpen: setImageFloatingPanelOpen,
    close: closeImageFloatingPanel,
  } = useNodeFloatingPanel<'image-model-menu' | 'image-asset-menu' | 'image-tool-panel'>(id, ensureImageNodeFocused);
  const modelMenuOpen = activeFloatingPanelKind === 'image-model-menu';
  const assetMenuOpen = activeFloatingPanelKind === 'image-asset-menu';
  const toolPanelOpen = activeFloatingPanelKind === 'image-tool-panel';
  const isNodeInteractionActive = isNodeExclusivelySelected;
  const setModelMenuOpen = (next: boolean | ((open: boolean) => boolean)) => {
    sustainImagePanelInteraction();
    setImageFloatingPanelOpen('image-model-menu', next);
  };
  const setAssetMenuOpen = (next: boolean | ((open: boolean) => boolean)) => {
    sustainImagePanelInteraction();
    setImageFloatingPanelOpen('image-asset-menu', next);
  };
  const setToolPanelOpen = (next: boolean | ((open: boolean) => boolean)) => {
    sustainImagePanelInteraction();
    setImageFloatingPanelOpen('image-tool-panel', next);
  };

  useEffect(() => {
    setPrompt(String(data?.prompt || ''));
  }, [data?.prompt]);

  useEffect(() => {
    void fetchBackendHealth();
  }, [fetchBackendHealth]);
  useEffect(() => {
    void fetchByokRuntime();
  }, [fetchByokRuntime]);

  const currentParams = useMemo(
    () => (data?.params && typeof data.params === 'object' ? (data.params as Record<string, unknown>) : {}),
    [data?.params],
  );
  const referenceSettings = useMemo(
    () => (currentParams.referenceSettings && typeof currentParams.referenceSettings === 'object'
      ? currentParams.referenceSettings as Record<string, { role?: ReferenceRole; weight?: number; enabled?: boolean }>
      : {}),
    [currentParams.referenceSettings],
  );
  const connectedRegionContracts = useMemo(
    () => collectConnectedRegionContracts(canvas, id, 'image'),
    [canvas, canvasVersion, id],
  );
  const activeRegionContractEntry = connectedRegionContracts[0] || null;
  const activeRegionContract = activeRegionContractEntry?.contract || null;
  const contractMode = Boolean(activeRegionContract);
  const directConnectedInputs = useMemo(
    () => collectConnectedReferenceInputs(canvas, id, 'image', referenceSettings),
    [canvas, canvasVersion, data?.inputs, id, referenceSettings],
  );
  const contractConnectedInputs = useMemo(
    () => buildRegionContractMediaInputs(activeRegionContract).map((item) => buildContractConnectedInput(item, referenceSettings)),
    [activeRegionContract, referenceSettings],
  );
  const executionInputs = useMemo(
    () => contractMode ? contractConnectedInputs : directConnectedInputs,
    [contractConnectedInputs, contractMode, directConnectedInputs],
  );
  const primaryInputs = useMemo(
    () => executionInputs.filter((item) => item.channel === 'primary'),
    [executionInputs],
  );
  const referenceInputs = useMemo(
    () => executionInputs.filter((item) => item.channel !== 'primary'),
    [executionInputs],
  );
  const referenceSummary = useMemo(() => summarizeReferenceInputs(executionInputs), [executionInputs]);
  const regionContractPrompt = useMemo(
    () => buildRegionContractPrompt(activeRegionContract),
    [activeRegionContract],
  );
  const regionCapabilityRequirements = useMemo(
    () => buildRegionCapabilityRequirements('image', activeRegionContract),
    [activeRegionContract],
  );
  const conditioningDebugSummary = useMemo(() => {
    const roleLabel = (role: string) => {
      if (role === 'subject') return '主体参考';
      if (role === 'omni') return '光影氛围';
      if (role === 'style') return '风格参考';
      if (role === 'composition') return '构图参考';
      if (role === 'lighting') return '光影参考';
      return role || '参考';
    };
    const primaryRole = primaryInputs[0]?.type === 'image' ? 'composition' : String(primaryInputs[0]?.role || 'primary');
    const referenceRoles = Array.from(new Set(referenceInputs.map((item) => String(item.role || 'style')).filter(Boolean)));
    const hasOmni = referenceRoles.includes('omni');
    const hasSubject = referenceRoles.includes('subject');
    const intent = hasSubject && primaryInputs.some((item) => item.type === 'image')
      ? '保构图换主体'
      : hasOmni
        ? '全能参考融合'
        : referenceRoles.length > 1
          ? '多参考融合'
          : '参考增强';
    return {
      primaryRole,
      referenceRoles,
      hasOmni,
      intent,
      text: `主素材 ${primaryRole} · 参考 ${referenceRoles.length ? referenceRoles.map(roleLabel).join(' / ') : '无'} · 意图 ${intent}`,
    };
  }, [primaryInputs, referenceInputs]);
  const imageReferenceHandles = useMemo(() => {
    const countHandles = (group: 'subject' | 'lighting') => {
      const matched = referenceInputs.filter((item) => {
        const handleId = String(item.handleId || '');
        if (group === 'subject') {
          return handleId.startsWith('image-subject-reference') || item.role === 'subject';
        }
        return handleId.startsWith('image-lighting-reference') || item.role === 'omni' || item.role === 'lighting' || item.role === 'style';
      }).length;
      return Math.max(1, matched + 1);
    };

    const subjectHandles = Array.from({ length: countHandles('subject') }, (_, index) => ({
      id: `image-subject-reference-${index}`,
      lane: 'subject' as const,
      shortLabel: '主体',
      helperLabel: index === 0 ? '主体参考' : `主体参考 ${index + 1}`,
      topPercent: 62 + (index * 8),
    }));
    const lightingHandles = Array.from({ length: countHandles('lighting') }, (_, index) => ({
      id: `image-lighting-reference-${index}`,
      lane: 'lighting' as const,
      shortLabel: '光影',
      helperLabel: index === 0 ? '光影参考' : `光影参考 ${index + 1}`,
      topPercent: 82 + (index * 8),
    }));
    return [...subjectHandles, ...lightingHandles];
  }, [referenceInputs]);


  useEffect(() => {
    const handlePosterEditorMessage = (event: MessageEvent) => {
      const payload = event.data && typeof event.data === 'object' ? event.data as { source?: string; nodeId?: string; layout?: PosterLayoutConfig } : null;
      if (!payload || payload.source !== 'hmdao-poster-editor' || payload.nodeId !== id || !payload.layout) return;
      const nextLayout = mergePosterLayoutPatch(readPosterLayoutConfig(currentParams), payload.layout);
      mergeLatestNodeParams({ posterLayout: nextLayout });
    };
    window.addEventListener('message', handlePosterEditorMessage);
    return () => window.removeEventListener('message', handlePosterEditorMessage);
  }, [currentParams, id, mergeLatestNodeParams]);
  const [activeTool, setActiveTool] = useState<ImageTool | null>(
    typeof currentParams.imageTool === 'string' ? (currentParams.imageTool as ImageTool) : null,
  );

  useEffect(() => {
    const nextTool = typeof currentParams.imageTool === 'string' ? (currentParams.imageTool as ImageTool) : null;
    setActiveTool(nextTool);
    if (!isImageGenerationTool(nextTool)) {
      closeImageFloatingPanel('image-tool-panel');
    }
  }, [closeImageFloatingPanel, currentParams.imageTool]);

  const models = useMemo<ImageModelOption[]>(() => {
    const catalogModels = catalogItems.filter((model) => model.nodeTypes.includes('image'));
    return catalogModels.length > 0
      ? catalogModels.map((model) => {
          const localKey = findProviderKeyState(apiKeys, model.provider, 'image');
          const activated = Boolean(
            model.activated
            || modelMatchesLocalKey(
              {
                id: model.id,
                name: model.name,
                provider: model.provider,
                upstreamModel: String(model.model || model.id),
              },
              localKey,
              'image',
            ),
          );
          return {
            id: model.id,
            name: model.name,
            description: model.description,
            latency: model.latency || '',
            provider: model.provider,
            providerLabel: model.providerMeta?.name || model.provider,
            upstreamModel: String(model.model || model.id),
            price: Number(model.price || 0),
            currency: model.currency || 'CNY',
            activated,
            discountLabel: model.discountLabel,
            maskedKey: model.maskedKey || localKey?.maskedKey,
            activationModelMatched: model.activationModelMatched ?? true,
            activationModel: model.activationModel || localKey?.model || '',
            activationRelaySource: model.activationRelaySource || null,
            capabilities: model.capabilities || null,
          };
        })
      : FALLBACK_MODELS;
  }, [apiKeys, catalogItems]);
  const identityController = useMemo<IdentityControllerConfig>(
    () => readIdentityControllerConfig(currentParams.identityController, referenceInputs),
    [currentParams.identityController, referenceInputs],
  );
  const activeImageToolParams = useMemo(
    () => buildImageToolParams(activeTool, currentParams),
    [activeTool, currentParams],
  );
  const imageCapabilityRequirements = useMemo(
    () => [
      ...buildImageModelCapabilityRequirements({
        toolOperation: typeof activeImageToolParams.toolOperation === 'string' ? activeImageToolParams.toolOperation : undefined,
        primaryInputs,
        referenceInputs,
        identityController,
      }),
      ...regionCapabilityRequirements,
    ],
    [activeImageToolParams.toolOperation, identityController, primaryInputs, referenceInputs, regionCapabilityRequirements],
  );
  const modelsWithSupport = useMemo<ImageModelOption[]>(
    () => models.map((model) => {
      const support = evaluateModelCapabilitySupport(model.capabilities || undefined, imageCapabilityRequirements);
      const routingHints = imageRoutingHintText(model);
      const strictCompositionSubjectIntent = conditioningDebugSummary.intent === '保构图换主体';
      const qwenSoftConstraintHit = strictCompositionSubjectIntent
        && (model.id === 'lib-image' || String(model.upstreamModel || '').toLowerCase().includes('qwen-image'))
        && !routingHints.includes('保构图换主体');
      return {
        ...model,
        supportedForCurrentRequest: support.supported && !qwenSoftConstraintHit,
        unsupportedReason: qwenSoftConstraintHit
          ? '当前模型更偏多参考融合生成，不是严格的 edit-grade 构图锁定模型。遇到“保构图换主体”这类强约束任务时，建议优先改用 FLUX Pro、GPT Image 2、Seedream 5 Lite 或 Grok Imagine Edit。'
          : support.reason,
      };
    }),
    [conditioningDebugSummary.intent, imageCapabilityRequirements, models],
  );
  const selectableModels = useMemo(
    () => modelsWithSupport.filter((model) => model.supportedForCurrentRequest !== false),
    [modelsWithSupport],
  );
  const imageCapabilityPreviewText = useMemo(
    () => formatImageCapabilityPreview(imageCapabilityRequirements, conditioningDebugSummary.intent),
    [conditioningDebugSummary.intent, imageCapabilityRequirements],
  );

  const selectedModelId = String(data?.model || modelsWithSupport[0]?.id || FALLBACK_MODELS[0].id);
  const selectedModel = useMemo(
    () => modelsWithSupport.find((item) => item.id === selectedModelId) || modelsWithSupport[0] || FALLBACK_MODELS[0],
    [modelsWithSupport, selectedModelId],
  );
  const recommendedCapabilityModel = useMemo(
    () => selectableModels.find((item) => item.activated && item.activationModelMatched !== false) || selectableModels[0] || null,
    [selectableModels],
  );
  const selectedModelCapabilityBoundaryMessage = selectedModel.supportedForCurrentRequest === false
    ? (selectedModel.unsupportedReason || '当前模型能力不足，无法满足当前图片工作流。')
    : '';
  const selectedModelCapabilityRecommendation = recommendedCapabilityModel
    ? `${recommendedCapabilityModel.providerLabel} · ${recommendedCapabilityModel.upstreamModel}`
    : '';
  const regionContractNotice = useMemo(
    () => buildVerboseRegionContractNotice(activeRegionContract, selectedModelCapabilityRecommendation),
    [activeRegionContract, selectedModelCapabilityRecommendation],
  );
  const selectedModelActivated = Boolean(
  (selectedModel?.activated && selectedModel.activationModelMatched !== false)
  || modelMatchesLocalKey(
    {
      id: selectedModel.id,
      name: selectedModel.name,
      provider: selectedModel.provider,
      upstreamModel: selectedModel.upstreamModel,
    },
    findProviderKeyState(apiKeys, selectedModel.provider, 'image'),
    'image',
  )
);

  const selectedCount = useMemo(() => clampCount(currentParams.count, 1), [currentParams.count]);
  const resolutionConfig = useMemo(
    () => readResolutionConfig(currentParams, String(data?.aspectRatio || '16:9')),
    [currentParams, data?.aspectRatio],
  );
  const resolutionPresetKey = useMemo(
    () => IMAGE_RESOLUTION_PRESETS.find((item) => item.width === resolutionConfig.width && item.height === resolutionConfig.height)?.key || 'custom',
    [resolutionConfig.height, resolutionConfig.width],
  );
  const posterLayout = useMemo(() => readPosterLayoutConfig(currentParams), [currentParams]);
  const posterEditor = useMemo(() => normalizePosterEditorState(posterLayout.editor, posterLayout), [posterLayout]);
  const routedModelPreview = useMemo(
    () => resolveImageToolModel(
      selectedModel.id,
      String(data?.provider || selectedModel.provider),
      {
        ...(data as unknown as NodeData),
        inputs: executionInputs,
        params: {
          ...currentParams,
          ...buildImageToolParams(activeTool, currentParams),
          regionContract: activeRegionContract || currentParams.regionContract,
          contractMode,
          contractSummary: regionContractNotice || currentParams.contractSummary,
          regionContractSourceNodeId: activeRegionContractEntry?.sourceNodeId || currentParams.regionContractSourceNodeId,
        },
      },
      catalogItems,
    ),
    [
      activeRegionContract,
      activeRegionContractEntry?.sourceNodeId,
      activeTool,
      catalogItems,
      contractMode,
      currentParams,
      data,
      executionInputs,
      regionContractNotice,
      selectedModel.id,
      selectedModel.provider,
    ],
  );
  const effectiveModel = useMemo(
    () => models.find((item) => item.id === routedModelPreview.model) || selectedModel,
    [models, routedModelPreview.model, selectedModel],
  );
  const estimatedSeconds = useMemo(
    () => parseLatencySeconds(effectiveModel.latency) * selectedCount,
    [effectiveModel.latency, selectedCount],
  );
  const estimatedCost = useMemo(
    () => Number(effectiveModel.price || 0) * selectedCount,
    [effectiveModel.price, selectedCount],
  );
  const promptAssistProvider = useMemo(
    () => pickPromptAssistProvider(selectedModel.provider, apiKeys),
    [apiKeys, selectedModel.provider],
  );
  const canSubmitPrompt = Boolean(prompt.trim() || regionContractPrompt.trim());
  const activeRegionContractJson = useMemo(
    () => activeRegionContract ? JSON.stringify(activeRegionContract) : '',
    [activeRegionContract],
  );
  const currentRegionContractJson = useMemo(() => {
    const normalized = readRegionContract(currentParams.regionContract);
    return normalized ? JSON.stringify(normalized) : '';
  }, [currentParams.regionContract]);

  useEffect(() => {
    const nextSummary = regionContractNotice || undefined;
    const nextSourceNodeId = activeRegionContractEntry?.sourceNodeId;
    const currentContractMode = Boolean(currentParams.contractMode);
    const currentSummary = typeof currentParams.contractSummary === 'string' ? currentParams.contractSummary : undefined;
    const currentSourceNodeId = typeof currentParams.regionContractSourceNodeId === 'string' ? currentParams.regionContractSourceNodeId : undefined;

    if (contractMode) {
      if (
        currentContractMode === contractMode
        && currentSummary === nextSummary
        && currentSourceNodeId === nextSourceNodeId
        && currentRegionContractJson === activeRegionContractJson
      ) {
        return;
      }
      updateNodeData(id, {
        params: {
          ...currentParams,
          regionContract: activeRegionContract || undefined,
          contractMode: true,
          contractSummary: nextSummary,
          regionContractSourceNodeId: nextSourceNodeId,
        },
      });
      return;
    }

    if (!currentContractMode && currentSummary === undefined && currentSourceNodeId === undefined) return;
    updateNodeData(id, {
      params: {
        ...currentParams,
        contractMode: false,
        contractSummary: undefined,
        regionContractSourceNodeId: undefined,
      },
    });
  }, [
    activeRegionContract,
    activeRegionContractEntry?.sourceNodeId,
    activeRegionContractJson,
    contractMode,
    currentParams,
    currentRegionContractJson,
    id,
    regionContractNotice,
    updateNodeData,
  ]);

  useEffect(() => {
    if (!data?.model && selectedModel) {
      updateNodeData(id, { model: selectedModel.id, provider: selectedModel.provider });
    }
  }, [data?.model, id, selectedModel, updateNodeData]);

  const imageUrl = useMemo(() => {
    const directUrl = typeof data?.imageUrl === 'string' ? data.imageUrl : '';
    const outputUrl = (data?.outputs as Array<{ url?: string }> | undefined)?.find((item) => item?.url)?.url ?? '';
    return directUrl || outputUrl;
  }, [data?.imageUrl, data?.outputs]);
  const renderImageUrl = useMemo(() => toRenderableAssetUrl(imageUrl, 'image'), [imageUrl]);
  const effectiveRenderImageUrl = renderImageUrl || restoredImageUrl;
  const originalImageUrl = useMemo(() => {
    const outputs = data?.outputs as Array<{ metadata?: Record<string, unknown>; url?: string }> | undefined;
    const originalUrl = outputs?.find((item) => typeof item?.metadata?.originalUrl === 'string')?.metadata?.originalUrl;
    return typeof originalUrl === 'string' && originalUrl ? originalUrl : imageUrl;
  }, [data?.outputs, imageUrl]);
  const posterExportImageUrl = originalImageUrl;

  const imageMeta = useMemo<ImageMeta | null>(() => {
    const raw = currentParams.imageMeta;
    if (!raw || typeof raw !== 'object') return null;
    const meta = raw as Partial<ImageMeta>;
    const width = Number(meta.width);
    const height = Number(meta.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return { width, height };
  }, [currentParams.imageMeta]);

  const hasImage = Boolean(imageUrl);
  const hasRenderableImage = Boolean(effectiveRenderImageUrl);
  const displaySize = useMemo(() => getImageDisplaySize(imageMeta), [imageMeta]);
  const imageOutcome = useMemo(() => getImageOutcomeLabel(data, currentParams), [currentParams, data]);
  const preflightImageIssue = useMemo<RenderableAssetIssue | null>(
    () => classifyRenderableAssetIssue(originalImageUrl, 'image'),
    [originalImageUrl],
  );
  const ratioText = imageMeta
    ? `${Math.round(imageMeta.width / gcd(imageMeta.width, imageMeta.height))}:${Math.round(imageMeta.height / gcd(imageMeta.width, imageMeta.height))}`
    : '16:9';
  const generationProgress = useMemo(() => {
    const raw = currentParams.generationProgress;
    return Array.isArray(raw) ? raw : [];
  }, [currentParams.generationProgress]);
  const latestProgress = generationProgress.length > 0
    ? generationProgress[generationProgress.length - 1] as Record<string, unknown>
    : null;
  const lastErrorCategory = typeof currentParams.lastErrorCategory === 'string' ? currentParams.lastErrorCategory : '';
  const effectiveImageRenderError = imageRenderError || preflightImageIssue?.detail || (
    hasImage && !hasRenderableImage && !restoringImageUrl
      ? (
        isTransientBlobUrl(imageUrl)
          ? '这是旧画布里的历史本地缓存图片，浏览器重启后原始 blob 已失效，请重新上传或重新生成。'
          : '图片地址暂时不可用，建议重新上传或重新生成。'
      )
      : null
  );
  const effectiveImageOutcome = useMemo(() => {
    if (effectiveImageRenderError) {
      return {
        tone: 'error' as const,
        label: preflightImageIssue?.summary || '资源渲染失败',
        reason: effectiveImageRenderError,
      };
    }
    return imageOutcome;
  }, [effectiveImageRenderError, imageOutcome, preflightImageIssue?.summary]);

  useEffect(() => {
    setImageRenderError(null);
  }, [effectiveRenderImageUrl]);

  useEffect(() => {
    let cancelled = false;
    setRestoredImageUrl('');
    setRestoringImageUrl(false);
    if (!imageUrl || !isLocalMediaHandle(imageUrl) || renderImageUrl) {
      return () => {
        cancelled = true;
      };
    }
    setRestoringImageUrl(true);
    void ensureLocalMediaUrl(imageUrl).then((resolvedUrl) => {
      if (cancelled) return;
      if (resolvedUrl) {
        setRestoredImageUrl(resolvedUrl);
        setImageRenderError(null);
        return;
      }
      setImageRenderError('当前本地图片缓存已失效，请重新上传，或重新执行生成获得新的结果节点。');
    }).catch(() => {
      if (cancelled) return;
      setImageRenderError('当前本地图片缓存恢复失败，请重新上传，或重新执行生成获得新的结果节点。');
    }).finally(() => {
      if (!cancelled) {
        setRestoringImageUrl(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [imageUrl, renderImageUrl]);

  useEffect(() => {
    if (previousBlobUrlRef.current && previousBlobUrlRef.current !== imageUrl && previousBlobUrlRef.current.startsWith('blob:')) {
      URL.revokeObjectURL(previousBlobUrlRef.current);
    }
    previousBlobUrlRef.current = imageUrl || null;
  }, [imageUrl]);

  useEffect(() => () => {
    if (previousBlobUrlRef.current?.startsWith('blob:')) {
      URL.revokeObjectURL(previousBlobUrlRef.current);
    }
  }, []);

  function handleImageRenderFailure() {
    const genericMessage = isTransientBlobUrl(imageUrl)
      ? '这是旧画布里的历史本地缓存图片，浏览器重启后原始 blob 已失效，请重新上传或重新生成。'
      : '图片渲染失败，请重试或重新上传。';
    const eagerIssue = classifyRenderableAssetIssue(originalImageUrl, 'image');
    if (eagerIssue) {
      setImageRenderError(eagerIssue.detail);
      return;
    }
    void probeRenderableAssetIssue(effectiveRenderImageUrl, originalImageUrl, 'image').then((issue) => {
      setImageRenderError(issue?.detail || genericMessage);
    }).catch(() => {
      setImageRenderError(genericMessage);
    });
  }

  async function applyUploadedFile(file: File) {
    const url = registerLocalMedia(file);
    const renderUrl = toRenderableAssetUrl(url, 'image');
    const tempAssetId = addAssetItem({
      name: file.name,
      type: 'image',
      url,
      thumbnail: url,
      folderId: 'root',
      size: file.size,
      tags: [],
      smartCategories: [],
      source: 'upload',
    });
    updateImageFromUrl(url, {
      source: 'upload',
      name: file.name,
      size: file.size,
      managedUrl: true,
      sourceAssetId: tempAssetId,
    });

    const probe = new window.Image();
    probe.onload = () => {
      const latestNode = useCanvasStore.getState().getNodeById(id);
      const latestParams = latestNode?.data?.params && typeof latestNode.data.params === 'object'
        ? latestNode.data.params as Record<string, unknown>
        : {};
      const latestSourceAssetId = String(latestParams.sourcePersistedAssetId || latestParams.sourceAssetId || tempAssetId).trim();
      const nextMeta = {
        width: probe.naturalWidth || probe.width || 1024,
        height: probe.naturalHeight || probe.height || 1024,
      };
      mergeLatestNodeParams({
        imageMeta: nextMeta,
      }, {
        aspectRatio: nextMeta.width >= nextMeta.height ? '16:9' : '9:16',
        outputs: [
          {
            id: `upload-${Date.now()}`,
            type: 'image',
            url,
            metadata: {
              source: 'upload',
              name: file.name,
              size: file.size,
              managedUrl: true,
              sourceAssetId: latestSourceAssetId,
              persistedAssetId: String(latestParams.sourcePersistedAssetId || '').trim() || undefined,
              ...nextMeta,
            },
          },
        ],
      });
    };
    probe.src = renderUrl || url;

    void (async () => {
      try {
        const persisted = await enqueueLocalAssetPersistence(file, {
          folderId: 'root',
          width: probe.naturalWidth || undefined,
          height: probe.naturalHeight || undefined,
          sourceUrl: file.name,
        });
        const persistedAssetId = String(persisted.item.backendAssetId || persisted.item.id || '').trim();
        const persistedUrl = String(persisted.item.url || '').trim();
        if (!persistedAssetId || !persistedUrl) return;

        const latestNode = useCanvasStore.getState().getNodeById(id);
        const latestParams = latestNode?.data?.params && typeof latestNode.data.params === 'object'
          ? latestNode.data.params as Record<string, unknown>
          : {};
        if (String(latestParams.sourceAssetId || '').trim() !== tempAssetId) return;

        syncPersistedItems([persisted.item]);
        deleteAssetItems([tempAssetId]);
        revokeLocalMedia(url);

        const imageMeta = {
          width: persisted.item.width || probe.naturalWidth || probe.width || 1024,
          height: persisted.item.height || probe.naturalHeight || probe.height || 1024,
        };
        mergeLatestNodeParams({
          sourceUrl: persistedUrl,
          sourceAssetId: persistedAssetId,
          sourcePersistedAssetId: persistedAssetId,
          imageMeta,
        }, {
          imageUrl: persistedUrl,
          aspectRatio: imageMeta.width >= imageMeta.height ? '16:9' : '9:16',
          outputs: [{
            id: `upload-${Date.now()}`,
            type: 'image',
            url: persistedUrl,
            metadata: {
              source: 'upload',
              name: file.name,
              size: file.size,
              managedUrl: true,
              sourceAssetId: persistedAssetId,
              persistedAssetId,
              originalUrl: url,
              ...imageMeta,
            },
          }],
        });
      } catch {
        // keep the optimistic local handle when persistence is unavailable
      }
    })();
  }

  async function openFilePicker(event?: { preventDefault: () => void; stopPropagation: () => void }) {
    if (event) stopImagePanelInteraction(event);

    const pickerWindow = window as WindowWithPicker;
    if (pickerWindow.showOpenFilePicker) {
      try {
        const [handle] = await pickerWindow.showOpenFilePicker({
          excludeAcceptAllOption: false,
          multiple: false,
          types: [
            {
              description: 'Images',
              accept: {
                'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg', '.avif'],
              },
            },
          ],
        });
        if (!handle) return;
        const file = await handle.getFile();
        await applyUploadedFile(file);
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
      }
    }

    fileInputRef.current?.click();
  }

  function updateImageFromUrl(url: string, metadata: Record<string, unknown>) {
    updateNodeData(id, {
      imageUrl: url,
      status: 'completed',
      outputs: [
        {
          id: `image-${Date.now()}`,
          type: 'image',
          url,
          metadata,
        },
      ],
    });
  }

  function handleUploadFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    void applyUploadedFile(file);
    event.target.value = '';
  }

  function chooseAsset(asset: AssetItem) {
    markImagePanelInteraction();
    const nextMeta = asset.width && asset.height ? { width: asset.width, height: asset.height } : undefined;
    updateNodeData(id, {
      imageUrl: asset.url,
      status: 'completed',
      aspectRatio: nextMeta ? (nextMeta.width >= nextMeta.height ? '16:9' : '9:16') : String(data?.aspectRatio || '16:9'),
      params: {
        ...currentParams,
        imageMeta: nextMeta || currentParams.imageMeta,
        sourceAssetId: asset.id,
      },
      outputs: [
        {
          id: `asset-${asset.id}-${Date.now()}`,
          type: 'image',
          url: asset.url,
          metadata: {
            source: 'asset-library',
            name: asset.name,
            size: asset.size,
            width: asset.width,
            height: asset.height,
          },
        },
      ],
    });
    setAssetMenuOpen(false);
  }

  function chooseModel(model: ImageModelOption) {
    markImagePanelInteraction();
    const nextCapabilityBoundaryMessage = model.supportedForCurrentRequest === false
      ? (model.unsupportedReason || '当前模型能力不足，无法满足当前图片工作流。')
      : undefined;
    const shouldClearCapabilityError = currentParams.lastErrorStage === 'capability-matrix';
    updateNodeData(id, {
      ...(shouldClearCapabilityError ? { status: 'pending', error: undefined } : {}),
      model: model.id,
      provider: model.provider,
      params: {
        ...currentParams,
        modelPinnedByUser: true,
        capabilityBoundaryMessage: nextCapabilityBoundaryMessage,
        capabilityBoundaryStage: nextCapabilityBoundaryMessage ? 'capability-matrix' : undefined,
        capabilityBoundaryRecommendedModel: nextCapabilityBoundaryMessage ? selectedModelCapabilityRecommendation : undefined,
        lastError: shouldClearCapabilityError ? undefined : currentParams.lastError,
        lastErrorCategory: shouldClearCapabilityError ? undefined : currentParams.lastErrorCategory,
        lastErrorStage: shouldClearCapabilityError ? undefined : currentParams.lastErrorStage,
      },
    });
    setModelMenuOpen(false);
  }

  function setOutputCount(count: number) {
    markImagePanelInteraction();
    updateNodeData(id, {
      params: {
        ...currentParams,
        count: clampCount(count, 1),
      },
    });
  }

  function setResolution(width: number, height: number, label: string, aspectRatio = reduceAspectRatio(width, height)) {
    markImagePanelInteraction();
    const nextWidth = clampDimension(width, resolutionConfig.width);
    const nextHeight = clampDimension(height, resolutionConfig.height);
    updateNodeData(id, {
      aspectRatio,
      quality: nextWidth >= 2048 || nextHeight >= 2048 ? '2k' : 'standard',
      params: {
        ...currentParams,
        resolution: {
          label,
          width: nextWidth,
          height: nextHeight,
        },
      },
    });
  }

  function selectResolutionPreset(presetKey: string) {
    const preset = IMAGE_RESOLUTION_PRESETS.find((item) => item.key === presetKey);
    if (!preset) return;
    setResolution(preset.width, preset.height, preset.label, preset.aspectRatio);
  }

  function updateCustomResolution(widthValue: string, heightValue: string) {
    const parsedWidth = Number.parseInt(String(widthValue || '').replace(/[^\d]/g, ''), 10);
    const parsedHeight = Number.parseInt(String(heightValue || '').replace(/[^\d]/g, ''), 10);
    const nextWidth = Number.isFinite(parsedWidth) ? clampDimension(parsedWidth, resolutionConfig.width) : resolutionConfig.width;
    const nextHeight = Number.isFinite(parsedHeight) ? clampDimension(parsedHeight, resolutionConfig.height) : resolutionConfig.height;
    setResolution(nextWidth, nextHeight, `${nextWidth}x${nextHeight}`, reduceAspectRatio(nextWidth, nextHeight));
  }

  function updatePosterLayout(patch: Partial<PosterLayoutConfig>) {
    const nextLayout = mergePosterLayoutPatch(posterLayout, patch);
    updateNodeData(id, {
      params: {
        ...currentParams,
        posterLayout: nextLayout,
      },
    });
  }

  function selectTool(tool: ImageTool) {
    markImagePanelInteraction();
    const nextTool = activeTool === tool ? null : tool;
    setActiveTool(nextTool);
    updateNodeData(id, {
      params: {
        ...currentParams,
        ...buildImageToolParams(nextTool, currentParams),
      },
    });
    setToolPanelOpen(nextTool !== null && hasToolPanel(nextTool));
  }

  async function handleToolApply(payload: Record<string, unknown>) {
    if (activeTool === 'brush') {
      const { mask, imageUrl: payloadImageUrl } = payload as { mask: string; imageUrl: string };
      try {
        const result = await applyBrushEdit({
          imageUrl: payloadImageUrl,
          mask,
          folderId: 'img-brush',
        });
        updateNodeData(id, {
          imageUrl: result.url,
          outputs: [
            {
              id: `brush-${Date.now()}`,
              type: 'image',
              url: result.url,
              metadata: { originalUrl: payloadImageUrl },
            },
          ],
        });
        setActiveTool(null);
        setToolPanelOpen(false);
      } catch (err) {
        if (err instanceof BrushEditError) {
          setActivation({ mode: 'image', provider: selectedModel.provider, reason: 'api-key' });
        } else {
          setActivation({ mode: 'image', provider: selectedModel.provider, reason: 'api-key' });
        }
      }
    } else if (activeTool === 'bgRemove') {
      const { imageUrl: payloadImageUrl } = payload as { imageUrl: string };
      if (!payloadImageUrl) return;
      try {
        const { url } = await removeImageBackground(payloadImageUrl);
        updateNodeData(id, {
          imageUrl: url,
          outputs: [
            {
              id: `bg-${Date.now()}`,
              type: 'image',
              url,
              metadata: { originalUrl: payloadImageUrl },
            },
          ],
        });
        setActiveTool(null);
        setToolPanelOpen(false);
      } catch (err) {
        if (err instanceof LocalModelError) {
          setActivation({ mode: 'image', provider: selectedModel.provider, reason: 'api-key' });
        }
      }
    }
  }

  async function handlePromptAssist(action: PromptAssistAction) {
    // 撤销：再次点击同一按钮时，切回原提示词
    if (assistBaseline && assistBaseline.action === action) {
      setPrompt(assistBaseline.text);
      setAssistBaseline(null);
      return;
    }
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt || promptAssistAction) return;
    markImagePanelInteraction();
    setPromptAssistAction(action);
    setPromptAssistError(null);
    const baseline = normalizedPrompt; // 替换前的原文（可能是更早的优化/翻译结果）
    try {
      const nextPrompt = await assistPrompt({
        prompt: normalizedPrompt,
        action,
        target: 'image',
        provider: promptAssistProvider,
        apiKey: findProviderKeyState(apiKeys, promptAssistProvider)?.apiKey,
      });
      if (!nextPrompt) return;
      // 直接替换原提示词（非追加新版本），并记录原文以便撤销
      setAssistBaseline({ action, text: baseline });
      setPrompt(nextPrompt);
    } catch (error) {
      setPromptAssistError(error instanceof Error ? error.message : '提示词处理失败。');
    } finally {
      setPromptAssistAction(null);
    }
  }

  function updateToolConfig(nextConfig: Record<string, unknown>) {
    if (!hasToolPanel(activeTool)) return;
    markImagePanelInteraction();
    const nextParams = {
      ...currentParams,
      toolConfig: nextConfig,
    };
    updateNodeData(id, {
      params: {
        ...currentParams,
        ...buildImageToolParams(activeTool, nextParams),
        toolConfig: nextConfig,
      },
    });
  }

  function updateReferenceSetting(key: string, patch: Record<string, unknown>) {
    updateNodeData(id, {
      params: {
        ...currentParams,
        referenceSettings: {
          ...referenceSettings,
          [key]: {
            ...(referenceSettings[key] || {}),
            ...patch,
          },
        },
      },
    });
  }

  function removeBoundReferenceInput(inputKey: string) {
    const existingInputs = Array.isArray(data?.inputs)
      ? data.inputs.filter((item) => item && typeof item === 'object')
      : [];
    const nextInputs = existingInputs.filter((item) => {
      const sourceNodeId = String(item?.sourceNodeId || '').trim();
      const handleId = String(item?.handleId || '').trim();
      const mediaType = String(item?.type || '').trim();
      const manualKey = `manual:${sourceNodeId}:${handleId || 'default'}:${mediaType}`;
      return manualKey !== inputKey;
    });
    updateNodeData(id, { inputs: nextInputs });
    const parts = String(inputKey || '').split(':');
    const sourceNodeId = String(parts[1] || '').trim();
    const handleId = String(parts[2] || '').trim();
    if (sourceNodeId && handleId) {
      (canvas?.edges || [])
        .filter((edge) => edge.target === id && edge.source === sourceNodeId && String(edge.targetHandle || '') === handleId)
        .forEach((edge) => removeEdge(edge.id));
    }
  }

  async function submitPrompt() {
    const userPrompt = prompt.trim();
    const contractPromptText = regionContractPrompt.trim();
    const trimmed = userPrompt || contractPromptText;
    const executionPrompt = contractMode && contractPromptText
      ? [userPrompt, contractPromptText].filter(Boolean).join('\n\n')
      : trimmed;
    if (!trimmed || !executionPrompt || data?.status === 'generating') return;
    pushImageSubmitTrace('submit:start', {
      nodeId: id,
      contractMode,
      selectedModel: selectedModel.id,
      provider: selectedModel.provider,
    });

    const nextInputs = [...primaryInputs, ...referenceInputs].map((item) => ({
      id: item.id,
      type: item.type,
      url: item.url,
      label: item.label,
      role: item.role,
      weight: item.weight,
      enabled: item.enabled,
      sourceNodeId: item.sourceNodeId,
      sourceNodeType: item.sourceNodeType,
      handleId: item.handleId,
      channel: item.channel,
      metadata: item.metadata,
    }));
    const activePrimary = primaryInputs.find((item) => item.enabled !== false);
    const activeReferences = referenceInputs.filter((item) => item.enabled !== false);
    const nextIdentityController = readIdentityControllerConfig(currentParams.identityController, activeReferences);
    const workflowGraph = buildNodeWorkflowGraph({
      nodeId: id,
      nodeType: 'image',
      executionMode: activeTool ? 'editing' : 'generation',
      provider: selectedModel.provider,
      model: selectedModel.id,
      prompt: executionPrompt,
      sourceMediaType: activePrimary?.type || String(currentParams.sourceMediaType || ''),
      toolOperation: typeof activeImageToolParams.toolOperation === 'string' ? activeImageToolParams.toolOperation : undefined,
      primaryInputs,
      referenceInputs,
      identityController: nextIdentityController,
    });
    const nextParamsBase = {
      ...currentParams,
      ...buildImageToolParams(activeTool, currentParams),
      nodeId: id,
      sourceUrl: activePrimary?.url || currentParams.sourceUrl,
      sourceMediaType: activePrimary?.type || currentParams.sourceMediaType,
      referenceImageUrl: activeReferences.find((item) => item.type === 'image')?.url || currentParams.referenceImageUrl,
      identityController: nextIdentityController,
      workflowGraph,
      workflowTemplateVersion: workflowGraph.templateVersion,
      referenceSummary,
      referenceSettings,
      regionContract: activeRegionContract || currentParams.regionContract,
      contractMode,
      contractSummary: regionContractNotice || undefined,
      regionContractSourceNodeId: activeRegionContractEntry?.sourceNodeId,
    };
    if (selectedModel.supportedForCurrentRequest === false && !recommendedCapabilityModel) {
      const blockingMessage = selectedModelCapabilityRecommendation
        ? `${selectedModelCapabilityBoundaryMessage} 推荐改用 ${selectedModelCapabilityRecommendation}。`
        : selectedModelCapabilityBoundaryMessage;
      updateNodeData(id, {
        status: 'error',
        error: blockingMessage,
        inputs: nextInputs,
        params: {
          ...nextParamsBase,
          capabilityBoundaryMessage: selectedModelCapabilityBoundaryMessage,
          capabilityBoundaryStage: 'capability-matrix',
          capabilityBoundaryRecommendedModel: selectedModelCapabilityRecommendation || undefined,
          lastError: blockingMessage,
          lastErrorCategory: 'routing',
          lastErrorStage: 'capability-matrix',
        },
      });
      return;
    }
    const capabilitySeedModel = selectedModel.supportedForCurrentRequest === false && recommendedCapabilityModel
      ? recommendedCapabilityModel
      : selectedModel;
    const capabilityAutoRoutedFrom = capabilitySeedModel.id !== selectedModel.id ? selectedModel.id : undefined;

    const routedModel = resolveImageToolModel(
      capabilitySeedModel.id,
      String(data?.provider || capabilitySeedModel.provider),
      {
        ...(data as unknown as NodeData),
        inputs: nextInputs,
        params: nextParamsBase,
      },
      catalogItems,
    );
    const routedCatalogModel = models.find((item) => item.id === routedModel.model) || selectedModel;
    const routedModelActivated = Boolean(
      (routedCatalogModel?.activated && routedCatalogModel.activationModelMatched !== false)
      || modelMatchesLocalKey(
        {
          id: routedCatalogModel.id,
          name: routedCatalogModel.name,
          provider: routedCatalogModel.provider,
          upstreamModel: routedModel.requestModel || routedCatalogModel.upstreamModel,
        },
        findProviderKeyState(apiKeys, routedCatalogModel.provider, 'image'),
        'image',
      )
    );

    const access = resolveGenerationAccess(
      'image',
      routedModel.requestModel || routedModel.model,
      routedModel.provider,
      apiKeys,
      isAuthenticated(),
      routedModelActivated,
      {
        strictProvider: true,
        allowProviderOnlyActivation: false,
      },
    );
    if (!access.ok) {
      pushImageSubmitTrace('submit:activation-blocked', {
        nodeId: id,
        provider: routedModel.provider,
        requestModel: routedModel.requestModel || routedModel.model,
        reason: access.reason || '',
      });
      if (access.reason === 'auth') {
        window.location.href = '/login';
        return;
      }
      setActivation(access);
      return;
    }

    const runId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    submitRunIdRef.current = runId;
    const generationPosterLayout = createFreshPosterLayoutForGeneration(posterLayout);
    const nextParams = {
      ...nextParamsBase,
      posterLayout: generationPosterLayout,
      activeRunId: runId,
      generationProgress: [],
      lastError: undefined,
      lastErrorCategory: undefined,
      lastErrorStage: undefined,
      capabilityAutoRoutedFrom,
      capabilityBoundaryMessage: selectedModel.supportedForCurrentRequest === false ? selectedModelCapabilityBoundaryMessage : undefined,
      capabilityBoundaryRecommendedModel: selectedModel.supportedForCurrentRequest === false ? selectedModelCapabilityRecommendation || undefined : undefined,
    };
    const requestPrompt = buildPosterSafePrompt(executionPrompt, generationPosterLayout, resolutionConfig);

    pushImageSubmitTrace('submit:before-update-node', {
      nodeId: id,
      runId,
      nextStatus: 'generating',
    });
    try {
      updateNodeData(id, {
        prompt: trimmed,
        model: routedModel.model,
        provider: access.provider,
        status: 'generating',
        error: undefined,
        inputs: nextInputs,
        params: nextParams,
      });
      pushImageSubmitTrace('submit:after-update-node', {
        nodeId: id,
        runId,
      });
    } catch (error) {
      pushImageSubmitTrace('submit:update-node-error', {
        nodeId: id,
        runId,
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : '',
      });
      throw error;
    }

    try {
      pushImageSubmitTrace('submit:before-generate-call', {
        nodeId: id,
        provider: access.provider,
        requestModel: routedModel.requestModel || routedModel.model,
        persistedModel: routedModel.model,
        hasContract: Boolean(nextParams.regionContract),
        inputCount: nextInputs.length,
      });
      const result = await generateNodeOutput({
        nodeId: id,
        nodeType: 'image',
        prompt: requestPrompt,
        provider: access.provider,
        apiKey: access.apiKey || '',
        baseUrl: access.endpoint,
        model: routedModel.requestModel || routedModel.model,
        persistedModel: routedModel.model,
        data: {
          ...(data as unknown as NodeData),
          prompt: requestPrompt,
          model: routedModel.model,
          provider: access.provider,
          status: 'generating',
          inputs: nextInputs,
          params: nextParams,
        },
      });
      pushImageSubmitTrace('submit:after-generate-call', {
        nodeId: id,
        status: typeof result.status === 'string' ? result.status : '',
        hasImageUrl: typeof result.imageUrl === 'string' && result.imageUrl.length > 0,
        outputCount: Array.isArray(result.outputs) ? result.outputs.length : 0,
      });
      const latestNode = useCanvasStore.getState().getNodeById(id);
      const latestRunId = latestNode?.data?.params && typeof latestNode.data.params === 'object'
        ? (latestNode.data.params as Record<string, unknown>).activeRunId
        : undefined;
      if (latestRunId !== runId || submitRunIdRef.current !== runId) return;
      updateNodeData(id, {
        ...result,
        prompt: trimmed,
        inputs: nextInputs,
        params: {
          ...nextParamsBase,
          ...(result.params || {}),
          userPrompt: trimmed,
          executionPrompt,
          requestPrompt,
          posterLayout: generationPosterLayout,
          referenceSettings,
          referenceSummary,
        },
      });
    } catch (error) {
      pushImageSubmitTrace('submit:catch', {
        nodeId: id,
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : '',
      });
      const latestNode = useCanvasStore.getState().getNodeById(id);
      const latestRunId = latestNode?.data?.params && typeof latestNode.data.params === 'object'
        ? (latestNode.data.params as Record<string, unknown>).activeRunId
        : undefined;
      if (latestRunId !== runId || submitRunIdRef.current !== runId) return;
      const generationError = error instanceof GenerationError ? error : null;
      const message = describeGenerationError(error);
      updateNodeData(id, {
        status: 'error',
        error: message,
        inputs: nextInputs,
        params: {
          ...nextParams,
          generationProgress: generationError?.metadata.workflowProgress || [],
          lastError: message,
          lastErrorCategory: generationError?.metadata.category || 'request',
          lastErrorStage: generationError?.metadata.stage,
          lastRequestId: generationError?.metadata.requestId,
          failedAt: Date.now(),
        },
      });
    }
  }

  useEffect(() => {
    const batchToken = String(currentParams.migrationBatchRegenerateToken || '').trim();
    const handledToken = String(currentParams.migrationBatchRegenerateHandledToken || '').trim();
    if (!batchToken || batchToken === handledToken || batchRegenerateTokenRef.current === batchToken) return;
    batchRegenerateTokenRef.current = batchToken;
    updateNodeData(id, {
      params: {
        ...currentParams,
        migrationBatchRegenerateHandledToken: batchToken,
        migrationBatchRegenerateHandledAt: Date.now(),
      },
    });
    if (!canSubmitPrompt || data?.status === 'generating') return;
    void submitPrompt();
  }, [canSubmitPrompt, currentParams, data?.status, id, updateNodeData]);

  useEffect(() => {
    const panelToken = String(currentParams.migrationOpenPanelToken || '').trim();
    const panelMode = String(currentParams.migrationOpenPanelMode || 'panel').trim();
    if (!isNodeInteractionActive || !panelToken || migrationPanelTokenRef.current === panelToken) return;
    migrationPanelTokenRef.current = panelToken;
    setModelMenuOpen(false);
    setToolPanelOpen(false);
    setAssetMenuOpen(panelMode === 'reupload');
  }, [currentParams.migrationOpenPanelMode, currentParams.migrationOpenPanelToken, isNodeInteractionActive]);

  function downloadImage() {
    if (!imageUrl) return;
    const anchor = document.createElement('a');
    anchor.href = imageUrl;
    anchor.download = 'hmdao-image.png';
    anchor.rel = 'noopener';
    anchor.click();
  }

  function exportPosterSvg() {
    if (!imageUrl) return;
    const svg = buildPosterSvgWithEditor(posterExportImageUrl || effectiveRenderImageUrl || imageUrl, posterLayout, resolutionConfig);
    downloadTextFile('hmdao-editable-poster.svg', svg, 'image/svg+xml;charset=utf-8');
  }

  async function rasterizePosterToLibrary() {
    if (!imageUrl) return;
    const svg = buildPosterSvgWithEditor(posterExportImageUrl || effectiveRenderImageUrl || imageUrl, posterLayout, resolutionConfig);
    const { assetId } = await commitPosterToLibrary({
      svg,
      width: resolutionConfig.width,
      height: resolutionConfig.height,
      folderId: 'img-poster',
      name: `海报-${Date.now()}.png`,
    });
    void assetId;
  }

  function openImage() {
    if (!imageUrl) return;
    setLightboxOpen(true);
  }

  function openPosterEditor() {
    if (!imageUrl) return;
    const search = new URLSearchParams({ nodeId: id });
    const width = Math.min(window.screen.availWidth - 80, 1600);
    const height = Math.min(window.screen.availHeight - 80, 980);
    const left = Math.max(40, Math.round((window.screen.availWidth - width) / 2));
    const top = Math.max(32, Math.round((window.screen.availHeight - height) / 2));
    window.open('/poster-editor?' + search.toString(), '_blank', 'popup=yes,width=' + width + ',height=' + height + ',left=' + left + ',top=' + top);
  }

  const nodeTestId = `image-node-${id}`;

  return (
    <div className="relative overflow-visible" data-testid={nodeTestId} data-node-id={id} data-node-type="image">
      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleUploadFile} />

      {isNodeInteractionActive && data?.status !== 'generating' && !hasImage ? (
        <div className="absolute -top-[62px] left-1/2 z-30 flex -translate-x-1/2 items-center gap-2">
          <ActionChip title="上传" onClick={openFilePicker} icon={<Upload className="h-4 w-4" />} />
          <ActionChip title="素材" onClick={() => setAssetMenuOpen((open) => !open)} icon={<FolderOpen className="h-4 w-4" />} />
        </div>
      ) : null}

      {isNodeInteractionActive && data?.status !== 'generating' && hasImage ? (
        <ImageToolbar
          activeTool={activeTool}
          onTool={selectTool}
          onUpload={openFilePicker}
          onToggleAssets={() => setAssetMenuOpen((open) => !open)}
          onDownload={downloadImage}
          onExportPosterSvg={exportPosterSvg}
          onRasterizePoster={() => void rasterizePosterToLibrary()}
          onOpenPosterEditor={openPosterEditor}
          onOpen={openImage}
        />
      ) : null}

      {lightboxOpen ? (
        <ImageLightbox
          url={toRenderableAssetUrl(effectiveRenderImageUrl || imageUrl, 'image')}
          onClose={() => setLightboxOpen(false)}
        />
      ) : null}

      {isNodeInteractionActive && data?.status !== 'generating' && assetMenuOpen ? (
        <AssetPicker assets={imageAssets} onChoose={chooseAsset} emptyText="素材库暂无图片" panelInteractionProps={imagePanelInteractionProps} onInteract={stopImagePanelInteraction} />
      ) : null}

      <div className="relative">
        <div
          className={`relative rounded-lg transition-all duration-150 flex-shrink-0 ${
            isNodeSelected ? 'ring-2 ring-[#9a9a9a] shadow-[0_0_0_1px_rgba(255,255,255,0.22)]' : 'ring-1 ring-[#343434]'
          } ${hasImage ? 'bg-transparent' : 'w-[535px] bg-[#262626]'}`}
          style={hasImage ? { width: displaySize.width } : undefined}
        >
        <EditableNodeTitle nodeId={id} icon={Image} label={data?.label} fallback="图片节点" className="absolute -top-7 left-0" />

        {data?.status === 'generating' ? (
          <div className="rounded-lg bg-[#262626] px-7 py-9">
            <GeneratingSkeleton lines={4} />
            {latestProgress ? (
              <div className="px-3">
                <ProgressBadge
                  label={String(latestProgress.message || latestProgress.stage || '处理中')}
                  progress={Number(latestProgress.progress)}
                />
              </div>
            ) : null}
          </div>
        ) : hasImage && hasRenderableImage && !effectiveImageRenderError ? (
          <div className="relative overflow-hidden rounded-lg bg-[#111] ring-1 ring-[#363636]" style={{ width: displaySize.width, height: displaySize.height }}>
            {activeTool === 'compare' ? (
              <PostComparePreview
                mediaKind="image"
                beforeUrl={toRenderableAssetUrl(originalImageUrl, 'image')}
                afterUrl={effectiveRenderImageUrl}
                className="h-full w-full"
                containerTestId="image-compare-preview"
                dividerTestId="image-compare-divider"
              />
            ) : (
              <>
                <img
                  src={effectiveRenderImageUrl}
                  alt=""
                  decoding="async"
                  draggable={false}
                  className="block h-full w-full object-cover [transform:translateZ(0)]"
                  onLoad={(event) => {
                setImageRenderError(null);
                const target = event.currentTarget;
                const nextMeta = { width: target.naturalWidth || target.width || displaySize.width, height: target.naturalHeight || target.height || displaySize.height };
                if (nextMeta.width > 0 && nextMeta.height > 0 && (!imageMeta || imageMeta.width !== nextMeta.width || imageMeta.height !== nextMeta.height)) {
                  mergeLatestNodeParams({
                    imageMeta: nextMeta,
                  }, {
                    aspectRatio: nextMeta.width >= nextMeta.height ? '16:9' : '9:16',
                  });
                }
              }}
              onError={handleImageRenderFailure}
            />
            {posterLayout.enabled ? (
              <PosterOverlay layout={{ ...posterLayout, editor: posterEditor }} previewHeight={displaySize.height} />
            ) : null}
            <button
              type="button"
              onClick={openFilePicker}
              className="nodrag absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-lg bg-black/70 text-white ring-1 ring-white/10 hover:bg-black/85"
              title="替换图片"
            >
              <Upload className="h-3.5 w-3.5" />
            </button>
              </>
            )}
          </div>
        ) : hasImage && restoringImageUrl ? (
          <div className="rounded-lg bg-[#262626] px-7 py-9">
            <GeneratingSkeleton lines={3} />
            <div className="px-3">
              <ProgressBadge label="恢复本地图片中" progress={52} />
            </div>
          </div>
        ) : hasImage ? (
          <MediaRenderErrorCard
            title={preflightImageIssue?.summary || effectiveImageOutcome?.label}
            message={effectiveImageRenderError || '图片渲染失败，请重试或重新上传。'}
            legacyBlob={isTransientBlobUrl(imageUrl)}
            onRetry={openFilePicker}
            onRegenerate={canSubmitPrompt ? () => {
              void submitPrompt();
            } : undefined}
          />
        ) : (
          <EmptyImageCard status={data?.status} />
        )}

        {effectiveImageOutcome ? (
          <div className={`border-t px-4 py-3 text-[12px] ${effectiveImageOutcome.tone === 'success' ? 'border-emerald-500/20 bg-emerald-500/8 text-emerald-200' : effectiveImageOutcome.tone === 'warning' ? 'border-amber-500/10 bg-amber-500/10 text-amber-200' : 'border-rose-500/20 bg-rose-500/10 text-rose-200'}`}>
            <div className="font-semibold">{effectiveImageOutcome.label}</div>
            <div className="mt-1 opacity-90">{effectiveImageOutcome.reason}</div>
          </div>
        ) : null}

        {contractMode ? (
          <div className="border-t border-sky-500/20 bg-sky-500/8 px-4 py-3 text-[12px] text-sky-100">
            <div className="font-semibold">打标签执行模式</div>
            <div className="mt-1">{regionContractNotice || '已接入打标签节点，当前节点将按上游标签协议执行。'}</div>
            {activeRegionContractEntry ? (
              <div className="mt-2 text-sky-200/90">合同来源：{activeRegionContractEntry.sourceNodeLabel}</div>
            ) : null}
          </div>
        ) : null}

        {data?.status === 'error' ? (
          <div className="px-4 pb-4">
            <ErrorDetailBlock category={lastErrorCategory} message={data?.error || currentParams.lastError} />
          </div>
        ) : null}

        <Handle
          type="target"
          id="image-main"
          data-testid={`image-handle-main-${id}`}
          title="主素材 / composition：连接一张图片，锁定机位、构图布局、镜头关系和空间结构。"
          aria-label="主素材端口：连接一张图片，锁定机位、构图布局、镜头关系和空间结构。"
          position={Position.Left}
          className="image-node-handle"
          style={{ ...handleLeft, top: hasImage ? '42%' : '44%' }}
        >
          <span className="text-[10px] font-bold leading-none text-[#8a8a8a]">主</span>
        </Handle>
        <div
          className="pointer-events-none absolute -left-[106px] z-10 rounded-full bg-[#1c242b] px-2 py-0.5 text-[10px] font-semibold text-[#d7e9f7]"
          style={{ top: `calc(${hasImage ? 42 : 44}% - 10px)` }}
        >
          主素材
        </div>
        {imageReferenceHandles.map((handleConfig, index) => (
          <Handle
            key={handleConfig.id}
            type="target"
            id={handleConfig.id}
            data-testid={`image-handle-reference-${id}-${index}`}
            title={
              handleConfig.lane === 'subject'
                ? `${handleConfig.helperLabel} / subject：连接要替换成的新主体，可连续添加多路主体参考。`
                : `${handleConfig.helperLabel} / omni：连接光影、材质、氛围参考，可连续添加多路光影参考。`
            }
            aria-label={
              handleConfig.lane === 'subject'
                ? `${handleConfig.helperLabel} 端口：连接要替换成的新主体，可连续添加多路主体参考。`
                : `${handleConfig.helperLabel} 端口：连接光影、材质、氛围参考，可连续添加多路光影参考。`
            }
            position={Position.Left}
            className="image-node-handle"
            style={{ ...handleLeft, top: `${handleConfig.topPercent}%` }}
          >
            <span className="text-[10px] font-bold leading-none text-[#8a8a8a]">
              {handleConfig.shortLabel === '光影' ? '光' : '体'}
            </span>
          </Handle>
        ))}
        {imageReferenceHandles.map((handleConfig) => (
          <div
            key={`${handleConfig.id}-label`}
            className={`pointer-events-none absolute -left-[106px] z-10 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
              handleConfig.lane === 'subject'
                ? 'bg-[#18332d] text-[#aaf2df]'
                : 'bg-[#302111] text-[#f6d089]'
            }`}
            style={{ top: `calc(${handleConfig.topPercent}% - 10px)` }}
          >
            {handleConfig.helperLabel}
          </div>
        ))}
        <Handle
          type="target"
          id="image-contract"
          data-testid={`image-handle-contract-${id}`}
          title="打标签：连接 Tagging Node，按标签协议执行主体替换、背景融合与参考绑定。"
          aria-label="打标签端口：连接 Tagging Node，按标签协议执行主体替换、背景融合与参考绑定。"
          position={Position.Left}
          className="image-node-handle"
          style={{ ...handleLeft, top: '22%' }}
        >
          <span className="text-[10px] font-bold leading-none text-[#8a8a8a]">合</span>
        </Handle>
        <div
          className="pointer-events-none absolute -left-[106px] z-10 rounded-full bg-[#1d2330] px-2 py-0.5 text-[10px] font-semibold text-[#c7d6ff]"
          style={{ top: 'calc(22% - 10px)' }}
        >
          打标签
        </div>
        <Handle id="media-output" type="source" position={Position.Right} className="image-node-handle" style={handleRight}>
          <span className="text-xs font-bold leading-none text-[#8a8a8a]">+</span>
        </Handle>
      </div>

      {isNodeInteractionActive && data?.status !== 'generating' && toolPanelOpen && hasToolPanel(activeTool) ? (
        <ImageToolPanelHost
          tool={activeTool}
          value={(currentParams.toolConfig && typeof currentParams.toolConfig === 'object' ? currentParams.toolConfig : {}) as Record<string, unknown>}
          sourceImageUrl={imageUrl}
          nodeLabel={typeof data?.label === 'string' ? data.label : '图片节点'}
          onChange={updateToolConfig}
          onApply={handleToolApply}
          onClose={() => setToolPanelOpen(false)}
          panelInteractionProps={imagePanelInteractionProps}
          onInteract={stopImagePanelInteraction}
        />
      ) : null}
      </div>

      {isNodeInteractionActive ? (
        <PromptPanel
          nodeId={id}
          prompt={prompt}
          conditioningDebugText={conditioningDebugSummary.text}
          conditioningIntent={conditioningDebugSummary.intent}
          capabilityPreviewText={imageCapabilityPreviewText}
          capabilityBoundaryMessage={selectedModelCapabilityBoundaryMessage}
          capabilityBoundaryRecommendedModel={selectedModelCapabilityRecommendation}
          regionContractNotice={regionContractNotice}
          canSubmit={canSubmitPrompt}
          selectedModel={selectedModel}
          models={modelsWithSupport}
          modelMenuOpen={modelMenuOpen}
          ratioText={ratioText}
          resolutionPresetKey={resolutionPresetKey}
          resolutionConfig={resolutionConfig}
          posterLayout={posterLayout}
          selectedCount={selectedCount}
          estimatedCost={estimatedCost}
          estimatedSeconds={estimatedSeconds}
          routedModel={effectiveModel}
          runtimeRecommendations={byokRuntime?.recommendations}
          identityController={identityController}
          backendRealApiEnabled={backendRealApiEnabled}
          backendHealthLoading={backendHealthLoading}
          promptAssistAction={promptAssistAction}
          promptAssistError={promptAssistError}
          assistBaselineAction={assistBaseline?.action ?? null}
          primaryInputs={primaryInputs}
          referenceInputs={referenceInputs}
          onPromptChange={(value: string) => {
            setPrompt(value);
            // 用户手动编辑后，撤销基线失效，避免撤销跳回旧内容
            setAssistBaseline(null);
          }}
          onToggleModelMenu={() => setModelMenuOpen((open) => !open)}
          onChooseModel={chooseModel}
          onUpload={openFilePicker}
          onToggleAssetMenu={() => setAssetMenuOpen((open) => !open)}
          toolSelection={toolSelection}
          activeTool={activeTool}
          onTool={selectTool}
          onSelectResolutionPreset={selectResolutionPreset}
          onCustomResolutionChange={updateCustomResolution}
          onPosterLayoutChange={updatePosterLayout}
          onOpenPosterEditor={openPosterEditor}
          onCountChange={setOutputCount}
          onPromptAssist={handlePromptAssist}
          onReferenceWeightChange={(key, weight) => updateReferenceSetting(key, { weight })}
          onReferenceEnabledChange={(key, enabled) => updateReferenceSetting(key, { enabled })}
          onRemoveReferenceInput={removeBoundReferenceInput}
          onSubmit={submitPrompt}
          panelInteractionProps={imagePanelInteractionProps}
          onPanelInteract={stopImagePanelInteraction}
        />
      ) : null}

      <ModelActivationPrompt
        open={Boolean(activation)}
        mode={activation?.mode || 'image'}
        provider={activation?.provider || selectedModel.provider}
        reason={activation?.reason || 'api-key'}
        onClose={() => setActivation(null)}
      />
    </div>
  );
}

function EmptyImageCard({ status }: { status?: unknown }) {
  return (
    <div className="h-[300px] px-7 py-10">
      <div className="mb-8 flex h-[92px] items-center justify-center">
        <Image className="h-14 w-14 text-[#626262]" />
      </div>
      <div className="mb-4 flex items-center gap-2 text-xs text-[#8f8f8f]">
        <span>状态</span>
        {status ? <StatusBadge status={String(status) as 'idle' | 'generating' | 'completed' | 'error'} /> : null}
      </div>
      <div className="space-y-4 text-[13px] font-semibold text-[#ececec]">
        <div className="flex items-center gap-2.5"><Upload className="h-3.5 w-3.5" />图生图</div>
        <div className="flex items-center gap-2.5"><span className="rounded border border-[#f2f2f2] px-1 text-[10px]">HD</span>图片高清</div>
      </div>
    </div>
  );
}

function MediaRenderErrorCard({
  title,
  message,
  legacyBlob,
  onRetry,
  onRegenerate,
}: {
  title?: string;
  message: string;
  legacyBlob?: boolean;
  onRetry: () => void;
  onRegenerate?: () => void;
}) {
  return (
    <div className="flex h-[300px] flex-col items-center justify-center gap-3 rounded-lg bg-[#1a1a1a] px-6 text-center">
      <div className="text-sm font-semibold text-[#f3f3f3]">{title || (legacyBlob ? '历史本地素材已失效' : '资源渲染失败')}</div>
      <div className="max-w-[280px] text-xs text-[#9f9f9f]">{message}</div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onRetry}
          className="nodrag rounded-md bg-[#2f2f2f] px-3 py-1.5 text-xs text-[#f0f0f0] hover:bg-[#3a3a3a]"
        >
          重新上传
        </button>
        {onRegenerate ? (
          <button
            type="button"
            onClick={onRegenerate}
            className="nodrag rounded-md bg-[#4d3a1f] px-3 py-1.5 text-xs text-[#ffe8bf] hover:bg-[#5b4628]"
          >
            重新生成
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ImageToolbar({
  activeTool,
  onTool,
  onUpload,
  onToggleAssets,
  onDownload,
  onExportPosterSvg,
  onRasterizePoster,
  onOpenPosterEditor,
  onOpen,
}: {
  activeTool: ImageTool | null;
  onTool: (tool: ImageTool) => void;
  onUpload: () => void;
  onToggleAssets: () => void;
  onDownload: () => void;
  onExportPosterSvg: () => void;
  onRasterizePoster: () => void;
  onOpenPosterEditor: () => void;
  onOpen: () => void;
}) {
  return (
    <div className="absolute -top-[82px] left-1/2 z-40 flex h-[52px] w-[920px] max-w-[calc(100vw-48px)] -translate-x-1/2 items-center rounded-xl bg-[#2a2a2a] px-3 shadow-2xl ring-1 ring-[#424242]">
      <IconToolButton title="上传" onClick={onUpload}><Upload className="h-4 w-4" /></IconToolButton>
      <IconToolButton title="素材库" onClick={onToggleAssets}><FolderOpen className="h-4 w-4" /></IconToolButton>
      <div className="mx-2 h-7 w-px bg-[#454545]" />
      <ToolbarButton tool="panorama" activeTool={activeTool} onTool={onTool} icon={<Wand2 className="h-4 w-4" />} />
      <ToolbarButton tool="multiAngle" activeTool={activeTool} onTool={onTool} icon={<Camera className="h-4 w-4" />} />
      <ToolbarButton tool="lighting" activeTool={activeTool} onTool={onTool} icon={<Lightbulb className="h-4 w-4" />} />
      <ToolbarButton tool="grid" activeTool={activeTool} onTool={onTool} icon={<Grid3x3 className="h-4 w-4" />} />
      <ToolbarButton tool="hd" activeTool={activeTool} onTool={onTool} icon={<span className="rounded-sm border border-current px-0.5 text-[10px] leading-3">HD</span>} />
      <ToolbarButton tool="split" activeTool={activeTool} onTool={onTool} icon={<SquareSplitHorizontal className="h-4 w-4" />} />
      <ToolbarButton tool="camera" activeTool={activeTool} onTool={onTool} icon={<Camera className="h-4 w-4" />} />
      <div className="mx-2 h-7 w-px bg-[#454545]" />
      <IconToolButton title="局部编辑" active={activeTool === "brush"} onClick={() => onTool("brush")}><Scissors className="h-4 w-4" /></IconToolButton>
      <IconToolButton title="对比" active={activeTool === "compare"} onClick={() => onTool("compare")}><Maximize2 className="h-4 w-4" /></IconToolButton>
      <IconToolButton title="下载" onClick={onDownload}><Download className="h-4 w-4" /></IconToolButton>
      <IconToolButton title="打开海报编辑器" onClick={onOpenPosterEditor}><Type className="h-4 w-4" /></IconToolButton>
      <IconToolButton title="导出 Figma SVG" onClick={onExportPosterSvg}><Sparkles className="h-4 w-4" /></IconToolButton>
      <IconToolButton title="海报栅格化并入库" onClick={onRasterizePoster}><ImageDown className="h-4 w-4" /></IconToolButton>
      <IconToolButton title="智能去背" active={activeTool === "bgRemove"} onClick={() => onTool("bgRemove")}><Shapes className="h-4 w-4" /></IconToolButton>
      <IconToolButton title="查看大图" onClick={onOpen}><Expand className="h-4 w-4" /></IconToolButton>
    </div>
  );
}

function PromptPanel({
  nodeId,
  prompt,
  conditioningDebugText,
  conditioningIntent,
  capabilityPreviewText,
  capabilityBoundaryMessage,
  capabilityBoundaryRecommendedModel,
  regionContractNotice,
  canSubmit,
  selectedModel,
  models,
  modelMenuOpen,
  ratioText,
  resolutionPresetKey,
  resolutionConfig,
  posterLayout,
  selectedCount,
  estimatedCost,
  estimatedSeconds,
  routedModel,
  runtimeRecommendations,
  identityController,
  backendRealApiEnabled,
  backendHealthLoading,
  promptAssistAction,
  promptAssistError,
  assistBaselineAction,
  primaryInputs,
  referenceInputs,
  onPromptChange,
  onToggleModelMenu,
  onChooseModel,
  onUpload,
  onToggleAssetMenu,
  toolSelection,
  activeTool,
  onTool,
  onSelectResolutionPreset,
  onCustomResolutionChange,
  onPosterLayoutChange,
  onOpenPosterEditor,
  onCountChange,
  onPromptAssist,
  onReferenceWeightChange,
  onReferenceEnabledChange,
  onRemoveReferenceInput,
  onSubmit,
  panelInteractionProps,
  onPanelInteract,
}: {
  nodeId: string;
  prompt: string;
  conditioningDebugText: string;
  conditioningIntent: string;
  capabilityPreviewText: string;
  capabilityBoundaryMessage: string;
  capabilityBoundaryRecommendedModel: string;
  regionContractNotice: string;
  canSubmit: boolean;
  selectedModel: ImageModelOption;
  models: ImageModelOption[];
  modelMenuOpen: boolean;
  ratioText: string;
  resolutionPresetKey: string;
  resolutionConfig: { width: number; height: number; label: string; aspectRatio: string };
  posterLayout: PosterLayoutConfig;
  selectedCount: number;
  estimatedCost: number;
  estimatedSeconds: number;
  routedModel: ImageModelOption;
  runtimeRecommendations?: ByokRuntimeResult['recommendations'] | null;
  identityController: IdentityControllerConfig;
  backendRealApiEnabled: boolean | null;
  backendHealthLoading: boolean;
  promptAssistAction: PromptAssistAction | null;
  promptAssistError: string | null;
  assistBaselineAction: PromptAssistAction | null;
  primaryInputs: ReturnType<typeof collectConnectedReferenceInputs>;
  referenceInputs: ReturnType<typeof collectConnectedReferenceInputs>;
  onPromptChange: (value: string) => void;
  onToggleModelMenu: () => void;
  onChooseModel: (model: ImageModelOption) => void;
  onUpload: () => void;
  onToggleAssetMenu: () => void;
  toolSelection: Array<{ key: ImageGenerationTool; label: string }>;
  activeTool: ImageTool | null;
  onTool: (tool: ImageTool) => void;
  onSelectResolutionPreset: (presetKey: string) => void;
  onCustomResolutionChange: (width: string, height: string) => void;
  onPosterLayoutChange: (patch: Partial<PosterLayoutConfig>) => void;
  onOpenPosterEditor: () => void;
  onCountChange: (count: number) => void;
  onPromptAssist: (action: PromptAssistAction) => void;
  onReferenceWeightChange: (key: string, weight: number) => void;
  onReferenceEnabledChange: (key: string, enabled: boolean) => void;
  onRemoveReferenceInput: (key: string) => void;
  onSubmit: () => void;
  panelInteractionProps: GuardedPanelInteractionProps;
  onPanelInteract: (event: { stopPropagation: () => void }) => void;
}) {
  const { isZh } = useUILanguage();
  const localTranslateState = useLocalTranslateProgress();
  const [customWidthDraft, setCustomWidthDraft] = useState(() => String(resolutionConfig.width));
  const [customHeightDraft, setCustomHeightDraft] = useState(() => String(resolutionConfig.height));

  useEffect(() => {
    setCustomWidthDraft(String(resolutionConfig.width));
    setCustomHeightDraft(String(resolutionConfig.height));
  }, [resolutionConfig.height, resolutionConfig.width]);

  const imageRecommendationCards = useMemo(() => {
    const generationSummary = runtimeRecommendations?.imageGeneration as ByokRuntimeRecommendationSummary | null | undefined;
    const analysisSummary = runtimeRecommendations?.imageAnalysis as ByokRuntimeRecommendationSummary | null | undefined;
    const generationTaskId = conditioningIntent === '保构图换主体'
      ? 'subjectReplaceKeepComposition'
      : conditioningIntent === '全能参考融合'
        ? 'omniReference'
        : conditioningIntent === '多参考融合'
          ? 'multiReferenceBlend'
          : 'styleReference';
    const analysisTaskId = conditioningIntent === '参考增强'
      ? 'promptInterrogation'
      : 'subjectLightingComposition';
    const runtimeCards = [
      taskToRecommendationCard(findRecommendationTask(generationSummary, generationTaskId), {
        purposeLabel: '生成',
        purposeTone: 'recommended',
      }) || summaryToRecommendationCard(generationSummary, {
        purposeLabel: '生成',
        purposeTone: 'recommended',
      }),
      taskToRecommendationCard(findRecommendationTask(analysisSummary, analysisTaskId), {
        purposeLabel: '解析',
        purposeTone: 'api',
      }) || summaryToRecommendationCard(analysisSummary, {
        purposeLabel: '解析',
        purposeTone: 'api',
      }),
    ].filter((card): card is NonNullable<typeof card> => Boolean(card));
    const activeProviderId = resolveProviderGuideId(selectedModel.provider)
      || resolveProviderGuideId(selectedModel.providerLabel)
      || resolveProviderGuideId(selectedModel.id);
    if (!activeProviderId) return runtimeCards;

    const fallbackCards = [
      ...getDirectRecommendationCards(activeProviderId, 'image', isZh, 'image-node'),
      ...getDirectRecommendationCards(activeProviderId, 'llm', isZh, 'image-analysis'),
    ];
    const merged = [...runtimeCards];
    const seen = new Set(merged.map((card) => card.id));
    for (const card of fallbackCards) {
      if (seen.has(card.id)) continue;
      seen.add(card.id);
      merged.push(card);
      if (merged.length >= 4) break;
    }
    return merged;
  }, [conditioningIntent, isZh, runtimeRecommendations, selectedModel.id, selectedModel.provider, selectedModel.providerLabel]);

  const imageModelSections = useMemo(() => {
    const mapItem = (model: ImageModelOption) => ({
      id: model.id,
      title: model.name,
      providerLabel: model.providerLabel,
      modelLabel: model.upstreamModel,
      description: model.description,
      selected: model.id === selectedModel.id,
      disabledReason: model.unsupportedReason || null,
      kind: 'image' as const,
      badges: [
        model.activated ? { label: model.activationModelMatched === false ? model.providerLabel : '已激活', tone: 'free' as const } : { label: model.providerLabel, tone: 'neutral' as const },
        imageModelActivationSourceLabel(model) ? { label: imageModelActivationSourceLabel(model) || '', tone: 'relay' as const } : null,
      ].filter(Boolean),
      meta: [
        `耗时 ${model.latency || '未知'}`,
        `单次 ${formatCurrency(model.price, model.currency)}`,
      ].filter(Boolean),
    });
    return [
      {
        id: 'all',
        title: '模型列表',
        items: models.map(mapItem),
      },
    ];
  }, [models, selectedModel.id]);

  function handleResolutionDraftChange(field: 'width' | 'height', value: string) {
    const sanitized = value.replace(/[^\d]/g, '').slice(0, 4);
    if (field === 'width') {
      setCustomWidthDraft(sanitized);
      return;
    }
    setCustomHeightDraft(sanitized);
  }

  function commitCustomResolution(nextWidth = customWidthDraft, nextHeight = customHeightDraft) {
    onCustomResolutionChange(nextWidth, nextHeight);
  }

  function resetCustomResolutionDraft() {
    setCustomWidthDraft(String(resolutionConfig.width));
    setCustomHeightDraft(String(resolutionConfig.height));
  }

  function handleResolutionKeyDown(event: { key: string; preventDefault: () => void }) {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitCustomResolution();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      resetCustomResolutionDraft();
    }
  }

  return (
    <div
      className="absolute left-1/2 top-full z-30 mt-4 w-[min(660px,calc(100vw-88px))] -translate-x-1/2 nodrag nopan nowheel"
      {...panelInteractionProps}
      onPointerDown={panelInteractionProps.onPointerDown || onPanelInteract}
      onWheel={panelInteractionProps.onWheel || onPanelInteract}
      onMouseDown={panelInteractionProps.onMouseDown || onPanelInteract}
      onTouchStart={panelInteractionProps.onTouchStart || onPanelInteract}
    >
      <div className="max-h-[min(560px,calc(100vh-120px))] overflow-y-auto overscroll-contain rounded-lg bg-[#2b2b2b] shadow-2xl ring-1 ring-[#3c3c3c]">
        <div className="flex items-center justify-between px-3 pt-3">
          <div className="flex items-center gap-2">
            <PanelIconButton icon={<Upload className="h-4 w-4" />} label="上传" onClick={onUpload} testId={`image-upload-${nodeId}`} />
            <PanelIconButton icon={<FolderOpen className="h-4 w-4" />} label="素材" onClick={onToggleAssetMenu} testId={`image-assets-${nodeId}`} />
          </div>
          <button type="button" className="nodrag rounded-md p-1.5 text-[#bdbdbd] hover:bg-[#3a3a3a]" title="展开">
            <Expand className="h-4 w-4" />
          </button>
        </div>

        <textarea
          data-testid={`image-prompt-${nodeId}`}
          placeholder="输入提示词，或在上传图片后追加编辑指令"
          value={prompt}
          onPointerDown={stopCanvasInteraction}
          onWheel={stopCanvasInteraction}
          onMouseDown={stopCanvasInteraction}
          onTouchStart={stopCanvasInteraction}
          onChange={(event) => onPromptChange(event.target.value)}
          aria-label="图片提示词"
          className="nodrag nopan nowheel min-h-[92px] w-full resize-none bg-transparent px-4 py-4 text-sm text-[#e6e6e6] outline-none placeholder:text-[#9a9a9a]"
        />

        <div className="flex flex-wrap items-center gap-2 px-4 pb-2">
          <button
            type="button"
            onPointerDown={stopCanvasInteraction}
            onClick={() => onPromptAssist('optimize')}
            className={`nodrag inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${assistBaselineAction === 'optimize' ? 'border-[#f5a623] text-[#f5a623] hover:bg-[#f5a623]/10' : 'border-[#4a4a4a] text-[#d9d9d9] hover:bg-[#353535]'}`}
            disabled={!prompt.trim() || promptAssistAction !== null}
            title={assistBaselineAction === 'optimize' ? '撤销优化，恢复原始提示词' : '自动优化成更适合模型生成的图片提示词'}
          >
            {promptAssistAction === 'optimize' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            {assistBaselineAction === 'optimize' ? '撤销优化' : '优化提示词'}
          </button>
          <button
            type="button"
            onPointerDown={stopCanvasInteraction}
            onClick={() => onPromptAssist('translate')}
            className={`nodrag inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${assistBaselineAction === 'translate' ? 'border-[#f5a623] text-[#f5a623] hover:bg-[#f5a623]/10' : 'border-[#4a4a4a] text-[#d9d9d9] hover:bg-[#353535]'}`}
            disabled={!prompt.trim() || promptAssistAction !== null}
            title={assistBaselineAction === 'translate' ? '撤销翻译，恢复原始提示词' : '中→英 / 英→中 自动翻译提示词'}
          >
            {promptAssistAction === 'translate' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Languages className="h-3.5 w-3.5" />}
            {assistBaselineAction === 'translate' ? '撤销翻译' : '自动翻译'}
          </button>
          <span className="rounded-full bg-[#343434] px-3 py-1 text-[11px] text-[#d0d0d0]">
            选择平台 {selectedModel.providerLabel}
          </span>
          <span className="rounded-full bg-[#343434] px-3 py-1 text-[11px] text-[#9adfd2]">
            实际上游 {routedModel.upstreamModel}
          </span>
          <span
            data-testid={`image-backend-route-status-${nodeId}`}
            className={`rounded-full px-3 py-1 text-[11px] ${
              backendHealthLoading && backendRealApiEnabled === null
                ? 'bg-[#343434] text-[#d0d0d0]'
                : backendRealApiEnabled
                  ? 'bg-[#20342f] text-[#aaf2df]'
                  : 'bg-amber-500/10 text-amber-300'
            }`}
          >
            生成链路 {backendHealthLoading && backendRealApiEnabled === null ? '检查中' : backendRealApiEnabled ? '真实代理已就绪' : '本地兜底'}
          </span>
          <span className={`rounded-full px-3 py-1 text-[11px] ${identityController.enabled ? 'bg-[#20342f] text-[#aaf2df]' : 'bg-[#343434] text-[#bdbdbd]'}`}>
            身份控制 {identityController.enabled ? (identityController.identityLockMode || 'reference') : '关闭'}
          </span>
          {selectedModel.id !== routedModel.id ? (
            <span className="rounded-full bg-amber-500/10 px-3 py-1 text-[11px] text-amber-300" title={`路由到 ${routedModel.name}`}>
              实际路由 {routedModel.name}
            </span>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2 px-4 pb-2">
          <label className="flex items-center gap-2 rounded-md border border-[#434343] px-2.5 py-1.5 text-xs text-[#d7d7d7]">
            <span>尺寸</span>
            <select
              data-testid={`image-resolution-preset-${nodeId}`}
              value={resolutionPresetKey}
              onPointerDown={stopCanvasInteraction}
              onWheel={stopCanvasInteraction}
              onMouseDown={stopCanvasInteraction}
              onTouchStart={stopCanvasInteraction}
              onChange={(event) => {
                if (event.target.value === 'custom') return;
                onSelectResolutionPreset(event.target.value);
              }}
              className="nodrag nopan nowheel bg-transparent text-xs outline-none"
            >
              {IMAGE_RESOLUTION_PRESETS.map((preset) => (
                <option key={preset.key} value={preset.key} className="bg-[#1f1f1f]">
                  {preset.label}
                </option>
              ))}
              <option value="custom" className="bg-[#1f1f1f]">自定义</option>
            </select>
          </label>
          <label className="flex items-center gap-2 rounded-md border border-[#434343] px-2.5 py-1.5 text-xs text-[#d7d7d7]">
            <span>宽</span>
            <input
              data-testid={`image-resolution-width-${nodeId}`}
              type="text"
              value={customWidthDraft}
              onPointerDown={stopCanvasInteraction}
              onWheel={stopCanvasInteraction}
              onMouseDown={stopCanvasInteraction}
              onTouchStart={stopCanvasInteraction}
              onChange={(event) => handleResolutionDraftChange('width', event.target.value)}
              onBlur={() => commitCustomResolution()}
              onKeyDown={handleResolutionKeyDown}
              className="nodrag nopan nowheel w-16 bg-transparent text-right text-xs outline-none"
              inputMode="numeric"
            />
          </label>
          <label className="flex items-center gap-2 rounded-md border border-[#434343] px-2.5 py-1.5 text-xs text-[#d7d7d7]">
            <span>高</span>
            <input
              data-testid={`image-resolution-height-${nodeId}`}
              type="text"
              value={customHeightDraft}
              onPointerDown={stopCanvasInteraction}
              onWheel={stopCanvasInteraction}
              onMouseDown={stopCanvasInteraction}
              onTouchStart={stopCanvasInteraction}
              onChange={(event) => handleResolutionDraftChange('height', event.target.value)}
              onBlur={() => commitCustomResolution()}
              onKeyDown={handleResolutionKeyDown}
              className="nodrag nopan nowheel w-16 bg-transparent text-right text-xs outline-none"
              inputMode="numeric"
            />
          </label>
          <button
            type="button"
            data-testid={`image-resolution-apply-${nodeId}`}
            onPointerDown={stopCanvasInteraction}
            onClick={() => commitCustomResolution()}
            className="nodrag rounded-md border border-[#4a4a4a] px-2.5 py-1.5 text-xs text-[#d7d7d7] hover:bg-[#353535]"
          >
            应用尺寸
          </button>
          <label className="flex items-center gap-2 rounded-md border border-[#434343] px-2.5 py-1.5 text-xs text-[#d7d7d7]">
            <span>生成数量</span>
            <select
              value={selectedCount}
              onPointerDown={stopCanvasInteraction}
              onWheel={stopCanvasInteraction}
              onMouseDown={stopCanvasInteraction}
              onTouchStart={stopCanvasInteraction}
              onChange={(event) => onCountChange(Number(event.target.value))}
              className="nodrag nopan nowheel bg-transparent text-xs outline-none"
            >
              {OUTPUT_COUNT_OPTIONS.map((count) => (
                <option key={count} value={count} className="bg-[#1f1f1f]">
                  {count} 张
                </option>
              ))}
            </select>
          </label>
          <span className="rounded-md bg-[#1f1f1f] px-2.5 py-1.5 text-xs text-[#9ee6d9]">
            预估耗时 {formatEta(estimatedSeconds)}
          </span>
          <span className="rounded-md bg-[#1f1f1f] px-2.5 py-1.5 text-xs text-[#f3d38a]">
            预估费用 {formatCurrency(estimatedCost, routedModel.currency)}
          </span>
        </div>

        {/* 提示词辅助错误 */}
        {promptAssistError ? (
          <div className="mx-4 mb-3 space-y-2">
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs leading-5 text-rose-200">
              <div className="font-semibold text-rose-300">提示词辅助失败</div>
              <div className="mt-1">{promptAssistError}</div>
            </div>
            {promptAssistError.includes('模型下载') || promptAssistError.includes('模型加载') || promptAssistError.includes('本地翻译') || promptAssistError.includes('未安装') ? (
              <Link
                to="/settings/models"
                className="inline-flex items-center gap-1 rounded-lg bg-rose-500/20 px-2.5 py-1.5 text-[11px] font-medium text-rose-300 hover:bg-rose-500/30 transition-colors"
              >
                <Download className="h-3 w-3" />
                前往模型下载面板安装
              </Link>
            ) : null}
            {promptAssistError.includes('API Key') || promptAssistError.includes('密钥') ? (
              <Link
                to="/settings/api-keys"
                className="inline-flex items-center gap-1 rounded-lg bg-rose-500/20 px-2.5 py-1.5 text-[11px] font-medium text-rose-300 hover:bg-rose-500/30 transition-colors"
              >
                <KeyRound className="h-3 w-3" />
                前往配置 API 密钥
              </Link>
            ) : null}
          </div>
        ) : null}
        {capabilityBoundaryMessage ? (
          <div
            data-testid={`image-model-capability-boundary-${nodeId}`}
            className="mx-4 mb-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs leading-6 text-amber-100"
          >
            <div className="font-semibold text-amber-200">当前模型可被选中，但不满足这次任务需求</div>
            <div className="mt-1">{capabilityBoundaryMessage}</div>
            {capabilityBoundaryRecommendedModel ? (
              <div className="mt-2 text-amber-300">推荐模型：{capabilityBoundaryRecommendedModel}</div>
            ) : null}
          </div>
        ) : null}
        {regionContractNotice ? (
          <div className="mx-4 mb-3 rounded-2xl border border-sky-500/20 bg-sky-500/10 px-4 py-3 text-xs leading-6 text-sky-100">
            <div className="font-semibold text-sky-200">打标签摘要</div>
            <div className="mt-1">{regionContractNotice}</div>
          </div>
        ) : null}

        <div className="relative px-4 pb-3">
          <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-[#3f464f] bg-[#1b1f24] px-3 py-3">
            <button
              type="button"
              onPointerDown={stopCanvasInteraction}
              onClick={onToggleModelMenu}
              data-testid={`image-model-toggle-${nodeId}`}
              className="nodrag inline-flex min-w-[240px] flex-1 items-center gap-2 rounded-xl border border-[#4b5560] bg-[#14181d] px-3 py-2 text-left text-sm font-semibold text-[#f0f0f0] transition-colors hover:bg-[#1d232a]"
              aria-expanded={modelMenuOpen}
            >
              <Sparkles className="h-4 w-4" />
              <span className="truncate">{selectedModel.providerLabel} · {selectedModel.upstreamModel}</span>
              {selectedModel.activated ? (
                <span className="shrink-0 text-xs text-emerald-400">
                  {selectedModel.activationModelMatched === false ? '平台已激活' : '已验证此模型'}
                </span>
              ) : null}
              {imageModelActivationSourceLabel(selectedModel) ? (
                <SourceBadge label={imageModelActivationSourceLabel(selectedModel) || 'via Relay'} tone="relay" />
              ) : null}
              {selectedModel.id !== routedModel.id ? (
                <span className="shrink-0 text-xs text-sky-300">实际 {routedModel.upstreamModel}</span>
              ) : null}
              <ChevronDown className={`ml-auto h-3.5 w-3.5 shrink-0 transition-transform ${modelMenuOpen ? 'rotate-180' : ''}`} />
            </button>
          </div>

          {modelMenuOpen ? (
            <div className="absolute left-4 top-[calc(100%+8px)] z-20">
              <NodeModelBrowser
                title="选择模型"
                subtitle="悬停模型查看能力说明，点击切换"
                recommendations={undefined}
                sections={imageModelSections}
                onSelect={(item) => {
                  const model = models.find((entry) => entry.id === item.id);
                  if (!model) return;
                  onChooseModel(model);
                }}
                testId={`image-model-browser-${nodeId}`}
                itemTestIdPrefix={`image-model-option-${nodeId}`}
              />
            </div>
          ) : null}
        </div>

        {/* 端口输入概览已简化，详细绑定通过端口连接可视化确认 */}

        <PosterLayoutPanel
          layout={posterLayout}
          onChange={onPosterLayoutChange}
          onOpenEditor={onOpenPosterEditor}
          panelInteractionProps={panelInteractionProps}
          onInteract={onPanelInteract}
        />

        <div className="flex flex-wrap gap-2 px-4 pb-1">
          {toolSelection.map((tool) => (
            <button
              key={tool.key}
              type="button"
              onPointerDown={stopCanvasInteraction}
              onClick={() => onTool(tool.key)}
              data-testid={`image-tool-chip-${nodeId}-${tool.key}`}
              className={`nodrag rounded-full border px-3 py-1 text-xs transition-colors ${
                activeTool === tool.key
                  ? 'border-[#707070] bg-[#414141] text-white'
                  : 'border-[#4a4a4a] text-[#d7d7d7] hover:border-[#666] hover:bg-[#353535]'
              }`}
            >
              {tool.label}
            </button>
          ))}
        </div>

        <div className="relative flex items-center gap-3 border-t border-[#3a3a3a] px-4 py-3">
          <span className="rounded-full bg-[#333] px-2.5 py-1 text-xs font-medium text-[#e4e4e4]">
            {ratioText} · {resolutionConfig.width}×{resolutionConfig.height}
          </span>
            <button
              type="button"
              onPointerDown={stopCanvasInteraction}
            onClick={() => onTool('camera')}
            className={`nodrag flex items-center gap-1.5 rounded-md px-2 py-1 text-xs hover:bg-[#3a3a3a] ${activeTool === 'camera' ? 'bg-[#3e3e3e] text-white' : 'text-[#e4e4e4]'}`}
          >
            <Camera className="h-3.5 w-3.5" />
            镜头
          </button>
          <button
            type="button"
            onPointerDown={stopCanvasInteraction}
            onClick={() => onTool('panorama')}
            className={`nodrag flex items-center gap-1.5 rounded-md px-2 py-1 text-xs hover:bg-[#3a3a3a] ${activeTool === 'panorama' ? 'bg-[#3e3e3e] text-white' : 'text-[#e4e4e4]'}`}
          >
            <Wand2 className="h-3.5 w-3.5" />
            全景
          </button>

          <div className="ml-auto flex items-center gap-3 text-[#d7d7d7]">
            <span className="text-xs text-[#cfcfcf]">{selectedCount} 张</span>
            <span className="text-xs text-[#cfcfcf]">{formatCurrency(estimatedCost, routedModel.currency)}</span>
            <Zap className="h-3.5 w-3.5 text-[#bdbdbd]" />
            <button type="button" className="nodrag rounded-md p-1.5 hover:bg-[#3a3a3a]" title="重置">
              <RotateCcw className="h-4 w-4" />
            </button>
            <button
              type="button"
              onPointerDown={stopCanvasInteraction}
              onClick={onSubmit}
              data-testid={`image-generate-${nodeId}`}
              disabled={!canSubmit}
              className="nodrag flex h-8 w-8 items-center justify-center rounded-lg bg-[#bdbdbd] text-[#252525] transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
              title="生成"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PanelIconButton({ icon, label, onClick, testId }: { icon: ReactNode; label: string; onClick?: () => void; testId?: string }) {
  return (
    <button
      type="button"
      onPointerDown={stopCanvasInteraction}
      onClick={onClick}
      data-testid={testId}
      className="nodrag flex h-12 w-12 flex-col items-center justify-center gap-1 rounded-lg border border-[#4a4a4a] text-xs text-[#cfcfcf] hover:bg-[#353535]"
      title={label}
    >
      {icon}
      {label}
    </button>
  );
}

function ToolbarButton({
  tool,
  activeTool,
  onTool,
  icon,
}: {
  tool: ImageTool;
  activeTool: ImageTool | null;
  onTool: (tool: ImageTool) => void;
  icon: ReactNode;
}) {
  const active = activeTool === tool;
  return (
    <button
      type="button"
      onPointerDown={stopCanvasInteraction}
      onClick={() => onTool(tool)}
      className={`nodrag flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-sm font-semibold transition-colors ${
        active ? 'bg-[#3e3e3e] text-white' : 'text-[#ececec] hover:bg-[#373737]'
      }`}
      title={TOOL_LABELS[tool]}
    >
      {icon}
      <span>{TOOL_LABELS[tool]}</span>
      <ChevronDown className="h-3.5 w-3.5 text-[#c8c8c8]" />
    </button>
  );
}

function IconToolButton({
  title,
  active,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onPointerDown={stopCanvasInteraction}
      onClick={onClick}
      className={`nodrag flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors ${
        active ? 'bg-[#3e3e3e] text-white' : 'text-[#eeeeee] hover:bg-[#373737]'
      }`}
      title={title}
    >
      {children}
    </button>
  );
}

function ActionChip({ title, onClick, icon }: { title: string; onClick: () => void; icon: ReactNode }) {
  return (
    <button
      type="button"
      onPointerDown={stopCanvasInteraction}
      onClick={onClick}
      className="nodrag flex h-8 items-center gap-1.5 rounded-lg bg-[#2f2f2f] px-3 text-sm font-semibold text-[#f0f0f0] shadow-lg ring-1 ring-[#444] hover:bg-[#3a3a3a]"
      title={title}
    >
      {icon}
      {title}
    </button>
  );
}

function AssetPicker({
  assets,
  onChoose,
  emptyText,
  panelInteractionProps,
  onInteract,
}: {
  assets: AssetItem[];
  onChoose: (asset: AssetItem) => void;
  emptyText: string;
  panelInteractionProps: GuardedPanelInteractionProps;
  onInteract: (event: { stopPropagation: () => void }) => void;
}) {
  return (
    <div
      className="absolute -top-[14px] left-1/2 z-50 max-h-[280px] w-[420px] -translate-x-1/2 translate-y-[58px] overflow-y-auto rounded-xl bg-[#242424] p-3 shadow-2xl ring-1 ring-[#4b4b4b]"
      {...panelInteractionProps}
      onPointerDown={panelInteractionProps.onPointerDown || onInteract}
      onMouseDown={panelInteractionProps.onMouseDown || onInteract}
      onTouchStart={panelInteractionProps.onTouchStart || onInteract}
      onWheel={panelInteractionProps.onWheel || onInteract}
    >
      <div className="mb-2 text-xs font-semibold text-[#d8d8d8]">选择素材</div>
      <div className="grid grid-cols-3 gap-2">
        {assets.length > 0 ? assets.map((asset) => (
          <button
            type="button"
            key={asset.id}
            onPointerDown={onInteract}
            onClick={() => onChoose(asset)}
            className="nodrag overflow-hidden rounded-lg bg-[#1b1b1b] text-left ring-1 ring-[#363636] hover:ring-[#888]"
            title={asset.name}
          >
            {toRenderableAssetUrl(asset.thumbnail || asset.url, 'image') ? (
              <img src={toRenderableAssetUrl(asset.thumbnail || asset.url, 'image')} alt="" className="h-20 w-full object-cover" />
            ) : (
              <div className="flex h-20 w-full items-center justify-center bg-[#202020] text-[11px] text-[#8f8f8f]">
                预览不可用
              </div>
            )}
            <div className="truncate px-2 py-1 text-[11px] text-[#d7d7d7]">{asset.name}</div>
          </button>
        )) : (
          <div className="col-span-3 rounded-lg border border-dashed border-[#555] px-3 py-5 text-center text-xs text-[#8f8f8f]">
            {emptyText}
          </div>
        )}
      </div>
    </div>
  );
}

function getImageDisplaySize(meta: ImageMeta | null) {
  const ratio = meta && meta.height > 0 ? meta.width / meta.height : 16 / 9;
  if (ratio >= 1) {
    const width = 536;
    return { width, height: Math.round(width / ratio) };
  }
  const height = 535;
  return { width: Math.round(height * ratio), height };
}

function gcd(a: number, b: number): number {
  let x = Math.round(Math.abs(a));
  let y = Math.round(Math.abs(b));
  while (y) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1;
}

const handleLeft: CSSProperties = { left: -22 };
const handleRight: CSSProperties = { right: -22 };

function imageReferenceLaneMeta(input: ConnectedReferenceInput) {
  const handleId = String(input.handleId || '');
  if (handleId.startsWith('image-lighting-reference') || input.role === 'omni' || input.role === 'lighting' || input.role === 'style') {
    return {
      lane: 'lighting' as const,
      laneLabel: '光影参考',
      roleLabel: input.role === 'style' ? '风格增强' : input.role === 'lighting' ? '光影增强' : '光影氛围',
      toneClass: 'border-[#6b4c25] bg-[#302111] text-[#f6d089]',
      sliderClass: 'accent-[#f0b35a]',
    };
  }
  return {
    lane: 'subject' as const,
    laneLabel: '主体参考',
    roleLabel: '替换主体',
    toneClass: 'border-[#315f57] bg-[#18332d] text-[#aaf2df]',
    sliderClass: 'accent-[#4bd3b2]',
  };
}

function renderConnectedInputLabel(input: ConnectedReferenceInput) {
  const label = String(input.sourceNodeLabel || input.label || '').trim();
  if (label) return label;
  return input.channel === 'primary' ? '主素材' : '参考素材';
}

function ImagePortInputSummary({
  nodeId,
  primaryInputs,
  referenceInputs,
  onWeightChange,
  onEnabledChange,
  onRemoveInput,
}: {
  nodeId: string;
  primaryInputs: ConnectedReferenceInput[];
  referenceInputs: ConnectedReferenceInput[];
  onWeightChange: (key: string, weight: number) => void;
  onEnabledChange: (key: string, enabled: boolean) => void;
  onRemoveInput: (key: string) => void;
}) {
  const subjectReferences = referenceInputs.filter((input) => imageReferenceLaneMeta(input).lane === 'subject');
  const lightingReferences = referenceInputs.filter((input) => imageReferenceLaneMeta(input).lane === 'lighting');

  return (
    <div className="mx-4 mb-3 rounded-xl border border-[#404040] bg-[#202020] p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-[#f3f3f3]">输入已按端口自动绑定</div>
          <div className="mt-1 text-xs leading-5 text-[#a9a9a9]">
            主素材接到 `composition` 端口后就锁定构图。主体图请接“主体参考”，光影/风格图请接“光影参考”，不再需要重复在面板里做二次绑定。
          </div>
        </div>
        <span className="rounded-full bg-[#323232] px-2.5 py-1 text-[11px] text-[#c9c9c9]">
          主素材 {primaryInputs.length} 路 · 主体 {subjectReferences.length} 路 · 光影 {lightingReferences.length} 路
        </span>
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-3">
        <div className="rounded-lg border border-[#36404a] bg-[#161a1f] px-3 py-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8ea0b2]">composition</div>
          <div className="mt-1 text-sm font-semibold text-[#eef3f8]">主素材 / 保构图</div>
          <div className="mt-1 text-[11px] leading-5 text-[#97a8b8]">锁定机位、构图布局、镜头关系和空间结构。</div>
        </div>
        <div className="rounded-lg border border-[#315f57] bg-[#18332d] px-3 py-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8ce2cf]">subject</div>
          <div className="mt-1 text-sm font-semibold text-[#dffaf3]">主体参考 / 换主体</div>
          <div className="mt-1 text-[11px] leading-5 text-[#b9efe2]">替换主物体本身，可连续挂多路主体参考做补充。</div>
        </div>
        <div className="rounded-lg border border-[#6b4c25] bg-[#302111] px-3 py-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#f1c982]">omni</div>
          <div className="mt-1 text-sm font-semibold text-[#fff0ce]">光影参考 / 氛围风格</div>
          <div className="mt-1 text-[11px] leading-5 text-[#f4d9a0]">只负责光影、材质、氛围与风格，不覆盖主体和构图。</div>
        </div>
      </div>

      {primaryInputs.length > 0 ? (
        <div className="mt-3 rounded-lg border border-[#36404a] bg-[#161a1f] px-3 py-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8ea0b2]">已接入主素材</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {primaryInputs.map((input) => (
              <span key={input.key} className="rounded-full bg-[#28323c] px-2.5 py-1 text-[11px] text-[#e6eef6]">
                {renderConnectedInputLabel(input)}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-3 grid gap-2">
        {referenceInputs.length > 0 ? (
          referenceInputs.map((input, index) => {
            const laneMeta = imageReferenceLaneMeta(input);
            return (
              <div
                key={input.key}
                data-testid={`image-port-input-card-${nodeId}-${index}`}
                className="rounded-lg border border-[#454545] bg-[#262626] px-3 py-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-[#f0f0f0]">{renderConnectedInputLabel(input)}</div>
                    <div className="mt-1 text-[11px] text-[#9a9a9a]">
                      {laneMeta.laneLabel} · {laneMeta.roleLabel}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full border px-2.5 py-1 text-[10px] ${laneMeta.toneClass}`}>
                      {laneMeta.laneLabel}
                    </span>
                    <label className="flex items-center gap-2 text-xs text-[#d7d7d7]">
                      <span>启用</span>
                      <input
                        data-testid={`reference-enabled-${nodeId}-${index}`}
                        type="checkbox"
                        checked={input.enabled}
                        onChange={(event) => onEnabledChange(input.key, event.target.checked)}
                      />
                    </label>
                    {input.isManualBinding ? (
                      <button
                        type="button"
                        data-testid={`reference-remove-${nodeId}-${input.key}`}
                        onClick={() => onRemoveInput(input.key)}
                        className="rounded-md border border-[#4a4a4a] px-2 py-1 text-[11px] text-[#d8d8d8] hover:bg-[#333]"
                      >
                        移除
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="mt-3 grid gap-2 md:grid-cols-[1fr_72px]">
                  <label className="grid gap-1 text-xs text-[#d9d9d9]">
                    <span>参考权重</span>
                    <input
                      data-testid={`reference-weight-${nodeId}-${index}`}
                      className={laneMeta.sliderClass}
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={input.weight}
                      onChange={(event) => onWeightChange(input.key, Number(event.target.value))}
                    />
                  </label>
                  <div className="flex items-end justify-end text-sm font-semibold text-[#9ee6d9]">{input.weight}</div>
                </div>
              </div>
            );
          })
        ) : (
          <div className="rounded-lg border border-dashed border-[#4a4a4a] px-3 py-4 text-xs text-[#9a9a9a]">
            还没有接入参考图。直接把参考图拖线接到“主体参考”或“光影参考”端口即可，连接完成后会自动写回对应语义。
          </div>
        )}
      </div>
    </div>
  );
}





