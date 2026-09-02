// MAIN-world 拦截器（由 manifest 以 "world":"MAIN" 注入，浏览器直接执行，不受页面 CSP 限制）
// 早期(document_start)捕获 B站 / YouTube 的 player API 响应，供侧栏下载兜底使用。
// 注意：本文件运行在页面主世界，禁止使用 chrome.* API。
// ===== B站整域熔断（兼容 B站原生播放器 + 规避 B站反扩展白名单提示）=====
// 实测：在 B站视频播放页即便只监听 fetch/XHR 响应，也会因微任务时序变化导致 B站播放器
// 读取 playurl 配置（nc_policy / reward_pcdn_loader_policy）时对象为 undefined，视频加载失败。
// ★2026-08-22 进一步扩展为「整域熔断」：B 站反扩展机制会通过 window.__hmdao* 命名空间 + fetch/XHR 包装
// 识别 MAIN world 注入脚本，在首页/空间/搜索/动态/分区等任何路径下都弹「请加入白名单」提示。
// 真实视频流（bilivideo CDN）由 background.js 的 webRequest 兜底捕获并入 NETWORK_ASSETS，
// 与本页 MAIN world 注入完全解耦，故可在 B 站整域 100% 静默而不损失下载能力。
function __hmdao_isBiliPlayPage() {
  try {
    const h = location.hostname || '';
    return h.endsWith('bilibili.com') || h.endsWith('b23.tv');
  } catch (_) { return false; }
}

// ★抖音/TikTok 播放页熔断（与 model-api-capture.js 的 __hmdao_isDouyinPlayPage 语义统一）：
// 抖音/TikTok 播放器用 fetch/XHR 拉流（MSE + a_bogus/x-bogus 签名，绑定原始请求头），
// 即便注入层只「记录 URL、不消费响应体」，包装 window.fetch 带来的微任务时序变化仍可能
// 干扰其 MSE appendBuffer 时序或被反爬风控捕获，导致「视频无法播放且无声」。
// ★2026-08-23 根因修复（问题1「源页无法流畅播放」+ 问题2/3「抖音采集失效」共同根因）：
//   此前 inject-main.js 在 manifest 仅注入 bilibili/youtube，抖音页【从不运行】本脚本，
//   导致 hmdaoCaptureDyStream / __hmdao_captureFirstFrame / curVideoSrc / curAwemeId 等
//   抖音核心捕获逻辑在抖音页永远空转 —— scan.js / preview-render.js 大量依赖这些字段的
//   「修复」全部失效，只能退化到 RENDER_DATA 静态解析（签名过期/切集错配的根源）。
//   现把抖音域纳入 manifest 注入范围，仅「专属观看页」（路径以 /video/ 开头，如
//   douyin.com/video/<id>）做 100% 熔断（与 model-api-capture 一致，保护原生播放器）；
//   jingxuan?modal_id= / 信息流 / 搜索 / 用户页 等采集主场景正常注入捕获。
function __hmdao_isDouyinPlayPage() {
  try {
    const h = location.hostname || '';
    const p = location.pathname || '';
    if (/(^|\.)douyin\.com$/.test(h) && /^\/video\//.test(p)) return true;
    if (/(^|\.)tiktok\.com$/.test(h) && /^\/video\//.test(p)) return true;
  } catch (_) {}
  return false;
}

// ★2026-08-22 修复（用户截图实证根因：music.douyin.com/studio 扫出 79 视频全同封面）：
// 抖音创作中心 / 通知 / 直播后台等非播放页 DOM 极复杂（含大量 video/海报/img），
// 注入后会从 RENDER_DATA 顶层读出几十条 aweme（无 modal_id 命中 → dyAwemes=unknown），
// 全部走 pageImgFallback 取页面同一张残留封面 → 79 视频全同图、playerUrl 退回 studio 来源页，
// "切到该集播放"/"新标签打开"全部跳回 studio 形成死循环。
// 修复：明确排除以下非播放路径，命中时与 B站同级别 100% 静默。
// 保留：/jingxuan /video/ /search / /follow /user/... 等合法播放/信息流/合集页。
function __hmdao_isDouyinExcluded() {
  try {
    const h = location.hostname || '';
    const p = location.pathname || '';
    // 音乐创作中心子域（整子域排除，截图实证用户在 music.douyin.com/studio 被误注入）
    if (h === 'music.douyin.com') return true;
    // 仅作用于 www/m 抖音主域；其他子域（iesdouyin/tiktok）由 __hmdao_isDouyinPlayPage 控
    if (h !== 'www.douyin.com' && h !== 'm.douyin.com') return false;
    if (/^\/studio(\/|$)/.test(p)) return true;          // 创作中心（含 /studio/contents 等子路径）
    if (/^\/creator(\/|$)/.test(p)) return true;          // 创作者中心
    if (/^\/notice(\/|$)/.test(p)) return true;            // 通知中心
    if (/^\/live\/studio(\/|$)/.test(p)) return true;      // 直播创作后台
  } catch (_) {}
  return false;
}

(function () {
  // ★2026-08-22 修复（98 条错卡根因）：SPA 路由/页面切换会重触发本 IIFE 注入，
  // 但窗口级 __hmdao_captures.dyUrls/dyAwemes 跨页面持续累积（旧 modal/旧搜索页的 CDN
  // 仍驻留数组），导致侧栏扫描时把跨页面的不同 aweme_id 全数 push 入资产表 → 98 张卡片，
  // 全部错配当前 modal 内容。修复：注入前对比「上一注入时的 URL」，变化时清空累积数组，
  // 保证 dyUrls/dyAwemes 仅反映当前页面会话内捕获的 CDN。
  const prevUrl = window.__hmdao_injected_url || '';
  const curUrl = location.href;
  const isFirstInject = !window.__hmdao_installed;
  const isPageChanged = prevUrl && prevUrl !== curUrl;
  // ★首注入且无残留：不主动清空（保留初次累积用于 SPA 早期捕获）。
  //   任意一种情况触发清空：a) URL 已变化（SPA 切模态/切搜索/切合集）；b) 首注入但已有旧累积（重载扩展时 window.__hmdao_captures 残留）。
  if ((isFirstInject && window.__hmdao_captures && window.__hmdao_captures.dyUrls && window.__hmdao_captures.dyUrls.length) || isPageChanged) {
    try {
      delete window.__hmdao_captures;
      window.__hmdao_captures = { dyUrls: [], dyUrlTs: [], dyAudios: [], dyAwemes: [], dyCovers: [], dyPlayback: [], tkUrls: [], tkAwemes: [], tkCovers: [], tkPlayback: [], dyCoverByAweme: {}, dyFormatsByAweme: {}, curFirstFrame: null, curVideoSrc: '', curAwemeId: '', curCover: '' };
    } catch (_) {}
  }
  window.__hmdao_injected_url = curUrl;

  // ★2026-08-22 修复（"切换视频侧栏还是旧的"核心根因）：抖音是 SPA（history.pushState / replaceState），
  // 切换 modal_id 时 <script> 不重新执行 → 上方 IIFE 清空逻辑（依赖重跑）永不触发 → dyUrls 跨模态累积错卡。
  // 改为 monkey-patch history 导航 + 监听 popstate/hashchange，在 SPA 导航发生时清空累积数组，
  // 保证 dyUrls/dyAwemes/dyCovers/dyPlayback 仅反映当前 modal 会话内捕获的 CDN。
  // 仅注册一次（本 IIFE 首次跑，后续因 __hmdao_installed 早返回不再进入）。
  if (!window.__hmdao_spaNavHooked) {
    window.__hmdao_spaNavHooked = true;
    const __hmdao_clearCaptures = () => {
      try {
        delete window.__hmdao_captures;
        window.__hmdao_captures = { dyUrls: [], dyUrlTs: [], dyAudios: [], dyAwemes: [], dyCovers: [], dyPlayback: [], tkUrls: [], tkAwemes: [], tkCovers: [], tkPlayback: [], dyCoverByAweme: {}, dyFormatsByAweme: {}, curFirstFrame: null, curVideoSrc: '', curAwemeId: '', curCover: '' };
        // ★2026-09-01：换页必须重置"全量分辨率扫描"标记，否则新页面的 aweme 不会被重新索引
        window.__hmdao_dyFormatsFullScanDone = false;
      } catch (_) {}
    };
    // ★2026-08-23 暴露给 background.scanTab()：重新扫描前主动清空累积，避免 SPA 不触发清空时残留旧 modal 捕获。
    window.__hmdao_clearCaptures = __hmdao_clearCaptures;
    const __hmdao_onNav = () => {
      const newUrl = location.href;
      // 仅当 URL 真正变化才清空（避免首次/无关导航误清，抖音信息流滚动不改 URL 不触发）
      if (window.__hmdao_injected_url && window.__hmdao_injected_url !== newUrl) {
        __hmdao_clearCaptures();
        // ★2026-08-23 修复（问题1/3 根因）：MAIN world 里 chrome.runtime 不可用（chrome.* API
        //   仅在 ISOLATED/background 可用），旧代码 chrome.runtime.sendMessage 静默失败，
        //   SPA 导航通知从未送达 background。改为经 window.postMessage 跨 world 广播，
        //   由 ISOLATED 世界的 content script（若存在）转发；无 content script 时由
        //   background 的轮询（startPolling）兜底触发重扫，不影响主链路。
        try { window.postMessage({ type: 'HMDAO_PAGE_NAVIGATED', url: newUrl }, '*'); } catch (_) {}
      }
      window.__hmdao_injected_url = newUrl;
    };
    const _push = history.pushState, _replace = history.replaceState;
    history.pushState = function () { const r = _push.apply(this, arguments); try { __hmdao_onNav(); } catch (_) {} return r; };
    history.replaceState = function () { const r = _replace.apply(this, arguments); try { __hmdao_onNav(); } catch (_) {} return r; };
    window.addEventListener('popstate', __hmdao_onNav);
    window.addEventListener('hashchange', __hmdao_onNav);
  }

  if (window.__hmdao_installed) return;
  // ★2026-08-22 修正：B站整域 100% 静默（被反扩展机制弹「白名单」提示）。
  if (__hmdao_isBiliPlayPage()) return;
  // ★2026-08-23 新增：抖音/TikTok「专属观看页」（/video/<id>）100% 熔断，保护原生播放器，
  //   与 model-api-capture.js 语义一致；jingxuan/信息流/搜索/用户页 正常注入捕获。
  if (__hmdao_isDouyinPlayPage()) return;
  // ★2026-08-22 修复（用户截图实证根因）：排除抖音创作中心/通知/直播后台等非播放页，
  // 防止 studio 等页面误注入后扫出几十条同封面脏数据。保留 jingxuan/搜索/首页/用户主页等合法路径。
  if (__hmdao_isDouyinExcluded()) return;
  window.__hmdao_installed = true;
  // ★2026-09-01 版本自检标记：用于确认页面里跑的是【最新】inject-main。
  //   排障第一条：若抖音页控制台看不到本行（或版本不是 -b），说明扩展未重载/页面未刷新，
  //   此时 dyCoverByAweme / dyFormatsByAweme 两个索引都不会存在，必然出现
  //   「视频卡无分辨率」「封面采集 byKey 0」。重载扩展 + 刷新页面后应能看到本行。
  console.log('[HMDAO][inject-main] v2026.09.01-b loaded');
  // ★2026-09-01 页面内自检：抖音页控制台执行 __hmdao_diag() 即可打印采集链路真实状态，
  //   不用靠猜。重点看 coverKeys / formatKeys 是否为 0（为 0 表示分辨率与封面都没索引到）。
  try {
    window.__hmdao_diag = function () {
      const c = window.__hmdao_captures || {};
      const coverKeys = Object.keys(c.dyCoverByAweme || {});
      const fmtKeys = Object.keys(c.dyFormatsByAweme || {});
      // ★2026-09-01：探测 window.player（诊断显示该字段存在）。
      //   用户确认源页本身支持 1080p/540p，数据很可能挂在播放器实例上，
      //   先把它的键与常见清晰度承载位置列出来，据此按真实数据接入。
      let playerProbe = null;
      try {
        const p = window.player;
        if (p) {
          playerProbe = { type: typeof p, keys: Object.keys(p).slice(0, 40) };
          for (const k of ['config', 'definition', 'definitions', 'quality', 'qualities', 'url', 'currentVideo', 'videoInfo']) {
            try {
              const val = p[k];
              if (!val) continue;
              if (Array.isArray(val)) {
                playerProbe[k] = val.slice(0, 6).map((x) => (typeof x === 'object' ? Object.keys(x).slice(0, 12) : String(x).slice(0, 50)));
              } else if (typeof val === 'object') {
                playerProbe[k] = Object.keys(val).slice(0, 25);
              } else {
                playerProbe[k] = String(val).slice(0, 60);
              }
            } catch (_) {}
          }
        }
      } catch (_) {}
      const report = {
        version: '2026.09.01-c',
        injectedUrl: window.__hmdao_injected_url || '',
        curAwemeId: c.curAwemeId || '',
        dyUrlsCount: (c.dyUrls || []).length,
        dyAwemes: (c.dyAwemes || []).slice(-5),
        coverKeys,
        // ★2026-09-01 修正笔误：变量实际叫 fmtKeys（旧代码写成 formatKeys → ReferenceError，
        //   整个 __hmdao_diag 直接抛错、什么都输出不了）。键名仍对外保持 formatKeys。
        formatKeys: fmtKeys,
        formatSample: fmtKeys.length ? (c.dyFormatsByAweme[fmtKeys[0]] || []) : [],
        fullScanDone: !!window.__hmdao_dyFormatsFullScanDone,
        // 详情 API 里 video 的真实字段结构（判断分辨率该从哪个字段取）
        videoShapeDiag: c.__dyVideoShapeDiag || [],
        playerProbe,
      };
      console.log('[HMDAO][diag]', JSON.stringify(report, null, 2));
      return report;
    };
  } catch (_) {}
  // ★2026-08-23 致命根因修复（问题1/2/3 共同底层 bug）：
  //   旧代码 window.__hmdao_captures = {} 把上方初始化好的 {dyUrls:[],dyAwemes:[],dyCovers:[],
  //   dyPlayback:[],curFirstFrame,curVideoSrc,curAwemeId} 覆盖成空对象，导致后续
  //   hmdaoCaptureDyStream 的 window.__hmdao_captures.dyUrls.push(...) 抛
  //   "Cannot read properties of undefined (reading 'push')"，被 try/catch 吞掉 ——
  //   抖音 dyUrls/dyAwemes/curVideoSrc/curAwemeId 捕获【从未真正工作】，全部依赖这些字段的
  //   扫描/预览/去重/切集逻辑空转。改为：仅在尚未初始化时才建立完整结构，绝不覆盖。
  if (!window.__hmdao_captures) {
    window.__hmdao_captures = { dyUrls: [], dyUrlTs: [], dyAudios: [], dyAwemes: [], dyCovers: [], dyPlayback: [], tkUrls: [], tkAwemes: [], tkCovers: [], tkPlayback: [], dyCoverByAweme: {}, dyFormatsByAweme: {}, curFirstFrame: null, curVideoSrc: '', curAwemeId: '', curCover: '' };
  } else if (typeof window.__hmdao_captures !== 'object') {
    window.__hmdao_captures = { dyUrls: [], dyUrlTs: [], dyAudios: [], dyAwemes: [], dyCovers: [], dyPlayback: [], tkUrls: [], tkAwemes: [], tkCovers: [], tkPlayback: [], dyCoverByAweme: {}, dyFormatsByAweme: {}, curFirstFrame: null, curVideoSrc: '', curAwemeId: '', curCover: '' };
  } else {
    // 结构已存在但缺字段 → 补齐（防历史空对象 {} 残留）
    const caps = window.__hmdao_captures;
    if (!Array.isArray(caps.dyUrls)) caps.dyUrls = [];
    if (!Array.isArray(caps.dyUrlTs)) caps.dyUrlTs = [];
    if (!Array.isArray(caps.dyAudios)) caps.dyAudios = [];
    if (!Array.isArray(caps.dyAwemes)) caps.dyAwemes = [];
    if (!Array.isArray(caps.dyCovers)) caps.dyCovers = [];
    if (!Array.isArray(caps.dyPlayback)) caps.dyPlayback = [];
    if (!Array.isArray(caps.tkUrls)) caps.tkUrls = [];
    if (!Array.isArray(caps.tkAwemes)) caps.tkAwemes = [];
    if (!Array.isArray(caps.tkCovers)) caps.tkCovers = [];
    if (!Array.isArray(caps.tkPlayback)) caps.tkPlayback = [];
    if (caps.curFirstFrame == null) caps.curFirstFrame = null;
    if (typeof caps.curVideoSrc !== 'string') caps.curVideoSrc = '';
    if (typeof caps.curAwemeId !== 'string') caps.curAwemeId = '';
    if (typeof caps.curCover !== 'string') caps.curCover = '';
  }

  // build 标记：MAIN world 无法用 chrome.runtime，经 postMessage 交给 detect.js 代为上报 background 统一入口
  const HMDAO_INJECT_MAIN_BUILD = '2026-07-25-main-v1';
  try { window.postMessage({ type: 'HMDAO_MAIN_BUILD', build: HMDAO_INJECT_MAIN_BUILD }, '*'); } catch (_) {}

  // ★2026-08-22 深层修复（抖音搜索/信息流"9 张错卡 + 有声没画面"根因）：
  // 抖音搜索页 / 推荐信息流的每个视频卡都有 <video preload="metadata">，浏览器会为它们发起
  // CDN 预加载请求；这些"预加载流"与"用户点击后真正播放的 modal 视频流"走同一套 XHR/fetch，
  // 旧逻辑一视同仁全部收进 dyUrls → 信息流 9 个预加载流 + modal 播放流混在一起 → 9 张卡、
  // 各自 CDN URL 不同导致 dedup 不合并、playerUrl 共用搜索页 URL 导致回源内容一样。
  // 修复：维护"当前是否真的在播放"状态。仅当页面存在 paused===false（正在播放）的 <video>
  // 时，捕获到的抖音 CDN 才标记为"当前播放流"（isPlayback）；预加载态（paused 的视频卡）
  // 不捕获。抖音信息流视频不会自动播放（需点击），故 paused 判定可精确区分两者。
  let __hmdao_playing = null; // 当前正在播放的 <video> 元素
  function __hmdao_refreshPlaying() {
    // ★2026-08-22 修复（抖音 jingxuan modal 单视频页 99 条错采根因）：
    // 抖音 modal 播放页底部「相关推荐」是 autoplay/muted 小卡片，paused=false / readyState>2 与主播放器无异，
    // 导致 fetch/XHR 拦截器把所有 CDN URL（包括推荐位的）都当作"当前播放"推入 dyUrls，scan.js dedup 后侧栏显示多条错卡。
    // 修复策略：主播放器一定有声音（muted=false），推荐位自动播放一定是 muted。
    // 取「第一个处于播放态且非 muted 的 video」，把 muted 卡片排除掉，避免 dyUrls 被推荐位污染。
    // ★2026-08-31 增强（"预览显示别视频的房间画面"根因）：
    //   仅靠 muted 不够——用户可能静音主播放器、推荐位也可能非 muted。
    //   强化"主播放器"判定：(1) 排除已知推荐容器（recommend/related/sidebar/feed-item）；
    //   (2) 排除过小预览（offsetWidth<300 || offsetHeight<200）；
    //   (3) 兜底用 intrinsic 分辨率（videoWidth*videoHeight）选最大——不受 CSS 缩放影响。
    const vs = document.querySelectorAll('video');
    const isRecommendation = (v) => {
      try {
        if (v.offsetWidth < 300 || v.offsetHeight < 200) return true;
        return !!v.closest('[class*="recommend" i], [class*="related" i], [class*="sidebar" i], [class*="side-video" i], [class*="feed-item" i]');
      } catch (_) { return false; }
    };
    let found = null;
    vs.forEach((v) => {
      try {
        if (!v.paused && !v.ended && v.readyState > 2 && !v.muted && !isRecommendation(v) && !found) found = v;
      } catch (_) {}
    });
    // 兜底：全网都 muted 或推荐容器过滤后无候选 → 用「intrinsic 分辨率最大」的那个 video
    if (!found) {
      let maxArea = 0;
      vs.forEach((v) => {
        try {
          if (!v.paused && !v.ended && v.readyState > 2 && !isRecommendation(v)) {
            const a = v.videoWidth * v.videoHeight;
            if (a > maxArea) { maxArea = a; found = v; }
          }
        } catch (_) {}
      });
    }
    __hmdao_playing = found;
    // ★2026-09-02 修复（"帧流兜底启动失败: __hmdao_playing is not defined"根因）：
    //   __hmdao_playing 定义在 IIFE 外层作用域（let，块级），但 __hmdaofs_getVideo() 在 L1110 的
    //   IIFE 内部调用——IIFE 不能访问外层 let 变量 → try/catch 吞错 → v 永远 null →
    //   帧流发送端拿不到 video → 侧栏永久停在兜底图（@image:...Temp\image.xxx.png）。
    //   修复：同步暴露到 window.__hmdao_playing，让 IIFE 内外都能读到。
    window.__hmdao_playing = found;
    // ★2026-08-23 P2（侧栏与当前播放视频精确匹配校验）：用主播放器的 currentSrc（真实播放流签名 URL）
    //   的"路径部分"去 dyUrls 数组里匹配，取其对应的 dyAwemes 当作 curAwemeId。
    //   这样 curAwemeId 就是"当前 <video> 真正在播放的那条流所属的视频 awemeId"，
    //   scan.js 单视频模式据此强制只保留与之匹配的资产，杜绝标题/缩略图/画面URL 错配。
    try {
      const cs = (__hmdao_playing && (__hmdao_playing.currentSrc || __hmdao_playing.src)) || window.__hmdao_captures.curVideoSrc || '';
      if (cs && window.__hmdao_captures.dyUrls && window.__hmdao_captures.dyAwemes) {
        const csPath = cs.split('?')[0].split('#')[0];
        let matchedIdx = -1;
        for (let i = 0; i < window.__hmdao_captures.dyUrls.length; i++) {
          const u = window.__hmdao_captures.dyUrls[i];
          if (u && u.split('?')[0].split('#')[0] === csPath) { matchedIdx = i; break; }
        }
        if (matchedIdx >= 0) {
          const aid = window.__hmdao_captures.dyAwemes[matchedIdx];
          window.__hmdao_captures.curAwemeId = (aid && aid !== 'unknown') ? aid : '';
        } else {
          window.__hmdao_captures.curAwemeId = ''; // 未匹配到（流尚未被捕获）→ 置空，scan.js 回退到末条
        }
      }
    } catch (_) {}
  }
  function __hmdao_onVideoPlay(e) {
    try {
      const v = e && e.target;
      if (!(v && v.tagName === 'VIDEO' && !v.paused)) return;
      // ★2026-08-31 修复（"预览显示别视频的房间画面"根因）：
      //   推荐位 video autoplay 也会进入此回调。原逻辑无条件 __hmdao_playing = v + 抽首帧，
      //   导致推荐位播放后 curFirstFrame/curVideoSrc/__hmdao_playing 全被污染成推荐位视频，
      //   侧栏预览兜底图与 WebRTC 流都跑偏（用户实测：万物生卡片预览显示一间房间的女人）。
      //   修复：调用 __hmdao_refreshPlaying() 用统一规则重选"主播放"，仅当 v 就是重选后的 __hmdao_playing 时才抽首帧。
      __hmdao_refreshPlaying();
      if (v === __hmdao_playing) {
        // 触发播放的瞬间，抽当前 video 的真实首帧到 window.__hmdao_captures.curFirstFrame（dataURL），
        // 供 scan.js extractVideoCovers 作为精准封面源。不再依赖页面 <img> 兜底——避免把横幅/认证/电子营业执照误当默认封面。
        try { __hmdao_captureFirstFrame(v); } catch (_) {}
      }
    } catch (_) {}
  }
  // ★2026-08-22：抽 video 当前帧到 dataURL（同源 MAIN 世界无 CORS 问题）。
  // 触发条件：HAVE_CURRENT_DATA(>=2) + 画布尺寸 > 0 + 尚未抽过（避免重复绘制）。
  // 同时把 v.currentSrc 存到 __hmdao_captures.curVideoSrc —— 这是页面 <video> 真正能播放的合法签名 URL，
  // SW 拉这个 URL 一定能 200（页面用同一会话请求同一 URL），无需借 Referer/Cookie 即可直拉。
  function __hmdao_captureFirstFrame(v) {
    try {
      if (!v || v.tagName !== 'VIDEO') return;
      if (!window.__hmdao_captures) return;
      // ★2026-08-31 防御：防止非主播放 video（推荐位）的 loadedmetadata/play 覆盖 curFirstFrame。
      //   若已有主播放的首帧且 v 不是主播放，直接拒绝——保证兜底图始终是"用户当前在看"的那条视频。
      if (__hmdao_playing && v !== __hmdao_playing && window.__hmdao_captures.curFirstFrame) return;
      // ★关键：实时把当前 video 的 currentSrc 也存下来（每次 src 变都更新）
      try {
        const cs = v.currentSrc || v.src || '';
        if (cs && cs !== window.__hmdao_captures.curVideoSrc) {
          window.__hmdao_captures.curVideoSrc = cs;
          window.postMessage({ type: 'HMDAO_VIDEO_SRC', src: cs }, '*');
        }
        // ★2026-08-31 新增：同步捕获当前播放视频的真实封面（poster/封面图 URL），
        //   供预览 WebRTC 协商前的兜底图使用——保证兜底图一定是"当前视频"封面，而非空白/错配推广图。
        try { __hmdao_captureCurCover(v); } catch (_) {}
      } catch (_) {}
      if (window.__hmdao_captures.curFirstFrame && window.__hmdao_captures.curFirstFrame.src === (v.currentSrc || v.src)) return;
      if (typeof v.readyState !== 'number' || v.readyState < 2) return;
      const w = v.videoWidth || 0, h = v.videoHeight || 0;
      if (w < 32 || h < 32) return;
      const c = document.createElement('canvas');
      const targetW = 320, targetH = Math.round(320 * h / w); // 缩到 320 宽，省内存
      c.width = targetW; c.height = targetH;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      // ★2026-08-23 深层修复（根因：源视频"莫名暂停"）：
      //   Chromium 对 MSE / blob: video 执行 drawImage 抽帧时，会强制 video 暂停解码直到画出当前帧
      //   （尤其抖音 douyinvod MSE 流），导致源页视频抽帧瞬间卡住/暂停。
      //   修复：抽帧前记录 wasPlaying；drawImage 后用 rVFC（若支持）或同步 play() 恢复播放，
      //   确保源视频抽帧后不残留暂停态——彻底消除"侧栏扫描/抽帧导致源视频暂停"。
      const wasPlaying = !v.paused && !v.ended;
      try { ctx.drawImage(v, 0, 0, targetW, targetH); } catch (_) { return; }
      if (wasPlaying && v.paused) {
        try {
          const pr = v.play();
          if (pr && pr.catch) pr.catch(() => {});
        } catch (_) {}
      }
      const dataUrl = c.toDataURL('image/jpeg', 0.7);
      if (!dataUrl || dataUrl.length < 200) return;
      window.__hmdao_captures.curFirstFrame = { dataUrl, src: v.currentSrc || v.src || '', ts: Date.now(), w: targetW, h: targetH };
      try { window.postMessage({ type: 'HMDAO_FIRST_FRAME', dataUrl, src: v.currentSrc || v.src || '' }, '*'); } catch (_) {}
    } catch (_) {}
  }
  // ★2026-08-31：抓取当前播放视频封面（poster URL）到 window.__hmdao_captures.curCover。
  //   优先 <video poster>（抖音 xgplayer 常直接写在 <video poster>），退化到 .xgplayer-poster 背景图。
  //   同时挂到 curFirstFrame.coverUrl，让预览既有读取路径也能直接拿到。
  //   仅取合法 http(s) 且非推广图（避免把电子营业执照/认证图当成封面）。
  function __hmdao_captureCurCover(v) {
    try {
      if (!window.__hmdao_captures) return;
      const isPromo = (url) => /(verify-|license-business|qrcode|qr-|banner|ad-|promo|advert|sponsor|avatar|emoji|logo|loading|sprite|placeholder|thumb\d{1,2}x\d{1,2}|\bicon[/-]|user-?data|sign(?:ature)?=|favicon)/i.test(url);
      let cover = '';
      if (v && v.tagName === 'VIDEO') {
        const p = v.getAttribute('poster') || v.poster;
        if (p && /^https?:/i.test(p)) {
          try { cover = new URL(p, location.href).href; } catch (_) { cover = p; }
        }
      }
      if (!cover || isPromo(cover)) {
        const pe = document.querySelector('.xgplayer-poster, .xgplayer-poster-img, [class*="poster"]');
        if (pe) {
          const bg = (pe.style && pe.style.backgroundImage) || (typeof getComputedStyle === 'function' ? getComputedStyle(pe).backgroundImage : '') || '';
          const m = bg.match(/url\(["']?(https?:[^"')]+)["']?\)/i);
          if (m && !isPromo(m[1])) cover = m[1];
        }
      }
      if (!cover || isPromo(cover)) return;
      window.__hmdao_captures.curCover = cover;
      if (window.__hmdao_captures.curFirstFrame) window.__hmdao_captures.curFirstFrame.coverUrl = cover;
      try { window.postMessage({ type: 'HMDAO_CUR_COVER', cover }, '*'); } catch (_) {}
    } catch (_) {}
  }
  function __hmdao_onVideoPause(e) {
    try {
      const v = e && e.target;
      if (v && v === __hmdao_playing) { __hmdao_playing = null; window.__hmdao_playing = null; __hmdao_refreshPlaying(); }
    } catch (_) {}
  }
  try {
    document.addEventListener('playing', __hmdao_onVideoPlay, true);
    document.addEventListener('play', __hmdao_onVideoPlay, true);
    document.addEventListener('pause', __hmdao_onVideoPause, true);
    document.addEventListener('emptied', __hmdao_onVideoPause, true);
    // ★2026-08-22：loadedmetadata 触发时同步抓 currentSrc（页面 <video> 此时已拿到合法签名 URL）
    document.addEventListener('loadedmetadata', function (e) {
      try { const v = e && e.target; if (v && v.tagName === 'VIDEO') __hmdao_captureFirstFrame(v); } catch (_) {}
    }, true);
    // 动态注入的 <video> 也能被监听（事件冒泡到 document）
    // ★2026-08-23 P5（防「莫名暂停」副作用）：抖音/信息流页面 DOM 高频变动（弹幕、推荐位、滚动），
    //   原 childList+subtree 监听每次变动都同步遍历所有 <video> + getBoundingClientRect，虽只读但
    //   高频强制重布局会干扰主播放器 React 渲染。加 400ms debounce 把高频合并，且 childList 不监听 subtree
    //   （视频元素不会深层嵌套变动），大幅降低对源页播放的打扰。
    let __hmdao_voTimer = null;
    const __hmdao_vo = new MutationObserver(() => {
      if (__hmdao_voTimer) return;
      __hmdao_voTimer = setTimeout(() => { __hmdao_voTimer = null; try { __hmdao_refreshPlaying(); } catch (_) {} }, 400);
    });
    __hmdao_vo.observe(document.documentElement, { childList: true, subtree: false });
    __hmdao_refreshPlaying();
  } catch (_) {}

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

  // ★2026-08-31 国际版 TikTok 捕获（镜像 hmdaoCaptureDyStream）：
  // TikTok 国际版 CDN 域为 tiktokcdn.com / bytecdn / v*.tiktokcdn.com，结构与抖音同理——
  // 播放器已完成签名/鉴权，真实播放流是最好的数据源。仅收视频轨（mime=video），丢弃音频轨。
  // TikTok 视频 id 取自 URL pathname 末段数字（/video/<id> 或 /@user/video/<id>）。
  function hmdaoCaptureTikTokStream(reqUrl) {
    try {
      if (typeof reqUrl !== 'string' || !/(tiktokcdn|bytecdn|tiktok\.com\/.*\/video|tiktokv\.com|tiktokcdn\.com)/i.test(reqUrl)) return;
      const u = new URL(reqUrl);
      const mime = (u.searchParams.get('mime') || '').toLowerCase();
      if (mime) { if (/audio/.test(mime) && !/video/.test(mime)) return; }
      else if (/[?&](?:audio|music)[=&]/i.test(u.search) && !/video/i.test(u.search)) return; // 纯音频轨，丢弃
      ['range', 'sq', 'rqh', 'rn', 'rbq'].forEach((k) => u.searchParams.delete(k));
      // 仅捕获"正在播放"的流（与抖音一致，避免预加载污染）
      __hmdao_refreshPlaying();
      const isPlaying = !!__hmdao_playing;
      let infoFlowAllowPaused = false;
      try { const p = new URL(location.href); infoFlowAllowPaused = !/\/video\/\d+/.test(p.pathname); } catch (_) {}
      if (!isPlaying && !infoFlowAllowPaused) return;
      window.__hmdao_captures.tkUrls = window.__hmdao_captures.tkUrls || [];
      window.__hmdao_captures.tkAwemes = window.__hmdao_captures.tkAwemes || [];
      window.__hmdao_captures.tkPlayback = window.__hmdao_captures.tkPlayback || [];
      const clean = u.toString();
      if (window.__hmdao_captures.tkUrls.indexOf(clean) < 0) {
        window.__hmdao_captures.tkUrls.push(clean);
        window.__hmdao_captures.tkPlayback.push(true);
        let tid = '';
        try { const m = location.pathname.match(/\/video\/(\d+)/); if (m) tid = m[1]; } catch (_) {}
        window.__hmdao_captures.tkAwemes.push(tid || 'unknown');
        if (window.__hmdao_captures.tkUrls.length > 50) {
          window.__hmdao_captures.tkUrls.shift();
          if (window.__hmdao_captures.tkAwemes.length) window.__hmdao_captures.tkAwemes.shift();
          if (window.__hmdao_captures.tkPlayback.length) window.__hmdao_captures.tkPlayback.shift();
        }
      }
    } catch (_) {}
  }
  window.__hmdaoCaptureTikTokStream = hmdaoCaptureTikTokStream;

  // 捕获抖音 CDN 直链（douyinvod.com / v26-web.douyinvod.com / bytedance 等）。
  // 抖音播放器和 YouTube 一样，播放器已经完成签名/鉴权，真实播放流是最好的数据源。
  // 在 MAIN 世界按时间戳收队，取最新一条作为「当前播放」的视频（避免 NETWORK_ASSETS 末尾是预加载）。

  // ★2026-09-01 抖音多画质提取（统一入口，供 chosen 与全量扫描共用）：
  //   兼容两种 RENDER_DATA 结构 —— bit_rate(下划线,老) 与 bitRateList(驼峰,现代 jingxuan/合集)。
  //   注：background.js:3540 的 probe 注释称 jingxuan 常「只有 bitRateList」，该结论属他人注释、
  //   可信度存疑，故此处【两种都支持】做防御性兼容，不依赖任何单一前提。
  //   同时处理：过滤音频轨（纯音频无画面，不能当分辨率选项）、同 URL 去重、按分辨率数字降序、
  //   标记 is_default（download_addr 优先，沿用 background.js:3613-3615 既有结论）。
  function hmdaoExtractVideoFormats(v) {
    const out = [];
    if (!v || typeof v !== 'object') return out;
    const list = Array.isArray(v.bit_rate) ? v.bit_rate
      : (Array.isArray(v.bitRateList) ? v.bitRateList : []);
    const seen = new Set();
    const isAudioTrack = (u) => /(media-audio|audio|\.m4a|\.mp3|\.aac|ies-music)(\?|$)/i.test(u || '');
    const push = (label, url, isDefault) => {
      try {
        if (!url || seen.has(url)) return;
        if (isAudioTrack(url)) return; // 纯音频轨：无画面，不能作为分辨率选项
        seen.add(url);
        out.push({ label: String(label || '默认'), url: String(url).replace(/\\\//g, '/'), is_default: !!isDefault });
      } catch (_) {}
    };
    for (const br of list) {
      if (!br || typeof br !== 'object') continue;
      const q = br.gear_name || br.quality_type || br.gearName
        || ('q' + (br.quality_value != null ? br.quality_value : ''));
      // 兼容 play_addr(下划线) 与 playAddr/PlayUrl(驼峰)
      const pu = br.play_addr || br.backup_play_addr || br.play_addr_h265 || br.download_addr
        || br.playAddr || br.PlayUrl;
      let u = '';
      if (Array.isArray(pu)) {
        const f0 = pu[0];
        u = !f0 ? '' : (typeof f0 === 'string' ? f0 : ((f0.url_list && f0.url_list[0]) || f0.src || ''));
      } else if (pu && typeof pu === 'object') {
        u = (pu.url_list && pu.url_list[0]) || pu.src || '';
      } else if (typeof pu === 'string') {
        u = pu;
      }
      if (u) push(q, u, false);
    }
    // download_addr = 官方下载源（原始最高清正片、含音画）→ 优先作为默认档
    const dl = v.download_addr && v.download_addr.url_list && v.download_addr.url_list[0];
    if (dl) push('下载源(含音画)', dl, true);
    // 兜底：无任何多画质时，用主 play_addr
    if (!out.length) {
      const pa = v.play_addr && v.play_addr.url_list && v.play_addr.url_list[0];
      if (pa) push('默认', pa, true);
    }
    if (!out.some((f) => f.is_default) && out.length) out[0].is_default = true;
    // 按分辨率数字降序（最高清在前）——不依赖「bit_rate 数组顺序」这一未验证假设
    const px = (l) => { const m = /(\d{3,4})\s*[pP]/.exec(String(l || '')); return m ? parseInt(m[1], 10) : 0; };
    out.sort((a, b) => px(b.label) - px(a.label));
    return out;
  }

  // ★2026-09-01 封面提取（独立函数，供 RENDER_DATA 路径与「详情 API 响应」路径共用）。
  //   抖音封面字段在不同接口/版本下形态不一：字符串、{url_list:[]}、或直接是数组。
  //   统一在此收敛，避免在调用处各写一套导致漏字段。
  function hmdaoPickCover(v) {
    try {
      if (!v || typeof v !== 'object') return '';
      const cands = [
        v.cover, v.originCover, v.dynamicCover, v.gaussianCover,
        v.coverUrlList, v.cover169UrlList, v.originCoverUrlList,
        v.rawCover, v.blurCover,
      ].reduce((acc, x) => acc.concat(Array.isArray(x) ? x : (x ? [x] : [])), []);
      for (const c of cands) {
        if (typeof c === 'string' && /^https?:/i.test(c)) return c.replace(/\\\//g, '/');
        if (c && typeof c === 'object') {
          if (Array.isArray(c.url_list) && c.url_list[0]) return String(c.url_list[0]).replace(/\\\//g, '/');
          if (typeof c.src === 'string' && /^https?:/i.test(c.src)) return c.src.replace(/\\\//g, '/');
          if (typeof c.url === 'string' && /^https?:/i.test(c.url)) return c.url.replace(/\\\//g, '/');
        }
      }
    } catch (_) {}
    return '';
  }

  // ★2026-09-01 关键新增：从抖音「详情 API 响应」提取视频元数据（分辨率/封面/标题的唯一可靠来源）。
  //   背景（实测结论）：jingxuan?modal_id=xxx 是【精选列表页 + modal 播放】，
  //   <script id="RENDER_DATA"> 里只有页面框架（实测解析不到 aweme），
  //   当前视频的 bitRateList / cover / desc 全都在这类 XHR 详情接口的响应体里。
  //   而旧 fetch 钩子在抖音页只捕获 URL 就 return 透传，从不读响应体
  //   → dyCoverByAweme / dyFormatsByAweme 恒空 → 卡片无封面、无分辨率选项。
  function hmdaoCaptureDyDetail(j) {
    try {
      if (!j || typeof j !== 'object') return;
      const list = [];
      if (j.aweme_detail) list.push(j.aweme_detail);
      if (j.awemeDetail) list.push(j.awemeDetail);
      if (Array.isArray(j.aweme_list)) j.aweme_list.forEach((x) => list.push(x));
      if (Array.isArray(j.awemeList)) j.awemeList.forEach((x) => list.push(x));
      if (Array.isArray(j.data)) j.data.forEach((x) => list.push(x));
      if (Array.isArray(j.item_list)) j.item_list.forEach((x) => list.push(x));
      if (Array.isArray(j.items)) j.items.forEach((x) => list.push(x));
      const caps = window.__hmdao_captures || (window.__hmdao_captures = {});
      caps.dyCoverByAweme = caps.dyCoverByAweme || {};
      caps.dyFormatsByAweme = caps.dyFormatsByAweme || {};
      caps.dyTitlesByAweme = caps.dyTitlesByAweme || {};
      let hit = 0;
      for (const a of list) {
        if (!a || typeof a !== 'object') continue;
        const id = (a.awemeId != null) ? String(a.awemeId)
          : (a.aweme_id != null ? String(a.aweme_id) : '');
        const v = a.video;
        if (!id || !v) continue;
        const cov = hmdaoPickCover(v);
        if (cov) caps.dyCoverByAweme[id] = cov;
        const fmts = hmdaoExtractVideoFormats(v);
        if (fmts.length) caps.dyFormatsByAweme[id] = fmts;
        if (a.desc) caps.dyTitlesByAweme[id] = String(a.desc);
        // ★2026-09-01 诊断：记录【详情 API 里 video 对象的真实结构】。
        //   实测现象：dyCoverByAweme 有值（封面取得到）但 dyFormatsByAweme 为空 →
        //   说明 hmdaoExtractVideoFormats 没认出该 video 的分辨率字段形态。
        //   把 video 的键名与关键子结构原样落盘，据此按真实数据修正提取逻辑（不靠猜）。
        try {
          caps.__dyVideoShapeDiag = caps.__dyVideoShapeDiag || [];
          if (caps.__dyVideoShapeDiag.length < 4) {
            caps.__dyVideoShapeDiag.push({
              id,
              keys: Object.keys(v).slice(0, 60),
              has_bit_rate: Array.isArray(v.bit_rate),
              has_bitRateList: Array.isArray(v.bitRateList),
              bitRateListLen: Array.isArray(v.bitRateList) ? v.bitRateList.length : 0,
              bitRateList0Keys: (Array.isArray(v.bitRateList) && v.bitRateList[0]) ? Object.keys(v.bitRateList[0]).slice(0, 20) : [],
              has_play_addr: !!(v.play_addr && v.play_addr.url_list && v.play_addr.url_list.length),
              play_addr0: (v.play_addr && v.play_addr.url_list && v.play_addr.url_list[0]) ? String(v.play_addr.url_list[0]).slice(0, 70) : '',
              has_download_addr: !!(v.download_addr && v.download_addr.url_list && v.download_addr.url_list.length),
              has_playAddr: !!v.playAddr,
              fmtsLen: fmts.length,
            });
          }
        } catch (_) {}
        // 记录最近一次详情对应的 awemeId：jingxuan modal 场景下它就是「当前播放」
        caps.curAwemeId = id;
        hit += 1;
      }
      if (hit) {
        try { console.log('[HMDAO][inject] dy-detail captured: awemes=' + hit + ' cur=' + caps.curAwemeId + ' fmtKeys=' + Object.keys(caps.dyFormatsByAweme).length); } catch (_) {}
      }
    } catch (_) {}
  }

  function hmdaoCaptureDyStream(reqUrl) {
    try {
      if (typeof reqUrl !== 'string' || !/(douyinvod|douyin\.com\/.*video|bytedance)/i.test(reqUrl)) return;
      const u = new URL(reqUrl);
      // ★抖音是 DASH 分离轨：播放器分别请求「视频轨 CDN」(mime=video) 与「音频轨 CDN」(mime=audio)。
      // 旧逻辑把音频轨直接丢弃（因为混进 dyUrls 会导致侧栏预览/下载选到纯音频 → "有声音没画面"）。
      // ★2026-09-02 改为【分轨收集】：视频轨仍进 dyUrls，音频轨单独进 dyAudios，两者按
      //   「同 aweme 锚点优先 + 捕获时间邻近兜底」配对。只有同时拿到两轨，后端 ffmpeg
      //   才能合并出含音画的单文件（此前抖音合并不了正是因为没有音频轨 URL）。
      // ★2026-09-02 实测修正（分轨判定对抖音从未生效的真凶）：
      //   抖音 douyinvod 直链的参数是【mime_type=video_mp4 / mime_type=audio_mp4】，
      //   而旧代码只读 'mime' 参数 → 永远拿到 null → 分轨判定形同虚设，音频轨一直混在
      //   dyUrls 里（这就是历史上"侧栏预览只有声音没画面"的真正成因）。现两个参数名都支持。
      const mime = (u.searchParams.get('mime') || u.searchParams.get('mime_type') || '').toLowerCase();
      let trackKind = 'video';
      if (mime) {
        if (/audio/.test(mime) && !/video/.test(mime)) trackKind = 'audio';
      } else if (/[?&](?:audio|music)[=&]/i.test(u.search) && !/video/i.test(u.search)) {
        trackKind = 'audio'; // 无 mime/mime_type 参数但带 audio/music 查询键
      }
      // 去掉可能的 range/分段参数，得到整文件直链
      ['range', 'sq', 'rqh', 'rn', 'rbq'].forEach((k) => u.searchParams.delete(k));
      // ★2026-08-22 深层修复：仅捕获"用户主动播放"的流。信息流/搜索页视频卡的 <video preload>
      // 预加载请求（paused=true）一律跳过，避免混进 dyUrls 造成 9 张错卡 / 有声没画面。
      // 实时查询（不单依赖事件缓存）：捕获瞬间扫一遍 document 的 <video>，任一 paused=false 即判定为播放态。
      // 防御：部分播放器把 <video> 包进 shadow DOM，playing 事件不冒泡出 shadow → 事件缓存可能漏；
      // 实时轮询可兜底（抖音 PC 网页 xgplayer 的 video 在 light DOM，通常事件也能命中）。
      __hmdao_refreshPlaying();
      const isPlaying = !!__hmdao_playing;
      // ★2026-08-22 修复（信息流批量裁剪开关无效根因）：
      //   单视频场景（modal_id 存在）→ 严格要求 playing 状态，避免预加载流污染 dyUrls；
      //   信息流场景（modal_id 不存在）→ 允许 paused 视频的预加载流进入 dyUrls，因为信息流的"多视频"
      //   正是来自这些 9 张推荐位 <video preload> 的 fetch 拦截；没有它们，batchMode 开关没东西可裁剪。
      let infoFlowAllowPaused = false;
      try {
        const u = new URL(location.href);
        infoFlowAllowPaused = !(u.searchParams.get('modal_id') || u.searchParams.get('aweme_id'));
      } catch (_) {}
      if (!isPlaying && !infoFlowAllowPaused) return;
      window.__hmdao_captures.dyUrls = window.__hmdao_captures.dyUrls || [];
      window.__hmdao_captures.dyAwemes = window.__hmdao_captures.dyAwemes || []; // ★2026-08-21：与 dyUrls 1:1 对应，存对应 aweme_id（合集多集数场景用，dedup 按此区分）
      window.__hmdao_captures.dyPlayback = window.__hmdao_captures.dyPlayback || []; // ★2026-08-22：与 dyUrls 1:1 对应，标记是否"当前播放流"（用于 scan.js 过滤信息流预加载）
      const clean = u.toString();
      // ★2026-09-02：音频轨只进 dyAudios（绝不进 dyUrls，避免侧栏出现"只有声音没画面"的卡）。
      //   记录 ts 供与视频轨按「捕获时间邻近」配对；同时记下当时的 aweme 锚点供精确配对。
      if (trackKind === 'audio') {
        const cA = window.__hmdao_captures;
        if (!Array.isArray(cA.dyAudios)) cA.dyAudios = [];
        let anchor = '';
        try {
          const pa = new URL(location.href);
          anchor = pa.searchParams.get('modal_id') || pa.searchParams.get('aweme_id') || '';
        } catch (_) {}
        if (!cA.dyAudios.some((x) => x && x.url === clean)) {
          cA.dyAudios.push({ url: clean, ts: Date.now(), awemeId: anchor });
          if (cA.dyAudios.length > 50) cA.dyAudios.shift();
        }
        return;
      }
      // 去重：不重复添加同一 URL
      if (window.__hmdao_captures.dyUrls.indexOf(clean) < 0) {
        window.__hmdao_captures.dyUrls.push(clean);
        // ★2026-09-02：与 dyUrls 1:1 的捕获时间戳，供与 dyAudios 按时间邻近配对
        if (!Array.isArray(window.__hmdao_captures.dyUrlTs)) window.__hmdao_captures.dyUrlTs = [];
        window.__hmdao_captures.dyUrlTs.push(Date.now());
        window.__hmdao_captures.dyPlayback.push(true); // 仅播放态进入，恒为 true
        // ★2026-08-21 修复:合集多集数场景(https://www.douyin.com/jingxuan?modal_id=...),每条 dyUrl 都属于 RENDER_DATA aweme_list 中
        //   某一条 aweme_id 下的视频轨。简易推断策略:取 RENDER_DATA 中所有 aweme_id 顺序 → 顺序填充遇到重复 URL 也复用最近 aweme_id。
        //   由于合集页滑一次只触发一条播放流,初次抓到的第一条 dyUrl ≈ 用户正在看的那条 target;
        //   数量多于 aweme_list 时,补充 'unknown' 即可。
        try {
          const el2 = document.querySelector('script#RENDER_DATA, script[id="RENDER_DATA"]');
          if (el2 && el2.textContent) {
            // ★2026-08-22 修复（封面/内容错配根因）：
            // 抖音 jingxuan?modal_id=xxx 是【单 URL 多模态 SPA】，modal_id 只是初始锚点。
            // 用户切到第 N 集后 URL 的 modal_id【不变】，但当前播放视频的真实 awemeId 变了。
            // 旧逻辑把 URL 的 modal_id 写死成所有 dyUrls 的标签 → 切集后侧栏视频源错配（拿到历史里
            // 被打成同一 modal_id 标签的另一条流）。
            // ★正确策略：优先用 dyUrl 的 path 去 RENDER_DATA 的 aweme_list 反查【真实 awemeId】
            // （每条流打上它真正属于哪个视频的 id），反查不到再用 modal_id 兜底（保证单集页仍有标签）。
            let aid = '';
            let modalFallback = '';
            try {
              const p = new URL(location.href);
              modalFallback = p.searchParams.get('modal_id') || p.searchParams.get('aweme_id') || '';
            } catch (_) {}
            {
              // ★2026-08-22 修复（信息流错封面根因）：无 modal_id 时，dyUrls 是浏览器实际拉流的
              // 网络层顺序，与 RENDER_DATA aweme_list 数组顺序【无对应关系】，不能用 ids[seq] 推断，
              // 否则会把流错配到错误的 aweme_id → scan.js 按 byKey 取到错封面（如"电子营业执照"）。
              // 正确做法：推 'unknown'，让 scan.js 走 pageImgFallback（页面真实可见缩略图）或保留空，
              // 不强行错配。批量采集封面由 RENDER_DATA 多视频分支的精确 awemeId 提供，不依赖此推断。
              // ★2026-08-22 v2：信息流批量裁剪开关真实生效根因——原来 aid='unknown' 导致所有 dyUrls
              //   在 scan.js dedup 阶段合并为 1 张卡，batchMode 开关失效。改为：反向匹配 RENDER_DATA
              //   aweme_list 找真实 awemeId；匹配不到用 'fp:<hash>' 作为唯一 id。
              aid = '';
              try {
                const el2b = document.querySelector('script#RENDER_DATA, script[id="RENDER_DATA"]');
                if (el2b && el2b.textContent) {
                  const data2 = JSON.parse(el2b.textContent);
                  const awList = [];
                  const walkAw = (o) => {
                    if (!o || typeof o !== 'object') return;
                    if (Array.isArray(o)) { o.forEach(walkAw); return; }
                    const v = o.video;
                    // ★2026-08-22 兼容：现代抖音 RENDER_DATA 用驼峰 awemeId，老结构用 aweme_id（下划线）
                    const amAw = (o.awemeId != null) ? String(o.awemeId) : (o.aweme_id != 0 && o.aweme_id != null ? String(o.aweme_id) : '');
                    if (v && amAw) {
                      const urls = [];
                      try {
                        if (v.play_addr && v.play_addr.url_list) urls.push(...v.play_addr.url_list);
                        if (v.play_addr_h265 && v.play_addr_h265.url_list) urls.push(...v.play_addr_h265.url_list);
                        if (v.download_addr && v.download_addr.url_list) urls.push(...v.download_addr.url_list);
                        // ★2026-08-22 补充：bitRateList[].playAddr[].src 是真实 CDN 直链（与 douyinvod 同源同 path），
                        // 仅收集 play_addr 会漏掉，导致反查 douyinvod 流时 path 不匹配 → 回退 modal_id → 切集错配。
                        if (Array.isArray(v.bitRateList)) {
                          v.bitRateList.forEach((br) => {
                            const pa = br && (br.playAddr || br.PlayUrl);
                            if (Array.isArray(pa)) pa.forEach((x) => { try { urls.push(typeof x === 'string' ? x : (x.url_list && x.url_list[0]) || x.src || ''); } catch (_) {} });
                            else if (pa && typeof pa === 'object') { try { urls.push(pa.url_list && pa.url_list[0] || pa.src || ''); } catch (_) {} }
                          });
                        }
                      } catch (_) {}
                      urls.forEach((u) => {
                        try {
                          const x = new URL(u);
                          awList.push({ fp: x.origin + x.pathname, aweme_id: amAw });
                        } catch (_) {}
                      });
                    }
                    for (const k in o) { try { walkAw(o[k]); } catch (_) {} }
                  };
                  walkAw(data2);
                  const dyFp = (function () { try { const x = new URL(clean); return x.origin + x.pathname; } catch (_) { return ''; } })();
                  const hit = awList.find((e) => e.fp === dyFp);
                  if (hit) aid = hit.aweme_id;
                }
              } catch (_) {}
              // 反查失败兜底：优先用 URL 的 modal_id（保证 jingxuan 单集页仍有稳定标签），
              // 其次按 dyUrl path 生成唯一 fp id（避免不同视频被合并成 1 张卡 → batchMode 失效），
              // 最后才 'unknown'。
              if (!aid) {
                if (modalFallback) aid = modalFallback;
                else { try { aid = 'fp:' + (new URL(clean).origin + new URL(clean).pathname).slice(-32); } catch (_) { aid = 'unknown'; } }
              }
            }
            window.__hmdao_captures.dyAwemes.push(aid || 'unknown');
            if (window.__hmdao_captures.dyAwemes.length > 50) window.__hmdao_captures.dyAwemes.shift();
          } else {
            window.__hmdao_captures.dyAwemes.push('unknown');
          }
        } catch (_) {
          window.__hmdao_captures.dyAwemes.push('unknown');
        }
        // 限制 50 条（避免内存泄漏）—— ★2026-08-22 同步 dyAwemes/dyCovers/dyPlayback 防止索引错位
        if (window.__hmdao_captures.dyUrls.length > 50) {
          window.__hmdao_captures.dyUrls.shift();
          // ★2026-09-02：dyUrlTs 与 dyUrls 1:1，必须同步裁剪，否则配对时会整体错位
          if (Array.isArray(window.__hmdao_captures.dyUrlTs) && window.__hmdao_captures.dyUrlTs.length > 0) {
            window.__hmdao_captures.dyUrlTs.shift();
          }
          if (window.__hmdao_captures.dyAwemes && window.__hmdao_captures.dyAwemes.length > 0) {
            window.__hmdao_captures.dyAwemes.shift();
          }
          if (window.__hmdao_captures.dyPlayback && window.__hmdao_captures.dyPlayback.length > 0) {
            window.__hmdao_captures.dyPlayback.shift();
          }
          if (window.__hmdao_captures.dyCovers && window.__hmdao_captures.dyCovers.length > 0) {
            window.__hmdao_captures.dyCovers.shift();
          }
        }
        // ★2026-08-18 修复：捕获抖音直链时，顺手从 RENDER_DATA 读当前 aweme 封面，存入 dyCovers，
        // 随回传一并交给 scan.js 直接赋给 dyUrls 资产（不再依赖 scan.js 跨世界 byKey 匹配，
        // jingxuan 信息流页 targetTabUrl 不带 modal_id 导致 awemeIdFromUrl 为空、封面匹配失败）。
        try {
          const el = document.querySelector('script#RENDER_DATA, script[id="RENDER_DATA"]');
          if (el && el.textContent) {
            const data = JSON.parse(decodeURIComponent(el.textContent));
            let chosen = null;
            const targetId = (function () {
              try {
                const p = new URL(location.href);
                return p.searchParams.get('modal_id') || p.searchParams.get('aweme_id') || '';
              } catch (_) { return ''; }
            })();
            const walk = (o) => {
              if (!o || typeof o !== 'object') return;
              if (Array.isArray(o)) { o.forEach(walk); return; }
              const hasV = o.video && (o.video.play_addr || o.video.download_addr);
              const am = (o.awemeId != null) ? String(o.awemeId) : (o.aweme_id != null ? String(o.aweme_id) : '');
              if ((am || hasV) && !chosen) chosen = o;
              if (targetId && String(am) === String(targetId)) chosen = o;
              for (const k in o) { try { walk(o[k]); } catch (_) {} }
            };
            walk(data);
            let cov = '';
            if (chosen && chosen.video) {
              const cv = chosen.video.cover;
              if (typeof cv === 'string' && cv) cov = cv.replace(/\\\//g, '/');
              else if (cv && typeof cv === 'object') cov = (cv.url_list || cv.urlList || [])[0] || '';
              // 补充数组型封面
              if (!cov) {
                const cands = [chosen.video.coverUrlList, chosen.video.cover169UrlList, chosen.video.originCoverUrlList, chosen.video.originCover, chosen.video.rawCover, chosen.video.dynamicCover]
                  .flatMap((x) => (Array.isArray(x) ? x : (x ? [x] : [])));
                for (const c of cands) {
                  if (typeof c === 'string' && /^https?:/i.test(c)) { cov = c.replace(/\\\//g, '/'); break; }
                  if (c && typeof c === 'object' && (c.url_list && c.url_list[0])) { cov = String(c.url_list[0]).replace(/\\\//g, '/'); break; }
                }
              }
            }
            // ★2026-09-01 修复（"封面错配/缺封面" + "能选分辨率下载"根因）：
            //   1) 按 awemeId 存封面（dyCoverByAweme），解决 dyCovers 索引错位导致封面错配/缺封面。
            //   2) 解析 RENDER_DATA video.bit_rate 多画质直链 → dyFormatsByAweme，供侧栏"选分辨率下载"。
            const chosenId = (chosen && (chosen.awemeId != null ? String(chosen.awemeId) : (chosen.aweme_id != null ? String(chosen.aweme_id) : ''))) || '';
            if (cov && chosenId) {
              window.__hmdao_captures.dyCoverByAweme = window.__hmdao_captures.dyCoverByAweme || {};
              window.__hmdao_captures.dyCoverByAweme[chosenId] = cov.replace(/\\\//g, '/');
            }
            if (cov) {
              window.__hmdao_captures.dyCovers = window.__hmdao_captures.dyCovers || [];
              const c = cov.replace(/\\\//g, '/');
              if (window.__hmdao_captures.dyCovers.indexOf(c) < 0) {
                window.__hmdao_captures.dyCovers.push(c);
                if (window.__hmdao_captures.dyCovers.length > 50) window.__hmdao_captures.dyCovers.shift();
              }
            }
            // ★2026-09-01 抖音多画质：兼容 bit_rate(老) / bitRateList(现代) 两种结构提取清晰度直链
            try {
              window.__hmdao_captures.dyFormatsByAweme = window.__hmdao_captures.dyFormatsByAweme || {};
              // ① 当前 chosen：每次捕获都刷新，保证拿到的是最新直链
              if (chosen && chosen.video && chosenId) {
                const fmts = hmdaoExtractVideoFormats(chosen.video);
                if (fmts.length) window.__hmdao_captures.dyFormatsByAweme[chosenId] = fmts;
              }
              // ② ★F2：全量遍历 RENDER_DATA 所有 aweme 建立分辨率索引（仅一次，避免重复全树遍历）。
              //    目的：合集/批量模式下，【未被播放的集数】也有分辨率选项
              //    （旧逻辑只写 chosen 一个 → 未播放集数无分辨率可选）。
              if (!window.__hmdao_dyFormatsFullScanDone) {
                try {
                  const elAll = document.querySelector('script#RENDER_DATA, script[id="RENDER_DATA"]');
                  if (elAll && elAll.textContent) {
                    const dataAll = JSON.parse(decodeURIComponent(elAll.textContent));
                    let __fmtNodes = 0;
                    const collectFmt = (o) => {
                      if (!o || typeof o !== 'object') return;
                      // 节点数上限保护：合集页 RENDER_DATA 可能含上百集，防极端情况遍历卡顿
                      if (++__fmtNodes > 50000) return;
                      if (Array.isArray(o)) { o.forEach(collectFmt); return; }
                      const vv = o.video;
                      const am = (o.awemeId != null) ? String(o.awemeId) : (o.aweme_id != null ? String(o.aweme_id) : '');
                      if (vv && am) {
                        const f = hmdaoExtractVideoFormats(vv);
                        if (f.length) window.__hmdao_captures.dyFormatsByAweme[am] = f;
                      }
                      for (const k in o) { try { collectFmt(o[k]); } catch (_) {} }
                    };
                    collectFmt(dataAll);
                    window.__hmdao_dyFormatsFullScanDone = true;
                  }
                } catch (_) {}
              }
            } catch (_) {}
          }
        } catch (_) {}
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
    // ★2026-08-22 修复（抖音 modal 单视频页面 46 条错卡根因）：
    // 抖音 modal 播放页（jingxuan?modal_id=xxx 或类似 /video/xxx）的 XHR 响应里常常含
    // 多条 mp4/m3u8 签名 CDN URL（不同分辨率/不同 itag/不同签名的同一视频轨）。这些全部
    // 经 API_VIDEO_RE 命中 → 进 apiVideos → 在 scan.js 不带 awemeId 被推到 networkAssets →
    // dedup 按 URL 区分（每条签名 URL 唯一）→ 多张卡片共用同一视频源却各自一张错卡。
    // 修复：抖音域 / TikTok 域在已知 modal_id/aweme_id 时跳过 apiVideos 扫描。
    // 当前视频由 __hmdao_playing 旁的 fetch/XHR 拦截捕获（进 dyUrls，dedup 按 awemeId 合并），
    // apiVideos 在此场景是冗余且制造错卡，禁用即可。其他站点（liblib/爱给）继续走 apiVideos。
    try {
      const host = location.hostname || '';
      const isDouyinTikTok = /(?:^|\.)(douyin\.com|ixigua\.com|tiktok\.com|tiktokv\.com)$/i.test(host);
      if (isDouyinTikTok) {
        let aid = '';
        try { aid = new URL(location.href).searchParams.get('modal_id') || new URL(location.href).searchParams.get('aweme_id') || ''; } catch (_) {}
        // ★抖音单视频场景（modal_id/aweme_id 已知）→ 跳过 apiVideos 扫描；当前视频由 dyUrls 接管。
        if (aid) return;
      }
    } catch (_) {}
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
    // ★2026-08-24 站点条件化包装（彻底消除非捕获站错误栈里的 inject-main 痕迹）：
    //   仅 YouTube / B站 / 抖音 需要捕获视频流，这三站才重写 window.fetch：
    //   - YT/B站：捕获 googlevideo / bilibili playurl 字节
    //   - 抖音：捕获 MSE/fetch 喂入的 douyinvod 流（hmdaoCaptureDyStream）
    //   任何其他站点（花瓣、微博、任意其他）**完全不重写 window.fetch** —— 网站自身 fetch 报错
    //   的调用栈里绝不会出现 window.fetch @ inject-main.js:644，从根本上消除"扩展引起错误"的误判。
    const isDyPage = /douyin\.com$/.test(location.hostname) || /tiktok\.com$/.test(location.hostname);
    const isYtBili = /(^|\.)youtube\.com$/.test(location.hostname) || /(^|\.)bilibili\.com$/.test(location.hostname);
    if (isDyPage || isYtBili) {
    const orig = window.fetch;
    window.fetch = function () {
      let p;
      try {
        const url = (typeof arguments[0] === 'string' ? arguments[0] : (arguments[0] && arguments[0].url)) || '';
        // 抖音页：只做抖音流捕获后直接透传，不进入任何 YT/B站 捕获分支（抖音无 googlevideo/bilibili）。
        if (isDyPage) {
          try { hmdaoCaptureDyStream(url); hmdaoCaptureTikTokStream(url); } catch (_) {}
          // ★2026-09-01 关键修复：抖音「详情 API」响应捕获。
          //   旧代码在这里直接 return 透传、【从不读响应体】，导致 jingxuan modal 播放场景下
          //   bitRateList / cover / desc 永远拿不到 → 卡片无封面、分辨率列表为空。
          //   现对详情接口 clone 一份响应后异步解析：clone 是只读副本，原响应原样交还页面，
          //   页面消费完全不受影响（零副作用）；非 JSON 响应（如 protobuf）解析失败会被忽略。
          // ★2026-09-01 放宽匹配：只要路径含 /aweme/ 或 iteminfo 即尝试解析。
          //   旧正则只认 aweme/vN/web/aweme/(detail|post)，实测 jingxuan modal 场景
          //   详情可能走其它 /aweme/* 接口 → 一个都捕获不到 → 分辨率索引恒空。
          const isDyDetailApi = /\/aweme\/|iteminfo|aweme_?detail|aweme\/post|aweme\/detail/i.test(url);
          if (isDyDetailApi) {
            p = orig.apply(this, arguments);
            return p.then(function (resp) {
              try {
                if (resp && resp.ok && resp.clone) {
                  resp.clone().json().then(function (j) {
                    try { hmdaoCaptureDyDetail(j); } catch (_) {}
                  }).catch(function () {});
                }
              } catch (_) {}
              return resp;
            });
          }
          return orig.apply(this, arguments);
        }
        hmdaoCaptureYtStream(url);
        hmdaoCaptureDyStream(url); hmdaoCaptureTikTokStream(url);
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
    } // end if (isDyPage || isYtBili)
  } catch (_) {}

  try {
    // ★2026-08-24 站点条件化包装（彻底消除非 YT/B站 站点错误栈里的 inject-main 痕迹）：
    //   仅 YouTube / B站 需要捕获视频流（googlevideo / bilibili playurl），这两站才重写
    //   XMLHttpRequest.prototype.open/send。抖音页（视频流走 fetch+MSE，已由上方 fetch 钩子的
    //   hmdaoCaptureDyStream 覆盖）以及任何其他站点（花瓣等）**完全不重写 XHR prototype** ——
    //   这样网站自身 XHR 报错（如抖音同步 XHR 设 timeout 的 InvalidAccessError）的调用栈里
    //   绝不会出现 XMLHttpRequest.open @ inject-main.js:663，从根本上消除"扩展引起错误"的误判。
    var isYtBili = /(^|\.)youtube\.com$/.test(location.hostname) || /(^|\.)bilibili\.com$/.test(location.hostname);
    if (!isYtBili) {
      // 非 YT/B站：不碰 XHR，直接跳过整个包装块。
    } else {
    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, asyncRest) {
      try {
        if (typeof url === 'string') hmdaoCaptureYtStream(url);
        if (typeof url === 'string') hmdaoCaptureDyStream(url); hmdaoCaptureTikTokStream(url);
        var isGV = typeof url === 'string' && /googlevideo\.(com|localhost)\/videoplayback/.test(url);
        if (isGV) this._hmdao_gvUrl = url;
        var isBili = typeof url === 'string' && /bilibili\.com\/x\/(web-interface\/view|player\/playurl|player\/wbi\/playurl|space\/acc\.info)/.test(url);
        var isYT = typeof url === 'string' && /youtube\.com\/youtubei\/v1\/player/.test(url);
        if (isBili || isYT) this._hmdao_ytUrl = url;
      } catch (_) {}
      return origOpen.call(this, method, url, asyncRest);
    };
    XMLHttpRequest.prototype.send = function (body) {
      // 此处仅在 YT/B站 域执行（外层 isYtBili 已保证），无需再判断 isDyPage。
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
    } // end else (isYtBili)
  } catch (_) {}
})();

// ===== 抖音/防盗链视频「侧栏真实预览播放」帧流发送端（WebRTC）=====
// ★2026-08-24 实现（用户要求「真实流畅预览播放」，替代 400ms 抽帧 base64 卡顿方案）：
//   侧栏无法独立解码抖音视频字节（CDN 防盗链 + MSE blob + CORS），但【源页 <video> 当前帧】
//   可在 MAIN 世界用 canvas.drawImage 持续绘制，再由 canvas.captureStream(30) 产 30fps 流，
//   经 RTCPeerConnection（本地 loopback，无 STUN/TURN 需求）实时传至侧栏 <video>.srcObject 播放 ——
//   这是纯前端扩展能在侧栏实现「真实流畅视频预览」的唯一高效途径（对比抽帧 base64 省 90%+ 带宽/延迟）。
//   信令：源页 MAIN world 经 chrome.runtime.sendMessage 上行 offer/ice；
//         background 中转给侧栏；侧栏 answer/ice 经 background chrome.tabs.sendMessage 下行到本监听。
//   注：本段使用 chrome.runtime 仅用于帧流信令中转（非包装 fetch/XHR），属 MAIN world 合法用途。
(function () {
  let __hmdaofs_pc = null, __hmdaofs_raf = null, __hmdaofs_canvas = null, __hmdaofs_ctx = null, __hmdaofs_stream = null;
  function __hmdaofs_getVideo() {
    // ★2026-08-24 修复：__hmdao_playing 是 inject-main 顶层【局部变量】不是 window 属性，
    //   原代码写 window.__hmdao_playing 永远 undefined → 只走 querySelector fallback。
    //   改用局部 __hmdao_playing（play 事件已写入），并 fallback 找【正在播放且 readyState>=2】的 video（避免选中暂停/广告 video）。
    // ★2026-08-31 增强（"预览显示别视频的房间画面"根因闭环）：
    //   原 fallback 用 !/^blob:/.test(x.src) 排除 blob URL（历史原因：避免 fetch blob 失败），
    //   但 canvas.drawImage(videoElement) 对 blob/MSE 流完全可用，此排除导致抖音主播放（blob:）永远不命中第一候选。
    //   且 fallback 仅取【第一个】候选——推荐位 preview 也会是第一个，劫持源流。
    //   修复：优先级改为
    //     (1) currentSrc 匹配 __hmdao_captures.curVideoSrc（与扫描识别的"当前播放"完全一致，最可靠）
    //     (2) __hmdao_playing（已用推荐容器排除 + intrinsic 分辨率选出的主播放）
    //     (3) 兜底：intrinsic 分辨率最大的非推荐 video（去掉 blob 排除，blob 对 drawImage 合法）
    // ★2026-09-02 修复帧流 bug：IIFE 内部无法访问外层 let __hmdao_playing → ReferenceError
    //   被 catch 吞 → v 永远 null。改读 window.__hmdao_playing（在外层刷新函数里同步写入）。
    let v = null;
    try {
      const hp = window.__hmdao_playing;
      if (hp && !hp.paused && hp.readyState >= 2 && hp.videoWidth >= 32) v = hp;
    } catch (_) {}
    if (!v) {
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
        // (1) 精确匹配：currentSrc 与扫描识别的 curVideoSrc 一致
        if (targetSrc) {
          v = all.find((x) => x && (x.currentSrc || x.src) === targetSrc && x.readyState >= 2 && x.videoWidth >= 32 && !x.paused) || null;
        }
        // (2) 兜底：intrinsic 分辨率最大的非推荐 playing video（去掉 blob 排除）
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
      } catch (_) {}
    }
    console.log('[HMDAO][fs] getVideo ->', v ? ('video ' + v.videoWidth + 'x' + v.videoHeight + ' readyState=' + v.readyState + ' src=' + ((v.currentSrc || v.src || '').slice(0, 60))) : 'null', '(__hmdao_playing set=' + (!!__hmdao_playing) + ')');
    return (v && v.tagName === 'VIDEO' && v.readyState >= 2 && v.videoWidth >= 32) ? v : null;
  }
  function __hmdaofs_stop() {
    if (__hmdaofs_raf) { cancelAnimationFrame(__hmdaofs_raf); __hmdaofs_raf = null; }
    if (__hmdaofs_stream) { __hmdaofs_stream.getTracks().forEach((t) => t.stop()); __hmdaofs_stream = null; }
    if (__hmdaofs_pc) { try { __hmdaofs_pc.close(); } catch (_) {} __hmdaofs_pc = null; }
    __hmdaofs_canvas = null; __hmdaofs_ctx = null;
  }
  function __hmdaofs_send(type, data) {
    try { chrome.runtime.sendMessage(Object.assign({ type: type, from: 'page' }, data || {})); } catch (_) {}
  }
  function __hmdaofs_start() {
    __hmdaofs_stop();
    console.log('[HMDAO][fs] page 收到 HMDAO_FS_START，尝试取源页 video');
    const v = __hmdaofs_getVideo();
    if (!v) { console.log('[HMDAO][fs] page 无可用 video → 发 no-video 错误'); __hmdaofs_send('HMDAO_FS_ERROR', { error: 'no-video' }); return; }
    console.log('[HMDAO][fs] page 找到 video ' + v.videoWidth + 'x' + v.videoHeight + '，开始 captureStream + createOffer');
    const w = v.videoWidth, h = v.videoHeight;
    const tw = 360, th = Math.round(360 * h / w);
    __hmdaofs_canvas = document.createElement('canvas');
    __hmdaofs_canvas.width = tw; __hmdaofs_canvas.height = th;
    __hmdaofs_ctx = __hmdaofs_canvas.getContext('2d');
    const draw = () => {
      const vv = __hmdaofs_getVideo();
      if (vv) {
        try {
          const wasPlaying = !vv.paused && !vv.ended;
          __hmdaofs_ctx.drawImage(vv, 0, 0, tw, th);
          // 抽帧前记录播放态，drawImage 后恢复（避免抖音 MSE 流抽帧被强制暂停）
          if (wasPlaying && vv.paused) { const p = vv.play(); if (p && p.catch) p.catch(() => {}); }
        } catch (_) {}
      }
      __hmdaofs_raf = requestAnimationFrame(draw);
    };
    draw();
    try { __hmdaofs_stream = __hmdaofs_canvas.captureStream(30); }
    catch (_) { try { __hmdaofs_stream = __hmdaofs_canvas.captureStream(); } catch (_) {} }
    if (!__hmdaofs_stream) { __hmdaofs_send('HMDAO_FS_ERROR', { error: 'captureStream-unsupported' }); return; }
    __hmdaofs_pc = new RTCPeerConnection({ iceServers: [] });
    __hmdaofs_pc.onicecandidate = (e) => { if (e && e.candidate) __hmdaofs_send('HMDAO_FS_ICE', { candidate: e.candidate }); };
    __hmdaofs_pc.onconnectionstatechange = () => {
      const s = __hmdaofs_pc && __hmdaofs_pc.connectionState;
      if (s === 'failed' || s === 'closed' || s === 'disconnected') __hmdaofs_send('HMDAO_FS_STATE', { state: s });
    };
    __hmdaofs_stream.getVideoTracks().forEach((t) => { try { __hmdaofs_pc.addTrack(t, __hmdaofs_stream); } catch (_) {} });
    __hmdaofs_pc.createOffer().then((offer) => {
      return __hmdaofs_pc.setLocalDescription(offer).then(() => {
        __hmdaofs_send('HMDAO_FS_OFFER', { sdp: offer.sdp, type: offer.type });
      });
    }).catch(() => { __hmdaofs_send('HMDAO_FS_ERROR', { error: 'createOffer-failed' }); });
  }
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((msg) => {
        if (!msg || !msg.type) return;
        if (msg.type === 'HMDAO_FS_START') __hmdaofs_start();
        else if (msg.type === 'HMDAO_FS_ANSWER') { if (__hmdaofs_pc && msg.sdp) __hmdaofs_pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).catch(() => {}); }
        else if (msg.type === 'HMDAO_FS_ICE') { if (__hmdaofs_pc && msg.candidate) __hmdaofs_pc.addIceCandidate(msg.candidate).catch(() => {}); }
        else if (msg.type === 'HMDAO_FS_STOP') __hmdaofs_stop();
      });
    }
    // ★2026-08-31 修复（"点击抖音视频卡只显示图片不显示视频"根因）：
    //   background 用 chrome.scripting.executeScript 调 window.__hmdaofs_start() 启动源页帧流发送端，
    //   但 __hmdaofs_start 原仅在 IIFE 内局部定义、未挂到 window → window.__hmdaofs_start 恒为 undefined
    //   → 源页从不发送 OFFER → 侧栏 WebRTC 永远收不到 ontrack → 预览永久停在封面兜底图（被误以为"显示图片而非视频"）。
    //   挂到 window 后，background 的 executeScript 即可直接启动源页采集，WebRTC 协商正常连通 → 侧栏真帧播放当前源视频。
    window.__hmdaofs_start = __hmdaofs_start;
  } catch (_) {}
})();
