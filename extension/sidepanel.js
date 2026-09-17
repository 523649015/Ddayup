// Ddayup 素材采集 · 侧栏逻辑（原生 JS）
// ┌──────────────────────────────────────────────────────────────┐
// │ 双击 → 预览原图/视频/音频 · 右键 → 保存/找相似               │
// │ 顶部筛选 → 排除小图标/低分辨率                                │
// │ 类型分模块 · 每类型独立保存路径（中文）· 一键打开官方源        │
// └──────────────────────────────────────────────────────────────┘

// 版本标记：侧栏打开时打印，用于确认扩展是否加载了最新代码
// ★2026-09-10：build 号是硬编码常量，改代码时若不更新，侧栏会一直显示旧号，
//   导致"代码到底有没有生效"无法判断（排查 m3u8 下载时反复踩这个坑）。
//   更新为本次修复标识，便于一眼确认跑的是最新代码。
const HMDAO_SIDEPANEL_BUILD = '2026-09-11-card-responsive-fix';
console.log('%c[Ddayup] 侧栏已加载 build ' + HMDAO_SIDEPANEL_BUILD, 'color:#00d4aa;font-weight:bold;font-size:13px');

// 云端 API 基地址：默认本机 3000，可由 chrome.storage 的 'ddayupApiBase' 覆盖（上云时配置）。
// 统一走 window.DdayupConfig（config-runtime.js），避免多文件内联读取导致的配置漂移。
async function getCloudApiBase() {
  try {
    if (typeof window !== 'undefined' && window.DdayupConfig) {
      return await window.DdayupConfig.getApiBase();
    }
  } catch (_) {}
  return 'http://127.0.0.1:3000';
}

// 同步版：用于无法 await 的场景（如 chrome.tabs.create / query 的 URL 构造）。
// 优先用 DdayupConfig 已填充的缓存，否则回退默认；首次异步填充后缓存生效。
function apiBaseUrl() {
  try {
    if (typeof window !== 'undefined' && window.DdayupConfig && window.DdayupConfig.getApiBaseSync) {
      const s = window.DdayupConfig.getApiBaseSync();
      if (s) return s;
    }
  } catch (_) {}
  return 'http://127.0.0.1:3000';
}

// ★包裹 chrome.runtime.sendMessage：MV3 后台 Service Worker 可能在异步处理期间被终止，
// 导致 Promise 被拒绝并打印 "message port closed before a response was received"。
// 此处统一吞掉该拒绝（回调式调用保持原样，由各自回调处理 lastError）。
// 用 try/catch 兜底：极少数环境该属性不可写，跳过包裹即可，不影响功能。
try {
  const _orig = chrome.runtime.sendMessage.bind(chrome.runtime);
  chrome.runtime.sendMessage = function (...args) {
    const last = args[args.length - 1];
    if (typeof last === 'function') return _orig(...args); // 回调式：原样透传
    const p = _orig(...args);
    if (p && typeof p.then === 'function') return p.catch(() => undefined);
    return p;
  };
} catch (_) { /* 包裹失败则保持原样 */ }

// 任务 J：向目标标签的 content script 发消息，并对「content script 未注入」场景给出真实反馈，
// 而非静默吞掉导致用户看到假成功提示（如 Ddayup 标签页尚未加载完/非 Ddayup 页）。
function sendToTabSafe(tabId, message, onOk) {
  chrome.tabs.sendMessage(tabId, message, (response) => {
    if (chrome.runtime.lastError) {
      // "Receiving end does not exist" 表示目标页未注入 content script（如刚打开/非 Ddayup 页）
      warnStatus('无法发送到 Ddayup');
      return;
    }
    if (onOk) onOk(response);
  });
}

// ★ 必须用 var（而非 let/const）：let/const 的顶层声明只在该 <script> 的词法环境内可见，
// 抽离到 bulk-actions.js 的 getChosen/download 等函数读不到 → 表现为「列表有素材但点下载显示无素材」。
// var 声明进入全局对象（window.assets / window.selected），跨多个 <script> 文件共享。
var assets = [];
var selected = new Set();
var currentFilter = 'all'; // var：跨 <script> 共享（card-render.js 读取筛选）
let statusTimer = null;
const imgDimensions = {}; // url → { w, h }（图片加载后采集的真实尺寸）
// ★ saveHandles 用 var 共享全局（const 不会跨 <script> 共享，导致 bulk-actions.js 读不到、保存目录失效）
var saveHandles = { image: null, video: null, audio: null, model: null, archive: null, netdisk: null };
// ★2026-09-12 移除「相对子目录兜底」(relDirs)：该机制只能落到浏览器默认下载目录下，
//   用户输入绝对路径时会被剥离盘符、落到默认目录并重复建文件夹（误导性鸡肋）。
//   现统一为「选择目录」→ saveHandles[type]（File System Access API）写任意绝对目录。
// ★2026-08-22 信息流批量采集：勾选态集合（存 awemeId 或 url，独立命名空间，不污染 window.selected）
var batchSelection = new Set();
var batchCollectEnabled = false; // 开关态（localStorage 持久化）
// ★2026-08-23 修复（问题4 根因）：批量采集资产独立容器。
//   普通扫描资产（window.assets）随页面增量合并/换页重置；批量采集资产单独存放，
//   重扫/切 tab 不清空（除非用户关闭批量开关或真正换页），彻底解决「已扫描素材无故消失」。
//   图片/音频/文档/模型一律不进批量（见 setBatchModeOnSource），批量只收视频流。
var batchAssets = [];
// ★2026-08-23 修复（问题3 根因）：记录当前展示页 URL，用于「增量合并 vs 换页重置」判定。
var currentSourceUrl = '';
// ★2026-09-05 新增：记录当前抖音合集 ID。切换不同合集时批量资产必须清空，否则旧合集卡片残留。
var currentMixId = '';
// ★2026-09-04 修复（合集页"一会多一会少"真凶）：旧逻辑用【整条 URL】判断"是否切站"，
//   抖音合集页内 SPA 切集会让 modal_id 变化 → 整 URL 变 → 误判为"切到新站" → 清空全部普通卡再重建 → 数量反复掉又涨。
// ★2026-09-04 v2：用户反馈"同一平台切换其他短视频合集也需要清理"。
//   所以不能只比 host，要比【合集/页面身份】：去掉 modal_id/aweme_id 等会随切集变化的参数，
//   保留 path 与稳定查询参数。这样：同合集内切集 → 身份不变 → 不清卡；
//   换到另一个合集（path 或稳定参数不同）→ 身份变 → 清卡；换站 → host 变 → 清卡。
// ★2026-09-07 建议1：hash 路由站点(如 example.com/#/page2 切 content) 默认不算换页(避免误清同页 SPA)；
//   仅当用户在侧栏勾选「hash 路由也清卡」(localStorage.hashClearOnRoute==='1') 时，把 hash 纳入身份，
//   纯 hash 路由站切换内容才会清卡。
function hmdaoHashClearEnabled() {
  try { return localStorage.getItem('hashClearOnRoute') === '1'; } catch (_) { return false; }
}
// 统一「页面身份」判定：host + path + (稳定查询参数，includeQuery) + (hash，开关开启时)。
//   includeQuery=false → 仅 host+pathname（auto 轻量同步用，区分真正换页与同文档 SPA 切集）；
//   includeQuery=true  → host+path+稳定查询（SCAN_RESULT 合并兜底用，更精确，避免 ?id= 同 path 误判同页）。
function hmdaoDocKey(u, includeQuery) {
  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase();
    const path = url.pathname;
    let key = host + path;
    if (includeQuery) {
      const volatile = new Set([
        'modal_id','aweme_id','from','source','range','t','ts','_t','timestamp','referer','scene',
        'enter_from','is_from_webapp','web_id','msToken','a_bogus','x_bogus','cursor','offset','p',
        'start','index','spm','share_source','seid','_sm','_ss','_fs','tt_from','gd_label','u_code','dj_token'
      ]);
      const params = Array.from(url.searchParams.entries())
        .filter(([k]) => !volatile.has(k) && !k.startsWith('utm_'))
        .sort(([a],[b]) => (a < b ? -1 : 1));
      const search = params.length ? ('?' + params.map(([k,v]) => k + '=' + encodeURIComponent(v)).join('&')) : '';
      key += search;
    }
    if (hmdaoHashClearEnabled() && url.hash) key += url.hash;
    return key;
  } catch (_) { return (u || '').split('#')[0]; }
}
// 兼容别名：合并兜底用(含稳定查询)，auto 轻量同步用(仅 pathname)。
function hmdaoSourceIdentityKey(u) { return hmdaoDocKey(u, true); }
function pageDocKey(u) { return hmdaoDocKey(u, false); }
try { window.__hmdaoDocKey = hmdaoDocKey; } catch (_) {}
// 向当前源页注入/清除 window.__hmdao_batchMode（驱动 tryDouyinWeixin 走多视频分支）
async function setBatchModeOnSource(enable) {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || !tab.id) return;
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: (on) => { window.__hmdao_batchMode = on; },
      args: [enable],
    });
  } catch (_) { /* 源页未就绪时静默，不影响开关态 */ }
}
// 读取开关持久化态
try { batchCollectEnabled = localStorage.getItem('batchCollectEnabled') === '1'; } catch (_) {}

function sourceOrigin() {
  try { return window.__sourcePageUrl ? new URL(window.__sourcePageUrl).origin : ''; } catch (_) { return ''; }
}

// 健壮推导 Referer（爱给等 CDN 强制校验 Referer，缺失即 403 → 三步播放全挂）。
// 优先级：
//   1) 源页 URL 的 origin（最准确）
//   2) 按音频 CDN 域名推断站点主页（如 s5.aigei.com → https://www.aigei.com/）
//   3) 通用兜底：www.<主域名>/
function pageReferer(a) {
  if (window.__sourcePageUrl) {
    try { return new URL(window.__sourcePageUrl).origin + '/'; } catch (_) {}
  }
  if (a && a.url) {
    try {
      const h = new URL(a.url).hostname;
      if (h.endsWith('aigei.com')) return 'https://www.aigei.com/';
      const parts = h.split('.');
      if (parts.length >= 2) {
        const root = parts.slice(-2).join('.');
        return (h.startsWith('www.') ? 'https://' + h : 'https://www.' + root) + '/';
      }
    } catch (_) {}
  }
  return '';
}

// 筛选状态
let minWidth = 0, minHeight = 0, excludeIcons = false;

// ★2026-08-18：屏蔽带水印来源（平台夹杂水印的图床/站，通用嗅探无法识别像素水印，
// 故按「域名」屏蔽已知带平台水印的来源；默认开，用户可关闭或自定义增删）。
// 说明：B站/Douyin/YouTube 采集的是平台原始流（已在 card-render 标「无水印源」），
// 不在屏蔽名单；本名单针对「图床 CDN 默认吐带水印图」的平台（小红书/微博/公众号/快手等）。
const WATERMARK_HOSTS_DEFAULT = [
  'xhscdn.com', 'sns-img', 'xiaohongshu.com',          // 小红书：图床默认吐带水印图
  'sinaimg.cn', 'weibo',                               // 微博：图床默认带水印
  'mmbiz.qpic.cn', 'qpic.cn', 'qlogo.cn',              // 微信公众号：图片带水印
  'kuaishou.com', 'kscdn.com', 'chenzhongtech.com',    // 快手：图床带水印
  'pstatp.com', 'toutiao',                             // 今日头条图床（部分带水印）
  // ★2026-08-23 整改：移除 douyinpic.com / byteimg.com / is.snssdk.com。
  // 抖音官方封面 CDN 是「内容封面」而非「默认吐水印图床」，且 scan.js 已为抖音域注入 Referer 防盗链，
  // 侧栏卡片封面正来自 p3-pc-sign.douyinpic.com（tos-cn-p-0015c000 640x360），若被屏蔽会导致
  // 「卡片缩略图出现 3-4 秒后消失、与当前页播放内容不匹配」。抖音封面必须保留。
];
let blockWatermark = true;                 // 总开关
let blockedHosts = new Set(WATERMARK_HOSTS_DEFAULT); // 当前生效屏蔽域名集
const WM_HOSTS_KEY = 'hmdao_blocked_hosts';
try {
  const saved = JSON.parse(localStorage.getItem(WM_HOSTS_KEY) || 'null');
  if (Array.isArray(saved)) { blockedHosts = new Set(saved); }
} catch (_) {}
function hostOf(u) {
  try { return new URL(u, location.href).hostname.toLowerCase(); } catch (_) { return ''; }
}
function isBlockedHost(u) {
  if (!blockWatermark) return false;
  const h = hostOf(u);
  if (!h) return false;
  for (const b of blockedHosts) { if (h === b || h.endsWith('.' + b) || h.includes(b)) return true; }
  return false;
}
function saveBlockedHosts() {
  try { localStorage.setItem(WM_HOSTS_KEY, JSON.stringify([...blockedHosts])); } catch (_) {}
}
// 当前右键菜单 / 预览窗口所指的资产（基于 global index）
let ctxAssetIdx = -1;

function getAsset(idx) {
  // ★2026-09-06 修复（双击音频卡却打开图片预览的真凶）：
  //   卡片渲染全程用 window.assets（见 SCAN_RESULT 合并段），而这里读的是模块变量 assets ——
  //   两者不是同一份数组，assets 里是旧数据 → 按索引取到的是另一张卡（图片卡）→ "双击音频显示图片"。
  //   改为优先读渲染用的同一份真源 window.assets，保证「点哪张开哪张」。
  try {
    if (typeof window !== 'undefined' && Array.isArray(window.assets)) return window.assets[idx] || null;
  } catch (_) {}
  return assets[idx] || null;
}

// ===== 工具函数 =====
function fileName(url) {
  try { const u = new URL(url); const seg = decodeURIComponent(u.pathname.split('/').pop() || ''); return seg.split('?')[0] || 'asset'; } catch (_) { return 'asset'; }
}
// ★2026-08-18 升级：原版只去非法字符。新片场/aigc 等 SPA 经常把 document.title 写成
//   "《作品标题》 - 新片场AI" 之类，但 React 渲染后又动态改成只剩"七"（错误状态），
//   此外还有"作品 | 作者 - 平台""作品_频道"等无规则格式。这里做三件事：
//   1) 优先提取 《...》 / 「...」 / 【...】 包裹的核心标题；
//   2) 干掉全角空格、em-dash、em-dash、&nbsp; 等装饰符号；
//   3) 截断到 80 字符（防止某些长尾 url/SEO title 把文件名撑爆）。
function sanitizeName(name) {
  let s = String(name || '');
  if (!s) return 'asset';
  // 1) 优先提取《》「」【】包裹内容（如"《七》- 新片场AI" → "七"）
  const m = s.match(/[《「【]([^《」】]{1,200})[》」】]/);
  if (m && m[1]) s = m[1];
  // 2) 去掉全角空格、不间断空格、em/en dash、各种破折号
  s = s.replace(/[\u00A0\u2003\u2002\u2001\u3000]/g, ' ').replace(/[—–−ー─]/g, '-');
  // 3) 替换文件系统非法字符
  s = s.replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_').trim();
  // 4) 截断 80 字符（按 Unicode 长度，避免 surrogate pair 截一半）
  if (Array.from(s).length > 80) s = Array.from(s).slice(0, 80).join('');
  return s.replace(/[. _-]+$/, '') || 'asset';
}
// extForType 定义见 assetTypes.js（全局单一事实来源）
// 根据素材来源域生成简短平台标签（用于文件名，便于用户识别来源 / 判断水印来源）
function platformTag(a) {
  const src = (a && (a.source || a.sourceDomain || a.host || '')) + ' ' + (a && a.url ? (() => { try { return new URL(a.url).hostname; } catch (_) { return ''; } })() : '');
  if (/bilibili\.com|b23\.tv/i.test(src)) return 'B站';
  if (/douyin\.com|bytedance|douyinvod/i.test(src)) return '抖音';
  if (/youtube\.com|googlevideo/i.test(src)) return 'YouTube';
  if (/weixin|qq\.com|channels/i.test(src)) return '视频号';
  if (/xinpianchang|newice/i.test(src)) return '新片场';
  if (/pexels|coverr|mixkit|videvo/i.test(src)) return '素材站';
  return '';
}
// ★2026-09-05：从资产标题里解析「第N集」（阿拉伯数字）。标题是抖音 desc 原文，
//   与卡片显示的标题同源——用它反推集数可自愈历史数据里被游标偏移算错的 episodeNo。
function titleEpisodeNo(a) {
  try {
    const m = String((a && a.title) || '').match(/第\s*([0-9]{1,4})\s*集/);
    if (m) return parseInt(m[1], 10);
  } catch (_) {}
  return 0;
}
function deriveFilename(a) {
  // 优先用真实标题生成文件名，避免 stream-xxx.mp4 等无意义名称
  const rawName = (a && a.title && !/^stream-/i.test(a.title)) ? a.title : fileName(a.url);
  let base = sanitizeName(rawName);
  // ★2026-09-03：抖音合集多集数——文件名带「第 N 集」且匹配当前播放源。
  //   优先用扫描/预览阶段算好的 episodeNo（按合集播放顺序），没有再回退 awemeId 保证各集不重名。
  // ★2026-09-05：标题里已带「第N集」时以标题为准（自愈历史错误的 episodeNo，如游标偏移算出的 211/15）
  const epNo = titleEpisodeNo(a) || ((a && a.episodeNo) ? parseInt(a.episodeNo, 10) : 0);
  const epTag = epNo > 0 ? ('第' + epNo + '集') : '';
  if (epTag) {
    if (!base.includes(epTag)) base = epTag + '_' + base;
  } else {
    const idTag = (a && a.awemeId) ? String(a.awemeId).replace(/[^\w]/g, '') : '';
    if (idTag && !new RegExp(idTag).test(base)) base = base + '_' + idTag;
  }
  const dot = base.lastIndexOf('.');
  const hasExt = dot > 0 && /^\.[a-z0-9]{1,6}$/i.test(base.slice(dot));
  // ★2026-09-12 修复（用户实测：抖音音频轨下载成「抖音音频轨（aweme ...）_抖音.mp4」，
  //   困惑"mp4 文件怎么归纳到音频里"）：
  //   抖音 DASH 音频轨实际是 MP4 容器（mime_type=audio_mp4 / 后缀 .m4s），URL 里没有音频后缀
  //   → ① 无后缀时被 extForType 兜成 .mp3（内容是 m4a，名不符实）；② 若该资产被当成 video，
  //   后缀会变成 .mp4。这里对【明确是音频轨】的资产统一给 .m4a（MP4 音频容器的标准后缀）：
  //   仅当 URL 命中 douyin/TikTok 的 audio_mp4/.m4s/douyinvod 或标题含「音频轨」时才生效，
  //   普通 mp3 音频（如爱给 mp3）仍走 extForType → .mp3，不受影响。
  const __audioTrack = !!(a && a.type === 'audio') && (
    /audio[_-]?mp4|mime_type=audio|\.m4[as](\?|$)|douyinvod|bytedance/i.test(String((a && a.url) || '')) ||
    /音频轨/i.test(String((a && a.title) || ''))
  );
  let core;
  if (hasExt) {
    core = (__audioTrack && /^\.(mp4|m4s)$/i.test(base.slice(dot)))
      ? (base.slice(0, dot) + '.m4a')
      : base;
  } else {
    core = base + '.' + (__audioTrack ? 'm4a' : extForType(a.type));
  }
  const tag = platformTag(a);
  if (!tag) return core;
  const d = core.lastIndexOf('.');
  // 把平台标签拼到文件名主体（保留扩展名），如 house.mp4 → house_抖音.mp4
  return (d > 0 ? core.slice(0, d) + '_' + tag + core.slice(d) : core + '_' + tag);
}
// typeLabel 定义见 assetTypes.js（全局单一事实来源）
// 列表/预览显示名：MSE 空 URL 的音频用「音频#索引」兜底，避免显示空白
function displayName(a) {
  if (a && a.type === 'netdisk') {
    try { return new URL(a.url).host; } catch (_) { return a.url || '网盘分享'; }
  }
  // ★2026-09-03：抖音合集卡片显示「第 N 集 · 标题」。
  //   此前 episodeNo（绝对集数，scan.js 按合集列表顺序写入）存进了资产却【从不渲染】→ 用户看不到第几集。
  // ★2026-09-05 修复（"视频 · 第15集 · 《枯魂道君》第40集…"双集数字样）：
  //   ① 标题里已含「第N集」→ 以标题数字为准（自愈旧数据里游标偏移算出的错误集数），
  //      且【不再重复加前缀】——标题自己已经把集数说清楚了；
  //   ② 标题没带集数 → 才用 episodeNo 加「第N集 · 」前缀。
  const __tEp = titleEpisodeNo(a);
  if (__tEp > 0) {
    // 标题自带集数：直接用标题（内部已含「第N集」），不再拼前缀
    if (a && a.title && !/^stream-/i.test(a.title)) return a.title;
  }
  const ep = (!__tEp && a && a.episodeNo && a.platform === 'douyin') ? ('第' + a.episodeNo + '集 · ') : '';
  // 2026-08-02：优先用标题（页面/视频真实标题），避免抖音 stream-xxx.mp4 或 CDN 裸链文件名无意义。
  if (a && a.title && !/^stream-/i.test(a.title)) return ep + a.title;
  // ★2026-08-22 P1-2 修复（真机日志实证根因：用户截图「卡片名字显示 lf3-static.bytednsdoc.com/obj/eden-cn/...」）：
  //   抖音 CDN 直链 URL 几乎不含可读文件名（仅 hash 路径），用 fileName(a.url) 会返回 CDN 路径
  //   全串，严重影响辨识。判定规则：扩展名缺失 或 形如「obj/eden-cn/xxxhash」等无意义路径 → 跳过
  const n = (a && a.url && fileName(a.url)) || '';
  if (n && !/^stream-/i.test(n) && /\.(mp4|mp3|m4a|wav|aac|flac|jpg|jpeg|png|gif|webp|avif|heic|webm|mkv|mov|ts|m3u8)(\?|$)/i.test(n)) return n;
  // ★2026-09-16 修复：无扩展名 CDN 图片（花瓣/B站 hash 文件名等）不能退化成"图片素材"，
  //   至少显示 URL 末段文件名，让图片卡彼此可区分且对应真实源图。
  if (a && a.type === 'image' && a.url) {
    try {
      const seg = decodeURIComponent(new URL(a.url).pathname.split('/').pop() || '');
      if (seg && seg.length > 1) return seg.replace(/[?#].*$/, '');
    } catch (_) {}
  }
  // ★CDN 裸链 / 无可读文件名 → 显示「视频素材 / 音频素材」，不再显示整条 CDN 路径
  return ep + ((a && a.type ? typeLabel(a.type) : '素材') + (a && a.audioIdx != null ? ('#' + a.audioIdx) : ''));
}
// 把任意错误对象安全地转成可读字符串（避免 [object Object]）
function errStr(e) {
  if (!e) return '未知错误';
  if (typeof e === 'string') return e;
  if (e.message) return (e.name ? e.name + ': ' : '') + e.message;
  if (e.name) return e.name;
  try { return JSON.stringify(e); } catch (_) { return String(e); }
}
// 把对象安全地压成【单行字符串】，专供 console.error/warn 的第二个参数——
// 否则日志框架把对象 String() 成 "[object Object]"，真实错误被吞掉。
function dbg(o) {
  if (o == null) return 'null';
  if (typeof o === 'string') return o;
  try { return JSON.stringify(o); } catch (_) { return String(o); }
}

// ===== 拖拽到桌面/文件夹/其他窗口：缓存真实字节为可拖拽文件 =====
// 直接抓取(无鉴权)的直链用 Chrome 专有 DownloadURL 即可；
// 受签名/Cookie 保护的 YouTube/抖音/音频则需把后台拉到的真实字节缓存成 File 才能写出。
const dragFileCache = new Map(); // url -> { file, blobUrl, mime, name }
function guessMime(a) {
  const ext = (deriveFilename(a).split('.').pop() || '').toLowerCase();
  const map = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4', mkv: 'video/x-matroska',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/ogg', weba: 'audio/webm',
    glb: 'model/gltf-binary', gltf: 'model/gltf+json', obj: 'text/plain', fbx: 'application/octet-stream', blend: 'application/octet-stream',
    zip: 'application/zip', rar: 'application/x-rar-compressed', '7z': 'application/x-7z-compressed', tar: 'application/x-tar', gz: 'application/gzip'
  };
  return map[ext] || (a.type === 'image' ? 'image/png' : a.type === 'video' ? 'video/mp4' : a.type === 'audio' ? 'audio/mpeg' : 'application/octet-stream');
}
// 预取字节并缓存为可拖拽文件（仅对较小资产；视频由预览/fallbackCdnFetch 缓存，避免长视频 OOM）
// 微信/PS 等应用拖入图片只认 dataTransfer.files 里的真实 File，必须提前把字节缓存好，
// 否则 dragstart 时 files 为空 → 读不到图片。
let dragPrefetchBusy = 0;
const DRAG_PREFETCH_MAX = 10; // 批量预热并发上限，避免一次性过多请求压垮后台
async function ensureDragData(a, force) {
  if (!a || !a.url || dragFileCache.has(a.url)) return;
  if (a.type === 'video') return; // 视频靠预览/下载已拿到的字节缓存，不在此预取
  if (!force && dragPrefetchBusy >= DRAG_PREFETCH_MAX) return; // 批量预热受并发限制，留给 pointerdown 强制补取
  dragPrefetchBusy++;
  try {
    const referer = deriveMediaReferer(a.url, window.__sourcePageUrl || '');
    const res = await fetchMediaViaBackground(a.url, referer);
    if (res && res.ok && res.b64) {
      const bytes = b64ToBytes(res.b64);
      const mime = res.mime || guessMime(a);
      const name = deriveFilename(a);
      const file = new File([bytes], name, { type: mime });
      const blobUrl = URL.createObjectURL(file);
      dragFileCache.set(a.url, { file, blobUrl, mime, name });
    }
  } catch (_) {} finally {
    if (dragPrefetchBusy > 0) dragPrefetchBusy--;
  }
}
// 复用已构造的 blob（预览/下载已拿到真实字节时），缓存为可拖拽文件（含受保护视频）
function cacheDragBlob(a, blob, mime) {
  if (!a || !a.url || !blob) return;
  const name = deriveFilename(a);
  const m = mime || guessMime(a);
  let file = null;
  try { file = new File([blob], name, { type: m }); } catch (_) {}
  const blobUrl = URL.createObjectURL(blob);
  const prev = dragFileCache.get(a.url);
  if (prev && prev.blobUrl && prev.blobUrl.startsWith('blob:')) { try { URL.revokeObjectURL(prev.blobUrl); } catch (_) {} }
  dragFileCache.set(a.url, { file, blobUrl, mime: m, name });
}
// 卡片拖拽开始：优先写出真实文件，否则用 DownloadURL 抓直链，并附带 URL 文本兜底
function onCardDragStart(e, a) {
  const cached = dragFileCache.get(a.url);
  const name = (cached && cached.name) || deriveFilename(a);
  const mime = (cached && cached.mime) || guessMime(a);
  const useUrl = (cached && cached.blobUrl) || a.url; // 直链用远程；受保护媒体用 blob
  try {
    if (cached && cached.file && cached.file.size) e.dataTransfer.items.add(cached.file);
  } catch (_) {}
  try { e.dataTransfer.setData('DownloadURL', mime + ':' + name + ':' + useUrl); } catch (_) {}
  try { e.dataTransfer.setData('text/uri-list', a.url); } catch (_) {}
  try { e.dataTransfer.setData('text/plain', a.url); } catch (_) {}
  e.dataTransfer.effectAllowed = 'copy';
  setStatus('拖动到桌面/文件夹即可复制文件：' + name);
}
// 复制图片到系统剪贴板（绕开扩展侧栏拖放不被导出为 OS 文件拖放的限制）
// 微信/PS 的 drop 区只认 OS 级文件拖放，扩展侧栏的 dataTransfer.File 不会被导出 → 直接拖会显示禁止。
// 改用系统剪贴板：写成功后用户在微信/PS 里 Ctrl+V 即可粘贴（剪贴板是 OS 级共享的）。
async function copyImageToClipboard(a) {
  if (!a || a.type !== 'image') return;
  try {
    await ensureDragData(a, true); // 确保字节已缓存为 File
    const cached = dragFileCache.get(a.url);
    let blob = cached && cached.file;
    let mime = (cached && cached.mime) || guessMime(a);
    if (!blob || !blob.size) {
      // 回退：后台直接拉字节
      const referer = deriveMediaReferer(a.url, window.__sourcePageUrl || '');
      const res = await fetchMediaViaBackground(a.url, referer);
      if (res && res.ok && res.b64) {
        const bytes = b64ToBytes(res.b64);
        mime = res.mime || mime;
        blob = new Blob([bytes], { type: mime });
      }
    }
    if (!blob || !blob.size) { setStatus('复制失败：无法获取图片字节（防盗链/跨域）', true); return; }
    await navigator.clipboard.write([new ClipboardItem({ [mime]: Promise.resolve(blob) })]);
    setStatus('✅ 已复制图片，到微信/PS 按 Ctrl+V 粘贴');
  } catch (e) {
    setStatus('复制失败：' + errStr(e), true);
  }
}
function setStatus(text, isError) {
  const el = document.getElementById('status');
  if (el) { el.textContent = text || ''; el.style.color = isError ? '#ffb4b4' : '#00d4aa'; }
  if (statusTimer) clearTimeout(statusTimer);
  if (text) statusTimer = setTimeout(() => { const e2 = document.getElementById('status'); if (e2) e2.textContent = ''; }, 3500);
}
// 把诊断信息直接写到侧栏日志面板（用户不用找 Service Worker 控制台也能看到 step/clickRes）
function panelLog(label, data) {
  try {
    const wrap = document.getElementById('panelLogWrap');
    const pre = document.getElementById('panelLog');
    if (!pre) return;
    if (wrap) wrap.open = true;
    const ts = new Date().toLocaleTimeString();
    const line = `[${ts}] ${label}: ${typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data)}`;
    pre.textContent = (pre.textContent ? pre.textContent + '\n---\n' : '') + line;
    pre.scrollTop = pre.scrollHeight;
  } catch (_) {}
}
window.panelLog = panelLog;
// 任务 Q：统一的「目标页未就绪」告警文案入口，避免多处手写近似字符串导致风格漂移。
// 所有「content script 未注入 / Ddayup 页未打开」类失败都经此输出，提示措辞保持一致。
function warnStatus(detail) {
  setStatus('⚠ ' + detail + '：请确认 Ddayup 页面已打开并加载完成', true);
}
function setConnection(ok, label) {
  const dot = document.getElementById('statusDot');
  const sub = document.getElementById('pageInfo');
  if (dot) dot.className = 'dot ' + (ok === null ? 'gray' : ok ? 'green' : 'red');
  if (sub && label) sub.textContent = label;
}

// ===== 第三方 Cookie 可用性检测（Privacy Sandbox 弃用告警降级）=====
// Chrome 在跨站 fetch 带 credentials:'include' 时会触发 "Third-party cookie will be blocked"。
// 检测原理：用一个真实跨站端点（googlevideo/youtube 直链预览、爱给/抖音 CDN 下载都依赖它）
// 探测浏览器对第三方 Cookie 的态度。若被阻止，显示友好横幅并让相关功能自动走 omit/回退分支，
// 不抛错、不崩溃。
const HMDAO_ISSUES_URL = 'https://github.com/DaoDaoWave/Ddayup/issues';
let __thirdPartyCookieState = 'unknown'; // 'available' | 'blocked' | 'unknown'

function showThirdPartyCookieNotice() {
  const banner = document.getElementById('thirdPartyCookieNotice');
  if (!banner) return;
  banner.style.display = '';
  const link = document.getElementById('thirdPartyCookieIssuesLink');
  if (link) link.href = HMDAO_ISSUES_URL;
  const dismiss = document.getElementById('thirdPartyCookieDismiss');
  if (dismiss && !dismiss.__bound) {
    dismiss.__bound = true;
    dismiss.addEventListener('click', () => { banner.style.display = 'none'; });
  }
}

function hideThirdPartyCookieNotice() {
  const banner = document.getElementById('thirdPartyCookieNotice');
  if (banner) banner.style.display = 'none';
}

// 通过设置一个第三方上下文的探测 cookie 并回读，判断第三方 Cookie 是否可用。
// 采用轻量方案：尝试 fetch 一个跨站且需 Referer 的公开资源（HEAD），观察是否因 Cookie 缺失而 403/401。
// 为不依赖特定站点，使用 document.cookie 在 sidepanel 自身（extension 上下文，属于 first-party）外，
// 借由 image 探针 + onerror 推断。若无法确定则保守显示提示，核心功能仍可用。
async function checkThirdPartyCookies() {
  try {
    // 方法：向一个已知需要第三方 Cookie 的跨站媒体探测（仅做 HEAD，不下载字节）。
    // 用 background 代为请求更可靠：让 background 在带/不带 Cookie 两种情况下探测，
    // 比较结果差异。此处用 contentSetting 探测作为主信号。
    if (typeof chrome !== 'undefined' && chrome.contentSettings && chrome.contentSettings.get) {
      const setting = await new Promise((resolve) => {
        chrome.contentSettings.get(
          { primaryUrl: 'https://www.youtube.com/', setting: 'cookies' },
          (details) => resolve(details || null)
        );
      }).catch(() => null);
      // setting.value 可能为 'allow' | 'block' | 'session_only' | 'ask'
      if (setting && setting.value && setting.value !== 'allow') {
        __thirdPartyCookieState = 'blocked';
        showThirdPartyCookieNotice();
        return 'blocked';
      }
    }
    // 无 contentSettings API 或显式 allow：尝试运行时探测（点开任一 YouTube 视频预览时由
    // fallbackCdnFetch 的错误码累计判断，这里先做保守未知态，不弹横幅）。
    __thirdPartyCookieState = 'available';
    hideThirdPartyCookieNotice();
    return 'available';
  } catch (err) {
    // 检测失败不应影响核心功能，保守按 unknown 处理、不弹横幅避免误报。
    __thirdPartyCookieState = 'unknown';
    return 'unknown';
  }
}

// ===== Background 通讯（fetchViaBackground / fetchMediaViaBackground / loadImageViaRelay 抽离至 media-fetch.js）=====

// 读取【播放器已下载的真实字节】——预览/下载 YouTube 视频最可靠的数据源。
// 播放器请求 googlevideo 时已带齐 n 签名 / 会话 Cookie / Referer，字节是真视频；
// 直接读这份字节，彻底绕过「抓直链后再重发被 YouTube 返回几百字节假视频文件」的死结。
async function getYtBytesViaBackground(url) {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'HMDAO_GET_YT_BYTES', url });
    if (r && r.ok) {
      // ★ 主路径：从 storage 分段读取 base64（background 已用 Uint8Array structured clone + btoa 编码）
      if (r._storageChunks && r._storageChunks.length) {
        try {
          const parts = [];
          for (const k of r._storageChunks) {
            const entry = await chrome.storage.local.get(k);
            if (entry && entry[k]) parts.push(entry[k]);
            await chrome.storage.local.remove(k);
          }
          const b64 = parts.join('');
          if (b64.length > 0) return { ok: true, b64, mime: r.mime, size: r.size, itag: r.itag };
        } catch (_) {}
      }
      if (r._storageKey) {
        try {
          const entry = await chrome.storage.local.get(r._storageKey);
          const data = entry && entry[r._storageKey];
          if (data && data.b64) { await chrome.storage.local.remove(r._storageKey); return { ok: true, b64: data.b64, mime: data.mime || r.mime, size: data.size || r.size, itag: data.itag || r.itag }; }
        } catch (_) {}
      }
    }
    return r || { ok: false, error: 'unknown' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
function isYoutubeMedia(url) {
  return /googlevideo\.(com|localhost)\/videoplayback|youtube\.com/i.test(url || '');
}
// yt-dlp 支持的多平台（YouTube/B站/优酷/腾讯/iqiyi/西瓜/搜狐等，以及 generic 通用兼容），可走后端提取 + 格式选择
// ★扩展：网络层被动捕获的 bilivideo 裸流（来源 source='bilibili-network'，没有 biliPageUrl 字段）也是一种 B站视频，
//        源页就是 B站播放页（window.__sourcePageUrl 含 bilibili.com），yt-dlp 能根据源页拉到多分辨率。
//        此前正则只认 bilibili.com 域名，遇到 bilivideo 裸流 + 源页是 B站时漏判 → 直链 chrome.downloads 直接 403 失败。
function isYtDlpPlatform(a) {
  if (!a) return false;
  const src = window.__sourcePageUrl || '';
  const platformUrl = a.playerUrl || a.ytPageUrl || a.biliPageUrl || a.url || '';
  const combined = platformUrl + ' ' + src;
  // generic 平台（未在白名单但被当作视频平台）：直接走 yt-dlp 尝试提取
  if (a.platform === 'generic') return true;
  // 关键：网络层捕获的 B站视频源（bilivideo 裸流 + source='bilibili-network'）→ 源页是 bilibili.com → yt-dlp 可解
  // ★2026-08-30 修正（用户要求"需要就要启用 yt-dlp"）：
  //   此前我把它注释掉（"永不判为 yt-dlp"）是过度修正——那会让 B站【失去 yt-dlp 兜底能力】。
  //   正确架构是【优先级】而非【禁用】：
  //     WBI 直连（快、无大小限制、不依赖后端）→ 失败才回退 yt-dlp（需后端，作为兜底）。
  //   该优先级在 download.js 的 B站分支实现，此处仅恢复"能否走 yt-dlp"的判定能力。
  const isBiliNet = (a.source && /bilibili/i.test(a.source)) && /bilibili\.com/i.test(src);
  if (isBiliNet) return true;
  // 2026-08-02 扩展 yt-dlp 平台：抖音/TikTok/新片场/快手/AcFun/好看等。
  // 同时补齐与 seekin.ai 对齐的社交平台（Instagram/小红书/Twitter-X/Facebook/Pinterest/VK/Kwai），
  // 这些 yt-dlp 均有专门 extractor，能解析多分辨率、合并音视频。
  // ★2026-08-18 修复：抖音/视频号（douyin.com / iesdouyin.com / tiktok.com）【不再】吸入 yt-dlp 通道。
  //   原因：抖音直链已由 MAIN 世界 hmdaoCaptureDyStream + 回源 RENDER_DATA 捕获（无需 yt-dlp 反爬解析）；
  //   且 yt-dlp 的 douyin/tiktok extractor 需要登录 cookie，在扩展场景 100% 失败并 spawn 出
  //   yt-dlp.exe/ffmpeg 黑窗口（用户点击抖音视频卡片即弹窗），体验极差。抖音预览/下载改走
  //   fallbackCdnRefetch（后台带 Referer 拉字节→blob）与 downloadViaBackground。
  const isDouyinFamily = /douyin\.com|iesdouyin\.com|tiktok\.com/i.test(combined)
    || !!a.platform && /douyin|tiktok/.test(a.platform);
  if (isDouyinFamily) return false;
  return /youtube\.com|youtu\.be|bilibili\.com|b23\.tv|xinpianchang\.com|kuaishou\.com|ixigua\.com|youku\.com|player\.youku|vzuu\.com|qq\.com|v\.qq\.com|iqiyi\.com|tudou\.com|sohu\.com|acfun\.cn|haokan\.baidu\.com|m\.haokan|instagram\.com|xiaohongshu\.com|xhslink\.com|twitter\.com|x\.com|facebook\.com|fb\.watch|pinterest\.com|vk\.com|kwai\.com/i.test(combined)
    || !!a.platform && /youku|qq|iqiyi|tudou|xigua|sohu|bilibili|youtube|xinpianchang|kuaishou|acfun|haokan|instagram|xiaohongshu|twitter|facebook|pinterest|vk|kwai/.test(a.platform);
}

// 媒体防盗链站专用 Referer：抖音/TikTok 系列固定 www.douyin.com；视频号用当前 host；B站固定 www.bilibili.com
function deriveMediaReferer(url, page) {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    // ★2026-08-31 修复（抖音/国际版 TikTok 分平台 Referer）：
    //   抖音图床（p3-sign.douyinpic.com / douyinpic.com）校验 Referer=www.douyin.com，否则 403。
    //   TikTok 国际版（tiktok.com / tiktokcdn.com / bytecdn）校验 Referer=www.tiktok.com，写成 douyin 会被 403。
    //   二者必须按域名分别返回，不能统一写死 douyin。
    if (h.includes('tiktok')) return 'https://www.tiktok.com/';
    if (h.includes('douyin') || h.includes('bytedance') || h.includes('douyinpic')) return 'https://www.douyin.com/';
    if (h.includes('weixin') || h.includes('qq.com')) return 'https://' + h + '/';
    // 小红书图床（xhscdn.com / sns-img.xiaohongshu.com）校验 Referer 为小红书站点，否则 403
    if (h.includes('xhscdn') || h.includes('xiaohongshu') || h.includes('xhs')) return 'https://www.xiaohongshu.com/';
    // B站 CDN（bilivideo.com / bilivideo.cn / bilivideo.tv）要求 Referer=https://www.bilibili.com/
    if (h.includes('bilivideo')) return 'https://www.bilibili.com/';
    // ★2026-09-08 修复（豆包 CDN 缩略图 403 真凶）：
    //   豆包（doubao.com）的 imagex CDN 是 p3-/p6-/p11-flow-imagex-sign.byteimg.com，
    //   与抖音共用 byteimg.com 但【严格校验 Referer=https://www.doubao.com/】。
    //   该域名不含 douyin/bytedance/douyinpic 任一关键字 → 上面分支全不命中 →
    //   落到 return page 用「源页完整 URL」（常带查询串/modal_id）当 Referer → CDN 拒 → 403，
    //   侧栏 <img> 直连更糟（Referer 是 chrome-extension:// 源，必然 403）。
    //   故按 imagex 命名空间精确识别豆包 CDN，固定返回干净站根 Referer。
    if (h.includes('doubao') || h.includes('flow-imagex')) return 'https://www.doubao.com/';
    // ★2026-09-11 新增（imini / 即梦国际版 CDN「软失败回统一占位图」根因）：
    //   imini 的媒体 CDN（file.iminicdn.com 等）校验 Referer：传带查询串/路径的完整源页 URL
    //   会被软失败（返回 200 + 统一绿色占位图，而不是 403）。只认【干净站根】https://imini.ai/。
    //   注意：仅新增本分支，不动下方 byteimg 通用分支与任何既有判定。
    if (h.includes('iminicdn') || h.includes('imini')) return 'https://imini.ai/';
    // 通用 byteimg.com —— 字节系【共用】CDN：抖音 / 豆包 / 即梦 / 剪映等都走它，
    //   因此只能按【源页平台】决定 Referer，绝不能对域名本身做假设。
    // ★2026-09-08 修正：上一版对"其它 byteimg"硬编码返回 douyin，会害了同样用 byteimg 的
    //   非抖音站点（实测即梦 jimeng.jianying.com 的图床 p3-res-place.byteimg.com，
    //   其 CDN 校验的是即梦自己的 Referer → 用 douyin 反而 403，缩略图/字节都拿不到）。
    //   改为：仅当源页确实是豆包/抖音/TikTok 才写死；其它站点【不做假设】，落到下方
    //   return page（用源页自身 origin 当 Referer），与通用站点行为一致。
    if (h.includes('byteimg')) {
      const pg = String(page || '');
      if (/doubao\.com/i.test(pg)) return 'https://www.doubao.com/';
      if (/tiktok/i.test(pg)) return 'https://www.tiktok.com/';
      if (/douyin\.com|iesdouyin\.com/i.test(pg)) return 'https://www.douyin.com/';
      // ★2026-09-08：即梦/Dreamina（p*-dreamina-sign.byteimg.com）、剪映等同样用 byteimg 的
      //   字节系站点 —— 只认【站点根】Referer；传整条带路径/查询的源页 URL 会被 CDN 拒（实测 403）。
      //   故取源页 origin + '/'；解析失败再退回原样由通用分支处理。
      try {
        const pu = new URL(pg);
        if (/^https?:/i.test(pu.protocol)) return pu.origin + '/';
      } catch (_) {}
    }
  } catch (_) {}
  return page || '';
}

// base64 → Uint8Array（后台回传的媒体字节用）
// 分段解码：超长 base64（>1MB）的单次 atob 在部分 Chrome 版本有边界 bug。
// 改为每 48KB 输出分一段（对应 64KB base64 输入），逐段 atob 后拼合。
function b64ToBytes(b64) {
  // 快速路径：短字符串直接 atob
  if (b64.length < 100000) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  // 分段路径：每 65536 base64 字符一段（解码输出 ~49152 字节）
  const SEG = 65536;
  const parts = [];
  for (let i = 0; i < b64.length; i += SEG) {
    const seg = b64.slice(i, Math.min(i + SEG, b64.length));
    parts.push(atob(seg));
  }
  const total = parts.reduce((s, c) => s + c.length, 0);
  const bytes = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) bytes[pos++] = p.charCodeAt(i);
  }
  return bytes;
}
async function findHmdaoTab() {
  // 优先按云端配置的基地址匹配已打开的 Ddayup Web 标签；同时兼容本机 localhost。
  const base = apiBaseUrl();
  const patterns = [];
  try {
    const u = new URL(base);
    patterns.push(u.origin + '/*');
  } catch (_) {}
  patterns.push('http://127.0.0.1:3000/*', 'http://localhost:3000/*');
  const tabs = await chrome.tabs.query({ url: patterns });
  return tabs[0] || null;
}

// ===== 小精灵（标题旁 SVG）：眼镜跟随鼠标 + 周期性眨眼 =====
(function initElfIcon() {
  const elf = document.getElementById('elfIcon');
  if (!elf) return;
  const pupilL = document.getElementById('pupilLeft');
  const pupilR = document.getElementById('pupilRight');
  if (!pupilL || !pupilR) return;
  const orig = { lx: +pupilL.getAttribute('cx'), ly: +pupilL.getAttribute('cy'), rx: +pupilR.getAttribute('cx'), ry: +pupilR.getAttribute('cy') };
  let lastMove = Date.now();

  document.addEventListener('mousemove', (e) => {
    const r = elf.getBoundingClientRect();
    const cX = r.left + r.width / 2, cY = r.top + r.height / 2;
    const dx = e.clientX - cX, dy = e.clientY - cY;
    const dist = Math.min(2.6, Math.hypot(dx, dy) / 35);
    const ang = Math.atan2(dy, dx);
    const ox = Math.cos(ang) * dist, oy = Math.sin(ang) * dist;
    pupilL.setAttribute('cx', orig.lx + ox); pupilL.setAttribute('cy', orig.ly + oy);
    pupilR.setAttribute('cx', orig.rx + ox); pupilR.setAttribute('cy', orig.ry + oy);
    lastMove = Date.now();
  }, { passive: true });

  function blink() { elf.classList.add('blinking'); setTimeout(() => elf.classList.remove('blinking'), 160); }
  // 眨眼节奏：随机 2.5-5.5 秒一次；闲置 10s+ 来个「打盹」双眨
  function loop() {
    const idle = Date.now() - lastMove > 10000;
    blink();
    setTimeout(() => { if (idle) blink(); }, 180); // 闲置时偶尔双眨
    setTimeout(loop, 2500 + Math.random() * 3000);
  }
  setTimeout(loop, 1200); // 启动后 1.2s 第一次眨眼
})();

// === 资产去重 + 列表渲染 已抽离到 card-render.js（在 sidepanel.js 之后、bulk-actions.js 之前加载，共享全局作用域） ===
// 原函数：deduplicateImages / render / shouldExclude / reapplyFilters。
// 依赖全局：assets / selected / currentFilter / imgDimensions / ensureDragData / openPreview /
// showContextMenu / hoverPlayAudio / stopHoverAudio / loadImageViaRelay / displayName / getAsset /
// queueModelThumb / netdiskResolve / window.__sourcePageUrl（均由 sidepanel.js / audio-playback.js 提供）。

// ===== 类型筛选 =====
document.querySelectorAll('.chip').forEach((chip) => {
  chip.onclick = () => {
    document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    currentFilter = chip.dataset.type;
    render();
  };
});

// ===== 重新扫描（核心函数，供「重新扫描」按钮与 HMDAO_RESCAN_TAB 自动同步共用）=====
// ★2026-08-23 P0：侧栏与当前浏览器页同步 + 关闭内容自动清理（正在下载的除外）。
//   关键修复（"重新扫描不清空旧素材、与当前页不同步"根因）：旧逻辑只发 HMDAO_SCAN_REQUEST，
//   assets/selected/batchSelection 全保留，新扫描结果被 merge 追加 → 旧标签素材滞留。
//   修复：先清空（保留正在下载的素材），再发扫描，确保只反映当前活动标签。
async function doRescan() {
  if (window.HMDaoLicense && !(await window.HMDaoLicense.gate())) return;
  // ★2026-08-23 修复（问题3 根因）：先确定当前活动页 URL，用于「增量合并 vs 换页重置」判定。
  //   用户要求：刷新/切 tab 不再清空已有卡片；仅当 URL 真正变化时重置；切换网页也同步重置。
  let activeUrl = '';
  try {
    // ★2026-09-11 修复（源页被污染成 devtools 调试窗口、导致列表恒空的根因）：
    //   侧栏自身是独立窗口，{active:true, currentWindow:true} 在侧栏上下文里查到的是它挂着的 DevTools 窗口
    //   → currentSourceUrl 被写成 devtools://... → 后续合并/换页判定全乱。改为只查【普通浏览器窗口】，
    //   且只接受 http(s) 页面，彻底排除 devtools/chrome/edge/about/扩展页。
    const tabs = await chrome.tabs.query({ active: true, windowType: 'normal' });
    activeUrl = (tabs && tabs[0] && tabs[0].url) || '';
    if (activeUrl && !/^https?:/i.test(activeUrl)) activeUrl = ''; // 非内容页不更新源页
  } catch (_) { }

  // ★2026-09-04 修复：按【页面/合集身份】判定换页，而非整条 URL（合集内切集 modal_id/aweme_id 变化不再误判换页清空）。
  const curId = hmdaoSourceIdentityKey(currentSourceUrl);
  const newId = hmdaoSourceIdentityKey(activeUrl);
  const urlChanged = !curId || (activeUrl && newId && newId !== curId);
  // 记录最新 URL（除非拿不到，保留旧值避免误判换页）
  if (activeUrl) currentSourceUrl = activeUrl;

  // 1) 手动「重新扫描」= 用户主动「从头再来」→ 无论 URL 是否变化，一律清空普通扫描资产再重扫，
  //    保证旧记录不被残留（用户明确要求：点重新扫描按钮即清除旧记录后重新识别）。
  //    仅保留「正在下载的普通资产」+「全部批量资产」（批量永清，满足"扫描多少是多少"）。
  let preserved = [];
  try {
    const dlUrls = (window.HmdaoProgress && window.HmdaoProgress.getDownloadingAssetUrls && window.HmdaoProgress.getDownloadingAssetUrls()) || [];
    if (dlUrls.length && Array.isArray(window.assets)) {
      preserved = window.assets.filter(a => dlUrls.includes(a.url));
    }
  } catch (_) {}
  try {
    // 换页/同页重扫统一走「重置」分支：仅保留「正在下载的普通资产」+「全部批量资产」，其余普通资产清空。
    const keep = batchAssets.concat(preserved.filter(a => !batchAssets.some(b => b.url === a.url)));
    window.assets = keep.slice();
    window.selected = new Set();
    try { batchSelection && batchSelection.clear(); } catch (_) {}
    // 卡片列表 = window.assets（已是 普通 + 批量 合并展示）；计数用合并列表
    const combined = window.assets.slice();
    try { window.__hmdaoAssets = combined.slice(); } catch (_) {}
    try { renderNow(); } catch (_) {}
    try { updateScanStatus(combined, 'scanning'); } catch (_) {}
  } catch (_) {}
  // 2) 探测后端健康（仅 fetch 本机 3000，不触达原生主机；失败也继续扫描页面内素材）
  setStatus('正在探测 Ddayup 后端…');
  try {
    const backendReady = await checkBackendHealth();
    setStatus(backendReady ? '后端已就绪，重新扫描中…' : '后端未启动，仍继续扫描页面内素材');
  } catch (e) {
    setStatus('后端探测失败：' + (e && e.message ? e.message : String(e)));
  }
  // ★2026-09-06：每次重新扫描前清空「诊断日志」面板并折叠 —— 没在诊断时保持干净状态，
  //   不让上一轮的日志一直堆在底部（用户要求：不诊断即清空）。
  try {
    const logEl = document.getElementById('panelLog');
    const wrap = document.getElementById('panelLogWrap');
    if (logEl) logEl.textContent = '';
    if (wrap) wrap.open = false;
  } catch (_) {}
  // 3) 发扫描请求 + 自动诊断真实数据到日志
  chrome.runtime.sendMessage({ type: 'HMDAO_SCAN_REQUEST', batchMode: batchCollectEnabled, force: true }).catch(() => {});
  try {
    const tabs = await chrome.tabs.query({ active: true, windowType: 'normal' });
    runDiagnose(tabs && tabs[0]);
  } catch (_) {}
}

// ★2026-09-07：换页清空旧资产（与 doRescan 的「换页重置」同语义，供 auto 事件轻量调用）。
//   保留「正在下载的普通资产」+「全部批量资产」(批量永清，满足"扫描多少是多少")，其余普通资产随换页丢弃，
//   确保不同链接的文件记录不会混在一起显示。
function clearAssetsForNewPage() {
  try {
    const dlUrls = (window.HmdaoProgress && window.HmdaoProgress.getDownloadingAssetUrls && window.HmdaoProgress.getDownloadingAssetUrls()) || [];
    const preserved = (Array.isArray(window.assets) ? window.assets.filter((a) => dlUrls.includes(a.url)) : []);
    const keep = batchAssets.concat(preserved.filter((a) => !batchAssets.some((b) => b.url === a.url)));
    window.assets = keep.slice();
    window.selected = new Set();
    try { batchSelection && batchSelection.clear(); } catch (_) {}
    window.__hmdaoAssets = window.assets.slice();
    // ★2026-09-12：换页清空旧资源时，若预览仍开着（展示的是旧页素材）→ 一并关闭，
    //   否则旧页的视频/音频仍在源页或帧流里播放，造成"切了页却还在响"。
    if (typeof closePreview === 'function') { try { closePreview(); } catch (_) {} }
    try { renderNow(); } catch (_) {}
  } catch (_) {}
}

document.getElementById('rescan').onclick = doRescan;

// ★2026-09-07 建议1：hash 路由站点「切换内容也清卡」开关（默认关，避免误清同页 SPA）。
//   改动即时写 localStorage，docKey 计算时实时读取（hmdaoHashClearEnabled），无需重载侧栏。
try {
  const hc = document.getElementById('hashClearOnRoute');
  if (hc) {
    hc.checked = hmdaoHashClearEnabled();
    hc.addEventListener('change', () => {
      try { localStorage.setItem('hashClearOnRoute', hc.checked ? '1' : '0'); } catch (_) {}
      // 切换后若当前已是 hash 路由页，立即按新规则重新同步一次（避免要等下次导航才生效）。
      try { loadPagePreview(); } catch (_) {}
      try { chrome.runtime.sendMessage({ type: 'HMDAO_SCAN_REQUEST', batchMode: batchCollectEnabled, force: true }).catch(() => {}); } catch (_) {}
    });
  }
} catch (_) {}


// ===== 诊断：抓取当前抖音页真实数据（标题/缩略图/视频URL/合集/分辨率）=====
// 挂载点：每次点「↻ 重新扫描」自动运行，结果写入底部「诊断日志」展开框（不新增按钮）。
// ★2026-08-31：全局诊断日志写出函数（供 download.js / 下载链路把错误/状态写入侧栏 #panelLog 诊断区）。
function hmdaoLog(s) {
  try {
    const logEl = document.getElementById('panelLog');
    const wrap = document.getElementById('panelLogWrap');
    if (wrap) wrap.open = true;
    if (logEl) { logEl.textContent += s + '\n'; logEl.scrollTop = logEl.scrollHeight; }
  } catch (_) {}
}
// 2026-08-23 整改：抖音真实数据在 window.RENDER_DATA（React 流式 JSON 字符串，需 decodeURIComponent 后 JSON.parse），
// 不再依赖不存在的 __playInfo。aweme 结构：desc、aweme_id、video.cover.url_list、video.play_addr.url_list。
async function runDiagnose(tab) {
  const logEl = document.getElementById('panelLog');
  const wrap = document.getElementById('panelLogWrap');
  if (wrap) wrap.open = true;
  const out = (s) => { if (logEl) { logEl.textContent += s + '\n'; logEl.scrollTop = logEl.scrollHeight; } };
  out('=== [HMDAO诊断] ' + new Date().toLocaleTimeString() + ' ===');
  if (!tab || !tab.id) { out('无活动标签'); return; }
  out('源页: ' + tab.url);
  if (!/douyin\.com/.test(tab.url || '')) { out('当前不是抖音页，跳过诊断（仅抖音页抓取真实数据）'); return; }
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => {
        const R = { url: location.href, title: document.title, play: null, collection: [], dom: [], videoSrc: null, resolutions: [], windowScan: [], rdErr: null };
        // ★2026-08-23 整改：抖音 RENDER_DATA 是惰性 Proxy/defineProperty 对象，递归遍历或 JSON.parse 会抛
        //   "Illegal invocation"。改为：① 用 Function 拿到原始 JSON（绕过页面可能改写的 JSON）；
        //   ② 失败则回退到把 RENDER_DATA 转成字符串后用「正则」提取 aweme 关键字段，全程不调用对象方法；
        //   ③ RENDER_DATA / 合集 / DOM 各步独立 try，互不连累（之前因 RENDER_DATA 异常导致 DOM 也 0 条）。
        R.windowScan = ['player', 'RENDER_DATA'].filter(k => window[k]);

        // —— 1) RENDER_DATA 解析（隔离 try）——
        let rdObj = null;
        try {
          const raw = window.RENDER_DATA;
          const rawStr = (typeof raw === 'string') ? (raw.charAt(0) === '%' ? decodeURIComponent(raw) : raw) : String(raw);
          // 用原始 JSON（Function 构造，拿到原生 parse，避免页面改写 JSON 触发 Illegal invocation）
          const nativeParse = Function('return JSON.parse')();
          try { rdObj = nativeParse(rawStr); }
          catch (_) { rdObj = null; }
          R.rdType = typeof raw;
          R.rdLen = rawStr.length;
        } catch (e) { R.rdErr = String(e); }

        // —— 2) 从 rdObj 取当前播放 aweme（隔离 try，纯属性读取，不递归遍历 Proxy）——
        try {
          if (rdObj && typeof rdObj === 'object') {
            // ★2026-08-31 修复（诊断误报根因）：抖音新版 RENDER_DATA 用驼峰 awemeId，
            //   旧 pushIfAweme 只查 aweme_id 永远不命中 → 误报「未解析到 aweme」。
            //   修复：兼容驼峰 + 下划线，且优先取 data.app.videoDetail（jingxuan/详情页权威锚点）。
            const candidates = [];
            const awemeIdOf = (o) => (o && o.awemeId != null) ? String(o.awemeId)
              : (o && o.aweme_id != null ? String(o.aweme_id) : '');
            const pushIfAweme = (o) => { if (o && awemeIdOf(o) && o.video) candidates.push(o); };
            // 深度放宽到 8，覆盖 data.app.videoDetail.awemeList / preloadAwemeList 等深层嵌套
            const search = (node, depth) => {
              if (!node || depth > 8 || candidates.length >= 5) return;
              if (Array.isArray(node)) { for (const it of node) search(it, depth + 1); return; }
              if (typeof node !== 'object') return;
              pushIfAweme(node);
              for (const k of ['data', 'awemeDetail', 'aweme', 'video', 'itemList', 'list', 'app', 'videoDetail', 'detail', 'awemeList', 'aweme_list', 'preloadAwemeList', 'mix_item_list']) {
                if (node[k]) search(node[k], depth + 1);
              }
            };
            // ★优先取 data.app.videoDetail（jingxuan/详情页权威锚点，含 cover/title/awemeId）
            try {
              const vd = rdObj && rdObj.app && rdObj.app.videoDetail;
              if (vd && awemeIdOf(vd) && vd.video) candidates.unshift(vd);
            } catch (_) {}
            search(rdObj, 0);
            const aweme = candidates[0];
            if (aweme) {
              const v = aweme.video || {};
              const coverRaw = v.cover || v.originCover || v.dynamicCover || v.gaussianCover || '';
              const coverList = (coverRaw && Array.isArray(coverRaw.url_list)) ? coverRaw.url_list : [];
              const playList = (v.play_addr && v.play_addr.url_list) || [];
              const downloadList = (v.download_addr && v.download_addr.url_list) || [];
              // ★bitRateList[].playAddr 兜底（实测 jingxuan 页 play_addr.url_list 常为空）
              const brUrls = [];
              if (Array.isArray(v.bitRateList)) {
                v.bitRateList.forEach((br) => {
                  const pa = br && (br.playAddr || br.PlayUrl);
                  if (!pa) return;
                  const isAudio = (br.gear_type === 'audio' || br.GearType === 'audio') || /media-audio/i.test(typeof pa === 'string' ? pa : JSON.stringify(pa));
                  if (isAudio) return;
                  if (Array.isArray(pa)) pa.forEach((x) => { if (typeof x === 'string') brUrls.push(x); else if (x && x.src) brUrls.push(x.src); else if (x && x.url_list && x.url_list[0]) brUrls.push(x.url_list[0]); });
                  else if (typeof pa === 'object') {
                    if (typeof pa.src === 'string') brUrls.push(pa.src);
                    else if (Array.isArray(pa.url_list) && pa.url_list[0]) brUrls.push(pa.url_list[0]);
                  } else if (typeof pa === 'string') brUrls.push(pa);
                });
              }
              const allPlayUrls = playList.concat(downloadList).concat(brUrls).filter((u) => typeof u === 'string' && u.indexOf('http') === 0);
              R.play = {
                desc: aweme.desc || '',
                awemeId: awemeIdOf(aweme),
                cover: (typeof coverRaw === 'string' ? coverRaw : '') || coverList[0] || '',
                playAddr: allPlayUrls[0] || '',
              };
              R.resolutions = brUrls.map((u, i) => ({ label: '档位 ' + (i + 1), url: u }));
              if (!R.resolutions.length && allPlayUrls[0]) R.resolutions.push({ label: '默认(单档)', url: allPlayUrls[0] });
            }
          }
        } catch (e) { R.playErr = String(e); }

        // —— 3) 合集（隔离 try）——
        try {
          if (rdObj && typeof rdObj === 'object') {
            const coll = [];
            const search2 = (node, depth) => {
              if (!node || depth > 4) return;
              if (typeof node !== 'object') return;
              if (node.mix_id && Array.isArray(node.mix_item_list)) {
                for (const x of node.mix_item_list) coll.push({ desc: (x.desc || '').slice(0, 30), awemeId: String(x.aweme_id || ''), cover: (x.video && x.video.cover && (x.video.cover.url_list || [])[0]) || '' });
              }
              if (node.aweme_list && Array.isArray(node.aweme_list)) {
                for (const x of node.aweme_list) coll.push({ desc: (x.desc || '').slice(0, 30), awemeId: String(x.aweme_id || ''), cover: (x.video && x.video.cover && (x.video.cover.url_list || [])[0]) || '' });
              }
              for (const k of Object.keys(node)) { const v = node[k]; if (v && typeof v === 'object') search2(v, depth + 1); }
            };
            search2(rdObj, 0);
            R.collection = coll.slice(0, 20);
          }
        } catch (e) { R.collErr = String(e); }

        // —— 4) DOM 资源（隔离 try，用 Array.prototype.forEach.call + getAttribute 避免 getter this 问题）——
        try {
          const dom = [];
          const imgs = document.querySelectorAll('img');
          Array.prototype.forEach.call(imgs, (el) => { const s = el.getAttribute('src'); if (s && s.indexOf('http') === 0 && !/icon|avatar|logo/.test(s)) dom.push({ t: 'img', src: s, w: el.naturalWidth || 0, h: el.naturalHeight || 0 }); });
          const vids = document.querySelectorAll('video');
          Array.prototype.forEach.call(vids, (el, i) => {
            if (i < 5) { const cs = el.currentSrc || el.getAttribute('src'); dom.push({ t: 'video', src: cs || '', poster: el.getAttribute('poster') || '', w: el.videoWidth || 0, h: el.videoHeight || 0 }); if (cs) R.videoSrc = cs; }
          });
          const auds = document.querySelectorAll('audio');
          Array.prototype.forEach.call(auds, (el, i) => { if (i < 5) dom.push({ t: 'audio', src: el.currentSrc || el.getAttribute('src') || '' }); });
          const links = document.querySelectorAll('a');
          Array.prototype.forEach.call(links, (el) => { const h = el.getAttribute('href') || ''; if (el.hasAttribute('download') || /\.(mp4|mp3|zip)($|\?)/.test(h)) dom.push({ t: 'dl', href: h, text: (el.textContent || '').trim().slice(0, 40) }); });
          R.dom = dom.slice(0, 40);
        } catch (e) { R.domErr = String(e); }
        return R;
      },
    });
    const data = res && res.result;
    if (!data) { out('注入返回空（可能页面未完全加载或非抖音）'); return; }
    if (data.err) out('页面内抓取异常: ' + data.err);
    out('URL: ' + data.url);
    out('页面标题: ' + data.title);
    out('window 命中字段: ' + JSON.stringify(data.windowScan));
    out('RENDER_DATA 类型: ' + (data.rdType || '?') + ' 长度: ' + (data.rdLen || 0) + (data.rdErr ? (' 解析异常: ' + data.rdErr) : ' 解析OK'));
    if (data.playErr) out('  [play解析异常] ' + data.playErr);
    if (data.collErr) out('  [合集解析异常] ' + data.collErr);
    if (data.domErr) out('  [DOM解析异常] ' + data.domErr);
    if (data.play) {
      out('--- 当前播放视频（来自 RENDER_DATA）---');
      out('标题(desc): ' + (data.play.desc || '(空)'));
      out('awemeId: ' + (data.play.awemeId || '(空)'));
      out('封面URL: ' + (data.play.cover || '(空)'));
      out('播放直链: ' + (data.play.playAddr || '(空/blob)'));
      out('分辨率档位 (' + (data.resolutions ? data.resolutions.length : 0) + '):');
      (data.resolutions || []).forEach((r, i) => out('  [' + i + '] ' + r.label + ' ' + (r.url || '').slice(0, 70)));
    } else { out('--- 当前播放视频: RENDER_DATA 未解析到 aweme（页面可能未完全加载，稍候再点重新扫描）---'); }
    out('--- 当前 <video> 正在播放 src ---');
    out(data.videoSrc || '(无 <video> 或尚未播放)');
    out('--- 合集视频列表 (' + (data.collection ? data.collection.length : 0) + ' 条) ---');
    if (data.collection && data.collection.length) {
      data.collection.slice(0, 10).forEach((c, i) => out('  [' + i + '] desc=' + (c.desc || '') + ' awemeId=' + c.awemeId + ' cover=' + (c.cover || '').slice(0, 60)));
    } else out('  (无合集数据；单视频页或合集未加载)');
    // ★2026-08-24 新增（用户实测「url和当前网站播放的视频内容不一致」根因暴露）：
    //   对比【侧栏扫描到的视频资产 URL】与【源页 DOM <video> 当前真实 src】，给出一致性诊断。
    try {
      const scannedVideos = (window.assets || []).filter((a) => a && a.type === 'video').map((a) => (a.url || '').split('?')[0]);
      const domSrc = (data.videoSrc || '').split('?')[0];
      out('--- 视频URL一致性诊断 ---');
      out('侧栏已扫描视频资产 (' + scannedVideos.length + ' 条):');
      scannedVideos.slice(0, 5).forEach((u, i) => out('  [扫描' + i + '] ' + u.slice(0, 80)));
      out('源页 DOM <video> 当前真实 src: ' + (domSrc || '(无)'));
      if (domSrc && scannedVideos.length) {
        const matched = scannedVideos.some((u) => domSrc === u || domSrc.indexOf(u) >= 0 || u.indexOf(domSrc) >= 0);
        if (matched) out('✅ 一致：侧栏扫描到的视频URL与源页正在播放的视频匹配');
        else out('❌ 不一致：侧栏扫描到的视频URL ≠ 源页正在播放的视频（可能取到推荐流/广告/电子营业执照）—— 已修复优先用 DOM <video> src');
      } else if (!domSrc) {
        out('⚠ 源页无 <video> 当前 src（视频可能未播放/未加载）—— 扫描取不到当前播放视频');
      }
    } catch (_) {}
    out('--- DOM 资源样本 (' + data.dom.length + ') ---');
    data.dom.slice(0, 25).forEach((d, i) => {
      if (d.t === 'img') out('  [' + i + '] img ' + d.w + 'x' + d.h + ' ' + d.src.slice(0, 80));
      else if (d.t === 'video') out('  [' + i + '] video ' + (d.w || '?') + 'x' + (d.h || '?') + ' src=' + (d.src || '').slice(0, 80) + ' poster=' + (d.poster || '').slice(0, 50));
      else if (d.t === 'audio') out('  [' + i + '] audio ' + (d.src || '').slice(0, 80));
      else if (d.t === 'dl') out('  [' + i + '] dl ' + (d.text || '') + ' ' + (d.href || '').slice(0, 80));
    });
    out('=== [HMDAO诊断] 结束 ===');
  } catch (e) {
    out('诊断注入失败: ' + (e && e.message ? e.message : String(e)));
  }
}



// ===== 尺寸/低质量筛选 =====
document.getElementById('applyFilter').onclick = () => {
  minWidth = parseInt(document.getElementById('minWidth').value, 10) || 0;
  minHeight = parseInt(document.getElementById('minHeight').value, 10) || 0;
  excludeIcons = !!document.getElementById('excludeIcons').checked;
  blockWatermark = !!document.getElementById('blockWatermark').checked;
  reapplyFilters();
  setStatus(`筛选：宽≥${minWidth} 高≥${minHeight} 排除小图标=${excludeIcons} 屏蔽水印来源=${blockWatermark}`);
};
document.getElementById('clearFilter').onclick = () => {
  document.getElementById('minWidth').value = '';
  document.getElementById('minHeight').value = '';
  document.getElementById('excludeIcons').checked = false;
  minWidth = 0; minHeight = 0; excludeIcons = false;
  reapplyFilters();
  setStatus('筛选已清空');
};

// ★2026-08-18：水印来源屏蔽开关 + 自定义域名
const blockWatermarkEl = document.getElementById('blockWatermark');
if (blockWatermarkEl) {
  // 初始勾选态同步全局
  blockWatermarkEl.checked = blockWatermark;
  blockWatermarkEl.addEventListener('change', () => {
    blockWatermark = blockWatermarkEl.checked;
    const row = document.getElementById('wmBlockRow');
    if (row) row.style.display = blockWatermark ? 'flex' : 'none';
    if (blockWatermark) {
      const inp = document.getElementById('wmHosts');
      if (inp) inp.value = [...blockedHosts].join(',');
    }
    reapplyFilters();
  });
  // 初始展开自定义行（默认开）
  const row0 = document.getElementById('wmBlockRow');
  if (row0) { row0.style.display = 'flex'; const inp0 = document.getElementById('wmHosts'); if (inp0) inp0.value = [...blockedHosts].join(','); }
}
const wmSave = document.getElementById('wmHostsSave');
if (wmSave) wmSave.onclick = () => {
  const inp = document.getElementById('wmHosts');
  const val = (inp && inp.value || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  blockedHosts = new Set(val.length ? val : WATERMARK_HOSTS_DEFAULT);
  saveBlockedHosts();
  reapplyFilters();
  setStatus('已更新水印屏蔽域名：' + [...blockedHosts].length + ' 个');
};

// ===== 页面预览 =====
async function loadPagePreview() {
  setConnection(null, '获取当前页…');
  try {
    const info = await chrome.runtime.sendMessage({ type: 'HMDAO_CAPTURE_PAGE' });
    if (info && info.ok) {
      document.getElementById('previewTitle').textContent = info.title || '(无标题)';
      document.getElementById('previewUrl').textContent = info.url || '';
      const thumbEl = document.getElementById('previewThumb');
      if (info.thumb) {
        thumbEl.src = info.thumb;
        thumbEl.dataset.kind = 'screenshot';
      } else {
        // ★2026-08-24 深层修复（用户实测「切花瓣后顶部预览图仍是抖音画面」根因）：
        //   background 的 captureVisibleTab 在花瓣等受 CSP 限制的页面会被静默 catch 吞掉，
        //   thumb=null → 旧 if (info.thumb) 跳过 → previewThumb.src 保留上一次（抖音）截图 → 红框错位。
        //   修复：thumb 缺失时绝不保留旧截图，必须主动清空 src + 用 og:image / favIcon 兜底显示，
        //   至少让顶部预览图视觉上与当前页面一致，避免「标题是花瓣 / 缩略图是抖音」的割裂。
        thumbEl.removeAttribute('src');
        thumbEl.dataset.kind = 'fallback';
        // 兜底缩略图：优先 og:image（页面 og: 标签里的代表图），其次 favIcon；都没有则显示首字母占位
        const host = (() => { try { return new URL(info.url).hostname; } catch (_) { return ''; } })();
        const fav = info.favIconUrl || (host ? ('https://www.google.com/s2/favicons?sz=64&domain=' + host) : '');
        if (fav) {
          thumbEl.src = fav;
          thumbEl.style.objectFit = 'contain';
          thumbEl.style.background = '#0f1620';
        } else {
          thumbEl.style.display = 'none';
        }
      }
      setConnection(true, '当前页：' + (info.url ? (() => { try { return new URL(info.url).hostname; } catch (_) { return info.url; } })() : ''));
      // 保存当前页 URL 供「打开来源页」使用
      window.__sourcePageUrl = info.url || '';
    } else {
      setConnection(false, '无法获取页面信息');
    }
  } catch (err) { setConnection(false, '连接失败：' + (err.message || err)); }
}

// ===== 右键上下文菜单（抽离至 context-menu.js）=====
// showContextMenu / ctxAsset / ctxMenu 按钮绑定见 context-menu.js

// ===== 网盘深度解析：直接调用网盘官方 Web API 解析出真实文件列表 + 下载直链（免登录）=====
// 关键修复：之前只「打开网盘页读 DOM」，而迅雷分享页必须登录才能看到文件 → 永远要登录。
// 现在改为：优先调后端真实 API（/api/netdisk/resolve，已实现迅雷/夸克免登录直链）；
// 后端离线时由 background 跨域调迅雷官方 API（background fetch 不受 CORS 限制）；
// 解析到的 zip/rar 带 direct 直链，点击下载即 chrome.downloads.download 直连存本地，无需登录。
const XL_CLIENT_ID = 'Xqp0kJBXWhwaTpB6';
const ARCHIVE_RE = /\.(zip|rar|7z|tar|gz|tgz|iso|dmg|z|001|part|tar\.gz)$/i;

function xunleiShareIdOf(u) { const m = String(u || '').match(/\/s\/([A-Za-z0-9_-]+)/); return m ? m[1] : ''; }
function pwdOfUrl(u) { const m = String(u || '').match(/[?&]pwd=([\w]+)/); return m ? m[1] : ''; }
function isArchiveName(n) { return ARCHIVE_RE.test(n || ''); }

function getActiveTabId() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs && tabs[0] && tabs[0].id ? tabs[0].id : null);
    });
  });
}
function registeredDomain(host) {
  try {
    const parts = (host || '').toLowerCase().split('.');
    if (parts.length <= 2) return host;
    return parts.slice(-2).join('.');
  } catch (_) { return host; }
}
async function findNetdiskTabId(assetUrl, preferredTabId) {
  // 优先校验已有 tabId 是否仍有效且同域
  if (preferredTabId) {
    try {
      const tab = await new Promise((res) => chrome.tabs.get(preferredTabId, (t) => res(chrome.runtime.lastError ? null : t)));
      if (tab && tab.url && assetUrl && registeredDomain(new URL(tab.url).hostname) === registeredDomain(new URL(assetUrl).hostname)) {
        return tab.id;
      }
    } catch (_) {}
  }
  // 否则查找同域的打开标签
  return new Promise((resolve) => {
    chrome.tabs.query({}, (tabs) => {
      try {
        const targetHost = registeredDomain(new URL(assetUrl).hostname);
        const found = (tabs || []).find((t) => t.url && registeredDomain(new URL(t.url).hostname) === targetHost);
        resolve(found ? found.id : null);
      } catch (_) { resolve(null); }
    });
  });
}

// 轻量探测本地后端是否在运行（不阻塞主流程，失败即视为离线）
async function isBackendUp() {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 1500);
    const base = await getCloudApiBase();
    const r = await fetch(base + '/api/extension/license/status', { method: 'GET', credentials: 'omit', signal: ctrl });
    clearTimeout(to);
    return r.ok || r.status < 500;
  } catch (_) {
    return false;
  }
}

// 后端真实 API 解析（返回 { ok, files:[{name,size,direct}] }）
async function resolveViaBackend(url) {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 5000);
    const base = await getCloudApiBase();
    const r = await fetch(base + '/api/netdisk/resolve', {
      method: 'POST',
      credentials: 'omit',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    clearTimeout(to);
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    if (j && j.ok && Array.isArray(j.files) && j.files.length) return j.files;
  } catch (_) {}
  return null;
}

// 前端回退：让 background 在后台打开网盘分享页，自动填码并读取文件列表（复用浏览器会话）。
// 这比直接伪造 captcha 调用官方 API 更稳定，且能区分「未登录」和「分享无效」。
async function resolveViaBackground(url) {
  // ★ 2026-08-09 修复：支持迅雷自己网盘页 pan.xunlei.com/?path=...
  const isXunleiMyDrive = /pan\.xunlei\.com\?.*\bpath=/i.test(url);
  if (!/pan\.(xunlei|quark)\.(com|cn)\/s\//.test(url) && !isXunleiMyDrive) return null;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'HMDAO_NETDISK_RESOLVE', url });
    if (!res || !res.ok) {
      // 把 requireLogin 等标记透传出去，让上层给出明确提示
      if (res && res.requireLogin) res._requireLogin = true;
      return res;
    }
    // ★ 2026-08-08：文件夹分享被迅雷 captcha 拦，纯前端无法展开子内容
    if (res.needManualExpand) {
      res._needManualExpand = true;
      return res;
    }
    const tree = Array.isArray(res.tree) ? res.tree : [];
    if (!tree.length) return null;
    return tree.map((t) => ({
      name: t.name || '',
      size: t.size || '',
      isDir: !!t.isDir,
      isArchive: isArchiveName(t.name || ''),
      direct: t.url || t.direct || '',
      fileId: t.fileId || '',
    }));
  } catch (_) {}
  return null;
}

async function netdiskResolve(a) {
  if (!a || a.type !== 'netdisk') return;
  setStatus('步骤1/3：尝试本地 Ddayup 后端解析…');
  let files = null;
  let src = 'backend';
  let resolveError = '';
  const backendUp = await isBackendUp().catch(() => false);
  if (backendUp) {
    files = await resolveViaBackend(a.url);
  } else {
    setStatus('本地后端未运行，使用浏览器代理直接解析（无需启动后端）…');
  }
  if (!files) {
    if (backendUp) setStatus('步骤2/3：本地后端不可用，尝试后台标签页解析…');
    else setStatus('步骤2/3：浏览器代理解析中…');
    src = 'background';
    files = await resolveViaBackground(a.url);
    // 透传登录提示，但不再直接放弃：继续尝试步骤3读取已打开的登录页 MAIN 捕获
    // （router.js 可能因新建标签未登录而误判，当前用户已打开的分享页本身可能已登录）
    if (files && files._requireLogin) {
      setStatus('后台解析提示：' + (files.note || '需登录网盘账号；继续尝试读取当前已打开页面…'));
      files = null;
    }
    if (files && files._needManualExpand) {
      setStatus('⚠ ' + (files.hint || '该分享为文件夹，迅雷对其子内容强制验证码。请先在网页端点击进入该文件夹，待文件列表出现后，再点本面板的「解析」按钮。'), true);
      return;
    }
  }

  // 后端/background 直调 API 都失败后，尝试读取页面自身已发出的 API 响应（MAIN 世界捕获）
  // 迅雷分享页在浏览器内已加载文件列表，其 fetch/XHR 响应被 model-api-capture.js 捕获。
  if (!files || !files.length) {
    setStatus('步骤3/3：尝试读取页面已捕获的网盘数据…');
    const isMyDrivePage = /pan\.xunlei\.com\?.*\bpath=/i.test(a.url || '');
    const pageTabId = await findNetdiskTabId(a.url, a.tabId);
    if (!pageTabId) {
      setStatus('找不到对应的网盘标签页，请保持分享页打开后再点深度解析。', true);
      return;
    }
    try {
      console.log('[HMDAO][netdiskResolve] page-capture tabId=', pageTabId, 'asset.url=', a.url);
      // 先触发 DOM 滚动扫描（迅雷虚拟滚动可能只渲染部分文件行）
      try {
        await chrome.scripting.executeScript({
          target: { tabId: pageTabId },
          world: 'MAIN',
          func: () => { if (typeof window.__hmdao_xunlei_scan_dom === 'function') return window.__hmdao_xunlei_scan_dom(); return null; },
        });
        await new Promise((r) => setTimeout(r, 800));
      } catch (e) { /* 忽略 */ }
      const [capRes] = await chrome.scripting.executeScript({
        target: { tabId: pageTabId },
        world: 'MAIN',
        func: (isMyDrive) => {
          if (isMyDrive) {
            const md = window.__hmdao_captures && window.__hmdao_captures.xunleiMyDrive;
            return { md: md || null, isMyDrive: true };
          }
          const xs = window.__hmdao_captures && window.__hmdao_captures.xunleiShare;
          return { xs: xs || null, isMyDrive: false };
        },
        args: [isMyDrivePage],
      });
      let xs = capRes && capRes.result && capRes.result.xs;
      let md = capRes && capRes.result && capRes.result.md;
      console.log('[HMDAO][netdiskResolve] page-capture xs=', xs ? { listLen: xs.list && xs.list.length, shareId: xs.shareId } : null, 'md=', md ? { listLen: md.list && md.list.length, space: md.space } : null);
      // 自己网盘页优先用 md；分享页用 xs
      let active = isMyDrivePage ? (md || xs) : (xs || md);
      // 如果 list 太少（<=1）可能是虚拟滚动未加载或 BFS 未展开，再触发一次 DOM 扫描并等待
      for (let retry = 0; retry < 3 && active && active.list && active.list.length <= 1; retry++) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: pageTabId },
            world: 'MAIN',
            func: () => { if (typeof window.__hmdao_xunlei_scan_dom === 'function') return window.__hmdao_xunlei_scan_dom(); return null; },
          });
          await new Promise((r) => setTimeout(r, 1200));
          const [capResRetry] = await chrome.scripting.executeScript({
            target: { tabId: pageTabId },
            world: 'MAIN',
            func: (isMyDrive) => {
              if (isMyDrive) return window.__hmdao_captures && window.__hmdao_captures.xunleiMyDrive;
              return window.__hmdao_captures && window.__hmdao_captures.xunleiShare;
            },
            args: [isMyDrivePage],
          });
          active = capResRetry && capResRetry.result;
          console.log('[HMDAO][netdiskResolve] retry scan', retry + 1, 'listLen=', active && active.list && active.list.length);
        } catch (e) { /* 忽略 */ }
      }
      if (active && active.list && active.list.length) {
          // 对所有非目录文件批量触发 file_info / download_url 拿直链（复用页面鉴权上下文）。
          const fileIds = active.list.filter((f) => !f.isDir && f.id).map((f) => f.id).filter(Boolean);
          if (fileIds.length) {
            const [resolveRes] = await chrome.scripting.executeScript({
              target: { tabId: pageTabId },
              world: 'MAIN',
              func: (ids, isMyDrive) => {
                if (isMyDrive) {
                  if (window.__hmdao_xunlei_resolve_mydrive_files) return window.__hmdao_xunlei_resolve_mydrive_files(ids);
                  return { ok: false, error: 'mydrive-resolver-not-ready' };
                }
                if (window.__hmdao_xunlei_resolve_files) return window.__hmdao_xunlei_resolve_files(ids);
                return { ok: false, error: 'resolver-not-ready' };
              },
              args: [fileIds, isMyDrivePage],
            });
            console.log('[HMDAO][netdiskResolve] resolve_files result=', resolveRes && resolveRes.result);
            if (resolveRes && resolveRes.result && resolveRes.result.error) {
              resolveError = resolveRes.result.error;
            }
            if (resolveRes && resolveRes.result && !resolveRes.result.ok) {
              resolveError = resolveRes.result.error || 'file_info 调用失败';
            }
            // 保存详细诊断供 hasDirect 分支使用
            if (resolveRes && resolveRes.result && resolveRes.result.details) {
              a.__xunleiDetails = resolveRes.result.details;
            }
          }
        // 重新读取一次，确保拿到刚触发得到的 direct
        const [capRes2] = await chrome.scripting.executeScript({
          target: { tabId: pageTabId },
          world: 'MAIN',
          func: (isMyDrive) => {
            if (isMyDrive) return window.__hmdao_captures && window.__hmdao_captures.xunleiMyDrive;
            return window.__hmdao_captures && window.__hmdao_captures.xunleiShare;
          },
          args: [isMyDrivePage],
        });
        const active2 = capRes2 && capRes2.result;
        if (active2 && active2.list && active2.list.length) {
          // ★ 职责分离：网盘路径只列出「可下载文件」（压缩包/文档等），按是否有直链做不同 UI。
          const mapped = active2.list.map((f) => {
            let direct = '';
            if (f.medias && f.medias.length) direct = f.medias[0].url || '';
            if (!direct && active2.fileInfo && active2.fileInfo[f.id]) direct = active2.fileInfo[f.id].direct || '';
            return { name: f.name, size: f.size, isDir: f.isDir, id: f.id || '', fileId: f.id || '', isArchive: /\.(zip|rar|7z|tar|gz|tgz|iso|dmg|z|001|part|tar\.gz)$/i.test(f.name || ''), direct };
          });
          files = mapped.filter((f) => f.isArchive || f.direct);
          src = 'page-capture';
        }
      } else {
        setStatus('未在页面捕获到网盘文件列表，请先确认文件列表已加载，或尝试刷新页面后重扫。', true);
        return;
      }
    } catch (e) {
      console.warn('[HMDAO][netdiskResolve] page-capture failed:', e && e.message);
      setStatus('页面读取失败：' + (e && e.message) + '（请刷新网盘页后重试）', true);
      return;
    }
  }

  if (!files || !files.length) {
    // 平台要求登录/滑块 → 诚实告知
    setStatus('该分享需登录或在网盘页手动获取（平台风控，扩展无法绕过登录）', true);
    return;
  }

  const hasDirect = files.some((f) => f.direct && f.direct.startsWith('http'));

  // 无论是否拿到直链，都展示文件树并把文件添加为侧栏 asset。
  // 无直链时用户仍能看到全部文件，点击单个文件下载会触发网盘页内下载按钮捕获真实直链。
  a.tree = files;
  a.resolved = true;
  renderPreviewNetdisk(a);

  if (!hasDirect) {
    // ★ 关键诊断：区分 bridge 失败 / file_info 失败 / 分享本身无直链 / 需登录
    if (resolveError === 'bridge-invalidated') {
      setStatus('扩展上下文已失效（扩展被重载/更新）。请刷新当前迅雷分享页（F5），再点「深度解析」。', true);
      return;
    }
    // 列出每个 file_id 的 file_info 返回状态，帮助定位是 401/403/404/空 medias
    let detailText = '';
    const details = a && a.__xunleiDetails;
    if (details && Object.keys(details).length) {
      detailText = Object.entries(details).map(([fid, d]) => {
        const short = String(fid).slice(-8);
        if (d.status === 0) return `id...${short}: bridge失败(${d.error})`;
        if (d.status === 200 && !d.error) return `id...${short}: 200但无直链`;
        return `id...${short}: HTTP${d.status} ${d.error || ''}`.trim();
      }).join('；');
    }
    let diag = `已列出 ${files.length} 个文件，但暂无直链。`;
    if (detailText) diag += ' file_info详情：' + detailText + '。';
    if (resolveError) diag += ' file_info 调用失败：' + resolveError + '。';
    diag += ' 原因：迅雷分享态接口已不再返回可下载直链（实测 file_info 400 / download_url 404）。唯一可靠方式：在迅雷网页版该分享页手动点击文件右侧的「下载」按钮，扩展会自动捕获真实直链，之后此面板会自动重试。';
    setStatus(diag, true);
    // 在文件树上方插一个醒目的引导按钮：直接打开迅雷分享页，引导用户去点下载
    showManualClickGuide(a.url);
  } // ★ 闭合 if (!hasDirect)

  const currentTab = await new Promise((res) => chrome.tabs.query({ active: true, currentWindow: true }, (t) => res(t && t[0])));
  const tabId = currentTab ? currentTab.id : null;
  const existingKeys = new Set((assets || []).map((x) => (x.url || '') + '|' + (x.name || '')));
  let added = 0;
  for (const item of files) {
    if (item.isDir) continue; // 目录暂不递归展开
    const isArchive = item.isArchive || isArchiveName(item.name);
    // 用直链（或带文件名的锚点）作为资产 URL，确保唯一且可下载
    const assetUrl = item.direct || (a.url + '#hmdao-file=' + encodeURIComponent(item.name));
    const key = assetUrl + '|' + (item.name || '');
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);
    assets.push({
      url: assetUrl,
      type: isArchive ? 'archive' : 'netdisk-file',
      source: 'netdisk-resolve',
      name: item.name,
      size: item.size,
      direct: item.direct || '',
      fileId: item.fileId || item.id || '',
      parentUrl: a.url,
      isNetdiskFile: true,
      netdiskPlatform: 'xunlei',
    });
    added++;
  }
  // 持久化到 lastScan
  chrome.storage.local.get('lastScan', (s) => {
    const ls = (s && s.lastScan) || { tabId, assets: [], ts: Date.now() };
    if (tabId != null) ls.tabId = tabId;
    const existing = new Set((ls.assets || []).map((x) => x.url));
    for (const asset of assets) {
      if (existing.has(asset.url)) continue;
      existing.add(asset.url);
      ls.assets.push(asset);
    }
    ls.ts = Date.now();
    if (currentSourceUrl) ls.url = currentSourceUrl;
    chrome.storage.local.set({ lastScan: ls });
  });
  if (added) render();
  const withLink = files.filter((f) => f.direct).length;
  setStatus('「' + hostOf(a.url) + '」已解析 ' + files.length + ' 项（' + withLink + ' 条带直链），新增 ' + added + ' 个文件；带直链的 zip/rar 点下载即存本地（无需登录）');
}

// ★ 深度解析无直链时，引导用户去迅雷网页版手动点「下载」触发被动捕获（2026-08-08）。
// 迅雷分享态接口已不再返回可下载直链（file_info 400 / download_url 404），主动请求是死路。
// 唯一可靠路径是用户在网页端真实点下载 → 网络层捕获 download_url 真实直链 → 自动重试。
function showManualClickGuide(shareUrl) {
  const old = document.getElementById('hmdaManualGuideBtn');
  if (old) old.remove();
  const btn = document.createElement('button');
  btn.id = 'hmdaManualGuideBtn';
  btn.textContent = '🌐 打开迅雷分享页，手动点「下载」';
  btn.style.cssText = 'display:block;margin:8px 0 4px;padding:6px 12px;background:#ff7a00;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;width:100%;';
  btn.onclick = () => {
    chrome.tabs.create({ url: shareUrl, active: true });
    setStatus('已在浏览器打开迅雷分享页。请在页面里点击文件右侧的「下载」按钮，扩展会自动捕获真实直链，捕获后此面板会刷新并重试下载。', false);
  };
  const statusEl = document.getElementById('status');
  if (statusEl && statusEl.parentNode) statusEl.parentNode.insertBefore(btn, statusEl.nextSibling);
  else document.body.appendChild(btn);
}
function hostOf(u) { try { return new URL(u).hostname; } catch (_) { return u; } }

// 「自动点击揭示」：点击页面下载/获取按钮，触发接口注入的动态链接后自动重扫
// ★2026-09-12 重写（用户实测：云桥网点了之后跳到另一个素材页，而不是下载路径）：
//   根因见 router.js 的 revealDownloadLinks —— 旧实现对「相关推荐文章标题」误判为下载按钮并 click，
//   导致整个标签页导航走。现在后台只点真正的中转/揭示按钮、绝不点 <a href>，
//   并把解析出的真实网盘入口回传；这里把它们挂到「☁️ 网盘」模块，源页全程不跳转。
const revealBtn = document.getElementById('revealBtn');
if (revealBtn) revealBtn.onclick = async () => {
  setStatus('正在自动点击下载/获取按钮…');
  const res = await chrome.runtime.sendMessage({ type: 'HMDAO_CLICK_REVEAL' });
  if (!res || !res.ok) { setStatus('自动点击失败：' + errStr(res && res.error), true); return; }
  const links = Array.isArray(res.collected) ? res.collected : [];
  let added = 0;
  try {
    if (!Array.isArray(window.assets)) window.assets = [];
    for (const u of links) {
      if (!u || window.assets.some((a) => a && a.url === u)) continue;
      const label = hostOf(u) + ' 下载入口';
      window.assets.push({
        url: u, type: 'netdisk', source: 'reveal',
        name: label, title: label,
        pageUrl: window.__sourcePageUrl || res.sourceUrl || '',
      });
      added++;
    }
    if (added) { window.__hmdaoAssets = window.assets.slice(); render(); }
  } catch (e) { console.warn('[HMDAO][reveal] 入口入库失败:', e && e.message); }
  if (added) {
    setStatus('✅ 已捕获 ' + added + ' 个下载入口，已加入「☁️ 网盘」模块（源页未跳转）');
  } else if (res.navigated) {
    setStatus('⚠ 点击过程中页面发生了跳转，已立即停止后续点击。请回到素材页后重试。', true);
  } else if (res.needLogin) {
    setStatus('⚠ 该资源需登录/购买后才显示下载地址（已点 ' + (res.clicked || 0) + ' 个按钮，源页未跳转）。请登录后重试。', true);
  } else {
    setStatus('已点 ' + (res.clicked || 0) + ' 个按钮，未发现可直接捕获的下载入口；正在重扫…');
  }
};

// ===== 信息流批量采集开关 + 批量采集按钮（★2026-08-22）=====
const batchToggle = document.getElementById('batchCollectEnabled');
const batchBar = document.getElementById('batchCollectBar');
const batchModeSel = document.getElementById('batchCollectMode');
const batchBtn = document.getElementById('batchCollectBtn');
function applyBatchUI() {
  // 修复（2026-08-22）：侧栏【始终】显示批量采集控制条（含开关），让用户随时发现入口；
  // 仅「模式选择 + 按钮」在启用后才可见。避免「找不到开关」的 UX 死路。
  if (batchBar) batchBar.style.display = 'flex';
  if (batchToggle) batchToggle.checked = batchCollectEnabled;
  // 模式选择 + 按钮 仅在开关 ON 时显示
  const modeGroup = document.getElementById('batchCollectModeGroup');
  if (modeGroup) modeGroup.style.display = batchCollectEnabled ? 'flex' : 'none';
  if (batchBtn) batchBtn.style.display = (batchCollectEnabled && batchModeSel && batchModeSel.value === 'custom') ? '' : 'none';
  // 关闭态的友好提示文字
  const hint = document.getElementById('batchCollectHint');
  if (hint) hint.textContent = batchCollectEnabled ? '' : '（开启后可批量勾选卡片采集）';
  // 开关态变化：重渲染卡片（显示/隐藏多选框）+ 注入/清除源页 batchMode
  if (typeof render === 'function') render();
  setBatchModeOnSource(batchCollectEnabled);
}
if (batchToggle) {
  batchToggle.checked = batchCollectEnabled;
  batchToggle.addEventListener('change', () => {
    batchCollectEnabled = !!batchToggle.checked;
    try { localStorage.setItem('batchCollectEnabled', batchCollectEnabled ? '1' : '0'); } catch (_) {}
    if (!batchCollectEnabled) {
      batchSelection.clear(); // 关闭时清空勾选，避免残留
      // ★2026-08-23 修复（"未开启却出现信息流素材"根因）：批量容器是持久独立存储，关闭开关后
      //   残留的旧批量素材仍会被并入 window.assets 展示 → 面板上出现"未开启批量却有的信息流素材"且多条闪烁。
      //   关闭开关 = 用户明确不再要批量 → 彻底清空 batchAssets 并从展示列表移除批量副本。
      if (Array.isArray(batchAssets)) batchAssets.length = 0;
      if (Array.isArray(window.assets)) window.assets = window.assets.filter((a) => !(a && a.__batch));
      if (Array.isArray(window.__hmdaoAssets)) window.__hmdaoAssets = window.__hmdaoAssets.filter((a) => !(a && a.__batch));
      // ★2026-09-12 修复（用户实测：关闭批量后列表清空，但耳机里仍在播视频声音）：
      //   打开抖音视频卡时会 playInSourceTab()（源页 <video> 带声音）+ startDouyinFrameStream；
      //   此前关闭批量只清空 window.assets 并重渲染，【从不关闭仍打开的预览】→ 源页视频继续播放、
      //   帧流不断 → 列表清空了声音却还在。现：只要展示列表被清空，就关掉仍在开的预览
      //   （closePreview 内部会 pauseInSourceTab 停源页 + stopDouyinFrameStream + 停悬停音频）。
      if (typeof closePreview === 'function') { try { closePreview(); } catch (_) {} }
      try { renderNow && renderNow(); } catch (_) {}
    }
    applyBatchUI();
    setStatus(batchCollectEnabled ? '信息流批量采集已开启，正在重新扫描…' : '信息流批量采集已关闭，正在重新扫描…');
    // ★2026-08-22 修复：开关变化后自动重新扫描，让「合集/多视频」立即生效，免去手动再点扫描。
    chrome.runtime.sendMessage({ type: 'HMDAO_SCAN_REQUEST', batchMode: batchCollectEnabled, force: true }).catch(() => {});
    // ★2026-09-11：开启批量即自动采集当前源页合集（B站观察模式常规扫描不出合集，必须走 BATCH_COLLECT）。
    //   关闭时不清空（关闭逻辑已在上方处理），仅开启时触发；custom 模式无勾选会自动跳过。
    if (batchCollectEnabled) doBatchCollect().catch(() => {});
  });
}
if (batchModeSel) {
  batchModeSel.addEventListener('change', () => {
    if (batchBtn) batchBtn.style.display = (batchCollectEnabled && batchModeSel.value === 'custom') ? '' : 'none';
  });
}
// ★2026-09-11：抽出命名函数 doBatchCollect()，供「开启批量开关」自动触发当前页合集采集。
//   B站为观察模式（常规扫描跳过 extractFreshVideoUrl），合集不会随常规扫描出现，必须走 BATCH_COLLECT。
async function doBatchCollect() {
  if (window.HMDaoLicense && !(await window.HMDaoLicense.gate())) return;
  const mode = batchModeSel ? batchModeSel.value : 'currentPage';
    // 自定义模式必须有勾选；合集/当前页模式由源页 RENDER_DATA 决定范围
    const ids = [...batchSelection].filter(Boolean);
    if (mode === 'custom' && ids.length === 0) { setStatus('请先勾选至少一张卡片', true); return; }
    setStatus('正在批量采集（' + mode + (mode === 'custom' ? ' · ' + ids.length + ' 张' : '') + '）…');
    const res = await chrome.runtime.sendMessage({ type: HMDAO_MSG.BATCH_COLLECT, mode, awemeIds: ids });
    if (res && res.ok) {
      const items = res.items || [];
      if (items.length) {
        // ★2026-09-11 范围隔离（用户要求：批量采集只显示当前源页合集，不混入其他平台/其他合集）：
        //   按 collectionId 比对本次采集与已有批量卡——
        //     · 不同合集/不同平台 → 先清空旧批量卡，再并入本次（侧栏只显示当前源页合集）；
        //     · 同合集（仅切集/换分P）→ 保留旧卡、增量更新，符合「批量采集累积不丢」语义。
        let __incColl = '';
        for (const it of items) { if (it && it.collectionId) { __incColl = it.collectionId; break; } }
        if (!__incColl) {
          const __fb = items.find((x) => x && (x.biliVideoId || x.bvid));
          __incColl = __fb ? ('bili-video:' + (__fb.biliVideoId || __fb.bvid)) : '';
        }
        if (__incColl && batchAssets.length) {
          const __oldColl = batchAssets[0].collectionId
            || ('bili-video:' + (batchAssets[0].biliVideoId || batchAssets[0].bvid || ''));
          if (__oldColl && __oldColl !== __incColl) {
            batchAssets.length = 0; // 清空旧合集卡（换合集/换平台），避免混入当前源页
            if (typeof batchSelection !== 'undefined' && batchSelection && batchSelection.clear) batchSelection.clear();
            console.log('[HMDAO][sidepanel] 批量采集换合集：清空旧合集卡', __oldColl, '→', __incColl);
          }
        }
        // ★2026-08-23 修复（问题4 根因）：批量采集资产独立归位 batchAssets，重扫/切 tab 不清空。
        //   图片/音频/文档/模型由 setBatchModeOnSource 已排除（一律不进批量），此处只收视频流。
        const existingKeys = new Set(window.assets.map((x) => x.url).concat(batchAssets.map((x) => x.url)));
        let added = 0;
        for (const it of items) {
          if (existingKeys.has(it.url)) continue;
          existingKeys.add(it.url);
          const batched = Object.assign({}, it, { __batch: true });
          batchAssets.push(batched);
          added++;
        }
        if (added) {
          // 触发卡片重渲染；window.assets = 普通(去批量) + (批量开启时)批量副本
          // ★2026-08-23 深层修复（根因3）：关闭批量开关时绝不把 batchAssets 并入展示列表，
          //   否则关闭后残留批量素材仍泄漏到卡片（"未开批量却显示信息流素材"）。
          const normalOnly = (window.assets || []).filter(a => !(a && a.__batch));
          window.assets = batchCollectEnabled ? normalOnly.concat(batchAssets.slice()) : normalOnly;
          window.__hmdaoAssets = window.assets.slice();
          render();
        }
      }
      setStatus('批量采集完成：' + (res.count || 0) + ' 条已加入列表' + (res.expired ? '（' + res.expired + ' 条流失效需播放激活）' : ''));
    } else {
      setStatus('批量采集失败：' + errStr(res && res.error), true);
    }
}
if (batchBtn) batchBtn.onclick = () => { doBatchCollect().catch(() => {}); };
// 初始化时若开关曾开启，恢复源页 batchMode 注入（侧栏重开不丢态）
if (batchCollectEnabled) setBatchModeOnSource(true);


// ===== 右键上下文菜单按钮绑定（抽离至 context-menu.js）=====

// ===== 3D 模型预览 / 缩略图（渲染器在 model-preview.js，ES module 异步加载）=====
const modelBytesCache = new Map(); // url -> Uint8Array（预览与缩略图共享，避免重复拉取）
const modelThumbCache = new Map(); // url -> dataURL | 'fail'
window.modelThumbCache = modelThumbCache; // 暴露以便调试/自动化测试驱动
// 专有闭源格式：浏览器不存在解析器，无法渲染，只能提示用对应软件打开或转换
const PROPRIETARY_3D_HINT = {
  c4d: 'Cinema 4D', blend: 'Blender', max: '3ds Max', ma: 'Maya', mb: 'Maya',
  skp: 'SketchUp', lwo: 'LightWave', abc: 'Alembic', smd: 'Source SMD',
  wrl: 'VRML', x3d: 'X3D', vrm: 'VRM(需 three-vrm)', usdz: 'USDZ(Apple)',
  ase: 'ASE', dxf: 'AutoCAD DXF', bvh: 'BVH 动捕',
};
const MODEL_EXT_LIST = 'glb|gltf|obj|fbx|stl|usdz|max|blend|ma|mb|c4d|dae|ply|3ds|skp|wrl|x3d|abc|lwo|smd|vrm|ase|dxf|bvh';
// 从 URL/文件名里解析 3D 扩展名（兼容 ?file=robot.fbx&sign=… 这类参数内路径）
function modelExtOf(s) {
  const m = new RegExp('[.](' + MODEL_EXT_LIST + ')([?#&]|$)', 'i').exec(s || '');
  return m ? m[1].toLowerCase() : '';
}
// 等 model-preview.js（type=module，在 sidepanel.js 之后异步执行）就绪
function model3dReady(timeoutMs = 5000) {
  if (window.__hmdaoModel3D) return Promise.resolve(window.__hmdaoModel3D);
  return new Promise((res) => {
    const t = setTimeout(() => res(window.__hmdaoModel3D || null), timeoutMs);
    window.addEventListener('hmdao:model3d-ready', () => { clearTimeout(t); res(window.__hmdaoModel3D); }, { once: true });
  });
}
// 拿模型字节：优先复用拖拽缓存(File) → 后台带 Referer 拉取(HMDAO_FETCH_MEDIA) → 直连 fetch 兜底
async function getModelBytes(a, cap = 30 * 1024 * 1024) {
  // 内联二进制（model-api-capture 按魔数识别的 glb/gltf，绕开跨域/签名失效）
  if (a.inline) {
    try { return b64ToBytes(a.inline); } catch (_) {}
  }
  if (modelBytesCache.has(a.url)) return modelBytesCache.get(a.url);
  let bytes = null;
  const cached = dragFileCache.get(a.url);
  if (cached && cached.file && cached.file.size) bytes = new Uint8Array(await cached.file.arrayBuffer());
  if (!bytes) {
    try {
      const referer = deriveMediaReferer(a.url, window.__sourcePageUrl || '');
      const res = await fetchMediaViaBackground(a.url, referer);
      if (res && res.ok && res.b64) bytes = b64ToBytes(res.b64);
    } catch (_) {}
  }
  if (!bytes) {
    // ★根因修复：侧栏是第三方上下文，跨域 fetch 媒体必须 omit Cookie，
    // 否则触发 Chrome「Third-party cookie will be blocked」警告（Privacy Sandbox）。
    try { const r = await fetch(a.url, { credentials: 'omit', cache: 'no-store' }); if (r.ok) bytes = new Uint8Array(await r.arrayBuffer()); } catch (_) {}
  }
  if (bytes && bytes.byteLength > cap) throw new Error('文件过大(' + Math.round(bytes.byteLength / 1048576) + 'MB)，请直接下载后本地查看');
  if (bytes && bytes.byteLength) { modelBytesCache.set(a.url, bytes); return bytes; }
  return null;
}
// 预览窗：可渲染格式 → Three.js 交互视口；专有格式 → 说明卡
// ★扩展页面 CSP 硬性禁止编译 WebAssembly（Chrome 对 extension_pages 的 wasm-unsafe-eval 也拒），
// DRACO/meshopt 压缩的 glb 无法在面板内解码。兜底：把资产导入 Web App（127.0.0.1:3000，
// 其 Three.js 管线跑在普通 dev-server CSP 下无此限制）并在新标签打开预览。
async function openModelInApp(a) {
  const btn = document.getElementById('pvModelOpenApp');
  if (btn) { btn.disabled = true; btn.textContent = '正在导入 Ddayup…'; }
  try {
    await new Promise((res) => chrome.runtime.sendMessage({ type: 'HMDAO_IMPORT_TO_APP', assets: [a] }, () => res()));
    chrome.tabs.create({ url: apiBaseUrl() });
    setStatus('已导入 Ddayup，正在打开 Web App 预览 3D', true);
  } catch (e) {
    if (btn) { btn.textContent = '在 Ddayup 中预览 3D'; btn.disabled = false; }
    setStatus('打开失败：' + (e.message || e), true);
  }
}

function isWasmCspError(e) {
  const msg = errStr(e) || '';
  return /WebAssembly|CompileError|instantiate|Content Security Policy|wasm/i.test(msg);
}

function isModelType(a) {
  if (!a) return false;
  const t = (a.type || '').toLowerCase();
  if (t === 'model' || t.includes('model')) return true;
  return /\.(glb|gltf|obj|fbx|stl|ply|dae|3ds|blend|max|c4d|usdz|wrl|x3d|abc|lwo|smd|vrm|skp|iges|step|stp)(\?|$|#)/i.test(a.url || '');
}

// ★沙箱 iframe 预览（glb/gltf 走此路）：沙箱页不受 extension_pages 的 WASM 禁制，可跑 DRACO/meshopt。
// 沙箱页通过 postMessage 上报 sandbox-ready / rendered / error。
let modelSandboxReady = false;
let sandboxRenderToken = '';
let pendingSandboxRender = null;

function getModelFrame() {
  const f = document.getElementById('pvModelFrame');
  const expected = chrome.runtime.getURL('sandbox-model.html');
  if (!f.src || !f.src.includes('sandbox-model.html')) f.src = expected;
  return f;
}

function dispatchSandboxRender(p) {
  const frm = document.getElementById('pvModelFrame');
  sandboxRenderToken = Date.now() + '-' + Math.random().toString(36);
  frm.contentWindow.postMessage({ __hmdao: 'render', token: sandboxRenderToken, ext: p.ext, data: p.bytes }, '*');
}

// ★glb/gltf 缩略图走沙箱（扩展页 CSP 禁 WASM，无法解码 DRACO/meshopt 压缩的 glb）。
// 沙箱用独立离屏 renderer 渲染单帧 dataURL，与全屏预览 canvas 隔离、互不抢占。
// 串行队列 + 独立 token，避免与全屏预览（sandboxRenderToken/pendingSandboxRender）冲突。
let sandboxThumbBusy = false;
let sandboxThumbToken = '';
const sandboxThumbQueue = [];
window.sandboxThumbQueue = sandboxThumbQueue; // 暴露以便调试/自动化测试驱动
function queueSandboxThumb(a, card) {
  const ext = a.ext || modelExtOf(a.url);
  if (ext !== 'glb' && ext !== 'gltf') return;
  if (modelThumbCache.get(a.url) === 'fail') return;
  if (modelThumbCache.has(a.url)) { applyModelThumb(card, modelThumbCache.get(a.url)); return; }
  sandboxThumbQueue.push({ a, card, ext });
  pumpSandboxThumbQueue();
}
async function pumpSandboxThumbQueue() {
  if (sandboxThumbBusy) return;
  const item = sandboxThumbQueue.shift();
  if (!item) return;
  sandboxThumbBusy = true;
  try {
    const frm = document.getElementById('pvModelFrame');
    if (!modelSandboxReady || !frm || !frm.contentWindow) {
      // 沙箱未就绪：入队等待（sandbox-ready 后会由 previewModelViaSandbox 触发，
      // 但缩略图也依赖沙箱 → 主动加载 iframe）
      sandboxThumbQueue.unshift(item);
      if (!modelSandboxReady) getModelFrame();
      sandboxThumbBusy = false;
      return;
    }
    // 全屏预览正在进行时，缩略图稍后再试，不抢占 #cv
    if (window.__previewAsset && isModelType(window.__previewAsset) &&
        (document.getElementById('pvModelFrame').style.display !== 'none')) {
      sandboxThumbQueue.unshift(item);
      sandboxThumbBusy = false;
      return;
    }
    const bytes = await getModelBytes(item.a, 12 * 1024 * 1024);
    if (!bytes) { modelThumbCache.set(item.a.url, 'fail'); sandboxThumbBusy = false; if (sandboxThumbQueue.length) pumpSandboxThumbQueue(); return; }
    sandboxThumbToken = Date.now() + '-' + Math.random().toString(36);
    window.__sandboxThumbPending = { token: sandboxThumbToken, url: item.a.url, card: item.card };
    frm.contentWindow.postMessage({ __hmdao: 'thumb', token: sandboxThumbToken, ext: item.ext, data: bytes, size: 128 }, '*');
    // 等待 thumb-ready 回传（消息监听里会继续队列）；兜底超时
    setTimeout(() => {
      if (window.__sandboxThumbPending && window.__sandboxThumbPending.token === sandboxThumbToken) {
        window.__sandboxThumbPending = null;
        modelThumbCache.set(item.a.url, 'fail');
        sandboxThumbBusy = false;
        if (sandboxThumbQueue.length) pumpSandboxThumbQueue();
      }
    }, 15000);
  } catch (_) {
    modelThumbCache.set(item.a.url, 'fail');
    sandboxThumbBusy = false;
    if (sandboxThumbQueue.length) pumpSandboxThumbQueue();
  }
}

function stopModelSandbox() {
  const frm = document.getElementById('pvModelFrame');
  if (frm && frm.style.display !== 'none' && frm.contentWindow) {
    try { frm.contentWindow.postMessage({ __hmdao: 'stop' }, '*'); } catch (_) {}
  }
}

window.addEventListener('message', (ev) => {
  const d = ev.data;
  if (!d || !d.__hmdao) return;
  // 缩略图回传（独立 token，不与全屏预览 token 冲突）
  if (d.__hmdao === 'thumb-ready' || d.__hmdao === 'thumb-fail') {
    const pend = window.__sandboxThumbPending;
    if (!pend || pend.token !== d.token) return;
    window.__sandboxThumbPending = null;
    if (d.__hmdao === 'thumb-ready' && d.url) {
      modelThumbCache.set(pend.url, d.url);
      applyModelThumb(pend.card, d.url);
    } else {
      modelThumbCache.set(pend.url, 'fail');
    }
    sandboxThumbBusy = false;
    if (sandboxThumbQueue.length) pumpSandboxThumbQueue();
    return;
  }
  if (d.__hmdao !== 'sandbox-ready' && d.__hmdao !== 'rendered' && d.__hmdao !== 'error') return;
  if (d.__hmdao === 'sandbox-ready') {
    modelSandboxReady = true;
    if (pendingSandboxRender) { const p = pendingSandboxRender; pendingSandboxRender = null; dispatchSandboxRender(p); }
    if (sandboxThumbQueue.length) pumpSandboxThumbQueue();
    return;
  }
  if (d.token !== sandboxRenderToken) return;
  const st = document.getElementById('pvModelStatus');
  const btn = document.getElementById('pvModelOpenApp');
  if (d.__hmdao === 'rendered') {
    st.textContent = `✅ 拖拽旋转 · 滚轮缩放 · ${Math.round((d.size || 0) / 1024)}KB · ${(d.vertices || 0).toLocaleString()} 顶点`;
  } else if (d.__hmdao === 'error') {
    st.textContent = '⚠️ 沙箱渲染失败：' + (d.message || '') + '。已为你转入 Ddayup（Web App）预览。';
    if (btn) { btn.style.display = ''; btn.disabled = false; btn.textContent = '在 Ddayup 中预览 3D'; btn.onclick = () => openModelInApp(window.__previewAsset); }
  }
});

// glb/gltf 在沙箱 iframe 内渲染（面板内 CSP 禁 WASM，无法在侧栏直接解码）
async function previewModelViaSandbox(a, bytes, ext, st, icon, vp) {
  const frm = document.getElementById('pvModelFrame');
  vp.style.display = 'none';
  frm.style.display = '';
  icon.style.display = 'none';
  st.style.display = '';
  st.textContent = '⏳ 解析渲染中…（沙箱）';
  if (modelSandboxReady) {
    dispatchSandboxRender({ a, bytes, ext });
  } else {
    pendingSandboxRender = { a, bytes, ext };
    getModelFrame(); // 触发加载 → sandbox-ready 后自动渲染
  }
}

async function previewModel3D(a) {
  const vp = document.getElementById('pvModelViewport');
  const st = document.getElementById('pvModelStatus');
  const icon = document.getElementById('pvModelIcon');
  vp.innerHTML = ''; vp.style.display = 'none'; st.style.display = ''; icon.style.display = '';
  const frm0 = document.getElementById('pvModelFrame'); if (frm0) frm0.style.display = 'none';
  const btn0 = document.getElementById('pvModelOpenApp'); if (btn0) btn0.style.display = 'none';
  const ext = a.ext || modelExtOf(a.url) || (fileName(a.url).split('.').pop() || '').toLowerCase();
  const m3 = await model3dReady();
  if (!m3) { st.textContent = '3D 渲染器未就绪（model-preview.js 加载失败）'; return; }
  if (!m3.canRender(ext)) {
    const app = PROPRIETARY_3D_HINT[ext];
    st.textContent = app
      ? `.${ext} 是 ${app} 专有格式，浏览器无法解析渲染；请下载后用 ${app} 打开，或在软件里转换为 glb/obj/fbx 再预览。`
      : `浏览器暂不支持渲染 .${ext || '未知'} 格式，请下载后本地查看。`;
    return;
  }
  st.textContent = '⏳ 正在获取模型字节…';
  try {
    const bytes = await getModelBytes(a);
    // 用户可能已切到别的预览
    if (!window.__previewAsset || window.__previewAsset.url !== a.url) return;
    if (!bytes) {
      if (isModelType(a)) {
        st.textContent = '⚠️ 扩展面板未能取到该 3D 模型字节，已为你转入 Ddayup（Web App）预览。';
        const btn = document.getElementById('pvModelOpenApp');
        if (btn) { btn.style.display = ''; btn.disabled = false; btn.textContent = '在 Ddayup 中预览 3D'; btn.onclick = () => openModelInApp(a); }
      } else {
        st.textContent = '获取模型字节失败（防盗链/跨域），请下载后本地查看';
      }
      return;
    }
    // glb/gltf 含 DRACO/meshopt 压缩，需 WASM 解码 → 走沙箱 iframe（面板内 CSP 禁 WASM）
    if (ext === 'glb' || ext === 'gltf') {
      await previewModelViaSandbox(a, bytes, ext, st, icon, vp);
      return;
    }
    st.textContent = '⏳ 解析渲染中…';
    vp.style.display = '';
    const info = await m3.preview(vp, bytes, ext);
    icon.style.display = 'none';
    st.textContent = `✅ 拖拽旋转 · 滚轮缩放 · ${(bytes.byteLength / 1024).toFixed(0)}KB · ${info.vertices.toLocaleString()} 顶点`;
  } catch (e) {
    vp.style.display = 'none';
    const msg = errStr(e);
    if (isWasmCspError(e) || isModelType(a)) {
      st.style.display = '';
      st.textContent = isWasmCspError(e)
        ? '⚠️ 该 3D 模型用了 DRACO/meshopt 压缩，扩展面板的安全策略禁止编译 WebAssembly，无法面板内解码。'
        : '⚠️ 扩展面板无法渲染该 3D 模型，已为你转入 Ddayup（Web App）预览。';
      const btn = document.getElementById('pvModelOpenApp');
      if (btn) {
        btn.style.display = '';
        btn.disabled = false;
        btn.textContent = '在 Ddayup 中预览 3D';
        btn.onclick = () => openModelInApp(a);
      }
    } else {
      st.textContent = '渲染失败：' + msg;
    }
  }
}
// 归档预览：zip 直接列出内部文件（fflate）；rar/7z 无浏览器解析器
async function previewArchiveEntries(a) {
  const box = document.getElementById('pvArchiveEntries');
  if (!box) return;
  box.style.display = 'none'; box.textContent = '';
  if (!/[.]zip([?#&]|$)/i.test(a.url)) return;
  const m3 = await model3dReady();
  if (!m3) return;
  try {
    const bytes = await getModelBytes(a, 60 * 1024 * 1024);
    if (!bytes) return;
    if (!window.__previewAsset || window.__previewAsset.url !== a.url) return;
    const entries = m3.listZipEntries(bytes);
    if (!entries || !entries.length) return;
    const models = entries.filter((n) => modelExtOf(n));
    box.textContent = `共 ${entries.length} 个文件${models.length ? `（含 ${models.length} 个 3D 模型）` : ''}：\n` +
      entries.slice(0, 100).join('\n') + (entries.length > 100 ? `\n… 其余 ${entries.length - 100} 个` : '');
    box.style.display = '';
  } catch (_) {}
}
// 列表卡片缩略图：离屏渲染一次 → dataURL 缓存 → 卡片显示模型真实样子（串行队列避免 GPU 抢占）
const modelThumbQueue = [];
let modelThumbBusy = false;
function queueModelThumb(a, card) {
  const ext = a.ext || modelExtOf(a.url);
  if (!ext) return;
  const c = modelThumbCache.get(a.url);
  if (c === 'fail') return;
  if (c) { applyModelThumb(card, c); return; }
  // glb/gltf 需 WASM 解码 → 缩略图走沙箱（扩展页 CSP 禁 WASM）；其余格式扩展页直接渲染
  if (ext === 'glb' || ext === 'gltf') { queueSandboxThumb(a, card); return; }
  modelThumbQueue.push({ a, card, ext });
  pumpModelThumbQueue();
}
async function pumpModelThumbQueue() {
  if (modelThumbBusy) return;
  const item = modelThumbQueue.shift();
  if (!item) return;
  modelThumbBusy = true;
  try {
    const m3 = await model3dReady();
    if (m3 && m3.canRender(item.ext) && !modelThumbCache.has(item.a.url)) {
      const bytes = await getModelBytes(item.a, 12 * 1024 * 1024); // 缩略图只处理 ≤12MB，太大留给预览
      if (bytes) {
        const url = await m3.thumbnail(bytes, item.ext, 128);
        modelThumbCache.set(item.a.url, url);
        applyModelThumb(item.card, url);
      } else {
        modelThumbCache.set(item.a.url, 'fail');
      }
    }
  } catch (_) {
    modelThumbCache.set(item.a.url, 'fail');
  }
  modelThumbBusy = false;
  if (modelThumbQueue.length) pumpModelThumbQueue();
}
function applyModelThumb(card, dataUrl) {
  if (!card || !card.isConnected) return;
  const tag = card.querySelector('.tag');
  if (tag) tag.remove();
  const img = document.createElement('img');
  img.src = dataUrl; img.draggable = false;
  img.style.objectFit = 'cover';
  card.insertBefore(img, card.firstChild);
}

// ===== 预览模态窗 =====
let previewIdx = -1;

function openPreview(idx) {
  previewIdx = idx;
  const a = getAsset(idx);
  if (!a) return;

  const ov = document.getElementById('previewOverlay');
  ov.classList.add('open');

  // 隐藏所有内容
  ['previewImg', 'previewVideo', 'previewAudio', 'previewModel', 'previewArchive', 'previewYoutube'].forEach((id) => {
    document.getElementById(id).style.display = 'none';
  });
  // ★2026-08-24 修复：切卡片/关预览时停止抖音实时帧轮询（避免旧定时器继续写已隐藏的 previewImg）
  try { if (typeof stopDouyinFrameStream === 'function') stopDouyinFrameStream(); } catch (_) {}
  document.getElementById('previewYtIframe').removeAttribute('src');
  // 试听按钮默认隐藏，仅音频资产显示
  document.getElementById('pvPlay').style.display = 'none';
  document.getElementById('pvCopyImage').style.display = 'none'; // 仅图片预览显示「复制图片」
  try { const t = document.getElementById('pvToMp3'); if (t) { t.style.display = 'none'; t.onclick = null; } } catch (_) {} // 仅音频预览显示「转 MP3」
  // 停止播放并彻底释放 WebMediaPlayer（removeAttribute('src') 后必须 load() 才能释放解码器）
  const v = document.getElementById('previewVideo'); v.pause(); v.removeAttribute('src'); try { v.load(); } catch (_) {}
  const au = document.getElementById('previewAudio'); au.pause(); au.removeAttribute('src'); try { au.load(); } catch (_) {}
  stopHoverAudio(); // 打开大窗时停掉悬停试听，避免两个音频叠播
  // ★2026-09-04 修复：打开大窗时立即停掉悬停抽帧 video，避免 hover video 与大窗同时出声/占内存。
  try { if (typeof stopHoverVideoFrame === 'function') stopHoverVideoFrame(); } catch (_) {}
  stopModelSandbox(); // 离开 3D 预览时停掉沙箱后台渲染，释放 GPU

  // 各类型预览子视图（渲染逻辑抽离至 preview-render.js，按 type 分发）
  switch (a.type) {
    case 'image': renderPreviewImage(a); break;
    case 'video': renderPreviewVideo(a); break;
    case 'audio': renderPreviewAudio(a); break;
    case 'model': renderPreviewModel(a); break;
    case 'archive': renderPreviewArchive(a); break;
    case 'document': renderPreviewDocument(a); break;
    default: renderPreviewNetdisk(a); break;
  }

  document.getElementById('previewInfo').innerHTML =
    `<span>${escapeHtml(typeLabel(a.type))} · ${escapeHtml(displayName(a))}</span><br>` +
    `<a href="${escapeAttr(a.url)}" target="_blank" title="${escapeAttr(a.url)}">${escapeHtml(truncate(a.url, 60))}</a>` +
    (imgDimensions[a.url] ? `<br><span>${imgDimensions[a.url].w}×${imgDimensions[a.url].h} px</span>` : '');

  // 仅网盘资产显示「深度解析」按钮
  const netResolveBtn = document.getElementById('pvNetResolve');
  if (netResolveBtn) netResolveBtn.style.display = (a.type === 'netdisk') ? 'inline-block' : 'none';

  // ★2026-08-21 修复:抖音合集多集数场景,被点击的非当前播放卡片若后台 fetch 拉不到字节(签名未鉴权),
  //   给出「▶ 切到此集播放」手动按钮(切换源页 ?modal_id= 到该集,等 1.5s 让 inject-main 捕获 dyUrl 后再扫描)。
  //   判定条件:platform='douyin' + awemeId 存在 + 是视频资产 + awemeId 与当前播放 modal_id 不一致。
  const switchBtn = document.getElementById('pvSwitchDouyinEpisode');
  if (switchBtn) {
    const isDouyinVideo = a.type === 'video' && a.platform === 'douyin' && a.awemeId && a.source && a.source !== 'network';
    // ★2026-09-03 修复：判定从「对比 modal_id」改为「对比当前正在播放的那集」(window.__hmdao_curAwemeId) 或 a.notPlayed。
    //   旧逻辑 20 张卡全判为非当前 → 当前集反而没按钮；现只有非当前集才显示「▶ 切到此集播放」。
    const curPlaying = (typeof window.__hmdao_curAwemeId === 'string') ? window.__hmdao_curAwemeId : '';
    const needDouyinSwitch = isDouyinVideo && a.awemeId && (a.notPlayed === true || (curPlaying && String(curPlaying) !== String(a.awemeId)));
    // ★2026-09-11：B站合集对等逻辑——非当前播放的 B站批量卡显示「切到该集播放」。
    const isBiliVideo = a.type === 'video' && a.source === 'bilibili-batch' && a.url;
    const needBiliSwitch = isBiliVideo && a.url && !biliSameEpisode(a.url, window.__sourcePageUrl || '');
    const needSwitch = needDouyinSwitch || needBiliSwitch;
    switchBtn.style.display = needSwitch ? 'inline-block' : 'none';
    if (needDouyinSwitch) {
      switchBtn.textContent = '▶ 切到此集播放';
      switchBtn.onclick = () => switchDouyinEpisodeTo(a.awemeId);
      const pi = document.getElementById('previewInfo');
      if (pi) {
        pi.innerHTML = `<span>⚠ 该集未在浏览器播放过，直链未缓存</span><br>` +
          `<span>点「▶ 切到此集播放」让源页跳到该集并捕获真实直链后，再双击预览即可正常播放</span>`;
      }
    } else if (needBiliSwitch) {
      switchBtn.textContent = '▶ 切到该集播放';
      switchBtn.onclick = () => switchBiliEpisodeTo(a);
      const pi = document.getElementById('previewInfo');
      if (pi) {
        pi.innerHTML = `<span>⚠ 该集未在源页播放</span><br>` +
          `<span>点「▶ 切到该集播放」让 B站源页跳到该集并捕获直链后，再双击预览即可正常播放</span>`;
      }
    }
  }
  // ★2026-08-23 「在源页播放」按钮默认隐藏，仅抖音分支播放失败时由 showSourcePlayButton 显示
  hideSourcePlayButton();

  // 网盘/归档资产显示「用 Aria2 下载」按钮（适合大文件/直链，多连接加速）
  const aria2Btn = document.getElementById('pvAria2');
  if (aria2Btn) {
    const showAria2 = (a.type === 'netdisk' || a.type === 'archive' || a.isNetdiskFile);
    aria2Btn.style.display = showAria2 ? 'inline-block' : 'none';
    aria2Btn.onclick = () => downloadViaAria2(a);
  }

  // 预览窗按钮指向当前资产
  window.__previewAsset = a;
}
// escapeAttr / truncate 定义见 ui-utils.js（全局单一来源）

// ★2026-09-10 防御：网络层捕获的 video URL 经常 path 末段是「get-url / asset / undefined / 空」
//   （同一视频的多条 CDN 引用、抓取 endpoint、占位 URL 等）。这些不该被当作「同视频的不同
//   分辨率」参与匹配——它们是去重失败的产物而非真实分辨率变体。
const PLACEHOLDER_FILE_NAME_RE = /^(asset|get-url|undefined|null|video|index|blob|untitled|\?.*)$/i;
function isPlaceholderFileName(name) {
  return PLACEHOLDER_FILE_NAME_RE.test(String(name || '').trim());
}

// ===== 视频备选分辨率：显示当前页面同一视频的其他 source URL =====
function buildVideoAltResolutions(current) {
  const altDiv = document.getElementById('pvAltResolutions');
  if (!altDiv) return;
  // ★2026-09-10 修复（"备选分辨率显示 get-url/get-url..."根因）：
  //   旧逻辑用 fileName(av.url) === fileName(current.url) 匹配同视频多分辨率——但网络层累积的
  //   同视频多条 CDN 引用 path 末段都是「get-url」/「asset」/「undefined」等占位符，全被匹配进去，
  //   显示 N 个堆叠重复的同名按钮。修复：① current 占位 → 整段不显示；② related 占位 → 剔除；
  //   ③ 限制最多 6 个（既防止堆叠也避免无关变体挤爆 UI）；④ 改用 stripResolutionTag 比较基础名，
  //   即使 fileName 不同但去掉 _1080p 后基名一致才算"同一视频"。
  const curBase = stripResolutionTag(fileName(current.url));
  if (isPlaceholderFileName(curBase)) { altDiv.style.display = 'none'; return; }
  const related = assets.filter((av) => {
    if (av.type !== 'video' || av.url === current.url) return false;
    if (!(av.source === 'video>source' || current.source === 'video>source')) return false;
    const fn = stripResolutionTag(fileName(av.url));
    if (isPlaceholderFileName(fn)) return false; // 排除占位 URL
    return fn === curBase;
  }).slice(0, 6);
  if (!related.length) { altDiv.style.display = 'none'; return; }

  // ★CSP 修复：不再用 innerHTML 拼内联 onclick（会被 script-src 拦截），改为 DOM 创建 + addEventListener
  altDiv.textContent = '';
  const altTip = document.createElement('div');
  altTip.style.color = '#d29922';
  altTip.textContent = '⬇ 备选分辨率（点击切换源，再点「下载」）：';
  altDiv.appendChild(altTip);
  altDiv.appendChild(document.createElement('br'));
  related.forEach(r => {
    const name = fileName(r.url);
    const resTag = extractResolutionHint(r.url);
    const btn = document.createElement('button');
    btn.textContent = (resTag ? resTag + ' · ' : '') + name;
    btn.addEventListener('click', () => switchPreviewVideo(r.url, name, r.source || ''));
    altDiv.appendChild(btn);
  });
  altDiv.style.display = '';
}

// 从 URL 中猜分辨率（如 _1080p, -720p, 1920x1080 等）
function extractResolutionHint(url) {
  const m = url.match(/[_-](\d{3,4}p)\b/i) || url.match(/(\d{3,4}x\d{3,4})/i) || url.match(/\b(hd|fhd|uhd|4k|2k|8k)\b/i);
  return m ? m[1].toUpperCase() : null;
}

// ★2026-09-02：yt-dlp 抖音 URL 归一化（jingxuan?modal_id=xxx → /video/<aweme_id>）。
//   后端 /api/platform/ytdlp 底层调 yt-dlp，而其抖音 extractor【不支持】精选列表页 + modal 锚点形式，
//   实测报错：ERROR: Unsupported URL: https://www.douyin.com/jingxuan?modal_id=7678346515106106634
//   换成 https://www.douyin.com/video/<id> 后即可被识别（实测报错转为 "Fresh cookies are needed"，
//   说明 URL 已正确解析，cookie 由 &cookies_file= 提供，buildDouyinCookiesFile() 负责）。
//   项目内多处把页面 URL 直接喂给后端（本文件 3629/3904/3906 与 download.js 的 action=download），
//   故统一在此归一化，避免只修一处、其余调用点仍 500。
function normalizeYtdlpDouyinUrl(u) {
  try {
    const pu = new URL(String(u || ''));
    if (/douyin\.com$/i.test(pu.hostname) && !/\/video\//i.test(pu.pathname)) {
      const mid = pu.searchParams.get('modal_id') || pu.searchParams.get('aweme_id');
      if (mid && /^\d+$/.test(mid)) return 'https://www.douyin.com/video/' + mid;
    }
  } catch (_) {}
  return String(u || '');
}

// 把分辨率标记/格式注记转成人话标签：1080P / 720P / 4K / 原画质 等
// 用于下载面板，避免用户看到一堆数字直链或 "format 137" 不知所云。
function humanizeResLabel(raw, opts) {
  opts = opts || {};
  if (!raw) return opts.fallback || '原画质';
  let s = String(raw);
  // 4K / 2160 / UHD
  if (/\b(4k|2160|uhd)\b/i.test(s)) return '4K（2160P）';
  if (/\b(2k|1440|qhd)\b/i.test(s)) return '2K（1440P）';
  if (/\b(8k|4320)\b/i.test(s)) return '8K（4320P）';
  // 数字 + p
  const p = s.match(/(\d{3,4})p/i);
  if (p) {
    const n = parseInt(p[1], 10);
    if (n >= 2160) return '4K（2160P）';
    if (n >= 1440) return '2K（1440P）';
    if (n >= 1080) return '1080P（全高清）';
    if (n >= 720) return '720P（高清）';
    if (n >= 480) return '480P（标清）';
    if (n >= 360) return '360P（流畅）';
    return p[1] + 'P';
  }
  // 宽x高
  const wh = s.match(/(\d{3,4})x(\d{3,4})/i);
  if (wh) {
    const h = parseInt(wh[2], 10);
    if (h >= 2160) return '4K（2160P）';
    if (h >= 1440) return '2K（1440P）';
    if (h >= 1080) return '1080P（全高清）';
    if (h >= 720) return '720P（高清）';
    if (h >= 480) return '480P（标清）';
    return wh[2] + 'P';
  }
  if (/\b(hd|fhd)\b/i.test(s)) return '1080P（全高清）';
  if (/\b(sd)\b/i.test(s)) return '480P（标清）';
  if (/\b(ld)\b/i.test(s)) return '360P（流畅）';
  // yt-dlp 的 format_note / quality_label 如 "1080p60" 已被上面 p 分支命中；
  // 剩下如 "tiny/small" 之类保留原文但加括号说明
  return opts.fallback || s;
}

// 收集同一视频的其它分辨率直链（用于下载面板的分辨率选项）。
// 返回 [{ label, downloadUrl }]，不含 current 自身。无相关源时返回 []。
function collectAltResolutionUrls(current) {
  if (!current || !current.url || !Array.isArray(assets)) return [];
  // ★2026-09-10：与 buildVideoAltResolutions 一致——current 占位、related 占位都剔除；
  //   限制最多 6 个备选，防止下载面板堆叠重复（同视频的多条 CDN 引用导致的「get-url」按钮堆）。
  const base = stripResolutionTag(fileName(current.url));
  if (isPlaceholderFileName(base)) return [];
  const related = assets.filter((av) => {
    if (av.type !== 'video' || av.url === current.url) return false;
    const fn = stripResolutionTag(fileName(av.url));
    if (isPlaceholderFileName(fn)) return false;
    return fn === base;
  }).slice(0, 6);
  return related.map(r => {
    const resTag = extractResolutionHint(r.url) || r.quality || '';
    return { label: (resTag ? resTag + ' · ' : '') + fileName(r.url), downloadUrl: r.url };
  });
}

// 去掉文件名中的分辨率标记（_1080p / -720p / 1920x1080 等），用于同视频多分辨率归并
function stripResolutionTag(name) {
  return (name || '')
    .replace(/[_-]?\d{3,4}p\b/gi, '')
    .replace(/[_-]?\d{3,4}x\d{3,4}/gi, '')
    .replace(/\b(hd|fhd|uhd|4k|2k|8k)\b/gi, '')
    .replace(/_{2,}/g, '_')
    .replace(/[-_]$/g, '');
}

// 切换预览窗里的视频源
window.switchPreviewVideo = function(url, name, source) {
  const v = document.getElementById('previewVideo');
  v.src = url; v.load(); v.play().catch(() => {});
  window.__previewAsset = { url, type: 'video', source };
  document.getElementById('previewInfo').innerHTML =
    `<span>视频 · ${escapeHtml(name)}</span><br><a href="${escapeAttr(url)}" target="_blank" title="${escapeAttr(url)}">${escapeHtml(truncate(url, 60))}</a>`;
};

// ===== YouTube 分辨率选择器 =====
function buildYoutubeFormatSelector(formats) {
  const altDiv = document.getElementById('pvAltResolutions');
  if (!altDiv) return;
  if (!formats || !formats.length) { altDiv.style.display = 'none'; return; }
  // 仅显示有视频的格式，去重分辨率
  const seen = new Set();
  const videoFormats = formats.filter(f => {
    if (!f.has_video || !f.height) return false;
    const key = f.height + (f.has_audio ? '_a' : '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!videoFormats.length) { altDiv.style.display = 'none'; return; }
  // 默认选中含音频的最高分辨率
  const defaultFmt = videoFormats.find(f => f.has_audio) || videoFormats[0];
  window.__ytSelectedFormat = defaultFmt ? defaultFmt.format_id : '';

  // ★CSP 修复：不再用 innerHTML 拼内联 onchange，改为 DOM 创建 + addEventListener
  altDiv.textContent = '';
  const ytTip = document.createElement('div');
  ytTip.style.color = '#d29922';
  ytTip.style.fontSize = '12px';
  ytTip.textContent = '🎬 分辨率（点击切换后重新预览/下载）';
  altDiv.appendChild(ytTip);
  altDiv.appendChild(document.createElement('br'));

  const sel = document.createElement('select');
  sel.id = 'ytFmtSelect';
  sel.style.margin = '4px 0';
  sel.style.padding = '4px';
  sel.style.borderRadius = '6px';
  sel.style.background = '#1a1a2e';
  sel.style.color = '#ccc';
  sel.style.border = '1px solid #444';
  sel.style.fontSize = '12px';
  sel.style.maxWidth = '100%';
  sel.addEventListener('change', (e) => { window.__ytSelectedFormat = e.target.value; });
  videoFormats.forEach(f => {
    const opt = document.createElement('option');
    opt.value = f.format_id;
    // 下载会合并音视频，无音轨条目不再标负面标记（避免误以为选了就没声音）
    const label = f.height + 'p' + (f.fps ? ` ${f.fps}fps` : '') + (f.has_audio ? ' 🔊' : '');
    opt.textContent = label + (f.filesize_mb ? ' (' + f.filesize_mb + 'MB)' : '');
    if (f.format_id === window.__ytSelectedFormat) opt.selected = true;
    sel.appendChild(opt);
  });
  altDiv.appendChild(sel);

  const hasDirect = formats.some(f => /^(direct-|d-)/i.test(f.format_id || ''));
  if (hasDirect) {
    const note = document.createElement('div');
    note.style.color = '#7fd1ff';
    note.style.fontSize = '11px';
    note.style.marginTop = '4px';
    note.textContent = '⏱ 源页直链分辨率（已绕过后端）。直链有时效，建议下载后立即保存。';
    altDiv.appendChild(note);
  }
  altDiv.style.display = '';
  window.__ytFormats = formats;
}

// 抖音分辨率选择器（从 RENDER_DATA 提取的多质量/编码版本）
function buildDyFormatSelector(formats) {
  const altDiv = document.getElementById('pvAltResolutions');
  if (!altDiv || !formats || !formats.length) return;
  const defaultFmt = formats.find(f => f.is_default) || formats[0];
  window.__dySelectedFormat = defaultFmt ? defaultFmt.url : '';

  // ★CSP 修复：不再用 innerHTML 拼内联 onchange，改为 DOM 创建 + addEventListener
  altDiv.textContent = '';
  const dyTip = document.createElement('div');
  dyTip.style.color = '#d29922';
  dyTip.style.fontSize = '12px';
  dyTip.textContent = '🎬 抖音画质（来自页面数据）';
  altDiv.appendChild(dyTip);
  altDiv.appendChild(document.createElement('br'));

  const sel = document.createElement('select');
  sel.id = 'dyFmtSelect';
  sel.style.margin = '4px 0';
  sel.style.padding = '4px';
  sel.style.borderRadius = '6px';
  sel.style.background = '#1a1a2e';
  sel.style.color = '#ccc';
  sel.style.border = '1px solid #444';
  sel.style.fontSize = '12px';
  sel.style.maxWidth = '100%';
  sel.addEventListener('change', (e) => {
    const s = e.target;
    const v = document.getElementById('previewVideo');
    if (s && s.value) {
      window.__dySelectedFormat = s.value;
      if (window.__previewAsset) { window.__previewAsset.url = s.value; }
      setStatus('▶ 已切换抖音画质直链（源页侧栏帧预览不受影响，源页按此直链播放）', true);
    }
  });
  formats.forEach(f => {
    const opt = document.createElement('option');
    opt.value = f.url;
    opt.setAttribute('data-label', f.label || '');
    opt.textContent = f.label;
    if (f.url === window.__dySelectedFormat) opt.selected = true;
    sel.appendChild(opt);
  });
  altDiv.appendChild(sel);
  altDiv.style.display = '';
  window.__dyFormats = formats;
}

// ── 视频下载面板（双击视频→点下载→弹出，选分辨率后下载）─────────────
// 统一入口：普通直链视频、嵌入平台（YT/B站/抖音/generic）均可从面板选择分辨率。
async function openDownloadPanel(a) {
  const panel = document.getElementById('downloadPanel');
  const list = document.getElementById('dlResolutionList');
  const info = document.getElementById('dlInfo');
  const loading = document.getElementById('dlLoading');
  if (!panel || !list || !a) return;
  // 网盘资产统一走 downloadSingle，不弹视频分辨率面板（避免把网盘分享页当视频直链）。
  if (a.type === 'netdisk' || a.type === 'archive' || a.isNetdiskFile) {
    downloadSingle(a);
    return;
  }
  // ★豆包朗读（WS 流式音频，伪 URL 无直链）：不弹分辨率面板、不请求 yt-dlp formats
  //   （此前会因 isEmbedPlatform 判定去解析豆包会话页 → 后端 500 + 弹出"选择分辨率"）。
  if (a.wsAudio || (a.type === 'audio' && !/^https?:/i.test(a.url || ''))) {
    downloadSingle(a);
    return;
  }
  window.__dlSelected = null;
  // ★2026-08-30：每次开面板重置分辨率缓存，避免上个视频的档位串到下一个视频
  //   （尤其 B站前端枚举的 __biliFrontendFormats / __biliAudioUrl 必须清，否则会拿旧视频的音轨去合并）。
  window.__ytFormats = null;
  window.__dyFormats = null;
  window.__biliFrontendFormats = false;
  window.__biliAudioUrl = '';
  info.textContent = (a.title || a.fileName || a.url || '').toString().slice(0, 120);
  list.innerHTML = '';
  loading.style.display = '';
  panel.classList.add('open');
  await populateDownloadResolutions(a);
}

// 收集分辨率选项：
//   { label, downloadUrl? , formatId? }
//   - downloadUrl 存在：具体直链源（用于 downloadSingle opts.downloadUrl）
//   - formatId 存在：yt-dlp 格式（用于 downloadViaYtDlp formatId 参数）
async function populateDownloadResolutions(a) {
  const list = document.getElementById('dlResolutionList');
  const loading = document.getElementById('dlLoading');
  let options = [];

  try {
    // 来源1：嵌入平台 → 优先用已加载过的 formats，否则触发 ytdlp/页面接口拉取
    let embedTried = false;
    if (isEmbedPlatformAsset(a)) {
      embedTried = true;
      // ★2026-08-18 抖音优化（C）：抖音扫描时已用 RENDER_DATA 解析出 a.dyFormats 多质量直链，
      // 下载面板直接用它们，不调后端 yt-dlp（抖音 extractor 需登录 Cookie 且 spawn onefile 弹窗）。
      const hasDyFormats = a.dyFormats && a.dyFormats.length;
      if (hasDyFormats) window.__dyFormats = a.dyFormats;
      // ★2026-08-30 B站优化：优先用【纯前端 WBI】枚举所有分辨率（HMDAO_BILI_LIST_QUALITIES）。
      //   不依赖后端 127.0.0.1:3000 / yt-dlp——此前后端未启动或 500 时 B站选不了清晰度（只能"原画质"）。
      //   前端一次调 playurl?fnval=16 拿 dash.video[]（4K/1080P/720P… 全部轨）+ 1080P 整段含音画 durl。
      const isBiliAsset = a.platform === 'bilibili'
        || /bilibili\.com/i.test(a.url || '')
        || /bilibili\.com/i.test(a.playerUrl || '')
        || /bilibili\.com/i.test(window.__sourcePageUrl || '');
      if (isBiliAsset && !window.__ytFormats && !window.__dyFormats) {
        try {
          const tab0 = await chrome.tabs.query({ active: true, currentWindow: true });
          const r = await Promise.race([
            chrome.runtime.sendMessage({
              type: (typeof HMDAO_MSG !== 'undefined' && HMDAO_MSG.BILI_LIST_QUALITIES) || 'HMDAO_BILI_LIST_QUALITIES',
              tabId: tab0 && tab0[0] && tab0[0].id,
            }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
          ]);
          if (r && r.ok && Array.isArray(r.formats) && r.formats.length) {
            window.__ytFormats = r.formats;
            window.__biliAudioUrl = r.audioUrl || '';
            window.__biliFrontendFormats = true; // 标记：本次 formats 来自前端，下载时按 isDash 走不同通道
            if (r.title && !a.title) a.title = r.title;
            console.log('[HMDAO][bili] ✅ 前端枚举成功，清晰度 ' + r.formats.length + ' 档：',
              r.formats.map((f) => f.label + (f.isDash ? '(DASH)' : '(整段)')).join(' / '));
          } else {
            // ★诊断：枚举失败时明确提示（此前静默 → 用户以为"没反应"）
            console.warn('[HMDAO][bili] ⚠ 前端枚举失败：', (r && r.error) || '无返回', '→ 将回退后端 yt-dlp');
            setStatus('⚠ B站清晰度前端解析失败（' + ((r && r.error) || '未知') + '），回退后端 yt-dlp…', true);
          }
        } catch (e) {
          console.warn('[HMDAO][bili] ⚠ 前端枚举异常：', e && e.message);
          setStatus('⚠ B站清晰度解析超时/异常，回退后端 yt-dlp…', true);
        }
      }
      if (!window.__ytFormats && !window.__dyFormats) {
        // ★2026-08-30：B站走 fetchPlatformFormats 会调后端 yt-dlp（实测 500）→ 面板打开时立刻 500 报错。
        //   B站已有 WBI 直连（HMDAO_BILI_LIST_QUALITIES），若失败也只显示兜底 "原画质" 直链，不走后端。
        //   故 B站跳过 fetchPlatformFormats。
        const isBiliAsset2 = /bilibili\.com/i.test(a.url || '') || /bilibili\.com/i.test(window.__sourcePageUrl || '');
        if (!isBiliAsset2) {
          try {
            await Promise.race([
              fetchPlatformFormats(a),
              new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
            ]);
          } catch (_) {}
        }
      }
    }
    // ★2026-09-01 修复（分辨率兜底恒失败根因）：
    //   旧逻辑调 HMDAO_FETCH_AWEME_INFO，其底层是 iesdouyin.com/web/api/v2/aweme/iteminfo/
    //   ——该接口已于 2023 年被抖音下线，永远返回 404 → 本兜底【恒失败】，还白等 6s 超时。
    //   改为：直接读源页 inject-main 已建立的 dyFormatsByAweme 索引（扫描阶段已完成，
    //   无需任何网络请求，更快且不会失败于已下线的接口）。拿不到再回退 yt-dlp。
    if ((a.platform === 'douyin' || /douyin|bytedance|tiktok/i.test(a.url || '')) && !window.__dyFormats && !window.__ytFormats) {
      const aid = a.awemeId || (a.playerUrl ? (new URL(a.playerUrl, 'https://www.douyin.com/').searchParams.get('modal_id') || '') : '');
      if (aid) {
        try {
          // 优先资产自带源页 tabId，其次当前激活标签
          let tid = (typeof a.tabId === 'number') ? a.tabId : null;
          if (tid == null) {
            const tab0 = await chrome.tabs.query({ active: true, currentWindow: true });
            tid = tab0 && tab0[0] && tab0[0].id;
          }
          if (tid != null) {
            const [res] = await Promise.race([
              chrome.scripting.executeScript({
                target: { tabId: tid }, world: 'MAIN',
                // ★2026-09-02：读取前先调一次 SSR 补扫，避免「扫描时填充 / 下载时已被重置」导致空读。
                //   实测：注入脚本在 SPA 路由变化时 delete __hmdao_captures 并重建（约 inject-main.js:93），
                //   扫一次管一阵，下一次面板打开时可能又被冲掉。补扫函数本身幂等且同步，立即重建索引。
                func: (id) => {
                  try { if (typeof window.__hmdaoScanDyRenderData === 'function') window.__hmdaoScanDyRenderData(); } catch (_) {}
                  try {
                    const c = window.__hmdao_captures || {};
                    const m = c.dyFormatsByAweme || {};
                    const f = m[String(id)] || null;
                    return Array.isArray(f) ? f : null;
                  } catch (_) { return null; }
                },
                args: [String(aid)],
              }),
              new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
            ]);
            const fmts = res && res.result;
            if (Array.isArray(fmts) && fmts.length) window.__dyFormats = fmts;
          }
        } catch (_) {}
      }
      // 回退：仍无 formats 则用 yt-dlp 拉多分辨率
      if (!window.__dyFormats && !window.__ytFormats) {
        try {
          await Promise.race([
            fetchPlatformFormats(a),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
          ]);
        } catch (_) {}
      }
    }
    // 兜底：资产自带平台字段不足（网络层被动捕获的裸流没带 ytPageUrl/biliVideoId 等）
    // 导致上面没拉到 formats，但【当前实际加载的网站】就是视频平台播放页 →
    // 用当前源页 URL 再尝试一次（纯被动读取，不注入任何脚本/请求到网站，不干扰其播放）。
    if (embedTried && !window.__ytFormats && !window.__dyFormats) {
      const src = window.__sourcePageUrl || '';
      if (src && /youtube\.com|youtu\.be|bilibili\.com|youku\.com|v\.qq\.com|iqiyi\.com|ixigua\.com|sohu\.com|tudou\.com|douyin\.com|iesdouyin\.com|tiktok\.com|xinpianchang\.com|kuaishou\.com|acfun\.cn|haokan\.baidu\.com|m\.haokan/i.test(src)) {
        try {
          await Promise.race([
            fetchPlatformFormats({ url: src, source: src }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
          ]);
        } catch (_) {}
      }
    }
    if (window.__ytFormats && window.__ytFormats.length) {
      // 按分辨率降序排列，让人话标签（4K/1080P/720P…）一目了然
      const sorted = [...window.__ytFormats].sort((x, y) => (y.height || 0) - (x.height || 0));
      // ★2026-08-31：B站前端枚举时已为每个 qn 并发请求 durl（fnval=1），
      //   故每个分辨率都自带"对应 qn 的整段含音画 MP4"直链（hasAudio=true），
      //   chrome.downloads 直连 durl 即可 100% 成功——不依赖 yt-dlp 后端、不需 SW 合并。
      //   拿不到 durl 的 qn（通常需大会员）降级为 DASH 视频轨（hasAudio=false），由上层走 yt-dlp 兜底。
      options = options.concat(sorted.map((f) => ({
        label: humanizeResLabel(
          // ★2026-08-30：B站前端 formats 用官方清晰度名（f.label，如「4K 超清」）；yt-dlp 用 quality_label
          f.label || f.quality_label || f.format_note || (f.height ? f.height + 'p' : ''),
          { fallback: '原画质' }
        )
          // 标签准确描述：命中 durl 走 chrome.downloads 直连（含音画、必成功）；
          // 降级 DASH 视频轨走 yt-dlp 兜底（可能失败，需要登录/大会员）。
          + (f.hasAudio === false && f.isDash ? ' 🎬仅视频轨（需登录/大会员，否则可能失败）' : (f.hasAudio ? ' 🔊含音画 · 单文件直下最快' : ''))
          + (f.ext ? ' · ' + f.ext : '')
          + (f.filesize_mb ? ' · ' + f.filesize_mb + 'MB' : '')
          + (f.width && f.height ? ' · ' + f.width + '×' + f.height : ''),
        // ★2026-08-23 P4：源页直链兜底格式（direct-*）带真实 url，下载时直接走字节下载，绕过 yt-dlp。
        formatId: /^(direct-|d-)/i.test(f.format_id || '') ? '' : (f.format_id || ''),
        // ★2026-08-30：B站前端 formats 每条都带 url（isDash 区分"整段含音画" vs "视频轨需合并"）
        downloadUrl: /^(direct-|d-)/i.test(f.format_id || '') ? (f.url || '') : (f.url || f.downloadUrl || ''),
        isDash: !!f.isDash,
      })));
    }
    if (window.__dyFormats && window.__dyFormats.length) {
      options = options.concat(window.__dyFormats.map(f => ({
        label: humanizeResLabel(f.label || '', { fallback: '抖音源' }),
        downloadUrl: f.url,
        note: f.is_default ? '默认画质' : '',
      })));
    }

    // 来源1.5：扫描阶段已聚合的替代 URL（爱给多分辨率等），优先使用带 quality 标注的版本
    if (!options.length && Array.isArray(a.altUrls) && a.altUrls.length) {
      options = options.concat(a.altUrls.map(o => ({
        label: humanizeResLabel(o.quality || extractResolutionHint(o.url) || '', { fallback: '备选画质' }),
        downloadUrl: o.url,
        note: o.source || '',
      })));
    }

    // 来源2：普通直链 → 同文件名（去分辨率标记）的其它视频源（多分辨率直链收录）
    if (!options.length && a.url && a.url.startsWith('http')) {
      try {
        const alt = collectAltResolutionUrls(a);
        if (alt.length) {
          options = options.concat(alt.map(o => ({
            label: humanizeResLabel(o.label, { fallback: '原画质' }),
            downloadUrl: o.downloadUrl,
          })));
        }
      } catch (_) {}
    }

    // 兜底：当前直链作为「原画质」（嵌入平台也保留平台直链，保证总有可下载项）
    if (!options.length) {
      // 嵌入平台（B站/YouTube 等）的直链是防盗链签名地址，作为 downloadUrl 必 403 失效，
      // 故不带 downloadUrl，让 confirmDownload 走 downloadSingle 的 WBI/yt-dlp 路径重新抓取整段 MP4。
      if (isEmbedPlatformAsset(a)) {
        options.push({ label: '原画质（需经后端重新抓取，点击下载）', downloadUrl: '', note: a.source || '' });
      } else {
        // 爱给视频：提示用户在源页切换画质后重扫，即可捕获 4K/1080P/720P 多分辨率
        const aigeiHint = (a.source === 'aigei') ? ' · 在源页切 4K/1080P/720P 后点重扫可捕获多分辨率' : '';
        options.push({ label: '原画质（平台直链）' + aigeiHint, downloadUrl: a.url, note: a.source || '' });
      }
    }

    // ★2026-08-02 借鉴 seekin.ai：对 yt-dlp 支持平台（含抖音/新片场/B站/YouTube）追加「仅音频 MP3」提取选项，
    // 让用户可单独下载 MP3（如背景音乐、演讲录音），与视频分辨率并列选择。
    // 重要区分：此选项专为「视频资产」做音轨分离，绝不能对已是 type:'audio' 的独立音效素材出现
    // （音效素材走 downloadSingle→downloadViaBrowser 直采，无需、也不该「再从视频提取音频」）。
    if (a.type !== 'audio' && isYtDlpPlatform(a)) {
      options.push({ label: '🎵 仅音频（MP3）', formatId: 'audio', note: '提取音轨' });
    }

    // 嵌入平台但后端/yt-dlp 不可用 → 仍保留平台直链「原画质」可下载，并加友好提示去安装，
    // 而不是平铺一串数字直链或完全无选项。
    if (embedTried && !window.__ytFormats && !window.__dyFormats) {
      const st = await checkYtDlp().catch(() => 'unreachable');
      if (st === 'missing') {
        options.push({
          label: '⚠ 想选 1080P/720P/4K？需先安装 yt-dlp',
          downloadUrl: '',
          isYtDlpHint: true,
        });
      } else if (st === 'unreachable') {
        options.push({
          label: '⚠ 想选多分辨率？需打开 Ddayup Web App（127.0.0.1:3000）',
          downloadUrl: '',
          isYtDlpHint: true,
        });
      }
    }
  } catch (e) {
    // 不要静默吞异常：曾因此把 ReferenceError 吞成「只剩原画质直链 → 点下载没反应」
    console.error('[Ddayup] populateDownloadResolutions 失败:', e);
    options = options.length ? options : [{ label: '原画质（当前直链）', downloadUrl: a.url }];
  }

  loading.style.display = 'none';
  // 去重（同一分辨率可能来自多来源）
  const seen = new Set();
  options = options.filter((o) => {
    const k = (o.label || '') + '|' + (o.formatId || '') + '|' + (o.downloadUrl || '');
    if (seen.has(k)) return false; seen.add(k); return true;
  });
  list.innerHTML = options.map((o, i) => {
    if (o.isYtDlpHint) {
      return `<div style="padding:10px 12px;border:1px solid #e0b341;border-radius:8px;background:rgba(224,179,65,0.12);font-size:12px;color:#caa12e;line-height:1.5">
        ${o.label}<br>
        <button class="dlYtDlpInstall" style="margin-top:6px;padding:5px 12px;border:0;border-radius:6px;background:#3b82f6;color:#fff;cursor:pointer;font-size:12px">前往「模型下载」安装 yt-dlp</button>
      </div>`;
    }
    const data = JSON.stringify({ downloadUrl: o.downloadUrl || '', formatId: o.formatId || '' }).replace(/"/g, '&quot;');
    const sel = i === 0 ? ' checked' : '';
    const note = o.note ? `<span style="color:#6e7681;font-size:11px;margin-left:6px">· ${escapeHtml(o.note)}</span>` : '';
    return `<label style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid #30363d;border-radius:8px;background:#161b22;cursor:pointer;font-size:13px;color:#e6edf3">
      <input type="radio" name="dlRes" value="${i}" data-opt="${data}"${sel}> ${o.label}${note}
    </label>`;
  }).join('');
  // 绑定 yt-dlp 安装按钮
  const yb = list.querySelector('.dlYtDlpInstall');
  if (yb) yb.addEventListener('click', () => chrome.tabs.create({ url: apiBaseUrl() + '/#models' }));
  window.__dlOptions = options;
  // ★2026-08-30 关键修复（"点下载没反应"）：
  //   此前默认选中【第一项】= 按 height 降序的最高清档位 = 通常是 4K/1080P+ 的 DASH 视频轨。
  //   DASH 轨需 mergeDashToMp4 与音频合并（受 chrome 消息 ~64MB 限制 + 耗时长）→ 用户感知"没反应"。
  //   改为【默认选中整段含音画的 durl 档（isDash===false）】——单文件直下、无大小限制、100% 成功。
  //   用户仍可手动改选更高清的 DASH 档位。
  const preferIdx = (() => {
    const i = options.findIndex((o) => o && o.isDash === false && o.downloadUrl);
    return i >= 0 ? i : 0;
  })();
  const prefRadio = list.querySelector(`input[name="dlRes"][value="${preferIdx}"]`);
  const first = prefRadio || list.querySelector('input[name="dlRes"]');
  if (first) { first.checked = true; window.__dlSelected = options[parseInt(first.value, 10)]; }
  list.querySelectorAll('input[name="dlRes"]').forEach(r => {
    r.addEventListener('change', () => {
      const i = parseInt(r.value, 10);
      window.__dlSelected = window.__dlOptions[i];
    });
  });
}


// ===== DASH 音视频合并（主线程分块拉取 + Web Worker 合并，主线程零阻塞）=====
// ★2026-08-31 关键修正：Worker 内【不能】自己 fetch —— Worker 的 fetch 是普通网页 fetch，
//   受 CORS 限制，而 B站 CDN 不返回 Access-Control-Allow-Origin → 被浏览器拦截 → 合并失败
//   （这正是"选了合并却下载两个文件"的根因：Worker fetch 失败后回退分轨下载）。
// 正确分工：
//   ① 主线程：用 fetchViaBackground 分块拉取（走 background SW，有 host_permissions 授权，
//      不受 CORS 限制；8MB/块，不触及 ~64MB 消息上限）—— 与 fetchTrackChunked 同款逻辑。
//   ② Worker ：只做 CPU 密集的 mp4box 解封装 + mp4-muxer 重封装 → 主线程零阻塞、不卡顿。
// 返回 Blob；抛错时由调用方回退分轨下载。
async function fetchBufferChunked(url, referer, stageLabel) {
  const CHUNK = 8 * 1024 * 1024; // 8MB
  let total = 0;
  try {
    const h = await fetchViaBackground(url, { referer, method: 'HEAD' });
    total = (h && h.contentLength) || 0;
  } catch (_) {}
  if (!total || total <= CHUNK) {
    const r = await fetchViaBackground(url, { referer });
    // ★2026-09-10：sendMessage 会丢弃 ArrayBuffer，优先用 b64 还原（fetchUrl 现已回传 b64）。
    let buf = r && r.arrayBuffer;
    if (!buf && r && r.b64) { try { buf = b64ToBytes(r.b64); } catch (_) { buf = null; } }
    if (!r || !r.ok || !buf) throw new Error(`${stageLabel || '轨道'}拉取失败：` + ((r && (r.error || r.status)) || 'unknown'));
    return buf;
  }
  const chunks = [];
  let offset = 0, guard = 0;
  let lastPct = -1;
  while (offset < total && guard < 4000) {
    guard++;
    const end = Math.min(offset + CHUNK - 1, total - 1);
    const r = await fetchViaBackground(url, { referer, headers: { Range: `bytes=${offset}-${end}` } });
    // ★2026-09-10：sendMessage 丢弃 ArrayBuffer，用 b64 还原分块。
    let buf = r && r.arrayBuffer;
    if (!buf && r && r.b64) { try { buf = b64ToBytes(r.b64); } catch (_) { buf = null; } }
    if (!r || !r.ok || !buf) throw new Error(`${stageLabel || '轨道'}分块失败 @${offset}：` + ((r && (r.error || r.status)) || 'unknown'));
    chunks.push(new Uint8Array(buf));
    offset = end + 1;
    const pct = Math.floor((offset / total) * 100);
    if (pct !== lastPct && pct % 10 === 0) {
      lastPct = pct;
      if (typeof setStatus === 'function') setStatus(`⏳ ${stageLabel || '轨道'}… ${pct}%`);
    }
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  return out.buffer;
}

function mergeDashInWorker(videoBuffer, audioBuffer, onMessage) {
  return new Promise((resolve, reject) => {
    let worker = null;
    let settled = false;
    const cleanup = () => { try { if (worker) worker.terminate(); } catch (_) {} };
    const done = (fn, arg) => { if (settled) return; settled = true; cleanup(); fn(arg); };
    try {
      const workerUrl = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
        ? chrome.runtime.getURL('dash-merge-worker.js')
        : 'dash-merge-worker.js';
      worker = new Worker(workerUrl);
      // 超时保护：10 分钟未完成则终止并报错（避免无限等待）
      const timer = setTimeout(() => done(reject, new Error('合并超时（10 分钟）')), 10 * 60 * 1000);
      worker.onmessage = (e) => {
        const m = e.data || {};
        if (typeof onMessage === 'function') { try { onMessage(m); } catch (_) {} }
        if (m.type === 'done') {
          clearTimeout(timer);
          const buf = m.buffer;
          if (!buf) { done(reject, new Error('Worker 未返回合并数据')); return; }
          done(resolve, new Blob([buf], { type: 'video/mp4' }));
        } else if (m.type === 'error') {
          clearTimeout(timer);
          done(reject, new Error(m.error || 'Worker 合并失败'));
        }
      };
      worker.onerror = (err) => {
        clearTimeout(timer);
        // ★Chrome Worker onerror 时 err.message 经常为空，需看 err.error / filename / lineno
        const detail = err && (err.message || err.error || `${err.filename || ''}:${err.lineno || ''}`);
        console.error('[HMDAO][merge] Worker 错误（详细）:', err);
        done(reject, new Error('Worker 加载/执行失败：' + (detail || '未知（请查看 console 完整 err 对象）')));
      };
      console.log('[HMDAO][merge] 发送 buffer 到 Worker（Transferable）…');
      // 传 buffer（Transferable 零拷贝），Worker 不再自己 fetch
      worker.postMessage(
        { type: 'merge', videoBuffer, audioBuffer },
        [videoBuffer, audioBuffer]
      );
    } catch (e) {
      done(reject, e);
    }
  });
}

// ★2026-08-30 修复（致命 SyntaxError）：此前本函数内用了 await 但未声明 async
//   → 解析期抛 "await is only valid in async functions" → sidepanel.js 整个文件不执行
//   → 侧栏 UI 全挂（下载面板/预览/列表全部失效）。现改为 async function。
async function confirmDownload() {
  const a = getPreviewAsset();
  const panel = document.getElementById('downloadPanel');
  const sel = window.__dlSelected;
  if (!a) { closeDownloadPanel(); return; }
  if (!sel) { setStatus('请选择分辨率', true); return; }
  // ★ 点击后立即给「进行中」视觉反馈：禁用按钮 + 文案变化，避免用户以为没反应
  const btn = document.getElementById('dlConfirm');
  if (btn) { btn.disabled = true; btn.dataset.old = btn.textContent; btn.textContent = '⏳ 下载中…'; }
  const restore = () => { if (btn) { btn.disabled = false; btn.textContent = btn.dataset.old || '下载'; } };
  setStatus('⏳ 正在合并下载（视视频大小需数秒到数十秒），请在浏览器下载栏查看');
  // 嵌入平台资产（B站/YouTube 等）：
  //   ① 选了具体 format_id → 走 yt-dlp 指定格式下载（多分辨率生效）；
  //   ② 未选 format_id（如 yt-dlp 不可用、只有平台直链兜底项）→ 直接 downloadSingle，
  //      它会按 B站走 WBI refreshThenDownload 重新抓整段 MP4，或 YouTube 走带 Cookie 后台拉取，
  //      绝不直接拿 bilivideo 防盗链直链（过期即 403 → 点下载没反应）。
  if (isEmbedPlatformAsset(a)) {
    // ★2026-08-30：B站「纯前端多分辨率」通道（window.__biliFrontendFormats）。
    //   formats 由 HMDAO_BILI_LIST_QUALITIES 前端 WBI 枚举得到，不经后端 yt-dlp：
    //   ① sel.isDash===false → 整段 MP4（含音画），直接按 downloadUrl 下载；
    //   ② sel.isDash===true  → DASH 视频轨（无音），先用 mergeDashToMp4 与 audioUrl 合并为单文件再下载。
    if (window.__biliFrontendFormats && sel.downloadUrl) {
      // ★2026-08-30 关键修复（"下载没成功/没反应"真凶）：
      //   此前 isDash=false 的 durl 走 downloadSingle → 其内部把含 bilivideo 的 URL 判为 cdnVideo
      //   → 一律走 downloadVideoViaBackground（后台拉字节 + b64 回传侧栏）。
      //   但 chrome.runtime.sendMessage 单条消息约 64MB 上限，大文件 b64 回传必失败 → 静默卡死。
      //   而 background.js 已实测「B站 durl 直链可无 Referer 被 chrome.downloads 完整下载」——
      //   故 durl（整段含音画）必须走【浏览器原生下载】：不经消息回传、无大小限制、100% 成功。
      if (!sel.isDash) {
        const fname = 'Ddayup/videos/' + (deriveFilename(a) || 'video.mp4');
        console.log('[HMDAO][dl] B站 durl 源页 fetch 下载 →', sel.downloadUrl.slice(0, 120), '| filename=', fname);
        // ★2026-08-31 修复（"B站 durl confirmDownload FILE_FAILED"真凶最终闭环）：
        //   之前多轮 chrome.downloads 直连 B站 durl 全失败（dNR 失效 / headers 不被支持 / CDN 拒绝），
        //   根因：chrome-extension 来源请求带不上 B站会话 Cookie → bilivideo CDN 403 → FILE_FAILED。
        //   修复：B站 durl 改走 downloadBiliDurlViaPageFetch（download.js）—— 源页 MAIN 世界
        //   credentials:'include' + unsafe-url referrerPolicy 自动带会话 Cookie + Referer → CDN 放行。
        //   （与 refreshThenDownload 路径 line 599-612 + downloadWithPageFetch 同一最稳路径。）
        try {
          await downloadBiliDurlViaPageFetch(sel.downloadUrl, a);
          setStatus('✅ 已开始下载：' + (sel.label || '整段含音画') + '（浏览器下载栏查看）');
        } catch (e) {
          console.warn('[HMDAO][dl] durl 源页 fetch 失败：', e && e.message);
          setStatus('⚠ 下载失败：' + (e && e.message || e) + '。请在 B站页面刷新后再试（durl 签名可能已过期）', true);
        } finally {
          // ★无论成功失败都关闭面板 + 恢复按钮（之前漏写 → 用户卡在 ⏳ + 关不掉）
          restore();
          closeDownloadPanel();
        }
        return;
      }
      // ★2026-08-31（满足"选合并音频就要真合并" + 严格遵守"不得卡顿"边界）：
      //   合并改由【Web Worker】(dash-merge-worker.js) 执行——mp4box 解封装 + mp4-muxer 重封装
      //   全部在 Worker 线程，主线程（侧栏 UI 与源页面）零阻塞：既真合并成一个含音画文件，
      //   又不会冻结界面 / 不影响源页面视频播放（严格遵守边界要求）。
      //   Worker 内直接用 fetch 拉字节（不经 sendMessage → 无 ~64MB 上限，任意大小）；
      //   Referer 由 dNR 在网络层注入，对 Worker 的 fetch 同样生效。
      const baseName = (deriveFilename(a).replace(/\.[^.]+$/i, '') || 'video');
      // ★2026-08-31 落实方案（低分辨率也失败的真正根因）：
      //   此前 B站 DASH 走【前端 SW 合并】，有 3 个对所有分辨率一视同仁的致命坑，所以 720P(AVC) 也失败：
      //     (1) MERGE_CHUNK 用 50MB ArrayBuffer 经 sendMessage 回传 → MV3 下 ArrayBuffer 跨消息会被丢弃成空对象
      //         （音频/视频 blob 下载当初就是因此改用 base64 才修好的，合并却忘了）；
      //     (2) SW fetch 拉 B站 DASH m4s 依赖 referrer 选项，防盗链不稳 → grab 抛错直接分轨；
      //     (3) muxerVideoCodec 把 AV1/VP9 误判为 avc → 若选到 AV1 档必崩。
      //   改用【yt-dlp 后端】(action=download) 原生合并：支持全部编码 + 不分块回传（后端落盘返回 fileUrl，
      //   前端再 fetch 字节→blob→<a download>），绕开上述全部前端坑。用户已确认 yt-dlp 后端可用。
      {
        const biliPage = (a && (a.biliPageUrl || a.playerUrl || a.url)) || window.__sourcePageUrl || '';
        const h = (() => {
          if (/4k|2160/i.test(sel.label || '')) return 2160;
          const m = String(sel.label || '').match(/(\d{3,4})\s*[PpKk]/);
          return m ? parseInt(m[1], 10) : 1080;
        })();
        const ytFmt = 'bv[height<=?' + h + ']+ba/best';
        try {
          setStatus('⏳ 正在用后端 yt-dlp 合并下载（支持所有编码 / 4K 含音画单文件）…');
          await downloadViaYtDlp(a, biliPage, ytFmt, false, true);
          restore(); closeDownloadPanel();
          return;
        } catch (ytErr) {
          console.warn('[HMDAO][dl] yt-dlp 合并失败：', ytErr && ytErr.message);
          setStatus('⚠ yt-dlp 合并失败（' + ((ytErr && ytErr.message) || ytErr) + '）。改用后端 ffmpeg 合并…', true);
          // ★2026-09-02 新增一层保障（不再一失败就退化成两个分轨文件）：
          //   yt-dlp 依赖运行时，未安装/解析失败/需登录态都很常见；而后端 ffmpeg 合并只要求
          //   后端在线 + 本机 ffmpeg：不挑编码、任意大小、浏览器零内存占用，产物还经后端
          //   ffprobe 自检保证含音画（/api/media/merge-dash，已端到端验证 5/5 + G 组全绿）。
          if (window.__biliAudioUrl && typeof mergeDashViaBackend === 'function') {
            try {
              const merged = await mergeDashViaBackend(
                a,
                { video: sel.downloadUrl, audio: window.__biliAudioUrl, referer: 'https://www.bilibili.com/' },
                baseName,
                'https://www.bilibili.com/',
              );
              if (merged) { restore(); closeDownloadPanel(); return; }
            } catch (mergeErr) {
              console.warn('[HMDAO][dl] 后端 ffmpeg 合并失败：', mergeErr && mergeErr.message);
              setStatus('⚠ 后端 ffmpeg 合并也失败（' + ((mergeErr && mergeErr.message) || mergeErr) + '），回退分轨直连…', true);
            }
          }
          // 两条后端合并都失败 → 回退分轨直连兜底（至少拿到视频+音频两个文件；
          // 不再走「前端 SW 合并」——Service Worker 无 WebCodecs，EncodedVideoChunk 必崩，
          // 且 MERGE_CHUNK 的 50MB ArrayBuffer 经 sendMessage 回传会被丢弃成空对象）。
          try {
            const vh = (() => { try { return new URL(sel.downloadUrl).hostname; } catch (_) { return ''; } })();
            if (vh) {
              await Promise.race([
                chrome.runtime.sendMessage({ type: 'HMDAO_INSTALL_REFERER_RULE', domain: vh, referer: 'https://www.bilibili.com/' }),
                new Promise((r) => setTimeout(r, 3000)),
              ]).catch(() => {});
            }
            await dlViaChrome({ url: sel.downloadUrl, filename: 'Ddayup/videos/' + baseName + '_video.mp4', saveAs: false, conflictAction: 'uniquify' });
            if (window.__biliAudioUrl) {
              await dlViaChrome({ url: window.__biliAudioUrl, filename: 'Ddayup/videos/' + baseName + '_audio.m4a', saveAs: false, conflictAction: 'uniquify' });
            }
            setStatus('✅ 已回退分轨下载（视频+音频两文件，未合并）。合并：ffmpeg -i "' + baseName + '_video.mp4" -i "' + baseName + '_audio.m4a" -c copy "' + baseName + '.mp4"', true);
            restore(); closeDownloadPanel();
            return;
          } catch (e2) {
            setStatus('⚠ 分轨下载也失败：' + ((e2 && e2.message) || e2) + '。请改用后端 yt-dlp 合并', true);
            restore(); closeDownloadPanel();
            return;
          }
        }
      }
    }
    // ★2026-09-03 修复（真机问题：面板选分辨率下载卡“下载中” + 没实际下载）：
    //   抖音等嵌入平台资产在面板里选了具体分辨率直链（sel.downloadUrl）时，
    //   必须把该 URL 传给 downloadSingle。否则确认下载只走默认 a.url / window.__dySelectedFormat，
    //   既可能忽略用户选的 1080P，又可能命中旧 mergeDashViaBackend 路径导致 UI 卡住且无失败提示。
    if (sel.downloadUrl) {
      console.log('[HMDAO][dl] 面板选中分辨率下载：label=', sel.label, 'url=', sel.downloadUrl.slice(0, 120));
      downloadSingle(a, { downloadUrl: sel.downloadUrl })
        .catch((e) => {
          console.error('[HMDAO][dl] 面板选中分辨率下载失败：', e);
          setStatus('⚠ 下载失败：' + (e && e.message || e), true);
        })
        .finally(restore);
      closeDownloadPanel();
      return;
    }
    if (sel.formatId) {
      downloadViaYtDlp(a, window.__sourcePageUrl || '', sel.formatId).finally(restore);
    } else {
      downloadSingle(a).finally(restore);
    }
    closeDownloadPanel();
    return;
  }
  if (sel.formatId) {
    // 嵌入平台 → 走 yt-dlp 指定格式
    downloadViaYtDlp(a, window.__sourcePageUrl || '', sel.formatId).finally(restore);
  } else if (sel.downloadUrl) {
    downloadSingle(a, { downloadUrl: sel.downloadUrl }).finally(restore);
  } else {
    downloadSingle(a).finally(restore);
  }
  closeDownloadPanel();
}

// ★ 监听浏览器下载进度/完成事件：本扩展触发的 Ddayup/ 前缀下载实时显示进度卡片，
//   解决「点击下载后不知道是否完成/进行中」以及「并发下载互相覆盖」的体验问题。
//   ★2026-08-11 改造：按 chrome downloadId 精确命中任务卡（HmdaoProgress.progressByDownloadId），
//   不再依赖单全局占位；interrupted 时把 delta.error 映射为中文失败原因展示给用户。
// ★2026-08-31 修复（"侧栏不显示实时下载进度"真凶闭环）：
//   chrome.downloads.onChanged 必须在 background service worker 注册（MV3 下侧栏 page 注册
//   在很多 Chrome 版本收不到事件）。background.js 现已转发 HMDAO_DL_ONCHANGED 到所有扩展上下文。
//   侧栏抽 handleDownloadChanged 函数统一处理两路通道：
//     通道 A：chrome.downloads.onChanged 直接监听（部分 Chrome 版本生效，保留兜底）
//     通道 B：chrome.runtime.onMessage 接收 HMDAO_DL_ONCHANGED（MV3 推荐路径，必然生效）
function handleDownloadChanged(delta) {
  if (!delta || !window.HmdaoProgress) return;
  const hasId = window.HmdaoProgress.hasDownloadId && window.HmdaoProgress.hasDownloadId(delta.id);
  const isOurs = (delta.filename && /Ddayup/i.test(delta.filename.current || '')) || hasId;
  if (delta.state && delta.state.current === 'in_progress' && isOurs) {
    // 进度更新：bytesReceived / totalBytes 可能不在 delta 里，必要时 search 补全
    const apply = (item) => {
      const received = (delta.bytesReceived && delta.bytesReceived.current != null) ? delta.bytesReceived.current : (item && item.bytesReceived);
      const total = (delta.totalBytes && delta.totalBytes.current != null) ? delta.totalBytes.current : (item && item.totalBytes);
      // 按 downloadId 精确命中任务卡（多任务并发互不覆盖）
      if (!window.HmdaoProgress.progressByDownloadId(delta.id, received || 0, total || 0)) {
        // 兜底：未登记过的下载（如外部触发）也登记一张卡
        const name = (delta.filename && delta.filename.current) || (item && item.filename) || '下载中…';
        const dlId = window.HmdaoProgress.registerTask({ name });
        window.HmdaoProgress.bindDownloadId(dlId, delta.id);
        window.HmdaoProgress.progress(dlId, received || 0, total || 0);
      }
    };
    if ((!delta.bytesReceived || delta.bytesReceived.current == null || !delta.totalBytes || delta.totalBytes.current == null) && chrome.downloads.search) {
      chrome.downloads.search({ id: delta.id }).then((items) => apply(items[0])).catch(() => apply(null));
    } else {
      apply(null);
    }
  }
  if (delta.state && delta.state.current === 'complete' && isOurs) {
    const name = (delta.filename && delta.filename.current || '').split(/[\\/]/).pop();
    // 按 downloadId 精确完成对应任务卡
    if (!window.HmdaoProgress.completeByDownloadId(delta.id, '已保存（浏览器下载文件夹）')) {
      window.HmdaoProgress.finishDownloadProgress('✅ 已保存：' + (name || '文件'), true);
    }
    setStatus('✅ 已保存：' + (name || '文件') + '（浏览器下载文件夹）');
  }
  if (delta.state && delta.state.current === 'interrupted' && isOurs) {
    const name = (delta.filename && delta.filename.current || '').split(/[\\/]/).pop();
    const reason = delta.error && delta.error.current;
    // ★2026-08-25 关键修复（interrupted race condition）：chrome.downloads 在 403/重定向竞态时
    //   可能 state=interrupted 但文件已实际写入完成（用户能看到已下载文件）。需先 search 校验文件
    //   存在性+大小，存在且 >0 视为完成，不标记失败。
    const verifyExists = (cb) => {
      if (!chrome.downloads || !chrome.downloads.search) return cb(false);
      try {
        chrome.downloads.search({ id: delta.id }, (items) => {
          const it = items && items[0];
          if (it && it.exists && (it.totalBytes || 0) > 0 && (it.state === 'complete' || it.state === 'in_progress')) {
            cb(true, it);
          } else {
            cb(false, it);
          }
        });
      } catch (_) { cb(false, null); }
    };
    verifyExists((actuallyDone, it) => {
      if (actuallyDone && it) {
        // 文件实际存在且有大小 → 视为完成
        if (!window.HmdaoProgress.completeByDownloadId(delta.id, '已保存（浏览器下载文件夹）')) {
          window.HmdaoProgress.finishDownloadProgress('✅ 已保存：' + (name || '文件'), true);
        }
        setStatus('✅ 已保存：' + (name || '文件') + '（浏览器下载文件夹）');
        return;
      }
      // 真实失败：按 downloadId 精确失败标记 + 失败原因
      if (!window.HmdaoProgress.failByDownloadId(delta.id, reason)) {
        window.HmdaoProgress.finishDownloadProgress('⚠ 下载中断：' + (name || '文件'), false);
      }
      setStatus('⚠ 下载中断：' + (name || '文件') + (reason ? '（' + reason + '）' : ''), true);
    });
  }
}

if (!window.__hmdaodlWatcher) {
  window.__hmdaodlWatcher = true;
  // 通道 A：直接监听（部分 Chrome 版本生效，作为兜底）
  if (chrome.downloads && chrome.downloads.onChanged) {
    try { chrome.downloads.onChanged.addListener(handleDownloadChanged); } catch (_) {}
  }
  // 通道 B：background 转发（MV3 推荐路径，必然生效）
  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === 'HMDAO_DL_ONCHANGED' && msg.delta) {
        handleDownloadChanged(msg.delta);
      } else if (msg.type === 'HMDAO_DL_ONCREATED' && typeof msg.id === 'number') {
        // 立即把 downloadId 回填到最近一张 pending 任务卡（消除 dlViaChrome 的 bindDownloadId 与 onChanged 竞态）
        if (!window.HmdaoProgress.bindLatestPending(msg.id)) {
          const name = (msg.filename || '下载中…').split(/[\\/]/).pop() || '下载中…';
          const dlId = window.HmdaoProgress.registerTask({ name });
          window.HmdaoProgress.bindDownloadId(dlId, msg.id);
        }
      }
    });
  }
}

function closeDownloadPanel() {
  const panel = document.getElementById('downloadPanel');
  if (panel) panel.classList.remove('open');
  // ★2026-09-03 修复：用户点「取消」或关闭面板时，必须重置「下载中…」按钮状态，
  //   否则下载异常挂起后再打开面板，确认按钮仍显示「下载中…」且不可用。
  const btn = document.getElementById('dlConfirm');
  if (btn) { btn.disabled = false; btn.textContent = btn.dataset.old || '下载'; }
}

document.getElementById('closeDownloadPanel').onclick = closeDownloadPanel;
document.getElementById('dlCancel').onclick = closeDownloadPanel;
document.getElementById('dlConfirm').onclick = confirmDownload;

// ── 测试钩子（仅供自动化 e2e 调用，无副作用）─────────────
// 注：downloadSingle 定义在 download.js（本脚本之后加载），不可在对象字面量立即引用，
// 否则脚本执行期 ReferenceError 中断后续注册。测试若需 spy 直接挂 window.downloadSingle。
window.__hmdaoPanel = {
  openDownloadPanel, closeDownloadPanel, confirmDownload, populateDownloadResolutions,
  hoverVideoFrame, getPreviewAsset, isEmbedPlatformAsset, collectAltResolutionUrls,
  openPreview, // 暴露双击入口，供 e2e 真实模拟「双击视频卡片」交互（零副作用）
  getAsset, // 暴露列表索引读取，供 e2e 校验卡片数据
  setPreviewAsset: (a) => { window.__previewAsset = a; },
  setAssets: (arr) => {
    if (Array.isArray(assets)) {
      assets.length = 0;
      // ★2026-08-18：屏蔽水印来源域名（平台夹杂水印的图床不进列表）
      // ★2026-08-23 整改：封面(cover)字段豁免水印过滤——封面是匹配当前播放视频的关键信息，
      // 抖音封面域 p3-pc-sign.douyinpic.com 是内容封面非水印图床；封面 URL 仅在 a.url 为封面时豁免
      // （封面以 'cover' role 标记于 asset，见 scan.js cover 字段）。若 a 为封面类型则不过滤。
      const filtered = blockWatermark
        ? (arr || []).filter((a) => (a && (a.kind === 'cover' || a.role === 'cover')) ? true : !isBlockedHost(a.url))
        : (arr || []);
      assets.push(...filtered);
    }
  },
  downloadViaAria2, checkAria2,
};

// ★2026-08-11 多任务：进度卡片「取消」按钮事件委托（事件委托，避免每卡单独绑定）。
// 任一进行中任务的 ✕ 按钮 → 调用 HmdaoProgress.cancel（内部调 chrome.downloads.cancel + 标记 cancelled）。
document.addEventListener('click', (e) => {
  const btn = e.target && e.target.closest && e.target.closest('.dlTaskCancel');
  if (btn) {
    const dlId = btn.getAttribute('data-dlid');
    if (dlId && window.HmdaoProgress) {
      window.HmdaoProgress.cancel(dlId);
      setStatus('已取消下载任务', true);
    }
  }
});

// ★2026-09-16 F2：扩展侧栏加载时只做轻量健康探测（纯 fetch 本机 3000 后端），不再 connectNative，
//   避免未装原生主机时报「Access to the specified native messaging host is forbidden」控制台噪音。
//   后端未启动 → 在状态栏与横幅给出明确提示，让用户可点「启动后端」或重新扫描唤醒。
setTimeout(() => {
  checkBackendHealth().then((ok) => {
    if (!ok) {
      setStatus('⚠ Ddayup 后端未启动，点击「启动 Ddayup 后端」或重新扫描可唤醒', true);
      ensureYtDlpPrompt();
      refreshYtDlpNotice();
    }
  }).catch(() => {});
}, 800);

// ★2026-08-17：扩展加载后自动确保 yt-dlp 就绪（朋友机器无 3000 后端也能下视频）。
// 仅当原生主机可用且 yt-dlp 尚未安装时，静默触发 ytdlp.ensure 自动下载（多源回退 + 断点续传）。
// 已装则跳过；原生主机不可用（朋友未跑安装器）则仅提示，不阻断。
setTimeout(() => {
  // ★2026-09-16 F2：仅本机 3000 后端可达才做 yt-dlp 探测/静默安装；否则跳过，
  //   避免后端未启动 + 原生主机未装时仍在加载期 connectNative 触发 forbidden 噪音。
  checkBackendHealth().then((ok) => {
    if (!ok) return;
    return checkYtDlp().then(async (st) => {
    if (st !== 'missing') return; // ready / unreachable 都不动
    // ★2026-09-16 修复（B 同类隐患）：原实现用裸 port.postMessage 且【无超时】，
    //   原生主机不回包时 onMessage 监听器永不移除（泄漏），且用户得不到任何反馈。
    //   现统一走带超时的 ddNativeRpc；本路径是静默自动行为，失败只回退到横幅引导，不打断用户。
    try {
      // ★2026-09-16（审查 重要-4）：与用户点「一键连接」共用单飞 Promise，
      //   否则首屏"静默安装 + 用户点击"两路并发会让 host 侧同写一个 .part 文件而损坏。
      const r = await ensureYtDlpOnce();
      if (r && r.ok && (r.installed || r.success)) { hideYtDlpPrompt(); refreshYtDlpNotice(); }
      else { ensureYtDlpPrompt(); refreshYtDlpNotice(); }
    } catch (_) {
      ensureYtDlpPrompt();
      refreshYtDlpNotice();
    }
  }).catch(() => {});
  });
}, 1500);

// ★2026-08-11 多任务：下载完成自动入库回调。
// 任务卡登记时若关联了素材对象（__currentDownloadAsset → dlViaChrome 的 asset），
// 完成时自动把该素材推送到 Web App 资源库（HMDAO_IMPORT_TO_APP），实现「下载完成即时加入列表」。
// 若 Web App（127.0.0.1:3000）未打开则静默跳过（不影响本地下载结果）。
if (window.HmdaoProgress && window.HmdaoProgress.setOnComplete) {
  window.HmdaoProgress.setOnComplete((dlId, t) => {
    if (t && t.asset) {
      try {
        chrome.runtime.sendMessage({ type: 'HMDAO_IMPORT_TO_APP', assets: [t.asset] }, () => {
          // 忽略 lastError（Web App 未打开时静默）
          void chrome.runtime.lastError;
        });
      } catch (_) {}
    }
  });
}

// ── yt-dlp 依赖检测与提示（方案 A：原生主机优先，Web 后端回退）─────────────
// 通道优先级：
//   1) 原生主机（com.ddayup.host）：用户安装原生主机后，侧栏可直接连本机 yt-dlp，无需 3000 后端在跑。
//   2) Web 后端 /api/health：复用既有 localPostBackends.ytdlp.detectedPath（保留兼容，3000 在跑时可用）。
// 返回三态：'ready'（已就绪）/ 'missing'（可达但 yt-dlp 未安装）/ 'unreachable'（两端都不可达）

// 原生主机常量（与 config.js / nativeClient.js / ddayup-host.js 同源，避免硬编码漂移）
const DD_YTDLP_NATIVE_HOST = 'com.ddayup.host';
let ddNativePort = null;
let ddNativeAvailable = null; // null=未知, true=已连, false=不可用

function ddNativeConnect() {
  if (ddNativePort) return ddNativePort;
  try {
    ddNativePort = chrome.runtime.connectNative(DD_YTDLP_NATIVE_HOST);
  } catch (_) {
    ddNativeAvailable = false;
    ddNativePort = null;
    return null;
  }
  ddNativePort.onDisconnect.addListener(() => {
    // ★2026-09-16 F2：消费 lastError，消除「Access to the specified native messaging host is forbidden」控制台噪音。
    //   connectNative 到未安装/被禁的主机时，错误经 onDisconnect 异步投递；若不读取即报 Unchecked runtime.lastError。
    //   此 handler 对所有 connectNative 路径（含 yt-dlp 原生探测）统一生效。
    void chrome.runtime.lastError;
    ddNativePort = null;
    ddNativeAvailable = false;
  });
  ddNativeAvailable = true;
  return ddNativePort;
}

// 通用原生主机 RPC（请求-响应，带超时 + 断开即拒绝）
function ddNativeRpc(type, payload = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const port = ddNativeConnect();
    if (!port) { ddNativeAvailable = false; return reject(new Error('native_unavailable')); }
    const id = 'dd-native-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    let done = false;
    const cleanup = () => {
      try { port.onMessage.removeListener(onMsg); } catch (_) {}
      try { port.onDisconnect.removeListener(onDisc); } catch (_) {}
      clearTimeout(timer);
    };
    // ★2026-09-16 修复（审查 重要-1）：原生主机中途崩溃/被结束时 onDisconnect 会触发，
    //   但旧实现只把 ddNativePort 置空、不 reject 在飞请求 → 请求要等满 timeoutMs 才失败，
    //   而 ytdlp.ensure 的超时是 180s，用户体感仍是"点了没反应"（只是从"永久"变成"最长 3 分钟"）。
    //   现与 nativeClient.js 的 rpc() 语义对齐：断开立刻以 native_disconnected 拒绝。
    const onDisc = () => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error('native_disconnected'));
    };
    const timer = setTimeout(() => {
      if (!done) { done = true; cleanup(); reject(new Error('native_timeout')); }
    }, timeoutMs);
    const onMsg = (msg) => {
      if (msg && msg.id === id) {
        if (done) return;
        done = true;
        cleanup();
        resolve(msg);
      }
    };
    port.onMessage.addListener(onMsg);
    try { port.onDisconnect.addListener(onDisc); } catch (_) {}
    try { port.postMessage({ id, type, ...payload }); }
    // ★原实现此处只 reject 不摘监听器 → 遗留监听器；现统一走 cleanup()
    catch (e) { if (!done) { done = true; cleanup(); reject(e); } }
  });
}

// 经原生主机查询 yt-dlp 状态（返回 {installed, nativeUnavailable?}）
// ★2026-09-16 修复（审查 次要-4）：原实现手写裸 port.postMessage + 固定 id，并发调用会互相
//   错配应答，且超时分支不摘监听器（每次刷新都遗留一个）。现统一走带超时/断开拒绝的 ddNativeRpc。
async function checkNativeYtDlp() {
  try {
    const msg = await ddNativeRpc('ytdlp.status', {}, 8000);
    const installed = !!(msg && (msg.installed || (msg.ytdlp && msg.ytdlp.installed)));
    return { installed, nativeUnavailable: false };
  } catch (e) {
    return { installed: false, nativeUnavailable: true, reason: String((e && e.message) || e) };
  }
}

// ★2026-08-11：扩展加载时自动检测并启动 Ddayup Web 后端（原生主机托管 Node 进程）
async function getBackendStatusViaNative() {
  try {
    const r = await ddNativeRpc('backend.status', {}, 6000);
    return { ok: !!r.ok, nativeUnavailable: false, ...r };
  } catch (e) {
    return { ok: false, nativeUnavailable: true, error: String(e && e.message || e) };
  }
}

async function startBackendViaNative() {
  try {
    setStatus('⏳ 正在启动 Ddayup 后端…');
    const r = await ddNativeRpc('backend.start', {}, 60000);
    if (r.ok) setStatus('✅ Ddayup 后端已启动：' + (r.started || []).map((s) => `${s.port}(${s.pid})`).join('、'));
    else setStatus('⚠ 后端启动失败：' + (r.error || '未知错误'), true);
    return r;
  } catch (e) {
    const msg = String(e && e.message || e);
    setStatus('⚠ 无法启动后端：' + msg, true);
    return { ok: false, error: msg, nativeUnavailable: msg.includes('native_unavailable') };
  }
}

// ★2026-09-16 F2：轻量后端健康探测（纯 fetch 本机 3000 后端，绝不 connectNative）。
// 用于侧栏加载/扫描时判断「后端是否启动」，避免触达原生主机协议引发 forbidden 噪音。
// 仅查本机 127.0.0.1:3000（与 requireLocal 语义一致，不查云端，避免本地后端未起被云端短路）。
async function checkBackendHealth(timeoutMs = 2000) {
  try {
    const r = await fetch('http://127.0.0.1:3000/api/health', { credentials: 'omit', signal: AbortSignal.timeout(timeoutMs) });
    return !!r.ok;
  } catch (_) {
    return false;
  }
}

async function ensureBackendRunningNative(options = {}) {
  const { silent = false, onStatus, requireLocal = false } = options;
  // ★2026-09-13 F1：requireLocal 模式专为 disk-write 等「本机写盘」调用方——
  // 必须确保「本地后端 127.0.0.1:3000」起来，不能因云端可达就被 /api/health 短路
  // （否则本地后端没起 → ERR_CONNECTION_REFUSED → 提示「后端未启动」）。
  if (requireLocal) {
    // 第一步直接探本机后端，绝不用 getCloudApiBase() 探云端
    try {
      const r = await fetch('http://127.0.0.1:3000/api/health', { credentials: 'omit', signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        const d = await r.json().catch(() => null);
        onStatus?.({ ok: true, via: 'local', data: d });
        if (!silent) refreshYtDlpNotice();
        return { ok: true, via: 'local', data: d };
      }
    } catch (_) { /* 本机后端未起 → 走下方原生主机拉起 */ }
    // 本机健康失败 → 走原生主机拉起逻辑（与非 requireLocal 分支完全一致，仅 via 标 'local'）
    const natStatus = await getBackendStatusViaNative();
    onStatus?.(natStatus);
    if (natStatus.ok) {
      if (!silent) refreshYtDlpNotice();
      return { ok: true, via: 'local', status: natStatus };
    }
    if (natStatus.nativeUnavailable) {
      onStatus?.({ ok: false, nativeUnavailable: true });
      if (!silent) { ensureYtDlpPrompt(); refreshYtDlpNotice(); }
      return { ok: false, nativeUnavailable: true };
    }
    const startRes = await startBackendViaNative();
    onStatus?.({ ok: false, starting: true, startRes });
    if (!startRes.ok) {
      if (!silent) { ensureYtDlpPrompt(); refreshYtDlpNotice(); }
      return { ok: false, startRes };
    }
    for (let i = 0; i < 30; i += 1) {
      await new Promise((r) => setTimeout(r, 800));
      const s = await getBackendStatusViaNative();
      onStatus?.(s);
      if (s.ok) {
        if (!silent) { hideYtDlpPrompt(); refreshYtDlpNotice(); }
        return { ok: true, via: 'local', status: s };
      }
    }
    if (!silent) { ensureYtDlpPrompt(); refreshYtDlpNotice(); }
    return { ok: false, error: '后端启动后健康检查超时' };
  }

  // 先尝试 Web 直连（后端可能已手动启动 / 或云端部署）
  try {
    const apiBase = await getCloudApiBase();
    const r = await fetch(apiBase + '/api/health', { credentials: 'omit', signal: AbortSignal.timeout(2000) });
    if (r.ok) {
      const d = await r.json().catch(() => null);
      onStatus?.({ ok: true, via: 'direct', data: d });
      if (!silent) refreshYtDlpNotice();
      return { ok: true, via: 'direct', data: d };
    }
  } catch (_) {}

  // Web 不可达 → 通过原生主机拉起
  const natStatus = await getBackendStatusViaNative();
  onStatus?.(natStatus);
  if (natStatus.ok) {
    if (!silent) refreshYtDlpNotice();
    return { ok: true, via: 'native', status: natStatus };
  }

  // 原生主机未安装 → 无法自动启动，交给 UI 提示
  if (natStatus.nativeUnavailable) {
    onStatus?.({ ok: false, nativeUnavailable: true });
    if (!silent) { ensureYtDlpPrompt(); refreshYtDlpNotice(); }
    return { ok: false, nativeUnavailable: true };
  }

  // 原生主机已安装但后端未运行 → 自动启动
  const startRes = await startBackendViaNative();
  onStatus?.({ ok: false, starting: true, startRes });
  if (!startRes.ok) {
    if (!silent) { ensureYtDlpPrompt(); refreshYtDlpNotice(); }
    return { ok: false, startRes };
  }

  // 轮询等待后端健康
  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 800));
    const s = await getBackendStatusViaNative();
    onStatus?.(s);
    if (s.ok) {
      if (!silent) { hideYtDlpPrompt(); refreshYtDlpNotice(); }
      return { ok: true, via: 'native', status: s };
    }
  }
  if (!silent) { ensureYtDlpPrompt(); refreshYtDlpNotice(); }
  return { ok: false, error: '后端启动后健康检查超时' };
}

// ★2026-09-16（审查 阻断-1）：新增 autoInstall 开关。
//   渲染横幅（refreshYtDlpNotice）/状态轮询只读探测，绝不触发安装；否则会形成
//   refresh → checkYtDlp → autoInstallYtDlpViaCloud → refresh 的无限请求循环（已实测复现）。
async function checkYtDlp(options = {}) {
  const { autoInstall = true } = options || {};
  // 优先问原生主机（方案 A 主通道）
  const nat = await checkNativeYtDlp().catch(() => ({ installed: false, nativeUnavailable: true }));
  if (nat.nativeUnavailable === false) {
    ddNativeAvailable = true;
    // ★2026-09-16 修复（审查 重要-2）：记录结论来源，供文案区分「本机缺」与「云端缺」。
    //   旧实现只看配置里的 base 是否云端，而默认配置（DEFAULT_API_BASE 就是云端域名）下，
    //   本机通道给出的 missing 会被写成"云端未安装 yt-dlp" —— 但云端其实从未被探测过。
    __ytDlpLastSource = 'native';
    return nat.installed ? 'ready' : 'missing';
  }
  // 回退：Web 后端 /api/health（走云端配置地址）
  async function probeWeb() {
    try {
      const apiBase = await getCloudApiBase();
      const r = await fetch(apiBase + '/api/health', { credentials: 'omit', signal: AbortSignal.timeout(3000) });
      if (!r.ok) return 'unreachable';
      const d = await r.json().catch(() => null);
      const lb = d && (d.capabilities?.localPostBackends || d.localPostBackends);
      if (!lb) return 'unreachable';
      const yt = lb.ytdlp;
      return (yt && yt.detectedPath) ? 'ready' : 'missing';
    } catch (_) {
      return 'unreachable';
    }
  }
  let webSt = await probeWeb();
  // ★2026-08-11：Web 后端不可达时，尝试通过原生主机自动拉起，再测一次
  if (webSt === 'unreachable') {
    const auto = await ensureBackendRunningNative({ silent: true }).catch(() => ({ ok: false }));
    if (auto.ok) webSt = await probeWeb();
  }
  // ★2026-09-16（审查 重要-2）：以下结论来自 Web / 云端通道，而非本机原生主机通道
  __ytDlpLastSource = 'web';
  // ★2026-08-24 自愈：云端部署场景下，后端可达但 yt-dlp 未装 → 自动触发云端安装，无需用户手动点。
  // 仅当云端地址非本机时启用（本机场景保留原生主机「一键连接」交互）。
  if (webSt === 'missing') {
    const base = await getCloudApiBase().catch(() => 'http://127.0.0.1:3000');
    const isCloud = !/127\.0\.0\.1|localhost/.test(base);
    if (autoInstall && isCloud && !autoYtDlpInstallInFlight()) {
      autoInstallYtDlpViaCloud(base);
    }
  }
  return webSt;
}

// 自愈安装的再入保护：内存占位 + 时间戳冷却。
// ★2026-09-16 修复（审查 阻断-2 / 重要-2）：
//   旧实现用 localStorage 布尔量且【从不清零、无 TTL】——侧栏在 3 分钟轮询中被关闭，
//   标记会永久留在 '1'，之后所有会话的自愈安装全部失效（且没有任何提示）；
//   而无身份/被拒分支又不置位 → refreshYtDlpNotice → checkYtDlp → 再次自愈 → 无限请求循环。
//   现改为「进行中标记（内存）+ 最近尝试时间戳（冷却窗口）」，两者任一命中都不再触发。
const YTDLP_AUTO_INSTALL_COOLDOWN_MS = 5 * 60 * 1000;
// ★审查 重要-1：占位若因异常/挂起没能复位，会永久禁用自愈。故占位带"开始时间"，
//   超过 STALE 视为失效（不依赖 finally 必达；finally 仍是主要复位手段）。
const YTDLP_AUTO_INSTALL_STALE_MS = 30 * 1000;
let __ytDlpAutoInstallRunning = false;
let __ytDlpAutoInstallStartedAt = 0;
let __ytDlpLastAttemptAt = 0; // 内存兜底：localStorage 写入失败时冷却依然生效（审查 次要-4）
function autoYtDlpInstallInFlight() {
  if (__ytDlpAutoInstallRunning) {
    return (Date.now() - __ytDlpAutoInstallStartedAt) < YTDLP_AUTO_INSTALL_STALE_MS;
  }
  let persisted = 0;
  try { persisted = Number(localStorage.getItem('hmdao_ytDlpAutoInstallingAt') || 0) || 0; } catch (_) { persisted = 0; }
  const lastAt = Math.max(__ytDlpLastAttemptAt, persisted);
  return lastAt > 0 && (Date.now() - lastAt) < YTDLP_AUTO_INSTALL_COOLDOWN_MS;
}
function markAutoYtDlpInstallAttempt() {
  __ytDlpLastAttemptAt = Date.now();
  try { localStorage.setItem('hmdao_ytDlpAutoInstallingAt', String(__ytDlpLastAttemptAt)); } catch (_) {}
  // 清理历史布尔键：它没有 TTL，会把用户永久卡在"不再自动安装"的死状态
  try { localStorage.removeItem('hmdao_ytDlpAutoInstalling'); } catch (_) {}
}
// 给「可能永不 settle」的读取加超时（chrome.storage 回调在极端情况下不回，会让自愈卡死）
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => { setTimeout(() => resolve(fallback), ms); }),
  ]);
}

// 云端自愈：POST /api/health/local-post/runtime/install 触发后端静默安装 yt-dlp，并轮询就绪。
// ★2026-09-16 鉴权收紧：该接口已不允许匿名调用——需「已授权设备（trial/paid）」或「运维 API Key」。
//   因此必须携带 deviceId(+token)，统一取自 ui-utils.js 的 getExtDeviceAuth / withDeviceAuth*（单一来源）。
//   既无身份也不硬试，只给可执行引导。
// ★2026-09-16 修复（审查 阻断-1/阻断-2）：
//   ① 一进函数就占位（__ytDlpAutoInstallRunning）并记录尝试时间，任何分支（含随后的刷新）都不会再入；
//   ② 横幅刷新放在 finally 且【在复位之后】，避免"被拒 → 立即重试"的热循环；
//   ③ 请求加 15s 超时，避免挂起的 fetch 让自愈永久锁死。
async function autoInstallYtDlpViaCloud(base) {
  if (autoYtDlpInstallInFlight()) return;
  __ytDlpAutoInstallRunning = true;
  __ytDlpAutoInstallStartedAt = Date.now();
  let hint = '';
  let needRefresh = false;
  try {
    // ★审查 重要-1：身份读取加 3s 超时——chrome.storage 回调若不返回，本函数会卡在 await，
    //   导致 finally 不可达（占位虽有 STALE 兜底，但也不该把用户晾着）。
    let apiKey = '';
    try {
      if (window.DdayupConfig && window.DdayupConfig.getApiKey) {
        apiKey = String(await withTimeout(window.DdayupConfig.getApiKey(), 3000, '') || '');
      }
    } catch (_) { apiKey = ''; }
    let auth = { deviceId: '', token: '' };
    try {
      if (typeof getExtDeviceAuth === 'function') {
        const raw = await withTimeout(getExtDeviceAuth(), 3000, null);
        if (raw) auth = { deviceId: String(raw.deviceId || ''), token: String(raw.token || '') };
      }
    } catch (_) { auth = { deviceId: '', token: '' }; }

    if (!auth.deviceId && !apiKey) {
      // 既无设备身份也无运维 Key：不做匿名尝试（服务端会 401），把原因交给横幅统一渲染。
      panelLog('ytDlp-auto-install', { skipped: true, reason: 'no-identity' });
      hint = '（云端未安装 yt-dlp：请在扩展内登录或开启试用后自动安装；运维也可在扩展「选项」填 API Key 自助安装。）';
      needRefresh = true;
      return;
    }

    // ★审查 次要-1：打点放在"确定要发请求"之后——否则"无身份"早退也会吃掉 5 分钟冷却，
    //   用户随后登录/开启试用时会遭遇"该装却装不了"的空窗。
    markAutoYtDlpInstallAttempt();
    panelLog('ytDlp-auto-install', { base, ts: Date.now(), byDevice: Boolean(auth.deviceId), byApiKey: Boolean(apiKey) });
    const headers = { 'Content-Type': 'application/json' };
    // ★审查 次要-1：运维 Key 只走 Authorization 头，不放进 query（URL 会进访问日志 / Referer）
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
    // deviceId/token 走请求体（服务端优先读 body.deviceId），URL 保持干净
    const body = (typeof withDeviceAuthBody === 'function')
      ? withDeviceAuthBody({ runtimeKey: 'ytdlp' }, auth)
      : { runtimeKey: 'ytdlp', deviceId: auth.deviceId, token: auth.token };
    const r = await fetch(base + '/api/health/local-post/runtime/install', {
      method: 'POST',
      credentials: 'omit',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) {
      // 401/402 是可解释的拒绝（缺身份 / 未授权）：给出可执行引导，而不是静默失败
      if (r.status === 401 || r.status === 402) {
        // ★审查 重要-3：消费服务端可区分的 mode，避免把"从未开通"也写成"试用已到期"
        const payload = await r.json().catch(() => null);
        const mode = String((payload && payload.mode) || '');
        const serverMessage = String((payload && payload.error && payload.error.message) || '');
        if (serverMessage) panelLog('ytDlp-auto-install', { serverMessage });
        // ★审查 次要-3：mode 解析失败/未知时用中性文案，避免把"已到期"误述成"从未开通"
        hint = r.status === 401
          ? '（云端安装需要身份：请在扩展内登录或开启试用后自动安装。）'
          : (mode === 'expired'
            ? '（试用已到期：订阅后即可自动安装云端运行时。）'
            : (mode === 'none'
              ? '（本机尚未开通试用：在扩展内开启试用后即可自动安装云端运行时。）'
              : '（需要先在扩展内开启试用或完成订阅，之后会自动安装云端运行时。）'));
        needRefresh = true;
      }
      panelLog('ytDlp-auto-install', { failed: true, status: r.status });
      return;
    }

    // 安装任务已受理：清空历史提示，轮询最多约 3 分钟等待就绪
    __ytDlpCloudInstallHint = '';
    const start = Date.now();
    const tick = async () => {
      if (Date.now() - start > 180000) {
        // ★审查 次要-3：超时不再静默，写失败原因交单一文案源渲染
        __ytDlpLastFailure = '⚠ 云端 yt-dlp 自动安装超时（3 分钟未就绪），可在模型下载面板手动重试。';
        refreshYtDlpNotice();
        return;
      }
      const st = await checkYtDlp({ autoInstall: false }).catch(() => 'unreachable');
      if (st === 'ready') { refreshYtDlpNotice(); return; }
      setTimeout(tick, 3000);
    };
    setTimeout(tick, 3000);
  } catch (e) {
    panelLog('ytDlp-auto-install', { error: String((e && e.message) || e) });
  } finally {
    // ★顺序关键：先复位占位，再刷新横幅（刷新只做只读探测，不会再触发安装）
    __ytDlpAutoInstallRunning = false;
    __ytDlpAutoInstallStartedAt = 0;
    if (hint) __ytDlpCloudInstallHint = hint;
    if (needRefresh) { ensureYtDlpPrompt(); refreshYtDlpNotice(); }
  }
}

// 显示 yt-dlp 提示横幅（双通道：原生一键连接优先，Web 面板备选）
// ★2026-08-18 精准修复：横幅「每个视频点击都弹」——原先每次 fetchPlatformFormats / fallbackCdnFetch /
//   downloadSingle 的 yt-dlp 分支都无条件 ensureYtDlpPrompt() 重显横幅，体验像「反复弹窗」。
//   现改为：整段会话（sidepanel 生命周期）只主动显示一次；用户点「不再提示」或后端就绪后永久隐藏（localStorage）。
let __ytDlpPromptShownThisSession = false;
function ytDlpPromptSuppressed() {
  try { return localStorage.getItem('hmdao_ytDlpPromptSuppressed') === '1'; } catch (_) { return false; }
}
// ===== yt-dlp 横幅交互辅助（2026-09-16 修复 B/C/D）=====
// 单一文案源约定：横幅文案只由 refreshYtDlpNotice() 生成，其它函数只改状态 / 触发刷新。
// （旧实现在 autoInstallYtDlpViaCloud 内直接 querySelector('.ytDlpNoticeMsg') 写文案，
//   而 sidepanel.html 中并无该元素 → 那句"云端未安装"提示永远不显示，属死代码。）
let __ytDlpCloudInstallHint = '';
// 上一次缺失/就绪结论的来源：'native'=原生主机通道（本机）；'web'=Web/云端通道（审查 重要-2）
let __ytDlpLastSource = '';
// 最近一次安装失败原因（由点击入口写入，refreshYtDlpNotice 统一渲染，避免文案与按钮状态脱节）
let __ytDlpLastFailure = '';

// ★2026-09-16（审查 重要-4）：ytdlp.ensure 单飞。
//   加载后 1.5s 的静默自动安装、用户点「一键连接」、两路可能同时发生，而 host 侧无锁、
//   且共用同一个 .part 文件（追加写）→ 并发会让下载交错损坏，表现为"两个入口都失败"。
//   统一收敛到同一个在飞 Promise，谁先来谁发起，其余复用结果。
let __ytDlpEnsurePromise = null;
function ensureYtDlpOnce(timeoutMs = 180000) {
  if (__ytDlpEnsurePromise) return __ytDlpEnsurePromise;
  __ytDlpEnsurePromise = ddNativeRpc('ytdlp.ensure', {}, timeoutMs)
    .finally(() => { __ytDlpEnsurePromise = null; });
  return __ytDlpEnsurePromise;
}

// 判定当前后端是「云端」还是「本机」（用于区分缺失文案，避免误导用户去点注定失败的按钮）
async function isCloudBackend() {
  try {
    const base = await getCloudApiBase();
    return !/127\.0\.0\.1|localhost/i.test(String(base || ''));
  } catch (_) {
    return false;
  }
}

// 把「一键连接（本地）」换成「前往 Web 模型面板」：
// 原生主机不可用时该按钮注定失败，留着只会让用户反复点击、反复等待（B 的兜底目标）。
function switchYtDlpConnectToWeb(connectBtn, webBtn) {
  try {
    if (connectBtn) { connectBtn.style.display = 'none'; connectBtn.disabled = true; }
  } catch (_) {}
  try {
    if (webBtn) { webBtn.style.display = ''; webBtn.textContent = '去模型下载面板安装'; }
  } catch (_) {}
}

function ensureYtDlpPrompt() {
  const n = document.getElementById('ytDlpNotice');
  if (!n) return;
  // 已被用户「不再提示」永久隐藏 → 直接返回，绝不重显
  if (ytDlpPromptSuppressed()) { n.style.display = 'none'; return; }
  // 本会话已显示过一次 → 不再重复弹出（避免每次点视频都闪横幅）
  if (__ytDlpPromptShownThisSession) return;
  __ytDlpPromptShownThisSession = true;
  n.style.display = '';
  refreshYtDlpNotice(); // 显示即按当前状态刷新文案（绿点/黄点/灰点）
  const startBtn = document.getElementById('ydStartBackendBtn');
  const connectBtn = document.getElementById('ydConnectBtn');
  const webBtn = document.getElementById('ydWebBtn');
  const spinner = document.getElementById('ydSpinner');

  // ★ 启动 Ddayup Web 后端（原生主机方案）
  if (startBtn && !startBtn.__bound) {
    startBtn.__bound = true;
    startBtn.addEventListener('click', async () => {
      spinner.style.display = '';
      spinner.textContent = '⏳ 正在启动后端…';
      startBtn.disabled = true;
      const r = await startBackendViaNative();
      if (r.ok) {
        // 启动成功后再检查 yt-dlp 状态
        spinner.textContent = '⏳ 后端启动成功，正在检查 yt-dlp…';
        await ensureBackendRunningNative();
        refreshYtDlpNotice();
      } else {
        spinner.textContent = '启动失败：' + (r.error || '未知错误');
      }
      setTimeout(() => { spinner.style.display = 'none'; startBtn.disabled = false; }, 3000);
    });
  }

  if (connectBtn && !connectBtn.__bound) {
    connectBtn.__bound = true;
    connectBtn.addEventListener('click', async () => {
      // ★2026-09-16 修复（B）：改用带超时的 ddNativeRpc（与 download.js 的 ytdlp.ensure 一致），
      //   并保证【任何】失败路径都复位按钮状态。
      //   旧实现用裸 port.postMessage + 无超时监听：原生主机不回包时 connectBtn.disabled
      //   永久为 true，表现为"卡死 / 没反应"（用户只能重开侧栏），且没有任何兜底出口。
      __ytDlpLastFailure = '';
      spinner.style.display = '';
      spinner.style.color = '#8b949e';
      spinner.textContent = '⏳ 正在安装 / 连接…';
      connectBtn.disabled = true;
      let result = null;
      let failure = '';
      try {
        // ★2026-09-16（审查 重要-4）：与静默自动安装共用单飞 Promise，避免并发写坏 .part
        result = await ensureYtDlpOnce(180000);
      } catch (e) {
        const msg = String((e && e.message) || e || '');
        if (msg === 'native_unavailable') failure = 'native_unavailable';
        else if (msg === 'native_timeout') failure = 'native_timeout';
        else if (msg === 'native_disconnected') failure = 'native_disconnected';
        else failure = msg || 'unknown';
      } finally {
        // ★关键：无论成功/异常/超时/断开，按钮与转圈一定复位（旧实现漏了异常与超时两条路径）
        connectBtn.disabled = false;
        spinner.style.display = 'none';
        spinner.textContent = '';
      }
      if (result && result.ok && (result.installed || result.success)) {
        __ytDlpLastFailure = '';
        hideYtDlpPrompt();
        refreshYtDlpNotice();
        return;
      }
      // ★2026-09-16（审查 重要-5）：失败原因写入状态变量，统一交给 refreshYtDlpNotice 渲染，
      //   并立即重排按钮出口。旧实现只在 spinner 留一句橙字、不刷新 → #ydDesc 仍在教用户
      //   点一个刚被隐藏的按钮，且按钮文案被永久改写、恢复只能等别的偶然事件。
      const detail = failure === 'native_unavailable'
        ? '未检测到原生主机（未安装或被浏览器禁用）'
        : failure === 'native_timeout'
          ? '原生主机 180 秒未响应'
          : failure === 'native_disconnected'
            ? '原生主机连接中断（进程退出或被结束）'
            : (result && result.error) ? String(result.error) : (failure || '未知错误');
      __ytDlpLastFailure = '⚠ 本地安装不可用（' + detail + '），已改用网页安装入口。';
      refreshYtDlpNotice();
    });
  }
  if (webBtn && !webBtn.__bound) {
    webBtn.__bound = true;
    webBtn.addEventListener('click', () => chrome.tabs.create({ url: apiBaseUrl() + '/#models' }));
  }
  // ★2026-08-18：用户点「不再提示」→ 永久隐藏横幅（localStorage 持久化）
  const dismissBtn = document.getElementById('ydDismiss');
  if (dismissBtn && !dismissBtn.__bound) {
    dismissBtn.__bound = true;
    dismissBtn.addEventListener('click', () => {
      try { localStorage.setItem('hmdao_ytDlpPromptSuppressed', '1'); } catch (_) {}
      hideYtDlpPrompt();
    });
  }
  // 安装/启动完成后自动隐藏：轮询最多 ~30s
  if (!n.__watching) {
    n.__watching = true;
    let tries = 0;
    const t = setInterval(() => {
      tries++;
      // ★2026-09-16（审查 阻断-1）：等待就绪的轮询只做只读探测，不得触发自愈安装
      checkYtDlp({ autoInstall: false }).then((st) => {
        if (st === 'ready') { hideYtDlpPrompt(); clearInterval(t); n.__watching = false; }
        else if (tries >= 10) { clearInterval(t); n.__watching = false; }
      });
    }, 3000);
  }
}

// 根据当前检测状态刷新横幅文案（绿点=就绪，黄点=需安装，灰点=检测中/后端未启动）
function refreshYtDlpNotice() {
  const n = document.getElementById('ytDlpNotice');
  if (!n) return;
  const dot = document.getElementById('ydDot');
  const title = document.getElementById('ydTitle');
  const desc = document.getElementById('ydDesc');
  const startBtn = document.getElementById('ydStartBackendBtn');
  const cBtn = document.getElementById('ydConnectBtn');
  const wBtn = document.getElementById('ydWebBtn');

  Promise.all([
    // ★2026-09-16（审查 阻断-1）：渲染只读探测，禁止在此触发自愈安装（防无限循环）
    checkYtDlp({ autoInstall: false }).catch(() => 'unreachable'),
    getBackendStatusViaNative().catch(() => ({ ok: false, nativeUnavailable: true })),
    isCloudBackend(),
  ]).then(([ytSt, backendSt, cloudBackend]) => {
    // 结论来源：'native'=原生主机通道（本机）；'web'=Web/云端通道（审查 重要-2）
    const fromNative = __ytDlpLastSource === 'native';
    const failureNote = __ytDlpLastFailure ? ' ' + __ytDlpLastFailure : '';
    const showWeb = (label) => { if (wBtn) { wBtn.style.display = ''; wBtn.textContent = label; } };

    if (ytSt === 'ready') {
      __ytDlpLastFailure = '';
      if (dot) dot.style.background = '#3fb950';
      if (title) title.textContent = 'yt-dlp 已就绪';
      if (desc) {
        desc.textContent = fromNative
          ? '本机 yt-dlp 已就绪，可用于解析视频多分辨率与下载。'
          : (cloudBackend ? '云端 yt-dlp 已就绪，可用于解析视频多分辨率。' : '后端 yt-dlp 已就绪，可用于解析视频多分辨率。');
      }
      if (startBtn) startBtn.style.display = 'none';
      if (cBtn) cBtn.style.display = 'none';
      if (wBtn) wBtn.style.display = 'none';
      setTimeout(hideYtDlpPrompt, 1500);
      return;
    }

    if (ytSt === 'missing') {
      if (dot) dot.style.background = '#e0b341';
      if (title) title.textContent = '需要 yt-dlp 解析视频直链';
      // ★2026-09-16 修复（C+D）：只在原生主机【真正可用】时才展示「一键连接（本地）」——
      //   否则该按钮注定失败（原生主机都没装，点它只会干等 180 秒），必须直接引导去模型下载面板。
      const nativeOk = !backendSt.nativeUnavailable;
      if (nativeOk) {
        // 该 missing 结论来自原生主机通道 → 就是【本机】缺，不再误写成"云端未安装"
        if (desc) desc.textContent = '本机 yt-dlp 未安装。点「一键连接」安装到本机，或前往 Web 模型面板安装。' + failureNote;
        if (cBtn) {
          // 静默自动安装进行中 → 按钮进入占用态，避免用户重复触发（审查 重要-4）
          const busy = Boolean(__ytDlpEnsurePromise);
          cBtn.style.display = '';
          cBtn.disabled = busy;
          cBtn.textContent = busy ? '⏳ 正在安装 yt-dlp…' : '⚡ 一键连接 yt-dlp（本地）';
        }
        showWeb('或前往 Web 模型面板');
      } else {
        // 本机通道不可用：结论若来自 Web 通道且指向云端 → 云端缺失；否则本机/内网后端缺失
        const cloudMissing = !fromNative && cloudBackend;
        if (desc) {
          const base = cloudMissing
            ? '云端未安装 yt-dlp：请在 Web 模型面板点「安装」，由服务器自行下载安装。'
            : '未检测到原生主机（未安装或被浏览器禁用），无法自动安装到本机。请前往模型下载面板安装 yt-dlp。';
          const hint = cloudMissing && __ytDlpCloudInstallHint ? ' ' + __ytDlpCloudInstallHint : '';
          desc.textContent = base + hint + failureNote;
        }
        // 不展示「一键连接（本地）」，直接换成「去模型下载面板安装」
        switchYtDlpConnectToWeb(cBtn, wBtn);
      }
      if (startBtn) startBtn.style.display = 'none';
      return;
    }

    // ytSt === 'unreachable'：两个通道都不可达
    if (backendSt.nativeUnavailable) {
      if (dot) dot.style.background = '#8b949e';
      if (title) title.textContent = 'Ddayup 后端未启动';
      if (desc) desc.textContent = '未检测到原生主机，且后端不可达。请前往模型下载面板按引导安装 / 启动后端（开发者可运行 extension/native-host/install-host.ps1）。' + failureNote;
      if (startBtn) startBtn.style.display = 'none';
      if (cBtn) cBtn.style.display = 'none';
      // ★审查 次要-2：所有分支都回写文案，避免上一条状态留下的文案串味
      showWeb('前往 Web 模型面板');
    } else {
      if (dot) dot.style.background = '#1a8cff';
      if (title) title.textContent = 'Ddayup 后端未启动';
      if (desc) desc.textContent = '原生主机已就绪，可自动启动后端（127.0.0.1:3000 / 8792）。' + failureNote;
      if (startBtn) startBtn.style.display = '';
      if (cBtn) cBtn.style.display = 'none';
      showWeb('前往 Web 模型面板');
    }
  });
}

function hideYtDlpPrompt() {
  const n = document.getElementById('ytDlpNotice');
  if (n) n.style.display = 'none';
}

// ===== Aria2 下载通道（方案 A：后端 8792 托管 aria2c --enable-rpc）=====
// 返回三态：'ready'（aria2 已安装且 RPC 可连）/ 'missing'（未安装）/ 'unreachable'（后端不可达）
async function checkAria2() {
  try {
    const apiBase = await getCloudApiBase();
    const r = await fetch(apiBase + '/api/aria2/status', { credentials: 'omit' });
    if (!r.ok) return 'unreachable';
    const d = await r.json().catch(() => null);
    if (!d || !d.status) return 'unreachable';
    if (!d.status.installed) return 'missing';
    return 'ready';
  } catch (_) {
    return 'unreachable';
  }
}

// 主动触发后端静默安装 Aria2（local-post runtime）。
async function triggerAria2Install() {
  try {
    const apiBase = await getCloudApiBase();
    const r = await fetch(apiBase + '/api/health/local-post/runtime/install', {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runtimeKey: 'aria2' }),
    });
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  } catch (_) {
    return null;
  }
}

// 轮询等待 Aria2 就绪，最多约 2 分钟。
async function pollAria2Ready(maxMs = 120000, intervalMs = 1500) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const st = await checkAria2().catch(() => 'unreachable');
    if (st === 'ready') return true;
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  return (await checkAria2().catch(() => 'unreachable')) === 'ready';
}

// 判断资产是否为网盘类资产（可能需要先解析真实直链）。
function isNetdiskAsset(a) {
  if (!a) return false;
  if (/xunlei|quark|baidu|pan\.|yunpan|netdisk|115\.com|aliyundrive|lanzou/i.test(a.url || '')) return true;
  return a.type === 'netdisk' || a.type === 'archive' || a.type === 'netdisk-file' || a.isNetdiskFile || a.source === 'netdisk' || a.source === 'archive';
}

// 通过 background 解析网盘资产的真实直链（只拿 URL，不触发浏览器下载）。
async function resolveNetdiskDirectForAria2(a) {
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'HMDAO_NETDISK_DOWNLOAD',
      url: a.url,
      name: a.name,
      returnUrlOnly: true,
    });
    if (res && res.ok && res.url && /^https?:/.test(res.url)) {
      return { ok: true, url: res.url, name: res.name || a.name, via: res.via };
    }
    return { ok: false, error: (res && res.error) || '未解析到直链', diag: res && res.diag };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// 收集网盘站点的登录态（Cookie）以及迅雷个人盘必需的 device-id/client-id。
// 后端 Playwright 跑在独立 Chromium 里，必须拿到这些才能解析【个人盘】真实直链。
async function collectNetdiskAuth(url) {
  const auth = { cookies: '', localStorageStr: '', deviceId: '', clientId: '' };
  try {
    const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
    // 1) 常规 Cookie（夸克/百度/迅雷登录态）
    if (host) {
      const cookies = await chrome.cookies.getAll({ domain: host }).catch(() => []);
      if (cookies && cookies.length) {
        auth.cookies = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      }
    }
    // 2) 迅雷个人盘：device-id / client-id 存在页面 localStorage，不在 Cookie。
    if (/xunlei/i.test(url)) {
      const did = (auth.cookies.match(/deviceid=([^;]+)/i) || [])[1];
      const cid = (auth.cookies.match(/client_id=([^;]+)/i) || [])[1];
      if (did) auth.deviceId = decodeURIComponent(did);
      if (cid) auth.clientId = decodeURIComponent(cid);
      // Cookie 没有则从打开的迅雷标签页 MAIN world 读 localStorage
      if (!auth.deviceId || !auth.clientId) {
        try {
          const tabs = await chrome.tabs.query({ url: '*://*.xunlei.com/*' }).catch(() => []);
          for (const t of tabs) {
            try {
              const res = await chrome.scripting.executeScript({
                target: { tabId: t.id }, world: 'MAIN',
                func: () => ({
                  deviceid: localStorage.getItem('deviceid') || localStorage.getItem('xunlei_device_id') || '',
                  clientid: localStorage.getItem('xunlei_client_id') || localStorage.getItem('client_id') || '',
                }),
              });
              const v = res && res[0] && res[0].result;
              if (v) {
                if (!auth.deviceId && v.deviceid) auth.deviceId = v.deviceid;
                if (!auth.clientId && v.clientid) auth.clientId = v.clientid;
                if (v.deviceid) auth.localStorageStr += `deviceid=${v.deviceid}; `;
                if (v.clientid) auth.localStorageStr += `xunlei_client_id=${v.clientid}; `;
              }
            } catch {}
            if (auth.deviceId && auth.clientId) break;
          }
        } catch {}
      }
    }
  } catch {}
  return auth;
}

// 通过后端 Playwright 深度解析（夸克/百度/迅雷/电驴等），提取真链并直发 Aria2。
// 返回 { ok, error, requireInteraction, taskId }。
async function scrapeNetdiskViaBackend(a) {
  try {
    const auth = await collectNetdiskAuth(a.url);
    const apiBase = await getCloudApiBase();
    const r = await fetch(apiBase + '/api/netdisk/scrape', {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: a.url,
        autoDownload: true,
        downloadDir: '',
        cookies: auth.cookies,
        localStorageStr: auth.localStorageStr,
        deviceId: auth.deviceId,
        clientId: auth.clientId,
      }),
    });
    const d = await r.json().catch(() => null);
    if (!d) return { ok: false, error: '后端无响应' };
    if (d.requireInteraction && d.taskId) {
      return { ok: false, requireInteraction: true, taskId: d.taskId, signals: d.signals, platform: d.platform, url: d.url };
    }
    if (d.ok && d.downloaded && d.downloaded.length) {
      return { ok: true, downloaded: d.downloaded };
    }
    return { ok: false, error: (d.error) || 'scrape 未返回可用直链', raw: d };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// 通过后端 Aria2 添加下载任务（网盘直链/归档/大文件）。
async function downloadViaAria2(a) {
  if (!a) return;
  setStatus('正在准备下载…');

  // 第一步：确保有可用的 HTTP 直链。
  let uri = (a.direct && /^https?:/.test(a.direct)) ? a.direct : '';
  let resolvedName = a.name || '';

  // 如果没有直链且是网盘资产，先让 background 解析/捕获真实下载直链（只返回 URL，不触发浏览器下载）。
  if (!uri && isNetdiskAsset(a)) {
    setStatus('正在解析网盘真实直链…');
    let resolved = await resolveNetdiskDirectForAria2(a);
    // 未深度解析（a.direct 为空）时，先主动触发一次页面会话解析（复用登录态，迅雷个人盘可真实拿到直链），
    // 而不是立刻掉进后端 Playwright 兜底（后端独立 Chromium 拿不到登录态时必然失败）。
    if (!resolved.ok) {
      try {
        const r2 = await chrome.runtime.sendMessage({ type: 'HMDAO_NETDISK_RESOLVE', url: a.url });
        if (r2 && r2.ok && Array.isArray(r2.tree)) {
          const hit = r2.tree.find((f) =>
            (a.fileId && f.fileId === a.fileId) || (a.name && f.name === a.name) ||
            (a.name && f.name && f.name.replace(/\s+/g, '').includes(String(a.name).replace(/\s+/g, ''))));
          if (hit && hit.direct && /^https?:/i.test(hit.direct)) {
            resolved = { ok: true, url: hit.direct, name: hit.name || a.name, via: 'session-resolve' };
          } else if (r2.requireLogin) {
            resolved = { ok: false, error: 'need-login', requireLogin: true };
          }
        } else if (r2 && r2.requireLogin) {
          resolved = { ok: false, error: 'need-login', requireLogin: true };
        }
      } catch (e) { /* 忽略，走兜底 */ }
    }
    if (!resolved.ok) {
      // 兜底：background 直链解析失败 → 走后端 Playwright 深度解析（夸克/百度/迅雷/电驴）。
      // 已把网盘登录态(Cookie + 迅雷 device-id)传给后端，个人盘也能解析。
      setStatus('常规解析失败，尝试用浏览器自动化深度解析…');
      const scraped = await scrapeNetdiskViaBackend(a);
      if (scraped.requireInteraction && scraped.taskId) {
        setStatus('⚠️ 该网盘页面需要登录/验证码。请在源网页完成登录或验证后，后台将自动重试；或先用浏览器登录态再试。', true);
        return;
      }
      if (scraped.ok && scraped.downloaded) {
        setStatus('✅ 已通过浏览器自动化解析并提交 Aria2 下载（' + scraped.downloaded.length + ' 个文件）。', false);
        return;
      }
      if (resolved.requireLogin) {
        setStatus('⚠️ 请先在浏览器登录该网盘账号（' + (a.name || '') + '），再点「用 Aria2 下载」。', true);
        return;
      }
      setStatus('无法解析该网盘文件直链：' + (scraped.error || resolved.error) + '。建议先点「深度解析」或手动在网页端触发下载。', true);
      return;
    }
    uri = resolved.url;
    resolvedName = resolved.name || resolvedName;
  }

  if (!uri) uri = (a.url || '');
  if (!/^https?:/.test(uri)) {
    setStatus('该资产暂无可用直链，请先点「深度解析」获取直链后再用 Aria2 下载。', true);
    return;
  }

  // 第二步：确保 Aria2 已就绪。
  setStatus('正在连接本机 Aria2…');
  let st = await checkAria2().catch(() => 'unreachable');

  // Aria2 缺失时：主动触发后端静默安装，并轮询等待完成，无需跳页面。
  if (st === 'missing') {
    setStatus('Aria2 未安装，正在后台自动安装…');
    const job = await triggerAria2Install();
    if (!job) {
      setStatus('自动安装 Aria2 失败，请打开 Ddayup Web 模型面板手动安装。', true);
      if (chrome.tabs) chrome.tabs.create({ url: apiBaseUrl() + '/#models' }).catch(() => {});
      return;
    }
    setStatus('Aria2 安装任务已启动（' + (job.jobId || 'background') + '），等待就绪…');
    const ready = await pollAria2Ready();
    if (!ready) {
      setStatus('Aria2 安装超时，请检查网络后重试，或前往模型面板手动安装。', true);
      if (chrome.tabs) chrome.tabs.create({ url: apiBaseUrl() + '/#models' }).catch(() => {});
      return;
    }
    st = 'ready';
  }

  if (st === 'unreachable') {
    setStatus('无法连接 Ddayup 后端（127.0.0.1:3000），请先启动 Web App 再使用 Aria2 下载。', true);
    return;
  }

  // 第三步：提交 Aria2 下载任务。
  try {
    const apiBase = await getCloudApiBase();
    const r = await fetch(apiBase + '/api/aria2/add-uri', {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris: uri, options: { out: resolvedName || undefined } }),
    });
    const d = await r.json().catch(() => null);
    if (d && d.ok) {
      setStatus('✅ 已提交 Aria2 下载（gid ' + d.gid + '），下载目录：Ddayup 模型面板 → Aria2 状态。', false);
      panelLog('aria2-add-uri', { uri, gid: d.gid });
    } else if (r.status === 412) {
      setStatus('Aria2 仍未就绪，请稍后重试，或前往模型面板手动安装。', true);
      if (chrome.tabs) chrome.tabs.create({ url: apiBaseUrl() + '/#models' }).catch(() => {});
    } else {
      setStatus('Aria2 提交失败：' + (d && d.error || r.status), true);
    }
  } catch (e) {
    setStatus('Aria2 提交异常：' + (e && e.message || e), true);
  }
}

// 多平台格式列表拉取（YouTube/B站等，用于分辨率选择）
// ★修复：此前只认 a.ytPageUrl/a.ytVideoId，B站资产(biliPageUrl/biliVideoId)被忽略 →
//        videoPageUrl 为空直接 return → window.__ytFormats 永远为空 → 分辨率面板永远只有一个「原画质直链」，
//        而那个直链是 bilivideo 防盗链签名地址（过期即 403）→ 点击下载毫无反应/失败。
//   现在统一从 biliPageUrl/biliVideoId/ytPageUrl/ytVideoId 推导视频页 URL，B站也能拉到多分辨率。
// 根据【当前实际加载的网站】推导可用于 yt-dlp 拉取分辨率的视频页 URL。
// 优先级：资产自带平台字段 > 资产 URL 本身是可识别平台播放页 > 当前源页（window.__sourcePageUrl）。
// 关键：网络层被动捕获的 bilivideo/googlevideo 裸流资产没有 biliPageUrl/ytPageUrl 字段，
// 但侧栏已知「当前网站」就是 B站/YouTube 播放页，应直接用当前源页作为 videoPageUrl，
// 否则 fetchPlatformFormats 推导为空 → 分辨率列表永远空白（"不能选对应分辨率下载"的根因之一）。
// 该逻辑纯被动读取，不向网站注入任何脚本/请求，不干扰网站正常运行与播放。
function derivePlatformVideoPageUrl(a) {
  const src = window.__sourcePageUrl || '';
  // 1) 资产自带平台字段（扫描阶段从 iframe/全局变量提取的 playerUrl 等）
  // ★2026-08-23 抖音优先：抖音资产自带 playerUrl（https://www.douyin.com/video/<awemeId> 或 webcast 播放页）
  //   是真正可播放/可解析的页面；a.url 往往是 CDN 直链（lf3-static.bytednsdoc.com）无法被 yt-dlp 直接解析，
  //   故抖音/platform=douyin 时优先用 playerUrl，且不要把 CDN 直链误当播放页。
  const isDy = /douyin|bytedance|tiktok|douyinvod|iesdouyin/i.test(a.platform || '');
  if (isDy && a.playerUrl && a.playerUrl !== 'null') return a.playerUrl;
  let url = a.biliPageUrl
    || (a.biliVideoId && a.biliVideoId !== 'null' ? ('https://www.bilibili.com/video/' + a.biliVideoId) : '')
    || a.ytPageUrl
    || (a.ytVideoId && a.ytVideoId !== 'null' ? ('https://www.youtube.com/watch?v=' + a.ytVideoId) : '')
    || a.playerUrl;
  if (url && url !== 'null') return url;
  // 2) 资产 URL 本身就是平台播放页（如 embed-platform 入库的 playerUrl 被当 url）
  // ★2026-08-23 排除抖音 CDN 直链（lf3-static.bytednsdoc.com / douyinvod 等），它们不是播放页、yt-dlp 解析会 404。
  if (a.url && !/bytednsdoc\.com|douyinvod|lf3-static|sf[0-9]*-cdn-tos/i.test(a.url) && /youtube\.com|youtu\.be|bilibili\.com|youku\.com|v\.qq\.com|iqiyi\.com|ixigua\.com|sohu\.com|tudou\.com|douyin\.com|iesdouyin\.com|tiktok\.com|xinpianchang\.com|kuaishou\.com|acfun\.cn|haokan\.baidu\.com|m\.haokan/i.test(a.url)) {
    return a.url;
  }
  // 3) 回退：当前实际加载的网站就是视频平台播放页 → 直接用它拉分辨率
  if (src && /youtube\.com|youtu\.be|bilibili\.com|youku\.com|v\.qq\.com|iqiyi\.com|ixigua\.com|sohu\.com|tudou\.com|douyin\.com|iesdouyin\.com|tiktok\.com|xinpianchang\.com|kuaishou\.com|acfun\.cn|haokan\.baidu\.com|m\.haokan/i.test(src)) {
    return src;
  }
  return '';
}

// 抖音解析需要「新鲜 cookie」（不一定要登录，浏览器匿名会话即可）。
// 后端 yt-dlp 已支持 --cookies，但 Win 上 --cookies-from-browser 因 Chrome App-Bound
// 加密（DPAPI）无法被 Node 进程解密 → 唯一可靠路径：扩展用 chrome.cookies API 读
// 源页 douyin cookie → 写 Netscape cookie 文件 → 调后端 ytdlp 时带 &cookiesFile=。
let __douyinCookiesFile = null; // 缓存，避免每次扫描重读
async function buildDouyinCookiesFile() {
  if (__douyinCookiesFile) return __douyinCookiesFile;
  try {
    // ★2026-09-02 修正（上一版用 domains 是错的，勿改回）：
    //   1) Chrome 的 cookies.getAll 【不支持 domains 属性】——实测直接抛
    //      "Unexpected property: 'domains'"，异常被本函数 catch 吞掉后返回 null，
    //      cookie 文件恒为空 → 后端 yt-dlp 报 "Fresh cookies are needed" → 500。
    //   2) 而 { domain:'douyin.com' } 是【精确匹配】，取不到 www.douyin.com 子域下的关键 cookie
    //      （ttwid / sessionid 等实际都设在 www 域）。两个写法都不行。
    //   正确做法：getAll({}) 取全部 cookie 再按域名后缀过滤，自然覆盖 douyin.com 及所有子域。
    const allCookies = await chrome.cookies.getAll({});
    const list = (allCookies || []).filter((c) => /douyin\.com$/i.test(String((c && c.domain) || '')));
    if (!list || !list.length) return null;
    const lines = [
      '# Netscape HTTP Cookie File',
      ...list.map((c) => [
        c.domain.startsWith('.') ? c.domain : '.' + c.domain,
        'TRUE', c.path || '/', c.secure ? 'TRUE' : 'FALSE',
        c.expirationDate ? String(Math.floor(c.expirationDate)) : '0',
        c.name, c.value,
      ].join('\t')),
    ];
    const tmp = (typeof window !== 'undefined' && window.__hmdaoTmpDir) || require('os').tmpdir();
    const fs = require('fs');
    const p = require('path').join(tmp, 'hmdao_douyin_cookies.txt');
    fs.writeFileSync(p, lines.join('\n'));
    __douyinCookiesFile = p;
    return p;
  } catch (_) { return null; }
}

// B站解析/下载需要「登录态 cookie」（未登录 yt-dlp 拿不到 720P+ 高清格式 → 后端 500）。
// 与抖音同理：扩展读 bilibili.com 登录 cookie → 写 Netscape 文件 → 调后端 ytdlp 带 &cookiesFile=。
let __biliCookiesFile = null; // 缓存，避免每次扫描重读
async function buildBiliCookiesFile() {
  if (__biliCookiesFile) return __biliCookiesFile;
  try {
    const list = await chrome.cookies.getAll({ domain: 'bilibili.com' });
    if (!list || !list.length) return null;
    const lines = [
      '# Netscape HTTP Cookie File',
      ...list.map((c) => [
        c.domain.startsWith('.') ? c.domain : '.' + c.domain,
        'TRUE', c.path || '/', c.secure ? 'TRUE' : 'FALSE',
        c.expirationDate ? String(Math.floor(c.expirationDate)) : '0',
        c.name, c.value,
      ].join('\t')),
    ];
    const tmp = (typeof window !== 'undefined' && window.__hmdaoTmpDir) || require('os').tmpdir();
    const fs = require('fs');
    const p = require('path').join(tmp, 'hmdao_bili_cookies.txt');
    fs.writeFileSync(p, lines.join('\n'));
    __biliCookiesFile = p;
    return p;
  } catch (_) { return null; }
}

// ★2026-08-23 P4（Youtube 真实分辨率兜底）：yt-dlp 后端易失效/需安装，
// 当后端没返回格式时，直接从源页 MAIN 世界读 window.ytInitialPlayerResponse，
// 提取 streamingData.formats（渐进式，含音视频）+ adaptiveFormats（自适应，纯视频/纯音频，需合并），
// 用真实直链构造与 yt-dlp 格式兼容的数组（format_id/direct-<itag>/height/has_video/has_audio/url），
// 写入 window.__ytFormats 并渲染分辨率选择器。该直链自带音视频（progressive），下载无需 ffmpeg 合并。
// 纯读取，不向网站注入任何东西，不影响播放（与 P0 要求"扫描不影响页面"一致）。
async function fetchYoutubeFromPage(a) {
  let tabId = null;
  try {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = t && t.id;
  } catch (_) {}
  if (!tabId) return false;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        try {
          const y = window.ytInitialPlayerResponse;
          if (!y || !y.streamingData) return null;
          const fmts = [];
          (y.streamingData.formats || []).forEach(f => {
            if (f && f.url && f.width) {
              fmts.push({
                format_id: 'direct-' + (f.itag || 'prog'),
                height: f.height || Math.round((f.width || 0) * 9 / 16),
                width: f.width,
                fps: f.fps,
                has_video: true,
                has_audio: true, // progressive 自带音轨
                url: f.url,
                ext: (f.mimeType || '').split(';')[0].split('/')[1] || 'mp4',
              });
            }
          });
          (y.streamingData.adaptiveFormats || []).forEach(f => {
            if (!f || !f.url || !f.width) return;
            const isAudio = /audio/i.test(f.mimeType || '');
            fmts.push({
              format_id: 'direct-' + (f.itag || 'adapt'),
              height: f.height || Math.round((f.width || 0) * 9 / 16),
              width: f.width,
              fps: f.fps,
              has_video: !isAudio,
              has_audio: isAudio,
              url: f.url,
              ext: (f.mimeType || '').split(';')[0].split('/')[1] || (isAudio ? 'webm' : 'mp4'),
            });
          });
          return fmts.length ? fmts : null;
        } catch (_) { return null; }
      },
    });
    const fmts = res && res.result;
    if (fmts && fmts.length) {
      window.__ytFormats = fmts;
      buildYoutubeFormatSelector(fmts);
      return true;
    }
  } catch (_) {}
  return false;
}

async function fetchPlatformFormats(a) {
  let videoPageUrl = derivePlatformVideoPageUrl(a);
  // ★过滤字面量 "null" / 非法 URL（biliVideoId 等字段可能为字符串 "null"，
  // 会拼出 https://www.bilibili.com/video/null → 后端 404 + 控制台 SyntaxError）
  try {
    const u = new URL(videoPageUrl);
    if (!/^https?:$/.test(u.protocol) || u.hostname === 'null' || u.pathname.includes('/null')) videoPageUrl = '';
  } catch (_) { videoPageUrl = ''; }
  if (!videoPageUrl) return;
  const isBili = /bilibili\.com/i.test(videoPageUrl);
  const isDy = /douyin|bytedance/i.test(videoPageUrl);
  let cookieArg = '';
  if (isBili) {
    const cf = await buildBiliCookiesFile();
    if (cf) cookieArg = '&cookies_file=' + encodeURIComponent(cf);
  } else if (isDy) {
    const cf = await buildDouyinCookiesFile();
    if (cf) cookieArg = '&cookies_file=' + encodeURIComponent(cf);
  }
  try {
    const apiBase = await getCloudApiBase();
    const r = await fetch(withDeviceAuth(apiBase + '/api/platform/ytdlp?action=formats&url=' + encodeURIComponent(normalizeYtdlpDouyinUrl(videoPageUrl)) + cookieArg, await getExtDeviceAuth()), { credentials: 'omit' });
    const d = await r.json().catch(() => null);
    if (d && d.formats && d.formats.length) {
      window.__ytFormats = d.formats;
      // B站/通用的多分辨率用同一选择器渲染（YouTube 也是它，复用即可）
      buildYoutubeFormatSelector(d.formats);
      if (isBili) {
        // 让下载确认时能直接按 format_id 走 yt-dlp 指定格式下载
        const defaultFmt = (d.formats.find(f => f.has_video && f.has_audio) || d.formats.find(f => f.has_video)) || d.formats[0];
        window.__ytSelectedFormat = defaultFmt ? defaultFmt.format_id : '';
      }
    } else if (d && d.error) {
      // ★2026-09-10：后端 yt-dlp 解析失败（站点不支持 / 证书无效 / 需登录 / 加密流等）。
      //   此前非 YouTube 站点走到这里什么都不做 → 用户点卡片「没反应」，只有 Console 里能看到 500，
      //   被误判成扩展坏了。现在把后端返回的原因直接显示到侧栏状态条。
      try { setStatus('⚠ 解析失败：' + String(d.error).slice(0, 120), true); } catch (_) {}
    } else if (a && /youtube\.com|youtu\.be/i.test(derivePlatformVideoPageUrl(a) || window.__sourcePageUrl || '')) {
      // ★2026-08-23 P4：yt-dlp 后端未返回（未安装/失效）→ 源页 ytInitialPlayerResponse 直链兜底，
      // 保证 Youtube 仍能选分辨率并直接下载真实直链（无需后端、不影响播放）。
      await fetchYoutubeFromPage(a);
    }
  } catch (_) {
    // 扩展已装、后端可达但 yt-dlp 未就绪时，主动提示去模型下载面板安装
    try {
      if (a && /youtube\.com|youtu\.be/i.test(derivePlatformVideoPageUrl(a) || window.__sourcePageUrl || '')) {
        await fetchYoutubeFromPage(a);
      }
    } catch (_) {}
    checkYtDlp().then((st) => { if (st === 'missing') ensureYtDlpPrompt(); });
  }
}

// ===== 音效试听 / 播放 =====
// 关键事实（决定为什么「在爱给网能播、面板不能」）：
//   · Chrome 自动播放策略只认【被播放页面自身文档内的用户手势】。
//     在爱给页面点播放键 → 手势在爱给文档内 → 放行。
//     扩展注入的 play() 手势来自侧栏 → 永远不算爱给文档的手势 → 被拦截。
//   · 侧栏自己的 <audio> 加载爱给 CDN 时，没有爱给登录 Cookie/Referer → 403。
// 因此可靠路径 = 以【源页身份】fetch 带登录态的字节（HMDAO_FETCH_IN_PAGE）→
//   回传侧栏用侧栏 <audio> 播放（手势来自侧栏点击/双击 → 有效）。两者兼备。
// === 音效试听 / 播放 已抽离到 audio-playback.js（在 sidepanel.js 之后加载，共享全局作用域） ===
// 原函数：unlockAudioOnGesture / fetchAudioBytesInPage / resolveFreshAudioUrl / playAudioViaBlob /
// downloadWithPageFetch / downloadViaBrowser / playAudioFromPage / playAudioWithRealUrl /
// playAudioInPage / hoverPlayAudio / stopHoverAudio（含全局 hoverAudioInPage / audioUnlocked）。
// closePreview 仍留在本文件（共享 teardown）。

function closePreview() {
  // ★2026-09-06：关闭预览必须立即停掉【侧栏自己的】音频（豆包朗读等走 previewAudio 播放）。
  //   否则关了卡片声音还在响（用户明确要求：不要有残留音效流出）。
  try {
    const au = document.getElementById('previewAudio');
    if (au) { au.pause(); try { au.removeAttribute('src'); au.load(); } catch (_) {} }
  } catch (_) {}
  try { if (typeof playToken !== 'undefined') playToken++; } catch (_) {}
  try { if (typeof window.stopHoverAudio === 'function') window.stopHoverAudio(); } catch (_) {}
  // ★2026-09-05 修复（"关闭视频卡后还有声音流出、没随卡片一起关闭"）：
  //   声音来自【源页】——openPreview 的抖音分支会调 playInSourceTab 让源页继续播。
  //   此前关闭预览只清理侧栏元素，从不暂停源页 → 用户听到"关了还在响"。
  //   现对称处理：仅当本次预览【确实触发过源页播放】才暂停源页（避免误停用户自己开的视频）。
  if (window.__hmdaoPreviewStartedPlayback != null) {
    const __pauseTab = window.__hmdaoPreviewStartedPlayback;
    window.__hmdaoPreviewStartedPlayback = null;
    try { pauseInSourceTab(__pauseTab); } catch (_) {}
  }
  document.getElementById('previewOverlay').classList.remove('open');
  const v = document.getElementById('previewVideo'); v.pause(); v.removeAttribute('src');
  try { v.load(); } catch (_) {} // ★2026-08-22 修复（"关闭预览有缓存声音"）：removeAttribute('src') 后必须 load() 才释放解码器，否则部分浏览器仍残留音轨
  const a = document.getElementById('previewAudio'); a.pause(); a.removeAttribute('src');
  try { a.load(); } catch (_) {}
  // ★2026-08-22 修复（"关闭预览有缓存声音"真凶）：悬停抽帧单例 hoverVideoEl（3149行）在 closePreview 里完全没停，
  // 导致用户此前悬停过的卡片视频仍在后台播放出声。此处彻底销毁该单例。
  if (typeof hoverVideoEl !== 'undefined' && hoverVideoEl) {
    try { if (hoverVideoEl.__hmdaoHls) { hoverVideoEl.__hmdaoHls.destroy(); hoverVideoEl.__hmdaoHls = null; } } catch (_) {}
    try { hoverVideoEl.pause(); hoverVideoEl.removeAttribute('src'); hoverVideoEl.load(); } catch (_) {}
    if (hoverVideoEl.parentElement) { try { hoverVideoEl.parentElement.removeChild(hoverVideoEl); } catch (_) {} }
    hoverVideoEl = null;
  }
  stopHoverAudio(); // 打开大窗时停掉悬停试听（1484 行同样调用），关闭时同样保险
  // 释放 3D 预览的 WebGL 上下文（侧栏 WebGL 上下文数量有限，不释放会累积到无法创建）
  try { window.__hmdaoModel3D && window.__hmdaoModel3D.disposeViewer(); } catch (_) {}
  const mvp = document.getElementById('pvModelViewport'); if (mvp) { mvp.innerHTML = ''; mvp.style.display = 'none'; }
  if (window.__playingPageIdx != null) {
    chrome.runtime.sendMessage({ type: 'HMDAO_STOP_PAGE_AUDIO', audioIdx: window.__playingPageIdx }).catch(() => {});
    window.__playingPageIdx = null;
  }
  if (window.__hlsInstance) { window.__hlsInstance.destroy(); window.__hlsInstance = null; }
  // ★2026-09-01 修复（用户实测「关闭视频卡片后声音一直在、没随卡片关闭结束」根因）：
  //   closePreview 此前清了 hoverVideoEl / hls / dash blob / 悬停试听 / 页面音频，
  //   却【唯独漏掉了主预览元素 previewVideo 与抖音 WebRTC 帧流】——
  //   vid 仍处 play() 状态，关闭面板只是隐藏 DOM，音频继续输出；
  //   且 stopDouyinFrameStream 未调用 → 源页帧流定时器与 RTCPeerConnection 持续占用。
  //   （对照：切卡片路径 1810 行是有调 stopDouyinFrameStream 的，关闭路径漏了。）
  //   补两道保险：① 停抖音帧流（内部已 pause + srcObject=null + removeAttribute + load + 隐藏）
  //              ② 对 previewVideo 再兜底清理一次（帧流未启动时的裸 src 播放场景）
  try { if (typeof stopDouyinFrameStream === 'function') stopDouyinFrameStream(); } catch (_) {}
  try {
    const pvEl = document.getElementById('previewVideo');
    if (pvEl) {
      try { pvEl.pause(); } catch (_) {}
      try { pvEl.srcObject = null; } catch (_) {}
      try { pvEl.removeAttribute('src'); } catch (_) {}
      try { pvEl.load(); } catch (_) {}
      pvEl.style.display = 'none';
    }
  } catch (_) {}
  const pvImgEl = document.getElementById('previewImg');
  if (pvImgEl) pvImgEl.style.display = 'none';
  if (window.__mergedDashBlobUrl) { try { URL.revokeObjectURL(window.__mergedDashBlobUrl); } catch (_) {} window.__mergedDashBlobUrl = null; }
  // ★2026-09-04 兜底（用户实测「点卡后只有声音没画面，关闭后声音仍不停」）：
  //   声音可能来自动态创建的媒体元素（DASH 合并 blob、音频轨直链、临时 video），
  //   逐个枚举容易漏 —— 这里统一杀掉侧栏文档里的全部 video/audio。
  try {
    document.querySelectorAll('video, audio').forEach((m) => {
      try { m.pause(); } catch (_) {}
      try { m.removeAttribute('src'); } catch (_) {}
      try { m.load(); } catch (_) {}
    });
  } catch (_) {}
  window.__previewAsset = null;
}

// =====================================================================
// ★2026-09-05 侧栏健康自检 + 媒体泄漏监视器（用户可在侧栏 DevTools 控制台直接使用）
//   window.__hmdaoHealth()          → 一键输出健康报告（资产/媒体元素/缓存/内存/定时器）
//   window.__hmdaoWatchMedia(true)  → 监视 video/audio 的创建/播放/移除（定位"关卡后仍有声音"）
//   window.__hmdaoWatchMedia(false) → 关闭监视
// =====================================================================
window.__hmdaoHealth = function () {
  const rep = { ts: new Date().toISOString() };
  try {
    // 1) 资产规模
    rep.assets = Array.isArray(window.assets) ? window.assets.length : -1;
    rep.batchAssets = (typeof batchAssets !== 'undefined' && Array.isArray(batchAssets)) ? batchAssets.length : -1;
    rep.selected = (window.selected && window.selected.size) || 0;
    rep.batchSelection = (window.batchSelection && window.batchSelection.size) || 0;
    rep.lastScanSig = window.__hmdaoLastScanSig ? String(window.__hmdaoLastScanSig).slice(0, 40) : null;
    // 2) DOM 内媒体元素（声音残留的直接证据）
    const media = Array.from(document.querySelectorAll('video, audio'));
    rep.mediaInDom = media.length;
    rep.mediaPlaying = media.filter((m) => !m.paused && !m.ended).map((m) => ({
      tag: m.tagName.toLowerCase(),
      src: String(m.currentSrc || m.src || m.srcObject || '').slice(0, 80),
      muted: m.muted, volume: m.volume,
      inDom: m.isConnected,
      cls: (m.className || '').toString().slice(0, 40),
    }));
    rep.mediaWithSrc = media.filter((m) => m.currentSrc || m.src).length;
    rep.mediaDetached = media.filter((m) => !m.isConnected).length;
    // 3) 缓存/队列状态（缩略图治理）
    rep.coverCache = (typeof HMDAO_COVER_CACHE !== 'undefined') ? HMDAO_COVER_CACHE.size : -1;
    rep.coverQueue = (typeof HMDAO_COVER_QUEUE !== 'undefined') ? HMDAO_COVER_QUEUE.length : -1;
    rep.coverActive = (typeof HMDAO_COVER_ACTIVE !== 'undefined') ? HMDAO_COVER_ACTIVE : -1;
    rep.frameBudget = (typeof HMDAO_FRAME_BUDGET !== 'undefined') ? HMDAO_FRAME_BUDGET : -1;
    rep.imgDimensions = (typeof imgDimensions !== 'undefined' && imgDimensions) ? Object.keys(imgDimensions).length : -1;
    // 4) 渲染状态
    rep.domCards = document.querySelectorAll('#list .card').length;
    rep.lastRenderSig = (typeof __lastRenderSig !== 'undefined' && __lastRenderSig) ? String(__lastRenderSig).length : 0;
    rep.hoverVideoAlive = (typeof hoverVideoEl !== 'undefined' && !!hoverVideoEl);
    // 5) 内存（Chrome 专属，精度粗但足够看趋势）
    if (performance.memory) {
      rep.heapMB = Math.round((performance.memory.usedJSHeapSize / 1048576) * 10) / 10;
      rep.heapLimitMB = Math.round(performance.memory.jsHeapSizeLimit / 1048576);
    }
  } catch (e) { rep.error = String(e && e.message || e); }
  console.log('%c[HMDAO 健康报告]', 'color:#1ea7fd;font-weight:bold', rep);
  return rep;
};

let __hmdaoMediaObserver = null;

// ★2026-09-05：一键停止全部媒体（侧栏 + 源页）。
//   场景：① 关卡片后源页仍在响 ② 悬停音频卡触发的试听停不下来 ③ 抖音自动连播。
//   调用方式：侧栏控制台 window.__hmdaoStopAllMedia()，或按 Esc（预览弹层打开时 Esc 仍走关闭逻辑）。
window.__hmdaoStopAllMedia = function () {
  try { if (typeof stopHoverAudio === 'function') stopHoverAudio(); } catch (_) {}
  try { if (typeof stopDouyinFrameStream === 'function') stopDouyinFrameStream(); } catch (_) {}
  try {
    document.querySelectorAll('video, audio').forEach((m) => { try { m.pause(); } catch (_) {} });
  } catch (_) {}
  try {
    if (window.__playingPageIdx != null) {
      chrome.runtime.sendMessage({ type: 'HMDAO_STOP_PAGE_AUDIO', audioIdx: window.__playingPageIdx }).catch(() => {});
      window.__playingPageIdx = null;
    }
  } catch (_) {}
  try { chrome.runtime.sendMessage({ type: 'HMDAO_STOP_AUDIO_IN_PAGE', audioId: 'hover' }).catch(() => {}); } catch (_) {}
  // 源页主播放器（若本次预览触发过播放）
  if (window.__hmdaoPreviewStartedPlayback != null) {
    const t = window.__hmdaoPreviewStartedPlayback;
    window.__hmdaoPreviewStartedPlayback = null;
    try { pauseInSourceTab(t); } catch (_) {}
  }
  return '已停止侧栏与源页的全部媒体播放';
};
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  try {
    const ov = document.getElementById('previewOverlay');
    if (ov && ov.classList.contains('open')) return; // 弹层打开时 Esc 走既有的关闭逻辑（内部会同步暂停源页）
    window.__hmdaoStopAllMedia();
    console.log('[HMDAO] Esc → 已停止全部媒体播放');
  } catch (_) {}
});

window.__hmdaoWatchMedia = function (on) {
  try {
    if (__hmdaoMediaObserver) { __hmdaoMediaObserver.disconnect(); __hmdaoMediaObserver = null; }
    if (!on) { console.log('[HMDAO] 媒体监视器已关闭'); return; }
    // 拦截 play 事件（捕获阶段，覆盖未来创建的元素）——"关卡后仍有声音"的直接证据源
    const onPlay = (e) => {
      const m = e.target;
      if (m && (m.tagName === 'VIDEO' || m.tagName === 'AUDIO')) {
        console.warn('[HMDAO][media-watch] ▶ 播放:', m.tagName.toLowerCase(),
          'src=' + String(m.currentSrc || m.src || m.srcObject || '').slice(0, 90),
          'inDom=' + m.isConnected, 'muted=' + m.muted);
      }
    };
    document.addEventListener('play', onPlay, true);
    // 监视 DOM 增删（卡片重建/媒体元素挂载与卸载）
    __hmdaoMediaObserver = new MutationObserver((muts) => {
      for (const mu of muts) {
        for (const n of mu.addedNodes) {
          if (n.nodeType === 1 && (n.tagName === 'VIDEO' || n.tagName === 'AUDIO' || n.querySelector && n.querySelector('video,audio'))) {
            console.log('[HMDAO][media-watch] + 挂载:', n.tagName.toLowerCase(), (n.className || '').toString().slice(0, 40));
          }
        }
        for (const n of mu.removedNodes) {
          const medias = (n.tagName === 'VIDEO' || n.tagName === 'AUDIO') ? [n]
            : (n.querySelectorAll ? Array.from(n.querySelectorAll('video,audio')) : []);
          for (const m of medias) {
            if (!m.paused) {
              console.warn('[HMDAO][media-watch] ⚠ 移除了仍在播放的媒体元素（这就是声音残留）:',
                m.tagName.toLowerCase(), 'src=' + String(m.currentSrc || m.src || '').slice(0, 90));
            }
          }
        }
      }
    });
    __hmdaoMediaObserver.observe(document.getElementById('list') || document.body, { childList: true, subtree: true });
    console.log('[HMDAO] 媒体监视器已开启：滚动/点击卡片，观察 play 与"移除仍在播放的媒体"告警');
  } catch (e) { console.warn('[HMDAO][media-watch] 启动失败:', e && e.message); }
};

// ===== DASH 1080p+ 音视频合并为单文件 MP4（纯 JS：mp4box.js 解封装 + mp4-muxer 封装）=====
function startDashPreview(a, vid, dash) {
  const vUrl = (dash.video && dash.video[0] && dash.video[0].baseUrl) || '';
  const aUrl = (dash.audio && dash.audio[0] && dash.audio[0].baseUrl) || '';
  window.__previewAsset = { ...a, url: vUrl };
  vid.src = vUrl; vid.load(); vid.play().catch(() => {});
  if (!vUrl) { setStatus('⚠ 未解析到 DASH 视频轨', true); return; }
  setStatus('DASH 分离轨：先播视频轨，正在合并音视频为单文件…');
  if (aUrl && typeof mergeDashToMp4 === 'function') {
    const dashReferer = (a && a.platform && /douyin|bytedance|tiktok/i.test(a.platform)) ? 'https://www.douyin.com/'
      : (a && a.platform && /youtube|googlevideo/i.test(a.platform)) ? 'https://www.youtube.com/'
      : 'https://www.bilibili.com/';
    mergeDashToMp4(vUrl, aUrl, dashReferer).then((blob) => {
      const url = URL.createObjectURL(blob);
      cacheDragBlob(a, blob, 'video/mp4'); // 合并后的单文件 MP4 → 可拖到桌面/文件夹
      window.__mergedDashBlobUrl = url;
      const name = (deriveFilename(a).replace(/\.[^.]+$/i, '') || 'video') + '_merged.mp4';
      window.__previewAsset = { ...a, url, __mergedDash: true, __mergedName: name };
      vid.src = url; vid.load(); vid.play().catch(() => {});
      setStatus('✅ 已合并为单文件 MP4（含音画），点「下载」保存');
    }).catch((e) => {
      setStatus('⚠ 音视频合并失败（' + (e && e.message ? e.message : '未知') + '），仅预览视频轨；下载将走分轨流程', true);
    });
  }
}

// 把 DASH 的视频轨 + 音频轨交后端 ffmpeg 合成为含音画单文件，再拉回侧栏（返回 Blob）
// 与下载链路同源（/api/media/merge-dash），产物经后端 ffprobe 自检保证含音画。
async function mergeDashForPreview(a) {
  const apiBase = (window.DdayupConfig && typeof window.DdayupConfig.getApiBaseSync === 'function')
    ? window.DdayupConfig.getApiBaseSync()
    : 'http://127.0.0.1:3000';
  // ★平台判定优先用 a.platform（权威字段），URL 关键字仅作兜底：
  //   仅看 URL 会漏判（例如本地/代理域、或 CDN 域名不含平台关键字的情况），
  //   一旦漏判就带错 Referer → 防盗链 CDN 403 → 合并失败。
  const isDy = /douyin|tiktok|bytedance/i.test(a.platform || '')
    || /douyin|bytedance|tiktok|douyinvod|iesdouyin|v26-web/i.test(a.url || '');
  const referer = isDy ? 'https://www.douyin.com/' : deriveMediaReferer(a.url, window.__sourcePageUrl || '');
  const resp = await fetch(apiBase + '/api/media/merge-dash', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(withDeviceAuthBody({
      videoUrl: a.downloadAddr || a.url,
      audioUrl: a.dashAudio,
      referer,
      filename: (a.title || deriveFilename(a) || 'video'),
    }, await getExtDeviceAuth())),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.ok) throw new Error((data && data.error) || ('HTTP ' + resp.status));
  const fileResp = await fetch(withDeviceAuth(apiBase + data.fileUrl, await getExtDeviceAuth()));
  if (!fileResp.ok) throw new Error('拉取合并产物失败 HTTP ' + fileResp.status);
  return await fileResp.blob();
}

// 后台带 Referer 拉取媒体字节 → 本地 blob → <video> 播放（绕过侧栏元素的签名/Referer 限制）
async function fallbackCdnFetch(a, vid) {
  const sourcePage = window.__sourcePageUrl || '';
  // ★2026-09-02 修复（真机冒烟"只有画面没声音"根因）：
  //   抖音是 DASH 分离轨 —— a.url 是【视频轨（无音）】，a.dashAudio 是配对的音频轨。
  //   此前预览只拉 a.url 播 → 必然有画面、没声音。
  //   修复：资产带 dashAudio 时，交后端 ffmpeg 合成含音画单文件再播放
  //   （字节不经过浏览器做合并，且产物经后端 ffprobe 自检，已 6/6 验证）。
  //   后端不可用 → 回退下方原逻辑（仅视频轨、无声），并给出明确提示，绝不静默。
  if (a && a.type === 'video' && a.dashAudio && /^https?:/i.test(a.dashAudio)) {
    try {
      setStatus('⏳ 正在合成含音画单文件（后端 ffmpeg）…');
      const blob = await mergeDashForPreview(a);
      const url = URL.createObjectURL(blob);
      cacheDragBlob(a, blob, 'video/mp4');
      window.__previewAsset = { ...a, url, __mergedDash: true };
      vid.src = url; vid.load(); vid.play().catch(() => {});
      setStatus('✅ 已合成含音画单文件（' + Math.round((blob.size || 0) / 1024) + 'KB），可直接播放/下载');
      return;
    } catch (e) {
      setStatus('⚠ 音视频合并失败（' + ((e && e.message) || '未知') + '），先播放视频轨（无声音）', true);
    }
  }
  // ★2026-08-24 修复：优先用 a.downloadAddr（抖音 REFRESH_FROM_PAGE 返回的新鲜直链），
  //   否则抖音 a.url（stale 扫描直链）拉字节 403 → blob 是错误页 → <video> 不播。
  const effectiveUrl = a.downloadAddr || a.url;
  const referer = deriveMediaReferer(effectiveUrl, sourcePage);
  // ★2026-08-18 修复：新片场 stock.xinpianchang.com/footage/details/<id> yt-dlp 不支持（XinpianChang extractor
  //   只认 www.xinpianchang.com/a\d+ 文章页），走下方后端 yt-dlp 必返回错误 → fetchMediaViaBackground 拉错误字节
  //   → blob 是 HTML/JSON → <video src=blob:HTML> 报 source not supported。必须先经 background 的 tryXinpianchang
  //   （mod-api / 内嵌 JSON）解析出真实 mp4 直链，再 fetchMediaViaBackground 拉字节→blob→<video> 播放。
  try {
    const xpPage = a.playerUrl || a.ytPageUrl || a.biliPageUrl || sourcePage || a.url || '';
    if (/xinpianchang\.com/i.test(xpPage) && /\/footage\/details\//.test(xpPage)) {
      setStatus('新片场素材：回源页解析直链（tryXinpianchang）…');
      const r = await chrome.runtime.sendMessage({ type: 'HMDAO_REFRESH_FROM_PAGE', assetUrl: xpPage });
      const mp4Url = r && r.ok && typeof r.url === 'string' ? r.url : '';
      if (mp4Url && /\.mp4(\?|$)/i.test(mp4Url)) {
        const fm = await fetchMediaViaBackground(mp4Url, referer);
        if (fm && fm.ok && fm.b64) {
          const bytes = b64ToBytes(fm.b64);
          const blob = new Blob([bytes], { type: 'video/mp4' });
          const url = URL.createObjectURL(blob);
          cacheDragBlob(a, blob, 'video/mp4');
          vid.src = url; vid.load(); vid.play().catch(() => {});
          setStatus('✅ 新片场预览中（' + Math.round(fm.size / 1024) + 'KB）');
          return;
        }
        // 解析出直链但 fetch 受限/签名过期 → 退到直连播放（部分预览可看）
        vid.src = mp4Url; vid.load(); vid.play().catch(() => {});
        setStatus('⚠ 新片场直链已解析，但后台拉取受限，尝试直连预览…');
        return;
      }
      setStatus('⚠ 新片场素材直链未解析到（tryXinpianchang 返回空）', true);
      return;
    }
  } catch (_) {}
  // ★2026-08-18 修复：抖音/TikTok 已有 CDN 直链（dyUrls 捕获 / RENDER_DATA play_addr），
  // 应走后台带 Referer 拉字节（fallbackCdnRefetch），不走 yt-dlp——
  // 抖音 yt-dlp extractor 需登录 cookie、后端 spawn 单文件 yt-dlp.exe 弹黑窗、且解析不稳。
  // 把抖音从 yt-dlp 分支排除，直接 fall through 到 line 2816 的 fallbackCdnRefetch。
  const isDouyinLike = /douyin|bytedance|tiktok|douyinvod|iesdouyin/i.test(
    (a.playerUrl || a.url || '') + ' ' + (a.source || '') + ' ' + (window.__sourcePageUrl || '')
  );
  if (isDouyinLike) {
    // ★2026-08-23 数据驱动修复（实测：点卡片不匹配、点源页刷新才匹配）：
    //   卡片 a.url 是历史扫描值（可能空/过期/错节点），直接用 → 与当前源页视频对不上。
    //   实测「源页刷新」走 HMDAO_REFRESH_FROM_PAGE → extractFreshVideoUrl（用源页 RENDER_DATA +
    //   修正锚点 videoDetail.awemeId）能精准拿到当前视频直链。故点击卡片也先实时重解析，
    //   用返回的准 url 覆盖 a.url 后再 fallbackCdnRefetch，使「点卡片」=「点源页刷新」同一正确路径。
    const hintUrl = a.url || a.playerUrl || (a.awemeId ? ('https://www.douyin.com/video/' + a.awemeId) : '') || window.__sourcePageUrl || '';
    setStatus('正在用源页实时解析当前视频…');
    chrome.runtime.sendMessage({ type: 'HMDAO_REFRESH_FROM_PAGE', assetUrl: hintUrl }).then((r) => {
      let awemeId = a.awemeId || '';
      let playerUrl = a.playerUrl || '';
      if (r && r.ok && r.awemeId) awemeId = r.awemeId;
      if (r && r.ok && r.playerUrl) playerUrl = r.playerUrl;
      // ★2026-08-24 修复（实测「点卡片不播放」根因）：HMDAO_REFRESH_FROM_PAGE 返回字段是 r.url（非 downloadAddr），
      //   原代码写 r.downloadAddr → 永远 undefined → 侧栏 trySidePanelPlay 拿空 url → 直接 return false 不播。
      //   改用 r.url（新鲜直链）覆盖 a.downloadAddr，侧栏才能 fallbackCdnRefetch 预览。
      // ★2026-09-03 修复（合集多集数）：只有「本卡片 awemeId 与源页返回的一致」时才覆盖 downloadAddr，
      //   否则保留本卡片专属直链，避免自动播放的下一集把 downloadAddr 改成别的集 → 预览对不上。
      const refAweme = (r && r.awemeId) ? String(r.awemeId).replace(/[^\w]/g, '') : '';
      const cardAweme = (a.awemeId) ? String(a.awemeId).replace(/[^\w]/g, '') : '';
      if (r && r.ok && r.url && (!cardAweme || !refAweme || cardAweme === refAweme)) {
        a.downloadAddr = r.url; // 新鲜直链，优先侧栏播放
      }
      // 本集标题也按 awemeId 对齐写入，确保下载文件名带当前集而不是统一合集名
      if (r && r.ok && r.desc && !a.title) a.title = r.desc;

      // ★2026-08-23 核心诉求落地：抖音视频「在源页继续播放」
      //   1) 立即让源页继续播：源页 video 本来就在播，play() 零风险，绝不 tabs.update 跳页/重载
      //      —— 直接满足用户核心需求，且源视频绝不会被侧栏任何操作暂停/中断。
      //   2) 侧栏后台试播预览（best-effort）：若防盗链放行则从字节预览，否则静默失败不影响源页。
      //   两项并行：源页播放是主保障，侧栏预览是附加。彻底消除"点击卡片导致源视频暂停"的旧 bug。
      // ★2026-09-05：记录"本次预览触发了源页播放"，供 closePreview 对称暂停（消除"关卡还有声音"）
      getSourceTabId().then((tabId) => {
        if (!tabId) return;
        playInSourceTab(tabId);
        window.__hmdaoPreviewStartedPlayback = tabId;
      });

      const trySidePanelPlay = (url) => {
        if (!url) return false;
        try { fallbackCdnRefetch(a, vid, referer); return true; } catch (_) { return false; }
      };
      if (a.downloadAddr && trySidePanelPlay(a.downloadAddr)) {
        setStatus('✅ 源页继续播放中；侧栏后台尝试预览（抖音防盗链可能不可见）');
      } else if (playerUrl && trySidePanelPlay(playerUrl)) {
        setStatus('✅ 源页继续播放中；侧栏后台尝试预览');
      } else {
        setStatus('✅ 源页继续播放中');
      }
    }).catch(() => {
      // 解析失败也不跳页：源页继续播 + 侧栏退到后台拉取
      getSourceTabId().then((tabId) => {
        if (!tabId) return;
        playInSourceTab(tabId);
        window.__hmdaoPreviewStartedPlayback = tabId;
      });
      try { fallbackCdnRefetch(a, vid, referer); }
      catch (_) { setStatus('✅ 源页继续播放中'); }
    });
    return;
  }
  // yt-dlp 多平台统一预览（YouTube / B站等）
  if (isYtDlpPlatform(a) || a.ytVideoId || a.biliVideoId) {
    // ★2026-08-30 防御：biliVideoId/ytVideoId 可能是字符串 'null'（页面 JSON 里的 null 被 stringify），
    //   直接拼接会产出 /video/null → 404 + 控制台 "Unexpected token '<'" 报错，污染源页控制台。
    //   现统一过滤（与 derivePlatformVideoPageUrl 一致）。
    const safeBv = (a.biliVideoId && a.biliVideoId !== 'null' && /^BV/i.test(a.biliVideoId)) ? a.biliVideoId : '';
    const safeYt = (a.ytVideoId && a.ytVideoId !== 'null') ? a.ytVideoId : '';
    const safeBiliPage = (a.biliPageUrl && !/\/null$/i.test(a.biliPageUrl)) ? a.biliPageUrl : '';
    const videoPageUrl = a.playerUrl
      || a.ytPageUrl
      || safeBiliPage
      || (safeYt ? ('https://www.youtube.com/watch?v=' + safeYt) : '')
      || (safeBv ? ('https://www.bilibili.com/video/' + safeBv) : '')
      || sourcePage;
    setStatus('正在通过后端 yt-dlp 获取视频直链…');
    const apiBase = await getCloudApiBase();
    // 抖音场景带上浏览器匿名 cookie（破解 Fresh cookies needed），其他平台不加
    let dyCookie = '';
    if (/douyin|bytedance/i.test(videoPageUrl)) {
      const cf = await buildDouyinCookiesFile();
      if (cf) dyCookie = '&cookies_file=' + encodeURIComponent(cf);
    }
    // 同时拉取格式列表（用于分辨率选择）
    const fmtP = fetch(withDeviceAuth(apiBase + '/api/platform/ytdlp?action=formats&url=' + encodeURIComponent(normalizeYtdlpDouyinUrl(videoPageUrl)) + dyCookie, await getExtDeviceAuth()), { credentials: 'omit' })
      .then(r => r.json()).catch(() => null);
    const urlP = fetch(withDeviceAuth(apiBase + '/api/platform/ytdlp?action=extract&url=' + encodeURIComponent(normalizeYtdlpDouyinUrl(videoPageUrl)) + dyCookie, await getExtDeviceAuth()), { credentials: 'omit' })
      .then(r => r.json()).catch(() => null);

    Promise.all([urlP, fmtP]).then(([ytData, fmtData]) => {
      if (ytData && ytData.url) {
        // 填充格式选择器
        if (fmtData && fmtData.formats) {
          window.__ytFormats = fmtData.formats;
          buildYoutubeFormatSelector(fmtData.formats);
        }
        // 2026-08-02 兜底：部分旧后端会把优酷/B站封面图（m.ykimg.com / hdslb.com）误当直链返回。
        // 若 ytData.url 是图片缩略图，尝试 urls 数组里的下一个真实媒体地址（通常是 m3u8/mp4）。
        const thumbDomains = ['i.ytimg.com', 'hdslb.com', '/pic.', 'm.ykimg.com', 'ykimg.com'];
        const isThumb = (u) => u && thumbDomains.some((d) => u.includes(d));
        const urls = Array.isArray(ytData.urls) ? ytData.urls.filter((u) => /^https?:\/\//.test(u)) : [ytData.url];
        let directUrl = urls.find((u) => !isThumb(u)) || ytData.url;
        ytData.url = directUrl; urls[0] = directUrl;
        setStatus('正在加载视频（' + (ytData.title || '') + '）…');

        // ★2026-08-11 修复：优酷 yt-dlp 返回的是 m3u8 播放列表（`/playlist/m3u8?...`），不能走 fetchMediaViaBackground
        //   把 m3u8 文本当 mp4 字节喂给 <video>。判断路径段或扩展名命中 m3u8 后，改用 hls.js 挂载；
        //   同时给 pl-ali.youku.com 等 CDN 域注入 Referer=v.youku.com。
        const finalUrlIsM3u8 = /[/.]m3u8(\?|&|$)/i.test(ytData.url);
        if (finalUrlIsM3u8 && window.Hls && window.Hls.isSupported()) {
          // 按需安装优酷 CDN Referer 规则，否则 hls.js 拉 m3u8/.ts 会 403
          chrome.runtime.sendMessage({ type: 'HMDAO_INSTALL_YOUKU_REFERER' }).catch(() => {});
          try {
            const hls = new window.Hls();
            hls.loadSource(ytData.url);
            hls.attachMedia(vid);
            hls.on(window.Hls.Events.MANIFEST_PARSED, () => { try { vid.play().catch(() => {}); } catch (_) {} });
            vid.__hmdaoHls = hls;
            setStatus('✅ 优酷流式播放中（hls.js + dNR Referer）');
            return;
          } catch (_) { /* hls 挂载失败，降级到下方 fetchMediaViaBackground */ }
        }

        // 优化：先尝试 ytBytes（播放器缓存字节，秒开）；
        // 失败才走 yt-dlp 直链的后台拉取（需全量下载，较慢）
        if (isYoutubeMedia(a.url) || a.ytVideoId) {
          getYtBytesViaBackground(a.url || ytData.url).then(yt => {
            if (yt && yt.ok && yt.b64 && yt.size > 1024) {
              const bytes = b64ToBytes(yt.b64);
              const blob = new Blob([bytes], { type: 'video/mp4' });
              const url = URL.createObjectURL(blob);
              cacheDragBlob(a, blob, 'video/mp4');
              vid.src = url; vid.load(); vid.play().catch(() => {});
              setStatus('✅ 播放中（缓存字节 ' + Math.round(yt.size / 1024) + 'KB）');
              return;
            }
            // ytBytes 不可用 → 回退后台全量拉取
            setStatus('正在从后端拉取视频流（首次需全量下载，请稍候…）');
            fetchMediaViaBackground(ytData.url, referer).then(fm => {
              if (fm && fm.ok && fm.b64) {
                const bytes = b64ToBytes(fm.b64);
                const blob = new Blob([bytes], { type: 'video/mp4' });
                const url = URL.createObjectURL(blob);
                cacheDragBlob(a, blob, 'video/mp4');
                vid.src = url; vid.load(); vid.play().catch(() => {});
                setStatus('✅ 正在播放（' + Math.round(fm.size / 1024) + 'KB）');
              } else {
                vid.src = ytData.url; vid.load(); vid.play().catch(() => {});
                setStatus('⚠ 后台拉取失败，直连播放（可能受限）');
              }
            }).catch(() => {
              vid.src = ytData.url; vid.load(); vid.play().catch(() => {});
            });
          }).catch(() => {
            fetchMediaViaBackground(ytData.url, referer).then(fm => {
              if (fm && fm.ok && fm.b64) {
                const bytes = b64ToBytes(fm.b64);
                const blob = new Blob([bytes], { type: 'video/mp4' });
                vid.src = URL.createObjectURL(blob);
                vid.load(); vid.play().catch(() => {});
                setStatus('✅ 正在播放（' + Math.round(fm.size / 1024) + 'KB）');
              }
            }).catch(() => { setStatus('⚠ 视频加载失败'); });
          });
          return;
        }
        // 非 YouTube 媒体：走原后台拉取逻辑
        fetchMediaViaBackground(ytData.url, referer).then(fm => {
          if (fm && fm.ok && fm.b64) {
            const bytes = b64ToBytes(fm.b64);
            const blob = new Blob([bytes], { type: 'video/mp4' });
            vid.src = URL.createObjectURL(blob);
            vid.load(); vid.play().catch(() => {});
            setStatus('✅ 正在播放（' + Math.round(fm.size / 1024) + 'KB）');
          }
        });
        return;
      }
      setStatus('⚠ YouTube 直链获取失败：后端未安装 yt-dlp。请在 Ddayup Web App（127.0.0.1:3000）的「模型下载 → 运行时依赖」点「一键安装 yt-dlp」后重试');
      checkYtDlp().then((st) => { if (st === 'missing') ensureYtDlpPrompt(); });
    }).catch(() => {
      setStatus('⚠ 后端 yt-dlp 链路不可用，请确保 Ddayup Web App 已启动（127.0.0.1:3000）且已安装 yt-dlp 运行时');
      fallbackCdnRefetch(a, vid, referer);
    });
    return;
  }
  fallbackCdnRefetch(a, vid, referer);
}

// ===== YouTube 字节转码为可播放 MP4（mp4box.js + mp4-muxer） =====
// UMP 字节是 ISOBMFF 容器（类似 DASH 片段），用 mp4box 解封装→mp4-muxer 重封装为标准 MP4。
function tryRemuxYtBytesToMp4(rawBytes, a, vid) {
  if (typeof MP4Box === 'undefined' || typeof Mp4Muxer === 'undefined') {
    // 库未加载 → 直接给兜底提示
    const ytWatch = a.ytVideoId ? ('https://www.youtube.com/watch?v=' + a.ytVideoId) : (a.ytPageUrl || '');
    if (ytWatch) {
      setStatus('⚠ 转码库未加载，请 <a href="' + ytWatch + '" target="_blank" style="color:#7cc4ff">在 YouTube 源页预览</a>', true);
      document.getElementById('previewInfo').innerHTML = '<a href="' + ytWatch + '" target="_blank" style="color:#7cc4ff;font-size:12px">🔗 在 YouTube 源页预览（点击跳转）</a>';
      document.getElementById('previewInfo').style.display = '';
    } else {
      setStatus('⚠ 无法播放此视频，请在源页播放后再试', true);
    }
    return;
  }
  try {
    const demux = dashDemux(rawBytes.buffer || rawBytes);
    demux.then(({ file, id, info, samples }) => {
      if (!samples || samples.length === 0) throw new Error('no samples');
      const muxer = new Mp4Muxer.Muxer({
        target: new Mp4Muxer.ArrayBufferTarget(),
        video: {
          codec: info.codec ? muxerVideoCodec(info.codec) : 'avc',
          width: (info.video && info.video.width) || 854,
          height: (info.video && info.video.height) || 480,
        },
        fastStart: 'in-memory',
      });
      // ★2026-09-02 与 dash-merge-worker.js / media-transcode.js 同步修复两处：
      //   ① 传入原始字节副本，让 getVideoCodecPrivate 能走字节级兜底
      //      （浏览器里 MP4Box.DataStream 实测不可用，只靠 mp4box 路径必然拿到 null）；
      //   ② decoderConfig 字段名必须是 description（mp4-muxer 不认 codecPrivate，
      //      写成 codecPrivate 会让 avcC 变空内容 → 产物不可播放）。
      let cp = null;
      try {
        cp = getVideoCodecPrivate(file, id, typeof cloneTrackBytes === 'function' ? cloneTrackBytes(rawBytes) : rawBytes);
      } catch (_) { cp = null; }
      const ts = info.timescale || 1;
      for (const s of samples) {
        const chunk = new EncodedVideoChunk({
          type: s.is_sync ? 'key' : 'delta',
          timestamp: Math.round((s.cts / ts) * 1e6),
          duration: Math.max(1, Math.round((s.duration / ts) * 1e6)),
          data: s.data,
        });
        muxer.addVideoChunk(chunk, cp ? { decoderConfig: { codec: info.codec, description: cp } } : undefined);
      }
      muxer.finalize();
      const { buffer } = muxer.target;
      const blob = new Blob([buffer], { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);
      cacheDragBlob(a, blob, 'video/mp4');
      vid.removeEventListener('error', () => {});
      vid.src = url; vid.load(); vid.play().catch(() => {});
      setStatus('✅ 已转码为 MP4 播放（' + Math.round(buffer.byteLength / 1024) + 'KB）');
    }).catch(() => {
      // mp4box 也无法解析 → 兜底链接
      const ytWatch = a.ytVideoId ? ('https://www.youtube.com/watch?v=' + a.ytVideoId) : (a.ytPageUrl || '');
      if (ytWatch) {
        setStatus('⚠ 字节无法转码，请 <a href="' + ytWatch + '" target="_blank" style="color:#7cc4ff">在 YouTube 源页预览</a>', true);
        document.getElementById('previewInfo').innerHTML = '<a href="' + ytWatch + '" target="_blank" style="color:#7cc4ff;font-size:12px">🔗 在 YouTube 源页预览（点击跳转）</a>';
        document.getElementById('previewInfo').style.display = '';
      } else {
        setStatus('⚠ 无法解码此视频字节，请在源页播放后再试', true);
      }
    });
  } catch (_) {
    setStatus('⚠ 转码异常，请在源页预览', true);
  }
}

// ★2026-08-22 修复根因：window.__hmdao_sourceTabId 从未被赋值（仅 extracted_check 快照里有）。
// 实际应从 background 的 SOURCE_TAB_ID 获取。最稳妥：直接查询当前活动标签；
// 找不到则回退到任意 http(s) 的抖音/视频站点，确保抖音音频/视频回源带 Cookie 的 tab 能被找到。
async function getSourceTabId() {
  try {
    const active = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active && active[0] && active[0].id != null &&
        /^https?:/.test(active[0].url || '')) {
      return active[0].id;
    }
  } catch (_) {}
  // 兜底：找一个抖音/抖音网页标签
  try {
    const all = await chrome.tabs.query({});
    const hit = all.find((t) => /douyin|douyinvod|tiktok|bilibili/i.test(t.url || ''));
    if (hit && hit.id != null) return hit.id;
  } catch (_) {}
  return null;
}

// ★2026-08-21：抖音合集「自动切到此集播放」流程。
//   用户点击合集非当前播放的卡片后,若后台 fetch 字节失败(签名未鉴权) → 让源 tab 跳到对应 modal_id,
//   等待 1.5s inject-main 捕获新 dyUrl,自动触发扫描并刷新侧栏。
//   注意:这是用户主动点击「▶ 切到此集播放」按钮才会触发,不会静默跳转。
async function switchDouyinEpisodeTo(assetOrId) {
  // ★2026-08-23 修复：抖音侧栏无法直播(CDN 防盗链 403)，唯一可靠路径 = 在源页播放。
  // 边界安全原则：
  //   1) 若目标视频 == 当前源页正在播放的 → 【绝不改 URL、绝不跳页】，
  //      只在当前源页文档内触发 play()（不影响浏览器正常状态，不刷新）。
  //   2) 若不同 → 用该卡片独立的 /video/<awemeId> 打开（每个视频唯一稳定页，点哪张开哪张，绝不错配）。
  let targetId = null;   // 卡片自身的真实 awemeId（=modalId 字段）
  let targetUrl = null;  // https://www.douyin.com/video/<awemeId>
  if (assetOrId && typeof assetOrId === 'object') {
    targetId = assetOrId.modalId || assetOrId.awemeId || null;
    targetUrl = assetOrId.playerUrl || (targetId ? ('https://www.douyin.com/video/' + targetId) : null);
  } else {
    targetId = assetOrId;
    targetUrl = targetId ? ('https://www.douyin.com/video/' + targetId) : null;
  }
  // ★2026-08-23 诊断：打印匹配决策，便于排查"单视频模式仍刷新"
  console.log('[HMDAO][pv] switchDouyinEpisodeTo entry: targetId=%s targetUrl=%s', targetId, targetUrl);
  const sourceTabId = await getSourceTabId();
  if (!sourceTabId) {
    setStatus('⚠ 没有源页面,请先在抖音页面扫描后再切换', true);
    return;
  }
  try {
    const tab = await chrome.tabs.get(sourceTabId);
    if (!tab || !tab.url) {
      setStatus('⚠ 源页面已关闭,无法切换', true);
      return;
    }
    // 从当前源页 URL 提取"正在播放的视频 id"，兼容三种形态：
    //   /video/<id>、jingxuan?modal_id=<id>、jingxuan?aweme_id=<id>
    let curId = '';
    try {
      const u = new URL(tab.url);
      if (u.pathname.startsWith('/video/')) {
        curId = u.pathname.split('/video/')[1] || '';
      } else {
        curId = u.searchParams.get('modal_id') || u.searchParams.get('aweme_id') || '';
      }
    } catch (_) {}
    console.log('[HMDAO][pv] 匹配: targetId=%s curId=%s tab.url=%s', targetId, curId, tab.url);

    // 情况1：目标与当前已是同一视频 → 不跳页，直接在当前页 play()
    if (targetId && curId && String(targetId) === String(curId)) {
      setStatus('✅ 就是当前播放的视频，正在源页继续播放…');
      await playInSourceTab(sourceTabId);
      return;
    }
    // 情况2：不同 → 打开该卡片独立的 /video/<awemeId> 页（点哪张开哪张，绝对正确，最小跳页）
    if (targetUrl && targetUrl !== tab.url) {
      setStatus('▶ 已在抖音源页打开该视频…');
      await chrome.tabs.update(sourceTabId, { url: targetUrl });
      setTimeout(async () => {
        try { await playInSourceTab(sourceTabId); } catch (_) {}
        try { chrome.runtime.sendMessage({ type: 'HMDAO_RESCAN_TAB', tabId: sourceTabId }); } catch (_) {}
        setStatus('已打开，等待源页重新扫描…');
      }, 1500);
      return;
    }
    setStatus('⚠ 无法定位该视频的源页地址');
  } catch (_) {
    setStatus('⚠ 切换源页面失败', true);
  }
}

// ★2026-09-11：B站合集「切到该集播放」流程（与抖音 switchDouyinEpisodeTo 对等）。
//   点击合集里非当前播放的 B站卡片后，让源 tab 跳到该卡片独立的 /video/<bvid>?p=<page>，
//   等 1.5s 让 inject-main 捕获新直链，自动触发重扫刷新侧栏。点哪张开哪张，绝不错配。
function biliEpisodeKey(u) {
  try {
    const p = new URL(u || '', 'https://www.bilibili.com');
    const m = (p.pathname + p.search).match(/\/video\/(BV\w+)/);
    if (!m) return '';
    const bv = m[1];
    const pm = p.searchParams.get('p');
    // ★2026-09-11：page 缺省也归一为 #p1，保证 p=1 卡片与源页 p=1 稳定匹配（避免漏判当前集）
    return bv + '#p' + (pm || '1');
  } catch (_) { return ''; }
}
function biliSameEpisode(a, b) {
  const ka = biliEpisodeKey(a || ''), kb = biliEpisodeKey(b || '');
  return !!ka && ka === kb;
}
async function switchBiliEpisodeTo(asset) {
  // ★边界：目标 == 当前源页正在播放的集 → 绝不跳页，只在当前源页 play()。
  let targetUrl = (asset && (asset.url || asset.biliPageUrl || asset.playerUrl)) || null;
  if (!targetUrl) { setStatus('⚠ 该集没有可用源页地址'); return; }
  const sourceTabId = await getSourceTabId();
  if (!sourceTabId) { setStatus('⚠ 没有源页面，请先在 B站页面扫描后再切换', true); return; }
  try {
    const tab = await chrome.tabs.get(sourceTabId);
    const cur = (tab && tab.url) || '';
    if (biliSameEpisode(cur, targetUrl)) {
      setStatus('✅ 就是当前播放的这集，正在源页继续播放…');
      await playInSourceTab(sourceTabId);
      return;
    }
    setStatus('▶ 已在 B站源页打开该集…');
    await chrome.tabs.update(sourceTabId, { url: targetUrl });
    setTimeout(async () => {
      try { await playInSourceTab(sourceTabId); } catch (_) {}
      try { chrome.runtime.sendMessage({ type: 'HMDAO_RESCAN_TAB', tabId: sourceTabId }); } catch (_) {}
      setStatus('已打开，等待源页重新扫描…');
    }, 1500);
  } catch (_) { setStatus('⚠ 切换源页面失败', true); }
}

// 在当前源页文档内触发 <video> 播放（滚动到可视区 + play），绕过 Chrome 自动播放策略。
// ★2026-08-23 修复（问题1「源页突然暂停/静音被改」）：
//   旧逻辑 document.querySelector('video') 会选中抖音 jingxuan 页【第一个】video（常是推荐位
//   muted 小卡片，而非主播放器），且 v.muted=false 强制取消静音，干扰用户已设置的静音态。
//   改为：优先选「正在播放且非 muted」的主播放器，否则选尺寸最大者；绝不改 muted（保持用户原静音）。
async function playInSourceTab(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const vs = Array.from(document.querySelectorAll('video'));
        if (!vs.length) return;
        let v = vs.find((x) => !x.paused && !x.ended && !x.muted);
        if (!v) {
          let maxArea = 0;
          vs.forEach((x) => {
            try {
              const r = x.getBoundingClientRect();
              const a = r.width * r.height;
              if (a > maxArea) { maxArea = a; v = x; }
            } catch (_) {}
          });
        }
        if (v) {
          try { v.scrollIntoView({ block: 'center' }); } catch (_) {}
          // 不强制 muted=false（保持用户原静音态）；若本就在播，play() 是幂等的，不造成暂停/重载。
          const p = v.play();
          if (p && p.catch) p.catch(() => {});
        }
      },
    });
  } catch (_) {}
}

// ★2026-09-05：「关闭视频卡后仍有声音流出」的根因修复配套。
//   实测健康报告 playing=[]（侧栏本身没有泄漏的播放元素），声音来自【源页】——
//   openPreview 的抖音分支会显式调 playInSourceTab 让源页视频继续播（这是产品行为：
//   侧栏直链被防盗链拦截时只能在源页看）。但关闭预览时没有任何地方暂停源页，
//   于是"关了卡片声音还在"。此处提供对称的 pauseInSourceTab，由 closePreview 在
//   「本次预览确实触发过源页播放」时调用（用 __hmdaoPreviewStartedPlayback 标记，
//   避免误停用户本来就在看的视频）。
async function pauseInSourceTab(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const vs = Array.from(document.querySelectorAll('video'));
        if (!vs.length) return;
        // 只暂停【正在播放且未静音】的主播放器（与 playInSourceTab 同一选取规则），
        // 不改动 muted 等用户设置，也不碰推荐位的静音小卡片。
        const playing = vs.filter((x) => !x.paused && !x.ended && !x.muted);
        const pool = playing.length ? playing : vs.filter((x) => !x.paused && !x.ended);
        for (const v of pool) { try { v.pause(); } catch (_) {} }
      },
    });
  } catch (_) {}
}

// ★2026-08-23 抖音侧栏无法播放时的兜底按钮：仅在预览窗显示"在源页播放"。
//   点击 → playInSourceTab（当前页 play()，绝不 tabs.update 换 url）→ 源视频继续播，不暂停/不重载。
function showSourcePlayButton(asset, awemeId, playerUrl) {
  const btn = document.getElementById('pvSourcePlay');
  if (!btn) return;
  btn.style.display = '';
  btn.onclick = () => {
    getSourceTabId().then((tabId) => { if (tabId) playInSourceTab(tabId); });
    if (setStatus) setStatus('▶ 已在源页继续播放（侧栏不跳转）');
  };
  if (setStatus) setStatus('⚠ 抖音防盗链无法在侧栏播放，点"在源页播放"继续观看（源视频不会被暂停）');
}
// 在 openPreview 默认隐藏该按钮（仅抖音分支按需显示）
function hideSourcePlayButton() { const b = document.getElementById('pvSourcePlay'); if (b) { b.style.display = 'none'; b.onclick = null; } }

// 重发直链取字节（非 YouTube，或 YouTube 无捕获字节时的兜底）
function fallbackCdnRefetch(a, vid, referer) {
  // ★2026-08-24 修复：优先用 a.downloadAddr（抖音 REFRESH_FROM_PAGE 返回的新鲜直链），否则 stale 扫描直链
  //   后台 fetch 抖音 CDN 403 → blob 错误页 → <video> 不播。fresh 直链才能放真实视频。
  const effectiveUrl = a.downloadAddr || a.url;
  const isDouyin = /douyin|bytedance|tiktok|douyinvod|iesdouyin/i.test(effectiveUrl || '');
  // ★2026-08-24 诊断日志：用户实测「点卡片不播放」时贴此日志即可定位根因（哪一步成功/失败）。
  try { console.log('[HMDAO][diag] fallbackCdnRefetch start url=' + (effectiveUrl || '').slice(0, 80) + ' isDouyin=' + isDouyin + ' referer=' + (referer || '').slice(0, 50)); } catch (_) {}
  // ★2026-08-23 优化（实测：点卡片需等数分钟才播 = 整个视频字节 blob 拉取慢）
  //   抖音 douyinvod 直链在【源页 tab 上下文】带 cookie 可播；侧栏 chrome-extension:// 域直接 src 多半被 CORS 挡，
  //   但仍先【低成本试一次直链 src】（若环境放行即秒播），同时并行启动字节拉取兜底，让用户最快看到画面。
  if (isDouyin && effectiveUrl && !effectiveUrl.startsWith('blob:')) {
    try {
      const probe = document.createElement('video');
      probe.muted = true; probe.playsInline = true; probe.preload = 'auto';
      probe.src = String(effectiveUrl || '').replace(/\\\//g, '/');
      probe.addEventListener('loadedmetadata', () => {
        // 直链可播：直接切换主播放器到直链，停止等 blob
        if (!vid.src || vid.src.startsWith('blob:') || vid.error) {
          const prev = vid.src; vid.src = probe.src; vid.load(); vid.play().catch(() => {});
          if (prev && prev.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(prev), 60000);
          setStatus('✅ 直链秒播（绕过字节拉取）');
        }
      }, { once: true });
      probe.addEventListener('error', () => { try { console.log('[HMDAO][diag] probe 直链 src 失败（CORS/CDN 拒绝），等字节兜底'); } catch (_) {} }, { once: true });
      probe.load();
    } catch (_) {}
  }
  setStatus('正在后台带 Referer 拉取视频字节…');
  fetchMediaViaBackground(effectiveUrl, referer).then((res) => {
    try { console.log('[HMDAO][diag] fetchMediaViaBackground 响应 ok=' + (res && res.ok) + ' status=' + (res && res.status) + ' b64Len=' + ((res && res.b64 && res.b64.length) || 0) + ' error=' + (res && res.error)); } catch (_) {}
    const swFailed = !res || !res.ok || !res.b64;
    if (!swFailed) {
      try {
        const blob = new Blob([b64ToBytes(res.b64)], { type: res.mime || 'video/mp4' });
        const url = URL.createObjectURL(blob);
        cacheDragBlob(a, blob, res.mime || 'video/mp4'); // 缓存真实字节 → 可拖到桌面/文件夹
        const prev = vid.src;
        vid.src = url; vid.load(); vid.play().catch(() => {});
        if (prev && prev.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(prev), 60000);
        setStatus('✅ 已用后台拉取的字节播放（绕过签名/Referer 限制）');
        return;
      } catch (e) {
        setStatus('⚠ 字节转 blob 失败：' + e.message, true);
      }
    }
    // ★第二层兜底：SW fetch 失败（抖音 sf*-cdn-tos 等需会话 Cookie 的防盗链视频/音频）时，
    //   在【源页标签页面上下文】fetch（继承 ttwid/SESSDATA，与封面 loadImageViaRelay 同源逻辑一致）。
    const swStatus = (res && res.status) || 0;
    if (swStatus === 403 || swStatus === 407 || swStatus === 0) {
      // ★2026-08-22 修复：window.__hmdao_sourceTabId 从未赋值，改为运行时查询真实源页 tab。
      getSourceTabId().then((tabId) => {
        try { console.log('[HMDAO][diag] 源页兜底 tabId=' + tabId + ' url=' + (effectiveUrl || '').slice(0, 80)); } catch (_) {}
        if (tabId != null) {
        setStatus('后台拉取受限，正在源页上下文回退拉取（继承会话 Cookie）…');
        const isDouyin = /douyin|bytedance|tiktok|douyinvod|iesdouyin/i.test(effectiveUrl || '');
        chrome.runtime.sendMessage({ type: 'HMDAO_FETCH_MEDIA_IN_TAB', tabId, url: effectiveUrl, referer: referer || '', usePageCookie: isDouyin }).then((t) => {
          try { console.log('[HMDAO][diag] 源页 fetch 响应 ok=' + (t && t.ok) + ' b64Len=' + ((t && t.b64 && t.b64.length) || 0) + ' error=' + (t && t.error)); } catch (_) {}
          if (t && t.ok && t.b64) {
            try {
              const mime = t.mime || (/\.mp3(\?|$)/i.test(effectiveUrl) ? 'audio/mpeg' : 'video/mp4');
              const blob = new Blob([b64ToBytes(t.b64)], { type: mime });
              const url = URL.createObjectURL(blob);
              cacheDragBlob(a, blob, mime);
              const prev = vid.src;
              vid.src = url; vid.load(); vid.play().catch(() => {});
              if (prev && prev.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(prev), 60000);
              setStatus('✅ 已用源页上下文拉取的字节播放（' + Math.round(t.size / 1024) + 'KB）');
              return;
            } catch (e) {
              setStatus('⚠ 源页字节转 blob 失败：' + e.message, true);
            }
          } else {
            setStatus('⚠ 源页拉取也失败（签名/登录态过期）：' + errStr(t && (t.error || t.status)), true);
          }
          if (!vid.src) { vid.src = effectiveUrl; vid.load(); vid.play().catch(() => {}); }
        }).catch(() => {
          if (!vid.src) { vid.src = a.url; vid.load(); vid.play().catch(() => {}); }
        });
        return;
        }
      });
      return;
    }
    if (swFailed) {
      setStatus('⚠ 后台拉取失败（签名可能已过期或防盗链）：' + errStr(res && (res.error || res.status)), true);
    }
    // 最后兜底：直接设原 URL（多数失败）
    if (!vid.src) { vid.src = a.url; vid.load(); vid.play().catch(() => {}); }
  }).catch(() => {
    if (!vid.src) { vid.src = a.url; vid.load(); vid.play().catch(() => {}); }
    setStatus('视频加载受限。直接点击「下载」按钮（chrome.downloads 通常能拿到）', true);
  });
}

// ===== 视频卡片悬停抽帧（单例 <video>，零常驻播放器开销）=====
// 鼠标悬停到视频卡片：临时把共享的单例 <video> 叠到卡片上方，后台带 Referer 拉首段字节 → 暂停首帧显示；
// 移开或切换到别的卡片时销毁。全程最多 1 个 WebMediaPlayer 实例，不触发 too many WebMediaPlayers 硬限制。
// 与 openPreview 的大窗 <video>（previewVideo）是不同元素，互不干扰；悬停期间若打开大窗，closePreview 不碰本单例。
let hoverVideoEl = null;
function ensureHoverVideo() {
  if (hoverVideoEl) return hoverVideoEl;
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'metadata'; v.crossOrigin = 'anonymous';
  // 透明背景：抽帧成功前保持透明，露出下方封面图（避免黑屏/空 video 盖住封面）。
  // 仅当 paintHoverFrame 真正拿到帧后才显示。
  v.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:6px;background:transparent;display:none;opacity:0;transition:opacity .12s;z-index:5;pointer-events:none';
  hoverVideoEl = v;
  return v;
}

// 嵌入平台（youku/yt/bili/qq/iqiyi 等，含 generic 通用兼容）—— 直链是防盗链签名地址无法预览，需走 yt-dlp 提取
// ★扩展：网络层捕获的 bilivideo 裸流 + source='bilibili-network' 也归类为嵌入平台（其源页是 B站播放页）。
//        此前只认 playerUrl/biliPageUrl/biliVideoId/platform 字段 → bilivideo 裸流被误判为「普通直链」→
//        populateDownloadResolutions 跳过 yt-dlp formats 拉取 → 面板只显示「原画质平台直链」→
//        confirmDownload 拿防盗链直链 chrome.downloads 直连 403 → 点下载无反应。
function isEmbedPlatformAsset(a) {
  if (!a) return false;
  if (a.platform === 'generic') return true;
  // 直接命中嵌入平台字段
  if (a.playerUrl || a.ytPageUrl || a.biliPageUrl || a.ytVideoId || a.biliVideoId) return true;
  if (a.platform && /youku|tudou|qq|iqiyi|xigua|sohu|bilibili|youtube|douyin|tiktok|xinpianchang|kuaishou|acfun|haokan/.test(a.platform)) return true;
  // 网络层捕获的 bilivideo 裸流 + 源页是 B站 → 视为嵌入平台（走 yt-dlp + WBI 重新抓取）
  if (a.source && /bilibili/i.test(a.source)) {
    const src = window.__sourcePageUrl || '';
    if (/bilibili\.com/i.test(src)) return true;
  }
  // 兜底：URL 本身就是 bilivideo 域名（且源页是 B站）
  if (/bilivideo\.(com|cn|tv)\b/i.test(a.url || '')) {
    const src = window.__sourcePageUrl || '';
    if (/bilibili\.com/i.test(src)) return true;
  }
  return false;
}

// ★2026-09-11 悬停抽帧改造：自增序号 + 闸门 + 字节上限。
//   ① 序号：鼠标移开/切卡后自增，回调先比对序号，不匹配直接丢弃（在途字节不再上屏，等价 abort）。
//   ② 闸门：悬停抽帧仅作为「该卡没有有效封面」时的兜底（旧闸门 assets.length>20 会把多视频页
//      整体静默禁用，imini 这类站点一张帧都抽不到）。
//   ③ 字节上限：只拉前 2MB（对齐 card-render.js 的抽帧写法），避免整文件拉完 + base64 回传打满 SW。
let hoverVideoSeq = 0;
const HOVER_FRAME_MAX_BYTES = 2 * 1024 * 1024;

// 判断该卡片是否需要「悬停抽帧」兜底：无封面 / 封面被判为统一占位图 / 封面加载失败 才需要。
function hmdaoCardNeedsHoverFrame(a, card) {
  try {
    if (!a || !card) return false;
    // 已抽过帧（含本次会话内 hover 过）→ 不必再抽
    if (a.__hoverCoverBlob) return false;
    const cover = Array.isArray(a.cover) ? (a.cover[0] || '') : (a.cover || '');
    // 封面已被判为「CDN 统一占位图」→ 需要抽真帧
    let ph = false;
    try {
      if (cover && typeof window.__hmdaoIsPlaceholderCover === 'function') ph = !!window.__hmdaoIsPlaceholderCover(cover);
    } catch (_) { ph = false; }
    const tag = card.querySelector ? card.querySelector('.tag') : null;
    const st = tag ? (tag.dataset.coverState || '') : '';
    const coverBroken = (st === 'error' || st === 'empty' || st === 'none');
    if (cover && !ph && !coverBroken) return false; // 已有有效封面 → 不抽帧（悬停仅作兜底）
    // 视口内【视频卡】过多时不抽帧（避免侧栏卡顿）：轻量 getBoundingClientRect 判定，不新建 observer
    // （renderNow 只给视频卡挂 .url-row，据此区分视频卡与图片卡，避免图片多的页面被误判超阈值）
    let visibleCards = 0;
    try {
      const cards = document.querySelectorAll('#list .card') || [];
      for (let i = 0; i < cards.length; i++) {
        const r = cards[i].getBoundingClientRect();
        if (r.bottom > -200 && r.top < (window.innerHeight + 200)) {
          if (cards[i].querySelector && cards[i].querySelector('.url-row')) visibleCards++;
        }
        if (visibleCards > 12) break;
      }
    } catch (_) { visibleCards = 0; }
    if (visibleCards > 12) return false;
    return true;
  } catch (_) { return false; }
}

// 该封面 <img> 当前是否显示着「已被判死的统一占位图」——用卡片上记录的原始 cover URL 反查
// （封面走 relay 后 im.src 是 blob: URL，无法直接按 src 判定，故回溯 card.dataset.cover）。
function hmdaoCoverIsPlaceholderOf(im) {
  try {
    if (!im || typeof window.__hmdaoIsPlaceholderCover !== 'function') return false;
    const card = (im.closest && im.closest('.card')) || null;
    const raw = card ? (card.dataset.cover || '') : '';
    if (!raw) return false;
    return !!window.__hmdaoIsPlaceholderCover(raw);
  } catch (_) { return false; }
}

async function hoverVideoFrame(a, card) {
  if (!a || (a.type !== 'video' && !a.dynamic)) return;
  // 动图（webp/gif 动画）直接显示封面动图即可，不需要创建 <video> 抽帧（避免无意义媒体实例开销）
  if (a.dynamic && a.type !== 'video') return;
  // ★2026-09-11 替换旧闸门（原 `assets.length > 20` 静默禁用整个多视频页的悬停抽帧）：
  //   新闸门 = 该卡没有有效封面 && 视口内视频卡 ≤ 12。
  try { if (!hmdaoCardNeedsHoverFrame(a, card)) return; } catch (_) { return; }
  const tag = card.querySelector('.tag');
  if (!tag) return;
  const v = ensureHoverVideo();
  // ★让 paintHoverFrame 能拿到当前资产（用于截帧缓存到 a.__hoverCoverBlob）
  v.__hmdaoAsset = a;
  if (v.parentElement && v.parentElement !== tag) {
    // 切换卡片时，保留旧位置的 video 120ms 淡出后移除，避免黑块突现（解决闪烁）
    const oldParent = v.parentElement;
    v.style.opacity = '0';
    setTimeout(() => { try { if (v.parentElement === oldParent) oldParent.removeChild(v); } catch (_) {} }, 120);
  }
  if (v.parentElement !== tag) {
    // 移动到当前卡片（保证同一时刻只有一个卡片在抽帧）
    if (v.parentElement) v.parentElement.removeChild(v);
    tag.appendChild(v);
  }
  v.style.display = 'block';

  // 嵌入式平台资产（youku/yt/bili/qq/iqiyi/douyin 等）：直链是防盗链签名地址无法预览。
  // ★2026-08-18 优化：悬停阶段【不再】调用 yt-dlp 抽帧。
  //   原因：yt-dlp 会再 spawn ffmpeg 做分片合并（孙进程不继承 windowsHide），
  //   鼠标经过每个视频都弹一次 yt-dlp.exe/ffmpeg 黑窗口，且每次悬停都启动重量级进程，体验极差。
  //   真正的预览交给用户「点击/双击」（openPreview 已按需调 yt-dlp），悬停只显示封面图（card-render 已挂 a.cover），零进程零弹窗。
  if (isEmbedPlatformAsset(a)) {
    // 纯显示封面：不创建 <video>、不调 yt-dlp。封面图由 card-render 渲染在卡片底层，
    // hoverVideoEl 保持 display:none，避免黑屏盖住封面。
    return;
  }

  // 直链视频（api-video / 通用 mp4 / 防盗链 CDN）：后台带 Referer 拉取字节 → blob → 暂停首帧
  // ★B站直链资产（bilivideo 防盗链签名地址）：禁止创建指向该直链的 <video>，
  // 否则浏览器加载过期签名/带 crossOrigin 的 bilivideo 会触发同域媒体并发异常，
  // 间接导致 B站原生播放器暂停。B站资产一律只用已有封面（即"悬停预览画面"），不抽帧。
  const isBiliDirect = /bilivideo/i.test(a.url) || a.platform === 'bilibili' || (a.source && /bilibili/i.test(a.source));
  if (isBiliDirect) {
    // 纯显示封面（card-render 已挂封面图），此处不操作任何 <video>，零副作用。
    return;
  }
  const referer = deriveMediaReferer(a.url, window.__sourcePageUrl || '');
  // ★2026-09-11：序号快照 —— 鼠标移开/切卡后 stopHoverVideoFrame 会 hoverVideoSeq++，
  //   此处捕获的 seq 随即失效，回调里比对不上就直接丢弃在途字节（等价 abort，不再上屏）。
  const mySeq = ++hoverVideoSeq;
  let res = null;
  try {
    // maxBytes：只拉前 2MB（只要首帧），否则整文件拉完 + base64 回传会打满 SW 通道
    res = await fetchMediaViaBackground(a.url, referer, { maxBytes: HOVER_FRAME_MAX_BYTES });
  } catch (_) { res = null; }
  if (mySeq !== hoverVideoSeq) return;      // 已移开/切卡 → 丢弃
  if (!res) { try { v.style.display = 'none'; } catch (_) {} return; }
  paintHoverFrame(v, res, mySeq);
}

// 把后台返回的字节画成悬停首帧（失败则保持封面图，不报错）
// 2026-08-24 增强：成功时把首帧 canvas 截成 png blob 缓存到 a.__hoverCoverBlob，
// 供 card-render 在 relay 封面 404 时回退（hover 过的视频移开鼠标也显示首帧），解决"hover 才显示"问题。
// ★2026-09-11：新增 seq 参数（丢弃在途结果）与「写回封面缓存」（悬停过的卡变成常驻封面）。
function paintHoverFrame(v, res, seq) {
  if (!res || !res.ok || !res.b64) return;
  // 上屏前再比对一次序号：字节回来时鼠标可能已经移开
  if (typeof seq === 'number' && seq !== hoverVideoSeq) return;
  try {
    const blob = new Blob([b64ToBytes(res.b64)], { type: res.mime || 'video/mp4' });
    const url = URL.createObjectURL(blob);
    let snapBlobUrl = null; // canvas 截帧 blob URL（仅在 paintHoverFrame 完成后由 a 持有）
    const onloaded = () => {
      try {
        // 跳到 0.1s 附近取一帧（部分编码首帧为黑场，0.1s 更稳）
        v.currentTime = Math.min(0.1, (v.duration || 0.1) * 0.05);
      } catch (_) {}
      v.pause();
      // 真正有画面后再淡入，避免黑屏盖住封面
      requestAnimationFrame(() => { v.style.opacity = '1'; });
      if (v.dataset.blobUrl && v.dataset.blobUrl.startsWith('blob:')) {
        try { URL.revokeObjectURL(v.dataset.blobUrl); } catch (_) {}
      }
      v.dataset.blobUrl = url;
      // ★ 截帧为 png 缓存到当前 hover 资产（如果 hoverVideoFrame 把 a 写在了 v 上）
      try {
        const a = v.__hmdaoAsset;
        if (a && v.videoWidth > 0 && v.videoHeight > 0) {
          const c = document.createElement('canvas');
          // 限幅：避免超高分辨率截帧消耗内存/卡顿
          const maxW = 480;
          const scale = v.videoWidth > maxW ? maxW / v.videoWidth : 1;
          c.width = Math.round(v.videoWidth * scale);
          c.height = Math.round(v.videoHeight * scale);
          const ctx = c.getContext('2d');
          if (ctx) {
            ctx.drawImage(v, 0, 0, c.width, c.height);
            c.toBlob((pb) => {
              if (!pb) return;
              // 释放旧缓存
              if (a.__hoverCoverBlob && a.__hoverCoverBlob.startsWith('blob:')) {
                try { URL.revokeObjectURL(a.__hoverCoverBlob); } catch (_) {}
              }
              snapBlobUrl = URL.createObjectURL(pb);
              a.__hoverCoverBlob = snapBlobUrl;
              // ★2026-09-11（与"无封面卡抽帧"方案合流）：把抽到的首帧【写回封面缓存】，
              //   让悬停过的卡变成常驻封面 —— 后续重渲/滚动不再重复抽帧，
              //   同时覆盖掉此前可能已被缓存的占位图（占位图识别已把 URL 判死并从缓存撤销）。
              try { if (typeof hmdaoCacheHoverCover === 'function') hmdaoCacheHoverCover(a, snapBlobUrl); } catch (_) {}
              // 刷新同 URL 资产的所有视频卡的 coverImg（包括当前卡，移开鼠标也保留画面）
              try {
                const esc = (window.CSS && CSS.escape) ? CSS.escape(a.url) : String(a.url).replace(/"/g, '\\"');
                document.querySelectorAll('.card[data-asset-url="' + esc + '"] .cover-img').forEach((im) => {
                  // ★2026-09-11 补全：占位图/破图/失败态也要被真帧替换（旧逻辑只跳过 'ok' 态，
                  //   而占位图命中时卡面停留在 🎬/空态，此处统一刷新）
                  if (!im.src || im.dataset.coverState !== 'ok' || hmdaoCoverIsPlaceholderOf(im)) {
                    im.src = snapBlobUrl;
                    im.dataset.coverState = 'hover';
                    const tag = im.parentElement;
                    if (tag) {
                      tag.dataset.coverState = 'ok';
                      tag.textContent = '';
                    }
                  }
                });
              } catch (_) {}
            }, 'image/png');
          }
        }
      } catch (_) {}
    };
    v.addEventListener('loadeddata', onloaded, { once: true });
    v.style.opacity = '0';
    v.src = url; v.load();
  } catch (_) {}
}

function stopHoverVideoFrame(card) {
  // ★2026-09-11：鼠标一移开就【立即让在途请求失效】（hoverVideoSeq++ 后，hoverVideoFrame /
  //   paintHoverFrame 的回调会因序号不匹配直接丢弃结果，等价 abort，不再等网络）。
  //   800ms 只用于已上屏画面的淡出，不再等字节。
  try { hoverVideoSeq++; } catch (_) {}
  // 仅当单例 video 确实在该卡片时才移除（避免误清其它卡片的悬停）
  if (hoverVideoEl && hoverVideoEl.parentElement === card) {
    // 销毁悬停的 hls 实例（优酷 m3u8 流用 hls.js 挂载，避免累积）
    try { if (hoverVideoEl.__hmdaoHls) { hoverVideoEl.__hmdaoHls.destroy(); hoverVideoEl.__hmdaoHls = null; } } catch (_) {}
    // ★2026-08-25 关键修复（缩略图 hover 移开消失）：hover 移开时，paintHoverFrame 是异步的
    //   （fetchMediaViaBackground 拉字节 → 解码 → canvas 截帧 → 写入 a.__hoverCoverBlob），
    //   若立即 display:none，coverImg 重现但 __hoverCoverBlob 还没写入 → 用户看到 🚫 或破图。
    //   现改为：延后 800ms 隐藏（淡出 + 移除），给 paintHoverFrame 足够时间把首帧写回 coverImg。
    //   期间若用户重新 hover 该卡，hoverVideoFrame 会把 v 移过去，parent 不再是 card，本 setTimeout 安全无效。
    hoverVideoEl.style.opacity = '0';
    const v = hoverVideoEl;
    const oldParent = card;
    setTimeout(() => {
      try {
        // 仍然附着在原 card 才隐藏/移除（避免把 v 移走后的卡片画面也清掉）
        if (v.parentElement === oldParent) {
          v.style.display = 'none';
          if (v.parentElement) v.parentElement.removeChild(v);
        }
      } catch (_) {}
    }, 800);
  }
}

// 后台带 Referer 拉取媒体字节 → blob → 浏览器下载（用于抖音/TikTok/视频号等 chrome.downloads 直连会 403 的站点）
async function downloadVideoViaBackground(a) {
  const referer = deriveMediaReferer(a.url, window.__sourcePageUrl || '');
  const name = deriveFilename(a);
  // ★2026-08-31 修复（"卡 1 永远正在拉取视频字节"真凶）：保留 pulseDownloadProgress 返回的 dlId，
  //   在成功/失败/return 处必须调 HmdaoProgress.complete 或 HmdaoProgress.fail 把卡转成终态，
  //   否则卡永远 STATE.DOWNLOADING pending（pulseDownloadProgress 不创建 downloadId 关联，onChanged 不会更新它）。
  const dlId = pulseDownloadProgress('正在拉取视频字节：' + name);
  const finish = (ok, errMsg) => {
    try {
      if (ok) window.HmdaoProgress.complete(dlId, { name });
      else window.HmdaoProgress.fail(dlId, errMsg || 'FAILED');
    } catch (_) {}
  };
  // YouTube：优先用播放器已下载的真实字节（避免重发直链拿到假视频文件）
  if (isYoutubeMedia(a.url)) {
    setStatus('正在读取播放器已缓存的真实视频字节用于下载…');
    const yt = await getYtBytesViaBackground(a.url);
    if (yt && yt.ok && yt.b64 && yt.size > 1024) {
      // YouTube UMP 底层是 ISOBMFF 容器——强制 video/mp4 MIME 确保下载文件可被播放器识别
      const blob = new Blob([b64ToBytes(yt.b64)], { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);
      cacheDragBlob(a, blob, 'video/mp4');
      // ★2026-09-10：用户为该类型设置了目录 → 写用户目录，否则回退默认路径
      if (await writeBlobToUserDir(a.type, deriveFilename(a), blob)) {
        setStatus('✅ 已保存到设置的目录：' + deriveFilename(a));
        finish(true); return;
      }
      downloadBlobUrl(url, 'Ddayup/videos/' + deriveFilename(a));
      setTimeout(() => URL.revokeObjectURL(url), 120000);
      setStatus('✅ 已用播放器真实字节下载（itag ' + (yt.itag || '?') + '，' + Math.round(yt.size / 1024) + 'KB）');
      finish(true);
      return;
    }
    // 无捕获字节 → 回退重发直链（下方逻辑）
  }
  setStatus('正在后台拉取视频字节用于下载（可能需数秒到数分钟，取决于视频大小）…');
  // ★2026-08-30 修复（"下载没反应"根因）：fetchMediaViaBackground 拉大文件时无任何 UI 反馈。
  //   加心跳：每 5 秒更新一次状态栏"⏳ 拉取中…已用 Ns"，避免用户以为卡死。
  //   加超时：180 秒未返回则主动报错（避免几十分钟等不到结果）。
  const t0 = Date.now();
  const heartbeat = setInterval(() => {
    const sec = Math.floor((Date.now() - t0) / 1000);
    if (sec > 0) setStatus('⏳ 正在拉取视频字节…已用 ' + sec + 's（' + name + '）');
  }, 5000);
  const timeoutId = setTimeout(() => {
    setStatus('⚠ 拉取超时（180s），可能是大文件或网络慢。可尝试「整段含音画 1080P」档位（durl，无需合并，单文件直下）', true);
  }, 180000);
  try {
    const res = await fetchMediaViaBackground(a.url, referer);
    if (res && res.ok && res.b64) {
      const blob = new Blob([b64ToBytes(res.b64)], { type: res.mime || 'video/mp4' });
      const url = URL.createObjectURL(blob);
      cacheDragBlob(a, blob, res.mime || 'video/mp4'); // 缓存真实字节 → 可拖到桌面/文件夹
      // ★2026-09-10：用户为该类型设置了目录 → 写用户目录（FileSystemAccess 可写任意路径）
      if (await writeBlobToUserDir(a.type, deriveFilename(a), blob)) {
        setStatus('✅ 已保存到设置的目录：' + deriveFilename(a));
        finish(true); return;
      }
      downloadBlobUrl(url, 'Ddayup/videos/' + deriveFilename(a));
      setTimeout(() => URL.revokeObjectURL(url), 120000);
      const usedSec = Math.floor((Date.now() - t0) / 1000);
      setStatus('✅ 已通过后台拉取下载（' + Math.round(blob.size / 1024) + 'KB，耗时 ' + usedSec + 's）');
      finish(true);
    } else {
      setStatus('⚠ 后台下载失败（签名可能已过期或防盗链）：' + errStr(res && (res.error || res.status)), true);
      // ★用户需求：视频下载失败时提醒去模型下载面板装 yt-dlp（仅当确实未装）
      checkYtDlp().then((st) => { if (st === 'missing') ensureYtDlpPrompt(); });
      finish(false, 'FETCH_FAILED');
    }
  } catch (e) {
    setStatus('⚠ 拉取异常：' + (e && e.message || e) + '。可尝试「整段含音画 1080P」档位（durl，无需合并，单文件直下）', true);
    finish(false, 'FETCH_EXCEPTION');
  } finally {
    clearInterval(heartbeat);
    clearTimeout(timeoutId);
  }
}

// 注：dashDemux / getVideoCodecPrivate / getAacCodecPrivate / muxerVideoCodec / mergeDashToMp4
// 已抽离至 media-transcode.js（纯算法簇，与 UI 解耦），由 sidepanel.html 在 vendor 库之后、
// 本文件之前加载，运行时经 typeof mergeDashToMp4 === 'function' 延迟调用。

document.getElementById('closePreview').onclick = closePreview;
// ★2026-08-23 修复（用户反馈：点侧栏预览面板内/外的空白都会触发返回）：
//   旧逻辑 previewOverlay.onclick 用 e.target===e.currentTarget 判定，但预览面板内视频下方留白区
//   实际命中的就是 overlay 自身 → 被误判为"点空白"而关闭预览。改为：预览面板**仅 ✕ 按钮关闭**，
//   点面板内任意区域（含视频下方空白/操作按钮行/侧栏其他空白）都不关闭，只有点右上角 ✕ 才返回。
//   另加 Esc 键关闭（不干扰面板内交互，因 Esc 不命中任何面板元素）。
document.getElementById('previewOverlay').onclick = null;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const ov = document.getElementById('previewOverlay');
    if (ov && ov.classList.contains('open')) closePreview();
  }
});

// 预览窗底部按钮
// getPreviewAsset 定义见 ui-utils.js（全局单一来源）

document.getElementById('pvDownload').onclick = () => {
  const a = getPreviewAsset();
  if (!a) return;
  // ★2026-09-10 修复（"图片从预览下载后落在 Ddayup/videos，右键下载却在 Ddayup/images"）：
  //   openDownloadPanel 是【视频分辨率面板】，其内部保存路径硬编码 'Ddayup/videos/'。
  //   此前任何非网盘/非归档资产（含图片）都走它 → 图片被存进 videos 目录，与右键菜单
  //   （走 downloadSingle → typeDirs[a.type] → images）不一致。
  //   现在只有【视频 / 动图】才需要分辨率面板；其余类型一律走 downloadSingle，
  //   由 typeDirs 决定子目录（image→images / audio→audio / model→models ...），全链路统一。
  const isVideoLike = a.type === 'video' || a.dynamic;
  if (a.type === 'netdisk' || a.type === 'archive' || a.isNetdiskFile || !isVideoLike) {
    downloadSingle(a);
    return;
  }
  openDownloadPanel(a);
};
document.getElementById('pvCopyImage').onclick = async () => { const a = getPreviewAsset(); if (a) await copyImageToClipboard(a); };
document.getElementById('pvPlay').onclick = () => { const a = getPreviewAsset(); if (a && a.type === 'audio') playAudioInPage(a, { visual: true }); };
document.getElementById('pvSaveLocal').onclick = () => {
  const a = getPreviewAsset();
  if (!a) return;
  const btn = document.getElementById('pvSaveLocal');
  if (btn) { btn.disabled = true; const old = btn.textContent; btn.textContent = '⏳ 保存中…';
    setStatus('⏳ 正在保存到本地目录…');
    Promise.resolve(saveSingleToLocal(a)).finally(() => { if (btn) { btn.disabled = false; btn.textContent = old; } });
  } else {
    saveSingleToLocal(a);
  }
};
// 本地保存落盘后也通过上面统一的 onChanged 监听给「已保存」提示（saveSingleToLocal 回退下载时同样生效）。
document.getElementById('pvCopyLink').onclick = () => {
  const a = getPreviewAsset(); if (!a) return;
  // ★2026-08-22 修复（"点卡片跳CDN"真凶）：复制源页链接应优先 playerUrl（抖音视频页），
  // 而非 a.url（CDN 直链）。无 playerUrl 时回退 a.url。
  navigator.clipboard.writeText(a.playerUrl || a.url).then(() => setStatus('已复制')).catch(() => setStatus('复制失败', true));
};
document.getElementById('pvOpenTab').onclick = () => {
  const a = getPreviewAsset();
  if (!a) return;
  // ★2026-08-22 修复（"点卡片跳CDN"真凶）：新标签页打开应优先 playerUrl（抖音视频页 / B站视频页），
  // 而非 a.url（CDN 直链 lf3-static.bytednsdoc.com）。无 playerUrl 时回退 a.url。
  const openUrl = a.ytVideoId ? ('https://www.youtube.com/watch?v=' + a.ytVideoId) : (a.playerUrl || a.url);
  chrome.tabs.create({ url: openUrl });
};
document.getElementById('pvNetResolve').onclick = () => { const a = getPreviewAsset(); if (a) netdiskResolve(a); };
document.getElementById('pvSimilar').onclick = () => { const a = getPreviewAsset(); if (a) doFindSimilar(a); };
// ★2026-09-05：「🔄 源页刷新」成功后同步侧栏卡片 + 触发源页重扫。
//   1) 用刷新到的直链/元数据就地更新 window.assets 里对应的卡（按 awemeId 优先、其次 url）；
//   2) renderNow() 让卡片立刻反映新直链（并清掉「📍 未在源页播放过」标记）；
//   3) 发 HMDAO_RESCAN_TAB 让 background 深度重扫该 tab —— SCRAN_RESULT 回来后
//      侧栏的集数/标题/封面与源页当前播放内容一致。
async function syncAssetAfterRefresh(a, r) {
  try {
    const list = Array.isArray(window.assets) ? window.assets : [];
    let hit = null;
    for (const x of list) {
      if (!x) continue;
      if (a && a.awemeId && x.awemeId && String(x.awemeId) === String(a.awemeId)) { hit = x; break; }
      if (a && a.url && x.url === a.url) { hit = x; break; }
    }
    if (hit) {
      if (r && r.url && typeof r.url === 'string') hit.url = r.url;
      if (r && r.title) hit.title = r.title;
      if (r && r.cover) hit.cover = r.cover;
      if (r && r.awemeId) hit.awemeId = r.awemeId;
      hit.notPlayed = false; // 已在源页播放过 → 撤掉「📍 未播放」徽标
      try { renderNow(); } catch (_) {}
    }
  } catch (_) {}
  try {
    const tid = (window.__hmdao_sourceTabId != null) ? window.__hmdao_sourceTabId : null;
    if (tid != null) await chrome.runtime.sendMessage({ type: 'HMDAO_RESCAN_TAB', tabId: tid });
  } catch (_) {}
}

document.getElementById('pvRefresh').onclick = async () => {
  const a = getPreviewAsset();
  if (!a) return;
  setStatus('正在源页重新捕获…');
  const r = await chrome.runtime.sendMessage({ type: 'HMDAO_REFRESH_FROM_PAGE', assetUrl: a.url });
  if (r && r.ok && r.url) {
    // DASH 分离轨对象：先播视频轨，并自动合并音视频为单文件 MP4
    if (typeof r.url === 'object' && r.url.__dash) {
      const vid = document.getElementById('previewVideo');
      const vUrl = (r.url.video && r.url.video[0] && r.url.video[0].baseUrl) || '';
      const aUrl = (r.url.audio && r.url.audio[0] && r.url.audio[0].baseUrl) || '';
      window.__previewAsset = { ...a, url: vUrl };
      vid.src = vUrl; vid.load(); vid.play().catch(() => {});
      setStatus('DASH 分离轨：正在合并音视频为单文件…');
      if (aUrl && typeof mergeDashToMp4 === 'function') {
        mergeDashToMp4(vUrl, aUrl, 'https://www.youtube.com/').then((blob) => {
          const url = URL.createObjectURL(blob);
          window.__mergedDashBlobUrl = url;
          const name = (deriveFilename(a).replace(/\.[^.]+$/i, '') || 'video') + '_merged.mp4';
          window.__previewAsset = { ...a, url, __mergedDash: true, __mergedName: name };
          vid.src = url; vid.load(); vid.play().catch(() => {});
          setStatus('✅ 已合并为单文件 MP4（含音画），可点「下载」保存');
        }).catch((e) => setStatus('⚠ 合并失败：' + (e && e.message || e) + '，仅视频轨', true));
      }
      return;
    }
    const isBlob = typeof r.url === 'string' && r.url.startsWith('blob:');
    if (isBlob) { setStatus('⚠ 仅捕获到 MSE blob URL，没有直接下载链接。请用 B站原生右键→「视频另存为」', true); return; }
    // 更新预览对象 + 重设预览源
    const freshUrl = r.url;
    window.__previewAsset = { ...a, url: freshUrl };
    const vid = document.getElementById('previewVideo');
    if (a.type === 'video' && vid) {
      vid.src = freshUrl; vid.load(); vid.play().catch(() => {});
    }
    document.getElementById('previewInfo').innerHTML = `<span>${escapeHtml(typeLabel(a.type))} · ${escapeHtml(fileName(freshUrl))}（已刷新）</span><br><a href="${escapeAttr(freshUrl)}" target="_blank" title="${escapeAttr(freshUrl)}">${escapeHtml(truncate(freshUrl, 60))}</a>`;
    setStatus('✅ 已刷新 URL，正在同步侧栏…');
    // ★2026-09-05：源页刷新成功后同步侧栏 —— 把该卡的直链换成源页当前播放的那条，
    //   再触发源页重扫，让侧栏卡片集数/标题/封面与【当前源播放内容】对齐。
    //   此前只更新预览对象，侧栏卡片仍是旧直链 → 用户遇到"刷新能播，但卡片还是历史内容"。
    try { await syncAssetAfterRefresh(a, r); } catch (_) {}
    setStatus('✅ 已刷新 URL 并同步侧栏，可点「下载」');
  } else {
    setStatus('⚠ 未捕获到 fresh URL，请保持在源页+点击视频让它播一下', true);
  }
};

// ===== 找相似（优先打开当前扫描的来源页面；不凭空造外链） =====
function doFindSimilar(a) {
  const sourcePage = window.__sourcePageUrl;
  if (sourcePage) {
    // 基于当前浏览页面找相似——直接打开来源页
    chrome.tabs.create({ url: sourcePage, active: true });
    setStatus(`已打开来源页：${(() => { try { return new URL(sourcePage).hostname; } catch (_) { return sourcePage; } })()}`);
    return;
  }
  // 无来源页：在匹配的 Ddayup 标签页中触发资产反向检索
  findHmdaoTab().then((tab) => {
    if (tab && tab.id) {
      sendToTabSafe(tab.id, {
        type: 'HMDAO_FIND_SIMILAR', url: String(a.url || ''), name: fileName(String(a.url || '')), type: a.type,
      }, () => setStatus('已发送到 Ddayup'));
    } else {
      setStatus('⚠ 未找到已打开的 Ddayup 页面，无法找相似', true);
    }
  });
}

// ===== 下载 / 存到本地（单个资产）（抽离至 download.js）=====
// 本文件（sidepanel.js）之后由 download.js 重新定义 downloadSingle / saveSingleToLocal 等，
// 供 bulk-actions.js 与 context-menu.js 运行时调用。

// 注：批量操作 / 按类型目录选择 / 预设官方源 / 消息监听 / beforeunload / lastScan 恢复
// 已抽离至 bulk-actions.js（由 sidepanel.html 在本文件之后加载，确保全局变量先初始化）。

// ===== 启动 =====
// 侧栏底部常驻显示 build 号（免开 DevTools 即可确认跑的是不是最新代码）
try {
  const bt = document.getElementById('buildTag');
  if (bt) { bt.textContent = 'Ddayup 侧栏 build ' + HMDAO_SIDEPANEL_BUILD; bt.classList.add('fresh'); }
} catch (_) {}
// 向 background 上报本组件 build，汇总到统一入口 HMDAO_GET_BUILDS（一眼分辨新旧）
chrome.runtime.sendMessage({ type: 'HMDAO_REPORT_BUILD', component: 'sidepanel', build: HMDAO_SIDEPANEL_BUILD }).catch(() => {});

// ★2026-09-10 关键链路：把 background 广播的 HMDAO_DOWNLOAD_PROGRESS 接到侧栏进度卡上。
//   这条消息是 chrome.downloads.onChanged 的实时回流（每个 tick 都可能触发）。
//   - state='in_progress' | 'in_paused' → progressByDownloadId 更新字节
//   - state='complete' → completeByDownloadId 转完成态（不再卡"开始下载"）
//   - state='interrupted' → failByDownloadId 转失败态（带 reason）
//   注意：chrome.downloads.onChanged 触发非常频繁（每次有变化都触发，含字节变化），
//   所以这里只做参数透传给 progress.js（内部有 dirty 防抖 + DOM 节流渲染）。
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'HMDAO_DOWNLOAD_PROGRESS') return;
  if (msg.downloadId == null) return;
  const HP = window.HmdaoProgress;
  if (!HP) return;
  if (msg.state === 'complete') {
    const base = String(msg.filename || '').split(/[\\/]/).pop() || '已下载';
    HP.completeByDownloadId(msg.downloadId, '已下载完成：' + base);
  } else if (msg.state === 'interrupted') {
    HP.failByDownloadId(msg.downloadId, (msg.error && (msg.error.message || String(msg.error))) || '下载中断');
  } else {
    // in_progress / in_paused / downloading / paused：实时进度
    HP.progressByDownloadId(msg.downloadId, msg.bytesReceived || 0, msg.totalBytes || 0);
  }
});

// onCreated：把刚创建的 downloadId 绑到当前未绑的最近进行中任务卡。
// progressByDownloadId 自身有 fallback，这里只是抢在第一时间绑定，让侧栏首屏字节能命中。
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'HMDAO_DOWNLOAD_CREATED') return;
  if (msg.downloadId == null) return;
  const HP = window.HmdaoProgress;
  if (HP && HP.bindLatestPending) {
    try { HP.bindLatestPending(msg.downloadId); } catch (_) {}
  }
});
chrome.runtime.sendMessage({ type: 'HMDAO_SCAN_REQUEST', batchMode: batchCollectEnabled, force: true }).catch(() => {});
loadPagePreview();
// 侧栏是单例面板，切换标签时不会自动重载；必须监听 onActivated 重新获取当前页信息并扫描新标签。
// 这样从云桥等平台标签切到 B站时，侧栏顶部「当前页」和素材列表会同步刷新，而不是滞留旧标签。
if (chrome.tabs && chrome.tabs.onActivated) {
  chrome.tabs.onActivated.addListener((activeInfo) => {
    // ★2026-08-24 修复（切 tab 残留根因）：切 tab 时重置 currentSourceUrl + 立即清空旧 tab 资产
    //   （仅保留正在下载的 + 全部批量资产），随后 SCAN_REQUEST 到达时只显示新 tab 资产。
    //   此前 currentSourceUrl 保留旧值，doRescan 误判为"同页重扫" → 旧 tab 资产不清除。
    try { currentSourceUrl = ''; } catch (_) {}
    try {
      const dlUrls = (window.HmdaoProgress && window.HmdaoProgress.getDownloadingAssetUrls && window.HmdaoProgress.getDownloadingAssetUrls()) || [];
      if (Array.isArray(window.assets)) {
        // ★2026-08-31：切 tab 完全清空（不保留 dlUrls），避免跨平台混合残留。batchAssets 保留。
        window.assets = batchAssets.slice();
        window.selected = new Set();
        try { batchSelection && batchSelection.clear(); } catch (_) {}
        window.__hmdaoAssets = window.assets.slice();
        try { renderNow(); } catch (_) {}
      }
    } catch (_) {}
    loadPagePreview();
    // ★2026-09-11 修复（列表恒空主因）：onActivated 会在 5315 行清空 window.assets 后请求扫描，
    //   此前不带 force → 若本次扫描内容与上次广播相同被 bcastSig 静默吞掉 → 列表永远填不回来。
    //   tab 切换是显式用户行为且已清空，必须强制广播以重新填充。
    chrome.runtime.sendMessage({ type: 'HMDAO_SCAN_REQUEST', tabId: activeInfo.tabId, batchMode: batchCollectEnabled, force: true }).catch(() => {});
  });
}
// ★2026-09-11：离开/切换即清 + 重进重扫（覆盖"源页关闭 / 同标签内跳转别的链接或平台"）。
//   onActivated 已处理"切到别的标签"；这里补 onRemoved（源页关闭）与 onUpdated（同标签导航换链/换平台）。
//   语义与 onActivated 一致：清空当前扫描卡历史（保留批量下载），更新 currentSourceUrl，重进时由 onActivated/SCAN_REQUEST 重扫。
if (chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    try {
      if (window.__hmdao_sourceTabId != null && tabId === window.__hmdao_sourceTabId) {
        // 源页关闭：清空扫描历史（保留批量），清 lastScan 避免下次打开恢复死卡
        window.assets = (batchAssets || []).slice();
        window.selected = new Set();
        try { batchSelection && batchSelection.clear(); } catch (_) {}
        window.__hmdaoAssets = window.assets.slice();
        currentSourceUrl = '';
        window.__hmdao_sourceTabId = null;
        try { chrome.storage.local.remove('lastScan'); } catch (_) {}
        try { renderNow(); } catch (_) {}
        try { if (typeof updateScanStatus === 'function') updateScanStatus(window.assets, 'idle'); } catch (_) {}
        try { if (typeof setStatus === 'function') setStatus('源页已关闭，已清空扫描历史。重新打开源页可再次扫描。', false); } catch (_) {}
      }
    } catch (_) {}
  });
}
if (chrome.tabs && chrome.tabs.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    try {
      // 仅关心"地址真正变化"（换链接/换平台），忽略同页刷新与仅 title 变化
      if (!changeInfo || !changeInfo.url) return;
      if (window.__hmdao_sourceTabId != null && tabId !== window.__hmdao_sourceTabId) return;
      const nu = String(changeInfo.url || '').split('#')[0];
      const old = String(currentSourceUrl || '').split('#')[0];
      if (nu === old) return; // 同页锚点/刷新不处理
      // 同标签内跳转到别的链接/平台：清空当前扫描卡，更新源页地址，触发重扫
      window.assets = (batchAssets || []).slice();
      window.selected = new Set();
      try { batchSelection && batchSelection.clear(); } catch (_) {}
      window.__hmdaoAssets = window.assets.slice();
      currentSourceUrl = changeInfo.url;
      try { renderNow(); } catch (_) {}
      try { if (typeof updateScanStatus === 'function') updateScanStatus(window.assets, 'scanning'); } catch (_) {}
      try { if (typeof setStatus === 'function') setStatus('已切换到新链接/平台，清空旧扫描历史，正在重新扫描…', false); } catch (_) {}
      chrome.runtime.sendMessage({ type: 'HMDAO_SCAN_REQUEST', tabId, batchMode: batchCollectEnabled, force: true }).catch(() => {});
    } catch (_) {}
  });
}
// 初始化阶段【不】主动探测第三方 Cookie：chrome.contentSettings.get 会在扩展加载时
// 于 Issues 面板触发 "Third-party cookie will be blocked" 警告噪音（实际并非扩展错误，
// 而是 Chrome Privacy Sandbox 对 MV3 扩展读取 cookie 的标准提示）。改为【懒探测】：
// 仅当首次真正需要跨站媒体（YouTube/B站预览、抖音/网盘下载带 cookie）时由下方入口触发，
// 避免加载即污染 Issues 面板；核心功能本身已有 omit 回退 + fallbackCdnRefetch 降级。
window.__hmdaoLazyCheck3pCookies = function lazyCheck3pCookies() {
  if (window.__hmdao3pChecked) return;
  window.__hmdao3pChecked = true;
  checkThirdPartyCookies();
};

// ===== Ddayup 智能机器人浮标（与 Web App SmartAgent 同款形象） =====
// 纯侧栏内浮动：拖动 + 眼睛跟随鼠标 + 眨眼(CSS) + 召唤/收起。
// AI 调用经 background → Ddayup 网页(127.0.0.1:3000) → 复用智能机器人后端，密钥不下发到扩展。
(function initAiBot() {
  const bot = document.getElementById('aiBot');
  const btn = document.getElementById('aiBotBtn');
  const chat = document.getElementById('aiBotChat');
  const summon = document.getElementById('summonBot');
  const closeBtn = document.getElementById('aiBotClose');
  const msgs = document.getElementById('aiBotMsgs');
  const text = document.getElementById('aiBotText');
  const statusEl = document.getElementById('aiBotStatus');
  const pupilL = document.getElementById('aiPupilL');
  const pupilR = document.getElementById('aiPupilR');
  if (!bot || !btn) return;

  let botVisible = false;
  let dragging = false, moved = false, startX = 0, startY = 0, origX = 0, origY = 0;

  function showBot() { bot.style.display = 'block'; botVisible = true; summon.textContent = '🤖 收起侧栏机器人'; }
  function hideBot() { bot.style.display = 'none'; botVisible = false; chat.style.display = 'none'; summon.textContent = '🤖 在侧栏显示机器人'; }

  // 「在侧栏显示机器人」：切换侧栏内浮标（形象 1:1 复制 3000）
  summon.addEventListener('click', () => { botVisible ? hideBot() : showBot(); });

  // 「在网页打开 / 收回」按钮已移除：智能机器人仅保留侧栏内浮标（形象 1:1 复制 3000），
  // 不再支持注入当前网页。

  // 网页机器人关闭后「回到侧栏」
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'HMDAO_AI_BOT_RETURN') { showBot(); }
  });

  // ===== 实时扫描状态指示器 =====
  // 接收 background 扫描结果广播，更新「已扫描数 / 进度 / 失败项」；
  // 同时在重新扫描期间显示进度态，扫描完整结束（含失败项）后显示最终态。
  function updateScanStatus(assets, state) {
    const dot = document.getElementById('ssDot');
    const txt = document.getElementById('ssText');
    if (!txt) return;
    const list = assets || [];
    // 失败项：非 http(s) 的 blob/data 音频、或 URL 为空的资产
    const failed = list.filter(a => !a || !/^https?:/i.test(a.url || '') || /^blob:|^data:/i.test(a.url || ''));
    const typeCount = {};
    for (const a of list) { const t = (a.type || 'other'); typeCount[t] = (typeCount[t] || 0) + 1; }
    const parts = [];
    for (const t of ['image', 'video', 'audio', 'model', 'archive', 'netdisk']) {
      if (typeCount[t]) parts.push(`${t}:${typeCount[t]}`);
    }
    if (state === 'scanning') {
      if (dot) { dot.className = 'ss-dot blue'; }
      txt.textContent = `扫描中… 已发现 ${list.length} 项` + (parts.length ? `（${parts.join(' ')}）` : '');
    } else {
      if (dot) { dot.className = 'ss-dot ' + (failed.length ? 'red' : 'green'); }
      txt.textContent = `已扫描 ${list.length} 项` + (failed.length ? `，失败 ${failed.length} 项` : '，全部有效')
        + (parts.length ? `（${parts.join(' ')}）` : '');
    }
  }
  // 初始把扫描状态挂到 window，供 bulk-actions.js 渲染后调用
  window.__hmdaoUpdateScanStatus = updateScanStatus;

  // 重新扫描时进入「扫描中」态
  const _rescan = document.getElementById('rescan');
  if (_rescan) {
    const orig = _rescan.onclick;
    _rescan.addEventListener('click', () => updateScanStatus(window.__hmdaoAssets || [], 'scanning'), true);
  }

  // ★2026-08-23 修复（问题3 断裂B）：sidepanel 初始化时从 lastScan 持久化回填，避免源页刷新/侧栏重开后 URL 全丢。
  //   之前 window.assets 既无运行时 SCAN_RESULT 回填（断裂A）、也无持久化加载 → 双向失效。
  //   刷新后首次打开侧栏：先从 lastScan 恢复上次扫描的普通/批量资产 + 当前页 URL，再发起一次扫描增量合并。
  try {
    chrome.storage.local.get('lastScan', (s) => {
      try {
        const ls = (s && s.lastScan) || null;
        if (!ls || !Array.isArray(ls.assets) || !ls.assets.length) return;
        // ★2026-09-11 守卫（离开/切换/新窗口即清根因）：仅当 lastScan 记录的源页仍是当前激活页且 URL 一致才恢复，
        //   否则视为"切换到别的链接/平台/新对话窗口"的残留 → 清空并交由下方 SCAN_REQUEST 重扫，杜绝错页死卡。
        const restoreIfSame = () => {
          if (!Array.isArray(window.assets)) window.assets = [];
          for (const a of ls.assets) {
            // ★豆包朗读的伪 URL 卡（doubao-ws-audio://）是上一轮内存里的 blob 指针，
            //   侧栏重启后已失效、永远点不动 → 恢复时直接丢弃，避免"历史残留幽灵卡"。
            if (a && /^doubao-ws-audio:/i.test(String(a.url || ''))) continue;
            // ★2026-09-11 修复（liblib 等 MSE 站点 lastScan 残留"假卡"根因）：
            //   视频/音频资产若 URL 是 blob:/data:，在侧栏重启/重开后已跨上下文失效，
            //   既不能预览也不能下载，且会触发控制台 ERR_FILE_NOT_FOUND。恢复时直接丢弃。
            if (a && (a.type === 'video' || a.type === 'audio')) {
              try {
                const u = String(a.url || '');
                if (/^blob:/i.test(u) || /^data:/i.test(u)) continue;
              } catch (_) {}
            }
            if (a && a.__batch) {
              if (!batchAssets.some(x => x.url === a.url)) batchAssets.push(a);
            } else {
              if (!window.assets.some(x => x.url === a.url)) window.assets.push(a);
            }
          }
          if (ls.url) currentSourceUrl = ls.url;
          // 统一约定：window.assets = 普通(去批量) + (批量开启时)批量副本（render 读它）
          // ★2026-08-23 深层修复（根因3）：关闭批量时仅普通，避免 batchAssets 残留泄漏。
          const normalOnly = (window.assets || []).filter(a => !(a && a.__batch));
          window.assets = batchCollectEnabled ? normalOnly.concat(batchAssets.slice()) : normalOnly;
          window.__hmdaoAssets = window.assets.slice();
          try { renderNow(); } catch (_) {}
          try { updateScanStatus(window.assets, 'done'); } catch (_) {}
        };
        const lsUrl = String(ls.url || '').split('#')[0];
        const verify = (cb) => {
          if (!chrome.tabs || !chrome.tabs.query || !lsUrl) return cb(false);
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const t = (tabs && tabs[0]) || null;
            const aUrl = t ? String(t.url || '').split('#')[0] : '';
            const sameUrl = !!aUrl && aUrl === lsUrl;
            // tabId 未知时（旧数据）仅按 URL 对齐，避免误清刷新恢复
            const sameTab = ls.tabId == null || (t && t.id === ls.tabId);
            cb(sameUrl && sameTab);
          });
        };
        verify((ok) => {
          if (!ok) { try { chrome.storage.local.remove('lastScan'); } catch (_) {} return; }
          restoreIfSame();
        });
      } catch (_) {}
    });
  } catch (_) {}

  // ★豆包朗读（WS 流式音频）实体化：源页只留字节元数据，这里把字节取回、在侧栏转成真实 blob: URL。
  //   转完之后它就是一张普通音频卡 —— 悬停试听、下载、停止全部走既有通用路径，
  //   不再有伪 URL（doubao-ws-audio://）泄漏到任何后续逻辑（杜绝 scheme 报错与走错通道）。
  async function hydrateDoubaoWsAudios() {
    try {
      const list = (window.assets || []).filter((a) => a && !a.__wsBlob
        && (a.wsAudio || /^doubao-ws-audio:\/\//i.test(String(a.url || ''))));
      if (!list.length) return;
      let changed = false;
      // 每段朗读一张卡（源页最多保留 5 段 + 当前段），逐个取字节实体化
      for (const a of list.slice(0, 6)) {
        // 伪 URL 里带时间戳（doubao-ws-audio://<ts>），元数据丢失时也能反解出是哪一段
        let ts = Number(a.wsTs) || 0;
        if (!ts) {
          const m = /doubao-ws-audio:\/\/(\d+)/i.exec(String(a.url || ''));
          if (m) ts = Number(m[1]) || 0;
        }
        let res = null;
        try {
          res = await chrome.runtime.sendMessage({ type: 'HMDAO_GET_DOUBAO_WS_AUDIO', ts });
        } catch (_) { res = null; }
        if (!res || !res.ok || !res.b64) {
          try { console.log('[HMDAO][doubao] 实体化跳过：' + ((res && res.error) || 'no-data')); } catch (_) {}
          continue;
        }
        const bytes = b64ToBytes(res.b64);
        const mime = (res.mime && /^audio\//.test(res.mime)) ? res.mime : 'audio/ogg';
        const blob = new Blob([bytes], { type: mime });
        const blobUrl = URL.createObjectURL(blob);
        a.url = blobUrl;
        a.__wsBlob = blobUrl;
        a.wsAudio = true;
        a.wsTs = a.wsTs || ts;
        a.mime = mime;
        a.size = Number(res.size) || bytes.length;
        changed = true;
      }
      // ★实体化失败的（拿不到字节、仍是伪 URL）一律剔除：
      //   剔除判据【只看 URL】——wsAudio 标记在链路中可能丢失（scanPage 重建只留 url/type/source），
      //   靠标记判断会漏掉这些卡 → 留下"点不动还刷错误日志"的幽灵卡（实测复现）。
      try {
        const before = (window.assets || []).length;
        window.assets = (window.assets || []).filter((x) => !(
          x && (x.wsAudio || /^doubao-ws-audio:/i.test(String(x.url || ''))) && !x.__wsBlob
        ));
        if ((window.assets || []).length !== before) changed = true;
      } catch (_) {}
      if (changed) {
        try { window.__hmdaoAssets = window.assets.slice(); } catch (_) {}
        try { renderNow(); } catch (_) {}
      }
    } catch (_) {}
  }

  // 接收扫描结果广播，更新状态
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'HMDAO_SCAN_RESULT' && Array.isArray(msg.assets)) {
      console.log('[HMDAO][sidepanel] SCAN_RESULT 收到 assets=' + msg.assets.length + ' url=' + (msg.url || ''));
      // ★2026-09-03：记录「本次扫描时的当前集」与「上次」对比，用于切集时实时刷新高亮/徽标（不等全量重建）。
      const prevCurAweme = (typeof window.__hmdao_curAwemeId === 'string') ? window.__hmdao_curAwemeId : '';
      // ★2026-09-01 修复（封面 403 无回退 / 预览·下载拿不到源页真凶）：
      //   window.__hmdao_sourceTabId 【从未被赋值】（全仓搜索 `window.__hmdao_sourceTabId =` 零命中）
      //   → media-fetch.js:107 第二层「源页 MAIN 世界带会话 Cookie 的 IN_TAB fetch」永远不执行
      //   → 抖音图床防盗链 403（日志：FETCH_MEDIA skip(host=p5-ex-gddgtc-sign.douyinpic.com,
      //     status=403)）之后【无任何回退】→ 封面空白。
      //   同理 download.js:402/663 的 HMDAO_DOWNLOAD_IN_TAB 也拿不到 tabId。
      //   修复：SCAN_RESULT 广播本就带 tabId（scan.js:1149），在此落地。
      try { if (typeof msg.tabId === 'number') window.__hmdao_sourceTabId = msg.tabId; } catch (_) {}
      // ★2026-09-03：记录「当前正在播放的集」awemeId，供侧栏精确高亮 + 打 📍 未播放 徽标（切集实时跟随源页）。
      try { window.__hmdao_curAwemeId = (msg.curAwemeId || '') ? String(msg.curAwemeId) : ''; } catch (_) {}
      // 切集时允许当前卡自动滚入可视区（card-render 的 _hmdaoScrolled 防止重复滚动）。
      try { window.__hmdao_autoScrollCurrent = (prevCurAweme !== (msg.curAwemeId || '')); } catch (_) {}
      // ★2026-09-01 修复（切站残留根因）：每次扫描结果带来源页 url；若与当前页不同，
      //   说明已切到其他网站/视频 → 清空普通资产（保留批量资产），再增量合并，避免历史残留。
      //   （SPA 同 tab 内导航不会触发 onActivated，旧逻辑只靠 onActivated 清空，故残留；此处用 url 兜底。）
      // ★2026-09-04 修复：从【整 URL】改为【站点 host】判定切站——合集页内切集 modal_id 变化属同站，
      //   不再清卡（否则数量"一会多一会少"）。仅真正切到不同站点(b站/YouTube 等)才清。
      try {
        // ★2026-09-07 建议2（防御性兜底/双保险）：与「当前展示页」(window.__sourcePageUrl，auto 导航会同步) 比对，
        //   而非 currentSourceUrl（auto 轻量同步路径不会更新它，易滞后 → 漏清）。一旦 SCAN_RESULT 的来源页与当前
        //   展示页文档身份不同（跨 path / 跨站 / hash 路由开启时跨 hash），直接清空旧资产再增量合并，
        //   即便 auto 分支的清空因竞态/事件丢失被跳过，此处也能兜住，彻底杜绝不同链接记录混显。
        const incomingUrl = (msg.url || '').toString();
        // ★2026-09-08 关键修正（imini 显示 runninghub 历史素材、重扫也不清的根因）：
        //   __sourcePageUrl 在【切标签那一刻】就被别处(:1116)更新成新站了 —— 等扫描结果回来，
        //   displayedUrl 与 incomingUrl 已相等 → idChanged 恒 false → 永不清残留。
        //   改为比对「当前展示资产所属页身份」(__hmdaoDisplayedPageKey)：它在每次合并后被记录，
        //   只随资产走，不随标签切换走 —— 切站后第一次 SCAN_RESULT 必然 idChanged → 正确清空。
        const displayedUrl = (window.__hmdaoDisplayedPageKey
          ? '__k__' + window.__hmdaoDisplayedPageKey
          : (window.__sourcePageUrl || '')).toString();
        const idChanged = hmdaoSourceIdentityKey(incomingUrl) !== hmdaoSourceIdentityKey(displayedUrl);
        // ★2026-09-08 更正（撤回上一版「0 条不清空」闸门）：
        //   该闸门会让「身份变更但本次扫描为空」的情况【跳过清理】；而 __sourcePageUrl
        //   会在切标签/导航时被别处（:1116）同步更新 → 下一轮 idChanged 变成 false
        //   → 永远不再触发清理 → 实测「即梦 ⇄ runninghub 切换后两站卡片混在一起」。
        //   混显是功能性错误，远比"清成空白"严重，故恢复【换页必清】。
        //   （"闪一下就消失"改由增量合并只加不删 + 换页后轮询快速回填来缓解。）
        if (incomingUrl && displayedUrl && idChanged) {
          // 切站：释放旧卡封面 blob URL，防止快速切源页时 blob 堆积导致内存膨胀/崩溃
          try {
            (window.assets || []).forEach((a) => {
              if (a && a.__hoverCoverBlob && /^blob:/.test(a.__hoverCoverBlob)) { try { URL.revokeObjectURL(a.__hoverCoverBlob); } catch (_) {} }
            });
          } catch (_) {}
          // ★保留「正在下载的普通资产」+「全部批量资产」(批量永清)，其余普通资产随换页丢弃（与 auto 清空同语义）。
          clearAssetsForNewPage();
          if (window.selected && window.selected.clear) window.selected.clear();
          if (typeof batchSelection !== 'undefined' && batchSelection && batchSelection.clear) batchSelection.clear();
          try { renderNow(); } catch (_) {}
        }
        // ★2026-09-10 B（同路径 SPA 切换内容 → 旧卡残留 / 封面错配）：
        //   切站清空的判定基于「文档身份」(origin+pathname)。但 imini / 即梦 / runninghub 这类
        //   多视频画廊站是【同路径 SPA 换内容】（列表刷新、切分类、切到另一个视频），
        //   pathname 不变 → idChanged 恒 false → 上一批视频卡与新一批混在一起，
        //   表现为「封面与卡对不上 / 越扫越多 / 显示上一个站的素材」。
        //   补一条内容层面的判定：本次扫描的视频 URL 与已有视频 URL【完全无交集】
        //   → 视为整批内容被替换，清空旧卡后再增量合并。
        //   例外：抖音 / B站 / YouTube 依赖源页累积（dyUrls 增量合并），清空会导致采不到，一律跳过。
        try {
          const hostOf = (u) => { try { return new URL(String(u || ''), 'https://x/').hostname; } catch (_) { return ''; } };
          const isIncremental = /(^|\.)(douyin|iesdouyin|tiktok|bilibili|youtube)\.(com|cn|tv|be)$/i.test(hostOf(incomingUrl));
          if (!isIncremental) {
            const keyOf = (a) => String((a && a.url) || '').split('?')[0];
            const incV = (Array.isArray(msg.assets) ? msg.assets : []).filter((a) => a && a.type === 'video').map(keyOf).filter(Boolean);
            const prevV = (window.assets || []).filter((a) => a && a.type === 'video').map(keyOf).filter(Boolean);
            if (incV.length && prevV.length && !incV.some((u) => prevV.indexOf(u) >= 0)) {
              clearAssetsForNewPage();
              if (window.selected && window.selected.clear) window.selected.clear();
              try { renderNow(); } catch (_) {}
            }
          }
        } catch (_) {}
        // ★豆包：会话切换（/chat/<id> 变化）时，必须移除上个会话的朗读音频卡。
        //   自动扫描走「增量合并、只加不删」，旧卡会带着旧标题一直留在列表 —— 表现为
        //   "新建任务后标题没刷新/没和源项目同步"。切会话即清音频卡，与源会话保持一致。
        try {
          const cid = (u) => { const m = /\/chat\/(\d+)/.exec(String(u || '')); return m ? m[1] : ''; };
          const cNew = cid(incomingUrl);
          const cOld = cid(currentSourceUrl);
          if (cNew && cOld && cNew !== cOld) {
            // 移除时同步释放 blob URL —— 否则来回切会话会不断泄漏音频字节内存
            window.assets = (window.assets || []).filter((x) => {
              if (x && x.wsAudio) {
                try {
                  if (x.__wsBlob && /^blob:/i.test(x.__wsBlob)) URL.revokeObjectURL(x.__wsBlob);
                } catch (_) {}
                return false;
              }
              return true;
            });
            window.__hmdaoAssets = window.assets.slice();
          }
        } catch (_) {}
        if (incomingUrl) currentSourceUrl = incomingUrl;
      } catch (_) {}
      // ★2026-09-05 关键修复：切换不同抖音合集（mixId 变化）时，旧批量资产必须清空，
      //   否则侧栏会残留上一合集的集数卡（用户看到的"第6集/第14集/第40集"幽灵卡）。
      //   同合集内切集 mixId 不变，批量资产保留。
      try {
        const incomingMixId = (msg.mixId || '').toString();
        const mixChanged = !!(incomingMixId || currentMixId) && incomingMixId !== currentMixId;
        if (mixChanged) {
          // ★2026-09-05 二次修复（"开启批量采集后卡数还是时多时少"）：
          //   信息流批量采集场景下，用户一滚动就会切到下一个视频/合集 → mixId 不停变化。
          //   此前无条件清空 batchAssets → 已采集到的卡被反复抹掉再重采 → 数量忽多忽少，
          //   与"扫描多少是多少、绝不丢"的批量语义直接冲突。
          //   改为：批量采集开启时【保留批量容器】（累积是批量的核心价值），
          //   只在【未开启批量】时按合集切换清理。
          if (!batchCollectEnabled && Array.isArray(batchAssets)) batchAssets.length = 0;
          // ★2026-09-05 补漏：此前只清 __batch 资产，普通资产里的【抖音视频卡】属于上一合集，
          //   不清就会留在列表里 → 切合集后标题/封面仍是旧合集的（"没和切换后的状态同步对齐"）。
          window.assets = (window.assets || []).filter((a) => !(a && a.__batch)
            && !(a && a.platform === 'douyin' && a.type === 'video'));
          window.__hmdaoLastScanSig = null; // 允许下一轮重新持久化（内容已变）
          if (window.selected && window.selected.clear) window.selected.clear();
          if (typeof batchSelection !== 'undefined' && batchSelection && batchSelection.clear) batchSelection.clear();
          console.log('[HMDAO][sidepanel] 合集切换：mixId %s → %s，清空批量资产', currentMixId || '(空)', incomingMixId || '(空)');
        }
        if (incomingMixId) currentMixId = incomingMixId;
      } catch (_) {}
      // ★2026-08-23 修复（问题3 断裂A）：扫描结果必须回填到 window.assets 才能显示卡片。
      //   旧逻辑只写 __hmdaoAssets（仅计数），导致 SCAN_RESULT 永不进卡片列表 → 刷新/扫描后无素材。
      //   改为「增量合并 + 按 url 去重」：普通扫描资产与批量资产分别归位，合并展示。
      try {
        if (!Array.isArray(window.assets)) window.assets = [];
        // 扫描结果分流：批量扫描模式下产出的「视频」归入 batchAssets（独立容器、重扫不清空）；
        // 其余（图片/音频/文档/模型等普通素材）一律归 window.assets（扫描多少是多少，随页保留）。
        // 显式 __batch 标记的（BATCH_COLLECT 按钮采集的）无条件入 batchAssets。
        const scanBatchMode = !!msg.batchMode;
        const incoming = msg.assets || [];
        // ★2026-09-11 诊断（侧栏 0 卡片定位）：打印入站资产真实形态，确认是否缺 url / 被误判批量。
        try {
          console.log('[HMDAO_DIAG][merge] 入站 assets=' + incoming.length
            + ' batchMode=' + !!msg.batchMode + ' batchCollectEnabled=' + !!batchCollectEnabled
            + ' 明细=' + JSON.stringify(incoming.map((a) => ({ t: a && a.type, hasUrl: !!(a && a.url), url0: ((a && a.url) || '').slice(0, 48), platform: a && a.platform, aid: a && a.awemeId, batch: !!(a && a.__batch) }))));
        } catch (_) {}
        const incoming_normal = []; // 本次扫描产出的普通（非批量）资产暂存
        // ★2026-09-04 修复（批量合集封面/标题"切集后不刷新"真凶）：
        //   此前批量资产只"追加不更新"——首次合成批量卡时若封面/标题尚为空(详情 API 未补齐)，
        //   之后 dyCoverByAweme/dyTitlesByAweme 补齐了也永远写不进 batchAssets → 卡片封面/标题恒为空/旧值。
        //   现改为：按 awemeId(优先) 或 url 找到已存在批量卡则就地更新元数据；找不到才新增。
        const BATCH_META_KEYS = ['cover', 'title', 'episodeNo', 'modalId', 'playerUrl', 'dashAudio', 'awemeId', 'dyFormats'];
        const applyBatchMeta = (tgt, src) => {
          for (const k of BATCH_META_KEYS) { const nv = src[k]; if (nv == null || nv === '') continue; tgt[k] = nv; }
          if (src.notPlayed !== undefined) tgt.notPlayed = src.notPlayed;
        };
        for (const a of incoming) {
          if (!a) continue;
          const isBatchItem = a.__batch || (scanBatchMode && a.type === 'video');
          if (isBatchItem) {
            const ex = batchAssets.find(x => (a.awemeId && x.awemeId === a.awemeId) || x.url === a.url);
            if (ex) applyBatchMeta(ex, a);
            else if (!batchAssets.some(x => x.url === a.url)) batchAssets.push(Object.assign({}, a, { __batch: true }));
          } else {
            // 普通资产暂存（稍后与批量合并进 window.assets）
            if (!incoming_normal.some(x => x.url === a.url)) incoming_normal.push(a);
          }
        }
        // 重新构造 window.assets = 现有普通资产（去重 incoming_normal） + (批量开启时)批量资产副本
        // ★2026-08-23 深层修复（根因3）：关闭批量时 window.assets 仅普通，batchAssets 不泄漏进展示列表。
        // ★2026-08-30 修复（"素材闪烁消失"根因）：
        //   此前每次 SCAN_RESULT 到达都【清空该 tab 全部旧资产】，再用本次 incoming 全量替换。
        //   轮询/重复扫描时，若某次扫描产出较少（页面元素未加载完/懒加载未触发），
        //   素材数会"变少又变多" → 用户看到卡片【闪烁后消失】。
        //   改为【增量合并】：保留已采集到的资产，只追加本次新增（按 url 去重），从不删除。
        //   切 tab / 换页的"残留清除"已由 onActivated / doRescan 的显式清空保证，此处不再重复丢弃。
        const existingNormal = (window.assets || []).filter(a => !(a && a.__batch));
        // ★2026-09-04 修复（用户要求"单卡跟随源页当前视频整体替换"）：非批量模式下，侧栏只保留
        //   【与源页当前视频同 awemeId】的那一张卡，上一集(different awemeId)直接丢弃 → 始终一张卡跟随源页，
        //   标题/封面随源页当前视频刷新，绝不与源视频不一致。批量模式(合集)不受影响（保留全部集数卡）。
        if (!batchCollectEnabled) {
          let curAid = null;
          for (const a of incoming_normal) { if (a && a.platform === 'douyin' && a.type === 'video' && a.awemeId) { curAid = String(a.awemeId); break; } }
          if (!curAid && incoming_normal[0] && incoming_normal[0].awemeId) curAid = String(incoming_normal[0].awemeId);
          if (curAid) {
            for (let i = existingNormal.length - 1; i >= 0; i--) {
              const x = existingNormal[i];
              if (x && x.platform === 'douyin' && x.type === 'video' && x.awemeId && String(x.awemeId) !== curAid) existingNormal.splice(i, 1);
            }
          }
        }
        // ★2026-08-30 修复（用户要求"判断有没有新素材，有新才刷新"）：
        //   先算出【真正的新增项】（url 不在已有集合中）。若【无新增】→ 直接 return，
        //   不更新 window.assets、不刷新扫描状态、不触发渲染 → 彻底消除"无变化也闪烁"。
        //   轮询（10s/12s）因此变成"增量感知"而非"无条件全量刷新"。
        const existingUrls = new Set(existingNormal.map(a => a && a.url).filter(Boolean));
        // ★2026-09-03 修复（标题 / 封面 / 集数不跟随源页刷新的真凶）：
        //   增量合并此前只认「新 URL」，同 url 或 同 awemeId 的资产一律跳过 →
        //   首次抓到某集时标题/封面/集数常还是空的，之后详情 API 补齐了元数据，
        //   却因「不是新 URL」永远补不进去 → 侧栏标题/封面/集数不跟随源页切换刷新。
        //   现分三种情况处理：
        //     ① 同 awemeId 且同 url → 就地更新元数据（补全标题/封面/集数）；
        //     ② 同 awemeId 但 url 变了（切集后捕获到新签名直链）→ 用新卡替换旧卡（旧直链已过期，留着就是"只有声音"废卡）；
        //     ③ 同 url → 就地更新元数据。
        const META_KEYS = ['cover', 'title', 'episodeNo', 'modalId', 'playerUrl', 'dashAudio', 'awemeId', 'dyFormats'];
        const metaOf = (x) => { try { return JSON.stringify(x); } catch (_) { return String(x); } };
        let metaChanged = false;
        const applyMeta = (tgt, src) => {
          for (const k of META_KEYS) {
            const nv = src[k];
            if (nv == null || nv === '') continue;
            if (metaOf(tgt[k]) === metaOf(nv)) continue;
            tgt[k] = nv;
            metaChanged = true;
          }
          // notPlayed 是布尔，false 也要能写回（旧卡从"未播放"变"当前播放"）
          if (src.notPlayed !== undefined && tgt.notPlayed !== src.notPlayed) { tgt.notPlayed = src.notPlayed; metaChanged = true; }
        };
        const addedNormal = [];
        for (const a of incoming_normal) {
          if (!a || !a.url) continue;
          const isDy = (a.platform === 'douyin' && a.type === 'video' && !!a.awemeId);
          let idx = isDy
            ? existingNormal.findIndex(x => x && x.platform === 'douyin' && x.type === 'video' && String(x.awemeId) === String(a.awemeId))
            : -1;
          if (idx >= 0) {
            if (existingNormal[idx].url === a.url) { applyMeta(existingNormal[idx], a); continue; }
            // ★2026-09-04 修复（批量合集 57 卡侧栏闪烁/卡死真凶）：
            //   抖音 play_addr 是带签名、会过期的直链，每次扫描都会换一个新 url。
            //   旧逻辑 ② 把旧卡整张丢弃、再 push 新卡 → 触发 full re-render →
            //   57 张卡每轮轮询全部重建、封面图重新加载 → 卡片"一会多一会少/封面闪烁"、侧栏卡死。
            //   但 url 轮换对【视觉】无任何变化（同一集、同一封面/标题），无需重建 DOM。
            //   现改为【原地更新 url 字段】：卡片 DOM 不变、封面不重载，仅底层直链悄然刷新。
            //   除非封面/标题等真正视觉字段也变了，否则不触发 metaChanged → 不重渲染。
            existingNormal[idx].url = a.url;
            applyMeta(existingNormal[idx], a); // cover/title/episodeNo 等真变了才置 metaChanged
            continue;
          }
          idx = existingNormal.findIndex(x => x && x.url === a.url);
          if (idx >= 0) { applyMeta(existingNormal[idx], a); continue; } // ③
          addedNormal.push(a);
        }
        const addedBatch = batchAssets.filter(b => b && b.url && !existingUrls.has(b.url));
        if (addedNormal.length === 0 && addedBatch.length === 0) {
          // 无新素材 → 若元数据有更新 或 「当前集」变化，仍刷新一次（让标题/封面/集数/高亮跟随源页）；
          // 否则静默跳过（不重建 DOM、不重载图片），消除无变化也闪烁。
          if (metaChanged || (prevCurAweme && prevCurAweme !== (msg.curAwemeId || ''))) {
            try { renderNow(); } catch (_) {}
          }
          return;
        }
        // 有新增 → 增量合并（保留已有 + 追加新增），从不删除
        const normalMerged = existingNormal.concat(addedNormal);
        const batchMerged = batchAssets.concat((window.assets || []).filter(a => a && a.__batch).filter(a => !batchAssets.some(b => b.url === a.url)));
        window.assets = batchCollectEnabled ? normalMerged.concat(batchMerged) : normalMerged;
        // ★2026-09-11 诊断：合并后 window.assets 实际条数与类型构成。
        try {
          console.log('[HMDAO_DIAG][merge] 合并后 window.assets=' + (window.assets || []).length
            + ' 明细=' + JSON.stringify((window.assets || []).map((a) => ({ t: a && a.type, hasUrl: !!(a && a.url), url0: ((a && a.url) || '').slice(0, 48), platform: a && a.platform }))));
        } catch (_) {}
        // 合并展示列表（普通 + 批量），更新计数与渲染
        const combined = window.assets.slice();
        window.__hmdaoAssets = combined.slice();
        // ★2026-09-08：记录「当前展示资产所属页身份」，供下一次 SCAN_RESULT 判定换站清残留
        //（不随标签切换漂移，只随资产走 —— 修复 imini 显示 runninghub 历史素材的根因）
        try { window.__hmdaoDisplayedPageKey = hmdaoSourceIdentityKey(incomingUrl || window.__sourcePageUrl || ''); } catch (_) {}
      } catch (e) { console.warn('[HMDAO][sidepanel] SCAN_RESULT 合并异常:', e, '\nassets示例=', JSON.stringify((msg.assets || []).slice(0, 3))); }
      // ★2026-09-06 豆包朗读：把 WS 流式音频「实体化」为侧栏 blob URL。
      //   根因：scanPage 的 push(url,type,source) 会重建资产对象、丢掉 wsAudio/wsTs/platform/title，
      //   卡片退化成「伪 URL 的普通音频」→ 试听/下载全部走错通道（实测 source 被写成 'network'）。
      //   改为在侧栏把字节取回、转成真实 blob: URL 写回 a.url —— 之后它就是一张普通音频卡，
      //   悬停试听/下载/停止全部复用现有通用路径，不再有任何伪 URL 泄漏到后续逻辑。
      try { hydrateDoubaoWsAudios(); } catch (_) {}
      // ★2026-08-23 修复（问题3 根因：刷新/重启侧栏后视频卡全丢）：
      //   旧逻辑只有 addXunleiFiles(1218) 写 lastScan，SCAN_RESULT 处理器从不持久化，
      //   导致普通扫描的视频资产重启即丢 → 用户报"刷新后 URL 全部丢失，扫描无法加载出视频"。
      //   修复：每次 SCAN_RESULT 处理完毕，按 url 去重持久化到 lastScan（含 batchAssets + 普通 + url + ts），
      //   侧栏重启时由 4040-4060 段的 lastScan 初始化逻辑完整恢复（已含 __batch 分流 + ls.url 回填）。
      try {
        if (Array.isArray(window.assets) && window.assets.length) {
          const allAssets = window.assets.slice();
          const persistedUrls = new Set();
          const persistList = [];
          // ★2026-09-09：图片上限放宽到 200 条后，全量持久化体积骤增。
          //   资产里可能挂着封面 dataURL / base64 预览（单条可达数 MB），整表入库会撑爆
          //   storage.local 配额 → set 静默失败 → 刷新后一条都恢复不了。
          //   这里只剔除「超长字符串字段」（>4096，实际只可能是 dataURL/b64），其余字段原样保留；
          //   封面等可视化字段运行时照常存在，恢复后由卡片懒加载重新生成，功能不降级。
          const slimAsset = (a) => {
            const o = {};
            for (const k of Object.keys(a)) {
              const v = a[k];
              o[k] = (typeof v === 'string' && v.length > 4096) ? '' : v;
            }
            return o;
          };
          const PERSIST_MAX = 500;
          for (const a of allAssets) {
            if (!a || !a.url || persistedUrls.has(a.url)) continue;
            if (persistList.length >= PERSIST_MAX) break;
            persistedUrls.add(a.url);
            persistList.push(slimAsset(a));
          }
          // ★2026-09-05 节流：此前「每次 SCAN_RESULT」都写 lastScan —— 上百条资产的 JSON 序列化
          //   + storage 写入 + storage.onChanged 触发重渲染，是侧栏卡顿的一环。
          //   改为：内容签名未变不写；即便变了也最多 3 秒一次（下一轮扫描会补上）。
          const __sig = persistList.length + '|' + persistList.map((a) => a.awemeId || a.url || '').join('|').length;
          const __now = Date.now();
          if (persistList.length && __sig !== window.__hmdaoLastScanSig && __now - (window.__hmdaoLastScanTs || 0) > 3000) {
            window.__hmdaoLastScanSig = __sig;
            window.__hmdaoLastScanTs = __now;
            chrome.storage.local.get('lastScan', (s) => {
              const ls = (s && s.lastScan) || {};
              if (currentSourceUrl) ls.url = currentSourceUrl;
              ls.assets = persistList;
              ls.ts = Date.now();
              // 优先从 sender/active tab 取 tabId（无则保留 ls.tabId）
              try {
                chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                  if (tabs && tabs[0] && tabs[0].id != null) ls.tabId = tabs[0].id;
                  try { chrome.storage.local.set({ lastScan: ls }); } catch (_) {}
                });
              } catch (_) { try { chrome.storage.local.set({ lastScan: ls }); } catch (_) {} }
            });
          }
        }
      } catch (_) {}
      updateScanStatus(msg.assets, 'done');
      try { renderNow(); } catch (_) {}
    }
  });

  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation(); chat.style.display = 'none';
    chat.classList.remove('full'); if (fullBtn) fullBtn.textContent = '⛶';
  });

  // ★2026-08-23 真机验证：暴露一键诊断函数，汇总侧栏 + 源页 + 持久化状态。
  //   用法：侧栏 F12 Console 运行 __hmdaoRunFullDiag()（亦可传入 {rescan:true} 先触发扫描）。
  window.__hmdaoRunFullDiag = async function (opts) {
    opts = opts || {};
    if (opts.rescan) {
      try { chrome.runtime.sendMessage({ type: 'HMDAO_SCAN_REQUEST', batchMode: batchCollectEnabled }); } catch (_) {}
    }
    const sidepanel = {
      currentSourceUrl: currentSourceUrl || '',
      window_assets_total: (window.assets || []).length,
      normal_total: (window.assets || []).filter((a) => !(a && a.__batch)).length,
      batchAssets_total: (batchAssets || []).length,
      batchVisibleInAssets: (window.assets || []).filter((a) => a && a.__batch).length,
      __hmdaoAssets_total: (window.__hmdaoAssets || []).length,
      consistent: ((window.assets || []).filter((a) => !(a && a.__batch)).length + (window.assets || []).filter((a) => a && a.__batch).length) === (window.assets || []).length
        && (window.assets || []).length === (window.__hmdaoAssets || []).length,
    };
    const lastScan = await new Promise((res) => { try { chrome.storage.local.get('lastScan', (s) => res((s && s.lastScan) || null)); } catch (_) { res(null); } });
    let page = null;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id != null) {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: 'MAIN',
          func: () => {
            const c = window.__hmdao_captures || {};
            // 视频/图片扫描全面诊断（2026-08-24 增补 liblib 等"hover 才挂 video"站点排查）
            const vs = Array.from(document.querySelectorAll('video'));
            const imgs = Array.from(document.querySelectorAll('img'));
            // 卡片容器探测：liblib 网格常见 class 含 card / item / video-card
            const cardLike = Array.from(document.querySelectorAll('[class*="card"],[class*="item"],[class*="video"]')).slice(0, 20);
            // shadow root 内 video 探测（普通 Observer 看不到）
            let shadowVideos = 0;
            try {
              const all = document.querySelectorAll('*');
              for (const el of all) {
                if (el.shadowRoot) {
                  shadowVideos += el.shadowRoot.querySelectorAll('video').length;
                }
              }
            } catch (_) {}
            return {
              url: location.href,
              dyUrlsCount: (c.dyUrls || []).length,
              curAwemeId: c.curAwemeId || '(空)',
              hasFirstFrame: !!(c.curFirstFrame && c.curFirstFrame.dataUrl),
              curVideoSrc: (c.curVideoSrc || '').slice(0, 60),
              // 新增视频诊断
              apiVideosCount: (c.apiVideos || []).length,
              apiVideosSample: (c.apiVideos || []).slice(0, 8),
              videoCount: vs.length,
              shadowVideoCount: shadowVideos,
              videoSample: vs.slice(0, 5).map((v) => ({
                src: (v.src || '').slice(0, 90),
                currentSrc: (v.currentSrc || '').slice(0, 90),
                poster: (v.poster || '').slice(0, 90),
                preload: v.preload,
                readyState: v.readyState,
                paused: v.paused,
                hasDataSrc: !!v.dataset.src,
                dataVideoUrl: (v.dataset.videoUrl || v.dataset.mp4 || v.dataset.src || '').slice(0, 90),
              })),
              imgCount: imgs.length,
              cardSample: cardLike.slice(0, 6).map((el) => ({
                cls: (el.className || '').toString().slice(0, 60),
                hasVideo: !!el.querySelector('video'),
                hasImg: !!el.querySelector('img'),
                imgSrc: (el.querySelector('img') && el.querySelector('img').src || '').slice(0, 80),
              })),
            };
          },
        });
        page = r && r.result;
      }
    } catch (e) { page = { error: String(e && e.message || e) }; }

    // ===== 2026-09-02 扩展：抖音下载链路专项自检（playApi 连通性 + dNR 规则）=====
    //   目的：用户无需手动拼接/复制 playApi，执行 __hmdaoRunFullDiag() 即可自动完成探测。
    let dy = null;
    try {
      const [tab2] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab2 && tab2.id != null && /douyin\.com/i.test(tab2.url || '')) {
        const [r2] = await chrome.scripting.executeScript({
          target: { tabId: tab2.id }, world: 'MAIN',
          func: async () => {
            try {
              if (typeof window.__hmdaoScanDyRenderData === 'function') window.__hmdaoScanDyRenderData();
              const c = window.__hmdao_captures || {};
              const aid = c.curAwemeId || (new URL(location.href).searchParams.get('modal_id')) || '';
              const f = (c.dyFormatsByAweme || {})[aid] || [];
              const mixed = f.find((x) => /含音画/.test(x.label || '')) || f.find((x) => x.is_default);
              const out = { aid, formatCount: f.length, hasMixed: !!mixed, labels: f.slice(0, 6).map((x) => x.label) };
              if (mixed && mixed.url) {
                out.playApiHead = String(mixed.url).slice(0, 80);
                try {
                  const resp = await fetch(mixed.url, { credentials: 'include' });
                  const b = await resp.blob();
                  out.probe = { status: resp.status, size: b.size, type: b.type, isVideo: /video|mp4|octet/i.test(b.type) };
                } catch (e) { out.probe = { err: String((e && e.message) || e) }; }
              }
              return out;
            } catch (e) { return { err: String((e && e.message) || e) }; }
          },
        });
        dy = (r2 && r2.result) || null;
      }
    } catch (e) { dy = { err: String((e && e.message) || e) }; }

    let dnr = null;
    try {
      const rules = await chrome.declarativeNetRequest.getSessionRules();
      dnr = {
        sessionRules: rules.length,
        douyinvodRules: rules.filter((r) => {
          const d = (r.condition && r.condition.domains) || (r.condition && r.condition.requestDomains) || [];
          return d.some((x) => x && x.includes('douyinvod'));
        }).length,
      };
    } catch (e) { dnr = { err: String((e && e.message) || e) }; }

    const report = { sidepanel, lastScan: lastScan ? { count: (lastScan.assets || []).length, url: lastScan.url || '', ts: lastScan.ts } : null, page, dy, dnr };
    console.log('%c[HMDAO 全量诊断]', 'color:#1ea7fd;font-weight:bold', report);
    // 逐项结论
    const L = (ok, name, good, bad) => console.log((ok ? '%c[✓] ' : '%c[✗] ') + name + (ok ? good : bad), ok ? 'color:#52c41a' : 'color:#ff4d4f');
    L(sidepanel.window_assets_total > 0, '断裂A·SCAN_RESULT 回填', 'window.assets 已填充=' + sidepanel.window_assets_total, 'window.assets 为空，SCAN_RESULT 未回填');
    L(sidepanel.consistent, '一致性·window.assets=普通+批量', '一致', 'window.assets 与 __hmdaoAssets 不一致');
    L(sidepanel.batchAssets_total === sidepanel.batchVisibleInAssets, '隔离D·批量资产可见', '批量 ' + sidepanel.batchAssets_total + ' 条均在卡片', '批量资产未在 window.assets 展示');
    L(!!(lastScan && (lastScan.assets || []).length), '持久化B·lastScan', '已存 ' + (lastScan ? lastScan.count : 0) + ' 条', 'lastScan 为空，刷新无法恢复');
    if (page && !page.error) {
      L(page.dyUrlsCount > 0, '累积C·源页 dyUrls', 'dyUrls=' + page.dyUrlsCount + '（同页刷新未清空）', 'dyUrls 为空，可能误清空或尚未播放');
      L(!!page.curAwemeId && page.curAwemeId !== '(空)', '精准·curAwemeId', '命中 ' + page.curAwemeId, 'curAwemeId 空，sync 将回退末条/playerUrl 兜底');
      // 视频诊断结论（2026-08-24）
      console.log('%c[视频·网络层 apiVideos]', 'color:#722ed1', 'count=' + page.apiVideosCount, page.apiVideosSample);
      console.log('%c[视频·DOM <video>]', 'color:#722ed1', 'videoCount=' + page.videoCount + ' shadowVideoCount=' + page.shadowVideoCount, page.videoSample);
      console.log('%c[视频·卡片结构]', 'color:#722ed1', page.cardSample);
      L(page.apiVideosCount > 0 || page.videoCount > 0, '视频·可捕获源', 'apiVideos=' + page.apiVideosCount + ' / DOM video=' + page.videoCount, '两者皆空 → 视频在 hover/接口外，需专属探针或 shadow DOM 穿透');
      if (page.shadowVideoCount > 0) console.warn('%c[⚠] 发现 shadow root 内 video=' + page.shadowVideoCount + '，普通 Observer 不可见，需穿透 shadow 扫描', 'color:#ffb020');
    } else if (page && page.error) {
      console.warn('%c[⚠] 源页读取失败：' + page.error, 'color:#ffb020');
    }
    // 抖音下载链路结论（2026-09-02）
    if (dy && !dy.err) {
      console.log('%c[抖音·playApi 探测]', 'color:#722ed1', dy);
      L(!!(dy.probe && dy.probe.isVideo), '抖音·playApi 连通性',
        '有效 status=' + (dy.probe && dy.probe.status) + ' size=' + (dy.probe && dy.probe.size) + ' type=' + (dy.probe && dy.probe.type),
        '失效 → ' + JSON.stringify(dy.probe || {}) + '（playApi 过期或被 CDN 拒）');
    } else if (dy && dy.err) {
      console.warn('%c[⚠] playApi 探测异常：' + dy.err, 'color:#ffb020');
    }
    if (dnr && !dnr.err) {
      L(dnr.douyinvodRules > 0, '抖音·dNR session 规则',
        'douyinvod 规则=' + dnr.douyinvodRules + '（session 池共 ' + dnr.sessionRules + ' 条）',
        'session 池中无 douyinvod 规则（注意：须用 getSessionRules，不是 getDynamicRules）');
    }
    return report;
  };
  // ★2026-09-02 一键自动化测试：抖音下载全链路。自动跑完
  //   「定位源页 → 取 playApi → 依次尝试 4 种下载方式 → 回查 chrome.downloads 任务最终状态」，
  //   每步输出成败与原因，一次执行即可定位断裂层。用法：侧栏 Console 运行 __hmdaoTestDyDownload()
  window.__hmdaoTestDyDownload = async function () {
    const log = [];
    const T = (name, r) => { const item = { step: name, ...(r || {}) }; log.push(item); console.log('[DY-TEST] ' + name, r); };
    try {
      // 1) 定位抖音源页
      const tabs = await chrome.tabs.query({});
      const dyTab = (tabs || []).find((t) => /douyin\.com/i.test(t.url || ''));
      T('1.定位源页', { ok: !!dyTab, url: dyTab ? String(dyTab.url).slice(0, 70) : '(未找到)' });
      if (!dyTab) return log;

      // 2) 取 playApi（先触发 SSR 补扫，保证索引最新）
      const [r0] = await chrome.scripting.executeScript({
        target: { tabId: dyTab.id }, world: 'MAIN',
        func: () => {
          try {
            if (typeof window.__hmdaoScanDyRenderData === 'function') window.__hmdaoScanDyRenderData();
            const c = window.__hmdao_captures || {};
            const aid = c.curAwemeId || (new URL(location.href).searchParams.get('modal_id')) || '';
            const f = (c.dyFormatsByAweme || {})[aid] || [];
            const mixed = f.find((x) => /含音画/.test(x.label || '')) || f.find((x) => x.is_default);
            return { ok: !!mixed, aid, formatCount: f.length, playApi: mixed ? String(mixed.url) : '' };
          } catch (e) { return { ok: false, err: String((e && e.message) || e) }; }
        },
      });
      const s0 = (r0 && r0.result) || {};
      T('2.取 playApi', { ok: s0.ok, aid: s0.aid, formatCount: s0.formatCount, head: String(s0.playApi || '').slice(0, 70) });
      if (!s0.playApi) return log;
      const playApi = s0.playApi;

      // 3A) 源页 fetch（预期：若 302 到跨域 CDN 则 CORS 失败）
      const [rA] = await chrome.scripting.executeScript({
        target: { tabId: dyTab.id }, world: 'MAIN',
        func: async (u) => {
          try {
            const r = await fetch(u, { credentials: 'include' });
            const b = await r.blob();
            return { ok: true, status: r.status, size: b.size, type: b.type };
          } catch (e) { return { ok: false, err: String((e && e.message) || e) }; }
        },
        args: [playApi],
      });
      T('3A.源页 fetch', (rA && rA.result) || {});

      // 3B) fetch(redirect:manual)：确认是否 302，以及重定向到哪个域
      const [rB] = await chrome.scripting.executeScript({
        target: { tabId: dyTab.id }, world: 'MAIN',
        func: async (u) => {
          try {
            const r = await fetch(u, { redirect: 'manual', credentials: 'include' });
            return { ok: true, status: r.status, type: r.type, location: r.headers ? r.headers.get('location') : null };
          } catch (e) { return { ok: false, err: String((e && e.message) || e) }; }
        },
        args: [playApi],
      });
      const sB = (rB && rB.result) || {};
      if (sB.location) { try { sB.locationHost = new URL(sB.location).hostname; } catch (_) {} sB.location = String(sB.location).slice(0, 70); }
      T('3B.fetch(redirect:manual)', sB);

      // 3C) 同源 <a download>（当前采用的方案）
      const [rC] = await chrome.scripting.executeScript({
        target: { tabId: dyTab.id }, world: 'MAIN',
        func: (u) => {
          try {
            const a = document.createElement('a');
            a.href = u; a.download = 'hmdao_test_C.mp4'; a.rel = 'noopener';
            document.body.appendChild(a); a.click();
            setTimeout(() => { try { a.remove(); } catch (_) {} }, 3000);
            return { ok: true, method: 'anchor-download', host: new URL(u).hostname };
          } catch (e) { return { ok: false, err: String((e && e.message) || e) }; }
        },
        args: [playApi],
      });
      T('3C.同源 <a download>', (rC && rC.result) || {});

      // 3D) chrome.downloads 直连（预期 403 / SERVER_FORBIDDEN，用于对照）
      const d = await new Promise((resolve) => {
        try {
          chrome.downloads.download({ url: playApi, filename: 'Ddayup/videos/hmdao_test_D.mp4', saveAs: false }, (id) => {
            if (chrome.runtime.lastError) resolve({ ok: false, err: chrome.runtime.lastError.message });
            else resolve({ ok: true, id });
          });
        } catch (e) { resolve({ ok: false, err: String((e && e.message) || e) }); }
      });
      T('3D.chrome.downloads 直连', d);
      if (d && d.id != null) {
        await new Promise((r) => setTimeout(r, 3500));
        const st = await new Promise((resolve) => {
          try { chrome.downloads.search({ id: d.id }, (items) => resolve(items && items[0])); }
          catch (_) { resolve(null); }
        });
        T('3D-2.任务最终状态', st ? {
          state: st.state, bytesReceived: st.bytesReceived, totalBytes: st.totalBytes,
          error: st.error, finalUrl: String(st.finalUrl || '').slice(0, 70),
        } : {});
      }
    } catch (e) {
      T('FATAL', { err: String((e && e.message) || e) });
    }
    console.log('%c[DY-TEST 汇总]', 'color:#1ea7fd;font-weight:bold', log);
    return log;
  };
  console.log('%c[HMDAO] 真机诊断已就绪：侧栏 Console 运行 __hmdaoRunFullDiag() （或 __hmdaoRunFullDiag({rescan:true}) 先扫描）', 'color:#1ea7fd');
  console.log('%c[HMDAO] 抖音下载链路自动测试：侧栏 Console 运行 __hmdaoTestDyDownload()', 'color:#1ea7fd');

  // 「全屏」：聊天框覆盖整个侧栏显示（再次点击还原）
  const fullBtn = document.getElementById('aiBotFull');
  if (fullBtn) fullBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    chat.classList.toggle('full');
    fullBtn.textContent = chat.classList.contains('full') ? '⤡' : '⛶';
  });

  // 拖动 vs 点击：pointer 事件 + 阈值区分
  btn.addEventListener('pointerdown', (e) => {
    dragging = true; moved = false;
    startX = e.clientX; startY = e.clientY;
    const r = bot.getBoundingClientRect();
    origX = r.left; origY = r.top;
    try { btn.setPointerCapture(e.pointerId); } catch (_) {}
  });
  btn.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
    const nx = Math.max(0, Math.min(window.innerWidth - 36, origX + dx));
    const ny = Math.max(0, Math.min(window.innerHeight - 36, origY + dy));
    bot.style.left = nx + 'px'; bot.style.top = ny + 'px';
    bot.style.right = 'auto'; bot.style.bottom = 'auto';
  });
  btn.addEventListener('pointerup', (e) => {
    dragging = false;
    try { btn.releasePointerCapture(e.pointerId); } catch (_) {}
    if (!moved) chat.style.display = (chat.style.display === 'none' ? 'flex' : 'none');
  });

  // 眼睛 + 眼镜跟随鼠标
  const glasses = document.getElementById('aiBotGlasses');
  document.addEventListener('mousemove', (e) => {
    if (!botVisible) return;
    const r = btn.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const ang = Math.atan2(e.clientY - cy, e.clientX - cx);
    const dist = Math.min(2.5, Math.hypot(e.clientX - cx, e.clientY - cy) / 30);
    const px = (Math.cos(ang) * dist).toFixed(2), py = (Math.sin(ang) * dist).toFixed(2);
    if (pupilL) pupilL.style.transform = `translate(${px}px, ${py}px)`;
    if (pupilR) pupilR.style.transform = `translate(${px}px, ${py}px)`;
    if (glasses) {
      const tilt = Math.max(-6, Math.min(6, (e.clientX - cx) / 8));
      glasses.style.transform = `translateX(-50%) rotate(${tilt * 0.12}deg) translateX(${tilt * 0.18}px)`;
    }
  });

  function addMsg(role, content) {
    const d = document.createElement('div');
    d.className = 'ai-msg ' + role;
    d.textContent = content;
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
  }

  // 持续复制模式：监听活动页回传的选区，实时写剪贴板 + 回填输入框。
  let copyStreamActive = false;
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.__hmdaCopyStream) return;
    if (msg.done) {
      copyStreamActive = false;
      statusEl.textContent = msg.text ? `已复制选中文案（${msg.text.length} 字）` : '已退出持续复制';
      return;
    }
    if (msg.text) {
      try { navigator.clipboard.writeText(msg.text); } catch (_) {}
      text.value = msg.text.slice(0, 8000);
      statusEl.textContent = `已复制 ${msg.text.length} 字到剪贴板并填入输入框（持续复制中，点页面左上角「取消」退出）`;
    }
  });

  // ★2026-08-23 P0：接收 background 的自动同步信号（切 tab / 同 tab URL 变化），
  //   自动重扫侧栏以匹配当前活动标签。复用 doRescan（先清空旧素材再扫描，保留正在下载的）。
  // ★2026-08-24 深层修复（真机 bug：顶部"当前页"与卡片不同步）：
  //   旧逻辑只调 doRescan 重扫，但 loadPagePreview（顶部 title/url/thumb 同步）只在初始化时跑一次。
  //   用户从抖音切到花瓣 → 顶部仍显示「www.douyin.com」+ 抖音缩略图，扫描结果却是花瓣素材
  //   （顶部抖音 + 卡片花瓣的诡异错位）。
  //   修复：先调 loadPagePreview 刷新顶部当前页（与实际 tab 同步），再 doRescan 重扫。
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'HMDAO_RESCAN_TAB') {
      // ★2026-09-05 修复（抖音卡顿根因，见 background.js notifySidepanelRescan 注释）：
      //   auto 事件（切 tab / 抖音 SPA pushState）此前走 doRescan —— 它会【清空全部卡片 +
      //   唤醒后端 + runDiagnose 页面诊断注入 + 深度重扫 + 重建上百张卡】，抖音上每 1.5s 来一次，
      //   侧栏被彻底占死。改为轻量同步：只刷新顶部当前页 + 发一次【轻量】扫描请求（不清空、
      //   不诊断、不深解析），素材卡片由 SCAN_RESULT 增量合并。
      //   用户手动点「↻ 重新扫描」仍走 doRescan 全量路径。
      if (msg && msg.auto) {
        // ★2026-09-07 修复（"切源页/前进后退残留旧记录"根因）：
        //   旧 auto 路径只发轻量扫描、从不清空 window.assets → SCAN_RESULT 增量合并把上一页素材滞留，
        //   不同链接记录混在一起。改为：若本次导航到的页面「文档身份」(origin+pathname) 与当前展示页不同
        //   （真正换页 / 前进后退到不同文档 / 切到别的标签页），先清空旧资产再扫描；仅同文档 SPA 切集
        //   (如抖音 ?modal_id 变化) 才走纯增量合并，避免抖音卡顿回归。
        const newUrl = (msg.url || '').toString();
        const oldUrl = (window.__sourcePageUrl || '').toString();
        const docChanged = !!(newUrl && oldUrl && pageDocKey(newUrl) !== pageDocKey(oldUrl));
        if (docChanged) {
          clearAssetsForNewPage();
          try { if (typeof currentSourceUrl !== 'undefined') currentSourceUrl = newUrl; } catch (_) {}
        }
        setTimeout(() => {
          try { loadPagePreview(); } catch (_) {} // 同步顶部当前页（更新 window.__sourcePageUrl）
          try { updateScanStatus(window.__hmdaoAssets || [], 'scanning'); } catch (_) {}
          chrome.runtime.sendMessage({ type: 'HMDAO_SCAN_REQUEST', batchMode: batchCollectEnabled, deep: false, force: true }).catch(() => {});
        }, 0);
        return;
      }
      setTimeout(() => {
        try { loadPagePreview(); } catch (_) {}
        try { doRescan(); } catch (_) {}
      }, 0);
    }
  });

  // 在活动页注入「持续复制模式」覆盖层：
  // 用浏览器原生选区（所见即所得，最准确），强制 user-select:text 并临时屏蔽页面的
  // copy/contextmenu/selectstart 拦截以绕过复制防护；用户每次在页面拖选文字即自动复制，
  // 无需再点「复制」。左上角工具条点「取消」退出。
  function boxSelectPageText() {
    return new Promise((resolve) => {
      let lastText = '';
      const style = document.createElement('style');
      style.textContent = '*{user-select:text !important;-webkit-user-select:text !important;}';
      document.documentElement.appendChild(style);
      const opt = { capture: true };
      const block = (e) => { e.stopPropagation(); };
      document.addEventListener('copy', block, opt);
      document.addEventListener('contextmenu', block, opt);
      document.addEventListener('selectstart', block, opt);

      // 覆盖层不拦截指针事件，让用户在页面上直接拖选文字（原生选区最准确）
      const root = document.createElement('div');
      root.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
      const sel = document.createElement('div');
      sel.style.cssText = 'position:fixed;border:2px dashed #0ea58b;background:rgba(14,165,139,.12);display:none;pointer-events:none;border-radius:4px;';
      // 控制工具条放左上角，操作更顺手
      const bar = document.createElement('div');
      bar.style.cssText = 'position:fixed;left:16px;top:16px;display:flex;gap:8px;align-items:center;background:#0f1620;border:1px solid #2a3a44;border-radius:12px;padding:8px 12px;color:#c9d1d9;font:12px/1.4 system-ui,"PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.5);pointer-events:auto;z-index:2147483647;';
      const info = document.createElement('span');
      info.textContent = '🔴 持续复制中：在页面拖选文字即自动复制';
      const cancel = document.createElement('button');
      cancel.textContent = '✕ 取消';
      cancel.style.cssText = 'border:1px solid #30363d;background:#161b22;color:#c9d1d9;border-radius:8px;padding:6px 11px;cursor:pointer;font-size:12px;';
      bar.append(info, cancel);
      root.append(sel, bar);
      document.documentElement.appendChild(root);

      function showSelBox() {
        const s = window.getSelection();
        if (!s || s.rangeCount === 0 || s.isCollapsed) { sel.style.display = 'none'; return; }
        const r = s.getRangeAt(0).getBoundingClientRect();
        if (!r || (r.width === 0 && r.height === 0)) { sel.style.display = 'none'; return; }
        sel.style.display = 'block';
        sel.style.left = r.left + 'px'; sel.style.top = r.top + 'px';
        sel.style.width = r.width + 'px'; sel.style.height = r.height + 'px';
      }
      function onSel() {
        const s = window.getSelection();
        if (!s || s.isCollapsed) { showSelBox(); return; }
        const t = (s.toString() || '').replace(/\s+/g, ' ').trim();
        showSelBox();
        if (!t || t === lastText) return;
        lastText = t;
        // 页面上下文（用户拖选即用户手势）直接写剪贴板，最可靠
        try { navigator.clipboard.writeText(t).catch(() => {}); } catch (_) {}
        chrome.runtime.sendMessage({ __hmdaCopyStream: true, text: t });
      }
      document.addEventListener('selectionchange', onSel);
      document.addEventListener('mouseup', onSel);
      document.addEventListener('pointerup', onSel);

      function cleanup() {
        document.removeEventListener('copy', block, opt);
        document.removeEventListener('contextmenu', block, opt);
        document.removeEventListener('selectstart', block, opt);
        document.removeEventListener('selectionchange', onSel);
        document.removeEventListener('mouseup', onSel);
        document.removeEventListener('pointerup', onSel);
        if (style.parentNode) style.parentNode.removeChild(style);
        if (root.parentNode) root.parentNode.removeChild(root);
        chrome.runtime.sendMessage({ __hmdaCopyStream: true, done: true, text: lastText });
      }
      cancel.addEventListener('click', () => { cleanup(); resolve(lastText); });
    });
  }

  // 复制本页文案：点击一次进入「持续复制模式」，在页面拖选即自动复制，直到点「取消」。
  document.getElementById('aiCopyPage').addEventListener('click', async () => {
    try {
      if (copyStreamActive) {
        statusEl.textContent = '已在持续复制模式，点页面左上角「取消」即可退出';
        return;
      }
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs && tabs[0];
      if (!tab || !tab.id) { statusEl.textContent = '未找到活动标签页'; return; }
      copyStreamActive = true;
      statusEl.textContent = '已进入持续复制模式：在页面拖选文字即自动复制，点左上角「取消」退出';
      const res = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: boxSelectPageText,
      });
      const txt = (res && res[0] && res[0].result) || '';
      if (txt) { try { await navigator.clipboard.writeText(txt); } catch (_) {} text.value = txt.slice(0, 8000); }
      statusEl.textContent = txt ? `已复制选中文案（${txt.length} 字）` : '已退出持续复制';
      copyStreamActive = false;
    } catch (err) { statusEl.textContent = '复制失败：' + (err && err.message || err); copyStreamActive = false; }
  });

  // AI 请求：路由到 Ddayup 网页后端（异步回传，不在此 await 结果）
  let aiTimer = null;
  // P2.a：多轮对话历史（仅 chat 模式参与上下文）
  const sidepanelChatHistory = [];
  function aiRequest(mode, label) {
    const payloadText = (text.value || '').trim();
    if (!payloadText) { statusEl.textContent = '请先粘贴/复制文案，或点「复制本页文案」'; return; }
    addMsg('user', (label ? label + '：' : '') + payloadText.slice(0, 120) + (payloadText.length > 120 ? '…' : ''));
    text.value = '';
    statusEl.textContent = '正在请求 Ddayup 智能机器人…';
    if (aiTimer) clearTimeout(aiTimer);
    aiTimer = setTimeout(() => {
      statusEl.textContent = '⏱ 请求超时，请确认 127.0.0.1:3000 已打开并在线';
    }, 25000);
    // P2.a：chat 模式携带多轮历史，让机器人记住上文
    if (mode === 'chat') sidepanelChatHistory.push({ role: 'user', content: payloadText.slice(0, 4000) });
    if (sidepanelChatHistory.length > 12) sidepanelChatHistory.splice(0, sidepanelChatHistory.length - 12);
    chrome.runtime.sendMessage({
      type: 'HMDAO_AI_CHAT',
      payload: { text: payloadText, mode, history: sidepanelChatHistory.slice(0, -1) },
    }).catch((e) => {
      statusEl.textContent = '发送失败：' + (e && e.message || e);
    });
  }
  document.getElementById('aiSummarize').addEventListener('click', () => aiRequest('summarize', '总结'));
  document.getElementById('aiTranslate').addEventListener('click', () => aiRequest('translate', '翻译'));
  document.getElementById('aiReverse').addEventListener('click', () => aiRequest('reverse-prompt', '反推提示词'));

  // 「分析本网页」：拉取活动页正文 → 填入输入框 → 直接走总结归纳
  document.getElementById('aiAnalyzePage').addEventListener('click', async () => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs && tabs[0];
      if (!tab || !tab.id) { statusEl.textContent = '未找到活动标签页'; return; }
      const res = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => (document.body && document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 8000),
      });
      const pageText = (res && res[0] && res[0].result) || '';
      if (!pageText) { statusEl.textContent = '未能读取页面正文（可能页面无正文内容）'; return; }
      text.value = `请分析并总结归纳本网页的主要内容、结构与重点。\n\n—— 网页内容 ——\n${pageText}`;
      aiRequest('summarize', '分析本网页');
    } catch (err) { statusEl.textContent = '分析网页失败：' + (err && err.message || err); }
  });

  // 「上传图片/视频」：落地画布素材库 + 触发画布 SmartAgent 媒体工作流
  const aiFile = document.getElementById('aiFile');
  let pendingDeepAnalyze = false; // 下一次文件选择是否为「深度分析」模式
  document.getElementById('aiUpload').addEventListener('click', () => { if (aiFile) aiFile.click(); });
  document.getElementById('aiDeep').addEventListener('click', () => { pendingDeepAnalyze = true; if (aiFile) aiFile.click(); });
  if (aiFile) aiFile.addEventListener('change', () => {
    const f = aiFile.files && aiFile.files[0];
    if (!f) return;
    const deep = pendingDeepAnalyze; pendingDeepAnalyze = false;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      addMsg('user', (deep ? '🧠 深度分析：' : '📎 上传：') + f.name);
      statusEl.textContent = deep ? '正在深度分析并上传到画布智能体…' : '正在上传到画布智能体…';
      chrome.runtime.sendMessage({
        type: 'HMDAO_AGENT_UPLOAD',
        payload: { fileName: f.name, mime: f.type, data: dataUrl, userText: text.value.trim(), deepAnalyze: deep },
      }).catch((e) => { statusEl.textContent = '上传失败：' + (e && e.message || e); });
      text.value = '';
    };
    reader.readAsDataURL(f);
    aiFile.value = '';
  });

  // 自由对话：Enter 发送、Shift+Enter 换行（侧栏原本没有 chat 发送入口）
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); aiRequest('chat', ''); } });

  // 接收 Web App 回传的 AI 结果
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'HMDAO_AI_CHAT_REPLY') {
      if (aiTimer) { clearTimeout(aiTimer); aiTimer = null; }
      if (msg.ok) {
        // P2.a：思考过程可见化 + 回复写入多轮历史
        if (msg.thinking) addMsg('bot', '💭 ' + msg.thinking);
        addMsg('bot', msg.text || '(空响应)');
        sidepanelChatHistory.push({ role: 'assistant', content: String(msg.text || '').slice(0, 4000) });
        if (sidepanelChatHistory.length > 12) sidepanelChatHistory.splice(0, sidepanelChatHistory.length - 12);
      } else addMsg('bot', '⚠️ ' + (msg.error || '请求失败（请确认已打开 Ddayup 网页 127.0.0.1:3000）'));
      statusEl.textContent = '';
    }
  });

  // 首次启动引导：若未配置云端地址（云端部署给用户用），低调提示去扩展选项页配置。
  maybePromptCloudConfig();
})();

// 首次启动引导：检测是否已配置云端 API 地址，未配置且疑似云端分发场景则提示。
async function maybePromptCloudConfig() {
  try {
    const res = await chrome.storage.local.get('ddayupApiBase');
    const configured = res && res.ddayupApiBase && /^https?:\/\//.test(res.ddayupApiBase);
    if (configured) return; // 已配置，不打扰
    // ★2026-08-30 修复（误解根因）：该提示此前无条件显示「未配置云端地址」，让用户误以为
    //   「必须配置云端才能下载」。实际本机后端可达时【完全不需要配置】——B站/抖音等直链下载、
    //   前端 WBI 分辨率枚举都不依赖后端。仅当本机后端也不可达、且用户可能需要 yt-dlp
    //   （优酷/腾讯/爱奇艺等）时才提示。
    const n = document.getElementById('cloudConfigHint');
    const base = await getCloudApiBase().catch(() => 'http://127.0.0.1:3000');
    let reachable = false;
    try {
      const r = await fetch(base + '/api/health', {
        credentials: 'omit',
        signal: AbortSignal.timeout(2000),
      });
      reachable = !!r.ok;
    } catch (_) {}
    if (reachable) {
      // 本机后端可达 → 无需配置，隐藏提示（避免误导）
      panelLog('cloud-config', { status: 'local-ok', hint: '本机后端已达，无需配置云端地址。' });
      if (n) n.style.display = 'none';
      return;
    }
    // 本机后端不可达：提示（措辞改为"可选"，并说明哪些场景才需要）
    panelLog('cloud-config', { status: 'unconfigured', hint: '未配置云端地址且本机后端不可达。B站/抖音直链下载无需后端；优酷/腾讯等需 yt-dlp 时才要后端。' });
    if (n) {
      n.style.display = '';
      n.textContent = 'ℹ 当前连本机 127.0.0.1:3000（未启动，可选）。B站/抖音等直链下载【不需要后端】；仅优酷/腾讯等需 yt-dlp 解析时才要启动后端或填云端地址。';
    }
  } catch (_) {}
}

// ===== 账号中心：我的设备 / 订单 / 忘记密码（与后端 /api/extension/* 配合）=====
(function initAccountPanel() {
  function webBase() {
    try { return (window.DdayupConfig && window.DdayupConfig.getApiBaseSync && window.DdayupConfig.getApiBaseSync()) || 'https://mingmingchuangyi.cn'; }
    catch (_) { return 'https://mingmingchuangyi.cn'; }
  }
  function $(id) { return document.getElementById(id); }
  const modeText = { paid: '已授权', trial: '试用中', expired: '已过期', none: '未授权' };
  const modeClass = { paid: 'paid', trial: 'trial', expired: 'expired', none: '' };

  async function refreshAccount() {
    const L = window.HMDaoLicense;
    const emailEl = $('accEmail'), devEl = $('accDevices'), maxEl = $('accMax'), stEl = $('accStatus'), ordEl = $('accOrdersList');
    const maxWrapEl = $('accMaxWrap');
    if (!L) return;
    let prof;
    try {
      prof = await L.fetchProfile();
    } catch (_) {
      if (emailEl) emailEl.textContent = '网络异常，请检查后端是否可达';
      if (devEl) devEl.innerHTML = '';
      if (ordEl) ordEl.innerHTML = '';
      return;
    }
    if (!prof || prof.success === false) {
      const httpStatus0 = prof && prof.status;
      const code0 = (prof && prof.error && prof.error.code) || '';
      // ★2026-09-14 新增：令牌缺失/失效但本机记住过密码 → 静默自动重登一次再重试（_retried 防重入）。
      if (!refreshAccount._retried && L.autoLoginIfRemembered
        && (httpStatus0 === 401 || code0 === 'NO_TOKEN' || code0 === 'BAD_TOKEN')) {
        refreshAccount._retried = true;
        try {
          const relogin = await L.autoLoginIfRemembered({ skipTokenCheck: true });
          if (relogin && relogin.success) { const r = await refreshAccount(); refreshAccount._retried = false; return r; }
          // ★设备冲突 UX：账号已在其他设备登录 → 不静默踢设备，改为在面板给出「踢出旧设备并登录」入口
          if (relogin && relogin.error && relogin.error.code === 'NEW_DEVICE_CONFLICT') refreshAccount._deviceConflict = true;
        } catch (_) { /* ignore */ }
        refreshAccount._retried = false;
      }
      // ★2026-09-14 自愈（令牌失效 + 本机无凭据）：请仍登录的官网重新签发绑定码，自动恢复登录态。
      //   这是「官网登录过 → 侧栏免登录」的最后一道保险，覆盖服务端重启导致令牌失效的场景。
      if (!refreshAccount._healed && (httpStatus0 === 401 || code0 === 'NO_TOKEN' || code0 === 'BAD_TOKEN')) {
        refreshAccount._healed = true;
        try {
          const r = await chrome.runtime.sendMessage({ type: 'HMDAO_REQUEST_SITE_LOGIN_SYNC' });
          if (r && r.ok) {
            await new Promise((res) => setTimeout(res, 2500)); // 等官网换码 + 扩展绑定完成
            const rr = await refreshAccount();
            refreshAccount._healed = false;
            return rr;
          }
        } catch (_) { /* 扩展未就绪：忽略 */ }
        refreshAccount._healed = false;
      }
      // ★分级提示（2026-09-14）：旧实现把所有失败一律写成「未登录或令牌已失效」，
      //   导致「线上后端未部署该接口（404）」也被误报成令牌问题，排查方向完全跑偏。
      //   authed() 已把 HTTP 状态码放进 status 字段，这里据此区分。
      const httpStatus = prof && prof.status;
      const code = (prof && prof.error && prof.error.code) || '';
      let msg;
      if (httpStatus === 404 || httpStatus === 501) {
        msg = '后端缺少该接口（线上服务未更新），请重新部署后重试';
      } else if (httpStatus === 401 && code === 'BAD_TOKEN') {
        msg = '登录已失效，请重新登录（点下方「去官网登录 / 注册」）';
      } else if (httpStatus === 401 || code === 'NO_TOKEN') {
        msg = '未登录：点下方「去官网登录 / 注册」完成登录，或在扩展付费墙内登录';
      } else if (httpStatus === 403) {
        msg = '无权访问（' + (code || 'FORBIDDEN') + '）';
      } else if (!httpStatus) {
        msg = '网络异常，请检查后端是否可达';
      } else {
        msg = '加载失败（HTTP ' + httpStatus + (code ? ' · ' + code : '') + '）';
      }
      // ★设备冲突：用明确文案 + 显示「踢出旧设备并登录」按钮（用户二次确认后才带 force）
      const deviceConflict = !!refreshAccount._deviceConflict;
      refreshAccount._deviceConflict = false;
      if (deviceConflict) {
        msg = '该账号已在其他设备登录。要继续在本机使用，请点下方「踢出旧设备并登录」'
          + '（旧设备上的已购订阅会保留，不影响其付费权益）。';
      }
      if (emailEl) emailEl.textContent = msg;
      if (devEl) devEl.innerHTML = '';
      if (ordEl) ordEl.innerHTML = '';
      const forceBtn = $('accForceLogin');
      if (forceBtn) forceBtn.style.display = deviceConflict ? '' : 'none';
      if (maxWrapEl) maxWrapEl.style.display = 'none'; // 未登录时不显示「最多 N 台」，避免误导
      // 未登录：显示「去官网登录 / 注册」引导（与「订阅 / 支付」对应两个不同引导页）
      const goWrapOff = $('accGoWebWrap'); if (goWrapOff) goWrapOff.style.display = '';
      // ★修复：未登录时隐藏「退出登录」（此前无条件显示，逻辑不严谨）
      const logoutOff = $('accLogout'); if (logoutOff) logoutOff.style.display = 'none';
      const cntOff = $('accOrdersCount'); if (cntOff) cntOff.textContent = '0';
      return;
    }
    // 已登录：隐藏设备冲突入口
    const forceBtnHide = $('accForceLogin'); if (forceBtnHide) forceBtnHide.style.display = 'none';
    // 已登录：隐藏「去官网登录 / 注册」引导；显示「退出登录」
    const goWrapOn = $('accGoWebWrap'); if (goWrapOn) goWrapOn.style.display = 'none';
    const logoutOn = $('accLogout'); if (logoutOn) logoutOn.style.display = '';
    if (emailEl) emailEl.textContent = prof.email || '(未知邮箱)';
    if (maxEl) maxEl.textContent = String(prof.maxDevices || 3);
    if (maxWrapEl) maxWrapEl.style.display = ''; // 已登录才展示设备上限文案
    const devices = prof.devices || [];
    devEl.innerHTML = '';
    if (!devices.length) { devEl.innerHTML = '<div style="color:#8b949e;font-size:12px">暂无绑定设备</div>'; }
    else {
      for (const d of devices) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid #30363d;border-radius:8px;background:#0d1117;';
        const info = document.createElement('div');
        info.style.cssText = 'flex:1;min-width:0';
        info.innerHTML = `<div style="font-size:13px;color:#c9d1d9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${d.deviceId}${d.isCurrent ? '（当前设备）' : ''}</div>`
          + `<div style="font-size:11px;color:#8b949e">${modeText[d.mode] || d.mode}${d.plan ? ' · ' + d.plan : ''}</div>`;
        row.appendChild(info);
        if (!d.isCurrent) {
          const btn = document.createElement('button');
          btn.textContent = '解绑 / 踢下线';
          btn.style.cssText = 'border:1px solid #7f1d1d;background:transparent;color:#fca5a5;padding:5px 10px;border-radius:7px;cursor:pointer;font-size:12px;white-space:nowrap';
          btn.addEventListener('click', async () => {
            btn.disabled = true; btn.textContent = '解绑中…';
            const r = await L.unbindDevice(d.deviceId);
            if (r && r.success) { if (stEl) { stEl.textContent = '已解绑 ' + d.deviceId; } refreshAccount(); }
            else { btn.disabled = false; btn.textContent = '解绑 / 踢下线'; if (stEl) stEl.textContent = '解绑失败：' + ((r && r.error && r.error.message) || '未知错误'); }
          });
          row.appendChild(btn);
        }
        devEl.appendChild(row);
      }
    }
    // 订单列表（内联查询，token 鉴权）
    if (ordEl) {
      ordEl.innerHTML = '';
      try {
        const ord = await L.fetchOrders();
        const list = (ord && ord.orders) || [];
        // 折叠摘要显示订单条数，便于用户在收起状态下一眼看到是否有订单
        const cntEl = $('accOrdersCount'); if (cntEl) cntEl.textContent = String(list.length);
        if (!list.length) { ordEl.innerHTML = '<div style="color:#8b949e;font-size:12px">暂无订单</div>'; }
        else {
          for (const o of list) {
            const card = document.createElement('div');
            card.style.cssText = 'padding:8px 10px;border:1px solid #30363d;border-radius:8px;background:#0d1117;font-size:12px;color:#c9d1d9';
            const statusText = o.status === 'paid' ? '已支付' : (o.status === 'pending' ? '待支付' : (o.status || '未知'));
            const period = o.periodEnd ? new Date(o.periodEnd).toLocaleDateString() : '—';
            card.innerHTML = `<div style="display:flex;justify-content:space-between"><span>${o.plan || '—'}</span><span style="color:${o.status === 'paid' ? '#3fb950' : '#d29922'}">${statusText}</span></div>`
              + `<div style="color:#8b949e;font-size:11px">${o.provider || ''} · 到期 ${period}</div>`;
            ordEl.appendChild(card);
          }
        }
      } catch (_) {
        ordEl.innerHTML = '<div style="color:#8b949e;font-size:12px">订单加载失败</div>';
      }
    }
  }

  async function openAccount() {
    const o = $('accountOverlay'); if (o) o.style.display = 'flex';
    // 打开账号面板：若本机记住过密码且当前无令牌，先静默自动登录再拉取资料（免受 SW 重启影响）
    try {
      const L = window.HMDaoLicense;
      if (L && L.autoLoginIfRemembered) {
        const token = await L.getToken();
        if (!token) await L.autoLoginIfRemembered();
      }
    } catch (_) { /* ignore */ }
    refreshAccount();
  }

  // 官网「同步登录到扩展」成功后，background 广播 HMDAO_ACCOUNT_SYNCED：
  // 侧栏据此立即刷新账号面板，无需用户手动重开「我的账号」。
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'HMDAO_ACCOUNT_SYNCED') {
        try { refreshAccount(); } catch (_) { /* ignore */ }
        // 官网登录态同步到扩展后，一并刷新授权状态（付费用户同步后应立即变为已授权）
        try {
          const L = window.HMDaoLicense;
          if (L && typeof L.refreshLicenseUI === 'function') L.refreshLicenseUI();
        } catch (_) { /* ignore */ }
      }
    });
  }

  function bind() {
    // ★Bug 反馈入口：点击弹出联系二维码（与隐私政策的联系方式保持一致）
    const fbBtn = $('feedbackBtn'), fbOv = $('feedbackOverlay');
    if (fbBtn && fbOv) {
      fbBtn.addEventListener('click', () => { fbOv.style.display = 'flex'; });
      const fbClose = $('fbClose');
      if (fbClose) fbClose.addEventListener('click', () => { fbOv.style.display = 'none'; });
      fbOv.addEventListener('click', (e) => { if (e.target === fbOv) fbOv.style.display = 'none'; });
    }
    const btn = $('accountBtn'), o = $('accountOverlay');
    if (btn) btn.addEventListener('click', openAccount);
    if (o) {
      const close = $('accClose'); if (close) close.addEventListener('click', () => { o.style.display = 'none'; });
      o.addEventListener('click', (e) => { if (e.target === o) o.style.display = 'none'; });
      const forgot = $('accForgot'); if (forgot) forgot.addEventListener('click', () => { if (window.HMDaoLicense && window.HMDaoLicense.openForgotPassword) window.HMDaoLicense.openForgotPassword(); o.style.display = 'none'; });
      // ★2026-09-14 修复（「我的订单」点了没反应）：官网并没有 /orders 路由，请求会命中 nginx 的
      //   SPA 回退返回 index.html，再由 React Router 的 path="*" 重定向回首页 —— 用户观感就是
      //   「点了没跳转」。改为跳真正的订阅支付页 /pricing.html（复用 goToPricing，携带 deviceId+token，
      //   支付后能正确激活当前设备授权），与付费墙「去官网订阅」走同一条已验证路径。
      //   订单明细本身已在上方面板内联展示（fetchOrders），无需再跳独立订单页。
      // 「账号」引导：未登录时去官网完成登录 / 注册（与「订阅 / 支付」对应两个不同引导页）
      const goWeb = $('accGoWeb');
      if (goWeb) goWeb.addEventListener('click', () => {
        const u = webBase() + '/login';
        if (typeof chrome !== 'undefined' && chrome.tabs) chrome.tabs.create({ url: u }); else window.open(u, '_blank');
      });
      // 「刷新授权」：付款 / 登录后立即重新查询授权状态，无需重开面板
      const accRefresh = $('accRefresh');
      if (accRefresh) accRefresh.addEventListener('click', async () => {
        const L = window.HMDaoLicense;
        const rEl = $('accStatus');
        if (rEl) rEl.textContent = '正在刷新授权…';
        try {
          if (L && typeof L.refreshLicenseUI === 'function') {
            const st = await L.refreshLicenseUI();
            if (rEl) rEl.textContent = st.mode === 'paid' ? '已确认订阅 ✓'
              : (st.mode === 'trial' ? '当前为试用中' : '暂未查询到有效授权');
          } else if (rEl) { rEl.textContent = '刷新失败：授权模块未就绪'; }
        } catch (_) { if (rEl) rEl.textContent = '刷新失败，请稍后重试'; }
        refreshAccount();
      });
      const orders = $('accOrders');
      if (orders) orders.addEventListener('click', () => {
        const L = window.HMDaoLicense;
        if (L && typeof L.goToPricing === 'function') {
          L.goToPricing();
        } else {
          const u = webBase() + '/pricing.html';
          if (chrome && chrome.tabs) chrome.tabs.create({ url: u }); else window.open(u, '_blank');
        }
        o.style.display = 'none';
      });
      // 设备冲突：用户在面板确认后带 force 重登（踢出旧设备）。force 只在此显式路径使用。
      const forceLoginBtn = $('accForceLogin');
      if (forceLoginBtn) forceLoginBtn.addEventListener('click', async () => {
        if (!window.confirm('将踢出该账号在其它设备上的登录（其已购订阅仍会保留在该设备上）。确定继续？')) return;
        const st = $('accStatus');
        if (st) st.textContent = '正在踢出旧设备并登录…';
        forceLoginBtn.disabled = true;
        try {
          const fn = window.HMDaoLicense && window.HMDaoLicense.forceLoginWithRemembered;
          const r = fn ? await fn() : { success: false, error: { message: '本机未记住账号密码，请在授权面板重新登录' } };
          if (st) st.textContent = (r && r.success) ? '已在本机登录（旧设备已下线）' : ((r && r.error && r.error.message) || '登录失败');
        } catch (_) { if (st) st.textContent = '登录失败'; }
        forceLoginBtn.disabled = false;
        refreshAccount();
      });
      // 退出登录：清除令牌与「记住我」保存的凭据，避免下次被自动登录
      const logoutBtn = $('accLogout');
      if (logoutBtn) logoutBtn.addEventListener('click', async () => {
        if (!window.confirm('退出登录将清除本机记住的密码，下次需重新登录。确定退出？')) return;
        try { if (window.HMDaoLicense && window.HMDaoLicense.logout) await window.HMDaoLicense.logout(); } catch (_) { /* ignore */ }
        if (o) o.style.display = 'none';
        refreshAccount();
      });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();

  // 侧栏启动即尝试一次自动重登：勾选「记住我」的用户无需再输入密码；成功后刷新账号面板。
  try {
    if (window.HMDaoLicense && window.HMDaoLicense.autoLoginIfRemembered) {
      window.HMDaoLicense.autoLoginIfRemembered()
        .then((r) => { if (r && r.success && !r.skipped) refreshAccount(); })
        .catch(() => {});
    }
  } catch (_) { /* ignore */ }
})();

// ===== 版本更新提醒（2026-09-15 新增）=====
// 与 background.js 的版本更新模块配套：
//   - 收到 HMDAO_EXT_UPDATE_AVAILABLE → 显示「发现新版本」横幅；点「立即更新」立即应用，
//     不点也会在宽限期后由 background 自动 reload 完成更新（即"自动完成更新"）。
//   - 扩展启动时读 hmdaoJustUpdated 标记 → 一次性展示「已更新到 vX」。
//   - 侧栏打开时主动触发一次检查，让用户尽早感知新版本。
(function () {
  function el() { return document.getElementById('updateNotice'); }
  function hide() { const e = el(); if (e) { e.style.display = 'none'; e.innerHTML = ''; } }

  function showUpdateAvailable(ver) {
    const e = el();
    if (!e) return;
    const v = ver ? (' v' + ver) : '';
    e.style.display = 'block';
    e.innerHTML = '发现新版本' + v + '，即将自动更新'
      + ' <button id="updNow" style="margin-left:8px;cursor:pointer;border:1px solid #30363d;background:#2f81f7;color:#fff;padding:4px 10px;border-radius:6px">立即更新</button>'
      + ' <button id="updLater" style="margin-left:6px;cursor:pointer;border:1px solid #30363d;background:transparent;color:#8b949e;padding:4px 10px;border-radius:6px">稍后</button>';
    e.style.cssText += ';background:rgba(47,129,247,.12);border:1px solid rgba(47,129,247,.4);color:#c9d1d9;padding:8px 10px;border-radius:8px;font-size:12px;margin-bottom:8px';
    const now = document.getElementById('updNow');
    if (now) now.addEventListener('click', () => {
      try { chrome.runtime.sendMessage({ type: 'HMDAO_APPLY_EXT_UPDATE' }).catch(() => {}); } catch (_) {}
    });
    const later = document.getElementById('updLater');
    if (later) later.addEventListener('click', hide);
  }

  function showJustUpdated(ver) {
    const e = el();
    if (!e) return;
    e.style.display = 'block';
    e.style.cssText += ';background:rgba(35,134,54,.12);border:1px solid rgba(35,134,54,.4);color:#c9d1d9;padding:8px 10px;border-radius:8px;font-size:12px;margin-bottom:8px';
    e.innerHTML = '已更新到 v' + ver + '，本次更新已自动生效。';
    setTimeout(hide, 6000);
  }

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.type !== 'HMDAO_EXT_UPDATE_AVAILABLE') return;
      showUpdateAvailable((msg.info && msg.info.version) || '');
    });
  } catch (_) {}

  function boot() {
    try {
      chrome.storage.local.get('hmdaoJustUpdated', (res) => {
        try {
          const v = res && res.hmdaoJustUpdated;
          if (v) {
            showJustUpdated(v);
            chrome.storage.local.remove('hmdaoJustUpdated');
          }
        } catch (_) {}
      });
    } catch (_) {}
    try { chrome.runtime.sendMessage({ type: 'HMDAO_CHECK_EXT_UPDATE' }).catch(() => {}); } catch (_) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
