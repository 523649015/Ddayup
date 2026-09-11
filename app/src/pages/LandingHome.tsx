import { Link } from 'react-router-dom';
import { Sparkles, PenTool, MessageCircle, Image as ImageIcon, Video, Music, FileText, ChevronRight, MapPin } from 'lucide-react';

/**
 * 支付宝商户号申请 · "网站首页"素材
 * - 独立路由 /landing，不影响现有 / (LaunchCanvasPage) 等业务逻辑
 * - 内容严格对应营业执照经营范围：专业设计服务 / 信息技术咨询服务 / 数字内容制作服务（不含出版发行）
 * - 经营场所：抖音平台（i.douyin.com/zGbYLtOOrKo），本网站为作品展示与预约渠道
 * - 顶部 nav + 业务介绍 + 服务列表（三类）+ CTA，价格页 /pricing、服务页 /services 互通
 */
export default function LandingHome() {
  // 三类业务，严格对应营业执照经营范围
  const domains = [
    {
      icon: PenTool,
      title: '专业设计服务',
      desc: '品牌视觉设计、活动主视觉、海报与详情页设计、产品图修图与平面物料制作。',
    },
    {
      icon: MessageCircle,
      title: '信息技术咨询',
      desc: '数字内容工具选型、个人素材整理方案、创作工作流建议与一对一咨询。',
    },
    {
      icon: Sparkles,
      title: '数字内容制作',
      desc: '图片精修、短视频剪辑、音频处理、数字插画与 3D 概念图制作（不含出版发行）。',
    },
  ];
  // 可展示的成品类型（仅为设计/制作产出示例，非软件功能）
  const works = [
    { icon: ImageIcon, name: '平面设计', desc: '海报、主视觉、品牌物料' },
    { icon: Video, name: '视频制作', desc: '短视频剪辑、产品展示' },
    { icon: Music, name: '音频处理', desc: '配乐剪辑、音效处理' },
    { icon: FileText, name: '数字插画', desc: '插画、3D 概念图' },
  ];
  return (
    <div className="min-h-screen bg-[#0d1117] text-[#e6edf3]">
      {/* 顶部导航（与 services / pricing 一致） */}
      <header className="sticky top-0 z-30 border-b border-[#21262d] bg-[#0d1117]/85 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
          <Link to="/landing" className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-[#4bd3b2] to-[#1f7a6c] text-xs font-bold text-black">鸣</div>
            <div className="text-sm font-semibold">鸣鸣创意 · 设计 / 咨询 / 数字内容</div>
          </Link>
          <nav className="flex items-center gap-5 text-sm text-[#8b949e]">
            <Link to="/landing" className="text-[#e6edf3]">首页</Link>
            <Link to="/services" className="hover:text-[#e6edf3]">服务</Link>
            <Link to="/subscribe" className="hover:text-[#e6edf3]">订阅</Link>
          </nav>
          <Link
            to="/subscribe"
            className="rounded-md bg-[#4bd3b2] px-3 py-1.5 text-xs font-medium text-black hover:brightness-110"
          >
            预约服务
          </Link>
        </div>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-5xl px-6 py-16 text-center">
        <div className="mb-4 inline-flex items-center gap-1.5 rounded-full border border-[#4bd3b2]/30 bg-[#4bd3b2]/10 px-3 py-1 text-[11px] text-[#4bd3b2]">
          <Sparkles size={12} /> 专业设计 · 信息技术咨询 · 数字内容制作
        </div>
        <h1 className="text-4xl font-bold leading-tight">
          用设计让创意<br />成为<span className="text-[#4bd3b2]">可见的作品</span>
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-sm text-[#8b949e]">
          宁乡市鸣鸣创意信息技术服务工作室（个体工商户）出品 · 提供专业设计服务、信息技术咨询与数字内容制作服务（不含出版发行），
          为创作者与个人提供可落地的视觉与内容方案。
        </p>
        <div className="mt-6 flex items-center justify-center gap-3">
          <Link
            to="/subscribe"
            className="rounded-md bg-[#4bd3b2] px-5 py-2 text-sm font-medium text-black hover:brightness-110"
          >
            预约服务
          </Link>
          <Link
            to="/services"
            className="rounded-md border border-[#30363d] px-5 py-2 text-sm text-[#e6edf3] hover:border-[#4bd3b2]"
          >
            查看服务 <ChevronRight size={14} className="inline" />
          </Link>
        </div>
      </section>

      {/* 三类业务 */}
      <section className="mx-auto max-w-5xl px-6 py-10">
        <h2 className="mb-6 text-center text-lg font-semibold">主营业务</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {domains.map((d) => (
            <div key={d.title} className="rounded-xl border border-[#21262d] bg-[#161b22] p-4">
              <d.icon className="mb-2 text-[#4bd3b2]" size={20} />
              <div className="text-sm font-medium">{d.title}</div>
              <div className="mt-1 text-xs leading-relaxed text-[#8b949e]">{d.desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* 成品示例 */}
      <section className="mx-auto max-w-5xl px-6 py-10">
        <h2 className="mb-6 text-center text-lg font-semibold">可承接的成品类型</h2>
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

      {/* CTA */}
      <section className="mx-auto max-w-5xl px-6 py-12 text-center">
        <div className="rounded-2xl border border-[#21262d] bg-[#161b22] p-8">
          <Sparkles className="mx-auto mb-2 text-[#4bd3b2]" size={24} />
          <h3 className="text-lg font-semibold">选择适合你的服务包</h3>
          <p className="mt-2 text-xs text-[#8b949e]">月度 ¥18 / 年度 ¥168 / 数字内容服务包（一次性）¥398</p>
          <Link
            to="/subscribe"
            className="mt-4 inline-block rounded-md bg-[#4bd3b2] px-6 py-2 text-sm font-medium text-black hover:brightness-110"
          >
            选择服务包
          </Link>
        </div>
      </section>

      {/* 经营场所声明（与营业执照一致） */}
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
