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
    if (msgHandler) chrome.runtime.onMessage.removeListener(msgHandler);
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

  sendBtn.addEventListener('click', () => sendChat(text.value, 'chat'));
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(text.value, 'chat'); } });
  panel.querySelectorAll('.acts button').forEach((b) => {
    b.addEventListener('click', () => {
      const action = b.dataset.action;
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
