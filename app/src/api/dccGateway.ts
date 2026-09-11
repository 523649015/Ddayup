import { useAuthStore } from '@/store/useAuthStore';

export function dccGatewayCandidates(): string[] {
  const envBase = typeof import.meta.env.VITE_HMDAO_API_BASE === 'string' ? import.meta.env.VITE_HMDAO_API_BASE.trim() : '';
  const current = window.location.origin;
  // 8787 仅为可选 fallback 端口（DCC_GATEWAY_PORT=8787 时启用），
  // 未显式配置则不列入候选，避免每次连接都产生 ERR_CONNECTION_REFUSED 噪音。
  const fallbackPort = typeof import.meta.env.VITE_DCC_GATEWAY_PORT === 'string' ? import.meta.env.VITE_DCC_GATEWAY_PORT.trim() : '';
  const loopback = ['http://127.0.0.1:8792', 'http://localhost:8792'];
  if (fallbackPort && fallbackPort !== '8792') {
    loopback.push(`http://127.0.0.1:${fallbackPort}`, `http://localhost:${fallbackPort}`);
  }
  // 同源优先：当前源在 dev 下由 Vite 代理转发 /api 到后端（vite.config.ts proxy），
  // 功能等价但不会跨源；此前 dev 模式把 loopback 排在 current 之前，导致每次连接
  // 都先打 4 个跨源地址、被 CORS 拦截后在控制台刷满 ERR_FAILED 红字，用户误以为后端挂了。
  // loopback 仅作为代理不可用时的兜底。
  const ordered = [envBase, current, ...loopback];
  return Array.from(new Set(ordered.filter(Boolean).map((item) => item.replace(/\/$/, ''))));
}

export async function resolveDccGatewayBase(pathname = '/api/dcc/status'): Promise<string> {
  const candidates = dccGatewayCandidates();
  for (const base of candidates) {
    try {
      const response = await fetch(`${base}${pathname}`, {
        credentials: 'include',
        cache: 'no-store',
        headers: dccAuthHeaders(),
      });
      if (response.ok) return base;
    } catch {
      /* try next candidate */
    }
  }
  return '';
}

export async function dccGatewayFetch(
  pathname: string,
  init: RequestInit = {},
  options: { fallbackPathname?: string } = {},
): Promise<Response> {
  const bases = dccGatewayCandidates();
  let lastResponse: Response | null = null;
  let lastError: unknown = null;

  for (const base of bases) {
    try {
      const response = await fetch(`${base}${pathname}`, {
        credentials: 'include',
        cache: 'no-store',
        headers: { ...dccAuthHeaders(), ...(init.headers || {}) },
        ...init,
      });
      if (response.status !== 404 || !options.fallbackPathname) {
        return response;
      }
      lastResponse = response;
      const fallbackResponse = await fetch(`${base}${options.fallbackPathname}`, {
        credentials: 'include',
        cache: 'no-store',
        headers: { ...dccAuthHeaders(), ...(init.headers || {}) },
        ...init,
      });
      if (fallbackResponse.ok || fallbackResponse.status !== 404) {
        return fallbackResponse;
      }
      lastResponse = fallbackResponse;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastResponse) return lastResponse;
  const networkDetail = lastError instanceof Error && lastError.message
    ? ` (${lastError.message})`
    : '';
  throw new Error(`HMDao DCC gateway is unavailable. Start or restart the backend on 127.0.0.1:8792, then retry.${networkDetail}`);
}

// 云端多用户隔离：DCC REST 调用附加当前登录用户的 Bearer token，
// 后端据此解析 owner 并向连接意图文件注入 token，供本机插件分桶连接。
function dccAuthHeaders(): Record<string, string> {
  const token = useAuthStore.getState().session?.accessToken;
  if (token) return { Authorization: `Bearer ${token}` };
  return {};
}