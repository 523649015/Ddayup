/* ===== Shared Node UI Components ===== */

export function GeneratingSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="space-y-2.5 px-3 pb-3">
      <div className="mb-3 flex items-center gap-2">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#00d4aa] opacity-75" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[#00d4aa]" />
        </span>
        <span className="text-xs font-medium text-[#00d4aa]">AI 生成中...</span>
      </div>
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="h-3 animate-pulse rounded-full bg-[#2a2a2c]"
          style={{ '--skel-w': `${85 - i * 15}%`, '--skel-delay': `${i * 150}ms` } as React.CSSProperties}
        />
      ))}
    </div>
  );
}

export function ProgressBadge({
  label,
  progress,
}: {
  label: string;
  progress?: number;
}) {
  const value = Number.isFinite(Number(progress)) ? Math.max(0, Math.min(100, Math.round(Number(progress)))) : undefined;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[#00d4aa]/10 px-2 py-0.5 text-[10px] font-medium text-[#00d4aa]">
      <span>{label}</span>
      {value !== undefined ? <span>{value}%</span> : null}
    </span>
  );
}

export function StatusBadge({ status }: { status: 'idle' | 'generating' | 'completed' | 'error' }) {
  const config: Record<string, { label: string; className: string }> = {
    idle: { label: '待处理', className: 'bg-[#2a2a2c] text-[#8b949e]' },
    generating: { label: '处理中', className: 'bg-[#00d4aa]/10 text-[#00d4aa]' },
    completed: { label: '已完成', className: 'bg-[#22c55e]/10 text-[#22c55e]' },
    error: { label: '失败', className: 'bg-[#ef4444]/10 text-[#ef4444]' },
  };
  const item = config[status] || config.idle;
  return (
    <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${item.className}`}>
      {item.label}
    </span>
  );
}

export function ErrorCategoryBadge({ category }: { category?: unknown }) {
  const raw = String(category || '').trim().toLowerCase();
  const config: Record<string, { label: string; className: string }> = {
    validation: { label: '参数错误', className: 'bg-amber-500/10 text-amber-300' },
    auth: { label: '鉴权失败', className: 'bg-orange-500/10 text-orange-300' },
    timeout: { label: '请求超时', className: 'bg-sky-500/10 text-sky-300' },
    routing: { label: '路由异常', className: 'bg-violet-500/10 text-violet-300' },
    upstream: { label: '模型异常', className: 'bg-fuchsia-500/10 text-fuchsia-300' },
    quota: { label: '余额不足', className: 'bg-rose-500/10 text-rose-300' },
    render: { label: '渲染失败', className: 'bg-rose-500/10 text-rose-300' },
    request: { label: '请求失败', className: 'bg-red-500/10 text-red-300' },
  };
  const item = config[raw] || config.request;
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${item.className}`}>
      {item.label}
    </span>
  );
}

export function ErrorDetailBlock({
  category,
  message,
}: {
  category?: unknown;
  message?: unknown;
}) {
  if (!category && !message) return null;
  return (
    <div className="mt-3 rounded-lg border border-[#4a1d1d] bg-[#2b1212] px-3 py-2">
      <div className="mb-1 flex items-center gap-2">
        <ErrorCategoryBadge category={category} />
      </div>
      {message ? <div className="text-xs leading-5 text-[#ffb4b4]">{String(message)}</div> : null}
    </div>
  );
}
