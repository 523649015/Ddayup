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
// 播放会话令牌：每次进入 playAudioViaBlob 自增，用于区分「被后续暂停合法打断」
// 与「本次会话真正失败」，避免悬停快速进出时的 AbortError 误报为播放故障。
let playToken = 0;

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

// ★P2（2026-08-01）：悬停补全捕获后，把新鲜直链回写到主资产库，避免下次悬停再次回退触发。
function maybeUpdateAssetUrl(a, url) {
  try {
    const list = (typeof window !== 'undefined' && window.assets) || [];
    const key = (x) => x && (x.url || x.href || '');
    let target = null;
    if (a && a.name) target = list.find((x) => x && x.name === a.name && x.type === 'audio');
    if (!target && a) {
      const ap = (() => { try { return new URL(key(a)).pathname; } catch (_) { return ''; } })();
      if (ap) target = list.find((x) => x && (() => { try { return new URL(key(x)).pathname; } catch (_) { return ''; } })() === ap);
    }
    if (!target && a) target = a;
    if (target && url) { target.url = url; target.fresh = true; }
  } catch (_) {}
}

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
    // ★抖音等需会话 Cookie 的防盗链流（sf*-cdn-tos.douyinstatic.com / ies-music/*.mp3）：
    // SW fetch(include 仍被 Privacy Sandbox 拦截) 与 ISOLATED world fetch 都拿不到，
    // 必须改用【源页 MAIN 世界 credentials:include】拉（继承 ttwid/SESSDATA）。
    // 复用 HMDAO_FETCH_MEDIA_IN_TAB + fetchMediaInTabWithCookie（与视频预览同源兜底）。
    const isDouyin = /douyin|bytedance|tiktok|douyinvod|iesdouyin/i.test(url || '');
    if (isDouyin) {
      const tabId = (typeof window.__hmdao_sourceTabId === 'number') ? window.__hmdao_sourceTabId : null;
      if (tabId != null) {
        console.log('[HMDAO][audio] 抖音音频回落 MAIN 世界带 Cookie 拉取 ' + dbg({ url, tabId }));
        const t = await chrome.runtime.sendMessage({
          type: 'HMDAO_FETCH_MEDIA_IN_TAB', tabId, url, referer: referer || '', usePageCookie: true,
        });
        if (t && t.ok && t.b64) return { ok: true, mime: t.mime || 'audio/mpeg', b64: t.b64, size: t.size };
        console.warn('[HMDAO][audio] MAIN 世界拉取也失败 ' + dbg({ url, err: t && (t.error || t.status) }));
      }
    }
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
      // ★mp4：豆包技能音乐是 .mp4 容器装 AAC 音频（由 <audio> 播放），必须映射成 audio/mp4，
      //   否则 blob MIME 是 video/mp4 / audio/mpeg → <audio> 解码失败（NotSupportedError）。
      const map = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/ogg', weba: 'audio/webm', mp4: 'audio/mp4' };
      mime = map[ext.toLowerCase()] || (isAudioMagic ? 'audio/mpeg' : mime || 'audio/mpeg');
    }
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    cacheDragBlob(a, blob, mime); // 缓存真实字节 → 可拖到桌面/文件夹
    console.log('[HMDAO][audio] 构造 blob ' + dbg({ mime, blobType: blob.type, blobSize: blob.size, isAudioMagic, head: head.slice(0, 8) }));
    const au = document.getElementById('previewAudio');
    if (!au) return false;
    if (visual) au.style.display = '';
    // ★播放会话令牌：悬停快速进出/切换时，上一个 play() 仍是挂起的异步 Promise，
    // 新会话会先 pause() 再 play()，从而打断前一个 play() → 抛 AbortError。
    // 用令牌区分「被合法打断」（忽略）与「本次会话真正失败」（报错），避免误报。
    const myToken = ++playToken;
    au.pause();
    au.src = url;
    au.load();
    try {
      await au.play();
      if (myToken !== playToken) return true; // 已被新会话合法接管/中断，静默退出
      hoverAudioInPage = true;
      setStatus('🎵 正在播放：' + fileName(a.url));
      return true;
    } catch (e) {
      // AbortError = 「play() 被随后的 pause() 打断」，属正常竞态，非故障，忽略。
      if (e && e.name === 'AbortError') {
        console.log('[HMDAO][audio] play() 被后续暂停合法打断(AbortError)，忽略');
        return true;
      }
      const isNotAllowed = (e && (e.name === 'NotAllowedError' || /notallowed|user didn't interact|gesture/i.test(e.message || '')));
      console.error('[HMDAO][audio] au.play() 失败(带手势尝试) ' + dbg({ name: e && e.name, msg: e && e.message, blobType: blob.type, blobSize: blob.size }));
      // 兜底：浏览器允许【静音】自动播放（无需用户手势）。先静音起播，再尝试取消静音。
      // 悬停试听等无手势场景也能借此出声；取消静音若被策略拦截则维持静音播放（仍可听）。
      try {
        au.muted = true;
        await au.play();
        if (myToken !== playToken) { try { au.muted = false; } catch (_) {} return true; } // 被接管
        try { au.muted = false; } catch (_) {}
        hoverAudioInPage = true;
        setStatus('🎵 正在播放：' + fileName(a.url));
        return true;
      } catch (e2) {
        if (e2 && e2.name === 'AbortError') {
          console.log('[HMDAO][audio] 静音兜底 play() 被合法打断(AbortError)，忽略');
          return true;
        }
        au.muted = false;
        console.error('[HMDAO][audio] 静音兜底播放也失败 ' + dbg({ name: e2 && e2.name, msg: e2 && e.message }));
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
  dlViaChrome({
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
    // ★2026-08-31 修复（open.maic.chat 等代理站点）：proxy-media 返回非音频 → code=4 格式不受支持。
    //   此时重试（resolveFreshAudioUrl / playAudioViaBlob）必然再次失败且刷屏。标记 __fmtUnsupported，
    //   明确提示"在源页播放"，catch 分支据此跳过重试。
    if (me && me.code === 4) {
      a.__fmtUnsupported = true;
      setStatus('⚠ 该音频直链格式无法在侧栏播放（站点代理可能返回非音频），请在源页播放', true);
    }
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
    // ★2026-08-31：格式不受支持（code=4，如站点代理返回非音频）→ 不进回源重试（必败且刷屏），直接返回。
    //   兼容 AbortError 先于 error 事件触发的乱序：直接判 au.error.code 兜底。
    if (a.__fmtUnsupported || (au.error && au.error.code === 4)) {
      console.warn('[HMDAO][audio] 直链格式不受支持，已提示在源页播放，跳过重试');
      return false;
    }
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

// ★豆包朗读（WS 流式 ogg_opus）试听：资产无 HTTP 直链（伪 URL doubao-ws-audio://ts），
//   先从源页取回 doubao-audio-capture.js 旁路收集到的原始字节，再走与爱给相同的 blob 播放路径。
// 在【源页内】播放豆包朗读（字节不出页面）：不受回传大小限制，悬停与点击都能用。
// silent=true 时失败完全静默（悬停场景不刷红字，违反不报错边界的提示一律不打）。
async function playDoubaoWsAudioInPage(a, { silent = false } = {}) {
  let res = null;
  try {
    res = await chrome.runtime.sendMessage({ type: 'HMDAO_PLAY_DOUBAO_WS_AUDIO', ts: Number(a.wsTs) || 0 });
  } catch (_) { res = null; }
  if (!res || !res.ok) {
    if (silent) {
      try { console.log('[HMDAO][doubao] 悬停试听静默跳过：' + ((res && res.error) || 'unknown')); } catch (_) {}
    } else {
      setStatus('⚠ 未取到朗读音频（请先在源页点一次「朗读」并播放完）', true);
    }
    return false;
  }
  window.__hmdaoPlayingDoubaoWs = true;
  if (!silent) setStatus('🎵 正在播放：' + (a.title || '豆包朗读'));
  return true;
}

async function playDoubaoWsAudio(a, { visual = false, silent = false } = {}) {
  if (!silent) setStatus('正在从源页取回朗读音频…');
  let res = null;
  try {
    res = await chrome.runtime.sendMessage({ type: 'HMDAO_GET_DOUBAO_WS_AUDIO', ts: Number(a.wsTs) || 0 });
  } catch (_) { res = null; }
  // no-result 多为瞬时注入失败（SW 忙/页面正重渲染），重试一次即可，不给用户假失败
  if (!res || (!res.ok && res.error === 'no-result')) {
    await new Promise((r) => setTimeout(r, 400));
    try {
      res = await chrome.runtime.sendMessage({ type: 'HMDAO_GET_DOUBAO_WS_AUDIO', ts: Number(a.wsTs) || 0 });
    } catch (_) { res = null; }
  }
  if (!res || !res.ok || !res.b64) {
    // 回退：在源页内直接播放（字节不出页面，不受回传限制）
    return playDoubaoWsAudioInPage(a, { silent });
  }
  try {
    const bytes = b64ToBytes(res.b64);
    const mime = (res.mime && /^audio\//.test(res.mime)) ? res.mime : 'audio/ogg';
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    cacheDragBlob(a, blob, mime); // 缓存真实字节 → 可复制/拖到桌面
    const au = document.getElementById('previewAudio');
    if (!au) return false;
    if (visual) au.style.display = '';
    const myToken = ++playToken;
    au.pause();
    au.src = url;
    au.load();
    try {
      await au.play();
      if (myToken !== playToken) return true; // 被新会话合法接管
      hoverAudioInPage = true;
      setStatus('🎵 正在播放：' + (a.title || fileName(a.url)));
      return true;
    } catch (e) {
      if (e && e.name === 'AbortError') return true; // play() 被后续 pause() 合法打断
      setStatus('⚠ 播放失败：' + errStr(e), true);
      return false;
    }
  } catch (e) {
    setStatus('⚠ 播放失败：' + errStr(e), true);
    return false;
  }
}

// 播放侧栏内已存在的音频 blob（豆包朗读实体化后的 URL）。
// 复用侧栏 <audio id="previewAudio">：移开/关闭时 pause 它即可立即静音，不会有残留音。
async function playPanelBlobAudio(a, visual = false) {
  try {
    const au = document.getElementById('previewAudio');
    if (!au || !a || !a.url) return false;
    if (visual) au.style.display = '';
    const myToken = ++playToken;
    au.pause();
    au.src = a.url;
    au.load();
    try {
      await au.play();
    } catch (e) {
      if (e && e.name === 'AbortError') return true;
      try { console.log('[HMDAO][doubao] blob 播放失败 ' + ((e && e.name) || '')); } catch (_) {}
      return false;
    }
    if (myToken !== playToken) return true; // 已被新会话合法接管
    return true;
  } catch (_) { return false; }
}

async function playAudioInPage(a, { visual = false, useHover = false } = {}) {
  console.log('[HMDAO][audio] playAudioInPage 开始 ' + dbg({
    url: a.url, type: a.type, audioIdx: a.audioIdx, source: a.source,
    hasHttpUrl: !!(a.url && a.url.startsWith('http')),
    referer: pageReferer(a),
    sourcePageUrl: window.__sourcePageUrl || '(空)',
  }));
  // ★防御：仍未实体化的伪 URL（实体化失败的残留）→ 静默返回。
  //   不进后续任何播放路径，避免刷「全部路径失败」错误日志（用户明确要求不产生错误噪音）。
  if (a && /^doubao-ws-audio:/i.test(String(a.url || ''))) return false;
  // ★侧栏内已实体化的音频（豆包朗读 blob:）：直接用侧栏 <audio> 播放。
  //   鼠标移开/关卡片 → stopHoverAudio 直接 pause 这个元素 → 立即静音、零残留。
  if (a && a.type === 'audio' && /^blob:/i.test(String(a.url || ''))) return playPanelBlobAudio(a, visual);
  // ★豆包朗读（WS 流式 ogg_opus）：伪 URL 不可 fetch，走「取回字节 → blob 播放」专用路径
  if (a.wsAudio) return playDoubaoWsAudio(a, { visual });
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
    // ★爱给等「签名 CDN 音频」(s8.aigei.com / alicdn / OSS) 绝不走裸 <audio src> 兜底：
    // 这类直链带 e=时间戳+token 签名，且 CDN 校验【源站登录 Cookie + Referer】。
    // 侧栏裸 <audio> 加载既无登录 Cookie、Referer 也常被 CSP 拦，必 403 → 控制台刷一排红色
    // GET ... 403 噪声，且毫无播放希望。这里直接跳过该兜底，给出一次友好提示即可。
    // 注意：本改动只影响 Ddayup 侧栏自身的播放逻辑，绝不注入/改写任何页面或全局请求头，
    // 因此【不会影响浏览器功能或网页运行】。
    // 抖音/字节系（sf*-cdn-tos.douyinstatic.com / ies-music/*.mp3 等）是需会话 Cookie 的签名防盗链流，
    // 裸 <audio src> 直连既无登录态、又触发「Third-party cookie will be blocked」告警，必败。
    // 这类与 aigei/alicdn 同属「跳过裸直连」范围（已优先走 MAIN 世界带 Cookie 的源页拉取）。
    const isSignedCdn = /(^|\.)aigei\.com$|s8\.aigei\.com|alicdn\.com|aliyuncs\.com|aliyun\.com|oss-/.test(a.url || '');
    const isCookieCdn = /douyin|bytedance|tiktok|douyinvod|iesdouyin|sf[0-9]*-cdn-tos\.douyinstatic\.com/i.test(a.url || '');
    if (!isSignedCdn && !isCookieCdn && await playAudioWithRealUrl(a)) return;
    if (isSignedCdn || isCookieCdn) {
      a.__lastErr = isCookieCdn
        ? '抖音音频需登录态会话 Cookie，已尝试源页带 Cookie 拉取，若仍失败请确认源页已登录抖音'
        : '源站签名校验未通过（需登录/会员或直链已失效）';
      console.warn('[HMDAO][audio] 跳过裸 <audio> 直连（' + (isCookieCdn ? '抖音防盗链需会话 Cookie' : '签名 CDN 必 403') + '，避免控制台噪声）: ' + dbg({ url: (a.url || '').slice(0, 80) }));
      // ★2026-08-23 数据驱动修复：抖音原声(ies-music)连源页带 Cookie 拉取都失败（实测 lastErr 已确认），
      //   再走 playAudioFromPage / console.error 只会刷噪声且无意义。直接优雅降级：提示用户去源页试听，
      //   不打「全部路径失败」，也不阻塞视频播放（音视频独立）。
      setStatus('⚠ 该音频为抖音原声/签名音频，需源页登录态才能播放，请到源页试听', false);
      return;
    }
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
  // ★豆包朗读（WS 流式，无直链）：悬停走【源页内播放】（字节不出页面），
  //   失败一律静默 —— 既不刷红色提示，又保留悬停试听体验。
  if (a && a.wsAudio) return playDoubaoWsAudioInPage(a, { silent: true });
  // ★P2（2026-08-01）：爱给等「游离 Audio 播放器」音效站，若 a.url 为空（扫描时序未跑到
  // forceAudioPlayCapture / 签名 URL 未捕获），悬停时先在源页自动触发试听补全捕获，
  // 按 pathname 匹配回填 a.url，确保悬停一定有得播。
  if (!a.url && a.tabId) {
    try {
      const isAigei = /(^|\.)aigei\.com$/i.test(new URL(a.pageUrl || '').hostname);
      if (isAigei) {
        const res = await chrome.runtime.sendMessage({ type: 'HMDAO_CAPTURE_AUDIO_NOW', tabId: a.tabId });
        if (res && res.ok && Array.isArray(res.audioPlays)) {
          // audioPlays 每条为 { url, path(origin+pathname), how, ts }；按 path 精确匹配
          const wantPath = (() => { try { return new URL(a.url || a.href || '').origin + new URL(a.url || a.href || '').pathname; } catch (_) { return ''; } })();
          let match = null;
          if (wantPath) match = res.audioPlays.find((p) => p.path && p.path === wantPath);
          if (!match && res.audioPlays.length) match = res.audioPlays[0];
          if (match && match.url) {
            a.url = match.url;
            a.fresh = true;
            // 同步写回全局素材库，避免下次悬停再次回退
            maybeUpdateAssetUrl(a, match.url);
          }
        }
      }
    } catch (_) {}
  }
  await playAudioInPage(a, { visual: false, useHover: true });
}

function stopHoverAudio() {
  const overlayOpen = document.getElementById('previewOverlay').classList.contains('open');
  if (overlayOpen) return;
  // ★豆包朗读：悬停走的是【源页内播放】，移开时必须同步停源页那个游离 <audio>
  if (window.__hmdaoPlayingDoubaoWs) {
    window.__hmdaoPlayingDoubaoWs = false;
    try { chrome.runtime.sendMessage({ type: 'HMDAO_STOP_DOUBAO_WS_AUDIO' }).catch(() => {}); } catch (_) {}
  }
  // ★关键修复（2026-08-01）：hoverPlayAudio 走 playAudioInPage → playAudioViaBlob，
  // 实际是给侧栏自身 <audio id="previewAudio"> 喂 blob 播放。鼠标离开时必须 pause 这个
  // 元素，否则音频会持续播放（之前 stopHoverAudio 只发 HMDAO_STOP_AUDIO_IN_PAGE 给源页
  // 的游离 Audio，未暂停侧栏 <audio> → 用户报告"移开还在播放"）。
  try {
    const au = document.getElementById('previewAudio');
    // ★推进播放令牌：使任何仍在挂起的 playAudioViaBlob.play() 落入「被合法接管」分支，
    // 不再把 pause() 打断它的 AbortError 误报为播放故障。
    playToken++;
    if (au) { try { au.pause(); } catch (_) {} try { au.removeAttribute('src'); au.load(); } catch (_) {} }
  } catch (_) {}
  if (hoverAudioInPage) {
    chrome.runtime.sendMessage({ type: 'HMDAO_STOP_AUDIO_IN_PAGE', audioId: 'hover' });
    hoverAudioInPage = false;
  }
  // 同时暂停源页自身正在播放的 <audio> 元素
  if (window.__playingPageIdx != null) {
    chrome.runtime.sendMessage({ type: 'HMDAO_STOP_PAGE_AUDIO', audioIdx: window.__playingPageIdx }).catch(() => {});
    window.__playingPageIdx = null;
  }
  setStatus('');
}

// ★兜底：鼠标离开整个侧栏资产列表或侧栏失去焦点时，强制停止 hover 试听。
// 单独卡片 mouseleave 在快速移出侧栏、iframe 边界或焦点丢失时可能漏发，
// 这里用容器级 mouseleave + window blur 作为最后一道保险。
function installSidepanelAudioLeaveGuard() {
  try {
    const listEl = document.getElementById('list');
    if (listEl) {
      listEl.addEventListener('mouseleave', (e) => {
        stopHoverAudio();
      });
    }
    // 侧栏失去焦点（用户切到别的窗口/标签）也停止
    window.addEventListener('blur', () => {
      stopHoverAudio();
    });
  } catch (_) {}
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', installSidepanelAudioLeaveGuard);
} else {
  installSidepanelAudioLeaveGuard();
}
