// Shared types, constants and pure helpers extracted from AssetLibrary.tsx.
// Moved verbatim — no behavior change.
import type { AssetItem } from '@/types/assets';
import type { NodeType } from '@/types';

export type AssetTab = 'all' | 'images' | 'videos' | 'audio' | 'model' | 'prompts' | 'workflow';

export function normalizeStoragePathValue(value: string) {
  return String(value || '')
    .trim()
    .replace(/\//g, '\\')
    .replace(/\\+$/g, '')
    .toLowerCase();
}

export function getAssetDirectoryPickerTestPath() {
  if (typeof window === 'undefined') return '';
  try {
    const storageValue = window.localStorage.getItem('HMDAO_ASSET_PICK_TEST_PATH');
    if (typeof storageValue === 'string' && storageValue.trim()) {
      return storageValue.trim();
    }
  } catch {
    // Ignore localStorage access issues and fall back to normal native picker flow.
  }
  const debugWindow = window as Window & {
    __HMDAO_ASSET_PICK_TEST_PATH__?: unknown;
  };
  return typeof debugWindow.__HMDAO_ASSET_PICK_TEST_PATH__ === 'string'
    ? debugWindow.__HMDAO_ASSET_PICK_TEST_PATH__
    : '';
}

export function buildImportStatusMessage(report: {
  importedCount: number;
  skippedCount: number;
  failedCount: number;
  duplicateCount: number;
  imageCount: number;
  videoCount: number;
  audioCount: number;
  textCount: number;
  autoTaggedCount: number;
  autoClassifiedCount: number;
  folderImport: boolean;
}) {
  const modeLabel = report.folderImport ? '文件夹素材' : '本地素材';
  const typeParts = [
    report.imageCount > 0 ? `${report.imageCount} 张图片` : '',
    report.videoCount > 0 ? `${report.videoCount} 条视频` : '',
    report.audioCount > 0 ? `${report.audioCount} 条音频` : '',
    report.textCount > 0 ? `${report.textCount} 个文档` : '',
  ].filter(Boolean);
  const summary = typeParts.length ? `，包含 ${typeParts.join('、')}` : '';
  const tagging = report.autoTaggedCount > 0 || report.autoClassifiedCount > 0
    ? '，并已自动打标签和分类'
    : '';
  const skipped = report.skippedCount > 0 ? `，跳过 ${report.skippedCount} 个不支持的文件` : '';
  const failed = report.failedCount > 0 ? `，失败 ${report.failedCount} 个` : '';
  const duplicates = report.duplicateCount > 0 ? `，识别到 ${report.duplicateCount} 个重复素材并跳过重复入库` : '';
  const indexing = report.folderImport ? '，已建立原文件引用，不额外复制素材' : '';
  return `已导入 ${report.importedCount} 个${modeLabel}${summary}${tagging}${duplicates}${indexing}${skipped}${failed}。`;
}

export function buildFolderImportStatusMessage(report: {
  importedCount: number;
  skippedCount: number;
  failedCount: number;
  duplicateCount: number;
  imageCount: number;
  videoCount: number;
  audioCount: number;
  textCount: number;
  autoTaggedCount: number;
  autoClassifiedCount: number;
  folderImport: boolean;
}) {
  return buildImportStatusMessage(report);
}

export type ContextMenuState =
  | { x: number; y: number; kind: 'item'; itemId: string }
  | { x: number; y: number; kind: 'folder'; folderId: string }
  | null;

export const MEDIA_FOLDER_IDS = {
  all: 'root',
  images: 'media:image',
  videos: 'media:video',
  audio: 'media:audio',
} as const;

export const PREVIEW_LIMITED_IMAGE_EXTENSIONS = new Set(['hdr', 'exr', 'heic', 'heif', 'dng', 'jxl']);

export function formatBytes(size: number) {
  if (!Number.isFinite(size) || size <= 0) return '未知大小';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatDuration(duration?: number) {
  if (!duration || duration <= 0) return '未知时长';
  const minutes = Math.floor(duration / 60);
  const seconds = Math.round(duration % 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function sanitizeNodeLabel(name: string) {
  return name.replace(/\.[^.]+$/, '').trim() || '素材节点';
}

export function getAssetNodeType(item: AssetItem): NodeType {
  if (item.type === 'image') return 'image' as const;
  if (item.type === 'video') return 'video' as const;
  if (item.type === 'audio') return 'audio' as const;
  if (item.type === 'model') return 'threed' as const;
  return 'text' as const;
}

export function getAssetBadge(item: AssetItem) {
  if (item.type === 'image') return '图片';
  if (item.type === 'video') return '视频';
  if (item.type === 'audio') return '音频';
  if (item.type === 'model') return '模型';
  return '文本';
}

export function getAssetExtension(item: AssetItem) {
  const candidate = [
    item.name,
    item.filePath,
    item.sourceUrl,
    item.url,
  ].find((value) => typeof value === 'string' && value.includes('.')) || '';
  const normalized = String(candidate).split('?')[0].trim().toLowerCase();
  const match = normalized.match(/\.([a-z0-9]+)$/i);
  return match?.[1] || '';
}

export function isPreviewLimitedImageAsset(item: AssetItem) {
  return item.type === 'image' && PREVIEW_LIMITED_IMAGE_EXTENSIONS.has(getAssetExtension(item));
}

