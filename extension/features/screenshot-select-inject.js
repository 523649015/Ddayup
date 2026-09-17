// ============================================================================
// Ddayup 扩展 — 截图识文 · 页面选区注入（features/screenshot-select-inject.js）
// ----------------------------------------------------------------------------
// 由侧栏经 chrome.scripting.executeScript({ files: ['shared/messages.js','features/screenshot-select-inject.js'] })
// 注入目标页（ISOLATED 世界）。渲染全屏可拖拽矩形选区覆盖层：
//   拖拽空白创建初框 → 显示 8 把手（4 角 + 4 边中点）缩放 / 框内拖动整体移动 → 工具条「✓ 确认 / ✕ 取消」
// 仅在用户点击「✓ 确认」时回传矩形坐标；取消 / Esc / 30s 超时未确认则清理并回传 CANCEL。
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
  const body = document.body || root;

  // ---- DOM 构建 ----
  // 暗化方案：overlay 本身透明（仅承载指针事件用于拖拽创建），下方用 4 块暗化矩形围在选区外围，
  // 选区内部不覆盖任何暗化层 → 页面原样清晰，外部统一压暗，内外颜色分明（满足"框外框内区分"）。
  // （注：box-shadow 方案会把选区内部也压暗，故不可用，改为 4 矩形。）
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;background:transparent;cursor:crosshair;' +
    'user-select:none;-webkit-user-select:none;touch-action:none;';

  // 4 块暗化矩形（上/下/左/右），始终位于 sel 之下（z-index:0），仅压暗选区外部
  const DIM_CSS = 'position:fixed;background:rgba(0,0,0,.55);pointer-events:none;z-index:0;';
  const dimTop = document.createElement('div');
  const dimBottom = document.createElement('div');
  const dimLeft = document.createElement('div');
  const dimRight = document.createElement('div');
  // 初始全屏压暗（提示已进入截图模式），layout() 会随选区实时重排为"围框"形态
  const _vw0 = window.innerWidth, _vh0 = window.innerHeight;
  dimTop.style.cssText = DIM_CSS + 'left:0;top:0;width:' + _vw0 + 'px;height:0px;';
  dimBottom.style.cssText = DIM_CSS + 'left:0;top:0;width:' + _vw0 + 'px;height:' + _vh0 + 'px;';
  dimLeft.style.cssText = DIM_CSS + 'left:0;top:0;width:0px;height:' + _vh0 + 'px;';
  dimRight.style.cssText = DIM_CSS + 'left:0;top:0;width:' + _vw0 + 'px;height:0px;';
  overlay.append(dimTop, dimBottom, dimLeft, dimRight);

  // 选区矩形：内部透明清晰，蓝色实线边框区分边界；暗化由外围 4 矩形负责
  const sel = document.createElement('div');
  sel.style.cssText =
    'position:fixed;border:2px solid #2f9bff;background:transparent;box-sizing:border-box;' +
    'display:none;pointer-events:auto;z-index:1;';

  // 8 个缩放把手（4 角 + 4 边中点），position:fixed 小方块，z-index 高于 sel
  const HANDLES = [
    { dir: 'nw', cx: 0,   cy: 0,   cursor: 'nwse-resize' },
    { dir: 'n',  cx: 0.5, cy: 0,   cursor: 'ns-resize' },
    { dir: 'ne', cx: 1,   cy: 0,   cursor: 'nesw-resize' },
    { dir: 'e',  cx: 1,   cy: 0.5, cursor: 'ew-resize' },
    { dir: 'se', cx: 1,   cy: 1,   cursor: 'nwse-resize' },
    { dir: 's',  cx: 0.5, cy: 1,   cursor: 'ns-resize' },
    { dir: 'sw', cx: 0,   cy: 1,   cursor: 'nesw-resize' },
    { dir: 'w',  cx: 0,   cy: 0.5, cursor: 'ew-resize' },
  ];
  const HANDLE_SIZE = 12;
  const handleEls = {};
  HANDLES.forEach((h) => {
    const el = document.createElement('div');
    el.dataset.dir = h.dir;
    el.style.cssText =
      'position:fixed;width:' + HANDLE_SIZE + 'px;height:' + HANDLE_SIZE + 'px;' +
      'background:#fff;border:2px solid #2f9bff;border-radius:2px;box-sizing:border-box;' +
      'z-index:2;display:none;pointer-events:auto;cursor:' + h.cursor + ';';
    handleEls[h.dir] = el;
    overlay.appendChild(el);
  });

  // 工具条（提示 + 取消 / 确认）
  const bar = document.createElement('div');
  bar.style.cssText =
    'position:fixed;left:50%;top:16px;transform:translateX(-50%);display:flex;gap:10px;align-items:center;' +
    'background:#0f1620;border:1px solid #2a3a44;border-radius:12px;padding:8px 14px;color:#c9d1d9;' +
    'font:12px/1.4 system-ui,"PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.5);pointer-events:auto;z-index:3;';
  const info = document.createElement('span');
  info.textContent = '拖拽边框缩放，确认后截图 · Esc 取消';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '✕ 取消';
  cancelBtn.style.cssText = 'border:1px solid #30363d;background:#161b22;color:#c9d1d9;border-radius:8px;padding:6px 11px;cursor:pointer;font-size:12px;';
  const confirmBtn = document.createElement('button');
  confirmBtn.textContent = '✓ 确认';
  confirmBtn.style.cssText = 'border:1px solid #1f6f43;background:#1a7f4c;color:#fff;border-radius:8px;padding:6px 11px;cursor:pointer;font-size:12px;';
  bar.append(info, cancelBtn, confirmBtn);

  overlay.append(sel, bar);
  root.appendChild(overlay);

  // ---- 状态机 ----
  // 状态：IDLE（未选区，可拖拽创建） | CREATE（拖拽创建中） | SELECTED（已选中，可移动 / 缩放）
  const STATE = { IDLE: 'idle', CREATE: 'create', SELECTED: 'selected' };
  let state = STATE.IDLE;
  const rect = { x: 0, y: 0, w: 0, h: 0 };
  let drag = null; // { mode:'create'|'move'|'resize', dir?, startX, startY, orig:{x,y,w,h} }
  const MIN_SIZE = 8;

  // 锁滚动 / 禁选择，避免选择期间页面滚动导致坐标错位（修 B5）
  const prevHtmlUserSelect = root.style.userSelect;
  const prevHtmlWebkitUserSelect = root.style.webkitUserSelect;
  const prevBodyOverflow = body.style.overflow;
  root.style.userSelect = 'none';
  root.style.webkitUserSelect = 'none';
  body.style.overflow = 'hidden';

  // 30s 超时兜底：若用户长时间未确认，自动清理并回传 CANCEL，避免守卫卡死（修 B7）
  let timeoutId = null;
  function resetTimer() {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(function () {
      if (window.__hmdaoSsActive) { cleanup(); sendCancel(); }
    }, 30000);
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function cloneRect() { return { x: rect.x, y: rect.y, w: rect.w, h: rect.h }; }
  function isInsideSel(px, py) {
    return px >= rect.x && px <= rect.x + rect.w && py >= rect.y && py <= rect.y + rect.h;
  }

  // 根据 rect 刷新选区与把手位置（仅 SELECTED 态显示把手）
  function layout() {
    const showHandles = state === STATE.SELECTED;
    if (rect.w > 0 && rect.h > 0) {
      sel.style.display = 'block';
      sel.style.left = rect.x + 'px';
      sel.style.top = rect.y + 'px';
      sel.style.width = rect.w + 'px';
      sel.style.height = rect.h + 'px';
    } else {
      sel.style.display = 'none';
    }
    HANDLES.forEach((h) => {
      const el = handleEls[h.dir];
      el.style.display = showHandles ? 'block' : 'none';
      el.style.left = (rect.x + rect.w * h.cx - HANDLE_SIZE / 2) + 'px';
      el.style.top = (rect.y + rect.h * h.cy - HANDLE_SIZE / 2) + 'px';
    });
    // 4 块暗化矩形围住选区外部（内部不覆盖 → 保持页面清晰），框外框内颜色分明
    const vw = window.innerWidth, vh = window.innerHeight;
    const x = rect.x, y = rect.y, w = rect.w, h = rect.h;
    dimTop.style.cssText = DIM_CSS + 'left:0;top:0;width:' + vw + 'px;height:' + y + 'px;';
    dimBottom.style.cssText = DIM_CSS + 'left:0;top:' + (y + h) + 'px;width:' + vw + 'px;height:' + Math.max(0, vh - (y + h)) + 'px;';
    dimLeft.style.cssText = DIM_CSS + 'left:0;top:' + y + 'px;width:' + x + 'px;height:' + h + 'px;';
    dimRight.style.cssText = DIM_CSS + 'left:' + (x + w) + 'px;top:' + y + 'px;width:' + Math.max(0, vw - (x + w)) + 'px;height:' + h + 'px;';
  }

  // 按方位缩放：保持对侧边缘不动，处理最小尺寸与视口越界
  function applyResize(dir, o, dx, dy) {
    let x = o.x, y = o.y, w = o.w, h = o.h;
    const right = o.x + o.w;
    const bottom = o.y + o.h;
    if (dir.indexOf('w') >= 0) {
      x = clamp(o.x + dx, 0, right - MIN_SIZE); // 左边缘移动，右边缘(right)固定
      w = right - x;
    }
    if (dir.indexOf('e') >= 0) {
      w = clamp(o.w + dx, MIN_SIZE, window.innerWidth - o.x); // 右边缘移动，左边缘(o.x)固定
    }
    if (dir.indexOf('n') >= 0) {
      y = clamp(o.y + dy, 0, bottom - MIN_SIZE); // 上边缘移动，下边缘(bottom)固定
      h = bottom - y;
    }
    if (dir.indexOf('s') >= 0) {
      h = clamp(o.h + dy, MIN_SIZE, window.innerHeight - o.y); // 下边缘移动，上边缘(o.y)固定
    }
    x = clamp(x, 0, window.innerWidth - w);
    y = clamp(y, 0, window.innerHeight - h);
    rect.x = x; rect.y = y; rect.w = w; rect.h = h;
  }

  function onDown(e) {
    if (e.button !== 0) return; // 仅左键
    if (drag) return; // 防重入
    if (e.target === confirmBtn || e.target === cancelBtn) return; // 工具条按钮自处理
    if (bar.contains(e.target)) return; // 工具条区域不触发拖拽
    e.preventDefault();
    resetTimer();
    const px = e.clientX, py = e.clientY;

    // 命中把手 → 缩放（仅 SELECTED 态）
    const dir = (e.target && e.target.dataset) ? e.target.dataset.dir : '';
    if (dir && state === STATE.SELECTED) {
      drag = { mode: 'resize', dir: dir, startX: px, startY: py, orig: cloneRect() };
      bindDrag();
      return;
    }
    // 命中选区内部（非把手）→ 整体移动
    if (state === STATE.SELECTED && isInsideSel(px, py)) {
      drag = { mode: 'move', startX: px, startY: py, orig: cloneRect() };
      bindDrag();
      return;
    }
    // 空白处（含从已选区外重拖）→ 重新创建初框
    state = STATE.CREATE;
    rect.x = px; rect.y = py; rect.w = 0; rect.h = 0;
    drag = { mode: 'create', startX: px, startY: py, orig: cloneRect() };
    layout();
    bindDrag();
  }

  function bindDrag() {
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function onMove(e) {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    const o = drag.orig;
    if (drag.mode === 'create') {
      rect.x = Math.min(o.x, o.x + dx);
      rect.y = Math.min(o.y, o.y + dy);
      rect.w = Math.abs(dx);
      rect.h = Math.abs(dy);
    } else if (drag.mode === 'move') {
      rect.x = clamp(o.x + dx, 0, window.innerWidth - o.w);
      rect.y = clamp(o.y + dy, 0, window.innerHeight - o.h);
      rect.w = o.w; rect.h = o.h;
    } else if (drag.mode === 'resize') {
      applyResize(drag.dir, o, dx, dy);
    }
    layout();
    e.preventDefault();
  }

  function onUp() {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    if (!drag) return;
    const mode = drag.mode;
    drag = null;
    if (mode === 'create') {
      // 太小视为误触：回到 idle，保留遮罩可重新创建
      if (rect.w < MIN_SIZE || rect.h < MIN_SIZE) {
        rect.w = 0; rect.h = 0;
        state = STATE.IDLE;
        layout();
        return;
      }
      state = STATE.SELECTED;
      layout();
      return;
    }
    state = STATE.SELECTED; // move / resize 结束，回到已选中态
  }

  function onKey(e) {
    if (e.key === 'Escape') { cleanup(); sendCancel(); }
  }

  function onConfirmClick(e) {
    e.stopPropagation();
    if (rect.w < MIN_SIZE || rect.h < MIN_SIZE) return;
    done();
  }
  function onCancelClick(e) {
    e.stopPropagation();
    cleanup();
    sendCancel();
  }

  // 仅在确认时回传 REGION_READY（视口坐标）
  function done() {
    const payload = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.w),
      h: Math.round(rect.h),
      dpr: window.devicePixelRatio || 1,
      scrollX: window.scrollX || window.pageXOffset || 0,
      scrollY: window.scrollY || window.pageYOffset || 0,
      vw: window.innerWidth,
      vh: window.innerHeight,
    };
    cleanup();
    try { chrome.runtime.sendMessage({ type: REGION_READY, payload: payload }); } catch (_) {}
  }

  function sendCancel() {
    try { chrome.runtime.sendMessage({ type: CANCEL }); } catch (_) {}
  }

  // 响应侧栏发来的 CANCEL：清理可能残留的选区层（解 B7 外部取消 / 清守卫）
  function onCancelMsg(m) {
    if (m && m.type === CANCEL) { cleanup(); }
  }

  // 完整清理：移除所有监听、还原样式、复位守卫（可安全重复调用，finally 语义）
  function cleanup() {
    if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
    overlay.removeEventListener('mousedown', onDown);
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('keydown', onKey);
    confirmBtn.removeEventListener('click', onConfirmClick);
    cancelBtn.removeEventListener('click', onCancelClick);
    try { chrome.runtime.onMessage.removeListener(onCancelMsg); } catch (_) {}
    root.style.userSelect = prevHtmlUserSelect;
    root.style.webkitUserSelect = prevHtmlWebkitUserSelect;
    body.style.overflow = prevBodyOverflow;
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    window.__hmdaoSsActive = false;
  }

  // ---- 事件绑定 ----
  overlay.addEventListener('mousedown', onDown);
  window.addEventListener('keydown', onKey);
  confirmBtn.addEventListener('click', onConfirmClick);
  cancelBtn.addEventListener('click', onCancelClick);
  chrome.runtime.onMessage.addListener(onCancelMsg);
  resetTimer();
})();
