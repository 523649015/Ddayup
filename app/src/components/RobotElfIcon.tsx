import type { CSSProperties } from 'react';

interface RobotElfIconProps {
  /** 图标整体边长（像素），默认 36，与智能机器人浮窗一致 */
  size?: number;
  className?: string;
}

/**
 * 与智能机器人浮窗完全一致的精灵机器人图标（尖耳尖帽 + 眼镜 + 眨眼 + 漂浮动画）。
 * 纯展示组件，不含点击/拖拽行为，可缩放用于启动页等场景。
 */
export function RobotElfIcon({ size = 36, className = '' }: RobotElfIconProps) {
  const scale = size / 36;
  const style = {
    '--robot-elf-scale': scale,
  } as CSSProperties;

  return (
    <>
      <style>{`
        @keyframes robot-elf-blink {
          0%, 8%, 44%, 46%, 100% { transform: scaleY(0); }
          4%, 45% { transform: scaleY(1); }
        }
        @keyframes robot-elf-float {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-3px); }
        }
      `}</style>
      <div
        className={`relative flex items-center justify-center rounded-[12px] border border-white/14 bg-[linear-gradient(180deg,#3af5cc,#0ea58b)] shadow-[0_10px_24px_rgba(2,16,18,0.34)] ${className}`}
        style={{ width: size, height: size, ...style }}
      >
        <span className="pointer-events-none absolute -inset-1.5 rounded-full bg-[#00d4aa]/24 blur-md" />
        <span className="pointer-events-none absolute inset-[1px] rounded-[11px] bg-[radial-gradient(circle_at_30%_18%,rgba(255,255,255,0.86),rgba(255,255,255,0)_36%),linear-gradient(180deg,rgba(255,255,255,0.18),rgba(0,0,0,0.1))]" />
        <span
          className="pointer-events-none relative block h-[26px] w-[26px]"
          style={{ transform: `scale(${scale})`, animation: 'robot-elf-float 4.6s ease-in-out infinite' }}
        >
          <span className="absolute inset-x-1 bottom-[1px] h-[4px] rounded-full bg-[#042b2a]/18 blur-[2px]" />
          <span className="absolute left-1/2 top-[2px] h-[5px] w-[5px] -translate-x-1/2 rounded-full bg-[#fff6d5] shadow-[0_0_0_1px_rgba(4,43,42,0.08)]" />
          <span className="absolute left-1/2 top-0 h-[4px] w-[1.5px] -translate-x-1/2 rounded-full bg-[#0d6e61]" />
          <span className="absolute inset-x-[3px] top-[5px] h-[17px] rounded-[8px] bg-[linear-gradient(180deg,#fffceb,#dffef7_60%,#8be5d5)] shadow-[inset_0_-2px_5px_rgba(4,38,35,0.12)]" />
          <span className="absolute left-1/2 top-[8px] -translate-x-1/2">
            <span className="flex items-center gap-[1px] will-change-transform">
              <span className="relative flex h-[7.5px] w-[7.5px] items-center justify-center rounded-full border border-[#133243] bg-[#d7f7ff]/90 shadow-[inset_0_1px_1px_rgba(255,255,255,0.7)]">
                <span className="h-[2.25px] w-[2.25px] rounded-full bg-[#102034]" />
                <span
                  className="absolute inset-[0.5px] origin-top rounded-full bg-[#fff7d6]"
                  style={{ transform: 'scaleY(0)', animation: 'robot-elf-blink 5.8s ease-in-out infinite' }}
                />
              </span>
              <span className="h-[1.5px] w-[3.5px] rounded-full bg-[#133243]" />
              <span className="relative flex h-[7.5px] w-[7.5px] items-center justify-center rounded-full border border-[#133243] bg-[#d7f7ff]/90 shadow-[inset_0_1px_1px_rgba(255,255,255,0.7)]">
                <span className="h-[2.25px] w-[2.25px] rounded-full bg-[#102034]" />
                <span
                  className="absolute inset-[0.5px] origin-top rounded-full bg-[#fff7d6]"
                  style={{ transform: 'scaleY(0)', animation: 'robot-elf-blink 5.8s ease-in-out infinite 120ms' }}
                />
              </span>
            </span>
          </span>
          <span className="absolute left-1/2 top-[16px] h-[2px] w-[8px] -translate-x-1/2 rounded-full bg-[#0d7b67]/70" />
          <span className="absolute bottom-[2px] left-[5px] h-[4px] w-[4px] rounded-full border border-white/18 bg-[#0f8b76]" />
          <span className="absolute bottom-[2px] right-[5px] h-[4px] w-[4px] rounded-full border border-white/18 bg-[#0f8b76]" />
        </span>
      </div>
    </>
  );
}

export default RobotElfIcon;
