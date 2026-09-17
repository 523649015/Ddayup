// ============================================================================
// Ddayup 扩展 — 截图识文 · 侧栏特性（features/screenshot-ocr.js）
// ----------------------------------------------------------------------------
// 经 window.FeatureManager.register(...) 自注册；由 feature-manager.js 在 DOMContentLoaded
// 时自动 init。不修改 sidepanel.js 主逻辑。
//
// 第二阶段（UI 整合层）改造点：
//   - 保留 #aiBotBtn 悬停 1s 兜底入口（robot 不在页时仍可用）；
//   - 优先把截图结果 / OCR 结果回传 robot-overlay（网页机器人浮标），失败回退侧栏面板；
//   - 复制改为在 active tab MAIN 世界执行（最可靠，可粘微信/QQ），失败降级侧栏；
//   - 保存走 chrome.downloads（F2）；长图框选 UI 在 robot-overlay 内实现（F3 UI）。
// ============================================================================
(function (root) {
  'use strict';
  const FM = root.FeatureManager;
  if (!FM) { console.error('[HMDAO][screenshot] FeatureManager 未加载'); return; }
  const MSG = root.HMDAO_MSG || {};

  function isRestrictedUrl(u) {
    if (!u) return false;
    if (/^(chrome:|chrome-extension:|chrome-untrusted:|edge:|devtools:|view-source:|data:)/i.test(u)) return true;
    if (/^about:/i.test(u) && !/^about:blank/i.test(u)) return true;
    try { const h = new URL(u).hostname; if (/chrome\.google\.com|chromewebstore\.google\.com/i.test(h)) return true; } catch (_) {}
    return false;
  }

  // ---- DOM 引用（init 时再取，确保 DOM 就绪）----
  let botBtn = null;
  let hoverTimer = null, hideTimer = null;
  let hotPanel = null, resultPanel = null;
  let pendingRect = null;   // 区域截图待裁切矩形
  let lastImage = null;     // 当前结果图 dataURL
  let regionListener = null;

  // robot-overlay 协调状态：收到 SCREENSHOT_OPEN 时置位，作为本次结果回传目标
  let robotPresent = false;
  let robotTabId = null;

  // ===== 悬停入口（兜底：robot 不在页时仍可触发）=====
  function showHotPanel() {
    if (!hotPanel) buildHotPanel();
    // 受限页检测：当前活动页不可截图则提示
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      const restricted = !tab || isRestrictedUrl(tab.url);
      hotPanel._notice.style.display = restricted ? 'block' : 'none';
      hotPanel._btns.style.display = restricted ? 'none' : 'flex';
      hotPanel.el.style.display = 'flex';
    });
  }
  function hideHotPanel() { if (hotPanel) hotPanel.el.style.display = 'none'; }

  function buildHotPanel() {
    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:9999;display:none;' +
      'flex-direction:column;gap:8px;background:#0f1620;border:1px solid #2a3a44;border-radius:14px;' +
      'padding:10px 12px;box-shadow:0 10px 30px rgba(0,0,0,.5);font:12px/1.5 system-ui,"PingFang SC","Microsoft YaHei",sans-serif;';
    const title = document.createElement('div');
    title.textContent = '🤖 截图识文';
    title.style.cssText = 'color:#9ecbff;font-weight:600;';
    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:8px;';
    const b1 = mkBtn('📐 区域截图');
    const b2 = mkBtn('📜 截长图');
    b1.onclick = () => { hideHotPanel(); startRegionCapture(); };
    b2.onclick = () => { hideHotPanel(); startLongCapture(); };
    btns.append(b1, b2);
    const notice = document.createElement('div');
    notice.textContent = '当前页面（chrome:// 等）不支持截图，请切换到普通网页';
    notice.style.cssText = 'color:#ffb4b4;display:none;max-width:240px;';
    el.append(title, btns, notice);
    el.addEventListener('mouseenter', () => { if (hideTimer) clearTimeout(hideTimer); });
    el.addEventListener('mouseleave', () => { hideTimer = setTimeout(hideHotPanel, 250); });
    document.body.appendChild(el);
    hotPanel = { el, btns, notice, _notice: notice, _btns: btns };
  }
  function mkBtn(label) {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'border:1px solid #30363d;background:#161b22;color:#c9d1d9;border-radius:9px;padding:7px 12px;cursor:pointer;font-size:12px;';
    return b;
  }

  // ===== 区域截图 =====
  function startRegionCapture() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || isRestrictedUrl(tab.url)) { toast('当前页面不支持截图'); return; }
      // 注入前先发清理消息，复位机制层守卫（修 B7：避免上次异常残留导致框不出现）
      chrome.tabs.sendMessage(tab.id, { type: MSG.SCREENSHOT_CANCEL }).catch(() => {});
      // 注入选区覆盖层（先发 messages.js 让注入脚本能用 HMDAO_MSG 常量）
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['shared/messages.js', 'features/screenshot-select-inject.js'],
      }).catch((e) => { toast('注入选区失败：' + (e && e.message || e)); });
      // 监听选区结果（一次性，确认才回传 REGION_READY；取消也清理，避免残留重复捕获 修 B6）
      if (regionListener) chrome.runtime.onMessage.removeListener(regionListener);
      regionListener = (msg) => {
        if (!msg || !msg.type) return;
        if (msg.type === MSG.SCREENSHOT_REGION_READY) {
          chrome.runtime.onMessage.removeListener(regionListener); regionListener = null;
          pendingRect = msg.payload;
          captureAndShow(tab.id, false);
        } else if (msg.type === MSG.SCREENSHOT_CANCEL) {
          // 用户取消框选：清理，避免 listener 永久残留导致下次重复捕获（修 B6）
          chrome.runtime.onMessage.removeListener(regionListener); regionListener = null;
          pendingRect = null;
          toast('已取消截图');
        }
      };
      chrome.runtime.onMessage.addListener(regionListener);
      toast('请在页面上拖拽框选区域…');
    });
  }

  // ===== 长截图 =====
  function startLongCapture() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || isRestrictedUrl(tab.url)) { toast('当前页面不支持截图'); return; }
      toast('正在生成长截图（滚动拼接中）…');
      chrome.runtime.sendMessage({ type: MSG.SCREENSHOT_CAPTURE_LONG, payload: { tabId: tab.id } }, (resp) => {
        onCaptured(resp, true);
      });
    });
  }

  function captureAndShow(tabId, long) {
    chrome.runtime.sendMessage(
      { type: long ? MSG.SCREENSHOT_CAPTURE_LONG : MSG.SCREENSHOT_CAPTURE, payload: { tabId } },
      (resp) => onCaptured(resp, long)
    );
  }

  // 截图完成：成功且 robot 在页 → 回传 robot；否则（受限/失败/robot 关闭）回退侧栏或 toast
  function onCaptured(resp, long) {
    if (!resp || resp.restricted) { notifyError('当前页面不支持截图（受限页）'); return; }
    if (!resp.ok) { notifyError('截图失败：' + (resp.error || '未知错误')); return; }
    const w = resp.width || null, h = resp.height || null;
    let img = resp.dataUrl;
    if (!long && pendingRect) {
      cropImage(img, pendingRect, (cropped) => { pendingRect = null; deliverResult(cropped, false, w, h); });
      return;
    }
    deliverResult(img, long, w, h);
  }

  // robot 在页时回传结果；sendMessage 失败（robot 已关闭）→ 回退侧栏面板
  function deliverResult(dataUrl, long, width, height) {
    if (robotPresent && robotTabId != null) {
      chrome.tabs.sendMessage(robotTabId, {
        type: MSG.SCREENSHOT_RESULT,
        payload: { dataUrl: dataUrl, isLong: !!long, width: width || null, height: height || null },
      }).catch((e) => {
        robotPresent = false; // robot 已关闭，回退侧栏
        showResult(dataUrl, long);
      });
      return;
    }
    showResult(dataUrl, long);
  }

  // robot 在页时回传错误提示；失败回退侧栏 toast
  function notifyError(text) {
    if (robotPresent && robotTabId != null) {
      chrome.tabs.sendMessage(robotTabId, { type: MSG.SCREENSHOT_ERROR, payload: { error: text } })
        .catch(() => { robotPresent = false; toast(text); });
      return;
    }
    toast(text);
  }

  // 按矩形裁切（自动用 截图尺寸/视口尺寸 修正缩放，规避 dpr 不确定）
  function cropImage(dataUrl, rect, cb) {
    const img = new Image();
    img.onload = () => {
      const vw = rect.vw || img.width, scale = img.width / vw;
      const sx = Math.max(0, Math.round(rect.x * scale));
      const sy = Math.max(0, Math.round(rect.y * scale));
      const sw = Math.min(Math.round(rect.w * scale), img.width - sx);
      const sh = Math.min(Math.round(rect.h * scale), img.height - sy);
      const c = document.createElement('canvas'); c.width = sw; c.height = sh;
      c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      cb(c.toDataURL('image/png'));
    };
    img.onerror = () => cb(dataUrl);
    img.src = dataUrl;
  }

  // ===== 结果面板（侧栏兜底；robot 在页时不显示，结果回传 robot）=====
  function showResult(dataUrl, long) {
    lastImage = dataUrl;
    if (!resultPanel) buildResultPanel();
    const img = resultPanel.img;
    img.src = dataUrl;
    img.style.maxHeight = long ? '50vh' : '38vh';
    resultPanel.textArea.value = '';
    resultPanel.textArea.style.display = 'none';
    resultPanel.copyText.style.display = 'none';
    resultPanel.el.style.display = 'flex';
  }

  function buildResultPanel() {
    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;right:12px;bottom:12px;z-index:9998;display:none;flex-direction:column;gap:8px;' +
      'width:300px;max-height:80vh;overflow:auto;background:#0f1620;border:1px solid #2a3a44;border-radius:14px;' +
      'padding:12px;box-shadow:0 10px 30px rgba(0,0,0,.5);font:12px/1.5 system-ui,"PingFang SC","Microsoft YaHei",sans-serif;';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;color:#9ecbff;font-weight:600;';
    head.textContent = '截图识文';
    const close = mkBtn('✕');
    close.style.padding = '4px 8px';
    close.onclick = () => { el.style.display = 'none'; };
    head.appendChild(close);
    const img = document.createElement('img');
    img.style.cssText = 'width:100%;border-radius:8px;background:#000;object-fit:contain;';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
    const bTranslate = mkBtn('🌐 翻译');
    const bExtract = mkBtn('📝 提取文字');
    const bCopy = mkBtn('📋 复制截图');
    const bSave = mkBtn('💾 保存本地');
    bTranslate.onclick = () => runOcr(lastImage, 'translate');
    bExtract.onclick = () => runOcr(lastImage, 'ocr');
    bCopy.onclick = () => copyImageInPage(null, lastImage);  // 优先 MAIN 世界复制
    bSave.onclick = () => saveImage(lastImage);
    row.append(bTranslate, bExtract, bCopy, bSave);
    const textArea = document.createElement('textarea');
    textArea.style.cssText = 'display:none;width:100%;height:120px;box-sizing:border-box;background:#0b1118;color:#c9d1d9;border:1px solid #2a3a44;border-radius:8px;padding:8px;font-size:12px;resize:vertical;';
    const copyText = mkBtn('复制文字');
    copyText.style.display = 'none';
    copyText.onclick = () => { if (textArea.value) navigator.clipboard.writeText(textArea.value).then(() => toast('已复制文字')); };
    el.append(head, img, row, textArea, copyText);
    document.body.appendChild(el);
    resultPanel = { el, img, textArea, copyText };
  }

  async function runOcr(dataUrl, task) {
    toast(task === 'translate' ? '正在翻译…' : '正在提取文字…');
    // 取设备标识与令牌，供后端授权闸口判定试用/订阅状态
    let deviceId = '', token = '';
    try {
      const s = await chrome.storage.local.get(['hmdaoDeviceId', 'hmdaoToken']);
      deviceId = s.hmdaoDeviceId || '';
      token = s.hmdaoToken || '';
    } catch (_) {}
    chrome.runtime.sendMessage({ type: MSG.SCREENSHOT_OCR, payload: { image: dataUrl, task, lang: 'zh', deviceId, token } }, (resp) => {
      // robot 在页：结果回传 robot（含 licenseRequired），侧栏仅负责 license 跳转
      if (robotPresent && robotTabId != null) {
        chrome.tabs.sendMessage(robotTabId, {
          type: MSG.SCREENSHOT_OCR_RESULT,
          payload: {
            text: (resp && resp.text) || '',
            error: (resp && resp.error) || '',
            licenseRequired: !!(resp && resp.licenseRequired),
          },
        }).catch(() => { robotPresent = false; renderOcrToSidePanel(resp); });
        if (resp && resp.licenseRequired && typeof window !== 'undefined' && window.HMDaoLicense) {
          window.HMDaoLicense.goToPricing(); // 侧栏上下文执行跳转
        }
        return;
      }
      renderOcrToSidePanel(resp);
    });
  }

  // 把 OCR 结果写到侧栏兜底面板
  function renderOcrToSidePanel(resp) {
    if (!resultPanel) return;
    if (resp && resp.ok) {
      resultPanel.textArea.value = resp.text || '';
      resultPanel.textArea.style.display = 'block';
      resultPanel.copyText.style.display = 'inline-block';
      toast('识别完成');
    } else if (resp && resp.licenseRequired) {
      resultPanel.textArea.value = (resp.error || '免费试用已结束') + '\n\n可点击「去订阅」继续使用。';
      resultPanel.textArea.style.display = 'block';
      resultPanel.copyText.style.display = 'none';
      if (typeof window !== 'undefined' && window.HMDaoLicense) window.HMDaoLicense.goToPricing();
      toast('试用已结束');
    } else {
      resultPanel.textArea.value = '识别失败：' + ((resp && resp.error) || '未知错误');
      resultPanel.textArea.style.display = 'block';
      resultPanel.copyText.style.display = 'none';
      toast('识别失败');
    }
  }

  // ===== 复制截图（修 B9：MAIN 世界执行，最可靠；失败降级侧栏）=====
  async function copyImageInPage(tabId, dataUrl) {
    let targetTab = (typeof tabId === 'number' && tabId >= 0) ? tabId : null;
    if (targetTab == null) { targetTab = await getActiveTabId(); }
    if (targetTab == null) { toast('复制失败：未找到目标标签页'); return; }
    const ok = await execCopyInPage(targetTab, dataUrl);
    if (ok) {
      toast('✅ 已复制截图，到微信按 Ctrl+V 粘贴');
      notifyCopyResult(true);
      return;
    }
    // 降级 1：侧栏文档内直接复制（需焦点）
    try {
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('✅ 已复制截图，到微信按 Ctrl+V 粘贴');
      notifyCopyResult(true);
      return;
    } catch (e2) {
      const hint = '复制失败，请点「保存本地」再用微信 Ctrl+V';
      toast(hint);
      notifyCopyResult(false, hint);
    }
  }

  // 在 active tab 的 MAIN 世界执行复制（返回 Promise<boolean>）
  function execCopyInPage(tabId, dataUrl) {
    return chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',
      func: (url) => {
        return fetch(url).then((r) => r.blob()).then((blob) => {
          return navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        }).then(() => true).catch(() => false);
      },
      args: [dataUrl],
    }).then((results) => {
      const r = results && results[0];
      return !!(r && r.result);
    }).catch(() => false);
  }

  // 复制结果回传 robot（复用 SCREENSHOT_ERROR 通道作 toast；ok 时带成功提示）
  function notifyCopyResult(ok, text) {
    if (!robotPresent || robotTabId == null) return;
    const msg = ok ? '✅ 已复制截图，到微信按 Ctrl+V 粘贴' : (text || '复制失败');
    chrome.tabs.sendMessage(robotTabId, { type: MSG.SCREENSHOT_ERROR, payload: { error: msg } })
      .catch(() => {});
  }

  // ===== 保存本地（chrome.downloads；data: URL 直下，避免 blob: 不被下载 API 支持的坑）=====
  function saveImage(dataUrl) {
    const filename = 'Ddayup-截图-' + Date.now() + '.png';
    if (!dataUrl) { toast('保存失败：无图片数据'); return; }
    // Chrome 的 downloads.download 不支持 blob: URL，必须用 data: URL（content script 内亦同）
    chrome.downloads.download({ url: dataUrl, filename: filename, saveAs: false })
      .then(() => toast('已保存到下载文件夹'))
      .catch((e) => toast('保存失败：' + (e && e.message || e)));
  }

  function getActiveTabId() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        resolve(tabs && tabs[0] && typeof tabs[0].id === 'number' ? tabs[0].id : null);
      });
    });
  }

  function toast(text) {
    const el = document.getElementById('status');
    if (el) { el.textContent = text; el.style.color = '#00d4aa'; }
  }

  // ===== 机器人协调消息已迁移至 background（screenshot-ocr-bg.js）=====
  // 侧栏仅保留 #aiBotBtn 悬停兜底入口（robot 不在页时直接本地协调），
  // 机器人发起的截图/长图/OCR/保存/复制统一由常驻 Service Worker 接收并回传，
  // 避免侧栏关闭后全部功能失效。

  // ===== 注册特性 =====
  FM.register({
    id: 'screenshot-ocr',
    title: '截图识文',
    enabled: () => root.FeatureManager ? root.FeatureManager.getFlag('screenshot-ocr') : Promise.resolve(true),
    init() {
      botBtn = document.getElementById('aiBotBtn');
      if (botBtn) {
        // 保留悬停 1s 兜底入口（robot 不在页时仍可用）
        botBtn.addEventListener('mouseenter', () => {
          if (hoverTimer) clearTimeout(hoverTimer);
          hoverTimer = setTimeout(showHotPanel, 1000);
        });
        botBtn.addEventListener('mouseleave', () => {
          if (hoverTimer) clearTimeout(hoverTimer);
          hideTimer = setTimeout(hideHotPanel, 250);
        });
      } else {
        console.warn('[HMDAO][screenshot] #aiBotBtn 不存在，跳过悬停入口');
      }
      console.log('[HMDAO][screenshot] 侧栏特性已初始化（悬停 1s 兜底入口；机器人协调已由 background 接管）');
    },
    teardown() {
      hideHotPanel();
      if (resultPanel) resultPanel.el.style.display = 'none';
      if (regionListener) { chrome.runtime.onMessage.removeListener(regionListener); regionListener = null; }
    },
  });
})(typeof self !== 'undefined' ? self : this);
