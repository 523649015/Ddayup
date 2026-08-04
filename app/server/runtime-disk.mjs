// P3-4: 下载前磁盘空间预检。使用 fs.statfs（Promise 版 fs.promises.statfs）读取目标盘可用空间（bavail*bsize），
// 在下载/解压开始前拦截「空间不足」，避免半截文件与难清理的碎片。
// 独立轻量模块，供安装流程与单元测试直接复用。
import { promises as fs } from 'node:fs';
import path from 'node:path';

// 取目录所在磁盘的可用字节数；目录尚不存在时向上回退到最近的可访问祖先。
// statfs 不可用或失败时返回 null（调用方应跳过校验而非阻断安装）。
export async function getAvailableDiskBytes(dirPath) {
  let target = path.resolve(dirPath);
  while (true) {
    try {
      await fs.access(target);
      break;
    } catch {
      const parent = path.dirname(target);
      if (parent === target) { target = null; break; }
      target = parent;
    }
  }
  if (!target) return null;
  try {
    const stats = await fs.statfs(target);
    const bsize = Number(stats?.bsize) || 1;
    const bavail = Number(stats?.bavail) || 0;
    return bavail * bsize;
  } catch {
    return null;
  }
}

// 校验目标盘剩余空间是否满足 requiredBytes。空间不足时抛出 DISK_SPACE_INSUFFICIENT（含 free/required）。
// statfs 不可用时（free === null）自动放行，不阻断安装。
export async function assertEnoughDiskSpace(dirPath, requiredBytes, { label = '' } = {}) {
  const free = await getAvailableDiskBytes(dirPath);
  const needed = Number(requiredBytes) || 0;
  if (free !== null && needed > 0 && free < needed) {
    const err = new Error(`disk-space-insufficient:${label}:free=${free},required=${needed}`);
    err.code = 'DISK_SPACE_INSUFFICIENT';
    err.freeBytes = free;
    err.requiredBytes = needed;
    throw err;
  }
  return { freeBytes: free, requiredBytes: needed };
}

// 返回目录所在磁盘的总容量字节数（blocks*bsize）；不可用时返回 null。
export async function getDiskTotalBytes(dirPath) {
  let target = path.resolve(dirPath);
  while (true) {
    try {
      await fs.access(target);
      break;
    } catch {
      const parent = path.dirname(target);
      if (parent === target) { target = null; break; }
      target = parent;
    }
  }
  if (!target) return null;
  try {
    const stats = await fs.statfs(target);
    const bsize = Number(stats?.bsize) || 1;
    const blocks = Number(stats?.blocks) || 0;
    return blocks * bsize;
  } catch {
    return null;
  }
}
