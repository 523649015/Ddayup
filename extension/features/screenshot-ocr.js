// ============================================================================
// Ddayup 扩展 — 截图识文 · 侧栏特性（features/screenshot-ocr.js）
// ----------------------------------------------------------------------------
// 经 window.FeatureManager.register(...) 自注册；由 feature-manager.js 在 DOMContentLoaded
// 时自动 init。不修改 sidepanel.js 主逻辑。
//
// 能力：智能机器人(#aiBotBtn) 悬停 1s → 弹出「截图识文」入口（区域截图 / 截长图）
//   → 区域截图：注入选区覆盖层框选 → 后台 png 高保真截图 → 本地 Canvas 裁切
//   → 结果面板：翻译 / 提取文字 / 复制截图（复制到剪贴板，可粘微信）
//   截长图：后台滚动拼接整页 → 结果面板同上
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

  // ===== 悬停入口 =====
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
      // 注入选区覆盖层（先 messages.js 让注入脚本能用 HMDAO_MSG 常量）
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['shared/messages.js', 'features/screenshot-select-inject.js'],
      }).catch((e) => { toast('注入选区失败：' + (e && e.message || e)); });
      // 监听选区结果（一次性）
      if (regionListener) chrome.runtime.onMessage.removeListener(regionListener);
      regionListener = (msg) => {
        if (!msg || msg.type !== MSG.SCREENSHOT_REGION_READY) return;
        chrome.runtime.onMessage.removeListener(regionListener); regionListener = null;
        pendingRect = msg.payload;
        captureAndShow(tab.id, false);
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

  function onCaptured(resp, long) {
    if (!resp || resp.restricted) { toast('当前页面不支持截图（受限页）'); return; }
    if (!resp.ok) { toast('截图失败：' + (resp.error || '未知错误')); return; }
    let img = resp.dataUrl;
    // 区域截图：按框选矩形裁切
    if (!long && pendingRect) {
      cropImage(img, pendingRect, (cropped) => { pendingRect = null; showResult(cropped); });
      return;
    }
    showResult(img, long);
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

  // ===== 结果面板 =====
  function showResult(dataUrl, long) {
    lastImage = dataUrl;
    if (!resultPanel) buildResultPanel();
    const img = resultPanel.img;
    img.src = dataUrl;
    img.style.maxHeight = long ? '50vh' : '38vh';
    resultPanel.textArea.value = '';
    resultPanel.textArea.style.display = 'none';
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
    bTranslate.onclick = () => runOcr(lastImage, 'translate');
    bExtract.onclick = () => runOcr(lastImage, 'ocr');
    bCopy.onclick = () => copyImage(lastImage);
    row.append(bTranslate, bExtract, bCopy);
    const textArea = document.createElement('textarea');
    textArea.style.cssText = 'display:none;width:100%;height:120px;box-sizing:border-box;background:#0b1118;color:#c9d1d9;border:1px solid #2a3a44;border-radius:8px;padding:8px;font-size:12px;resize:vertical;';
    const copyText = mkBtn('复制文字');
    copyText.style.display = 'none';
    copyText.onclick = () => { if (textArea.value) navigator.clipboard.writeText(textArea.value).then(() => toast('已复制文字')); };
    el.append(head, img, row, textArea, copyText);
    document.body.appendChild(el);
    resultPanel = { el, img, textArea, copyText };
  }

  function runOcr(dataUrl, task) {
    toast(task === 'translate' ? '正在翻译…' : '正在提取文字…');
    chrome.runtime.sendMessage({ type: MSG.SCREENSHOT_OCR, payload: { image: dataUrl, task, lang: 'zh' } }, (resp) => {
      if (!resultPanel) return;
      if (resp && resp.ok) {
        resultPanel.textArea.value = resp.text || '';
        resultPanel.textArea.style.display = 'block';
        resultPanel.copyText.style.display = 'inline-block';
        toast('识别完成');
      } else {
        resultPanel.textArea.value = '识别失败：' + ((resp && resp.error) || '未知错误');
        resultPanel.textArea.style.display = 'block';
        resultPanel.copyText.style.display = 'none';
        toast('识别失败');
      }
    });
  }

  async function copyImage(dataUrl) {
    try {
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('✅ 已复制截图，到微信按 Ctrl+V 粘贴');
    } catch (e) {
      toast('复制失败：' + (e && e.message || e));
    }
  }

  function toast(text) {
    const el = document.getElementById('status');
    if (el) { el.textContent = text; el.style.color = '#00d4aa'; }
  }

  // ===== 注册特性 =====
  FM.register({
    id: 'screenshot-ocr',
    title: '截图识文',
    enabled: () => root.FeatureManager ? root.FeatureManager.getFlag('screenshot-ocr') : Promise.resolve(true),
    init() {
      botBtn = document.getElementById('aiBotBtn');
      if (!botBtn) { console.warn('[HMDAO][screenshot] #aiBotBtn 不存在，跳过悬停入口'); return; }
      botBtn.addEventListener('mouseenter', () => {
        if (hoverTimer) clearTimeout(hoverTimer);
        hoverTimer = setTimeout(showHotPanel, 1000);
      });
      botBtn.addEventListener('mouseleave', () => {
        if (hoverTimer) clearTimeout(hoverTimer);
        hideTimer = setTimeout(hideHotPanel, 250);
      });
      console.log('[HMDAO][screenshot] 侧栏特性已初始化（悬停 1s 入口已挂载）');
    },
    teardown() {
      hideHotPanel();
      if (resultPanel) resultPanel.el.style.display = 'none';
      if (regionListener) { chrome.runtime.onMessage.removeListener(regionListener); regionListener = null; }
    },
  });
})(typeof self !== 'undefined' ? self : this);
