// 媒体代理相关的纯工具函数（从 hmdao-api.mjs 剥离，行为零变更）。
// 这些函数不依赖主文件的模块级运行时状态（send / sessions 等），
// 仅依赖标准库与彼此，可安全复用。依赖 send 的函数
// （sendMediaProxyError / detectRemoteMediaUpstreamIssue）仍保留在主文件。
import path from 'node:path';
import { extractFirstString } from './str-utils.mjs';

export function inferMediaContentType(targetUrl, upstreamType = '', kind = '') {
  const normalizedType = String(upstreamType || '').split(';')[0].trim().toLowerCase();
  if (normalizedType && normalizedType !== 'application/octet-stream') {
    return upstreamType;
  }

  const pathname = (() => {
    try {
      return new URL(targetUrl).pathname.toLowerCase();
    } catch {
      return String(targetUrl || '').toLowerCase();
    }
  })();

  if (pathname.endsWith('.png')) return 'image/png';
  if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
  if (pathname.endsWith('.webp')) return 'image/webp';
  if (pathname.endsWith('.gif')) return 'image/gif';
  if (pathname.endsWith('.bmp')) return 'image/bmp';
  if (pathname.endsWith('.svg')) return 'image/svg+xml';
  if (pathname.endsWith('.avif')) return 'image/avif';
  if (pathname.endsWith('.heic')) return 'image/heic';
  if (pathname.endsWith('.heif')) return 'image/heif';
  if (pathname.endsWith('.tif') || pathname.endsWith('.tiff')) return 'image/tiff';
  if (pathname.endsWith('.hdr')) return 'image/vnd.radiance';
  if (pathname.endsWith('.exr')) return 'image/x-exr';
  if (pathname.endsWith('.dng')) return 'image/x-adobe-dng';
  if (pathname.endsWith('.jxl')) return 'image/jxl';
  if (pathname.endsWith('.mp4')) return 'video/mp4';
  if (pathname.endsWith('.webm')) return 'video/webm';
  if (pathname.endsWith('.mov')) return 'video/quicktime';
  if (pathname.endsWith('.m4v')) return 'video/x-m4v';
  if (pathname.endsWith('.mkv')) return 'video/x-matroska';
  if (pathname.endsWith('.avi')) return 'video/x-msvideo';
  if (pathname.endsWith('.mp3')) return 'audio/mpeg';
  if (pathname.endsWith('.wav')) return 'audio/wav';
  if (pathname.endsWith('.m4a')) return 'audio/mp4';
  if (pathname.endsWith('.aac')) return 'audio/aac';

  if (kind === 'image') return 'image/png';
  if (kind === 'video') return 'video/mp4';
  if (kind === 'audio') return 'audio/mpeg';
  return upstreamType || 'application/octet-stream';
}

// 依据文件扩展名推断媒体/资源 MIME 类型（从主文件 hmdao-api.mjs 单源化，行为零变更）。
// 与 inferMediaContentType 同源但入参为本地路径/URL 字符串，回退值可定制。
export function imageExtensionFromMimeType(mimeType = 'image/jpeg') {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.includes('png')) return 'png';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('gif')) return 'gif';
  if (normalized.includes('bmp')) return 'bmp';
  if (normalized.includes('svg')) return 'svg';
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg';
  return 'jpg';
}

export function mediaMimeTypeFromExtension(filePath, fallback = 'application/octet-stream') {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.avif') return 'image/avif';
  if (ext === '.heic') return 'image/heic';
  if (ext === '.heif') return 'image/heif';
  if (ext === '.tif' || ext === '.tiff') return 'image/tiff';
  if (ext === '.hdr') return 'image/vnd.radiance';
  if (ext === '.exr') return 'image/x-exr';
  if (ext === '.dng') return 'image/x-adobe-dng';
  if (ext === '.jxl') return 'image/jxl';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.m4v') return 'video/x-m4v';
  if (ext === '.mkv') return 'video/x-matroska';
  if (ext === '.avi') return 'video/x-msvideo';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.ogg') return 'audio/ogg';
  if (ext === '.flac') return 'audio/flac';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.aac') return 'audio/aac';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.csv') return 'text/csv; charset=utf-8';
  if (ext === '.glb') return 'model/gltf-binary';
  if (ext === '.gltf') return 'model/gltf+json';
  if (ext === '.fbx') return 'application/octet-stream';
  if (ext === '.obj') return 'text/plain';
  if (ext === '.blend') return 'application/octet-stream';
  if (ext === '.stl') return 'model/stl';
  if (ext === '.usdz') return 'model/vnd.usdz+zip';
  if (ext === '.3ds') return 'application/octet-stream';
  return fallback;
}

// Detect when an upstream response is actually a web page (HTML) rather than
// real media. Source sites with hotlink/anti-scraping/anti-leech protection
// often answer media requests with a login/player/error HTML page (HTTP 200),
// which would otherwise be streamed/saved as if it were the audio/video file.
export function looksLikeHtml(body, contentType = '') {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('text/html') || ct.includes('application/xhtml+xml')) return true;
  if (!body || !body.length || body.length > 2 * 1024 * 1024) return false;
  const head = body.slice(0, 1024).toString('utf8').replace(/^﻿/, '').trimStart().toLowerCase();
  return (
    head.startsWith('<!doctype')
    || head.startsWith('<html')
    || head.startsWith('<?xml')
  );
}

export function sanitizeForwardHeaderValue(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

/**
 * 规范化 HTTP URL：trim、去尾斜杠；对本地回环专用端口（127.0.0.1/localhost:1025，
 * Unreal 像素流 legacy 代理的占位地址）回退到 fallback。
 * 从主文件 hmdao-api.mjs 单源化（原 normalizeHttpUrl），行为零变更。
 * @param {string} value
 * @param {string} fallback
 * @returns {string}
 */
export function normalizeHttpUrl(value, fallback) {
  const raw = String(value || '').trim() || fallback;
  const normalized = raw.replace(/\/$/, '');
  if (normalized === 'http://127.0.0.1' || normalized === 'http://localhost') return fallback;
  if (normalized === 'http://127.0.0.1:1025' || normalized === 'http://localhost:1025') return fallback;
  return normalized;
}

/**
 * 大小写不敏感读取 HTTP 头；兼容 fetch Headers 实例与原生 req.headers 对象两种形态。
 * 从主文件 hmdao-api.mjs 单源化（原 readHeaderValue），行为零变更。
 * @param {Headers|Record<string,string|string[]>} headers
 * @param {string} name
 * @returns {string}
 */
export function readHeaderValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') {
    return String(headers.get(name) || '').trim();
  }
  const lowered = String(name || '').toLowerCase();
  return String(extractFirstString(headers[lowered] ?? headers[name]) || '').trim();
}

export function parseAwsSignedAt(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) return 0;
  const [, year, month, day, hour, minute, second] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
}

export function getRemoteSignedUrlExpiry(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    const host = parsed.hostname.toLowerCase();
    const signedAt = parseAwsSignedAt(parsed.searchParams.get('X-Amz-Date'));
    const expiresInSeconds = Number(parsed.searchParams.get('X-Amz-Expires'));
    if (!signedAt || !Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) return null;
    const expiresAt = signedAt + expiresInSeconds * 1000;
    return {
      host,
      provider: host.includes('siliconflow.cn') ? 'siliconflow' : '',
      signedAt,
      expiresAt,
      expired: Date.now() > expiresAt,
    };
  } catch {
    return null;
  }
}

export function createMediaProxyErrorPayload(status, category, provider, message) {
  return {
    success: false,
    error: {
      status,
      category,
      provider,
      message,
    },
  };
}

export default {
  inferMediaContentType,
  imageExtensionFromMimeType,
  mediaMimeTypeFromExtension,
  looksLikeHtml,
  sanitizeForwardHeaderValue,
  parseAwsSignedAt,
  getRemoteSignedUrlExpiry,
  createMediaProxyErrorPayload,
};
