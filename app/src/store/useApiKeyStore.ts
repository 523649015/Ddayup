import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { secureKeyStore } from '@/services/secureKeyStore';
import { normalizeProviderId } from '@/lib/providerAlias';

// 任务 AM：invalid 是后端校验失败的运行期真实状态（任务 AD/F 引入并保留），
// 此前漏声明导致 item.status 在 TS 层不被识别、UI 无法自然分支。补入联合类型使类型诚实反映现实。
export type ProviderKeyStatus = 'active' | 'expiring' | 'expired' | 'invalid';
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
  status?: ProviderKeyStatus;
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
  // 关键修复：把后端（已持久化）已激活的平台，以 metadata-only 形式合并进本地 keys，
  // 使 isActive 经 metadataOnly 返回 true。这样刷新/重登后即使本地加密 key 尚未回填，
  // 也由「服务端真值」驱动激活态，不再提示「重新执行验证激活」。
  syncFromRuntime: (records: Array<{
    provider: string;
    mode?: ProviderKeyMode;
    maskedKey?: string;
    status?: string;
    endpoint?: string;
    activatedAt?: number;
  }>) => void;
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
  // 关键：provider 统一归一化，保证「存储 key」与「校验激活」两端使用同一个 id，
  // 避免 volcengine/ark/doubao、siliconflow/silicon-flow 等别名或大小写导致的
  // keyId 不一致（会引发「已激活却反复要求激活」的 bug）。
  const canonical = normalizeProviderId(provider) || String(provider || '').trim();
  return `${canonical}::${mode}`;
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

/**
 * 任务 AL：provider key 可用性的单一真值判定。
 * invalid（后端校验失败，任务 AD/F）与 expired（生命周期到期，任务 M/AE）同为「不可用」，
 * 均需用户更新后由 verifyKeyValidity 翻回 active。此前各调用点只判 expired，
 * 导致 invalid key 在模型匹配/节点可用性/面板激活态上被误当可用——此处收敛，避免语义散落漂移。
 */
export function isUnusableProviderKeyStatus(status: string | undefined): boolean {
  return status === 'expired' || status === 'invalid';
}

export function providerKeyMatchesModel(
  key: Pick<ProviderKeyState, 'model' | 'status'> | undefined,
  model: string | undefined | null,
  options?: { allowProviderOnlyFallback?: boolean },
): boolean {
  if (!key || isUnusableProviderKeyStatus(key.status)) return false;
  const requestedVariants = providerModelIdentifierVariants(model);
  if (!requestedVariants.length) return true;
  const activatedVariants = providerModelIdentifierVariants(key.model);
  if (!activatedVariants.length) return options?.allowProviderOnlyFallback ?? true;
  return requestedVariants.some((item) => activatedVariants.includes(item));
}

function normalizeProviderKeyIdentity(identifier: string, key: Partial<ProviderKeyState>): { provider: string; mode: ProviderKeyMode } {
  const rawProvider = String(key.provider || '').trim();
  const rawMode = String(key.mode || '').trim() as ProviderKeyMode;

  let provider = rawProvider;
  let mode = rawMode;

  if (!provider || !mode) {
    const match = String(identifier || '').match(/^(.*)::(llm|image|video|audio)$/);
    if (match) {
      provider = provider || match[1];
      mode = (mode || match[2]) as ProviderKeyMode;
    } else {
      provider = provider || String(identifier || '').trim();
      mode = (mode || 'llm') as ProviderKeyMode;
    }
  }

  // 统一归一化 provider，保证 store 内的 key 身份与校验端一致。
  return { provider: normalizeProviderId(provider) || provider, mode };
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
      // 任务 M/AE：本地预估过期不等同于平台真实失效，不再静默删除条目（否则不跨会话持久化，
      // 任务 M 的「expired 保留」在 partialize 存盘/加载时失效）。过期条目降级标记为 expired 保留，
      // 但后端已校验的 invalid 状态（任务 AD）必须原样保留，交 verifyKeyValidity 决策翻回。
      if (isExpired(normalized)) {
        // 任务 AD：后端已校验的 invalid 状态必须原样保留（normalizeProviderKeyState 仅按时间推算会抹掉 invalid），
        // 交 verifyKeyValidity 决策翻回；其余过期条目降级标 expired 保留（任务 M/AE 跨会话持久）。
        const preserved = value.status === 'invalid' ? { ...normalized, status: 'invalid' } : { ...normalized, status: 'expired' };
        return [providerKeyId(identity.provider, identity.mode), preserved] as const;
      }
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

  const canonicalProvider = normalizeProviderId(provider) || String(provider || '').trim();
  const matched = Object.values(keys || {}).find((item) => (
    item
    && (normalizeProviderId(item.provider) || item.provider) === canonicalProvider
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
        // 单一归一化路径：过期/invalid 的保留语义与 normalizeProviderKeyMap(AE/AD) 保持一致，
        // 避免在 setKey 内重复拦截导致 invalid 被错误降级为 expired（normalizeProviderKeyState
        // 按时间重算会抹掉原始 invalid，必须用传入 key.status 判断）。
        const keyId = providerKeyId(key.provider, key.mode);
        const normalized = normalizeProviderKeyState(key);
        if (key.status === 'invalid') {
          // 后端已校验的 invalid 必须原样保留（任务 AD）：normalizeProviderKeyState 仅按时间
          // 重算会抹掉 invalid，此处显式还原，交 verifyKeyValidity 决策翻回。
          set((state) => ({
            keys: {
              ...normalizeProviderKeyMap(state.keys),
              [keyId]: { ...normalized, status: 'invalid' },
            },
          }));
        } else if (isExpired(normalized)) {
          // 本地预估过期不等同于平台真实失效：降级标记为 expired 保留，
          // 由登录后的后端有效性校验（verifyKeyValidity）确认真实状态。
          set((state) => ({
            keys: {
              ...normalizeProviderKeyMap(state.keys),
              [keyId]: { ...normalized, status: 'expired' },
            },
          }));
        } else {
          set((state) => ({
            keys: {
              ...normalizeProviderKeyMap(state.keys),
              [keyId]: normalized,
            },
          }));
        }

        if (normalized.apiKey && secureKeyStore.isReady()) {
          await secureKeyStore.store(keyId, normalized.apiKey);
        }
      },

      removeKey: async (provider, mode) => {
        const current = normalizeProviderKeyMap(get().keys);
        const canonicalProvider = normalizeProviderId(provider) || String(provider || '').trim();
        const targetEntries = Object.entries(current).filter(([, value]) => (
          (normalizeProviderId(value.provider) || value.provider) === canonicalProvider && (!mode || value.mode === mode)
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

      syncFromRuntime: (records) => {
        if (!Array.isArray(records)) return;
        const incoming = records
          .map((rec) => {
            const provider = normalizeProviderId(rec.provider) || String(rec.provider || '').trim();
            if (!provider) return null;
            return { provider, mode: (rec.mode || 'llm') as ProviderKeyMode };
          })
          .filter(Boolean) as Array<{ provider: string; mode: ProviderKeyMode }>;
        const incomingIds = new Set(incoming.map((r) => providerKeyId(r.provider, r.mode)));
        set((state) => {
          const next = normalizeProviderKeyMap(state.keys);
          // 关键修复：对账清除——后端已不存在的 metadata-only 条目（旧中继/失效 key）必须删除，
          // 否则清理后端 activated-providers.json 后，localStorage 里的陈旧 metadata 仍会让平台显示「已激活」。
          for (const keyId of Object.keys(next)) {
            const entry = next[keyId];
            // 任务 I：对账清除两类后端已不存在的陈旧条目，避免过期 key 永久滞留本地：
            // 1) metadata-only（后端中继）且无真实 apiKey —— 后端已不承认；
            // 2) 本地状态为 expired 且无真实 apiKey —— 后端已停用，本地预估过期已无复验价值。
            // 注意（任务 AH）：持有真实 apiKey 的 expired 条目【不能删】——它由 verifyKeyValidity
            // 负责后端复验翻回 active（任务 M/AE 的「过期保留不静默删除」闭环）；若此处抢先删除，
            // 与登录时并发的 syncByokRuntimeKeys/verifyKeyValidity 会形成竞态，使真实 key 永久失去复验。
            // 同理 active 且持有真实 apiKey 的条目无论后端是否同步都保留（后端可能尚未同步）。
            if (!incomingIds.has(keyId)) {
              const isStaleMetadata = entry?.metadataOnly && entry.apiKey === undefined;
              const isExpiredAndOrphaned = entry?.status === 'expired' && entry.apiKey === undefined;
              if (isStaleMetadata || isExpiredAndOrphaned) {
                delete next[keyId];
              }
            }
          }
          for (const rec of records) {
            const provider = normalizeProviderId(rec.provider) || String(rec.provider || '').trim();
            if (!provider) continue;
            const mode = (rec.mode || 'llm') as ProviderKeyMode;
            const keyId = providerKeyId(provider, mode);
            const existing = next[keyId];
            // 不覆盖已存有真实 apiKey 的本地条目（避免把可管理的 key 降级为 metadata-only）
            if (existing && existing.apiKey) continue;
            next[keyId] = {
              ...(existing || {}),
              provider,
              mode,
              apiKey: undefined,
              maskedKey: rec.maskedKey || existing?.maskedKey || '',
              endpoint: rec.endpoint || existing?.endpoint || '',
              status: (rec.status === 'expired' ? 'expired' : (rec.status || 'active')) as ProviderKeyStatus,
              metadataOnly: true,
              activatedAt: rec.activatedAt || existing?.activatedAt || 0,
              expiresAt: existing?.expiresAt ?? undefined,
            };
          }
          return { keys: next };
        });
      },

      getKey: (provider, mode) => {
        const key = findProviderKeyState(get().keys, provider, mode);
        // 任务 AJ：invalid 条目（后端校验失败，任务 AD/F）不返回 apiKey，避免用已失效 key 发起请求；
        // 仅 expired 与 invalid 视为不可用（任务 AL 统一判定），active 才返回真实 key。
        if (!key || isUnusableProviderKeyStatus(key.status) || isExpired(key)) return undefined;
        return key.apiKey;
      },
      isActive: (provider, mode) => {
        const key = findProviderKeyState(get().keys, provider, mode);
        if (!key) return false;
        // 任务 AK：必须读原始 key.status（经 setKey/normalizeProviderKeyMap 显式保留的 invalid），
        // 不可读 normalizeProviderKeyState 重算后的 status——后者按 expiresAt 重算会抹掉 invalid，
        // 导致 invalid 被误判为 active（与任务 AD/F 闭环冲突）。仅 expired 用时间推算（isExpired）。
        return Boolean((key.apiKey || key.metadataOnly) && !isUnusableProviderKeyStatus(key.status) && !isExpired(key));
      },
    }),
    {
      name: 'hmdao-api-keys',
      partialize: (state) => ({
        keys: stripSecrets(normalizeProviderKeyMap(state.keys)),
      }),
      // 关键修复：解决「刷新后每次要重新激活」的根因。
      // 真实 apiKey 不在 localStorage（被 stripSecrets 抹掉），而是加密存放在
      // secureKeyStore（localStorage hmdao_enc_k_*），解密密钥由登录态 refreshToken 派生。
      // useAuthStore 在刷新时（onRehydrateStorage）会调用 initSecureStore(refreshToken)
      // → hydrateSecureKeys() 回填 apiKey，但此刻本 store 的 metadata 往往尚未 rehydrate
      // 完成，get().keys 为空，导致 hydrateSecureKeys 找不到条目而永不回填；
      // 之后本 store 完成 rehydrate 写入 metadata，却不再触发 hydrate。
      // 这里在本 store 自己的 metadata 加载完成后再补一次 hydrate，确保 apiKey 回填，
      // 从而 isActive 返回 true，表单不再要求重新激活。
      onRehydrateStorage: () => (state) => {
        if (state && secureKeyStore.isReady()) {
          void state.hydrateSecureKeys();
        }
      },
    },
  ),
);
