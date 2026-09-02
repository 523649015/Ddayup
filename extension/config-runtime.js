// Ddayup 扩展运行时配置 · 唯一真实数据源（普通脚本，挂 window.DdayupConfig）
// 供非 ESM 上下文（sidepanel.js / license.js）使用；config.js 作为 ESM 薄代理复用本实现。
// 所有 apiBase 读取/写入逻辑仅此一份，避免多文件内联导致的漂移。
(function () {
  const DEFAULT_API_BASE = 'http://127.0.0.1:3000';
  const STORAGE_KEY = 'ddayupApiBase';

  // 上架模式：true=免费版（试用过期不阻断核心功能，仅提示，符合 Edge 审核要求）。接真实支付后改 false。
  const FREE_MODE = true;
  const NATIVE_HOST_NAME = 'com.ddayup.host';

  let cache = null;
  const API_KEY_STORAGE = 'ddayupApiKey';
  let apiKeyCache = null;

  // 同步读取：优先用已填充的 cache；否则返回 null，由调用方回退默认地址。
  function getApiBaseSync() {
    if (cache) return cache;
    return null;
  }

  async function getApiBase() {
    if (cache) return cache;
    try {
      const res = await chrome.storage.local.get(STORAGE_KEY);
      const v = res && res[STORAGE_KEY];
      if (v && typeof v === 'string' && /^https?:\/\//.test(v)) {
        cache = v.replace(/\/+$/, '');
        return cache;
      }
    } catch {
      // 忽略：保持默认
    }
    cache = DEFAULT_API_BASE;
    return cache;
  }

  async function setApiBase(base) {
    const v = (base || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(v)) return false;
    cache = v;
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: v });
      return true;
    } catch {
      return false;
    }
  }

  function defaultApiBase() {
    return DEFAULT_API_BASE;
  }

  // 运维 API Key（云端部署时用于受 HMDAO_API_KEY 保护的 install 等写操作）。仅本地存储，不上报。
  async function getApiKey() {
    if (apiKeyCache !== null) return apiKeyCache;
    try {
      const res = await chrome.storage.local.get(API_KEY_STORAGE);
      apiKeyCache = (res && res[API_KEY_STORAGE]) || '';
      return apiKeyCache;
    } catch {
      return '';
    }
  }

  async function setApiKey(key) {
    apiKeyCache = (key || '').trim();
    try {
      if (apiKeyCache) await chrome.storage.local.set({ [API_KEY_STORAGE]: apiKeyCache });
      else await chrome.storage.local.remove(API_KEY_STORAGE);
      return true;
    } catch {
      return false;
    }
  }

  window.DdayupConfig = {
    DEFAULT_API_BASE,
    STORAGE_KEY,
    API_KEY_STORAGE,
    FREE_MODE,
    NATIVE_HOST_NAME,
    getApiBase,
    getApiBaseSync,
    setApiBase,
    getApiKey,
    setApiKey,
    defaultApiBase,
  };
})();
