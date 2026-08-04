import type { CSSProperties } from 'react';

/**
 * DDUp 小精灵眨眼图标。
 * 纯内联 SVG + CSS 眨眼动画（无需外部资源），眼睛每隔约 4 秒眨一次。
 */
export function ElfLogo({ size = 64, className }: { size?: number; className?: string }) {
  return (
    <span className={className} style={{ display: 'inline-flex', lineHeight: 0 } as CSSProperties}>
      <style>{`
        @keyframes elfBlink {
          0%, 90%, 100% { transform: scaleY(1); }
          93% { transform: scaleY(0.08); }
          96% { transform: scaleY(1); }
        }
        .elf-eye {
          transform-box: fill-box;
          transform-origin: center;
          animation: elfBlink 4.2s ease-in-out infinite;
        }
      `}</style>
      <svg
        width={size}
        height={size}
        viewBox="0 0 64 64"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label="DDUp 精灵"
      >
        {/* 帽子 */}
        <path d="M15 27 C15 13 32 3 32 3 C32 3 49 13 49 27 Z" fill="#34d399" stroke="#10b981" strokeWidth="1.5" />
        <circle cx="32" cy="3.5" r="3.2" fill="#a7f3d0" stroke="#10b981" strokeWidth="1" />
        {/* 左耳 */}
        <path d="M13 33 L20 20 L27 34 Z" fill="#86efac" stroke="#34d399" strokeWidth="1.5" strokeLinejoin="round" />
        {/* 右耳 */}
        <path d="M51 33 L44 20 L37 34 Z" fill="#86efac" stroke="#34d399" strokeWidth="1.5" strokeLinejoin="round" />
        {/* 脸 */}
        <ellipse cx="32" cy="39" rx="20" ry="18" fill="#d1fae5" stroke="#34d399" strokeWidth="2" />
        {/* 眼睛（带眨眼动画） */}
        <ellipse className="elf-eye" cx="25" cy="38" rx="2.6" ry="3.4" fill="#0f172a" />
        <ellipse className="elf-eye" cx="39" cy="38" rx="2.6" ry="3.4" fill="#0f172a" />
        {/* 腮红 */}
        <circle cx="21" cy="44" r="2.4" fill="#fca5a5" opacity="0.7" />
        <circle cx="43" cy="44" r="2.4" fill="#fca5a5" opacity="0.7" />
        {/* 嘴 */}
        <path d="M27 46 Q32 51 37 46" stroke="#0f172a" strokeWidth="1.8" strokeLinecap="round" fill="none" />
      </svg>
    </span>
  );
}

export default ElfLogo;
