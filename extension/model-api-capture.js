// MAIN-world 拦截器（由 manifest 以 "world":"MAIN" 注入模型/资源站）。

// ===== B站播放页熔断（兼容 B站原生播放器）=====
// 实测：在 B站视频播放页（bilibili.com/video/）即便只「监听」fetch/XHR 响应，
// 也会因微任务时序变化导致 B站播放器读取 playurl 配置（nc_policy / reward_pcdn_loader_policy）
// 时对象为 undefined，进而视频加载失败。为彻底兼容，B站播放页直接跳过全部 patch，
// 让扩展在该页面 100% 静默（与「无扩展」行为完全一致）。侧栏采集仍可在 B站列表/首页页工作，
// 但不在视频播放页注入。
function __hmdao_isBiliPlayPage() {
  try {
    const h = location.hostname || '';
    return (h.endsWith('bilibili.com') || h.endsWith('b23.tv')) && /\/(video|blackboard\/.*play|festival)\//.test(location.pathname);
  } catch (_) { return false; }
}

// ★抖音/TikTok 播放页熔断（2026-08-02 起，2026-08-18 放宽）：
// 不再整站 100% 静默，仅「专属观看页」（路径以 /video/ 开头，如 douyin.com/video/<id>）静默，
// 以兼容原生播放器的 fetch/XHR 时序。列表/精选(jingxuan?modal_id=)/用户页/v.douyin.com 播放器
// iframe 等不再熔断，可直接被捕获脚本注入（采集视频/音效/CDN 直链）。
function __hmdao_isDouyinPlayPage() {
  try {
    const h = location.hostname || '';
    const p = location.pathname || '';
    if (/(^|\.)douyin\.com$/.test(h) && /^\/video\//.test(p)) return true;
    if (/(^|\.)tiktok\.com$/.test(h) && /^\/video\//.test(p)) return true;
    return false;
  } catch (_) { return false; }
}

// ★媒体播放主站熔断（2026-08-12 修复：开启扩展后第三方视频/音乐站报错的根因）。
// 这些站点（优酷/腾讯/爱奇艺/芒果/搜狐/咪咕/B站(全站)/YouTube(全站)/抖音/音乐类）的播放器
// 对 fetch/XHR 微任务时序极敏感，任何对 window.fetch / XMLHttpRequest 的包裹都会改变
// Promise 链结构，导致播放器自身中间件超时（如 youku-player 的 "jump the middleware maxTimeout"）、
// 广告/统计脚本 CORS 失败、AudioContext 警告等。进入即 100% 跳过全部 patch，与「无扩展」完全一致。
function __hmdao_isMediaPlaySite() {
  try {
    const h = location.hostname || '';
    return (
      /(^|\.)youku\.com$/.test(h) ||
      /(^|\.)iqiyi\.com$/.test(h) ||
      /(^|\.)letv\.com$/.test(h) || /(^|\.)le\.com$/.test(h) ||
      /(^|\.)mgtv\.com$/.test(h) || /(^|\.)hunanrm\.com$/.test(h) ||
      /(^|\.)sohu\.com$/.test(h) ||
      /(^|\.)miguvideo\.com$/.test(h) || /(^|\.)咪咕/.test(h) ||
      /(^|\.)bilibili\.com$/.test(h) || /(^|\.)b23\.tv$/.test(h) ||
      /(^|\.)youtube\.com$/.test(h) || /(^|\.)youtu\.be$/.test(h) ||
      // 抖音/TikTok 已从「整站熔断」移除：仅由 __hmdao_isDouyinPlayPage 针对专属观看页(/video/)静默，
      // 列表/精选(jingxuan)/用户页/v.douyin.com 播放器 iframe 均允许注入捕获（2026-08-18 放宽）。
      /(^|\.)tencentvideo\.com$/.test(h) || /(^|\.)v\.qq\.com$/.test(h) ||
      /(^|\.)kuaishou\.com$/.test(h) ||
      /(^|\.)weibo\.com$/.test(h) ||
      /(^|\.)qq\.com$/.test(h) || // 腾讯视频/音乐/新闻等大量子域统一跳过
      /(^|\.)netease\.com$/.test(h) || /(^|\.)music\.163\.com$/.test(h) || // 网易云音乐
      /(^|\.)kugou\.com$/.test(h) ||
      /(^|\.)kuwo\.cn$/.test(h) ||
      /(^|\.)ximalaya\.com$/.test(h)
    );
  } catch (_) { return false; }
}

// ★2026-08-24 站点条件化（彻底消除素材站错误栈里的 model-api-capture 署名）：
//   model-api-capture.js 以 MAIN world 注入「模型/设计素材站 + 抖音/TikTok」(manifest matches)。
//   这些站的「模型 API 视频直链」几乎都走 fetch —— 已由下方 fetch patch 完整捕获。
//   重写 XMLHttpRequest.prototype.open/send 纯属「额外署名点」：站点自身 XHR（统计/clarity/分析）
//   一旦失败，错误栈里就会挂上 model-api-capture.js:687，让用户误以为扩展在报错（实际是站点自身 bug）。
//   故：model-api-capture 在这些 matches 站点【完全不重写 XHR】，XHR 捕获需求统一由 fetch patch 覆盖。
//   返回 false = 不重写 XHR（当前所有 matches 站均不重写；若未来需支持仅靠 XHR 的老音频站，
//   在此白名单放行即可，不影响现有 fetch 捕获链路）。
function __hmdao_isXhrCaptureSite() {
  try {
    const h = location.hostname || '';
    // 当前留空：模型/设计素材站（huaban/zcool/artstation/modelbox）与抖音/TikTok 均不需要 XHR 捕获。
    // 如有仅靠 XHR 的老音频站，在此追加白名单（如 /(^|\.)aigei\.com$/ 等）。
    return false;
  } catch (_) { return false; }
}

// 仅音效/音频素材站才启用「通用音频 fetch/XHR 捕获」（避免全站 wrap 的时序副作用）。
function __hmdao_isAudioCaptureSite() {
  try {
    const h = location.hostname || '';
    return (
      /(^|\.)aigei\.com$/.test(h) ||
      /(^|\.)soundcloud\.com$/.test(h) ||
      /(^|\.)freepd\.com$/.test(h) ||
      /(^|\.)freesound\.org$/.test(h) ||
      /(^|\.)mixkit\.co$/.test(h)
    );
  } catch (_) { return false; }
}


// ★2026-09-09 站点分级（源页零干扰硬约束）
// manifest 恢复 <all_urls> 是为了不丢任何站点的采集能力（模型/归档/音效/网盘），
// 但这也让「持续型重量钩子」—— fetch 响应体克隆扫描 + 全文档 MutationObserver ——
// 进入所有普通网站（电商/文档/后台/社交/协同编辑等）。这些页面没有可采集的
// 模型/归档资产，钩子却要为每个 JSON 响应多读一遍 body、为每次 DOM 变更回调
// querySelectorAll，属于纯损耗，违反「不得对源页造成任何负面影响」的边界。
// 故：重量钩子只在扩展真正的采集目标站装载；其余站点 100% 静默（与无扩展完全一致）。
// 轻量旁路（音频 URL 记录、网络层 webRequest 捕获）不受影响，采集能力不降级。
// ★2026-09-10 关于 MSN（msn.cn / msn.com）——刻意【不】列入本白名单，走温和模式：
//   曾把 MSN 列入以强化 API 响应体扫描（它是纯 CSR 站），但真机日志证明这是过度改动：
//     · scan.js 的 DOM 解析【已独立产出 58 条素材】+ 网络层并入 8 条视频直链，采集完全够用；
//     · 列入后 MSN 页面上【每一个 fetch 响应】都会被立即 clone().text() 同步读取，
//       其中包含大量视频/广告相关请求——既增加源页主线程负担，又可能与播放器已锁定的
//       流冲突（clone 抛错），违反「不得影响源页正常播放」的硬边界。
//   结论：MSN 走温和模式（空闲期处理 + 后台标签跳过），采集能力不变，源页零额外开销。
const __HMDAO_TARGET_HOST_RE = /(^|\.)(aigei\.com|biaozhiku\.com|gfxcamp\.com|tripo3d\.com|meshy\.ai|sketchfab\.com|poly\.pizza|civitai\.com|baidu\.com|quark\.cn|aliyundrive\.com|lanzou\.com|xunlei\.com|weiyun\.com|123pan\.com|189\.cn|ctfile\.com|blueidea\.com|tuicool\.com|zsjzt\.com|modelbox\.cn|artstation\.com|huaban\.com|zcool\.com\.cn|douyin\.com|iesdouyin\.com|tiktok\.com|jianying\.com|imini\.ai|canva\.cn|canva\.com|liblib\.art|liblibai-online\.liblib\.cloud|soundcloud\.com|freepd\.com|freesound\.org|mixkit\.co)$/i;
function __hmdao_isCaptureTargetSite() {
  try { return __HMDAO_TARGET_HOST_RE.test(location.hostname || ''); } catch (_) { return false; }
}

// 温和模式调度器：把「非紧急」的采集工作推到浏览器空闲期执行；后台标签直接丢弃。
// 用于非目标站的 DOM 变更处理与响应体扫描，确保不与页面主线程抢时间（零卡顿），
// 同时功能不打折——空闲期到就会执行，只是不在关键路径上。
function __hmdaoScheduleIdle(job) {
  try {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => { try { job(); } catch (_) {} }, { timeout: 2000 });
      return;
    }
  } catch (_) {}
  try { setTimeout(() => { try { job(); } catch (_) {} }, 300); } catch (_) {}
}

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
  if (__hmdao_isMediaPlaySite()) return; // 媒体播放主站熔断：100% 静默，不破坏播放器 fetch 时序
  if (__hmdao_isBiliPlayPage()) return; // B站播放页熔断：不 patch，兼容原生播放器
  if (__hmdao_isDouyinPlayPage()) return; // 抖音/TikTok 播放页熔断：不 patch，兼容原生播放器
  // 目标站 = 立即模式（采集实时性优先）；其它站 = 温和模式（空闲期处理，源页零卡顿优先）
  window.__hmdao_liteMode = !__hmdao_isCaptureTargetSite();
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
      // ★2026-08-18 优化：对「与素材采集无关」的请求零侵入，让错误栈恢复为平台自身文件署名。
      //   核心问题：扩展在 document_start 重写了 window.fetch，导致抖音页面里那些【本身就会失败】
      //   的请求（埋点 CORS、bytedance:// / bitbrowser:// scheme 启动、TrustedScript 报告等）的
      //   错误栈第一行变成 model-api-capture.js，造成「开扩展才报错」的假象。这些报错内容全是
      //   抖音页面自身行为（扩展一行都没触发、也没改这些请求），错误栈被改写只是因为 fetch
      //   包装器函数体本身出现在栈顶帧。
      //   边界原则：① 不改变任何请求行为（零侵入）；② 仅对「非媒体/非模型」请求直接透传原生
      //   fetch，使栈顶帧回到抖音文件；③ 媒体/模型请求仍正常被捕获（保留采集能力）。
      let host = '';
      const isHttp = /^https?:\/\//i.test(url);
      try { host = new URL(url).hostname; } catch (_) {}
      // 跳过条件：非 http(s) 的 scheme（bytedance://、bitbrowser:// 等深链启动）+ 抖音站内噪声域。
      const isSchemeLaunch = !isHttp && /^[a-z][a-z0-9+.-]*:\/\//i.test(url); // 非 http(s) 协议
      const isDouyinNoise = /(zijieapi\.com|mon\.|analytics|metrics|collect|track|sentry|log\.)/i.test(url || host)
        || /(security\.zijieapi|douyin\.com|iesdouyin\.com|tiktok\.com)/i.test(host)
           && !/(douyinpic|bytecdn|douyinstatic|douyinvod|v26-web|bytedance\.com\/.*\.(mp4|webm|m4a|mp3))/i.test(url);
      if (isSchemeLaunch || isDouyinNoise) {
        // 直接返回原生 fetch，不创建任何 then 包装 → 错误栈指向平台自身文件，控制台安静；
        // 同时避免无谓的微任务开销。
        return orig.apply(this, arguments);
      }
      let p;
      try {
        p = orig.apply(this, arguments);
      } catch (e) {
        throw e; // 保持原生同步异常语义（如非法 URL）
      }
      // ★通用音频捕获（WebAudio 按钮音效等走 fetch→decodeAudioData，不经 <audio> 元素）：
      // URL 带音频扩展名立即记录；无扩展名接口靠响应 content-type: audio/* 旁路判定。
      try { if (window.__hmdao_remember_audio && /\.(mp3|wav|flac|aac|m4a|ogg|opus|wma)([?#]|$)/i.test(url)) window.__hmdao_remember_audio(url, 'fetch'); } catch (_) {}
      // ★爱给等音效站 best-effort：防盗链接口常「无扩展名 + content-type 非 audio/*」，
      // 被动钩子会整条漏抓。这里按 host(媒体子域) + URL 路径(疑似播放接口) 或「签名参数」推断为音频并记录，
      // 零副作用（仅观察，不主动请求/播放）。2026-08-01 / 强化 2026-08-01。
      try {
        if (window.__hmdao_remember_audio) {
          let h = '';
          try { h = new URL(url).hostname; } catch (_) {}
          if (/(^|\.)aigei\.com$/i.test(h) || /(^|\.)aigei\.com$|alicdn\.com$|aliyuncs\.com$|aliyun\.com$|oss-/.test(url)) {
            const aigeiAudioPath = /\/(play|listen|voice|media|file|get|download|resource|api\/|bgm|effect|sfx|sound|yinxiao|bmg|music|mp3|wav|m4a|ogg)(\/|$|[?#])/i;
            // ★根因修复（2026-08-01）：旧版 aigeiNotAudio 把路径含 /class/ 的 URL 全排除，
            // 但爱给【分类页 /sound/class/ 内点试听】发出的播放请求路径也含 class（如 .../class/xxx/play?e=..&token=..），
            // 被一并误杀 → 重构后分类页试听采不到（重构前靠 webRequest 网络层不区分路径能采到）。
            // 修正：仅当「纯导航页」（路径停在 class/list/index 等导航段、且不含播放接口段、无签名参数）才排除；
            // 一旦命中播放接口路径或带音频签名参数，无论是否含 class，都判为音频。
            const aigeiNavOnly = /\/(class|index|list|category|search|tag|rank|topic)\/?$/i;
            // 真实爱给试听接口形如 ...?e=171xxxx&token=xxx（限时签名 URL，无扩展名、content-type 非 audio/*）。
            // 这类 URL 即使路径不在白名单，只要带音频签名参数即判为音频，彻底覆盖登录后点击试听漏抓。
            // ★且爱给真实音频常托管在 alicdn/OSS 外域 CDN（路径不含 aigei.com），故外域 CDN + 签名参数也记。
            const aigeiSigned = /[?&](e|token|t|sign|sk|expire|expires|k|fm|tt|x-oss-)/i;
            const isPlay = aigeiAudioPath.test(url);
            const isCDN = /(^|\.)aigei\.com$|alicdn\.com$|aliyuncs\.com$|aliyun\.com$|oss-/.test(url);
            const isSigned = aigeiSigned.test(url);
            const isNavOnly = aigeiNavOnly.test(url) && !isPlay && !isSigned;
            if ((isPlay && !isNavOnly) || (isSigned && !isNavOnly) || (isCDN && isSigned)) {
              window.__hmdao_remember_audio(url, 'aigei-besteffort');
            }
          }
        }
      } catch (_) {}
      if (p && typeof p.then === 'function' && window.__hmdao_remember_audio) {
        p.then(function (resp) {
          try {
            const rurl = (resp && resp.url) || url;
            const ct = (resp && resp.headers && resp.headers.get) ? (resp.headers.get('content-type') || '') : '';
            // ★放宽（2026-08-01）：爱给等站音频常托管在 alicdn/OSS，content-type 是 octet-stream 而非 audio/*，
            // 且 URL 无扩展名（带 e/token 签名）。旧逻辑只认 content-type:audio/* → 全漏 → 试听采不到。
            // 现在：audio/* 或 爱给域名/CDN 下带签名参数 或 音频扩展名，都记。
            const isAigei = /aigei\.com$|alicdn\.com$|aliyuncs\.com$|aliyun\.com$|oss-/.test(rurl);
            const aigeiSigned = /[?&](e|token|t|sign|sk|expire|expires|k|fm|tt|x-oss-)/i.test(rurl);
            const audioExt = /\.(mp3|wav|flac|aac|m4a|ogg|opus|wma|amr|mid|midi)([?#]|$)/i.test(rurl);
            if (/^audio\//i.test(ct) || (isAigei && aigeiSigned) || audioExt) {
              window.__hmdao_remember_audio(rurl, 'fetch-ct');
            } else if (isAigei && /application\/(octet-stream|.*download)|binary\//i.test(ct)) {
              window.__hmdao_remember_audio(rurl, 'fetch-ct'); // OSS 默认 octet-stream + 爱给域名：基本确定是音频直链
            }
          } catch (_) {}
          return resp;
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

  // ★2026-08-24 站点条件化：本 IIFE 不再重写 XMLHttpRequest.prototype.open/send。
  //   原因：model-api-capture 注入的 matches 站点（花瓣/zcool/artstation/modelbox/抖音/TikTok）
  //   的「模型 API 视频直链」几乎都走 fetch，已由下方 fetch patch 完整捕获；XHR 重写只会给
  //   站点自身 XHR（统计/clarity/分析）失败时挂上 model-api-capture.js 署名，造成"扩展报错"假象。
  //   XHR 音频捕获（爱给等）由独立 aigei IIFE 与下方 fetch patch 的 __hmdao_remember_audio 覆盖，
  //   本处删除不影响 matches 站的采集能力。

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
      // ★2026-09-09 温和模式：非目标站的 DOM 变更回调若同步跑 querySelectorAll，
      //   在高频变更页（弹幕/协同编辑/无限滚动）会抢占主线程 → 源页卡顿。
      //   改为把变更攒起来，交给浏览器空闲期合并处理；后台标签直接丢弃（零开销）。
      //   目标站保持同步处理，采集实时性优先。两种模式采集能力完全一致。
      const lite = !!window.__hmdao_liteMode;
      let liteQueue = [];
      let liteScheduled = false;
      const flushLite = () => {
        liteScheduled = false;
        const q = liteQueue;
        liteQueue = [];
        try {
          for (const n of q) { if (n && n.isConnected !== false) scanNode(n); }
        } catch (_) {}
      };
      const mo = new MutationObserver((mutations) => {
        if (lite) {
          try {
            if (document.visibilityState === 'hidden') return; // 后台标签：不处理
            for (const m of mutations) {
              if (m.addedNodes) { for (const n of m.addedNodes) if (n && n.nodeType === 1) liteQueue.push(n); }
              if (m.type === 'attributes' && m.target) liteQueue.push(m.target);
            }
            if (liteQueue.length > 400) liteQueue.splice(0, liteQueue.length - 400); // 上限防内存膨胀
            if (!liteScheduled) { liteScheduled = true; __hmdaoScheduleIdle(flushLite); }
          } catch (_) {}
          return;
        }
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

  // ★被动 click 兜底（零副作用）：仅观察用户真实点击，绝不主动触发播放/请求。
  // 爱给等站点试听按钮可能不带可预测 URL，而是点击后才由页面 JS 注入签名音频到游离 Audio / <audio>。
  // 本钩子在用户点击「疑似播放按钮」时，扫描该元素及最近容器的音频关联（data-src/data-url/<audio>/data-mp3），
  // 主动 remember，确保「点过试听」的音效一定被采集；同时给页面 400ms 让它的 JS 注入 Audio 后被既有钩子捕获。
  try {
    if (typeof document !== 'undefined' && !window.__hmdao_click_audio_watch) {
      window.__hmdao_click_audio_watch = true;
      const looksPlayLike = (el) => {
        if (!el || el.nodeType !== 1) return false;
        const txt = (el.textContent || '').trim();
        const cls = (typeof el.className === 'string' ? el.className : (el.getAttribute && el.getAttribute('class') || ''));
        const attrs = (el.getAttribute && (el.getAttribute('aria-label') || '')) || '';
        const sig = (cls + ' ' + txt + ' ' + attrs).toLowerCase();
        return /(play|试听|listen|audio|voice|播放|听|sound|music)/i.test(sig) ||
               /data-(play|audio|sound|src|url|mp3)/i.test(el.outerHTML || '');
      };
      const collectFromEl = (el) => {
        if (!el || el.nodeType !== 1) return;
        const tryRem = (u, how) => {
          if (u && /^https?:/i.test(u) && window.__hmdao_remember_audio) window.__hmdao_remember_audio(u, how);
        };
        // 元素自身的音频属性
        ['data-src', 'data-url', 'data-mp3', 'data-audio', 'data-media', 'src'].forEach(a => {
          const v = el.getAttribute && el.getAttribute(a);
          if (v) tryRem(v, 'click-attr');
        });
        // 同容器内的 <audio>
        try {
          const root = el.closest('[class],li,div,tr,article,a') || el.parentElement || el;
          const audios = root.querySelectorAll ? root.querySelectorAll('audio[src],audio source[src]') : [];
          audios.forEach(aud => {
            const s = aud.currentSrc || aud.src || (aud.querySelector && aud.querySelector('source') && aud.querySelector('source').src);
            if (s) tryRem(s, 'click-audio-el');
          });
          // data-* 里可能藏 URL
          if (root.getAttribute) {
            for (const a of root.attributes) {
              if (/src|url|mp3|audio|media|sound/i.test(a.name) && /^https?:/i.test(a.value)) tryRem(a.value, 'click-attr');
            }
          }
        } catch (_) {}
      };
      document.addEventListener('click', (ev) => {
        try {
          let el = ev.target;
          while (el && el.nodeType === 1) {
            if (looksPlayLike(el)) { collectFromEl(el); break; }
            el = el.parentElement;
          }
          // 给页面 JS 注入 Audio 留时间，既有钩子会在 play/src 时自动捕获
        } catch (_) {}
      }, true);
    }
  } catch (_) {}
})();

// ===== 爱给视频多分辨率捕获（MAIN 世界，零副作用） =====
// 爱给视频详情页（aigei.com/video/...）的播放器有画质选择（4K/1080P/720P），
// 切换画质时会改变 <video> 的 src。被动监听这些变化，把不同画质的 URL 存进
// window.__hmdao_captures.aigeiVideos，由 background 扫描时读回，侧栏即可呈现
// 用户已在源页切过的所有分辨率。不主动触发画质切换，不影响页面播放器。
(function () {
  if (typeof window === 'undefined' || window.__hmdao_aigei_video_capture) return;
  window.__hmdao_aigei_video_capture = true;

  const isAigeiVideoPage = () => {
    try {
      return /(^|\.)aigei\.com$/i.test(location.hostname) && /\/video\//.test(location.pathname);
    } catch (_) { return false; }
  };
  if (!isAigeiVideoPage()) return;

  function bag() {
    const c = window.__hmdao_captures = window.__hmdao_captures || {};
    return c.aigeiVideos = c.aigeiVideos || [];
  }
  function normalizeUrl(u) {
    try { return new URL(u, location.href).href; } catch (_) { return u; }
  }
  function rememberVideo(url, qualityHint) {
    try {
      if (!url || typeof url !== 'string') return;
      if (/^(blob:|data:|mediasource:)/i.test(url)) return;
      const u = normalizeUrl(url);
      if (!/^https?:/i.test(u)) return;
      if (!/\.(mp4|webm|m3u8|mov|m4v|mkv|ogv|flv|f4v)(\?[^"'\s}]*)?/i.test(u)) return;
      const list = bag();
      let path = u;
      try { const x = new URL(u); path = x.origin + x.pathname; } catch (_) {}
      const idx = list.findIndex((e) => e.path === path);
      const item = { url: u, path, quality: qualityHint || '', ts: Date.now() };
      if (idx >= 0) list[idx] = item; else list.push(item);
      if (list.length > 50) list.shift();
      // 零副作用：仅在真实发生切换/加载后通知 ISOLATED world 触发后台 rescan，不主动请求
      try { window.postMessage({ __hmdao_type: 'VIDEO_CAPTURED', url: u, path, quality: qualityHint || '' }, location.origin); } catch (_) {}
    } catch (_) {}
  }
  function scanVideoEl(v) {
    if (!v || v.nodeType !== 1) return;
    const src = v.currentSrc || v.src;
    if (src) rememberVideo(src, v.dataset.quality || v.getAttribute('data-quality') || '');
    if (v.querySelectorAll) {
      v.querySelectorAll('source').forEach((s) => {
        const q = s.dataset.quality || s.getAttribute('data-quality') || s.getAttribute('label') || s.getAttribute('title') || '';
        if (s.src) rememberVideo(s.src, q);
      });
    }
  }

  // DOM 监听：已有 video、新增 video、src 属性变化
  try {
    document.querySelectorAll('video').forEach(scanVideoEl);
    if (typeof MutationObserver !== 'undefined') {
      const mo = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.addedNodes) {
            for (const n of m.addedNodes) {
              if (n.nodeType === 1) {
                if (n.tagName === 'VIDEO') {
                  scanVideoEl(n);
                  // A3 增强（2026-08-24）：新增 <video> 的 src 常被站点 JS 延后填充
                  // （hover 后下一拍才 set src / 才挂载 <source>）。同步首扫可能拿到空 currentSrc，
                  // 故在浏览器空闲时对该元素二次扫描，覆盖懒挂载场景。
                  try {
                    const ric = window.requestIdleCallback || ((f) => setTimeout(f, 400));
                    ric(() => { try { if (n.isConnected) scanVideoEl(n); } catch (_) {} });
                  } catch (_) {}
                }
                if (n.querySelectorAll) n.querySelectorAll('video').forEach((v) => {
                  scanVideoEl(v);
                  try {
                    const ric = window.requestIdleCallback || ((f) => setTimeout(f, 400));
                    ric(() => { try { if (v.isConnected) scanVideoEl(v); } catch (_) {} });
                  } catch (_) {}
                });
              }
            }
          }
          if (m.type === 'attributes' && m.target && m.target.tagName === 'VIDEO' && m.attributeName === 'src') {
            scanVideoEl(m.target);
          }
        }
      });
      mo.observe(document.documentElement || document, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    }
  } catch (_) {}

  // 旁路监听 src setter：只记录，不改变原生行为
  try {
    const proto = HTMLMediaElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'src');
    if (desc && desc.set && !window.__hmdao_aigei_src_hooked) {
      window.__hmdao_aigei_src_hooked = true;
      const origSet = desc.set;
      Object.defineProperty(proto, 'src', {
        configurable: true,
        get: desc.get,
        set: function (v) {
          try { if (this.tagName === 'VIDEO') rememberVideo(v, this.dataset.quality || ''); } catch (_) {}
          return origSet.call(this, v);
        }
      });
    }
  } catch (_) {}

  // 兜底轮询：应对 SPA 动态替换 video 不触发 mutation 的情况
  try {
    setInterval(() => { document.querySelectorAll('video').forEach(scanVideoEl); }, 2000);
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
  // 同 model IIFE：目标站立即扫描，其它站走温和模式（空闲期 + 后台标签暂停）
  window.__hmdao_liteMode = !__hmdao_isCaptureTargetSite();
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
      // ★与上方 model IIFE 一致：对「非素材采集相关」请求零侵入，避免本文件出现在错误栈顶
      //   （造成「开扩展才报错」假象）。直接在栈底透传原生 fetch，使失败请求的栈顶回到抖音自身文件。
      let vHost = '';
      const vIsHttp = /^https?:\/\//i.test(url);
      try { vHost = new URL(url).hostname; } catch (_) {}
      const vIsSchemeLaunch = !vIsHttp && /^[a-z][a-z0-9+.-]*:\/\//i.test(url);
      // ★2026-09-10 兼容加固（MSN 播放器「Active video player not found」→ 黑屏无画面无声音）：
      //   MSN 等站点的播放器核心库由外部 CDN 提供（video.js = vjs.zencdn.net，语言包 = unpkg.com）。
      //   它们是【播放器运行时】而非可采集素材——任何包装（then 链 / clone / 响应体扫描）
      //   都只有风险没有收益：一旦本文件出现在播放器加载或字幕/清单请求的错误栈顶，
      //   用户会误判为「装了扩展才播不了」，而真实原因（Edge 跟踪防护拦截 CDN 存储访问）
      //   反而被掩盖。故这些域一律 100% 原生透传：零包装、零 clone、零扫描。
      const PLAYER_LIB_CDN_RE = /(^|\.)(vjs\.zencdn\.net|unpkg\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|player\.bilibili\.com)$/i;
      if (vHost && PLAYER_LIB_CDN_RE.test(vHost)) {
        return origFetch.apply(this, arguments);
      }
      const vIsNoise = /(zijieapi\.com|mon\.|analytics|metrics|collect|track|sentry|log\.)/i.test(url || vHost)
        || /(security\.zijieapi|douyin\.com|iesdouyin\.com|tiktok\.com)/i.test(vHost)
           && !/(douyinpic|bytecdn|douyinstatic|douyinvod|v26-web|bytedance\.com\/.*\.(mp4|webm|m4a|mp3))/i.test(url);
      if (vIsSchemeLaunch || vIsNoise) {
        return origFetch.apply(this, arguments);
      }
      const p = origFetch.apply(this, arguments);
      if (p && typeof p.then === 'function') {
        p.then(function (resp) {
          try {
            const ct = (resp && resp.headers && resp.headers.get) ? (resp.headers.get('content-type') || '') : '';
            if (/json/i.test(ct) && resp.clone) {
              // 温和模式：把「读响应体」这件事推到空闲期，避免与页面主线程抢时间；
              // 后台标签直接跳过。功能不打折——空闲期到就会扫描，只是不在关键路径。
              const doScan = () => resp.clone().text().then(function (t) { try { scanApiVideoUrls(t); } catch (_) {} }).catch(function () {});
              if (window.__hmdao_liteMode) __hmdaoScheduleIdle(doScan);
              else doScan();
              return resp;
            }
          } catch (_) {}
          return resp;
        }).catch(function () {});
      }
      return p;
    };
  } catch (_) {}

  // ★2026-08-24 站点条件化：本 IIFE 不再重写 XMLHttpRequest.prototype.open/send。
  //   理由同上方 model IIFE —— 注入站点（花瓣/抖音/设计素材站）XHR 重写只会给站点自身 XHR 失败
  //   挂上 model-api-capture.js 署名（造成"扩展报错"假象），且 JSON 响应视频 URL 扫描已由上方
  //   fetch patch（origFetch 段）完整覆盖（现代站点模型 API 走 fetch）。删除后采集能力不变。
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
  if (__hmdao_isMediaPlaySite()) return; // 媒体播放主站熔断：不 hook，避免 AudioContext 等噪音
  if (__hmdao_isBiliPlayPage()) return; // B站播放页熔断：不 patch，兼容原生播放器
  if (__hmdao_isDouyinPlayPage()) return; // 抖音/TikTok 播放页熔断：不 patch，兼容原生播放器
  window.__hmdao_audio_capture = true;

  function bag() {
    const c = window.__hmdao_captures = window.__hmdao_captures || {};
    return (c.audioPlays = c.audioPlays || []);
  }
  // 拒绝明显不是音频的 URL（如图片/视频扩展名、追踪像素等）。
  // 部分站点会错误地把封面图/jpg 传进 soundManager.createSound，不过滤会让音频模块混入图片。
  function isObviousNonAudioUrl(url) {
    try {
      const path = new URL(url).pathname.toLowerCase();
      if (/\.(jpg|jpeg|png|gif|webp|bmp|svg|ico|avif|apng|tif|tiff)(\?|#|$)/.test(path)) return true;
      if (/\.(mp4|webm|mov|m4v|mkv|ogv|m3u8|mpd|flv|avi|wmv|ts|3gp|f4v)(\?|#|$)/.test(path)) return true;
      if (/\.(json|xml|html?|css|js|pdf|docx?|zip|rar|7z|gz|tar)(\?|#|$)/.test(path)) return true;
      if (/(^|\/)(1x1|spacer|pixel|beacon|track|collect|analytics)(\.[^/]*)?$/i.test(path)) return true;
    } catch (_) {}
    return false;
  }

  function remember(url, how) {
    try {
      if (!url || typeof url !== 'string') return;
      if (/^(blob:|data:|mediasource:)/i.test(url)) return; // blob/data 跨上下文不可用
      try { url = new URL(url, location.href).href; } catch (_) { return; }
      if (!/^https?:/i.test(url)) return;
      if (isObviousNonAudioUrl(url)) return; // 2026-08-02 防止图片/视频混入音频模块
      const list = bag();
      // 按 origin+pathname 去重：爱给等站的签名参数（?e=&token=）会刷新，
      // 同 pathname 视为同一音频，永远保留【最新】签名 URL（旧签名已过期无用）。
      let path = url;
      try { const x = new URL(url); path = x.origin + x.pathname; } catch (_) {}
      const item = { url, path, how, ts: Date.now() };
      const idx = list.findIndex((e) => e.path === path);
      if (idx >= 0) list[idx] = item; else list.push(item);
      if (list.length > 200) list.shift();
      // ★零副作用：用户真点试听、音频被捕获后，通知 ISOLATED world 的 content script
      // （scanPage）去触发后台 rescan，让侧栏实时出现音效（不主动点击/播放，纯被动）。
      // MAIN 世界变量 ISOLATED 读不到，故用 window.postMessage 跨 world 通信。2026-08-01。
      try { window.postMessage({ __hmdao_type: 'AUDIO_CAPTURED', url, path }, location.origin); } catch (_) {}
    } catch (_) {}
  }
  window.__hmdao_remember_audio = remember; // 供上方 fetch/XHR 钩子复用

  // ===== 旁路监听（非破坏性，不改变原生 API 行为，不影响页面播放器）=====

  // ★ 关键设计原则：爱给等站点使用 SoundManager 2 库，内部 new Audio() 创建音频元素。
  // 不能 patch window.Audio / HTMLMediaElement.prototype.src / play / setAttribute ——
  // 这些钩子会改变原生行为，导致 SoundManager 播放链路异常（试听无声音）。
  // 改为纯旁路监听：只记录 URL，不拦截/改变原生 API 的返回值或行为。

  // 1) soundManager.createSound({url})：爱给 AudioPlayerManager.audioUrlRequest
  //    最终调 soundManager.createSound({id, url}) 加载真实 mp3。这是最精准的入口，
  //    零副作用——只读 opts.url，不改 createSound 的返回值和内部行为。
  try {
    const SM = window.soundManager;
    if (SM && typeof SM.createSound === 'function' && !window.__hmdao_sm_hooked) {
      window.__hmdao_sm_hooked = true;
      const origCreateSound = SM.createSound.bind(SM);
      SM.createSound = function (opts) {
        try {
          if (opts && typeof opts.url === 'string') {
            remember(opts.url, 'soundmanager-createSound');
          }
        } catch (_) {}
        return origCreateSound(opts);
      };
    }
  } catch (_) {}

  // 2) fetch/XHR 旁路（已在文件前面的拦截器中）：URL 带音频扩展名或响应 content-type: audio/*
  //    走 remember(url, 'fetch'/'xhr')，不改原生 fetch/XHR 行为，仅旁路记录。
  //    详见本文件上方 fetch/XHR 拦截器（__hmdao_remember_audio 回调）。

  // 3) HTMLMediaElement.prototype.play 旁路：仅用于调试记录（可选，不影响行为）。
  //    当前不启用，避免任何对原生 API 的修改。

})();

// ===== 迅雷网盘分享页 API 响应捕获 =====
// 迅雷分享页的文件列表与下载直链由 api-pan.xunlei.com 动态返回，且需要页面自身鉴权上下文。
// 我们在 MAIN 世界 hook fetch/XHR，被动捕获这些响应，存到 window.__hmdao_captures.xunleiShare，
// 供 scanTab / netdiskResolve 读取并生成可直连下载的 archive 资产。
(function () {
  if (typeof window === 'undefined' || window.__hmdao_xunlei_capture_installed) return;
  try {
    const h = location.hostname || '';
    if (!/(^|\.)xunlei\.com$/.test(h)) return;
  } catch (_) { return; }
  window.__hmdao_xunlei_capture_installed = true;

  // ★调试探针（2026-08-08）：暴露到 window，走 ISOLATED→background 代理通道探测迅雷 API，
  // 绕过页面 CORS（api-pan.xunlei.com 对带凭据预检返回 ACAO='*' → MAIN 直发必 ERR_FAILED）。
  // 用法（Console 粘贴执行）：
  //   __hmdao_xunlei_probe('VOj-h8suAkW9oy_-90W8M4r9A1','qkva','VOj-gdWBPeCnQdqryg0WRKi3A1')
  window.__hmdao_xunlei_probe = async function (shareId, pwd, fid) {
    const base = 'https://api-pan.xunlei.com/drive/v1/share';
    const out = (...a) => console.log('[PROBE]', ...a);
    // 先取顶层列表拿 pass_code_token
    const topUrl = `${base}?share_id=${encodeURIComponent(shareId)}&pass_code=${encodeURIComponent(pwd)}&limit=100&page_token=&thumbnail_size=SIZE_SMALL`;
    const tr = await xunleiBridgeFetch(topUrl, { 'Content-Type': 'application/json' });
    let passToken = '', topJson = null;
    try { topJson = JSON.parse(tr.text); passToken = topJson.pass_code_token || ''; } catch (_) {}
    out('顶层 status=', tr.status, ' pass_code_token=', (passToken || '').slice(0, 24), ' keys=', JSON.stringify(Object.keys(topJson || {})));
    const files = topJson && (topJson.files || topJson.list || (topJson.data && (topJson.data.files || topJson.data.list)) || []);
    out('顶层 first item FULL=', JSON.stringify(files[0] || {}, null, 2));
    // file_info + download_url：试 space='' / 'share' / 'drive'
    for (const sp of ['', 'share', 'drive']) {
      const fiUrl = `${base}/file_info?pass_code_token=${encodeURIComponent(passToken)}` + (sp ? `&space=${encodeURIComponent(sp)}` : '') + `&file_id=${encodeURIComponent(fid)}&share_id=${encodeURIComponent(shareId)}&pass_code=${encodeURIComponent(pwd)}`;
      const fr = await xunleiBridgeFetch(fiUrl, { 'Content-Type': 'application/json' });
      out(`file_info space="${sp}" status=${fr.status} body(前1200)=`, (fr.text || '').slice(0, 1200));
      const dlUrl = `${base}/download_url?share_id=${encodeURIComponent(shareId)}` + (sp ? `&space=${encodeURIComponent(sp)}` : '') + `&file_id=${encodeURIComponent(fid)}&pass_code_token=${encodeURIComponent(passToken)}&pass_code=${encodeURIComponent(pwd)}`;
      const dr = await xunleiBridgeFetch(dlUrl, { 'Content-Type': 'application/json' });
      out(`download_url space="${sp}" status=${dr.status} dlUrl=`, dlUrl);
      out(`download_url space="${sp}" body(前1200)=`, (dr.text || '').slice(0, 1200));
    }
    out('PROBE DONE');
  };

  // ★迅雷 API 通道根因修复（2026-08-08 实锤）：
  //   旧「MAIN world 直发」主路径在此域名下必然失败——迅雷 api-pan.xunlei.com 对带凭据的
  //   预检请求返回 ACAO='*'，而浏览器规则「credentials:include + ACAO='*'」→ net::ERR_FAILED，
  //   file_info 请求（带 Authorization/x-pass-code-token 非简单头触发预检）直接发不出去，
  //   导致 sub_file_id 永远提取不到 → download_url 用顶层 fid → 404 not_found。
  //   实测日志已坐实：MAIN 直发 file_info 报 CORS ERR_FAILED，download_url 拿到 404 body。
  //
  //   正确做法：全部走 ISOLATED→background 代理通道（xunlei-bridge.js → HMDAO_XUNLEI_API →
  //   xunleiProxyFetch）。background 的 fetch 用 credentials:'omit' + 手动从 chrome.cookies
  //   读取登录态塞进 Cookie 头：SW fetch 不受页面 CORS 限制，omit 模式不需 ACAO 匹配，
  //   既带登录态（过 401）又能读响应体（过 CORS），彻底绕开 MAIN 直发的两难。
  //
  //   主路径 = ISOLATED→background 代理；MAIN 直发已删除（在该域名下已被实测证伪）。
  function xunleiBridgeFetch(url, headers, method) {
    return new Promise((resolve) => {
      fallbackXunleiBridge(url, headers, method).then((r) => {
        if (r && !r.__via) r.__via = 'bridge';
        resolve(r);
      });
    });
  }

  // ISOLATED→background 中转通道（当前唯一主路径）。
  function fallbackXunleiBridge(url, headers, method) {
    return new Promise((resolve) => {
      const reqId = 'xl' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      let done = false;
      console.log('[HMDAO][xunlei] bridge send', reqId, url.slice(0, 120));
      const onMsg = (e) => {
        const d = e.data;
        if (!d || d.__hmdao_type !== 'XUNLEI_FETCH_RESULT' || d.reqId !== reqId) return;
        if (done) return; done = true;
        window.removeEventListener('message', onMsg);
        console.log('[HMDAO][xunlei] bridge recv', reqId, 'status=', d.status, 'ok=', d.ok, 'err=', d.error, 'len=', (d.text || '').length);
        if (d.ok) resolve({ status: d.status, text: d.text });
        else resolve({ status: d.status || 0, text: d.text || '', __error: d.error || 'bridge-failed' });
      };
      window.addEventListener('message', onMsg);
      setTimeout(() => {
        if (done) return; done = true;
        window.removeEventListener('message', onMsg);
        console.warn('[HMDAO][xunlei] bridge timeout', reqId, url.slice(0, 120));
        resolve({ status: 0, text: '', __error: 'bridge-timeout' });
      }, 5000);
      try {
        window.postMessage({ __hmdao_type: 'XUNLEI_FETCH', reqId, url, headers: headers || {}, method: method || 'GET' }, '*');
      } catch (e) {
        if (!done) { done = true; window.removeEventListener('message', onMsg); resolve({ status: 0, text: '', __error: String(e) }); }
      }
    });
  }

  function readXunleiCaptcha() {
    try {
      const cid = 'Xqp0kJBXWhwaTpB6';
      const raw = localStorage.getItem('captcha_' + cid) || localStorage.getItem('xunlei_captcha');
      if (raw) { try { return JSON.parse(raw).token || raw; } catch (_) { return raw; } }
    } catch (_) {}
    return '';
  }
  function bag() {
    const c = window.__hmdao_captures = (window.__hmdao_captures || {});
    const xs = c.xunleiShare = c.xunleiShare || { list: [], fileInfo: {}, shareId: '', passCodeToken: '', pwd: '', captchaToken: '', authToken: '', ts: 0 };
    // pass_code_token / captcha 由页面 JS 生成并存于 localStorage，每次刷新保证拿到最新值
    //（MV3/手动注入时可能初始为空，后续页面写入 localStorage 后需重新读取）
    try {
      const pt = localStorage.getItem('xlpan_pass_token') || '';
      if (pt) xs.passCodeToken = pt;
    } catch (_) {}
    const ct = readXunleiCaptcha();
    if (ct) xs.captchaToken = ct;
    // ★ 登录 Authorization 兜底抓取（2026-08-08）：主动请求 file_info/download_url 时若
    //   store.authToken 为空会触发 401。被动捕获（fetch hook）有时因页面用 XHR/Headers 对象
    //   而漏抓。这里主动扫描 localStorage 里迅雷存放的登录 token 键作为回退。
    if (!xs.authToken) {
      try {
        const cand = ['xunlei_token', 'xlpan_token', 'pan_auth', 'xunlei_user_token', 'xluser_token', 'user_token', 'token', 'auth_token', 'xunlei_login_token'];
        for (const k of cand) {
          const v = localStorage.getItem(k);
          if (v && v.length > 8) {
            // 直接是 token 串，或 JSON 内含 token 字段
            let tok = v;
            try { const o = JSON.parse(v); if (o && (o.token || o.access_token || o.auth_token)) tok = o.token || o.access_token || o.auth_token; } catch (_) {}
            if (tok && tok.length > 8) { xs.authToken = tok.indexOf('Bearer ') === 0 ? tok : ('Bearer ' + tok); break; }
          }
        }
      } catch (_) {}
    }
    return xs;
  }

  // ★ 2026-08-09 新增：迅雷自己网盘（pan.xunlei.com/?path=...）捕获存储
  function bagMyDrive() {
    const c = window.__hmdao_captures = (window.__hmdao_captures || {});
    // ★ 2026-08-10 修复：device_id/client_id 只存在于页面 localStorage，background(SW 世界)读不到。
    //   必须在此 MAIN 世界读取并固化，供 background 代理优先使用（否则 background 只能读 Cookie → device_id is empty）。
    if (!c.xunleiMyDrive) {
      c.xunleiMyDrive = { list: [], fileInfo: {}, space: '', path: '', authToken: '', captchaToken: '', deviceId: '', clientId: '', ts: 0 };
    }
    const md = c.xunleiMyDrive;
    // ★ 直接用 localStorage 真实值刷新（不触发 xunleiDeviceId 的写死 fallback，避免污染缓存）。
    //   真实值存在时始终覆盖（localStorage 晚加载也能源源不断刷新），缺失时保留既有缓存。
    try {
      const did = localStorage.getItem('deviceid') || localStorage.getItem('xunlei_device_id') || localStorage.getItem('device_id') || localStorage.getItem('x_device_id') || '';
      if (did) md.deviceId = did;
      const cid = localStorage.getItem('xunlei_client_id') || localStorage.getItem('client_id') || '';
      if (cid) md.clientId = cid;
    } catch (_) {}
    return md;
  }

  function okCode(json) {
    if (!json) return false;
    const c = json.code;
    if (typeof c === 'number') return c === 0 || c === 200;
    if (typeof c === 'string') return c === '0' || c === '200';
    // 迅雷分享接口真实返回：{ share_status: 'OK', files: [...], ... }（无 code 字段）
    if (json.share_status === 'OK' || json.share_status === 'ok') return true;
    if (json.file_info && typeof json.file_info === 'object') return true;
    if (json.download_url) return true;
    return json.errno === 0 || json.errno === '0' || json.status === 0 || json.status === '0' || json.success === true || json.data;
  }
  function pickFiles(json) {
    if (!json || typeof json !== 'object') return null;
    const candidates = [
      json.files, json.file_list, json.fileList, json.list, json.children,
      json.data && json.data.files,
      json.data && json.data.file_list,
      json.data && json.data.list,
      json.data && json.data.file_list && json.data.file_list.list,
      json.result && json.result.files,
      json.result && json.result.list,
      json.fileList && json.fileList.files,
    ];
    for (const arr of candidates) {
      if (Array.isArray(arr) && arr.length) return arr;
    }
    // 兜底：在 json.data 里找任意数组字段，其元素含 name + id
    if (json.data && typeof json.data === 'object') {
      for (const k in json.data) {
        const v = json.data[k];
        if (Array.isArray(v) && v.length && v[0] && (v[0].name || v[0].file_name || v[0].file_id || v[0].id)) return v;
      }
    }
    return null;
  }
  function shareIdFromUrl() {
    try {
      const m = location.pathname.match(/\/s\/([A-Za-z0-9_-]+)/);
      return m ? m[1] : '';
    } catch (_) { return ''; }
  }

  function parseList(json, append) {
    // ★ 诊断（2026-08-08）：无条件打印入口，确认是否被调用、传了什么
    try { console.warn('[HMDAO][xunlei] >>> parseList called append=', append, 'code=', json && json.code, 'keys=', JSON.stringify(Object.keys(json || {}))); } catch (_) {}
    if (!okCode(json)) {
      try { console.log('[HMDAO][xunlei] list response code not ok:', json && json.code, json); } catch (_) {}
      return;
    }
    const files = pickFiles(json);
    // ★原始条目诊断（2026-08-08）：打印第一个文件条目的真实字段名（id/file_id/sub_file_id），
    // 用于确认 subFileId 提取路径是否正确。迅雷分享态 file_info 404 极可能是字段名猜错。
    try { console.warn('[HMDAO][xunlei] RAW first list item', JSON.stringify(files[0] || {}, null, 2)); } catch (_) {}
    if (!Array.isArray(files) || !files.length) {
      try { console.log('[HMDAO][xunlei] list no files array', json); } catch (_) {}
      return;
    }
    const store = bag();
    const newItems = files.map(function (f) {
      const raw = f || {};
      const name = raw.name || raw.file_name || raw.title || raw.fileTitle || '';
      const id = raw.id || raw.file_id || raw.fid || raw.fileId || '';
      const size = Number(raw.size || raw.file_size || raw.fileSize || 0) || 0;
      const isDir = raw.is_folder === 1 || raw.isFolder === 1 || raw.is_dir === 1 || raw.isDir === 1 || raw.folder === 1 || raw.category === 'folder' || /文件夹|folder/i.test(raw.kind || raw.type || '');
      let medias = [];
      if (Array.isArray(raw.medias)) medias = raw.medias;
      else if (raw.media) medias = [raw.media];
      else if (raw.link && raw.link.url) medias = [{ link: raw.link }];
      else if (raw.download_url) medias = [{ link: { url: raw.download_url, token: '' } }];
      else if (raw.url) medias = [{ link: { url: raw.url, token: '' } }];
      return {
        id,
        name,
        size,
        isDir,
        subFileId: raw.sub_file_id || raw.subFileId || raw.subFile_id_ || '',
        medias: medias.map(function (m) {
          const link = m.link || m;
          return { url: link.url || m.url || raw.download_url || raw.url || '', token: link.token || m.token || '' };
        }).filter(function (m) { return m.url; }),
      };
    });
    // 追加模式（进入子文件夹时）：合并到现有列表，避免丢失顶层/兄弟文件
    if (append) {
      const existing = store.list || [];
      const seen = new Set(existing.map(function (x) { return x.id; }));
      store.list = existing.concat(newItems.filter(function (x) { return x.id && !seen.has(x.id); }));
    } else {
      store.list = newItems;
    }
    store.shareId = json.share_id || json.shareId || (json.data && (json.data.share_id || json.data.shareId)) || shareIdFromUrl() || '';
    store.passCodeToken = json.pass_code_token || json.passCodeToken || (json.data && (json.data.pass_code_token || json.data.passCodeToken)) || '';
    store.ts = Date.now();
    // 记录文件夹，稍后主动进入以列出其中真实素材（去重，避免进入后仍含该文件夹导致递归）
    const entered = store.enteredFolders || {};
    const folderIds = store.list.filter(function (x) { return x.isDir && x.id && !entered[x.id]; }).map(function (x) { return x.id; });
    // 文件类条目（非文件夹）直接补直链，确保素材能被下载
    const fileIdsNow = store.list.filter(function (x) { return !x.isDir && x.id && !store.fileInfo[x.id]; }).map(function (x) { return x.id; });
    if (folderIds.length) {
      if (!store.enteredFolders) store.enteredFolders = {};
      folderIds.forEach(function (id) { store.enteredFolders[id] = true; });
      try { console.log('[HMDAO][xunlei] captured list:', store.list.length, 'folders=', folderIds.length, 'files=', fileIdsNow.length, 'shareId=', store.shareId); } catch (_) {}
      // ★ 修复（2026-08-08）：drive/v1/share 进入子文件夹需 captcha（API 直调被拦 400）。
      // 改用页面 DOM 点击展开（合法会话、无需 captcha）。触发 scanXunleiDom，其内部会
      // 自动 click 这些文件夹项，SPA 加载子内容后 MutationObserver 再次触发扫描，
      // 子文件夹内的文件会出现在 store.list，随后由 resolveXunleiDirect 补直链。
      try { scanXunleiDom(); } catch (_) {}
      // 兜底：API 路径仍尝试一次（若将来 captcha 可用），失败不阻塞 DOM 路径
      if (!store.folderQueue) store.folderQueue = [];
      folderIds.forEach(function (id) { store.folderQueue.push(id); });
      setTimeout(drainXunleiFolderQueue, 2500);
    } else {
      try { console.log('[HMDAO][xunlei] captured list:', store.list.length, 'files (no unentered folder)', 'shareId=', store.shareId); } catch (_) {}
    }
    // 无论是否进入文件夹，都给当前列表中的文件补直链（避免 list[0] 恰好是文件夹时漏掉文件）
    if (fileIdsNow.length) {
      try { setTimeout(function () { resolveXunleiDirect(fileIdsNow); }, 0); } catch (_) {}
    }
  }

  // 排空文件夹队列：优先用页面 DOM 点击展开（合法会话、无需 captcha），
  // 失败（API captcha）时回退到 DOM 点击方案；确保多层目录内素材都被列出。
  function drainXunleiFolderQueue() {
    const store = bag();
    if (!store.folderQueue || !store.folderQueue.length) return;
    const next = store.folderQueue.shift();
    if (!next) return;
    Promise.resolve()
      .then(function () { return enterXunleiFolder(next); })
      .then(function (res) {
        // enterXunleiFolder 成功则继续；失败（captcha）则走 DOM 点击兜底
        const ok = res && (res.ok === undefined ? true : res.ok);
        if (!ok) { try { scanXunleiDom(); } catch (_) {} }
        setTimeout(drainXunleiFolderQueue, 50);
      })
      .catch(function () { try { scanXunleiDom(); } catch (_) {} setTimeout(drainXunleiFolderQueue, 50); });
  }

  // 读取迅雷页面自身的 device_id / client_id（未带则回退默认，使主动请求通过服务端校验）
  const store_deviceFallback = '925b7631473a13716b791d7f28289cad';
  function xunleiClientId() {
    try {
      const ls = localStorage.getItem('xunlei_client_id') || localStorage.getItem('client_id');
      if (ls) return ls;
    } catch (_) {}
    return 'Xqp0kJBXWhwaTpB6';
  }
  function xunleiDeviceId() {
    try {
      // 真实迅雷网页端 device_id 存于 localStorage 键 'deviceid'
      const ls = localStorage.getItem('deviceid') || localStorage.getItem('xunlei_device_id') || localStorage.getItem('device_id') || localStorage.getItem('x_device_id');
      if (ls) return ls;
    } catch (_) {}
    try {
      const m = document.cookie.match(/(?:^|;\s*)device_id=([^;]+)/);
      if (m) return m[1];
    } catch (_) {}
    return store_deviceFallback;
  }

  // 主动进入文件夹：迅雷分享 API（drive/v1/share）游客态无法展开文件夹内容，
  // 需改用 drive/v1/share?parent_folder_id=<folder> 才能列出文件夹内文件（登录态/游客态均可，关键是 pass_code_token 必须有效）。
  async function enterXunleiFolder(folderId) {
    const store = bag();
    let shareId = store.shareId || shareIdFromUrl();
    const pwd = store.pwd || pwdFromLoc();
    let passToken = store.passCodeToken || '';
    if (!shareId || !folderId) { console.log('[HMDAO][xunlei] enterFolder skip', { shareId: !!shareId, folderId }); return; }
    const deviceId = xunleiDeviceId();
    const clientId = xunleiClientId();
    // captcha token 可能含非 Latin-1 字符（存储损坏），作为 header 发送会抛编码异常；清理为 ASCII 再发送
    let captcha = store.captchaToken || '';
    try { captcha = captcha ? captcha.replace(/[^\x00-\xFF]/g, '') : ''; } catch (_) { captcha = ''; }

    // ★ 关键修复：进入子文件夹前，强制刷新 pass_code_token / share_id。
    // store.passCodeToken 可能是 localStorage 脏值（实测含 file_id 片段），直接透传会导致 file_info 400。
    // 无论是否非空，都用 share_id 补一次顶层列表（游客态也能拿 pass_code_token）作为权威值。
    try {
      const topUrl = 'https://api-pan.xunlei.com/drive/v1/share?share_id=' + encodeURIComponent(shareId) + '&pass_code=' + encodeURIComponent(pwd) + '&limit=100&page_token=&thumbnail_size=SIZE_SMALL';
      const topHeaders = { 'Content-Type': 'application/json', 'x-device-id': deviceId, 'x-client-id': clientId, 'Referer': 'https://pan.xunlei.com/s/' + shareId + (pwd ? '?pwd=' + pwd : '') };
      if (captcha) topHeaders['x-captcha-token'] = captcha;
      if (store.authToken) topHeaders['Authorization'] = store.authToken;
      const tr = await xunleiBridgeFetch(topUrl, topHeaders);
      if (tr && tr.__error) bridgeFailed++;
      const tt = (tr && typeof tr.text === 'string') ? tr.text : '';
      maybeCapture(topUrl, tt, { Authorization: store.authToken });
      const tj = JSON.parse(tt);
      if (tj && tj.pass_code_token) { passToken = tj.pass_code_token; }
      if (tj && tj.share_id) { shareId = tj.share_id; }
      bag().passCodeToken = passToken; bag().shareId = shareId;
    } catch (e) { console.log('[HMDAO][xunlei] enterFolder 补顶层列表失败', e && e.message); }
    if (!passToken) { console.log('[HMDAO][xunlei] enterFolder 仍无 pass_code_token，放弃展开'); return; }

    const headersBase = { 'Content-Type': 'application/json', 'x-device-id': deviceId, 'x-client-id': clientId, 'Referer': 'https://pan.xunlei.com/s/' + shareId + (pwd ? '?pwd=' + pwd : '') };
    if (captcha) headersBase['x-captcha-token'] = captcha;
    if (store.authToken) headersBase['Authorization'] = store.authToken;

    // 正确展开接口：drive/v1/share 带 parent_folder_id / parent_id 列出该文件夹内文件。
    // 迅雷不同场景参数名可能不同，依次尝试 parent_folder_id、parent_id；均失败再回退 drive/v1/files。
    // ★ 401 修复：列子文件夹【不需要】pass_code_token（它在顶层列表响应里返回，列子层带进去反而干扰签名）。
    // 同时 credentials 改 'include'，复用页面登录态 Cookie（之前 omit 导致 401 Unauthorized）。
    const shareUrls = [
      'https://api-pan.xunlei.com/drive/v1/share?share_id=' + encodeURIComponent(shareId) + '&pass_code=' + encodeURIComponent(pwd) + '&parent_folder_id=' + encodeURIComponent(folderId) + '&limit=200&page_token=',
      'https://api-pan.xunlei.com/drive/v1/share?share_id=' + encodeURIComponent(shareId) + '&pass_code=' + encodeURIComponent(pwd) + '&parent_id=' + encodeURIComponent(folderId) + '&limit=200&page_token=',
    ];
    console.log('[HMDAO][xunlei] enterFolder(share+parent) auth=', !!store.authToken, 'device=', !!deviceId, 'captcha=', !!captcha, 'hasToken=', !!passToken);
    let ok = false;
    for (const shareUrl of shareUrls) {
      if (ok) break;
      try {
        // ★CORS 死局修复（2026-08-07）：经 xunleiBridgeFetch → background 代理。
        // background 用 dNR 把响应 ACAO 钉成 https://pan.xunlei.com（非 '*'）+ credentials:'include'，
        // 既带登录态过 401，又通过预检（避免 net::ERR_FAILED）。
        const r = await xunleiBridgeFetch(shareUrl, headersBase);
        // bridge 失败时 r 是 {status,text,__error}，text 是字符串；否则 r.text() 才可用。
        const t = (r && typeof r.text === 'string') ? r.text : '';
        if (r && r.__error) console.warn('[HMDAO][xunlei] enterFolder share bridge-error', r.__error);
        else if (r && r.status === 200) {
          const json = JSON.parse(t);
          parseList(json, true); // 追加到现有列表，不要覆盖
          ok = true;
        } else {
          console.log('[HMDAO][xunlei] enterFolder share status=', r && r.status, 'url=', shareUrl.split('?')[0], 'body=', t.slice(0, 200));
        }
      } catch (e) { console.log('[HMDAO][xunlei] enterFolder(share) error', e && e.message); }
    }

    // ★ 2026-08-08：移除旧的 drive/v1/files 兜底接口。
    // 该接口路径（drive/v1/files?share_id=&parent_id=）迅雷早已停用，实测恒返 404
    // （日志 back xl1786174956552_a4fvud 404 http-404），且会白白消耗一次 bridge 往返。
    // 迅雷分享态当前根本不再返回可下载直链，主动请求这条路已死；直链只能靠用户在
    // 网页端手动点「下载」触发被动捕获（见 resolveXunleiDirect 的 passive 优先逻辑）。
    // 因此这里不再做任何主动兜底，直接依赖 DOM 扫描（策略 A-D）拿到的文件条目。

    // 进入后，对列表内所有文件类条目主动拿直链（遍历全部，不只 list[0]）
    const s2 = bag();
    if (s2.list && s2.list.length) {
      const fileIds = s2.list.filter(function (x) { return !x.isDir && x.id && !s2.fileInfo[x.id]; }).map(function (x) { return x.id; });
      if (fileIds.length) {
        await resolveXunleiDirect(fileIds);
      } else {
        console.log('[HMDAO][xunlei] enterFolder: 该层全为文件夹或无文件，listLen=', s2.list.length);
      }
    } else {
      console.log('[HMDAO][xunlei] enterFolder: 仍未拿到文件夹内文件（可能需登录迅雷网页端或滑块验证）listLen=', s2.list && s2.list.length);
    }
  }

  // 解析 download_url 接口响应（已登录页面下载时带 Authorization，返回真实直链）
  function parseDownloadUrl(url, json) {
    if (!okCode(json)) return;
    const u = (function () { try { return new URL(url, location.href); } catch (_) { return null; } })();
    const fid = u ? (u.searchParams.get('file_id') || u.searchParams.get('fid') || '') : '';
    // 接口返回：{ download_url: '...', file_name: '...' } 或 { web_content_link, ... }
    let direct = '';
    if (json.download_url) direct = json.download_url;
    else if (json.web_content_link) direct = json.web_content_link;
    else if (json.url) direct = json.url;
    else if (json.data && json.data.download_url) direct = json.data.download_url;
    if (!direct || !fid) { console.log('[HMDAO][xunlei] parseDownloadUrl skip', { hasDirect: !!direct, fid }); return; }
    const store = bag();
    if (!store.fileInfo[fid]) store.fileInfo[fid] = { direct: '', medias: [], ts: 0 };
    store.fileInfo[fid].direct = direct;
    store.fileInfo[fid].ts = Date.now();
    console.log('[HMDAO][xunlei] parseDownloadUrl got direct for', fid, direct.slice(0, 80));
  }

  // 主动请求直链接口拿真实下载 URL（复用页面 Authorization）。
  // 关键修复（2026-08-07）：原代码调 drive/v1/files/download_url —— 该接口只对"已转存到自己网盘"的文件有效，
  // 分享态未转存的文件直接调会返回 400，且网页侧会提示"需转存"。正确接口是
  // drive/v1/share/file_info（GET，带 pass_code_token），它要求登录态但【不要求转存】，可直接拿 CDN 直链。
  //
  // ★ 2026-08-07 二次修复（400 根因）：
  //   1) pass_code_token 必须由列表响应 drive/v1/share 返回（lj.pass_code_token），不能用 localStorage 脏值。
  //      故每次调用都从 bag() 实时重读，且若缺失先补一次顶层列表拿 token。
  //   2) file_id 必须传【文件 id】（!isDir），传文件夹 id 会 400。
  //   3) header 与服务端 tryXunlei 对齐：必须带 x-captcha-token + Referer，authorization 留空串也可。
  //   4) captcha token 含非 Latin-1 字符作为 header 发送会抛编码异常 → 严格 ASCII 化。
  async function resolveXunleiDirect(fileIds) {
    const store = bag();
    let shareId = store.shareId || shareIdFromUrl();
    const pwd = store.pwd || pwdFromLoc();
    // 实时重读 pass_code_token（列表响应异步到达后才会被写入）
    let passToken = store.passCodeToken || '';
    if (!shareId || !Array.isArray(fileIds) || !fileIds.length) return { ok: false };
    const deviceId = xunleiDeviceId();
    const clientId = xunleiClientId();
    // captcha token 可能含非 Latin-1 字符（存储损坏），作为 header 发送会抛编码异常 → 严格 ASCII 清理
    let captcha = store.captchaToken || '';
    try { captcha = captcha ? captcha.replace(/[^\x00-\xFF]/g, '') : ''; } catch (_) { captcha = ''; }

    const out = {};
    const details = {}; // 每个 fid 的 status / error / body 摘要，用于侧栏诊断
    let bridgeFailed = 0;
    let needLogin = 0; // ★ download_url 返回 401/403（真正需登录态）的 fid 数
    let fileInfoOkCount = 0; // ★ 统计 file_info 接口成功的 fid 数：>0 说明 bridge/MAIN fetch 健康，
    // ★ 诊断快照（2026-08-08）：把鉴权相关状态打到顶层，便于定位 401 根因
    //   （authToken 空→缺 Authorization；captcha 空→滑块未过；走 main 还是 bridge）
    const diagSnap = {
      authTokenLen: (store.authToken || '').length,
      captchaLen: (captcha || '').length,
      deviceIdLen: (deviceId || '').length,
      passTokenLen: (passToken || '').length,
      shareId: !!shareId,
    };
    console.log('[HMDAO][xunlei] resolveDirect diag', JSON.stringify(diagSnap));
    // ★ 诊断（2026-08-08）：把 space 候选初始值打出来，确认顶层列表是否抓到了 space。
    // 若此处 spaceCandidates=[""]（只有空串），说明顶层列表无 space 字段，需依赖 file_info 补抓。
    console.warn('[HMDAO][xunlei] >>> spaceCandidates(初始)=', JSON.stringify((bag().spaceCandidates || [])));
    // ★ 强制刷新 pass_code_token：store.passCodeToken 可能是 localStorage 脏值（用户日志实测含 file_id 片段），
    // 直接透传会导致 file_info 400。无论是否非空，都先用 share_id 补一次顶层列表拿权威 token
    // （游客态也能拿 pass_code_token，它是分享响应自带字段，不依赖登录）。
    try {
      const topUrl = 'https://api-pan.xunlei.com/drive/v1/share?share_id=' + encodeURIComponent(shareId) + '&pass_code=' + encodeURIComponent(pwd) + '&limit=100&page_token=&thumbnail_size=SIZE_SMALL';
      const topHeaders = { 'Content-Type': 'application/json', 'x-device-id': deviceId, 'x-client-id': clientId, 'Referer': 'https://pan.xunlei.com/s/' + shareId + (pwd ? '?pwd=' + pwd : '') };
      if (captcha) topHeaders['x-captcha-token'] = captcha;
      if (store.authToken) topHeaders['Authorization'] = store.authToken;
      const tr = await xunleiBridgeFetch(topUrl, topHeaders);
      if (tr && tr.__error) bridgeFailed++;
      const tt = (tr && typeof tr.text === 'string') ? tr.text : '';
      // ★ 诊断（2026-08-08）：顶层列表无论成功失败，都把状态/body 前 400 字打出来，
      // 便于真机定位 400/401 根因（是登录态缺失还是参数错）。
      console.warn('[HMDAO][xunlei] >>> 顶层列表 topUrl=', topUrl.slice(0, 120));
      console.warn('[HMDAO][xunlei] >>> 顶层列表 status=', tr && tr.status, ' error=', tr && tr.error, ' body前400=', (tt || '').slice(0, 400));
      maybeCapture(topUrl, tt, { Authorization: store.authToken });
      const tj = JSON.parse(tt);
      if (tj && tj.pass_code_token) { passToken = tj.pass_code_token; bag().passCodeToken = passToken; }
      if (tj && tj.share_id) { shareId = tj.share_id; bag().shareId = shareId; }
      // ★ space 候选收集（2026-08-08）：file_info/download_url 的 space 参数必须填分享响应里的真实
      // space 名（实测硬编码 'share' 会返回 space_name_invalid）。从顶层响应抓 space/space_name/space_id，
      // 加上空串候选（空串在部分分享下也能查），遍历尝试。
      const spaceCandidates = [];
      for (const k of ['space', 'space_name', 'space_id']) { if (tj && tj[k] && spaceCandidates.indexOf(tj[k]) < 0) spaceCandidates.push(tj[k]); }
      if (spaceCandidates.indexOf('') < 0) spaceCandidates.push(''); // 空串候选放最后兜底
      bag().spaceCandidates = spaceCandidates;
      console.warn('[HMDAO][xunlei] spaceCandidates=', JSON.stringify(spaceCandidates), 'listTopKeys=', JSON.stringify(Object.keys(tj || {})));
    } catch (e) { console.log('[HMDAO][xunlei] resolveDirect 补顶层列表失败', e && e.message); }
    if (!passToken) { console.log('[HMDAO][xunlei] resolveDirect 仍无 pass_code_token，放弃'); return { ok: false, out: {} }; }
    const spaceCandidates = (bag().spaceCandidates && bag().spaceCandidates.length) ? bag().spaceCandidates : [''];

    for (const fid of fileIds) {
      if (!fid) continue;
      // ★ 被动捕获优先（2026-08-08）：页面自身点击「下载」时，maybeCapture 已通过 parseDownloadUrl
      //   把真实直链写入 store.fileInfo[fid].direct。优先复用，避免扩展主动猜 download_url 参数
      //   （迅雷新版分享态 download_url 参数语义不稳定，主动调易 404）。
      const passive = (bag().fileInfo[fid] && bag().fileInfo[fid].direct) || '';
      if (passive) {
        out[fid] = passive;
        try { console.log('[HMDAO][xunlei] 复用被动捕获直链', fid, passive.slice(0, 80)); } catch (_) {}
        continue; // 已拿到直链，跳过主动请求
      }
      // 正确接口：drive/v1/share/file_info（GET，带 pass_code_token），不要求转存。
      // ★ 多 space 候选遍历（2026-08-08）：space 参数值未知（实测 'share' 无效），
      // 遍历 spaceCandidates，首个返回可用直链的即采用。
      let fileInfoOk = false;
      for (const sp of spaceCandidates) {
        const url = 'https://api-pan.xunlei.com/drive/v1/share/file_info?pass_code_token=' + encodeURIComponent(passToken) + (sp ? '&space=' + encodeURIComponent(sp) : '') + '&file_id=' + encodeURIComponent(fid) + '&share_id=' + encodeURIComponent(shareId) + '&pass_code=' + encodeURIComponent(pwd);
        try {
        const headers = { 'Content-Type': 'application/json', 'x-device-id': deviceId, 'x-client-id': clientId, 'Referer': 'https://pan.xunlei.com/s/' + shareId + (pwd ? '?pwd=' + pwd : '') };
        // ★CORS 死局修复（2026-08-07）：pass_code_token 同时作为 header x-pass-code-token 发送，
        // 并经 xunleiBridgeFetch → background 代理（dNR 钉 ACAO 为具体 origin + include 带登录态），
        // 同时解决 401（鉴权）和 net::ERR_FAILED（CORS 预检 * 冲突）。
        if (passToken) headers['x-pass-code-token'] = passToken;
        if (captcha) headers['x-captcha-token'] = captcha;
        if (store.authToken) headers['Authorization'] = store.authToken;
        const r = await xunleiBridgeFetch(url, headers);
        // bridge 失败时 r 没有 .text() 方法（resolve 的是 {status,text,__error}），
        // 直接用字符串 r.text，避免 await r.text() 抛 TypeError 把整条解析吞掉。
        // 仅真正通道错误（非 http- 状态错误）计入 bridgeFailed，避免 404 参数错被误判为扩展失效
        if (r && r.__error && !/^http-/.test(String(r.__error))) bridgeFailed++;
        const t = (r && typeof r.text === 'string') ? r.text : '';
        // ★ bridge 通道断裂（Extension context invalidated / 扩展重载）诊断：
        //   此时 r.__error 形如 'bridge-error:...' 或 'bridge-timeout'。必须明确标记，
        //   不能再往下走「解析 body 找直链」的逻辑（body 是空的），否则会把「通道断」误报成「接口 404 参数错」。
        const bridgeBroken = !!(r && r.__error && !/^http-/.test(String(r.__error)));
        if (bridgeBroken) {
          console.warn('[HMDAO][xunlei] file_info BRIDGE-BROKEN', fid, 'sp=', sp, 'err=', r.__error, '（扩展被重载？请刷新分享页重新解析）');
          details[fid] = { status: 0, error: String(r.__error), via: 'bridge-broken', body: '' };
          // 跳出 space 候选循环：通道已断，试其他 space 无意义
          break;
        }
        maybeCapture(url, t, { Authorization: store.authToken });
        // parseFileInfo 已把结果写入 store.fileInfo[fid]，回读即可
        out[fid] = (bag().fileInfo[fid] && bag().fileInfo[fid].direct) || '';
        let parsed = null;
        let subIdFromInfo = '';
        if (!out[fid]) {
          let direct = '';
          try {
            parsed = JSON.parse(t);
            const fi = parsed && (parsed.file_info || (parsed.data && parsed.data.file_info));
            // ★ 提取 sub_file_id：迅雷分享态 file_info 的顶层 id 是「分享条目 id」，
            //   真实网盘文件 id 在 sub_file_id 字段。download_url 接口必须以 sub_file_id 作
            //   为主 file_id 参数，否则返回 404 not_found（本次日志实锤）。
            if (fi) subIdFromInfo = fi.sub_file_id || fi.subFileId || (fi.file_info && (fi.file_info.sub_file_id || '')) || '';
            // ★ space 候选从 file_info 响应动态提取（2026-08-08 修正）：
            //   顶层列表响应无 space 字段，真实的 space 值（如 'share'/'drive' 等）在 file_info 响应的
            //   space/space_name/space_id 字段里。之前只从顶层列表收集 → spaceCandidates 恒为 [''] →
            //   download_url 不带 space 参数 → 404。现从 file_info 响应补抓并 push 进同一数组引用。
            if (fi) {
              for (const k of ['space', 'space_name', 'space_id']) {
                const v = fi[k];
                if (v && spaceCandidates.indexOf(v) < 0) {
                  spaceCandidates.push(v);
                  bag().spaceCandidates = spaceCandidates.slice();
                  console.warn('[HMDAO][xunlei] spaceCandidates 追加(来自 file_info.', k, ')=', v);
                }
              }
            }
            if (fi && fi.medias && fi.medias.length) {
              const m = fi.medias.find(function (x) { return x.link && x.link.url; }) || fi.medias[0];
              direct = (m && m.link && m.link.url) || fi.download_url || fi.url || '';
            }
            if (!direct) direct = (parsed && (parsed.download_url || (parsed.data && parsed.data.download_url))) || '';
          } catch (_) {}
          out[fid] = direct;
        }
        // ★ space 候选命中即跳出（拿到直链则无需试其他 space 值）
        if (out[fid]) { fileInfoOk = true; }
        // ★ 关键诊断日志：status、body 前 500 字符、直链是否拿到、medias 长度
        const fiTmp = parsed && (parsed.file_info || (parsed.data && parsed.data.file_info));
        if (r && r.__error) {
          // 桥接/main-fetch 失败：把真实错误透传出来，便于定位（CORS / 网络 / Extension context invalidated）
          console.warn('[HMDAO][xunlei] file_info FETCH-FAIL', fid, 'sp=', sp, 'err=', r.__error, 'via=', r.__via, '（扩展被重载？请刷新分享页重新解析）');
          details[fid] = { status: r.status || 0, error: String(r.__error), via: r.__via || 'unknown', body: t.slice(0, 300) };
        } else {
          console.log('[HMDAO][xunlei] file_info result', fid, 'sp=', sp, 'status=', r.status, 'err=', '', 'direct=', !!out[fid], 'medias_len=', (fiTmp && fiTmp.medias && fiTmp.medias.length) || 0, 'via=', r.__via, 'body=', t.slice(0, 1200));
          // ★完整请求 URL 诊断（2026-08-08）：贴出用于定位 space/pass_code_token/file_id 是否正确
          console.warn('[HMDAO][xunlei] file_info URL', url);
          details[fid] = { status: r.status, error: parsed && parsed.error ? (parsed.error.description || parsed.error.message || JSON.stringify(parsed.error)) : '', via: r.__via || 'unknown', body: t.slice(0, 300) };
          if (r.status && r.status >= 200 && r.status < 300) fileInfoOkCount++;
        }
        if (fileInfoOk) break; // ★ 拿到直链，跳出 space 候选循环
        // ★ 被动捕获优先（2026-08-08 闭环修复）：用户在迅雷网页版手动点击下载按钮时，
        //   网页网络层发出的真实 download_url 响应会被 maybeCapture(parseDownloadUrl) 捕获并写入
        //   store.fileInfo[fid].direct。主动请求拿不到直链（分享态 download_url 用分享条目 id 必 404），
        //   因此优先复用被动捕获值，命中则直接跳过主动请求并跳出 space 循环。
        const passiveDirect = (bag().fileInfo[fid] && bag().fileInfo[fid].direct) || '';
        if (passiveDirect) {
          out[fid] = passiveDirect;
          details[fid] = { via: 'passive-capture', hasDirect: true, status: 200, body: '(from page download click)' };
          console.log('[HMDAO][xunlei] resolveDirect 命中被动捕获直链', fid, passiveDirect.slice(0, 80));
          break;
        }
        // ★ 补刀（2026-08-07 / 2026-08-08 修正）：迅雷新版 file_info 接口 medias 为空、无直链。
        //   主动调分享态 download_url 接口拿真实 CDN 直链。
        //   ★根因修正：分享态 download_url 必须以「真实网盘文件 id（sub_file_id）」作主 file_id 参数，
        //   传顶层分享条目 id（file_info 的 id）会返回 404 not_found。sub_file_id 优先取 file_info 响应里的
        //   sub_file_id 字段；兜底查 store.list；再不行才用顶层 fid 尝试。
        if (!out[fid]) {
          try {
            let subId = subIdFromInfo;
            if (!subId) {
              try {
                const item = (store.list || []).find(function (x) { return x.id === fid; });
                subId = item && item.subFileId ? item.subFileId : '';
              } catch (_) {}
            }
            // 依次尝试：(1) 顶层 fid（分享条目 id，file_info 响应里的 id）作主 file_id；
            //           (2) sub_file_id 作主 file_id（兜底，部分旧版分享态用此字段）。
            // ★ 顺序修正（2026-08-08）：实测 file_info 响应的顶层 id（VOj-gdWB...）才是 download_url
            //   接口需要的 file_id 参数；sub_file_id 在新版分享态中多不存在或为同名，优先用顶层 id。
            const tryIds = [];
            tryIds.push({ fileId: fid, label: 'top' });
            if (subId && subId !== fid) tryIds.push({ fileId: subId, label: 'sub' });
            let dr = null, dt = '', got = '', dj = null, lastStatus = 0;
            for (const cand of tryIds) {
              const dlUrl = 'https://api-pan.xunlei.com/drive/v1/share/download_url?share_id=' + encodeURIComponent(shareId) + (sp ? '&space=' + encodeURIComponent(sp) : '') + '&file_id=' + encodeURIComponent(cand.fileId) + '&pass_code_token=' + encodeURIComponent(passToken) + '&pass_code=' + encodeURIComponent(pwd);
              const dlHeaders = Object.assign({}, headers);
              dr = await xunleiBridgeFetch(dlUrl, dlHeaders, 'GET');
              // ★ 只有真正的通道错误（Extension context invalidated / 网络异常）才算 bridgeFailed。
              // HTTP 状态错误（如 404/401，__error 形如 'http-404'）是接口正常响应，bridge 通道健康，
              // 不应计入 bridgeFailed，否则会把「参数错 404」误判成 need-login/bridge-invalidated。
              if (dr && dr.__error && !/^http-/.test(String(dr.__error))) bridgeFailed++;
              dt = (dr && typeof dr.text === 'string') ? dr.text : '';
              lastStatus = dr ? dr.status : 0;
              maybeCapture(dlUrl, dt, { Authorization: store.authToken });
              got = (bag().fileInfo[fid] && bag().fileInfo[fid].direct) || '';
              if (got) break;
              try { dj = JSON.parse(dt); } catch (_) { dj = null; }
              // 明确 404/not_found 才继续尝试下一个候选 id；其它错误（401 等）直接停
              const isNotFound = (dr && dr.status === 404) || (dj && dj.error_code === 5);
              if (!isNotFound) break;
            }
            // ★ 诊断：记录 passToken 是否非空（空则接口必 400），body 加长到 800 便于看真实返回
            const diagBase = { status: lastStatus, passTokenEmpty: !passToken, subFileId: !!subId, usedSubId: !!subId };
            if (got) {
              out[fid] = got;
              details[fid] = Object.assign({ via: 'download_url', hasDirect: true, body: dt.slice(0, 800) }, diagBase);
            } else {
              // 兜底解析（接口返回结构不标准时）
              const fb = (dj && (dj.download_url || (dj.data && dj.data.download_url) || (dj.data && dj.data.url) || dj.url)) || '';
              if (fb) { out[fid] = fb; bag().fileInfo[fid] = { direct: fb, medias: [], ts: Date.now() }; details[fid] = Object.assign({ via: 'download_url-fallback', hasDirect: true, body: dt.slice(0, 800) }, diagBase); }
              else {
                // ★ 完整 download_url 诊断（2026-08-08）：打印 URL + 完整响应体，用于定位参数/接口语义
                console.warn('[HMDAO][xunlei] download_url FAIL', fid, 'status=', lastStatus, 'dlUrl=', dlUrl, 'body=', dt.slice(0, 1200));
                // ★ 始终记录 download_url 失败原因（不再受 file_info 已写 details 的阻挡），
                // 便于区分 401(需登录) / Extension context invalidated(扩展重载) / 400(参数错) / 404(参数错)。
                const isBridgeErr = !!(dr && dr.__error);
                // 401/403 = 真正需登录态（游客态拿不到直链）；404 = 参数错（已由 sub_file_id 重试覆盖）
                const isAuthErr = (lastStatus === 401 || lastStatus === 403);
                if (isAuthErr) needLogin++;
                details[fid] = Object.assign({
                  via: 'download_url',
                  hasDirect: false,
                  needLogin: isAuthErr,
                  bridgeError: isBridgeErr ? String(dr.__error) : '',
                  error: isBridgeErr ? String(dr.__error) : (dj && dj.error ? (dj.error.description || dj.error.message || JSON.stringify(dj.error)) : ''),
                  status: lastStatus,
                  body: dt.slice(0, 800),
                }, diagBase);
              }
            }
          } catch (e) {
            console.log('[HMDAO][xunlei] resolveDirect(download_url) err', fid, e && e.message);
          }
        }
      } catch (e) {
        console.log('[HMDAO][xunlei] resolveDirect(share/file_info) err', fid, e && e.message);
        out[fid] = '';
      }
      } // ★ 闭合 for (const sp of spaceCandidates)
    }
    // needLogin：download_url 返回 401/403（真正需登录态），与 404（参数错）区分。
    // 404 现在已由 sub_file_id 重试覆盖，不应误报 need-login 触发快速失败。
    return { ok: true, out, bridgeFailed, fileInfoOkCount, needLogin, details, diag: diagSnap };
  }

  function parseFileInfo(url, json) {
    const fi = json && (json.file_info || (json.data && json.data.file_info));
    if (!fi) return;
    let fid = '';
    try {
      const u = new URL(url, location.href);
      fid = u.searchParams.get('file_id') || u.searchParams.get('fid') || u.searchParams.get('fileId') || '';
    } catch (_) {}
    if (!fid) return;
    let direct = '';
    let medias = [];
    if (Array.isArray(fi.medias)) medias = fi.medias;
    else if (fi.media) medias = [fi.media];
    else if (fi.link && fi.link.url) { direct = fi.link.url; medias = [{ link: fi.link }]; }
    else if (fi.download_url) { direct = fi.download_url; medias = [{ link: { url: fi.download_url, token: '' } }]; }
    else if (fi.url) { direct = fi.url; medias = [{ link: { url: fi.url, token: '' } }]; }
    if (!direct && medias.length) {
      const m = medias.find(function (m) { return m.link && m.link.url; }) || medias[0];
      direct = ((m && m.link) || {}).url || '';
    }
    const store = bag();
    store.fileInfo[fid] = { direct, medias, ts: Date.now() };
    try { console.log('[HMDAO][xunlei] captured file_info:', fid, 'direct=', !!direct); } catch (_) {}
  }

  function isXunleiApi(url) {
    if (!url || typeof url !== 'string') return false;
    // ★ 2026-08-10 放宽：api-pan.xunlei.com 的所有请求都捕获（个人盘列表接口的真实路径
    //   可能不是 /drive/v1/files，而是别的如 /drive/v1/files 带不同 query，甚至 /webapi/...）。
    //   之前正则只匹配特定子串，导致个人盘列表请求根本没进 maybeCapture（MAIN 钩子抓到了
    //   列表但没走 drive/v1/files 分支，证明真实路径没被正则覆盖）。放宽为「xunlei 域名下
    //   任何 api-pan.xunlei.com 请求」都捕获，并在 maybeCapture 里打印真实 URL 供真机确认 space。
    if (/api-pan\.xunlei\.com/i.test(url)) return true;
    if (!/xunlei\.com/i.test(url)) return false;
    return /(\/drive\/v1\/share|\/drive\/v1\/files|file_info|download_url|\/webapi\/share)/i.test(url);
  }
  function maybeCapture(url, text, reqHeaders) {
    if (!url || typeof text !== 'string') return;
    if (!isXunleiApi(url)) return;
    // 记录最近一次请求携带的鉴权头（已登录页面 fetch 自带 Authorization/Cookie），供主动补发 download_url 使用
    if (reqHeaders && reqHeaders.Authorization) {
      try { bag().authToken = reqHeaders.Authorization; } catch (_) {}
    }
    let json = null;
    try { json = JSON.parse(text); } catch (_) { return; }
    try { console.log('[HMDAO][xunlei] maybeCapture url=', url, 'code=', json && json.code, 'ok=', okCode(json), 'filesLen=', json && (json.files || json.file_list || json.list || (json.data && json.data.files) || []).length); } catch (_) {}
    // ★ 2026-08-10 通用 space 收集：仅从【成功响应】里扫描真实 space 候选。
    //   重要教训：迅雷 400 错误响应体的 error_details[].@type 值是 google.rpc 常量
    //   （STATUS_OK / SOURCE_RESTORE / DEFAULT_FOLDER_TYPE 等），之前被误当 space 收集，
    //   导致 space 候选污染、download_url 全 400。故：
    //   (a) 仅 okCode(json) 为真时收集；
    //   (b) 跳过 error / error_details / @type / error_description 等错误字段；
    //   (c) 只接受字段名含 space 且值形如 xl<数字>_...（迅雷个人盘 space 格式）或明确 space 字段的值；
    //   (d) 显式排除 drive / 空 / 大写常量。
    try {
      if (okCode(json)) {
        const md = bagMyDrive();
        if (!Array.isArray(md.spaceCandidates)) md.spaceCandidates = [];
        const BLACK = /^(drive|STATUS_OK|SOURCE_RESTORE|DEFAULT_FOLDER_TYPE|SPACE_NAME_INVALID|CAPTCHA_INVALID)$/i;
        const pushSpace = (v) => {
          if (!v || typeof v !== 'string' || !v.length || BLACK.test(v)) return;
          if (md.spaceCandidates.indexOf(v) < 0) md.spaceCandidates.push(v);
        };
        const deep = (obj, depth, inErr) => {
          if (!obj || typeof obj !== 'object' || depth > 4) return;
          if (inErr) return; // 错误子树（error_details 等）整枝跳过
          for (const k of Object.keys(obj)) {
            if (/^error(_details)?$|^@type$|error_description|debug_info/i.test(k)) { continue; }
            const val = obj[k];
            if (typeof val === 'string') {
              // 只接受明确像迅雷 space 的值：xl<数字>_ 前缀，或字段名含 space 且非黑名单
              if (/^xl\d+_/i.test(val)) pushSpace(val);
              else if (/space/i.test(k) && val && !/^(drive)$/i.test(val)) pushSpace(val);
            } else if (Array.isArray(val)) {
              if (k === 'error_details') continue; // 显式跳过错误详情数组
              for (const it of val) deep(it, depth + 1, false);
            } else if (typeof val === 'object' && val) {
              deep(val, depth + 1, false);
            }
          }
        };
        deep(json, 0, false);
        const u = (() => { try { return new URL(url); } catch (_) { return null; } })();
        if (u && u.searchParams.get('space') && !BLACK.test(u.searchParams.get('space'))) pushSpace(u.searchParams.get('space'));
      }
    } catch (_) {}

    // ★ 2026-08-09 新增：迅雷自己网盘 drive/v1/files 路径（非 share）
    if (/drive\/v1\/files/.test(url) && !/\/share\//.test(url)) {
      try {
        const u = new URL(url);
        const space = u.searchParams.get('space') || (json && (json.space || (json.data && json.data.space))) || '';
        const path = decodeURIComponent(u.searchParams.get('path') || '') || (typeof location !== 'undefined' && location.href) || '';
        const md = bagMyDrive();
        if (reqHeaders && reqHeaders.Authorization) md.authToken = reqHeaders.Authorization;
        if (reqHeaders && reqHeaders.captcha) md.captchaToken = reqHeaders.captcha;
        // ★ 2026-08-10 修复：迅雷个人盘 download_url 对 space 严格校验，列表接口传的 space=drive
        //   常被 download_url 拒绝（space_name_invalid 400）。真实 space 是 xl<user_id>_<suffix> 形式，
        //   常藏在列表响应的文件条目 space / space_id 字段里。故从顶层 + 每个文件条目收集 space 候选，
        //   不再只信 URL 的 space 参数。
        if (!Array.isArray(md.spaceCandidates)) md.spaceCandidates = [];
        const pushSpace = (v) => { if (v && md.spaceCandidates.indexOf(v) < 0) md.spaceCandidates.push(v); };
        pushSpace(space);
        if (json) {
          for (const k of ['space', 'space_name', 'space_id']) {
            if (json[k]) pushSpace(json[k]);
            if (json.data && json.data[k]) pushSpace(json.data[k]);
          }
        }
        if (space && !/^drive$/.test(space)) md.space = space; // 非 'drive' 的才是真实个人空间名
        if (path) md.path = path;
        console.warn('[HMDAO][xunlei][mydrive] space 候选=', JSON.stringify(md.spaceCandidates), 'urlSpace=', space);
        // download_url 响应（自己网盘点下载按钮时返回）——这是真实 space 的权威来源
        if (/download_url/i.test(url)) {
          console.warn('[HMDAO][xunlei][mydrive] >>> 页面真实 download_url URL=', url, 'code=', json && json.code, 'err=', json && json.error_code);
          const fid = u.searchParams.get('file_id') || (json && json.file_id) || '';
          const realSpace = u.searchParams.get('space') || '';
          if (realSpace && !/^(drive|)$/i.test(realSpace)) {
            md.space = realSpace;
            if (md.spaceCandidates && md.spaceCandidates.indexOf(realSpace) < 0) md.spaceCandidates.push(realSpace);
            // ★ 持久化：点一次下载后，把真实 space 固化到 chrome.storage.local，
            //   后续扫描即使不点下载也能复用（跨 MV3 SW 重启、跨标签页）。
            try { chrome.storage.local.set({ hmdao_xunlei_space: realSpace }); } catch (_) {}
          }
          if (fid) {
            const direct = parseDownloadUrl(fid, json);
            if (direct) md.fileInfo[fid] = direct;
          }
          return;
        }
        // 文件列表
        const files = pickFiles(json);
        if (files && files.length) {
          const mapped = files.map(function (f) {
            const name = f.name || f.file_name || f.fileName || '';
            const id = f.id || f.file_id || f.fileId || f.fid || '';
            const size = Number(f.size || f.file_size || f.fileSize || 0) || 0;
            const isDir = f.is_folder === 1 || f.isFolder === 1 || f.is_dir === 1 || f.isDir === 1 || f.folder === 1 || String(f.category).toLowerCase() === 'folder';
            let medias = [];
            if (Array.isArray(f.medias)) medias = f.medias;
            else if (f.media) medias = [f.media];
            else if (f.link && f.link.url) medias = [{ link: f.link }];
            else if (f.download_url) medias = [{ link: { url: f.download_url, token: '' } }];
            return { id, name, size, isDir, subFileId: f.sub_file_id || f.subFileId || '', medias: medias.map(function (m) { const link = m.link || m; return { url: link.url || m.url || '', token: link.token || m.token || '' }; }).filter(function (m) { return m.url; }) };
          });
          md.list = mapped;
          md.ts = Date.now();
          // ★ 真机诊断：打印列表响应首个文件条目的字段名，确认迅雷是否在条目里返回 space 字段。
          //   若日志里出现 space/space_id 字段，说明动态解析已能拿到真实 space；若完全没有，
          //   则需改用别的端点（诊断信息不足以闭环时再排查）。仅打印一次避免刷屏。
          try {
            if (files && files[0] && !md._diagListKeys) {
              md._diagListKeys = true;
              console.warn('[HMDAO][xunlei][mydrive] 列表条目字段名=', JSON.stringify(Object.keys(files[0])), 'sampleSpace=', JSON.stringify(files[0].space || files[0].space_id || null));
            }
          } catch (_) {}
          // ★ 从「原始」文件条目收集 space 候选（迅雷个人盘真实 space 多藏在条目里）
          for (const f of files) {
            for (const k of ['space', 'space_name', 'space_id']) {
              if (f && f[k]) pushSpace(f[k]);
            }
          }
          console.warn('[HMDAO][xunlei][mydrive] 列表解析后 space 候选=', JSON.stringify(md.spaceCandidates), 'listLen=', mapped.length);
          const fileIdsNow = mapped.filter(function (x) { return !x.isDir && x.id; }).map(function (x) { return x.id; });
          if (fileIdsNow.length) setTimeout(function () { resolveXunleiMyDrive(fileIdsNow); }, 0);
        }
      } catch (_) {}
      return;
    }

    // download_url 接口（已登录页面点击下载时返回真实直链）
    if (/download_url/i.test(url)) {
      // ★ 诊断（2026-08-08）：把页面自己发的 download_url 完整 URL 打出来，这是 space 参数的权威来源。
      // 对比我们主动发的 dlUrl，若页面自带 space=xxx 而我们没有，则说明根因是 space 取值路径不对。
      console.warn('[HMDAO][xunlei] >>> 页面真实 download_url 请求 URL=', url, ' code=', json && json.code, ' err=', json && json.error_code, ' msg=', json && (json.error_msg || json.message));
      parseDownloadUrl(url, json); return;
    }
    // file_info 接口路径固定包含 /file_info；其余 share 接口当列表处理
    if (/file_info/i.test(url)) parseFileInfo(url, json);
    else parseList(json);
  }

  // 从当前页面 URL 解析 pwd（供主动调用 file_info 时使用）
  function pwdFromLoc() {
    try { const m = location.search.match(/[?&]pwd=([\w]+)/); return m ? m[1] : ''; } catch (_) { return ''; }
  }
  function storePwd() {
    const s = bag();
    if (!s.pwd) s.pwd = pwdFromLoc();
  }

  // Hook fetch
  try {
    const origFetch = window.fetch;
    window.fetch = function () {
      storePwd();
      const url = (typeof arguments[0] === 'string' ? arguments[0] : (arguments[0] && arguments[0].url)) || '';
      // ★零侵入：非迅雷网盘域直接透传原生 fetch，避免本文件出现在错误栈顶
      //   （造成「开扩展才报错」假象）。抖音等站点的埋点/失败请求栈顶应回归平台自身文件。
      if (!isXunleiApi(url)) {
        return origFetch.apply(this, arguments);
      }
      const opts = arguments[1] || {};
      const hdrs = opts.headers || {};
      const authHeader = (typeof hdrs === 'object' && !Array.isArray(hdrs)) ? (hdrs.Authorization || hdrs.authorization) : '';
      const captchaHeader = (typeof hdrs === 'object' && !Array.isArray(hdrs)) ? (hdrs['x-captcha-token'] || hdrs['X-Captcha-Token']) : '';
      const p = origFetch.apply(this, arguments);
      if (p && typeof p.then === 'function') {
        if (isXunleiApi(url)) {
          // 记录页面真实请求携带的鉴权头，供主动补发进入文件夹/拿直链使用
          try {
            const store = bag();
            if (authHeader) store.authToken = authHeader;
            if (captchaHeader) store.captchaToken = captchaHeader;
          } catch (_) {}
          p.then(function (resp) {
            try {
              if (resp && typeof resp.clone === 'function') {
                resp.clone().text().then(function (t) { maybeCapture(url, t, { Authorization: authHeader, captcha: captchaHeader }); }).catch(function () {});
              }
            } catch (_) {}
            return resp;
          }).catch(function () {});
        }
      }
      return p;
    };
  } catch (_) {}

  // ★2026-08-24 站点条件化：迅雷 XHR Hook 仅在本类网盘域（pan.xunlei.com / xunlei.com）生效。
  //   其他注入站点（抖音/花瓣/设计素材站）完全不重写 XMLHttpRequest.prototype.open/setRequestHeader，
  //   否则这些站点自身 XHR（统计/clarity/分析）失败时错误栈会挂上 model-api-capture.js 署名，
  //   造成"扩展报错"假象（实际是站点自身 bug）。迅雷捕获只依赖本域名内的 XHR，跨域无关。
  if (/(^|\.)xunlei\.com$/i.test(location.hostname)) {
  // Hook XHR
  try {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      // ★零侵入：非迅雷域直接透传，避免本文件出现在 XHR 错误栈顶
      try {
        const u = (this && this.__hmdao_xunlei_url);
        if (u === undefined || !isXunleiApi(u)) {
          return origSetHeader.apply(this, arguments);
        }
      } catch (_) {}
      try {
        const lname = String(name || '').toLowerCase();
        if (lname === 'authorization' || lname === 'x-captcha-token') {
          const store = bag();
          if (lname === 'authorization' && value) store.authToken = value.indexOf('Bearer ') === 0 ? value : ('Bearer ' + value);
          if (lname === 'x-captcha-token' && value) store.captchaToken = value;
        }
      } catch (_) {}
      return origSetHeader.apply(this, arguments);
    };
    XMLHttpRequest.prototype.open = function () {
      storePwd();
      const url = arguments[1] || '';
      // ★零侵入：非迅雷域直接透传（记录 url 供 setRequestHeader 判断），避免本文件出现在 XHR 错误栈顶
      try { this.__hmdao_xunlei_url = url; } catch (_) {}
      if (!isXunleiApi(url)) {
        return origOpen.apply(this, arguments);
      }
      if (isXunleiApi(url)) {
        const self = this;
        // ★ 记录本次请求携带的鉴权头（axios 用 XHR 发请求时 Authorization 在 send 前通过
        //   setRequestHeader 设置，上面已 hook 收集进 bag；这里从 bag 取出传给 maybeCapture，
        //   解决「XHR 钩子传空 Authorization 导致 background 拿不到登录态」的根因）。
        this.addEventListener('load', function () {
          try {
            const store = bag();
            maybeCapture(url, self.responseText || '', { Authorization: store.authToken || '', captcha: store.captchaToken || '' });
          } catch (_) {}
        });
        // ★ 诊断（2026-08-10）：把个人盘真实请求 URL 原文打印出来，这是 space 参数的权威来源。
        try { console.warn('[HMDAO][xunlei][xhr] 捕获请求 URL=', url); } catch (_) {}
      }
      return origOpen.apply(this, arguments);
    };
  } catch (_) {}
  } // end if xunlei host

  // ★ 2026-08-09 新增：迅雷自己网盘（pan.xunlei.com/?path=...）download_url 主动解析
  // ★ 2026-08-10 修复：迅雷个人盘 space 是 xl<user_id>_<suffix> 形式，不是 'drive'。
  //   原硬编码 'drive' 导致 download_url 返回 space_name_invalid(400)。改为动态解析：
  //   优先 users/me 拿 space_name，其次用已捕获 md.space，最后穷举候选。
  async function resolveXunleiSpaceMine() {
    const md = bagMyDrive();
    const cands = [];
    // ★ 最高优先：持久化的真实 space（之前在页面点下载时由 XHR 钩子捕获并固化到
    //   chrome.storage.local.hmdao_xunlei_space）。这是唯一可靠的真实 space 来源，
    //   即使本次扫描没点下载也能复用（跨 SW 重启、跨标签页）。
    try {
      const persp = await new Promise((resolve) => { try { chrome.storage.local.get('hmdao_xunlei_space', (r) => resolve(r)); } catch (_) { resolve(null); } });
      if (persp && persp.hmdao_xunlei_space && cands.indexOf(persp.hmdao_xunlei_space) < 0) cands.push(persp.hmdao_xunlei_space);
    } catch (_) {}
    // ★ 优先用列表响应收集到的真实 space 候选（条目里的 xl<user>_<suffix>）
    if (Array.isArray(md.spaceCandidates)) for (const s of md.spaceCandidates) { if (s && cands.indexOf(s) < 0) cands.push(s); }
    if (md.space && cands.indexOf(md.space) < 0) cands.push(md.space);
    // ★ 2026-08-10 修正：不再依赖 /drive/v1/users/me（实测对个人盘返回 404，无 space_name）。
    //   改用持久化 space + 页面已登录态（captcha token）直接试 download_url 候选。
    try {
      const meUrl = 'https://api-pan.xunlei.com/drive/v1/users/me';
      const h = { 'Content-Type': 'application/json', 'x-device-id': xunleiDeviceId(), 'x-client-id': xunleiClientId(), 'Referer': 'https://pan.xunlei.com/' };
      if (md.authToken) h.Authorization = md.authToken;
      const me = await xunleiBridgeFetch(meUrl, h, 'GET');
      const t = (me && typeof me.text === 'string') ? me.text : '';
      let j = null; try { j = JSON.parse(t); } catch (_) {}
      const sn = j && (j.space_name || j.spaceName || (j.user && (j.user.space_name || j.user.spaceName)) || (j.data && (j.data.space_name || j.data.spaceName)));
      if (sn && cands.indexOf(sn) < 0) cands.push(sn);
      const sid = j && (j.id || (j.user && j.user.id));
      if (sid && cands.indexOf('xl' + sid) < 0) cands.push('xl' + sid);
    } catch (_) {}
    // 穷举兜底（drive 放最后，因为它已被证实对 download_url 无效；空串最后）
    for (const c of ['drive', '']) { if (cands.indexOf(c) < 0) cands.push(c); }
    return cands;
  }
  async function resolveXunleiMyDrive(fileIds) {
    const md = bagMyDrive();
    if (!fileIds || !fileIds.length) return;
    const deviceId = xunleiDeviceId();
    const clientId = xunleiClientId();
    const path = md.path || '/';
    const baseHeaders = {
      'Content-Type': 'application/json',
      'x-device-id': deviceId,
      'x-client-id': clientId,
      'Referer': 'https://pan.xunlei.com/?path=' + encodeURIComponent(path)
    };
    if (md.authToken) baseHeaders.Authorization = md.authToken;
    if (md.captchaToken) baseHeaders['x-captcha-token'] = md.captchaToken;
    const spaceCandidates = await resolveXunleiSpaceMine();
    console.warn('[HMDAO][xunlei][mydrive] space 候选=', JSON.stringify(spaceCandidates));
    for (const fid of fileIds) {
      if (md.fileInfo[fid] && md.fileInfo[fid].direct) continue;
      let ok = false;
      for (const sp of spaceCandidates) {
        try {
          const dlUrl = 'https://api-pan.xunlei.com/drive/v1/files/download_url?space=' + encodeURIComponent(sp) + '&file_id=' + encodeURIComponent(fid);
          console.warn('[HMDAO][xunlei][mydrive] resolving', fid, 'space=', sp);
          const dr = await xunleiBridgeFetch(dlUrl, baseHeaders, 'GET');
          const dt = (dr && typeof dr.text === 'string') ? dr.text : '';
          maybeCapture(dlUrl, dt, { Authorization: md.authToken, captcha: md.captchaToken });
          // 若已写入直链，说明命中正确 space
          if (md.fileInfo[fid] && md.fileInfo[fid].direct) { ok = true; md.space = sp; break; }
          if (dr && (dr.status === 401 || dr.status === 403)) break; // 鉴权失败跳过
        } catch (e) { console.warn('[HMDAO][xunlei][mydrive] resolve exception', e); }
      }
      if (!ok) console.warn('[HMDAO][xunlei][mydrive] 所有 space 候选均失败 fid=', fid);
    }
  }
  window.__hmdao_xunlei_resolve_mydrive_files = function (fileIds) { try { return resolveXunleiMyDrive(fileIds).then(function () { return bagMyDrive(); }); } catch (e) { return Promise.reject(e); } };
  window.__hmdao_xunlei_mydrive_salvage = function () { try { salvageFromGlobals(); const md = bagMyDrive(); const ids = (md.list || []).filter(function (x) { return !x.isDir && x.id; }).map(function (x) { return x.id; }); return resolveXunleiMyDrive(ids).then(function () { return md; }); } catch (e) { return Promise.resolve(null); } };

  // 兜底扫描：若 3s 后仍未捕获到文件列表，尝试从页面全局变量/HTML 中抢救数据
  window.__hmdao_xunlei_salvage = function () { try { salvageFromGlobals(); return bag(); } catch (e) { return null; } };
  function isFileLike(o) {
    return o && typeof o === 'object' && (o.name || o.file_name || o.fileName) && (o.id || o.file_id || o.fileId || o.fid);
  }
  function salvageFromGlobals() {
    try {
      const isMyDrive = typeof location !== 'undefined' && /pan\.xunlei\.com/.test(location.href) && /\?path=/.test(location.href);
      const store = isMyDrive ? bagMyDrive() : bag();
      if (store.list && store.list.length) return;
      const names = Object.getOwnPropertyNames(window);
      const filesArr = [];
      for (const k of names) {
        try {
          const v = window[k];
          if (!v || typeof v !== 'object') continue;
          let arr = null;
          if (Array.isArray(v)) arr = v;
          else if (v.files && Array.isArray(v.files)) arr = v.files;
          else if (v.file_list && Array.isArray(v.file_list)) arr = v.file_list;
          else if (v.list && Array.isArray(v.list)) arr = v.list;
          else if (v.data && Array.isArray(v.data)) arr = v.data;
          else {
            for (const sub of ['files', 'fileList', 'list', 'data', 'result']) {
              if (v[sub] && Array.isArray(v[sub]) && v[sub].length > 0) { arr = v[sub]; break; }
            }
          }
          if (!arr || !arr.length) continue;
          const sample = arr.find((x) => x && typeof x === 'object');
          if (!sample || !isFileLike(sample)) continue;
          // 找到疑似文件列表
          for (const f of arr) {
            if (!f || typeof f !== 'object' || !isFileLike(f)) continue;
            const name = f.name || f.file_name || f.fileName || '';
            const id = f.id || f.file_id || f.fileId || f.fid || '';
            if (!name || !id) continue;
            const size = Number(f.size || f.file_size || f.fileSize || 0) || 0;
            const isDir = f.is_folder === 1 || f.isFolder === 1 || f.is_dir === 1 || f.isDir === 1 || f.folder === 1 || String(f.category).toLowerCase() === 'folder';
            let medias = [];
            if (Array.isArray(f.medias)) medias = f.medias;
            else if (f.media) medias = [f.media];
            else if (f.link && f.link.url) medias = [{ link: f.link }];
            else if (f.download_url) medias = [{ link: { url: f.download_url, token: '' } }];
            filesArr.push({ id, name, size, isDir, medias: medias.map((m) => { const link = m.link || m; return { url: link.url || m.url || '', token: link.token || m.token || '' }; }).filter((m) => m.url) });
          }
        } catch (_) {}
      }
      if (filesArr.length) {
        store.list = filesArr;
        store.ts = Date.now();
        try { console.log('[HMDAO][xunlei] salvageFromGlobals recovered', filesArr.length, 'files'); } catch (_) {}
      }
    } catch (_) {}
  }

  // DOM 扫描兜底：迅雷分享 API 对子文件夹内容有平台限制（drive/v1/share 只能返回顶层），
  // 真实登录态下页面前端会渲染文件列表。扫描已渲染的 DOM 文件行，提取 name/size/fileId/下载链接，
  // 合并进 store.list，使侧栏能列出用户在网页端已展开看到的素材。
  async function scanXunleiDom() {
    const diag = { selectors: {}, rowSamples: [] };
    try {
      const store = bag();
      // 先触发懒加载：迅雷分享页使用虚拟滚动，向下滚动到底部让全部文件行渲染
      try {
        const scroller = document.querySelector('.file-list, .share-file-list, .xl-list, [class*="fileList"], [class*="file-list"], .share-content, [class*="shareContent"], main, .main, #root, .ant-layout-content') ||
                          document.documentElement;
        const step = Math.max(300, Math.floor((scroller.scrollHeight || document.body.scrollHeight) / 10));
        for (let i = 0; i < 12; i++) {
          scroller.scrollTo({ top: (i + 1) * step, behavior: 'instant' });
          window.scrollTo(0, (i + 1) * step);
          await new Promise((r) => setTimeout(r, 150));
        }
        scroller.scrollTo({ top: 0, behavior: 'instant' });
        window.scrollTo(0, 0);
        await new Promise((r) => setTimeout(r, 300));
      } catch (_) {}

      const rows = [];
      const pushRow = function (row, source) {
        if (!row || !row.name) return;
        if (!rows.some((r) => r.name === row.name || (row.id && r.id === row.id))) {
          row.__source = source;
          rows.push(row);
        }
      };

      // ★ 修复（2026-08-08）：分享链接指向文件夹时，drive/v1/share 只返回顶层文件夹，
      // 且进入子文件夹需 captcha（API 直调被拦）。改用页面自身会话：自动点击文件夹项，
      // 让迅雷前端 SPA 加载子内容（合法会话，无需 captcha）。点击后 MutationObserver
      // 会在 300ms 后重新触发本函数，届时 DOM 已含文件行。
      // 限制：仅在「当前列表全是文件夹、且尚未展开过」时点击，避免死循环。
      try {
        const curList = store.list || [];
        const hasFile = curList.some((f) => f && !f.isDir);
        const folders = curList.filter((f) => f && f.isDir && f.id);
        if (folders.length && !hasFile) {
          store.__xunleiClicked = store.__xunleiClicked || {};
          const remaining = folders.filter((f) => !store.__xunleiClicked[f.id]);
          if (remaining.length) {
            for (const f of remaining) {
              store.__xunleiClicked[f.id] = true;
              // 优先点主区域的文件夹行（排除侧边栏 SourceListItem，点它只切换选中态不展开主区）
              const el = document.querySelector('.ant-table-row[data-file-id="' + (window.CSS && CSS.escape ? CSS.escape(f.id) : f.id) + '"], [class*="file-list"] [data-file-id="' + (window.CSS && CSS.escape ? CSS.escape(f.id) : f.id) + '"], [class*="FileList"] [data-file-id="' + (window.CSS && CSS.escape ? CSS.escape(f.id) : f.id) + '"]') ||
                         document.querySelector('[data-file-id="' + (window.CSS && CSS.escape ? CSS.escape(f.id) : f.id) + '"]');
              if (el) {
                try {
                  el.click();
                  try { console.log('[HMDAO][xunlei] auto-clicked folder', f.name, f.id, 'cls=', (el.className || '').toString().slice(0, 60)); } catch (_) {}
                } catch (_) {}
              } else {
                try { console.log('[HMDAO][xunlei] folder el not found for click', f.id); } catch (_) {}
              }
            }
            // 等待 SPA 加载子内容后再继续扫描
            await new Promise((r) => setTimeout(r, 2500));
          }
        }
      } catch (_) {}

      // 策略 A：找带 file-id / fid / id 属性的元素（现代前端常用）
      const attrEls = Array.from(document.querySelectorAll('[data-file-id], [data-fid], [data-id], [file-id], [fid], [data-key], [data-row-key]'));
      diag.selectors.attrCount = attrEls.length;
      attrEls.forEach(function (el) {
        const row = findXunleiRow(el);
        if (row) pushRow(row, 'attr');
      });

      // 策略 A+：迅雷新版可能把文件信息放在 role=row / tr / 列表项里
      document.querySelectorAll('tr, [role="row"], .ant-list-item, [class*="list-row"], [class*="file-item"], [class*="fileItem"]').forEach(function (el) {
        const row = findXunleiRow(el);
        if (row) pushRow(row, 'row');
      });

      // 策略 B：通过文件名文本反推行（对无 data-id 的旧版/动态行有效）。
      // 不限于叶子节点：文件名常在 <a>/<span> 里，且同一行还包含大小/日期。
      // ★ 放宽（2026-08-08）：不只压缩包，任何「文件名+大小」格式的行都视作素材。
      document.querySelectorAll('*').forEach(function (el) {
        const text = (el.textContent || '').trim();
        // 匹配「含文件扩展名」或「含大小格式（如 1.2 GB）的文件名行」
        if (/\.(zip|rar|7z|tar|gz|tgz|iso|dmg|001|part|tar\.gz|exe|apk|mp4|pdf|docx?|xlsx?|pptx?|png|jpg|jpeg|gif|webp|mov|mkv|avi|flv)$/i.test(text) ||
            (/^\S+\.\S+\s+\d+\.?\d*\s*(B|KB|MB|GB|TB)$/i.test(text))) {
          const row = findXunleiRow(el);
          if (row) pushRow(row, 'text');
        }
      });

      // 策略 C：直接从整页文本匹配 zip 文件名+大小兜底（虚拟滚动只渲染部分行时，
      // 至少把文件名收入 list，id 留空；后续 netdiskResolve 可用 name 做占位提示）。
      const bodyText = document.body ? document.body.innerText : '';
      const zipNameRe = /[^\s\n]+\.(zip|rar|7z|tar\.gz|gz|tgz|iso|dmg|001|part)/gi;
      let m;
      while ((m = zipNameRe.exec(bodyText)) !== null) {
        const name = m[0].trim();
        if (name && !rows.some((r) => r.name === name)) {
          // 尝试在 name 附近找大小
          const around = bodyText.substring(Math.max(0, m.index - 120), Math.min(bodyText.length, m.index + 180));
          const sm = around.match(/(\d+\.?\d*)\s*(B|KB|MB|GB|TB)/i);
          pushRow({ id: '', name: name.slice(0, 200), size: sm ? parseSizeText(sm[0]) : 0, href: '' }, 'text-regex');
        }
      }

      // 策略 D：从页面全局变量/JS 状态里找文件列表（迅雷现代 SPA 常把列表存在 window.__INITIAL_STATE__ / __DATA__ / xl 等）
      try {
        const globals = [window.__INITIAL_STATE__, window.__DATA__, window.__data__, window.xl, window.XL, window.__APP__, window.__app__, window.__store__, window.store];
        for (const g of globals) {
          if (!g) continue;
          const candidates = [];
          // 递归搜索对象中的 files/list 数组
          function walk(obj, depth) {
            if (!obj || depth > 8) return;
            if (Array.isArray(obj)) {
              for (const item of obj) walk(item, depth + 1);
            } else if (typeof obj === 'object') {
              const keys = Object.keys(obj);
              if ((keys.includes('files') || keys.includes('list') || keys.includes('fileList')) && Array.isArray(obj.files || obj.list || obj.fileList)) {
                const arr = obj.files || obj.list || obj.fileList;
                for (const item of arr) candidates.push(item);
              }
              for (const k of keys) walk(obj[k], depth + 1);
            }
          }
          walk(g, 0);
          for (const item of candidates) {
            if (!item || typeof item !== 'object') continue;
            const name = item.name || item.file_name || item.fileName || '';
            if (/\.(zip|rar|7z|tar\.gz|gz|tgz|iso|dmg|001|part)$/i.test(name)) {
              const id = item.id || item.file_id || item.fileId || item.fid || '';
              pushRow({ id: String(id), name: String(name).slice(0, 200), size: parseSizeText(item.size || item.file_size || ''), href: item.url || item.link || '' }, 'global');
            }
          }
        }
      } catch (_) {}

      // 诊断采样
      if (rows.length) {
        diag.rowSamples = rows.slice(0, 5).map(function (r) { return { name: r.name, id: r.id ? 'yes' : 'no', size: r.size, source: r.__source }; });
      }
      diag.totalRows = rows.length;
      diag.beforeListLen = (store.list || []).length;

      if (rows.length) {
        const seen = {};
        (store.list || []).forEach(function (f) { if (f && f.id) seen[f.id] = true; });
        let added = 0;
        rows.forEach(function (r) {
          if (!r.name) return;
          // 生成稳定 id：优先 fileId；没有则用 name 做伪 id，确保能列出
          const id = r.id || ('dom-name-' + r.name);
          if (seen[id]) return;
          seen[id] = true;
          store.list.push({ id, name: r.name, size: r.size, isDir: !!r.isDir, source: 'dom' });
          if (r.href && !store.fileInfo[id]) store.fileInfo[id] = { direct: r.href, medias: [{ url: r.href, token: '' }], ts: Date.now() };
          added++;
        });
        store.ts = Date.now();
        try { console.log('[HMDAO][xunlei] scanXunleiDom recovered', added, 'files from DOM (total rows=', rows.length, ')', 'diag=', diag); } catch (_) {}
      } else {
        try { console.log('[HMDAO][xunlei] scanXunleiDom recovered 0 files; bodyText sample=', bodyText.slice(0, 400)); } catch (_) {}
      }
      try { window.__hmdao_xunlei_diag = window.__hmdao_xunlei_diag || {}; window.__hmdao_xunlei_diag.lastScan = diag; } catch (_) {}
    } catch (e) {
      diag.error = e && e.message;
      try { window.__hmdao_xunlei_diag = window.__hmdao_xunlei_diag || {}; window.__hmdao_xunlei_diag.lastScan = diag; } catch (_) {}
      try { console.log('[HMDAO][xunlei] scanXunleiDom error', e && e.message); } catch (_) {}
    }
  }
  // 给定元素，向上查找文件行并提取 name/size/id
  function findXunleiRow(el) {
    try {
      let row = el.closest && el.closest('[data-file-id], [data-fid], [data-id], [class*="file-item"], [class*="file-row"], [class*="list-item"]');
      if (!row) {
        // 向上最多 6 层找包含文件名+大小的行
        let p = el.parentElement;
        for (let i = 0; i < 6 && p; i++, p = p.parentElement) {
          const txt = (p.textContent || '').trim();
          if (/\.(zip|rar|7z|tar|gz|tgz|iso|dmg|001|part|tar\.gz)/i.test(txt) && /\d+\.?\d*\s*(B|KB|MB|GB|TB)/i.test(txt)) { row = p; break; }
        }
      }
      if (!row) row = el;
      const textAll = (row.textContent || '').trim();
      // 提取文件名：优先 data-title/aria-label/class*name
      const nameEl = row.querySelector('[class*="name"], [data-name], [title], [data-title], .file-name, .title') || row;
      let name = (nameEl.getAttribute && (nameEl.getAttribute('title') || nameEl.getAttribute('data-title') || nameEl.getAttribute('data-name'))) ||
                 (nameEl.textContent || '').split(/\s{2,}|\n/)[0] || '';
      name = String(name).trim();
      if (!/\.(zip|rar|7z|tar|gz|tgz|iso|dmg|001|part|tar\.gz)$/i.test(name)) {
        // 从整行文本里抓文件名
        const m = textAll.match(/[^\s\n]+\.(zip|rar|7z|tar\.gz|gz|tgz|iso|dmg|001|part)/i);
        if (m) name = m[0];
      }
      if (!name) return null;
      const sizeEl = row.querySelector('[class*="size"], .file-size, [data-size]');
      let size = parseSizeText(sizeEl ? sizeEl.textContent : '');
      if (!size) {
        const sm = textAll.match(/(\d+\.?\d*)\s*(B|KB|MB|GB|TB)/i);
        if (sm) size = parseSizeText(sm[0]);
      }
      let id = '';
      const rowAttrs = row.attributes || [];
      for (let i = 0; i < rowAttrs.length; i++) {
        const n = rowAttrs[i].name;
        if (/^(data-)?(file[_-]?id|fid|id)$/i.test(n)) { id = rowAttrs[i].value; break; }
      }
      // 判断是否为文件夹：行内出现「N项」/「N 项」或图标类含 folder/dir 字样
      const isDir = /项\b|\bfolder\b|\bdir\b/i.test(textAll) || /(folder|dir)/i.test((row.className || '') + ' ' + ((row.getAttribute && row.getAttribute('class')) || ''));
      const href = (row.querySelector('a[href*="download"], a[href*="file_id"], a[href*="fid="]') || {}).href || '';
      // ★ 修复（2026-08-08）：不再强求文件名是压缩包——所有带 data-file-id 的行都视作素材（文件或文件夹）
      return { id, name: name.slice(0, 200), size, href, isDir };
    } catch (_) { return null; }
  }
  function parseSizeText(t) {
    if (!t) return 0;
    const m = String(t).match(/([\d.]+)\s*(KB|MB|GB|TB|B)/i);
    if (!m) return 0;
    const n = parseFloat(m[1]); const u = m[2].toUpperCase();
    const mul = { B: 1, KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024, TB: 1024 * 1024 * 1024 * 1024 }[u] || 1;
    return Math.round(n * mul);
  }
  window.__hmdao_xunlei_scan_dom = scanXunleiDom;
  try {
    if (typeof MutationObserver !== 'undefined') {
      const mo = new MutationObserver(function () { setTimeout(scanXunleiDom, 300); });
      mo.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(scanXunleiDom, 1500);
      setTimeout(scanXunleiDom, 4000);
    }
  } catch (_) {}
  try {
    if (document.readyState === 'complete') setTimeout(salvageFromGlobals, 2500);
    else window.addEventListener('load', () => setTimeout(salvageFromGlobals, 1500));
  } catch (_) {}

  // 暴露给侧栏主动调用的批量直链解析函数（复用页面自身鉴权上下文，走 download_url 接口）
  window.__hmdao_xunlei_resolve_files = async function (fileIds) {
    const store = bag();
    let shareId = store.shareId || '';
    const pwd = store.pwd || pwdFromLoc();
    if (!shareId) shareId = shareIdFromUrl();
    if (!shareId || !Array.isArray(fileIds) || !fileIds.length) {
      try { console.log('[HMDAO][xunlei] resolve_files skipped:', { shareId: !!shareId, fileIds: fileIds && fileIds.length }); } catch (_) {}
      return { ok: false, error: 'missing-share-context' };
    }
    const results = {};
    // 直链通过 download_url 接口获取（file_info 在新接口中 medias 为空，无直链）
    const out = await resolveXunleiDirect(fileIds.filter(function (fid) {
      if (!fid) return false;
      const existing = store.fileInfo[fid] && store.fileInfo[fid].direct;
      if (existing) results[fid] = store.fileInfo[fid];
      return !existing;
    }));
    // 合并 download_url 结果
    if (out && out.out) {
      for (const fid of Object.keys(out.out)) {
        const direct = out.out[fid];
        if (direct && !store.fileInfo[fid]) store.fileInfo[fid] = { direct: '', medias: [], ts: 0 };
        if (direct) { store.fileInfo[fid].direct = direct; store.fileInfo[fid].ts = Date.now(); results[fid] = store.fileInfo[fid]; }
      }
    }
    // 根因区分（2026-08-08 / 2026-08-08 修正）：
    // - bridge 全失败 且 file_info 也全失败 → 真正的 Extension context invalidated（扩展被重载）→ 提示刷新分享页。
    // - download_url 返回 401/403（needLogin>0）→ 真正需登录态 → 报 need-login，让侧栏提示先登录迅雷网页版。
    // - download_url 仅 404（参数错，现已用 sub_file_id 重试）→ 不算 need-login，继续走方案 B 或返回明确参数错误。
    // bridge 通道失败（真正的 Extension context invalidated）→ 提示刷新分享页
    if (out && out.bridgeFailed && out.bridgeFailed > 0 && Object.keys(results).length === 0) {
      const fileInfoHealthy = (out.fileInfoOkCount || 0) > 0;
      let errCode = 'bridge-invalidated';
      if (fileInfoHealthy && (out.needLogin || 0) > 0) errCode = 'need-login';
      return { ok: false, error: errCode, results, details: out.details, fileInfoOkCount: out.fileInfoOkCount || 0, needLogin: (out.needLogin || 0) > 0 };
    }
    // ★ 通道健康（bridgeFailed=0）但无直链（download_url 全 404/参数错等）：
    //   明确返回 no-direct，让侧栏快速失败（不再进方案 B 白等 30s 超时）。
    if (Object.keys(results).length === 0) {
      const errCode = (out && (out.needLogin || 0) > 0) ? 'need-login' : 'no-direct';
      return { ok: false, error: errCode, results, details: out.details, fileInfoOkCount: out.fileInfoOkCount || 0, needLogin: (out.needLogin || 0) > 0 };
    }
    return { ok: true, results, details: out.details, fileInfoOkCount: out.fileInfoOkCount || 0, needLogin: (out.needLogin || 0) > 0 };
  };
  // 公开给诊断：扫描 DOM 并返回当前 list/fileInfo 摘要
  window.__hmdao_xunlei_diagnose = async function () {
    await scanXunleiDom();
    const xs = bag();
    return {
      shareId: xs.shareId,
      pwd: xs.pwd,
      listLen: xs.list ? xs.list.length : 0,
      list: (xs.list || []).map((f) => ({ id: f.id, name: f.name, size: f.size, isDir: f.isDir, source: f.source })),
      fileInfoKeys: Object.keys(xs.fileInfo || {}),
      fileInfoDirects: Object.entries(xs.fileInfo || {}).map(([k, v]) => ({ id: k, direct: !!v.direct })),
    };
  };
  window.__hmdao_xunlei_resolve_direct = resolveXunleiDirect;
  window.__hmdao_xunlei_enter_folder = enterXunleiFolder;
  // ★ 调试导出（2026-08-08）：暴露桥接 fetch，供自动化脚本直接探测原始响应结构
  window.__hmdao_xunlei_bridge_fetch = xunleiBridgeFetch;
})();
