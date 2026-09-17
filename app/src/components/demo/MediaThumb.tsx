import { useEffect, useMemo, useState } from 'react';

/**
 * 媒体类型专属缩略图渲染器（零侵入装饰器）
 * - 按 kind 渲染代码生成的视觉表征：UI 截图 / 视频帧 / 音频波动带 / 3D 模型 / Banner / 插画
 * - 颜色基于 seed 决定（HSL 渐变），保证视觉丰富
 * - 音频类型有动态均衡器动效
 * - 纯前端模拟，不发任何请求
 */

type Kind = 'banner' | 'video' | 'product' | 'ui' | 'audio' | 'model' | 'art';

const KIND_ICON: Record<Kind, string> = {
  banner: '🖼',
  video: '🎬',
  product: '🛒',
  ui: '📱',
  audio: '🎵',
  model: '📦',
  art: '🎨',
};

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function KindBadge({ kind, label }: { kind: Kind; label: string }) {
  return (
    <div className="absolute left-1 top-1 z-10 flex items-center gap-1 rounded bg-black/55 px-1 text-[9px] text-white backdrop-blur-sm">
      <span>{KIND_ICON[kind]}</span>
      <span className="uppercase tracking-wide">{kind}</span>
    </div>
  );
}

export function LabelBar({ label }: { label: string }) {
  return (
    <div className="absolute inset-x-0 bottom-0 z-10 truncate bg-gradient-to-t from-black/85 via-black/50 to-transparent px-1.5 py-1 text-[9px] text-white">
      {label}
    </div>
  );
}

/* ---------- 1. UI 截图模拟 ---------- */
function UiMock({ hue }: { hue: number }) {
  // 伪随机 UI 元素（基于 hue 决定布局）
  const r = hash(String(hue));
  const navItems = ['首页', '文档', '博客', '关于'].slice(0, 2 + (r % 3));
  return (
    <div className="absolute inset-0 p-1.5 text-white">
      {/* 标题栏 */}
      <div className="flex items-center gap-0.5 border-b border-white/20 pb-0.5">
        <div className="h-1.5 w-1.5 rounded-full bg-red-400" />
        <div className="h-1.5 w-1.5 rounded-full bg-yellow-400" />
        <div className="h-1.5 w-1.5 rounded-full bg-green-400" />
        <div className="ml-1 h-1 flex-1 rounded bg-white/20" />
      </div>
      {/* 导航 */}
      <div className="mt-1 flex items-center gap-1 text-[7px] font-semibold">
        <div className="rounded bg-white/30 px-1 py-0.5">APP</div>
        {navItems.map((n, i) => (
          <span key={i} className="text-white/80">{n}</span>
        ))}
      </div>
      {/* Hero */}
      <div className="mt-1 rounded bg-white/15 p-1">
        <div className="h-1 w-3/4 rounded bg-white/80" />
        <div className="mt-0.5 h-0.5 w-1/2 rounded bg-white/50" />
        <div className="mt-1 h-3 w-12 rounded-sm bg-white" />
      </div>
      {/* 卡片列表 */}
      <div className="mt-1 grid grid-cols-2 gap-0.5">
        {[0, 1].map((i) => (
          <div key={i} className="rounded bg-white/10 p-0.5">
            <div className="h-4 rounded-sm bg-white/30" />
            <div className="mt-0.5 h-0.5 w-3/4 rounded bg-white/60" />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- 2. Banner 模拟 ---------- */
function BannerMock({ hue, label }: { hue: number; label: string }) {
  const r = hash(label);
  return (
    <div className="absolute inset-0 p-2 text-white">
      {/* 装饰圆 */}
      <div
        className="absolute -right-2 -top-2 h-10 w-10 rounded-full"
        style={{ background: `hsla(${(hue + 60) % 360} 80% 70% / 0.5)` }}
      />
      <div
        className="absolute -bottom-1 left-4 h-6 w-6 rounded-full"
        style={{ background: `hsla(${(hue + 120) % 360} 80% 70% / 0.4)` }}
      />
      {/* 标题 */}
      <div className="relative">
        <div className="text-[8px] uppercase tracking-widest text-white/70">
          {r % 2 === 0 ? 'NEW ARRIVAL' : 'LIMITED OFFER'}
        </div>
        <div className="mt-0.5 h-1.5 w-3/4 rounded bg-white" />
        <div className="mt-0.5 h-1 w-1/2 rounded bg-white/80" />
        <div className="mt-1.5 h-3 w-10 rounded-sm bg-white text-center text-[7px] font-bold leading-3 text-black/80">
          SHOP
        </div>
      </div>
    </div>
  );
}

/* ---------- 3. 视频帧模拟 ---------- */
function VideoMock({ hue, label }: { hue: number; label?: string }) {
  const r = hash(String(hue) + (label || ''));
  const secs = 12 + (r % 200);
  return (
    <div className="absolute inset-0 z-[6]">
      {/* 中心播放按钮（半透明 + 投影，叠在场景之上） */}
      <div className="absolute left-1/2 top-1/3 flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white/75 shadow-[0_2px_4px_rgba(0,0,0,0.5)] backdrop-blur-sm">
        <div
          className="ml-0.5 border-y-[4px] border-l-[6px] border-y-transparent"
          style={{ borderLeftColor: `hsl(${hue} 70% 40%)` }}
        />
      </div>
      {/* 进度条 + 时长 */}
      <div className="absolute inset-x-1 bottom-2 z-[7]">
        <div className="h-0.5 w-full rounded-full bg-white/40">
          <div
            className="h-0.5 rounded-full bg-white"
            style={{ width: `${30 + (r % 50)}%` }}
          />
        </div>
        <div className="mt-0.5 text-right text-[8px] font-mono text-white drop-shadow">
          0:{String(secs).padStart(3, '0')}
        </div>
      </div>
    </div>
  );
}

/* ---------- 4. 音频波动带（动态均衡器） ---------- */
function AudioMock({ hue }: { hue: number }) {
  // 18 条动态高度条
  const seed = useMemo(() => hash(String(hue)), [hue]);
  const baseHeights = useMemo(
    () => Array.from({ length: 18 }, (_, i) => 30 + ((seed * (i + 1)) % 70)),
    [seed],
  );
  const [t, setT] = useState(0);
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = now - last;
      last = now;
      setT((v) => v + dt * 0.005);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="absolute inset-0 flex items-center justify-center px-1.5">
      <div className="flex h-8 w-full items-end justify-between gap-[1px]">
        {baseHeights.map((base, i) => {
          // 4 个相位叠加形成波动
          const wave =
            Math.sin(t + i * 0.4) * 0.4 +
            Math.sin(t * 1.7 + i * 0.6) * 0.3 +
            Math.sin(t * 2.3 + i * 0.2) * 0.3;
          const h = Math.max(8, Math.min(100, base + wave * 35));
          return (
            <span
              key={i}
              className="block w-[3px] rounded-sm"
              style={{
                height: `${h}%`,
                background: `linear-gradient(180deg, hsl(${hue} 90% 75%), hsl(${(hue + 30) % 360} 80% 50%))`,
                boxShadow: `0 0 4px hsla(${hue} 90% 60% / 0.5)`,
                transition: 'height 60ms linear',
              }}
            />
          );
        })}
      </div>
      {/* 频率标识线 */}
      <div className="pointer-events-none absolute inset-x-2 top-1/2 h-px bg-white/15" />
    </div>
  );
}

/* ---------- 5. 3D 模型模拟 ---------- */
function ModelMock({ hue }: { hue: number }) {
  return (
    <div className="absolute inset-0 overflow-hidden" style={{ perspective: '120px' }}>
      {/* 网格地面（透视旋转台） */}
      <div
        className="absolute inset-0 opacity-50"
        style={{
          backgroundImage: `linear-gradient(hsla(${hue} 80% 80% / 0.5) 1px, transparent 1px),
                            linear-gradient(90deg, hsla(${hue} 80% 80% / 0.5) 1px, transparent 1px)`,
          backgroundSize: '8px 8px',
          backgroundPosition: 'center',
          transform: 'perspective(60px) rotateX(55deg) translateY(18px)',
          transformOrigin: 'center',
        }}
      />
      {/* 3D 物体：立方体（6 个面），持续 Y 轴旋转 */}
      <div
        className="absolute left-1/2 top-1/2 h-8 w-8"
        style={{
          transformStyle: 'preserve-3d',
          animation: 'demoSpin3d 6s linear infinite',
        }}
      >
        <div
          className="absolute inset-0"
          style={{
            background: `hsl(${hue} 70% 62%)`,
            transform: `rotateY(0deg) translateZ(16px)`,
            boxShadow: 'inset 0 0 5px rgba(0,0,0,0.4)',
          }}
        />
        <div
          className="absolute inset-0"
          style={{
            background: `hsl(${(hue + 25) % 360} 70% 52%)`,
            transform: `rotateY(90deg) translateZ(16px)`,
            boxShadow: 'inset 0 0 5px rgba(0,0,0,0.4)',
          }}
        />
        <div
          className="absolute inset-0"
          style={{
            background: `hsl(${(hue + 305) % 360} 70% 42%)`,
            transform: `rotateY(-90deg) translateZ(16px)`,
            boxShadow: 'inset 0 0 5px rgba(0,0,0,0.4)',
          }}
        />
        <div
          className="absolute inset-0"
          style={{
            background: `hsl(${(hue + 180) % 360} 60% 45%)`,
            transform: `rotateY(180deg) translateZ(16px)`,
            boxShadow: 'inset 0 0 5px rgba(0,0,0,0.4)',
          }}
        />
        {/* 顶面 */}
        <div
          className="absolute inset-0"
          style={{
            background: `hsl(${hue} 75% 72%)`,
            transform: `rotateX(90deg) translateZ(16px)`,
            boxShadow: 'inset 0 0 5px rgba(0,0,0,0.3)',
          }}
        />
        {/* 底面 */}
        <div
          className="absolute inset-0"
          style={{
            background: `hsl(${hue} 60% 30%)`,
            transform: `rotateX(-90deg) translateZ(16px)`,
          }}
        />
      </div>
      {/* 阴影 */}
      <div
        className="absolute left-1/2 bottom-3 h-2 w-12 -translate-x-1/2 rounded-full bg-black/40 blur-[2px]"
      />
      {/* 旋转指示环 */}
      <div className="absolute right-1 top-1.5 flex h-3 w-3 items-center justify-center rounded-full bg-white/20">
        <div className="absolute h-px w-3 bg-red-400" />
        <div className="absolute h-3 w-px bg-green-400" />
        <div className="absolute h-px w-3 -rotate-45 bg-blue-400" />
      </div>
      {/* 旋转提示 */}
      <div className="absolute left-1 bottom-1 rounded bg-black/45 px-1 text-[8px] text-white/80">
        ⟳ 360°
      </div>
    </div>
  );
}

/* ---------- 6. 插画（几何构图） ---------- */
function ArtMock({ hue, label }: { hue: number; label: string }) {
  const r = hash(label);
  return (
    <div className="absolute inset-0 overflow-hidden">
      <div
        className="absolute -right-2 -top-2 h-8 w-8 rounded-full"
        style={{ background: `hsl(${(hue + 60) % 360} 80% 65%)` }}
      />
      <div
        className="absolute -bottom-1 -left-2 h-10 w-10 rotate-45"
        style={{ background: `hsl(${(hue + 180) % 360} 80% 55%)` }}
      />
      <div
        className="absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-sm"
        style={{ background: `hsl(${hue} 80% 75%)` }}
      />
      {r % 2 === 0 && (
        <div
          className="absolute right-3 bottom-3 h-3 w-3 rounded-full"
          style={{ background: `hsl(${(hue + 90) % 360} 80% 60%)` }}
        />
      )}
    </div>
  );
}

/* ---------- 7. 商品（产品卡）---------- */
function ProductMock({ hue }: { hue: number }) {
  return (
    <div className="absolute inset-0 p-1.5 text-white">
      <div className="flex h-full gap-1">
        <div
          className="h-full w-2/3 rounded-sm"
          style={{ background: `hsl(${(hue + 40) % 360} 60% 40%)` }}
        />
        <div className="flex flex-1 flex-col justify-between">
          <div>
            <div className="h-1 w-full rounded bg-white/80" />
            <div className="mt-0.5 h-0.5 w-2/3 rounded bg-white/50" />
          </div>
          <div>
            <div className="text-[9px] font-bold">¥{(19 + (hue % 300))}</div>
            <div className="mt-0.5 h-2.5 rounded-sm bg-white text-center text-[7px] font-bold leading-[10px] text-black/80">
              +
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- 场景缩略图（叠加层）：video=车/山/海/太空，ui=办公/购物/社交，audio=音符/唱片，model=展台，banner=舞台，art=城市，product=货架 ---------- */
function pickVariant(seed: number, n: number) {
  return Math.abs(seed) % n;
}

function VideoScene({ hue, label }: { hue: number; label: string }) {
  const v = pickVariant(hash(label || String(hue)), 8);
  // v0: 绿皮面包车；v1: 山；v2: 海/日落；v3: 太空；v4: 城市天际线；v5: 飞机；v6: 船舶；v7: 人物剪影
  const carColor = `hsl(${(hue + 90) % 360} 60% 35%)`;
  const carHi = `hsl(${(hue + 90) % 360} 60% 55%)`;
  return (
    <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden">
      {/* 地面阴影 */}
      <div className="absolute inset-x-0 bottom-0 h-1.5 bg-black/40" />
      {v === 0 && (
        /* 绿皮面包车 */
        <svg viewBox="0 0 100 100" className="absolute inset-x-0 bottom-0 h-3/4 w-full">
          {/* 阴影 */}
          <ellipse cx="50" cy="84" rx="38" ry="3" fill="rgba(0,0,0,0.45)" />
          {/* 车身主体 */}
          <path
            d="M14 70 L14 50 Q14 32 32 28 L66 28 Q82 28 84 50 L84 70 L78 70 Q78 76 70 76 Q62 76 62 70 L36 70 Q36 76 28 76 Q20 76 20 70 Z"
            fill={carColor}
            stroke="#000"
            strokeWidth="0.6"
          />
          {/* 车身高光 */}
          <path
            d="M18 50 Q18 36 32 32 L64 32 L64 50 Z"
            fill={carHi}
            opacity="0.45"
          />
          {/* 前挡风 */}
          <path
            d="M30 30 L52 30 L48 48 L30 48 Z"
            fill="#dff"
            opacity="0.55"
            stroke="#000"
            strokeWidth="0.4"
          />
          {/* 中窗 */}
          <path
            d="M52 30 L62 30 L62 48 L50 48 Z"
            fill="#dff"
            opacity="0.55"
            stroke="#000"
            strokeWidth="0.4"
          />
          {/* 后窗 */}
          <path
            d="M64 30 L78 32 Q80 32 80 40 L80 48 L64 48 Z"
            fill="#dff"
            opacity="0.45"
            stroke="#000"
            strokeWidth="0.4"
          />
          {/* 车灯 */}
          <rect x="14" y="56" width="6" height="3" fill="#ff3" stroke="#000" strokeWidth="0.3" />
          <rect x="80" y="56" width="4" height="3" fill="#f55" stroke="#000" strokeWidth="0.3" />
          {/* 进气格栅 */}
          <rect x="14" y="64" width="12" height="3" fill="#111" />
          {/* 车门线 */}
          <line x1="52" y1="50" x2="52" y2="70" stroke="#000" strokeWidth="0.5" />
          <line x1="64" y1="50" x2="64" y2="70" stroke="#000" strokeWidth="0.5" />
          {/* 门把手 */}
          <rect x="55" y="58" width="2" height="0.8" fill="#000" />
          <rect x="67" y="58" width="2" height="0.8" fill="#000" />
          {/* 后视镜 */}
          <rect x="30" y="34" width="2" height="3" fill="#000" />
          {/* 轮毂 */}
          <circle cx="28" cy="76" r="6" fill="#111" stroke="#000" strokeWidth="0.5" />
          <circle cx="28" cy="76" r="2.2" fill="#999" />
          <circle cx="70" cy="76" r="6" fill="#111" stroke="#000" strokeWidth="0.5" />
          <circle cx="70" cy="76" r="2.2" fill="#999" />
          {/* 车牌 */}
          <rect x="14" y="68" width="10" height="3" fill="#eee" stroke="#000" strokeWidth="0.3" />
          <text x="19" y="70.5" textAnchor="middle" fontSize="2" fontWeight="700" fill="#000">A001</text>
        </svg>
      )}
      {v === 1 && (
        /* 山 */
        <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full">
          <circle cx="78" cy="22" r="10" fill="#ffd66b" />
          <path d="M0 80 L30 45 L48 65 L70 35 L100 75 L100 100 L0 100 Z" fill="rgba(0,0,0,0.4)" />
          <path d="M0 80 L30 45 L48 65 L70 35 L100 75 L100 100 L0 100 Z" fill="none" stroke="#fff" strokeWidth="0.3" />
        </svg>
      )}
      {v === 2 && (
        /* 海/日落 */
        <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full">
          <circle cx="50" cy="40" r="14" fill="#ffb14a" />
          <rect x="0" y="50" width="100" height="50" fill="rgba(0,0,0,0.5)" />
          <line x1="0" y1="60" x2="100" y2="60" stroke="#fff" strokeWidth="0.3" opacity="0.4" />
          <line x1="0" y1="68" x2="100" y2="68" stroke="#fff" strokeWidth="0.3" opacity="0.3" />
          <line x1="0" y1="76" x2="100" y2="76" stroke="#fff" strokeWidth="0.3" opacity="0.2" />
        </svg>
      )}
      {v === 3 && (
        /* 太空 */
        <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full">
          {Array.from({ length: 14 }).map((_, i) => (
            <circle
              key={i}
              cx={(i * 17) % 100}
              cy={(i * 23) % 100}
              r={(i % 3) * 0.3 + 0.4}
              fill="#fff"
              opacity={0.4 + (i % 4) * 0.15}
            />
          ))}
          <circle cx="50" cy="55" r="14" fill="rgba(0,0,0,0.55)" stroke="#fff" strokeWidth="0.5" />
          <ellipse cx="50" cy="55" rx="22" ry="4" fill="none" stroke="#fff" strokeWidth="0.5" opacity="0.7" />
        </svg>
      )}
      {v === 4 && (
        /* 城市天际线 */
        <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full">
          <rect x="6" y="50" width="14" height="34" fill="rgba(0,0,0,0.5)" />
          <rect x="22" y="38" width="10" height="46" fill="rgba(0,0,0,0.55)" />
          <rect x="34" y="46" width="12" height="38" fill="rgba(0,0,0,0.5)" />
          <rect x="48" y="30" width="14" height="54" fill="rgba(0,0,0,0.6)" />
          <rect x="64" y="42" width="10" height="42" fill="rgba(0,0,0,0.5)" />
          <rect x="76" y="48" width="18" height="36" fill="rgba(0,0,0,0.55)" />
          {/* 窗 */}
          {Array.from({ length: 30 }).map((_, i) => (
            <rect
              key={i}
              x={6 + (i * 7) % 90}
              y={32 + ((i * 11) % 50)}
              width="1.5"
              height="1.5"
              fill="#ffd66b"
              opacity={0.4 + (i % 3) * 0.2}
            />
          ))}
        </svg>
      )}
      {v === 5 && (
        /* 飞机（侧视） */
        <svg viewBox="0 0 100 100" className="absolute inset-x-0 top-1/3 h-1/2 w-full">
          {/* 机身 */}
          <path
            d="M8 50 Q30 44 55 46 L80 46 Q90 47 92 50 Q90 53 80 54 L55 54 Q30 56 8 50 Z"
            fill={`hsl(${(hue + 90) % 360} 60% 70%)`}
            stroke="#000"
            strokeWidth="0.5"
          />
          {/* 主翼 */}
          <path d="M44 50 L52 50 L40 66 L34 66 Z" fill={`hsl(${(hue + 90) % 360} 60% 55%)`} stroke="#000" strokeWidth="0.4" />
          <path d="M44 50 L52 50 L60 36 L54 36 Z" fill={`hsl(${(hue + 90) % 360} 60% 55%)`} stroke="#000" strokeWidth="0.4" />
          {/* 尾翼 */}
          <path d="M10 50 L16 50 L12 40 L8 40 Z" fill={`hsl(${(hue + 90) % 360} 60% 50%)`} stroke="#000" strokeWidth="0.4" />
          <path d="M10 50 L16 50 L14 58 L10 58 Z" fill={`hsl(${(hue + 90) % 360} 60% 50%)`} stroke="#000" strokeWidth="0.4" />
          {/* 舷窗 */}
          {[28, 36, 44, 52].map((x) => (
            <circle key={x} cx={x} cy="49" r="1.2" fill="#001" opacity="0.6" />
          ))}
          {/* 引擎 */}
          <circle cx="60" cy="52" r="2" fill="#222" stroke="#000" strokeWidth="0.3" />
          {/* 云 */}
          <ellipse cx="20" cy="30" rx="8" ry="2.5" fill="#fff" opacity="0.5" />
          <ellipse cx="70" cy="22" rx="10" ry="3" fill="#fff" opacity="0.4" />
        </svg>
      )}
      {v === 6 && (
        /* 船舶 */
        <svg viewBox="0 0 100 100" className="absolute inset-x-0 bottom-0 h-2/3 w-full">
          {/* 海面 */}
          <rect x="0" y="62" width="100" height="38" fill={`hsl(${(hue + 200) % 360} 70% 45%)`} opacity="0.7" />
          <path d="M0 62 Q10 60 20 62 T40 62 T60 62 T80 62 T100 62" fill="none" stroke="#fff" strokeWidth="0.4" opacity="0.4" />
          {/* 船体 */}
          <path d="M18 62 L82 62 L74 78 L26 78 Z" fill={`hsl(${(hue + 30) % 360} 55% 40%)`} stroke="#000" strokeWidth="0.5" />
          {/* 甲板建筑 */}
          <rect x="34" y="48" width="32" height="14" fill={`hsl(${(hue + 30) % 360} 55% 55%)`} stroke="#000" strokeWidth="0.4" />
          <rect x="38" y="42" width="10" height="6" fill={`hsl(${(hue + 30) % 360} 55% 65%)`} stroke="#000" strokeWidth="0.4" />
          {/* 烟囱 */}
          <rect x="56" y="40" width="6" height="8" fill="#333" stroke="#000" strokeWidth="0.3" />
          <circle cx="59" cy="39" r="2" fill="#999" opacity="0.6" />
          {/* 窗 */}
          {[38, 44, 50, 56, 62].map((x) => (
            <rect key={x} x={x} y="50" width="3" height="3" fill="#ffe" opacity="0.7" />
          ))}
        </svg>
      )}
      {v === 7 && (
        /* 人物剪影 */
        <svg viewBox="0 0 100 100" className="absolute inset-x-0 bottom-0 h-3/4 w-full">
          {/* 地面 */}
          <rect x="0" y="82" width="100" height="18" fill="rgba(0,0,0,0.35)" />
          {/* 人物 */}
          <g fill={`hsl(${hue} 30% 25%)`}>
            {/* 头 */}
            <circle cx="50" cy="30" r="8" />
            {/* 身体 */}
            <path d="M38 40 Q38 36 42 40 L42 60 L58 60 L58 40 Q62 36 62 40 L60 72 L40 72 Z" />
            {/* 手臂 */}
            <path d="M40 44 L30 58 L34 60 L42 50 Z" />
            <path d="M60 44 L70 58 L66 60 L58 50 Z" />
            {/* 腿 */}
            <path d="M42 72 L40 90 L46 90 L48 74 Z" />
            <path d="M58 72 L60 90 L54 90 L52 74 Z" />
          </g>
          {/* 影子 */}
          <ellipse cx="50" cy="90" rx="16" ry="2.5" fill="rgba(0,0,0,0.4)" />
        </svg>
      )}
    </div>
  );
}

function UiScene({ hue }: { hue: number; label?: string }) {
  const v = pickVariant(hue, 3);
  return (
    <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden opacity-40">
      {v === 0 && (
        /* 办公：笔记本 */
        <svg viewBox="0 0 100 100" className="absolute bottom-0 right-0 h-2/3 w-2/3">
          <rect x="20" y="40" width="60" height="36" fill="#2a2f3a" stroke="#000" strokeWidth="0.4" />
          <rect x="24" y="44" width="52" height="28" fill="#6cc" opacity="0.7" />
          <rect x="14" y="76" width="72" height="4" fill="#1a1d24" />
          <rect x="40" y="40" width="20" height="2" fill="#1a1d24" />
        </svg>
      )}
      {v === 1 && (
        /* 购物：购物袋 */
        <svg viewBox="0 0 100 100" className="absolute bottom-1 right-1 h-3/4 w-3/4">
          <path d="M25 35 L75 35 L70 80 L30 80 Z" fill={`hsl(${(hue + 20) % 360} 60% 45%)`} stroke="#000" strokeWidth="0.4" />
          <path d="M38 35 Q38 22 50 22 Q62 22 62 35" stroke="#000" strokeWidth="1" fill="none" />
        </svg>
      )}
      {v === 2 && (
        /* 社交：消息气泡 */
        <svg viewBox="0 0 100 100" className="absolute bottom-1 right-1 h-2/3 w-2/3">
          <path d="M10 25 Q10 15 20 15 L60 15 Q70 15 70 25 L70 45 Q70 55 60 55 L30 55 L20 65 L22 55 Q10 55 10 45 Z" fill="#fff" opacity="0.85" />
          <circle cx="30" cy="35" r="2" fill="#000" />
          <circle cx="40" cy="35" r="2" fill="#000" />
          <circle cx="50" cy="35" r="2" fill="#000" />
        </svg>
      )}
    </div>
  );
}

function AudioScene({ hue, label }: { hue: number; label: string }) {
  const v = pickVariant(hash(label || String(hue)), 3);
  return (
    <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden opacity-30">
      {v === 0 && (
        /* 黑胶唱片 */
        <svg viewBox="0 0 100 100" className="absolute right-1 top-2 h-2/3 w-2/3">
          <circle cx="50" cy="50" r="36" fill="#0a0a0a" />
          <circle cx="50" cy="50" r="36" fill="none" stroke="#222" strokeWidth="0.4" />
          {Array.from({ length: 5 }).map((_, i) => (
            <circle key={i} cx="50" cy="50" r={30 - i * 5} fill="none" stroke="#333" strokeWidth="0.2" />
          ))}
          <circle cx="50" cy="50" r="8" fill={`hsl(${hue} 70% 45%)`} />
          <circle cx="50" cy="50" r="1.5" fill="#000" />
        </svg>
      )}
      {v === 1 && (
        /* 音符 */
        <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full">
          <ellipse cx="36" cy="68" rx="8" ry="6" fill="#fff" transform="rotate(-15 36 68)" />
          <rect x="42" y="36" width="2" height="32" fill="#fff" />
          <path d="M44 36 Q60 40 56 56" stroke="#fff" strokeWidth="2" fill="none" />
          <ellipse cx="70" cy="60" rx="6" ry="4.5" fill="#fff" transform="rotate(-15 70 60)" />
          <rect x="74" y="32" width="2" height="28" fill="#fff" />
        </svg>
      )}
      {v === 2 && (
        /* 麦克风 */
        <svg viewBox="0 0 100 100" className="absolute left-1/2 top-1/2 h-3/4 w-3/4 -translate-x-1/2 -translate-y-1/2">
          <rect x="40" y="22" width="20" height="32" rx="10" fill="#bbb" stroke="#000" strokeWidth="0.4" />
          <line x1="44" y1="28" x2="56" y2="28" stroke="#666" />
          <line x1="44" y1="34" x2="56" y2="34" stroke="#666" />
          <line x1="44" y1="40" x2="56" y2="40" stroke="#666" />
          <line x1="44" y1="46" x2="56" y2="46" stroke="#666" />
          <path d="M32 46 Q32 64 50 64 Q68 64 68 46" stroke="#bbb" strokeWidth="2" fill="none" />
          <line x1="50" y1="64" x2="50" y2="74" stroke="#bbb" strokeWidth="2" />
          <line x1="40" y1="76" x2="60" y2="76" stroke="#bbb" strokeWidth="2" />
        </svg>
      )}
    </div>
  );
}

function ModelScene({ hue }: { hue: number; label?: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden opacity-40">
      {/* 展台：水平圆盘 */}
      <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full">
        <ellipse cx="50" cy="80" rx="40" ry="6" fill="rgba(0,0,0,0.4)" />
        <ellipse cx="50" cy="78" rx="34" ry="4" fill={`hsl(${hue} 30% 50%)`} />
        <ellipse cx="50" cy="78" rx="34" ry="4" fill="none" stroke="#fff" strokeWidth="0.3" opacity="0.5" />
      </svg>
    </div>
  );
}

function BannerScene({ hue }: { hue: number; label?: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden opacity-50">
      {/* 舞台聚光 */}
      <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full">
        <path d="M0 0 L100 0 L80 50 L20 50 Z" fill="rgba(0,0,0,0.4)" />
        <path d="M20 0 L40 0 L36 30 L24 30 Z" fill={`hsl(${(hue + 60) % 360} 80% 70%)`} opacity="0.6" />
        <path d="M60 0 L80 0 L76 30 L64 30 Z" fill={`hsl(${(hue + 180) % 360} 80% 70%)`} opacity="0.6" />
      </svg>
    </div>
  );
}

function ArtScene({ hue }: { hue: number; label?: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden opacity-30">
      <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full">
        {/* 城市轮廓 */}
        <path d="M0 80 L0 60 L10 60 L10 45 L20 45 L20 55 L30 55 L30 40 L40 40 L40 50 L55 50 L55 30 L65 30 L65 45 L80 45 L80 55 L100 55 L100 80 Z" fill="rgba(0,0,0,0.5)" />
        <path d="M0 80 L0 70 L15 70 L15 65 L25 65 L25 72 L40 72 L40 60 L50 60 L50 70 L70 70 L70 62 L90 62 L90 72 L100 72 L100 80 Z" fill="rgba(0,0,0,0.6)" />
        {/* 月亮 */}
        <circle cx="78" cy="22" r="8" fill="#fff" opacity="0.8" />
      </svg>
    </div>
  );
}

function ProductScene({ hue }: { hue: number; label?: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden opacity-50">
      {/* 货架背板 */}
      <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full">
        <rect x="0" y="60" width="100" height="3" fill="rgba(0,0,0,0.55)" />
        <rect x="2" y="63" width="6" height="22" fill="rgba(0,0,0,0.5)" />
        <rect x="92" y="63" width="6" height="22" fill="rgba(0,0,0,0.5)" />
        {/* 灯带 */}
        <line x1="0" y1="62" x2="100" y2="62" stroke="#ffd66b" strokeWidth="0.4" />
      </svg>
    </div>
  );
}

function SceneOverlay({ kind, hue, label }: { kind: Kind; hue: number; label: string }) {
  switch (kind) {
    case 'video':
      return <VideoScene hue={hue} label={label} />;
    case 'ui':
      return <UiScene hue={hue} />;
    case 'audio':
      return <AudioScene hue={hue} label={label} />;
    case 'model':
      return <ModelScene hue={hue} />;
    case 'banner':
      return <BannerScene hue={hue} />;
    case 'art':
      return <ArtScene hue={hue} />;
    case 'product':
      return <ProductScene hue={hue} />;
  }
}

function ThumbMock({ kind, hue, label }: { kind: Kind; hue: number; label: string }) {
  switch (kind) {
    case 'ui':
      return <UiMock hue={hue} />;
    case 'banner':
      return <BannerMock hue={hue} label={label} />;
    case 'video':
      return <VideoMock hue={hue} label={label} />;
    case 'audio':
      return <AudioMock hue={hue} />;
    case 'model':
      return <ModelMock hue={hue} />;
    case 'art':
      return <ArtMock hue={hue} label={label} />;
    case 'product':
      return <ProductMock hue={hue} />;
  }
}

export default function MediaThumb({
  seed,
  kind,
  label,
  inViewport = true,
}: {
  seed: number;
  kind: string;
  label: string;
  inViewport?: boolean;
}) {
  const safeKind: Kind = ['banner', 'video', 'product', 'ui', 'audio', 'model', 'art'].includes(
    kind,
  )
    ? (kind as Kind)
    : 'ui';
  return (
    <div
      className="group relative aspect-square w-full overflow-hidden rounded border border-[#21262d]"
      style={{
        background: `linear-gradient(135deg, hsl(${seed} 70% 55%), hsl(${(seed + 40) % 360} 70% 40%))`,
        animation: 'demoPopIn 0.45s cubic-bezier(0.22, 1, 0.36, 1) both',
      }}
    >
      {inViewport && <ThumbMock kind={safeKind} hue={seed} label={label} />}
      {/* 场景缩略图（不破坏原控件，叠在色块之上） */}
      {inViewport && <SceneOverlay kind={safeKind} hue={seed} label={label} />}
      <KindBadge kind={safeKind} label={kind} />
      <LabelBar label={label} />
    </div>
  );
}
