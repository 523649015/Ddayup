// APIMart 载荷构建纯工具函数（从主文件 hmdao-api.mjs 剥离，行为零变更）。
// 仅依赖同 lib 的 str-utils / object-utils，零 catalog/网络/模块状态依赖。
import { extractFirstString } from './str-utils.mjs';
import { normalizeAspectRatio } from './object-utils.mjs';

export function extractApimartTaskId(payload = {}) {
  return (
    extractFirstString(payload?.task_id)
    || extractFirstString(payload?.task?.id)
    || extractFirstString(payload?.task?.task_id)
    || extractFirstString(payload?.data?.[0]?.task_id)
    || extractFirstString(payload?.data?.[0]?.id)
    || extractFirstString(payload?.result?.task_id)
    || ''
  );
}

export function normalizeApimartTaskPhase(value = '') {
  const status = String(value || '').trim().toLowerCase();
  if (!status) return 'pending';
  if (['submitted', 'queued', 'pending', 'created', 'running', 'processing', 'generating', 'in_progress'].includes(status)) {
    return 'pending';
  }
  if (['success', 'succeed', 'succeeded', 'completed', 'done', 'finished'].includes(status)) {
    return 'success';
  }
  if (['failed', 'failure', 'error', 'cancelled', 'canceled', 'expired'].includes(status)) {
    return 'failed';
  }
  return 'pending';
}

export function apimartTaskStatusCandidates(baseUrl = '', endpoint = '', taskId = '') {
  const normalizedTaskId = String(taskId || '').trim();
  if (!normalizedTaskId) return [];
  const normalizedBaseUrl = String(baseUrl || '').trim().replace(/\/$/, '');
  const normalizedEndpoint = String(endpoint || '').trim().replace(/\/$/, '');
  const candidates = [
    `${normalizedBaseUrl}/tasks/${normalizedTaskId}`,
    `${normalizedBaseUrl}${normalizedEndpoint}/${normalizedTaskId}`,
  ];
  return candidates.filter((value, index, array) => value && array.indexOf(value) === index);
}

export function apimartVideoSize(payload = {}) {
  const quality = String(payload.quality || '').trim().toLowerCase();
  if (/^\d+p$/.test(quality)) return quality;

  const resolution = String(payload.resolution || '').trim().toLowerCase();
  if (/^\d+p$/.test(resolution)) return resolution;

  const width = Number(payload.width);
  const height = Number(payload.height);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    const key = `${Math.round(width)}x${Math.round(height)}`;
    const known = {
      '854x480': '480p',
      '960x720': '720p',
      '1024x1024': '720p',
      '1280x720': '720p',
      '1440x1080': '1080p',
      '1920x1080': '1080p',
    };
    return known[key] || key;
  }

  const aspectRatio = normalizeAspectRatio(payload.aspect_ratio || payload.aspectRatio || '16:9', '16:9');
  const fallback = {
    '16:9': '720p',
    '9:16': '720p',
    '1:1': '720p',
    '4:3': '720p',
    '3:4': '720p',
  };
  return fallback[aspectRatio] || '720p';
}

export function apimartVideoAspectRatio(payload = {}) {
  return normalizeAspectRatio(
    payload.aspect_ratio || payload.aspectRatio || payload.size || rawAspectRatioFromResolution(payload.width, payload.height) || '16:9',
    '16:9',
  );
}

export function rawAspectRatioFromResolution(width, height) {
  const normalizedWidth = Number(width);
  const normalizedHeight = Number(height);
  if (!Number.isFinite(normalizedWidth) || !Number.isFinite(normalizedHeight) || normalizedWidth <= 0 || normalizedHeight <= 0) {
    return '';
  }
  if (Math.abs((normalizedWidth / normalizedHeight) - (16 / 9)) < 0.04) return '16:9';
  if (Math.abs((normalizedWidth / normalizedHeight) - (9 / 16)) < 0.04) return '9:16';
  if (Math.abs((normalizedWidth / normalizedHeight) - 1) < 0.04) return '1:1';
  if (Math.abs((normalizedWidth / normalizedHeight) - (4 / 3)) < 0.04) return '4:3';
  if (Math.abs((normalizedWidth / normalizedHeight) - (3 / 4)) < 0.04) return '3:4';
  return '';
}

export function apimartKlingMode(payload = {}) {
  const explicitMode = String(payload.mode || '').trim().toLowerCase();
  if (['std', 'pro', '4k'].includes(explicitMode)) return explicitMode;
  const quality = String(payload.quality || payload.resolution || '').trim().toLowerCase();
  if (quality === '4k' || quality === '2160p') return '4k';
  if (quality === '1080p') return 'pro';
  return 'std';
}

export function isApimartKlingVideoModelKind(modelKind = '') {
  return /^kling(?:-|$)/.test(String(modelKind || '').trim().toLowerCase());
}

export function isStrictImageSubjectSwapOperation(operation = '') {
  return String(operation || '').trim() === 'preserveCompositionReplaceSubject';
}

export function apimartImageSize(payload = {}) {
  const explicitSize = extractFirstString(payload.size);
  if (explicitSize) return explicitSize;

  const aspectRatio = normalizeAspectRatio(
    payload.aspect_ratio || payload.aspectRatio || rawAspectRatioFromResolution(payload.width, payload.height) || '1:1',
    '1:1',
  );
  const supported = new Set(['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3']);
  return supported.has(aspectRatio) ? aspectRatio : '1:1';
}

export function apimartImageResolution(payload = {}, modelKind = '') {
  const explicitResolution = String(payload.resolution || '').trim().toLowerCase();
  if (explicitResolution === '1k' || explicitResolution === '2k' || explicitResolution === '4k') {
    if (modelKind === 'qwen-image' && explicitResolution === '4k') return '2K';
    return modelKind === 'qwen-image' ? explicitResolution.toUpperCase() : explicitResolution;
  }

  const quality = String(payload.quality || '').trim().toLowerCase();
  if (quality === '2k' || quality === 'hd' || quality === '1080p' || quality === '1440p') {
    return modelKind === 'qwen-image' ? '2K' : '2k';
  }
  if (quality === '4k' || quality === '2160p') {
    return modelKind === 'qwen-image' ? '2K' : '4k';
  }

  const width = Number(payload.width);
  const height = Number(payload.height);
  const maxEdge = Math.max(
    Number.isFinite(width) ? width : 0,
    Number.isFinite(height) ? height : 0,
  );
  if (maxEdge >= 2300) return modelKind === 'qwen-image' ? '2K' : '4k';
  if (maxEdge >= 1400) return modelKind === 'qwen-image' ? '2K' : '2k';
  return modelKind === 'qwen-image' ? '1K' : '1k';
}

export function assetCoverageRoles(asset = {}, options = {}) {
  const explicitCoverage = Array.isArray(asset?.coverageRoles)
    ? asset.coverageRoles
    : Array.isArray(asset?.coverage_roles)
      ? asset.coverage_roles
      : [];
  const normalizedExplicitCoverage = Array.from(new Set(
    explicitCoverage
      .map((entry) => String(entry || '').trim().toLowerCase())
      .filter(Boolean),
  ));
  if (normalizedExplicitCoverage.length > 0) return normalizedExplicitCoverage;

  const normalizedRole = String(asset?.role || '').trim().toLowerCase();
  if (!normalizedRole) return ['reference'];
  if (normalizedRole === 'primary') return ['composition'];
  if (normalizedRole !== 'omni') return [normalizedRole];
  if (String(asset?.type || '').trim().toLowerCase() === 'video') return ['motion', 'rhythm', 'style'];
  if (isStrictImageSubjectSwapOperation(options?.imageStrategyOperation)) return ['style', 'lighting'];
  return ['subject', 'style', 'composition', 'lighting'];
}

export function apimartExpandedImageRoles(asset = {}, options = {}) {
  return assetCoverageRoles(asset, options);
}
