// Shared types, interfaces and pure config constants for generation.ts.
// Extracted during incremental decoupling — no behavior change.
import type { WorkflowProgressSnapshot } from '@/services/workflow';
import type { NodeType } from '@/types';

export type GenerationMode = 'llm' | 'image' | 'video' | 'audio';

export interface GenerationAccess {
  ok: boolean;
  mode: GenerationMode;
  provider: string;
  apiKey?: string;
  endpoint?: string;
  reason?: 'auth' | 'api-key';
}

export interface GenerationErrorMetadata {
  category: 'validation' | 'timeout' | 'auth' | 'quota' | 'routing' | 'upstream' | 'request' | 'render';
  provider?: string;
  model?: string;
  status?: number;
  code?: string;
  stage?: string;
  requestId?: string;
  requestBody?: SanitizedGenerationBody;
  workflowProgress?: WorkflowProgressSnapshot[];
}

export interface ProxyGenerationResult {
  success?: boolean;
  provider?: string;
  mode?: GenerationMode;
  content?: string;
  progressLog?: WorkflowProgressSnapshot[];
  asset?: {
    id?: string;
    type?: 'image' | 'video' | 'audio' | 'text';
    url?: string;
    kind?: string;
    prompt?: string;
    metadata?: Record<string, unknown>;
  };
  assets?: Array<{
    id?: string;
    type?: 'image' | 'video' | 'audio' | 'text';
    url?: string;
    kind?: string;
    prompt?: string;
    metadata?: Record<string, unknown>;
  }>;
  error?: { message?: string; category?: string; status?: number; code?: string; provider?: string };
}

export interface WorkflowGenerationResult extends ProxyGenerationResult {
  workflowId?: string;
  requestId?: string;
  nodeId?: string;
  progressLog?: WorkflowProgressSnapshot[];
  fallbackReason?: string;
}

export interface ProxyRoutePreviewResult {
  success?: boolean;
  preview?: boolean;
  provider?: string;
  requestedProvider?: string;
  effectiveProvider?: string;
  mode?: GenerationMode;
  endpoint?: string;
  requestedModel?: string;
  effectiveModel?: string;
  dispatchMode?: string;
  realProxyEnabled?: boolean;
  proxyBypass?: {
    code?: string;
    category?: string;
    message?: string;
  } | null;
  connectivityProbe?: {
    ok?: boolean;
    url?: string;
    status?: number;
    code?: string;
    message?: string;
    fallback?: boolean;
  } | null;
}

export type SanitizedGenerationBody = Record<string, unknown>;

export interface GenerationCacheEntry {
  cachedAt: number;
  expiresAt: number;
  result: ProxyGenerationResult;
}

export type RenderableAssetKind = 'image' | 'video' | 'audio';

export interface RenderableAssetIssue {
  category: 'remote-asset-expired' | 'legacy-blob' | 'render-failed';
  summary: string;
  detail: string;
  provider?: string;
  status?: number;
  expiresAt?: number;
}

export interface CanvasMigrationIssue extends RenderableAssetIssue {
  nodeId: string;
  nodeLabel: string;
  nodeType: NodeType;
  assetKind: RenderableAssetKind;
  assetUrl?: string;
}

// ---- Pure config constants (single source of truth, no behavior) ----
const PROVIDER_MODE_SUPPORT: Record<string, GenerationMode[]> = {
  deepseek: ['llm'],
  siliconflow: ['llm', 'image', 'video'],
  zhipu: ['llm', 'image', 'video'],
  bailian: ['llm', 'image', 'video'],
  minimax: ['llm', 'audio'],
  volcengine: ['image', 'video', 'audio'],
  kling: ['image', 'video'],
  modelscope: ['llm', 'image', 'video'],
  openai: ['llm', 'image'],
  fal: ['image', 'video'],
  replicate: ['image', 'video'],
};

const PROVIDER_PRIORITY: string[] = [
  'deepseek', 'siliconflow', 'openai', 'bailian', 'zhipu',
  'volcengine', 'minimax', 'modelscope', 'kling', 'fal', 'replicate',
];

const MODE_PROVIDERS: Record<GenerationMode, string[]> = (() => {
  const out = {} as Record<GenerationMode, string[]>;
  (['llm', 'image', 'video', 'audio'] as GenerationMode[]).forEach((mode) => {
    out[mode] = PROVIDER_PRIORITY.filter((p) =>
      (PROVIDER_MODE_SUPPORT[p] ?? []).includes(mode),
    );
  });
  return out;
})();

const GENERATION_CACHE_STORAGE_KEY = 'hmdao-generation-cache-v1';
const GENERATION_CACHE_TTL_MS = 1000 * 60 * 60 * 6;
const IMAGE_GENERATION_TIMEOUT_MS = 180000;
const VIDEO_GENERATION_TIMEOUT_MS = 900000;
const GENERATION_ASSET_MATERIALIZE_TIMEOUT_MS = 30000;
const CONDITIONING_IMAGE_NORMALIZE_TIMEOUT_MS = 10000;

export {
  PROVIDER_MODE_SUPPORT,
  PROVIDER_PRIORITY,
  MODE_PROVIDERS,
  GENERATION_CACHE_STORAGE_KEY,
  GENERATION_CACHE_TTL_MS,
  IMAGE_GENERATION_TIMEOUT_MS,
  VIDEO_GENERATION_TIMEOUT_MS,
  GENERATION_ASSET_MATERIALIZE_TIMEOUT_MS,
  CONDITIONING_IMAGE_NORMALIZE_TIMEOUT_MS,
};
