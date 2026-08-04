import React from 'react';

interface DispatchInfoBadgeProps {
  data?: any;
}

// 展示节点生成后实际被分派的模型（来自后端免费优先 + 多模型轮换分发）。
// AIPanel 生成后会把 routePreviewDispatchMode / routedProvider / routedModel 写入节点 data.params。
export default function DispatchInfoBadge({ data }: DispatchInfoBadgeProps) {
  if (!data) return null;
  const params = data.params && typeof data.params === 'object' ? data.params : {};
  const routedModel = params.routedModel || data.model;
  const routedProvider = params.routedProvider;
  const dispatchMode = params.routePreviewDispatchMode;
  const isFree = dispatchMode === 'operation-dispatch' || /免费/.test(data.discountLabel || '');
  if (!routedModel && !routedProvider) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-[#21262d] bg-[#0d1117]/70 px-2.5 py-1.5 text-[11px]">
      <span className={isFree ? 'font-medium text-emerald-400' : 'font-medium text-[#c9d1d9]'}>
        {isFree ? '🆓 免费模型' : '模型'}: {routedModel || '—'}
      </span>
      {routedProvider ? <span className="text-[#6e7681]">· {routedProvider}</span> : null}
      {dispatchMode ? (
        <span className="rounded-full bg-[#161b22] px-2 py-0.5 text-[#8b949e]">
          {dispatchMode === 'operation-dispatch' ? '自动轮换' : '指定模型'}
        </span>
      ) : null}
    </div>
  );
}
