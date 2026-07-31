// MAIN-world 拦截器（由 manifest 以 "world":"MAIN" 注入模型/资源站）。
// 目标：爱给 / CG模型 等站的 3D 模型、压缩包下载地址是「点下载按钮才由下载 API 动态签名返回」的，
// DOM 静态扫描（scanPage）拿不到，chrome.webRequest 又读不到响应体。
// 故在页面主世界 patch fetch/XHR，解析下载 API 响应里的 fileUrl/cdnLink/url 字段，
// 把签名的 .zip/.glb/.fbx 等真实地址存入 window.__hmdao_model_hits，
// 由 background 扫描/轮询时以 world:'MAIN' 的 executeScript 读取（MAIN 世界不可 sendMessage）。

// ===== 纯函数（浏览器与 Node 测试共用，避免算法漂移） =====
const MODEL_RE = /\.(glb|gltf|obj|fbx|stl|usdz|max|blend|ma|mb|c4d|dae|ply|3ds|skp|wrl|x3d|abc|lwo|smd|vrm|ase|dxf|bvh)([?#]|$)/i;
const ARCH_RE = /\.(zip|rar|7z|tar\.gz|tgz|tar\.bz2|gz|bz2|tar|iso|cab|jar|z|lzh|ace|arj)([?#]|$)/i;
// 下载型 API 特征（含网盘 list/download 接口）。覆盖 pan.baidu.com 的 /api/list、/api/download 等。
const API_RE = /(\/download|\/resource|\/package|\/file|\/geturl|\/downfile|\/down|\/list|\/sharedownload|\/api\/[^\s"']*(file|download|resource|attachment|asset|list|getfile|sharedownload))/i;
const URL_RE = /https?:\/\/[^"')\s\\]+/gi;

// 分类：URL 带模型/归档扩展名直接判；否则用文件名（网盘 dlink 无扩展名、但 server_filename 带扩展名）作线索。
function classify(u, filenameHint) {
  if (typeof u === 'string' && (MODEL_RE.test(u) || ARCH_RE.test(u))) {
    return ARCH_RE.test(u) ? 'archive' : 'model';
  }
  if (filenameHint && (MODEL_RE.test(filenameHint) || ARCH_RE.test(filenameHint))) {
    return ARCH_RE.test(filenameHint) ? 'archive' : 'model';
  }
  return null;
}

// 从响应体文本中萃取出所有「模型/压缩包」直链（含 fileUrl/cdnLink/url/dlink 等 JSON 字段）。
// 返回 [{ url, type }]，type 由 URL 扩展名或「配对的 server_filename」推断（网盘 dlink 无扩展名时靠文件名）。
function extractDownloadUrls(text) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  const seen = new Set();
  const add = (u, t) => {
    if (!u || !t) return;
    if (/[?&](thumb|preview|cover|small|tiny|avatar)/i.test(u)) return;
    const key = u + '|' + t;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ url: u, type: t });
  };
  const isDlUrl = (s) => /^https?:\/\//i.test(s)
    && /(dlink|download_url|downloadurl|downurl|file_url|fileurl|\/download|\/file\/|\/getfile|\/downfile)/i.test(s)
    && !/\.(html?|php|asp)(\?|$)/i.test(s);
  const isFileName = (s) => /\.(zip|rar|7z|tar\.gz|tgz|tar\.bz2|gz|iso|cab|jar|z|lzh|glb|gltf|fbx|obj|blend|max|c4d|dae|ply|3ds|skp|stl|usdz|abc|lwo|smd|vrm)(\?|$)/i.test(s);
  // 1) 直接 URL（带扩展名）。先对正文做轻度转义还原，兼容爱给等把签名 URL
  //    用 Unicode/HTML 实体转义下发的情况（JSON.stringify 后会是双反斜杠 \\u0026）。
  const norm = (text || '')
    .replace(/\\\\u0026/g, '&')
    .replace(/\\u0026/g, '&')
    .replace(/&#47;/g, '/')
    .replace(/\\u002f/gi, '/');
  let m;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(norm))) {
    const u = m[0];
    const t = classify(u);
    if (t) add(u, t);
  }
  // 2) JSON：递归配对网盘「dlink + server_filename」「download_url + filename」等
  try {
    const obj = JSON.parse(text);
    const dlUrls = [];
    const fileNames = [];
    const pairObject = (o) => {
      if (!o || typeof o !== 'object') return;
      let dl = null, fn = null;
      for (const k in o) {
        const v = o[k];
        if (typeof v !== 'string') continue;
        if (/^(dlink|download_url|downloadurl|downurl|file_url|fileurl)$/i.test(k) && /^https?:\/\//i.test(v)) dl = v;
        if (/^(server_filename|filename|file_name|name|fname)$/i.test(k) && isFileName(v)) fn = v;
      }
      if (dl && fn) add(dl, classify(dl, fn));
    };
    const rec = (o, depth) => {
      if (!o || depth > 10) return;
      if (typeof o === 'string') {
        if (isDlUrl(o)) dlUrls.push(o);
        if (isFileName(o)) fileNames.push(o);
        return;
      }
      if (Array.isArray(o)) { o.forEach((v) => rec(v, depth + 1)); return; }
      if (typeof o === 'object') { pairObject(o); for (const k in o) rec(o[k], depth + 1); }
    };
    rec(obj, 0);
    // 启发式：有 dlink 但没和 filename 配对成功时，用任一文件名扩展名推断类型
    if (dlUrls.length && fileNames.length) {
      for (const u of dlUrls) add(u, classify(u, fileNames[0]));
    }
  } catch (_) { /* 非 JSON，已靠正则处理 */ }
  return out;
}

// 仅当「请求 URL 像下载 API」或「响应体含下载地址/网盘字段」时才处理，避免无谓开销/误报
function shouldInspect(url, bodyText) {
  if (API_RE.test(url || '')) return true;
  if (bodyText && /(fileurl|cdnlink|downloadurl|cdn_link|file_url|cos_url|oss_url|server_filename|dlink|isdir|path)/i.test(bodyText)) return true;
  return false;
}

// Node 单测导出（浏览器中 module 不存在，忽略）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { extractDownloadUrls, classify, shouldInspect, MODEL_RE, ARCH_RE, API_RE };
}

// ===== 浏览器主世界注入（patch fetch/XHR） =====
(function () {
  if (typeof window === 'undefined' || window.__hmdao_model_capture) return;
  window.__hmdao_model_capture = true;

  // 站点经私有 API 直接返回 glb/gltf 二进制（URL 无 .glb 扩展名、content-type 也非 model/，
  // 例 tripo3d 等查看器加载模型 → 扫描器与网络层都抓不到）。按「URL 形态」预判是否可能含模型二进制。
  function looksModelUrl(url) {
    return /(^|[?/&.])(glb|gltf|glbz|usdz?|fbx|obj|stl|ply|3ds|max|blend|dae|model|task|asset|resource|mesh|pbr|render|preview)s?([?/&#.]|$)/i.test(url || '');
  }
  // Uint8Array → base64（分块避免 call stack 超限）
  function abToB64(u8) {
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    return btoa(s);
  }

  // ★根因修复：本文件运行在【MAIN 世界】，网页主世界没有扩展消息通道 ——
  // chrome.runtime.sendMessage 要么 undefined 要么因缺 extensionId 直接抛错，被 try/catch 静默吞掉，
  // 导致下载 API 里解析出的 3D/压缩包直链【从未到达后台】（真实 3D 站识别不出的第一根因）。
  // 正确模式（与 inject-main 的 ytPlay 相同）：存 window.__hmdao_model_hits，
  // 由 background 在扫描/轮询时用 chrome.scripting.executeScript({world:'MAIN'}) 读取。
  function report(items) {
    (items || []).forEach((it) => {
      const u = typeof it === 'string' ? it : it.url;
      const t = typeof it === 'string' ? classify(it) : (it.type || (it.url ? classify(it.url) : null));
      if (!u || !t) return;
      const ext = (it && it.ext) || null;
      const inline = (it && it.inline) || null;
      try {
        const store = window.__hmdao_model_hits || (window.__hmdao_model_hits = []);
        // 内联字节按 url+type+已内联 去重，避免重复塞大字符串
        const dup = store.some((x) => x.url === u && x.type === t && (!inline || x.inline));
        if (!dup) {
          store.push({ url: u, type: t, ext, inline, ts: Date.now() });
          if (store.length > 300) store.shift();
        }
      } catch (_) {}
      // best-effort：若未来改为 ISOLATED 注入，此通道自动生效；MAIN 世界会抛错，忽略即可
      // 注意：inline 字节不在此通道传（base64 过大且 MAIN 世界 sendMessage 不可靠），靠 readAllCapturesMAIN 回读
      try {
        chrome.runtime.sendMessage({ type: 'HMDAO_MODEL_API_CAPTURE', url: u, assetType: t })
          .catch(() => {});
      } catch (_) {}
    });
  }

  try {
    const orig = window.fetch;
    window.fetch = function () {
      const url = (typeof arguments[0] === 'string' ? arguments[0] : (arguments[0] && arguments[0].url)) || '';
      let p;
      try {
        p = orig.apply(this, arguments);
      } catch (e) {
        throw e; // 保持原生同步异常语义（如非法 URL）
      }
      // ★通用音频捕获（WebAudio 按钮音效等走 fetch→decodeAudioData，不经 <audio> 元素）：
      // URL 带音频扩展名立即记录；无扩展名接口靠响应 content-type: audio/* 旁路判定。
      try { if (window.__hmdao_remember_audio && /\.(mp3|wav|flac|aac|m4a|ogg|opus|wma)([?#]|$)/i.test(url)) window.__hmdao_remember_audio(url, 'fetch'); } catch (_) {}
      if (p && typeof p.then === 'function' && window.__hmdao_remember_audio) {
        p.then(function (resp) {
          try {
            const ct = (resp && resp.headers && resp.headers.get) ? (resp.headers.get('content-type') || '') : '';
            if (/^audio\//i.test(ct)) window.__hmdao_remember_audio((resp && resp.url) || url, 'fetch-ct');
          } catch (_) {}
        }).catch(function () {}); // 独立旁路，不影响页面 Promise
      }
      // 全站注入时，仅「下载型 API」或「明显是模型的 URL」才读取响应体，避免对视频等大响应体无谓读内存。
      const isApi = API_RE.test(url);
      const isModelReq = isApi || looksModelUrl(url);
      if (p && typeof p.then === 'function' && isModelReq) {
        // 关键修复：把「读取响应体做抓取」作为【独立旁路】，绝不改变返回给页面的原生 Promise。
        p.then(function (resp) {
          try {
            const ct = (resp && resp.headers && resp.headers.get) ? (resp.headers.get('content-type') || '') : '';
            const clHeader = parseInt((resp && resp.headers && resp.headers.get && resp.headers.get('content-length')) || '0', 10);
            // A) 文本：从下载 API 响应体里抽签名直链（既有逻辑）
            if (isApi && clHeader < 50 * 1024 * 1024) {
              const body = resp && resp.clone ? resp.clone() : resp;
              if (body && typeof body.text === 'function') {
                body.text().then(function (text) {
                  try { if (shouldInspect(url, text)) report(extractDownloadUrls(text)); } catch (_) {}
                }).catch(function () {});
              }
            }
            // B) 二进制：站点经私有 API 直接吐 glb/gltf 字节（URL 无 .glb 扩展名、content-type 也非 model/），
            //    例 tripo3d 等查看器加载模型 → 扫描器/网络层都抓不到。按魔数识别并【内联】捕获，
            //    后台读回后侧栏可直接预览/缩略图，绕开跨域与签名失效。
            const looksBinaryModel = /model\/|octet-stream|application\/x-tgif|gltf|mesh/i.test(ct) || looksModelUrl(url) || isApi;
            if (looksBinaryModel && clHeader < 80 * 1024 * 1024) {
              const bin = resp && resp.clone ? resp.clone() : resp;
              if (bin && typeof bin.arrayBuffer === 'function') {
                bin.arrayBuffer().then(function (ab) {
                  try {
                    const u8 = new Uint8Array(ab);
                    // glb 魔数 b'glTF'（偏移 0）
                    if (u8.length > 12 && u8[0] === 0x67 && u8[1] === 0x6c && u8[2] === 0x54 && u8[3] === 0x46) {
                      report([{ url: url, type: 'model', ext: 'glb', inline: abToB64(u8) }]);
                    } else if (u8.length && u8[0] === 0x7b) {
                      // gltf JSON：含 "asset" 字段
                      try { const s = new TextDecoder().decode(u8.subarray(0, 512)); if (/"asset"/.test(s)) report([{ url: url, type: 'model', ext: 'gltf', inline: abToB64(u8) }]); } catch (_) {}
                    }
                  } catch (_) {}
                }).catch(function () {});
              }
            }
          } catch (_) {}
          return resp;
        }).catch(function () {}); // 旁路自捕获，不影响页面
      }
      return p;
    };
  } catch (_) {}

  try {
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function () {
      const a = arguments;
      const u = a[1] || '';
      if (API_RE.test(u)) {
        this.addEventListener('load', function () {
          try { report(extractDownloadUrls(this.responseText || (this.response || ''))); } catch (_) {}
        });
      }
      // ★通用音频捕获：XHR 拉音频（含无扩展名接口，靠响应 content-type 判定）
      try { if (window.__hmdao_remember_audio && /\.(mp3|wav|flac|aac|m4a|ogg|opus|wma)([?#]|$)/i.test(u)) window.__hmdao_remember_audio(u, 'xhr'); } catch (_) {}
      this.addEventListener('load', function () {
        try {
          const ct = (this.getResponseHeader && (this.getResponseHeader('content-type') || '')) || '';
          if (/^audio\//i.test(ct) && window.__hmdao_remember_audio) window.__hmdao_remember_audio(this.responseURL || u, 'xhr-ct');
        } catch (_) {}
      });
      // ★根因修复（2026-08-01）：透传全部参数（含第 3 个 async），避免吞掉 async 导致
      // 页面同步 XHR 被静默改成异步，进而设置 responseType/timeout 抛 DOMException。
      return origOpen.apply(this, a);
    };
  } catch (_) {}

  // 「藏在另外的下载链接里」场景：站点 JS 在调完下载 API 后，把签名地址写进
  // <a href> / <area href> / data-* 属性 / download 属性（DOM 静态扫描抓不到，因为扫描时还没填充）。
  // 用 MutationObserver 监听 DOM 变化，把新出现/被改动的模型或压缩包直链也捕获上报。
  try {
    if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
      const ATTRS = ['href', 'src', 'data-src', 'data-url', 'data-link', 'data-download', 'data-href', 'download'];
      const scanNode = (node) => {
        if (!node || node.nodeType !== 1) return;
        try {
          for (const a of ATTRS) {
            const v = node.getAttribute && node.getAttribute(a);
            if (v && /^https?:/i.test(v) && (MODEL_RE.test(v) || ARCH_RE.test(v))) report([v]);
          }
          if (node.querySelectorAll) {
            node.querySelectorAll('a[href],area[href]').forEach((el) => {
              const h = el.getAttribute('href');
              if (h && /^https?:/i.test(h) && (MODEL_RE.test(h) || ARCH_RE.test(h))) report([h]);
            });
          }
        } catch (_) {}
      };
      const mo = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.addedNodes) { for (const n of m.addedNodes) scanNode(n); }
          if (m.type === 'attributes' && m.target) scanNode(m.target);
        }
      });
      mo.observe(document.documentElement || document, {
        childList: true, subtree: true, attributes: true, attributeFilter: ATTRS,
      });
    }
  } catch (_) {}
})();

// ===== 接口响应体视频直链捕获（全站 MAIN 世界） =====
// ★根因修复（2026-08-01）：原逻辑放在 inject-main.js，但 manifest 仅对 bilibili/youtube 注入
// → 非 YT/B站的站点（LiblibAI / 模型社区 / 云桥网 等）的接口视频直链【从未被捕获】。
// 本文件是全站 MAIN 注入，故把捕获钩子迁移到这里，覆盖所有站点。
// 站点"视频在 XHR/fetch 响应 JSON 里"（如 liblib 搜索接口返回 mp4 直链），
// SPA 异步渲染进 DOM（常仅 hover 时才把 <img> 换成 <video>）→ 静态 DOM 扫描抓不到，
// 必须 patch 网络层，从响应体里扫出 mp4/webm/m3u8 等直链，存进 window.__hmdao_captures.apiVideos，
// 由 background 扫描时经 readAllCapturesMAIN 回读合并（见 scanTab 的 readMainCaptures）。
(function () {
  if (typeof window === 'undefined' || window.__hmdao_api_video_capture) return;
  window.__hmdao_api_video_capture = true;

  const API_VIDEO_RE = /https?:\/\/[^"'\\<>()\s]+\.(mp4|webm|m3u8|mov|m4v|mkv|ogv|flv|f4v)(\?[^\"'\\<>()\s]*)?/gi;

  function scanApiVideoUrls(text) {
    if (!text || typeof text !== 'string') return;
    if (text.length > 2 * 1024 * 1024) return; // 仅扫接口 JSON，跳过超长文本
    if (text.indexOf('{') < 0 && text.indexOf('[') < 0) return; // 非 JSON 不扫
    try {
      const c = (window.__hmdao_captures = window.__hmdao_captures || {});
      const arr = c.apiVideos = c.apiVideos || [];
      let m;
      API_VIDEO_RE.lastIndex = 0;
      while ((m = API_VIDEO_RE.exec(text)) && arr.length < 100) {
        const u = m[0];
        if (arr.indexOf(u) < 0) {
          arr.push(u);
          if (arr.length > 100) arr.shift();
        }
      }
    } catch (_) {}
  }
  window.__hmdaoScanApiVideoUrls = scanApiVideoUrls;

  // 包一层 window.fetch：仅对「JSON 响应」做轻量 text 克隆扫描。
  // 注意：上方 model IIFE 已 patch 过一次 fetch，这里包在它外面再 clone 一次是安全的
  // （clone 不改变页面侧消费的响应，互不影响）。
  const origFetch = window.fetch;
  try {
    window.fetch = function () {
      const url = (typeof arguments[0] === 'string' ? arguments[0] : (arguments[0] && arguments[0].url)) || '';
      const p = origFetch.apply(this, arguments);
      if (p && typeof p.then === 'function') {
        p.then(function (resp) {
          try {
            const ct = (resp && resp.headers && resp.headers.get) ? (resp.headers.get('content-type') || '') : '';
            if (/json/i.test(ct) && resp.clone) {
              resp.clone().text().then(function (t) { try { scanApiVideoUrls(t); } catch (_) {} }).catch(function () {});
            }
          } catch (_) {}
          return resp;
        }).catch(function () {});
      }
      return p;
    };
  } catch (_) {}

  try {
    const oOpen = XMLHttpRequest.prototype.open;
    const oSend = XMLHttpRequest.prototype.send;
    // ★根因修复（2026-08-01）：原 open 重写只传 (m, u) 两个参数，吞掉了第 3 个 async 参数。
    // B站等站点用 open('GET', url, false) 发起【同步】XHR，被静默改成异步后，
    // 页面随后设置 responseType/timeout 会触发「无法设置 responseType」DOMException，干扰网站正常运行。
    // 修复：透传全部参数（method, url, async, user, password），保持页面原生语义不变。
    XMLHttpRequest.prototype.open = function () { return oOpen.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function (b) {
      const self = this;
      self.addEventListener('load', function () {
        try {
          const ct = (self.getResponseHeader && self.getResponseHeader('content-type')) || '';
          if (/json/i.test(ct) && typeof self.responseText === 'string') scanApiVideoUrls(self.responseText);
        } catch (_) {}
      });
      return oSend.call(this, b);
    };
  } catch (_) {}
})();

// ===== 通用音频播放捕获（全站 MAIN 世界） =====
// ★根因（爱给实测）：预览播放器是【游离 new Audio()】——不在 DOM、初始无 src，
// 点击试听时才把限时签名 mp3 注入其中一个播放：
//   1) DOM 扫描 querySelectorAll('audio') 永远看不到（元素没挂进 DOM）；
//   2) 网络层 webRequest 在「SW 冷启动竞态 / memory cache 命中（根本不发事件）」时会漏；
//   3) inject-main 只注入 B站/YouTube，通用站点无播放钩子。
// 修复：钩 Audio 构造 / HTMLMediaElement.play / src setter（+上方 fetch/XHR 的 content-type 旁路），
// 把播放过的音频 URL 存 window.__hmdao_captures.audioPlays（页面全局，抗 SW 重启、抗缓存命中），
// 由 background 扫描时以 world:'MAIN' 的 readAllCapturesMAIN 读回合并。
(function () {
  if (typeof window === 'undefined' || window.__hmdao_audio_capture) return;
  window.__hmdao_audio_capture = true;

  function bag() {
    const c = window.__hmdao_captures = window.__hmdao_captures || {};
    return (c.audioPlays = c.audioPlays || []);
  }
  function remember(url, how) {
    try {
      if (!url || typeof url !== 'string') return;
      if (/^(blob:|data:|mediasource:)/i.test(url)) return; // blob/data 跨上下文不可用
      try { url = new URL(url, location.href).href; } catch (_) { return; }
      if (!/^https?:/i.test(url)) return;
      const list = bag();
      // 按 origin+pathname 去重：爱给等站的签名参数（?e=&token=）会刷新，
      // 同 pathname 视为同一音频，永远保留【最新】签名 URL（旧签名已过期无用）。
      let path = url;
      try { const x = new URL(url); path = x.origin + x.pathname; } catch (_) {}
      const item = { url, path, how, ts: Date.now() };
      const idx = list.findIndex((e) => e.path === path);
      if (idx >= 0) list[idx] = item; else list.push(item);
      if (list.length > 200) list.shift();
    } catch (_) {}
  }
  window.__hmdao_remember_audio = remember; // 供上方 fetch/XHR 钩子复用

  // 1) 游离 new Audio(url)：构造时就带地址（爱给点击试听的典型形态之一）
  try {
    const OA = window.Audio;
    const NA = function (src) {
      const a = (src === undefined) ? new OA() : new OA(src);
      if (src) { try { remember(String(src), 'new-audio'); } catch (_) {} }
      return a;
    };
    NA.prototype = OA.prototype;
    window.Audio = NA;
  } catch (_) {}

  // 2) play() 时的 currentSrc：src 常在 play 前一刻才注入；游离元素不在 DOM 也能抓到。
  //    延迟 400ms 再补记一次（部分播放器 play() 后才完成 src 设置/重定向）。
  try {
    const op = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      const el = this;
      const cap = () => {
        try {
          const s = el.currentSrc || el.src || '';
          if (s) remember(s, (el.tagName === 'AUDIO') ? 'media-play' : 'video-play-src');
        } catch (_) {}
      };
      // 仅音频元素与「音频扩展名的视频元素 src」入音频捕获；视频直链已有网络层/各站解析负责
      if (el.tagName === 'AUDIO') { cap(); setTimeout(cap, 400); }
      return op.apply(this, arguments);
    };
  } catch (_) {}

  // 3) src setter：audio 元素 src 一旦被赋音频直链立即记录（还没 play 也能采到）
  try {
    const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    if (desc && desc.set) {
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        get: desc.get,
        set(v) {
          try {
            if (this.tagName === 'AUDIO' && typeof v === 'string') remember(v, 'src-set');
            else if (typeof v === 'string' && /\.(mp3|wav|flac|aac|m4a|ogg|opus|wma)([?#]|$)/i.test(v)) remember(v, 'src-set');
          } catch (_) {}
          return desc.set.call(this, v);
        },
        configurable: true,
      });
    }
  } catch (_) {}

  // 4) setAttribute('src', ...)：部分播放器不走 property setter
  try {
    const osa = HTMLMediaElement.prototype.setAttribute;
    HTMLMediaElement.prototype.setAttribute = function (name, value) {
      try {
        if (String(name).toLowerCase() === 'src' && this.tagName === 'AUDIO' && typeof value === 'string') remember(value, 'set-attr');
      } catch (_) {}
      return osa.call(this, name, value);
    };
  } catch (_) {}
})();
