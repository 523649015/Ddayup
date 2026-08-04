import { useEffect, useMemo, useState } from 'react';
import { Globe, Heart, MessageCircle, X, Coins, ExternalLink } from 'lucide-react';
import { useUILanguage } from '@/i18n/ui';
import { useCobuildStore, maskCobuildEmail, type CoBuildEntry } from '@/store/useCobuildStore';
import { useDonationStore } from '@/store/useDonationStore';

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

function entryTitle(e: CoBuildEntry, lang: 'zh' | 'en') {
  if (e.type === 'donation') {
    return lang === 'en' ? `Tipped ¥${e.donation} to support HMDao` : `打赏 ¥${e.donation} 支持 HMDao`;
  }
  if (e.type === 'both') {
    return lang === 'en' ? `Feedback + ¥${e.donation} tip` : `提交反馈并打赏 ¥${e.donation}`;
  }
  return e.message;
}

export function WorldChannel() {
  const { language, t } = useUILanguage();
  const lang = language === 'en' ? 'en' : 'zh';
  const show = useDonationStore((s) => s.showWorldChannel);
  const toggleWorldChannel = useDonationStore((s) => s.toggleWorldChannel);
  const toggleDonationPanel = useDonationStore((s) => s.toggleDonationPanel);
  const { entries, load, toggleLike } = useCobuildStore();

  const [index, setIndex] = useState(0);
  const [showComments, setShowComments] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [detail, setDetail] = useState<CoBuildEntry | null>(null);

  useEffect(() => {
    load();
  }, [load]);

  // 同步世界频道：优先展示有打赏或热度较高的共建动态，按点赞与打赏加权排序。
  const carousel = useMemo(() => {
    return [...entries]
      .sort((a, b) => b.likes + b.donation - (a.likes + a.donation))
      .slice(0, 12);
  }, [entries]);

  useEffect(() => {
    if (!show || carousel.length <= 1) return;
    const timer = setInterval(() => setIndex((i) => (i + 1) % carousel.length), 5000);
    return () => clearInterval(timer);
  }, [show, carousel.length]);

  useEffect(() => {
    if (index >= carousel.length) setIndex(0);
  }, [carousel.length, index]);

  if (!show) return null;
  const current = carousel[index];

  return (
    <div className="world-channel">
      <div className="wc-header">
        <span className="wc-title">
          <Globe size={14} /> {t('世界频道', 'World Channel')}
          <span className="wc-live">{t('实时', 'LIVE')}</span>
        </span>
        <div className="wc-actions">
          <button className="wc-link" onClick={() => toggleDonationPanel()} title={t('我也要共建', 'Co-build')}>
            <ExternalLink size={13} />
          </button>
          <button className="wc-close" onClick={() => toggleWorldChannel()} aria-label="close">
            <X size={14} />
          </button>
        </div>
      </div>

      {carousel.length === 0 ? (
        <div className="wc-empty">{t('暂无共建动态，快来成为第一个参与者！', 'No activity yet. Be the first to join!')}</div>
      ) : (
        <div className="wc-body" onClick={() => setDetail(current)}>
          <div className="wc-user">
            <span className="wc-avatar">{(maskCobuildEmail(current.userEmail) || '?').slice(0, 1).toUpperCase()}</span>
            <span className="wc-name">{maskCobuildEmail(current.userEmail)}</span>
            {current.donation > 0 && <span className="wc-amount-sm">¥{current.donation}</span>}
            <span className="wc-time">{timeAgo(current.createdAt, lang)}</span>
          </div>
          <div className="wc-message">
            {current.type === 'donation' ? (
              <span className="wc-donation">
                <Coins size={13} /> {entryTitle(current, lang)}
              </span>
            ) : (
              entryTitle(current, lang)
            )}
            {current.message && current.type !== 'donation' && (
              <span className="wc-sub">{current.message}</span>
            )}
          </div>
          {current.tags?.length > 0 && (
            <div className="wc-tags">
              {current.tags.map((tag) => (
                <span key={tag}>#{tag}</span>
              ))}
            </div>
          )}
          <div className="wc-stats">
            <span>♥ {current.likes}</span>
            <span>💬 {(current.comments || []).length}</span>
          </div>
        </div>
      )}

      {carousel.length > 1 && (
        <div className="wc-dots">
          {carousel.map((_, i) => (
            <button
              key={i}
              className={`wc-dot ${i === index ? 'active' : ''}`}
              onClick={() => setIndex(i)}
              aria-label={`slide ${i + 1}`}
            />
          ))}
        </div>
      )}

      {detail && (
        <div className="wc-detail-overlay" onClick={() => setDetail(null)}>
          <div className="wc-detail" onClick={(e) => e.stopPropagation()}>
            <div className="wc-detail-head">
              <span className="wc-title">
                <Globe size={14} /> {t('共建详情', 'Co-build detail')}
              </span>
              <button className="wc-close" onClick={() => setDetail(null)}>
                <X size={14} />
              </button>
            </div>
            <div className="wc-detail-user">
              <span className="wc-avatar">{(maskCobuildEmail(detail.userEmail) || '?').slice(0, 1).toUpperCase()}</span>
              <span>{maskCobuildEmail(detail.userEmail)}</span>
              <span className="wc-time">{timeAgo(detail.createdAt, lang)}</span>
            </div>
            {detail.message && <div className="wc-detail-msg">{detail.message}</div>}
            {detail.donation > 0 && (
              <div className="wc-detail-donation">
                <Coins size={13} /> {lang === 'en' ? `Tipped ¥${detail.donation}` : `打赏 ¥${detail.donation}`}
              </div>
            )}
            {detail.tags?.length > 0 && (
              <div className="wc-tags">
                {detail.tags.map((tag) => (
                  <span key={tag}>#{tag}</span>
                ))}
              </div>
            )}
            <div className="wc-detail-actions">
              <button className="wc-like" onClick={() => toggleLike(detail.id)}>
                <Heart size={13} /> {detail.likes}
              </button>
            </div>
            <div className="wc-detail-comments">
              <div className="wc-detail-comments-title">
                <MessageCircle size={13} /> {t('评论', 'Comments')} ({(detail.comments || []).length})
              </div>
              {(detail.comments || []).map((c) => (
                <div key={c.id} className="wc-comment">
                  <span className="wc-comment-user">{maskCobuildEmail(c.userEmail)}</span>
                  <span className="wc-comment-text">{c.text}</span>
                </div>
              ))}
              {(!detail.comments || detail.comments.length === 0) && (
                <div className="wc-comment-empty">{t('还没有评论', 'No comments yet')}</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
