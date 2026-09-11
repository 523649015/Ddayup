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
  // ★2026-09-05 修复（侧栏"卡一会多一会少 / 一会有封面一会没 / 集数跳变"根因）：
  //   URL 变化（含 SPA 切集 jingxuan?modal_id=xxx）会【整体 delete】__hmdao_captures，
  //   把按 awemeId 索引的封面/标题/集数/直链索引一并清零 → 侧栏卡数骤降、封面消失，
  //   随后靠 API 一集一集慢慢重建（10s 轮询一轮）→ 表现为"闪烁、数量忽多忽少、封面时有时无"。
  //   这些索引是【跨集有效的累积知识】（按 id 键控，不随播放会话失效），同页切集不该清。
  //   只清"当前播放会话"相关的瞬时数组（dyUrls/dyUrlTs/dyAudios/dyAwemes/dyCovers/dyPlayback）。
  // 按 awemeId 索引的累积知识键（切集保留；跨页/换站才清）
  var HMDAO_INDEX_KEYS = ['dyCoverByAweme', 'dyFormatsByAweme', 'dyUrlsByAweme', 'dyEpisodeByAweme',
    'dyTitlesByAweme', 'dyAudiosByAweme', 'dyVideoUrlByAweme', 'dyMixIdsByAweme'];

  function hmdaoBaseCaps() {
    return {
      dyUrls: [], dyUrlTs: [], dyAudios: [], dyAwemes: [], dyCovers: [], dyPlayback: [],
      tkUrls: [], tkAwemes: [], tkCovers: [], tkPlayback: [],
      dyCoverByAweme: {}, dyFormatsByAweme: {}, dyUrlsByAweme: {}, dyEpisodeByAweme: {},
      dyTitlesByAweme: {}, dyAudiosByAweme: {}, dyVideoUrlByAweme: {}, dyMixIdsByAweme: {},
      curFirstFrame: null, curVideoSrc: '', curAwemeId: '', curCover: '',
    };
  }

  // 同页导航判定：origin + pathname 相同，仅 query/hash 变化（jingxuan?modal_id= 切集即属此类）
  function hmdaoSamePageNav(a, b) {
    try {
      var ua = new URL(String(a || ''), location.href);
      var ub = new URL(String(b || ''), location.href);
      return ua.origin === ub.origin && ua.pathname === ub.pathname;
    } catch (_) { return false; }
  }

  function hmdaoResetCaptures(prevUrl, nextUrl) {
    var old = (window.__hmdao_captures && typeof window.__hmdao_captures === 'object') ? window.__hmdao_captures : null;
    var keepIndex = !!(old && hmdaoSamePageNav(prevUrl, nextUrl));
    var fresh = hmdaoBaseCaps();
    if (keepIndex) {
      for (var i = 0; i < HMDAO_INDEX_KEYS.length; i++) {
        var k = HMDAO_INDEX_KEYS[i];
        if (old[k] && typeof old[k] === 'object') fresh[k] = old[k];
      }
      if (old.mixId) fresh.mixId = old.mixId;
      if (old.mixName) fresh.mixName = old.mixName;
      // 索引已保留 → 分辨率全量扫描无需重跑（避免每次切集重复扫）
    } else {
      try { window.__hmdao_dyFormatsFullScanDone = false; } catch (_) {}
    }
    try { delete window.__hmdao_captures; } catch (_) {}
    window.__hmdao_captures = fresh;
  }

  // ★2026-09-05 修复（"第15集 · 第二十二集"自相矛盾根因）：
  //   从标题/描述文本解析集数。标题是抖音自己下发的 desc，与卡片显示的标题同源，
  //   用它派生的集数不可能与标题矛盾（此前用 API 数组下标，必然对不上）。
  function hmdaoCn2Num(s) {
    try {
      var CN = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
      var t = String(s || '');
      var total = 0, cur = 0, has = false;
      for (var i = 0; i < t.length; i++) {
        var ch = t[i];
        if (ch === '十') { cur = (cur || 1) * 10; total += cur; cur = 0; has = true; }
        else if (ch === '百') { cur = (cur || 1) * 100; total += cur; cur = 0; has = true; }
        else if (CN[ch] != null) { cur = CN[ch]; has = true; }
        else { has = false; break; }
      }
      if (!has) return 0;
      return total + cur;
    } catch (_) { return 0; }
  }

  function hmdaoParseEpisodeFromText(text) {
    try {
      var t = String(text || '');
      var m = t.match(/第\s*([0-9]{1,4})\s*[集期话章回]/);
      if (m) return parseInt(m[1], 10);
      m = t.match(/第\s*([零〇一二两三四五六七八九十百]{1,6})\s*[集期话章回]/);
      if (m) return hmdaoCn2Num(m[1]);
      m = t.match(/[Ee][Pp]?\s*([0-9]{1,4})\b/);
      if (m) return parseInt(m[1], 10);
    } catch (_) {}
    return 0;
  }

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
      hmdaoResetCaptures(prevUrl, curUrl);
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
    // ★2026-09-05：同页切集（仅 modal_id 变化）保留按 awemeId 索引的累积知识，
    //   只清当前播放会话的瞬时数组 —— 消除侧栏"卡数骤降/封面丢失/集数跳变"的闪烁。
    const __hmdao_clearCaptures = (nextUrl) => {
      try {
        hmdaoResetCaptures(window.__hmdao_injected_url || '', nextUrl || location.href);
      } catch (_) {}
    };
    // ★2026-08-23 暴露给 background.scanTab()：重新扫描前主动清空累积，避免 SPA 不触发清空时残留旧 modal 捕获。
    window.__hmdao_clearCaptures = __hmdao_clearCaptures;
    const __hmdao_onNav = () => {
      const newUrl = location.href;
      // 仅当 URL 真正变化才清空（避免首次/无关导航误清，抖音信息流滚动不改 URL 不触发）
      if (window.__hmdao_injected_url && window.__hmdao_injected_url !== newUrl) {
        __hmdao_clearCaptures(newUrl);
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
        version: '2026.09.04-a',
        injectedUrl: window.__hmdao_injected_url || '',
        curAwemeId: c.curAwemeId || '',
        mixId: c.mixId || '',
        mixName: c.mixName || '',
        dyUrlsCount: (c.dyUrls || []).length,
        dyAwemes: (c.dyAwemes || []).slice(-5),
        coverKeys,
        titleKeys: Object.keys(c.dyTitlesByAweme || {}).slice(0, 20),
        episodeKeys: c.dyEpisodeByAweme || {},
        videoUrlByAwemeKeys: Object.keys(c.dyVideoUrlByAweme || {}).slice(0, 20),
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
    window.__hmdao_captures = { dyUrls: [], dyUrlTs: [], dyAudios: [], dyAwemes: [], dyCovers: [], dyPlayback: [], tkUrls: [], tkAwemes: [], tkCovers: [], tkPlayback: [], dyCoverByAweme: {}, dyFormatsByAweme: {}, dyUrlsByAweme: {}, dyEpisodeByAweme: {}, dyTitlesByAweme: {}, dyAudiosByAweme: {}, dyVideoUrlByAweme: {}, dyMixIdsByAweme: {}, curFirstFrame: null, curVideoSrc: '', curAwemeId: '', curCover: '' };
  } else if (typeof window.__hmdao_captures !== 'object') {
    window.__hmdao_captures = { dyUrls: [], dyUrlTs: [], dyAudios: [], dyAwemes: [], dyCovers: [], dyPlayback: [], tkUrls: [], tkAwemes: [], tkCovers: [], tkPlayback: [], dyCoverByAweme: {}, dyFormatsByAweme: {}, dyUrlsByAweme: {}, dyEpisodeByAweme: {}, dyTitlesByAweme: {}, dyAudiosByAweme: {}, dyVideoUrlByAweme: {}, dyMixIdsByAweme: {}, curFirstFrame: null, curVideoSrc: '', curAwemeId: '', curCover: '' };
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
  // ★2026-09-03：从页面播放器实例「实时」读取当前播放视频的真实 awemeId / 标题 / 封面。
  //   背景：jingxuan modal 是 SPA，切集后 <script id=RENDER_DATA> 与详情 API 都不一定刷新，
  //   旧逻辑靠 RENDER_DATA/列表 API 推断当前集，极易锁死在旧集（封面/标题不变、内容错配）。
  //   window.player 是抖音 PC 网页播放器实例，切集后其内部状态【立即更新】，是最权威的当前集来源。
  //   深搜其对象树找 awemeId（19 位数字）+ video，带节点数上限与 DOM 引用跳过，避免卡顿/爆栈。
  // ★2026-09-03：从某个 video 对象里取第一个可播放直链（play_addr / download_addr 的 url_list[0]）。
  //   播放器当前在播的视频对象本身就带着签名直链，比详情 API 更实时、更可靠（不依赖接口是否下发）。
  function hmdaoFirstVideoUrl(v) {
    if (!v || typeof v !== 'object') return '';
    for (const key of ['play_addr', 'playAddr', 'download_addr', 'downloadAddr']) {
      const u = v[key];
      if (u && Array.isArray(u.url_list) && u.url_list.length) {
        const s = String(u.url_list[0] || '').trim();
        if (s) return s;
      }
    }
    return '';
  }
  function hmdaoFindAwemeInPlayer() {
    try {
      const p = window.player;
      if (!p || typeof p !== 'object') return null;
      // ★2026-09-03 修正（推翻上一版做法）：
      //   抖音 jingxuan 合集页的 modal_id 【就是当前正在播放那一集的真实 awemeId】。
      //   实测证据：modal_id=7667779728996076846，而「第45集」的 awemeId 恰好也是 7667779728996076846。
      //   上一版误以为它是"合集壳 ID"而用 `am !== modalId` 显式排除 → 真正的当前集被误杀
      //   → curAwemeId 恒为空 → 侧栏高亮 / 📍未播放徽标 / 标题集数同步全部失效，且
      //   scan.js 的 dyVideoUrlByAweme[pageCurAwemeId] 合成路径拿不到 key → 抖音视频卡一张都生不成。
      //   正确策略：优先选 ≠modal_id 的候选（用户切集后当前集通常与初始 modal_id 不同）；
      //   若一个都选不到（首次打开、播放器只挂了初始那集），再回退接受 modal_id 本身。
      let modalId = '';
      try { modalId = new URL(location.href).searchParams.get('modal_id') || ''; } catch (_) {}
      const runSearch = (excludeModal) => {
      const isRealAweme = (am) => am && /^\d{8,}$/.test(am) && (!excludeModal || am !== modalId);
      let found = null;
      let count = 0;
      const seen = new WeakSet();
      const skip = { ownerDocument: 1, document: 1, parentNode: 1, parentElement: 1, firstChild: 1,
        childNodes: 1, nextSibling: 1, previousSibling: 1, children: 1 };
      // ★跳过 React Fiber / 内部 DOM 引用，避免深搜爆栈/卡顿（抖音 PC 播放器是 React，window.player 链向整棵 Fiber 树）
      const skipKey = (k) => skip[k] || /^(__react|reactFiber|_react|stateNode|memoized|pending|alternate|sibling|return$|_owner|internalInstanceHandle|__debug)/i.test(k);
      const walk = (o, depth) => {
        if (found || depth > 10 || count > 8000) return;
        if (!o || typeof o !== 'object') return;
        if (typeof o.nodeType === 'number') return; // 跳过 DOM 节点
        try { if (seen.has(o)) return; seen.add(o); } catch (_) {}
        count++;
        try {
          const am = (o.awemeId != null) ? String(o.awemeId) : (o.aweme_id != null ? String(o.aweme_id) : '');
          const v = o.video;
          // ★只认「真实集」(非合集 modal_id) 且带 video 对象的条目；video 对象存在说明是单条视频而非合集壳
          if (isRealAweme(am) && v && typeof v === 'object') {
            found = {
              awemeId: am,
              desc: (typeof o.desc === 'string' ? o.desc : (typeof o.caption === 'string' ? o.caption : '')),
              cover: hmdaoPickCover(v),
              videoUrl: hmdaoFirstVideoUrl(v),
            };
            return;
          }
        } catch (_) {}
        try {
          for (const k in o) {
            if (skipKey(k)) continue;
            if (count > 8000) break;
            try { walk(o[k], depth + 1); } catch (_) {}
          }
        } catch (_) {}
      };
      // ★先试常见显式路径（快），再深搜兜底。显式路径（video/videoInfo/currentItem）是当前播放视频的最可能位置。
      const probes = [p.video, p.videoInfo, p.currentVideo, p._videoInfo, p._data, p.data, p.config,
        p._config, p.playerInfo, p._playerInfo, p.currentItem, p._state, p.state, p.getStats && p.getStats()];
      for (const o of probes) {
        if (found) break;
        try {
          const am = (o && o.awemeId != null) ? String(o.awemeId) : (o && o.aweme_id != null ? String(o.aweme_id) : '');
          const v = o && o.video;
          if (isRealAweme(am) && v && typeof v === 'object') {
            found = { awemeId: am, desc: (typeof o.desc === 'string' ? o.desc : ''), cover: hmdaoPickCover(v), videoUrl: hmdaoFirstVideoUrl(v) };
            break;
          }
        } catch (_) {}
      }
      if (!found) walk(p, 0);
      return found;
      };
      // 第一轮排除 modal_id（优先拿"用户切过去的那一集"），第二轮不排除（兜底：modal_id 就是当前集）
      return runSearch(true) || runSearch(false);
    } catch (_) { return null; }
  }

  // ★2026-09-03：从播放列表面板读取「当前集」的绝对集数 + awemeId + 标题。
  //   播放列表里每条项文字含「第 N 集」；带 active/current/playing 类（或 aria-current）的就是当前集。
  //   这是对用户「标题要严格等于播放列表显示的绝对集数」的直接满足。
  function hmdaoFindPlaylistEpisode() {
    try {
      const els = Array.from(document.querySelectorAll('a, li, div, span'));
      let best = null;
      for (const el of els) {
        const t = (el.textContent || '').trim();
        const m = t.match(/第\s*(\d+)\s*集/);
        if (!m) continue;
        const ep = parseInt(m[1], 10);
        let aid = '';
        const href = (el.getAttribute && el.getAttribute('href')) || '';
        const mm = href.match(/\/video\/(\d+)/);
        if (mm) aid = mm[1];
        else {
          for (const a of ['data-aweme-id', 'data-awemeid', 'data-id', 'data-cid', 'data-item-id']) {
            const vv = el.getAttribute && el.getAttribute(a);
            if (vv) { aid = vv; break; }
          }
        }
        const cls = ((typeof el.className === 'string' ? el.className : '') + ' ' + (el.getAttribute && (el.getAttribute('aria-current') || ''))).toLowerCase();
        const isActive = /active|current|playing|on\b|cur/.test(cls) || (el.getAttribute && el.getAttribute('aria-current') === 'true');
        if (isActive) { best = { awemeId: aid, episode: ep, title: t }; break; }
        if (!best) best = { awemeId: aid, episode: ep, title: t };
      }
      return best;
    } catch (_) { return null; }
  }

  // ★2026-09-03：用 window.player 实时刷新「当前播放集」的 awemeId / 标题 / 封面。
  //   在 __hmdao_refreshPlaying 与定时轮询里调用，保证切集后侧栏立刻跟到新集。
  // ★2026-09-03：切集后自动触发侧栏重新扫描，让封面/标题/视频卡「立刻」跟随当前集刷新。
  let hmdaoLastRescanAweme = '';
  let hmdaoRescanTimer = null;
  function hmdaoAutoRescanOnSwitch(newAwemeId) {
    try {
      if (!newAwemeId || newAwemeId === hmdaoLastRescanAweme) return;
      hmdaoLastRescanAweme = newAwemeId;
      // 防抖：切集瞬间可能多次刷新，合并成一次扫描；避免刷屏/死循环。
      if (hmdaoRescanTimer) { try { clearTimeout(hmdaoRescanTimer); } catch (_) {} }
      hmdaoRescanTimer = setTimeout(() => {
        // ★2026-09-04 致命根因修复：inject-main 是 【MAIN world】脚本，没有 chrome.* API！
        //   旧代码 `if (typeof chrome !== 'undefined' && chrome.runtime ...)` 在 MAIN 世界恒为假，
        //   于是整段被静默跳过（连日志都没有）→ "切集自动重扫"从未生效 → 侧栏永远停在首集。
        //   正确通道：dispatch window 自定义事件，由 rescan-bridge.js（ISOLATED 世界，有 chrome.*）
        //   接收后转发给 background 的 HMDAO_RESCAN_TAB。
        let bridged = false;
        try {
          window.dispatchEvent(new CustomEvent('hmdao:request-rescan', { detail: { awemeId: newAwemeId } }));
          bridged = true;
        } catch (_) {}
        // 仍保留直连尝试（万一将来运行在 ISOLATED 世界），但失败必须打日志，不再静默吞掉
        try {
          if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage({ type: 'HMDAO_RESCAN_TAB' }).catch(() => {});
          }
        } catch (_) {}
        try {
          console.log('[HMDAO][inject] 请求重扫 newAwemeId=' + newAwemeId + ' 事件桥=' + (bridged ? '已派发' : '派发失败')
            + ' chrome.runtime=' + (typeof chrome !== 'undefined' && chrome.runtime ? '可用' : '不可用(MAIN世界正常)'));
        } catch (_) {}
      }, 300);
    } catch (_) {}
  }
  function hmdaoRefreshCurFromPlayer() {
    try {
      const caps = window.__hmdao_captures || (window.__hmdao_captures = {});
      hmdaoRestoreCaps(); // 页面重载后先读回上轮集数元数据，避免 dyVideoUrlByAweme 归零
      // ★2026-09-04 自动补拉合集剧集列表（解决"侧栏只有 1 张卡 / 没缩略图 / 没集数"）：
      //   已知 mixId 且集数未拉满即触发；内部 30s 冷却 + 20 集上限防重，避免每次轮询重复拉 5 页。
      //   关键修复：之前只在「切集(URL modal_id 变化)」分支触发，首次加载或重载同源页(已恢复 curAwemeId)
      //   时该分支不进入 → 探测从不自动跑 → 只剩被动单视频详情抓到的 1 集。
      try {
        if (caps.mixId && !(caps.dyEpisodeByAweme && Object.keys(caps.dyEpisodeByAweme).length >= 20)) {
          hmdaoTryFetchMixAweme(false);
        }
      } catch (_) {}
      // ★2026-09-03 切集不同步【真凶修复】：优先用 URL 的 modal_id 判定"当前正在播放的那一集"。
      //   实测证据（用户切集诊断）：切集时抖音会把 location.href 的 modal_id 更新为新的那一集
      //   （7667779728996076846 → 7668131026677419327），但 window.player 对象常常取不到/滞后，
      //   而上一版的兜底逻辑是 `if (!caps.curAwemeId)` 才触发 → curAwemeId 一旦设过就永远卡在旧集，
      //   于是侧栏标题/封面/集数/高亮全部不跟随源页切换。
      //   正确做法：只要 URL 的 modal_id 与当前记录的 curAwemeId 不同，就以 modal_id 为准（最权威、最及时）。
      let mId = '';
      try { mId = new URL(location.href).searchParams.get('modal_id') || new URL(location.href).searchParams.get('aweme_id') || ''; } catch (_) {}
      if (mId && mId !== caps.curAwemeId) {
        caps.curAwemeId = mId;
        // 切集：清空上一集累积的分片直链（旧签名会过期 → "只有声音没画面"废卡）
        try {
          if (caps.__hmdaoLastClearedAweme !== mId) {
            caps.__hmdaoLastClearedAweme = mId;
            caps.dyUrls = [];
            caps.dyAwemes = [];
            caps.dyPlayback = [];
            caps.dyUrlTs = [];
          }
        } catch (_) {}
        hmdaoAutoRescanOnSwitch(mId);
        console.log('[HMDAO][inject] curAwemeId 跟随 URL modal_id 切到新集=' + mId);
        // mix_id 已知但剧集还没拉全时，补一次主动拉取（带防重：hmdaoMixProbeTried 上限 2 次）
        setTimeout(() => { try { hmdaoTryFetchMixAweme(); } catch (_) {} }, 1200);
        return true;
      }
      let found = hmdaoFindAwemeInPlayer();
      // ★window.player 取不到时，用播放列表「当前集」DOM 项兜底（其 href 常含 /video/<真实 awemeId>）
      if (!found || !found.awemeId) {
        try {
          const pl = hmdaoFindPlaylistEpisode();
          if (pl && pl.awemeId) {
            found = { awemeId: pl.awemeId, desc: pl.title || '', cover: '' };
          }
        } catch (_) {}
      }
      if (found && found.awemeId) {
        // ★2026-09-03：切到「真实新的一集」时，清空上一集累积的 dyUrls 分片直链。
        //   否则旧分片签名过期 → 视频轨 403、只剩配对 dashAudio 能响 → 侧栏出现一堆"没画面只有声音"的废卡。
        //   只在真实 awemeId 跨集变化时才清（同集重复检测不清，避免正在播的流被误删）。
        try {
          if (caps.__hmdaoLastClearedAweme !== found.awemeId) {
            caps.__hmdaoLastClearedAweme = found.awemeId;
            caps.dyUrls = [];
            caps.dyAwemes = [];
            caps.dyPlayback = [];
            caps.dyUrlTs = [];
            console.log('[HMDAO][inject] 切集清空上一集 dyUrls 分片（新集=' + found.awemeId + '）');
          }
        } catch (_) {}
        caps.curAwemeId = found.awemeId;
        hmdaoAutoRescanOnSwitch(found.awemeId);
        if (found.desc) { caps.dyTitlesByAweme = caps.dyTitlesByAweme || {}; caps.dyTitlesByAweme[found.awemeId] = found.desc; }
        if (found.cover) { caps.dyCoverByAweme = caps.dyCoverByAweme || {}; caps.dyCoverByAweme[found.awemeId] = found.cover; }
        // ★2026-09-03：直接从播放器当前 video 对象取到的视频直链（最实时，不依赖详情 API 是否下发 play_addr）。
        //   写入 dyVideoUrlByAweme 后，即便 MSE 没暴露 fetch、dyUrls 为空，scan.js 也能合成当前集视频卡。
        if (found.videoUrl) {
          caps.dyVideoUrlByAweme = caps.dyVideoUrlByAweme || {};
          caps.dyVideoUrlByAweme[found.awemeId] = found.videoUrl;
        }
        // 播放列表绝对集数（命中当前集时写入）
        try {
          const pl = hmdaoFindPlaylistEpisode();
          if (pl && pl.episode && (pl.awemeId === found.awemeId || !pl.awemeId)) {
            caps.dyEpisodeByAweme = caps.dyEpisodeByAweme || {};
            caps.dyEpisodeByAweme[found.awemeId] = pl.episode;
          }
        } catch (_) {}
        return true;
      }
      // ★2026-09-03 兜底（侧栏与源页脱节的最后一道防线）：
      //   播放器对象与播放列表 DOM 都没定位到当前集时，curAwemeId 会一直空着 →
      //   scan.js 的 dyVideoUrlByAweme[pageCurAwemeId] 合成路径拿不到 key → 抖音视频卡一张都生不成，
      //   侧栏只剩"无 awemeId 的裸直链卡"，高亮/徽标/标题集数同步全部失效。
      //   此时用「modal_id 命中已采集的某一集」兜底（jingxuan 页 modal_id 就是初始播放的那一集）。
      try {
        if (!caps.curAwemeId) {
          let mId = '';
          try { mId = new URL(location.href).searchParams.get('modal_id') || new URL(location.href).searchParams.get('aweme_id') || ''; } catch (_) {}
          const vmap = caps.dyVideoUrlByAweme || {};
          if (mId && vmap[mId]) {
            caps.curAwemeId = mId;
            hmdaoAutoRescanOnSwitch(mId);
            console.log('[HMDAO][inject] curAwemeId 兜底：用 modal_id 命中已采集集 ' + mId);
            return true;
          }
        }
      } catch (_) {}
    } catch (_) {}
    return false;
  }

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
    // ★2026-09-04 关键兜底（dyUrls 恒为 0、卡片没画面没声音的真凶）：
    //   上面纯 DOM 的"主播放器"判定过严，实测在 jingxuan?modal_id= 页会把【主播放器误判成推荐位】：
    //     · isRecommendation 里 closest('[class*="feed-item" i]') 等容器类名匹配（精选页主播放器
    //       就处在这类 feed 容器中）；或 offsetWidth/Height 在首帧尚未布局时为 0，直接被 <300x200 判死。
    //   → found 恒为 null → hmdaoCaptureDyStream 的
    //       `if (!isPlaying && !infoFlowAllowPaused) return;`
    //     把【所有真实视频流全部丢弃】。而诊断实证：v26-web.douyinvod.com 这些请求
    //     返回 206 Partial Content 且响应体以 'ftypisom' 开头（真实 MP4 字节）——流明明在拉，
    //     只是被这条守卫丢掉了，于是 dyUrls 永远是 0、侧栏只能拿到 MSE 的 blob（后台 fetch 必失败）。
    //   修复：DOM 判定不出播放态时，改用 window.player（诊断确认 window.player.video 存在）兜底判定。
    if (!found) {
      try {
        const p = window.player;
        const pv = p && p.video;
        if (pv && typeof pv === 'object' && typeof pv.tagName === 'string') {
          const playingLike = (pv.paused === false) || (typeof pv.currentTime === 'number' && pv.currentTime > 0);
          if (playingLike) found = pv;
        }
        // xgplayer 把播放态挂在 player 自身而非 player.video
        if (!found && p && typeof p === 'object') {
          const st = (p.isPlaying === true) || (p.paused === false)
            || (typeof p.currentTime === 'number' && p.currentTime > 0)
            || (p.videoInfo && p.videoInfo.isPlaying === true);
          if (st && p.video && typeof p.video === 'object' && typeof p.video.tagName === 'string') found = p.video;
          else if (st) found = p; // 至少让 isPlaying 为真（dyUrls 捕获只需要布尔判定）
        }
      } catch (_) {}
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
          // ★2026-09-03：MSE/blob 场景下 currentSrc 不是真实 CDN URL，反查会失败。
          //   此时用「最近捕获到的视频轨」对应的 awemeId 作为当前集兜底，避免 curAwemeId 空转。
          const dyAwemes = window.__hmdao_captures.dyAwemes || [];
          const lastAid = dyAwemes.length ? dyAwemes[dyAwemes.length - 1] : '';
          window.__hmdao_captures.curAwemeId = (lastAid && lastAid !== 'unknown') ? lastAid : '';
        }
      }
      // ★2026-09-03：window.player 是最权威的当前集来源（切集即更新），优先用它覆盖，
      //   解决 RENDER_DATA/列表 API 锁死旧集导致的「封面标题不变 / 内容错配」。
      try { hmdaoRefreshCurFromPlayer(); } catch (_) {}
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
          // ★2026-09-04：只恢复【主播放器】，绝不恢复"相关推荐"等小卡片视频。
          //   抖音 modal 播放页底部的推荐位是 autoplay 小卡片（paused=false），
          //   若被逐个当成播放态并 play()，就会出现"多个视频同时出声"（用户实测）。
          //   主播放器判定：可见尺寸足够大（≥300x200），排除推荐位小卡片。
          const rect = (v.getBoundingClientRect ? v.getBoundingClientRect() : null) || { width: 0, height: 0 };
          const dw = v.offsetWidth || rect.width || 0;
          const dh = v.offsetHeight || rect.height || 0;
          const isMainPlayer = dw >= 300 && dh >= 200;
          if (isMainPlayer) {
            const pr = v.play();
            if (pr && pr.catch) pr.catch(() => {});
          }
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
    // ★2026-09-02：按 label 去重。抖音 bitRateList 同档位（1080P/720P）有多个 CDN 备份 URL，
    //   之前按 URL 去重 → 同一档位显示 N 次；现在 label 由 width×height 统一构造后变成同字串。
    //   按 label 去重后弹窗清爽。备份 CDN 走另一条路（预览时 altDiv 备选源，见 sidepanel.js:1886）。
    const seenLabels = new Set();
    const isAudioTrack = (u) => /(media-audio|audio|\.m4a|\.mp3|\.aac|ies-music)(\?|$)/i.test(u || '');
    const push = (label, url, isDefault) => {
      try {
        if (!url || !label) return;
        if (seenLabels.has(label)) return;
        if (isAudioTrack(url)) return; // 纯音频轨：无画面，不能作为分辨率选项
        seenLabels.add(label);
        out.push({ label: String(label), url: String(url).replace(/\\\//g, '/'), is_default: !!isDefault });
      } catch (_) {}
    };
    for (const br of list) {
      if (!br || typeof br !== 'object') continue;
      // ★2026-09-02：抖音 gearName（adapt_lowest_4_1 / low_540_0 / 720_1_1 等）原始字串，
      //   侧栏 sidepanel.js:1904 humanizeResLabel 一个都不认，全部 fallback '抖音源'。
      //   优先用宽高构造人话 label（实测 dump：br.width / br.height 直接可用，bitRate0=3840x2160），
      //   humanizeResLabel 二次归一化为 '4K /1080P /720P' 等展示。保持 gearName 兜底以防宽高缺失。
      let q = br.gear_name || br.quality_type || br.gearName
        || ('q' + (br.quality_value != null ? br.quality_value : ''));
      const brW = br.width || (br.play_addr && br.play_addr.width) || (br.playAddr && br.playAddr.width);
      const brH = br.height || (br.play_addr && br.play_addr.height) || (br.playAddr && br.playAddr.height);
      if (brW && brH) {
        const tier = brH >= 2160 ? '4K' : brH >= 1440 ? '2K' : brH >= 1080 ? '1080P'
          : brH >= 720 ? '720P' : brH >= 540 ? '540P' : brH >= 480 ? '480P' : (brH + 'P');
        q = tier + ' ' + brW + 'x' + brH;
      }
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
  // ★2026-09-03：把「按集索引的元数据」持久化到 sessionStorage（同标签页内跨重载存活）。
  //   实测问题：dyVideoUrlByAweme 上一轮明明采到 12 集，切集/重载后变成 0 → 12 张卡一张都生不成，
  //   侧栏只剩通用扫描捡到的"野卡"（title 竟然是网页标题「发现更多精彩视频 - 抖音搜索」）。
  //   原因：window.__hmdao_captures 是页面级全局变量，页面一重载就清空；而合集列表 API
  //   并非每次进页面都会重新请求（命中缓存就不再发网络请求 → fetch/xhr 钩子拦不到）。
  //   sessionStorage 在同一标签页内可跨重载保留，正好兜住这个场景。带 2 小时 TTL 防止跨合集串数据。
  const HMDAO_CAPS_KEY = '__hmdao_caps_v1';
  const HMDAO_CAPS_TTL = 2 * 60 * 60 * 1000;
  let __hmdaoCapsRestored = false;
  function hmdaoRestoreCaps() {
    if (__hmdaoCapsRestored) return;
    __hmdaoCapsRestored = true;
    try {
      const raw = sessionStorage.getItem(HMDAO_CAPS_KEY);
      if (!raw) return;
      const box = JSON.parse(raw);
      if (!box || !box.ts || (Date.now() - box.ts) > HMDAO_CAPS_TTL) return;
      const d = box.data || {};
      const caps = window.__hmdao_captures || (window.__hmdao_captures = {});
      // ★2026-09-05：持久化盒里记录了 mixId 且与当前合集不同 → 这是上一个合集的数据，
      //   恢复进来就是「切换合集后新旧封面来回跳动」的来源之一，直接丢弃。
      if (d.mixId && caps.mixId && String(d.mixId) !== String(caps.mixId)) {
        console.log('[HMDAO][inject] sessionStorage 缓存属于上一合集(' + d.mixId + ')，跳过恢复(当前=' + caps.mixId + ')');
        return;
      }
      let n = 0;
      for (const k of Object.keys(d)) {
        if (d[k] && typeof d[k] === 'object' && !Array.isArray(d[k])) {
          caps[k] = Object.assign({}, d[k], caps[k] || {});
          n += Object.keys(d[k]).length;
        }
      }
      console.log('[HMDAO][inject] 从 sessionStorage 恢复上轮集数元数据，键数=' + n);
    } catch (_) {}
  }
  function hmdaoPersistCaps() {
    try {
      const caps = window.__hmdao_captures;
      if (!caps) return;
      const data = {
        mixId: caps.mixId || '',
        dyCoverByAweme: caps.dyCoverByAweme || {},
        dyTitlesByAweme: caps.dyTitlesByAweme || {},
        dyEpisodeByAweme: caps.dyEpisodeByAweme || {},
        dyVideoUrlByAweme: caps.dyVideoUrlByAweme || {},
        dyFormatsByAweme: caps.dyFormatsByAweme || {},
        dyAudiosByAweme: caps.dyAudiosByAweme || {},
      };
      sessionStorage.setItem(HMDAO_CAPS_KEY, JSON.stringify({ ts: Date.now(), data }));
    } catch (_) {}
  }

  function hmdaoPickCover(v) {
    try {
      if (!v || typeof v !== 'object') return '';
      const cands = [
        v.cover, v.originCover, v.dynamicCover, v.gaussianCover,
        v.coverUrlList, v.cover169UrlList, v.originCoverUrlList,
        v.rawCover, v.blurCover,
      ].reduce((acc, x) => acc.concat(Array.isArray(x) ? x : (x ? [x] : [])), []);
      // ★2026-09-03：封面绝不能是监控/埋点信标（mssdk.bytedance.com/web/common?msToken=...）。
      //   这类 URL 会被当成缩略图传进 /api/media-proxy → 必然 404 → "视频卡缩略图显示失败"。
      // ★2026-09-04 追加：封面绝不能是 HTML/JS/CSS 等【非图片资源】。
      //   实测（用户控制台）：封面被填成
      //     https://lf-zt.douyin.com/obj/uc-assets/zt/@byted/x-storage-web/4.0.5/dist/latest/index.html
      //   这是 x-storage-web 的 iframe 页面（HTML 文档），被当成缩略图后
      //   → /api/media-proxy 去拉 → 422 / ERR_BLOCKED_BY_RESPONSE → 缩略图永远显示不出来。
      const badCover = (s) => /^https?:/i.test(s) === false
        || /\.(html?|js|css|json|txt|xml|svg\+xml)(\?|#|$)/i.test(s)
        || /(mssdk|msToken|ms_appid|slardar|apm\.|beacon|log-sdk|webid|tea\.|toblog|\/web\/common|monitor\.|\/monitor\/|report\.|\/report\?|metrics|\/collect\?|pixel\.)/i.test(s);
      for (const c of cands) {
        if (typeof c === 'string' && /^https?:/i.test(c) && !badCover(c)) return c.replace(/\\\//g, '/');
        if (c && typeof c === 'object') {
          if (Array.isArray(c.url_list) && c.url_list[0]) {
            const s0 = String(c.url_list[0]).replace(/\\\//g, '/');
            if (!badCover(s0)) return s0;
          }
          if (typeof c.src === 'string' && /^https?:/i.test(c.src) && !badCover(c.src)) return c.src.replace(/\\\//g, '/');
          if (typeof c.url === 'string' && /^https?:/i.test(c.url) && !badCover(c.url)) return c.url.replace(/\\\//g, '/');
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
  // ★2026-09-04 降噪计数器（见 hmdaoCaptureDyDetail else 分支）
  const hmdaoZeroHitWarned = {};
  let hmdaoZeroHitWarnedCount = 0;

  // ★2026-09-04 主动拉取合集剧集列表 —— 当下核心问题（合集侧栏只有 1 张卡、无缩略图/标题/集数）的直接解法。
  //   被动拦截只有在用户手动打开「选集」面板时才能看到 /mix/aweme/ 的响应；
  //   现在一旦知道 mix_id 就主动调一次。策略（全部在页面主世界 fetch，自动带登录 Cookie）：
  //     ① 直接 GET（实测部分场景无需签名）
  //     ② window.byted_acrawler.frontierSign(url) 签名后重试（X-Bogus 以查询参数附加）
  //     ③ 都失败 → 静默放弃，保留被动拦截兜底，不打扰用户
  //   成功的响应直接交给 hmdaoCaptureDyDetail 解析（它已支持 aweme_list + 按数组下标编集数），
  //   于是 dyVideoUrlByAweme / dyCoverByAweme / dyTitlesByAweme / dyEpisodeByAweme 一次补齐，
  //   scan.js 的「合集批量合成」自然把 N 张带缩略图/标题/集数的卡建出来。
  let hmdaoMixProbeTried = 0;
  let hmdaoLastMixProbeTs = 0; // ★2026-09-04：30s 冷却，避免每次轮询重复拉 5 页

  // 多来源猜 mix_id：①已捕获 ②RENDER_DATA ③window.player ④页面上的 /collection/ 链接
  function hmdaoGuessMixId(caps) {
    try {
      if (caps.mixId) return String(caps.mixId);
      // URL 查询参数兜底：合集页有时直接把 mix_id / collection_id 带在地址栏
      try {
        const u = new URL(location.href);
        const qid = u.searchParams.get('mix_id') || u.searchParams.get('collection_id') || u.searchParams.get('playlist_id') || u.searchParams.get('series_id');
        if (qid) return String(qid);
      } catch (_) {}
      const el = document.querySelector('script#RENDER_DATA, script[id="RENDER_DATA"]');
      if (el && el.textContent) {
        const d = JSON.parse(decodeURIComponent(el.textContent));
        const app = d && d.app;
        const vd = app && app.videoDetail;
        const mi = (vd && (vd.mixInfo || vd.mix_info)) || (app && (app.mixInfo || app.mix_info)) || null;
        const id = mi && (mi.mixId || mi.mix_id);
        if (id) return String(id);
      }
    } catch (_) {}
    try {
      const p = window.player;
      const cands = [(p && p.videoInfo && (p.videoInfo.mixInfo || p.videoInfo.mix_info)),
        (p && p.video && (p.video.mixInfo || p.video.mix_info)),
        (p && (p.mixInfo || p.mix_info))];
      for (const mi of cands) { const id = mi && (mi.mixId || mi.mix_id); if (id) return String(id); }
    } catch (_) {}
    try {
      const a = document.querySelector('a[href*="/collection/"]');
      if (a) {
        const m = String(a.getAttribute('href') || '').match(/\/collection\/(\d+)/);
        if (m) return m[1];
      }
    } catch (_) {}
    return '';
  }

  function hmdaoTryFetchMixAweme(verbose, force) {
    try {
      const caps = window.__hmdao_captures || (window.__hmdao_captures = {});
      const mid = hmdaoGuessMixId(caps);
      if (mid && !caps.mixId) caps.mixId = mid;
      // ★2026-09-04：30s 冷却 + 20 集上限，避免每次轮询都重复拉 5 页 / 已拉满还拉。
      if (!force && hmdaoLastMixProbeTs && (Date.now() - hmdaoLastMixProbeTs) < 30000) {
        if (verbose) console.log('[HMDAO][mix] 冷却中(<30s)，跳过主动拉取');
        return false;
      }
      const epCount = Object.keys(caps.dyEpisodeByAweme || {}).length;
      if (epCount >= 20) { if (verbose) console.log('[HMDAO][mix] 已足 20 集，跳过'); return true; }
      if (verbose) {
        console.log('[HMDAO][mix] 状态 → mixId=' + (mid || '(空)')
          + ' mixName=' + (caps.mixName || '(空)')
          + ' 已尝试=' + hmdaoMixProbeTried
          + ' 已有集数=' + epCount
          + ' 直链键数=' + Object.keys(caps.dyVideoUrlByAweme || {}).length);
      }
      if (!mid) {
        if (verbose) console.warn('[HMDAO][mix] 拿不到 mix_id → 无法拉取剧集列表（合集页需先打开/播放一次）');
        return false;
      }
      if (!force && hmdaoMixProbeTried >= 2) {
        if (verbose) console.warn('[HMDAO][mix] 已自动尝试 2 次均失败 → 跳过。强制重试：__hmdao_tryMix(true, true)');
        return false;
      }
      // ★2026-09-05 移除旧的「已有 2 集就不再拉」早退：它导致合集列表【永远只补到被动
      //   捕获的 2~3 集】→ 侧栏视频卡数量（1~3 张）远少于合集总集数（42/99 集）。
      //   现在只要 epCount < 20 就一次性把列表拉完（下方 has_more 分页）。
      hmdaoLastMixProbeTs = Date.now();
      hmdaoMixProbeTried++;
      let pages = 0;
      const grab = (cursor, tag, extraQs) => {
        let base = '/aweme/v1/web/mix/aweme/?device_platform=webapp&aid=6383&version_code=170400'
          + '&mix_id=' + encodeURIComponent(mid) + '&cursor=' + cursor + '&count=20';
        if (extraQs) base += '&' + extraQs;
        return fetch(base, { credentials: 'include' })
          .then((r) => {
            if (verbose) console.log('[HMDAO][mix] ' + tag + ' → HTTP ' + r.status);
            return r.ok ? r.json() : null;
          })
          .then((j) => {
            if (!j) { if (verbose) console.warn('[HMDAO][mix] ' + tag + ' 响应非 JSON 或请求失败'); return false; }
            const list = Array.isArray(j.aweme_list) ? j.aweme_list : null;
            if (verbose) {
              console.log('[HMDAO][mix] ' + tag + ' 顶层键=' + Object.keys(j).slice(0, 14).join(',')
                + ' | status_code=' + j.status_code + ' | aweme_list=' + (list ? list.length : '无'));
            }
            if (!list || !list.length) return false;
            hmdaoCaptureDyDetail(j, base);
            pages++;
            console.log('[HMDAO][mix] ✅ ' + tag + ' 第' + pages + '页：' + list.length + ' 集，has_more=' + !!j.has_more);
            hmdaoPersistCaps();
            // ★2026-09-05：5 页(100集)上限不够长合集（实测 133 集），放宽到 10 页(200集)
            if (j.has_more && pages < 10) {
              const nc = (j.cursor != null) ? j.cursor : (pages * 20);
              return grab(String(nc), tag, extraQs);
            }
            return true;
          })
          .catch((e) => { if (verbose) console.warn('[HMDAO][mix] ' + tag + ' 异常：' + (e && e.message)); return false; });
      };
      grab(0, 'unsigned').then((ok) => {
        if (ok) return;
        try {
          const s = window.byted_acrawler;
          if (s && typeof s.frontierSign === 'function') {
            const sg = s.frontierSign('/aweme/v1/web/mix/aweme/?mix_id=' + mid);
            if (verbose) console.log('[HMDAO][mix] frontierSign 返回键=' + (sg ? Object.keys(sg).join(',') : '(空)'));
            if (sg && typeof sg === 'object' && Object.keys(sg).length) {
              const q = Object.keys(sg).map((k) => k + '=' + encodeURIComponent(sg[k])).join('&');
              return grab(0, 'frontierSign', q);
            }
          } else if (verbose) {
            console.warn('[HMDAO][mix] window.byted_acrawler.frontierSign 不存在 → 无签名可用，只能靠被动拦截');
          }
        } catch (e) { if (verbose) console.warn('[HMDAO][mix] 签名分支异常：' + (e && e.message)); }
      });
      return true;
    } catch (e) {
      if (verbose) console.warn('[HMDAO][mix] 顶层异常：' + (e && e.message));
      return false;
    }
  }
  // 诊断手动触发：__hmdao_tryMix(true) 打印详情；__hmdao_tryMix(true, true) 强制重试
  window.__hmdao_tryMix = hmdaoTryFetchMixAweme;
  // ★2026-09-05：供 background.scanTab 在检测到「切换合集」时调用 —— 清掉上一合集的
  //   封面/标题/集数/直链索引与主动拉取计数，防止旧合集卡片混进新合集侧栏。
  window.__hmdao_reset_collection_index = function () {
    try {
      const caps = window.__hmdao_captures || (window.__hmdao_captures = {});
      for (const ik of ['dyCoverByAweme', 'dyFormatsByAweme', 'dyUrlsByAweme', 'dyEpisodeByAweme',
        'dyTitlesByAweme', 'dyAudiosByAweme', 'dyVideoUrlByAweme', 'dyMixIdsByAweme']) caps[ik] = {};
      hmdaoMixProbeTried = 0;
      hmdaoLastMixProbeTs = 0;
    } catch (_) {}
  };

  function hmdaoCaptureDyDetail(j, reqUrl) {
    try {
      hmdaoRestoreCaps(); // 页面重载后先把上轮采集到的集数元数据读回来
      if (!j || typeof j !== 'object') return;
      // ★2026-09-03：合集列表 API 会返回 aweme_list/awemeList/item_list/items 等数组，
      //   其中顺序就是播放列表的「第 1 集 / 第 2 集 …」。按数组下标 + URL 分页偏移建立 awemeId → 绝对集数 索引。
      const arrays = [];
      if (j.aweme_detail) arrays.push([j.aweme_detail]);
      if (j.awemeDetail) arrays.push([j.awemeDetail]);
      if (Array.isArray(j.aweme_list)) arrays.push(j.aweme_list);
      if (Array.isArray(j.awemeList)) arrays.push(j.awemeList);
      if (Array.isArray(j.data)) arrays.push(j.data);
      if (Array.isArray(j.item_list)) arrays.push(j.item_list);
      if (Array.isArray(j.items)) arrays.push(j.items);
      // ★2026-09-04 修复：jingxuan 精选页等场景详情走 /aweme/v2/web/module/feed/ 这类模块化接口，
      //   响应把 aweme 数组包在 module_list / cards / feeds / contents / results 等嵌套字段里，
      //   旧逻辑只认顶层 aweme_list/data → 解析到 0 条 → 批量模式下所有集数卡都没有标题/封面。
      if (Array.isArray(j.module_list)) arrays.push(j.module_list);
      if (Array.isArray(j.moduleList)) arrays.push(j.moduleList);
      if (Array.isArray(j.cards)) arrays.push(j.cards);
      if (Array.isArray(j.feeds)) arrays.push(j.feeds);
      if (Array.isArray(j.contents)) arrays.push(j.contents);
      if (Array.isArray(j.results)) arrays.push(j.results);
      // 兜底：再浅层递归（深度 2）扫一遍，避免未来接口字段改名。
      try {
        const findAwemeArrays = (obj, depth) => {
          if (!obj || typeof obj !== 'object' || depth <= 0) return [];
          const out = [];
          for (const v of Object.values(obj)) {
            if (Array.isArray(v) && v.length && v.some((x) => x && (x.aweme_id != null || x.awemeId != null || x.video))) out.push(v);
            else if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...findAwemeArrays(v, depth - 1));
          }
          return out;
        };
        const seen = new Set(arrays);
        for (const arr of findAwemeArrays(j, 2)) { if (!seen.has(arr)) { arrays.push(arr); seen.add(arr); } }
      } catch (_) {}
      const list = [];
      arrays.forEach((arr) => arr.forEach((x) => list.push(x)));
      const caps = window.__hmdao_captures || (window.__hmdao_captures = {});
      caps.dyCoverByAweme = caps.dyCoverByAweme || {};
      caps.dyFormatsByAweme = caps.dyFormatsByAweme || {};
      caps.dyTitlesByAweme = caps.dyTitlesByAweme || {};
      caps.dyEpisodeByAweme = caps.dyEpisodeByAweme || {};
      let hit = 0;
      // ★2026-09-03：只有「单条详情响应」才用来更新 curAwemeId；
      //   合集/列表 API 会返回多集，取最后一集当 current 会错配（如播放第10集时列表返回 8~13）。
      const isSingleDetail = !!(j.aweme_detail || j.awemeDetail);
      // 合集/播放列表 API 判定：响应含 mix_info / mixInfo / mix_id，或 URL 含 mix/collection/series/playlist
      const reqUrlStr = String(reqUrl || '');
      const hasMixTop = !!(j.mix_info || j.mixInfo || j.mix_id || j.mixId
        || j.collection_info || j.collectionInfo || j.playlist_info || j.playlistInfo
        || j.series_info || j.seriesInfo);
      const urlLikeMix = /\/(mix|collection|series|playlist)\/|mix[_-]id|collection[_-]id|series[_-]id|playlist[_-]id/i.test(reqUrlStr);
      // 列表项本身带 mix_info 也视为合集（部分接口把 mix 信息挂在 item 上）
      const anyItemMix = list.some((x) => x && (x.mix_info || x.mixInfo || x.mix_id || x.mixId));
      const isCollectionList = hasMixTop || urlLikeMix || anyItemMix;
      // 分页偏移：抖音合集接口常用 cursor / offset 参数
      let listOffset = 0;
      try {
        const u = new URL(reqUrl || '', location.href);
        const off = parseInt(u.searchParams.get('cursor') || u.searchParams.get('offset') || '0', 10);
        if (!isNaN(off) && off > 0) listOffset = off;
      } catch (_) {}
      for (const arr of arrays) {
        for (let idx = 0; idx < arr.length; idx++) {
          let a = arr[idx];
          if (!a || typeof a !== 'object') continue;
          // ★2026-09-04 修复（搜索页/推荐流"一个都抓不到"的真凶）：
          //   抖音搜索结果、推荐流、聚合列表的每一项形如
          //     { type: 1, aweme_info: { aweme_id, video, desc, ... } }
          //   真实 aweme 被【包在 aweme_info（或 aweme / item）里】，顶层既没有 aweme_id 也没有 video
          //   → 下面的 `if (!id || !v) continue` 会把每一项统统跳过
          //   → dyVideoUrlByAweme / dyCoverByAweme / dyTitlesByAweme 恒为 0
          //   → 卡片无封面、无标题、无集数，且只能拿到 MSE 的 blob 直链（后台 fetch 必然失败 → "没画面没声音"）。
          //   必须先解包再取字段。
          if (a.aweme_id == null && a.awemeId == null) {
            const wrap = a.aweme_info || a.awemeInfo || a.aweme || a.item || a.data || null;
            if (wrap && typeof wrap === 'object' && (wrap.aweme_id != null || wrap.awemeId != null || wrap.video)) a = wrap;
          }
          const id = (a.awemeId != null) ? String(a.awemeId)
            : (a.aweme_id != null ? String(a.aweme_id) : '');
          const v = a.video;
          if (!id || !v) continue;
          const cov = hmdaoPickCover(v);
          if (cov) caps.dyCoverByAweme[id] = cov;
          const fmts = hmdaoExtractVideoFormats(v);
          if (fmts.length) caps.dyFormatsByAweme[id] = fmts;
          if (a.desc) caps.dyTitlesByAweme[id] = String(a.desc);
          // ★2026-09-03：存当前集的「视频轨直链」（play_addr.url_list[0]）。
          //   抖音 MSE 播放时视频分片常不经过可被拦截的 fetch → dyUrls 经常为空（导致预览"没画面"）。
          //   但详情 API 的 play_addr 是平台本次下发的签名直链，按真实 awemeId 索引后，
          //   即便 dyUrls 为空，scan.js 也能用它对当前集拼出可播放/可预览的视频卡。
          try {
            const vu = (v.play_addr && v.play_addr.url_list && v.play_addr.url_list[0])
              || (v.playAddr && v.playAddr.url_list && v.playAddr.url_list[0])
              || (v.download_addr && v.download_addr.url_list && v.download_addr.url_list[0]) || '';
            if (vu) {
              caps.dyVideoUrlByAweme = caps.dyVideoUrlByAweme || {};
              caps.dyVideoUrlByAweme[id] = String(vu);
            }
          } catch (_) {}
          // ★2026-09-05 修复（"视频 · 第15集 · 第二十二集 菩提破阵救悟空"自相矛盾根因）：
          //   集数此前 = listOffset + idx + 1，即「API 返回数组下标 + cursor 查询参数」。
          //   但抖音合集列表的 cursor 是【分页游标】而非线性集数，且列表常以当前集为中心
          //   返回窗口（播第 22 集时返回 20~25）→ 下标 1..6 被当成第 1..6 集，
          //   与同一对象 desc 里的「第二十二集」直接冲突 —— 标题与集数各说各话。
          //   权威顺序：① desc 里的「第N集」（与卡片标题同源，必然自洽）
          //             ② mix_info.current_episode（抖音自己标注的合集内集数，权威）
          //             ③ API 数组下标（仅兜底、只填补不覆盖）
          const epFromDesc = hmdaoParseEpisodeFromText(a.desc || a.title || '');
          const epFromMix = (function () {
            try {
              const mi = a.mix_info || a.mixInfo || null;
              const ce = mi ? (mi.current_episode != null ? mi.current_episode : mi.currentEpisode) : null;
              return (ce != null && Number(ce) > 0) ? Number(ce) : 0;
            } catch (_) { return 0; }
          })();
          const epFromList = (isCollectionList && arr.length > 1 && !isSingleDetail) ? (listOffset + idx + 1) : 0;
          const epFinal = epFromDesc || epFromMix;
          if (epFinal || epFromList) {
            caps.dyEpisodeByAweme = caps.dyEpisodeByAweme || {};
            if (epFinal) caps.dyEpisodeByAweme[id] = epFinal;
            else if (caps.dyEpisodeByAweme[id] == null) caps.dyEpisodeByAweme[id] = epFromList;
          }
          // ★2026-09-05：记录该 aweme 归属的合集 id，供 scan.js 过滤"非本合集的 feed 脏数据"
          if (isCollectionList) {
            try {
              const mixOfItem = (a.mix_info && (a.mix_info.mix_id || a.mix_info.mixId))
                || (a.mixInfo && (a.mixInfo.mix_id || a.mixInfo.mixId))
                || (j.mix_info && (j.mix_info.mix_id || j.mix_info.mixId))
                || (j.mixInfo && (j.mixInfo.mix_id || j.mixInfo.mixId))
                || j.mix_id || j.mixId || caps.mixId || '';
              if (mixOfItem) {
                caps.dyMixIdsByAweme = caps.dyMixIdsByAweme || {};
                if (!caps.dyMixIdsByAweme[id]) caps.dyMixIdsByAweme[id] = String(mixOfItem);
              }
            } catch (_) {}
          }
          // ★2026-09-01 诊断：记录【详情 API 里 video 对象的真实结构】。
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
          // ★2026-09-03：单条详情才更新 curAwemeId（它代表当前播放的这 1 集）；
          //   列表只用来补全各集元数据/绝对集数，避免 curAwemeId 被列表最后一集污染。
          if (isSingleDetail || arr.length === 1) caps.curAwemeId = id;
          // ★2026-09-04：单条详情里的 mix_info 是「当前合集」的权威标识（mix_id/合集名）
          try {
            if (isSingleDetail) {
              const mi = a.mix_info || a.mixInfo;
              if (mi && typeof mi === 'object') {
                const mid = String(mi.mix_id || mi.mixId || '');
                const mname = String(mi.mix_name || mi.mixName || '');
                if (mid) caps.mixId = mid;
                if (mname && !caps.mixName) caps.mixName = mname;
              }
            }
          } catch (_) {}
          hit += 1;
        }
      }
      // ★2026-09-04：抓「合集」标识与名称（mix_id / mix_name）。
      //   用途：① 主动拉取剧集列表 /mix/aweme/?mix_id=...（见 hmdaoTryFetchMixAweme）
      //         ② 文件名 {合集名}_{第N集}_{标题}.mp4
      try {
        const takeMix = (mi, force) => {
          if (!mi || typeof mi !== 'object') return;
          const mid = String(mi.mix_id || mi.mixId || '');
          const mname = String(mi.mix_name || mi.mixName || '');
          // ★2026-09-05 修复（切换合集后卡片封面在新旧合集间来回跳动的根因）：
          //   检测到【不同的 mix_id】= 用户切到了另一个合集 → 上一合集的封面/标题/集数/直链索引
          //   全部作废（键都是旧合集的 awemeId）。不清的话它们仍会通过 episodeMap 成员检查被合成
          //   进侧栏（「第211集 · 第五十六集」那张串合集卡就是这么来的），且与新一合集数据交替
          //   出现 → 封面跳变。
          if (mid && caps.mixId && String(caps.mixId) !== mid) {
            try {
              console.log('[HMDAO][inject] 检测到切换合集 mixId %s → %s，清空上一合集索引', caps.mixId, mid);
              for (const ik of ['dyCoverByAweme', 'dyFormatsByAweme', 'dyUrlsByAweme', 'dyEpisodeByAweme',
                'dyTitlesByAweme', 'dyAudiosByAweme', 'dyVideoUrlByAweme', 'dyMixIdsByAweme']) caps[ik] = {};
              hmdaoMixProbeTried = 0;
              hmdaoLastMixProbeTs = 0;
            } catch (_) {}
            caps.mixId = mid;
            if (mname) caps.mixName = mname;
          }
          if (mid && (force || !caps.mixId)) caps.mixId = mid;
          if (mname && (force || !caps.mixName)) caps.mixName = mname;
        };
        takeMix(j.mix_info || j.mixInfo, true); // 顶层 mix_info 最权威
        const infos = Array.isArray(j.mix_infos) ? j.mix_infos : null;
        if (infos && infos.length) {
          for (const mi of infos) { takeMix(mi, false); takeMix(mi && (mi.mix_info || mi.mixInfo), false); }
        }
      } catch (_) {}

      if (hit) {
        try { console.log('[HMDAO][inject] dy-detail captured: awemes=' + hit + ' cur=' + caps.curAwemeId + ' fmtKeys=' + Object.keys(caps.dyFormatsByAweme).length + ' epKeys=' + Object.keys(caps.dyEpisodeByAweme).length); } catch (_) {}
        hmdaoPersistCaps(); // 采到就落盘，供下次重载恢复
        setTimeout(() => { try { hmdaoTryFetchMixAweme(); } catch (_) {} }, 800); // mix_id 到手后主动拉剧集列表
      } else {
        // ★2026-09-04 降噪（用户扩展错误页被刷出 36 条垃圾告警的根因）：
        //   /aweme/* 下大量接口与视频无关（social/count、page/turn/offline、multicast/query、
        //   play/progress、get/user/settings、suggest_words……），旧逻辑对它们一律 warn。
        //   现只对【可能承载视频数据】的接口告警，且每路径只一次、全会话最多 3 条。
        try {
          const path = String(reqUrl || '').split('?')[0];
          const VIDEO_BEARING = /aweme\/detail|mix\/aweme|iteminfo|general\/search|aweme\/post|aweme\/detail/i;
          if (VIDEO_BEARING.test(path) && !hmdaoZeroHitWarned[path] && hmdaoZeroHitWarnedCount < 3) {
            hmdaoZeroHitWarned[path] = 1;
            hmdaoZeroHitWarnedCount++;
            const first = (arrays[0] && arrays[0][0]) ? Object.keys(arrays[0][0]).slice(0, 16).join(',') : '(无数组项)';
            console.warn('[HMDAO][inject] dy-detail 命中但解析到 0 条 | url=' + path.slice(0, 88)
              + ' | 顶层键=' + Object.keys(j || {}).slice(0, 12).join(',')
              + ' | 首项键=' + first);
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  // ★2026-09-02 根因修复（当前播放视频「无分辨率 / 选源错 / 缺音频轨」的总入口）：
  //   原 RENDER_DATA 扫描（hmdaoCaptureDyStream 内约 797 行）挂在【成功捕获一条新流】之后，
  //   而视频一旦缓冲完（实测 readyState=4）就【不再发起任何请求】→ 该分支永远不执行 →
  //   fullScanDone 恒 false，dyFormatsByAweme 里只有 XHR feed 抓到的推荐流视频，
  //   【当前 modal 正在播放的视频一个档位都没有】→ 侧栏无分辨率选项、选源退回网络层裸轨
  //   （滤不掉 mime_type=audio_mp4 的音频轨 → 预览「有声音没画面」）。
  //   现提供独立于网络捕获的入口，直接扫 SSR 首屏（app.videoDetail，驼峰结构）。
  //   与 XHR feed 接口（下划线结构，由 hmdaoCaptureDyDetail 负责）互补，互不冲突。
  //   ★实测字段（jingxuan?modal_id=）：
  //     videoDetail.awemeId / video.bitRateList[22]（gearName / playAddr[{src}] / width / height / isH265）
  //     video.playApi                 → 官方含音画播放源（本结构无 download_addr 字段）
  //     video.bitRateAudioList[0].urlList[0].src → 音频轨直链（DASH 合并的另一半）
  //     video.cover / video.originCover → 字符串封面 URL
  function hmdaoScanDyRenderData() {
    try {
      const el = document.querySelector('script#RENDER_DATA, script[id="RENDER_DATA"]');
      if (!el || !el.textContent) return;
      // ★2026-09-04 修复（页面卡顿 + 日志洪水真凶，用户 profiler 实测 5 分钟 596 次）：
      //   RENDER_DATA 是服务端首屏数据，切集(SPA)后不会刷新（见下方注释）。
      //   但本函数被定时器反复调用，每次都 JSON.parse 整份大 JSON 并遍历 bitRateList
      //   → 主线程持续高负载 → 抖音视频播放卡顿；且每次都打一条日志（几万条消息）。
      //   修复：按 textContent.length 做廉价指纹，内容没变就直接返回（每页只真正解析一次）。
      const ssrSig = el.textContent.length;
      if (window.__hmdaoSsrSig === ssrSig) return;
      window.__hmdaoSsrSig = ssrSig;
      let data = null;
      try { data = JSON.parse(decodeURIComponent(el.textContent)); } catch (_) {
        try { data = JSON.parse(el.textContent); } catch (_) { return; }
      }
      const vd = data && data.app && data.app.videoDetail;
      if (!vd) return;
      const id = String(vd.awemeId || '');
      if (!id) return;
      const caps = window.__hmdao_captures || (window.__hmdao_captures = {});
      caps.dyFormatsByAweme = caps.dyFormatsByAweme || {};
      caps.dyCoverByAweme = caps.dyCoverByAweme || {};
      caps.dyTitlesByAweme = caps.dyTitlesByAweme || {};
      const v = vd.video;
      if (v) {
        const fmts = hmdaoExtractVideoFormats(v);
        // playApi = 官方含音画播放源（本 SSR 结构没有 download_addr，用它等价替代）
        const api = (typeof v.playApi === 'string' ? v.playApi : '');
        if (api) {
          fmts.push({ label: '下载源(含音画)', url: api, is_default: true });
          // ★2026-09-02：消除重复 is_default。hmdaoExtractVideoFormats 末尾会把 out[0]（按 height 降序，
          //   多数情况下是 4K / 2K）设为默认，与 playApi 重复 → 弹窗出现两个「默认画质」。
          //   保留 playApi 为唯一默认（官方含音画源、必下得到）；其他档位仅作可选。
          for (let i = 0; i < fmts.length - 1; i++) fmts[i].is_default = false;
        }
        if (fmts.length) caps.dyFormatsByAweme[id] = fmts;
        const cov = (typeof v.cover === 'string' && v.cover) ? v.cover
          : (typeof v.originCover === 'string' ? v.originCover : '');
        if (cov) caps.dyCoverByAweme[id] = cov.replace(/\\\//g, '/');
        if (vd.desc) caps.dyTitlesByAweme[id] = String(vd.desc);
        // ★音频轨直链：DASH 分离轨合并的另一半，此前只能靠网络层碰运气捞 mime_type=audio_mp4
        const au = (v.bitRateAudioList && v.bitRateAudioList[0]) || null;
        const auUrl = (au && au.urlList && au.urlList[0] && au.urlList[0].src) || '';
        if (auUrl) {
          caps.dyAudios = caps.dyAudios || [];
          if (!caps.dyAudios.some((x) => x && x.url === auUrl)) {
            caps.dyAudios.push({ url: auUrl, ts: Date.now(), awemeId: id });
          }
        }
      }
      // ★2026-09-03：不再用 RENDER_DATA 的 videoDetail.awemeId 更新 curAwemeId。
      //   jingxuan modal 是 SPA，RENDER_DATA 为服务端首屏数据，切集后不会刷新；
      //   若用它兜底写入 curAwemeId，会把旧集（如第8集）锁死成「当前播放」，导致侧栏永远显示旧集。
      //   curAwemeId 现由「单条详情 API」+「currentSrc 反查」+「末条视频轨兜底」共同维护，更准。
      try { console.log('[HMDAO][inject] dy-ssr scanned: id=' + id + ' fmtKeys=' + Object.keys(caps.dyFormatsByAweme).length); } catch (_) {}
    } catch (_) {}
  }
  // ★2026-09-02 幂等自愈轮询（替代原先的单次 setTimeout）：
  //   实测：注入脚本在 SPA 路由变化时执行 delete window.__hmdao_captures 并重建（约 93 行），
  //   单次 setTimeout 写入的 curAwemeId / 档位会被随后的重置【整体冲掉】——这正是上一轮
  //   "日志显示扫描成功、但查出来 curAwemeId 为空"的原因（本函数幂等，手动再调一次立刻有值）。
  //   改为轮询：只要发现 curAwemeId 为空就重新填充；连续 3 次观测到非空即停止，避免长期空转；
  //   另设 60s 无条件停止兜底。SPA 切集场景仍由 hmdaoCaptureDyDetail 补位。
  try {
    let ssrOk = 0;
    const ssrTimer = setInterval(() => {
      try {
        if (window.__hmdao_captures && window.__hmdao_captures.curAwemeId) {
          if (++ssrOk >= 3) { try { clearInterval(ssrTimer); } catch (_) {} }
          return;
        }
        hmdaoScanDyRenderData();
      } catch (_) {}
    }, 1500);
    setTimeout(() => { try { clearInterval(ssrTimer); } catch (_) {} }, 60000);
  } catch (_) {}
  // ★2026-09-03：常驻轮询——用 window.player 持续刷新「当前播放集」awemeId/标题/封面。
  //   覆盖 SPA 切集后 RENDER_DATA/列表 API 不刷新的场景；与上面 ssrTimer 互补（后者只填首次空窗）。
  try {
    setInterval(() => {
      try {
        // ★2026-09-09（源页零开销硬约束）：后台标签不做常驻轮询，避免在用户看不到的
        //   页面上持续读播放器状态。切回前台后下一拍（≤1s）立即恢复，前台行为完全不变。
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        hmdaoRefreshCurFromPlayer();
      } catch (_) {}
    }, 1000);
  } catch (_) {}
  // 暴露到 window：便于页面控制台手动触发排查（__hmdao_captures 被注入重置后可再次填充）。
  try { window.__hmdaoScanDyRenderData = hmdaoScanDyRenderData; } catch (_) {}
  try { window.__hmdao_refreshCurFromPlayer = hmdaoRefreshCurFromPlayer; } catch (_) {}
  // ★2026-09-03：诊断函数——在页面控制台执行 __hmdao_diagDouyinCurrent() 可查看当前集识别情况，
  //   便于排查「封面/标题仍不匹配」时 window.player 的结构（若 awemeId 仍取不到，把输出贴回即可定位）。
  try {
    window.__hmdao_diagDouyinCurrent = function () {
      const caps = window.__hmdao_captures || {};
      const found = hmdaoFindAwemeInPlayer();
      const pl = hmdaoFindPlaylistEpisode();
      const p = window.player;
      let pKeys = [];
      try { pKeys = p && typeof p === 'object' ? Object.keys(p).slice(0, 40) : []; } catch (_) {}
      return {
        curAwemeId: caps.curAwemeId || '',
        playerExists: !!p,
        playerTopKeys: pKeys,
        playerFoundAweme: found,
        playerFoundVideoUrl: (found && found.videoUrl) || '',
        playlistFound: pl,
        titleKeys: Object.keys(caps.dyTitlesByAweme || {}).slice(0, 20),
        coverKeys: Object.keys(caps.dyCoverByAweme || {}).slice(0, 20),
        episodeKeys: caps.dyEpisodeByAweme || {},
        urlByAwemeKeys: Object.keys(caps.dyUrlsByAweme || {}).slice(0, 20),
        videoUrlByAwemeKeys: Object.keys(caps.dyVideoUrlByAweme || {}).slice(0, 20),
        audioByAwemeKeys: Object.keys(caps.dyAudiosByAweme || {}).slice(0, 20),
        dyUrlsCount: (caps.dyUrls || []).length,
        dyAudiosCount: (caps.dyAudios || []).length,
      };
    };
  } catch (_) {}

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
        // ★2026-09-03：音频轨按「当前集锚点」索引，确保与视频轨同源配对（切集后精确合成本集音画）。
        //   锚点优先用已检测到的真实 awemeId（window.player / 详情 API），否则退回 URL 的 modal_id。
        let anchor = '';
        try {
          if (cA.curAwemeId && cA.curAwemeId !== 'unknown' && !/^fp:/.test(cA.curAwemeId)) anchor = cA.curAwemeId;
          else {
            const pa = new URL(location.href);
            anchor = pa.searchParams.get('modal_id') || pa.searchParams.get('aweme_id') || '';
          }
        } catch (_) {}
        if (!cA.dyAudios.some((x) => x && x.url === clean)) {
          cA.dyAudios.push({ url: clean, ts: Date.now(), awemeId: anchor });
          if (cA.dyAudios.length > 50) cA.dyAudios.shift();
        }
        // ★按锚点索引音频轨直链，供 scan.js 直接取本集音频做 DASH 合并（无需再按时间配对，更稳）
        cA.dyAudiosByAweme = cA.dyAudiosByAweme || {};
        if (anchor) cA.dyAudiosByAweme[anchor] = clean;
        // ★同时按 URL 的 modal_id 兜底索引（jingxuan 锚点对所有集稳定），保证切集后最新音频一定能按此键取到。
        try {
          const pa = new URL(location.href);
          const mId = pa.searchParams.get('modal_id') || pa.searchParams.get('aweme_id') || '';
          if (mId) cA.dyAudiosByAweme[mId] = clean;
        } catch (_) {}
        return;
      }
      // 去重：不重复添加同一 URL
      if (window.__hmdao_captures.dyUrls.indexOf(clean) < 0) {
        window.__hmdao_captures.dyUrls.push(clean);
        // ★2026-09-03：限长，避免单集内无限堆积分片（旧分片签名过期变废卡）。与 dyAwemes/dyPlayback/dyUrlTs 同步裁剪。
        if (window.__hmdao_captures.dyUrls.length > 12) {
          window.__hmdao_captures.dyUrls.shift();
          if (Array.isArray(window.__hmdao_captures.dyAwemes)) window.__hmdao_captures.dyAwemes.shift();
          if (Array.isArray(window.__hmdao_captures.dyPlayback)) window.__hmdao_captures.dyPlayback.shift();
          if (Array.isArray(window.__hmdao_captures.dyUrlTs)) window.__hmdao_captures.dyUrlTs.shift();
        }
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
            // ★2026-09-03：按 awemeId 索引「视频轨直链」，供侧栏实时匹配当前集（切集后精确取本集 url，不再取错/取旧）
            try {
              if (aid && aid !== 'unknown' && !/^fp:/.test(aid)) {
                window.__hmdao_captures.dyUrlsByAweme = window.__hmdao_captures.dyUrlsByAweme || {};
                window.__hmdao_captures.dyUrlsByAweme[aid] = clean;
              }
            } catch (_) {}
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
  // 扫描响应文本里出现的 mp4/webm/m3u8 等直链，去重存入 apiVideos；同时捕获同响应体中
  // 与每条视频直链邻近的封面 URL，供 scan.js 精确配对（解决 liblib 多视频卡封面错配/缺失）。
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
      const pairs = window.__hmdao_captures.apiVideoPairs = window.__hmdao_captures.apiVideoPairs || {};
      const titles = window.__hmdao_captures.apiVideoTitles = window.__hmdao_captures.apiVideoTitles || {};
      let m;
      API_VIDEO_RE.lastIndex = 0;
      while ((m = API_VIDEO_RE.exec(text)) && arr.length < 100) {
        const u = m[0];
        if (arr.indexOf(u) < 0) {
          arr.push(u);
          if (arr.length > 100) arr.shift();
        }
        // ★2026-09-11→重写（liblib 封面 404 + 重复根因）：
        //   旧逻辑在视频直链 ±800 字符窗口取"第1张图"，对 liblib 抓到 master.jpg / 720p/index.jpg /
        //   seg001.jpg 等分片缩略图（热链 404，且多视频共用→重复封面）。
        //   改为在 ±4096 窗口内优先提取媒体对象【结构化 cover/poster/thumbnail 字段】做封面，
        //   并拒绝分片缩略图路径；同时提取结构化 title/name 字段写入 apiVideoTitles，多平台通用。
        try {
          const winStart = Math.max(0, m.index - 4096);
          const winEnd = Math.min(text.length, m.index + m[0].length + 4096);
          const win = text.slice(winStart, winEnd);
          const winOff = m.index - winStart;
          if (!pairs[u]) {
            // 结构化封面字段：优先 cover/poster/thumbnail，其次 img/image/pic/preview/snapshot
            const COVER_KEY_PRIORITY = ['cover', 'poster', 'thumbnail', 'first_frame', 'firstframe', 'cover_url', 'poster_url', 'coverimg', 'coverimage', 'img', 'image', 'pic', 'preview', 'snapshot', 'screenshot', 'thumb'];
            // 分片/帧缩略图路径（liblib 的 master.jpg / 720p/index.jpg / seg001.jpg 等）热链 404，必须拒绝
            const SEG_THUMB_RE = /\/(720p|1080p|540p|480p|360p|240p|144p|4k|2k|hd|sd|fhd|uhd)\//i
              | /master\.jpg$/i | /index\.jpg$/i | /seg\d+\.jpg/i | /frame_\d+/i | /\/frames\//i;
            const COVER_FIELD_RE = /"(cover|poster|thumbnail|first_frame|firstframe|cover_url|poster_url|coverimg|coverimage|img|image|pic|preview|snapshot|screenshot|thumb)"\s*:\s*"([^"]+\.(?:jpg|jpeg|png|webp|avif|gif)(?:[^"]*)?)"/gi;
            let bestCover = null, bestScore = Infinity;
            let cm;
            COVER_FIELD_RE.lastIndex = 0;
            while ((cm = COVER_FIELD_RE.exec(win))) {
              const key = (cm[1] || '').toLowerCase();
              const url = cm[2];
              const rank = COVER_KEY_PRIORITY.indexOf(key);
              if (rank < 0) continue;
              if (SEG_THUMB_RE.test(url)) continue; // 拒绝分片缩略图（404/重复源）
              const dist = Math.abs(cm.index - winOff);
              const score = rank * 100000 + dist; // 优先高优先级 key，其次就近
              if (score < bestScore) { bestScore = score; bestCover = url; }
            }
            if (bestCover) pairs[u] = bestCover;
          }
          if (!titles[u]) {
            const TITLE_FIELD_RE = /"(?:title|name|caption|video_name|work_name|videoName|workName)"\s*:\s*"([^"]{1,200})"/i;
            const tm = TITLE_FIELD_RE.exec(win);
            if (tm && tm[1]) titles[u] = tm[1].replace(/\\"/g, '"').replace(/\s+/g, ' ').trim().slice(0, 120);
          }
        } catch (_) {}
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
                    try { hmdaoCaptureDyDetail(j, url); } catch (_) {}
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
    //   XMLHttpRequest.prototype.open/send。任何其他站点（花瓣等）**完全不重写 XHR prototype** ——
    //   这样网站自身 XHR 报错的调用栈里绝不会出现 XMLHttpRequest.open @ inject-main，
    //   从根本上消除"扩展引起错误"的误判。
    //   ★★2026-09-02【本注释的原结论已被实测推翻，请勿据此改回】：
    //   原注释称"抖音页视频流走 fetch+MSE、已由 fetch 钩子覆盖，故抖音页不重写 XHR"。
    //   实测（performance.getEntriesByType('resource') 看 initiatorType）：抖音 /aweme/v1/web/*
    //   详情接口 17 次【全部 xmlhttprequest】、fetch 0 次 → 抖音页不 hook XHR 会导致详情响应
    //   永远读不到，分辨率/封面/标题全空。抖音域现已加入本钩子，详见下方 2026-09-02 注释。
    var isYtBili = /(^|\.)youtube\.com$/.test(location.hostname) || /(^|\.)bilibili\.com$/.test(location.hostname);
    // ★2026-09-02 根因修复（侧栏「无分辨率选项 / 无封面」）：
    //   实测手段：performance.getEntriesByType('resource') 看 initiatorType，抖音 /aweme/v1/web/*
    //   详情接口实测 17 次【全部 xmlhttprequest】、fetch 0 次。而旧代码基于「抖音视频流走
    //   fetch+MSE、已由 fetch 钩子覆盖」的错误假设，在抖音页【完全不重写 XHR prototype】
    //   → 详情响应体永远读不到 → dyFormatsByAweme / dyCoverByAweme 恒空 → 拿不到 bitRateList
    //   → 侧栏没有 1080p 等档位可选。现对抖音域一并启用 XHR 钩子，仅用于「详情 API 响应捕获」
    //   （与上方 fetch 分支 995-1008 完全对称）。
    //   ★代价：抖音个别同步 XHR 的报错栈会多出一层 XMLHttpRequest.open @ inject-main。
    //   仅为调试观感问题、不影响功能；包装函数原样透传全部参数，不改变页面任何行为。
    var isDyHost = /(^|\.)douyin\.com$/.test(location.hostname) || /(^|\.)tiktok\.com$/.test(location.hostname);
    if (!isYtBili && !isDyHost) {
      // 非 YT/B站/抖音：不碰 XHR，直接跳过整个包装块。
    } else {
    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, asyncRest) {
      try {
        if (typeof url === 'string') hmdaoCaptureYtStream(url);
        if (typeof url === 'string') hmdaoCaptureDyStream(url); hmdaoCaptureTikTokStream(url);
        // ★2026-09-02：抖音详情接口标记（供 send 阶段读取响应体）。
        //   正则与上方 fetch 分支保持一致。jingxuan 精选页实测【既没有 aweme/detail 也没有
        //   iteminfo】（14 条 /aweme/ XHR 全部是周边接口），详情数据走 /aweme/v2/web/module/feed/
        //   这类模块化接口，故必须按 /\/aweme\// 宽匹配，否则一个都命中不了。
        if (isDyHost && typeof url === 'string' && /\/aweme\/|iteminfo/i.test(url)) this._hmdao_dyDetailUrl = url;
        var isGV = typeof url === 'string' && /googlevideo\.(com|localhost)\/videoplayback/.test(url);
        if (isGV) this._hmdao_gvUrl = url;
        var isBili = typeof url === 'string' && /bilibili\.com\/x\/(web-interface\/view|player\/playurl|player\/wbi\/playurl|space\/acc\.info)/.test(url);
        var isYT = typeof url === 'string' && /youtube\.com\/youtubei\/v1\/player/.test(url);
        if (isBili || isYT) this._hmdao_ytUrl = url;
      } catch (_) {}
      return origOpen.call(this, method, url, asyncRest);
    };
    XMLHttpRequest.prototype.send = function (body) {
    // 此处在 YT/B站/抖音 域执行（外层 isYtBili || isDyHost 已保证）；抖音分支只做详情响应捕获。
    var self = this;
    var gvUrl = self._hmdao_gvUrl;
    var ytUrl = self._hmdao_ytUrl;
    // ★2026-09-02：抖音详情响应捕获 —— 分辨率 bitRateList / 封面 / 标题的唯一真实来源。
    //   只读 responseText 再 JSON.parse，【不改写 responseType、不消费 response】，对页面零副作用；
    //   非 JSON（protobuf）或不含 aweme 结构的响应由 hmdaoCaptureDyDetail 内部自然跳过。
    //   同步 XHR 同样会派发 load / readystatechange，故两种请求形态都能覆盖；dyDone 防重复解析。
    if (self._hmdao_dyDetailUrl) {
      var dyDone = false;
      var grabDy = function () {
        if (dyDone) return;
        dyDone = true;
        try {
          if (!self.responseText) return;
          hmdaoCaptureDyDetail(JSON.parse(self.responseText), self._hmdao_dyDetailUrl);
        } catch (_) {}
      };
      self.addEventListener('load', grabDy);
      self.addEventListener('readystatechange', function () { if (self.readyState === 4) grabDy(); });
    }
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
