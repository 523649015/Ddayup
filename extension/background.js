// MV3 Service Worker
//  - 被动观察网络响应，捕获引擎加载的 GLB / 视频流 / 音频缓冲（content script 抓不到）
//  - 接收 Web App 外部消息（externally_connectable），打开侧栏并扫描当前页
//  - 接收侧栏的导入指令，转发给 HMDao Web App 标签页
// 二进制魔数校验 + 下载型 API 识别（与 Node 测试共用，避免算法漂移）
try { importScripts('model-magic.js'); } catch (_) {}
try { importScripts('mv3-state.js'); } catch (_) {}
try { importScripts('shared/messages.js'); } catch (_) {}
// 规则层：Referer 注入 / 音频 CORS / 域名工具 / 捕获扩展名白名单（详见 rules.js）
try { importScripts('rules.js'); } catch (_) {}
// 轮询层：去抖重扫 / 视频站主动轮询（详见 polling.js）
try { importScripts('polling.js'); } catch (_) {}
// 消息路由表（D1 基础设施，详见 router.js）：已注册 handler 优先接管，未命中走下方 if 链
try { importScripts('router.js'); } catch (_) {}
// 扫描层：scanTab（深度直链解析 + 页面 DOM 解析）与 scanPage（注入 ISOLATED 世界的页面解析），详见 scan.js
try { importScripts('scan.js'); } catch (_) {}
const NETWORK_ASSETS = {}; // tabId -> [{ url, type }]
// 最近一次扫描/捕获的源标签页 ID。播放音频需在该标签页上下文里 <audio> 才能拿到
// 正确的 Referer/Cookie；若仍用 chrome.tabs.query({active:true})，用户在侧栏打开
// 后切到 HMDao/其它标签就会注入到错误上下文，hover 试听静默失败。
let SOURCE_TAB_ID = null;

// ===== P0-2: MV3 容错 —— SW 重启后恢复易失状态 =====
// NETWORK_ASSETS / SOURCE_TAB_ID 是模块级内存变量，SW 被终止即丢失。
// 周期快照写入 chrome.storage.local，并在每次唤醒时恢复，避免整段状态丢失。
(function restoreMv3OnWake() {
  try {
    restoreMv3State()
      .then((st) => {
        // ★竞态修复：restore 是异步的。SW 被 webRequest 事件唤醒时，captureNetworkAsset
        // 可能已先写入了【新捕获】（如用户正点击爱给试听）；原实现「清空→覆盖旧快照」
        // 会把这些新资产吞掉 → “听到了却采不到”。改为快照打底 + 合并唤醒后新增。
        const freshNow = {};
        for (const k of Object.keys(NETWORK_ASSETS)) freshNow[k] = NETWORK_ASSETS[k].slice();
        Object.keys(NETWORK_ASSETS).forEach((k) => delete NETWORK_ASSETS[k]);
        Object.assign(NETWORK_ASSETS, st.assets || {});
        for (const k of Object.keys(freshNow)) {
          const list = NETWORK_ASSETS[k] || (NETWORK_ASSETS[k] = []);
          for (const item of freshNow[k]) {
            if (!list.some((x) => x.url === item.url)) list.push(item);
          }
        }
        if (typeof st.sourceTabId === 'number') SOURCE_TAB_ID = st.sourceTabId;
      })
      .catch(() => {});
  } catch (_) {}
})();

// 周期持久化（SW 被终止前的最后一次快照可被恢复）
setInterval(() => {
  try { void persistMv3State(NETWORK_ASSETS, SOURCE_TAB_ID); } catch (_) {}
}, 3000);

// ===== 统一 build 汇总（跨组件：background / sidepanel / detect / inject-main） =====
// 各组件启动/加载时向 background 上报自身 build 标记，background 作为单一真理源；
// Web App 经 detect.js 转发 HMDAO_GET_BUILDS 即可一次拿到全部组件 build，一眼分辨新旧。
const HMDAO_BACKGROUND_BUILD = '2026-07-28-bg-v3';
const HMDAO_BUILDS = {
  background: HMDAO_BACKGROUND_BUILD,
  sidepanel: null,
  detect: null,
  injectMain: null,
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// ===== 规则层（Referer 注入 / 音频 CORS / 域名工具 / 捕获扩展名白名单）=====
// 已抽取到 rules.js，由上方 importScripts('rules.js') 引入，避免 background.js 过度臃肿。
// 此处保留网络捕获核心：captureNetworkAsset 依赖 scheduleRescan（本文件后续定义）与
// rules.js 提供的 MODEL_EXT_RE / ARCHIVE_EXT_RE / dispositionsFilename / registeredDomain。

function captureNetworkAsset(details) {
  if (details.tabId < 0) return;
  const url = details.url || '';
  if (!url) return;
  let type = null;
  if (/\.(mp4|webm|mov|m4v|mkv|ogv|m3u8|flv|avi|wmv|ts|mpg|mpeg|3gp|rm|rmvb|asf|vob|m2ts|f4v|m4s)(\?|$)/i.test(url)) type = 'video';
  else if (/\.(mp3|wav|flac|aac|m4a|ogg|opus|wma)(\?|$)/i.test(url)) type = 'audio';
  else if (MODEL_EXT_RE.test(url)) type = 'model';
  else if (ARCHIVE_EXT_RE.test(url)) type = 'archive';
  if (!type && details.responseHeaders) {
    const ct = (details.responseHeaders.find((h) => h.name.toLowerCase() === 'content-type') || {}).value || '';
    if (/^audio\//i.test(ct)) type = 'audio';
    else if (/^video\//i.test(ct)) type = 'video';
    else if (/^model\//i.test(ct)) type = 'model';
    else if (/octet-stream|application\/download|binary/i.test(ct)) {
      const fn = dispositionsFilename(details.responseHeaders);
      if (MODEL_EXT_RE.test(fn)) type = 'model';
      else if (ARCHIVE_EXT_RE.test(fn)) type = 'archive';
    }
  }
  // URL 无扩展名时，再用 Content-Disposition 文件名兜底（很多下载接口走 /api/download?id=）
  if (!type) {
    const fn = dispositionsFilename(details.responseHeaders);
    if (MODEL_EXT_RE.test(fn)) type = 'model';
    else if (ARCHIVE_EXT_RE.test(fn)) type = 'archive';
  }
  // YouTube 实际播放流：googlevideo.com/videoplayback（无扩展名、带 range 分段），
  // 既不在扩展名白名单、又会被下方「分片」过滤排除。单独处理：strip range 得整文件直链，
  // 按 mime 参数区分 audio/video 入库并触发 rescan（与 inject-main 的 ytPlay 双保险）。
  if (/googlevideo\.com\/videoplayback/.test(url)) {
    try {
      const u = new URL(url);
      // 仅捕获真实 DASH 流（带 itag / mime 参数）。YouTube 的 storyboard/缩略图请求也走
      // googlevideo.com/videoplayback 但无 itag/mime，且 expire 字段异常，不可作下载源，须排除。
      if (!u.searchParams.has('itag') && !u.searchParams.has('mime')) return;
      // 与 inject-main 一致：删除 DASH 分段/序列参数，得到整文件直链（否则只抓到 sq=N 单片）
      ['range', 'sq', 'rqh', 'rn', 'rbq'].forEach((k) => u.searchParams.delete(k));
      const mime = u.searchParams.get('mime') || '';
      const ytType = /^audio\//.test(mime) ? 'audio' : 'video';
      const clean = u.toString();
      const yl = NETWORK_ASSETS[details.tabId] || (NETWORK_ASSETS[details.tabId] = []);
      if (!yl.some((x) => x.url === clean)) {
        yl.push({ url: clean, type: ytType, source: 'youtube' });
        scheduleRescan(details.tabId);
      }
    } catch (_) {}
    return;
  }
  if (!type) return;
  // 排除 MSE / HLS 的细碎分片（segment / chunk / init / .m4s），避免列表被污染。
  // ★修复（断点 B/H）：抖音/B站真实视频流常是「无扩展名 + 带 range=/m4s 参数」的 CDN URL，
  // 原过滤会把这些真实 media 流整行丢弃 → 视频/音效采不到。
  // 改为：type 已是媒体/模型（即 content-type 已确认为 video/audio/model）→ 即便带分片参数也保留。
  const isMediaType = type === 'video' || type === 'audio' || type === 'model';
  if (!isMediaType &&
      !/\.(mp3|mp4|m4a|wav|flac|aac|ogg|webm|mov|mkv|ogv|m3u8|flv|avi|wmv|ts|mpg|mpeg|3gp|rm|rmvb|asf|vob|m2ts|f4v|glb|gltf|zip|rar|7z|fbx|obj|max|blend|c4d|dae|ply|3ds|skp|stl|usdz)(\?|$)/i.test(url) &&
      /[?&](segment|chunk|fragment|init=|m4s|range=\d+-\d+)/i.test(url)) return;
  const list = NETWORK_ASSETS[details.tabId] || (NETWORK_ASSETS[details.tabId] = []);
  if (!list.some((x) => x.url === url)) {
    list.push({ url, type });
    if (list.length > 500) list.shift();
    // 新增音视频 / 3D / 归档资产 → 去抖触发侧栏自动刷新，无需手动重新扫描
    if (type === 'audio' || type === 'video' || type === 'model' || type === 'archive') scheduleRescan(details.tabId);
  }
  // 技术验证 1：标记下载型 API 端点（路径含 /download /resource /package 等）。
  // 这些 XHR/fetch 的「响应」才是真实模型文件地址（往往经签名/重定向），
  // DOM / URL 后缀匹配都抓不到，必须靠网络层捕获 + 后续落盘。供侧栏标注「本页暴露了模型下载接口」。
  if (typeof DOWNLOAD_API_RE !== 'undefined' &&
      (details.type === 'xmlhttprequest' || details.type === 'fetch' || details.type === 'other') &&
      DOWNLOAD_API_RE.test(url)) {
    if (!list.some((x) => x.url === url && x.source === 'download-api')) {
      list.push({ url, type: 'api', source: 'download-api' });
      scheduleRescan(details.tabId);
    }
  }
}
chrome.webRequest.onResponseStarted.addListener(
  captureNetworkAsset,
  { urls: ['<all_urls>'] },
  ['responseHeaders', 'extraHeaders'],
);
chrome.webRequest.onCompleted.addListener(
  captureNetworkAsset,
  { urls: ['<all_urls>'] },
  ['responseHeaders', 'extraHeaders'],
);

chrome.downloads.onCreated.addListener((item) => {
  const url = item.url || item.finalUrl || '';
  const fn = item.filename || '';
  let type = null;
  // 百度网盘等：下载 URL 是重定向 dlink（无扩展名），真实文件名靠 Content-Disposition 携带 → 用文件名识别。
  if (MODEL_EXT_RE.test(url) || MODEL_EXT_RE.test(fn)) type = 'model';
  else if (ARCHIVE_EXT_RE.test(url) || ARCHIVE_EXT_RE.test(fn)) type = 'archive';
  if (!type) return;
  // 关联到「来源页」：优先按 referrer 的注册域匹配已打开标签，否则用当前激活标签。
  // 旧代码 fallback 用了 item.id（下载项 id，非标签 id）→ 资产存错 key，永不进入侧栏扫描。
  const refDomain = (() => { try { return registeredDomain(new URL(item.referrer || '').hostname); } catch (_) { return ''; } })();
  chrome.tabs.query({}, (tabs) => {
    const all = (tabs || []);
    let hit = refDomain ? all.find((t) => { try { return registeredDomain(new URL(t.url || '').hostname) === refDomain; } catch (_) { return false; } }) : null;
    if (!hit) hit = (all.filter((t) => t.active && t.windowId != null)[0]) || all[0];
    const tabId = hit ? hit.id : null;
    if (typeof tabId !== 'number') return;
    const list = NETWORK_ASSETS[tabId] || (NETWORK_ASSETS[tabId] = []);
    if (!list.some((x) => x.url === url)) {
      list.push({ url, type });
      scheduleRescan(tabId);
    }
  });
});

// registeredDomain（注册域解析）已随规则层移入 rules.js（importScripts 引入），
// 此处 pickSourceTabForUrl 直接复用其全局定义。

// 为某音频 URL 挑选「源页标签」执行 MAIN world fetch（决定 Referer 上下文）。
// 关键：MV3 Service Worker 会被浏览器随时终止重启，NETWORK_ASSETS / SOURCE_TAB_ID
// 是模块级全局变量，重启后即丢失 → 若只靠它们，点试听时会在错误上下文(错误 Referer)拉取 → CDN 403。
// 故按「音频所属站点的注册域」在所有打开标签里找正确的源页标签，优先顺序：
//   1) 网络层确实捕获过该 URL 的标签（最准）
//   2) SOURCE_TAB_ID（侧栏扫描时记录的源页）
//   3) 与音频同注册域的任意打开标签（抗 SW 重启/切标签）
//   4) 当前激活标签（兜底）
async function pickSourceTabForUrl(wanted) {
  const wantDomain = registeredDomain((() => { try { return new URL(wanted).hostname; } catch (_) { return ''; } })());
  const isHttp = (u) => /^https?:/i.test(u || '');
  // 收集「同注册域 + http(s)」的候选源页（彻底排除 chrome-extension / chrome:// 等扩展页，
  // 否则侧栏自身页面或当前激活的扩展页会被误当成源页 → 在错误上下文(错误 Referer)拉取 → 防盗链失败）。
  let candidates = [];
  try {
    const all = await chrome.tabs.query({});
    candidates = (all || []).filter((t) => isHttp(t.url) && (!wantDomain || registeredDomain(new URL(t.url).hostname) === wantDomain));
  } catch (_) {}
  // 1) 优先：该标签的网络捕获里确实含此直链（最准，且仅限 http(s) 候选）
  for (const t of candidates) {
    const list = NETWORK_ASSETS[t.id];
    if (list && list.some((x) => x.url === wanted)) return t.id;
  }
  // 2) 记录的源页：仅当它是 http(s) 且与目标同注册域（侧栏打开时可能把 SOURCE_TAB_ID 设成扩展页，需过滤）
  if (typeof SOURCE_TAB_ID === 'number' && SOURCE_TAB_ID != null) {
    try {
      const t = await chrome.tabs.get(SOURCE_TAB_ID);
      if (t && isHttp(t.url) && (!wantDomain || registeredDomain(new URL(t.url).hostname) === wantDomain)) return t.id;
    } catch (_) { /* 标签已关 */ }
  }
  // 3) 同注册域的任意打开标签（抗 SW 重启/切标签）
  if (candidates.length) return candidates[0].id;
  // 4) 兜底：当前激活的「同域 http(s)」标签
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const hit = (tabs || []).find((t) => isHttp(t.url) && (!wantDomain || registeredDomain(new URL(t.url).hostname) === wantDomain));
    if (hit) return hit.id;
  } catch (_) {}
  return null;
}

// deriveRefererForUrl 已随规则层移入 rules.js（importScripts 引入），此处直接复用其全局定义。

// ===== 音频抓取通用「Referer + 响应 CORS」放行规则 =====
// 真实爱给等 CDN 的防盗链会在【第三方域名】上校验 Referer 与登录态：
//   · 缺 Referer / 无登录 Cookie → 伪 200 返回 HTML（got-html-not-audio）。
//   · 浏览器 <audio> 能播是因为它自动带「页面 Referer + 同站 Cookie」；
//     而扩展 fetch 跨源既无 Cookie、Referer 又是禁设头、且响应无 ACAO 导致读不到 body。
// 用 declarativeNetRequest 在网络层同时：
//   · requestHeaders.set referer —— 绕过防盗链（缺失即 HTML/403）。
//   · requestHeaders.set cookie（可选，YouTube 用）—— 显式注入 youtube 会话 Cookie，
//     使 googlevideo 直链鉴权通过，且【不】触发「Third-party cookie will be blocked」告警
//     （告警来自浏览器自动附加第三方 Cookie 的机制；我们显式注入即不再依赖它）。
//   · responseHeaders.set ACAO/ACAC —— 让跨源 fetch 能 READ 字节（否则 CORS 拦）。
// 注意：对【第三方域名】改写请求/响应头必须声明 declarativeNetRequestWithHostAccess 权限，
//       否则 Chrome 会静默忽略规则（这正是此前本地能过、真实 aigei 却 got-html 的根因）。
// 音频 CORS 放行规则（installAudioCorsRule / removeAudioCorsRule / getYoutubeCookieHeader /
// extOrigin / HMDAO_DNR_AUDIO_RULE_ID）已随规则层移入 rules.js，此处 fetchAudioViaBackground
// 直接复用其全局定义。

// 【主路径】扩展 SW 直接 fetch 音频字节：
//   · credentials:'include' 送源站登录 Cookie（与浏览器 <audio> 行为一致）。
//   · dNR 注入 Referer + 响应 ACAO/ACAC（见 installAudioCorsRule）。
//   · 含魔数校验（伪 200 HTML 防盗链页会被识别为失败）与 MIME 按扩展名补正。
async function fetchAudioViaBackground(url, referer) {
  let host = '';
  try { host = new URL(url).hostname; } catch (_) { return { ok: false, error: 'bad-url' }; }
  const domain = registeredDomain(host) || host;
  try {
    await installAudioCorsRule(domain, referer, extOrigin());
    // 注意：签名 URL（?token=）绝不能附加 cache-buster 参数，会破坏签名导致 403。
    const r = await fetch(url, { credentials: 'include', cache: 'no-store' });
    if (!r.ok) return { ok: false, status: r.status, error: 'http-' + r.status + (r.status === 403 ? ' (Referer被拒或签名过期)' : '') };
    const bytes = new Uint8Array(await r.arrayBuffer());
    const head = String.fromCharCode.apply(null, Array.from(bytes.slice(0, 64)));
    if (/^\s*(<!doctype|<html|<head|<\?xml|\{)/i.test(head)) {
      return { ok: false, error: 'got-html-not-audio', headSample: head.slice(0, 40) };
    }
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
    }
    const b64 = btoa(binary);
    let mime = (r.headers.get('content-type') || '').split(';')[0].trim();
    if (!/^audio\//.test(mime)) {
      const ext = (url.split('?')[0].match(/\.([a-z0-9]+)$/i) || [])[1] || '';
      const map = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/ogg', weba: 'audio/webm' };
      mime = map[ext.toLowerCase()] || mime || 'audio/mpeg';
    }
    return { ok: true, mime, b64, size: bytes.length };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    await removeAudioCorsRule();
  }
}

// 来自 Web App（http://127.0.0.1:3000）的外部消息
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === HMDAO_MSG.OPEN_SCAN && sender.tab && sender.tab.id) {
    chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {});
    scanTab(sender.tab.id);
    sendResponse({ ok: true });
  }
});

// 来自扩展侧栏（内部消息）
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // D1 路由表优先分发：仅当存在已注册 handler 时才交由 dispatchMessage 接管，
  // 并直接返回其同步布尔结果（true=异步保持通道）；未注册类型走下方原 if 链。
  if (typeof hasHandler === 'function' && hasHandler(msg)) {
    return dispatchMessage(msg, _sender, sendResponse);
  }
  // ===== 以下分支已迁移至 router.js（D1 路由表），由 hasHandler/dispatchMessage 优先接管 =====
  // - REPORT_BUILD / GET_BUILDS / PAGE_MUTATION
  // - NETDISK_RESOLVE
  // - CLICK_REVEAL / PANEL_CLOSED / DEBUG_NETWORK
  // 侧栏切换活动标签（P2 串素材修复）：停掉所有旧 tab 轮询，仅对当前 tab 启动轮询
  if (msg && msg.type === 'HMDAO_SWITCH_TAB') {
    const newTabId = msg.tabId;
    try {
      Object.keys(POLL_TIMERS).forEach((tid) => {
        const n = parseInt(tid, 10);
        if (n !== newTabId) stopPolling(n);
      });
      if (typeof newTabId === 'number') startPolling(newTabId);
    } catch (_) {}
    return;
  }
  // 侧栏打开时请求扫描当前标签页
  if (msg && msg.type === HMDAO_MSG.SCAN_REQUEST) {
    chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
      // 支持显式 tabId（侧栏/测试精确指定扫描目标）；无则回退 active tab / 上次源页
      let targetId = (typeof msg.tabId === 'number') ? msg.tabId
        : (tab && tab.id) ? tab.id : SOURCE_TAB_ID;
      // ★P2 健壮性：active tab 取不到（侧栏焦点/多窗口）时，回退到上次记录源页；仍无则上报明确错误。
      if (!targetId) {
        console.warn('[HMDAO][bg] SCAN_REQUEST 无可用目标 tab（active 为空且 SOURCE_TAB_ID 未记录）');
        chrome.runtime.sendMessage({ type: 'HMDAO_SCAN_RESULT', assets: [], error: 'no-target-tab' }).catch(() => {});
        return;
      }
      // 过滤不可脚本化的页面（chrome://、扩展页、file:// 等）——MV3 禁止 scripting，提前报错而非静默空结果。
      try {
        const info = await chrome.tabs.get(targetId);
        if (info && info.url && /^(chrome:|chrome-extension:|edge:|file:)/i.test(info.url)) {
          console.warn('[HMDAO][bg] 目标页不可脚本化，跳过扫描：', info.url);
          chrome.runtime.sendMessage({ type: 'HMDAO_SCAN_RESULT', assets: [], error: 'unscriptable-tab', url: info.url }).catch(() => {});
          return;
        }
      } catch (_) {}
      SOURCE_TAB_ID = targetId;
      // 首扫走深度直链解析（B），随后启动轮询（A）让流媒体稍后请求也能即时出现
      scanTab(targetId, { deep: true }).catch((e) => {
        console.warn('[HMDAO][bg] scanTab 失败：', e && e.message);
        chrome.runtime.sendMessage({ type: 'HMDAO_SCAN_RESULT', assets: [], error: 'scan-failed', message: String(e && e.message || e) }).catch(() => {});
      });
      startPolling(targetId);
    });
    return;
  }
  // 侧栏请求当前页面信息 + 缩略图预览
  if (msg && msg.type === HMDAO_MSG.CAPTURE_PAGE) {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.id) SOURCE_TAB_ID = tab.id;
        if (!tab) {
          sendResponse({ ok: false, error: 'no-active-tab' });
          return;
        }
        let thumb = null;
        try {
          thumb = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 60 });
        } catch (_) {
          // 某些受限页（chrome://、扩展页）无法截图；不阻断其他信息
        }
        sendResponse({
          ok: true,
          title: tab.title || '',
          url: tab.url || '',
          favIconUrl: tab.favIconUrl || '',
          thumb,
        });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message || err) });
      }
    })();
    return true; // 异步响应
  }
  // 侧栏点了「专业官方源」按钮：开新标签 + 加载完自动扫描
  if (msg && msg.type === HMDAO_MSG.OPEN_PRESET) {
    (async () => {
      try {
        const [cur] = await chrome.tabs.query({ active: true, currentWindow: true });
        const windowId = (cur && cur.windowId) || undefined;
        chrome.tabs.create({ url: msg.url, windowId, active: true }, (tab) => {
          if (!tab || !tab.id) return;
          const listener = (tabId, changeInfo) => {
            if (tabId !== tab.id) return;
            if (changeInfo.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener);
              scanTab(tab.id, { deep: true }).catch(() => {});
              startPolling(tab.id);
              // 尝试打开侧栏（用户已激活过扩展图标，该窗口内的 sidePanel.open 可被允许）
              chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
          // 兜底：某些页面 load 事件不触发 onUpdated，10s 后强制扫一次
          setTimeout(() => { try { scanTab(tab.id, { deep: true }).catch(() => {}); startPolling(tab.id); } catch (_) {} }, 10000);
        });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message || err) });
      }
    })();
    return true; // 异步响应
  }
  if (msg && msg.type === HMDAO_MSG.IMPORT_TO_APP) {
    const assets = msg.assets || [];
    findHmdaoTab().then((tab) => {
      if (tab && tab.id) {
        chrome.tabs.sendMessage(tab.id, { type: HMDAO_MSG.IMPORT_ASSETS, assets }).catch(() => {});
      }
    });
    return;
  }
  // AI 助手：侧栏/网页浮标请求 → 直接 fetch Ddayup 网页后端(127.0.0.1:3000 /api/extension-ai)，密钥留在服务端。
  // 不再经 detect.js 中转，避免「内容脚本未加载 / 接收端不存在」导致聊天彻底卡死。
  // aiChatRequester 记录请求发起方：null=侧栏（用 runtime.sendMessage 回传），数字=网页 tabId（用 tabs.sendMessage 回传）
  if (msg && msg.type === HMDAO_MSG.AI_CHAT) {
    aiChatRequester = (_sender && _sender.tab && typeof _sender.tab.id === 'number') ? _sender.tab.id : null;
    const payload = msg.payload || {};
    findHmdaoTab().then((tab) => {
      const base = (tab && tab.url) ? new URL(tab.url).origin : 'http://127.0.0.1:3000';
      fetch(base + '/api/extension-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // P2.a：透传多轮对话 history，让后端拼上下文实现「记住上文再思考」
        body: JSON.stringify({
          text: payload.text || '',
          mode: payload.mode || 'chat',
          history: Array.isArray(payload.history) ? payload.history.slice(-12) : [],
        }),
      }).then((r) => r.json().catch(() => ({}))).then((d) => {
        const ok = !!(d && d.ok);
        const text = (d && d.text) || (ok ? '(空响应)' : '');
        const error = ok ? '' : ((d && (d.error || d.message)) || '请求失败');
        // P2.a：透传 thinking（模型 reasoning_content），前端以"💭 思考"展示
        forwardAiReply({ ok, text, error, thinking: (d && d.thinking) || '' });
      }).catch(() => {
        forwardAiReply({ ok: false, error: 'Ddayup 网页(127.0.0.1:3000)未响应，请确认网页已打开' });
      });
    });
    return;
  }
  // 扩展机器人上传文件（图片/视频）→ 落地画布素材库，并触发画布 SmartAgent 媒体工作流
  if (msg && msg.type === HMDAO_MSG.AGENT_UPLOAD) {
    aiChatRequester = (_sender && _sender.tab && typeof _sender.tab.id === 'number') ? _sender.tab.id : null;
    const payload = msg.payload || {};
    findHmdaoTab().then((tab) => {
      const base = (tab && tab.url) ? new URL(tab.url).origin : 'http://127.0.0.1:3000';
      const canvasTabId = tab && tab.id;
      fetch(base + '/api/extension-agent-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: payload.fileName || 'upload.bin',
          mime: payload.mime || '',
          data: payload.data || '',
          userText: payload.userText || '',
        }),
      }).then((r) => r.json().catch(() => ({}))).then((d) => {
        if (d && d.ok && d.asset) {
          // 1) 触发画布 SmartAgent 媒体工作流（经 detect.js 桥接 hmdao:run-agent-workflow）
          if (canvasTabId) {
            chrome.tabs.sendMessage(
              canvasTabId,
              {
                type: HMDAO_MSG.RUN_AGENT_WORKFLOW,
                payload: {
                  asset: d.asset,
                  userText: payload.userText || '',
                  // 扩展机器人「深度分析」标识：画布侧改用 VLM 深度分析喂给工作流，效果等同 AIDeepAnalysisPanel → 机器人
                  deepAnalyze: !!payload.deepAnalyze,
                },
              },
            ).catch(() => {});
          }
          const deep = !!payload.deepAnalyze;
          const label = d.asset.type === 'video' ? '视频推理' : (deep ? '深度分析' : '图片分析');
          forwardAiReply({ ok: true, text: `已将「${d.asset.name}」上传到画布素材库，并${deep ? '基于深度分析在' : '在'}智能体面板生成${label}工作流。` });
        } else {
          forwardAiReply({ ok: false, error: (d && (d.error || d.message)) || '上传失败' });
        }
      }).catch(() => {
        forwardAiReply({ ok: false, error: 'Ddayup 网页(127.0.0.1:3000)未响应，请确认网页已打开' });
      });
    });
    return;
  }
  if (msg && msg.type === HMDAO_MSG.AI_CHAT_REPLY) {
    forwardAiReply({ ok: !!msg.ok, text: msg.text, error: msg.error });
    return;
  }
  // 网页浮标关闭 → 清理后台记录 + 转发侧栏「回到侧栏」
  if (msg && msg.type === HMDAO_MSG.AI_BOT_RETURN) {
    if (_sender && _sender.tab && typeof _sender.tab.id === 'number') robotTabIds.delete(_sender.tab.id);
    chrome.runtime.sendMessage({ type: HMDAO_MSG.AI_BOT_RETURN }).catch(() => {});
    return;
  }
  // 侧栏查询：当前网页是否已注入浮标
  if (msg && msg.type === HMDAO_MSG.AI_BOT_STATUS) {
    sendResponse({ active: robotTabIds.has(msg.tabId) });
    return true;
  }
  // 侧栏切换：对当前网页注入 / 收回浮标（基于 robotTabIds 真实状态）
  if (msg && msg.type === HMDAO_MSG.AI_BOT_TOGGLE_PAGE) {
    const tabId = msg.tabId;
    if (typeof tabId !== 'number') { sendResponse({ state: 'error', error: '无有效标签页' }); return true; }
    if (robotTabIds.has(tabId)) {
      chrome.tabs.sendMessage(tabId, { type: HMDAO_MSG.AI_BOT_REMOVE }).catch(() => {});
      robotTabIds.delete(tabId);
      sendResponse({ state: 'removed' });
    } else {
      chrome.scripting.executeScript({ target: { tabId }, files: ['robot-overlay.js'] })
        .then(() => { robotTabIds.add(tabId); sendResponse({ state: 'injected' }); })
        .catch((e) => { sendResponse({ state: 'error', error: String((e && e.message) || e) }); });
    }
    return true; // 异步响应
  }
  // 侧栏请求抓取跨域资源字节（扩展已声明 host_permissions: <all_urls>，可绕过 CORS 读取正文）
  if (msg && msg.type === HMDAO_MSG.FETCH) {
    fetchUrl(msg).then(sendResponse);
    return true; // 异步响应，保持消息通道打开
  }
  // 后台带 Referer 的 fetch → 返回原始字节（ArrayBuffer），供侧栏转 blob 播放/下载。
  // 专门解决抖音/TikTok/视频号/CDN 防盗链视频：侧栏 <video>/<a download> 直连会因签名+Referer 被拒，
  // 改为「后台 Service Worker 注入 Referer + 注入 ACAO 响应头 → 读取跨域字节 → 回传侧栏 → 本地 blob」，
  // 完全绕过侧栏元素的签名/Referer 限制。
  if (msg && msg.type === HMDAO_MSG.FETCH_MEDIA) {
    (async () => {
      try {
        const url = msg.url || (msg.payload && msg.payload.url);
        const u = new URL(url);
        const host = u.hostname.toLowerCase();
        // Referer 取值：抖音/TikTok 系列须用 www.douyin.com；视频号用当前 host；其余用注册域
        let referer = msg.referer || '';
        if (!referer) {
          if (host.includes('douyin') || host.includes('bytedance') || host.includes('tiktok')) referer = 'https://www.douyin.com/';
          else if (host.includes('weixin') || host.includes('qq.com')) referer = 'https://' + host + '/';
          else if (host.includes('googlevideo') || host.includes('youtube')) referer = 'https://www.youtube.com/';
          else { const dom = registeredDomain(host); if (dom) referer = 'https://' + (host.startsWith('www.') ? host : 'www.' + dom) + '/'; }
        }
        // ★3D 模型（glb/gltf/obj/fbx/...）：优先在【源页 MAIN 世界】fetch 字节。
        // 源页加载模型用的就是同源凭据，跨域 CORS 天然成立；后台 dNR 改写 ACAO 反而会把页面
        // 自身的跨域抓取搞挂（报 ACAO=chrome-extension 不匹配）。故模型不走会破坏页面的 dNR 规则。
        const isModelUrl = /\.(glb|gltf|obj|fbx|stl|ply|dae|3ds|blend|max|c4d|usdz|wrl|x3d|abc|lwo|smd|vrm)(\?|$|#)/i.test(url || '');
        if (isModelUrl) {
          let srcTab = msg.tabId || null;
          if (!srcTab) { try { srcTab = await pickSourceTabForUrl(url); } catch (_) {} }
          if (!srcTab) {
            try {
              const dom = registeredDomain(host);
              const tabs = await chrome.tabs.query({});
              const m = (tabs || []).find((t) => { try { return registeredDomain(new URL(t.url).hostname) === dom; } catch (_) { return false; } });
              if (m) srcTab = m.id;
            } catch (_) {}
          }
          if (srcTab) {
            try {
              const [mr] = await chrome.scripting.executeScript({
                target: { tabId: srcTab },
                world: 'MAIN',
                func: (u) => {
                  return fetch(u, { method: 'GET', credentials: 'include' })
                    .then((r) => {
                      if (!r.ok) return { ok: false, status: r.status };
                      return r.arrayBuffer().then((ab) => {
                        let s = ''; const v = new Uint8Array(ab);
                        for (let i = 0; i < v.length; i++) s += String.fromCharCode(v[i]);
                        return { ok: true, mime: r.headers.get('content-type') || 'application/octet-stream', b64: btoa(s), size: ab.byteLength };
                      });
                    })
                    .catch((e) => ({ ok: false, error: String(e) }));
                },
                args: [url],
              });
              const mres = mr && mr.result;
              if (mres && mres.ok && mres.b64) {
                sendResponse({ ok: true, mime: mres.mime, b64: mres.b64, size: mres.size, fromPage: true });
                return true;
              }
              console.warn('[HMDAO][bg] 模型源页 fetch 失败，回退 SW dnr：', mres && (mres.error || mres.status));
            } catch (e) { console.warn('[HMDAO][bg] 模型源页 executeScript 失败：', e); }
          }
          // 回退：源页取不到 → 后台 dNR + fetch，ACAO='*' 且不加 ACAC（模型无需 Cookie，不破坏页面）
          try { await installAudioCorsRule(registeredDomain(host) || host, referer, '*', null, false); } catch (_) {}
        } else {
          // 安装 请求Referer + 响应ACAO 规则：使 SW 的 fetch 能读跨域 CDN 字节（否则 opaque → 读不到）
          // ★ACAO 用 '*' 而非扩展源：媒体 fetch 用 credentials:'omit'，'*' 合法；且不会把网页自身的
          //   跨域抓取搞挂（否则 ACAO=chrome-extension 不匹配 → 像 tripo3d 加载 GLB 那样被 CORS 拦截）。
          try { await installAudioCorsRule(registeredDomain(host) || host, referer, '*', null, false); } catch (_) {}
        }
        // 凭据策略：
        // - 抖音/TikTok/视频号：鉴权靠 URL 签名 + Referer，不需要登录 Cookie → credentials:'omit'
        //   避免触发 Chrome「第三方 Cookie 将被拦截」告警。
        // - YouTube / googlevideo：googlevideo 直链鉴权依赖 youtube.com 下发的第三方 Cookie
        //   （PREF/VISITOR_INFO1_LIVE 等，SameSite=None）。这些 Cookie 不在扩展 SW 的 Cookie 分区里，
        //   浏览器自动附加第三方 Cookie 又会触发弃用告警。做法：用 chrome.cookies 读出 → 经 dNR 注入为
        //   请求头 Cookie；页面/SW fetch 改用 credentials:'omit'（不再依赖浏览器自动附加机制，从而
        //   消除「Third-party cookie will be blocked」告警，且即使用户禁止第三方 Cookie 也能命中）。
        //   优先在【源页 youtube 标签】上下文 fetch，失败再回退 SW fetch。
        if (host.includes('googlevideo') || host.includes('youtube')) {
          // —— 最高优先级：直接查 ytBytes 缓存（播放器已下载的真实字节）——
          // 省去「在源页开 MAIN 世界 fetch→等 playerResponse→解 signatureCipher→n 反混淆」全部复杂度。
          // googlevideo URL 的注册域与 youtube 标签不同，pickSourceTabForUrl 可能找不到→改用
          // chrome.tabs.query 直接搜 youtube.com 标签（ytBytes 只存在于 youtube 页面上下文）。
          let srcTab = null;
          try { srcTab = await pickSourceTabForUrl(url); } catch (_) {}
          if (!srcTab) {
            try {
              const ytTabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
              if (ytTabs && ytTabs.length) srcTab = ytTabs[0].id;
            } catch (_) {}
          }
          if (srcTab) {
            let targetItag = null;
            try { const p = new URL(url).searchParams.get('itag'); if (p) targetItag = +p; } catch (_) {}
            const [ytCheck] = await chrome.scripting.executeScript({
              target: { tabId: srcTab },
              world: 'MAIN',
              func: (hintItag) => {
                const c = window.__hmdao_captures && window.__hmdao_captures.ytBytes;
                if (!c) return null;
                if (hintItag && c[hintItag] && c[hintItag].size >= 1024)
                  return { itag: hintItag, b64: c[hintItag].b64, mime: c[hintItag].mime || 'video/mp4', size: c[hintItag].size };
                let best = null;
                for (const k of Object.keys(c)) { if (!best || c[k].size > c[best].size) best = k; }
                if (!best || c[best].size < 1024) return null;
                return { itag: best, b64: c[best].b64, mime: c[best].mime || 'video/mp4', size: c[best].size };
              },
              args: [targetItag],
            });
            const ytRes = ytCheck && ytCheck.result;
            if (ytRes && ytRes.b64 && ytRes.size >= 1024) {
              console.log('[HMDAO][bg] FETCH_MEDIA ytBytes 缓存命中 itag=' + ytRes.itag + ' size=' + ytRes.size);
              sendResponse({ ok: true, mime: ytRes.mime, b64: ytRes.b64, size: ytRes.size, fromCache: true });
              return true;
            }
            console.log('[HMDAO][bg] FETCH_MEDIA ytBytes 为空，走源页回退：', (ytRes && 'size=' + ytRes.size) || 'null');
          }
          // 回退：源页 MAIN world fetch（需登录态 Cookie 且可能被 n 签名拒绝）
          // 关键修正：不再依赖 dNR 注入 Cookie（cookie 是 dNR 禁止修改的请求头，会令整条规则失败）。
          // 改为在【源页 youtube 标签的 MAIN 世界】发起 fetch(credentials:'include')，与播放器
          // 同源同 Cookie 分区，自动带上 youtube.com 第三方 Cookie，与原生 <video> 完全一致。
          if (srcTab) {
            let acao = 'https://www.youtube.com';
            try { const t = await chrome.tabs.get(srcTab); if (t && t.url) acao = new URL(t.url).origin; } catch (_) {}
            try { await installAudioCorsRule(registeredDomain(host) || 'googlevideo.com', '', acao); } catch (_) {}
            const pr = await fetchMediaInYoutubeTab(srcTab, url, referer);
            if (pr && pr.ok && pr.arrayBuffer) {
              sendResponse({ ok: true, mime: pr.mime, b64: abToB64(pr.arrayBuffer), size: pr.arrayBuffer.byteLength });
              return true;
            }
            console.warn('[HMDAO] YouTube 源页 fetch 失败，回退 SW：', pr && (pr.error || pr.status));
          }
        }
        const creds = (host.includes('googlevideo') || host.includes('youtube'))
          ? 'omit' // Cookie 已由 dNR 注入，无需浏览器自动附加第三方 Cookie（避免弃用告警）
          : (typeof msg.credentials === 'string' ? msg.credentials : 'omit');
        const resp = await fetchUrl({ url, referer, credentials: creds });
        // 注意：ArrayBuffer 无法通过 chrome.runtime.sendMessage 可靠回传（会被克隆成空对象），
        // 故改为 base64 字符串传输（侧栏再解码为字节 → Blob），跨消息通道稳定。
        if (resp && resp.ok && resp.arrayBuffer) {
          sendResponse({ ok: true, mime: resp.mime, b64: abToB64(resp.arrayBuffer), size: resp.arrayBuffer.byteLength });
        } else {
          sendResponse(resp);
        }
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }
  // 读取【播放器已下载的真实响应体字节】（MAIN 世界 window.__hmdao_captures.ytBytes）。
  // 这是预览/下载 YouTube 视频最可靠的数据源：字节已由播放器带齐鉴权拉回，无需再重发直链
  // （重发直链会因 n 签名/第三方 Cookie/Referer 任一缺失被 YouTube 返回几百字节假视频文件）。
  // 优先按传入 URL 的 itag 精确返回该码率字节（用于完整下载）；无 itag 则返回体量最大的（用于预览）。
  if (msg && msg.type === HMDAO_MSG.GET_YT_BYTES) {
    (async () => {
      try {
        let tabId = msg.tabId;
        if (!tabId) { try { tabId = await pickSourceTabForUrl(msg.url || ''); } catch (_) {} }
        if (!tabId) { sendResponse({ ok: false, error: 'no-tab' }); return true; }
        // 从传入 URL 提取 itag，用于精确匹配（下载场景）vs 预览场景（返回最大 itag）
        let targetItag = null;
        try {
          if (msg.url) { const p = new URL(msg.url).searchParams.get('itag'); if (p) targetItag = +p; }
        } catch (_) {}
        const [r] = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: (hintItag) => {
            const c = window.__hmdao_captures && window.__hmdao_captures.ytBytes;
            if (!c) return null;
            if (hintItag && c[hintItag] && c[hintItag].size >= 1024) {
              const e = c[hintItag];
              return { itag: hintItag, rawChunks: e.rawChunks, mime: e.mime || 'video/mp4', size: e.size };
            }
            let best = null;
            for (const k of Object.keys(c)) { if (!best || c[k].size > c[best].size) best = k; }
            if (!best) return null;
            const e = c[best];
            return { itag: best, rawChunks: e.rawChunks, mime: e.mime || 'video/mp4', size: e.size };
          },
          args: [targetItag],
        });
        const res = r && r.result;
        if (res && res.size >= 1024 && res.rawChunks && res.rawChunks.length) {
          // ★ Uint8Array[] 经 structured clone 到 background → 拼合 → btoa 编码 → 分段写 storage
          // （structured clone 保证字节零损坏；btoa 在 background SW 执行，不受页面 CSP/JS 引擎差异影响）
          const total = res.rawChunks.reduce((s, c) => s + c.byteLength, 0);
          const merged = new Uint8Array(total);
          let pos = 0;
          for (const c of res.rawChunks) { merged.set(c, pos); pos += c.byteLength; }
          const CHUNK = 256 * 1024; // 256KB → ~341KB base64，storage 无压力
          const keyPrefix = '_ytBytes_' + Date.now() + '_';
          try {
            const keys = [];
            for (let i = 0; i < merged.length; i += CHUNK) {
              const ki = keyPrefix + Math.floor(i / CHUNK);
              keys.push(ki);
              const end = Math.min(i + CHUNK, merged.length);
              // Uint8Array → binary string → btoa（在 background SW 中 btoa 不受限）
              let bin = '';
              for (let j = i; j < end; j++) bin += String.fromCharCode(merged[j]);
              await chrome.storage.local.set({ [ki]: btoa(bin) });
            }
            sendResponse({ ok: true, _storageChunks: keys, mime: res.mime || 'video/mp4', size: total, itag: res.itag });
          } catch (_) {
            sendResponse({ ok: true, mime: res.mime || 'video/mp4', size: total, itag: res.itag });
          }
        } else {
          sendResponse({ ok: false, error: 'no-bytes', reason: '页面尚未播放该视频，请在源页点击播放后再试' });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }
  // 侧栏在落盘/试看模型前，先做二进制魔数校验（技术验证 5）：
  // 杜绝「HTML/JSON 错误页伪装成模型文件」（爱给等站签名过期返 HTML 的场景）。
  if (msg && msg.type === HMDAO_MSG.VERIFY_MAGIC) {
    try {
      let bytes;
      if (msg.b64) {
        const bin = atob(msg.b64);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } else if (Array.isArray(msg.bytes)) {
        bytes = new Uint8Array(msg.bytes);
      } else {
        bytes = new Uint8Array(0);
      }
      sendResponse({ ok: true, result: verifyModelBinarySignature(bytes) });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
    return true;
  }
  // model-api-capture.js（MAIN world）从下载 API 响应体里抽出签名的模型/压缩包直链后上报。
  // 这些地址 DOM 静态扫描拿不到，是爱给/CG模型 等站获取 3D 文件的唯一可靠来源。
  if (msg && msg.type === HMDAO_MSG.MODEL_API_CAPTURE) {
    try {
      const url = msg.url;
      const type = msg.assetType === 'archive' ? 'archive' : 'model';
      if (!url) { sendResponse({ ok: false, error: 'empty' }); return; }
      const tabId = (_sender && _sender.tab && _sender.tab.id) || SOURCE_TAB_ID;
      const list = NETWORK_ASSETS[tabId] || (NETWORK_ASSETS[tabId] = []);
      let wrote = false;
      if (!list.some((x) => x.url === url && x.source === 'api-capture')) {
        list.push({ url, type, source: 'api-capture' });
        if (list.length > 500) list.shift();
        wrote = true;
      }
      if (wrote && tabId) scheduleRescan(tabId);
      sendResponse({ ok: true, captured: wrote, url: url.slice(0, 90) });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
    return true;
  }
  // 侧栏安装临时的 Referer 注入规则（用于 chrome.downloads.download 时带 Referer）
  if (msg && msg.type === HMDAO_MSG.INSTALL_REFERER_RULE) {
    // 必须 await：保证 sendResponse 在 updateSessionRules 真正完成之后，
    // 否则侧栏 chrome.downloads.download 会在 dNR 规则生效前触发，仍 403。
    installRefererRuleForDomain(msg.domain, msg.referer).then((id) => {
      sendResponse({ ok: true, ruleId: id });
    });
    return true;
  }
  // 侧栏请求在源页面中创建 Audio 元素试听（解决 CDN CORS 限制：<audio> 无 CORS 限制）
  if (msg && msg.type === HMDAO_MSG.PLAY_AUDIO_IN_PAGE) {
    (async () => {
      try {
        // 优先用最近扫描/捕获的源标签页，避免用户切到 HMDao 等其它标签后
        // 把 <audio> 注入到错误上下文导致 Referer/Cookie 丢失、CDN 返 HTML。
        let targetTabId = SOURCE_TAB_ID;
        if (!targetTabId) {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          targetTabId = tabs[0] && tabs[0].id;
        }
        if (!targetTabId) { sendResponse({ ok: false, error: 'no-source-tab' }); return; }
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: targetTabId, allFrames: true },
          // ISOLATED（内容脚本世界）：不受页面 CSP 约束。MAIN world 注入等同页面内联脚本，
          // 会被严格 CSP 站点拒绝（"Refused to execute inline script"）→ 注入静默失败。
          world: 'ISOLATED',
          // 关键：必须 await play()，并把真实结果回传——
          // 之前固定返回 {ok:true}，把自动播放策略拒绝/防盗链 403 错误吞了，
          // 侧栏 UI 一直误显示「正在试听」但实际无声。
          func: async (audioUrl, audioId) => {
            const POOL_KEY = '__hmdao_audio_pool';
            if (!window[POOL_KEY]) window[POOL_KEY] = {};
            const old = window[POOL_KEY][audioId];
            if (old) { old.pause(); old.removeAttribute('src'); old.load(); }
            const a = new Audio();
            a.src = audioUrl;
            a.volume = 1;
            window[POOL_KEY][audioId] = a;
            try {
              await a.play();
              return { ok: true };
            } catch (e) {
              // 自动播放策略拒绝 / 防盗链 403 / 网络错误 / 媒体格式不支持 都在此
              const code = (e && (e.name || e.code)) || '';
              return { ok: false, error: 'play-rejected:' + code };
            }
          },
          args: [msg.url, msg.audioId || 'hover'],
        });
        sendResponse(result?.result || { ok: false, error: 'no result' });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  // 侧栏请求抓取音频字节。
  // 两层都走「dNR 注入 Referer + 响应 ACAO/ACAC」：
  //   · SW 主路径：credentials:'include' 送 Cookie + dNR 补 ACAO(扩展源) 让跨源 fetch 可读 body。
  //   · 页面兜底：在源页 ISOLATED world 以 include 拉（自带正确 Referer + 同站 Cookie），
  //     dNR 补 ACAO(页面源) 让跨源 fetch 可读 body。
  // 二者都不依赖任何标签页/SW 全局状态之外的脆弱假设。
  if (msg && msg.type === HMDAO_MSG.FETCH_IN_PAGE) {
    (async () => {
      try {
        const wanted = msg.url || '';
        const referer = msg.referer || deriveRefererForUrl(wanted);
        // ---- 主路径：SW fetch + dNR(Referer + 响应 CORS) ----
        const bg = await fetchAudioViaBackground(wanted, referer);
        if (bg && bg.ok) {
          console.log('[HMDAO][bg] HMDAO_FETCH_IN_PAGE 主路径(SW+dNR)成功', { size: bg.size, mime: bg.mime });
          sendResponse(bg);
          return;
        }
        console.warn('[HMDAO][bg] 主路径(SW+dNR)失败，回落页面注入', bg);
        // ---- 兜底：源页 ISOLATED world fetch（带 Cookie + dNR 补 ACAO）----
        try {
          const targetTabId = await pickSourceTabForUrl(wanted);
          if (!targetTabId) { sendResponse(bg || { ok: false, error: 'no-source-tab' }); return; }
          let pageOrigin = '';
          try { const t = await chrome.tabs.get(targetTabId); pageOrigin = new URL(t.url || '').origin; } catch (_) {}
          const domain = registeredDomain((() => { try { return new URL(wanted).hostname; } catch (_) { return ''; } })()) || '';
          // 安装「Referer + ACAO(页面源)」规则，让源页跨源 fetch 既能过防盗链又能读字节
          await installAudioCorsRule(domain, referer, pageOrigin || extOrigin());
          console.log('[HMDAO][bg] HMDAO_FETCH_IN_PAGE 选标签', { targetTabId, wantedHost: (() => { try { return new URL(wanted).hostname; } catch (_) { return '?'; } })(), pageOrigin });
          const [result] = await chrome.scripting.executeScript({
            target: { tabId: targetTabId, allFrames: false },
            // ISOLATED world：不受页面 CSP 约束；可复用页面已登录态与正确 Referer 上下文。
            world: 'ISOLATED',
            func: async (url) => {
              try {
                // credentials:'include' 送页面登录 Cookie（与浏览器 <audio> 行为一致）；
                // referrerPolicy:'unsafe-url' 让浏览器自动带页面 URL 当 Referer；
                // 响应 ACAO/ACAC 由 SW 端 dNR 规则补，使本跨源 fetch 能读 body。
                const r = await fetch(url, { credentials: 'include', referrerPolicy: 'unsafe-url', cache: 'no-store' });
                if (!r.ok) return { ok: false, status: r.status };
                const buf = await r.arrayBuffer();
                const bytes = new Uint8Array(buf);
                const head = String.fromCharCode.apply(null, Array.from(bytes.slice(0, 64)));
                if (/^\s*(<!doctype|<html|<head|<\?xml|\{)/i.test(head)) {
                  return { ok: false, error: 'got-html-not-audio', status: r.status, headSample: head.slice(0, 40) };
                }
                let binary = '';
                const CHUNK = 0x8000;
                for (let i = 0; i < bytes.length; i += CHUNK) {
                  binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
                }
                const b64 = btoa(binary);
                let mime = (r.headers.get('content-type') || '').split(';')[0].trim();
                if (!/^audio\//.test(mime)) {
                  const ext = (url.split('?')[0].match(/\.([a-z0-9]+)$/i) || [])[1] || '';
                  const map = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/ogg', weba: 'audio/webm' };
                  mime = map[ext.toLowerCase()] || mime || 'audio/mpeg';
                }
                return { ok: true, mime, b64, size: bytes.length };
              } catch (e) {
                return { ok: false, error: String((e && e.message) || e) };
              }
            },
            args: [msg.url],
          });
          const pageRes = result && result.result ? result.result : { ok: false, error: 'no result' };
          if (!pageRes.ok && bg && !bg.ok) pageRes.bgError = bg.error || bg.status; // 带上主路径诊断
          sendResponse(pageRes);
        } catch (fallbackErr) {
          const out = bg && !bg.ok ? Object.assign({}, bg) : { ok: false };
          out.fallbackError = String((fallbackErr && fallbackErr.message) || fallbackErr);
          if (!out.error) out.error = out.fallbackError;
          sendResponse(out);
        } finally {
          await removeAudioCorsRule();
        }
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }

  // 侧栏按【页面内 <audio> 元素索引】播放源页真实音频。
  // 关键：爱给/多数现代播放器用 MSE（audio.srcObject），<audio>.src 为空，
  // 扫描抓到的 a.url 实际是网页 URL（HTML），重新 fetch/新建 Audio 必然 NotSupportedError。
  // 唯一可靠做法 = 直接 play 页面自身已缓冲好真实音频的 <audio> 元素（复用站点自己的工作管线）。
  if (msg && msg.type === HMDAO_MSG.PLAY_PAGE_AUDIO) {
    (async () => {
      try {
        const targetTabId = await pickSourceTabForUrl(msg.url || '');
        if (!targetTabId) { sendResponse({ ok: false, error: 'no-source-tab' }); return; }
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: targetTabId, allFrames: false },
          world: 'ISOLATED', // DOM 共享，功能等价；免疫页面 CSP
          func: (audioIdx, url) => {
            const audios = Array.from(document.querySelectorAll('audio'));
            let el = (audioIdx != null && audios[audioIdx]) ? audios[audioIdx] : null;
            if (!el && url) {
              el = audios.find((a) => {
                const s = (a.src || a.currentSrc || '');
                return s && (s.indexOf(url) >= 0 || String(url).indexOf(s) >= 0);
              }) || null;
            }
            if (!el) {
              // 退化：点页面上的播放键
              const btn = document.querySelector('button.play, .play-btn, [class*="play" i], [data-action="play"], .audio-play');
              if (btn) { btn.click(); return { ok: true, method: 'click' }; }
              return { ok: false, error: 'no-audio-element' };
            }
            try {
              const p = el.play();
              if (p && p.catch) p.catch(() => {});
              return { ok: true, method: 'element', hasSrc: !!el.getAttribute('src') };
            } catch (e) { return { ok: false, error: 'play:' + (e && e.name || e) }; }
          },
          args: [msg.audioIdx, msg.url || ''],
        });
        sendResponse(result && result.result ? result.result : { ok: false, error: 'no result' });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }

  // 侧栏按索引暂停源页 <audio> 元素
  if (msg && msg.type === HMDAO_MSG.STOP_PAGE_AUDIO) {
    (async () => {
      try {
        let targetTabId = SOURCE_TAB_ID;
        if (!targetTabId) {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          targetTabId = tabs[0] && tabs[0].id;
        }
        if (!targetTabId) { sendResponse({ ok: false, error: 'no-source-tab' }); return; }
        await chrome.scripting.executeScript({
          target: { tabId: targetTabId, allFrames: false },
          world: 'ISOLATED', // DOM 共享，功能等价；免疫页面 CSP
          func: (audioIdx) => {
            const el = document.querySelectorAll('audio')[audioIdx];
            if (el) el.pause();
          },
          args: [msg.audioIdx],
        });
        sendResponse({ ok: true });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }

  // 侧栏请求【点击源页自身的下载按钮】以下载音频（MSE 空 URL / 限时签名 URL 场景）。
  // 直接抓 a.url 对爱给这类站拿不到直链，但点击站点自己的下载键能带登录态正常下载。
  if (msg && msg.type === HMDAO_MSG.DOWNLOAD_PAGE_AUDIO) {
    (async () => {
      try {
        let targetTabId = SOURCE_TAB_ID;
        if (!targetTabId) {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          targetTabId = tabs[0] && tabs[0].id;
        }
        if (!targetTabId) { sendResponse({ ok: false, error: 'no-source-tab' }); return; }
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: targetTabId, allFrames: false },
          world: 'ISOLATED', // DOM 共享，功能等价；免疫页面 CSP
          func: (audioIdx) => {
            const el = document.querySelectorAll('audio')[audioIdx];
            if (!el) return { ok: false, error: 'no-audio-element' };
            const root = el.closest('[class],[id]') || el.parentElement || el;
            const SEL = 'a[download], a[data-download], button[data-download], [class*="download" i], [class*="down" i], [data-action*="download" i], [title*="下载" i]';
            const btn = root.querySelector(SEL) || (el.parentElement && el.parentElement.querySelector(SEL)) || document.querySelector(SEL);
            if (btn) { btn.click(); return { ok: true, method: 'click' }; }
            return { ok: false, error: 'no-download-btn' };
          },
          args: [msg.audioIdx],
        });
        sendResponse(result && result.result ? result.result : { ok: false, error: 'no result' });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }

  // 侧栏请求停止源页面中的音频试听
  if (msg && msg.type === HMDAO_MSG.STOP_AUDIO_IN_PAGE) {
    (async () => {
      try {
        let targetTabId = SOURCE_TAB_ID;
        if (!targetTabId) {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          targetTabId = tabs[0] && tabs[0].id;
        }
        if (!targetTabId) { sendResponse({ ok: false, error: 'no-source-tab' }); return; }
        await chrome.scripting.executeScript({
          target: { tabId: targetTabId, allFrames: true },
          world: 'ISOLATED', // 必须与 HMDAO_PLAY_AUDIO_IN_PAGE 同 world（音频池挂在各自 world 的 window 上）
          func: (audioId) => {
            const POOL_KEY = '__hmdao_audio_pool';
            const a = window[POOL_KEY] && window[POOL_KEY][audioId];
            if (a) { a.pause(); a.removeAttribute('src'); a.load(); delete window[POOL_KEY][audioId]; }
          },
          args: [msg.audioId || 'hover'],
        });
        sendResponse({ ok: true });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  // 侧栏请求「在源页重新捕获 fresh URL」：对 B站 blob/签名 URL，必须找到当前正在播放的 video 元素取实时 src
  if (msg && msg.type === HMDAO_MSG.REFRESH_FROM_PAGE) {
    (async () => {
      try {
        // 优先按 assetUrl 的注册域定位「源页」标签（避免侧栏自身被当作 active tab，
        // 导致在侧栏文档里跑 extractFreshVideoUrl 而读不到 RENDER_DATA / B站 API）；找不到再回退激活标签。
        let tabId;
        const picked = await pickSourceTabForUrl(msg.assetUrl);
        if (picked && picked.id) tabId = picked.id;
        if (!tabId) {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          tabId = tabs[0] && tabs[0].id;
        }
        if (!tabId) { sendResponse({ ok: false, error: 'no-source-tab' }); return; }
        // B站/YouTube 拦截器已由 inject-main.js（content_scripts, world=MAIN, document_start）常驻注入；
        // 扩展安装前已打开的页面刷新后即自动生效，无需按需重复注入（原 ensurePlatformInterceptors 已删除）。
        // 仅留一点等待时间，便于在途的 player API 返回后再读取 fresh URL。
        await new Promise((r) => setTimeout(r, 1500));
        const hintUrl = msg.assetUrl || '';
        const results = await chrome.scripting.executeScript({
          target: { tabId, allFrames: false },
          world: 'MAIN',
          func: extractFreshVideoUrl,
          args: [hintUrl, NETWORK_ASSETS[tabId] || []],
        });
        const r = (results && results[0] && results[0].result) || null;
        if (r) {
          // 抖音/视频号/TikTok 的 CDN 依赖 Referer + 签名鉴权：动态安装 Referer 规则提升预览/下载成功率
          try {
            const u = new URL(typeof r === 'string' ? r : (r.url || ''));
            const host = u.hostname.toLowerCase();
            let referer;
            if (host.includes('douyin') || host.includes('bytedance') || host.includes('tiktok')) referer = 'https://www.douyin.com/';
            else if (host.includes('weixin') || host.includes('qq.com')) referer = 'https://' + host + '/';
            else { const dom = registeredDomain(host); if (dom) referer = 'https://' + (host.startsWith('www.') ? host : 'www.' + dom) + '/'; }
            if (referer) {
              // B站域名刻意只匹配 ['other']，避免覆盖页面 <video> 原生媒体流的合法 Referer/Origin，
              // 否则 B站视频会 403 加载不了（dNR modifyHeaders 优先级高于页面原生请求头）。
              const isBili = host.includes('bilivideo.com') || host.includes('bilivideo.cn') || host.includes('hdslb.com');
              await installRefererRuleForDomain(registeredDomain(host) || host, referer, undefined, isBili ? ['other'] : undefined);
            }
          } catch (_) {}
        }
        sendResponse({ ok: !!r, url: r });
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
    })();
    return true;
  }
  // 侧栏请求：从【源页】重新解析该音频项的新鲜直链。
  // 爱给等站每个音频的 mp3 直链是「限时签名 URL」：pathname(路径)稳定、签名(e=/token=)随时间失效。
  // 采集时抓到的直链在试听时已过期 → 源站返 HTML(got-html-not-audio)/403。
  // 解决：回源页重新扫描音频直链，按 pathname 匹配到同一音频的「当前新鲜 URL」后重试；
  //       若用户已在源页播放该音频，直接复用 <audio>.currentSrc（即新鲜直链）。
  if (msg && msg.type === HMDAO_MSG.RESOLVE_FRESH_AUDIO) {
    (async () => {
      try {
        const wanted = msg.url || '';
        let hintPath = '';
        try { hintPath = new URL(wanted).pathname; } catch (_) {}
        const targetTabId = (await pickSourceTabForUrl(wanted))
          || SOURCE_TAB_ID
          || ((await chrome.tabs.query({ active: true, currentWindow: true }))[0] && (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
        if (!targetTabId) { sendResponse({ ok: false, error: 'no-source-tab' }); return; }
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: targetTabId, allFrames: false },
          // 内联音频收集（注入函数无法引用 background 作用域的 scanPage）。
          func: (hp, networkAssets) => {
            const AUD_RE = /\.(mp3|wav|flac|ogg|aac|m4a|wma|opus)(\?|#|$)/i;
            const out = []; const seen = new Set();
            const push = (u) => {
              if (!u || typeof u !== 'string') return;
              let norm = u; try { norm = new URL(u, location.href).href; } catch (_) {}
              let p = ''; try { p = new URL(norm).pathname; } catch (_) {}
              const key = p || norm;
              if (seen.has(key)) return; seen.add(key);
              if (AUD_RE.test(norm)) out.push({ url: norm, pathname: p });
            };
            // 1) 页面内所有 <audio> 当前 src（含 source 子元素）
            document.querySelectorAll('audio').forEach((a) => {
              if (a.currentSrc || a.src) push(a.currentSrc || a.src);
              a.querySelectorAll('source').forEach((s) => push(s.src));
            });
            // 2) <a href> 直指音频
            document.querySelectorAll('a[href]').forEach((a) => { if (AUD_RE.test(a.href)) push(a.href); });
            // 3) 播放器常用 data-*/rurl 属性（含任意 data-*，避免遗漏站点私有字段）
            document.querySelectorAll('*').forEach((el) => {
              el.getAttributeNames().forEach((k) => {
                const v = el.getAttribute(k);
                if (v && AUD_RE.test(v)) push(v);
              });
            });
            // 4) 内联脚本 / 全局变量里埋的音频直链
            document.querySelectorAll('script:not([src]), script[type="application/ld+json"], script[type="application/json"]').forEach((s) => {
              const re = /https?:\/\/[^"')\s]+\.(mp3|wav|flac|ogg|aac|m4a|wma|opus)(\?[^"')\s]*)?/gi;
              let m; while ((m = re.exec(s.textContent || '')) && out.length < 400) push(m[0]);
            });
            try {
              ['soundList', 'soundData', 'audioList', 'playerData', 'mediaList', 'sound_list', 'SOUND_DATA', '__PRELOADED_STATE__', 'tracks', 'playlist'].forEach((k) => {
                const obj = window[k]; if (!obj) return;
                const json = JSON.stringify(obj);
                const re = /https?:\/\/[^"')\s}]+\.(mp3|wav|flac|ogg|aac|m4a|wma|opus)(\?[^"')\s}]*)?/gi;
                let m; while ((m = re.exec(json)) && out.length < 600) push(m[0]);
              });
            } catch (_) {}
            // 5) 网络层捕获的音频缓冲（含签名 URL 刷新后新出现的请求）
            (networkAssets || []).forEach((a) => { if (a && a.url && AUD_RE.test(a.url)) push(a.url); });
            // 6) 页面播放器实时 currentSrc（用户可能已在源页播放该音频）
            let playingSrc = '';
            try { const au = document.querySelector('audio'); playingSrc = (au && (au.currentSrc || au.src)) || ''; } catch (_) {}
            return { audioUrls: out, playingSrc };
          },
          args: [hintPath, NETWORK_ASSETS[targetTabId] || []],
        });
        const page = (res && res.result) || { audioUrls: [], playingSrc: '' };
        let freshUrl = '';
        if (hintPath) {
          const m = page.audioUrls.find((x) => x.pathname && x.pathname === hintPath);
          if (m) freshUrl = m.url;
        }
        // 回退：采集到的是页面 URL（无 mp3 后缀）→ 用正在播放的 currentSrc
        if (!freshUrl && page.playingSrc && /^https?:/i.test(page.playingSrc)) freshUrl = page.playingSrc;
        console.log('[HMDAO][bg] HMDAO_RESOLVE_FRESH_AUDIO', {
          wanted, hintPath, found: page.audioUrls.length, freshUrl: freshUrl ? freshUrl.slice(0, 80) : '', playingSrc: page.playingSrc ? page.playingSrc.slice(0, 80) : '',
        });
        sendResponse({ ok: !!freshUrl, freshUrl, audioUrls: page.audioUrls, playingSrc: page.playingSrc });
      } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
    })();
    return true;
  }
});

// 注：B站/YouTube 拦截器已移至 inject-main.js（content_scripts, world=MAIN, document_start）常驻注入，
// 并置 window.__hmdao_installed=true。此处不再保留重复的按需注入版本（ensurePlatformInterceptors）。

// 在源页 DOM 中提取最近/匹配的 fresh video URL（page context 内运行，能读出 blob 实时 src）
// 注：B站 WBI 签名与 playurl 自调逻辑已内联在 extractFreshVideoUrl 内部（executeScript 只序列化函数体，
// 外部定义的 wbiSign/biliWbiCall 无法进入页面作用域，故不在此重复定义）。
async function extractFreshVideoUrl(hintUrl, networkAssets) {
  const REFERER = 'https://www.bilibili.com';

  // ===== 自包含 WBI 依赖（必须内联！）=====
  // chrome.scripting.executeScript({func}) 只序列化【本函数体】，外层 biliWbiCall/wbiSign/md5Hash
  // 不会进入页面作用域（此前 Layer0 一直 ReferenceError→静默落到无声 DASH→403）。
  // 且浏览器 Web Crypto 不支持 MD5、页面无 require('crypto')，故 MD5 必须纯 JS 实现（blueimp-md5）。
  function __md5(str) {
    function sa(x, y) { const l = (x & 0xffff) + (y & 0xffff); const m = (x >> 16) + (y >> 16) + (l >> 16); return (m << 16) | (l & 0xffff); }
    function rol(n, c) { return (n << c) | (n >>> (32 - c)); }
    function cmn(q, a, b, x, s, t) { return sa(rol(sa(sa(a, q), sa(x, t)), s), b); }
    function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
    function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
    function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
    function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }
    function core(x, len) {
      x[len >> 5] |= 0x80 << (len % 32);
      x[(((len + 64) >>> 9) << 4) + 14] = len;
      let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
      for (let i = 0; i < x.length; i += 16) {
        const oa = a, ob = b, oc = c, od = d;
        a = ff(a, b, c, d, x[i], 7, -680876936); d = ff(d, a, b, c, x[i + 1], 12, -389564586);
        c = ff(c, d, a, b, x[i + 2], 17, 606105819); b = ff(b, c, d, a, x[i + 3], 22, -1044525330);
        a = ff(a, b, c, d, x[i + 4], 7, -176418897); d = ff(d, a, b, c, x[i + 5], 12, 1200080426);
        c = ff(c, d, a, b, x[i + 6], 17, -1473231341); b = ff(b, c, d, a, x[i + 7], 22, -45705983);
        a = ff(a, b, c, d, x[i + 8], 7, 1770035416); d = ff(d, a, b, c, x[i + 9], 12, -1958414417);
        c = ff(c, d, a, b, x[i + 10], 17, -42063); b = ff(b, c, d, a, x[i + 11], 22, -1990404162);
        a = ff(a, b, c, d, x[i + 12], 7, 1804603682); d = ff(d, a, b, c, x[i + 13], 12, -40341101);
        c = ff(c, d, a, b, x[i + 14], 17, -1502002290); b = ff(b, c, d, a, x[i + 15], 22, 1236535329);
        a = gg(a, b, c, d, x[i + 1], 5, -165796510); d = gg(d, a, b, c, x[i + 6], 9, -1069501632);
        c = gg(c, d, a, b, x[i + 11], 14, 643717713); b = gg(b, c, d, a, x[i], 20, -373897302);
        a = gg(a, b, c, d, x[i + 5], 5, -701558691); d = gg(d, a, b, c, x[i + 10], 9, 38016083);
        c = gg(c, d, a, b, x[i + 15], 14, -660478335); b = gg(b, c, d, a, x[i + 4], 20, -405537848);
        a = gg(a, b, c, d, x[i + 9], 5, 568446438); d = gg(d, a, b, c, x[i + 14], 9, -1019803690);
        c = gg(c, d, a, b, x[i + 3], 14, -187363961); b = gg(b, c, d, a, x[i + 8], 20, 1163531501);
        a = gg(a, b, c, d, x[i + 13], 5, -1444681467); d = gg(d, a, b, c, x[i + 2], 9, -51403784);
        c = gg(c, d, a, b, x[i + 7], 14, 1735328473); b = gg(b, c, d, a, x[i + 12], 20, -1926607734);
        a = hh(a, b, c, d, x[i + 5], 4, -378558); d = hh(d, a, b, c, x[i + 8], 11, -2022574463);
        c = hh(c, d, a, b, x[i + 11], 16, 1839030562); b = hh(b, c, d, a, x[i + 14], 23, -35309556);
        a = hh(a, b, c, d, x[i + 1], 4, -1530992060); d = hh(d, a, b, c, x[i + 4], 11, 1272893353);
        c = hh(c, d, a, b, x[i + 7], 16, -155497632); b = hh(b, c, d, a, x[i + 10], 23, -1094730640);
        a = hh(a, b, c, d, x[i + 13], 4, 681279174); d = hh(d, a, b, c, x[i], 11, -358537222);
        c = hh(c, d, a, b, x[i + 3], 16, -722521979); b = hh(b, c, d, a, x[i + 6], 23, 76029189);
        a = hh(a, b, c, d, x[i + 9], 4, -640364487); d = hh(d, a, b, c, x[i + 12], 11, -421815835);
        c = hh(c, d, a, b, x[i + 15], 16, 530742520); b = hh(b, c, d, a, x[i + 2], 23, -995338651);
        a = ii(a, b, c, d, x[i], 6, -198630844); d = ii(d, a, b, c, x[i + 7], 10, 1126891415);
        c = ii(c, d, a, b, x[i + 14], 15, -1416354905); b = ii(b, c, d, a, x[i + 5], 21, -57434055);
        a = ii(a, b, c, d, x[i + 12], 6, 1700485571); d = ii(d, a, b, c, x[i + 3], 10, -1894986606);
        c = ii(c, d, a, b, x[i + 10], 15, -1051523); b = ii(b, c, d, a, x[i + 1], 21, -2054922799);
        a = ii(a, b, c, d, x[i + 8], 6, 1873313359); d = ii(d, a, b, c, x[i + 15], 10, -30611744);
        c = ii(c, d, a, b, x[i + 6], 15, -1560198380); b = ii(b, c, d, a, x[i + 13], 21, 1309151649);
        a = ii(a, b, c, d, x[i + 4], 6, -145523070); d = ii(d, a, b, c, x[i + 11], 10, -1120210379);
        c = ii(c, d, a, b, x[i + 2], 15, 718787259); b = ii(b, c, d, a, x[i + 9], 21, -343485551);
        a = sa(a, oa); b = sa(b, ob); c = sa(c, oc); d = sa(d, od);
      }
      return [a, b, c, d];
    }
    function bin2rstr(input) { let out = ''; for (let i = 0; i < input.length * 32; i += 8) out += String.fromCharCode((input[i >> 5] >>> (i % 32)) & 0xff); return out; }
    function rstr2bin(input) { const out = []; for (let i = 0; i < (input.length >> 2) + 1; i++) out[i] = 0; for (let i = 0; i < input.length * 8; i += 8) out[i >> 5] |= (input.charCodeAt(i / 8) & 0xff) << (i % 32); return out; }
    function rstr(s) { return bin2rstr(core(rstr2bin(s), s.length * 8)); }
    function hex(input) { const t = '0123456789abcdef'; let out = ''; for (let i = 0; i < input.length; i++) { const x = input.charCodeAt(i); out += t.charAt((x >>> 4) & 0x0f) + t.charAt(x & 0x0f); } return out; }
    return hex(rstr(unescape(encodeURIComponent(str))));
  }
  const WBI_MIX_TABLE = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13];
  const getMixinKey = (imgKey, subKey) => { const s = imgKey + subKey; let r = ''; for (let i = 0; i < 32; i++) r += s[WBI_MIX_TABLE[i]]; return r; };
  const biliWbiCall = async (apiPath, params, wbi) => {
    const mixinKey = getMixinKey(wbi.wbiImgKey, wbi.wbiSubKey);
    const wts = Math.floor(Date.now() / 1000);
    const merged = Object.assign({}, params, { wts });
    const q1 = Object.keys(merged).sort().map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(merged[k]).replace(/[!'()*]/g, ''))).join('&');
    const w_rid = __md5(q1 + mixinKey);
    const signed = Object.assign({}, merged, { w_rid });
    const query = Object.keys(signed).sort().map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(signed[k])).join('&');
    const r = await fetch('https://api.bilibili.com' + apiPath + '?' + query, { credentials: 'include' });
    return await r.json();
  };

  // ===== 第 0 层：B 站 WBI 自签 playurl（最稳定；本层运行在页面 MAIN world，fetch 天然带 bilibili referer）=====
  try {
    if (location.hostname.indexOf('bilibili.com') >= 0) {
      const s0 = window.__INITIAL_STATE__ || {};
      // 1) WBI 密钥：优先 __INITIAL_STATE__，缺失则从 nav API 现拉（不再依赖页面状态，彻底修复 Layer0 被跳过→落到无声 DASH 的问题）
      let wbi0 = (s0.videoData && s0.videoData.wbi) || s0.defaultWbiKey || (s0.loginInfo && s0.loginInfo.wbi);
      if (!wbi0 || !wbi0.wbiImgKey || !wbi0.wbiSubKey) {
        try {
          const nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' })).json();
          const img = nav && nav.data && nav.data.wbi_img;
          if (img && img.img_url && img.sub_url) {
            wbi0 = {
              wbiImgKey: img.img_url.slice(img.img_url.lastIndexOf('/') + 1).split('.')[0],
              wbiSubKey: img.sub_url.slice(img.sub_url.lastIndexOf('/') + 1).split('.')[0],
            };
          }
        } catch (_) {}
      }
      if (wbi0 && wbi0.wbiImgKey && wbi0.wbiSubKey) {
        // 2) aid/cid：优先页面状态；否则从 URL 里的 BV 号经 view API 解析
        let aid, cid;
        if (s0.videoData && s0.videoData.aid) {
          aid = s0.videoData.aid;
          const pages = (s0.videoData.pages && s0.videoData.pages.length) ? s0.videoData.pages : [{ cid: s0.videoData.cid }];
          cid = pages[0].cid;
        }
        if (!aid || !cid) {
          const bm = String(hintUrl || location.href).match(/BV(\w+)/);
          if (bm) {
            try {
              const v = await biliWbiCall('/x/web-interface/view', { bvid: 'BV' + bm[1] }, wbi0);
              if (v && v.code === 0 && v.data) { aid = v.data.aid; cid = v.data.cid; }
            } catch (_) {}
          }
        }
        if (aid && cid) {
          try {
            // fnval=1 请求「整段 MP4」（音画合一）。qn=80 + credentials:include：登录态给 1080p，未登录降级 720p。
            // 已实测该 durl 直链可【无 Referer】被 chrome.downloads 完整下载。
            const p = await biliWbiCall('/x/player/playurl', { avid: aid, cid, qn: 80, fnval: 1, fnver: 0, fourk: 1, platform: 'html5', high_quality: 1 }, wbi0);
            if (p && p.code === 0 && p.data) {
              // 关键：优先 durl（整段含音画 MP4），绝不返回 DASH 单视频轨（无声视频 = "下载不正常"根因）
              if (p.data.durl && p.data.durl.length) {
                for (const dq of p.data.durl) {
                  const u = dq.url || (dq.backup_urls && dq.backup_urls[0]);
                  if (u) return u;
                }
              }
              // 无 durl（>1080p 等仅 DASH）时：结构化返回分离轨 + referer 标记，上层走「带 Referer 的 background 下载」（m4s 无 Referer 必 403）
              if (p.data.dash) {
                const videos = (p.data.dash.video || []).filter((v) => v.baseUrl).sort((a, b) => (b.id || 0) - (a.id || 0));
                const audios = (p.data.dash.audio || []).filter((a) => a.baseUrl).sort((a, b) => (b.id || 0) - (a.id || 0));
                if (videos.length) {
                  const vu = videos[0].baseUrl || (videos[0].backup_urls && videos[0].backup_urls[0]);
                  const au = audios.length ? (audios[0].baseUrl || (audios[0].backup_urls && audios[0].backup_urls[0])) : null;
                  if (vu) return { __dash: true, video: vu, audio: au, referer: REFERER };
                }
              }
            }
          } catch (_) {}
        }
      }
    }
  } catch (_) { /* fallback */ }

  // ===== 第 1 层：video 元素非 blob src =====
  const videos = Array.from(document.querySelectorAll('video'));
  for (const v of videos) {
    const src = v.currentSrc || v.src;
    if (src && !src.startsWith('blob:') && src.startsWith('http') && v.duration > 0) return src;
  }
  for (const v of videos) {
    const src = v.currentSrc || v.src;
    if (src && !src.startsWith('blob:') && src.startsWith('http')) return src;
  }

  // ===== 第 2 层：<source> 子元素（hls.js 等） =====
  for (const v of videos) {
    const sources = v.querySelectorAll('source[src]');
    for (const s of sources) {
      if (s.src && !s.src.startsWith('blob:') && s.src.startsWith('http')) return s.src;
    }
  }

  // ===== 第 3 层：B站：拦截的 API 响应（durl 优先；DASH 必须结构化返回，绝不返回裸 m4s 字符串）=====
  try {
    const biliCap = window.__hmdao_captures && window.__hmdao_captures.bili;
    if (biliCap && biliCap.data && biliCap.data.data) {
      const p = biliCap.data.data;
      // durl（整段 MP4）优先——可无 Referer 直下
      if (p.durl && p.durl.length) {
        for (const dq of p.durl) {
          const u = dq.url || (dq.backup_urls && dq.backup_urls[0]);
          if (u) return u;
        }
      }
      // DASH：结构化返回（带 referer），走带 Referer 的 background 下载，否则裸 m4s 必 403
      if (p.dash && p.dash.video && p.dash.video.length) {
        const vQ = p.dash.video.slice().sort((a, b) => (b.id || 0) - (a.id || 0));
        const aQ = (p.dash.audio || []).slice().sort((a, b) => (b.id || 0) - (a.id || 0));
        const vu = vQ.length && (vQ[0].baseUrl || vQ[0].base_url || (vQ[0].backup_urls && vQ[0].backup_urls[0]));
        const au = aQ.length && (aQ[0].baseUrl || aQ[0].base_url || (aQ[0].backup_urls && aQ[0].backup_urls[0]));
        if (vu && /^https?:/.test(vu)) return { __dash: true, video: vu, audio: au || null, referer: REFERER };
      }
    }
  } catch (_) {}
  // ===== 第 3' 层：B 站页面挂载的 __playinfo__ / __INITIAL_STATE__ =====
  try {
    if (window.__playinfo__ && window.__playinfo__.data) {
      const p = window.__playinfo__.data;
      if (p.durl && p.durl[0] && p.durl[0].url) return p.durl[0].url;
      if (p.dash && p.dash.video && p.dash.video[0]) {
        const vu = p.dash.video[0].baseUrl || p.dash.video[0].base_url;
        const au = (p.dash.audio && p.dash.audio[0]) ? (p.dash.audio[0].baseUrl || p.dash.audio[0].base_url) : null;
        if (vu) return { __dash: true, video: vu, audio: au, referer: REFERER };
      }
    }
  } catch (_) {}
  try {
    if (window.__INITIAL_STATE__) {
      const s = window.__INITIAL_STATE__;
      const play = s.videoData && s.videoData.playUrl || s.aidData && s.aidData.playUrl;
      if (play) return play;
    }
  } catch (_) {}

  // ===== 第 4 层：YouTube —— 优先用页面已验证的 playback 直链，再兜底 player API =====
  {
    const ytR = await tryYouTube();
    if (ytR) return ytR;
  }

  // ===== 第 5 层：抖音 / 视频号 —— RENDER_DATA 结构解析 =====
  // 关键修复：抖音「精选(jingxuan?modal_id=)」是信息流，RENDER_DATA 含多个视频；
  // 旧逻辑贪心抓「首个 play_addr」→ 命中的是与当前播放视频无关的信息流视频，
  // 表现为「解析到的视频和实际看到的不一样」。现按 modal_id / aweme_id 精确匹配。
  {
    const dyR = tryDouyinWeixin();
    if (dyR) return dyR;
  }

  // ===== 第 5.1 层：Vimeo —— player 配置返回 progressive 单文件 mp4（含音画）=====
  {
    const vmR = await tryVimeo();
    if (vmR) return vmR;
  }

  // ===== 第 5.2 层：新片场 xinpianchang —— 媒体 API / 内嵌 JSON 取 progressive mp4 =====
  {
    const xpR = await tryXinpianchang();
    if (xpR) return xpR;
  }

  // ===== 第 6 层：video 的 data-src / data-url 等自定义属性 =====
  for (const v of videos) {
    if (v.dataset.src && !v.dataset.src.startsWith('blob:') && /^https?:/.test(v.dataset.src)) return v.dataset.src;
    if (v.dataset.videoUrl && !v.dataset.videoUrl.startsWith('blob:') && /^https?:/.test(v.dataset.videoUrl)) return v.dataset.videoUrl;
  }

  // ===== 第 7 层：兜底 blob URL（告知 MSE 限制） =====
  for (const v of videos) {
    const src = v.currentSrc || v.src;
    if (src && src.startsWith('blob:')) return 'blob:' + src.slice(5, 40) + '…';
  }
  return null;

  // ===== 第 4 层实现：YouTube（随 extractFreshVideoUrl 一起被序列化注入 MAIN 世界，自包含）=====
  async function tryYouTube() {
    try {
      // 最优先：inject-main 捕获的 googlevideo 真实播放流（已含合法 n 签名、含音画，直接可下）。
      // 这是绕过 YouTube n 签名反混淆的最稳路径，且天然覆盖「视频轨」与「音效/Audio Library 音轨」。
      const ytPlay = window.__hmdao_captures && window.__hmdao_captures.ytPlay;
      if (ytPlay && ytPlay.video && Object.keys(ytPlay.video).length) {
        const vids = Object.keys(ytPlay.video).map((k) => ytPlay.video[k]);
        vids.sort((a, b) =>
          (parseInt(new URL(b).searchParams.get('itag')) || 0) -
          (parseInt(new URL(a).searchParams.get('itag')) || 0));
        return vids[0]; // 返回质量最高(itag 最大)的视频直链
      }
      // ytPlay 为空（用户尚未播放 / 刚打开页面）：主动触发播放器缓冲，
      // 让 MAIN 世界拦截器捕获真实 googlevideo 直链——等价于「用平台自己已解好的签名」，
      // 无需在扩展里重算 n 反混淆。静音 + 稍后暂停，避免打扰用户。
      if (location.hostname.includes('youtube.com')) {
        try {
          const v = document.querySelector('video');
          if (v) {
            const wasMuted = v.muted, wasPaused = v.paused;
            v.muted = true;
            try { v.currentTime = Math.min((v.currentTime || 0) + 1, (v.duration || 1e9)); } catch (_) {}
            await v.play().catch(() => {});
            await new Promise((r) => setTimeout(r, 1500));
            try { v.pause(); } catch (_) {}
            v.muted = wasMuted;
            if (!wasPaused) { try { v.play().catch(() => {}); } catch (_) {} }
            const yt2 = window.__hmdao_captures && window.__hmdao_captures.ytPlay;
            if (yt2 && yt2.video && Object.keys(yt2.video).length) {
              const v2 = Object.keys(yt2.video).map((k) => yt2.video[k]);
              v2.sort((a, b) =>
                (parseInt(new URL(b).searchParams.get('itag')) || 0) -
                (parseInt(new URL(a).searchParams.get('itag')) || 0));
              return v2[0];
            }
          }
        } catch (_) {}
      }
      // 兜底：直接读 window.ytInitialPlayerResponse 全局（比正则稳），解析带 url 的 progressive 格式
      try {
        const y = window.ytInitialPlayerResponse;
        if (y && y.streamingData) {
          const arr = (y.streamingData.formats || []).concat(y.streamingData.adaptiveFormats || []);
          const mp4 = arr.filter((f) => f.url && /^video\/mp4/.test(f.mimeType || ''));
          if (mp4.length) { mp4.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0)); return mp4[0].url; }
          if (arr[0] && arr[0].url) return arr[0].url;
        }
      } catch (_) {}
      const ytCap = window.__hmdao_captures && window.__hmdao_captures.yt;
      let sd = ytCap && ytCap.data && ytCap.data.streamingData;
      if (!sd) {
        // 兜底：从页面源码解析 ytInitialPlayerResponse
        const m = document.documentElement.innerHTML.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/);
        if (m) { try { sd = JSON.parse(m[1]).streamingData; } catch (_) {} }
      }
      if (sd) {
        const arr = (sd.formats || []).concat(sd.adaptiveFormats || []);
        // 优先 progressive mp4（单文件，下载友好），按 bitrate 高到低
        const mp4 = arr.filter((f) => f.url && /^video\/mp4/.test(f.mimeType || ''));
        if (mp4.length) { mp4.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0)); return mp4[0].url; }
        if (arr[0] && arr[0].url) return arr[0].url;
      }
    } catch (_) {}
    return null;
  }

  // ===== 第 5 层实现：抖音 / 视频号（随 extractFreshVideoUrl 一起被序列化注入 MAIN 世界，自包含）=====
  function tryDouyinWeixin() {
    try {
      const isDy = location.hostname.includes('douyin.com');
      const isWx = location.hostname.includes('channels.weixin.qq.com') || location.hostname.includes('weixin.qq.com') || location.hostname.includes('find.qq.com');
      if (!isDy && !isWx) return null;
      // 0) ★ 最优先：inject-main（MAIN 世界）捕获的 douyinvod CDN 直链。
      //    时间序收队，取最新一条=当前正在播放的视频（不受页面预加载/信息流多视频干扰）。
      if (isDy) {
        const dyUrls = (window.__hmdao_captures && window.__hmdao_captures.dyUrls) || [];
        if (dyUrls.length) return dyUrls[dyUrls.length - 1]; // 最新一条 = 当前播放
      }
      // 0b) 次优先：网络层捕获的真实 CDN 直链（保证是「正在播放」的那条，避免 RENDER_DATA 兜底取错视频）
      if (isDy) {
        const dyNet = (networkAssets || []).filter((x) => x && x.url && /(v26-web\.douyinvod|douyinvod|douyin|tiktok|bytedance)/i.test(x.url));
        if (dyNet.length) {
          const pick = dyNet[dyNet.length - 1]; // 取最近一次请求（最新鲜）
          if (pick && pick.url) return pick.url;
        }
      }
      // 1) 目标视频 id
      let targetId = '';
      try {
        const u = new URL(location.href);
        targetId = u.searchParams.get('modal_id') || u.searchParams.get('aweme_id')
          || u.searchParams.get('feedid') || u.searchParams.get('id') || '';
        if (!targetId) {
          const pm = location.pathname.match(/(?:video|note)\/(\w+)/);
          if (pm) targetId = pm[1];
        }
      } catch (_) {}

      // 递归收集所有 aweme（含 video.play_addr/download_addr），按 aweme_id 去重，优先匹配 targetId
      const grab = (root) => {
        const awemes = [];
        const walk = (o) => {
          if (!o || typeof o !== 'object') return;
          if (Array.isArray(o)) { o.forEach(walk); return; }
          const hasV = o.video && (o.video.play_addr || o.video.download_addr);
          if ((o.aweme_id || hasV)) awemes.push(o);
          for (const k in o) { try { walk(o[k]); } catch (_) {} }
        };
        try { walk(root); } catch (_) {}
        const byId = new Map();
        awemes.forEach((a) => { const id = String(a.aweme_id || ''); if (id && !byId.has(id)) byId.set(id, a); });
        let chosen = (targetId && byId.get(String(targetId))) || null;
        const matched = !!chosen;
        if (!chosen) chosen = awemes[0] || null; // 无 targetId / 未命中时兜底（可能与当前视频不同 → 仅警告）
        if (chosen && chosen.video) {
          const v = chosen.video;
          const list = (v.download_addr && v.download_addr.url_list) || (v.play_addr && v.play_addr.url_list) || [];
          if (list && list.length) {
            // ★ 收集多质量/编码版本（供侧栏分辨率下拉用）
            const formats = [];
            const bit = v.bit_rate || [];
            const addFmt = (label, addr, idx) => {
              if (!addr || !addr.url_list || !addr.url_list.length) return;
              const b = bit[idx] || {};
              const q = b.gear_name || '';
              const tag = q ? (label + ' ' + q) : label;
              formats.push({ url: addr.url_list[0].replace(/\\\//g, '/'), label: tag, bit_rate: b.bit_rate || 0, is_default: idx === 0 });
            };
            // 各编码/质量版本的 url_list[0] —— 注意：url_list 是同质 CDN 镜像数组，不同编码在不同 key 下
            if (v.play_addr) addFmt('播放源', v.play_addr, 0);
            if (v.play_addr_h265) addFmt('H265', v.play_addr_h265, 1);
            if (v.download_addr) addFmt('下载源', v.download_addr, 2);
            return { url: list[0].replace(/\\\//g, '/'), matched, formats };
          }
        }
        return null;
      };

      const els = document.querySelectorAll('script#RENDER_DATA, script[id="RENDER_DATA"]');
      for (const el of els) {
        if (el && el.textContent) {
          try {
            const data = JSON.parse(decodeURIComponent(el.textContent));
            const r = grab(data);
            if (r) {
              if (!r.matched) console.warn('[HMDAO] 抖音/视频号：未匹配到目标 id=' + targetId + '，返回首个视频（可能与当前播放不同）');
              return r.url;
            }
          } catch (_) {}
        }
      }
      // 兜底：整页正则（旧行为，易取错视频）
      const m = document.documentElement.innerHTML.match(/"play_addr"\s*:\s*\{[^}]*?"url_list"\s*:\s*\["(https?:[^"\\]+)"\]/);
      if (m) return m[1].replace(/\\\//g, '/');
    } catch (_) {}
    return null;
  }

  // ===== 第 5.1 层实现：Vimeo（随 extractFreshVideoUrl 一起被序列化注入 MAIN 世界，自包含）=====
  async function tryVimeo() {
    try {
      if (!location.hostname.includes('vimeo.com')) return null;
      // 页面内嵌的 config（window.playerConfig）或 clip id → config API
      let cfg = window.playerConfig || (window.vimeo && window.vimeo.clip_page_config);
      let progressive = cfg && cfg.request && cfg.request.files && cfg.request.files.progressive;
      if (!progressive) {
        const idm = location.pathname.match(/(\d{6,})/);
        if (idm) {
          try {
            const j = await (await fetch('https://player.vimeo.com/video/' + idm[1] + '/config', { credentials: 'include' })).json();
            progressive = j && j.request && j.request.files && j.request.files.progressive;
          } catch (_) {}
        }
      }
      if (progressive && progressive.length) {
        progressive.sort((a, b) => (b.height || 0) - (a.height || 0));
        if (progressive[0].url) return progressive[0].url;
      }
    } catch (_) {}
    return null;
  }

  // ===== 第 5.2 层实现：新片场 xinpianchang（随 extractFreshVideoUrl 一起被序列化注入 MAIN 世界，自包含）=====
  async function tryXinpianchang() {
    try {
      if (!location.hostname.includes('xinpianchang.com')) return null;
      // 详情页通常内嵌 vid；调 mod-api 拿 mp4 资源（progressive，含音画）
      const html = document.documentElement.innerHTML;
      const vid = (html.match(/["']vid["']\s*[:=]\s*["']([\w]+)["']/) || [])[1]
        || (location.pathname.match(/\/(?:article|detail|works?)\/(\w+)/) || [])[1];
      if (vid) {
        try {
          const j = await (await fetch('https://mod-api.xinpianchang.com/mod/api/v2/media/' + vid + '?appKey=61a2f329348b3bf77', { credentials: 'include' })).json();
          const resource = j && j.data && j.data.resource;
          const progressive = resource && resource.progressive;
          if (progressive && progressive.length) {
            progressive.sort((a, b) => (b.height || 0) - (a.height || 0));
            const u = progressive[0].url || progressive[0].mp4;
            if (u) return u;
          }
        } catch (_) {}
      }
      // 兜底：页面 JSON 里直接出现的 mp4 直链
      const m = html.match(/https?:\\?\/\\?\/[^"'\s]+?\.mp4[^"'\s]*/);
      if (m) return m[0].replace(/\\\//g, '/');
    } catch (_) {}
    return null;
  }
}

// ArrayBuffer → base64（用于跨 chrome.runtime.sendMessage 可靠回传字节）
function abToB64(ab) {
  const bytes = new Uint8Array(ab);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function fetchUrl(payload) {
  try {
    const url = typeof payload === 'string' ? payload : payload.url;
    // fetch API：credentials 默认 'include' 让扩展 fetch 携带用户的登录 cookie（B站/爱给等
    // 需要 SESSDATA session 才能返回真实音视频字节）。但抖音/TikTok/视频号等媒体仅靠
    // URL 签名 + Referer 鉴权、不需要登录 Cookie，调用方可传 credentials:'omit' 避免
    // 触发 Chrome「第三方 Cookie 将被拦截」告警（Privacy Sandbox 弃用提示）。
    const options = {
      credentials: (typeof payload === 'object' && payload.credentials) || 'include',
      redirect: 'follow',
    };
    if (typeof payload === 'object' && payload.referer) {
      options.referrer = payload.referer;
      options.referrerPolicy = 'unsafe-url';
    }
    const resp = await fetch(url, options);
    if (!resp.ok) return { ok: false, status: resp.status };
    const arrayBuffer = await resp.arrayBuffer();
    return {
      ok: true,
      arrayBuffer,
      mime: resp.headers.get('content-type') || 'application/octet-stream',
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// 在【源页标签】的 ISOLATED 世界发起 fetch：继承页面上下文的 Cookie（含 YouTube 下发的
// SameSite=None 第三方 Cookie PREF/VISITOR_INFO1_LIVE），与浏览器 <video> 原生请求一致，
// 能拿到 googlevideo 真实字节。dNR 已在网络层注入 Referer + 响应 ACAO，故可读取 body。
// 这是 YouTube 预览/下载可用的关键：扩展 SW 的 Cookie 分区里没有这些第三方 Cookie，
// SW fetch(credentials:'include') 跨域到 googlevideo.com 带不出 → 403。
async function fetchMediaInTab(tabId, url, referer) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: (u, ref) => new Promise((resolve) => {
        const done = (o) => resolve(o);
        // credentials:'omit'：不依赖浏览器自动附加第三方 Cookie（避免「Third-party cookie will be
        // blocked」告警）；所需 youtube 会话 Cookie 已由后台 dNR 注入为请求头 Cookie。
        fetch(u, { credentials: 'omit', referrer: ref || 'https://www.youtube.com/', referrerPolicy: 'unsafe-url', cache: 'no-store' })
          .then(async (resp) => {
            if (!resp.ok) return done({ ok: false, status: resp.status });
            try {
              const buf = await resp.arrayBuffer();
              const u8 = new Uint8Array(buf);
              done({ ok: true, arr: Array.from(u8), mime: resp.headers.get('content-type') || 'video/mp4' });
            } catch (e) { done({ ok: false, error: 'arrbuf:' + ((e && e.message) || e) }); }
          })
          .catch((e) => done({ ok: false, error: String((e && e.message) || e) }));
      }),
      args: [url, referer],
    });
    const res = r && r.result;
    if (res && res.ok && Array.isArray(res.arr)) {
      const bytes = new Uint8Array(res.arr);
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      return { ok: true, arrayBuffer: ab, mime: res.mime || 'video/mp4' };
    }
    return res || { ok: false, error: 'no-result' };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

// MAIN 世界 fetch（YouTube 专用）：与播放器同源同 Cookie 分区，自动携带 youtube.com 下发的
// 第三方 Cookie（PREF/VISITOR_INFO1_LIVE），无需也不会依赖 dNR 注入 Cookie（cookie 是 dNR
// 禁止修改的请求头之一，依赖它会被整条规则拒掉 → ACAO 也一起失败 → 403）。
// 配合网络层注入的 ACAO 响应头即可读取字节。
async function fetchMediaInYoutubeTab(tabId, url, referer) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (u, ref) => new Promise((resolve) => {
        const done = (o) => resolve(o);
        fetch(u, { credentials: 'include', referrer: ref || 'https://www.youtube.com/', referrerPolicy: 'unsafe-url', cache: 'no-store' })
          .then(async (resp) => {
            if (!resp.ok) return done({ ok: false, status: resp.status });
            try {
              const buf = await resp.arrayBuffer();
              const u8 = new Uint8Array(buf);
              done({ ok: true, arr: Array.from(u8), mime: resp.headers.get('content-type') || 'video/mp4' });
            } catch (e) { done({ ok: false, error: 'arrbuf:' + ((e && e.message) || e) }); }
          })
          .catch((e) => done({ ok: false, error: String((e && e.message) || e) }));
      }),
      args: [url, referer],
    });
    const res = r && r.result;
    if (res && res.ok && Array.isArray(res.arr)) {
      const bytes = new Uint8Array(res.arr);
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      return { ok: true, arrayBuffer: ab, mime: res.mime || 'video/mp4' };
    }
    return res || { ok: false, error: 'no-result' };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

async function findHmdaoTab() {
  const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1:3000/*' });
  return tabs[0] || null;
}

// 已注入智能机器人浮标的标签页集合（用于侧栏随时「收回」）
const robotTabIds = new Set();
chrome.tabs.onRemoved.addListener((id) => { robotTabIds.delete(id); stopPolling(id); });
// 导航/刷新会卸载 content script（浮标随之消失），同步清理记录
chrome.tabs.onUpdated.addListener((id, info) => {
  if (info.status === 'loading' && robotTabIds.has(id)) robotTabIds.delete(id);
});

// AI 助手请求发起方：null=侧栏（runtime.sendMessage 回传），数字=网页 tabId（tabs.sendMessage 回传）
let aiChatRequester = null;
function forwardAiReply(reply) {
  if (aiChatRequester == null) {
    chrome.runtime.sendMessage({ type: HMDAO_MSG.AI_CHAT_REPLY, ...reply }).catch(() => {});
  } else {
    chrome.tabs.sendMessage(aiChatRequester, { type: HMDAO_MSG.AI_CHAT_REPLY, ...reply }).catch(() => {
      // 网页已关闭则回退到侧栏
      chrome.runtime.sendMessage({ type: HMDAO_MSG.AI_CHAT_REPLY, ...reply }).catch(() => {});
    });
  }
}

// 去抖重扫 / 视频站主动轮询（scheduleRescan / startPolling / stopPolling / isVideoHost /
// RESCAN_TIMERS / POLL_TIMERS / VIDEO_HOST_RE）已随轮询层移入 polling.js（importScripts 引入），
// 此处直接复用其全局定义。

// MAIN 世界：静音触发播放器缓冲，强制 YouTube 请求 googlevideo 直链，
// 让 inject-main 的 hmdaoCaptureYtStream 捕获整文件直链（绕开 n 签名反混淆）。
// 仅用于「用户还没播放过、ytPlay 为空」时补全采集，不影响已播放页面。
async function forceYtBufferAndCapture() {
  try {
    const v = document.querySelector('video');
    if (!v) return;
    const wasMuted = v.muted;
    v.muted = true;
    try { v.currentTime = Math.min((v.currentTime || 0) + 1, (v.duration || 1e9)); } catch (_) {}
    await v.play().catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    try { v.pause(); } catch (_) {}
    v.muted = wasMuted;
  } catch (_) {}
}

// C) 合并 MAIN 世界被动捕获读取（原本分散 3+ 次 executeScript 往返 → 1 次）。
// 返回 YouTube 播放流 + 抖音直链/多质量版本 + ★下载 API 捕获的模型/压缩包直链(modelHits)。
// ★注意：executeScript({func}) 序列化【不带闭包】——不能引用外部函数/常量，
// 否则页面里是 ReferenceError 被吞。抖音 formats 解析逻辑必须内联在本函数体内（见下方内联版）。
function readAllCapturesMAIN() {
  const out = { ytPlay: null, dyUrls: [], dyFormats: null, modelHits: [], audioPlays: [], apiVideos: [] };
  try {
    out.ytPlay = (window.__hmdao_captures && window.__hmdao_captures.ytPlay) || null;
    out.dyUrls = (window.__hmdao_captures && window.__hmdao_captures.dyUrls) || [];
    // ★扩展（2026-08-01）：接口响应体视频直链（LiblibAI / 模型社区等动态视频站点）
    out.apiVideos = (window.__hmdao_captures && Array.isArray(window.__hmdao_captures.apiVideos))
      ? window.__hmdao_captures.apiVideos.slice(-100) : [];
    // ★通用音频播放捕获（model-api-capture.js 全站 MAIN 钩子）：
    // 爱给等站预览用「游离 new Audio()」（不在 DOM）→ DOM 扫描抓不到；
    // webRequest 又受 SW 冷启动/memory cache 限制。页面全局 audioPlays 是最可靠来源。
    out.audioPlays = (window.__hmdao_captures && Array.isArray(window.__hmdao_captures.audioPlays))
      ? window.__hmdao_captures.audioPlays.slice(-200) : [];
    // model-api-capture.js（MAIN 世界）捕获的下载 API 模型/压缩包直链
    out.modelHits = Array.isArray(window.__hmdao_model_hits) ? window.__hmdao_model_hits.slice(-300) : [];
    // 抖音 RENDER_DATA 多质量版本（内联解析，因注入函数无闭包必须内联）
    try {
      const els = document.querySelectorAll('script#RENDER_DATA, script[id="RENDER_DATA"]');
      for (const el of els) {
        if (!el || !el.textContent) continue;
        try {
          const data = JSON.parse(decodeURIComponent(el.textContent));
          const awemes = [];
          const walk = (o) => {
            if (!o || typeof o !== 'object') return;
            if (Array.isArray(o)) { o.forEach(walk); return; }
            if (o.video && (o.video.play_addr || o.video.download_addr)) awemes.push(o);
            for (const k in o) { try { walk(o[k]); } catch (_) {} }
          };
          walk(data);
          const targetId = (() => {
            const u = new URL(location.href);
            return u.searchParams.get('modal_id') || u.searchParams.get('aweme_id') || u.pathname.match(/(?:video|note)\/(\w+)/)?.[1] || '';
          })();
          const byId = new Map();
          awemes.forEach((a) => { const id = String(a.aweme_id || ''); if (id && !byId.has(id)) byId.set(id, a); });
          const chosen = (targetId && byId.get(targetId)) || awemes[0] || null;
          if (!chosen || !chosen.video) continue;
          const v = chosen.video;
          const formats = [];
          if (v.play_addr && v.play_addr.url_list && v.play_addr.url_list.length)
            formats.push({ url: v.play_addr.url_list[0].replace(/\\\//g, '/'), label: '播放源 · 默认', is_default: true });
          if (v.play_addr_h265 && v.play_addr_h265.url_list && v.play_addr_h265.url_list.length)
            formats.push({ url: v.play_addr_h265.url_list[0].replace(/\\\//g, '/'), label: 'H265 编码', is_default: false });
          if (v.download_addr && v.download_addr.url_list && v.download_addr.url_list.length)
            formats.push({ url: v.download_addr.url_list[0].replace(/\\\//g, '/'), label: '下载源', is_default: false });
          out.dyFormats = { formats };
          break;
        } catch (_) { continue; }
      }
    } catch (_) {}
  } catch (_) {}
  return out;
}

