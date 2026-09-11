// ===== 扩展公共服务规则层（由 background.js 经 importScripts 引入）=====
// 集中管理：Referer 注入规则、音频 CORS 放行规则、域名工具、捕获扩展名白名单。
// 这些函数均为纯工具或只依赖 chrome.declarativeNetRequest / chrome.cookies，
// 不依赖 background.js 后续定义的业务函数（如 scheduleRescan / captureNetworkAsset），
// 故可安全地被 importScripts 在其他逻辑之前加载，供 background 全局调用。
// 沿用 mv3-state.js 的惯例：以全局函数/常量形式挂载到 SW 全局作用域。

// ===== B站 CDN Referer 注入规则（按需、临时、不覆盖页面原生请求）=====
// 背景：浏览器 fetch / chrome.downloads 无法自行设置 Referer（禁止头），B站 m4s/durl CDN 无 Referer 必 403。
// 但【致命坑】：若扩展启动即常驻对所有 bilivideo.com 请求强制 set Referer + 注入 Origin，
// 会覆盖 B站页面原生（带 video 路径、无 Origin 的）合法请求头，导致 B站 CDN 防盗链校验失败 → 403 → 视频加载不了。
// 修复原则：
//   1) 不再「扩展启动即永久安装」——改为【按需】安装，仅当本扩展后台确实要重发 B站视频字节时才临时启用；
//   2) 规则只匹配 resourceTypes: ['other']（后台 fetch 在 dNR 中常被归类为 other），【不匹配 'media'】，
//      从而完全不触碰页面 <video> 标签发出的原生媒体流请求（其 resourceType 正是 'media'）；
//   3) 安装后 600s 自动清理（与原有逻辑一致），避免常驻。
// 这样：页面正常播 B站视频（原生 media 请求，规则不作用）→ 不受影响；
//      后台下载/预览（other 类型 fetch）→ 带 Referer 通过防盗链。
// ===== 优酷 CDN Referer 注入规则（按需、临时、hls.js 用）=====
// 背景：优酷 yt-dlp 返回的直链是 `/playlist/m3u8?...`，浏览器侧栏用 hls.js 拉取时
//       必须带 Referer=https://v.youku.com/ 否则 pl-ali.youku.com / vali-ugc 立即 403。
//       dNR 在请求头注入 Referer 是唯一手段（fetch API 禁止设 Referer）。
// 修复原则（同 B站规则）：
//   1) 按需安装（仅用户点预览时），不常驻；
//   2) 仅匹配 ['xmlhttprequest','other']，【不匹配 'media'】——避免覆盖 hls.js 的 .ts 分片时
//      和播放器计算出的 Referer 冲突。
//   3) 600s 自动清理。
const YOUKU_REFERER = 'https://v.youku.com/';
const YOUKU_ORIGIN = 'https://v.youku.com';
const YOUKU_CDN_DOMAINS = ['pl-ali.youku.com', 'pl.youku.com', 'vali-ugc.cp31.ott.cibntv.net', 'valipl.youku.com'];
async function installYoukuRefererRules() {
  try {
    for (const d of YOUKU_CDN_DOMAINS) {
      await installRefererRuleForDomain(d, YOUKU_REFERER, YOUKU_ORIGIN, ['xmlhttprequest', 'other']);
    }
  } catch (_) { /* 老浏览器无该 API 时忽略 */ }
}

const BILI_REFERER = 'https://www.bilibili.com/';
const BILI_ORIGIN = 'https://www.bilibili.com';
const BILI_CDN_DOMAINS = ['bilivideo.com', 'bilivideo.cn', 'hdslb.com', 'mirrorakam.akamaized.net'];
// 仅匹配后台 fetch 的 'other' 类型，绝不匹配页面 <video> 的 'media'，避免破坏 B站原生播放。
const BILI_REFERER_RESOURCE_TYPES = ['other'];
async function installBiliRefererRules() {
  try {
    for (const d of BILI_CDN_DOMAINS) {
      await installRefererRuleForDomain(d, BILI_REFERER, BILI_ORIGIN, BILI_REFERER_RESOURCE_TYPES);
    }
  } catch (_) { /* 老浏览器无该 API 时忽略 */ }
}
// ★关键：不再「扩展加载即执行」（那会常驻覆盖所有 B站请求）。
// B站 Referer 规则彻底改为【按需】安装：仅在 background.js 真正需要后台重发 B站视频字节
// （预览/下载路径）时才调用 installBiliRefererRules()，且 600s 后自动清理。
// 因此此处【不】挂任何自动安装钩子，确保扩展启动后页面原生 B站视频播放完全不受影响。
// （如确需浏览器重启后恢复，可在此显式调用，但默认保持关闭以杜绝 403 干扰。）

// ===== 通用 Referer 规则管理器：为任意 CDN 域名动态注入 Referer 头 =====
// chrome.downloads.download 和 fetch 都无法在请求头设置 Referer（禁止头），
// 但很多防盗链 CDN 依赖 Referer 鉴权。通过 declarativeNetRequest 在网络层注入。
// 规则 ID 范围：9000-9999（预留 1000 个规则槽，所有 Referer 规则统一在此段内分配，
// 不再另设 8801-8804 段，避免 ID 段并存导致的潜在冲突与重复状态）
let _refRuleNextId = 9000;
const _refRuleMap = new Map(); // domain -> { id, domain, referer }
async function installRefererRuleForDomain(domain, referer, origin, resourceTypes) {
  try {
    if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateSessionRules) return 0;
    // 如果已有同域规则，先删除旧
    const existing = [..._refRuleMap.entries()].find(([, v]) => v.domain === domain);
    if (existing) removeRefererRule(existing[0]);

    const id = _refRuleNextId++;
    if (_refRuleNextId > 9999) _refRuleNextId = 9000; // 循环复用（实际不会超）
    _refRuleMap.set(id, { domain, referer, origin, installedAt: Date.now() });

    // 必须 await：旧实现 fire-and-forget 导致与 chrome.downloads.download 存在竞态，
    // 下载请求可能在 dNR 规则生效前发出 → CDN 仍 403/HTML → 静默失败。
    const requestHeaders = [{ header: 'referer', operation: 'set', value: referer }];
    // 部分 CDN（如 B站）同时校验 origin，允许调用方一并注入
    if (origin) requestHeaders.push({ header: 'origin', operation: 'set', value: origin });

    // ★零干扰原则（2026-08-02 修正）：默认【不匹配 'media'】。
    // 页面 <video>/<audio> 原生流请求的资源类型正是 'media'；若 dNR 给 media 类型
    // 强行 set Referer/Origin，会覆盖抖音/B站/YouTube 播放器自身精确计算的防盗链签名
    // （a_bogus/x-bogus 等绑定原始请求头），导致 CDN 返回错误流 → 视频无法播放且无声。
    // 扩展后台 fetch 拉媒体字节在 dNR 中归类为 'other'/'xmlhttprequest'，只在这两类上
    // 注入 Referer 即可（与 B站 ['other'] 熔断逻辑一致）。'image' 可保留（不影响媒体流）。
    const finalResourceTypes = resourceTypes || ['xmlhttprequest', 'other', 'image'];

    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [{
        id,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders,
        },
        condition: {
          urlFilter: `||${domain}`,
          resourceTypes: finalResourceTypes,
        },
      }],
    }).catch(() => {});

    // 600秒后自动清理（签名URL过期后无需保留）
    setTimeout(() => removeRefererRule(id), 600_000);
    return id;
  } catch (_) { return 0; }
}
function removeRefererRule(id) {
  if (!_refRuleMap.has(id)) return;
  _refRuleMap.delete(id);
  try {
    chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
  } catch (_) {}
}

// ★2026-08-18 新增：少数 CDN（目前仅新片场 oss-xpc6.xpccdn.com）走 dNR 默认规则时缺 Referer：
//   默认 installRefererRuleForDomain 排除 'media'（防覆盖页面 <video> 防盗链签名）。
//   但 oss-xpc6 xpccdn 只校验 Referer 防盗链、不签名 URL，且页面原生 <video> 用同源 HLS 拉流
//   （不带 CDN 资源类型），扩展 chrome.downloads 走 'media' 才会 403。
//   此处用独立规则 ID 段（9900+）仅对 xpccdn.com / oss-xpc 等域加 'media' Referer 注入。
const _refRuleMediaNextId = 9900;
const _refRuleMediaMap = new Map(); // id -> { domain, referer }
async function installMediaRefererRuleForDomain(domain, referer) {
  try {
    if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateSessionRules) return 0;
    if (!/^xpccdn\.com$|^oss-xpc/i.test(domain) && !/oss-xpc6\.xpccdn\.com|xpccdn/i.test(domain)) {
      // 守门：仅允许新片场相关域，避免误伤
      return 0;
    }
    // 同域已存在 → 更新
    for (const [id, v] of _refRuleMediaMap.entries()) {
      if (v.domain === domain) { removeMediaRefererRule(id); break; }
    }
    const id = _refRuleMediaNextId++;
    _refRuleMediaMap.set(id, { domain, referer, installedAt: Date.now() });
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [{
        id,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'referer', operation: 'set', value: referer }] },
        condition: {
          urlFilter: `||${domain}`,
          resourceTypes: ['xmlhttprequest', 'other', 'image', 'media'],
        },
      }],
    }).catch(() => {});
    setTimeout(() => removeMediaRefererRule(id), 600_000);
    return id;
  } catch (_) { return 0; }
}
function removeMediaRefererRule(id) {
  if (!_refRuleMediaMap.has(id)) return;
  _refRuleMediaMap.delete(id);
  try { chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }).catch(() => {}); } catch (_) {}
}

// 网络层媒体捕获（对应「F12 → Network → Media」方案）：
// 站点用 MSE / 限时签名 / 懒加载时，<audio>.src 为空，DOM 扫描抓不到真实地址；
// 但真实音频字节一定经过网络请求，这里在响应阶段把直链捕获下来，供侧栏试听/下载。
// 同时用响应 Content-Type(audio/*, video/*) 兜底补捕「无扩展名」的 MSE / 签名 URL。
// 3D 模型 / 归档 扩展名（覆盖主流 DCC 与压缩格式）
const MODEL_EXT_RE = /\.(glb|gltf|obj|fbx|stl|usdz|max|blend|ma|mb|c4d|dae|ply|3ds|skp|wrl|x3d|abc|lwo|smd|vrm|ase|dxf|bvh)(\?|$)/i;
const ARCHIVE_EXT_RE = /\.(zip|rar|7z|tar\.gz|tgz|tar\.bz2|gz|bz2|tar|iso|cab|jar|z|lzh|ace|arj)(\?|$)/i;

function dispositionsFilename(headers) {
  if (!headers) return '';
  const cd = (headers.find((h) => h.name.toLowerCase() === 'content-disposition') || {}).value || '';
  if (!cd) return '';
  const m = cd.match(/filename\*?=(?:UTF-8''\s*)?\s*([^\s;]+)/i);
  if (!m) return '';
  return m[1].trim().replace(/^['\x22]+|['\x22]+$/g, '');
}

// 从主机名取「注册域」（e.g. s5.aigei.com → aigei.com），用于跨子域匹配源页标签。
function registeredDomain(host) {
  if (!host) return '';
  const h = host.toLowerCase().replace(/^www\./, '');
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  return parts.slice(-2).join('.');
}

// 按音频 URL 推导防盗链 Referer（如 s5.aigei.com → https://www.aigei.com/）。
function deriveRefererForUrl(url) {
  try {
    const host = new URL(url).hostname;
    const domain = registeredDomain(host);
    if (domain) return 'https://www.' + domain + '/';
  } catch (_) {}
  return '';
}

// ===== 音频抓取通用「Referer + 响应 CORS」放行规则 =====
// 真实爱给等 CDN 的防盗链会在【第三方域名】上校验 Referer 与登录态：
//   · 缺 Referer / 无登录 Cookie → 伪 200 返回 HTML（got-html-not-audio）。
//   · 浏览器 <audio> 能播是因为它自动带「页面 Referer + 同站 Cookie」；
//     而扩展 fetch 跨源既无 Cookie、Referer 又是禁设头、且响应无 ACAO 导致读不到 body。
// 用 declarativeNetRequest 在网络层同时：
//   · requestHeaders.set referer —— 绕过防盗链（缺失即 HTML/403）。
//   · requestHeaders.set cookie（可选，YouTube 用）—— 显式注入 youtube 会话 Cookie，
//     使 googlevideo 直链鉴权通过，且【不】触发「Third-party cookie will be blocked」告警
//     （告警来自浏览器自动附加第三方 Cookie 的机制；我们显式注入即不再依赖它）。
//   · responseHeaders.set ACAO/ACAC —— 让跨源 fetch 能 READ 字节（否则 CORS 拦）。
// 注意：对【第三方域名】改写请求/响应头必须声明 declarativeNetRequestWithHostAccess 权限，
//       否则 Chrome 会静默忽略规则（这正是此前本地能过、真实 aigei 却 got-html 的根因）。
// 匹配 ||<注册域> 而非精确 host：覆盖 302 跳转到同注册域其它子域的情况。
const HMDAO_DNR_AUDIO_RULE_ID = 987654;
async function installAudioCorsRule(domain, referer, acao, cookie, setAcac = true) {
  try {
    if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateSessionRules) return false;
    const requestHeaders = [];
    if (referer) requestHeaders.push({ header: 'referer', operation: 'set', value: referer });
    // cookie 头在 declarativeNetRequest 的标头白名单内，可直接 set（见官方文档）。
    if (cookie) requestHeaders.push({ header: 'cookie', operation: 'set', value: cookie });
    // ★setAcac=false：模型回退路径用 ACAO='*' 且不带 ACAC（模型无需 Cookie，'*' 不会破坏页面自身跨域抓取）；
    //   音频/YouTube 等需要凭据的走 setAcac=true（ACAO 必须为精确 origin，不能用 '*'）。
    const responseHeaders = [
      { header: 'access-control-allow-origin', operation: 'set', value: acao },
    ];
    if (setAcac) responseHeaders.push({ header: 'access-control-allow-credentials', operation: 'set', value: 'true' });
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [HMDAO_DNR_AUDIO_RULE_ID],
      addRules: [{
        id: HMDAO_DNR_AUDIO_RULE_ID,
        priority: 100,
        action: { type: 'modifyHeaders', requestHeaders, responseHeaders },
        // ★零干扰：不匹配 'media'（源页播放器原生媒体流类型），仅在后台 fetch 的
        //   xmlhttprequest/other 上注入 CORS 响应头；避免任何可能触碰页面播放器请求。
        // ★2026-09-08 关键修复（即梦页面被我们搞坏的根因）：
        //   本规则按「注册域」匹配【所有】xmlhttprequest/other —— 包括源页自己发出的请求！
        //   实测即梦页：我们为图片 relay 装了 ||byteimg.com 规则后，即梦页面自己的
        //   fetch(byteimg 图) 被改写 ACAO → 与其 credentials:'include' 撞车
        //   （"must not be the wildcard '*'"）→ 即梦页面自己的图全部 403。
        //   与 installScopedDoubaoCorsRule 同理，这里必须加 initiatorDomains=[扩展 id]，
        //   只作用于【扩展自身发起】的请求，源页请求（initiator=页面域）不再匹配。
        condition: {
          urlFilter: '||' + domain,
          resourceTypes: ['xmlhttprequest', 'other'],
          initiatorDomains: (function () { try { return [chrome.runtime.id]; } catch (_) { return undefined; } })(),
        },
      }],
    });
    return true;
  } catch (_) { return false; }
}

// 读取 youtube.com / googlevideo.com 的会话 Cookie（PREF / VISITOR_INFO1_LIVE 等，
// 标记 SameSite=None 的第三方 Cookie），拼接成 Cookie 请求头字符串。
// 这些 Cookie 是 googlevideo 直链鉴权所必需的；用 chrome.cookies 读出后由 dNR 显式注入，
// 避免依赖浏览器「自动附加第三方 Cookie」机制（该机制会触发弃用告警，且被禁时拉不到字节）。
async function getYoutubeCookieHeader() {
  try {
    if (!chrome.cookies) return '';
    const seen = new Set();
    let header = '';
    for (const d of ['youtube.com', 'googlevideo.com']) {
      const list = await chrome.cookies.getAll({ domain: d });
      for (const c of list) {
        if (seen.has(c.name)) continue;
        seen.add(c.name);
        header += c.name + '=' + c.value + '; ';
      }
    }
    return header.replace(/; $/, '');
  } catch (_) { return ''; }
}
async function removeAudioCorsRule() {
  try { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [HMDAO_DNR_AUDIO_RULE_ID] }); } catch (_) {}
}
function extOrigin() {
  try { return new URL(chrome.runtime.getURL('')).origin; } catch (_) { return '*'; }
}
