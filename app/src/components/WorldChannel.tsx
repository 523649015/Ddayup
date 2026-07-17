import { useState, useEffect } from 'react';
import { useDonationStore } from '@/store/useDonationStore';
import { Globe, TrendingUp, Heart, X, ChevronRight, Crown, Sparkles, CircleDollarSign } from 'lucide-react';
import { toRenderableAssetUrl } from '@/services/generation';

export function WorldChannel() {
  const { suggestions, showWorldChannel, toggleWorldChannel, toggleLike, currentUserId, toggleDonationPanel } = useDonationStore();
  const [isExpanded, setIsExpanded] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);

  const top3 = [...suggestions].sort((a, b) => b.likes - a.likes).slice(0, 3);
  const hotItems = [...suggestions].sort((a, b) => b.likes - a.likes);

  // Auto-rotate ticker
  useEffect(() => {
    if (top3.length === 0) return;
    const interval = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % top3.length);
    }, 4000);
    return () => clearInterval(interval);
  }, [top3.length]);

  if (!showWorldChannel) return null;

  return (
    <>
      {/* Floating Ticker Bar */}
      <div className="fixed left-1/2 -translate-x-1/2 top-14 z-40 w-[600px]">
        <div
          className="bg-[#161b22]/90 backdrop-blur-xl border border-[#30363d] rounded-xl shadow-2xl overflow-hidden cursor-pointer hover:border-[#00d4aa]/30 transition-all"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          {/* Header Strip */}
          <div className="flex items-center gap-3 px-4 py-2">
            <div className="w-6 h-6 rounded-lg bg-[#00d4aa]/15 flex items-center justify-center shrink-0">
              <Globe className="w-3.5 h-3.5 text-[#00d4aa]" />
            </div>
            <span className="text-[#e6edf3] text-xs font-semibold shrink-0">世界频道</span>
            <span className="text-[#6e7681] text-[10px]">|</span>
            <div className="flex-1 overflow-hidden relative h-5">
              {top3.length > 0 && (
                <div className="flex items-center gap-2 animate-fade-in">
                  <Crown className="w-3 h-3 text-[#fbbf24] shrink-0" />
                  <span className="text-[#fbbf24] text-[10px] font-medium shrink-0">TOP {currentIndex + 1}</span>
                  <span className="text-[#c9d1d9] text-xs truncate">{top3[currentIndex]?.title}</span>
                  <span className="text-[#8b949e] text-[10px] shrink-0 ml-auto flex items-center gap-0.5">
                    <Heart className="w-2.5 h-2.5" /> {top3[currentIndex]?.likes}
                  </span>
                  <span className="text-[#00d4aa] text-[10px] shrink-0 flex items-center gap-0.5">
                    <CircleDollarSign className="w-2.5 h-2.5" /> ¥{top3[currentIndex]?.donation}
                  </span>
                </div>
              )}
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); toggleWorldChannel(); }}
              className="w-5 h-5 rounded hover:bg-[#21262d] flex items-center justify-center text-[#8b949e] shrink-0"
            >
              <X className="w-3 h-3" />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setIsExpanded(!isExpanded); }}
              className={`text-[#8b949e] transition-transform shrink-0 ${isExpanded ? 'rotate-90' : ''}`}
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          {/* Expanded Content */}
          {isExpanded && (
            <div className="border-t border-[#21262d] px-4 py-3 max-h-[400px] overflow-y-auto">
              {/* Ranking Table */}
              <div className="flex items-center justify-between mb-2">
                <span className="text-[#e6edf3] text-xs font-semibold flex items-center gap-1.5">
                  <TrendingUp className="w-3.5 h-3.5 text-[#fbbf24]" />
                  需求排行榜
                </span>
                <span className="text-[#6e7681] text-[10px]">{suggestions.length} 个需求</span>
              </div>

              <div className="space-y-1.5">
                {hotItems.map((s, index) => {
                  const rankColors = ['text-[#00d4aa]', 'text-[#fbbf24]', 'text-[#a855f7]'];
                  const rankBg = ['bg-[#00d4aa]/10', 'bg-[#fbbf24]/10', 'bg-[#a855f7]/10'];
                  const isLiked = s.likedBy.has(currentUserId);

                  return (
                    <div
                      key={s.id}
                      className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-[#0d1117] transition-colors group"
                    >
                      {/* Rank */}
                      <div className={
                        `w-5 h-5 rounded-md flex items-center justify-center text-[10px] font-bold shrink-0 ${
                          index < 3 ? `${rankBg[index]} ${rankColors[index]}` : 'bg-[#161b22] text-[#6e7681]'
                        }`
                      }>
                        {index + 1}
                      </div>

                      {/* Avatar & Title */}
                      <img src={toRenderableAssetUrl(s.avatar, 'image')} alt="" className="w-6 h-6 rounded-full bg-[#21262d] shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-[#c9d1d9] text-xs truncate">{s.title}</div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          {s.tags.slice(0, 2).map((t) => (
                            <span key={t} className="text-[#6e7681] text-[9px] px-1 py-0.5 rounded bg-[#161b22]">{t}</span>
                          ))}
                        </div>
                      </div>

                      {/* Stats */}
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-[#00d4aa] text-[10px] font-medium flex items-center gap-0.5">
                          <CircleDollarSign className="w-2.5 h-2.5" />
                          ¥{s.donation}
                        </span>
                        <button
                          onClick={(e) => { e.stopPropagation(); toggleLike(s.id); }}
                          className={`flex items-center gap-0.5 text-[10px] transition-colors ${
                            isLiked ? 'text-[#00d4aa]' : 'text-[#8b949e] hover:text-[#00d4aa]'
                          }`}
                        >
                          <Heart className={`w-3 h-3 ${isLiked ? 'fill-current' : ''}`} />
                          {s.likes}
                        </button>
                        <div className={`w-1.5 h-1.5 rounded-full ${
                          s.status === 'completed' ? 'bg-[#22c55e]' : s.status === 'in-progress' ? 'bg-[#fbbf24]' : 'bg-[#6e7681]'
                        }`} title={s.status} />
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Tip */}
              <div className="mt-3 pt-2 border-t border-[#21262d] flex items-center justify-between">
                <span className="text-[#6e7681] text-[10px] flex items-center gap-1">
                  <Sparkles className="w-3 h-3 text-[#00d4aa]" />
                  打赏 ¥10 起即可提交需求建议，获得社区投票优先开发
                </span>
                <button
                  onClick={() => { toggleDonationPanel(); }}
                  className="px-2.5 py-1 rounded-lg bg-[#00d4aa] text-[#0d1117] text-[10px] font-medium hover:bg-[#00e5b3] transition-colors"
                >
                  去打赏
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
