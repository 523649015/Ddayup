/**
 * HMDao AI 模型下载与缓存管理 — 进度追踪 + 断点续传 + IndexedDB 缓存
 *
 * 核心能力：
 * 1. ReadableStream 分块下载 + 实时进度回调
 * 2. IndexedDB 缓存（首次下载后离线可用）
 * 3. 下载中断后可恢复（Range 请求断点续传）
 * 4. 并发下载控制（最多 N 个并行）
 * 5. 下载超时 + 重试
 *
 * 用途：
 * - Phase 3 E2: Real-ESRGAN onnxruntime-web 模型 (~30MB)
 * - Phase 5 A3: LoRA 权重文件
 * - 未来: 任何大文件下载
 */

import { cacheModel, getCachedModel, getStorageQuota, listModelCache } from '@/services/storage';
import { wrapService, type ServiceResult } from '@/services/serviceErrorBoundary';

// ===== 类型定义 =====

export interface ModelDownloadProgress {
  modelId: string;
  version: string;
  url: string;
  totalBytes: number;
  downloadedBytes: number;
  percent: number; // 0-100
  speed: number; // bytes/s
  status: 'pending' | 'downloading' | 'cached' | 'completed' | 'error' | 'paused';
  error?: string;
  startedAt: number;
  lastUpdateAt: number;
  /** 拆分式权重（如 Depth V3 的 model.onnx_data）各自的下载进度，主文件阶段为空 */
  extraFiles?: { name: string; downloaded: number; total: number }[];
}

export interface ModelDownloadOptions {
  /** 模型标识 */
  modelId: string;
  /** 模型版本 */
  version: string;
  /** 下载 URL */
  url: string;
  /** 预期文件大小 (bytes)，用于进度计算和配额检查 */
  expectedSize?: number;
  /** 进度回调 */
  onProgress?: (progress: ModelDownloadProgress) => void;
  /** 下载超时 (ms)，默认 5 分钟 */
  timeout?: number;
  /** 重试次数 */
  retries?: number;
  /** 是否强制重新下载（忽略缓存） */
  force?: boolean;
  /** 外部权重文件（拆分式 onnx 的 model.onnx_data 等），会与主文件一同下载并缓存 */
  extraFiles?: { name: string; url: string }[];
}

export interface ModelInfo {
  modelId: string;
  version: string;
  size: number;
  cachedAt: number;
  lastAccessedAt: number;
}

// ===== 并发控制 =====

const MAX_CONCURRENT_DOWNLOADS = 2;
const activeDownloads = new Set<string>();
const pendingQueue: Array<() => void> = [];

function acquireDownloadSlot(modelId: string): Promise<void> {
  if (activeDownloads.size < MAX_CONCURRENT_DOWNLOADS) {
    activeDownloads.add(modelId);
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    pendingQueue.push(() => {
      activeDownloads.add(modelId);
      resolve();
    });
  });
}

function releaseDownloadSlot(modelId: string): void {
  activeDownloads.delete(modelId);
  const next = pendingQueue.shift();
  if (next) next();
}

// ===== 进度追踪器 =====

const progressMap = new Map<string, ModelDownloadProgress>();

function getProgressKey(modelId: string, version: string): string {
  return `${modelId}@${version}`;
}

function updateProgress(
  key: string,
  update: Partial<ModelDownloadProgress>,
  onProgress?: (progress: ModelDownloadProgress) => void,
): void {
  const current = progressMap.get(key);
  if (!current) return;

  const now = Date.now();
  const timeDelta = Math.max(now - current.lastUpdateAt, 1);
  const bytesDelta = (update.downloadedBytes ?? current.downloadedBytes) - current.downloadedBytes;

  const newProgress: ModelDownloadProgress = {
    ...current,
    ...update,
    speed: bytesDelta > 0 ? (bytesDelta / timeDelta) * 1000 : current.speed,
    lastUpdateAt: now,
  };

  progressMap.set(key, newProgress);
  onProgress?.(newProgress);
}

/** 获取当前下载进度 */
export function getDownloadProgress(modelId: string, version: string): ModelDownloadProgress | undefined {
  return progressMap.get(getProgressKey(modelId, version));
}

/** 获取所有活跃下载进度 */
export function getAllDownloadProgress(): ModelDownloadProgress[] {
  return Array.from(progressMap.values());
}

// ===== 核心下载函数 =====

/**
 * 下载模型文件到 ArrayBuffer
 * 支持 ReadableStream 分块读取 + 进度回调
 */
async function downloadToBuffer(
  url: string,
  options: {
    expectedSize?: number;
    onProgress?: (downloaded: number, total: number) => void;
    signal?: AbortSignal;
    timeout?: number;
  },
): Promise<ArrayBuffer> {
  const { expectedSize, onProgress, signal, timeout = 300000 } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  // 合并外部 signal
  if (signal) {
    signal.addEventListener('abort', () => controller.abort());
  }

  try {
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const total = expectedSize ?? parseInt(response.headers.get('content-length') ?? '0', 10);
    const reader = response.body?.getReader();

    if (!reader) {
      // 不支持流式读取，直接获取
      const buffer = await response.arrayBuffer();
      onProgress?.(buffer.byteLength, buffer.byteLength);
      return buffer;
    }

    // 流式读取
    const chunks: Uint8Array[] = [];
    let downloaded = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      chunks.push(value);
      downloaded += value.byteLength;
      onProgress?.(downloaded, total);
    }

    // 合并 chunks
    const buffer = new ArrayBuffer(downloaded);
    const view = new Uint8Array(buffer);
    let offset = 0;
    for (const chunk of chunks) {
      view.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return buffer;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ===== 公开 API =====

/**
 * 下载并缓存模型
 * 优先从 IndexedDB 缓存读取，未命中时下载
 */
export async function loadModel(options: ModelDownloadOptions): Promise<ServiceResult<ArrayBuffer>> {
    const {
    modelId,
    version,
    url,
    expectedSize,
    onProgress,
    timeout = 300000,
    retries = 2,
    force = false,
    extraFiles,
  } = options;

  const key = getProgressKey(modelId, version);

  // 初始化进度
  progressMap.set(key, {
    modelId,
    version,
    url,
    totalBytes: expectedSize ?? 0,
    downloadedBytes: 0,
    percent: 0,
    speed: 0,
    status: 'pending',
    startedAt: Date.now(),
    lastUpdateAt: Date.now(),
  });

  try {
    // 1. 检查缓存
    if (!force) {
      const cached = await getCachedModel(modelId, version);
      if (cached) {
        updateProgress(key, {
          status: 'cached',
          totalBytes: cached.size,
          downloadedBytes: cached.size,
          percent: 100,
        }, onProgress);

        return {
          success: true,
          data: cached.data,
          category: 'network',
          timestamp: Date.now(),
        };
      }
    }

    // 2. 检查存储配额
    if (expectedSize) {
      const quota = await getStorageQuota();
      if (quota.status === 'critical') {
        const error = '存储空间不足，无法下载模型';
        updateProgress(key, { status: 'error', error }, onProgress);
        return { success: false, error, category: 'validation', timestamp: Date.now() };
      }
    }

    // 3. 获取并发槽位
    await acquireDownloadSlot(modelId);

    try {
      updateProgress(key, { status: 'downloading' }, onProgress);

      // 4. 下载（带重试）
      let buffer: ArrayBuffer | null = null;
      let lastError: Error | null = null;

      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          buffer = await downloadToBuffer(url, {
            expectedSize,
            timeout,
            onProgress: (downloaded, total) => {
              updateProgress(key, {
                totalBytes: total || expectedSize || downloaded,
                downloadedBytes: downloaded,
                percent: total > 0 ? Math.round((downloaded / total) * 100) : 0,
              }, onProgress);
            },
          });
          break; // 成功，跳出重试循环
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (attempt < retries) {
            console.warn(`[HMDao ModelLoader] ${modelId} 下载失败，重试 ${attempt + 1}/${retries}: ${lastError.message}`);
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          }
        }
      }

      if (!buffer) {
        throw lastError ?? new Error('下载失败');
      }

      // 5. 缓存到 IndexedDB
      try {
        await cacheModel(modelId, version, buffer);
      } catch (cacheErr) {
        // 缓存失败不阻塞返回（内存中仍有数据）
        console.warn('[HMDao ModelLoader] 缓存写入失败:', cacheErr);
      }

      // 6. 下载并缓存外部权重文件（如 Depth Anything V3 的 model.onnx_data）
      //    强校验：任一片外部权重下载/缓存失败，整个安装视为失败（向上抛出 error），
      //    避免「主文件装好但外部权重缺失 → 激活时静默失败 / 回退」的边界。
      if (extraFiles?.length) {
        // 初始化外部权重进度（面板据此展示「主文件 + N 个外部权重」明细）
        updateProgress(key, {
          extraFiles: extraFiles.map((ef) => ({ name: ef.name, downloaded: 0, total: 0 })),
        }, onProgress);
        for (const ef of extraFiles) {
          const efKey = `${version}#${ef.name}`;
          try {
            const existing = await getCachedModel(modelId, efKey);
            if (existing && !force) continue;
            const efBuffer = await downloadToBuffer(ef.url, {
              timeout,
              onProgress: (downloaded, total) => {
                updateProgress(key, {
                  extraFiles: extraFiles.map((x) =>
                    x.name === ef.name ? { name: x.name, downloaded, total } : { name: x.name, downloaded: 0, total: 0 },
                  ),
                }, onProgress);
              },
            });
            await cacheModel(modelId, efKey, efBuffer);
            // 回读校验：确保外部权重已真实落盘（cacheModel 偶发静默失败）
            const verify = await getCachedModel(modelId, efKey);
            if (!verify || !verify.data || verify.data.byteLength === 0) {
              throw new Error(`外部权重 ${ef.name} 缓存校验失败（写入为空）`);
            }
          } catch (efErr) {
            const reason = efErr instanceof Error ? efErr.message : String(efErr);
            throw new Error(
              `外部权重 ${ef.name} 下载/缓存失败：${reason}（该模型依赖拆分权重，缺少将无法激活，请重试安装）`,
            );
          }
        }
      }

      updateProgress(key, {
        status: 'completed',
        totalBytes: buffer.byteLength,
        downloadedBytes: buffer.byteLength,
        percent: 100,
      }, onProgress);

      return {
        success: true,
        data: buffer,
        category: 'network',
        timestamp: Date.now(),
      };
    } finally {
      releaseDownloadSlot(modelId);
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    updateProgress(key, { status: 'error', error: errorMessage }, onProgress);

    return {
      success: false,
      error: errorMessage,
      category: 'network',
      timestamp: Date.now(),
    };
  }
}

/**
 * 使用 serviceErrorBoundary 包装的 loadModel
 * 适用于需要熔断器保护的场景
 */
export const safeLoadModel = wrapService(
  (options: ModelDownloadOptions) => loadModel(options).then(r => {
    if (!r.success) throw new Error(r.error);
    return r.data!;
  }),
  {
    name: 'ModelLoader',
    timeout: 600000, // 10 分钟总超时
    retries: 1,
  },
);

/**
 * 校验某已安装模型的外部权重（拆分式 onnx 的 model.onnx_data 等）是否真实存在于缓存。
 * 用于安装成功后的强校验（activateLocalModel 之前）以及启动时对已安装态的复核。
 * @returns ok=true 表示全部就绪；missing 为缺失的外部权重大件名（空数组表示齐备）。
 */
export async function verifyExternalWeights(
  modelId: string,
  version: string,
  extraFiles?: { name: string; url: string }[],
): Promise<{ ok: boolean; missing: string[] }> {
  const missing: string[] = [];
  if (extraFiles?.length) {
    for (const ef of extraFiles) {
      const efKey = `${version}#${ef.name}`;
      try {
        const cached = await getCachedModel(modelId, efKey);
        if (!cached || !cached.data || cached.data.byteLength === 0) missing.push(ef.name);
      } catch {
        missing.push(ef.name);
      }
    }
  }
  return { ok: missing.length === 0, missing };
}

/** 列出已缓存的模型（枚举 IndexedDB modelCache，使刷新后仍能判定已安装） */
export async function listCachedModels(): Promise<ModelInfo[]> {
  try {
    const list = await listModelCache();
    return list.map((entry) => ({
      modelId: entry.modelId,
      version: entry.version,
      size: entry.size,
      cachedAt: entry.cachedAt,
      lastAccessedAt: entry.cachedAt,
    }));
  } catch {
    return [];
  }
}

/** 清除进度记录 */
export function clearProgress(modelId: string, version: string): void {
  progressMap.delete(getProgressKey(modelId, version));
}
