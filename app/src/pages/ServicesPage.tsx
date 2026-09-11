import { Link } from 'react-router-dom';
import { Check, PenTool, MessageCircle, Sparkles, Camera, FileText, Music, Image as ImageIcon, MapPin } from 'lucide-react';

/**
 * 支付宝商户号申请 · "商品/服务页"素材
 * - 独立路由 /services，列出三档服务包（与订阅档位语义一致）
 * - 服务严格对应营业执照经营范围：专业设计服务 / 信息技术咨询服务 / 数字内容制作服务（不含出版发行）
 * - 经营场所：抖音平台，本网站为展示与预约渠道
 */
export default function ServicesPage() {
  const tiers = [
    {
      name: '基础包',
      tag: '个人尝鲜',
      price: '¥18 / 月',
      points: ['单类设计服务（海报 / 修图 / 插画三选一）', '基础数字内容制作咨询', '7×12 小时工单响应'],
    },
    {
      name: '专业包',
      tag: '最受欢迎',
      price: '¥168 / 年',
      points: ['设计 + 咨询 + 数字内容三类服务', '短视频剪辑 / 音频处理任选', '一对一创作方案咨询', '优先交付排期'],
      highlight: true,
    },
    {
      name: '工作室包',
      tag: '深度合作',
      price: '¥398 一次性',
      points: ['专业包全部服务', '数字内容综合服务包（一次性）', '多项目整体视觉规划', '专属交付沟通'],
    },
  ];
  const services = [
    { icon: PenTool, title: '专业设计服务', desc: '品牌视觉、活动主视觉、海报与详情页设计、产品图修图与平面物料。' },
    { icon: MessageCircle, title: '信息技术咨询', desc: '数字内容工具选型、个人素材整理方案、创作工作流建议与一对一咨询。' },
    { icon: Sparkles, title: '数字内容制作', desc: '图片精修、短视频剪辑、音频处理、数字插画与 3D 概念图制作（不含出版发行）。' },
  ];
  const works = [
    { icon: ImageIcon, name: '平面设计', desc: '海报、主视觉、品牌物料' },
    { icon: Camera, name: '视频制作', desc: '短视频剪辑、产品展示' },
    { icon: Music, name: '音频处理', desc: '配乐剪辑、音效处理' },
    { icon: FileText, name: '数字插画', desc: '插画、3D 概念图' },
  ];
  return (
    <div className="min-h-screen bg-[#0d1117] text-[#e6edf3]">
      {/* 顶部导航（与首页一致） */}
      <header className="sticky top-0 z-30 border-b border-[#21262d] bg-[#0d1117]/85 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
          <Link to="/landing" className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-[#4bd3b2] to-[#1f7a6c] text-xs font-bold text-black">鸣</div>
            <div className="text-sm font-semibold">鸣鸣创意 · 设计 / 咨询 / 数字内容</div>
          </Link>
          <nav className="flex items-center gap-5 text-sm text-[#8b949e]">
            <Link to="/landing" className="hover:text-[#e6edf3]">首页</Link>
            <Link to="/services" className="text-[#e6edf3]">服务</Link>
            <Link to="/subscribe" className="hover:text-[#e6edf3]">订阅</Link>
          </nav>
          <Link to="/subscribe" className="rounded-md bg-[#4bd3b2] px-3 py-1.5 text-xs font-medium text-black hover:brightness-110">
            预约服务
          </Link>
        </div>
      </header>

      {/* 标题 */}
      <section className="mx-auto max-w-5xl px-6 py-12 text-center">
        <h1 className="text-3xl font-bold">服务 & 服务包</h1>
        <p className="mt-3 text-sm text-[#8b949e]">按需选择服务包，所有服务均支持 7 天无理由协商退费</p>
      </section>

      {/* 服务列表（三类） */}
      <section className="mx-auto max-w-5xl px-6 pb-10">
        <h2 className="mb-4 text-lg font-semibold">我们提供的服务</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {services.map((s) => (
            <div key={s.title} className="rounded-xl border border-[#21262d] bg-[#161b22] p-4">
              <s.icon className="mb-2 text-[#4bd3b2]" size={20} />
              <div className="text-sm font-medium">{s.title}</div>
              <div className="mt-1 text-xs leading-relaxed text-[#8b949e]">{s.desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* 成品示例 */}
      <section className="mx-auto max-w-5xl px-6 pb-10">
        <h2 className="mb-4 text-lg font-semibold">可承接的成品类型</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {works.map((w) => (
            <div key={w.name} className="rounded-xl border border-[#21262d] bg-[#161b22] p-4">
              <w.icon className="mb-2 text-[#4bd3b2]" size={20} />
              <div className="text-sm font-medium">{w.name}</div>
              <div className="mt-1 text-xs text-[#8b949e]">{w.desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* 套餐档位 */}
      <section className="mx-auto max-w-5xl px-6 py-6">
        <h2 className="mb-4 text-lg font-semibold">服务包</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {tiers.map((t) => (
            <div
              key={t.name}
              className={`relative rounded-xl border p-5 ${
                t.highlight
                  ? 'border-[#4bd3b2] bg-[#0d1117] shadow-[0_0_0_1px_rgba(75,211,178,0.25)]'
                  : 'border-[#21262d] bg-[#161b22]'
              }`}
            >
              {t.tag && (
                <div className={`mb-2 inline-block rounded-full px-2 py-0.5 text-[10px] ${
                  t.highlight ? 'bg-[#4bd3b2]/15 text-[#4bd3b2]' : 'bg-[#21262d] text-[#8b949e]'
                }`}>
                  {t.tag}
                </div>
              )}
              <div className="text-base font-semibold">{t.name}</div>
              <div className="mt-1 text-lg font-bold text-[#4bd3b2]">{t.price}</div>
              <ul className="mt-3 space-y-1.5 text-xs text-[#8b949e]">
                {t.points.map((p) => (
                  <li key={p} className="flex items-start gap-1.5">
                    <Check size={12} className="mt-0.5 shrink-0 text-[#4bd3b2]" />
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
              <Link
                to="/subscribe"
                className={`mt-4 block rounded-md px-3 py-1.5 text-center text-xs font-medium ${
                  t.highlight
                    ? 'bg-[#4bd3b2] text-black hover:brightness-110'
                    : 'border border-[#30363d] text-[#e6edf3] hover:border-[#4bd3b2]'
                }`}
              >
                选择此服务包
              </Link>
            </div>
          ))}
        </div>
      </section>

      {/* 经营场所声明 */}
      <section className="mx-auto max-w-5xl px-6 pb-10">
        <div className="flex items-start gap-2 rounded-xl border border-[#21262d] bg-[#0d1117] p-4 text-[11px] leading-relaxed text-[#8b949e]">
          <MapPin size={14} className="mt-0.5 shrink-0 text-[#4bd3b2]" />
          <span className="whitespace-normal">
            本工作室营业执照载明的经营场所为
            <strong className="text-[#e6edf3]">抖音平台</strong>
            （抖音主页：
            <a href="https://i.douyin.com/zGbYLtOOrKo/" target="_blank" rel="noreferrer" className="break-all text-[#4bd3b2] underline">
              i.douyin.com/zGbYLtOOrKo
            </a>
            ）。本网站仅作为设计作品展示与服务预约渠道，实际服务沟通、下单与交付以抖音平台为准。
          </span>
        </div>
      </section>

      <footer className="border-t border-[#21262d] py-6 text-center text-[11px] text-[#6e7681]">
        © 2026 宁乡市鸣鸣创意信息技术服务工作室（个体工商户） · 统一社会信用代码 92430182MAKM6RRM1E
      </footer>
    </div>
  );
}
