import type { ModelCapabilityMatrix } from '@/types';

export interface CatalogProviderMeta {
  id: string;
  name: string;
  domestic: boolean;
  modes: string[];
}

export interface CatalogModel {
  id: string;
  name: string;
  provider: string;
  mode: 'llm' | 'image' | 'video' | 'audio';
  nodeTypes: string[];
  description: string;
  latency?: string;
  price?: number;
  currency?: string;
  discountLabel?: string;
  discountPercent?: number;
  activated: boolean;
  activatedAt?: number | null;
  model?: string | null;
  maskedKey?: string;
  activationModelMatched?: boolean;
  activationModel?: string | null;
  activationMode?: string | null;
  activationRelaySource?: string | null;
  activationAvailableModelCount?: number;
  upstreamModel?: string | null;
  providerMeta?: CatalogProviderMeta | null;
  capabilities?: ModelCapabilityMatrix | null;
}

export async function fetchModelCatalog(params?: { mode?: string; nodeType?: string }): Promise<CatalogModel[]> {
  const search = new URLSearchParams();
  if (params?.mode) search.set('mode', params.mode);
  if (params?.nodeType) search.set('nodeType', params.nodeType);
  const response = await fetch(`/api/models/catalog${search.size ? `?${search.toString()}` : ''}`, {
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`获取模型目录失败：HTTP ${response.status}`);
  const data = await response.json() as { success: boolean; models: CatalogModel[] };
  return data.models || [];
}
