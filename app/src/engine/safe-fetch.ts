/**
 * HMDao 安全 Fetch 包装器
 * 所有 API 调用必须通过此包装器，自动添加错误处理、重试和超时
 */

export type ErrorCategory = 'network' | 'timeout' | 'api' | 'auth' | 'validation' | 'unknown';

export interface FetchError extends Error {
  category: ErrorCategory;
  status?: number;
  retryable: boolean;
}

interface SafeFetchOptions extends RequestInit {
  retryCount?: number;
  retryDelay?: number;
  timeout?: number;
}

/** 错误分类 */
export function classifyError(error: unknown): ErrorCategory {
  if (error instanceof DOMException && error.name === 'AbortError') return 'timeout';
  if (error instanceof TypeError && error.message.includes('fetch')) return 'network';
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes('401') || msg.includes('unauthorized')) return 'auth';
    if (msg.includes('400') || msg.includes('422')) return 'validation';
    if (msg.includes('4') || msg.includes('5')) return 'api';
  }
  return 'unknown';
}

/** 结构化日志 */
export function logError(error: Error, context: Record<string, unknown> = {}): void {
  console.error(`[HMDao] ❌ ${context.module || 'unknown'}.${context.function || 'unknown'}:`, {
    message: error.message,
    category: context.category,
    timestamp: new Date().toISOString(),
    ...context,
  });
}

/** 安全 fetch — 自动错误处理 + 指数退避重试 + 超时 */
export async function safeFetch(url: string, options: SafeFetchOptions = {}): Promise<Response> {
  const { retryCount = 2, retryDelay = 1000, timeout = 30000, ...fetchOptions } = options;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retryCount; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, { ...fetchOptions, signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const err = new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`) as FetchError;
        err.status = response.status;
        err.category = response.status === 401 ? 'auth' : response.status >= 400 && response.status < 500 ? 'validation' : 'api';
        err.retryable = response.status >= 500 || response.status === 429;
        throw err;
      }

      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const category = classifyError(error);

      // 非重试类错误直接抛出
      if (category === 'auth' || category === 'validation') break;
      // 最后一次尝试
      if (attempt >= retryCount) break;
      // 指数退避
      await new Promise(r => setTimeout(r, retryDelay * Math.pow(2, attempt)));
    }
  }

  logError(lastError!, { category: classifyError(lastError), module: 'safe-fetch', function: 'safeFetch' });
  throw lastError;
}

export async function safeGet(url: string, options?: SafeFetchOptions): Promise<Response> {
  return safeFetch(url, { method: 'GET', ...options });
}

export async function safePost(url: string, body: unknown, options?: SafeFetchOptions): Promise<Response> {
  return safeFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...options,
  });
}
