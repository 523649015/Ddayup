// ===== 消息路由表（D1 基础设施）=====
// 将原 onMessage 中的巨型 if 分支逐步迁移为注册式 handler，降低 background.js 单文件耦合。
// 约定：每个 handler 形如 async (msg, sender, sendResponse) => boolean
//   - 返回 true 表示已接管消息且会异步调用 sendResponse（保持 Chrome 消息通道打开）
//   - 返回 false 表示已同步响应或无需响应
//   - 未注册的类型由 background.js 原有 if 链兜底，保证运行时行为不变。
// 注意：handler 与 background.js 同处 SW 全局作用域（importScripts 引入），
// 可直接读写 SOURCE_TAB_ID / NETWORK_ASSETS 等背景全局变量。

const HANDLERS = {};

function registerHandler(type, fn) {
  HANDLERS[type] = fn;
}

// 是否存在已注册的 handler（供 onMessage 同步判断，避免误判 Promise-truthy）。
function hasHandler(msg) {
  return !!(msg && msg.type && HANDLERS[msg.type]);
}

// 统一分发：同步调用命中的 handler 并同步返回其布尔结果（true=异步保持通道）。
// 注意：本函数必须保持同步返回 boolean —— Chrome onMessage 依据该返回值决定是否保持
// 消息通道。若返回 Promise，外层 `if (x) return true` 会因 Promise 恒 truthy 而误拦截
// 所有消息（含未注册类型），导致原 if 链被跳过、通道挂起。故 handler 自身负责内部异步。
function dispatchMessage(msg, sender, sendResponse) {
  const fn = HANDLERS[msg && msg.type];
  if (!fn) return false;
  return fn(msg, sender, sendResponse) === true;
}

// ---- 网盘深度解析（原 NETDISK_RESOLVE 分支，自包含、零上下文依赖）----
registerHandler(HMDAO_MSG.NETDISK_RESOLVE, (msg, _sender, sendResponse) => {
  (async () => {
    try {
      const url = msg.url || '';
      let m;
      if ((m = url.match(/pan\.baidu\.com\/s\/([\w-]+)/))) {
        const pwd = (url.match(/[?&]pwd=([\w]+)/) || [])[1] || '';
        const tab = await chrome.tabs.create({ url, active: true });
        // eslint-disable-next-line no-undef -- SOURCE_TAB_ID 是 background.js 经 importScripts 引入的全局变量，运行时可见
        SOURCE_TAB_ID = tab.id;
        const result = await new Promise((resolve) => {
          const to = setTimeout(() => resolve({ ok: false, error: 'timeout' }), 15000);
          const iv = setInterval(async () => {
            try {
              const [r] = await chrome.scripting.executeScript({
                target: { tabId: tab.id }, world: 'ISOLATED',
                func: (pwd) => {
                  const inp = document.querySelector('input[placeholder*="提取" i], input[name="pwd"], input.accessKey, .pwd-input input, #accessCode, #pwd');
                  if (inp && !inp.value && pwd) { inp.value = pwd; inp.dispatchEvent(new Event('input', { bubbles: true })); }
                  const btn = Array.from(document.querySelectorAll('button')).find((b) => /提取|确定|提交|进入|解压/i.test(b.textContent || '')) || document.querySelector('button[type="submit"], .submit-btn, [class*="submit" i]');
                  if (btn) try { btn.click(); } catch (_) {}
                  const names = Array.from(document.querySelectorAll('.u-file-list .file-name, [data-module="fileList"] .name, .file-list li .name, .sl-list .name')).map((e) => e.textContent.trim()).filter(Boolean);
                  return { names, hasInput: !!inp };
                },
                args: [pwd],
              });
              const res = r && r.result;
              if (res && res.names && res.names.length) { clearInterval(iv); clearTimeout(to); resolve({ ok: true, names: res.names }); }
            } catch (_) {}
          }, 800);
        });
        sendResponse({ ok: result.ok, names: result.names || [], note: '已自动填码并打开网盘页；点击下载后真实文件将通过浏览器下载事件自动捕获为归档素材' });
        return;
      }
      if (/lanzou|quark|123pan|aliyundrive/.test(url)) {
        await chrome.tabs.create({ url, active: true });
        sendResponse({ ok: true, note: '已打开网盘页，自动填码暂未适配该平台，请手动提取' });
        return;
      }
      sendResponse({ ok: false, error: 'unsupported-netdisk' });
    } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
  })();
  return true;
});

// ---- build 汇总上报（原 REPORT_BUILD 分支，无副作用，仅写全局 HMDAO_BUILDS）----
/* global HMDAO_BUILDS, scheduleRescan */
registerHandler(HMDAO_MSG.REPORT_BUILD, (msg) => {
  const comp = msg.component;
  if (comp === 'sidepanel' || comp === 'detect' || comp === 'injectMain') {
    HMDAO_BUILDS[comp] = msg.build || null;
  }
  return false; // 同步、无需响应
});

// ---- build 汇总查询（原 GET_BUILDS 分支，一次返回全部组件 build）----
registerHandler(HMDAO_MSG.GET_BUILDS, (_msg, _sender, sendResponse) => {
  sendResponse({ ok: true, builds: HMDAO_BUILDS });
  return true; // 同步响应但保持通道（与原分支一致）
});

// ---- 动态链接去抖重扫（原 PAGE_MUTATION 分支）----
registerHandler(HMDAO_MSG.PAGE_MUTATION, (_msg, sender) => {
  const tabId = sender && sender.tab && sender.tab.id;
  if (typeof tabId === 'number') scheduleRescan(tabId);
  return false; // 同步、无需响应
});

// ---- 主动点击「下载/获取」按钮触发动态链接（原 CLICK_REVEAL 分支）----
/* global scanTab */
registerHandler(HMDAO_MSG.CLICK_REVEAL, (msg, _sender, sendResponse) => {
  (async () => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (!tab || !tab.id) { sendResponse({ ok: false, error: 'no-active-tab' }); return; }
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: false },
        world: 'ISOLATED',
        func: () => {
          const SEL = 'a[href*="pan.baidu"],a[href*="lanzou"],a[href*="quark"],a[href*="123pan"],a[href*="aliyundrive"],button,[role="button"],.btn,[class*="download" i],[class*="get" i],[class*="obtain" i],[class*="fetch" i],[data-action*="download" i],[id*="download" i],[title*="下载" i],[title*="获取" i]';
          const txt = (e) => (e.textContent || e.getAttribute('title') || e.getAttribute('aria-label') || '').toLowerCase();
          const targets = Array.from(document.querySelectorAll(SEL)).filter((b) => /下载|获取|提取|立即下载|资源|网盘|download|obtain|fetch|save|领取|click/i.test(txt(b)));
          let clicked = 0;
          targets.slice(0, 8).forEach((b) => { try { b.click(); clicked++; } catch (_) {} });
          return { clicked, total: targets.length };
        },
      });
      setTimeout(() => { scanTab(tab.id).catch(() => {}); }, 1500);
      sendResponse({ ok: true, clicked: res && res.result && res.result.clicked });
    } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
  })();
  return true; // 异步响应
});

// ---- 侧栏关闭：停止全部轮询，释放定时器（原 PANEL_CLOSED 分支）----
/* global POLL_TIMERS, stopPolling */
registerHandler(HMDAO_MSG.PANEL_CLOSED, () => {
  Object.keys(POLL_TIMERS).forEach(stopPolling);
  return false; // 同步、无需响应
});

// ---- 调试：返回各 tab 的网络捕获资产统计（原 DEBUG_NETWORK 分支）----
/* global NETWORK_ASSETS */
registerHandler(HMDAO_MSG.DEBUG_NETWORK, (_msg, _sender, sendResponse) => {
  const summary = {};
  for (const k of Object.keys(NETWORK_ASSETS)) {
    const arr = NETWORK_ASSETS[k] || [];
    summary[k] = arr.map((a) => ({ type: a.type, source: a.source, gv: /googlevideo\.com\/videoplayback/.test(a.url), u: a.url.slice(0, 70) }));
  }
  sendResponse({ ok: true, tabs: summary });
  return true; // 同步响应但保持通道（与原分支一致）
});

// 暴露到全局（importScripts 引入，与 background.js 共享作用域）
if (typeof globalThis !== 'undefined') {
  globalThis.HMDAO_HANDLERS = HANDLERS;
  globalThis.dispatchMessage = dispatchMessage;
  globalThis.hasHandler = hasHandler;
}
