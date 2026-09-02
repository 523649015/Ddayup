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
function dlViaChrome(opts) {
  const name = (opts.filename || '').split(/[\\/]/).pop() || '下载中…';
  const asset = opts.asset || __currentDownloadAsset || null;
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
    else window.HmdaoProgress.fail(dlId, 'FILE_FAILED');
    throw err;
  });
}

// chrome.downloads.download 不支持 blob: URL，统一用 <a download> 触发 blob 下载
// （blob 触发无进度事件，故用脉冲条提示「正在保存」）
function downloadBlobUrl(blobUrl, filename, asset) {
  const name = (filename || '').split(/[\\/]/).pop() || '下载中…';
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
async function downloadSingle(a, opts = {}) {
  if (!chrome.downloads) { setStatus('下载 API 不可用', true); return; }
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
    if (cdnVideoOpt && !isBiliCdn) { downloadVideoViaBackground(target); return; }
    pulseDownloadProgress('正在下载所选分辨率：' + deriveFilename(target));
    const viaChrome = () => dlViaChrome({
      url: opts.downloadUrl,
      filename: 'Ddayup/videos/' + deriveFilename(target),
      saveAs: false, conflictAction: 'uniquify',
      ...(referer ? { headers: [{ name: 'Referer', value: referer }] } : {}),
    });
    try {
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
    setStatus('检测到 HLS/DASH 流媒体，尝试 yt-dlp 合并下载最高清…');
    await downloadViaYtDlp({ ...a, playerUrl: a.url, ytPageUrl: '', biliPageUrl: '' }, '', 'bv*+ba/best');
    return;
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
        await dlViaChrome({
          url: freshUrl,
          filename: dyFilename,
          asset: a,
          saveAs: false,
          conflictAction: 'uniquify',
          // ★2026-09-02 修复（"点击下载弹出新链接、没下载到本地"的确切根因）：
          //   chrome.downloads.download 原生支持 headers（同文件 L151 迅雷分支、L175 B站分支
          //   都已在用），但【抖音分支漏传 Referer】→ CDN 403 → dlViaChrome 失败 → 回退
          //   源页 <a download> → 跨域使 download 属性失效 → Chrome 内嵌播放 = 弹出新标签。
          //   直接带 Referer 即可绕过防盗链：不依赖 dNR、不依赖后端，所有用户都可落盘。
          headers: [{
            name: 'Referer',
            value: /tiktok\.com/i.test(freshUrl) ? 'https://www.tiktok.com/' : 'https://www.douyin.com/',
          }],
        });
        setStatus('✅ 抖音视频已开始下载到本地（侧栏任务卡查看实时进度）', true);
        return;
      } catch (e) {
        console.log('[HMDAO][diag] chrome.downloads 失败，回退源页 <a download>：', (e && e.message) || e);
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
  const isYtDlpVideo = a.type === 'video' && isYtDlpPlatform(a);
  if (isYtDlpVideo) {
    await downloadViaYtDlp(a, sourcePage);
    return;
  }
  // 直接走 chrome.downloads.download（不带任何 header）—— B 站 CDN URL 自带签名参数必通
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
    // ★ 走 action=download：yt-dlp 合并音视频落盘成单文件 mp4（或 audio=1 时仅 MP3）。
    let dlUrl = 'http://127.0.0.1:3000/api/platform/ytdlp?action=download&url=' + encodeURIComponent(videoPageUrl);
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
  pulseDownloadProgress('正在拉取：' + deriveFilename(a));
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

// ===== DASH 分轨：本机后端 ffmpeg 合并为「含音画单文件」=====
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
  const resp = await fetch(apiBase + '/api/media/merge-dash', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      videoUrl: dash.video,
      audioUrl: dash.audio || '',
      referer,
      filename: base + '.mp4',
    }),
  });
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
    const res = await fetchViaBackground(a.url, a.type === 'audio' ? { referer: sourceOrigin() } : {});
    if (!res || !res.ok) { setStatus('抓取失败', true); return; }
    const name = deriveFilename(a);
    const fileHandle = await handle.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(res.arrayBuffer);
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
