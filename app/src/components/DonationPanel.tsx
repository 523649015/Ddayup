import { useEffect, useState } from 'react';
import { Heart, MessageCircle, Send, Tag, X, Coins, Lock, HandHeart } from 'lucide-react';
import { useUILanguage } from '@/i18n/ui';
import { useAuthStore } from '@/store/useAuthStore';
import { useCobuildStore, maskCobuildEmail, type CoBuildEntry } from '@/store/useCobuildStore';
import { useDonationStore } from '@/store/useDonationStore';
import { ModelActivationPrompt } from '@/components/ModelActivationPrompt';
import { toast } from 'sonner';

const DONATION_AMOUNTS = [6, 18, 30, 66, 88, 188];

function timeAgo(iso: string, lang: 'zh' | 'en') {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return lang === 'en' ? 'just now' : '刚刚';
  if (m < 60) return lang === 'en' ? `${m}m ago` : `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return lang === 'en' ? `${h}h ago` : `${h} 小时前`;
  const d = Math.floor(h / 24);
  return lang === 'en' ? `${d}d ago` : `${d} 天前`;
}

function entrySummary(e: CoBuildEntry, lang: 'zh' | 'en') {
  if (e.type === 'donation') {
    return lang === 'en'
      ? `Supported the project with ¥${e.donation}`
      : `为项目打赏了 ¥${e.donation}`;
  }
  if (e.type === 'both') {
    return lang === 'en'
      ? `Feedback + ¥${e.donation} support`
      : `提交反馈并打赏 ¥${e.donation}`;
  }
  return e.message;
}

export function DonationPanel() {
  const { language, t } = useUILanguage();
  const lang = language === 'en' ? 'en' : 'zh';
  const authed = useAuthStore((s) => s.isAuthenticated());
  const user = useAuthStore((s) => s.user);
  const show = useDonationStore((s) => s.showDonationPanel);
  const toggleDonationPanel = useDonationStore((s) => s.toggleDonationPanel);

  if (!show) return null;

  const { entries, load, submit, toggleLike, addComment, submitting, error } = useCobuildStore();
  const [activeTab, setActiveTab] = useState<'suggestions' | 'world'>('suggestions');
  const [message, setMessage] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [amount, setAmount] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [commentText, setCommentText] = useState('');
  const [showAuth, setShowAuth] = useState(false);

  useEffect(() => {
    load();
  }, [load]);

  const currentUserId = user?.id || 'local-user';
  const isLiked = (e: CoBuildEntry) => (e.likedBy || []).includes(currentUserId);

  function addTag() {
    const v = tagInput.trim();
    if (v && !tags.includes(v)) setTags([...tags, v]);
    setTagInput('');
  }

  async function handleSubmit() {
    const result = await submit({ message, tags, donation: amount });
    if (result) {
      if (result.donation > 0) {
        toast.success(lang === 'en' ? 'Thank you for your support ❤️' : '感谢支持 ❤️');
      } else {
        toast.success(lang === 'en' ? 'Submitted, thank you!' : '提交成功，感谢共建！');
      }
      setMessage('');
      setTags([]);
      setTagInput('');
      setAmount(0);
      setActiveTab('world');
    } else if (error) {
      toast.error(error);
    }
  }

  // 未登录：仅注册用户可参与需求共建
  if (!authed) {
    return (
      <div className="donation-panel">
        <div className="donation-header">
          <span className="donation-title">
            <HandHeart size={16} /> {t('需求共建', 'Community Co-build')}
          </span>
          <button className="donation-close" onClick={() => toggleDonationPanel()} aria-label="close">
            <X size={16} />
          </button>
        </div>
        <div className="donation-gate">
          <Lock size={28} />
          <p className="donation-gate-title">{t('仅限已注册用户参与', 'Registered users only')}</p>
          <p className="donation-gate-desc">
            {t(
              '需求共建与打赏功能仅对已注册账号开放，提交反馈或打赏前请先登录。',
              'Co-build and tipping are available to registered accounts only. Please sign in before submitting feedback or tipping.',
            )}
          </p>
          <button className="donation-submit" onClick={() => setShowAuth(true)}>
            <Lock size={14} /> {t('去登录 / 注册', 'Sign in / Register')}
          </button>
        </div>
        <ModelActivationPrompt open={showAuth} mode="llm" provider="" reason="auth" onClose={() => setShowAuth(false)} />
      </div>
    );
  }

  return (
    <div className="donation-panel">
      <div className="donation-header">
        <span className="donation-title">
          <HandHeart size={16} /> {t('需求共建', 'Community Co-build')}
        </span>
        <button className="donation-close" onClick={() => toggleDonationPanel()} aria-label="close">
          <X size={16} />
        </button>
      </div>

      <div className="donation-tabs">
        <button
          className={`donation-tab ${activeTab === 'suggestions' ? 'active' : ''}`}
          onClick={() => setActiveTab('suggestions')}
        >
          {t('提建议', 'Suggest')}
        </button>
        <button
          className={`donation-tab ${activeTab === 'world' ? 'active' : ''}`}
          onClick={() => setActiveTab('world')}
        >
          {t('世界频道', 'World Channel')}
        </button>
      </div>

      {activeTab === 'suggestions' ? (
        <div className="donation-body">
          {error && <div className="donation-error">{error}</div>}

          <label className="donation-label">{t('反馈留言', 'Feedback message')}</label>
          <textarea
            className="donation-textarea"
            placeholder={t('说说你希望 HMDao 增加或改进的能力…', 'Tell us what you want HMDao to add or improve…')}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={3}
          />

          <label className="donation-label">{t('标签（可选）', 'Tags (optional)')}</label>
          <div className="donation-tagbar">
            <Tag size={13} />
            <input
              className="donation-taginput"
              placeholder={t('如：视频导出 / 字幕 / 智能分镜', 'e.g. video export / subtitle / storyboard')}
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addTag();
                }
              }}
            />
            <button className="donation-tagadd" onClick={addTag}>
              {t('添加', 'Add')}
            </button>
          </div>
          {tags.length > 0 && (
            <div className="donation-tags">
              {tags.map((tag) => (
                <span key={tag} className="donation-tag">
                  #{tag}
                  <button onClick={() => setTags(tags.filter((x) => x !== tag))}>
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="donation-section">
            <div className="donation-section-title">
              <Coins size={14} /> {t('打赏支持（可选）', 'Tip / Support (optional)')}
            </div>
            <div className="donation-amounts">
              {DONATION_AMOUNTS.map((v) => (
                <button
                  key={v}
                  className={`donation-amount ${amount === v ? 'active' : ''}`}
                  onClick={() => setAmount(amount === v ? 0 : v)}
                >
                  ¥{v}
                </button>
              ))}
            </div>
            {amount > 0 && (
              <div className="donation-amount-selected">
                {t('已选择打赏金额', 'Selected tip amount')}: <strong>¥{amount}</strong>
              </div>
            )}
          </div>

          <button className="donation-submit" disabled={submitting} onClick={handleSubmit}>
            <Send size={14} /> {submitting ? t('提交中…', 'Submitting…') : t('提交需求共建', 'Submit Co-build')}
          </button>

          <div className="donation-list">
            <div className="donation-list-title">{t('共建留言', 'Co-build messages')}</div>
            {entries
              .filter((e) => e.type !== 'donation' || e.message)
              .map((e) => (
                <div key={e.id} className="donation-item">
                  <div className="donation-item-head">
                    <span className="donation-user">{maskCobuildEmail(e.userEmail)}</span>
                    <span className="donation-time">{timeAgo(e.createdAt, lang)}</span>
                  </div>
                  {e.message && <div className="donation-msg">{e.message}</div>}
                  {e.donation > 0 && (
                    <div className="donation-amount-badge">♥ ¥{e.donation}</div>
                  )}
                  {e.tags?.length > 0 && (
                    <div className="donation-item-tags">
                      {e.tags.map((tag) => (
                        <span key={tag}>#{tag}</span>
                      ))}
                    </div>
                  )}
                  <div className="donation-item-actions">
                    <button
                      className={`donation-like ${isLiked(e) ? 'liked' : ''}`}
                      onClick={() => toggleLike(e.id)}
                    >
                      <Heart size={13} /> {e.likes}
                    </button>
                    <button
                      className="donation-comment-btn"
                      onClick={() => setExpandedId(expandedId === e.id ? null : e.id)}
                    >
                      <MessageCircle size={13} /> {(e.comments || []).length}
                    </button>
                  </div>
                  {expandedId === e.id && (
                    <div className="donation-comments">
                      {(e.comments || []).map((c) => (
                        <div key={c.id} className="donation-comment">
                          <span className="donation-comment-user">{maskCobuildEmail(c.userEmail)}</span>
                          <span className="donation-comment-text">{c.text}</span>
                        </div>
                      ))}
                      <div className="donation-comment-input">
                        <input
                          placeholder={t('回复…', 'Reply…')}
                          value={commentText}
                          onChange={(e) => setCommentText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              if (commentText.trim() && expandedId) {
                                addComment(expandedId, commentText);
                                setCommentText('');
                              }
                            }
                          }}
                        />
                        <button
                            onClick={() => {
                              if (commentText.trim() && expandedId) {
                                addComment(expandedId, commentText);
                                setCommentText('');
                            }
                          }}
                        >
                          <Send size={13} />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
          </div>
        </div>
      ) : (
        <div className="donation-body">
          <div className="donation-world-hint">
            {t(
              '世界频道实时轮播所有用户的共建留言与打赏动态，其他用户均可查看。',
              'The World Channel carousels all users’ co-build messages and tipping activity in real time, visible to everyone.',
            )}
          </div>
          <div className="donation-list">
            {entries.map((e) => (
              <div key={e.id} className="donation-item">
                <div className="donation-item-head">
                  <span className="donation-user">{maskCobuildEmail(e.userEmail)}</span>
                  <span className="donation-time">{timeAgo(e.createdAt, lang)}</span>
                </div>
                <div className="donation-msg">{entrySummary(e, lang)}</div>
                {e.message && e.type !== 'donation' && (
                  <div className="donation-msg-sub">{e.message}</div>
                )}
                {e.tags?.length > 0 && (
                  <div className="donation-item-tags">
                    {e.tags.map((tag) => (
                      <span key={tag}>#{tag}</span>
                    ))}
                  </div>
                )}
                <div className="donation-item-actions">
                  <button
                    className={`donation-like ${isLiked(e) ? 'liked' : ''}`}
                    onClick={() => toggleLike(e.id)}
                  >
                    <Heart size={13} /> {e.likes}
                  </button>
                  <span className="donation-world-flag">🌐</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
