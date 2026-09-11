import { useEffect, useState } from 'react';

/**
 * 订阅流程演示（序列帧，零侵入装饰器）
 * - 打开即自动循环：纯展示"选套餐→订阅中→已开通"流程动画
 * - 不使用蓝色高亮边框（避免与真实选中态混淆），改用扫描线/脉冲提示
 * - 纯前端模拟，不发任何 API
 * - 由订阅页 <PricingDemo /> 渲染（「立即订阅」按钮下方）
 */

const PLANS = [
  { id: 'monthly', name: '月度', price: '¥18' },
  { id: 'yearly', name: '年度', price: '¥168', tag: '省 22%' },
  { id: 'lifetime', name: '永久授权', price: '¥398', tag: '一次性' },
];

const FRAME_MS = 1500;
const TOTAL_FRAMES = PLANS.length + 2; // 选完后的"订阅中"帧 + "已开通"帧

export default function PricingDemo() {
  // frame: 0..PLANS.length-1 指向被演示的套餐（仅作为流程指示，不修改真实选中）；
  //        =PLANS.length 订阅中；=PLANS.length+1 已开通
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % TOTAL_FRAMES);
    }, FRAME_MS);
    return () => clearInterval(id);
  }, []);

  const focusIdx = frame < PLANS.length ? frame : -1;
  const isSubscribing = frame === PLANS.length;
  const isActive = frame === PLANS.length + 1;

  return (
    <div className="w-full rounded-2xl border border-[#21262d] bg-[#0d1117] p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#8b949e]">
          <span className="h-2 w-2 animate-pulse rounded-full bg-[#6e7681]" />
          订阅流程演示（自动循环 · 不影响上方选择）
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {PLANS.map((plan, i) => {
          const focused = focusIdx === i;
          return (
            <div
              key={plan.id}
              className={`relative overflow-hidden rounded-xl border p-3 text-center transition-all duration-500 ${
                focused ? 'border-[#30363d] bg-[#161b22]' : 'border-[#21262d] opacity-70'
              }`}
            >
              {/* 仅用扫描线提示，不抢真实选中态的蓝色高亮 */}
              {focused && (
                <span
                  className="pointer-events-none absolute inset-0"
                  style={{
                    background:
                      'linear-gradient(90deg, transparent, rgba(0,212,170,0.12), transparent)',
                    backgroundSize: '200% 100%',
                    animation: 'demoScan 1.4s linear infinite',
                  }}
                />
              )}
              <div className="relative text-sm font-medium text-[#e6edf3]">{plan.name}</div>
              <div className="relative mt-1 text-sm text-[#8b949e]">{plan.price}</div>
              {plan.tag && <div className="relative mt-1 text-[10px] text-[#6e7681]">{plan.tag}</div>}
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex h-6 items-center justify-center text-xs">
        {isSubscribing ? (
          <span className="inline-flex items-center gap-2 text-[#8b949e]">
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#6e7681] border-t-transparent" />
            正在创建订单并确认订阅状态…
          </span>
        ) : isActive ? (
          <span className="inline-flex items-center gap-1.5 font-medium text-[#4bd3b2]">
            ✓ 订阅成功，已开通采集权限
          </span>
        ) : (
          <span className="text-[#6e7681]">演示：推荐「{PLANS[focusIdx]?.name}」→ 发起订阅…</span>
        )}
      </div>
    </div>
  );
}
