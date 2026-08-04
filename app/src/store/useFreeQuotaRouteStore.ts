import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useApiKeyStore } from './useApiKeyStore';
import {
  buildAvailableChain,
  resolveModelForTask,
  type ModelCandidate,
  type ModelResolution,
} from '@/services/modelFallback';
import type { NodeType } from '@/types';

export type RouteTaskType = Extract<NodeType, 'text' | 'image' | 'video' | 'audio'>;

export const ROUTE_TASK_TYPES: RouteTaskType[] = ['text', 'image', 'video', 'audio'];

export interface FreeQuotaRouteView {
  task: RouteTaskType;
  /** 当前真实可用的回退链（静态链 ∩ 已激活平台） */
  chain: ModelCandidate[];
  /** 结合「免费优先开关 + 动态链」的最终决策 */
  resolution: ModelResolution | null;
}

interface FreeQuotaRouteStore {
  /** 免费优先总开关（默认开）。关闭后仅按能力选首个候选，不刻意挑免费。 */
  preferFree: boolean;
  setPreferFree: (value: boolean) => void;
  /** 按任务类型派生「当前真实可用的免费优先回退链」（仅含已激活平台） */
  availableChain: (task: NodeType) => ModelCandidate[];
  /** 解析某任务类型的最终决策（结合开关 + 动态链） */
  resolve: (task: NodeType) => ModelResolution | null;
  /** 一次性计算所有展示所需的视图数据 */
  buildView: () => FreeQuotaRouteView[];
}

/**
 * 免费额度路由状态层（单一职责）。
 *
 * 只负责：持有「免费优先」偏好 + 基于 useApiKeyStore 激活态派生可用链与决策。
 * 不持有任何 UI、不直连网络；纯派生计算，便于单元测试与面板复用。
 */
export const useFreeQuotaRouteStore = create<FreeQuotaRouteStore>()(
  persist(
    (set, get) => ({
      preferFree: true,

      setPreferFree: (value) => set({ preferFree: value }),

      availableChain: (task) => {
        const isActive = useApiKeyStore.getState().isActive;
        return buildAvailableChain(task, (provider) => isActive(provider));
      },

      resolve: (task) => {
        const { preferFree, availableChain } = get();
        return resolveModelForTask(task, {
          preferFree,
          chain: availableChain(task),
        });
      },

      buildView: () => {
        const { preferFree, availableChain, resolve } = get();
        void preferFree;
        return ROUTE_TASK_TYPES.map((task) => ({
          task,
          chain: availableChain(task),
          resolution: resolve(task),
        }));
      },
    }),
    {
      name: 'hmdao-free-quota-route',
      partialize: (state) => ({ preferFree: state.preferFree }),
    },
  ),
);
