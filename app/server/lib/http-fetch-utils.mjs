// P1-11 抽取：自 hmdao-api.mjs 原样搬移（零转写），仅追加 export 前缀。
// 依赖常量/工具经既有模块单点导入，ESM 单例语义与原文件一致。
import http from 'node:http';
import https from 'node:https';
import { readHeaderValue } from './media-utils.mjs';

export async function requestRemoteBinaryAsset(targetUrl, {
  method = 'GET',
  headers = {},
  timeoutMs = 45000,
} = {}) {
  const normalizedMethod = String(method || 'GET').toUpperCase();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  try {
    const upstream = await fetch(targetUrl, {
      method: normalizedMethod,
      headers,
      redirect: 'follow',
      signal: controller.signal,
    });
    const body = normalizedMethod === 'HEAD'
      ? Buffer.alloc(0)
      : Buffer.from(await upstream.arrayBuffer());
    return {
      status: upstream.status,
      headers: upstream.headers,
      body,
      transport: 'fetch',
    };
  } catch (fetchError) {
    const fallback = await nativeHttpRequest(targetUrl, {
      method: normalizedMethod,
      timeoutMs,
      headers,
      responseType: 'buffer',
    });
    if (!fallback.ok && !fallback.status) {
      throw fetchError instanceof Error ? fetchError : new Error(String(fetchError));
    }
    return {
      status: Number(fallback.status || 0),
      headers: fallback.headers || {},
      body: normalizedMethod === 'HEAD' ? Buffer.alloc(0) : Buffer.from(fallback.bodyBuffer || Buffer.alloc(0)),
      transport: 'native-http',
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function downloadRemoteMediaBuffer(targetUrl) {
  const upstream = await requestRemoteBinaryAsset(targetUrl, {
    method: 'GET',
    headers: {
      Accept: '*/*',
      'User-Agent': 'HMDao-LocalVideoEdit/1.0',
    },
    timeoutMs: 45000,
  });
  if (!(upstream.status >= 200 && upstream.status < 300)) {
    throw new Error(`remote-media-fetch-failed:${upstream.status}`);
  }
  const mimeType = readHeaderValue(upstream.headers, 'content-type');
  const bytes = upstream.body;
  return {
    bytes,
    mimeType,
  };
}

export function requestModuleFor(protocol) {
  return protocol === 'https:' ? https : http;
}

export function nativeHttpRequest(url, { method = 'GET', timeoutMs = 2500, headers = {}, responseType = 'text' } = {}) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      resolve({ ok: false, status: 0, error: 'invalid-url' });
      return;
    }

    const requestLib = requestModuleFor(parsed.protocol);
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
    const req = requestLib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port,
        path: `${parsed.pathname || '/'}${parsed.search || ''}`,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          if (responseType === 'buffer') {
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 500,
              status: res.statusCode || 0,
              bodyBuffer: body,
              headers: res.headers,
            });
            return;
          }
          if (responseType === 'json') {
            try {
              const data = JSON.parse(body.toString('utf8'));
              resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode || 0, data, headers: res.headers });
            } catch {
              resolve({ ok: false, status: res.statusCode || 0, error: 'invalid-json', data: null, headers: res.headers });
            }
            return;
          }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 500, status: res.statusCode || 0, body: body.toString('utf8'), headers: res.headers });
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (error) => {
      resolve({ ok: false, status: 0, error: error instanceof Error ? error.message : String(error), code: error?.code || '' });
    });
    req.end();
  });
}

export function extensionFromMimeType(mimeType = 'video/mp4') {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.includes('.cube') || normalized.includes('cube')) return 'cube';
  if (normalized.includes('.3dl') || normalized.includes('3dl')) return '3dl';
  if (normalized.includes('plain')) return 'txt';
  if (normalized.includes('png')) return 'png';
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('gif')) return 'gif';
  if (normalized.includes('bmp')) return 'bmp';
  if (normalized.includes('svg')) return 'svg';
  if (normalized.includes('avif')) return 'avif';
  if (normalized.includes('heic')) return 'heic';
  if (normalized.includes('heif')) return 'heif';
  if (normalized.includes('tiff') || normalized.includes('tif')) return 'tiff';
  if (normalized.includes('radiance') || normalized.includes('hdr')) return 'hdr';
  if (normalized.includes('exr')) return 'exr';
  if (normalized.includes('adobe-dng') || normalized.includes('dng')) return 'dng';
  if (normalized.includes('jxl')) return 'jxl';
  if (normalized.includes('webm')) return 'webm';
  if (normalized.includes('quicktime')) return 'mov';
  if (normalized.includes('x-m4v') || normalized.includes('m4v')) return 'm4v';
  if (normalized.includes('x-matroska') || normalized.includes('mkv')) return 'mkv';
  if (normalized.includes('avi')) return 'avi';
  if (normalized.includes('mpeg')) return 'mp3';
  if (normalized.includes('wav')) return 'wav';
  if (normalized.includes('flac')) return 'flac';
  if (normalized.includes('audio/mp4') || normalized.includes('m4a')) return 'm4a';
  if (normalized.includes('aac')) return 'aac';
  return 'mp4';
}
