// MV3 容错：将本应易失的内存状态（网络捕获素材 + 源页标签）持久化到 chrome.storage.local，
// 使 Service Worker 被浏览器随时终止重启后，仍可从上次快照恢复，而非整段丢失。
// 由 background.js 通过 importScripts 引入（普通 SW 不能用 ES import）。
// 仅依赖 chrome.storage.local；序列化/反序列化均为纯函数，便于单测。

const MV3_STATE_KEY = 'hmdao_mv3_state';

/** 把内存态序列化为可 JSON 存储的纯对象（过滤无效项） */
function serializeMv3State(networkAssets, sourceTabId) {
  const assets = {};
  if (networkAssets && typeof networkAssets === 'object') {
    for (const tabId of Object.keys(networkAssets)) {
      const arr = Array.isArray(networkAssets[tabId]) ? networkAssets[tabId] : [];
      const clean = arr
        .filter((a) => a && typeof a.url === 'string')
        .map((a) => ({ url: a.url, type: typeof a.type === 'string' ? a.type : 'unknown' }));
      if (clean.length) assets[tabId] = clean;
    }
  }
  return {
    v: 1,
    assets,
    sourceTabId: typeof sourceTabId === 'number' ? sourceTabId : null,
  };
}

/** 把存储的原始值安全还原为内存态（任何损坏都回退到空态，不抛错） */
function deserializeMv3State(raw) {
  if (!raw || typeof raw !== 'object') return { assets: {}, sourceTabId: null };
  const assets = raw.assets && typeof raw.assets === 'object' ? raw.assets : {};
  const sourceTabId = typeof raw.sourceTabId === 'number' ? raw.sourceTabId : null;
  return { assets, sourceTabId };
}

/** 持久化当前内存态 */
async function persistMv3State(networkAssets, sourceTabId) {
  try {
    await chrome.storage.local.set({ [MV3_STATE_KEY]: serializeMv3State(networkAssets, sourceTabId) });
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
    return { assets: {}, sourceTabId: null };
  }
}

// 兼容 importScripts：同时挂到 self，确保 background.js 作用域内可调用
if (typeof self !== 'undefined') {
  self.serializeMv3State = serializeMv3State;
  self.deserializeMv3State = deserializeMv3State;
  self.persistMv3State = persistMv3State;
  self.restoreMv3State = restoreMv3State;
}
