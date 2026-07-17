export interface ByokValidateRequest {
  provider: string;
  apiKey: string;
  mode?: 'llm' | 'image' | 'video' | 'audio';
  endpoint?: string;
  model?: string;
}

export interface ByokValidateResult {
  success: boolean;
  provider: string;
  mode: string;
  maskedKey: string;
  message?: string;
  model?: string;
  endpoint?: string;
  latencyMs?: number;
  error?: { title: string; message: string; details?: string };
}

export interface ByokProvider {
  id: string;
  name: string;
  domestic: boolean;
  modes: Array<'llm' | 'image' | 'video' | 'audio'>;
  note?: string;
}

export interface ByokValidateAllResult {
  success: boolean;
  results: ByokValidateResult[];
  summary: { total: number; success: number; failed: number };
}

export interface RelayDiscoveredModel {
  id: string;
  name: string;
  mode: 'llm' | 'image' | 'video' | 'audio';
  provider: string;
  providerLabel: string;
  catalogModelId: string | null;
  upstreamModel: string;
  supportedOnCanvas: boolean;
  recommended: boolean;
  recommendationScore: number;
  recommendation: string;
  priceUnit?: string | null;
  pricingSummary?: string | null;
  description?: string;
  price?: number | null;
  currency?: string | null;
}

export interface RelayDiscoveryResult {
  success: boolean;
  endpoint: string;
  relayPresetId: string;
  relayName?: string | null;
  message?: string;
  models: RelayDiscoveredModel[];
  recommended: Partial<Record<'llm' | 'image' | 'video' | 'audio', RelayDiscoveredModel[]>>;
  error?: { title: string; message: string; details?: string };
}

export interface RelayActivationItem {
  provider: string;
  mode: 'llm' | 'image' | 'video' | 'audio';
  model: string;
  catalogModelIds: string[];
  availableModels: Array<{
    id: string;
    name: string;
    mode: 'llm' | 'image' | 'video' | 'audio';
    catalogModelId?: string | null;
    upstreamModel?: string;
    price?: number | null;
    currency?: string | null;
    priceUnit?: string | null;
    pricingSummary?: string | null;
    recommended?: boolean;
    recommendationScore?: number;
    recommendation?: string;
  }>;
  primaryPrice?: number | null;
  primaryCurrency?: string | null;
  maskedKey: string;
}

export interface RelayActivationResult extends RelayDiscoveryResult {
  activations: RelayActivationItem[];
  latencyMs?: number;
}

export interface ByokRuntimeProviderRecord {
  provider: string;
  mode: 'llm' | 'image' | 'video' | 'audio';
  model?: string | null;
  endpoint?: string;
  relaySource?: string | null;
  relayPresetId?: string | null;
  catalogModelIds?: string[];
  availableModels?: RelayActivationItem['availableModels'];
}

export interface ByokRuntimeImageAnalysisRemote {
  provider: string;
  model: string;
  endpoint?: string;
  mode?: string;
}

export interface ByokRuntimeRecommendationCandidate {
  id: string;
  provider: string;
  providerLabel?: string;
  mode: 'llm' | 'image' | 'video' | 'audio';
  model: string;
  title: string;
  description?: string | null;
  relaySource?: string | null;
  price?: number | null;
  currency?: string | null;
  priceUnit?: string | null;
  pricingSummary?: string | null;
  recommendation?: string | null;
  recommendationScore?: number | null;
}

export interface ByokRuntimeTaskRecommendation {
  id: string;
  title: string;
  summary: string;
  tags?: string[];
  primary?: ByokRuntimeRecommendationCandidate | null;
  alternates?: ByokRuntimeRecommendationCandidate[];
  candidates?: ByokRuntimeRecommendationCandidate[];
}

export interface ByokRuntimeRecommendationSummary {
  key: 'imageGeneration' | 'imageAnalysis' | 'videoGeneration' | 'videoAnalysis' | 'audioGeneration';
  title: string;
  summary: string;
  provider: string;
  providerLabel?: string;
  mode: 'llm' | 'image' | 'video' | 'audio';
  model: string;
  relaySource?: string | null;
  price?: number | null;
  currency?: string | null;
  priceUnit?: string | null;
  pricingSummary?: string | null;
  recommendation?: string | null;
  tags?: string[];
  primary?: ByokRuntimeRecommendationCandidate | null;
  alternates?: ByokRuntimeRecommendationCandidate[];
  candidates?: ByokRuntimeRecommendationCandidate[];
  tasks?: ByokRuntimeTaskRecommendation[];
}

export interface ByokRuntimeResult {
  success: boolean;
  activatedProviders: ByokRuntimeProviderRecord[];
  selectedImageAnalysisRemote?: ByokRuntimeImageAnalysisRemote | null;
  recommendations?: Partial<Record<'imageGeneration' | 'imageAnalysis' | 'videoGeneration' | 'videoAnalysis' | 'audioGeneration', ByokRuntimeRecommendationSummary | null>>;
}

export async function getByokProviders(): Promise<ByokProvider[]> {
  const response = await fetch('/api/byok/providers');
  if (!response.ok) throw new Error(`加载平台列表失败：HTTP ${response.status}`);
  const data = await response.json() as { success: boolean; providers: ByokProvider[] };
  return data.providers || [];
}

export async function validateByokKey(
  provider: string,
  apiKey: string,
  mode?: 'llm' | 'image' | 'video' | 'audio',
  endpoint?: string,
  model?: string,
): Promise<ByokValidateResult> {
  const body: ByokValidateRequest = { provider, apiKey, mode, endpoint, model };
  const response = await fetch('/api/byok/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return await response.json() as ByokValidateResult;
}

export async function validateByokKeys(
  keys: Array<{ provider: string; apiKey: string; mode?: 'llm' | 'image' | 'video' | 'audio' }>,
): Promise<ByokValidateAllResult> {
  const response = await fetch('/api/byok/validate-all', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys }),
  });
  return await response.json() as ByokValidateAllResult;
}

export async function discoverRelayModels(
  endpoint: string,
  apiKey: string,
  relayPresetId = 'comfly',
): Promise<RelayDiscoveryResult> {
  const response = await fetch('/api/byok/relay/discover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint, apiKey, relayPresetId }),
  });
  return await response.json() as RelayDiscoveryResult;
}

export async function activateRelayModels(
  endpoint: string,
  apiKey: string,
  relayPresetId = 'comfly',
): Promise<RelayActivationResult> {
  const response = await fetch('/api/byok/relay/activate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint, apiKey, relayPresetId }),
  });
  return await response.json() as RelayActivationResult;
}

export async function getByokRuntime(): Promise<ByokRuntimeResult> {
  const response = await fetch('/api/byok/runtime', {
    cache: 'no-store',
  });
  return await response.json() as ByokRuntimeResult;
}

export async function deactivateByokKey(provider?: string, mode?: 'llm' | 'image' | 'video' | 'audio'): Promise<void> {
  await fetch('/api/byok/deactivate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, mode }),
  });
}

export function maskApiKey(key: string): string {
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '****' + key.slice(-4);
}
