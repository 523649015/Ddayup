// ===== 豆包（doubao.com）「朗读」音频被动采集（MAIN 世界）=====
// 需求：侧栏能扫描并采集豆包会话里「朗读」生成的音频。
// 设计原则（与爱给/抖音采集同一套零副作用方法论）：
//   1) 只旁路记录，绝不改写原生 API 的入参 / 返回值 / 调用时序；所有逻辑 try/catch 包裹，异常绝不外抛。
//   2) 不 clone 响应体、不读 body —— 只读响应头 content-type/content-length。
//      （豆包对话是高频 SSE 流，任何 clone().text() 都会造成内存与 CPU 浪费。）
//   3) 不扫 DOM、不装 MutationObserver、不 hook WebSocket（豆包对话流极高频，碰它必卡顿）。
//   4) 结果存 window.__hmdao_captures.doubaoTts，由 background 在【用户点扫描时】用
//      world:'MAIN' 的 readAllCapturesMAIN 一次性读回 —— 平时零开销。
//   5) 仅在 doubao.com 生效，其它站点一行代码都不执行。
(function () {
  if (typeof window === 'undefined' || window.__hmdao_doubao_audio) return;
  try {
    const h = location.hostname || '';
    if (!/(^|\.)doubao\.com$/.test(h)) return;
  } catch (_) { return; }
  window.__hmdao_doubao_audio = true;
  // ★注入即建立容器（此前只在首次捕获时才建 → 现场无法区分「脚本没注入」和「注入了但没抓到」）。
  //   空对象/空数组，零开销，仅用于诊断与后台读取的一致性。
  (function initBag() {
    try {
      const c = (window.__hmdao_captures = window.__hmdao_captures || {});
      if (!Array.isArray(c.doubaoTts)) c.doubaoTts = [];
      if (!Array.isArray(c.doubaoTtsCandidates)) c.doubaoTtsCandidates = [];
    } catch (_) {}
  }());

  const MAX = 50;
  function bag() {
    const c = (window.__hmdao_captures = window.__hmdao_captures || {});
    return (c.doubaoTts = c.doubaoTts || []);
  }

  // 明显不是音频的 URL（图片/视频/文档/埋点）——防止污染音频模块
  function isNoise(url) {
    try {
      const p = new URL(url).pathname.toLowerCase();
      if (/\.(jpe?g|png|gif|webp|bmp|svg|ico|avif|apng|tiff?)(\?|#|$)/.test(p)) return true;
      if (/\.(mp4|webm|mov|m4v|mkv|ogv|m3u8|mpd|flv|avi|wmv|ts|3gp|f4v)(\?|#|$)/.test(p)) return true;
      if (/\.(json|xml|html?|css|js|mjs|pdf|docx?|zip|rar|7z|gz|tar)(\?|#|$)/.test(p)) return true;
      if (/(^|\/)(1x1|spacer|pixel|beacon|track|collect|analytics|log|report)(\.[^/]*)?$/i.test(p)) return true;
    } catch (_) {}
    return false;
  }

  // 响应是否像音频（【确定性判据】才直接入库）：
  //   a) content-type: audio/*（mp3/mpeg/wav/mp4-aac/ogg/webm…）；
  //   b) URL 带音频扩展名。
  // octet-stream/JSON 包体等【非确定性】形态一律走候选 → 后台 Range GET 验魔数后才入库。
  function looksAudio(url, ct) {
    try {
      if (/^audio\//i.test(ct)) return true;
      if (/\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|weba|amr)(\?|#|$)/i.test(url)) return true;
    } catch (_) {}
    return false;
  }

  // 候选记录（非确定性 URL）：Performance 探针与 fetch/XHR 的 octet-stream 兜底共用。
  // 只记 URL 元数据，入库与否由后台魔数验证决定。
  function pushCand(url, size) {
    try {
      if (!url || typeof url !== 'string' || /^(blob:|data:)/i.test(url)) return;
      const u = new URL(url, location.href);
      if (!/^https?:$/.test(u.protocol)) return;
      if (isNoise(u.href)) return;
      const list = candBag();
      const key = u.origin + u.pathname;
      const item = { url: u.href, path: key, size: Number(size) || 0, ts: Date.now() };
      const i = list.findIndex((e) => e.path === key);
      if (i >= 0) list[i] = item; else list.push(item);
      if (list.length > 30) list.shift();
    } catch (_) {}
  }
  function candBag() {
    const c = (window.__hmdao_captures = window.__hmdao_captures || {});
    return (c.doubaoTtsCandidates = c.doubaoTtsCandidates || []);
  }
  // 二进制/未知包体 → 候选（豆包 TTS 接口常返回 octet-stream）
  function looksBinaryCand(url, ct) {
    return /octet-stream|application\/binary|binary\/octet-stream|application\/x-protobuf/i.test(String(ct || ''));
  }

  function remember(url, ct, how, size) {
    try {
      if (!url || typeof url !== 'string') return;
      if (/^(blob:|data:|mediasource:)/i.test(url)) return; // 跨上下文不可用
      const abs = new URL(url, location.href).href;
      if (!/^https?:/i.test(abs)) return;
      // ★2026-09-08 修复（豆包技能音乐「有的扫得到、有的扫不到」真凶）：
      //   豆包技能音乐实为 https://lf-flow-web-cdn.doubao.com/obj/flow-doubao/samantha/skills/music/<hash>.mp4
      //   —— 后缀是 .mp4（AAC 音频装在 mp4 容器），但确由 <audio> 元素播放
      //   （实测 Performance initiatorType='audio'、size≈768KB）。
      //   旧逻辑 isNoise() 把 mp4 当"视频噪声"无条件拒绝 → <audio> 正在播的这首歌反被当视频排除
      //   → doubaoTts 恒为 0，只有通用网络层偶尔碰巧捞到一条（故"有的能、有的不能"）。
      //   ★元素类型是权威判据：<audio> 加载/播放的一定是音频，此时跳过扩展名噪声过滤。
      const authoritativeAudio = (how === 'media-play' || how === 'dom-play');
      if (!authoritativeAudio && isNoise(abs)) return;
      let path = abs;
      try { const x = new URL(abs); path = x.origin + x.pathname; } catch (_) {}
      const list = bag();
      // 同 pathname 视为同一段朗读（签名参数会刷新），永远保留【最新】直链
      const item = { url: abs, path: path, mime: String(ct || '').split(';')[0] || '', how: how || '', size: Number(size) || 0, ts: Date.now() };
      const i = list.findIndex((e) => e.path === path);
      if (i >= 0) list[i] = item; else list.push(item);
      if (list.length > MAX) list.shift();
    } catch (_) {}
  }

  // ── 1) fetch 旁路：只读响应头，不碰 body ──
  try {
    const of = window.fetch;
    if (typeof of === 'function' && !of.__hmdao_doubao) {
      const patched = function () {
        const input = arguments[0];
        const p = of.apply(this, arguments);
        try {
          if (p && typeof p.then === 'function') {
            p.then(function (r) {
              try {
                const u = (typeof input === 'string') ? input : ((input && input.url) || '');
                const ct = (r && r.headers && r.headers.get) ? (r.headers.get('content-type') || '') : '';
                const cl = (r && r.headers && r.headers.get) ? (r.headers.get('content-length') || '') : '';
                if (looksAudio(String(u || ''), ct)) remember(String(u || ''), ct, 'fetch', parseInt(cl || '0', 10));
                else if (looksBinaryCand(u, ct)) pushCand(String(u || ''), parseInt(cl || '0', 10));
              } catch (_) {}
            }).catch(function () {});
          }
        } catch (_) {}
        return p;
      };
      patched.__hmdao_doubao = true;
      window.fetch = patched;
    }
  } catch (_) {}

  // ── 2) XHR 旁路：open 时挂一次性 load 监听，只读响应头 ──
  try {
    const ox = XMLHttpRequest.prototype.open;
    if (typeof ox === 'function' && !ox.__hmdao_doubao) {
      const patched = function (m, u) {
        try {
          if (!this.__hmdao_doubao_hook) {
            this.__hmdao_doubao_hook = true;
            this.addEventListener('load', function () {
              try {
                const ct = this.getResponseHeader('content-type') || '';
                const cl = this.getResponseHeader('content-length') || '';
                if (looksAudio(String(u || ''), ct)) remember(String(u || ''), ct, 'xhr', parseInt(cl || '0', 10));
                else if (looksBinaryCand(u, ct)) pushCand(String(u || ''), parseInt(cl || '0', 10));
              } catch (_) {}
            });
          }
        } catch (_) {}
        return ox.apply(this, arguments);
      };
      patched.__hmdao_doubao = true;
      XMLHttpRequest.prototype.open = patched;
    }
  } catch (_) {}

  // ── 3) 游离 <audio>/new Audio() 播放旁路 ──
  // 豆包可能用不在 DOM 里的 new Audio(url) 播放（爱给已实证过同类形态）。
  // 仅包装 play：读一次 currentSrc 后原样透传返回值（Promise），不改变任何行为。
  try {
    const op = HTMLMediaElement.prototype.play;
    if (typeof op === 'function' && !op.__hmdao_doubao) {
      const patched = function () {
        try {
          // 只认 <audio>（豆包也会播 AI 生成的视频，必须排除 VIDEO，否则视频 URL 混入音频模块）。
          // <audio> 元素播放的一定是音频，无需再看扩展名（TTS 直链常无扩展名）。
          if (this && this.tagName && String(this.tagName).toUpperCase() !== 'AUDIO') {
            return op.apply(this, arguments);
          }
          remember(this.currentSrc || this.src || '', '', 'media-play');
        } catch (_) {}
        return op.apply(this, arguments);
      };
      patched.__hmdao_doubao = true;
      HTMLMediaElement.prototype.play = patched;
    }
  } catch (_) {}

  // ── 4) Performance 资源探针（只读，零干扰）────────────────────────────
  // 实测（Edge 登录态）：朗读播放中侧栏「音频 0」→ 豆包朗读不是标准 audio/* 直链，
  // 可能是 octet-stream/JSON 包体的接口流。fetch 钩子按响应头判定会漏。
  // PerformanceObserver 只读浏览器自己记录的 resource 条目（不拦截、不修改任何请求），
  // 把「响应体较大且不像脚本/样式/图片」的 URL 记为【候选】，由 background 用
  // Range GET 前 64 字节验魔数（ID3/ftyp-M4A/OggS/RIFF/fLaC/ADTS）后才入库——杜绝误报。
  try {
    if (window.PerformanceObserver && !window.__hmdao_doubao_perf) {
      window.__hmdao_doubao_perf = true;
      // pushCand/candBag 复用本 IIFE 顶部定义（fetch/XHR 兜底与探针共用）
      const obs = new PerformanceObserver((entries) => {
        try {
          for (const e of entries.getEntries() || []) {
            const sz = Math.max(e.transferSize || 0, e.encodedBodySize || 0, e.decodedBodySize || 0);
            if (sz < 16384) continue; // 朗读一段通常几十 KB 起；小响应（信令/埋点）不看
            const it = String(e.initiatorType || '');
            if (it && !/fetch|xmlhttprequest|other|media|audio/i.test(it)) continue;
            const n = String(e.name || '');
            // ★性能：豆包每次会话有 500+ 资源条目，先做【最便宜】的静态资源排除
            //   （只取扩展名做一次小字符串判断），避免对每个条目都跑完整 URL 解析与正则。
            const dot = n.lastIndexOf('.');
            if (dot > 0) {
              const ext = n.slice(dot + 1, dot + 6).toLowerCase();
              if (/(js|mjs|css|map|png|jpe?g|gif|webp|svg|woff2?|ttf|ico)/.test(ext)) continue;
            }
            pushCand(n, sz);
          }
        } catch (_) {}
      });
      obs.observe({ type: 'resource', buffered: true });
    }
  } catch (_) {}

  // ── 5) WebSocket 音频流旁路收集（2026-09-06 定案）──────────────────────
  // ★静态分析（s2-doubao-speech-sdk.841b9775.js + async-chat-speech.js）实测结论：
  //   豆包朗读走 wss://frontier-audio-web-ws.doubao.com/api/v2/sami/voicegenie，
  //   格式 ogg_opus / 24kHz / 32kbps，前端由 OpusDecoderModule(wasm) 解码后交给
  //   PCMPlayer + AudioWorklet 播放 —— 全程无 HTTP 音频直链、无 <audio> 元素、
  //   也不走 decodeAudioData。故「抓 URL」方案对它无效，改为【旁路收集 WS 原始音频字节】。
  // 边界（严格）：
  //   · 不替换 WebSocket 构造函数 → instanceof / 静态常量 / new 行为 100% 不变；
  //   · 只额外注册一个 message 监听（addEventListener 透传 + onmessage setter 保留原 descriptor）；
  //   · 只读 ev.data 并 slice 复制，不改数据、不拦截事件、不阻塞 SDK；
  //   · 仅匹配音频 WS（URL 含 voicegenie/sami/tts），对话 WS 完全不碰；
  //   · 每段上限 32MB，超限停止收集（opus 32kbps ≈ 240KB/分钟，实际远低于此）。
  try {
    const WS_AUDIO_RE = /voicegenie|sami|tts|speech/i;
    const WS_MAX_BYTES = 32 * 1024 * 1024;
    // ★分段策略（用户要求：第一次朗读=第 1 张卡，第二次=第 2 张卡，不许合并）：
    //   【一个 WebSocket 连接 = 一段朗读】，在连接建立时即开新段。
    //   绝不用 URL 判等 —— 豆包多次朗读可能复用同一个 wss endpoint（URL 相同），
    //   按 URL 判等会把多次朗读的字节混进同一段（实测正是"几段合在一起"的原因）。
    const WS_MAX_SEGMENTS = 5;
    // ★按会话隔离（2026-09-06 用户要求）：新建任务/切聊天页 → 侧栏不再显示上个会话的音频卡；
    //   切回原会话 → 又能读到（数据仍在页面内存，仅按会话 id 分区，不删除）。
    function chatKey() {
      try {
        const m = /\/chat\/(\d+)/.exec(location.pathname || '');
        return m ? m[1] : 'root';
      } catch (_) { return 'root'; }
    }
    function bucket(create) {
      const c = (window.__hmdao_captures = window.__hmdao_captures || {});
      if (!c.doubaoTtsByChat || typeof c.doubaoTtsByChat !== 'object') c.doubaoTtsByChat = {};
      const k = chatKey();
      if (!c.doubaoTtsByChat[k] && create) c.doubaoTtsByChat[k] = { list: [], cur: null };
      return c.doubaoTtsByChat[k] || null;
    }
    // 开新段：一个 WS 连接 = 一段朗读；每段由连接自己持有（闭包），
    // 不会出现「上一段还在收数据却写到新段」的串数据问题。
    function startWsSegment(url) {
      const bk = bucket(true);
      if (!bk) return null;
      const prev = bk.cur;
      if (prev && prev.bytes > 1024) {
        bk.list.push(prev);
        if (bk.list.length > WS_MAX_SEGMENTS) bk.list.shift();
      }
      bk.cur = { url: String(url || ''), chunks: [], bytes: 0, ts: Date.now(), frames: 0, done: false };
      return bk.cur;
    }
    // ★诊断探针（2026-09-08）：非语音 WS 只统计字节量（不保留数据、不拦截、不阻塞 SDK），
    //   用于回答「模板音乐到底走不走 WS」——若 probe 里有 binary 大流量 WS，说明音乐走
    //   WS 但端点不在 WS_AUDIO_RE 内，下一轮把它加进正则即可完整采集。上限 12 条防膨胀。
    function probeWs(u, ws) {
      try {
        const c = (window.__hmdao_captures = window.__hmdao_captures || {});
        if (!c.doubaoWsProbe || typeof c.doubaoWsProbe !== 'object') c.doubaoWsProbe = {};
        const keys = Object.keys(c.doubaoWsProbe);
        if (keys.length > 12) {
          let oldest = keys[0];
          for (const k of keys) if (c.doubaoWsProbe[k].ts < c.doubaoWsProbe[oldest].ts) oldest = k;
          delete c.doubaoWsProbe[oldest];
        }
        const key = String(u || '').slice(0, 160);
        const e = c.doubaoWsProbe[key] || (c.doubaoWsProbe[key] = { bytes: 0, msgs: 0, ts: Date.now() });
        ws.addEventListener('message', function (ev) {
          try {
            const d = ev && ev.data;
            const n = (d instanceof ArrayBuffer) ? d.byteLength
              : (typeof Blob !== 'undefined' && d instanceof Blob) ? d.size
              : (typeof d === 'string' ? d.length : 0);
            e.bytes += n; e.msgs++;
          } catch (_) {}
        });
      } catch (_) {}
    }
    function attachWsBypass(ws) {
      try {
        if (!ws || ws.__hmdao_ws_hook) return;
        const u = String((ws && ws.url) || '');
        if (!/^wss?:/i.test(u)) return;
        ws.__hmdao_ws_hook = true;
        // 非语音端点 → 挂字节统计探针后返回（不采集、不保留数据）
        if (!WS_AUDIO_RE.test(u)) { probeWs(u, ws); return; }
        // 新连接 → 新的一段（hook 每个连接只挂一次）
        const seg = startWsSegment(u);
        if (!seg) return;
        // ★朗读「完成」判定：WS 关闭/出错即视为本段结束（用户要求：结束完成才算一张卡，
        //   不允许上一段还在播就提前拆出新卡）。
        const finish = function () { try { seg.done = true; } catch (_) {} };
        try { ws.addEventListener('close', finish); } catch (_) {}
        try { ws.addEventListener('error', finish); } catch (_) {}
        ws.addEventListener('message', function (ev) {
          try {
            const b = seg;
            if (b.bytes > WS_MAX_BYTES) return;
            const d = ev && ev.data;
            if (d instanceof ArrayBuffer) {
              b.chunks.push(new Uint8Array(d.slice(0))); // 复制，避免 SDK 复用底层 buffer
              b.bytes += d.byteLength;
              b.frames++;
            } else if (typeof Blob !== 'undefined' && d instanceof Blob) {
              // binaryType='blob' 场景：异步取字节（消息间隔远大于微任务，顺序可靠）
              d.slice(0).arrayBuffer().then(function (ab) {
                try {
                  const bb = seg;
                  if (bb.bytes > WS_MAX_BYTES) return;
                  bb.chunks.push(new Uint8Array(ab));
                  bb.bytes += ab.byteLength;
                  bb.frames++;
                } catch (_) {}
              }).catch(function () {});
            }
          } catch (_) {}
        });
      } catch (_) {}
    }
    // 5a) addEventListener 透传包装（覆盖 SDK 用 addEventListener 的写法）
    const oadd = window.WebSocket && WebSocket.prototype.addEventListener;
    if (typeof oadd === 'function' && !oadd.__hmdao_doubao) {
      const patchedAdd = function (type, fn, opts) {
        try { if (type === 'message') attachWsBypass(this); } catch (_) {}
        return oadd.call(this, type, fn, opts);
      };
      patchedAdd.__hmdao_doubao = true;
      WebSocket.prototype.addEventListener = patchedAdd;
    }
    // 5b) onmessage setter 旁路（覆盖 SDK 用 ws.onmessage = fn 的写法；保留完整 descriptor）
    const omDesc = window.WebSocket && Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
    if (omDesc && omDesc.set && !omDesc.set.__hmdao_doubao) {
      const origSet = omDesc.set;
      const patchedSet = function (fn) {
        try { attachWsBypass(this); } catch (_) {}
        return origSet.call(this, fn);
      };
      patchedSet.__hmdao_doubao = true;
      Object.defineProperty(WebSocket.prototype, 'onmessage', {
        configurable: omDesc.configurable !== false,
        enumerable: omDesc.enumerable,
        get: omDesc.get,
        set: patchedSet,
      });
    }
  } catch (_) {}

  // 挂在 DOM 里的 <audio>（React 常见）：'play' 不冒泡，但捕获阶段仍经过 document。
  try {
    document.addEventListener('play', function (e) {
      try {
        const t = e && e.target;
        if (!t || t.tagName === 'VIDEO') return;
        remember(t.currentSrc || t.src || '', '', 'dom-play');
      } catch (_) {}
    }, true);
  } catch (_) {}
})();
