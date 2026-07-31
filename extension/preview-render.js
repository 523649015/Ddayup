// ===== 预览子视图渲染（抽离自 openPreview 的 switch 分支）=====
// 依赖 sidepanel.js 全局：getAsset / loadImageViaRelay / fallbackCdnFetch / startDashPreview /
// fetchPlatformFormats / isYtDlpPlatform / buildVideoAltResolutions / buildDyFormatSelector /
// previewModel3D / previewArchiveEntries / setStatus / typeLabel / fileName / imgDimensions /
// escapeAttr / truncate，以及 audio-playback.js 的 playAudioInPage / stopHoverAudio / stopModelSandbox。
// 本文件在 sidepanel.js 与 audio-playback.js 之后加载（运行时由 openPreview 调用），纯物理拆分，行为零改变。

// ===== 图片预览 =====
function renderPreviewImage(a) {
  ensureDragData(a, true); // 预览即缓存字节，确保拖到桌面/文件夹能写出真实文件（File）
  document.getElementById('pvCopyImage').style.display = ''; // 图片可复制到系统剪贴板（微信 Ctrl+V）
  document.getElementById('previewInfo').textContent = '拖拽到微信/PS 不会被识别（Chrome 扩展限制），请点「📋 复制图片」后在微信按 Ctrl+V 粘贴。';
  document.getElementById('previewInfo').style.color = '#d29922';
  const pvImg = document.getElementById('previewImg');
  // ★动图直显：GIF/APNG 必须直连原 URL，若走后台 relay 取 blob 重编码会丢失动画 → 退化为静态帧。
  if (a.animated) {
    pvImg.src = a.url; // <img> 原生支持 GIF/APNG 动画，直显即保动画
    pvImg.style.display = '';
    return;
  }
  // ★根因修复：预览大图同样经后台 relay（omit）取 blob，避免侧栏直连第三方触发 Cookie 告警
  loadImageViaRelay(a.url, window.__sourcePageUrl).then((burl) => { pvImg.src = burl || a.url; });
  pvImg.style.display = '';
}

// ===== 视频预览 =====
function renderPreviewVideo(a) {
  // YouTube 视频：不再用 iframe embed（chrome-extension:// origin 导致 Error 153），
  // 改为从 ytBytes 读取播放器真实字节 → 强制 video/mp4 MIME → 直接播放；
  // 若 UMP 解码失败 → mp4box.js 转码为标准 MP4 → 兜底"在源页预览"链接。
  // 流程：isCdnProtected 命中 → HMDAO_REFRESH_FROM_PAGE → fallbackCdnFetch → ytBytes → play/remux
  {
    const isStream = /\.(m3u8|mpd)(\?|$)/i.test(a.url);
    const isCdnProtected = /bilibili\.com|youku\.com|v\.qq\.com|iqiyi\.com|youku\.com|cctv\.com|sohu\.com|mgtv\.com|bytedance|akamaized|cloudfront|alicdn|tiktok|migu\.cn|douyin|douyinvod|weixin|qq\.com|googlevideo|youtube/i.test(a.url)
                          || /bilibili\.com|youku\.com|v\.qq\.com|iqiyi\.com|douyin|weixin|youtube/i.test(window.__sourcePageUrl || '');
    const vid = document.getElementById('previewVideo');
    vid.style.display = '';
    window.__mergedDashBlobUrl = null;
    // 优先走 hls.js 处理流媒体
    if (isStream && window.Hls && Hls.isSupported()) {
      const hls = new Hls();
      hls.loadSource(a.url);
      hls.attachMedia(vid);
      window.__hlsInstance = hls;
      setStatus('流媒体播放中（m3u8/mpd）', true);
    } else if (isCdnProtected) {
      // 关键修复：B站等视频在侧栏里扫描到的是 MSE blob，直接 fetch/播放都跨源失败 → 预览黑屏。
      // 改为「预览时自动从源页 WBI 取真实 CDN 直链」再播放：
      //  · 整段 MP4（≤720p 含音画）：<video src> 直接播，Referer 由网络层 declarativeNetRequest 规则注入
      //  · DASH 分离轨（1080p+）：先播视频轨，再用 mp4box.js+mp4-muxer 合并音视频为单文件 MP4
      setStatus('正在从源页获取直链…');
      chrome.runtime.sendMessage({ type: 'HMDAO_REFRESH_FROM_PAGE', assetUrl: a.url }).then((r) => {
        if (r && r.ok && r.url) {
          if (typeof r.url === 'string') {
            if (r.url.startsWith('blob:')) { fallbackCdnFetch(a, vid); return; }
            // 防盗链直链：侧栏 <video> 直连缺 Referer/Cookie → 403。
            // 必须走后台 fetch（带 Referer+Cookie+dNR）→ blob 播放。
            // YouTube: googlevideo 需 youtube 会话 Cookie
            // 抖音/视频号: douyinvod/weixin 需平台 Referer
            // B站 durl: bilivideo CDN 实测可无 Referer 直连 → 直接 vid.src
            if (/googlevideo\.com|youtube\.com|douyin|douyinvod|tiktok|bytedance|weixin|qq\.com/i.test(r.url)) { fallbackCdnFetch(a, vid); return; }
            window.__previewAsset = { ...a, url: r.url };
            vid.src = r.url; vid.load(); vid.play().catch(() => {});
            setStatus('✅ 直链已就绪（Referer 已注入），点击播放');
          } else if (r.url && r.url.__dash) {
            startDashPreview(a, vid, r.url);
          }
        } else {
          fallbackCdnFetch(a, vid);
        }
      }).catch(() => fallbackCdnFetch(a, vid));
    } else if (isStream) {
      vid.src = a.url;
      setStatus('当前浏览器不支持 HLS 流播放，m3u8 仅得到播放列表文件', true);
    } else {
      vid.src = a.url;
    }
    buildVideoAltResolutions(a);
    // yt-dlp 平台：额外拉取格式列表支持分辨率选择
    if (isYtDlpPlatform(a)) fetchPlatformFormats(a);
    // 抖音：显示 RENDER_DATA 提取的多质量/编码版本
    if (a.dyFormats && a.dyFormats.length) buildDyFormatSelector(a.dyFormats);
  }
}

// ===== 音频预览 =====
function renderPreviewAudio(a) {
  // 以「源页身份」拉取带登录态的字节，用侧栏 <audio> 播放（手势有效）
  document.getElementById('pvPlay').style.display = '';
  playAudioInPage(a, { visual: true });
}

// ===== 3D 模型预览 =====
function renderPreviewModel(a) {
  document.getElementById('previewModelName').textContent = fileName(a.url);
  document.getElementById('previewModelUrl').textContent = a.url;
  document.getElementById('previewModel').style.display = '';
  window.__previewAsset = a; // previewModel3D 里的竞态检查需要先设好
  previewModel3D(a); // 异步：可渲染格式进 Three.js 视口，专有格式显示说明
}

// ===== 归档 / 网盘预览 =====
function renderPreviewArchive(a) {
  document.getElementById('previewArchiveName').textContent = fileName(a.url);
  document.getElementById('previewArchiveUrl').textContent = a.url;
  document.getElementById('previewArchive').style.display = '';
  window.__previewAsset = a;
  previewArchiveEntries(a); // 异步：zip 列出内部文件清单
}

// ===== 网盘（default 分支回退）=====
function renderPreviewNetdisk(a) {
  document.getElementById('previewArchiveName').textContent = (() => { try { return new URL(a.url).host; } catch (_) { return a.url; } })();
  document.getElementById('previewArchiveUrl').textContent = a.url;
  document.getElementById('previewArchive').style.display = '';
}
