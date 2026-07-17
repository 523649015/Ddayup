export function dccGatewayCandidates(): string[] {
  const envBase = typeof import.meta.env.VITE_HMDAO_API_BASE === 'string' ? import.meta.env.VITE_HMDAO_API_BASE.trim() : '';
  const current = window.location.origin;
  const loopback = ['http://127.0.0.1:8792', 'http://localhost:8792', 'http://127.0.0.1:8787', 'http://localhost:8787'];
  const currentIsViteDev = /\/\/(localhost|127\.0\.0\.1):3000$/i.test(current);
  const ordered = currentIsViteDev
    ? [envBase, ...loopback, current]
    : [envBase, current, ...loopback];
  return Array.from(new Set(ordered.filter(Boolean).map((item) => item.replace(/\/$/, ''))));
}

export async function resolveDccGatewayBase(pathname = '/api/dcc/status'): Promise<string> {
  const candidates = dccGatewayCandidates();
  for (const base of candidates) {
    try {
      const response = await fetch(`${base}${pathname}`, {
        credentials: 'include',
        cache: 'no-store',
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
        ...init,
      });
      if (response.status !== 404 || !options.fallbackPathname) {
        return response;
      }
      lastResponse = response;
      const fallbackResponse = await fetch(`${base}${options.fallbackPathname}`, {
        credentials: 'include',
        cache: 'no-store',
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