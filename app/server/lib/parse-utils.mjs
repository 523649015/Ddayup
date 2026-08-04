// 纯解析 / URL / ID 工具函数（无运行时 I/O、不依赖任何模块级状态）。
// 从主文件 hmdao-api.mjs 单源化，行为零变更，便于复用与 CI 审计覆盖。
import path from 'node:path';

/**
 * 为内联预览构造安全的 Content-Disposition: inline 头。
 * 仅用 path.basename + encodeURIComponent，无副作用。
 * @param {string} filename
 * @returns {string}
 */
export function buildSafeInlineContentDisposition(filename = '') {
  const rawName = path.basename(String(filename || '').trim()) || 'file';
  const asciiName = rawName
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]+/g, '_')
    .replace(/["\\;]/g, '_')
    .replace(/\s+/g, ' ')
    .trim() || 'file';
  const encodedName = encodeURIComponent(rawName)
    .replace(/['()]/g, escape)
    .replace(/\*/g, '%2A');
  return `inline; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;
}

/**
 * 本地素材 ID 清洗：拒绝含路径遍历/分隔符的值，返回空串表示非法。
 * @param {string} value
 * @returns {string}
 */
export function sanitizeLocalAssetId(value) {
  const assetId = String(value || '').trim();
  if (!assetId || assetId.includes('..') || assetId.includes('/') || assetId.includes('\\')) {
    return '';
  }
  return assetId;
}

/**
 * 多段表单字段名清洗：小写、限定 [a-z0-9_-]、折叠连字符。
 * @param {string} value
 * @returns {string}
 */
export function sanitizeMultipartFieldName(value = 'field') {
  return String(value || 'field')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '') || 'field';
}

/**
 * 将字符串/数组/JSON 字符串字段统一解析为去空白非空字符串数组。
 * @param {*} value
 * @returns {string[]}
 */
export function parseStringArrayField(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item || '').trim()).filter(Boolean);
    }
  } catch {
    // ignore json parse failure
  }
  return trimmed.split(',').map((item) => item.trim()).filter(Boolean);
}

/**
 * 解析 data:[mime];base64,xxx 内联数据 URL，返回 { mimeType, buffer } 或 null。
 * @param {string} value
 * @returns {{ mimeType: string, buffer: Buffer } | null}
 */
export function parseInlineDataUrl(value = '') {
  const source = String(value || '').trim();
  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,([a-z0-9+/=\s]+)$/i.exec(source);
  if (!match) return null;
  return {
    mimeType: String(match[1] || 'application/octet-stream').trim().toLowerCase(),
    buffer: Buffer.from(match[2].replace(/\s+/g, ''), 'base64'),
  };
}

/**
 * 判断 URL 是否指向本应用托管的公开 relay 素材路径
 * （/api/assets/content、/api/media-proxy、/api/local-video/result、/api/local-post/result）。
 * @param {string} value
 * @returns {boolean}
 */
export function isManagedPublicRelayAssetUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return (
      url.pathname.startsWith('/api/assets/content/')
      || url.pathname.startsWith('/api/media-proxy')
      || url.pathname.startsWith('/api/local-video/result/')
      || url.pathname.startsWith('/api/local-post/result/')
    );
  } catch {
    return false;
  }
}

/**
 * 判断主机名是否属于临时隧道服务（loca.lt / localtunnel.me / trycloudflare.com 等）。
 * @param {string} hostname
 * @returns {boolean}
 */
export function isTemporaryTunnelHost(hostname = '') {
  const normalized = String(hostname || '').trim().toLowerCase();
  return (
    normalized.endsWith('.loca.lt')
    || normalized.endsWith('.localtunnel.me')
    || normalized.endsWith('.lhr.life')
    || normalized.endsWith('.localhost.run')
    || normalized.endsWith('.trycloudflare.com')
  );
}

/**
 * 判断 baseUrl 是否属于 APIMart 托管域名（apimart.ai / suanliai.top / comfly.org）。
 * @param {string} baseUrl
 * @returns {boolean}
 */
export function isApimartBaseUrl(baseUrl = '') {
  try {
    const url = new URL(String(baseUrl || '').trim());
    return /(^|\.)(apimart\.ai|suanliai\.top|comfly\.org)$/i.test(url.hostname);
  } catch {
    return false;
  }
}

export default {
  buildSafeInlineContentDisposition,
  sanitizeLocalAssetId,
  sanitizeMultipartFieldName,
  parseStringArrayField,
  parseInlineDataUrl,
  isManagedPublicRelayAssetUrl,
  isTemporaryTunnelHost,
  isApimartBaseUrl,
};
