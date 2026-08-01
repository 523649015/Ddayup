// MAIN-world 拦截器（由 manifest 以 "world":"MAIN" 注入，浏览器直接执行，不受页面 CSP 限制）
// 早期(document_start)捕获 B站 / YouTube 的 player API 响应，供侧栏下载兜底使用。
// 注意：本文件运行在页面主世界，禁止使用 chrome.* API。
// ===== B站播放页熔断（兼容 B站原生播放器）=====
// 实测：在 B站视频播放页即便只监听 fetch/XHR 响应，也会因微任务时序变化导致 B站播放器
// 读取 playurl 配置（nc_policy / reward_pcdn_loader_policy）时对象为 undefined，视频加载失败。
// 故 B站播放页（bilibili.com/video/ 等）直接跳过本注入脚本的全部逻辑，扩展在该页面 100% 静默。
function __hmdao_isBiliPlayPage() {
  try {
    const h = location.hostname || '';
    return (h.endsWith('bilibili.com') || h.endsWith('b23.tv')) && /\/(video|blackboard\/.*play|festival)\//.test(location.pathname);
  } catch (_) { return false; }
}

(function () {
  if (window.__hmdao_installed) return;
  if (__hmdao_isBiliPlayPage()) return; // B站播放页熔断：不执行任何 patch，兼容原生播放器
  window.__hmdao_installed = true;
  window.__hmdao_captures = {};

  // build 标记：MAIN world 无法用 chrome.runtime，经 postMessage 交给 detect.js 代为上报 background 统一入口
  const HMDAO_INJECT_MAIN_BUILD = '2026-07-25-main-v1';
  try { window.postMessage({ type: 'HMDAO_MAIN_BUILD', build: HMDAO_INJECT_MAIN_BUILD }, '*'); } catch (_) {}

  // 捕获 YouTube 实际播放流（googlevideo.com/videoplayback）。
  // 这些 URL 是页面自身播放时请求的、已含合法 n 签名且绑定同 IP，可直接下载；
  // 按 mime 参数区分 audio/video，按 itag 去重，strip range 得到整文件直链。
  // 这样无需反混淆 YouTube 的 n 签名算法，即可拿到可用直链（含 Audio Library 音效）。
  function hmdaoCaptureYtStream(reqUrl) {
    try {
      if (typeof reqUrl !== 'string' || reqUrl.indexOf('googlevideo.com/videoplayback') < 0) return;
      const u = new URL(reqUrl);
      // 去掉分段/序列参数，得到「整文件」直链。YouTube 现代走 DASH，播放器按 sq=0,sq=1… 逐段请求，
      // 若只删 range 保留 sq，则后续拉取只拿到单个片段（残缺/400）→ 预览黑屏、下载不完整。
      ['range', 'sq', 'rqh', 'rn', 'rbq'].forEach((k) => u.searchParams.delete(k));
      const mime = u.searchParams.get('mime') || '';
      const itag = u.searchParams.get('itag') || u.pathname;
      const cls = /^audio\//.test(mime) ? 'audio' : 'video';
      window.__hmdao_captures.ytPlay = window.__hmdao_captures.ytPlay || { video: {}, audio: {} };
      window.__hmdao_captures.ytPlay[cls][itag] = u.toString();
    } catch (_) {}
  }
  window.__hmdaoCaptureYtStream = hmdaoCaptureYtStream;

  // 捕获抖音 CDN 直链（douyinvod.com / v26-web.douyinvod.com / bytedance 等）。
  // 抖音播放器和 YouTube 一样，播放器已经完成签名/鉴权，真实播放流是最好的数据源。
  // 在 MAIN 世界按时间戳收队，取最新一条作为「当前播放」的视频（避免 NETWORK_ASSETS 末尾是预加载）。
  function hmdaoCaptureDyStream(reqUrl) {
    try {
      if (typeof reqUrl !== 'string' || !/(douyinvod|douyin\.com\/.*video|bytedance)/i.test(reqUrl)) return;
      const u = new URL(reqUrl);
      // 去掉可能的 range/分段参数，得到整文件直链
      ['range', 'sq', 'rqh', 'rn', 'rbq'].forEach((k) => u.searchParams.delete(k));
      window.__hmdao_captures.dyUrls = window.__hmdao_captures.dyUrls || [];
      const clean = u.toString();
      // 去重：不重复添加同一 URL
      if (window.__hmdao_captures.dyUrls.indexOf(clean) < 0) {
        window.__hmdao_captures.dyUrls.push(clean);
        // 限制 50 条（避免内存泄漏）
        if (window.__hmdao_captures.dyUrls.length > 50) window.__hmdao_captures.dyUrls.shift();
      }
    } catch (_) {}
  }
  window.__hmdaoCaptureDyStream = hmdaoCaptureDyStream;

  // 接口响应体里的视频直链捕获（针对 LiblibAI / 模型社区等"视频在 XHR/fetch 响应 JSON 里"的站点）。
  // 扫描响应文本里出现的 mp4/webm/m3u8 等直链，去重存入 apiVideos。
  // 仅扫描 JSON 接口（文本含 '{'），且限制长度避免性能问题。
  const API_VIDEO_RE = /https?:\/\/[^"'\\<>()\s]+\.(mp4|webm|m3u8|mov|m4v|mkv|ogv)(\?[^\"'\\<>()\s]*)?/gi;
  function hmdaoScanApiVideoUrls(text) {
    if (!text || typeof text !== 'string') return;
    if (text.length > 2 * 1024 * 1024) return; // 仅扫描接口 JSON，跳过超长文本
    if (text.indexOf('{') < 0 && text.indexOf('[') < 0) return; // 非 JSON 不扫
    try {
      const arr = window.__hmdao_captures.apiVideos = window.__hmdao_captures.apiVideos || [];
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
  window.__hmdaoScanApiVideoUrls = hmdaoScanApiVideoUrls;

  // 捕获 YouTube 播放器实际拉回的【响应体字节】——这是「真视频」，因为请求已由播放器带齐所有
  // 鉴权（n 签名 / 会话 Cookie / Referer）完成。fetch 拦截器已改为消费原响应→重建 Response，
  // 确保 100% 拿到真实字节，彻底绕过「抓直链后再重发被 YouTube 返回假视频」的死结。
  // 按 itag 拼接连续片段（DASH 顺序请求 sq=0,sq=1… → 拼接即连续可播放文件）。
  // 上限 200MB（足够 1080p 30min 甚至 720p 60min 完整缓存；base64 会放大 33% 约 267MB 内存开销）。
  function hmdaoCaptureYtBody(reqUrl, buf, mime) {
    try {
      if (!buf || buf.byteLength < 64) return; // 太小的多半是错误体，跳过
      let u;
      try { u = new URL(reqUrl); } catch (_) { return; }
      // 与 hmdaoCaptureYtStream 一致的 itag 提取逻辑：查询参数优先，pathname 兜底
      const itag = u.searchParams.get('itag') || u.pathname;
      // ★ 双轨存储：rawChunks(Uint8Array 片段数组) 用于跨 context 传输（structured clone）
      //   + b64(字符串) 用于兼容旧代码。rawChunks 绕开 base64→atob 在传输中的损坏问题。
      const cap = (window.__hmdao_captures.ytBytes = window.__hmdao_captures.ytBytes || {});
      const entry = cap[itag] || (cap[itag] = { b64: '', rawChunks: [], mime: mime || 'video/mp4', size: 0 });
      const MAX = 200 * 1024 * 1024;
      if (entry.size >= MAX) return;
      const remain = MAX - entry.size;
      const slice = buf.byteLength > remain ? buf.slice(0, remain) : buf;
      // 存储 Uint8Array 片段（structured clone 传输用）
      entry.rawChunks.push(new Uint8Array(slice));
      // 同时维护 b64（兼容旧路径，逐步废弃）
      const bytes = new Uint8Array(slice);
      const CH = 0xC000;
      let part = '';
      for (let i = 0; i < bytes.length; i++) {
        part += String.fromCharCode(bytes[i]);
        if (part.length >= CH || i === bytes.length - 1) { entry.b64 += btoa(part); part = ''; }
      }
      entry.size += slice.byteLength;
      if (mime) entry.mime = mime;
    } catch (_) {}
  }
  window.__hmdaoCaptureYtBody = hmdaoCaptureYtBody;

  try {
    const orig = window.fetch;
    window.fetch = function () {
      let p;
      try {
        const url = (typeof arguments[0] === 'string' ? arguments[0] : (arguments[0] && arguments[0].url)) || '';
        hmdaoCaptureYtStream(url);
        hmdaoCaptureDyStream(url);
        const isBili = /bilibili\.com\/x\/(web-interface\/view|player\/playurl|player\/wbi\/playurl|space\/acc\.info)/.test(url);
        const isYT = /youtube\.com\/youtubei\/v1\/player/.test(url);
        // googlevideo 直链：克隆响应读取【真实字节】，拼接进 ytBytes（按 itag）
        // 注意：window.fetch 返回的是 Promise<Response>，不是 Response —— 必须先 .then 拿到
        // resp 再 clone()（早前误用 p.clone() 恒为 undefined，导致字节从未被捕获）。
        const isGV = /googlevideo\.(com|localhost)\/videoplayback/.test(url);
        if (isGV) {
          p = orig.apply(this, arguments);
          // ★关键修复：YouTube 播放器拉流时，response.clone() 常因浏览器流消费锁/时机
          // 问题拿不到字节（实测 ytPlay 有 URL 但 ytBytes 为空）。改为：消费原 response
          // → 拷贝 arrayBuffer → 用拷贝重建 Response 还给播放器。播放器无感知（同 status/headers），
          // 我们同步拿到真实视频字节存入 ytBytes。这是绕过 n 签名/Cookie/Referer 四道门禁的
          // 唯一可靠来源——请求已由播放器完成全部鉴权。
          p = p.then(function (resp) {
            if (!resp || !resp.ok) return resp;
            try {
              var ct = (resp.headers && resp.headers.get) ? (resp.headers.get('content-type') || 'video/mp4') : 'video/mp4';
              return resp.arrayBuffer().then(function (buf) {
                window.__hmdao_captures._lastCapture = 'fetch:' + buf.byteLength;
                try { hmdaoCaptureYtBody(url, buf, ct); } catch (_) {}
                return new Response(buf, { status: resp.status, statusText: resp.statusText || '', headers: resp.headers });
              }).catch(function () { return resp; });
            } catch (_) { return resp; }
          }).catch(function () { /* 原始 fetch 失败时让错误透传即可 */ });
          return p;
        }
        if (isBili || isYT) {
          p = orig.apply(this, arguments);
          try {
            p.then(function (resp) {
              try {
                if (!resp || typeof resp.clone !== 'function') return;
                var r2 = resp.clone();
                r2.json().then(function (d) {
                  window.__hmdao_captures[isBili ? 'bili' : 'yt'] = { url: url, data: d, ts: Date.now() };
                }).catch(function () {});
                // ★扩展（2026-08-01）：接口响应体视频直链捕获（liblib 等动态视频站点）
                var r3 = resp.clone();
                r3.text().then(function (t) { try { hmdaoScanApiVideoUrls(t); } catch (_) {} }).catch(function () {});
              } catch (_) {}
            }).catch(function () {});
          } catch (_) {}
          return p;
        }
        // 其它（非 B站/YouTube/GoogleVideo）请求：本文件仅注入 YT/B站，这两个站没有
        // "接口响应体动态视频直链"场景；该捕获已由 model-api-capture.js 全站 MAIN 注入负责。
        p = orig.apply(this, arguments);
      } catch (_) {}
      return p;
    };
  } catch (_) {}

  try {
    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, asyncRest) {
      try {
        if (typeof url === 'string') hmdaoCaptureYtStream(url);
        if (typeof url === 'string') hmdaoCaptureDyStream(url);
        var isGV = typeof url === 'string' && /googlevideo\.(com|localhost)\/videoplayback/.test(url);
        if (isGV) this._hmdao_gvUrl = url;
        var isBili = typeof url === 'string' && /bilibili\.com\/x\/(web-interface\/view|player\/playurl|player\/wbi\/playurl|space\/acc\.info)/.test(url);
        var isYT = typeof url === 'string' && /youtube\.com\/youtubei\/v1\/player/.test(url);
        if (isBili || isYT) this._hmdao_ytUrl = url;
      } catch (_) {}
      return origOpen.call(this, method, url, asyncRest);
    };
    XMLHttpRequest.prototype.send = function (body) {
      var self = this;
      var gvUrl = self._hmdao_gvUrl;
      var ytUrl = self._hmdao_ytUrl;
      if (gvUrl) {
        // ★关键修复：YouTube 播放器可能用 XHR(而非 fetch)拉 googlevideo 视频。
        // 旧逻辑靠 addEventListener('load') 读取 this.response，但在默认 responseType=''
        // 时 this.response 是 DOMString 无法还原二进制→跳过捕获，导致 ytBytes 始终为空。
        // 修复：在 send() 时把 responseType 设为 'arraybuffer' 以拿到真实 ArrayBuffer。
        // ★重要约束（2026-08-01）：绝不能 Object.defineProperty(...,{writable:false}) 锁死该属性，
        // 否则页面自身后续对该 XHR 的 .responseType= 赋值会抛 DOMException，干扰网站正常运行。
        // 也仅在原生默认 ''/'text' 时改写；若页面已设其它类型则保留页面原值、跳过捕获，绝不破坏页面语义。
        try {
          if (self.responseType === '' || self.responseType === 'text') {
            try { self.responseType = 'arraybuffer'; } catch (_) {}
          }
        } catch (_) {}
        self.addEventListener('load', function () {
          try {
            var ct = (self.getResponseHeader && self.getResponseHeader('content-type')) || 'video/mp4';
            var buf = null;
            if (self.response instanceof ArrayBuffer) buf = self.response;
            else if (self.response && typeof self.response === 'object' && 'buffer' in self.response) buf = self.response.buffer || self.response;
            if (buf && buf.byteLength >= 64) {
              window.__hmdao_captures._lastCapture = 'xhr:' + buf.byteLength;
              hmdaoCaptureYtBody(gvUrl, buf, ct);
            }
          } catch (_) {}
        });
      }
      if (ytUrl) {
        self.addEventListener('load', function () {
          try {
            var d = JSON.parse(self.responseText);
            window.__hmdao_captures['yt'] = { url: ytUrl, data: d, ts: Date.now() };
          } catch (_) {}
          try { hmdaoScanApiVideoUrls(self.responseText); } catch (_) {}
        });
      }
      // 其它（非 B站/YouTube/GoogleVideo）XHR：本文件仅注入 YT/B站，动态视频直链捕获
      // 已由 model-api-capture.js 全站 MAIN 注入负责，此处不再处理。
      return origSend.call(this, body);
    };
  } catch (_) {}
})();
