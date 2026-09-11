import { useState } from 'react';
import { Check, MapPin, Loader2, QrCode } from 'lucide-react';
import { toDataURL } from 'qrcode';

// 留空 = 使用相对路径（生产走同域 Nginx 反代 /api -> 8793）
// 本地开发请在 .env 设置 VITE_PAY_API=http://127.0.0.1:8793 或依赖 vite proxy
const API = (import.meta as any).env?.VITE_PAY_API || '';

// Ddayup 网页素材采集扩展 · 订阅套餐（每档对应固定周期）
const PLANS = [
  {
    key: 'basic',
    name: '基础版',
    tag: '个人 / 起步',
    price: 18,
    unit: '月',
    points: [
      '网页图片 / 视频 / 音频采集',
      '文档 / 3D 模型索引采集',
      '批量下载与格式整理',
      '基础技术支持',
      '按月订阅，随时取消',
    ],
  },
  {
    key: 'pro',
    name: '专业版',
    tag: '高频 / 进阶',
    price: 168,
    unit: '年',
    hot: true,
    points: [
      '含基础版全部功能',
      '每年 2 次定制采集规则',
      'Bug 优先修复通道',
      '新功能优先体验',
    ],
  },
  {
    key: 'lifetime',
    name: '终身版',
    tag: '长期 / 一次付费',
    price: 588,
    unit: '终身',
    points: [
      '含专业版全部功能',
      '终身免费更新',
      '每日 AI 工作流教程',
      '专属客服对接',
    ],
  },
];

export default function SubscribePage() {
  const [loading, setLoading] = useState<string | null>(null);
  const [qr, setQr] = useState<{ outTradeNo: string; dataUrl: string; subject: string; amount: number } | null>(null);
  const [paid, setPaid] = useState(false);

  async function poll(outTradeNo: string) {
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const r = await fetch(`${API}/api/orders/${outTradeNo}`);
        const o = await r.json();
        if (o?.status === 'PAID') { setPaid(true); return; }
      } catch { /* ignore */ }
    }
  }

  async function pay(planKey: string, amount: number, subject: string, channel: 'alipay' | 'wechat') {
    setLoading(planKey + channel);
    try {
      const outTradeNo = 'DD' + Date.now();
      const res = await fetch(`${API}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, plan: planKey, amount, subject, outTradeNo }),
      });
      if (channel === 'alipay') {
        // 后端已经把参数 POST 到支付宝网关并跟随了所有重定向，返回最终收银台 HTML
        // 同窗口渲染收银台（避开浏览器弹窗拦截）
        const aliHtml = await res.text();
        if (!aliHtml.includes('支付宝') && !aliHtml.includes('alipay')) {
          throw new Error('支付页获取失败');
        }
        // 用 document.open + write 直接在当前窗口替换内容
        // 支付宝内部含 <script> 自动提交表单，跟随 302 重定向到最终收银台
        document.open();
        document.write(aliHtml);
        document.close();
        poll(outTradeNo);
        return;
      }
      const { outTradeNo: wxNo, qrCode } = await res.json();
      const dataUrl = await toDataURL(qrCode, { width: 240, margin: 1 });
      setQr({ outTradeNo: wxNo, dataUrl, subject, amount });
      setPaid(false);
      poll(wxNo);
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="min-h-screen bg-[#0d1117] text-[#c9d1d9]">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        <div className="text-lg font-semibold">鸣鸣创意 <span className="text-[#8b949e] text-sm">· 订阅</span></div>
        <a href="/landing" className="text-xs text-[#8b949e] hover:text-[#e6edf3]">返回首页</a>
      </header>

      <section className="mx-auto max-w-5xl px-6 py-8 text-center">
        <h1 className="text-3xl font-bold">Ddayup 素材采集扩展 · 订阅</h1>
        <p className="mt-2 text-sm text-[#8b949e]">
          网页图片 / 视频 / 音频 / 文档 / 模型采集 · 未激活可全额退款
        </p>
      </section>

      <section className="mx-auto grid max-w-5xl gap-4 px-6 pb-10 md:grid-cols-3">
        {PLANS.map((p) => (
          <div
            key={p.key}
            className={`relative flex flex-col rounded-xl border p-5 ${p.hot ? 'border-[#4bd3b2]' : 'border-[#30363d]'}`}
          >
            {p.hot && (
              <span className="absolute -top-2 right-4 rounded bg-[#4bd3b2] px-2 py-0.5 text-[10px] font-medium text-black">推荐</span>
            )}
            <h3 className="text-lg font-semibold">{p.name}</h3>
            <p className="text-xs text-[#8b949e]">{p.tag}</p>
            <div className="mt-3 text-2xl font-bold">
              ¥{p.price}
              <span className="text-xs font-normal text-[#8b949e]">/{p.unit}</span>
            </div>
            <ul className="mt-4 flex-1 space-y-2 text-sm">
              {p.points.map((pt) => (
                <li key={pt} className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-[#4bd3b2]" />{pt}</li>
              ))}
            </ul>
            <div className="mt-5 grid grid-cols-2 gap-2">
              <button
                disabled={loading === p.key + 'alipay'}
                onClick={() => pay(p.key, p.price, `${p.name}（${p.unit}）`, 'alipay')}
                className="rounded-md bg-[#4bd3b2] py-2 text-sm font-medium text-black hover:brightness-110 disabled:opacity-60"
              >
                {loading === p.key + 'alipay' ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : '支付宝'}
              </button>
              <button
                disabled={loading === p.key + 'wechat'}
                onClick={() => pay(p.key, p.price, `${p.name}（${p.unit}）`, 'wechat')}
                className="rounded-md border border-[#30363d] py-2 text-sm font-medium text-[#e6edf3] hover:border-[#4bd3b2] disabled:opacity-60"
              >
                {loading === p.key + 'wechat' ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : '微信扫码'}
              </button>
            </div>
          </div>
        ))}
      </section>

      <section className="mx-auto max-w-5xl px-6 pb-10">
        <div className="space-y-2 rounded-md border border-[#30363d] bg-[#161b22] p-4 text-xs leading-relaxed text-[#8b949e]">
          <p className="font-medium text-[#e6edf3]">使用须知</p>
          <p>
            本工具仅供采集您拥有合法权益或已获授权的内容。请遵守目标网站 robots
            协议及相关法律法规，因采集行为产生的责任由使用者自行承担。
          </p>
          <p>
            <strong className="text-[#e6edf3]">终身版</strong>
            指本产品持续运营期间内有效；若因业务调整需终止服务，将提前 90
            日通知并按剩余价值协商处理。
          </p>
          <p>
            本商品为数字化服务，<strong className="text-[#e6edf3]">未激活使用前可全额退款</strong>
            ；激活后按剩余服务时长协商退款。
          </p>
        </div>
      </section>

      {qr && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" onClick={() => setQr(null)}>
          <div className="w-full max-w-sm rounded-xl border border-[#30363d] bg-[#161b22] p-6 text-center" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center justify-center gap-2 text-sm font-medium text-[#e6edf3]">
              <QrCode className="h-4 w-4 text-[#4bd3b2]" /> 微信扫码支付
            </div>
            <p className="text-xs text-[#8b949e]">{qr.subject} · ¥{qr.amount}</p>
            {paid ? (
              <div className="mt-4 rounded-md bg-[#4bd3b2]/15 py-3 text-sm font-medium text-[#4bd3b2]">✓ 支付成功</div>
            ) : (
              <>
                <img src={qr.dataUrl} alt="qr" className="mx-auto mt-4 h-60 w-60 rounded bg-white p-2" />
                <p className="mt-3 text-xs text-[#8b949e]">请使用微信扫一扫，支付后自动跳转</p>
                <button
                  onClick={async () => { await fetch(`${API}/api/orders/${qr.outTradeNo}/simulate`, { method: 'POST' }); }}
                  className="mt-3 text-xs text-[#6e7681] underline"
                >（沙箱）模拟支付成功</button>
              </>
            )}
            <button onClick={() => setQr(null)} className="mt-4 text-xs text-[#8b949e] hover:text-[#e6edf3]">关闭</button>
          </div>
        </div>
      )}

      <footer className="mx-auto max-w-5xl px-6 py-8 text-xs text-[#8b949e]">
        <div className="flex items-start gap-2 rounded-md border border-[#30363d] bg-[#161b22] p-3">
          <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-[#4bd3b2]" />
          <span>
            本工作室营业执照载明的经营场所为<strong className="text-[#e6edf3]">抖音平台</strong>
            （抖音主页：
            <a href="https://i.douyin.com/zGbYLtOOrKo/" target="_blank" rel="noreferrer" className="break-all text-[#4bd3b2] underline">
              i.douyin.com/zGbYLtOOrKo
            </a>
            ）。本网站仅作为设计作品展示与服务预约渠道，实际服务沟通、下单与交付以抖音平台为准。
          </span>
        </div>
        <div className="mt-3 text-center">© 宁乡市鸣鸣创意信息技术服务工作室 · 92430182MAKM6RRM1E</div>
      </footer>
    </div>
  );
}
