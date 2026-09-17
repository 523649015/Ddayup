// robot-overlay.js — 注入到当前网页的 Ddayup 智能机器人浮标
// 形象 1:1 复制 Web App SmartAgent(127.0.0.1:3000)；可在整页拖动、点击展开、全屏覆盖、收起。
// 由侧栏「在网页打开」注入；AI 调用经 background → 3000 智能机器人后端；关闭后自动回到侧栏。
(function () {
  if (window.__hmdaoRobotOverlay) return;
  window.__hmdaoRobotOverlay = true;

  const host = document.createElement('div');
  host.id = 'hmdao-robot-host';
  host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
  const shadow = host.attachShadow({ mode: 'open' });
  document.documentElement.appendChild(host);

  shadow.innerHTML = `
  <style>
    :host { all: initial; }
    * { box-sizing: border-box; }
    .anchor {
      position: fixed; left: 24px; top: 24px; width: 36px; height: 36px;
      pointer-events: auto; user-select: none; touch-action: none;
    }
    /* ===== 精灵形象（1:1 复制 SmartAgent 3000，缩放至与侧栏一致 36px） ===== */
    .bot {
      position: relative; width: 72px; height: 72px; cursor: grab; border-radius: 24px;
      border: 2px solid rgba(255,255,255,.18); background: linear-gradient(180deg, #3af5cc, #0ea58b);
      box-shadow: 0 14px 30px rgba(2,16,18,.35); animation: hmFloat 4.6s ease-in-out infinite;
      transform: scale(.5); transform-origin: top left;
    }
    .bot:active { cursor: grabbing; }
    .bot .glow { position: absolute; inset: -12px; border-radius: 50%; background: rgba(0,212,170,.24); filter: blur(12px); pointer-events: none; }
    .bot .sheen {
      position: absolute; inset: 2px; border-radius: 22px; pointer-events: none;
      background: radial-gradient(circle at 30% 18%, rgba(255,255,255,.86), rgba(255,255,255,0) 36%),
                  linear-gradient(180deg, rgba(255,255,255,.18), rgba(0,0,0,.1));
    }
    .bot .float { position: absolute; left: 10px; top: 10px; width: 52px; height: 52px; }
    .bot .shadow { position: absolute; left: 6px; right: 6px; bottom: 2px; height: 8px; border-radius: 999px; background: rgba(4,43,42,.18); filter: blur(4px); }
    .bot .antenna-dot { position: absolute; left: 50%; top: 4px; height: 10px; width: 10px; transform: translateX(-50%); border-radius: 50%; background: #fff6d5; box-shadow: 0 0 0 2px rgba(4,43,42,.08); }
    .bot .antenna-stalk { position: absolute; left: 50%; top: 0; height: 8px; width: 3px; transform: translateX(-50%); border-radius: 999px; background: #0d6e61; }
    .bot .body { position: absolute; left: 6px; right: 6px; top: 10px; height: 34px; border-radius: 16px; background: linear-gradient(180deg, #fffceb, #dffef7 60%, #8be5d5); box-shadow: inset 0 -4px 10px rgba(4,38,35,.12); }
    .bot .glasses { position: absolute; left: 50%; top: 16px; transform: translateX(-50%); display: flex; align-items: center; gap: 2px; will-change: transform; }
    .bot .lens { position: relative; display: flex; align-items: center; justify-content: center; height: 15px; width: 15px; border-radius: 50%; border: 2px solid #133243; background: rgba(215,247,255,.9); box-shadow: inset 0 1px 1px rgba(255,255,255,.7); overflow: hidden; }
    .bot .pupil { height: 4.5px; width: 4.5px; border-radius: 50%; background: #102034; transition: transform .075s ease-out; }
    .bot .lid { position: absolute; inset: 1px; transform-origin: top; border-radius: 50%; background: #fff7d6; transform: scaleY(0); animation: hmBlink 5.8s ease-in-out infinite; }
    .bot .bridge { height: 3px; width: 7px; border-radius: 999px; background: #133243; }
    .bot .mouth { position: absolute; left: 50%; top: 32px; height: 4px; width: 16px; transform: translateX(-50%); border-radius: 999px; background: rgba(13,123,103,.7); }
    .bot .feet-l, .bot .feet-r { position: absolute; bottom: 4px; height: 8px; width: 8px; border-radius: 50%; border: 2px solid rgba(255,255,255,.18); background: #0f8b76; }
    .bot .feet-l { left: 10px; } .bot .feet-r { right: 10px; }

    /* ===== 聊天面板（与侧栏同款深色主题，自适应大小） ===== */
    .panel {
      position: fixed; display: none; width: 340px; max-width: 92vw; height: 460px; max-height: 78vh;
      flex-direction: column; background: #0f1620; border: 1px solid #2a3a44; border-radius: 16px; overflow: hidden;
      box-shadow: 0 24px 60px rgba(0,0,0,.5); font: 13px/1.5 system-ui, "PingFang SC", "Microsoft YaHei", sans-serif; color: #c9d1d9;
    }
    .panel.open { display: flex; }
    .panel.full { width: 92vw; height: 88vh; max-width: none; max-height: none; }
    /* 全屏时字号随面板放大，避免文字过小 */
    .panel.full .msgs, .panel.full .row { font-size: 16px; line-height: 1.6; }
    .panel.full .inbox textarea { font-size: 15px; }
    .panel.full .acts button { font-size: 14px; padding: 9px 10px; }
    .panel.full .status { font-size: 13px; }
    .panel.full .head { font-size: 15px; padding: 14px 16px; }
    .panel .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; cursor: grab; background: linear-gradient(90deg, #0ea58b, #0b7d6b); color: #04150f; }
    .panel .head .ttl { font-weight: 700; flex: 1; }
    .panel .head .ico { cursor: pointer; opacity: .92; padding: 0 4px; font-size: 14px; }
    .panel .head .ico:hover { opacity: 1; }
    .panel .msgs { flex: 1 1 auto; min-height: 80px; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    .panel .row { max-width: 88%; padding: 8px 11px; border-radius: 12px; white-space: pre-wrap; word-break: break-word; }
    .panel .row.me { align-self: flex-end; background: #0ea58b; color: #04150f; border-bottom-right-radius: 4px; }
    .panel .row.bot { align-self: flex-start; background: #1a2530; color: #c9d1d9; border: 1px solid #2a3a44; border-bottom-left-radius: 4px; }
    .panel .row.err { align-self: flex-start; background: #ffe9e9; color: #c0392b; border-bottom-left-radius: 4px; }
    .panel .status { font-size: 11px; color: #d29922; padding: 0 12px 8px; min-height: 14px; }
    .panel .acts { display: flex; gap: 6px; padding: 8px 10px 0; flex-wrap: wrap; }
    .panel .acts button { flex: 1 1 auto; min-width: 88px; border: 1px solid #30363d; background: #161b22; color: #c9d1d9; border-radius: 9px; padding: 7px 8px; cursor: pointer; font-size: 12px; }
    .panel .acts button:hover { border-color: #0ea58b; color: #0ea58b; }
    .panel .inbox { display: flex; gap: 8px; padding: 10px; border-top: 1px solid #2a3a44; }
    .panel .inbox textarea { flex: 1; resize: none; height: 42px; border: 1px solid #30363d; border-radius: 10px; padding: 8px 10px; font: inherit; outline: none; background: #0d1117; color: #c9d1d9; }
    .panel .inbox textarea:focus { border-color: #0ea58b; }
    .panel .inbox .send { border: 0; background: #0ea58b; color: #04150f; border-radius: 10px; padding: 0 14px; cursor: pointer; font-weight: 700; }
    .panel .inbox .send:disabled { opacity: .5; cursor: default; }

    /* 底部高度调整把手（上下拖动放大聊天面板，解决文字显示不全） */
    .panel .grip { position: absolute; left: 0; right: 0; bottom: 0; height: 9px; cursor: ns-resize; pointer-events: auto; background: linear-gradient(180deg, rgba(14,165,139,0), rgba(14,165,139,.35)); }
    .panel .grip:hover { background: linear-gradient(180deg, rgba(14,165,139,0), rgba(14,165,139,.6)); }
    /* 全屏模式下把手仍可见，允许上下拖动继续放大/缩小 */

    /* 框选本页文案覆盖层 */
    .marquee { position: fixed; inset: 0; display: none; z-index: 2147483647; cursor: crosshair; pointer-events: auto; }
    .marquee.on { display: block; }
    .marquee .sel { position: fixed; border: 2px dashed #0ea58b; background: rgba(14,165,139,.14); display: none; pointer-events: none; border-radius: 4px; }
    .marquee .mbar { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); display: none; gap: 8px; align-items: center; background: #0f1620; border: 1px solid #2a3a44; border-radius: 12px; padding: 8px 12px; color: #c9d1d9; font: 12px/1.4 system-ui, "PingFang SC", "Microsoft YaHei", sans-serif; box-shadow: 0 10px 30px rgba(0,0,0,.5); pointer-events: auto; max-width: 92vw; }
    .marquee.on .mbar { display: flex; }
    .marquee .mbar button { border: 1px solid #30363d; background: #161b22; color: #c9d1d9; border-radius: 8px; padding: 6px 11px; cursor: pointer; font-size: 12px; }
    .marquee .mbar button:hover { border-color: #0ea58b; color: #0ea58b; }

    /* ===== 截图识文结果面板（第二阶段，跟随 #hmAnchor，content script 内渲染） ===== */
    .sspanel {
      position: fixed; display: none; z-index: 2147483647; flex-direction: column; gap: 8px;
      width: 300px; max-width: 92vw; max-height: 86vh; overflow: auto;
      background: #0f1620; border: 1px solid #2a3a44; border-radius: 14px; padding: 10px 12px;
      box-shadow: 0 24px 60px rgba(0,0,0,.5); font: 12px/1.5 system-ui, "PingFang SC", "Microsoft YaHei", sans-serif; color: #c9d1d9;
    }
    .sspanel.open { display: flex; }
    .ss-head { display: flex; justify-content: space-between; align-items: center; color: #9ecbff; font-weight: 600; }
    .ss-close { cursor: pointer; opacity: .9; padding: 0 4px; font-size: 14px; }
    .ss-close:hover { opacity: 1; }
    .ss-imgwrap { position: relative; width: 100%; }
    .sspanel img { width: 100%; border-radius: 8px; background: #000; object-fit: contain; display: block; }
    .ss-crop-overlay { position: absolute; left: 0; top: 0; width: 100%; height: 100%; display: none; cursor: crosshair; background: rgba(0,0,0,.12); }
    .ss-crop-box { position: absolute; border: 2px dashed #0ea58b; background: rgba(14,165,139,.14); display: none; pointer-events: none; }
    .ss-row { display: flex; gap: 6px; flex-wrap: wrap; }
    .ss-row button { flex: 1 1 auto; min-width: 64px; border: 1px solid #30363d; background: #161b22; color: #c9d1d9; border-radius: 9px; padding: 7px 6px; cursor: pointer; font-size: 12px; }
    .ss-row button:hover { border-color: #0ea58b; color: #0ea58b; }
    .ss-crop-btn { border: 1px solid #30363d; background: #161b22; color: #c9d1d9; border-radius: 9px; padding: 7px 8px; cursor: pointer; font-size: 12px; }
    .ss-crop-btn:hover { border-color: #0ea58b; color: #0ea58b; }
    .ss-text { display: none; width: 100%; height: 120px; box-sizing: border-box; background: #0b1118; color: #c9d1d9; border: 1px solid #2a3a44; border-radius: 8px; padding: 8px; font-size: 12px; resize: vertical; }
    .ss-copytext { display: none; align-self: flex-start; border: 1px solid #30363d; background: #161b22; color: #c9d1d9; border-radius: 8px; padding: 6px 10px; cursor: pointer; font-size: 12px; }
    .ss-copytext:hover { border-color: #0ea58b; color: #0ea58b; }
    .sstoast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); display: none; max-width: 80vw; background: #0f1620; border: 1px solid #2a3a44; color: #c9d1d9; border-radius: 10px; padding: 8px 12px; font: 12px/1.4 system-ui, "PingFang SC", "Microsoft YaHei", sans-serif; box-shadow: 0 10px 30px rgba(0,0,0,.5); z-index: 2147483647; }

    @keyframes hmFloat { 0%,100% { transform: translateY(0) scale(.5); } 50% { transform: translateY(-6px) scale(.5); } }
    @keyframes hmBlink { 0%,8%,44%,46%,100% { transform: scaleY(0); } 4%,45% { transform: scaleY(1); } }
  </style>

  <div class="anchor" id="hmAnchor">
    <div class="bot" id="hmBot" title="点击展开 / 拖动我">
      <span class="glow"></span>
      <span class="sheen"></span>
      <span class="float">
        <span class="shadow"></span>
        <span class="antenna-dot"></span>
        <span class="antenna-stalk"></span>
        <span class="body"></span>
        <span class="glasses" id="hmGlasses">
          <span class="lens"><span class="pupil" id="hmPupilL"></span><span class="lid"></span></span>
          <span class="bridge"></span>
          <span class="lens"><span class="pupil" id="hmPupilR"></span><span class="lid"></span></span>
        </span>
        <span class="mouth"></span>
        <span class="feet-l"></span>
        <span class="feet-r"></span>
      </span>
    </div>

    <div class="panel" id="hmPanel">
      <div class="head" id="hmHead">
        <span class="ttl">🤖 Ddayup 智能助手</span>
        <span class="ico" id="hmFull" title="全屏/还原">⛶</span>
        <span class="ico" id="hmMin" title="收起">—</span>
        <span class="ico" id="hmClose" title="关闭并回到侧栏">×</span>
      </div>
      <div class="msgs" id="hmMsgs"></div>
      <div class="status" id="hmStatus"></div>
      <div class="acts">
        <button data-mode="summarize">📝 总结素材</button>
        <button data-mode="translate">🌐 翻译</button>
        <button data-mode="reverse">💡 反推提示词</button>
        <button data-action="analyze-page">🔎 分析本网页</button>
        <button data-action="upload">📎 上传图片/视频</button>
        <button data-action="deep">🧠 深度分析</button>
        <button data-mode="screenshot-region">📷 截图识文</button>
        <button data-mode="screenshot-long">📜 截长图</button>
      </div>
      <div class="inbox">
        <input type="file" id="hmFile" accept="image/*,video/*" style="display:none" />
        <textarea id="hmText" placeholder="问点什么，或选上面的快捷操作…（可上传图片/视频交给画布智能体工作流）"></textarea>
        <button class="send" id="hmSend">发送</button>
      </div>
      <div class="grip" id="hmGrip" title="上下拖动调整面板高度"></div>
    </div>
    <div class="marquee" id="hmMarquee">
      <div class="sel" id="hmSel"></div>
      <div class="mbar">
        <span id="hmMinfo">在页面上拖拽框选要分析的文案（松开后点「分析」）</span>
        <button id="hmMok">✓ 分析选中内容</button>
        <button id="hmMre">↻ 重新框选</button>
        <button id="hmMcancel">✕ 取消</button>
      </div>
    </div>

    <!-- 截图识文结果面板（第二阶段：跟随 #hmAnchor，content script 内渲染） -->
    <div class="sspanel" id="hmSsPanel">
      <div class="ss-head">
        <span class="ss-ttl">📷 截图识文</span>
        <span class="ss-close" id="hmSsClose" title="关闭">✕</span>
      </div>
      <div class="ss-imgwrap" id="hmSsImgWrap">
        <img id="hmSsImg" alt="截图预览" />
        <div class="ss-crop-overlay" id="hmSsCropOverlay"><div class="ss-crop-box" id="hmSsCropBox"></div></div>
      </div>
      <div class="ss-row">
        <button id="hmSsTranslate">🌐 翻译</button>
        <button id="hmSsExtract">📝 提取文字</button>
        <button id="hmSsCopy">📋 复制截图</button>
        <button id="hmSsSave">💾 保存本地</button>
      </div>
      <button class="ss-crop-btn" id="hmSsCrop" style="display:none">✂ 框选区域</button>
      <textarea id="hmSsText" class="ss-text" placeholder="识别结果将显示在这里"></textarea>
      <button id="hmSsCopyText" class="ss-copytext" style="display:none">复制文字</button>
    </div>
    <div class="sstoast" id="hmSsToast"></div>
  </div>`;

  const anchor = shadow.getElementById('hmAnchor');
  const bot = shadow.getElementById('hmBot');
  const glasses = shadow.getElementById('hmGlasses');
  const pupilL = shadow.getElementById('hmPupilL');
  const pupilR = shadow.getElementById('hmPupilR');
  const panel = shadow.getElementById('hmPanel');
  const head = shadow.getElementById('hmHead');
  const msgs = shadow.getElementById('hmMsgs');
  const statusEl = shadow.getElementById('hmStatus');
  const text = shadow.getElementById('hmText');
  const sendBtn = shadow.getElementById('hmSend');

  // ===== 拖动（整页范围） =====
  let dragEl = null, dx = 0, dy = 0, moved = false;
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function onDown(e, el) {
    dragEl = el; moved = false;
    const r = anchor.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    dx = p.clientX - r.left; dy = p.clientY - r.top;
    el.setPointerCapture && el.setPointerCapture(p.pointerId);
  }
  function onMove(e) {
    if (!dragEl) return;
    const p = e.touches ? e.touches[0] : e;
    moved = true;
    const x = clamp(p.clientX - dx, 0, window.innerWidth - anchor.offsetWidth);
    const y = clamp(p.clientY - dy, 0, window.innerHeight - anchor.offsetHeight);
    anchor.style.left = x + 'px';
    anchor.style.top = y + 'px';
    e.preventDefault();
    repositionSS(); // 截图结果面板跟随锚点（F4 核心）
  }
  function onUp() { dragEl = null; }
  bot.addEventListener('pointerdown', (e) => onDown(e, bot));
  head.addEventListener('pointerdown', (e) => { if (e.target.id === 'hmHead' || e.target.classList.contains('ttl')) onDown(e, head); });
  window.addEventListener('pointermove', onMove, { passive: false });
  window.addEventListener('pointerup', onUp);

  // ===== 框选本页文案（替代直接抓取整页 innerText，避免采到无用文案） =====
  const marquee = shadow.getElementById('hmMarquee');
  const selBox = shadow.getElementById('hmSel');
  const minfo = shadow.getElementById('hmMinfo');
  const mok = shadow.getElementById('hmMok');
  const mre = shadow.getElementById('hmMre');
  const mcancel = shadow.getElementById('hmMcancel');
  let selRect = null, selectedText = '', selDragging = false, selSX = 0, selSY = 0;

  // 提取与矩形相交的所有文本节点内容（按文档顺序拼接，跳过脚本/样式/表单）
  function getPageTextInRect(r) {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const t = (node.nodeValue || '').trim();
      if (!t) continue;
      const p = node.parentElement;
      if (!p) continue;
      const tag = p.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA' || tag === 'INPUT') continue;
      const range = document.createRange();
      try { range.selectNodeContents(node); } catch (_) { continue; }
      const b = range.getBoundingClientRect();
      if (!b || (b.width === 0 && b.height === 0)) continue;
      const intersects = !(b.right < r.left || b.left > r.left + r.width || b.bottom < r.top || b.top > r.top + r.height);
      if (intersects) out.push(t);
    }
    return out.join('\n').replace(/\n{2,}/g, '\n').trim();
  }
  function updateSelBox() {
    if (!selRect) return;
    selBox.style.left = selRect.left + 'px';
    selBox.style.top = selRect.top + 'px';
    selBox.style.width = selRect.width + 'px';
    selBox.style.height = selRect.height + 'px';
  }
  function analyzeSelectedText(txt) {
    marquee.classList.remove('on');
    const prompt = (text.value.trim() || '请分析并总结归纳以下网页片段的主要内容、结构与重点。');
    sendChat((prompt + '\n\n—— 网页片段 ——\n' + txt.slice(0, 8000)), 'summarize');
  }
  function startSelect() {
    // 若用户已在页面上用鼠标选中了文字，直接复用，省去框选
    const native = ((window.getSelection && window.getSelection().toString()) || '').trim();
    if (native) { analyzeSelectedText(native); return; }
    selRect = null; selectedText = ''; selBox.style.display = 'none';
    minfo.textContent = '在页面上拖拽框选要分析的文案（松开后点「分析」）';
    marquee.classList.add('on');
  }
  marquee.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.mbar')) return; // 点工具条按钮不触发框选
    selDragging = true; selSX = e.clientX; selSY = e.clientY;
    selRect = { left: selSX, top: selSY, width: 0, height: 0 };
    selBox.style.display = 'block'; updateSelBox();
    marquee.setPointerCapture && marquee.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  marquee.addEventListener('pointermove', (e) => {
    if (!selDragging) return;
    const x = Math.min(selSX, e.clientX), y = Math.min(selSY, e.clientY);
    selRect = { left: x, top: y, width: Math.abs(e.clientX - selSX), height: Math.abs(e.clientY - selSY) };
    updateSelBox();
  });
  marquee.addEventListener('pointerup', () => {
    if (!selDragging) return;
    selDragging = false;
    if (selRect && selRect.width > 4 && selRect.height > 4) {
      selectedText = getPageTextInRect(selRect);
      if (selectedText) { minfo.textContent = `已选中 ${selectedText.length} 字，可「分析」或「重新框选」`; return; }
    }
    selectedText = ''; minfo.textContent = '未选中文字，请重新框选';
  });
  mok.addEventListener('click', () => { if (selectedText) analyzeSelectedText(selectedText); else minfo.textContent = '请先框选一段文案'; });
  mre.addEventListener('click', () => { selectedText = ''; selRect = null; selBox.style.display = 'none'; minfo.textContent = '在页面上拖拽框选要分析的文案'; });
  mcancel.addEventListener('click', () => { marquee.classList.remove('on'); selectedText = ''; selRect = null; selBox.style.display = 'none'; });

  // ===== 面板高度调整（底部 grip 上下拖动，解决文字显示不全） =====
  const grip = shadow.getElementById('hmGrip');
  let resizing = false, rzStartY = 0, rzStartH = 0;
  grip.addEventListener('pointerdown', (e) => {
    resizing = true; rzStartY = e.clientY; rzStartH = panel.offsetHeight;
    grip.setPointerCapture && grip.setPointerCapture(e.pointerId);
    e.preventDefault(); e.stopPropagation();
  });
  window.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    const dy = e.clientY - rzStartY;
    const nh = clamp(rzStartH - dy, 280, Math.max(280, window.innerHeight - 40));
    panel.style.height = nh + 'px';
  });
  window.addEventListener('pointerup', () => { resizing = false; });

  // ===== 点击：展开 / 收起 =====
  bot.addEventListener('click', () => {
    if (moved) return;
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) text.focus();
  });
  shadow.getElementById('hmMin').addEventListener('click', () => panel.classList.remove('open'));
  // 关闭：彻底移除浮标并通知侧栏「回到侧栏」
  shadow.getElementById('hmClose').addEventListener('click', () => removeSelf());
  shadow.getElementById('hmFull').addEventListener('click', () => { panel.classList.toggle('full'); panel.style.height = ''; });

  // ===== 眼睛 + 眼镜跟随鼠标 =====
  function mouseHandler(e) {
    const r = bot.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const ang = Math.atan2(e.clientY - cy, e.clientX - cx);
    const dist = Math.min(2.5, Math.hypot(e.clientX - cx, e.clientY - cy) / 40);
    const tx = Math.cos(ang) * dist, ty = Math.sin(ang) * dist;
    pupilL.style.transform = `translate(${tx}px, ${ty}px)`;
    pupilR.style.transform = `translate(${tx}px, ${ty}px)`;
    const tilt = clamp((e.clientX - cx) / 12, -6, 6);
    glasses.style.transform = `translateX(-50%) rotate(${tilt * 0.12}deg) translateX(${tilt * 0.18}px)`;
  }
  window.addEventListener('mousemove', mouseHandler);

  // ===== 彻底移除浮标（关闭 / 被侧栏收回时调用） =====
  function removeSelf() {
    window.removeEventListener('mousemove', mouseHandler);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('resize', repositionSS);
    if (msgHandler) chrome.runtime.onMessage.removeListener(msgHandler);
    if (ssHandler) chrome.runtime.onMessage.removeListener(ssHandler);
    if (ssPanel) ssPanel.classList.remove('open');
    if (ssToast) ssToast.style.display = 'none';
    try { if (host && host.parentNode) host.parentNode.removeChild(host); } catch (_) {}
    try { delete window.__hmdaoRobotOverlay; } catch (_) {}
    chrome.runtime.sendMessage({ type: 'HMDAO_AI_BOT_RETURN' }).catch(() => {});
  }

  // ===== AI 聊天 =====
  function addRow(text, cls) {
    const d = document.createElement('div');
    d.className = 'row ' + cls;
    d.textContent = text;
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
    return d;
  }
  let busy = false, busyTimer = null;
  let pendingDeep = false; // 标记下一次文件选择为「深度分析」模式
  // P2.a：多轮对话历史（仅 chat 模式参与上下文），随请求发给后端拼 messages
  const chatHistory = [];
  function pushHistory(role, content) {
    chatHistory.push({ role, content: String(content || '').slice(0, 4000) });
    if (chatHistory.length > 12) chatHistory.splice(0, chatHistory.length - 12);
  }
  function sendChat(textVal, mode) {
    const val = (textVal || '').trim();
    if (!val || busy) return;
    addRow((mode ? '【' + modeLabel(mode) + '】' : '') + val, 'me');
    busy = true; sendBtn.disabled = true; statusEl.textContent = '智能助手正在思考…';
    const payload = { text: val, mode: mode || 'chat', history: chatHistory.slice() };
    if ((mode || 'chat') === 'chat') pushHistory('user', val);
    text.value = '';
    // background 异步转发到 3000，不在此 await 结果；用超时兜底防止卡死
    chrome.runtime.sendMessage({ type: 'HMDAO_AI_CHAT', payload }).catch((err) => {
      statusEl.textContent = '';
      addRow('发送失败：' + (err && err.message || err), 'err');
      busy = false; sendBtn.disabled = false;
    });
    busyTimer = setTimeout(() => {
      if (busy) {
        busy = false; sendBtn.disabled = false;
        statusEl.textContent = '⏱ 请求超时，请确认 127.0.0.1:3000 已打开并在线';
      }
    }, 25000);
  }
  function modeLabel(m) { return ({ summarize: '总结', translate: '翻译', reverse: '反推提示词' })[m] || m; }

  // 接收来自 background 的消息（回传 / 被侧栏收回指令）
  const msgHandler = (msg) => {
    if (msg && msg.type === 'HMDAO_AI_BOT_REMOVE') { removeSelf(); return; }
    if (msg && msg.type === 'HMDAO_AI_CHAT_REPLY') {
      busy = false; sendBtn.disabled = false; statusEl.textContent = '';
      if (busyTimer) { clearTimeout(busyTimer); busyTimer = null; }
      if (msg.ok) {
        // P2.a：思考过程可见化——模型返回 reasoning_content 时先展示"💭 思考"行
        if (msg.thinking) addRow('💭 ' + msg.thinking, 'bot');
        addRow(msg.text || '(空回复)', 'bot');
        pushHistory('assistant', msg.text || '');
      } else addRow('⚠️ ' + (msg.error || '请求失败'), 'err');
    }
  };
  chrome.runtime.onMessage.addListener(msgHandler);

  // ===== 截图识文（第二阶段：结果面板跟随锚点 + 复制/保存/OCR/长图框选）=====
  // 消息键回退：content script ISOLATED 世界未必加载 shared/messages.js，故本文件内联常量
  const SS = (typeof self !== 'undefined' && self.HMDAO_MSG) || {};
  const SCREENSHOT_OPEN = SS.SCREENSHOT_OPEN || 'HMDAO_SCREENSHOT_OPEN';
  const SCREENSHOT_RESULT = SS.SCREENSHOT_RESULT || 'HMDAO_SCREENSHOT_RESULT';
  const SCREENSHOT_ERROR = SS.SCREENSHOT_ERROR || 'HMDAO_SCREENSHOT_ERROR';
  const SCREENSHOT_OCR_RESULT = SS.SCREENSHOT_OCR_RESULT || 'HMDAO_SCREENSHOT_OCR_RESULT';
  const SCREENSHOT_SAVE = SS.SCREENSHOT_SAVE || 'HMDAO_SCREENSHOT_SAVE';
  const SCREENSHOT_COPY = SS.SCREENSHOT_COPY || 'HMDAO_SCREENSHOT_COPY';
  const SCREENSHOT_OCR = SS.SCREENSHOT_OCR || 'HMDAO_SCREENSHOT_OCR';
  const SCREENSHOT_CANCEL = SS.SCREENSHOT_CANCEL || 'HMDAO_SCREENSHOT_CANCEL';
  const SCREENSHOT_REGION_READY = SS.SCREENSHOT_REGION_READY || 'HMDAO_SCREENSHOT_REGION_READY';

  const ssPanel = shadow.getElementById('hmSsPanel');
  const ssClose = shadow.getElementById('hmSsClose');
  const ssImg = shadow.getElementById('hmSsImg');
  const ssCropOverlay = shadow.getElementById('hmSsCropOverlay');
  const ssCropBox = shadow.getElementById('hmSsCropBox');
  const ssTranslate = shadow.getElementById('hmSsTranslate');
  const ssExtract = shadow.getElementById('hmSsExtract');
  const ssCopy = shadow.getElementById('hmSsCopy');
  const ssSave = shadow.getElementById('hmSsSave');
  const ssCropBtn = shadow.getElementById('hmSsCrop');
  const ssText = shadow.getElementById('hmSsText');
  const ssCopyText = shadow.getElementById('hmSsCopyText');
  const ssToast = shadow.getElementById('hmSsToast');

  let lastImage = null, isLong = false, ssW = null, ssH = null;
  let ssToastTimer = null;
  let ssCropping = false, ssCropSX = 0, ssCropSY = 0, ssCropRect = null;

  // 轻量 toast（content script 无侧栏 #status，独立实现）
  function toastSS(text) {
    if (!ssToast) return;
    ssToast.textContent = text || '';
    ssToast.style.display = 'block';
    if (ssToastTimer) clearTimeout(ssToastTimer);
    ssToastTimer = setTimeout(() => { ssToast.style.display = 'none'; }, 2600);
  }

  // 结果面板跟随机器人浮标（F4 核心）：fixed 坐标由 #hmAnchor 推算，越界翻到另一侧
  function repositionSS() {
    if (!ssPanel || !ssPanel.classList.contains('open')) return;
    const a = anchor.getBoundingClientRect();
    const w = ssPanel.offsetWidth || 300;
    const h = ssPanel.offsetHeight || 320;
    let left = a.right + 12;
    let top = a.bottom + 12;
    if (left + w > window.innerWidth - 8) left = a.left - w - 12; // 右侧越界 → 翻到左侧
    if (left < 8) left = 8;
    if (top + h > window.innerHeight - 8) top = a.top - h - 12;  // 下方越界 → 翻到上方
    if (top < 8) top = 8;
    ssPanel.style.left = left + 'px';
    ssPanel.style.top = top + 'px';
  }

  function showSsResult(payload) {
    if (!payload || !payload.dataUrl) return;
    if (marquee.classList.contains('on')) marquee.classList.remove('on'); // 与文本模式互斥
    lastImage = payload.dataUrl;
    isLong = !!payload.isLong;
    ssW = payload.width || null;
    ssH = payload.height || null;
    ssImg.src = payload.dataUrl;
    ssImg.onload = repositionSS; // 图片尺寸定稿后再次定位，避免初始 0 尺寸导致偏移
    ssImg.style.maxHeight = isLong ? '50vh' : '38vh';
    ssText.value = '';
    ssText.style.display = 'none';
    ssCopyText.style.display = 'none';
    ssCropBtn.style.display = isLong ? 'block' : 'none'; // 长图才显示「框选区域」
    ssPanel.classList.add('open');
    repositionSS();
  }

  function showSsError(text) {
    if (!ssPanel.classList.contains('open')) { ssPanel.classList.add('open'); repositionSS(); }
    toastSS(text || '出错了');
  }

  function showSsOcr(payload) {
    if (!payload) return;
    if (payload.licenseRequired) {
      ssText.value = (payload.error || '免费试用已结束') + '\n\n可点击「去订阅」继续使用。';
      ssText.style.display = 'block';
      ssCopyText.style.display = 'none';
      toastSS('试用已结束');
      return;
    }
    if (payload.text) {
      ssText.value = payload.text;
      ssText.style.display = 'block';
      ssCopyText.style.display = 'inline-block';
      toastSS('识别完成');
    } else if (payload.error) {
      ssText.value = '识别失败：' + payload.error;
      ssText.style.display = 'block';
      ssCopyText.style.display = 'none';
      toastSS('识别失败');
    }
  }

  // 监听来自 sidepanel 的截图消息（SCREENSHOT_RESULT / ERROR / OCR_RESULT）
  const ssHandler = (msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === SCREENSHOT_RESULT) showSsResult(msg.payload);
    else if (msg.type === SCREENSHOT_ERROR) showSsError(msg.payload && msg.payload.error);
    else if (msg.type === SCREENSHOT_OCR_RESULT) showSsOcr(msg.payload);
  };
  chrome.runtime.onMessage.addListener(ssHandler);

  // 受限页检测：robot 运行的页即 active tab，用自身地址判定（复刻 B8）
  function isRestrictedUrl(u) {
    if (!u) return false;
    if (/^(chrome:|chrome-extension:|chrome-untrusted:|edge:|devtools:|view-source:|data:)/i.test(u)) return true;
    if (/^about:/i.test(u) && !/^about:blank/i.test(u)) return true;
    try { const h = new URL(u).hostname; if (/chrome\.google\.com|chromewebstore\.google\.com/i.test(h)) return true; } catch (_) {}
    return false;
  }

  // 截图入口按钮（与 marquee 文本模式互斥）
  function startScreenshot(mode) {
    if (marquee.classList.contains('on')) marquee.classList.remove('on');
    if (isRestrictedUrl(window.location.href)) {
      toastSS('当前页面（chrome:// 等）不支持截图，请切换到普通网页');
      return;
    }
    chrome.runtime.sendMessage({ type: SCREENSHOT_OPEN, payload: { mode: mode } });
  }

  function sendSsOcr(task) {
    if (!lastImage) { toastSS('请先完成截图'); return; }
    // 不传 callback：由 sidepanel 协调器回传 SCREENSHOT_OCR_RESULT（并负责 license 跳转）
    chrome.runtime.sendMessage({ type: SCREENSHOT_OCR, payload: { image: lastImage, task: task, lang: 'zh' } });
  }

  // 长图框选区域（F3 UI）：在预览图上叠加框选层，按「显示尺寸→原图尺寸」裁切
  function startCropMode() {
    if (!lastImage || !isLong || !ssImg) return;
    ssCropping = true;
    ssCropOverlay.style.display = 'block';
    ssCropBox.style.display = 'none';
    ssCropOverlay.addEventListener('pointerdown', onCropDown);
    toastSS('在预览图上拖拽框选要保留的区域');
  }
  function onCropDown(e) {
    if (!ssCropping) return;
    const r = ssCropOverlay.getBoundingClientRect();
    ssCropSX = e.clientX - r.left; ssCropSY = e.clientY - r.top;
    ssCropRect = { x: ssCropSX, y: ssCropSY, w: 0, h: 0 };
    ssCropBox.style.display = 'block'; updateCropBox();
    ssCropOverlay.setPointerCapture && ssCropOverlay.setPointerCapture(e.pointerId);
    ssCropOverlay.addEventListener('pointermove', onCropMove);
    ssCropOverlay.addEventListener('pointerup', onCropUp);
    e.preventDefault();
  }
  function onCropMove(e) {
    const r = ssCropOverlay.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    const x = Math.min(ssCropSX, cx), y = Math.min(ssCropSY, cy);
    ssCropRect = { x, y, w: Math.abs(cx - ssCropSX), h: Math.abs(cy - ssCropSY) };
    updateCropBox();
  }
  function onCropUp() {
    ssCropOverlay.removeEventListener('pointermove', onCropMove);
    ssCropOverlay.removeEventListener('pointerup', onCropUp);
    ssCropping = false;
    ssCropOverlay.style.display = 'none';
    if (ssCropRect && ssCropRect.w > 4 && ssCropRect.h > 4) cropLastImage(ssCropRect);
  }
  function updateCropBox() {
    if (!ssCropRect) return;
    ssCropBox.style.left = ssCropRect.x + 'px';
    ssCropBox.style.top = ssCropRect.y + 'px';
    ssCropBox.style.width = ssCropRect.w + 'px';
    ssCropBox.style.height = ssCropRect.h + 'px';
  }
  function cropLastImage(rectDisplay) {
    const dispW = ssImg.clientWidth, dispH = ssImg.clientHeight;
    const natW = ssImg.naturalWidth, natH = ssImg.naturalHeight;
    if (!dispW || !dispH || !natW || !natH) return;
    const sx = Math.round(rectDisplay.x / dispW * natW);
    const sy = Math.round(rectDisplay.y / dispH * natH);
    const sw = Math.max(1, Math.round(rectDisplay.w / dispW * natW));
    const sh = Math.max(1, Math.round(rectDisplay.h / dispH * natH));
    const c = document.createElement('canvas'); c.width = sw; c.height = sh;
    try { c.getContext('2d').drawImage(ssImg, sx, sy, sw, sh, 0, 0, sw, sh); } catch (_) { return; }
    const cropped = c.toDataURL('image/png');
    lastImage = cropped; isLong = false; ssW = sw; ssH = sh;
    ssImg.src = cropped; ssCropBtn.style.display = 'none';
    toastSS('已裁切选中区域');
  }

  // 复制/保存直接在页面内执行（利用点击的用户激活，最可靠，可粘微信/QQ；失败再回退 background 消息）
  async function copyImageInPage(dataUrl) {
    try {
      const blob = await (await fetch(dataUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toastSS('✅ 已复制截图，到微信按 Ctrl+V 粘贴');
    } catch (e) {
      // 兜底：转交 background 在 MAIN 世界执行复制
      chrome.runtime.sendMessage({ type: SCREENSHOT_COPY, payload: { dataUrl: dataUrl } });
    }
  }
  function saveImageInPage(dataUrl) {
    const filename = 'Ddayup-截图-' + Date.now() + '.png';
    // Chrome downloads.download 不支持 blob:，用 data: URL 直下（content script 内同样有效）
    chrome.downloads.download({ url: dataUrl, filename: filename, saveAs: false })
      .then(() => toastSS('已保存到下载文件夹'))
      .catch((e) => { chrome.runtime.sendMessage({ type: SCREENSHOT_SAVE, payload: { dataUrl: dataUrl } }); });
  }

  // 绑定结果面板按钮
  ssClose.addEventListener('click', () => { ssPanel.classList.remove('open'); lastImage = null; });
  ssTranslate.addEventListener('click', () => sendSsOcr('translate'));
  ssExtract.addEventListener('click', () => sendSsOcr('ocr'));
  ssCopy.addEventListener('click', () => { if (lastImage) copyImageInPage(lastImage); });
  ssSave.addEventListener('click', () => { if (lastImage) saveImageInPage(lastImage); });
  ssCopyText.addEventListener('click', () => { if (ssText.value) navigator.clipboard.writeText(ssText.value).then(() => toastSS('已复制文字')).catch(() => toastSS('复制文字失败')); });
  ssCropBtn.addEventListener('click', () => startCropMode());
  window.addEventListener('resize', repositionSS);

  sendBtn.addEventListener('click', () => sendChat(text.value, 'chat'));
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(text.value, 'chat'); } });
  panel.querySelectorAll('.acts button').forEach((b) => {
    b.addEventListener('click', () => {
      const action = b.dataset.action;
      const mode = b.dataset.mode;
      // 截图识文入口（第二阶段）：与文本模式互斥，走 sidepanel 协调器
      if (mode === 'screenshot-region') { startScreenshot('region'); return; }
      if (mode === 'screenshot-long') { startScreenshot('long'); return; }
      if (action === 'upload') { fileInput.click(); return; }
      if (action === 'deep') { pendingDeep = true; fileInput.click(); return; }
      if (action === 'analyze-page') {
        startSelect();
        return;
      }
      const t = text.value.trim() || '请处理当前选中的素材';
      sendChat(t, b.dataset.mode);
    });
  });

  // 上传图片/视频 → 经 background 落地画布素材库并触发 SmartAgent 媒体工作流
  const fileInput = panel.querySelector('#hmFile');
  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    if (busy) { addRow('上一项还在处理中，请稍候', 'err'); return; }
    const deep = pendingDeep; pendingDeep = false;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      busy = true; sendBtn.disabled = true; statusEl.textContent = deep ? '正在深度分析并上传到画布智能体…' : '正在上传到画布智能体…';
      addRow((deep ? '🧠 深度分析：' : '📎 上传：') + f.name, 'me');
      chrome.runtime.sendMessage({
        type: 'HMDAO_AGENT_UPLOAD',
        payload: { fileName: f.name, mime: f.type, data: dataUrl, userText: text.value.trim(), deepAnalyze: deep },
      }).catch((err) => {
        statusEl.textContent = ''; addRow('上传失败：' + (err && err.message || err), 'err'); busy = false; sendBtn.disabled = false;
      });
      text.value = '';
      busyTimer = setTimeout(() => {
        if (busy) { busy = false; sendBtn.disabled = false; statusEl.textContent = '⏱ 上传超时，请确认 127.0.0.1:3000 已打开'; }
      }, 30000);
    };
    reader.readAsDataURL(f);
    fileInput.value = '';
  });

  addRow('你好，我是 Ddayup 智能助手。我可以总结素材、翻译、反推提示词，或回答你关于素材的问题。', 'bot');
})();
