import { useState } from 'react';
import { useDonationStore } from '@/store/useDonationStore';
import { Heart, Flame, TrendingUp, Clock, Filter, X, Send, ChevronUp, MessageCircle, CircleDollarSign } from 'lucide-react';
import { toRenderableAssetUrl } from '@/services/generation';

const TAGS = ['功能请求', 'Bug修复', 'UI优化', '性能', '协作', 'Agent', '3D', '视频', 'ComfyUI', '插件'];

export function DonationPanel() {
  const {
    suggestions, toggleLike, addComment, sortBy, setSortBy, filterTag, setFilterTag,
    toggleDonationPanel, addSuggestion, currentUserId, showDonationPanel,
  } = useDonationStore();

  const [showSubmit, setShowSubmit] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [donation, setDonation] = useState(50);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [commentInputs, setCommentInputs] = useState<Record<string, string>>({});

  if (!showDonationPanel) return null;

  const sorted = [...suggestions].filter((s) => !filterTag || s.tags.includes(filterTag)).sort((a, b) => {
    if (sortBy === 'likes') return b.likes - a.likes;
    if (sortBy === 'highest-donation') return b.donation - a.donation;
    return b.createdAt - a.createdAt;
  });

  const totalDonations = suggestions.reduce((sum, s) => sum + s.donation, 0);
  const totalSupporters = new Set(suggestions.map((s) => s.author)).size;

  const handleSubmit = () => {
    if (!title.trim() || !description.trim()) return;
    const address = '0x' + Math.random().toString(16).substring(2, 8) + '...' + Math.random().toString(16).substring(2, 6);
    addSuggestion(title, description, address, donation, selectedTags);
    setTitle('');
    setDescription('');
    setDonation(50);
    setSelectedTags([]);
    setShowSubmit(false);
  };

  return (
    <div className="absolute right-4 top-14 z-40 w-[460px] h-[calc(100vh-80px)] bg-[#161b22]/95 backdrop-blur-xl border border-[#30363d] rounded-2xl shadow-2xl flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#21262d] shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl bg-[#00d4aa]/15 flex items-center justify-center">
            <CircleDollarSign className="w-4.5 h-4.5 text-[#00d4aa]" />
          </div>
          <div>
            <h3 className="text-[#e6edf3] text-sm font-semibold">需求共建</h3>
            <p className="text-[#6e7681] text-[10px]">
              {totalSupporters} 支持者 · ¥{totalDonations} 总捐赠
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setShowSubmit(!showSubmit)}
            className="h-7 px-2.5 rounded-lg bg-[#00d4aa] text-[#0d1117] text-xs font-medium hover:bg-[#00e5b3] transition-colors flex items-center gap-1"
          >
            <Heart className="w-3 h-3" />
            打赏建议
          </button>
          <button onClick={toggleDonationPanel} className="w-7 h-7 rounded-lg hover:bg-[#21262d] flex items-center justify-center text-[#8b949e]">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Submit Form */}
      {showSubmit && (
        <div className="px-4 py-3 border-b border-[#21262d] bg-[#0d1117]/50 shrink-0 space-y-3">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="需求标题（简洁描述）"
            className="w-full bg-[#0d1117] text-[#e6edf3] text-sm rounded-lg px-3 py-2 border border-[#30363d] focus:border-[#00d4aa] outline-none"
          />
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="详细描述你的需求建议..."
            rows={3}
            className="w-full bg-[#0d1117] text-[#e6edf3] text-sm rounded-lg px-3 py-2 border border-[#30363d] focus:border-[#00d4aa] outline-none resize-none"
          />
          {/* Tags */}
          <div className="flex flex-wrap gap-1">
            {TAGS.map((tag) => (
              <button
                key={tag}
                onClick={() => {
                  setSelectedTags((prev) =>
                    prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
                  );
                }}
                className={
                  `px-2 py-0.5 rounded-full text-[10px] transition-colors ` +
                  (selectedTags.includes(tag)
                    ? 'bg-[#00d4aa]/20 text-[#00d4aa] ring-1 ring-[#00d4aa]/30'
                    : 'bg-[#21262d] text-[#8b949e] hover:bg-[#30363d]')
                }
              >
                {tag}
              </button>
            ))}
          </div>
          {/* Donation Amount */}
          <div className="flex items-center gap-2">
            <span className="text-[#8b949e] text-xs">打赏金额 (CNY):</span>
            {[10, 50, 100, 200, 500].map((amt) => (
              <button
                key={amt}
                onClick={() => setDonation(amt)}
                className={
                  `px-2 py-1 rounded-lg text-xs transition-colors ` +
                  (donation === amt
                    ? 'bg-[#00d4aa] text-[#0d1117] font-medium'
                    : 'bg-[#21262d] text-[#8b949e] hover:bg-[#30363d]')
                }
              >
                ¥{amt}
              </button>
            ))}
            <input
              type="number"
              value={donation}
              onChange={(e) => setDonation(Number(e.target.value))}
              className="w-16 bg-[#0d1117] text-[#e6edf3] text-xs rounded-lg px-2 py-1 border border-[#30363d] outline-none"
            />
          </div>
          <button
            onClick={handleSubmit}
            disabled={!title.trim() || !description.trim()}
            className="w-full h-8 rounded-lg bg-[#00d4aa] text-[#0d1117] text-sm font-medium hover:bg-[#00e5b3] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            提交需求建议
          </button>
        </div>
      )}

      {/* Filter & Sort */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[#21262d] shrink-0">
        <div className="flex items-center gap-1">
          {[
            { key: 'likes' as const, icon: TrendingUp, label: '最热' },
            { key: 'highest-donation' as const, icon: Flame, label: '最高打赏' },
            { key: 'newest' as const, icon: Clock, label: '最新' },
          ].map((item) => (
            <button
              key={item.key}
              onClick={() => setSortBy(item.key)}
              className={
                `flex items-center gap-1 px-2 py-1 rounded-lg text-xs transition-colors ` +
                (sortBy === item.key ? 'bg-[#00d4aa]/10 text-[#00d4aa]' : 'text-[#8b949e] hover:bg-[#21262d]')
              }
            >
              <item.icon className="w-3 h-3" />
              {item.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <Filter className="w-3 h-3 text-[#8b949e]" />
          <select
            value={filterTag || ''}
            onChange={(e) => setFilterTag(e.target.value || null)}
            className="bg-[#0d1117] text-[#8b949e] text-xs rounded border border-[#30363d] px-1.5 py-0.5 outline-none"
          >
            <option value="">全部</option>
            {TAGS.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Suggestion List */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {sorted.map((s, index) => (
          <div
            key={s.id}
            className="rounded-xl bg-[#0d1117] border border-[#21262d] overflow-hidden hover:border-[#30363d] transition-colors"
          >
            {/* Rank Badge */}
            {index < 3 && (
              <div className="flex items-center gap-1 px-3 py-1 border-b border-[#21262d]">
                <ChevronUp className={`w-3.5 h-3.5 ${index === 0 ? 'text-[#00d4aa]' : index === 1 ? 'text-[#fbbf24]' : 'text-[#a855f7]'}`} />
                <span className={`text-[10px] font-bold ${index === 0 ? 'text-[#00d4aa]' : index === 1 ? 'text-[#fbbf24]' : 'text-[#a855f7]'}`}>
                  TOP {index + 1}
                </span>
                <span className="text-[#6e7681] text-[10px] ml-auto">
                  {s.status === 'completed' ? '已完成' : s.status === 'in-progress' ? '开发中' : '待处理'}
                </span>
              </div>
            )}
            <div className="px-3 py-2.5">
              {/* Author */}
              <div className="flex items-center gap-2 mb-2">
                <img src={toRenderableAssetUrl(s.avatar, 'image')} alt="" className="w-5 h-5 rounded-full bg-[#21262d]" />
                <span className="text-[#8b949e] text-[10px]">{s.author}</span>
                <span className="text-[#6e7681] text-[10px] ml-auto">¥{s.donation}</span>
              </div>
              {/* Title & Desc */}
              <h4 className="text-[#e6edf3] text-xs font-semibold mb-1">{s.title}</h4>
              <p className="text-[#8b949e] text-[11px] leading-relaxed line-clamp-2">{s.description}</p>
              {/* Tags */}
              <div className="flex flex-wrap gap-1 mt-1.5">
                {s.tags.map((t) => (
                  <span key={t} className="px-1.5 py-0.5 rounded bg-[#21262d] text-[#6e7681] text-[9px]">{t}</span>
                ))}
              </div>
              {/* Actions */}
              <div className="flex items-center gap-3 mt-2 pt-2 border-t border-[#21262d]">
                <button
                  onClick={() => toggleLike(s.id)}
                  className={`flex items-center gap-1 text-xs transition-colors ${
                    s.likedBy.has(currentUserId) ? 'text-[#00d4aa]' : 'text-[#8b949e] hover:text-[#00d4aa]'
                  }`}
                >
                  <Heart className={`w-3.5 h-3.5 ${s.likedBy.has(currentUserId) ? 'fill-current' : ''}`} />
                  {s.likes}
                </button>
                <button className="flex items-center gap-1 text-[#8b949e] hover:text-[#00d4aa] text-xs transition-colors">
                  <MessageCircle className="w-3.5 h-3.5" />
                  {s.comments.length}
                </button>
                <span className="text-[#6e7681] text-[10px] ml-auto">
                  {new Date(s.createdAt).toLocaleDateString('zh-CN')}
                </span>
              </div>
              {/* Comments */}
              {s.comments.length > 0 && (
                <div className="mt-2 space-y-1">
                  {s.comments.map((c) => (
                    <div key={c.id} className="flex gap-1.5 px-2 py-1 bg-[#161b22] rounded">
                      <span className="text-[#00d4aa] text-[10px] shrink-0">{c.author}</span>
                      <span className="text-[#8b949e] text-[10px]">{c.content}</span>
                    </div>
                  ))}
                </div>
              )}
              {/* Comment Input */}
              <div className="flex items-center gap-1 mt-1.5">
                <input
                  value={commentInputs[s.id] || ''}
                  onChange={(e) => setCommentInputs((prev) => ({ ...prev, [s.id]: e.target.value }))}
                  placeholder="评论..."
                  className="flex-1 bg-[#161b22] text-[#e6edf3] text-[10px] rounded-lg px-2 py-1 border border-[#30363d] focus:border-[#00d4aa] outline-none"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && commentInputs[s.id]?.trim()) {
                      addComment(s.id, currentUserId, commentInputs[s.id]);
                      setCommentInputs((prev) => ({ ...prev, [s.id]: '' }));
                    }
                  }}
                />
                <button
                  onClick={() => {
                    if (commentInputs[s.id]?.trim()) {
                      addComment(s.id, currentUserId, commentInputs[s.id]);
                      setCommentInputs((prev) => ({ ...prev, [s.id]: '' }));
                    }
                  }}
                  className="text-[#00d4aa] hover:text-[#00e5b3] transition-colors"
                >
                  <Send className="w-3 h-3" />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
