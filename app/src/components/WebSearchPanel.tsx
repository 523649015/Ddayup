import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import {
  Search, X, Download, Plus, Globe, Settings2, Image as ImageIcon,
  CheckSquare, Square, Tag, Loader2, ExternalLink,
  Filter, Clock, SortAsc, Gauge, Shield,
  Play, FolderPlus, AlertCircle, Copy, Check,
  Monitor, Palette,
} from 'lucide-react';
import { freeWebSearch, prepareFreeImport, FREE_PLATFORM_META, DEFAULT_FREE_PLATFORMS, scrapeUrl } from '@/services/freeImageSearchService';
import { useAssetStore } from '@/store/useAssetStore';
import { importRemoteAsset, pickAssetLibraryDirectory, saveAssetLibrarySettings, fetchAssetLibrarySettings } from '@/api/assetLibrary';
import {
  type MatchMode,
  type SortOrder,
  type TimeRange,
  type WebSearchResult,
  type SearchFilters,
  type SearchPlatform,
  type SearchPlatformMeta,
  type SearchMode,
  type MediaType,
  SEARCH_PLATFORMS,
  TIME_RANGE_OPTIONS,
  SORT_OPTIONS,
  MATCH_MODE_OPTIONS,
  DEFAULT_SEARCH_FILTERS,
} from '@/types/assets';
import { SearchBrowserView } from './SearchBrowserView';
import { ImageLightbox } from './ImageLightbox';

/* ===== Types ===== */

interface WebSearchPanelProps {
  isOpen: boolean;
  onClose: () => void;
  /** 打开时预填的检索关键词（如由智能归纳插件注入） */
  initialQuery?: string;
  /** For reverse search: pre-populated item info */
  reverseItem?: { id: string; url: string; name: string; type: string } | null;
  onClearReverseItem?: () => void;
}

interface ImportPreview extends WebSearchResult {
  customTags: string[];
  isImporting: boolean;
}

/* ===== Constants ===== */

const RESULTS_PER_PAGE = 24;

export function WebSearchPanel({
  isOpen,
  onClose,
  initialQuery,
  reverseItem,
  onClearReverseItem,
}: WebSearchPanelProps) {
  const { addItem, importTargetFolderId, storagePath, setStoragePath } = useAssetStore();

  // 由智能归纳插件等外部入口注入的初始关键词
  useEffect(() => {
    if (isOpen && initialQuery) setSearchQuery(initialQuery);
  }, [isOpen, initialQuery]);
  const [isPickingPath, setIsPickingPath] = useState(false);
  const [pathNotice, setPathNotice] = useState<string | null>(null);
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  // ===== All state / refs first =====
  const [searchMode, setSearchMode] = useState<SearchMode>('keyword');
  const [searchQuery, setSearchQuery] = useState('');
  const [results, setResults] = useState<WebSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [mediaType, setMediaType] = useState<MediaType | 'all'>('image');
  const [lightbox, setLightbox] = useState<WebSearchResult | null>(null);
  const [browserMode, setBrowserMode] = useState(false);
  const [browserPlatform, setBrowserPlatform] = useState<SearchPlatformMeta>(SEARCH_PLATFORMS[0]);
  const [customPlatforms, setCustomPlatforms] = useState<SearchPlatformMeta[]>(() => {
    try {
      const raw = localStorage.getItem('ddayup_custom_platforms');
      if (raw) return JSON.parse(raw) as SearchPlatformMeta[];
    } catch (_) { /* ignore */ }
    return [];
  });
  const [showAddPlatform, setShowAddPlatform] = useState(false);
  const [newPlatformName, setNewPlatformName] = useState('');
  const [newPlatformUrl, setNewPlatformUrl] = useState('');
  const [newPlatformType, setNewPlatformType] = useState<MediaType>('image');
  const [newPlatformDesc, setNewPlatformDesc] = useState('');
  const [newPlatformColor, setNewPlatformColor] = useState('#00d4aa');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [importQueue, setImportQueue] = useState<Map<string, ImportPreview>>(new Map());
  const [importedIds, setImportedIds] = useState<Set<string>>(new Set());
  const [isImporting, setIsImporting] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [filters, setFilters] = useState<SearchFilters>(DEFAULT_SEARCH_FILTERS);
  const [tagInputId, setTagInputId] = useState<string | null>(null);
  const [tagInputValue, setTagInputValue] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [playingVideo, setPlayingVideo] = useState<string | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const resultsContainerRef = useRef<HTMLDivElement>(null);
  const videoRefs = useRef<Record<string, HTMLVideoElement | null>>({});

  const allPlatforms: SearchPlatformMeta[] = [...SEARCH_PLATFORMS, ...customPlatforms];
  // 反向搜图可选择的真实平台（走后端代理，免 Key 的 Openverse/Wikimedia 开箱即用）。
  const reversePlatforms = DEFAULT_FREE_PLATFORMS
    .map((id) => FREE_PLATFORM_META[id])
    .filter(Boolean);
  const reverseSearchQuery = reverseItem?.name.replace(/\.[^.]+$/, '') ?? '';
  const isReverseItemActive = Boolean(reverseItem);
  const activeSearchMode: SearchMode = isReverseItemActive ? 'reverse-image' : searchMode;
  const displaySearchQuery = isReverseItemActive && activeSearchMode === 'reverse-image'
    ? reverseSearchQuery
    : searchQuery;

  const mediaTypeTabs = useMemo(() => {
    const tabs: Array<{ id: MediaType | 'all'; label: string; icon: any }> = [
      { id: 'image', label: '图片', icon: ImageIcon },
      { id: 'video', label: '视频', icon: Play },
      { id: 'audio', label: '音效', icon: Copy },
      { id: 'model', label: '模型', icon: Monitor },
    ];
    if (searchMode === 'scrape') tabs.unshift({ id: 'all', label: '全部', icon: Globe });
    return tabs;
  }, [searchMode]);

  // ===== Callbacks =====
  const persistCustomPlatforms = useCallback((list: SearchPlatformMeta[]) => {
    try { localStorage.setItem('ddayup_custom_platforms', JSON.stringify(list)); } catch (_) { /* ignore */ }
  }, []);

  const addCustomPlatform = useCallback(() => {
    if (!newPlatformName.trim() || !newPlatformUrl.trim()) return;
    const id = `custom_${Date.now()}` as SearchPlatform;
    const newPlatform: SearchPlatformMeta = {
      id,
      name: newPlatformName.trim(),
      supports: [newPlatformType],
      description: newPlatformDesc.trim() || '自定义收藏网站',
      searchUrl: newPlatformUrl.trim(),
      isCustom: true,
      color: newPlatformColor,
    };
    setCustomPlatforms((prev) => {
      const next = [...prev, newPlatform];
      persistCustomPlatforms(next);
      return next;
    });
    setNewPlatformName('');
    setNewPlatformUrl('');
    setNewPlatformDesc('');
    setNewPlatformType('image');
    setShowAddPlatform(false);
  }, [newPlatformName, newPlatformUrl, newPlatformDesc, newPlatformType, newPlatformColor, persistCustomPlatforms]);

  const removeCustomPlatform = useCallback((id: SearchPlatform) => {
    setCustomPlatforms((prev) => {
      const next = prev.filter((p) => p.id !== id);
      persistCustomPlatforms(next);
      return next;
    });
    setFilters((prev) => ({
      ...prev,
      platforms: prev.platforms.filter((p) => p !== id),
    }));
  }, [persistCustomPlatforms]);

  // Toggle platform filter
  const togglePlatform = useCallback((platform: SearchPlatform) => {
    setFilters((prev) => {
      const current = prev.platforms.includes(platform)
        ? prev.platforms.filter((p) => p !== platform)
        : [...prev.platforms, platform];
      return { ...prev, platforms: current };
    });
  }, []);

  // 关键词搜索：走后端真实代理；尊重用户在高级设置中勾选的平台（不盲目全搜）。
  const handleSearch = useCallback(async () => {
    const keywordQuery = searchQuery.trim();
    if (!keywordQuery && activeSearchMode === 'keyword') return;

    setIsSearching(true);
    setSearchError(null);
    setResults([]);
    setSelectedIds(new Set());

    try {
      const effectiveType = mediaType === 'all' ? 'image' : mediaType;
      // 音效/模型使用专属平台（无需用户在高级设置里勾选图片平台）
      const mediaDefaultPlatforms: string[] =
        effectiveType === 'audio' ? ['wikimedia', 'openverse', 'freesound']
        : effectiveType === 'model' ? ['polyhaven', 'sketchfab']
        : DEFAULT_FREE_PLATFORMS;
      const chosenFree = (filters.platforms as string[]).filter((p) => DEFAULT_FREE_PLATFORMS.includes(p));
      const freePlatforms =
        effectiveType === 'audio' || effectiveType === 'model'
          ? mediaDefaultPlatforms
          : chosenFree.length > 0 ? chosenFree : undefined;
      const response = await freeWebSearch({
        query: keywordQuery || 'trending',
        mode: activeSearchMode,
        filters,
        page: 1,
        perPage: RESULTS_PER_PAGE,
        mediaType: effectiveType,
        // 仅当用户显式勾选了「免费图搜平台」时才限定，否则走默认全部平台
        freePlatforms,
      });
      setResults(response.results);
      if (response.results.length === 0) {
        const hint = response.notice ? `（${response.notice}）` : '';
        setSearchError(`未找到匹配结果${hint}，请尝试更换关键词或调整筛选条件`);
      }
    } catch (e) {
      setSearchError('搜索失败，请检查网络连接后重试');
      console.error('Search error:', e);
    }
    setIsSearching(false);
  }, [searchQuery, activeSearchMode, filters, mediaType]);

  // 网页直采：抓取任意公开网址上的图片/视频/音效/模型（免 Key，不限网站）。
  const handleScrape = useCallback(async () => {
    const target = (searchQuery || '').trim();
    if (!target) return;
    setIsSearching(true);
    setSearchError(null);
    setResults([]);
    setSelectedIds(new Set());

    try {
      const scrapeType = (mediaType === 'all' ? 'all' : mediaType) as 'image' | 'video' | 'audio' | 'model' | 'all';
      const response = await scrapeUrl(target, scrapeType);
      if (response.error) {
        setSearchError(`抓取失败：${response.error}`);
        setResults([]);
      } else {
        setResults(response.results);
        if (response.results.length === 0) {
          setSearchError('该网址未解析到匹配的素材，可能是页面由 JS 动态加载（需登录或前端渲染），可改用关键词搜索');
        }
      }
    } catch {
      setSearchError('抓取失败，请检查网址或网络连接');
    }
    setIsSearching(false);
  }, [searchQuery, mediaType]);

  // 反向搜图：以参考图的名称/视觉关键词，在用户所选平台上做相似检索（走后端真实代理）。
  // 不再使用 mock 假数据；必须至少选择一个平台后才允许搜索。
  const handleSearchWithItem = useCallback(async (item: { id: string; url: string; name: string; type: string }) => {
    setIsSearching(true);
    setSearchError(null);
    setResults([]);
    setSelectedIds(new Set());

    const nameParts = item.name.replace(/\.[^.]+$/, '').split(/[-_\s]+/).filter(Boolean);
    const query = nameParts.join(' ') || 'similar';
    const chosenFree = (filters.platforms as string[]).filter((p) => DEFAULT_FREE_PLATFORMS.includes(p));
    const freePlatforms = chosenFree.length > 0 ? chosenFree : DEFAULT_FREE_PLATFORMS;

    try {
      const response = await freeWebSearch({
        query,
        mode: 'reverse-image',
        filters,
        page: 1,
        perPage: RESULTS_PER_PAGE,
        freePlatforms,
      });
      setResults(response.results);
      if (response.results.length === 0) {
        setSearchError('未找到相似素材，请尝试更换平台或调整关键词');
      }
    } catch (e) {
      setSearchError('相似搜索失败');
      console.error('Reverse search error:', e);
    }
    setIsSearching(false);
  }, [filters]);

  // 提交搜索：反向搜图需先选平台（无平台时不盲目搜）。
  const handleSubmitSearch = useCallback(() => {
    if (searchMode === 'scrape') {
      void handleScrape();
      return;
    }
    if (reverseItem && activeSearchMode === 'reverse-image') {
      if (filters.platforms.length === 0) {
        setSearchError('请先选择要搜索相似的平台（参考图 → 选平台 → 搜索）。');
        return;
      }
      void handleSearchWithItem(reverseItem);
      return;
    }

    void handleSearch();
  }, [searchMode, reverseItem, activeSearchMode, filters, handleSearchWithItem, handleSearch, handleScrape]);

  // 反向搜图：仅在用户已选平台时自动发起；否则展示平台选择步骤，不盲目搜索。
  useEffect(() => {
    if (!reverseItem) return;
    if (filters.platforms.length === 0) return;

    const timeoutId = window.setTimeout(() => {
      void handleSearchWithItem(reverseItem);
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [reverseItem, filters.platforms.length, handleSearchWithItem]);

  // Toggle result selection
  const toggleSelection = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(results.map((r) => r.id)));
  }, [results]);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  // 载入当前资产库下载路径（采集落盘目标）
  useEffect(() => {
    if (!isOpen) return;
    let canceled = false;
    fetchAssetLibrarySettings()
      .then((s) => { if (!canceled && s.storagePath) setStoragePath(s.storagePath); })
      .catch(() => {});
    return () => { canceled = true; };
  }, [isOpen, setStoragePath]);

  // 采集前自定义本地下载路径
  const handlePickDownloadPath = useCallback(async () => {
    setIsPickingPath(true);
    setPathNotice(null);
    try {
      const picked = await pickAssetLibraryDirectory(storagePath || '', '');
      if (picked.canceled || !picked.path) {
        setIsPickingPath(false);
        return;
      }
      const saved = await saveAssetLibrarySettings(picked.path);
      setStoragePath(saved.storagePath);
      setPathNotice('已更新采集下载路径');
    } catch (err) {
      setPathNotice(err instanceof Error ? err.message : '选择下载路径失败');
    } finally {
      setIsPickingPath(false);
      setTimeout(() => setPathNotice(null), 2500);
    }
  }, [storagePath, setStoragePath]);

  // Add custom tag to result
  const addCustomTag = useCallback((resultId: string, tag: string) => {
    const trimmed = tag.trim();
    if (!trimmed) return;
    setImportQueue((prev) => {
      const next = new Map(prev);
      const existing = next.get(resultId) || {
        ...results.find((r) => r.id === resultId)!,
        customTags: [],
        isImporting: false,
      };
      if (!existing.customTags.includes(trimmed)) {
        next.set(resultId, {
          ...existing,
          customTags: [...existing.customTags, trimmed],
        });
      }
      return next;
    });
    setTagInputValue('');
    setTagInputId(null);
  }, [results]);

  const removeCustomTag = useCallback((resultId: string, tag: string) => {
    setImportQueue((prev) => {
      const next = new Map(prev);
      const existing = next.get(resultId);
      if (existing) {
        next.set(resultId, {
          ...existing,
          customTags: existing.customTags.filter((t) => t !== tag),
        });
      }
      return next;
    });
  }, []);

  // Import selected/all to asset library (downloads to configured storage path)
  const handleImportSelected = useCallback(async () => {
    const toImport = selectedIds.size > 0
      ? results.filter((r) => selectedIds.has(r.id) && !importedIds.has(r.id))
      : results.filter((r) => !importedIds.has(r.id));

    if (toImport.length === 0) return;

    setIsImporting(true);
    setImportProgress({ done: 0, total: toImport.length });
    setImportError(null);

    for (const result of toImport) {
      const queueEntry = importQueue.get(result.id);
      const customTags = queueEntry?.customTags || [];

      try {
        const prepared = await prepareFreeImport(result, customTags);
        if (!prepared.url) throw new Error('素材缺少有效下载链接');
        const imported = await importRemoteAsset(prepared.url, {
          name: prepared.name,
          type: prepared.type,
          folderId: importTargetFolderId,
          tags: prepared.tags,
          smartCategories: prepared.smartCategories,
          width: prepared.width,
          height: prepared.height,
        });
        addItem({
          name: imported.item.name || prepared.name,
          type: prepared.type,
          url: prepared.url,
          thumbnail: prepared.thumbnail,
          folderId: importTargetFolderId,
          size: Number(imported.item.size || 0),
          width: prepared.width,
          height: prepared.height,
          tags: prepared.tags,
          smartCategories: prepared.smartCategories,
          source: 'web',
          sourceUrl: prepared.url,
        });
        setImportedIds((prev) => new Set(prev).add(result.id));
      } catch (err) {
        const msg = err instanceof Error ? err.message : '导入失败';
        console.error(`Failed to import: ${result.title}`, msg);
        setImportError(`「${result.title}」下载失败：${msg}`);
      } finally {
        setImportProgress((prev) => prev ? { ...prev, done: prev.done + 1 } : prev);
      }
    }

    setIsImporting(false);
    setImportProgress(null);
    setSelectedIds(new Set());
  }, [results, selectedIds, importedIds, importQueue, addItem, importTargetFolderId]);

  // Copy URL
  const copyUrl = useCallback(async (url: string, id: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch { /* clipboard not available */ }
  }, []);

  // Quick import single item
  const quickImport = useCallback(async (result: WebSearchResult) => {
    if (importedIds.has(result.id)) return;

    const queueEntry = importQueue.get(result.id);
    const customTags = queueEntry?.customTags || [];

    try {
      const prepared = await prepareFreeImport(result, customTags);
      if (!prepared.url) throw new Error('素材缺少有效下载链接');
      const imported = await importRemoteAsset(prepared.url, {
        name: prepared.name,
        type: prepared.type,
        folderId: importTargetFolderId,
        tags: prepared.tags,
        smartCategories: prepared.smartCategories,
        width: prepared.width,
        height: prepared.height,
      });
      addItem({
        name: imported.item.name || prepared.name,
        type: prepared.type,
        url: prepared.url,
        thumbnail: prepared.thumbnail,
        folderId: importTargetFolderId,
        size: Number(imported.item.size || 0),
        width: prepared.width,
        height: prepared.height,
        tags: prepared.tags,
        smartCategories: prepared.smartCategories,
        source: 'web',
        sourceUrl: prepared.url,
      });
      setImportedIds((prev) => new Set(prev).add(result.id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : '导入失败';
      console.error('Quick import failed', msg);
      setImportError(`「${result.title}」下载失败：${msg}`);
    }
  }, [importedIds, importQueue, addItem, importTargetFolderId]);

  // Drag to import
  const handleDragStart = useCallback((e: React.DragEvent, result: WebSearchResult) => {
    e.dataTransfer.setData('application/json', JSON.stringify({
      type: 'web-search-result',
      result,
    }));
    e.dataTransfer.effectAllowed = 'copy';
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.ctrlKey && e.key === 'a' && document.activeElement !== searchInputRef.current) {
        e.preventDefault();
        selectAll();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose, selectAll]);

  if (!isOpen) return null;

  return (
    <div data-testid="web-search-panel" className="flex flex-col h-full bg-[#0d1117] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#21262d] shrink-0">
        <div className="flex items-center gap-2">
          <Globe className="w-4 h-4 text-[#00d4aa]" />
          <h3 className="text-[#e6edf3] text-sm font-semibold">联网搜索</h3>
          {reverseItem && (
            <span data-testid="web-search-panel-reverse-badge" className="text-[#6e7681] text-[10px] bg-[#161b22] rounded-full px-2 py-0.5">
              以图搜图
            </span>
          )}        </div>
        <button
          onClick={onClose}
          className="w-7 h-7 rounded-lg hover:bg-[#21262d] flex items-center justify-center text-[#8b949e] hover:text-[#e6edf3] transition-colors"
          title="关闭搜索面板"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Search Bar */}
      <div className="px-4 py-3 border-b border-[#21262d] shrink-0 space-y-2.5">
        {/* Mode selector */}
        <div className="flex items-center gap-1.5">
          <div className="flex items-center gap-0.5 bg-[#161b22] rounded-lg p-0.5 flex-1">
            <button
              onClick={() => { setSearchMode('keyword'); onClearReverseItem?.(); }}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium transition-colors ${
                activeSearchMode === 'keyword'
                  ? 'bg-[#2a2a2c] text-[#00d4aa]'
                  : 'text-[#8b949e] hover:text-[#c9d1d9]'
              }`}
            >
              <Search className="w-3 h-3" />
              关键词搜索
            </button>
            <button
              onClick={() => setSearchMode('reverse-image')}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium transition-colors ${
                activeSearchMode === 'reverse-image'
                  ? 'bg-[#2a2a2c] text-[#00d4aa]'
                  : 'text-[#8b949e] hover:text-[#c9d1d9]'
              }`}
            >
              <ImageIcon className="w-3 h-3" />
              以图搜图
            </button>
            <button
              onClick={() => { setSearchMode('scrape'); setResults([]); setSearchError(null); }}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium transition-colors ${
                searchMode === 'scrape'
                  ? 'bg-[#2a2a2c] text-[#00d4aa]'
                  : 'text-[#8b949e] hover:text-[#c9d1d9]'
              }`}
            >
              <Globe className="w-3 h-3" />
              网页直采
            </button>
          </div>
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
              showAdvanced
                ? 'bg-[#00d4aa]/15 text-[#00d4aa]'
                : 'text-[#8b949e] hover:bg-[#21262d] hover:text-[#c9d1d9]'
            }`}
            title="高级筛选"
          >
            <Settings2 className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Search input */}
        <div className="flex items-center gap-2">
          <div className="flex-1 flex items-center gap-2 bg-[#161b22] rounded-lg border border-[#30363d] focus-within:border-[#00d4aa] transition-colors px-3">
            <Search className="w-3.5 h-3.5 text-[#6e7681] shrink-0" />
            <input
              ref={searchInputRef}
              value={displaySearchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSubmitSearch()}
              placeholder={
                searchMode === 'scrape'
                  ? '粘贴任意网页网址，如 https://example.com/gallery'
                  : activeSearchMode === 'reverse-image'
                  ? '输入图片URL或选择资产库中的素材进行反向搜索...'
                  : '输入关键词搜索图片素材，如"极简风格海报"...'
              }
              aria-label="搜索关键词"
              readOnly={isReverseItemActive && activeSearchMode === 'reverse-image'}
              className="flex-1 bg-transparent text-[#e6edf3] text-xs outline-none placeholder:text-[#5a5a5c] py-2 min-w-0"
            />
            {displaySearchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="text-[#6e7681] hover:text-[#c9d1d9] shrink-0"
              >
                <X className="w-3 h-3" />
              </button>
            )}          </div>
          <button
            onClick={handleSubmitSearch}
            disabled={
              isSearching ||
              (searchMode === 'scrape'
                ? !searchQuery.trim()
                : (activeSearchMode === 'keyword' && !displaySearchQuery.trim()) ||
                  (activeSearchMode === 'reverse-image' && filters.platforms.length === 0))
            }
            className={`px-4 py-2 rounded-lg text-xs font-medium transition-colors shrink-0 ${
              isSearching || (searchMode === 'scrape' ? !searchQuery.trim() : (!displaySearchQuery.trim() && activeSearchMode === 'keyword'))
                ? 'bg-[#2a2a2c] text-[#6e7681]'
                : 'bg-[#00d4aa] text-[#0d1117] hover:bg-[#00e5b3]'
            }`}
          >
            {isSearching ? (
              <span className="flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" /> {searchMode === 'scrape' ? '抓取中' : '搜索中'}
              </span>
            ) : (
              searchMode === 'scrape' ? '抓取' : '搜索'
            )}          </button>
          {/* ===== 素材源分组（始终可见，支持自定义收藏）===== */}
          {!browserMode && (
            <div className="w-full flex flex-col gap-2 px-3 py-2 border-t border-[#21262d]">
              {([
                { key: 'video', label: '🎬 专业视频源', types: ['video'] as MediaType[] },
                { key: 'image', label: '📸 专业图片源', types: ['image'] as MediaType[] },
                { key: 'audio', label: '🎵 音效 / 音乐源', types: ['audio'] as MediaType[] },
                { key: 'model', label: '🧊 3D 模型源', types: ['model'] as MediaType[] },
              ] as const).map((grp) => {
                const items = allPlatforms.filter((p) => (p.supports || []).some((s) => grp.types.includes(s)));
                if (items.length === 0) return null;
                return (
                  <div key={grp.key} className="flex items-start gap-2">
                    <span className="text-[10px] text-[#6e7681] w-24 shrink-0 pt-1 select-none">{grp.label}</span>
                    <div className="flex flex-wrap gap-1.5 flex-1">
                      {items.map((p) => (
                        <button
                          key={p.id}
                          onClick={() => { setBrowserPlatform(p); setBrowserMode(true); }}
                          className="group relative flex items-center gap-1 px-2 py-1 rounded-md text-[11px] bg-[#161b22] text-[#8b949e] hover:text-[#c9d1d9] hover:bg-[#21262d] border border-[#30363d] transition-colors"
                          title={`在 ${p.name} 页面搜索`}
                        >
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.color || '#00d4aa' }} />
                          {p.name}
                          {p.isCustom && (
                            <span
                              onClick={(e) => { e.stopPropagation(); removeCustomPlatform(p.id); }}
                              className="ml-0.5 text-[#6e7681] hover:text-[#f85149] cursor-pointer"
                              title="移除收藏"
                            >
                              <X className="w-2.5 h-2.5" />
                            </span>
                          )}
                        </button>
                      ))}
                      {(grp.key === 'video' || grp.key === 'image' || grp.key === 'audio' || grp.key === 'model') && (
                        <button
                          onClick={() => { setNewPlatformType(grp.key as MediaType); setShowAddPlatform(true); }}
                          className="flex items-center gap-0.5 px-2 py-1 rounded-md text-[11px] bg-transparent text-[#6e7681] hover:text-[#00d4aa] border border-dashed border-[#30363d] hover:border-[#00d4aa] transition-colors"
                          title={`收藏自定义${grp.label.slice(2)}网站`}
                        >
                          <Plus className="w-2.5 h-2.5" />收藏
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {/* Browser mode */}
          {searchQuery.trim() && searchMode !== 'scrape' && (
            <button
              onClick={() => {
                if (!browserMode) {
                  const active = allPlatforms.find((p) => filters.platforms.includes(p.id));
                  setBrowserPlatform(active || allPlatforms[0]);
                }
                setBrowserMode(!browserMode);
              }}
              className={`px-3 py-2 rounded-lg text-xs font-medium transition-colors shrink-0 flex items-center gap-1 ${
                browserMode
                  ? 'bg-[#1a8cff]/15 text-[#1a8cff] ring-1 ring-[#1a8cff]/30'
                  : 'bg-[#161b22] text-[#8b949e] hover:text-[#1a8cff] hover:bg-[#1a8cff]/10'
              }`}
              title={browserMode ? '返回搜索结果' : '在搜索页面中浏览'}
            >
              <Monitor className="w-3 h-3" />
              {browserMode ? '退出浏览' : '页面浏览'}
            </button>
          )}        </div>

        {/* Reverse item indicator + 平台选择步骤（先选平台再搜） */}
        {reverseItem && activeSearchMode === 'reverse-image' && (
          <div
            data-testid="web-search-panel-reverse-indicator"
            className="flex flex-col gap-2 px-3 py-2 bg-[#1a8cff]/10 rounded-lg border border-[#1a8cff]/20"
          >
            <div className="flex items-center gap-2">
              <ImageIcon className="w-3.5 h-3.5 text-[#1a8cff] shrink-0" />
              <span data-testid="web-search-panel-reverse-name" className="text-[#c9d1d9] text-[11px] truncate flex-1">
                参考图：「{reverseItem.name}」→ 选择平台搜索相似
              </span>
              <button
                onClick={() => { onClearReverseItem?.(); setSearchMode('keyword'); setSearchQuery(''); }}
                className="text-[#6e7681] hover:text-[#c9d1d9] shrink-0"
                title="清除反向搜索"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {reversePlatforms.map((platform) => {
                const isActive = filters.platforms.includes(platform.id as SearchPlatform);
                return (
                  <button
                    key={platform.id}
                    type="button"
                    onClick={() => togglePlatform(platform.id as SearchPlatform)}
                    data-testid={`web-search-reverse-platform-${platform.id}`}
                    className={`flex items-center gap-1 px-2 py-1 rounded-md text-[10px] transition-all ${
                      isActive
                        ? 'bg-[#1a8cff]/20 text-[#8fd0ff] ring-1 ring-[#1a8cff]/40'
                        : 'bg-[#0d1117] text-[#6e7681] ring-1 ring-[#21262d] hover:text-[#c9d1d9] hover:ring-[#30363d]'
                    }`}
                    title={platform.description}
                  >
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: platform.color || '#8b949e' }}
                    />
                    {platform.name}
                    {!platform.requiresKey ? <span className="text-[#3fb950]">·免Key</span> : null}
                  </button>
                );
              })}
            </div>
            {filters.platforms.length === 0 ? (
              <p className="text-[10px] text-[#8b949e]">请至少选择一个平台，再点击「搜索」以在该平台查找相似素材。</p>
            ) : (
              <p className="text-[10px] text-[#8b949e]">已选 {filters.platforms.length} 个平台，点击「搜索」开始查找相似并采集进资产库。</p>
            )}
          </div>
        )}
        {/* Advanced Filters */}
        {showAdvanced && (
          <div className="bg-[#161b22] rounded-xl border border-[#21262d] p-3 space-y-3 animate-fade-in">
            {/* Platform filter */}
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <Globe className="w-3 h-3 text-[#6e7681]" />
                <span className="text-[#8b949e] text-[10px] font-medium uppercase tracking-wider">
                  搜索平台
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {allPlatforms.map((platform) => {
                  const isActive = filters.platforms.includes(platform.id as SearchPlatform);
                  return (
                    <button
                      key={platform.id}
                      onClick={() => togglePlatform(platform.id as SearchPlatform)}
                      className={`flex items-center gap-1 px-2 py-1 rounded-md text-[10px] transition-all ${
                        isActive
                          ? 'bg-[#00d4aa]/15 text-[#00d4aa] ring-1 ring-[#00d4aa]/30'
                          : 'bg-[#0d1117] text-[#6e7681] ring-1 ring-[#21262d] hover:text-[#c9d1d9] hover:ring-[#30363d]'
                      }`}
                      title={platform.description}
                      style={platform.color ? { borderColor: isActive ? platform.color + '40' : undefined } : undefined}
                    >
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: platform.color || '#8b949e' }}
                      />
                      {isActive && <Check className="w-2.5 h-2.5" />}
                      {platform.name}
                      {platform.isCustom && (
                        <button
                          onClick={(e) => { e.stopPropagation(); removeCustomPlatform(platform.id); }}
                          className="ml-0.5 text-[#6e7681] hover:text-[#ef4444]"
                          title="删除此平台"
                        >
                          <X className="w-2.5 h-2.5" />
                        </button>
                      )}                    </button>
                  );
                })}
                {/* Add custom platform */}
                <button
                  onClick={() => setShowAddPlatform(true)}
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] bg-[#0d1117] text-[#6e7681] ring-1 ring-[#21262d] hover:text-[#00d4aa] hover:ring-[#00d4aa]/30 transition-all"
                  title="添加自定义搜索平台"
                >
                  <Plus className="w-2.5 h-2.5" /> 添加平台
                </button>
              </div>
            </div>

            {/* Add platform dialog */}
            {showAddPlatform && (
              <div className="bg-[#0d1117] rounded-lg p-3 space-y-2 ring-1 ring-[#00d4aa]/30">
                <p className="text-[#e6edf3] text-[10px] font-medium">添加自定义搜索平台</p>
                <input
                  value={newPlatformName}
                  onChange={(e) => setNewPlatformName(e.target.value)}
                  placeholder="平台名称（如 站酷）"
                  className="w-full bg-[#161b22] text-[#e6edf3] text-[10px] rounded px-2 py-1.5 border border-[#30363d] focus:border-[#00d4aa] outline-none"
                />
                <input
                  value={newPlatformUrl}
                  onChange={(e) => setNewPlatformUrl(e.target.value)}
                  placeholder="搜索URL模板（如 https://www.zcool.com.cn/search?word={query}）"
                  className="w-full bg-[#161b22] text-[#e6edf3] text-[10px] rounded px-2 py-1.5 border border-[#30363d] focus:border-[#00d4aa] outline-none"
                />
                <input
                  value={newPlatformDesc}
                  onChange={(e) => setNewPlatformDesc(e.target.value)}
                  placeholder="平台描述（可选）"
                  className="w-full bg-[#161b22] text-[#e6edf3] text-[10px] rounded px-2 py-1.5 border border-[#30363d] focus:border-[#00d4aa] outline-none"
                />
                <div className="flex items-center gap-1.5">
                  <Tag className="w-3 h-3 text-[#6e7681] shrink-0" />
                  <select
                    value={newPlatformType}
                    onChange={(e) => setNewPlatformType(e.target.value as MediaType)}
                    aria-label="素材类型"
                    className="flex-1 bg-[#161b22] text-[#c9d1d9] text-[10px] rounded px-2 py-1.5 border border-[#30363d] focus:border-[#00d4aa] outline-none"
                  >
                    <option value="video">🎬 视频源</option>
                    <option value="image">📸 图片源</option>
                    <option value="audio">🎵 音效源</option>
                    <option value="model">🧊 模型源</option>
                  </select>
                </div>
                <div className="flex items-center gap-1.5">
                  <Palette className="w-3 h-3 text-[#6e7681] shrink-0" />
                  <input
                    type="color"
                    value={newPlatformColor}
                    onChange={(e) => setNewPlatformColor(e.target.value)}
                    className="w-5 h-5 rounded cursor-pointer border-0 bg-transparent"
                  />
                  <span className="text-[#6e7681] text-[9px]">标识色</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={addCustomPlatform}
                    disabled={!newPlatformName.trim() || !newPlatformUrl.trim()}
                    className={`px-3 py-1 rounded text-[10px] ${
                      newPlatformName.trim() && newPlatformUrl.trim()
                        ? 'bg-[#00d4aa] text-[#0d1117]'
                        : 'bg-[#2a2a2c] text-[#6e7681]'
                    }`}
                  >
                    确认添加
                  </button>
                  <button
                    onClick={() => setShowAddPlatform(false)}
                    className="px-3 py-1 rounded text-[10px] bg-[#21262d] text-[#8b949e] hover:text-[#c9d1d9]"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
            <div className="grid grid-cols-3 gap-2">
              {/* Time range */}
              <div>
                <div className="flex items-center gap-1 mb-1.5">
                  <Clock className="w-2.5 h-2.5 text-[#6e7681]" />
                  <span className="text-[#6e7681] text-[10px]">时间范围</span>
                </div>
                <select
                  value={filters.timeRange}
                  onChange={(e) => setFilters({ ...filters, timeRange: e.target.value as TimeRange })}
                  aria-label="时间范围"
                  className="w-full bg-[#0d1117] text-[#c9d1d9] text-[10px] rounded-md border border-[#21262d] px-2 py-1.5 focus:border-[#00d4aa] outline-none"
                >
                  {TIME_RANGE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>

              {/* Sort order */}
              <div>
                <div className="flex items-center gap-1 mb-1.5">
                  <SortAsc className="w-2.5 h-2.5 text-[#6e7681]" />
                  <span className="text-[#6e7681] text-[10px]">排序方式</span>
                </div>
                <select
                  value={filters.sortOrder}
                  onChange={(e) => setFilters({ ...filters, sortOrder: e.target.value as SortOrder })}
                  aria-label="排序方式"
                  className="w-full bg-[#0d1117] text-[#c9d1d9] text-[10px] rounded-md border border-[#21262d] px-2 py-1.5 focus:border-[#00d4aa] outline-none"
                >
                  {SORT_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>

              {/* Match mode */}
              <div>
                <div className="flex items-center gap-1 mb-1.5">
                  <Gauge className="w-2.5 h-2.5 text-[#6e7681]" />
                  <span className="text-[#6e7681] text-[10px]">匹配模式</span>
                </div>
                <select
                  value={filters.matchMode}
                  onChange={(e) => setFilters({ ...filters, matchMode: e.target.value as MatchMode })}
                  aria-label="匹配模式"
                  className="w-full bg-[#0d1117] text-[#c9d1d9] text-[10px] rounded-md border border-[#21262d] px-2 py-1.5 focus:border-[#00d4aa] outline-none"
                >
                  {MATCH_MODE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Safe search toggle */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Shield className="w-3 h-3 text-[#6e7681]" />
                <span className="text-[#8b949e] text-[10px]">安全搜索</span>
              </div>
              <button
                onClick={() => setFilters({ ...filters, safeSearch: !filters.safeSearch })}
                className={`w-8 h-4.5 rounded-full transition-colors relative ${
                  filters.safeSearch ? 'bg-[#00d4aa]' : 'bg-[#3a3a3c]'
                }`}
              >
                <div
                  className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-transform ${
                    filters.safeSearch ? 'left-[14px]' : 'left-[2px]'
                  }`}
                />
              </button>
            </div>

            {/* Reset filters */}
            <button
              onClick={() => setFilters(DEFAULT_SEARCH_FILTERS)}
              className="text-[#6e7681] hover:text-[#c9d1d9] text-[10px] flex items-center gap-1 transition-colors"
            >
              <Filter className="w-2.5 h-2.5" /> 重置筛选
            </button>
          </div>
        )}      </div>

      {/* Search Error */}
      {searchError && (
        <div className="mx-4 mt-3 p-3 bg-[#ef4444]/10 border border-[#ef4444]/20 rounded-lg flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-[#ef4444] shrink-0 mt-0.5" />
          <p className="text-[#c9d1d9] text-xs">{searchError}</p>
        </div>
      )}
      {/* Import progress / error (download to configured local path) */}
      {importProgress && (
        <div className="mx-4 mt-3 p-2.5 bg-[#00d4aa]/10 border border-[#00d4aa]/20 rounded-lg flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 text-[#00d4aa] shrink-0 animate-spin" />
          <p className="text-[#7ee787] text-xs">
            正在下载到本地资产库：{importProgress.done}/{importProgress.total}
          </p>
        </div>
      )}
      {importError && (
        <div className="mx-4 mt-3 p-2.5 bg-[#ef4444]/10 border border-[#ef4444]/20 rounded-lg flex items-start gap-2">
          <AlertCircle className="w-3.5 h-3.5 text-[#ef4444] shrink-0 mt-0.5" />
          <p className="text-[#ffb4b4] text-xs">{importError}</p>
        </div>
      )}
      {/* 采集下载路径（自定义本地下载路径） */}
      <div className="px-4 py-2 border-b border-[#21262d] shrink-0 flex items-center gap-2 bg-[#0a0e14]">
        <FolderPlus className="w-3.5 h-3.5 text-[#00d4aa] shrink-0" />
        <span className="text-[10px] text-[#8b949e] shrink-0">采集下载至</span>
        <span
          className="text-[10px] text-[#c9d1d9] truncate flex-1"
          title={storagePath || '未设置（使用默认路径）'}
        >
          {storagePath || '未设置（使用默认路径）'}
        </span>
        <button
          type="button"
          onClick={handlePickDownloadPath}
          disabled={isPickingPath}
          className="text-[10px] px-2 py-1 rounded-md bg-[#161b22] text-[#00d4aa] hover:bg-[#1f2630] transition-colors shrink-0 disabled:opacity-50"
        >
          {isPickingPath ? '选择中…' : '更改路径'}
        </button>
      </div>
      {pathNotice && (
        <div className="px-4 py-1.5 text-[10px] text-[#00d4aa] bg-[#00d4aa]/5 border-b border-[#00d4aa]/10">
          {pathNotice}
        </div>
      )}
      {/* 素材类型 Tab：图片 / 视频 / 音效 / 模型 */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-[#21262d] shrink-0 overflow-x-auto">
        {mediaTypeTabs.map((tab) => {
          const Icon = tab.icon;
          const active = mediaType === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => {
                setMediaType(tab.id);
                setResults([]);
                setSearchError(null);
                setSelectedIds(new Set());
              }}
              className={`flex items-center gap-1 px-3 py-1.5 rounded-md text-[11px] font-medium whitespace-nowrap transition-colors ${
                active
                  ? 'bg-[#00d4aa] text-black'
                  : 'text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d]'
              }`}
            >
              <Icon size={13} />
              {tab.label}
            </button>
          );
        })}
      </div>
      {/* Results Toolbar */}
      {results.length > 0 && (
        <div className="flex items-center justify-between px-4 py-2 border-b border-[#21262d] shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-[#8b949e] text-[10px]">
              找到 <span className="text-[#e6edf3]">{results.length}</span> 个结果
            </span>
            <button
              onClick={selectedIds.size === results.length ? clearSelection : selectAll}
              className="text-[#6e7681] hover:text-[#c9d1d9] text-[10px] transition-colors"
            >
              {selectedIds.size === results.length ? '取消全选' : '全选'}
            </button>
          </div>
          <div className="flex items-center gap-2">
            {selectedIds.size > 0 && (
              <span className="text-[#00d4aa] text-[10px]">已选 {selectedIds.size}</span>
            )}            <button
              onClick={handleImportSelected}
              disabled={
                isImporting ||
                (selectedIds.size === 0 ? results.every((r) => importedIds.has(r.id)) : false)
              }
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-medium transition-colors ${
                isImporting
                  ? 'bg-[#2a2a2c] text-[#6e7681]'
                  : 'bg-[#00d4aa] text-[#0d1117] hover:bg-[#00e5b3]'
              }`}
            >
              {isImporting ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin" /> 导入中
                </>
              ) : (
                <>
                  <Download className="w-3 h-3" />
                  {selectedIds.size > 0 ? `导入选中 (${selectedIds.size})` : '导入全部'}
                </>
              )}            </button>
          </div>
        </div>
      )}
      {/* ===== Browser View Mode ===== */}
      {browserMode && searchQuery.trim() && (
        <div className="flex-1 min-h-0 overflow-hidden">
          <SearchBrowserView
            query={searchQuery}
            platform={browserPlatform}
            allPlatforms={allPlatforms}
            onPlatformChange={setBrowserPlatform}
            onBack={() => setBrowserMode(false)}
            onClose={onClose}
          />
        </div>
      )}
      {/* Results Grid (hidden in browser mode) */}
      {!browserMode && (
      <div ref={resultsContainerRef} className="flex-1 overflow-y-auto p-3 min-h-0">
        {/* Loading */}
        {isSearching && (
          <div className="flex flex-col items-center justify-center h-full text-[#6e7681] py-12">
            <Loader2 className="w-8 h-8 animate-spin mb-3 text-[#00d4aa]" />
            <p className="text-sm">正在搜索全网素材...</p>
            <p className="text-[10px] mt-1">检索中，请稍候</p>
          </div>
        )}
        {/* Empty State */}
        {!isSearching && results.length === 0 && !searchError && (
          <div className="flex flex-col items-center justify-center h-full text-[#6e7681] py-12">
            <Globe className="w-12 h-12 mb-4 opacity-20" />
            <p className="text-sm font-medium text-[#8b949e]">输入关键词开始搜索</p>
            <p className="text-[10px] mt-1.5 max-w-[260px] text-center">
              支持多平台搜索，可在高级设置中指定平台、时间范围和排序方式
            </p>
            <div className="flex flex-wrap gap-1.5 mt-4 max-w-[320px] justify-center">
              {['极简海报', '产品摄影', '自然风景', '科技插画', '美食拍摄'].map((kw) => (
                <button
                  key={kw}
                  onClick={() => { setSearchQuery(kw); handleSearch(); }}
                  className="px-2.5 py-1 rounded-full bg-[#161b22] text-[#8b949e] text-[10px] border border-[#21262d] hover:border-[#00d4aa]/40 hover:text-[#00d4aa] transition-all"
                >
                  {kw}
                </button>
              ))}
            </div>
          </div>
        )}
        {/* Results */}
        {results.length > 0 && (
          <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
            {results.map((result) => (
              <div
                key={result.id}
                draggable
                onDragStart={(e) => handleDragStart(e, result)}
                className={`group relative rounded-xl overflow-hidden cursor-pointer transition-all ${
                  selectedIds.has(result.id)
                    ? 'ring-2 ring-[#00d4aa]'
                    : 'ring-1 ring-[#30363d] hover:ring-[#484f58]'
                } ${importedIds.has(result.id) ? 'opacity-70' : ''}`}
                onClick={() => toggleSelection(result.id)}
              >
                {/* Thumbnail */}
                <div className="aspect-[4/3] bg-[#161b22] relative overflow-hidden">
                  {result.type === 'video' ? (
                    <>
                      <video
                        ref={(el) => { videoRefs.current[result.id] = el; }}
                        src={result.url}
                        className="w-full h-full object-cover"
                        preload="metadata"
                        onClick={(e) => {
                          e.stopPropagation();
                          const vid = videoRefs.current[result.id];
                          if (vid) {
                            if (vid.paused) {
                              void vid.play();
                              setPlayingVideo(result.id);
                            } else {
                              vid.pause();
                              setPlayingVideo(null);
                            }
                          }
                        }}
                      />
                      <div className="absolute inset-0 flex items-center justify-center pointer-events-none bg-black/10">
                        {playingVideo !== result.id && (
                          <div className="w-9 h-9 rounded-full bg-black/50 flex items-center justify-center">
                            <Play className="w-4 h-4 text-white" />
                          </div>
                        )}                      </div>
                    </>
                  ) : result.type === 'audio' ? (
                    <div className="w-full h-full flex items-center justify-center p-2" onClick={(e) => e.stopPropagation()}>
                      {result.thumb ? (
                        <img src={result.thumb} alt={result.title} className="absolute inset-0 w-full h-full object-cover opacity-20" />
                      ) : null}
                      <audio controls src={result.url} className="relative z-10 w-full max-h-10">
                        <track kind="captions" />
                      </audio>
                    </div>
                  ) : result.type === 'model' ? (
                    <img
                      src={result.thumb || result.url}
                      alt={result.title}
                      className="w-full h-full object-cover cursor-zoom-in"
                      loading="lazy"
                      onClick={(e) => { e.stopPropagation(); setLightbox(result); }}
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).src =
                          'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90"><rect width="120" height="90" fill="%2321262d"/><text x="60" y="50" font-size="13" fill="%238b949e" text-anchor="middle">3D 模型</text></svg>';
                      }}
                    />
                  ) : (
                    <img
                      src={result.url || result.thumb || result.previewUrl}
                      alt={result.title}
                      className="w-full h-full object-cover cursor-zoom-in"
                      loading="lazy"
                      onClick={(e) => { e.stopPropagation(); setLightbox(result); }}
                      onError={(e) => {
                        const t = e.currentTarget as HTMLImageElement;
                        if (t.src !== result.thumb && result.thumb) t.src = result.thumb;
                        else if (t.src !== result.previewUrl && result.previewUrl) t.src = result.previewUrl;
                      }}
                    />
                  )}
                  {/* Selection indicator */}
                  <div className="absolute top-2 left-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    {selectedIds.has(result.id) ? (
                      <div className="w-5 h-5 rounded-full bg-[#00d4aa] flex items-center justify-center shadow-lg">
                        <CheckSquare className="w-3 h-3 text-[#0d1117]" />
                      </div>
                    ) : (
                      <div className="w-5 h-5 rounded-full bg-black/50 flex items-center justify-center">
                        <Square className="w-3 h-3 text-white/70" />
                      </div>
                    )}                  </div>

                  {/* Source badge */}
                  <div className="absolute top-2 right-2">
                    <span className="px-1.5 py-0.5 rounded bg-black/60 text-white text-[8px] font-medium">
                      {result.sourceName}
                    </span>
                  </div>

                  {/* Imported badge */}
                  {importedIds.has(result.id) && (
                    <div className="absolute inset-0 flex items-center justify-center bg-[#0d1117]/60">
                      <div className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#00d4aa]/20 text-[#00d4aa] text-[10px]">
                        <Check className="w-3 h-3" /> 已收录
                      </div>
                    </div>
                  )}
                  {/* Resolution */}
                  {result.width && (
                    <div className="absolute bottom-1.5 right-1.5 px-1 py-0.5 rounded bg-black/60 text-white text-[8px]">
                      {result.width}×{result.height}
                    </div>
                  )}
                </div>

                {/* Info */}
                <div className="px-2.5 py-2 bg-[#161b22] space-y-1">
                  <p className="text-[#c9d1d9] text-[11px] leading-tight line-clamp-2" title={result.title}>
                    {result.title}
                  </p>

                  {/* Tags */}
                  {result.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {result.tags.slice(0, 3).map((tag) => (
                        <span key={tag} className="px-1.5 py-0.5 rounded bg-[#0d1117] text-[#6e7681] text-[8px]">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                  {/* Custom tags */}
                  {importQueue.get(result.id)?.customTags.map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-[#00d4aa]/15 text-[#00d4aa] text-[8px]"
                    >
                      {tag}
                      <button
                        onClick={(e) => { e.stopPropagation(); removeCustomTag(result.id, tag); }}
                        className="hover:text-[#ef4444]"
                      >
                        <X className="w-2 h-2" />
                      </button>
                    </span>
                  ))}

                  {/* Action buttons */}
                  <div className="flex items-center gap-1 pt-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => { e.stopPropagation(); quickImport(result); }}
                      disabled={importedIds.has(result.id)}
                      className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-[#00d4aa]/10 text-[#00d4aa] text-[9px] hover:bg-[#00d4aa]/20 disabled:opacity-40"
                      title="快速收录"
                    >
                      <FolderPlus className="w-2.5 h-2.5" /> 收录
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); copyUrl(result.downloadUrl || result.url, result.id); }}
                      className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-[#21262d] text-[#8b949e] text-[9px] hover:text-[#c9d1d9]"
                      title="复制链接"
                    >
                      {copiedId === result.id ? <Check className="w-2.5 h-2.5" /> : <Copy className="w-2.5 h-2.5" />}
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setTagInputId(tagInputId === result.id ? null : result.id); setTagInputValue(''); }}
                      className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-[#21262d] text-[#8b949e] text-[9px] hover:text-[#c9d1d9]"
                      title="添加标签"
                    >
                      <Tag className="w-2.5 h-2.5" /> 标签
                    </button>
                    <a
                      href={result.downloadUrl || result.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-[#21262d] text-[#8b949e] text-[9px] hover:text-[#c9d1d9]"
                      title="查看/下载原素材"
                    >
                      <ExternalLink className="w-2.5 h-2.5" />
                    </a>
                  </div>

                  {/* Tag input inline */}
                  {tagInputId === result.id && (
                    <div
                      className="flex items-center gap-1 mt-1"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        value={tagInputValue}
                        onChange={(e) => setTagInputValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') addCustomTag(result.id, tagInputValue);
                          if (e.key === 'Escape') setTagInputId(null);
                        }}
                        placeholder="输入标签..."
                        autoFocus
                        className="flex-1 bg-[#0d1117] text-[#e6edf3] text-[10px] rounded px-2 py-1 border border-[#30363d] focus:border-[#00d4aa] outline-none min-w-0"
                      />
                      <button
                        onClick={() => addCustomTag(result.id, tagInputValue)}
                        className="w-5 h-5 rounded bg-[#00d4aa]/15 text-[#00d4aa] flex items-center justify-center hover:bg-[#00d4aa]/25"
                      >
                        <Plus className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        </div>
      )}

      {results.length > 0 && (
        <div className="px-4 py-2 border-t border-[#21262d] shrink-0 flex items-center justify-between">
          <span className="text-[#6e7681] text-[10px]">
            点击选择素材，拖拽或点击"收录"导入资产库
          </span>
          <div className="flex items-center gap-2 text-[#6e7681] text-[10px]">
            <Globe className="w-3 h-3" />
            {filters.platforms.length} 个平台
          </div>
        </div>
      )}

      {/* 图片放大预览 */}
      {lightbox && (
        <ImageLightbox
          url={lightbox.url || lightbox.thumb || ''}
          title={lightbox.title}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}




