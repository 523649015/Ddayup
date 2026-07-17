import { create } from 'zustand';
import { fetchModelCatalog, type CatalogModel } from '@/api/models';

interface ModelCatalogState {
  models: CatalogModel[];
  loading: boolean;
  error?: string;
  lastFetchedAt: number;
  fetchCatalog: (params?: { mode?: string; nodeType?: string; force?: boolean }) => Promise<void>;
  getModelsForNodeType: (nodeType: string) => CatalogModel[];
}

let inFlight: Promise<void> | null = null;

export const useModelCatalogStore = create<ModelCatalogState>()((set, get) => ({
  models: [],
  loading: false,
  error: undefined,
  lastFetchedAt: 0,

  fetchCatalog: async (params) => {
    const force = Boolean(params?.force);
    const isFresh = Date.now() - get().lastFetchedAt < 10_000;
    if (!force && isFresh && get().models.length > 0) return;
    if (inFlight) return inFlight;

    set({ loading: true, error: undefined });
    inFlight = fetchModelCatalog({
      mode: params?.mode,
      nodeType: params?.nodeType,
    })
      .then((models) => {
        set({
          models,
          loading: false,
          error: undefined,
          lastFetchedAt: Date.now(),
        });
      })
      .catch((error) => {
        set({
          loading: false,
          error: error instanceof Error ? error.message : '获取模型目录失败。',
        });
      })
      .finally(() => {
        inFlight = null;
      });

    return inFlight;
  },

  getModelsForNodeType: (nodeType) => {
    return get().models.filter((model) => model.nodeTypes.includes(nodeType));
  },
}));
