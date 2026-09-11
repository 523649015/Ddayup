// ===== 预览子视图渲染（抽离自 openPreview 的 switch 分支）=====
// 依赖 sidepanel.js 全局：getAsset / loadImageViaRelay / fallbackCdnFetch / startDashPreview /

// ★2026-09-01 防御性更新 previewImg 封面（抽离成独立函数，便于测试与复用）
//   旧逻辑的破图根因：先 pvImg.style.display='' 然后异步等 loadImageViaRelay →
//   中间状态时 <img> 上保留【上一张卡的旧 src】(可能是视频 URL)→ 浏览器短暂显示红禁止 →
//   失败资源被 Chrome 缓存到 %TEMP%\image.<hash>.png → 用户看到 @image:C:\...\Temp\image.xxx.png。
//   修：先【清 src + 隐藏】，relay 成功才显示 blob；失败永不再设 src、保持隐藏。
async function safeSetPvImgCover(pvImg, coverUrl, referer) {
  if (!pvImg || !coverUrl) return;
  try { pvImg.removeAttribute('src'); } catch (_) {}
  pvImg.style.display = 'none';
  try {
    const burl = await Promise.resolve(loadImageViaRelay(coverUrl, referer));
    if (burl && pvImg) {
      pvImg.src = burl;
      pvImg.style.display = '';
    }
  } catch (_) { /* 保持隐藏，绝不直连 */ }
}
// ★2026-09-02 B 方案：抖音视频字节经【本机后端】代理拉取。
//   实测铁证：douyinvod.com 相对 douyin.com 跨域，且 CDN 不返回 CORS 头，
//   前端任何 fetch（源页 MAIN / SW）都抛 "Failed to fetch"（background.js:2206）。
//   前端此路不通 → 改由后端 /api/media-proxy 代拉：
//     服务端无 CORS 限制，且 hmdao-api.mjs:831-834 确认会带上 Referer → 拿到真实字节。
//   边界：任何失败一律返回 null，由调用方回退原逻辑；不抛错、不干扰其他平台。
async function fetchDouyinBytesViaBackend(targetUrl) {
  if (!targetUrl || typeof targetUrl !== 'string' || !/^https?:/i.test(targetUrl)) return null;
  try {
    const bases = ['http://127.0.0.1:3000', 'http://localhost:3000'];
    let lastErr = null;
    for (const base of bases) {
      try {
        const api = base + '/api/media-proxy?url=' + encodeURIComponent(targetUrl)
          + '&referer=' + encodeURIComponent('https://www.douyin.com/');
        const r = await fetch(api, { method: 'GET' });
        if (!r || !r.ok) { lastErr = new Error('HTTP ' + (r && r.status)); continue; }
        const buf = await r.arrayBuffer();
        // 小于 1KB 基本是错误页/HTML，不算成功
        if (buf && buf.byteLength > 1024) return buf;
      } catch (e) { lastErr = e; }
    }
    if (lastErr) console.log('[HMDAO][pv] 后端代理拉字节失败，回退原路径：', lastErr && lastErr.message);
  } catch (_) {}
  return null;
}

// 暴露供测试用（仅 Node 测试环境；浏览器 chrome 扩展不读这个，零影响）
try { if (typeof module !== 'undefined' && module.exports) module.exports = { safeSetPvImgCover }; } catch (_) {}
// fetchPlatformFormats / isYtDlpPlatform / buildVideoAltResolutions / buildDyFormatSelector /
// previewModel3D / previewArchiveEntries / setStatus / typeLabel / fileName / imgDimensions /
// escapeAttr / truncate，以及 audio-playback.js 的 playAudioInPage / stopHoverAudio / stopModelSandbox。
// 本文件在 sidepanel.js 与 audio-playback.js 之后加载（运行时由 openPreview 调用），纯物理拆分，行为零改变。

// ===== 图片预览 =====
function renderPreviewImage(a) {
  ensureDragData(a, true); // 预览即缓存字节，确保拖到桌面/文件夹能写出真实文件（File）
  document.getElementById('pvCopyImage').style.display = ''; // 图片可复制到系统剪贴板（微信 Ctrl+V）
  document.getElementById('previewInfo').textContent = '拖拽到微信/PS 不会被识别（Chrome 扩展限制），请点「📋 复制图片」后在微信按 Ctrl+V 粘贴。';
  document.getElementById('previewInfo').style.color = '#d29922';
  const pvImg = document.getElementById('previewImg');
  // ★动图直显：GIF/APNG 必须直连原 URL，若走后台 relay 取 blob 重编码会丢失动画 → 退化为静态帧。
  // ★2026-08-31 修复（边界要求——"不得引发控制台报错"）：
  //   <img> 跨域请求【默认携带 cookie】→ Chrome 判定为第三方 cookie 并拦截，
  //   在 Issues 面板与控制台报 "Third-party cookie will be blocked."。
  //   加 crossOrigin='anonymous' 后请求【不再携带 cookie】→ 消除该警告，且仍直连保住动画。
  //   若目标图床未返回 ACAO 头导致 CORS 失败 → onerror 回退后台 relay（静态帧，至少能显示且无警告）。
  if (a.animated) {
    try { pvImg.crossOrigin = 'anonymous'; } catch (_) {}
    try { pvImg.referrerPolicy = 'no-referrer'; } catch (_) {}
    pvImg.onerror = () => {
      try {
        loadImageViaRelay(a.url, window.__sourcePageUrl).then((burl) => {
          if (burl) {
            try { pvImg.removeAttribute('crossorigin'); } catch (_) {}
            pvImg.src = burl;   // blob → 不触发第三方 cookie 警告
          }
        }).catch(() => {});
      } catch (_) {}
    };
    pvImg.src = a.url; // <img> 原生支持 GIF/APNG 动画，直显即保动画
    pvImg.style.display = '';
    return;
  }
  // ★2026-09-01 修复（与 L211 同款防御性策略）：
  //   旧逻辑 `burl || a.url`：relay 失败时回退直连 → 若 a.url 是防盗链资源或视频字节 → 破图 → @image:Temp 缓存。
  //   改：先清旧 src + 隐藏，relay 成功才显示，绝不直连任何远程 URL。
  //   复用 safeSetPvImgCover（独立函数 + 测试覆盖），避免逻辑脱节。
  safeSetPvImgCover(pvImg, a.url, window.__sourcePageUrl);
}

// ★2026-08-23 P5（实测修复 + 有声无画根因修复）：实时同步抖音【当前播放】真实直链到卡片资产。
//   优先经 background 的 HMDAO_FETCH_AWEME_INFO 拿 download_addr（含音画正片整段，单条即可播），
//   彻底规避旧 dyUrls 播放流「分离轨 → 有声无画」问题；该接口同时返回 desc/cover/多档 formats。
//   仅当 FETCH_AWEME_INFO 失败时，回退到源页 inject-main 的 dyUrls[curAwemeId]（播放流兜底）。
//   纯读取，不操作源页 <video>，绝不暂停/刷新。返回 true 表示更新了 a.url / a.dyFormats。
async function syncDouyinCurrentUrl(a) {
  let tabId = null;
  try { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); tabId = t && t.id; } catch (_) {}
  if (!tabId) return false;
  // 取 awemeId：资产自身 > 源页 curAwemeId
  let aid = (a.awemeId || '').replace(/[^\w]/g, '');
  if (!aid) {
    try {
      const [cr] = await chrome.scripting.executeScript({
        target: { tabId }, world: 'MAIN',
        func: () => (window.__hmdao_captures && (window.__hmdao_captures.curAwemeId || '')).replace(/[^\w]/g, '') || '',
      });
      aid = (cr && cr.result) || '';
    } catch (_) {}
  }
  // ★2026-08-24 根因修复（用户实测：「刷新后没匹配内容」「卡片无视频」）：
  //   旧逻辑三路全依赖 HMDAO_FETCH_AWEME_INFO，而该接口底层是
  //   https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/ —— 该接口已于 2023 年被抖音下线，
  //   永远返回 404 → synced 恒为 false → 卡片 a.url/a.cover 永远得不到「刷新补充」，
  //   且刷新后 __hmdao_captures.dyUrls 被 SPA 导航清空 → 第二路 dyUrls[curAwemeId] 也空 →
  //   侧栏只能退回扫描时填的裸 CDN 直链（防盗链 403/404）→ 黑屏、内容对不上。
  //   修复策略：
  //   ① 卡片 a.url / a.cover / a.playerUrl 已在扫描阶段由 extractFreshVideoUrl 的 buildMeta
  //      从 RENDER_DATA 的 download_addr / bitRateList / video.cover 正确填入 —— 这是【唯一可靠】来源，
  //      直接信任，不再依赖已废弃的 iesdouyin 接口（删除全部 HMDAO_FETCH_AWEME_INFO 调用）。
  //   ② 仅当扫描值明显缺失（a.url 为空）时，才尝试源页 dyUrls[curAwemeId] 兜底（播放流，不保证可播）。
  if (a.url && /^https?:/i.test(a.url)) {
    // 可选增强：用源页 curVideoSrc 反查更精确的当前播放流（失败不影响主路径）
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId }, world: 'MAIN',
        // ★2026-09-03 修复（抖音合集多集数：预览/下载对不上当前集）：
        //   把本卡片的 awemeId 传进去，分别返回「源页当前集」与「本卡片专属集」的直链/画质/标题，
        //   外层按是否同一集决定是否覆盖 a.url，避免被自动播放的下一集污染。
        args: [aid],
        func: (aidArg) => {
          try {
            const c = window.__hmdao_captures || {};
            // ★2026-09-01 修复：captures 里【没有】 dyFormats 字段（只有 dyFormatsByAweme，
            //   按 awemeId 索引的对象）。旧代码读 c.dyFormats 恒为 undefined → fmts 恒空
            //   → 刷新后多画质永不更新。改为读 dyFormatsByAweme 并按 awemeId 取值。
            const dyUrls = c.dyUrls || [], dyAwemes = c.dyAwemes || [], dyFormats = c.dyFormatsByAweme || {}, dyTitles = c.dyTitlesByAweme || {}, dyUrlsByAweme = c.dyUrlsByAweme || {}, dyEpisodeByAweme = c.dyEpisodeByAweme || {};
            const cur = (c.curAwemeId || '').replace(/[^\w]/g, '');
            let idx = -1;
            if (cur) idx = dyAwemes.findIndex(x => (x || '').replace(/[^\w]/g, '') === cur);
            if (idx < 0 && dyUrls.length) idx = dyUrls.length - 1;
            const url = idx >= 0 ? (dyUrls[idx] || '') : '';
            const idAt = (i) => (i >= 0 && dyAwemes[i]) ? String(dyAwemes[i]).replace(/[^\w]/g, '') : '';
            const fmts = (dyFormats && (dyFormats[cur] || (idx >= 0 ? (dyFormats[idAt(idx)] || []) : []))) || [];
            // 本卡片专属（按 awemeId 精确取，不依赖源页当前播放位置）
            const myId = String(aidArg || '').replace(/[^\w]/g, '');
            const myFmts = (myId && dyFormats[myId]) || [];
            const myTitle = (myId && dyTitles[myId]) || '';
            // ★2026-09-03：按 awemeId 索引的「视频轨直链」——切集后精确指向本集，实时匹配当前播放内容
            const myUrl = (myId && dyUrlsByAweme[myId]) || '';
            // ★2026-09-03：优先用合集/列表 API 的「绝对集数」，严格等于播放列表；未索引到时按 dyAwemes 顺序兜底
            const myEp = (myId && dyEpisodeByAweme[myId]) || ((myId && dyAwemes.indexOf(myId) >= 0) ? (dyAwemes.indexOf(myId) + 1) : 0);
            return { url, fmts, cur, myFmts, myTitle, myEp, myUrl };
          } catch (_) { return null; }
        },
      });
      const r = res && res.result;
      const cur = (r && r.cur) || '';
      const sameEpisode = !aid || !cur || aid === cur;
      // ★2026-09-03：优先用按 awemeId 索引的「视频轨直链」覆盖 a.url（切集后精确指向本集，实时匹配当前播放内容）；
      // 没有时退回「源页当前播放尾流」（仅当确实是同一集，避免被下一集污染）。
      if (r && r.myUrl && /^https?:/i.test(r.myUrl) && !/media-audio|ies-music|\.mp3(\?|$)/i.test(r.myUrl)) {
        a.url = r.myUrl;
      } else if (sameEpisode && r && r.url && /^https?:/i.test(r.url) && !/media-audio|ies-music|\.mp3(\?|$)/i.test(r.url)) {
        a.url = r.url;
      }
      // 分辨率列表按「本卡片 awemeId」取，而不是源页当前集（避免选了 A 集却下成 B 集画质）
      const myFmts = (r && r.myFmts) || [];
      if (myFmts.length) { a.dyFormats = myFmts; window.__dyFormats = myFmts; }
      // 标题按本集 awemeId 取，确保下载文件名带本集标题而非统一合集名
      if (r && r.myTitle && !a.title) a.title = r.myTitle;
      // 集数按源页 dyAwemes 顺序算（与当前播放的源视频一致），供文件名加「第 N 集」
      if (r && r.myEp) a.episodeNo = r.myEp;
    } catch (_) {}
    return true; // 扫描值已可靠，返回 true（不再误判 synced=false）
  }

  // ② 兜底：扫描 a.url 为空（极端场景）时，用源页 dyUrls[curAwemeId] 播放流补充
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: () => {
        try {
          const c = window.__hmdao_captures || {};
          // ★2026-09-01 修复（第二处，兜底分支）：captures 里【没有】 dyFormats 字段
          //   （只有 dyFormatsByAweme，按 awemeId 索引的对象）。旧代码读 c.dyFormats 恒为
          //   undefined → fmts 恒空 → 刷新后多画质永不更新。改为读 dyFormatsByAweme。
          const dyUrls = c.dyUrls || [], dyAwemes = c.dyAwemes || [], dyFormats = c.dyFormatsByAweme || {};
          const cur = (c.curAwemeId || '').replace(/[^\w]/g, '');
          let idx = -1;
          if (cur) idx = dyAwemes.findIndex(x => (x || '').replace(/[^\w]/g, '') === cur);
          if (idx < 0 && dyUrls.length) idx = dyUrls.length - 1;
          const url = idx >= 0 ? (dyUrls[idx] || '') : '';
          const idAt = (i) => (i >= 0 && dyAwemes[i]) ? String(dyAwemes[i]).replace(/[^\w]/g, '') : '';
          const fmts = (dyFormats && (dyFormats[cur] || (idx >= 0 ? (dyFormats[idAt(idx)] || []) : []))) || [];
          return { url, fmts };
        } catch (_) { return null; }
      },
    });
    const r = res && res.result;
    if (r && r.url && /^https?:/i.test(r.url) && !/media-audio|ies-music|\.mp3(\?|$)/i.test(r.url)) {
      a.url = r.url;
      if (r.fmts && r.fmts.length) { a.dyFormats = r.fmts; window.__dyFormats = r.fmts; }
      return true;
    }
  } catch (_) {}
  return false;
}

// ★2026-08-24 修复（用户实测「点卡片→显示图片不是视频」根因闭环）：
//   抖音视频侧栏无法独立解码（CDN 防盗链 + MSE blob + CORS），但【源页 <video> 当前帧】
//   可在 MAIN 世界用 canvas.drawImage 截取（同源 MSE blob 视频，canvas 可读不污染）→ 不受防盗链限制。
//   方案：侧栏每隔 ~400ms 经 chrome.scripting 在【源页 MAIN 世界】截取当前播放 <video> 帧（dataURL），
//   写入 previewImg.src → 侧栏显示「源页视频实时画面」（动态预览），即用户要求的「当前网页播放的内容画面」。
//   相比静态封面图，这是真正的视频帧流，能看到画面在动。源页主播放器继续播（不暂停/不跳页）。
//   停止：切卡片/关预览时 stopDouyinFrameStream 清 timer。
// ★2026-08-24 实现（WebRTC 真实流畅预览，替代 400ms 抽帧 base64 卡顿方案）：
//   侧栏为接收端：RTCPeerConnection.ontrack → previewVideo.srcObject = remoteStream 播放（30fps 流畅）。
//   源页 MAIN world 为发送端（见 inject-main.js 末尾）：canvas.captureStream(30) → addTrack → offer。
//   信令经 background 中转（HMDAO_FS_*）：侧栏↔源页，本地 loopback 无需 STUN/TURN。
let __dyFramePC = null;
let __dyFrameTabId = null;
let __dyFrameOnMsg = null;
let __dyFrameTimeout = null;
function stopDouyinFrameStream() {
  if (__dyFrameTimeout) { try { clearTimeout(__dyFrameTimeout); } catch (_) {} __dyFrameTimeout = null; }
  if (__dyFrameOnMsg) { try { chrome.runtime.onMessage.removeListener(__dyFrameOnMsg); } catch (_) {} __dyFrameOnMsg = null; }
  if (__dyFramePC) { try { __dyFramePC.close(); } catch (_) {} __dyFramePC = null; }
  if (__dyFrameTabId != null) {
    try { chrome.runtime.sendMessage({ type: 'HMDAO_FS_STOP', from: 'panel', tabId: __dyFrameTabId }); } catch (_) {}
  }
  __dyFrameTabId = null;
  const pv = document.getElementById('previewVideo');
  if (pv) { try { pv.pause(); } catch (_) {} try { pv.srcObject = null; } catch (_) {} try { pv.removeAttribute('src'); } catch (_) {} try { pv.load(); } catch (_) {} pv.style.display = 'none'; }
  // ★2026-08-24 切卡时也彻底隐藏封面图，避免旧卡封面与新卡 video 流并存（用户截图实证"工程车+西瓜小男孩"）
  const pvImg = document.getElementById('previewImg');
  if (pvImg) pvImg.style.display = 'none';
}
async function startDouyinFrameStream(pv, a) {
  stopDouyinFrameStream();
  if (!pv) return;
  // 确定源页 tabId（优先 __hmdao_sourceTabId → 资产自带的 __sourceTabId → active tab）
  let tid = (typeof window.__hmdao_sourceTabId === 'number') ? window.__hmdao_sourceTabId : null;
  // ★2026-08-31 修复（"预览显示别 tab 的图/视频"根因闭环）：
  //   window.__hmdao_sourceTabId 从未被赋值、且 chrome.tabs.query({active:true}) 在多窗口/侧栏焦点切换时
  //   极易猜到错的抖音标签（如打开过直播/合集其他集的标签），导致：
  //   (1) executeScript 从错的标签读 curFirstFrame → 兜底图与卡片源视频不一致；
  //   (2) WebRTC 协商从错的标签拉流 → 侧栏播放的是别视频的内容。
  //   修复：优先用资产自带的 __sourceTabId（scan.js 在 SCAN_RESULT 广播前写入），
  //   这是【这张卡真正产生于】的标签，比 active tab 准一个数量级。先 chrome.tabs.get 校验存活再使用。
  if (tid == null && a && typeof a.__sourceTabId === 'number') {
    try { const t = await chrome.tabs.get(a.__sourceTabId); if (t && t.id != null) tid = t.id; } catch (_) {}
  }
  if (tid == null) { try { const t = await chrome.tabs.query({ active: true, currentWindow: true }); tid = t && t[0] && t[0].id; } catch (_) {} }
  if (tid == null) { setStatus('无法确定源页标签，无法启动预览流', false); return; }
  __dyFrameTabId = tid;
  // 立即显示封面兜底（WebRTC 协商期间不空白）
  const pvImg = document.getElementById('previewImg');
  // ★2026-08-24 修复：启动协商前 PV 保持隐藏（stopDouyinFrameStream 已彻底清理 srcObject + load），
  //   避免 srcObject 为空时浏览器显示 video 的"最后一帧"与新封面并存（用户截图实证"工程车+西瓜小男孩"）。
  //   只在 pc.ontrack 真正收到流后才 pv.style.display = ''（line 168 那里设）。
  try {
    pv.style.display = 'none';
    const [r0] = await chrome.scripting.executeScript({
      target: { tabId: tid }, world: 'MAIN',
      func: () => {
        try {
          const caps = window.__hmdao_captures;
          if (!caps) return '';
          const f = caps.curFirstFrame;
          if (f && f.dataUrl) return f.dataUrl;     // 视频首帧快照（最贴合当前画面）
          if (f && f.coverUrl) return f.coverUrl;   // 当前视频封面（poster）
          if (caps.curCover) return caps.curCover;  // 当前播放视频封面（兜底）
          return '';
        } catch (_) { return ''; }
      },
    });
    const d0 = r0 && r0.result;
    if (pvImg) {
      if (d0) { pvImg.src = d0; pvImg.style.display = ''; }
      // ★2026-08-31 修复：curFirstFrame 缺失时，用资产正确封面兜底（来源已修正为播放器 DOM 当前视频封面），
      //   避免预览区空白或停在推广图上；用户至少能看到"与源视频对应"的缩略图。
      else if (a && a.cover) {
        // ★2026-09-01 防御性修复：复用 safeSetPvImgCover（独立函数 + 5 用例真实执行测试）
        //   先清 src + 隐藏，relay 成功才显示，绝不直连任何远程 URL。
        const coverUrl = Array.isArray(a.cover) ? (a.cover[0] || '') : (a.cover || '');
        safeSetPvImgCover(pvImg, coverUrl, window.__sourcePageUrl);
      }
    }
  } catch (_) {}
  // 侧栏 RTCPeerConnection（本地 loopback）
  const pc = new RTCPeerConnection({ iceServers: [] });
  __dyFramePC = pc;
  pc.ontrack = (e) => {
    try { clearTimeout(__dyFrameTimeout); } catch (_) {}
    if (e && e.streams && e.streams[0]) {
      console.log('[HMDAO][fs] panel pc.ontrack → 收到源页视频流，写入 pv.srcObject');
      try { pv.srcObject = e.streams[0]; pv.style.display = ''; pv.play().catch(() => {}); } catch (_) {}
      if (pvImg) pvImg.style.display = 'none'; // 收到流后隐藏封面，显示 video
      setStatus('✅ 源页实时预览流已连接（WebRTC 真帧播放）', true);
    }
  };
  pc.onicecandidate = (e) => { if (e && e.candidate) chrome.runtime.sendMessage({ type: 'HMDAO_FS_ICE', from: 'panel', tabId: tid, candidate: e.candidate }).catch(() => {}); };
  // 信令监听（源页上行 offer/ice）
  __dyFrameOnMsg = (msg) => {
    // ★2026-08-24 修复：background 现在会双向转发 HMDAO_FS_*，所以侧栏自己 panel→page 的 ICE/ANSWER 也会广播回自己。
    //   必须严格过滤只接收源页（msg.from === 'page'）的消息，避免侧栏把 panel 自己的 ICE 又 addIceCandidate 给自己造成死循环/重复协商。
    if (!msg || !/^HMDAO_FS_/.test(msg.type) || msg.from !== 'page') return;
    if (msg.type === 'HMDAO_FS_OFFER') {
      console.log('[HMDAO][fs] panel 收到 HMDAO_FS_OFFER，开始 answer 协商');
      pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp })
        .then(() => pc.createAnswer())
        .then((ans) => pc.setLocalDescription(ans))
        .then(() => { chrome.runtime.sendMessage({ type: 'HMDAO_FS_ANSWER', from: 'panel', tabId: tid, sdp: pc.localDescription.sdp, type: 'answer' }).catch(() => {}); })
        .catch(() => {});
    } else if (msg.type === 'HMDAO_FS_ICE') {
      if (msg.candidate) pc.addIceCandidate(msg.candidate).catch(() => {});
    } else if (msg.type === 'HMDAO_FS_ERROR') {
      setStatus('源页预览流启动失败：' + (msg.error || '') + '，已显示封面兜底', false);
    }
  };
  chrome.runtime.onMessage.addListener(__dyFrameOnMsg);
  // 发启动指令给源页 MAIN world
  chrome.runtime.sendMessage({ type: 'HMDAO_FS_START', from: 'panel', tabId: tid }).catch(() => {});
  console.log('[HMDAO][fs] panel 发 HMDAO_FS_START → tabId=' + tid);
  setStatus('▶ 正在建立源页实时预览流…（WebRTC 30fps 真实播放）', true);
  // ★2026-08-31 修复（"点击视频卡显示图片"根因）：源页 inject-main 未就绪 / HMDAO_FS_START 无响应时，
  //   WebRTC 永远连不上，预览永久停在静态封面图（被误以为"显示图片"而非在播视频）。
  //   加连接超时：4.5s 内未收到 ontrack → 明确提示"在源页播放"，封面常显（缩略图即当前视频），不误导。
  __dyFrameTimeout = setTimeout(() => {
    try {
      const pvStill = document.getElementById('previewVideo');
      if (pvStill && pvStill.style.display === 'none') {
        setStatus('⚠ 源页实时预览流连接超时（源页可能未激活播放或未注入采集脚本）。缩略图所示即当前视频；点「在源页播放」继续观看。', true);
      }
    } catch (_) {}
  }, 4500);
}

// ★2026-08-24 修复（用户实测「点击卡片没视频」根因）：
//   抖音 douyinvod CDN 直链带 dy_q 签名+防盗链，侧栏 <video> 直连与后台 fetchMediaViaBackground
//   带 Referer 均返回 403/404（见日志 v26-web.douyinvod.com / douyinstatic 404）→ 侧栏【无法播放】视频字节。
//   旧逻辑失败时 pv.removeAttribute('src') → 侧栏预览区黑屏 → 用户感知「卡片没视频」。
// ===== 视频预览 =====
function renderPreviewVideo(a) {
  // YouTube 视频：不再用 iframe embed（chrome-extension:// origin 导致 Error 153），
  // 改为从 ytBytes 读取播放器真实字节 → 强制 video/mp4 MIME → 直接播放；
  // 若 UMP 解码失败 → mp4box.js 转码为标准 MP4 → 兜底"在源页预览"链接。
  // 流程：isCdnProtected 命中 → HMDAO_REFRESH_FROM_PAGE → fallbackCdnFetch → ytBytes → play/remux
  {
    // ★2026-09-11 修复（liblib 等 MSE 站点的"假卡"点击无反应根因）：
    //   若扫描阶段漏网，把 blob:/data: URL 视频资产带进了侧栏，点击预览时直接提示用户
    //   这是无效卡，并阻止后续黑屏/控制台报错。
    if (/^blob:/i.test(a.url || '') || /^data:/i.test(a.url || '')) {
      const vid = document.getElementById('previewVideo');
      if (vid) vid.style.display = '';
      setStatus('⚠ 此视频源无效：源页使用 MSE blob 流，未暴露真实直链。请在源页播放或重新扫描。', true);
      return;
    }
    const isStream = /[/.](m3u8|mpd)(\?|&|$)/i.test(a.url); // 你酷 m3u8 流前面是 `/` 不是 `.`，必须都识别
    const isCdnProtected = /bilibili\.com|youku\.com|vzuu\.com|v\.qq\.com|iqiyi\.com|youku\.com|cctv\.com|sohu\.com|mgtv\.com|bytedance|akamaized|cloudfront|alicdn|tiktok|migu\.cn|douyin|douyinvod|weixin|qq\.com|googlevideo|youtube|xinpianchang/i.test(a.url)
                          || /bilibili\.com|youku\.com|vzuu\.com|v\.qq\.com|iqiyi\.com|douyin|weixin|youtube|xinpianchang/i.test(window.__sourcePageUrl || '')
                          || isYtDlpPlatform(a); // yt-dlp 平台统一走后台解析/拉流，避免直链签名过期或缺 Referer
    const vid = document.getElementById('previewVideo');
    vid.style.display = '';
    window.__mergedDashBlobUrl = null;
    // ★2026-09-10 防御：清空上一卡遗留的 onerror 处理，避免误触发到本卡
    try { vid.onerror = null; } catch (_) {}
    // 优先走 hls.js 处理流媒体
    if (isStream && window.Hls && Hls.isSupported()) {
      const hls = new Hls();
      hls.loadSource(a.url);
      hls.attachMedia(vid);
      window.__hlsInstance = hls;
      setStatus('流媒体播放中（m3u8/mpd）', true);
    } else if (isCdnProtected) {
      // ★2026-08-23 修复（"抖音视频侧栏不能播放"真凶）：抖音 CDN 直链带 dy_q 签名+防盗链，
      // 侧栏 <video> 直连与后台 fetchMediaViaBackground 带 Referer 均返回 403（见日志 v26-web.douyinvod.com 403）。
      // 抖音视频在侧栏内**无法播放**，唯一可靠路径 = 切到抖音源页播放。
      // 故抖音视频（有 awemeId 或 playerUrl）点击预览时**直接切源页播放**，不再尝试侧栏 fetch（必 403 黑屏）。
      const isDouyin = /douyin\.com|douyinvod|v26-web|bytedance|tiktok/i.test(a.url || '') || (a.platform === 'douyin');
      // ★2026-08-25 修复（抖音卡点击无 url/黑屏真凶）：旧逻辑要求 (a.awemeId || a.playerUrl || a.modalId) 全空时
      //   落到 B站分支 → 抖音 CDN 直链 403 → 黑屏/无素材。但 RENDER_DATA 解析失败时这些字段常为 ''，
      //   而【源页实时帧流 startDouyinFrameStream 不依赖 awemeId】——它直接从源页 <video> 当前帧抓流。
      //   故只要是抖音视频，无条件走抖音分支（源页帧预览），不再要求 awemeId 必填。
      if (isDouyin) {
        // ★2026-09-01 修复（"视频卡没视频播放"根因）：
        //   旧逻辑：只启 startDouyinFrameStream(WebRTC)，依赖源页 <video> 主播放器【正在播放】——
        //   跨域 canvas + MSE blob captureStream 极易抛错、WebRTC 协商经常失败、用户未主动播视频时彻底
        //   收不到流 → 4.5s 超时仅 setStatus 提示，previewVideo 仍 display:none → 用户看到"什么都没"。
        //   改：【双路径并行】，哪个先成功用哪个——
        //     路径 1：startDouyinFrameStream（WebRTC 帧流，源页正在播时最优体验）
        //     路径 2：fallbackCdnFetch（侧栏.js:3832 抖音分支含 playInSourceTab + fallbackCdnRefetch：
        //              源页继续播【绝不暂停】，同时后台带 Referer+Cookie 拉字节→ blob → vid.src 播放，
        //              真正能让侧栏播画面）
        //   两条路径独立：WebRTC 失败也有 fallback 兜底；fallback 失败也有 WebRTC 兜底。
        // ★2026-09-02 B 方案（用户选定）：侧栏真正的 <video> 播放，且【完全不干预源页】。
        //   为何前端拉字节此路不通（实测铁证）：
        //     douyinvod.com 相对 douyin.com 跨域，且 CDN 不返回 CORS 头，
        //     源页 MAIN fetch 与 SW fetch 均抛 "Failed to fetch"（background.js:2206 日志）。
        //     → 前端补 Referer / dNR 都无解，这是 CORS 限制而非防盗链。
        //   故改走【本机后端 /api/media-proxy】代拉：
        //     · hmdao-api.mjs:831-834 已确认会设置 upstreamHeaders.Referer
        //     · 服务端 fetch 无 CORS 限制、Referer 可自由设置 → 必定拿到真实视频字节
        //   边界（严格遵守）：
        //     1) 仅在 isDouyin 分支内，B站/YouTube/花瓣等平台一行未动
        //     2) 后端未启动或失败 → 静默回退原有双路径，绝不会比改动前更差
        //     3) 成功时不碰源页任何元素（不 play / 不暂停 / 不跳转）
        (async () => {
          // ★2026-09-03 修复（合集多集数预览对不上当前集）：
          //   优先用本卡片专属的 a.url（扫描阶段按 awemeId 填入的直链，也是下载实际使用的 URL），
          //   只有 a.url 为空时才回退到 a.downloadAddr（源页当前播放集的新鲜直链）。
          //   这样「预览看到的内容」与「下载下来的内容」是同一集，不再被自动播放的下一集覆盖。
          const target = String(a.url || a.downloadAddr || '');
          if (!target) { startDouyinFrameStream(vid, a); return; }
          // ★2026-09-04 修复（用户实测：点卡片 4~5 分钟才出声音、没画面）：
          //   旧逻辑 fetchDouyinBytesViaBackend 把整个视频(常 50MB+)整段 arrayBuffer 拉回再 blob 播放，
          //   浏览器须等「完整下载」才起播 → 大文件要等数分钟。
          //   实测后端 /api/media-proxy(hmdao-api.mjs:826/864) 已完整支持 HTTP Range：
          //   转发 Range + 回传 Accept-Ranges/Content-Range。故侧栏 <video> 直接把 media-proxy
          //   当 src，浏览器自动发 Range 分段请求 → 边下边播，几秒内出画面/声音。
          //   不再走「整段 blob」慢路径；仅当 media-proxy 加载失败时回退到 blob 兜底。
          const proxySrc = 'http://127.0.0.1:3000/api/media-proxy?url=' + encodeURIComponent(target)
            + '&referer=' + encodeURIComponent('https://www.douyin.com/');
          let fellBack = false;
          const tryBlobFallback = () => {
            if (fellBack) return;
            fellBack = true;
            fetchDouyinBytesViaBackend(target).then((bytes) => {
              if (bytes && bytes.byteLength > 0) {
                try {
                  const blob = new Blob([bytes], { type: 'video/mp4' });
                  const objUrl = URL.createObjectURL(blob);
                  if (typeof cacheDragBlob === 'function') { try { cacheDragBlob(a, blob, 'video/mp4'); } catch (_) {} }
                  vid.src = objUrl; vid.load(); vid.play().catch(() => {});
                  setStatus('⚠ 媒体代理流式失败，已回退整段拉取（较慢）');
                } catch (_) { startDouyinFrameStream(vid, a); }
              } else { startDouyinFrameStream(vid, a); }
            }).catch(() => startDouyinFrameStream(vid, a));
          };
          vid.addEventListener('error', tryBlobFallback, { once: true });
          vid.src = proxySrc;
          vid.load();
          const p = vid.play();
          if (p && p.catch) p.catch(() => {});
          setStatus('✅ 本机后端流式代理播放中（边下边播，源页不受影响）');
          // 保险：若 8s 内仍无数据（代理未起/网络差），自动回退 blob 兜底，避免一直黑屏。
          setTimeout(() => { if (vid.readyState < 2 && !fellBack) tryBlobFallback(); }, 8000);
          return;
        })();
        // ★2026-08-23 实测修复（用户痛点：点卡片→抖音暂停 / 卡片无视频数据 / URL 不更新）：
        //  1) 旧逻辑 switchDouyinEpisodeTo 会 tabs.update 跳源页 → 中断当前播放（用户感知为暂停）。
        //     改为【绝不主动跳源页/刷新】，源页主播放器继续播，侧栏只承担"选中+同步URL+显示当前直链"。
        //  2) 实时从 inject-main 取【当前播放真实直链】写入 a.url（卡片 URL 同步），优先用 curAwemeId 匹配的那条。
        //  3) 侧栏预览尝试 fetchMediaViaBackground 拉字节播（绕过 CDN 403）；若仍 403，显示当前直链+提示源页观看，但不跳页。
        console.log('[HMDAO][pv] 抖音分支: a.url=%s awemeId=%s modalId=%s playerUrl=%s', a.url, a.awemeId, a.modalId, a.playerUrl);
        syncDouyinCurrentUrl(a).then((synced) => {
          if (synced) {
            // 同步刷新列表卡片上的真实直链行（用户要求"卡片上同步当前获取的 url"）
            if (a.__urlRow) { a.__urlRow.textContent = truncate(a.url, 46); a.__urlRow.title = a.url || ''; }
          }
        });
        // 显示「在源页播放」按钮（fallback 成功则侧栏播放，否则源页主播放器承担）。
        try { if (typeof showSourcePlayButton === 'function') showSourcePlayButton(a, a.awemeId, a.playerUrl); } catch (_) {}
        setStatus('▶ 抖音预览加载中（WebRTC + 后台字节 双路径，哪个先成功用哪个）', true);
        return;
      }
      // 关键修复：B站等视频在侧栏里扫描到的是 MSE blob，直接 fetch/播放都跨源失败 → 预览黑屏。
      // 改为「预览时自动从源页 WBI 取真实 CDN 直链」再播放：
      //  · 整段 MP4（≤720p 含音画）：<video src> 直接播，Referer 由网络层 declarativeNetRequest 规则注入
      //  · DASH 分离轨（1080p+）：先播视频轨，再用 mp4box.js+mp4-muxer 合并音视频为单文件 MP4
      setStatus('正在从源页获取直链…');
      chrome.runtime.sendMessage({ type: 'HMDAO_REFRESH_FROM_PAGE', assetUrl: a.url }).then((r) => {
        if (r && r.ok && r.url) {
          if (typeof r.url === 'string') {
            if (r.url.startsWith('blob:')) { fallbackCdnFetch(a, vid); return; }
            // 防盗链直链：侧栏 <video> 直连缺 Referer/Cookie → 403。
            // 必须走后台 fetch（带 Referer+Cookie+dNR）→ blob 播放。
            // YouTube: googlevideo 需 youtube 会话 Cookie
            // 抖音/视频号: douyinvod/weixin 需平台 Referer
            // B站 durl: bilivideo CDN 实测可无 Referer 直连 → 直接 vid.src
            if (/googlevideo\.com|youtube\.com|douyin|douyinvod|tiktok|bytedance|weixin|qq\.com/i.test(r.url)) { fallbackCdnFetch(a, vid); return; }
            window.__previewAsset = { ...a, url: r.url };
            vid.src = r.url; vid.load(); vid.play().catch(() => {});
            setStatus('✅ 直链已就绪（Referer 已注入），点击播放');
          } else if (r.url && r.url.__dash) {
            startDashPreview(a, vid, r.url);
          }
        } else {
          fallbackCdnFetch(a, vid);
        }
      }).catch(() => fallbackCdnFetch(a, vid));
    } else if (isStream) {
      // ★2026-08-31（边界要求"不得引发控制台报错"）：直连兜底时加 crossOrigin='anonymous'
      //   → 媒体请求不带 cookie → 避免 Chrome "Third-party cookie will be blocked" 警告。
      try { vid.crossOrigin = 'anonymous'; } catch (_) {}
      vid.src = a.url;
      setStatus('当前浏览器不支持 HLS 流播放，m3u8 仅得到播放列表文件', true);
      vid.onerror = () => { if (vid.readyState === 0) setStatus('⚠ 此视频无法在侧栏预览：直链可能已失效或需源页鉴权，请到源页观看/下载。', true); };
    } else {
      try { vid.crossOrigin = 'anonymous'; } catch (_) {}
      vid.src = a.url;
      vid.onerror = () => { if (vid.readyState === 0) setStatus('⚠ 此视频无法在侧栏预览：直链可能已失效或需源页鉴权，请到源页观看/下载。', true); };
    }
    buildVideoAltResolutions(a);
    // yt-dlp 平台：额外拉取格式列表支持分辨率选择
    // ★2026-08-18 修复：新片场（stock./www.xinpianchang.com）直链由 tryXinpianchang 在源页解析，
    //   不走后端 yt-dlp（XinpianChang extractor 不支持 stock. 子域），否则会 spawn 出 yt-dlp.exe 窗口且解析失败。
    //   故排除 xinpianchang，预览走上方 fallbackCdnFetch 的 tryXinpianchang 分支。
    // ★2026-08-18 抖音优化（B）：抖音精选页扫描时已用 RENDER_DATA 解析出 a.dyFormats 多质量直链，
    //   预览走 isCdnProtected→HMDAO_REFRESH_FROM_PAGE→fallbackCdnFetch（带 Referer 拉字节）即可，
    //   无需再调后端 yt-dlp（抖音 extractor 需登录 Cookie，且会 spawn onefile 弹窗）。
    //   故抖音有 dyFormats 时跳过 fetchPlatformFormats，直接显示 RENDER_DATA 画质选择器。
    const isDouyinWithFormats = /douyin\.com|douyinvod|v26-web|bytedance/i.test(a.url || '') && a.dyFormats && a.dyFormats.length;
    if (isYtDlpPlatform(a) && !/xinpianchang\.com/i.test(a.playerUrl || a.url || window.__sourcePageUrl || '') && !isDouyinWithFormats) fetchPlatformFormats(a);
    // 抖音：显示 RENDER_DATA 提取的多质量/编码版本
    if (a.dyFormats && a.dyFormats.length) buildDyFormatSelector(a.dyFormats);

    // ★2026-08-21 修复:抖音 DASH 分轨视频常见「无声播放」——视频轨和音轨是独立 m4s,扩展后台
    //   fetch 字节时通常只拉到视频轨(音轨走单独的 audio m4s,需 MSE 合并),即使 vid.src 加载成功也没声音。
    //   在加载完成后检测 audioTracks 为空 → previewInfo 顶部加可读提示,告诉用户「无声是平台防盗链导致,
    //   下载完整版或侧边栏预览到浏览器内播放才有完整音画」。
    try {
      vid.addEventListener('loadedmetadata', () => {
        try {
          const audios = (typeof vid.audioTracks !== 'undefined') ? vid.audioTracks : null;
          const audioCount = audios ? audios.length : 1; // audioTracks 不支持时假设有音轨(避免误报)
          // 抖音特定检测:vid.audioTracks undefined 时,记录到该 url 的"无声"标记,通过 __hmdao_recentPreviewed 检测 loadingcomplete 后尝试匹配。
          const isDouyinCdn = /douyin|bytedance|douyinvod|tiktok/i.test(a.url || '');
          if (isDouyinCdn && (audios && audioCount === 0)) {
            appendPreviewWarn('⚠ 抖音 DASH 流分轨,音频轨需平台单独拉取,此处只见画面无声音。<br>完整版请下载或 <a href="' + escapeAttr(a.url || '') + '" target="_blank" style="color:#7cc4ff">在源页播放</a>。');
          }
        } catch (_) {}
      }, { once: true });
    } catch (_) {}
  }
}

function appendPreviewWarn(html) {
  const info = document.getElementById('previewInfo');
  if (!info || !html) return;
  const cur = info.innerHTML;
  if (cur.indexOf('DASH 流分轨') >= 0) return; // 已有
  info.innerHTML = cur + '<br><span style="color:#ffaa55;font-size:12px">' + html + '</span>';
}

// ===== 音频预览 =====
function renderPreviewAudio(a) {
  // 以「源页身份」拉取带登录态的字节，用侧栏 <audio> 播放（手势有效）
  document.getElementById('pvPlay').style.display = '';
  // 转 MP3 按钮：仅在转码模块可用时显示（可插拔 —— 模块没加载就当它不存在）
  const toMp3 = document.getElementById('pvToMp3');
  try {
    if (toMp3 && typeof transcodeAudioToMp3 === 'function') {
      toMp3.style.display = '';
      toMp3.onclick = () => { transcodeAudioToMp3(a); };
    } else if (toMp3) {
      toMp3.style.display = 'none';
    }
  } catch (_) {}
  playAudioInPage(a, { visual: true });
}

// ===== 3D 模型预览 =====
function renderPreviewModel(a) {
  document.getElementById('previewModelName').textContent = fileName(a.url);
  document.getElementById('previewModelUrl').textContent = a.url;
  document.getElementById('previewModel').style.display = '';
  window.__previewAsset = a; // previewModel3D 里的竞态检查需要先设好
  previewModel3D(a); // 异步：可渲染格式进 Three.js 视口，专有格式显示说明
}

// ===== 归档 / 网盘预览 =====
function renderPreviewArchive(a) {
  document.getElementById('previewNetdisk').style.display = 'none';
  document.getElementById('previewArchiveName').textContent = fileName(a.url);
  document.getElementById('previewArchiveUrl').textContent = a.url;
  document.getElementById('previewArchive').style.display = '';
  window.__previewAsset = a;
  previewArchiveEntries(a); // 异步：zip 列出内部文件清单
}

// ===== 文档预览（pdf/doc/ppt 等：直接链接打开 + 下载）=====
function renderPreviewDocument(a) {
  // 隐藏其它预览区块
  ['previewNetdisk', 'previewArchive', 'previewModel'].forEach((id) => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
  const card = document.getElementById('previewDocument');
  if (!card) { // 兜底：无专用区块则用网盘区块展示基本信息
    document.getElementById('previewNetdisk').style.display = '';
    document.getElementById('previewNetdiskName').textContent = (a.title || fileName(a.url)) + ' · 文档';
    document.getElementById('previewNetdiskUrl').textContent = a.url;
    window.__previewAsset = a;
    return;
  }
  card.style.display = '';
  document.getElementById('previewDocumentName').textContent = (a.title || fileName(a.url));
  document.getElementById('previewDocumentUrl').textContent = a.url;
  const openBtn = document.getElementById('previewDocumentOpen');
  if (openBtn) openBtn.onclick = () => window.open(a.url, '_blank', 'noopener');
  window.__previewAsset = a;
}

// ===== 网盘（渲染可折叠文件树 + 下载）=====
function renderPreviewNetdisk(a) {
  // 隐藏归档区块，显示网盘区块
  document.getElementById('previewArchive').style.display = 'none';
  const card = document.getElementById('previewNetdisk');
  card.style.display = '';
  document.getElementById('previewNetdiskName').textContent = (() => { try { return new URL(a.url).host; } catch (_) { return a.url; } })();
  document.getElementById('previewNetdiskUrl').textContent = a.url;
  const treeEl = document.getElementById('pvNetdiskTree');
  treeEl.style.display = '';
  const tree = a.tree && a.tree.length ? a.tree : null;
  if (!tree) {
    treeEl.innerHTML = '<div style="color:#8b949e;padding:6px">尚未解析文件树。点击「深度解析」自动填提取码并读取文件列表（已登录网页版账号可直接下载，无需安装客户端）。</div>' +
      '<button id="pvNetdiskResolveInline" style="margin-top:8px;padding:6px 14px;border-radius:8px;border:1px solid #1a8cff;background:#1a8cff;color:#fff;cursor:pointer;font-size:12px">🔓 深度解析</button>';
    const inlineBtn = document.getElementById('pvNetdiskResolveInline');
    if (inlineBtn) inlineBtn.onclick = () => { if (window.__previewAsset) netdiskResolve(window.__previewAsset); };
    return;
  }
  treeEl.innerHTML = '<div style="color:#8b949e;padding:4px 6px;font-size:12px">共 ' + tree.length + ' 项（' + tree.filter((n) => !n.isDir).length + ' 个文件）</div>';
  const renderNodes = (nodes, depth) => {
    nodes.forEach((n) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:6px;cursor:pointer;margin-left:' + (depth * 14) + 'px';
      row.onmouseenter = () => { row.style.background = '#1c2128'; };
      row.onmouseleave = () => { row.style.background = 'transparent'; };
      const icon = n.isDir ? '📁' : (/(zip|rar|7z|tar\.gz|tgz)$/i.test(n.name) ? '🗜️' : '📄');
      const sizeStr = n.size ? '  <span style="color:#6e7681">' + n.size + '</span>' : '';
      row.innerHTML = '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + icon + ' ' + escapeHtml(n.name) + sizeStr + '</span>';
      if (!n.isDir) {
        const dl = document.createElement('button');
        dl.textContent = '⬇';
        dl.title = '下载 ' + n.name;
        dl.style.cssText = 'background:#238636;color:#fff;border:none;border-radius:6px;padding:2px 7px;font-size:11px;cursor:pointer;flex:none';
        dl.onclick = (e) => {
          e.stopPropagation();
          if (dl.dataset.busy === '1') {
            setStatus('该文件正在请求下载，请勿重复点击', true);
            return;
          }
          dl.dataset.busy = '1';
          dl.textContent = '请求中…';
          dl.style.opacity = '0.6';
          const payload = { name: n.name, hasDirect: !!(n.direct && /^https?:/.test(n.direct)), fileId: n.id || n.fileId || '', parentUrl: a.url };
          panelLog('netdisk-tree-download-click', payload);
          try {
            // ★关键修复：节点有真实直链（direct）时直接用直链下载，不再走分享页/视频面板。
            // 无直链时：用「分享页 URL + #hmdao-file=文件名」作为锚点 URL，并带 parentUrl + fileId，
            // 让 downloadSingle 走 HMDAO_NETDISK_DOWNLOAD 在网盘页内触发下载按钮捕获真实直链。
            const anchorUrl = n.direct || (a.url + '#hmdao-file=' + encodeURIComponent(n.name));
            downloadSingle({ type: 'netdisk-file', url: anchorUrl, name: n.name, direct: n.direct || '', size: n.size, isNetdiskFile: true, parentUrl: a.url, fileId: n.id || n.fileId || '' });
          } catch (err) {
            panelLog('netdisk-tree-download-click-error', String(err && err.message ? err.message : err));
            setStatus('下载按钮异常：' + (err && err.message ? err.message : String(err)), true);
          } finally {
            setTimeout(() => {
              dl.dataset.busy = '0';
              dl.textContent = '⬇';
              dl.style.opacity = '';
            }, 10000);
          }
        };
        row.appendChild(dl);
      } else {
        row.onclick = () => {
          // 子目录：触发深层解析（递归）
          setStatus('正在展开子目录：' + n.name + ' …');
          chrome.runtime.sendMessage({ type: 'HMDAO_NETDISK_TREE', url: a.url, sub: n.name }, (res) => {
            if (res && res.ok && res.tree) { n.children = res.tree; renderNodesSub(res.tree, row, depth + 1); }
            else setStatus('子目录解析失败：' + (res && res.error || '需登录'), true);
          });
        };
      }
      treeEl.appendChild(row);
    });
  };
  const renderNodesSub = (nodes, parentRow, depth) => {
    // 在父行后插入子节点
    const frag = document.createDocumentFragment();
    const tmp = document.createElement('div');
    nodes.forEach((n) => { /* 同 renderNodes 但 append 到 frag */ });
    renderNodes(nodes, depth);
  };
  renderNodes(tree, 0);
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
