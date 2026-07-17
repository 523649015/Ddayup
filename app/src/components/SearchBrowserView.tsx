import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  Check,
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  Globe,
  Image,
  Link,
  Plus,
  Search,
  Tag,
  Trash2,
  Video,
  X,
} from 'lucide-react';
import { useAssetStore } from '@/store/useAssetStore';
import { prepareImport } from '@/services/webSearchService';
import type {
  CollectedItem,
  SearchPlatformMeta,
  WebSearchResult,
} from '@/types/assets';
import { buildPlatformSearchUrl, generateCollectedId } from '@/types/assets';

interface SearchBrowserViewProps {
  query: string;
  platform: SearchPlatformMeta;
  allPlatforms: SearchPlatformMeta[];
  onPlatformChange: (platform: SearchPlatformMeta) => void;
  onBack: () => void;
  onClose: () => void;
}

const BLOCKED_EMBED_PLATFORM_IDS = new Set([
  'unsplash',
  'pexels',
  'pixabay',
  'huaban',
  'youtube',
  'pinterest',
  'deviantart',
]);

function canEmbedPlatform(platform: SearchPlatformMeta) {
  if (platform.isCustom) return true;
  return !BLOCKED_EMBED_PLATFORM_IDS.has(platform.id);
}

export function SearchBrowserView({
  query,
  platform,
  allPlatforms,
  onPlatformChange,
  onBack,
  onClose,
}: SearchBrowserViewProps) {
  const { addItem, importTargetFolderId } = useAssetStore();

  const [currentUrl, setCurrentUrl] = useState(() => buildPlatformSearchUrl(platform, query));
  const [urlInput, setUrlInput] = useState(currentUrl);
  const [collectedItems, setCollectedItems] = useState<CollectedItem[]>([]);
  const [pasteUrl, setPasteUrl] = useState('');
  const [pasteTitle, setPasteTitle] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [tagTargetId, setTagTargetId] = useState<string | null>(null);
  const [importedIds, setImportedIds] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    const nextUrl = buildPlatformSearchUrl(platform, query);
    setCurrentUrl(nextUrl);
    setUrlInput(nextUrl);
  }, [platform, query]);

  const supportsEmbed = useMemo(() => canEmbedPlatform(platform), [platform]);

  const handleGo = useCallback(() => {
    const raw = urlInput.trim();
    if (!raw) return;
    const nextUrl = raw.startsWith('http://') || raw.startsWith('https://')
      ? raw
      : `https://${raw}`;
    setCurrentUrl(nextUrl);
    setUrlInput(nextUrl);
  }, [urlInput]);

  const handleOpenExternal = useCallback(() => {
    window.open(currentUrl, '_blank', 'noopener,noreferrer');
  }, [currentUrl]);

  const handleCopyCurrentUrl = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(currentUrl);
      setCopiedId('__current__');
      window.setTimeout(() => setCopiedId(null), 1800);
    } catch {
      // ignore clipboard failures
    }
  }, [currentUrl]);

  const handleCollectUrl = useCallback(() => {
    const url = pasteUrl.trim();
    if (!url) return;
    const title = pasteTitle.trim() || url.split('/').pop()?.split('?')[0] || '网络素材';
    const isVideo = /\.(mp4|webm|mov|mkv|avi)(\?|$)/i.test(url) || /video/i.test(url);

    setCollectedItems((prev) => [
      {
        id: generateCollectedId(),
        url,
        title,
        type: isVideo ? 'video' : 'image',
        sourcePlatform: platform.name,
        tags: [],
        collectedAt: Date.now(),
      },
      ...prev,
    ]);
    setPasteUrl('');
    setPasteTitle('');
  }, [pasteTitle, pasteUrl, platform.name]);

  const handleImportCollected = useCallback(async (item: CollectedItem) => {
    if (importedIds.has(item.id)) return;

    const fakeResult: WebSearchResult = {
      id: item.id,
      url: item.url,
      thumb: item.url,
      previewUrl: item.url,
      title: item.title,
      source: platform.id,
      sourceName: platform.name,
      type: item.type,
      tags: item.tags,
    };

    try {
      const prepared = await prepareImport(fakeResult, item.tags);
      addItem({
        name: prepared.name,
        type: prepared.type,
        url: prepared.url,
        thumbnail: prepared.thumbnail,
        folderId: importTargetFolderId,
        size: 0,
        width: prepared.width,
        height: prepared.height,
        tags: prepared.tags,
        smartCategories: prepared.smartCategories,
        source: 'web',
        sourceUrl: prepared.url,
      });
      setImportedIds((prev) => new Set(prev).add(item.id));
    } catch (error) {
      console.error('Failed to import collected asset.', error);
    }
  }, [addItem, importTargetFolderId, importedIds, platform.id, platform.name]);

  const addTagToCollected = useCallback((itemId: string, tag: string) => {
    const trimmed = tag.trim();
    if (!trimmed) return;
    setCollectedItems((prev) =>
      prev.map((item) =>
        item.id === itemId && !item.tags.includes(trimmed)
          ? { ...item, tags: [...item.tags, trimmed] }
          : item,
      ),
    );
    setTagInput('');
    setTagTargetId(null);
  }, []);

  const removeCollected = useCallback((itemId: string) => {
    setCollectedItems((prev) => prev.filter((item) => item.id !== itemId));
  }, []);

  const copyItemUrl = useCallback(async (url: string, id: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(id);
      window.setTimeout(() => setCopiedId(null), 1800);
    } catch {
      // ignore clipboard failures
    }
  }, []);

  return (
    <div className="flex h-full bg-[#0d1117] overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden border-r border-[#21262d]">
        <div className="flex items-center gap-2 border-b border-[#21262d] px-3 py-2.5">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-[#8b949e] transition-colors hover:bg-[#21262d] hover:text-[#e6edf3]"
            title="返回搜索结果"
          >
            <ArrowLeft className="h-4 w-4" />
            <span>返回</span>
          </button>

          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-[#30363d] bg-[#161b22] px-3 py-2">
            <Globe className="h-3.5 w-3.5 shrink-0 text-[#6e7681]" />
            <input
              value={urlInput}
              onChange={(event) => setUrlInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') handleGo();
              }}
              className="min-w-0 flex-1 bg-transparent text-[11px] text-[#e6edf3] outline-none placeholder:text-[#5a5a5c]"
              placeholder="输入平台搜索地址或素材地址"
            />
            <button
              type="button"
              onClick={handleGo}
              className="rounded-lg px-2 py-1 text-[11px] text-[#8fd0ff] transition-colors hover:bg-[#1a8cff]/10"
            >
              前往
            </button>
          </div>

          <select
            value={platform.name}
            onChange={(event) => {
              const next = allPlatforms.find((item) => item.name === event.target.value) || allPlatforms[0];
              onPlatformChange(next);
            }}
            aria-label="切换搜索平台"
            className="max-w-[128px] rounded-lg border border-[#30363d] bg-[#161b22] px-2 py-2 text-[11px] text-[#c9d1d9] outline-none focus:border-[#00d4aa]"
          >
            {allPlatforms.map((item) => (
              <option key={item.name} value={item.name}>
                {item.name}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[#8b949e] transition-colors hover:bg-[#21262d] hover:text-[#e6edf3]"
            title="关闭搜索面板"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_320px]">
            <div className="space-y-4">
              <div className="rounded-2xl border border-[#21262d] bg-[#11161d] p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="mb-1 flex items-center gap-2">
                      <div
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: platform.color || '#00d4aa' }}
                      />
                      <span className="text-sm font-semibold text-[#e6edf3]">{platform.name}</span>
                    </div>
                    <p className="text-sm text-[#8b949e]">{platform.description}</p>
                  </div>
                  <span className="rounded-full border border-[#2d3742] px-2.5 py-1 text-[10px] text-[#8fd0ff]">
                    {supportsEmbed ? '可应用内浏览' : '建议外部打开'}
                  </span>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <ActionCard
                    icon={<ExternalLink className="h-4 w-4" />}
                    title="外部打开"
                    description="直接在浏览器打开目标平台，避免被站点安全策略拦截。"
                    actionLabel="打开平台"
                    onClick={handleOpenExternal}
                    testId="asset-search-open-external"
                  />
                  <ActionCard
                    icon={copiedId === '__current__' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    title="复制链接"
                    description="把当前搜索链接发给同事，或在独立标签页继续筛素材。"
                    actionLabel={copiedId === '__current__' ? '已复制' : '复制地址'}
                    onClick={handleCopyCurrentUrl}
                    testId="asset-search-copy-current-url"
                  />
                  <ActionCard
                    icon={<FolderOpen className="h-4 w-4" />}
                    title="快速收录"
                    description="把图像或视频链接直接粘贴到右侧，立刻进资产库。"
                    actionLabel="去收录"
                    onClick={() => {
                      const next = currentUrl.trim();
                      if (!next) return;
                      setPasteUrl(next);
                    }}
                    testId="asset-search-collect-current-url"
                  />
                </div>
              </div>

              {!supportsEmbed ? (
                <div
                  data-testid="asset-search-blocked-state"
                  className="rounded-2xl border border-[#4d3a1f] bg-[#241a0e] p-4"
                >
                  <div className="mb-2 flex items-center gap-2 text-[#ffd28f]">
                    <Link className="h-4 w-4" />
                    <span className="text-sm font-medium">当前平台不适合内嵌显示</span>
                  </div>
                  <p className="text-sm leading-6 text-[#d8c6ab]">
                    {platform.name} 这类站点通常会通过 <code className="rounded bg-black/20 px-1 py-0.5">X-Frame-Options</code> 或
                    <code className="ml-1 rounded bg-black/20 px-1 py-0.5">CSP frame-ancestors</code> 拒绝被嵌入应用。
                    这不是你的网络问题，而是平台自身的安全策略。
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={handleOpenExternal}
                      className="rounded-xl bg-[#ffb65b] px-3 py-2 text-xs font-medium text-[#201407] transition-colors hover:bg-[#ffc57d]"
                    >
                      在外部浏览器打开
                    </button>
                    <button
                      type="button"
                      onClick={handleCopyCurrentUrl}
                      className="rounded-xl border border-[#6a5637] px-3 py-2 text-xs text-[#f6d7a9] transition-colors hover:bg-[#3b2b14]"
                    >
                      复制平台链接
                    </button>
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl border border-[#21262d] bg-[#0f1319] p-4">
                  <div className="mb-2 flex items-center gap-2 text-[#8fd0ff]">
                    <Search className="h-4 w-4" />
                    <span className="text-sm font-medium">应用内浏览已启用</span>
                  </div>
                  <p className="text-sm leading-6 text-[#8b949e]">
                    当前平台允许应用内打开。若你后续仍碰到加载异常，优先使用“外部打开”或“快速收录 URL”两条路径。
                  </p>
                  <div className="mt-3 rounded-xl border border-[#26303a] bg-[#11161d] px-3 py-2 text-xs text-[#c9d1d9] break-all">
                    {currentUrl}
                  </div>
                </div>
              )}

              <div className="rounded-2xl border border-[#21262d] bg-[#11161d] p-4">
                <div className="mb-2 flex items-center gap-2">
                  <Search className="h-4 w-4 text-[#00d4aa]" />
                  <h4 className="text-sm font-medium text-[#e6edf3]">联网搜索优化建议</h4>
                </div>
                <ul className="space-y-2 text-sm leading-6 text-[#8b949e]">
                  <li>优先使用搜索结果列表模式挑素材，页面浏览仅作为补充入口。</li>
                  <li>对被平台拦截的站点，直接走“外部打开 + 粘贴真实素材 URL 收录”最稳定。</li>
                  <li>后续如果要进一步升级，可把搜索结果抓取迁到后端代理或采集服务，避开浏览器侧 CORS 与嵌入限制。</li>
                </ul>
              </div>
            </div>

            <div className="flex min-h-[420px] flex-col overflow-hidden rounded-2xl border border-[#21262d] bg-[#0f1319]">
              <div className="flex items-center justify-between border-b border-[#21262d] px-4 py-3">
                <div className="flex items-center gap-2">
                  <FolderOpen className="h-4 w-4 text-[#00d4aa]" />
                  <span className="text-sm font-semibold text-[#e6edf3]">快速收录</span>
                </div>
                <span className="text-[10px] text-[#6e7681]">{collectedItems.length} 项</span>
              </div>

              <div className="space-y-2 border-b border-[#21262d] px-4 py-3">
                <input
                  value={pasteUrl}
                  onChange={(event) => setPasteUrl(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') handleCollectUrl();
                  }}
                  placeholder="粘贴图片、视频或网页素材链接"
                  aria-label="素材链接"
                  className="w-full rounded-xl border border-[#30363d] bg-[#161b22] px-3 py-2 text-xs text-[#e6edf3] outline-none placeholder:text-[#5a5a5c] focus:border-[#00d4aa]"
                />
                <div className="flex items-center gap-2">
                  <input
                    value={pasteTitle}
                    onChange={(event) => setPasteTitle(event.target.value)}
                    placeholder="素材名称（可选）"
                    aria-label="素材名称"
                    className="min-w-0 flex-1 rounded-xl border border-[#30363d] bg-[#161b22] px-3 py-2 text-xs text-[#e6edf3] outline-none placeholder:text-[#5a5a5c] focus:border-[#00d4aa]"
                  />
                  <button
                    type="button"
                    onClick={handleCollectUrl}
                    disabled={!pasteUrl.trim()}
                    className={`flex h-10 shrink-0 items-center gap-1 rounded-xl px-3 text-xs font-medium transition-colors ${
                      pasteUrl.trim()
                        ? 'bg-[#00d4aa] text-[#08110e] hover:bg-[#00e5b3]'
                        : 'bg-[#2a2a2c] text-[#6e7681]'
                    }`}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    收录
                  </button>
                </div>
              </div>

              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
                {collectedItems.length === 0 ? (
                  <div className="flex h-full flex-col items-center justify-center px-6 text-center text-[#6e7681]">
                    <Image className="mb-3 h-9 w-9 opacity-20" />
                    <p className="text-sm">把网页里的素材链接粘贴到上方，就能直接进入资产库。</p>
                    <p className="mt-1 text-[11px] text-[#5a6471]">
                      对外站无法内嵌的情况，这条收录链是最稳定的替代方案。
                    </p>
                  </div>
                ) : (
                  collectedItems.map((item) => (
                    <div key={item.id} className="overflow-hidden rounded-2xl border border-[#21262d] bg-[#161b22]">
                      <div className="relative aspect-video overflow-hidden bg-[#0d1117]">
                        {item.type === 'video' ? (
                          <div className="flex h-full w-full items-center justify-center">
                            <Video className="h-7 w-7 text-[#ff8d4d]" />
                          </div>
                        ) : (
                          <img
                            src={item.url}
                            alt={item.title}
                            className="h-full w-full object-cover"
                            loading="lazy"
                            onError={(event) => {
                              (event.target as HTMLImageElement).style.display = 'none';
                            }}
                          />
                        )}
                        <span className="absolute right-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] text-white">
                          {item.type === 'video' ? '视频' : '图片'}
                        </span>
                      </div>

                      <div className="space-y-2 p-3">
                        <div>
                          <p className="truncate text-xs font-medium text-[#e6edf3]" title={item.title}>
                            {item.title}
                          </p>
                          <p className="text-[10px] text-[#6e7681]">{item.sourcePlatform}</p>
                        </div>

                        {item.tags.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {item.tags.map((tag) => (
                              <span key={tag} className="rounded-full bg-[#00d4aa]/10 px-2 py-0.5 text-[10px] text-[#00d4aa]">
                                {tag}
                              </span>
                            ))}
                          </div>
                        ) : null}

                        {tagTargetId === item.id ? (
                          <div className="flex items-center gap-2">
                            <input
                              value={tagInput}
                              onChange={(event) => setTagInput(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') addTagToCollected(item.id, tagInput);
                                if (event.key === 'Escape') setTagTargetId(null);
                              }}
                              autoFocus
                              placeholder="输入标签"
                              className="min-w-0 flex-1 rounded-lg border border-[#30363d] bg-[#0d1117] px-2 py-1.5 text-[11px] text-[#e6edf3] outline-none focus:border-[#00d4aa]"
                            />
                            <button
                              type="button"
                              onClick={() => addTagToCollected(item.id, tagInput)}
                              className="rounded-lg bg-[#00d4aa]/15 p-2 text-[#00d4aa] transition-colors hover:bg-[#00d4aa]/25"
                            >
                              <Plus className="h-3 w-3" />
                            </button>
                          </div>
                        ) : null}

                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleImportCollected(item)}
                            disabled={importedIds.has(item.id)}
                            className={`flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] transition-colors ${
                              importedIds.has(item.id)
                                ? 'bg-[#00d4aa]/10 text-[#6fcfb9]'
                                : 'bg-[#00d4aa]/15 text-[#00d4aa] hover:bg-[#00d4aa]/25'
                            }`}
                          >
                            <Download className="h-3 w-3" />
                            {importedIds.has(item.id) ? '已收录' : '收录'}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setTagTargetId(tagTargetId === item.id ? null : item.id);
                              setTagInput('');
                            }}
                            className="rounded-lg bg-[#21262d] p-2 text-[#8b949e] transition-colors hover:text-[#c9d1d9]"
                            title="添加标签"
                          >
                            <Tag className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => copyItemUrl(item.url, item.id)}
                            className="rounded-lg bg-[#21262d] p-2 text-[#8b949e] transition-colors hover:text-[#c9d1d9]"
                            title="复制素材链接"
                          >
                            {copiedId === item.id ? <Check className="h-3 w-3 text-[#00d4aa]" /> : <Copy className="h-3 w-3" />}
                          </button>
                          <button
                            type="button"
                            onClick={() => removeCollected(item.id)}
                            className="ml-auto rounded-lg bg-[#21262d] p-2 text-[#8b949e] transition-colors hover:text-[#ff8c8c]"
                            title="移除"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ActionCard({
  icon,
  title,
  description,
  actionLabel,
  onClick,
  testId,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  actionLabel: string;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <div className="rounded-2xl border border-[#21262d] bg-[#0d1117] p-3">
      <div className="mb-2 flex items-center gap-2 text-[#8fd0ff]">
        {icon}
        <span className="text-sm font-medium text-[#e6edf3]">{title}</span>
      </div>
      <p className="min-h-[48px] text-[12px] leading-5 text-[#8b949e]">{description}</p>
      <button
        type="button"
        data-testid={testId}
        onClick={onClick}
        className="mt-3 rounded-xl border border-[#2d3742] px-3 py-2 text-xs text-[#c9d1d9] transition-colors hover:bg-[#161b22]"
      >
        {actionLabel}
      </button>
    </div>
  );
}
