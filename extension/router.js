// ===== 消息路由表（D1 基础设施）=====
// 将原 onMessage 中的巨型 if 分支逐步迁移为注册式 handler，降低 background.js 单文件耦合。
// 约定：每个 handler 形如 async (msg, sender, sendResponse) => boolean
//   - 返回 true 表示已接管消息且会异步调用 sendResponse（保持 Chrome 消息通道打开）
//   - 返回 false 表示已同步响应或无需响应
//   - 未注册的类型由 background.js 原有 if 链兜底，保证运行时行为不变。
// 注意：handler 与 background.js 同处 SW 全局作用域（importScripts 引入），
// 可直接读写 SOURCE_TAB_ID / NETWORK_ASSETS 等背景全局变量。

const HANDLERS = {};

// 网盘单文件下载请求防重入表（requestKey -> timestamp），防止连续点击导致开多个 hidden tab。
let netdiskDownloadInFlight = null;

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

// 注：网盘深度解析 HMDAO_NETDISK_RESOLVE 已在 background.js 中实现为更完整的版本
// （复用已打开的登录页、等待 MAIN 捕获、触发 file_info 拿直链），router.js 不再重复注册，
// 避免覆盖 background.js 的 handler。


// ---- 网盘单文件下载（HMDAO_NETDISK_DOWNLOAD）----
// 在网盘页内自动勾选指定文件并触发下载按钮，通过浏览器下载事件捕获真实直链。
// 关键：不依赖迅雷/夸克桌面客户端，复用网页版登录会话拿到下载 URL。
registerHandler(HMDAO_MSG.NETDISK_DOWNLOAD, (msg, _sender, sendResponse) => {
  (async () => {
    const diag = { step: 'start', url: msg.url, name: msg.name, fileId: msg.fileId };
    try {
      const url = msg.url || '';
      const targetName = msg.name || '';
      const targetId = msg.fileId || '';
      // ★ 2026-08-09 修复：原 isXunlei 只匹配 /s/（分享态），用户转存后到自己网盘
      //    pan.xunlei.com/?path=... 时无法触发下载。现在整站 pan.xunlei.com 均视为迅雷网盘。
      const isXunlei = /pan\.xunlei\.com/.test(url);
      const isQuark = /pan\.quark\.cn\/s\//.test(url);
      if ((!isXunlei && !isQuark) || (!targetName && !targetId)) {
        diag.step = 'invalid-params';
        sendResponse({ ok: false, error: 'invalid-params', diag });
        return;
      }

      // ============ 方案 A（主力）：复用页面会话解析出真实下载直链，直接后台下载 ============
      // 迅雷/夸克 web 端点击下载按钮【不触发浏览器原生下载】（弹客户端/弹面板），
      // 旧「点按钮 → 等 chrome.downloads.onCreated」方案必然 timeout，且会误关用户正在浏览的标签。
      // 正确路径：复用 handleNetdiskResolve 已验证的页面 API 钩子，拿到 direct 直链后直下。
      try {
        diag.step = 'resolve';
        // ★ 2026-08-09 修复：迅雷「自己网盘」页（pan.xunlei.com/?path=）优先走
        //   handleXunleiMyDriveResolve —— 它自带 background 代理兜底（xunleiProxyFetch 带登录态
        //   主动拉 download_url 直链），【完全不依赖本地后端 3000】。即使后端未启动，下载也成功。
        //   之前统一走 handleNetdiskResolve 在个别时序下会漏掉 mydrive 的代理直链，导致强依赖后端。
        const isXunleiMyDriveUrl = /pan\.xunlei\.com\?.*\bpath=/i.test(url);
        let resolver = null;
        if (isXunleiMyDriveUrl) {
          resolver = (typeof globalThis !== 'undefined' && globalThis.handleXunleiMyDriveResolve) ||
            (typeof handleXunleiMyDriveResolve !== 'undefined' ? handleXunleiMyDriveResolve : null);
          if (resolver) diag.resolver = 'handleXunleiMyDriveResolve';
        }
        if (!resolver) {
          // 通过 globalThis 显式取，避免 importScripts 边界下函数声明提升不可见的时序问题
          resolver = (typeof globalThis !== 'undefined' && globalThis.handleNetdiskResolve) || (typeof handleNetdiskResolve !== 'undefined' ? handleNetdiskResolve : null);
        }
        if (!resolver) {
          diag.resolveError = 'resolver-missing';
          diag.step = 'resolve-unavailable';
          throw new Error('handleNetdiskResolve unavailable');
        }
        const resolveRes = await resolver(url);
        const _tree = (resolveRes && resolveRes.tree) || [];
        const _hasDirect = _tree.filter((f) => f.direct && /^https?:/i.test(f.direct)).length;
        diag.resolve = {
          ok: resolveRes && resolveRes.ok,
          listLen: _tree.length,
          hasDirectCount: _hasDirect,
          fileInfoDirect: (resolveRes && resolveRes._diag && resolveRes._diag.fileInfoDirect) || null,
          resolveDetails: (resolveRes && resolveRes._diag && resolveRes._diag.resolveDetails) || null,
          resolveError: (resolveRes && resolveRes._diag && resolveRes._diag.resolveError) || null,
          resolveDiag: (resolveRes && resolveRes._diag && resolveRes._diag.resolveDiag) || null,
        };
        // 解析明确失败（如 requireLogin / 分享失效）：直接透传失败原因，不再去点按钮（没登录点了也没用）
        if (resolveRes && !resolveRes.ok) {
          diag.step = 'resolve-failed-explicit';
          sendResponse({ ok: false, error: resolveRes.error || 'resolve-failed', requireLogin: !!resolveRes.requireLogin, note: resolveRes.error || '解析失败', diag });
          return;
        }
        if (resolveRes && resolveRes.ok && resolveRes.tree && resolveRes.tree.length) {
          const hit = resolveRes.tree.find((f) =>
            (targetId && f.fileId === targetId) || (targetName && f.name === targetName) ||
            (targetName && f.name && f.name.replace(/\s+/g, '').includes(targetName.replace(/\s+/g, ''))));
          const direct = hit && hit.direct;
          diag.step = 'resolve-hit';
          diag.hit = hit ? { name: hit.name, hasDirect: !!direct, isDir: hit.isDir } : null;
          if (hit && !hit.isDir && direct && /^https?:/i.test(direct)) {
            const name = hit.name || targetName || 'netdisk-file';
            // ★ Aria2 模式：只返回直链，不触发浏览器下载；由调用方用 Aria2 提交下载。
            if (msg.returnUrlOnly) {
              sendResponse({ ok: true, url: direct, name, via: 'direct-api-return-only', diag });
              return;
            }
            // ★后台直接下载直链（复用网盘页登录 Cookie 上下文）
            const isXlDirect = /xunlei\.com|xlcdn\.com|tc\.xunlei\.com|pan\.xunlei/i.test(direct);
            const dlOpts = {
              url: direct,
              filename: 'Ddayup/netdisk/' + name,
              saveAs: false,
              conflictAction: 'uniquify',
            };
            if (isXlDirect) dlOpts.headers = [{ name: 'Referer', value: 'https://pan.xunlei.com/' }];
            let dlId = null;
            try { dlId = await chrome.downloads.download(dlOpts); } catch (e) { dlId = null; }
            diag.step = 'download-started';
            diag.dlId = dlId;
            sendResponse({ ok: true, url: direct, name, via: 'direct-api', diag });
            return;
          }
          if (hit && hit.isDir) {
            diag.step = 'is-dir';
            sendResponse({ ok: false, error: 'is-dir', note: '该条目是文件夹，请下载其中的具体文件', diag });
            return;
          }
          // 解析到了文件但没直链（未登录/分享失效/接口未返回 download_url）→ 回退方案 B
          diag.step = 'no-direct-fallback';
          // ★ 快速失败（2026-08-08）：若根因是 bridge 失效或需登录，进方案 B 点下载按钮
          // 必然 30s 超时（迅雷网页端点击不触发浏览器原生下载，仅弹客户端/登录）。
          // 直接返回明确提示，避免用户白等 30s；让用户刷新分享页(F5)/登录后重解析。
          const _re = resolveRes && resolveRes._diag && resolveRes._diag.resolveError;
          // bridge-invalidated(扩展失效需刷新) / need-login(需登录) / no-direct(参数错无直链)
          // 三者都不再进方案 B 白等 30s，直接明确返回，避免用户反复重试无效。
          if (_re === 'bridge-invalidated' || _re === 'need-login' || _re === 'no-direct') {
            diag.step = 'no-direct-need-refresh';
            diag.resolveError = _re;
            // ★ 迅雷分享态主动请求拿不到直链（实测 file_info 无 medias/sub_file_id、download_url 用分享条目 id 必 404）。
            //   唯一活路：用户在迅雷网页端手动点「下载」按钮，触发网络层被动捕获真实 CDN 直链。
            //   返回 needManualClick 让侧栏引导用户点下载 + 自动重试闭环。
            if (_re === 'no-direct') {
              sendResponse({
                ok: false,
                error: 'no-direct',
                needManualClick: true,
                fileId: targetId,
                note: '迅雷分享态接口已不再返回可下载直链（主动请求返回 404/无直链）。请在迅雷网页版该分享页手动点击「' + (targetName || '文件') + '」右侧的下载按钮，扩展会自动捕获真实直链；捕获后此下载将自动重试。',
                diag,
              });
              return;
            }
            let note;
            if (_re === 'bridge-invalidated') note = '扩展上下文已失效（扩展被重载/更新）。请刷新迅雷分享页（F5）后重新点「深度解析」。';
            else note = '需先登录迅雷网页版账号，再点「深度解析」获取直链。';
            sendResponse({ ok: false, error: _re, requireLogin: _re === 'need-login', note, diag });
            return;
          }
        }
      } catch (e) {
        diag.resolveError = String((e && e.message) || e);
        diag.step = 'resolve-failed';
      }

      // ============ 方案 B（兜底，仅当方案 A 拿不到直链时）：点下载按钮 + 捕获 onCreated ============
      // 仅对「新建的 hidden tab」才允许 remove；复用 existing 标签时绝不 remove（避免关掉用户正在看的页面）。
      const requestKey = (url + '|' + targetName + '|' + targetId).slice(0, 240);
      if (netdiskDownloadInFlight && netdiskDownloadInFlight.has(requestKey)) {
        sendResponse({ ok: false, error: 'duplicate-request', diag: { step: 'duplicate', requestKey } });
        return;
      }
      if (!netdiskDownloadInFlight) netdiskDownloadInFlight = new Map();
      netdiskDownloadInFlight.set(requestKey, Date.now());
      setTimeout(() => { if (netdiskDownloadInFlight) netdiskDownloadInFlight.delete(requestKey); }, 45000);
      const pwd = (url.match(/[?&]pwd=([^&]+)/) || [])[1] || '';

      let tab = null;
      let tabOwned = false; // 仅当本 handler 新建的 tab 才允许 remove
      const base = url.split('?')[0];
      try {
        const all = await chrome.tabs.query({});
        tab = all.find((t) => t.url && (t.url === url || t.url.startsWith(base)));
      } catch (_) {}
      if (tab && tab.id) {
        diag.tabSource = 'existing';
        diag.tabId = tab.id;
        // eslint-disable-next-line no-undef
        SOURCE_TAB_ID = tab.id;
      } else {
        tab = await chrome.tabs.create({ url, active: false });
        tabOwned = true;
        diag.tabSource = 'created';
        diag.tabId = tab.id;
        // eslint-disable-next-line no-undef
        SOURCE_TAB_ID = tab.id;
      }

      await new Promise((r) => setTimeout(r, tab.url && tab.url.includes(base) ? 600 : 2500));
      await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'ISOLATED',
        func: (pwd) => {
          const inp = document.querySelector('input[type="password"], input[placeholder*="提取" i], input[placeholder*="密码" i], input[placeholder*="口令" i], .pwd-input input, #accessCode, #pwd, input[name="pwd"]');
          if (inp && !inp.value && pwd) { inp.value = pwd; inp.dispatchEvent(new Event('input', { bubbles: true })); }
          const btn = Array.from(document.querySelectorAll('button')).find((b) => /提取|确定|提交|进入|解压|查看|登录/i.test(b.textContent || ''));
          if (btn) try { btn.click(); } catch (_) {}
        },
        args: [pwd],
      });

      if (tabOwned) {
        await new Promise((r) => setTimeout(r, 400));
        await chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: 'ISOLATED',
          func: () => {
            return new Promise((resolve) => {
              const scroller = document.querySelector('.file-list, .share-file-list, .xl-list, [class*="fileList" i], [class*="file-list" i], .share-content, [class*="shareContent" i], main, .main, #root, .ant-layout-content, .ant-spin-nested-loading') || document.documentElement;
              let step = 0;
              const max = 12;
              const interval = setInterval(() => {
                const top = (step + 1) * 600;
                scroller.scrollTo({ top, behavior: 'instant' });
                window.scrollTo(0, top);
                step++;
                if (step >= max) { clearInterval(interval); scroller.scrollTo({ top: 0, behavior: 'instant' }); window.scrollTo(0, 0); resolve('scrolled'); }
              }, 180);
            });
          },
        });
        await new Promise((r) => setTimeout(r, 500));
      }

      const clickTs = Date.now();
      const clicked = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'ISOLATED',
        func: (targetName, targetId) => {
          const host = location.hostname;
          const isQuark = host.includes('quark');
          const rowSel = isQuark
            ? '[class*="file-item" i], [class*="fileItem" i], li[class*="item" i], [data-file-id], [data-name], tr, [role="row"], .ant-list-item'
            : '[class*="file-item" i], [class*="fileItem" i], [class*="list-item" i], [class*="file" i], [data-file-id], [data-name], tr, [class*="row" i], [role="row"], .ant-list-item';
          const rows = Array.from(document.querySelectorAll(rowSel)).filter((e) => e.offsetParent !== null);
          const candidates = [];
          for (const e of rows) {
            const name = (e.getAttribute('data-name') || e.querySelector('[class*="name" i], [class*="title" i], .file-name')?.textContent || e.textContent || '').trim();
            const fileId = e.getAttribute('data-file-id') || e.getAttribute('data-fid') || e.getAttribute('data-id') || '';
            candidates.push({ name: name.slice(0, 60), fileId: fileId.slice(0, 40) });
            if ((targetName && name === targetName) || (targetId && fileId === targetId)) {
              const dlBtn = e.querySelector('[class*="download" i], [title*="下载" i], [class*="down" i], [class*="btn-download" i]') ||
                Array.from(e.querySelectorAll('button, a')).find((b) => /下载|保存|导出|立即下载/i.test(b.textContent || b.title || b.getAttribute('aria-label') || ''));
              if (dlBtn) { try { dlBtn.click(); return { clicked: true, name, via: 'inline-btn' }; } catch (_) {} }
              try { e.click(); } catch (_) {}
              setTimeout(() => {
                const float = document.querySelector('[class*="download" i], [title*="下载" i], [class*="down" i]') ||
                  Array.from(document.querySelectorAll('button, a')).find((b) => /下载|保存|导出|立即下载/i.test(b.textContent || b.title || b.getAttribute('aria-label') || ''));
                if (float) try { float.click(); } catch (_) {}
              }, 500);
              return { clicked: true, name, via: 'row-click' };
            }
          }
          return { clicked: false, candidates: candidates.slice(0, 20) };
        },
        args: [targetName, targetId],
      });
      const clickRes = clicked && clicked[0] && clicked[0].result;
      diag.clickRes = clickRes;
      diag.clickTs = clickTs;
      if (!clickRes || !clickRes.clicked) {
        if (tabOwned) try { await chrome.tabs.remove(tab.id); } catch (_) {}
        diag.step = 'file-not-found';
        if (netdiskDownloadInFlight) netdiskDownloadInFlight.delete(requestKey);
        sendResponse({ ok: false, error: 'file-not-found', diag });
        return;
      }

      diag.step = 'wait-download';
      let done = false;
      let pollTimer = null;
      let timeoutTimer = null;
      const cleanup = () => {
        try { chrome.downloads.onCreated.removeListener(listener); } catch (_) {}
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
      };
      // 后台直下：带迅雷 Referer，避免 403；成功即视为下载已发起
      const startDirectDownload = (dlUrl, via) => {
        if (done) return;
        done = true;
        cleanup();
        if (netdiskDownloadInFlight) netdiskDownloadInFlight.delete(requestKey);
        diag.dlUrl = String(dlUrl).slice(0, 200);
        diag.via = via;
        // ★ Aria2 模式：只返回直链，不触发浏览器下载。
        if (msg.returnUrlOnly) {
          diag.step = 'url-returned';
          sendResponse({ ok: true, url: dlUrl, name: targetName || clickRes.name, via, diag });
          return;
        }
        chrome.downloads.download({
          url: dlUrl,
          filename: 'Ddayup/netdisk/' + (targetName || ''),
          saveAs: false,
          conflictAction: 'uniquify',
          headers: [{ name: 'Referer', value: 'https://pan.xunlei.com/' }]
        }, () => {
          const err = chrome.runtime.lastError;
          if (err) {
            diag.step = 'download-failed';
            diag.dlError = String((err && err.message) || err);
            sendResponse({ ok: false, error: diag.dlError, diag });
            return;
          }
          diag.step = 'download-started';
          sendResponse({ ok: true, url: dlUrl, name: targetName || clickRes.name, diag });
        });
      };
      const listener = (item) => {
        if (done) return;
        const dlUrl = item.url || item.finalUrl || '';
        const itemTs = Date.now();
        const fileNameHint = (item.filename || '').toLowerCase();
        const targetNameLower = (targetName || '').toLowerCase();
        const looksNetdisk = dlUrl && /^https?:\/\//.test(dlUrl) && itemTs >= clickTs && !dlUrl.startsWith('blob:') && !dlUrl.startsWith('data:');
        const nameMatch = !targetNameLower || fileNameHint.includes(targetNameLower);
        const urlMatch = /xunlei|quark|baidu|xl.*\.com|pan\.xunlei|pan\.quark|dlink|cdrive|download/i.test(dlUrl) ||
          (item.referringPage && /pan\.xunlei|pan\.quark|pan\.baidu/i.test(item.referringPage));
        if (looksNetdisk && (nameMatch || urlMatch)) {
          startDirectDownload(dlUrl, 'oncreated');
        }
      };
      chrome.downloads.onCreated.addListener(listener);
      // ★ 核心兜底：迅雷点下载按钮【不触发浏览器原生下载事件】（弹客户端/面板），
      //   但会发起 download_url 请求 → MAIN world 的 maybeCapture 被动捕获真实直链并写入
      //   store.fileInfo[targetId].direct。轮询该直链，拿到即用后台直下，绕开 onCreated 死局。
      pollTimer = setInterval(async () => {
        if (done) return;
        try {
          const xs = await readXunleiShareFromTab(tab.id);
          const fi = xs && xs.fileInfo && xs.fileInfo[targetId];
          if (fi && fi.direct && /^https?:\/\//.test(fi.direct)) {
            diag.pollGotDirect = true;
            startDirectDownload(fi.direct, 'poll-captured-direct');
          }
        } catch (_) {}
      }, 600);
      timeoutTimer = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        if (tabOwned) try { chrome.tabs.remove(tab.id); } catch (_) {}
        diag.step = 'timeout';
        if (netdiskDownloadInFlight) netdiskDownloadInFlight.delete(requestKey);
        sendResponse({ ok: false, error: 'timeout', note: '未捕获到下载直链。可能原因：1) 该分享强制使用客户端；2) 需先登录网页版账号；3) 点击下载后页面未发起 download_url 请求（迅雷未推送直链）。', diag });
      }, 30000);
    } catch (e) {
      diag.step = 'exception';
      diag.error = String((e && e.message) || e);
      if (netdiskDownloadInFlight) netdiskDownloadInFlight.delete(requestKey);
      sendResponse({ ok: false, error: diag.error, diag });
    }
  })();
  return true;
});

// ---- 网盘文件树递归解析（HMDAO_NETDISK_TREE）----
// 在已打开的网盘源页中：自动填码 → 递归展开子目录 → 对每个文件项触发下载拿到真实直链。
// 返回结构化树：[{ name, size, isDir, url?, children? }]
// 关键：真实下载直链在「点击下载按钮 → 网络请求 → 直链出现在响应」时产生，
// 扩展通过网络层 + DOM 点击捕获，完全不弹「请安装客户端」窗，无需安装迅雷/夸克。
registerHandler(HMDAO_MSG.NETDISK_TREE, (msg, _sender, sendResponse) => {
  (async () => {
    try {
      const url = msg.url || '';
      // ★ 2026-08-09 同步修复：深度解析树也支持迅雷自己网盘页。
      if (!/pan\.xunlei\.com|pan\.quark\.cn\/s\//.test(url)) {
        sendResponse({ ok: false, error: 'unsupported-netdisk' });
        return;
      }
      const pwd = (url.match(/[?&]pwd=([^&]+)/) || [])[1] || '';
      const tab = await chrome.tabs.create({ url, active: false });
      // eslint-disable-next-line no-undef -- SOURCE_TAB_ID 是 background.js 经 importScripts 引入的全局变量，运行时可见
      SOURCE_TAB_ID = tab.id;

      const collectFiles = async (depth) => {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: 'ISOLATED',
          func: async (pwd, depth) => {
            const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
            const clickPwd = () => {
              const inp = document.querySelector('input[type="password"], input[placeholder*="提取" i], input[placeholder*="密码" i], input[placeholder*="口令" i], .pwd-input input, #accessCode, #pwd, input[name="pwd"]');
              if (inp && !inp.value && pwd) { inp.value = pwd; inp.dispatchEvent(new Event('input', { bubbles: true })); }
              const btn = Array.from(document.querySelectorAll('button')).find((b) => /提取|确定|提交|进入|解压|查看|登录/i.test(b.textContent || ''));
              if (btn) try { btn.click(); } catch (_) {}
            };
            clickPwd();
            await sleep(600);
            const host = location.hostname;
            const isQuark = host.includes('quark');
            const rowSel = isQuark
              ? '[class*="file-item" i], [class*="fileItem" i], li[class*="item" i], [data-file-id], [data-name]'
              : '[class*="file-item" i], [class*="fileItem" i], [class*="list-item" i], [data-file-id], [data-name]';
            const rows = Array.from(document.querySelectorAll(rowSel)).filter((e) => e.offsetParent !== null);
            const out = [];
            for (const e of rows) {
              const name = (e.getAttribute('data-name') || e.querySelector('[class*="name" i]')?.textContent || e.textContent || '').trim().slice(0, 200);
              if (!name) continue;
              const isDir = !!(e.querySelector('[class*="folder" i], [class*="dir" i]') || /文件夹|目录/.test(e.textContent || '')) || e.getAttribute('data-is-dir') === 'true';
              const size = (e.querySelector('[class*="size" i]')?.textContent || '').trim();
              out.push({ name, isDir, size });
              // 递归展开子目录（限制深度，防止失控）
              if (isDir && depth < 4) {
                try { e.click(); await sleep(500); } catch (_) {}
              }
            }
            return out;
          },
          args: [pwd, depth],
        });
        return (r && r.result) || [];
      };

      const tree = await collectFiles(0);
      try { await chrome.tabs.remove(tab.id); } catch (_) {}
      const names = tree.map((t) => t.name);
      sendResponse({
        ok: true,
        tree,
        names,
        note: '已解析网盘文件树（含子目录），侧栏可可视化展示并支持下载',
      });
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

// ---- 给新片场 oss-xpc6.xpccdn.com 注入 dNR Referer 规则（覆盖 media 资源类型）----
// ★2026-08-18：通用 installRefererRuleForDomain 排除 'media'（防止干扰页面 <video> 签名防盗链），
//   但新片场 oss-xpc6 CDN 只校验 Referer 防盗链，且页面 <video> 用同源 HLS 不走 dNR 注入域，
//   chrome.downloads.download 走 'media' 拉 oss-xpc6 必 403 → 下载到 0 字节被误当作"图片"。
//   此处对 xpccdn.com 局部破例，加 installMediaRefererRuleForDomain（10 分钟 TTL）。
/* global installMediaRefererRuleForDomain */
registerHandler('HMDAO_INSTALL_MEDIA_REFERER', async (msg, _sender, sendResponse) => {
  try {
    const domain = String(msg.domain || '').toLowerCase();
    const referer = String(msg.referer || '');
    if (!domain || !referer) { sendResponse({ ok: false, error: 'missing args' }); return false; }
    if (typeof installMediaRefererRuleForDomain !== 'function') { sendResponse({ ok: false, error: 'helper missing' }); return false; }
    const id = await installMediaRefererRuleForDomain(domain, referer);
    sendResponse({ ok: !!id, id });
  } catch (e) {
    sendResponse({ ok: false, error: String((e && e.message) || e) });
  }
  return true; // 异步响应
});

// 暴露到全局（importScripts 引入，与 background.js 共享作用域）
if (typeof globalThis !== 'undefined') {
  globalThis.HMDAO_HANDLERS = HANDLERS;
  globalThis.dispatchMessage = dispatchMessage;
  globalThis.hasHandler = hasHandler;
  globalThis.registerHandler = registerHandler;
}
