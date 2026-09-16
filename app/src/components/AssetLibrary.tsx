import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import {
  CheckSquare,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Copy,
  Edit3,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Grid3X3,
  Image as ImageIcon,
  List,
  Loader2,
  LogIn,
  Music,
  Play,
  Plus,
  Search,
  Sparkles,
  Square,
  Tag,
  Trash2,
  Upload,
  Video,
  Wand2,
  X,
  Brain,
  Box,
  ClipboardPaste,
  RefreshCw,
  Globe,
} from 'lucide-react';
import { useAssetStore } from '@/store/useAssetStore';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/store/useAuthStore';
import { useCanvasStore } from '@/store/useCanvasStore';
import {
  detectHmdaoExtension,
  onExtensionWebAssetsImported,
  openExtensionScan,
  startExtensionPresenceWatch,
  recheckExtensionPresence,
  getExtensionDetectionDiagnostics,
  isExtensionDetected,
  type ExtensionAssetRef,
} from '@/services/extensionBridge';
import {
  ANALYSIS_ENGINE_GROUPS,
  findAnalysisEngineOption,
  getImageAnalysisEngineOptions,
  type AnalysisEngineOption,
} from '@/config/analysisModelOptions';
import { EXTENSION_STORE_URL } from '@/config/extensionStore';
import { SHOW_DEV_INSTALL } from '@/config/environment';

import { SourceBadge } from '@/components/SourceBadge';

import { useByokRuntimeStore } from '@/store/useByokRuntimeStore';
import {
  deletePersistedAssets,
  fetchAssetDuplicates,
  fetchAssetLibrarySettings,
  fetchPersistedAssetCatalog,
  fetchPersistedAssetDuplicates,
  pruneMissingAssets,
  importAssetDirectory,
  pickAssetLibraryDirectory,
  repairPersistedAsset,
  saveAssetLibrarySettings,
  validatePersistedAsset,
} from '@/api/assetLibrary';
import { toRenderableAssetUrl } from '@/services/generation';
import { prepareFreeImport } from '@/services/freeImageSearchService';
import { parseFileNameSemantics } from '@/services/autoClassifier';
import { AssetSearchBar } from './AssetSearchBar';
import { LocalSimilarPanel } from './LocalSimilarPanel';
import { AIDeepAnalysisPanel } from './AIDeepAnalysisPanel';
import type { AssetFolder, AssetItem, AIDeepAnalysis, WebSearchResult } from '@/types/assets';
import { useUILanguage } from '@/i18n/ui';


import {
  buildFolderImportStatusMessage,
  formatBytes,
  formatDuration,
  getAssetBadge,
  getAssetDirectoryPickerTestPath,
  getAssetExtension,
  getAssetNodeType,
  isPreviewLimitedImageAsset,
  MEDIA_FOLDER_IDS,
  normalizeStoragePathValue,
  sanitizeNodeLabel,
  type AssetTab,
  type ContextMenuState,
} from './AssetLibrary.shared';
export function AssetLibrary() {
  const { isZh } = useUILanguage();
  const byokRuntime = useByokRuntimeStore((state) => state.runtime);
  const fetchByokRuntime = useByokRuntimeStore((state) => state.fetchRuntime);
  const {
    folders,
    items,
    selectedFolderId,
    importTargetFolderId,
    selectFolder,
    createFolder,
    renameFolder,
    deleteFolder,
    uploadFiles,
    selectedItemIds,
    selectItem,
    selectPreviewItem,
    clearSelection,
    viewMode,
    sortBy,
    setViewMode,
    searchQuery,
    setSearchQuery,
    setSortBy,
    getItemsInFolder,
    getPreviewItem,
    getSmartCategories,
    isUploading,
    isProcessing,
    analyzeImage,
    applyImageAnalysis,
    deleteItems,
    moveItems,
    storagePath,
    setStoragePath,
    syncPersistedItems,
    addTag,
    removeTag,
    renameItem,
    autoClassify,
    batchAddTag,
    batchAutoClassify,
    batchAnalyzeImages,
    batchAnalyzeProgress,
    analyzeConcurrency,
    analyzeRetries,
    setAnalyzeConcurrency,
    setAnalyzeRetries,
    detectDuplicates,
    applyServerDuplicates,
    clearDuplicateFlags,
    removeDuplicateItems,
    undoLastOperation,
    operationHistory,
    setImportTargetFolder,
    collectFromUrl,
  } = useAssetStore();

  const addNode = useCanvasStore((state) => state.addNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const setSelectedNodeIds = useCanvasStore((state) => state.setSelectedNodeIds);
  const workflows = useCanvasStore((state) => state.workflows);
  const loadWorkflow = useCanvasStore((state) => state.loadWorkflow);
  const deleteWorkflow = useCanvasStore((state) => state.deleteWorkflow);
  const renameWorkflow = useCanvasStore((state) => state.renameWorkflow);

  const previewItem = getPreviewItem();
  const smartCategories = getSmartCategories();

  // 切换预览素材时清空上一次的诊断结果，避免误显示。
  useEffect(() => {
    setPreviewIssue(null);
    setPreviewValidating(false);
  }, [previewItem?.id]);

  // 自愈：清理图库里指向已被删除/重置的后端内容（/api/assets/content/<id>）的死引用，
  // 避免这些素材反复发起 GET 请求导致控制台 404。
  useEffect(() => {
    void useAssetStore.getState().pruneMissingBackendAssets();
  }, []);

  const [activeTab, setActiveTab] = useState<AssetTab>('images');
  const [showExtInstall, setShowExtInstall] = useState(false);
  const [extDiag, setExtDiag] = useState(getExtensionDetectionDiagnostics);

  useEffect(() => {
    startExtensionPresenceWatch();
  }, []);
  const [reverseSearchItem, setReverseSearchItem] = useState<{ id: string; url: string; name: string; type: string } | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(['root']));
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [folderRenameId, setFolderRenameId] = useState<string | null>(null);
  const [folderRenameValue, setFolderRenameValue] = useState('');
  const [itemRenameValue, setItemRenameValue] = useState('');
  const [editingItemName, setEditingItemName] = useState(false);
  const [newTagValue, setNewTagValue] = useState('');
  const [urlCollectValue, setUrlCollectValue] = useState('');
  const [urlCollectName, setUrlCollectName] = useState('');
  const [isCollectingUrl, setIsCollectingUrl] = useState(false);
  const [analyzingItemId, setAnalyzingItemId] = useState<string | null>(null);
  const [imageAnalysisEngine, setImageAnalysisEngine] = useState<string>('auto');
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [hoveredVideo, setHoveredVideo] = useState<string | null>(null);
  const [gridCols, setGridCols] = useState(4);
  const [workflowRenameId, setWorkflowRenameId] = useState<string | null>(null);
  const [workflowRenameValue, setWorkflowRenameValue] = useState('');
  const [storageDraft, setStorageDraft] = useState('');
  const [defaultStoragePath, setDefaultStoragePath] = useState('');
  const [storageStatus, setStorageStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [importStatus, setImportStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [isSavingStoragePath, setIsSavingStoragePath] = useState(false);
  const [isPickingStoragePath, setIsPickingStoragePath] = useState(false);
  const [isImportingFolder, setIsImportingFolder] = useState(false);
  const [isLoadingAssetLibrary, setIsLoadingAssetLibrary] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);
  const isAuthed = useAuthStore((state) => state.isAuthenticated());
  const navigate = useNavigate();
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [showDuplicatesOnly, setShowDuplicatesOnly] = useState(false);
  const [batchTagInput, setBatchTagInput] = useState('');
  const [batchMoveFolderId, setBatchMoveFolderId] = useState<string>(importTargetFolderId);
  const [duplicateCount, setDuplicateCount] = useState(0);
  const [duplicateGroups, setDuplicateGroups] = useState<Array<{ canonicalId: string; duplicateIds: string[]; name?: string; type?: string }>>([]);
  const [showMergeConfirm, setShowMergeConfirm] = useState(false);
  const [showFailureList, setShowFailureList] = useState(false);
  const [analyzeScopeNote, setAnalyzeScopeNote] = useState('');

  // 预览自愈：图片/视频加载失败时诊断（缺失/损坏/格式），并提供删除或转码修复。
  const [previewIssue, setPreviewIssue] = useState<{ state: 'missing' | 'corrupted' | 'reference' | 'ok'; canTranscode: boolean; detail?: string } | null>(null);
  const [previewValidating, setPreviewValidating] = useState(false);
  const [previewRepairToken, setPreviewRepairToken] = useState(0);
  // 网格缩略图加载失败（多为 /api/assets/content/<id> 后端已删除的死引用 404）时静默降级，
  // 用占位图标替代坏图，避免控制台持续刷 404；自愈逻辑（pruneMissingBackendAssets）会后续清理条目。
  const [brokenImageIds, setBrokenImageIds] = useState<Set<string>>(new Set());
  const handleGridImageError = useCallback((id: string) => {
    setBrokenImageIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);
  // 双击缩放：预览面板中图片/视频放大到原始尺寸查看细节
  const [previewZoomed, setPreviewZoomed] = useState(false);

  // 自定义拖拽缩放：预览面板宽度（px），替代 react-resizable-panels
  const [previewWidth, setPreviewWidth] = useState(360);
  const [isResizingPreview, setIsResizingPreview] = useState(false);
  const resizeStartRef = useRef<{ x: number; width: number } | null>(null);

  // 新增：AI 分析与本地相似面板
  const [showAIAnalysis, setShowAIAnalysis] = useState(false);
  const [showLocalSimilar, setShowLocalSimilar] = useState(true);
  const [aiAnalysisResult, setAiAnalysisResult] = useState<AIDeepAnalysis | null>(null);

  // 浏览器扩展：把扫描到的网页资源导入本地素材库（collectFromUrl 会下载为本地 hmdao-local:// 句柄，画布只读本地句柄）
  const setSidebarTab = useCanvasStore((s) => s.setSidebarTab);
  const importWebAssetsFromExtension = useCallback(async (assets: ExtensionAssetRef[]) => {
    const store = useAssetStore.getState();
    let ok = 0;
    for (const a of assets) {
      try {
        await store.collectFromUrl(a.url, {
          type: (a.type === 'model' ? 'image' : a.type) as 'image' | 'video' | 'audio',
          source: 'web',
          pageUrl: a.pageUrl || '',
          name: a.name || '',
        });
        ok += 1;
      } catch (err) {
        console.error('[ext-import] 导入失败', a.url, err);
      }
    }
    if (ok > 0) setImportStatus({ type: 'success', message: `已通过浏览器扩展导入 ${ok} 个本地素材` });
  }, []);
  useEffect(
    () => onExtensionWebAssetsImported((assets) => void importWebAssetsFromExtension(assets)),
    [importWebAssetsFromExtension],
  );

  const fileInputRef = useRef<HTMLInputElement>(null);
  const directoryInputRef = useRef<HTMLInputElement>(null);
  const gridContainerRef = useRef<HTMLDivElement>(null);
  const videoRefs = useRef<Record<string, HTMLVideoElement | null>>({});
  const hoverTimers = useRef<Record<string, number>>({});
  const stopAllPreviewVideos = useCallback(() => {
    Object.values(videoRefs.current).forEach((video) => {
      if (!video) return;
      try {
        video.pause();
        video.currentTime = 0;
      } catch {
        // Ignore preview cleanup failures.
      }
    });
    setHoveredVideo(null);
  }, []);

  const focusImportedItems = useCallback((incomingItems: AssetItem[]) => {
    const resolvedItems = incomingItems.filter(Boolean);
    if (!resolvedItems.length) return;
    const firstVisibleItem = resolvedItems.find((item) => item.type === 'image')
      || resolvedItems.find((item) => item.type === 'video')
      || resolvedItems.find((item) => item.type === 'audio')
      || resolvedItems[0];
    setSearchQuery('');
    selectFolder(firstVisibleItem.folderId || 'root');
    if (firstVisibleItem.type === 'video') setActiveTab('videos');
    else if (firstVisibleItem.type === 'audio') setActiveTab('audio');
    else if (firstVisibleItem.type === 'text') setActiveTab('prompts');
    else setActiveTab('images');
    selectItem(firstVisibleItem.id, false);
    selectPreviewItem(firstVisibleItem.id);
  }, [selectFolder, selectItem, selectPreviewItem, setSearchQuery]);

  // 剪贴板粘贴采集
  const handlePasteCollection = useCallback(async (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items?.length) return;

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (blob) {
          try {
            await uploadFiles(
              [blob] as unknown as FileList,
              selectedFolderId || importTargetFolderId || 'web',
            );
          } catch { /* ignore paste errors */ }
        }
        return;
      }
    }

    // 检测粘贴的图片 URL
    const text = e.clipboardData?.getData('text/plain');
    if (text && /^https?:\/\/.+\.(png|jpe?g|webp|gif|svg|avif|bmp)(\?.*)?$/i.test(text.trim())) {
      e.preventDefault();
      const url = text.trim();
      const parsed = parseFileNameSemantics(url.split('/').pop() || url);
      try {
        await collectFromUrl(url, {
          folderId: selectedFolderId || importTargetFolderId || 'web',
          type: 'image',
          title: parsed.category !== '未分类' ? parsed.category : '粘贴采集',
          tags: parsed.tags,
          smartCategories: parsed.category !== '未分类' ? [parsed.category] : [],
        });
      } catch { /* ignore */ }
    }
  }, [uploadFiles, selectedFolderId, importTargetFolderId, collectFromUrl]);

  useEffect(() => {
    document.addEventListener('paste', handlePasteCollection);
    return () => document.removeEventListener('paste', handlePasteCollection);
  }, [handlePasteCollection]);

  const refreshPersistedCatalog = useCallback(async (preferredItems: AssetItem[] = []) => {
    const catalog = await fetchPersistedAssetCatalog();
    const catalogItems = catalog.items || [];
    syncPersistedItems(catalogItems);
    if (!preferredItems.length) return catalogItems;
    const preferredIds = new Set(preferredItems.map((item) => item.id));
    const matchedItems = catalogItems.filter((item) => preferredIds.has(item.id));
    return matchedItems.length ? matchedItems : catalogItems;
  }, [syncPersistedItems]);

  const [isPruningMissing, setIsPruningMissing] = useState(false);
  const [pruneMessage, setPruneMessage] = useState<string | null>(null);

  // 清理素材目录中“本地文件已缺失”的死引用条目（避免 /api/assets/content/<id> 反复 404）。
  const handlePruneMissing = useCallback(async () => {
    if (isPruningMissing) return;
    setIsPruningMissing(true);
    setPruneMessage(null);
    try {
      const result = await pruneMissingAssets();
      await refreshPersistedCatalog();
      setPruneMessage(
        result.removedCount > 0
          ? `已清理 ${result.removedCount} 条失效素材引用，当前保留 ${result.keptCount} 条。`
          : `未发现失效素材引用，目录共 ${result.keptCount} 条均有效。`,
      );
    } catch (error) {
      setPruneMessage(`清理失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsPruningMissing(false);
    }
  }, [isPruningMissing, refreshPersistedCatalog]);

  useEffect(() => {
    const item = previewItem;
    setItemRenameValue(item?.name || '');
    setEditingItemName(false);
    setNewTagValue('');
    setPreviewZoomed(false); // 切换素材时重置缩放
  }, [previewItem?.id]);

  useEffect(() => {
    if (reverseSearchItem && !items.some((item) => item.id === reverseSearchItem.id)) {
      setReverseSearchItem(null);
    }
  }, [items, reverseSearchItem]);

  useEffect(() => {
    const container = gridContainerRef.current;
    if (!container) return;
    // 延迟到下一帧 + 二次测量：避免 ResizeObserver 在 ResizablePanel 还没完成 layout 时
    // 拿到错误的初始宽度（典型 0px），导致 gridCols 永久被锁在 1。
    let observer: ResizeObserver | null = null;
    const measure = () => {
      const width = container.getBoundingClientRect().width;
      if (!width || width < 200) return; // 忽略明显未就绪的测量值
      if (width >= 960) setGridCols(6);
      else if (width >= 760) setGridCols(5);
      else if (width >= 580) setGridCols(4);
      else if (width >= 420) setGridCols(3);
      else setGridCols(2); // 最少 2 列，避免 <280px 极端情况下变成 1 张大图
    };
    const raf1 = requestAnimationFrame(() => {
      measure();
      // 第二帧再测一次，确保 flex/grid layout 已稳定
      requestAnimationFrame(measure);
      observer = new ResizeObserver(measure);
      observer.observe(container);
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (observer) observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const input = directoryInputRef.current;
    if (!input) return;
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
    input.setAttribute('multiple', '');
  }, []);

  useEffect(() => {
    const timers = hoverTimers.current;
    return () => {
      Object.values(timers).forEach((timer) => window.clearTimeout(timer));
      stopAllPreviewVideos();
    };
  }, [stopAllPreviewVideos]);

  useEffect(() => {
    return () => {
      stopAllPreviewVideos();
    };
  }, [stopAllPreviewVideos]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopAllPreviewVideos();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [stopAllPreviewVideos]);

  useEffect(() => {
    let cancelled = false;
    // 未登录：直接引导登录，避免发起请求后向用户展示 401
    if (!isAuthed) {
      setNeedsLogin(true);
      setIsLoadingAssetLibrary(false);
      return;
    }
    setNeedsLogin(false);
    setIsLoadingAssetLibrary(true);
    setStorageStatus(null);
    void (async () => {
      try {
        const [settings, catalog] = await Promise.all([
          fetchAssetLibrarySettings(),
          fetchPersistedAssetCatalog(),
        ]);
        if (cancelled) return;
        setStoragePath(settings.storagePath);
        setStorageDraft(settings.storagePath);
        setDefaultStoragePath(settings.defaultStoragePath);
        syncPersistedItems(catalog.items || []);
      } catch (error) {
        if (cancelled) return;
        // 已登录但会话过期（token 失效）也会返回 401，引导重新登录而非显示技术性错误
        const msg = error instanceof Error ? error.message : '';
        if (msg.includes('401') || msg.toLowerCase().includes('unauthorized')) {
          setNeedsLogin(true);
        } else {
          setStorageStatus({
            type: 'error',
            message: error instanceof Error ? error.message : '加载资产库配置失败。',
          });
        }
      } finally {
        if (!cancelled) {
          setIsLoadingAssetLibrary(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setStoragePath, syncPersistedItems, isAuthed]);

  useEffect(() => {
    setStorageDraft(storagePath || '');
  }, [storagePath]);

  const renderAssetUrl = useCallback((item: AssetItem) => {
    // 远程/采集素材把来源页 URL 作为 referer 转发，绕过仅依赖 Referer 的防盗链。
    const referer = item.sourceUrl || '';
    if (item.type === 'video') return toRenderableAssetUrl(item.url, 'video', referer);
    if (item.type === 'audio') return toRenderableAssetUrl(item.url, 'audio', referer);
    return toRenderableAssetUrl(item.thumbnail || item.url, 'image', referer);
  }, []);

  const handleSelectAssetFolder = useCallback((folderId: string, options?: { tab?: AssetTab; clearSearch?: boolean }) => {
    selectFolder(folderId);
    if (options?.tab) {
      setActiveTab(options.tab);
    }
    if (options?.clearSearch !== false) {
      setSearchQuery('');
    }
  }, [selectFolder, setSearchQuery]);

  const visibleItems = (showDuplicatesOnly ? items : getItemsInFolder()).filter((item) => {
    if (showDuplicatesOnly) return Boolean(item.duplicateOf);
    if (activeTab === 'all') return true;
    if (activeTab === 'images') return item.type === 'image';
    if (activeTab === 'videos') return item.type === 'video';
    if (activeTab === 'audio') return item.type === 'audio';
    if (activeTab === 'model') return item.type === 'model';
    if (activeTab === 'prompts') return Boolean(item.prompt) || item.type === 'text';
    return true;
  });

  const folderLookup = useMemo(() => {
    const map = new Map<string, AssetFolder>();
    folders.forEach((folder) => map.set(folder.id, folder));
    return map;
  }, [folders]);
  const allItems = useMemo(() => items, [items]);
  const mediaFolders = useMemo(() => ([
    { id: MEDIA_FOLDER_IDS.all, name: '全部素材', count: allItems.length, tab: activeTab },
    { id: MEDIA_FOLDER_IDS.images, name: '图片素材', count: allItems.filter((item) => item.type === 'image').length, tab: 'images' as const },
    { id: MEDIA_FOLDER_IDS.videos, name: '视频素材', count: allItems.filter((item) => item.type === 'video').length, tab: 'videos' as const },
    { id: MEDIA_FOLDER_IDS.audio, name: '音频素材', count: allItems.filter((item) => item.type === 'audio').length, tab: 'audio' as const },
  ]), [activeTab, allItems]);
  const smartCategoryFolders = useMemo(
    () => smartCategories.map((category) => ({
      ...category,
      id: `smart:${encodeURIComponent(category.name)}`,
    })),
    [smartCategories],
  );
  const selectedFolderName = useMemo(() => {
    if (!selectedFolderId || selectedFolderId === 'root') return '全部素材';
    const mediaFolder = mediaFolders.find((folder) => folder.id === selectedFolderId);
    if (mediaFolder) return mediaFolder.name;
    const smartFolder = smartCategoryFolders.find((folder) => folder.id === selectedFolderId);
    if (smartFolder) return `智能分类 · ${smartFolder.name}`;
    return folderLookup.get(selectedFolderId)?.name || '全部素材';
  }, [folderLookup, mediaFolders, selectedFolderId, smartCategoryFolders]);
  const importFolderName = folderLookup.get(importTargetFolderId)?.name || '网页采集';
  const imageAnalysisOptions = useMemo(
    () => getImageAnalysisEngineOptions(byokRuntime),
    [byokRuntime],
  );
  const imageAnalysisGroups = useMemo(
    () => ANALYSIS_ENGINE_GROUPS.map((group) => ({
      ...group,
      options: imageAnalysisOptions.filter((option) => option.group === group.key),
    })).filter((group) => group.options.length > 0),
    [imageAnalysisOptions],
  );
  const selectedAnalysisOption = useMemo<AnalysisEngineOption>(
    () => findAnalysisEngineOption(imageAnalysisOptions, imageAnalysisEngine),
    [imageAnalysisEngine, imageAnalysisOptions],
  );
  const activatedRemoteAnalysisLabel = useMemo(() => {
    const provider = String(byokRuntime?.selectedImageAnalysisRemote?.provider || '').trim();
    const model = String(byokRuntime?.selectedImageAnalysisRemote?.model || '').trim();
    return [provider, model].filter(Boolean).join(' / ');
  }, [byokRuntime]);

  // 额度感知并发封顶：运行时无精确剩余额度数字，故以「激活平台状态」作为代理指标保守收敛，
  // 避免在仅有免费额度/未激活平台时因高并发触发限流。
  //  - 无激活分析平台：本地降级，封顶 2
  //  - 单一直连平台（多为免费额度）：封顶 3
  //  - 中转聚合或多平台激活（额度更充裕）：封顶 6
  const quotaAwareConcurrencyCap = useMemo(() => {
    const providers = Array.isArray(byokRuntime?.activatedProviders) ? byokRuntime!.activatedProviders : [];
    const analysisProviders = providers.filter((entry) => entry.mode === 'llm' || entry.mode === 'image');
    const distinct = new Set(
      analysisProviders.map((entry) => String(entry.provider || '').toLowerCase()).filter(Boolean),
    );
    if (distinct.size === 0) return 2;
    const hasRelay = analysisProviders.some((entry) => Boolean(entry.relaySource || entry.relayPresetId));
    if (hasRelay || distinct.size >= 2) return 6;
    return 3;
  }, [byokRuntime]);

  const storagePathChanged = normalizeStoragePathValue(storageDraft) !== normalizeStoragePathValue(storagePath);
  const defaultStoragePathActive = normalizeStoragePathValue(storageDraft) === normalizeStoragePathValue(defaultStoragePath || storagePath || '');
  const imageAnalysisStatus = useMemo(() => {
    if (previewItem?.type !== 'image') {
      return imageAnalysisEngine === 'custom-api'
        ? {
            tone: 'info' as const,
            message: activatedRemoteAnalysisLabel
              ? `当前将优先使用 ${activatedRemoteAnalysisLabel} 做云端解析，通常需要 5-8 秒。`
              : '若已激活云端多模态模型，解析通常需要 5-8 秒；完成后会在下方显示 provider / model。',
          }
        : null;
    }
    const analysis = previewItem.analysis;
    if (!analysis) {
      return imageAnalysisEngine === 'custom-api'
        ? {
            tone: 'info' as const,
            message: activatedRemoteAnalysisLabel
              ? `当前将优先使用 ${activatedRemoteAnalysisLabel} 做云端解析，通常需要 5-8 秒。`
              : '若已激活云端多模态模型，解析通常需要 5-8 秒；完成后会在下方显示 provider / model。',
          }
        : null;
    }
    if (analysis.engine === 'local-heuristic-fallback') {
      return {
        tone: 'warn' as const,
        message: '当前未配置可用的视觉模型，仅做了轻量本地占位解析。请在「模型下载」面板安装 Florence-2（本地免费）或激活云端付费模型（如 Qwen3.7-VL）后再解析。',
      };
    }
    if (analysis.runtime?.provider || analysis.runtime?.model || analysis.runtime?.modelLabel) {
      return {
        tone: 'success' as const,
        message: `当前已通过 ${analysis.runtime?.modelLabel || `${analysis.runtime?.provider || '云端'} / ${analysis.runtime?.model || analysis.engine}`} 完成解析。`,
      };
    }
    if (analysis.warnings?.length) {
      return {
        tone: 'warn' as const,
        message: analysis.warnings[0],
      };
    }
    return null;
  }, [activatedRemoteAnalysisLabel, imageAnalysisEngine, previewItem, selectedAnalysisOption.label]);

  useEffect(() => {
    void fetchByokRuntime();
  }, [fetchByokRuntime]);

  const addAssetToCanvas = useCallback((item: AssetItem) => {
    const nodeType = getAssetNodeType(item);
    const nodeId = addNode(nodeType, {
      x: 320 + Math.random() * 220,
      y: 180 + Math.random() * 180,
    });
    const label = sanitizeNodeLabel(item.name);
    const sourcePrompt = String(item.prompt || item.analysis?.promptZh || item.analysis?.promptEn || '').trim();
    const baseParams = {
      sourceAssetId: item.id,
      sourceAssetUrl: item.url,
      sourceAssetName: item.name,
      sourceAssetFolderId: item.folderId,
      sourceAssetPrompt: sourcePrompt,
      sourceAssetAnalysisEngine: String(item.analysis?.engine || ''),
    };

    if (item.type === 'image') {
      updateNodeData(nodeId, {
        label,
        prompt: sourcePrompt,
        status: 'completed',
        imageUrl: item.url,
        outputs: [
          {
            id: `asset-output-${item.id}`,
            type: 'image',
            url: item.url,
            thumbnail: item.thumbnail || item.url,
            metadata: {
              source: 'asset-library',
              sourceAssetId: item.id,
              width: item.width,
              height: item.height,
            },
          },
        ],
        params: {
          ...baseParams,
          originalUrl: item.url,
        },
      });
    } else if (item.type === 'video') {
      updateNodeData(nodeId, {
        label,
        prompt: sourcePrompt,
        status: 'completed',
        videoUrl: item.url,
        outputs: [
          {
            id: `asset-output-${item.id}`,
            type: 'video',
            url: item.url,
            thumbnail: item.thumbnail || item.url,
            metadata: {
              source: 'asset-library',
              sourceAssetId: item.id,
              width: item.width,
              height: item.height,
              duration: item.duration,
            },
          },
        ],
        params: {
          ...baseParams,
          originalUrl: item.url,
        },
      });
    } else if (item.type === 'audio') {
      updateNodeData(nodeId, {
        label,
        prompt: sourcePrompt,
        status: 'completed',
        outputs: [
          {
            id: `asset-output-${item.id}`,
            type: 'audio',
            url: item.url,
            metadata: {
              source: 'asset-library',
              sourceAssetId: item.id,
              duration: item.duration,
            },
          },
        ],
        params: {
          ...baseParams,
          sourceUrl: item.url,
          audioMeta: {
            duration: item.duration || 0,
            format: item.url.split('.').pop() || 'mp3',
            backendLabel: '资产库素材',
          },
        },
      });
    } else {
      updateNodeData(nodeId, {
        label,
        prompt: sourcePrompt,
        content: sourcePrompt || item.name,
        status: 'completed',
        params: baseParams,
      });
    }

    setSelectedNodeIds([nodeId]);
    return nodeId;
  }, [addNode, setSelectedNodeIds, updateNodeData]);

  const openSimilarSearch = useCallback((item: AssetItem) => {
    if (item.type !== 'image' && item.type !== 'video') return;
    setReverseSearchItem({
      id: item.id,
      url: item.url,
      name: item.name,
      type: item.type,
    });
  }, []);

  const handleUpload = () => fileInputRef.current?.click();
  const handleImportFolder = async () => {
    setImportStatus(null);
    setIsImportingFolder(true);
    try {
      const result = await importAssetDirectory({
        folderId: selectedFolderId || undefined,
        initialPath: storagePath || defaultStoragePath || '',
        autoSelectPath: getAssetDirectoryPickerTestPath(),
      });
      if (result.canceled) {
        setImportStatus({
          type: 'error',
          message: '已取消文件夹导入。',
        });
        return;
      }
      const syncedItems = await refreshPersistedCatalog(result.items || []);
      focusImportedItems(syncedItems);
      setImportStatus({
        type: (Number(result.report?.importedCount || 0) > 0 || Number(result.report?.duplicateCount || 0) > 0) ? 'success' : 'error',
        message: (Number(result.report?.importedCount || 0) > 0 || Number(result.report?.duplicateCount || 0) > 0)
          ? buildFolderImportStatusMessage(result.report)
          : result.report?.skippedCount > 0
            ? '当前文件夹里没有可导入的图片、视频、音频或文档素材。'
            : '没有导入到任何素材，请重试。',
      });
    } catch (error) {
      setImportStatus({
        type: 'error',
        message: error instanceof Error ? error.message : '导入本地素材失败。',
      });
      directoryInputRef.current?.click();
    } finally {
      setIsImportingFolder(false);
    }
  };

  const handleFiles = async (event: React.ChangeEvent<HTMLInputElement>, mode: 'file' | 'folder' = 'file') => {
    if (!event.target.files) return;
    setImportStatus(null);
    try {
      const report = await uploadFiles(event.target.files, selectedFolderId || undefined, {
        folderImport: mode === 'folder',
      });
      setImportStatus({
        type: (report.importedCount > 0 || report.duplicateCount > 0) ? 'success' : 'error',
        message: (report.importedCount > 0 || report.duplicateCount > 0)
          ? buildFolderImportStatusMessage(report)
          : report.skippedCount > 0
            ? '当前文件夹里没有可导入的图片、视频、音频或文档素材。'
            : '没有导入到任何素材，请重试。',
      });
    } catch (error) {
      setImportStatus({
        type: 'error',
        message: error instanceof Error ? error.message : '导入本地素材失败。',
      });
    } finally {
      event.target.value = '';
    }
  };

  const handleCreateFolder = () => {
    if (!newFolderName.trim()) return;
    createFolder(newFolderName.trim(), selectedFolderId || 'root');
    setNewFolderName('');
    setShowNewFolder(false);
  };

  const handleSaveFolderRename = (folderId: string) => {
    if (!folderRenameValue.trim()) {
      setFolderRenameId(null);
      return;
    }
    renameFolder(folderId, folderRenameValue.trim());
    setFolderRenameId(null);
  };

  const handleCollectUrl = async () => {
    if (!urlCollectValue.trim()) return;
    setIsCollectingUrl(true);
    try {
      await collectFromUrl(urlCollectValue, {
        title: urlCollectName,
        folderId: importTargetFolderId,
      });
      setUrlCollectValue('');
      setUrlCollectName('');
    } finally {
      setIsCollectingUrl(false);
    }
  };

  const handlePreviewRename = () => {
    if (!previewItem || !itemRenameValue.trim()) {
      setEditingItemName(false);
      setItemRenameValue(previewItem?.name || '');
      return;
    }
    renameItem(previewItem.id, itemRenameValue.trim());
    setEditingItemName(false);
  };

  const handleAddTag = () => {
    if (!previewItem || !newTagValue.trim()) return;
    addTag(previewItem.id, newTagValue.trim());
    setNewTagValue('');
  };

  const handleAnalyzePreviewImage = useCallback(async () => {
    if (!previewItem || previewItem.type !== 'image') return;
    setAnalyzingItemId(previewItem.id);
    try {
      await analyzeImage(previewItem.id, { engine: imageAnalysisEngine });
    } finally {
      setAnalyzingItemId(null);
    }
  }, [analyzeImage, imageAnalysisEngine, previewItem]);

  const handleSaveStoragePath = useCallback(async () => {
    const nextPath = storageDraft.trim();
    if (!nextPath) {
      setStorageStatus({ type: 'error', message: '请输入资产库存储路径。' });
      return;
    }
    setIsSavingStoragePath(true);
    setStorageStatus(null);
    try {
      const saved = await saveAssetLibrarySettings(nextPath);
      setStoragePath(saved.storagePath);
      setStorageDraft(saved.storagePath);
      setDefaultStoragePath(saved.defaultStoragePath);
      const refreshedItems = await refreshPersistedCatalog();
      focusImportedItems(refreshedItems);
      setStorageStatus({ type: 'success', message: '资产库存储路径已保存。' });
    } catch (error) {
      setStorageStatus({
        type: 'error',
        message: error instanceof Error ? error.message : '保存资产库存储路径失败。',
      });
    } finally {
      setIsSavingStoragePath(false);
    }
  }, [focusImportedItems, refreshPersistedCatalog, setStoragePath, storageDraft]);

  const handleResetStoragePath = useCallback(() => {
    setStorageDraft(defaultStoragePath || storagePath || '');
    setStorageStatus(null);
  }, [defaultStoragePath, storagePath]);

  const handleSaveStoragePathInteractive = useCallback(async () => {
    const nextPath = storageDraft.trim();
    if (!nextPath) {
      setStorageStatus({ type: 'error', message: '请输入资产库存储路径。' });
      return;
    }
    if (normalizeStoragePathValue(nextPath) === normalizeStoragePathValue(storagePath)) {
      setStorageStatus({ type: 'success', message: '当前已经是这个存储路径，无需重复保存。' });
      return;
    }
    setIsSavingStoragePath(true);
    setStorageStatus(null);
    try {
      const saved = await saveAssetLibrarySettings(nextPath);
      setStoragePath(saved.storagePath);
      setStorageDraft(saved.storagePath);
      setDefaultStoragePath(saved.defaultStoragePath);
      const refreshedItems = await refreshPersistedCatalog();
      focusImportedItems(refreshedItems);
      setStorageStatus({ type: 'success', message: '资产库存储路径已保存。' });
    } catch (error) {
      setStorageStatus({
        type: 'error',
        message: error instanceof Error ? error.message : '保存资产库存储路径失败。',
      });
    } finally {
      setIsSavingStoragePath(false);
    }
  }, [focusImportedItems, refreshPersistedCatalog, setStoragePath, storageDraft, storagePath]);

  const handleResetStoragePathInteractive = useCallback(() => {
    const nextValue = defaultStoragePath || storagePath || '';
    setStorageDraft(nextValue);
    setStorageStatus({
      type: 'success',
      message: normalizeStoragePathValue(nextValue) === normalizeStoragePathValue(storagePath)
        ? '当前已经是默认存储路径。'
        : '已切回默认存储路径，点击“保存路径”后生效。',
    });
  }, [defaultStoragePath, storagePath]);

  const handlePickStoragePathInteractive = useCallback(async () => {
    setIsPickingStoragePath(true);
    setStorageStatus(null);
    try {
      const picked = await pickAssetLibraryDirectory(
        storageDraft || storagePath || defaultStoragePath || '',
        getAssetDirectoryPickerTestPath(),
      );
      if (picked.canceled) {
        setStorageStatus({ type: 'success', message: '已取消目录选择，当前路径保持不变。' });
        return;
      }
      if (!picked.path) {
        setStorageStatus({ type: 'error', message: '目录选择器未返回有效路径，请重试。' });
        return;
      }
      setStorageDraft(picked.path);
      setStorageStatus({ type: 'success', message: '已选择本地目录，点击“保存路径”即可生效。' });
    } catch (error) {
      setStorageStatus({
        type: 'error',
        message: error instanceof Error ? error.message : '打开目录选择器失败。',
      });
    } finally {
      setIsPickingStoragePath(false);
    }
  }, [defaultStoragePath, storageDraft, storagePath]);

  const handleDeleteItems = useCallback((itemIds: string[]) => {
    void (async () => {
      const targets = items.filter((item) => itemIds.includes(item.id));
      const persistedAssetIds = targets
        .map((item) => item.backendAssetId)
        .filter((assetId): assetId is string => Boolean(assetId));
      try {
        if (persistedAssetIds.length > 0) {
          await deletePersistedAssets(persistedAssetIds);
        }
        deleteItems(itemIds);
        if (reverseSearchItem && itemIds.includes(reverseSearchItem.id)) {
          setReverseSearchItem(null);
        }
        if (persistedAssetIds.length > 0) {
          const referencedCount = targets.filter((item) => String(item.storageLabel || '').trim().toLowerCase() === 'reference').length;
          setStorageStatus({
            type: 'success',
            message: referencedCount > 0
              ? `已删除 ${persistedAssetIds.length} 个素材索引，其中 ${referencedCount} 个为原文件引用，未改动本地源文件。`
              : `已删除 ${persistedAssetIds.length} 个落库素材。`,
          });
        }
      } catch (error) {
        setStorageStatus({
          type: 'error',
          message: error instanceof Error ? error.message : '删除素材失败。',
        });
      }
    })();
  }, [deleteItems, items, reverseSearchItem]);

  const handleBatchTag = useCallback(() => {
    const tag = batchTagInput.trim();
    if (!tag || selectedItemIds.length === 0) return;
    batchAddTag(selectedItemIds, tag);
    setBatchTagInput('');
    setImportStatus({ type: 'success', message: `已为 ${selectedItemIds.length} 个素材添加标签「${tag}」。` });
  }, [batchAddTag, batchTagInput, selectedItemIds]);

  const handleBatchMove = useCallback(() => {
    if (selectedItemIds.length === 0) return;
    moveItems(selectedItemIds, batchMoveFolderId);
    setImportStatus({ type: 'success', message: `已移动 ${selectedItemIds.length} 个素材到「${folderLookup.get(batchMoveFolderId)?.name || '目录'}」。` });
  }, [batchMoveFolderId, folderLookup, moveItems, selectedItemIds]);

  const handleBatchClassify = useCallback(() => {
    if (selectedItemIds.length === 0) return;
    void (async () => {
      try {
        await batchAutoClassify(selectedItemIds);
        setImportStatus({ type: 'success', message: `已完成 ${selectedItemIds.length} 个素材的智能分类。` });
      } catch {
        setImportStatus({ type: 'error', message: '批量智能分类失败。' });
      }
    })();
  }, [batchAutoClassify, selectedItemIds]);

  const handleBatchAnalyze = useCallback(() => {
    if (selectedItemIds.length === 0) return;
    void (async () => {
      const baseConcurrency = analyzeConcurrency > 0 ? analyzeConcurrency : (selectedItemIds.length > 20 ? 5 : 3);
      const concurrency = Math.min(baseConcurrency, quotaAwareConcurrencyCap);
      setAnalyzeScopeNote(
        concurrency < baseConcurrency
          ? `并发已按当前激活平台额度收敛至 ${concurrency}（原 ${baseConcurrency}）`
          : '',
      );
      try {
        await batchAnalyzeImages(selectedItemIds, { concurrency });
        const finalProgress = useAssetStore.getState().batchAnalyzeProgress;
        const successCount = finalProgress.done - finalProgress.failed;
        if (finalProgress.failed > 0) {
          setImportStatus({
            type: 'error',
            message: `批量分析完成：${successCount} 成功，${finalProgress.failed} 失败（见顶部失败清单）。`,
          });
        } else {
          setImportStatus({
            type: 'success',
            message: `已对 ${finalProgress.done} 个图片素材执行 AI 分析（并发 ${concurrency}、失败重试 ${analyzeRetries} 次）。`,
          });
        }
      } catch {
        setImportStatus({ type: 'error', message: '批量 AI 分析失败。' });
      }
    })();
  }, [batchAnalyzeImages, selectedItemIds, analyzeConcurrency, analyzeRetries, quotaAwareConcurrencyCap]);

  // 仅重跑失败项：不传 ids 时重跑全部失败，传 ids 时重跑指定条目。
  const handleRetryFailedAnalyze = useCallback((ids?: string[]) => {
    const failed = useAssetStore.getState().batchAnalyzeProgress.failedItems;
    const retryIds = (ids && ids.length ? ids : failed.map((entry) => entry.id)).filter(Boolean);
    if (retryIds.length === 0) return;
    void (async () => {
      const baseConcurrency = analyzeConcurrency > 0 ? analyzeConcurrency : (retryIds.length > 20 ? 5 : 3);
      const concurrency = Math.min(baseConcurrency, quotaAwareConcurrencyCap);
      try {
        await batchAnalyzeImages(retryIds, { concurrency });
        const finalProgress = useAssetStore.getState().batchAnalyzeProgress;
        const successCount = finalProgress.done - finalProgress.failed;
        if (finalProgress.failed > 0) {
          setImportStatus({ type: 'error', message: `重试完成：${successCount} 成功，${finalProgress.failed} 仍失败（见失败清单）。` });
        } else {
          setImportStatus({ type: 'success', message: `已重跑 ${finalProgress.done} 个失败项，全部成功。` });
        }
      } catch {
        setImportStatus({ type: 'error', message: '重试失败项时出错。' });
      }
    })();
  }, [batchAnalyzeImages, analyzeConcurrency, quotaAwareConcurrencyCap]);

  const handleDetectDuplicates = useCallback(() => {
    void (async () => {
      // 优先调用服务端已落库的 contentHash 去重（跨会话更准），失败回退本地指纹
      try {
        const data = await fetchAssetDuplicates();
        const found = applyServerDuplicates(data.groups);
        setDuplicateGroups(Array.isArray(data.groups) ? data.groups : []);
        setDuplicateCount(found);
        setShowDuplicatesOnly(found > 0);
        if (found > 0) {
          setImportStatus({ type: 'success', message: `服务端检测到 ${found} 个重复素材（基于内容指纹），已切换到重复视图。` });
        } else {
          setImportStatus({ type: 'success', message: '未发现重复素材。' });
        }
        return;
      } catch {
        const found = detectDuplicates();
        setDuplicateCount(found);
        setShowDuplicatesOnly(found > 0);
        if (found > 0) {
          setImportStatus({ type: 'success', message: `本地检测到 ${found} 个重复素材，已切换到重复视图。` });
        } else {
          setImportStatus({ type: 'success', message: '未发现重复素材。' });
        }
      }
    })();
  }, [applyServerDuplicates, detectDuplicates]);

  const handleClearDuplicates = useCallback(() => {
    clearDuplicateFlags();
    setDuplicateCount(0);
    setDuplicateGroups([]);
    setShowDuplicatesOnly(false);
  }, [clearDuplicateFlags]);

  // 合并单个重复分组（仅删该组的重复项），并更新看板状态。
  const handleMergeGroup = useCallback((group: { canonicalId: string; duplicateIds: string[] }) => {
    const removed = removeDuplicateItems(group.duplicateIds);
    setDuplicateGroups((current) => current.filter((entry) => entry.canonicalId !== group.canonicalId));
    setDuplicateCount((current) => Math.max(0, current - removed));
    if (removed > 0) {
      setImportStatus({ type: 'success', message: `已合并该组 ${removed} 个重复素材，仅保留原图（可撤销）。` });
    }
  }, [removeDuplicateItems]);

  // 定位：选中并预览该组的规范项，便于在网格中直接跳转处理。
  const handleLocateGroup = useCallback((canonicalId: string) => {
    selectItem(canonicalId, false);
    selectPreviewItem(canonicalId);
  }, [selectItem, selectPreviewItem]);

  // 预览加载失败时诊断素材：文件缺失/损坏 → 可删除；格式不被浏览器支持 → 可转码修复。
  const handlePreviewMediaError = useCallback(() => {
    const item = previewItem;
    if (!item || !item.backendAssetId) return;
    setPreviewValidating(true);
    void (async () => {
      try {
        const result = await validatePersistedAsset(item.backendAssetId!);
        setPreviewIssue({ state: result.state, canTranscode: Boolean(result.canTranscode), detail: result.detail });
      } catch {
        setPreviewIssue({ state: 'corrupted', canTranscode: false });
      } finally {
        setPreviewValidating(false);
      }
    })();
  }, [previewItem]);

  // 转码修复：把可解码但浏览器无法直接预览的素材转成标准格式并原地替换。
  const handleRepairPreview = useCallback(() => {
    const item = previewItem;
    if (!item || !item.backendAssetId) return;
    setPreviewValidating(true);
    void (async () => {
      try {
        await repairPersistedAsset(item.backendAssetId!);
        setPreviewRepairToken((token) => token + 1);
        setPreviewIssue(null);
        setImportStatus({ type: 'success', message: '已将素材转码为标准格式，预览已刷新。' });
      } catch {
        setImportStatus({ type: 'error', message: '转码修复失败，素材可能已损坏且无法解码。' });
      } finally {
        setPreviewValidating(false);
      }
    })();
  }, [previewItem]);

  // 去重看板常驻徽标：静默预取服务端已落盘的去重分组（不打标记、不切视图），
  // 让侧栏入口与去重看板常显最新重复计数与分组；后端不可用时静默跳过。
  const refreshDuplicateBadge = useCallback(async () => {
    try {
      const persisted = await fetchPersistedAssetDuplicates();
      setDuplicateGroups(Array.isArray(persisted.groups) ? persisted.groups : []);
      setDuplicateCount(Number(persisted.total || 0));
    } catch {
      // 静默失败：后端不可用时不影响本地视图
    }
  }, []);

  useEffect(() => {
    void refreshDuplicateBadge();
  }, [refreshDuplicateBadge]);

  const handleCardClick = (item: AssetItem, multi: boolean) => {
    selectItem(item.id, multi || multiSelectMode);
    selectPreviewItem(item.id);
  };

  const handleToggleCardSelection = useCallback((item: AssetItem) => {
    selectItem(item.id, true);
    selectPreviewItem(item.id);
  }, [selectItem, selectPreviewItem]);

  // 双击素材：切换预览缩放到原始尺寸，避免 addAssetToCanvas 引发画布状态变更导致布局跳动
  const handleCardDoubleClick = (item: AssetItem) => {
    if (previewItem?.id === item.id) {
      setPreviewZoomed((prev) => !prev);
    } else {
      selectPreviewItem(item.id);
      setPreviewZoomed(true);
    }
  };

  // 自定义拖拽缩放：mousedown 时记录起点，移动时更新宽度
  const handlePreviewResizeStart = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizingPreview(true);
    resizeStartRef.current = { x: e.clientX, width: previewWidth };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    // 拖拽时锁定滚动容器，防止意外触发内容滚动
    if (gridContainerRef.current) {
      gridContainerRef.current.style.overflowY = 'hidden';
    }
  }, [previewWidth]);

  useEffect(() => {
    if (!isResizingPreview) return;
    const handleMove = (e: MouseEvent) => {
      if (!resizeStartRef.current) return;
      // 阻止拖拽时触发页面滚动
      e.preventDefault();
      // 向左拖 = 面板变宽（因为面板在右侧）
      const delta = resizeStartRef.current.x - e.clientX;
      const containerWidth = window.innerWidth;
      const minWidth = 220;
      const maxWidth = Math.min(containerWidth * 0.7, 800);
      const newWidth = Math.max(minWidth, Math.min(maxWidth, resizeStartRef.current.width + delta));
      setPreviewWidth(newWidth);
    };
    const handleUp = () => {
      setIsResizingPreview(false);
      resizeStartRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // 恢复滚动容器
      if (gridContainerRef.current) {
        gridContainerRef.current.style.overflowY = 'auto';
      }
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // 确保清理时恢复滚动
      if (gridContainerRef.current) {
        gridContainerRef.current.style.overflowY = 'auto';
      }
    };
  }, [isResizingPreview]);

  // 预览媒体区：提取为独立函数避免在 JSX props 中出现多行箭头函数导致 Babel 解析级联错误
  const handleMediaClick = useCallback(() => {
    if (previewItem && (previewItem.type === 'image' || previewItem.type === 'video')) {
      openSimilarSearch(previewItem);
    }
  }, [previewItem, openSimilarSearch]);

  const handleMediaDoubleClick = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (previewItem && (previewItem.type === 'image' || previewItem.type === 'video')) {
      setPreviewZoomed((p) => !p);
    }
  }, [previewItem]);

  const handleVideoDoubleClick = useCallback((e: ReactMouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setPreviewZoomed((p) => !p);
  }, []);

  const handleZoomToggle = useCallback((e: ReactMouseEvent) => {
    e.stopPropagation();
    setPreviewZoomed((p) => !p);
  }, []);

  const getPreviewMediaClass = useCallback((zoomed: boolean) => {
    const base = 'relative mb-3 w-full select-none overflow-hidden rounded-2xl bg-[#161b22] ring-1 ring-[#30363d]';
    return zoomed ? base + ' cursor-zoom-out' : base + ' cursor-zoom-in';
  }, []);

  const getZoomedMediaClass = useMemo(() => (
    previewZoomed
      ? 'block max-h-[70vh] max-w-full w-full object-contain'
      : 'block aspect-video w-full object-cover'
  ), [previewZoomed]);

  const renderPreviewMedia = useMemo(() => {
    if (!previewItem) return null;
    if (previewItem.type === 'video') {
      return (
        <div className="relative">
          <video
            src={previewRepairToken > 0 ? `${renderAssetUrl(previewItem)}?t=${previewRepairToken}` : renderAssetUrl(previewItem)}
            className={getZoomedMediaClass}
            controls
            preload="metadata"
            onError={handlePreviewMediaError}
            onDoubleClick={handleVideoDoubleClick}
          />
        </div>
      );
    }
    if (previewItem.type === 'audio') {
      return (
        <div className="flex aspect-video flex-col items-center justify-center gap-3 bg-[#161b22]">
          <Music className="h-10 w-10 text-[#a855f7]" />
          <audio src={renderAssetUrl(previewItem)} controls className="w-[88%]" onError={handlePreviewMediaError} />
        </div>
      );
    }
    if (previewItem.type === 'model') {
      return (
        <div className="flex aspect-video flex-col items-center justify-center gap-3 bg-[#161b22]">
          <Box className="h-10 w-10 text-[#a78bfa]" />
          <div className="max-w-[84%] text-center text-xs leading-5 text-[#8b949e]">
            3D 模型（{getAssetExtension(previewItem).toUpperCase() || '模型'}）已导入本地，可在外部 3D 软件中打开。
          </div>
          <a
            href={renderAssetUrl(previewItem)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 rounded-md bg-[#a78bfa]/15 px-3 py-1.5 text-xs text-[#c4b5fd] hover:bg-[#a78bfa]/25"
          >
            <ExternalLink className="h-3.5 w-3.5" /> 打开/下载模型文件
          </a>
        </div>
      );
    }
    if (isPreviewLimitedImageAsset(previewItem)) {
      return (
        <div className="flex aspect-video flex-col items-center justify-center gap-3 bg-[radial-gradient(circle_at_top,#243247,transparent_58%),linear-gradient(180deg,#11161d,#0d1117)] px-4 text-center">
          <ImageIcon className="h-10 w-10 text-[#8fd0ff]" />
          <div className="text-sm font-medium text-[#dbeafe]">
            {getAssetExtension(previewItem).toUpperCase() || 'HDR'} 资源已兼容
          </div>
          <div className="max-w-[84%] text-xs leading-5 text-[#8b949e]">
            这类 HDR / EXR / HEIC 素材可正常导入、分类、加到节点或作为 HDRI 参考使用；当前浏览器仅不直接显示像素预览。
          </div>
        </div>
      );
    }
    return (
      <img
        src={previewRepairToken > 0 ? `${renderAssetUrl(previewItem)}?t=${previewRepairToken}` : renderAssetUrl(previewItem)}
        alt={previewItem.name}
        className={getZoomedMediaClass}
        onError={handlePreviewMediaError}
        draggable={false}
      />
    );
  }, [previewItem, previewZoomed, previewRepairToken, getZoomedMediaClass, handleVideoDoubleClick, handlePreviewMediaError]);

  const handleVideoMouseEnter = useCallback((itemId: string) => {
    if (hoverTimers.current[`leave-${itemId}`]) {
      window.clearTimeout(hoverTimers.current[`leave-${itemId}`]);
    }
    hoverTimers.current[`enter-${itemId}`] = window.setTimeout(() => {
      const video = videoRefs.current[itemId];
      if (!video) return;
      video.currentTime = 0;
      video.muted = true;
      void video.play().catch(() => undefined);
      setHoveredVideo(itemId);
    }, 180);
  }, []);

  const handleVideoMouseLeave = useCallback((itemId: string) => {
    if (hoverTimers.current[`enter-${itemId}`]) {
      window.clearTimeout(hoverTimers.current[`enter-${itemId}`]);
    }
    hoverTimers.current[`leave-${itemId}`] = window.setTimeout(() => {
      const video = videoRefs.current[itemId];
      if (!video) return;
      video.pause();
      try {
        video.currentTime = 0;
      } catch {
        // ignore currentTime reset failure
      }
      setHoveredVideo((current) => current === itemId ? null : current);
    }, 80);
  }, []);

  const handleContextAction = (action: 'add' | 'similar' | 'rename' | 'delete' | 'autotag') => {
    if (!contextMenu) return;
    if (contextMenu.kind === 'item') {
      const item = useAssetStore.getState().items.find((entry) => entry.id === contextMenu.itemId);
      if (!item) {
        setContextMenu(null);
        return;
      }
      if (action === 'add') {
        addAssetToCanvas(item);
      } else if (action === 'similar') {
        openSimilarSearch(item);
      } else if (action === 'rename') {
        selectPreviewItem(item.id);
        setItemRenameValue(item.name);
        setEditingItemName(true);
      } else if (action === 'autotag') {
        void autoClassify(item.id);
      } else if (action === 'delete') {
        handleDeleteItems([item.id]);
      }
    } else {
      const folder = folders.find((entry) => entry.id === contextMenu.folderId);
      if (!folder) {
        setContextMenu(null);
        return;
      }
      if (action === 'rename') {
        setFolderRenameId(folder.id);
        setFolderRenameValue(folder.name);
      } else if (action === 'delete') {
        deleteFolder(folder.id);
      }
    }
    setContextMenu(null);
  };

  const tabs: Array<{ id: AssetTab; label: string; icon: typeof Grid3X3 }> = [
    { id: 'all', label: '全部素材', icon: Grid3X3 },
    { id: 'images', label: '图片素材', icon: ImageIcon as typeof Grid3X3 },
    { id: 'videos', label: '视频素材', icon: Video as typeof Grid3X3 },
    { id: 'audio', label: '音频素材', icon: Music as typeof Grid3X3 },
    { id: 'model', label: '模型素材', icon: Box as typeof Grid3X3 },
    { id: 'prompts', label: '提示词库', icon: Tag as typeof Grid3X3 },
    { id: 'workflow', label: '工作流', icon: FolderOpen as typeof Grid3X3 },
  ];

  if (needsLogin) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-[#0d1117] px-6 text-center">
        <LogIn className="h-10 w-10 text-[#58a6ff]" />
        <div className="text-sm font-medium text-[#dbeafe]">请先登录后查看素材库</div>
        <div className="max-w-[260px] text-xs leading-5 text-[#8b949e]">
          素材库按账号隔离存储，登录后即可查看、导入并管理你的本地素材。
        </div>
        <button
          type="button"
          onClick={() => navigate('/login')}
          className="mt-1 rounded-lg bg-[#238636] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#2ea043]"
        >
          前往登录
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[#0d1117]">
      <div className="flex items-center gap-1 border-b border-[#21262d] px-3 py-2">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            data-testid={`asset-tab-${tab.id}`}
            onClick={() => {
              setActiveTab(tab.id);
              if (tab.id === 'all' && String(selectedFolderId || '').startsWith('media:')) {
                handleSelectAssetFolder(MEDIA_FOLDER_IDS.all, { tab: 'all' });
              } else if (tab.id === 'images' && selectedFolderId === MEDIA_FOLDER_IDS.videos) {
                handleSelectAssetFolder(MEDIA_FOLDER_IDS.images, { tab: 'images' });
              } else if (tab.id === 'videos' && selectedFolderId === MEDIA_FOLDER_IDS.images) {
                handleSelectAssetFolder(MEDIA_FOLDER_IDS.videos, { tab: 'videos' });
              } else if (tab.id === 'audio' && selectedFolderId !== MEDIA_FOLDER_IDS.audio && String(selectedFolderId || '').startsWith('media:')) {
                handleSelectAssetFolder(MEDIA_FOLDER_IDS.audio, { tab: 'audio' });
              } else if ((tab.id === 'images' || tab.id === 'videos' || tab.id === 'audio') && selectedFolderId === 'root') {
                handleSelectAssetFolder(MEDIA_FOLDER_IDS[tab.id], { tab: tab.id });
              } else if (tab.id === 'model' && String(selectedFolderId || '').startsWith('media:')) {
                handleSelectAssetFolder('root', { tab: 'model' });
              }
            }}
            className={`flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
              activeTab === tab.id ? 'bg-[#00d4aa]/10 text-[#00d4aa]' : 'text-[#8b949e] hover:bg-[#21262d] hover:text-[#c9d1d9]'
            }`}
          >
            <tab.icon className="h-3.5 w-3.5" />
            <span className="hidden lg:inline">{tab.label}</span>
          </button>
        ))}
        <button
          type="button"
          data-testid="asset-curator-toggle"
          title="采集当前浏览器页面的图片/视频/音效/3D 模型（需安装 Ddayup 素材采集扩展）"
          onClick={async () => {
            if (isExtensionDetected()) {
              const ok = await openExtensionScan();
              if (!ok) setShowExtInstall(true);
              return;
            }
            const ok = await recheckExtensionPresence();
            setExtDiag(getExtensionDetectionDiagnostics());
            if (ok) {
              setShowExtInstall(false);
              await openExtensionScan();
            } else {
              setShowExtInstall(true);
            }
          }}
          className="ml-auto flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs transition-colors text-[#8b949e] hover:bg-[#21262d] hover:text-[#c9d1d9]"
        >
          <Sparkles className="h-3.5 w-3.5" />
          <span className="hidden lg:inline">网络资产采集</span>
        </button>
      </div>



      {showExtInstall ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60" data-testid="ext-install-modal">
          <div className="w-[470px] rounded-2xl border border-[#30363d] bg-[#161b22] p-5 shadow-2xl">
            <div className="mb-2 flex items-center gap-2">
              <Globe className="h-5 w-5 text-[#00d4aa]" />
              <h3 className="text-sm font-semibold text-[#e6edf3]">未检测到浏览器素材采集扩展</h3>
            </div>
            <p className="text-xs leading-relaxed text-[#8b949e]">
              「网络资产采集」依赖 Ddayup 浏览器扩展扫描当前网页的真实图片 / 视频 / 音效 / 3D 模型资源。
            </p>
            <div className="mt-3 rounded-lg border border-[#21262d] bg-[#0d1117] p-3 text-[10px] font-mono leading-5 text-[#9aa4af]">
              <div>当前访问地址：{extDiag.origin || '—'}</div>
              <div>扩展状态：{extDiag.installed ? '已检测到 ✓' : '未检测到 ✗'}</div>
              <div>版本：{extDiag.version || '—'}（build {extDiag.build || '—'}）</div>
              <div>扩展注入站点：{extDiag.manifestMatches.join('、')}</div>
              {!extDiag.installed && (
                <div className="mt-1 text-[#ffb86b]">若你通过局域网 IP / 域名（非 127.0.0.1:3000）访问，扩展不会注入——请把你的访问地址加入 manifest 的 content_scripts / externally_connectable matches。</div>
              )}
            </div>
            <div className="mt-3 text-xs leading-relaxed text-[#8b949e]">
              <strong className="text-[#e6edf3]">安装方式（推荐）：</strong>
              <div className="mt-1.5">
                <a
                  href={EXTENSION_STORE_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#1f6feb] bg-[#1f6feb]/15 px-3 py-1.5 text-xs font-medium text-[#7cc4ff] transition hover:bg-[#1f6feb]/25"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  从 Edge 加载项商店安装
                </a>
                <div className="mt-1.5 text-[10px]">
                  在商店页点「获取」即完成安装；安装后由 Edge 自动保持最新版本，回到本页刷新即可采集。
                </div>
              </div>
              {/* 本地开发环境才展示本地加载方式；线上站点整块隐藏，不暴露 edge://extensions */}
              {SHOW_DEV_INSTALL ? (
                <details className="mt-2">
                  <summary className="cursor-pointer text-[10px] text-[#8b949e]">备用方案：本地加载（本地开发 / 调试用）</summary>
                  <ol className="mt-1 list-decimal space-y-1 pl-4 text-[10px]">
                    <li>打开 <code className="rounded bg-[#0f1317] px-1 text-[#9bf5df]">chrome://extensions</code>（Edge 为 edge://extensions）；</li>
                    <li>右上角开启「开发者模式」，点「加载已解压的扩展程序」并选择 <code className="rounded bg-[#0f1317] px-1 text-[#9bf5df]">extension/</code> 目录；</li>
                    <li>确认扩展已「启用」（开关打开、无报错），回到本页刷新即可采集。</li>
                    <li className="text-[#8b949e]">此方式不会自动更新，仅供本地开发调试。</li>
                  </ol>
                </details>
              ) : (
                <div className="mt-2 text-[10px] text-[#6e7681]">Chrome 版正在上架流程中，敬请期待。</div>
              )}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg border border-[#30363d] bg-[#0d1117] px-3 py-1.5 text-xs text-[#c9d1d9] hover:border-[#46515d]"
                onClick={() => setShowExtInstall(false)}
              >
                关闭
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-lg border border-[#30363d] bg-[#0d1117] px-3 py-1.5 text-xs text-[#c9d1d9] hover:border-[#46515d]"
                onClick={async () => {
                  const ok = await recheckExtensionPresence();
                  setExtDiag(getExtensionDetectionDiagnostics());
                  if (ok) {
                    setShowExtInstall(false);
                    void openExtensionScan();
                  }
                }}
              >
                <RefreshCw className="h-3 w-3" /> 我已安装，重新检测
              </button>
              <button
                type="button"
                className="rounded-lg bg-[#00d4aa] px-3 py-1.5 text-xs font-semibold text-[#06231d] hover:bg-[#00e6b8]"
                onClick={() => {
                  setShowExtInstall(false);
                  setSidebarTab('models');
                }}
              >
                前往模型下载面板
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex w-[198px] shrink-0 flex-col overflow-hidden border-r border-[#21262d]">
          <div className="flex items-center justify-between border-b border-[#21262d] px-3 py-2">
            <span className="text-xs font-medium text-[#e6edf3]">文件夹</span>
            <button
              type="button"
              onClick={() => setShowNewFolder((current) => !current)}
              className="flex h-6 w-6 items-center justify-center rounded hover:bg-[#21262d] text-[#8b949e]"
              title="新建文件夹"
            >
              <FolderPlus className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            <FolderTreeItem
              folder={folderLookup.get('root')!}
              folders={folders}
              expandedFolders={expandedFolders}
              selectedFolderId={selectedFolderId}
              folderRenameId={folderRenameId}
              folderRenameValue={folderRenameValue}
              onToggleFolder={(folderId) => {
                setExpandedFolders((current) => {
                  const next = new Set(current);
                  if (next.has(folderId)) next.delete(folderId);
                  else next.add(folderId);
                  return next;
                });
              }}
              onSelectFolder={selectFolder}
              onStartRename={(folder) => {
                setFolderRenameId(folder.id);
                setFolderRenameValue(folder.name);
              }}
              onFolderRenameValue={setFolderRenameValue}
              onSaveRename={handleSaveFolderRename}
              onContextMenu={(event, folderId) => {
                event.preventDefault();
                setContextMenu({ x: event.clientX, y: event.clientY, kind: 'folder', folderId });
              }}
            />

            {showNewFolder ? (
              <div className="mt-3 px-2">
                <input
                  value={newFolderName}
                  onChange={(event) => setNewFolderName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') handleCreateFolder();
                    if (event.key === 'Escape') setShowNewFolder(false);
                  }}
                  placeholder="输入文件夹名称"
                  className="w-full rounded-lg border border-[#30363d] bg-[#0d1117] px-2 py-1.5 text-xs text-[#e6edf3] outline-none focus:border-[#00d4aa]"
                />
              </div>
            ) : null}

            <div className="mt-4 px-2">
              <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-[#6e7681]">媒体分栏</div>
              <div className="space-y-1">
                {mediaFolders.map((folder) => (
                  <button
                    key={folder.id}
                    type="button"
                    data-testid={`asset-media-folder-${folder.id.replace(/[^a-z0-9:_-]+/gi, '-')}`}
                    onClick={() => handleSelectAssetFolder(folder.id, { tab: folder.tab })}
                    className={`flex w-full items-center justify-between rounded-lg px-2 py-1 text-left text-xs transition-colors ${
                      selectedFolderId === folder.id ? 'bg-[#00d4aa]/10 text-[#00d4aa]' : 'text-[#8b949e] hover:bg-[#21262d] hover:text-[#c9d1d9]'
                    }`}
                  >
                    <span className="truncate">{folder.name}</span>
                    <span className="text-[10px] text-[#6e7681]">{folder.count}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-4 px-2">
              <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-[#6e7681]">去重看板</div>
              <button
                type="button"
                data-testid="asset-duplicate-dashboard"
                onClick={handleDetectDuplicates}
                className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                  showDuplicatesOnly
                    ? 'bg-[#ffb454]/12 text-[#ffd29a]'
                    : 'text-[#8b949e] hover:bg-[#21262d] hover:text-[#c9d1d9]'
                }`}
              >
                <span className="flex items-center gap-1.5 truncate">
                  <Copy className="h-3.5 w-3.5" />
                  重复素材
                </span>
                <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${duplicateCount > 0 ? 'bg-[#ffb454]/20 text-[#ffd29a]' : 'text-[#6e7681]'}`}>
                  {duplicateCount}
                </span>
              </button>
              {showDuplicatesOnly && duplicateCount > 0 ? (
                <div className="mt-1 flex gap-1">
                  <button
                    type="button"
                    data-testid="asset-duplicate-dashboard-merge"
                    onClick={() => setShowMergeConfirm(true)}
                    className="flex-1 rounded-lg border border-[#00d4aa]/40 bg-[#00d4aa]/10 px-2 py-1 text-[11px] text-[#7cf7d4] hover:bg-[#00d4aa]/20"
                  >
                    一键合并
                  </button>
                  <button
                    type="button"
                    onClick={handleClearDuplicates}
                    className="rounded-lg border border-[#30363d] bg-[#11161d] px-2 py-1 text-[11px] text-[#8b949e] hover:text-[#c9d1d9]"
                  >
                    退出
                  </button>
                </div>
              ) : null}
            </div>

            <div className="mt-4 px-2">
              <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-[#6e7681]">智能分类文件夹</div>
              <div className="space-y-1">
                {smartCategoryFolders.slice(0, 16).map((category) => (
                  <button
                    key={category.id}
                    type="button"
                    data-testid={`asset-smart-folder-${category.name}`}
                    onClick={() => handleSelectAssetFolder(category.id, { tab: 'all' })}
                    className={`flex w-full items-center justify-between rounded-lg px-2 py-1 text-left text-xs transition-colors ${
                      selectedFolderId === category.id ? 'bg-[#00d4aa]/10 text-[#00d4aa]' : 'text-[#8b949e] hover:bg-[#21262d] hover:text-[#c9d1d9]'
                    }`}
                  >
                    <span className="truncate">{category.name}</span>
                    <span className="text-[10px] text-[#6e7681]">{category.count}</span>
                  </button>
                ))}
                {smartCategoryFolders.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-[#30363d] px-2 py-2 text-[11px] text-[#6e7681]">
                    导入后会按主体、风格、场景等信息自动归入可点击的分类目录。
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          <div className="border-t border-[#21262d] px-3 py-2 text-[10px] text-[#6e7681]">
            双击素材可放大预览；拖拽中间分隔线可调整面板宽度
          </div>
        </div>

        <div
          className="flex min-w-0 flex-1 overflow-hidden"
          style={{ flexDirection: 'row' }}
        >
        <div className="flex min-w-0 h-full flex-col overflow-hidden" style={{ flex: '1 1 0%', minWidth: 0 }}>
          <div className="flex flex-wrap items-center gap-2 border-b border-[#21262d] px-3 py-2">
            <span className="max-w-[120px] truncate text-xs font-medium text-[#e6edf3]">{selectedFolderName}</span>
            <span className="text-xs text-[#6e7681]">{visibleItems.length} 项</span>
            {selectedItemIds.length > 0 ? (
              <>
                <span className="text-xs text-[#8b949e]">已选 {selectedItemIds.length}</span>
                <div className="flex items-center gap-1">
                  <input
                    value={batchTagInput}
                    onChange={(event) => setBatchTagInput(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter') handleBatchTag(); }}
                    placeholder="批量打标签"
                    data-testid="asset-batch-tag-input"
                    className="w-[110px] rounded-lg border border-[#30363d] bg-[#0d1117] px-2 py-1 text-xs text-[#e6edf3] outline-none focus:border-[#00d4aa]"
                  />
                  <button
                    type="button"
                    data-testid="asset-batch-tag-apply"
                    onClick={handleBatchTag}
                    className="flex items-center gap-1 rounded-lg border border-[#30363d] bg-[#11161d] px-2 py-1 text-[11px] text-[#8b949e] hover:text-[#c9d1d9]"
                  >
                    <Tag className="h-3.5 w-3.5" />
                    应用
                  </button>
                </div>
                <button
                  type="button"
                  data-testid="asset-batch-classify"
                  onClick={handleBatchClassify}
                  className="flex items-center gap-1 rounded-lg border border-[#30363d] bg-[#11161d] px-2 py-1 text-[11px] text-[#8b949e] hover:text-[#c9d1d9]"
                >
                  <Wand2 className="h-3.5 w-3.5" />
                  批量分类
                </button>
                <button
                  type="button"
                  data-testid="asset-batch-analyze"
                  onClick={handleBatchAnalyze}
                  disabled={batchAnalyzeProgress.running}
                  className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] transition-colors ${
                    batchAnalyzeProgress.running
                      ? 'border-[#30363d] bg-[#2a2a2c] text-[#6e7681]'
                      : 'border-[#30363d] bg-[#11161d] text-[#8b949e] hover:text-[#c9d1d9]'
                  }`}
                >
                  <Brain className="h-3.5 w-3.5" />
                  {batchAnalyzeProgress.running
                    ? `分析中 ${batchAnalyzeProgress.done}/${batchAnalyzeProgress.total}`
                    : '批量分析'}
                </button>
                <div className="flex items-center gap-1 rounded-lg border border-[#30363d] bg-[#0d1117] px-1.5 py-0.5 text-[10px] text-[#6e7681]">
                  <span>并发</span>
                  <select
                    value={analyzeConcurrency}
                    onChange={(event) => setAnalyzeConcurrency(Number(event.target.value))}
                    data-testid="asset-analyze-concurrency"
                    title="批量分析并发数（0=按选中数量自适应，>20 自动提到 5）"
                    className="bg-transparent text-[11px] text-[#c9d1d9] outline-none"
                  >
                    <option value={0}>自动</option>
                    <option value={1}>1</option>
                    <option value={2}>2</option>
                    <option value={3}>3</option>
                    <option value={4}>4</option>
                    <option value={5}>5</option>
                    <option value={6}>6</option>
                  </select>
                  <span>重试</span>
                  <select
                    value={analyzeRetries}
                    onChange={(event) => setAnalyzeRetries(Number(event.target.value))}
                    data-testid="asset-analyze-retries"
                    title="单图分析失败重试次数"
                    className="bg-transparent text-[11px] text-[#c9d1d9] outline-none"
                  >
                    <option value={0}>0</option>
                    <option value={1}>1</option>
                    <option value={2}>2</option>
                    <option value={3}>3</option>
                  </select>
                </div>
                <div className="flex items-center gap-1">
                  <select
                    value={batchMoveFolderId}
                    onChange={(event) => setBatchMoveFolderId(event.target.value)}
                    data-testid="asset-batch-move-select"
                    className="rounded-lg border border-[#30363d] bg-[#0d1117] px-2 py-1 text-xs text-[#c9d1d9] outline-none"
                  >
                    {folders.map((folder) => (
                      <option key={folder.id} value={folder.id} className="bg-[#0d1117]">
                        {folder.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    data-testid="asset-batch-move-apply"
                    onClick={handleBatchMove}
                    className="flex items-center gap-1 rounded-lg border border-[#30363d] bg-[#11161d] px-2 py-1 text-[11px] text-[#8b949e] hover:text-[#c9d1d9]"
                  >
                    <Folder className="h-3.5 w-3.5" />
                    移动
                  </button>
                </div>
                <button
                  type="button"
                  data-testid="asset-delete-selected"
                  onClick={() => handleDeleteItems(selectedItemIds)}
                  className="flex items-center gap-1 text-xs text-[#ef4444] hover:text-[#ff6b6b]"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  删除选中
                </button>
                <button
                  type="button"
                  onClick={clearSelection}
                  className="text-xs text-[#8b949e] hover:text-[#c9d1d9]"
                >
                  清空选择
                </button>
              </>
            ) : null}
            <button
              type="button"
              data-testid="asset-detect-duplicates"
              onClick={handleDetectDuplicates}
              className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] transition-colors ${
                showDuplicatesOnly
                  ? 'border-[#ffb454] bg-[#ffb454]/12 text-[#ffd29a]'
                  : 'border-[#30363d] bg-[#11161d] text-[#8b949e] hover:text-[#c9d1d9]'
              }`}
            >
              <Copy className="h-3.5 w-3.5" />
              查找重复{duplicateCount > 0 ? ` (${duplicateCount})` : ''}
            </button>
            {duplicateCount > 0 ? (
              <>
                <button
                  type="button"
                  data-testid="asset-merge-duplicates"
                  onClick={() => setShowMergeConfirm(true)}
                  className="flex items-center gap-1 rounded-lg border border-[#00d4aa]/40 bg-[#00d4aa]/10 px-2 py-1 text-[11px] text-[#7cf7d4] hover:bg-[#00d4aa]/20"
                >
                  <Copy className="h-3.5 w-3.5" />
                  合并重复（仅留原图）
                </button>
                <button
                  type="button"
                  data-testid="asset-clear-duplicates"
                  onClick={handleClearDuplicates}
                  className="text-xs text-[#8b949e] hover:text-[#c9d1d9]"
                >
                  清除重复标记
                </button>
              </>
            ) : null}
            <button
              type="button"
              data-testid="asset-multi-select-toggle"
              onClick={() => setMultiSelectMode((current) => !current)}
              className={`rounded-lg border px-2 py-1 text-[11px] transition-colors ${
                multiSelectMode
                  ? 'border-[#00d4aa] bg-[#00d4aa]/12 text-[#7cf7d4]'
                  : 'border-[#30363d] bg-[#11161d] text-[#8b949e] hover:text-[#c9d1d9]'
              }`}
            >
              {multiSelectMode ? '多选模式已开' : '开启多选模式'}
            </button>
            <span className="text-[11px] text-[#6e7681]">
              {multiSelectMode
                ? '当前可直接点卡片连续多选；切到“全部素材”可混选图片、视频和音频。'
                : '点素材左上角勾选，或先开启多选模式；切到“全部素材”可混选图片、视频和音频。'}
            </span>

            <div className="ml-auto flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 rounded-lg border border-[#30363d] bg-[#161b22] px-2 py-1.5 text-xs text-[#c9d1d9]">
                <span>收录到</span>
                <select
                  data-testid="asset-import-folder-select"
                  value={importTargetFolderId}
                  onChange={(event) => setImportTargetFolder(event.target.value)}
                  className="bg-transparent text-xs outline-none"
                >
                  {folders.map((folder) => (
                    <option key={folder.id} value={folder.id} className="bg-[#0d1117]">
                      {folder.name}
                    </option>
                  ))}
                </select>
              </label>

              <div className="relative min-w-0 flex-1">
                <AssetSearchBar
                  value={searchQuery}
                  onChange={setSearchQuery}
                  onSearch={() => { /* search is reactive in store */ }}
                  allItems={items}
                  placeholder="搜索素材、标签、来源…"
                />
              </div>

              <button
                type="button"
                onClick={handleUpload}
                data-testid="asset-import-files-button"
                disabled={isUploading || isImportingFolder}
                className={`flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
                  isUploading || isImportingFolder
                    ? 'bg-[#2a2a2c] text-[#6e7681]'
                    : 'bg-[#00d4aa]/10 text-[#00d4aa] hover:bg-[#00d4aa]/20'
                }`}
              >
                <Upload className="h-3.5 w-3.5" />
                {isUploading ? '导入中...' : '导入文件'}
              </button>
              <button
                type="button"
                onClick={handleImportFolder}
                data-testid="asset-import-folder-button"
                disabled={isUploading || isImportingFolder}
                className={`flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
                  isUploading || isImportingFolder
                    ? 'bg-[#2a2a2c] text-[#6e7681]'
                    : 'bg-[#1a2332] text-[#8fd0ff] hover:bg-[#24324a]'
                }`}
                title="按文件夹批量导入本地素材，并基于目录结构、文件名和素材类型自动打标签与分类。"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                {isImportingFolder ? '导入文件夹中...' : '导入文件夹'}
              </button>
              <button
                type="button"
                onClick={handlePruneMissing}
                disabled={isPruningMissing || isUploading || isImportingFolder}
                data-testid="asset-prune-missing-button"
                title="清理素材目录中本地文件已缺失的死引用条目（避免 /api/assets/content/<id> 反复 404）"
                className={`flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
                  isPruningMissing || isUploading || isImportingFolder
                    ? 'bg-[#2a2a2c] text-[#6e7681]'
                    : 'bg-[#2a1f1f] text-[#ff9b9b] hover:bg-[#3a2626]'
                }`}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {isPruningMissing ? '清理中...' : '清理失效引用'}
              </button>
              <button
                type="button"
                onClick={() => setViewMode(viewMode === 'grid' ? 'list' : 'grid')}
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#30363d] bg-[#0d1117] text-[#8b949e] hover:text-[#c9d1d9]"
                title={viewMode === 'grid' ? '切换列表' : '切换网格'}
              >
                {viewMode === 'grid' ? <List className="h-3.5 w-3.5" /> : <Grid3X3 className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>

          {pruneMessage ? (
            <div className="flex items-center gap-2 border-b border-[#21262d] bg-[#161b22] px-3 py-1.5 text-[11px] text-[#8b949e]">
              <AlertCircle className="h-3 w-3 shrink-0 text-[#ff9b9b]" />
              <span className="min-w-0 flex-1 truncate">{pruneMessage}</span>
              <button
                type="button"
                onClick={() => setPruneMessage(null)}
                className="shrink-0 rounded px-1 text-[#6e7681] hover:text-[#c9d1d9]"
                aria-label="关闭提示"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2 border-b border-[#21262d] px-3 py-2">
            <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-[#30363d] bg-[#161b22] px-3 py-2">
              <Folder className="h-3.5 w-3.5 text-[#8b949e]" />
              <span className="shrink-0 text-xs text-[#8b949e]">存储路径</span>
              <input
                data-testid="asset-storage-path-input"
                value={storageDraft}
                onChange={(event) => {
                  setStorageDraft(event.target.value);
                  if (storageStatus) setStorageStatus(null);
                }}
                placeholder="输入资产库存储目录"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void handleSaveStoragePathInteractive();
                  }
                }}
                className="min-w-0 flex-1 bg-transparent text-xs text-[#e6edf3] outline-none"
              />
            </label>
            <button
              type="button"
              data-testid="asset-storage-path-pick"
              onClick={() => void handlePickStoragePathInteractive()}
              disabled={isPickingStoragePath}
              className={`rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                isPickingStoragePath
                  ? 'border-[#21463e] bg-[#10241f] text-[#79d8c0]'
                  : 'border-[#30363d] bg-[#161b22] text-[#8b949e] hover:text-[#c9d1d9]'
              }`}
            >
              {isPickingStoragePath ? '选择中...' : '选择文件夹'}
            </button>
            <button
              type="button"
              data-testid="asset-storage-path-reset"
              onClick={handleResetStoragePathInteractive}
              className={`rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                defaultStoragePathActive
                  ? 'border-[#21463e] bg-[#10241f] text-[#79d8c0]'
                  : 'border-[#30363d] bg-[#161b22] text-[#8b949e] hover:text-[#c9d1d9]'
              }`}
            >
              默认路径
            </button>
            <button
              type="button"
              data-testid="asset-storage-path-save"
              onClick={() => void handleSaveStoragePathInteractive()}
              disabled={isSavingStoragePath || isPickingStoragePath || !storageDraft.trim()}
              className={`rounded-lg px-3 py-1.5 text-xs transition-colors ${
                isSavingStoragePath || isPickingStoragePath || !storageDraft.trim()
                  ? 'bg-[#2a2a2c] text-[#6e7681]'
                  : storagePathChanged
                    ? 'bg-[#00d4aa]/12 text-[#4de3c3] hover:bg-[#00d4aa]/20'
                    : 'bg-[#1f2c29] text-[#9fd8ca] hover:bg-[#243531]'
              }`}
            >
              {isSavingStoragePath ? '保存中...' : '保存路径'}
            </button>
            <div data-testid="asset-storage-current-path" className="min-w-0 flex-1 text-right text-[11px] text-[#6e7681]">
              {isLoadingAssetLibrary ? '正在同步资产库配置...' : `当前落库目录：${storagePath || '未设置'}`}
            </div>
          </div>

          {storageStatus ? (
            <div
              className={`border-b px-3 py-2 text-xs ${
                storageStatus.type === 'success'
                  ? 'border-[#123b31] bg-[#0f201a] text-[#7ee787]'
                  : 'border-[#4a1d1d] bg-[#231818] text-[#ffb4b4]'
              }`}
              data-testid="asset-storage-path-status"
            >
              {storageStatus.message}
            </div>
          ) : null}

          {importStatus ? (
            <div
              className={`border-b px-3 py-2 text-xs ${
                importStatus.type === 'success'
                  ? 'border-[#123b31] bg-[#0f201a] text-[#7ee787]'
                  : 'border-[#4a1d1d] bg-[#231818] text-[#ffb4b4]'
              }`}
              data-testid="asset-import-status"
            >
              {importStatus.message}
            </div>
          ) : null}

          {batchAnalyzeProgress.running || batchAnalyzeProgress.failedItems.length > 0 ? (
            <div className="border-b border-[#21262d] bg-[#0f141b] px-3 py-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="text-[#8b949e]">
                  批量分析进度：{batchAnalyzeProgress.done}/{batchAnalyzeProgress.total}
                  {batchAnalyzeProgress.failed > 0 ? `（失败 ${batchAnalyzeProgress.failed}）` : ''}
                </span>
                <span className="text-[10px] text-[#6e7681]">
                  {analyzeConcurrency > 0 ? `并发 ${analyzeConcurrency}` : '并发 自动'}
                  {' · '}重试 {analyzeRetries}
                  {analyzeScopeNote ? ` · ${analyzeScopeNote}` : ''}
                </span>
                {batchAnalyzeProgress.failedItems.length > 0 ? (
                  <div className="ml-auto flex items-center gap-1">
                    <button
                      type="button"
                      data-testid="asset-retry-failed"
                      onClick={() => handleRetryFailedAnalyze()}
                      disabled={batchAnalyzeProgress.running}
                      className={`flex items-center gap-1 rounded-lg border px-2 py-0.5 text-[11px] transition-colors ${
                        batchAnalyzeProgress.running
                          ? 'border-[#30363d] bg-[#2a2a2c] text-[#6e7681]'
                          : 'border-[#00d4aa]/40 bg-[#00d4aa]/10 text-[#7cf7d4] hover:bg-[#00d4aa]/20'
                      }`}
                    >
                      <RefreshCw className="h-3 w-3" />
                      仅重跑失败
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowFailureList((current) => !current)}
                      className="flex items-center gap-1 rounded-lg border border-[#f85149]/40 bg-[#f85149]/10 px-2 py-0.5 text-[11px] text-[#ff9b9b] hover:bg-[#f85149]/20"
                    >
                      <AlertCircle className="h-3 w-3" />
                      失败清单（{batchAnalyzeProgress.failedItems.length}）
                    </button>
                  </div>
                ) : null}
              </div>
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[#21262d]">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-[#00d4aa] to-[#1a8cff] transition-all"
                  style={{
                    width: `${batchAnalyzeProgress.total ? Math.round((batchAnalyzeProgress.done / batchAnalyzeProgress.total) * 100) : 0}%`,
                  }}
                />
              </div>
              {showFailureList && batchAnalyzeProgress.failedItems.length > 0 ? (
                <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto pr-1">
                  {batchAnalyzeProgress.failedItems.map((entry) => (
                    <li key={entry.id} className="flex items-center gap-2 rounded-lg bg-[#1a1010] px-2 py-1">
                      <AlertCircle className="mt-0.5 h-3 w-3 shrink-0 self-start text-[#f85149]" />
                      <div className="min-w-0 flex-1">
                        <span className="text-[11px] text-[#e6edf3]">{entry.name}</span>
                        <p className="truncate text-[10px] text-[#ff9b9b]">{entry.error}</p>
                      </div>
                      <button
                        type="button"
                        data-testid="asset-retry-failed-item"
                        onClick={() => handleRetryFailedAnalyze([entry.id])}
                        disabled={batchAnalyzeProgress.running}
                        title="重试该素材"
                        className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] transition-colors ${
                          batchAnalyzeProgress.running
                            ? 'border-[#30363d] bg-[#2a2a2c] text-[#6e7681]'
                            : 'border-[#00d4aa]/40 bg-[#00d4aa]/10 text-[#7cf7d4] hover:bg-[#00d4aa]/20'
                        }`}
                      >
                        重试
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}


          {operationHistory.length > 0 ? (
            <div className="flex items-center gap-2 border-b border-[#21262d] bg-[#0f141b] px-3 py-1.5 text-xs">
              <span className="text-[#8b949e]">
                已执行：{operationHistory[0].label}
              </span>
              <button
                type="button"
                data-testid="asset-undo-last"
                onClick={() => {
                  const label = undoLastOperation();
                  if (label) {
                    setImportStatus({ type: 'success', message: `已撤销：${label}` });
                  }
                }}
                className="ml-auto flex items-center gap-1 rounded-lg border border-[#00d4aa]/40 bg-[#00d4aa]/10 px-2 py-0.5 text-[11px] text-[#7cf7d4] hover:bg-[#00d4aa]/20"
              >
                <RefreshCw className="h-3 w-3" />
                撤销
              </button>
            </div>
          ) : null}

          {showMergeConfirm ? (() => {
            const candidates = items.filter((item) => Boolean(item.duplicateOf));
            const canonicalName = (id: string) => items.find((entry) => entry.id === id)?.name || id;
            return (
              <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
                data-testid="asset-merge-confirm"
                onClick={(event) => { if (event.target === event.currentTarget) setShowMergeConfirm(false); }}
              >
                <div className="w-full max-w-md rounded-2xl border border-[#30363d] bg-[#0d1117] p-4 shadow-2xl">
                  <div className="mb-3 flex items-center gap-2">
                    <Copy className="h-4 w-4 text-[#00d4aa]" />
                    <span className="text-sm font-medium text-[#e6edf3]">确认合并重复素材</span>
                  </div>
                  <p className="mb-3 text-[11px] leading-relaxed text-[#8b949e]">
                    将删除以下 {candidates.length} 个重复素材，仅保留各自对应的原始版本。此操作已纳入撤销历史，可随时还原。
                  </p>
                  <div className="mb-4 max-h-60 space-y-1.5 overflow-y-auto pr-1">
                    {candidates.map((item) => (
                      <div key={item.id} className="flex items-center gap-2 rounded-lg bg-[#161b22] px-2 py-1.5">
                        {item.thumbnail ? (
                          <img src={toRenderableAssetUrl(item.thumbnail, 'image')} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
                        ) : (
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-[#21262d] text-[#6e7681]">
                            <Copy className="h-3.5 w-3.5" />
                          </span>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[11px] text-[#c9d1d9]">{item.name}</p>
                          <p className="truncate text-[10px] text-[#6e7681]">重复自：{canonicalName(item.duplicateOf || '')}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setShowMergeConfirm(false)}
                      className="rounded-lg border border-[#30363d] bg-[#11161d] px-3 py-1.5 text-xs text-[#8b949e] hover:text-[#c9d1d9]"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      data-testid="asset-merge-confirm-ok"
                      onClick={() => {
                        const removed = removeDuplicateItems();
                        setShowMergeConfirm(false);
                        setDuplicateCount(0);
                        setShowDuplicatesOnly(false);
                        if (removed > 0) {
                          setImportStatus({ type: 'success', message: `已合并 ${removed} 个重复素材，仅保留原始版本（可撤销）。` });
                        }
                      }}
                      className="rounded-lg bg-[#00d4aa] px-3 py-1.5 text-xs font-medium text-[#07110e] hover:bg-[#00e5b3]"
                    >
                      确认合并
                    </button>
                  </div>
                </div>
              </div>
            );
          })() : null}


          <div className="flex flex-wrap items-center gap-2 border-b border-[#21262d] px-3 py-2">
            <input
              data-testid="asset-url-input"
              value={urlCollectValue}
              onChange={(event) => setUrlCollectValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleCollectUrl();
              }}
              placeholder={`粘贴图片/视频链接，默认收录到 ${importFolderName}`}
              className="min-w-0 flex-1 rounded-lg border border-[#30363d] bg-[#161b22] px-3 py-1.5 text-xs text-[#e6edf3] outline-none focus:border-[#00d4aa]"
            />
            <input
              data-testid="asset-url-name-input"
              value={urlCollectName}
              onChange={(event) => setUrlCollectName(event.target.value)}
              placeholder="素材名称（可选）"
              className="w-[180px] rounded-lg border border-[#30363d] bg-[#161b22] px-3 py-1.5 text-xs text-[#e6edf3] outline-none focus:border-[#00d4aa]"
            />
            <button
              type="button"
              data-testid="asset-url-collect-button"
              onClick={() => void handleCollectUrl()}
              disabled={!urlCollectValue.trim() || isCollectingUrl}
              className={`flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs transition-colors ${
                !urlCollectValue.trim() || isCollectingUrl
                  ? 'bg-[#2a2a2c] text-[#6e7681]'
                  : 'bg-[#1a8cff]/15 text-[#8fd0ff] hover:bg-[#1a8cff]/25'
              }`}
            >
              {isCollectingUrl ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              收录网址素材
            </button>

              <select
                value={sortBy}
                onChange={(event) => setSortBy(event.target.value as 'name' | 'date' | 'size')}
                className="rounded-lg border border-[#30363d] bg-[#161b22] px-2.5 py-1.5 text-xs text-[#c9d1d9] outline-none"
              >
              <option value="date">按更新时间</option>
              <option value="name">按名称</option>
              <option value="size">按大小</option>
            </select>
          </div>

          <div ref={gridContainerRef} className="min-h-0 flex-1 overflow-y-auto p-3">
            {activeTab === 'workflow' ? (
              <div className="space-y-2">
                {workflows.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 text-[#6e7681]">
                    <FolderOpen className="mb-3 h-10 w-10 opacity-30" />
                    <p className="text-sm">暂无工作流</p>
                    <p className="mt-1 text-[10px]">后续保存后的工作流会在这里继续复用</p>
                  </div>
                ) : workflows.map((workflow) => (
                  <div
                    key={workflow.id}
                    className="group flex items-center gap-3 rounded-xl bg-[#161b22] px-3 py-2.5 ring-1 ring-[#21262d] transition-all hover:bg-[#1c1c1e] hover:ring-[#3a3a3c]"
                  >
                    <div className="h-3 w-3 shrink-0 rounded-full" style={{ background: workflow.color }} />
                    <div className="min-w-0 flex-1">
                      {workflowRenameId === workflow.id ? (
                        <input
                          value={workflowRenameValue}
                          onChange={(event) => setWorkflowRenameValue(event.target.value)}
                          onBlur={() => {
                            renameWorkflow(workflow.id, workflowRenameValue);
                            setWorkflowRenameId(null);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              renameWorkflow(workflow.id, workflowRenameValue);
                              setWorkflowRenameId(null);
                            }
                          }}
                          autoFocus
                          className="w-full rounded border border-[#00d4aa] bg-[#0d1117] px-2 py-1 text-xs text-[#e6edf3] outline-none"
                        />
                      ) : (
                        <>
                          <div className="truncate text-sm font-medium text-[#e6edf3]">{workflow.name}</div>
                          <div className="truncate text-[10px] text-[#8b949e]">{workflow.description || '无描述'}</div>
                        </>
                      )}
                    </div>
                    <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        type="button"
                        onClick={() => loadWorkflow(workflow.id)}
                        className="rounded-lg px-2.5 py-1 text-xs text-[#00d4aa] hover:bg-[#00d4aa]/10"
                      >
                        加载
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setWorkflowRenameId(workflow.id);
                          setWorkflowRenameValue(workflow.name);
                        }}
                        className="rounded-lg p-1.5 text-[#8b949e] hover:bg-[#21262d] hover:text-[#c9d1d9]"
                        title="重命名工作流"
                      >
                        <Edit3 className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteWorkflow(workflow.id)}
                        className="rounded-lg p-1.5 text-[#8b949e] hover:bg-[#21262d] hover:text-[#ef4444]"
                        title="删除工作流"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : visibleItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-[#6e7681]">
                <Folder className="mb-3 h-10 w-10 opacity-30" />
                <p className="text-sm">当前分类下还没有素材</p>
                <p className="mt-1 text-[10px]">可以上传本地文件、收录网页链接，或打开联网搜索采集素材</p>
              </div>
            ) : (
              <>
                {showDuplicatesOnly && duplicateGroups.length > 0 ? (
                  <div
                    className="mb-3 rounded-xl border border-[#ffb454]/25 bg-[#1a1408]/40 p-3"
                    data-testid="asset-duplicate-dashboard-panel"
                  >
                    <div className="mb-2 flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-xs font-medium text-[#ffd29a]">
                        <Copy className="h-3.5 w-3.5" />
                        去重看板（{duplicateGroups.length} 组，{duplicateCount} 个重复）
                      </span>
                      <button
                        type="button"
                        onClick={handleClearDuplicates}
                        className="rounded-lg border border-[#30363d] bg-[#11161d] px-2 py-0.5 text-[10px] text-[#8b949e] hover:text-[#c9d1d9]"
                      >
                        退出
                      </button>
                    </div>
                    <div className="space-y-2">
                      {duplicateGroups.map((group) => (
                        <div key={group.canonicalId} className="rounded-lg border border-[#30363d] bg-[#0d1117] p-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-[11px] text-[#e6edf3]">规范项：{group.name || group.canonicalId}</span>
                            <span className="shrink-0 rounded-full bg-[#ffb454]/20 px-1.5 py-0.5 text-[10px] text-[#ffd29a]">
                              {group.duplicateIds.length} 重复
                            </span>
                          </div>
                          <div className="mt-1.5 flex gap-1.5">
                            <button
                              type="button"
                              data-testid="asset-merge-group"
                              onClick={() => handleMergeGroup(group)}
                              className="flex-1 rounded-lg border border-[#00d4aa]/40 bg-[#00d4aa]/10 px-2 py-1 text-[11px] text-[#7cf7d4] hover:bg-[#00d4aa]/20"
                            >
                              合并这组
                            </button>
                            <button
                              type="button"
                              data-testid="asset-locate-group"
                              onClick={() => handleLocateGroup(group.canonicalId)}
                              className="flex-1 rounded-lg border border-[#30363d] bg-[#11161d] px-2 py-1 text-[11px] text-[#8b949e] hover:text-[#c9d1d9]"
                            >
                              定位
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                {viewMode === 'grid' ? (
              <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))` }}>
                {visibleItems.map((item) => {
                  const selected = selectedItemIds.includes(item.id);
                  return (
                    <div
                      key={item.id}
                      data-testid="asset-card"
                      data-asset-id={item.id}
                      data-asset-type={item.type}
                      onClick={(event) => handleCardClick(item, event.ctrlKey || event.metaKey || event.shiftKey)}
                      onDoubleClick={() => handleCardDoubleClick(item)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        selectPreviewItem(item.id);
                        setContextMenu({ x: event.clientX, y: event.clientY, kind: 'item', itemId: item.id });
                      }}
                      className={`group overflow-hidden rounded-2xl bg-[#161b22] ring-1 transition-all ${
                        selected ? 'ring-[#00d4aa]' : 'ring-[#21262d] hover:ring-[#3b434b]'
                      }`}
                    >
                      <div className="relative aspect-square overflow-hidden bg-[#0d1117]">
                        {item.duplicateOf ? (
                          <span
                            data-testid="asset-duplicate-badge"
                            className="absolute left-1.5 top-1.5 z-10 rounded-md bg-[#ffb454]/90 px-1.5 py-0.5 text-[10px] font-medium text-[#1c1305]"
                            title={`重复素材，原始素材：${item.duplicateOf}`}
                          >
                            重复
                          </span>
                        ) : null}
                        {item.type === 'image' ? (
                          isPreviewLimitedImageAsset(item) ? (
                            <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-[radial-gradient(circle_at_top,#243247,transparent_58%),linear-gradient(180deg,#11161d,#0d1117)] px-3 text-center">
                              <ImageIcon className="h-8 w-8 text-[#8fd0ff]" />
                              <div className="text-[11px] font-medium text-[#dbeafe]">
                                {getAssetExtension(item).toUpperCase() || 'HDR'}
                              </div>
                              <div className="text-[10px] leading-4 text-[#8b949e]">
                                已兼容入库与分类，当前浏览器预览受限
                              </div>
                            </div>
                          ) : (
                            brokenImageIds.has(item.id) ? (
                              <div className="flex h-full w-full items-center justify-center bg-[#11161d] text-[#8b949e]">
                                <ImageIcon className="h-8 w-8" />
                              </div>
                            ) : (
                              <img
                                src={renderAssetUrl(item)}
                                alt={item.name}
                                className="h-full w-full object-cover"
                                loading="lazy"
                                onError={() => handleGridImageError(item.id)}
                              />
                            )
                          )
                        ) : item.type === 'video' ? (
                          <div
                            className="h-full w-full"
                            onMouseEnter={() => handleVideoMouseEnter(item.id)}
                            onMouseLeave={() => handleVideoMouseLeave(item.id)}
                          >
                            <video
                              ref={(element) => { videoRefs.current[item.id] = element; }}
                              src={renderAssetUrl(item)}
                              className="h-full w-full object-cover"
                              preload="metadata"
                              muted
                              loop
                              playsInline
                            />
                            {hoveredVideo !== item.id ? (
                              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-black/50">
                                  <Play className="h-4 w-4 text-white" />
                                </div>
                              </div>
                            ) : null}
                          </div>
                        ) : item.type === 'audio' ? (
                          <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-[#a855f7]">
                            <Music className="h-10 w-10" />
                            <span className="text-[10px] text-[#b9a7d9]">音频素材</span>
                          </div>
                        ) : item.type === 'model' ? (
                          <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-[#a78bfa]">
                            <Box className="h-10 w-10" />
                            <span className="text-[10px] text-[#c4b5fd]">3D 模型</span>
                          </div>
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-[#8b949e]">
                            <FileText className="h-9 w-9" />
                          </div>
                        )}

                        <button
                          type="button"
                          data-testid={`asset-card-toggle-select-${item.id}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            handleToggleCardSelection(item);
                          }}
                          className="absolute left-2 top-2 rounded-md bg-black/35 p-0.5 transition-colors hover:bg-black/55"
                          title={selected ? '取消多选' : '加入多选'}
                        >
                          {selected ? (
                            <CheckSquare className="h-4 w-4 text-[#00d4aa]" />
                          ) : (
                            <Square className="h-4 w-4 text-white/75" />
                          )}
                        </button>

                        <div className="absolute right-2 top-2 rounded-full bg-black/55 px-2 py-0.5 text-[9px] text-white">
                          {getAssetBadge(item)}
                        </div>

                        {String(item.storageLabel || '').trim().toLowerCase() === 'reference' ? (
                          <div
                            data-testid={`asset-card-storage-${item.id}`}
                            className="absolute left-2 bottom-2 rounded-full bg-[#0b3b33]/90 px-2 py-0.5 text-[9px] text-[#8df4d7]"
                          >
                            原文件引用
                          </div>
                        ) : null}

                        <div className="absolute inset-x-0 bottom-2 flex items-center justify-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                          {(item.type === 'image' || item.type === 'video') ? (
                            <button
                              type="button"
                              data-testid={`asset-card-similar-${item.id}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                openSimilarSearch(item);
                              }}
                              className="rounded-full bg-black/60 px-2.5 py-1 text-[10px] text-white hover:bg-black/75"
                            >
                              相似搜索
                            </button>
                          ) : null}
                          <button
                            type="button"
                            data-testid={`asset-card-add-${item.id}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              addAssetToCanvas(item);
                            }}
                            className="rounded-full bg-[#00d4aa]/85 px-2.5 py-1 text-[10px] text-[#07110e] hover:bg-[#00e5b3]"
                          >
                            加到画布
                          </button>
                        </div>

                        {item.duration ? (
                          <div className="absolute bottom-2 right-2 rounded bg-black/60 px-1.5 py-0.5 text-[9px] text-white">
                            {formatDuration(item.duration)}
                          </div>
                        ) : null}
                      </div>

                      <div className="space-y-1 px-2.5 py-2">
                        <p className="truncate text-xs text-[#c9d1d9]" title={item.name}>{item.name}</p>
                        <p className="truncate text-[10px] text-[#6e7681]">
                          {item.width && item.height ? `${item.width} × ${item.height}` : item.duration ? formatDuration(item.duration) : '未记录尺寸'}
                          {' · '}
                          {formatBytes(item.size)}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="space-y-2">
                {visibleItems.map((item) => {
                  const selected = selectedItemIds.includes(item.id);
                  return (
                    <div
                      key={item.id}
                      data-testid="asset-card"
                      data-asset-id={item.id}
                      data-asset-type={item.type}
                      onClick={(event) => handleCardClick(item, event.ctrlKey || event.metaKey || event.shiftKey)}
                      onDoubleClick={() => handleCardDoubleClick(item)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        selectPreviewItem(item.id);
                        setContextMenu({ x: event.clientX, y: event.clientY, kind: 'item', itemId: item.id });
                      }}
                      className={`flex items-center gap-3 rounded-2xl bg-[#161b22] px-3 py-2 ring-1 transition-colors ${
                        selected ? 'ring-[#00d4aa]' : 'ring-[#21262d] hover:ring-[#3b434b]'
                      }`}
                    >
                      <button
                        type="button"
                        data-testid={`asset-card-toggle-select-${item.id}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleToggleCardSelection(item);
                        }}
                        className="rounded-lg p-1 text-[#8b949e] hover:bg-[#21262d] hover:text-[#c9d1d9]"
                        title={selected ? '取消多选' : '加入多选'}
                      >
                        {selected ? <CheckSquare className="h-4 w-4 text-[#00d4aa]" /> : <Square className="h-4 w-4" />}
                      </button>
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[#0d1117]">
                        {item.type === 'image' ? (
                          isPreviewLimitedImageAsset(item) ? (
                            <div className="flex h-full w-full items-center justify-center rounded-xl bg-[#11161d] text-[10px] font-medium text-[#8fd0ff]">
                              {getAssetExtension(item).toUpperCase() || 'HDR'}
                            </div>
                          ) : (
                            brokenImageIds.has(item.id) ? (
                              <ImageIcon className="h-5 w-5 text-[#8b949e]" />
                            ) : (
                              <img
                                src={renderAssetUrl(item)}
                                alt={item.name}
                                className="h-full w-full object-cover"
                                loading="lazy"
                                onError={() => handleGridImageError(item.id)}
                              />
                            )
                          )
                        ) : item.type === 'video' ? (
                          <Video className="h-5 w-5 text-[#ff6b35]" />
                        ) : item.type === 'audio' ? (
                          <Music className="h-5 w-5 text-[#a855f7]" />
                        ) : (
                          <FileText className="h-5 w-5 text-[#8b949e]" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-[#e6edf3]">{item.name}</div>
                        <div className="truncate text-[11px] text-[#8b949e]">
                          {getAssetBadge(item)} · {item.width && item.height ? `${item.width} × ${item.height}` : item.duration ? formatDuration(item.duration) : '未记录尺寸'} · {formatBytes(item.size)}
                        </div>
                      </div>
                      {(item.type === 'image' || item.type === 'video') ? (
                        <button
                          type="button"
                          data-testid={`asset-card-similar-${item.id}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            openSimilarSearch(item);
                          }}
                          className="rounded-lg px-2.5 py-1 text-xs text-[#8fd0ff] hover:bg-[#1a8cff]/10"
                        >
                          相似搜索
                        </button>
                      ) : null}
                      <button
                        type="button"
                        data-testid={`asset-card-add-${item.id}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          addAssetToCanvas(item);
                        }}
                        className="rounded-lg bg-[#00d4aa]/10 px-2.5 py-1 text-xs text-[#00d4aa] hover:bg-[#00d4aa]/20"
                      >
                        加到画布
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
          </div>
        </div>
        {previewItem ? (
          <>
            {/* 自定义拖拽分隔条：替代 react-resizable-panels，避免 flex-basis 冲突 */}
            <div
              onMouseDown={handlePreviewResizeStart}
              className={`group relative flex w-2 shrink-0 cursor-col-resize items-center justify-center transition-colors ${
                isResizingPreview ? 'bg-[#1a8cff]/30' : 'bg-[#21262d] hover:bg-[#1a8cff]/60'
              }`}
              title="拖拽调整预览面板宽度"
              data-testid="asset-preview-resize-handle"
            >
              <div className={`h-8 w-1 rounded-full transition-colors ${
                isResizingPreview ? 'bg-[#1a8cff]' : 'bg-[#30363d] group-hover:bg-[#1a8cff]'
              }`} />
            </div>
            {/* 预览面板：使用动态宽度替代百分比，确保尺寸精确可控 */}
            <div
              data-testid="asset-preview-panel"
              className="flex h-full shrink-0 flex-col overflow-hidden border-l border-[#21262d] bg-[#0d1117]"
              style={{ width: `${previewWidth}px` }}
            >
            <div className="flex items-center justify-between border-b border-[#21262d] px-3 py-2">
              <span className="text-xs font-medium text-[#e6edf3]">素材预览</span>
              <button
                type="button"
                onClick={() => selectPreviewItem(null)}
                className="flex h-6 w-6 items-center justify-center rounded hover:bg-[#21262d] text-[#8b949e]"
                title="关闭预览"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <div
                data-testid="asset-preview-media"
                className={getPreviewMediaClass(previewZoomed)}
                onClick={handleMediaClick}
                onDoubleClick={handleMediaDoubleClick}
                title={previewItem.type === 'image' || previewItem.type === 'video' ? '点击：联网相似搜索；双击：放大/缩小预览' : undefined}
              >
                {renderPreviewMedia}
              </div>
              {(previewItem.type === 'image' || previewItem.type === 'video') ? (
                <div className="mb-3 -mt-2 rounded-b-2xl border-t border-[#262626] bg-[#161b22] ring-1 ring-[#30363d] px-3 py-2 text-left text-[10px] text-[#8fd0ff] flex items-center justify-between">
                  <span>{previewZoomed ? '双击缩小恢复默认' : '双击图片放大到原始尺寸'}</span>
                  <button
                    type="button"
                    onClick={handleZoomToggle}
                    className="rounded border border-[#1a8cff]/40 bg-[#1a8cff]/10 px-1.5 py-0.5 text-[9px] text-[#1a8cff] hover:bg-[#1a8cff]/20"
                    title="切换缩放状态"
                  >
                    {previewZoomed ? '缩小' : '放大'}
                  </button>
                </div>
              ) : null}

              {previewIssue ? (
                <div className="mx-3 mb-2 rounded-xl border border-[#3d2222] bg-[#1a0f0f] p-3" data-testid="asset-preview-issue">
                  {previewIssue.state === 'missing' || previewIssue.state === 'corrupted' ? (
                    <>
                      <p className="text-[11px] font-medium text-[#ff9b9b]">
                        {previewIssue.state === 'missing' ? '素材文件缺失，无法预览。' : '素材文件已损坏，无法解码。'}
                      </p>
                      <p className="mt-0.5 text-[10px] text-[#c98b8b]">建议删除该素材，避免占用资产库。</p>
                      <button
                        type="button"
                        data-testid="asset-preview-delete-issue"
                        onClick={() => handleDeleteItems([previewItem.id])}
                        className="mt-2 w-full rounded-lg border border-[#ef4444]/40 bg-[#ef4444]/10 px-2 py-1.5 text-[11px] text-[#ff9b9b] hover:bg-[#ef4444]/20"
                      >
                        删除素材
                      </button>
                    </>
                  ) : previewIssue.state === 'ok' && previewIssue.canTranscode ? (
                    <>
                      <p className="text-[11px] font-medium text-[#ffd29a]">格式不被当前浏览器直接支持，但可转码为标准格式预览。</p>
                      <button
                        type="button"
                        data-testid="asset-preview-repair"
                        onClick={handleRepairPreview}
                        disabled={previewValidating}
                        className="mt-2 w-full rounded-lg border border-[#00d4aa]/40 bg-[#00d4aa]/10 px-2 py-1.5 text-[11px] text-[#7cf7d4] hover:bg-[#00d4aa]/20 disabled:opacity-60"
                      >
                        {previewValidating ? '转码中…' : '转码为标准格式'}
                      </button>
                    </>
                  ) : null}
                </div>
              ) : previewValidating ? (
                <div className="mx-3 mb-2 rounded-xl border border-[#30363d] bg-[#11161d] p-3 text-[11px] text-[#8b949e]" data-testid="asset-preview-validating">
                  正在诊断素材…
                </div>
              ) : null}

              {/* 主要操作 */}
              <div className="space-y-2">
                <button
                  type="button"
                  data-testid="asset-preview-add"
                  onClick={() => addAssetToCanvas(previewItem)}
                  className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-[#00d4aa] px-3 py-2.5 text-sm font-semibold text-[#07110e] hover:bg-[#00e5b3]"
                >
                  <Plus className="h-4 w-4" />
                  添加到画布并写入节点
                </button>
                <div className="grid grid-cols-2 gap-2">
                  {previewItem.type === 'image' ? (
                    <button
                      type="button"
                      onClick={() => setShowAIAnalysis(!showAIAnalysis)}
                      className={`flex items-center justify-center gap-1 rounded-xl px-3 py-2 text-xs font-medium transition-colors ${
                        showAIAnalysis
                          ? 'bg-gradient-to-r from-[#00d4aa]/15 to-[#1a8cff]/15 text-[#00d4aa]'
                          : 'bg-[#161b22] text-[#c9d1d9] hover:text-[#00d4aa] hover:bg-[#00d4aa]/5'
                      }`}
                    >
                      <Brain className="h-3.5 w-3.5" />
                      AI 深度分析
                    </button>
                  ) : (
                    <div />
                  )}
                  <button
                    type="button"
                    onClick={() => void autoClassify(previewItem.id)}
                    className="flex items-center justify-center gap-1 rounded-xl border border-[#30363d] px-3 py-2 text-xs text-[#c9d1d9] hover:bg-[#21262d]"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    自动打标签
                  </button>
                  {(previewItem.type === 'image' || previewItem.type === 'video') ? (
                    <button
                      type="button"
                      onClick={() => openSimilarSearch(previewItem)}
                      className="flex items-center justify-center gap-1 rounded-xl border border-[#30363d] px-3 py-2 text-xs text-[#8fd0ff] hover:bg-[#1a8cff]/10"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      相似搜索
                    </button>
                  ) : (
                    <div />
                  )}
                  <button
                    type="button"
                    data-testid="asset-preview-delete"
                    onClick={() => handleDeleteItems([previewItem.id])}
                    className="flex items-center justify-center gap-1 rounded-xl border border-[#3d2222] px-3 py-2 text-xs text-[#ff9b9b] hover:bg-[#3d2222]/30"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    删除素材
                  </button>
                </div>
                {previewItem.type === 'image' && showAIAnalysis && (
                  <div className="mt-2">
                    <AIDeepAnalysisPanel
                      item={previewItem}
                      compact
                      onAnalysisComplete={(analysis) => {
                        setAiAnalysisResult(analysis);
                        applyImageAnalysis(previewItem.id, analysis);
                      }}
                      onGeneratedImage={(imageUrl) => {
                        collectFromUrl(imageUrl, {
                          folderId: importTargetFolderId,
                          type: 'image',
                          source: 'generate',
                          title: `AI生成_${previewItem.name}`,
                          tags: aiAnalysisResult?.keywords || [],
                        }).catch(() => {});
                      }}
                    />
                  </div>
                )}
              </div>

              <div className="space-y-3">
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-[#6e7681]">名称</div>
                  {editingItemName ? (
                    <div className="flex items-center gap-2">
                      <input
                        value={itemRenameValue}
                        onChange={(event) => setItemRenameValue(event.target.value)}
                        onBlur={handlePreviewRename}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') handlePreviewRename();
                          if (event.key === 'Escape') {
                            setEditingItemName(false);
                            setItemRenameValue(previewItem.name);
                          }
                        }}
                        autoFocus
                        className="min-w-0 flex-1 rounded-lg border border-[#00d4aa] bg-[#0d1117] px-2.5 py-1.5 text-sm text-[#e6edf3] outline-none"
                      />
                      <button
                        type="button"
                        onClick={handlePreviewRename}
                        className="rounded-lg bg-[#00d4aa]/10 px-2.5 py-1.5 text-xs text-[#00d4aa] hover:bg-[#00d4aa]/20"
                      >
                        保存
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-start gap-2">
                      <h4 data-testid="asset-preview-name" className="min-w-0 flex-1 break-words text-sm font-medium text-[#f0f6fc]">{previewItem.name}</h4>
                      <button
                        type="button"
                        data-testid="asset-preview-rename"
                        onClick={() => {
                          setEditingItemName(true);
                          setItemRenameValue(previewItem.name);
                        }}
                        className="rounded-lg p-1 text-[#8b949e] hover:bg-[#21262d] hover:text-[#c9d1d9]"
                        title="重命名"
                      >
                        <Edit3 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <InfoItem label="类型" value={getAssetBadge(previewItem)} />
                  <InfoItem label="大小" value={formatBytes(previewItem.size)} />
                  <InfoItem label="尺寸" value={previewItem.width && previewItem.height ? `${previewItem.width} × ${previewItem.height}` : '未记录'} />
                  <InfoItem label="时长" value={previewItem.duration ? formatDuration(previewItem.duration) : '未记录'} />
                  <InfoItem label="来源" value={previewItem.source === 'upload' ? '本地上传' : previewItem.source === 'web' ? '联网搜索' : previewItem.source === 'generate' ? 'AI 生成' : '网页采集'} />
                  <InfoItem
                    label="存储方式"
                    value={String(previewItem.storageLabel || '').trim().toLowerCase() === 'reference' ? '原文件引用' : '落库文件'}
                    testId="asset-preview-storage-mode"
                  />
                  <InfoItem label="文件夹" value={folderLookup.get(previewItem.folderId)?.name || '未分类'} />
                </div>

                {(previewItem.sourceUrl || previewItem.filePath) ? (
                  <div>
                    {(() => {
                      const isReference = String(previewItem.storageLabel || '').trim().toLowerCase() === 'reference';
                      const sourceValue = isReference
                        ? String(previewItem.filePath || previewItem.sourceUrl || '').trim()
                        : String(previewItem.sourceUrl || '').trim();
                      if (!sourceValue) return null;
                      return (
                        <>
                    <div className="mb-1 text-[10px] uppercase tracking-wider text-[#6e7681]">
                          {isReference ? '源文件路径' : '来源链接'}
                    </div>
                    <div className="flex items-center gap-2 rounded-xl border border-[#30363d] bg-[#161b22] px-2.5 py-2">
                          <span data-testid="asset-preview-source-path" className="min-w-0 flex-1 truncate text-[11px] text-[#c9d1d9]">{sourceValue}</span>
                      <button
                        type="button"
                            onClick={() => navigator.clipboard.writeText(sourceValue)}
                        className="rounded-lg p-1 text-[#8b949e] hover:bg-[#21262d] hover:text-[#c9d1d9]"
                            title={isReference ? '复制源文件路径' : '复制来源链接'}
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                    </div>
                        </>
                      );
                    })()}
                  </div>
                ) : null}

                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-[#6e7681]">智能分类</div>
                  <div className="flex flex-wrap gap-1.5">
                    {previewItem.smartCategories.length > 0 ? previewItem.smartCategories.map((category) => (
                      <span key={category} className="rounded-full bg-[#00d4aa]/10 px-2 py-0.5 text-[10px] text-[#00d4aa]">
                        {category}
                      </span>
                    )) : (
                      <span className="text-xs text-[#8b949e]">还没有自动分类</span>
                    )}
                  </div>
                </div>

                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-[#6e7681]">标签</div>
                  <div className="flex flex-wrap gap-1.5">
                    {previewItem.tags.map((tag) => (
                      <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-[#21262d] px-2 py-0.5 text-[10px] text-[#c9d1d9]">
                        {tag}
                        <button
                          type="button"
                          onClick={() => removeTag(previewItem.id, tag)}
                          className="text-[#8b949e] hover:text-[#ef4444]"
                          title="移除标签"
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </span>
                    ))}
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      data-testid="asset-preview-tag-input"
                      value={newTagValue}
                      onChange={(event) => setNewTagValue(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') handleAddTag();
                      }}
                      placeholder="添加标签"
                      className="min-w-0 flex-1 rounded-lg border border-[#30363d] bg-[#161b22] px-2.5 py-1.5 text-xs text-[#e6edf3] outline-none focus:border-[#00d4aa]"
                    />
                    <button
                      type="button"
                      onClick={handleAddTag}
                      className="rounded-lg bg-[#21262d] px-2.5 py-1.5 text-xs text-[#c9d1d9] hover:bg-[#2b3138]"
                    >
                      添加
                    </button>
                  </div>
                </div>

                {previewItem.type === 'image' ? (
                  <div>
                    <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-[#6e7681]">
                      <span>图片解析</span>
                      <div className="flex items-center gap-2">
                        <select
                          data-testid="asset-preview-analysis-engine"
                          value={imageAnalysisEngine}
                          onChange={(event) => setImageAnalysisEngine(event.target.value)}
                          className="rounded-lg border border-[#30363d] bg-[#11161d] px-2 py-1 text-[10px] text-[#c9d1d9] outline-none"
                          title={selectedAnalysisOption?.hint || ''}
                        >
                          {imageAnalysisGroups.map((group) => (
                            <optgroup key={group.key} label={group.label}>
                              {group.options.map((option) => (
                                <option key={option.value} value={option.value}>{option.label}</option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                      <button
                        type="button"
                        data-testid="asset-preview-analyze-image"
                        onClick={() => void handleAnalyzePreviewImage()}
                        disabled={isProcessing && analyzingItemId === previewItem.id}
                        className={`rounded-lg px-2 py-1 text-[10px] transition-colors ${
                          isProcessing && analyzingItemId === previewItem.id
                            ? 'bg-[#2a2a2c] text-[#6e7681]'
                            : 'bg-[#1a8cff]/12 text-[#8fd0ff] hover:bg-[#1a8cff]/18'
                        }`}
                      >
                        {isProcessing && analyzingItemId === previewItem.id ? '解析中...' : '解析图片'}
                      </button>
                      </div>
                    </div>
                    <div data-testid="asset-preview-analysis-engine-hint" className="mb-2 rounded-xl border border-[#30363d] bg-[#11161d] px-3 py-2 text-[11px] leading-5 text-[#8b949e]">
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        {selectedAnalysisOption.badge ? (
                          <SourceBadge label={selectedAnalysisOption.badge} tone={selectedAnalysisOption.tone} />
                        ) : null}
                        {selectedAnalysisOption.runtimeBadge ? (
                          <SourceBadge label={selectedAnalysisOption.runtimeBadge} tone="relay" />
                        ) : null}
                        {!selectedAnalysisOption.runtimeBadge && imageAnalysisEngine === 'custom-api' ? (
                          <SourceBadge label="待激活" tone="neutral" />
                        ) : null}
                      </div>
                      {selectedAnalysisOption?.hint}
                    </div>
                    {imageAnalysisStatus ? (
                      <div
                        data-testid="asset-preview-analysis-status"
                        className={`mb-2 rounded-xl border px-3 py-2 text-[11px] leading-5 ${
                          imageAnalysisStatus.tone === 'success'
                            ? 'border-[#144d3b] bg-[#0f231d] text-[#8ce0bf]'
                            : imageAnalysisStatus.tone === 'warn'
                              ? 'border-[#4b3b17] bg-[#211a0b] text-[#f3d27a]'
                              : 'border-[#1e3a5f] bg-[#0f1a29] text-[#8fd0ff]'
                        }`}
                      >
                        {imageAnalysisStatus.message}
                      </div>
                    ) : null}
                    {previewItem.analysis ? (
                      <div data-testid="asset-preview-analysis" className="space-y-2 rounded-xl border border-[#30363d] bg-[#161b22] p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[10px] text-[#8fd0ff]">{previewItem.analysis.engine}</span>
                          <span className="text-[10px] text-[#6e7681]">
                            {new Date(previewItem.analysis.analyzedAt).toLocaleString('zh-CN', { hour12: false })}
                          </span>
                        </div>
                        {previewItem.analysis.runtime?.provider || previewItem.analysis.runtime?.model || previewItem.analysis.runtime?.resolvedEngine || previewItem.analysis.runtime?.modelLabel ? (
                          <div data-testid="asset-preview-analysis-runtime" className="rounded-lg border border-[#262626] bg-[#11161d] px-2 py-1.5 text-[10px] leading-5 text-[#8b949e] flex items-center gap-1.5 flex-wrap">
                            <span>
                              本次分析模型：{previewItem.analysis.runtime?.modelLabel
                                || `${previewItem.analysis.runtime?.provider ? `${previewItem.analysis.runtime.provider} / ` : ''}${previewItem.analysis.runtime?.model || previewItem.analysis.runtime?.resolvedEngine || '本地链路'}`}
                            </span>
                            {(/免费|Florence|本地/.test(previewItem.analysis.runtime?.modelLabel || '') || previewItem.analysis.runtime?.resolvedEngine === 'florence2') && (
                              <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 text-[9px] font-medium">免费额度</span>
                            )}
                          </div>
                        ) : null}
                        <p className="text-xs leading-5 text-[#dbe4ee]">{previewItem.analysis.summary}</p>
                        <div className="grid grid-cols-2 gap-2 text-[11px] text-[#c9d1d9]">
                          <AnalysisField label="主体" value={previewItem.analysis.subject} />
                          <AnalysisField label="场景" value={previewItem.analysis.scene} />
                          <AnalysisField label="风格" value={previewItem.analysis.style} />
                          <AnalysisField label="光影" value={previewItem.analysis.lighting} />
                          <AnalysisField label="构图" value={previewItem.analysis.composition} />
                          <AnalysisField label="镜头" value={previewItem.analysis.camera} />
                        </div>
                        {previewItem.analysis.keywords.length > 0 ? (
                          <div className="flex flex-wrap gap-1.5">
                            {previewItem.analysis.keywords.map((keyword) => (
                              <span key={keyword} className="rounded-full bg-[#0d1117] px-2 py-0.5 text-[10px] text-[#a7c6ff]">
                                {keyword}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="rounded-xl border border-dashed border-[#30363d] bg-[#11161d] p-3 text-xs leading-5 text-[#8b949e]">
                        解析后会输出主体、场景、风格、光影、构图、镜头与中英提示词。默认先走本地免费链路；若后端已激活云端多模态、CLIP Interrogator、Florence-2 或 Qwen 视觉链，会自动升级到更强的融合反推。
                      </div>
                    )}
                  </div>
                ) : null}



                {/* 本地相似素材面板 */}
                <div className="mt-3">
                  <button
                    type="button"
                    onClick={() => setShowLocalSimilar(!showLocalSimilar)}
                    className={`flex items-center gap-1.5 w-full rounded-xl px-3 py-2 text-xs font-medium transition-colors ${
                      showLocalSimilar
                        ? 'bg-[#1a8cff]/10 text-[#1a8cff]'
                        : 'bg-[#161b22] text-[#8b949e] hover:text-[#1a8cff] hover:bg-[#1a8cff]/5'
                    }`}
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    本地相似素材
                  </button>
                  {showLocalSimilar && (
                    <div className="mt-2">
                      <LocalSimilarPanel
                        targetItem={previewItem}
                        maxResults={8}
                        compact
                        onAddToCanvas={(item) => addAssetToCanvas(item)}
                        onPreviewItem={(item) => selectPreviewItem(item.id)}
                      />
                    </div>
                  )}
                </div>

                {/* 粘贴提示 */}
                <div className="mt-3 flex items-center gap-1.5 text-[10px] text-[#6e7681] px-1">
                  <ClipboardPaste className="w-3 h-3" />
                  <span>Ctrl+V 粘贴图片到当前文件夹</span>
                </div>
              </div>
            </div>
          </div>
          </>
        ) : null}
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,video/*,audio/*,.hdr,.exr,.tif,.tiff,.heic,.heif,.avif,.dng,.jxl"
        data-testid="asset-file-input"
        className="hidden"
        onChange={(event) => void handleFiles(event, 'file')}
      />

      <input
        ref={directoryInputRef}
        type="file"
        multiple
        accept="image/*,video/*,audio/*,.txt,.md,.json,.csv,.hdr,.exr,.tif,.tiff,.heic,.heif,.avif,.dng,.jxl"
        data-testid="asset-directory-input"
        className="hidden"
        onChange={(event) => void handleFiles(event, 'folder')}
      />

      {contextMenu ? (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setContextMenu(null)} />
          <div
            className="fixed z-50 min-w-[176px] rounded-2xl border border-[#30363d] bg-[#161b22] py-1 shadow-xl"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            {contextMenu.kind === 'item' ? (
              <>
                <ContextAction onClick={() => handleContextAction('add')} icon={<Plus className="h-3.5 w-3.5" />} label="加到画布" />
                <ContextAction onClick={() => handleContextAction('similar')} icon={<ExternalLink className="h-3.5 w-3.5" />} label="联网搜相似素材" />
                <ContextAction onClick={() => handleContextAction('autotag')} icon={<Sparkles className="h-3.5 w-3.5" />} label="自动打标签" />
                <div className="my-1 border-t border-[#30363d]" />
                <ContextAction onClick={() => handleContextAction('rename')} icon={<Edit3 className="h-3.5 w-3.5" />} label="重命名" />
                <ContextAction onClick={() => handleContextAction('delete')} icon={<Trash2 className="h-3.5 w-3.5" />} label="删除" destructive />
              </>
            ) : (
              <>
                <ContextAction onClick={() => handleContextAction('rename')} icon={<Edit3 className="h-3.5 w-3.5" />} label="重命名文件夹" />
                {contextMenu.folderId !== 'root' ? (
                  <ContextAction onClick={() => handleContextAction('delete')} icon={<Trash2 className="h-3.5 w-3.5" />} label="删除文件夹" destructive />
                ) : null}
              </>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

import { AnalysisField, ContextAction, FolderTreeItem, InfoItem } from './AssetLibrary.parts';