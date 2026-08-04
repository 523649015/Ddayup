import type { ModelCapabilityMatrix } from '@/types';

export interface CatalogProviderMeta {
  id: string;
  name: string;
  domestic: boolean;
  modes: string[];
}

/** 音频模型的可用音色（AudioNode 用于音色预设匹配） */
export interface AudioVoice {
  value: string;
  label: string;
  gender?: 'male' | 'female' | string;
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
  /** 火山方舟等平台要求先创建推理接入点（ep-xxxx）后才能调用 */
  requiresEndpoint?: boolean;
  endpointHint?: string | null;
  /** 火山方舟已自动创建的推理接入点 ID（ep-xxxx），存在即表示可直接调用 */
  endpointId?: string | null;
  endpointStatus?: string | null;
  providerMeta?: CatalogProviderMeta | null;
  capabilities?: ModelCapabilityMatrix | null;
  /** 音频模型的可用音色列表（运行时由音频类模型 catalog 注入） */
  audioVoices?: AudioVoice[];
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
