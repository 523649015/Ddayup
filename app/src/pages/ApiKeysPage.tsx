import { type ReactNode, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  KeyRound,
  Link2,
  Loader2,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { SourceBadge, relaySourceLabel } from '@/components/SourceBadge';
import { RecommendationCardsPanel } from '@/components/RecommendationCardsPanel';
import {
  activateRelayModels,
  deactivateByokKey,
  discoverRelayModels,
  getByokProviders,
  validateByokKey,
  type ByokProvider,
  type ByokRuntimeRecommendationSummary,
  type ByokRuntimeResult,
  type RelayDiscoveredModel,
  type RelayDiscoveryResult,
} from '@/api/byok';
import type { CatalogModel } from '@/api/models';
import {
  getProviderGuide,
  getRecommendedDirectModels,
  RELAY_PRESETS,
  type RelayPreset,
} from '@/config/providerGuides';
import { useUILanguage } from '@/i18n/ui';
import { useApiKeyStore, resolveProviderKeyStatus } from '@/store/useApiKeyStore';
import { setVisionActivationFlag } from '@/services/visionActivation';
import { useBackendHealthStore } from '@/store/useBackendHealthStore';
import { useByokRuntimeStore } from '@/store/useByokRuntimeStore';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import { getDirectRecommendationCards } from '@/utils/directProviderRecommendationCards';
import { findRecommendationTask, summaryToRecommendationCard, taskToRecommendationCard } from '@/utils/runtimeRecommendationCards';

type Mode = 'llm' | 'image' | 'video' | 'audio';
type DiscoveryModeFilter = 'all' | Mode;
const CUSTOM_RELAY_PRESETS_STORAGE_KEY = 'hmdao-custom-relay-presets-v1';

function sanitizeRelayPresetId(value: string) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || `relay-${Date.now()}`;
}

function canonicalizeRelayBaseUrl(baseUrl: string) {
  const raw = String(baseUrl || '').trim();
  if (!raw) return '';
  const normalizedInput = raw.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(normalizedInput)) return normalizedInput;
  try {
    const parsed = new URL(normalizedInput);
    const hostname = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    if (hostname === 'apimart.ai' || hostname === 'api.apimart.ai') {
      return 'https://api.apimart.ai/v1';
    }
    const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
    return `${parsed.protocol}//${parsed.host}${pathname}`;
  } catch {
    return normalizedInput;
  }
}

function buildCustomRelayPreset(baseUrl: string): RelayPreset {
  const normalizedBaseUrl = canonicalizeRelayBaseUrl(baseUrl);
  let hostLabel = normalizedBaseUrl;
  try {
    hostLabel = new URL(normalizedBaseUrl).hostname.replace(/^www\./i, '') || normalizedBaseUrl;
  } catch {
    hostLabel = normalizedBaseUrl.replace(/^https?:\/\//i, '');
  }
  const safeId = sanitizeRelayPresetId(hostLabel);
  return {
    id: `custom-${safeId}`,
    nameZh: `${hostLabel} 自定义中转`,
    nameEn: `${hostLabel} Custom Relay`,
    docsUrl: normalizedBaseUrl,
    consoleUrl: normalizedBaseUrl,
    baseUrlExample: normalizedBaseUrl,
    descriptionZh: '本地保存的自定义中转平台，便于下次继续使用，无需重复输入 Base URL。',
    descriptionEn: 'A locally saved custom relay so you can reuse the Base URL without entering it again.',
    endpointHintZh: '填写该平台控制台给出的 OpenAI 兼容 Base URL，通常以 /v1 结尾。',
    endpointHintEn: 'Use the OpenAI-compatible Base URL shown in the platform console, usually ending with /v1.',
    recommendedProviders: [],
    recommendedModels: {},
  };
}

function readCustomRelayPresets(): RelayPreset[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(CUSTOM_RELAY_PRESETS_STORAGE_KEY);
    const parsed = JSON.parse(String(raw || '[]'));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item === 'object' && String(item.baseUrlExample || '').trim())
      .map((item) => buildCustomRelayPreset(canonicalizeRelayBaseUrl(String(item.baseUrlExample || '').trim())));
  } catch {
    return [];
  }
}

function writeCustomRelayPresets(presets: RelayPreset[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CUSTOM_RELAY_PRESETS_STORAGE_KEY, JSON.stringify(
      presets.map((item) => ({ id: item.id, baseUrlExample: item.baseUrlExample })),
    ));
  } catch {
    // Ignore localStorage write failures and continue with runtime state.
  }
}

interface SpotlightModel {
  key: string;
  label: string;
  mode: Mode;
  providerHint: string;
  descriptionZh: string;
  descriptionEn: string;
  noteZh?: string;
  noteEn?: string;
}

const SPOTLIGHT_MODELS: SpotlightModel[] = [
  {
    key: 'kling-video',
    label: 'kling-video',
    mode: 'video',
    providerHint: 'Kling',
    descriptionZh: '优先用于强主体一致性、强参考视频和全能参考视频生成。',
    descriptionEn: 'Best for strong subject consistency, reference-heavy video generation, and omni-reference workflows.',
  },
  {
    key: 'image2',
    label: 'image2',
    mode: 'image',
    providerHint: 'Google',
    descriptionZh: '高质量图片生成候选，适合商品图、品牌图和海报图。',
    descriptionEn: 'Strong candidate for high-quality image generation, especially product shots, brand images, and posters.',
  },
  {
    key: 'doubao-seedance-2-0',
    label: 'doubao-seedance-2-0',
    mode: 'video',
    providerHint: '豆包 / Seedance',
    descriptionZh: '视频多模态候选，适合主素材加参考素材的组合工作流。',
    descriptionEn: 'A multimodal video candidate suitable for primary-asset plus reference workflows.',
    noteZh: '只有稳定映射到 seedance-v2 这类明确声明参考角色和主体控制能力的目录模型时，才建议开放更细的参考控制。',
    noteEn: 'Fine-grained reference controls should only unlock once this is mapped to a stable catalog model such as seedance-v2.',
  },
  {
    key: 'doubao-seedream5-0',
    label: 'doubao-seedream5-0',
    mode: 'image',
    providerHint: '豆包 / Seedream',
    descriptionZh: '高质感商品图与广告图候选。',
    descriptionEn: 'A premium candidate for product and advertising visuals.',
  },
  {
    key: 'veo3.1',
    label: 'veo3.1',
    mode: 'video',
    providerHint: 'Google',
    descriptionZh: '高质量视频生成候选，适合高端成片路线。',
    descriptionEn: 'A premium candidate for polished, high-end video output.',
  },
  {
    key: 'omni',
    label: 'omni',
    mode: 'llm',
    providerHint: 'Multimodal',
    descriptionZh: '适合全能参考、多模态理解和路由决策。',
    descriptionEn: 'Suitable for omni-reference flows, multimodal understanding, and routing decisions.',
  },
  {
    key: 'gemini-3.1',
    label: 'gemini-3.1',
    mode: 'llm',
    providerHint: 'Google',
    descriptionZh: '适合多模态理解、解析和 Agent 调度。',
    descriptionEn: 'Strong for multimodal analysis, parsing, and agent orchestration.',
  },
  {
    key: 'runway',
    label: 'runway',
    mode: 'video',
    providerHint: 'Runway',
    descriptionZh: '视频生成与编辑候选。',
    descriptionEn: 'A candidate for both video generation and editing workflows.',
  },
  {
    key: 'suno_music',
    label: 'suno_music',
    mode: 'audio',
    providerHint: 'Suno',
    descriptionZh: '适合作为 BGM 与音乐候选，方便同步给音频节点。',
    descriptionEn: 'Useful as a BGM and music candidate that can later sync into audio-node workflows.',
  },
];

function formatModeLabel(mode: Mode, label: (zh: string, en: string) => string) {
  if (mode === 'image') return label('图片', 'Image');
  if (mode === 'video') return label('视频', 'Video');
  if (mode === 'audio') return label('音频', 'Audio');
  return label('文本', 'Text');
}

function normalizeIdentifier(value: string | null | undefined) {
  return String(value || '').trim().toLowerCase();
}

function formatCurrency(price: number | null | undefined, currency: string | null | undefined) {
  if (!Number.isFinite(Number(price))) return 'Budget pending sync';
  const normalizedCurrency = String(currency || 'CNY').toUpperCase();
  return `${normalizedCurrency} ${Number(price).toFixed(Number(price) >= 1 ? 2 : 3)}`;
}

function formatPricingDetail(model: Pick<RelayDiscoveredModel, 'price' | 'currency' | 'priceUnit' | 'pricingSummary'>) {
  const base = formatCurrency(model.price, model.currency);
  if (model.priceUnit) return `${base} / ${model.priceUnit}`;
  if (model.pricingSummary) return `${base} 路 ${model.pricingSummary}`;
  return base;
}

function relayDiscoveryFamilyKey(model: Pick<RelayDiscoveredModel, 'mode' | 'provider' | 'catalogModelId' | 'upstreamModel' | 'id' | 'name'>) {
  const raw = String(model.catalogModelId || model.upstreamModel || model.id || model.name || '').trim().toLowerCase();
  const normalized = raw
    .replace(/^.+\//, '')
    .replace(/[:_]/g, '-')
    .replace(/(?:-|\s)+(preview|latest|stable|fast|flash|turbo|pro|max|plus|ultra|image|video|audio|music|omni|relax|mirror|proxy|relay)$/g, '')
    .replace(/(?:-|\s)+v?\d+(?:\.\d+)*$/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `${model.mode}:${normalized || normalizeIdentifier(model.id)}`;
}

function sortRelayDiscoveryModels(models: RelayDiscoveredModel[], recommendedIds: Set<string>) {
  return [...models].sort((a, b) => {
    const aRecommended = Number(Boolean(a.recommended || recommendedIds.has(normalizeIdentifier(a.id)) || recommendedIds.has(normalizeIdentifier(a.catalogModelId))));
    const bRecommended = Number(Boolean(b.recommended || recommendedIds.has(normalizeIdentifier(b.id)) || recommendedIds.has(normalizeIdentifier(b.catalogModelId))));
    if (aRecommended !== bRecommended) return bRecommended - aRecommended;
    const aCanvas = Number(Boolean(a.supportedOnCanvas));
    const bCanvas = Number(Boolean(b.supportedOnCanvas));
    if (aCanvas !== bCanvas) return bCanvas - aCanvas;
    const scoreDiff = Number(b.recommendationScore || 0) - Number(a.recommendationScore || 0);
    if (scoreDiff !== 0) return scoreDiff;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
}

function dedupeRelayDiscoveryModels(models: RelayDiscoveredModel[]) {
  const seen = new Set<string>();
  return models.filter((item) => {
    const key = relayDiscoveryFamilyKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function summarizeRelayDiscovery(result: RelayDiscoveryResult | null) {
  const models = result?.models || [];
  return {
    total: models.length,
    recommended: models.filter((item) => item.recommended).length,
    canvasReady: models.filter((item) => item.supportedOnCanvas).length,
    image: models.filter((item) => item.mode === 'image').length,
    video: models.filter((item) => item.mode === 'video').length,
    audio: models.filter((item) => item.mode === 'audio').length,
    llm: models.filter((item) => item.mode === 'llm').length,
    dedupedFamilies: dedupeRelayDiscoveryModels(sortRelayDiscoveryModels(models, new Set())).length,
  };
}

function buildRuntimeRelayIndex(records: Array<{
  model?: string | null;
  catalogModelIds?: string[];
  availableModels?: Array<{
    id?: string | null;
    name?: string | null;
    upstreamModel?: string | null;
    catalogModelId?: string | null;
  }>;
}>) {
  const ids = new Set<string>();
  const canvasReady = new Set<string>();

  for (const record of records) {
    if (record.model) ids.add(normalizeIdentifier(record.model));
    for (const catalogId of record.catalogModelIds || []) {
      const normalized = normalizeIdentifier(catalogId);
      if (!normalized) continue;
      ids.add(normalized);
      canvasReady.add(normalized);
    }
    for (const model of record.availableModels || []) {
      for (const identifier of [model.id, model.name, model.upstreamModel, model.catalogModelId]) {
        const normalized = normalizeIdentifier(identifier);
        if (!normalized) continue;
        ids.add(normalized);
        if (model.catalogModelId) canvasReady.add(normalized);
      }
    }
  }

  return { ids, canvasReady };
}

function recommendationSummary(
  runtime: ByokRuntimeResult | null,
  key: 'imageGeneration' | 'imageAnalysis' | 'videoGeneration' | 'videoAnalysis' | 'audioGeneration',
) {
  return runtime?.recommendations?.[key] as ByokRuntimeRecommendationSummary | null | undefined;
}

function relayPresetDisplayName(
  preset: RelayPreset | null | undefined,
  label: (zh: string, en: string) => string,
) {
  if (!preset) return label('自定义中转', 'Custom relay');
  if (preset.id === 'apimart') return label('APIMart 聚合平台', 'APIMart Aggregator');
  if (preset.id === 'comfly') return label('Comfly 聚合平台', 'Comfly Aggregator');
  if (preset.id === 'suanliai') return label('算力聚合平台', 'Suanliai Aggregator');
  if (preset.id === 'generic-openai-relay') return label('自定义 OpenAI 兼容中转', 'Generic OpenAI-Compatible Relay');
  return label(preset.nameZh, preset.nameEn);
}

function relayPresetDescription(
  preset: RelayPreset | null | undefined,
  label: (zh: string, en: string) => string,
) {
  if (!preset) return '';
  if (preset.id === 'apimart') {
    return label(
      '适合 APIMart 这类 OpenAI 兼容聚合平台，自动读取 /models，并同步画布可用的主流多模态模型。',
      'Best for APIMart-style OpenAI-compatible aggregators. It reads /models and syncs mainstream multimodal models that are usable on the canvas.',
    );
  }
  if (preset.id === 'comfly') {
    return label(
      '适合用一个 Key 统一接入多家上游模型，自动发现并同步画布可用的主流多模态模型。',
      'Use one key to access multiple upstream model families and sync mainstream multimodal models into the canvas.',
    );
  }
  if (preset.id === 'suanliai') {
    return label(
      '适合接入 OpenAI 兼容聚合平台，系统会优先读取 /models 再同步到画布。',
      'Great for OpenAI-compatible aggregators. The system reads /models first and then syncs supported models into the canvas.',
    );
  }
  if (preset.id === 'generic-openai-relay') {
    return label(
      '用于任意 OpenAI 兼容中转站，适合自定义 Base URL 和自定义模型目录。',
      'Works with any OpenAI-compatible relay and is best when you need a custom Base URL and model catalog.',
    );
  }
  return label(preset.descriptionZh, preset.descriptionEn);
}

function relayPresetEndpointHint(
  preset: RelayPreset | null | undefined,
  label: (zh: string, en: string) => string,
) {
  if (!preset) return '';
  if (preset.id === 'apimart') {
    return label(
      '统一填写 https://api.apimart.ai/v1。即使输入 apimart.ai、www.apimart.ai 或带 /zh 的页面地址，系统也会自动改写成这个地址。',
      'Use https://api.apimart.ai/v1. If you enter apimart.ai, www.apimart.ai, or a /zh page URL, the app rewrites it to this canonical endpoint.',
    );
  }
  if (preset.id === 'comfly') {
    return label(
      '优先填写控制台给出的 OpenAI 兼容 Base URL；若没有单独展示，可先尝试 https://ai.comfly.org/v1。',
      'Prefer the OpenAI-compatible Base URL shown in your console. If none is listed, start with https://ai.comfly.org/v1.',
    );
  }
  if (preset.id === 'suanliai') {
    return label(
      '优先填写平台控制台给出的 Base URL；若未单独展示，可先尝试 https://www.suanliai.top/v1。',
      'Prefer the exact Base URL shown in the platform console. If none is shown, start with https://www.suanliai.top/v1.',
    );
  }
  if (preset.id === 'generic-openai-relay') {
    return label(
      '填写中转文档提供的完整 Base URL，通常以 /v1 结尾。',
      'Paste the full Base URL from your relay docs, usually ending with /v1.',
    );
  }
  return label(preset.endpointHintZh, preset.endpointHintEn);
}

function statusChip(active: boolean) {
  return active
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
    : 'border-[#30363d] bg-[#11161d] text-[#9fb0c3]';
}

function modelBadgeTone(model: RelayDiscoveredModel | null | undefined) {
  if (model?.recommended) return 'recommended';
  if (model?.supportedOnCanvas) return 'relay';
  return 'neutral';
}

function catalogSourceBadge(model: CatalogModel) {
  const label = relaySourceLabel(model.activationRelaySource);
  if (!label) return null;
  return <SourceBadge label={label} tone="relay" />;
}

function looksBrokenText(value: string | null | undefined) {
  const text = String(value || '').trim();
  if (!text) return false;
  return /[閿熶粙宕ｉ柟铏规喆婵☆偆鐥梺顐ょ磼閻犲洭鎮界€殿噣鏌婃径濠冨€ゆ鐐插暱瑜扮⒎]/.test(text);
}

function pickLocaleText(isZh: boolean, zh: string | null | undefined, en: string | null | undefined) {
  const zhText = String(zh || '').trim();
  const enText = String(en || '').trim();
  if (isZh && zhText && !looksBrokenText(zhText)) return zhText;
  return enText || zhText || '';
}

function firstCleanText(...values: Array<string | null | undefined>) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text && !looksBrokenText(text)) return text;
  }
  return '';
}

function CollapseToggle({
  expanded,
  title,
  subtitle,
  onClick,
  badge,
  testId,
}: {
  expanded: boolean;
  title: string;
  subtitle: string;
  onClick: () => void;
  badge?: ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="flex w-full items-center justify-between gap-3 rounded-2xl border border-[#25303b] bg-[#101720] px-4 py-3 text-left transition hover:border-[#425468]"
    >
      <div className="min-w-0">
        <div className="text-sm font-semibold text-white">{title}</div>
        <div className="mt-1 text-xs leading-6 text-[#8ea0b2]">{subtitle}</div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {badge}
        <ChevronDown className={`h-4 w-4 text-[#8ea0b2] transition ${expanded ? 'rotate-180' : ''}`} />
      </div>
    </button>
  );
}

export default function ApiKeysPage() {
  const navigate = useNavigate();
  const { isZh } = useUILanguage();
  const ui = (zh: string, en: string) => pickLocaleText(isZh, zh, en);

  const [providers, setProviders] = useState<ByokProvider[]>([]);
  const [selectedProvider, setSelectedProvider] = useState('siliconflow');
  const [mode, setMode] = useState<Mode>('image');
  const [officialModel, setOfficialModel] = useState('');
  const [officialApiKey, setOfficialApiKey] = useState('');
  const [officialCustomModelEnabled, setOfficialCustomModelEnabled] = useState(false);
  const [officialCustomEndpointEnabled, setOfficialCustomEndpointEnabled] = useState(false);
  const [officialEndpoint, setOfficialEndpoint] = useState('');
  const [relayPresetId, setRelayPresetId] = useState(RELAY_PRESETS[0]?.id || 'apimart');
  const [relayBaseUrl, setRelayBaseUrl] = useState(RELAY_PRESETS[0]?.baseUrlExample || '');
  const [relayApiKey, setRelayApiKey] = useState('');
  const [customRelayPresets, setCustomRelayPresets] = useState<RelayPreset[]>([]);
  const [relayDiscovery, setRelayDiscovery] = useState<RelayDiscoveryResult | null>(null);
  const [relaySpotlightMode, setRelaySpotlightMode] = useState<Mode>('video');
  const [activeConfigSection, setActiveConfigSection] = useState<'relay' | 'official'>('relay');
  const [relayExpanded, setRelayExpanded] = useState(true);
  const [officialExpanded, setOfficialExpanded] = useState(true);
  const [showActivatedPlatforms, setShowActivatedPlatforms] = useState(false);
  const [showActivatedCanvasModels, setShowActivatedCanvasModels] = useState(true);
  const [showRelayInsights, setShowRelayInsights] = useState(false);
  const [showRelayDiscovery, setShowRelayDiscovery] = useState(false);
  const [showActiveKeys, setShowActiveKeys] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [showRecommendations, setShowRecommendations] = useState(false);
  const [relayDiscoveryFilterMode, setRelayDiscoveryFilterMode] = useState<DiscoveryModeFilter>('all');
  const [relayDiscoveryOnlyRecommended, setRelayDiscoveryOnlyRecommended] = useState(false);
  const [relayDiscoveryOnlyCanvasReady, setRelayDiscoveryOnlyCanvasReady] = useState(false);
  const [relayDiscoveryDeduped, setRelayDiscoveryDeduped] = useState(true);
  const [inventoryExpandedModes, setInventoryExpandedModes] = useState<Record<Mode, boolean>>({
    image: true,
    video: true,
    audio: true,
    llm: false,
  });
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingAction, setLoadingAction] = useState<'relay-discover' | 'relay-activate' | 'official-activate' | null>(null);

  const keys = useApiKeyStore((state) => state.keys);
  const setKey = useApiKeyStore((state) => state.setKey);
  const removeKey = useApiKeyStore((state) => state.removeKey);
  const secureReady = useApiKeyStore((state) => state.secureReady);
  const secureLoading = useApiKeyStore((state) => state.secureLoading);
  const secureError = useApiKeyStore((state) => state.secureError);

  const fetchCatalog = useModelCatalogStore((state) => state.fetchCatalog);
  const catalogModels = useModelCatalogStore((state) => state.models);

  const backendRealApiEnabled = useBackendHealthStore((state) => state.realApiEnabled);
  const backendDiagnostics = useBackendHealthStore((state) => state.diagnostics);
  const backendHealthLoading = useBackendHealthStore((state) => state.loading);
  const backendHealthError = useBackendHealthStore((state) => state.error);
  const fetchBackendHealth = useBackendHealthStore((state) => state.fetchHealth);

  const runtime = useByokRuntimeStore((state) => state.runtime);
  const runtimeLoading = useByokRuntimeStore((state) => state.loading);
  const runtimeError = useByokRuntimeStore((state) => state.error);
  const fetchRuntime = useByokRuntimeStore((state) => state.fetchRuntime);

  useEffect(() => {
    setCustomRelayPresets(readCustomRelayPresets());
  }, []);

  const relayPresetOptions = useMemo(() => {
    const merged = new Map<string, RelayPreset>();
    for (const item of RELAY_PRESETS) merged.set(item.id, item);
    for (const item of customRelayPresets) merged.set(item.id, item);
    return Array.from(merged.values());
  }, [customRelayPresets]);

  useEffect(() => {
    void getByokProviders()
      .then((items) => setProviders(items))
      .catch(() => setProviders([]));
    void fetchCatalog({ force: true });
    void fetchRuntime({ force: true });
    void fetchBackendHealth({ force: true });
  }, [fetchBackendHealth, fetchCatalog, fetchRuntime]);

  const providerOptions = useMemo(
    () => providers.map((item) => ({
      id: item.id,
      name: item.name,
      domestic: item.domestic,
      modes: item.modes,
    })),
    [providers],
  );

  useEffect(() => {
    if (!providerOptions.length) return;
    if (!providerOptions.some((item) => item.id === selectedProvider)) {
      setSelectedProvider(providerOptions[0].id);
    }
  }, [providerOptions, selectedProvider]);

  // 从 AI 深度分析面板跳转激活视觉模型时，预选对应平台并给出提示
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('vision') !== '1') return;
      const provider = params.get('provider');
      if (!provider) return;
      setSelectedProvider(provider);
      if (params.get('from') === 'deep-analysis') {
        const flag = providerOptions.some((item) => item.id === provider)
          ? ui('已为你定位到该视觉模型平台，激活后将自动回填分析面板。', 'Located the vision platform; activation will auto-fill the analysis panel.')
          : ui('未找到该平台，已为你停留在当前选择，可手动切换到视觉模型平台激活。', 'Platform not found; switch to a vision platform manually to activate.');
        setMessage(flag);
      }
    } catch {
      // 解析失败忽略
    }
    // 仅在挂载时读取一次跳转参数
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const provider = providers.find((item) => item.id === selectedProvider);
  const providerGuide = useMemo(() => getProviderGuide(selectedProvider), [selectedProvider]);

  useEffect(() => {
    if (provider?.modes?.length && !provider.modes.includes(mode)) {
      setMode(provider.modes[0] as Mode);
    }
  }, [mode, provider]);

  const keyList = useMemo(
    () => Object.values(keys).sort((a, b) => b.activatedAt - a.activatedAt),
    [keys],
  );
  const runtimeActivatedProviderCount = runtime?.activatedProviders?.length || 0;

  const activatedCanvasModels = useMemo(
    () => catalogModels.filter((item) => item.activated && item.activationModelMatched !== false),
    [catalogModels],
  );

  const activatedSummary = useMemo(
    () => ({
      image: activatedCanvasModels.filter((item) => item.mode === 'image').length,
      video: activatedCanvasModels.filter((item) => item.mode === 'video').length,
      llm: activatedCanvasModels.filter((item) => item.mode === 'llm').length,
      audio: activatedCanvasModels.filter((item) => item.mode === 'audio').length,
    }),
    [activatedCanvasModels],
  );

  const activatedCanvasModelsByMode = useMemo(
    () => ({
      image: activatedCanvasModels.filter((item) => item.mode === 'image'),
      video: activatedCanvasModels.filter((item) => item.mode === 'video'),
      audio: activatedCanvasModels.filter((item) => item.mode === 'audio'),
      llm: activatedCanvasModels.filter((item) => item.mode === 'llm'),
    }),
    [activatedCanvasModels],
  );

  const activatedPlatformCards = useMemo(() => {
    const platformMap = new Map<string, {
      providerId: string;
      providerLabel: string;
      sourceLabel: string;
      sourceTone: 'relay' | 'api';
      modes: Set<Mode>;
      modelCount: number;
      endpoint?: string;
    }>();

    const ensureEntry = (
      providerId: string,
      providerLabel: string,
      sourceLabel: string,
      sourceTone: 'relay' | 'api',
      endpoint?: string,
    ) => {
      const key = `${providerId}::${sourceLabel}`;
      if (!platformMap.has(key)) {
        platformMap.set(key, {
          providerId,
          providerLabel,
          sourceLabel,
          sourceTone,
          modes: new Set<Mode>(),
          modelCount: 0,
          endpoint,
        });
      }
      const entry = platformMap.get(key)!;
      if (!entry.endpoint && endpoint) entry.endpoint = endpoint;
      return entry;
    };

    for (const record of runtime?.activatedProviders || []) {
      const providerId = String(record.provider || '').trim();
      if (!providerId) continue;
      const guide = getProviderGuide(providerId);
      const providerLabel = guide?.officialName || providerOptions.find((item) => item.id === providerId)?.name || providerId;
      const sourceLabel = relaySourceLabel(record.relaySource) || ui('官方直连', 'Official direct');
      const sourceTone = record.relaySource ? 'relay' as const : 'api' as const;
      const entry = ensureEntry(providerId, providerLabel, sourceLabel, sourceTone, record.endpoint || undefined);
      entry.modes.add(record.mode as Mode);
      entry.modelCount += Math.max(1, record.catalogModelIds?.length || 0);
    }

    for (const key of keyList) {
      const providerId = String(key.provider || '').trim();
      if (!providerId) continue;
      const guide = getProviderGuide(providerId);
      const providerLabel = guide?.officialName || providerOptions.find((item) => item.id === providerId)?.name || providerId;
      const entry = ensureEntry(providerId, providerLabel, ui('官方直连', 'Official direct'), 'api', key.endpoint || undefined);
      entry.modes.add(key.mode as Mode);
    }

    return Array.from(platformMap.values())
      .map((entry) => ({
        ...entry,
        modes: Array.from(entry.modes),
      }))
      .sort((a, b) => b.modes.length - a.modes.length || b.modelCount - a.modelCount || a.providerLabel.localeCompare(b.providerLabel));
  }, [keyList, providerOptions, runtime?.activatedProviders, ui]);

  // 哪些 provider 有激活 key（官方直连）和哪些聚合平台有激活记录
  const activatedProviderIds = useMemo(() => {
    const ids = new Set<string>();
    for (const key of keyList) { if (resolveProviderKeyStatus(key.expiresAt) === 'active') ids.add(key.provider); }
    for (const record of (runtime?.activatedProviders || [])) { ids.add(String(record.provider || '').trim()); }
    return ids;
  }, [keyList, runtime?.activatedProviders]);
  // 哪些聚合中转 preset 真正激活过（只显示验证通过的，未激活的不显示"已激活"）
  const activatedRelayPresetIds = useMemo(() => {
    const ids = new Set<string>();
    for (const record of (runtime?.activatedProviders || [])) {
      const presetId = String(record.relayPresetId || '').trim();
      if (presetId) ids.add(presetId);
    }
    return ids;
  }, [runtime?.activatedProviders]);

  const currentPreset = useMemo(
    () => relayPresetOptions.find((item) => item.id === relayPresetId) || RELAY_PRESETS[0],
    [relayPresetId, relayPresetOptions],
  );
  const currentRelayPresetIsCustom = Boolean(currentPreset && !RELAY_PRESETS.some((item) => item.id === currentPreset.id));

  const officialRecommendedModels = useMemo(
    () => getRecommendedDirectModels(selectedProvider, mode, 'api-page'),
    [mode, selectedProvider],
  );

  const officialRecommendationCards = useMemo(
    () => getDirectRecommendationCards(selectedProvider, mode, isZh, 'api-page'),
    [isZh, mode, selectedProvider],
  );

  const selectedOfficialPreset = useMemo(
    () => officialRecommendedModels.find((item) => item.model === officialModel) || officialRecommendedModels[0] || null,
    [officialModel, officialRecommendedModels],
  );

  useEffect(() => {
    if (officialCustomModelEnabled) return;
    const recommended = officialRecommendedModels[0]?.model || '';
    setOfficialModel(recommended);
  }, [officialCustomModelEnabled, officialRecommendedModels]);

  const normalizedRelayBaseUrl = canonicalizeRelayBaseUrl(relayBaseUrl);
  const normalizedOfficialEndpoint = officialEndpoint.trim().replace(/\/$/, '');
  const resolvedOfficialModel = officialCustomModelEnabled
    ? officialModel.trim()
    : (selectedOfficialPreset?.model || officialModel.trim());

  const relayActionsDisabled = !secureReady || secureLoading || relayApiKey.trim().length < 8 || !/^https?:\/\/.+/i.test(normalizedRelayBaseUrl);
  const officialActionsDisabled = !secureReady
    || secureLoading
    || officialApiKey.trim().length < 8
    || (officialCustomEndpointEnabled && normalizedOfficialEndpoint.length > 0 && !/^https?:\/\/.+/i.test(normalizedOfficialEndpoint));

  const runtimeRelayRecords = useMemo(
    () => (runtime?.activatedProviders || []).filter((item) => item?.relaySource),
    [runtime],
  );

  const runtimeRelayIndex = useMemo(
    () => buildRuntimeRelayIndex(runtimeRelayRecords),
    [runtimeRelayRecords],
  );

  const discoveryModelIndex = useMemo(() => {
    const map = new Map<string, RelayDiscoveredModel>();
    for (const item of relayDiscovery?.models || []) {
      for (const identifier of [item.id, item.name, item.upstreamModel, item.catalogModelId]) {
        const normalized = normalizeIdentifier(identifier);
        if (normalized && !map.has(normalized)) {
          map.set(normalized, item);
        }
      }
    }
    return map;
  }, [relayDiscovery]);

  const relayRecommendedModelIds = useMemo(() => {
    const ids = new Set<string>();
    for (const models of Object.values(relayDiscovery?.recommended || {})) {
      for (const item of models || []) {
        for (const identifier of [item.id, item.catalogModelId, item.upstreamModel, item.name]) {
          const normalized = normalizeIdentifier(identifier);
          if (normalized) ids.add(normalized);
        }
      }
    }
    return ids;
  }, [relayDiscovery]);

  const relayDiscoverySummary = useMemo(
    () => summarizeRelayDiscovery(relayDiscovery),
    [relayDiscovery],
  );

  const relayDiscoveryRecommendedCards = useMemo(
    () => (['image', 'video', 'audio', 'llm'] as Mode[])
      .map((entryMode) => {
        const top = relayDiscovery?.recommended?.[entryMode]?.[0];
        if (!top) return null;
        return { mode: entryMode, item: top };
      })
      .filter(Boolean) as Array<{ mode: Mode; item: RelayDiscoveredModel }>,
    [relayDiscovery],
  );

  const relayDiscoveryVisibleModels = useMemo(() => {
    const base = sortRelayDiscoveryModels(relayDiscovery?.models || [], relayRecommendedModelIds);
    const filtered = base.filter((item) => {
      if (relayDiscoveryFilterMode !== 'all' && item.mode !== relayDiscoveryFilterMode) return false;
      const isRecommended = item.recommended
        || relayRecommendedModelIds.has(normalizeIdentifier(item.id))
        || relayRecommendedModelIds.has(normalizeIdentifier(item.catalogModelId))
        || relayRecommendedModelIds.has(normalizeIdentifier(item.upstreamModel));
      if (relayDiscoveryOnlyRecommended && !isRecommended) return false;
      if (relayDiscoveryOnlyCanvasReady && !item.supportedOnCanvas) return false;
      return true;
    });
    return relayDiscoveryDeduped ? dedupeRelayDiscoveryModels(filtered) : filtered;
  }, [
    relayDiscovery,
    relayDiscoveryDeduped,
    relayDiscoveryFilterMode,
    relayDiscoveryOnlyCanvasReady,
    relayDiscoveryOnlyRecommended,
    relayRecommendedModelIds,
  ]);

  const relayDiscoveryHiddenCount = Math.max(0, (relayDiscovery?.models?.length || 0) - relayDiscoveryVisibleModels.length);

  const spotlightByMode = useMemo(
    () => ({
      image: SPOTLIGHT_MODELS.filter((item) => item.mode === 'image'),
      video: SPOTLIGHT_MODELS.filter((item) => item.mode === 'video'),
      audio: SPOTLIGHT_MODELS.filter((item) => item.mode === 'audio'),
      llm: SPOTLIGHT_MODELS.filter((item) => item.mode === 'llm'),
    }),
    [],
  );

  const activeSpotlightItems = spotlightByMode[relaySpotlightMode];

  const spotlightRows = useMemo(() => activeSpotlightItems.map((item) => {
    const discovered = discoveryModelIndex.get(normalizeIdentifier(item.key));
    const normalizedKey = normalizeIdentifier(item.key);
    const activeInRelay = runtimeRelayIndex.ids.has(normalizedKey)
      || runtimeRelayIndex.ids.has(normalizeIdentifier(discovered?.id))
      || runtimeRelayIndex.ids.has(normalizeIdentifier(discovered?.catalogModelId))
      || runtimeRelayIndex.ids.has(normalizeIdentifier(discovered?.upstreamModel));
    const canvasReady = runtimeRelayIndex.canvasReady.has(normalizedKey)
      || runtimeRelayIndex.canvasReady.has(normalizeIdentifier(discovered?.catalogModelId));
    return {
      ...item,
      discovered: discovered || null,
      activeInRelay,
      canvasReady,
    };
  }), [activeSpotlightItems, discoveryModelIndex, runtimeRelayIndex]);

  const relayRecommendationCards = useMemo(() => {
    const imageGeneration = recommendationSummary(runtime, 'imageGeneration');
    const imageAnalysis = recommendationSummary(runtime, 'imageAnalysis');
    const videoGeneration = recommendationSummary(runtime, 'videoGeneration');
    const videoAnalysis = recommendationSummary(runtime, 'videoAnalysis');
    const audioGeneration = recommendationSummary(runtime, 'audioGeneration');

    if (relaySpotlightMode === 'image') {
      return [
        taskToRecommendationCard(findRecommendationTask(imageGeneration, 'subjectReplaceKeepComposition'), {
          purposeLabel: ui('图片生成', 'Image generation'),
          purposeTone: 'recommended',
        }) || summaryToRecommendationCard(imageGeneration, {
          purposeLabel: ui('图片生成', 'Image generation'),
          purposeTone: 'recommended',
        }),
        taskToRecommendationCard(findRecommendationTask(imageGeneration, 'omniReference'), {
          purposeLabel: ui('全能参考', 'Omni reference'),
          purposeTone: 'api',
        }),
        taskToRecommendationCard(findRecommendationTask(imageAnalysis, 'promptInterrogation'), {
          purposeLabel: ui('提示词反推', 'Prompt interrogation'),
          purposeTone: 'api',
        }) || summaryToRecommendationCard(imageAnalysis, {
          purposeLabel: ui('解析 / 反推', 'Analysis / prompting'),
          purposeTone: 'api',
        }),
        taskToRecommendationCard(findRecommendationTask(imageAnalysis, 'subjectLightingComposition'), {
          purposeLabel: ui('构图理解', 'Composition understanding'),
          purposeTone: 'relay',
        }),
      ];
    }

    if (relaySpotlightMode === 'video') {
      return [
        taskToRecommendationCard(findRecommendationTask(videoGeneration, 'subjectReplaceKeepMotion'), {
          purposeLabel: ui('保运镜换主体', 'Keep motion, swap subject'),
          purposeTone: 'recommended',
        }) || summaryToRecommendationCard(videoGeneration, {
          purposeLabel: ui('视频生成', 'Video generation'),
          purposeTone: 'recommended',
        }),
        taskToRecommendationCard(findRecommendationTask(videoGeneration, 'omniReferenceKeepMotion'), {
          purposeLabel: ui('主体 + 全能参考', 'Subject + omni reference'),
          purposeTone: 'api',
        }),
        taskToRecommendationCard(findRecommendationTask(videoAnalysis, 'semanticParse'), {
          purposeLabel: ui('语义解析', 'Semantic analysis'),
          purposeTone: 'api',
        }) || summaryToRecommendationCard(videoAnalysis, {
          purposeLabel: ui('视频解析', 'Video analysis'),
          purposeTone: 'api',
        }),
        taskToRecommendationCard(findRecommendationTask(videoAnalysis, 'shotBreakdown'), {
          purposeLabel: ui('分镜 / 运镜', 'Shot breakdown'),
          purposeTone: 'relay',
        }),
      ];
    }

    if (relaySpotlightMode === 'audio') {
      return [
        taskToRecommendationCard(findRecommendationTask(audioGeneration, 'bgm'), {
          purposeLabel: 'BGM',
          purposeTone: 'recommended',
        }) || summaryToRecommendationCard(audioGeneration, {
          purposeLabel: ui('音频生成', 'Audio generation'),
          purposeTone: 'recommended',
        }),
        taskToRecommendationCard(findRecommendationTask(audioGeneration, 'sfx'), {
          purposeLabel: ui('音效', 'SFX'),
          purposeTone: 'api',
        }),
        taskToRecommendationCard(findRecommendationTask(audioGeneration, 'voiceover'), {
          purposeLabel: ui('旁白', 'Voiceover'),
          purposeTone: 'relay',
        }),
      ];
    }

    return [
      taskToRecommendationCard(findRecommendationTask(imageAnalysis, 'promptInterrogation'), {
        purposeLabel: ui('图片反推', 'Image interrogation'),
        purposeTone: 'recommended',
      }) || summaryToRecommendationCard(imageAnalysis, {
        purposeLabel: ui('图片解析', 'Image analysis'),
        purposeTone: 'recommended',
      }),
      taskToRecommendationCard(findRecommendationTask(videoAnalysis, 'semanticParse'), {
        purposeLabel: ui('视频语义', 'Video semantics'),
        purposeTone: 'api',
      }) || summaryToRecommendationCard(videoAnalysis, {
        purposeLabel: ui('视频解析', 'Video analysis'),
        purposeTone: 'api',
      }),
      taskToRecommendationCard(findRecommendationTask(videoAnalysis, 'shotBreakdown'), {
        purposeLabel: ui('分镜拆解', 'Shot breakdown'),
        purposeTone: 'relay',
      }),
    ];
  }, [relaySpotlightMode, runtime, ui]);

  const providerKeySteps = useMemo(() => {
    if (!providerGuide) return [];
    return isZh ? providerGuide.keyStepsZh : providerGuide.keyStepsEn;
  }, [isZh, providerGuide]);

  async function refreshRuntimeViews() {
    await Promise.all([
      fetchCatalog({ force: true }),
      fetchRuntime({ force: true }),
      fetchBackendHealth({ force: true }),
    ]);
  }

  function upsertCustomRelayPreset(baseUrl: string) {
    const normalizedBaseUrl = canonicalizeRelayBaseUrl(baseUrl);
    if (!/^https?:\/\/.+/i.test(normalizedBaseUrl)) return null;
    const builtin = RELAY_PRESETS.find((item) => canonicalizeRelayBaseUrl(item.baseUrlExample) === normalizedBaseUrl);
    if (builtin) return builtin;
    const nextPreset = buildCustomRelayPreset(normalizedBaseUrl);
    setCustomRelayPresets((current) => {
      const merged = [...current.filter((item) => canonicalizeRelayBaseUrl(item.baseUrlExample) !== normalizedBaseUrl), nextPreset];
      writeCustomRelayPresets(merged);
      return merged;
    });
    return nextPreset;
  }

  function deleteCustomRelayPreset(presetId: string) {
    setCustomRelayPresets((current) => {
      const next = current.filter((item) => item.id !== presetId);
      writeCustomRelayPresets(next);
      return next;
    });
    if (relayPresetId === presetId) {
      setRelayPresetId('generic-openai-relay');
      setRelayBaseUrl(RELAY_PRESETS.find((item) => item.id === 'generic-openai-relay')?.baseUrlExample || '');
    }
  }

  async function handleOfficialActivate() {
    setLoadingAction('official-activate');
    setMessage(null);
    setError(null);
    try {
      const result = await validateByokKey(
        selectedProvider,
        officialApiKey.trim(),
        mode,
        officialCustomEndpointEnabled ? normalizedOfficialEndpoint || undefined : undefined,
        resolvedOfficialModel || undefined,
      );
      if (!result.success) {
        setError(firstCleanText(result.error?.message, result.message) || ui('官方直连激活失败。', 'Official activation failed.'));
        return;
      }
      await setKey({
        provider: selectedProvider,
        apiKey: officialApiKey.trim(),
        maskedKey: result.maskedKey,
        mode,
        model: resolvedOfficialModel || result.model || undefined,
        endpoint: result.endpoint || (officialCustomEndpointEnabled ? normalizedOfficialEndpoint || undefined : undefined),
      });
      await refreshRuntimeViews();
      setMessage(firstCleanText(result.message) || ui('官方直连已激活，并同步到画布模型菜单。', 'Official provider activated and synced to the canvas model menu.'));
      setVisionActivationFlag([selectedProvider]);
      setOfficialApiKey('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : ui('官方直连激活失败。', 'Official activation failed.'));
    } finally {
      setLoadingAction(null);
    }
  }

  async function handleRelayDiscover() {
    setLoadingAction('relay-discover');
    setMessage(null);
    setError(null);
    try {
      const result = await discoverRelayModels(normalizedRelayBaseUrl, relayApiKey.trim(), currentPreset.id);
      if (result.endpoint) setRelayBaseUrl(result.endpoint);
      const savedPreset = upsertCustomRelayPreset(result.endpoint || normalizedRelayBaseUrl);
      if (savedPreset) setRelayPresetId(savedPreset.id);
      setRelayDiscovery(result);
      setRelayDiscoveryFilterMode('all');
      setRelayDiscoveryOnlyRecommended(false);
      setRelayDiscoveryOnlyCanvasReady(false);
      setRelayDiscoveryDeduped(true);
      setShowRelayDiscovery(true);
      if (!result.success) {
        setError(firstCleanText(result.error?.message, result.message) || ui('模型发现失败。', 'Model discovery failed.'));
        return;
      }
      await fetchRuntime({ force: true });
      setMessage(firstCleanText(result.message) || ui('已拉取中转模型，主流候选已准备就绪。', 'Relay models loaded and mainstream candidates are ready.'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : ui('模型发现失败。', 'Model discovery failed.'));
    } finally {
      setLoadingAction(null);
    }
  }

  async function handleRelayActivate() {
    setLoadingAction('relay-activate');
    setMessage(null);
    setError(null);
    try {
      const result = await activateRelayModels(normalizedRelayBaseUrl, relayApiKey.trim(), currentPreset.id);
      if (result.endpoint) setRelayBaseUrl(result.endpoint);
      const resolvedEndpoint = result.endpoint || normalizedRelayBaseUrl;
      const savedPreset = upsertCustomRelayPreset(resolvedEndpoint);
      if (savedPreset) setRelayPresetId(savedPreset.id);
      setRelayDiscovery(result);
      setRelayDiscoveryFilterMode('all');
      setRelayDiscoveryOnlyRecommended(false);
      setRelayDiscoveryOnlyCanvasReady(false);
      setRelayDiscoveryDeduped(true);
      setShowRelayDiscovery(true);
      if (!result.success) {
        setError(firstCleanText(result.error?.message, result.message) || ui('中转聚合激活失败。', 'Relay activation failed.'));
        return;
      }
      for (const item of result.activations || []) {
        await setKey({
          provider: item.provider,
          apiKey: relayApiKey.trim(),
          maskedKey: item.maskedKey,
          mode: item.mode,
          model: item.model,
          endpoint: resolvedEndpoint,
        });
      }
      await refreshRuntimeViews();
      setMessage(firstCleanText(result.message) || ui('中转聚合模型已激活，并同步到画布模型列表。', 'Relay models activated and synced to the canvas model list.'));
      setVisionActivationFlag((result.activations || []).map((item: { provider?: string }) => String(item.provider || '')));
      setRelayApiKey('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : ui('中转聚合激活失败。', 'Relay activation failed.'));
    } finally {
      setLoadingAction(null);
    }
  }

  async function handleRemoveKey(providerId: string, keyMode?: Mode) {
    setMessage(null);
    setError(null);
    try {
      await removeKey(providerId, keyMode);
      await deactivateByokKey(providerId, keyMode);
      await refreshRuntimeViews();
      setMessage(ui('已移除激活。', 'Activation removed.'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : ui('移除激活失败。', 'Failed to remove activation.'));
    }
  }

  const layout = (
    <div className="min-h-screen bg-[#0b0f14] px-4 py-6 text-[#dce5ee] md:px-6">
      <div className="mx-auto max-w-[1600px] space-y-6">
        <section className="rounded-[28px] border border-[#202834] bg-[radial-gradient(circle_at_top_left,_rgba(0,212,170,0.12),_transparent_38%),linear-gradient(180deg,#111821_0%,#0c1118_100%)] p-5 md:p-6">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
            <div className="space-y-4">
              <button
                type="button"
                onClick={() => navigate('/?skipLaunch=1')}
                className="inline-flex items-center gap-2 rounded-full border border-[#2f465f] bg-[#0f1822] px-4 py-2 text-sm text-[#cfe7ff] transition hover:border-[#5b89b7] hover:text-white"
              >
                <ArrowLeft className="h-4 w-4" />
                {ui('返回画布', 'Back to canvas')}
              </button>
              <div>
                <div className="inline-flex items-center gap-2 rounded-full border border-[#29465b] bg-[#112231] px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-[#8fdcff]">
                  <Sparkles className="h-3.5 w-3.5" />
                  {ui('API 管理与模型路由', 'API Control & Model Routing')}
                </div>
                <h1 className="mt-4 text-2xl font-semibold tracking-tight text-white md:text-3xl">
                  {ui('官方直连、聚合中转与画布模型在同一页打通', 'Keep direct providers, relays, and canvas models in one workspace')}
                </h1>
                <p className="mt-3 max-w-4xl text-sm leading-7 text-[#92a4b7]">
                  {ui(
                    '左侧先选平台，中间填写 Base URL / API Key 并验证，右侧随时查看哪些图片、视频、音频与文本模型已经真正激活到画布。重要操作放首屏，不重要信息折叠。',
                    'Pick a platform on the left, validate Base URL and API key in the middle, and inspect which image, video, audio, and text models are actually live on the canvas from the right column. Primary actions stay front and center while secondary status stays collapsible.',
                  )}
                </p>
              </div>
            </div>

            <div className="grid gap-3 rounded-2xl border border-[#22303c] bg-[#0f151d]/95 p-4 sm:grid-cols-2 lg:grid-cols-4">
              {(['image', 'video', 'llm', 'audio'] as Mode[]).map((entryMode) => (
                <div key={entryMode} className="rounded-xl border border-[#202833] bg-[#111821] px-3 py-3">
                  <div className="text-[11px] uppercase tracking-[0.16em] text-[#708193]">
                    {formatModeLabel(entryMode, ui)}
                  </div>
                  <div className="mt-2 text-xl font-semibold text-white">{activatedSummary[entryMode]}</div>
                  <div className="mt-1 text-[11px] text-[#7d8fa1]">
                    {ui('已同步到画布', 'Synced to canvas')}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {message ? (
          <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">{message}</div>
        ) : null}
        {error ? (
          <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</div>
        ) : null}

        <section className="grid gap-6 xl:grid-cols-[280px_minmax(0,1fr)_380px] xl:items-start">
          <aside className="min-h-0 space-y-5 xl:max-h-[calc(100vh-136px)] xl:overflow-y-auto xl:pr-1">
            <div className="rounded-[24px] border border-[#202934] bg-[#0f141b] p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-white">{ui('平台列表', 'Platform list')}</div>
                  <div className="mt-1 text-xs leading-6 text-[#8ea0b2]">
                    {ui('先从左侧确定接入入口，再到中间填写 Key 和验证。', 'Choose the access path here first, then validate in the middle workspace.')}
                  </div>
                </div>
                <SourceBadge label={`${activatedPlatformCards.length} ${ui('个平台已接通', 'platforms live')}`} tone="recommended" />
              </div>

              <div className="mt-5 space-y-5">
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-[#74d8ff]">{ui('聚合中转平台', 'Relay / aggregator')}</div>
                    <SourceBadge label={relayPresetDisplayName(currentPreset, ui)} tone="relay" />
                  </div>
                  <div className="space-y-2">
                    {relayPresetOptions.map((item) => {
                      const selected = relayPresetId === item.id;
                      const customPreset = !RELAY_PRESETS.some((preset) => preset.id === item.id);
                      return (
                        <div
                          key={item.id}
                          className={`w-full rounded-2xl border px-4 py-3 transition ${
                            selected
                              ? 'border-[#5ca7ff]/45 bg-[#162232] shadow-[0_0_0_1px_rgba(92,167,255,0.12)]'
                              : 'border-[#27313c] bg-[#111821] hover:border-[#46607a]'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <button
                              type="button"
                              onClick={() => {
                                setActiveConfigSection('relay');
                                setRelayPresetId(item.id);
                                setRelayBaseUrl(item.baseUrlExample);
                                setRelayExpanded(true);
                              }}
                              className="min-w-0 flex-1 text-left"
                            >
                              <div className="text-sm font-semibold text-white">{pickLocaleText(isZh, item.nameZh, item.nameEn)}</div>
                              <div className="mt-1 text-[11px] leading-5 text-[#8ea0b2]">
                                {relayPresetDescription(item, ui)}
                              </div>
                              {item.id === 'generic-openai-relay' ? (
                                <div className="mt-2">
                                  <SourceBadge label={ui('自定义入口', 'Custom entry')} tone="recommended" />
                                </div>
                              ) : null}
                              {customPreset ? (
                                <div className="mt-2">
                                  <SourceBadge label={ui('本地保存', 'Saved locally')} tone="relay" />
                                </div>
                              ) : null}
                            </button>
                            <div className="flex items-center gap-2">
                              {customPreset ? (
                                <button
                                  type="button"
                                  onClick={() => deleteCustomRelayPreset(item.id)}
                                  className="inline-flex items-center gap-1 rounded-full border border-[#43303a] px-2.5 py-1 text-[11px] text-[#ffb5c4] transition hover:border-[#9d5167] hover:text-white"
                                >
                                  <Trash2 className="h-3 w-3" />
                                  {ui('删除', 'Delete')}
                                </button>
                              ) : null}
                              <SourceBadge label={selected ? ui('当前选择', 'Selected') : ui('可接入', 'Available')} tone={selected ? 'relay' : 'neutral'} />
                              {activatedRelayPresetIds.has(item.id) ? (
                                <SourceBadge label={ui('已激活', 'Active')} tone="recommended" />
                              ) : null}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-[#74d8ff]">{ui('官方直连', 'Official direct')}</div>
                    <SourceBadge label={providerGuide?.officialName || selectedProvider} tone="api" />
                  </div>
                  <div className="space-y-2">
                    {providerOptions.map((item) => {
                      const selected = selectedProvider === item.id;
                      const guide = getProviderGuide(item.id);
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => {
                            setActiveConfigSection('official');
                            setSelectedProvider(item.id);
                            setOfficialExpanded(true);
                          }}
                          className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
                            selected
                              ? 'border-[#5ca7ff]/45 bg-[#162232] shadow-[0_0_0_1px_rgba(92,167,255,0.12)]'
                              : 'border-[#27313c] bg-[#111821] hover:border-[#46607a]'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-sm font-semibold text-white">{guide?.officialName || item.name}</div>
                              <div className="mt-1 flex flex-wrap gap-1.5">
                                {item.modes.map((entryMode) => (
                                  <SourceBadge key={`${item.id}-${entryMode}`} label={formatModeLabel(entryMode as Mode, ui)} tone="neutral" />
                                ))}
                              </div>
                            </div>
                            <SourceBadge label={selected ? ui('当前选择', 'Selected') : ui('官方', 'Direct')} tone={selected ? 'api' : 'neutral'} />
                            {keyList.some((k) => k.provider === item.id && resolveProviderKeyStatus(k.expiresAt) === 'active') ? (
                              <SourceBadge label={ui('已激活', 'Active')} tone="recommended" />
                            ) : null}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </aside>

            <main className="min-h-0 min-w-0 space-y-6 xl:max-h-[calc(100vh-136px)] xl:overflow-y-auto xl:pr-1">
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-2xl border border-[#22303c] bg-[#101720] px-4 py-3">
                <div className="text-[11px] uppercase tracking-[0.16em] text-[#73cfe8]">{ui('第 1 步', 'Step 1')}</div>
                <div className="mt-1 text-sm text-white">{ui('左侧选平台入口', 'Pick a platform on the left')}</div>
              </div>
              <div className="rounded-2xl border border-[#22303c] bg-[#101720] px-4 py-3">
                <div className="text-[11px] uppercase tracking-[0.16em] text-[#73cfe8]">{ui('第 2 步', 'Step 2')}</div>
                <div className="mt-1 text-sm text-white">{ui('在中间填写 Base URL / Key', 'Enter Base URL / key here')}</div>
              </div>
              <div className="rounded-2xl border border-[#22303c] bg-[#101720] px-4 py-3">
                <div className="text-[11px] uppercase tracking-[0.16em] text-[#73cfe8]">{ui('第 3 步', 'Step 3')}</div>
                <div className="mt-1 text-sm text-white">{ui('验证后自动同步到画布', 'Validate and sync to the canvas')}</div>
              </div>
            </div>

            <div className="rounded-[24px] border border-[#202934] bg-[#0f141b] p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-white">{ui('平台配置工作区', 'Platform configuration workspace')}</div>
                  <div className="mt-1 text-xs leading-6 text-[#8ea0b2]">
                    {activeConfigSection === 'relay'
                      ? ui('当前在配置聚合中转平台。填写 Base URL 和一个 API Key 后，可以统一激活多家模型。', 'You are configuring a relay / aggregator. One Base URL and key can activate multiple upstream models.')
                      : ui('当前在配置官方直连。系统会先推荐更适合当前模式的模型，再验证 API Key。', 'You are configuring an official direct provider. The page recommends the best-fit model before validation.')}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setActiveConfigSection('relay')}
                    className={`rounded-full border px-4 py-2 text-sm transition ${
                      activeConfigSection === 'relay'
                        ? 'border-[#00d4aa]/40 bg-[#00d4aa]/12 text-[#8cf0df]'
                        : 'border-[#2a3440] bg-[#111821] text-[#9eb0c2] hover:border-[#46607a] hover:text-white'
                    }`}
                  >
                    {ui('聚合中转平台', 'Relay / aggregator')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveConfigSection('official')}
                    className={`rounded-full border px-4 py-2 text-sm transition ${
                      activeConfigSection === 'official'
                        ? 'border-[#5ca7ff]/40 bg-[#173253] text-[#b4dbff]'
                        : 'border-[#2a3440] bg-[#111821] text-[#9eb0c2] hover:border-[#46607a] hover:text-white'
                    }`}
                  >
                    {ui('官方直连', 'Official direct')}
                  </button>
                </div>
              </div>

              {activeConfigSection === 'relay' ? (
                <div className="mt-5 space-y-5">
                  <CollapseToggle
                    expanded={relayExpanded}
                    onClick={() => setRelayExpanded((value) => !value)}
                    title={ui('中转聚合平台', 'Relay / Aggregator')}
                    subtitle={ui('中间区域只保留 Base URL、API Key、发现模型和激活动作，避免首屏被历史说明挤满。', 'This workspace keeps Base URL, API key, discovery, and activation front and center so the page does not get crowded by long-form instructions.')}
                    badge={<SourceBadge label={relayPresetDisplayName(currentPreset, ui)} tone="relay" />}
                  />

                  {relayExpanded ? (
                    <div className="space-y-5">
                      <div className="grid gap-4 md:grid-cols-2">
                        <label className="space-y-2">
                          <span className="text-xs uppercase tracking-[0.16em] text-[#7f92a7]">{ui('聚合平台类型', 'Relay preset')}</span>
                          <select
                            data-testid="api-relay-preset"
                            value={relayPresetId}
                            onChange={(event) => {
                              const nextPreset = relayPresetOptions.find((item) => item.id === event.target.value) || RELAY_PRESETS[0];
                              setRelayPresetId(nextPreset.id);
                              setRelayBaseUrl(nextPreset.baseUrlExample);
                            }}
                            className="w-full rounded-2xl border border-[#2b3440] bg-[#111821] px-4 py-3 text-sm text-white outline-none transition focus:border-[#5ba4ff]"
                          >
                            {relayPresetOptions.map((item) => (
                              <option key={item.id} value={item.id}>
                              {relayPresetDisplayName(item, ui)}
                            </option>
                          ))}
                          </select>
                        </label>

                        <label className="space-y-2">
                          <span className="text-xs uppercase tracking-[0.16em] text-[#7f92a7]">Base URL</span>
                          <input
                            data-testid="api-relay-base-url"
                            value={relayBaseUrl}
                            onChange={(event) => setRelayBaseUrl(event.target.value)}
                            onBlur={() => {
                              const next = canonicalizeRelayBaseUrl(relayBaseUrl);
                              if (next && next !== relayBaseUrl) setRelayBaseUrl(next);
                            }}
                            placeholder={currentPreset?.baseUrlExample}
                            className="w-full rounded-2xl border border-[#2b3440] bg-[#111821] px-4 py-3 text-sm text-white outline-none transition focus:border-[#5ba4ff]"
                          />
                        </label>
                      </div>

                      <div className="rounded-2xl border border-[#222d38] bg-[#111821] p-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-semibold text-white">
                              {relayPresetDisplayName(currentPreset, ui)}
                            </div>
                            <div className="mt-1 text-xs leading-6 text-[#8ea0b2]">
                              {relayPresetDescription(currentPreset, ui)}
                            </div>
                            <div className="mt-2 text-xs leading-6 text-[#72e4d2]">
                              {relayPresetEndpointHint(currentPreset, ui)}
                            </div>
                          </div>
                          <div className="flex shrink-0 flex-wrap gap-2">
                            {currentPreset?.docsUrl ? (
                              <a
                                href={currentPreset.docsUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 rounded-full border border-[#2f465f] px-3 py-1.5 text-xs text-[#9fd4ff] transition hover:border-[#5b89b7] hover:text-white"
                              >
                                <Link2 className="h-3.5 w-3.5" />
                                Docs
                              </a>
                            ) : null}
                            {currentPreset?.consoleUrl ? (
                              <a
                                href={currentPreset.consoleUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 rounded-full border border-[#2f465f] px-3 py-1.5 text-xs text-[#9fd4ff] transition hover:border-[#5b89b7] hover:text-white"
                              >
                                <ArrowUpRight className="h-3.5 w-3.5" />
                                {ui('打开控制台', 'Open console')}
                              </a>
                            ) : null}
                          </div>
                        </div>

                        <div className="mt-4 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              const savedPreset = upsertCustomRelayPreset(normalizedRelayBaseUrl);
                              if (savedPreset) {
                                setRelayPresetId(savedPreset.id);
                                setMessage(ui('当前中转平台已保存到本地，下次会自动出现在左侧列表。', 'The current relay has been saved locally and will appear in the left list next time.'));
                              }
                            }}
                            disabled={!/^https?:\/\/.+/i.test(normalizedRelayBaseUrl)}
                            className="inline-flex items-center gap-2 rounded-full border border-[#2f465f] px-3 py-1.5 text-xs text-[#9fd4ff] transition hover:border-[#5b89b7] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <Sparkles className="h-3.5 w-3.5" />
                            {currentRelayPresetIsCustom ? ui('更新本地记录', 'Update local preset') : ui('保存为本地中转', 'Save as local relay')}
                          </button>
                          {currentRelayPresetIsCustom ? (
                            <button
                              type="button"
                              onClick={() => deleteCustomRelayPreset(currentPreset.id)}
                              className="inline-flex items-center gap-2 rounded-full border border-[#43303a] px-3 py-1.5 text-xs text-[#ffb5c4] transition hover:border-[#9d5167] hover:text-white"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              {ui('删除本地记录', 'Delete local preset')}
                            </button>
                          ) : null}
                        </div>

                        <div className="mt-4 space-y-3">
                          {(['image', 'video', 'audio', 'llm'] as Mode[]).map((entryMode) => {
                            const labels = currentPreset?.recommendedModels?.[entryMode] || [];
                            if (!labels.length) return null;
                            return (
                              <div key={`preset-${entryMode}`}>
                                <div className="mb-2 text-[11px] uppercase tracking-[0.16em] text-[#708193]">
                                  {formatModeLabel(entryMode, ui)}
                                </div>
                                <div className="flex flex-wrap gap-2">
                                  {labels.map((label) => (
                                    <SourceBadge
                                      key={`${entryMode}-${label}`}
                                      label={label}
                                      tone={entryMode === 'image' ? 'recommended' : entryMode === 'video' ? 'relay' : 'neutral'}
                                    />
                                  ))}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      <label className="space-y-2">
                        <span className="text-xs uppercase tracking-[0.16em] text-[#7f92a7]">{ui('聚合平台 Key', 'Relay API key')}</span>
                        <div className="relative">
                          <KeyRound className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#708193]" />
                          <input
                            data-testid="api-relay-api-key"
                            type="password"
                            value={relayApiKey}
                            onChange={(event) => setRelayApiKey(event.target.value)}
                            placeholder="sk-..."
                            className="w-full rounded-2xl border border-[#2b3440] bg-[#111821] py-3 pl-11 pr-4 text-sm text-white outline-none transition focus:border-[#5ba4ff]"
                          />
                        </div>
                      </label>

                      <div className="flex flex-wrap gap-3">
                        <button
                          type="button"
                          data-testid="api-relay-discover-button"
                          onClick={() => { void handleRelayDiscover(); }}
                          disabled={relayActionsDisabled || loadingAction !== null}
                          className="inline-flex items-center gap-2 rounded-full border border-[#2d4152] bg-[#111b25] px-4 py-2.5 text-sm text-[#cae2ff] transition hover:border-[#5d86aa] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {loadingAction === 'relay-discover' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                          {ui('拉取模型列表', 'Discover models')}
                        </button>
                        <button
                          type="button"
                          data-testid="api-relay-activate-button"
                          onClick={() => { void handleRelayActivate(); }}
                          disabled={relayActionsDisabled || loadingAction !== null}
                          className="inline-flex items-center gap-2 rounded-full border border-[#00d4aa]/40 bg-[#00d4aa]/12 px-4 py-2.5 text-sm text-[#8cf0df] transition hover:border-[#7cf1dc] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {loadingAction === 'relay-activate' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                          {ui('验证并同步到画布', 'Activate and sync')}
                        </button>
                      </div>

                      <CollapseToggle
                        expanded={showRelayInsights}
                        onClick={() => setShowRelayInsights((value) => !value)}
                        title={ui('更多候选与来源状态', 'More relay candidates and source state')}
                        subtitle={ui('需要时再展开，用来检查推荐候选、来源标记和画布可同步状态。', 'Expand only when needed to inspect discovery candidates, source labels, and canvas readiness.')}
                      />

                      {showRelayInsights ? (
                        <div className="rounded-2xl border border-[#1f2a34] bg-[#0d1319] p-4">
                          <div className="flex flex-wrap gap-2">
                            {(['image', 'video', 'audio', 'llm'] as Mode[]).map((entryMode) => (
                              <button
                                key={entryMode}
                                type="button"
                                onClick={() => setRelaySpotlightMode(entryMode)}
                                className={`rounded-full border px-3 py-1.5 text-xs transition ${
                                  relaySpotlightMode === entryMode
                                    ? 'border-[#5ca7ff]/40 bg-[#173253] text-[#b4dbff]'
                                    : 'border-[#2a3440] bg-[#111821] text-[#9eb0c2] hover:border-[#46607a] hover:text-white'
                                }`}
                              >
                                {formatModeLabel(entryMode, ui)}
                              </button>
                            ))}
                          </div>

                          <div className="mt-4 grid gap-3 lg:grid-cols-2">
                            {spotlightRows.map((item) => (
                              <article key={item.key} className="rounded-2xl border border-[#283340] bg-[#121922] p-4">
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                  <div>
                                    <div className="text-sm font-semibold text-white">{item.label}</div>
                                    <div className="mt-1 text-xs text-[#73cfe8]">{item.providerHint}</div>
                                  </div>
                                  <div className="flex flex-wrap gap-2">
                                    <SourceBadge label={item.activeInRelay ? 'via Relay' : ui('中转候选', 'Relay candidate')} tone={item.activeInRelay ? 'relay' : 'neutral'} />
                                    {item.canvasReady ? <SourceBadge label={ui('可同步到画布', 'Canvas ready')} tone="recommended" /> : null}
                                  </div>
                                </div>
                                <div className="mt-2 text-xs leading-6 text-[#8ea0b2]">
                                  {pickLocaleText(isZh, item.descriptionZh, item.descriptionEn)}
                                </div>
                                {item.noteZh || item.noteEn ? (
                                  <div className="mt-2 rounded-xl border border-[#2c3641] bg-[#0f151c] px-3 py-2 text-[11px] leading-5 text-[#9fb0c3]">
                                    {pickLocaleText(isZh, item.noteZh, item.noteEn)}
                                  </div>
                                ) : null}
                                {item.discovered ? (
                                  <div className="mt-3 rounded-xl border border-[#2d3844] bg-[#0e141c] px-3 py-2">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <SourceBadge label={formatModeLabel(item.discovered.mode as Mode, ui)} tone={modelBadgeTone(item.discovered)} />
                                      {item.discovered.supportedOnCanvas ? <SourceBadge label={ui('支持画布', 'Canvas supported')} tone="relay" /> : null}
                                      {item.discovered.recommended ? <SourceBadge label={ui('推荐', 'Recommended')} tone="recommended" /> : null}
                                    </div>
                                    <div className="mt-2 text-xs font-medium text-white">{item.discovered.name}</div>
                                    <div className="mt-1 text-[11px] text-[#89a0b6]">
                                      {firstCleanText(item.discovered.recommendation, item.discovered.description) || ui('这是当前模式下更稳妥的推荐。', 'A strong recommendation for this mode.')}
                                    </div>
                                  </div>
                                ) : (
                                  <div className="mt-3 rounded-xl border border-dashed border-[#2c3441] bg-[#0e141c] px-3 py-2 text-[11px] leading-5 text-[#8ea0b2]">
                                    {ui('当前中转里还没有发现这个模型。', 'This model has not been discovered from the current relay yet.')}
                                  </div>
                                )}
                              </article>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      {relayDiscovery ? (
                        <div className="rounded-2xl border border-[#1f2a34] bg-[#0d1319] p-4">
                          <CollapseToggle
                            expanded={showRelayDiscovery}
                            onClick={() => setShowRelayDiscovery((value) => !value)}
                            title={ui('本次拉取的模型列表', 'Discovered relay models')}
                            subtitle={firstCleanText(relayDiscovery.message) || ui('系统已经把拉取结果按图片、视频、音频与文本能力筛成更适合画布的候选。', 'The result set has already been filtered into more canvas-friendly candidates by task type.')}
                            badge={<SourceBadge label={`${relayDiscovery.models.length} ${ui('个模型', 'models')}`} tone="recommended" />}
                          />

                          {showRelayDiscovery ? (
                            <div className="mt-4 max-h-[420px] overflow-y-auto pr-1">
                              <div className="mb-4 space-y-3" data-testid="api-relay-discovery-summary">
                                <div className="flex flex-wrap gap-2">
                                  <SourceBadge label={`${relayDiscoverySummary.total} ${ui('个模型', 'models')}`} tone="recommended" />
                                  <SourceBadge label={`${relayDiscoverySummary.recommended} ${ui('个推荐', 'recommended')}`} tone="api" />
                                  <SourceBadge label={`${relayDiscoverySummary.canvasReady} ${ui('个可上画布', 'canvas-ready')}`} tone="relay" />
                                  <SourceBadge label={`${relayDiscoverySummary.dedupedFamilies} ${ui('个模型家族', 'families')}`} tone="neutral" />
                                </div>
                                {relayDiscoveryRecommendedCards.length ? (
                                  <div className="grid gap-3 xl:grid-cols-2">
                                    {relayDiscoveryRecommendedCards.map(({ mode: entryMode, item }) => (
                                      <article key={`${entryMode}-${item.id}`} className="rounded-2xl border border-[#27323d] bg-[#101720] px-4 py-3">
                                        <div className="flex flex-wrap items-start justify-between gap-3">
                                          <div className="min-w-0">
                                            <div className="text-xs uppercase tracking-[0.16em] text-[#7f92a7]">{formatModeLabel(entryMode, ui)}</div>
                                            <div className="mt-1 text-sm font-semibold text-white">{item.name}</div>
                                            <div className="mt-1 break-all text-[11px] text-[#8ea0b2]">{item.upstreamModel || item.id}</div>
                                          </div>
                                          <div className="flex flex-wrap gap-2">
                                            <SourceBadge label={ui('首推', 'Primary pick')} tone="recommended" />
                                            {item.supportedOnCanvas ? <SourceBadge label={ui('可同步到画布', 'Canvas ready')} tone="relay" /> : null}
                                          </div>
                                        </div>
                                        <div className="mt-2 text-[11px] leading-5 text-[#8ea0b2]">
                                          {firstCleanText(item.recommendation, item.description) || ui('优先展示当前任务里更稳妥的主流模型。', 'Prioritizes the strongest mainstream model for this task.')}
                                        </div>
                                      </article>
                                    ))}
                                  </div>
                                ) : null}
                              </div>

                              <div className="mb-4 flex flex-wrap items-center gap-2">
                                {(['all', 'image', 'video', 'audio', 'llm'] as DiscoveryModeFilter[]).map((entryMode) => (
                                  <button
                                    key={entryMode}
                                    type="button"
                                    data-testid={`api-relay-discovery-filter-${entryMode}`}
                                    onClick={() => setRelayDiscoveryFilterMode(entryMode)}
                                    className={`rounded-full border px-3 py-1.5 text-xs transition ${
                                      relayDiscoveryFilterMode === entryMode
                                        ? 'border-[#5ca7ff]/40 bg-[#173253] text-[#b4dbff]'
                                        : 'border-[#2a3440] bg-[#111821] text-[#9eb0c2] hover:border-[#46607a] hover:text-white'
                                    }`}
                                  >
                                    {entryMode === 'all' ? ui('全部任务', 'All tasks') : formatModeLabel(entryMode, ui)}
                                  </button>
                                ))}
                                <button
                                  type="button"
                                  data-testid="api-relay-discovery-toggle-recommended"
                                  onClick={() => setRelayDiscoveryOnlyRecommended((value) => !value)}
                                  className={`rounded-full border px-3 py-1.5 text-xs transition ${
                                    relayDiscoveryOnlyRecommended
                                      ? 'border-[#62d6b3]/40 bg-[#12342d] text-[#a7f3df]'
                                      : 'border-[#2a3440] bg-[#111821] text-[#9eb0c2] hover:border-[#46607a] hover:text-white'
                                  }`}
                                >
                                  {relayDiscoveryOnlyRecommended ? ui('仅看推荐中', 'Recommended only') : ui('只看推荐', 'Recommended only')}
                                </button>
                                <button
                                  type="button"
                                  data-testid="api-relay-discovery-toggle-canvas-ready"
                                  onClick={() => setRelayDiscoveryOnlyCanvasReady((value) => !value)}
                                  className={`rounded-full border px-3 py-1.5 text-xs transition ${
                                    relayDiscoveryOnlyCanvasReady
                                      ? 'border-[#5ca7ff]/40 bg-[#173253] text-[#b4dbff]'
                                      : 'border-[#2a3440] bg-[#111821] text-[#9eb0c2] hover:border-[#46607a] hover:text-white'
                                  }`}
                                >
                                  {relayDiscoveryOnlyCanvasReady ? ui('仅看可上画布', 'Canvas-ready only') : ui('只看可上画布', 'Canvas-ready only')}
                                </button>
                                <button
                                  type="button"
                                  data-testid="api-relay-discovery-toggle-deduped"
                                  onClick={() => setRelayDiscoveryDeduped((value) => !value)}
                                  className={`rounded-full border px-3 py-1.5 text-xs transition ${
                                    relayDiscoveryDeduped
                                      ? 'border-[#f3d38a]/40 bg-[#352b16] text-[#f8df9c]'
                                      : 'border-[#2a3440] bg-[#111821] text-[#9eb0c2] hover:border-[#46607a] hover:text-white'
                                  }`}
                                >
                                  {relayDiscoveryDeduped ? ui('同族已去重', 'Family dedupe on') : ui('同族去重', 'Deduplicate families')}
                                </button>
                              </div>

                              <div className="mb-4 rounded-2xl border border-[#23303a] bg-[#0f161d] px-4 py-3 text-[11px] leading-5 text-[#8ea0b2]">
                                {ui(
                                  `当前展示 ${relayDiscoveryVisibleModels.length} 个候选，优先按任务首推、画布可用、推荐分排序。${relayDiscoveryHiddenCount > 0 ? `其余 ${relayDiscoveryHiddenCount} 个已折叠或过滤。` : '当前没有额外折叠项。'}`,
                                  `Showing ${relayDiscoveryVisibleModels.length} candidates, sorted by task-first picks, canvas readiness, and recommendation score.${relayDiscoveryHiddenCount > 0 ? ` The other ${relayDiscoveryHiddenCount} items are folded or filtered.` : ' No extra items are currently folded.'}`,
                                )}
                              </div>

                              <div className="grid gap-3 xl:grid-cols-2" data-testid="api-relay-discovery-list">
                                {relayDiscoveryVisibleModels.map((item) => {
                                  const taskFirst = relayRecommendedModelIds.has(normalizeIdentifier(item.id))
                                    || relayRecommendedModelIds.has(normalizeIdentifier(item.catalogModelId))
                                    || relayRecommendedModelIds.has(normalizeIdentifier(item.upstreamModel));
                                  return (
                                    <article key={`${item.id}-${item.mode}`} className="rounded-2xl border border-[#283340] bg-[#121922] px-4 py-3">
                                      <div className="flex flex-wrap items-start justify-between gap-3">
                                        <div className="min-w-0">
                                          <div className="text-sm font-semibold text-white">{item.name}</div>
                                          <div className="mt-1 text-xs text-[#74d8ff]">{item.providerLabel}</div>
                                          <div className="mt-1 break-all text-[11px] text-[#8ea0b2]">{item.upstreamModel || item.id}</div>
                                        </div>
                                        <div className="flex flex-wrap gap-2">
                                          <SourceBadge label={formatModeLabel(item.mode as Mode, ui)} tone={modelBadgeTone(item)} />
                                          {taskFirst ? <SourceBadge label={ui('任务首推', 'Task-first pick')} tone="api" /> : null}
                                          {item.supportedOnCanvas ? <SourceBadge label={ui('可上画布', 'Canvas ready')} tone="relay" /> : null}
                                          {item.recommended ? <SourceBadge label={ui('推荐', 'Recommended')} tone="recommended" /> : null}
                                        </div>
                                      </div>
                                      <div className="mt-2 text-[11px] leading-5 text-[#8ea0b2]">
                                        {firstCleanText(item.recommendation, item.description) || ui('这是当前模式下更稳妥的推荐。', 'A strong recommendation for this mode.')}
                                      </div>
                                      <div className="mt-2 text-[11px] text-[#72e4d2]">
                                        {formatPricingDetail(item)}
                                      </div>
                                    </article>
                                  );
                                })}
                              </div>
                              {!relayDiscoveryVisibleModels.length ? (
                                <div className="mt-3 rounded-2xl border border-dashed border-[#2a3440] bg-[#111821] px-4 py-5 text-sm text-[#93a4b4]">
                                  {ui('当前筛选条件下没有可见模型，建议先取消“只看推荐”或“只看可上画布”。', 'No models match the current filters. Try disabling the recommended-only or canvas-ready-only toggle.')}
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="mt-5 space-y-5">
                  <CollapseToggle
                    expanded={officialExpanded}
                    onClick={() => setOfficialExpanded((value) => !value)}
                    title={ui('官方直连', 'Official direct')}
                    subtitle={ui('适合已经明确知道要直连哪家官方平台时使用；模型标识会优先给出首推与备选，尽量不让用户手动猜。', 'Use this when you know which official provider to connect. The page recommends primary and alternate model ids so users do not have to guess.')}
                    badge={<SourceBadge label={providerGuide?.officialName || selectedProvider} tone="api" />}
                  />

                  {officialExpanded ? (
                    <div className="space-y-5">
                      <div className="grid gap-4 md:grid-cols-2">
                        <label className="space-y-2">
                          <span className="text-xs uppercase tracking-[0.16em] text-[#7f92a7]">{ui('官方平台', 'Official provider')}</span>
                          <select
                            value={selectedProvider}
                            onChange={(event) => setSelectedProvider(event.target.value)}
                            className="w-full rounded-2xl border border-[#2b3440] bg-[#111821] px-4 py-3 text-sm text-white outline-none transition focus:border-[#5ba4ff]"
                          >
                            {providerOptions.map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.name}
                              </option>
                            ))}
                          </select>
                        </label>

                        <label className="space-y-2">
                          <span className="text-xs uppercase tracking-[0.16em] text-[#7f92a7]">{ui('模式', 'Mode')}</span>
                          <select
                            value={mode}
                            onChange={(event) => setMode(event.target.value as Mode)}
                            className="w-full rounded-2xl border border-[#2b3440] bg-[#111821] px-4 py-3 text-sm text-white outline-none transition focus:border-[#5ba4ff]"
                          >
                            {(provider?.modes || ['image', 'video', 'llm', 'audio']).map((entryMode) => (
                              <option key={entryMode} value={entryMode}>
                                {formatModeLabel(entryMode as Mode, ui)}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>

                      <div className="rounded-2xl border border-[#222d38] bg-[#111821] p-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-semibold text-white">{providerGuide?.officialName || selectedProvider}</div>
                            <div className="mt-1 text-xs leading-6 text-[#8ea0b2]">
                              {providerGuide ? pickLocaleText(isZh, providerGuide.relayHintZh, providerGuide.relayHintEn) : ui('尽量直接使用系统推荐模型，而不是手动填写模型标识。', 'Use the system recommended model whenever possible instead of manually typing model ids.')}
                            </div>
                            {providerKeySteps.length ? (
                              <div className="mt-3 flex flex-wrap gap-2">
                                {providerKeySteps.map((step) => (
                                  <span key={step} className="rounded-full border border-[#2a3440] bg-[#0f151c] px-3 py-1 text-[11px] text-[#9fb0c3]">
                                    {step}
                                  </span>
                                ))}
                              </div>
                            ) : null}
                          </div>
                          <div className="flex shrink-0 flex-wrap gap-2">
                            {providerGuide?.docsUrl ? (
                              <a
                                href={providerGuide.docsUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 rounded-full border border-[#2f465f] px-3 py-1.5 text-xs text-[#9fd4ff] transition hover:border-[#5b89b7] hover:text-white"
                              >
                                <Link2 className="h-3.5 w-3.5" />
                                Docs
                              </a>
                            ) : null}
                            {providerGuide?.consoleUrl ? (
                              <a
                                href={providerGuide.consoleUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 rounded-full border border-[#2f465f] px-3 py-1.5 text-xs text-[#9fd4ff] transition hover:border-[#5b89b7] hover:text-white"
                              >
                                <ArrowUpRight className="h-3.5 w-3.5" />
                                {ui('打开控制台', 'Open console')}
                              </a>
                            ) : null}
                          </div>
                        </div>
                      </div>

                      {/* API Key 放在最上方 —— 填完才能激活 */}
                      <label className="space-y-2">
                        <span className="text-xs uppercase tracking-[0.16em] text-[#7f92a7]">{ui('官方 API Key', 'Official API key')}</span>
                        <div className="relative">
                          <KeyRound className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#708193]" />
                          <input
                            type="password"
                            value={officialApiKey}
                            onChange={(event) => setOfficialApiKey(event.target.value)}
                            placeholder="sk-..."
                            className="w-full rounded-2xl border border-[#2b3440] bg-[#111821] py-3 pl-11 pr-4 text-sm text-white outline-none transition focus:border-[#5ba4ff]"
                          />
                        </div>
                      </label>

                      <button
                        type="button"
                        onClick={() => { void handleOfficialActivate(); }}
                        disabled={officialActionsDisabled || loadingAction !== null}
                        className="inline-flex items-center gap-2 rounded-full border border-[#00d4aa]/40 bg-[#00d4aa]/12 px-4 py-2.5 text-sm text-[#8cf0df] transition hover:border-[#7cf1dc] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {loadingAction === 'official-activate' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                        {ui('验证并激活', 'Validate and activate')}
                      </button>

                      {/* 推荐模型放在 API Key 下方 —— 激活后再选择模型 */}
                      {officialRecommendedModels.length ? (
                        <div className="space-y-3">
                          <span className="text-xs uppercase tracking-[0.16em] text-[#7f92a7]">{ui('推荐模型', 'Recommended model')}</span>
                          <select
                            value={resolvedOfficialModel}
                            onChange={(event) => {
                              setOfficialCustomModelEnabled(false);
                              setOfficialModel(event.target.value);
                            }}
                            className="w-full rounded-2xl border border-[#2b3440] bg-[#111821] px-4 py-3 text-sm text-white outline-none transition focus:border-[#5ba4ff]"
                          >
                            {officialRecommendedModels.map((item) => (
                              <option key={item.id} value={item.model}>
                                {pickLocaleText(isZh, item.labelZh, item.labelEn)} 路 {item.model}
                              </option>
                            ))}
                          </select>
                          <div className="rounded-2xl border border-[#243240] bg-[#0d141c] px-4 py-3 text-xs leading-6 text-[#8ea0b2]">
                            <div className="font-medium text-white">
                              {pickLocaleText(isZh, selectedOfficialPreset?.labelZh, selectedOfficialPreset?.labelEn)}
                            </div>
                            <div className="mt-1">{selectedOfficialPreset?.model}</div>
                            {selectedOfficialPreset?.noteZh || selectedOfficialPreset?.noteEn ? (
                              <div className="mt-2 text-[#72e4d2]">
                                {pickLocaleText(isZh, selectedOfficialPreset?.noteZh, selectedOfficialPreset?.noteEn)}
                              </div>
                            ) : null}
                          </div>
                          {officialRecommendationCards.length ? (
                            <RecommendationCardsPanel
                              testId="api-official-direct-recommendation-panel"
                              title={ui('官方直连推荐卡', 'Official direct recommendation cards')}
                              subtitle={ui('按任务展示首推、备选和适用标签；默认模型选择器会跟随首推项。', 'Shows primary picks, alternates, and task tags by task; the default model selector follows the primary pick.')}
                              cards={officialRecommendationCards}
                            />
                          ) : null}
                        </div>
                      ) : (
                        <div className="rounded-2xl border border-[#243240] bg-[#0d141c] px-4 py-3 text-xs leading-6 text-[#8ea0b2]">
                          {ui('当前这个平台和模式还没有预设模型；后端会尽量按平台默认模型做校验。', 'No preset model is configured for this provider and mode yet. The backend will validate against the provider default when possible.')}
                        </div>
                      )}

                      {/* model / endpoint 获取指引 */}
                      <div className="rounded-2xl border border-[#2b3a4d] bg-[#0e1620] px-4 py-3 text-xs leading-6 text-[#9fb0c3]">
                        <div className="font-medium text-[#bfe0ff]">{ui('模型标识 / Base URL 怎么填？', 'How to fill model id / Base URL?')}</div>
                        <ul className="mt-2 list-disc space-y-1 pl-4">
                          <li>
                            {ui(
                              '模型标识：默认已带出该平台当前模式的推荐模型（图像生成用 wanx2.1，文本/对话用 qwen-plus）。要做 AI 深度分析，请切到“文本/对话”模式，在推荐模型里选 Qwen-VL-Max（视觉模型），激活后即写入分析链路。需要自定义时，在下方“高级设置”填平台“模型列表”里复制的模型 ID。',
                              'Model id: the recommended model for the current mode is pre-filled (wanx2.1 for image generation, qwen-plus for text). For AI deep analysis, switch to the "Text / LLM" mode and pick Qwen-VL-Max (a vision model) from the recommended list; activating it wires it into the analysis chain. To override, copy the model id from the platform model list in Advanced settings below.',
                            )}
                          </li>
                          <li>
                            {ui(
                              'Base URL：多数平台留空即可，后端会自动用平台默认地址（百炼默认 https://dashscope.aliyuncs.com/compatible-mode/v1，硅基流动默认 https://api.siliconflow.cn/v1）。仅当官方文档明确要求自定义网关时才填写。',
                              'Base URL: leave empty for most platforms; the backend uses the provider default (Bailian: https://dashscope.aliyuncs.com/compatible-mode/v1, SiliconFlow: https://api.siliconflow.cn/v1). Only fill it when the docs explicitly require a custom gateway.',
                            )}
                          </li>
                          <li>
                            {ui(
                              'AI 深度分析链路需要“视觉模型”（如 Qwen-VL / GPT-4o / Gemini）。若只装了图像生成模型（如 Wanx / Flux），分析会回退到本地启发式，出现“待确认/待补充”占位。',
                              'The AI deep analysis chain needs a vision model (Qwen-VL / GPT-4o / Gemini). If only an image generation model (Wanx / Flux) is activated, analysis falls back to local heuristics and shows "待确认/待补充" placeholders.',
                            )}
                          </li>
                        </ul>
                      </div>

                      <div className="rounded-2xl border border-dashed border-[#2b3440] bg-[#0e141c] p-4">
                        <button
                          type="button"
                          onClick={() => setOfficialCustomModelEnabled((value) => !value)}
                          className="inline-flex items-center gap-2 text-sm text-[#9fd4ff] transition hover:text-white"
                        >
                          <ChevronDown className={`h-4 w-4 transition ${officialCustomModelEnabled ? 'rotate-180' : ''}`} />
                          {ui('高级设置：手动覆盖模型标识', 'Advanced: override model id manually')}
                        </button>
                        {officialCustomModelEnabled ? (
                          <label className="mt-3 block space-y-2">
                            <span className="text-xs uppercase tracking-[0.16em] text-[#7f92a7]">{ui('模型标识', 'Model id')}</span>
                            <input
                              value={officialModel}
                              onChange={(event) => setOfficialModel(event.target.value)}
                              placeholder={selectedOfficialPreset?.model || 'model-id'}
                              className="w-full rounded-2xl border border-[#2b3440] bg-[#111821] px-4 py-3 text-sm text-white outline-none transition focus:border-[#5ba4ff]"
                            />
                          </label>
                        ) : null}

                        <button
                          type="button"
                          onClick={() => setOfficialCustomEndpointEnabled((value) => !value)}
                          className="mt-4 inline-flex items-center gap-2 text-sm text-[#9fd4ff] transition hover:text-white"
                        >
                          <ChevronDown className={`h-4 w-4 transition ${officialCustomEndpointEnabled ? 'rotate-180' : ''}`} />
                          {ui('高级设置：自定义官方 Base URL', 'Advanced: custom official Base URL')}
                        </button>
                        {officialCustomEndpointEnabled ? (
                          <label className="mt-3 block space-y-2">
                            <span className="text-xs uppercase tracking-[0.16em] text-[#7f92a7]">Base URL</span>
                            <input
                              value={officialEndpoint}
                              onChange={(event) => setOfficialEndpoint(event.target.value)}
                              placeholder={ui('可选，留空则使用平台默认地址', 'Optional. Leave empty to use the provider default endpoint.')}
                              className="w-full rounded-2xl border border-[#2b3440] bg-[#111821] px-4 py-3 text-sm text-white outline-none transition focus:border-[#5ba4ff]"
                            />
                            <div className="text-xs leading-6 text-[#8ea0b2]">
                              {ui(
                                '只有当官方平台文档明确要求自定义网关地址时才建议填写，避免和默认官方地址混淆。',
                                'Only fill this in when the official provider explicitly requires a custom gateway endpoint.',
                              )}
                            </div>
                          </label>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
              )}
            </div>

            <div className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
              <div className="rounded-[24px] border border-[#202934] bg-[#0f141b] p-5">
                <CollapseToggle
                  expanded={showDiagnostics}
                  onClick={() => setShowDiagnostics((value) => !value)}
                  title={ui('系统状态', 'System status')}
                  subtitle={ui('默认折叠，避免诊断信息和主要操作抢占注意力。', 'Collapsed by default so diagnostics do not compete with primary actions.')}
                />

                {showDiagnostics ? (
                  <div className="mt-4 grid gap-3 md:grid-cols-3">
                    <div className={`rounded-2xl border px-4 py-3 ${statusChip(Boolean(secureReady && !secureLoading))}`}>
                      <div className="text-[11px] uppercase tracking-[0.16em]">{ui('安全存储', 'Secure Store')}</div>
                      <div className="mt-2 text-sm font-medium">{secureReady ? ui('就绪', 'Ready') : ui('未就绪', 'Not ready')}</div>
                      <div className="mt-1 text-xs text-[#9fb0c3]">{secureError || ui('登录后会初始化安全 Key 存储。', 'Secure key storage is initialized after login.')}</div>
                    </div>
                    <div className={`rounded-2xl border px-4 py-3 ${statusChip(Boolean(backendRealApiEnabled))}`}>
                      <div className="text-[11px] uppercase tracking-[0.16em]">{ui('真实 API', 'Real API')}</div>
                      <div className="mt-2 text-sm font-medium">
                        {backendHealthLoading ? ui('检测中', 'Checking') : backendRealApiEnabled ? ui('已开启', 'Enabled') : ui('未开启', 'Disabled')}
                      </div>
                      <div className="mt-1 text-xs text-[#9fb0c3]">
                        {backendHealthError || (
                          backendDiagnostics
                            ? `${ui('API 端口', 'API port')}: ${backendDiagnostics.apiPort || '-'}`
                            : ui('后端暂未返回诊断信息。', 'No backend diagnostics were returned.')
                        )}
                      </div>
                    </div>
                    <div className={`rounded-2xl border px-4 py-3 ${statusChip(Boolean(runtime && !runtimeLoading))}`}>
                      <div className="text-[11px] uppercase tracking-[0.16em]">{ui('运行时', 'Runtime')}</div>
                      <div className="mt-2 text-sm font-medium">{runtimeLoading ? ui('加载中', 'Loading') : runtime ? ui('已同步', 'Synced') : ui('未同步', 'Not synced')}</div>
                      <div className="mt-1 text-xs text-[#9fb0c3]">
                        {runtimeError || ui('首推、备选和任务标签会从这里同步到画布。', 'Primary picks, alternates, and task tags sync from here to the canvas.')}
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="rounded-[24px] border border-[#202934] bg-[#0f141b] p-5">
                <CollapseToggle
                  expanded={showRecommendations}
                  onClick={() => setShowRecommendations((value) => !value)}
                  title={ui('推荐模型卡', 'Recommended model cards')}
                  subtitle={ui('默认折叠，避免推荐内容挤占主要操作区。', 'Collapsed by default so recommendation content does not crowd the primary workflow.')}
                />

                {showRecommendations ? (
                  <div className="mt-4">
                    <RecommendationCardsPanel
                      testId="api-runtime-recommendation-panel"
                      title={ui('任务优先推荐', 'Task-first recommendations')}
                      subtitle={ui('直接使用运行时的首推、备选和任务标签，减少用户手动猜模型。', 'Uses runtime primary picks, alternates, and task tags so users do not have to guess models manually.')}
                      cards={relayRecommendationCards}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          </main>

          <aside className="min-h-0 space-y-5 xl:max-h-[calc(100vh-136px)] xl:overflow-y-auto xl:pr-1">
            <div className="rounded-[24px] border border-[#202934] bg-[#0f141b] p-5">
              <CollapseToggle
                expanded={showActivatedCanvasModels}
                onClick={() => setShowActivatedCanvasModels((value) => !value)}
                title={ui('已激活模型列表', 'Activated model inventory')}
                subtitle={ui('按图片、视频、音频和文本分类展示，方便一眼确认哪些模型已经真正同步到画布。', 'Grouped by image, video, audio, and text so you can quickly confirm what is actually live on the canvas.')}
                badge={<SourceBadge label={`${activatedCanvasModels.length} ${ui('个模型', 'models')}`} tone="recommended" />}
                testId="api-activated-canvas-models-toggle"
              />

              {showActivatedCanvasModels ? (
                <div className="mt-4 max-h-[calc(100vh-260px)] space-y-4 overflow-y-auto pr-1" data-testid="api-activated-canvas-models-panel">
                  {(['image', 'video', 'audio', 'llm'] as Mode[]).map((entryMode) => {
                    const items = activatedCanvasModelsByMode[entryMode] || [];
                    const expanded = inventoryExpandedModes[entryMode];
                    return (
                      <section key={entryMode} className="rounded-2xl border border-[#25303b] bg-[#111821] p-4">
                        <button
                          type="button"
                          onClick={() => setInventoryExpandedModes((value) => ({ ...value, [entryMode]: !value[entryMode] }))}
                          className="flex w-full items-center justify-between gap-3 text-left"
                        >
                          <div className="text-sm font-semibold text-white">{formatModeLabel(entryMode, ui)}</div>
                          <div className="flex items-center gap-2">
                            <SourceBadge label={`${items.length} ${ui('个已激活', 'live')}`} tone={items.length ? 'recommended' : 'neutral'} />
                            <ChevronDown className={`h-4 w-4 text-[#8ea0b2] transition ${expanded ? 'rotate-180' : ''}`} />
                          </div>
                        </button>
                        {expanded ? (
                          <div className="mt-3 space-y-3">
                            {items.length ? items.map((item) => (
                              <article key={`${item.id}-${item.mode}`} className="rounded-xl border border-[#2a3340] bg-[#0e141b] px-3 py-3">
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="text-sm font-semibold text-white">{item.name}</div>
                                    <div className="mt-1 text-xs text-[#74d8ff]">{item.providerMeta?.name || item.provider}</div>
                                    <div className="mt-1 break-all text-[11px] text-[#91a4b6]">{item.activationModel || item.model || item.id}</div>
                                    {item.price !== undefined ? (
                                      <div className="mt-2 text-[11px] text-[#72e4d2]">{formatCurrency(item.price, item.currency)}</div>
                                    ) : null}
                                  </div>
                                  <div className="flex flex-wrap gap-2">
                                    <SourceBadge label={formatModeLabel(item.mode as Mode, ui)} tone="neutral" />
                                    {catalogSourceBadge(item)}
                                  </div>
                                </div>
                              </article>
                            )) : (
                              <div className="rounded-xl border border-dashed border-[#2a3440] bg-[#0e141b] px-3 py-3 text-sm text-[#93a4b4]">
                                {ui('这一类模型还没有激活。', 'No active models in this category yet.')}
                              </div>
                            )}
                          </div>
                        ) : null}
                      </section>
                    );
                  })}
                </div>
              ) : null}
            </div>

            <div className="rounded-[24px] border border-[#202934] bg-[#0f141b] p-5">
              <CollapseToggle
                expanded={showActivatedPlatforms}
                onClick={() => setShowActivatedPlatforms((value) => !value)}
                title={ui('已激活平台', 'Activated platforms')}
                subtitle={ui('折叠后保持页面清爽；需要排查来源时再展开。', 'Collapsed by default so the page stays clean; expand when you need to inspect platform sources.')}
                badge={<SourceBadge label={`${activatedPlatformCards.length} ${ui('个平台', 'platforms')}`} tone="recommended" />}
                testId="api-activated-platforms-toggle"
              />
              {showActivatedPlatforms ? (
                <div className="mt-4 grid gap-3" data-testid="api-activated-platforms-panel">
                  {activatedPlatformCards.length ? activatedPlatformCards.map((platform) => (
                    <article key={`${platform.providerId}-${platform.sourceLabel}`} className="rounded-2xl border border-[#25303b] bg-[#111821] px-4 py-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-white">{platform.providerLabel}</div>
                          <div className="mt-1 flex flex-wrap gap-2">
                            <SourceBadge label={platform.sourceLabel} tone={platform.sourceTone} />
                            {platform.modes.map((entryMode) => (
                              <SourceBadge key={`${platform.providerId}-${entryMode}`} label={formatModeLabel(entryMode, ui)} tone="neutral" />
                            ))}
                          </div>
                        </div>
                        <div className="text-right text-xs text-[#8ea0b2]">
                          <div>{platform.modelCount > 0 ? `${platform.modelCount} ${ui('个模型映射', 'model mappings')}` : ui('平台已接通', 'Platform connected')}</div>
                          {platform.endpoint ? (
                            <div className="mt-1 max-w-[220px] truncate text-[#6f8193]" title={platform.endpoint}>{platform.endpoint}</div>
                          ) : null}
                        </div>
                      </div>
                    </article>
                  )) : (
                    <div className="rounded-2xl border border-dashed border-[#2a3440] bg-[#111821] px-4 py-5 text-sm text-[#93a4b4]">
                      {ui('当前还没有已激活平台。先在中转聚合或官方直连区完成激活，这里会立即显示平台来源和模式覆盖。', 'No active platforms yet. Once relay or official direct activation completes, this area will immediately show the platform source and mode coverage.')}
                    </div>
                  )}
                </div>
              ) : null}
            </div>

            <div className="rounded-[24px] border border-[#202934] bg-[#0f141b] p-5">
              <CollapseToggle
                expanded={showActiveKeys}
                onClick={() => setShowActiveKeys((value) => !value)}
                title={ui('当前激活 Key', 'Active keys')}
                subtitle={ui('默认折叠，减少干扰；展开后可查看当前激活的平台、模式、模型和激活时间。', 'Collapsed by default to reduce clutter. Expand to inspect active provider, mode, model, and activation time.')}
                badge={<SourceBadge label={`${keyList.length} ${ui('项', 'items')}`} tone="neutral" />}
              />

              {showActiveKeys ? (
                <div className="mt-4 space-y-3">
                  {keyList.length ? keyList.map((item) => (
                    <article key={`${item.provider}-${item.mode}-${item.activatedAt}`} className="rounded-2xl border border-[#25303b] bg-[#111821] px-4 py-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-white">{item.provider}</div>
                          <div className="mt-1 text-xs text-[#8ea0b2]">
                            {[formatModeLabel(item.mode as Mode, ui), item.model || '-', item.maskedKey].filter(Boolean).join(' 路 ')}
                          </div>
                          <div className="mt-1 text-xs text-[#6f8193]">
                            {ui('激活时间', 'Activated at')}: {new Date(item.activatedAt).toLocaleString()}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <SourceBadge label={item.status} tone={item.status === 'active' ? 'recommended' : 'neutral'} />
                          <button
                            type="button"
                            onClick={() => { void handleRemoveKey(item.provider, item.mode as Mode); }}
                            className="inline-flex items-center gap-1 rounded-full border border-[#43303a] px-3 py-1.5 text-xs text-[#ffb5c4] transition hover:border-[#9d5167] hover:text-white"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            {ui('移除', 'Remove')}
                          </button>
                        </div>
                      </div>
                    </article>
                  )) : (
                    <div className="rounded-2xl border border-dashed border-[#2a3440] bg-[#111821] px-4 py-5 text-sm text-[#93a4b4]">
                      {runtimeActivatedProviderCount > 0
                        ? ui(
                            '当前登录账号的本地 Key 还没有写入，但右侧“已激活平台 / 已激活模型”已经检测到后端可用来源。若要在这个账号下继续管理 Key，请重新执行一次验证激活。',
                            'This signed-in account has not stored local keys yet, but the activated platform/model panels on the right already detected live backend sources. Run one activation again here if you want this account to manage those keys directly.',
                          )
                        : ui('当前还没有激活 Key。建议先从中转聚合开始，一次同步主流模型。', 'No active keys yet. Start with relay mode to sync mainstream models in one step.')}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </aside>
        </section>
      </div>
    </div>
  );

  return layout;
}
