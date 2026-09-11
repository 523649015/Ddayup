// ============================================================================
// Ddayup 扩展 — 截图识文 · 页面选区注入（features/screenshot-select-inject.js）
// ----------------------------------------------------------------------------
// 由侧栏经 chrome.scripting.executeScript({ files: ['shared/messages.js','features/screenshot-select-inject.js'] })
// 注入目标页（ISOLATED 世界）。渲染全屏可拖拽矩形选区覆盖层，用户框选后回传矩形坐标。
//
// 回传协议（chrome.runtime.sendMessage → 侧栏监听）：
//   { type: HMDAO_SCREENSHOT_REGION_READY, payload: { x, y, w, h, dpr, scrollX, scrollY, vw, vh } }
//   { type: HMDAO_SCREENSHOT_CANCEL }
// 坐标均为视口（client）坐标；侧栏按 captureVisibleTab 的当前视口裁切，无需减 scroll。
// ============================================================================
(function () {
  'use strict';
  if (window.__hmdaoSsActive) return; // 防止重复注入叠加
  window.__hmdaoSsActive = true;

  const MSG = (typeof self !== 'undefined' && self.HMDAO_MSG) || {};
  const REGION_READY = MSG.SCREENSHOT_REGION_READY || 'HMDAO_SCREENSHOT_REGION_READY';
  const CANCEL = MSG.SCREENSHOT_CANCEL || 'HMDAO_SCREENSHOT_CANCEL';

  const root = document.documentElement;

  // 暗化遮罩（拦截指针，承载选区）
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.35);cursor:crosshair;' +
    'user-select:none;-webkit-user-select:none;touch-action:none;';
  // 选区矩形
  const sel = document.createElement('div');
  sel.style.cssText =
    'position:fixed;border:2px solid #2f9bff;background:rgba(47,155,255,.12);box-sizing:border-box;display:none;pointer-events:none;';
  // 工具条
  const bar = document.createElement('div');
  bar.style.cssText =
    'position:fixed;left:50%;top:16px;transform:translateX(-50%);display:flex;gap:10px;align-items:center;' +
    'background:#0f1620;border:1px solid #2a3a44;border-radius:12px;padding:8px 14px;color:#c9d1d9;' +
    'font:12px/1.4 system-ui,"PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.5);pointer-events:auto;z-index:2147483647;';
  const info = document.createElement('span');
  info.textContent = '拖拽框选要识别的区域 · Esc 取消';
  const cancel = document.createElement('button');
  cancel.textContent = '✕ 取消';
  cancel.style.cssText = 'border:1px solid #30363d;background:#161b22;color:#c9d1d9;border-radius:8px;padding:6px 11px;cursor:pointer;font-size:12px;';
  bar.append(info, cancel);
  overlay.append(sel, bar);
  root.appendChild(overlay);

  let startX = 0, startY = 0, dragging = false;

  function setSel(x, y, w, h) {
    sel.style.display = 'block';
    sel.style.left = x + 'px'; sel.style.top = y + 'px';
    sel.style.width = w + 'px'; sel.style.height = h + 'px';
  }
  function clearSel() { sel.style.display = 'none'; }

  function done() {
    cleanup();
    const sx = Math.min(startX, lastX), sy = Math.min(startY, lastY);
    const w = Math.abs(lastX - startX), h = Math.abs(lastY - startY);
    if (w < 8 || h < 8) return; // 太小视为误触
    chrome.runtime.sendMessage({
      type: REGION_READY,
      payload: {
        x: Math.round(sx), y: Math.round(sy), w: Math.round(w), h: Math.round(h),
        dpr: window.devicePixelRatio || 1,
        scrollX: window.scrollX || window.pageXOffset || 0,
        scrollY: window.scrollY || window.pageYOffset || 0,
        vw: window.innerWidth, vh: window.innerHeight,
      },
    });
  }

  let lastX = 0, lastY = 0;
  function onDown(e) {
    if (e.target === cancel) return;
    dragging = true;
    startX = lastX = e.clientX; startY = lastY = e.clientY;
    setSel(startX, startY, 0, 0);
    e.preventDefault();
  }
  function onMove(e) {
    if (!dragging) return;
    lastX = e.clientX; lastY = e.clientY;
    setSel(Math.min(startX, lastX), Math.min(startY, lastY), Math.abs(lastX - startX), Math.abs(lastY - startY));
  }
  function onUp() { if (dragging) { dragging = false; done(); } }

  function onKey(e) { if (e.key === 'Escape') { cleanup(); finishCancel(); } }

  function cleanup() {
    overlay.removeEventListener('mousedown', onDown);
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('keydown', onKey);
    cancel.removeEventListener('click', onCancelClick);
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    window.__hmdaoSsActive = false;
  }
  function finishCancel() {
    try { chrome.runtime.sendMessage({ type: CANCEL }); } catch (_) {}
  }
  function onCancelClick(e) { e.stopPropagation(); cleanup(); finishCancel(); }

  overlay.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  window.addEventListener('keydown', onKey);
  cancel.addEventListener('click', onCancelClick);
})();
