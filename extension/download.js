// ===== 下载 / 存到本地（单个资产）（抽离自 sidepanel.js）=====
// 依赖 sidepanel.js 全局：setStatus / typeDirs / deriveFilename / fileName / sourceOrigin /
// fetchViaBackground / isYtDlpPlatform / window.__sourcePageUrl / checkYtDlp / ensureYtDlpPrompt，
// 以及 audio-playback.js 的 downloadViaBrowser / downloadVideoViaBackground。
// 本文件在音频与右键菜单之后加载，故调用方（bulk-actions.js / context-menu.js）运行时可见全部符号。
// 纯物理拆分（普通脚本，共享全局作用域），行为零改变。

// chrome.downloads.download 不支持 blob: URL，统一用 <a download> 触发 blob 下载
function downloadBlobUrl(blobUrl, filename) {
  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

// opts: { downloadUrl?: string, formatId?: string }
//   downloadUrl —— 指定要下载的具体直链（用于分辨率选择面板选中的某个直链源）
//   formatId    —— 指定 yt-dlp 格式（如 '137+140'），覆盖当前选中的 __ytSelectedFormat
async function downloadSingle(a, opts = {}) {
  if (!chrome.downloads) { setStatus('下载 API 不可用', true); return; }
  // 指定具体直链下载（分辨率选择面板选中的某个 URL 源）：经后台带 Referer 拉取字节→blob→下载，
  // 兼容防盗链（抖音/腾讯等）与普通 CDN，失败时回退 chrome.downloads 直连。
  if (opts && opts.downloadUrl && opts.downloadUrl.startsWith('http')) {
    const target = { ...a, url: opts.downloadUrl };
    const referer = deriveMediaReferer(opts.downloadUrl, window.__sourcePageUrl || '');
    const cdnVideo = /douyin|tiktok|bytedance|weixin|qq\.com|douyinvod|v26-web/i.test(opts.downloadUrl || '');
    if (cdnVideo) { downloadVideoViaBackground(target); return; }
    setStatus('正在后台拉取所选分辨率字节…');
    const res = await fetchMediaViaBackground(opts.downloadUrl, referer);
    if (res && res.ok && res.b64) {
      const blob = new Blob([b64ToBytes(res.b64)], { type: res.mime || 'video/mp4' });
      const url = URL.createObjectURL(blob);
      cacheDragBlob(target, blob, res.mime || 'video/mp4');
      downloadBlobUrl(url, 'Ddayup/videos/' + deriveFilename(target));
      setTimeout(() => URL.revokeObjectURL(url), 120000);
      setStatus('✅ 已下载所选分辨率');
      return;
    }
    // 后台失败 → 回退直连（直链自带签名通常可通）
    chrome.downloads.download({
      url: opts.downloadUrl,
      filename: 'Ddayup/videos/' + deriveFilename(target),
      saveAs: false, conflictAction: 'uniquify',
    }).then(() => setStatus('✅ 已下载所选分辨率'))
      .catch((e) => setStatus('⚠ 所选分辨率下载失败：' + (e && e.message || e), true));
    return;
  }
  console.log('[Ddayup] downloadSingle', a.url);
  // 网盘分享：没有真实文件直链，直接打开提取页（输提取码后由网盘 API / 浏览器下载事件捕获真实文件）
  if (a.type === 'netdisk') {
    chrome.tabs.create({ url: a.url, active: true });
    setStatus('已打开网盘分享页：' + (() => { try { return new URL(a.url).hostname; } catch (_) { return a.url; } })());
    return;
  }
  // 已合并的 DASH 单文件（blob）：直接下载合并结果，无需再走 WBI
  if (a.__mergedDash && typeof a.url === 'string' && a.url.startsWith('blob:')) {
    const name = a.__mergedName || 'video_merged.mp4';
    chrome.downloads.download({ url: a.url, filename: 'Ddayup/videos/' + name, saveAs: false, conflictAction: 'uniquify' })
      .then(() => setStatus('✅ 已下载合并单文件 MP4：' + name))
      .catch((e) => setStatus('⚠ 合并文件下载失败：' + (e && e.message || e), true));
    return;
  }
  const isBlob = a.url.startsWith('blob:');
  const sourcePage = window.__sourcePageUrl || '';
  const isBili = /bilibili\.com/.test(a.url) || /bilibili\.com/.test(sourcePage);
  // B站视频（含 MSE blob）：若 yt-dlp 可用则走后端提取（含格式选择），否则走 WBI
  if (a.type === 'video' && (isBlob || isBili)) {
    if (isYtDlpPlatform(a)) {
      // 走下面统一的 yt-dlp 路径
    } else if (sourcePage && isBili) {
      setStatus('B站视频：正在通过 WBI 获取整段 MP4（含音画）…');
      refreshThenDownload(a, sourcePage);
      return;
    } else if (isBlob) {
      if (sourcePage) { setStatus('视频为 MSE 流，正在源页重新捕获直链…'); refreshThenDownload(a, sourcePage); return; }
      setStatus('⚠ blob URL — 请保持源页打开后重试', true); return;
    }
  }
  // 音效下载：
  // 优先用「源页身份」fetch+下载（带登录 Cookie，能复刻在爱给/freesound 页面能下的效果）。
  // 仅当源页方案失败（无源标签 / 跨域 fetch 报错）才退回 chrome.downloads + Referer 规则兜底。
  if (a.type === 'audio') {
    // 主路径：抓到真实直链（网络层捕获 / 页面解析）→ 用浏览器下载管理器下载。
    // chrome.downloads.download 会自动带上源站登录 Cookie（用户已登录），
    // 再叠加 declarativeNetRequest 注入的 Referer 头绕过防盗链，等价于「F12 复制直链 → 新标签打开 → 另存为」。
    if (a.url && a.url.startsWith('http')) {
      await downloadViaBrowser(a);
      return;
    }
    // 兜底：仅有 MSE <audio> 元素（空 URL，如未捕获到直链的爱给试听）→ 触发源页自身下载按钮（带登录态）
    if (a.audioIdx != null) {
      setStatus('正在触发源页下载按钮…');
      const r = await chrome.runtime.sendMessage({ type: 'HMDAO_DOWNLOAD_PAGE_AUDIO', audioIdx: a.audioIdx });
      if (r && r.ok) { setStatus('✅ 已触发源页下载（浏览器下载管理器接管）'); return; }
      setStatus('⚠ 未找到源页下载按钮（' + (r && r.error || '未知') + '），请在爱给页点下载', true);
      return;
    }
    setStatus('⚠ 无可用下载地址', true);
    return;
  }
  if (isBlob) { setStatus('⚠ blob URL — 无法下载，请用原页面右键「视频另存为」', true); return; }
  const isStream = /\.(m3u8|mpd)(\?|$)/i.test(a.url);
  if (isStream) setStatus('⚠ 流媒体下载仅得到播放列表', true);
  // 抖音/TikTok/视频号等防盗链视频：chrome.downloads 直连必 403，走后台带 Referer 拉取字节→blob 下载
  const cdnVideo = /douyin|tiktok|bytedance|weixin|qq\.com|douyinvod|v26-web/i.test(a.url || '');
  if (a.type === 'video' && cdnVideo) {
    // 如果用户在分辨率下拉选了非默认版本，用它替换下载 URL
    const selDy = window.__dySelectedFormat;
    if (selDy && selDy !== a.url) {
      a = { ...a, url: selDy };
    }
    downloadVideoViaBackground(a);
    return;
  }
  // yt-dlp 多平台统一下载（YouTube / B站等）：支持分辨率选择
  const isYtDlpVideo = a.type === 'video' && isYtDlpPlatform(a);
  if (isYtDlpVideo) {
    await downloadViaYtDlp(a, sourcePage);
    return;
  }
  // 直接走 chrome.downloads.download（不带任何 header）—— B 站 CDN URL 自带签名参数必通
  chrome.downloads.download({
    url: a.url,
    filename: 'Ddayup/' + (typeDirs[a.type] || 'other') + '/' + deriveFilename(a),
    saveAs: false,
    conflictAction: 'uniquify',
  }).then((id) => {
    setStatus(`✅ 下载已触发：${fileName(a.url)}` + (isStream ? '（仅播放列表）' : ''));
    console.log('[Ddayup] download id', id);
  }).catch((err) => {
    // 回退：WBI 重新拿 fresh URL
    console.log('[Ddayup] chrome.downloads 失败:', err && err.message, a.url);
    if (window.__sourcePageUrl) {
      setStatus('直链失败，回退 WBI 重新捕获…');
      refreshThenDownload(a, window.__sourcePageUrl);
    } else {
      setStatus('下载失败：' + (err.message || err), true);
      if (a.type === 'video') checkYtDlp().then((st) => { if (st === 'missing') ensureYtDlpPrompt(); });
    }
  });
}

// ===== yt-dlp 多平台统一下载（YouTube / B站等），支持分辨率选择 =====
async function downloadViaYtDlp(a, sourcePage, formatId) {
  const selFmt = formatId || window.__ytSelectedFormat || '';
  const fmtHint = selFmt ? '（指定格式 ' + selFmt + '）' : '';
    const platform = /bilibili/i.test(sourcePage || a.ytPageUrl || a.biliPageUrl || a.url || '') ? 'B站' : (/youtube/i.test(sourcePage || a.ytPageUrl || a.url || '') ? 'YouTube' : '平台');
  setStatus('正在通过后端提取 ' + platform + ' 直链' + fmtHint + '…');
  try {
    const videoPageUrl = a.ytPageUrl
      || a.biliPageUrl
      || a.playerUrl
      || (a.ytVideoId ? ('https://www.youtube.com/watch?v=' + a.ytVideoId) : '')
      || (a.biliVideoId ? ('https://www.bilibili.com/video/' + a.biliVideoId) : '')
      || sourcePage;
    let extractUrl = 'http://127.0.0.1:3000/api/platform/ytdlp?action=extract&url=' + encodeURIComponent(videoPageUrl);
    if (selFmt) extractUrl += '&format=' + encodeURIComponent(selFmt);
    const ytRes = await fetch(extractUrl, { credentials: 'omit' });
    const ytData = await ytRes.json().catch(() => null);
    if (ytData && ytData.url) {
      // yt-dlp 返回的直链自带签名，直接用 chrome.downloads 下载
      // B站 CDN 无 Referer 限制，YouTube googlevideo 需 Referer（由 dNR 规则注入）
      const title = ytData.title || deriveFilename(a);
      const safeTitle = title.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_');
      chrome.downloads.download({
        url: ytData.url,
        filename: 'Ddayup/videos/' + safeTitle + '.mp4',
        saveAs: false,
        conflictAction: 'uniquify',
      }).then(() => setStatus('✅ 已下载：' + title))
        .catch((e) => setStatus('⚠ 下载失败：' + (e && e.message || e), true));
      return;
    }
    setStatus('⚠ yt-dlp 返回空直链，请确保后端 127.0.0.1:3000 正在运行', true);
    checkYtDlp().then((st) => { if (st === 'missing') ensureYtDlpPrompt(); });
  } catch (e) {
    setStatus('⚠ 后端 yt-dlp 不可用，请确保 Ddayup Web App 已启动（127.0.0.1:3000）', true);
    checkYtDlp().then((st) => { if (st === 'missing') ensureYtDlpPrompt(); });
  }
}

// ===== CDN 鉴权站专用：先在源页重新捕获 fresh URL，再下载 =====
async function refreshThenDownload(a, sourcePage) {
  setStatus('正在源页重新捕获 fresh URL…');
  try {
    const refreshRes = await chrome.runtime.sendMessage({ type: 'HMDAO_REFRESH_FROM_PAGE', assetUrl: a.url });
    if (refreshRes && refreshRes.ok && refreshRes.url) {
      const result = refreshRes.url;
      // DASH 分离轨（>1080p 等无整段 MP4）：m4s 直链无 Referer 必 403，必须经 background 带 Referer 拉取再落盘
      if (result && typeof result === 'object' && result.__dash) {
        await downloadDashTracks(a, result);
        return;
      }
      const newUrl = result;
      const isBlob = typeof newUrl === 'string' && newUrl.startsWith('blob:');
      if (isBlob) {
        setStatus('⚠ 该视频使用 MSE（Media Source Extensions），无单一下载链接。请在 B站原视频上右键→「视频另存为」', true);
        return;
      }
      setStatus('已捕获 fresh URL：' + (() => { try { return new URL(newUrl).host; } catch (_) { return ''; } })() + '，下载中…');
      if (/googlevideo\.com\/videoplayback/i.test(newUrl)) {
        // YouTube 直链需带源站第三方 Cookie，chrome.downloads 直连带不出 → 走后台源页上下文拉取
        downloadVideoViaBackground({ ...a, url: newUrl });
        return;
      }
      // 优先走 chrome.downloads（不带任何 header，避开 Unsafe）
      chrome.downloads.download({
        url: newUrl,
        filename: 'Ddayup/' + (typeDirs[a.type] || 'other') + '/' + deriveFilename(a),
        saveAs: false,
        conflictAction: 'uniquify',
      }).then(() => {
        setStatus('下载触发：' + fileName(a.url));
      }).catch((err) => {
        // chrome.downloads 失败再走 fetch+Blob（带 referer）
        setStatus('原生下载失败，回退 fetch+Blob…');
        return downloadViaFetchBlob({ ...a, url: newUrl }, sourcePage);
      });
    } else {
      // 源页拿不到 fresh URL —— 退到 fetch + Blob（可能 0 字节但能拿就拿）
      setStatus('源页未捕获到 video，尝试 fetch+Blob…');
      await downloadViaFetchBlob(a, sourcePage);
    }
  } catch (e) {
    setStatus('refresh 失败：' + (e.message || e), true);
    if (a.type === 'video') checkYtDlp().then((st) => { if (st === 'missing') ensureYtDlpPrompt(); });
  }
}

// ===== CDN 鉴权站专用下载：fetch + Blob + <a download> =====
async function downloadViaFetchBlob(a, sourcePage) {
  setStatus('带 Referer 鉴权下载…');
  try {
    const res = await fetchViaBackground(a.url, { referer: sourcePage });
    if (!res || !res.ok) { setStatus('下载失败：' + (res?.error || res?.status || '无响应'), true); return; }
    // 注意：大文件（视频）一次性写内存 → Blob 可能 OOM；本路径主要应对 ≤50 MB 资源
    const sizeKB = (res.arrayBuffer && res.arrayBuffer.byteLength || 0) / 1024;
    if (sizeKB > 50 * 1024) {
      // 大视频直接报错让用户用「存到本地」（流式写盘）
      setStatus(`⚠ 该文件 ${Math.round(sizeKB/1024)}MB，超出 Blob 内存上限，请用「存到本地」流式写盘`, true);
      return;
    }
    const mime = res.mime || (a.type === 'audio' ? 'audio/mpeg' : a.type === 'video' ? 'video/mp4' : 'application/octet-stream');
    const blob = new Blob([res.arrayBuffer], { type: mime });
    const url = URL.createObjectURL(blob);
    // chrome.downloads.download 不支持 blob: URL，统一用 <a download> 触发（Chrome 支持 blob 下载）
    downloadBlobUrl(url, deriveFilename(a));
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    setStatus('下载触发：' + fileName(a.url));
  } catch (e) {
    setStatus('下载失败：' + (e.message || e), true);
  }
}

// ===== DASH 分离轨下载：经 background 带 Referer 拉取（m4s 无 Referer 必 403），blob 落盘 =====
// 视频轨/音频轨分别保存为 .video.mp4 / .audio.m4a，附提示需用播放器或 ffmpeg 合并。
async function downloadDashTracks(a, dash) {
  const base = deriveFilename(a).replace(/\.[^.]+$/, '');
  const referer = dash.referer || window.__sourcePageUrl || 'https://www.bilibili.com';
  setStatus('该清晰度仅 DASH 分离轨，正在带 Referer 拉取视频/音频轨…');
  const saveBlob = async (url, filename, mime) => {
    const res = await fetchViaBackground(url, { referer });
    if (!res || !res.ok || !res.arrayBuffer) throw new Error('track status=' + (res && (res.status || res.error)));
    const blobUrl = URL.createObjectURL(new Blob([res.arrayBuffer], { type: mime }));
    await chrome.downloads.download({ url: blobUrl, filename, saveAs: false, conflictAction: 'uniquify' });
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  };
  try {
    await saveBlob(dash.video, 'Ddayup/videos/' + base + '.video.mp4', 'video/mp4');
    if (dash.audio) await saveBlob(dash.audio, 'Ddayup/videos/' + base + '.audio.m4a', 'audio/mp4');
    setStatus('✅ 已下载视频轨+音频轨（DASH 分离），请用播放器/ffmpeg 合并（该清晰度无整段 MP4）', true);
  } catch (e) {
    setStatus('DASH 分轨下载失败：' + (e.message || e) + '（可在预览里切低清晰度取整段 MP4）', true);
  }
}

async function saveSingleToLocal(a) {
  const handle = saveHandles[a.type];
  if (!handle) {
    // 未设置该类型目录 → 回退下载
    setStatus(`「${typeLabel(a.type)}」未设保存目录，改为下载`, true);
    downloadSingle(a);
    return;
  }
  try {
    const res = await fetchViaBackground(a.url, a.type === 'audio' ? { referer: sourceOrigin() } : {});
    if (!res || !res.ok) { setStatus('抓取失败', true); return; }
    const name = deriveFilename(a);
    const fileHandle = await handle.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(res.arrayBuffer);
    await writable.close();
    setStatus('已保存：' + name);
  } catch (e) { setStatus('保存失败：' + (e.message || e), true); }
}
