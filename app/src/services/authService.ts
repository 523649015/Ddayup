import { useAuthStore } from '@/store/useAuthStore';
import {
  normalizeProviderKeyState,
  resolveProviderKeyStatus,
  useApiKeyStore,
} from '@/store/useApiKeyStore';
import { parseAuthError } from '@/utils/authErrors';
import type { EmailLoginInput, EmailRegisterInput, EmailResetInput } from '@/schemas/authSchemas';

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

function syncProviderKeyLifecycle(now = Date.now()): void {
  const apiKeyStore = useApiKeyStore.getState();
  const entries = Object.values(apiKeyStore.keys);
  void Promise.all(entries.map(async (item) => {
    const normalized = normalizeProviderKeyState(item, now);
    if (resolveProviderKeyStatus(normalized.expiresAt, now) === 'expired') {
      await apiKeyStore.removeKey(normalized.provider);
      return;
    }
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
    const data = await authFetch('/login', input);

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
    const data = await authFetch('/register', {
      email: input.email,
      password: input.password,
    });

    if (data.success) {
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
      return;
    }

    const apiKeyStore = useApiKeyStore.getState();
    for (const item of Object.values(apiKeyStore.keys)) {
      if (resolveProviderKeyStatus(item.expiresAt) === 'expired') {
        void apiKeyStore.removeKey(item.provider);
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
