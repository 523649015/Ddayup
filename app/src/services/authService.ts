import { useAuthStore } from '@/store/useAuthStore';
import {
  normalizeProviderKeyState,
  providerKeyId,
  resolveProviderKeyStatus,
  isUnusableProviderKeyStatus,
  useApiKeyStore,
  type ProviderKeyMode,
  type ProviderKeyState,
} from '@/store/useApiKeyStore';
import { useByokRuntimeStore } from '@/store/useByokRuntimeStore';
import { parseAuthError } from '@/utils/authErrors';
import type { EmailLoginInput, EmailRegisterInput, EmailResetInput } from '@/schemas/authSchemas';
import { normalizeEmail } from '@/schemas/authSchemas';

const API_BASE = '/api/auth';
const SESSION_REFRESH_WINDOW_MS = 5 * 60 * 1000;
const AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const AUTH_REQUEST_TIMEOUT_MS = 15000;

interface AuthResponse {
  success: boolean;
  message?: string;
  user?: { id: string; email: string; created_at: string };
  session?: { access_token: string; refresh_token: string; expires_at: number };
  error?: { message: string; code?: string };
}

interface AuthActionResult {
  success: boolean;
  error?: string;
  code?: string;
}

class AuthRequestError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AuthRequestError';
    this.code = code;
  }
}

function mapHttpStatusToAuthCode(status: number): string {
  if (status === 401) return 'invalid_credentials';
  if (status === 408) return 'request_timeout';
  // 邮箱重复注册：后端 auth.mjs 返回 409 + code 'user_already_exists'，
  // 此处兜底保证即使响应体未携带 code，前端也能据此识别并引导登录。
  if (status === 409) return 'user_already_exists';
  if ([502, 503, 504].includes(status)) return 'service_unavailable';
  if (status >= 500) return 'server_error';
  return `http_${status}`;
}

function fallbackHttpMessage(status: number): string {
  const code = mapHttpStatusToAuthCode(status);
  if (code === 'invalid_credentials') return '邮箱或密码错误，请重新输入。';
  if (code === 'request_timeout') return '认证服务响应超时，请稍后重试。';
  if (code === 'service_unavailable') return '认证服务暂时不可用，请稍后重试。';
  if (code === 'server_error') return '认证服务异常，请稍后再试。';
  return `认证请求失败（HTTP ${status}）。`;
}

/**
 * 任务 M：单一收敛点——把本地预估过期的 key 降级标记为 expired 保留（不静默删除）。
 * 由登录后的 verifyKeyValidity 做后端真实校验决策（翻回 active 或标 invalid）。
 * 原 syncProviderKeyLifecycle 与 startAutoRefresh 各有一份相同分支，现收敛此处避免维护漂移。
 */
async function markKeyExpiredIfStale(item: ProviderKeyState): Promise<void> {
  if (item.status === 'expired' || item.status === 'invalid') return;
  if (resolveProviderKeyStatus(item.expiresAt) === 'expired') {
    await useApiKeyStore.getState().setKey({ ...item, status: 'expired' });
  }
}

function syncProviderKeyLifecycle(now = Date.now()): void {
  const apiKeyStore = useApiKeyStore.getState();
  const entries = Object.values(apiKeyStore.keys);
  void Promise.all(entries.map(async (item) => {
    const normalized = normalizeProviderKeyState(item, now);
    // 本地预估过期不等于平台真实失效：不再静默删除，仅标记 expired 保留（任务 M 收敛点）。
    if (resolveProviderKeyStatus(normalized.expiresAt, now) === 'expired') {
      await markKeyExpiredIfStale(normalized);
      return;
    }
    // 任务 AD：后端校验失败标记的 invalid 状态由 verifyKeyValidity 专属决策，本地预估不可将其
    // 静默覆盖回 active（否则被平台吊销的 key 会被本地时间推算复活，破坏任务 F 的 invalid 闭环）。
    // 仅当本地状态非 invalid（或后端已翻回）时才用本地归一化结果同步其他字段。
    if (item.status === 'invalid') return;
    if (
      normalized.status !== item.status ||
      normalized.lastValidatedAt !== item.lastValidatedAt ||
      normalized.refreshAfter !== item.refreshAfter
    ) {
      await apiKeyStore.setKey({
        ...normalized,
        apiKey: normalized.apiKey,
      });
    }
  }));
}

/**
 * 登录后把后端已持久化的激活平台（服务端真值）同步进本地 key store，
 * 与本地加密 key 互为冗余，避免直接进入画布时激活态丢失。
 * 复用 useByokRuntimeStore 的 fetchRuntime（带 10s 去抖）与 useApiKeyStore.syncFromRuntime。
 */
async function syncByokRuntimeKeys(): Promise<void> {
  try {
    const runtime = await useByokRuntimeStore.getState().fetchRuntime({ force: true });
    const records = runtime?.activatedProviders;
    if (Array.isArray(records) && records.length > 0) {
      useApiKeyStore.getState().syncFromRuntime(records);
    }
  } catch {
    // 同步失败不应阻断登录流程，后端激活态会在相关页面加载时再次拉取
  }
}

/**
 * P2：登录后对本地已恢复的 key 做一次后端真实有效性校验（非仅看本地 expiresAt）。
 * 校验失败（平台吊销/额度耗尽/格式错误）时标记 invalid 并 toast 提醒用户更新；
 * 不静默删除本地 key，保留给用户手动处理。
 */
async function verifyKeyValidity(): Promise<boolean> {
  const entries = Object.values(useApiKeyStore.getState().keys);
  // 任务 AA：candidate 精确携带 provider+mode（与后端契约一致，不含多余 id 字段）；
  // 回写时用 providerKeyId 重建稳定键精确命中 store 条目，避免同 provider 不同 mode 的 key 错配。
  const candidates = entries
    .filter((item) => item.apiKey && (item.status === 'expired' || item.status === 'invalid' || item.status === 'active'))
    .map((item) => ({ provider: item.provider, apiKey: item.apiKey as string, mode: item.mode }));
  if (candidates.length === 0) return true;
  try {
    const { validateByokKeys } = await import('@/api/byok');
    const result = await validateByokKeys(candidates);
    const results = result.results || [];
    if (results.length === 0) return true;
    const apiKeyStore = useApiKeyStore.getState();
    const failed = results.filter((r) => !r.success);
    // 任务 F：后端校验通过的本地 key，若因本地预估过期被标为 expired，则翻回 active 恢复可用；
    // 这是任务 A「expired 保留、由后端真实校验决策」的闭环——后端说有效即恢复，不要求用户重填。
    // 任务 AA：用 providerKeyId 重建 id 精确命中 store 条目，杜绝 mode 歧义导致的错配回写。
    for (const ok of results.filter((r) => r.success)) {
      const targetId = providerKeyId(ok.provider, (ok.mode as ProviderKeyMode) || 'llm');
      const target = apiKeyStore.keys[targetId];
      // 任务 AG：后端校验通过的本地 key，若因本地预估过期(expired)或后端曾判 invalid 被保留，
      // 均翻回 active 恢复可用——闭环任务 AD「交 verifyKeyValidity 决策翻回」与 AF「invalid 显式保留」。
      if (target && (target.status === 'expired' || target.status === 'invalid')) {
        await apiKeyStore.setKey({ ...target, status: 'active', lastValidatedAt: Date.now() });
      }
    }
    if (failed.length === 0) return true;
    for (const f of failed) {
      const targetId = providerKeyId(f.provider, (f.mode as ProviderKeyMode) || 'llm');
      const target = apiKeyStore.keys[targetId];
      if (target) {
        await apiKeyStore.setKey({ ...target, status: 'invalid', lastValidatedAt: Date.now() });
      }
    }
    const { toast } = await import('sonner');
    toast.warning(
      `有 ${failed.length} 个平台 API Key 校验未通过，请前往「模型密钥」页面更新：${failed
        .map((f) => f.provider)
        .join('、')}`,
    );
    return true;
  } catch {
    // 校验接口异常不应阻断登录流程，但需向调用方上报失败以便任务 S 暂停复验。
    return false;
  }
}

async function authFetch(path: string, body: unknown): Promise<AuthResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AUTH_REQUEST_TIMEOUT_MS);

  try {
    let resp: Response;
    try {
      resp = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) {
        throw new AuthRequestError('request_timeout', '认证服务响应超时，请稍后重试。');
      }
      throw new AuthRequestError('service_unreachable', '认证服务未启动或不可达，请先启动本地服务。');
    }

    const rawText = await resp.text();
    let data: AuthResponse | null = null;
    if (rawText) {
      try {
        data = JSON.parse(rawText) as AuthResponse;
      } catch {
        data = null;
      }
    }
    if (data) {
      if (!resp.ok && !data.error) {
        data.error = {
          message: data.message || fallbackHttpMessage(resp.status),
          code: mapHttpStatusToAuthCode(resp.status),
        };
      }
      return data;
    }
    return {
      success: false,
      error: {
        message: fallbackHttpMessage(resp.status),
        code: mapHttpStatusToAuthCode(resp.status),
      },
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function signInWithEmail(input: EmailLoginInput): Promise<AuthActionResult> {
  const store = useAuthStore.getState();
  store.setLoading(true);

  try {
    // 任务 C：邮箱归一化（去空格 + 转小写），避免大小写歧义导致同一邮箱被当成不同账号。
    const data = await authFetch('/login', { ...input, email: normalizeEmail(input.email) });

    if (data.success && data.user && data.session) {
      store.setUser({
        id: data.user.id,
        email: data.user.email,
        createdAt: data.user.created_at,
      });
      store.setSession({
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        expiresAt: data.session.expires_at,
      });
      await useApiKeyStore.getState().initSecureStore(data.session.refresh_token);
      syncProviderKeyLifecycle();
      // P1 加固：登录成功后显式同步后端已持久化的激活平台（服务端真值），
      // 与本地加密 key 互为冗余，确保直接进入画布时也已恢复激活态。
      void syncByokRuntimeKeys();
      // P2：登录后对本地 key 做真实有效性校验，失效则提醒用户更新
      void verifyKeyValidity().then((ok) => {
        // 任务 T：登录代表后端可达，首验成功即重置任务 S 的复验失败计数，
        // 避免此前周期复验累计的失败计数阻碍后续正常复验。
        if (ok) expiredRecheckState.consecutiveFailures = 0;
      });
      return { success: true };
    }

    return { success: false, error: data.error?.message || '登录失败', code: data.error?.code };
  } catch (error) {
    if (error instanceof AuthRequestError) {
      return { success: false, error: error.message, code: error.code };
    }
    return { success: false, error: parseAuthError(error) };
  } finally {
    store.setLoading(false);
  }
}

export async function signUpWithEmail(input: EmailRegisterInput): Promise<AuthActionResult> {
  const store = useAuthStore.getState();
  store.setLoading(true);

  try {
    // 任务 C：邮箱归一化（去空格 + 转小写），与登录入口保持一致。
    const data = await authFetch('/register', {
      email: normalizeEmail(input.email),
      password: input.password,
    });

    if (data.success) {
      if (data.user && data.session) {
        store.setUser({
          id: data.user.id,
          email: data.user.email,
          createdAt: data.user.created_at,
        });
        store.setSession({
          accessToken: data.session.access_token,
          refreshToken: data.session.refresh_token,
          expiresAt: data.session.expires_at,
        });
        await useApiKeyStore.getState().initSecureStore(data.session.refresh_token);
        syncProviderKeyLifecycle();
      }
      return { success: true };
    }

    return { success: false, error: data.error?.message || '注册失败', code: data.error?.code };
  } catch (error) {
    if (error instanceof AuthRequestError) {
      return { success: false, error: error.message, code: error.code };
    }
    return { success: false, error: parseAuthError(error) };
  } finally {
    store.setLoading(false);
  }
}

export async function resetPasswordWithEmail(input: EmailResetInput): Promise<AuthActionResult> {
  const store = useAuthStore.getState();
  store.setLoading(true);

  try {
    const data = await authFetch('/reset-password', {
      email: input.email,
      password: input.password,
    });

    if (data.success) {
      return { success: true };
    }

    return { success: false, error: data.error?.message || '重置密码失败', code: data.error?.code };
  } catch (error) {
    if (error instanceof AuthRequestError) {
      return { success: false, error: error.message, code: error.code };
    }
    return { success: false, error: parseAuthError(error) };
  } finally {
    store.setLoading(false);
  }
}

export async function signOut(): Promise<void> {
  const store = useAuthStore.getState();
  const refreshToken = store.session?.refreshToken;

  try {
    await authFetch('/logout', refreshToken ? { refresh_token: refreshToken } : {});
  } catch {
    // ignore logout API failure and still clear local state
  }

  await useApiKeyStore.getState().clearAll();
  useApiKeyStore.getState().clearRuntimeKeys();
  stopAutoRefresh();
  // 任务 Z：登出时重置 expired key 复验状态，避免旧时间戳导致新登录后周期复验被延迟最多一个冷却周期。
  resetExpiredRecheckState();
  store.logout();
}

export async function refreshToken(): Promise<boolean> {
  const store = useAuthStore.getState();
  const session = store.session;
  if (!session?.refreshToken) return false;

  try {
    const data = await authFetch('/refresh', { refresh_token: session.refreshToken });
    if (data.success && data.session) {
      await useApiKeyStore.getState().rotateSessionSecret(session.refreshToken, data.session.refresh_token);
      store.setSession({
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        expiresAt: data.session.expires_at,
      });
      syncProviderKeyLifecycle();
      return true;
    }

    await useApiKeyStore.getState().clearAll();
    useApiKeyStore.getState().clearRuntimeKeys();
    return false;
  } catch {
    await useApiKeyStore.getState().clearAll();
    useApiKeyStore.getState().clearRuntimeKeys();
    return false;
  }
}

let refreshInterval: ReturnType<typeof setInterval> | null = null;
// 任务 G：对已标记 expired 的本地 key，周期性（默认 30 分钟）后端复验翻回 active 的冷却间隔。
const EXPIRED_RECHECK_COOLDOWN_MS = 30 * 60 * 1000;
// 任务 W：expired key 周期复验的运行态收敛到单一对象，避免散落全局变量。
// lastAt：上次复验时间戳（冷却比较）；consecutiveFailures：连续失败计数（任务 S 阈值暂停）。
const EXPIRED_RECHECK_MAX_CONSECUTIVE_FAILURES = 3;
const expiredRecheckState = {
  lastAt: 0,
  consecutiveFailures: 0,
};
function resetExpiredRecheckState(): void {
  expiredRecheckState.lastAt = 0;
  expiredRecheckState.consecutiveFailures = 0;
}

export function startAutoRefresh(): void {
  if (refreshInterval) return;

  refreshInterval = setInterval(async () => {
    const store = useAuthStore.getState();
    syncProviderKeyLifecycle();

    if (store.isAuthenticated() && store.session) {
      if (Date.now() > store.session.expiresAt - SESSION_REFRESH_WINDOW_MS) {
        const ok = await refreshToken();
        if (!ok) store.logout();
      }
      // 任务 G：已登录态下，周期性对本地 expired key 做后端复验，后端说有效即翻回 active（不要求用户重登）。
      // 受冷却间隔限制，避免每次心跳都打校验接口；且无 expired key 时直接跳过。
      // 任务 S：连续失败达到阈值后暂停复验，避免后端长期不可用时无谓重试；成功一次即重置计数。
      if (Date.now() - expiredRecheckState.lastAt > EXPIRED_RECHECK_COOLDOWN_MS) {
        // 任务 AN：周期复验触发条件从「仅 expired」扩展为「expired 或 invalid」，与 verifyKeyValidity 的翻回逻辑（第 147 行）对齐。
        // 用户重新填了正确 key 被后端判为 invalid 后，不必等下次登录即可被周期复验翻回 active，闭环任务 AD「提示用户更新」的诉求。
        // 复用 isUnusableProviderKeyStatus 单一真值，避免字面量散落。
        const hasUnstableKey = Object.values(useApiKeyStore.getState().keys).some((k) => isUnusableProviderKeyStatus(k.status));
        if (hasUnstableKey && expiredRecheckState.consecutiveFailures < EXPIRED_RECHECK_MAX_CONSECUTIVE_FAILURES) {
          expiredRecheckState.lastAt = Date.now();
          void verifyKeyValidity().then((ok) => {
            expiredRecheckState.consecutiveFailures = ok ? 0 : expiredRecheckState.consecutiveFailures + 1;
          });
        }
      }
      return;
    }

    const apiKeyStore = useApiKeyStore.getState();
    for (const item of Object.values(apiKeyStore.keys)) {
      // 本地预估过期的 key 降级标记 expired 保留（复用任务 M 收敛点，与 syncProviderKeyLifecycle 一致）。
      if (resolveProviderKeyStatus(item.expiresAt) === 'expired') {
        void markKeyExpiredIfStale(item);
      }
    }
  }, AUTO_REFRESH_INTERVAL_MS);
}

export function stopAutoRefresh(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}
