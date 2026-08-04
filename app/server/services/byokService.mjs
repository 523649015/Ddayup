// BYOK 服务模块（激活记录/Relay 发现/运行时推荐/校验），从 hmdao-api.mjs 迁移（原 13510..15133 行）
// 工厂模式：外部项目级依赖经 deps 注入；import 来源符号本地 re-import；内部互引保持闭包。
import { promises as fs, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { getArkEndpointInfo } from '../providers/ark.mjs';
import { normalizeCatalogIdentifier, inferMode, inferNodeTypesFromMode } from '../lib/catalog-utils.mjs';

export function createByokService(deps = {}) {
  const {
    catalogModelByIdentifier,
    catalogLifecycleFor,
    ACTIVATED_PROVIDERS_FILE,
    activatedProviders,
    DATA_DIR,
    providers,
    MODEL_CATALOG,
    extractFirstString,
    escapePowerShellSingleQuoted,
    pickActivatedCloudImageAnalysisRuntime,
  } = deps;
  // 内化状态（原主文件顶层 let，仅本集群使用）
  let activatedProvidersHydrated = false;

function maskKey(apiKey = '') {
  if (apiKey.length <= 8) return '****';
  return `${apiKey.slice(0, 4)}****${apiKey.slice(-4)}`;
}

function relayAliasCatalogId(identifier) {
  const source = String(identifier || '').trim();
  if (!source) return '';
  const matched = RELAY_MODEL_MATCHERS.find((matcher) => matcher.aliases.some((pattern) => pattern.test(source)));
  return String(matched?.catalogId || '').trim();
}

function modelMatchesActivation(record, item) {
  if (!record || !item) return false;
  if (record.mode && record.mode !== item.mode) return false;

  const explicitModels = [
    ...(Array.isArray(record.catalogModelIds) ? record.catalogModelIds : []),
    ...(Array.isArray(record.availableModels)
      ? record.availableModels.flatMap((entry) => [entry?.catalogModelId, entry?.upstreamModel, entry?.id])
      : []),
  ]
    .map((value) => normalizeCatalogIdentifier(value))
    .filter(Boolean);
  if (explicitModels.length) {
    const candidateIds = [item.id, item.upstreamModel, item.model, item.name]
      .map((value) => normalizeCatalogIdentifier(value))
      .filter(Boolean);
    if (candidateIds.some((candidate) => explicitModels.includes(candidate))) return true;
  }

  const requestedModel = normalizeCatalogIdentifier(record.model);
  if (!requestedModel) return true;

  const aliasCatalogId = normalizeCatalogIdentifier(relayAliasCatalogId(record.model));
  const candidateIds = [
    item.id,
    item.upstreamModel,
    item.model,
    item.name,
    aliasCatalogId,
  ]
    .map((value) => normalizeCatalogIdentifier(value))
    .filter(Boolean);
  return candidateIds.includes(requestedModel);
}

function resolveActivatedRelayModel(record, requestedModel = '') {
  const requested = String(requestedModel || '').trim();
  if (!record || !requested) return requested;
  const availableModels = Array.isArray(record.availableModels) ? record.availableModels : [];
  const normalizedRequested = normalizeCatalogIdentifier(requested);
  const normalizedRequestedAlias = normalizeCatalogIdentifier(relayAliasCatalogId(requested));
  const matchScore = (entry = {}) => {
    const upstreamModel = normalizeCatalogIdentifier(entry?.upstreamModel || '');
    const rawId = normalizeCatalogIdentifier(entry?.id || '');
    const rawName = normalizeCatalogIdentifier(entry?.name || '');
    const catalogModelId = normalizeCatalogIdentifier(entry?.catalogModelId || '');
    if (normalizedRequested && [upstreamModel, rawId, rawName].includes(normalizedRequested)) return 4;
    if (normalizedRequestedAlias && [upstreamModel, rawId, rawName].includes(normalizedRequestedAlias)) return 3;
    if (normalizedRequested && catalogModelId === normalizedRequested) return 2;
    if (normalizedRequestedAlias && catalogModelId === normalizedRequestedAlias) return 1;
    return 0;
  };
  const matched = availableModels
    .map((entry) => ({ entry, score: matchScore(entry) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)[0]?.entry || null;
  if (matched) {
    // suanliai.top 的 seedance 有多个分辨率变体。优先选 720p。
    const matchedId = String(matched.upstreamModel || matched.id || '').trim();
    if (/suanliai\.top/i.test(record.endpoint || '') && /seedance/i.test(matchedId)) {
      const preferred = availableModels.find((m) => (m?.id || '').includes('-720p'));
      if (preferred?.id) return String(preferred.id).trim();
    }
    return matchedId;
  }
  const requestedCatalogModel = catalogModelByIdentifier(requested);
  if (
    requestedCatalogModel
    && (!record.provider || requestedCatalogModel.provider === record.provider)
    && (!record.mode || requestedCatalogModel.mode === record.mode)
  ) {
    const upstream = String(requestedCatalogModel.upstreamModel || requestedCatalogModel.id || requested).trim();
    // suanliai.top 的 seedance 有多个分辨率变体（720p/480p/1080p）。
    // 如果用户指定了 resolution=720p，优先匹配对应分辨率的 relay 模型变体。
    const availableModels = Array.isArray(record.availableModels) ? record.availableModels : [];
    if (availableModels.length > 0 && /suanliai\.top/i.test(record.endpoint || '') && /seedance/i.test(upstream)) {
      const preferredModelId = availableModels.find((m) => m?.id?.includes('-720p'))?.id;
      if (preferredModelId) return preferredModelId;
    }
    return upstream;
  }
  return String(record.model || requested).trim();
}

function providerActivationKey(providerId, mode = '') {
  return mode ? `${providerId}::${mode}` : providerId;
}

// 视觉/多模态模型识别：用于图片分析链路优先选择真正具备视觉理解能力的模型，
// 避免把图像/视频生成模型（如 wanx / flux / gpt-image / seedance）误当作视觉分析模型调用。
const VISION_MODEL_PATTERNS = [
  /qwen[-\w]*vl/i,
  /qwen2\.5-vl/i,
  /qwen3[-\w]*vl/i,
  /qwen[-]?omni/i,
  /qwen[-]?vl[-]?max/i,     // qwen-vl-max (百炼)
  /gpt-4[o1]/i,
  /gpt-4\.1/i,
  /gemini[-\w]*flash/i,
  /gemini[-\w]*pro/i,
  /gemini[-\w]*3/i,          // Gemini 3 / 3.1 / 3-flash / 3-pro 等全系列
  /claude/i,
  /llava/i,
  /moondream/i,
  /minicpm-v/i,
  /phi-?3[-\w]*vision/i,
  /glm-?4v/i,                // GLM-4V / GLM-4V-Plus (智谱)
  /glm[-\w.]*v[-\w.]*plus/i, // GLM-4V-Plus / GLM-4.5V-Plus 等
  /glm[-\w.]*v/i,            // GLM 系列视觉模型（glm-4.5v / glm-v 等）
  /internvl[-\w]*3/i,        // InternVL3 系列 (硅基流动/ModelScope)
  /deepseek-vl/i,
  /doubao[-\w.]*vision/i,    // 豆包视觉 Pro / doubao-1.5-vision 等 (火山方舟)
  /hunyuan[-\w.]*vision/i,   // 腾讯 Hunyuan-Vision
  /abab.*v/i,
  /qwen3[-\w\.]*/i,         // qwen3.7-plus, qwen3.7-vl 等最新系列
  /qwen[-\w]*plus/i,        // qwen-plus, qwen3.7-plus 等
  /qwen[-\w]*max/i,         // qwen-max, qwen-vl-max 等
  /kimi[-]?vl/i,            // 月之暗面 Kimi-VL / Kimi-VL-A3B
  /step[-\w]*vision/i,      // 阶跃星辰 Step-Vision
  /step-?1[\w.]*v/i,        // 阶跃星辰 step-1v / step-1.5v
  /ernie[-\w.]*vl/i,        // 百度 ERNIE-VL / ERNIE-4.5-VL
  /cogvlm/i,                // 智谱 CogVLM
  /cogagent/i,              // 智谱 CogAgent
];

function isVisionModelId(modelId) {
  const value = String(modelId || '').trim();
  if (!value) return false;
  // 显式排除纯图像/视频生成模型，避免误判为视觉分析模型
  if (/(wanx|flux|wan2|stable-diffusion|sd3|sdxl|midjourney|\bdalle\b|gpt-image|seedance|kling|veo|runway|hunyuan-video|wan21|wan22|imagen|dall-e)/i.test(value)) return false;
  return VISION_MODEL_PATTERNS.some((pattern) => pattern.test(value));
}


function hydrateActivatedProviderRecordsFromDisk(force = false) {
  if (activatedProvidersHydrated && !force) return;
  activatedProvidersHydrated = true;
  try {
    if (!existsSync(ACTIVATED_PROVIDERS_FILE)) return;
    const raw = readFileSync(ACTIVATED_PROVIDERS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const records = Array.isArray(parsed) ? parsed : [];
    activatedProviders.clear();
    for (const record of records) {
      if (!record || typeof record !== 'object') continue;
      const provider = String(record.provider || '').trim();
      const mode = String(record.mode || '').trim();
      if (!provider) continue;
      activatedProviders.set(providerActivationKey(provider, mode), {
        ...record,
        provider,
        mode,
      });
    }
  } catch {
    // ignore broken activation cache and rebuild from fresh runtime state
  }
}

function persistActivatedProviderRecordsToDisk() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(
      ACTIVATED_PROVIDERS_FILE,
      JSON.stringify(Array.from(activatedProviders.values()), null, 2),
      'utf8',
    );
  } catch {
    // best-effort persistence only
  }
}

function listActivatedProviderRecords() {
  hydrateActivatedProviderRecordsFromDisk();
  const records = new Map();
  for (const [key, value] of activatedProviders.entries()) {
    if (!value?.provider) continue;
    const recordKey = providerActivationKey(value.provider, value.mode || '');
    if (!records.has(recordKey) || key === recordKey) {
      records.set(recordKey, value);
    }
  }
  return Array.from(records.values());
}

function publicActivatedProviderRecord(record) {
  if (!record || typeof record !== 'object') return null;
  return {
    ...record,
    apiKey: undefined,
  };
}

function publicImageAnalysisRuntime(runtime) {
  if (!runtime || typeof runtime !== 'object') return null;
  return {
    ...runtime,
    apiKey: undefined,
  };
}

function providerLabelFor(providerId) {
  return providers.find((provider) => provider.id === providerId)?.name || providerId;
}

function buildFallbackRuntimeCandidate(record) {
  if (!record || typeof record !== 'object') return null;
  const catalogModel = catalogModelByIdentifier(String(record.model || '').trim());
  const mode = String(record.mode || catalogModel?.mode || 'llm').trim().toLowerCase();
  if (!['llm', 'image', 'video', 'audio'].includes(mode)) return null;
  return {
    id: String(catalogModel?.id || record.model || `${record.provider}-${mode}`).trim(),
    provider: String(record.provider || '').trim(),
    providerLabel: providerLabelFor(String(record.provider || '').trim()),
    mode,
    model: String(record.model || catalogModel?.upstreamModel || catalogModel?.id || '').trim(),
    title: String(catalogModel?.name || record.model || 'Untitled model').trim(),
    description: String(catalogModel?.description || '').trim() || null,
    relaySource: String(record.relaySource || '').trim() || null,
    price: Number.isFinite(Number(record.primaryPrice)) ? Number(record.primaryPrice) : (Number.isFinite(Number(catalogModel?.price)) ? Number(catalogModel.price) : null),
    currency: String(record.primaryCurrency || catalogModel?.currency || '').trim() || null,
    priceUnit: null,
    pricingSummary: null,
    recommendation: null,
    recommendationScore: Number(record.relaySource ? 65 : 52),
    activatedAt: Number(record.activatedAt || 0),
    supportedOnCanvas: Boolean(catalogModel),
  };
}

function flattenActivatedRuntimeCandidates() {
  return listActivatedProviderRecords()
    .flatMap((record) => {
      const availableModels = Array.isArray(record?.availableModels) ? record.availableModels : [];
      if (availableModels.length === 0) {
        const fallback = buildFallbackRuntimeCandidate(record);
        return fallback ? [fallback] : [];
      }
      return availableModels.map((entry) => {
        const catalogModel = catalogModelByIdentifier(String(entry?.catalogModelId || entry?.upstreamModel || entry?.id || '').trim());
        const mode = String(entry?.mode || record?.mode || catalogModel?.mode || '').trim().toLowerCase();
        return {
          id: String(entry?.id || catalogModel?.id || '').trim(),
          provider: String(record?.provider || '').trim(),
          providerLabel: providerLabelFor(String(record?.provider || '').trim()),
          mode,
          model: String(entry?.upstreamModel || catalogModel?.upstreamModel || entry?.id || '').trim(),
          title: String(entry?.name || catalogModel?.name || entry?.upstreamModel || entry?.id || 'Untitled model').trim(),
          description: String(catalogModel?.description || '').trim() || null,
          relaySource: String(record?.relaySource || '').trim() || null,
          price: Number.isFinite(Number(entry?.price)) ? Number(entry.price) : null,
          currency: String(entry?.currency || '').trim() || null,
          priceUnit: String(entry?.priceUnit || '').trim() || null,
          pricingSummary: String(entry?.pricingSummary || '').trim() || null,
          recommendation: String(entry?.recommendation || '').trim() || null,
          recommendationScore: Number.isFinite(Number(entry?.recommendationScore)) ? Number(entry.recommendationScore) : 0,
          activatedAt: Number(record?.activatedAt || 0),
          supportedOnCanvas: Boolean(catalogModel),
          catalogModelId: String(entry?.catalogModelId || catalogModel?.id || '').trim() || null,
        };
      });
    })
    .filter((item) => item && ['llm', 'image', 'video', 'audio'].includes(String(item.mode || '').trim()));
}

function sortRuntimeCandidates(candidates = [], preferredModels = []) {
  const normalizedPreferred = new Set(preferredModels.map((value) => normalizeCatalogIdentifier(value)).filter(Boolean));
  return candidates.slice().sort((left, right) => {
    const leftPreferred = normalizedPreferred.has(normalizeCatalogIdentifier(left?.id))
      || normalizedPreferred.has(normalizeCatalogIdentifier(left?.model))
      || normalizedPreferred.has(normalizeCatalogIdentifier(left?.catalogModelId));
    const rightPreferred = normalizedPreferred.has(normalizeCatalogIdentifier(right?.id))
      || normalizedPreferred.has(normalizeCatalogIdentifier(right?.model))
      || normalizedPreferred.has(normalizeCatalogIdentifier(right?.catalogModelId));
    if (leftPreferred !== rightPreferred) return rightPreferred ? 1 : -1;
    const recommendedDelta = Number(right?.recommendationScore || 0) - Number(left?.recommendationScore || 0);
    if (recommendedDelta !== 0) return recommendedDelta;
    const canvasDelta = Number(Boolean(right?.supportedOnCanvas)) - Number(Boolean(left?.supportedOnCanvas));
    if (canvasDelta !== 0) return canvasDelta;
    const relayDelta = Number(Boolean(right?.relaySource)) - Number(Boolean(left?.relaySource));
    if (relayDelta !== 0) return relayDelta;
    return Number(right?.activatedAt || 0) - Number(left?.activatedAt || 0);
  });
}

function publicRuntimeRecommendationCandidate(candidate) {
  if (!candidate) return null;
  return {
    id: String(candidate.id || '').trim(),
    provider: String(candidate.provider || '').trim(),
    providerLabel: String(candidate.providerLabel || '').trim() || providerLabelFor(String(candidate.provider || '').trim()),
    mode: String(candidate.mode || 'llm').trim(),
    model: String(candidate.model || '').trim(),
    title: String(candidate.title || candidate.model || candidate.id || '').trim(),
    description: String(candidate.description || '').trim() || null,
    relaySource: String(candidate.relaySource || '').trim() || null,
    price: Number.isFinite(Number(candidate.price)) ? Number(candidate.price) : null,
    currency: String(candidate.currency || '').trim() || null,
    priceUnit: String(candidate.priceUnit || '').trim() || null,
    pricingSummary: String(candidate.pricingSummary || '').trim() || null,
    recommendation: String(candidate.recommendation || '').trim() || null,
    recommendationScore: Number.isFinite(Number(candidate.recommendationScore)) ? Number(candidate.recommendationScore) : null,
  };
}

function buildRuntimeRecommendationSummary(key, candidate, options = {}) {
  if (!candidate) return null;
  const candidates = Array.isArray(options.candidates)
    ? options.candidates.map((item) => publicRuntimeRecommendationCandidate(item)).filter(Boolean)
    : [];
  const primary = publicRuntimeRecommendationCandidate(candidate);
  return {
    key,
    title: String(options.title || '').trim(),
    summary: String(options.summary || candidate.recommendation || '').trim(),
    provider: String(candidate.provider || '').trim(),
    providerLabel: String(candidate.providerLabel || '').trim() || providerLabelFor(String(candidate.provider || '').trim()),
    mode: String(candidate.mode || 'llm').trim(),
    model: String(candidate.model || '').trim(),
    relaySource: String(candidate.relaySource || '').trim() || null,
    price: Number.isFinite(Number(candidate.price)) ? Number(candidate.price) : null,
    currency: String(candidate.currency || '').trim() || null,
    priceUnit: String(candidate.priceUnit || '').trim() || null,
    pricingSummary: String(candidate.pricingSummary || '').trim() || null,
    recommendation: String(candidate.recommendation || '').trim() || null,
    tags: Array.isArray(options.tags) ? options.tags.map((item) => String(item || '').trim()).filter(Boolean) : [],
    primary,
    alternates: candidates.filter((item) => item.id !== primary?.id || item.model !== primary?.model).slice(0, 2),
    candidates,
    tasks: Array.isArray(options.tasks) ? options.tasks.filter(Boolean) : [],
  };
}

function buildRuntimeTaskRecommendation(id, options = {}) {
  const candidates = Array.isArray(options.candidates)
    ? options.candidates.map((item) => publicRuntimeRecommendationCandidate(item)).filter(Boolean)
    : [];
  const primary = candidates[0] || null;
  if (!primary) return null;
  return {
    id: String(id || '').trim(),
    title: String(options.title || '').trim(),
    summary: String(options.summary || primary.recommendation || '').trim(),
    tags: Array.isArray(options.tags) ? options.tags.map((item) => String(item || '').trim()).filter(Boolean) : [],
    primary,
    alternates: candidates.slice(1, 3),
    candidates,
  };
}

function buildRuntimeRecommendations() {
  const allCandidates = flattenActivatedRuntimeCandidates();
  const imageCandidates = allCandidates.filter((item) => item.mode === 'image');
  const videoCandidates = allCandidates.filter((item) => item.mode === 'video');
  const audioCandidates = allCandidates.filter((item) => item.mode === 'audio');
  const analysisCandidates = allCandidates.filter((item) => item.mode === 'llm' || item.mode === 'image');

  const imageGenerationCandidates = sortRuntimeCandidates(imageCandidates, ['flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'grok-imagine-1.5-edit-apimart', 'Qwen/Qwen-Image', 'lib-image']);
  const videoGenerationCandidates = sortRuntimeCandidates(videoCandidates, ['kling-o3', 'happyhorse-11', 'doubao-seedance-2-0', 'seedance-v2', 'wan22-i2v-a14b', 'wan22-t2v-a14b']);
  const audioGenerationCandidates = sortRuntimeCandidates(audioCandidates, ['qwen3-tts-instruct', 'minimax-speech-28', 'suno_music', 'doubao-audio-1-0']);

  const imageAnalysisRuntime = publicImageAnalysisRuntime(pickActivatedCloudImageAnalysisRuntime());
  const matchedAnalysisCandidate = imageAnalysisRuntime
    ? sortRuntimeCandidates(
      analysisCandidates.filter((item) => (
        String(item.provider || '').trim() === String(imageAnalysisRuntime.provider || '').trim()
        || normalizeCatalogIdentifier(item.model) === normalizeCatalogIdentifier(imageAnalysisRuntime.model)
        || normalizeCatalogIdentifier(item.id) === normalizeCatalogIdentifier(imageAnalysisRuntime.model)
      )),
      [String(imageAnalysisRuntime.model || '')],
    )[0] || null
    : null;
  const analysisFallbackCandidate = imageAnalysisRuntime
    ? {
        id: String(imageAnalysisRuntime.model || 'analysis-runtime').trim(),
        provider: String(imageAnalysisRuntime.provider || '').trim(),
        providerLabel: providerLabelFor(String(imageAnalysisRuntime.provider || '').trim()),
        mode: String(imageAnalysisRuntime.mode || 'llm').trim(),
        model: String(imageAnalysisRuntime.model || '').trim(),
        title: String(imageAnalysisRuntime.model || 'Cloud runtime model').trim(),
        description: null,
        relaySource: null,
        price: null,
        currency: null,
        priceUnit: null,
        pricingSummary: null,
        recommendation: '已激活的云端多模态运行时，可直接用于图片解析与视频语义理解',
        recommendationScore: 88,
        activatedAt: 0,
        supportedOnCanvas: false,
      }
    : null;
  const analysisPrimary = matchedAnalysisCandidate || analysisFallbackCandidate;
  const analysisTopCandidates = sortRuntimeCandidates(
    analysisCandidates,
    [String(imageAnalysisRuntime?.model || ''), 'qwen35-vl', 'florence2', 'clip-interrogator'],
  ).slice(0, 3);
  const imageSubjectReplaceCandidates = sortRuntimeCandidates(
    imageCandidates,
    ['flux-pro', 'gpt-image-2', 'grok-imagine-1.5-edit-apimart', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'Qwen/Qwen-Image', 'lib-image'],
  ).slice(0, 3);
  const imageOmniCandidates = sortRuntimeCandidates(
    imageCandidates,
    ['flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'Qwen/Qwen-Image', 'lib-image'],
  ).slice(0, 3);
  const imageMultiReferenceCandidates = sortRuntimeCandidates(
    imageCandidates,
    ['doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'flux-pro', 'gpt-image-2', 'Qwen/Qwen-Image', 'lib-image'],
  ).slice(0, 3);
  const imageStyleCandidates = sortRuntimeCandidates(
    imageCandidates,
    ['flux-pro', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'gpt-image-2', 'Qwen/Qwen-Image', 'lib-image'],
  ).slice(0, 3);
  const imagePromptInterrogationCandidates = sortRuntimeCandidates(
    analysisCandidates,
    [String(imageAnalysisRuntime?.model || ''), 'clip-interrogator', 'florence2', 'qwen35-vl'],
  ).slice(0, 3);
  const imageCompositionAnalysisCandidates = sortRuntimeCandidates(
    analysisCandidates,
    [String(imageAnalysisRuntime?.model || ''), 'qwen35-vl', 'florence2', 'clip-interrogator'],
  ).slice(0, 3);
  const videoSubjectReplaceCandidates = sortRuntimeCandidates(
    videoCandidates,
    ['kling-o3', 'happyhorse-11', 'seedance-v2', 'wan22-i2v-a14b', 'wan22-t2v-a14b'],
  ).slice(0, 3);
  const videoOmniKeepMotionCandidates = sortRuntimeCandidates(
    videoCandidates,
    ['kling-o3', 'happyhorse-11', 'seedance-v2', 'wan22-i2v-a14b', 'wan22-t2v-a14b'],
  ).slice(0, 3);
  const videoMotionStyleCandidates = sortRuntimeCandidates(
    videoCandidates,
    ['kling-o3', 'seedance-v2', 'happyhorse-11', 'wan22-i2v-a14b', 'wan22-t2v-a14b'],
  ).slice(0, 3);
  const videoImageToVideoCandidates = sortRuntimeCandidates(
    videoCandidates,
    ['kling-o3', 'happyhorse-11', 'seedance-v2', 'wan22-i2v-a14b', 'wan22-t2v-a14b'],
  ).slice(0, 3);
  const videoSemanticParseCandidates = sortRuntimeCandidates(
    analysisCandidates,
    [String(imageAnalysisRuntime?.model || ''), 'qwen35-vl', 'internvideo', 'video-llava'],
  ).slice(0, 3);
  const videoShotBreakdownCandidates = sortRuntimeCandidates(
    analysisCandidates,
    [String(imageAnalysisRuntime?.model || ''), 'qwen35-vl', 'video-llava', 'internvideo'],
  ).slice(0, 3);
  const audioBgmCandidates = sortRuntimeCandidates(audioCandidates, ['suno_music']).slice(0, 3);
  const audioSfxCandidates = sortRuntimeCandidates(audioCandidates, ['suno_music']).slice(0, 3);
  const audioVoiceCandidates = sortRuntimeCandidates(audioCandidates, ['suno_music']).slice(0, 3);

  return {
    imageGeneration: buildRuntimeRecommendationSummary('imageGeneration', imageGenerationCandidates[0], {
      title: '图片节点首推模型',
      summary: '优先用于主素材+ 参考素材的图片生成、编辑与保构图换主体',
      tags: ['图片生成', '主素材', '参考素材'],
      candidates: imageGenerationCandidates.slice(0, 3),
      tasks: [
        buildRuntimeTaskRecommendation('subjectReplaceKeepComposition', {
          title: '保构图换主体',
          summary: '保持主素材的机位、构图与画面布局，优先替换主体到参考素材目标',
          tags: ['composition', 'subject', '主体替换', '保构图'],
          candidates: imageSubjectReplaceCandidates,
        }),
        buildRuntimeTaskRecommendation('omniReference', {
          title: '全能参考融合',
          summary: '同时吸收主体、材质、风格与氛围信息，更适合多条件强约束出图',
          tags: ['omni', '多模态', '强条件'],
          candidates: imageOmniCandidates,
        }),
        buildRuntimeTaskRecommendation('multiReferenceBlend', {
          title: '多参考融合',
          summary: '多张参考图混合时优先保持主体和风格的平衡，减少参考互相打架',
          tags: ['multi-reference', 'blend', '风格融合'],
          candidates: imageMultiReferenceCandidates,
        }),
        buildRuntimeTaskRecommendation('styleReference', {
          title: '风格参考增强',
          summary: '更偏向风格、光影和质感迁移，适合单参考快速增强',
          tags: ['style', 'lighting', 'texture'],
          candidates: imageStyleCandidates,
        }),
      ],
    }),
    imageAnalysis: buildRuntimeRecommendationSummary('imageAnalysis', analysisPrimary, {
      title: '图片解析首推模型',
      summary: '优先用于图片解析、反推提示词、风格光影和主体构图理解',
      tags: ['图片解析', '提示词反推'],
      candidates: analysisTopCandidates,
      tasks: [
        buildRuntimeTaskRecommendation('promptInterrogation', {
          title: '提示词反推',
          summary: '优先提取主体、风格、镜头、光影和氛围词，适合写回图片与视频节点参数区',
          tags: ['prompt', 'style', 'lighting'],
          candidates: imagePromptInterrogationCandidates,
        }),
        buildRuntimeTaskRecommendation('subjectLightingComposition', {
          title: '主体 / 光影 / 构图理解',
          summary: '更适合拆解主素材构图、主体层级和画面光影，辅助保构图换主体',
          tags: ['composition', 'subject', 'lighting'],
          candidates: imageCompositionAnalysisCandidates,
        }),
      ],
    }),
    videoGeneration: buildRuntimeRecommendationSummary('videoGeneration', videoGenerationCandidates[0], {
      title: '视频节点首推模型',
      summary: '优先用于视频生成、多模态参考、全能参考和保运镜换主体',
      tags: ['视频生成', '多模态参考'],
      candidates: videoGenerationCandidates.slice(0, 3),
      tasks: [
        buildRuntimeTaskRecommendation('subjectReplaceKeepMotion', {
          title: '保运镜换主体',
          summary: '锁定主视频的运镜、节奏和镜头结构，优先替换为参考主体',
          tags: ['motion', 'subject', 'video-edit'],
          candidates: videoSubjectReplaceCandidates,
        }),
        buildRuntimeTaskRecommendation('omniReferenceKeepMotion', {
          title: '主视频锁定+ 全能参数',
          summary: '在保留主视频镜头调度的同时融合主体、风格和场景参考',
          tags: ['motion', 'omni', 'all-in-one'],
          candidates: videoOmniKeepMotionCandidates,
        }),
        buildRuntimeTaskRecommendation('motionStyleBlend', {
          title: '运镜与风格融合',
          summary: '强调视频运动轨迹与视觉风格的同步迁移，适合广告或 MV 类镜头',
          tags: ['motion', 'style', 'blend'],
          candidates: videoMotionStyleCandidates,
        }),
        buildRuntimeTaskRecommendation('subjectReferenceImageToVideo', {
          title: '主体参考图生视频',
          summary: '以主体参考图为核心驱动视频生成，兼顾动作连贯和造型一致',
          tags: ['image-to-video', 'subject', 'consistency'],
          candidates: videoImageToVideoCandidates,
        }),
        buildRuntimeTaskRecommendation('omniReferenceVideoGeneration', {
          title: '全能参考视频生成',
          summary: '适合从多张参考中统一生成视频结果，兼顾主体、风格和镜头意图',
          tags: ['omni', 'video-generation', 'multi-reference'],
          candidates: videoOmniKeepMotionCandidates,
        }),
        buildRuntimeTaskRecommendation('referenceDrivenVideoGeneration', {
          title: '参考驱动视频生成',
          summary: '当参考约束较弱时优先保证视频可生成性，再逐步叠加主体和风格控制',
          tags: ['reference', 'fallback', 'robust'],
          candidates: videoGenerationCandidates.slice(0, 3),
        }),
      ],
    }),
    videoAnalysis: buildRuntimeRecommendationSummary('videoAnalysis', analysisPrimary, {
      title: '视频解析首推模型',
      summary: '优先用于关键帧语义解析、镜头语言整理和视频提示词反推',
      tags: ['视频解析', '语义理解'],
      candidates: analysisTopCandidates,
      tasks: [
        buildRuntimeTaskRecommendation('semanticParse', {
          title: '视频语义解析',
          summary: '优先理解镜头内容、时序语义和场景变化，适合驱动全能参考与视频解析',
          tags: ['semantic', 'timeline', 'scene'],
          candidates: videoSemanticParseCandidates,
        }),
        buildRuntimeTaskRecommendation('promptInterrogation', {
          title: '视频提示词反推',
          summary: '适合从关键帧和时序摘要中整理出可写回节点的提示词、风格和运动描述',
          tags: ['prompt', 'style', 'motion'],
          candidates: videoSemanticParseCandidates,
        }),
        buildRuntimeTaskRecommendation('shotBreakdown', {
          title: '分镜 / 运镜拆解',
          summary: '更适合提取镜头节奏、运镜方向和镜头切换结构，辅助保运镜换主体',
          tags: ['shot', 'camera', 'motion'],
          candidates: videoShotBreakdownCandidates,
        }),
      ],
    }),
    audioGeneration: buildRuntimeRecommendationSummary('audioGeneration', audioGenerationCandidates[0], {
      title: '音频节点首推模型',
      summary: '优先用于后续远程 BGM、音效和旁白生成链路',
      tags: ['音频生成'],
      candidates: audioGenerationCandidates.slice(0, 3),
      tasks: [
        buildRuntimeTaskRecommendation('bgm', {
          title: 'BGM 生成',
          summary: '适合氛围配乐、节奏铺底和音乐片段草图生成',
          tags: ['bgm', 'music'],
          candidates: audioBgmCandidates,
        }),
        buildRuntimeTaskRecommendation('sfx', {
          title: '音效生成',
          summary: '适合短音效、环境声与事件音频生成',
          tags: ['sfx', 'foley'],
          candidates: audioSfxCandidates,
        }),
        buildRuntimeTaskRecommendation('voiceover', {
          title: '旁白生成',
          summary: '适合后续真人感旁白、口播和语气化语音链路',
          tags: ['voice', 'narration'],
          candidates: audioVoiceCandidates,
        }),
      ],
    }),
  };
}

function getActivatedProviderRecord(providerId, mode = '') {
  hydrateActivatedProviderRecordsFromDisk();
  if (mode) {
    const exact = activatedProviders.get(providerActivationKey(providerId, mode));
    if (exact) return exact;
  }
  const legacy = activatedProviders.get(providerId);
  if (legacy && (!mode || legacy.mode === mode)) return legacy;
  const modeMatch = listActivatedProviderRecords().find((record) => (
    record.provider === providerId && (!mode || record.mode === mode)
  ));
  if (modeMatch) return modeMatch;
  // 跨模式兜底：聚合平台（如火山方舟 Ark）的 key/endpoint 在文本/图像/视频间通用，
  // 激活任意模式即可驱动其 LLM 聚合模型。
  if (mode) {
    const anyMode = listActivatedProviderRecords().find((record) => record.provider === providerId);
    if (anyMode) return anyMode;
  }
  return null;
}

function setActivatedProviderRecord(providerId, mode, record) {
  hydrateActivatedProviderRecordsFromDisk();
  activatedProviders.set(providerActivationKey(providerId, mode), {
    ...record,
    provider: providerId,
    mode,
  });
  persistActivatedProviderRecordsToDisk();
}

function isRealApiProxyEnabled() {
  if (process.env.HMDAO_REAL_API === '1') return true;
  hydrateActivatedProviderRecordsFromDisk();
  if (String(process.env.HMDAO_LITELLM_API_KEY || '').trim()) return true;
  for (const record of activatedProviders.values()) {
    if (String(record?.apiKey || '').trim()) return true;
  }
  return false;
}

function deleteActivatedProviderRecord(providerId, mode = '') {
  hydrateActivatedProviderRecordsFromDisk();
  if (mode) {
    activatedProviders.delete(providerActivationKey(providerId, mode));
    const legacy = activatedProviders.get(providerId);
    if (legacy?.mode === mode) activatedProviders.delete(providerId);
    persistActivatedProviderRecordsToDisk();
    return;
  }
  for (const key of Array.from(activatedProviders.keys())) {
    if (key === providerId || key.startsWith(`${providerId}::`)) {
      activatedProviders.delete(key);
    }
  }
  persistActivatedProviderRecordsToDisk();
}

function activatedProviderPayload(providerId, catalogItem = null) {
  const mode = catalogItem?.mode || '';
  let record = getActivatedProviderRecord(providerId, mode);
  // 音频类目录：只要该 provider 任意模式有激活密钥即可（与 resolveAudioProviderApiKey 的 fallback 一致）
  if (!record && mode === 'audio') record = getActivatedProviderRecord(providerId, '');
  const providerActivated = Boolean(record);
  const activationModelMatched = catalogItem ? modelMatchesActivation(record, catalogItem) : providerActivated;
  const matchedAvailableModel = providerActivated && catalogItem && Array.isArray(record?.availableModels)
    ? record.availableModels.find((entry) => modelMatchesActivation({
      mode: record.mode,
      model: entry?.upstreamModel || entry?.catalogModelId || entry?.id,
      catalogModelIds: [entry?.catalogModelId, entry?.upstreamModel, entry?.id].filter(Boolean),
    }, catalogItem))
    : null;
  return {
    activated: providerActivated,
    activationModelMatched,
    activatedAt: providerActivated ? (record?.activatedAt || null) : null,
    activationMode: providerActivated ? (record?.mode || null) : null,
    activationModel: providerActivated ? (record?.model || null) : null,
    maskedKey: providerActivated ? (record?.maskedKey || '') : '',
    activationPrice: providerActivated ? (matchedAvailableModel?.price ?? record?.primaryPrice ?? null) : null,
    activationCurrency: providerActivated ? (matchedAvailableModel?.currency || record?.primaryCurrency || null) : null,
    activationRelaySource: providerActivated ? (record?.relaySource || null) : null,
    activationAvailableModelCount: providerActivated ? (Array.isArray(record?.availableModels) ? record.availableModels.length : 0) : 0,
  };
}

function isCatalogModelActivated(item) {
  return activatedProviderPayload(item.provider, item).activated;
}

function modelCatalogPayload({ mode, nodeType } = {}) {
  return MODEL_CATALOG
    .filter((item) => {
      const providerMeta = providers.find((provider) => provider.id === item.provider);
      const providerSupportsMode = providerMeta ? providerMeta.modes.includes(item.mode) : true;
      return providerSupportsMode && (!mode || item.mode === mode) && (!nodeType || item.nodeTypes.includes(nodeType));
    })
    .map((item) => {
      const activationState = activatedProviderPayload(item.provider, item);
      const hasActivationPrice = activationState.activationPrice !== null
        && activationState.activationPrice !== undefined
        && Number.isFinite(Number(activationState.activationPrice));
      const arkCached = item.provider === 'volcengine' ? getArkEndpointInfo(item.id) : null;
      const arkHint = item.provider === 'volcengine'
        ? (arkCached?.endpointId
            ? `已自动创建推理接入点 ${arkCached.endpointId}，可直接调用。`
            : '该平台模型需推理接入点（ep-xxxx）才能调用：可在火山方舟控制台手动创建，或在 API Keys 页填写火山 AccessKey/SecretKey 由系统自动创建，然后用 ep-xxxx 作为模型名。')
        : (item.endpointHint || undefined);
      return {
        ...item,
        model: item.upstreamModel || item.id,
        requiresEndpoint: item.provider === 'volcengine' ? true : Boolean(item.requiresEndpoint),
        endpointHint: arkHint,
        endpointId: item.provider === 'volcengine' ? (arkCached?.endpointId || null) : undefined,
        endpointStatus: item.provider === 'volcengine' ? (arkCached?.status || null) : undefined,
        lifecycle: catalogLifecycleFor(item),
        price: hasActivationPrice ? Number(activationState.activationPrice) : item.price,
        currency: activationState.activationCurrency || item.currency,
        ...activationState,
        providerMeta: providers.find((provider) => provider.id === item.provider) || null,
      };
    });
}

function activatedModelIds() {
  return new Set(
    listActivatedProviderRecords()
      .flatMap((item) => {
        const matched = catalogModelByIdentifier(item?.model);
        return [
          item?.model,
          ...(Array.isArray(item?.catalogModelIds) ? item.catalogModelIds : []),
          ...(Array.isArray(item?.availableModels)
            ? item.availableModels.flatMap((entry) => [entry?.catalogModelId, entry?.upstreamModel, entry?.id])
            : []),
          ...(matched ? [matched.id, matched.upstreamModel] : []),
        ].filter(Boolean);
      }),
  );
}

function modelMatchesIdentifier(item, identifier) {
  const normalizedIdentifier = normalizeCatalogIdentifier(identifier);
  if (!normalizedIdentifier) return false;
  const resolvedCatalogId = normalizeCatalogIdentifier(relayAliasCatalogId(identifier));
  const candidateIds = [
    item?.id,
    item?.name,
    item?.model,
    item?.upstreamModel,
  ]
    .map((value) => normalizeCatalogIdentifier(value))
    .filter(Boolean);
  return candidateIds.includes(normalizedIdentifier) || (resolvedCatalogId ? candidateIds.includes(resolvedCatalogId) : false);
}

function defaultProviderModeModel(provider, mode, items = []) {
  if (provider === 'siliconflow' && mode === 'video') {
    return items.find((item) => modelMatchesIdentifier(item, 'Wan-AI/Wan2.2-T2V-A14B'))
      || items.find((item) => modelMatchesIdentifier(item, 'Wan-AI/Wan2.2-I2V-A14B'))
      || null;
  }
  if (provider === 'siliconflow' && mode === 'image') {
    return items.find((item) => modelMatchesIdentifier(item, 'Qwen/Qwen-Image')) || null;
  }
  return null;
}

function normalizeRelayEndpointInput(endpoint = '') {
  const raw = String(endpoint || '').trim();
  if (!raw) return '';
  let normalized = raw.replace(/\/models\/?$/i, '').replace(/\/$/, '');
  try {
    const url = new URL(normalized);
    if (url.hostname === 'www.apimart.ai') {
      url.hostname = 'api.apimart.ai';
    }
    if (/^\/(?:zh|en|cn|ja|ko|ru|fr|de|es|pt)(?:-[a-z]{2})?\/v1\/?$/i.test(url.pathname)) {
      url.pathname = '/v1';
    }
    if (/(^|\.)apimart\.ai$/i.test(url.hostname) && url.hostname !== 'api.apimart.ai') {
      url.hostname = 'api.apimart.ai';
    }
    if (/(^|\.)apimart\.ai$/i.test(url.hostname) && (!url.pathname || url.pathname === '/')) {
      url.pathname = '/v1';
    }
    normalized = url.toString().replace(/\/$/, '');
  } catch {
    normalized = normalized.replace(/\/$/, '');
  }
  return normalized;
}

function relayBaseUrlCandidates(baseUrl = '') {
  const candidates = [];
  const push = (value) => {
    const normalized = String(value || '').trim().replace(/\/$/, '');
    if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
  };
  push(baseUrl);
  try {
    const url = new URL(baseUrl);
    if (/(^|\.)apimart\.ai$/i.test(url.hostname) && url.hostname !== 'api.apimart.ai') {
      const apiUrl = new URL(url.toString());
      apiUrl.hostname = 'api.apimart.ai';
      if (!apiUrl.pathname || apiUrl.pathname === '/') apiUrl.pathname = '/v1';
      push(apiUrl.toString());
    }
  } catch {
    // ignore malformed URL here; validation happens at request time
  }
  return candidates;
}

function relayRequestUrlCandidates(baseUrl = '', requestUrl = '') {
  const candidates = [];
  const push = (value) => {
    const normalized = String(value || '').trim();
    if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
  };
  push(requestUrl);
  try {
    const target = new URL(requestUrl);
    for (const candidateBaseUrl of relayBaseUrlCandidates(baseUrl)) {
      const candidateBase = new URL(candidateBaseUrl);
      if (candidateBase.origin === target.origin) continue;
      const next = new URL(target.toString());
      next.protocol = candidateBase.protocol;
      next.hostname = candidateBase.hostname;
      next.port = candidateBase.port;
      push(next.toString());
    }
  } catch {
    // ignore malformed URL here; validation happens at request time
  }
  return candidates;
}

function relayModelsEndpointCandidates(baseUrl = '') {
  const candidates = [];
  const push = (value) => {
    const normalized = String(value || '').trim().replace(/\/$/, '');
    if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
  };
  push(baseUrl);
  try {
    const url = new URL(baseUrl);
    if (/^\/(?:zh|en|cn|ja|ko|ru|fr|de|es|pt)(?:-[a-z]{2})?\/v1$/i.test(url.pathname)) {
      const stripped = new URL(url.toString());
      stripped.pathname = '/v1';
      push(stripped.toString());
    }
    if (/(^|\.)apimart\.ai$/i.test(url.hostname) && url.hostname !== 'api.apimart.ai') {
      const apiUrl = new URL(url.toString());
      apiUrl.hostname = 'api.apimart.ai';
      if (!apiUrl.pathname || apiUrl.pathname === '/') apiUrl.pathname = '/v1';
      push(apiUrl.toString());
    }
  } catch {
    // ignore malformed URL here; validation happens at request time
  }
  return candidates.map((value) => `${value}/models`);
}

function relayEndpointHelpMessage(baseUrl = '') {
  try {
    const url = new URL(baseUrl);
    if (/(^|\.)apimart\.ai$/i.test(url.hostname)) {
      return '检测到你填写的 APIMart 地址。请优先使用 OpenAI 兼容根地址，例如 https://apimart.ai/v1 或 https://api.apimart.ai/v1，而不是官网语言页地址';
    }
  } catch {
    // ignore
  }
  return '请确认填写的 OpenAI 兼容 Base URL，而不是官网介绍页或文档页面地址';
}

const RELAY_PRESET_META = {
  comfly: {
    id: 'comfly',
    name: 'Comfly',
  },
  suanliai: {
    id: 'suanliai',
    name: 'Suanliai',
  },
  apimart: {
    id: 'apimart',
    name: 'APIMart',
  },
  'generic-openai-relay': {
    id: 'generic-openai-relay',
    name: 'OpenAI Relay',
  },
};

const RELAY_CONNECTIVITY_CACHE = new Map();
const RELAY_CONNECTIVITY_SUCCESS_TTL_MS = 5 * 60 * 1000;
const RELAY_CONNECTIVITY_FAILURE_TTL_MS = 60 * 1000;

const RELAY_MODEL_MATCHERS = [
  {
    catalogId: 'lib-image',
    aliases: [/qwen[\/\-_ ]?qwen[\/\-_ ]?image/i, /qwen[\/\-_ ]?image(?:[\/\-_ ]?edit)?/i],
    score: 100,
    recommendation: '多参考主体控制、保构图换主体、文字与商品图表现稳定',
  },
  {
    catalogId: 'gpt-image-2',
    aliases: [/gpt[\/\-_ ]?image(?:[\/\-_ ]?(?:1|1\.0|1\.5|2))?/i, /gpt[\/\-_ ]?4o[\/\-_ ]?image/i],
    score: 92,
    recommendation: '适合作为通用图片生成与编辑候选，尤其适合保构图换主体与多参考改图',
  },
  {
    aliases: [/image\s*2/i, /imagen\s*2/i],
    score: 82,
    recommendation: 'Google 图片家族，适合作为聚合平台里的高质量图片候选',
    mode: 'image',
    providerLabel: 'Google',
    displayName: 'Imagen 2 / image2',
  },
  {
    catalogId: 'flux-pro',
    aliases: [/flux[\/\-_ ]?pro/i],
    score: 90,
    recommendation: '写实海报和高质感商业图更稳，适合作为图片备选',
  },
  {
    catalogId: 'doubao-seedream-4-5',
    aliases: [/seedream[\/\-_ ]?4\.5/i, /doubao[\/\-_ ]?seedream[\/\-_ ]?4\.5/i],
    score: 90,
    recommendation: 'Seedream 4.5 提供新用户免费额度，商品图与场景图性价比高',
  },
  {
    catalogId: 'doubao-seedream-5-0-lite',
    aliases: [/seedream[\/\-_ ]?4(?:\.0)?/i, /doubao[\/\-_ ]?seedream[\/\-_ ]?4(?:\.0)?/i, /seedream[\/\-_ ]?5(?:\.0)?(?:[\/\-_ ]?lite)?/i, /doubao[\/\-_ ]?seedream[\/\-_ ]?5(?:\.0)?(?:[\/\-_ ]?lite)?/i],
    score: 88,
    recommendation: '商品图、打光和高质感场景表现强',
  },
  {
    catalogId: 'grok-imagine-1.5-edit-apimart',
    aliases: [/grok[\/\-_ ]?imagine[\/\-_ ]?1\.5[\/\-_ ]?edit/i],
    score: 90,
    recommendation: '复杂编辑指令和多参考改图适配更好，可作为强编辑备选',
  },
  {
    catalogId: 'gemini-3-pro-image-preview',
    aliases: [/gemini[\/\-_ ]?3(?:\.0|\.1)?[\/\-_ ]?pro[\/\-_ ]?image[\/\-_ ]?preview/i],
    score: 84,
    recommendation: '适合多模态预览、参考分析和结构理解',
  },
  {
    catalogId: 'kling-v3-omni',
    aliases: [/kling[\/\-_ ]?v3[\/\-_ ]?omni/i],
    score: 100,
    recommendation: '主视频保运镜、多参考换角和全能参考视频编辑优先推荐',
  },
  {
    catalogId: 'kling-o3',
    aliases: [/kling[\/\-_ ]?(?:o3|v3|video)/i],
    score: 100,
    recommendation: '全能参考、主体一致性和多模态视频编辑优先推荐',
  },
  {
    catalogId: 'seedance-v2',
    aliases: [/seedance[\/\-_ ]?(?:2(?:\.0)?|v2)/i],
    score: 96,
    recommendation: '参考图/参考视频参考音频混合输入能力强，适合多模态视频链路',
  },
  {
    catalogId: 'wan22-i2v-a14b',
    aliases: [/wan[^a-z0-9]*2(?:\.|_)?2[^a-z0-9]*(?:i2v|image[^a-z0-9]*to[^a-z0-9]*video)/i],
    score: 84,
    recommendation: '图生视频与首尾帧控制能力稳定，适合轻量预演',
  },
  {
    catalogId: 'wan22-t2v-a14b',
    aliases: [/wan[^a-z0-9]*2(?:\.|_)?2[^a-z0-9]*(?:t2v|text[^a-z0-9]*to[^a-z0-9]*video)/i],
    score: 80,
    recommendation: '文生视频预览成本更低，适合先做草案',
  },
  {
    catalogId: 'deepseek-chat',
    aliases: [/deepseek[\/\-_ ]?chat/i, /deepseek[\/\-_ ]?v?3/i, /deepseek[\/\-_ ]?r1/i],
    score: 86,
    recommendation: '用于文案、调度和 agent 辅助较稳',
  },
  {
    aliases: [/grok[\/\-_ ]?1(?:\.5)?[\/\-_ ]?video/i, /grok[\/\-_ ]?video/i],
    score: 83,
    recommendation: '更适合作为平台侧的视频多模态候选，后续可扩成强语义视频理解与生成路由',
    mode: 'video',
    providerLabel: 'xAI',
    displayName: 'Grok 1.5 Video',
  },
  {
    aliases: [/veo[\/\-_ ]?3(?:\.1)?/i, /veo3(?:\.1)?/i],
    score: 92,
    recommendation: '高质量视频生成家族，适合列为 Comfly 平台级主流视频候选',
    mode: 'video',
    providerLabel: 'Google',
    displayName: 'Veo 3.1',
  },
  {
    aliases: [/\bomni\b/i],
    score: 89,
    recommendation: '适合作为全能参考多模态理解类入口展示，便于后续接强条件控制链路',
    mode: 'llm',
    providerLabel: 'Multimodal',
    displayName: 'Omni',
  },
  {
    aliases: [/nano[\/\-_ ]?banana[\/\-_ ]?pro/i],
    score: 78,
    recommendation: '更适合作为轻量创意图片候选，当前可先展示为平台可用模型',
    mode: 'image',
    providerLabel: 'Creative',
    displayName: 'Nano Banana Pro',
  },
  {
    catalogId: 'nano-banana2',
    aliases: [/nano[\/\-_ ]?banana[\/\-_ ]?2/i, /nano[\/\-_ ]?banana[\/\-_ ]?v?2/i],
    score: 80,
    recommendation: '轻量创意图片与参考图改写候选，适合聚合平台侧快速出图',
  },
  {
    catalogId: 'gemini-31',
    aliases: [/gemini[\/\-_ ]?3(?:\.1)?/i, /gemini[\/\-_ ]?3[\/\-_ ]?pro/i, /gemini[\/\-_ ]?3[\/\-_ ]?flash/i],
    score: 88,
    recommendation: '适合作为多模态理解与 agent 路由候选，后续可扩到更深的视频/图像分析工作流',
  },
  {
    catalogId: 'midjourney-relax',
    aliases: [/mj[\/\-_ ]?relax/i, /midjourney[\/\-_ ]?relax/i, /\bmidjourney\b/i],
    score: 80,
    recommendation: '适合作为平台级图片创作候选展示，后续可补更精细的风格与计费提示',
    displayName: 'MJ Relax',
  },
  {
    catalogId: 'happyhorse-11',
    aliases: [/happyhorse(?:[\/\-_ ]?1(?:\.0|\.1)?)?/i],
    score: 94,
    recommendation: '统一视频入口，适合文本、首帧、参考图与视频编辑混合链路',
  },
  {
    aliases: [/suno[\/\-_ ]?music/i, /\bsuno\b/i],
    score: 87,
    recommendation: '适合作为音频/BGM 平台模型展示，后续可继续打通到音频节点',
    mode: 'audio',
    providerLabel: 'Suno',
    displayName: 'Suno Music',
  },
  {
    aliases: [/\brunway\b/i],
    score: 90,
    recommendation: 'Runway 视频家族适合作为平台级视频候选，后续可扩成强编辑路线',
    mode: 'video',
    providerLabel: 'Runway',
    displayName: 'Runway',
  },
];

function firstFiniteNumber(values = []) {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function fallbackRelayModelsRequestViaPowerShell(url, apiKey, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const seconds = Math.max(5, Math.ceil(Number(timeoutMs || 15000) / 1000));
    const script = `
$ProgressPreference = 'SilentlyContinue'
$uri = '${escapePowerShellSingleQuoted(url)}'
$headers = @{
  Accept = 'application/json'
  Authorization = 'Bearer ${escapePowerShellSingleQuoted(String(apiKey || '').trim())}'
}
try {
  $resp = Invoke-WebRequest -Uri $uri -Method GET -Headers $headers -TimeoutSec ${seconds} -ErrorAction Stop
  [Console]::Out.Write([int]$resp.StatusCode)
  [Console]::Out.Write([Environment]::NewLine)
  [Console]::Out.Write(($resp.Headers['Content-Type'] -join ','))
  [Console]::Out.Write([Environment]::NewLine)
  [Console]::Out.Write([string]$resp.Content)
} catch {
  $resp = $_.Exception.Response
  if ($resp) {
    $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
    $content = $reader.ReadToEnd()
    [Console]::Out.Write([int]$resp.StatusCode)
    [Console]::Out.Write([Environment]::NewLine)
    [Console]::Out.Write(($resp.Headers['Content-Type'] -join ','))
    [Console]::Out.Write([Environment]::NewLine)
    [Console]::Out.Write([string]$content)
    exit 0
  }
  throw
}
`.trim();

    const child = spawn('powershell', ['-NoProfile', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk || ''); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk || ''); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(stderr.trim() || `PowerShell request failed with code ${code}.`));
        return;
      }
      const [statusLine = '', contentTypeLine = '', ...bodyLines] = stdout.split(/\r?\n/);
      resolve({
        status: Number(statusLine) || 500,
        ok: Number(statusLine) >= 200 && Number(statusLine) < 300,
        contentType: String(contentTypeLine || '').trim().toLowerCase(),
        text: bodyLines.join('\n'),
      });
    });
  });
}

async function requestRelayModelsEndpoint(url, apiKey, signal, timeoutMs = 15000) {
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${String(apiKey).trim()}`,
  };
  const requestUrls = relayRequestUrlCandidates(url.replace(/\/models\/?$/i, ''), url);
  let lastError = null;
  for (const requestUrl of requestUrls) {
    try {
      const response = await fetch(requestUrl, {
        method: 'GET',
        headers,
        signal,
      });
      return {
        status: response.status,
        ok: response.ok,
        contentType: String(response.headers.get('content-type') || '').toLowerCase(),
        text: await response.text(),
      };
    } catch (error) {
      lastError = error;
      const code = error?.cause?.code || error?.code || '';
      if (!(process.platform === 'win32' && ['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT', 'ENETUNREACH', 'ECONNRESET', 'ECONNREFUSED'].includes(String(code)))) {
        throw error;
      }
    }
  }
  if (process.platform === 'win32') {
    for (const requestUrl of requestUrls) {
      const fallback = await fallbackRelayModelsRequestViaPowerShell(requestUrl, apiKey, timeoutMs);
      if (fallback.ok || fallback.status > 0 || String(fallback.text || '').trim()) {
        return fallback;
      }
    }
  }
  throw lastError || new Error('relay-model-request-failed');
}

function parseRelayPricing(item = {}) {
  const pricing = item?.pricing && typeof item.pricing === 'object' && !Array.isArray(item.pricing)
    ? item.pricing
    : null;
  const directPrice = firstFiniteNumber([
    item?.price,
    item?.unit_price,
    item?.cost,
    item?.pricing,
  ]);
  const pricingPrice = pricing
    ? firstFiniteNumber([
      pricing.price,
      pricing.unit_price,
      pricing.image,
      pricing.video,
      pricing.input,
      pricing.output,
      pricing.per_call,
      pricing.per_second,
      pricing.per_image,
    ])
    : null;
  const price = directPrice ?? pricingPrice;
  const currency = extractFirstString([
    item?.currency,
    pricing?.currency,
    pricing?.unit,
  ]) || null;
  const pricingUnit = extractFirstString([
    pricing?.price_unit,
    pricing?.billing_unit,
    pricing?.unit_label,
    item?.price_unit,
    item?.billing_unit,
  ]) || null;
  const pricingSummary = pricing
    ? Object.entries(pricing)
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .slice(0, 5)
      .map(([key, value]) => `${key}:${value}`)
      .join(' | ')
    : '';
  return {
    price,
    currency,
    pricingUnit,
    pricingSummary: pricingSummary || null,
  };
}

function guessRelayModelMode(modelId = '', modelName = '') {
  const source = `${modelId} ${modelName}`.toLowerCase();
  if (/\b(tts|speech|voice|audio|music|sound)\b/.test(source)) return 'audio';
  if (/\b(video|i2v|t2v|ti2v|reference-to-video|img2video|image-to-video)\b/.test(source)) return 'video';
  if (/\b(image|edit|flux|seedream|wanx|qwen-image|poster|photo)\b/.test(source)) return 'image';
  return 'llm';
}

function matchRelayCatalogModel(modelId = '', modelName = '') {
  const source = `${modelId} ${modelName}`.trim();
  for (const matcher of RELAY_MODEL_MATCHERS) {
    if (matcher.aliases.some((pattern) => pattern.test(source))) {
      const catalogModel = matcher.catalogId ? catalogModelByIdentifier(matcher.catalogId) : null;
      return {
        catalogModel,
        recommendationScore: matcher.score,
        recommendation: matcher.recommendation,
        mode: matcher.mode || catalogModel?.mode || null,
        providerLabel: matcher.providerLabel || '',
        displayName: matcher.displayName || '',
      };
    }
  }

  const normalizedSource = normalizeCatalogIdentifier(source);
  const exactCatalogModel = MODEL_CATALOG.find((item) => (
    [item.id, item.name, item.upstreamModel]
      .map((value) => normalizeCatalogIdentifier(value))
      .filter(Boolean)
      .includes(normalizedSource)
  ));

  return exactCatalogModel
    ? {
        catalogModel: exactCatalogModel,
        recommendationScore: 72,
        recommendation: '已匹配到当前画布模型目录，可直接同步到节点菜单',
        mode: exactCatalogModel.mode,
        providerLabel: '',
        displayName: '',
      }
    : null;
}

function normalizeRelayDiscoveredModel(item = {}) {
  const modelId = extractFirstString([item?.id, item?.model, item?.name]);
  if (!modelId) return null;
  const modelName = extractFirstString([item?.name, item?.display_name, item?.label, modelId]);
  const matched = matchRelayCatalogModel(modelId, modelName);
  const catalogModel = matched?.catalogModel || null;
  const pricing = parseRelayPricing(item);
  const mode = matched?.mode || catalogModel?.mode || guessRelayModelMode(modelId, modelName);
  const providerMeta = catalogModel ? providers.find((provider) => provider.id === catalogModel.provider) : null;
  return {
    id: modelId,
    name: matched?.displayName || modelName,
    mode,
    provider: catalogModel?.provider || '',
    providerLabel: matched?.providerLabel || providerMeta?.name || extractFirstString([item?.owned_by, item?.provider, item?.organization]) || '',
    catalogModelId: catalogModel?.id || null,
    upstreamModel: modelId,
    supportedOnCanvas: Boolean(catalogModel),
    recommended: Boolean(matched),
    recommendationScore: matched?.recommendationScore || 0,
    recommendation: matched?.recommendation || '',
    description: catalogModel?.description || extractFirstString(item?.description) || '',
    price: pricing.price ?? (Number.isFinite(Number(catalogModel?.price)) ? Number(catalogModel.price) : null),
    currency: pricing.currency || catalogModel?.currency || null,
    priceUnit: pricing.pricingUnit || null,
    pricingSummary: pricing.pricingSummary || null,
  };
}

function summarizeRelayRecommendations(models = []) {
  return ['image', 'video', 'llm', 'audio'].reduce((acc, mode) => {
    acc[mode] = models
      .filter((item) => item.mode === mode && item.recommended)
      .sort((left, right) => (
        Number(right.recommendationScore || 0) - Number(left.recommendationScore || 0)
      ))
      .slice(0, mode === 'video' ? 3 : 2);
    return acc;
  }, {});
}

async function fetchRelayModelIndex({ endpoint = '', apiKey = '', relayPresetId = 'generic-openai-relay' } = {}) {
  const baseUrl = normalizeRelayEndpointInput(endpoint);
  if (!baseUrl) {
    return {
      success: false,
      status: 400,
      endpoint: '',
      message: '中转站 Base URL 不能为空',
      models: [],
      recommended: summarizeRelayRecommendations([]),
    };
  }
  if (!apiKey || String(apiKey).trim().length < 8) {
    return {
      success: false,
      status: 400,
      endpoint: baseUrl,
      message: 'API Key 至少需 8 位',
      models: [],
      recommended: summarizeRelayRecommendations([]),
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const modelEndpoints = relayModelsEndpointCandidates(baseUrl);
    let lastFailure = null;

    for (const candidate of modelEndpoints) {
      const response = await requestRelayModelsEndpoint(candidate, apiKey, controller.signal, 15000);
      const text = response.text;
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }
      const contentType = String(response.contentType || '').toLowerCase();

      if (!response.ok) {
        const message = extractFirstString([payload?.error?.message, payload?.message])
          || 'Relay model list request failed (HTTP ' + response.status + ').';
        lastFailure = {
          status: response.status,
          endpoint: candidate.replace(/\/models$/i, ''),
          contentType,
          payload,
          message,
          text,
        };
        const shouldRetryCandidate = (
          [404, 405].includes(response.status)
          || contentType.includes('text/html')
          || /^<!doctype html>/i.test(String(text || '').trim())
        );
        if (shouldRetryCandidate) {
          continue;
        }
        return {
          success: false,
          status: response.status,
          endpoint: candidate.replace(/\/models$/i, ''),
          message,
          models: [],
          recommended: summarizeRelayRecommendations([]),
        };
      }

      const rawModels = Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.models)
          ? payload.models
          : [];
      const normalizedModels = rawModels
        .map((entry) => normalizeRelayDiscoveredModel(entry))
        .filter(Boolean)
        .sort((left, right) => {
          const recommendedDelta = Number(right.recommendationScore || 0) - Number(left.recommendationScore || 0);
          if (recommendedDelta !== 0) return recommendedDelta;
          return String(left.name || '').localeCompare(String(right.name || ''));
        });
      const recommended = summarizeRelayRecommendations(normalizedModels);
      const relayPreset = RELAY_PRESET_META[relayPresetId] || RELAY_PRESET_META['generic-openai-relay'];
      return {
        success: true,
        status: response.status,
        endpoint: candidate.replace(/\/models$/i, ''),
        relayPresetId: relayPreset.id,
        relayName: relayPreset.name,
        message: normalizedModels.length
          ? 'Discovered ' + normalizedModels.length + ' model(s) and filtered mainstream multimodal recommendations.'
          : '模型列表已返回，但暂未匹配到当前画布可直接使用的模型',
        models: normalizedModels,
        recommended,
      };
    }

    return {
      success: false,
      status: lastFailure?.status || 400,
      endpoint: lastFailure?.endpoint || baseUrl,
      message: lastFailure?.message
        ? `${lastFailure.message} ${relayEndpointHelpMessage(baseUrl)}`
        : relayEndpointHelpMessage(baseUrl),
      models: [],
      recommended: summarizeRelayRecommendations([]),
    };
  } catch (error) {
    return {
      success: false,
      status: 500,
      endpoint: baseUrl,
      message: error?.name === 'AbortError'
        ? 'Relay model list request timed out. Please try again later.'
        : (error instanceof Error ? error.message : String(error)),
      models: [],
      recommended: summarizeRelayRecommendations([]),
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildRelayActivationRecords(discoveredModels = []) {
  const groups = new Map();
  for (const item of discoveredModels) {
    if (!item?.supportedOnCanvas || !item.provider || !item.mode) continue;
    const key = providerActivationKey(item.provider, item.mode);
    if (!groups.has(key)) {
      groups.set(key, {
        provider: item.provider,
        mode: item.mode,
        items: [],
      });
    }
    groups.get(key).items.push(item);
  }

  return Array.from(groups.values()).map((group) => {
    const items = group.items
      .slice()
      .sort((left, right) => Number(right.recommendationScore || 0) - Number(left.recommendationScore || 0));
    const primary = items[0];
    const availableModels = items.map((item) => ({
      id: item.id,
      name: item.name,
      mode: item.mode,
      catalogModelId: item.catalogModelId,
      upstreamModel: item.upstreamModel,
      price: item.price,
      currency: item.currency,
      priceUnit: item.priceUnit || null,
      pricingSummary: item.pricingSummary || null,
      recommended: item.recommended,
      recommendationScore: item.recommendationScore,
      recommendation: item.recommendation,
    }));
    return {
      provider: group.provider,
      mode: group.mode,
      model: primary?.upstreamModel || primary?.id || '',
      catalogModelIds: Array.from(new Set(
        availableModels
          .flatMap((item) => [item.catalogModelId, item.upstreamModel, item.id])
          .filter(Boolean),
      )),
      availableModels,
      primaryModelName: primary?.name || '',
      primaryPrice: primary?.price ?? null,
      primaryCurrency: primary?.currency || null,
    };
  });
}

async function validateByokProvider({ provider, apiKey, model, mode = 'llm', endpoint = '' }) {
  const baseUrl = normalizeRelayEndpointInput(endpoint || PROVIDER_BASE_URLS[provider] || '');
  const isRelayEndpoint = Boolean(String(endpoint || '').trim());
  if (!baseUrl) {
    return {
      success: true,
      validated: false,
      model: model || '',
      message: '已保存 API Key，但当前平台尚未接入远程校验',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await requestRelayModelsEndpoint(`${baseUrl}/models`, apiKey, controller.signal, 15000);
    const text = response.text;
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    const contentType = String(response.contentType || '').toLowerCase();

    if (!response.ok) {
      if (isRelayEndpoint && ![401, 403].includes(response.status)) {
        return {
          success: true,
          validated: false,
          model: model || '',
          message: '中转站未返回标准 /models 列表，已按中转站模式保存，首次真实请求时再确认可用性',
        };
      }
      const message = extractFirstString(payload?.error?.message)
        || extractFirstString(payload?.message)
        || ('远程校验失败（HTTP ' + response.status + '）。');
      return {
        success: false,
        validated: true,
        message,
      };
    }

    const items = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : [];

    if (!items.length) {
      const looksLikeHtml = contentType.includes('text/html') || /^<!doctype html>/i.test(text.trim());
      if (looksLikeHtml || !payload) {
        return {
          success: true,
          validated: true,
          model: model || '',
          message: '该平台未暴露标准模型列表，已按当前模式保存 API Key（远程返回 200，密钥有效）。生成时会继续按真实模型归属平台路由',
        };
      }
      // 返回了合法 JSON 但模型列表为空（如火山方舟需先在控制台创建并部署推理端点）
      return {
        success: true,
        validated: true,
        model: model || '',
        message: '远程返回了空模型列表，已保存 API Key（密钥有效）。若该平台需要先部署推理端点（如火山方舟），请先在控制台创建端点后再生成。',
      };
    }
    const requestedModel = String(model || '').trim();
    const matchedModel = requestedModel
      ? items.find((item) => modelMatchesIdentifier(item, requestedModel))
      : null;
    const defaultModel = !requestedModel ? defaultProviderModeModel(provider, mode, items) : null;

    if (requestedModel && !matchedModel) {
      // 官方直连场景下，所选模型是平台内部目录 ID（如 seedream-4），而火山方舟等平台的
      // /models 只返回「已部署的推理端点」，不会暴露目录 ID，无法用名称比对。
      // 只要远程返回了 200 且可解析模型列表，即说明 API Key 有效，应视为校验通过。
      if (isRelayEndpoint) {
        return {
          success: false,
          validated: true,
          message: '所选模型「' + requestedModel + '」未在远程模型列表中找到（' + provider + '）。请确认模型名称是否正确。',
        };
      }
      return {
        success: true,
        validated: true,
        model: requestedModel,
        message: (providers.find((item) => item.id === provider)?.name || provider)
          + ' 远程校验通过（已返回模型列表）。所选模型「' + requestedModel
          + '」未直接出现在平台返回的列表中；部分平台（如火山方舟）需先在控制台创建并部署对应推理端点，生成时会按该平台实际模型路由。',
      };
    }

    return {
      success: true,
      validated: true,
      model: extractFirstString(matchedModel?.id) || extractFirstString(defaultModel?.id) || requestedModel,
      message: (providers.find((item) => item.id === provider)?.name || provider) + ' 远程校验通过。',
    };
  } catch (error) {
    return {
      success: false,
      validated: true,
      message: error?.name === 'AbortError'
        ? '远程校验超时，请稍后重试。'
        : (error instanceof Error ? error.message : String(error)),
    };
  } finally {
    clearTimeout(timer);
  }
}

  return {
    maskKey,
    inferMode,
    inferNodeTypesFromMode,
    normalizeCatalogIdentifier,
    relayAliasCatalogId,
    modelMatchesActivation,
    resolveActivatedRelayModel,
    providerActivationKey,
    isVisionModelId,
    hydrateActivatedProviderRecordsFromDisk,
    persistActivatedProviderRecordsToDisk,
    listActivatedProviderRecords,
    publicActivatedProviderRecord,
    publicImageAnalysisRuntime,
    providerLabelFor,
    buildFallbackRuntimeCandidate,
    flattenActivatedRuntimeCandidates,
    sortRuntimeCandidates,
    publicRuntimeRecommendationCandidate,
    buildRuntimeRecommendationSummary,
    buildRuntimeTaskRecommendation,
    buildRuntimeRecommendations,
    getActivatedProviderRecord,
    setActivatedProviderRecord,
    isRealApiProxyEnabled,
    deleteActivatedProviderRecord,
    activatedProviderPayload,
    isCatalogModelActivated,
    modelCatalogPayload,
    activatedModelIds,
    modelMatchesIdentifier,
    defaultProviderModeModel,
    normalizeRelayEndpointInput,
    relayBaseUrlCandidates,
    relayRequestUrlCandidates,
    relayModelsEndpointCandidates,
    relayEndpointHelpMessage,
    firstFiniteNumber,
    fallbackRelayModelsRequestViaPowerShell,
    requestRelayModelsEndpoint,
    parseRelayPricing,
    guessRelayModelMode,
    matchRelayCatalogModel,
    normalizeRelayDiscoveredModel,
    summarizeRelayRecommendations,
    fetchRelayModelIndex,
    buildRelayActivationRecords,
    validateByokProvider,
    VISION_MODEL_PATTERNS,
    RELAY_PRESET_META,
    RELAY_CONNECTIVITY_CACHE,
    RELAY_CONNECTIVITY_SUCCESS_TTL_MS,
    RELAY_CONNECTIVITY_FAILURE_TTL_MS,
    RELAY_MODEL_MATCHERS,
  };
}
