// P3-8: 下载后完整性校验（hash/size）。损坏/截断的安装包在解压与版本切换前被拦截，避免装进半成品运行时。
// 独立成轻量模块，供 hmdao-api.mjs 安装流程与单元测试直接复用，避免引入整个 server 模块。
import { promises as fs, createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export async function computeFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(path.resolve(filePath));
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function normalizeSha256(value) {
  const trimmed = String(value || '').trim().toLowerCase();
  // 兼容 GitHub Release Asset 的 SRI digest 格式：sha256:xxx / sha256-xxx / sha256=xxx
  const match = trimmed.match(/^(?:sha256)[:=-]?([a-f0-9]{64})$/i);
  if (match) return match[1];
  return trimmed;
}

export async function verifyDownloadIntegrity(filePath, { expectedSha256 = null, expectedSize = null } = {}) {
  const resolved = path.resolve(filePath);
  if (!existsSync(resolved)) {
    const err = new Error(`integrity-file-missing:${path.basename(resolved)}`);
    err.code = 'INTEGRITY_FILE_MISSING';
    throw err;
  }
  const stat = await fs.stat(resolved);
  const actualSize = stat.size;
  if (expectedSize != null && Number(expectedSize) > 0) {
    if (actualSize !== Number(expectedSize)) {
      const err = new Error(`integrity-size-mismatch:${path.basename(resolved)}:expected=${expectedSize},actual=${actualSize}`);
      err.code = 'INTEGRITY_SIZE_MISMATCH';
      throw err;
    }
  }
  let actualSha256 = null;
  const normalizedExpectedSha256 = normalizeSha256(expectedSha256);
  if (normalizedExpectedSha256) {
    actualSha256 = await computeFileSha256(resolved);
    if (actualSha256.toLowerCase() !== normalizedExpectedSha256) {
      const err = new Error(`integrity-hash-mismatch:${path.basename(resolved)}:expected=${normalizedExpectedSha256},actual=${actualSha256}`);
      err.code = 'INTEGRITY_HASH_MISMATCH';
      throw err;
    }
  }
  return { ok: true, actualSize, actualSha256, skipped: !normalizedExpectedSha256 && !expectedSize };
}
