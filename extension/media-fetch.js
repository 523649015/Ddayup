// ===== 后台通讯 / 媒体字节拉取（抽离自 sidepanel.js）=====
// 侧栏 → background 的通用通讯封装层；依赖 sidepanel.js 全局 b64ToBytes / window.__sourcePageUrl。
// 本文件在 sidepanel.js 之后加载，纯物理拆分（共享全局作用域），行为零改变。

// 通用后台 fetch：透传任意选项到 HMDAO_FETCH
async function fetchViaBackground(url, options = {}) {
  // 首次跨站请求时懒触发第三方 Cookie 探测（不在加载时触发，避免 Issues 噪音）
  if (typeof window !== 'undefined' && window.__hmdaoLazyCheck3pCookies) {
    try { window.__hmdaoLazyCheck3pCookies(); } catch (_) {}
  }
  return await chrome.runtime.sendMessage({ type: 'HMDAO_FETCH', url, ...options });
}

// 后台带 Referer 拉取媒体字节（ArrayBuffer），绕过侧栏 <video>/<a download> 的签名/Referer 限制
// ★2026-09-11：新增可选第三参 opts = { maxBytes } —— 透传到 HMDAO_FETCH_MEDIA
//   （background.js:4684 已支持 payload.maxBytes：先 HEAD 探长度，超限直接拒绝，不下载不回传）。
//   悬停抽帧等"只要首帧"的场景必须带上限，否则整文件拉完再 base64 回传会打满 SW 通道。
async function fetchMediaViaBackground(url, referer, opts) {
  // ★2026-09-01 修复（控制台 "Third-party cookie will be blocked" 告警真凶）：
  //   background.js:2212 兜底分支：
  //     creds = (googlevideo|youtube) ? 'omit' : (msg.credentials ?? 'include')
  //   本函数此前【从不传 credentials】→ 抖音等非 YouTube 平台一律回落 'include'
  //   → Chrome 判定为第三方 Cookie 并拦截 → 控制台刷 "Third-party cookie will be blocked"。
  //   （日志实证：[HMDAO][bg] FETCH_MEDIA failed ... creds=include）
  //   但 background.js:4064-4066 注释已明确：抖音/TikTok/视频号等媒体【仅靠 URL 签名 + Referer
  //   鉴权、不需要登录 Cookie】→ 应对其传 'omit' 以消除告警。
  //   ★边界：B站/爱给等确实需要 SESSDATA session 的平台【保持不传】（沿用 'include'），
  //   不破坏其鉴权，只针对字节系平台优化。
  const u = String(url || '');
  // ★守卫：伪 URL（豆包 WS 朗读 doubao-ws-audio://ts 等）不得进 fetch，
  //   否则控制台刷 "URL scheme is not supported"（违反不报错边界）。
  if (!/^https?:/i.test(u)) return { ok: false, error: 'unsupported-scheme' };
  const noCookieNeeded = /douyin|douyinvod|iesdouyin|bytedance|tiktok|v26-web/i.test(u);
  const payload = {
    type: 'HMDAO_FETCH_MEDIA',
    url,
    referer,
    credentials: noCookieNeeded ? 'omit' : undefined,
  };
  // ★2026-09-11：maxBytes 透传（仅正整数才透传，不影响既有两参调用方的行为）
  try {
    const mb = (opts && typeof opts === 'object') ? parseInt(opts.maxBytes, 10) : 0;
    if (mb > 0) payload.maxBytes = mb;
  } catch (_) {}
  return await chrome.runtime.sendMessage(payload);
}

// 同会话内已拉取的封面 URL -> blob URL 缓存，避免列表重渲/滚动时重复 fetch 后台。
const __thumbCache = new Map();

// ===== 2026-09-11 统一占位图识别（imini / runninghub 等「CDN 软失败回 200+占位图」根因）=====
//   根因：部分图床（iminicdn、rh-images.xiaoyaoyou.com 等）在 Referer/Cookie 校验失败时
//   【不返回 403】，而是返回 200 + 一张统一的品牌/绿色占位图。旧逻辑只按「字节 <6KB」判定可疑，
//   >6KB 的占位图被当成正常封面 → 写进 __thumbCache 与 card-render 的 HMDAO_COVER_CACHE
//   双缓存 → 永久污染、后续永不重试（用户看到一片错图/绿图）。
//   方案：自学习登记，按内容哈希判定，不需要站点黑名单——
//     同一哈希被 ≥3 个【不同 URL】命中 ⇒ 这些 URL 返回的是同一张图 ⇒ 判定为「统一占位图」。
//   命中后：不写缓存、不返回 blobUrl、URL 进 PLACEHOLDER_SET（card-render 据此立即判死不再重试）。
// ★2026-09-11 修订（QA 回归 P1：抖音系真封面被误判死）：
//   登记键【必须】归一化成 origin+pathname（与 card-render.js 的 coverCacheKey 同口径）。
//   原因：抖音图床封面是「限时签名 URL」，每次轮询/重扫 query 里的 x-expires/x-signature 都变，
//   而 __thumbCache 按完整 URL 作键 → 换签名即缓存未命中 → 重新 fetch 同一份字节 → 再登记一次。
//   用完整 URL 登记时，同一张【真封面】只要换 3 次签名就凑满阈值 → 被永久判死 → 误伤抖音。
//   归一化后：抖音换签名只记 1 个键（永不达阈值）；imini 各卡 pathname 不同，照样能凑满 3 个。
const PLACEHOLDER_HASH_URLS = new Map();  // 内容哈希 -> Set<归一化 url 键>
const PLACEHOLDER_SET = new Set();        // 已判定为统一占位图的【归一化 url 键】
const PLACEHOLDER_MIN_URLS = 3;           // 同一哈希命中多少个不同 URL 才判定为占位图
const PLACEHOLDER_HASH_CAP = 300;         // 登记表容量上限（防内存无限增长，超限即停止登记）
// ★2026-09-11（QA K-1）：已被【源页 Cookie 重试救回】的键（证明该 URL 返回的是真实封面）。
//   进入本集合的键永不判死，且从 PLACEHOLDER_SET 移除——否则"追溯判死"会把救回的 URL 又打回去。
const PLACEHOLDER_RESCUED = new Set();
const PLACEHOLDER_RESCUED_CAP = 1000;

// 归一化键：origin + pathname（剥离签名/时间戳等 query 与 hash）
function hmdaoCoverKeyOf(u) {
  try {
    const x = new URL(String(u || ''));
    return x.origin + x.pathname;
  } catch (_) { return String(u || ''); }
}

// FNV-1a 哈希（只取前 64KB 参与，兼顾性能与区分度；长度并入 key 以降低碰撞误判）
function hmdaoCoverHash(bytes) {
  try {
    const n = Math.min(bytes.length, 65536);
    let h = 0x811c9dc5;
    for (let i = 0; i < n; i++) {
      h ^= bytes[i];
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return 'f' + h.toString(36) + 'n' + bytes.length;
  } catch (_) { return ''; }
}

// 登记一次封面字节。返回 true = 该 URL 已被判定为「统一占位图」（此时禁止写缓存 / 返回 blobUrl）。
// 注意：内部一律按【归一化键】（origin+pathname）登记与查询，避免签名轮换导致误判（见上方注释）。
function hmdaoNoteCoverBytes(url, bytes) {
  try {
    const u = String(url || '');
    if (!u || !bytes || !bytes.length) return false;
    const key = hmdaoCoverKeyOf(u);
    if (!key) return false;
    // ★K-1：该 URL 已被证明返回真实封面（源页 Cookie 重试救回）→ 永不参与判死
    if (PLACEHOLDER_RESCUED.has(key)) return false;
    const h = hmdaoCoverHash(bytes);
    if (!h) return false;
    let set = PLACEHOLDER_HASH_URLS.get(h);
    if (!set) {
      if (PLACEHOLDER_HASH_URLS.size >= PLACEHOLDER_HASH_CAP) return false;
      set = new Set();
      PLACEHOLDER_HASH_URLS.set(h, set);
    }
    set.add(key);
    if (set.size < PLACEHOLDER_MIN_URLS) return false;
    // 命中阈值：把登记表里该哈希的【全部】键（含此前已放行过的）一起判死，并撤销其缓存
    set.forEach((k) => hmdaoRevokeCover(k));
    hmdaoRevokeCover(key);
    return true;
  } catch (_) { return false; }
}

// 判死某个封面键：加入 PLACEHOLDER_SET，并撤销 __thumbCache 中该键的 blob（连同 blob 内存一起释放）
function hmdaoRevokeCover(key) {
  // ★K-1：被救回的键不得再被（追溯）判死
  try { if (PLACEHOLDER_RESCUED.has(key)) return; } catch (_) {}
  try { PLACEHOLDER_SET.add(key); } catch (_) {}
  try {
    if (__thumbCache.has(key)) {
      const old = __thumbCache.get(key);
      // ★2026-09-11（QA P3）：只 delete 不 revoke 会漏掉 blob 内存。
      //   已上屏的 <img> 不受影响（字节已解码）；未完成的加载会走既有 🎬 兜底。
      if (typeof old === 'string' && old.indexOf('blob:') === 0) { try { URL.revokeObjectURL(old); } catch (_) {} }
      __thumbCache.delete(key);
    }
    // __thumbCache 以【完整 URL】为键（常带签名 query），按归一化键再扫一遍把同图的缓存一并撤销
    __thumbCache.forEach((v, k) => {
      if (hmdaoCoverKeyOf(k) !== key) return;
      if (typeof v === 'string' && v.indexOf('blob:') === 0) { try { URL.revokeObjectURL(v); } catch (_) {} }
      __thumbCache.delete(k);
    });
  } catch (_) {}
}

// 供 card-render.js 查询：该封面 URL 是否已被判定为统一占位图（判死后不再重试、不再走 4 次 retry）
function isPlaceholderCover(url) {
  try { return PLACEHOLDER_SET.has(hmdaoCoverKeyOf(url)); } catch (_) { return false; }
}

// ★2026-09-11（QA K-1）：源页 Cookie 重试【确实拿到了与占位图不同的图】⇒ 该 URL 不是占位图，撤销判死。
//   不撤销的话：键已在黑名单里 → loadImageViaRelay 首行即 return null → 第二次渲染开始这张真封面
//   就再也取不回来（只闪一次），等于白付一次源页 in-tab 请求，收益为负。
//   撤销后该键进 PLACEHOLDER_RESCUED，后续"追溯判死"也不会把它再打回去。
function hmdaoMarkCoverRescued(url) {
  try {
    const key = hmdaoCoverKeyOf(url);
    if (!key) return;
    if (PLACEHOLDER_RESCUED.size < PLACEHOLDER_RESCUED_CAP) PLACEHOLDER_RESCUED.add(key);
    PLACEHOLDER_SET.delete(key);
  } catch (_) {}
}
try { if (typeof window !== 'undefined') window.__hmdaoIsPlaceholderCover = isPlaceholderCover; } catch (_) {}

// ★2026-09-11「源页带 Cookie 回退」的平台族登记表 + 熔断：
//   源页内 fetch 受【源页 CSP connect-src】约束。一旦用 A 站页面去取 B 站资产，浏览器会直接
//   抛 "Refused to connect ... violates CSP" —— 这是【浏览器打印】的报错，JS 无法 catch，
//   因此绝不做"先试一次看行不行"的探针（探针本身就会在源页产生红字）。
//   改为退化的安全方案：① 显式成对登记（严禁通配）② 任一失败即对该 tab+图床 熔断一段时间，
//   后续不再重试 —— 保证失败时不产生新的控制台报错。
const PAGE_FETCH_PAIRS = [
  // [源页 host 正则, 图床 host 正则]
  [/imini\.ai$/i, /iminicdn\.com$/i],   // imini（即梦国际版）↔ 其 CDN
];
const PAGE_FETCH_BREAKER = new Map();   // '<tabId>|<assetHost>' -> 解禁时间戳(ms)
const PAGE_FETCH_BREAKER_MS = 5 * 60 * 1000;

// ★2026-09-01 字节魔术判断真实类型（不信任服务器返回的 mime）。
//   为什么不能"严格 mime 校验"：HMDAO_FETCH_MEDIA 的 mime 兜底是 'video/mp4'
//   （background.js:2279，为视频下载设计的兜底），而本函数复用同一通道拉【图片】——
//   服务器不返回 Content-Type 时 mime 就是 'video/mp4'，若严格校验会把这些正常图片全误杀。
//   故改为按字节判断：明确图片 → 放行；明确视频/音频 → 丢弃；无法识别 → 宽容放行（交给浏览器嗅探）。
//   ★关键陷阱：AVIF/HEIC 图片也用 ISOBMFF(ftyp) 容器，与 MP4 同签名，必须看 ftyp brand 区分。
function sniffBytesKind(b) {
  if (!b || b.length < 4) return 'unknown';
  const ascii = (i, n) => { try { return String.fromCharCode.apply(null, b.subarray(i, i + n)); } catch (_) { return ''; } };
  const hex = (i, n) => { try { return Array.from(b.subarray(i, i + n)).map((x) => x.toString(16).padStart(2, '0')).join(''); } catch (_) { return ''; } };
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image';            // JPEG
  if (hex(0, 8) === '89504e470d0a1a0a') return 'image';                           // PNG
  if (ascii(0, 3) === 'GIF') return 'image';                                      // GIF87a/89a
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image';           // WebP
  if (b[0] === 0x42 && b[1] === 0x4D) return 'image';                             // BMP
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return 'image'; // ICO
  if (ascii(0, 5) === '<?xml' || ascii(0, 4) === '<svg') return 'image';          // SVG
  if (ascii(4, 4) === 'ftyp') {                                                   // ISOBMFF(MP4/AVIF/HEIC 共用)
    const brand = ascii(8, 4);
    if (/^(avif|avis)$/i.test(brand)) return 'image';                             // AVIF 图片
    if (/^(heic|heix|hevc|hevx|mif1|msf1)$/i.test(brand)) return 'image';         // HEIC/HEIF 图片
    return 'video';                                                               // isom/mp42/avc1/dash 等 = 视频
  }
  if (hex(0, 4) === '1a45dfa3') return 'video';                                   // WebM/MKV
  if (ascii(0, 3) === 'ID3') return 'audio';                                      // MP3
  if (ascii(0, 4) === 'OggS') return 'audio';                                     // OGG
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'audio';           // WAV
  return 'unknown';
}

// 通过后台 relay（credentials:'omit'）拉取第三方图片字节 → blob: URL。
// 根因：侧栏直接 img.src=第三方URL 时，源站响应里的 Set-Cookie 会被 Chrome 当作第三方 Cookie 拦截，
// 在 Issues 面板报「Third-party cookie will be blocked」。走 blob 后侧栏不再直连第三方源，消除告警。
async function loadImageViaRelay(url, referer) {
  if (!url) return null;
  // ★2026-09-11：已被判定为「统一占位图」的 URL 直接拒绝，不再重复拉取（避免白占 SW 通道）
  try { if (isPlaceholderCover(url)) return null; } catch (_) {}
  if (__thumbCache.has(url)) return __thumbCache.get(url); // 命中缓存，不重复 fetch
  // ★2026-08-22 修复（封面 relay 返回空：http://127.0.0.1:3000/hmdao-logo.png）：
  // 本地地址（localhost / 127.0.0.1 / [::1]）属于 Web App 开发服务器或本地资源，
  // 不涉及「第三方 Cookie」问题，根本不需要走后台 SW relay（SW 上下文 fetch 本地地址
  // 常因 referer 空 / 跨源被拒 → 返回空 → 卡片封面显示 🪫）。
  // 直接返回原 URL 让侧栏 <img> 直连即可（同源/本地不受第三方 Cookie 限制）。
  try {
    const u = new URL(url);
    if (/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname) || u.protocol === 'blob:' || u.protocol === 'data:') {
      __thumbCache.set(url, url);
      return url;
    }
  } catch (_) {}

  // 抖音/字节系封面图偶用非 douyin 域名短链 CDN，此时仅靠 host 推导 referer 会失败。
  // ★2026-08-31 分平台：tiktok 域强制补 www.tiktok.com；douyin/bytedance 域补 www.douyin.com。
  // ★2026-09-04 修复：封面加载必须用 deriveMediaReferer 按 CDN 域名选平台 origin，
  //   不能直接用 window.__sourcePageUrl（可能带长查询串 / modal_id）。抖音图床对 Referer 严格校验，
  //   用 jingxuan?modal_id=... 全链经常 403 → loadImageViaRelay 返回 null → 视频卡封面空白。
  let finalReferer = (typeof deriveMediaReferer === 'function'
    ? deriveMediaReferer(url, referer || window.__sourcePageUrl || '')
    : (referer || window.__sourcePageUrl || ''));
  if (!finalReferer) {
    if (/tiktok/i.test(url)) finalReferer = 'https://www.tiktok.com/';
    else if (/douyin|douyinpic|bytecdn|douyinstatic|bytedance/i.test(url)) finalReferer = 'https://www.douyin.com/';
  }
  // 第一层：后台 SW 带 Referer 拉字节（适合通用 CDN，对 douyin Pic 防盗链经常 403）
  // ★2026-09-11：swPlaceholder —— 第一层返回 200 但内容是「统一占位图」时置 true，
  //   作为第二层（源页带 Cookie 重试）的并集触发条件之一。
  let r = null;
  let swPlaceholder = false;
  try {
    r = await fetchMediaViaBackground(url, finalReferer);
    if (r && r.ok && r.b64) {
      const bytes = b64ToBytes(r.b64);
      if (bytes && bytes.length) {
        // ★2026-09-01：先按字节判断真实类型。若是视频/音频字节则【丢弃】，
        //   绝不生成 blob 交给 <img>（否则 <img> 解码失败 → 破图 + Chrome 缓存到
        //   %TEMP%\image.<hash>.png，即用户看到的 "@image:C:\...\Temp\image.xxxx.png"）。
        const kind = sniffBytesKind(bytes);
        if (kind === 'video' || kind === 'audio') {
          console.warn('[HMDAO][relay] 丢弃非图片字节（kind=%s, mime=%s）: %s', kind, r.mime, String(url).slice(0, 100));
          return null;
        }
        // ★2026-09-11：统一占位图识别 —— 必须在写 blobUrl / __thumbCache 【之前】拦截。
        //   命中则【只置位不返回】：不写缓存、不生成 blobUrl，让流程继续走到下方
        //   needCookieRetry（并集条件③ swPlaceholder），用源页会话 Cookie 再试一次拿真封面；
        //   若源页那次仍是同一张占位图，第三层同样会被拦下 → 最终返回 null。
        //   （★2026-09-11 修订 QA P2：原写法命中即 return null，导致 swPlaceholder 成为死代码，
        //     注释里承诺的"用源页 Cookie 再试一次"实际从未发生。）
        if (hmdaoNoteCoverBytes(url, bytes)) {
          swPlaceholder = true;
        } else {
          const mime = (r.mime && r.mime.startsWith('image/')) ? r.mime : 'image/*';
          const blobUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
          __thumbCache.set(url, blobUrl);
          return blobUrl;
        }
      }
    }
  } catch (_) {}

  // ★2026-09-10 修复（第三方图床封面 relay 空）：部分 CDN（如 tutupian.top）校验 Referer
  //   必须是本域或空，传源页 URL 会 403/空。第一层失败后，用图床自身 origin 当 Referer 再试一次。
  if (!r || !r.ok || !r.b64) {
    try {
      const selfReferer = 'https://' + (new URL(url).hostname) + '/';
      const r2 = await fetchMediaViaBackground(url, selfReferer);
      if (r2 && r2.ok && r2.b64) {
        const bytes = b64ToBytes(r2.b64);
        if (bytes && bytes.length) {
          const kind = sniffBytesKind(bytes);
          if (kind === 'video' || kind === 'audio') {
            console.warn('[HMDAO][relay] self-referer 丢弃非图片字节（kind=%s）: %s', kind, String(url).slice(0, 100));
            return null;
          }
          // ★2026-09-11：占位图识别（同上，写缓存前拦截）
          if (hmdaoNoteCoverBytes(url, bytes)) return null;
          const mime = (r2.mime && r2.mime.startsWith('image/')) ? r2.mime : 'image/*';
          const blobUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
          __thumbCache.set(url, blobUrl);
          return blobUrl;
        }
      }
    } catch (_) {}
  }

  // 第二层：在源页标签页面上下文 fetch（继承页面会话 Cookie，如 ttwid/SESSDATA/uid_tt），
  //   专为抖音 PCDN / B站防盗链签名图等"必须带会话 Cookie 才回真实图"场景回退。
  //   仅在 SW fetch 明确失败（403/407/空）时才走，避免无谓开销。
  // ★2026-09-08 两处关键补充：
  //   ① 必须传 usePageCookie:true —— 否则走的是不带 Cookie 的 ISOLATED 通道，对即梦
  //      （p*-dreamina-sign.byteimg.com 403）与 runninghub（rh-images.xiaoyaoyou.com）这类
  //      「必须带会话 Cookie 才回真实图」的图床完全无效。
  //   ② 除 403/407/空 外，还要覆盖「SW 返回 200 但字节极小」——runninghub 的图床在
  //      无 Cookie 时【不报 403】，而是回一张统一的绿色占位图（几 KB）。判定为可疑小图
  //      后用带 Cookie 的结果替换（只接受更大的字节，避免覆盖正常小图标）。
  const swStatus = (r && r.status) || 0;
  const swOk = !!(r && r.ok && r.b64);
  const swSize = (r && r.b64) ? Math.floor((r.b64.length * 3) / 4) : 0;
  const SUSPICIOUS_TINY = 6 * 1024;
  const needCookieRetry = (swStatus === 403 || swStatus === 407 || swStatus === 404 || swStatus === 0)
    || (swOk && swSize > 0 && swSize < SUSPICIOUS_TINY)
    // ★2026-09-11：并集条件③ —— SW 返回 200 但内容是「统一占位图」（CDN 软失败特征），
    //   同样值得用源页会话 Cookie 再试一次（可能拿回真实封面）。
    || swPlaceholder;
  if (needCookieRetry) {
    try {
      const tabId = (typeof window.__hmdao_sourceTabId === 'number') ? window.__hmdao_sourceTabId : null;
      // ★2026-09-08：源页内 fetch 受【当前页面 CSP connect-src】约束，绝不能拿当前源页去取
      //   别的站的资产。实测在即梦页残留了 runninghub 的卡片，用即梦页面去 fetch
      //   runninghub.cn 的图 → "Refused to connect ... violates CSP connect-src"（即梦白名单无该域）。
      //   故：仅当【同注册域】或【页面与图床属同一平台族（字节系站点 ↔ 字节系 CDN）】时才走源页通道；
      //   跨站资产直接放弃第二层（保持 SW 结果或空），既避开 CSP 报错也不污染源页。
      const regOf = (h) => { const p = String(h || '').split('.'); return p.slice(-2).join('.'); };
      const hostOf = (u) => { try { return new URL(String(u || '')).hostname; } catch (_) { return ''; } };
      const pageHost = hostOf(window.__sourcePageUrl || '');
      const assetHost = hostOf(url);
      const BYTE_SITES = /(jianying\.com|jimeng\.com|douyin\.com|iesdouyin\.com|doubao\.com|capcut\.com|capcut\.cn|ixigua\.com|toutiao\.com|snssdk\.com|bytedance\.com|vlabstatic\.com)/i;
      const BYTE_CDN = /(byteimg\.com|bytetos\.com|vlabstatic\.com|byteacctimg\.com|bytefcdn\.com|douyinvod\.com|douyinpic\.com|douyinstatic\.com|pstatp\.com|byteoversea\.com|bytecdn\.com|bytednsdoc\.com|ixigua\.com)/i;
      // ★2026-09-11 补充平台族登记表：除「同注册域 / 字节系」外，成对登记的平台族也放行
      //   （如 imini.ai 源页 ↔ iminicdn.com 图床）。严禁通配，新增必须成对登记。
      let pairHit = false;
      for (let pi = 0; pi < PAGE_FETCH_PAIRS.length; pi++) {
        if (PAGE_FETCH_PAIRS[pi][0].test(pageHost) && PAGE_FETCH_PAIRS[pi][1].test(assetHost)) { pairHit = true; break; }
      }
      const breakerKey = String(tabId) + '|' + assetHost;
      let breakerOpen = false;
      try {
        const until = PAGE_FETCH_BREAKER.get(breakerKey);
        if (until && Date.now() < until) breakerOpen = true;
      } catch (_) {}
      const trustedForPageFetch = !breakerOpen && !!pageHost && !!assetHost
        && (regOf(pageHost) === regOf(assetHost) || (BYTE_SITES.test(pageHost) && BYTE_CDN.test(assetHost)) || pairHit);
      if (tabId != null && trustedForPageFetch) {
        // 失败即熔断：本轮（5 分钟）内不再用该 tab 的源页去取该图床，避免反复触发 CSP 报错。
        const openBreaker = () => {
          try { PAGE_FETCH_BREAKER.set(breakerKey, Date.now() + PAGE_FETCH_BREAKER_MS); } catch (_) {}
        };
        let t = null;
        try {
          t = await chrome.runtime.sendMessage({ type: 'HMDAO_FETCH_MEDIA_IN_TAB', tabId, url, referer: finalReferer, usePageCookie: true });
        } catch (_) { t = null; openBreaker(); }
        if (t && t.ok && t.b64) {
          const tSize = Math.floor((t.b64.length * 3) / 4);
          // ★2026-09-11：源页结果比 SW 大才替换（避免用较小的图覆盖正常封面）；
          //   但 SW 那次若已被判为占位图，则【无条件】采用源页结果（旧的已知是坏的）。
          const takeNew = !swOk || swSize === 0 || swPlaceholder || tSize > swSize;
          if (!takeNew) return null;
          const bytes = b64ToBytes(t.b64);
          if (bytes && bytes.length) {
            // ★2026-09-01：第二层（源页带 Cookie 回退）同样按字节校验，防漏网
            const kind2 = sniffBytesKind(bytes);
            if (kind2 === 'video' || kind2 === 'audio') {
              console.warn('[HMDAO][relay] 第二层丢弃非图片字节（kind=%s）: %s', kind2, String(url).slice(0, 100));
              return null;
            }
            // ★2026-09-11：占位图识别（同上，写缓存前拦截）
            if (hmdaoNoteCoverBytes(url, bytes)) return null;
            // ★2026-09-11（QA K-1）：能走到这里说明源页那次返回的【不是】占位图 —— 该 URL 被证明
            //   有真封面，撤销判死，让这张真封面能被缓存与复用（否则只闪一次就永远取不回来）。
            hmdaoMarkCoverRescued(url);
            const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/*' }));
            __thumbCache.set(url, blobUrl);
            return blobUrl;
          }
          openBreaker();
        } else {
          openBreaker();
        }
      }
    } catch (_) {}
  }
  return null;
}
