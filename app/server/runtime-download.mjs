// P3-1: 下载工具（支持断点续传）。独立轻量模块，便于单测、避免测试时拉起重型 server。
import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';

const USER_AGENT = 'HMDAO Runtime Installer';

// 单个响应流泵：边读边写，按已接收字节回调进度。
async function pumpResponse(response, fileHandle, startOffset, totalBytes, onProgress) {
  const reader = response.body.getReader();
  let received = startOffset;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      await fileHandle.write(Buffer.from(value));
      onProgress?.({
        receivedBytes: received,
        totalBytes,
        percent: totalBytes > 0 ? Math.min(100, Math.round((received / totalBytes) * 100)) : 0,
      });
    }
  } finally {
    reader.releaseLock?.();
  }
  return received;
}

/**
 * 带进度与断点续传的下载。
 * - 若 targetPath 已存在部分文件且服务端支持 Range（返回 206），则从断点续传（append）。
 * - 若服务端忽略 Range（返回 200），则丢弃部分文件从头下载（'w'）。
 * - 若服务端对 Range 返回 416（范围不满足），则从头重下。
 * @param {object} [options]
 * @param {boolean} [options.allowResume=true] 是否允许断点续传
 * @returns {Promise<{receivedBytes:number,totalBytes:number,resumed:boolean}>}
 */
/**
 * GitHub Releases 在国内经常超时/被限速，会让「一键安装」直接失败。
 * 允许用 HMDAO_GITHUB_MIRROR 配置镜像前缀兜底（多个用逗号/分号/空格分隔），
 * 镜像的用法是「前缀 + 原始 URL」，例如：
 *   https://gh-proxy.com/https://github.com/yt-dlp/yt-dlp/releases/download/...
 * 只对 GitHub 系域名套用，避免把前缀误加到自建源 / OSS 地址上。
 */
function buildMirrorCandidates(url) {
  const candidates = [url];
  const raw = String(process.env.HMDAO_GITHUB_MIRROR || '').trim();
  if (!raw) return candidates;
  const isGithubAsset = /^https?:\/\/(?:www\.)?github\.com\//i.test(url)
    || /^https?:\/\/objects\.githubusercontent\.com\//i.test(url);
  if (!isGithubAsset) return candidates;
  for (const prefix of raw.split(/[,;\s]+/).filter(Boolean)) {
    const candidate = `${prefix.replace(/\/+$/, '')}/${url}`;
    if (!candidates.includes(candidate)) candidates.push(candidate);
  }
  return candidates;
}

/** 单一源的下载实现（断点续传等原行为保持不变）。 */
async function downloadOnce(url, targetPath, onProgress, headers = {}, options = {}) {
  const allowResume = options?.allowResume !== false;
  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  let resumeFrom = 0;
  if (allowResume && existsSync(targetPath)) {
    const stat = await fs.stat(targetPath).catch(() => null);
    if (stat && stat.size > 0) resumeFrom = stat.size;
  }

  const baseHeaders = { 'User-Agent': USER_AGENT, ...headers };

  const tryFetch = (extra = {}) => fetch(url, { headers: { ...baseHeaders, ...extra } });

  let response = await tryFetch(resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : {});
  if (!response.ok) {
    // 416：请求的范围不可满足（部分文件可能已损坏）→ 从头重下
    if (resumeFrom > 0 && response.status === 416) {
      resumeFrom = 0;
      response = await tryFetch();
    } else {
      throw new Error(`download-failed:${response.status}`);
    }
  }
  if (!response.body) {
    throw new Error('download-failed:no-body');
  }

  const isResume = resumeFrom > 0 && response.status === 206;
  const fileHandle = await fs.open(targetPath, isResume ? 'a' : 'w');
  try {
    const contentLength = Number(response.headers.get('content-length') || 0);
    const totalBytes = isResume ? resumeFrom + contentLength : contentLength;
    const received = await pumpResponse(response, fileHandle, resumeFrom, totalBytes, onProgress);
    return { receivedBytes: received, totalBytes, resumed: isResume };
  } finally {
    await fileHandle.close().catch(() => {});
  }
}

/**
 * 对外入口：先走原始地址，失败后依次尝试 HMDAO_GITHUB_MIRROR 配置的镜像。
 * 签名与返回值保持不变，调用方无感知。
 */
export async function downloadFileWithProgress(url, targetPath, onProgress, headers = {}, options = {}) {
  const candidates = buildMirrorCandidates(url);
  let lastError = null;

  for (let index = 0; index < candidates.length; index += 1) {
    try {
      // 换源后不能沿用上一个源的断点（分片边界与校验可能不兼容），仅首个源允许续传。
      return await downloadOnce(candidates[index], targetPath, onProgress, headers, {
        ...options,
        allowResume: index === 0 ? options?.allowResume !== false : false,
      });
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('download-failed:unknown');
}

export { USER_AGENT };
