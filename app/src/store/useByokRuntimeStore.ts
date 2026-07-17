import { create } from 'zustand';
import { getByokRuntime, type ByokRuntimeResult } from '@/api/byok';

interface ByokRuntimeState {
  runtime: ByokRuntimeResult | null;
  loading: boolean;
  error?: string;
  lastFetchedAt: number;
  fetchRuntime: (params?: { force?: boolean }) => Promise<ByokRuntimeResult | null>;
}

let runtimeInFlight: Promise<ByokRuntimeResult | null> | null = null;

export const useByokRuntimeStore = create<ByokRuntimeState>()((set, get) => ({
  runtime: null,
  loading: false,
  error: undefined,
  lastFetchedAt: 0,

  fetchRuntime: async (params) => {
    const force = Boolean(params?.force);
    const isFresh = Date.now() - get().lastFetchedAt < 10_000;
    if (!force && isFresh && get().runtime) return get().runtime;
    if (runtimeInFlight) return runtimeInFlight;

    set({ loading: true, error: undefined });
    runtimeInFlight = getByokRuntime()
      .then((runtime) => {
        set({
          runtime,
          loading: false,
          error: undefined,
          lastFetchedAt: Date.now(),
        });
        return runtime;
      })
      .catch((error) => {
        set({
          loading: false,
          error: error instanceof Error ? error.message : '加载运行时状态失败。',
        });
        return null;
      })
      .finally(() => {
        runtimeInFlight = null;
      });

    return runtimeInFlight;
  },
}));
