import { useEffect, useMemo, useState } from 'react';
import { usePublicUILanguage } from '@/i18n/publicUi';
import { useNavigate } from 'react-router-dom';
import { Check, Loader2, Sparkles } from 'lucide-react';
import { useAuthStore } from '@/store/useAuthStore';
import { syncLoginToExtension, detectHmdaoExtension } from '@/services/extensionBridge';

// 营销文案（仅展示；价格由后端 GET /api/extension/plans 下发，杜绝前后端金额不一致）
const PLAN_MARKETING: Record<string, {
  name: { zh: string; en: string };
  tagline: { zh: string; en: string };
  highlight: boolean;
  features: { zh: string[]; en: string[] };
}> = {
  monthly: {
    name: { zh: '基础版', en: 'Basic' },
    tagline: { zh: '轻量使用，按月灵活订阅', en: 'Light use, flexible monthly' },
    highlight: false,
    features: { zh: ['Ddayup 插件使用教程', 'BUG 反馈与修复', '基础技术支持'], en: ['Plugin tutorial', 'Bug report & fix', 'Basic support'] },
  },
  quarterly: {
    name: { zh: '季度版', en: 'Quarterly' },
    tagline: { zh: '按季订阅，性价比之选', en: 'Quarterly, balanced value' },
    highlight: false,
    features: { zh: ['含基础版全部', '季度优先支持'], en: ['Everything in Basic', 'Quarterly priority support'] },
  },
  yearly: {
    name: { zh: '专业版', en: 'Pro' },
    tagline: { zh: '进阶用户首选，按年更省', en: 'For power users, yearly saving' },
    highlight: true,
    features: { zh: ['含基础版全部', '优先工单处理', '定制化扫描规则配置'], en: ['Everything in Basic', 'Priority tickets', 'Custom scan rules'] },
  },
  lifetime: {
    name: { zh: '豪华版', en: 'Deluxe' },
    tagline: { zh: '一次性买断，永久使用', en: 'One-time, forever' },
    highlight: false,
    features: { zh: ['含专业版全部', '1 对 1 远程协助', '专属功能定制'], en: ['Everything in Pro', '1-on-1 remote help', 'Exclusive customization'] },
  },
};

type PlanPrice = { id: string; name: { zh: string; en: string }; priceCny: number; priceUsd: number; days: number };

export default function SubscribePage() {
  const { t, language } = usePublicUILanguage();
  const navigate = useNavigate();
  const [plans, setPlans] = useState<PlanPrice[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string>('yearly');

  // 官网登录态 → 扩展同步（一次性绑定码换令牌）
  const loggedIn = useAuthStore((s) => Boolean(s.user && s.session && Date.now() <= (s.session?.expiresAt || 0)));
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [extInstalled, setExtInstalled] = useState<boolean | null>(null);

  useEffect(() => { detectHmdaoExtension().then(setExtInstalled).catch(() => setExtInstalled(false)); }, []);

  const onSyncLogin = async () => {
    setSyncing(true);
    setSyncMsg(null);
    const r = await syncLoginToExtension();
    setSyncing(false);
    setSyncMsg(r.success ? `已同步到扩展${r.email ? `（${r.email}）` : ''}` : (r.error || '同步失败'));
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/extension/plans', { credentials: 'omit' });
        const j = await r.json();
        if (!cancelled && j?.success && Array.isArray(j.plans)) {
          setPlans(j.plans);
          if (j.plans.some((p: PlanPrice) => p.id === 'yearly')) setSelected('yearly');
        }
      } catch { /* ignore */ }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  const unitLabel = (p: PlanPrice) =>
    p.days >= 9999 ? t('永久', 'forever')
      : p.id === 'monthly' ? t('月', 'month')
      : p.id === 'quarterly' ? t('季', 'quarter')
      : t('年', 'year');

  // 实际下单走口径统一的 /pricing 流程（携带扩展端 deviceId/token 才能激活授权），
  // 旧 payment.mjs 通道已废弃（其回调从不激活授权，属死通道）。
  const goCheckout = () => navigate('/pricing' + (window.location.search || ''));

  const current = useMemo(() => plans.find((p) => p.id === selected), [plans, selected]);

  return (
    <div className="min-h-screen bg-[#0d1117] text-[#e6edf3]">
      <div className="mx-auto max-w-5xl px-4 py-10">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold">{t('订阅 Ddayup 专业版', 'Subscribe to Ddayup Pro')}</h1>
          <p className="mt-2 text-[#8b949e]">{t('一站式网页素材采集与 AI 创作增强', 'All-in-one web asset capture & AI creation')}</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          {loading || plans.length === 0 ? (
            <div className="col-span-full flex items-center justify-center gap-2 py-10 text-sm text-[#8b949e]">
              <Loader2 size={16} className="animate-spin" /> {t('正在加载套餐…', 'Loading plans…')}
            </div>
          ) : plans.map((p) => {
            const m = PLAN_MARKETING[p.id] || { name: p.name, tagline: { zh: '', en: '' }, highlight: false, features: { zh: [], en: [] } };
            return (
              <div
                key={p.id}
                onClick={() => setSelected(p.id)}
                className={`cursor-pointer rounded-xl border p-5 transition ${selected === p.id ? 'border-[#1f6feb] ring-1 ring-[#1f6feb]' : 'border-[#30363d]'} ${m.highlight ? 'bg-[#111d2e]' : 'bg-[#161b22]'}`}
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-semibold">{m.name[language === 'zh' ? 'zh' : 'en']}</h3>
                  {m.highlight && <span className="rounded bg-[#1f6feb] px-2 py-0.5 text-[10px] text-white">{t('推荐', 'Popular')}</span>}
                </div>
                <p className="mt-1 text-sm text-[#8b949e]">{m.tagline[language === 'zh' ? 'zh' : 'en']}</p>
                <div className="mt-4 text-2xl font-bold">¥{p.priceCny}<span className="text-sm font-normal text-[#8b949e]"> / {unitLabel(p)}</span></div>
                <div className="mt-1 text-xs text-[#6e7681]">≈ ${p.priceUsd}</div>
                <ul className="mt-3 space-y-1.5 text-xs text-[#c9d1d9]">
                  {m.features[language === 'zh' ? 'zh' : 'en'].map((f) => (
                    <li key={f} className="flex gap-1.5"><Check size={13} className="mt-0.5 shrink-0 text-[#4bd3b2]" />{f}</li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>

        <div className="mt-8 flex flex-col items-center gap-3">
          <button
            onClick={goCheckout}
            disabled={!current}
            className="w-64 rounded-full bg-[#1f6feb] px-6 py-3 font-medium text-white transition hover:bg-[#388bfd] disabled:opacity-50"
          >
            {t('立即订阅', 'Subscribe now')}
          </button>
          {current && (
            <p className="flex items-center gap-1 text-xs text-[#8b949e]">
              <Sparkles size={12} /> {current.days >= 9999 ? t('一次性买断，永久使用', 'One-time, forever') : t('到期前可续费', 'Renew before expiry')}
            </p>
          )}
        </div>

        {loggedIn && (
          <div className="mt-8 flex flex-col items-center gap-2 border-t border-[#21262d] pt-6">
            <p className="text-center text-xs text-[#8b949e]">
              {extInstalled === false
                ? t('未检测到 Ddayup 扩展，请先安装并启用后再同步', 'Ddayup extension not detected — install and enable it first')
                : t('已登录官网，可一键把登录态同步到浏览器扩展', 'Signed in — sync this login to the browser extension')}
            </p>
            <button
              onClick={onSyncLogin}
              disabled={syncing || extInstalled === false}
              className="w-64 rounded-full border border-[#30363d] bg-[#161b22] px-6 py-2.5 text-sm text-[#c9d1d9] transition hover:border-[#1f6feb] disabled:opacity-50"
            >
              {syncing ? t('同步中…', 'Syncing…') : t('同步登录到扩展', 'Sync login to extension')}
            </button>
            {syncMsg && <p className="text-center text-xs text-[#8b949e]">{syncMsg}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
