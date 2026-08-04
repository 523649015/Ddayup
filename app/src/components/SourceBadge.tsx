interface SourceBadgeProps {
  label: string;
  tone?: 'relay' | 'free' | 'local' | 'api' | 'recommended' | 'neutral' | 'danger';
  className?: string;
}

export type SourceBadgeTone = NonNullable<SourceBadgeProps['tone']>;

const SOURCE_BADGE_STYLES: Record<SourceBadgeTone, string> = {
  relay: 'border-[#00d4aa]/35 bg-[#00d4aa]/12 text-[#8cf0df]',
  free: 'border-[#29503f] bg-[#173427] text-[#98e8c3]',
  local: 'border-[#35506b] bg-[#162334] text-[#9fd4ff]',
  api: 'border-[#5a4a1f] bg-[#2b2410] text-[#f2d17a]',
  recommended: 'border-[#5d3dd8]/35 bg-[#3a2876]/18 text-[#d4c6ff]',
  neutral: 'border-[#30363d] bg-[#161b22] text-[#9fb0c3]',
  // 任务 AM：danger 复用页面既有错误色系（与删除按钮 #ffb5c4 / #9d5167 一致），用于 invalid 已失效状态。
  danger: 'border-[#9d5167] bg-[#3a1822] text-[#ffb5c4]',
};

export function SourceBadge({ label, tone = 'neutral', className = '' }: SourceBadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-1 text-[10px] font-medium leading-none ${SOURCE_BADGE_STYLES[tone]} ${className}`.trim()}
    >
      {label}
    </span>
  );
}

export function relaySourceLabel(source?: string | null) {
  if (!source) return null;
  if (source === 'Comfly') return 'via Comfly';
  if (source === 'Suanliai') return 'via Suanliai';
  return 'via Relay';
}
