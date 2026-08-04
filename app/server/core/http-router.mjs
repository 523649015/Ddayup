/**
 * 轻量 HTTP 路由注册表（零依赖，替代 hmdao-api.mjs 中 2000+ 行的顺序 if 链）。
 *
 * 设计目标：
 * 1. 精确路径 O(1) 查表命中，前缀/正则按注册顺序回退，避免 86 分支线性比较；
 * 2. 与旧 if 链行为完全一致：未命中时返回 false，由调用方回落 legacy 分发；
 * 3. 注册期冲突检测，防止迁移过程中同一路由被重复注册导致静默覆盖。
 *
 * handler 签名：(req, res, url) => any | Promise<any>
 */

const ALL_METHODS = '*';

/**
 * HTTP 方法大写归一化的记忆化缓存。
 * node 传入的 req.method 恒为大写，但直接调用 toUpperCase() 仍会在热路径产生
 * 字符串分配；HTTP 动词是极小的有限集合，用 Map 记忆化后为零分配查表。
 */
const METHOD_UPPER_CACHE = new Map();

function upperMethod(value) {
  const raw = typeof value === 'string' ? value : String(value || '');
  const cached = METHOD_UPPER_CACHE.get(raw);
  if (cached !== undefined) return cached;
  const upper = raw.toUpperCase();
  // 上限保护：避免恶意构造的畸形 method 无限撑大缓存。
  if (METHOD_UPPER_CACHE.size < 64) METHOD_UPPER_CACHE.set(raw, upper);
  return upper;
}

function normalizeMethods(method) {
  if (!method || method === ALL_METHODS) return [ALL_METHODS];
  const list = Array.isArray(method) ? method : [method];
  return list
    .map((m) => String(m || '').trim().toUpperCase())
    .filter(Boolean);
}

export function createHttpRouter(options = {}) {
  const name = String(options.name || 'router');
  /**
   * 两级 Map：method -> (pathname -> entry)。
   * 刻意不使用 `${method} ${pathname}` 复合字符串键——那会在每次请求解析时产生
   * 一次字符串拼接分配，实测使热路径开销增加约 2.5 倍。两级查表为零分配。
   * @type {Map<string, Map<string, {handler: Function, meta: object}>>}
   */
  const exact = new Map();

  function bucketFor(method, create) {
    let bucket = exact.get(method);
    if (!bucket && create) {
      bucket = new Map();
      exact.set(method, bucket);
    }
    return bucket;
  }
  /** @type {Array<{methods: string[], prefix: string, handler: Function, meta: object}>} */
  const prefixes = [];
  /** @type {Array<{methods: string[], regex: RegExp, handler: Function, meta: object}>} */
  const patterns = [];

  function assertHandler(handler, label) {
    if (typeof handler !== 'function') {
      throw new Error(`[${name}] handler for ${label} must be a function`);
    }
  }

  /**
   * 注册精确路径路由。
   * @param {string|string[]} method HTTP 方法，或 '*' 表示任意方法
   * @param {string} pathname 完整路径（如 '/api/health'）
   */
  function register(method, pathname, handler, meta = {}) {
    assertHandler(handler, pathname);
    const methods = normalizeMethods(method);
    const entry = { handler, meta };
    for (const m of methods) {
      const bucket = bucketFor(m, true);
      if (bucket.has(pathname)) {
        throw new Error(`[${name}] duplicate route registration: ${m} ${pathname}`);
      }
      bucket.set(pathname, entry);
    }
    return api;
  }

  /**
   * 注册前缀路由（对应旧代码的 url.pathname.startsWith(...)）。
   * 前缀之间若存在互相包含关系会抛错，避免顺序敏感的静默行为变化。
   */
  function registerPrefix(method, prefix, handler, meta = {}) {
    assertHandler(handler, prefix);
    const methods = normalizeMethods(method);
    for (const existing of prefixes) {
      const methodOverlap = existing.methods.includes(ALL_METHODS)
        || methods.includes(ALL_METHODS)
        || existing.methods.some((m) => methods.includes(m));
      if (!methodOverlap) continue;
      if (existing.prefix.startsWith(prefix) || prefix.startsWith(existing.prefix)) {
        throw new Error(`[${name}] ambiguous prefix routes: "${prefix}" vs "${existing.prefix}"`);
      }
    }
    prefixes.push({ methods, prefix, handler, meta });
    return api;
  }

  /** 注册正则路由（对应旧代码的 url.pathname.match(/.../)），match 结果挂到 req._routeMatch。 */
  function registerPattern(method, regex, handler, meta = {}) {
    assertHandler(handler, String(regex));
    patterns.push({ methods: normalizeMethods(method), regex, handler, meta });
    return api;
  }

  function methodAllowed(methods, reqMethod) {
    return methods.includes(ALL_METHODS) || methods.includes(reqMethod);
  }

  /** 查找匹配的 handler，不执行。用于测试与路由自省。 */
  function resolve(reqMethod, pathname) {
    const m = upperMethod(reqMethod);
    const hit = exact.get(m)?.get(pathname) ?? exact.get(ALL_METHODS)?.get(pathname);
    if (hit) return { kind: 'exact', handler: hit.handler, meta: hit.meta };
    for (const p of prefixes) {
      if (methodAllowed(p.methods, m) && pathname.startsWith(p.prefix)) {
        return { kind: 'prefix', handler: p.handler, meta: p.meta };
      }
    }
    for (const p of patterns) {
      if (!methodAllowed(p.methods, m)) continue;
      const match = pathname.match(p.regex);
      if (match) return { kind: 'pattern', handler: p.handler, meta: p.meta, match };
    }
    return null;
  }

  /**
   * 分发请求。命中返回 true（handler 已执行），未命中返回 false 交由 legacy 链处理。
   */
  async function dispatch(req, res, url) {
    const found = resolve(req.method, url.pathname);
    if (!found) return false;
    if (found.match) req._routeMatch = found.match;
    await found.handler(req, res, url);
    return true;
  }

  /** 返回已注册路由清单（测试/文档用）。 */
  function list() {
    const out = [];
    for (const [method, bucket] of exact) {
      for (const pathname of bucket.keys()) {
        out.push({ kind: 'exact', route: `${method} ${pathname}` });
      }
    }
    for (const p of prefixes) out.push({ kind: 'prefix', route: `${p.methods.join('|')} ${p.prefix}*` });
    for (const p of patterns) out.push({ kind: 'pattern', route: `${p.methods.join('|')} ${p.regex}` });
    return out;
  }

  function size() {
    let exactCount = 0;
    for (const bucket of exact.values()) exactCount += bucket.size;
    return exactCount + prefixes.length + patterns.length;
  }

  const api = { register, registerPrefix, registerPattern, resolve, dispatch, list, size };
  return api;
}

export default createHttpRouter;
