import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import QRCode from 'qrcode';
import { Check, Loader2, Sparkles, ShieldCheck } from 'lucide-react';
import PricingDemo from '@/components/demo/PricingDemo';
import ScanCaptureDemo from '@/components/demo/ScanCaptureDemo';
import { usePublicUILanguage } from '@/i18n/publicUi';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';

// 营销文案（仅展示用，不含价格——价格一律由后端 GET /api/extension/plans 下发，杜绝前后端金额不一致）
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
    features: {
      zh: ['Ddayup 插件操作使用教程', 'BUG 反馈与修复', '基础技术支持'],
      en: ['Plugin tutorial', 'Bug report & fix', 'Basic support'],
    },
  },
  quarterly: {
    name: { zh: '季度版', en: 'Quarterly' },
    tagline: { zh: '按季订阅，性价比之选', en: 'Quarterly, balanced value' },
    highlight: false,
    features: {
      zh: ['含基础版全部', '季度优先支持'],
      en: ['Everything in Basic', 'Quarterly priority support'],
    },
  },
  yearly: {
    name: { zh: '专业版', en: 'Pro' },
    tagline: { zh: '进阶用户首选，按年更省', en: 'For power users, yearly saving' },
    highlight: true,
    features: {
      zh: ['含基础版全部', '优先工单处理', '定制化扫描规则配置'],
      en: ['Everything in Basic', 'Priority tickets', 'Custom scan rules'],
    },
  },
  lifetime: {
    name: { zh: '豪华版', en: 'Deluxe' },
    tagline: { zh: '一次性买断，永久使用', en: 'One-time, forever' },
    highlight: false,
    features: {
      zh: ['含专业版全部', '1 对 1 远程协助', '专属功能定制'],
      en: ['Everything in Pro', '1-on-1 remote help', 'Exclusive customization'],
    },
  },
};

type PlanId = 'monthly' | 'quarterly' | 'yearly' | 'lifetime';

// 套餐价格（来自后端单一真源）；加载完成前为空数组
type PlanPrice = { id: PlanId; name: { zh: string; en: string }; priceCny: number; priceUsd: number; days: number };

async function createSubscription(deviceId: string, token: string, plan: PlanId, provider: 'wechat' | 'alipay') {
  const resp = await fetch('/api/extension/subscription/create', {
    method: 'POST',
    credentials: 'omit', // 公开端点，避免 Chrome 第三方 Cookie 拦截告警
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId, token, plan, provider }),
  });
  return resp.json();
}

async function fetchLicenseStatus(deviceId: string) {
  const resp = await fetch('/api/extension/license/status', {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId }),
  });
  return resp.json();
}

export default function PricingPage() {
  const [searchParams] = useSearchParams();
  const { t, language } = usePublicUILanguage();
  const deviceId = searchParams.get('deviceId') || '';
  const token = searchParams.get('token') || '';
  const paidParam = searchParams.get('paid') === '1';

  const [provider, setProvider] = useState<'wechat' | 'alipay'>('wechat');
  const [selected, setSelected] = useState<PlanId>('yearly');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [checkoutUrl, setCheckoutUrl] = useState('');
  const [orderId, setOrderId] = useState('');
  const [paid, setPaid] = useState(false);
  const [expireAt, setExpireAt] = useState<number | null>(null);
  const [polling, setPolling] = useState(paidParam); // URL 里有 ?paid=1 先进入轮询态，等真实状态确认
  const [verifyingReturn, setVerifyingReturn] = useState(paidParam); // 回跳态：正在向服务端核实

  // 套餐价格（来自后端单一真源）；加载完成前为空数组
  const [plans, setPlans] = useState<PlanPrice[]>([]);
  const [plansLoading, setPlansLoading] = useState(true);
  // 从后端 GET /api/extension/plans 拉取套餐（价格单一事实来源，前端不再硬编码金额）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/extension/plans', { credentials: 'omit' });
        const j = await r.json();
        if (!cancelled && j?.success && Array.isArray(j.plans)) setPlans(j.plans as PlanPrice[]);
      } catch { /* ignore */ }
      finally { if (!cancelled) setPlansLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  // 回跳 ?paid=1 时立刻向服务端核实真实授权状态，避免异步回调未到就误显"成功"
  useEffect(() => {
    if (!paidParam || !deviceId) return;
    let cancelled = false;
    (async () => {
      try {
        const status = await fetchLicenseStatus(deviceId);
        if (cancelled) return;
        if (status?.success && status.mode === 'paid') {
          setPaid(true);
          setExpireAt(status.periodEnd || null);
          setPolling(false);
          setVerifyingReturn(false);
          return;
        }
        // 服务端尚未收到异步回调，保持轮询态直到追上
        setVerifyingReturn(false);
      } catch {
        setVerifyingReturn(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startCheckout = useCallback(async () => {
    if (!deviceId) {
      setError(t('缺少设备标识，请从浏览器扩展内点击「去订阅」进入本页。', 'Missing device id. Open this page from the extension’s “Subscribe” button.'));
      return;
    }
    setLoading(true);
    setError(null);
    setQrDataUrl('');
    setCheckoutUrl('');
    try {
      const data = await createSubscription(deviceId, token, selected, provider);
      if (!data.success) {
        setError(data?.error?.message || t('创建订单失败，请重试。', 'Failed to create order, please retry.'));
        return;
      }
      setOrderId(data.orderId);
      if (data.mock) {
        // 本地/未配置真实网关：模拟回跳直接激活（仅开发测试）
        setCheckoutUrl(data.checkoutUrl);
        setPolling(true);
        return;
      }
      // 微信 / 支付宝 均为扫码支付，返回 codeUrl → 前端生成二维码
      if ((provider === 'wechat' || provider === 'alipay') && data.codeUrl) {
        const url = await QRCode.toDataURL(data.codeUrl, { width: 220, margin: 1 });
        setQrDataUrl(url);
        setPolling(true);
      }
    } catch (e) {
      setError(t('网络错误，请检查连接后重试。', 'Network error, please retry.'));
    } finally {
      setLoading(false);
    }
  }, [deviceId, token, selected, provider, t]);

  // 轮询授权状态直到 paid；超时（5 分钟）后停止并提示，避免永久轮询
  const POLL_MAX = 100; // 100 × 3s = 5 分钟
  useEffect(() => {
    if (!polling || !deviceId) return;
    let timer: ReturnType<typeof setInterval>;
    let count = 0;
    const tick = async () => {
      try {
        const status = await fetchLicenseStatus(deviceId);
        if (status?.success && status.mode === 'paid') {
          setPaid(true);
          setExpireAt(status.periodEnd || null);
          setPolling(false);
          clearInterval(timer);
          return;
        }
      } catch { /* ignore */ }
      count += 1;
      if (count >= POLL_MAX) {
        setPolling(false);
        clearInterval(timer);
        setError(t('未检测到支付完成，请确认支付是否成功；如已支付，请稍后刷新或联系客服。', 'No payment detected. If you paid, please refresh later or contact support.'));
      }
    };
    timer = setInterval(tick, 3000);
    tick();
    return () => clearInterval(timer);
  }, [polling, deviceId, t]);

  return (
    <div className="min-h-screen bg-[#0d1117] px-4 py-10 text-[#e6edf3]">
      <div className="mx-auto max-w-5xl">
        <header className="mb-8 text-center">
          <Link to="/" className="text-sm text-[#8b949e] hover:text-[#e6edf3]">← {t('返回画布编辑器（免费）', 'Back to Canvas Editor (free)')}</Link>
          <h1 className="mt-3 text-3xl font-bold">{t('Ddayup 素材采集扩展 · 订阅', 'Ddayup Capture Extension · Subscribe')}</h1>
          <p className="mt-2 text-[#8b949e]">
            {t('7 天免费试用，结束后订阅以继续采集网络素材。', '7-day free trial. Subscribe after trial to keep capturing web assets.')}
          </p>
          {/* 边界明确声明：画布编辑器免费，付费仅针对扩展 */}
          <div className="mx-auto mt-4 inline-flex items-center gap-2 rounded-full border border-[#30363d] bg-[#161b22] px-4 py-1.5 text-xs text-[#8b949e]">
            <ShieldCheck size={14} className="text-[#4bd3b2]" />
            {t('画布编辑器（DCC/视频/图片/音频/文本节点）永久免费；下方付费仅针对「Ddayup 网页素材整理」浏览器扩展。', 'The Canvas Editor (DCC / video / image / audio / text nodes) is free forever. Payment below applies only to the Ddayup web-asset organizer browser extension.')}
          </div>
        </header>

        {!deviceId ? (
          <Card className="mx-auto mt-10 max-w-md border-[#30363d] bg-[#161b22]">
            <CardContent className="flex flex-col items-center gap-3 py-10">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#30363d] text-2xl text-[#8b949e]"><ShieldCheck size={28} /></div>
              <h2 className="text-lg font-semibold">{t('请从浏览器扩展内进入', 'Open from the browser extension')}</h2>
              <p className="max-w-sm text-center text-sm text-[#8b949e]">
                {t('订阅页仅服务于 Ddayup 网页素材采集扩展。请在浏览器扩展侧栏点击「去订阅」进入本页。', 'This subscription page is for the Ddayup web-capture extension only. Please click "Subscribe" in the extension sidebar to open this page.')}
              </p>
            </CardContent>
          </Card>
        ) : verifyingReturn ? (
          <Card className="mx-auto max-w-md border-[#30363d] bg-[#161b22]">
            <CardContent className="flex flex-col items-center gap-3 py-10">
              <Loader2 size={28} className="animate-spin text-[#1f6feb]" />
              <h2 className="text-lg font-semibold">{t('正在确认支付结果…', 'Confirming payment…')}</h2>
              <p className="max-w-sm text-center text-sm text-[#8b949e]">
                {t('已收到你的支付回跳，正在与支付网关核实最终状态，通常 1~10 秒内完成。', 'We received your return URL. Confirming with the payment gateway — usually finishes within 1–10 seconds.')}
              </p>
            </CardContent>
          </Card>
        ) : paid ? (
          <Card className="mx-auto max-w-md border-[#315f57] bg-[#18332d]">
            <CardContent className="flex flex-col items-center gap-3 py-10">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#4bd3b2] text-2xl text-[#06281f]"><Check size={28} /></div>
              <h2 className="text-xl font-semibold">{t('订阅成功！', 'Subscription active!')}</h2>
              {expireAt ? (
                <p className="text-center text-sm text-[#aaf2df]">
                  {t('有效期至', 'Valid until')} {new Date(expireAt).toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US')}
                  {selected !== 'lifetime' && <> · {t('到期前可在此续费', 'Renew here before expiry')}</>}
                </p>
              ) : (
                <p className="text-center text-sm text-[#aaf2df]">{t('现在可返回浏览器扩展继续使用素材采集功能。', 'Return to the browser extension to keep using capture.')}</p>
              )}
              {/* 续期入口：到期前可再次发起订阅 */}
              {selected !== 'lifetime' && (
                <Button variant="outline" className="mt-2 border-[#4bd3b2] text-[#4bd3b2]" onClick={() => { setPaid(false); setQrDataUrl(''); setCheckoutUrl(''); setExpireAt(null); }}>{t('续费 / 升级', 'Renew / Upgrade')}</Button>
              )}
              <Button asChild className="mt-2"><a href="#" onClick={() => window.close()}>{t('关闭页面', 'Close page')}</a></Button>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* 支付方式切换：微信 / 支付宝（仅适用扩展） */}
            <div className="mb-6 flex justify-center gap-2">
              <button
                onClick={() => setProvider('wechat')}
                className={`rounded-full px-4 py-1.5 text-sm ${provider === 'wechat' ? 'bg-[#07c160] text-white' : 'border border-[#30363d] text-[#8b949e]'}`}
              >{t('微信支付', 'WeChat Pay')}</button>
              <button
                onClick={() => setProvider('alipay')}
                className={`rounded-full px-4 py-1.5 text-sm ${provider === 'alipay' ? 'bg-[#1677ff] text-white' : 'border border-[#30363d] text-[#8b949e]'}`}
              >{t('支付宝', 'Alipay')}</button>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              {plansLoading || plans.length === 0 ? (
                <div className="col-span-full flex items-center justify-center gap-2 py-10 text-sm text-[#8b949e]">
                  <Loader2 size={16} className="animate-spin" /> {t('正在加载套餐…', 'Loading plans…')}
                </div>
              ) : plans.map((plan) => {
                const m = PLAN_MARKETING[plan.id] || { name: plan.name, tagline: { zh: '', en: '' }, highlight: false, features: { zh: [], en: [] } };
                return (
                <Card
                  key={plan.id}
                  className={`cursor-pointer transition ${selected === plan.id ? 'border-[#1f6feb] ring-1 ring-[#1f6feb]' : 'border-[#30363d]'} ${m.highlight ? 'bg-[#111d2e]' : 'bg-[#161b22]'}`}
                  onClick={() => setSelected(plan.id)}
                >
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-lg">{plan.name[language === 'zh' ? 'zh' : 'en']}</CardTitle>
                      {m.highlight && <span className="rounded bg-[#1f6feb] px-2 py-0.5 text-[10px] text-white">{t('推荐', 'Popular')}</span>}
                    </div>
                    <CardDescription className="text-[#8b949e]">{m.tagline[language === 'zh' ? 'zh' : 'en']}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">¥{plan.priceCny}<span className="text-sm font-normal text-[#8b949e]"> / {(plan.days >= 9999 ? t('永久', 'forever') : (plan.id as string) === 'monthly' ? t('月', 'month') : (plan.id as string) === 'quarterly' ? t('季', 'quarter') : t('年', 'year'))}</span></div>
                    <div className="mt-1 text-xs text-[#6e7681]">≈ ${plan.priceUsd}</div>
                    <ul className="mt-3 space-y-1.5 text-xs text-[#c9d1d9]">
                      {m.features[language === 'zh' ? 'zh' : 'en'].map((f) => (
                        <li key={f} className="flex gap-1.5"><Check size={13} className="mt-0.5 shrink-0 text-[#4bd3b2]" />{f}</li>
                      ))}
                    </ul>
                  </CardContent>
                  <CardFooter>
                    <div className="flex w-full items-center gap-1 text-xs text-[#8b949e]">
                      <Sparkles size={12} /> {plan.days >= 9999 ? t('一次性买断，永久使用', 'One-time, forever') : t('到期前可续费', 'Renew before expiry')}
                    </div>
                  </CardFooter>
                </Card>
                );
              })}
            </div>

            <div className="mt-8 flex flex-col items-center gap-4">
              <Button onClick={startCheckout} disabled={loading} className="w-64 bg-[#1f6feb] hover:bg-[#388bfd]">
                {loading && <Loader2 size={16} className="mr-2 animate-spin" />}
                {t('立即订阅', 'Subscribe now')}
              </Button>

              {qrDataUrl && (
                <div className="rounded-lg border border-[#30363d] bg-white p-4">
                  <img src={qrDataUrl} alt="pay qrcode" className="h-[220px] w-[220px]" />
                  <p className="mt-2 text-center text-xs text-black">
                    {provider === 'alipay' ? t('请用支付宝扫码支付', 'Scan with Alipay to pay') : t('请用微信扫码支付', 'Scan with WeChat to pay')}
                  </p>
                </div>
              )}

              {checkoutUrl && (
                <a href={checkoutUrl} className="text-sm text-[#1f6feb] underline">{t('点击此处完成支付（模拟）', 'Complete payment here (mock)')}</a>
              )}

              {polling && !qrDataUrl && !checkoutUrl && (
                <p className="flex items-center gap-2 text-sm text-[#8b949e]"><Loader2 size={14} className="animate-spin" />{t('正在确认支付状态…', 'Confirming payment…')}</p>
              )}

              {error && <p className="text-sm text-[#ff7b72]">{error}</p>}
            </div>
          </>
        )}

        {/* 底部双栏循环演示：左 Ddayup 扩展扫描采集 / 右订阅流程。所有页面状态（锁定/确认中/已订阅/未订阅）都显示 */}
        <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-2">
          <ScanCaptureDemo />
          <PricingDemo />
        </div>
      </div>
    </div>
  );
}
