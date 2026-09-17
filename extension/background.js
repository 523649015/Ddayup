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
try { importScripts('features/screenshot-ocr-bg.js'); } catch (_) {}
// 扫描层：scanTab（深度直链解析 + 页面 DOM 解析）与 scanPage（注入 ISOLATED 世界的页面解析），详见 scan.js
try { importScripts('scan.js'); } catch (_) {}
// ★2026-09-02 移除：这里原本为「SW 线程 DASH 合并」预加载 mp4box / mp4-muxer / media-transcode
//   （约 250KB），在每次 SW 启动时都要解析一遍。
//   移除原因：SW 合并路径已废弃——Service Worker 全局没有 WebCodecs，
//   EncodedVideoChunk/EncodedAudioChunk 是 ReferenceError，加载了这些库也用不了，
//   白白付出 SW 冷启动开销。合并现在走两条已验证路径：
//     主路径 = 后端 ffmpeg（/api/media/merge-dash）
//     回退   = 侧栏 Web Worker（dash-merge-worker.js，Worker 内有完整 WebCodecs）
//   若将来要恢复，需先解决 SW 无 WebCodecs 这一根本限制（例如改用 mp4-muxer 的 Raw API）。
// ── 全局下载进度回流（2026-09-10 ★P0 修复：侧栏进度卡死的真凶） ──
// 之前侧栏 "拉流完成，开始下载" 之后就再也不动了——根因是 background.js 完全没注册
// chrome.downloads.onChanged：浏览器在背后把文件写盘了多少、剩多少、是否完成，
// 没有任何代码回流给侧栏。侧栏 progress.js 虽然早就有 progressByDownloadId /
// completeByDownloadId / failByDownloadId 等按 downloadId 精确更新进度的 API，
// 但从来没有驱动源——所以"卡片被创建"和"实际下载"之间存在永久断链。
// 这里在 SW 顶层同步注册 onChanged 监听（SW 每次重启都会重新执行）：
//   · onChanged 触发 → 查 chrome.downloads.search 拿到最新状态 → 广播给侧栏；
//   · state=complete → 侧栏收到后走 completeByDownloadId 转 COMPLETED；
//   · state=interrupted → 走 failByDownloadId 转 FAILED；
//   · 其它（in_progress / in_paused）→ 走 progressByDownloadId 更新字节。
try {
  if (chrome.downloads && chrome.downloads.onChanged) {
    chrome.downloads.onChanged.addListener(async (delta) => {
      if (!delta || !delta.id) return;
      try {
        const [items] = await chrome.downloads.search({ id: delta.id });
        const item = items && items[0];
        if (!item) return;
        chrome.runtime.sendMessage({
          type: 'HMDAO_DOWNLOAD_PROGRESS',
          downloadId: delta.id,
          state: item.state,
          bytesReceived: item.bytesReceived,
          totalBytes: item.totalBytes,
          filename: item.filename || '',
          error: item.error || null,
        }).catch(() => { /* 侧栏未开/已关闭：静默忽略，不算错 */ });
      } catch (_) { /* 查不到就跳过 */ }
    });
  }
} catch (_) { /* 旧版 Chrome 无 onChanged 监听接口时静默退化 */ }

// ── 下载创建事件：让侧栏第一时间把"刚创建"的 downloadId 绑到对应任务卡 ──
// onCreated 在 onChanged 之前触发（Chrome 保证），携带 downloadId + filename + url。
// 侧栏收到后调 progress.js 的 bindLatestPending 把最近未绑的进行中卡绑上。
// （progressByDownloadId 本身有 fallback 兜底，所以即便这条消息晚到也不会丢字节）
try {
  if (chrome.downloads && chrome.downloads.onCreated) {
    chrome.downloads.onCreated.addListener((item) => {
      if (!item || item.id == null) return;
      try {
        chrome.runtime.sendMessage({
          type: 'HMDAO_DOWNLOAD_CREATED',
          downloadId: item.id,
          filename: item.filename || '',
          url: item.url || '',
        }).catch(() => {});
      } catch (_) {}
    });
  }
} catch (_) {}

const NETWORK_ASSETS = {}; // tabId -> [{ url, type }]
const NETWORK_ASSETS_URL = {}; // tabId -> 上次扫描的页面 URL（用于判断"真正换页"以清空源页累积）
// 最近一次扫描/捕获的源标签页 ID。播放音频需在该标签页上下文里 <audio> 才能拿到
// 正确的 Referer/Cookie；若仍用 chrome.tabs.query({active:true})，用户在侧栏打开
// 后切到 HMDao/其它标签就会注入到错误上下文，hover 试听静默失败。
let SOURCE_TAB_ID = null;

// ===== 过期素材清理辅助（2026-08-02）：重新加载侧栏时自动剔除失效素材 =====
// 解析签名限时 URL 的过期时间戳（Unix 秒）。覆盖常见参数：
//   爱给/阿里系：?e=1785600600 / ?expires= / ?expire= / ?exp= / ?tte=（相对秒，需 + 当前）
//   阿里 OSS：x-oss-expires（相对秒）
// 返回 null 表示非签名限时链接（无法从 URL 判断过期，保留）。
function extractUrlExpire(url) {
  try {
    const u = new URL(url, 'https://x/');
    const q = u.searchParams;
    const nowSec = Math.floor(Date.now() / 1000);
    // 绝对时间戳
    for (const k of ['e', 'expires', 'expire', 'exp', 'timestamp']) {
      const v = q.get(k);
      if (v && /^\d{9,13}$/.test(v)) {
        const n = parseInt(v, 10);
        return n > 1e12 ? Math.floor(n / 1000) : n; // 毫秒戳归一化
      }
    }
    // 相对秒（TTL）：tte / x-oss-expires
    for (const k of ['tte', 'x-oss-expires']) {
      const v = q.get(k);
      if (v && /^\d{1,10}$/.test(v)) {
        const n = parseInt(v, 10);
        if (n > 0 && n < 1e9) return nowSec + n; // 相对值：+当前
      }
    }
  } catch (_) {}
  return null;
}
// 该素材 URL 是否为「签名限时链接且已过期」
function isSignedUrlExpired(url) {
  if (!url || typeof url !== 'string') return false;
  const exp = extractUrlExpire(url);
  if (exp == null) return false;
  return exp * 1000 <= Date.now();
}

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
        // ★2026-08-23 修复（问题3）：恢复 NETWORK_ASSETS_URL（tabId -> 上次扫描页 URL）。
        //   持久化的 urlMap 打底，唤醒后新写入的 URL 优先（更新鲜），避免旧 URL 覆盖新 URL。
        const freshUrls = {};
        for (const k of Object.keys(NETWORK_ASSETS_URL)) freshUrls[k] = NETWORK_ASSETS_URL[k];
        Object.keys(NETWORK_ASSETS_URL).forEach((k) => delete NETWORK_ASSETS_URL[k]);
        Object.assign(NETWORK_ASSETS_URL, st.urlMap || {});
        for (const k of Object.keys(freshUrls)) NETWORK_ASSETS_URL[k] = freshUrls[k];
        if (typeof st.sourceTabId === 'number') SOURCE_TAB_ID = st.sourceTabId;
      })
      .catch(() => {});
  } catch (_) {}
})();

// 周期持久化（SW 被终止前的最后一次快照可被恢复）
setInterval(() => {
  try { void persistMv3State(NETWORK_ASSETS, SOURCE_TAB_ID, NETWORK_ASSETS_URL); } catch (_) {}
}, 3000);

// ===== 统一 build 汇总（跨组件：background / sidepanel / detect / inject-main） =====
// 各组件启动/加载时向 background 上报自身 build 标记，background 作为单一真理源；
// Web App 经 detect.js 转发 HMDAO_GET_BUILDS 即可一次拿到全部组件 build，一眼分辨新旧。
// ★2026-09-10：与侧栏 build 号同步更新，便于一眼分辨是否加载到新代码。
//   本次新增 chrome.downloads.onChanged/onCreated 全局监听 + HMDAO_DOWNLOAD_PROGRESS/CREATED 广播。
const HMDAO_BACKGROUND_BUILD = '2026-09-10-bg-download-progress';
const HMDAO_BUILDS = {
  background: HMDAO_BACKGROUND_BUILD,
  sidepanel: null,
  detect: null,
  injectMain: null,
};

chrome.runtime.onInstalled.addListener((details) => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  // ★2026-09-15：记录"刚完成更新"，供侧栏展示「已更新到 vX」（见下方版本更新模块）。
  try {
    if (details && details.reason === 'update') {
      const v = (chrome.runtime.getManifest() || {}).version || '';
      chrome.storage.local.set({ hmdaoJustUpdated: v });
    }
  } catch (_) {}
  // ★2026-09-05：重载/更新扩展后清空 lastScan 持久化缓存。
  //   lastScan 里存着【旧版扫描逻辑产出的资产】（错误的集数编号、过期签名直链、旧合集的卡），
  //   扩展一重载侧栏就把它原样恢复回来 → 用户看到"还是历史内容/集数不对/点开播不了"，
  //   误以为修复没生效。修复代码只对新扫描生效，旧缓存必须清掉才有干净的起点。
  //   （瞬时数据丢失无碍：重载后第一次扫描会立刻重建。）
  try { chrome.storage.local.remove('lastScan'); } catch (_) {}
  try { chrome.storage.local.get(null, (all) => {
    try {
      const stale = Object.keys(all || {}).filter((k) => /^hmdao_scan_/.test(k));
      if (stale.length) chrome.storage.local.remove(stale);
    } catch (_) {}
  }); } catch (_) {}
  // ★2026-09-04：重载/更新扩展后，自动刷新已打开的「注入了内容脚本的站点」标签页。
  //   原因（MV3 硬限制）：扩展重载后，已打开页面里运行的【旧内容脚本不会重新注入】，
  //   但它们的 chrome.runtime 已失效 → 调 sendMessage 抛
  //   "Extension context invalidated."（rescan-bridge 转发重扫请求时会撞上）。
  //   用户此前每次都必须手动 F5 刷新页面，否则一切看起来"没生效"。
  //   这里在扩展更新后自动刷新这些站点的标签，从根本上消除该问题。
  try {
    const INJECTED = [
      '*://*.douyin.com/*', '*://*.iesdouyin.com/*', '*://*.tiktok.com/*',
      '*://*.bilibili.com/*', '*://*.youtube.com/*',
    ];
    chrome.tabs.query({ url: INJECTED }, (tabs) => {
      for (const t of (tabs || [])) {
        try { chrome.tabs.reload(t.id).catch(() => {}); } catch (_) {}
      }
      if (tabs && tabs.length) {
        console.log('[HMDAO][bg] 扩展已更新，自动刷新 ' + tabs.length + ' 个相关标签页（避免内容脚本失联）');
      }
    });
  } catch (_) {}
});

// ===== 版本更新：提醒用户 + 自动完成更新（2026-09-15 新增）=====
// 需求：体验期/使用期间若商店发布了新版本，要提醒用户；能自动完成的就自动完成。
// 实现（全部走浏览器原生能力，【不新增任何权限】、不依赖自建服务器）：
//   1) chrome.runtime.onUpdateAvailable：商店新版本已下载就绪 → 通知侧栏 + 宽限期后自动 reload 应用。
//      （这是"自动完成更新"的关键：商店扩展本就会自动下载，缺的是"应用"这一步。）
//   2) chrome.runtime.requestUpdateCheck()：主动询问商店是否有新版本（扩展启动 / 侧栏打开时各一次）。
//   3) onInstalled(reason==='update')：更新落地后写入标记，侧栏展示"已更新到 vX"。
const HMDAO_UPDATE_GRACE_MS = 20000; // 自动应用前的宽限期，留时间给用户点「立即更新」
let hmdaoUpdateTimer = null;

function hmdaoNotifyUpdate(info) {
  try { chrome.runtime.sendMessage({ type: 'HMDAO_EXT_UPDATE_AVAILABLE', info: info || {} }).catch(() => {}); } catch (_) {}
}

// 宽限期结束后自动应用更新；用户点「立即更新」可提前触发。
function hmdaoScheduleAutoApply() {
  if (hmdaoUpdateTimer) return;
  hmdaoUpdateTimer = setTimeout(() => {
    hmdaoUpdateTimer = null;
    try { chrome.runtime.reload(); } catch (_) {}
  }, HMDAO_UPDATE_GRACE_MS);
}

try {
  chrome.runtime.onUpdateAvailable.addListener(() => {
    console.log('[HMDAO][bg] 新版本已就绪，通知侧栏并在 ' + (HMDAO_UPDATE_GRACE_MS / 1000) + 's 后自动应用');
    hmdaoNotifyUpdate({ stage: 'ready' });
    hmdaoScheduleAutoApply();
  });
} catch (_) {}

function hmdaoCheckUpdate() {
  try {
    if (!chrome.runtime || !chrome.runtime.requestUpdateCheck) return;
    // 注意：回调形式与 Promise 形式在不同浏览器版本表现不一，统一用回调并吞掉异常。
    chrome.runtime.requestUpdateCheck((status, details) => {
      try {
        if (status === 'update_available') {
          console.log('[HMDAO][bg] 商店有新版本: ' + (details && details.version));
          hmdaoNotifyUpdate({ stage: 'available', version: (details && details.version) || '' });
          hmdaoScheduleAutoApply();
        }
      } catch (_) {}
    });
  } catch (_) {}
}

// 侧栏点「立即更新」→ 立刻应用
try {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return false;
    if (msg.type === 'HMDAO_APPLY_EXT_UPDATE') {
      try { chrome.runtime.reload(); } catch (_) {}
      if (sendResponse) sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'HMDAO_CHECK_EXT_UPDATE') {
      hmdaoCheckUpdate();
      if (sendResponse) sendResponse({ ok: true });
      return true;
    }
    return false;
  });
} catch (_) {}

// 扩展启动/唤醒时查一次（商店版本检查由浏览器自身周期性执行，这里只是加快首次感知）
hmdaoCheckUpdate();

// ===== 规则层（Referer 注入 / 音频 CORS / 域名工具 / 捕获扩展名白名单）=====
// 已抽取到 rules.js，由上方 importScripts('rules.js') 引入，避免 background.js 过度臃肿。
// 此处保留网络捕获核心：captureNetworkAsset 依赖 scheduleRescan（本文件后续定义）与
// rules.js 提供的 MODEL_EXT_RE / ARCHIVE_EXT_RE / dispositionsFilename / registeredDomain。

// ★媒体播放主站零干扰（2026-08-12）：优酷/腾讯/爱奇艺/芒果/搜狐/咪咕/B站/YouTube/音乐站等
// 对网络层极敏感。即便本函数只「读响应头、不改写」，为每个响应唤醒 SW + 解析头 + 更新全局
// 仍可能改变页面播放器对请求时序/头的预期（实测开启扩展后这些站控制台出现权限策略/中间件超时噪音）。
// 故对这些站完全跳过捕获——它们本就难以通过直链采集，跳过无任何功能损失，且 100% 还原「无扩展」行为。
// 注（2026-08-18）：抖音/TikTok 已从「整站跳过」移除——仅 SKIP 其「响应头媒体类型探测」
// （HMDAO_HEADER_MEDIA_HOST_RE），仍允许网络层按 URL 扩展名/CDN 域名捕获视频与音效直链
// （配合内容脚本熔断放宽，让 jingxuan 精选页可采集）。
const HMDAO_MEDIA_HOST_RE = /(^|\.)(youku\.com|iqiyi\.com|letv\.com|le\.com|mgtv\.com|hunanrm\.com|sohu\.com|miguvideo\.com|咪咕|bilibili\.com|b23\.tv|youtube\.com|youtu\.be|tencentvideo\.com|v\.qq\.com|kuaishou\.com|weibo\.com|qq\.com|netease\.com|music\.163\.com|kugou\.com|kuwo\.cn|ximalaya\.com)$/;
// 仅跳过「响应头媒体类型探测」的站点：避免对这些站逐个响应读 content-type 改变播放器请求时序，
// 但仍允许按 URL 扩展名/已知 CDN 域名捕获（抖音/TikTok 在此列）。
const HMDAO_HEADER_MEDIA_HOST_RE = /(^|\.)(douyin\.com|iesdouyin\.com|tiktok\.com)$/;
function captureNetworkAsset(details) {
  if (details.tabId < 0) return;
  const url = details.url || '';
  if (!url) return;
  let host = '';
  try { host = new URL(url).hostname; } catch (_) {}
  try { if (HMDAO_MEDIA_HOST_RE.test(host)) return; } catch (_) {}

  const capTs = Date.now(); // 捕获时间戳，供"重新加载侧栏时清理过期素材"判断素材新旧
  let type = null;
  if (/\.(mp4|webm|mov|m4v|mkv|ogv|m3u8|flv|avi|wmv|ts|mpg|mpeg|3gp|rm|rmvb|asf|vob|m2ts|f4v|m4s)(\?|$)/i.test(url)) type = 'video';
  else if (/\.(mp3|wav|flac|aac|m4a|ogg|opus|wma)(\?|$)/i.test(url)) type = 'audio';
  else if (MODEL_EXT_RE.test(url)) type = 'model';
  else if (ARCHIVE_EXT_RE.test(url)) type = 'archive';
  if (!type && details.responseHeaders && !HMDAO_HEADER_MEDIA_HOST_RE.test(host)) {
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
  // ★B站真实视频流：bilivideo.com（含 cn 子域）URL 无扩展名，且响应 Content-Type
  // 常为 application/octet-stream（裸流、无 Content-Disposition 文件名）→ 上方扩展名/content-type
  // 兜底都识别失败 → 被丢弃 → 侧栏"扫不出 B站素材"。此类 URL 本身就是 B站播放器拉的媒体裸流，
  // 无条件识别为 video（绝不依赖扩展名/响应头），保证网络层被动捕获生效。
  // 注意：本处理在浏览器进程层（webRequest）运行，不进页面、不碰 DOM、不影响 B站原生播放器。
  if (/bilivideo\.(com|cn|tv)\b/i.test(url)) {
    const bili = NETWORK_ASSETS[details.tabId] || (NETWORK_ASSETS[details.tabId] = []);
      if (!bili.some((x) => x.url === url)) {
      bili.push({ url, type: 'video', source: 'bilibili-network', ts: capTs });
      if (bili.length > 500) bili.shift();
      scheduleRescan(details.tabId);
    }
    return;
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
        yl.push({ url: clean, type: ytType, source: 'youtube', ts: capTs });
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
  // ★2026-08-22 深层修复（抖音"有声没画面"防御）：抖音 DASH 分离轨，纯音频轨 CDN 经此路径
  // 入库为 type:'audio' → 若侧栏未来并入抖音网络资产，会选到纯音频 → 预览只有声音。
  // 此处对抖音 CDN 的纯音频条目直接丢弃（与 inject-main 的 mime 过滤策略一致）。
  if (/douyinvod|douyin\.com\/.*video|bytedance/i.test(url) && type === 'audio') return;
  const list = NETWORK_ASSETS[details.tabId] || (NETWORK_ASSETS[details.tabId] = []);
  if (!list.some((x) => x.url === url)) {
    const src = /douyinvod|douyin\.com\/.*video|bytedance/i.test(url) ? 'douyin-network' : undefined;
    list.push({ url, type, ts: capTs, ...(src ? { source: src } : {}) });
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
      list.push({ url, type: 'api', source: 'download-api', ts: capTs });
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
  // ★2026-08-31：所有 Ddayup 前缀下载（无论类型，含 HMDAO_DOWNLOAD_IN_TAB 产生的 Ddayup_videos_ 名）转发
  // onCreated 给侧栏，使侧栏任务卡能立即回填 downloadId（消除与 onChanged 竞态导致的重复哑卡）。
  if (/Ddayup/i.test(fn)) {
    try {
      chrome.runtime.sendMessage({ type: 'HMDAO_DL_ONCREATED', id: item.id, filename: fn }).catch(() => {});
    } catch (_) {}
  }
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
      list.push({ url, type, ts: Date.now() });
      scheduleRescan(tabId);
    }
  });
});

// ★2026-08-31 修复（"侧栏不显示实时下载进度"真凶闭环）：
//   chrome.downloads.onChanged 必须在 background service worker 注册（MV3 下侧栏 page 注册
//   在很多 Chrome 版本收不到事件）。故此处注册并转发 HMDAO_DL_ONCHANGED 给所有扩展上下文
//   （侧栏 chrome.runtime.onMessage 会收到 → handleDownloadChanged → HmdaoProgress 实时进度）。
chrome.downloads.onChanged.addListener((delta) => {
  if (!delta || typeof delta.id !== 'number') return;
  try {
    chrome.runtime.sendMessage({ type: 'HMDAO_DL_ONCHANGED', delta }).catch(() => {});
  } catch (_) {}
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

// ★2026-08-24 新增：放宽抖音/防盗链 CDN 场景的源页 tab 选择。pickSourceTabForUrl 用 registeredDomain 严格匹配，
//   抖音 CDN douyinvod.com / v26-web.douyinvod.com 与源页 www.douyin.com 不是同注册域 → 找不到 → no-tab。
//   这里：1) 先用 pickSourceTabForUrl（同注册域）; 2) SOURCE_TAB_ID 记录的真实源页;
//        3) 任意 douyin.com/tiktok.com 打开 tab（哪怕 URL 是 CDN）。覆盖大部分防盗链视频场景。
async function pickDouyinLikeTab(url) {
  try {
    // 1) 同注册域（直链域 = 源页域，少数平台成立）
    const t1 = await pickSourceTabForUrl(url);
    if (t1) return t1;
  } catch (_) {}
  // 2) 记录的源页
  try {
    if (typeof SOURCE_TAB_ID === 'number' && SOURCE_TAB_ID != null) {
      const t = await chrome.tabs.get(SOURCE_TAB_ID);
      if (t && /^https?:/i.test(t.url || '')) return t.id;
    }
  } catch (_) {}
  // 3) 任意 douyin/tiktok/iesdouyin/bytedance 打开 tab（覆盖 CDN 域与源页域不一致场景）
  try {
    const all = await chrome.tabs.query({});
    const hit = (all || []).find((t) => {
      try {
        const h = new URL(t.url).hostname;
        return /^https?:/i.test(t.url) && /(douyin|tiktok|bytedance|iesdouyin|douyinvod)/i.test(h);
      } catch (_) { return false; }
    });
    if (hit) return hit.id;
  } catch (_) {}
  return null;
}

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
    if (!/^(audio|video)\//.test(mime)) {
      const ext = (url.split('?')[0].match(/\.([a-z0-9]+)$/i) || [])[1] || '';
      // ★mp4：豆包技能音乐是 .mp4 容器装 AAC 音频（<audio> 播放），须映射为 audio/mp4 否则 <audio> 拒绝解码
      const map = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/ogg', weba: 'audio/webm', mp4: 'audio/mp4' };
      mime = map[ext.toLowerCase()] || mime || 'audio/mpeg';
    }
    return { ok: true, mime, b64, size: bytes.length };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    await removeAudioCorsRule();
  }
}

// ===== 豆包朗读音频候选验证（2026-09-06）=====
// 背景（Edge 登录态实测）：豆包「朗读」播放中侧栏音频为 0 —— 它不是标准 audio/* 直链响应，
// fetch 钩子按响应头判定会漏。doubao-audio-capture.js 的 Performance 只读探针把「大响应 URL」
// 记为候选，这里由后台做【确定性验证】：Range GET 前 64 字节，按魔数（ID3/OggS/RIFF/fLaC/
// ADTS/ftyp-M4A）+ content-type 双判据，命中才入 NETWORK_ASSETS。杜绝把接口/图片误报成音频。
// 边界：每轮扫描最多验证 3 条未验证过的候选；每个 URL 只验证一次（Map 缓存）；请求体 ≤64 字节。
const HMDAO_DOUBAO_VERIFYED = new Map(); // url -> 'audio' | 'no'
// ★独立 scoped CORS 规则（ID 987655）：只对【扩展自身发起】的请求注入 Referer/ACAO，用完立即移除。
//   为什么不用通用 installAudioCorsRule：通用规则按「注册域」匹配全部 xmlhttprequest/other，
//   会连带改写【源页自己】发往同域其它子域的响应头 —— 实测把 mcs.doubao.com / opt.doubao.com
//   的 ACAO 改成扩展 origin，导致豆包页面自己的埋点上报被 CORS 拒绝（net::ERR_FAILED + 控制台报错）。
//   这违反「不影响源页正常运行」的边界，故豆包链路一律走本 scoped 规则。
const HMDAO_DOUBAO_CORS_RULE_ID = 987655;
async function installScopedDoubaoCorsRule(domain, referer, acao, cookie) {
  try {
    if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateSessionRules) return false;
    const requestHeaders = [];
    if (referer) requestHeaders.push({ header: 'referer', operation: 'set', value: referer });
    if (cookie) requestHeaders.push({ header: 'cookie', operation: 'set', value: cookie });
    const condition = { urlFilter: '||' + domain, resourceTypes: ['xmlhttprequest', 'other'] };
    // 仅作用于扩展自身发起的请求：源页发起的请求 initiator 是 doubao.com，不匹配 → 零影响
    try { if (chrome.runtime && chrome.runtime.id) condition.initiatorDomains = [chrome.runtime.id]; } catch (_) {}
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [HMDAO_DOUBAO_CORS_RULE_ID],
      addRules: [{
        id: HMDAO_DOUBAO_CORS_RULE_ID,
        priority: 100,
        action: {
          type: 'modifyHeaders',
          requestHeaders,
          responseHeaders: [
            { header: 'access-control-allow-origin', operation: 'set', value: acao },
            { header: 'access-control-allow-credentials', operation: 'set', value: 'true' },
          ],
        },
        condition,
      }],
    }).catch(() => {});
    return true;
  } catch (_) { return false; }
}
async function removeScopedDoubaoCorsRule() {
  try { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [HMDAO_DOUBAO_CORS_RULE_ID] }); } catch (_) {}
}
async function getDoubaoCookieHeader() {
  try {
    if (!chrome.cookies) return '';
    const list = await chrome.cookies.getAll({ domain: 'doubao.com' });
    return list.map((c) => c.name + '=' + c.value).join('; ');
  } catch (_) { return ''; }
}
async function verifyDoubaoAudioCandidates(tabId, candidates) {
  let added = 0;
  try {
  for (const c of (candidates || []).slice(-3)) {
    const url = c && c.url;
    if (!url || HMDAO_DOUBAO_VERIFYED.has(url)) continue;
    HMDAO_DOUBAO_VERIFYED.set(url, 'no'); // 先置 no，验证成功再改，防并发重复
    try {
      const host = new URL(url).hostname;
      // 用精确 host（而非注册域）收窄范围，避免任何同注册域下的兄弟子域被规则覆盖
      const domain = host;
      const referer = 'https://www.doubao.com/';
      const cookie = await getDoubaoCookieHeader();
      await installScopedDoubaoCorsRule(domain, referer, extOrigin(), cookie || undefined);
      const r = await fetch(url, {
        method: 'GET',
        credentials: 'omit',
        headers: Object.assign({ Referer: referer }, cookie ? { Cookie: cookie } : {}, { Range: 'bytes=0-63' }),
        cache: 'no-store',
        redirect: 'follow',
      });
      const ct = (r.headers.get('content-type') || '').split(';')[0].trim();
      const buf = new Uint8Array(await r.arrayBuffer());
      const head = String.fromCharCode.apply(null, Array.from(buf.slice(0, 16)));
      const ftypBrand = /ftyp/.test(head) ? head.slice(8, 12) : '';
      const isM4a = /^M4A/i.test(ftypBrand) || /^M4B/i.test(ftypBrand);
      const isMp4Video = /^(isom|mp42|mp41|dash|iso2|avc1)/i.test(ftypBrand);
      const magic = /^ID3/.test(head) || /^OggS/.test(head) || /^RIFF/.test(head) || /^fLaC/.test(head)
        || /^#!AMR/.test(head) || isM4a
        || (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0); // MPEG/AAC ADTS 帧同步
      if (/^audio\//i.test(ct) || (magic && !isMp4Video)) {
        const list = NETWORK_ASSETS[tabId] || (NETWORK_ASSETS[tabId] = []);
        if (!list.some((x) => x.url === url)) {
          list.push({ url, type: 'audio', source: 'doubao-tts-verified', ts: Date.now() });
          if (list.length > 500) list.shift();
          scheduleRescan(tabId);
          added++;
        }
        HMDAO_DOUBAO_VERIFYED.set(url, 'audio');
        console.log('[HMDAO][doubao] 候选验证命中音频:', url.slice(0, 120), 'ct=' + ct, 'size=' + buf.length);
      } else {
        console.log('[HMDAO][doubao] 候选非音频（丢弃）: ct=' + ct + ' head=' + head.slice(0, 8));
      }
    } catch (_) {}
  }
  } finally {
    // 验证结束立即撤销规则，绝不留下任何影响源页请求/响应头的残留
    await removeScopedDoubaoCorsRule();
  }
  return added;
}

// 从 chrome.cookies 读取迅雷网盘登录态，拼出代理请求所需的真实请求头。
// 真实 client-id / device-id 是迅雷接口鉴权的关键，写死占位值会导致 users/me 404、download_url 400/404。
async function readXunleiCookiesAuth() {
  const cookieUrls = ['https://pan.xunlei.com/', 'https://xunlei.com/'];
  const cookies = [];
  const seen = {};
  for (const cu of cookieUrls) {
    const cs = await chrome.cookies.getAll({ url: cu }).catch(() => []);
    if (cs && cs.length) for (const c of cs) { if (!seen[c.name]) { seen[c.name] = true; cookies.push(c); } }
  }
  const get = (n) => { const c = cookies.find((x) => x.name === n); return c ? c.value : ''; };
  const clientId = get('x-client-id') || get('client_id') || get('device_id') || '';
  const deviceId = get('x-device-id') || get('device_id') || clientId || '';
  const token = get('token') || get('access_token') || get('lx_session') || get('session') || '';
  const headers = {};
  if (clientId) { headers['x-client-id'] = clientId; headers['x-device-id'] = deviceId; }
  if (token) {
    // 迅雷 Bearer：token 已是 JWT 时直接用；否则按 Cookie 名兜底。
    headers['Authorization'] = /^eyJ/i.test(token) ? ('Bearer ' + token) : token;
  }
  return { headers, clientId, deviceId, token: !!token, cookieCount: cookies.length };
}

// 迅雷分享 API 代理 fetch：供 xunlei-bridge.js（ISOLATED）转发 MAIN world 的迅雷请求。
// 关键：credentials:'include' 带登录态过 401；用 dNR 把响应 ACAO 钉成 https://pan.xunlei.com
// （具体 origin，非 '*'），避免「凭据模式 + ACAO=*」的预检冲突（net::ERR_FAILED）。
// SW 的 fetch 不携带 Origin 头，本身不受页面 CORS 限制；dNR 补 ACAO 仅让响应可读。
async function xunleiProxyFetch(url, headers, method) {
  let host = '';
  try { host = new URL(url).hostname; } catch (_) {}
  let domain = host;
  try { domain = registeredDomain(host) || host; } catch (_) {}
  const seen = {}; // ★ 防御：提到函数顶部，确保作用域覆盖整个 try 块
  try {
    // ★ 携带登录态的关键修复（2026-08-08）：
    //   SW 的 fetch 用 credentials:'include' 带的是「扩展自身 Cookie jar」，里面没有用户在
    //   pan.xunlei.com 的登录态 → 迅雷 drive 接口返回 401。
    //   改用 credentials:'omit' + 手动从 chrome.cookies 读取迅雷登录 Cookie 塞进 Cookie 头，
    //   这样既带上登录态（过 401），又因 SW fetch 不受页面 CORS 限制能读到响应体。
    let cookieStr = '';
    try {
      // ★Cookie 域名修复（2026-08-08）：迅雷登录态 Cookie 设在 pan.xunlei.com 域下，
      // 而请求目标是 api-pan.xunlei.com。chrome.cookies.getAll 按请求 URL 匹配域，
      // 用 api-pan.xunlei.com 读不到登录态 → 迅雷 401。改读 pan.xunlei.com 的 Cookie。
      // 迅雷登录态 Cookie 可能设在 pan.xunlei.com / xunlei.com / 或请求目标域。
      // 三个都读，合并去重，最大化覆盖登录态所在域。
      const cookieUrls = ['https://pan.xunlei.com/', 'https://xunlei.com/', 'https://' + host + '/'];
      for (const cu of cookieUrls) {
        const cs = await chrome.cookies.getAll({ url: cu }).catch(() => []);
        if (cs && cs.length) for (const c of cs) { if (!seen[c.name]) { seen[c.name] = true; cookieStr += (cookieStr ? '; ' : '') + c.name + '=' + c.value; } }
      }
    } catch (_) { cookieStr = ''; }
    // ★ 2026-08-10 增强：把真实 client-id / device-id 也并入 Cookie 串（迅雷接口会校验）。
    try {
      const ra = await readXunleiCookiesAuth();
      if (ra.clientId && !seen['x-client-id']) cookieStr += (cookieStr ? '; ' : '') + 'x-client-id=' + ra.clientId;
      if (ra.deviceId && !seen['x-device-id']) cookieStr += (cookieStr ? '; ' : '') + 'x-device-id=' + ra.deviceId;
    } catch (_) {}
    // ★ 诊断（2026-08-08）：打印代理实际读到的迅雷 Cookie 数量，定位 401/400 是否因登录态缺失。
    console.warn('[HMDAO][xunlei-proxy] cookieUrls 读到的 cookie 数=', Object.keys(seen).length, ' host=', host);
    const hd = Object.assign({}, headers || {});
    if (cookieStr) hd['Cookie'] = cookieStr;
    // 调用方未显式传 client-id/device-id 时，用 Cookie 里的真实值兜底（避免写死占位值被 404）。
    try {
      const ra = await readXunleiCookiesAuth();
      if (ra.clientId) { if (!hd['x-client-id']) hd['x-client-id'] = ra.clientId; if (!hd['x-device-id']) hd['x-device-id'] = ra.deviceId; }
    } catch (_) {}
    if (!hd['Referer']) hd['Referer'] = 'https://pan.xunlei.com/';
    if (!hd['User-Agent']) hd['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, 12000);
    let r, text = '';
    try {
      r = await fetch(url, { method: method || 'GET', credentials: 'omit', cache: 'no-store', headers: hd, signal: ctrl.signal });
      text = await r.text();
    } finally {
      clearTimeout(timer);
    }
    // ★ 正常返回也带 error 字段：HTTP 非 2xx 时标 http-<status>，让 MAIN 世界区分
    //   「真实 HTTP 错误（401/403/429）」与「桥接失败（通道断开）」，避免误报 bridge-failed。
    const err = r.ok ? '' : ('http-' + r.status);
    return { ok: r.ok, status: r.status, text, error: err };
  } catch (e) {
    return { ok: false, status: 0, text: '', error: String((e && e.message) || e) };
  }
}

// ===== 官网 → 扩展 登录同步（2026-09-14）=====
// 背景：官网(/api/auth/login)与扩展(/api/extension/account/login)原本是两套独立令牌体系，
//   用户在官网登录后扩展仍提示「未登录或令牌已失效」。
// 方案：官网用登录态换一个 6 位一次性绑定码，扩展拿「绑定码 + 本机 deviceId」换扩展令牌。
//   长令牌绝不经网页传递，绑定码 5 分钟有效、单次消费。
// 本函数是唯一收口：外部消息（官网已知扩展 ID）与内部消息（site-auth-bridge.js 转发）都走这里。
async function bindFromWebCode(code, force) {
  const c = String(code || '').trim();
  if (!c) return { success: false, error: '缺少绑定码' };

  // 一次读取拿到设备标识与 apiBase（合并 IO：MV3 下每个 await 都是 SW 被回收的机会窗口）
  let deviceId = '';
  let base = 'https://mingmingchuangyi.cn';
  try {
    const s = await new Promise((res) => chrome.storage.local.get(['hmdaoDeviceId', 'ddayupApiBase'], (o) => res(o || {})));
    deviceId = s.hmdaoDeviceId || '';
    const v = s.ddayupApiBase;
    if (v && typeof v === 'string' && /^https?:\/\//.test(v)) base = v.replace(/\/+$/, '');
  } catch (_) { /* ignore */ }
  // 与 license.js 的 getDeviceId() 保持同一个键与同一种 ID 格式
  if (!deviceId) {
    deviceId = 'dd-' + ((typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now() + Math.random()));
    try { await new Promise((res) => chrome.storage.local.set({ hmdaoDeviceId: deviceId }, () => res())); } catch (_) { /* ignore */ }
  }

  try {
    const r = await fetch(base + '/api/extension/account/bind', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: c, deviceId, force: !!force }),
      // 超时护栏：服务端挂起时不让 SW 事件无限等待（MV3 单事件上限 5 分钟）
      signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(15000) : undefined,
    });
    let json = null;
    try { json = await r.json(); } catch (_) { json = {}; }
    if (r.ok && json && json.success) {
      const merged = Object.assign({}, json, { cachedAt: Date.now() });
      // ★四个键必须一起写：hmdaoLicenseFetched / hmdaoLastMode / hmdaoLastPlan 是
      //   license.js 离线判定的依据，漏写会让「官网绑定付费账号」的用户在清缓存+离线时被误判 expired。
      await new Promise((res) => chrome.storage.local.set({
        hmdaoToken: json.token,
        hmdaoLicense: merged,
        hmdaoLicenseFetched: true,
        hmdaoLastMode: merged.mode || null,
        hmdaoLastPlan: merged.plan || null,
      }, () => res()));
      // 广播给侧栏刷新账号面板；无监听者时 MV3 会 reject，必须 catch
      try {
        const p = chrome.runtime.sendMessage({ type: 'HMDAO_ACCOUNT_SYNCED', email: json.email || null });
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (_) { /* ignore */ }
      return { success: true, email: json.email || null };
    }
    return { success: false, error: (json && json.error && (json.error.message || json.error.code)) || ('http-' + r.status) };
  } catch (e) {
    return { success: false, error: String((e && e.message) || e) };
  }
}

// 外部消息来源白名单（本机 Web App + 官网，含子域）
function isTrustedExternalSender(sender) {
  const o = String((sender && (sender.origin || sender.url)) || '');
  return /^http:\/\/(127\.0\.0\.1|localhost):3000\b/.test(o)
    || /^https:\/\/([\w-]+\.)*mingmingchuangyi\.cn(:\d+)?\b/.test(o);
}

// 来自 Web App（http://127.0.0.1:3000）与官网（mingmingchuangyi.cn）的外部消息
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (!isTrustedExternalSender(sender)) {
    sendResponse({ ok: false, success: false, error: 'forbidden' });
    return;
  }
  if (msg && msg.type === HMDAO_MSG.OPEN_SCAN && sender.tab && sender.tab.id) {
    chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {});
    scanTab(sender.tab.id);
    sendResponse({ ok: true });
    return;
  }
  // 官网在 manifest 的 externally_connectable 名单内且已知扩展 ID 时，可直接送绑定码。
  // ★force 恒 false：外部网页不具备「踢掉用户其它设备」的能力，冲突须由侧栏 UI 确认后内部发起。
  if (msg && msg.type === 'HMDAO_BIND_FROM_WEB') {
    if (!/^\d{6}$/.test(String((msg && msg.code) || ''))) {
      sendResponse({ success: false, error: '绑定码格式不正确' });
      return;
    }
    bindFromWebCode(msg.code, false).then(sendResponse, (e) => sendResponse({ success: false, error: String((e && e.message) || e) }));
    return true; // 异步响应
  }
  // 兜底响应，避免发送端 Promise 一直 pending
  sendResponse({ ok: false, success: false, error: 'unsupported' });
});

// 来自扩展侧栏（内部消息）
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // D1 路由表优先分发：仅当存在已注册 handler 时才交由 dispatchMessage 接管，
  // 并直接返回其同步布尔结果（true=异步保持通道）；未注册类型走下方原 if 链。
  if (typeof hasHandler === 'function' && hasHandler(msg)) {
    return dispatchMessage(msg, _sender, sendResponse);
  }
  // 官网「同步登录到扩展」：由注入 mingmingchuangyi.cn 的 site-auth-bridge.js 转发而来
  if (msg && msg.type === 'HMDAO_BIND_FROM_WEB') {
    bindFromWebCode(msg.code, false).then(sendResponse, (e) => sendResponse({ success: false, error: String((e && e.message) || e) }));
    return true; // 异步响应
  }
  // ===== 扩展 ↔ 官网 登录态打通（2026-09-14）=====
  // ★L1：这里曾有一个 HMDAO_GET_REMEMBERED_CREDS handler（把明文密码返回给调用方），
  //   但 site-auth-bridge.js 实际是直接读 chrome.storage.local，该端点无人调用，
  //   属死代码且是「明文密码出站」的多余暴露面，已删除。
  // 扩展侧登录成功后通知：主动把登录态推给已打开的官网标签（官网免重复输入）
  if (msg && msg.type === 'HMDAO_NOTIFY_EXT_LOGIN') {
    pushAutoLoginToSite().then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // 异步响应
  }
  // ★自愈：扩展令牌失效时，请官网标签重新签发绑定码（官网仍登录态则自动恢复，无需用户操作）
  if (msg && msg.type === 'HMDAO_REQUEST_SITE_LOGIN_SYNC') {
    pushSiteRefreshLogin().then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // 异步响应
  }
  // ===== 以下分支已迁移至 router.js（D1 路由表），由 hasHandler/dispatchMessage 优先接管 =====
  // - REPORT_BUILD / GET_BUILDS / PAGE_MUTATION
  // - NETDISK_RESOLVE
  // - CLICK_REVEAL / PANEL_CLOSED / DEBUG_NETWORK
  // 迅雷分享 API 代理：MAIN world（model-api-capture.js）经 xunlei-bridge.js 转发而来。
  // 解决 CORS 死局：credentials:'include' 带登录态（过 401）必须用 dNR 把响应 ACAO 钉成
  // 具体 origin（不能用 '*'，否则预检失败 net::ERR_FAILED）。SW fetch 本身不带 Origin，
  // 不受页面 CORS 限制，再由 dNR 补 ACAO 让响应可被读取。
  if (msg && msg.type === 'HMDAO_XUNLEI_API') {
    // ★ 诊断（2026-08-08）：回传完整 stack，定位 background 内抛错根因
    xunleiProxyFetch(msg.url, msg.headers, msg.method)
      .then((r) => {
        if (!r.ok) console.warn('[HMDAO][xunlei-proxy] >>> 非 2xx:', msg.url.slice(0, 120), 'status=', r.status, 'err=', r.error);
        sendResponse({ ok: r.ok, status: r.status, text: r.text, error: r.error });
      })
      .catch((e) => {
        console.error('[HMDAO][xunlei-proxy] >>> FETCH 抛错:', (e && e.stack) || e);
        sendResponse({ ok: false, status: 0, text: '', error: String((e && e.message) || e) });
      });
    return true; // 异步响应
  }
  // ★2026-08-24 说明：抖音/防盗链视频「侧栏真实预览播放」帧流信令（HMDAO_FS_*）走 chrome.runtime.sendMessage
  //   广播通道 —— 源页 MAIN world 与侧栏各自注册 chrome.runtime.onMessage 监听，按 msg.from（'page'/'panel'）
  //   区分方向，无需 background 中转（chrome.runtime.sendMessage 天然投递到所有扩展上下文，含 MAIN world）。
  // ★2026-08-23 P1：抖音真实视频直链 + 多档分辨率。侧栏下载面板打开时，若有 awemeId，
  //   在源页 MAIN 世界（带抖音 Cookie）请求 iesdouyin 公开接口拿 aweme_detail.video.bit_rate[]，
  //   返回各档 {label,url,is_default}。比 background 直连更稳（继承页面会话），避开 CDN 签名限制。
  //   失败回退到 null（侧栏自动回退 yt-dlp / dyUrls 单档）。
  if (msg && msg.type === 'HMDAO_FETCH_AWEME_INFO') {
    (async () => {
      const awemeId = msg.awemeId;
      const tabId = msg.tabId;
      if (!awemeId || !tabId) { sendResponse({ ok: false, error: 'missing awemeId/tabId' }); return; }
      try {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: (id) => {
            return new Promise((resolve) => {
              try {
                const url = 'https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?aweme_id=' + encodeURIComponent(id);
                const xhr = new XMLHttpRequest();
                xhr.open('GET', url, true);
                xhr.withCredentials = true;
                xhr.setRequestHeader('Referer', 'https://www.douyin.com/');
                xhr.setRequestHeader('User-Agent', navigator.userAgent);
                xhr.onload = () => {
                  try {
                    if (xhr.status !== 200) { resolve({ ok: false, status: xhr.status }); return; }
                    const json = JSON.parse(xhr.responseText);
                    const aweme = (json && json.aweme_detail) || (json && json.item_list && json.item_list[0]) || null;
                    if (!aweme || !aweme.video) { resolve({ ok: false, error: 'no aweme_detail' }); return; }
                    const v = aweme.video;
                    const list = [];
                    const seen = new Set();
                    const pushUnique = (u, label, isDef, codec) => { if (u && !seen.has(u)) { seen.add(u); list.push({ label, url: u, is_default: !!isDef, codec: codec || 'h264' }); } };
                    // ★2026-08-23 P5（修复「抖音只有声音没画面」根因 + 格式链路兼容）：
                    //   抖音 play_addr / bit_rate.play_addr 是【分离轨播放流】——视频轨无声音、音频轨无画面，
                    //   旧逻辑把它们当视频直链 → <video> 播放「纯视频轨」或「纯音频轨」→ 用户看到「有声无画/有画无声」。
                    //   修复：优先 download_addr（抖音官方下载源 = 原始正片，单条【含音画】H.264 MP4），
                    //   它才真正可播放（侧栏预览/下载都用它）；play_addr 仅作分辨率备选，不默认。
                    //   另：play_addr 部分档为 HEVC/H.265，浏览器 <video> 无硬解会黑屏（有声无画的另一成因），
                    //   故标记 codec，下载/预览优先选 H.264 含音画档，保证侧栏能播 + 本地下载能播。
                    const dl = (v.download_addr && v.download_addr.url_list && v.download_addr.url_list[0]) || '';
                    if (dl) pushUnique(dl, '原画(含音画) ' + ((v.width && v.height) ? (v.width + 'x' + v.height) : ''), true, 'h264');
                    (v.bit_rate || []).forEach((b) => {
                      const u = (b.play_addr && b.play_addr.url_list && b.play_addr.url_list[0]) || '';
                      const codec = /hevc|h265|h\.265|265/i.test(b.gear_name || (b.play_addr && (b.play_addr.codec_type || '')) || '') ? 'hevc' : 'h264';
                      pushUnique(u, (b.gear_name || '') + ' ' + ((b.play_addr && (b.play_addr.width + 'x' + b.play_addr.height)) || ''), false, codec);
                    });
                    const def = (v.play_addr && v.play_addr.url_list && v.play_addr.url_list[0]) || '';
                    pushUnique(def, '播放源 ' + ((v.width && v.height) ? (v.width + 'x' + v.height) : '原画质'), !dl);
                    resolve({ ok: true, awemeId: id, desc: aweme.desc || '', cover: (v.cover && (v.cover.url_list || [])[0]) || '', formats: list });
                  } catch (e) { resolve({ ok: false, error: String(e) }); }
                };
                xhr.onerror = () => resolve({ ok: false, error: 'xhr error' });
                xhr.send();
              } catch (e) { resolve({ ok: false, error: String(e) }); }
            });
          },
          args: [awemeId],
        });
        const r = res && res.result;
        sendResponse(r && r.ok ? { ok: true, desc: r.desc, cover: r.cover, formats: r.formats } : { ok: false, error: (r && r.error) || 'empty' });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true; // 异步
  }
  // ★2026-09-02 废弃：DASH 音视频【后台线程合并】。
  //   原动机：mp4box 解封装 + mp4-muxer 重封装是 CPU 密集操作，放 SW 线程以免冻结侧栏 UI。
  //   但这条路【根本跑不通】：Service Worker 全局没有 WebCodecs，EncodedVideoChunk /
  //   EncodedAudioChunk 在 SW 里是 ReferenceError —— 必崩，改字段名也救不回来
  //   （download.js 的注释亦记录了该现象）。此前它伪装成"后台开始合并"再静默失败，
  //   让用户以为在合并、实际拿到的是回退产物。
  //   合并现已统一到两条已验证可靠的路径：
  //     主路径 = 后端 ffmpeg（/api/media/merge-dash：任意大小、浏览器零内存占用）
  //     回退   = 侧栏 Web Worker（dash-merge-worker.js：Worker 内有完整 WebCodecs）
  //   故这里保留消息入口但立即返回明确错误，让调用方 mergeDashViaBackground 立刻回退，
  //   不再给用户"正在后台合并"的假象。
  if (msg && msg.type === HMDAO_MSG.MERGE_DASH) {
    (async () => {
      const notify = (m) => { try { chrome.runtime.sendMessage(m).catch(() => {}); } catch (_) {} };
      console.warn('[HMDAO][bg][merge] MERGE_DASH 已废弃：Service Worker 无 WebCodecs，无法在后台合并');
      notify({
        type: HMDAO_MSG.MERGE_DONE,
        ok: false,
        error: 'SW_MERGE_DEPRECATED：后台(SW)合并已废弃——Service Worker 不支持 WebCodecs；请改用后端 ffmpeg 合并或侧栏 Worker 合并',
      });
    })();
    return true; // 异步
  }
  // ★2026-08-30：B站多分辨率枚举（纯前端 WBI，不依赖后端 yt-dlp）。
  //   此前 B站只能走后端 /api/platform/ytdlp?action=formats，后端未启动（或 500）时用户选不了清晰度；
  //   且 extractFreshVideoUrl 里 qn 硬编码 80，只能拿单一档位。
  //   本接口在源页 MAIN 世界用 WBI 自签调 playurl?fnval=16（DASH）——一次返回 dash.video[]（所有分辨率轨）
  //   + support_formats（官方清晰度名称），侧栏据此展示 4K/1080P/720P/480P 让用户自选。
  //   注意：DASH 视频轨无音轨，下载时需与 audioUrl 合并（上层 mergeDashToMp4 已支持纯前端合并）。
  if (msg && msg.type === HMDAO_MSG.BILI_LIST_QUALITIES) {
    (async () => {
      const tabId = msg.tabId;
      if (!tabId) { sendResponse({ ok: false, error: 'missing tabId' }); return; }
      try {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: () => {
            // ===== WBI 依赖必须内联（executeScript 只序列化本函数体，外层函数进不了页面作用域）=====
            const WBI_MIX_TABLE = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13];
            const getMixinKey = (imgKey, subKey) => { const s = imgKey + subKey; let r = ''; for (let i = 0; i < 32; i++) r += s[WBI_MIX_TABLE[i]]; return r; };
            const encWbi = (params, wbi) => {
              const mixinKey = getMixinKey(wbi.wbiImgKey, wbi.wbiSubKey);
              const currTime = Math.round(Date.now() / 1000);
              const chrFilter = /[!'()*]/g;
              const o = Object.assign({ wts: currTime }, params);
              const keys = Object.keys(o).sort();
              const query = keys.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(o[k]).replace(chrFilter, ''))}`).join('&');
              const wRid = md5Hash(query + mixinKey);
              return query + '&w_rid=' + wRid;
            };
            // ★2026-08-30 修复（致命 bug）：此前的"精简 MD5"实现逻辑错误——
            //   cmn() 内部已包含 K[j] 与循环左移，外部却又重复计算了一次 (a + f + K[j] + M)，
            //   导致 w_rid 签名错误 → /x/player/playurl 返回 -403 → 前端分辨率枚举永远失败
            //   → 下载面板拿不到 durl → 回退旧路径（bilivideo 防盗链直链）→ 下载必然失败。
            //   现改用与 extractFreshVideoUrl（本文件 extractFreshVideoUrl L2719）完全相同的已验证实现。
            function md5Hash(str) {
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
              function bin2rstr(input) { let o = ''; for (let i = 0; i < input.length * 32; i += 8) o += String.fromCharCode((input[i >> 5] >>> (i % 32)) & 0xff); return o; }
              function rstr2bin(input) { const o = []; for (let i = 0; i < (input.length >> 2) + 1; i++) o[i] = 0; for (let i = 0; i < input.length * 8; i += 8) o[i >> 5] |= (input.charCodeAt(i / 8) & 0xff) << (i % 32); return o; }
              function hex(input) { const t = '0123456789abcdef'; let o = ''; for (let i = 0; i < input.length; i++) { const x = input.charCodeAt(i); o += t.charAt((x >>> 4) & 0x0f) + t.charAt(x & 0x0f); } return o; }
              return hex(bin2rstr(core(rstr2bin(unescape(encodeURIComponent(str))), unescape(encodeURIComponent(str)).length * 8)));
            }
            const biliWbiCall = async (apiPath, params, wbi) => {
              const q = encWbi(params, wbi);
              const r = await fetch('https://api.bilibili.com' + apiPath + '?' + q, { credentials: 'include', referrer: location.href });
              const j = await r.json().catch(() => null);
              // ★诊断日志：让用户/排障时能直接看到 playurl 是否成功（以前失败是静默的）
              if (j && j.code !== 0) {
                console.warn('[HMDAO][bili] playurl 返回非 0：code=' + j.code + ' msg=' + (j.message || '') + ' api=' + apiPath);
              }
              return j;
            };

            return new Promise((resolve) => {
              (async () => {
                try {
                  // 1) WBI 密钥：优先 __INITIAL_STATE__，否则 nav API 现拉
                  let wbi = null;
                  try {
                    const s0 = window.__INITIAL_STATE__ || {};
                    wbi = (s0.videoData && s0.videoData.wbi) || s0.defaultWbiKey || (s0.loginInfo && s0.loginInfo.wbi) || null;
                  } catch (_) {}
                  if (!wbi || !wbi.wbiImgKey || !wbi.wbiSubKey) {
                    try {
                      const nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' })).json();
                      const img = nav && nav.data && nav.data.wbi_img;
                      if (img && img.img_url && img.sub_url) {
                        wbi = {
                          wbiImgKey: img.img_url.slice(img.img_url.lastIndexOf('/') + 1).split('.')[0],
                          wbiSubKey: img.sub_url.slice(img.sub_url.lastIndexOf('/') + 1).split('.')[0],
                        };
                      }
                    } catch (_) {}
                  }
                  if (!wbi || !wbi.wbiImgKey || !wbi.wbiSubKey) { resolve({ ok: false, error: 'no wbi key' }); return; }

                  // 2) aid/cid
                  let aid, cid, title = '';
                  try {
                    const s0 = window.__INITIAL_STATE__ || {};
                    if (s0.videoData && s0.videoData.aid) {
                      aid = s0.videoData.aid; title = s0.videoData.title || '';
                      const pages = (s0.videoData.pages && s0.videoData.pages.length) ? s0.videoData.pages : [{ cid: s0.videoData.cid }];
                      cid = pages[0].cid;
                    }
                  } catch (_) {}
                  if (!aid || !cid) {
                    const bm = String(location.href).match(/BV(\w+)/);
                    if (bm) {
                      try {
                        const v = await biliWbiCall('/x/web-interface/view', { bvid: 'BV' + bm[1] }, wbi);
                        if (v && v.code === 0 && v.data) { aid = v.data.aid; cid = v.data.cid; title = v.data.title || ''; }
                      } catch (_) {}
                    }
                  }
                  if (!aid || !cid) { resolve({ ok: false, error: 'no aid/cid' }); return; }

                  // 3) fnval=16 → DASH：一次拿到 dash.video[]（所有分辨率轨）+ dash.audio[] + support_formats
                  const p = await biliWbiCall('/x/player/playurl', {
                    avid: aid, cid, qn: 120, fnval: 16, fnver: 0, fourk: 1, platform: 'html5', high_quality: 1,
                  }, wbi);
                  if (!p || p.code !== 0 || !p.data) { resolve({ ok: false, error: 'playurl failed: ' + (p && p.message) }); return; }

                  const d = p.data;
                  // 官方清晰度名称映射（quality -> new_description，如 120->"4K 超清"、80->"1080P 高清"）
                  const qName = {};
                  (d.support_formats || []).forEach((f) => { if (f && f.quality != null) qName[f.quality] = f.new_description || f.display_desc || ''; });

                  const audios = (d.dash && d.dash.audio && d.dash.audio.length) ? [...d.dash.audio].sort((a, b) => (b.id || 0) - (a.id || 0)) : [];
                  const audioUrl = audios.length ? (audios[0].baseUrl || (audios[0].backup_urls && audios[0].backup_urls[0]) || '') : '';

                  // DASH 视频轨 → 分辨率列表（按 height 降序，★同 qn 去重：只保留带宽最高的一条）
                  // 此前未去重导致同 qn 多条（不同 codec/bandwidth）重复显示，违反"不得影响视觉稳定"边界。
                  const vids = (d.dash && d.dash.video && d.dash.video.length) ? [...d.dash.video] : [];
                  const byQn = new Map();
                  for (const v of vids) {
                    if (!v || !(v.baseUrl || (v.backup_urls && v.backup_urls[0]))) continue;
                    const qn = v.id;
                    const cur = byQn.get(qn);
                    if (!cur || (v.bandwidth || 0) > (cur.bandwidth || 0)) byQn.set(qn, v);
                  }

                  // ★2026-08-31 关键修复（"4 个 DASH 分辨率点击没反应"真凶闭环）：
                  //   此前每个 DASH 分辨率没有自己的 durl（整段含音画 MP4）兜底，下载时只能走 yt-dlp 后端合并——
                  //     · 后端未启/未登录/大会员限制 → yt-dlp 500 → 静默卡死"没反应"
                  //     · catch 兜底 dlViaChrome(DASH m4s URL) → m4s 是单分片，chrome.downloads 拉下来不能播 + 防盗链 FILE_FAILED
                  //   现在为每个 qn 并发请求 durl（fnval=1），让每个分辨率优先关联"对应 qn 的整段 MP4 直链"——
                  //     chrome.downloads 直连 bilivideo durl 即可 100% 成功下载（含音画、不需合并、不依赖 yt-dlp 后端）。
                  //   拿不到 durl 的 qn（需大会员/区域限制/老视频）降级为 DASH 视频轨，由上层走 yt-dlp 兜底。
                  const qnList = Array.from(new Set(Array.from(byQn.values()).map((v) => v.id).filter((x) => x != null)));
                  const durlByQn = new Map();
                  if (qnList.length) {
                    const settled = await Promise.allSettled(qnList.map(async (qn) => {
                      try {
                        const pr = await biliWbiCall('/x/player/playurl', {
                          avid: aid, cid, qn, fnval: 1, fnver: 0, fourk: 1, platform: 'html5', high_quality: 1,
                        }, wbi);
                        if (pr && pr.code === 0 && pr.data && pr.data.durl && pr.data.durl.length) {
                          const u = pr.data.durl[0].url || (pr.data.durl[0].backup_urls && pr.data.durl[0].backup_urls[0]) || '';
                          if (u) return { qn, url: u, width: pr.data.width || 0, height: pr.data.height || 0 };
                        }
                        return null;
                      } catch (_) { return null; }
                    }));
                    for (const r of settled) if (r.status === 'fulfilled' && r.value) durlByQn.set(r.value.qn, r.value);
                  }

                  const formats = Array.from(byQn.values())
                    .sort((a, b) => (b.height || 0) - (a.height || 0))
                    .map((v) => {
                      const durl = durlByQn.get(v.id);
                      if (durl && durl.url) {
                        // ★ 命中 durl → 整段含音画 MP4，chrome.downloads 直连 100% 成功，无需 yt-dlp / 合并
                        return {
                          quality: v.id,
                          label: qName[v.id] || (v.height ? (v.height + 'P') : (v.id + '')),
                          width: durl.width || v.width || 0,
                          height: durl.height || v.height || 0,
                          url: durl.url,
                          codecs: '',
                          bandwidth: 0,
                          isDash: false,
                          hasAudio: true,
                        };
                      }
                      // 降级：durl 拿不到（通常需大会员/区域限制），保留 DASH 视频轨由上层走 yt-dlp 兜底
                      return {
                        quality: v.id,
                        label: qName[v.id] || (v.height ? (v.height + 'P') : (v.id + '')),
                        width: v.width || 0,
                        height: v.height || 0,
                        url: v.baseUrl || (v.backup_urls && v.backup_urls[0]) || '',
                        codecs: v.codecs || '',
                        bandwidth: v.bandwidth || 0,
                        isDash: true,
                        hasAudio: false, // DASH 视频轨无音；下载时需与 audioUrl 合并
                      };
                    });

                  resolve({ ok: true, formats, audioUrl, title, aid, cid });
                } catch (e) { resolve({ ok: false, error: String(e) }); }
              })();
            });
          },
        });
        const r = res && res.result;
        if (r && r.ok && Array.isArray(r.formats) && r.formats.length) {
          sendResponse({ ok: true, formats: r.formats, audioUrl: r.audioUrl || '', title: r.title || '' });
        } else {
          sendResponse({ ok: false, error: (r && r.error) || 'empty formats' });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true; // 异步
  }
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
  // ★2026-08-23 P1：源页 SPA 导航（抖音 pushState 切集/跳转）inject-main 发来 → 通知侧栏自动重扫。
  //   onCommitted 对 SPA 不触发主框架提交，故需此消息兜底闭环 P0 切集同步遗留点。
  if (msg && msg.type === 'HMDAO_PAGE_NAVIGATED') {
    try {
      const fromTab = (_sender && _sender.tab && _sender.tab.id) || null;
      if (fromTab) notifySidepanelRescan(fromTab);
    } catch (_) {}
    return;
  }
  // 侧栏打开时请求扫描当前标签页
  if (msg && msg.type === HMDAO_MSG.SCAN_REQUEST) {
    chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
      // 支持显式 tabId（侧栏/测试精确指定扫描目标）；无则回退 active tab / 上次源页
      // 兼容 string/number（Playwright/侧栏可能序列化为 string）。
      const explicitTabId = msg.tabId ? Number(msg.tabId) : NaN;
      let targetId = (!isNaN(explicitTabId) && explicitTabId > 0) ? explicitTabId
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
          // ★2026-08-22 增强：明确提示用户"请先打开抖音页面再扫描"，而非静默空结果。
          chrome.runtime.sendMessage({
            type: 'HMDAO_SCAN_RESULT', assets: [], error: 'unscriptable-tab',
            message: '当前激活页（' + info.url + '）不可脚本化，请先打开抖音视频/信息流页，再点击扫描。',
            url: info.url
          }).catch(() => {});
          return;
        }
      } catch (_) {}
      SOURCE_TAB_ID = targetId;
      // ★2026-08-22 信息流批量采集：侧栏扫描按钮可能附带 batchMode（如开启信息流采集+合集场景），
      //   scanTab 据此决定走单视频或多视频分支。
      const scanBatchMode = !!msg.batchMode;
      // ★2026-09-05：自动同步（侧栏收到 HMDAO_RESCAN_TAB{auto} 后发的轻量请求）走 deep:false，
      //   不再每 1.5s 跑一次深度解析（WBI/详情 API/播放器触碰）；用户手动点「重新扫描」仍是深度。
      const scanDeep = msg.deep !== false;
      // 首扫走深度直链解析（B），随后启动轮询（A）让流媒体稍后请求也能即时出现
      scanTab(targetId, { deep: scanDeep, batchMode: scanBatchMode, force: !!msg.force }).catch((e) => {
        console.warn('[HMDAO][bg] scanTab 失败：', e && e.message);
        chrome.runtime.sendMessage({ type: 'HMDAO_SCAN_RESULT', assets: [], error: 'scan-failed', message: String(e && e.message || e) }).catch(() => {});
      });
      startPolling(targetId);
    });
    return;
  }
  // 重新加载侧栏时清理过期/失效素材（2026-08-02）：
  //   1) 源页标签已关闭 → 该 tabId 下全部素材清理
  //   2) 素材 URL 是签名限时链接且已过期（?e=&expires=…）→ 单条清理
  // 不影响任何页面运行（仅操作 background 自身内存 + 持久化）。
  if (msg && msg.type === 'HMDAO_CLEANUP_STALE_ASSETS') {
    (async () => {
      let removedCount = 0;
      try {
        const tabIds = Object.keys(NETWORK_ASSETS);
        const alive = new Set();
        // 并发校验每个源页标签是否仍存活
        await Promise.all(tabIds.map(async (tidStr) => {
          const tid = parseInt(tidStr, 10);
          let aliveTab = false;
          try { const t = await chrome.tabs.get(tid); aliveTab = !!(t && t.id); } catch (_) { aliveTab = false; }
          if (!aliveTab) {
            removedCount += (NETWORK_ASSETS[tid] || []).length;
            delete NETWORK_ASSETS[tid]; // 标签已关 → 整组失效
          } else {
            alive.add(tid);
          }
        }));
        // 存活标签内：剔除签名已过期条目
        for (const tid of alive) {
          const list = NETWORK_ASSETS[tid] || [];
          const before = list.length;
          NETWORK_ASSETS[tid] = list.filter((a) => !isSignedUrlExpired(a.url));
          removedCount += before - NETWORK_ASSETS[tid].length;
        }
        // 同步清理持久化的 lastScan（侧栏重载后实际读取的源）
        try {
          const res = await chrome.storage.local.get('lastScan');
          const ls = res && res.lastScan;
          if (ls && Array.isArray(ls.assets)) {
            const before = ls.assets.length;
            const kept = ls.assets.filter((a) => !isSignedUrlExpired(a.url));
            removedCount += before - kept.length;
            await chrome.storage.local.set({ lastScan: { ...ls, assets: kept, ts: Date.now() } });
          }
        } catch (_) {}
        // 持久化内存态（NETWORK_ASSETS + NETWORK_ASSETS_URL）
        try { await persistMv3State(NETWORK_ASSETS, SOURCE_TAB_ID, NETWORK_ASSETS_URL); } catch (_) {}
      } catch (e) {
        console.warn('[HMDAO][bg] 清理过期素材失败：', e && e.message);
      }
      console.log('[HMDAO][bg] HMDAO_CLEANUP_STALE_ASSETS 完成，移除', removedCount, '条');
      sendResponse({ ok: true, removed: removedCount });
    })();
    return true; // 保持消息通道异步响应
  }
  // 网盘「深度解析」/花瓣采集 回退路径：由 background 跨域调用官方 API
  // （background 的 fetch 不受 CORS 限制），返回 JSON 文本交由前端解析直链。
  // 2026-08-18：默认带 credentials:'include'，让花瓣/网盘登录态 cookie 随请求发送
  // （ISOLATED 世界直接 fetch 会被 CORS 拦截，必须走此通道；登录态鉴权靠 cookie）。
  if (msg && msg.type === 'HMDAO_NETDISK_FETCH') {
    (async () => {
      try {
        const url = msg.url;
        const method = (msg.method || 'GET').toUpperCase();
        const headers = msg.headers || { 'User-Agent': UA };
        const opts = { method, headers, redirect: 'follow', credentials: (msg.credentials || 'include') };
        if (msg.body && method !== 'GET') opts.body = JSON.stringify(msg.body);
        const resp = await fetch(url, opts);
        const text = await resp.text().catch(() => '');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { json = null; }
        sendResponse({ ok: resp.ok, status: resp.status, text, json });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true; // 保持消息通道异步响应
  }
  // 网盘「深度解析」后台解析：复用已打开的分享页标签，读取 MAIN 世界捕获的网盘 API 数据。
  // 相比伪造官方 API，此方案复用页面自身会话，登录状态、提取码、风控都在浏览器里解决。
  if (msg && msg.type === 'HMDAO_NETDISK_RESOLVE') {
    (async () => {
      try {
        const result = await handleNetdiskResolve(msg.url);
        sendResponse(result);
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true; // 保持消息通道异步响应
  }
  // ===== 网盘「深度解析」后台解析辅助函数 =====
function parseNetdiskShareId(url) {
  try {
    const u = new URL(url, 'https://x/');
    // 兼容各类网盘 shareId（含 - _ ~ 等），避免把 ?pwd= 后的内容吃进来
    const m = u.pathname.match(/\/s\/([^/?#]+)/);
    const shareId = m ? m[1] : '';
    const pwd = u.searchParams.get('pwd') || '';
    return { shareId, pwd, host: u.hostname };
  } catch (_) { return { shareId: '', pwd: '', host: '' }; }
}
function waitTabLoad(tabId, timeout) {
  timeout = timeout || 10000;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeout);
    const listener = (id, info) => {
      if (id !== tabId) return;
      if (info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    }).catch(() => {});
  });
}
async function readXunleiShareFromTab(tabId) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const xs = window.__hmdao_captures && window.__hmdao_captures.xunleiShare;
      return xs || null;
    }
  });
  return res && res.result;
}
async function triggerXunleiFileInfo(tabId, fileIds) {
  if (!fileIds || !fileIds.length) return null;
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (ids) => { if (window.__hmdao_xunlei_resolve_files) return window.__hmdao_xunlei_resolve_files(ids); return null; },
      args: [fileIds]
    });
    // MAIN 世界函数返回的 { ok, results, details } 在 res[0].result；透传 details 供诊断
    const result = res && res[0] && res[0].result;
    return result || null;
  } catch (_) { return null; }
}
function isXunleiMyDrive(url) {
  try {
    const u = new URL(url);
    return /pan\.xunlei\.com$/.test(u.hostname) && /\?path=/.test(u.href);
  } catch (_) { return false; }
}
async function readXunleiMyDriveFromTab(tabId) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const md = window.__hmdao_captures && window.__hmdao_captures.xunleiMyDrive;
      return md || null;
    }
  });
  return res && res.result;
}
async function triggerXunleiMyDriveFileInfo(tabId, fileIds) {
  if (!fileIds || !fileIds.length) return null;
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (ids) => { if (window.__hmdao_xunlei_resolve_mydrive_files) return window.__hmdao_xunlei_resolve_mydrive_files(ids); return null; },
      args: [fileIds]
    });
    return res && res[0] && res[0].result;
  } catch (_) { return null; }
}
// ★ 2026-08-09 新增：MAIN 世界捕获失败时（老标签 / content script 在页面 document_start 前未注入），
// 直接由 background 带着迅雷登录态（chrome.cookies）通过代理主动拉取「自己网盘」文件树，
// 不依赖 MAIN 世界的 fetch 钩子。xunleiProxyFetch 签名为 (url, headers, method)，返回 {ok,status,text,error}。
// ★ 2026-08-09 修正（直连下载根因）：迅雷「自己网盘」根目录 ID 不是 '0'，从根 BFS 列目录会 400。
//   正确做法：直接用页面已捕获到的真实 file_id 调 drive/v1/files/download_url 换直链，
//   完全不需要知道父目录路径。knownFileIds 即页面捕获到的真实文件 id 列表。
// ★ 2026-08-10 修复（直连下载根因）：迅雷个人盘 space 不是固定的 'drive'，
//   而是形如 xl1786291165120_w1xhzo 的「用户空间名」（与 user_id 绑定）。
//   之前硬编码 'drive' 导致 download_url 返回 space_name_invalid(400)。
//   正确做法：先调 /drive/v1/users/me（带登录态）拿权威 space_name，
//   拿不到再回退候选列表穷举。
async function resolveXunleiSpace(knownSpace, knownCandidates) {
  const base = 'https://api-pan.xunlei.com/drive/v1';
  const candidates = [];
  // ★ 0) 最高优先：持久化的真实 space（用户曾点下载被 XHR 钩子捕获并固化到 chrome.storage.local）。
  //   这是唯一可靠的真实 space 来源，优先于一切猜测。MAIN 世界在用户点下载时由 maybeCapture 写入。
  try {
    const persp = await chrome.storage.local.get('hmdao_xunlei_space');
    if (persp && persp.hmdao_xunlei_space && candidates.indexOf(persp.hmdao_xunlei_space) < 0) candidates.push(persp.hmdao_xunlei_space);
  } catch (_) {}
  // ★ 1) 优先：MAIN 世界从列表响应收集到的真实 space 候选（条目里的 xl<user>_<suffix>）
  if (Array.isArray(knownCandidates)) for (const s of knownCandidates) { if (s && candidates.indexOf(s) < 0) candidates.push(s); }
  if (knownSpace) candidates.push(knownSpace);
  // ★ 2026-08-11 修复（根因）：之前在此处调 /drive/v1/users/me 尝试拿 space_name，
  //   但迅雷个人盘该接口返回 404（非个人盘字段），导致候选收集被 404 干扰，且真实 space 完全缺失
  //   → download_url 永远 space_name_invalid(400)。MAIN 世界已确认 users/me 对个人盘无效，
  //   background 不再依赖它。真实 space 来源：持久化 space（优先级0）+ 列表响应字段（下方主动探测）。
  // ★ 2) 主动探测：列表接口能正常返回（space=drive 对列表合法），从响应 JSON 提取真实 space。
  //   注意：探测只用空串候选（drive 对个人盘 download_url 无效，不放进探测避免污染），
  //   且探测成功拿到的 xl<user>_<suffix> 才作为真实候选，drive/空串仅作最后兜底。
  let realAuth = null;
  try { realAuth = await readXunleiCookiesAuth(); } catch (_) {}
  const probeHeaders = Object.assign({ 'Referer': 'https://pan.xunlei.com/' }, (realAuth && realAuth.headers) || {});
  // ★ 2026-08-11 新增：迅雷个人盘真实 space 的权威来源是用户信息端点。
  //   实测 /drive/v1/users/me 对个人盘返回 404（分享盘/个人盘接口差异），
  //   正确端点是 /drive/v1/me —— 登录态下返回 { space_name: "xl<uid>_<suffix>", ... }。
  //   务必用真实 device-id/client-id（从 Cookie 读，个人盘登录态 Cookie 里通常含 x-device-id）。
  try {
    const meUrl = `${base.replace(/\/files$/, '')}/me`;
    const mr = await xunleiProxyFetch(meUrl, probeHeaders, 'GET');
    if (mr && mr.ok) {
      let j = null; try { j = JSON.parse(mr.text); } catch (_) {}
      const sn = j && (j.space_name || j.spaceName || (j.user && (j.user.space_name || j.user.spaceName)));
      if (sn && candidates.indexOf(sn) < 0) candidates.push(sn);
      const sid = j && (j.id || (j.user && j.user.id));
      if (sid && candidates.indexOf('xl' + sid) < 0) candidates.push('xl' + sid);
      try { console.warn('[HMDAO][xunlei-proxy] /me 响应 space_name=', sn, 'id=', sid); } catch (_) {}
    } else {
      console.log('[HMDAO][xunlei-proxy] /me 非 2xx status=', mr && mr.status);
    }
  } catch (_) {}
  try {
    const listUrl = `${base}/files?space=${encodeURIComponent('')}&limit=10&page_token=&parent_folder_id=`;
    const lr = await xunleiProxyFetch(listUrl, probeHeaders, 'GET');
    if (lr && lr.ok) {
      let j = null; try { j = JSON.parse(lr.text); } catch (_) {}
      try { console.warn('[HMDAO][xunlei-proxy] 列表探测响应片段=', (lr.text || '').slice(0, 600)); } catch (_) {}
      if (j) {
        const collect = (v) => { if (v && typeof v === 'string' && /^xl\d+_/i.test(v) && candidates.indexOf(v) < 0) candidates.push(v); };
        for (const k of ['space', 'space_name', 'space_id']) { collect(j[k]); if (j.data) collect(j.data[k]); }
        const arr = j.files || (j.data && j.data.files) || [];
        for (const f of arr) { for (const k of ['space', 'space_name', 'space_id']) collect(f && f[k]); }
      }
    } else {
      console.log('[HMDAO][xunlei-proxy] 列表探测非 2xx status=', lr && lr.status);
    }
  } catch (_) {}
  // 3) 穷举兜底（drive 放最后，因其已被证实对 download_url 无效；空串最后试）
  for (const c of ['', 'drive']) { if (candidates.indexOf(c) < 0) candidates.push(c); }
  console.log('[HMDAO][xunlei-proxy] 最终 space 候选=', JSON.stringify(candidates));
  return candidates;
}

async function fetchXunleiMyDriveTreeViaProxy(url, knownFileIds, knownCandidates, knownAuth) {
  try {
    const u = new URL(url);
    const pathParam = u.searchParams.get('path') || '/';
    const base = 'https://api-pan.xunlei.com/drive/v1/files';
    // ★ 动态解析真实 space（不再写死 'drive'）
    const spaceCandidates = await resolveXunleiSpace('', knownCandidates || []);
    console.log('[HMDAO][mydrive-proxy] space 候选=', JSON.stringify(spaceCandidates));
    // ★ 2026-08-10 修复（根因）：迅雷的 device-id/client-id 只存在于页面 localStorage，
    //   background(SW 世界) 读不到 Cookie 里的它们 → "device_id is empty"。
    //   优先用 MAIN 世界捕获并传来的真实 deviceId/clientId（knownAuth），
    //   其次回退 readXunleiCookiesAuth（Cookie，通常缺失，仅作兜底），最后才用占位值。
    const realAuth = await readXunleiCookiesAuth();
    const headers = Object.assign({
      'Referer': 'https://pan.xunlei.com/',
    }, realAuth.headers);
    // ★ 优先注入 MAIN 世界捕获的真实 device-id/client-id（来自页面 localStorage）
    if (knownAuth && knownAuth.deviceId) { headers['x-device-id'] = knownAuth.deviceId; }
    if (knownAuth && knownAuth.clientId) { headers['x-client-id'] = knownAuth.clientId; }
    if (knownAuth && knownAuth.deviceId && !headers['x-device-id']) headers['x-device-id'] = knownAuth.deviceId;
    if (knownAuth && knownAuth.clientId && !headers['x-client-id']) headers['x-client-id'] = knownAuth.clientId;
    // 页面捕获的 Authorization / captcha（更贴近当前会话）优先于 Cookie 泛化值。
    if (knownAuth && knownAuth.authToken) headers.Authorization = knownAuth.authToken;
    if (knownAuth && knownAuth.captchaToken) {
      try { const c = knownAuth.captchaToken.replace(/[^\x00-\xFF]/g, ''); if (c) headers['x-captcha-token'] = c; } catch (_) {}
    }
    const parseDownload = (res) => {
      if (!res || !res.ok) return null;
      let json = null; try { json = JSON.parse(res.text); } catch (_) { return null; }
      const dl = json.download_url || (json.data && json.data.download_url) ||
        json.url || (json.data && json.data.url) ||
        json.web_content_link || (json.data && json.data.web_content_link) ||
        (json.links && (json.links.url || json.links.download_url));
      return dl ? { direct: dl, subFileId: json.sub_file_id || json.subFileId || (json.data && json.data.sub_file_id) || '' } : null;
    };

    const md = { list: [], fileInfo: {}, space: spaceCandidates[0] || 'drive', path: pathParam };
    // ★ download_url 遍历 space 候选，首个成功即采用（迅雷个人盘 space 名不确定）
    const tryDownloadUrl = async (fid) => {
      for (const sp of spaceCandidates) {
        const dlUrl = `${base}/download_url?space=${encodeURIComponent(sp)}&file_id=${encodeURIComponent(fid)}`;
        const dr = await xunleiProxyFetch(dlUrl, headers, 'GET');
        const got = parseDownload(dr);
        if (got) { md.space = sp; return got; }
        // ★ 诊断（2026-08-10）：把失败响应原文打印，区分「space 错」还是「缺 captcha/鉴权」。
        try { console.warn('[HMDAO][mydrive-proxy] download_url 失败 space=', sp, 'status=', dr && dr.status, 'resp=', (dr && dr.text || '').slice(0, 300)); } catch (_) {}
        if (dr && (dr.status === 401 || dr.status === 403)) break; // 鉴权失败，试别的 space 无意义
      }
      return null;
    };

    // ★ 优先：页面已捕获到真实文件 id，直接换直链（绕开根目录 BFS，避免 400）
    if (Array.isArray(knownFileIds) && knownFileIds.length) {
      console.log('[HMDAO][mydrive-proxy] 直接用已捕获 file_id 拉直链，数量=', knownFileIds.length);
      const ids = knownFileIds.filter(Boolean);
      let resolved = 0;
      let usedSpace = '';
      for (const fid of ids) {
        const got = await tryDownloadUrl(fid);
        if (got) { md.fileInfo[fid] = got; resolved++; if (!usedSpace) usedSpace = md.space; }
        else console.log('[HMDAO][mydrive-proxy] download_url 失败 fid=', fid);
      }
      // 拉取文件基础信息（名字/大小）用于回填列表
      if (!md.list.length && resolved) {
        const infoUrl = `${base}?space=${encodeURIComponent(usedSpace || md.space)}&id=${encodeURIComponent(ids.join(','))}&limit=200`;
        const ir = await xunleiProxyFetch(infoUrl, headers, 'GET');
        let ijson = null; try { ijson = JSON.parse(ir.text); } catch (_) {}
        const arr = ijson && (ijson.files || (ijson.data && ijson.data.files) || []);
        if (Array.isArray(arr)) {
          md.list = arr.filter((f) => !f.is_dir).map((f) => ({ id: f.id || f.file_id, name: f.name || f.file_name, size: Number(f.size || 0), isDir: false, medias: [] }));
        }
      }
      const ready = resolved > 0;
      return { ok: ready, md, _diag: { source: 'known-file-ids', resolved, total: ids.length, space: md.space } };
    }

    // ★ 兜底：完全没有捕获到 file_id（页面从未加载/老标签），尝试列根目录。
    //   注意：迅雷根目录 ID 不是 '0'，这里用不带 parent_folder_id 的方式列「我的网盘根」，
    //   若仍 400 则提示用户先打开并登录该页面（让 MAIN 钩子捕获到 id）。
    console.log('[HMDAO][mydrive-proxy] 无已捕获 file_id，尝试列根目录');
    for (const sp of spaceCandidates) {
      const rootUrl = `${base}?space=${encodeURIComponent(sp)}&limit=200&page_token=`;
      const rootRes = await xunleiProxyFetch(rootUrl, headers, 'GET');
      if (!rootRes || !rootRes.ok) continue;
      const arr = (() => { let j = null; try { j = JSON.parse(rootRes.text); } catch (_) { return null; } return j.files || (j.data && j.data.files) || []; })();
      if (Array.isArray(arr) && arr.length) {
        md.space = sp;
        md.list = arr.filter((f) => !f.is_dir).map((f) => ({ id: f.id || f.file_id, name: f.name || f.file_name, size: Number(f.size || 0), isDir: false, medias: [] }));
        return { ok: true, md, _diag: { source: 'root-list', listLen: md.list.length, space: sp } };
      }
    }
    return { ok: false, error: '列根目录失败，请先打开并登录该迅雷页面' };

    const files = items.filter((f) => !f.is_dir).map((f) => ({
      id: f.id || f.file_id,
      name: f.name || f.file_name,
      size: Number(f.size || 0),
      isDir: false,
      medias: [],
    }));
    md.list = files;

    // 逐个拉直链
    let resolved = 0;
    for (const f of files) {
      if (!f.id) continue;
      try {
        const dlUrl = `${base}/download_url?space=${space}&file_id=${encodeURIComponent(f.id)}`;
        const dlRes = await xunleiProxyFetch(dlUrl, headers, 'GET');
        const parsed = parseDownload(dlRes);
        if (parsed) {
          md.fileInfo[f.id] = { direct: parsed.direct, subFileId: parsed.subFileId, ts: Date.now() };
          resolved++;
        }
      } catch (_) {}
    }
    console.log('[HMDAO][mydrive-proxy] 拉取完成：文件', files.length, '已解析直链', resolved);
    return { ok: true, md, _diag: { source: 'xunlei-mydrive-proxy', listLen: files.length, resolved } };
  } catch (e) {
    console.log('[HMDAO][mydrive-proxy] 异常', String(e && e.stack || e));
    return { ok: false, error: '代理拉取异常：' + String(e && e.message || e) };
  }
}

async function handleXunleiMyDriveResolve(url) {
  console.log('[HMDAO][handleXunleiMyDriveResolve] start url=', url);
  const DEADLINE = Date.now() + 70000;
  const timedOut = () => Date.now() > DEADLINE;

  // 找已打开的迅雷自己网盘标签
  let tabId = null;
  try {
    const tabs = await chrome.tabs.query({ url: [url + '*', 'https://pan.xunlei.com/*'] });
    if (tabs && tabs.length) {
      const targetPath = new URL(url).searchParams.get('path') || '';
      tabId = tabs.find((t) => t.url && (t.url === url || (targetPath && t.url.includes('path=' + encodeURIComponent(targetPath)))))?.id || tabs[0].id;
    }
  } catch (_) {}
  if (!tabId) {
    try {
      const all = await chrome.tabs.query({});
      const targetHost = registeredDomain('pan.xunlei.com');
      for (const t of all) {
        if (!t.url) continue;
        try {
          const u = new URL(t.url);
          if (registeredDomain(u.hostname) === targetHost && /\?path=/.test(u.href)) { tabId = t.id; break; }
        } catch (_) {}
      }
    } catch (_) {}
  }
  if (!tabId) {
    // ★ 2026-08-09 修复：未找到已打开标签时，不再直接失败，
    //   改由 background 代理主动拉取（xunleiProxyFetch 带登录态，不依赖页面/后端），
    //   保证「已登录浏览器但标签关了」的场景也能下载，避免强依赖标签页存在。
    console.log('[HMDAO][handleXunleiMyDriveResolve] 未找到已打开标签，改走 background 代理兜底');
    const proxy = await fetchXunleiMyDriveTreeViaProxy(url);
    if (proxy && proxy.ok && proxy.md && proxy.md.list.length) {
      const md = proxy.md;
      const tree = md.list.map((f) => ({
        type: f.isDir ? 'folder' : 'file',
        name: f.name,
        size: f.size,
        direct: md.fileInfo && md.fileInfo[f.id] && md.fileInfo[f.id].direct,
        fileId: f.id,
        subFileId: (md.fileInfo && md.fileInfo[f.id] && md.fileInfo[f.id].subFileId) || '',
        isDir: f.isDir,
        resolved: !!(md.fileInfo && md.fileInfo[f.id] && md.fileInfo[f.id].direct),
      })).filter((n) => n.name);
      return { ok: true, tree, _diag: { source: 'xunlei-mydrive-proxy-nolabel', listLen: md.list.length, resolved: tree.filter((n) => n.direct).length } };
    }
    return { ok: false, requireLogin: !!(proxy && proxy.requireLogin), error: (proxy && proxy.error) || '未找到已打开的迅雷自己网盘页，且代理拉取失败' };
  }

  // 等待文件列表捕获
  let md = null;
  for (let i = 0; i < 20; i++) {
    if (timedOut()) break;
    try { md = await readXunleiMyDriveFromTab(tabId); } catch (_) {}
    if (md && md.list && md.list.length) break;
    try {
      await chrome.scripting.executeScript({
        target: { tabId }, world: 'MAIN',
        func: () => { if (window.__hmdao_xunlei_mydrive_salvage) window.__hmdao_xunlei_mydrive_salvage(); }
      });
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log('[HMDAO][handleXunleiMyDriveResolve] captured md=', md ? { listLen: md.list && md.list.length, fileInfoKeys: Object.keys(md.fileInfo || {}).length, space: md.space } : null);

  const mdHasList = md && md.list && md.list.length;
  const mdHasDirect = mdHasList && md.list.some((f) => f.id && md.fileInfo && md.fileInfo[f.id] && md.fileInfo[f.id].direct);
  // ★ 2026-08-09 修复：列表为空「或」列表有但直链全为空（MAIN 钩子没写回直链）时，
  //   都改由 background 代理主动拉取 download_url 直链。之前只在列表为空时兜底，
  //   导致「有列表无直链」的残废结果被当成功返回，下载流程拿不到 direct → 失败。
  if (!mdHasList || !mdHasDirect) {
    console.log('[HMDAO][handleXunleiMyDriveResolve] MAIN 捕获' + (mdHasList ? '列表有但直链为空' : '为空') + '，启用 background 代理兜底');
    // ★ 把页面已捕获到的真实 file_id 传给代理，直接换直链（绕开根目录 BFS 400）
    const knownFileIds = mdHasList ? md.list.filter((f) => !f.isDir && f.id).map((f) => f.id) : [];
    const knownCandidates = (md && Array.isArray(md.spaceCandidates)) ? md.spaceCandidates : [];
    const knownAuth = (md && (md.authToken || md.captchaToken || md.deviceId || md.clientId)) ? {
      authToken: md.authToken, captchaToken: md.captchaToken,
      deviceId: md.deviceId, clientId: md.clientId,
    } : null;
    const proxy = await fetchXunleiMyDriveTreeViaProxy(url, knownFileIds, knownCandidates, knownAuth);
    if (proxy && proxy.ok && proxy.md) {
      // 合并：保留 MAIN 列表里的名字/大小，用代理拉到的直链覆盖
      const merged = md || { list: [], fileInfo: {}, space: 'drive', path: '' };
      merged.fileInfo = Object.assign({}, merged.fileInfo, proxy.md.fileInfo);
      if (!merged.list.length && proxy.md.list.length) merged.list = proxy.md.list;
      md = merged;
    } else if (!mdHasList) {
      return { ok: false, requireLogin: !!(proxy && proxy.requireLogin), error: (proxy && proxy.error) || '未获取到文件列表，请确认页面已加载且已登录' };
    }
    // 若 MAIN 有列表但代理也失败，保留 MAIN 列表继续走下方 MAIN 直链补偿
  }

  // 触发 download_url 解析（MAIN 世界补直链，作为代理兜底的补充）
  const fileIds = md.list.filter((f) => !f.isDir && f.id).map((f) => f.id);
  if (fileIds.length) {
    const alreadyResolved = fileIds.filter((fid) => md && md.fileInfo && md.fileInfo[fid] && md.fileInfo[fid].direct).length;
    if (alreadyResolved < fileIds.length) {
      try { await triggerXunleiMyDriveFileInfo(tabId, fileIds); } catch (_) {}
      for (let i = 0; i < 30; i++) {
        if (timedOut()) break;
        try { md = await readXunleiMyDriveFromTab(tabId); } catch (_) {}
        const resolvedCount = fileIds.filter((fid) => md && md.fileInfo && md.fileInfo[fid] && md.fileInfo[fid].direct).length;
        if (resolvedCount >= Math.min(fileIds.length, 1)) break;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
  }

  // 构建 tree（与分享页保持一致的 flat array 格式）
  const tree = md.list.map((f) => ({
    type: f.isDir ? 'folder' : 'file',
    name: f.name,
    size: f.size,
    direct: f.medias && f.medias[0] && f.medias[0].url ? f.medias[0].url : (md.fileInfo && md.fileInfo[f.id] && md.fileInfo[f.id].direct),
    fileId: f.id,
    subFileId: f.subFileId || (md.fileInfo && md.fileInfo[f.id] && md.fileInfo[f.id].subFileId) || '',
    isDir: f.isDir,
    resolved: !!(md.fileInfo && md.fileInfo[f.id] && md.fileInfo[f.id].direct),
  })).filter((n) => n.name);

  return { ok: true, tree, _diag: { source: 'xunlei-mydrive', listLen: md.list.length, resolved: fileIds.filter((fid) => md.fileInfo && md.fileInfo[fid] && md.fileInfo[fid].direct).length } };
}

async function handleNetdiskResolve(url) {
  // ★ 2026-08-09 新增：迅雷自己网盘页（pan.xunlei.com/?path=...）走独立解析流程
  if (isXunleiMyDrive(url)) return handleXunleiMyDriveResolve(url);

  const { shareId, pwd, host } = parseNetdiskShareId(url);
  if (!shareId) return { ok: false, error: 'invalid-share-url' };
  const isXunlei = /xunlei\.(com|cn)$/.test(host);
  const isQuark = /quark\.(com|cn)$/.test(host);
  if (!isXunlei && !isQuark) return { ok: false, error: 'unsupported-netdisk' };
  // ★ 硬性自限时（2026-08-08）：保证无论循环拖多久，本函数必在 ~70s 内返回，
  // 否则 download.js 的 90s 兜底之前若还在跑会导致侧栏长期无响应。
  const DEADLINE = Date.now() + 70000;
  const timedOut = () => Date.now() > DEADLINE;
  // 1) 找已打开的分享页标签；没有则在后台创建
  let tabId = null;
  let created = false;
  console.log('[HMDAO][handleNetdiskResolve] start url=', url, 'shareId=', shareId, 'host=', host);
  try {
    const tabs = await chrome.tabs.query({ url: [`https://${host}/s/${shareId}*`, `http://${host}/s/${shareId}*`] });
    if (tabs && tabs.length) tabId = tabs[0].id;
  } catch (_) {}
  // fallback：URL pattern 匹配失败时全量遍历，按 hostname + shareId 兜底
  if (!tabId) {
    try {
      const all = await chrome.tabs.query({});
      const target = registeredDomain(host);
      for (const t of all) {
        if (!t.url) continue;
        try {
          const u = new URL(t.url);
          if (registeredDomain(u.hostname) === target && u.pathname.includes('/s/' + shareId)) { tabId = t.id; break; }
        } catch (_) {}
      }
    } catch (_) {}
  }
  console.log('[HMDAO][handleNetdiskResolve] found tabId=', tabId, 'created=', created);
  if (!tabId) {
    try {
      const tab = await chrome.tabs.create({ url, active: false });
      tabId = tab.id;
      created = true;
      await waitTabLoad(tabId, 12000);
    } catch (e) {
      return { ok: false, error: 'open-tab-failed: ' + (e && e.message) };
    }
  }
  // 2) 等待 MAIN 世界捕获到文件列表；每轮顺带触发兜底抢救扫描
  let xs = null;
  for (let i = 0; i < 20; i++) {
    if (timedOut()) break; // ★ 自限时：超期即停，不无限轮询
    try { xs = await readXunleiShareFromTab(tabId); } catch (_) {}
    if (xs && xs.list && xs.list.length) break;
    try {
      await chrome.scripting.executeScript({
        target: { tabId }, world: 'MAIN',
        func: () => { if (window.__hmdao_xunlei_salvage) window.__hmdao_xunlei_salvage(); },
      });
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log('[HMDAO][handleNetdiskResolve] captured xs=', xs ? { listLen: xs.list && xs.list.length, fileInfoKeys: Object.keys(xs.fileInfo || {}).length } : null);
  if (!xs || !xs.list || !xs.list.length) {
    if (created) try { chrome.tabs.remove(tabId).catch(() => {}); } catch (_) {}
    return { ok: false, requireLogin: true, error: '未获取到文件列表，可能需要登录或分享已失效' };
  }
  // 2.5) 文件夹递归：若列表含文件夹且尚未解析出压缩包，主动进入文件夹并重新读取
  const archiveRe = /\.(zip|rar|7z|tar|gz|tgz|iso|dmg|z|001|part|tar\.gz)$/i;
  let hasArchives = xs.list.some((f) => !f.isDir && archiveRe.test(f.name || ''));
  const folderIds = xs.list.filter((f) => f.isDir && f.id).map((f) => f.id);
  if (!hasArchives && folderIds.length) {
    console.log('[HMDAO][handleNetdiskResolve] list has folder(s), entering:', folderIds);
    try {
      await chrome.scripting.executeScript({
        target: { tabId }, world: 'MAIN',
        func: (fids) => {
          if (window.__hmdao_xunlei_enter_folder) {
            return Promise.all(fids.map((id) => window.__hmdao_xunlei_enter_folder(id)));
          }
          return null;
        },
        args: [folderIds]
      });
    } catch (_) {}
    // 等待文件夹内文件列表出现（MAIN 世界会 BFS 递归展开所有子文件夹）。
    // 等待条件：列表含非文件夹文件 且 不再有新文件夹产生（enteredFolders 与 folderQueue 都稳定）。
    let prevLen = -1;
    let stableCount = 0;
    for (let i = 0; i < 40; i++) {
      if (timedOut()) break; // ★ 自限时：文件夹递归等待超期即停，不拖满 20s
      try { xs = await readXunleiShareFromTab(tabId); } catch (_) {}
      const hasFiles = xs && xs.list && xs.list.some((f) => !f.isDir);
      const stillEntering = xs && xs.folderQueue && xs.folderQueue.length;
      const len = (xs && xs.list && xs.list.length) || 0;
      if (hasFiles && !stillEntering && len === prevLen) {
        stableCount++;
        if (stableCount >= 2) break; // 连续两轮无变化，视为稳定
      } else {
        stableCount = 0;
      }
      prevLen = len;
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log('[HMDAO][handleNetdiskResolve] after folder enter, listLen=', xs && xs.list && xs.list.length, 'files=', xs && xs.list && xs.list.filter((f) => !f.isDir).length);
    if (!xs || !xs.list || !xs.list.length) {
      return { ok: false, requireLogin: true, error: '已进入文件夹但未能列出素材，可能需要登录态' };
    }
  }
  // 3) 对所有非文件夹文件触发 download_url 拿真实下载直链（不只是 zip/rar，普通素材也要能下载）
  const fileIdsAll = xs.list
    .filter((f) => !f.isDir)
    .map((f) => f.id)
    .filter(Boolean);
  let fileInfoResolved = null;
  if (fileIdsAll.length) {
    fileInfoResolved = await triggerXunleiFileInfo(tabId, fileIdsAll);
    try { xs = await readXunleiShareFromTab(tabId); } catch (_) {}
  }
  const tree = xs.list.map((f) => ({
    name: f.name || '',
    size: f.size || '',
    isDir: !!f.isDir,
    isArchive: /\.(zip|rar|7z|tar|gz|tgz|iso|dmg|z|001|part|tar\.gz)$/i.test(f.name || ''),
    direct: (f.medias && f.medias[0] && f.medias[0].url) || (xs.fileInfo && xs.fileInfo[f.id] && xs.fileInfo[f.id].direct) || '',
    fileId: f.id || '',
    subFileId: (f && f.subFileId) || (xs.fileInfo && xs.fileInfo[f.id] && xs.fileInfo[f.id].subFileId) || '',
  }));
  // 透传直链解析诊断（含 download_url 接口每文件 status/error/body），供侧栏定位
  let _diag = null;
  try {
    const xs2 = await readXunleiShareFromTab(tabId);
    _diag = {
      fileInfoDirect: Object.keys((xs2 && xs2.fileInfo) || {}).reduce((acc, k) => { acc[k] = !!((xs2.fileInfo[k] || {}).direct); return acc; }, {}),
      resolveDetails: fileInfoResolved && fileInfoResolved.details ? fileInfoResolved.details : null,
      resolveOk: fileInfoResolved ? fileInfoResolved.ok : null,
      resolveError: fileInfoResolved && fileInfoResolved.error ? fileInfoResolved.error : null,
      resolveDiag: fileInfoResolved && fileInfoResolved.diag ? fileInfoResolved.diag : null,
    };
  } catch (_) {}
  // ★ 诊断（2026-08-08）：若 tree 全是文件夹、无任何可下载文件，说明迅雷对该分享的
  // 子文件夹内容强制 captcha（drive/v1/share?parent_folder_id 返回 400 captcha_token is empty），
  // 纯前端 API 无法展开。标记 needManualExpand，让侧栏提示用户「先在网页端点击进入该文件夹」。
  const onlyFolders = tree.length > 0 && tree.every((t) => t.isDir);
  const flag = onlyFolders ? { ok: true, tree, _diag, needManualExpand: true,
    hint: '该分享为文件夹，迅雷对其子内容强制验证码（captcha）。请先在网页端点击进入该文件夹，待文件列表出现后，再点击本面板的「解析」按钮。' } : { ok: true, tree, _diag };
  return flag;
}
// 显式挂到 globalThis，确保被 importScripts 加载的 router.js 能稳定引用（避免 SW 边界下函数声明提升不可见的时序问题）
if (typeof self !== 'undefined') self.handleNetdiskResolve = handleNetdiskResolve;

// 侧栏请求当前页面信息 + 缩略图预览
  if (msg && msg.type === HMDAO_MSG.CAPTURE_PAGE) {
    (async () => {
      try {
        // ★2026-08-24 深层修复（用户真机实测「切换到花瓣链接，侧栏顶部仍显示抖音，扫描却是花瓣」根因）：
        //   旧逻辑分支 1/2/3 优先 SOURCE_TAB_ID / douyin 域搜所有 tab，把「曾经记录过的抖音 tab」
        //   强塞给侧栏——只要那个抖音 tab 还开着，不论用户当前在看什么站，顶部 header 永远是抖音。
        //   真实需求：用户当前激活的 tab 才是「顶部当前页」，必须严格按 active tab 取。
        //   修复策略：
        //   1) 始终先取 active tab（用户当前正在看的页面）—— 主路径；
        //   2) 仅当 active tab 不可用（chrome:// / 扩展页 / 受限）时，才回退到 SOURCE_TAB_ID（已知 douyin 域），
        //      让预览仍能显示上一个抖音源页（而非错误的扩展页）；
        //   3) 把每次确认的 active tab tabId 写回 SOURCE_TAB_ID，下次优先复用，避免活动 tab 偶发空。
        let tab = null;
        // 1) 主路径：active tab（用户当前正在看的页面）—— 严格按此取
        try {
          const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (t && /^https?:/i.test(t.url || '')) tab = t;
        } catch (_) {}
        // 2) 仅当 active tab 不是 http(s)（如 chrome:// / 扩展页 / 新建标签页 about:blank）时，
        //    回退到 SOURCE_TAB_ID 记录的 douyin 源页，让预览仍能展示上一个抖音页而非错误页
        if (!tab && typeof SOURCE_TAB_ID === 'number' && SOURCE_TAB_ID != null) {
          try {
            const t = await chrome.tabs.get(SOURCE_TAB_ID);
            const host = (() => { try { return new URL(t.url).hostname; } catch (_) { return ''; } })();
            if (t && /^https?:/i.test(t.url) && /(douyin|tiktok|bytedance|iesdouyin)/i.test(host)) tab = t;
          } catch (_) {}
        }
        // 3) 兜底：所有 tab 找 douyin 域（极少用，仅前两步都失败）
        if (!tab) {
          try {
            const all = await chrome.tabs.query({});
            tab = (all || []).find((t) => {
              try {
                const h = new URL(t.url).hostname;
                return /^https?:/i.test(t.url) && /(douyin|tiktok|bytedance|iesdouyin)/i.test(h);
              } catch (_) { return false; }
            });
          } catch (_) {}
        }
        if (tab && tab.id) SOURCE_TAB_ID = tab.id;
        if (!tab) {
          sendResponse({ ok: false, error: 'no-source-tab' });
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
  // ★2026-08-24 修复（用户实测「现在预览播放都没有了」根因）：
  //   HMDAO_FS_*（侧栏 ↔ 源页 inject-main 帧流信令：START / OFFER / ANSWER / ICE / STOP / ERROR / STATE）原注释
  //   声称"chrome.runtime.sendMessage 天然投递到所有扩展上下文（含 MAIN world）"——【错】。
  //   实际只投递到 background service worker 和其他扩展页面，content scripts（含 MAIN world 注入脚本）不会自动接收。
  //   侧栏发 HMDAO_FS_START → background 收不到 handler → 源页 inject-main 永远不启动 → 帧流协商失败 → 侧栏黑屏。
  //   必须由 background 中转：chrome.runtime.onMessage 收 → chrome.tabs.sendMessage(tabId, msg) 发到源页 content scripts。
  //   反向亦然（源页发 OFFER/ICE/ERROR 到 background → 转发给侧栏 onMessage）。
  if (msg && typeof msg.type === 'string' && /^HMDAO_FS_/.test(msg.type)) {
    // ★帧流信令是双向广播（page ↔ panel），不阻塞其他 handler，直接转发 + sendResponse 占位
    (async () => {
      try {
        // 侧栏→源页：msg.from === 'panel'，带 tabId；转发到对应 tab content scripts
        if (msg.from === 'panel' && typeof msg.tabId === 'number') {
          // ★2026-08-24 修复（用户实测 URL 是 mssdk.bytedance.com 而非 jingxuan 根因）：
          //   侧栏 startDouyinFrameStream 第 142 行兜底用 chrome.tabs.query({active:true}) → 拿到 mssdk tab
          //   → 该 tab 没有 inject-main.js content script → 帧流信令无人接收 → 黑屏。
          //   转发前先校验 msg.tabId 的 host 是否 douyin 域，不是则用 pickDouyinLikeTab 自动替换。
          let targetTabId = msg.tabId;
          try {
            const t = await chrome.tabs.get(msg.tabId);
            const host = (() => { try { return new URL(t.url).hostname; } catch (_) { return ''; } })();
            if (!/(douyin|tiktok|bytedance|iesdouyin)/i.test(host)) {
              const fixed = await pickDouyinLikeTab('https://www.douyin.com/');
              if (fixed) targetTabId = fixed;
            }
          } catch (_) {
            const fixed = await pickDouyinLikeTab('https://www.douyin.com/');
            if (fixed) targetTabId = fixed;
          }
          // ★关键：覆盖原 msg.tabId 后再转发，确保侧栏 listener 收到的 tabId 也是 douyin tab（一致性）
          const fixed = Object.assign({}, msg, { tabId: targetTabId });
          if (msg.type === 'HMDAO_FS_START') {
            // ★2026-08-24 修复（见上）＋ ★2026-08-31 鲁棒化（用户实测「重载扩展后预览仍只显示图片」根因闭环）：
            //   旧版 inject-main.js 未把 __hmdaofs_start 挂到 window；且重载扩展时若源页标签未同步刷新，
            //   源页仍是旧代码 → window.__hmdaofs_start 恒 undefined → 源页从不发 OFFER → 侧栏永远停在封面图。
            //   改为「自包含启动」：executeScript 内直接定义并运行帧流发送端，不再依赖源页已暴露该函数。
            //   与 inject-main 的 __hmdaofs_start 二选一（优先用已注册的，避免双连），即使源页是旧版也能建连。
            try {
              await chrome.scripting.executeScript({
                target: { tabId: targetTabId },
                world: 'MAIN',
                func: () => {
                  try {
                    // 新版 inject-main 已暴露 → 直接复用，避免重复建连
                    if (typeof window.__hmdaofs_start === 'function') { window.__hmdaofs_start(); return; }
                    if (window.__hmdaofs_bootstrap_registered) return; // 已自注册则跳过
                    window.__hmdaofs_bootstrap_registered = true;
                    let pc = null, raf = null, canvas = null, ctx = null, stream = null;
                    // ★2026-08-31 增强（"预览显示别视频的房间画面"根因闭环）：与 inject-main 的 __hmdaofs_getVideo 同构。
                    //   优先级：(1) currentSrc 匹配 window.__hmdao_captures.curVideoSrc → (2) intrinsic 分辨率最大的非推荐 playing video。
                    //   去掉 blob 排除（canvas.drawImage 对 blob/MSE 合法）；排除推荐容器（recommend/related/sidebar/feed-item）与过小预览。
                    function getV() {
                      try {
                        const caps = window.__hmdao_captures || {};
                        const targetSrc = caps.curVideoSrc || '';
                        const all = Array.from(document.querySelectorAll('video'));
                        const isRecommendation = (x) => {
                          try {
                            if (x.offsetWidth < 300 || x.offsetHeight < 200) return true;
                            return !!x.closest('[class*="recommend" i], [class*="related" i], [class*="sidebar" i], [class*="side-video" i], [class*="feed-item" i]');
                          } catch (_) { return false; }
                        };
                        let v = null;
                        if (targetSrc) {
                          v = all.find((x) => x && (x.currentSrc || x.src) === targetSrc && x.readyState >= 2 && x.videoWidth >= 32 && !x.paused) || null;
                        }
                        if (!v) {
                          let maxA = 0;
                          for (const x of all) {
                            try {
                              if (!x || x.readyState < 2 || x.videoWidth < 32 || x.paused || x.ended) continue;
                              if (isRecommendation(x)) continue;
                              const a = x.videoWidth * x.videoHeight;
                              if (a > maxA) { maxA = a; v = x; }
                            } catch (_) {}
                          }
                        }
                        return (v && v.tagName === 'VIDEO' && v.readyState >= 2 && v.videoWidth >= 32) ? v : null;
                      } catch (_) { return null; }
                    }
                    function stop() {
                      if (raf) { cancelAnimationFrame(raf); raf = null; }
                      if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
                      if (pc) { try { pc.close(); } catch (_) {} pc = null; }
                      canvas = null; ctx = null;
                    }
                    function send(type, data) { try { chrome.runtime.sendMessage(Object.assign({ type: type, from: 'page' }, data || {})); } catch (_) {} }
                    window.__hmdaofs_start = function () {
                      stop();
                      const v = getV();
                      if (!v) { send('HMDAO_FS_ERROR', { error: 'no-video' }); return; }
                      const w = v.videoWidth, h = v.videoHeight, tw = 360, th = Math.round(360 * h / w);
                      canvas = document.createElement('canvas'); canvas.width = tw; canvas.height = th;
                      ctx = canvas.getContext('2d');
                      const draw = () => { const vv = getV(); if (vv) { try { ctx.drawImage(vv, 0, 0, tw, th); } catch (_) {} } raf = requestAnimationFrame(draw); };
                      draw();
                      try { stream = canvas.captureStream(30); } catch (_) { try { stream = canvas.captureStream(); } catch (_) {} }
                      if (!stream) { send('HMDAO_FS_ERROR', { error: 'captureStream-unsupported' }); return; }
                      pc = new RTCPeerConnection({ iceServers: [] });
                      pc.onicecandidate = (e) => { if (e && e.candidate) send('HMDAO_FS_ICE', { candidate: e.candidate }); };
                      stream.getVideoTracks().forEach((t) => { try { pc.addTrack(t, stream); } catch (_) {} });
                      pc.createOffer().then((offer) => pc.setLocalDescription(offer).then(() => {
                        send('HMDAO_FS_OFFER', { sdp: offer.sdp, type: offer.type });
                      })).catch(() => send('HMDAO_FS_ERROR', { error: 'createOffer-failed' }));
                    };
                    chrome.runtime.onMessage.addListener((m) => {
                      if (!m || !m.type) return;
                      if (m.type === 'HMDAO_FS_START') window.__hmdaofs_start();
                      else if (m.type === 'HMDAO_FS_ANSWER') { if (pc && m.sdp) pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }).catch(() => {}); }
                      else if (m.type === 'HMDAO_FS_ICE') { if (pc && m.candidate) pc.addIceCandidate(m.candidate).catch(() => {}); }
                      else if (m.type === 'HMDAO_FS_STOP') stop();
                    });
                    window.__hmdaofs_start();
                  } catch (e) { console.log('[HMDAO][fs] 兜底启动失败:', e && e.message); }
                },
              });
              console.log('[HMDAO][fs] bg executeScript 启动源页帧流 → tabId=' + targetTabId);
            } catch (e) {
              console.log('[HMDAO][fs] bg executeScript 失败（回退 tabs.sendMessage）:', e && e.message);
              chrome.tabs.sendMessage(targetTabId, fixed).catch((err) => { console.log('[HMDAO][fs] bg tabs.sendMessage 也失败:', err && err.message); });
            }
          } else {
            console.log('[HMDAO][fs] bg 转发 panel→page ' + msg.type + ' → tabId=' + targetTabId + (targetTabId !== msg.tabId ? ' (已修正 mssdk→douyin)' : ''));
            chrome.tabs.sendMessage(targetTabId, fixed).catch((e) => { console.log('[HMDAO][fs] bg tabs.sendMessage 失败:', e && e.message); });
          }
        } else if (msg.from === 'page') {
          // 源页→侧栏：转发到所有扩展页面（popup / sidepanel / options 等）。不指定特定面板用 broadcast。
          chrome.runtime.sendMessage(msg).catch(() => {});
        }
      } catch (_) {}
    })();
    sendResponse({ ok: true, forwarded: true });
    return true;
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
  // ★2026-08-21 修复:抖音合集「切到此集」按钮触发后,等 2.5s 让 inject-main 抓到该集 dyUrl,
  //   然后 sidepanel 让 background 强制对目标 tab 重新扫描,以同步新条目到侧栏。
  if (msg && msg.type === 'HMDAO_RESCAN_TAB') {
    // ★2026-09-04 崩溃修复：本 onMessage 监听器的 sender 形参名为【_sender】（见下方 AI_CHAT 分支
    //   的 `_sender && _sender.tab`）。此处误写成 `sender` → ReferenceError: sender is not defined，
    //   导致整段 HMDAO_RESCAN_TAB 处理中断、重扫从不执行（新增的 onHistoryStateUpdated 正好踩中）。
    const tid = (msg && msg.tabId) || (_sender && _sender.tab && _sender.tab.id);
    if (tid) {
      scanTab(tid, { deep: true }).catch(() => {});
      startPolling(tid);
    }
    sendResponse({ ok: true });
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
        // Referer 取值：抖音/TikTok 系列按域名分平台；视频号用当前 host；其余用注册域
        let referer = msg.referer || '';
        if (!referer) {
          if (host.includes('tiktok')) referer = 'https://www.tiktok.com/';
          else if (host.includes('douyin') || host.includes('bytedance')) referer = 'https://www.douyin.com/';
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
        // ★2026-08-22 修复 v2（真机日志二次实证根因）：上一版把 creds 改 include 仍 403，
        //   日志：FETCH_MEDIA failed host=sf6-cdn-tos.douyinstatic.com ... creds=include
        //   → 真实根因是 Chrome SW 跨域 fetch 会强制把 Referer 重写为 chrome-extension://origin，
        //   抖音 CDN 严格校验 Referer: https://www.douyin.com/ → 403 防盗链。
        //   修正：抖音/视频号 CDN（sf*-cdn-tos.douyinstatic.com / lf*-static.bytednsdoc.com / douyinvod 等）
        //   必须在【源页 MAIN 世界】fetch（继承页面 Referer + Cookie + 第三方会话），与原生 <video>/<audio> 一致。
        //   路径与 YouTube 完全一致：先 fetchMediaInTabWithCookie（MAIN 世界），失败再 SW 兜底。
        //   非抖音/非视频号保留 SW 主路径不变。
        const isDouyinCdn = /(^|\.)(douyinstatic\.com|douyinvod|tiktokcdn|bytednsdoc|ibeivod|tospush)\./i.test(host)
          || host.endsWith('.douyin.com') || host.endsWith('.tiktok.com');
        if (isDouyinCdn) {
          // 找源页（抖音/iesdouyin/抖音创作者中心等均在此搜索）
          let srcTab = null;
          try { srcTab = await pickSourceTabForUrl(url); } catch (_) {}
          if (!srcTab) {
            try {
              const dom = registeredDomain(host);
              const tabs = await chrome.tabs.query({});
              const m = (tabs || []).find((t) => { try { return registeredDomain(new URL(t.url).hostname) === dom; } catch (_) { return false; } });
              if (m) srcTab = m.id;
            } catch (_) {}
          }
          if (!srcTab) {
            try {
              const dyTabs = await chrome.tabs.query({ url: ['*://*.douyin.com/*', '*://*.iesdouyin.com/*', '*://*.tiktok.com/*'] });
              if (dyTabs && dyTabs.length) srcTab = dyTabs[0].id;
            } catch (_) {}
          }
          if (srcTab) {
            // 关键：Referer 必须明确传 https://www.douyin.com/，源页 MAIN 世界 fetch 才能真正带上这个 Referer
            const ref = referer || 'https://www.douyin.com/';
            const pr = await fetchMediaInTabWithCookie(srcTab, url, ref);
            if (pr && pr.ok && pr.arrayBuffer) {
              sendResponse({ ok: true, mime: pr.mime, b64: abToB64(pr.arrayBuffer), size: pr.arrayBuffer.byteLength });
              return true;
            }
            console.warn('[HMDAO][bg] 抖音 CDN 源页 MAIN fetch 失败，回退 SW：', pr && (pr.status || pr.error));
          } else {
            console.warn('[HMDAO][bg] 抖音 CDN 无源页标签可借，回退 SW（可能仍 403）');
          }
        }
        // SW 兜底（含非抖音 CDN 走原逻辑 + 无源页时的抖音降级）
        const creds = (host.includes('googlevideo') || host.includes('youtube'))
          ? 'omit' // YouTube Cookie 经 dNR 注入
          : (typeof msg.credentials === 'string' ? msg.credentials : 'include');
        const resp = await fetchUrl({ url, referer, credentials: creds });
        // 注意：ArrayBuffer 无法通过 chrome.runtime.sendMessage 可靠回传（会被克隆成空对象），
        // 故改为 base64 字符串传输（侧栏再解码为字节 → Blob），跨消息通道稳定。
        if (resp && resp.ok && resp.arrayBuffer) {
          sendResponse({ ok: true, mime: resp.mime, b64: abToB64(resp.arrayBuffer), size: resp.arrayBuffer.byteLength });
        } else {
          // ★失败时打一条可见日志，让用户在 chrome://extensions → 服务工作者（service worker）
          // 面板里直接看到 "哪个 URL 为什么失败"，省去前后台切换盲猜。
          // 但抖音 BGM/视频直链常因防盗链签名过期返回 403/404（正常、可忽略），降级为 debug 避免刷屏。
          const status = (resp && resp.status) || 0;
          if (status === 403 || status === 404) {
            console.debug('[HMDAO][bg] FETCH_MEDIA skip(host=%s, status=%d): %s', host, status, url);
          } else {
            console.warn('[HMDAO][bg] FETCH_MEDIA failed host=%s url=%s referer=%s creds=%s detail=%o', host, url, referer, creds, resp);
          }
          sendResponse(resp);
        }
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }
  // ★层2兜底：在源页标签页面上下文 fetch 封面图（继承 ttwid / SESSDATA 等会话 Cookie）。
  // 背景：抖音 PCDN (p1-sign.douyinpic.com/...) / B站防盗链签名图等仅凭 URL+Referer 无法读到
  // 真实图（403），必须携带页面注入的会话 Cookie 才回 200 + 真实 m4/hd 字节。
  if (msg && msg.type === 'HMDAO_FETCH_MEDIA_IN_TAB') {
    (async () => {
      try {
        // ★守卫：伪 URL（豆包 WS 朗读 doubao-ws-audio://ts）不得进源页 fetch
        if (!/^https?:/i.test(String(msg.url || ''))) { sendResponse({ ok: false, error: 'unsupported-scheme' }); return true; }
        const tabId = msg.tabId || (await pickSourceTabForUrl(msg.url || ''));
        if (!tabId) { sendResponse({ ok: false, error: 'no-tab' }); return true; }
        // usePageCookie=true：在源页 MAIN 世界用 credentials:'include' 拉取，
        // 继承页面会话 Cookie（抖音 ttwid/SESSDATA 等），专为「SW fetch(omit) + ISOLATED 兜底都拿不到」的
        // 防盗链视频/音频流场景（sf*-cdn-tos.douyinstatic.com / ies-music/*.mp3）回退。
        const usePageCookie = !!msg.usePageCookie;
        const t = usePageCookie
          ? await fetchMediaInTabWithCookie(tabId, msg.url, msg.referer || '')
          : await fetchMediaInTab(tabId, msg.url, msg.referer || '');
        if (t && t.ok && t.arrayBuffer) {
          sendResponse({ ok: true, mime: t.mime || 'image/*', b64: abToB64(t.arrayBuffer), size: t.arrayBuffer.byteLength });
        } else {
          sendResponse(t || { ok: false, error: 'empty' });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }
  // ★2026-08-24 修复（用户实测「侧栏黑屏不播放」根因）：
  //   fetchMediaViaBackground 发 HMDAO_FETCH_MEDIA 但 background.js 此前【没有 handler】，消息无人接收，
  //   chrome.runtime.sendMessage 不 reject（无 callback），侧栏 .then(res) 永远 pending → fallbackCdnRefetch
  //   永远走不到 blob URL 切换 → 探针黑屏一直显示。本 handler：SW 优先 fetch（手动注入 Referer），
  //   失败回退到源页 MAIN 世界 fetch（带 session Cookie，抖音/防盗链视频唯一能拿字节的路径）。
  // ★豆包朗读 WS 音频取字节（仅在用户点预览/下载时调用）：
  //   在源页 MAIN 世界把旁路收集到的 WS 分片拼成完整音频，识别 'OggS' 起点（跳过可能的协议头），
  //   返回 base64 + mime。字节平时留在页面，扫描阶段只传元数据 → 零卡顿。
  if (msg && msg.type === 'HMDAO_GET_DOUBAO_WS_AUDIO') {
    (async () => {
      try {
        const tabId = msg.tabId || await pickSourceTabForUrl('https://www.doubao.com/');
        if (!tabId) { sendResponse({ ok: false, error: 'no-tab' }); return true; }
        const [r] = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: function (wantTs) {
            try {
              const c = window.__hmdao_captures || {};
              // ★按会话隔离（写入时）：采集只按当前会话（/chat/<id>）的桶写，切会话互不串。
              //   【读取时】不能只查当前桶：模板页没 /chat/<id> 落入 'root' 桶，而豆包在模板试听时常
              //   跳转到 /chat/<id> 或反向 —— 读取时刻的 pathname 与采集时刻不同 → 只查当前桶必
              //   no-data → 卡片"有扫描、没文件、点不动"。故读取改为【跨全部桶按 ts 精确匹配】。
              const allBuckets = (c.doubaoTtsByChat && typeof c.doubaoTtsByChat === 'object') ? Object.keys(c.doubaoTtsByChat) : [];
              let list = [];
              for (const bkKey of allBuckets) {
                const bk = c.doubaoTtsByChat[bkKey];
                if (!bk) continue;
                list = list.concat(bk.list || [], bk.cur ? [bk.cur] : []);
              }
              let b = null;
              if (wantTs) {
                for (let i = 0; i < list.length; i++) {
                  if (list[i] && Number(list[i].ts) === Number(wantTs)) { b = list[i]; break; }
                }
              }
              if (!b) {
                const sorted = list.filter(function (x) { return x && x.bytes > 512; })
                  .sort(function (x, y) { return (Number(y.ts) || 0) - (Number(x.ts) || 0); });
                b = sorted[0] || null;
              }
              if (!b || !b.chunks || !b.chunks.length) return { ok: false, error: 'no-data' };
              let total = 0;
              for (let i = 0; i < b.chunks.length; i++) total += b.chunks[i].length;
              const all = new Uint8Array(total);
              let off = 0;
              for (let i = 0; i < b.chunks.length; i++) { all.set(b.chunks[i], off); off += b.chunks[i].length; }
              // 找 OggS 起始（前 4KB 内搜索，跳过 sami 协议头）
              let start = 0;
              const lim = Math.min(all.length, 4096);
              for (let i = 0; i + 4 <= lim; i++) {
                if (all[i] === 0x4F && all[i + 1] === 0x67 && all[i + 2] === 0x67 && all[i + 3] === 0x53) { start = i; break; }
              }
              const hasOgg = (all.length - start) > 1024;
              const body = hasOgg ? all.subarray(start) : all;
              let bin = '';
              const CH = 0x8000;
              for (let i = 0; i < body.length; i += CH) {
                bin += String.fromCharCode.apply(null, Array.from(body.subarray(i, i + CH)));
              }
              return {
                ok: true, b64: btoa(bin), size: body.length,
                mime: hasOgg ? 'audio/ogg' : 'application/octet-stream',
                ogg: hasOgg, url: String(b.url || ''), ts: Number(b.ts) || 0,
              };
            } catch (e) {
              return { ok: false, error: String((e && e.message) || e) };
            }
          },
          args: [Number(msg.ts) || 0],
        });
        // ★修复（no-result 真凶）：executeScript 已用 const [r] 解构出第一个 InjectionResult，
        //   再取 r[0] 恒为 undefined → got 永远 null → 所有调用方都收到 no-result。
        const got = (r && typeof r === 'object' && r.result) ? r.result : null;
        // 诊断日志：定位「no-result」到底是没注入 / 没数据 / 取字节失败
        try {
          console.log('[HMDAO][doubao] 取字节结果 ' + JSON.stringify({
            tabId, ts: Number(msg.ts) || 0,
            injected: !!(r && typeof r === 'object'),
            res: got ? { ok: got.ok, size: got.size, ogg: got.ogg, error: got.error } : null,
          }));
        } catch (_) {}
        sendResponse(got || { ok: false, error: 'no-result' });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }
  // ★豆包朗读下载（首选路径）：在【源页内】把收集到的字节合成 Blob 并用 <a download> 触发下载。
  //   字节不出页面 → 不受 sendMessage/executeScript 回传大小限制，长朗读也稳。
  //   仍不改动源页任何既有逻辑（只临时创建一个 <a> 并立即移除）。
  if (msg && msg.type === 'HMDAO_DOWNLOAD_DOUBAO_WS_AUDIO') {
    (async () => {
      try {
        const tabId = msg.tabId || await pickSourceTabForUrl('https://www.doubao.com/');
        if (!tabId) { sendResponse({ ok: false, error: 'no-tab' }); return true; }
        const [r] = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: function (wantTs, wantName) {
            try {
              const c = window.__hmdao_captures || {};
              // ★按会话隔离（写入时）：采集只按当前会话（/chat/<id>）的桶写，切会话互不串。
              //   【读取时】不能只查当前桶：模板页没 /chat/<id> 落入 'root' 桶，而豆包在模板试听时常
              //   跳转到 /chat/<id> 或反向 —— 读取时刻的 pathname 与采集时刻不同 → 只查当前桶必
              //   no-data → 卡片"有扫描、没文件、点不动"。故读取改为【跨全部桶按 ts 精确匹配】。
              const allBuckets = (c.doubaoTtsByChat && typeof c.doubaoTtsByChat === 'object') ? Object.keys(c.doubaoTtsByChat) : [];
              let list = [];
              for (const bkKey of allBuckets) {
                const bk = c.doubaoTtsByChat[bkKey];
                if (!bk) continue;
                list = list.concat(bk.list || [], bk.cur ? [bk.cur] : []);
              }
              let b = null;
              if (wantTs) {
                for (let i = 0; i < list.length; i++) {
                  if (list[i] && Number(list[i].ts) === Number(wantTs)) { b = list[i]; break; }
                }
              }
              if (!b) {
                const sorted = list.filter(function (x) { return x && x.bytes > 512; })
                  .sort(function (x, y) { return (Number(y.ts) || 0) - (Number(x.ts) || 0); });
                b = sorted[0] || null;
              }
              if (!b || !b.chunks || !b.chunks.length) return { ok: false, error: 'no-data' };
              let total = 0;
              for (let i = 0; i < b.chunks.length; i++) total += b.chunks[i].length;
              const all = new Uint8Array(total);
              let off = 0;
              for (let i = 0; i < b.chunks.length; i++) { all.set(b.chunks[i], off); off += b.chunks[i].length; }
              let start = 0;
              const lim = Math.min(all.length, 4096);
              for (let i = 0; i + 4 <= lim; i++) {
                if (all[i] === 0x4F && all[i + 1] === 0x67 && all[i + 2] === 0x67 && all[i + 3] === 0x53) { start = i; break; }
              }
              const hasOgg = (all.length - start) > 1024;
              const body = hasOgg ? all.subarray(start) : all;
              const blob = new Blob([body], { type: hasOgg ? 'audio/ogg' : 'application/octet-stream' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = wantName || ('豆包朗读_' + (Number(b.ts) || Date.now()) + (hasOgg ? '.ogg' : '.bin'));
              a.style.display = 'none';
              document.body.appendChild(a);
              a.click();
              setTimeout(function () { try { a.remove(); } catch (_) {} }, 0);
              setTimeout(function () { try { URL.revokeObjectURL(url); } catch (_) {} }, 60000);
              return { ok: true, size: body.length, ogg: hasOgg, name: a.download };
            } catch (e) {
              return { ok: false, error: String((e && e.message) || e) };
            }
          },
          args: [Number(msg.ts) || 0, String(msg.name || '')],
        });
        const got = (r && typeof r === 'object' && r.result) ? r.result : null;
        try { console.log('[HMDAO][doubao] 源页内下载结果 ' + JSON.stringify(got)); } catch (_) {}
        sendResponse(got || { ok: false, error: 'no-result' });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }
  // ★豆包朗读「源页内试听」：字节不出页面（不回传 → 不受消息大小限制），
  //   在源页 MAIN 世界合成 Blob 后用游离 <audio> 播放。悬停/点击都走这条，失败静默。
  if (msg && msg.type === 'HMDAO_PLAY_DOUBAO_WS_AUDIO') {
    (async () => {
      try {
        const tabId = msg.tabId || await pickSourceTabForUrl('https://www.doubao.com/');
        if (!tabId) { sendResponse({ ok: false, error: 'no-tab' }); return true; }
        const [r] = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: function (wantTs) {
            try {
              // 播放新的之前先停掉上一段，避免叠音
              try {
                const prev = window.__hmdao_doubao_prev_el;
                if (prev) { prev.pause(); if (prev.src && /^blob:/i.test(prev.src)) { try { URL.revokeObjectURL(prev.src); } catch (_) {} } }
              } catch (_) {}
              const c = window.__hmdao_captures || {};
              // ★按会话隔离（写入时）：采集只按当前会话（/chat/<id>）的桶写，切会话互不串。
              //   【读取时】不能只查当前桶：模板页没 /chat/<id> 落入 'root' 桶，而豆包在模板试听时常
              //   跳转到 /chat/<id> 或反向 —— 读取时刻的 pathname 与采集时刻不同 → 只查当前桶必
              //   no-data → 卡片"有扫描、没文件、点不动"。故读取改为【跨全部桶按 ts 精确匹配】。
              const allBuckets = (c.doubaoTtsByChat && typeof c.doubaoTtsByChat === 'object') ? Object.keys(c.doubaoTtsByChat) : [];
              let list = [];
              for (const bkKey of allBuckets) {
                const bk = c.doubaoTtsByChat[bkKey];
                if (!bk) continue;
                list = list.concat(bk.list || [], bk.cur ? [bk.cur] : []);
              }
              let b = null;
              if (wantTs) {
                for (let i = 0; i < list.length; i++) {
                  if (list[i] && Number(list[i].ts) === Number(wantTs)) { b = list[i]; break; }
                }
              }
              if (!b) {
                const sorted = list.filter(function (x) { return x && x.bytes > 512; })
                  .sort(function (x, y) { return (Number(y.ts) || 0) - (Number(x.ts) || 0); });
                b = sorted[0] || null;
              }
              if (!b || !b.chunks || !b.chunks.length) return { ok: false, error: 'no-data' };
              let total = 0;
              for (let i = 0; i < b.chunks.length; i++) total += b.chunks[i].length;
              const all = new Uint8Array(total);
              let off = 0;
              for (let i = 0; i < b.chunks.length; i++) { all.set(b.chunks[i], off); off += b.chunks[i].length; }
              let start = 0;
              const lim = Math.min(all.length, 4096);
              for (let i = 0; i + 4 <= lim; i++) {
                if (all[i] === 0x4F && all[i + 1] === 0x67 && all[i + 2] === 0x67 && all[i + 3] === 0x53) { start = i; break; }
              }
              const hasOgg = (all.length - start) > 1024;
              const body = hasOgg ? all.subarray(start) : all;
              const blob = new Blob([body], { type: hasOgg ? 'audio/ogg' : 'application/octet-stream' });
              const url = URL.createObjectURL(blob);
              const el = new Audio(url);
              el.preload = 'auto';
              window.__hmdao_doubao_prev_el = el;
              const p = el.play();
              if (p && p.catch) p.catch(function () {}); // 自动播放策略拒绝时静默（不抛红字）
              el.addEventListener('ended', function () {
                try { if (el.src && /^blob:/i.test(el.src)) URL.revokeObjectURL(el.src); } catch (_) {}
              }, { once: true });
              return { ok: true, size: body.length, ogg: hasOgg };
            } catch (e) {
              return { ok: false, error: String((e && e.message) || e) };
            }
          },
          args: [Number(msg.ts) || 0],
        });
        sendResponse((r && typeof r === 'object' && r.result) || { ok: false, error: 'no-result' });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }
  // 停止源页内的豆包朗读试听（悬停移开 / 切窗口时调用）
  if (msg && msg.type === 'HMDAO_STOP_DOUBAO_WS_AUDIO') {
    (async () => {
      try {
        const tabId = msg.tabId || await pickSourceTabForUrl('https://www.doubao.com/');
        if (!tabId) { sendResponse({ ok: false, error: 'no-tab' }); return true; }
        await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: function () {
            try {
              const el = window.__hmdao_doubao_prev_el;
              if (el) {
                try { el.pause(); } catch (_) {}
                try { if (el.src && /^blob:/i.test(el.src)) URL.revokeObjectURL(el.src); } catch (_) {}
                window.__hmdao_doubao_prev_el = null;
              }
              return { ok: true };
            } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
          },
        }).catch(() => {});
        sendResponse({ ok: true });
      } catch (_) { sendResponse({ ok: false }); }
    })();
    return true;
  }
  if (msg && msg.type === 'HMDAO_FETCH_MEDIA') {
    (async () => {
      try {
        const url = String(msg.url || '');
        const referer = String(msg.referer || 'https://www.douyin.com/');
        // ★伪 URL 资产（如豆包 WS 朗读 doubao-ws-audio://ts）绝不能进 fetch，
        //   否则控制台刷 "URL scheme is not supported" 报错（违反不影响源页/不报错的边界）。
        if (!url) { sendResponse({ ok: false, error: 'no-url' }); return true; }
        if (!/^https?:/i.test(url)) { sendResponse({ ok: false, error: 'unsupported-scheme' }); return true; }
        try {
          const r = await fetch(url, { method: 'GET', credentials: 'omit', headers: { Referer: referer }, cache: 'no-store', redirect: 'follow' });
          if (r && r.ok) {
            const ab = await r.arrayBuffer();
            sendResponse({ ok: true, mime: r.headers.get('content-type') || 'video/mp4', b64: abToB64(ab), size: ab.byteLength, status: r.status });
            return true;
          }
          const swStatus = r ? r.status : 0;
          // ★2026-08-24 修复：pickSourceTabForUrl 用 registeredDomain 匹配，但抖音 CDN douyinvod.com 与源页 douyin.com
          //   不同注册域 → 找不到源页 → no-tab 失败。改为：先试 msg.tabId，再 SOURCE_TAB_ID，再所有 douyin.com tab。
          const tabId = msg.tabId || await pickDouyinLikeTab(url);
          if (tabId) {
            const t = await fetchMediaInTabWithCookie(tabId, url, referer);
            if (t && t.ok && t.arrayBuffer) {
              sendResponse({ ok: true, mime: t.mime || 'video/mp4', b64: abToB64(t.arrayBuffer), size: t.arrayBuffer.byteLength, status: 200 });
              return true;
            }
            sendResponse({ ok: false, error: t && (t.error || 'tab-fetch-fail'), status: swStatus || 0 });
          } else {
            sendResponse({ ok: false, error: 'no-tab', status: swStatus });
          }
        } catch (e) {
          try {
            const tabId = msg.tabId || await pickDouyinLikeTab(url);
            if (tabId) {
              const t = await fetchMediaInTabWithCookie(tabId, url, referer);
              if (t && t.ok && t.arrayBuffer) {
                sendResponse({ ok: true, mime: t.mime || 'video/mp4', b64: abToB64(t.arrayBuffer), size: t.arrayBuffer.byteLength, status: 200 });
                return true;
              }
            }
          } catch (_) {}
          sendResponse({ ok: false, error: String((e && e.message) || e) });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }
  // ★2026-08-24 新增（抖音/防盗链 CDN 真正下载）：在【源页 MAIN 世界】创建 <a download href=直链> 并点击。
  // 根因：抖音 CDN 直链签名绑定源页 IP+session，且跨域无 CORS 头，故：
  //   - 侧栏/后台 fetch 直连 → CORS Failed to fetch / 403（签名绑定 IP）
  //   - chrome.downloads 直连 → Referer=chrome-extension → 403 且被当作「成功」写出 HTML 文本
  //   唯独【源页 context 内 <a download> 点击】是 no-cors 媒体下载，仅校验 Referer=源页 douyin.com（合法） →
  //   抖音放行 → 浏览器真正下载 mp4 字节。这是纯前端扩展能拿真实抖音视频的唯一可靠途径
  //   （与第三方解析站「服务端代理」不同，本扩展无后端，只能借源页会话）。
  if (msg && msg.type === 'HMDAO_DOWNLOAD_IN_TAB') {
    (async () => {
      try {
        // ★2026-08-31 修复（"右键下载后源视频页消失 + 缩略图丢失"真凶闭环）：
        //   必须用【源页 bilibili.com】找 tab，而非直链 bilivideo.com（二者注册域不同，
        //   pickSourceTabForUrl 按注册域匹配会把 mp4 页当候选 → 注入错误 tab）。
        //   故优先 msg.tabId，其次按 sourcePageUrl（bilibili.com）找源页，最后回退直链域名。
        const tabId = msg.tabId || (await pickSourceTabForUrl(msg.sourcePageUrl || msg.url || ''));
        if (!tabId) { sendResponse({ ok: false, error: 'no-tab' }); return true; }
        const [r] = await chrome.scripting.executeScript({
          target: { tabId }, world: 'MAIN',
          // 双保险注入：先 fetch→blob→同源<a download>（绝对不导航源页、无 64MB 上限、带登录 Cookie），
          // 跨域无 CORS 头时 fetch 失败 → 兜底 <a target=_blank>（新标签打开 mp4，Chrome 自动下载，源页不导航）。
          func: async (u, fname) => {
            const name = (fname || 'video.mp4').replace(/[\\/:*?"<>|]/g, '_');
            // ★2026-08-31 分平台 referrer：TikTok→www.tiktok.com，抖音/字节→www.douyin.com，其余→www.bilibili.com
            const __ref = /tiktok/i.test(u) ? 'https://www.tiktok.com/'
              : (/douyin|bytedance/i.test(u) ? 'https://www.douyin.com/' : 'https://www.bilibili.com/');
            try {
              const resp = await fetch(u, {
                credentials: 'include',
                referrer: __ref,
                referrerPolicy: 'unsafe-url',
                mode: 'cors',
              });
              if (resp && resp.ok) {
                const blob = await resp.blob();
                const blobUrl = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = blobUrl;
                a.download = name;
                a.style.display = 'none';
                document.body.appendChild(a);
                a.click();
                setTimeout(() => { try { URL.revokeObjectURL(blobUrl); a.remove(); } catch (_) {} }, 5000);
                return { ok: true, method: 'blob' };
              }
            } catch (_) { /* CORS/网络失败 → 走 target=_blank 兜底 */ }
            try {
              const a = document.createElement('a');
              a.href = u;
              a.download = name;
              a.target = '_blank';
              a.rel = 'noopener noreferrer';
              a.style.display = 'none';
              document.body.appendChild(a);
              a.click();
              setTimeout(() => { try { a.remove(); } catch (_) {} }, 3000);
              return { ok: true, method: 'tab' };
            } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
          },
          args: [msg.url, msg.filename || ''],
        });
        sendResponse((r && r.result) || { ok: false, error: 'no-result' });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }
  // ★2026-09-10：由 SW 代侧栏触发 chrome.downloads（用于后端 ffmpeg 拉流产物落盘）。
  //   为什么必须走 SW：侧栏是 chrome-extension 页面，直接用 fetch 拉几百 MB 产物会把
  //   整个文件读进扩展内存，且在跨域流式响应下可能长期 pending —— 实测既不成功也不报错，
  //   chrome.downloads.search 里完全没有条目。改由 SW 调 chrome.downloads：
  //   浏览器原生流式写盘、不占扩展内存、有真实进度、侧栏关闭也不影响。
  if (msg && msg.type === 'HMDAO_DOWNLOAD_LOCAL_FILE') {
    (async () => {
      try {
        const url = String(msg.url || '').trim();
        const filename = String(msg.filename || '').trim();
        if (!/^https?:/i.test(url) || !filename) {
          sendResponse({ ok: false, error: '参数不完整（url / filename）' });
          return;
        }
        // ★2026-09-10：绝不能 await 它。实测对【跨域大文件】（后端 1.5GB 拉流产物）
        //   chrome.downloads.download 的 Promise 会长期挂起而不 resolve —— 于是
        //   sendResponse 永远不执行 → 侧栏 await 永久等待 → 表现为"进度卡住、
        //   下载管理器里却一个条目都没有"。
        //   改为：发起下载后【立即】响应，下载本身交给浏览器在后台流式接管
        //   （chrome.downloads.onChanged 会照常驱动侧栏进度卡）。
        chrome.downloads.download({
          url,
          filename,
          saveAs: false,
          conflictAction: 'uniquify',
        }).then((downloadId) => {
          console.log('[Ddayup] 下载已触发 id=', downloadId, '→', filename);
        }).catch((e) => {
          console.warn('[Ddayup] 下载触发失败:', e && e.message);
        });
        sendResponse({ ok: true, started: true });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }
  // ★2026-08-31 新增（B站 durl「下载到本地」根因闭环）：
  //   HMDAO_DOWNLOAD_IN_TAB 对 B站 durl 无效：fetch→blob 因 bilivideo 无 CORS 头失败（method=blob 失败），
  //   兜底 <a target=_blank> 打开 mp4 直链 → Chrome 内嵌播放（无 Content-Disposition）→ 「弹出新界面、没下载到本地」。
  //   唯一能「强制下载到本地且绝不导航源页」的是 chrome.downloads.download；但它发请求 Referer=chrome-extension
  //   → bilivideo CDN 403。故下载前用 dNR 临时注入 Referer=https://www.bilibili.com（600s 自动清理），
  //   chrome.downloads 直连 durl 即被 CDN 放行 → 真实完整 mp4 落盘，源视频页完全不受影响。
  if (msg && msg.type === 'HMDAO_DOWNLOAD_BILI_DURL') {
    (async () => {
      try {
        const durl = msg.url;
        const filename = msg.filename || 'video.mp4';
        // 临时注入 bilivideo Referer+Origin（下载期间有效，600s 后自动清理）
        try {
          if (typeof installRefererRuleForDomain === 'function') {
            await installRefererRuleForDomain('bilivideo.com', BILI_REFERER, BILI_ORIGIN, ['other', 'media']);
          }
        } catch (_) {}
        const dlId = await new Promise((resolve, reject) => {
          chrome.downloads.download({
            url: durl,
            filename,
            saveAs: false,
            conflictAction: 'uniquify',
          }, (id) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message || 'download-failed'));
            else resolve(id);
          });
        });
        sendResponse({ ok: true, id: dlId });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }
  // ★2026-09-01 补：只安装抖音 Referer 规则（不发起下载）。
  //   供 download.js 先装规则、再由侧栏 dlViaChrome 直接下载——
  //   chrome.downloads.download 由侧栏发起时，dlViaChrome 会 registerTask + bindDownloadId，
  //   侧栏任务卡即与该下载关联，chrome.downloads.onChanged 可【实时同步进度/完成/中断】。
  //   （上一版由 background 代下载，绕过了进度注册 → 用户看不到下载进度。）
  if (msg && msg.type === 'HMDAO_INSTALL_DY_REFERER') {
    (async () => {
      try {
        const ref = msg.referer || 'https://www.douyin.com/';
        let ok = false;
        try {
          if (typeof installRefererRuleForDomain === 'function') {
            // 只装 'other'：chrome.downloads 的请求类型即 'other'；
            // 绝不加 'media'，否则会覆盖播放器防盗链签名导致「有声无画」。
            await installRefererRuleForDomain('douyinvod.com', ref, 'https://www.douyin.com', ['other']);
            ok = true;
          }
        } catch (_) {}
        sendResponse({ ok });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }
  // ★2026-09-01 新增（抖音「点下载弹出新链接、没下载到本地」根因闭环）：
  //   HMDAO_DOWNLOAD_IN_TAB 对抖音 CDN 无效——CDN 是 douyinvod.com、源页是 douyin.com，
  //   【不同源】；而 HTML <a download> 属性仅对同源 URL 生效，跨域时被浏览器直接忽略
  //   → 退化成 <a target=_blank> 打开 mp4 → Chrome 内嵌播放（CDN 未返回
  //   Content-Disposition:attachment）→ 用户看到「弹出新标签在播，本地什么都没下到」。
  //   与 B站 durl 同一解法：dNR 临时注入 Referer=douyin.com（600s 自动清理），
  //   chrome.downloads.download 直连 CDN 即被放行 → 真实 mp4 落盘，源页不受影响。
  //   ★资源类型只传 ['other']：chrome.downloads.download 的请求类型就是 'other'；
  //     绝不加 'media'——页面 <video> 原生流正是 'media'，注入 Referer 会覆盖播放器
  //     精确计算的防盗链签名（a_bogus/x-bogus）→ CDN 返回错误流 → 「有声无画」。
  if (msg && msg.type === 'HMDAO_DOWNLOAD_DY_URL') {
    (async () => {
      try {
        const durl = msg.url;
        const filename = msg.filename || 'video.mp4';
        const ref = msg.referer || 'https://www.douyin.com/';
        try {
          if (typeof installRefererRuleForDomain === 'function') {
            await installRefererRuleForDomain('douyinvod.com', ref, 'https://www.douyin.com', ['other']);
          }
        } catch (_) {}
        const dlId = await new Promise((resolve, reject) => {
          chrome.downloads.download({
            url: durl,
            filename,
            saveAs: false,
            conflictAction: 'uniquify',
          }, (id) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message || 'download-failed'));
            else resolve(id);
          });
        });
        sendResponse({ ok: true, id: dlId });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }
  // ★2026-09-02 新增（抖音下载最终方案）：在源页 douyin.com 上下文 fetch playApi → blob → <a download>。
  //   为什么放弃 chrome.downloads + dNR：
  //     · chrome.downloads 无法经 headers 传 Referer（禁止头，实测抛 Unsafe request header name）；
  //     · dNR（rules.js 的 installRefererRuleForDomain，用 updateSessionRules）确实注入了 session 规则，
  //       但 douyinvod 仍返回 403（SERVER_FORBIDDEN）——该 CDN 校验不止 Referer，还绑定 biz_sign 会话/IP。
  //   源页 fetch 方案为什么稳：playApi 形如 https://www.douyin.com/aweme/v1/play/?...&biz_sign=...，
  //   对源页【同源】。源页 MAIN 世界 fetch 时浏览器自动附带源页会话 Cookie 与合法 Referer，
  //   既无 CORS 限制，也无禁止头问题，更不依赖 dNR。与 B站已验证的 downloadBiliDurlViaPageFetch
  //   同一模式（B站那处是跨域，此处同源，应更稳）。
  if (msg && msg.type === 'HMDAO_DY_FETCH_PLAY') {
    (async () => {
      try {
        const tabId = msg.tabId || (await pickSourceTabForUrl('https://www.douyin.com/'));
        if (!tabId) { sendResponse({ ok: false, error: 'no-douyin-tab' }); return; }
        const [r] = await chrome.scripting.executeScript({
          target: { tabId }, world: 'MAIN',
// ★2026-09-02 修正：这里【不能用 fetch】。
          //   playApi 会 302 重定向到 douyinvod.com（跨域），fetch 跟随重定向后触发 CORS
          //   → "Failed to fetch"（用户日志已证实）。
          //   正确做法：playApi 属 www.douyin.com，与源页【同源】，HTML download 属性对同源
          //   URL 完全生效。用原生 <a download> 让浏览器自己发请求——自动带会话 Cookie 与
          //   Referer=douyin.com，并自行跟随 302 到 CDN 取真实字节，全程不经 fetch /
          //   不触发 CORS / 不依赖 dNR / 不依赖 chrome.downloads。
          //   （对比：此前对 douyinvod 直链用 <a download> 失败，正因为它是跨域。）
          func: (u, fname) => {
            try {
              const a = document.createElement('a');
              a.href = u;
              a.download = fname || 'douyin_video.mp4';
              a.rel = 'noopener';
              document.body.appendChild(a);
              a.click();
              setTimeout(() => { try { a.remove(); } catch (_) {} }, 5000);
              let host = '';
              try { host = new URL(u).hostname; } catch (_) {}
              return { ok: true, method: 'anchor-download', urlHost: host };
            } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
          },
          args: [msg.url, msg.filename],
        });
        sendResponse((r && r.result) || { ok: false, error: 'no-result' });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }
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
  // 侧栏预览优酷 m3u8：按需给 pl-ali.youku.com 等 CDN 域注入 Referer=https://v.youku.com/
  // （hls.js 浏览器内拉 .m3u8/.ts 时不带防盗链 Referer 会 403；唯一注入手段是 dNR）
  if (msg && msg.type === HMDAO_MSG.INSTALL_YOUKU_REFERER) {
    Promise.resolve(installYoukuRefererRules()).then(() => sendResponse({ ok: true }));
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
                if (!/^(audio|video)\//.test(mime)) {
                  const ext = (url.split('?')[0].match(/\.([a-z0-9]+)$/i) || [])[1] || '';
                  // ★mp4：豆包技能音乐是 .mp4 容器装 AAC 音频（<audio> 播放），须映射为 audio/mp4 否则 <audio> 拒绝解码
      const map = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/ogg', weba: 'audio/webm', mp4: 'audio/mp4' };
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
        // ★2026-09-10 硬边界（用户要求：侧栏绝不能影响源页正常播放）：
        //   本分支会做两件【侵入源页】的事——
        //     ① 在源页 MAIN 世界执行 extractFreshVideoUrl；
        //     ② 按解析结果调 installRefererRuleForDomain 装 dNR Referer 规则。
        //   而 installRefererRuleForDomain 与 installAudioCorsRule 不同——它【没有
        //   initiatorDomains 限制】，会连带改写【源页自己】发往同域的请求头。
        //   对 MSN 这类【未接入 inject-main 的站点】(video.js + 签名 URL)：
        //     · extractFreshVideoUrl 解析不出任何直链（页面无 __playinfo__/RENDER_DATA）；
        //     · 却会往 msn 域强加错误 Referer → 播放器签名校验失败 → 源页视频不能播放，
        //       且 session 规则存活 600 秒（用户会以为"页面坏了"）。
        //   故：仅【已支持平台】才允许回源页解析；其余站点直接放弃，源页零干预。
        try {
          const __t = await chrome.tabs.get(tabId);
          const __u = (__t && __t.url) || '';
          let __host = '';
          try { __host = new URL(__u).hostname.toLowerCase(); } catch (_) { __host = ''; }
          if (__host) {
            const SUPPORTED = /(^|\.)(bilibili\.com|b23\.tv|youtube\.com|youtu\.be|douyin\.com|iesdouyin\.com|tiktok\.com|xinpianchang\.com)$/i;
            if (!SUPPORTED.test(__host)) {
              console.log('[HMDAO][scan] REFRESH_FROM_PAGE 跳过非支持平台（避免干扰源页播放）：', __host);
              sendResponse({ ok: false, error: 'unsupported-site' });
              return;
            }
          }
        } catch (_) {}
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
            // ★B站播放页熔断：刷新出的若是 B站视频 CDN 且当前页是 B站播放页，完全不装 Referer 规则，
            // 让 B站原生播放器保持静默无干扰（与「无扩展」行为一致）。
            const isBili = host.includes('bilivideo.com') || host.includes('bilivideo.cn') || host.includes('hdslb.com');
            const senderTab = (sender && sender.tab && sender.tab.url) || (sender && sender.tab && sender.tab.pendingUrl) || '';
            const senderIsBiliPlay = /bilibili\.com\/(video|blackboard\/.*play|festival)\//.test(senderTab);
            if (isBili && senderIsBiliPlay) {
              // 跳过：B站播放页不注入任何规则，避免干扰原生播放器。
            } else {
              let referer;
              if (host.includes('tiktok')) referer = 'https://www.tiktok.com/';
              else if (host.includes('douyin') || host.includes('bytedance')) referer = 'https://www.douyin.com/';
              else if (host.includes('weixin') || host.includes('qq.com')) referer = 'https://' + host + '/';
              else { const dom = registeredDomain(host); if (dom) referer = 'https://' + (host.startsWith('www.') ? host : 'www.' + dom) + '/'; }
              if (referer) {
                // B站域名（非播放页场景，如侧栏预览）刻意只匹配 ['other']，避免覆盖页面 <video> 原生媒体流。
                await installRefererRuleForDomain(registeredDomain(host) || host, referer, undefined, isBili ? ['other'] : undefined);
              }
            }
          } catch (_) {}
        }
        // ★2026-08-23 修复（实测：点卡片不播放根因）：
        //   extractFreshVideoUrl 抖音分支返回的是【对象】{__douyin:true, url:'真实直链', awemeId,...}
        //   或 {__douyinMulti:true, items:[...]}。旧代码 sendResponse({ok:!!r, url:r}) 把整个对象塞进 url 字段，
        //   → 侧栏 r.url 是对象而非字符串 → line 2885 的 typeof r.url==='string' 判断永 false → a.url 不更新
        //   → fallbackCdnRefetch 用历史空 url → 不播放。
        //   修复：从返回对象中提取真实字符串直链作为 url 返回；多视频分支返回首个 item 的 url + awemeId。
        let outUrl = '';
        let outAwemeId = '';
        if (r) {
          if (typeof r === 'string') outUrl = r;
          else if (r.url && typeof r.url === 'string') outUrl = r.url;
          else if (r.__douyinMulti && Array.isArray(r.items) && r.items[0] && r.items[0].url) outUrl = r.items[0].url;
          if (r.awemeId) outAwemeId = r.awemeId;
          else if (r.__douyinMulti && r.items && r.items[0] && r.items[0].awemeId) outAwemeId = r.items[0].awemeId;
        }
        sendResponse({ ok: !!outUrl, url: outUrl, awemeId: outAwemeId, __isDouyin: !!(r && (r.__douyin || r.__douyinMulti)) });
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
    })();
    return true;
  }
  // ★2026-08-22 信息流批量采集：独立通道（不与 REFRESH_FROM_PAGE 串扰）。
  // 处理前注入 window.__hmdao_batchMode=true 驱动源页 tryDouyinWeixin 走 aweme_list 多视频分支，
  // 处理完清除信号恢复单视频默认行为。返回 { ok, count, items, expired } 供侧栏追加资产。
  if (msg && msg.type === HMDAO_MSG.BATCH_COLLECT) {
    (async () => {
      try {
        let tabId;
        const picked = await pickSourceTabForUrl(msg.assetUrl);
        if (picked && picked.id) tabId = picked.id;
        if (!tabId) { const tabs = await chrome.tabs.query({ active: true, currentWindow: true }); tabId = tabs[0] && tabs[0].id; }
        if (!tabId) { sendResponse({ ok: false, error: 'no-source-tab' }); return; }
        // 注入批量模式信号（驱动多视频分支）
        await chrome.scripting.executeScript({ target: { tabId, allFrames: false }, world: 'MAIN', func: () => { window.__hmdao_batchMode = true; } });
        await new Promise((r) => setTimeout(r, 1200)); // 等 RENDER_DATA 就绪
        const results = await chrome.scripting.executeScript({
          target: { tabId, allFrames: false }, world: 'MAIN',
          func: extractFreshVideoUrl, args: ['', NETWORK_ASSETS[tabId] || []],
        });
        const r = (results && results[0] && results[0].result) || null;
        // 清除批量信号，恢复单视频默认行为
        await chrome.scripting.executeScript({ target: { tabId, allFrames: false }, world: 'MAIN', func: () => { window.__hmdao_batchMode = false; } });
        // 兼容抖音 __douyinMulti / B站 __biliMulti（后续 YouTube/TikTok 同理）
        const items = (r && (r.__douyinMulti || r.__biliMulti) && Array.isArray(r.items)) ? r.items : [];
        // 自定义模式：按勾选 awemeIds 过滤（其余模式输出全部）
        // ★防御：custom 模式即使 awemeIds 为空数组也按空集过滤（0 条），绝不误回退全量。
        let filtered = items;
        if (msg.mode === 'custom') {
          const want = new Set(Array.isArray(msg.awemeIds) ? msg.awemeIds : []);
          filtered = items.filter((it) => it && (want.has(it.awemeId) || want.has(it.url)));
        }
        // 将每条 item 转为侧栏资产格式。按来源区分：
        //  - 抖音/视频号（source:'douyin-batch'）：url 是 play_addr 直链，用字符串特征弱判 expired（下载时 fetch 失败会再提示）。
        //  - B站（source:'bilibili-batch'）：url 是视频页 URL（非直链），直链需播放激活 → 强制标 __batchExpired=true 提示「需播放」。
        //    同时标 __biliMulti（而非 __douyinMulti），保证平台语义正确，避免下游误判下载逻辑。
        const assetsOut = [];
        let expired = 0;
        for (const it of filtered) {
          if (!it || !it.url) { expired++; continue; }
          const isBili = it.source === 'bilibili-batch';
          let isExpired;
          if (isBili) {
            isExpired = true; // B站批量 url 是页面 URL，真实直链需播放激活
          } else {
            isExpired = /(403|expired|expire|signature)/i.test(it.url) || it.url.length < 20;
          }
          if (isExpired) expired++;
          assetsOut.push({
            url: it.url,
            type: 'video',
            source: it.source || 'douyin-batch',
            title: it.title || '',
            cover: it.cover || '',
            awemeId: it.awemeId || '',
            // ★2026-09-11：B站批量卡补全 biliPageUrl/biliVideoId/page/episodeNo，
            //   供 download.js 走 yt-dlp 按页解析、card-render 高亮、以及 /null 防御统一使用。
            biliPageUrl: (isBili && it.url) ? it.url : '',
            biliVideoId: (isBili && it.bvid) ? it.bvid : '',
            page: it.page || 0,
            episodeNo: it.episodeNo || 0,
            collectionId: it.collectionId || '', // ★范围隔离：侧栏据此判定是否同一合集
            __douyinMulti: !isBili,
            __biliMulti: isBili,
            __batchExpired: isExpired,
          });
        }
        sendResponse({ ok: true, count: assetsOut.length, expired, items: assetsOut });
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

  // ★P2（2026-08-01，修订 2026-08-01 v2）：爱给等音效站 —— 悬停预览时若 a.url 为空，
  // 后台只【读回】源页已捕获的 audioPlays（含签名直链）回填 a.url 再播。
  // 注意：不再主动点击试听按钮（v1 的 forceAudioPlayCapture 会干扰浏览，已撤回）。
  // 用户手动点过试听后 audioPlays 已有数据，悬停时直接读回即可。
  if (msg.type === 'HMDAO_CAPTURE_AUDIO_NOW') {
    (async () => {
      try {
        const tabId = msg.tabId;
        if (!tabId) { sendResponse({ ok: false, error: 'no tabId' }); return; }
        // 读回 MAIN 世界的 audioPlays 捕获（每条为 { url, path, how, ts }，path = origin+pathname）
        const res = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: () => {
            const cap = (window.__hmdao_captures && window.__hmdao_captures.audioPlays) || [];
            return cap.map((c) => ({ url: c.url, path: c.path, how: c.how, ts: c.ts }));
          },
        });
        const plays = (res && res[0] && res[0].result) || [];
        sendResponse({ ok: true, audioPlays: plays });
      } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
    })();
    return true;
  }

  // ★零副作用「试听后自动刷新」（2026-08-01）：scanPage 监听到 AUDIO_CAPTURED 后转发此消息，
  // 后台去抖触发一次 scanTab，把新捕获的音频刷新进侧栏。纯被动，不主动点击/播放。
  if (msg.type === 'HMDAO_PAGE_MUTATION') {
    try {
      const tabId = msg.tabId || (sender && sender.tab && sender.tab.id);
      if (tabId) scheduleRescan(tabId);
    } catch (_) {}
    return false; // 不需要 sendResponse
  }

});

// 注：B站/YouTube 拦截器已移至 inject-main.js（content_scripts, world=MAIN, document_start）常驻注入，
// 并置 window.__hmdao_installed=true。此处不再保留重复的按需注入版本（ensurePlatformInterceptors）。

// 在源页 DOM 中提取最近/匹配的 fresh video URL（page context 内运行，能读出 blob 实时 src）
// 注：B站 WBI 签名与 playurl 自调逻辑已内联在 extractFreshVideoUrl 内部（executeScript 只序列化函数体，
// 外部定义的 wbiSign/biliWbiCall 无法进入页面作用域，故不在此重复定义）。
async function extractFreshVideoUrl(hintUrl, networkAssets) {
  const REFERER = 'https://www.bilibili.com';
  // ★2026-08-22 信息流批量采集：batchMode 提升为函数级，所有平台分支（抖音/视频号/B站/YouTube）共享。
  // 侧栏「批量采集」开启时由 background 注入 window.__hmdao_batchMode=true，此处读取，
  // 各平台 try* 分支据此跳过「播放流早返回」，强制走页面 RENDER_DATA/__INITIAL_STATE__/ytInitialData
  // 的多视频列表路径（实现「当前页所有视频」）。单视频模式（默认）完全不受影响。
  const batchMode = window.__hmdao_batchMode === true;

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
      // ★2026-08-22 信息流批量采集（B站）：批量模式下从 __INITIAL_STATE__ 读合集/列表多视频。
      //   合集页 ugcSeason.sections[].episodes[] 含每个视频的 aid/bvid/cover/title（源页真实数据，保证一致性）。
      //   playurl（真实下载直链）延迟到用户播放该集时由 inject-main 捕获 / 单条 REFRESH 激活（避免批量拉流风控）。
      if (batchMode) {
        try {
          // ★2026-09-11 重写（修复「多卡重复播第一集 / 标题相同 / 点哪张都进第一集」）：
          //   根因：① B站「分P」(同一 BV 多 page) 不会出现在 ugcSeason 里，必须单独读 videoData.pages[]；
          //         ② 合集 episodes 的 ep.page 是【对象 {cid,page,part}】(非数字)，旧代码 page>1 恒 false → 永远不拼 ?p=；
          //         ③ WBI 单视频取直链旧逻辑写死 pages[0].cid → 无视 ?p= 永远播第1集。
          //   现统一：每张分集归一化为 (bvid + ?p=N) 一张独立卡，标题用分P的 part 或合集的 episode 标题，
          //   去重键含 bvid+page。带 hintUrl(点某集播放/下载)时不早返回，继续走下方 WBI 精确取该集直链。
          const vd = s0.videoData || {};
          const curBvid = vd.bvid || '';
          // ★2026-09-11 范围隔离（用户要求：批量采集只扫当前源页的合集，绝不混入其他平台/其他合集）：
          //   collectionId 标识「当前合集」——有 ugcSeason 用其 season_id（跨多个 BV 也属同一合集）；
          //   否则用主视频 bvid（分P 系列 / 单视频各自成「合集」）。侧栏在 BATCH_COLLECT 时按它比对，
          //   不同合集先清空旧卡，保证侧栏只显示当前源页合集。
          const __season = s0.ugcSeason || vd.ugc_season || null;
          const __seasonId = (__season && (__season.id || __season.season_id)) ? ('bili-season:' + (__season.id || __season.season_id)) : '';
          const collId = __seasonId || ('bili-video:' + (curBvid || (s0.aid || '')));
          const items = [];
          const seen = new Set();
          const pushItem = (bvid, pageNum, title, cover) => {
            const bv = (bvid && String(bvid)) || curBvid;
            const pg = Number(pageNum) || 1;
            if (!bv || pg < 1) return; // ★防御：bvid/page 任一无效直接丢弃，绝不产生 /null 之类的非法 URL
            const dk = bv + '#p' + pg;
            if (seen.has(dk)) return;
            seen.add(dk);
            items.push({
              url: 'https://www.bilibili.com/video/' + bv + (pg > 1 ? ('?p=' + pg) : ''),
              title: (title && String(title).trim()) ? String(title).trim() : ('第' + pg + '集'),
              cover: cover || vd.pic || '',
              awemeId: bv, // 复用 awemeId 字段承载 B站 id（scan.js byKey 统一用 <platform>:<id> 映射）
              bvid: bv,
              page: pg,
              episodeNo: pg,
              source: 'bilibili-batch',
              collectionId: collId, // ★范围隔离标记：侧栏据此判定「是否同一合集」
            });
          };
          const normPage = (p) => (p && typeof p === 'object' && typeof p.page === 'number') ? p.page : (Number(p) || 0);
          const normPart = (p) => (p && typeof p === 'object' && p.part) ? p.part : '';
          // ② 当前视频的分P（同一 BV 多 page，B站用 ?p=N 区分）—— 必须早于合集处理，使分P标题(part)胜出
          if (Array.isArray(vd.pages) && vd.pages.length >= 2) {
            vd.pages.forEach((p) => { pushItem(curBvid, p.page, p.part, vd.pic); });
          }
          // ① 合集/系列：ugcSeason.sections[].episodes[]（每集通常是独立 BV；也可能同 BV 不同 page）
          const season = s0.ugcSeason || (vd.ugc_season);
          if (season && Array.isArray(season.sections)) {
            season.sections.forEach((sec) => {
              if (!sec || !Array.isArray(sec.episodes)) return;
              sec.episodes.forEach((ep) => {
                const bvid = ep.bvid || (ep.arc && ep.arc.bvid) || '';
                const pg = normPage(ep.page) || normPage(ep.arc && ep.arc.page) || 1;
                const title = ep.title || normPart(ep.page) || (ep.arc && ep.arc.title) || '';
                const cover = (ep.arc && ep.arc.pic) || vd.pic || '';
                pushItem(bvid, pg, title, cover);
              });
            });
          }
          // ③ 兜底【已移除】—— 原逻辑把单视频页底部「相关视频」(relatedVideos) 也当「当前页所有视频」塞进批量卡，
          //   但相关视频是【其他视频/其他合集/可能其他平台】的推荐，会污染当前源页合集（用户实测「混入其他合集内容」根因）。
          //   批量采集的边界必须是「当前源页的合集」(videoData.pages 分P + ugcSeason.sections 合集)，绝不外溢。
          //   故此处不再读取 relatedVideos；单视频(无分P 无合集)由下方 WBI 取直链走单卡，符合「当前播放一个视频」。
          if (items.length >= 2) {
            items.forEach((it, k) => { it.__biliMulti = true; it.__index = k; });
            // ★仅「扫描合集」(hintUrl 为空)时整批返回；若传入具体 hintUrl(点某集播放/下载)，
            //   不早返回，继续往下走 WBI 单集取直链（否则会误把整批 items 当直链 → 播放失败/404）。
            if (!hintUrl) return { __biliMulti: true, items };
          }
        } catch (_) {}
      }
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
        // ★2026-09-11 修复：必须按 hintUrl 的 ?p=N 选出【对应分P】的 cid，否则永远用 pages[0].cid → 点哪张都播第1集。
        const __bvMatch = String(hintUrl || location.href).match(/BV(\w+)/);
        const __wantBvid = __bvMatch ? ('BV' + __bvMatch[1]) : '';
        let __wantPage = 0;
        try { __wantPage = Number(new URL(String(hintUrl || location.href), 'https://www.bilibili.com').searchParams.get('p')) || 0; } catch (_) {}
        let aid, cid;
        if (s0.videoData && s0.videoData.aid) {
          aid = s0.videoData.aid;
          const pages = (s0.videoData.pages && s0.videoData.pages.length) ? s0.videoData.pages : [{ cid: s0.videoData.cid }];
          // hintUrl 指向当前页某分P → 选对应 cid；否则默认第1集
          const target = (__wantPage && pages[__wantPage - 1]) ? pages[__wantPage - 1] : pages[0];
          cid = target.cid;
        }
        // hintUrl 指向【合集里另一个视频】(bvid 与当前页 videoData.bvid 不同) → 经 view API 拉其 cid
        if ((!aid || !cid || (__wantBvid && s0.videoData && s0.videoData.bvid && __wantBvid !== s0.videoData.bvid)) && __wantBvid) {
          try {
            const v = await biliWbiCall('/x/web-interface/view', { bvid: __wantBvid }, wbi0);
            if (v && v.code === 0 && v.data) {
              aid = v.data.aid;
              const ps = (v.data.pages && v.data.pages.length) ? v.data.pages : [{ cid: v.data.cid }];
              const tt = (__wantPage && ps[__wantPage - 1]) ? ps[__wantPage - 1] : ps[0];
              cid = tt.cid;
            }
          } catch (_) {}
        }
        if (aid && cid) {
          try {
            // fnval=1 请求「整段 MP4」（音画合一）。qn=80 + fourk:1 + credentials:include：
            //   - 登录 1080P → data.quality=80（1080P 高清，匹配当前链接可播放的最高清）
            //   - 大会员 4K → data.quality=120（4K 超清，API 自动升档）
            //   - 未登录 720P → data.quality=64（720P 高清，API 自动降级）
            // B站 playurl API 自动匹配 qn 到用户能看的最高清晰度，无需手动 try/catch。
            // 用户明确要求（"右键默认下载当前链接支持的最高质量，不是 4K"）：qn=80 是登录 1080P 用户的稳态选择。
            // 上轮 qn=120 在非大会员登录 1080P 用户下 B站 API 可能直接 code=-101 鉴权失败（非"自动降级"），
            // 导致 WBI refresh 拿不到 durl → refreshThenDownload 失败 → 用户看到 FILE_FAILED。
            // qn=80 + fourk:1：所有场景都能拿到对应最高清晰度（API 自动升降级）。
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
  // ★2026-08-22 批量模式下跳过 YouTube 单视频早返回（为后续 ytInitialData playlist 多视频分支让路）
  {
    const ytR = (!batchMode) ? await tryYouTube() : null;
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
      // ★2026-08-22 批量模式由侧栏开关注入 window.__hmdao_batchMode=true（见 2153 行函数级 batchMode）。
      //   批量模式下跳过「播放流早返回」，强制走 RENDER_DATA aweme_list 全量多视频分支，
      //   实现「当前页所有视频」采集；单视频模式（默认）完全不受影响。
      // 0) ★ 当前播放直链（inject-main 捕获的 douyinvod CDN，URL 有效可播放）。
      //    抖音 jingxuan / 视频详情页的真实元数据（awemeId/封面/标题）在 RENDER_DATA.app.videoDetail，
      //    旧逻辑直接 return 裸 URL 会丢失 awemeId/cover → scan.js 回退“电子营业执照”。
      //    这里只记下「最新一条=当前播放」的直链，供下方 videoDetail 分支组合成完整 meta；
      //    批量模式（合集多视频）则保留原 aweme_list 逻辑，不走这条单视频快路径。
      // ★2026-08-22 根因修复（视频卡内容与封面错配核心）：jingxuan 页面 dyUrls 数组会累积同一 tab 历史上
      // 抓到的所有 CDN 流（来自信息流 prefetch、合集上下集、跨集切换、recommend 预加载等）。
      // 此前直接取「末尾最新一条」→ 当用户从信息流/搜索结果点进 modal 时，dyUrls 末尾往往是上一条
      // prefetch 流的 URL，与当前 modal 正在播放的视频完全不同 → 侧栏封面是 modal 视频、内容是上一条
      //   (出现「预览图毒液但播放挥春」的根因)。
      // ★正确策略：用 modal_id (URL 参数) 或 RENDER_DATA videoDetail.awemeId 作权威 anchor，从 dyAwemes[]
      // 里筛出属于当前 aweme 的 dyUrls 下标集合，再取该集合的最新一条。inject-main 已经把同一 modal
      // 期间的所有 dyUrls 都标 dyAwemes[i] = modal_id，所以这条过滤天然能命中「当前播放」。
      let targetAwemeId = '';
      try {
        const u = new URL(location.href);
        targetAwemeId = u.searchParams.get('modal_id') || u.searchParams.get('aweme_id') || '';
      } catch (_) {}
      try {
        const vd0 = data && data.app && data.app.videoDetail;
        if (vd0 && vd0.awemeId) targetAwemeId = String(vd0.awemeId);
      } catch (_) {}
      // 选 audio-only fallback：若无 awemeId anchor，则跳过 dyUrls 兜底，避免错配
      const haveAnchor = !!targetAwemeId;
      // ★2026-08-23 终极 anchor：页面 <video> 元素的 currentSrc（inject-main 已实时跟踪到
      //   window.__hmdao_captures.curVideoSrc）。这是「源页当前真正在播放」的 URL，权威度高于
      //   modal_id / RENDER_DATA videoDetail.awemeId —— 后两者在 jingxuan SPA 切集场景下经常不一致
      //   （例如 modal_id 锚定合集里某一集，而 videoDetail 是「详情页」默认锁定的另一个视频）。
      let curVideoSrc = '';
      try { curVideoSrc = (window.__hmdao_captures && window.__hmdao_captures.curVideoSrc) || ''; } catch (_) {}
      let dyUrlsTail = '';
      if (isDy && !batchMode && haveAnchor) {
        const dyUrls = (window.__hmdao_captures && window.__hmdao_captures.dyUrls) || [];
        const dyAwemes = (window.__hmdao_captures && window.__hmdao_captures.dyAwemes) || [];
        // ★最高优先级：curVideoSrc 精确匹配 <video> 当前在播的流（剥离 query 后比较，签名差异不影响）
        if (curVideoSrc) {
          let csPath = '';
          try { csPath = new URL(curVideoSrc).origin + new URL(curVideoSrc).pathname; } catch (_) {}
          for (let i = dyUrls.length - 1; i >= 0; i--) {
            const u = dyUrls[i];
            if (!u) continue;
            let uPath = '';
            try { uPath = new URL(u).origin + new URL(u).pathname; } catch (_) {}
            if (uPath && csPath && uPath === csPath) { dyUrlsTail = u; break; }
          }
        }
        // 次优先：按 anchor 过滤（兼容 curVideoSrc 还没抓到的早期场景）
        if (!dyUrlsTail) {
          // ★过滤：仅保留属于当前 modal 的 dyUrls 下标，去除历史 prefetch 噪音。
          const idxs = [];
          for (let i = 0; i < dyUrls.length; i++) {
            if (String(dyAwemes[i] || '') === String(targetAwemeId)) idxs.push(i);
          }
          // 兜底：若 dyAwemes 全空（旧版本 inject-main / 还没来得及标），按「路径去重 + 路径含 video mime」退化
          let useIdxs = idxs;
          if (!useIdxs.length) {
            for (let i = dyUrls.length - 1; i >= 0; i--) {
              if (!/\.mp3(\?|$)/i.test(dyUrls[i])) { useIdxs = [i]; break; }
            }
          }
          if (useIdxs.length) dyUrlsTail = dyUrls[useIdxs[useIdxs.length - 1]];
        }
      }
      // 0a-2) ★2026-09-02：抖音「含音画源」优先于网络层裸轨（根治"有画面没声音 / 有声音没画面"）。
      //   抖音是 DASH 分离轨：网络层(webRequest)捕获到的单条 douyinvod 要么是纯视频轨、要么是纯音频轨，
      //   而 0b 分支一旦命中【立即 return】，于是视频卡必然缺一侧——
      //     实测演进：过滤不认 mime_type=audio_mp4 时选中音频轨 → "有声音没画面"；
      //               滤掉音频轨后选中视频轨 → "有画面没声音"，音频轨则被单列为"音效文件"资产。
      //   而 SSR/详情数据里的 playApi（标签"下载源(含音画)"）是官方【单文件含音画】源，
      //   可直接播放与下载，不必再做 DASH 合并。故在此优先取用，让 0b 无机可乘。
      if (isDy && !batchMode) {
        try {
          const caps0 = window.__hmdao_captures || {};
          const fmMap = caps0.dyFormatsByAweme || {};
          // ★2026-09-02 回归修复：直接读 URL 的 modal_id / aweme_id，不再依赖 targetAwemeId。
          //   targetAwemeId 在本函数 3413 行被 data.app.videoDetail.awemeId 覆盖，jingxuan 切集场景
          //   下 videoDetail 滞后（见 background.js:3741 注释：modal_id 锚定第91集，videoDetail 是
          //   另一个详情页主视频），导致 aid0 变成下一集的 ID → fmMap 命中下一集的档位 → 0a-2 返
          //   回下一集的 playApi → 侧栏视频卡点击播放的是合集下一集内容。URL 的 modal_id 是用户
          //   锚定当前 modal 的稳定来源，从这里直接读，避免被任何中间变量覆盖。
          let aid0 = '';
          try {
            const u0 = new URL(location.href);
            aid0 = u0.searchParams.get('modal_id') || u0.searchParams.get('aweme_id') || '';
          } catch (_) {}
          const fl0 = fmMap[aid0] || [];
          const mixed = fl0.find((f) => f && f.url && /含音画/.test(f.label || ''))
            || fl0.find((f) => f && f.url && f.is_default);
          if (mixed && mixed.url) return String(mixed.url);
        } catch (_) {}
      }
      // 0b) 次优先：网络层捕获的真实 CDN 直链（保证是「正在播放」的那条，避免 RENDER_DATA 兜底取错视频）
      // ★2026-08-22 批量模式下同样跳过，强制走 aweme_list 多视频分支。
      if (isDy && !batchMode) {
        // ★修复：抖音是 DASH 分离轨，网络层会同时捕获「视频轨 CDN」(douyinvod) 与「音频轨/原声 CDN」
        // (sf*-cdn-tos.douyinstatic.com/obj/ies-music/*.mp3)。正则 /douyin/ 会命中静态 CDN 的音频流，
        // 若不排除会因「type==='audio'」被误当视频资产 → 预览/下载选到纯音频 → "有声音没画面"。
        // 过滤：仅收视频资产（type==='video'），且排除 ies-music 原声路径与 sf*-cdn-tos 的音频文件。
        // ★2026-08-22 再加 anchor 过滤：仅保留 inject-main 标为「当前 modal」的 dyUrls，避免历史 prefetch
        // 让网络层末尾命中上一条信息流视频。注入源为 window.__hmdao_captures.dyUrls 的过滤集合。
        const dyUrlsAll = (window.__hmdao_captures && window.__hmdao_captures.dyUrls) || [];
        const dyAwemesAll = (window.__hmdao_captures && window.__hmdao_captures.dyAwemes) || [];
        const anchorSet = new Set();
        if (haveAnchor) {
          for (let i = 0; i < dyUrlsAll.length; i++) {
            if (String(dyAwemesAll[i] || '') === String(targetAwemeId)) anchorSet.add(dyUrlsAll[i]);
          }
        }
        const dyNet = (networkAssets || []).filter((x) => {
          if (!x || !x.url) return false;
          if (x.type === 'audio' || x.type === 'image') return false; // 音频/图片资产不当视频
          const u = x.url.toLowerCase();
          if (/ies-music\/|\.mp3(\?|$)/.test(u)) return false; // 抖音原声/背景音乐，纯音频
          if (/sf[0-9]*-cdn-tos\.douyinstatic\.com\/obj\/ies-music/.test(u)) return false;
          if (!/(v26-web\.douyinvod|douyinvod|douyin|tiktok|bytedance)/i.test(x.url)) return false;
          // ★anchor 过滤：若 anchorSet 非空，仅保留注入的当前 modal 流；否则（无 anchor / 跨 SPA 切换期）放过
          if (anchorSet.size && !anchorSet.has(x.url)) return false;
          return true;
        });
        if (dyNet.length) {
          // ★2026-08-23 修复（实测：dyNet 抢先 return 会绕过 grab 分支的 RENDER_DATA 锚点 + 音频轨过滤，
          //   命中残留/音频轨直链 → 侧栏有声音没画面 / 内容对不上）。
          //   仅当候选是【视频轨】直链时才抢先返回；音频轨/原声(.mp3/ies-music/media-audio)直接 fall through
          //   到下方 grab 分支（用 RENDER_DATA + videoDetail.awemeId 锚点 + 视频轨过滤，精准对齐当前视频）。
          const okVid = dyNet.filter((x) => x && x.url && !/media-audio|ies-music|\.mp3(\?|$)/i.test(x.url));
          const pick = (okVid.length ? okVid : dyNet)[dyNet.length - 1];
          if (pick && pick.url && !/media-audio|ies-music|\.mp3(\?|$)/i.test(pick.url)) return pick.url;
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
          // ★2026-08-23 数据驱动修复（用户实测侧栏 0 卡片根因）：
          //   抖音 jingxuan 当前播放 video 节点常【只有 bitRateList，没有 play_addr/download_addr】
          //   （probe: play_addr_list_count=0, download_addr 空），旧 hasV 判定只看 play_addr/download_addr
          //   → chosen 节点的 video 不进 awemes → buildMeta 无 video 可处理 → return null → 0 卡片。
          //   放宽：video 有 play_addr OR download_addr OR bitRateList(数组) 都算有效 aweme，
          //   与 inject-main walkAw（line 333-336）保持一致，复现 STR_COUNT=42。
          const v0 = o.video;
          const hasBR = v0 && Array.isArray(v0.bitRateList) && v0.bitRateList.length;
          const hasV = v0 && (v0.play_addr || v0.download_addr || hasBR);
          const am = (o.awemeId != null) ? String(o.awemeId) : (o.aweme_id != null ? String(o.aweme_id) : '');
          if ((am || hasV)) awemes.push(o);
          for (const k in o) { try { walk(o[k]); } catch (_) {} }
        };
        try { walk(root); } catch (_) {}
        const byId = new Map();
        awemes.forEach((a) => { const id = (a.awemeId != null) ? String(a.awemeId) : (a.aweme_id != null ? String(a.aweme_id) : ''); if (id && !byId.has(id)) byId.set(id, a); });
        // ★2026-08-23 数据驱动修复（真实数据支撑）：
        //   实测：抖音 jingxuan 源页 URL 的 modal_id(7671906299432455467) 与 RENDER_DATA 实际视频
        //   awemeId(7671492318590979378=毒液) 经常不一致（SPA 切集/合集场景），导致 targetId 在 byId 里
        //   命中失败 → chosen 落到 awemes[0]（可能是无直链的推荐节点）→ buildMeta 返回 null →
        //   grab 分支 return null → 侧栏 a.url 空 → 回退 blob: 黑屏、且内容对不上。
        //   修复：锚点优先级 = RENDER_DATA.videoDetail.awemeId（与当前播放内容一致，已实测）> URL modal_id。
        let anchorAwemeId = '';
        try {
          const vd = data && data.app && data.app.videoDetail;
          if (vd && vd.awemeId) anchorAwemeId = String(vd.awemeId);
        } catch (_) {}
        const anchorKey = (anchorAwemeId || targetId || '');
        let chosen = (anchorKey && byId.get(String(anchorKey))) || null;
        const matched = !!chosen;
        if (!chosen) chosen = awemes[0] || null; // 无 anchor / 未命中时兜底
        // 收集 aweme → metadata helper
        const buildMeta = (a) => {
          if (!a || !a.video) return null;
          const v = a.video;
          // ★2026-08-23 数据驱动修复（真实数据支撑）：
          //   抖音 jingxuan modal 页：play_addr.url_list 经常为空（0），download_addr 也没了
          //   → 旧 list 取不到直链 → buildMeta 返回 null → 整个 chosen 无 url → 侧栏拿不到播放源、awemeId 不稳定。
          //   真实数据：RENDER_DATA 的 bitRateList[].playAddr.url_list 嵌套结构里【仍有 douyinvod 真实字符串直链】
          //   （用户探针测得 STR_COUNT=42、源页 fetch HTTP 206 video/mp4 = 字节可拉）。
          //   修复：list 优先 play_addr/download_addr，无则深递归 bitRateList[].playAddr 收集所有 url_list 字符串
          //   合并成可播放直链池，下游 list[0] 一定能拿到真实 CDN 链接。
          const collectAddr = (addr) => (addr && Array.isArray(addr.url_list)) ? addr.url_list.filter((u) => typeof u === 'string') : [];
          let list = collectAddr(v.download_addr).concat(collectAddr(v.play_addr));
          if (!list.length && Array.isArray(v.bitRateList)) {
            const brUrls = [];
            v.bitRateList.forEach((br) => {
              const pa = br && (br.playAddr || br.PlayUrl);
              // ★2026-08-23 修复（实测：侧栏拿到 media-audio-und-mp4a 纯音频轨直链 → 有声音没画面）
              //   抖音 bitRateList 同时含视频轨(gear_type=normal / URL 含 media-video)与音频轨
              //   (gear_type=audio / URL 含 media-audio)。跳过音频轨，否则 list[0] 命中音频轨 → 无画面。
              const paStr = (pa && typeof pa === 'object' && typeof pa.src === 'string') ? pa.src
                : (pa && typeof pa === 'object' && Array.isArray(pa.url_list) ? pa.url_list[0] : (typeof pa === 'string' ? pa : ''));
              const isAudio = (br && (br.gear_type === 'audio' || br.GearType === 'audio'))
                || /media-audio/i.test(paStr || (pa ? JSON.stringify(pa) : ''));
              if (isAudio) return;
              // playAddr 形态（与 inject-main walkAw 保持一致，才能复现 STR_COUNT=42）：
              //   {url_list:[...]} / {src:"..."} / 数组 / 字符串
              if (pa && typeof pa === 'object' && Array.isArray(pa.url_list)) {
                pa.url_list.forEach((u) => { if (typeof u === 'string') brUrls.push(u); });
              } else if (typeof pa === 'object' && typeof pa.src === 'string') {
                // ★关键兜底：url_list=NOT_ARR 时直链在 pa.src（用户实测 bitRateList[0].playAddr 是对象且 url_list 空）
                brUrls.push(pa.src);
              } else if (Array.isArray(pa)) {
                pa.forEach((x) => { if (typeof x === 'string') brUrls.push(x); else if (x && typeof x.src === 'string') brUrls.push(x.src); else if (x && Array.isArray(x.url_list)) x.url_list.forEach((u) => { if (typeof u === 'string') brUrls.push(u); }); });
              } else if (typeof pa === 'string') {
                brUrls.push(pa);
              }
            });
            list = brUrls;
          }
          if (!list || !list.length) return null;
          const formats = [];
          const bit = v.bit_rate || [];
          // ★2026-08-23：抖音 download_addr 是「下载源」= 原始最高清正片（无水印），应优于 play_addr（播放源，可能降清晰度）。
          // 故默认选中项优先 download_addr；若无 download_addr 才回退到 play_addr。
          const defaultIdx = v.download_addr ? 2 : (v.play_addr ? 0 : -1);
          const addFmt = (label, addr, idx) => {
            if (!addr || !addr.url_list || !addr.url_list.length) return;
            const b = bit[idx] || {};
            const q = b.gear_name || '';
            const tag = q ? (label + ' ' + q) : label;
            formats.push({ url: addr.url_list[0].replace(/\\\//g, '/'), label: tag, bit_rate: b.bit_rate || 0, is_default: idx === defaultIdx });
          };
          if (v.play_addr) addFmt('播放源', v.play_addr, 0);
          if (v.play_addr_h265) addFmt('H265', v.play_addr_h265, 1);
          if (v.download_addr) addFmt('下载源', v.download_addr, 2);
          // ★2026-08-22 修复：抖音现代结构 video.cover 可能是字符串（直链），也可能是 { url_list:[...] } 对象
          const cover = (typeof v.cover === 'string' && v.cover)
            ? v.cover.replace(/\\\//g, '/')
            : ((v.cover && v.cover.url_list && v.cover.url_list[0]) || '');
          // 补充 coverUrlList / originCover 等数组型封面
          const cover2 = (!cover && (Array.isArray(v.coverUrlList) && v.coverUrlList[0])) ? v.coverUrlList[0].replace(/\\\//g, '/') : '';
          const finalCover = cover || cover2;
          const title = a.itemTitle || a.desc || a.preview_title || '';
          const am = (a.awemeId != null) ? String(a.awemeId) : (a.aweme_id != null ? String(a.aweme_id) : '');
          // ★2026-08-23 统一播放地址：附带抖音视频页 playerUrl，供侧栏点击切源页播放（侧栏 CDN 直链无法播）。
          // ★2026-08-23 修复（"切页自动刷新/匹配不上当前视频"根因）：
          //   旧逻辑一律构造 https://www.douyin.com/video/<awemeId>，但用户实际播放页是
          //   jingxuan?modal_id=<feedId>，且 awemeId(视频实体 id) ≠ modal_id(feed item id)。
          //   把 awemeId 当 modal_id 塞进切页 URL → 抖音找不到该 feed item → 自动刷新/跳错视频。
          //   修复：优先沿用【源页当前 URL 的 modal_id/aweme_id 参数 + 源页路径】构造 playerUrl，
          //   这样切页后仍在同一个 jingxuan 上下文、精确命中当前播放视频；无 modal_id 才回退 /video/<awemeId>。
          let modalId = (am && am !== 'unknown') ? am : '';
          const finalPlayerUrl = (() => {
            try {
              const lu = new URL(location.href);
              const m = lu.searchParams.get('modal_id') || lu.searchParams.get('aweme_id') || (am && am !== 'unknown' ? am : '');
              if (!m) return '';
              if (lu.searchParams.has('modal_id') || lu.searchParams.has('aweme_id')) {
                // 沿用源页路径（jingxuan/note 等），仅替换/保留 modal_id 参数
                lu.searchParams.set(lu.searchParams.has('modal_id') ? 'modal_id' : 'aweme_id', m);
                return lu.toString();
              }
              return 'https://www.douyin.com/video/' + m;
            } catch (_) { return am && am !== 'unknown' ? ('https://www.douyin.com/video/' + am) : ''; }
          })();
          return { url: String(list[0] || '').replace(/\\\//g, '/'), matched: matched && String(am || '') === String(targetId || ''), formats, title, cover: finalCover, awemeId: am, modalId, duration: a.duration || v.duration, playerUrl: finalPlayerUrl };
        };
        // ★2026-08-21 修复:合集多集数场景(抖音 jingxuan?modal_id=...),旧逻辑只返回当前 modal 那一条,
        //   网络层 dyUrls(每集一条独立 CDN)又因 playerUrl+dedup 命中合集页 URL 被合并为 1 条,
        //   最终侧栏只看到 1 张视频卡片重复显示合集多张封面,点击全部播放同一视频。
        //   新逻辑:awemes >= 2 且 dyUrls.length >= 2 时,按 RENDER_DATA aweme 顺序逐一配对 dyUrls(i)
        //   或该 aweme 自带 play_addr,产出多条独立深链资产(__douyinMulti:true),scan 主路径循环 push。
        //   单视频场景保留单对象返回值,不动 refreshFromPage 等下游。
        if (chosen && chosen.video) {
          let baseMeta = buildMeta(chosen);
          // ★2026-08-23 兜底：chosen 节点可能无可用直链（推荐/相关节点、play_addr 与 bitRateList 均空）。
          //   实测 RENDER_DATA 其他 aweme 节点常含 douyinvod 直链（STR_COUNT=42、源页 fetch 206）。
          //   若 chosen 取不到直链，遍历全部 awemes 找第一个 buildMeta 成功的，避免 grab 分支 return null
          //   → 侧栏 a.url 空 → 回退 blob 黑屏。
          if (!baseMeta) {
            for (const alt of awemes) {
              if (alt === chosen || !alt.video) continue;
              const m = buildMeta(alt);
              if (m && m.url) { baseMeta = m; break; }
            }
          }
          if (!baseMeta) return null;
          const dyUrlsArr = isDy && window.__hmdao_captures && window.__hmdao_captures.dyUrls;
          const allDyUrls = (Array.isArray(dyUrlsArr) && dyUrlsArr.length) ? dyUrlsArr : [];
          // ★2026-08-22 修复（截图根因 - 封面/内容/声音全部错配）：
          // 旧 canMulti 误判：awemes walk 会收集 RENDER_DATA 顶层 aweme_list 之外的【推荐/相关】视频
          // （每个都有 aweme_id + video.play_addr），单视频页面 RENDER_DATA 也可能含 N 个推荐 → canMulti=true
          // 进入多视频分支后用 allDyUrls[i] 替换 url，导致所有 item 共用当前播放视频的 CDN 签名直链，
          // 但 cover/title 仍来自各自 RENDER_DATA 静态记录 → 5 张卡片都是不同封面不同标题，全部点开播放同一视频。
          // ★新判定（用户截图场景修复）：
          //   - URL 带 modal_id（单视频合集页：用户点击某集后进入 modal 单独播放）→ 永远走单对象返回。
          //     这是用户截图场景：5 张同封面卡片 = 顶层 aweme_list 整集合（含其他集）都被错配生成。
          //   - URL 不带 modal_id（合集主页/多集数列表）→ 顶层 aweme_list >= 2 时走多视频分支。
          //   - 单视频普通视频页（无 modal_id + 无 jingxuan 路径）→ 单对象返回。
          const isJingxuanMulti = (() => {
            try {
              const isJingxuan = /\/jingxuan(\/|\?|$)/.test(location.pathname)
                || location.hostname.includes('jingxuan.douyin.com');
              const hasModal = !!targetId && /modal_id=/.test(location.search);
              // 顶层 aweme_list 长度 >= 2 才是真正的多视频合集页（单视频合集页顶层只有 1 个）
              // 兼容顶层键名 aweme_list / awemeList
              const topLevel = (root && (root.aweme_list || root.awemeList) && Array.isArray(root.aweme_list || root.awemeList)) ? (root.aweme_list || root.awemeList) : null;
              // ★2026-08-22 修复（批量采集失效）：jingxuan?modal_id=xxx 单集页的合集105集【不在】顶层 aweme_list
              // （aweme_list 通常只有当前集，长度=1），而是在 RENDER_DATA 其他字段（preloadAwemeList /
              // videoDetail.chapterInfo / 深层嵌套）。旧逻辑要求 topLevel.length>=2 才进多视频分支 → 永远进不去。
              // ★改为：batchMode 开启时，凡 hasModal 页一律走 grab() 全树扫描（grab 遍历整个 RENDER_DATA
              // 找所有带 video.play_addr 的对象，不受 aweme_list 限制），天然覆盖合集/选集。
              if (hasModal) {
                if (batchMode) return true;
                return false;
              }
              // ★2026-08-22 信息流批量采集：放宽多视频触发条件
              //   - jingxuan 合集主页（无 modal_id）→ 多视频
              //   - 信息流/搜索/发现/首页（无 modal_id）→ 同样走 aweme_list 全量多视频，实现"当前页所有视频"模式
              //   - 单视频普通页（无 modal_id + 顶层只有 1 个）→ 单对象
              const isFeed = /\/(search|discover|recommend|feed|explore)(\/|\?|$)/.test(location.pathname)
                || location.pathname === '/' || location.pathname === '';
              if (isJingxuan && topLevel && topLevel.length >= 2) return true;
              if (isFeed && topLevel && topLevel.length >= 2) return true;
              // 兜底：无 jingxuan/feed 标记但顶层确实是多视频列表（如用户自定义合集），也走多视频
              return !!(topLevel && topLevel.length >= 2);
            } catch (_) { return false; }
          })();
          if (isJingxuanMulti) {
            // 真正的合集多集数场景：按 RENDER_DATA 顶层 aweme_list 顺序生成多 item（每条用各自 RENDER_DATA 真实 url/cover/title）
            const topLevel = (root && (root.aweme_list || root.awemeList) && Array.isArray(root.aweme_list || root.awemeList)) ? (root.aweme_list || root.awemeList) : [];
            const seenIds = new Set();
            const items = [];
            for (let i = 0; i < topLevel.length; i++) {
              const a = topLevel[i];
              if (!a || !a.video) continue;
              const id = (a.awemeId != null) ? String(a.awemeId) : (a.aweme_id != null ? String(a.aweme_id) : '');
              if (!id || seenIds.has(id)) continue;
              seenIds.add(id);
              const m = buildMeta(a);
              if (!m) continue;
              // ★2026-08-22 关键修复：移除 `m.url = allDyUrls[i]` —— 让每条 item 用各自 RENDER_DATA 真实 url，
              //   不会因为全部替换成当前播放 CDN 而错配封面/内容。
              //   (注:合集切集时新集的视频会重新触发 hmdaoCaptureDyStream → 推新 dyUrls,scan.js 网络层也会更新对应 awemeId)
              items.push(m);
            }
            if (items.length >= 2) {
              items.forEach((it, k) => {
                it.__douyin = true;
                it.__douyinMulti = true;
                it.__isCurrent = (String(it.awemeId || '') === String(targetId || ''));
                it.__index = k;
                // ★2026-09-03：按合集播放顺序记「第几集」，供下载文件名加「第 N 集」且匹配当前播放源
                it.episodeNo = k + 1;
              });
              return { __douyinMulti: true, items };
            }
          }
          // 单视频场景：保持原行为(返回单对象)
          return { __douyin: true, ...baseMeta };
        }
        return null;
      };

      const els = document.querySelectorAll('script#RENDER_DATA, script[id="RENDER_DATA"]');
      for (const el of els) {
        if (el && el.textContent) {
          try {
            let data;
            try {
              data = JSON.parse(decodeURIComponent(el.textContent));
            } catch (_) {
              data = JSON.parse(el.textContent);
            }
            // ★2026-08-22 修复（jingxuan/视频详情页：封面=电子营业执照、内容错配根因）:
            // 抖音新版 RENDER_DATA 顶层只有 app，真实视频在 data.app.videoDetail（字段 awemeId 驼峰）。
            // 旧 grab() 递归找 o.aweme_id 永远 0 命中 → 返回 null → 退化裸 URL → 封面/内容全错。
            // 这里直接从 videoDetail 构造精确 meta：awemeId/封面/标题 与当前播放视频一致。
            // url 优先用「当前播放直链 dyUrlsTail」(有效签名、页面能播)，无则用 bitRateList 兜底。
            // ★2026-08-23：jingxuan SPA 切集场景下，RENDER_DATA.videoDetail 可能滞后于实际播放。
            //   例：modal_id 锚定合集里第91集，但 videoDetail.awemeId 仍是另一个「详情页」主视频。
            //   若有 curVideoSrc（即页面 <video> 真实在播的流），用它去 RENDER_DATA 全树反查它属于哪个 aweme，
            //   并用那个 aweme 的 cover/title/awemeId 构建 meta —— 真正的「数据统一」。
            const vd = data && data.app && data.app.videoDetail;
            if (vd && vd.awemeId && vd.video && !batchMode) {
              const vid = vd.video || {};
              // ★尝试用 curVideoSrc 反查 RENDER_DATA 里真正对应的 aweme（覆盖 videoDetail 与实际播放不一致的情况）
              let resolvedVd = vd;
              let resolvedVid = vid;
              let resolvedAwemeId = String(vd.awemeId);
              let resolvedCover = '';
              let resolvedTitle = vd.desc || vd.itemTitle || '';
              if (curVideoSrc) {
                try {
                  let csPath = '';
                  try { csPath = new URL(curVideoSrc).origin + new URL(curVideoSrc).pathname; } catch (_) {}
                  if (csPath) {
                    const collectPlayUrls = (v) => {
                      const urls = [];
                      try {
                        if (v.play_addr && v.play_addr.url_list) urls.push(...v.play_addr.url_list);
                        if (v.play_addr_h265 && v.play_addr_h265.url_list) urls.push(...v.play_addr_h265.url_list);
                        if (v.download_addr && v.download_addr.url_list) urls.push(...v.download_addr.url_list);
                        if (Array.isArray(v.bitRateList)) v.bitRateList.forEach((br) => {
                          const pa = br && (br.playAddr || br.PlayUrl);
                          if (Array.isArray(pa)) pa.forEach((x) => { try { urls.push(typeof x === 'string' ? x : (x.url_list && x.url_list[0]) || x.src || ''); } catch (_) {} });
                          else if (pa && typeof pa === 'object') { try { urls.push(pa.url_list && pa.url_list[0] || pa.src || ''); } catch (_) {} }
                        });
                      } catch (_) {}
                      return urls;
                    };
                    let hit = null;
                    const walkFind = (o, d) => {
                      if (!o || typeof o !== 'object' || d > 12 || hit) return;
                      if (Array.isArray(o)) { o.forEach((x) => walkFind(x, d + 1)); return; }
                      if (o.video) {
                        const urls = collectPlayUrls(o.video);
                        for (const u of urls) {
                          if (!u) continue;
                          let uPath = '';
                          try { uPath = new URL(u).origin + new URL(u).pathname; } catch (_) {}
                          if (uPath && uPath === csPath) { hit = o; break; }
                        }
                      }
                      if (!hit) for (const k in o) { try { walkFind(o[k], d + 1); } catch (_) {} }
                    };
                    walkFind(data, 0);
                    if (hit && hit.video) {
                      const hitAm = (hit.awemeId != null) ? String(hit.awemeId) : (hit.aweme_id != null ? String(hit.aweme_id) : '');
                      if (hitAm) {
                        resolvedAwemeId = hitAm;
                        // hit.aweme 是 RENDER_DATA 里完整结构，hit.video 通常包含 cover/desc/title
                        resolvedVd = hit;
                        resolvedVid = hit.video;
                        const cv = hit.video.cover || hit.video.originCover || hit.video.dynamicCover || '';
                        if (typeof cv === 'string') resolvedCover = cv;
                        else if (cv && cv.url_list && cv.url_list[0]) resolvedCover = cv.url_list[0];
                        resolvedTitle = hit.desc || hit.itemTitle || resolvedTitle || '';
                      }
                    }
                  }
                } catch (_) {}
              }
              // 若 curVideoSrc 没命中，保持 videoDetail 原值；否则用反查结果
              if (!resolvedCover) {
                const coverRaw = vid.cover || vid.originCover || vid.dynamicCover || vid.gaussianCover || '';
                resolvedCover = (typeof coverRaw === 'string') ? coverRaw : (coverRaw && coverRaw.url_list && coverRaw.url_list[0]) || '';
              }
              // url 优先：当前播放直链（curVideoSrc 命中 / dyUrlsTail）> bitRateList[0].playAddr.src > play_addr.url_list
              let url = curVideoSrc || dyUrlsTail || '';
              if (!url) {
                // ★2026-08-23 修复（实测：bitRateList[0] 常是音频轨 → 侧栏有声音没画面）
                //   遍历 bitRateList 找第一个【非音频轨】的 playAddr，优先视频轨。
                const brs = Array.isArray(vid.bitRateList) ? vid.bitRateList : [];
                for (const br0 of brs) {
                  if (!br0) continue;
                  const paObj = br0.playAddr || br0.PlayUrl;
                  const paStr = (paObj && typeof paObj === 'object' && typeof paObj.src === 'string') ? paObj.src
                    : (paObj && typeof paObj === 'object' && Array.isArray(paObj.url_list) ? paObj.url_list[0]
                      : (typeof paObj === 'string' ? paObj : ''));
                  const isAudio = (br0.gear_type === 'audio' || br0.GearType === 'audio')
                    || /media-audio/i.test(paStr || (paObj ? JSON.stringify(paObj) : ''));
                  if (isAudio) continue;
                  // 兼容 playAddr 三种形态：{src} / {url_list:[...]} / 数组[].src / 字符串
                  let brSrc = '';
                  if (paObj && typeof paObj === 'object') brSrc = (typeof paObj.src === 'string' && paObj.src) || (Array.isArray(paObj.url_list) && paObj.url_list[0]) || '';
                  else if (Array.isArray(paObj)) brSrc = (paObj[0] && (paObj[0].src || (paObj[0].url_list && paObj[0].url_list[0]))) || '';
                  else if (typeof paObj === 'string') brSrc = paObj;
                  if (!brSrc && br0.url_list) brSrc = Array.isArray(br0.url_list) ? br0.url_list[0] : '';
                  if (brSrc) { url = typeof brSrc === 'string' ? brSrc : (brSrc.url_list && brSrc.url_list[0]) || ''; break; }
                }
              }
              if (!url) {
                const pa = vid.play_addr || vid.download_addr;
                if (pa) url = (pa.url_list && pa.url_list[0]) || '';
              }
              if (url) {
                // ★2026-08-24 日志降噪修复（用户实测"控制台突然狂刷 HMDAO 警告，之前没有"根因）：
                //   此 console.warn 是 2026-08-23 验证"抖音 app.videoDetail 精确匹配"时加的调试日志，
                //   但 extractFreshVideoUrl 每次点卡片/自动重扫都会被 executeScript 重新注入执行一次，
                //   导致该 warn 在抖音页 console 反复刷屏（VM9009/VM9022 多次注入）。
                //   改为仅在诊断模式（window.__hmdaoVerbose=true，由 __hmdaoRunFullDiag 设置）才打印，
                //   平时彻底静默——消除扩展自身造成的控制台噪音，不影响任何解析功能。
                if (window.__hmdaoVerbose) console.warn('[HMDAO-diag] 抖音:从 app.videoDetail 精确匹配 aweme ' + resolvedAwemeId + '（封面/内容对齐当前播放）');
                return { __douyin: true, url, matched: true, awemeId: resolvedAwemeId, cover: resolvedCover, title: resolvedTitle, duration: (resolvedVd && resolvedVd.createTime) || 0 };
              }
            }
            const r = grab(data);
            if (r) {
              if (r.__douyinMulti) {
                if (targetId && !r.items.some((it) => it.__isCurrent)) {
                  if (window.__hmdaoVerbose) console.warn('[HMDAO-diag] 抖音:合集中未找到目标 modal/aweme ' + targetId + '，已返回全部 ' + r.items.length + ' 条');
                }
                return r; // 多视频合集:外层 {__douyinMulti, items[]}
              }
              if (!r.matched) console.warn('[HMDAO] 抖音/视频号:未匹配到目标 id=' + targetId + '，返回首个视频(可能与当前播放不同)');
              return r;
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
      // ★2026-08-18 修复：素材库页 stock.xinpianchang.com/footage/details/9ePYJbUrefw4I.html
      //   的 vid 是字母数字混合（非纯数字），旧正则 /\/a(\d+)/ 与 /(article|detail|works?)\/(\w+)/
      //   都匹配不到 footage/details/<id> 路径 → vid 为空 → 视频直链解析失败 → 用户只能下到封面图。
      //   新增 /footage\/details\/([\w-]+)/ 分支覆盖素材库页 ID。
      const html = document.documentElement.innerHTML;
      const vid = (html.match(/["']vid["']\s*[:=]\s*["']([\w]+)["']/) || [])[1]
        || (location.pathname.match(/\/a(\d+)/) || [])[1]
        || (location.pathname.match(/\/footage\/details\/([\w-]+)/) || [])[1]
        || (location.pathname.match(/\/(?:article|detail|works?)\/(\w+)/) || [])[1];

      // ① 解析页面内嵌 JSON（新片场把视频资源嵌在 window.__INITIAL_STATE__ 或 RENDER_DATA 等全局）
      const grabFromState = () => {
        try {
          const scripts = Array.from(document.querySelectorAll('script'))
            .map((s) => s.textContent || '').filter((t) => t && /progressive|\.mp4|resource_id|video_id/.test(t));
          for (const t of scripts) {
            // 宽松匹配 progressive 里的 mp4 url
            const mm = t.match(/"url"\s*:\s*"([^"]+\.mp4[^"]*)"/g)
              || t.match(/https?:\/\/[^"'\\<>()\s]+\.mp4[^"'\\<>()\s]*/g);
            if (mm && mm.length) {
              const sorted = mm.map((x) => x.replace(/\\\//g, '/').replace(/^"url"\s*:\s*"/, '').replace(/"$/, ''))
                .sort((a, b) => (b.match(/1080|720|(\d{3,4})p/)?1:0) - (a.match(/1080|720|(\d{3,4})p/)?1:0));
              return sorted[0];
            }
          }
        } catch (_) {}
        return null;
      };
      // ①b 兜底：已渲染页面的 <video>/<source> 标签 + window 全局变量（SPA 运行时注入，不在 <script> 文本里）
      const grabFromDom = () => {
        try {
          const v = document.querySelector('video[src]');
          if (v && /\.mp4/i.test(v.src || '')) return v.src;
          const src = document.querySelector('video source[src]');
          if (src && /\.mp4/i.test(src.src || '')) return src.src;
          // window 全局里找含 .mp4 的字符串（如 __INITIAL_STATE__.video.url）
          for (const k of Object.keys(window)) {
            try {
              const s = JSON.stringify(window[k]);
              if (s && s.length < 200000 && /\.mp4/.test(s)) {
                const m = s.match(/https?:\/\/[^"'\\<>()\s]+\.mp4[^"'\\<>()\s]*/);
                if (m) return m[0].replace(/\\\//g, '/');
              }
            } catch (_) {}
          }
        } catch (_) {}
        return null;
      };
      const fromState = grabFromState();
      if (fromState) return fromState;
      const fromDom = grabFromDom();
      if (fromDom) return fromDom;

      // ② mod-api 兜底（带 referer/UA，降低 403 概率）
      if (vid) {
        try {
          const j = await (await fetch('https://mod-api.xinpianchang.com/mod/api/v2/media/' + vid + '?appKey=61a2f329348b3bf77', {
            credentials: 'include',
            headers: { 'Referer': location.href, 'User-Agent': navigator.userAgent },
          })).json();
          const resource = j && j.data && j.data.resource;
          const progressive = resource && resource.progressive;
          if (progressive && progressive.length) {
            progressive.sort((a, b) => (b.height || 0) - (a.height || 0));
            const u = progressive[0].url || progressive[0].mp4;
            if (u) {
              // ★2026-08-18 修复：把 mod-api 返回的作品名暂存到 window 全局，供 scanTab 合并到
              //   networkAssets[].title，让"采集的视频素材名与源地址不一致（变成'七'）"问题得到修正。
              const realTitle = (j && j.data && (j.data.title || (j.data.work && j.data.work.title))) || resource.title || resource.name || '';
              if (realTitle) { try { window.__hmdao_xpc_meta = { url: u, title: realTitle, cover: (j.data.cover || resource.cover || ''), vid }; } catch (_) {} }
              return u;
            }
          }
        } catch (_) {}
      }
      // ★2026-08-18 新增：aigc.xinpianchang.com（Shotlab AI 创作平台）详情页视频解析。
      //   aigc 作品页（如 /work/<id> 或 /explore/<id>）的视频不在 mod-api/v2/media，而是嵌在
      //   页面内联 JSON（window.__INITIAL_STATE__ / RENDER_DATA）的 videoInfo/mediaInfo/videoUrl/playUrl 字段，
      //   或走 aigc 专用接口。这里优先从内联全局变量深抓 mp4，再探测 aigc 接口。
      if (location.hostname.includes('aigc.xinpianchang.com')) {
        try {
          // a) 遍历 window 全局变量找含 .mp4 的视频 URL（aigc 运行时注入，不在 <script> 文本）
          for (const k of Object.keys(window)) {
            try {
              const s = JSON.stringify(window[k]);
              if (s && s.length < 500000 && /\.mp4|playUrl|videoUrl|video_info|media_info|resourceInfo/i.test(s)) {
                const m = s.match(/https?:\/\/[^"'\\<>()\s]+\.(?:mp4|webm|m3u8)(?:[^"'\\<>()\s]*)?/);
                if (m) {
                  // ★2026-08-18 修复：aigc 详情页常常在 __INITIAL_STATE__/RENDER_DATA 里带作品标题（如 work.title / videoInfo.title），
                  //   顺手抓出来挂到 window.__hmdao_xpc_meta，让素材名与源作品一致。
                  try {
                    const tm = s.match(/"(?:title|videoTitle|video_title|name|workTitle|article_title)"\s*:\s*"([^"\\]{1,200})"/);
                    if (tm && tm[1]) window.__hmdao_xpc_meta = { url: m[0].replace(/\\\//g, '/'), title: tm[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') };
                  } catch (_) {}
                  return m[0].replace(/\\\//g, '/');
                }
              }
            } catch (_) {}
          }
          // b) aigc 专用接口兜底（带 referer）
          if (vid) {
            const aj = await (await fetch('https://aigc.xinpianchang.com/api/v1/work/detail?id=' + vid, {
              credentials: 'include',
              headers: { 'Referer': location.href, 'User-Agent': navigator.userAgent },
            })).json().catch(() => null);
            const au = aj && (aj.data && (aj.data.videoUrl || aj.data.playUrl || (aj.data.videoInfo && aj.data.videoInfo.url)))
              || (aj && aj.data && aj.data.resource && (aj.data.resource.progressive && aj.data.resource.progressive[0] && (aj.data.resource.progressive[0].url || aj.data.resource.progressive[0].mp4)));
            if (au) {
              // ★2026-08-18 修复：aigc 接口回 JSON 顶层 data.title / data.work.title 即作品名。
              const at = aj && aj.data && (aj.data.title || (aj.data.work && aj.data.work.title) || (aj.data.videoInfo && aj.data.videoInfo.title)) || '';
              if (at) { try { window.__hmdao_xpc_meta = { url: au, title: at, cover: (aj.data.cover || (aj.data.work && aj.data.work.cover) || ''), vid }; } catch (_) {} }
              return au;
            }
          }
        } catch (_) {}
      }
      // ③ 整页 mp4 直链兜底
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

// base64 → Uint8Array（abToB64 的反向，供 executeScript 回传的 b64 还原字节）
function b64ToBytes(b64) {
  const bin = atob(String(b64 || ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function fetchUrl(payload) {
  try {
    const url = typeof payload === 'string' ? payload : payload.url;
    // ★守卫：伪 URL（doubao-ws-audio:// 等）不得进 fetch，避免 "URL scheme is not supported" 报错
    if (!url || !/^https?:/i.test(String(url))) {
      return { ok: false, error: 'unsupported-scheme', url: String(url || '').slice(0, 80) };
    }
    // fetch API：credentials 默认 'include' 让扩展 fetch 携带用户的登录 cookie（B站/爱给等
    // 需要 SESSDATA session 才能返回真实音视频字节）。但抖音/TikTok/视频号等媒体仅靠
    // URL 签名 + Referer 鉴权、不需要登录 Cookie，调用方可传 credentials:'omit' 避免
    // 触发 Chrome「第三方 Cookie 将被拦截」告警（Privacy Sandbox 弃用提示）。
    const options = {
      credentials: (typeof payload === 'object' && payload.credentials) || 'include',
      redirect: 'follow',
    };
    // ★2026-08-30：支持自定义 headers（Range 分块下载必需）。
    //   大文件（B站 DASH 轨常达数百 MB~数 GB）无法一次性经 sendMessage 回传（约 64MB 上限），
    //   必须由调用方用 Range: bytes=start-end 分块拉取后本地拼接。
    if (typeof payload === 'object' && payload.headers && typeof payload.headers === 'object') {
      options.headers = payload.headers;
    }
    // ★2026-08-30 修复：支持 method（HEAD）。此前 probeSize 传 method:'HEAD' 被忽略 → 实际发 GET
    //   → 大文件被完整下载一次（仅为了探测大小），浪费流量且拖慢合并流程。
    //   HEAD 时直接返回 content-length，不读 body。
    const method = (typeof payload === 'object' && payload.method) || 'GET';
    if (typeof payload === 'object' && payload.referer) {
      options.referrer = payload.referer;
      options.referrerPolicy = 'unsafe-url';
    }
    if (method === 'HEAD') {
      try {
        const h = await fetch(url, { ...options, method: 'HEAD' });
        const cl = parseInt(h.headers.get('content-length') || '0', 10);
        return { ok: !!h.ok, status: h.status, head: true, contentLength: cl };
      } catch (e) { return { ok: false, error: String((e && e.message) || e), head: true }; }
    }
    // ★2026-08-30 修复（"B站 DASH 下载没反应"真凶）：chrome.runtime.sendMessage 对单条消息有 ~64MB 限制
    //   （实测更严，b64 后超 50MB 易失败），fetchUrl 全量拉回 + b64 回传超大文件必静默失败（侧栏永远 pending）。
    //   现支持 maxBytes：先用 HEAD 探 Content-Length，超限立即拒绝（不下载不回传），调用方改走其他路径。
    const maxBytes = (typeof payload === 'object' && payload.maxBytes) || 0;
    if (maxBytes > 0) {
      try {
        const head = await fetch(url, { ...options, method: 'HEAD' });
        const cl = parseInt(head.headers.get('content-length') || '0', 10);
        if (cl > maxBytes) return { ok: false, error: 'too-large', size: cl, maxBytes, hint: '文件过大（' + Math.round(cl / 1048576) + 'MB > ' + Math.round(maxBytes / 1048576) + 'MB），请选低清晰度或用 yt-dlp 后端下载' };
      } catch (_) { /* HEAD 失败不阻断，下载时再校验 */ }
    }
    const resp = await fetch(url, options);
    if (!resp.ok) return { ok: false, status: resp.status };
    const arrayBuffer = await resp.arrayBuffer();
    if (maxBytes > 0 && arrayBuffer.byteLength > maxBytes) {
      return { ok: false, error: 'too-large', size: arrayBuffer.byteLength, maxBytes, hint: '文件过大（' + Math.round(arrayBuffer.byteLength / 1048576) + 'MB > ' + Math.round(maxBytes / 1048576) + 'MB），请选低清晰度或用 yt-dlp 后端下载' };
    }
    // ★2026-09-10 修复（"用户设置的目录被忽略、下载落到默认路径"真凶）：
    // chrome.runtime.sendMessage 在跨上下文回传时会【丢弃 ArrayBuffer】（对侧收到的是空对象、
    // byteLength=undefined），导致侧栏 res.arrayBuffer 永远为空 → 保存用户目录逻辑判定失败 → 回退默认路径。
    // 故必须转 base64 字符串回传；sidepanel 侧用 b64ToBytes 还原。arrayBuffer 仍保留（同进程调用兼容）。
    let b64 = '';
    try {
      const v = new Uint8Array(arrayBuffer);
      let s = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < v.length; i += CHUNK) s += String.fromCharCode.apply(null, v.subarray(i, i + CHUNK));
      b64 = btoa(s);
    } catch (_) { b64 = ''; }
    return {
      ok: true,
      arrayBuffer,
      b64,
      size: arrayBuffer.byteLength,
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
              // ★2026-09-09：跨 executeScript 回传字节必须用 base64（原 Array.from(u8) 每字节一个
              //   JS number，1MB 视频≈100 万数组元素，结构化克隆极慢且逼近单条消息上限）。
              let s = '';
              const CH = 0x8000;
              for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + CH)));
              done({ ok: true, b64: btoa(s), size: u8.length, mime: resp.headers.get('content-type') || 'video/mp4' });
            } catch (e) { done({ ok: false, error: 'arrbuf:' + ((e && e.message) || e) }); }
          })
          .catch((e) => done({ ok: false, error: String((e && e.message) || e) }));
      }),
      args: [url, referer],
    });
    const res = r && r.result;
    if (res && res.ok && typeof res.b64 === 'string') {
      const bytes = b64ToBytes(res.b64);
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      return { ok: true, arrayBuffer: ab, mime: res.mime || 'video/mp4' };
    }
    return res || { ok: false, error: 'no-result' };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

// 源页 MAIN 世界 fetch（带页面会话 Cookie，credentials:'include'）：
// 与页面同源同 Cookie 分区，自动继承 ttwid/SESSDATA 等登录态 Cookie。
// 专用于「SW fetch(omit) + ISOLATED 世界 omit 兜底」都拿不到的抖音防盗链播放流
// （sf*-cdn-tos.douyinstatic.com 视频、ies-music/*.mp3 音频），这些必须带会话 Cookie 才回 200。
// 注意：抖音第三方 Cookie 由页面自身在用户已登录抖音时持有，用 credentials:'include' 在 MAIN 世界
// fetch 不会触发「Third-party cookie will be blocked」告警（那是 SW 世界跨站自动附加才有的告警）。
// 配合 installAudioCorsRule 注入的 ACAO 响应头即可读取字节。
// ★2026-09-08：源页带 Cookie 取字节专用 CORS 规则（ID 987656）。
//   credentials:'include' 模式下，响应头 ACAO 不能是通配符 '*' —— 浏览器会直接拒绝
//   （实测即梦 jimeng：The value of the 'Access-Control-Allow-Origin' header must not be the
//    wildcard '*' when the request's credentials mode is 'include' → ERR_FAILED 403）。
//   原因：现有通用规则给的是 ACAO='*'，而本路径的请求发起者是【源页】而非扩展。
//   故按「目标域名 + 源页发起者」精确作用域临时注入 ACAO=<源页 origin> + ACAC:true + Vary:Origin，
//   用完立即移除；只匹配该图片/媒体域名、只匹配源页发起的请求，不改 Referer，对页面零副作用。
async function installPageCookieCorsRule(url, pageOrigin) {
  const RULE_ID = 987656;
  try {
    if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateSessionRules) return null;
    const host = new URL(url).hostname;
    const domain = registeredDomain(host) || host;
    const pageHost = new URL(pageOrigin).hostname;
    const pageDomain = registeredDomain(pageHost) || pageHost;
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [RULE_ID],
      addRules: [{
        id: RULE_ID,
        priority: 101,
        action: {
          type: 'modifyHeaders',
          responseHeaders: [
            { header: 'access-control-allow-origin', operation: 'set', value: pageOrigin },
            { header: 'access-control-allow-credentials', operation: 'set', value: 'true' },
            { header: 'vary', operation: 'set', value: 'Origin' },
          ],
        },
        condition: {
          urlFilter: '||' + domain,
          resourceTypes: ['xmlhttprequest', 'other'],
          initiatorDomains: [pageDomain],
        },
      }],
    }).catch(() => {});
    return RULE_ID;
  } catch (_) { return null; }
}
async function removePageCookieCorsRule(ruleId) {
  try { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }); } catch (_) {}
}
async function fetchMediaInTabWithCookie(tabId, url, referer) {
  let __pccRule = null;
  try {
    let pageOrigin = '';
    try { const t = await chrome.tabs.get(tabId); pageOrigin = new URL(t.url || '').origin; } catch (_) {}
    if (pageOrigin) __pccRule = await installPageCookieCorsRule(url, pageOrigin);
  } catch (_) {}
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (u, ref) => new Promise((resolve) => {
        const done = (o) => resolve(o);
        fetch(u, { credentials: 'include', referrer: ref || 'https://www.douyin.com/', referrerPolicy: 'unsafe-url', cache: 'no-store' })
          .then(async (resp) => {
            if (!resp.ok) return done({ ok: false, status: resp.status });
            try {
              const buf = await resp.arrayBuffer();
              const u8 = new Uint8Array(buf);
              // ★2026-09-09：跨 executeScript 回传字节必须用 base64（原 Array.from(u8) 每字节一个
              //   JS number，1MB 视频≈100 万数组元素，结构化克隆极慢且逼近单条消息上限）。
              let s = '';
              const CH = 0x8000;
              for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + CH)));
              done({ ok: true, b64: btoa(s), size: u8.length, mime: resp.headers.get('content-type') || 'video/mp4' });
            } catch (e) { done({ ok: false, error: 'arrbuf:' + ((e && e.message) || e) }); }
          })
          .catch((e) => done({ ok: false, error: String((e && e.message) || e) }));
      }),
      args: [url, referer],
    });
    const res = r && r.result;
    if (res && res.ok && typeof res.b64 === 'string') {
      const bytes = b64ToBytes(res.b64);
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      return { ok: true, arrayBuffer: ab, mime: res.mime || 'video/mp4' };
    }
    return res || { ok: false, error: 'no-result' };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  finally { if (__pccRule) { try { await removePageCookieCorsRule(__pccRule); } catch (_) {} } }
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
              // ★2026-09-09：跨 executeScript 回传字节必须用 base64（原 Array.from(u8) 每字节一个
              //   JS number，1MB 视频≈100 万数组元素，结构化克隆极慢且逼近单条消息上限）。
              let s = '';
              const CH = 0x8000;
              for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + CH)));
              done({ ok: true, b64: btoa(s), size: u8.length, mime: resp.headers.get('content-type') || 'video/mp4' });
            } catch (e) { done({ ok: false, error: 'arrbuf:' + ((e && e.message) || e) }); }
          })
          .catch((e) => done({ ok: false, error: String((e && e.message) || e) }));
      }),
      args: [url, referer],
    });
    const res = r && r.result;
    if (res && res.ok && typeof res.b64 === 'string') {
      const bytes = b64ToBytes(res.b64);
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

// ★2026-09-14：官网（mingmingchuangyi.cn）标签查找。与 findHmdaoTab 分离，不改动既有 3000 逻辑。
// ★M3：仅匹配官网 apex 域，避免把本机凭据推送到信任级别更低的子域页面。
//   子域页面仍可通过「页面主动索取」（HMDAO_WEB_REQUEST_CREDS）自动登录，只是不接收主动推送。
async function findSiteTab() {
  const tabs = await chrome.tabs.query({ url: ['https://mingmingchuangyi.cn/*'] });
  return tabs[0] || null;
}

// 扩展侧登录成功后，主动让已打开的官网标签自动登录（凭据经 site-auth-bridge.js 同源传递，不出本机）。
async function pushAutoLoginToSite() {
  try {
    const tab = await findSiteTab();
    if (!tab || !tab.id) return { ok: false, error: 'no-site-tab' };
    await chrome.tabs.sendMessage(tab.id, { type: 'HMDAO_EXT_AUTOLOGIN' });
    return { ok: true, tabId: tab.id };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ★2026-09-14 自愈：扩展令牌失效（服务端重启/被吊销）且本机无记住的凭据时，
//   请仍处于登录态的官网标签重新走一次「绑定码」同步，用户无需手动操作。
//   链路：sidepanel → background(本函数) → site-auth-bridge → 页面 → /bind-code → /bind → 新令牌
async function pushSiteRefreshLogin() {
  try {
    const tab = await findSiteTab();
    if (!tab || !tab.id) return { ok: false, error: 'no-site-tab' };
    await chrome.tabs.sendMessage(tab.id, { type: 'HMDAO_SITE_REFRESH_LOGIN' });
    return { ok: true, tabId: tab.id };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// 已注入智能机器人浮标的标签页集合（用于侧栏随时「收回」）
const robotTabIds = new Set();
chrome.tabs.onRemoved.addListener((id) => { robotTabIds.delete(id); stopPolling(id); });
// 导航/刷新会卸载 content script（浮标随之消失），同步清理记录
chrome.tabs.onUpdated.addListener((id, info) => {
  if (info.status === 'loading' && robotTabIds.has(id)) robotTabIds.delete(id);
});

// ★2026-08-23 P0：侧栏与当前浏览器页同步 —— 用户切换标签 / 当前标签 URL 变化 → 通知侧栏自动重扫。
//   解决「侧栏扫描内容跟当前打开的页面不一样、旧素材残留」的根因：之前只有手动点「重新扫描」才同步，
//   切 tab 或同 tab 跳转（如抖音切集）后侧栏仍是旧页素材。
//   实现：background 在这两个时机向侧栏（runtime.sendMessage）发 HMDAO_RESCAN_TAB，
//   侧栏收到后先清空旧素材再扫描，确保只反映当前活动标签。
// ★2026-09-04 性能回归修复（用户实测"打开抖音异常卡顿、加载很慢、多个视频声音"）：
//   抖音是 SPA，滚动 / 切集 / 切 tab 都会高频触发 pushState → onHistoryStateUpdated 会疯狂回调。
//   旧实现每次回调都立刻发一次 HMDAO_RESCAN_TAB = 一次 scanTab(deep:true) 全量深度扫描
//   （注入脚本 + 遍历页面 + 触碰播放器），连发几十次直接把页面拖垮，并可能因反复触碰播放器
//   出现"多个视频同时出声"。
//   修复：按 tab 做【节流 + 合并】——最小间隔 1.5s，期间的多次事件只合并成间隔到期后的一次。
// ★2026-09-05 修复（"抖音链接扫几次就卡死、点击半响没反应，其他平台正常"的【抖音专属根因】）：
//   抖音是 SPA，滚动信息流/切集/播放都会触发 pushState → onHistoryStateUpdated 高频回调 →
//   每 1.5s 向侧栏发一次 HMDAO_RESCAN_TAB → 侧栏旧的处理器无条件执行 doRescan()：
//   【清空全部卡片 + 唤醒后端 + runDiagnose 页面诊断注入 + 深度重扫 + 重建 100+ 张卡片（封面重请求）】。
//   反复几次就把侧栏主线程彻底占死 —— 表现为点击延迟、拖不动滑块、源页也跟着卡。
//   非 SPA 站点不会高频触发 pushState，所以"其他平台正常"。
//   治理：① 最小间隔 1.5s → 5s；② 该 tab 上一轮扫描还没跑完 → 直接丢弃（扫描会带上最新状态）；
//         ③ 侧栏侧对 auto 事件改为轻量重扫（不清空、不诊断、不深度解析），见 sidepanel.js。
const HMDAO_RESCAN_MIN_GAP = 5000;
const hmdaoLastRescanAt = new Map();
const hmdaoPendingRescan = new Map();
// ★2026-09-07：新增 url 参数（导航/历史/SPA 的真实目标 URL），透传给侧栏用于「文档身份」比对，
// 让侧栏能区分「真正换页」(清空旧记录) 与「同文档 SPA 切集」(增量合并)，见 sidepanel.js auto 分支。
function notifySidepanelRescan(tabId, url) {
  if (!tabId) return;
  const fire = () => {
    hmdaoLastRescanAt.set(tabId, Date.now());
    // 该 tab 上一轮扫描仍在进行 → 丢弃本次（它与刚结束的扫描结果几乎等价）
    try {
      if (typeof HMDAO_SCAN_RUNNING !== 'undefined' && HMDAO_SCAN_RUNNING && HMDAO_SCAN_RUNNING.has(tabId)) return;
    } catch (_) {}
    chrome.runtime.sendMessage({ type: 'HMDAO_RESCAN_TAB', tabId, auto: true, url: url || '' }).catch(() => {});
  };
  const now = Date.now();
  const last = hmdaoLastRescanAt.get(tabId) || 0;
  const wait = HMDAO_RESCAN_MIN_GAP - (now - last);
  if (wait <= 0) { fire(); return; }
  // 未到最小间隔 → 合并本次事件：重置定时器，只保留最后一次
  const old = hmdaoPendingRescan.get(tabId);
  if (old) clearTimeout(old);
  hmdaoPendingRescan.set(tabId, setTimeout(() => {
    hmdaoPendingRescan.delete(tabId);
    fire();
  }, wait));
}
// 1) 切换标签：激活新标签即同步（取该标签真实 URL 透传，供侧栏比对文档身份）
chrome.tabs.onActivated.addListener((activeInfo) => {
  if (activeInfo && activeInfo.tabId) {
    try { chrome.tabs.get(activeInfo.tabId, (tab) => { notifySidepanelRescan(activeInfo.tabId, (tab && tab.url) || ''); }); }
    catch (_) { notifySidepanelRescan(activeInfo.tabId, ''); }
  }
});
// 2) 同一标签 URL 变化（导航/刷新/抖音切集）：onCommitted 在文档提交时触发，比 onUpdated 更准
if (chrome.webNavigation && chrome.webNavigation.onCommitted) {
  chrome.webNavigation.onCommitted.addListener((details) => {
    // 仅主框架（frameId===0），忽略 iframe/子帧，避免侧栏内 iframe 误触发
    if (details && details.frameId === 0 && details.tabId) notifySidepanelRescan(details.tabId, details.url);
  });
}
// 2b) ★2026-09-04 切集不同步【致命根因修复】：
//   抖音 jingxuan 合集切集是 SPA，用 history.pushState 更新 ?modal_id=<新一集>，
//   **pushState 不会触发 onCommitted**（onCommitted 只在真实文档提交时触发），
//   所以上面这条监听器对"切集"完全无效 → 侧栏永远停在首集、标题/封面/集数全不跟随。
//   必须监听 onHistoryStateUpdated（专门捕获 pushState/replaceState 造成的 URL 变化）。
if (chrome.webNavigation && chrome.webNavigation.onHistoryStateUpdated) {
  chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details && details.frameId === 0 && details.tabId) {
      // ★2026-09-07：透传 details.url（前进/后退回到历史记录也在此触发），供侧栏判定是否跨文档换页。
      notifySidepanelRescan(details.tabId, details.url);
    }
  });
}
// 2c) hash 变化（#xxx 路由）：【暂不监听】。
//   抖音用 ?modal_id= 而非 hash，对它无收益；而 hash 变化在部分站点极其频繁，
//   监听只会制造扫描风暴。若将来需要支持 hash 路由站点再单独开启。
//   （已由上方 notifySidepanelRescan 的节流兜住，即便开启也不会拖垮页面。）

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
// ★B站播放页禁用本缓冲：B站原生播放器对 play()/pause() 注入极敏感，会破坏用户已暂停/播放的状态
// （表现为「点暂停了又自己播放」），且 B站走「用户选择后再解析」策略，不自动无脑缓冲采素材。
async function forceYtBufferAndCapture() {
  try {
    const h = location.hostname || '';
    const isBili = (h.endsWith('bilibili.com') || h.endsWith('b23.tv')) && /\/(video|blackboard\/.*play|festival)\//.test(location.pathname);
    if (isBili) return; // B站：绝不触碰播放器，保护浏览端运行状态
    // ★2026-09-10 硬边界：本函数语义是「强制【YouTube】缓冲以捕获 googlevideo 直链」，
    //   对源页 <video> 执行 静音 → currentTime+1 → play → 1.5s → pause → 恢复，属破坏性操作。
    //   原实现只挡了 B站，其余站点（MSN 用 video.js）同样会被跳进度 + play/pause 抖动
    //   → 播放器状态机错乱 / MSE 缓冲重置 → 源页视频不能播放。
    //   调用点(scan.js:1031)虽已限定为 YouTube，但函数自身必须自证清白：非 YouTube 一律不碰。
    if (!/(^|\.)youtube\.com$/.test(h) && !/(^|\.)youtu\.be$/.test(h)) return;
    const v = document.querySelector('video');
    if (!v) return;
    // 若用户当前已暂停，不强行播放（避免「暂停了又自己播放」的观感与竞态）
    if (v.paused) return;
    const wasMuted = v.muted;
    const wasPlaying = !v.paused && !v.ended;
    v.muted = true;
    try { v.currentTime = Math.min((v.currentTime || 0) + 1, (v.duration || 1e9)); } catch (_) {}
    await v.play().catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    try { v.pause(); } catch (_) {}
    v.muted = wasMuted;
    // ★2026-08-23 修复（问题1「源页突然暂停」）：缓冲结束后恢复原播放状态，
    //   绝不把「原本在播」的视频停留在暂停态（此前 pause() 后不恢复 → 源页莫名暂停）。
    if (wasPlaying) {
      try { v.play().catch(() => {}); } catch (_) {}
    }
  } catch (_) {}
}

// C) 合并 MAIN 世界被动捕获读取（原本分散 3+ 次 executeScript 往返 → 1 次）。
// 返回 YouTube 播放流 + 抖音直链/多质量版本 + ★下载 API 捕获的模型/压缩包直链(modelHits)。
// ★注意：executeScript({func}) 序列化【不带闭包】——不能引用外部函数/常量，
// 否则页面里是 ReferenceError 被吞。抖音 formats 解析逻辑必须内联在本函数体内（见下方内联版）。
function readAllCapturesMAIN() {
  const out = { ytPlay: null, dyUrls: [], dyFormats: null, modelHits: [], audioPlays: [], apiVideos: [], aigeiVideos: [], xunleiShare: null, xunleiMyDrive: null, dyCoverByAweme: {}, dyFormatsByAweme: {}, dyTitlesByAweme: {} };
  try {
    // ★2026-09-02 关键修复（当前视频「无分辨率 / 无封面 / curAwemeId 为空」的最终落点）：
    //   抖音 jingxuan 首屏数据（app.videoDetail，驼峰结构）原先只在【捕获到一条新流】之后才扫，
    //   而视频缓冲完(readyState=4)就不再发请求 → 该分支永不执行；改注入脚本内轮询后又被
    //   SPA 注入的 delete window.__hmdao_captures 反复冲掉（实测：自动调度查为空、手动调用
    //   立刻有 20 档）。改为在【读取时同步补扫】——本函数由 executeScript 在 MAIN world 执行，
    //   此刻数据必定最新，且不依赖任何后台定时/注入时序。函数幂等，重复执行无副作用。
    try { if (typeof window.__hmdaoScanDyRenderData === 'function') window.__hmdaoScanDyRenderData(); } catch (_) {}
    out.ytPlay = (window.__hmdao_captures && window.__hmdao_captures.ytPlay) || null;
    out.dyUrls = (window.__hmdao_captures && window.__hmdao_captures.dyUrls) || [];
    // ★2026-08-18：MAIN 世界捕获抖音直链时同步收集的封面（dyCovers），随 dyUrls 一起回传，
    // 供 scan.js 直接赋给 dyUrls 资产，避免 jingxuan 信息流页跨世界 byKey 匹配失败导致缩略图空白。
    out.dyCovers = (window.__hmdao_captures && Array.isArray(window.__hmdao_captures.dyCovers))
      ? window.__hmdao_captures.dyCovers.slice(-50) : [];
    // ★2026-08-21：抖音 CDN dyUrls 对应的 aweme_id 序列（合集多集数场景 dedup 用）；保持与 dyUrls 1:1 同步。
    out.dyAwemes = (window.__hmdao_captures && Array.isArray(window.__hmdao_captures.dyAwemes))
      ? window.__hmdao_captures.dyAwemes.slice(-50) : [];
    // ★2026-08-22 深层修复：dyUrls 是否"当前播放流"标记（与 dyUrls 1:1）。仅播放态捕获的流为 true，
    // 用于 scan.js 过滤搜索/信息流的预加载脏数据（这些预加载流不会进 dyUrls，此处恒为 true，保留以备未来扩展）。
    out.dyPlayback = (window.__hmdao_captures && Array.isArray(window.__hmdao_captures.dyPlayback))
      ? window.__hmdao_captures.dyPlayback.slice(-50) : [];
    // ★2026-09-02：抖音 DASH 分轨收集（inject-main）。
    //   dyUrls 只放视频轨；音频轨单独放 dyAudios[{url, ts, awemeId}]，
    //   这样后端 ffmpeg 才有音频轨可合并成含音画单文件（此前抖音合并不了就是因为音频轨被丢弃）。
    out.dyAudios = (window.__hmdao_captures && Array.isArray(window.__hmdao_captures.dyAudios))
      ? window.__hmdao_captures.dyAudios.slice(-50) : [];
    // 与 dyUrls 1:1 的视频轨捕获时间戳，供 scan.js 按「时间邻近」把音频轨配对到视频卡
    out.dyUrlTs = (window.__hmdao_captures && Array.isArray(window.__hmdao_captures.dyUrlTs))
      ? window.__hmdao_captures.dyUrlTs.slice(-50) : [];
    // ★2026-09-01：按 awemeId 索引的封面与多画质直链，供 scan.js 精确回填到对应视频卡。
    out.dyCoverByAweme = (window.__hmdao_captures && window.__hmdao_captures.dyCoverByAweme && typeof window.__hmdao_captures.dyCoverByAweme === 'object')
      ? window.__hmdao_captures.dyCoverByAweme : {};
    out.dyFormatsByAweme = (window.__hmdao_captures && window.__hmdao_captures.dyFormatsByAweme && typeof window.__hmdao_captures.dyFormatsByAweme === 'object')
      ? window.__hmdao_captures.dyFormatsByAweme : {};
    // ★2026-09-04：按 awemeId 索引的标题，批量合集卡需要 distinct 标题；之前漏回传导致 57 张卡都空标题。
    out.dyTitlesByAweme = (window.__hmdao_captures && window.__hmdao_captures.dyTitlesByAweme && typeof window.__hmdao_captures.dyTitlesByAweme === 'object')
      ? window.__hmdao_captures.dyTitlesByAweme : {};
    // ★2026-09-03：按 awemeId 索引的「视频轨直链」，供侧栏实时匹配当前集（切集后精确取本集 url）
    out.dyUrlsByAweme = (window.__hmdao_captures && window.__hmdao_captures.dyUrlsByAweme && typeof window.__hmdao_captures.dyUrlsByAweme === 'object')
      ? window.__hmdao_captures.dyUrlsByAweme : {};
    // ★2026-09-03：按 awemeId 索引的「绝对集数」（来自合集/列表 API 的数组顺序），确保标题=播放列表第 N 集
    out.dyEpisodeByAweme = (window.__hmdao_captures && window.__hmdao_captures.dyEpisodeByAweme && typeof window.__hmdao_captures.dyEpisodeByAweme === 'object')
      ? window.__hmdao_captures.dyEpisodeByAweme : {};
    // ★2026-09-04：合集 ID / 合集名回传，scan.js 批量模式据此判断是否在合集页，避免把 feed 脏数据当合集
    // ★2026-09-05：按 awemeId 索引的「所属合集 id」，供 scan.js 过滤非本合集的 feed 脏数据
    out.dyMixIdsByAweme = (window.__hmdao_captures && window.__hmdao_captures.dyMixIdsByAweme && typeof window.__hmdao_captures.dyMixIdsByAweme === 'object')
      ? window.__hmdao_captures.dyMixIdsByAweme : {};
    out.mixId = (window.__hmdao_captures && (window.__hmdao_captures.mixId || window.__hmdao_captures.mix_id)) || '';
    out.mixName = (window.__hmdao_captures && (window.__hmdao_captures.mixName || window.__hmdao_captures.mix_name)) || '';
    // ★2026-09-03：按 awemeId 索引的「音频轨直链」（切集后精确合成本集音画，无需时间配对）
    out.dyAudiosByAweme = (window.__hmdao_captures && window.__hmdao_captures.dyAudiosByAweme && typeof window.__hmdao_captures.dyAudiosByAweme === 'object')
      ? window.__hmdao_captures.dyAudiosByAweme : {};
    // ★2026-09-03：按 awemeId 索引的「视频轨直链」（来自详情 API play_addr，MSE 场景下 dyUrls 为空时的视频卡兜底源）
    out.dyVideoUrlByAweme = (window.__hmdao_captures && window.__hmdao_captures.dyVideoUrlByAweme && typeof window.__hmdao_captures.dyVideoUrlByAweme === 'object')
      ? window.__hmdao_captures.dyVideoUrlByAweme : {};
    // ★扩展（2026-08-01）：接口响应体视频直链（LiblibAI / 模型社区等动态视频站点）
    out.apiVideos = (window.__hmdao_captures && Array.isArray(window.__hmdao_captures.apiVideos))
      ? window.__hmdao_captures.apiVideos.slice(-100) : [];
    // ★2026-09-11：MAIN 世界捕获的「视频直链→结构化封面/标题」配对（inject-main 提取，多平台通用）。
    //   apiVideoPairs：视频直链→封面图 URL（已拒绝分片缩略图 404 路径）；apiVideoTitles：视频直链→标题文本。
    out.apiVideoPairs = (window.__hmdao_captures && window.__hmdao_captures.apiVideoPairs && typeof window.__hmdao_captures.apiVideoPairs === 'object')
      ? window.__hmdao_captures.apiVideoPairs : {};
    out.apiVideoTitles = (window.__hmdao_captures && window.__hmdao_captures.apiVideoTitles && typeof window.__hmdao_captures.apiVideoTitles === 'object')
      ? window.__hmdao_captures.apiVideoTitles : {};
    // ★爱给视频多分辨率：model-api-capture.js 在 aigei.com/video/* 页面被动捕获的画质版本
    out.aigeiVideos = (window.__hmdao_captures && Array.isArray(window.__hmdao_captures.aigeiVideos))
      ? window.__hmdao_captures.aigeiVideos.slice(-50) : [];
    // ★通用音频播放捕获（model-api-capture.js 全站 MAIN 钩子）：
    // 爱给等站预览用「游离 new Audio()」（不在 DOM）→ DOM 扫描抓不到；
    // webRequest 又受 SW 冷启动/memory cache 限制。页面全局 audioPlays 是最可靠来源。
    out.audioPlays = (window.__hmdao_captures && Array.isArray(window.__hmdao_captures.audioPlays))
      ? window.__hmdao_captures.audioPlays.slice(-200).filter((a) => {
          // 二次兜底：把混进来的图片/视频扩展名清掉（如 yunqiaowang 的 .jpg 被误当音频）
          try {
            const path = new URL(a.url).pathname.toLowerCase();
            if (/\.(jpg|jpeg|png|gif|webp|bmp|svg|ico|avif|apng|tif|tiff|mp4|webm|mov|m4v|mkv|ogv|m3u8|mpd|flv|avi|wmv|ts|3gp|f4v)(\?|#|$)/.test(path)) return false;
          } catch (_) {}
          return true;
        })
      : [];
    // ★豆包朗读音频（doubao-audio-capture.js，仅 doubao.com MAIN 世界）：
    // 页面 fetch/XHR 拉 TTS 字节或直接 <audio> 播放时旁路记录的直链（含 mime/大小/时间）。
    // 只在用户点扫描时读回，平时零开销。
    out.doubaoTts = (window.__hmdao_captures && Array.isArray(window.__hmdao_captures.doubaoTts))
      ? window.__hmdao_captures.doubaoTts.slice(-50).filter((a) => a && typeof a.url === 'string' && /^https?:/i.test(a.url))
        .map((a) => ({ url: a.url, mime: a.mime || '', how: a.how || '', size: Number(a.size) || 0, ts: Number(a.ts) || 0 }))
      : [];
    // ★豆包朗读 WS 音频流（wss://.../sami/voicegenie，ogg_opus）：只回传【元数据】。
    //   字节在用户点预览/下载时才取（HMDAO_GET_DOUBAO_WS_AUDIO），避免扫描时传大 base64 卡顿。
    out.doubaoWsAudio = (function () {
      const list = [];
      try {
        const c = window.__hmdao_captures;
        // ★按会话隔离：只回传当前会话（/chat/<id>）的朗读段
        //   → 新建任务/切聊天页后扫描不会再出现上个会话的音频卡；切回来又能读到。
        const key = (function () {
          try {
            const m = /\/chat\/(\d+)/.exec(location.pathname || '');
            return m ? m[1] : 'root';
          } catch (_) { return 'root'; }
        }());
        const bk = (c && c.doubaoTtsByChat && c.doubaoTtsByChat[key]) || null;
        const all = bk ? ((bk.list || []).concat(bk.cur ? [bk.cur] : [])) : [];
        for (let i = 0; i < all.length; i++) {
          const b = all[i];
          if (!b || Number(b.bytes) <= 512) continue;
          // done=false 表示【这段朗读还没结束】（WS 未关闭）→ 不生成卡片，
          // 等它播完/停止（WS 关闭）后下一次扫描才出现，符合"结束完成才成卡"。
          list.push({
            url: String(b.url || ''),
            bytes: Number(b.bytes) || 0,
            frames: Number(b.frames) || 0,
            ts: Number(b.ts) || 0,
            done: b.done === true,
          });
        }
      } catch (_) {}
      return list;
    }());
    // Performance 只读探针候选（豆包朗读可能不是 audio/* 响应头 → fetch 钩子按头判定会漏；
    // 候选由后台 Range GET 验魔数后才入库）
    out.doubaoTtsCandidates = (window.__hmdao_captures && Array.isArray(window.__hmdao_captures.doubaoTtsCandidates))
      ? window.__hmdao_captures.doubaoTtsCandidates.slice(-20)
        .filter((a) => a && typeof a.url === 'string' && /^https?:/i.test(a.url))
      : [];
    // model-api-capture.js（MAIN 世界）捕获的下载 API 模型/压缩包直链
    out.modelHits = Array.isArray(window.__hmdao_model_hits) ? window.__hmdao_model_hits.slice(-300) : [];
    // 迅雷网盘分享页 API 响应（文件列表 + file_info 直链）
    try {
      const xs = window.__hmdao_captures && window.__hmdao_captures.xunleiShare;
      if (xs && (xs.list && xs.list.length || xs.fileInfo && Object.keys(xs.fileInfo).length)) {
        out.xunleiShare = { list: xs.list || [], fileInfo: xs.fileInfo || {}, shareId: xs.shareId || '', passCodeToken: xs.passCodeToken || '', pwd: xs.pwd || '', ts: xs.ts || 0 };
      }
    } catch (_) {}
    // ★ 2026-08-09 新增：迅雷自己网盘 API 响应（文件列表 + download_url 直链）
    try {
      const md = window.__hmdao_captures && window.__hmdao_captures.xunleiMyDrive;
      if (md && (md.list && md.list.length || md.fileInfo && Object.keys(md.fileInfo).length)) {
        out.xunleiMyDrive = { list: md.list || [], fileInfo: md.fileInfo || {}, space: md.space || '', path: md.path || '', ts: md.ts || 0 };
      }
    } catch (_) {}
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
            const am = (o.awemeId != null) ? String(o.awemeId) : (o.aweme_id != null ? String(o.aweme_id) : '');
            if ((am && o.video && (o.video.play_addr || o.video.download_addr))) awemes.push(o);
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

