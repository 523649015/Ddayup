import { importLocalAssetFile } from '@/api/assetLibrary';
import type { AssetItem } from '@/types/assets';

interface LocalAssetPersistenceOptions {
  folderId?: string;
  tags?: string[];
  smartCategories?: string[];
  width?: number;
  height?: number;
  duration?: number;
  sourceUrl?: string;
}

interface LocalAssetPersistenceResult {
  item: AssetItem;
  duplicate: boolean;
  dedupeKey: string;
}

const inflightPersistenceTasks = new Map<string, Promise<LocalAssetPersistenceResult>>();
let persistenceQueue: Promise<void> = Promise.resolve();

function normalizeAssetImportScope(options: LocalAssetPersistenceOptions) {
  return JSON.stringify({
    folderId: String(options.folderId || 'root'),
    sourceUrl: String(options.sourceUrl || ''),
    tags: Array.isArray(options.tags) ? [...options.tags].sort() : [],
    smartCategories: Array.isArray(options.smartCategories) ? [...options.smartCategories].sort() : [],
    width: Number.isFinite(options.width) ? Math.round(Number(options.width)) : 0,
    height: Number.isFinite(options.height) ? Math.round(Number(options.height)) : 0,
    duration: Number.isFinite(options.duration) ? Math.round(Number(options.duration)) : 0,
  });
}

async function computeAssetDigest(file: File) {
  const scope = normalizeAssetImportScope({
    sourceUrl: file.name,
  });
  try {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const buffer = await file.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      const hex = Array.from(new Uint8Array(digest))
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('');
      return `${hex}:${scope}`;
    }
  } catch {
    // fall through to metadata-only digest
  }
  return [
    file.name,
    file.size,
    file.lastModified,
    file.type,
    scope,
  ].join(':');
}

export async function enqueueLocalAssetPersistence(
  file: File,
  options: LocalAssetPersistenceOptions = {},
): Promise<LocalAssetPersistenceResult> {
  const dedupeKey = `${await computeAssetDigest(file)}:${normalizeAssetImportScope(options)}`;
  const existingTask = inflightPersistenceTasks.get(dedupeKey);
  if (existingTask) return await existingTask;

  const task = (async () => {
    let releaseQueue: () => void = () => {};
    const waitTurn = persistenceQueue;
    persistenceQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    await waitTurn;
    try {
      const persisted = await importLocalAssetFile(file, options);
      return {
        item: persisted.item,
        duplicate: Boolean(persisted.duplicate),
        dedupeKey,
      };
    } finally {
      releaseQueue();
    }
  })();

  inflightPersistenceTasks.set(dedupeKey, task);
  try {
    return await task;
  } finally {
    inflightPersistenceTasks.delete(dedupeKey);
  }
}
