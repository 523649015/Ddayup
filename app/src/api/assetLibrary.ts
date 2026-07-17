import type { AssetItem } from '@/types/assets';

export interface AssetLibrarySettingsResponse {
  success: true;
  path: string;
  catalogPath: string;
  storagePath: string;
  defaultStoragePath: string;
}

export interface AssetLibraryDirectoryPickerResponse {
  success: true;
  canceled: boolean;
  path: string;
}

export interface AssetLibraryCatalogResponse {
  success: true;
  items: AssetItem[];
}

export interface AssetLibraryImportDirectoryResponse {
  success: true;
  canceled: boolean;
  path: string;
  items: AssetItem[];
  report: {
    importedCount: number;
    failedCount: number;
    skippedCount: number;
    folderImport: boolean;
    imageCount: number;
    videoCount: number;
    audioCount: number;
    textCount: number;
    autoTaggedCount: number;
    autoClassifiedCount: number;
    duplicateCount: number;
  };
}

export interface AssetImportResponse {
  success: true;
  item: AssetItem;
  duplicate?: boolean;
}

interface ImportAssetOptions {
  folderId?: string;
  tags?: string[];
  smartCategories?: string[];
  width?: number;
  height?: number;
  duration?: number;
  sourceUrl?: string;
}

function assertOk(response: Response, fallback: string) {
  if (response.ok) return;
  throw new Error(`${fallback}: HTTP ${response.status}`);
}

export function buildAssetLibraryContentUrl(assetId: unknown) {
  const normalized = typeof assetId === 'string' ? assetId.trim() : '';
  return normalized ? `/api/assets/content/${encodeURIComponent(normalized)}` : '';
}

export function extractPersistedAssetIdFromUrl(value: unknown) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  const match = raw.match(/\/api\/assets\/content\/([^/?#]+)/i);
  return match?.[1] ? decodeURIComponent(match[1]) : '';
}

export function resolvePersistedAssetLibraryUrl(url: unknown, persistedAssetId: unknown) {
  const stableUrl = buildAssetLibraryContentUrl(persistedAssetId);
  if (stableUrl) return stableUrl;
  return typeof url === 'string' ? url.trim() : '';
}

export async function fetchAssetLibrarySettings() {
  const response = await fetch('/api/settings/assets', {
    credentials: 'include',
  });
  assertOk(response, 'Failed to load asset library settings');
  return await response.json() as AssetLibrarySettingsResponse;
}

export async function saveAssetLibrarySettings(storagePath: string) {
  const response = await fetch('/api/settings/assets', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({ storagePath }),
  });
  const data = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  if (!response.ok) {
    throw new Error(data?.error?.message || `Failed to save asset library settings: HTTP ${response.status}`);
  }
  return data as AssetLibrarySettingsResponse;
}

export async function pickAssetLibraryDirectory(initialPath = '', autoSelectPath = '') {
  const response = await fetch('/api/settings/assets/pick-directory', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({ initialPath, autoSelectPath }),
  });
  const data = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  if (!response.ok) {
    throw new Error(data?.error?.message || `Failed to pick asset library directory: HTTP ${response.status}`);
  }
  return data as AssetLibraryDirectoryPickerResponse;
}

export async function importAssetDirectory(options: {
  folderId?: string;
  initialPath?: string;
  autoSelectPath?: string;
} = {}) {
  const response = await fetch('/api/assets/import-directory', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({
      folderId: options.folderId || 'root',
      initialPath: options.initialPath || '',
      autoSelectPath: options.autoSelectPath || '',
    }),
  });
  const data = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  if (!response.ok) {
    throw new Error(data?.error?.message || `Failed to import asset directory: HTTP ${response.status}`);
  }
  return data as AssetLibraryImportDirectoryResponse;
}

export async function fetchPersistedAssetCatalog() {
  const response = await fetch('/api/assets/library', {
    credentials: 'include',
  });
  assertOk(response, 'Failed to load persisted asset catalog');
  return await response.json() as AssetLibraryCatalogResponse;
}

export interface AssetDuplicateGroup {
  canonicalId: string;
  type: string;
  name: string;
  contentHash: string;
  duplicateIds: string[];
}

export interface AssetDuplicatesResponse {
  success: true;
  groups: AssetDuplicateGroup[];
  duplicateIds: string[];
  total: number;
}

export async function fetchAssetDuplicates() {
  const response = await fetch('/api/assets/duplicates', {
    credentials: 'include',
  });
  assertOk(response, 'Failed to load asset duplicates');
  return await response.json() as AssetDuplicatesResponse;
}

// 读取已落盘的去重分组缓存（不去重重算），供去重看板常驻视图使用。
export async function fetchPersistedAssetDuplicates() {
  const response = await fetch('/api/assets/duplicates/persisted', {
    credentials: 'include',
  });
  assertOk(response, 'Failed to load persisted asset duplicates');
  return await response.json() as AssetDuplicatesResponse;
}

export async function deletePersistedAssets(assetIds: string[]) {
  const response = await fetch('/api/assets/delete', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({ assetIds }),
  });
  const data = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  if (!response.ok) {
    throw new Error(data?.error?.message || `Failed to delete persisted assets: HTTP ${response.status}`);
  }
  return data as { success: true; deletedIds: string[] };
}

// 撤销找回：把此前软删除（移入回收站）的持久化素材文件恢复到原路径并写回目录。
export async function restorePersistedAssets(items: AssetItem[]) {
  const payload = items.filter((item) => Boolean(item?.backendAssetId));
  if (payload.length === 0) return { success: true, restoredIds: [] as string[] };
  const response = await fetch('/api/assets/restore', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({ items: payload }),
  });
  const data = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  if (!response.ok) {
    throw new Error(data?.error?.message || `Failed to restore persisted assets: HTTP ${response.status}`);
  }
  return data as { success: true; restoredIds: string[] };
}

export interface AssetValidateResponse {
  success: true;
  state: 'ok' | 'missing' | 'corrupted' | 'reference';
  canTranscode: boolean;
  detail?: string;
  type?: string;
}

// 预览加载失败时的诊断：检测素材文件是否缺失/损坏，或仅格式不被浏览器支持。
export async function validatePersistedAsset(assetId: string) {
  const response = await fetch('/api/assets/validate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({ assetId }),
  });
  const data = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  if (!response.ok) {
    throw new Error(data?.error?.message || `Failed to validate asset: HTTP ${response.status}`);
  }
  return data as AssetValidateResponse;
}

export interface AssetRepairResponse {
  success: true;
  url: string;
  size: number;
  contentHash: string;
}

// 修复（转码）：把可解码但浏览器无法直接预览的素材转成标准格式并原地替换。
export async function repairPersistedAsset(assetId: string) {
  const response = await fetch('/api/assets/repair', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({ assetId }),
  });
  const data = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  if (!response.ok) {
    throw new Error(data?.error?.message || `Failed to repair asset: HTTP ${response.status}`);
  }
  return data as AssetRepairResponse;
}

export async function importLocalAssetFile(file: File, options: ImportAssetOptions = {}) {
  const form = new FormData();
  form.append('file', file, file.name);
  form.append('name', file.name);
  form.append('folderId', options.folderId || 'root');
  form.append('type', file.type.startsWith('video/')
    ? 'video'
    : file.type.startsWith('audio/')
      ? 'audio'
      : file.type.startsWith('text/')
        ? 'text'
        : 'image');
  if (options.tags?.length) form.append('tags', JSON.stringify(options.tags));
  if (options.smartCategories?.length) form.append('smartCategories', JSON.stringify(options.smartCategories));
  if (Number.isFinite(options.width)) form.append('width', String(options.width));
  if (Number.isFinite(options.height)) form.append('height', String(options.height));
  if (Number.isFinite(options.duration)) form.append('duration', String(options.duration));
  if (options.sourceUrl) form.append('sourceUrl', options.sourceUrl);

  const response = await fetch('/api/assets/import', {
    method: 'POST',
    body: form,
    credentials: 'include',
  });
  const data = await response.json().catch(() => null) as ({ error?: { message?: string } } & Partial<AssetImportResponse>) | null;
  if (!response.ok || !data?.item) {
    throw new Error(data?.error?.message || `Failed to import local asset: HTTP ${response.status}`);
  }
  return {
    item: data.item,
    duplicate: Boolean(data.duplicate),
  };
}

export async function importReferencedLocalAsset(
  inputPath: string,
  options: ImportAssetOptions & {
    name?: string;
    type?: AssetItem['type'];
    copySourceFile?: boolean;
  } = {},
) {
  const normalizedPath = String(inputPath || '').trim();
  if (!normalizedPath) {
    throw new Error('Local asset path is required.');
  }

  const response = await fetch('/api/assets/import', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({
      inputPath: normalizedPath,
      name: options.name || '',
      folderId: options.folderId || 'root',
      type: options.type,
      tags: options.tags || [],
      smartCategories: options.smartCategories || [],
      width: options.width,
      height: options.height,
      duration: options.duration,
      sourceUrl: options.sourceUrl || normalizedPath,
      referenceSourceFile: true,
      copySourceFile: Boolean(options.copySourceFile),
    }),
  });
  const data = await response.json().catch(() => null) as ({ error?: { message?: string } } & Partial<AssetImportResponse>) | null;
  if (!response.ok || !data?.item) {
    throw new Error(data?.error?.message || `Failed to import referenced local asset: HTTP ${response.status}`);
  }
  return {
    item: data.item,
    duplicate: Boolean(data.duplicate),
  };
}

export async function importRemoteAsset(sourceUrl: string, options: ImportAssetOptions & { name?: string; type?: AssetItem['type'] } = {}) {
  const response = await fetch('/api/assets/import', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({
      sourceUrl,
      name: options.name || '',
      folderId: options.folderId || 'root',
      type: options.type,
      tags: options.tags || [],
      smartCategories: options.smartCategories || [],
      width: options.width,
      height: options.height,
      duration: options.duration,
    }),
  });
  const data = await response.json().catch(() => null) as ({ error?: { message?: string } } & Partial<AssetImportResponse>) | null;
  if (!response.ok || !data?.item) {
    throw new Error(data?.error?.message || `Failed to import remote asset: HTTP ${response.status}`);
  }
  return {
    item: data.item,
    duplicate: Boolean(data.duplicate),
  };
}
