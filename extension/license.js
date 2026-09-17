// Ddayup 素材采集扩展 · 登录 / 7 天免费试用 / 付费许可闸门
// 与后端 /api/extension/* 配合；授权判定以服务端为准，本文件只做展示与动作拦截。
(function () {
  // API 地址：默认本机 3000，可由 config.setApiBase() 经 chrome.storage 覆盖（上云时用）。
  // 统一走 window.DdayupConfig（config-runtime.js），与 sidepanel 单点配置。
  function apiBase() {
    if (typeof window !== 'undefined' && window.DdayupConfig) {
      return window.DdayupConfig.getApiBase();
    }
    return Promise.resolve('https://mingmingchuangyi.cn');
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

  // 统一落库：授权状态 + 离线判定所需的影子键一起写。
  // ★四个键缺一不可：hmdaoLicenseFetched / hmdaoLastMode / hmdaoLastPlan 是 refreshState()
  //   在「离线且缓存丢失」时的判定依据。若只在 refreshState 里写，则「登录/注册/激活成功后
  //   立刻清缓存 + 断网」会被误判，付费用户甚至被降级为 expired。
  function persistLicenseState(json, extra) {
    const merged = Object.assign({}, json, { cachedAt: Date.now() });
    chrome.storage.local.set(Object.assign({
      hmdaoLicense: merged,
      hmdaoLicenseFetched: true,
      hmdaoLastMode: merged.mode || null,
      hmdaoLastPlan: merged.plan || null,
    }, extra || {}));
    return merged;
  }

  async function postJSON(p, body) {
    const base = await apiBase();
    return fetch(base + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // ★M4：超时护栏，避免后端挂起时登录/自动重登长期 pending（账号面板一直空转）
      signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(15000) : undefined,
    }).then((r) => r.json().catch(() => ({ success: false })));
  }

  async function refreshState() {
    const deviceId = await getDeviceId();
    const store = await new Promise((res) => chrome.storage.local.get(
      ['hmdaoLicense', 'hmdaoLicenseFetched', 'hmdaoLastMode', 'hmdaoLastPlan'], (o) => res(o || {})));
    const cached = store.hmdaoLicense || null;
    const everFetched = !!store.hmdaoLicenseFetched;
    let st = null;
    try { st = await postJSON('/api/extension/license/status', { deviceId }); } catch (_) { /* 离线用缓存 */ }
    if (!st || st.success === false) {
      // 离线 / 后端不可达：优先尊重本地缓存的真实状态。
      // ★P0 加固（2026-09-14）：旧逻辑「无缓存就回退 trial」可被「清空缓存 + 断网」反复白嫖。
      //   现改为：只要曾成功取到过服务端状态，离线时沿用最后一次已知状态，不再无条件送试用；
      //   仅「全新安装且首次联网就失败」才回退 trial，避免把真实新用户永久锁死。
      if (cached) {
        // 离线缓存同样要做到期校验：否则付费到期后只要断网，就能凭旧缓存无限按 paid 使用
        if (cached.paidUntil && cached.paidUntil < Date.now()) return { mode: 'expired', offline: true };
        if (cached.trialEndsAt && cached.trialEndsAt < Date.now()) return { mode: 'expired', offline: true };
        return Object.assign({}, cached, { offline: true });
      }
      if (everFetched) {
        if (store.hmdaoLastMode === 'paid') {
          // 付费用户离线不应被降级：沿用已购状态（到期判定仍由服务端在恢复联网后校正）
          return { mode: 'paid', plan: store.hmdaoLastPlan || null, offline: true };
        }
        if (store.hmdaoLastMode === 'trial') {
          return { mode: 'trial', trialDaysLeft: TRIAL_DAYS, offline: true };
        }
        return { mode: 'expired', offline: true };
      }
      return { mode: 'trial', trialDaysLeft: TRIAL_DAYS, offline: true };
    }
    const merged = Object.assign({}, st, { cachedAt: Date.now() });
    chrome.storage.local.set({
      hmdaoLicense: merged,
      hmdaoLicenseFetched: true,
      hmdaoLastMode: merged.mode || null,
      hmdaoLastPlan: merged.plan || null,
    });
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

  // force=true：用户已确认「踢出旧设备继续」，服务端先解除同账号其他设备的绑定再放行。
  async function login(email, password, opts) {
    const deviceId = await getDeviceId();
    const r = await postJSON('/api/extension/account/login', { email, password, deviceId, force: !!(opts && opts.force) });
    if (r && r.success) {
      persistLicenseState(r, { hmdaoToken: r.token });
      await onAuthSuccess(email, password, opts);
    }
    return r;
  }

  // 注册即开通 7 天试用（后端自动建号）
  async function register(email, password, opts) {
    const deviceId = await getDeviceId();
    const r = await postJSON('/api/extension/account/register', { email, password, deviceId, force: !!(opts && opts.force) });
    if (r && r.success) {
      persistLicenseState(r, { hmdaoToken: r.token });
      await onAuthSuccess(email, password, opts);
    }
    return r;
  }

  // 跳转官网结账页（Edge 禁止扩展内嵌支付 UI，只能跳转网页完成支付）
  async function goToPricing() {
    const deviceId = await getDeviceId();
    const token = await new Promise((res) => chrome.storage.local.get('hmdaoToken', (o) => res((o && o.hmdaoToken) || '')));
    const base = await apiBase();
    // 指向独立定价页文件 /pricing.html（静态代理对无后缀 /pricing 会 fallback 到 SPA index.html，
    // 只有 .html 才命中真实文件）。后端订阅回跳 /pricing 同理。
    const url = base + '/pricing.html?deviceId=' + encodeURIComponent(deviceId || '') +
      (token ? '&token=' + encodeURIComponent(token) : '');
    if (typeof chrome !== 'undefined' && chrome.tabs) chrome.tabs.create({ url });
    else window.open(url, '_blank');
  }

  async function activate(key) {
    const deviceId = await getDeviceId();
    const r = await postJSON('/api/extension/license/activate', { deviceId, key });
    if (r && r.success) persistLicenseState(r);
    return r;
  }

  // ===== 本机记住密码 + 自动重登（2026-09-14：官网 / 侧栏同一套账号打通）=====
  // 用户勾选「记住我」后凭据存本机 chrome.storage.local，重开浏览器或重开侧栏可静默自动登录。
  // ★仅本地存储、仅经扩展内部通道（background ↔ 内容脚本）传递，绝不发往任何后端；登出即清除。
  const REMEMBER_KEY = 'hmdaoRememberedCreds';
  async function saveRememberedCreds(email, password) {
    if (!email || !password) return;
    await new Promise((res) => chrome.storage.local.set({
      [REMEMBER_KEY]: { email: String(email), password: String(password), savedAt: Date.now() },
    }, () => res()));
  }
  async function getRememberedCreds() {
    const o = await new Promise((res) => chrome.storage.local.get(REMEMBER_KEY, (v) => res(v || {})));
    const c = o && o[REMEMBER_KEY];
    return (c && c.email && c.password) ? c : null;
  }
  async function clearRememberedCreds() {
    await new Promise((res) => chrome.storage.local.remove(REMEMBER_KEY, () => res()));
  }

  // 登录 / 注册成功统一收口：按 opts.remember（默认 true）持久化或清除本机凭据，
  // 并通知 background 主动把登录态推给已打开的官网标签（官网免重复输入）。
  async function onAuthSuccess(email, password, opts) {
    const remember = !(opts && opts.remember === false);
    try {
      if (remember) await saveRememberedCreds(email, password);
      else await clearRememberedCreds();
    } catch (_) { /* 存储失败不影响登录 */ }
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        const p = chrome.runtime.sendMessage({ type: 'HMDAO_NOTIFY_EXT_LOGIN' });
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
    } catch (_) { /* background 未就绪时忽略 */ }
  }

  // 打开侧栏 / 账号面板时调用：本机存有凭据且当前未登录 → 静默重登（不踢其他设备、不带 force）。
  async function autoLoginIfRemembered(opts) {
    const creds = await getRememberedCreds().catch(() => null);
    if (!creds) return { success: false, skipped: 'no-creds' };
    if (!(opts && opts.skipTokenCheck)) {
      const token = await getToken();
      if (token) return { success: true, skipped: 'has-token', email: creds.email };
    }
    const r = await login(creds.email, creds.password, { remember: true });
    // ★M1：密码已被修改 / 账号不存在等「凭据永久失效」错误 → 清掉本机凭据，
    //   否则每次开侧栏/开面板都会拿旧密码反复撞后端（触发限流/账户锁定）。
    const code = r && r.error && r.error.code;
    if (r && r.success === false && (code === 'INVALID_CRED' || code === 'NO_USER')) {
      try { await clearRememberedCreds(); } catch (_) { /* ignore */ }
    }
    return Object.assign({}, r, { auto: true, email: creds.email, credsCleared: code === 'INVALID_CRED' || code === 'NO_USER' });
  }

  // ★设备冲突 UX（2026-09-14）：账号已在其他设备登录时，用户显式确认后带 force=true 重登（踢出旧设备）。
  //   与自动重登严格区分：自动路径永不 force（绝不静默踢掉用户其它设备），
  //   force 只在用户点了「踢出旧设备并登录」并二次确认后才使用。
  async function forceLoginWithRemembered() {
    const creds = await getRememberedCreds().catch(() => null);
    if (!creds) return { success: false, error: { code: 'NO_CREDS', message: '本机未记住账号密码，请在授权面板输入后登录' } };
    return login(creds.email, creds.password, { force: true, remember: true });
  }

  // 退出登录：只清「登录令牌 + 本机记住的凭据」。
  // ★H2（2026-09-14 修复）：绝不能连带清除 hmdaoLicenseFetched / hmdaoLastMode / hmdaoLastPlan ——
  //   这三个影子键是 refreshState() 的离线判定依据，清掉会重开「登出 → 断网 → 白嫖 trial」的口子。
  //   授权本身按 deviceId 记录在服务端，登出账号不应影响本机既有授权缓存。
  async function logout() {
    await new Promise((res) => chrome.storage.local.remove(['hmdaoToken', REMEMBER_KEY], () => res()));
    return { success: true };
  }

  // 读取已登录令牌（登录/注册后由后端下发并存入 chrome.storage.local）
  async function getToken() {
    return new Promise((res) => chrome.storage.local.get('hmdaoToken', (o) => res((o && o.hmdaoToken) || '')));
  }

  // 携带 Bearer 令牌的鉴权请求（用于设备列表/解绑/订单/账号信息等敏感端点）
  async function authed(method, p, body) {
    const base = await apiBase();
    const token = await getToken();
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const init = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    // ★M4：同上，鉴权请求同样加超时护栏
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) init.signal = AbortSignal.timeout(15000);
    return fetch(base + p, init).then(async (r) => {
      let json;
      try { json = await r.json(); } catch { json = {}; }
      if (!r.ok) return Object.assign({ success: false, status: r.status }, json);
      return json;
    }).catch(() => ({ success: false }));
  }
  const postJSONAuth = (p, body) => authed('POST', p, body);
  const getAuth = (p) => authed('GET', p);

  async function fetchProfile() { return getAuth('/api/extension/account/profile'); }
  async function fetchDevices() { return getAuth('/api/extension/devices'); }
  async function fetchOrders() { return getAuth('/api/extension/orders'); }
  async function unbindDevice(id) { return postJSONAuth('/api/extension/devices/' + encodeURIComponent(id) + '/unbind', {}); }

  // 忘记密码：打开官网重置页（复用官网 /api/auth/reset-password 后端）
  async function openForgotPassword() {
    const base = (typeof window !== 'undefined' && window.DdayupConfig && window.DdayupConfig.getApiBaseSync())
      ? window.DdayupConfig.getApiBaseSync() : 'https://mingmingchuangyi.cn';
    const url = base + '/reset-password';
    if (typeof chrome !== 'undefined' && chrome.tabs) chrome.tabs.create({ url });
    else window.open(url, '_blank');
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

  // 供侧栏「刷新授权」按钮调用：重新拉取授权状态，并同步更新徽章 / 横幅 / 付费墙。
  // 解决「付款或登录后扩展不感知、需重开面板」的问题。
  async function refreshLicenseUI() {
    const st = await refreshState();
    updateTrialBadge(st);
    renderLicNotice(st);
    if (st.mode === 'expired' && !FREE_MODE) { showPaywall(st, /*block*/ true); }
    else { hidePaywall(); }
    return st;
  }
  function updateTrialBadge(state) {
    const badge = document.getElementById('trialBadge');
    if (!badge) return;
    if (state && state.mode === 'paid') {
      // ★按档位区分标签：月付 / 季付 / 年付 / 永久解锁。
      //   仅当剩余 ≤5 天才追加倒计时，避免长期订阅用户天天被数字提醒（产品要求）。
      const plan = state.plan;
      let label = '已授权';
      if (plan === 'lifetime') label = '永久解锁';
      else if (plan === 'monthly') label = '月付';
      else if (plan === 'quarterly') label = '季付';
      else if (plan === 'yearly') label = '年付';
      if (plan !== 'lifetime' && typeof state.paidUntil === 'number') {
        const daysLeft = Math.ceil((state.paidUntil - Date.now()) / 86400000);
        if (daysLeft >= 0 && daysLeft <= 5) label += ` · 剩余${daysLeft}天`;
      }
      badge.textContent = label;
      badge.className = 'lic-badge paid';
    }
    else if (state && state.mode === 'trial') { badge.textContent = `试用 ${state.trialDaysLeft != null ? state.trialDaysLeft : TRIAL_DAYS}天`; badge.className = 'lic-badge trial'; }
    else if (state && state.mode === 'expired') { badge.textContent = '已过期'; badge.className = 'lic-badge expired'; }
    else { badge.textContent = ''; badge.className = 'lic-badge'; }
  }

  // 到期提醒横幅（紧凑横向排版，窄幅自动换行）：
  //   · 试用剩余 ≤3 天 → 「立即订阅」
  //   · 已过期        → 「立即订阅」
  //   · 付费剩余 ≤5 天 → 「续费」
  // ★按钮统一跳「订阅付费页」goToPricing()（/pricing.html?deviceId=&token=）。
  //   此前它跳 /register（画布注册页），导致用户注册完仍找不到付费入口 —— 已修正。
  //   登录/注册引导归属「账号」面板（见 sidepanel.js 账号中心），与本横幅各司其职。
  function renderLicNotice(st) {
    const el = document.getElementById('licNotice');
    if (!el) return;
    const decorate = (danger) => {
      el.style.display = 'flex';
      el.style.flexWrap = 'wrap';          // ★窄幅自动换行，避免文字被挤成逐字一列
      el.style.alignItems = 'center';
      el.style.gap = '6px';
      el.style.padding = '5px 8px';        // 尺寸减半：原 10px 14px
      el.style.margin = '0 0 8px';         // 原 14px
      el.style.borderRadius = '8px';
      el.style.fontSize = '11px';          // 原 13px
      el.style.lineHeight = '1.45';
      if (danger) {
        el.style.background = '#2b1414'; el.style.border = '1px solid #7f1d1d'; el.style.color = '#fecaca';
      } else {
        el.style.background = '#1f2a14'; el.style.border = '1px solid #4d7c0f'; el.style.color = '#d9f99d';
      }
      const txt = el.querySelector('#licNoticeText');
      if (txt) { txt.style.flex = '1 1 auto'; txt.style.minWidth = '0'; }
      const b = el.querySelector('#licNoticeGo');
      if (b) {
        b.style.flexShrink = '0';
        b.style.border = '0';
        b.style.background = danger ? '#dc2626' : '#65a30d';
        b.style.color = '#fff';
        b.style.padding = '3px 8px';       // 尺寸减半：原 6px 12px
        b.style.borderRadius = '6px';
        b.style.cursor = 'pointer';
        b.style.fontSize = '10px';         // 原 13px
        b.style.whiteSpace = 'nowrap';
        b.onclick = () => { goToPricing(); };
      }
    };
    if (st && st.mode === 'expired') {
      el.innerHTML = '<span id="licNoticeText">试用已结束，采集已暂停 · 订阅后恢复</span>'
        + ' <button id="licNoticeGo">立即订阅</button>';
      decorate(true);
      return;
    }
    if (st && st.mode === 'trial' && typeof st.trialDaysLeft === 'number' && st.trialDaysLeft <= 3) {
      el.innerHTML = `<span id="licNoticeText">试用剩余 <b>${st.trialDaysLeft}</b> 天 · 订阅后可继续使用</span>`
        + ' <button id="licNoticeGo">立即订阅</button>';
      decorate(false);
      return;
    }
    // 付费用户剩余 ≤5 天：提示续费（与徽章倒计时口径一致）
    if (st && st.mode === 'paid' && st.plan !== 'lifetime' && typeof st.paidUntil === 'number') {
      const daysLeft = Math.ceil((st.paidUntil - Date.now()) / 86400000);
      if (daysLeft >= 0 && daysLeft <= 5) {
        el.innerHTML = `<span id="licNoticeText">订阅剩余 <b>${daysLeft}</b> 天 · 续费不中断</span>`
          + ' <button id="licNoticeGo">续费</button>';
        decorate(false);
        return;
      }
    }
    el.style.display = 'none';
  }

  async function gate() {
    const st = await refreshState();
    renderLicNotice(st);
    if (st.mode === 'expired') {
      // 硬阻断模式：过期后拦截核心采集功能，并弹出付费墙引导订阅。
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
    const lpLogin = el.querySelector('#lpLogin');
    const lpRegister = el.querySelector('#lpRegister');
    const lpRemember = el.querySelector('#lpRemember');
    const lpEmailEl = el.querySelector('#lpEmail');
    const lpPasswordEl = el.querySelector('#lpPassword');
    // 回填本机记住的邮箱/密码：勾选过「记住我」的用户直接点「登录」即可，无需重复输入。
    (async () => {
      try {
        const c = await getRememberedCreds();
        if (c) {
          if (lpEmailEl && !lpEmailEl.value) lpEmailEl.value = c.email || '';
          if (lpPasswordEl && !lpPasswordEl.value) lpPasswordEl.value = c.password || '';
          if (lpRemember) lpRemember.checked = true;
        }
      } catch (_) { /* ignore */ }
    })();
    // 多端冲突二次确认：首次登录撞 NEW_DEVICE_CONFLICT 后，把按钮翻转为「踢出旧设备并登录」，
    // 用户再次点击才带 force=true 上报，避免静默踢掉自己的其他设备。
    let pendingForce = false;
    const resetLoginBtn = () => { if (lpLogin) lpLogin.textContent = '登录'; pendingForce = false; };
    lpLogin.addEventListener('click', async () => {
      const email = el.querySelector('#lpEmail').value.trim();
      const pwd = el.querySelector('#lpPassword').value;
      const remember = !(lpRemember && !lpRemember.checked);
      lpStatus.textContent = '登录中…';
      const r = await login(email, pwd, { force: pendingForce, remember });
      if (r && r.success) {
        lpStatus.textContent = '登录成功，试用期已激活。';
        resetLoginBtn(); hidePaywall(); updateTrialBadge(r);
      } else if (r && r.error && r.error.code === 'NEW_DEVICE_CONFLICT') {
        pendingForce = true;
        if (lpLogin) lpLogin.textContent = '踢出旧设备并登录';
        lpStatus.textContent = '该账号已在其他设备登录。继续将踢出旧设备（其已购订阅仍会保留在该设备上）；也可到原设备「账号中心 → 我的设备」中解绑后再登录。';
      } else { lpStatus.textContent = (r && r.error && r.error.message) || '登录失败'; }
    });
    if (lpRegister) lpRegister.addEventListener('click', async () => {
      const email = el.querySelector('#lpEmail').value.trim();
      const pwd = el.querySelector('#lpPassword').value;
      if (!email || pwd.length < 6) { lpStatus.textContent = '请填写邮箱且密码至少 6 位'; return; }
      const remember = !(lpRemember && !lpRemember.checked);
      lpStatus.textContent = '注册中…';
      const r = await register(email, pwd, { force: pendingForce, remember });
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
    // 付款 / 登录完成后无需重开面板：点此立即刷新授权
    const lpRefreshBtn = el.querySelector('#lpRefresh');
    if (lpRefreshBtn) lpRefreshBtn.addEventListener('click', async () => {
      lpStatus.textContent = '正在刷新授权…';
      const st = await refreshLicenseUI();
      lpStatus.textContent = st.mode === 'paid'
        ? '已确认订阅，感谢支持！'
        : (st.mode === 'trial' ? '当前为试用中。' : '暂未查询到有效授权，请确认已完成支付。');
    });
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
      renderLicNotice(st);
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
    refreshLicenseUI,
    getToken, fetchProfile, fetchDevices, fetchOrders, unbindDevice, openForgotPassword,
    // 本机记住密码 / 自动重登 / 退出（2026-09-14）
    saveRememberedCreds, getRememberedCreds, clearRememberedCreds, autoLoginIfRemembered, logout, forceLoginWithRemembered,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { wirePaywall(); init(); });
  } else {
    wirePaywall(); init();
  }
})();
