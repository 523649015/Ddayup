import { v4 as uuidv4 } from 'uuid';

const LOCAL_MEDIA_PREFIX = 'hmdao-local://';
const LOCAL_MEDIA_DB_NAME = 'hmdao-local-media';
const LOCAL_MEDIA_DB_VERSION = 1;
const LOCAL_MEDIA_STORE = 'entries';

interface LocalMediaEntry {
  id: string;
  blob: Blob;
  objectUrl: string;
  createdAt: number;
}

const localMediaEntries = new Map<string, LocalMediaEntry>();
let localMediaDbPromise: Promise<IDBDatabase> | null = null;

function buildHandle(id: string) {
  return `${LOCAL_MEDIA_PREFIX}${id}`;
}

function readHandleId(handle: string) {
  return handle.startsWith(LOCAL_MEDIA_PREFIX) ? handle.slice(LOCAL_MEDIA_PREFIX.length) : '';
}

function createObjectUrl(blob: Blob) {
  return URL.createObjectURL(blob);
}

function getLocalMediaDb() {
  if (typeof window === 'undefined' || !window.indexedDB) {
    return Promise.reject(new Error('indexeddb-unavailable'));
  }
  if (localMediaDbPromise) return localMediaDbPromise;
  localMediaDbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(LOCAL_MEDIA_DB_NAME, LOCAL_MEDIA_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LOCAL_MEDIA_STORE)) {
        db.createObjectStore(LOCAL_MEDIA_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      localMediaDbPromise = null;
      reject(request.error || new Error('indexeddb-open-failed'));
    };
  });
  return localMediaDbPromise;
}

async function writePersistedLocalMedia(id: string, blob: Blob) {
  try {
    const db = await getLocalMediaDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(LOCAL_MEDIA_STORE, 'readwrite');
      tx.objectStore(LOCAL_MEDIA_STORE).put({
        id,
        blob,
        createdAt: Date.now(),
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('indexeddb-write-failed'));
      tx.onabort = () => reject(tx.error || new Error('indexeddb-write-aborted'));
    });
  } catch {
    // ignore persistence failures and keep in-memory behavior
  }
}

async function readPersistedLocalMedia(id: string) {
  try {
    const db = await getLocalMediaDb();
    return await new Promise<Blob | null>((resolve, reject) => {
      const tx = db.transaction(LOCAL_MEDIA_STORE, 'readonly');
      const request = tx.objectStore(LOCAL_MEDIA_STORE).get(id);
      request.onsuccess = () => {
        const result = request.result as { blob?: Blob } | undefined;
        resolve(result?.blob instanceof Blob ? result.blob : null);
      };
      request.onerror = () => reject(request.error || new Error('indexeddb-read-failed'));
      tx.onabort = () => reject(tx.error || new Error('indexeddb-read-aborted'));
    });
  } catch {
    return null;
  }
}

async function deletePersistedLocalMedia(id: string) {
  try {
    const db = await getLocalMediaDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(LOCAL_MEDIA_STORE, 'readwrite');
      tx.objectStore(LOCAL_MEDIA_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('indexeddb-delete-failed'));
      tx.onabort = () => reject(tx.error || new Error('indexeddb-delete-aborted'));
    });
  } catch {
    // noop
  }
}

export function isLocalMediaHandle(value: unknown) {
  return typeof value === 'string' && value.startsWith(LOCAL_MEDIA_PREFIX);
}

export function isTransientBlobUrl(value: unknown) {
  return typeof value === 'string' && value.startsWith('blob:');
}

export function registerLocalMedia(blob: Blob) {
  const id = uuidv4();
  const objectUrl = createObjectUrl(blob);
  localMediaEntries.set(id, {
    id,
    blob,
    objectUrl,
    createdAt: Date.now(),
  });
  void writePersistedLocalMedia(id, blob);
  return buildHandle(id);
}

export async function registerLocalMediaPersisted(blob: Blob) {
  const id = uuidv4();
  const objectUrl = createObjectUrl(blob);
  localMediaEntries.set(id, {
    id,
    blob,
    objectUrl,
    createdAt: Date.now(),
  });
  await writePersistedLocalMedia(id, blob);
  return buildHandle(id);
}

export function resolveLocalMediaUrl(value: string) {
  if (!isLocalMediaHandle(value)) return value;
  const entry = localMediaEntries.get(readHandleId(value));
  if (!entry) return '';
  if (!entry.objectUrl) {
    entry.objectUrl = createObjectUrl(entry.blob);
  }
  return entry.objectUrl;
}

export function readLocalMediaBlob(value: string) {
  if (!isLocalMediaHandle(value)) return null;
  return localMediaEntries.get(readHandleId(value))?.blob || null;
}

export async function ensureLocalMediaUrl(value: string) {
  if (!isLocalMediaHandle(value)) return value;
  const id = readHandleId(value);
  const existing = localMediaEntries.get(id);
  if (existing) {
    if (!existing.objectUrl) {
      existing.objectUrl = createObjectUrl(existing.blob);
    }
    return existing.objectUrl;
  }
  const blob = await readPersistedLocalMedia(id);
  if (!blob) return '';
  const objectUrl = createObjectUrl(blob);
  localMediaEntries.set(id, {
    id,
    blob,
    objectUrl,
    createdAt: Date.now(),
  });
  return objectUrl;
}

export function revokeLocalMedia(value: string) {
  if (!isLocalMediaHandle(value)) return;
  const id = readHandleId(value);
  const entry = localMediaEntries.get(id);
  if (!entry) return;
  if (isTransientBlobUrl(entry.objectUrl)) {
    URL.revokeObjectURL(entry.objectUrl);
  }
  localMediaEntries.delete(id);
  void deletePersistedLocalMedia(id);
}

/**
 * 启动时从 IndexedDB 批量恢复本地媒体句柄映射。
 * 刷新页面后内存中的 localMediaEntries 会清空，而资产库持久化的 items 仍引用
 * `hmdao-local://<id>` 句柄。通过本函数在启动/重水合时把已持久化的 blob 重新载入
 * 内存映射（objectUrl 留空、由 resolveLocalMediaUrl 按需懒创建），使同步的
 * toRenderableAssetUrl → resolveLocalMediaUrl 在刷新后仍能正确解析，图片不再空白。
 */
export async function hydrateLocalMediaRegistry(): Promise<void> {
  try {
    const db = await getLocalMediaDb();
    const entries = await new Promise<Array<{ id: string; blob: Blob }>>((resolve, reject) => {
      const tx = db.transaction(LOCAL_MEDIA_STORE, 'readonly');
      const store = tx.objectStore(LOCAL_MEDIA_STORE);
      const request = store.getAll();
      request.onsuccess = () => resolve((request.result as Array<{ id: string; blob: Blob }>) || []);
      request.onerror = () => reject(tx.error);
    });
    for (const entry of entries) {
      if (!localMediaEntries.has(entry.id)) {
        localMediaEntries.set(entry.id, {
          id: entry.id,
          blob: entry.blob,
          objectUrl: '',
          createdAt: Date.now(),
        });
      }
    }
  } catch {
    // indexedDB 不可用时安全忽略
  }
}
