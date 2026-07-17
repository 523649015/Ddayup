import { create } from 'zustand';

interface BackendHealthDiagnostics {
  enabled: boolean;
  apiPort: number;
  litellmBaseUrlConfigured: boolean;
  litellmApiKeyConfigured: boolean;
}

interface BackendHealthState {
  realApiEnabled: boolean | null;
  diagnostics: BackendHealthDiagnostics | null;
  loading: boolean;
  error?: string;
  lastFetchedAt: number;
  fetchHealth: (params?: { force?: boolean }) => Promise<void>;
}

interface HealthResponse {
  success?: boolean;
  realApiEnabled?: boolean;
  realApiDiagnostics?: Partial<BackendHealthDiagnostics>;
}

let inFlight: Promise<void> | null = null;

export const useBackendHealthStore = create<BackendHealthState>()((set, get) => ({
  realApiEnabled: null,
  diagnostics: null,
  loading: false,
  error: undefined,
  lastFetchedAt: 0,

  fetchHealth: async (params) => {
    const force = Boolean(params?.force);
    const isFresh = Date.now() - get().lastFetchedAt < 10_000;
    if (!force && isFresh && (get().realApiEnabled !== null || get().error)) return;
    if (inFlight) return inFlight;

    set({ loading: true, error: undefined });
    inFlight = fetch('/api/health')
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Backend health check failed with HTTP ${response.status}.`);
        }
        return response.json() as Promise<HealthResponse>;
      })
      .then((payload) => {
        set({
          realApiEnabled: typeof payload.realApiEnabled === 'boolean' ? payload.realApiEnabled : false,
          diagnostics: payload.realApiDiagnostics
            ? {
                enabled: Boolean(payload.realApiDiagnostics.enabled),
                apiPort: Number(payload.realApiDiagnostics.apiPort || 0),
                litellmBaseUrlConfigured: Boolean(payload.realApiDiagnostics.litellmBaseUrlConfigured),
                litellmApiKeyConfigured: Boolean(payload.realApiDiagnostics.litellmApiKeyConfigured),
              }
            : null,
          loading: false,
          error: undefined,
          lastFetchedAt: Date.now(),
        });
      })
      .catch((error) => {
        set({
          loading: false,
          error: error instanceof Error ? error.message : 'Backend health check failed.',
          lastFetchedAt: Date.now(),
        });
      })
      .finally(() => {
        inFlight = null;
      });

    return inFlight;
  },
}));
