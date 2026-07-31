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

// 扫描单个标签页：深度直链解析（B：网络层捕获 + MAIN 世界直链 + YouTube 缓冲补全） + 页面 DOM 解析（A）。
// 合并去重后回写 NETWORK_ASSETS 并广播 SCAN_RESULT 给侧栏。
async function scanTab(tabId, opts = {}) {
  const deep = opts.deep !== false; // 默认深度：首扫跑各站直链主动解析（B），轮询走轻量
  let networkAssets = [];
  let ytPlay = [];

  // 读取 MAIN 世界被动捕获（YouTube/抖音/B站/通用音频/3D模型的真实直链）
  const readMainCaptures = async () => {
    try {
      const injected = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: readAllCapturesMAIN,
      });
      const mainRes = injected && injected[0] && injected[0].result;
      if (mainRes) {
        if (Array.isArray(mainRes.videoPlays)) networkAssets.push(...mainRes.videoPlays);
        if (Array.isArray(mainRes.audioPlays)) networkAssets.push(...mainRes.audioPlays);
        // ★修复：抖音 MAIN 世界已捕获的 CDN 直链（dyUrls）此前没回传 → 抖音视频采不到。
        // 这里并入 networkAssets，合并阶段按 type==='video' 智能保留（不再被 VIDEO_HOST_RE 误杀）。
        if (Array.isArray(mainRes.dyUrls)) networkAssets.push(...mainRes.dyUrls.map((u) => ({ url: u, type: 'video', source: 'douyin' })));
        // ★扩展（2026-08-01）：接口响应体视频直链（liblib 等动态视频站点）
        if (Array.isArray(mainRes.apiVideos)) networkAssets.push(...mainRes.apiVideos.map((u) => ({ url: u, type: 'video', source: 'api-video' })));
        if (Array.isArray(mainRes.ytPlay)) ytPlay.push(...mainRes.ytPlay);
      }
    } catch (e) {
      console.warn('[HMDAO][scan] readAllCapturesMAIN 注入失败（普通网页无 MAIN 捕获属正常）：', e && e.message);
    }
  };
  await readMainCaptures();

  const n = NETWORK_ASSETS[tabId] || [];
  const netAssets = n.filter((a) => a && /googlevideo\.com\/videoplayback/.test(a.url));
  if (netAssets.length) networkAssets.push(...netAssets.map((a) => ({ url: a.url, type: 'video', source: 'youtube' })));

  // 主动扫描时若 YouTube 直链为空，或抖音/B站有 <video> 但 dyUrls 为空（用户无操作未播放），
  // 静音缓冲 1.5s 触发播放器发请求，让 MAIN 世界拦截器捕获真实直链（打开页即扫描也能采到）。
  const needBuffer = ytPlay.length === 0 && (networkAssets.length === 0 || !networkAssets.some((a) => a.type === 'video'));
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

  let pageAssets = [];
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: scanPage,
      args: [networkAssets],
    });
    pageAssets = (res && res[0] && res[0].result) || [];
    console.log('[HMDAO][scan] DOM 解析产出', pageAssets.length, '条素材（含图片/视频/音频/3D模型/下载链接）');
  } catch (e) {
    console.warn('[HMDAO][scan] scanPage 注入/执行失败（tab 未就绪或不可脚本化）：', e && e.message);
  }

  // ★P0 回归修复：扫描阶段必须跑深度直链解析（extractFreshVideoUrl）。
  // 重构前 scanTab 直接调用它产出视频；重构后该函数仅剩 REFRESH_FROM_PAGE（点击刷新）才触发，
  // 导致打开任意视频站页面、首扫/轮询都采不到视频（DOM 只读到 blob: MSE 源，无真实直链）。
  // 这里【始终】调用（首扫与轮询都跑）：它是视频站采集的唯一来源，不跑则视频永远缺失。
  // 成本可控——extractFreshVideoUrl 优先读页面已就绪的全局（__playinfo__/__INITIAL_STATE__/拦截捕获），
  // 不发请求；仅兜底 WBI playurl 才发一次 API，且 inject-main 已常态拦截播放器请求。
  let deepVideoAssets = [];
  if (typeof extractFreshVideoUrl === 'function') {
    try {
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
        }
      }
      console.log('[HMDAO][scan] 深度直链解析产出', deepVideoAssets.length, '条视频/音频');
    } catch (e) {
      console.warn('[HMDAO][scan] extractFreshVideoUrl 注入/执行失败：', e && e.message);
    }
  }

  // ★视频封面采集（供侧栏卡片显示封面图，悬停再抽帧）：
  // 注入 MAIN 世界读页面全局封面（B站 videoData.pic / 抖音 aweme.cover / 通用 <video poster>），
  // 以「视频直链」为键回填给 deepVideoAssets，也让通用 <video poster> 回填到同页视频资产。
  // 注意：deepVideoAssets 的 url 是播放直链（bilivideo CDN 等），与 <video poster> 不是同一 URL，
  // 故 poster 仅做「同页首个视频资产」的兜底封面（优先用页面全局封面键匹配）。
  try {
    const cr = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: extractVideoCovers,
      args: [],
    });
    const coverMap = (cr && cr[0] && cr[0].result) || null;
    if (coverMap && (coverMap.pageCovers && coverMap.pageCovers.length || coverMap.defaultCover)) {
      // 优先：用平台直链/页面全局封面键匹配
      if (coverMap.byKey && Object.keys(coverMap.byKey).length) {
        deepVideoAssets.forEach((dv) => {
          if (!dv.cover) {
            const hit = coverMap.byKey[dv.url] || coverMap.byKey[dv.url && dv.url.split('?')[0]];
            if (hit) dv.cover = hit;
          }
        });
      }
      // 兜底：deepVideoAssets 尚无封面时，用页面默认封面（B站 pic/抖音 cover）补第一个视频资产
      if (!deepVideoAssets.some((d) => d.cover) && coverMap.defaultCover) {
        deepVideoAssets.forEach((d) => { if (!d.cover) d.cover = coverMap.defaultCover; });
      }
      // 通用 <video poster>：回填给同页、且无封面的视频资产（按顺序逐条分配）
      const posters = (coverMap.pageCovers || []).filter((c) => c.kind === 'poster');
      if (posters.length) {
        let pi = 0;
        deepVideoAssets.forEach((d) => {
          if (!d.cover && pi < posters.length) { d.cover = posters[pi].url; pi++; }
        });
      }
      console.log('[HMDAO][scan] 封面采集：byKey', coverMap.byKey ? Object.keys(coverMap.byKey).length : 0,
        'defaultCover', !!coverMap.defaultCover, 'posters', posters.length);
    }
  } catch (e) {
    console.warn('[HMDAO][scan] extractVideoCovers 注入/执行失败（封面功能降级，不影响采集）：', e && e.message);
  }

  // ★修复：networkAssets（MAIN 世界抖音 dyUrls / 通用 audioPlays / 视频平台 videoPlays / 网络层捕获）
  // 此前只写进背景全局 NETWORK_ASSETS 持久化，却从未并入合并列表 → 抖音视频/音效永远采不到。
  // 现在与 ytPlay + pageAssets 一起进入合并（合并段按类型智能保留，不再被 VIDEO_HOST_RE 误杀）。
  const all = [
    ...ytPlay.map((u) => ({ url: u, type: 'video', source: 'youtube' })),
    ...networkAssets,
    ...pageAssets,
    ...deepVideoAssets,
  ];
  const urlSeen = new Set();
  const merged = [];
  // ★修复（断点 A/D/F 共因）：原先 VIDEO_HOST_RE.test(u) 把所有视频平台 URL 整行丢弃，
  // 连带 YouTube/抖音/B站/视频号的真实视频/音频直链、视频平台的动图（qq.com 图床等）一并丢失。
  // 改为按类型智能过滤：媒体/模型/动图直链无论 host 一律保留；仅排除「无明确资源扩展名的页面导航 URL」。
  const RES_EXT_RE = /\.(mp4|webm|mov|m4v|mkv|ogv|m3u8|flv|avi|wmv|ts|mpg|mpeg|3gp|rm|rmvb|asf|vob|m2ts|f4v|m4s|mp3|wav|ogg|aac|m4a|flac|opus|gif|apng|webp|png|jpe?g|bmp|svg|avif|ico|tiff?|glb|gltf|obj|fbx|stl|dae|ply|max|blend|ma|mb|c4d|3ds|skp|wrl|x3d|abc|lwo|smd|vrm)([?#]|$)/i;
  const PAGE_NAV_RE = /^https?:\/\/[^\/]+(\/|$)/; // 仅 host 根路径或空路径（如 youtube.com/watch 这类导航页）
  for (const a of all) {
    const u = (a && a.url || '').split('#')[0];
    if (!u) continue;
    // 媒体/模型/动图直链：无条件保留（即使 host 命中视频平台）
    const isMediaOrModel = a.type === 'video' || a.type === 'audio' || a.type === 'model' || (a.animated === true);
    if (isMediaOrModel) {
      if (urlSeen.has(u)) continue;
      urlSeen.add(u);
      merged.push(a);
      continue;
    }
    // 图片：若 URL 带资源扩展名则保留；否则（裸页面导航 URL）丢弃，避免把视频网站页面当素材
    if (a.type === 'image') {
      if (!RES_EXT_RE.test(u)) continue; // 无扩展名的图片型 URL（多为页面导航）丢弃
      if (urlSeen.has(u)) continue;
      urlSeen.add(u);
      merged.push(a);
      continue;
    }
    // 其他类型（archive/netdisk/link）：保留带扩展名或明确资源的
    if (urlSeen.has(u)) continue;
    urlSeen.add(u);
    merged.push(a);
  }

  NETWORK_ASSETS[tabId] = merged;
  // ★关键修复：侧栏加载时（bulk-actions.js）读取的持久化 key 是 'lastScan'，
  // 此前 scanTab 写的是 'hmdao_scan_${tabId}'，两套 key 不匹配 → 侧栏重启/重载后
  // 只能依赖 SCAN_RESULT 运行时广播；一旦广播因 SW 重启/侧栏加载时序竞态丢失，
  // 侧栏永远为空（真机「采不到」的头号根因）。统一写 'lastScan' 并供 storage.onChanged 实时接收。
  if (deep) {
    try { await chrome.storage.local.set({ lastScan: { assets: merged, tabId, ts: Date.now() } }); } catch (_) {}
  }

  // 扫描结果广播给侧栏（SCAN_RESULT 由 detect.js 转发到页面事件，侧栏监听）
  chrome.runtime.sendMessage({ type: HMDAO_MSG.SCAN_RESULT, tabId, assets: merged }).catch(() => {});
  return merged;
}

// 页面 DOM 解析（注入 ISOLATED 世界运行，禁止引用 background 作用域）。
// networkAssets: 由 background 透传的网络层捕获资产（含 source 字段，供侧栏/测试区分来源）。
function scanPage(networkAssets) {
  let out = [];
  const push = (url, type, source, meta) => {
    if (!url) return;
    // 动图检测：gif/apng/动图 webp 标记 animated，预览直显（不重编码），合并阶段据此免过滤
    let animated = false;
    if (type === 'image') {
      const lower = String(url).toLowerCase();
      if (/\.(gif|apng)(\?|$)/i.test(lower)) animated = true;
      else if (/format=apng|format=gif/i.test(lower)) animated = true;
    }
    let u = String(url).trim();
    if (!/^https?:\/\//i.test(u)) return;
    const item = { url: u, type, source };
    if (animated) item.animated = true;
    if (meta && typeof meta === 'object') Object.assign(item, meta);
    out.push(item);
  };

  // 1) 图片：<img src/currentSrc/srcset> + data-* 属性 + 内联 style background + <picture>
  document.querySelectorAll('img').forEach((img) => {
    const src = img.currentSrc || img.src;
    push(src, 'image', 'img');
    if (img.srcset) {
      img.srcset.split(',').forEach((s) => {
        const u = s.trim().split(/\s+/)[0];
        push(u, 'image', 'img[srcset]');
      });
    }
  });
  document.querySelectorAll('picture source').forEach((s) => push(s.srcset ? s.srcset.split(',')[0].trim().split(/\s+/)[0] : s.src, 'image', 'picture'));
  document.querySelectorAll('[style]').forEach((el) => {
    const st = el.getAttribute('style') || '';
    const m = st.match(/url\(['"]?(https?:\/\/[^'")]+)['"]?\)/i);
    if (m) push(m[1], 'image', 'css-bg');
  });
  document.querySelectorAll('[data-src], [data-original], [data-lazy], [data-bg], [data-image], [data-img], [data-url], [data-pic], [data-thumb], [data-preview]').forEach((el) => {
    ['data-src', 'data-original', 'data-lazy', 'data-bg', 'data-image', 'data-img', 'data-url', 'data-pic', 'data-thumb', 'data-preview'].forEach((k) => push(el.getAttribute(k), 'image', 'img[data]'));
  });
  document.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    if (/\.(jpe?g|png|gif|webp|bmp|svg|avif|ico|tiff?)([?#]|$)/i.test(href)) {
      const img = a.querySelector('img');
      if (img) push(img.currentSrc || img.src, 'image', 'a>img');
      else push(href, 'image', 'a>img');
    }
  });

  // 2) 视频：<video src> + <source> + poster + 属性 + 内联脚本/全局变量
  document.querySelectorAll('video').forEach((v) => {
    push(v.src, 'video', 'video');
    v.querySelectorAll('source').forEach((s) => push(s.src, 'video', 'video>source'));
    if (v.poster) push(v.poster, 'image', 'video[poster]');
  });
  document.querySelectorAll('[data-video], [data-src], [data-mp4], [data-video-src], [data-play]').forEach((el) => {
    ['data-video', 'data-src', 'data-mp4', 'data-video-src', 'data-play'].forEach((k) => push(el.getAttribute(k), 'video', 'video[attr]'));
  });
  // 2.5) 视频直链（含 m3u8 / 直播）：<a href="*.mp4"> 等 + 属性 + 脚本/全局变量
  const VID_RE = /\.(mp4|webm|mov|m4v|mkv|ogv|m3u8|flv|avi|wmv|ts|mpg|mpeg|3gp|rm|rmvb|asf|vob|m2ts|f4v|m4s)([?#]|$)/i;
  document.querySelectorAll('a[href]').forEach((a) => { if (VID_RE.test(a.href)) push(a.href, 'video', 'a[href]'); });
  document.querySelectorAll('*').forEach((el) => {
    el.getAttributeNames().forEach((name) => {
      const v = el.getAttribute(name);
      if (!v || typeof v !== 'string') return;
      const m = v.match(/https?:\/\/[^ "'()]+/i);
      if (m && VID_RE.test(m[0])) push(m[0], 'video', 'attr:' + name);
    });
  });
  document.querySelectorAll('script:not([src])').forEach((s) => {
    const urls = (s.textContent || '').match(/https?:\/\/[^ "'()]+(\.(mp4|webm|mov|m4v|mkv|ogv|m3u8|flv|avi|wmv|ts|mpg|mpeg|3gp|rm|rmvb|asf|vob|m2ts|f4v|m4s)|(\.(mp4|webm|mov|m4v|mkv|ogv|m3u8|flv|avi|wmv|ts|mpg|mpeg|3gp|rm|rmvb|asf|vob|m2ts|f4v|m4s)))([?#]|$)/ig) || [];
    urls.forEach((u) => push(u, 'video', 'script'));
  });
  try {
    ['videoList', 'videos', 'videoData', 'playerData', 'playList', 'playlist', 'videoInfo', 'mediaList', '__VIDEO__'].forEach((k) => {
      const obj = window[k];
      if (!obj) return;
      const urls = JSON.stringify(obj).match(/https?:\/\/[^ "'()]+/g) || [];
      urls.forEach((u) => { if (VID_RE.test(u)) push(u, 'video', 'global'); });
    });
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
    const m = txt.match(/https?:\/\/(www\.)?(youtube\.com\/(watch\?v=|embed\/|shorts\/)|youtu\.be\/|player\.bilibili\.com\/player\.html\?bvid=|www\.bilibili\.com\/video\/|player\.youku\.com\/embed\/|v\.youku\.com\/v_show\/|video\.tudou\.com\/[a-z]\/|v\.qq\.com\/[a-z]+\/|www\.iqiyi\.com\/[a-z0-9_]+\.html|www\.iqiyi\.com\/v_|ixigua\.com\/[0-9]+|www\.sohu\.com\/[a-z]+\/[0-9]+)[^\s"'<>()]+/gi) || [];
    m.forEach(collectEmbedUrl);
  })();
  // 规范化 + 入库。返回 { platform, playerUrl, ... } 或 null。
  // 设计：★先做「白名单特殊规范化」——YT/B站/youku/qq/iqiyi/tudou/西瓜/搜狐 等已知平台，
  // 解析出更干净稳定的播放页 playerUrl（去参数/统一域名），便于 yt-dlp 稳定提取。
  // ★白名单未命中，则做「通用兼容」回退：任何看起来像视频平台播放页的 URL
  // （含已知视频平台域名，或路径含 /embed/ /v_ /v_show/ /video/ 等视频特征）都按
  // generic 平台入库，直接以原始 raw URL 作为 playerUrl 交给 yt-dlp 尝试提取。
  // 这样「未列在白名单的小众/海外平台」也能被采集，特殊平台再走白名单做规范化增强。
  const VIDEO_PLATFORM_HOST_RE = /(youtube\.com|youtu\.be|bilibili\.com|youku\.com|tudou\.com|qq\.com|iqiyi\.com|ixigua\.com|sohu\.com|le\.com|acfun\.cn|1905\.com|mgtv\.com|v\.qq\.com|v\.ku6\.com|kankan\.com|56\.com|fun\.tv|pptv\.com|wasu\.cn|cntv\.cn|bokecc\.com|polyv\.net|qiyi\.com|v\.163\.com|open\.163\.com|vimeo\.com|dailymotion\.com|facebook\.com|twitter\.com|vk\.com|ok\.ru|rutube\.ru|streamable\.com|twitch\.tv|invidious\.|piped\.|peertube|mixcloud\.com|soundcloud\.com|ted\.com|metacafe\.com|break\.com|liveleak\.com|veoh\.com|9cache\.com|bits\.co|bitchute\.com|rumble\.com|odysee\.com|brighteon\.com|v\.douyin\.com|douyin\.com|kuaishou\.com|bilibili\.tv|nicovideo\.jp|dmm\.co\.jp|niconico)/i;
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
      } else if (/(^|\.)youku\.com$/.test(h)) {
        let vid = null;
        if (u.pathname.startsWith('/embed/')) vid = u.pathname.split('/embed/')[1].split('/')[0];
        else { const m = u.href.match(/id_([A-Za-z0-9]+)/); if (m) vid = m[1]; }
        if (vid) return { platform: 'youku', playerUrl: 'https://player.youku.com/embed/' + vid };
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
      if (VIDEO_PLATFORM_HOST_RE.test(h) || VIDEO_PATH_RE.test(u.pathname)) {
        return { platform: 'generic', playerUrl: u.toString() };
      }
    } catch (_) {}
    return null;
  }
  EMBED_SOURCES.forEach((raw) => {
    const info = normalizeEmbedPlatform(raw);
    if (info && info.platform && info.playerUrl) {
      // 以平台播放页 URL 作为 url，便于 isYtDlpPlatform 识别（yt-dlp 支持大量平台，含 generic）。
      const meta = Object.assign({ platform: info.platform }, info.playerUrl ? { playerUrl: info.playerUrl } : {});
      if (info.ytPageUrl) meta.ytPageUrl = info.ytPageUrl;
      if (info.ytVideoId) meta.ytVideoId = info.ytVideoId;
      if (info.biliPageUrl) meta.biliPageUrl = info.biliPageUrl;
      if (info.biliVideoId) meta.biliVideoId = info.biliVideoId;
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
  document.querySelectorAll('*').forEach((el) => {
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
  const NETDISK_RE = /(pan\.baidu\.com\/s\/|lanzou[s]?\.com|lanzaou\.com|quark\.cn|123pan\.com|aliyundrive\.com|weiyun\.com|cowtransfer\.com|ctfile\.com|mediafire\.com|mega\.nz|drive\.google\.com\/file|dropbox\.com\/s|terabox|pcloud)/i;
  document.querySelectorAll('a[href]').forEach((a) => {
    if (NETDISK_RE.test(a.href)) push(a.href, 'netdisk', 'a[href]');
  });
  // 3) 任意元素属性上含模型/归档扩展名的 URL（data-*/data-download-url/data-file/data-model/下载按钮属性等）。
  //    3D 站常把下载地址藏在按钮/div 的属性里，而非 <a href>。
  document.querySelectorAll('*').forEach((el) => {
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
    root.querySelectorAll('img').forEach((img) => push(img.currentSrc || img.src, 'image', 'shadow-img'));
    root.querySelectorAll('video').forEach((v) => push(v.src, 'video', 'shadow-video'));
    root.querySelectorAll('audio').forEach((a) => push(a.src, 'audio', 'shadow-audio'));
    root.querySelectorAll('model-viewer').forEach((m) => push(m.getAttribute('src'), 'model', 'shadow-model'));
    root.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) scanRoot(el.shadowRoot);
    });
  };
  document.querySelectorAll('*').forEach((el) => {
    if (el.shadowRoot) scanRoot(el.shadowRoot);
  });

  // 网络层捕获（引擎加载的 GLB / 音频缓冲 / 视频流）
  // ★透传原始 source（api-capture / audio-playback / youtube 等），不要硬编码覆盖成 'network'，
  // 侧栏与测试依赖 source 区分捕获来源。
  (networkAssets || []).forEach((a) => push(a.url, a.type, (a && a.source) || 'network'));

  // 动态链接自动重扫：站点把下载/网盘/模型链接在「点击按钮」或「接口回调」后才注入 DOM
  // （如 yunqiaonet 登录态）。静态扫描读不到 → 安装 MutationObserver，DOM 新增匹配链接时通知后台去抖重扫。
  try {
    if (!window.__hmdao_mutation_watch) {
      window.__hmdao_mutation_watch = true;
      const RE = /(pan\.baidu\.com\/s\/|lanzou|quark|123pan|aliyundrive|\.(glb|gltf|obj|fbx|zip|rar|7z|max|blend|c4d|dae|ply|3ds|skp|stl|usdz|mp4|webm|mov|mkv|flv|avi|wmv|ts|mpg|3gp)(\?|#|$))/i;
      let _mt = 0;
      const obs = new MutationObserver((muts) => {
        let hit = false;
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (n.nodeType !== 1) continue;
            if (RE.test(n.outerHTML || '')) { hit = true; break; }
            const as = n.querySelectorAll && n.querySelectorAll('a[href]');
            if (as) { for (const a of as) { if (RE.test(a.href)) { hit = true; break; } } }
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
      obs.observe(document.documentElement, { childList: true, subtree: true });
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
        key = u.host + u.pathname; // 抹掉 query/hash 的尺寸参数 → 同图不同尺寸合并
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

  // ★根因 B 修复：原 out.slice(0, 800) 会把排在最后的 3D/归档条目裁掉（图片/视频/音频段先跑，画廊页极易超 800）。
  // 改为：模型/归档/网盘条目永远保留，只在图片/视频/音频里做预算裁剪。
  const CAP = 800;
  if (out.length <= CAP) return out;
  const priority = out.filter((a) => a.type === 'model' || a.type === 'archive' || a.type === 'netdisk');
  const media = out.filter((a) => a.type !== 'model' && a.type !== 'archive' && a.type !== 'netdisk');
  const room = Math.max(0, CAP - priority.length);
  return priority.concat(media.slice(0, room));
}

// 视频封面采集（注入 MAIN 世界运行，自包含，禁止引用 background 作用域）。
// 返回 { byKey:{<video直链>:<封面URL>}, defaultCover:<页面默认封面>, pageCovers:[{kind,url}] }。
// - byKey：优先用平台直链键匹配（B站 playurl 直链↔__INITIAL_STATE__ 封面命中率有限，故主要依赖 defaultCover/pageCovers 兜底）。
// - defaultCover：B站 videoData.pic / 抖音 aweme.cover —— 同页视频资产的最佳封面。
// - pageCovers：页面所有 <video poster> —— 通用站点兜底封面。
function extractVideoCovers() {
  const byKey = {};
  let defaultCover = '';
  const pageCovers = [];
  try {
    // 1) B站封面：window.__INITIAL_STATE__.videoData.pic（已 URL编码，需解码）
    try {
      const ini = window.__INITIAL_STATE__;
      if (ini && ini.videoData && ini.videoData.pic) {
        defaultCover = decodeURIComponent(ini.videoData.pic);
      }
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
          const walk = (o) => {
            if (!o || typeof o !== 'object') return;
            if (Array.isArray(o)) { o.forEach(walk); return; }
            const hasV = o.video && (o.video.play_addr || o.video.download_addr);
            if ((o.aweme_id || hasV) && !chosen) chosen = o;
            if (targetId && String(o.aweme_id) === String(targetId)) chosen = o;
            for (const k in o) { try { walk(o[k]); } catch (_) {} }
          };
          walk(data);
          if (chosen && chosen.video && chosen.video.cover) {
            const cl = (chosen.video.cover.url_list || []);
            if (cl.length) defaultCover = cl[0].replace(/\\\//g, '/');
          }
        }
      } catch (_) {}
    }
    // 3) 通用 <video poster>（含 data-src 兜底）
    document.querySelectorAll('video').forEach((v) => {
      let p = v.getAttribute('poster') || v.poster;
      if (!p && v.dataset) p = v.dataset.poster || v.dataset.cover || v.dataset.thumbnail;
      if (p) {
        try { p = new URL(p, location.href).href; } catch (_) {}
        pageCovers.push({ kind: 'poster', url: p });
      }
    });
  } catch (_) {}
  return { byKey, defaultCover, pageCovers };
}

if (typeof globalThis !== 'undefined') {
  globalThis.scanTab = scanTab;
  globalThis.scanPage = scanPage;
}
