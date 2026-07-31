// ===== 音效试听 / 播放 =====
// 关键事实（决定为什么「在爱给网能播、面板不能」）：
//   · Chrome 自动播放策略只认【被播放页面自身文档内的用户手势】。
//     在爱给页面点播放键 → 手势在爱给文档内 → 放行。
//     扩展注入的 play() 手势来自侧栏 → 永远不算爱给文档的手势 → 被拦截。
//   · 侧栏自己的 <audio> 加载爱给 CDN 时，没有爱给登录 Cookie/Referer → 403。
// 因此可靠路径 = 以【源页身份】fetch 带登录态的字节（HMDAO_FETCH_IN_PAGE）→
//   回传侧栏用侧栏 <audio> 播放（手势来自侧栏点击/双击 → 有效）。两者兼备。
// 本文件依赖 sidepanel.js 顶部定义的全局符号：setStatus / warnStatus / pageReferer /
// deriveFilename / fileName / errStr / dbg / cacheDragBlob / downloadBlobUrl / typeDirs。
// 故在 sidepanel.js 之后加载（共享全局作用域，无 TDZ 风险）。
let hoverAudioInPage = false;

// ===== 自动播放解锁 =====
// 浏览器自动播放策略要求 play() 必须在「用户手势」内调用；而悬停(onmouseenter)不是手势，
// 会导致 au.play() 被以 NotAllowedError 拒绝。Chrome 的 sticky activation 规则：
// 一旦用户在【本面板文档】内发生过任意真实手势(pointerdown/click)，该文档即可被永久解锁，
// 此后 play()（含悬停触发的）都会被放行。
// 做法：首次 pointerdown 时用一段静音 wav「预热」音频元素，触发解锁；解锁后悬停试听即可正常播放。
let audioUnlocked = false;
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
function unlockAudioOnGesture() {
  if (audioUnlocked) return;
  try {
    const au = document.getElementById('previewAudio');
    if (!au) return;
    au.muted = true;
    au.src = SILENT_WAV;
    au.play().then(() => { try { au.pause(); } catch (_) {} au.muted = false; au.removeAttribute('src'); }).catch(() => {});
    audioUnlocked = true;
  } catch (_) {}
}
document.addEventListener('pointerdown', unlockAudioOnGesture);

// 以【源页身份】fetch 音频字节（带 Cookie + Referer），返回 { ok, b64, mime, size }。
// overrideUrl 用于「直链过期后回源页取到的新鲜直链」重试。
async function fetchAudioBytesInPage(a, overrideUrl) {
  const url = overrideUrl || a.url;
  const referer = pageReferer(a);
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'HMDAO_FETCH_IN_PAGE',
      url,
      referer,
    });
    console.log('[HMDAO][audio] fetch 字节结果 ' + dbg({ url, referer, res: res && { ok: res.ok, status: res.status, mime: res.mime, size: res.size, error: res.error } }));
    if (res && res.ok && res.b64) return res;
    return { ok: false, status: res && res.status, error: (res && (res.error || res.status)) || 'unknown', _res: res };
  } catch (e) {
    console.error('[HMDAO][audio] fetch 字节异常', e);
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// 回源页重新解析同一音频的「新鲜直链」（pathname 一致、签名已刷新）。
// 爱给等站音频是限时签名 URL：采集时的直链过期后源站返 HTML/403，
// 必须从仍打开的源页按 pathname 匹配出新鲜 URL 才能继续试听。
async function resolveFreshAudioUrl(a) {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'HMDAO_RESOLVE_FRESH_AUDIO', url: a.url });
    if (res && res.ok && res.freshUrl) return res.freshUrl;
  } catch (_) {}
  return '';
}

// 用侧栏自己的 <audio> 播放（gesture 有效，可绕过自动播放策略），
// src 来自「源页身份 fetch」得到的 blob —— 既带登录态、又避开了手势限制。
// 以【源页身份】fetch 音频字节（带 Cookie + Referer）→ 回传侧栏用侧栏 <audio> 播放（手势有效）。
// 作为「直链 src 播放」失败时的兜底（某些站点禁止跨域 media 加载但允许 fetch）。
// overrideUrl 用于「直链过期后回源页取到的新鲜直链」重试。
async function playAudioViaBlob(a, { visual = false, url: overrideUrl } = {}) {
  setStatus('正在以源页身份拉取音频…');
  const res = await fetchAudioBytesInPage(a, overrideUrl);
  if (!res.ok || !res.b64) {
    // 403 高概率是「签名 URL 已过期」（爱给等站的直链带 e=时间戳+token 签名，过期即 403）。
    const is403 = res.status === 403 || /403/.test(String(res.error || ''));
    setStatus(is403
      ? '⚠ 音频直链已过期（源站签名失效）。请刷新源页并重新播放一次该音频，让扩展重新采集新链接'
      : '⚠ 无法获取音频（' + (res.error || '未知') + '），请到源页试听', true);
    return false;
  }
  try {
    // 直接构造 Blob：atob 解码 base64 → Uint8Array → new Blob([bytes], {type})
    // 废弃 fetch('data:...;base64,...') 中间层 —— 该中间层在 Chrome 侧面板的
    // blob URL 解析路径中可能丢失 MIME 语义，导致 <audio>.play() 抛 NotSupportedError。
    let mime = res.mime || 'audio/mpeg';
    const binary = atob(res.b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    // 魔数校验：确认真的是音频字节，避免把 HTML/JSON 喂给 <audio> 报 NotSupportedError
    const head = String.fromCharCode.apply(null, Array.from(bytes.slice(0, 16)));
    const isAudioMagic = /^ID3/.test(head) || (bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0) // mp3
      || /^OggS/.test(head) || /^RIFF/.test(head) || /^fLaC/.test(head)
      || (bytes.length > 8 && String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]) === 'ftyp'); // m4a/aac
    if (/^\s*(<!doctype|<html|<head|\{)/i.test(head)) {
      console.error('[HMDAO][audio] 拉到的是网页/JSON 而非音频 ' + dbg({ head: head.slice(0, 40), mime, size: bytes.length }));
      setStatus('⚠ 源站返回的是网页而非音频（防盗链拦截），请到源页试听', true);
      return false;
    }
    // MIME 补正：非 audio/* 会让 <audio> 直接拒绝 blob
    if (!/^audio\//.test(mime)) {
      const ext = ((a.url || '').split('?')[0].match(/\.([a-z0-9]+)$/i) || [])[1] || '';
      const map = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/ogg', weba: 'audio/webm' };
      mime = map[ext.toLowerCase()] || (isAudioMagic ? 'audio/mpeg' : mime || 'audio/mpeg');
    }
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    cacheDragBlob(a, blob, mime); // 缓存真实字节 → 可拖到桌面/文件夹
    console.log('[HMDAO][audio] 构造 blob ' + dbg({ mime, blobType: blob.type, blobSize: blob.size, isAudioMagic, head: head.slice(0, 8) }));
    const au = document.getElementById('previewAudio');
    if (!au) return false;
    if (visual) au.style.display = '';
    au.pause();
    au.src = url;
    au.load();
    try {
      await au.play();
      hoverAudioInPage = true;
      setStatus('🎵 正在播放：' + fileName(a.url));
      return true;
    } catch (e) {
      const isNotAllowed = (e && (e.name === 'NotAllowedError' || /notallowed|user didn't interact|gesture/i.test(e.message || '')));
      console.error('[HMDAO][audio] au.play() 失败(带手势尝试) ' + dbg({ name: e && e.name, msg: e && e.message, blobType: blob.type, blobSize: blob.size }));
      // 兜底：浏览器允许【静音】自动播放（无需用户手势）。先静音起播，再尝试取消静音。
      // 悬停试听等无手势场景也能借此出声；取消静音若被策略拦截则维持静音播放（仍可听）。
      try {
        au.muted = true;
        await au.play();
        try { au.muted = false; } catch (_) {}
        hoverAudioInPage = true;
        setStatus('🎵 正在播放：' + fileName(a.url));
        return true;
      } catch (e2) {
        au.muted = false;
        console.error('[HMDAO][audio] 静音兜底播放也失败 ' + dbg({ name: e2 && e2.name, msg: e2 && e2.message }));
        a.__lastErr = isNotAllowed ? '浏览器自动播放策略拒绝（缺少用户手势）' : ('au.play 失败：' + errStr(e));
        setStatus(isNotAllowed
          ? '⚠ 浏览器拦截了自动播放（无手势）。先点一下卡片/本面板任意位置即可解锁试听'
          : '⚠ 播放被拦截：' + errStr(e) + '，请先点一下源页或本卡片', true);
        return false;
      }
    }
  } catch (e) {
    console.error('[HMDAO][audio] blob 构造异常', e);
    setStatus('⚠ 播放失败：' + errStr(e), true);
    return false;
  }
}

// 以【源页身份】下载音频：先 fetch 带登录态字节，再用 blob 触发侧栏下载。
// 比 chrome.downloads.download 可靠——后者对 CDN 域名不带源站 Cookie，爱给等站会 403。
async function downloadWithPageFetch(a) {
  setStatus('正在以源页身份拉取音频…');
  let res = await fetchAudioBytesInPage(a);
  // 直链签名过期（got-html/403）→ 回源页按 pathname 取新鲜直链重试（同预览逻辑）
  if (!res.ok || !res.b64) {
    const isDead = /got-html-not-audio/.test(String(res.error || '')) || String(res.status) === '403' || /403/.test(String(res.error || ''));
    if (isDead) {
      const fresh = await resolveFreshAudioUrl(a);
      if (fresh && fresh !== a.url) {
        setStatus('⏳ 直链已过期，回源页重新解析新鲜链接…');
        res = await fetchAudioBytesInPage(a, fresh);
        if (res.ok && res.b64) a.url = fresh;
      }
    }
  }
  if (!res.ok || !res.b64) {
    setStatus('⚠ 源页拉取失败（' + errStr(res.error) + '），改用浏览器下载', true);
    return false;
  }
  try {
    const mime = res.mime || 'application/octet-stream';
    const binary = atob(res.b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    downloadBlobUrl(url, 'Ddayup/audio/' + deriveFilename(a));
    setStatus('✅ 已下载：' + fileName(a.url));
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    return true;
  } catch (e) {
    setStatus('⚠ 下载失败：' + errStr(e), true);
    return false;
  }
}

// 用浏览器下载管理器下载真实直链：自动带源站 Cookie + dNR 注入 Referer，绕过防盗链。
// 失败兜底：源页身份 fetch 字节 → blob 下载。
async function downloadViaBrowser(a) {
  const referer = pageReferer(a);
  try {
    if (referer) {
      const host = new URL(a.url).hostname;
      await chrome.runtime.sendMessage({ type: 'HMDAO_INSTALL_REFERER_RULE', domain: host, referer });
    }
  } catch (_) {}
  setStatus('正在下载：' + fileName(a.url));
  chrome.downloads.download({
    url: a.url,
    filename: 'Ddayup/' + (typeDirs[a.type] || 'other') + '/' + deriveFilename(a),
    saveAs: false,
    conflictAction: 'uniquify',
  }).then(() => setStatus('✅ 已下载：' + fileName(a.url)))
    .catch(async (e) => {
      setStatus('⚠ 直链下载失败，尝试源页身份拉取…', true);
      const ok = await downloadWithPageFetch(a);
      if (!ok) setStatus('下载失败：' + errStr(e), true);
    });
}

// 兜底：直接播放【源页自身的 <audio> 元素】（按索引）。
// 仅在「无真实直链」时（如未捕获到网络请求、纯 MSE 播放器）使用：
// 此时 a.url 为空，必须 play 页面自己那个已缓冲好真实音频的元素。
async function playAudioFromPage(a) {
  if (a.audioIdx == null) return false;
  setStatus('正在源页播放该音频…');
  const res = await chrome.runtime.sendMessage({
    type: 'HMDAO_PLAY_PAGE_AUDIO',
    audioIdx: a.audioIdx,
    url: a.url || '',
  });
  if (res && res.ok) {
    hoverAudioInPage = true;
    window.__playingPageIdx = a.audioIdx;
    setStatus('🎵 正在源页播放：' + (fileName(a.url) || ('音频#' + a.audioIdx)));
    return true;
  }
  setStatus('⚠ 源页播放失败（' + errStr(res && res.error) + '），尝试拉取字节', true);
  return false;
}

// 用「真实音频直链」直接喂给侧栏 <audio> 播放。媒体元素加载跨域资源不受 CORS 限制
// （仅 Web Audio API 分析才需要 CORS），所以只要能带上正确 Referer 绕过防盗链即可播放。
// 这等价于「F12 复制直链 → 新标签打开 → 浏览器原生播放」，是爱给/freesound 等站最稳的路径。
async function playAudioWithRealUrl(a) {
  const referer = pageReferer(a);
  try {
    const host = new URL(a.url).hostname;
    // 始终安装 Referer 规则（referer 现在对已知站点一定非空）；失败也继续尝试直接播放
    await chrome.runtime.sendMessage({ type: 'HMDAO_INSTALL_REFERER_RULE', domain: host, referer });
  } catch (_) {}
  const au = document.getElementById('previewAudio');
  if (!au) return false;
  au.style.display = '';
  // 监听一次加载错误：CDN 403 / 防盗链 / 签名过期。记录清晰错误并用 errStr 避免 [object Object]。
  let loadFailed = false;
  let mediaErrText = '';
  const onErr = () => {
    loadFailed = true;
    const me = au.error;
    // MediaError.code: 1=ABORTED 2=NETWORK 3=DECODE 4=SRC_NOT_SUPPORTED
    const codeMap = { 1: '已中止', 2: '网络错误', 3: '解码错误', 4: '格式/源不受支持' };
    mediaErrText = me ? ('媒体错误 code=' + me.code + '(' + (codeMap[me.code] || '未知') + ') ' + (me.message || '')) : '媒体加载错误';
    a.__lastErr = '直链 <audio> 加载失败：' + mediaErrText;
    console.warn('[HMDAO][audio] 直链加载失败 ' + dbg({ url: a.url, referer, code: me && me.code, message: me && me.message }));
  };
  au.addEventListener('error', onErr, { once: true });
  au.pause();
  au.src = a.url;
  au.load();
  try {
    await au.play();
    // play() 可能在资源真正加载前就 resolve（竞态），短暂停顿后确认媒体确实在加载，
    // 否则把加载失败当作异常抛出，走下面的回源重试逻辑。
    await new Promise((r) => setTimeout(r, 300));
    if (loadFailed || au.error || au.readyState === 0) {
      throw new Error(a.__lastErr || '媒体加载错误');
    }
    hoverAudioInPage = true;
    console.log('[HMDAO][audio] 直链播放成功 ' + dbg({ url: a.url, referer }));
    setStatus('🎵 正在播放：' + fileName(a.url));
    return true;
  } catch (e) {
    const reason = loadFailed ? mediaErrText : errStr(e);
    console.warn('[HMDAO][audio] 直链播放被拒 ' + dbg({ url: a.url, referer, reason }));
    // 回源页取新鲜直链（签名过期场景）后用最稳的「源页 fetch→blob」路径重试一次
    const fresh = await resolveFreshAudioUrl(a);
    if (fresh && fresh !== a.url) {
      a.url = fresh;
      setStatus('⏳ 直链已过期/被拦截，用新鲜链接重试…');
      if (await playAudioViaBlob(a, { visual: true, url: fresh })) return;
    }
    setStatus('⚠ 直链播放失败（' + reason + '），尝试以源页身份拉取', true);
    return false;
  }
}

async function playAudioInPage(a, { visual = false, useHover = false } = {}) {
  console.log('[HMDAO][audio] playAudioInPage 开始 ' + dbg({
    url: a.url, type: a.type, audioIdx: a.audioIdx, source: a.source,
    hasHttpUrl: !!(a.url && a.url.startsWith('http')),
    referer: pageReferer(a),
    sourcePageUrl: window.__sourcePageUrl || '(空)',
  }));
  // 主路径（最稳）：在【源页 MAIN world】以 fetch + referrerPolicy 自动带 Referer 拉字节 → blob 播放。
  // 爱给 CDN 强制校验 Referer，且 dNR 无法可靠注入 referer（白名单不含 referer），
  // 只有「源页上下文里的 fetch 用 unsafe-url referrerPolicy」能让浏览器自动带上正确 Referer。
  if (a.url && a.url.startsWith('http')) {
    let fb = await playAudioViaBlob(a, { visual: true });
    console.log('[HMDAO][audio] 主路径 fetch/blob 播放结果', fb);
    // 直链签名过期（got-html-not-audio / 403）→ 回源页按 pathname 取新鲜直链重试。
    // 爱给等站所有音频在同一网页，源页仍打开即能重新解析出带新签名的同路径 URL。
    if (!fb) {
      a.__lastErr = '源页 fetch/blob 失败：' + errStr((fb && fb.error) || '无音频字节');
      const isDead = !fb || /got-html-not-audio/.test(String(fb.error || '')) || String(fb.status) === '403' || /403/.test(String(fb.error || ''));
      if (isDead) {
        setStatus('⏳ 直链已过期，正在回源页重新解析新鲜链接…');
        const fresh = await resolveFreshAudioUrl(a);
        if (fresh && fresh !== a.url) {
          console.log('[HMDAO][audio] 命中新鲜直链，重试 ' + dbg({ fresh: fresh.slice(0, 90) }));
          fb = await playAudioViaBlob(a, { visual: true, url: fresh });
          if (fb) { a.url = fresh; setStatus('🎵 已用新鲜直链播放：' + fileName(a.url)); } // 就地更新，后续直接可用
        }
      }
    }
    if (fb) {
      // ★用户试听成功即说明该音频 URL 真实可用（已带登录态 fetch 到字节）。
      // 此时 MAIN 世界的 audioPlays 已捕获该直链，触发一次扫描刷新，让新音频实时进列表可下载。
      chrome.runtime.sendMessage({ type: 'HMDAO_SCAN_REQUEST' }).catch(() => {});
      return;
    }
    // 悬停无手势：若主路径因自动播放策略(无手势)失败，重试直链/源页同样无手势也必败，
    // 且会刷出一串吓人报错。未解锁前直接静默返回，等用户点过一次(已 unlock)后悬停即可正常播。
    if (useHover && !audioUnlocked && /手势|自动播放/.test(String(a.__lastErr || ''))) {
      console.log('[HMDAO][audio] 悬停试听被自动播放策略拦截（无手势），静默跳过，待用户点击解锁');
      return false;
    }
    // 兜底：直链 <audio src> 直接播（部分站点 dNR referer 生效或无需 referer 时可用）
    if (await playAudioWithRealUrl(a)) return;
  }
  // 最后兜底：仅有 MSE <audio> 元素（空 URL）→ 直接驱动源页该元素播放
  if (a.audioIdx != null) {
    const pg = await playAudioFromPage(a);
    console.log('[HMDAO][audio] 源页元素播放结果', pg);
    if (pg) return;
    a.__lastErr = '源页 <audio> 元素播放失败';
  }
  console.error('[HMDAO][audio] 全部路径失败 ' + dbg({ url: a.url, audioIdx: a.audioIdx, lastErr: errStr(a.__lastErr) }));
  const isGesture = /手势|自动播放/.test(String(a.__lastErr || ''));
  setStatus(isGesture
    ? '⚠ 浏览器禁止自动播放：请先点一下本面板的卡片或「▶ 播放」按钮后再试听'
    : '⚠ 无法播放该音频，请到源页试听（' + errStr(a.__lastErr) + '）', true);
}

async function hoverPlayAudio(a) {
  hoverAudioInPage = false;
  await playAudioInPage(a, { visual: false, useHover: true });
}

function stopHoverAudio() {
  const overlayOpen = document.getElementById('previewOverlay').classList.contains('open');
  if (overlayOpen) return;
  if (hoverAudioInPage) {
    chrome.runtime.sendMessage({ type: 'HMDAO_STOP_AUDIO_IN_PAGE', audioId: 'hover' });
    hoverAudioInPage = false;
  }
  // 同时暂停源页自身正在播放的 <audio> 元素
  if (window.__playingPageIdx != null) {
    chrome.runtime.sendMessage({ type: 'HMDAO_STOP_PAGE_AUDIO', audioIdx: window.__playingPageIdx }).catch(() => {});
    window.__playingPageIdx = null;
  }
}
