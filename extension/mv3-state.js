// MV3 容错：将本应易失的内存状态（网络捕获素材 + 源页标签）持久化到 chrome.storage.local，
// 使 Service Worker 被浏览器随时终止重启后，仍可从上次快照恢复，而非整段丢失。
// 由 background.js 通过 importScripts 引入（普通 SW 不能用 ES import）。
// 仅依赖 chrome.storage.local；序列化/反序列化均为纯函数，便于单测。

const MV3_STATE_KEY = 'hmdao_mv3_state';

/** 把内存态序列化为可 JSON 存储的纯对象（过滤无效项） */
function serializeMv3State(networkAssets, sourceTabId, assetUrls) {
  const assets = {};
  if (networkAssets && typeof networkAssets === 'object') {
    for (const tabId of Object.keys(networkAssets)) {
      const arr = Array.isArray(networkAssets[tabId]) ? networkAssets[tabId] : [];
      const clean = arr
        .filter((a) => a && typeof a.url === 'string')
        .map((a) => ({
          url: a.url,
          type: typeof a.type === 'string' ? a.type : 'unknown',
          // 保留捕获时间戳：用于「重新加载侧栏时清理过期素材」判断素材新旧
          ts: typeof a.ts === 'number' ? a.ts : null,
        }));
      if (clean.length) assets[tabId] = clean;
    }
  }
  // ★2026-08-23 修复（问题3「刷新/切 tab 清空丢失」深层根因）：
  //   NETWORK_ASSETS_URL（tabId -> 上次扫描页 URL）此前【不持久化】，SW 被终止重启后丢失，
  //   scanTab 里 `!prevUrl` 恒真 → 每次扫描都清空源页累积 → 刷新后 URL 全丢。
  //   现将 urlMap 一并持久化，使「同 URL 刷新不清空、真正换页才清空」的语义跨 SW 重启依然成立。
  const urlMap = {};
  if (assetUrls && typeof assetUrls === 'object') {
    for (const tabId of Object.keys(assetUrls)) {
      if (typeof assetUrls[tabId] === 'string' && assetUrls[tabId]) urlMap[tabId] = assetUrls[tabId];
    }
  }
  return {
    v: 2,
    assets,
    urlMap,
    sourceTabId: typeof sourceTabId === 'number' ? sourceTabId : null,
  };
}

/** 把存储的原始值安全还原为内存态（任何损坏都回退到空态，不抛错） */
function deserializeMv3State(raw) {
  if (!raw || typeof raw !== 'object') return { assets: {}, urlMap: {}, sourceTabId: null };
  const assets = raw.assets && typeof raw.assets === 'object' ? raw.assets : {};
  const urlMap = raw.urlMap && typeof raw.urlMap === 'object' ? raw.urlMap : {};
  const sourceTabId = typeof raw.sourceTabId === 'number' ? raw.sourceTabId : null;
  return { assets, urlMap, sourceTabId };
}

/** 持久化当前内存态 */
async function persistMv3State(networkAssets, sourceTabId, assetUrls) {
  try {
    await chrome.storage.local.set({ [MV3_STATE_KEY]: serializeMv3State(networkAssets, sourceTabId, assetUrls) });
  } catch (_) {
    // 存储不可用时忽略（MV3 限制）
  }
}

/** 恢复上次持久化的内存态 */
async function restoreMv3State() {
  try {
    const res = await chrome.storage.local.get(MV3_STATE_KEY);
    return deserializeMv3State(res && res[MV3_STATE_KEY]);
  } catch (_) {
    return { assets: {}, urlMap: {}, sourceTabId: null };
  }
}

// 兼容 importScripts：同时挂到 self，确保 background.js 作用域内可调用
if (typeof self !== 'undefined') {
  self.serializeMv3State = serializeMv3State;
  self.deserializeMv3State = deserializeMv3State;
  self.persistMv3State = persistMv3State;
  self.restoreMv3State = restoreMv3State;
}
