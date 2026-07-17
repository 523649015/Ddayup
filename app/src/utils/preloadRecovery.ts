/**
 * Vite 动态模块加载失败时的恢复逻辑（从 main.tsx 抽出，便于测试）
 *
 * 关键修复：
 *   - 外部 CDN / 跨域模块导入失败（如 @xenova/transformers、其内部的
 *     cdnjs.cloudflare.net / jsdelivr wasm）【不再】 preventDefault / 刷新页面，
 *     否则 import() 会被 resolve 成 undefined 或无限刷新，导致页面卡死。
 *   - 仅对 Vite 自身「同源」 chunk 加载失败保留一次性自动刷新恢复。
 *   - 刷新守卫按 pathname（去掉 hmdao-reload 参数）判定，避免每次刷新
 *     的 timestamp 都不同导致守卫永不命中、陷入无限刷新循环。
 */

const RECOVERY_SESSION_KEY = '__HMDAO_PRELOAD_RECOVERY__';

export interface PreloadErrorEventLike {
  payload?: unknown;
  preventDefault?: () => void;
}

/** 是否应跳过自动刷新恢复（外部 CDN / 跨域模块导入失败不应刷新页面） */
export function shouldSkipPreloadRecovery(message: string): boolean {
  // 1) 提取消息中的 URL，若任一为跨域（非同源），说明失败来自外部 CDN，
  //    刷新无济于事，直接跳过（这正是之前「点下载就无限刷新」的根因）。
  const origin = (typeof window !== 'undefined' && window.location?.origin) || '';
  const urlMatches = message.match(/https?:\/\/[^\s"'<>]+/g) || [];
  for (const raw of urlMatches) {
    try {
      const parsed = new URL(raw);
      if (parsed.origin !== origin) return true;
    } catch {
      // 无法解析的片段忽略，继续按关键词判断
    }
  }

  // 2) 关键词兜底（消息里不一定带完整 URL，例如 @xenova/transformers 内部报错、
  //    cdnjs.cloudflare.net 不可达等）。注意：不要包含过于宽泛的词（如 "Failed to fetch"），
  //    否则同源 chunk 失败（同样以 Failed to fetch 开头）会被误判为外部 CDN 而跳过刷新。
  return /cdn|cloudflare|jsdelivr|unpkg|@xenova|cross-origin|Importing a module script failed/i.test(
    message,
  );
}

/**
 * 计算刷新恢复的判定键：去掉 hmdao-reload 参数，仅看 pathname + 其余 query，
 * 避免每次刷新 URL 的 timestamp 都不同导致守卫永不命中、陷入无限刷新循环。
 */
function recoveryKey(): string {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('hmdao-reload');
    return url.pathname + url.search;
  } catch {
    return (typeof window !== 'undefined' && window.location?.pathname) || '/';
  }
}

function buildRecoveryUrl(): string {
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set('hmdao-reload', String(Date.now()));
  return nextUrl.toString();
}

/**
 * 构造 vite:preloadError 事件处理器。
 * 直接返回函数，便于单元测试中传入伪造事件而不依赖 CustomEvent 分发细节。
 *
 * @param options.navigate 用于执行页面跳转（默认 window.location.replace）。
 *        注入它是为了让单元测试能在不触碰不可配置的 window.location 的前提下断言是否发生刷新。
 */
export function createPreloadErrorHandler(
  options?: { navigate?: (url: string) => void },
): (event: PreloadErrorEventLike) => void {
  const navigate = options?.navigate ?? ((url: string) => window.location.replace(url));
  return (event: PreloadErrorEventLike) => {
    const payload = event.payload;
    const message = payload instanceof Error ? payload.message : String(payload || '');

    // 不处理外部 CDN / 跨域的导入失败，让错误正常抛出（import() 会 reject 而非 resolve undefined）
    if (shouldSkipPreloadRecovery(message)) {
      return;
    }

    event.preventDefault?.();

    try {
      const currentKey = recoveryKey();
      const previousKey = window.sessionStorage.getItem(RECOVERY_SESSION_KEY);
      if (previousKey === currentKey) {
        // 同一路径已尝试过刷新，避免无限循环
        console.error('[HMDao] Dynamic module reload recovery already attempted for this path.', event);
        return;
      }
      window.sessionStorage.setItem(RECOVERY_SESSION_KEY, currentKey);
    } catch {
      // 存储失败则继续一次刷新尝试
    }

    console.warn('[HMDao] Dynamic module fetch failed. Reloading the page with a cache-busting token to sync the latest asset manifest.', event);
    navigate(buildRecoveryUrl());
  };
}

/** 在浏览器中安装全局错误恢复监听（main.tsx 调用） */
export function installPreloadRecovery(): void {
  if (typeof window === 'undefined') return;

  const handler = createPreloadErrorHandler();
  window.addEventListener('vite:preloadError', handler as EventListener);

  // 页面恢复（bfcache / 前进后退）后清除标记，使下一次失败能重新触发刷新
  window.addEventListener('pageshow', () => {
    try {
      window.sessionStorage.removeItem(RECOVERY_SESSION_KEY);
    } catch {
      // ignore
    }
  });
}
