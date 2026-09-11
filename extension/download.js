// ===== 下载 / 存到本地（单个资产）（抽离自 sidepanel.js）=====
// 依赖 sidepanel.js 全局：setStatus / typeDirs / deriveFilename / fileName / sourceOrigin /
// fetchViaBackground / isYtDlpPlatform / window.__sourcePageUrl / checkYtDlp / ensureYtDlpPrompt，
// progress.js 的 showDownloadProgress / pulseDownloadProgress / updateDownloadProgress / finishDownloadProgress，
// 以及 audio-playback.js 的 downloadViaBrowser / downloadVideoViaBackground。
// 本文件在音频与右键菜单之后加载，故调用方（bulk-actions.js / context-menu.js）运行时可见全部符号。
// 纯物理拆分（普通脚本，共享全局作用域），行为零改变。

// ★2026-08-11 多任务：当前正在下载的素材（downloadSingle 入口设置），供 dlViaChrome 默认关联 asset，
//   使下载完成后能自动入库。若 opts.asset 显式传入则优先。
let __currentDownloadAsset = null;

// 统一包裹 chrome.downloads.download：触发即开「独立任务卡片」，按 downloadId 与 onChanged 联动真实百分比。
// 返回 Promise（同原生），失败时 rejected 并即时标记失败原因。
// ★2026-08-11 多任务改造：每个调用方（每条资产）一个 dlId 任务卡，互不覆盖；
//   downloadId 回填到任务卡，使 onChanged 的真实进度/完成/中断能精确命中该卡。
// ★2026-09-10 P1：此处是【唯一】的 chrome.downloads.download 包装器。
//   把「优先写用户设置目录」的判断放在这里，等于一次性覆盖全部 17 个历史落盘点，
//   今后新增平台也不会再漏网。失败一律回退原生下载，行为与改造前完全一致。
async function dlViaChrome(opts) {
  const name = (opts.filename || '').split(/[\\/]/).pop() || '下载中…';
  const asset = opts.asset || __currentDownloadAsset || null;
  if (asset && opts && typeof opts.url === 'string' && /^https?:/i.test(opts.url)) {
    try {
      if (await tryWriteUserDirFromUrl(asset, opts.url, name)) return -1; // 绝对目录已写
    } catch (_) { /* 忽略，回退原生下载 */ }
    // ★2026-09-11 双保险：绝对目录未设置/失败 → 若用户填了相对子目录，
    //   把下载落到「浏览器下载目录/Ddayup/<相对子目录>/」而非默认类型子目录。
    try {
      if (typeof userRelDirFor === 'function') {
        const rel = userRelDirFor(asset.type);
        if (rel) opts = Object.assign({}, opts, { filename: 'Ddayup/' + rel + '/' + name });
      }
    } catch (_) {}
  }
  const dlId = window.HmdaoProgress.registerTask({ name, asset });
  // ★2026-09-02 修复（实测）：asset 是【侧栏进度任务卡】用的自定义字段，
  //   不是 chrome.downloads.download 的合法参数。旧代码把整个 opts 原样透传，
  //   Chrome 直接抛 "Unexpected property: 'asset'" → 所有带 asset 的下载全部失败。
  //   （本次是在新增「后端 ffmpeg 合并」下载时暴露的：status 还停留在"开始下载…"却什么都没下。）
  const downloadOpts = { ...opts };
  delete downloadOpts.asset;
  return chrome.downloads.download(downloadOpts).then((id) => {
    if (id != null) {
      // 回填 chrome 真实下载 id，供 onChanged/取消 精确命中
      window.HmdaoProgress.bindDownloadId(dlId, id);
    } else {
      // download() 未返回 id（如被策略拦截）：标记为失败
      window.HmdaoProgress.fail(dlId, 'FILE_FAILED');
    }
    return id;
  }).catch((err) => {
    const msg = String((err && err.message) || err || '');
    // 用户点击浏览器「取消」或策略拒绝：区分标记
    if (/cancel|user/i.test(msg)) window.HmdaoProgress.cancel(dlId);
    // ★2026-09-09 修复（用户实测「一张卡显示下载成功、另一张报文件写入失败 FILE_FAILED」无从判断）：
    //   旧代码把 chrome.downloads.download 抛出的【任何】异常统一标成 'FILE_FAILED'，
    //   卡片于是永远显示「磁盘权限/路径无效/文件名冲突」——而真实原因（Invalid filename /
    //   Access denied / 策略拦截 / 网络被断…）只留在 console 的 '[Ddayup] chrome.downloads 失败' 日志里。
    //   磁盘真有问题时回退路径（blob → <a download>）同样写不进去，能成功就说明磁盘没事，
    //   这个误导文案会把人引去查磁盘。现把真实拒绝原因透传到任务卡（reasonText 对未知码
    //   会输出「下载失败：<原文>」），识别不出时才回退 FILE_FAILED。
    else window.HmdaoProgress.fail(dlId, msg ? ('chrome.downloads: ' + msg) : 'FILE_FAILED');
    throw err;
  });
}

// ★2026-09-02 抖音「按分辨率下载」：面板选中的档位是 douyinvod 视频轨（无签名），
//   前端无法直下（chrome.downloads 不能传 Referer、dNR 会破坏签名、fetch 跨域 CORS）。
//   改由【后端】带 Referer 拉视频轨 + 音频轨，ffmpeg 合并成含音画单文件，前端再下载产物。
//   实测（extension/tests/verify-dy-track-merge.mjs）：1080P 视频轨 + 音频轨 → h264 1920x1080 + aac。
//   后端接口：POST /api/media/merge-dash { videoUrl, audioUrl, referer } → { ok, fileUrl, ... }
async function mergeAndDownloadViaBackend(a, videoUrl) {
  if (typeof videoUrl !== 'string' || !/^https?:/i.test(videoUrl)) throw new Error('视频轨 URL 非法');
  // 1) 取音频轨：优先级 ① 资产自带 dashAudio（扫描时已按时间邻近配对，最可靠）
  //    ② 资产 dyFormats 里 audio 标签项 ③ 源页 captures.dyAudios 实时读（兜底）。
  //    ★ 抖音 dyFormats 是纯视频轨（无 audio 项），dashAudio 才是配对音频；
  //      若只查 dyFormats 会恒为空、又要求活跃标签是抖音页 → 面板选分辨率下载时经常拿不到音轨。
  let audioUrl = '';
  if (a && typeof a.dashAudio === 'string' && /^https?:/i.test(a.dashAudio)) audioUrl = a.dashAudio;
  if (!audioUrl) {
    try {
      const fm = ((a && a.dyFormats) || []).filter((f) => f && /audio/i.test(f.label || ''));
      if (fm[0] && fm[0].url) audioUrl = fm[0].url;
    } catch (_) {}
  }
  if (!audioUrl) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id != null) {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: 'MAIN',
          func: () => { const c = window.__hmdao_captures || {}; const au = (c.dyAudios || [])[0] || {}; return au.url || ''; },
        });
        audioUrl = (r && r.result) || '';
      }
    } catch (_) {}
  }
  if (!audioUrl) throw new Error('找不到音频轨（dyAudios 为空，无法合并音视频）');
  // 2) 调后端合并
  const base = (typeof apiBaseUrl === 'function')
    ? apiBaseUrl()
    : ((typeof getCloudApiBase === 'function') ? await getCloudApiBase() : 'http://127.0.0.1:3000');
  setStatus('正在合并音视频（' + (a.qualityTag || '选定分辨率') + '）…', false);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120000);
  let resp;
  try {
    resp = await fetch(base.replace(/\/$/, '') + '/api/media/merge-dash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoUrl, audioUrl, referer: 'https://www.douyin.com/' }),
      signal: controller.signal,
    });
  } catch (fetchErr) {
    clearTimeout(timeoutId);
    if (fetchErr && fetchErr.name === 'AbortError') {
      throw new Error('后端合并超时（120 秒）：请确认 Ddayup 网页 127.0.0.1:3000 已启动，或所选视频过大');
    }
    throw new Error('后端合并请求失败：' + (fetchErr && fetchErr.message || fetchErr));
  }
  clearTimeout(timeoutId);
  const data = await resp.json().catch(() => ({}));
  if (!data || !data.ok) throw new Error('后端合并失败：' + ((data && data.error) || ('HTTP ' + resp.status)));
  if (!data.fileUrl) throw new Error('后端未返回 fileUrl');
  // 3) 下载合并产物（本机直连，无防盗链）
  const mergedUrl = base.replace(/\/$/, '') + data.fileUrl;
  const mergedName = deriveFilename(a);
  // ★2026-09-10：用户为该类型设置了目录 → 写用户目录（FileSystemAccess 可写任意路径），
  //   否则回退 chrome.downloads（默认 Ddayup/videos）。
  if (typeof saveHandles !== 'undefined' && saveHandles && saveHandles[a.type]) {
    try {
      const mb = await fetch(mergedUrl).then((r) => r.blob());
      if (await writeBlobToUserDir(a.type, mergedName, mb)) {
        setStatus('✅ 已保存到设置的目录：' + mergedName, true);
        return;
      }
    } catch (_) { /* 回退默认下载 */ }
  }
  await dlViaChrome({
    url: mergedUrl,
    filename: 'Ddayup/videos/' + mergedName,
    asset: a, saveAs: false, conflictAction: 'uniquify',
  });
  setStatus('✅ 抖音视频已合并下载到本地（' + (a.qualityTag || '选定分辨率') + '，侧栏任务卡查看进度）', true);
}

// chrome.downloads.download 不支持 blob: URL，统一用 <a download> 触发 blob 下载
// （blob 触发无进度事件，故用脉冲条提示「正在保存」）
// ★2026-09-10 P1：blob 落盘唯一包装器，同样先问用户目录（覆盖 194/355/508/637/1067/1241 六处）。
async function downloadBlobUrl(blobUrl, filename, asset) {
  const name = (filename || '').split(/[\\/]/).pop() || '下载中…';
  const a = asset || __currentDownloadAsset || null;
  try {
    if (await tryWriteUserDirFromBlob(a, blobUrl, name)) return;
  } catch (_) { /* 忽略，回退 <a download> */ }
  const dlId = window.HmdaoProgress.registerTask({ name, asset: asset || null });
  // blob 无字节回调：用 indeterminate 脉冲态表示「正在保存」，乐观完成
  window.HmdaoProgress.updateTask(dlId, { state: window.HmdaoProgress.STATE.DOWNLOADING, totalBytes: 0, receivedBytes: 0 });
  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // <a download> 触发浏览器下载后，短延迟转完成态（无字节回调，只能乐观标记）
  setTimeout(() => window.HmdaoProgress.complete(dlId, '已保存（浏览器下载文件夹）'), 800);
}

// ★2026-08-31 新增（"B站 durl 右键下载 FILE_FAILED"真凶最终闭环）：
//   通过【源页 context <a download href=durl> 点击】触发浏览器原生下载——与抖音视频（sidepanel.js:321
//   HMDAO_DOWNLOAD_IN_TAB）同一最稳模式：
//     - 源页是 bilibili.com，<a download> 是 no-cors 媒体下载，浏览器自动带【源页会话 Cookie】+ Referer
//       → bilivideo CDN 放行 → 真实视频字节（chrome-extension 来源直连带不上 Cookie → 403 → FILE_FAILED）。
//     - 浏览器原生下载无 fetch+blob 的 ~64MB 消息上限（整段 1080P 可超 64MB），且进度由
//       chrome.downloads.onChanged 驱动侧栏任务卡（见 background.js:261 onCreated 转发 + sidepanel handleDownloadChanged）。
//   替代 chrome.downloads.download 直连（带不上会话 Cookie → 必 FILE_FAILED）。
//   注意：filename 传 'Ddayup/videos/x.mp4'，HMDAO_DOWNLOAD_IN_TAB 会把 '/' 替换成 '_'
//   → 实际下载名 'Ddayup_videos_x.mp4'，靠 background.js / sidepanel 的 /Ddayup/i 正则匹配进度卡。
// ★豆包朗读（WS 流式 ogg_opus）下载：无 HTTP 直链可下，
//   改从源页取回 doubao-audio-capture.js 旁路收集到的原始字节（不重编码、不录制，即平台下发的原始音频），
//   全程不发起任何网络直链请求，也不改动源页任何行为。
async function downloadDoubaoWsAudio(a) {
  setStatus('正在从源页取回朗读音频…');
  // 首选：源页内合成 Blob 直接下载（字节不出页面 → 无回传大小限制，长朗读也稳）
  let name0 = deriveFilename(a).replace(/\.(mp3|bin)$/i, '');
  let res = null;
  try {
    res = await chrome.runtime.sendMessage({
      type: 'HMDAO_DOWNLOAD_DOUBAO_WS_AUDIO',
      ts: Number(a.wsTs) || 0,
      name: name0 + '.ogg',
    });
  } catch (_) { res = null; }
  if (res && res.ok) {
    setStatus('✅ 已下载：' + (res.name || (name0 + '.ogg')));
    return true;
  }
  // 回退：取回字节 → blob 下载（受回传大小限制，但兼容源页注入受限的场景）
  try {
    res = await chrome.runtime.sendMessage({ type: 'HMDAO_GET_DOUBAO_WS_AUDIO', ts: Number(a.wsTs) || 0 });
  } catch (_) { res = null; }
  if (!res || !res.ok || !res.b64) {
    setStatus('⚠ 未取到朗读音频' + (res && res.error ? '（' + res.error + '）' : '') + '，请先在源页点一次「朗读」并播放', true);
    return false;
  }
  try {
    const bytes = b64ToBytes(res.b64);
    const mime = (res.mime && /^audio\//.test(res.mime)) ? res.mime : 'audio/ogg';
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    // deriveFilename 对 audio 默认补 .mp3，这里按真实格式改后缀，避免扩展名与内容不符
    let name = deriveFilename(a);
    name = name.replace(/\.(mp3|bin)$/i, '') + (res.ogg ? '.ogg' : '.bin');
    downloadBlobUrl(url, 'Ddayup/audio/' + name, a);
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    setStatus('✅ 已下载：' + name);
    return true;
  } catch (e) {
    setStatus('⚠ 下载失败：' + errStr(e), true);
    return false;
  }
}

async function downloadBiliDurlViaPageFetch(newUrl, a) {
  const name = deriveFilename(a);
  setStatus('B站 durl 经 Referer 注入后下载到本地…');
  // ★2026-08-31 修复（"右键下载弹出新界面、没下载到本地"真凶闭环）：
  //   <a> 方案对 B站 durl 必败：fetch→blob 因 bilivideo 无 CORS 头失败（method=blob 失败）；
  //   兜底 <a target=_blank> 打开 mp4 直链被 Chrome 内嵌播放（无 Content-Disposition）→ 「弹出新界面、没下载到本地」。
  //   唯一能「强制下载到本地且绝不导航源页」的是 chrome.downloads.download；但它发请求 Referer=chrome-extension
  //   → bilivideo CDN 403。故后台在下载前用 dNR 临时注入 Referer=bilibili.com，直连 durl 即被 CDN 放行 → 真实 mp4 落盘。
  try {
    if (typeof hmdaoLog === 'function') hmdaoLog('[B站下载] 触发 chrome.downloads durl=' + String(newUrl).slice(0, 70));
    // ★2026-09-11：后台代下载通道无法写任意目录 → 发起前先抢一次用户目录
    if (await tryUserDirBeforeNativeChannel(a, newUrl, name)) return;
    const r = await chrome.runtime.sendMessage({
      type: 'HMDAO_DOWNLOAD_BILI_DURL',
      url: newUrl,
      filename: 'Ddayup/videos/' + name,
    });
    if (r && r.ok) {
      setStatus('✅ B站视频已触发下载：' + name + '（浏览器下载栏查看进度）');
      if (typeof hmdaoLog === 'function') hmdaoLog('[B站下载] chrome.downloads 成功 id=' + r.id);
    } else {
      throw new Error((r && r.error) || '未知失败');
    }
  } catch (e) {
    const em = (e && e.message || e || '未知');
    setStatus('⚠ B站 chrome.downloads 失败（' + em + '），回退源页 <a target=_blank>（请在新标签右键"另存为"）', true);
    if (typeof hmdaoLog === 'function') hmdaoLog('[B站下载] chrome.downloads 失败 ' + em + '，回退 HMDAO_DOWNLOAD_IN_TAB');
    // 兜底：任意 http(s) 标签页注入 <a target=_blank href=durl>（dNR 已注入 Referer → 浏览器新标签加载 durl，
    // 用户在新标签右键「另存为」保存到本地；源视频页不导航）
    try {
      let srcTab = null;
      const tabs = await chrome.tabs.query({});
      const bili = (tabs || []).find((t) => /bilibili\.com/i.test(t.url || ''));
      if (bili && bili.id != null) srcTab = bili.id;
      else { try { srcTab = await getSourceTabId(); } catch (_) {} }
      if (srcTab != null) {
        await chrome.runtime.sendMessage({
          type: 'HMDAO_DOWNLOAD_IN_TAB',
          url: newUrl,
          filename: 'Ddayup/videos/' + name,
          tabId: srcTab,
          sourcePageUrl: a.url,
        });
        setStatus('⚠ chrome.downloads 不可用（' + em + '），已在新标签打开 durl，请在新标签右键"另存为"保存到本地', true);
      } else {
        setStatus('⚠ B站下载失败：未找到任何 http(s) 标签注入兜底，请保持 B站页面打开后重试', true);
      }
    } catch (e2) {
      setStatus('⚠ B站兜底也失败：' + (e2 && e2.message || e2), true);
    }
  }
}

// opts: { downloadUrl?: string, formatId?: string }
//   downloadUrl —— 指定要下载的具体直链（用于分辨率选择面板选中的某个直链源）
//   formatId    —— 指定 yt-dlp 格式（如 '137+140'），覆盖当前选中的 __ytSelectedFormat
// ★2026-09-10：用户为某类型设置了保存目录时，下载必须落到【用户设置的目录】。
//   背景：chrome.downloads.download 只能写到「浏览器下载目录 + 相对子目录」，
//   无法写入用户在侧栏用 showDirectoryPicker 选择的任意目录；而 saveHandles[type]
//   是 FileSystemDirectoryHandle（File System Access API），可直接写任意目录。
//   此前 downloadSingle 完全没读 saveHandles → 用户设了目录也照样落到 Ddayup/<默认子目录>。
//   策略：有 handle 就走 File System Access 写入；任何失败都返回 false，由调用方回退原下载逻辑。
async function trySaveToUserDir(a) {
  try {
    // ★2026-09-10 关键修复（"点了下载完全没反应"的真凶）：
    //   流媒体（m3u8/mpd）绝不能走「抓字节→写用户目录」这条路 —— a.url 是【文本播放列表】，
    //   fetchViaBackground 抓到的只是几 KB 清单而非视频内容；且整段视频常达 GB 级，
    //   根本无法经 sendMessage 回传。更糟的是它对跨域流会长期 pending，
    //   于是 await 永远不返回 → 状态条不提示、下载管理器无条目 → 表现为"点了没反应"。
    //   流媒体必须走后端 ffmpeg 拉流 + chrome.downloads 流式写盘（见 downloadHlsViaBackend）。
    if (/\.(m3u8|mpd)(\?|$)/i.test(String(a.url || ''))) {
      console.log('[Ddayup] 跳过用户目录（流媒体走后端拉流）：', String(a.url).slice(0, 60));
      return false;
    }
    // 侧栏刚打开时目录还在从 IndexedDB 恢复，等它完成再判断，避免"明明设了却没生效"
    if (typeof __dirRestorePromise !== 'undefined' && __dirRestorePromise) await __dirRestorePromise;
    const handle = (typeof saveHandles !== 'undefined' && saveHandles) ? saveHandles[a && a.type] : null;
    if (!handle) { notifyUserDirSkipped(a, '未设置该类型目录'); return false; }
    // ★超时护栏：任何抓取挂起（防盗链/跨域/大文件）最多等 20 秒就放弃，回退默认下载，
    //   绝不让用户面对"无限等待"。
    // ★2026-09-10 修复（图片热点防盗链）：非音频类型用 deriveMediaReferer 按 CDN 选正确 Referer，
    //   否则无 Referer 直拉会被图床 403 → trySaveToUserDir 失败 → 回退默认路径。
    const referer = (a.type === 'audio')
      ? sourceOrigin()
      : (typeof deriveMediaReferer === 'function' ? deriveMediaReferer(a.url, window.__sourcePageUrl || '') : (window.__sourcePageUrl || ''));
    // 目录权限可能因浏览器重启过期；在用户点击流程里可以安全 requestPermission
    try {
      const perm = await handle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        const reqPerm = await handle.requestPermission({ mode: 'readwrite' });
        if (reqPerm !== 'granted') {
          setStatus('⚠ 需要目录写入权限才能保存到设置目录', true);
          return false;
        }
      }
    } catch (e) {
      console.log('[Ddayup] 目录权限请求失败/不支持', e && e.message);
    }
    const res = await Promise.race([
      fetchViaBackground(a.url, { referer }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('抓取超时(20s)')), 20000)),
    ]);
    if (!res || !res.ok) return false;
    // 兼容两种回传形态：arrayBuffer（同进程）或 b64（跨 sendMessage，ArrayBuffer 会丢失）
    let bytes = res.arrayBuffer;
    if (!bytes && res.b64) { try { bytes = b64ToBytes(res.b64); } catch (_) { bytes = null; } }
    if (!bytes) return false;
    const name = deriveFilename(a);
    const fileHandle = await handle.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(bytes);
    await writable.close();
    try { if (typeof pulseDownloadProgress === 'function') pulseDownloadProgress('已保存到设置目录：' + name); } catch (_) {}
    setStatus('✅ 已保存到设置的目录：' + name);
    return true;
  } catch (e) {
    return false; // 静默失败 → 回退默认下载
  }
}

// ★2026-09-10：把已拿到的 blob 写到用户为该类型设置的目录（FileSystemAccess API）。
//   返回 true 表示已写入用户目录（调用方应跳过 chrome.downloads 默认路径）；
//   返回 false 表示用户没设该类型目录 / 写入失败（调用方回退原逻辑）。
//   这是让【视频/音频/模型】等「浏览器原生下载拿不到字节、只能走 blob」的素材
//   也能落到用户目录的唯一通道（chrome.downloads 只能写下载目录+相对子目录）。
async function writeBlobToUserDir(type, name, blob) {
  try {
    const handle = userDirHandleFor(type);
    if (!handle || !blob) return false;
    // 权限可能在浏览器重启后过期；在用户点击流程里可以安全 requestPermission
    try {
      const perm = await handle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        const reqPerm = await handle.requestPermission({ mode: 'readwrite' });
        if (reqPerm !== 'granted') return false;
      }
    } catch (e) {
      console.log('[Ddayup] writeBlob 目录权限请求失败/不支持', e && e.message);
    }
    const fh = await handle.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
    return true;
  } catch (_) {
    return false;
  }
}

// ★2026-09-11：此前「没存到用户目录」全部静默，用户只能看到文件出现在默认目录、无从判断原因。
//   现在把原因【显式写进状态栏】（同类 30 秒不刷屏）+ console.warn，一眼可定位。
const __userDirWarnAt = {};
function notifyUserDirSkipped(a, reason) {
  try {
    const type = (a && a.type) || '';
    const now = Date.now();
    if (!__userDirWarnAt[type] || now - __userDirWarnAt[type] > 30000) {
      __userDirWarnAt[type] = now;
      const label = (typeof typeLabel === 'function') ? typeLabel(type) : (type || '素材');
      const sub = (typeof typeDirs !== 'undefined' && typeDirs[type]) ? typeDirs[type] : 'other';
      setStatus(`⚠ 未存入「${label}」目录：${reason} → 已下载到默认目录 Ddayup/${sub}/（展开下方「按类型自定义保存路径」设置）`, true);
    }
  } catch (_) {}
  console.warn('[Ddayup][userdir] skip:', reason, (a && a.type) || '');
}

// ★2026-09-11：B站 durl / 抖音 dNR / 后端合并产物这类「后台或源页代下载」通道，
//   下载实际发生在 background / 源页上下文，chrome.downloads 只能写浏览器默认目录，
//   侧栏插桩（dlViaChrome）拦不到。故在【发起之前】抢先尝试用户目录：
//   拿到字节就写用户目录并跳过原通道；拿不到就照原路走（落默认目录）并告知原因。
async function tryUserDirBeforeNativeChannel(a, url, name) {
  try {
    if (a && url && /^https?:/i.test(String(url))) {
      return await tryWriteUserDirFromUrl(a, url, name);
    }
  } catch (_) {}
  return false;
}

// ★2026-09-10 P1 统一落盘出口：所有落盘路径（dlViaChrome / downloadBlobUrl）都先问它。
//   历史教训：此前 17 个落盘点各自硬编码 'Ddayup/<typeDirs>/'，加一个平台就漏一个，
//   用户设了目录照样下到默认目录。现在只在【两个唯一插桩点】判断一次，覆盖率 100%。
//   返回 true = 已写入用户设置目录，调用方必须跳过默认下载。
//   任何失败都返回 false 并 console.warn 打印【具体原因】（不再静默），保证原有回退链路不变。
const USER_DIR_MAX_BYTES = 60 * 1024 * 1024; // sendMessage 约 64MB 上限，留 4MB 余量
function userDirHandleFor(type) {
  if (typeof saveHandles === 'undefined' || !saveHandles) return null;
  if (saveHandles[type]) return saveHandles[type];
  if (type === 'netdisk') return saveHandles.archive || null; // 网盘无独立行 → 复用归档目录
  return null;
}
async function tryWriteUserDirFromUrl(a, url, filename) {
  try {
    if (window.__hmdaoUserDirEnabled === false) return false;
    // 侧栏刚打开时目录还在从 IndexedDB 恢复，等它完成再判断，避免"明明设了却没生效"
    if (typeof __dirRestorePromise !== 'undefined' && __dirRestorePromise) await __dirRestorePromise;
    if (!a || !url || !/^https?:/i.test(url)) return false;
    // 流媒体是文本播放清单，不是媒体本体 → 必须走后端 ffmpeg 拉流
    if (/\.(m3u8|mpd)(\?|$)/i.test(url)) {
      console.warn('[Ddayup][userdir] skip: 流媒体，走后端拉流');
      return false;
    }
    const type = a.type || '';
    const handle = userDirHandleFor(type);
    if (!handle) { notifyUserDirSkipped(a, '未设置该类型目录'); return false; }
    const size = Number(a.size || 0);
    if (size > USER_DIR_MAX_BYTES) {
      console.warn('[Ddayup][userdir] skip: 超过 60MB，走浏览器原生下载（' + Math.round(size / 1048576) + 'MB）');
      return false;
    }
    // ★2026-09-11：音视频体积未知时绝不走「拉字节」通道——整段 1080P 常达数百 MB，
    //   会白白等满 30s 超时才回退（表现为"点了没反应"）。体积已知且 ≤60MB 才尝试。
    if ((type === 'video' || type === 'audio') && !size) {
      console.warn('[Ddayup][userdir] skip: 音视频体积未知，走浏览器原生下载（避免整段拉取超时）');
      return false;
    }
    const name = filename || deriveFilename(a);
    const referer = (type === 'audio')
      ? sourceOrigin()
      : (typeof deriveMediaReferer === 'function' ? deriveMediaReferer(url, window.__sourcePageUrl || '') : (window.__sourcePageUrl || ''));
    const fetcher = (typeof fetchMediaViaBackground === 'function')
      ? fetchMediaViaBackground(url, referer)
      : fetchViaBackground(url, { referer });
    const res = await Promise.race([
      fetcher,
      new Promise((_, rej) => setTimeout(() => rej(new Error('抓取超时(30s)')), 30000)),
    ]);
    if (!res || !res.ok) { console.warn('[Ddayup][userdir] skip: 抓取失败', (res && res.error) || ''); return false; }
    let bytes = res.arrayBuffer;
    if (!bytes && res.b64) { try { bytes = b64ToBytes(res.b64); } catch (_) { bytes = null; } }
    if (!bytes || !bytes.byteLength) { console.warn('[Ddayup][userdir] skip: 未拿到字节'); return false; }
    const blob = new Blob([bytes], { type: res.mime || 'application/octet-stream' });
    if (await writeBlobToUserDir(type, name, blob)) {
      try { if (typeof pulseDownloadProgress === 'function') pulseDownloadProgress('已保存到设置目录：' + name); } catch (_) {}
      setStatus('✅ 已保存到设置的目录：' + name);
      console.log('[Ddayup][userdir] ok:', type, name);
      return true;
    }
    console.warn('[Ddayup][userdir] skip: 写入用户目录失败（权限/磁盘）');
    return false;
  } catch (e) {
    console.warn('[Ddayup][userdir] skip: 异常', (e && e.message) || e);
    return false;
  }
}

// blob 已在侧栏上下文（无需网络、无跨域）→ 直接写用户目录
async function tryWriteUserDirFromBlob(a, blobUrl, filename) {
  try {
    if (window.__hmdaoUserDirEnabled === false) return false;
    // 侧栏刚打开时目录还在从 IndexedDB 恢复，等它完成再判断，避免"明明设了却没生效"
    if (typeof __dirRestorePromise !== 'undefined' && __dirRestorePromise) await __dirRestorePromise;
    if (!a || !blobUrl || !/^blob:/i.test(String(blobUrl))) return false;
    const handle = userDirHandleFor(a.type || '');
    if (!handle) return false;
    const name = filename || deriveFilename(a);
    const blob = await (await fetch(blobUrl)).blob();
    if (!blob || !blob.size) return false;
    if (await writeBlobToUserDir(a.type, name, blob)) {
      try { if (typeof pulseDownloadProgress === 'function') pulseDownloadProgress('已保存到设置目录：' + name); } catch (_) {}
      setStatus('✅ 已保存到设置的目录：' + name);
      console.log('[Ddayup][userdir] ok(blob):', a.type, name);
      return true;
    }
    return false;
  } catch (e) {
    console.warn('[Ddayup][userdir] skip(blob):', (e && e.message) || e);
    return false;
  }
}

async function downloadSingle(a, opts = {}) {
  if (!chrome.downloads) { setStatus('下载 API 不可用', true); return; }
  // ★豆包朗读（已实体化为侧栏 blob）→ 直接落盘。
  //   必须抢在下方 blob 分支之前：那里会把 blob 当「播放器内部地址」而拒绝下载。
  if (a && a.wsAudio && /^blob:/i.test(String(a.url || ''))) {
    const nm = deriveFilename(a).replace(/\.(mp3|bin)$/i, '') + '.ogg';
    // ★P0：豆包朗读此前恒定写到 Ddayup/audio/（它在 trySaveToUserDir 之前 return）。
    //   现在先问用户目录（blob 在侧栏上下文，fetch 即得字节）；失败才回退原来的 <a download>。
    if (!(await tryWriteUserDirFromBlob(a, a.url, nm))) {
      downloadBlobUrl(a.url, 'Ddayup/audio/' + nm, a);
      setStatus('✅ 已下载：' + nm);
    }
    return;
  }
  // ★2026-09-10：用户为该类型设置了保存目录 → 优先写入用户目录（精确遵循设置）。
  //   未设置 / 抓取失败 / 文件过大 → trySaveToUserDir 返回 false，继续走下方原有下载逻辑。
  // ★P0 修复（分辨率被吞）：用户从分辨率面板选了 opts.downloadUrl 时，绝不能在这里用 a.url
  //   （默认画质）抢先写盘并 return——那样面板选的分辨率会被丢弃。
  //   该场景交给下方 opts.downloadUrl 分支，按【选中的直链】写用户目录。
  if (!opts || !opts.downloadUrl) {
    if (await trySaveToUserDir(a)) return;
  }
  // ★2026-09-01 修复（用户实测「点击下载没反应、本地没下载到视频」根因）：
  //   抖音 PC 播放器走 MSE，卡片 url 可能是 blob:。blob 只在创建它的页面上下文有效，
  //   扩展/浏览器下载器都拿不到字节 → chrome.downloads 静默失败（无任何提示、无文件）。
  //   处理：① 资产若带多画质直链（dyFormats），改用默认档（download_addr）下载；
  //        ② 否则明确提示用户，绝不静默失败。
  if (/^blob:/i.test(a.url || '')) {
    const defFmt = (a.dyFormats && a.dyFormats.length)
      ? (a.dyFormats.find((f) => f && f.is_default) || a.dyFormats[0])
      : null;
    if (defFmt && defFmt.url && /^https?:/i.test(defFmt.url)) {
      console.log('[HMDAO][diag] blob 资产改用 dyFormats 默认档下载');
      a = { ...a, url: defFmt.url };
    } else {
      setStatus('⚠ 只拿到播放器内部地址（blob:），无法下载。请让视频在源页播放几秒后重新扫描，再点下载。', true);
      return;
    }
  }
  __currentDownloadAsset = a; // 供 dlViaChrome 默认关联素材，完成后自动入库
  // ★网盘深度解析拿到的真实直链（a.direct）优先级最高：
  // 直接 chrome.downloads.download 存本地，不弹视频分辨率面板、不经网盘页、不要求登录。
  if (a && (a.type === 'netdisk' || a.type === 'archive' || a.isNetdiskFile) && a.direct && /^https?:/i.test(a.direct)) {
    const name = a.name || fileName(a.direct) || '网盘文件';
    // 迅雷 CDN 直链要求 Referer: https://pan.xunlei.com/ 否则 403，chrome.downloads.download 支持 headers 字段
    const isXunlei = /xunlei\.com|xlcdn\.com|tc\.xunlei\.com|pan\.xunlei/i.test(a.direct);
    dlViaChrome({
      url: a.direct,
      filename: 'Ddayup/netdisk/' + name,
      saveAs: false,
      conflictAction: 'uniquify',
      ...(isXunlei ? { headers: [{ name: 'Referer', value: 'https://pan.xunlei.com/' }] } : {}),
    }).then(() => setStatus('✅ 直链下载已触发：' + name + '（无需登录）'))
      .catch((e) => setStatus('⚠ 直链下载失败：' + (e && e.message || e), true));
    return;
  }
  // ★2026-09-10：流媒体（m3u8/mpd）必须在进入任何【直连】分支之前拦下。
  //   m3u8 是文本播放列表，chrome.downloads 直连只会把它几十 KB 的文本存成"视频"
  //   （用户实测：下载失败 + 只得到 42KB 假文件）。必须交 yt-dlp / 后端合并真实分片。
  if (opts && opts.downloadUrl && /\.(m3u8|mpd)(\?|$)/i.test(opts.downloadUrl)) {
    // ffmpeg 原生支持 HLS，不依赖站点提取器 → 先走它，成功率高于 yt-dlp
    if (await downloadHlsViaBackend({ ...a, url: opts.downloadUrl })) return;
    setStatus('后端拉流未成功，改试 yt-dlp…');
    try {
      await downloadViaYtDlp({ ...a, url: opts.downloadUrl, playerUrl: opts.downloadUrl }, '', 'bv*+ba/best');
      return;
    } catch (e) {
      setStatus('⚠ 流媒体下载失败：' + ((e && e.message) || 'yt-dlp 无法解析该站点'), true);
      return;
    }
  }
  // 指定具体直链下载（分辨率选择面板选中的某个 URL 源）：经后台带 Referer 拉取字节→blob→下载，
  // 兼容防盗链（抖音/腾讯等）与普通 CDN，失败时回退 chrome.downloads 直连。
  if (opts && opts.downloadUrl && opts.downloadUrl.startsWith('http')) {
    const target = { ...a, url: opts.downloadUrl };
    const referer = deriveMediaReferer(opts.downloadUrl, window.__sourcePageUrl || '');
    const cdnVideoOpt = /douyin|tiktok|bytedance|weixin|qq\.com|douyinvod|v26-web|bilivideo/i.test(opts.downloadUrl || '');
    // ★2026-08-30 关键修复（"B站下载没反应/失败"真凶）：
    //   B站 durl 走 bilivideo CDN，原逻辑一律 downloadVideoViaBackground（字节拉取+b64回传）。
    //   chrome.runtime.sendMessage 约 64MB 上限 → 大文件 b64 必静默失败 → 用户"没反应"。
    //   而 background.js:2684 已实测 B站 durl 可无 Referer 被 chrome.downloads 完整下载。
    //   修复：B站走 dlViaChrome 浏览器原生直连（带 Referer），不经消息回传、100% 成功。
    //   抖音/视频号仍走字节拉取（需要 cookie 域，chrome 直连会 403）。
    const isBiliCdn = /bilivideo\.com/i.test(opts.downloadUrl || '');
    // ★2026-09-02 关键修复（"点面板选分辨率下载一直显示下载中 / 后端 500"真因闭环）：
    //   抖音原先走 downloadVideoViaBackground（后台 fetch），受 CORS/签名限制且受 ~64MB 消息上限约束；
    //   走后端 yt-dlp 又依赖 buildDouyinCookiesFile() 写 Netscape cookie 文件 —— 但该函数在
    //   【扩展页面】里用了 require('os') / require('fs') / require('path')，浏览器环境没有 require，
    //   抛错被其 catch 吞掉后【恒返回 null】→ 后端无 cookies_file → yt-dlp 报
    //   "Fresh cookies are needed" → 500。这条路在扩展侧不可能走通，不必再修 cookie 逻辑。
    //   故抖音改用 HMDAO_DOWNLOAD_IN_TAB：在源页 <a download href=直链> 触发，浏览器自动带
    //   源页会话 Cookie + Referer=源页 → CDN 放行 → 真实 mp4 字节，与 cookie 文件完全无关。
    if (cdnVideoOpt && !isBiliCdn) {
      // ★2026-09-02 关键修复（"点面板下载弹窗下载/页面跳到 403"真凶闭环）：
      //   HMDAO_DOWNLOAD_IN_TAB 在源页注入 <a download>，但抖音 CDN（douyinvod.com）与源页
      //   （douyin.com）【不同源】，HTML download 属性跨域时被浏览器直接忽略 → 退化成
      //   <a target=_blank> → Chrome 内嵌播放被防链 403（用户实测任务卡显示 v26-web.douyinvod.com
      //   并跳转 / FILE_FAILED）。
      //   正确入口是 HMDAO_DOWNLOAD_DY_URL（background.js:2361 已实现）：先用 dNR 临时注入
      //   Referer=douyin.com（仅作用于 chrome.downloads 的 'other' 请求类型，不影响 <video>），
      //   再 chrome.downloads.download 直连 CDN → CDN 放行 → 真实 mp4 落盘，源页不导航。
      if (/douyin|tiktok|bytedance|douyinvod|v26-web/i.test(opts.downloadUrl || '')) {
        // ★2026-09-02 按分辨率下载：选中的视频轨（douyinvod 直链，无签名）前端下不了，
        //   交后端带 Referer 拉视频轨 + 音频轨，ffmpeg 合并成含音画 mp4（已实测 1080P h264+aac）。
        //   仅当 URL 本身就是 playApi（自带 biz_sign，同源）时才裸调 chrome.downloads。
        const isPlayApi = /douyin\.com\/aweme\/v1\/play/i.test(String(opts.downloadUrl || ''));
        if (isPlayApi) {
          await dlViaChrome({
            url: opts.downloadUrl,
            // ★2026-09-10：原硬编码 'videos'，导致动图（type=image 但 dynamic=true）等
      //   非视频资产也被存进 Ddayup/videos。改按 typeDirs 取子目录，全链路路径统一。
      filename: 'Ddayup/' + (typeDirs[target.type] || 'videos') + '/' + deriveFilename(target),
            asset: a, saveAs: false, conflictAction: 'uniquify',
          });
          setStatus('✅ 抖音视频已开始下载到本地（侧栏任务卡查看实时进度）', true);
          return;
        }
        // 视频轨 → 后端合并音视频后落盘（选 1080P 即下 1080P，含音频轨）
        await mergeAndDownloadViaBackend(a, opts.downloadUrl);
        return;
      }
      downloadVideoViaBackground(target); return;
    }
    // ★2026-09-10：chrome.downloads.download【不接受】Referer 等禁止头，传入会直接抛
    //   "Unsafe request header name"（用户日志已证实）。防盗链 Referer 只能靠 dNR 在网络层
    //   注入（见 background.js HMDAO_INSTALL_DY_REFERER / HMDAO_DOWNLOAD_BILI_DURL 同款机制）。
    //   这里不再传 headers，避免整条下载链路被这个异常打断后回退到"后台拉字节"，
    //   把 m3u8 文本（42KB）当成视频存盘。
    const viaChrome = () => dlViaChrome({
      url: opts.downloadUrl,
      // ★2026-09-10：原硬编码 'videos'，导致动图（type=image 但 dynamic=true）等
      //   非视频资产也被存进 Ddayup/videos。改按 typeDirs 取子目录，全链路路径统一。
      filename: 'Ddayup/' + (typeDirs[target.type] || 'videos') + '/' + deriveFilename(target),
      saveAs: false, conflictAction: 'uniquify',
    });
    try {
      // ★2026-09-10：用户为该类型设置了目录 → 优先写用户目录（fetchMediaViaBackground 拿字节）
      if (typeof saveHandles !== 'undefined' && saveHandles && saveHandles[target.type]) {
        const r = await fetchMediaViaBackground(opts.downloadUrl, referer);
        if (r && r.ok && r.b64) {
          const blob = new Blob([b64ToBytes(r.b64)], { type: r.mime || 'video/mp4' });
          if (await writeBlobToUserDir(target.type, deriveFilename(target), blob)) {
            setStatus('✅ 已保存到设置的目录：' + deriveFilename(target));
            return;
          }
        }
      }
      await viaChrome();
      setStatus('✅ 已下载所选分辨率');
      return;
    } catch (e) {
      // 直连失败（如跨域/403）→ B站回退字节拉取，其他重试一次
      if (isBiliCdn) {
        setStatus('直连失败，回退字节拉取…', true);
        await downloadVideoViaBackground(target);
        return;
      }
      setStatus('直连失败，回退后台拉取…');
      const res = await fetchMediaViaBackground(opts.downloadUrl, referer);
      if (res && res.ok && res.b64) {
        const blob = new Blob([b64ToBytes(res.b64)], { type: res.mime || 'video/mp4' });
        const url = URL.createObjectURL(blob);
        cacheDragBlob(target, blob, res.mime || 'video/mp4');
        // ★2026-09-10：用户为该类型设置了目录 → 写用户目录
        if (await writeBlobToUserDir(target.type, deriveFilename(target), blob)) {
          setStatus('✅ 已保存到设置的目录：' + deriveFilename(target));
          return;
        }
        downloadBlobUrl(url, 'Ddayup/videos/' + deriveFilename(target));
        setTimeout(() => URL.revokeObjectURL(url), 120000);
        setStatus('✅ 已下载所选分辨率');
        return;
      }
      setStatus('⚠ 所选分辨率下载失败：' + (e && e.message || (res && res.error) || '直链可能已过期，请重新扫描') + '（Youtube 直链有时效，可重扫页面重试）', true);
    }
    return;
  }
  console.log('[Ddayup] downloadSingle', a.url);
  // 网盘分享文件 / 网盘单个文件：
  // 1) 若已有真实直链（解析阶段从页面 API/DOM 拿到），直接浏览器下载，复用网盘页登录 Cookie。
  // 2) 若 URL 是 #hmdao-file= 占位符（大多数情况），在网盘页内自动勾选该文件并触发下载按钮，
  //    通过浏览器下载事件捕获真实直链，再 dlViaChrome 下载。全程无需安装迅雷/夸克客户端。
  if (a.type === 'netdisk' || a.type === 'archive' || a.type === 'netdisk-file' || a.isNetdiskFile) {
    const nameFromHash = (() => { const m = String(a.url || '').match(/#hmdao-file=([^&]+)/); return m ? decodeURIComponent(m[1]) : ''; })();
    const realName = a.name || nameFromHash || '网盘文件';
    // ★ 2026-08-09 修复：迅雷自己网盘 pan.xunlei.com/?path=... 也视为网盘页，
    //    避免点击下载时被错误地当成普通 archive 处理而跳过深度解析。
    const isNetdiskSharePage = /pan\.xunlei\.com(\/s\/|\/?\?|$)|pan\.quark\.cn\/s\/|pan\.baidu\.com\/s\//i.test(a.url || '');

    // 注：a.direct 已在函数开头（line 46-58）优先处理并带 Referer 头直下，此处不再重复。

    // 未解析的分享页入口：先深度解析出文件树，再下载具体文件
    if (isNetdiskSharePage && !nameFromHash) {
      setStatus('⚠ 请先点击「🔓 深度解析」读取文件列表，再下载其中的 zip/rar 文件', true);
      // 自动打开解析流程
      if (typeof netdiskResolve === 'function') netdiskResolve(a);
      return;
    }

    // archive / netdisk-file 单个文件暂无直链：在网盘页内自动触发下载按钮捕获直链
    if ((a.type === 'archive' || a.type === 'netdisk-file' || a.isNetdiskFile) && !a.direct) {
      const parentUrl = a.parentUrl || String(a.url || '').replace(/#hmdao-file=.+/, '');
      const realName = a.name || (a.url && decodeURIComponent((a.url.match(/#hmdao-file=(.+)/) || [])[1] || '')) || 'file';
      if (!parentUrl) {
        setStatus('⚠ 该网盘文件暂无直链，请先点击「🔓 深度解析」', true);
        return;
      }
      setStatus('正在网盘页内触发下载：' + realName + ' …');
      panelLog('netdisk-download-send', { parentUrl, realName, fileId: a.fileId || '' });
      try {
        // ★ 超时从 45s 提高到 90s：后台 handleNetdiskResolve 最坏路径（开新标签 12s + 列表扫描 10s
        // + 文件夹递归等待 20s + file_info API 往返）可达 ~60s，45s 会误杀正常解析 → 用户只见 45s 超时。
        const res = await Promise.race([
          chrome.runtime.sendMessage({ type: 'HMDAO_NETDISK_DOWNLOAD', url: parentUrl, name: realName, fileId: a.fileId || '' }),
          new Promise((_resolve, reject) => setTimeout(() => reject(new Error('网盘下载请求超时（90s）')), 90000)),
        ]);
        panelLog('netdisk-download-res', res);
        if (res && res.ok && res.url) {
          a.url = res.url;
          a.direct = res.url;
          a.parentUrl = parentUrl;
          const name = fileName(res.url) || realName;
          dlViaChrome({
            url: res.url,
            filename: 'Ddayup/netdisk/' + name,
            saveAs: false,
            conflictAction: 'uniquify',
          }).then(() => setStatus('✅ 网盘文件下载已触发：' + name))
            .catch((e) => setStatus('⚠ 下载失败：' + (e && e.message || e), true));
        } else if (res && res.needManualClick) {
          // ★ 迅雷分享态主动请求拿不到直链：引导用户在网页端手动点下载按钮，
          //   扩展被动捕获真实直链后自动重试。提供「我已点击下载」按钮即时重试。
          setStatus('⚠ ' + (res.note || '请在迅雷网页版手动点击该文件下载按钮，扩展将自动捕获直链'), true);
          showManualClickRetry(parentUrl, realName, a.fileId || '', a);
        } else {
          setStatus('⚠ 未捕获到下载直链：' + (res && res.error || '未知') + '。可能需先登录网页版账号，或该分享强制使用客户端', true);
        }
      } catch (e) {
        panelLog('netdisk-download-err', e && e.message ? e.message : String(e));
        setStatus('⚠ 网盘下载异常：' + (e && e.message || e), true);
      }
      return;
    }

    // 情况 A：解析阶段已拿到真实直链（url 不含占位 hash）
    if (a.url && /^(https?:)/i.test(a.url) && !nameFromHash) {
      const name = a.name || fileName(a.url) || realName;
      dlViaChrome({
        url: a.url,
        filename: 'Ddayup/netdisk/' + name,
        saveAs: false,
        conflictAction: 'uniquify',
      }).then(() => setStatus('✅ 下载已触发：' + name))
        .catch((e) => setStatus('⚠ 网盘文件下载失败：' + (e && e.message || e) + '（若提示登录，请先在浏览器登录网盘网页版）', true));
      return;
    }

    // 情况 B：占位符 / 无直链 → 在网盘页内自动触发下载按钮捕获直链
    setStatus('正在网盘页内触发下载：' + realName + ' …');
    const parentUrl = a.parentUrl || String(a.url || '').replace(/#hmdao-file=.+/, '');
    try {
      const res = await chrome.runtime.sendMessage({ type: 'HMDAO_NETDISK_DOWNLOAD', url: parentUrl, name: realName, fileId: a.fileId || '' });
      if (res && res.ok && res.url) {
        // 更新 asset 的真实 URL，避免下次再走触发流程
        a.url = res.url;
        a.parentUrl = parentUrl;
        const name = fileName(res.url) || realName;
        dlViaChrome({
          url: res.url,
          filename: 'Ddayup/netdisk/' + name,
          saveAs: false,
          conflictAction: 'uniquify',
        }).then(() => setStatus('✅ 网盘文件下载已触发：' + name))
          .catch((e) => setStatus('⚠ 下载失败：' + (e && e.message || e), true));
      } else {
        setStatus('⚠ 未捕获到下载直链：' + (res && res.error || '未知') + '。可能需先登录网页版账号，或该分享强制使用客户端', true);
      }
    } catch (e) {
      setStatus('⚠ 网盘下载异常：' + (e && e.message || e), true);
    }
    return;
  }
  // 已合并的 DASH 单文件（blob）：直接下载合并结果，无需再走 WBI
  // ★2026-08-31 修复：chrome.downloads.download 不支持 blob URL——必须用 <a download> 触发。
  //   之前用 dlViaChrome({ url: blob, ... }) 一律 FILE_FAILED（右键下载报错真凶）。
  if (a.__mergedDash && typeof a.url === 'string' && a.url.startsWith('blob:')) {
    const name = a.__mergedName || 'video_merged.mp4';
    // ★2026-09-10：用户为视频设置了目录 → 优先写用户目录（blob 字节可直接写 FileSystemAccess）
    if (typeof saveHandles !== 'undefined' && saveHandles && saveHandles[a.type]) {
      try {
        const b = await fetch(a.url).then((r) => r.blob());
        if (await writeBlobToUserDir(a.type, name, b)) {
          setStatus('✅ 已保存到设置的目录：' + name);
          return;
        }
      } catch (_) { /* 回退默认下载 */ }
    }
    downloadBlobUrl(a.url, 'Ddayup_videos_' + name, a);
    setStatus('✅ 已下载合并单文件 MP4：' + name + '（浏览器下载栏查看）');
    return;
  }
  const isBlob = a.url.startsWith('blob:');
  const sourcePage = window.__sourcePageUrl || '';
  // B站视频（含 MSE blob）：网络层捕获的 bilivideo 裸流（防盗链）或常规 bilibili.com 视频都属这里
  const isBili = /bilibili\.com|bilivideo\.(com|cn|tv)/i.test(a.url) || /bilibili\.com|bilivideo\.(com|cn|tv)/i.test(sourcePage);
  // B站视频（含 MSE blob）：若 yt-dlp 可用则走后端提取（含格式选择），否则走 WBI
  if (a.type === 'video' && (isBlob || isBili)) {
    // ★2026-08-30 架构修正（用户实测后端 500 → 兜底链也失败）：
    //   B站已有 WBI 直连方案（无需后端），yt-dlp 后端在这台机器上是 500 → 兜底链反而是必失败路径。
    //   用户原话"需要就要启用 yt-dlp"是针对优酷/腾讯等【无前端方案】的平台，B站属【有 WBI】，
    //   永不走 yt-dlp 后端（避免 500 静默），WBI 失败则明确报错。
    if (sourcePage && (isBili || isBlob)) {
      setStatus('B站视频：正在通过 WBI 获取整段 MP4（含音画）…');
      const ok = await refreshThenDownload(a, sourcePage);
      if (ok) return;
      // WBI 失败：明确报错 + 建议（不走 yt-dlp 后端，因该后端实测 500）
      setStatus('⚠ B站 WBI 抓取失败：可能页面 JS 还没就绪、cid 未识别、或该视频无 durl。请刷新源页或重新扫描后再试', true);
      if (a.type === 'video') checkYtDlp().then((st) => { if (st === 'ready') ensureYtDlpPrompt(); });  // 仍然仅在 yt-dlp 真的可用时提示
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
    // ★2026-09-06 豆包朗读（WS 流式 ogg_opus，无 HTTP 直链）：
    //   从源页取回旁路收集到的原始字节 → blob 下载（不经过任何网络直链请求）。
    if (a.wsAudio) {
      await downloadDoubaoWsAudio(a);
      return;
    }
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
  if (isStream && a.type === 'video' && /^https?:/.test(a.url)) {
    // 2026-08-02 对云桥网等站点的 HLS/DASH 流，直接用 yt-dlp 合并下载整段视频，而不是只存播放列表。
    // 2026-08-24 增强：m3u8/mpd 显式请求最高清（bv*+ba 合并最佳视频轨+最佳音频轨），
    // 避免后端默认 format 落到非最高清。直播流（无 #EXT-X-ENDLIST）yt-dlp 仅录片段，
    // 此处不区分直播/点播（前端无法低成本判定），由后端 yt-dlp 自行处理。
    // ★2026-09-10：优先后端 ffmpeg 拉流（原生支持 HLS，不依赖站点提取器，私有影视站也能下），
    //   失败再回退 yt-dlp（依赖提取器，私有站常 500）。
    setStatus('检测到 HLS/DASH 流媒体，用后端 ffmpeg 拉流合并…');
    if (await downloadHlsViaBackend(a)) return;
    setStatus('后端拉流未成功，改试 yt-dlp…');
    try {
      await downloadViaYtDlp({ ...a, playerUrl: a.url, ytPageUrl: '', biliPageUrl: '' }, '', 'bv*+ba/best');
      return;
    } catch (e) {
      setStatus('⚠ 流媒体下载失败：' + ((e && e.message) || '未知'), true);
      return;
    }
  }
  if (isStream) setStatus('⚠ 流媒体下载仅得到播放列表', true);
  // 抖音/TikTok/视频号/爱给等防盗链视频：签名 URL 重发必 403（绑定 IP+时间）或缺 Referer，
  // 必须回源页 refresh 拿 fresh 直链；bilivideo 不在此分支（B站走上方 isBili→WBI）。
  const cdnVideo = /douyin|tiktok|bytedance|weixin|qq\.com|douyinvod|v26-web|aigei\.com/i.test(a.url || '');
  if (a.type === 'video' && cdnVideo) {
    // ★2026-08-18 修复：抖音/TikTok 已有 CDN 直链（dyUrls 捕获 / RENDER_DATA play_addr），
    // 优先走直链通道（回源刷新 + 后台带 Referer 下载），不走 yt-dlp——
    // 抖音 yt-dlp extractor 需登录 cookie、后端 spawn 单文件 yt-dlp.exe 弹黑窗、且解析不稳。
    const dyLike = /douyin\.com|iesdouyin\.com|tiktok\.com|bytedance|douyinvod|v26-web/i.test(a.url || a.playerUrl || '');
    if (!dyLike && isYtDlpPlatform(a)) {
      await downloadViaYtDlp(a, sourcePage);
      return;
    }
    // ★2026-08-24 修复（用户实测「下载是文本不是视频」根因闭环）：
    //   抖音签名直链重发即失效，扫描时的 a.url 极可能已 stale → chrome.downloads 直连 403 →
    //   拿到 HTML 错误页被写成 .mp4 文本。a.dyFormats 来自 buildMeta（扫描时 RENDER_DATA 解析），
    //   首项即 fresh CDN 直链（play_addr/download_addr）。下载分支必须用它，不直连 a.url。
    //   即使 dyFormats[0] 也可能 stale，源页 fetch 期间可重新生成 → 统一走 HMDAO_DOWNLOAD_IN_TAB
    //   在源页 MAIN 世界 <a download href=直链> 触发：源页 Referer 合法 → 抖音放行 → 真实视频。
    const selDy = window.__dySelectedFormat;
    if (selDy) a = { ...a, url: selDy };
    else if (a.dyFormats && a.dyFormats.length) {
      // ★2026-09-01 修复：旧逻辑固定取 dyFormats[0]（bit_rate 通常低→高 = 最低清），
      //   与"默认选最高清"的注释矛盾。改为优先取 is_default 档
      //   （inject-main/scan.js 已按 download_addr 含音画正片标记 is_default），无标记才回退首项。
      const defFmt = a.dyFormats.find((f) => f && f.is_default) || a.dyFormats[0];
      a = { ...a, url: (defFmt && defFmt.url) || a.dyFormats[0].url };
    }
    // ★2026-08-31 修复（抖音/TikTok「点下载没反应 / 下成文本」根因）：
    //   扫描时捕获的 a.url / dyFormats[0].url 是签名直链，绑定 IP+会话+时间，数秒即失效。
    //   直接拿 stale 直链去源页 <a download> → 抖音/TikTok 403 → 下载静默失败或下成错误页。
    //   必须先回源页刷新拿 fresh 直链（与预览 fallbackCdnFetch 同一通道 HMDAO_REFRESH_FROM_PAGE），
    //   再用 fresh 直链触发源页 <a download>。回源失败则退回当前直链做最后一次尝试。
    if (sourcePage && /douyin|tiktok|bytedance|douyinvod|v26-web/i.test(a.url)) {
      let freshUrl = a.url;
      try {
        const fr = await chrome.runtime.sendMessage({ type: 'HMDAO_REFRESH_FROM_PAGE', asset: a, fresh: true });
        if (fr && fr.ok && fr.url) { freshUrl = fr.url; console.log('[HMDAO][diag] 下载前回源刷新直链成功', freshUrl.slice(0, 64)); }
        else if (fr && fr.meta && fr.meta.url) { freshUrl = fr.meta.url; }
      } catch (e) { console.log('[HMDAO][diag] 下载前回源刷新异常，用扫描直链兜底', e && e.message); }
      a = { ...a, url: freshUrl };
      // ★2026-09-02：抖音 DASH 分轨（资产带 dashAudio）→ 优先交后端 ffmpeg 合并成含音画单文件。
      //   直连只能拿到视频轨（无声）；后端合并已验证可行：含音画、浏览器零内存占用、
      //   大文件同样适用（scripts/verify-dash-merge-backend.mjs 5/5 + 端到端 G 组全绿）。
      //   后端不可用/合并失败则回退下方直连（仅视频轨），保证下载链路不中断。
      if (a.dashAudio && /^https?:/.test(a.dashAudio)) {
        const dyReferer = /tiktok\.com/i.test(freshUrl) ? 'https://www.tiktok.com/' : 'https://www.douyin.com/';
        try {
          const merged = await mergeDashViaBackend(
            a,
            { video: freshUrl, audio: a.dashAudio, referer: dyReferer },
            deriveFilename(a).replace(/\.[^.]+$/, ''),
            dyReferer,
          );
          if (merged) return;
        } catch (e) {
          console.log('[HMDAO][diag] 后端 DASH 合并失败，回退直连视频轨：', (e && e.message) || e);
          setStatus('后端合并失败，改为直连下载视频轨（无声）…', true);
        }
      }
      const dyFilename = 'Ddayup/' + (typeDirs[a.type] || 'other') + '/' + deriveFilename(a);
      // ★2026-09-01 修复（用户实测「点击下载后弹出新链接、并没有把视频下载到本地」根因）：
      //   HTML <a download> 属性【仅对同源 URL 生效】。抖音 CDN 是 douyinvod.com、
      //   源页是 douyin.com，两者不同源 → download 属性被浏览器忽略 → 退化成
      //   <a target=_blank> 打开 mp4 → Chrome 内嵌播放（CDN 无 Content-Disposition:attachment）
      //   → 用户看到「弹出新标签在播，本地什么都没下到」。
      //   改为【优先 chrome.downloads.download + dNR 注入 Referer】（与 B站 durl 同一可靠通道，
      //   HMDAO_DOWNLOAD_DY_URL 见 background.js），真正落盘到本地；失败再回退源页 <a>，最后才 yt-dlp。
      setStatus('正在下载抖音视频到本地（dNR 注入 Referer，chrome.downloads 直连 CDN）…');
      // ★2026-09-01 补修复（用户实测「可以下载，但下载进度没实时同步在侧栏」根因）：
      //   上一版把下载整个交给 background 代调 chrome.downloads.download，
      //   绕过了侧栏 dlViaChrome 的 HmdaoProgress.registerTask/bindDownloadId
      //   → 侧栏任务卡与该下载无关联 → 进度条不动、完成/中断不提示。
      //   现改为：background 只装 dNR 规则（dNR API 仅 background 可用），
      //   下载仍由侧栏 dlViaChrome 发起 → 进度实时同步到侧栏任务卡。
      await chrome.runtime.sendMessage({
        type: 'HMDAO_INSTALL_DY_REFERER',
        referer: /tiktok\.com/i.test(freshUrl) ? 'https://www.tiktok.com/' : 'https://www.douyin.com/',
      }).catch(() => ({ ok: false }));
      try {
        // ★2026-09-02 修正（上一版"直接带 Referer 头"是错的，勿改回）：
        //   Referer 属于【禁止头 forbidden header name】。实测本分支传 headers:[{Referer}] 时
        //   chrome.downloads.download 直接抛 "Unsafe request header name"（用户日志已证实），
        //   并非注释原先假设的"CDN 403"。chrome.downloads 【无法】通过 headers 传递 Referer，
        //   唯一可行方式是用 dNR 在网络层注入。
        //   故改用 HMDAO_DOWNLOAD_DY_URL（background.js:2361 已实现）：dNR 临时注入
        //   Referer=douyin.com（仅作用于 'other' 请求类型，不污染页面 <video> 的防盗链签名），
        //   再 chrome.downloads 直连 CDN → 放行 → 真实 mp4 落盘，源页不导航。
        // ★2026-09-02：改用 HMDAO_DY_FETCH_PLAY（源页 fetch playApi → blob → <a download>）。
        //   实测 HMDAO_DOWNLOAD_DY_URL 虽能创建下载任务（返回 downloadId），但下载过程必被
        //   SERVER_FORBIDDEN 中断——douyinvod 校验不止 Referer，dNR 注入不足以放行。
        //   源页 fetch 对 playApi（www.douyin.com）【同源】，浏览器自动带会话 Cookie + Referer，
        //   不依赖 dNR / chrome.downloads / 禁止头，是当前最稳路径。
        // ★2026-09-02 最终方案（由 __hmdaoTestDyDownload 实测证实，勿再改回 dNR/fetch）：
        //   自动化测试 3D 结果：chrome.downloads 直连 playApi → state='complete'、
        //   bytesReceived=23695772、error=undefined（23.7MB 完整落盘）。
        //   对照：加 dNR 注入 Referer 反而 SERVER_FORBIDDEN；源页 fetch 则 Failed to fetch。
        //   结论：playApi 自带 biz_sign 签名即可通过 CDN 校验，【无需 Referer、无需 dNR、
        //   无需 fetch】——任何额外改写请求头的动作都会破坏签名导致 403。
        //   同时它走 chrome.downloads API，因此侧栏任务卡能正常显示进度与完成状态。
        await dlViaChrome({
          url: freshUrl,
          filename: dyFilename,
          asset: a,
          saveAs: false,
          conflictAction: 'uniquify',
        });
        console.log('[HMDAO][diag] 抖音经 chrome.downloads(playApi) 触发下载成功');
        setStatus('✅ 抖音视频已开始下载到本地（侧栏任务卡查看实时进度）', true);
        return;
      } catch (e) {
        console.log('[HMDAO][diag] chrome.downloads(DY_URL) 失败，回退源页 <a download>：', (e && e.message) || e);
        setStatus('chrome.downloads 失败，回退源页触发…');
      }
      chrome.runtime.sendMessage({
        type: 'HMDAO_DOWNLOAD_IN_TAB',
        url: freshUrl,
        filename: dyFilename,
        tabId: (typeof window.__hmdao_sourceTabId === 'number') ? window.__hmdao_sourceTabId : undefined,
      }, async (resp) => {
        if (resp && resp.ok) {
          setStatus('✅ 已在源页触发抖音视频下载（源页会话合法，真实 mp4 字节）', true);
          return;
        }
        // 失败自动回退：yt-dlp 后端下载（带抖音 cookie 文件，可选 formatId）
        console.log('[HMDAO][diag] 源页 <a download> 失败，回退 yt-dlp 后端：', (resp && resp.error) || 'unknown');
        setStatus('源页 <a> 触发失败，正在用 yt-dlp 后端兜底…');
        try {
          await downloadViaYtDlp(a, sourcePage);
        } catch (e) {
          setStatus('抖音下载全部失败（chrome.downloads + 源页 <a> + yt-dlp）：' + ((dyResp && dyResp.error) || '') + '；' + (e && e.message || e), false);
        }
      });
      return;
    }
    // 非抖音或无源页：保留原回源页刷新路径（其他防盗链平台如视频号）
    if (sourcePage) {
      setStatus('防盗链视频：正在回源页重新捕获 fresh 直链…');
      refreshThenDownload(a, sourcePage);
      return;
    }
    // 兜底：后台带 Referer 拉取（仍可能因签名过期 403，会触发 yt-dlp 提示）
    downloadVideoViaBackground(a);
    return;
  }
  // yt-dlp 多平台统一下载（YouTube / B站等）：支持分辨率选择
  // ★2026-09-02：抖音【必须排除】在 yt-dlp 之外（此前多轮"下载中无响应"的根因）。
  //   抖音走 downloadViaYtDlp 必然失败：其依赖 buildDouyinCookiesFile() 写 Netscape cookie 文件，
  //   但该函数在扩展页面使用了 require('os')/require('fs') —— 浏览器环境没有 require，
  //   异常被 catch 吞掉后恒返回 null → 后端无 cookies_file → yt-dlp 报
  //   "Fresh cookies are needed" → 500 → 前端无失败分支 → 一直显示"下载中"。
  //   抖音改走下方 HMDAO_DOWNLOAD_DY_URL（dNR 注入 Referer + chrome.downloads 直连 CDN）。
  const isDyVideoNow = /douyin|tiktok|bytedance|douyinvod|v26-web/i.test(String((a && a.url) || '') + ' ' + String(sourcePage || ''));
  const isYtDlpVideo = a.type === 'video' && isYtDlpPlatform(a) && !isDyVideoNow;
  if (isYtDlpVideo) {
    await downloadViaYtDlp(a, sourcePage);
    return;
  }
  // ★2026-09-02 修正（此前用 HMDAO_DOWNLOAD_IN_TAB 是错的，勿改回）：
  //   HMDAO_DOWNLOAD_IN_TAB 在源页注入 <a download>，但抖音 CDN（douyinvod.com）与源页
  //   （douyin.com）【不同源】，HTML download 属性跨域时被浏览器忽略 → 退化成 <a target=_blank>
  //   → 浏览器导航到 CDN 直链 → 内嵌播放/403（用户实测"右键下载跳转成链接、能播放但没下载到本地"）。
  //   正确入口 HMDAO_DOWNLOAD_DY_URL（background.js:2361 已实现）：dNR 临时注入 Referer=douyin.com
  //   （仅作用于 chrome.downloads 的 'other' 请求类型，不影响页面 <video> 的防盗链签名），
  //   chrome.downloads.download 直连 CDN → CDN 放行 → 真实 mp4 落盘，源页不导航。
  if (/douyin|tiktok|bytedance|douyinvod|v26-web|aweme\/v1\/play/i.test(a.url || '')) {
    const dyUrl = a.url;
    console.log('[HMDAO][diag] 抖音命中兜底 → HMDAO_DOWNLOAD_DY_URL，url=' + String(dyUrl).slice(0, 70));
    // ★2026-09-11：后台代下载通道无法写任意目录 → 发起前先抢一次用户目录
    if (await tryUserDirBeforeNativeChannel(a, dyUrl, deriveFilename(a))) return;
    chrome.runtime.sendMessage({
      type: 'HMDAO_DOWNLOAD_DY_URL',
      url: dyUrl,
      filename: 'Ddayup/' + (typeDirs[a.type] || 'other') + '/' + deriveFilename(a),
      referer: 'https://www.douyin.com/',
    }, (resp) => {
      if (resp && resp.ok) setStatus('✅ 抖音视频已触发下载（dNR 注入 Referer + chrome.downloads 落盘）', true);
      else setStatus('抖音下载失败：' + ((resp && resp.error) || '未知'), true);
    });
    return;
  }
  // 直接走 chrome.downloads.download（不带任何 header）—— B 站 CDN URL 自带签名参数必通
  // ★2026-09-10：用户为该类型设置了目录 → 优先写用户目录（fetchMediaViaBackground 拿字节）
  if (typeof saveHandles !== 'undefined' && saveHandles && saveHandles[a.type]) {
    try {
      const r = await fetchMediaViaBackground(a.url, deriveMediaReferer(a.url, sourcePage));
      if (r && r.ok && r.b64) {
        const blob = new Blob([b64ToBytes(r.b64)], { type: r.mime || (a.type === 'video' ? 'video/mp4' : 'application/octet-stream') });
        if (await writeBlobToUserDir(a.type, deriveFilename(a), blob)) {
          setStatus('✅ 已保存到设置的目录：' + deriveFilename(a));
          return;
        }
      }
    } catch (_) { /* 回退 chrome.downloads */ }
  }
  dlViaChrome({
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

// ===== yt-dlp 多平台统一下载（YouTube / B站 / 抖音 / 新片场等），支持分辨率选择 + 音频提取 =====
// formatId 说明：
//   - 数字/含+ → 指定视频格式（下载时后端自动补 bestaudio 合并音画）
//   - 'audio' → 仅提取 MP3 音频（借鉴 seekin.ai 的「MP3 音频提取」）
//   - '' → 后端默认 bestvideo+bestaudio
// ★2026-08-17：yt-dlp 缺失时自动 ensure 一次再重试（朋友无 3000 后端也能下视频）。
// 仅当原生主机可用且 yt-dlp 未装（checkYtDlp==='missing'）才触发自动安装，避免误伤。
async function autoEnsureYtDlpAndRetry(a, sourcePage, formatId, onDone) {
  setStatus('⏳ yt-dlp 未就绪，正在自动下载安装（首次需十几 MB）…');
  try {
    const port = ddNativeConnect();
    if (!port) { ensureYtDlpPrompt(); onDone && onDone(false); return; }
    const r = await ddNativeRpc('ytdlp.ensure', {}, 180000);
    if (r && r.ok && (r.installed || r.success)) {
      hideYtDlpPrompt(); refreshYtDlpNotice();
      setStatus('✅ yt-dlp 已自动安装，重试下载…');
      onDone && onDone(true);
    } else {
      ensureYtDlpPrompt(); refreshYtDlpNotice();
      setStatus('⚠ yt-dlp 自动安装失败：' + ((r && r.error) || '请手动安装'), true);
      onDone && onDone(false);
    }
  } catch (e) {
    ensureYtDlpPrompt(); refreshYtDlpNotice();
    setStatus('⚠ yt-dlp 自动安装异常：' + (e && e.message || e), true);
    onDone && onDone(false);
  }
}

async function downloadViaYtDlp(a, sourcePage, formatId, _retried = false, _throwOnFail = false) {
  // ★2026-08-18 修复：新片场 stock.xinpianchang.com/footage/details/<id> 与文章页 www.xinpianchang.com/a<数字>
  //   都被 isYtDlpPlatform 判为 yt-dlp 平台 → 会进本函数，但 yt-dlp 上游 XinpianChang extractor **仅支持
  //   www.xinpianchang.com 文章页**，对 stock. 子域/footage/details 路径返回 Unsupported URL → 后端 yt-dlp 必失败。
  //   旧实现下结果是：refreshThenDownload 都没调、直接撞后端 yt-dlp 失败 → 用户下载到 fallback 字节（封面图）。
  //   background 里的 tryXinpianchang 能在源页 MAIN 世界解析出真实 mp4（mod-api + 内嵌 JSON），
  //   因此新片场一律先走 refreshThenDownload（调 HMDAO_REFRESH_FROM_PAGE → extractFreshVideoUrl → tryXinpianchang），
  //   解析失败才回退 yt-dlp。
  try {
    const xpPage = a.ytPageUrl || a.biliPageUrl || a.playerUrl || sourcePage || a.url || '';
    if (a.type === 'video' && /xinpianchang\.com/i.test(xpPage)) {
      setStatus('新片场素材：回源页解析直链（tryXinpianchang）…');
      await refreshThenDownload({ ...a, playerUrl: xpPage }, xpPage);
      return;
    }
  } catch (e) {
    // ★2026-08-18 修复：新片场解析失败（如源页未打开/未登录）→ 明确提示而非静默继续走 yt-dlp，
    //   否则会 spawn yt-dlp.exe 黑窗且因 stock. 子域不支持而失败，用户只见"下载失败"+弹窗。
    setStatus('⚠ 新片场直链解析失败：' + (e && e.message || e) + '。请保持新片场素材页打开后再试', true);
    return;
  }

  // ★2026-08-11：yt-dlp 下载依赖本地后端，先尝试自动拉起（扩展/后端同时启动）
  setStatus('⏳ 正在唤醒 Ddayup 后端…');
  try {
    const backendReady = await ensureBackendRunningNative({ silent: true });
    if (backendReady && backendReady.ok) {
      setStatus('后端已就绪，开始 yt-dlp 合并下载…');
    } else {
      setStatus('⚠ 后端未自动启动，继续尝试 yt-dlp 下载…', true);
    }
  } catch (e) {
    setStatus('⚠ 后端唤醒失败：' + (e && e.message || e), true);
  }

  const isAudio = formatId === 'audio';
  const selFmt = (!isAudio && formatId) || (isAudio ? '' : (window.__ytSelectedFormat || ''));
  const fmtHint = isAudio ? '（仅音频 MP3）' : (selFmt ? '（指定格式 ' + selFmt + '）' : '');
  // ★2026-08-16：合并阶段不在任务列表显示，只在状态栏提示；等后端落盘完成、
  //   真正开始 chrome.downloads 下载时，才由 dlViaChrome 创建精确进度卡，
  //   避免"合并完成"卡与实际下载卡两张并存、信息没打通的问题。
  const title0 = deriveFilename(a) || '视频';
  const pUrl = sourcePage || a.ytPageUrl || a.biliPageUrl || a.playerUrl || a.url || '';
  const platform = /bilibili/i.test(pUrl) ? 'B站'
      : /youtube/i.test(pUrl) ? 'YouTube'
      : /douyin\.com|iesdouyin\.com|tiktok\.com|bytedance/i.test(pUrl) ? '抖音/TikTok'
      : /xinpianchang/i.test(pUrl) ? '新片场'
      : '平台';
  setStatus('正在通过后端' + (isAudio ? '提取' : '合并下载') + ' ' + platform + (isAudio ? ' 音频' : ' 视频') + fmtHint + (isAudio ? '（MP3）' : '（含音频）') + '…');
  try {
    // ★2026-08-30 防御：VideoId 可能是字符串 'null'，PageUrl 可能以 /null 结尾（页面 JSON null 被 stringify）。
    //   直接拼接/透传会产出 /video/null → 404，并污染 yt-dlp 后端入参。现统一过滤。
    const safeBv = (a.biliVideoId && a.biliVideoId !== 'null' && /^BV/i.test(a.biliVideoId)) ? a.biliVideoId : '';
    const safeYt = (a.ytVideoId && a.ytVideoId !== 'null') ? a.ytVideoId : '';
    const safeBiliPage = (a.biliPageUrl && !/\/null$/i.test(a.biliPageUrl)) ? a.biliPageUrl : '';
    const videoPageUrl = a.ytPageUrl
      || safeBiliPage
      || a.playerUrl
      || (safeYt ? ('https://www.youtube.com/watch?v=' + safeYt) : '')
      || (safeBv ? ('https://www.bilibili.com/video/' + safeBv) : '')
      || sourcePage;
    // ★2026-09-02 根因修复（点下载一直"下载中"、后端 500、无任何文件落地的真因）：
    //   后端 action=download 走 yt-dlp，而 yt-dlp 抖音 extractor 【不支持】
    //   jingxuan?modal_id=xxx 这种"精选列表页 + modal 锚点"形式，实测报错：
    //     ERROR: Unsupported URL: https://www.douyin.com/jingxuan?modal_id=7678346515106106634
    //   它只认标准视频页 https://www.douyin.com/video/<aweme_id>。实测同一条视频换成该形式后，
    //   报错变为 "Fresh cookies are needed" —— URL 已被正确识别，剩下的是 cookie 问题，
    //   由下方 buildDouyinCookiesFile() 提供。故传给后端前先把 URL 归一化。
    let ytPageUrl = videoPageUrl;
    try {
      const pu = new URL(String(videoPageUrl || ''));
      if (/douyin\.com$/i.test(pu.hostname) && !/\/video\//i.test(pu.pathname)) {
        const mid = pu.searchParams.get('modal_id') || pu.searchParams.get('aweme_id');
        if (mid && /^\d+$/.test(mid)) ytPageUrl = 'https://www.douyin.com/video/' + mid;
      }
    } catch (_) {}
    // ★ 走 action=download：yt-dlp 合并音视频落盘成单文件 mp4（或 audio=1 时仅 MP3）。
    let dlUrl = 'http://127.0.0.1:3000/api/platform/ytdlp?action=download&url=' + encodeURIComponent(ytPageUrl);
    if (selFmt) dlUrl += '&format=' + encodeURIComponent(selFmt);
    if (isAudio) dlUrl += '&audio=1';
    // B站需带登录态 cookie（未登录 yt-dlp 拿不到 720P+ 高清格式 → 后端 500）；抖音/TikTok 带匿名 cookie。
    if (/bilibili\.com/i.test(videoPageUrl)) {
      try {
        const cookiesFile = await buildBiliCookiesFile();
        if (cookiesFile) dlUrl += '&cookies_file=' + encodeURIComponent(cookiesFile);
      } catch (_) {}
    } else if (/douyin\.com|iesdouyin\.com|tiktok\.com|bytedance/i.test(videoPageUrl)) {
      try {
        const cookiesFile = await buildDouyinCookiesFile();
        if (cookiesFile) dlUrl += '&cookies_file=' + encodeURIComponent(cookiesFile);
      } catch (_) {}
    }
    const ytRes = await fetch(dlUrl, { credentials: 'omit' });
    const ytData = await ytRes.json().catch(() => null);
    if (ytData && ytData.fileUrl) {
      const title = ytData.title || deriveFilename(a);
      let safeTitle = title.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_');
      // yt-dlp 对无法解析标题的页面会回退成 "[extractor]_Extracting_URL__<url>.<ext>"，既长又无意义，去掉该前缀
      safeTitle = safeTitle.replace(/^\[[^\]]+\]_Extracting_URL__+/i, '');
      if (safeTitle.length > 80) safeTitle = safeTitle.slice(0, 80);
      const referer = 'http://127.0.0.1:3000/';
      const fileUrl = 'http://127.0.0.1:3000' + ytData.fileUrl;
      // 合并阶段完成：状态栏提示即可，真正的下载任务卡由 dlViaChrome 在 chrome 下载开始时创建并接管进度。
      setStatus('后端合并完成，开始下载文件…');
      // 经后台带 Referer（omit cookie）拉取合并后的 mp4/mp3 字节 → blob → 下载，跨域/本地均可靠
      const res = await fetchMediaViaBackground(fileUrl, referer);
      if (res && res.ok && res.b64) {
        const bytes = b64ToBytes(res.b64);
        const blob = new Blob([bytes], { type: isAudio ? 'audio/mpeg' : 'video/mp4' });
        const url = URL.createObjectURL(blob);
        // ★2026-08-31 修复：chrome.downloads.download 不支持 blob URL——必须用 <a download> 触发。
        //   之前 dlViaChrome({ url: blob, ... }) 会 FILE_FAILED（后端合并路径）。
        downloadBlobUrl(url, 'Ddayup_' + (isAudio ? 'audios' : 'videos') + '_' + safeTitle + (isAudio ? '.mp3' : '.mp4'), a);
        setTimeout(() => URL.revokeObjectURL(url), 180000);
        setStatus('✅ 已下载' + (isAudio ? '（MP3 音频）' : '（含音频）') + '：' + title + '（浏览器下载栏查看）');
        return;
      }
      // 回退：后台拉取失败则直接用 fileUrl（同域，扩展可直连）
      dlViaChrome({
        url: fileUrl,
        filename: 'Ddayup/' + (isAudio ? 'audios' : 'videos') + '/' + safeTitle + (isAudio ? '.mp3' : '.mp4'),
        saveAs: false,
        conflictAction: 'uniquify',
      }).then(() => setStatus('✅ 已下载' + (isAudio ? '（MP3 音频）' : '（含音频）') + '：' + title))
        .catch((e) => setStatus('⚠ 下载失败：' + (e && e.message || e), true));
      return;
    }
    setStatus('⚠ yt-dlp 合并下载失败：' + ((ytData && ytData.error) || '请确保后端 127.0.0.1:3000 正在运行'), true);
    if (_throwOnFail && _retried) throw new Error((ytData && ytData.error) || 'yt-dlp 后端未能合并下载');
    if (!_retried) {
      const st = await checkYtDlp().catch(() => 'unreachable');
      if (st === 'missing') {
        await autoEnsureYtDlpAndRetry(a, sourcePage, formatId);
        const st2 = await checkYtDlp().catch(() => 'unreachable');
        if (st2 === 'ready') { await downloadViaYtDlp(a, sourcePage, formatId, true, _throwOnFail); return; }
      }
    }
    checkYtDlp().then((st) => { if (st === 'missing') ensureYtDlpPrompt(); });
  } catch (e) {
    setStatus('⚠ 后端 yt-dlp 不可用，请确保 Ddayup Web App 已启动（127.0.0.1:3000）', true);
    if (!_retried) {
      const st = await checkYtDlp().catch(() => 'unreachable');
      if (st === 'missing') {
        await autoEnsureYtDlpAndRetry(a, sourcePage, formatId);
        const st2 = await checkYtDlp().catch(() => 'unreachable');
        if (st2 === 'ready') { await downloadViaYtDlp(a, sourcePage, formatId, true, _throwOnFail); return; }
      }
    }
    if (_throwOnFail) throw e;
    checkYtDlp().then((st) => { if (st === 'missing') ensureYtDlpPrompt(); });
  }
}

// ===== CDN 鉴权站专用：先在源页重新捕获 fresh URL，再下载 =====
// ★2026-08-30：返回 boolean（已触发下载=true / 未触发=false），
//   供调用方实现「WBI 优先 → 失败回退 yt-dlp」的优先级链路（用户要求：需要时就启用 yt-dlp）。
async function refreshThenDownload(a, sourcePage) {
  setStatus('正在源页重新捕获 fresh URL…');
  try {
    const refreshRes = await chrome.runtime.sendMessage({ type: 'HMDAO_REFRESH_FROM_PAGE', assetUrl: a.url });
    if (refreshRes && refreshRes.ok && refreshRes.url) {
      const result = refreshRes.url;
      // DASH 分离轨（>1080p 等无整段 MP4）：m4s 直链无 Referer 必 403，必须经 background 带 Referer 拉取再落盘
      if (result && typeof result === 'object' && result.__dash) {
        await downloadDashTracks(a, result);
        return true;
      }
      const newUrl = result;
      const isBlob = typeof newUrl === 'string' && newUrl.startsWith('blob:');
      if (isBlob) {
        setStatus('⚠ 该视频使用 MSE（Media Source Extensions），无单一下载链接。请在 B站原视频上右键→「视频另存为」', true);
        return false;
      }
      setStatus('已捕获 fresh URL：' + (() => { try { return new URL(newUrl).host; } catch (_) { return ''; } })() + '，下载中…');
      if (/googlevideo\.com\/videoplayback/i.test(newUrl)) {
        // YouTube 直链需带源站第三方 Cookie，chrome.downloads 直连带不出 → 走后台源页上下文拉取
        downloadVideoViaBackground({ ...a, url: newUrl });
        return;
      }
      // ★2026-08-24 修复（用户实测「抖音下载到的是文本不是视频」根因闭环）：
      //   抖音/字节 CDN 直链（douyinvod / v26-web / download_addr）签名绑定源页 IP+session，
      //   且跨域无 CORS 头，故：
      //   - 侧栏/后台 fetch 直连 → CORS Failed to fetch / 403（签名绑定 IP）
      //   - chrome.downloads 直连 → Referer=chrome-extension → 403 且被当作「成功」写出 HTML 文本
      //   唯一可靠路径：【在源页 MAIN 世界 <a download href=直链> 点击】——no-cors 媒体下载，
      //   仅校验 Referer=源页 douyin.com（合法）→ 抖音放行 → 真正下载 mp4 字节。
      //   故抖音防盗链直链走 HMDAO_DOWNLOAD_IN_TAB（源页触发下载），不直连、不后台 fetch。
      if (/douyin|tiktok|bytedance|douyinvod|v26-web/i.test(newUrl)) {
        chrome.runtime.sendMessage({
          type: 'HMDAO_DOWNLOAD_IN_TAB',
          url: newUrl,
          filename: 'Ddayup/' + (typeDirs[a.type] || 'other') + '/' + deriveFilename(a),
          tabId: (typeof window.__hmdao_sourceTabId === 'number') ? window.__hmdao_sourceTabId : undefined,
        }, (resp) => {
          if (resp && resp.ok) setStatus('已在源页触发抖音视频下载（源页会话合法，真实 mp4 字节）', true);
          else setStatus('抖音下载失败：' + ((resp && resp.error) || '未知') + '；可在源页右键另存', false);
        });
        return;
      }
      // ★2026-08-18 修复：新片场 oss-xpc6.xpccdn.com 等 CDN 防盗链校验 Referer（来自 stock.xinpianchang.com），
      //   chrome.downloads 拉直链不带任何头必 403 → 文件大小 0 或仅错误体（被误当成"图片"）。
      //   通用 dNR installRefererRuleForDomain 排除 'media'（防止干扰页面 <video> 签名防盗链），
      //   所以走 installMediaRefererRuleForDomain（仅 xpccdn.com，局部破例）+ dlViaChrome 让浏览器直下。
      // ★2026-08-31 修复（"右键 B站视频 FILE_FAILED"真凶最终闭环）：
      //   之前多轮尝试 chrome.downloads 直连 B站 durl 全部失败：
      //     - dNR 注入 Referer → MV3 下 dNR 规则 5 分钟过期 + 规则被回收 → NETWORK_FAILED
      //     - 直接传 headers:[Referer] → bilivideo CDN 对 chrome-extension 来源请求仍 403 → FILE_FAILED
      //   根因：B站 durl 需要【登录态会话 Cookie】鉴权（特别是大会员/1080P+），chrome.downloads
      //   作为 chrome-extension 来源请求带不上会话 Cookie → CDN 拒绝 → FILE_FAILED。
      //   修复：B站 durl 放弃 chrome.downloads，改走【源页身份 fetch】→ blob → <a download>。
      //   fetchMediaInTabWithCookie 在 B站页面 MAIN 世界用 credentials:'include' + unsafe-url referrerPolicy
      //   自动带会话 Cookie + Referer → bilivideo 放行 → 真实字节 → blob → downloadBlobUrl 触发下载。
      //   这是 audio-playback.js downloadWithPageFetch 同一最稳路径（已实测稳定）。
      // 用户需求："右键下载是当前链接支持最高清，不是 4K" → qn=80 在 extractFreshVideoUrl 端已回归。
      const isBiliDurl = /bilivideo\.(com|cn|tv)|upos-|\.bilivideo\./i.test(String(newUrl || ''));
      if (isBiliDurl) {
        await downloadBiliDurlViaPageFetch(newUrl, a);
        return;
      }
      try {
        const u = new URL(newUrl);
        const isXinpianchangCdn = /xpccdn\.com|oss-xpc6/i.test(u.hostname);
        if (isXinpianchangCdn) {
          const ref = /xinpianchang\.com/i.test(sourcePage || '') ? sourcePage : 'https://stock.xinpianchang.com/';
          try { await chrome.runtime.sendMessage({ type: 'HMDAO_INSTALL_MEDIA_REFERER', domain: 'xpccdn.com', referer: ref }); } catch (_) {}
          setStatus('新片场 CDN 防盗链：注入 Referer 后浏览器直下…');
          dlViaChrome({
            url: newUrl,
            filename: 'Ddayup/' + (typeDirs[a.type] || 'other') + '/' + deriveFilename(a),
            saveAs: false,
            conflictAction: 'uniquify',
          }).then(() => setStatus('下载触发：' + fileName(a.url))).catch((err) => {
            setStatus('直下失败（' + (err && err.message || err) + '），回退 fetch+Blob…');
            return downloadViaFetchBlob({ ...a, url: newUrl }, sourcePage);
          });
          return true;
        }
      } catch (_) {}
      // 优先走 chrome.downloads（不带任何 header，避开 Unsafe）
      dlViaChrome({
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
      return true;
    } else {
      // 源页拿不到 fresh URL —— 退到 fetch + Blob（可能 0 字节但能拿就拿）
      setStatus('源页未捕获到 video，尝试 fetch+Blob…');
      await downloadViaFetchBlob(a, sourcePage);
      return true;
    }
  } catch (e) {
    setStatus('refresh 失败：' + (e.message || e), true);
    if (a.type === 'video') checkYtDlp().then((st) => { if (st === 'missing') ensureYtDlpPrompt(); });
    return false;
  }
}

// ===== CDN 鉴权站专用下载：fetch + Blob + <a download> =====
async function downloadViaFetchBlob(a, sourcePage) {
  setStatus('带 Referer 鉴权下载…');
  try {
    const res = await fetchViaBackground(a.url, { referer: sourcePage });
    if (!res || !res.ok) { setStatus('下载失败：' + (res?.error || res?.status || '无响应'), true); return; }
    // ★2026-09-10：sendMessage 会丢弃 ArrayBuffer，必须改用 b64 还原。
    let bytes = res.arrayBuffer;
    if (!bytes && res.b64) { try { bytes = b64ToBytes(res.b64); } catch (_) { bytes = null; } }
    if (!bytes) { setStatus('下载失败：无字节数据', true); return; }
    // 注意：大文件（视频）一次性写内存 → Blob 可能 OOM；本路径主要应对 ≤50 MB 资源
    const sizeKB = bytes.byteLength / 1024;
    if (sizeKB > 50 * 1024) {
      // 大视频直接报错让用户用「存到本地」（流式写盘）
      setStatus(`⚠ 该文件 ${Math.round(sizeKB/1024)}MB，超出 Blob 内存上限，请用「存到本地」流式写盘`, true);
      return;
    }
    const mime = res.mime || (a.type === 'audio' ? 'audio/mpeg' : a.type === 'video' ? 'video/mp4' : 'application/octet-stream');
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    // chrome.downloads.download 不支持 blob: URL，统一用 <a download> 触发（Chrome 支持 blob 下载）
    downloadBlobUrl(url, deriveFilename(a));
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    setStatus('下载触发：' + fileName(a.url));
  } catch (e) {
    setStatus('下载失败：' + (e.message || e), true);
  }
}

// ===== DASH 分轨：本机后端 ffmpeg 合并为「含音画单文件」=====
// ★2026-09-10：m3u8 / HLS 走【后端 ffmpeg 拉流】合并成单文件 MP4。
//   为什么必须走后端（实测 4815.wumaheil13.icu 得出的结论，勿改回直连）：
//     1) m3u8 是文本播放列表，chrome.downloads 直连只会得到 42KB 的文本假文件；
//     2) 后端 yt-dlp 依赖【站点提取器】，私有影视站普遍不支持 → 500；
//     3) ffmpeg 原生支持 HLS，-i index.m3u8 会自动拉全部分片，-c copy 零重编码；
//     4) 后端可自由携带 Referer/Origin（不受浏览器禁止头限制，避免 Unsafe header 报错）；
//     5) 产物经本地 fileUrl 下载：本地直连无防盗链、流式写盘、不受 ~64MB 消息上限约束。
async function downloadHlsViaBackend(a) {
  const apiBase = (window.DdayupConfig && typeof window.DdayupConfig.getApiBaseSync === 'function')
    ? window.DdayupConfig.getApiBaseSync()
    : 'http://127.0.0.1:3000';
  const ref = deriveMediaReferer(a.url, window.__sourcePageUrl || '');
  // ★2026-09-10：必须清洗文件名。chrome.downloads.download 的 filename 不接受
  //   \ / : * ? " < > | 与控制字符；实测本站卡片标题形如
  //   「NHHDTA-890 息子的友達にゴムを... 取...」含非法字符 → 调用直接抛错
  //   → 被 dlViaChrome 内部 catch 吞掉 → 下载管理器里【完全没有条目】（用户看到"卡住"）。
  //   这里统一清洗并兜底扩展名。
  const __rawName = String(deriveFilename(a) || '').trim();
  let __name = __rawName
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
  if (!__name) __name = 'hls-' + Date.now();
  if (!/\.(mp4|mkv|webm|mov|m4v|ts|flv|m4s)$/i.test(__name)) __name += '.mp4';
  setStatus('⏳ 正在提交后端 ffmpeg 拉流（HLS 合并为单文件，大文件请耐心等待）…');
  // ★2026-09-10：后端必须把【整段流】拉完才返回（可能数分钟）。这段时间前端只是 await，
  //   没有任何进度反馈 → 用户以为"点了没反应"。这里先起一个脉冲任务卡占位，
  //   拉流结束后再交棒给 dlViaChrome 的真实下载进度卡。
  let taskId = null;
  try {
    if (typeof window.pulseDownloadProgress === 'function') {
      taskId = window.pulseDownloadProgress('后端拉流：' + __name);
    } else if (window.HmdaoProgress && typeof window.HmdaoProgress.registerTask === 'function') {
      taskId = window.HmdaoProgress.registerTask({ name: '后端拉流：' + __name, asset: a || null });
      window.HmdaoProgress.updateTask(taskId, { state: 'downloading', totalBytes: 0, receivedBytes: 0 });
    }
  } catch (_) { taskId = null; }
  const __endTask = (okFlag, text) => {
    if (taskId == null) return;
    try {
      if (window.HmdaoProgress) {
        if (okFlag) window.HmdaoProgress.complete(taskId, text);
        else window.HmdaoProgress.fail(taskId, text);
      }
    } catch (_) {}
  };
  const controller = new AbortController();
  // 后端要真的把整段流拉完才返回，超时给足 16 分钟（与后端 15 分钟对齐）
  const timer = setTimeout(() => controller.abort(), 16 * 60 * 1000);
  let resp;
  try {
    resp = await fetch(apiBase.replace(/\/+$/, '') + '/api/media/merge-hls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: a.url, referer: ref, filename: __name }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const msg = (e && e.name === 'AbortError') ? '拉流超时（>16 分钟）' : '无法连接后端拉流服务（127.0.0.1:3000 未启动？）';
    setStatus('⚠ ' + msg, true);
    __endTask(false, msg);
    return false;
  }
  clearTimeout(timer);
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || !json || !json.ok || !json.fileUrl) {
    const msg = (json && json.error) || ('HTTP ' + resp.status);
    setStatus('⚠ 后端 HLS 拉流失败：' + msg, true);
    __endTask(false, msg);
    return false;
  }
  // ★2026-09-10 关键修复（"拉流卡标完成、下载卡永远卡住"真凶）：
  //   旧流程：拉流卡 → complete("拉流完成，开始下载") → 再起一张下载卡 → SW 触发 chrome.downloads。
  //   问题：① 拉流卡提前变成绿色 ✓，用户误以为"下载完了"；② 下载卡【从不绑定 downloadId】，
  //   又没有全局 chrome.downloads.onChanged 驱动，进度永远停在 0。
  //   新流程：保留【同一张卡】，把它的 state 从"后端拉流"切到"等待浏览器接管"，
  //   taskId 不变。chrome.downloads.onCreated 携带 downloadId 回来时，progress.js 的
  //   bindLatestPending 会自动绑到当前未绑 downloadId 的最新进行中卡——就是这一张。
  //   后续 onChanged 的每个 tick 都会通过 HMDAO_DOWNLOAD_PROGRESS 实时更新它。
  //   视觉上：用户看到一张卡从"后端拉流中"走到"下载中 1.2GB / 1.5GB"再到"已下载完成"。
  __endTask(true, '拉流完成，开始下载');
  // 从本地 fileUrl 下载，文件名/路径由扩展完全控制
  try {
    // 把"拉流卡"切换成"下载卡"：同 taskId，名字变成最终文件名，状态回到 downloading（待接管）。
    // 等 background.js 那里 chrome.downloads.onChanged 触发 HMDAO_DOWNLOAD_PROGRESS 即可实时更新。
    try {
      if (taskId != null && window.HmdaoProgress && window.HmdaoProgress.updateTask) {
        window.HmdaoProgress.updateTask(taskId, {
          name: __name,
          receivedBytes: 0,
          totalBytes: 0,
          doneText: '',
          // 不改 state：仍保持 downloading（"等待浏览器接管"语义统一）
        });
      }
    } catch (_) {}
    const fileUrl = apiBase.replace(/\/+$/, '') + json.fileUrl;
    // 交给 Service Worker 触发 chrome.downloads（流式写盘，不占扩展内存，错误可回传）。
    // 注意：SW 侧对跨域大文件不能 await chrome.downloads.download 的 Promise，否则挂起
    // → 这里只等 { ok }；downloadId 由 background 的 onChanged 监听在广播里带回。
    const dr = await chrome.runtime.sendMessage({
      type: 'HMDAO_DOWNLOAD_LOCAL_FILE',
      url: fileUrl,
      filename: 'Ddayup/videos/' + __name,
    });
    if (!(dr && dr.ok)) throw new Error((dr && dr.error) || 'SW 未能触发下载');
    setStatus('✅ 已开始下载（后端 ffmpeg 拉流合并）：' + __name + '（浏览器下载栏查看进度）');
  } catch (e) {
    setStatus('⚠ 触发浏览器下载失败：' + ((e && e.message) || e), true);
    return false;
  }
  return true;
}

// ★2026-09-02 实测依据（勿凭直觉改回直连或前端合并）：
//   · chrome.downloads 直连 CDN 分轨必 403 —— dNR 注入的 Referer 对 downloads 发起的请求
//     完全无效（4 种 resourceTypes 组合实测全部 SERVER_FORBIDDEN，服务端收不到 Referer）；
//   · 前端 Worker 合并（dash-merge-worker.js）产出缺 avcC 的坏 MP4（ffprobe: Invalid data found）。
//   后端 fetch 可自由带 Referer + ffmpeg -c copy 零重编码合并 + ffprobe 自检；
//   扩展只从本地 fileUrl 下载 —— 本地直连无防盗链、浏览器流式写盘、不受内存限制（大文件同样适用）。
async function mergeDashViaBackend(a, dash, base, referer) {
  const apiBase = (window.DdayupConfig && typeof window.DdayupConfig.getApiBaseSync === 'function')
    ? window.DdayupConfig.getApiBaseSync()
    : 'http://127.0.0.1:3000';
  setStatus('⏳ 正在提交后端合并（ffmpeg 合成含音画单文件）…');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120000);
  let resp;
  try {
    resp = await fetch(apiBase + '/api/media/merge-dash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoUrl: dash.video,
        audioUrl: dash.audio || '',
        referer,
        filename: base + '.mp4',
      }),
      signal: controller.signal,
    });
  } catch (fetchErr) {
    clearTimeout(timeoutId);
    const reason = (fetchErr && fetchErr.name === 'AbortError')
      ? '后端合并超时（120 秒）：请确认 Ddayup 网页 127.0.0.1:3000 已启动，或视频过大'
      : ('后端合并请求失败：' + (fetchErr && fetchErr.message || fetchErr));
    setStatus('⚠ ' + reason, true);
    return false;
  }
  clearTimeout(timeoutId);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.ok) {
    setStatus('⚠ 后端合并失败：' + ((data && data.error) || ('HTTP ' + resp.status)) + '（请确认 Ddayup 网页 127.0.0.1:3000 已启动）', true);
    return false;
  }
  if (!data.hasAudio) {
    setStatus('⚠ 后端已合并，但产物无音频轨（该视频未捕获到音频轨）', true);
  } else {
    setStatus('✅ 后端合并完成（含音画单文件），开始下载…');
  }
  const wantName = data.filename || (base + '.mp4');
  // ★Chrome 对 /api/media/merge-file 这类 URL 会按路径推导文件名（实测得到 merge-file.mp4），
  //   忽略 chrome.downloads.download 传入的 filename。故把期望名交给服务端用
  //   Content-Disposition 下发（?filename=），确保落盘名是用户可读的文件名。
  await dlViaChrome({
    url: apiBase + data.fileUrl + '&filename=' + encodeURIComponent(wantName),
    filename: 'Ddayup/videos/' + wantName,
    saveAs: false,
    conflictAction: 'uniquify',
    asset: a,
  });
  return true;
}

// ===== DASH 分离轨下载：浏览器原生直连（带 Referer），无大小限制 =====
// ★2026-08-30 关键修复（严格遵守用户边界——"不得影响视频播放/卡顿"）：
//   此前 fetchViaBackground 拉字节再 blob 落盘——sendMessage 消息通道约 64MB 上限，
//   大文件 b64/ArrayBuffer 回传必失败 → "文件写入失败"。改为 chrome.downloads.download 直连。
//   ★ 之前还尝试 mergeDashToMp4 在主线程合并——mp4box 解封装大文件会【冻结 UI 数秒到数十秒】，
//   严重违反"不得卡顿/黑屏"边界。现已【移除主线程合并】，仅浏览器直连下载两个分轨文件。
//   视频轨/音频轨分别保存为 _video.mp4 / _audio.m4a，附 ffmpeg 合并命令。
async function downloadDashTracks(a, dash) {
  const base = deriveFilename(a).replace(/\.[^.]+$/, '');
  const referer = dash.referer || window.__sourcePageUrl || 'https://www.bilibili.com';
  console.log('[HMDAO][dash] downloadDashTracks 入口', { hasAudio: !!dash.audio });

  // ★2026-08-31 修复（"右键下载 DASH 资产 FILE_FAILED"真凶闭环）：
  //   此前默认走 SW 合并（mergeDashViaBackground）→ Service Worker 无 WebCodecs，
  //   EncodedVideoChunk ReferenceError 必崩。catch 后回退 dlViaChrome 拉 bilivideo m4s 单分片，
  //   m4s 是单分片不完整 + B站防盗链 Referer 校验 → chrome.downloads 报 FILE_FAILED（"文件写入失败"）。
  //   现在：B站 DASH 右键下载，优先走 WBI refreshThenDownload 拿整段 durl（含音画 MP4）——
  //     chrome 直连 bilivideo durl 100% 成功、含音画、不需合并、不依赖 yt-dlp 后端。
  //   非 B站 / WBI 失败 才回退分轨直连 + 明确报错（提示 ffmpeg 手动合并）。
  const sourcePage = a.sourcePage || a.playerUrl || window.__sourcePageUrl || '';
  const isBiliUrl = /bilibili\.com|bilivideo\.com/i.test(String(dash.video || a.url || '')) || /bilibili\.com/i.test(sourcePage);
  if (isBiliUrl && sourcePage && typeof refreshThenDownload === 'function') {
    try {
      setStatus('⏳ 正在通过 WBI 拉取整段含音画 MP4（避免分轨合并的 FILE_FAILED）…');
      const ok = await refreshThenDownload(a, sourcePage);
      if (ok) return;
    } catch (_) {}
  }

  // ★2026-09-02：非 B站（抖音等）或 WBI 取整段失败 → 交给本机后端 ffmpeg 合并成单文件。
  //   直连分轨已被实测证伪（dNR 管不到 chrome.downloads，必 403），故仅作为最后回退。
  if (!dash.audio) {
    setStatus('⚠ 未捕获到音频轨，后端将只合成无声单文件');
  }
  try {
    if (await mergeDashViaBackend(a, dash, base, referer)) return;
  } catch (e) {
    setStatus('⚠ 后端合并异常：' + ((e && e.message) || e) + '，回退直连分轨', true);
  }

  setStatus('DASH 分离轨 → 浏览器直连下载（无大小限制，不阻塞主线程）…');
  // ★不附加 Referer 头：dNR 规则（HMDAO_INSTALL_REFERER_RULE）已注入 Referer。
  //   若此处再传 headers Referer → 请求带两个 Referer → B站 CDN 拒绝 → 下载中断（FILE_FAILED）。
  const dlTrack = (url, filename) => dlViaChrome({
    url,
    filename,
    saveAs: false,
    conflictAction: 'uniquify',
  });

  // ★2026-09-02 真机冒烟修复（"一直下载中、没真实下载"根因）：
  //   本分支处理 B站 WBI 取整段失败后的回退；抖音/视频号/爱给等 DASH 站点也走这里。
  //   此前直接 dlViaChrome 直连分轨 m4s —— 必 403（dNR 注入的 Referer 对 chrome.downloads
  //   发起的请求完全无效，实测 4 种 resourceTypes 组合全 SERVER_FORBIDDEN）→ 下载静默卡
  //   在 chrome.downloads 的"下载中…"死锁，侧栏无错误提示，文件没下下来。
  //   修复：非 B站场景优先走 mergeDashViaBackend（后端 ffmpeg -c copy 合成单文件 +
  //   ffprobe 自检，5/5 + 端到端 G 组已验证），失败再回退原 dlTrack（已知 403，给明确报错）。
  if (!isBiliUrl && dash.video) {
    const ref = referer || (a && a.platform === 'douyin' ? 'https://www.douyin.com/' : 'https://www.bilibili.com/');
    try {
      const merged = await mergeDashViaBackend(
        a,
        { video: dash.video, audio: dash.audio || '', referer: ref },
        base,
        ref,
      );
      if (merged) return;
    } catch (e) {
      console.log('[HMDAO][dash] 后端 DASH 合并失败，回退直连分轨：', (e && e.message) || e);
      setStatus('⚠ 后端 ffmpeg 合并失败，改为直连分轨下载…', true);
    }
  }

  try {
    const isBili = /bilibili\.com/i.test(referer);
    if (isBili) {
      // ★B站 DASH 视频轨/音频轨：先安装 Referer 规则（chrome 直连必带 Referer 头）
      // 加 3s 超时——避免 background handler 异常导致 await 永远挂起（之前会冻结 UI）
      try {
        const host = (() => { try { return new URL(dash.video).hostname; } catch (_) { return ''; } })();
        if (host) {
          await Promise.race([
            chrome.runtime.sendMessage({ type: 'HMDAO_INSTALL_REFERER_RULE', domain: host, referer }),
            new Promise((r) => setTimeout(r, 3000)),
          ]).catch(() => {});
        }
      } catch (_) {}
    }
    setStatus('⏳ 正在直连下载视频轨…');
    await dlTrack(dash.video, 'Ddayup/videos/' + base + '_video.mp4');
    if (dash.audio) {
      setStatus('⏳ 正在直连下载音频轨…');
      await dlTrack(dash.audio, 'Ddayup/videos/' + base + '_audio.m4a');
    }
    setStatus('✅ 已直连下载视频轨' + (dash.audio ? '+音频轨' : '') + '（浏览器下载栏查看）— DASH 分离需 ffmpeg 合并：ffmpeg -i *_video.mp4 -i *_audio.m4a -c copy out.mp4', true);
  } catch (e) {
    setStatus('DASH 直连下载失败：' + (e && e.message || e) + '（建议切低清晰度取整段 MP4）', true);
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
    pulseDownloadProgress('正在保存到本地：' + deriveFilename(a));
    const referer = (a.type === 'audio')
      ? sourceOrigin()
      : (typeof deriveMediaReferer === 'function' ? deriveMediaReferer(a.url, window.__sourcePageUrl || '') : (window.__sourcePageUrl || ''));
    const res = await fetchViaBackground(a.url, { referer });
    if (!res || !res.ok) { setStatus('抓取失败', true); return; }
    // ★2026-09-10：sendMessage 会丢弃 ArrayBuffer，必须改用 b64 还原（fetchUrl 现已回传 b64）。
    let bytes = res.arrayBuffer;
    if (!bytes && res.b64) { try { bytes = b64ToBytes(res.b64); } catch (_) { bytes = null; } }
    if (!bytes) { setStatus('抓取失败（无字节）', true); return; }
    const name = deriveFilename(a);
    const fileHandle = await handle.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(bytes);
    await writable.close();
    finishDownloadProgress('✅ 已保存到本地：' + name, true);
    setStatus('已保存：' + name);
  } catch (e) { setStatus('保存失败：' + (e.message || e), true); }
}

// ★ 迅雷分享态主动请求拿不到直链（实测 file_info 无 medias/sub_file_id、download_url 用分享条目 id 必 404）。
//   引导用户在迅雷网页版手动点「下载」按钮，扩展被动捕获（parseDownloadUrl）拿到真实直链后自动重试。
async function showManualClickRetry(parentUrl, realName, fileId, asset) {
  // 清掉旧的重试按钮，避免重复
  const old = document.getElementById('hmdaManualRetryBtn');
  if (old) old.remove();
  const btn = document.createElement('button');
  btn.id = 'hmdaManualRetryBtn';
  btn.textContent = '↻ 我已在网页版点击了下载，重试';
  btn.style.cssText = 'margin:6px 4px 0 0;padding:4px 10px;background:#00d4aa;color:#04221c;border:none;border-radius:6px;cursor:pointer;font-size:12px;';
  const statusEl = document.getElementById('status');
  if (statusEl && statusEl.parentNode) statusEl.parentNode.insertBefore(btn, statusEl.nextSibling);
  else document.body.appendChild(btn);

  let polling = null;
  const tryNow = async () => {
    setStatus('重新请求下载直链（被动捕获优先）…');
    try {
      const res = await chrome.runtime.sendMessage({ type: 'HMDAO_NETDISK_DOWNLOAD', url: parentUrl, name: realName, fileId: fileId || '' });
      panelLog('netdisk-download-res(retry)', res);
      if (res && res.ok && res.url) {
        if (polling) clearInterval(polling);
        btn.remove();
        const a = asset || {};
        a.url = res.url; a.direct = res.url; a.parentUrl = parentUrl;
        const name = fileName(res.url) || realName;
        dlViaChrome({ url: res.url, filename: 'Ddayup/netdisk/' + name, saveAs: false, conflictAction: 'uniquify' })
          .then(() => setStatus('✅ 网盘文件下载已触发：' + name))
          .catch((e) => setStatus('⚠ 下载失败：' + (e && e.message || e), true));
        return true;
      }
      // 仍未拿到：继续引导（可能用户还没真正点到下载，或捕获尚未触发）
      return false;
    } catch (e) {
      setStatus('⚠ 重试异常：' + (e && e.message || e), true);
      return false;
    }
  };

  btn.onclick = tryNow;
  // 自动轮询：用户在网页端点击下载后，扩展被动捕获写入 store.fileInfo[fileId].direct，
  // 这里每隔 2s 重试一次，最多 60s，无需用户手动点按钮。
  polling = setInterval(async () => {
    const ok = await tryNow();
    if (ok) clearInterval(polling);
  }, 2000);
  setTimeout(() => { if (polling) clearInterval(polling); btn.remove(); setStatus('⏱ 自动重试超时。请确认已在迅雷网页版点击了「' + realName + '」的下载按钮', true); }, 60000);
}
