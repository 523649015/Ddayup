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

  // 滚动后在页面内等待两帧 + 固定延时，确保懒加载图片 load 完成再截图（解 B11）
  async function waitForLazy(tabId) {
    await pageEval(tabId, function () {
      return new Promise((resolve) => {
        const finish = function () { resolve(); };
        requestAnimationFrame(function () {
          requestAnimationFrame(function () { setTimeout(finish, 300); });
        });
        setTimeout(finish, 800); // 兜底：后台标签 rAF 可能不触发
      });
    }).catch(function () {});
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
        clientW: document.documentElement.clientWidth, // 用于剔除滚动条宽度
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
      // 滚动条宽度（device px）：captureVisibleTab 含右侧滚动条，拼接时裁掉（解 B10）
      const sbW = Math.max(0, Math.floor((m.iw - m.clientW) * dpr));
      const canvasW = Math.max(1, Math.floor(m.iw * dpr) - sbW);
      const canvas = new OffscreenCanvas(canvasW, totalH);
      const ctx = canvas.getContext('2d');

      // 仅收集真正的 fixed/sticky 元素并打标记类；注入「只隐藏这些元素」的样式，
      // 绝不动其它元素的 position（修 B3：原通配符 * 把全页变 fixed+hidden 导致内容丢失）
      await pageEval(tabId, function () {
        document.documentElement.style.scrollBehavior = 'auto'; // 关平滑滚动，scrollTo 立即到位
        const all = document.querySelectorAll('*');
        for (let i = 0; i < all.length; i++) {
          const pos = getComputedStyle(all[i]).position;
          if (pos === 'fixed' || pos === 'sticky') all[i].classList.add('hm-fixed-tag');
        }
        const st = document.createElement('style');
        st.id = '__hmdaoSsFixedStyle';
        st.textContent = '.hm-fixed-hide{opacity:0!important;visibility:hidden!important;}';
        document.documentElement.appendChild(st);
      }).catch(function () {});

      for (let i = 0; i < slices; i++) {
        const maxY = Math.max(0, m.sh - m.ih);
        const targetY = Math.min(Math.floor(i * m.ih), maxY); // 末片对齐底部
        await pageEval(tabId, function (y) { window.scrollTo(0, y); }, [targetY]);

        // 首片保留 fixed 头部；其余片隐藏 fixed/sticky，避免每片重复出现
        const hide = i > 0;
        await pageEval(tabId, function (doHide) {
          const els = document.querySelectorAll('.hm-fixed-tag');
          for (let k = 0; k < els.length; k++) {
            if (doHide) els[k].classList.add('hm-fixed-hide');
            else els[k].classList.remove('hm-fixed-hide');
          }
        }, [hide]);

        await waitForLazy(tabId); // 等两帧 + 懒加载延时

        const d = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        if (!d) continue;
        const blob = await (await fetch(d)).blob();
        const bmp = await createImageBitmap(blob);
        const drawY = Math.min(i * sliceH, totalH - bmp.height); // 接缝对齐，clamp 到顶部（保留原逻辑）
        if (drawY >= 0) {
          // 裁掉右侧滚动条条带，仅绘制内容区
          const srcW = Math.max(1, bmp.width - sbW);
          ctx.drawImage(bmp, 0, 0, srcW, bmp.height, 0, drawY, srcW, bmp.height);
        }
        bmp.close && bmp.close();
      }

      const outBlob = await canvas.convertToBlob({ type: 'image/png' });
      const buf = await outBlob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      const b64 = btoa(bin);
      return {
        ok: true,
        dataUrl: 'data:image/png;base64,' + b64,
        isLong: true,
        width: canvas.width,
        height: canvas.height,
        totalW: canvas.width, // 供第二阶段 UI「框选区域」按钮使用
        totalH: canvas.height,
      };
    } catch (e) {
      console.warn('[HMDAO][screenshot] 长截图失败，退化为视口：', e && e.message);
      const vp = await captureViewport(tabId);
      if (vp && vp.ok) vp.degraded = true;
      return vp || { ok: false, error: String((e && e.message) || e) };
    } finally {
      // 无论成功失败都还原页面（滚动位置 / 隐藏样式 / 标记类 / 平滑滚动），避免遗留脏状态
      await pageEval(tabId, function (sy) {
        try {
          window.scrollTo(0, sy);
          const st = document.getElementById('__hmdaoSsFixedStyle');
          if (st && st.parentNode) st.parentNode.removeChild(st);
          const tagged = document.querySelectorAll('.hm-fixed-tag');
          for (let i = 0; i < tagged.length; i++) {
            tagged[i].classList.remove('hm-fixed-tag');
            tagged[i].classList.remove('hm-fixed-hide');
          }
          document.documentElement.style.scrollBehavior = '';
        } catch (_) {}
      }, [m.sy]).catch(function () {});
    }
  }

  // 解析后端地址：优先用扩展设置里配置的 apiBase（生产填 mingmingchuangyi.cn），
  // 否则回退到打开的 Ddayup 标签页 origin（本地联调），最后回退生产域名。
  async function resolveApiBase() {
    try {
      const s = await chrome.storage.local.get('ddayupApiBase');
      const v = s && s.ddayupApiBase;
      if (v && /^https?:\/\//.test(v)) return v.replace(/\/+$/, '');
    } catch (_) {}
    try {
      const tab = await (typeof findHmdaoTab === 'function' ? findHmdaoTab() : Promise.resolve(null));
      if (tab && tab.url) return new URL(tab.url).origin;
    } catch (_) {}
    return 'https://mingmingchuangyi.cn';
  }

  // 读取设备标识与令牌（与 license.js 同一套 storage key），供后端授权闸口判定
  async function getAuth() {
    try {
      const s = await chrome.storage.local.get(['hmdaoDeviceId', 'hmdaoToken']);
      return { deviceId: s.hmdaoDeviceId || '', token: s.hmdaoToken || '' };
    } catch (_) {
      return { deviceId: '', token: '' };
    }
  }

  // ---- OCR / 翻译：发 Ddayup 后端（后端已实现 /api/extension/ocr，自带授权闸口）----
  async function ocrRequest(payload) {
    const image = payload && payload.image;
    const task = (payload && payload.task) || 'ocr';
    const lang = (payload && payload.lang) || 'zh';
    if (!image) return { ok: false, error: 'missing-image' };
    const { deviceId, token } = await getAuth();
    try {
      const base = await resolveApiBase();
      const r = await fetch(base + '/api/extension/ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image, task, lang, deviceId, token }),
      });
      const d = await r.json().catch(() => ({}));
      if (d && d.ok && typeof d.text === 'string') return { ok: true, text: d.text };
      // 授权闸口拒绝（试用过期/未授权）/ 后端异常 → 透传错误信息
      if (d && d.code === 'LICENSE_REQUIRED') {
        return { ok: false, licenseRequired: true, error: d.message || '免费试用已结束，请订阅后使用' };
      }
      return { ok: false, error: (d && (d.error || d.message)) || ('后端返回异常（HTTP ' + r.status + '）') };
    } catch (e) {
      return { ok: false, error: 'Ddayup 后端未响应，请确认 apiBase 配置正确且服务在线' };
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

  // ============================================================================
  // 截图协调器（常驻 background，脱离侧栏独立工作）
  // ----------------------------------------------------------------------------
  // 根因：原协调逻辑放在侧栏（screenshot-ocr.js），用户关闭侧栏后机器人消息无人接收，
  //       导致「截图/识文/跟随/保存/复制/长图」全部静默失效。现把机器人发起的
  //       截图 / 长图 / OCR / 保存 / 复制 统一收口到 background（Service Worker 常驻），
  //       结果经 chrome.tabs.sendMessage(robotTabId, ...) 回传机器人浮标。
  // ============================================================================
  let robotTabId = null;       // 发起截图的机器人所在 tab（= sender.tab.id）
  let robotRegionPending = false; // 仅机器人发起的选区捕获进行中时才为 true

  // ★ MV3 关键：SW 可能在「注入选区 → 用户框选确认」的等待间隙被挂起，模块变量随之丢失。
  //   故把进行中状态落到 storage，REGION_READY 到达时若模块变量已失效则从 storage 恢复，
  //   保证侧栏关闭后区域截图仍能完成（长图/OCR/保存/复制无用户等待间隙，无需持久化）。
  const SS_STATE_KEY = 'hmdao:screenshot:state';
  function saveState(obj) { try { chrome.storage.local.set({ [SS_STATE_KEY]: obj }); } catch (_) {} }
  function loadState() {
    return new Promise((resolve) => {
      try { chrome.storage.local.get(SS_STATE_KEY, (o) => resolve((o && o[SS_STATE_KEY]) || null)); }
      catch (_) { resolve(null); }
    });
  }
  function clearState() { try { chrome.storage.local.remove(SS_STATE_KEY); } catch (_) {} }

  // 在 background 内按矩形裁切（device px = 视口截图 × scale，scale = 图宽 / 视口 CSS 宽）
  async function cropInBackground(dataUrl, rect) {
    try {
      const blob = await (await fetch(dataUrl)).blob();
      const bmp = await createImageBitmap(blob);
      const vw = rect.vw || bmp.width;
      const scale = bmp.width / vw;
      const sx = Math.max(0, Math.round(rect.x * scale));
      const sy = Math.max(0, Math.round(rect.y * scale));
      const sw = Math.min(Math.round(rect.w * scale), bmp.width - sx);
      const sh = Math.min(Math.round(rect.h * scale), bmp.height - sy);
      const c = new OffscreenCanvas(Math.max(1, sw), Math.max(1, sh));
      c.getContext('2d').drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
      if (bmp.close) bmp.close();
      const out = await c.convertToBlob({ type: 'image/png' });
      const buf = await out.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return 'data:image/png;base64,' + btoa(bin);
    } catch (e) {
      console.warn('[HMDAO][screenshot] 裁切失败，回退原图：', e && e.message);
      return dataUrl;
    }
  }

  function deliverResult(payload) {
    if (robotTabId != null) {
      chrome.tabs.sendMessage(robotTabId, { type: MSG.SCREENSHOT_RESULT, payload }).catch(() => {});
    }
  }
  function deliverToast(text) {
    if (robotTabId != null) {
      chrome.tabs.sendMessage(robotTabId, { type: MSG.SCREENSHOT_ERROR, payload: { error: text } }).catch(() => {});
    }
  }

  // 区域截图：注入选区层 → 等 REGION_READY → 截图 + 裁切 → 回传
  register(MSG.SCREENSHOT_OPEN, (msg, sender) => {
    const tabId = (sender && sender.tab && sender.tab.id) || (msg && msg.payload && msg.payload.tabId);
    if (typeof tabId !== 'number') return false;
    if (isRestrictedUrl(sender && sender.tab && sender.tab.url)) { deliverToast('当前页面不支持截图（受限页）'); return false; }
    robotTabId = tabId;
    const mode = (msg && msg.payload && msg.payload.mode) || 'region';
    if (mode === 'long') {
      captureLong(tabId).then((resp) => {
        if (resp && resp.ok) {
          deliverResult({ dataUrl: resp.dataUrl, isLong: true, width: resp.width, height: resp.height });
          deliverToast('长截图已生成');
        } else {
          deliverToast('长截图失败：' + ((resp && resp.error) || '未知错误'));
        }
      });
      return true;
    }
    // region：注入选区层（其自带 30s 超时守卫与重复注入拦截）
    robotRegionPending = true;
    saveState({ pending: true, robotTabId: tabId });
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['shared/messages.js', 'features/screenshot-select-inject.js'],
    }).catch((e) => {
      robotRegionPending = false;
      deliverToast('注入选区失败：' + (e && e.message || e));
    });
    return true;
  });

  // 选区就绪：仅接管机器人发起的捕获（侧栏自身 hover 入口的 REGION_READY 由侧栏监听，互不干扰）
  register(MSG.SCREENSHOT_REGION_READY, (msg, _sender, sendResponse) => {
    (async () => {
      let tabId = robotTabId;
      let pending = robotRegionPending;
      if (!pending) { const st = await loadState(); if (st && st.pending) { pending = true; tabId = st.robotTabId; robotTabId = tabId; } }
      if (!pending || typeof tabId !== 'number') { if (sendResponse) sendResponse({ ok: false }); return; }
      robotRegionPending = false;
      clearState();
      const rect = (msg && msg.payload) || {};
      const resp = await captureViewport(tabId);
      if (!resp || !resp.ok) { deliverToast('截图失败：' + ((resp && resp.error) || '未知错误')); return; }
      const cropped = await cropInBackground(resp.dataUrl, rect);
      deliverResult({ dataUrl: cropped, isLong: false, width: null, height: null });
    })();
    return true;
  });

  register(MSG.SCREENSHOT_CANCEL, async (msg) => {
    let pending = robotRegionPending;
    if (!pending) { const st = await loadState(); pending = !!(st && st.pending); }
    if (!pending) return false; // 非机器人选区取消，忽略（侧栏自身 hover 入口的取消不在此处理）
    robotRegionPending = false;
    clearState();
    deliverToast('已取消截图');
    return true;
  });

  // OCR / 翻译：发后端，结果回传机器人
  register(MSG.SCREENSHOT_OCR, (msg) => {
    const p = (msg && msg.payload) || {};
    if (!p.image) return false;
    ocrRequest(p).then((resp) => {
      if (robotTabId != null) {
        chrome.tabs.sendMessage(robotTabId, {
          type: MSG.SCREENSHOT_OCR_RESULT,
          payload: { text: (resp && resp.text) || '', error: (resp && resp.error) || '', licenseRequired: !!(resp && resp.licenseRequired) },
        }).catch(() => {});
      }
    });
    return false;
  });

  // 保存本地（content script 直连更可靠；此处为兜底，data: URL 直接下）
  register(MSG.SCREENSHOT_SAVE, (msg) => {
    const dataUrl = msg && msg.payload && msg.payload.dataUrl;
    if (!dataUrl) return false;
    const filename = 'Ddayup-截图-' + Date.now() + '.png';
    chrome.downloads.download({ url: dataUrl, filename: filename, saveAs: false })
      .then(() => deliverToast('已保存到下载文件夹'))
      .catch((e) => deliverToast('保存失败：' + (e && e.message || e)));
    return false;
  });

  // 复制截图（MAIN 世界执行；content script 直连为主，此处兜底）
  register(MSG.SCREENSHOT_COPY, (msg) => {
    const dataUrl = msg && msg.payload && msg.payload.dataUrl;
    if (!dataUrl || robotTabId == null) return false;
    chrome.scripting.executeScript({
      target: { tabId: robotTabId }, world: 'MAIN',
      func: (url) => fetch(url).then((r) => r.blob()).then((b) => navigator.clipboard.write([new ClipboardItem({ 'image/png': b })])).then(() => true).catch(() => false),
      args: [dataUrl],
    }).then((results) => {
      const ok = !!(results && results[0] && results[0].result);
      deliverToast(ok ? '✅ 已复制截图，到微信按 Ctrl+V 粘贴' : '复制失败，请点「保存本地」再用微信 Ctrl+V');
    }).catch(() => deliverToast('复制失败，请点「保存本地」再用微信 Ctrl+V'));
    return false;
  });

  console.log('[HMDAO][screenshot] 后台处理器已注册：CAPTURE / CAPTURE_LONG / OCR / OPEN / REGION_READY / CANCEL / SAVE / COPY');
})();
