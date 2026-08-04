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
export async function downloadFileWithProgress(url, targetPath, onProgress, headers = {}, options = {}) {
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

export { USER_AGENT };
