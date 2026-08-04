import { proxyRequest } from '@/api/proxy';
import { buildImageToolPrompt, getImageToolPreset } from '@/config/imageToolPresets';
import {
  extractPersistedAssetIdFromUrl,
  importLocalAssetFile,
  resolvePersistedAssetLibraryUrl,
} from '@/api/assetLibrary';
import type { CatalogModel } from '@/api/models';
import type { CanvasNode, MediaInput, MediaOutput, NodeData, NodeType } from '@/types';
import { resolveSharedAgentMemories, serializeSharedMemoryReferences } from '@/services/agentMemory';
import {
  buildImageModelCapabilityRequirements,
  buildNodeWorkflowGraph,
  evaluateModelCapabilitySupport,
  readIdentityControllerConfig,
} from '@/services/workflowGraph';
import { buildRegionContractMediaInputs, readRegionContract, serializeRegionPack } from '@/services/regionContracts';
import { extractFallbackChain, resolveModelForTask, type ModelCandidate } from '@/services/modelFallback';
import { findProviderKeyState, providerKeyMatchesModel, type ProviderKeyState } from '@/store/useApiKeyStore';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import { normalizeProviderId } from '@/lib/providerAlias';
import { isLocalMediaHandle, isTransientBlobUrl, readLocalMediaBlob, resolveLocalMediaUrl } from '@/services/localMediaRegistry';
import {
  getWorkflowClient,
  type WorkflowNodeResult,
  type WorkflowProgressSnapshot,
  type WorkflowStatusPayload,
} from '@/services/workflow';
import { allowsLocalCanvasDemoAccess } from '@/utils/demoMode';
import { z } from 'zod';
import {
  type GenerationMode,
  type GenerationAccess,
  type GenerationErrorMetadata,
  type RenderableAssetKind,
  type RenderableAssetIssue,
  type CanvasMigrationIssue,
  type ProxyGenerationResult,
  type WorkflowGenerationResult,
  type ProxyRoutePreviewResult,
  type SanitizedGenerationBody,
  type GenerationCacheEntry,
  PROVIDER_MODE_SUPPORT,
  PROVIDER_PRIORITY,
  MODE_PROVIDERS,
  GENERATION_CACHE_STORAGE_KEY,
  GENERATION_CACHE_TTL_MS,
  IMAGE_GENERATION_TIMEOUT_MS,
  VIDEO_GENERATION_TIMEOUT_MS,
  GENERATION_ASSET_MATERIALIZE_TIMEOUT_MS,
  CONDITIONING_IMAGE_NORMALIZE_TIMEOUT_MS,
} from './generation.shared';

// Re-export public types so existing importers of '@/services/generation' keep working.
export type {
  GenerationMode,
  GenerationAccess,
  GenerationErrorMetadata,
  RenderableAssetKind,
  RenderableAssetIssue,
  CanvasMigrationIssue,
  ProxyGenerationResult,
  WorkflowGenerationResult,
  ProxyRoutePreviewResult,
  SanitizedGenerationBody,
  GenerationCacheEntry,
};

export class GenerationError extends Error {
  metadata: GenerationErrorMetadata;

  constructor(message: string, metadata: GenerationErrorMetadata) {
    super(message);
    this.name = 'GenerationError';
    this.metadata = metadata;
  }
}

function normalizeErrorCategory(value: unknown): GenerationErrorMetadata['category'] {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'validation' || raw === 'timeout' || raw === 'auth' || raw === 'quota' || raw === 'routing' || raw === 'upstream' || raw === 'render') {
    return raw;
  }
  return 'request';
}

export function describeGenerationError(error: unknown): string {
  if (error instanceof GenerationError) {
    switch (error.metadata.category) {
      case 'validation':
        return '\u53c2\u6570\u914d\u7f6e\u6709\u8bef\uff1a' + error.message;
      case 'auth':
        return '\u9274\u6743\u5931\u8d25\uff1a' + error.message;
      case 'quota':
        return '\u4f59\u989d\u4e0d\u8db3\uff1a' + error.message;
      case 'timeout':
        return '\u8bf7\u6c42\u8d85\u65f6\uff1a' + error.message;
      case 'routing':
        return '\u8def\u7531\u4e0d\u53ef\u7528\uff1a' + error.message;
      case 'upstream':
        return '\u6a21\u578b\u670d\u52a1\u5f02\u5e38\uff1a' + error.message;
      case 'render':
        return '\u8d44\u6e90\u6e32\u67d3\u5931\u8d25\uff1a' + error.message;
      default:
        return error.message;
    }
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
const aspectRatioSchema = z.string().trim().regex(/^\d+:\d+$/).default('16:9');
const resolutionSchema = z.object({
  width: z.number().int().min(256).max(4096),
  height: z.number().int().min(256).max(4096),
  label: z.string().min(3),
});

const llmBodySchema = z.object({
  model: z.string().min(1),
  messages: z.array(z.object({
    role: z.literal('user'),
    content: z.string().min(1),
  })).min(1),
  max_tokens: z.number().int().min(32).max(8192),
  temperature: z.number().min(0).max(2),
  workflow_graph: z.record(z.string(), z.unknown()).optional(),
  shared_memory_ids: z.array(z.string().min(1)).optional(),
  shared_memory_layers: z.array(z.string().min(1)).optional(),
  shared_memory_context: z.array(z.string().min(1)).optional(),
  shared_memory_refs: z.array(z.record(z.string(), z.unknown())).optional(),
});

const imageBodySchema = z.object({
  model: z.string().min(1),
  prompt: z.string().min(1),
  aspect_ratio: aspectRatioSchema,
  quality: z.string().min(1),
  resolution: z.string().optional(),
  width: z.number().int().min(256).max(4096).optional(),
  height: z.number().int().min(256).max(4096).optional(),
  steps: z.number().int().min(1).max(80),
  seed: z.number().int().optional(),
  source_url: z.string().min(1).optional(),
  source_asset_id: z.string().min(1).optional(),
  source_media_type: z.string().min(1).optional(),
  primary_assets: z.array(z.record(z.string(), z.unknown())).optional(),
  panorama: z.boolean().optional(),
  multi_angle: z.boolean().optional(),
  lighting: z.boolean().optional(),
  grid: z.union([z.string().min(1), z.null()]).optional(),
  split: z.union([z.string().min(1), z.null()]).optional(),
  image_tool: z.union([z.string().min(1), z.null()]).optional(),
  base_prompt: z.string().min(1).optional(),
  tool_prompt: z.string().min(1).optional(),
  tool_operation: z.string().min(1).optional(),
  tool_capability: z.string().min(1).optional(),
  tool_config: z.record(z.string(), z.unknown()).optional(),
  generation_mode: z.string().min(1).optional(),
  reference_image_url: z.string().min(1).optional(),
  reference_assets: z.array(z.record(z.string(), z.unknown())).optional(),
  reference_summary: z.record(z.string(), z.unknown()).optional(),
  conditioning_strategy: z.record(z.string(), z.unknown()).optional(),
  enhancement_strategy: z.record(z.string(), z.unknown()).optional(),
  camera_control: z.boolean().optional(),
  count: z.number().int().min(1).max(4).optional(),
  workflow_graph: z.record(z.string(), z.unknown()).optional(),
  region_pack: z.record(z.string(), z.unknown()).optional(),
  identity_controller: z.record(z.string(), z.unknown()).optional(),
  shared_memory_ids: z.array(z.string().min(1)).optional(),
  shared_memory_layers: z.array(z.string().min(1)).optional(),
  shared_memory_context: z.array(z.string().min(1)).optional(),
  shared_memory_refs: z.array(z.record(z.string(), z.unknown())).optional(),
});

const videoBodySchema = z.object({
  model: z.string().min(1),
  prompt: z.string().min(1),
  aspect_ratio: aspectRatioSchema,
  quality: z.string().min(1),
  resolution: z.string().optional(),
  width: z.number().int().min(256).max(4096).optional(),
  height: z.number().int().min(256).max(4096).optional(),
  steps: z.number().int().min(1).max(80),
  seed: z.number().int().optional(),
  source_url: z.string().min(1).optional(),
  source_asset_id: z.string().min(1).optional(),
  source_media_type: z.string().min(1).optional(),
  primary_assets: z.array(z.record(z.string(), z.unknown())).optional(),
  fps: z.number().int().min(8).max(60),
  duration: z.number().int().min(1).max(30),
  first_frame_url: z.string().min(1).optional(),
  last_frame_url: z.string().min(1).optional(),
  clip: z.boolean().optional(),
  crop: z.boolean().optional(),
  parse: z.boolean().optional(),
  remove_subtitle: z.boolean().optional(),
  audio_split: z.boolean().optional(),
  video_tool: z.union([z.string().min(1), z.null()]).optional(),
  generation_mode: z.string().min(1).optional(),
  motion_preset: z.string().min(1).optional(),
  style_preset: z.string().min(1).optional(),
  motion_strength: z.number().min(0).max(1).optional(),
  consistency_strength: z.number().min(0).max(1).optional(),
  reference_weight: z.number().min(0).max(1).optional(),
  reference_image_url: z.string().min(1).optional(),
  reference_video_url: z.string().min(1).optional(),
  reference_assets: z.array(z.record(z.string(), z.unknown())).optional(),
  reference_summary: z.record(z.string(), z.unknown()).optional(),
  conditioning_strategy: z.record(z.string(), z.unknown()).optional(),
  enhancement_strategy: z.record(z.string(), z.unknown()).optional(),
  linked_audio_url: z.string().min(1).optional(),
  linked_audio_asset_id: z.string().min(1).optional(),
  linked_audio_mode: z.string().min(1).optional(),
  linked_audio_label: z.string().min(1).optional(),
  linked_audio_backend: z.string().min(1).optional(),
  audio_mix_mode: z.string().min(1).optional(),
  audio_gain: z.number().min(0).max(2).optional(),
  video_gain: z.number().min(0).max(2).optional(),
  tool_operation: z.string().min(1).optional(),
  tool_config: z.record(z.string(), z.unknown()).optional(),
  count: z.number().int().min(1).max(4).optional(),
  workflow_graph: z.record(z.string(), z.unknown()).optional(),
  region_pack: z.record(z.string(), z.unknown()).optional(),
  identity_controller: z.record(z.string(), z.unknown()).optional(),
  shared_memory_ids: z.array(z.string().min(1)).optional(),
  shared_memory_layers: z.array(z.string().min(1)).optional(),
  shared_memory_context: z.array(z.string().min(1)).optional(),
  shared_memory_refs: z.array(z.record(z.string(), z.unknown())).optional(),
});

const audioBodySchema = z.object({
  model: z.string().min(1),
  input: z.string().min(1),
  voice: z.string().min(1),
  sample_rate: z.number().int().min(8000).max(48000),
});

const PROVIDER_HINTS: Record<string, string> = {
  'lib-image': 'siliconflow',
  'qwen-image': 'siliconflow',
  'gpt-image-2': 'openai',
  'grok-imagine-1.5-edit-apimart': 'openai',
  'doubao-seedream-5-0-lite': 'volcengine',
  'doubao-seedream-5-0-pro': 'volcengine',
  'gemini-3-pro-image-preview': 'openai',
  'seedream-4': 'volcengine',
  'doubao-seedance-2-0': 'volcengine',
  'doubao-audio-1-0': 'volcengine',
  'flux-pro': 'fal',
  'wanx-v1': 'bailian',
  'wan22-t2v-a14b': 'siliconflow',
  'wan22-i2v-a14b': 'siliconflow',
  'wan-ai/wan2.2-t2v-a14b': 'siliconflow',
  'wan-ai/wan2.2-i2v-a14b': 'siliconflow',
  'bailian-wan22-t2v-plus': 'bailian',
  'bailian-wan22-i2v-plus': 'bailian',
  'wan2.2-t2v-plus': 'bailian',
  'wan2.2-i2v-plus': 'bailian',
  'seedance-v2': 'fal',
  'happyhorse-11': 'bailian',
  'kling-o3': 'kling',
  'wanx-video': 'kling',
  'deepseek-chat': 'deepseek',
};

function normalizeRequestedModelIdentifier(value: string | undefined | null) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return '';
  if (/gpt[\-_/ ]?image(?:[\-_/ ]?(?:1|1\.0|1\.5))?/.test(normalized) && !/2/.test(normalized)) return 'gpt-image-2';
  if (/gpt[\-_/ ]?image[\-_/ ]?2/.test(normalized)) return 'gpt-image-2';
  if (/grok[\-_/ ]?imagine[\-_/ ]?1\.5[\-_/ ]?edit/.test(normalized)) return 'grok-imagine-1.5-edit-apimart';
  if (/seedream[\-_/ ]?4(?:\.0)?/.test(normalized) || /doubao[\-_/ ]?seedream[\-_/ ]?4(?:\.0)?/.test(normalized)) {
    return 'doubao-seedream-5-0-lite';
  }
  if (/seedream[\-_/ ]?5(?:\.0)?[\-_/ ]?lite/.test(normalized) || /doubao[\-_/ ]?seedream[\-_/ ]?5(?:\.0)?[\-_/ ]?lite/.test(normalized)) {
    return 'doubao-seedream-5-0-lite';
  }
  if (/seedream[\-_/ ]?5(?:\.0)?[\-_/ ]?pro/.test(normalized) || /doubao[\-_/ ]?seedream[\-_/ ]?5(?:\.0)?[\-_/ ]?pro/.test(normalized)) {
    return 'doubao-seedream-5-0-pro';
  }
  if (/gemini[\-_/ ]?3(?:\.0|\.1)?[\-_/ ]?pro[\-_/ ]?image[\-_/ ]?preview/.test(normalized)) return 'gemini-3-pro-image-preview';
  if (/doubao[\-_/ ]?seedance[\-_/ ]?2(?:\.0)?/.test(normalized)) return 'doubao-seedance-2-0';
  if (/doubao[\-_/ ]?audio[\-_/ ]?1(?:\.0)?/.test(normalized)) return 'doubao-audio-1-0';
  if (/seedance[\-_/ ]?(?:2(?:\.0)?|v2)/.test(normalized)) return 'seedance-v2';
  if (/happyhorse(?:[\-_/ ]?1(?:\.0|\.1)?)?/.test(normalized)) return 'happyhorse-11';
  return normalized;
}

// 模型名 → provider 提示，输出统一经 normalizeProviderId 归一化，
// 与 store 端 providerKeyId 保持一致，避免 hint 值大小写/别名导致的 key 不匹配。
function providerHintForModel(model?: string | null): string {
  const hint = model ? PROVIDER_HINTS[normalizeRequestedModelIdentifier(model)] : undefined;
  return hint ? (normalizeProviderId(hint) || hint) : '';
}

function pushGenerationTrace(stage: string, detail?: Record<string, unknown>) {
  if (typeof window === 'undefined') return;
  const target = window as typeof window & {
    __HMDAO_GENERATION_TRACE__?: Array<Record<string, unknown>>;
  };
  const entries = Array.isArray(target.__HMDAO_GENERATION_TRACE__)
    ? target.__HMDAO_GENERATION_TRACE__
    : [];
  entries.push({
    stage,
    at: Date.now(),
    ...(detail || {}),
  });
  target.__HMDAO_GENERATION_TRACE__ = entries.slice(-80);
}

async function previewGenerationRoute(
  provider: string,
  endpoint: string,
  body: SanitizedGenerationBody,
  timeout: number,
  apiKey: string,
  baseUrl?: string,
): Promise<ProxyRoutePreviewResult | null> {
  try {
    const response = await fetch(`/api/proxy-preview/${encodeURIComponent(provider)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        endpoint,
        method: 'POST',
        timeout: Math.min(Math.max(timeout, 2000), 12000),
        body,
        apiKey,
        baseUrl,
      }),
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : null;
    return parsed && typeof parsed === 'object' ? parsed as ProxyRoutePreviewResult : null;
  } catch {
    return null;
  }
}

function modelMatchesRequestedIdentifier(
  model: Pick<CatalogModel, 'id' | 'name' | 'provider' | 'description' | 'upstreamModel' | 'capabilities'>,
  requestedModel: string,
) {
  const normalizedRequested = normalizeRequestedModelIdentifier(requestedModel);
  if (!normalizedRequested) return false;
  const candidates = [
    model.id,
    model.name,
    model.upstreamModel,
  ]
    .map((value) => normalizeRequestedModelIdentifier(String(value || '')))
    .filter(Boolean);
  return candidates.includes(normalizedRequested);
}

// 单一数据源：MODE_PROVIDERS 直接由 PROVIDER_MODE_SUPPORT 派生，
// 避免「两套表」漂移导致的路由遗漏（如之前 llm 漏 minimax/modelscope、
// image 漏 zhipu/modelscope）。顺序仅影响无 key 时的回退优先级，不覆盖已存的 key 匹配。
const generationCache = new Map<string, ProxyGenerationResult>();

function normalizeProvider(provider?: string) {
  if (!provider || provider.startsWith('hmdao-')) return '';
  // 归一化别名/大小写（ark/doubao→volcengine、silicon-flow→siliconflow 等），
  // 与 store 端 providerKeyId 保持同一套规则，避免校验/存储 id 不一致。
  return normalizeProviderId(provider) || provider;
}

function supportsMode(provider: string, mode: GenerationMode) {
  return PROVIDER_MODE_SUPPORT[provider]?.includes(mode) ?? false;
}

function isKeyExpired(key?: ProviderKeyState) {
  return Boolean(key?.expiresAt && Date.now() > key.expiresAt);
}

function canUseProviderKey(key: ProviderKeyState | undefined, provider: string, mode: GenerationMode, requireRawKey: boolean) {
  if (!key || isKeyExpired(key)) return false;
  if (!(key.mode === mode || supportsMode(provider, mode))) return false;
  if (requireRawKey) return Boolean(key.apiKey);
  return true;
}

function canUseKeyForMode(key: ProviderKeyState | undefined, provider: string, mode: GenerationMode, requireRawKey: boolean) {
  if (!key || isKeyExpired(key)) return false;
  const providerSupported = supportsMode(provider, mode);
  const keySupported = key.mode === mode;
  if (!(providerSupported && keySupported)) return false;
  if (requireRawKey) return Boolean(key.apiKey || key.metadataOnly);
  return true;
}

function clamp(value: unknown, min: number, max: number, fallback: number) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.min(max, Math.max(min, next));
}

function compactRecord<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''),
  ) as T;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
    .join(',')}}`;
}

function readGenerationCacheRecord() {
  if (typeof window === 'undefined') return {} as Record<string, GenerationCacheEntry>;
  try {
    const raw = localStorage.getItem(GENERATION_CACHE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, GenerationCacheEntry>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeGenerationCacheRecord(record: Record<string, GenerationCacheEntry>) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(GENERATION_CACHE_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Ignore quota and storage errors; in-memory cache still works for this session.
  }
}

function getCachedGeneration(cacheKey: string): ProxyGenerationResult | null {
  const memoryHit = generationCache.get(cacheKey);
  if (memoryHit) return memoryHit;

  const record = readGenerationCacheRecord();
  const entry = record[cacheKey];
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    delete record[cacheKey];
    writeGenerationCacheRecord(record);
    return null;
  }
  generationCache.set(cacheKey, entry.result);
  return entry.result;
}

function setCachedGeneration(cacheKey: string, result: ProxyGenerationResult) {
  generationCache.set(cacheKey, result);
  const record = readGenerationCacheRecord();
  record[cacheKey] = {
    cachedAt: Date.now(),
    expiresAt: Date.now() + GENERATION_CACHE_TTL_MS,
    result,
  };
  writeGenerationCacheRecord(record);
}

function buildGenerationCacheKey(nodeType: NodeType, provider: string, model: string, body: SanitizedGenerationBody) {
  return `${nodeType}:${provider}:${model}:${stableSerialize(sanitizeStoredGenerationBody(body))}`;
}

function shouldCacheGenerationResult(result: ProxyGenerationResult) {
  const assetUrl = result.asset?.url || '';
  if (!result.success || !assetUrl) return false;
  return assetUrl.startsWith('data:') || assetUrl.startsWith('http://') || assetUrl.startsWith('https://') || assetUrl.startsWith('/');
}

export function toRenderableAssetUrl(
  url: string,
  kind: 'image' | 'video' | 'audio' = 'image',
  referer?: string,
) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (isLocalMediaHandle(raw)) {
    return resolveLocalMediaUrl(raw);
  }
  // 同源（同主机）或站点内相对路径的资源由浏览器直接同源加载即可，
  // 不应走 media-proxy 跨域代理：否则代理会自请求本机 URL，文件缺失时
  // static 服务兜底返回 index.html（HTML），被 detectRemoteMediaUpstreamIssue
  // 误判为 422；且同源资源本就无需 CORS 代理。
  const isSameOriginOrLocal = (() => {
    if (raw.startsWith('/')) {
      // 站点内相对路径（如 /assets/...），但排除已是后端路由的 /api/ 路径
      return !raw.startsWith('/api/');
    }
    try {
      const u = new URL(raw);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      const host = typeof window !== 'undefined' ? window.location.host : '';
      return host !== '' && u.host === host;
    } catch {
      return false;
    }
  })();
  if (isSameOriginOrLocal) return raw;
  if (raw.startsWith('/api/media-proxy?')) return raw;
  const queryParams: Record<string, string> = { url: raw, kind };
  // 转发来源页 URL 以绕过仅依赖 Referer 的防盗链。
  const cleanedReferer = String(referer || '').trim();
  if (cleanedReferer && /^https?:\/\//i.test(cleanedReferer)) {
    queryParams.referer = cleanedReferer;
  }
  const query = new URLSearchParams(queryParams);
  if (raw.startsWith('file:///') || /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\')) {
    return `/api/media-proxy?${query.toString()}`;
  }
  if (/^https?:\/\//i.test(raw)) {
    return `/api/media-proxy?${query.toString()}`;
  }
  return raw;
}

function kindLabel(kind: RenderableAssetKind) {
  if (kind === 'video') return '视频';
  if (kind === 'audio') return '音频';
  return '图片';
}

function parseAwsSignedTimestamp(value: string) {
  const match = String(value || '').trim().match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) return 0;
  const [, year, month, day, hour, minute, second] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
}

export function readSignedAssetExpiry(url: string) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw, window.location.origin);
    const host = parsed.hostname.toLowerCase();
    const signedAt = parseAwsSignedTimestamp(parsed.searchParams.get('X-Amz-Date') || '');
    const expiresInSeconds = Number(parsed.searchParams.get('X-Amz-Expires'));
    if (!signedAt || !Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) return null;
    const expiresAt = signedAt + expiresInSeconds * 1000;
    return {
      host,
      provider: host.includes('siliconflow.cn') ? 'siliconflow' as const : '' as const,
      signedAt,
      expiresAt,
      expired: Date.now() > expiresAt,
    };
  } catch {
    return null;
  }
}

export function classifyRenderableAssetIssue(url: string, kind: RenderableAssetKind = 'image'): RenderableAssetIssue | null {
  const raw = String(url || '').trim();
  if (!raw) return null;
  if (isTransientBlobUrl(raw)) {
    return {
      category: 'legacy-blob',
      summary: '历史本地素材已失效',
      detail: `这是旧画布里的历史本地缓存${kindLabel(kind)}，浏览器重启后原始 blob 已失效，请重新上传或重新生成。`,
    };
  }

  const signed = readSignedAssetExpiry(raw);
  if (signed?.provider === 'siliconflow' && signed.expired) {
    return {
      category: 'remote-asset-expired',
      provider: 'siliconflow',
      expiresAt: signed.expiresAt,
      summary: '硅基流动临时素材链接已过期',
      detail: '该结果使用的是硅基流动临时签名素材地址，已超过有效期。请重新生成、重新上传，或从最新结果节点重新取用素材。',
    };
  }

  return null;
}

export async function probeRenderableAssetIssue(
  renderUrl: string,
  sourceUrl: string,
  kind: RenderableAssetKind = 'image',
): Promise<RenderableAssetIssue | null> {
  const eager = classifyRenderableAssetIssue(sourceUrl, kind);
  if (eager) return eager;
  const rawRenderUrl = String(renderUrl || '').trim();
  if (!rawRenderUrl || !rawRenderUrl.startsWith('/api/media-proxy?')) return null;
  try {
    const response = await fetch(rawRenderUrl, {
      method: 'HEAD',
      cache: 'no-store',
    });
    if (response.ok) return null;
    const category = String(response.headers.get('X-HMDAO-Media-Error') || '').trim().toLowerCase();
    const provider = String(response.headers.get('X-HMDAO-Media-Provider') || '').trim().toLowerCase();
    if (category === 'remote-asset-expired') {
      return {
        category: 'remote-asset-expired',
        provider: provider || 'siliconflow',
        status: response.status,
        summary: '硅基流动临时素材链接已过期',
        detail: '该结果使用的是硅基流动临时签名素材地址，已超过有效期。请重新生成、重新上传，或从最新结果节点重新取用素材。',
      };
    }
    return {
      category: 'render-failed',
      provider: provider || undefined,
      status: response.status,
      summary: `${kindLabel(kind)}资源加载失败`,
      detail: `${kindLabel(kind)}资源暂时不可用，请重试、重新上传，或重新生成新的结果节点。`,
    };
  } catch {
    return null;
  }
}

function defaultAssetKindForNode(nodeType: NodeType): RenderableAssetKind | null {
  if (nodeType === 'video') return 'video';
  if (nodeType === 'audio') return 'audio';
  if (nodeType === 'image') return 'image';
  return null;
}

function collectNodeAssetCandidates(node: Pick<CanvasNode, 'type' | 'data'>): Array<{ url: string; kind: RenderableAssetKind }> {
  const candidates: Array<{ url: string; kind: RenderableAssetKind }> = [];
  const fallbackKind = defaultAssetKindForNode(node.type);
  if (node.type === 'image' && typeof node.data?.imageUrl === 'string' && node.data.imageUrl.trim()) {
    candidates.push({ url: node.data.imageUrl.trim(), kind: 'image' });
  }
  if (node.type === 'video' && typeof node.data?.videoUrl === 'string' && node.data.videoUrl.trim()) {
    candidates.push({ url: node.data.videoUrl.trim(), kind: 'video' });
  }
  if (Array.isArray(node.data?.outputs)) {
    for (const output of node.data.outputs) {
      const originalUrl = typeof output?.metadata?.originalUrl === 'string' ? output.metadata.originalUrl.trim() : '';
      const outputUrl = typeof output?.url === 'string' ? output.url.trim() : '';
      const url = originalUrl || outputUrl;
      if (!url) continue;
      const inferredKind = output?.type === 'video' || output?.type === 'audio' || output?.type === 'image'
        ? output.type
        : fallbackKind;
      if (!inferredKind) continue;
      candidates.push({ url, kind: inferredKind });
    }
  }
  return candidates;
}

function normalizedKindLabel(kind: RenderableAssetKind) {
  if (kind === 'video') return '视频';
  if (kind === 'audio') return '音频';
  return '图片';
}

function looksLikeMigrationMojibake(value: string) {
  return /[�]/.test(value)
    || /(鍘嗗彶|纭呭熀娴佸姩|妫€娴|鏃х殑|绱犳潗|閾炬帴|鍔犺浇澶辫触|鑺傜偣)/.test(value);
}

function sanitizeMigrationText(value: unknown, fallback: string) {
  const next = String(value || '').trim();
  if (!next) return fallback;
  return looksLikeMigrationMojibake(next) ? fallback : next;
}

function fallbackMigrationIssueText(category: CanvasMigrationIssue['category'], assetKind: RenderableAssetKind) {
  const assetLabel = normalizedKindLabel(assetKind);
  if (category === 'legacy-blob') {
    return {
      summary: '历史本地素材已失效',
      detail: `这是旧画布里的历史本地缓存${assetLabel}，浏览器重启后原始 blob 已失效，请重新上传或重新生成。`,
    };
  }
  if (category === 'remote-asset-expired') {
    return {
      summary: '硅基流动临时素材链接已过期',
      detail: '该结果使用的是硅基流动临时签名素材地址，已超过有效期。请重新生成、重新上传，或从最新结果节点重新取用素材。',
    };
  }
  return {
    summary: `${assetLabel}资源加载失败`,
    detail: `${assetLabel}资源暂时不可用，请重试、重新上传，或重新生成新的结果节点。`,
  };
  if (category === 'legacy-blob') {
    return {
      summary: '历史本地素材已失效',
      detail: `这是旧画布里的历史本地缓存${kindLabel(assetKind)}，浏览器重启后原始 blob 已失效，请重新上传或重新生成。`,
    };
  }
  if (category === 'remote-asset-expired') {
    return {
      summary: '硅基流动临时素材链接已过期',
      detail: '该结果使用的是硅基流动临时签名素材地址，已超过有效期。请重新生成、重新上传，或从最新结果节点重新取用素材。',
    };
  }
  return {
    summary: `${kindLabel(assetKind)}资源加载失败`,
    detail: `${kindLabel(assetKind)}资源暂时不可用，请重试、重新上传，或重新生成新的结果节点。`,
  };
}

function normalizeCanvasMigrationIssue(issue: CanvasMigrationIssue): CanvasMigrationIssue {
  const fallback = fallbackMigrationIssueText(issue.category, issue.assetKind);
  return {
    ...issue,
    nodeLabel: sanitizeMigrationText(issue.nodeLabel, '节点'),
    summary: sanitizeMigrationText(issue.summary, fallback.summary),
    detail: sanitizeMigrationText(issue.detail, fallback.detail),
  };
}

function cleanMigrationText(value: unknown, fallback: string) {
  const next = String(value || '').trim();
  if (!next) return fallback;
  return /[\uFFFD]/.test(next) || /(鍘嗗彶|纭呭熀娴佸姩|妫€娴|鏃х殑|绱犳潗|閾炬帴|鍔犺浇澶辫触|鑺傜偣)/.test(next)
    ? fallback
    : next;
}

function cleanCanvasMigrationIssue(issue: CanvasMigrationIssue): CanvasMigrationIssue {
  const assetLabel = normalizedKindLabel(issue.assetKind);
  const fallbackSummary = issue.category === 'legacy-blob'
    ? '\u5386\u53f2\u672c\u5730\u7d20\u6750\u5df2\u5931\u6548'
    : issue.category === 'remote-asset-expired'
      ? '\u7845\u57fa\u6d41\u52a8\u4e34\u65f6\u7d20\u6750\u94fe\u63a5\u5df2\u8fc7\u671f'
      : `${assetLabel}\u8d44\u6e90\u52a0\u8f7d\u5931\u8d25`;
  const fallbackDetail = issue.category === 'legacy-blob'
    ? `\u8fd9\u662f\u65e7\u753b\u5e03\u91cc\u7684\u5386\u53f2\u672c\u5730\u7f13\u5b58${assetLabel}\uff0c\u6d4f\u89c8\u5668\u91cd\u542f\u540e\u539f\u59cb blob \u5df2\u5931\u6548\uff0c\u8bf7\u91cd\u65b0\u4e0a\u4f20\u6216\u91cd\u65b0\u751f\u6210\u3002`
    : issue.category === 'remote-asset-expired'
      ? '\u8be5\u7ed3\u679c\u4f7f\u7528\u7684\u662f\u7845\u57fa\u6d41\u52a8\u4e34\u65f6\u7b7e\u540d\u7d20\u6750\u5730\u5740\uff0c\u5df2\u8d85\u8fc7\u6709\u6548\u671f\u3002\u8bf7\u91cd\u65b0\u751f\u6210\u3001\u91cd\u65b0\u4e0a\u4f20\uff0c\u6216\u4ece\u6700\u65b0\u7ed3\u679c\u8282\u70b9\u91cd\u65b0\u53d6\u7528\u7d20\u6750\u3002'
      : `${assetLabel}\u8d44\u6e90\u6682\u65f6\u4e0d\u53ef\u7528\uff0c\u8bf7\u91cd\u8bd5\u3001\u91cd\u65b0\u4e0a\u4f20\uff0c\u6216\u91cd\u65b0\u751f\u6210\u65b0\u7684\u7ed3\u679c\u8282\u70b9\u3002`;
  return {
    ...issue,
    nodeLabel: cleanMigrationText(issue.nodeLabel, '\u8282\u70b9'),
    summary: cleanMigrationText(issue.summary, fallbackSummary),
    detail: cleanMigrationText(issue.detail, fallbackDetail),
  };
}

export function scanNodeMigrationIssues(node: Pick<CanvasNode, 'id' | 'type' | 'data'>): CanvasMigrationIssue[] {
  const issues: CanvasMigrationIssue[] = [];
  const label = String(node.data?.label || node.type || '节点').trim() || '节点';
  const params = node.data?.params && typeof node.data.params === 'object'
    ? node.data.params as Record<string, unknown>
    : {};

  if (Boolean(params.legacyBlobInvalid)) {
    const fallbackKind = defaultAssetKindForNode(node.type) || 'image';
    issues.push({
      nodeId: node.id,
      nodeLabel: cleanMigrationText(label, '节点'),
      nodeType: node.type,
      assetKind: fallbackKind,
      category: 'legacy-blob',
      summary: '历史本地素材已失效',
      detail: `节点里的历史本地${kindLabel(fallbackKind)}缓存已经失效，请重新上传或重新生成新的结果节点。`,
    });
    return issues.map((issue) => cleanCanvasMigrationIssue(issue));
  }

  const seen = new Set<string>();
  for (const candidate of collectNodeAssetCandidates(node)) {
    const issue = classifyRenderableAssetIssue(candidate.url, candidate.kind);
    if (!issue) continue;
    const key = `${issue.category}:${candidate.kind}:${candidate.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push({
      ...issue,
      nodeId: node.id,
      nodeLabel: cleanMigrationText(label, '节点'),
      nodeType: node.type,
      assetKind: candidate.kind,
      assetUrl: candidate.url,
    });
  }
  return issues.map((issue) => cleanCanvasMigrationIssue(issue));
}

export function scanCanvasMigrationIssues(nodes: Array<Pick<CanvasNode, 'id' | 'type' | 'data'>> | undefined): CanvasMigrationIssue[] {
  if (!Array.isArray(nodes) || nodes.length === 0) return [];
  return nodes.flatMap((node) => scanNodeMigrationIssues(node));
}

function shouldRetryGeneration(error: unknown) {
  if (!(error instanceof GenerationError)) return false;
  return error.metadata.category === 'timeout' || error.metadata.category === 'upstream' || error.metadata.category === 'request';
}

function modelBestForText(model: Pick<CatalogModel, 'capabilities'>) {
  return Array.isArray(model.capabilities?.bestFor)
    ? model.capabilities.bestFor.join(' ').toLowerCase()
    : '';
}

function modelImageRoutingHintText(model: Pick<CatalogModel, 'id' | 'name' | 'provider' | 'description' | 'upstreamModel' | 'capabilities'>) {
  return [
    model.id,
    model.name,
    model.provider,
    model.description,
    model.upstreamModel,
    modelBestForText(model),
    Array.isArray(model.capabilities?.limitations) ? model.capabilities.limitations.join(' ') : '',
  ].join(' ').toLowerCase();
}

function inferImageRoutingIntent(
  primaryInputs: MediaInput[],
  referenceInputs: MediaInput[],
  strategyOperation: string,
) {
  const coverageOptions = { imageStrategyOperation: strategyOperation };
  const activePrimary = primaryInputs.filter((item) => item.enabled !== false);
  const activeReferences = referenceInputs.filter((item) => item.enabled !== false);
  const hasPrimaryImage = activePrimary.some((item) => item.type === 'image');
  const hasSubjectReference = hasReferenceRole(activeReferences, ['subject'], coverageOptions);
  const hasStyleReference = hasReferenceRole(activeReferences, ['style'], coverageOptions);
  const hasCompositionReference = hasReferenceRole(activeReferences, ['composition'], coverageOptions);
  const hasLightingReference = hasReferenceRole(activeReferences, ['lighting'], coverageOptions);
  const hasElementReference = hasReferenceRole(activeReferences, ['element'], coverageOptions);
  const hasOmniReference = activeReferences.some((item) => isOmniReferenceRole(item.role));
  const distinctRoleCount = distinctReferenceRoleCount(activeReferences, coverageOptions);
  const subjectReferenceCount = activeReferences.filter((item) => expandReferenceCoverage(item, coverageOptions).includes('subject')).length;
  const imageReferenceCount = activeReferences.filter((item) => item.type === 'image').length;
  const preserveCompositionReplaceSubject = isStrictImageSubjectSwapOperation(strategyOperation);
  return {
    hasPrimaryImage,
    hasSubjectReference,
    hasStyleReference,
    hasCompositionReference,
    hasLightingReference,
    hasElementReference,
    hasOmniReference,
    distinctRoleCount,
    subjectReferenceCount,
    imageReferenceCount,
    preserveCompositionReplaceSubject,
    needsStrictCompositionLock: preserveCompositionReplaceSubject || (hasPrimaryImage && hasCompositionReference),
    needsIdentityLock: hasSubjectReference || (!preserveCompositionReplaceSubject && hasOmniReference),
    needsOmniFusion: hasOmniReference,
    needsMultiReferenceFusion: distinctRoleCount >= 3 || imageReferenceCount >= 3 || (hasSubjectReference && hasStyleReference && hasLightingReference),
    needsProductSubjectSwap: preserveCompositionReplaceSubject && hasPrimaryImage && hasSubjectReference,
    needsReferenceDrivenLookdev: hasStyleReference || hasLightingReference || hasElementReference,
  };
}

function scoreImageRoutingCandidate(
  model: CatalogModel,
  options: {
    requestedModel: string;
    requestedProvider: string | undefined;
    preferredModelIds: string[];
    preferredProviders: string[];
    requirements: ReturnType<typeof buildImageModelCapabilityRequirements>;
    primaryInputs: MediaInput[];
    referenceInputs: MediaInput[];
    strategyOperation: string;
    referenceRoleCount: number;
    hasOmniReference: boolean;
  },
) {
  const support = evaluateModelCapabilitySupport(model.capabilities || undefined, options.requirements);
  const tags = modelBestForText(model);
  const hints = modelImageRoutingHintText(model);
  const intent = inferImageRoutingIntent(options.primaryInputs, options.referenceInputs, options.strategyOperation);
  let score = 0;
  if (model.activated) score += 1000;
  if (support.supported) score += 400;
  else score -= 400;
  if (modelMatchesRequestedIdentifier(model, options.requestedModel)) score += 90;
  if (options.requestedProvider && model.provider === options.requestedProvider) score += 50;
  if (options.preferredModelIds.includes(model.id)) score += 70;
  if (options.preferredProviders.includes(model.provider)) score += 30;
  if (intent.needsIdentityLock && model.capabilities?.supportsIdentityController) score += 110;

  if (intent.needsStrictCompositionLock) {
    if (tags.includes('保构图换主体')) score += 240;
    if (tags.includes('参考主体锁定')) score += 180;
    if (tags.includes('角色一致性')) score += 120;
    if (hints.includes('qwen-image')) score += 60;
  }

  if (options.strategyOperation === 'preserveCompositionReplaceSubject') {
    if (tags.includes('参考主体锁定')) score += 180;
    if (tags.includes('角色一致性')) score += 140;
    if (tags.includes('多参考图像生成')) score += 120;
    if (tags.includes('保构图换主体')) score += 180;
    if (tags.includes('全能参考')) score += 140;
    if (tags.includes('商品图')) score += 80;
  } else if (options.strategyOperation === 'referenceConditionedImageEdit') {
    if (tags.includes('多参考图像生成')) score += 110;
    if (tags.includes('角色一致性')) score += 80;
    if (tags.includes('全能参考')) score += 120;
    if (tags.includes('商品图')) score += 60;
  }
  if (intent.needsProductSubjectSwap) {
    if (tags.includes('商品图')) score += 90;
    if (tags.includes('高质感场景')) score += 50;
  }
  if (intent.needsReferenceDrivenLookdev) {
    if (tags.includes('高质感场景')) score += 70;
    if (tags.includes('打光强化')) score += 60;
  }
  if (options.referenceRoleCount >= 3) {
    if (tags.includes('全能参考')) score += 160;
    if (tags.includes('多参考图像生成')) score += 120;
    if (tags.includes('高质感场景')) score += 40;
  }
  if (options.hasOmniReference) {
    if (tags.includes('全能参考')) score += 220;
    if (tags.includes('参考主体锁定')) score += 90;
    if (tags.includes('角色一致性')) score += 70;
  }
  if (intent.needsMultiReferenceFusion) {
    if (tags.includes('全能参考')) score += 170;
    if (tags.includes('多参考图像生成')) score += 160;
  }
  if (intent.needsOmniFusion) {
    if (tags.includes('全能参考')) score += 240;
    if (tags.includes('多参考图像生成')) score += 110;
    if (tags.includes('参考主体锁定')) score += 80;
  }
  if (intent.hasCompositionReference && tags.includes('保构图换主体')) score += 80;
  if (intent.subjectReferenceCount >= 2 && tags.includes('角色一致性')) score += 120;
  if (intent.imageReferenceCount >= 2 && tags.includes('多参考图像生成')) score += 90;
  if (intent.needsMultiReferenceFusion && hints.includes('复杂多参考控制较弱')) score -= 180;

  return { score, support };
}

export function resolveImageToolModel(
  requestedModel: string,
  requestedProvider: string | undefined,
  data: NodeData,
  catalogItems: CatalogModel[],
) {
  const params = (data.params || {}) as Record<string, unknown>;
  const preset = getImageToolPreset(params.imageTool);
  const connectedInputs = Array.isArray(data.inputs) ? data.inputs.filter(Boolean) as MediaInput[] : [];
  const primaryInputs = connectedInputs.filter((item) => item?.channel === 'primary' && item.enabled !== false);
  const referenceInputs = connectedInputs.filter((item) => item?.channel !== 'primary' && item.enabled !== false);
  const fallbackCatalogItem = catalogItems.find((item) => modelMatchesRequestedIdentifier(item, requestedModel)) || null;

  const candidates = catalogItems.filter((model) => model.mode === 'image' && model.nodeTypes.includes('image'));
  const exactRequested = candidates.find((item) => modelMatchesRequestedIdentifier(item, requestedModel));
  const exactProvider = requestedProvider ? candidates.find((item) => item.provider === requestedProvider && modelMatchesRequestedIdentifier(item, requestedModel)) : undefined;
  const preferredModelIds = preset?.preferredModels || [];
  const preferredProviders = preset?.preferredProviders || [];
  const preferredByModel = preferredModelIds
    .map((modelId) => candidates.find((item) => item.id === modelId))
    .filter((item): item is CatalogModel => Boolean(item));
  const preferredByProvider = preferredProviders.flatMap((providerId) =>
    candidates.filter((item) => item.provider === providerId),
  );
  const identityController = readIdentityControllerConfig(params.identityController, referenceInputs);
  const requirements = buildImageModelCapabilityRequirements({
    toolOperation: typeof params.toolOperation === 'string' && params.toolOperation
      ? params.toolOperation
      : preset?.operation,
    primaryInputs,
    referenceInputs,
    identityController,
  });
  const strategy = buildImageConditioningStrategy(
    primaryInputs,
    referenceInputs,
    typeof params.generationMode === 'string' ? params.generationMode : undefined,
  );
  const coverageOptions = typeof strategy.operation === 'string'
    ? { imageStrategyOperation: strategy.operation }
    : undefined;
  const referenceRoleCount = distinctReferenceRoleCount(referenceInputs, coverageOptions);
  const hasOmniReference = referenceInputs.some((item) => item.enabled !== false && isOmniReferenceRole(item.role));

  const ordered = [
    exactProvider,
    exactRequested,
    ...preferredByModel,
    ...preferredByProvider,
    ...candidates,
  ].filter((item, index, array): item is CatalogModel => Boolean(item) && array.findIndex((entry) => entry?.id === item?.id) === index);

  const ranked = ordered
    .map((item) => ({
      item,
      ...scoreImageRoutingCandidate(item, {
        requestedModel,
        requestedProvider,
        preferredModelIds: preferredByModel.map((entry) => entry.id),
        preferredProviders,
        requirements,
        primaryInputs,
        referenceInputs,
        strategyOperation: String(strategy.operation || ''),
        referenceRoleCount,
        hasOmniReference,
      }),
    }))
    .sort((left, right) => right.score - left.score);
  const chosen = ranked[0]?.item || ordered[0];
  if (!chosen) {
    return {
      model: fallbackCatalogItem?.id || requestedModel,
      requestModel: String(fallbackCatalogItem?.model || fallbackCatalogItem?.model || requestedModel),
      provider: fallbackCatalogItem?.provider || requestedProvider || providerHintForModel(requestedModel) || '',
    };
  }
  return {
    model: chosen.id,
    requestModel: String(chosen.model || chosen.id),
    provider: chosen.provider,
  };
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function validateImageToolParams(tool: unknown, toolConfig: Record<string, unknown> | undefined) {
  const preset = getImageToolPreset(tool);
  if (!preset || !toolConfig) return;

  if (tool === 'panorama') {
    const fov = Number(toolConfig.fov);
    if (!Number.isFinite(fov) || fov < 30 || fov > 180) {
      throw new GenerationError('\\u5168\\u666f\\u89c6\\u573a\\u89d2\\u5fc5\\u987b\\u5728 30 \u5230 180 \u4e4b\\u95f4\\u3002', { category: 'validation', stage: 'tool-config' });
    }
  }

  if (tool === 'multiAngle') {
    const yaw = Number(toolConfig.yaw);
    const pitch = Number(toolConfig.pitch);
    if (!Number.isFinite(yaw) || yaw < 0 || yaw > 360 || !Number.isFinite(pitch) || pitch < -90 || pitch > 90) {
      throw new GenerationError('\\u591a\\u89d2\\u5ea6\\u673a\\u4f4d\\u53c2\\u6570\\u8d85\\u51fa\\u53ef\\u7528\\u8303\\u56f4\\u3002', { category: 'validation', stage: 'tool-config' });
    }
  }

  if (tool === 'split') {
    const rows = Number(toolConfig.rows);
    const cols = Number(toolConfig.cols);
    if (!Number.isFinite(rows) || rows < 1 || rows > 10 || !Number.isFinite(cols) || cols < 1 || cols > 10) {
      throw new GenerationError('\\u5bab\\u683c\\u5207\\u5206\\u7684\\u884c\\u5217\\u6570\\u5fc5\\u987b\\u5728 1 \u5230 10 \u4e4b\\u95f4\\u3002', { category: 'validation', stage: 'tool-config' });
    }
  }

  if (tool === 'camera') {
    const aperture = Number(toolConfig.aperture);
    const iso = Number(toolConfig.iso);
    if (!Number.isFinite(aperture) || aperture <= 0 || !Number.isFinite(iso) || iso < 50 || iso > 25600) {
      throw new GenerationError('\\u6444\\u50cf\\u673a\\u5149\\u5708\\u6216 ISO \\u53c2\\u6570\\u4e0d\\u5408\\u6cd5\\u3002', { category: 'validation', stage: 'tool-config' });
    }
  }  if (tool === 'hd') {
    const hdMode = String(toolConfig.hdMode || 'upscale');
    const allowedModes = new Set(['upscale', 'outpaint', 'inpaint', 'erase', 'cutout', 'crop', 'restore']);
    if (!allowedModes.has(hdMode)) {
      throw new GenerationError('HD 子工具无效。', { category: 'validation', stage: 'tool-config' });
    }

    const detailBoost = Number(toolConfig.detailBoost ?? 0.45);
    const outpaintRatio = Number(toolConfig.outpaintRatio ?? 0.35);
    const brushSize = Number(toolConfig.brushSize ?? 24);
    const maskStrength = Number(toolConfig.maskStrength ?? 0.8);
    const cropCenterX = Number(toolConfig.cropCenterX ?? 0.5);
    const cropCenterY = Number(toolConfig.cropCenterY ?? 0.5);
    const cropZoom = Number(toolConfig.cropZoom ?? 1);
    const subjectThreshold = Number(toolConfig.subjectThreshold ?? 0.58);
    const edgeFeather = Number(toolConfig.edgeFeather ?? 0.35);
    const textureRecovery = Number(toolConfig.textureRecovery ?? 0.7);
    const compareSplit = Number(toolConfig.compareSplit ?? 0.55);

    if (!['1.5x', '2x', '4x'].includes(String(toolConfig.upscale ?? '2x'))) {
      throw new GenerationError('HD upscale factor is invalid.', { category: 'validation', stage: 'tool-config' });
    }
    if (!Number.isFinite(detailBoost) || detailBoost < 0 || detailBoost > 1) {
      throw new GenerationError('HD detail boost must be between 0 and 1.', { category: 'validation', stage: 'tool-config' });
    }
    if (!Number.isFinite(outpaintRatio) || outpaintRatio < 0.1 || outpaintRatio > 1) {
      throw new GenerationError('HD outpaint ratio must be between 0.1 and 1.', { category: 'validation', stage: 'tool-config' });
    }
    if (!Number.isFinite(brushSize) || brushSize < 1 || brushSize > 140) {
      throw new GenerationError('HD brush size must be between 1 and 140.', { category: 'validation', stage: 'tool-config' });
    }
    if (!Number.isFinite(maskStrength) || maskStrength < 0 || maskStrength > 1) {
      throw new GenerationError('HD mask strength must be between 0 and 1.', { category: 'validation', stage: 'tool-config' });
    }
    if (!Number.isFinite(cropCenterX) || cropCenterX < 0 || cropCenterX > 1 || !Number.isFinite(cropCenterY) || cropCenterY < 0 || cropCenterY > 1) {
      throw new GenerationError('HD crop focus must stay within the preview area.', { category: 'validation', stage: 'tool-config' });
    }
    if (!Number.isFinite(cropZoom) || cropZoom < 1 || cropZoom > 2.4) {
      throw new GenerationError('HD crop zoom must be between 1 and 2.4.', { category: 'validation', stage: 'tool-config' });
    }
    if (!Number.isFinite(subjectThreshold) || subjectThreshold < 0 || subjectThreshold > 1 || !Number.isFinite(edgeFeather) || edgeFeather < 0 || edgeFeather > 1) {
      throw new GenerationError('HD cutout tuning must stay between 0 and 1.', { category: 'validation', stage: 'tool-config' });
    }
    if (!Number.isFinite(textureRecovery) || textureRecovery < 0 || textureRecovery > 1 || !Number.isFinite(compareSplit) || compareSplit < 0.1 || compareSplit > 0.9) {
      throw new GenerationError('HD restore compare values are out of range.', { category: 'validation', stage: 'tool-config' });
    }
  }
}

function parseResolution(data: NodeData) {
  const params = (data.params || {}) as Record<string, unknown>;
  const raw = params.resolution;
  if (raw && typeof raw === 'object') {
    const width = clamp((raw as Record<string, unknown>).width, 256, 4096, 1024);
    const height = clamp((raw as Record<string, unknown>).height, 256, 4096, 1024);
    return { width, height, label: `${width}x${height}` };
  }

  const quality = String(data.quality || params.quality || '').toLowerCase();
  if (quality === '1080p') return { width: 1920, height: 1080, label: '1920x1080' };
  if (quality === '720p') return { width: 1280, height: 720, label: '1280x720' };
  if (quality === '480p') return { width: 854, height: 480, label: '854x480' };
  if (quality === '2k' || quality === 'hd') return { width: 2048, height: 1152, label: '2048x1152' };
  return undefined;
}

function normalizeResolution(data: NodeData) {
  const parsed = parseResolution(data);
  if (!parsed) return undefined;
  return resolutionSchema.parse(parsed);
}

function extractSourceAssetUrl(data: NodeData, nodeType: NodeType): string | undefined {
  const params = (data.params || {}) as Record<string, unknown>;
  if (typeof params.sourceUrl === 'string' && params.sourceUrl) return params.sourceUrl;
  if (nodeType === 'video' && typeof params.sourceUrl === 'string' && params.sourceUrl) return params.sourceUrl;
  if (nodeType === 'image' && typeof data.imageUrl === 'string' && data.imageUrl) return data.imageUrl;
  if (nodeType === 'video' && typeof data.videoUrl === 'string' && data.videoUrl) return data.videoUrl;
  return undefined;
}

function readPersistedAssetId(value: unknown, url?: string) {
  const explicit = typeof value === 'string' ? value.trim() : '';
  if (explicit) return explicit;
  return extractPersistedAssetIdFromUrl(url);
}

function resolveStableGenerationAssetUrl(url: unknown, persistedAssetId: unknown) {
  return resolvePersistedAssetLibraryUrl(url, readPersistedAssetId(persistedAssetId, typeof url === 'string' ? url : ''));
}

function mediaInputWeight(item: MediaInput) {
  return typeof item.weight === 'number' ? Number((item.weight / 100).toFixed(2)) : undefined;
}

function isOmniReferenceRole(role: unknown) {
  return String(role || '').trim() === 'omni';
}

function isStrictImageSubjectSwapOperation(strategyOperation: unknown) {
  return String(strategyOperation || '').trim() === 'preserveCompositionReplaceSubject';
}

function isSvgPlaceholderUrl(url: unknown) {
  return typeof url === 'string' && url.startsWith('data:image/svg+xml');
}

function expandReferenceCoverage(
  item: Pick<MediaInput, 'type' | 'role'>,
  options?: { imageStrategyOperation?: string | undefined },
): string[] {
  if (!isOmniReferenceRole(item.role)) {
    const role = String(item.role || '').trim();
    return role ? [role] : [];
  }
  if (item.type === 'video') return ['motion', 'rhythm', 'style'];
  if (isStrictImageSubjectSwapOperation(options?.imageStrategyOperation)) return ['style', 'lighting'];
  return ['subject', 'style', 'composition', 'lighting'];
}

function hasReferenceRole(
  inputs: MediaInput[],
  roles: string[],
  options?: { imageStrategyOperation?: string | undefined },
) {
  return inputs.some((item) => item.enabled !== false && expandReferenceCoverage(item, options).some((role) => roles.includes(role)));
}

function distinctReferenceRoleCount(
  inputs: MediaInput[],
  options?: { imageStrategyOperation?: string | undefined },
) {
  return new Set(
    inputs
      .filter((item) => item.enabled !== false)
      .flatMap((item) => expandReferenceCoverage(item, options)),
  ).size;
}

function serializeReferenceInput(
  item: MediaInput,
  channel: 'primary' | 'reference',
  options?: { imageStrategyOperation?: string | undefined },
) {
  const metadata = item.metadata && typeof item.metadata === 'object'
    ? item.metadata as Record<string, unknown>
    : undefined;
  const role = channel === 'primary'
    ? item.type === 'video'
      ? 'motion'
      : 'composition'
    : item.role;
  const persistedAssetId = readPersistedAssetId(metadata?.persistedAssetId, item.url);
  const sourceMeta = metadata
    ? compactRecord({
        width: typeof metadata.width === 'number' ? metadata.width : undefined,
        height: typeof metadata.height === 'number' ? metadata.height : undefined,
        duration: typeof metadata.duration === 'number' ? metadata.duration : undefined,
        contentType: typeof metadata.contentType === 'string' ? metadata.contentType : undefined,
        provider: typeof metadata.provider === 'string' ? metadata.provider : undefined,
        model: typeof metadata.model === 'string' ? metadata.model : undefined,
        source: typeof metadata.source === 'string' ? metadata.source : undefined,
        bindingRole: typeof metadata.bindingRole === 'string' ? metadata.bindingRole : undefined,
        regionLabel: typeof metadata.regionLabel === 'string' ? metadata.regionLabel : undefined,
      })
    : undefined;
  return compactRecord({
    type: item.type,
    role,
    ui_role: item.role,
    weight: mediaInputWeight(item),
    source_node_id: item.sourceNodeId,
    source_node_type: item.sourceNodeType,
    handle_id: item.handleId,
    channel: item.channel,
    url: resolveStableGenerationAssetUrl(item.url, persistedAssetId),
    persisted_asset_id: persistedAssetId || undefined,
    source_meta: sourceMeta,
    coverage_roles: channel === 'reference' ? expandReferenceCoverage(item, options) : undefined,
    binding_role: channel === 'reference' && typeof metadata?.bindingRole === 'string' ? metadata.bindingRole : undefined,
    binding_description: channel === 'reference' && typeof metadata?.bindingDescription === 'string' ? metadata.bindingDescription : undefined,
    region_label: channel === 'reference' && typeof metadata?.regionLabel === 'string' ? metadata.regionLabel : undefined,
    preserve_detail: channel === 'reference' && typeof metadata?.preserveDetail === 'boolean' ? metadata.preserveDetail : undefined,
    preserve: channel === 'primary'
      ? item.type === 'video'
        ? ['camera_motion', 'timing', 'composition', 'framing', 'spatial_layout']
        : ['composition', 'framing', 'camera_angle', 'spatial_layout', 'subject_scale']
      : undefined,
  });
}

function videoReferenceRoleText(role: unknown) {
  switch (String(role || '').trim()) {
    case 'omni': return 'combined subject, style, composition, lighting and motion guidance from one consolidated reference';
    case 'subject': return 'subject appearance, wardrobe, silhouette and identity';
    case 'composition': return 'composition, spatial relationship and framing';
    case 'lighting': return 'lighting direction, contrast, highlights, shadows and atmosphere';
    case 'motion': return 'camera motion, character motion, timing and shot rhythm';
    case 'rhythm': return 'editing rhythm, motion beats and temporal pacing';
    case 'style':
    default: return 'visual style, color palette, background mood, lighting atmosphere and material texture';
  }
}

function buildVideoConditioningStrategy(
  primaryInputs: MediaInput[],
  referenceInputs: MediaInput[],
  generationMode: string | undefined,
  sourceMediaType: string | undefined,
) {
  const hasPrimaryVideo = primaryInputs.some((item) => item.enabled !== false && item.type === 'video');
  const hasImageReference = referenceInputs.some((item) => item.enabled !== false && item.type === 'image');
  const hasVideoReference = referenceInputs.some((item) => item.enabled !== false && item.type === 'video');
  const hasSubjectImageReference = hasReferenceRole(referenceInputs.filter((item) => item.type === 'image'), ['subject']);
  const hasStyleImageReference = hasReferenceRole(referenceInputs.filter((item) => item.type === 'image'), ['style']);
  const hasOmniImageReference = referenceInputs.some((item) => item.enabled !== false && item.type === 'image' && isOmniReferenceRole(item.role));
  const hasOmniVideoReference = referenceInputs.some((item) => item.enabled !== false && item.type === 'video' && isOmniReferenceRole(item.role));
  const operation = hasPrimaryVideo && hasImageReference
    ? 'videoStyleTransfer'
    : hasPrimaryVideo || hasVideoReference || sourceMediaType === 'video'
      ? 'referenceVideo'
      : generationMode || 'textToVideo';
  return compactRecord({
    operation,
    generation_mode: generationMode,
    source_media_type: sourceMediaType,
    primary_video_policy: hasPrimaryVideo ? 'preserve_camera_motion_timing_composition_only' : undefined,
    image_reference_policy: hasImageReference ? 'transfer_style_lighting_background_subject_as_requested' : undefined,
    subject_transfer_policy: hasPrimaryVideo && hasSubjectImageReference ? 'replace_subject_only_keep_primary_motion_and_composition' : undefined,
    style_transfer_policy: hasPrimaryVideo && hasStyleImageReference ? 'preserve_primary_motion_apply_reference_style_and_lighting' : undefined,
    video_reference_policy: hasVideoReference ? 'reuse_motion_rhythm_camera_language' : undefined,
    omni_reference_policy: hasOmniImageReference || hasOmniVideoReference ? 'single_reference_drives_multiple_control_dimensions' : undefined,
  });
}

function inferVideoGenerationMode(
  primaryInputs: MediaInput[],
  referenceInputs: MediaInput[],
  sourceMediaType: string | undefined,
): string {
  const hasPrimaryVideo = primaryInputs.some((item) => item.enabled !== false && item.type === 'video');
  const hasVideoReference = referenceInputs.some((item) => item.enabled !== false && item.type === 'video');
  if (hasPrimaryVideo || hasVideoReference || sourceMediaType === 'video') {
    return 'referenceVideo';
  }
  return 'textToVideo';
}

function buildVideoConditionedPrompt(
  prompt: string,
  primaryInputs: MediaInput[],
  referenceInputs: MediaInput[],
  strategy: Record<string, unknown>,
) {
  const activePrimary = primaryInputs.filter((item) => item.enabled !== false);
  const activeReferences = referenceInputs.filter((item) => item.enabled !== false);
  if (!activePrimary.length && !activeReferences.length) return prompt;

  const lines = [prompt.trim()];
  const primaryVideo = activePrimary.find((item) => item.type === 'video');
  const imageRefs = activeReferences.filter((item) => item.type === 'image');
  const videoRefs = activeReferences.filter((item) => item.type === 'video');

  lines.push('');
  lines.push('[HMDAO reference conditioning contract]');
  if (primaryVideo) {
    lines.push('- PRIMARY VIDEO: preserve ONLY camera motion, shot timing, framing, composition, screen direction and spatial layout from the primary video. Do not copy its original style, lighting, colors, background, textures, or unwanted subject appearance.');
  }
  if (imageRefs.length) {
    lines.push('- IMAGE REFERENCES: use image references to control visual style, color palette, lighting, background atmosphere, material texture, and subject appearance when the user asks for subject consistency.');
    imageRefs.forEach((item, index) => {
      lines.push(`  image reference ${index + 1}: role=${item.role || 'style'}, weight=${mediaInputWeight(item) ?? 0.6}, purpose=${videoReferenceRoleText(item.role)}.`);
    });
  }
  if (videoRefs.length) {
    lines.push('- VIDEO REFERENCES: use video references only for motion language, rhythm, camera path and temporal pacing unless explicitly stated otherwise.');
    videoRefs.forEach((item, index) => {
      lines.push(`  video reference ${index + 1}: role=${item.role || 'motion'}, weight=${mediaInputWeight(item) ?? 0.85}, purpose=${videoReferenceRoleText(item.role)}.`);
    });
  }
  if (imageRefs.some((item) => isOmniReferenceRole(item.role))) {
    lines.push('- OMNI IMAGE REFERENCE: treat the omni image reference as a combined subject + style + composition + lighting controller. Keep the primary video camera path stable, but obey the omni reference for product identity, scene finish, palette and atmosphere.');
  }
  if (videoRefs.some((item) => isOmniReferenceRole(item.role))) {
    lines.push('- OMNI VIDEO REFERENCE: treat the omni video reference as a combined motion + rhythm + style controller when the prompt asks for full-shot recreation.');
  }
  if (strategy.operation === 'videoStyleTransfer') {
    lines.push('- FINAL INTENT: perform video style transfer. Keep the primary video motion/composition locked, while replacing style, lighting, background atmosphere and requested subject look using the image reference.');
  }
  if (primaryVideo && imageRefs.some((item) => item.role === 'subject')) {
    lines.push('- SUBJECT REPLACEMENT: replace the original main subject from the primary video with the subject reference appearance or product identity. Keep camera path, framing, scene blocking and timing stable.');
  }
  lines.push('- Avoid unrelated scene changes unless the image reference or user prompt explicitly requests them.');
  return lines.join('\n');
}

function imageReferenceRoleText(role: unknown) {
  return imageReferenceRoleTextWithOptions(role);
}

function imageReferenceRoleTextWithOptions(
  role: unknown,
  options?: { imageStrategyOperation?: string | undefined },
) {
  switch (String(role || '').trim()) {
    case 'omni':
      return isStrictImageSubjectSwapOperation(options?.imageStrategyOperation)
        ? 'style palette, lighting mood, material finish and atmosphere support from one consolidated reference without overriding the locked composition or explicit subject identity'
        : 'subject identity, composition, style palette, lighting mood and material consistency from one consolidated reference';
    case 'subject': return 'subject identity, silhouette, wardrobe, shape language and placement stability';
    case 'element': return 'supporting objects, logo marks, graphic elements and local replacement targets';
    case 'composition': return 'composition, framing, layout hierarchy and spatial relationship';
    case 'lighting': return 'lighting direction, contrast, highlights, shadows and atmosphere';
    case 'style':
    default: return 'visual style, color palette, rendering texture, background mood and finish quality';
  }
}

function buildImageConditioningStrategy(
  primaryInputs: MediaInput[],
  referenceInputs: MediaInput[],
  generationMode: string | undefined,
) {
  const hasPrimaryImage = primaryInputs.some((item) => item.enabled !== false && item.type === 'image');
  const hasExplicitSubjectReference = referenceInputs.some((item) => item.enabled !== false && item.role === 'subject');
  const operation = hasPrimaryImage && hasExplicitSubjectReference
    ? 'preserveCompositionReplaceSubject'
    : hasPrimaryImage && referenceInputs.length
    ? 'referenceConditionedImageEdit'
    : hasPrimaryImage
      ? 'imageToImage'
      : referenceInputs.length
        ? 'referenceConditionedGeneration'
        : generationMode || 'textToImage';
  const coverageOptions = { imageStrategyOperation: operation };
  const hasSubjectReference = hasReferenceRole(referenceInputs, ['subject'], coverageOptions);
  const hasStyleReference = hasReferenceRole(referenceInputs, ['style'], coverageOptions);
  const hasCompositionReference = hasReferenceRole(referenceInputs, ['composition'], coverageOptions);
  const hasElementReference = hasReferenceRole(referenceInputs, ['element'], coverageOptions);
  const hasLightingReference = hasReferenceRole(referenceInputs, ['lighting'], coverageOptions);
  const hasOmniReference = referenceInputs.some((item) => item.enabled !== false && isOmniReferenceRole(item.role));
  return compactRecord({
    operation,
    generation_mode: generationMode,
    primary_image_policy: hasPrimaryImage ? 'preserve_composition_camera_framing_and_spatial_layout_from_primary' : undefined,
    subject_reference_policy: hasSubjectReference ? 'replace_primary_subject_with_reference_subject_when_requested' : undefined,
    subject_replacement_policy: hasPrimaryImage && hasSubjectReference ? 'keep_primary_composition_replace_primary_subject_only' : undefined,
    style_reference_policy: hasStyleReference ? 'transfer_style_palette_material_and_background_mood' : undefined,
    composition_reference_policy: hasCompositionReference ? 'keep_layout_hierarchy_and_framing_structure' : undefined,
    lighting_reference_policy: hasLightingReference ? 'reuse_lighting_direction_contrast_and_atmosphere' : undefined,
    element_reference_policy: hasElementReference ? 'reuse_or_replace_specific visual elements by role and weight' : undefined,
    omni_reference_policy: hasOmniReference
      ? isStrictImageSubjectSwapOperation(operation)
        ? 'single_reference_refines_style_lighting_material_and_atmosphere_without_overriding_locked_subject_or_composition'
        : 'single_reference_drives_subject_style_composition_and_lighting'
      : undefined,
  });
}

function buildImageConditionedPrompt(
  prompt: string,
  primaryInputs: MediaInput[],
  referenceInputs: MediaInput[],
  strategy: Record<string, unknown>,
) {
  const strategyOperation = typeof strategy.operation === 'string' ? strategy.operation : undefined;
  const activePrimary = primaryInputs.filter((item) => item.enabled !== false);
  const activeReferences = referenceInputs.filter((item) => item.enabled !== false);
  if (!activePrimary.length && !activeReferences.length) return prompt;

  const lines = [prompt.trim()];
  const primaryImage = activePrimary.find((item) => item.type === 'image');
  const imageRefs = activeReferences.filter((item) => item.type === 'image');

  lines.push('');
  lines.push('[HMDAO image reference conditioning contract]');
  if (primaryImage) {
    lines.push('- PRIMARY IMAGE: preserve framing, composition, camera angle, crop, perspective, subject scale and scene structure from the primary image unless the prompt explicitly requests a change.');
    lines.push('- PRIMARY IMAGE: do not add unrelated black bars, letterboxing or aspect-ratio padding. Recompose the content to fill the requested canvas naturally.');
  }
  if (imageRefs.length) {
    lines.push('- IMAGE REFERENCES: apply each image reference according to its explicit role and weight.');
    imageRefs.forEach((item, index) => {
      lines.push(`  image reference ${index + 1}: role=${item.role || 'style'}, weight=${mediaInputWeight(item) ?? 0.6}, purpose=${imageReferenceRoleTextWithOptions(item.role, { imageStrategyOperation: strategyOperation })}.`);
    });
  }
  if (imageRefs.some((item) => isOmniReferenceRole(item.role))) {
    lines.push(
      isStrictImageSubjectSwapOperation(strategyOperation)
        ? '- OMNI IMAGE REFERENCE: use the omni image reference only as a secondary controller for style palette, lighting mood, material finish and atmosphere. It must not override the primary composition lock or the explicit subject reference.'
        : '- OMNI IMAGE REFERENCE: use the omni image reference as the master controller for subject identity, overall style, composition intent and lighting mood.',
    );
  }
  if (isStrictImageSubjectSwapOperation(strategyOperation)) {
    lines.push('- LOCKED ROLE CONTRACT: the primary image is the only authority for composition, framing, camera angle, crop, perspective and scene layout.');
    lines.push('- LOCKED ROLE CONTRACT: the explicit subject reference is the only authority for hero product identity, silhouette, materials, branding details and replacement target.');
    lines.push('- NON-SUBJECT REFERENCES: never inherit the identity, silhouette or product family from any lighting, style or background reference. If a non-subject reference contains a foreground object, discard that object completely and keep only its atmosphere, reflections, palette and lighting cues.');
    lines.push('- FINAL INTENT: keep the main composition, lens feel, spatial layout and text placement from the primary image, but replace ONLY the original hero subject or product with the subject reference.');
    lines.push('- SUBJECT REPLACEMENT: use the subject reference as the authoritative source for product identity, silhouette, materials, logo placement and subject appearance. Do not keep the old primary subject.');
    lines.push('- SUBJECT FIDELITY: do not modernize, redesign, or substitute the requested subject with a different generation, class or era of object. Keep the replacement consistent with the bound subject reference.');
  } else if (strategy.operation === 'referenceConditionedImageEdit') {
    lines.push('- FINAL INTENT: keep the main composition and subject continuity from the primary image, while merging the requested reference-driven style, lighting, elements or identity edits.');
  }
  lines.push('- Keep all poster copy legible if text is requested. Avoid gibberish, mirrored characters or unreadable decorative text.');
  lines.push('- Respect the requested resolution and aspect ratio with full-frame composition, not empty side padding.');
  return lines.join('\n');
}

export function buildGenerationBody(nodeType: NodeType, model: string, prompt: string, data: NodeData): SanitizedGenerationBody {
  const params = (data.params || {}) as Record<string, unknown>;
  const regionContract = readRegionContract(params.regionContract);
  const regionContractInputs = buildRegionContractMediaInputs(regionContract);
  const rawConnectedInputs = Array.isArray(data.inputs) ? data.inputs : [];
  const hasExplicitRegionContractInputs = rawConnectedInputs.some((item) => Boolean(item?.metadata && typeof item.metadata === 'object' && (item.metadata as Record<string, unknown>).fromRegionContract));
  const connectedInputs = Boolean(params.contractMode) && regionContractInputs.length
    ? (hasExplicitRegionContractInputs ? rawConnectedInputs : regionContractInputs)
    : rawConnectedInputs;
  const primaryInputs = connectedInputs.filter((item) => item?.channel === 'primary' && item.enabled !== false && item.url);
  const referenceInputs = connectedInputs.filter((item) => item?.channel !== 'primary' && item.enabled !== false && item.url);
  const imageLike = nodeType === 'image' || nodeType === 'threed' || nodeType === 'dcc';
  const imageTool = imageLike && typeof params.imageTool === 'string' ? params.imageTool : undefined;
  const toolPreset = getImageToolPreset(imageTool);
  const toolConfig = recordOrUndefined(params.toolConfig) || toolPreset?.defaultParams;
  validateImageToolParams(imageTool, toolConfig);
  const resolution = normalizeResolution(data);
  const aspectRatio = aspectRatioSchema.parse(String(data.aspectRatio || params.aspectRatio || '16:9'));
  const quality = String(data.quality || params.quality || (nodeType === 'video' ? '720p' : 'standard'));
  const steps = clamp(params.steps, 1, 80, nodeType === 'image' ? 28 : 32);
  const fps = clamp(params.fps, 8, 60, nodeType === 'video' ? 24 : 24);
  const duration = clamp(data.duration || params.duration, 1, 30, nodeType === 'video' ? 5 : 5);
  const maxTokens = clamp(params.maxTokens, 32, 8192, 2048);
  const imageConditioningStrategy = imageLike
    ? buildImageConditioningStrategy(primaryInputs, referenceInputs, typeof params.generationMode === 'string' ? params.generationMode : undefined)
    : undefined;
  const imageCoverageOptions = imageLike && typeof imageConditioningStrategy?.operation === 'string'
    ? { imageStrategyOperation: imageConditioningStrategy.operation }
    : undefined;
  const activePrimaryInput = primaryInputs.find((item) => item.url);
  const connectedSourceUrl = activePrimaryInput?.url;
  const fallbackSourceUrl = extractSourceAssetUrl(data, nodeType);
  const rawSourceUrl = typeof params.sourceDataUrl === 'string' && params.sourceDataUrl
    ? isSvgPlaceholderUrl(params.sourceDataUrl) && connectedSourceUrl && !isSvgPlaceholderUrl(connectedSourceUrl)
      ? connectedSourceUrl
      : params.sourceDataUrl
    : connectedSourceUrl || fallbackSourceUrl;
  const persistedSourceAssetId = readPersistedAssetId(params.sourcePersistedAssetId, rawSourceUrl)
    || readPersistedAssetId(undefined, rawSourceUrl)
    || readPersistedAssetId(activePrimaryInput?.metadata && typeof activePrimaryInput.metadata === 'object'
      ? (activePrimaryInput.metadata as Record<string, unknown>).persistedAssetId
      : undefined, connectedSourceUrl);
  const sourceUrl = resolveStableGenerationAssetUrl(rawSourceUrl, persistedSourceAssetId);
  const sourceMediaType = typeof params.sourceMediaType === 'string' && params.sourceMediaType
    ? params.sourceMediaType
    : activePrimaryInput?.type
      || primaryInputs.find((item) => item.url === sourceUrl)?.type
      || (nodeType === 'video' && sourceUrl ? 'video' : nodeType === 'image' && sourceUrl ? 'image' : undefined);
  const explicitGenerationMode = typeof params.generationMode === 'string'
    ? params.generationMode.trim()
    : '';
  const inferredVideoGenerationMode = nodeType === 'video'
    ? inferVideoGenerationMode(primaryInputs, referenceInputs, sourceMediaType)
    : undefined;
  const generationMode = explicitGenerationMode || inferredVideoGenerationMode;
  const prioritizedImageReference = referenceInputs.find((item) => item.enabled !== false && item.type === 'image' && item.role === 'subject')
    || referenceInputs.find((item) => item.enabled !== false && item.type === 'image' && item.role === 'style')
    || referenceInputs.find((item) => item.enabled !== false && item.type === 'image' && item.role === 'composition')
    || referenceInputs.find((item) => item.enabled !== false && item.type === 'image');
  const prioritizedVideoReference = referenceInputs.find((item) => item.enabled !== false && item.type === 'video' && item.role === 'motion')
    || referenceInputs.find((item) => item.enabled !== false && item.type === 'video' && item.role === 'rhythm')
    || referenceInputs.find((item) => item.enabled !== false && item.type === 'video');
  const fallbackReferenceImageUrl = typeof params.referenceImageUrl === 'string' && params.referenceImageUrl
    ? params.referenceImageUrl
    : undefined;
  const referenceImageUrl = typeof params.referenceImageDataUrl === 'string' && params.referenceImageDataUrl
    ? isSvgPlaceholderUrl(params.referenceImageDataUrl) && prioritizedImageReference?.url && !isSvgPlaceholderUrl(prioritizedImageReference.url)
      ? prioritizedImageReference.url
      : params.referenceImageDataUrl
    : prioritizedImageReference?.url
      || fallbackReferenceImageUrl;
  const referenceVideoUrl = typeof params.referenceVideoDataUrl === 'string' && params.referenceVideoDataUrl
    ? params.referenceVideoDataUrl
    : prioritizedVideoReference?.url
      || (typeof params.referenceVideoUrl === 'string' && params.referenceVideoUrl
        ? params.referenceVideoUrl
        : undefined)
      || (nodeType === 'video' && sourceMediaType === 'video' ? sourceUrl : undefined);
  const primaryAssets = primaryInputs.map((item) => serializeReferenceInput(item, 'primary', imageCoverageOptions));
  const referenceAssets = referenceInputs.map((item) => serializeReferenceInput(item, 'reference', imageCoverageOptions));
  const identityController = readIdentityControllerConfig(params.identityController, referenceInputs);
  const sharedMemoryIds = Array.isArray(params.sharedMemoryIds)
    ? Array.from(new Set(params.sharedMemoryIds.map((item) => String(item || '').trim()).filter(Boolean)))
    : [];
  const sharedMemoryLayers = Array.isArray(params.sharedMemoryLayers)
    ? Array.from(new Set(params.sharedMemoryLayers.map((item) => String(item || '').trim()).filter(Boolean)))
    : [];
  const sharedMemoryContext = Array.isArray(params.sharedMemoryContext)
    ? Array.from(new Set(params.sharedMemoryContext.map((item) => String(item || '').trim()).filter(Boolean))).slice(0, 8)
    : [];
  const sharedMemories = serializeSharedMemoryReferences(resolveSharedAgentMemories(sharedMemoryIds));
  const conditioningStrategy = nodeType === 'video'
    ? buildVideoConditioningStrategy(primaryInputs, referenceInputs, generationMode, sourceMediaType)
    : undefined;
  const executionMode = nodeType === 'video'
    ? (typeof params.videoToolOperation === 'string' && params.videoToolOperation
        ? (String(params.videoTool || '').trim() === 'parse' ? 'analysis' : 'editing')
        : 'generation')
    : (typeof params.toolOperation === 'string' && params.toolOperation ? 'editing' : 'generation');
  const workflowGraph = buildNodeWorkflowGraph({
    nodeId: typeof params.nodeId === 'string' ? params.nodeId : 'detached',
    nodeType,
    executionMode,
    generationMode,
    provider: typeof data.provider === 'string' ? data.provider : '',
    model,
    prompt,
    sourceMediaType,
    toolOperation: typeof params.videoToolOperation === 'string' && params.videoToolOperation
      ? params.videoToolOperation
      : typeof params.toolOperation === 'string'
        ? params.toolOperation
        : toolPreset?.operation,
    primaryInputs,
    referenceInputs,
    identityController,
    sharedMemories,
  });
  const enhancementStrategy = workflowGraph.enhancementStrategy;
  const regionPack = serializeRegionPack(regionContract);
  const baseImagePrompt = toolPreset ? buildImageToolPrompt(prompt, imageTool) : prompt;
  const requestPrompt = nodeType === 'video'
    ? buildVideoConditionedPrompt(prompt, primaryInputs, referenceInputs, conditioningStrategy || {})
    : imageLike
      ? buildImageConditionedPrompt(baseImagePrompt, primaryInputs, referenceInputs, imageConditioningStrategy || {})
      : prompt;
  const shared = compactRecord({
    model,
    prompt: requestPrompt,
    aspect_ratio: aspectRatio,
    quality,
    resolution: resolution?.label,
    width: resolution?.width,
    height: resolution?.height,
    steps,
    count: clamp(params.count, 1, 4, 1),
    seed: typeof params.seed === 'number' ? params.seed : undefined,
    source_url: sourceUrl,
    source_asset_id: persistedSourceAssetId || undefined,
  });

  if (nodeType === 'video') {
    return compactRecord(videoBodySchema.parse({
      ...shared,
      fps,
      duration,
      source_media_type: sourceMediaType,
      primary_assets: primaryAssets,
      first_frame_url:
        typeof params.firstFrameDataUrl === 'string' && params.firstFrameDataUrl
          ? params.firstFrameDataUrl
          : typeof params.firstFrameUrl === 'string'
            ? params.firstFrameUrl
            : sourceMediaType === 'video'
              ? undefined
              : sourceUrl,
      last_frame_url:
        typeof params.lastFrameDataUrl === 'string' && params.lastFrameDataUrl
          ? params.lastFrameDataUrl
          : typeof params.lastFrameUrl === 'string'
            ? params.lastFrameUrl
            : undefined,
      clip: Boolean(params.clip),
      crop: Boolean(params.crop),
      parse: Boolean(params.parse),
      remove_subtitle: Boolean(params.removeSubtitle),
      audio_split: Boolean(params.audioSplit),
      video_tool: typeof params.videoTool === 'string' ? params.videoTool : undefined,
      generation_mode: generationMode,
      motion_preset: typeof recordOrUndefined(params.videoToolConfig)?.motionPreset === 'string' ? String(recordOrUndefined(params.videoToolConfig)?.motionPreset) : typeof params.motionPreset === 'string' ? params.motionPreset : undefined,
      style_preset: typeof params.stylePreset === 'string' ? params.stylePreset : undefined,
      motion_strength: typeof params.motionStrength === 'number' ? clamp(params.motionStrength, 0, 1, 0.62) : undefined,
      consistency_strength: typeof params.consistencyStrength === 'number' ? clamp(params.consistencyStrength, 0, 1, 0.8) : undefined,
      reference_weight: typeof params.referenceWeight === 'number' ? clamp(params.referenceWeight, 0, 1, 0.7) : undefined,
      reference_image_url: referenceImageUrl,
      reference_video_url: referenceVideoUrl,
      reference_assets: referenceAssets,
      reference_summary: recordOrUndefined(params.referenceSummary),
      conditioning_strategy: conditioningStrategy,
      enhancement_strategy: enhancementStrategy as unknown as Record<string, unknown> | undefined,
      linked_audio_url: typeof params.linkedAudioSourceUrl === 'string' ? params.linkedAudioSourceUrl : undefined,
      linked_audio_asset_id: typeof params.linkedAudioAssetId === 'string' ? params.linkedAudioAssetId : undefined,
      linked_audio_mode: typeof params.linkedAudioMode === 'string' ? params.linkedAudioMode : undefined,
      linked_audio_label: typeof params.linkedAudioLabel === 'string' ? params.linkedAudioLabel : undefined,
      linked_audio_backend: typeof params.linkedAudioBackend === 'string' ? params.linkedAudioBackend : undefined,
      audio_mix_mode: typeof params.linkedAudioMixMode === 'string' ? params.linkedAudioMixMode : undefined,
      audio_gain: typeof params.linkedAudioGain === 'number' ? clamp(params.linkedAudioGain, 0, 2, 1) : undefined,
      video_gain: typeof params.linkedVideoGain === 'number' ? clamp(params.linkedVideoGain, 0, 2, 1) : undefined,
      tool_operation: typeof params.videoToolOperation === 'string' ? params.videoToolOperation : undefined,
      tool_config: recordOrUndefined(params.videoToolConfig),
      workflow_graph: workflowGraph as unknown as Record<string, unknown>,
      region_pack: regionPack,
      identity_controller: identityController as unknown as Record<string, unknown>,
      shared_memory_ids: sharedMemoryIds,
      shared_memory_layers: sharedMemoryLayers,
      shared_memory_context: sharedMemoryContext,
      shared_memory_refs: sharedMemories as unknown as Record<string, unknown>[],
    }));
  }

  if (nodeType === 'image' || nodeType === 'threed' || nodeType === 'dcc') {
    return compactRecord(imageBodySchema.parse({
      ...shared,
      source_media_type: sourceMediaType,
      primary_assets: primaryAssets,
      base_prompt: toolPreset ? prompt : undefined,
      tool_prompt: toolPreset?.promptInstruction,
      tool_operation: typeof params.toolOperation === 'string' ? params.toolOperation : toolPreset?.operation,
      tool_capability: typeof params.toolCapability === 'string' ? params.toolCapability : toolPreset?.capability,
      tool_config: toolConfig,
      panorama: Boolean(params.panorama),
      multi_angle: Boolean(params.multiAngle),
      lighting: Boolean(params.lighting),
      camera_control: Boolean(params.cameraControl),
      grid: params.grid || undefined,
      split: params.split || undefined,
      image_tool: params.imageTool || undefined,
      generation_mode: generationMode,
      reference_image_url: referenceImageUrl,
      reference_assets: referenceAssets,
      reference_summary: recordOrUndefined(params.referenceSummary),
      conditioning_strategy: imageConditioningStrategy,
      enhancement_strategy: enhancementStrategy as unknown as Record<string, unknown> | undefined,
      workflow_graph: workflowGraph as unknown as Record<string, unknown>,
      region_pack: regionPack,
      identity_controller: identityController as unknown as Record<string, unknown>,
      shared_memory_ids: sharedMemoryIds,
      shared_memory_layers: sharedMemoryLayers,
      shared_memory_context: sharedMemoryContext,
      shared_memory_refs: sharedMemories as unknown as Record<string, unknown>[],
    }));
  }

  if (nodeType === 'audio') {
    return compactRecord(audioBodySchema.parse({
      model,
      input: prompt,
      voice: typeof params.voice === 'string' ? params.voice : 'default',
      sample_rate: clamp(params.sampleRate, 8000, 48000, 24000),
    }));
  }

  return compactRecord(llmBodySchema.parse({
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens,
    temperature: clamp(params.temperature, 0, 2, 0.7),
    workflow_graph: workflowGraph as unknown as Record<string, unknown>,
    shared_memory_ids: sharedMemoryIds,
    shared_memory_layers: sharedMemoryLayers,
    shared_memory_context: sharedMemoryContext,
    shared_memory_refs: sharedMemories as unknown as Record<string, unknown>[],
  }));
}

export function buildDebugGenerationBodyFromNode(node: Pick<CanvasNode, 'type' | 'data'> | null | undefined): SanitizedGenerationBody | null {
  if (!node?.type || !node.data) return null;
  const nodeType = node.type as NodeType;
  const data = node.data as NodeData;
  const model = typeof data.model === 'string' ? data.model.trim() : '';
  const prompt = typeof data.prompt === 'string' ? data.prompt : '';
  if (!model) {
    throw new Error(`Node ${data.label || nodeType} is missing model information.`);
  }
  return buildGenerationBody(nodeType, model, prompt, data);
}

const blobConditioningUrlCache = new Map<string, Promise<string>>();

function isBlobConditioningUrl(value: unknown) {
  return typeof value === 'string' && value.startsWith('blob:');
}

function isLocalConditioningUrl(value: unknown) {
  return isLocalMediaHandle(value);
}

function isSvgConditioningUrl(value: unknown) {
  return typeof value === 'string' && /^data:image\/svg\+xml/i.test(value);
}

function isInlineImageDataUrl(value: unknown) {
  return typeof value === 'string' && /^data:image\//i.test(value);
}

async function withTimeoutFallback<T>(
  task: Promise<T>,
  timeoutMs: number,
  fallback: () => T | Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => {
          void Promise.resolve(fallback()).then(resolve);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  const mimeType = String(blob.type || 'application/octet-stream').trim() || 'application/octet-stream';
  return `data:${mimeType};base64,${btoa(binary)}`;
}

async function rasterizeConditioningImage(dataUrl: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      try {
        const sourceWidth = Math.max(1, image.naturalWidth || image.width || 1280);
        const sourceHeight = Math.max(1, image.naturalHeight || image.height || 720);
        const maxEdge = 1280;
        const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
        const width = Math.max(1, Math.round(sourceWidth * scale));
        const height = Math.max(1, Math.round(sourceHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) {
          reject(new Error('Canvas 2D context is unavailable.'));
          return;
        }
        context.clearRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.9));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    image.onerror = () => reject(new Error('Failed to normalize conditioning image.'));
    image.src = dataUrl;
  });
}

async function normalizeConditioningDataUrl(dataUrl: string): Promise<string> {
  if (isSvgConditioningUrl(dataUrl)) {
    return withTimeoutFallback(
      rasterizeConditioningImage(dataUrl).catch(() => dataUrl),
      CONDITIONING_IMAGE_NORMALIZE_TIMEOUT_MS,
      () => dataUrl,
    );
  }
  if (isInlineImageDataUrl(dataUrl) && dataUrl.length > 262144) {
    return withTimeoutFallback(
      rasterizeConditioningImage(dataUrl).catch(() => dataUrl),
      CONDITIONING_IMAGE_NORMALIZE_TIMEOUT_MS,
      () => dataUrl,
    );
  }
  return dataUrl;
}

async function blobConditioningUrlToDataUrl(url: string): Promise<string> {
  const cached = blobConditioningUrlCache.get(url);
  if (cached) return cached;

  const pending = (async () => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to read local media blob: HTTP ${response.status}.`);
    }
    const blob = await response.blob();
    const dataUrl = await blobToDataUrl(blob);
    return normalizeConditioningDataUrl(dataUrl);
  })();

  blobConditioningUrlCache.set(url, pending);
  try {
    return await pending;
  } catch (error) {
    blobConditioningUrlCache.delete(url);
    throw error;
  }
}

async function localConditioningUrlToDataUrl(url: string): Promise<string> {
  const cached = blobConditioningUrlCache.get(url);
  if (cached) return cached;

  const pending = (async () => {
    const blob = readLocalMediaBlob(url);
    if (!blob) {
      throw new Error('Failed to read local media handle.');
    }
    const dataUrl = await blobToDataUrl(blob);
    return normalizeConditioningDataUrl(dataUrl);
  })();

  blobConditioningUrlCache.set(url, pending);
  try {
    return await pending;
  } catch (error) {
    blobConditioningUrlCache.delete(url);
    throw error;
  }
}

async function materializeConditioningUrl(value: unknown): Promise<unknown> {
  if (isLocalConditioningUrl(value)) {
    return localConditioningUrlToDataUrl(String(value));
  }
  if (isBlobConditioningUrl(value)) {
    return blobConditioningUrlToDataUrl(String(value));
  }
  if (isSvgConditioningUrl(value)) {
    return normalizeConditioningDataUrl(String(value));
  }
  return value;
}

const atmosphereOnlyReferenceCache = new Map<string, Promise<string>>();
const localImageConditioningUrlCache = new Map<string, Promise<string>>();
const localVideoConditioningUrlCache = new Map<string, Promise<string>>();

function mediaExtensionFromMimeType(mimeType = 'application/octet-stream') {
  const normalized = String(mimeType || '').trim().toLowerCase();
  if (normalized.includes('webm')) return 'webm';
  if (normalized.includes('mp4')) return 'mp4';
  if (normalized.includes('quicktime') || normalized.includes('mov')) return 'mov';
  if (normalized.includes('ogg') || normalized.includes('ogv')) return 'ogv';
  if (normalized.includes('x-matroska') || normalized.includes('mkv')) return 'mkv';
  if (normalized.includes('avi')) return 'avi';
  if (normalized.includes('png')) return 'png';
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg';
  return 'bin';
}

function isServerHostedConditioningUrl(value: unknown) {
  const raw = String(value || '').trim();
  return raw.startsWith('/api/assets/content/') || raw.startsWith('/api/media-proxy?');
}

async function materializeLocalImageConditioningUrl(value: unknown): Promise<unknown> {
  const raw = String(value || '').trim();
  if (!raw) return value;
  if (isServerHostedConditioningUrl(raw) || /^https?:\/\//i.test(raw)) return raw;

  const cached = localImageConditioningUrlCache.get(raw);
  if (cached) return cached;

  const pending = (async () => {
    let normalizedUrl = raw;
    if (isLocalMediaHandle(raw)) {
      normalizedUrl = await localConditioningUrlToDataUrl(raw);
    } else if (isTransientBlobUrl(raw) || raw.startsWith('blob:')) {
      normalizedUrl = await blobConditioningUrlToDataUrl(raw);
    } else if (raw.startsWith('data:image/')) {
      normalizedUrl = await normalizeConditioningDataUrl(raw);
    }
    if (!String(normalizedUrl || '').trim().startsWith('data:image/')) return normalizedUrl;
    const response = await fetch(String(normalizedUrl));
    if (!response.ok) {
      throw new Error(`Failed to read local image blob: HTTP ${response.status}.`);
    }
    const blob = await response.blob();
    if (typeof File === 'undefined') {
      throw new Error('file-constructor-unavailable');
    }
    const extension = mediaExtensionFromMimeType(blob.type || 'image/png');
    const file = new File([blob], `hmdao-conditioning-image.${extension}`, {
      type: blob.type || 'image/png',
      lastModified: Date.now(),
    });
    const imported = await importLocalAssetFile(file, {
      folderId: 'root',
      sourceUrl: raw,
      tags: ['HMDao', 'conditioning-image'],
      smartCategories: ['图片参考', '本地转存'],
    });
    return String(imported.item?.url || normalizedUrl);
  })();

  localImageConditioningUrlCache.set(raw, pending);
  try {
    return await pending;
  } catch (error) {
    localImageConditioningUrlCache.delete(raw);
    throw error;
  }
}

async function materializeLocalVideoConditioningUrl(value: unknown): Promise<unknown> {
  const raw = String(value || '').trim();
  if (!raw) return value;
  if (isServerHostedConditioningUrl(raw) || /^https?:\/\//i.test(raw)) return raw;

  const cached = localVideoConditioningUrlCache.get(raw);
  if (cached) return cached;

  const pending = (async () => {
    let blob: Blob | null = null;
    if (isLocalMediaHandle(raw)) {
      blob = readLocalMediaBlob(raw);
    } else if (isTransientBlobUrl(raw) || raw.startsWith('blob:')) {
      const response = await fetch(raw);
      if (!response.ok) {
        throw new Error(`Failed to read local video blob: HTTP ${response.status}.`);
      }
      blob = await response.blob();
    }
    if (!blob) return raw;
    if (typeof File === 'undefined') {
      throw new Error('file-constructor-unavailable');
    }
    const extension = mediaExtensionFromMimeType(blob.type || 'video/webm');
    const file = new File([blob], `hmdao-conditioning-video.${extension}`, {
      type: blob.type || 'video/webm',
      lastModified: Date.now(),
    });
    const imported = await importLocalAssetFile(file, {
      folderId: 'root',
      sourceUrl: raw,
      tags: ['HMDao', 'conditioning-video'],
      smartCategories: ['视频参考', '本地转存'],
    });
    return String(imported.item?.url || raw);
  })();

  localVideoConditioningUrlCache.set(raw, pending);
  try {
    return await pending;
  } catch (error) {
    localVideoConditioningUrlCache.delete(raw);
    throw error;
  }
}

function shouldDeriveAtmosphereOnlyReference(
  record: Record<string, unknown>,
  options?: { imageStrategyOperation?: string | undefined },
) {
  if (!isStrictImageSubjectSwapOperation(options?.imageStrategyOperation)) return false;
  const mediaType = String(record.type || record.media_type || '').trim().toLowerCase();
  if (mediaType !== 'image') return false;
  const role = String(record.role || '').trim().toLowerCase();
  const bindingRole = String(record.binding_role || '').trim().toLowerCase();
  const coverageRoles = Array.isArray(record.coverage_roles)
    ? record.coverage_roles.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean)
    : [];
  return role === 'lighting'
    || bindingRole === 'background-reference'
    || coverageRoles.includes('lighting');
}

async function loadConditioningImage(url: string): Promise<HTMLImageElement> {
  if (typeof Image === 'undefined') {
    throw new Error('image-constructor-unavailable');
  }
  return await new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('image-load-failed'));
    image.src = url;
  });
}

async function deriveAtmosphereOnlyReferenceUrl(url: string): Promise<string> {
  if (!url || typeof document === 'undefined') return url;
  const cached = atmosphereOnlyReferenceCache.get(url);
  if (cached) return await cached;

  const pending = (async () => {
    const image = await loadConditioningImage(url);
    const width = Math.max(1, image.naturalWidth || image.width || 1);
    const height = Math.max(1, image.naturalHeight || image.height || 1);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return url;

    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = width;
    sourceCanvas.height = height;
    const sourceContext = sourceCanvas.getContext('2d');
    if (!sourceContext) return url;
    sourceContext.drawImage(image, 0, 0, width, height);

    const skySourceHeight = Math.max(1, Math.round(height * 0.44));
    const skyTargetHeight = Math.max(skySourceHeight, Math.round(height * 0.56));
    const lowerSourceY = Math.max(0, Math.round(height * 0.68));
    const lowerSourceHeight = Math.max(1, height - lowerSourceY);
    const sideStripWidth = Math.max(1, Math.round(width * 0.18));
    const rightStripX = Math.max(0, width - sideStripWidth);
    const centerMaskX = Math.max(0, Math.round(width * 0.18));
    const centerMaskY = Math.max(0, Math.round(height * 0.2));
    const centerMaskWidth = Math.max(1, Math.round(width * 0.64));
    const centerMaskHeight = Math.max(1, Math.round(height * 0.58));

    context.filter = 'blur(22px) saturate(1.08)';
    context.drawImage(sourceCanvas, 0, 0, width, height);
    context.filter = 'none';

    context.drawImage(sourceCanvas, 0, 0, width, skySourceHeight, 0, 0, width, skyTargetHeight);

    const lowerTargetY = Math.max(0, Math.round(height * 0.62));
    const lowerTargetHeight = Math.max(1, height - lowerTargetY);
    context.globalAlpha = 0.82;
    context.drawImage(sourceCanvas, 0, lowerSourceY, sideStripWidth, lowerSourceHeight, 0, lowerTargetY, Math.round(width * 0.55), lowerTargetHeight);
    context.drawImage(sourceCanvas, rightStripX, lowerSourceY, sideStripWidth, lowerSourceHeight, Math.round(width * 0.45), lowerTargetY, Math.round(width * 0.55), lowerTargetHeight);
    context.globalAlpha = 1;

    context.save();
    context.beginPath();
    context.rect(centerMaskX, centerMaskY, centerMaskWidth, centerMaskHeight);
    context.clip();
    context.filter = 'blur(44px) saturate(1.04)';
    context.drawImage(sourceCanvas, 0, 0, width, height);
    context.restore();
    context.filter = 'none';

    const atmosphereGlow = context.createLinearGradient(0, 0, 0, height);
    atmosphereGlow.addColorStop(0, 'rgba(255,255,255,0.05)');
    atmosphereGlow.addColorStop(0.58, 'rgba(255,255,255,0)');
    atmosphereGlow.addColorStop(1, 'rgba(255,255,255,0.08)');
    context.fillStyle = atmosphereGlow;
    context.fillRect(0, 0, width, height);

    return normalizeConditioningDataUrl(canvas.toDataURL('image/png'));
  })();

  atmosphereOnlyReferenceCache.set(url, pending);
  try {
    return await pending;
  } catch (error) {
    atmosphereOnlyReferenceCache.delete(url);
    throw error;
  }
}

async function materializeReferenceAssetUrls(
  value: unknown,
  options?: { imageStrategyOperation?: string | undefined },
): Promise<unknown> {
  if (!Array.isArray(value)) return value;
  return await Promise.all(value.map(async (item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    const mediaType = String(record.type || record.media_type || '').trim().toLowerCase();
    const persistedAssetId = readPersistedAssetId(record.persisted_asset_id || record.asset_id, typeof record.url === 'string' ? record.url : '');
    const stableUrl = resolveStableGenerationAssetUrl(record.url, persistedAssetId);
    if (mediaType === 'video') {
      const materializedUrl = await materializeLocalVideoConditioningUrl(stableUrl);
      return {
        ...record,
        url: typeof materializedUrl === 'string' ? materializedUrl : stableUrl,
      };
    }
    if (mediaType !== 'image') return item;
    const materializedUrl = await materializeLocalImageConditioningUrl(stableUrl);
    const normalizedUrl = typeof materializedUrl === 'string' ? materializedUrl : stableUrl;
    const derivedAtmosphereOnly = shouldDeriveAtmosphereOnlyReference(record, options)
      ? await deriveAtmosphereOnlyReferenceUrl(String(normalizedUrl || ''))
      : normalizedUrl;
    const persistedDerivedUrl = shouldDeriveAtmosphereOnlyReference(record, options)
      ? await materializeLocalImageConditioningUrl(derivedAtmosphereOnly)
      : normalizedUrl;
    return {
      ...record,
      url: persistedDerivedUrl,
      derived_from_url: typeof persistedDerivedUrl === 'string' && persistedDerivedUrl !== normalizedUrl ? normalizedUrl : undefined,
      preprocess: typeof persistedDerivedUrl === 'string' && persistedDerivedUrl !== normalizedUrl
        ? 'background-atmosphere-plate'
        : record.preprocess,
    };
  }));
}

async function materializeGenerationBodyAssets(body: SanitizedGenerationBody): Promise<SanitizedGenerationBody> {
  const sourceMediaType = String(body.source_media_type || '').trim().toLowerCase();
  const imageStrategyOperation = typeof body.conditioning_strategy === 'object' && body.conditioning_strategy && !Array.isArray(body.conditioning_strategy)
    ? String((body.conditioning_strategy as Record<string, unknown>).operation || '').trim()
    : '';
  const stableSourceUrl = resolveStableGenerationAssetUrl(body.source_url, body.source_asset_id);
  const sourceUrlPromise = sourceMediaType === 'video'
    ? materializeLocalVideoConditioningUrl(stableSourceUrl)
    : materializeLocalImageConditioningUrl(stableSourceUrl);
  const firstFramePromise = materializeLocalImageConditioningUrl(body.first_frame_url);
  const lastFramePromise = materializeLocalImageConditioningUrl(body.last_frame_url);
  const referenceImagePromise = materializeLocalImageConditioningUrl(body.reference_image_url);
  const referenceVideoPromise = materializeLocalVideoConditioningUrl(body.reference_video_url);
  const primaryAssetsPromise = materializeReferenceAssetUrls(body.primary_assets, { imageStrategyOperation });
  const referenceAssetsPromise = materializeReferenceAssetUrls(body.reference_assets, { imageStrategyOperation });
  const [
    sourceUrl,
    firstFrameUrl,
    lastFrameUrl,
    referenceImageUrl,
    referenceVideoUrl,
    primaryAssets,
    referenceAssets,
  ] = await Promise.all([
    sourceUrlPromise,
    firstFramePromise,
    lastFramePromise,
    referenceImagePromise,
    referenceVideoPromise,
    primaryAssetsPromise,
    referenceAssetsPromise,
  ]);
  return compactRecord({
    ...body,
    source_url: sourceUrl,
    first_frame_url: firstFrameUrl,
    last_frame_url: lastFrameUrl,
    reference_image_url: referenceImageUrl,
    reference_video_url: referenceVideoUrl,
    primary_assets: primaryAssets,
    reference_assets: referenceAssets,
  });
}

function summarizeInlineMedia(value: string): string {
  if (!value.startsWith('data:') || value.length < 2048) return value;
  const header = value.slice(0, Math.max(value.indexOf(',') + 1, 0)) || 'data:application/octet-stream;base64,';
  return `${header}[inline-media:${value.length}]`;
}

function sanitizeStoredGenerationBody<T>(value: T): T {
  if (typeof value === 'string') {
    return summarizeInlineMedia(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeStoredGenerationBody(item)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, sanitizeStoredGenerationBody(item)]),
    ) as T;
  }
  return value;
}

function isLocalFallbackAsset(asset: WorkflowGenerationResult['asset'] | undefined): boolean {
  if (!asset) return false;
  const url = typeof asset.url === 'string' ? asset.url : '';
  const metadata = asset.metadata as Record<string, unknown> | undefined;
  return Boolean(metadata?.fallback) || asset.kind === 'procedural-video' || url.startsWith('data:image/svg+xml');
}

function isLocalFallbackResult(result: WorkflowGenerationResult): boolean {
  if (isLocalFallbackAsset(result.asset)) return true;
  return Array.isArray(result.assets) && result.assets.some((asset) => isLocalFallbackAsset(asset));
}

function generationModeForNode(type: NodeType): GenerationMode {
  if (type === 'image' || type === 'threed' || type === 'dcc') return 'image';
  if (type === 'video') return 'video';
  if (type === 'audio') return 'audio';
  return 'llm';
}

function endpointForNode(type: NodeType): string {
  if (type === 'image' || type === 'threed' || type === 'dcc') return '/images/generations';
  if (type === 'video') return '/videos/generations';
  if (type === 'audio') return '/tts';
  return '/chat/completions';
}

function outputTypeForNode(type: NodeType): MediaOutput['type'] {
  if (type === 'image' || type === 'threed' || type === 'dcc') return 'image';
  if (type === 'video') return 'video';
  if (type === 'audio') return 'audio';
  return 'text';
}

function normalizeWorkflowNodeResult(nodeResult: WorkflowNodeResult | undefined): WorkflowGenerationResult {
  if (!nodeResult) {
    return {
      success: false,
      error: { message: 'Workflow completed without a node result.' },
    };
  }
  return {
    success: nodeResult.status === 'completed',
    provider: nodeResult.provider,
    mode: generationModeForNode(nodeResult.nodeType),
    content: nodeResult.content,
    asset: nodeResult.asset,
    assets: Array.isArray((nodeResult as WorkflowNodeResult & { assets?: unknown }).assets)
      ? (nodeResult as WorkflowNodeResult & { assets?: ProxyGenerationResult['assets'] }).assets
      : undefined,
    error: nodeResult.error,
  };
}

export function resolveGenerationAccess(
  nodeType: NodeType,
  model: string | undefined,
  provider: string | undefined,
  keys: Record<string, ProviderKeyState>,
  authenticated: boolean,
  remoteActivated = false,
  options?: {
    strictProvider?: boolean;
    allowProviderOnlyActivation?: boolean;
  },
): GenerationAccess {
  const mode = generationModeForNode(nodeType);
  const preferredProvider = normalizeProvider(provider) || providerHintForModel(String(model || '')) || MODE_PROVIDERS[mode][0];
  const allowProviderOnlyActivation = options?.allowProviderOnlyActivation ?? true;
  const allowLocalDemoAccess = allowsLocalCanvasDemoAccess();
  const candidates = options?.strictProvider
    ? [preferredProvider].filter(Boolean)
    : Array.from(new Set([
      preferredProvider,
      ...MODE_PROVIDERS[mode],
      ...Object.values(keys)
        .map((item) => item?.provider)
        .filter((item): item is string => Boolean(item && supportsMode(item, mode))),
    ].filter(Boolean)));

  if (!authenticated && !allowLocalDemoAccess) {
    return { ok: false, mode, provider: preferredProvider, reason: 'auth' };
  }

  for (const item of candidates) {
    const key = findProviderKeyState(keys, item, mode);
    if (
      canUseKeyForMode(key, item, mode, true)
      && providerKeyMatchesModel(key, model, { allowProviderOnlyFallback: allowProviderOnlyActivation })
    ) {
      return { ok: true, mode, provider: item, apiKey: key?.apiKey, endpoint: key?.endpoint };
    }
  }

  const metadataOnlyKey = findProviderKeyState(keys, preferredProvider, mode);
  if (
    canUseKeyForMode(metadataOnlyKey, preferredProvider, mode, false)
    && providerKeyMatchesModel(metadataOnlyKey, model, { allowProviderOnlyFallback: allowProviderOnlyActivation })
  ) {
    return { ok: true, mode, provider: preferredProvider, apiKey: '', endpoint: metadataOnlyKey?.endpoint };
  }

  if (remoteActivated) {
    return { ok: true, mode, provider: preferredProvider, apiKey: '' };
  }

  return { ok: false, mode, provider: preferredProvider, reason: 'api-key' };
}

function isUsableAssetUrl(url?: string) {
  if (!url) return false;
  return (
    url.startsWith('data:') ||
    url.startsWith('blob:') ||
    isLocalMediaHandle(url) ||
    url.startsWith('http://') ||
    url.startsWith('https://') ||
    url.startsWith('/')
  );
}

async function sha256Hex(buffer: ArrayBuffer) {
  if (typeof crypto === 'undefined' || !crypto.subtle) return '';
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function validateAssetIntegrity(
  asset: ProxyGenerationResult['asset'] | undefined,
  outputType: MediaOutput['type'],
) {
  const url = asset?.url;
  if (!url) {
    if (outputType !== 'text') {
      throw new Error('Generation succeeded but did not return a media asset.');
    }
    return;
  }

  if (!isUsableAssetUrl(url)) {
    throw new Error('Model returned an unsupported media URL.');
  }

  const metadata = asset?.metadata || {};
  const expectedBytes = Number(metadata.bytes);
  const expectedHash = typeof metadata.sha256 === 'string' ? metadata.sha256.trim().toLowerCase() : '';
  const shouldValidatePayload =
    (url.startsWith('data:') || url.startsWith('blob:')) &&
    (Number.isFinite(expectedBytes) || Boolean(expectedHash));

  if (!shouldValidatePayload) return;

  const response = await fetch(url);
  const buffer = await response.arrayBuffer();

  if (Number.isFinite(expectedBytes) && buffer.byteLength !== expectedBytes) {
    throw new Error(`Media payload size mismatch: expected ${expectedBytes} bytes, got ${buffer.byteLength}.`);
  }

  if (expectedHash) {
    const digest = await sha256Hex(buffer);
    if (digest && digest !== expectedHash) {
      throw new Error('Media payload checksum verification failed.');
    }
  }
}

export async function createProceduralVideo(prompt: string, durationMs = 3200): Promise<{ url: string; managedUrl: boolean }> {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Current browser does not support procedural video generation.');

  const stream = canvas.captureStream(24);
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : 'video/webm';
  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks: Blob[] = [];

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  const stopped = new Promise<{ url: string; managedUrl: boolean }>((resolve, reject) => {
    recorder.onerror = () => reject(new Error('Failed to record procedural preview video.'));
    recorder.onstop = () => resolve({
      url: URL.createObjectURL(new Blob(chunks, { type: 'video/webm' })),
      managedUrl: true,
    });
  });

  const startedAt = performance.now();
  let frameId = 0;

  const draw = (now: number) => {
    const progress = Math.min((now - startedAt) / durationMs, 1);
    const hue = Math.round(180 + progress * 110);

    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, `hsl(${hue}, 70%, 14%)`);
    gradient.addColorStop(0.55, '#0f766e');
    gradient.addColorStop(1, '#111827');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = `rgba(34, 211, 238, ${0.18 + progress * 0.12})`;
    ctx.beginPath();
    ctx.arc(260 + progress * 760, 210 + Math.sin(progress * Math.PI * 2) * 80, 110, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ecfeff';
    ctx.font = '700 58px Arial, sans-serif';
    ctx.fillText('DDUp Video', 80, 130);
    ctx.fillStyle = '#a7f3d0';
    ctx.font = '28px Arial, sans-serif';
    ctx.fillText(`Progress ${(progress * 100).toFixed(0)}%`, 80, 182);

    ctx.fillStyle = '#ffffff';
    ctx.font = '42px Arial, sans-serif';
    const words = prompt || 'DDUp local procedural preview';
    const lines = words.match(/.{1,24}/g) || [words];
    lines.slice(0, 5).forEach((line, index) => ctx.fillText(line, 80, 300 + index * 58));

    if (progress < 1) frameId = requestAnimationFrame(draw);
    else recorder.stop();
  };

  recorder.start();
  frameId = requestAnimationFrame(draw);

  try {
    return await stopped;
  } finally {
    cancelAnimationFrame(frameId);
    stream.getTracks().forEach((track) => track.stop());
  }
}

export async function generateNodeOutput({
  nodeId,
  nodeType,
  prompt,
  provider,
  apiKey,
  baseUrl,
  model,
  persistedModel,
  data,
  onRequestBody,
}: {
  nodeId: string;
  nodeType: NodeType;
  prompt: string;
  provider: string;
  apiKey: string;
  baseUrl?: string;
  model: string;
  persistedModel?: string;
  data: NodeData;
  onRequestBody?: (requestBody: SanitizedGenerationBody) => void | Promise<void>;
}): Promise<Partial<NodeData>> {
  pushGenerationTrace('generate:start', { nodeId, nodeType, provider, model });
  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt) throw new Error('提示词不能为空。');

  const outputType = outputTypeForNode(nodeType);
  const textLike = outputType === 'text';
  const body = buildGenerationBody(nodeType, model, normalizedPrompt, data);
  pushGenerationTrace('generate:body-built', {
    nodeId,
    hasSourceUrl: typeof body.source_url === 'string' && body.source_url.length > 0,
    primaryAssetCount: Array.isArray(body.primary_assets) ? body.primary_assets.length : 0,
    referenceAssetCount: Array.isArray(body.reference_assets) ? body.reference_assets.length : 0,
  });
  let requestBody: SanitizedGenerationBody;
  try {
    pushGenerationTrace('generate:materialize:start', { nodeId });
    requestBody = await Promise.race([
      materializeGenerationBodyAssets(body),
      new Promise<SanitizedGenerationBody>((_, reject) => {
        setTimeout(() => reject(new Error('asset-materialize-timeout')), GENERATION_ASSET_MATERIALIZE_TIMEOUT_MS);
      }),
    ]);
    pushGenerationTrace('generate:materialize:done', {
      nodeId,
      hasSourceUrl: typeof requestBody.source_url === 'string' && requestBody.source_url.length > 0,
      primaryAssetCount: Array.isArray(requestBody.primary_assets) ? requestBody.primary_assets.length : 0,
      referenceAssetCount: Array.isArray(requestBody.reference_assets) ? requestBody.reference_assets.length : 0,
    });
    if (typeof onRequestBody === 'function') {
      await onRequestBody(sanitizeStoredGenerationBody(requestBody));
    }
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    pushGenerationTrace('generate:materialize:error', { nodeId, message: rawMessage });
    const timedOut = rawMessage.includes('asset-materialize-timeout');
    throw new GenerationError(
      timedOut
        ? '本地参考素材准备超时，请重新上传素材后再试。'
        : '本地参考素材读取失败，请重新上传后再试。',
      {
      category: 'validation',
      provider,
      stage: 'asset-materialize',
      code: rawMessage,
    });
  }
  pushGenerationTrace('generate:route-preview:start', { nodeId });
  const routePreview = await previewGenerationRoute(
    provider,
    endpointForNode(nodeType),
    requestBody,
    8000,
    apiKey,
    baseUrl,
  );
  pushGenerationTrace('generate:route-preview:done', {
    nodeId,
    connectivityOk: routePreview?.connectivityProbe?.ok ?? null,
    connectivityCode: routePreview?.connectivityProbe?.code ?? '',
  });
  if (routePreview?.proxyBypass?.message) {
    throw new GenerationError(routePreview.proxyBypass.message, {
      category: normalizeErrorCategory(routePreview.proxyBypass.category || 'routing'),
      provider,
      stage: 'route-preview',
      code: routePreview.proxyBypass.code,
      requestBody: sanitizeStoredGenerationBody(requestBody),
    });
  }
  if (routePreview?.connectivityProbe?.ok === false) {
    const message = routePreview.connectivityProbe.message
      || routePreview.connectivityProbe.code
      || '当前真实上游暂不可达。';
    throw new GenerationError(message, {
      category: 'routing',
      provider,
      stage: 'route-connectivity',
      code: routePreview.connectivityProbe.code,
      requestBody: sanitizeStoredGenerationBody(requestBody),
    });
  }
  const routedProvider = normalizeProvider(routePreview?.effectiveProvider || provider) || provider;
  const routedModel = String(routePreview?.effectiveModel || requestBody.model || model).trim() || model;
  const routedApiKey = routedProvider === provider ? apiKey : '';
  const routedBaseUrl = routedProvider === provider ? baseUrl : undefined;
  const routedRequestBody: SanitizedGenerationBody = routedModel !== String(requestBody.model || '').trim()
    ? {
        ...requestBody,
        model: routedModel,
      }
    : requestBody;
  if (typeof onRequestBody === 'function' && routedRequestBody !== requestBody) {
    await onRequestBody(sanitizeStoredGenerationBody(routedRequestBody));
  }
  const cacheKey = buildGenerationCacheKey(nodeType, routedProvider, routedModel, routedRequestBody);
  const cachedResult = getCachedGeneration(cacheKey);
  if (cachedResult?.success) {
    const cachedUrl = cachedResult.asset?.url;
    const cachedAssets = Array.isArray(cachedResult.assets) && cachedResult.assets.length > 0
      ? cachedResult.assets
      : cachedResult.asset
        ? [cachedResult.asset]
        : [];
    const outputs = cachedAssets
      .filter((asset): asset is NonNullable<ProxyGenerationResult['asset']> => Boolean(asset?.url))
      .map((asset, index) => ({
        id: asset.id || `${nodeType}-${Date.now()}-${index}`,
        type: outputType,
        url: asset.url || '',
        prompt: normalizedPrompt,
        metadata: {
          provider: routedProvider,
          model: routedModel,
          cached: true,
          outputIndex: index,
          outputCount: cachedAssets.length,
          ...(asset.metadata || {}),
        },
      } satisfies MediaOutput));
    const output: MediaOutput | null = cachedUrl
      ? {
          id: cachedResult.asset?.id || `${nodeType}-${Date.now()}`,
          type: outputType,
          url: cachedUrl,
          prompt: normalizedPrompt,
        metadata: {
            provider: routedProvider,
            model: routedModel,
            cached: true,
            ...(cachedResult.asset?.metadata || {}),
          },
        }
      : null;

    return {
      prompt: normalizedPrompt,
      provider: routedProvider,
      model: routePreview?.effectiveModel || persistedModel || routedModel,
      status: 'completed',
      error: undefined,
      content: cachedResult.content || (textLike ? `已生成内容：${normalizedPrompt}` : data.content),
      imageUrl: outputType === 'image' ? cachedUrl : undefined,
      videoUrl: outputType === 'video' ? cachedUrl : undefined,
      outputs: outputs.length > 0 ? outputs : data.outputs,
      params: {
        ...(data.params || {}),
        lastGeneratedAt: Date.now(),
        lastError: undefined,
        lastErrorCategory: undefined,
        lastErrorStage: undefined,
        failedAt: undefined,
        requestBody: sanitizeStoredGenerationBody(routedRequestBody),
        generationProgress: [{ stage: 'cache', progress: 100, message: '已从缓存加载。' }],
        cacheHit: true,
        retryCount: 0,
        routedProvider,
        routedModel,
        routePreviewDispatchMode: routePreview?.dispatchMode,
        mediaIntegrity: output?.metadata || cachedResult.asset?.metadata || {},
      },
    };
  }

  const timeout = nodeType === 'video' ? VIDEO_GENERATION_TIMEOUT_MS : IMAGE_GENERATION_TIMEOUT_MS;
  const requestId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  async function executeAttempt(): Promise<WorkflowGenerationResult> {
    // 火山方舟接入点拦截：provider 为 volcengine 且目录中该模型尚无可用推理接入点（endpointId）时，
    // 直接拦截，避免向上游发送裸模型名导致 404（图像/视频）或被静默 fallback 掩盖（文本），引导用户配置接入点。
    // 注意：routedModel 始终是裸目录 id（后端控制器层才会解析为 ep-xxxx），故以目录 endpointId 为准判断可用性。
    if (routedProvider === 'volcengine' && !/^ep-/.test(routedModel)) {
      const catalogEntry = useModelCatalogStore
        .getState()
        .models.find((m) => m.id === model || m.model === model || m.upstreamModel === model);
      const hasEndpoint = Boolean(catalogEntry?.endpointId);
      if (catalogEntry && catalogEntry.requiresEndpoint && !hasEndpoint) {
        throw new GenerationError(
          '火山方舟模型需要推理接入点（ep-xxxx）才能调用。若已在 API Keys 页填写火山 AccessKey/SecretKey，'
          + '请稍候系统自动创建接入点（可在模型目录查看该模型的 endpointId 状态）；否则请前往火山方舟控制台手动创建推理接入点后重试。',
          { category: 'routing', provider: 'volcengine', model: routedModel, stage: 'ark-endpoint', code: 'ark-endpoint-required' },
        );
      }
    }
    let result: WorkflowGenerationResult;
    let workflowFailure: Error | null = null;
    try {
      const workflowClient = getWorkflowClient();
      const workflowResult = await workflowClient.runWorkflow(
        {
          name: `${nodeType}-${nodeId}`,
          nodes: [
            {
              node_id: nodeId,
              nodeType,
              provider: routedProvider,
              model: routedModel,
              prompt: normalizedPrompt,
              endpoint: endpointForNode(nodeType),
              body: routedRequestBody,
              apiKey: routedApiKey,
              baseUrl: routedBaseUrl,
              timeout,
              metadata: {
                nodeType,
                outputType,
                requestId,
              },
            },
          ],
          metadata: {
            source: 'hmdao-canvas',
            nodeType,
            requestId,
          },
        },
        { timeoutMs: timeout + 15000 },
      );
      result = {
        ...normalizeWorkflowNodeResult(workflowResult.nodeResults.find((item) => item.node_id === nodeId)),
        progressLog: workflowResult.progressLog,
      };
    } catch (workflowError) {
      workflowFailure = workflowError instanceof Error ? workflowError : new Error(String(workflowError));
      result = await proxyRequest(routedProvider, {
        endpoint: endpointForNode(nodeType),
        method: 'POST',
        body: routedRequestBody,
        timeout,
        apiKey: routedApiKey,
        baseUrl: routedBaseUrl,
      }) as WorkflowGenerationResult;
      if (!result.success && workflowFailure && !result.error?.message) {
        result.error = { message: workflowFailure.message };
      }
      if (result.success && isLocalFallbackResult(result)) {
        result.fallbackReason = workflowFailure?.message;
      }
    }
    return result;
  }

  let result = await executeAttempt();
  let retryCount = 0;

  if (!result.success) {
    const initialError = new GenerationError(result.error?.message || 'Generation request failed.', {
      category: normalizeErrorCategory(result.error?.category),
      provider: result.error?.provider || routedProvider,
      model: routedModel,
      status: result.error?.status,
      code: result.error?.code,
      stage: 'request',
      requestId,
      requestBody: sanitizeStoredGenerationBody(routedRequestBody),
      workflowProgress: result.progressLog,
    });
    if (!shouldRetryGeneration(initialError)) {
      throw initialError;
    }
    retryCount = 1;
    result = await executeAttempt();
    if (!result.success) {
      throw new GenerationError(result.error?.message || initialError.message, {
        category: normalizeErrorCategory(result.error?.category),
        provider: result.error?.provider || routedProvider,
        model: routedModel,
        status: result.error?.status,
        code: result.error?.code,
        stage: 'retry',
        requestId,
        requestBody: sanitizeStoredGenerationBody(routedRequestBody),
        workflowProgress: result.progressLog,
      });
    }
  }

  let outputUrl = result.asset?.url;
  let managedUrl = Boolean(result.asset?.metadata?.managedUrl);
  let resultAssets = Array.isArray(result.assets) && result.assets.length > 0
    ? result.assets
    : result.asset
      ? [result.asset]
      : [];

  if (nodeType === 'video' && (!outputUrl || result.asset?.kind === 'procedural-video')) {
    const localVideo = await createProceduralVideo(normalizedPrompt);
    outputUrl = localVideo.url;
    managedUrl = localVideo.managedUrl;
    resultAssets = [{
      ...(result.asset || {}),
      id: result.asset?.id || `${nodeType}-${Date.now()}`,
      type: outputType,
      url: outputUrl,
      metadata: {
        ...(result.asset?.metadata || {}),
        managedUrl,
      },
    }];
  }

  await Promise.all(resultAssets.map((asset) => validateAssetIntegrity(asset, outputType)));

  const outputs = resultAssets
    .filter((asset): asset is NonNullable<ProxyGenerationResult['asset']> => Boolean(asset?.url))
    .map((asset, index) => {
      const originalUrl = asset.url || '';
      const renderUrl = toRenderableAssetUrl(originalUrl, outputType as 'image' | 'video' | 'audio');
      return {
        id: asset.id || `${nodeType}-${Date.now()}-${index}`,
        type: outputType,
        url: renderUrl,
        prompt: normalizedPrompt,
        metadata: {
          provider: routedProvider,
          model: routedModel,
          originalUrl,
          proxyUrl: renderUrl !== originalUrl ? renderUrl : undefined,
          managedUrl: Boolean((asset.metadata?.managedUrl ?? managedUrl) || renderUrl !== originalUrl),
          retryCount,
          outputIndex: index,
          outputCount: resultAssets.length,
          workflowFallback: Boolean((result as WorkflowGenerationResult).fallbackReason),
          workflowFallbackReason: (result as WorkflowGenerationResult).fallbackReason,
          ...(asset.metadata || {}),
        },
      } satisfies MediaOutput;
    });

  const output = outputs[0] || null;
  outputUrl = output?.url;

  if (shouldCacheGenerationResult(result)) {
    setCachedGeneration(cacheKey, result);
  }

  return {
    prompt: normalizedPrompt,
    provider: routedProvider,
    model: routePreview?.effectiveModel || persistedModel || routedModel,
    status: 'completed',
    error: undefined,
    content: result.content || (textLike ? `已生成内容：${normalizedPrompt}` : data.content),
    imageUrl: outputType === 'image' ? outputUrl : undefined,
    videoUrl: outputType === 'video' ? outputUrl : undefined,
    outputs: outputs.length > 0 ? outputs : data.outputs,
    params: {
      ...(data.params || {}),
      lastGeneratedAt: Date.now(),
      lastRequestId: requestId,
      lastError: undefined,
      lastErrorCategory: undefined,
      lastErrorStage: undefined,
      failedAt: undefined,
      requestBody: sanitizeStoredGenerationBody(routedRequestBody),
      generationProgress: result.progressLog || [],
      cacheHit: false,
      retryCount,
      routedProvider,
      routedModel,
      routePreviewDispatchMode: routePreview?.dispatchMode,
      workflowFallbackReason: (result as WorkflowGenerationResult).fallbackReason,
      mediaIntegrity: output?.metadata || result.asset?.metadata || {},
    },
  };
}

/**
 * 运行期「免费额度模型优先 → 不行则按优先级切换付费 API 模型」封装。
 *
 * - 若节点 data 携带 modelFallbackChain（智能体「免费优先路线」写入），则依次尝试每条候选：
 *   免费模型生成失败（配额耗尽 / 403 / 超时等）时自动切换到按优先级排列的下一条（付费）模型。
 * - 若未携带回退链，则回退到普通的 generateNodeOutput 行为（不破坏既有节点逻辑）。
 *
 * 返回的结果会附带 modelFallbackUsedProvider / modelFallbackUsedModel / modelFallbackAutoSwitched /
 * modelFallbackReason，便于 UI 显示「免费优先 / 已自动切换模型」。
 */
export async function generateNodeOutputWithFallback(
  params: Parameters<typeof generateNodeOutput>[0] & { freeFirst?: boolean },
): Promise<Partial<NodeData>> {
  const dataType = (params.data ?? {}) as unknown as Record<string, unknown>;
  const fromPlan = extractFallbackChain(dataType);

  let candidates: ModelCandidate[] | null = fromPlan;
  if (!candidates && params.freeFirst) {
    const res = resolveModelForTask(params.nodeType, { preferFree: true });
    if (res) candidates = res.fallbackChain;
  }

  // 无回退链：保持原有行为
  if (!candidates || candidates.length === 0) {
    return generateNodeOutput(params);
  }

  let lastError: unknown = null;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!c.provider || !c.model) continue;
    try {
      const result = await generateNodeOutput({
        ...(params as Parameters<typeof generateNodeOutput>[0]),
        // 切换候选模型：清空显式 apiKey/baseUrl，让 generateNodeOutput 按候选 provider 重新解析密钥与端点
        apiKey: '',
        baseUrl: undefined,
        provider: c.provider,
        model: c.model,
        persistedModel: c.model,
        data: {
          ...(params.data ?? {}),
          model: c.model,
          provider: c.provider,
          status: 'generating',
        } as NodeData,
      });
      return {
        ...result,
        model: c.model,
        provider: c.provider,
        modelFallbackUsedProvider: c.provider,
        modelFallbackUsedModel: c.model,
        modelFallbackAutoSwitched: i > 0,
        modelFallbackReason:
          i > 0
            ? `免费模型生成失败，已按优先级切换到 ${c.provider}/${c.model}`
            : (dataType.modelFallbackReason as string) || '',
      };
    } catch (err) {
      lastError = err;
      // 继续尝试下一条候选
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(lastError ? String(lastError) : '所有候选模型均生成失败');
}

