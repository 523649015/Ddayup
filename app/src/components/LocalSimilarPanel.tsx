/**
 * HMDao 本地相似素材面板
 * 展示与当前选中素材相似的本地素材
 */
import { useState, useEffect, useCallback } from 'react';
import { Image as ImageIcon, Video, Sparkles, Loader2, Plus } from 'lucide-react';
import { findSimilarAssetsInLibrary } from '@/services/assetSimilarityService';
import { useAssetStore } from '@/store/useAssetStore';
import { toRenderableAssetUrl } from '@/services/generation';
import type { AssetItem, LocalSimilarResult } from '@/types/assets';

interface LocalSimilarPanelProps {
  targetItem: AssetItem | null;
  onAddToCanvas?: (item: AssetItem) => void;
  onPreviewItem?: (item: AssetItem) => void;
  maxResults?: number;
  compact?: boolean;
}

export function LocalSimilarPanel({
  targetItem,
  onAddToCanvas,
  onPreviewItem,
  maxResults = 8,
  compact = false,
}: LocalSimilarPanelProps) {
  const [results, setResults] = useState<LocalSimilarResult[]>([]);
  const [loading, setLoading] = useState(false);
  const items = useAssetStore((s) => s.items);

  useEffect(() => {
    if (!targetItem) {
      setResults([]);
      return;
    }

    setLoading(true);
    // 使用 setTimeout 避免阻塞 UI
    const timer = setTimeout(() => {
      try {
        const similar = findSimilarAssetsInLibrary(targetItem, items, maxResults);
        setResults(similar);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 50);

    return () => clearTimeout(timer);
  }, [targetItem, items, maxResults]);

  const handleAddToCanvas = useCallback(
    (item: AssetItem) => {
      onAddToCanvas?.(item);
    },
    [onAddToCanvas],
  );

  if (!targetItem) return null;

  return (
    <div className="space-y-2">
      {/* 标题 */}
      <div className="flex items-center gap-2">
        <Sparkles className="w-3.5 h-3.5 text-[#00d4aa]" />
        <span className="text-[11px] font-medium text-[#e6edf3]">本地相似素材</span>
        {loading && <Loader2 className="w-3 h-3 animate-spin text-[#6e7681]" />}
        {!loading && results.length > 0 && (
          <span className="text-[10px] text-[#6e7681]">{results.length}个结果</span>
        )}
      </div>

      {/* 结果网格 */}
      {loading ? (
        <div className="flex items-center justify-center py-8 text-[#6e7681]">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : results.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-6 text-[#6e7681]">
          <ImageIcon className="w-8 h-8 mb-2 opacity-30" />
          <p className="text-[10px]">未找到相似素材</p>
          <p className="text-[9px] mt-0.5">尝试给素材添加更多标签以提升匹配效果</p>
        </div>
      ) : (
        <div
          className="grid gap-2"
          style={{
            gridTemplateColumns: compact
              ? 'repeat(auto-fill, minmax(70px, 1fr))'
              : 'repeat(auto-fill, minmax(100px, 1fr))',
          }}
        >
          {results.map(({ item, score, matchDetails, matchedBy }) => (
            <div
              key={item.id}
              role="button"
              tabIndex={0}
              onClick={() => onPreviewItem?.(item)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPreviewItem?.(item); } }}
              className="group relative rounded-lg overflow-hidden bg-[#161b22] ring-1 ring-[#21262d] hover:ring-[#00d4aa]/40 transition-all cursor-pointer"
              title={`${item.name}\n内容相似: ${matchDetails.contentSimilarity != null ? Math.round(matchDetails.contentSimilarity * 100) + '%' : '未分析'}\n标签重叠: ${Math.round(matchDetails.tagOverlap * 100)}% | 分类重叠: ${Math.round(matchDetails.categoryOverlap * 100)}% | 文件名相似: ${Math.round(matchDetails.nameSimilarity * 100)}%`}
            >
              {/* 缩略图 */}
              <div className="aspect-square bg-[#0d1117] relative">
                {item.type === 'video' ? (
                  <div className="flex items-center justify-center w-full h-full">
                    <Video className="w-6 h-6 text-[#ff6b35]/60" />
                  </div>
                ) : item.thumbnail ? (
                  <img
                    src={toRenderableAssetUrl(item.thumbnail, 'image')}
                    alt={item.name}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex items-center justify-center w-full h-full">
                    <ImageIcon className="w-6 h-6 text-[#6e7681]/40" />
                  </div>
                )}

                {/* 相似度分数 */}
                <div
                  className={`absolute top-1 right-1 px-1 py-0.5 rounded text-[9px] font-medium flex items-center gap-0.5 ${
                    score >= 70
                      ? 'bg-[#00d4aa]/20 text-[#00d4aa]'
                      : score >= 40
                        ? 'bg-[#f59e0b]/20 text-[#f59e0b]'
                        : 'bg-[#6e7681]/20 text-[#8b949e]'
                  }`}
                >
                  {matchedBy === 'content' || matchedBy === 'mixed' ? '语义 ' : ''}
                  {score}%
                </div>

                {/* 快速添加按钮 */}
                <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/40">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleAddToCanvas(item);
                    }}
                    className="flex items-center gap-1 px-2 py-1 rounded-md bg-[#00d4aa]/85 text-[#07110e] text-[10px] font-medium hover:bg-[#00e5b3]"
                  >
                    <Plus className="w-3 h-3" />
                    加到画布
                  </button>
                </div>
              </div>

              {/* 文件名 */}
              {!compact && (
                <div className="px-2 py-1.5">
                  <p className="text-[10px] text-[#c9d1d9] truncate">{item.name}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
