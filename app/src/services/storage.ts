/**
 * HMDao IndexedDB 持久化存储 — 离线草稿 + 版本历史 + Schema 迁移
 *
 * 核心能力：
 * 1. 画布自动保存/恢复（离线草稿）
 * 2. Schema 版本化 + 自动迁移（不丢数据）
 * 3. 存储配额监控 + 降级策略
 * 4. 模型缓存（为 Phase 3 E2 Real-ESRGAN onnx 模型准备）
 * 5. 操作日志持久化（为 Phase 4 C2 审计准备）
 *
 * 数据库结构：
 * - canvases: 画布数据（主键: canvasId）
 * - drafts: 自动保存草稿（主键: canvasId）
 * - modelCache: AI 模型文件缓存（主键: modelId + version）
 * - opLogs: 操作审计日志（主键: autoIncrement）
 * - meta: 元数据（主键: key）— 存储 schemaVersion 等
 */

// ===== 数据库配置 =====

const DB_NAME = 'hmdao-storage';
const DB_VERSION = 1;

/** 存储配额阈值 — 超过此比例发出警告 */
const QUOTA_WARN_RATIO = 0.7;
/** 存储配额临界 — 超过此比例拒绝写入大文件 */
const QUOTA_CRITICAL_RATIO = 0.9;

// ===== 类型定义 =====

export interface StoredCanvas {
  id: string;
  title: string;
  json: string; // 画布 JSON 序列化
  thumbnail?: string; // base64 缩略图
  createdAt: number;
  updatedAt: number;
  version: number; // 乐观锁版本号
}

export interface StoredDraft {
  canvasId: string;
  json: string;
  savedAt: number;
  autoSaveCount: number;
}

export interface StoredModelCache {
  modelId: string;
  version: string;
  data: ArrayBuffer;
  size: number;
  cachedAt: number;
  lastAccessedAt: number;
}

export interface StoredOpLog {
  id?: number; // autoIncrement
  canvasId: string;
  userId: string;
  action: string;
  payload?: string; // JSON
  timestamp: number;
}

export interface StorageQuota {
  usage: number;
  quota: number;
  usageRatio: number;
  status: 'ok' | 'warn' | 'critical';
}

// ===== 错误类型 =====

export class StorageError extends Error {
  constructor(
    message: string,
    public readonly code: 'quota_exceeded' | 'db_unavailable' | 'version_conflict' | 'not_found' | 'migration_failed',
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

// ===== 数据库单例 =====
// 注意：挂到 globalThis，避免 storage 模块被 Vite 多实例化为多份时，
// 各副本持有独立 dbInstance 导致「A 写入 / B 读取」互相不可见（如 Depth V3 缓存读不到 → model-not-cached）。

const _g = globalThis as unknown as { __hmdaoDBInstance?: IDBDatabase | null; __hmdaoDBInit?: Promise<IDBDatabase> | null };
let dbInstance: IDBDatabase | null = _g.__hmdaoDBInstance ?? null;
let dbInitPromise: Promise<IDBDatabase> | null = _g.__hmdaoDBInit ?? null;

/** 获取数据库实例（懒初始化） */
function getDB(): Promise<IDBDatabase> {
  // 多实例场景下，从 globalThis 恢复共享连接（避免 A 写入 / B 读取互相不可见）
  if (_g.__hmdaoDBInstance) { dbInstance = _g.__hmdaoDBInstance; return Promise.resolve(dbInstance); }
  if (_g.__hmdaoDBInit) { dbInitPromise = _g.__hmdaoDBInit; return dbInitPromise; }
  if (dbInstance) return Promise.resolve(dbInstance);
  if (dbInitPromise) return dbInitPromise;

  dbInitPromise = _g.__hmdaoDBInit = new Promise<IDBDatabase>((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new StorageError('IndexedDB 不可用', 'db_unavailable'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      const oldVersion = event.oldVersion;

      console.info(`[HMDao Storage] 数据库升级: v${oldVersion} → v${DB_VERSION}`);

      // v1 初始化
      if (oldVersion < 1) {
        // 画布存储
        if (!db.objectStoreNames.contains('canvases')) {
          const canvasesStore = db.createObjectStore('canvases', { keyPath: 'id' });
          canvasesStore.createIndex('updatedAt', 'updatedAt', { unique: false });
          canvasesStore.createIndex('title', 'title', { unique: false });
        }

        // 自动保存草稿
        if (!db.objectStoreNames.contains('drafts')) {
          db.createObjectStore('drafts', { keyPath: 'canvasId' });
        }

        // 模型缓存
        if (!db.objectStoreNames.contains('modelCache')) {
          const modelStore = db.createObjectStore('modelCache', { keyPath: ['modelId', 'version'] });
          modelStore.createIndex('lastAccessedAt', 'lastAccessedAt', { unique: false });
        }

        // 操作日志
        if (!db.objectStoreNames.contains('opLogs')) {
          const logStore = db.createObjectStore('opLogs', { autoIncrement: true, keyPath: 'id' });
          logStore.createIndex('canvasId', 'canvasId', { unique: false });
          logStore.createIndex('timestamp', 'timestamp', { unique: false });
        }

        // 元数据
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      }

      // 未来版本迁移在此处理：
      // if (oldVersion < 2) { ... }
    };

    request.onsuccess = (event) => {
      dbInstance = (event.target as IDBOpenDBRequest).result;
      _g.__hmdaoDBInstance = dbInstance;

      // 监听数据库意外关闭
      dbInstance.onclose = () => {
        console.warn('[HMDao Storage] 数据库意外关闭');
        dbInstance = null;
        dbInitPromise = null;
        _g.__hmdaoDBInstance = null;
        _g.__hmdaoDBInit = null;
      };

      // 写入 schema 版本
      writeMeta('schemaVersion', DB_VERSION).catch(() => {});

      console.info('[HMDao Storage] 数据库初始化完成');
      resolve(dbInstance);
    };

    request.onerror = (event) => {
      const error = (event.target as IDBOpenDBRequest).error;
      console.error('[HMDao Storage] 数据库打开失败:', error);
      dbInitPromise = null;
      _g.__hmdaoDBInit = null;
      reject(new StorageError(`数据库打开失败: ${error?.message}`, 'db_unavailable'));
    };

    request.onblocked = () => {
      console.warn('[HMDao Storage] 数据库升级被阻塞，请关闭其他标签页');
    };
  });

  return dbInitPromise;
}

// ===== 通用事务辅助 =====

/** 执行读写事务 */
async function rwTransaction<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T> {
  const db = await getDB();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);

    let request: IDBRequest<T> | void;
    try {
      request = fn(store);
    } catch (err) {
      reject(err);
      return;
    }

    tx.oncomplete = () => {
      if (request) {
        resolve(request.result);
      } else {
        resolve(undefined as unknown as T);
      }
    };

    tx.onerror = () => {
      reject(tx.error || new Error('事务失败'));
    };

    tx.onabort = () => {
      reject(new Error('事务中止'));
    };
  });
}

// ===== 元数据操作 =====

async function writeMeta(key: string, value: unknown): Promise<void> {
  await rwTransaction('meta', 'readwrite', (store) => store.put({ key, value }));
}

async function readMeta<T>(key: string): Promise<T | undefined> {
  try {
    const result = await rwTransaction<{ key: string; value: T }>('meta', 'readonly', (store) => store.get(key));
    return result?.value;
  } catch {
    return undefined;
  }
}

// ===== 存储配额 =====

/** 获取当前存储配额信息 */
export async function getStorageQuota(): Promise<StorageQuota> {
  if (!navigator.storage?.estimate) {
    return { usage: 0, quota: 0, usageRatio: 0, status: 'ok' };
  }

  try {
    const estimate = await navigator.storage.estimate();
    const usage = estimate.usage ?? 0;
    const quota = estimate.quota ?? 0;
    const usageRatio = quota > 0 ? usage / quota : 0;

    let status: StorageQuota['status'] = 'ok';
    if (usageRatio >= QUOTA_CRITICAL_RATIO) status = 'critical';
    else if (usageRatio >= QUOTA_WARN_RATIO) status = 'warn';

    return { usage, quota, usageRatio, status };
  } catch {
    return { usage: 0, quota: 0, usageRatio: 0, status: 'ok' };
  }
}

/** 检查是否有足够空间写入 */
async function checkQuota(requiredBytes: number): Promise<void> {
  const { usage, quota, status } = await getStorageQuota();

  if (status === 'critical') {
    throw new StorageError(
      `存储空间不足 (已用 ${(usage / 1024 / 1024).toFixed(1)}MB / ${(quota / 1024 / 1024).toFixed(1)}MB)`,
      'quota_exceeded',
    );
  }

  if (quota > 0 && usage + requiredBytes > quota * QUOTA_CRITICAL_RATIO) {
    throw new StorageError(
      `写入后存储将超过临界值 (需要 ${(requiredBytes / 1024 / 1024).toFixed(1)}MB)`,
      'quota_exceeded',
    );
  }
}

// ===== 画布 CRUD =====

/** 保存画布 */
export async function saveCanvas(canvas: StoredCanvas): Promise<void> {
  await checkQuota(new Blob([canvas.json]).size);
  await rwTransaction('canvases', 'readwrite', (store) => store.put(canvas));
}

/** 加载画布 */
export async function loadCanvas(id: string): Promise<StoredCanvas | undefined> {
  try {
    return await rwTransaction<StoredCanvas>('canvases', 'readonly', (store) => store.get(id));
  } catch (err) {
    if (err instanceof StorageError) throw err;
    return undefined;
  }
}

/** 列出所有画布（按更新时间倒序） */
export async function listCanvases(limit = 50): Promise<StoredCanvas[]> {
  const results: StoredCanvas[] = [];
  return new Promise((resolve, reject) => {
    getDB().then((db) => {
      const tx = db.transaction('canvases', 'readonly');
      const store = tx.objectStore('canvases');
      const index = store.index('updatedAt');
      let count = 0;

      const request = index.openCursor(null, 'prev');
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor && count < limit) {
          results.push(cursor.value);
          count++;
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve(results);
      tx.onerror = () => reject(tx.error);
    }).catch(reject);
  });
}

/** 删除画布 */
export async function deleteCanvas(id: string): Promise<void> {
  await rwTransaction('canvases', 'readwrite', (store) => store.delete(id));
  // 同时删除关联草稿
  try { await rwTransaction('drafts', 'readwrite', (store) => store.delete(id)); } catch { /* 忽略 */ }
}

// ===== 自动保存草稿 =====

/** 保存/更新自动保存草稿 */
export async function saveDraft(canvasId: string, json: string): Promise<void> {
  const existing = await loadDraft(canvasId);
  const draft: StoredDraft = {
    canvasId,
    json,
    savedAt: Date.now(),
    autoSaveCount: (existing?.autoSaveCount ?? 0) + 1,
  };
  await rwTransaction('drafts', 'readwrite', (store) => store.put(draft));
}

/** 加载自动保存草稿 */
export async function loadDraft(canvasId: string): Promise<StoredDraft | undefined> {
  try {
    return await rwTransaction<StoredDraft>('drafts', 'readonly', (store) => store.get(canvasId));
  } catch {
    return undefined;
  }
}

/** 删除自动保存草稿 */
export async function deleteDraft(canvasId: string): Promise<void> {
  await rwTransaction('drafts', 'readwrite', (store) => store.delete(canvasId));
}

/** 检查是否有未恢复的草稿 */
export async function hasDraft(canvasId: string): Promise<boolean> {
  const draft = await loadDraft(canvasId);
  return !!draft;
}

// ===== 模型缓存 =====

/** 缓存模型文件 */
export async function cacheModel(modelId: string, version: string, data: ArrayBuffer): Promise<void> {
  await checkQuota(data.byteLength);

  const entry: StoredModelCache = {
    modelId,
    version,
    data,
    size: data.byteLength,
    cachedAt: Date.now(),
    lastAccessedAt: Date.now(),
  };

  await rwTransaction('modelCache', 'readwrite', (store) => store.put(entry));
}

/** 获取缓存的模型 */
export async function getCachedModel(modelId: string, version: string): Promise<StoredModelCache | undefined> {
  try {
    const result = await rwTransaction<StoredModelCache>(
      'modelCache',
      'readonly',
      (store) => store.get([modelId, version]),
    );
    if (result) {
      // 更新访问时间
      result.lastAccessedAt = Date.now();
      rwTransaction('modelCache', 'readwrite', (store) => store.put(result)).catch(() => {});
    }
    return result;
  } catch {
    return undefined;
  }
}

/** 删除指定缓存的模型（卸载时使用） */
export async function deleteCachedModel(modelId: string, version: string): Promise<void> {
  try {
    await rwTransaction('modelCache', 'readwrite', (store) => store.delete([modelId, version]));
  } catch {
    /* 忽略删除失败 */
  }
  // 同时清理可能关联的外部权重（如 V3 的 model.onnx_data）
  try {
    await rwTransaction('modelCache', 'readwrite', (store) => store.delete([modelId, `${version}#model.onnx_data`]));
  } catch {
    /* 忽略 */
  }
}

/** 枚举已缓存的模型（用于刷新/重登后真实判定「已安装」状态） */
export async function listModelCache(): Promise<
  Array<{ modelId: string; version: string; size: number; cachedAt: number }>
> {
  try {
    const db = await getDB();
    const entries = await new Promise<Array<{ modelId: string; version: string; size: number; cachedAt: number }>>(
      (resolve, reject) => {
        const tx = db.transaction('modelCache', 'readonly');
        const store = tx.objectStore('modelCache');
        const request = store.getAll();
        request.onsuccess = () =>
          resolve(
            (request.result as Array<{ modelId: string; version: string; size: number; cachedAt: number }>) || [],
          );
        request.onerror = () => reject(tx.error);
      },
    );
    return entries;
  } catch {
    return [];
  }
}

/** 清理最旧的模型缓存（LRU 策略，释放空间） */
export async function evictOldestModelCache(keepCount = 5): Promise<void> {
  const entries: StoredModelCache[] = [];
  const db = await getDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction('modelCache', 'readwrite');
    const store = tx.objectStore('modelCache');
    const index = store.index('lastAccessedAt');

    const request = index.openCursor(null, 'next');
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        entries.push(cursor.value);
        cursor.continue();
      }
    };
    tx.oncomplete = () => {
      // 删除超出保留数量的最旧条目
      const toDelete = entries.slice(0, Math.max(0, entries.length - keepCount));
      if (toDelete.length > 0) {
        const deleteTx = db.transaction('modelCache', 'readwrite');
        const deleteStore = deleteTx.objectStore('modelCache');
        for (const entry of toDelete) {
          deleteStore.delete([entry.modelId, entry.version]);
        }
      }
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

// ===== 操作日志 =====

/** 记录操作日志 */
export async function appendOpLog(log: StoredOpLog): Promise<number> {
  const id = await rwTransaction<number>('opLogs', 'readwrite', (store) => {
    const request = store.add(log);
    return request as IDBRequest<number>;
  });
  return id;
}

/** 查询画布的操作日志 */
export async function queryOpLogs(
  canvasId: string,
  options?: { limit?: number; before?: number; after?: number },
): Promise<StoredOpLog[]> {
  const { limit = 100, before, after } = options ?? {};
  const results: StoredOpLog[] = [];

  return new Promise((resolve, reject) => {
    getDB().then((db) => {
      const tx = db.transaction('opLogs', 'readonly');
      const store = tx.objectStore('opLogs');
      const index = store.index('canvasId');
      const range = IDBKeyRange.only(canvasId);

      const request = index.openCursor(range, 'prev');
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || results.length >= limit) return;

        const log = cursor.value as StoredOpLog;
        if (after && log.timestamp < after) { cursor.continue(); return; }
        if (before && log.timestamp > before) { cursor.continue(); return; }

        results.push(log);
        cursor.continue();
      };
      tx.oncomplete = () => resolve(results);
      tx.onerror = () => reject(tx.error);
    }).catch(reject);
  });
}

/** 清理过期操作日志（保留最近 N 条或 N 天） */
export async function pruneOpLogs(options: { maxEntries?: number; maxAgeDays?: number }): Promise<void> {
  const { maxEntries = 10000, maxAgeDays = 30 } = options;
  const cutoff = Date.now() - maxAgeDays * 86400000;

  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('opLogs', 'readwrite');
    const store = tx.objectStore('opLogs');
    const index = store.index('timestamp');
    const range = IDBKeyRange.upperBound(cutoff);

    let deletedCount = 0;
    const request = index.openCursor(range);
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        cursor.delete();
        deletedCount++;
        cursor.continue();
      }
    };
    tx.oncomplete = () => {
      if (deletedCount > 0) {
        console.info(`[HMDao Storage] 清理了 ${deletedCount} 条过期操作日志`);
      }
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

// ===== 数据库维护 =====

/** 关闭数据库连接 */
export function closeDB(): void {
  if (dbInstance) {
    dbInstance.close();
  }
  dbInstance = null;
  dbInitPromise = null;
  _g.__hmdaoDBInstance = null;
  _g.__hmdaoDBInit = null;
}

/** 检查 IndexedDB 是否可用 */
export async function isStorageAvailable(): Promise<boolean> {
  try {
    await getDB();
    return true;
  } catch {
    return false;
  }
}

/** 获取数据库统计信息 */
export async function getStorageStats(): Promise<{
  canvasCount: number;
  draftCount: number;
  modelCacheCount: number;
  opLogCount: number;
  totalSize: number;
}> {
  const db = await getDB();
  const storeNames = ['canvases', 'drafts', 'modelCache', 'opLogs'];
  const counts: Record<string, number> = {};

  for (const name of storeNames) {
    counts[name] = await new Promise<number>((resolve, reject) => {
      const tx = db.transaction(name, 'readonly');
      const store = tx.objectStore(name);
      const request = store.count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(tx.error);
    });
  }

  const quota = await getStorageQuota();

  return {
    canvasCount: counts.canvases ?? 0,
    draftCount: counts.drafts ?? 0,
    modelCacheCount: counts.modelCache ?? 0,
    opLogCount: counts.opLogs ?? 0,
    totalSize: quota.usage,
  };
}