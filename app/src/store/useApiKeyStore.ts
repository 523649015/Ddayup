import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { secureKeyStore } from '@/services/secureKeyStore';

export type ProviderKeyStatus = 'active' | 'expiring' | 'expired';
export type ProviderKeySource = 'byok' | 'platform';
export type ProviderKeyMode = 'llm' | 'image' | 'video' | 'audio';

export const DEFAULT_PROVIDER_KEY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const PROVIDER_KEY_EXPIRING_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
export const PROVIDER_KEY_REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ProviderKeyState {
  provider: string;
  apiKey?: string;
  maskedKey: string;
  mode: ProviderKeyMode;
  model?: string;
  endpoint?: string;
  activatedAt: number;
  expiresAt?: number;
  refreshAfter?: number;
  lastValidatedAt?: number;
  lastUsedAt?: number;
  source: ProviderKeySource;
  status: ProviderKeyStatus;
  metadataOnly?: boolean;
}

export interface ProviderKeyInput {
  provider: string;
  apiKey?: string;
  maskedKey: string;
  mode: ProviderKeyMode;
  model?: string;
  endpoint?: string;
  activatedAt?: number;
  expiresAt?: number;
  refreshAfter?: number;
  lastValidatedAt?: number;
  lastUsedAt?: number;
  source?: ProviderKeySource;
  metadataOnly?: boolean;
}

interface ApiKeyStore {
  keys: Record<string, ProviderKeyState>;
  secureReady: boolean;
  secureLoading: boolean;
  secureError?: string;
  initSecureStore: (sessionSecret: string) => Promise<void>;
  rotateSessionSecret: (oldSecret: string, nextSecret: string) => Promise<void>;
  hydrateSecureKeys: () => Promise<void>;
  setKey: (key: ProviderKeyInput) => Promise<void>;
  removeKey: (provider: string, mode?: ProviderKeyMode) => Promise<void>;
  clearAll: () => Promise<void>;
  clearRuntimeKeys: () => void;
  getKey: (provider: string, mode?: ProviderKeyMode) => string | undefined;
  isActive: (provider: string, mode?: ProviderKeyMode) => boolean;
}

function stripSecrets(keys: Record<string, ProviderKeyState>): Record<string, ProviderKeyState> {
  return Object.fromEntries(
    Object.entries(keys).map(([keyId, value]) => [
      keyId,
      {
        ...value,
        apiKey: undefined,
      },
    ]),
  );
}

export function resolveProviderKeyStatus(expiresAt: number | undefined, now = Date.now()): ProviderKeyStatus {
  if (expiresAt && now > expiresAt) return 'expired';
  if (expiresAt && now >= expiresAt - PROVIDER_KEY_EXPIRING_WINDOW_MS) return 'expiring';
  return 'active';
}

export function providerKeyId(provider: string, mode: ProviderKeyMode): string {
  return `${String(provider || '').trim()}::${mode}`;
}

export function normalizeProviderModelIdentifier(value: string | undefined | null): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

function providerModelIdentifierVariants(value: string | undefined | null): string[] {
  const normalized = normalizeProviderModelIdentifier(value);
  if (!normalized) return [];
  const variants = new Set<string>([normalized]);
  if (normalized.startsWith('models/')) variants.add(normalized.slice('models/'.length));
  if (normalized.includes('/')) {
    const lastSegment = normalized.split('/').filter(Boolean).pop();
    if (lastSegment) variants.add(lastSegment);
  }
  if (normalized.includes(':')) {
    const lastSegment = normalized.split(':').filter(Boolean).pop();
    if (lastSegment) variants.add(lastSegment);
  }
  return Array.from(variants);
}

export function providerKeyMatchesModel(
  key: Pick<ProviderKeyState, 'model' | 'status'> | undefined,
  model: string | undefined | null,
  options?: { allowProviderOnlyFallback?: boolean },
): boolean {
  if (!key || key.status === 'expired') return false;
  const requestedVariants = providerModelIdentifierVariants(model);
  if (!requestedVariants.length) return true;
  const activatedVariants = providerModelIdentifierVariants(key.model);
  if (!activatedVariants.length) return options?.allowProviderOnlyFallback ?? true;
  return requestedVariants.some((item) => activatedVariants.includes(item));
}

function normalizeProviderKeyIdentity(identifier: string, key: Partial<ProviderKeyState>): { provider: string; mode: ProviderKeyMode } {
  const rawProvider = String(key.provider || '').trim();
  const rawMode = String(key.mode || '').trim() as ProviderKeyMode;
  if (rawProvider && rawMode) return { provider: rawProvider, mode: rawMode };

  const match = String(identifier || '').match(/^(.*)::(llm|image|video|audio)$/);
  if (match) {
    return {
      provider: rawProvider || match[1],
      mode: (rawMode || match[2]) as ProviderKeyMode,
    };
  }

  return {
    provider: rawProvider || String(identifier || '').trim(),
    mode: (rawMode || 'llm') as ProviderKeyMode,
  };
}

export function normalizeProviderKeyState(key: ProviderKeyInput | ProviderKeyState, now = Date.now()): ProviderKeyState {
  const activatedAt = Number(key.activatedAt || now);
  const expiresAt = Number(key.expiresAt || activatedAt + DEFAULT_PROVIDER_KEY_TTL_MS);
  const refreshAfter = Number(key.refreshAfter || Math.max(activatedAt, expiresAt - PROVIDER_KEY_REFRESH_WINDOW_MS));
  return {
    provider: key.provider,
    apiKey: key.apiKey?.trim(),
    maskedKey: key.maskedKey,
    mode: key.mode,
    model: key.model,
    endpoint: key.endpoint?.trim(),
    activatedAt,
    expiresAt,
    refreshAfter,
    lastValidatedAt: Number(key.lastValidatedAt || now),
    lastUsedAt: key.lastUsedAt ? Number(key.lastUsedAt) : undefined,
    source: key.source || 'byok',
    status: resolveProviderKeyStatus(expiresAt, now),
    metadataOnly: Boolean(key.metadataOnly),
  };
}

function isExpired(key?: ProviderKeyState) {
  return resolveProviderKeyStatus(key?.expiresAt) === 'expired';
}

export function normalizeProviderKeyMap(keys: Record<string, ProviderKeyState> | undefined, now = Date.now()): Record<string, ProviderKeyState> {
  const normalizedEntries = Object.entries(keys || {})
    .map(([identifier, value]) => {
      if (!value) return null;
      const identity = normalizeProviderKeyIdentity(identifier, value);
      const normalized = normalizeProviderKeyState({
        ...value,
        provider: identity.provider,
        mode: identity.mode,
      }, now);
      if (isExpired(normalized)) return null;
      return [providerKeyId(identity.provider, identity.mode), normalized] as const;
    })
    .filter(Boolean) as Array<readonly [string, ProviderKeyState]>;

  return Object.fromEntries(normalizedEntries);
}

export function findProviderKeyState(
  keys: Record<string, ProviderKeyState> | undefined,
  provider: string,
  mode?: ProviderKeyMode,
): ProviderKeyState | undefined {
  const exactMode = mode ? keys?.[providerKeyId(provider, mode)] : undefined;
  if (exactMode && !isExpired(exactMode)) return normalizeProviderKeyState(exactMode);

  const legacy = keys?.[provider];
  if (legacy && (!mode || legacy.mode === mode) && !isExpired(legacy)) {
    const identity = normalizeProviderKeyIdentity(provider, legacy);
    return normalizeProviderKeyState({
      ...legacy,
      provider: identity.provider,
      mode: identity.mode,
    });
  }

  const matched = Object.values(keys || {}).find((item) => (
    item
    && item.provider === provider
    && (!mode || item.mode === mode)
    && !isExpired(item)
  ));
  return matched ? normalizeProviderKeyState(matched) : undefined;
}

export const useApiKeyStore = create<ApiKeyStore>()(
  persist(
    (set, get) => ({
      keys: {},
      secureReady: false,
      secureLoading: false,
      secureError: undefined,

      initSecureStore: async (sessionSecret) => {
        set({ secureLoading: true, secureError: undefined });
        try {
          await secureKeyStore.init(sessionSecret);
          await get().hydrateSecureKeys();
          set({ secureReady: true, secureLoading: false });
        } catch (error) {
          set({
            secureReady: false,
            secureLoading: false,
            secureError: error instanceof Error ? error.message : 'Failed to initialize secure key storage.',
          });
          throw error;
        }
      },

      rotateSessionSecret: async (oldSecret, nextSecret) => {
        set({ secureLoading: true, secureError: undefined });
        try {
          await secureKeyStore.rotateKey(oldSecret, nextSecret, Object.keys(get().keys));
          await get().hydrateSecureKeys();
          set({ secureReady: true, secureLoading: false });
        } catch (error) {
          set({
            secureReady: false,
            secureLoading: false,
            secureError: error instanceof Error ? error.message : 'Failed to rotate secure key storage.',
          });
          throw error;
        }
      },

      hydrateSecureKeys: async () => {
        if (!secureKeyStore.isReady()) return;
        const providers = secureKeyStore.listProviders();
        const now = Date.now();
        const current = normalizeProviderKeyMap(get().keys, now);
        const hydratedEntries = await Promise.all(
          Object.entries(current).map(async ([keyId, existing]) => {
            if (!existing) return null;
            const normalizedExisting = normalizeProviderKeyState(existing, now);
            if (isExpired(normalizedExisting)) {
              secureKeyStore.remove(keyId);
              return null;
            }
            const apiKey = await secureKeyStore.retrieve(keyId);
            return [
              keyId,
              {
                ...normalizedExisting,
                apiKey: apiKey || undefined,
              },
            ] as const;
          }),
        );

        for (const keyId of providers) {
          if (!current[keyId]) {
            secureKeyStore.remove(keyId);
          }
        }

        set((state) => {
          const normalizedStateKeys = normalizeProviderKeyMap(state.keys, now);
          return {
          keys: {
            ...normalizedStateKeys,
            ...Object.fromEntries(hydratedEntries.filter(Boolean) as Array<readonly [string, ProviderKeyState]>),
          },
          };
        });
      },

      setKey: async (key) => {
        const normalized = normalizeProviderKeyState(key);
        if (isExpired(normalized)) {
          await get().removeKey(normalized.provider, normalized.mode);
          return;
        }
        const keyId = providerKeyId(normalized.provider, normalized.mode);
        set((state) => ({
          keys: {
            ...normalizeProviderKeyMap(state.keys),
            [keyId]: normalized,
          },
        }));

        if (normalized.apiKey && secureKeyStore.isReady()) {
          await secureKeyStore.store(keyId, normalized.apiKey);
        }
      },

      removeKey: async (provider, mode) => {
        const current = normalizeProviderKeyMap(get().keys);
        const targetEntries = Object.entries(current).filter(([, value]) => (
          value.provider === provider && (!mode || value.mode === mode)
        ));

        for (const [keyId] of targetEntries) {
          secureKeyStore.remove(keyId);
        }
        if (!mode) {
          secureKeyStore.remove(provider);
        }

        set((state) => {
          const next = normalizeProviderKeyMap(state.keys);
          for (const [keyId] of targetEntries) {
            delete next[keyId];
          }
          if (!mode) {
            delete next[provider];
          }
          return { keys: next };
        });
      },

      clearAll: async () => {
        secureKeyStore.clearAll();
        set({ keys: {} });
      },

      clearRuntimeKeys: () => {
        set((state) => ({
          keys: stripSecrets(normalizeProviderKeyMap(state.keys)),
          secureReady: false,
          secureLoading: false,
        }));
        secureKeyStore.destroy();
      },

      getKey: (provider, mode) => {
        const key = findProviderKeyState(get().keys, provider, mode);
        if (isExpired(key)) return undefined;
        return key?.apiKey;
      },
      isActive: (provider, mode) => {
        const key = findProviderKeyState(get().keys, provider, mode);
        const normalized = key ? normalizeProviderKeyState(key) : undefined;
        return Boolean(normalized && (normalized.apiKey || normalized.metadataOnly) && normalized.status !== 'expired');
      },
    }),
    {
      name: 'hmdao-api-keys',
      partialize: (state) => ({
        keys: stripSecrets(normalizeProviderKeyMap(state.keys)),
      }),
    },
  ),
);
