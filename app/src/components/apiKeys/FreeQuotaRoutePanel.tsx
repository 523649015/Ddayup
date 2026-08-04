/**
 * FreeQuotaRoutePanel.tsx — 免费额度路由可视化面板（单一职责 UI 子组件）
 *
 * 只负责展示「免费优先 + 动态回退链」：消费 useFreeQuotaRouteStore 派生的视图数据，
 * 渲染免费优先开关、各任务类型的可用回退链、每个模型/平台的激活态、以及为何切换付费。
 *
 * 不含任何业务逻辑与网络请求；决策计算全部在 store（useFreeQuotaRouteStore）与
 * 服务层（modelFallback.buildAvailableChain）完成，本组件仅做呈现。
 */
import { useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle2 } from 'lucide-react';
import {
  useFreeQuotaRouteStore,
  ROUTE_TASK_TYPES,
  type RouteTaskType,
} from '@/store/useFreeQuotaRouteStore';
import { useApiKeyStore } from '@/store/useApiKeyStore';

const TASK_LABELS: Record<RouteTaskType, string> = {
  text: '文本 / 脚本',
  image: '图片',
  video: '视频',
  audio: '音频',
};

export function FreeQuotaRoutePanel() {
  const preferFree = useFreeQuotaRouteStore((s) => s.preferFree);
  const setPreferFree = useFreeQuotaRouteStore((s) => s.setPreferFree);
  const buildView = useFreeQuotaRouteStore((s) => s.buildView);
  const isActive = useApiKeyStore((s) => s.isActive);
  // 订阅整个 key store，确保平台激活态变化能触发本面板重渲染
  const apiKeyState = useApiKeyStore();

  const [activeTask, setActiveTask] = useState<RouteTaskType>('text');

  const views = useMemo(() => buildView(), [apiKeyState, preferFree, buildView]);
  const view = views.find((v) => v.task === activeTask);

  return (
    <section className="rounded-2xl border border-white/10 bg-white/5 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white/90">免费额度路由</h3>
        <label className="flex items-center gap-2 text-xs text-white/70">
          <span>免费优先</span>
          <input
            type="checkbox"
            checked={preferFree}
            onChange={(e) => setPreferFree(e.target.checked)}
            className="h-4 w-4 accent-emerald-500"
          />
        </label>
      </div>
      <p className="mt-1 text-xs text-white/50">
        按你已激活的平台 key 动态生成回退链：免费额度优先，不满足任务能力时自动切换到付费模型。
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        {ROUTE_TASK_TYPES.map((task) => (
          <button
            key={task}
            type="button"
            onClick={() => setActiveTask(task)}
            className={`rounded-full px-3 py-1 text-xs ${
              activeTask === task ? 'bg-emerald-500/20 text-emerald-300' : 'bg-white/5 text-white/60'
            }`}
          >
            {TASK_LABELS[task]}
          </button>
        ))}
      </div>

      {view && (
        <div className="mt-3 space-y-2">
          <div className="text-xs text-white/70">
            <span className="font-medium">决策：</span>
            {view.resolution?.reason ?? '暂无可解析模型'}
            {view.resolution?.autoSwitched && (
              <span className="ml-1 inline-flex items-center gap-1 text-amber-300">
                <AlertTriangle size={12} /> 已切付费
              </span>
            )}
          </div>
          {view.chain.length === 0 ? (
            <div className="rounded-lg bg-white/5 p-3 text-xs text-white/50">
              未激活任何支持「{TASK_LABELS[activeTask]}」任务的平台 key。请在上方激活对应平台以启用免费额度。
            </div>
          ) : (
            <ol className="space-y-1">
              {view.chain.map((c, idx) => {
                const active = isActive(c.provider);
                const chosen = view.resolution?.chosenIndex === idx;
                return (
                  <li
                    key={c.id}
                    className={`flex items-center justify-between rounded-lg px-3 py-2 text-xs ${
                      chosen ? 'bg-emerald-500/10 ring-1 ring-emerald-500/40' : 'bg-white/5'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      {idx === 0 && <span className="text-white/40">①</span>}
                      <span className="text-white/85">{c.label ?? c.id}</span>
                      {c.isFree ? (
                        <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-emerald-300">免费</span>
                      ) : (
                        <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-amber-300">付费</span>
                      )}
                      {chosen && <CheckCircle2 size={13} className="text-emerald-400" />}
                    </span>
                    <span className="flex items-center gap-2">
                      {active ? (
                        <span className="text-emerald-400">已激活</span>
                      ) : (
                        <span className="text-white/40">未激活</span>
                      )}
                      {idx < view.chain.length - 1 && <ArrowRight size={12} className="text-white/30" />}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
