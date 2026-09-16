// =====================================================================
// scan.js — 素材采集核心（由 background.js importScripts 引入，与 SW 共享作用域）
//
// 仅依赖 SW 全局（importScripts 后可见）：
//   NETWORK_ASSETS / VIDEO_HOST_RE / POLL_TIMERS / HMDAO_MSG / chrome
//   extractFreshVideoUrl / readAllCapturesMAIN（MAIN 世界注入函数，由 background.js 定义，运行时引用）
// scanPage 是纯页面注入函数（经 chrome.scripting.executeScript 注入 ISOLATED 世界），
// 内部仅引用页面可访问的 window.HMDAO_MSG（由 content script 暴露）与 document / location。
// =====================================================================
/* global NETWORK_ASSETS, VIDEO_HOST_RE, POLL_TIMERS, HMDAO_MSG, extractFreshVideoUrl, readAllCapturesMAIN, forceYtBufferAndCapture */

// 当前扫描到的抖音/视频号目标 aweme_id，用于在 merge 时优先保留“当前播放/当前 modal”的视频。
let __hmdao_current_aweme_id = null;

// ★2026-09-05：每标签页上一次扫描到的合集 mixId —— 用于检测「切换合集」，
//   切合集时必须清空上一合集的全部累积（网络层资产 + 侧栏缓存 + MAIN 索引），
//   否则旧合集的卡片/封面会混进新合集侧栏并在新旧之间来回跳动。
const HMDAO_TAB_MIXID = {};

// ★2026-09-05：卡片标题去「第N集」前缀。集数已由 episodeNo 单独展示（卡面「第X集 · 标题」），
//   标题里再带一遍「第五十六集：」会与 episodeNo 并排出现两个集数字样（且历史数据两者还可能不一致）。
function stripEpisodePrefix(t) {
  return String(t || '').replace(/^第\s*(?:[0-9]{1,4}|[零〇一二两三四五六七八九十百]{1,6})\s*[集期话章回]\s*[:：、.\-—]?\s*/, '');
}

// ★2026-09-05：上一轮广播的内容签名。内容无变化时跳过 SCAN_RESULT 广播 ——
//   否则每 10s 轮询都全量广播上百条资产（含长签名直链）→ 消息序列化 + 侧栏全量处理 +
//   lastScan 重持久化 + 渲染抖动 → 十几分钟后侧栏与源页明显卡顿。
let HMDAO_LAST_BCAST_SIG = '';

// ★2026-09-04 日志节流（用户实测侧栏 DevTools 堆积 28,941 条消息）：
//   轮询每 10s 一次，同样的日志行反复刷，几小时就是几万条 —— 开着 DevTools 会明显卡顿，
//   且 console 持有对象引用造成内存膨胀。同一 key 只在【内容变化】时打印一次，未变则静默。
const __hmdaoLogMemo = new Map();
function logOnChange(key, msg) {
  try {
    if (__hmdaoLogMemo.get(key) === msg) return;
    __hmdaoLogMemo.set(key, msg);
  } catch (_) {}
  console.log(msg);
}

// ★2026-08-23 修复：每张抖音卡片用自己反查出的真实 awemeId 构造唯一稳定的播放地址
//   https://www.douyin.com/video/<awemeId>（抖音每个视频唯一独立页）。
//   —— 点哪张卡片就开哪张视频，绝不错配（不用页面级统一 modal_id，否则所有卡片跳同一视频）。
//   该地址为抖音自家页面，<video> 能正常播放（侧栏内 CDN 403 无法播，故切源页）。
function douyinPlayerUrl(aid, sourceTabUrl) {
  const a = (aid && aid !== 'unknown') ? String(aid) : '';
  if (!a) return '';
  // ★2026-08-31 分平台：TikTok 国际版用 tiktok.com/video/<id>（无 @user 前缀亦可跳独立播放页）；
  //   抖音国内版用 douyin.com/video/<id>。按源页域名判定，避免 TikTok 卡片跳到 douyin 死链。
  const isTikTok = /tiktok\.com/i.test(sourceTabUrl || '');
  return isTikTok ? ('https://www.tiktok.com/video/' + a) : ('https://www.douyin.com/video/' + a);
}

// 网盘分享链接识别正则（全局复用，scanTab 与 scanPage 共用）。
// ★ 2026-08-09 修复：原正则只匹配 pan.xunlei.com/s/（分享态），导致用户转存到自己网盘后
//    的 pan.xunlei.com/?path=... 页面不被识别为网盘，文件被误判为 archive。
//    现在 pan.xunlei.com 整站均视为网盘（分享态 + 自己网盘）。
const NETDISK_RE = /(pan\.baidu\.com\/s\/|lanzou[s]?\.com|lanzaou\.com|quark\.cn|pan\.quark\.cn|pan\.xunlei\.com(\/s\/|\/?\?|$)|123pan\.com|aliyundrive\.com|weiyun\.com|cowtransfer\.com|ctfile\.com|mediafire\.com|mega\.nz|drive\.google\.com\/file|dropbox\.com\/s|terabox|pcloud)/i;

// 视频平台 URL 归一化（用于去重）：移除签名/时间戳等查询参数，保留协议+主机+路径。
function normalizeVideoUrl(url) {
  try {
    if (!url || typeof url !== 'string') return url || '';
    const u = new URL(url);
    // 对抖音/新片场/YouTube/B站等播放页或 CDN 直链，签名参数不同导致同一视频被当成多条素材。
    const host = u.hostname.toLowerCase();
    const isPlatform = /douyin|iesdouyin|tiktok|bytedance|xinpianchang|youtube|youtu|bilibili|bilivideo|b23\.tv|youku|qq\.com|iqiyi|ixigua|sohu|tudou|kuaishou|acfun|haokan|baidu/i.test(host);
    if (!isPlatform) return url;
    // 保留路径，但移除查询参数和 hash（不同签名/清晰度参数的同一视频归一）
    return u.origin + u.pathname;
  } catch (_) { return url || ''; }
}

// 判断 playerUrl 是否包含明确视频 ID（如抖音 modal_id / 新片场 a12345），
// 只有含 ID 时才按 playerUrl 去重，避免信息流页把不同视频误合并。
function playerUrlHasVideoId(playerUrl) {
  return /modal_id=|\/a\d+|\/video\/\d+|\/x\/|\/av\d+/i.test(playerUrl || '');
}

// ★2026-09-01 修复（music.douyin.com/studio 卡片链接回退根因）：
//   与 inject-main __hmdao_isDouyinExcluded 对齐。studio/creator/notice/live-studio 等非播放页
//   此前未被 scanTab 排除，扫描会产出 "playerUrl 回退成 studio URL" 的资产（aid 为空）→ 侧栏出现
//   指向 music.douyin.com/studio 的卡。这里提前 return（并广播空结果让侧栏清空残留）。
function isDouyinExcludedUrl(url) {
  try {
    const u = new URL(url);
    const h = u.hostname, p = u.pathname;
    if (h === 'music.douyin.com') return true;
    if (h !== 'www.douyin.com' && h !== 'm.douyin.com') return false;
    if (/^\/studio(\/|$)/.test(p)) return true;
    if (/^\/creator(\/|$)/.test(p)) return true;
    if (/^\/notice(\/|$)/.test(p)) return true;
    if (/^\/live\/studio(\/|$)/.test(p)) return true;
  } catch (_) {}
  return false;
}

// 同 key 下保留「信息更完整」的那条资产；若已知抖音/视频号当前 aweme_id，
// 优先保留匹配当前 modal/播放的视频，避免信息流预加载的其它视频被选中。
function preferAsset(a, b) {
  if (!b) return true;
  const score = (x) => {
    let s = 0;
    if (__hmdao_current_aweme_id && x.awemeId === __hmdao_current_aweme_id) s += 2000; // 当前目标视频
    if (x.matched) s += 500;          // RENDER_DATA 精确匹配的视频
    if (x.source === 'deep-parse') s += 100; // 深度解析结果优先于脚本抓取
    if (x.playerUrl) s += 100;        // 有平台播放页 → 可走 yt-dlp
    if (x.title && !/^stream-/i.test(x.title)) s += 50;
    if (x.coverUrl || x.cover) s += 30;
    if (x.width && x.height) s += 20;
    if (x.name && !/^stream-/i.test(x.name)) s += 10;
    // ★2026-09-08 修复（imini 视频卡选到「被截断 URL」的根因之一）：
    //   score 此前只看元数据（awemeId/matched/playerUrl/title/cover…），【完全不看 URL 是否完整】
    //   → 一条"元数据更全但 URL 被截断"的候选会赢过"URL 完整"的候选，
    //   侧栏 <video src> 指向 NoSuchKey 的残片 → 无画面也无声音。
    //   给「URL 完整（有媒体扩展名 / 可交 yt-dlp 解析的平台页 / blob / DASH）」加权，
    //   使其高于 cover(+30)/title(+50)/playerUrl(+100) 之和。
    if (x.type === 'video' && isCompleteVideoUrl(x)) s += 300;
    return s;
  };
  return score(a) > score(b);
}

// ===== 视频 URL 完整性判定（防御"被截断/选中不完整候选"）=====
// ★2026-09-08（imini.ai 视频卡 URL 被截断 → 对象存储 NoSuchKey、预览无声音）：
//   现象：侧栏 <video src> = https://file.iminicdn.com/file/2026/06/04/206250370317222297
//   （无媒体扩展名、比真实文件 .../2062503703172222976_vHi9PU4CtCf3.mp4 明显短一截）。
//   成因两条：① 提取阶段正则漏/截断（内联 JSON 里的 .mp4 后紧跟引号 → 旧 script 正则永不命中；
//      attr / <video src> 等来源又不校验扩展名，半截 URL 也能被推成 video 资产）；
//   ② 合并阶段 preferAsset 不比较 URL 完整度。
//   这里做最后一道防御。
const VIDEO_MEDIA_EXT_RE = /\.(mp4|webm|mov|m4v|mkv|ogv|m3u8|flv|avi|wmv|ts|mpg|mpeg|3gp|rm|rmvb|asf|vob|m2ts|f4v|m4s)([?#]|$)/i;

function isCompleteVideoUrl(a) {
  const u = String((a && a.url) || '').split('#')[0];
  if (!u) return false;
  if (/^blob:/i.test(u)) return true;                      // 源页 MSE：交给源页播放，不算残片
  if (VIDEO_MEDIA_EXT_RE.test(u)) return true;             // 明确媒体扩展名
  if (a && a.__dash) return true;                          // DASH 音视频轨结构
  // yt-dlp 平台卡：url 常常【就是】播放页地址（generic 卡 url===playerUrl），本身没有媒体扩展名，
  // 但它会交给 yt-dlp 解析出真正可播的合并流（imini 这类站唯一"有声音"的入口就在yt-dlp），
  // 故只要有 playerUrl 一律视为完整，绝不按残片丢弃。
  if (a && a.playerUrl) return true;
  return false;
}

// 丢弃「被截断」的 video 候选。安全边界（必须遵守，否则会误杀真实无扩展名直链）：
//   · 只有在【同源存在完整候选】时才可能丢弃；没有任何完整候选 → 一条都不动（绝不整页视频消失）
//   · googlevideo / douyinvod / m3u8 / blob 等无扩展名的真实直链由 isCompleteVideoUrl 放行
//   · 能配对到完整候选时，先把封面/标题/时长过继给完整候选再丢弃，避免"修好了 URL 却丢了封面"
function dropTruncatedVideoAssets(list) {
  try {
    const src = list || [];
    const vids = src.filter((a) => a && a.type === 'video' && /^https?:/i.test(String(a.url || '')));
    if (vids.length < 2 || vids.length > 500) return src;
    const complete = vids.filter(isCompleteVideoUrl);
    if (!complete.length) return src;
    const originOf = (u) => { try { return new URL(u).origin; } catch (_) { return ''; } };
    // 同源完整候选长度中位数 → 判定"明显短于同源其它候选"
    const lenByOrigin = new Map();
    for (const c of complete) {
      const o = originOf(c.url);
      if (!lenByOrigin.has(o)) lenByOrigin.set(o, []);
      lenByOrigin.get(o).push(String(c.url).length);
    }
    const median = (arr) => {
      const s = (arr || []).slice().sort((x, y) => x - y);
      return s.length ? s[Math.floor(s.length / 2)] : 0;
    };
    const drop = new Set();
    for (const a of vids) {
      if (isCompleteVideoUrl(a)) continue;
      const u = String(a.url);
      // ① 是某条完整候选的【前缀】→ 典型截断（...222297 是 ...2222976_vHi9PU4CtCf3.mp4 的前缀）
      let host = null;
      for (const c of complete) {
        const cu = String(c.url);
        if (cu.length - u.length >= 3 && cu.indexOf(u) === 0) { host = c; break; }
      }
      // ② 无媒体扩展名且长度明显短于同源完整候选的中位数（<70%）→ 判为残片
      if (!host) {
        const med = median(lenByOrigin.get(originOf(u)));
        if (!(med > 0 && u.length < med * 0.7)) continue;
      }
      if (host) {
        if (!host.cover && a.cover) host.cover = a.cover;
        if (!host.title && a.title) host.title = a.title;
        if (!host.duration && a.duration) host.duration = a.duration;
      }
      drop.add(a);
    }
    if (!drop.size) return src;
    console.log('[HMDAO][scan] 丢弃被截断/无媒体扩展名的视频候选 %d 条（同源存在更完整候选）', drop.size);
    return src.filter((a) => !drop.has(a));
  } catch (_) { return list; }
}

// ★2026-09-02：抖音 DASH 音视频轨配对。
//   inject-main 把视频轨存 dyUrls（配 dyUrlTs 时间戳、dyAwemes 的 awemeId），
//   音频轨单独存 dyAudios[{url, ts, awemeId}]（绝不进 dyUrls，否则会变成"只有声音没画面"的卡）。
//   配对规则：① 同 awemeId 精确命中优先；② 否则取 |Δts| 最小且未被占用的音频轨（时间邻近）。
//   实测依据：同一视频的两轨相差 35~45ms，切换视频间隔数秒，按此规则不会串台
//   （见 scripts/verify-douyin-audio-track-capture.mjs 的 6/7 项断言）。
function pairDouyinDashAudio(dyUrls, dyUrlTs, dyAudios, dyAwemes) {
  const audios = Array.isArray(dyAudios) ? dyAudios : [];
  const urls = Array.isArray(dyUrls) ? dyUrls : [];
  const used = new Set();
  return urls.map((u, i) => {
    const vTs = (dyUrlTs && dyUrlTs[i]) || 0;
    const aid = (dyAwemes && dyAwemes[i]) || '';
    let idx = -1;
    // ① 同 awemeId 精确命中
    if (aid && aid !== 'unknown') {
      for (let j = 0; j < audios.length; j++) {
        const a = audios[j];
        if (used.has(j) || !a || !a.awemeId) continue;
        if (String(a.awemeId) === String(aid)) { idx = j; break; }
      }
    }
    // ② 时间邻近兜底
    if (idx < 0) {
      let best = -1;
      let bestDelta = Infinity;
      for (let j = 0; j < audios.length; j++) {
        if (used.has(j) || !audios[j]) continue;
        const d = Math.abs((audios[j].ts || 0) - vTs);
        if (d < bestDelta) { bestDelta = d; best = j; }
      }
      // 超过 10 秒视为不同播放会话，不强行配对（避免把上一个视频的音轨配给下一个）
      idx = bestDelta <= 10000 ? best : -1;
    }
    if (idx >= 0) used.add(idx);
    return idx >= 0 ? audios[idx] : null;
  });
}

// 扫描单个标签页：深度直链解析（B：网络层捕获 + MAIN 世界直链 + YouTube 缓冲补全） + 页面 DOM 解析（A）。
// 合并去重后回写 NETWORK_ASSETS 并广播 SCAN_RESULT 给侧栏。
// ★2026-09-05：每 tab 扫描串行化。此前轮询每 10s 直接调 scanTab，而一轮深度扫描要
//   3~8s（RENDER_DATA 等待 ≤3s + 多次 executeScript + DOM 解析 + 深度直链解析）→
//   上一轮没跑完下一轮又起 → 扫描在 SW 与源页里叠加堆积 → 十几分钟后侧栏与源页
//   都异常卡顿、点刷新半天没反应。改为：同一 tab 上一轮未结束（45s 看门狗）则跳过本轮。
const HMDAO_SCAN_RUNNING = new Map();
async function scanTab(tabId, opts = {}) {
  const startedAt = HMDAO_SCAN_RUNNING.get(tabId) || 0;
  if (startedAt && Date.now() - startedAt < 45000) {
    console.log('[HMDAO][scan] 上一轮扫描未结束，跳过本轮（防叠加卡顿） tabId=%s', tabId);
    return NETWORK_ASSETS[tabId] || [];
  }
  HMDAO_SCAN_RUNNING.set(tabId, Date.now());
  try {
    return await scanTabInner(tabId, opts);
  } finally {
    HMDAO_SCAN_RUNNING.delete(tabId);
  }
}

async function scanTabInner(tabId, opts = {}) {
  const deep = opts.deep !== false; // 默认深度：首扫跑各站直链主动解析（B），轮询走轻量
  const batchMode = !!opts.batchMode; // ★2026-08-22 信息流批量采集：true 时采集合集多视频而非单卡
  let networkAssets = [];
  let ytPlay = [];
  __hmdao_current_aweme_id = null; // 每次扫描重置当前抖音/视频号目标 ID
  // ★2026-09-07 修复（「重新扫描」按钮偶发清空后不再回填）：force 时清空广播签名，
  //   强制本次扫描结果一定广播出去（不命中 bcastSig 静默跳过），保证手动重扫必定重新采集当前页。
  if (opts.force) {
    HMDAO_LAST_BCAST_SIG = '';
    // ★2026-09-07 补充（重新扫描仍有残留根因）：force 重扫同时清空该 tab 的网络层累计资产。
    //   否则 SPA 站内切模型/合集时，上一轮网络捕获的视频/音频流(googlevideo/bilivideo/音频)仍驻留
    //   NETWORK_ASSETS，会被本轮深度扫描一并并入 → 侧栏出现"上一页"的幽灵卡。清掉后本轮只采当前页。
    try { NETWORK_ASSETS[tabId] = []; } catch (_) {}
  }

  // ===== 记录目标标签页 URL，后续合并与网盘兜底均需要 =====
  let targetTabUrl = '';
  let targetTabTitle = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    targetTabUrl = (tab && tab.url) || '';
    targetTabTitle = (tab && tab.title) || '';
  } catch (_) {}

  // ★2026-08-31 修复（严格遵守边界要求——"不得引发控制台报错"）：
  //   chrome:// / edge:// / about: / 扩展库 / 新标签页 等【浏览器内部页面不可被脚本化】，
  //   此前 scanTab 仍会尝试 executeScript 注入 → 抛 "The extensions gallery cannot be scripted."
  //   → 控制台多条红色报错 + 无意义的扫描开销。现【提前静默返回】，不做任何注入、不打 warn。
  if (!targetTabUrl || /^(chrome|edge|about|devtools|chrome-extension|edge-extension|view-source|file):/i.test(targetTabUrl)) {
    console.log('[HMDAO][scan] 跳过不可脚本化页面（浏览器内部页）：', (targetTabUrl || '(空)').slice(0, 80));
    return;
  }

  // ★2026-09-01：抖音非播放页（studio/creator/notice/live-studio）直接跳过，避免产出 studio URL 卡片；
  // 并广播空结果让侧栏清空此前残留（切站/切回主页时不再滞留旧链接记录）。
  if (isDouyinExcludedUrl(targetTabUrl)) {
    console.log('[HMDAO][scan] 跳过抖音非播放页（studio/creator 等）：', (targetTabUrl || '').slice(0, 80));
    try { chrome.runtime.sendMessage({ type: HMDAO_MSG.SCAN_RESULT, tabId, url: targetTabUrl, assets: [], batchMode: !!batchMode }).catch(() => {}); } catch (_) {}
    return;
  }

  // ★2026-08-23 修复（"刷新/切 tab 清空丢失累积"根因闭环）：
  //   源页累积（dyUrls/dyCovers/dyAwemes）的清空职责**完全下放给 inject-main 的 SPA 导航钩子**
  //   （__hmdao_onNav 仅在 URL 真正变化时清空，见 inject-main.js:92-107）。scanTab **不再无条件清空**，
  //   否则用户在同 URL 刷新/切回标签页时，正在累积的 dyUrls 被抹掉 → 采不到 → 卡片消失。
  //   仅当本次扫描的页面 URL 与上次记录不同（真正换页/切集）时，才主动清空源页累积，避免旧 modal 残留。
  //   注意：必须在 targetTabUrl 赋值之后访问（避免 TDZ），本段即置于 103 行获取 targetTabUrl 之后。
  let prevUrl = '';
  try { prevUrl = (NETWORK_ASSETS_URL && NETWORK_ASSETS_URL[tabId]) || ''; } catch (_) { }
  const isSameUrl = !!prevUrl && prevUrl === (targetTabUrl || '');
  if (!isSameUrl) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: false }, world: 'MAIN',
        func: () => { try { window.__hmdao_clearCaptures && window.__hmdao_clearCaptures(); } catch (_) {} },
      });
    } catch (_) { /* 非抖音/未就绪页面忽略 */ }
    // ★2026-09-05 关键修复：换页/切集时 background 的 NETWORK_ASSETS 也必须清空，
    //   否则旧页的网络层捕获（audio/video）会混入新页扫描结果 → 侧栏出现"别的合集/上一页"的幽灵卡。
    NETWORK_ASSETS[tabId] = [];
    // 持久化侧栏缓存也一并清空，避免侧栏重载后先显示旧素材
    try { chrome.storage.local.set({ lastScan: { assets: [], tabId, ts: Date.now() } }); } catch (_) {}
    HMDAO_LAST_BCAST_SIG = ''; // 换页后允许重新广播
    console.log('[HMDAO][scan] scanTab 换页清空源页累积+网络层资产 tabId=%s prev=%s now=%s', tabId, prevUrl, targetTabUrl);
  } else {
    console.log('[HMDAO][scan] scanTab 同页扫描，保留源页累积（不清空）tabId=%s url=%s', tabId, targetTabUrl);
  }
  // 同页扫描时保留 NETWORK_ASSETS[tabId] 的累积：扫描结果最终由 finalMerged 整体覆盖；换页时已清空。

  // ===== B站播放页：纯旁观模式（不干扰播放器，保声音）=====
  // 根因：此前 scanTab 在 B站播放页仍注入 scanPage(ISOLATED) + extractFreshVideoUrl(MAIN) +
  // scanApiVideoUrls(MAIN)。其中 extractFreshVideoUrl 在播放页读取 __INITIAL_STATE__ 并触发 WBI
  // playurl/nav 请求，scanPage 扫描到播放器 <video src=blob> 与首帧预览图 → 既干扰 SPA 播放器
  // （导致有画面无声音），又产出"asset/home/all/frame/v2/40"等伪素材、多条同一视频的卡片。
  // 修复：B站播放页【只】做两件事——
  //   1) extractVideoCovers（只读 videoData.pic，零副作用）拿封面；
  //   2) 合并网络层被动捕获的 bilivideo 直链（background 层 passive 捕获，绝不碰播放器），
  //      并去重为「单条」视频（最高画质视频轨），不再把音频流/不同 itag 当成多个素材。
  // 不跑 scanPage / extractFreshVideoUrl / scanApiVideoUrls，彻底避免声音与伪素材问题。
  let isBiliPlay = false;
  let biliPlayUrl = '';
  try {
    const u = targetTabUrl;
    isBiliPlay = /bilibili\.com\/(video|blackboard\/.*play|festival)\//i.test(u) || /b23\.tv\//i.test(u);
    if (isBiliPlay) biliPlayUrl = u;
  } catch (_) {}

  // ★2026-08-23 修复（致命执行顺序 bug，问题2/3 根因）：
  //   pageCurAwemeId / curVideoSrc 此前定义在下方 extractVideoCovers 之后的第 593 行，
  //   但 readMainCaptures 函数体（下方第 272 行）在 `await readMainCaptures()` 时【先执行】，
  //   彼时 `let pageCurAwemeId` 尚未执行 → TDZ ReferenceError → 整个 dyUrls 合并逻辑被
  //   第 368 行 catch 吞掉 → 抖音 dyUrls 从未进 networkAssets → 刷新后扫描不到正确 url。
  //   修复：把读取提前到 readMainCaptures 之前，消除 TDZ 与执行顺序依赖。
  let curVideoSrc = '';
  let pageCurAwemeId = '';
  let pageMixId = '';
  try {
    const srcRes = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: () => ({
        curVideoSrc: (window.__hmdao_captures && window.__hmdao_captures.curVideoSrc) || '',
        curAwemeId: (window.__hmdao_captures && window.__hmdao_captures.curAwemeId) || '',
        mixId: (window.__hmdao_captures && window.__hmdao_captures.mixId) || '',
      }),
    });
    const r = (srcRes && srcRes[0] && srcRes[0].result) || {};
    curVideoSrc = r.curVideoSrc || '';
    pageCurAwemeId = (r.curAwemeId || '').replace(/[^\w]/g, '');
    pageMixId = (r.mixId || '').replace(/[^\w]/g, '');
  } catch (_) {}

  // ★2026-09-05 修复（切换合集后卡片封面在新旧封面间来回跳动 + 串合集卡根因）：
  //   抖音 jingxuan 切合集只变 modal_id（同 pathname），上面按 URL 判定的「换页清空」虽会触发，
  //   但 inject-main 的「同页切集保留索引」会把上一合集的封面/标题/集数/直链全部留着 →
  //   新合集首轮扫描把两合集数据混播，之后才慢慢收敛。这里按 mixId 变化兜底：
  //   mixId 变了 = 换了合集 → 清空网络层资产 + 侧栏缓存 + MAIN 世界上一合集索引。
  try {
    const prevMix = HMDAO_TAB_MIXID[tabId] || '';
    if (prevMix && pageMixId && String(prevMix) !== String(pageMixId)) {
      NETWORK_ASSETS[tabId] = [];
      try { chrome.storage.local.set({ lastScan: { assets: [], tabId, ts: Date.now() } }); } catch (_) {}
      try {
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: false }, world: 'MAIN',
          func: () => { try { window.__hmdao_reset_collection_index && window.__hmdao_reset_collection_index(); } catch (_) {} },
        });
      } catch (_) {}
      console.log('[HMDAO][scan] 检测到切换合集 mixId %s → %s，已清空上一合集累积', prevMix, pageMixId);
    }
    if (pageMixId) HMDAO_TAB_MIXID[tabId] = pageMixId;
  } catch (_) {}

  // 读取 MAIN 世界被动捕获（YouTube/抖音/B站/通用音频/3D模型的真实直链）
  const readMainCaptures = async () => {
    try {
      let injected = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: readAllCapturesMAIN,
      });
      var mainRes = injected && injected[0] && injected[0].result;
      // 迅雷分享页：文件列表 API 可能是懒加载，首次没读到就等 1.5s 重读一次。
      // 同时：顶层列表只有文件夹、子文件夹内容靠 BFS 异步展开（enterXunleiFolder）。
      // 扫描必须在 BFS 展开完成后再读取 xs.list，否则只会看到顶层文件夹（被跳过）→ 0 素材。
      const isXunleiMyDriveUrl = /pan\.xunlei\.com\?.*\bpath=/i.test(targetTabUrl || '');
      if (/pan\.xunlei\.com\/s\//i.test(targetTabUrl || '') || isXunleiMyDriveUrl) {
        const waitXunleiExpanded = async () => {
          let expanded = {};
          for (let round = 0; round < 8; round++) {
            const snap = await chrome.scripting.executeScript({
              target: { tabId },
              world: 'MAIN',
              func: readAllCapturesMAIN,
            });
            // ★ 2026-08-09 新增：自己网盘页单独处理
            if (isXunleiMyDriveUrl) {
              const md = snap && snap[0] && snap[0].result && snap[0].result.xunleiMyDrive;
              if (md && md.list && md.list.length) break; // 已捕获到文件列表
              // 未捕获则触发兜底抢救
              try {
                await chrome.scripting.executeScript({
                  target: { tabId }, world: 'MAIN',
                  func: function () { if (window.__hmdao_xunlei_mydrive_salvage) window.__hmdao_xunlei_mydrive_salvage(); },
                });
              } catch (e) { /* 忽略 */ }
              await new Promise((r) => setTimeout(r, 1200));
              continue;
            }
            const xs = snap && snap[0] && snap[0].result && snap[0].result.xunleiShare;
            if (!xs || !xs.list || !xs.list.length) { await new Promise((r) => setTimeout(r, 1200)); continue; }
            // 找出尚未展开过的文件夹
            const folders = xs.list.filter(function (f) { return f && f.isDir && f.id && !expanded[f.id]; });
            if (!folders.length) break; // 没有新文件夹需要展开 → 展开完成
            // 逐个主动展开（MAIN 世界复用页面鉴权上下文）
            for (const f of folders) {
              expanded[f.id] = true;
              try {
                await chrome.scripting.executeScript({
                  target: { tabId },
                  world: 'MAIN',
                  func: function (folderId) { return window.__hmdao_xunlei_enter_folder(folderId); },
                  args: [f.id],
                });
              } catch (e) { /* 展开失败继续 */ }
            }
            await new Promise((r) => setTimeout(r, 1500)); // 等 BFS 内部请求与子文件夹入队
          }
        };
        const hasXunleiList = (mainRes && mainRes.xunleiShare && mainRes.xunleiShare.list && mainRes.xunleiShare.list.length) ||
                              (mainRes && mainRes.xunleiMyDrive && mainRes.xunleiMyDrive.list && mainRes.xunleiMyDrive.list.length);
        if (!hasXunleiList) {
          await new Promise((r) => setTimeout(r, 1500));
        }
        await waitXunleiExpanded();
        // 迅雷分享页使用虚拟滚动，先触发 DOM 滚动扫描，让全部文件行渲染并进入捕获
        try {
          const scanRes = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: function () {
              if (typeof window.__hmdao_xunlei_scan_dom === 'function') return window.__hmdao_xunlei_scan_dom();
              return { error: 'scanXunleiDom not found' };
            },
          });
          try { console.log('[HMDAO][scan] xunlei dom scan result', scanRes && scanRes[0] && scanRes[0].result); } catch (_) {}
        } catch (e) { /* 忽略 */ try { console.log('[HMDAO][scan] xunlei dom scan error', e && e.message); } catch (_) {} }
        await new Promise((r) => setTimeout(r, 1200));
        injected = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: readAllCapturesMAIN,
        });
        mainRes = injected && injected[0] && injected[0].result;

        // ★ 2026-08-09 兜底：自己网盘页若 MAIN 世界未捕获到（老标签 / 钩子未装），
        // 直接由 background 代理主动拉取文件树，写回 xunleiMyDrive 供下方资产生成逻辑使用。
        if (isXunleiMyDriveUrl && (!mainRes || !mainRes.xunleiMyDrive || !mainRes.xunleiMyDrive.list || !mainRes.xunleiMyDrive.list.length)) {
          try {
            const proxyTree = await fetchXunleiMyDriveTreeViaProxy(targetTabUrl);
            if (proxyTree && proxyTree.ok && proxyTree.md && proxyTree.md.list.length) {
              console.log('[HMDAO][scan] 自己网盘代理兜底下拉到', proxyTree.md.list.length, '个文件');
              if (!mainRes) mainRes = {};
              mainRes.xunleiMyDrive = proxyTree.md;
            } else {
              console.log('[HMDAO][scan] 自己网盘代理兜底失败:', proxyTree && proxyTree.error);
            }
          } catch (e) { console.log('[HMDAO][scan] 自己网盘代理兜底异常', e && e.message); }
        }
      }
      if (mainRes) {
        if (Array.isArray(mainRes.videoPlays)) networkAssets.push(...mainRes.videoPlays);
        // ★2026-09-06 修复：readAllCapturesMAIN 回传的 audioPlays 条目只有 {url,path,how,ts}、
        //   【没有 type 字段】→ scanPage 的 push(url, type, source) 把 type 落成 undefined
        //   → 合并阶段「非 media/model/image/archive/netdisk/link 一律丢弃」被整条丢掉，
        //   通用音频播放捕获（爱给/豆包等）此前实际从未生效。此处显式补 type/source。
        if (Array.isArray(mainRes.audioPlays)) {
          // ★2026-09-11 修复（B站 index-legacy-de44e0de.js 等静态资源被当音频）：
          //   音频捕获会把「页面里 fetch/XHR 过的任意 https 响应」记录为 audioPlays，其中混入
          //   .js/.css/.json 等非媒体资源 → 侧栏出现「拿 JS 文件当音频播放」的废卡，且污染资产列表。
          //   这里按扩展名硬性排除非媒体 URL（仅放行音视频/无扩展名的直链），从源头杜绝。
          const NON_MEDIA_RE = /\.(js|mjs|cjs|jsx|ts|tsx|css|json|html|htm|xml|php|svg|woff2?|ttf|eot|map|wasm|png|jpg|jpeg|gif|webp|ico|txt|md)(\?|#|$)/i;
          networkAssets.push(...mainRes.audioPlays
            .filter((x) => x && typeof x.url === 'string' && /^https?:/i.test(x.url) && !NON_MEDIA_RE.test(x.url))
            .map((x) => ({ url: x.url, type: 'audio', source: 'audio-playback' })));
        }
        // ★2026-09-06 豆包（doubao.com）朗读音频：doubao-audio-capture.js 在 MAIN 世界
        //   旁路记录 TTS 直链（fetch/XHR 响应头 audio/* 或音频扩展名 + <audio> 播放）。
        //   带 platform/playerUrl/title，让侧栏卡片可识别来源、文件名带会话名。
        if (Array.isArray(mainRes.doubaoTts) && mainRes.doubaoTts.length) {
          const ttsBase = (function () {
            let t = String(targetTabTitle || '').replace(/^\s*豆包\s*[-—|]\s*/, '').replace(/\s*[-—|]\s*豆包\s*$/, '').trim();
            if (!t || /^豆包$|新对话|有什么我能帮你的吗/.test(t)) t = '';
            return t ? (t + ' · 豆包朗读') : '豆包朗读';
          }());
          const seenTts = new Set();
          mainRes.doubaoTts.forEach((x, i) => {
            if (!x || typeof x.url !== 'string' || !/^https?:/i.test(x.url)) return;
            if (seenTts.has(x.url)) return;
            seenTts.add(x.url);
            networkAssets.push({
              url: x.url,
              type: 'audio',
              source: 'doubao-tts',
              platform: 'doubao',
              playerUrl: targetTabUrl || undefined,
              // 多段朗读时按序号区分，避免多张卡同名同 key
              title: mainRes.doubaoTts.length > 1 ? (ttsBase + ' ' + (i + 1)) : ttsBase,
              mime: x.mime || '',
              size: Number(x.size) || 0,
            });
          });
          console.log('[HMDAO][scan] 豆包朗读音频并入:', mainRes.doubaoTts.length, '条');
        }
        // ★2026-09-06 豆包朗读【WS 流式音频】（wss://.../sami/voicegenie，ogg_opus）：
        //   SDK 静态分析已证实无 HTTP 直链、无 <audio>、不走 decodeAudioData。
        //   doubao-audio-capture.js 旁路收集了 WS 下发的原始音频字节（留在源页，不随扫描传输），
        //   这里只产出一张带 wsAudio/wsTs 标记的卡片；预览/下载时经 HMDAO_GET_DOUBAO_WS_AUDIO 取字节。
        //   url 用伪协议（不可 fetch），避免任何代码把它当直链去请求。
        if (Array.isArray(mainRes.doubaoWsAudio) && mainRes.doubaoWsAudio.length) {
          const wsBase = (function () {
            let t = String(targetTabTitle || '').replace(/^\s*豆包\s*[-—|]\s*/, '').replace(/\s*[-—|]\s*豆包\s*$/, '').trim();
            if (!t || /^豆包$|新对话|有什么我能帮你的吗/.test(t)) t = '';
            return t ? (t + ' · 豆包朗读') : '豆包朗读';
          }());
          // 标题带上【朗读开始时间 HHMMSS】：
          //   ① 同一会话多次朗读可区分；② 跨会话切换时，即便豆包 tab 标题没跟着变
          //      （实测豆包标题切换有延迟/可能不变），两张卡也能靠时间一眼分辨，不会混淆。
          //   用纯数字而非 HH:MM:SS —— 冒号会被文件名 sanitize 处理掉，数字更安全。
          const wsTime = (ts) => {
            try {
              const d = new Date(Number(ts) || Date.now());
              const p = (n) => String(n).padStart(2, '0');
              return p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
            } catch (_) { return ''; }
          };
          const wsSeen = new Set();
          mainRes.doubaoWsAudio.forEach((x, i) => {
            // ★只认【已完成】的朗读段（WS 已关闭 = 播完/已停止）。
            //   正在朗读中的段（done=false）不生成卡片，避免"还没读完就冒出一张残缺卡"。
            // ★朗读失败（0KB / 只有几十字节的信令）一律不生成卡片：阈值 4KB
            //   （opus 32kbps 约 4KB/秒，低于 4KB 基本是空文件或握手失败产物）。
            if (!x || Number(x.bytes) < 4096 || !x.ts || x.done !== true) return;
            const key = 'ws:' + x.ts;
            if (wsSeen.has(key)) return;
            wsSeen.add(key);
            networkAssets.push({
              url: 'doubao-ws-audio://' + x.ts,
              type: 'audio',
              source: 'doubao-ws',
              platform: 'doubao',
              playerUrl: targetTabUrl || undefined,
              title: wsBase + ' ' + (wsTime(x.ts) || String(Number(x.ts) || '').slice(-6)),
              wsAudio: true,
              wsTs: Number(x.ts) || 0,
              size: Number(x.bytes) || 0,
              mime: 'audio/ogg',
            });
          });
          console.log('[HMDAO][scan] 豆包 WS 朗读音频并入:', mainRes.doubaoWsAudio.length, '段');
        }
        // ★豆包候选验证：Performance 只读探针抓到的「大响应 URL」（可能不是 audio/* 响应头），
        //   交后台 Range GET 前 64 字节验魔数，命中音频才入 NETWORK_ASSETS 并自动重扫。
        //   异步执行不阻塞扫描；每个 URL 只验证一次；每轮最多 3 条 → 零卡顿边界。
        if (Array.isArray(mainRes.doubaoTtsCandidates) && mainRes.doubaoTtsCandidates.length
            && !mainRes.doubaoTts.length && /doubao\.com/i.test(targetTabUrl || '')) {
          verifyDoubaoAudioCandidates(tabId, mainRes.doubaoTtsCandidates).catch(() => {});
        }
        // ★修复：抖音 MAIN 世界已捕获的 CDN 直链（dyUrls）此前没回传 → 抖音视频采不到。
        // 这里并入 networkAssets，合并阶段按 type==='video' 智能保留（不再被 VIDEO_HOST_RE 误杀）。
        // ★2026-08-18 修复：抖音 dyUrls 资产此前只有 url/type/source，缺 playerUrl 与 cover，
        // 导致 (1) 侧栏卡片无缩略图 (2) 无 yt-dlp 解析源页 (3) dedup key 不稳产生重复卡片。
        // 现补 playerUrl（抖音 jingxuan?modal_id= 即播放页，供回源解析与稳定去重），封面由下方
        // extractVideoCovers 的 defaultCover/byKey['aweme:<id>'] 统一回填。
        // 注意：必须用源页 URL（targetTabUrl），不能用 location.href（那是扩展 background 自身 URL）。
        if (Array.isArray(mainRes.dyUrls)) {
          // ★2026-09-02：抖音 DASH 音频轨与视频轨配对（后端合并成含音画单文件的前提）
          const dyAudios = (mainRes.dyAudios && Array.isArray(mainRes.dyAudios)) ? mainRes.dyAudios : [];
          const dyUrlTs = (mainRes.dyUrlTs && Array.isArray(mainRes.dyUrlTs)) ? mainRes.dyUrlTs : [];
          const dyAudioPaired = pairDouyinDashAudio(mainRes.dyUrls, dyUrlTs, dyAudios, mainRes.dyAwemes);
          // ★2026-08-18 修复：dyCovers 是 MAIN 世界捕获抖音直链时同步收集的封面（按时间序与 dyUrls 对齐）。
          // 优先把最新一条封面赋给最新一条 dyUrls 资产；多视频场景若数量不匹配则整页默认封面兜底（下方 extractVideoCovers 处理）。
          const dyCovers = (mainRes.dyCovers && mainRes.dyCovers.length) ? mainRes.dyCovers : [];
          const dyPlayback = (mainRes.dyPlayback && mainRes.dyPlayback.length) ? mainRes.dyPlayback : [];
        // ★2026-09-01：按 awemeId 索引的封面与多画质直链，精确回填到对应视频卡（不再依赖错位索引）。
        const dyCoverByAweme = (mainRes.dyCoverByAweme && typeof mainRes.dyCoverByAweme === 'object') ? mainRes.dyCoverByAweme : {};
        const dyFormatsByAweme = (mainRes.dyFormatsByAweme && typeof mainRes.dyFormatsByAweme === 'object') ? mainRes.dyFormatsByAweme : {};
        const dyAudiosByAweme = (mainRes.dyAudiosByAweme && typeof mainRes.dyAudiosByAweme === 'object') ? mainRes.dyAudiosByAweme : {};
        const dyVideoUrlByAweme = (mainRes.dyVideoUrlByAweme && typeof mainRes.dyVideoUrlByAweme === 'object') ? mainRes.dyVideoUrlByAweme : {};
          let dyAssets = mainRes.dyUrls
            .map((u, i) => {
              const aid = ((mainRes.dyAwemes && mainRes.dyAwemes[i]) || '').replace(/[^\w]/g, '');
              // ★2026-08-22 深层修复：仅保留"当前播放流"（dyPlayback 标记）。搜索/信息流的预加载脏数据
              // 在 inject-main 已被拦截（未进 dyUrls），此处再行防御——若未来某来源混入非播放流则丢弃，
              // 避免产生"9 张错卡 / 有声没画面"。
              const isPlayback = (dyPlayback[i] !== false);
              if (!isPlayback) return null;
              return {
                // ★2026-09-03：优先用按 awemeId 索引的视频轨直链（切集后精确指向本集，避免取错/取旧），
                //   回退到 dyUrls 当前下标对应的流（仍仅为视频轨，音频轨已分离到 dyAudios），
                //   再回退到详情 API 的 play_addr 直链（MSE 场景下 dyUrls 常为空的兜底，保证预览"有画面"）。
                url: ((aid && mainRes.dyUrlsByAweme && mainRes.dyUrlsByAweme[aid])
                  || (aid && dyVideoUrlByAweme[aid])
                  || (pageCurAwemeId && dyVideoUrlByAweme[pageCurAwemeId])
                  || u), type: 'video', source: 'douyin', platform: 'douyin',
                // ★2026-09-02：配对到的 DASH 音频轨直链。下载时若存在则交后端 ffmpeg
                //   合并成含音画单文件（直连只能拿到无声视频轨）。
                // ★2026-09-03：优先用按「当前集锚点」索引的音频轨（dyAudiosByAweme[当前 awemeId]），
                //   比时间配对更稳，切集后精确拿到本集音频，避免"有画面没声音/内容不一致"。
                dashAudio: (dyAudioPaired[i] && dyAudioPaired[i].url)
                  || dyAudiosByAweme[aid]
                  || (pageCurAwemeId && dyAudiosByAweme[pageCurAwemeId])
                  || (dyAudios && dyAudios.length && dyAudios[dyAudios.length - 1].url)
                  || null,
                // ★2026-08-23 修复：playerUrl 优先沿用源页 jingxuan?modal_id=<feedId> 上下文，
                // 切页时与当前播放页 modal_id 精确匹配 → 点当前视频不刷新，点别的视频最小化跳页。
                playerUrl: douyinPlayerUrl(aid, targetTabUrl) || (targetTabUrl || undefined),
                // ★2026-08-23 修复（revert 错误：不能用品页面统一的 modal_id，否则所有卡片都跳同一视频）：
                // 每张卡片用自己反查出的真实 awemeId 作为唯一播放标识 → 点哪张开哪张，绝不错配。
                // switchDouyinEpisodeTo 用 awemeId 与当前源页 /video/<id> 或 modal_id=<id> 比较，相等则不跳页。
                modalId: aid || '',
                // 末条 dyUrls 对应「当前播放」，取末条 dyCovers；其余按索引对齐（不足则留空，后续 extractVideoCovers 兜底）
                // ★2026-09-01：优先用按 awemeId 索引的精确封面，彻底解决 dyCovers 索引错位导致封面错配/缺封面。
                cover: (aid && dyCoverByAweme[aid]) || (dyCovers.length ? (dyCovers[i] || dyCovers[dyCovers.length - 1]) : undefined),
                // ★2026-09-01：抖音多画质直链（RENDER_DATA bit_rate），供侧栏"选分辨率下载"。
                // ★2026-09-01：保留 is_default（inject-main 已按 download_addr 优先标记），
                //   旧映射只取 {label,url} 会丢掉默认档标记 → 侧栏永远回退 formats[0]
                //   （bit_rate 通常低→高，等于默认选最低清）。
                dyFormats: (aid && dyFormatsByAweme[aid] && dyFormatsByAweme[aid].length)
                  ? dyFormatsByAweme[aid].map((f) => ({
                      label: (f && f.label) || '默认',
                      url: (f && f.url) || '',
                      is_default: !!(f && f.is_default),
                    }))
                  : undefined,
                // ★2026-08-21 修复:合集多集数场景下，每条 dyUrls 对应不同 aweme_id，dedup 必须按 awemeId 区分。
                // 来源：inject-main 在捕获 dyUrl 时按 RENDER_DATA aweme_list 顺序填充 dyAwemes，与 dyUrls 1:1 同步。
                awemeId: aid,
                // ★2026-09-03：是否「浏览器未实际播放过」——仅当前正在播放的那集(aid===pageCurAwemeId)为 false。
                //   用于侧栏打 📍 未播放 徽标 + 预览引导「切到此集播放」，避免拿过期 API play_addr 直链硬预览(403→只有声音)。
                notPlayed: !!(pageCurAwemeId && aid && String(aid) !== String(pageCurAwemeId)),
                // ★2026-09-03：优先用合集/列表 API 的数组顺序作为「绝对集数」，严格等于播放列表显示的「第 N 集」；
                //   未索引到时按 dyAwemes 顺序兜底，保证文件名一定带集数。
                episodeNo: (aid && mainRes.dyEpisodeByAweme && mainRes.dyEpisodeByAweme[aid]) || (i + 1),
                // ★2026-09-03：用 RENDER_DATA / 详情 API 里按 awemeId 索引的真实标题（通常含「第 N 集：...」）做文件名
                title: stripEpisodePrefix((aid && mainRes.dyTitlesByAweme && mainRes.dyTitlesByAweme[aid]) || ''),
              };
            })
            .filter(Boolean);
          // ★2026-09-03：同一集的视频分片(DASH)在 dyUrls 里是多条不同 CDN 直链，但内容相同。
          //   按 awemeId 去重，只保留每集第一条，避免"一个视频变 N 张卡"且旧分片签名过期→"只有声音没画面"。
          //   无 awemeId 的分片(RENDER_DATA 反查失败)各自保留(用 url 兜底唯一性)。
          try {
            const seenAid = new Set();
            const deduped = [];
            for (const d of dyAssets) {
              const k = d && d.awemeId;
              if (k && seenAid.has(k)) continue;
              if (k) seenAid.add(k);
              deduped.push(d);
            }
            dyAssets = deduped;
          } catch (_) {}
          // ★2026-09-03 合集批量合成：
          //   实测 dyUrls 常为 0（抖音 MSE 播放不暴露可拦截的 fetch），但详情/合集列表 API 已把
          //   每一集的【标题 / 封面 / 绝对集数 / 视频轨直链】都抓全了（dyTitlesByAweme / dyCoverByAweme /
          //   dyEpisodeByAweme / dyVideoUrlByAweme）。此前 scan.js 从不遍历这些映射，
          //   只认 dyUrls → 侧栏一张抖音卡都生不成，只剩"无 awemeId 的裸直链卡"。
          //   现按集数映射为每一集合成视频卡：当前集不打「未播放」，其余打 📍（需切源页播放才能拿到实时流）。
          // ★2026-09-05 修复：合集页（有 mixId / episodeMap）时，无论"信息流批量采集"开关是否打开，
          //   都要把每一集都列出来——这是合集页的基本功能；开关只控制 feed/搜索等非合集场景是否批量。
          try {
            const vmap = mainRes.dyVideoUrlByAweme || {};
            const vkeys = Object.keys(vmap);
            const episodeMap = mainRes.dyEpisodeByAweme || {};
            const hasEpisodeIndex = Object.keys(episodeMap).length > 0;
            const isKnownCollection = hasEpisodeIndex || !!(mainRes.mixId);
            // ★2026-09-05 修复（"内容有当前合集不匹配" + 卡数忽多忽少根因）：
            //   dyVideoUrlByAweme 会被推荐流/搜索/上一合集的残留污染。此前只用 episodeMap
            //   （数组下标派生、随 chunk 变化）当成员名单 → 名单本身不稳定、且漏判归属。
            //   现以【按 awemeId 索引的所属合集 id】为准：当前页有 mixId 时，只接受归属本合集
            //   （或已被本合集集数索引到）的项，其余一律丢弃。
            const mixIdsByAweme = mainRes.dyMixIdsByAweme || {};
            const curMixId = pageMixId || mainRes.mixId || mainRes.mix_id || '';
            if ((isKnownCollection || batchMode) && vkeys.length > 0) {
              const liveByAid = new Map();
              for (const d of dyAssets) if (d && d.awemeId) liveByAid.set(String(d.awemeId), d);
              const coll = [];
              // ★2026-09-04 修复（批量开启时"合集 3 集却凭空多出很多视频卡"真凶）：
              //   dyVideoUrlByAweme 会被任意详情/feed/搜索响应污染，里面可能混入 20+ 个推荐流 awemeId；
              //   旧逻辑把【所有键】都合成卡片 → 侧栏出现 N 张非合集卡。
              //   只有合集/列表 API 才会按播放列表顺序写入 dyEpisodeByAweme，因此以它为权威成员名单：
              //   有 episodeNo 的才认为属于当前合集；否则跳过。
              //   episodeMap / isKnownCollection 已在外层计算好，这里直接用。
              for (const k of vkeys) {
                const u = vmap[k];
                if (!u) continue;
                if (isKnownCollection && !episodeMap[k]) continue; // 合集页：只认列表成员；非合集页：保持全部
                // ★2026-09-05：已知当前合集 id 时，剔除归属其它合集/无归属的脏数据。
                //   注意兜底：dyMixIdsByAweme 整体为空（旧缓存/刚重载还没采到归属）时不能启用过滤，
                //   否则会把全部成员误杀 → 侧栏一张合集卡都不剩（比混入脏数据更糟）。
                if (curMixId && isKnownCollection && Object.keys(mixIdsByAweme).length > 0) {
                  const owner = mixIdsByAweme[k] ? String(mixIdsByAweme[k]) : '';
                  if (owner !== String(curMixId)) continue;
                }
                if (liveByAid.has(String(k))) continue; // 已有实时流卡（更鲜），不重复生成
                coll.push({
                  url: u,
                  type: 'video', source: 'douyin', platform: 'douyin',
                  dashAudio: (mainRes.dyAudiosByAweme && mainRes.dyAudiosByAweme[k]) || null,
                  playerUrl: douyinPlayerUrl(k, targetTabUrl) || (targetTabUrl || undefined),
                  modalId: k,
                  cover: dyCoverByAweme[k] || undefined,
                  dyFormats: (dyFormatsByAweme[k] && dyFormatsByAweme[k].length)
                    ? dyFormatsByAweme[k].map((f) => ({ label: (f && f.label) || '默认', url: (f && f.url) || '', is_default: !!(f && f.is_default) }))
                    : undefined,
                  awemeId: k,
                  episodeNo: (mainRes.dyEpisodeByAweme && mainRes.dyEpisodeByAweme[k]) || undefined,
                  title: stripEpisodePrefix((mainRes.dyTitlesByAweme && mainRes.dyTitlesByAweme[k]) || ''),
                  notPlayed: !!(pageCurAwemeId && String(k) !== String(pageCurAwemeId)),
                });
              }
              if (coll.length) {
                dyAssets = dyAssets.concat(coll);
                console.log('[HMDAO][scan] 抖音合集批量：合成 %d 张集数卡（共 %d 集）', coll.length, vkeys.length);
              }
            }
          } catch (e) { console.warn('[HMDAO][scan] 合集批量合成失败：', e && e.message); }
          // ★2026-08-22 修复（"没开启信息流也扫出很多视频"真凶）：单视频模式（!batchMode）下，
          //   只保留「当前播放的那一条」（dyUrls 末条 isPlayback），而非所有 isPlayback 累积项。
          //   否则 inject-main 跨页面累积 + 主播放器判定抖动会产出多条错卡。
          //   批量模式（batchMode）保留全部（合集/信息流的多视频场景需要）。
          if (!batchMode) {
            // ★2026-08-23 P2（侧栏与当前播放视频精确匹配校验）：
            //   单视频模式必须只保留「当前 <video> 真正在播放的那条流所属的视频」，
            //   即 awemeId === 主播放器 currentSrc 反查出的 pageCurAwemeId 的资产，
            //   确保标题/缩略图/画面URL 三者与页面实际播放一致。
            // ★2026-09-04 修复（用户实测：单视频模式点侧栏播放的是下一集/18集而非当前17集）：
            //   MSE 流数组 dyUrls 会被预加载、信息流推荐、切集缓存污染，用它反查的 awemeId 与 URL 可能对不上。
            //   详情/合集 API 按 awemeId 索引的 play_addr（dyVideoUrlByAweme）才是该集的真实签名直链。
            //   因此单视频模式【优先】用 dyVideoUrlByAweme[pageCurAwemeId] 生成当前集资产，其次才回退 dyAssets 精确匹配。
            if (pageCurAwemeId) {
              const vurl = dyVideoUrlByAweme[pageCurAwemeId];
              if (vurl) {
                const aid = pageCurAwemeId;
                networkAssets.push({
                  url: vurl, type: 'video', source: 'douyin', platform: 'douyin',
                  dashAudio: (dyAudiosByAweme[aid] || (dyAudios && dyAudios.length && dyAudios[dyAudios.length - 1].url)) || null,
                  playerUrl: douyinPlayerUrl(aid, targetTabUrl) || (targetTabUrl || undefined),
                  modalId: aid || '',
                  cover: (dyCoverByAweme[aid]) || (dyCovers.length ? (dyCovers[dyCovers.length - 1]) : undefined),
                  dyFormats: (aid && dyFormatsByAweme[aid] && dyFormatsByAweme[aid].length)
                    ? dyFormatsByAweme[aid].map((f) => ({ label: (f && f.label) || '默认', url: (f && f.url) || '', is_default: !!(f && f.is_default) }))
                    : undefined,
                  awemeId: aid,
                  episodeNo: ((mainRes.dyEpisodeByAweme && mainRes.dyEpisodeByAweme[aid]) || 1),
                  title: stripEpisodePrefix((mainRes.dyTitlesByAweme && mainRes.dyTitlesByAweme[aid]) || ''),
                });
              } else {
                const exact = dyAssets.filter(a => a.awemeId === pageCurAwemeId);
                // 无详情直链时：先精确匹配实时流，再回退末条
                if (exact.length) {
                  networkAssets.push(...exact);
                } else if (dyAssets.length) {
                  networkAssets.push(dyAssets[dyAssets.length - 1]);
                }
              }
            } else if (dyAssets.length > 1) {
              networkAssets.push(dyAssets[dyAssets.length - 1]);
            } else {
              networkAssets.push(...dyAssets);
            }
          } else {
            networkAssets.push(...dyAssets);
          }
          // ★2026-09-02：抖音 DASH 音频轨作为【独立音频卡片】入库（侧栏音频面板）。
          //   card-render.js 对 type==='audio' 的卡片无条件绑定「悬停试听 / 移开停止」
          //   （card.onmouseenter = hoverPlayAudio），点击走 openPreview 预览，
          //   所以只要资产 type 是 audio，试听与预览自动可用，无需额外接线。
          //   同时它被视频卡的 dashAudio 引用，供后端 ffmpeg 合并成含音画单文件。
          // 去重（跨重复处理也生效）：
          //   ① networkAssets 里已存在的同 URL 音频资产不再入库；
          //   ② 本次 dyAudios 内同 URL 只留一条。
          //   实测同一条音频轨会被处理两遍（视频卡同样存在 douyin / deep-parse 双来源），
          //   不去重会渲染出两张一模一样的音频卡。
          const seenAudioUrl = new Set(networkAssets.filter((a) => a && a.type === 'audio' && a.url).map((a) => a.url));
          // ★2026-09-12 修复（用户实测：一个视频扫出 3 个音频文件）：
          //   dyAudios 来自两个独立来源 —— ① 页面 RENDER_DATA/详情的 video.bitRateAudioList[0] 音频直链；
          //   ② 网络拦截到的每条 mime_type=audio_mp4 请求（DASH 音频会分多次、每次带不同签名请求）。
          //   旧逻辑仅按【完整 URL】去重 → 同一视频的同一音轨因签名不同被当成多张独立音频卡。
          //   改为按 awemeId 归并（无 awemeId 时退回 URL），同一视频只保留最后一条（最新签名）。
          const byAweme = new Map();
          for (const x of dyAudios) {
            if (!x || !x.url) continue;
            const k = x.awemeId ? ('aweme:' + x.awemeId) : ('url:' + x.url);
            byAweme.set(k, x); // 后写覆盖前值 → 同一视频保留最新捕获的那条
          }
          const dyAudioAssets = [];
          for (const x of byAweme.values()) {
            if (seenAudioUrl.has(x.url)) continue;
            seenAudioUrl.add(x.url);
            dyAudioAssets.push({
              url: x.url,
              type: 'audio',
              source: 'douyin-dash-audio',
              platform: 'douyin',
              playerUrl: targetTabUrl || undefined,
              title: '抖音音频轨' + (x.awemeId ? '（aweme ' + x.awemeId + '）' : ''),
              awemeId: x.awemeId || '',
            });
          }
          if (dyAudioAssets.length) networkAssets.push(...dyAudioAssets);
        }
        // ★2026-08-31 国际版 TikTok：镜像抖音 dyUrls（TikTok CDN 直链经 inject-main 捕获到 tkUrls）。
        // 同样只保留"当前播放流"（tkPlayback 标记）；单视频模式仅留末条（当前播放），批量模式全留。
        if (Array.isArray(mainRes.tkUrls)) {
          const tkCovers = (mainRes.tkCovers && mainRes.tkCovers.length) ? mainRes.tkCovers : [];
          const tkPlayback = (mainRes.tkPlayback && mainRes.tkPlayback.length) ? mainRes.tkPlayback : [];
          const tkAssets = mainRes.tkUrls
            .map((u, i) => {
              const tid = ((mainRes.tkAwemes && mainRes.tkAwemes[i]) || '').replace(/[^\w]/g, '');
              if (tkPlayback[i] === false) return null;
              return {
                url: u, type: 'video', source: 'tiktok', platform: 'tiktok',
                playerUrl: douyinPlayerUrl(tid, targetTabUrl) || (targetTabUrl || undefined),
                modalId: tid || '',
                cover: tkCovers.length ? (tkCovers[i] || tkCovers[tkCovers.length - 1]) : undefined,
                awemeId: tid, // 复用 awemeId 字段存 TikTok 视频 id，供 dedup/切源页
              };
            })
            .filter(Boolean);
          if (tkAssets.length) {
            if (!batchMode) networkAssets.push(tkAssets[tkAssets.length - 1]);
            else networkAssets.push(...tkAssets);
          }
        }
        // ★扩展（2026-08-01）：接口响应体视频直链（liblib 等动态视频站点）
        // ★2026-08-22 修复（46 条错卡根因兜底）：抖音/TikTok 域在 modal_id 已知单视频场景下，
        //   apiVideos 已被 inject-main 跳过扫描（避免签名 CDN URL 多条误入）。此处再次防御：
        //   抖音单视频场景下若 mainRes.apiVideos 仍有残留（重载扩展/缓存竞争），强制跳过整个 apiVideos 源，
        //   让当前视频仅由 dyUrls（含 modal_id 的那条）捕获 → dedup 合并为 1 张卡片。
        if (Array.isArray(mainRes.apiVideos) && mainRes.apiVideos.length) {
          // ★2026-08-23 数据驱动修复（实测 67 张错卡根因）：
          //   apiVideos 来自 model-api-capture.js 抓抖音页面所有 fetch/XHR 响应体里的 mp4/webm/m3u8 直链，
          //   实测 39 条全是 bytednsdoc.com 游戏广告 / douyincdn.com 第三方游戏推广 / douyinvod.com 推广短片 —
          //   全部不是当前播放视频，更不是合集其他集。注入 inject-main.js 的 dyUrls 在抖音 PC web 因
          //   MSE 接管 video + 播放事件不冒泡 → 永远抓不到（硬限制），所以 apiVideos 是抖音唯一的网络直链
          //   来源，但又是垃圾。旧过滤逻辑用 modal_id 判定，但 aidKnown 在 modal_id 已知场景下仍会
          //   把 39 条全 push 进来 → 网络资产 39 条 + 我放宽 walk 后深链资产多条 = 67 张同款错卡。
          //   修复：抖音 / TikTok / 头条域【任何场景都强制跳过】apiVideos，让抖音只走 RENDER_DATA 路径
          //   （videoDetail 快速路径 + walk 放宽 + playAddr.src 兜底），保证 1 张当前真实视频卡。
          const isDyTikTok = /(?:^|\.)(douyin\.com|ixigua\.com|tiktok\.com|tiktokv\.com|bytedance\.com|toutiao\.com)$/i.test(targetTabUrl || '');
          if (!isDyTikTok) {
            // ★2026-09-11 修复（liblib 等站同一视频多分辨率占多张卡根因）：
            //   apiVideos 会捕获同一视频的 1080p/720p/540p 等多个签名直链，旧 dedup 只按 URL 去签名归一，
            //   pathname 里带 _1080p / _720p 的变体无法合并 → 同一视频出现 3~4 张重复卡。
            //   这里按"去掉分辨率标签后的 basename"分组，最高分辨率作为 asset.url，其余收入 altUrls，
            //   下载时用户可在分辨率面板里切换（与 aigeiVideos 的多分辨率聚合语义一致）。
            const apiPairs = (mainRes.apiVideoPairs && typeof mainRes.apiVideoPairs === 'object') ? mainRes.apiVideoPairs : {};
            const apiTitles = (mainRes.apiVideoTitles && typeof mainRes.apiVideoTitles === 'object') ? mainRes.apiVideoTitles : {};
            const stripResTag = (name) => String(name || '')
              .replace(/[_-](1080|720|540|480|360|240|1440|2160|4k|2k|hd|sd|fhd|uhd|high|low|medium|mid)[pP]?([-_]|$)/gi, '$2')
              .replace(/(1080|720|540|480|360|240|1440|2160|4k|2k|hd|sd|fhd|uhd|high|low|medium|mid)[pP]?([-_]|$)/gi, '$2')
              .trim();
            const apiVideoByBase = new Map();
            for (const u of mainRes.apiVideos) {
              try {
                const urlObj = new URL(u);
                const base = stripResTag((urlObj.pathname || '').split('/').pop() || '');
                const groupKey = base ? (urlObj.origin + urlObj.pathname.replace(/[^/]+$/, '') + base) : u;
                const list = apiVideoByBase.get(groupKey) || [];
                list.push(u);
                apiVideoByBase.set(groupKey, list);
              } catch (_) {
                networkAssets.push({ url: u, type: 'video', source: 'api-video' });
              }
            }
            for (const list of apiVideoByBase.values()) {
              if (!list.length) continue;
              // 按分辨率排序：数字越大越靠前（取 1080p > 720p）；无数字按 URL 原序
              list.sort((x, y) => {
                const rx = Number((String(x).match(/[_-]?(\d+)[pP]/) || [0, 0])[1] || 0);
                const ry = Number((String(y).match(/[_-]?(\d+)[pP]/) || [0, 0])[1] || 0);
                return ry - rx;
              });
              const main = { url: list[0], type: 'video', source: 'api-video' };
              const cover = apiPairs[list[0]] || apiPairs[list[0].split('?')[0]];
              if (cover) main.cover = cover;
              // ★2026-09-11：结构化标题（多平台通用，liblib/模型社区等 API JSON 内 title/name 字段）
              const title = apiTitles[list[0]] || apiTitles[list[0].split('?')[0]];
              if (title) main.title = title;
              if (list.length > 1) {
                main.altUrls = list.slice(1).map((u) => {
                  const q = Number((String(u).match(/[_-]?(\d+)[pP]/) || [0, 0])[1] || 0);
                  return { url: u, quality: q ? (q + 'P') : '', source: 'api-video' };
                });
              }
              networkAssets.push(main);
            }
          }
        }
        // ★爱给视频多分辨率：用户已在源页切换过的画质版本，按 quality 保留为同一素材的候选 URL
        if (Array.isArray(mainRes.aigeiVideos)) {
          networkAssets.push(...mainRes.aigeiVideos.map((v) => ({ url: v.url, type: 'video', source: 'aigei', quality: v.quality || '', path: v.path || '' })));
        }
        if (Array.isArray(mainRes.ytPlay)) ytPlay.push(...mainRes.ytPlay);
        // 迅雷网盘分享页 API 响应：生成可直连下载的 archive/netdisk-file 资产
        if (mainRes.xunleiShare && mainRes.xunleiShare.list && mainRes.xunleiShare.list.length) {
          const ARCHIVE_RE = /\.(zip|rar|7z|tar|gz|tgz|iso|dmg|z|001|part|tar\.gz)$/i;
          const xs = mainRes.xunleiShare;
          for (const f of xs.list) {
            if (f.isDir) continue;
            const isArchive = ARCHIVE_RE.test(f.name || '');
            let direct = '';
            if (f.medias && f.medias.length) direct = f.medias[0].url || '';
            if (!direct && xs.fileInfo && xs.fileInfo[f.id]) direct = xs.fileInfo[f.id].direct || '';
            // 即使暂时没有直链，也把 zip/rar 文件显出来，方便用户点深度解析拿直链
            if (!isArchive && !direct) continue;
            const asset = {
              url: direct || (targetTabUrl + '#hmdao-file=' + encodeURIComponent(f.name)),
              type: isArchive ? 'archive' : 'netdisk-file',
              source: 'xunlei-share-api',
              name: f.name,
              size: f.size || 0,
              direct: direct || '',
              fileId: f.id,
              parentUrl: targetTabUrl,
              isNetdiskFile: true,
              netdiskPlatform: 'xunlei',
            };
            networkAssets.push(asset);
          }
        }
        // ★ 2026-08-09 新增：迅雷自己网盘 API 响应 → 生成 netdisk-file / archive 资产
        if (mainRes.xunleiMyDrive && mainRes.xunleiMyDrive.list && mainRes.xunleiMyDrive.list.length) {
          const ARCHIVE_RE = /\.(zip|rar|7z|tar|gz|tgz|iso|dmg|z|001|part|tar\.gz)$/i;
          const md = mainRes.xunleiMyDrive;
          for (const f of md.list) {
            if (f.isDir) continue;
            const isArchive = ARCHIVE_RE.test(f.name || '');
            let direct = '';
            if (f.medias && f.medias.length) direct = f.medias[0].url || '';
            if (!direct && md.fileInfo && md.fileInfo[f.id]) direct = md.fileInfo[f.id].direct || '';
            // 自己网盘的 zip/rar 即使暂无直链也显出来，走深度解析拿直链
            if (!isArchive && !direct) continue;
            const asset = {
              url: direct || (targetTabUrl + '#hmdao-file=' + encodeURIComponent(f.name)),
              // 自己网盘文件统一归类为网盘（避免 zip 被误判到归档 tab）
              type: 'netdisk',
              source: 'xunlei-mydrive-api',
              name: f.name,
              size: f.size || 0,
              direct: direct || '',
              fileId: f.id,
              parentUrl: targetTabUrl,
              isNetdiskFile: true,
              netdiskPlatform: 'xunlei',
            };
            networkAssets.push(asset);
          }
        }
      }
      // ★2026-09-05 自动触发抖音合集列表主动拉取：
      //   仅被动扫描拿不到 episodeMap 时，自动调用页面里的 __hmdao_tryMix(true,true)，
      //   等 2s 后再读一次 MAIN 捕获，避免用户手动在控制台执行。
      const mixId = mainRes && (mainRes.mixId || mainRes.mix_id);
      const episodeMap = (mainRes && mainRes.dyEpisodeByAweme) || {};
      if (mixId && Object.keys(episodeMap).length === 0) {
        try {
          console.log('[HMDAO][scan] 抖音合集页缺少 episodeMap，触发主动拉取 mixId=%s', mixId);
          await chrome.scripting.executeScript({
            target: { tabId, allFrames: false },
            world: 'MAIN',
            func: () => { try { window.__hmdao_tryMix && window.__hmdao_tryMix(true, true); } catch (_) {} },
          });
          await new Promise((r) => setTimeout(r, 2000));
          const reinjected = await chrome.scripting.executeScript({
            target: { tabId, allFrames: false },
            world: 'MAIN',
            func: readAllCapturesMAIN,
          });
          mainRes = reinjected && reinjected[0] && reinjected[0].result;
          console.log('[HMDAO][scan] 主动拉取后 episodeKeys=%d', Object.keys((mainRes && mainRes.dyEpisodeByAweme) || {}).length);
        } catch (e) { console.warn('[HMDAO][scan] 主动拉取失败:', e && e.message); }
      }
    } catch (e) {
      console.warn('[HMDAO][scan] readAllCapturesMAIN 注入失败（普通网页无 MAIN 捕获属正常）：', e && e.message);
    }
  };
  await readMainCaptures();

  const n = NETWORK_ASSETS[tabId] || [];
  const netAssets = n.filter((a) => a && /googlevideo\.com\/videoplayback/.test(a.url));
  if (netAssets.length) networkAssets.push(...netAssets.map((a) => ({ url: a.url, type: 'video', source: 'youtube' })));
  // ★B站真实视频流（bilivideo 裸流）：background 网络层已无条件识别为 video 并存入 NETWORK_ASSETS。
  // 此前此处只并入 googlevideo，把 bilivideo 漏掉 → B站素材永远进不了侧栏。
  // 现一并并入，下游（isBiliPlay 分支）按 itag 去重为单条最高画质视频轨。
  const biliNet = n.filter((a) => a && /bilivideo\.(com|cn|tv)\b/i.test(a.url));
  if (biliNet.length) networkAssets.push(...biliNet.map((a) => ({ url: a.url, type: 'video', source: a.source || 'bilibili-network' })));
  // ★断点修复（2026-08-01）：爱给等音效站的试听走 SoundManager.createSound({url}) → 浏览器发起真实 .mp3 HTTP 请求
  // → webRequest 捕获入 NETWORK_ASSETS[type:'audio']。但此处上面只挑 googlevideo/bilivideo 把音频资产
  // 整条漏掉 → 侧栏「音频 0 / 试听音效采不到」。改为：把 NETWORK_ASSETS 里所有 audio 类型（除 bilivideo 外）也并入。
  const audioNet = n.filter((a) => a && a.type === 'audio' && !/bilivideo\.(com|cn|tv)\b/i.test(a.url));
  if (audioNet.length) {
    networkAssets.push(...audioNet.map((a) => {
      const base = { url: a.url, type: 'audio', source: a.source || 'network' };
      // ★2026-09-06 豆包朗读（后台魔数验证命中）：补平台/标题，卡片与文件名可读
      if (a.source === 'doubao-tts-verified') {
        const t = String(targetTabTitle || '').replace(/^\s*豆包\s*[-—|]\s*/, '').replace(/\s*[-—|]\s*豆包\s*$/, '').trim();
        base.platform = 'doubao';
        base.playerUrl = targetTabUrl || undefined;
        base.title = (t && !/^豆包$|新对话/.test(t) ? t + ' · 豆包朗读' : '豆包朗读');
      }
      return base;
    }));
    console.log('[HMDAO][scan] 网络层音频资产并入:', audioNet.length, '条');
  }
  // ★2026-09-10：其它站点的网络层视频直链（m3u8 / mp4 / flv 等）此前【完全未并入】
  //   —— 只并了 googlevideo(YouTube) / bilivideo(B站) / audio 三类，导致 DPlayer、hls.js
  //   一类播放器用 XHR 拉的 m3u8（initiatorType=xmlhttprequest 而非原生 media）
  //   虽被 webRequest 捕获进 NETWORK_ASSETS，却永远进不了侧栏。
  //   实测 4815.wumaheil13.icu：t27.cdn2020.com/.../index.m3u8 已被捕获，侧栏视频仍为 0。
  //   这里并入其余 video 类型网络资产；并排除 HLS 数字分片（0000.ts / 0001.ts…），
  //   避免几十上百张碎片卡刷屏（分片本身不可独立播放，播放列表 index.m3u8 才是素材）。
  // ★2026-09-10 修复（占位/API 直链不应生成可播放卡）：
  //   网络层会把 MSN 之类站点的「…/get-url」「…/asset」这类【无扩展名 API 占位直链】
  //   （响应可能是 video/*，其实是接口而非媒体文件）也标成 type:'video' 收进来。
  //   同一视频的 N 个签名变体被收成 N 张「点哪张都播同一个」的废卡。
  //   真实可直接播放的媒体文件 URL，其 pathname 末段必带视频/音频扩展名（.mp4/.webm/.m3u8/.m4s/.flv…）；
  //   API 占位直链末段是动词/无扩展名 → 直接排除。例外：少数无扩展名但确为媒体的已知 CDN（抖音 douyinvod/v26-web）放行。
  //   YouTube/B站 已在上面单独分支处理，不依赖此判定。
  const looksLikeMediaFileUrl = (url) => {
    if (!url || typeof url !== 'string') return false;
    try {
      const u = new URL(url);
      const path = u.pathname || '';
      if (/\.(mp4|webm|m4s|mov|m3u8|flv|m4v|avi|mkv|ts|ogv|mpd|m3u|mp3|m4a|aac|ogg|wav|mpg|mpeg)(\?|#|$)/i.test(path)) return true;
      const host = (u.hostname || '').toLowerCase();
      if (/douyinvod|v26-web/.test(host)) return true; // 抖音 CDN 无扩展名但确为媒体
      return false;
    } catch (_) { return false; }
  };
  const otherVideoNet = n.filter((a) => a && a.type === 'video'
    && !/googlevideo\.com\/videoplayback/.test(a.url)
    && !/bilivideo\.(com|cn|tv)\b/i.test(a.url)
    && !/\/[0-9]+\.ts(\?|$)/i.test(a.url)
    && looksLikeMediaFileUrl(a.url));
  if (otherVideoNet.length) {
    networkAssets.push(...otherVideoNet.map((a) => ({ url: a.url, type: 'video', source: a.source || 'network' })));
    console.log('[HMDAO][scan] 网络层其它视频直链并入:', otherVideoNet.length, '条');
  }

  // ★爱给视频多分辨率聚合（2026-08-01）：同一视频不同画质版本合并为单条素材，
  // 最新签名的 URL 作为主 asset.url，其余版本放入 asset.altUrls，下载面板可切换分辨率。
  // 注意：这里只聚合来自 MAIN 捕获的 aigeiVideos，NETWORK_ASSETS 里的同名视频也在后续去重中处理。
  try {
    const aigeiItems = networkAssets.filter((a) => a && a.source === 'aigei' && a.path);
    if (aigeiItems.length > 1) {
      const byPath = new Map();
      for (const item of aigeiItems) {
        if (!byPath.has(item.path)) byPath.set(item.path, []);
        byPath.get(item.path).push(item);
      }
      const merged = [];
      for (const items of byPath.values()) {
        items.sort((x, y) => (y.ts || 0) - (x.ts || 0));
        const main = { ...items[0] };
        main.altUrls = items.slice(1).map((v) => ({ url: v.url, quality: v.quality || '', source: 'aigei' }));
        merged.push(main);
      }
      networkAssets = networkAssets.filter((a) => !(a && a.source === 'aigei' && a.path));
      networkAssets.push(...merged);
      console.log('[HMDAO][scan] 爱给视频多分辨率聚合:', merged.length, '组，候选 URL 数', aigeiItems.length);
    }
  } catch (e) {
    console.warn('[HMDAO][scan] 爱给视频聚合失败:', e && e.message);
  }

  // 主动扫描时若 YouTube 直链为空，或抖音有 <video> 但 dyUrls 为空（用户无操作未播放），
  // 静音缓冲 1.5s 触发播放器发请求，让 MAIN 世界拦截器捕获真实直链（打开页即扫描也能采到）。
  // ★B站不自动缓冲：走「用户选择后再解析」策略，不无脑 play/pause 触碰播放器（保护浏览端运行状态）。
  // ★2026-08-23 修复（问题1「源页突然暂停」根因）：
  //   forceYtBufferAndCapture 会「静音→改 currentTime→play→1.5s→pause()」，且【不恢复播放】。
  //   它只对「需要靠静音缓冲触发播放器发 googlevideo 请求」的 YouTube 有效——YouTube 的 n 签名
  //   直链必须由播放器实际发起请求才能被 inject-main 拦截到。抖音 dyUrls 由 inject-main 的
  //   fetch/XHR 拦截直接捕获（无需 play/pause 触发），RENDER_DATA 解析也不依赖播放状态。
  //   此前 isBufferedPlatform 误把 douyin/tiktok 也纳入，且 ytPlay 在抖音恒为空 → needBuffer 恒真，
  //   抖音页每次扫描都会 forceYtBufferAndCapture → 源页视频被静音 + 1.5s 后 pause 且不恢复 →
  //   「没任何操作却突然暂停」。修复：缓冲仅限 YouTube，抖音/TikTok 绝不触碰播放器。
  // ★修复（2026-08-18 之前残留笔误 tabUrl）：正式变量名是 targetTabUrl。
  //   此前写漏成全局 tabUrl → ReferenceError → 整条 scanTab 同步抛错。
  const isBufferedPlatform = /\byoutube\.com\b|\byoutu\.be\b/i.test(targetTabUrl || '');
  const needBuffer = !isBiliPlay && isBufferedPlatform && ytPlay.length === 0 && (networkAssets.length === 0 || !networkAssets.some((a) => a.type === 'video'));
  if (needBuffer) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: forceYtBufferAndCapture,
      });
      // 缓冲后重新读取 MAIN 捕获（此时 dyUrls/ytPlay 已填充）
      await readMainCaptures();
    } catch (e) {
      console.warn('[HMDAO][scan] forceYtBufferAndCapture 注入失败：', e && e.message);
    }
  }

  // ★2026-08-25 修复（抖音封面/视频有时 0 条根因）：抖音 RENDER_DATA 是页面 JS 动态注入的，
  // 首次扫描时 aweme 数组常为空（日志「RENDER_DATA 未解析到 aweme，稍候再点重新扫描」）。
  // 扫描前对抖音页注入阻塞式等待：轮询 RENDER_DATA 含 video.play_addr 的 aweme，最多 ~3s，
  // 让封面(aweme.cover)与真实直链(dyUrls)能被 extractVideoCovers/解析到。
  if (/douyin\.com|tiktok\.com/i.test(targetTabUrl || '')) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => new Promise((resolve) => {
          const t0 = Date.now();
          const hasAweme = () => {
            try {
              const el = document.querySelector('script#RENDER_DATA, script[id="RENDER_DATA"]');
              if (!el || !el.textContent) return false;
              const data = JSON.parse(decodeURIComponent(el.textContent));
              let found = false;
              const walk = (o) => {
                if (!o || typeof o !== 'object' || found) return;
                if (Array.isArray(o)) { o.forEach(walk); return; }
                const am = o.awemeId != null ? String(o.awemeId) : (o.aweme_id != null ? String(o.aweme_id) : '');
                if (am && o.video && (o.video.play_addr || o.video.download_addr)) { found = true; return; }
                for (const k in o) { try { walk(o[k]); } catch (_) {} }
              };
              walk(data);
              return found;
            } catch (_) { return false; }
          };
          const poll = () => {
            if (hasAweme() || Date.now() - t0 > 3000) return resolve(true);
            setTimeout(poll, 200);
          };
          poll();
        }),
      });
      console.log('[HMDAO][scan] 抖音页已等待 RENDER_DATA 稳定（≤3s）');
    } catch (e) {
      console.warn('[HMDAO][scan] 等待 RENDER_DATA 失败（继续扫描）：', e && e.message);
    }
  }

  let pageAssets = [];
  let deepVideoAssets = [];
  if (isBiliPlay) {
    // 纯旁观：B站播放页不跑任何会碰播放器的注入（scanPage / extractFreshVideoUrl）。
    console.log('[HMDAO][scan] B站播放页：进入纯旁观模式（跳过 scanPage / extractFreshVideoUrl，保声音）');
  } else {
    try {
      // ★2026-09-07 修复（用户实测课程/设计站 webp/avif 漏采根因）：原注入只扫顶层帧，
      // 图片/链接若位于 <iframe>（设计评审、课程、网盘预览常把内容放隔离 iframe）则永远采不到。
      // 改 allFrames:true 注入到所有子帧（含跨域；扩展已声明 <all_urls> host 权限），并聚合各帧结果。
      const res = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: 'ISOLATED',
        func: scanPage,
        args: [networkAssets],
      });
      pageAssets = (res || []).flatMap((r) => (r && r.result) || []);
      console.log('[HMDAO][scan] DOM 解析产出', pageAssets.length, '条素材（含图片/视频/音频/3D模型/下载链接，已含 iframe 子帧）');
    } catch (e) {
      console.warn('[HMDAO][scan] scanPage 注入/执行失败（tab 未就绪或不可脚本化）：', e && e.message);
    }

    // ★P0 回归修复：扫描阶段必须跑深度直链解析（extractFreshVideoUrl）。
    // 重构前 scanTab 直接调用它产出视频；重构后该函数仅剩 REFRESH_FROM_PAGE（点击刷新）才触发，
    // 导致打开任意视频站页面、首扫/轮询都采不到视频（DOM 只读到 blob: MSE 源，无真实直链）。
    // 这里【始终】调用（首扫与轮询都跑）：它是视频站采集的唯一来源，不跑则视频永远缺失。
    // 成本可控——extractFreshVideoUrl 优先读页面已就绪的全局（__playinfo__/__INITIAL_STATE__/拦截捕获），
    // 不发请求；仅兜底 WBI playurl 才发一次 API，且 inject-main 已常态拦截播放器请求。
    if (typeof extractFreshVideoUrl === 'function') {
      try {
        // ★2026-08-22 信息流批量采集：先注入 __hmdao_batchMode 到 MAIN 世界，
        //   让 extractFreshVideoUrl 内部能识别「批量采集合集」/「当前页所有视频」/「自定义」模式。
        //   默认 false（单视频）；批量模式由 scanTab opts.batchMode 控制。
        try {
          await chrome.scripting.executeScript({
            target: { tabId }, world: 'MAIN',
            func: (flag) => { window.__hmdao_batchMode = !!flag; },
            args: [batchMode],
          });
        } catch (_) {}
        const fr = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: extractFreshVideoUrl,
          args: ['', networkAssets],
        });
        const r = (fr && fr[0] && fr[0].result) || null;
        if (r) {
          if (typeof r === 'string') {
            deepVideoAssets.push({ url: r, type: 'video', source: 'deep-parse' });
          } else if (r && r.__dash) {
            // DASH 结构：视频轨 +（可选）音轨，分开入库以便预览/下载分别处理
            if (r.video) deepVideoAssets.push({ url: r.video, type: 'video', source: 'deep-parse-dash', referer: r.referer, dashAudio: r.audio || null });
            if (r.audio) deepVideoAssets.push({ url: r.audio, type: 'audio', source: 'deep-parse-dash-audio', referer: r.referer });
          } else if (r && r.__douyinMulti && Array.isArray(r.items) && r.items.length >= 2) {
            // ★2026-08-21 修复:抖音合集多集数场景(返回多资产数组)→ 每条独立入库,
            //   解决「扫描出合集里 N 个视频卡片但点击播放都是同一条」的根因。
            //   每条 deepVideo 资产带独立 url/awemeId/cover/title,dedup 阶段按 awemeId 区分(后续改动)。
            for (const it of r.items) {
              if (!it || !it.url) continue;
              const aid = it.awemeId || '';
              deepVideoAssets.push({
                url: it.url,
                type: 'video',
                source: 'deep-parse',
                platform: 'douyin', // ★2026-08-21 dedup 例外分支识别
                matched: !!it.__isCurrent,
                formats: it.formats,
                title: it.title || '',
                cover: it.cover || '',
                awemeId: aid,
                // ★2026-08-22 修复：抖音多视频/合集 item 必须补 playerUrl（抖音每个视频唯一页），
                // 否则侧栏预览 xpPage=a.playerUrl||a.url 会 fallback 到 CDN 直链 lf3-static.bytednsdoc.com
                // （签名/防盗链导致预览失败或跳 CDN）。批量/合集模式下尤其明显。
                playerUrl: it.playerUrl || douyinPlayerUrl(aid, targetTabUrl),
                modalId: aid || '',
                duration: it.duration,
                __isCurrent: !!it.__isCurrent,
                episodeNo: it.episodeNo || 0,
              });
            }
            const cur = (r.items.find((x) => x.__isCurrent) || {}).awemeId || '';
            if (cur) __hmdao_current_aweme_id = cur;
          } else if (r && r.__douyin) {
            // 抖音/视频号：返回完整元数据，便于侧栏识别当前 modal 视频
            deepVideoAssets.push({
              url: r.url,
              type: 'video',
              source: 'deep-parse',
              matched: r.matched,
              formats: r.formats,
              title: r.title || '',
              cover: r.cover || '',
              awemeId: r.awemeId,
              duration: r.duration,
              // ★2026-08-23 统一播放地址：带上抖音视频页 playerUrl，供侧栏点击切源页播放
              playerUrl: r.playerUrl || douyinPlayerUrl(r.awemeId, targetTabUrl),
              // 记录该卡片自身反查出的 awemeId，供 switchDouyinEpisodeTo 匹配当前源页（相等则不跳页）
              modalId: r.awemeId || '',
              platform: 'douyin',
              episodeNo: r.episodeNo || 0,
            });
            if (r.awemeId) __hmdao_current_aweme_id = r.awemeId;
          }
        }
        // ★2026-08-18 修复：tryXinpianchang 在 mod-api / aigc 接口命中后会把作品标题暂存到
        //   window.__hmdao_xpc_meta；这里再注入一次 MAIN world 读出来，回填到刚推出的 deepVideoAssets
        //   末项的 title/cover（让"采集的视频素材名与源地址不一致（变成'七'）"问题得到修正）。
        try {
          const mr = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: function () {
              try {
                const m = window.__hmdao_xpc_meta;
                if (!m || !m.url) return null;
                window.__hmdao_xpc_meta = null; // 消费即清，避免下轮扫描复用
                return { url: m.url, title: m.title || '', cover: m.cover || '' };
              } catch (_) { return null; }
            },
          });
          const m = mr && mr[0] && mr[0].result;
          if (m && m.title) {
            const tail = deepVideoAssets[deepVideoAssets.length - 1];
            if (tail && tail.url === m.url) {
              if (!tail.title) tail.title = m.title;
              if (!tail.cover && m.cover) tail.cover = m.cover;
              tail.xpcMeta = true;
            }
          }
        } catch (_) { /* 读不到就忽略，保持原行为 */ }
        console.log('[HMDAO][scan] 深度直链解析产出', deepVideoAssets.length, '条视频/音频');
      } catch (e) {
        console.warn('[HMDAO][scan] extractFreshVideoUrl 注入/执行失败：', e && e.message);
      }
    }
  }

  // ★视频封面采集（供侧栏卡片显示封面图，悬停再抽帧）：
  // 注入 MAIN 世界读页面全局封面（B站 videoData.pic / 抖音 aweme.cover / 通用 <video poster>），
  // 以「视频直链」为键回填给 deepVideoAssets，也让通用 <video poster> 回填到同页视频资产。
  // 注意：deepVideoAssets 的 url 是播放直链（bilivideo CDN 等），与 <video poster> 不是同一 URL，
  // 故 poster 仅做「同页首个视频资产」的兜底封面（优先用页面全局封面键匹配）。
  let coverMap = null;
  try {
    const cr = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: extractVideoCovers,
      args: [],
    });
    coverMap = (cr && cr[0] && cr[0].result) || null;
    // ★2026-08-23 修复：curVideoSrc / pageCurAwemeId 已在 readMainCaptures 之前读取（见上），
    //   此处不再重复 executeScript（消除 TDZ + 减少一次注入）。仅把 curVideoSrc 同步进 coverMap。
    if (curVideoSrc && coverMap) coverMap.curVideoSrc = curVideoSrc;
    if (coverMap && (coverMap.pageCovers && coverMap.pageCovers.length || coverMap.defaultCover || (coverMap.byKey && Object.keys(coverMap.byKey).length) || coverMap.curVideoSrc)) {
      // 收集本次合并后页面里所有「视频类型」资产（深链 + 网络层 + 平台），统一补封面。
      // 关键点：B站播放页因熔断 model-api-capture 导致 deepVideoAssets 为空，
      // 此时视频直链来自网络层 networkAssets（bilivideo CDN），封面来自页面 videoData.pic，
      // 二者 URL 不同，必须用「同页视频资产兜底」而非 byKey 精确匹配。
      const pageVideoAssets = [];
      if (Array.isArray(deepVideoAssets)) pageVideoAssets.push(...deepVideoAssets);
      if (Array.isArray(networkAssets)) pageVideoAssets.push(...networkAssets.filter((n) => n && n.type === 'video'));
      if (Array.isArray(ytPlay)) pageVideoAssets.push(...ytPlay.map((u) => ({ url: u, type: 'video' })));

      // ★2026-08-22 一次性根除「FETCH_MEDIA failed」：优先用 curVideoSrc 替换当前播放视频的 URL，
      //   这样 SW 拉的就是页面 <video> 真实合法签名 URL（页面能播，SW 也能 200）。
      // ★2026-08-24 修复（用户实测「url和当前网站播放的视频内容不一致 / 缩略图变回电子营业执照」根因）：
      //   原条件要求 __hmdao_current_aweme_id 同时存在才替换，但抖音 jingxuan 页 RENDER_DATA 结构变化导致
      //   awemeId 解析不到 → __hmdao_current_aweme_id 为空 → 条件不成立 → 用末条网络层捕获（推荐流/广告视频）→ 不一致。
      //   单视频页只有 1 条视频，直接以 DOM <video> 当前 src 为准（curVideoSrc 即页面真正在播的合法签名 URL）。
      // ★2026-09-01 【根因纠正】—— 上面那句假设是错的，用户日志实证：
      //   抖音用 MSE 播放，<video>.currentSrc 是【blob: URL】(blob:https://www.douyin.com/<uuid>)。
      //   blob 绑定到创建它的【源页 document】，侧栏 / background【无法 fetch】
      //   （日志：FETCH_MEDIA failed url=blob:... + net::ERR_FILE_NOT_FOUND），也不能跨文档用作 <video src>。
      //   旧代码无条件 cur.url = curVideoSrc → 把 inject-main 网络层捕获的真实 CDN 直链
      //   （v26-web.douyinvod.com/...）【冲掉】→ a.url 变成 blob: → 预览/下载全部失败
      //   （用户实测「点击视频卡出来的依然不是视频」）。
      //   修：仅当 curVideoSrc 是真实 http(s) 直链时才覆盖；blob:/data:/mediasource 一律跳过，
      //   保留网络层捕获的真实 CDN 直链。
      if (curVideoSrc && /^https?:/i.test(curVideoSrc)) {
        const cur = pageVideoAssets.find((d) => d && (__hmdao_current_aweme_id ? d.awemeId === __hmdao_current_aweme_id : true));
        if (cur) {
          cur.url = curVideoSrc;
          cur.__useCurSrc = true;
        } else if (pageVideoAssets.length) {
          // 找不到匹配（如 awemeId 全空）→ 直接覆盖首条（单视频场景就是当前播放）
          pageVideoAssets[0].url = curVideoSrc;
          pageVideoAssets[0].__useCurSrc = true;
        }
      }

      // 1) byKey 精确匹配（页面已显式给出 直链→封面 映射时优先）
      if (coverMap.byKey && Object.keys(coverMap.byKey).length) {
        pageVideoAssets.forEach((dv) => {
          if (!dv.cover) {
            const hit = (dv.awemeId && coverMap.byKey['aweme:' + String(dv.awemeId).replace(/[^\w]/g, '')])
              || coverMap.byKey[dv.url]
              || coverMap.byKey[(dv.url || '').split('?')[0]];
            if (hit) dv.cover = hit;
          }
        });
      }
      // 2) 兜底：同页仍无封面的视频资产，统一用页面默认封面（B站 pic / 抖音 cover）
      // ★2026-08-22 P1-1 v3 升级（基于真机截图实证）：defaultCover 已由白名单+黑名单筛过的
      //   抖音视频缩略图（tos-cn-i/pc 特征 URL），可全员共享。但为了避免 9 张仍同款（万一 defaultCover
      //   命中的是同张图），建议"按 pageVideoAssets 个数复制分发"——但抖音单视频过滤后只剩 1 条，
      //   所以这里直接赋 cover 即可。若批量场景（信息流）多视频，可能需要 dedup 优化——后续追加。
      if (coverMap.defaultCover) {
        // ★2026-09-08 修复（imini.ai 等多视频页「所有视频卡共用同一张封面」根因）：
        //   本段设计前提是【单视频页】（B站 videoData.pic / 抖音 aweme.cover / YouTube og:image，
        //   全页仅 1 条视频 → 共享页面默认封面 = 正确）。但通用多视频画廊页（imini /zh/video，
        //   6+ 条视频）也会进到这里：defaultCover 是 og:image / 页面最大图 → 全部视频卡被塞同一张图。
        //   修复：仅当本页视频资产 ≤1（单视频页语义）才用 defaultCover 兜底；多视频页交给下方
        //   posters / page-img 的按序分发（本来就有），分不到的宁可空封面（显示占位图标），
        //   绝不给所有卡发同一张错图。抖音/B站/YouTube 单视频页行为完全不变。
        if (pageVideoAssets.length <= 1) {
          // ★额外防御：即使白名单过滤，仍校验一次不含推广特征（双保险）
          const def = coverMap.defaultCover;
          // ★2026-09-08：补 og/分享图 黑名单（与上方 isPromo 同步）——即便候选漏进来，下发前再拦一道
          const looksLikePromo = /^(data:image\/jpeg|data:image\/png)/i.test(def) ? false : /(verify-|license-business|qrcode|qr-|banner|ad-|promo|advert|sponsor|avatar|emoji|logo|loading|sprite|placeholder|\bicon[/-]|user-?data|sign-|favicon|og[-_.]?(?:image|share|poster)|social[-_]?(?:share|preview)|apple-touch|share[-_]?(?:image|icon|logo|img))/i.test(def);
          if (!looksLikePromo) {
            pageVideoAssets.forEach((d) => { if (!d.cover) d.cover = coverMap.defaultCover; });
          } else {
            // 兜底：默认封面看起来仍像推广图 → 只给首条用一次（避免9 张同款电子营业执照）
            if (pageVideoAssets.length && !pageVideoAssets[0].cover) pageVideoAssets[0].cover = coverMap.defaultCover;
          }
        }
      }
      // 2.5) ★2026-09-11 修复（imini 等多视频页「封面与内容错配 / 部分卡无封面」根因）：
      //   视频封面此前来自「页面 <img> 按 DOM 序分发」的猜测式匹配，与视频毫无对应关系。
      //   这里先按【真封面来源优先级】给每张视频卡定封面，取不到才落回下方 posters/page-img 分发：
      //     ① <video poster> ② 内联 JSON / RSC 中与同一条 mp4 成对出现的 cover 字段（coverMap.pairs）
      //     ③ 与 mp4 同源同目录、同 basename 的图片（iminicdn 惯例：xxx.mp4 → xxx.jpg）
      //   ③ 是【候选 URL、不发任何网络请求验证】，可能 404；下游有完整降级链
      //   （media-fetch 的占位图识别 + card-render 的抽帧兜底 / 🎬），卡片不会停在"永远加载中"。
      try {
        const coverPairs = (coverMap && coverMap.pairs) || {};
        const pairKeys = Object.keys(coverPairs);
        const bareOf = (u) => { try { return String(u || '').split('?')[0]; } catch (_) { return ''; } };
        // 与视频直链同源同目录、同 basename 的图片候选
        //   a) 先在页面已加载的封面里找同 basename 的图（存在即真封面，零风险）
        //   b) 否则按同名换扩展名猜 .jpg（仅对"通用文件型 CDN"启用，平台防盗链 CDN 不猜，避免误伤）
        const SIBLING_GUESS_SKIP = /(douyinvod|douyinpic|douyinstatic|byteimg|bytetos|bytefcdn|bilivideo|bilibili|tiktokcdn|tiktokv|tiktok|googlevideo|youtu\.be|youtube|ytimg|alicdn|qpic|mmbiz|sinaimg|xhscdn|xiaohongshu|iqiyi|youku|kuaishou|\.qq\.com|pstatp|ixigua|huoshan|snssdk|akamaized)/i;
        const siblingCoverOf = (videoUrl) => {
          try {
            const u = new URL(String(videoUrl || ''), 'https://x/');
            if (!/^https?:/i.test(u.protocol)) return '';
            const m = /^(.*)\.(mp4|webm|mov|m4v|mkv|ogv|m3u8|flv|avi|wmv|ts|mpg|mpeg)$/i.exec(u.pathname);
            if (!m) return '';
            const base = m[1];
            // a) 页面已加载图里有同 basename 的 → 直接用（零风险真封面）
            const allCovers = ((coverMap && coverMap.pageCovers) || []);
            for (const c of allCovers) {
              const cu = c && c.url;
              if (!cu) continue;
              try {
                const pu = new URL(String(cu), 'https://x/');
                if (pu.origin === u.origin && pu.pathname.indexOf(base + '.') === 0
                    && /\.(jpg|jpeg|png|webp|avif|gif|bmp)(\?|$)/i.test(pu.pathname)) return String(cu);
              } catch (_) {}
            }
            // b) 同名换扩展名（仅通用文件型 CDN）
            if (SIBLING_GUESS_SKIP.test(u.hostname)) return '';
            return u.origin + base + '.jpg';
          } catch (_) { return ''; }
        };
        const findPair = (videoUrl) => {
          if (!videoUrl) return '';
          if (coverPairs[videoUrl]) return coverPairs[videoUrl];
          const bare = bareOf(videoUrl);
          if (bare && coverPairs[bare]) return coverPairs[bare];
          for (let i = 0; i < pairKeys.length; i++) {
            if (bareOf(pairKeys[i]) === bare) return coverPairs[pairKeys[i]];
          }
          return '';
        };
        const assignTrueCover = (d) => {
          if (!d || d.type !== 'video' || d.cover || !d.url) return;
          if (!/^https?:/i.test(String(d.url || ''))) return;
          const p = findPair(d.url);      // ①②
          if (p) { d.cover = p; return; }
          const sib = siblingCoverOf(d.url); // ③
          if (sib) d.cover = sib;
        };
        pageVideoAssets.forEach(assignTrueCover);
        // scanPage 产出的页面资产（imini 的内联 JSON mp4 直链走这里）
        if (Array.isArray(pageAssets)) pageAssets.forEach(assignTrueCover);
        // ★2026-09-11：api-video 网络资产（liblib 等 XHR 捕获）同样按 coverPairs 补封面，
        //   仅用 ①②（结构化/段配对），不触发 ③ 同名换扩展名猜测（liblib 会猜出 master.jpg 等 404 死链）。
        if (Array.isArray(networkAssets)) {
          for (const d of networkAssets) {
            if (d && d.type === 'video' && d.source === 'api-video' && !d.cover && /^https?:/i.test(String(d.url || ''))) {
              const p = findPair(d.url);
              if (p) d.cover = p;
            }
          }
        }
      } catch (_) {}
      // 3) 通用 <video poster>：回填给同页、且无封面的视频资产（按顺序逐条分配）
      const posters = (coverMap.pageCovers || []).filter((c) => c.kind === 'poster');
      if (posters.length) {
        let pi = 0;
        pageVideoAssets.forEach((d) => {
          if (!d.cover && pi < posters.length) { d.cover = posters[pi].url; pi++; }
        });
      }
      // ★2026-08-18 新增：通用 <img> 兜底（同页 RENDER_DATA / og:image 都缺失的「下载站」等页面）。
      // 当仍有未拿到封面的视频时，按 round-robin 顺序消费 pageCovers 里 page-img 兜底资源。
      const pageImgs = (coverMap.pageCovers || []).filter((c) => c.kind === 'page-img');
      if (pageImgs.length) {
        // ★2026-09-10（"视频卡封面与内容不一致"根因）：
        //   page-img 是【页面图片兜底】，与视频内容毫无对应关系（实测影视站会把
        //   横幅广告图 / 装饰图当成视频封面）。一旦给视频卡塞了这种图，
        //   它就"有封面"了 → 侧栏不再触发抽帧 → 用户看到的永远是错的图。
        //   故：持有【真实视频流】的卡（mp4/m3u8/…）不参与页面图兜底分配，
        //   保持无封面 → 由 card-render 的抽帧（hls.js / ffmpeg）产出真实首帧。
        //   只有站内链接卡（generic，无真实流，无法抽帧）才继续用页面图兜底。
        const hasRealStream = (d) => /\.(mp4|webm|m3u8|mov|m4v|mkv|ogv|flv|ts|mpg|mpeg|3gp|rm|rmvb|asf|vob|m2ts|f4v|m4s)(\?|$)/i.test(String((d && d.url) || ''));
        let pi = 0;
        pageVideoAssets.forEach((d) => {
          if (hasRealStream(d)) return;
          if (!d.cover && pi < pageImgs.length) { d.cover = pageImgs[pi].url; pi++; }
        });
      }
      // 把补好的封面同步回原始数组（networkAssets / deepVideoAssets），确保持久化与面板读取一致
      const syncCover = (arr) => {
        if (!Array.isArray(arr)) return;
        arr.forEach((d) => {
          const hit = pageVideoAssets.find((p) => p === d || (p.url && d.url && p.url.split('?')[0] === d.url.split('?')[0]));
          if (hit && hit.cover && !d.cover) d.cover = hit.cover;
        });
      };
      syncCover(deepVideoAssets);
      syncCover(networkAssets);
      // ★2026-08-18 修复：抖音 dyUrls 资产（CDN 直链）URL 与 pageVideoAssets（modal_id/RENDER_DATA 直链）
      // 不同，syncCover 按 url 匹配永远命中不了 → 抖音卡片无封面。这里显式回填：
      //   优先：从资产自身 playerUrl 解析 modal_id/aweme_id → byKey['aweme:<id>'] 精确封面
      //         （信息流多视频场景，每条抖音资产按其播放页精确取封面，避免错配）
      //   次优先：当前播放视频的 aweme 封面（__hmdao_current_aweme_id）
      //   兜底1：整页默认封面（RENDER_DATA aweme.cover）
      //   兜底2：extractVideoCovers 新增的 page-img 列表（抖音下载站等无 RENDER_DATA 页面的真实缩略图）
      const awemeIdFromUrl = (u) => {
        if (!u) return '';
        try {
          const parsed = new URL(u, 'https://www.douyin.com/');
          const q = parsed.searchParams;
          const fromQ = q.get('modal_id') || q.get('aweme_id') || '';
          if (fromQ) return fromQ;
          // ★2026-08-22 深层修复：支持 https://www.douyin.com/video/<awemeId> 路径格式
          // （scan.js 已用 awemeId 构造精确 playerUrl，此处需能反解回 awemeId 以精确取封面）。
          const m = /\/video\/(\w+)/.exec(parsed.pathname);
          return m ? m[1] : '';
        } catch (_) { return ''; }
      };
      const pageImgFallback = ((coverMap && coverMap.pageCovers) || []).filter((c) => c.kind === 'page-img');
      let pageImgCursor = 0;
      if (coverMap && (coverMap.defaultCover || (coverMap.byKey && Object.keys(coverMap.byKey).length) || pageImgFallback.length)) {
        (networkAssets || []).forEach((d) => {
          if (d && d.type === 'video' && d.source === 'douyin' && !d.cover) {
            // ★2026-08-22 深层修复：优先用资产自带 awemeId（scan.js 已构造，最精确），
            // 其次从 playerUrl 反解，再次用当前播放 aweme_id。避免搜索页共用 URL 导致全部错配。
            const idFromAsset = (d.awemeId && d.awemeId !== 'unknown') ? d.awemeId : '';
            const idFromPlayer = awemeIdFromUrl(d.playerUrl);
            const id = idFromAsset || idFromPlayer || (__hmdao_current_aweme_id || '');
            if (id && coverMap.byKey && coverMap.byKey['aweme:' + id]) {
              d.cover = coverMap.byKey['aweme:' + id];
            } else if (__hmdao_current_aweme_id && coverMap.byKey && coverMap.byKey['aweme:' + __hmdao_current_aweme_id]) {
              d.cover = coverMap.byKey['aweme:' + __hmdao_current_aweme_id];
            } else if (pageImgFallback[pageImgCursor]) {
              // ★2026-08-22 修复（搜索/信息流多视频错封面根因）：
              // 抖音搜索/推荐页 playerUrl 全部共用同一搜索页 URL，awemeIdFromUrl 全部解析到同一个 modal_id。
              // 此时若 modal_id 不在 byKey 里（旧逻辑会 fallback 到 coverMap.defaultCover = RENDER_DATA
              // 首个 aweme 的封面，可能恰好是某推广视频"电子营业执照"），导致所有 9 张卡片共用错封面。
              // 改为：pageImgFallback（页面内 <img> 真实可见缩略图）优先；无则保留空 cover（不显示错图）。
              d.cover = pageImgFallback[pageImgCursor].url;
              pageImgCursor++;
            } else if (coverMap.defaultCover) {
              d.cover = coverMap.defaultCover;
            }
          }
        });
      }
      logOnChange('cover', '[HMDAO][scan] 封面采集：byKey=' + (coverMap.byKey ? Object.keys(coverMap.byKey).length : 0)
        + ' defaultCover=' + !!coverMap.defaultCover + ' posters=' + posters.length
        + ' pageVideoAssets=' + pageVideoAssets.length);
    }
  } catch (e) {
    console.warn('[HMDAO][scan] extractVideoCovers 注入/执行失败（封面功能降级，不影响采集）：', e && e.message);
  }

  // ★修复：networkAssets（MAIN 世界抖音 dyUrls / 通用 audioPlays / 视频平台 videoPlays / 网络层捕获）
  // 此前只写进背景全局 NETWORK_ASSETS 持久化，却从未并入合并列表 → 抖音视频/音效永远采不到。
  // 现在与 ytPlay + pageAssets 一起进入合并（合并段按类型智能保留，不再被 VIDEO_HOST_RE 误杀）。
  let finalNetworkAssets = networkAssets;
  if (isBiliPlay) {
    // B站播放页：网络层会捕获多个 bilivideo 分片（音频流 / 视频流 / 不同 itag 清晰度）。
    // 这些其实是「同一个 B站视频」的多个流，必须去重为【单条】视频卡片，否则侧栏会出现
    // 多条「点击都是同一个视频」的素材。策略：只保留画质最高的「视频轨」（itag 最大），
    // 音频流(itag 较小或含 audio 标记)丢弃；封面由 extractVideoCovers 统一补。
    const bili = (networkAssets || []).filter((a) => a && a.type === 'video' && /bilivideo/i.test(a.url));
    // 非 B站视频流的网络资产（如页面里其它素材）始终保留
    const others = (networkAssets || []).filter((a) => !(a && a.type === 'video' && /bilivideo/i.test(a.url)));
    // ★封面回填：bilivideo 网络资产本身无 cover（background 只存 url/type/source），
    // 必须用 extractVideoCovers 采到的页面默认封面（B站 videoData.pic，原网无水印封面）回填，
    // 否则 B站视频卡片永远没封面。优先 defaultCover，其次 pageCovers[0]。
    const biliCover = (coverMap && coverMap.defaultCover) || (coverMap && coverMap.pageCovers && coverMap.pageCovers[0] && coverMap.pageCovers[0].url) || '';
    if (bili.length) {
      // 选「最高画质视频轨」：B站 bilivideo 分片含音频流(itag=30xxx)与视频流(itag<10000)，
      // 必须排除音频流（否则会选中 itag=30280 的音频而非视频）。策略：优先取 itag<10000 的视频流，取最大。
      const videoStreams = bili.filter((a) => {
        const it = Number((a.url.match(/itag[=_](\d+)/i) || [])[1] || 0);
        return it > 0 && it < 10000;
      });
      const pool = videoStreams.length ? videoStreams : bili;
      const pickHighest = pool.sort((x, y) => {
        const itx = Number((x.url.match(/itag[=_](\d+)/i) || [])[1] || 0);
        const ity = Number((y.url.match(/itag[=_](\d+)/i) || [])[1] || 0);
        return ity - itx;
      })[0];
      finalNetworkAssets = [...others, {
        url: pickHighest.url, type: 'video', source: 'bilibili',
        referer: 'https://www.bilibili.com', isBiliPlayAsset: true,
        platform: 'bilibili', biliPageUrl: biliPlayUrl,
        cover: biliCover,
      }];
      console.log('[HMDAO][scan] B站播放页 bilivideo 去重：', bili.length, '条分片 → 1 条（最高画质）');
    } else if (biliPlayUrl) {
      // ★2026-08-03：用户尚未播放、网络层无 bilivideo 被动捕获时，仍自动产出 B站视频资产，
      // url 用 B站页面地址（非过期裸流），让侧栏预览/下载时走 yt-dlp 真实解析（已实测可用：
      // BV1Wk3m6uEXG 返回 15 条 1080P~360P 格式）。全程不触碰源页播放器、不依赖播放动作。
      finalNetworkAssets = [...others, {
        url: biliPlayUrl, type: 'video', source: 'bilibili',
        referer: 'https://www.bilibili.com', isBiliPlayAsset: true,
        platform: 'bilibili', biliPageUrl: biliPlayUrl,
        cover: biliCover,
      }];
      console.log('[HMDAO][scan] B站播放页未捕获 bilivideo（用户未播放）→ 自动产出资产（url=页面地址，走 yt-dlp）');
    }
  }
  // ★2026-08-18 缩略图修复：YouTube ytPlay 资产此前不带 cover → 侧栏视频卡片永远显示 🎬 占位图。
  // 优先用 extractVideoCovers 采到的 og:image（watch 页默认封面）；缺失时按 video id 推导 i.ytimg.com 海报。
  function youtubeIdFromUrl(u) {
    try {
      const url = new URL(u, location.href);
      const h = url.hostname;
      if (/youtu\.be$/.test(h)) { const p = url.pathname.split('/').filter(Boolean)[0]; return p || ''; }
      if (/\byoutube\.com$/.test(h)) {
        const v = url.searchParams.get('v'); if (v) return v;
        const m = url.pathname.match(/\/(embed|shorts|v)\/([^/?#]+)/); if (m) return m[2];
      }
    } catch (_) {}
    return '';
  }
  const ytOgCover = (coverMap && coverMap.defaultCover) || '';
  const all = [
    ...ytPlay.map((u) => {
      const id = youtubeIdFromUrl(u);
      const cover = ytOgCover || (id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : '');
      return { url: u, type: 'video', source: 'youtube', cover };
    }),
    ...finalNetworkAssets,
    ...pageAssets,
    ...deepVideoAssets,
  ];
  // ★2026-08-02 增强去重：同一视频平台播放页/CDN 直链因签名参数不同会产生多条资产，
  // 旧逻辑按完整 URL 去重导致侧栏出现「多个相同视频」或「音频轨/视频轨」并存。
  // 新策略：
  //   1) 为抖音/新片场等资产补 playerUrl（平台播放页），供侧栏走 yt-dlp 统一解析；
  //   2) 按 playerUrl 归一去重；无 playerUrl 则按 normalizeVideoUrl(去查询参数) 归一；
  //   3) 同 key 保留信息更完整的资产（有标题/封面/平台页）。
  const dedupMap = new Map();
  // ★2026-08-21 二次修复：抖音视频「重复采集」根因——同一视频从两条来源进入合并列表：
  //   (1) 网络层 dyUrls（MAIN 捕获，awemeId 按 RENDER_DATA 顺序推断，易为 'unknown' 或错位）；
  //   (2) extractFreshVideoUrl 的 __douyinMulti items（awemeId 精确解析）。
  //   两者指向同一视频但 dedup key 不同（一个 'unknown'、一个真实 id）→ 产生重复卡片。
  //   解决方案：对抖音视频额外按「CDN 指纹(origin+pathname，剥离签名/range 参数)」跨来源去重，
  //   同一 CDN 文件只保留一条（优先保留带真实 awemeId/封面/matched 的精确版）。
  //   注意：不同集数的 dyUrls CDN pathname 不同 → 指纹不同 → 不会被误合并（合集多集数仍各自独立）。
  const cdnFpMap = new Map();
  function cdnFingerprint(u) {
    try {
      const url = new URL(u, location.href);
      return url.origin + url.pathname;
    } catch (_) { return u || ''; }
  }
  const RES_EXT_RE = /\.(mp4|webm|mov|m4v|mkv|ogv|m3u8|flv|avi|wmv|ts|mpg|mpeg|3gp|rm|rmvb|asf|vob|m2ts|f4v|m4s|mp3|wav|ogg|aac|m4a|flac|opus|gif|apng|webp|png|jpe?g|bmp|svg|avif|ico|tiff?|glb|gltf|obj|fbx|stl|dae|ply|max|blend|ma|mb|c4d|3ds|skp|wrl|x3d|abc|lwo|smd|vrm)([?#]|$)/i;
  // ★2026-08-18：图片扩展名兜底——小红书/微博等图床 CDN 图片 URL 路径无扩展名，
  // 真实格式藏在 ?format=webp / imageView2 等参数里，RES_EXT_RE 的 ([?#]|$) 截断会把它丢弃。
  // 这里补一组「无扩展名但可判定为图片」的判定：已知图床 host，或 URL query 含图片格式参数。
  // ★2026-09-10 补 akamaized\.net（Akamai 图片 CDN，MSN 等大量新闻/媒体站使用）：
  //   MSN 图片形如 https://img-s-msn-com.akamaized.net/tenant/amp/entityid/AA1xYzQ?w=300&h=200&f=jpg
  //   ——① 路径无扩展名（RES_EXT_RE 的 ([?#]|$) 截断 → 不命中）；
  //     ② host 原不在本白名单（不命中）；③ query 用 f= 而非 format=（query 分支不命中）。
  //   三道判定全落空 → 网络层捕获的 MSN 图片被判为「非图片」全部丢弃，侧栏永远空白。
  const IMG_CDN_HOST_RE = /(xhscdn\.com|sns-img|xiaohongshu\.com|weibo(pic)?\.com|sinaimg\.cn|douyinpic|tiktokcdn|byteimg\.com|pstatp\.com|byteimg|iqiyipic|youku\.com|alicdn\.com|douyinpic\.com|hbimg\.|upaiyun\.com|huaban\.com|akamaized\.net)/i;
  function looksLikeImageUrl(u) {
    if (!u) return false;
    if (RES_EXT_RE.test(u)) return true;
    try {
      const url = new URL(u, location.href);
      if (IMG_CDN_HOST_RE.test(url.hostname)) return true;
      // query 里显式声明图片格式（format=webp/jpg/png、或 imageView2/thumbnail 图床处理参数）
      // ★2026-09-07 补全：avif/svg/ico/tiff/heic/heif 也判为图片（无扩展名图床用 format 参数暗示格式）
      // ★2026-09-10 补 f= 变体：MSN 的 Akamai 图床用 ?...&f=jpg（不是 format=），
      //   否则 MSN 图片即便命中 host 白名单外的来源也仍会被丢。值限定为图片格式，避免误伤 f=其它语义。
      if (/[?&]((?:format|f)=(webp|jpg|jpeg|png|gif|avif|bmp|svg|ico|tiff|heic|heif)|imageView2|thumbnail|imageMogr2|x-oss-process=image)/i.test(url.search)) return true;
    } catch (_) {}
    return false;
  }
  // ★2026-09-16 修复（B站/主流图床封面重复根因）：剥离 URL pathname 末尾的尺寸/格式处理后缀，
  //   让同一张图的不同变体（如 xxx.jpg@672w_378h_1c.webp 与 @336w_189h_1c.webp）在去重中合并为一张。
  function normalizeImagePathname(p) {
    return String(p || '')
      .replace(/~tplv-[^/]*$/i, '')            // 字节系：~tplv-xxx-aigc_resize_loss:480:480.webp
      .replace(/!\w+$/i, '')                   // 又拍云：xxx.png!w600_webp
      .replace(/:\d{1,5}:\d{1,5}\.\w{2,5}$/i, '') // 残留 :480:480.webp
      .replace(/:\d{1,5}:\d{1,5}$/i, '')
      .replace(/@\d+w_\d+h(_\d+c)?\.\w+$/i, '') // B站：xxx.jpg@672w_378h_1c.webp / @336w_189h.webp
      .replace(/@!?\w+\.\w+$/i, '')             // 其他 @ 处理后缀（@!web / @xxx.webp）
      .replace(/[-_]\d{2,4}x\d{2,4}$/i, '');   //  basename 中的 -480x480 尺寸后缀
  }
  // ★2026-09-08 修复（即梦侧栏 200 张杂图根因）：html-fallback 是「正则扫页面 HTML 文本」的
  //   最后兜底，会把编辑器贴纸/头像/素材库等所有 CDN 变体全捞进来（实测即梦 html-fallback:156
  //   vs 真实 DOM img:44）。既然 DOM 里已有真实 <img>（DEF_IMG_SRC 命中），HTML 文本兜底就是
  //   纯噪音 → 直接丢弃，只保留 DOM 收集的真实图片。
  const hasDomImgs = all.some((x) => x && x.type === 'image' && /^(img|picture|img\[srcset\]|a>img|css-bg)$/.test(x.source || ''));
  // ★2026-09-08：去重前先剔除「被截断 / 无媒体扩展名」的视频候选（同源存在更完整候选时）。
  //   必须在 dedup 之前——截断 URL 与完整 URL 的 dedup key 不同（URL 不同），
  //   两者会各自成为一张卡，去重根本拦不住，只能在这里按"同源更完整候选"消解。
  const dedupSrc = dropTruncatedVideoAssets(all);
  for (const a of dedupSrc) {
    if (!a) continue;
    const u = (a.url || '').split('#')[0];
    if (!u) continue;
    if (hasDomImgs && a.type === 'image' && a.source === 'html-fallback') continue;
    // 图片：带资源扩展名 / 已知图床 / query 含图片格式参数 才保留；否则（裸页面导航 URL）丢弃
    // ★2026-09-07 修复（avif 等真实图片被误杀根因）：仅「启发式来源」(html-fallback / img[data] 等从属性/文本
    //   猜出的 URL) 才用 looksLikeImageUrl 过滤裸页面导航 URL；<img> / <picture> / <css-bg> / a>img 是浏览器
    //   已渲染的真实图片元素，其 src 必为图片，绝不因「无扩展名 / 非图床 host」被丢弃（否则 fastcampus 等用
    //   无扩展名 CDN 或 <picture> 多候选交付的 avif 永远采不到）。
    const DEF_IMG_SRC = /^(img|img\[srcset\]|picture|css-bg|a>img)$/;
    if (a.type === 'image' && !DEF_IMG_SRC.test(a.source || '') && !looksLikeImageUrl(u)) continue;
    // 媒体/模型/动图直链：无条件保留
    const isMediaOrModel = a.type === 'video' || a.type === 'audio' || a.type === 'model' || (a.animated === true);
    if (!isMediaOrModel && a.type !== 'image' && a.type !== 'archive' && a.type !== 'netdisk' && a.type !== 'link') continue;

    // 统一生成去重 key:
    // - playerUrl 含明确视频 ID(modal_id / a12345 等)时按 playerUrl 归一(解决同一视频多条签名直链)
    // - 否则按 normalizeVideoUrl(去签名参数)+ pageUrl 归一(避免信息流不同视频被误合并)
    // - ★2026-08-21 修复:抖音合集多视频场景(platform:'douyin' + source:'douyin/deep-parse' + awemeId),
    //   旧逻辑把同一合集页 playerUrl+modal_id 视为同 key → 合集内多条不同集数被合并。
    //   例外:有 awemeId 时,按「平台|url的origin-pathname|awemeId」区分(剥离 ?signature= ?range= 等签名),
    //   让多个 dyUrls(每集独立 CDN URL)精准区分;同集数多分辨率(play_addr/play_addr_h265)仍合并。
    let key;
    if (a.platform === 'douyin' && a.awemeId) {
      // 抖音合集 dedup 用 awemeId 区分(同集数多 URL 自然合并为 1 条;不同集数各自独立)。
      key = 'douyin|' + String(a.awemeId) + '|' + (a.type || 'video');
    } else if (a.playerUrl && playerUrlHasVideoId(a.playerUrl)) {
      key = (a.playerUrl || '') + '|' + (a.type || 'video');
    } else {
      // ★2026-09-08 修复（即梦 400+ 张重复图片卡根因）：字节系图床会给同一张图生成
      //   一堆处理变体（~tplv-xxx-aigc_resize_loss:480:480.webp / :720:720.webp / !w600_webp），
      //   变体在【pathname】里而非 query → normalizeVideoUrl 剥不掉 → 同一张图被拆成
      //   几百张卡。图片类去重键按「剥离处理段后的规范路径」归一，同图多尺寸合并为一张。
      let keyUrl = normalizeVideoUrl(u);
      if (a.type === 'image') {
        try {
          const ku = new URL(keyUrl);
          ku.pathname = normalizeImagePathname(ku.pathname);
          keyUrl = ku.href;
        } catch (_) {}
      }
      key = keyUrl + '|' + (a.type || 'video') + '|' + (a.pageUrl || '');
    }
    // ★2026-08-22 修复（封面/内容错配 + 重复扫描根因）：
    // 1. 上轮 cdnFpMap 的 continue 越权：单视频场景下所有 dyUrls 共用同一 awemeId（modal_id），
    //    key dedup 本应合并为 1 条，但 cdnFpMap 因 CDN 指纹不同直接 continue 跳过 key dedup，
    //    导致每条 CDN URL 都成为独立卡片（用户截图显示 9 张同源卡片）。
    // 2. 修复策略：cdnFpMap 不再 continue 越权跳过 key dedup，改为只对"key 已不同但 CDN 同文件"
    //    的跨来源场景兜底（同 CDN 文件不同来源版本仍合并；同来源多 CDN 不再被越权分开）。
    // 3. 信息流多集数场景：每集 dyUrls CDN pathname 不同 → CDN 指纹不同 → 不会被 cdnFpMap 合并，
    //    交由 awemeId-based key dedup（已修复为 modal_id 优先 + ids[seq]/ids[last]）正确区分。
    if (a.platform === 'douyin' && a.type === 'video') {
      const fp = cdnFingerprint(u);
      if (fp) cdnFpMap.set(fp, a); // 仅登记，不 continue
    }
    const existing = dedupMap.get(key);
    if (existing) {
      if (preferAsset(a, existing)) dedupMap.set(key, a);
      continue;
    }
    dedupMap.set(key, a);
  }
  const merged = Array.from(dedupMap.values());

  // ★2026-08-22 修复（真机日志实证根因）：单视频模式（!batchMode）下，抖音 jingxuan/video 播放页
  //   经 scanPage DOM 通用嗅探会产出 128 条素材（含推荐位图片/视频/下载链接/3D模型），与用户要的
  //   "当前播放的 1 条视频"无关，导致侧栏刷出大量错配卡片（封面/标题对不上）。
  //   此前"单视频只取末条"只压 dyUrls，不压 DOM 嗅探产物 → 用户仍看到 128 条。
  //   修复：单视频模式只保留"当前播放视频"相关的 1 条（优先带真实 awemeId 的抖音视频 / dyUrls 末条），
  //   其余媒体/图片/链接类非当前视频资产全部丢弃。批量模式（batchMode）不受影响，保留合集多集数。
  let finalMerged = merged;
  // ★2026-08-23 修复（确凿根因）：原正则 /\/(jingxuan|video|note|discover|search|recommend|explore)/
  //   要求路径段后必须是 "/" 才能匹配，但 jingxuan?modal_id=... 是 "jingxuan?" → 正则不命中，
  //   单视频过滤跳过 → 抖音播放页被当非播放页 → dyUrls/DOM 嗅探产物全部保留（用户实测 85 条）。
  //   修复：用 (pathname 只到该段) 而非后跟 "/"——jingxuan 是路径末尾 + query，video 是路径段后跟数字或 /。
  const isDouyinPlayPage = /(^|\.)douyin\.com\/jingxuan(\?|$)/i.test(targetTabUrl)
    || /(^|\.)douyin\.com\/(video|note|discover|search|recommend|explore)(\/|\?|$)/i.test(targetTabUrl)
    || /(^|\.)iesdouyin\.com/i.test(targetTabUrl);
  logOnChange('filterJudge', '[HMDAO][scan] 单视频过滤判定: batchMode=' + !!batchMode
    + ' isDouyinPlayPage=' + isDouyinPlayPage + ' url=' + targetTabUrl + ' mergedLen=' + merged.length);
  // ★2026-09-05 修复：jingxuan?modal_id=... 同时可能是抖音合集页（有 mixId）。
  //   合集页应列出全部集数，不能按单视频模式过滤成 1 条；只有无 mixId 的单视频/播放页才走单视频过滤。
  const hasMixId = !!pageMixId;
  if (!batchMode && isDouyinPlayPage && !hasMixId) {
    const curAweme = __hmdao_current_aweme_id || '';
    // ★2026-09-01 修复（用户实测「侧栏视频资产是充值页」「深度解析产出 1 条但最终 0 条」根因）：
    //   抖音 /falcon/ 是 H5 功能页容器（充值页 douyin_recharge、webcast_openpc、活动页、
    //   电子营业执照、登录页…）。DOM 通用嗅探会把这些页面链接误判为 type:'video' 混入
    //   videoAssets → 被选中当「当前播放视频」keepVideo → 下面 finalMerged 只保留 keepVideo
    //   → 真正的视频被丢弃，侧栏只剩充值页（或全空）。
    //   这些 URL 根本不是视频流，必须在选 keepVideo 之前排除。
    const isNonVideoPage = (u) => /\/falcon\/|douyin_recharge|webcast_openpc|\/passport\/|electronic_license|营业执照|biz_license/i.test(u || '');
    const allVideoAssets = merged.filter((a) => a && a.type === 'video' && !isNonVideoPage(a.url));
    // ★2026-09-01 修复（用户实测「侧栏视频 = blob: 播不了也下不了」根因）：
    //   抖音 PC 网页播放器走 MSE + blob（<video src="blob:https://www.douyin.com/...">），
    //   DOM 嗅探把这个 blob 收成视频资产，而旧逻辑取「末条」→ 正好选中 blob。
    //   blob: 只在创建它的页面上下文有效，扩展后台/侧栏读不到字节
    //   （实测 FETCH_MEDIA failed url=blob:... + ERR_FILE_NOT_FOUND），
    //   既不能预览也不能下载。必须优先真实 CDN 直链（inject-main 捕获的 douyinvod 直链）；
    //   仅在【完全没有】真实直链时才退回 blob（保底有卡片，预览走源页帧流）。
    const isBlobUrl = (u) => /^blob:/i.test(u || '');
    // ★2026-09-01 补修复（用户实测「侧栏变成抖音 PC 客户端安装包」根因）：
    //   上一版只做「非 blob 优先」太粗糙——DOM 嗅探产出的 "video" 里还混着
    //   https://www.douyin.com/download/pc/obj/douyin-pc-web/douyin-pc-client/...（PC 客户端安装包）、
    //   各类 /download/ 页面链接等 http 地址。它们是当时唯一的非 blob 项 → 被优先选中
    //   → 侧栏出现安装包卡片，且因不是 blob 而【绕过】了下面的「blob 升级为真实直链」分支，
    //   导致既没有直链也没有分辨率。
    //   必须按「是否真实视频直链」判定：抖音 CDN 域名族，或明确视频扩展名。
    const isRealVideoUrl = (u) => {
      if (!u || typeof u !== 'string') return false;
      if (/^blob:/i.test(u)) return false;
      // 抖音/头条系视频 CDN 域名族
      if (/douyinvod\.(com|net)|douyinstatic|bytevcloud|byteimg|\.amemv\.|ixigua|tiktokcdn|tiktokv/i.test(u)) return true;
      // 明确视频扩展名
      if (/\.(mp4|webm|mov|m4v|flv|m3u8|mkv)(\?|&|$)/i.test(u)) return true;
      return false;
    };
    const videoAssets = allVideoAssets.filter((a) => isRealVideoUrl(a.url));
    const blobOnlyAssets = allVideoAssets.filter((a) => isBlobUrl(a.url));
    // 优先级：① 真实 CDN 直链（最佳）② blob（下面会用 awemeId 升级成真实直链）③ 其余兜底
    const pickFrom = videoAssets.length ? videoAssets : (blobOnlyAssets.length ? blobOnlyAssets : allVideoAssets);
    // 当前播放视频：优先 awemeId 命中，其次任一抖音视频（单视频页通常只有 1 条）
    let keepVideo = null;
    if (curAweme && pickFrom.some((a) => a.awemeId === curAweme)) {
      keepVideo = pickFrom.find((a) => a.awemeId === curAweme);
    } else if (pickFrom.length) {
      keepVideo = pickFrom[pickFrom.length - 1]; // 末条 = 当前播放（inject-main 顺序保证）
    }
    if (keepVideo) {
      // ★2026-08-23 修复（"单视频模式点当前卡片仍刷新/匹配不上"根因）：
      //   单视频模式侧栏只有"当前播放"这 1 张卡片。点它本应 = 当前播放视频，【绝不该跳页刷新】。
      //   但旧逻辑卡片 modalId=awemeId(视频实体id)，与源页 jingxuan?modal_id=<feedId>(地址栏当前页) 不等
      //   → switchDouyinEpisodeTo 判定"不同" → tabs.update 整页跳转 = 刷新。
      //   修复：单视频模式下，把保留卡片的 modalId 强制设为【源页 URL 的 modal_id】(=地址栏当前视频)
      //   → 与源页 curId 完全相等 → 命中"同一视频"分支 → 不跳页、直接在源页 play()。
      //   这是真实匹配：单视频页地址栏的 modal_id 就是用户正在看的视频，无虚假数据。
      let pageModal = '';
      try {
        const lu = new URL(targetTabUrl || '');
        pageModal = lu.searchParams.get('modal_id') || lu.searchParams.get('aweme_id') || '';
      } catch (_) {}
      if (pageModal) keepVideo.modalId = pageModal;
      // ★2026-09-01 关键修复：把 blob 资产「升级」成可下载的真实直链。
      //   抖音 PC 走 MSE 时 <video src> 就是 blob，此时 dyUrls 可能为空（视频已预加载/命中缓存，
      //   未再发起新的 CDN 请求）→ 上面 pickFrom 只能退回 blob。
      //   blob 在扩展侧读不到字节（不能预览也不能下载），但它带 awemeId，
      //   而【详情 API 索引 dyFormatsByAweme 里存着该 awemeId 的完整多画质直链】
      //   → 用默认档（download_addr，含音画整段）替换 url，并挂上 dyFormats 供侧栏选分辨率。
      //   这样即使源页只暴露 blob，用户依然能选 1080p/540p 并真正下载到本地。
      if (/^blob:/i.test(keepVideo.url || '')) {
        try {
          const aid = String(keepVideo.awemeId || pageModal || '').replace(/[^\w]/g, '');
          if (aid) {
            const [fr] = await chrome.scripting.executeScript({
              target: { tabId }, world: 'MAIN',
              func: (id) => {
                try {
                  const c = window.__hmdao_captures || {};
                  // ★2026-09-01 决定性修复（用户实测真实数据）：
                  //   window.player.url = [{src:"https://v26-web.douyinvod.com/..."}, {src:"https://v11-weba..."},
                  //                        {src:"https://www.douyin.com/aweme/v1/play/?..."}, ...]
                  //   关键事实：
                  //     · 只有 src 键，【没有】 name/definition/label（definition 探针返回 undefined）
                  //     · douyinvod 域名的是【真实 CDN 直链】；/aweme/v1/play/ 是跳转接口，
                  //       直接下载会拿到 HTML 而非视频字节，必须排除
                  //     · 这是播放器【正在使用】的直链，鉴权（签名/Cookie/Referer）由播放器算好，
                  //       比我们自行抓 CDN 请求可靠得多——不怕签名过期、不怕 403
                  //   故优先级：player 真直链 > 详情 API 索引（后者实测常为空）。
                  const playerUrls = [];
                  try {
                    const p = window.player;
                    if (p && Array.isArray(p.url)) {
                      for (const it of p.url) {
                        const u = (typeof it === 'string') ? it : ((it && (it.src || it.url)) || '');
                        if (typeof u !== 'string' || !/^https?:/i.test(u)) continue;
                        if (!/douyinvod\.(com|net)|bytevcloud|ixigua/i.test(u)) continue;
                        if (playerUrls.indexOf(u) < 0) playerUrls.push(u);
                      }
                    }
                  } catch (_) {}
                  const m = c.dyFormatsByAweme || {};
                  let f = m[String(id)] || null;
                  // ★兜底：地址栏 modal_id（feedId）与详情 API 的 awemeId（视频实体 id）
                  //   在抖音并不总是相等，直接按 id 取可能落空。
                  //   单视频场景里索引通常只有 1 个键，此时页面当前就这一个视频，
                  //   直接采用它（真实数据，非猜测）。
                  if ((!Array.isArray(f) || !f.length) && Object.keys(m).length === 1) {
                    f = m[Object.keys(m)[0]];
                  }
                  const formats = (Array.isArray(f) && f.length)
                    ? f.map((x) => ({ label: (x && x.label) || '默认', url: (x && x.url) || '', is_default: !!(x && x.is_default) }))
                    : [];
                  // 旧代码在这里 `if (!f.length) return null` —— 会在 player 有真直链、
                  // 但详情索引为空时【提前返回 null】，导致真直链永远用不上。已移除该提前返回。
                  let url = playerUrls[0] || '';
                  if (!url && formats.length) {
                    const def = formats.find((x) => x.is_default) || formats[0];
                    url = (def && def.url) || '';
                  }
                  // ★2026-09-04 再兜一层：详情/合集列表 API 抓到的 play_addr 直链（dyVideoUrlByAweme）。
                  //   window.player.url 与 dyFormatsByAweme 都可能为空（页面刚切过来、档位未下发），
                  //   这时 play_addr 是最后能拿到真实直链的来源。
                  if (!url) url = (c.dyVideoUrlByAweme || {})[String(id)] || '';
                  if (!url) {
                    const vKeys = Object.keys(c.dyVideoUrlByAweme || {});
                    if (vKeys.length === 1) url = c.dyVideoUrlByAweme[vKeys[0]] || '';
                  }
                  // 详情索引无档位但 player 有多条真直链（不同 CDN 节点）→ 都列为可选项
                  if (!formats.length && playerUrls.length > 1) {
                    playerUrls.forEach((u, i) => formats.push({ label: '源 ' + (i + 1), url: u, is_default: i === 0 }));
                  }
                  return {
                    url,
                    formats,
                    playerUrls,
                    // ★2026-09-01：封面一并带回。blob 资产由 DOM 嗅探产生，通常没有 awemeId，
                    //   导致 scan.js 构建 dyAssets 时 cover 取不到 dyCoverByAweme[aid] → 卡片显示 ⛔。
                    //   这里按同一 id 从详情 API 索引取回封面，保证卡片有缩略图。
                    cover: (c.dyCoverByAweme || {})[String(id)] || '',
                    title: (c.dyTitlesByAweme || {})[String(id)] || '',
                  };
                } catch (_) { return null; }
              },
              args: [aid],
            });
            const r = fr && fr.result;
            if (r && r.url && /^https?:/i.test(r.url)) {
              console.log('[HMDAO][scan] blob 资产升级为真实直链 awemeId=%s url=%s', aid, String(r.url).slice(0, 64));
              keepVideo.url = r.url;
              if (r.formats && r.formats.length) keepVideo.dyFormats = r.formats;
              // 封面/标题/awemeId 一并补齐：blob 资产由 DOM 嗅探产生，这些字段通常缺失，
              // 缺 cover 会让卡片显示 ⛔（card-render.js 无封面源分支），
              // 缺 awemeId 会让后续按 id 取分辨率/切集全部落空。
              if (r.cover && !keepVideo.cover) keepVideo.cover = r.cover;
              if (r.title && !keepVideo.title) keepVideo.title = r.title;
              if (!keepVideo.awemeId && aid) keepVideo.awemeId = aid;
            }
          }
        } catch (_) {}
      }
      // ★2026-09-04 修复（"切换集数后没画面没声音"根因）：
      //   blob: 是创建它的那个文档私有的，扩展后台/侧栏跨上下文 fetch 必然失败
      //   （日志：FETCH_MEDIA failed url=blob:https://www.douyin.com/... detail={ok:false,error:'Failed to fetch'}）。
      //   上面若没能把它升级成 http 直链，继续保留就是一张"点了只有加载失败"的废卡。
      //   处理：优先在同 awemeId 的其它资产里换一条真实直链；换不到就丢弃，宁缺勿废。
      if (keepVideo && !/^https?:/i.test(keepVideo.url || '')) {
        const kbAid = String(keepVideo.awemeId || '').replace(/[^\w]/g, '');
        const alt = allVideoAssets.find((a) => a && a !== keepVideo && /^https?:/i.test(a.url || '')
          && (!kbAid || String(a.awemeId || '').replace(/[^\w]/g, '') === kbAid || !a.awemeId));
        if (alt) {
          keepVideo = alt;
          console.log('[HMDAO][scan] blob 升级失败 → 改用同 awemeId 的真实直链资产');
        } else {
          console.log('[HMDAO][scan] blob 升级失败且无替代直链 → 丢弃该视频卡（避免"没画面没声音"废卡）');
          keepVideo = null;
        }
      }
      // 仅保留当前视频 + 其关联音频（同 awemeId，供预览配音），其余全部丢弃
      finalMerged = merged.filter((a) =>
        a === keepVideo
        || (a && a.type === 'audio' && curAweme && a.awemeId === curAweme)
        // ★keepVideo 可能因"blob 升级失败且无替代直链"被置空，此处必须先判空再取 .url，否则 TypeError
        || (a && a.type === 'audio' && !curAweme && a.url && keepVideo && keepVideo.url && a.url.includes(keepVideo.url.slice(0, 40)))
      );
      logOnChange('singleFilter', '[HMDAO][scan] 单视频模式过滤：' + merged.length + '条 → ' + finalMerged.length
        + '条（保留当前播放视频, modalId=' + pageModal + '）');
    } else {
      // 无任何视频资产时，DOM 嗅探到的图片/链接等仍丢弃（单视频页不应有无关素材）
      finalMerged = [];
      console.log('[HMDAO][scan] 单视频模式：无抖音视频资产，清空', merged.length, '条 DOM 嗅探产物');
    }
  }

  // ★2026-09-03：抖音页丢弃「野卡」。
  //   实测（用户侧栏诊断）：唯一一张卡 title 竟然是网页标题「发现更多精彩视频 - 抖音搜索」、
  //   platform 为空、awemeId 为无 —— 这是通用 DOM/网络扫描捡到的非视频产物，会顶替真正的视频卡误导用户。
  //   仅在本次扫描【已经产出抖音专属卡（带 awemeId）】时才丢弃，避免抖音专属路径全失效时侧栏彻底空白。
  try {
    const dyHost = (function () { try { return new URL(targetTabUrl || '').hostname; } catch (_) { return ''; } })();
    if (/(?:^|\.)(douyin\.com|ixigua\.com|tiktok\.com)$/i.test(dyHost)) {
      const hasDyCard = finalMerged.some((a) => a && a.type === 'video' && a.awemeId);
      if (hasDyCard) {
        const before = finalMerged.length;
        finalMerged = finalMerged.filter((a) => !(a && a.type === 'video' && !a.awemeId));
        if (before !== finalMerged.length) {
          console.log('[HMDAO][scan] 抖音页丢弃无 awemeId 的野卡：%d → %d 条', before, finalMerged.length);
        }
      }
    }
  } catch (_) {}

  // ★2026-09-07 修正（画廊/课程页真实素材被误杀根因）：原硬上限 60 张，仅对抖音"百张头像/图标"降负载合理，
  //   但在 fastcampus 这类课程/画廊页（100+ 张图，用户要采的草稿图恰是后注入、score=0 的低分项）会被整批砍掉 →
  //   用户「等网站稳定重新扫描仍采不到 webp」的真凶。改为大幅抬高上限到 200：正常内容页(含 106 图)不再裁剪，
  //   仍只对极端大页(>200 张)做降负载；视频/音频/3D/网盘等用户真正要采的类型不受限制。
  try {
    const MAX_IMAGE_ASSETS = 200;
    const imgs = finalMerged.filter((a) => a && a.type === 'image');
    if (imgs.length > MAX_IMAGE_ASSETS) {
      // ★2026-09-07：真实渲染的图片元素（img/picture/css-bg/a>img）加权 +4，优先于 html-fallback 等
      //   启发式副本保留——避免大图库页(>200 张)裁剪时把用户真正要的 avif/内容图当成低分项丢掉。
      const score = (a) => (a.cover ? 2 : 0) + (a.dimensions ? 2 : 0) + (a.width ? 1 : 0) + (a.title ? 1 : 0) + (/^(img|img\[srcset\]|picture|css-bg|a>img)$/.test(a.source || '') ? 4 : 0);
      const keep = new Set(imgs.slice().sort((x, y) => score(y) - score(x)).slice(0, MAX_IMAGE_ASSETS));
      const before = finalMerged.length;
      finalMerged = finalMerged.filter((a) => !(a && a.type === 'image') || keep.has(a));
      console.log('[HMDAO][scan] 图片资产裁剪（降负载，上限200）：%d → %d 条', before, finalMerged.length);
    }
  } catch (_) {}

  // ★2026-09-04：封面最终消毒（兜住所有来源，不只是 hmdaoPickCover）。
  //   实测封面被填成 https://lf-zt.douyin.com/obj/uc-assets/zt/@byted/x-storage-web/.../index.html
  //   —— 这是 x-storage-web 的 iframe 页面（HTML 文档），经 /api/media-proxy 代拉必然
  //   422 / ERR_BLOCKED_BY_RESPONSE.NotSameSite → 缩略图永远空白。非图片资源一律清掉。
  try {
    let dropped = 0;
    for (const a of finalMerged) {
      if (a && a.cover && typeof a.cover === 'string') {
        if (!/^https?:/i.test(a.cover) || /\.(html?|js|css|json|txt|xml)(\?|#|$)/i.test(a.cover)) {
          a.cover = '';
          dropped++;
        }
      }
    }
    if (dropped) console.log('[HMDAO][scan] 丢弃非图片封面 %d 个（HTML/JS 等不能当缩略图）', dropped);
  } catch (_) {}

  // ★2026-09-08 恢复（imini 等「页面无 <video> 元素」站点此前能出带声音视频卡的原因）：
  //   实测 imini /zh/video：document.querySelectorAll('video') = 0，源页预览本身静音，
  //   此前唯一能拿到【音视频合并完整流】的入口是「站内链接 → generic 平台卡 → yt-dlp 解析」。
  //   为消除"无封面/点不开/标题是网页标题"的假卡，上一版把同站内链全部过滤 → 这类站
  //   连视频卡都没了（用户反馈"之前有声音，现在没有"）。
  //   折中：仅当本次扫描【一条视频/音频都没有】时，才补一张「整页 generic 卡」
  //   （playerUrl = 页面地址，交 yt-dlp 解析合并流）。有真实素材的页面完全不受影响，
  //   既不会回到"一堆假卡污染列表"，又能恢复 imini 这类站的带音频预览/下载。
  try {
    const hasMedia = finalMerged.some((a) => a && (a.type === 'video' || a.type === 'audio'));
    if (!hasMedia && /^https?:/i.test(targetTabUrl || '')) {
      let p = '';
      try { p = new URL(targetTabUrl).pathname; } catch (_) { p = ''; }
      if (/\/(video|watch|play|media|shorts|detail|mv|live)\b/i.test(p)) {
        finalMerged.push({
          url: targetTabUrl, type: 'video', source: 'embed-platform',
          platform: 'generic', playerUrl: targetTabUrl, pageUrl: targetTabUrl,
        });
        console.log('[HMDAO][scan] 页面无 DOM 媒体 → 补整页 generic 卡交 yt-dlp 解析（恢复带音频的合并流）');
      }
    }
  } catch (_) {}
  NETWORK_ASSETS[tabId] = finalMerged;
  // ★P2（2026-08-01）：给每个资产补 tabId/pageUrl/playerUrl，供侧栏悬停试听/yt-dlp 解析使用。
  // ★2026-09-08 修复（TDZ）：srcPageUrl/pageTitle 原本声明在【下一次使用之后】，
  //   上一行 NETWORK_ASSETS_URL[tabId] 读 srcPageUrl 时它还在 TDZ（let 未初始化）
  //   → 抛 ReferenceError 被 catch(_) 静默吞掉 → NETWORK_ASSETS_URL 从未被赋值
  //   → scanTab 的「是否真正换页」判定失去依据（换页清空/保留逻辑失效）。
  //   把声明提到使用之前即可。
  let srcPageUrl = '';
  let pageTitle = '';
  // ★2026-08-23 修复：记录本次扫描的页面 URL，供下次 scanTab 判断是否"真正换页"以决定清空源页累积。
  try { NETWORK_ASSETS_URL[tabId] = (targetTabUrl || srcPageUrl || ''); } catch (_) { }
  try {
    const t = await chrome.tabs.get(tabId);
    srcPageUrl = (t && t.url) || '';
    pageTitle = (t && t.title) || '';
  } catch (_) {}
  // ★2026-09-16 F5：从 title-extract.js（MAIN 世界）经 DOM 桥接读回页面素材标题
  //   byUrl：按"素材 URL"精确关联的标题（high）；pageLevel：页面/平台级单标题，仅当页面只有 1 个视频元素时
  //   才视为"主视频标题"（mid），多视频/合集/画廊页不套用，避免几十张卡同名/图配错标题（防错位）。
  let __titleByUrl = {}, __titleMainVideo = null;
  try {
    const raw = document.documentElement.getAttribute('data-hmdao-titles');
    if (raw) {
      const parsed = JSON.parse(raw) || {};
      __titleByUrl = parsed.byUrl || {};
      if (parsed.pageLevel && parsed.pageLevel.title && parsed.pageLevel.videoCount === 1) {
        __titleMainVideo = parsed.pageLevel.title;
      }
    }
  } catch (_) {}
  const __titleUrlBase = (u) => String(u || '').replace(/[?#].*$/, '');
  const __titleByUrlMatch = (u) => {
    if (!u) return null;
    const k = __titleUrlBase(u);
    if (__titleByUrl[k]) return __titleByUrl[k];
    for (const key in __titleByUrl) { if (__titleUrlBase(key) === k) return __titleByUrl[key]; }
    return null;
  };
  // ★2026-09-16 修复（图片卡全用主页标题根因）：按图片自身 alt / URL 基文件名派生标题。
  function deriveImageName(a) {
    const alt = String(a.alt || '').trim();
    if (alt && alt.length > 2 && !/^\d+$/.test(alt) && !/\b(logo|icon|avatar|banner|spacer|placeholder|loading|default|cover|thumb)\b/i.test(alt)) {
      return alt;
    }
    try {
      const u = new URL(a.url);
      let name = decodeURIComponent(normalizeImagePathname(u.pathname).split('/').pop() || '');
      name = name.replace(/[-_]\d{2,4}x\d{2,4}$/i, '').replace(/[-_]?\d+$/, '').trim();
      if (name && name.length > 1) return name;
    } catch (_) {}
    return '';
  }
  for (const a of merged) {
    if (!a) continue;
    a.tabId = tabId;
    if (!a.pageUrl) a.pageUrl = srcPageUrl;
    // ★2026-09-16 F5：素材本身标题（按 URL 精确关联，绝不按位置套用，防错位）
    if (!a.title) {
      const hit = __titleByUrlMatch(a.url);
      if (hit && hit.title) {
        a.title = hit.title;                                   // per-asset URL 命中（high）
      } else if (__titleMainVideo && a.type === 'video' && !(a.platform === 'douyin' && a.type === 'video')) {
        a.title = __titleMainVideo;                            // 页面级主视频标题（mid，仅单视频页）
      }
    }
    // ★2026-09-16 修复：图片卡标题绝不用 pageTitle 兜底，改用自身 alt 或 URL 基文件名，
    //   避免同一页面所有图片卡显示同一个主页标题。
    if (!a.title && a.type === 'image') {
      const nm = deriveImageName(a);
      if (nm) a.title = nm;
    }
    // ★2026-09-04 修复：不要把【页面标题】填给抖音视频卡。抖音视频标题应从详情 API 的 desc 取；
    //   取不到时显示"第N集"或"视频素材"都比"抖音精选电脑版 - 抖音"这种页面标题准确一万倍，
    //   也不会造成批量模式下几十张卡同名、用户以为"内容对应不上"。
    // ★2026-09-16 F5 防错位：整页兜底（low）仅对"主视频"（单视频页 videoCount===1，__titleMainVideo 已置）
    //   与音频/模型/归档等资产保留；多视频/列表页的视频与图片资产不再套用 pageTitle。
    if (!a.title && pageTitle && !(a.platform === 'douyin' && a.type === 'video')) {
      if ((a.type !== 'video' && a.type !== 'image') || (__titleMainVideo && a.type === 'video')) a.title = pageTitle;
    }
    if (!a.name && a.title) a.name = a.title;
    // 为抖音/新片场等资产补 playerUrl，让侧栏识别为 yt-dlp 平台并走统一解析
    if (!a.playerUrl && srcPageUrl) {
      // ★2026-08-18 修复：素材库页 stock.xinpianchang.com/footage/details/<id>.html
      //   与文章页 www.xinpianchang.com/a<数字> 都是新片场视频，都需补 playerUrl 让侧栏走 yt-dlp。
      //   旧正则 /xinpianchang\.com\/a\d+/ 漏掉了 stock. 子域与 footage/details 路径 →
      //   素材资产缺 playerUrl → isYtDlpPlatform 判否 → 视频直链解析不出 → 用户只下到封面图。
      if (/xinpianchang\.com/i.test(srcPageUrl)) {
        a.playerUrl = srcPageUrl;
      } else if (/(^|\.)douyin\.com/.test(srcPageUrl) || /(^|\.)iesdouyin\.com/.test(srcPageUrl)) {
        a.playerUrl = srcPageUrl;
      }
    }
  }
  // ★关键修复：侧栏加载时（bulk-actions.js）读取的持久化 key 是 'lastScan'，
  // 此前 scanTab 写的是 'hmdao_scan_${tabId}'，两套 key 不匹配 → 侧栏重启/重载后
  // 只能依赖 SCAN_RESULT 运行时广播；一旦广播因 SW 重启/侧栏加载时序竞态丢失，
  // 侧栏永远为空（真机「采不到」的头号根因）。统一写 'lastScan' 并供 storage.onChanged 实时接收。
  if (deep) {
    try { await chrome.storage.local.set({ lastScan: { assets: finalMerged, tabId, ts: Date.now() } }); } catch (_) {}
  }

  // ★P0 兜底：如果目标标签页本身就是网盘分享页，但 scanPage（旧版 content script/SPA）
  // 没有返回网盘资产，直接在 background 层补录，确保侧栏一定能出现「深度解析」入口。
  try {
    if (targetTabUrl && NETDISK_RE.test(targetTabUrl) && !merged.some((a) => a.type === 'netdisk')) {
      merged.push({
        url: targetTabUrl,
        type: 'netdisk',
        source: 'netdisk-current-page-bg',
        title: '网盘分享页',
        name: '网盘分享页',
        pageUrl: targetTabUrl,
        tabId,
      });
    }
  } catch (_) {}

  // 扫描结果广播给侧栏（SCAN_RESULT 由 detect.js 转发到页面事件，侧栏监听）
  // ★2026-08-23 修复（确凿根因）：旧代码广播 merged（过滤前 159 条全量），单视频过滤的 finalMerged 从未触达侧栏，
  //   导致抖音 jingxuan 页侧栏一直显示几十张无关图片 + 1 条视频（用户实测 10+ 张）。
  //   修复：广播/持久化/返回值全部用 finalMerged。
  logOnChange('broadcast', '[HMDAO][scan] broadcast assets: finalMerged=' + finalMerged.length + ' (merged=' + merged.length + ')');
  // ★2026-09-11 诊断（yunqiaonet「扫了 84 条但侧栏看不到」定位）：打印资产类型构成 + 样例图片 URL，
  //   一眼看出 84 条是 image/video/杂项，以及图片来自哪个 CDN（判断防盗链导致裂图）。
  try {
    const hist = {};
    for (const a of finalMerged) { if (a && a.type) hist[a.type] = (hist[a.type] || 0) + 1; }
    const histStr = Object.keys(hist).map((k) => k + '=' + hist[k]).join(' ');
    const sampleImgs = [];
    for (const a of finalMerged) { if (a && a.type === 'image' && a.url) { sampleImgs.push(String(a.url).slice(0, 80)); if (sampleImgs.length >= 4) break; } }
    const _host = (function () { try { return new URL(targetTabUrl).hostname; } catch (_) { return '?'; } })();
    logOnChange('assets-diag', '[HMDAO][scan] 资产构成 host=' + _host + ' ' + histStr + ' 样例img=' + JSON.stringify(sampleImgs));
  } catch (_) {}
  // ★2026-08-31 修复（"点击抖音视频卡预览显示别 tab 的图/视频"根因）：
  //   finalMerged 此前不带源 tabId → 侧栏点击卡片时 startDouyinFrameStream 只能靠
  //   chrome.tabs.query({active:true}) 猜源 tab，猜错就拉到别的抖音标签（直播/合集其他集）
  //   的 curFirstFrame/视频流 → 预览画面与卡片源视频不一致（用户实测「命比草轻卡片→预览显示万能青年旅店直播」）。
  //   修复：给 finalMerged 每条资产挂上 __sourceTabId = 本次扫描的 tabId（这张卡就是从这个 tab 扫出来的），
  //   侧栏预览用它即可精准锁定真正产生这张卡的标签，不再依赖 active tab 猜。
  // ★2026-09-02：抖音音频轨兜底去重。
  //   实测同一条音频轨会被处理两遍（两遍各自构建数组，块内 Set 拦不住），
  //   最终广播前必须再按 URL 去重一次，否则侧栏出现两张一模一样的音频卡。
  const broadcastAssets = (function dedupDashAudio(list) {
    const seen = new Set();
    const out = [];
    for (const a of list) {
      if (a && a.type === 'audio' && a.source === 'douyin-dash-audio') {
        if (!a.url || seen.has(a.url)) continue;
        seen.add(a.url);
      }
      out.push(a);
    }
    return out;
  })(finalMerged);
  // ★2026-09-05 修复（封面/标题在新旧值间来回切换的【交替引擎】）：
  //   同一集(awemeId)会从两条路径各产出一条卡：「实时流卡」(dyUrls/CDN) 与「API 合成卡」
  //   (dyVideoUrlByAweme)，二者 url 不同 → 上面按 url 的去重拦不住 → finalMerged 同集两条。
  //   侧栏 applyMeta 按【数组顺序】依次吸收 → 本轮实时流卡赢、下一轮 API 卡赢 →
  //   封面/标题每 10s 在两份值之间翻转（用户实测"封面缩略图和标题前后来回切换"）。
  //   折叠优先级：带 dashAudio（可合成音画的实时流）> 带 cover > 带 episodeNo > 先到的。
  try {
    const byAid = new Map();
    const collapsed = [];
    const aidScore = (x) => (x.dashAudio ? 4 : 0) + (x.cover ? 2 : 0) + (x.episodeNo ? 1 : 0);
    for (const a of finalMerged) {
      const k = (a && a.platform === 'douyin' && a.type === 'video' && a.awemeId) ? ('dy:' + a.awemeId) : null;
      if (!k) { collapsed.push(a); continue; }
      const prev = byAid.get(k);
      if (!prev) { byAid.set(k, a); collapsed.push(a); continue; }
      if (aidScore(a) > aidScore(prev)) {
        collapsed.splice(collapsed.indexOf(prev), 1, a);
        byAid.set(k, a);
      }
    }
    if (collapsed.length !== finalMerged.length) {
      console.log('[HMDAO][scan] 同集多来源折叠：%d → %d 条', finalMerged.length, collapsed.length);
      finalMerged.length = 0;
      finalMerged.push(...collapsed);
      NETWORK_ASSETS[tabId] = finalMerged;
    }
  } catch (_) {}
  broadcastAssets.forEach((a) => { if (a && typeof a === 'object') a.__sourceTabId = tabId; });
  // ★2026-09-05 修复（十几分钟后侧栏/源页卡顿的主要推手）：
  //   内容签名与上一轮完全一致 → 跳过广播。侧栏零动作：不处理消息、不持久化 lastScan、
  //   不触发渲染。轮询从「每 10s 全量灌一次上百条资产」变成「只在真变化时广播一次」。
  const bcastSig = broadcastAssets
    .map((a) => (a.type || '') + '|' + (a.awemeId ? 'dy:' + a.awemeId : (a.url || '')) + '|cov:' + (a.cover || '') + '|tt:' + (a.title || '') + '|np:' + (a.notPlayed ? 1 : 0))
    .sort().join('~')
    + '#cur:' + (pageCurAwemeId || '') + '#mix:' + (pageMixId || '') + '#b:' + (batchMode ? 1 : 0);
  if (bcastSig === HMDAO_LAST_BCAST_SIG) return broadcastAssets; // 无变化：静默返回
  HMDAO_LAST_BCAST_SIG = bcastSig;
  chrome.runtime.sendMessage({ type: HMDAO_MSG.SCAN_RESULT, tabId, url: targetTabUrl, assets: broadcastAssets, batchMode: !!batchMode, curAwemeId: pageCurAwemeId || '', mixId: pageMixId || '' }).catch(() => {});
  return broadcastAssets;
}

// 页面 DOM 解析（注入 ISOLATED 世界运行，禁止引用 background 作用域）。
// networkAssets: 由 background 透传的网络层捕获资产（含 source 字段，供侧栏/测试区分来源）。
// 2026-08-18 改为 async：huaban 等平台需要 await fetch 真实接口才能拿原图。
async function scanPage(networkAssets) {
  let out = [];
  // ★2026-09-06：重 SPA 会话页（豆包）性能熔断。
  //   豆包 DOM 巨大且 SSE 打字机每秒改几十次节点，scanPage 里 5 处 querySelectorAll('*')
  //   全量属性遍历 + MutationObserver 回调会造成明显掉帧/卡顿（用户明确要求不能卡）。
  //   这类页面的音频走【网络层捕获 + MAIN 世界旁路捕获】，不依赖全量属性扫描，
  //   故在此类站点跳过重量级遍历，其余站点行为完全不变。
  let heavyDom = true;
  try { if (/(^|\.)doubao\.com$/.test(location.hostname)) heavyDom = false; } catch (_) {}
  // ★2026-09-16 修复：scanPage 被注入页面执行，无法访问顶层作用域，必须在内部定义此 helper。
  function normalizeImagePathname(p) {
    return String(p || '')
      .replace(/~tplv-[^/]*$/i, '')
      .replace(/!\w+$/i, '')
      .replace(/:\d{1,5}:\d{1,5}\.\w{2,5}$/i, '')
      .replace(/:\d{1,5}:\d{1,5}$/i, '')
      .replace(/@\d+w_\d+h(_\d+c)?\.\w+$/i, '')
      .replace(/@!?\w+\.\w+$/i, '')
      .replace(/[-_]\d{2,4}x\d{2,4}$/i, '');
  }
  const push = (url, type, source, meta) => {
    if (!url) return;
    // ★2026-09-11 修复（liblib / B站等 MSE 播放器产生"假卡"根因）：
    //   源页 <video src="blob:..."> / <source src="blob:..."> 只在创建它的页面上下文有效，
    //   扩展后台/侧栏跨上下文 fetch 必然 ERR_FILE_NOT_FOUND，既不能预览也不能下载。
    //   scanPage 嗅探到这类 blob URL 后必须丢弃，避免生成点击无反应的"假卡"。
    //   例外：豆包 WS 音频的伪 URL（doubao-ws-audio://）会在侧栏 hydrate 成真实 blob，不在这里处理。
    if (type === 'video' || type === 'audio') {
      try {
        const s = String(url || '');
        if (/^blob:/i.test(s) || /^data:/i.test(s)) return;
        // ★2026-09-14 修复（B 站等站点「JS 包被当成音频」根因）：
        //   下方 [data-audio] / [data-src] 等属性嗅探是无条件推送的，而 data-src 常被用于
        //   懒加载 JS / 图片（B 站 index-legacy-*.js 即挂在 data-src 上），
        //   于是 1.4MB 的 application/javascript 被入库为音频，预览必然
        //   NotSupportedError（blobType: application/javascript）。
        //   这里在唯一入口做兜底：路径以明确的非媒体扩展名结尾 → 一律丢弃。
        //   只按「扩展名黑名单」拒绝，不强制要求音频后缀，以免影响爱给等
        //   「无扩展名 + 签名参数」的真实音频直链。
        if (/\.(js|mjs|cjs|css|html?|json|jsonp|xml|svg|png|jpe?g|gif|webp|avif|bmp|ico|woff2?|ttf|otf|eot|map|txt|md|pdf)(\?|#|$)/i.test(s)) return;
      } catch (_) {}
    }
    // 动图检测：gif/apng/动图 webp 标记 animated，预览直显（不重编码），合并阶段据此免过滤
    // 2026-08-24 扩展：动画 webp 也标记 dynamic（素材站如 liblib 用 webp 动图作"视频预览"，
    // 无 <video> 元素，需进侧栏「视频/动态」模块并自带缩略图）。
    let animated = false;
    if (type === 'image') {
      const lower = String(url).toLowerCase();
      if (/\.(gif|apng|webp)(\?|$)/i.test(lower)) animated = true;
      else if (/format=apng|format=gif|format=webp/i.test(lower)) animated = true;
    }
    let u = String(url).trim();
    if (!u) return;
    // 统一用 new URL 解析：① 相对/协议相对地址 → 绝对地址；② 含 raw 非 ASCII（如韩文文件名
    // https://cdn.x/파이널.webp）→ 自动 percent-encode，保证去重键一致、缩略图请求可成功。
    try { u = new URL(u, location.href).href; } catch (_) { return; }
    const item = { url: u, type, source };
    if (animated) {
      item.animated = true;
      item.dynamic = true;
      // 动图自带缩略图（自身 URL），侧栏视频卡据此显示封面而非 emoji 占位
      if (!item.cover) item.cover = u;
    }
    if (meta && typeof meta === 'object') Object.assign(item, meta);
    out.push(item);
  };

  // 1) 图片：<img src/currentSrc/srcset> + data-* 属性 + 内联 style background + <picture>
  document.querySelectorAll('img').forEach((img) => {
    const src = img.currentSrc || img.src;
    const alt = img.alt || '';
    push(src, 'image', 'img', { alt });
    if (img.srcset) {
      img.srcset.split(',').forEach((s) => {
        const u = s.trim().split(/\s+/)[0];
        push(u, 'image', 'img[srcset]', { alt });
      });
    }
  });
  // ★2026-09-07 修复（avif 多候选漏采根因）：<picture><source> 可能按格式协商给出多个候选
  //   （如 webp 在前、avif 在后，或 avif 1x/2x 多档），旧逻辑只取 srcset 第 1 段 → 排在后面的 avif 永远采不到。
  //   改为遍历 srcset 全部候选 + 兜底 s.src，确保 avif 等任一候选都被收集。
  document.querySelectorAll('picture source').forEach((s) => {
    if (s.srcset) {
      s.srcset.split(',').forEach((c) => { const u = c.trim().split(/\s+/)[0]; if (u) push(u, 'image', 'picture'); });
    } else if (s.src) {
      push(s.src, 'image', 'picture');
    }
  });
  document.querySelectorAll('[style]').forEach((el) => {
    const st = el.getAttribute('style') || '';
    const m = st.match(/url\(['"]?(https?:\/\/[^'")]+)['"]?\)/i);
    if (m) push(m[1], 'image', 'css-bg');
  });
  // ★2026-09-07 修复（懒加载 avif 漏采根因）：设计/课程/图库站常用各站自定义的懒加载属性承载真实图片 URL，
  //   旧清单只覆盖 10 个常见属性，fastcampus/liblib 等用 data-lazy-src / data-original-src / data-webp-src 等
  //   → 真实 avif 永远采不到。扩到常见懒加载属性全集，并对 data-srcset 按 srcset 规则拆分多候选。
  const LAZY_ATTRS = ['data-src', 'data-original', 'data-lazy', 'data-bg', 'data-image', 'data-img', 'data-url', 'data-pic', 'data-thumb', 'data-preview', 'data-lazy-src', 'data-original-src', 'data-webp-src', 'data-hd-src', 'data-high-res-src', 'data-full', 'data-zoom', 'data-large', 'data-big', 'data-origin', 'data-real', 'data-actual', 'data-load-src', 'data-true-src', 'data-retina', 'data-imgurl', 'data-imageurl', 'data-bigpic', 'data-poster', 'data-file', 'data-cdn', 'data-path', 'data-link', 'data-gif', 'data-srcset'];
  document.querySelectorAll(LAZY_ATTRS.map((a) => '[' + a + ']').join(',')).forEach((el) => {
    const lazyAlt = el.getAttribute('alt') || '';
    for (const k of LAZY_ATTRS) {
      const v = el.getAttribute(k);
      if (!v) continue;
      if (k === 'data-srcset') { v.split(',').forEach((c) => { const u = c.trim().split(/\s+/)[0]; if (u) push(u, 'image', 'img[data]', { alt: lazyAlt }); }); }
      else push(v, 'image', 'img[data]', { alt: lazyAlt });
    }
  });
  document.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    if (/\.(jpe?g|png|gif|webp|bmp|svg|avif|ico|tiff?)([?#]|$)/i.test(href)) {
      const img = a.querySelector('img');
      if (img) push(img.currentSrc || img.src, 'image', 'a>img', { alt: img.alt || '' });
      else push(href, 'image', 'a>img');
    } else if (/\.(pdf|docx?|pptx?|xlsx?|txt|rtf|epub|csv|md)([?#]|$)/i.test(href)) {
      // ★2026-08-23 P4（文档/模型采集）：识别普通 <a> 指向的真实文档链接，纳入侧栏「文档」素材。
      // 不依赖网络层 content-type（静态链接未必发请求即被捕获），直接按扩展名归类更稳。
      const txt = (a.textContent || a.getAttribute('title') || a.getAttribute('download') || '').trim();
      push(href, 'document', 'a>doc', { title: txt || null });
    } else if (/\.(glb|gltf|obj|fbx|stl|usdz|dae|3mf)([?#]|$)/i.test(href)) {
      // ★2026-08-23 P4：静态 3D 模型链接（网络层 model-api-capture 已抓无扩展名/API，这里补齐静态直链）。
      const txt = (a.textContent || a.getAttribute('title') || a.getAttribute('download') || '').trim();
      push(href, 'model', 'a>model', { title: txt || null });
    }
  });
  // ★2026-09-11：补齐 object/embed/SVG <image>/<use> 内的图片（部分 AI 画廊/3D 预览用这些标签承载直链）。
  try {
    document.querySelectorAll('object, embed, svg image, use').forEach((el) => {
      const v = el.getAttribute('data') || el.getAttribute('src') || el.getAttribute('href') || el.getAttribute('xlink:href') || '';
      if (!v) return;
      if (/\.(jpe?g|png|gif|webp|bmp|svg|avif|ico|tiff?)([?#]|$)/i.test(v)) push(v, 'image', 'object/embed');
      else if (/\.(glb|gltf|obj|fbx|stl|usdz|dae|3mf)([?#]|$)/i.test(v)) push(v, 'model', 'object/embed');
    });
  } catch (_) {}

  // ★2026-08-18：小红书（SPA + 登录态注入）图片/视频提取。
  // 笔记真实媒体 URL 在页面内联 JSON（window.__INITIAL_STATE__ / 初始 state script）里，
  // DOM 懒加载前这些 <img> 还不存在，故必须直接从内联数据抓取。
  try {
    if (/xiaohongshu\.com|xhslink\.com/i.test(location.hostname + location.href)) {
      const XHS_IMG_RE = /https?:\/\/[^\s"']+?(?:xhscdn\.com|sns-img|xiaohongshu\.com)[^\s"']+?/gi;
      const XHS_VIDEO_RE = /https?:\/\/[^\s"']+?\.(?:mp4|webm|mov|m4v|m3u8)(?:[?#][^\s"']*)?/gi;
      // a) 全局变量 __INITIAL_STATE__
      const tryObj = (obj) => {
        if (!obj) return;
        const json = JSON.stringify(obj);
        let m;
        XHS_IMG_RE.lastIndex = 0;
        while ((m = XHS_IMG_RE.exec(json))) push(m[0], 'image', 'xhs-initial');
        XHS_VIDEO_RE.lastIndex = 0;
        while ((m = XHS_VIDEO_RE.exec(json))) push(m[0], 'video', 'xhs-initial');
      };
      try { tryObj(window.__INITIAL_STATE__); } catch (_) {}
      try { tryObj(window.__INITIAL_STATE__ && window.__INITIAL_STATE__.note); } catch (_) {}
      // b) 内联 script 文本（含 window.__INITIAL_STATE__ = {...}）
      document.querySelectorAll('script:not([src])').forEach((s) => {
        const t = s.textContent || '';
        if (!/xiaohongshu|__INITIAL_STATE__|imageList|image\/|video\/|media\/|urlList/i.test(t)) return;
        let m;
        XHS_IMG_RE.lastIndex = 0;
        while ((m = XHS_IMG_RE.exec(t))) push(m[0], 'image', 'xhs-script');
        XHS_VIDEO_RE.lastIndex = 0;
        while ((m = XHS_VIDEO_RE.exec(t))) push(m[0], 'video', 'xhs-script');
      });
      // c) 页面 HTML 里裸 CDN 图片 URL（含无扩展名的小红书图床）
      const htmlTxt = document.documentElement && document.documentElement.innerHTML || '';
      let hm;
      XHS_IMG_RE.lastIndex = 0;
      while ((hm = XHS_IMG_RE.exec(htmlTxt))) push(hm[0], 'image', 'xhs-html');
      XHS_VIDEO_RE.lastIndex = 0;
      while ((hm = XHS_VIDEO_RE.exec(htmlTxt))) push(hm[0], 'video', 'xhs-html');
    }
  } catch (_) {}

  // 2) 视频：<video src> + <source> + poster + 属性 + 内联脚本/全局变量
  // 增强（2026-08-24）：兼容懒加载/虚拟列表 — 取 currentSrc（懒挂载后浏览器填充的直链）+
  // <video> 上的 data-* 视频 URL（React 网格常用 data-src/data-mp4/data-video 挂预览直链）。
  // 注意：仅同步收集，不触发 v.load()/setTimeout（避免发声/流量副作用及与 model-api-capture
  // 的 MutationObserver+轮询重复；hover 后才出现的 <video> 由该 Observer 兜底捕获）。
  const VPRE_RE = /[.](mp4|webm|mov|m4v|mkv|ogv|m3u8)(\?|#|$)/i;
  document.querySelectorAll('video').forEach((v) => {
    // ★2026-08-25 修复（Liblib 等无 poster 视频封面缺失）：优先 v.poster；
    // 若 poster 为空，向上查找卡片容器（最近带 class 含 card/item/work 的祖先）内的第一张 <img> 作为 cover。
    let cover = v.poster || '';
    if (!cover) {
      try {
        let p = v.parentElement;
        for (let i = 0; i < 6 && p; i++) {
          // ★2026-09-08 修复（多视频页封面错配根因之一）：候选祖先若已包含多个 <video>，
          // 它的第一张 <img> 是共享资源（轮播位/页头图/推荐位）→ 会让所有视频卡拿到同一张封面。
          // 此时停止上爬（更上层只会包含更多视频），宁可留空交给 defaultCover/pageCovers 按序分发。
          try { if (p.querySelectorAll && p.querySelectorAll('video').length > 1) break; } catch (_) {}
          const img = p.querySelector('img');
          if (img && (img.currentSrc || img.src)) { cover = img.currentSrc || img.src; break; }
          p = p.parentElement;
        }
      } catch (_) {}
    }
    // currentSrc 优先（懒加载后浏览器会更新它，src 可能仍是空/blob）
    [v.currentSrc, v.src].forEach((s) => {
      // ★2026-08-31 修复（抖音/TikTok MSE blob 源「扫描 1 项失败 1 项」根因）：
      //   抖音/TikTok 现代播放器走 MSE，<video>.src = blob:https://...，扩展上下文无法 fetch
      //   这些 blob（跨上下文隔离）→ 侧栏显示为「失败」视频卡。真实 CDN URL 由 extractFreshVideoUrl
      //   从 RENDER_DATA/inject-main.dyUrls 解析，此处只收 http(s) 视频源。
      if (!s || !/^https?:/i.test(s)) return;
      const it = push(s, 'video', 'video');
      // 用 video 的 poster 作为视频卡缩略图（侧栏视频模块据此显示封面而非 emoji 占位）
      if (it && cover) it.cover = cover;
    });
    // ★2026-09-10 修复（通用站 <video> 多 <source> 变体产生重复卡片）：
    //   同一 <video> 的 <source> 通常是不同格式/清晰度的同一视频；若 <video> 已有有效当前源（currentSrc/src），
    //   不再把 <source> 拆成独立卡片；仅当当前源无效（blob/空）时才用 <source> 兜底。
    const hasActiveSrc = [v.currentSrc, v.src].some((s) => s && /^https?:/i.test(s));
    v.querySelectorAll('source').forEach((s) => {
      if (hasActiveSrc) return;
      push(s.src, 'video', 'video>source');
    });
    // <video> 的 data-* 上挂的预览视频直链
    if (v.dataset) {
      for (const k in v.dataset) {
        const val = v.dataset[k];
        if (typeof val === 'string' && VPRE_RE.test(val)) {
          const it = push(val, 'video', 'video[data-' + k + ']');
          if (it && cover) it.cover = cover;
        }
      }
    }
    // poster 仍作为独立图片资产保留（可被图片模块扫描到）
    if (v.poster) push(v.poster, 'image', 'video[poster]');
  });
  // ★2026-08-24 修复（关键 bug）：data-src 太宽泛（liblib 等页面任何元素带 data-src 都会被误推为 video，
  // 包括百度/bing 统计跟踪像素如 bat.bing.com/action/0?...）—— 需校验 URL 是否真视频格式才推 video，
  // 否则推为"待定"（仍走 push 但后续 merge 阶段过滤）。同时把 query 选择器去掉 data-src（最常见且最易误伤），
  // 改用 [data-video], [data-mp4], [data-video-src], [data-play]——更精准，hover 懒加载场景由 1167 段 attr 兜底。
  const ATTR_VID_RE = /\.(mp4|webm|mov|m4v|mkv|ogv|m3u8|flv|avi|wmv|ts|mpg|mpeg|3gp|rm|rmvb|asf|vob|m2ts|f4v|m4s)([?#]|$)/i;
  document.querySelectorAll('[data-video], [data-mp4], [data-video-src], [data-play]').forEach((el) => {
    ['data-video', 'data-mp4', 'data-video-src', 'data-play'].forEach((k) => {
      const v = el.getAttribute(k);
      if (v && ATTR_VID_RE.test(v)) push(v, 'video', 'video[attr]');
    });
  });
  // data-src 单独处理（最常见为 img lazy-load，扫描器主 img 段已处理；这里仅补"真是视频格式"的例外）
  document.querySelectorAll('[data-src]').forEach((el) => {
    const v = el.getAttribute('data-src');
    if (v && ATTR_VID_RE.test(v)) push(v, 'video', 'video[data-src]');
  });
  // 2.5) 视频直链（含 m3u8 / 直播）：<a href="*.mp4"> 等 + 属性 + 脚本/全局变量
  const VID_RE = /\.(mp4|webm|mov|m4v|mkv|ogv|m3u8|flv|avi|wmv|ts|mpg|mpeg|3gp|rm|rmvb|asf|vob|m2ts|f4v|m4s)([?#]|$)/i;
  document.querySelectorAll('a[href]').forEach((a) => { if (VID_RE.test(a.href)) push(a.href, 'video', 'a[href]'); });
  if (heavyDom) document.querySelectorAll('*').forEach((el) => {
    el.getAttributeNames().forEach((name) => {
      const v = el.getAttribute(name);
      if (!v || typeof v !== 'string') return;
      const m = v.match(/https?:\/\/[^ "'()]+/i);
      if (m && VID_RE.test(m[0])) push(m[0], 'video', 'attr:' + name);
    });
  });
  // ★2026-09-08 修复（imini.ai / 所有内联 JSON 的 Next.js、RSC 站点「视频直链一条都采不到」真凶）：
  //   旧正则在扩展名后【强制】要求 ([?#]|$)，即 .mp4 后面必须紧跟 ? / # / 整个字符串结尾。
  //   但内联 JSON（<script id="__NEXT_DATA__">、self.__next_f.push([1,"…"]) RSC payload）里
  //   .mp4 后面紧跟的是【引号】→ 永远不匹配。
  //   实测：真实 imini.ai/zh/video 页面 HTML 中确有 9 条 https://file.iminicdn.com/.../*.mp4，
  //   旧正则命中 0 条 → 内联数据里的真直链全部漏采，只剩 attr/<video>/网络层的残片候选，
  //   这正是"侧栏视频卡 URL 是被截断的半截"的源头。
  //   改为「惰性主体 + 媒体扩展名 + 可选查询串」：引号/空白/尖括号/括号即终止，
  //   既能命中内联 JSON，也不会跨过引号吞掉后面的无关文本。
  const VID_SCRIPT_RE = /https?:\/\/[^ "'()<>]+?\.(?:mp4|webm|mov|m4v|mkv|ogv|m3u8|flv|avi|wmv|ts|mpg|mpeg|3gp|rm|rmvb|asf|vob|m2ts|f4v|m4s)(?:[?#][^ "'()<>]*)?/gi;
  document.querySelectorAll('script:not([src])').forEach((s) => {
    let m;
    VID_SCRIPT_RE.lastIndex = 0;
    while ((m = VID_SCRIPT_RE.exec(s.textContent || ''))) push(m[0], 'video', 'script');
  });
  try {
    ['videoList', 'videos', 'videoData', 'playerData', 'playList', 'playlist', 'videoInfo', 'mediaList', '__VIDEO__'].forEach((k) => {
      const obj = window[k];
      if (!obj) return;
      const urls = JSON.stringify(obj).match(/https?:\/\/[^ "'()]+/g) || [];
      urls.forEach((u) => { if (VID_RE.test(u)) push(u, 'video', 'global'); });
    });
  } catch (_) {}

  // 2.6.5) ★2026-09-10 网络层遗漏补偿（Performance API 回补）
  //   问题：MV3 Service Worker 休眠时，唤醒它的【首批 webRequest 事件会丢失】。
  //   而 m3u8 恰恰是 hls.js 播放器发出的第一个请求（DPlayer / 各类 m3u8 站都如此），
  //   正好撞上冷启动 → 永远进不了 NETWORK_ASSETS → 侧栏视频恒为 0（实测确认）。
  //   方案：从 Performance API 的「已发生资源请求」里回补媒体直链，不依赖 webRequest 时序。
  //   注意：Performance 只记录【当前 frame】的请求；本函数以 allFrames:true 注入，
  //   故位于 iframe 内的播放器（最常见）其请求也能由各自 frame 回补。
  //   跨域资源即使 transferSize=0（无 Timing-Allow-Origin），name(URL) 依然可用。
  try {
    const perfEntries = (typeof performance !== 'undefined' && performance.getEntriesByType)
      ? performance.getEntriesByType('resource') : [];
    let perfHit = 0;
    for (const e of perfEntries) {
      const u = e && e.name;
      if (!u || !/^https?:/i.test(u)) continue;
      // 排除 HLS 数字分片（0000.ts）：碎片不可独立播放，只认播放列表 index.m3u8
      if (/\/[0-9]+\.ts(\?|$)/i.test(u)) continue;
      if (VID_RE.test(u)) { push(u, 'video', 'perf-network'); perfHit++; }
      else if (/\.(mp3|wav|flac|aac|m4a|ogg|opus|wma)(\?|$)/i.test(u)) { push(u, 'audio', 'perf-network'); perfHit++; }
    }
    if (perfHit) console.log('[HMDAO][scanPage] Performance 回补媒体直链', perfHit, '条');
  } catch (_) {}

  // 2.7) 嵌入视频平台 URL 扫描（让网页内嵌的 YouTube/B站/优酷/腾讯/iqiyi 等 走 yt-dlp 拿全清晰度）：
  // 网页里很多"带分辨率选项的视频"是这些平台播放器 iframe 嵌进来的，其真实视频直链是
  // googlevideo/bilivideo/cibntv 等防盗链地址（无法选清晰度、直连 403），但 iframe.src 里的平台 URL
  // 能被 yt-dlp 识别并枚举所有清晰度。本步提取规范化后的平台 URL 入库，供预览/下载走 yt-dlp。
  // ★扩展（2026-08-01）：原只识别 YouTube/B站，youku/tudou/腾讯/iqiyi 等国内嵌入被直接丢弃 →
  //   云桥网(yunqiaowang)等用 youku 嵌入的站点采不到。现扩到主流国内平台。
  const EMBED_SOURCES = [];
  const collectEmbedUrl = (raw) => { if (raw) EMBED_SOURCES.push(String(raw)); };
  // a) 直接 iframe（跨域 iframe 的 src 属性本身可读，仅内部 DOM 不可读）
  document.querySelectorAll('iframe').forEach((ifr) => {
    collectEmbedUrl(ifr.src);
    collectEmbedUrl(ifr.getAttribute('data-src'));
  });
  // b) 页面里的平台链接（<a href>、data-*、全局变量、内联脚本）
  document.querySelectorAll('a[href]').forEach((a) => collectEmbedUrl(a.href));
  ['data-video', 'data-src', 'data-url', 'data-href', 'data-link', 'data-embed'].forEach((k) => {
    document.querySelectorAll('[' + k + ']').forEach((el) => collectEmbedUrl(el.getAttribute(k)));
  });
  (function () {
    const txt = (document.documentElement && document.documentElement.innerHTML) || '';
    const m = txt.match(/https?:\/\/(www\.)?(youtube\.com\/(watch\?v=|embed\/|shorts\/)|youtu\.be\/|player\.bilibili\.com\/player\.html\?bvid=|www\.bilibili\.com\/video\/|player\.youku\.com\/embed\/|v\.youku\.com\/v_show\/|vzuu\.com\/v_show\/|video\.tudou\.com\/[a-z]\/|v\.qq\.com\/[a-z]+\/|www\.iqiyi\.com\/[a-z0-9_]+\.html|www\.iqiyi\.com\/v_|ixigua\.com\/[0-9]+|www\.sohu\.com\/[a-z]+\/[0-9]+)[^\s"'<>()]+/gi) || [];
    m.forEach(collectEmbedUrl);
  })();
  // 规范化 + 入库。返回 { platform, playerUrl, ... } 或 null。
  // 设计：★先做「白名单特殊规范化」——YT/B站/youku/qq/iqiyi/tudou/西瓜/搜狐 等已知平台，
  // 解析出更干净稳定的播放页 playerUrl（去参数/统一域名），便于 yt-dlp 稳定提取。
  // ★白名单未命中，则做「通用兼容」回退：任何看起来像视频平台播放页的 URL
  // （含已知视频平台域名，或路径含 /embed/ /v_ /v_show/ /video/ 等视频特征）都按
  // generic 平台入库，直接以原始 raw URL 作为 playerUrl 交给 yt-dlp 尝试提取。
  // 这样「未列在白名单的小众/海外平台」也能被采集，特殊平台再走白名单做规范化增强。
  const VIDEO_PLATFORM_HOST_RE = /(youtube\.com|youtu\.be|bilibili\.com|youku\.com|vzuu\.com|tudou\.com|qq\.com|iqiyi\.com|ixigua\.com|sohu\.com|le\.com|acfun\.cn|1905\.com|mgtv\.com|v\.qq\.com|v\.ku6\.com|kankan\.com|56\.com|fun\.tv|pptv\.com|wasu\.cn|cntv\.cn|bokecc\.com|polyv\.net|qiyi\.com|v\.163\.com|open\.163\.com|vimeo\.com|dailymotion\.com|facebook\.com|twitter\.com|vk\.com|ok\.ru|rutube\.ru|streamable\.com|twitch\.tv|invidious\.|piped\.|peertube|mixcloud\.com|soundcloud\.com|ted\.com|metacafe\.com|break\.com|liveleak\.com|veoh\.com|9cache\.com|bits\.co|bitchute\.com|rumble\.com|odysee\.com|brighteon\.com|v\.douyin\.com|douyin\.com|kuaishou\.com|bilibili\.tv|nicovideo\.jp|dmm\.co\.jp|niconico)/i;
  const VIDEO_PATH_RE = /\/(embed|player|v_show|v_|video|watch|shorts|play|player\.html|v\/|detail|media|mv|live)\b/i;
  function normalizeEmbedPlatform(raw) {
    try {
      const u = new URL(raw, location.href);
      const h = u.hostname;
      // ===== 白名单特殊规范化（稳定 playerUrl / 视频 ID） =====
      // YouTube
      if (/(^|\.)youtube\.com$/.test(h)) {
        let videoId = null;
        if (u.pathname === '/watch') videoId = u.searchParams.get('v');
        else if (u.pathname.startsWith('/embed/')) videoId = u.pathname.split('/embed/')[1].split('/')[0];
        else if (u.pathname.startsWith('/shorts/')) videoId = u.pathname.split('/shorts/')[1].split('/')[0];
        if (videoId) return { platform: 'youtube', ytPageUrl: 'https://www.youtube.com/watch?v=' + videoId, ytVideoId: videoId };
      } else if (/(^|\.)youtu\.be$/.test(h)) {
        const videoId = u.pathname.slice(1).split('/')[0];
        if (videoId) return { platform: 'youtube', ytPageUrl: 'https://www.youtube.com/watch?v=' + videoId, ytVideoId: videoId };
      } else if (/(^|\.)bilibili\.com$/.test(h)) {
        let videoId = null;
        if (u.pathname.startsWith('/video/')) videoId = u.pathname.split('/video/')[1].split('/')[0];
        else if (u.pathname === '/player.html' || u.pathname === '/player/') videoId = u.searchParams.get('bvid');
        if (videoId && /^BV/.test(videoId)) return { platform: 'bilibili', biliPageUrl: 'https://www.bilibili.com/video/' + videoId, biliVideoId: videoId };
      } else if (/(^|\.)vzuu\.com$/.test(h)) {
        // vzuu 是优酷的镜像/反代站，直接按 youku 平台归一化
        let vid = null;
        const m = u.href.match(/id_([A-Za-z0-9]+)/);
        if (m) vid = m[1];
        if (vid) return { platform: 'youku', playerUrl: 'https://v.youku.com/v_show/id_' + vid + '.html' };
      } else if (/(^|\.)youku\.com$/.test(h)) {
        let vid = null;
        if (u.pathname.startsWith('/embed/')) vid = u.pathname.split('/embed/')[1].split('/')[0];
        else { const m = u.href.match(/id_([A-Za-z0-9]+)/); if (m) vid = m[1]; }
        // 必须转成 yt-dlp 能解析的 v_show 播放页；embed URL 不被 yt-dlp 支持。
        if (vid) return { platform: 'youku', playerUrl: 'https://v.youku.com/v_show/id_' + vid + '.html' };
      } else if (/(^|\.)tudou\.com$/.test(h)) {
        const m = u.href.match(/iid_([0-9]+)|code_([A-Za-z0-9]+)/);
        const vid = m && (m[1] || m[2]);
        if (vid) return { platform: 'tudou', playerUrl: raw };
      } else if (/(^|\.)qq\.com$/.test(h)) {
        const m = u.href.match(/\/([a-z]+)\/([A-Za-z0-9]+)/);
        if (m) return { platform: 'qq', playerUrl: raw };
      } else if (/(^|\.)iqiyi\.com$/.test(h)) {
        const m = u.href.match(/v_([A-Za-z0-9]+)/) || u.pathname.match(/\/([a-z0-9_]+)\.html/);
        if (m) return { platform: 'iqiyi', playerUrl: raw };
      } else if (/ixigua\.com$/.test(h)) {
        return { platform: 'xigua', playerUrl: raw };
      } else if (/(^|\.)sohu\.com$/.test(h)) {
        return { platform: 'sohu', playerUrl: raw };
      }
      // ===== 通用兼容回退（白名单未命中） =====
      // 已知视频平台域名，或路径含视频播放特征 → 按 generic 平台处理，以原始 URL 作为 playerUrl 交给 yt-dlp。
      // ★2026-09-08 修复（imini.ai 等站点「扫出一堆页面链接假视频卡」真凶）：
      //   EMBED_SOURCES 收集页面上【全部 <a href>】（2082 行），而 VIDEO_PATH_RE 的
      //   /video|play|detail|media|watch|live/ 会命中【本站自己的导航链接】——实测 imini.ai
      //   模型卡片链接 /zh/video、/zh/video/seedance2.0… 每条内链都被生成一张 generic 视频卡
      //   （url=页面链接）→ yt-dlp 解析 500 → 无封面(拿页面当图片 404)、点击不能播、标题是网页标题。
      //   修复：路径回退仅对【跨站】URL 生效——候选 host 与当前页面同注册域视为站内导航，跳过。
      //   兼容性：host 白名单分支不动（浏览快手/B站时指向本站视频页的链接仍照常采集，
      //   走上方 host 命中）；跨站 generic（如第三方 player 页）也不受影响。
      const sameSitePath = (function () {
        try {
          const reg = (x) => { const p = String(x || '').toLowerCase().split('.'); return p.slice(-2).join('.'); };
          return reg(h) === reg(location.hostname);
        } catch (_) { return false; }
      }());
      const hostHit = VIDEO_PLATFORM_HOST_RE.test(h);
      const pathHit = !sameSitePath && VIDEO_PATH_RE.test(u.pathname);
      if (hostHit || pathHit) {
        if (h === 'null' || u.toString() === 'null') return null; // 拒绝字面量 "null" 入库
        return { platform: 'generic', playerUrl: u.toString() };
      }
    } catch (_) {}
    return null;
  }
  EMBED_SOURCES.forEach((raw) => {
    const info = normalizeEmbedPlatform(raw);
    if (info && info.platform && info.playerUrl) {
      // 以平台播放页 URL 作为 url，便于 isYtDlpPlatform 识别（yt-dlp 支持大量平台，含 generic）。
      const meta = Object.assign({ platform: info.platform }, info.playerUrl && info.playerUrl !== 'null' ? { playerUrl: info.playerUrl } : {});
      if (info.ytPageUrl && info.ytPageUrl !== 'null') meta.ytPageUrl = info.ytPageUrl;
      if (info.ytVideoId && info.ytVideoId !== 'null') meta.ytVideoId = info.ytVideoId;
      if (info.biliPageUrl && info.biliPageUrl !== 'null') meta.biliPageUrl = info.biliPageUrl;
      if (info.biliVideoId && info.biliVideoId !== 'null') meta.biliVideoId = info.biliVideoId;
      push(info.playerUrl, 'video', 'embed-platform', meta);
    }
  });

  // ★注意：接口响应体视频直链（LiblibAI / 模型社区等"视频在 XHR/fetch 响应里动态注入"的站点）
  // 不再在 ISOLATED 世界读 window.__hmdao_captures.apiVideos —— MAIN 世界变量在 ISOLATED 不可见。
  // 改为由 scanTab 经 readAllCapturesMAIN（world:'MAIN'）回读 apiVideos 并并入 networkAssets，
  // 见本文件 scanTab 的 readMainCaptures（source='api-video'）。

  // 3) 音频：<audio src> + <source> + data-* + 属性 + 内联脚本/全局变量 + 播放器配置
  const AUD_RE = /\.(mp3|wav|flac|ogg|aac|m4a|wma|opus)(\?[^"'\s}]*)?/i;
  document.querySelectorAll('audio').forEach((a) => {
    push(a.src, 'audio', 'audio');
    a.querySelectorAll('source').forEach((s) => push(s.src, 'audio', 'audio>source'));
  });
  document.querySelectorAll('[data-audio], [data-src], [data-mp3], [data-music], [data-song], [data-track]').forEach((el) => {
    ['data-audio', 'data-src', 'data-mp3', 'data-music', 'data-song', 'data-track'].forEach((k) => push(el.getAttribute(k), 'audio', 'audio[attr]'));
  });
  if (heavyDom) document.querySelectorAll('*').forEach((el) => {
    el.getAttributeNames().forEach((name) => {
      const v = el.getAttribute(name);
      if (!v || typeof v !== 'string') return;
      const m = v.match(/https?:\/\/[^ "'()]+/i);
      if (m && AUD_RE.test(m[0])) push(m[0], 'audio', 'attr:' + name);
    });
  });
  document.querySelectorAll('script:not([src])').forEach((s) => {
    const urls = (s.textContent || '').match(/https?:\/\/[^ "'()]+/ig) || [];
    urls.forEach((u) => { if (AUD_RE.test(u)) push(u, 'audio', 'script'); });
  });
  try {
    ['audioList', 'audios', 'musicList', 'songList', 'audioData', 'playerData', '__AUDIO__'].forEach((k) => {
      const obj = window[k];
      if (!obj) return;
      const urls = JSON.stringify(obj).match(/https?:\/\/[^ "'()]+/g) || [];
      urls.forEach((u) => { if (AUD_RE.test(u)) push(u, 'audio', 'global'); });
    });
  } catch (_) {}
  // 部分播放器把 playlist 序列化在 <div data-player-config='[...]'> 中
  document.querySelectorAll('[data-player-config]').forEach((el) => {
    try { const v = el.getAttribute('data-player-config'); if (v) {
      const re = /https?:\/\/[^"'\s}]+\.(mp3|wav|flac|ogg|aac|m4a|wma|opus)(\?[^"'\s}]*)?/gi;
      let m; while ((m = re.exec(v)) && out.length < 800) push(m[0], 'audio', 'player-config');
    }} catch (_) {}
  });

  // 3D 模型：覆盖 <model-viewer>/A-Frame/直链/<a href>/属性/内联脚本/全局变量/下载按钮等多种藏匿方式
  // ★根因 A 修复：锚点原写死 ([?]|#|$)，要求扩展名后紧跟 ?/#/结尾。
  // 但 3D 站下载链接常是 ?file=robot.fbx&sign=abc（扩展名后是 &），原正则不匹配 → 整类模型从未被识别。
  // 改为 ([?#&]|$)：扩展名后是 ?/#/&/结尾都算命中（& 仅在 ? 后出现才合法，这里放宽不影响判断，
  // 因为 .fbx 不会出现在随机文本里，误匹配风险极低）。
  const MODEL_RE = /[.](glb|gltf|obj|fbx|stl|usdz|max|blend|ma|mb|c4d|dae|ply|3ds|skp|wrl|x3d|abc|lwo|smd|vrm|ase|dxf|bvh)([?#&]|$)/i;
  const ARCH_RE = /[.](zip|rar|7z|tar[.]gz|tgz|tar[.]bz2|gz|bz2|tar|iso|cab|jar)([?#&]|$)/i;
  const URL_RE = new RegExp("https?://[^ \"'()]+", "gi");
  // 1) <model-viewer> / A-Frame <a-asset-item> / <a-scene> 的 src
  document.querySelectorAll('model-viewer').forEach((m) => push(m.getAttribute('src'), 'model', 'model-viewer'));
  document.querySelectorAll('a-asset-item, a-asset, a-entity[model-src], a-entity[src]').forEach((el) => {
    const s = el.getAttribute('src') || el.getAttribute('model-src') || el.getAttribute('gltf-model');
    push(s, 'model', 'a-frame');
  });
  // 2) <a href> 直链
  document.querySelectorAll('a[href]').forEach((a) => {
    if (MODEL_RE.test(a.href)) push(a.href, 'model', 'a[href]');
    else if (ARCH_RE.test(a.href)) push(a.href, 'archive', 'a[href]');
  });
  // 2.5) 网盘分享链接：压缩包/模型常经网盘分发，页面本体（如模型详情页）只有分享主页 URL，无直链。
  //      捕获为 'netdisk' 类型，侧栏可一键打开提取页，进入后再由网盘 API / 浏览器下载事件捕获真实文件。
  // ★ 2026-08-09 同步修复：迅雷自己网盘 pan.xunlei.com/?path=... 也纳入识别。
  const NETDISK_RE = /(pan\.baidu\.com\/s\/|lanzou[s]?\.com|lanzaou\.com|quark\.cn|pan\.quark\.cn|pan\.xunlei\.com(\/s\/|\/?\?|$)|123pan\.com|aliyundrive\.com|weiyun\.com|cowtransfer\.com|ctfile\.com|mediafire\.com|mega\.nz|drive\.google\.com\/file|dropbox\.com\/s|terabox|pcloud)/i;
  document.querySelectorAll('a[href]').forEach((a) => {
    if (NETDISK_RE.test(a.href)) push(a.href, 'netdisk', 'a[href]');
  });
  // 3) 任意元素属性上含模型/归档扩展名的 URL（data-*/data-download-url/data-file/data-model/下载按钮属性等）。
  //    3D 站常把下载地址藏在按钮/div 的属性里，而非 <a href>。
  if (heavyDom) document.querySelectorAll('*').forEach((el) => {
    el.getAttributeNames().forEach((name) => {
      const v = el.getAttribute(name);
      if (!v || typeof v !== 'string') return;
      const m = v.match(URL_RE);
      if (m) {
        const u = m[0];
        if (MODEL_RE.test(u)) push(u, 'model', 'attr:' + name);
        else if (ARCH_RE.test(u)) push(u, 'archive', 'attr:' + name);
        else if (NETDISK_RE.test(u)) push(u, 'netdisk', 'attr:' + name);
        // 其余普通 URL（如 /api 接口）不匹配扩展名，跳过，避免误判为归档污染列表
      }
    });
  });
  // 4) 内联脚本 / JSON-LD / JSON 中埋的模型/归档直链
  document.querySelectorAll('script:not([src]), script[type="application/ld+json"], script[type="application/json"]').forEach((s) => {
    const urls = (s.textContent || '').match(URL_RE) || [];
    urls.forEach((u) => {
      if (MODEL_RE.test(u)) push(u, 'model', 'script');
      else if (ARCH_RE.test(u)) push(u, 'archive', 'script');
      else if (NETDISK_RE.test(u)) push(u, 'netdisk', 'script');
    });
  });
  // 5) 页面全局变量（模型站常把模型列表挂在 window 上，如 modelList/models/asset 等）
  try {
    ['modelList', 'models', 'modelData', 'assetList', 'assets', 'modelInfo', 'playerData', 'sceneData', 'MODEL_DATA', '__MODEL__', 'downloadUrl', 'fileUrl', 'resourceInfo'].forEach((k) => {
      const obj = window[k];
      if (!obj) return;
      const urls = JSON.stringify(obj).match(URL_RE) || [];
      urls.forEach((u) => {
        if (MODEL_RE.test(u)) push(u, 'model', 'global');
        else if (ARCH_RE.test(u)) push(u, 'archive', 'global');
        else if (NETDISK_RE.test(u)) push(u, 'netdisk', 'global');
      });
    });
  } catch (_) {}

  // ShadowDOM 内部资源（现代站点大量使用）
  const scanRoot = (root) => {
    root.querySelectorAll('img').forEach((img) => push(img.currentSrc || img.src, 'image', 'shadow-img', { alt: img.alt || '' }));
    root.querySelectorAll('video').forEach((v) => push(v.src, 'video', 'shadow-video'));
    root.querySelectorAll('audio').forEach((a) => push(a.src, 'audio', 'shadow-audio'));
    root.querySelectorAll('model-viewer').forEach((m) => push(m.getAttribute('src'), 'model', 'shadow-model'));
    root.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) scanRoot(el.shadowRoot);
    });
  };
  if (heavyDom) document.querySelectorAll('*').forEach((el) => {
    if (el.shadowRoot) scanRoot(el.shadowRoot);
  });

  // 网络层捕获（引擎加载的 GLB / 音频缓冲 / 视频流）
  // ★透传原始 source（api-capture / audio-playback / youtube 等），不要硬编码覆盖成 'network'，
  // 侧栏与测试依赖 source 区分捕获来源。
  (networkAssets || []).forEach((a) => push(a.url, a.type, (a && a.source) || 'network'));

  // 动态链接/图片自动重扫：站点把下载/网盘/模型链接或图片在「点击按钮 / 滚动懒加载 / 切换 Tab /
  // 接口回调」后才注入 DOM（如 fastcampus 课程页的 커리큘럼 초안본 图、yunqiaonet 登录态链接）。
  // 静态扫描读不到 → 安装 MutationObserver，DOM 新增节点或图片属性(src/srcset/data-src/style)变化命中
  // 时通知后台去抖重扫。★2026-09-07 修复（用户实测课程页 webp 漏采根因）：原 RE 只匹配网盘/3D/视频扩展名，
  // 不含图片（.webp/.png 等）→ 动态插入的图片（如 1차초안본.webp）永远触发不了重扫 → 侧栏采不到。
  // 现把图片扩展名纳入命中，并新增 attributes 观察（懒加载图是先有 <img> 再补 src/srcset/data-src）。
  try {
    if (heavyDom && !window.__hmdao_mutation_watch) {
      window.__hmdao_mutation_watch = true;
      // 命中即触发重扫：网盘/3D/视频（原有）+ 图片（覆盖课程页内容图/懒加载图）。
      // ★2026-09-07 补充：图片扩展名补全为全量网页可渲染格式
      // （webp/png/jpg/jpeg/gif/avif/bmp/svg/ico/tiff），avif/svg 等也要能触发动态重扫，不能遗漏。
      const RE = /(pan\.baidu\.com\/s\/|lanzou|quark|xunlei|123pan|aliyundrive|\.(glb|gltf|obj|fbx|zip|rar|7z|max|blend|c4d|dae|ply|3ds|skp|stl|usdz|mp4|webm|mov|mkv|flv|avi|wmv|ts|mpg|3gp|webp|png|jpe?g|gif|avif|bmp|svg|ico|tiff?)(\?|#|$))/i;
      const IMG_ATTR_RE = /^(src|srcset|data-src|data-original|data-lazy|data-img|data-image|data-bg|style|data-nimg)$/i;
      const CSS_IMG_RE = /url\(\s*['"]?(https?:\/\/[^'")]+?\.(?:webp|png|jpe?g|gif|avif|bmp|svg|ico)(?:[?#][^'")]*)?)/i;
      const nodeHasAsset = (n) => {
        if (!n || n.nodeType !== 1) return false;
        // ★2026-09-07：新插入的 <iframe> 也触发重扫（重扫会 allFrames 注入进新子帧，
        // 否则后加载的 iframe 内的图片/链接永远采不到）。
        if (n.tagName === 'IFRAME') return true;
        const html = n.outerHTML || '';
        if (RE.test(html) || CSS_IMG_RE.test(html)) return true;
        // 子节点的图片/链接也检查（新增子树里可能含 <img>/<source>/<picture>/<a href>）
        const kids = n.querySelectorAll && n.querySelectorAll('img,source,picture,a[href]');
        if (kids) { for (const k of kids) { if (RE.test(k.outerHTML || '') || CSS_IMG_RE.test(k.outerHTML || '')) return true; } }
        return false;
      };
      const attrHasAsset = (el, name) => {
        if (!el || el.nodeType !== 1 || !IMG_ATTR_RE.test(name || '')) return false;
        const v = el.getAttribute(name) || '';
        return RE.test(v) || CSS_IMG_RE.test(v);
      };
      let _mt = 0;
      const obs = new MutationObserver((muts) => {
        let hit = false;
        for (const m of muts) {
          if (m.type === 'attributes') {
            // 懒加载：已有 <img> 的 src/srcset、或 div 的 style background-image 被填充
            if (attrHasAsset(m.target, m.attributeName)) { hit = true; break; }
            continue;
          }
          for (const n of m.addedNodes) {
            if (n.nodeType !== 1) continue;
            if (nodeHasAsset(n)) { hit = true; break; }
            if (hit) break;
          }
          if (hit) break;
        }
        if (!hit) return;
        const now = Date.now();
        if (now - _mt < 2000) return; // 客户端节流，避免 MutationObserver 风暴
        _mt = now;
        if (typeof chrome !== 'undefined' && chrome.runtime) chrome.runtime.sendMessage({ type: 'HMDAO_PAGE_MUTATION' }).catch(() => {});
      });
      // childList + attributes 双观察：覆盖「整段插入」与「先占位后补 src」两种懒加载形态
      obs.observe(document.documentElement, {
        childList: true, subtree: true,
        attributes: true, attributeFilter: ['src', 'srcset', 'data-src', 'data-original', 'data-lazy', 'data-img', 'data-image', 'data-bg', 'style', 'data-nimg'],
      });
      // ★2026-09-04 关键修复（用户实测"几分钟几万条消息"+ 卡顿）：
      //   scanPage 每次扫描都会执行到这里并【再装一个 MutationObserver】，而抖音每 10s 轮询一次
      //   → 一小时累积 ~360 个 observer，全部监听 documentElement(childList+subtree)。
      //   抖音播放器每秒改几十次 DOM（进度/时间/推荐位）→ N 个 observer × 每次变更
      //   = 海量 HMDAO_PAGE_MUTATION 消息 + 持续 CPU 占用，且永不释放。
      //   修复：整个页面生命周期只装一次。
      window.__hmdaoMutationObsInstalled = true;
    }
  } catch (_) {}

  // ★零副作用「试听/切画质后自动刷新」（2026-08-01）：用户真点试听或切换画质、
  // model-api-capture.js 把音频/视频记进 window.__hmdao_captures 后，经 window.postMessage
  // 跨 world 通知本 ISOLATED 上下文 → 去抖转发后台触发 rescan，侧栏实时出现音效/多分辨率视频。
  // 纯被动：不主动点击/播放/切换画质，仅在真实发生后刷新。
  try {
    if (!window.__hmdao_audio_rescan_watch) {
      window.__hmdao_audio_rescan_watch = true;
      let _at = 0;
      window.addEventListener('message', (ev) => {
        try {
          if (!ev || !ev.data) return;
          const t = ev.data.__hmdao_type;
          if (t !== 'AUDIO_CAPTURED' && t !== 'VIDEO_CAPTURED') return;
          const now = Date.now();
          if (now - _at < 2000) return; // 去抖，避免连点风暴
          _at = now;
          if (typeof chrome !== 'undefined' && chrome.runtime) {
            chrome.runtime.sendMessage({ type: 'HMDAO_PAGE_MUTATION' }).catch(() => {});
          }
        } catch (_) {}
      });
    }
  } catch (_) {}

  // ★图片像素去重：同一张图常在不同位置以不同尺寸出现（缩略图 / 原图 / 带尺寸 query 参数的变体）。
  // 按 host+pathname 归组（忽略 query/hash 的尺寸参数），每组只保留「像素最大」的那张，其余小图剔除。
  // 优先用 <img> 的 naturalWidth*naturalHeight 比较；像素未知时回退按「原图来源优先」(a>img / img[data] 通常比 img / css-bg 更大)。
  {
    const imgIdx = [];
    out.forEach((a, i) => { if (a.type === 'image') imgIdx.push(i); });
    const groups = new Map();
    for (const i of imgIdx) {
      const a = out[i];
      let key;
      try {
        const u = new URL(a.url);
        key = u.host + normalizeImagePathname(u.pathname); // 抹掉 query/hash 与处理后缀 → 同图不同尺寸变体合并
      } catch (_) {
        key = a.url;
      }
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(i);
    }
    const FULL_PREF = { 'a>img': 0, 'img[data]': 1, 'img[srcset]': 2, 'shadow-img': 3, 'video[poster]': 4, 'css-bg': 5, 'picture': 5, 'img': 6 };
    const drop = new Set();
    for (const [, idxs] of groups) {
      if (idxs.length < 2) continue;
      let best = idxs[0];
      for (const j of idxs) {
        const a = out[j], b = out[best];
        const pa = a.px || 0, pb = b.px || 0;
        if (pa !== pb) { if (pa > pb) best = j; continue; }
        // 像素相同/都未知：原图来源优先
        const ra = FULL_PREF[a.source] != null ? FULL_PREF[a.source] : 99;
        const rb = FULL_PREF[b.source] != null ? FULL_PREF[b.source] : 99;
        if (ra < rb) best = j;
      }
      for (const j of idxs) if (j !== best) drop.add(j);
    }
    if (drop.size) {
      const kept = [];
      out.forEach((a, i) => { if (!drop.has(i)) kept.push(a); });
      out = kept;
    }
  }

  // 合集/列表页检测（借鉴 seekin.ai 的「抖音合集」能力）：当前页面是合集时，
  // 注入一条 type:'playlist' 资产，侧栏可展开批量选择下载。抖音合集页 URL 多为
  // /collection/xxx 或带 mix_id/playlist_id；B站/优酷等合集同理。
  try {
    const host = location.hostname.toLowerCase();
    const path = location.pathname.toLowerCase();
    const isCollection =
      /collection|mix_id|playlist|album|play_list|channel\/(\d+)\/mix/i.test(location.href) ||
      /\/collection\//.test(path) || /\/mix\//.test(path) || /\/playlist\//.test(path);
    if (isCollection && (host.includes('douyin') || host.includes('bytedance') || host.includes('xinpianchang') || host.includes('bilibili') || host.includes('youku') || host.includes('iqiyi'))) {
      // 避免重复注入：若已存在同页 playlist 资产则跳过
      const hasPlaylist = out.some((a) => a.type === 'playlist' && a.playerUrl === location.href);
      if (!hasPlaylist) {
        out.push({
          type: 'playlist',
          url: location.href,
          playerUrl: location.href,
          title: (document.title || '合集').replace(/\s*[-_|]\s*(抖音|新片场|哔哩哔哩|优酷|爱奇艺).*$/i, '').trim() || '合集',
          name: '合集',
          source: 'collection-page',
          isCollection: true,
        });
      }
    }
  } catch (_) {}

  // 兜底：如果当前页面 URL 本身就是网盘分享链接，把该页作为网盘资产加入侧栏
  // 这样用户直接在地址栏打开网盘页时也能看到「深度解析」入口。
  // ★ 2026-08-09 同步：pan.xunlei.com 自己网盘（?path=...）也作为 netdisk 资产加入，
  //    避免 zip 文件被误归类为 archive 后无法下载。
  try {
    const pageUrl = location.href;
    if (NETDISK_RE.test(pageUrl)) {
      const exists = out.some((x) => x.url === pageUrl || x.url === (new URL(pageUrl).origin + new URL(pageUrl).pathname));
      if (!exists) {
        const isXunleiMyDrive = /pan\.xunlei\.com\?.*\bpath=/i.test(pageUrl);
        const defaultTitle = isXunleiMyDrive ? '迅雷云盘·我的转存' : '网盘分享页';
        out.push({
          url: pageUrl,
          type: 'netdisk',
          source: isXunleiMyDrive ? 'xunlei-mydrive-current-page' : 'netdisk-current-page',
          title: document.title || defaultTitle,
          name: document.title || defaultTitle,
        });
      }
    }
  } catch (_) {}

  // ★2026-08-18 修复：新片场素材库页（stock.xinpianchang.com/footage/details/<id>.html）
  //   与文章页（www.xinpianchang.com/a<数字>）都是视频站，但页面不用 <iframe> 内嵌可识别播放器，
  //   scanPage 抓不到 embed / 裸 mp4 直链，只会把封面图当 image 入库 → 侧栏下载的是图片。
  //   这里强制补一条 type:'video' 资产（playerUrl=源页），让侧栏 downloadSingle 走 yt-dlp 解析直链，
  //   经 background 的 tryXinpianchang 拿到 progressive mp4 再下载，彻底告别"下到封面图"。
  try {
    const ph = location.hostname.toLowerCase();
    if (ph.includes('xinpianchang.com')) {
      const hasXpcVideo = out.some((a) => a && a.type === 'video' && /xinpianchang/i.test(a.url || a.playerUrl || a.pageUrl || ''));
      if (!hasXpcVideo) {
        out.push({
          type: 'video',
          platform: 'xinpianchang',
          url: location.href,
          playerUrl: location.href,
          pageUrl: location.href,
          title: (document.title || '新片场视频').replace(/\s*[-_|]\s*新片场.*$/i, '').trim() || '新片场视频',
          name: '新片场视频',
          source: 'xinpianchang-page',
        });
      }
    }
    // ★2026-08-18 修复：aigc.xinpianchang.com（新片场 AI 创作社区）图片/视频都采不到。
    //   根因：aigc 是 React/Next SPA，作品网格的真实媒体 URL 在【内联 JSON】里（window.__INITIAL_STATE__
    //   或 <script id="__NEXT_DATA__">），DOM 里的 <img> 常是懒加载占位/data-src，扫描时机视口外的还没渲染。
    //   通用 <img>/<video> 采集会漏掉未渲染项，故对 aigc 子域直接从内联数据深抓图片+视频。
    if (ph.includes('aigc.xinpianchang.com')) {
      try {
        const XPC_IMG_RE = /https?:\/\/[^"'\\<>\s)]+?(?:\.xpccdn\.com|\.xinpianchang\.com|image\.xinpianchang|oss-xpc)[^"'\\<>\s)]*?\.(?:jpg|jpeg|png|webp|gif|avif|bmp|svg|ico|tiff?)(?:[?#][^"'\\<>\s)]*)?/gi;
        const XPC_VIDEO_RE = /https?:\/\/[^"'\\<>\s)]+?\.(?:mp4|webm|mov|m4v|m3u8)(?:[?#][^"'\\<>\s)]*)?/gi;
        const XPC_JSON_IMG_RE = /"(?:coverUrl|cover|imageUrl|image|imgUrl|picUrl|url|src|original|thumbnail|poster)"\s*:\s*"(https?:[^"]+?)"/gi;
        const collectJson = (jsonStr) => {
          if (!jsonStr) return;
          let m;
          XPC_IMG_RE.lastIndex = 0;
          while ((m = XPC_IMG_RE.exec(jsonStr))) push(m[0].replace(/\\\//g, '/'), 'image', 'aigc-json');
          XPC_VIDEO_RE.lastIndex = 0;
          while ((m = XPC_VIDEO_RE.exec(jsonStr))) push(m[0].replace(/\\\//g, '/'), 'video', 'aigc-json');
          XPC_JSON_IMG_RE.lastIndex = 0;
          while ((m = XPC_JSON_IMG_RE.exec(jsonStr))) {
            const u = m[1].replace(/\\\//g, '/');
            if (/\.(mp4|webm|mov|m4v|m3u8)/i.test(u)) push(u, 'video', 'aigc-json');
            else if (/\.(jpg|jpeg|png|webp|gif|avif|bmp)/i.test(u) || /xpccdn|xinpianchang/i.test(u)) push(u, 'image', 'aigc-json');
          }
        };
        // a) 全局变量
        ['__INITIAL_STATE__', '__NEXT_DATA__', 'initialState', 'pageData', 'serverData'].forEach((k) => {
          try { if (window[k]) collectJson(JSON.stringify(window[k])); } catch (_) {}
        });
        // b) 内联 script（含 __NEXT_DATA__ / window.__INITIAL_STATE__ = {...}）
        document.querySelectorAll('script:not([src])').forEach((s) => {
          const t = s.textContent || '';
          if (/xinpianchang|xpccdn|cover|image|video|pic/i.test(t)) collectJson(t);
        });
        // c) 页面 HTML 裸 URL（兜底）
        const htmlTxt = document.documentElement && document.documentElement.innerHTML || '';
        collectJson(htmlTxt);
      } catch (_) {}
    }

    // ★2026-08-18 新增（2026-08-18 修正 Backbone 解析）：花瓣 huaban.com 是 Backbone SPA，
    //   瀑布流 90% 的图在 window.app 的 Backbone 集合里（pin 是 Model，需 .toJSON() 取纯数据）。
    //   静态 DOM 扫描只能拿到 1-2 张封面，这里做三件事：
    //     ① 正确解析 window.app（Backbone：app.pins._byId / app.board.pins._byId，每个 pin 是 Model）；
    //     ② 异步等 2 秒让 SPA 把"相关推荐"渲染进 DOM，再抓 <img>（详情页默认只渲染当前 pin）；
    //     ③ 调 api.huaban.com/pins/<id>（带 cookie）拿原图 + board_id，再翻页整个 board。
    //   关键事实（已用 Playwright 探针验证 2026-08-18）：huaban 强风控，无登录态/headless 100% 被
    //   captcha.eo.qq.com 拦截 → 任何纯前端方案都必须用户登录态才能采到。
    if (ph.includes('huaban.com')) {
      try {
        // ★2026-08-18 修复 CORS：api.huaban.com 的跨域 fetch 在 ISOLATED 世界会被浏览器 CORS 预检拦截
        // （无论是否登录，登录态只解决鉴权不解决跨域头）。改经 background 的 HMDAO_NETDISK_FETCH 通道
        // 发起——Service Worker 的 fetch 不受 CORS 限制，且带 cookie 能过登录态。
        // 返回 { ok, status, json }（json 为已解析对象或 null）。
        const hbFetch = (u) => new Promise((resolve) => {
          try {
            chrome.runtime.sendMessage(
              { type: 'HMDAO_NETDISK_FETCH', url: u, method: 'GET', headers: {
                'Accept': 'application/json', 'Referer': location.href, 'X-Requested-With': 'XMLHttpRequest',
              } },
              (resp) => {
                try {
                  if (resp && resp.ok && resp.json) resolve(resp.json);
                  else resolve(null);
                } catch (_) { resolve(null); }
              }
            );
          } catch (_) { resolve(null); }
        });
        // 工具：从任意对象深抓 hbimg 链接（Backbone Model 用 .toJSON()，普通对象直接 JSON.stringify）
        const HB_RE = /https?:\/\/hbimg\.(?:b0\.)?upaiyun\.com\/[a-zA-Z0-9_/.\-]+/g;
        // 把 upaiyun key 拼成原图 URL。
        // 注意：路径末段必须保留 key 本体（不能固定成 fw/2048.jpg），否则 card-render 的去重
        // 会把所有花瓣原图按末段「2048」当成同一张而合并成 1 张。
        // 规格用 query 参数 ?imageView/... 或 fw 放在 key 之后、用 .jpg 收尾，末段仍是 key 派生值。
        const keyToUrl = (key) => {
          const k = String(key).replace(/^https?:\/\/hbimg\.(?:b0\.)?upaiyun\.com\//, '').replace(/\.(jpg|jpeg|png|webp|gif)$/i, '');
          // 末段保持 key 唯一性：<key>.jpg?imageView2/2/w/2048
          return 'https://hbimg.b0.upaiyun.com/' + k + '.jpg?imageView2/2/w/2048';
        };
        const addHb = (u, src) => {
          if (!u) return;
          // 情况1：完整 hbimg URL（含扩展名）→ 直接收
          if (/hbimg\.(?:b0\.)?upaiyun\.com/.test(u) && /\.(jpg|jpeg|png|webp|gif)/i.test(u)) {
            push(u + (u.includes('?') ? '&' : '?') + 'v=1', 'image', src);
            return;
          }
          // 情况2：裸 upaiyun key（如 a1b2c3...，无 host 无扩展名）→ 拼原图 URL
          if (/^[a-zA-Z0-9/_.-]+$/.test(u) && u.length > 8 && !/^https?:/.test(u)) {
            push(keyToUrl(u), 'image', src);
          }
        };
        const scanStr = (s, src) => {
          if (!s || s.length > 2000000) return;
          let m;
          HB_RE.lastIndex = 0;
          while ((m = HB_RE.exec(s))) addHb(m[0], src);
          // 兜底：抓 JSON 里的裸 upaiyun key（"key":"xxxx" / "file_id":"xxxx"）
          const KEY_RE = /"(?:key|file_id|file_key|original|url)":\s*"([a-zA-Z0-9/_.-]{12,})"/g;
          let km;
          while ((km = KEY_RE.exec(s))) {
            const v = km[1];
            if (!/^https?:/.test(v) && /^[a-zA-Z0-9/_.-]+$/.test(v)) addHb(v, src);
          }
        };
        // 把 Backbone 集合/Model 转纯 JSON
        const toPlain = (o) => {
          try {
            if (!o) return null;
            if (typeof o.toJSON === 'function') return o.toJSON();
            if (o.attributes) return o.attributes;
            return o;
          } catch (_) { return o; }
        };
        try {
          if (window.app) {
            // 优先 collections：app.pins / app.board.pins
            const collections = [];
            if (window.app.pins) collections.push(window.app.pins);
            if (window.app.board && window.app.board.pins) collections.push(window.app.board.pins);
            for (const col of collections) {
              let arr = [];
              try {
                if (col._byId) arr = Object.values(col._byId);
                else if (Array.isArray(col.models)) arr = col.models;
                else if (Array.isArray(col)) arr = col;
              } catch (_) {}
              for (const model of arr) {
                const p = toPlain(model) || {};
                // pin 的图在 file.key（upaiyun key）或 file.url
                if (p.file && (p.file.key || p.file.url)) {
                  const key = p.file.key || '';
                  const url = p.file.url || ('https://hbimg.b0.upaiyun.com/' + key);
                  addHb(url, 'huaban-app');
                  // board 信息
                  if (p.board_id) { try { window.__hmdao_huaban_board_id = p.board_id; } catch (_) {} }
                }
                // 有些 pin 在 raw_text / media 里有 hbimg
                scanStr(JSON.stringify(p).slice(0, 200000), 'huaban-app');
              }
            }
            // 全局 window.app 再扫一遍（兜底）
            scanStr(JSON.stringify(window.app).slice(0, 500000), 'huaban-app-raw');
          }
        } catch (_) {}
        // b) 内嵌 <script> JSON
        try {
          document.querySelectorAll('script:not([src])').forEach((s) => {
            const t = s.textContent || '';
            if (/hbimg|huaban|file|board|pin/i.test(t)) scanStr(t, 'huaban-script');
          });
        } catch (_) {}
        // c) 异步等 SPA 渲染"相关推荐"，再抓 DOM <img>（详情页默认只渲染当前 pin）
        try {
          await new Promise((r) => setTimeout(r, 2000));
          document.querySelectorAll('img').forEach((img) => {
            const src = img.currentSrc || img.src;
            if (src && /hbimg|upaiyun|huaban\.com\/|\/pins\//i.test(src)) addHb(src, 'huaban-dom');
          });
        } catch (_) {}
        // d) 详情页单图：huaban 接口拿原图（★经 background 跨域通道，绕过 CORS；带 cookie 过登录态）
        try {
          const mPin = location.pathname.match(/^\/pins\/(\d+)/);
          if (mPin) {
            const pinId = mPin[1];
            const apiResp = await hbFetch('https://api.huaban.com/pins/' + pinId + '?fetch=1');
            if (apiResp && apiResp.pin && apiResp.pin.file) {
              const f = apiResp.pin.file;
              const key = f.key || '';
              const url = f.url || ('https://hbimg.b0.upaiyun.com/' + key);
              addHb(url, 'huaban-api');
              if (apiResp.pin.board_id) { try { window.__hmdao_huaban_board_id = apiResp.pin.board_id; } catch (_) {} }
            }
          }
        } catch (_) { /* 接口失败（captcha/无登录）退回到通用采集 */ }
        // e) 翻页整个 board（需 __hmdao_huaban_board_id，由 c/d 设置；★同样经 background 跨域通道）
        try {
          const boardId = window.__hmdao_huaban_board_id;
          if (boardId) {
            let max = 0, got = 0, page = 0;
            while (page < 20) {
              const url = 'https://api.huaban.com/boards/' + boardId + '/pins?limit=40&max=' + max;
              const j = await hbFetch(url);
              if (!j || !j.pins || !j.pins.length) break;
              for (const pin of j.pins) {
                if (pin.file && (pin.file.key || pin.file.url)) {
                  const u = pin.file.url || ('https://hbimg.b0.upaiyun.com/' + pin.file.key);
                  addHb(u, 'huaban-board');
                  got++;
                }
              }
              max = j.pins[j.pins.length - 1].pin_id || (max + 40);
              if (j.pins.length < 40) break;
              page++;
            }
            if (got) console.log('[HMDAO][huaban] 翻页采到 board', boardId, '共', got, '张');
          }
        } catch (_) {}
      } catch (_) {}
    }
  } catch (_) {}

  // ★通用兜底：DOM 扫描可能漏掉 CSS 背景图、JS 模板、懒加载占位、内联 JSON/脚本里的图片直链等。
  //   把 innerHTML 里出现的图片 URL 再扫一遍，补抓 webp/png/jpg/gif/avif/svg/tiff。
  //   ★2026-09-07 修正：原门限 ≤100 在「图片数>100 的正常内容页」会整段跳过兜底 → avif 等藏在
  //   内联 JSON/脚本里的链接永远采不到。抬高到 ≤400（仅极端大页跳过，避免 innerHTML 全扫开销），
  //   正常 100+ 图的内容页也能跑兜底，补回 avif 等链接。
  try {
    if (out.filter((a) => a && a.type === 'image').length <= 400) {
      const htmlTxt = document.documentElement && document.documentElement.innerHTML || '';
      const GENERIC_IMG_RE = /https?:\/\/[^"'<>\s)]+?\.(?:webp|png|jpe?g|gif|avif|bmp|svg|ico|tiff?)(?:[?#][^"'<>\s)]*)?/gi;
      let gm;
      while ((gm = GENERIC_IMG_RE.exec(htmlTxt))) push(gm[0], 'image', 'html-fallback');
    }
  } catch (_) {}

  // ★2026-09-11 诊断（「侧栏扫描不到素材」定位用）：扫完 0 条 → 打印页面画像，
  //   让用户一行 Console 看出根因：① 整页本就没 <img>（登录墙 / Canvas 渲染 / 跨域 iframe）；
  //   ② 图片在跨域 iframe 里（allFrames 也够不到，只能用户手动开那个 iframe 页扫描）；
  //   ③ 内联 JSON/脚本里虽有 URL 但被正则漏掉（把样例 img 也打印出来便于补正则）。
  if (!out.length) {
    try {
      const iframes = [...document.querySelectorAll('iframe')];
      const cross = iframes.filter((f) => {
        const s = f.src || '';
        if (!s) return false;
        try { return new URL(s, location.href).hostname !== location.hostname; } catch (_) { return true; }
      }).length;
      const lazy = document.querySelectorAll('[data-src],[data-original],[data-lazy-src],[data-webp-src],[data-bg],[data-imgurl]').length;
      const htmlImgHits = (() => {
        const t = document.documentElement.innerHTML || '';
        const m = t.match(/https?:\/\/[^"'<>\s)]+?\.(?:webp|png|jpe?g|gif|avif|bmp|svg)(?:[?#][^"'<>\s)]*)?/gi);
        return m ? m.length : 0;
      })();
      const sampleImgs = [];
      for (let i = 0; i < Math.min(document.images.length, 3); i++) sampleImgs.push((document.images[i].currentSrc || document.images[i].src || '').slice(0, 90));
      console.warn('[HMDAO][scan-diag] 0 素材 host=' + location.hostname +
        ' imgs=' + document.images.length +
        ' videos=' + document.querySelectorAll('video').length +
        ' canvas=' + document.querySelectorAll('canvas').length +
        ' iframes=' + iframes.length + '(跨域=' + cross + ')' +
        ' lazyAttrs=' + lazy +
        ' htmlImgUrls=' + htmlImgHits +
        ' title=' + (document.title || '').slice(0, 24));
      if (sampleImgs.length) console.warn('[HMDAO][scan-diag] 样例 img:', sampleImgs);
    } catch (_) {}
  }

  // ★根因 B 修复：原 out.slice(0, 800) 会把排在最后的 3D/归档条目裁掉（图片/视频/音频段先跑，画廊页极易超 800）。
  // 改为：模型/归档/网盘条目永远保留，只在图片/视频/音频里做预算裁剪。
  const CAP = 800;
  if (out.length <= CAP) return out;
  const priority = out.filter((a) => a.type === 'model' || a.type === 'archive' || a.type === 'netdisk' || a.type === 'playlist');
  const media = out.filter((a) => a.type !== 'model' && a.type !== 'archive' && a.type !== 'netdisk' && a.type !== 'playlist');
  const room = Math.max(0, CAP - priority.length);
  return priority.concat(media.slice(0, room));
}

// 视频封面采集（注入 MAIN 世界运行，自包含，禁止引用 background 作用域）。
// 返回 { byKey:{<video直链>:<封面URL>}, defaultCover:<页面默认封面>, pageCovers:[{kind,url}], pairs:{<视频直链>:<真封面>} }。
// - byKey：优先用平台直链键匹配（B站 playurl 直链↔__INITIAL_STATE__ 封面命中率有限，故主要依赖 defaultCover/pageCovers 兜底）。
// - defaultCover：B站 videoData.pic / 抖音 aweme.cover —— 同页视频资产的最佳封面。
// - pageCovers：页面所有 <video poster> —— 通用站点兜底封面。
// - pairs：★2026-09-11 新增。与视频直链【一一对应】的真封面（<video poster> / 内联 JSON 成对 cover 字段），
//   用于取代"页面 <img> 按 DOM 序猜测分发"造成的封面错配。
function extractVideoCovers() {
  const byKey = {};
  let defaultCover = '';
  const pageCovers = [];
  // ★2026-09-11：pairs = { <视频直链>: <与该直链一一对应的真封面> }（video[poster] / 内联 JSON 成对字段）
  const pairs = {};

  // ★2026-08-31 修复（jingxuan 占位符 RENDER_DATA → byKey 空 → 封面错配根因）：
  //   现代抖音 jingxuan 页 RENDER_DATA 仅 26 字符占位符，RENDER_DATA walk 拿不到任何 aweme，
  //   封面被迫回退到「页面最大非推广 img」→ 与当前播放视频不符。
  //   可靠来源 = 页面正在播放的 <video> 元素的 poster / xgplayer poster 容器背景图 / 播放器附近真实缩略图。
  //   因此把封面识别白/黑名单提升到函数作用域，并新增 extractPlayerPoster() 专门从播放器 DOM 抓当前视频封面。
  // —— 抖音视频缩略图白名单（含 i/pc 段、douyinpic/byteimg/tplv-dy 等常见 CDN 指纹）——
  const isVideoThumb = (url) => /(tos-cn-(i|pc)|aweme-(subCover|image|cover)|img-video|image-view|img-web|aweme-image|video-cover|video-poster|aweme-cover|douyinpic\.com|byteimg\.com|lf-douyin-pc-web|image-cut-tos|p\d{1,2}-pc-|tplv-dy-)/i.test(url);
  // —— 推广/认证/横幅/头像/二维码黑名单（电子营业执照、verify-、license-business 等）——
  const isPromo = (url) => /(verify-|license-business|qrcode|qr-|banner|ad-|promo|advert|sponsor|avatar|emoji|logo|loading|sprite|placeholder|thumb\d{1,2}x\d{1,2}|\bicon[/-]|user-?data|sign(?:ature)?=|favicon|og[-_.]?(?:image|share|poster)|social[-_]?(?:share|preview)|apple-touch|share[-_]?(?:image|icon|logo|img))/i.test(url);
  // ★2026-09-08 补充（runninghub 全部视频卡共用 og 分享图根因）：
  //   og:image / og-share / social share 是【页面级品牌分享图】，永远不是某条视频的内容封面。
  //   实测 runninghub.cn 的 defaultCover 候选排序按「面积最大」取到 assets/images/og-share-cn.png
  //   （品牌绿底红标图，且该文件服务端已 404）→ 全部视频卡被塞同一张品牌图。
  //   把 og/social-share/apple-touch 一类加入推广黑名单，从候选源头排除。
  // ★2026-09-03 修复（视频卡缩略图 404 真凶）：
  //   抖音把监控上报做成 <img> 信标 https://mssdk.bytedance.com/web/common?ms_appid=6383&msToken=...
  //   它的 naturalWidth/Height 均为 0 → 躲过下方 `area > 0 && area < 80*80` 的小图过滤，
  //   又被当成"页面唯一可见缩略图"兜底成封面 → /api/media-proxy 去拉必然 404。
  //   现新增「监控/埋点/信标」黑名单：mssdk、msToken、slardar、apm、beacon、webid、/web/common、tea. 等。
  const isBeacon = (url) => /(mssdk|msToken|ms_appid|slardar|apm\.|beacon|log-sdk|webid|tea\.|toblog|\/web\/common|monitor\.|\/monitor\/|report\.|\/report\?|metrics|\/collect\?|pixel\.)/i.test(url);
  // 从播放器 DOM 抓「当前正在播放视频」的真实封面（jingxuan 占位 RENDER_DATA 时的唯一可靠来源）
  function extractPlayerPoster() {
    try {
      const videos = Array.from(document.querySelectorAll('video'));
      const toAbs = (p) => { try { return new URL(p, location.href).href; } catch (_) { return p; } };
      const pickPoster = (v) => {
        const p = v.getAttribute('poster') || v.poster;
        if (p && /^https?:/i.test(p)) { const abs = toAbs(p); if (!isPromo(abs)) return abs; }
        return '';
      };
      // ★2026-08-31 边界修复：页面可能含多个 <video>（背景视频/广告）。优先取**正在播放**的那个
      //   （MSE 播放时 <video>.src 为 blob:；或 src 命中平台域名）→ 其 poster 才是当前视频封面，避免取错。
      const isPlaying = (v) => /^(blob:|https?:.*(douyin|tiktok|bytedance|ixigua))/i.test(v.currentSrc || v.src || '');
      for (const v of videos) { if (isPlaying(v)) { const r = pickPoster(v); if (r) return r; } }
      // 兜底：任意带有效 poster 的 <video>
      for (const v of videos) { const r = pickPoster(v); if (r) return r; }
      // 2) xgplayer poster 容器背景图（部分版本用 div.xgplayer-poster 而非 <video poster>）
      const posterEl = document.querySelector('.xgplayer-poster, .xgplayer-poster-img, [class*="poster"]');
      if (posterEl) {
        const bg = (posterEl.style && posterEl.style.backgroundImage) || (typeof getComputedStyle === 'function' ? getComputedStyle(posterEl).backgroundImage : '') || '';
        const m = bg.match(/url\(["']?(https?:[^"')]+)["']?\)/i);
        if (m && !isPromo(m[1])) return m[1];
      }
      // 3) 播放器容器内最近的真实视频缩略图 <img>（详情页常把封面放 .video-card / .player 容器里）
      const playerWrap = document.querySelector('.xgplayer, [class*="player"], [class*="video-container"], [class*="video-card"]');
      if (playerWrap) {
        // ★2026-09-10 修复（MSN 等通用站视频卡无封面根因）：
        //   isVideoThumb 是【抖音专属】CDN 指纹白名单（tos-cn- / aweme- / byteimg / tplv-dy 等），
        //   设计目的是把真视频缩略图从"电子营业执照/推广图"里挑出来。
        //   但它对非抖音站（MSN 封面用 img-s-msn-com.akamaized.net）会把所有真实封面
        //   全部判为「非视频缩略图」→ 播放器容器内永远选不到封面 → 视频卡一片空白。
        //   修复：该白名单【只在抖音/字节系站点强制】；其余站点退化为"非推广图 + 面积门槛"。
        const isDouyinSite = /(^|\.)(douyin|iesdouyin|tiktok)\.com$/i.test((location && location.hostname) || '');
        const imgs = Array.from(playerWrap.querySelectorAll('img')).filter((im) => {
          const s = im.currentSrc || im.src || '';
          if (!s || /^data:|^blob:/i.test(s)) return false;
          if (isPromo(s)) return false;
          if (isDouyinSite && !isVideoThumb(s)) return false; // 仅抖音站强制 CDN 指纹
          return (im.naturalWidth || 0) >= 120;               // 通用站：面积门槛剔除小图标
        }).sort((a, b) => (b.naturalWidth || 0) - (a.naturalWidth || 0));
        if (imgs[0]) {
          const s = imgs[0].currentSrc || imgs[0].src;
          const abs = (() => { try { return new URL(s, location.href).href; } catch (_) { return s; } })();
          if (!isPromo(abs)) return abs;
        }
      }
    } catch (_) {}
    return '';
  }

  // ★2026-08-22 一次性根除「9 张同款电子营业执照」（基于真机日志实证）：
  //   抖音 xgplayer modal <video> 多带 crossorigin="anonymous" → canvas drawImage 抛 SecurityError
  //   → firstFrame 永远拿不到。原 firstFrame 路径撤回。
  //   改用「页面 <img> 真实视频缩略图模式识别」：抖音视频缩略图 URL 实际模式：
  //     - tos-cn-i-xxx / tos-cn-pc-xxx / aweme-subCover / aweme-image / img-video / image-view / img-web
  //     - 且必须不含 verify-license/license-business/qrcode/banner/ad-/promo
  //   按"是否含视频缩略图特征 + 面积大"双重排序，最大一张作为 defaultCover。
  //   这是用户真机截图实证有效的策略：右侧 3 张蓝色/红色封面 = tos-cn-i-xxx 类图，正是抖音视频缩略图。
  try {
    // 1) B站封面：window.__INITIAL_STATE__.videoData.pic（已 URL编码，需解码）
    try {
      const ini = window.__INITIAL_STATE__;
      if (ini && ini.videoData && ini.videoData.pic) {
        defaultCover = decodeURIComponent(ini.videoData.pic);
      }
      // ★2026-08-22 信息流批量采集（B站）：合集/列表每个 episode 的封面进 byKey['aweme:<id>']，
      // 保证批量采集的每条 B站资产按其自身 id 精确取封面（与抖音 aweme:<id> 键约定统一），
      // 避免批量资产全部回退到 defaultCover（当前播放视频封面）导致错乱。
      const season = ini && (ini.ugcSeason || (ini.videoData && ini.videoData.ugc_season));
      const eps = [];
      if (season && Array.isArray(season.sections)) {
        season.sections.forEach((sec) => { if (sec && Array.isArray(sec.episodes)) eps.push(...sec.episodes); });
      }
      if (!eps.length && Array.isArray(ini.relatedVideos)) eps.push(...ini.relatedVideos);
      eps.forEach((ep) => {
        const id = String(ep.aid || (ep.arc && ep.arc.bvid) || ep.bvid || '');
        const pic = ep.arc && ep.arc.pic ? ep.arc.pic : (ep.cover || '');
        if (id && pic) byKey['aweme:' + id] = decodeURIComponent(pic).replace(/\\\//g, '/');
      });
    } catch (_) {}
    // 2) 抖音/视频号封面：RENDER_DATA 里 aweme.cover
    if (!defaultCover) {
      try {
        const el = document.querySelector('script#RENDER_DATA, script[id="RENDER_DATA"]');
        if (el && el.textContent) {
          const data = JSON.parse(decodeURIComponent(el.textContent));
          let chosen = null;
          const targetId = (function () {
            try {
              const u = new URL(location.href);
              return u.searchParams.get('modal_id') || u.searchParams.get('aweme_id') || u.searchParams.get('feedid') || u.searchParams.get('id') || '';
            } catch (_) { return ''; }
          })();
          // ★2026-08-22 修复（jingxuan 电子营业执照根因）：现代抖音 RENDER_DATA 用驼峰 awemeId，
          // 旧 walk 只认 aweme_id（下划线），导致精确匹配失败 + byKey 全空 → 所有卡片回退 defaultCover（首个命中对象，
          // 常为「电子营业执照」推广视频）。现同时兼容 aweme_id 与 awemeId。
          // ★2026-08-22 修复（jingxuan 封面根因）：抖音现代 RENDER_DATA 里 video.cover 是【字符串】（直链），
          // 不是 { url_list:[...] } 对象。旧逻辑只看 o.video.cover.url_list，对 string 永远 undefined → byKey 空 → 回退电子营业执照。
          // 兼容：cover 为 string 直接取；为对象取 url_list/urlList；并补 coverUrlList / cover169UrlList / originCover。
          const awemeIdOf = (o) => (o && (o.awemeId != null ? String(o.awemeId) : (o.aweme_id != null ? String(o.aweme_id) : '')));
          const coverUrlOf = (v) => {
            if (!v) return '';
            // 直接字符串
            if (typeof v.cover === 'string' && v.cover) {
              let c = v.cover.replace(/\\\//g, '/');
              if (/^https?:/i.test(c) || /^data:/i.test(c)) return c;
            }
            // 对象 { url_list:[], urlList:[] }
            if (v.cover && typeof v.cover === 'object') {
              const cl = v.cover.url_list || v.cover.urlList || [];
              if (cl.length) return String(cl[0]).replace(/\\\//g, '/');
            }
            // 数组候选
            const arrCands = [v.coverUrlList, v.cover169UrlList, v.cover169BigUrlList, v.originCoverUrlList, v.originCover, v.rawCover, v.dynamicCover]
              .flatMap((x) => (Array.isArray(x) ? x : (x ? [x] : [])));
            for (const c of arrCands) {
              if (typeof c === 'string' && /^https?:/i.test(c)) return c.replace(/\\\//g, '/');
              if (c && typeof c === 'object' && (c.url_list && c.url_list[0])) return String(c.url_list[0]).replace(/\\\//g, '/');
              if (c && typeof c === 'object' && (c.urlList && c.urlList[0])) return String(c.urlList[0]).replace(/\\\//g, '/');
            }
            return '';
          };
          const walk = (o) => {
            if (!o || typeof o !== 'object') return;
            if (Array.isArray(o)) { o.forEach(walk); return; }
            const hasV = o.video && (o.video.play_addr || o.video.download_addr);
            const am = awemeIdOf(o);
            // ★优先按 targetId 精确命中（当前播放集），其次首个有视频的对象兜底
            if (targetId && String(am) === String(targetId)) chosen = o;
            else if ((am || hasV) && !chosen) chosen = o;
            // 信息流多视频场景，每个 aweme 的封面都应进 byKey（避免其它视频 dyUrls 资产拿不到精确封面）。
            const cv = coverUrlOf(o.video);
            if (am && cv) {
              byKey['aweme:' + am] = cv;
            }
            for (const k in o) { try { walk(o[k]); } catch (_) {} }
          };
          walk(data);
          if (chosen && chosen.video) {
            const c = coverUrlOf(chosen.video);
            if (c) {
              defaultCover = c;
              const am = awemeIdOf(chosen);
              // 抖音封面通常无水印，作为 byKey 键（以 awemeId 视频直链兜底由 scan.js 同页兜底处理）
              if (am) byKey['aweme:' + am] = c;
              else if (targetId) byKey['aweme:' + targetId] = c;
            }
          }
          // ★2026-08-31 修复（jingxuan 占位 RENDER_DATA → byKey 空 → 封面错配）：
          //   若 RENDER_DATA walk 一个 aweme 都没拿到（byKey 空）或默认封面仍空，
          //   改从「正在播放的播放器 DOM」抓当前视频真实封面（video[poster] / xgplayer poster 背景 / 播放器内 <img>）。
          //   单视频 jingxuan 页此封面即当前播放视频封面，与 a.url 一一对应，彻底消除"电子营业执照"错配。
          if ((!defaultCover || Object.keys(byKey).length === 0)) {
            const playerPoster = extractPlayerPoster();
            if (playerPoster) {
              defaultCover = playerPoster;
              if (targetId) byKey['aweme:' + targetId] = playerPoster;
            }
          }
        }
      } catch (_) {}
    }
    // 3) 新片场封面：页面内嵌 __INITIAL_STATE__ / RENDER_DATA 里的 cover / poster / video_pic 字段
    if (!defaultCover || pageCovers.length === 0) {
      try {
        const scripts = Array.from(document.querySelectorAll('script'))
          .map((s) => s.textContent || '').filter((t) => t && /xinpianchang|cover|poster|video_pic|pic/i.test(t));
        for (const t of scripts) {
          // 宽松匹配 "...cover":"https://..." 或 "...poster":"..." 或 "...video_pic":"..."
          const mm = t.match(/"\s*(?:cover|poster|video_pic|pic)\s*"\s*:\s*"\s*(https?:[^"\\{}]+?\.(?:jpg|jpeg|png|webp)(?:\?[^"\\{}]*)?)\s*"/i)
            || t.match(/https?:\/\/[^"'\\<>\s]+\.xinpianchang\.com[^"'\\<>\s]+\.(?:jpg|jpeg|png|webp)/i);
          if (mm) {
            const c = (mm[1] || mm[0]).replace(/\\\//g, '/');
            if (!defaultCover) defaultCover = c;
            pageCovers.push({ kind: 'xinpianchang', url: c });
            break;
          }
        }
      } catch (_) {}
    }
    // 4) 通用 <video poster>（含 data-src 兜底）
    document.querySelectorAll('video').forEach((v) => {
      let p = v.getAttribute('poster') || v.poster;
      if (!p && v.dataset) p = v.dataset.poster || v.dataset.cover || v.dataset.thumbnail;
      if (p) {
        try { p = new URL(p, location.href).href; } catch (_) {}
        pageCovers.push({ kind: 'poster', url: p });
      }
    });
    // 4.5) ★2026-09-11 修复（imini 等多视频页「封面与内容错配」根因）：
    //   视频封面此前来自「页面 <img> 按 DOM 序分发」的猜测式匹配，与视频毫无对应关系
    //   → 卡片拿到的是"同页另一张图"。这里采集【与视频直链一一对应】的真封面：
    //     ① <video poster>（video 元素自身声明的封面，最权威，且天然与 src 成对）
    //     ② 内联 JSON / RSC（__NEXT_DATA__、self.__next_f 等）中与同一条 mp4
    //        【在同一个对象里成对出现】的 cover / poster / thumbnail / image / picUrl
    //        / imgUrl / frameUrl 字段（imini 等 Next.js 站点的真封面就藏在这里）
    //   结果放进 pairs：<视频直链> -> <真封面>，由 scanTab 按优先级消费。
    //   注意：pairs 只做纯字符串解析，不发任何网络请求，也不会改动页面 DOM。
    const COVER_KEY_RE = /^(cover|coverUrl|cover_url|coverImage|cover_image|coverImg|poster|posterUrl|poster_url|thumbnail|thumbnailUrl|thumbnail_url|thumb|thumbUrl|thumb_url|image|imgUrl|img_url|imageUrl|picUrl|pic_url|pic|frameUrl|frame_url|frame|firstFrame|first_frame|snapshot|preview|previewUrl|preview_url|videoCover|video_cover)$/i;
    const COVER_FIELD_RE = /\\?"?(?:cover|coverUrl|cover_url|coverImage|cover_image|coverImg|poster|posterUrl|poster_url|thumbnail|thumbnailUrl|thumbnail_url|thumb|thumbUrl|thumb_url|image|imgUrl|img_url|imageUrl|picUrl|pic_url|pic|frameUrl|frame_url|frame|firstFrame|first_frame|snapshot|preview|previewUrl|preview_url|videoCover|video_cover)\\?"?\s*:\s*\\?"([^"\\]{4,600})/gi;
    const VID_URL_TAIL_RE = /\.(mp4|webm|mov|m4v|mkv|ogv|m3u8|flv|avi|wmv|ts|mpg|mpeg)(?:[?#][^\s"'<>\\]*)?$/i;
    const VID_IN_JSON_RE = /https?:\/\/[^ "'<>\\]+?\.(?:mp4|webm|mov|m4v|mkv|ogv|m3u8|flv|avi|wmv|ts|mpg|mpeg)(?:[?#][^ "'<>\\]*)?/gi;
    const toAbs = (s) => { try { return new URL(String(s), location.href).href; } catch (_) { return ''; } };
    const isImgLike = (s) => {
      const v = String(s || '');
      if (!/^https?:\/\/[^\s"'<>\\]+$/i.test(v)) return false;
      if (VID_URL_TAIL_RE.test(v)) return false;      // 视频直链不是封面
      if (isPromo(v) || isBeacon(v)) return false;    // 推广/信标图一律排除
      return true;
    };
    //   RSC（self.__next_f.push([1,"…"])）会把引号/斜杠转义成 \" 与 \\/ —— 先做一次还原，
    //   否则 URL 正则（依赖 http:// 里的连续两个 /）永远命中不到，与 scanPage:2264 同理。
    const unescapeJsonText = (s) => {
      try {
        return String(s || '')
          .replace(/\\\\/g, '\\')   // \\ -> \（先合并双反斜杠）
          .replace(/\\\//g, '/')    // \/ -> /
          .replace(/\\"/g, '"');    // \" -> "
      } catch (_) { return String(s || ''); }
    };
    // 完整绝对地址判定：必须是 http(s):// 且后面还有内容（"https:" / "https" 这种半截串不算）
    const isFullUrl = (s) => /^https?:\/\/[^\s"'<>\\]/i.test(String(s || ''));
    // ★2026-09-11（QA K-2）：可接受的封面/直链写法 = 完整绝对地址，或常见相对路径
    //   （/img/a.jpg、./a.jpg、../a.jpg、协议相对 //cdn/x.jpg）。相对路径由 toAbs 解析成绝对地址，
    //   真正要拦的只有"只有 scheme 没有 //"的半截串。
    const isUsableUrl = (s) => {
      const v = String(s || '');
      if (!v) return false;
      if (/^\/\//.test(v)) return true;              // 协议相对 //host/path
      if (/^\.{0,2}\/[^/\s]/.test(v)) return true;   // /a.jpg、./a.jpg、../a.jpg
      return isFullUrl(v);
    };
    const addPair = (v, c) => {
      try {
        if (!v || !c) return;
        // ★2026-09-11 修订（QA P2）：必须先要求原始串【已经是】完整 http(s):// 再做 toAbs。
        //   否则 "https:" 这类半截串会被 new URL('https:', location.href) 解析成【源页 URL】
        //   → 反而通过下面的绝对地址校验 → 该卡拿源页 HTML 当封面（白拉整页 + 🎬）。
        if (!isUsableUrl(c)) return;
        if (!isUsableUrl(v)) return;
        let vv = String(v).replace(/\\\//g, '/');
        let cc = String(c).replace(/\\\//g, '/');
        if (!/^https?:\/\//i.test(vv)) vv = toAbs(vv);
        if (!/^https?:\/\//i.test(cc)) cc = toAbs(cc);
        if (!vv || !cc || !isFullUrl(vv) || !isFullUrl(cc)) return;
        if (!VID_URL_TAIL_RE.test(vv)) return;     // 只认真正的视频直链
        // ★兜底防御：解析结果退化成【当前页面地址】（半截串经 toAbs 的典型产物）→ 丢弃
        try {
          const pg = String(location.href || '');
          const originPath = pg.split('?')[0];
          if (cc === pg || cc === originPath || cc === (location.origin + '/')) return;
        } catch (_) {}
        if (isPromo(cc) || isBeacon(cc)) return;   // 推广/信标图一律排除
        if (!pairs[vv]) pairs[vv] = cc;
      } catch (_) {}
    };
    try {
      // ① <video poster>（含 data-poster / data-cover / data-thumbnail）
      document.querySelectorAll('video').forEach((v) => {
        const p = v.getAttribute('poster') || v.poster
          || (v.dataset && (v.dataset.poster || v.dataset.cover || v.dataset.thumbnail)) || '';
        if (!p) return;
        [v.currentSrc, v.src, v.getAttribute('data-src')].forEach((s) => {
          if (s && /^https?:/i.test(s)) addPair(s, p);
        });
      });
    } catch (_) {}
    try {
      // ② 内联数据：能 JSON.parse 就走对象遍历（精确）；RSC / 转义串走「邻近窗口」匹配
      const walkPairs = (o, depth) => {
        if (!o || typeof o !== 'object' || depth > 12) return;
        if (Array.isArray(o)) { for (let i = 0; i < o.length && i < 3000; i++) walkPairs(o[i], depth + 1); return; }
        let vid = '';
        let cov = '';
        for (const k in o) {
          const v = o[k];
          if (!v || typeof v !== 'string') continue;
          if (!vid && /^https?:/i.test(v) && VID_URL_TAIL_RE.test(v)) vid = v;
          if (!cov && COVER_KEY_RE.test(k) && isImgLike(v)) cov = v;
        }
        if (vid && cov) addPair(vid, cov);
        for (const k in o) { try { walkPairs(o[k], depth + 1); } catch (_) {} }
      };
      const scripts = Array.from(document.querySelectorAll('script:not([src])'));
      for (const s of scripts) {
        const rawTxt = s.textContent || '';
        if (!rawTxt || rawTxt.length > 2000000) continue;
        if (!/\.(mp4|webm|mov|m4v|mkv|ogv|m3u8|flv|avi|wmv|ts|mpg|mpeg)/i.test(rawTxt)) continue;
        let parsed = null;
        try { parsed = JSON.parse(rawTxt); } catch (_) { parsed = null; }
        if (parsed && typeof parsed === 'object') { try { walkPairs(parsed, 0); } catch (_) {} continue; }
        // RSC / 转义串：先还原 \" 与 \\/ 再按「视频 URL 邻近窗口」取最近 cover 字段
        const txt = unescapeJsonText(rawTxt);
        try { parsed = JSON.parse(txt); } catch (_) { parsed = null; }
        if (parsed && typeof parsed === 'object') { try { walkPairs(parsed, 0); } catch (_) {} continue; }
        VID_IN_JSON_RE.lastIndex = 0;
        let m = null;
        let guard = 0;
        while ((m = VID_IN_JSON_RE.exec(txt)) && guard++ < 400) {
          const win = txt.slice(Math.max(0, m.index - 800), Math.min(txt.length, m.index + m[0].length + 800));
          COVER_FIELD_RE.lastIndex = 0;
          const cm = COVER_FIELD_RE.exec(win);
          if (cm) addPair(m[0], cm[1]);
        }
      }
    } catch (_) {}
    // 5) og:image / twitter:image 作为通用默认封面（Pexels/Coverr 等专业视频源常用）
    if (!defaultCover) {
      try {
        const og = document.querySelector('meta[property="og:image"], meta[name="twitter:image"]');
        if (og) {
          const c = og.getAttribute('content');
          if (c) { defaultCover = new URL(c, location.href).href; }
        }
      } catch (_) {}
    }
    // ★2026-08-18 新增：抖音/视频聚合下载站（无 RENDER_DATA / modal_id 也无 og:image）页面兜底。
    // 思路：扫页内所有 <img>，取可见区域中**尺寸最大**且非占位图标（如 emoji/avatar/loading）的真实缩略图，
    // 作为页面级 defaultCover。同封面（按 url 去重）也进 pageCovers，扫描结果中无 cover 的视频将依次消费。
    if (!defaultCover || pageCovers.length === 0) {
      try {
        const imgs = Array.from(document.querySelectorAll('img'));
        const sizeKey = (el) => {
          const r = el.getBoundingClientRect();
          const w = el.naturalWidth || r.width || 0;
          const h = el.naturalHeight || r.height || 0;
          return w * h;
        };
        // ★2026-08-22 P1-1 修复 v3（真机日志 + 截图实证根因）：
        //   用户 jingxuan 截图实证：9 张卡中只有 1 张是真正视频缩略图（紫色，tos-cn-i 类图），
        //   其余 8 张都是"电子营业执照"（license-business / verify-）。
        //   真实抖音视频缩略图 URL 模式：
        //     - tos-cn-i-xxxx / tos-cn-pc-xxxx（CDN 标识，含 i/pc 段）
        //     - aweme-subCover / aweme-image / aweme-cover / img-video / image-view / img-web
        //     - obj/eden-cn/obj/aweme-image 这些抖音 img 域常见 path
        //   黑名单（推广/认证/横幅/头像/二维码）：
        //     - verify- / license-business / qrcode / qr- / banner / ad- / promo / advert / sponsor
        //     - avatar / emoji / logo / loading / sprite / placeholder / thumb{尺寸} / icon
        //   排序：白名单命中 > 面积大
        // ★2026-08-31：isPromo / isVideoThumb 已提升到函数作用域（见文件头），此处直接复用，避免 const 重声明。
        const candidates = [];
        const seen = new Set();
        for (const img of imgs) {
          const src = img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-original') || '';
          if (!src || /^data:/i.test(src) || /^blob:/i.test(src)) continue;
          const area = sizeKey(img);
          if (area > 0 && area < 80 * 80) continue;
          let abs;
          try { abs = new URL(src, location.href).href; } catch (_) { continue; }
          if (isPromo(abs)) continue; // ★排除推广/认证/电子营业执照
          if (isBeacon(abs)) continue; // ★排除监控/埋点信标（mssdk 等，0 尺寸且必然 404）
          if (seen.has(abs)) continue;
          seen.add(abs);
          // ★2026-09-10 isContent：区分「用户内容图」与「网站静态资源图」（本地模拟验证，见
          //   tmp/sim-imini-cover.mjs）。imini 实测：真封面在 file.iminicdn.com/file/…，
          //   而 logo / 定价广告 / 模型图标 / 首页营销图都在 /static/ /public/ /assets/ /resources/ 下。
          //   借此把装饰图排到候补位，避免它们挤占前排导致卡片拿到非封面图。
          //   idx = DOM 顺序，供下游「按序分发」与卡片顺序对齐。
          const isContent = !/\/(static|public|assets|resources)\//i.test(abs);
          candidates.push({ url: abs, area, w: img.naturalWidth || 0, h: img.naturalHeight || 0, isThumb: isVideoThumb(abs), idx: candidates.length, isContent });
        }
        // ★2026-09-03 修复（"电子营业执照/认证图"被当封面的真凶）：
        //   抖音/视频号页面里"<img>"兜底扫描会把"电子营业执照"等无 verify/license 关键字的认证图
        //   当成候选（其域名/路径就是普通的 p3-sign.douyinpic.com，与真实视频缩略图无法靠黑名单区分）。
        //   解决：抖音/视频号/TikTok 页强制只接受【白名单命中】的候选（已知视频缩略图域名/路径段），
        //   否则直接清空 pageCovers、不设 defaultCover → 卡片显示空封面好过显示"电子营业执照"误导用户。
        const isDouyinLike = /(?:^|\.)(douyin\.com|ixigua\.com|tiktok\.com|tiktokv\.com|weixin\.qq\.com|channels\.weixin\.qq\.com)$/i.test(location.hostname || '');
        if (isDouyinLike) {
          for (let ci = candidates.length - 1; ci >= 0; ci--) {
            if (!candidates[ci].isThumb) candidates.splice(ci, 1);
          }
        }
        // ★2026-09-10 修复（imini 等多视频页「封面错位 + 部分卡无封面」）：
        //   本地模拟（tmp/sim-imini-cover.mjs，用真实 DOM 数据）对比结果：
        //     原「面积排序 + slice(0,6)」              → 9 张卡仅 5 张拿到真封面，3 张无封面
        //     「内容图优先 + DOM 顺序 + 上限 30」       → 9 张卡 9 张全部拿到正确封面
        //   ① 原按【面积】排序打乱了 DOM 顺序，而下游是「按序分发」（卡片顺序）
        //      → 面积顺序 ≠ 卡片顺序 → 封面与卡对不上；
        //   ② slice(0, 6) 硬上限 → imini 9+ 张视频卡必然有卡分不到封面 → 占位圆；
        //   ③ 装饰图（logo/定价广告/模型图标/首页营销）挤占前排 → 卡片拿到非封面图。
        //   修复：先「用户内容图」按 DOM 顺序，再「静态资源图」按 DOM 顺序兜底，上限放宽到 30。
        const contentImgs = candidates.filter((c) => c.isContent).sort((a, b) => a.idx - b.idx);
        const staticImgs = candidates.filter((c) => !c.isContent).sort((a, b) => a.idx - b.idx);
        const seen2 = new Set();
        for (const c of [...contentImgs, ...staticImgs].slice(0, 30)) {
          pageCovers.push({ kind: 'page-img', url: c.url });
          seen2.add(c.url);
        }
        // ★白名单命中（视频缩略图）优先于面积 —— 仅用于挑 defaultCover，不影响上面的按序分发
        candidates.sort((a, b) => (b.isThumb - a.isThumb) || (b.area - a.area));
        if (!defaultCover && candidates.length) defaultCover = candidates[0].url;
      } catch (_) {}
    }
  } catch (_) {}
  // ★2026-09-11 修复（liblib 视频卡封面缺失根因）：
  //   inject-main 在 MAIN 世界捕获 apiVideos 时，已把响应体中「视频直链 → 邻近封面图」
  //   的配对写入 window.__hmdao_captures.apiVideoPairs。extractVideoCovers 同样运行在 MAIN 世界，
  //   读取该 pairs 并合并到返回结果，供 scanTab 精确回填每张视频卡封面。
  try {
    const apiPairs = (window.__hmdao_captures && window.__hmdao_captures.apiVideoPairs) || {};
    for (const k in apiPairs) {
      const v = apiPairs[k];
      if (v && !pairs[k]) pairs[k] = v;
    }
    // ★2026-09-11 补充（多平台视频卡封面"对应"兜底）：
    //   apiVideos 来自 XHR 响应体（如 liblib），其结构化 cover 字段可能缺失/热链 404。
    //   此时用【页面已渲染的 <img> 缩略图】按"共享长路径段"配对——页面缩略图必与视频同源、
    //   必能加载、必与该卡内容对应（即用户说的"平台自带的"封面）。
    //   例：视频 …/88dc2eab…/master.mp4 与缩略图 …/88dc2eab…/720p/index.jpg 共享 item-id 段 88dc2eab…。
    //   取【最长】共享段（≥12 字符）以避开通用路径词（/upload-images/ 等），确保配对到具体 item 缩略图。
    const apiVideos = (window.__hmdao_captures && Array.isArray(window.__hmdao_captures.apiVideos)) ? window.__hmdao_captures.apiVideos : [];
    if (apiVideos.length && pageCovers.length) {
      const coverSeg = new Map(); // 长段 → 缩略图 URL（同段取首个）
      const segOf = (u) => String(u || '').match(/[A-Za-z0-9_\-]{12,}/g) || [];
      for (const c of pageCovers) {
        const u = (c && (c.url || c)) || '';
        if (!/^https?:/i.test(u)) continue;
        for (const s of segOf(u)) {
          if (!coverSeg.has(s)) coverSeg.set(s, u);
        }
      }
      for (const v of apiVideos) {
        if (!v || pairs[v]) continue; // 已有结构化封面则跳过
        let best = '', bestLen = 0;
        for (const s of segOf(v)) {
          const cu = coverSeg.get(s);
          if (cu && s.length > bestLen) { best = cu; bestLen = s.length; }
        }
        if (best && /^https?:/i.test(best)) pairs[v] = best;
      }
    }
  } catch (_) {}
  return { byKey, defaultCover, pageCovers, pairs };
}

if (typeof globalThis !== 'undefined') {
  globalThis.scanTab = scanTab;
  globalThis.scanPage = scanPage;
}
