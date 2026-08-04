// APIMart 模型类型识别簇（从主文件注入式拆分，行为零变更）。
//
// 这三个函数原本紧耦合主文件的 MODEL_CATALOG 状态（catalogModelByIdentifier /
// relayAliasCatalogId / normalizeCatalogIdentifier）。为解耦，改为显式注入
// lookup 对象（由主文件在 MODEL_CATALOG 可用域构造一次后传入），本模块不持有
// 任何目录/网络/闭包状态，便于独立单测与复用。
import { extractFirstString } from './str-utils.mjs';
import { isApimartKlingVideoModelKind } from './apimart-payload-utils.mjs';
import { buildApimartImageRoleEntries } from './apimart-role-builders.mjs';
import { normalizeCatalogIdentifier } from './catalog-utils.mjs';

const fallbackNull = () => null;
const fallbackEmpty = () => '';

function resolveLookup(lookup = {}) {
  return {
    normalizeCatalogIdentifier: lookup.normalizeCatalogIdentifier || normalizeCatalogIdentifier,
    catalogModelByIdentifier: lookup.catalogModelByIdentifier || fallbackNull,
    relayAliasCatalogId: lookup.relayAliasCatalogId || fallbackEmpty,
  };
}

// 依据模型标识（含目录 id / upstreamModel / 别名 / 原始 model）推断 APIMart 视频模型类别。
export function apimartVideoModelKind(model = '', lookup = {}) {
  const { normalizeCatalogIdentifier, catalogModelByIdentifier, relayAliasCatalogId } = resolveLookup(lookup);
  const normalized = normalizeCatalogIdentifier(model);
  if (!normalized) return '';
  const catalogItem = catalogModelByIdentifier(model);
  const candidates = [
    catalogItem?.id,
    catalogItem?.upstreamModel,
    relayAliasCatalogId(model),
    model,
  ]
    .map((value) => normalizeCatalogIdentifier(value))
    .filter(Boolean);
  if (candidates.some((value) => value === 'seedance-v2' || value.includes('seedance'))) return 'seedance-v2';
  if (candidates.some((value) => value.includes('happyhorse'))) return 'happyhorse';
  if (candidates.some((value) => value.includes('kling-v3-omni'))) return 'kling-v3-omni';
  if (candidates.some((value) => value.includes('kling-v3-motion-control'))) return 'kling-v3-motion-control';
  if (candidates.some((value) => value.includes('kling-video-o1'))) return 'kling-video-o1';
  if (candidates.some((value) => value === 'kling-o3')) return 'kling-o3';
  if (candidates.some((value) => value.includes('kling-v3'))) return 'kling-v3';
  if (candidates.some((value) => value.includes('kling'))) return 'kling';
  return '';
}

// 推断 APIMart 图像模型类别（qwen-image / gpt-image-2 / generic-image）。
export function apimartImageModelKind(model = '', lookup = {}) {
  const { normalizeCatalogIdentifier, catalogModelByIdentifier, relayAliasCatalogId } = resolveLookup(lookup);
  const normalized = normalizeCatalogIdentifier(model);
  if (!normalized) return '';
  const catalogItem = catalogModelByIdentifier(model);
  const catalogId = normalizeCatalogIdentifier(catalogItem?.id || relayAliasCatalogId(model) || model);
  if (catalogId === 'qwen-image-2-0' || normalized.includes('qwen-image')) return 'qwen-image';
  if (catalogId === 'gpt-image-2' || normalized.includes('gpt-image-2')) return 'gpt-image-2';
  return 'generic-image';
}

// 是否应将 APIMart 视频编辑请求路由到 happyhorse 兜底通道。
// 仅在 HMDAO_ENABLE_HAPPYHORSE_VIDEO_EDIT_FALLBACK 开启、模型为 kling 视频类、
// 源媒体类型为 video、且存在图像角色条目时返回 true。
export function shouldRouteApimartVideoEditToHappyhorse(rawPayload = {}, normalizedPayload = {}, lookup = {}) {
  const fallbackEnabled = ['1', 'true', 'yes'].includes(
    String(process.env.HMDAO_ENABLE_HAPPYHORSE_VIDEO_EDIT_FALLBACK || '').trim().toLowerCase(),
  );
  if (!fallbackEnabled) return false;
  const model = extractFirstString(normalizedPayload?.model) || extractFirstString(rawPayload?.model);
  if (!isApimartKlingVideoModelKind(apimartVideoModelKind(model, lookup))) return false;
  const sourceMediaType = String(rawPayload?.source_media_type || normalizedPayload?.source_media_type || '')
    .trim()
    .toLowerCase();
  if (sourceMediaType !== 'video') return false;
  const imageRoleEntries = buildApimartImageRoleEntries(rawPayload || {}, normalizedPayload || {});
  return imageRoleEntries.length > 0;
}
