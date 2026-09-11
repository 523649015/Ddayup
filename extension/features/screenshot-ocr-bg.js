// ============================================================================
// Ddayup 扩展 — 截图识文 · 后台服务（features/screenshot-ocr-bg.js）
// ----------------------------------------------------------------------------
// 经 router.js 的 registerHandler(HMDAO_MSG.XXX, fn) 自注册到 HMDAO_HANDLERS，
// 由 background.js 顶部 importScripts 引入；不修改 background.js 主逻辑。
//
// 职责：
//   - SCREENSHOT_CAPTURE     ：当前视口 png 高保真截图（修复受限页静默异常 → 返回 restricted:true）
//   - SCREENSHOT_CAPTURE_LONG：长截图 = 滚动 + 逐视口 captureVisibleTab + OffscreenCanvas 拼接
//   - SCREENSHOT_OCR         ：把截图发 Ddayup 后端做 OCR/翻译（不传画布）
// ============================================================================
(function () {
  'use strict';

  const MSG = (typeof self !== 'undefined' && self.HMDAO_MSG) || {};
  const register = (typeof self !== 'undefined' && self.registerHandler) || function () {};

  // 受限页 scheme：extension 截图 API 必然失败，需提前识别并友好提示
  function isRestrictedUrl(url) {
    if (!url) return false;
    if (/^(chrome:|chrome-extension:|chrome-untrusted:|edge:|devtools:|view-source:|data:)/i.test(url)) return true;
    if (/^about:/i.test(url) && !/^about:blank/i.test(url)) return true;
    try {
      const h = new URL(url).hostname;
      if (/chrome\.google\.com|chromewebstore\.google\.com/i.test(h)) return true;
    } catch (_) {}
    return false;
  }

  async function getActiveTabId(payload) {
    if (payload && payload.tabId) return payload.tabId;
    try {
      const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
      return (t && t.id) || null;
    } catch (_) { return null; }
  }

  // 在目标页执行自包含函数并取回结果
  async function pageEval(tabId, func, args) {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args: args || [] });
    return res && res.result;
  }

  // ---- 视口截图（png 高保真）----
  async function captureViewport(tabId) {
    const tab = await chrome.tabs.get(tabId);
    if (!tab) return { ok: false, error: 'no-tab' };
    if (isRestrictedUrl(tab.url)) return { ok: false, restricted: true, url: tab.url };
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      if (!dataUrl) return { ok: false, error: 'empty' };
      return { ok: true, dataUrl, isLong: false };
    } catch (e) {
      // 某些受限页/无痕空白会抛错 —— 不再静默吞掉
      return { ok: false, restricted: isRestrictedUrl(tab.url), error: String((e && e.message) || e), url: tab.url };
    }
  }

  // ---- 长截图（滚动拼接）----
  async function captureLong(tabId) {
    const tab = await chrome.tabs.get(tabId);
    if (!tab) return { ok: false, error: 'no-tab' };
    if (isRestrictedUrl(tab.url)) return { ok: false, restricted: true, url: tab.url };

    const m = await pageEval(tabId, function () {
      return {
        sh: document.documentElement.scrollHeight,
        ih: window.innerHeight,
        iw: window.innerWidth,
        dpr: window.devicePixelRatio || 1,
        sy: window.scrollY,
      };
    }).catch(() => null);

    if (!m) return captureViewport(tabId); // 页面不可脚本化 → 退化为视口
    if (m.sh <= m.ih + 4) return captureViewport(tabId); // 无需滚动 → 直接视口

    try {
      const MAX = 65000; // OffscreenCanvas 单维上限保护
      const dpr = m.dpr;
      const totalH = Math.min(Math.floor(m.sh * dpr), MAX);
      const sliceH = Math.floor(m.ih * dpr);
      const slices = Math.max(1, Math.ceil(totalH / sliceH));
      const canvas = new OffscreenCanvas(Math.floor(m.iw * dpr), totalH);
      const ctx = canvas.getContext('2d');

      for (let i = 0; i < slices; i++) {
        const targetY = Math.floor((i * m.ih));
        await pageEval(tabId, function (y) { window.scrollTo(0, y); }, [targetY]);
        // 首片保留 fixed 头部；其余片隐藏 fixed/sticky，避免重复
        await pageEval(tabId, function (hide) {
          let s = document.getElementById('__hmdaoSsFixed');
          if (hide) {
            if (!s) { s = document.createElement('style'); s.id = '__hmdaoSsFixed'; document.documentElement.appendChild(s); }
            s.textContent = '*{position:fixed!important;position:sticky!important;visibility:hidden!important;}';
          } else if (s && s.parentNode) { s.parentNode.removeChild(s); }
        }, [i > 0]);
        await new Promise((r) => setTimeout(r, 320)); // 等懒加载 + 一帧

        const d = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        if (!d) continue;
        const blob = await (await fetch(d)).blob();
        const bmp = await createImageBitmap(blob);
        const drawY = Math.min(i * sliceH, totalH - bmp.height);
        if (drawY >= 0) ctx.drawImage(bmp, 0, drawY);
        bmp.close && bmp.close();
      }

      // 还原页面
      await pageEval(tabId, function () {
        window.scrollTo(0, 0);
        const s = document.getElementById('__hmdaoSsFixed');
        if (s && s.parentNode) s.parentNode.removeChild(s);
      });

      const outBlob = await canvas.convertToBlob({ type: 'image/png' });
      const buf = await outBlob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      const b64 = btoa(bin);
      return { ok: true, dataUrl: 'data:image/png;base64,' + b64, isLong: true, width: canvas.width, height: canvas.height };
    } catch (e) {
      console.warn('[HMDAO][screenshot] 长截图失败，退化为视口：', e && e.message);
      const vp = await captureViewport(tabId);
      if (vp && vp.ok) vp.degraded = true;
      return vp || { ok: false, error: String((e && e.message) || e) };
    }
  }

  // ---- OCR / 翻译：发 Ddayup 后端（需后端支持多模态图片输入）----
  async function ocrRequest(payload) {
    const image = payload && payload.image;
    const task = (payload && payload.task) || 'ocr';
    const lang = (payload && payload.lang) || 'zh';
    if (!image) return { ok: false, error: 'missing-image' };
    try {
      const tab = await (typeof findHmdaoTab === 'function' ? findHmdaoTab() : Promise.resolve(null));
      const base = (tab && tab.url) ? new URL(tab.url).origin : 'http://127.0.0.1:3000';
      const r = await fetch(base + '/api/extension-ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image, task, lang }),
      });
      const d = await r.json().catch(() => ({}));
      if (d && d.ok && typeof d.text === 'string') return { ok: true, text: d.text };
      // 后端未实现该接口 / 返回异常 → 明确提示（P0 阻塞项：后端需接入 /api/extension-ocr）
      return { ok: false, error: (d && (d.error || d.message)) || '后端暂不支持图片识别，请在 Ddayup 后端接入 /api/extension-ocr' };
    } catch (e) {
      return { ok: false, error: 'Ddayup 后端未响应，请确认 127.0.0.1:3000 已打开' };
    }
  }

  // ---- 注册处理器（自注册到 router.js 的 HMDAO_HANDLERS）----
  register(MSG.SCREENSHOT_CAPTURE, (msg, _sender, sendResponse) => {
    (async () => {
      const tabId = await getActiveTabId(msg && msg.payload);
      if (!tabId) { sendResponse({ ok: false, error: 'no-active-tab' }); return; }
      sendResponse(await captureViewport(tabId));
    })();
    return true;
  });

  register(MSG.SCREENSHOT_CAPTURE_LONG, (msg, _sender, sendResponse) => {
    (async () => {
      const tabId = await getActiveTabId(msg && msg.payload);
      if (!tabId) { sendResponse({ ok: false, error: 'no-active-tab' }); return; }
      sendResponse(await captureLong(tabId));
    })();
    return true;
  });

  register(MSG.SCREENSHOT_OCR, (msg, _sender, sendResponse) => {
    (async () => {
      sendResponse(await ocrRequest(msg && msg.payload));
    })();
    return true;
  });

  console.log('[HMDAO][screenshot] 后台处理器已注册：CAPTURE / CAPTURE_LONG / OCR');
})();
