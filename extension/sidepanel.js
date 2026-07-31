// Ddayup 素材采集 · 侧栏逻辑（原生 JS）
// ┌──────────────────────────────────────────────────────────────┐
// │ 双击 → 预览原图/视频/音频 · 右键 → 保存/找相似               │
// │ 顶部筛选 → 排除小图标/低分辨率                                │
// │ 类型分模块 · 每类型独立保存路径（中文）· 一键打开官方源        │
// └──────────────────────────────────────────────────────────────┘

// 版本标记：侧栏打开时打印，用于确认扩展是否加载了最新代码
const HMDAO_SIDEPANEL_BUILD = '2026-07-25-audio-fix-v2';
console.log('%c[Ddayup] 侧栏已加载 build ' + HMDAO_SIDEPANEL_BUILD, 'color:#00d4aa;font-weight:bold;font-size:13px');

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

let assets = [];
const selected = new Set();
let currentFilter = 'all';
let statusTimer = null;
const imgDimensions = {}; // url → { w, h }（图片加载后采集的真实尺寸）
const saveHandles = { image: null, video: null, audio: null, model: null, archive: null, netdisk: null };
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
// 当前右键菜单 / 预览窗口所指的资产（基于 global index）
let ctxAssetIdx = -1;

function getAsset(idx) { return assets[idx] || null; }

// ===== 工具函数 =====
function fileName(url) {
  try { const u = new URL(url); const seg = decodeURIComponent(u.pathname.split('/').pop() || ''); return seg.split('?')[0] || 'asset'; } catch (_) { return 'asset'; }
}
function sanitizeName(name) {
  let s = (name || '').replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_').trim();
  return s.replace(/[. ]+$/, '') || 'asset';
}
// extForType 定义见 assetTypes.js（全局单一事实来源）
function deriveFilename(a) {
  const base = sanitizeName(fileName(a.url));
  const dot = base.lastIndexOf('.');
  const hasExt = dot > 0 && /^\.[a-z0-9]{1,6}$/i.test(base.slice(dot));
  return hasExt ? base : base + '.' + extForType(a.type);
}
// typeLabel 定义见 assetTypes.js（全局单一事实来源）
// 列表/预览显示名：MSE 空 URL 的音频用「音频#索引」兜底，避免显示空白
function displayName(a) {
  if (a && a.type === 'netdisk') {
    try { return new URL(a.url).host; } catch (_) { return a.url || '网盘分享'; }
  }
  const n = (a && a.url && fileName(a.url)) || '';
  if (n) return n;
  return (a && a.type ? typeLabel(a.type) : '素材') + (a && a.audioIdx != null ? ('#' + a.audioIdx) : '');
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
function isYtDlpPlatform(a) {
  if (!a) return false;
  const src = window.__sourcePageUrl || '';
  // 优先用资产自身携带的嵌入平台 URL（网页内嵌平台 iframe 的直链是防盗链签名地址，不命中正则）
  const platformUrl = a.playerUrl || a.ytPageUrl || a.biliPageUrl || a.url || '';
  const combined = platformUrl + ' ' + src;
  // generic 平台（未在白名单但被当作视频平台）：直接走 yt-dlp 尝试提取
  if (a.platform === 'generic') return true;
  return /youtube\.com|bilibili\.com|youku\.com|player\.youku|qq\.com|v\.qq\.com|iqiyi\.com|tudou\.com|ixigua\.com|sohu\.com/i.test(combined)
    || !!a.platform && /youku|qq|iqiyi|tudou|xigua|sohu|bilibili|youtube/.test(a.platform);
}

// 媒体防盗链站专用 Referer：抖音/TikTok 系列固定 www.douyin.com；视频号用当前 host
function deriveMediaReferer(url, page) {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    if (h.includes('douyin') || h.includes('bytedance') || h.includes('tiktok')) return 'https://www.douyin.com/';
    if (h.includes('weixin') || h.includes('qq.com')) return 'https://' + h + '/';
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
  const tabs = await chrome.tabs.query({ url: ['http://127.0.0.1:3000/*', 'http://localhost:3000/*'] });
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

// ===== 重新扫描 =====
document.getElementById('rescan').onclick = () => {
  chrome.runtime.sendMessage({ type: 'HMDAO_SCAN_REQUEST' }).catch(() => {});
  setStatus('重新扫描中…');
};

// ===== 尺寸/低质量筛选 =====
document.getElementById('applyFilter').onclick = () => {
  minWidth = parseInt(document.getElementById('minWidth').value, 10) || 0;
  minHeight = parseInt(document.getElementById('minHeight').value, 10) || 0;
  excludeIcons = !!document.getElementById('excludeIcons').checked;
  reapplyFilters();
  setStatus(`筛选：宽≥${minWidth} 高≥${minHeight} 排除小图标=${excludeIcons}`);
};
document.getElementById('clearFilter').onclick = () => {
  document.getElementById('minWidth').value = '';
  document.getElementById('minHeight').value = '';
  document.getElementById('excludeIcons').checked = false;
  minWidth = 0; minHeight = 0; excludeIcons = false;
  reapplyFilters();
  setStatus('筛选已清空');
};

// ===== 页面预览 =====
async function loadPagePreview() {
  setConnection(null, '获取当前页…');
  try {
    const info = await chrome.runtime.sendMessage({ type: 'HMDAO_CAPTURE_PAGE' });
    if (info && info.ok) {
      document.getElementById('previewTitle').textContent = info.title || '(无标题)';
      document.getElementById('previewUrl').textContent = info.url || '';
      if (info.thumb) document.getElementById('previewThumb').src = info.thumb;
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

// ===== 网盘深度解析：打开分享页 + 自动填提取码 + 读文件列表 =====
async function netdiskResolve(a) {
  if (!a || a.type !== 'netdisk') return;
  setStatus('正在打开网盘页并自动填码…');
  const res = await chrome.runtime.sendMessage({ type: 'HMDAO_NETDISK_RESOLVE', url: a.url });
  if (res && res.ok) {
    let msg = '已打开「' + (() => { try { return new URL(a.url).hostname; } catch (_) { return a.url; } })() + '」';
    if (res.names && res.names.length) msg += '，文件：' + res.names.slice(0, 3).join('、') + (res.names.length > 3 ? '…' : '');
    if (res.note) msg += '；' + res.note;
    setStatus(msg);
  } else {
    setStatus('深度解析失败：' + errStr(res && res.error), true);
  }
}

// 「自动点击揭示」：点击页面下载/获取按钮，触发接口注入的动态链接后自动重扫
const revealBtn = document.getElementById('revealBtn');
if (revealBtn) revealBtn.onclick = async () => {
  setStatus('正在自动点击下载/获取按钮…');
  const res = await chrome.runtime.sendMessage({ type: 'HMDAO_CLICK_REVEAL' });
  setStatus(res && res.ok ? ('已点击 ' + (res.clicked || 0) + ' 个按钮，正在重扫…') : ('自动点击失败：' + errStr(res && res.error)), !(res && res.ok));
};

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
    chrome.tabs.create({ url: 'http://127.0.0.1:3000' });
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
  document.getElementById('previewYtIframe').removeAttribute('src');
  // 试听按钮默认隐藏，仅音频资产显示
  document.getElementById('pvPlay').style.display = 'none';
  document.getElementById('pvCopyImage').style.display = 'none'; // 仅图片预览显示「复制图片」
  // 停止播放并彻底释放 WebMediaPlayer（removeAttribute('src') 后必须 load() 才能释放解码器）
  const v = document.getElementById('previewVideo'); v.pause(); v.removeAttribute('src'); try { v.load(); } catch (_) {}
  const au = document.getElementById('previewAudio'); au.pause(); au.removeAttribute('src'); try { au.load(); } catch (_) {}
  stopHoverAudio(); // 打开大窗时停掉悬停试听，避免两个音频叠播
  stopModelSandbox(); // 离开 3D 预览时停掉沙箱后台渲染，释放 GPU

  // 各类型预览子视图（渲染逻辑抽离至 preview-render.js，按 type 分发）
  switch (a.type) {
    case 'image': renderPreviewImage(a); break;
    case 'video': renderPreviewVideo(a); break;
    case 'audio': renderPreviewAudio(a); break;
    case 'model': renderPreviewModel(a); break;
    case 'archive': renderPreviewArchive(a); break;
    default: renderPreviewNetdisk(a); break;
  }

  document.getElementById('previewInfo').innerHTML =
    `<span>${typeLabel(a.type)} · ${displayName(a)}</span><br>` +
    `<a href="${escapeAttr(a.url)}" target="_blank" title="${escapeAttr(a.url)}">${truncate(a.url, 60)}</a>` +
    (imgDimensions[a.url] ? `<br><span>${imgDimensions[a.url].w}×${imgDimensions[a.url].h} px</span>` : '');

  // 预览窗按钮指向当前资产
  window.__previewAsset = a;
}
// escapeAttr / truncate 定义见 ui-utils.js（全局单一来源）

// ===== 视频备选分辨率：显示当前页面同一视频的其他 source URL =====
function buildVideoAltResolutions(current) {
  const altDiv = document.getElementById('pvAltResolutions');
  if (!altDiv) return;
  // 找同一页面中的其他视频 URL（不同链接），并尝试从文件名中提取分辨率标记
  const related = assets.filter(av =>
    av.type === 'video' && av.url !== current.url &&
    (av.source === 'video>source' || current.source === 'video>source' || fileName(av.url) === fileName(current.url))
  );
  if (!related.length) { altDiv.style.display = 'none'; return; }

  const buttons = related.map(r => {
    const name = fileName(r.url);
    const resTag = extractResolutionHint(r.url);
    return `<button onclick="switchPreviewVideo('${escapeAttr(r.url)}','${escapeAttr(name)}','${escapeAttr(r.source || '')}')">${resTag ? resTag + ' · ' : ''}${name}</button>`;
  }).join('');

  altDiv.innerHTML = `<span style="color:#d29922">⬇ 备选分辨率（点击切换源，再点「下载」）：</span><br>${buttons}`;
  altDiv.style.display = '';
}

// 从 URL 中猜分辨率（如 _1080p, -720p, 1920x1080 等）
function extractResolutionHint(url) {
  const m = url.match(/[_-](\d{3,4}p)\b/i) || url.match(/(\d{3,4}x\d{3,4})/i) || url.match(/\b(hd|fhd|uhd|4k|2k|8k)\b/i);
  return m ? m[1].toUpperCase() : null;
}

// 收集同一视频的其它分辨率直链（用于下载面板的分辨率选项）。
// 返回 [{ label, downloadUrl }]，不含 current 自身。无相关源时返回 []。
function collectAltResolutionUrls(current) {
  if (!current || !current.url || !Array.isArray(assets)) return [];
  // 用「去分辨率标记后的基础名」匹配，使 house_1080p.mp4 / house_720p.mp4 视为同一视频
  const base = stripResolutionTag(fileName(current.url));
  const related = assets.filter(av =>
    av.type === 'video' && av.url !== current.url && stripResolutionTag(fileName(av.url)) === base
  );
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
    `<span>视频 · ${name}</span><br><a href="${escapeAttr(url)}" target="_blank" title="${escapeAttr(url)}">${truncate(url, 60)}</a>`;
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

  const opts = videoFormats.map(f => {
    const sel = f.format_id === window.__ytSelectedFormat ? ' selected' : '';
    const label = f.height + 'p' + (f.fps ? ` ${f.fps}fps` : '') + (f.has_audio ? ' 🔊' : ' 🔇仅视频');
    return `<option value="${f.format_id}"${sel}>${label}${f.filesize_mb ? ' (' + f.filesize_mb + 'MB)' : ''}</option>`;
  }).join('');

  altDiv.innerHTML = `<span style="color:#d29922;font-size:12px">🎬 分辨率（点击切换后重新预览/下载）</span><br>
    <select id="ytFmtSelect" style="margin:4px 0;padding:4px;border-radius:6px;background:#1a1a2e;color:#ccc;border:1px solid #444;font-size:12px;max-width:100%"
      onchange="var s=document.getElementById('ytFmtSelect');window.__ytSelectedFormat=s.value;">
      ${opts}
    </select>`;
  altDiv.style.display = '';
  window.__ytFormats = formats;
}

// 抖音分辨率选择器（从 RENDER_DATA 提取的多质量/编码版本）
function buildDyFormatSelector(formats) {
  const altDiv = document.getElementById('pvAltResolutions');
  if (!altDiv || !formats || !formats.length) return;
  const defaultFmt = formats.find(f => f.is_default) || formats[0];
  window.__dySelectedFormat = defaultFmt ? defaultFmt.url : '';

  const opts = formats.map(f => {
    const sel = f.url === window.__dySelectedFormat ? ' selected' : '';
    return `<option value="${f.url.replace(/"/g,'&quot;')}" data-label="${(f.label||'').replace(/"/g,'&quot;')}"${sel}>${f.label}</option>`;
  }).join('');

  altDiv.innerHTML = `<span style="color:#d29922;font-size:12px">🎬 抖音画质（来自页面数据）</span><br>
    <select id="dyFmtSelect" style="margin:4px 0;padding:4px;border-radius:6px;background:#1a1a2e;color:#ccc;border:1px solid #444;font-size:12px;max-width:100%"
      onchange="var s=document.getElementById('dyFmtSelect');window.__dySelectedFormat=s.value;var v=document.getElementById('previewVideo');if(v){v.src=s.value;v.load();v.play().catch(()=>{});}">
      ${opts}
    </select>`;
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
  window.__dlSelected = null;
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
    if (isEmbedPlatformAsset(a)) {
      if (!window.__ytFormats && !window.__dyFormats) {
        // 触发异步拉取（与预览同逻辑，结果写入 window.__ytFormats/__dyFormats）；
        // 加 4s 超时保护，避免无后端/网络慢时面板长时间 loading。
        try {
          await Promise.race([
            fetchPlatformFormats(a),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
          ]);
        } catch (_) {}
      }
      if (window.__ytFormats && window.__ytFormats.length) {
        options = options.concat(window.__ytFormats.map(f => ({
          label: (f.quality_label || f.format_note || ('format ' + f.format_id)) + (f.ext ? ' · ' + f.ext : ''),
          formatId: f.format_id,
        })));
      }
      if (window.__dyFormats && window.__dyFormats.length) {
        options = options.concat(window.__dyFormats.map(f => ({
          label: f.label || '抖音源',
          downloadUrl: f.url,
        })));
      }
    }

    // 来源2：普通直链 → 同文件名（去分辨率标记）的其它视频源（多分辨率直链收录）
    if (!options.length && a.url && a.url.startsWith('http')) {
      try { options = options.concat(collectAltResolutionUrls(a)); } catch (_) {}
    }

    // 兜底：当前直链作为「原画质」
    if (!options.length) {
      options.push({ label: '原画质（当前直链）', downloadUrl: a.url });
    }
  } catch (e) {
    options = options.length ? options : [{ label: '原画质（当前直链）', downloadUrl: a.url }];
  }

  loading.style.display = 'none';
  list.innerHTML = options.map((o, i) => {
    const data = JSON.stringify({ downloadUrl: o.downloadUrl || '', formatId: o.formatId || '' }).replace(/"/g, '&quot;');
    const sel = i === 0 ? ' checked' : '';
    return `<label style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid #30363d;border-radius:8px;background:#161b22;cursor:pointer;font-size:13px;color:#e6edf3">
      <input type="radio" name="dlRes" value="${i}" data-opt="${data}"${sel}> ${o.label}
    </label>`;
  }).join('');
  window.__dlOptions = options;
  // 默认选中第一项
  const first = list.querySelector('input[name="dlRes"]');
  if (first) { first.checked = true; window.__dlSelected = options[0]; }
  list.querySelectorAll('input[name="dlRes"]').forEach(r => {
    r.addEventListener('change', () => {
      const i = parseInt(r.value, 10);
      window.__dlSelected = window.__dlOptions[i];
    });
  });
}

function confirmDownload() {
  const a = getPreviewAsset();
  const panel = document.getElementById('downloadPanel');
  const sel = window.__dlSelected;
  if (!a) { closeDownloadPanel(); return; }
  if (!sel) { setStatus('请选择分辨率', true); return; }
  if (sel.formatId) {
    // 嵌入平台 → 走 yt-dlp 指定格式
    downloadViaYtDlp(a, window.__sourcePageUrl || '', sel.formatId);
  } else if (sel.downloadUrl) {
    downloadSingle(a, { downloadUrl: sel.downloadUrl });
  } else {
    downloadSingle(a);
  }
  closeDownloadPanel();
}

function closeDownloadPanel() {
  const panel = document.getElementById('downloadPanel');
  if (panel) panel.classList.remove('open');
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
  setPreviewAsset: (a) => { window.__previewAsset = a; },
  setAssets: (arr) => { if (Array.isArray(assets)) { assets.length = 0; assets.push(...arr); } },
};

// ── yt-dlp 依赖检测与提示（与模型下载面板打通）─────────────
// 复用后端 /api/health 的 localPostBackends.ytdlp.detectedPath，无需新增接口。
// 返回三态：'ready'（已就绪）/ 'missing'（Web App 可达但 yt-dlp 未检测）/ 'unreachable'（Web App 未运行）
async function checkYtDlp() {
  try {
    const r = await fetch('http://127.0.0.1:3000/api/health', { credentials: 'omit' });
    if (!r.ok) return 'unreachable';
    const d = await r.json().catch(() => null);
    // 后端路由重构后清单落在 capabilities.localPostBackends（与 ModelDownloadPanel/PostNode 读法一致），
    // 同时兼容历史顶层字段，避免因结构差异永远判定为 unreachable 而不提示安装。
    const lb = d && (d.capabilities?.localPostBackends || d.localPostBackends);
    if (!lb) return 'unreachable'; // 健康接口未返回运行时清单（如 DEV 桩/未知结构），不误报缺失
    const yt = lb.ytdlp;
    // 后端以 detectedPath 非空表示已安装（与 ModelDownloadPanel 的 Boolean(status?.detectedPath) 一致）
    return (yt && yt.detectedPath) ? 'ready' : 'missing';
  } catch (_) {
    return 'unreachable';
  }
}

// 显示「前往模型下载面板安装 yt-dlp」可操作横幅；点击直达 http://127.0.0.1:3000/#models
function ensureYtDlpPrompt() {
  const n = document.getElementById('ytDlpNotice');
  if (!n) return;
  n.style.display = '';
  const btn = n.querySelector('.install-btn');
  if (btn && !btn.__bound) {
    btn.__bound = true;
    btn.addEventListener('click', () => {
      chrome.tabs.create({ url: 'http://127.0.0.1:3000/#models' });
    });
  }
  // 安装完成后自动隐藏：轮询最多 ~30s（避免用户装好后横幅残留）
  if (!n.__watching) {
    n.__watching = true;
    let tries = 0;
    const t = setInterval(() => {
      tries++;
      checkYtDlp().then((st) => {
        if (st === 'ready') { hideYtDlpPrompt(); clearInterval(t); n.__watching = false; }
        else if (tries >= 10) { clearInterval(t); n.__watching = false; }
      });
    }, 3000);
  }
}

function hideYtDlpPrompt() {
  const n = document.getElementById('ytDlpNotice');
  if (n) n.style.display = 'none';
}

// 多平台格式列表拉取（YouTube/B站等，用于分辨率选择）
async function fetchPlatformFormats(a) {
  const sourcePage = window.__sourcePageUrl || '';
  const videoPageUrl = a.ytPageUrl || (a.ytVideoId ? ('https://www.youtube.com/watch?v=' + a.ytVideoId) : sourcePage);
  if (!videoPageUrl) return;
  try {
    const r = await fetch('http://127.0.0.1:3000/api/platform/ytdlp?action=formats&url=' + encodeURIComponent(videoPageUrl), { credentials: 'omit' });
    const d = await r.json().catch(() => null);
    if (d && d.formats && d.formats.length) {
      window.__ytFormats = d.formats;
      buildYoutubeFormatSelector(d.formats);
    }
  } catch (_) {
    // 扩展已装、后端可达但 yt-dlp 未就绪时，主动提示去模型下载面板安装
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
  document.getElementById('previewOverlay').classList.remove('open');
  const v = document.getElementById('previewVideo'); v.pause(); v.removeAttribute('src');
  const a = document.getElementById('previewAudio'); a.pause(); a.removeAttribute('src');
  // 释放 3D 预览的 WebGL 上下文（侧栏 WebGL 上下文数量有限，不释放会累积到无法创建）
  try { window.__hmdaoModel3D && window.__hmdaoModel3D.disposeViewer(); } catch (_) {}
  const mvp = document.getElementById('pvModelViewport'); if (mvp) { mvp.innerHTML = ''; mvp.style.display = 'none'; }
  if (window.__playingPageIdx != null) {
    chrome.runtime.sendMessage({ type: 'HMDAO_STOP_PAGE_AUDIO', audioIdx: window.__playingPageIdx }).catch(() => {});
    window.__playingPageIdx = null;
  }
  if (window.__hlsInstance) { window.__hlsInstance.destroy(); window.__hlsInstance = null; }
  if (window.__mergedDashBlobUrl) { try { URL.revokeObjectURL(window.__mergedDashBlobUrl); } catch (_) {} window.__mergedDashBlobUrl = null; }
  window.__previewAsset = null;
}

// ===== DASH 1080p+ 音视频合并为单文件 MP4（纯 JS：mp4box.js 解封装 + mp4-muxer 封装）=====
function startDashPreview(a, vid, dash) {
  const vUrl = (dash.video && dash.video[0] && dash.video[0].baseUrl) || '';
  const aUrl = (dash.audio && dash.audio[0] && dash.audio[0].baseUrl) || '';
  window.__previewAsset = { ...a, url: vUrl };
  vid.src = vUrl; vid.load(); vid.play().catch(() => {});
  if (!vUrl) { setStatus('⚠ 未解析到 DASH 视频轨', true); return; }
  setStatus('DASH 分离轨：先播视频轨，正在合并音视频为单文件…');
  if (aUrl && typeof mergeDashToMp4 === 'function') {
    mergeDashToMp4(vUrl, aUrl).then((blob) => {
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

// 后台带 Referer 拉取媒体字节 → 本地 blob → <video> 播放（绕过侧栏元素的签名/Referer 限制）
function fallbackCdnFetch(a, vid) {
  const sourcePage = window.__sourcePageUrl || '';
  const referer = deriveMediaReferer(a.url, sourcePage);
  // yt-dlp 多平台统一预览（YouTube / B站等）
  if (isYtDlpPlatform(a) || a.ytVideoId || a.biliVideoId) {
    const videoPageUrl = a.ytPageUrl
      || a.biliPageUrl
      || (a.ytVideoId ? ('https://www.youtube.com/watch?v=' + a.ytVideoId) : '')
      || (a.biliVideoId ? ('https://www.bilibili.com/video/' + a.biliVideoId) : '')
      || sourcePage;
    setStatus('正在通过后端 yt-dlp 获取视频直链…');
    // 同时拉取格式列表（用于分辨率选择）
    const fmtP = fetch('http://127.0.0.1:3000/api/platform/ytdlp?action=formats&url=' + encodeURIComponent(videoPageUrl), { credentials: 'omit' })
      .then(r => r.json()).catch(() => null);
    const urlP = fetch('http://127.0.0.1:3000/api/platform/ytdlp?action=extract&url=' + encodeURIComponent(videoPageUrl), { credentials: 'omit' })
      .then(r => r.json()).catch(() => null);

    Promise.all([urlP, fmtP]).then(([ytData, fmtData]) => {
      if (ytData && ytData.url) {
        // 填充格式选择器
        if (fmtData && fmtData.formats) {
          window.__ytFormats = fmtData.formats;
          buildYoutubeFormatSelector(fmtData.formats);
        }
        setStatus('正在加载视频（' + (ytData.title || '') + '）…');
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
      let cp;
      try { cp = getVideoCodecPrivate(file, id); } catch (_) {}
      const ts = info.timescale || 1;
      for (const s of samples) {
        const chunk = new EncodedVideoChunk({
          type: s.is_sync ? 'key' : 'delta',
          timestamp: Math.round((s.cts / ts) * 1e6),
          duration: Math.max(1, Math.round((s.duration / ts) * 1e6)),
          data: s.data,
        });
        muxer.addVideoChunk(chunk, cp ? { decoderConfig: { codec: info.codec, codecPrivate: cp } } : undefined);
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

// 重发直链取字节（非 YouTube，或 YouTube 无捕获字节时的兜底）
function fallbackCdnRefetch(a, vid, referer) {
  setStatus('正在后台带 Referer 拉取视频字节…');
  fetchMediaViaBackground(a.url, referer).then((res) => {
    if (res && res.ok && res.b64) {
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
    } else {
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
  v.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:6px;background:#000;display:none;z-index:5;pointer-events:none';
  v.addEventListener('error', () => { /* 拉取失败静默：封面图仍在下方 */ });
  hoverVideoEl = v;
  return v;
}

// 嵌入平台（youku/yt/bili/qq/iqiyi 等，含 generic 通用兼容）—— 直链是防盗链签名地址无法预览，需走 yt-dlp 提取
function isEmbedPlatformAsset(a) {
  if (!a) return false;
  if (a.platform === 'generic') return true;
  return !!(a.playerUrl || a.ytPageUrl || a.biliPageUrl || a.ytVideoId || a.biliVideoId ||
    (a.platform && /youku|tudou|qq|iqiyi|xigua|sohu|bilibili|youtube/.test(a.platform)));
}

async function hoverVideoFrame(a, card) {
  if (!a || a.type !== 'video') return;
  const tag = card.querySelector('.tag');
  if (!tag) return;
  const v = ensureHoverVideo();
  if (v.parentElement !== tag) {
    // 移动到当前卡片（保证同一时刻只有一个卡片在抽帧）
    if (v.parentElement) v.parentElement.removeChild(v);
    tag.appendChild(v);
  }
  v.style.display = 'block';

  // 嵌入式平台资产（youku/yt/bili/qq/iqiyi 等）：直链是防盗链签名地址无法预览，
  // 必须经 yt-dlp 提取出可直连的直链，再后台带 Referer 拉字节做首帧。
  if (isEmbedPlatformAsset(a)) {
    try {
      const videoPageUrl = a.playerUrl || a.ytPageUrl || a.biliPageUrl
        || (a.ytVideoId ? ('https://www.youtube.com/watch?v=' + a.ytVideoId) : '')
        || (a.biliVideoId ? ('https://www.bilibili.com/video/' + a.biliVideoId) : '')
        || a.url;
      const extractUrl = 'http://127.0.0.1:3000/api/platform/ytdlp?action=extract&url=' + encodeURIComponent(videoPageUrl);
      const ytRes = await fetch(extractUrl, { credentials: 'omit' });
      const ytData = await ytRes.json().catch(() => null);
      if (ytData && ytData.url) {
        const referer = deriveMediaReferer(ytData.url, videoPageUrl || location.href);
        const res = await fetchMediaViaBackground(ytData.url, referer);
        paintHoverFrame(v, res);
        return;
      }
      // yt-dlp 不可用/无直链 → 降级为封面图（不影响浏览）
    } catch (_) {}
    return;
  }

  // 直链视频（api-video / 通用 mp4 / 防盗链 CDN）：后台带 Referer 拉取字节 → blob → 暂停首帧
  const referer = deriveMediaReferer(a.url, window.__sourcePageUrl || '');
  fetchMediaViaBackground(a.url, referer).then((res) => {
    paintHoverFrame(v, res);
  }).catch(() => {
    // 后台拉取失败（大文件超时/防盗链）→ 降级：直接用原直链作为 video.src，
    // 交给浏览器自身解码首帧（对允许跨域的 CDN 有效），避免悬停完全无首帧。
    try { if (v.src !== a.url) { v.crossOrigin = null; v.src = a.url; } } catch (_) {}
  });
}

// 把后台返回的字节画成悬停首帧（失败则保持封面图，不报错）
function paintHoverFrame(v, res) {
  if (!res || !res.ok || !res.b64) return;
  try {
    const blob = new Blob([b64ToBytes(res.b64)], { type: res.mime || 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const onloaded = () => {
      try { v.currentTime = Math.min(0.1, (v.duration || 0.1) * 0.05); } catch (_) {}
      v.pause();
      if (v.dataset.blobUrl && v.dataset.blobUrl.startsWith('blob:')) {
        try { URL.revokeObjectURL(v.dataset.blobUrl); } catch (_) {}
      }
      v.dataset.blobUrl = url;
    };
    v.addEventListener('loadeddata', onloaded, { once: true });
    v.src = url; v.load();
  } catch (_) {}
}

function stopHoverVideoFrame(card) {
  // 仅当单例 video 确实在该卡片时才移除（避免误清其它卡片的悬停）
  if (hoverVideoEl && hoverVideoEl.parentElement === card) {
    hoverVideoEl.style.display = 'none';
    if (hoverVideoEl.parentElement) hoverVideoEl.parentElement.removeChild(hoverVideoEl);
  }
}

// 后台带 Referer 拉取媒体字节 → blob → 浏览器下载（用于抖音/TikTok/视频号等 chrome.downloads 直连会 403 的站点）
async function downloadVideoViaBackground(a) {
  const referer = deriveMediaReferer(a.url, window.__sourcePageUrl || '');
  // YouTube：优先用播放器已下载的真实字节（避免重发直链拿到假视频文件）
  if (isYoutubeMedia(a.url)) {
    setStatus('正在读取播放器已缓存的真实视频字节用于下载…');
    const yt = await getYtBytesViaBackground(a.url);
    if (yt && yt.ok && yt.b64 && yt.size > 1024) {
      // YouTube UMP 底层是 ISOBMFF 容器——强制 video/mp4 MIME 确保下载文件可被播放器识别
      const blob = new Blob([b64ToBytes(yt.b64)], { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);
      cacheDragBlob(a, blob, 'video/mp4');
      downloadBlobUrl(url, 'Ddayup/videos/' + deriveFilename(a));
      setTimeout(() => URL.revokeObjectURL(url), 120000);
      setStatus('✅ 已用播放器真实字节下载（itag ' + (yt.itag || '?') + '，' + Math.round(yt.size / 1024) + 'KB）');
      return;
    }
    // 无捕获字节 → 回退重发直链（下方逻辑）
  }
  setStatus('正在后台拉取视频字节用于下载…');
  const res = await fetchMediaViaBackground(a.url, referer);
  if (res && res.ok && res.b64) {
    const blob = new Blob([b64ToBytes(res.b64)], { type: res.mime || 'video/mp4' });
    const url = URL.createObjectURL(blob);
    cacheDragBlob(a, blob, res.mime || 'video/mp4'); // 缓存真实字节 → 可拖到桌面/文件夹
    downloadBlobUrl(url, 'Ddayup/videos/' + deriveFilename(a));
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    setStatus('✅ 已通过后台拉取下载（绕过防盗链）');
  } else {
    setStatus('⚠ 后台下载失败（签名可能已过期或防盗链）：' + errStr(res && (res.error || res.status)), true);
    // ★用户需求：视频下载失败时提醒去模型下载面板装 yt-dlp（仅当确实未装）
    checkYtDlp().then((st) => { if (st === 'missing') ensureYtDlpPrompt(); });
  }
}

// 注：dashDemux / getVideoCodecPrivate / getAacCodecPrivate / muxerVideoCodec / mergeDashToMp4
// 已抽离至 media-transcode.js（纯算法簇，与 UI 解耦），由 sidepanel.html 在 vendor 库之后、
// 本文件之前加载，运行时经 typeof mergeDashToMp4 === 'function' 延迟调用。

document.getElementById('closePreview').onclick = closePreview;
document.getElementById('previewOverlay').onclick = (e) => {
  if (e.target === e.currentTarget) closePreview();
};

// 预览窗底部按钮
// getPreviewAsset 定义见 ui-utils.js（全局单一来源）

document.getElementById('pvDownload').onclick = () => { const a = getPreviewAsset(); if (a) openDownloadPanel(a); };
document.getElementById('pvCopyImage').onclick = async () => { const a = getPreviewAsset(); if (a) await copyImageToClipboard(a); };
document.getElementById('pvPlay').onclick = () => { const a = getPreviewAsset(); if (a && a.type === 'audio') playAudioInPage(a, { visual: true }); };
document.getElementById('pvSaveLocal').onclick = () => { const a = getPreviewAsset(); if (a) saveSingleToLocal(a); };
document.getElementById('pvCopyLink').onclick = () => {
  const a = getPreviewAsset(); if (!a) return;
  navigator.clipboard.writeText(a.url).then(() => setStatus('已复制')).catch(() => setStatus('复制失败', true));
};
document.getElementById('pvOpenTab').onclick = () => {
  const a = getPreviewAsset();
  if (!a) return;
  const openUrl = a.ytVideoId ? ('https://www.youtube.com/watch?v=' + a.ytVideoId) : a.url;
  chrome.tabs.create({ url: openUrl });
};
document.getElementById('pvSimilar').onclick = () => { const a = getPreviewAsset(); if (a) doFindSimilar(a); };
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
        mergeDashToMp4(vUrl, aUrl).then((blob) => {
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
    window.__previewAsset = { ...a, url: r.url };
    const vid = document.getElementById('previewVideo');
    if (a.type === 'video' && vid) {
      vid.src = r.url; vid.load(); vid.play().catch(() => {});
    }
    document.getElementById('previewInfo').innerHTML = `<span>${typeLabel(a.type)} · ${fileName(a.url)}（已刷新）</span><br><a href="${escapeAttr(r.url)}" target="_blank" title="${escapeAttr(r.url)}">${truncate(r.url, 60)}</a>`;
    setStatus('✅ 已刷新 URL，可点「下载」');
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
chrome.runtime.sendMessage({ type: 'HMDAO_SCAN_REQUEST' }).catch(() => {});
loadPagePreview();
// 初始化时检测第三方 Cookie 是否被阻止：被阻止则显示友好横幅，核心功能仍降级可用。
checkThirdPartyCookies();

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

  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation(); chat.style.display = 'none';
    chat.classList.remove('full'); if (fullBtn) fullBtn.textContent = '⛶';
  });

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
})();
