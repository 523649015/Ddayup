import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { v4 as uuidv4 } from 'uuid';
import { registerLocalMedia, resolveLocalMediaUrl, revokeLocalMedia, hydrateLocalMediaRegistry } from '@/services/localMediaRegistry';
import { analyzeAssetImage } from '@/services/assetImageAnalysis';
import { importRemoteAsset, deletePersistedAssets, restorePersistedAssets } from '@/api/assetLibrary';
import { enqueueLocalAssetPersistence } from '@/services/localAssetPersistenceQueue';
import { postAssetPatch, onAssetPatch } from '@/services/crossTabAssetSync';
import { enhancedSearch } from '@/services/assetSearchService';
import { findSimilarAssetsInLibrary } from '@/services/assetSimilarityService';
import type { AssetFolder, AssetImageAnalysis, AssetItem, AssetLibrary, LocalSimilarResult } from '@/types/assets';

type SimilarImageResult = Array<{ url: string; thumb: string; title?: string; source?: string; width?: number; height?: number }>;
type SimilarVideoResult = Array<{ url: string; thumb: string; title?: string; source?: string; duration?: string }>;

export interface AssetOperationRecord {
  id: string;
  kind: 'move' | 'tag' | 'delete' | 'classify' | 'merge';
  label: string;
  payload: {
    ids?: string[];
    fromFolderId?: string;
    toFolderId?: string;
    tag?: string;
    items?: AssetItem[];
    prevCategories?: Array<{ id: string; smartCategories: string[]; tags: string[] }>;
  };
  createdAt: number;
}

export interface AssetUploadReport {
  importedCount: number;
  failedCount: number;
  skippedCount: number;
  duplicateCount: number;
  folderImport: boolean;
  imageCount: number;
  videoCount: number;
  audioCount: number;
  textCount: number;
  autoTaggedCount: number;
  autoClassifiedCount: number;
}

interface AssetStore extends AssetLibrary {
  createFolder: (name: string, parentId?: string | null) => string;
  renameFolder: (folderId: string, newName: string) => void;
  deleteFolder: (folderId: string) => void;
  moveFolder: (folderId: string, newParentId: string | null) => void;
  selectFolder: (folderId: string | null) => void;

  addItem: (item: Omit<AssetItem, 'id' | 'createdAt' | 'updatedAt'>) => string;
  deleteItems: (itemIds: string[]) => void;
  moveItems: (itemIds: string[], targetFolderId: string) => void;
  renameItem: (itemId: string, newName: string) => void;
  selectItem: (itemId: string, multi?: boolean) => void;
  selectPreviewItem: (itemId: string | null) => void;
  clearSelection: () => void;

  uploadFiles: (files: FileList, folderId?: string, options?: { folderImport?: boolean }) => Promise<AssetUploadReport>;

  autoClassify: (itemId: string) => Promise<string[]>;
  legacyReversePrompt: (itemId: string) => Promise<string>;
  reversePrompt: (itemId: string, options?: { engine?: string }) => Promise<string>;
  analyzeImage: (itemId: string, options?: { engine?: string }) => Promise<AssetImageAnalysis>;
  applyImageAnalysis: (itemId: string, analysis: AssetImageAnalysis) => void;
  applyCrossTabItemPatch: (itemId: string, patch: {
    tags?: string[];
    smartCategories?: string[];
    analysis?: AssetImageAnalysis;
    prompt?: string;
    updatedAt?: number;
  }) => void;
  addTag: (itemId: string, tag: string) => void;
  removeTag: (itemId: string, tag: string) => void;

  batchAddTag: (itemIds: string[], tag: string) => void;
  batchAutoClassify: (itemIds: string[]) => Promise<void>;
  batchAnalyzeImages: (itemIds: string[], options?: { concurrency?: number; retries?: number }) => Promise<void>;
  batchAnalyzeProgress: {
    total: number;
    done: number;
    running: boolean;
    failed: number;
    failedItems: Array<{ id: string; name: string; error: string }>;
  };
  analyzeConcurrency: number;
  analyzeRetries: number;
  setAnalyzeConcurrency: (value: number) => void;
  setAnalyzeRetries: (value: number) => void;
  detectDuplicates: () => number;
  applyServerDuplicates: (groups: Array<{ canonicalId: string; duplicateIds: string[] }>) => number;
  clearDuplicateFlags: () => void;
  removeDuplicateItems: (ids?: string[]) => number;
  operationHistory: AssetOperationRecord[];
  pushOperation: (record: Omit<AssetOperationRecord, 'id' | 'createdAt'>) => void;
  undoLastOperation: () => string | null;

  searchSimilarImages: (query: string) => Promise<SimilarImageResult>;
  searchSimilarVideos: (query: string) => Promise<SimilarVideoResult>;
  crawlImage: (url: string, folderId?: string) => Promise<string>;
  importFromWeb: (item: {
    url: string;
    thumbnail: string;
    name: string;
    type: 'image' | 'video';
    width?: number;
    height?: number;
    tags?: string[];
    smartCategories?: string[];
    folderId?: string;
  }) => string;
  setImportTargetFolder: (folderId: string) => void;
  collectFromUrl: (url: string, options?: {
    title?: string;
    folderId?: string;
    tags?: string[];
    smartCategories?: string[];
    type?: 'image' | 'video' | 'audio';
  }) => Promise<string>;

  setViewMode: (mode: 'grid' | 'list') => void;
  setSortBy: (sort: 'name' | 'date' | 'size') => void;
  setSearchQuery: (query: string) => void;
  setStoragePath: (storagePath: string) => void;
  syncPersistedItems: (items: AssetItem[]) => void;

  getItemsInFolder: (folderId?: string | null) => AssetItem[];
  getSelectedItems: () => AssetItem[];
  getPreviewItem: () => AssetItem | null;
  getFolderPath: (folderId: string) => AssetFolder[];
  getSmartCategories: () => Array<{ name: string; count: number; type: string }>;
}

const now = Date.now();
const IMAGE_FILE_EXTENSION_PATTERN = /\.(png|jpe?g|webp|gif|bmp|svg|avif|heic|heif|tif|tiff|hdr|exr|dng|jxl)$/i;
const VIDEO_FILE_EXTENSION_PATTERN = /\.(mp4|mov|webm|mkv|avi|m4v)$/i;
const AUDIO_FILE_EXTENSION_PATTERN = /\.(mp3|wav|ogg|flac|m4a|aac)$/i;
const TEXT_FILE_EXTENSION_PATTERN = /\.(txt|md|json|csv|pdf)$/i;
const MEDIA_FOLDER_PREFIX = 'media:';
const SMART_FOLDER_PREFIX = 'smart:';

function assetFingerprint(item: AssetItem): string {
  if (item.contentHash) return `hash:${item.contentHash}`;
  const stableKey = (item.backendAssetId || item.sourceUrl || item.url || '').trim().toLowerCase();
  if (stableKey) return `url:${stableKey}`;
  if (item.filePath) return `path:${String(item.filePath).toLowerCase()}`;
  return `meta:${item.type}:${String(item.name).toLowerCase()}:${item.size}:${(item.width || 0)}x${(item.height || 0)}`;
}

// 图片节点专用文件夹树：临时素材 / 图片节点 / {宫格切分, 海报, 高清, 局部编辑, 对比, 全景, 多角度, 打光, 摄像机}
// 用于把图片节点各功能产生的素材按分类归档，便于用户管理与删除。
const IMAGE_NODE_FOLDER_DEFS: AssetFolder[] = [
  { id: 'temp-root', name: '临时素材', parentId: 'root', children: ['img-node'], createdAt: now },
  {
    id: 'img-node',
    name: '图片节点',
    parentId: 'temp-root',
    children: ['img-grid', 'img-poster', 'img-hd', 'img-brush', 'img-compare', 'img-pano', 'img-multi', 'img-light', 'img-cam', 'img-bg'],
    createdAt: now,
  },
  { id: 'img-grid', name: '宫格切分', parentId: 'img-node', children: [], createdAt: now },
  { id: 'img-poster', name: '海报', parentId: 'img-node', children: [], createdAt: now },
  { id: 'img-hd', name: '高清', parentId: 'img-node', children: [], createdAt: now },
  { id: 'img-brush', name: '局部编辑', parentId: 'img-node', children: [], createdAt: now },
  { id: 'img-compare', name: '对比', parentId: 'img-node', children: [], createdAt: now },
  { id: 'img-pano', name: '全景', parentId: 'img-node', children: [], createdAt: now },
  { id: 'img-multi', name: '多角度', parentId: 'img-node', children: [], createdAt: now },
  { id: 'img-light', name: '打光', parentId: 'img-node', children: [], createdAt: now },
  { id: 'img-cam', name: '摄像机', parentId: 'img-node', children: [], createdAt: now },
  { id: 'img-bg', name: '去背', parentId: 'img-node', children: [], createdAt: now },
];

// 按 id 合并图片节点专用文件夹：已存在的保留（含用户重命名/删除），仅补齐缺失项。
// 这样刷新后既保证分类树存在，又不会覆盖用户对文件夹的改名/删除操作。
function withImageNodeFolders(folders: AssetFolder[]): AssetFolder[] {
  const existing = new Set(folders.map((folder) => folder.id));
  const missing = IMAGE_NODE_FOLDER_DEFS.filter((folder) => !existing.has(folder.id));
  if (missing.length === 0) return folders;
  const merged = folders.map((folder) => ({ ...folder, children: [...folder.children] }));
  for (const folder of missing) {
    merged.push({ ...folder, children: [...folder.children] });
    if (folder.parentId) {
      const parent = merged.find((entry) => entry.id === folder.parentId);
      if (parent && !parent.children.includes(folder.id)) parent.children.push(folder.id);
    }
  }
  return merged;
}

const defaultFolders: AssetFolder[] = [
  { id: 'root', name: '全部素材', parentId: null, children: ['anker', 'gs', 'lay', 'web', 'dcc', 'temp-root'], createdAt: now },
  { id: 'anker', name: 'Anker', parentId: 'root', children: [], createdAt: now },
  { id: 'gs', name: 'GS', parentId: 'root', children: [], createdAt: now },
  { id: 'lay', name: 'Lay', parentId: 'root', children: [], createdAt: now },
  { id: 'web', name: '网页采集', parentId: 'root', children: [], createdAt: now },
  { id: 'dcc', name: 'DCC \u6355\u83b7', parentId: 'root', children: [], createdAt: now },
  ...IMAGE_NODE_FOLDER_DEFS,
];

const demoItems: AssetItem[] = [
  {
    id: 'asset-image-mountain',
    name: '山脉风景.jpg',
    type: 'image',
    url: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=1600',
    thumbnail: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=400',
    folderId: 'root',
    size: 1163716,
    width: 1920,
    height: 1080,
    tags: ['自然', '风景'],
    smartCategories: ['风景', '自然', '户外'],
    source: 'upload',
    createdAt: now - 86400000,
    updatedAt: now - 86400000,
  },
  {
    id: 'asset-image-product',
    name: '产品静物.jpg',
    type: 'image',
    url: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=1600',
    thumbnail: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=400',
    folderId: 'anker',
    size: 642240,
    width: 1200,
    height: 1200,
    tags: ['产品', '电商'],
    smartCategories: ['产品', '静物'],
    source: 'upload',
    createdAt: now - 172800000,
    updatedAt: now - 172800000,
  },
  {
    id: 'asset-image-portrait',
    name: '人像参考.jpg',
    type: 'image',
    url: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=1600',
    thumbnail: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=400',
    folderId: 'gs',
    size: 456780,
    width: 1200,
    height: 1600,
    tags: ['人像', '模特'],
    smartCategories: ['人物', '人像'],
    source: 'web',
    createdAt: now - 259200000,
    updatedAt: now - 259200000,
  },
  {
    id: 'asset-video-city',
    name: '城市夜景.mp4',
    type: 'video',
    url: 'https://storage.googleapis.com/coverr-main/mp4/City_Traffic.mp4',
    thumbnail: 'https://images.unsplash.com/photo-1514565131-fce0801e5785?w=400',
    folderId: 'lay',
    size: 10485760,
    width: 1920,
    height: 1080,
    duration: 20,
    tags: ['城市', '夜景'],
    smartCategories: ['城市', '夜景'],
    source: 'crawl',
    createdAt: now - 345600000,
    updatedAt: now - 345600000,
  },
  {
    id: 'asset-video-product',
    name: '产品展示.mp4',
    type: 'video',
    url: 'https://storage.googleapis.com/coverr-main/mp4/Mt_Baker.mp4',
    thumbnail: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=400',
    folderId: 'anker',
    size: 5242880,
    width: 1920,
    height: 1080,
    duration: 15,
    tags: ['产品', '展示'],
    smartCategories: ['产品', '展示'],
    source: 'upload',
    createdAt: now - 432000000,
    updatedAt: now - 432000000,
  },
  {
    id: 'asset-audio-bgm',
    name: '柔和 BGM.mp3',
    type: 'audio',
    url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
    thumbnail: '',
    folderId: 'root',
    size: 2097152,
    duration: 180,
    tags: ['BGM', '氛围'],
    smartCategories: ['音乐', '背景'],
    source: 'upload',
    createdAt: now - 518400000,
    updatedAt: now - 518400000,
  },
];

const CATEGORY_RULES: Array<{ keywords: string[]; category: string }> = [
  { keywords: ['landscape', 'mountain', 'forest', 'ocean', 'nature', '风景', '自然', '山', '海'], category: '风景' },
  { keywords: ['portrait', 'person', 'model', 'people', '人像', '人物', '模特'], category: '人物' },
  { keywords: ['city', 'building', 'architecture', 'interior', '城市', '建筑', '室内'], category: '建筑' },
  { keywords: ['night', 'nightscape', 'neon', '夜景', '霓虹'], category: '夜景' },
  { keywords: ['car', 'vehicle', 'auto', 'automobile', '汽车', '车辆'], category: '汽车' },
  { keywords: ['product', 'commerce', 'electric', 'watch', 'phone', '产品', '电商', '静物'], category: '产品' },
  { keywords: ['tech', 'technology', 'digital', '芯片', '科技'], category: '科技' },
  { keywords: ['fashion', 'beauty', 'clothes', '时尚', '美妆'], category: '时尚' },
  { keywords: ['food', 'drink', 'cafe', 'coffee', '美食', '饮品'], category: '美食' },
  { keywords: ['audio', 'bgm', 'voice', 'music', '音频', '音乐', '旁白'], category: '音频' },
  { keywords: ['video', 'film', 'cinema', '镜头', '视频'], category: '视频' },
];

function uniq(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

/**
 * 大小写不敏感的标签去重：保持首次出现的原始大小写，
 * 避免 “Cat” / “cat” 这类同义标签在 VLM 闭环中并存导致“跨标签不一致”。
 */
function uniqTags(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = (raw || '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/**
 * 将某个素材当前的标签/分析/提示词增量广播到其它窗口，
 * 实现 VLM 闭环结果的“多窗口一致性”。
 */
function broadcastItemPatch(itemId: string): void {
  try {
    const item = useAssetStore.getState().items.find((entry) => entry.id === itemId);
    if (!item) return;
    postAssetPatch({
      itemId,
      tags: item.tags,
      smartCategories: item.smartCategories,
      analysis: item.analysis,
      prompt: item.prompt,
      updatedAt: item.updatedAt,
    });
  } catch {
    /* 广播失败不应影响主流程 */
  }
}

function normalizeName(value: string, fallback: string) {
  const next = value.trim();
  return next || fallback;
}

function inferTypeFromUrl(url: string, fallback: AssetItem['type'] = 'image'): AssetItem['type'] {
  const normalized = url.toLowerCase();
  if (VIDEO_FILE_EXTENSION_PATTERN.test(normalized) || normalized.includes('video')) return 'video';
  if (AUDIO_FILE_EXTENSION_PATTERN.test(normalized) || normalized.includes('audio')) return 'audio';
  if (TEXT_FILE_EXTENSION_PATTERN.test(normalized)) return 'text';
  if (IMAGE_FILE_EXTENSION_PATTERN.test(normalized) || normalized.includes('image')) return 'image';
  return fallback;
}

function inferTypeFromMime(mimeType: string): AssetItem['type'] | '' {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.startsWith('video/')) return 'video';
  if (normalized.startsWith('audio/')) return 'audio';
  if (normalized.startsWith('text/') || normalized.includes('json') || normalized.includes('csv') || normalized.includes('pdf')) return 'text';
  if (normalized.startsWith('image/')) return 'image';
  return '';
}

function inferSupportedAssetType(file: Pick<File, 'name' | 'type'>): AssetItem['type'] | null {
  const fromMime = inferTypeFromMime(file.type || '');
  if (fromMime) return fromMime;
  const normalized = String(file.name || '').toLowerCase();
  if (VIDEO_FILE_EXTENSION_PATTERN.test(normalized)) return 'video';
  if (AUDIO_FILE_EXTENSION_PATTERN.test(normalized)) return 'audio';
  if (IMAGE_FILE_EXTENSION_PATTERN.test(normalized)) return 'image';
  if (TEXT_FILE_EXTENSION_PATTERN.test(normalized)) return 'text';
  return null;
}

function stripExtension(value: string) {
  return value.replace(/\.[^.]+$/, '');
}

function normalizeImportToken(value: string) {
  return String(value || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferImportFolderSegments(relativePath = '') {
  return uniq(
    String(relativePath || '')
      .split(/[\\/]+/)
      .slice(0, -1)
      .map((segment) => normalizeImportToken(segment))
      .filter((segment) => segment.length >= 2),
  ).slice(-4);
}

function inferNameFromUrl(url: string, fallbackPrefix = '网页素材') {
  try {
    const parsed = new URL(url);
    const last = decodeURIComponent(parsed.pathname.split('/').pop() || '');
    if (last) return last;
  } catch {
    const last = decodeURIComponent(url.split('/').pop() || '');
    if (last) return last.split('?')[0];
  }
  return `${fallbackPrefix}-${Date.now()}`;
}

function classifyFromText(text: string) {
  const content = text.toLowerCase();
  const matched = CATEGORY_RULES
    .filter((rule) => rule.keywords.some((keyword) => content.includes(keyword.toLowerCase())))
    .map((rule) => rule.category);
  return uniq(matched).slice(0, 4);
}

function inferCategories(item: {
  name: string;
  tags?: string[];
  prompt?: string;
  url?: string;
  sourceUrl?: string;
}) {
  const combined = [item.name, ...(item.tags || []), item.prompt || '', item.url || '', item.sourceUrl || ''].join(' ');
  const categories = classifyFromText(combined);
  return categories.length ? categories : ['待整理'];
}

function inferTags(item: {
  name: string;
  type: AssetItem['type'];
  tags?: string[];
  smartCategories?: string[];
  prompt?: string;
}) {
  const nameParts = stripExtension(item.name)
    .split(/[\s_\-.]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2)
    .slice(0, 3);
  return uniq([
    ...(item.tags || []),
    ...(item.smartCategories || []),
    ...nameParts,
    item.type === 'video' ? '视频' : item.type === 'audio' ? '音频' : item.type === 'text' ? '文档' : '图片',
    ...(item.prompt ? classifyFromText(item.prompt) : []),
  ]).slice(0, 8);
}

function buildFallbackReversePrompt(item?: Pick<AssetItem, 'type' | 'name' | 'tags' | 'smartCategories' | 'analysis'> | null) {
  const analyzedPrompt = String(item?.analysis?.promptZh || item?.analysis?.promptEn || '').trim();
  if (analyzedPrompt) return analyzedPrompt;
  const categories = item?.smartCategories?.length
    ? item.smartCategories
    : inferCategories({ name: item?.name || '', tags: item?.tags });
  const subjectText = categories.length > 0 ? categories.join('、') : '主体与场景';
  if (item?.type === 'video') {
    return `保持原视频的运镜、节奏和构图稳定，围绕 ${subjectText} 组织画面内容，强调主体一致性、风格统一、光影氛围与场景层次，适合作为视频生成、视频编辑或镜头参考提示词。`;
  }
  if (item?.type === 'audio') {
    return `生成一段贴合 ${subjectText} 氛围的音频素材，情绪自然、层次清晰、质感真实，可继续用于 BGM、音效或旁白制作。`;
  }
  return `基于参考画面保留主体与构图，围绕 ${subjectText} 强化风格、光影、色调、镜头感与材质细节，适合作为海报、KV 或图像生成提示词。`;
}

function buildImportHints(file: File, type: AssetItem['type']) {
  const relativePath = String((file as File & { webkitRelativePath?: string }).webkitRelativePath || '').trim();
  const folderSegments = inferImportFolderSegments(relativePath);
  const semanticCategories = classifyFromText([file.name, relativePath].join(' '));
  const smartCategories = uniq([
    ...semanticCategories,
    ...folderSegments.slice(0, 2),
  ]).slice(0, 6);
  const tags = inferTags({
    name: file.name,
    type,
    tags: folderSegments,
    smartCategories,
    prompt: relativePath,
  });
  return {
    relativePath,
    smartCategories,
    tags,
  };
}

async function readImageSize(url: string) {
  return await new Promise<{ width?: number; height?: number }>((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve({});
    image.src = url;
  });
}

async function readVideoMeta(url: string) {
  return await new Promise<{ width?: number; height?: number; duration?: number }>((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      resolve({
        width: Number.isFinite(video.videoWidth) ? video.videoWidth : undefined,
        height: Number.isFinite(video.videoHeight) ? video.videoHeight : undefined,
        duration: Number.isFinite(video.duration) ? Math.round(video.duration) : undefined,
      });
    };
    video.onerror = () => resolve({});
    video.src = url;
  });
}

async function readMediaDetails(type: AssetItem['type'], url: string): Promise<{ width?: number; height?: number; duration?: number }> {
  if (typeof window === 'undefined') return {};
  if (type === 'image') return await readImageSize(url);
  if (type === 'video') return await readVideoMeta(url);
  return {};
}

function normalizeAssetItem(input: Omit<AssetItem, 'id' | 'createdAt' | 'updatedAt'>): Omit<AssetItem, 'id' | 'createdAt' | 'updatedAt'> {
  const type = input.type || inferTypeFromUrl(input.url, 'image');
  const name = normalizeName(input.name, inferNameFromUrl(input.url, '素材'));
  const smartCategories = uniq(input.smartCategories?.length ? input.smartCategories : inferCategories({ ...input, name }));
  const tags = inferTags({ ...input, type, name, smartCategories });
  return {
    ...input,
    name,
    type,
    thumbnail: input.thumbnail || input.url,
    tags,
    smartCategories,
    folderId: input.folderId || 'root',
    size: Number.isFinite(Number(input.size)) ? Number(input.size) : 0,
    sourceUrl: input.sourceUrl || input.url,
  };
}

function normalizeStoredAssetItem(item: AssetItem): AssetItem {
  const type = item.type || inferTypeFromUrl(item.url, 'image');
  const name = normalizeName(item.name, inferNameFromUrl(item.url, '素材'));
  const smartCategories = uniq(item.smartCategories?.length ? item.smartCategories : inferCategories({
    name,
    tags: item.tags,
    prompt: item.prompt,
    url: item.url,
    sourceUrl: item.sourceUrl,
  }));
  const tags = inferTags({
    name,
    type,
    tags: item.tags,
    smartCategories,
    prompt: item.prompt,
  });
  return {
    ...item,
    name,
    type,
    thumbnail: item.thumbnail || item.url,
    folderId: String(item.folderId || 'root').trim() || 'root',
    smartCategories,
    tags,
    sourceUrl: item.sourceUrl || item.url,
    size: Number.isFinite(Number(item.size)) ? Number(item.size) : 0,
  };
}

function mergeAssetCollections(existingItems: AssetItem[], incomingItems: AssetItem[]) {
  const merged = new Map<string, AssetItem>();
  for (const item of existingItems) {
    merged.set(item.id, normalizeStoredAssetItem(item));
  }
  for (const item of incomingItems) {
    merged.set(item.id, normalizeStoredAssetItem(item));
  }
  return Array.from(merged.values()).sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
}

function isMediaFolderId(folderId: string | null | undefined) {
  return String(folderId || '').startsWith(MEDIA_FOLDER_PREFIX);
}

function isSmartFolderId(folderId: string | null | undefined) {
  return String(folderId || '').startsWith(SMART_FOLDER_PREFIX);
}

function folderMatchesAsset(item: AssetItem, folderId: string | null | undefined) {
  const normalizedFolderId = String(folderId || '').trim();
  if (!normalizedFolderId || normalizedFolderId === 'root') return true;
  if (isMediaFolderId(normalizedFolderId)) {
    const mediaType = normalizedFolderId.slice(MEDIA_FOLDER_PREFIX.length);
    return item.type === mediaType;
  }
  if (isSmartFolderId(normalizedFolderId)) {
    const category = decodeURIComponent(normalizedFolderId.slice(SMART_FOLDER_PREFIX.length));
    return item.smartCategories.includes(category);
  }
  return item.folderId === normalizedFolderId;
}

const IMAGE_SEARCH_RESULTS: SimilarImageResult = [
  { url: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=1600', thumb: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=400', title: '山脉风景', source: 'Unsplash', width: 1920, height: 1080 },
  { url: 'https://images.unsplash.com/photo-1469474968028-56623f02e42e?w=1600', thumb: 'https://images.unsplash.com/photo-1469474968028-56623f02e42e?w=400', title: '自然光景', source: 'Unsplash', width: 1600, height: 900 },
  { url: 'https://images.unsplash.com/photo-1447752875215-b2761acb3c5d?w=1600', thumb: 'https://images.unsplash.com/photo-1447752875215-b2761acb3c5d?w=400', title: '森林小径', source: 'Unsplash', width: 1200, height: 800 },
  { url: 'https://images.unsplash.com/photo-1501854140801-50d01698950b?w=1600', thumb: 'https://images.unsplash.com/photo-1501854140801-50d01698950b?w=400', title: '绿色丘陵', source: 'Unsplash', width: 1920, height: 1280 },
];

const VIDEO_SEARCH_RESULTS: SimilarVideoResult = [
  { url: 'https://storage.googleapis.com/coverr-main/mp4/Mt_Baker.mp4', thumb: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=400', title: '山景航拍', source: 'Coverr', duration: '0:15' },
  { url: 'https://storage.googleapis.com/coverr-main/mp4/Stream_Flow.mp4', thumb: 'https://images.unsplash.com/photo-1469474968028-56623f02e42e?w=400', title: '溪流流水', source: 'Coverr', duration: '0:12' },
  { url: 'https://storage.googleapis.com/coverr-main/mp4/City_Traffic.mp4', thumb: 'https://images.unsplash.com/photo-1514565131-fce0801e5785?w=400', title: '城市车流', source: 'Coverr', duration: '0:25' },
];

let suppressOperationHistory = false;

export const useAssetStore = create<AssetStore>()(
  persist(
    immer((set, get) => ({
    folders: defaultFolders,
    items: demoItems,
    selectedFolderId: 'root',
    importTargetFolderId: 'web',
    selectedItemIds: [],
    previewItemId: null,
    viewMode: 'grid',
    sortBy: 'date',
    searchQuery: '',
    isUploading: false,
    isProcessing: false,
    batchAnalyzeProgress: { total: 0, done: 0, running: false, failed: 0, failedItems: [] },
    analyzeConcurrency: 0,
    analyzeRetries: 2,
    operationHistory: [],
    storagePath: '',

    createFolder: (name, parentId = 'root') => {
      const id = uuidv4();
      set((state) => {
        state.folders.push({ id, name: normalizeName(name, '新建文件夹'), parentId: parentId || null, children: [], createdAt: Date.now() });
        const parent = state.folders.find((folder) => folder.id === parentId);
        if (parent) {
          parent.children.push(id);
        }
      });
      return id;
    },

    renameFolder: (folderId, newName) => {
      set((state) => {
        const folder = state.folders.find((entry) => entry.id === folderId);
        if (folder) {
          folder.name = normalizeName(newName, folder.name);
        }
      });
    },

    deleteFolder: (folderId) => {
      set((state) => {
        const folder = state.folders.find((entry) => entry.id === folderId);
        if (!folder || folderId === 'root') return;
        if (folder.parentId) {
          const parent = state.folders.find((entry) => entry.id === folder.parentId);
          if (parent) {
            parent.children = parent.children.filter((childId) => childId !== folderId);
          }
        }
        state.folders = state.folders.filter((entry) => entry.id !== folderId);
        state.items = state.items.map((item) => item.folderId === folderId ? { ...item, folderId: 'root', updatedAt: Date.now() } : item);
        if (state.selectedFolderId === folderId) {
          state.selectedFolderId = 'root';
        }
        if (state.importTargetFolderId === folderId) {
          state.importTargetFolderId = 'web';
        }
      });
    },

    moveFolder: (folderId, newParentId) => {
      set((state) => {
        const folder = state.folders.find((entry) => entry.id === folderId);
        if (!folder || folderId === 'root') return;
        if (folder.parentId) {
          const oldParent = state.folders.find((entry) => entry.id === folder.parentId);
          if (oldParent) {
            oldParent.children = oldParent.children.filter((childId) => childId !== folderId);
          }
        }
        folder.parentId = newParentId;
        if (newParentId) {
          const nextParent = state.folders.find((entry) => entry.id === newParentId);
          if (nextParent && !nextParent.children.includes(folderId)) {
            nextParent.children.push(folderId);
          }
        }
      });
    },

    selectFolder: (folderId) => {
      set((state) => {
        state.selectedFolderId = folderId;
        state.selectedItemIds = [];
        state.previewItemId = null;
      });
    },

    addItem: (item) => {
      const id = uuidv4();
      const normalized = normalizeAssetItem(item);
      set((state) => {
        state.items.unshift({
          ...normalized,
          id,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      });
      return id;
    },

    deleteItems: (itemIds) => {
      const removed = get().items.filter((item) => itemIds.includes(item.id)).map((item) => ({ ...item }));
      set((state) => {
        state.items = state.items.filter((item) => !itemIds.includes(item.id));
        state.selectedItemIds = state.selectedItemIds.filter((id) => !itemIds.includes(id));
        if (state.previewItemId && itemIds.includes(state.previewItemId)) {
          state.previewItemId = null;
        }
      });
      get().pushOperation({
        kind: 'delete',
        label: `删除 ${itemIds.length} 个素材`,
        payload: { ids: [...itemIds], items: removed },
      });
    },

    moveItems: (itemIds, targetFolderId) => {
      const fromFolderId = get().items.find((item) => itemIds.includes(item.id))?.folderId;
      set((state) => {
        state.items.forEach((item) => {
          if (itemIds.includes(item.id)) {
            item.folderId = targetFolderId;
            item.updatedAt = Date.now();
          }
        });
      });
      get().pushOperation({
        kind: 'move',
        label: `移动 ${itemIds.length} 个素材`,
        payload: { ids: [...itemIds], fromFolderId, toFolderId: targetFolderId },
      });
    },

    renameItem: (itemId, newName) => {
      set((state) => {
        const item = state.items.find((entry) => entry.id === itemId);
        if (item) {
          item.name = normalizeName(newName, item.name);
          item.updatedAt = Date.now();
        }
      });
    },

    selectItem: (itemId, multi = false) => {
      set((state) => {
        if (multi) {
          if (state.selectedItemIds.includes(itemId)) {
            state.selectedItemIds = state.selectedItemIds.filter((id) => id !== itemId);
          } else {
            state.selectedItemIds.push(itemId);
          }
        } else {
          state.selectedItemIds = [itemId];
        }
      });
    },

    selectPreviewItem: (itemId) => {
      set((state) => {
        state.previewItemId = itemId;
      });
    },

    clearSelection: () => {
      set((state) => {
        state.selectedItemIds = [];
      });
    },

    uploadFiles: async (files, folderId, options = {}) => {
      set((state) => {
        state.isUploading = true;
      });
      const targetFolderId = folderId || get().selectedFolderId || get().importTargetFolderId || 'root';
      const report: AssetUploadReport = {
        importedCount: 0,
        failedCount: 0,
        skippedCount: 0,
        duplicateCount: 0,
        folderImport: Boolean(options.folderImport),
        imageCount: 0,
        videoCount: 0,
        audioCount: 0,
        textCount: 0,
        autoTaggedCount: 0,
        autoClassifiedCount: 0,
      };

      try {
        for (const file of Array.from(files)) {
          try {
            const type = inferSupportedAssetType(file);
            if (!type) {
              report.skippedCount += 1;
              continue;
            }
            const importHints = buildImportHints(file, type);
            let mediaMeta: { width?: number; height?: number; duration?: number } = {};
            let metadataProbeHandle = '';
            try {
              metadataProbeHandle = registerLocalMedia(file);
              const renderUrl = resolveLocalMediaUrl(metadataProbeHandle) || metadataProbeHandle;
              mediaMeta = await readMediaDetails(type, renderUrl);
            } catch {
              mediaMeta = {};
            } finally {
              if (metadataProbeHandle) {
                revokeLocalMedia(metadataProbeHandle);
              }
            }

            try {
              const persistedImport = await enqueueLocalAssetPersistence(file, {
                folderId: targetFolderId,
                tags: importHints.tags,
                smartCategories: importHints.smartCategories,
                width: mediaMeta.width,
                height: mediaMeta.height,
                duration: mediaMeta.duration,
                sourceUrl: importHints.relativePath || file.name,
              });
              get().syncPersistedItems([persistedImport.item]);
              if (persistedImport.duplicate) {
                report.duplicateCount += 1;
              } else {
                report.importedCount += 1;
              }
            } catch {
              const localHandle = registerLocalMedia(file);
              get().addItem({
                name: file.name,
                type,
                url: localHandle,
                thumbnail: type === 'audio' ? '' : localHandle,
                folderId: targetFolderId,
                size: file.size,
                width: mediaMeta.width,
                height: mediaMeta.height,
                duration: mediaMeta.duration,
                tags: importHints.tags,
                smartCategories: importHints.smartCategories,
                source: 'upload',
                sourceUrl: importHints.relativePath || file.name,
              });
              report.importedCount += 1;
            }

            report.autoTaggedCount += Math.min(importHints.tags.length, 1);
            report.autoClassifiedCount += Math.min(importHints.smartCategories.length, 1);
            if (type === 'image') report.imageCount += 1;
            if (type === 'video') report.videoCount += 1;
            if (type === 'audio') report.audioCount += 1;
            if (type === 'text') report.textCount += 1;
          } catch {
            report.failedCount += 1;
          }
        }
        return report;
      } finally {
        set((state) => {
          state.isUploading = false;
        });
      }
    },

    autoClassify: async (itemId) => {
      set((state) => {
        state.isProcessing = true;
      });
      await new Promise((resolve) => window.setTimeout(resolve, 120));
      const item = get().items.find((entry) => entry.id === itemId);
      const categories = inferCategories({
        name: item?.name || '',
        tags: item?.tags,
        prompt: item?.prompt,
        url: item?.url,
        sourceUrl: item?.sourceUrl,
      });
      set((state) => {
        const target = state.items.find((entry) => entry.id === itemId);
        if (target) {
          target.smartCategories = uniqTags(categories);
          target.tags = uniqTags([...target.tags, ...categories]);
          target.updatedAt = Date.now();
        }
        state.isProcessing = false;
      });
      broadcastItemPatch(itemId);
      return categories;
    },

    legacyReversePrompt: async (itemId) => {
      set((state) => {
        state.isProcessing = true;
      });
      await new Promise((resolve) => window.setTimeout(resolve, 180));
      const item = get().items.find((entry) => entry.id === itemId);
      const generatedPrompt = buildFallbackReversePrompt(item);
      set((state) => {
        const target = state.items.find((entry) => entry.id === itemId);
        if (target) {
          target.prompt = generatedPrompt;
          target.updatedAt = Date.now();
        }
        state.isProcessing = false;
      });
      broadcastItemPatch(itemId);
      return generatedPrompt;
    },

    reversePrompt: async (itemId, options = {}) => {
      const item = get().items.find((entry) => entry.id === itemId);
      if (!item) throw new Error('asset-not-found');

      if (item.type === 'image') {
        const analysis = await get().analyzeImage(itemId, { engine: String(options.engine || 'auto') });
        const nextPrompt = String(analysis.promptZh || analysis.promptEn || buildFallbackReversePrompt(item)).trim();
        set((state) => {
          const target = state.items.find((entry) => entry.id === itemId);
          if (!target) return;
          target.prompt = nextPrompt;
          target.updatedAt = Date.now();
        });
        return nextPrompt;
      }

      set((state) => {
        state.isProcessing = true;
      });
      await new Promise((resolve) => window.setTimeout(resolve, 180));
      const generatedPrompt = buildFallbackReversePrompt(item);

      set((state) => {
        const target = state.items.find((entry) => entry.id === itemId);
        if (target) {
          target.prompt = generatedPrompt;
          target.updatedAt = Date.now();
        }
        state.isProcessing = false;
      });
      broadcastItemPatch(itemId);
      return generatedPrompt;
    },

    analyzeImage: async (itemId, options = {}) => {
      const item = get().items.find((entry) => entry.id === itemId);
      if (!item) throw new Error('asset-not-found');
      if (item.type !== 'image') throw new Error('only-image-assets-supported');

      set((state) => {
        state.isProcessing = true;
      });

      try {
        const analysis = await analyzeAssetImage({ item, engine: String(options.engine || 'auto') });
        // 统一走 applyImageAnalysis，保证面板与 reversePrompt 两条闭环路径一致
        get().applyImageAnalysis(itemId, analysis);
        return analysis;
      } finally {
        set((state) => {
          state.isProcessing = false;
        });
      }
    },

    /**
     * 将 VLM 分析结果落地到素材，并保证“跨标签一致性”：
     * - `analysis.keywords` 作为 VLM 标签的唯一权威来源；
     * - 重新分析时，移除上一次 VLM 写入但本次不再出现的旧关键词，仅保留用户手动标签；
     * - 标签统一做大小写不敏感去重，避免 “Cat”/“cat” 并存；
     * - 变更后广播给其他窗口，保证“多窗口一致性”。
     */
    applyImageAnalysis: (itemId, analysis) => {
      set((state) => {
        const target = state.items.find((entry) => entry.id === itemId);
        if (!target) return;
        const prevVlm = new Set((target.analysis?.keywords || []).map((keyword) => keyword.trim().toLowerCase()));
        const manualTags = target.tags.filter((tag) => !prevVlm.has(tag.trim().toLowerCase()));
        const newKeywords = analysis.keywords || [];
        const newCategories = classifyFromText([
          analysis.subject,
          analysis.scene,
          analysis.style,
          analysis.lighting,
          analysis.composition,
          analysis.camera,
          analysis.mood,
        ].join(' '));
        target.analysis = analysis;
        target.prompt = analysis.promptZh || target.prompt;
        target.smartCategories = uniqTags([...target.smartCategories, ...newCategories]);
        target.tags = uniqTags([...manualTags, ...newKeywords, ...newCategories]).slice(0, 16);
        target.updatedAt = Date.now();
      });
      broadcastItemPatch(itemId);
    },

    /**
     * 应用来自其它窗口的增量补丁（多窗口一致性）。
     * 仅在补丁不比本地更旧时应用，避免回退到过期状态。
     */
    applyCrossTabItemPatch: (itemId, patch) => {
      set((state) => {
        const target = state.items.find((entry) => entry.id === itemId);
        if (!target) return;
        if (
          typeof patch.updatedAt === 'number'
          && typeof target.updatedAt === 'number'
          && patch.updatedAt < target.updatedAt
        ) {
          return;
        }
        if (Array.isArray(patch.tags)) target.tags = uniqTags(patch.tags);
        if (Array.isArray(patch.smartCategories)) target.smartCategories = uniqTags(patch.smartCategories);
        if (patch.analysis !== undefined) target.analysis = patch.analysis;
        if (typeof patch.prompt === 'string') target.prompt = patch.prompt;
        target.updatedAt = patch.updatedAt ?? Date.now();
      });
    },

    addTag: (itemId, tag) => {
      const normalizedTag = tag.trim();
      if (!normalizedTag) return;
      set((state) => {
        const item = state.items.find((entry) => entry.id === itemId);
        if (item && !item.tags.some((existing) => existing.toLowerCase() === normalizedTag.toLowerCase())) {
          item.tags = uniqTags([...item.tags, normalizedTag]);
          item.smartCategories = uniqTags([...item.smartCategories, ...classifyFromText(normalizedTag)]);
          item.updatedAt = Date.now();
        }
      });
      broadcastItemPatch(itemId);
    },

    removeTag: (itemId, tag) => {
      const key = tag.trim().toLowerCase();
      set((state) => {
        const item = state.items.find((entry) => entry.id === itemId);
        if (item) {
          item.tags = item.tags.filter((entry) => entry.toLowerCase() !== key);
          item.updatedAt = Date.now();
        }
      });
      broadcastItemPatch(itemId);
    },

    batchAddTag: (itemIds, tag) => {
      const normalizedTag = (tag || '').trim();
      if (!normalizedTag) return;
      set((state) => {
        state.items.forEach((item) => {
          if (itemIds.includes(item.id) && !item.tags.some((existing) => existing.toLowerCase() === normalizedTag.toLowerCase())) {
            item.tags = uniqTags([...item.tags, normalizedTag]);
            item.smartCategories = uniqTags([...item.smartCategories, ...classifyFromText(normalizedTag)]);
            item.updatedAt = Date.now();
          }
        });
      });
      itemIds.forEach((id) => broadcastItemPatch(id));
      get().pushOperation({
        kind: 'tag',
        label: `为 ${itemIds.length} 个素材添加标签「${normalizedTag}」`,
        payload: { ids: [...itemIds], tag: normalizedTag },
      });
    },

    batchAutoClassify: async (itemIds) => {
      const snapshot = get().items
        .filter((item) => itemIds.includes(item.id))
        .map((item) => ({ id: item.id, smartCategories: [...item.smartCategories], tags: [...item.tags] }));
      for (const itemId of itemIds) {
        try {
          await get().autoClassify(itemId);
        } catch {
          // skip individual failures and continue with the rest
        }
      }
      // 纳入可撤销历史：记录分类前的分类/标签，便于一键还原
      get().pushOperation({
        kind: 'classify',
        label: `智能分类 ${itemIds.length} 个素材`,
        payload: { ids: [...itemIds], prevCategories: snapshot },
      });
    },

    batchAnalyzeImages: async (itemIds, options = {}) => {
      const targets = get().items.filter((item) => itemIds.includes(item.id) && item.type === 'image');
      const total = targets.length;
      if (total === 0) return;
      // 并发自适应：未显式指定时按选中数量自适应（>20 提高到 5），否则用偏好值
      const storeConcurrency = get().analyzeConcurrency;
      const storeRetries = get().analyzeRetries;
      const requestedConcurrency = options.concurrency != null ? Number(options.concurrency) : NaN;
      const requestedRetries = options.retries != null ? Number(options.retries) : NaN;
      const effectiveConcurrency = Number.isFinite(requestedConcurrency)
        ? Math.max(1, requestedConcurrency)
        : (storeConcurrency > 0 ? storeConcurrency : (total > 20 ? 5 : 3));
      const effectiveRetries = Number.isFinite(requestedRetries)
        ? Math.max(0, requestedRetries)
        : (storeRetries > 0 ? storeRetries : 1);

      set((state) => {
        state.batchAnalyzeProgress = { total, done: 0, running: true, failed: 0, failedItems: [] };
      });

      let cursor = 0;
      let done = 0;
      let failed = 0;
      const runOne = async (item: typeof targets[number]) => {
        let lastError = '';
        for (let attempt = 0; attempt <= effectiveRetries; attempt += 1) {
          try {
            await get().analyzeImage(item.id, { engine: 'auto' });
            return;
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
          }
        }
        failed += 1;
        set((state) => {
          state.batchAnalyzeProgress.failedItems.push({ id: item.id, name: item.name, error: lastError });
        });
      };
      const worker = async () => {
        for (;;) {
          const index = cursor;
          if (index >= total) break;
          cursor += 1;
          const item = targets[index];
          if (!item) break;
          await runOne(item);
          done += 1;
          set((state) => {
            state.batchAnalyzeProgress.done = done;
            state.batchAnalyzeProgress.failed = failed;
          });
        }
      };

      const pool = Array.from({ length: Math.min(effectiveConcurrency, total) }, () => worker());
      await Promise.all(pool);
      set((state) => {
        state.batchAnalyzeProgress.running = false;
      });
    },

    setAnalyzeConcurrency: (value) => set((state) => {
      state.analyzeConcurrency = Math.max(0, Number(value) || 0);
    }),

    setAnalyzeRetries: (value) => set((state) => {
      state.analyzeRetries = Math.max(0, Number(value) || 0);
    }),

    detectDuplicates: () => {
      let duplicateCount = 0;
      const seen = new Map<string, string>();
      set((state) => {
        state.items.forEach((item) => {
          item.duplicateOf = undefined;
        });
        for (const item of state.items) {
          const key = assetFingerprint(item);
          if (!key) continue;
          const canonical = seen.get(key);
          if (canonical && canonical !== item.id) {
            item.duplicateOf = canonical;
            duplicateCount += 1;
          } else if (!canonical) {
            seen.set(key, item.id);
          }
        }
      });
      return duplicateCount;
    },

    clearDuplicateFlags: () => {
      set((state) => {
        state.items.forEach((item) => {
          item.duplicateOf = undefined;
        });
      });
    },

    applyServerDuplicates: (groups) => {
      let duplicateCount = 0;
      const duplicateToCanonical = new Map<string, string>();
      for (const group of groups) {
        for (const dupId of group.duplicateIds) {
          duplicateToCanonical.set(dupId, group.canonicalId);
        }
      }
      set((state) => {
        state.items.forEach((item) => {
          const canonical = duplicateToCanonical.get(item.id);
          if (canonical) {
            item.duplicateOf = canonical;
            duplicateCount += 1;
          } else {
            item.duplicateOf = undefined;
          }
        });
      });
      return duplicateCount;
    },

    removeDuplicateItems: (ids) => {
      // ids 为空时合并全部重复项；传入 ids 时只合并指定分组（用于「合并这组」）。
      const idFilter = Array.isArray(ids) && ids.length ? new Set(ids.map((value) => String(value))) : null;
      let removedCount = 0;
      const persistedAssetIds: string[] = [];
      const duplicateIds: string[] = [];
      const removedItems: AssetItem[] = [];
      set((state) => {
        const targets = state.items.filter(
          (item) => Boolean(item.duplicateOf) && (!idFilter || idFilter.has(String(item.id || ''))),
        );
        for (const item of targets) {
          duplicateIds.push(item.id);
          removedItems.push({ ...item });
          if (item.backendAssetId) persistedAssetIds.push(item.backendAssetId);
          removedCount += 1;
        }
        const removeSet = new Set(duplicateIds);
        state.items = state.items.filter((item) => !removeSet.has(item.id));
        if (state.previewItemId && removeSet.has(state.previewItemId)) {
          state.previewItemId = null;
        }
        state.selectedItemIds = state.selectedItemIds.filter((id) => !removeSet.has(id));
      });
      if (persistedAssetIds.length > 0) {
        void deletePersistedAssets(persistedAssetIds).catch(() => undefined);
      }
      // 纳入可撤销历史：合并本质是把重复项删除，仅保留原图
      get().pushOperation({
        kind: 'merge',
        label: `合并重复 ${removedCount} 个素材（仅留原图）`,
        payload: { ids: [...duplicateIds], items: removedItems },
      });
      return removedCount;
    },

    pushOperation: (record) => {
      if (suppressOperationHistory) return;
      const id = uuidv4();
      set((state) => {
        state.operationHistory = [
          { ...record, id, createdAt: Date.now() },
          ...state.operationHistory,
        ].slice(0, 30);
      });
    },

    undoLastOperation: () => {
      const last = get().operationHistory[0];
      if (!last) return null;
      set((state) => {
        state.operationHistory = state.operationHistory.slice(1);
      });
      suppressOperationHistory = true;
      try {
        if (last.kind === 'move' && last.payload.ids && last.payload.fromFolderId != null) {
          get().moveItems(last.payload.ids, last.payload.fromFolderId);
        } else if (last.kind === 'tag' && last.payload.ids && last.payload.tag) {
          last.payload.ids.forEach((id) => get().removeTag(id, last.payload.tag as string));
        } else if (last.kind === 'classify' && last.payload.prevCategories) {
          set((state) => {
            const byId = new Map(last.payload.prevCategories!.map((entry) => [entry.id, entry]));
            state.items.forEach((item) => {
              const prev = byId.get(item.id);
              if (prev) {
                item.smartCategories = [...prev.smartCategories];
                item.tags = [...prev.tags];
                item.updatedAt = Date.now();
              }
            });
          });
        } else if ((last.kind === 'delete' || last.kind === 'merge') && last.payload.items) {
          set((state) => {
            const existing = new Set(state.items.map((item) => item.id));
            last.payload.items?.forEach((item) => {
              if (!existing.has(item.id)) state.items.unshift({ ...item });
            });
          });
          // 云端文件找回：对已落库（含 backendAssetId）的删除项，异步从回收站恢复物理文件。
          const persistedRestores = (last.payload.items || []).filter((item) => Boolean(item.backendAssetId));
          if (persistedRestores.length > 0) {
            void restorePersistedAssets(persistedRestores).catch(() => undefined);
          }
        }
      } finally {
        suppressOperationHistory = false;
      }
      return last.label;
    },

    searchSimilarImages: async (query) => {
      await new Promise((resolve) => window.setTimeout(resolve, 50));
      const state = get();
      // 基于标签/分类查找本地相似图片
      const similar = findSimilarAssetsInLibrary(
        { id: '__query__', name: query, type: 'image', url: '', thumbnail: '', folderId: 'root', size: 0, tags: query.split(/\s+/), smartCategories: [], source: 'upload', createdAt: Date.now(), updatedAt: Date.now() },
        state.items.filter((i) => i.type === 'image'),
        8,
      );
      return similar.map((r) => ({
        url: r.item.url,
        thumb: r.item.thumbnail || r.item.url,
        title: r.item.name,
        source: '本地相似',
        width: r.item.width,
        height: r.item.height,
      }));
    },

    searchSimilarVideos: async (query) => {
      await new Promise((resolve) => window.setTimeout(resolve, 50));
      const state = get();
      const similar = findSimilarAssetsInLibrary(
        { id: '__query__', name: query, type: 'video', url: '', thumbnail: '', folderId: 'root', size: 0, tags: query.split(/\s+/), smartCategories: [], source: 'upload', createdAt: Date.now(), updatedAt: Date.now() },
        state.items.filter((i) => i.type === 'video'),
        8,
      );
      return similar.map((r) => ({
        url: r.item.url,
        thumb: r.item.thumbnail || r.item.url,
        title: r.item.name,
        source: '本地相似',
        duration: r.item.duration ? `${r.item.duration}s` : undefined,
      }));
    },

    crawlImage: async (url, folderId) => {
      return await get().collectFromUrl(url, { folderId: folderId || 'web', type: 'image' });
    },

    importFromWeb: (item) => {
      return get().addItem({
        name: item.name,
        type: item.type,
        url: item.url,
        thumbnail: item.thumbnail,
        folderId: item.folderId || get().importTargetFolderId || 'web',
        size: 0,
        width: item.width,
        height: item.height,
        tags: item.tags || [],
        smartCategories: item.smartCategories || [],
        source: 'web',
        sourceUrl: item.url,
      });
    },

    setImportTargetFolder: (folderId) => {
      set((state) => {
        state.importTargetFolderId = folderId;
      });
    },

    collectFromUrl: async (url, options) => {
      const cleanedUrl = String(url || '').trim();
      if (!cleanedUrl) {
        throw new Error('empty-url');
      }
      const type = options?.type || inferTypeFromUrl(cleanedUrl, 'image');
      const name = normalizeName(options?.title || inferNameFromUrl(cleanedUrl, '网页素材'), inferNameFromUrl(cleanedUrl, '网页素材'));
      const folderId = options?.folderId || get().importTargetFolderId || 'web';
      const mediaMeta = /^https?:\/\//i.test(cleanedUrl) ? {} : await readMediaDetails(type, cleanedUrl);
      try {
        const persistedImport = await importRemoteAsset(cleanedUrl, {
          name,
          type,
          folderId,
          tags: options?.tags || [],
          smartCategories: options?.smartCategories || [],
          width: mediaMeta.width,
          height: mediaMeta.height,
          duration: mediaMeta.duration,
        });
        get().syncPersistedItems([persistedImport.item]);
        return persistedImport.item.id;
      } catch {
        return get().addItem({
          name,
          type,
          url: cleanedUrl,
          thumbnail: type === 'audio' ? '' : cleanedUrl,
          folderId,
          size: 0,
          width: mediaMeta.width,
          height: mediaMeta.height,
          duration: mediaMeta.duration,
          tags: options?.tags || [],
          smartCategories: options?.smartCategories || [],
          source: 'crawl',
          sourceUrl: cleanedUrl,
        });
      }
    },

    setViewMode: (mode) => set((state) => {
      state.viewMode = mode;
    }),
    setSortBy: (sort) => set((state) => {
      state.sortBy = sort;
    }),
    setSearchQuery: (query) => set((state) => {
      state.searchQuery = query;
    }),
    setStoragePath: (storagePath) => set((state) => {
      state.storagePath = String(storagePath || '');
    }),
    syncPersistedItems: (items) => set((state) => {
      state.items = mergeAssetCollections(state.items, items.map((item) => normalizeStoredAssetItem(item)));
    }),

    getItemsInFolder: (folderId) => {
      const state = get();
      const effectiveFolder = folderId ?? state.selectedFolderId;
      let items = state.items;
      if (effectiveFolder && effectiveFolder !== 'root') {
        items = items.filter((item) => folderMatchesAsset(item, effectiveFolder));
      }
      if (state.searchQuery.trim()) {
        const results = enhancedSearch(items, state.searchQuery, { maxResults: 500 });
        items = results.map((r) => r.item);
      }
      return [...items].sort((a, b) => {
        if (state.sortBy === 'name') return a.name.localeCompare(b.name, 'zh-CN');
        if (state.sortBy === 'size') return b.size - a.size;
        return b.updatedAt - a.updatedAt;
      });
    },

    getSelectedItems: () => {
      const state = get();
      return state.items.filter((item) => state.selectedItemIds.includes(item.id));
    },

    getPreviewItem: () => {
      const state = get();
      return state.items.find((item) => item.id === state.previewItemId) || null;
    },

    getFolderPath: (folderId) => {
      const folders = get().folders;
      const path: AssetFolder[] = [];
      let current = folders.find((folder) => folder.id === folderId);
      while (current) {
        path.unshift(current);
        current = current.parentId ? folders.find((folder) => folder.id === current?.parentId) : undefined;
      }
      return path;
    },

    getSmartCategories: () => {
      const counts: Record<string, { name: string; count: number; type: string }> = {};
      get().items.forEach((item) => {
        item.smartCategories.forEach((category) => {
          if (!counts[category]) {
            counts[category] = { name: category, count: 0, type: 'tag' };
          }
          counts[category].count += 1;
        });
      });
      return Object.values(counts).sort((a, b) => b.count - a.count);
    },
    })),
    {
      name: 'hmdao-asset-library',
      partialize: (state) => ({
        folders: state.folders,
        items: state.items,
        selectedItemIds: state.selectedItemIds,
        operationHistory: state.operationHistory,
        analyzeConcurrency: state.analyzeConcurrency,
        analyzeRetries: state.analyzeRetries,
      }),
      // 重水合（页面刷新/重新登录）后：
      // 1) 按 id 补齐图片节点专用文件夹（不覆盖用户重命名/删除）；
      // 2) 从 IndexedDB 恢复本地媒体句柄映射，使持久化的 hmdao-local:// 句柄能继续解析。
      onRehydrateStorage: () => (state) => {
        if (state) {
          const merged = withImageNodeFolders(state.folders);
          if (merged !== state.folders) {
            useAssetStore.setState({ folders: merged });
          }
        }
        void hydrateLocalMediaRegistry();
      },
    },
  ),
);

// 多窗口一致性：订阅其它标签页发来的资产补丁（VLM 分析 / 打标结果），
// 将其应用到本窗口的内存 store，使各窗口的标签与分析始终保持一致。
if (typeof window !== 'undefined') {
  onAssetPatch((patch) => {
    if (patch?.itemId) {
      useAssetStore.getState().applyCrossTabItemPatch(patch.itemId, patch);
    }
  });
}
