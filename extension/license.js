// Ddayup 素材采集扩展 · 登录 / 7 天免费试用 / 付费许可闸门
// 与后端 /api/extension/* 配合；授权判定以服务端为准，本文件只做展示与动作拦截。
(function () {
  // API 地址：默认本机 3000，可由 config.setApiBase() 经 chrome.storage 覆盖（上云时用）。
  // 统一走 window.DdayupConfig（config-runtime.js），与 sidepanel 单点配置。
  function apiBase() {
    if (typeof window !== 'undefined' && window.DdayupConfig) {
      return window.DdayupConfig.getApiBase();
    }
    return Promise.resolve('http://127.0.0.1:3000');
  }
  const TRIAL_DAYS = 7;
  // 付费模式：false=7 天试用结束后阻断采集功能，付费（微信/Paddle，在官网网页完成）后恢复。
  // 支付不内置进扩展（Edge 禁止内嵌支付 UI），扩展只放"去官网订阅"按钮并查询授权状态。
  const FREE_MODE = (typeof window !== 'undefined' && window.DdayupConfig)
    ? window.DdayupConfig.FREE_MODE
    : false;

  function getDeviceId() {
    return new Promise((resolve) => {
      chrome.storage.local.get('hmdaoDeviceId', (o) => {
        if (o && o.hmdaoDeviceId) return resolve(o.hmdaoDeviceId);
        const id = 'dd-' + (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));
        chrome.storage.local.set({ hmdaoDeviceId: id }, () => resolve(id));
      });
    });
  }

  async function postJSON(p, body) {
    const base = await apiBase();
    return fetch(base + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json().catch(() => ({ success: false })));
  }

  async function refreshState() {
    const deviceId = await getDeviceId();
    const cached = await new Promise((res) => chrome.storage.local.get('hmdaoLicense', (o) => res(o.hmdaoLicense || null)));
    let st = null;
    try { st = await postJSON('/api/extension/license/status', { deviceId }); } catch (_) { /* 离线用缓存 */ }
    if (!st || st.success === false) {
      return cached || { mode: 'trial', trialDaysLeft: TRIAL_DAYS, offline: true };
    }
    // ★2026-08-31 用户要求「重置过期恢复 7 天体验」（FREE_MODE 免费版）：
    //   后端返回 expired 时，前端强制包装为 trial，恢复徽章「试用 7天」，并保证 gate() 在 FREE_MODE 下始终放行。
    //   不改后端，只是把后端的 expired 在前端表现层复位为 trial（后端仍记录过期时间，下次 refresh 再次包装即可）。
    if (FREE_MODE && st.mode === 'expired') {
      st = Object.assign({}, st, { mode: 'trial', trialDaysLeft: TRIAL_DAYS });
    }
    const merged = Object.assign({}, st, { cachedAt: Date.now() });
    chrome.storage.local.set({ hmdaoLicense: merged });
    return merged;
  }

  async function ensureTrial() {
    const deviceId = await getDeviceId();
    const st = await refreshState();
    if (st.mode === 'none') {
      try { await postJSON('/api/extension/trial/start', { deviceId }); } catch (_) {}
    }
    return refreshState();
  }

  async function login(email, password) {
    const deviceId = await getDeviceId();
    const r = await postJSON('/api/extension/account/login', { email, password, deviceId });
    if (r && r.success) {
      chrome.storage.local.set({ hmdaoToken: r.token, hmdaoLicense: Object.assign({}, r, { cachedAt: Date.now() }) });
    }
    return r;
  }

  // 注册即开通 7 天试用（后端自动建号）
  async function register(email, password) {
    const deviceId = await getDeviceId();
    const r = await postJSON('/api/extension/account/register', { email, password, deviceId });
    if (r && r.success) {
      chrome.storage.local.set({ hmdaoToken: r.token, hmdaoLicense: Object.assign({}, r, { cachedAt: Date.now() }) });
    }
    return r;
  }

  // 跳转官网结账页（Edge 禁止扩展内嵌支付 UI，只能跳转网页完成支付）
  async function goToPricing() {
    const deviceId = await getDeviceId();
    const token = await new Promise((res) => chrome.storage.local.get('hmdaoToken', (o) => res((o && o.hmdaoToken) || '')));
    const base = await apiBase();
    const url = base + '/pricing?deviceId=' + encodeURIComponent(deviceId || '') +
      (token ? '&token=' + encodeURIComponent(token) : '');
    if (typeof chrome !== 'undefined' && chrome.tabs) chrome.tabs.create({ url });
    else window.open(url, '_blank');
  }

  async function activate(key) {
    const deviceId = await getDeviceId();
    const r = await postJSON('/api/extension/license/activate', { deviceId, key });
    if (r && r.success) {
      chrome.storage.local.set({ hmdaoLicense: Object.assign({}, r, { cachedAt: Date.now() }) });
    }
    return r;
  }

  function showPaywall(state, block) {
    const el = document.getElementById('licensePaywall');
    if (!el) return;
    // 非阻断模式（免费版 expired）：不弹付费墙，仅更新状态徽章提示。
    if (block === false) { hidePaywall(); updateTrialBadge(state); return; }
    el.style.display = 'flex';
    const info = el.querySelector('#lpInfo');
    if (info) {
      if (state && state.mode === 'expired') {
        info.textContent = `免费试用已结束（${TRIAL_DAYS} 天）。请登录账号或激活付费许可证后继续使用素材采集。`;
      } else if (state && state.mode === 'trial') {
        info.textContent = `免费试用剩余 ${state.trialDaysLeft != null ? state.trialDaysLeft : TRIAL_DAYS} 天。可登录账号或激活许可证以长期使用。`;
      } else {
        info.textContent = `登录账号或激活许可证以开始使用 Ddayup 素材采集。`;
      }
    }
    updateTrialBadge(state);
  }
  function hidePaywall() {
    const el = document.getElementById('licensePaywall');
    if (el) el.style.display = 'none';
  }
  function updateTrialBadge(state) {
    const badge = document.getElementById('trialBadge');
    if (!badge) return;
    if (state && state.mode === 'paid') { badge.textContent = '已授权'; badge.className = 'lic-badge paid'; }
    else if (state && state.mode === 'trial') { badge.textContent = `试用 ${state.trialDaysLeft != null ? state.trialDaysLeft : TRIAL_DAYS}天`; badge.className = 'lic-badge trial'; }
    else if (state && state.mode === 'expired') { badge.textContent = '已过期'; badge.className = 'lic-badge expired'; }
    else { badge.textContent = ''; badge.className = 'lic-badge'; }
  }

  async function gate() {
    const st = await refreshState();
    if (st.mode === 'expired') {
      // 免费版（FREE_MODE）下：仅提示，不阻断核心采集功能，符合 Edge 审核要求。
      if (FREE_MODE) { showPaywall(st, /*block*/ false); updateTrialBadge(st); return true; }
      showPaywall(st, /*block*/ true); return false;
    }
    hidePaywall();
    updateTrialBadge(st);
    return true;
  }

  function wirePaywall() {
    const el = document.getElementById('licensePaywall');
    if (!el) return;
    const lpStatus = el.querySelector('#lpStatus');
    el.querySelector('#lpLogin').addEventListener('click', async () => {
      const email = el.querySelector('#lpEmail').value.trim();
      const pwd = el.querySelector('#lpPassword').value;
      lpStatus.textContent = '登录中…';
      const r = await login(email, pwd);
      if (r && r.success) { lpStatus.textContent = '登录成功，试用期已激活。'; hidePaywall(); updateTrialBadge(r); }
      else { lpStatus.textContent = (r && r.error && r.error.message) || '登录失败'; }
    });
    const lpRegister = el.querySelector('#lpRegister');
    if (lpRegister) lpRegister.addEventListener('click', async () => {
      const email = el.querySelector('#lpEmail').value.trim();
      const pwd = el.querySelector('#lpPassword').value;
      if (!email || pwd.length < 6) { lpStatus.textContent = '请填写邮箱且密码至少 6 位'; return; }
      lpStatus.textContent = '注册中…';
      const r = await register(email, pwd);
      if (r && r.success) {
        if (r.passwordReset) {
          lpStatus.textContent = '原密码已重置为新密码，7 天试用已开通！请用新密码登录。';
        } else if (r.upgraded) {
          lpStatus.textContent = '账户已升级到新格式，7 天试用已开通！';
        } else {
          lpStatus.textContent = '注册成功，7 天试用已开通！';
        }
        hidePaywall(); updateTrialBadge(r);
      }
      else { lpStatus.textContent = (r && r.error && r.error.message) || '注册失败'; }
    });
    const lpUpgrade = el.querySelector('#lpUpgrade');
    if (lpUpgrade) lpUpgrade.addEventListener('click', () => { goToPricing(); });
    el.querySelector('#lpActivate').addEventListener('click', async () => {
      const key = el.querySelector('#lpKey').value.trim();
      lpStatus.textContent = '激活中…';
      const r = await activate(key);
      if (r && r.success) { lpStatus.textContent = '激活成功，感谢支持！'; hidePaywall(); updateTrialBadge(r); }
      else { lpStatus.textContent = (r && r.error && r.error.message) || '激活失败'; }
    });
    const close = el.querySelector('#lpClose');
    if (close) close.addEventListener('click', () => hidePaywall());
  }

  // 自动初始化：确保试用已启动；过期时遵循 FREE_MODE（与 gate() 一致）
  async function init() {
    try {
      const st = await ensureTrial();
      updateTrialBadge(st);
      if (st.mode === 'expired') {
        // ★2026-08-22 修复（重启/重开浏览器后强制弹付费墙）：
        // 旧逻辑 showPaywall(st) 不传 block → FREE_MODE=true 下仍强制弹付费墙，导致用户每次重启都看到
        // "免费试用已结束，请登录"对话框，必须手动关掉才能继续使用（与 gate() 行为不一致）。
        // 与 gate() 对齐：FREE_MODE=true 下仅更新试用徽章提示，不弹墙、不阻断核心采集。
        showPaywall(st, /*block*/ FREE_MODE ? false : true);
      } else hidePaywall();
    } catch (_) { /* 后端不可达：不打断采集，仅不显示墙 */ }
  }

  window.HMDaoLicense = {
    getDeviceId, refreshState, ensureTrial, login, register, activate, goToPricing, showPaywall, hidePaywall, gate, TRIAL_DAYS,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { wirePaywall(); init(); });
  } else {
    wirePaywall(); init();
  }
})();
