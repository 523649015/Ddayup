// ISOLATED-world 中继（注入到 pan.xunlei.com 系域名）。
//
// 问题背景：
//  model-api-capture.js 运行在 MAIN world，它直接 window.fetch 迅雷 API 时面临两难：
//   · credentials:'include'  → 带登录态（解决 401）但触发预检冲突：
//      响应 ACAO='*' + 凭据模式 → 浏览器拒「* 不能用于 include」→ net::ERR_FAILED（CORS）。
//   · credentials:'omit'     → 不触发 CORS 但丢弃登录态 → 401 Unauthorized。
//  MAIN world 无法调用 chrome.declarativeNetRequest（扩展 API 在 MAIN 世界不可用），
//  也无法 chrome.runtime.sendMessage（MAIN 世界 chrome.runtime 不可靠）。
//
// 解决：本文件以 ISOLATED world 注入（能 chrome.runtime.sendMessage），作为 MAIN→background 的
//  fetch 中继。background 用 dNR 把响应 ACAO 钉成具体 origin(https://pan.xunlei.com) 再 include fetch，
//  既带登录态（过 401）又通过 CORS（ACAO 非 *），彻底绕开两难。

(function () {
  if (!chrome || !chrome.runtime) return;

  // MAIN world 发出的请求消息，按 reqId 配对响应
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.__hmdao_type !== 'XUNLEI_FETCH') return;
    const reqId = d.reqId;
    if (!reqId || !d.url) return;
    console.log('[HMDAO][xunlei-bridge] forward', d.method || 'GET', d.url.slice(0, 120));
    // ★前置守卫：context invalidated 时 chrome.runtime.id 变为 undefined（比等 sendMessage 抛异常更干净）。
    // 此时直接回传 bridge-error，不触碰已失效的 sendMessage。
    if (!chrome.runtime || !chrome.runtime.id) {
      try {
        window.postMessage(
          { __hmdao_type: 'XUNLEI_FETCH_RESULT', reqId, ok: false, status: 0, text: '', error: 'bridge-error:Extension context invalidated' },
          '*'
        );
      } catch (_) {}
      return;
    }
    // ★防御 Extension context invalidated：扩展被重载/更新后旧 content script 仍存活，
    // 此时 chrome.runtime 对象还在，但 sendMessage 会抛 "Extension context invalidated"。
    // 必须 try/catch，把错误回传 MAIN 世界（让 xunleiBridgeFetch 走失败分支而非未捕获异常）。
    // 同时监听 runtime.lastError 兜底异步失败。
    try {
      let settled = false;
      const localTimer = setTimeout(() => {
        if (settled) return; settled = true;
        try {
          window.postMessage(
            { __hmdao_type: 'XUNLEI_FETCH_RESULT', reqId, ok: false, status: 0, text: '', error: 'bridge-no-response(background 未在 5s 内回包)' },
            '*'
          );
        } catch (_) {}
      }, 5000);
      chrome.runtime.sendMessage(
        { type: 'HMDAO_XUNLEI_API', url: d.url, headers: d.headers || {}, method: d.method || 'GET' },
        (resp) => {
          if (settled) return; settled = true;
          clearTimeout(localTimer);
          if (chrome.runtime.lastError) {
            console.warn('[HMDAO][xunlei-bridge] lastError', reqId, chrome.runtime.lastError.message);
            try {
              window.postMessage(
                { __hmdao_type: 'XUNLEI_FETCH_RESULT', reqId, ok: false, status: 0, text: '', error: 'bridge-error:' + chrome.runtime.lastError.message },
                '*'
              );
            } catch (_) {}
            return;
          }
          console.log('[HMDAO][xunlei-bridge] back', reqId, resp && resp.status, resp && resp.ok, resp && resp.error);
          try {
            window.postMessage(
              { __hmdao_type: 'XUNLEI_FETCH_RESULT', reqId, ok: !!(resp && resp.ok), status: resp && resp.status, text: (resp && resp.text) || '', error: resp && resp.error },
              '*'
            );
          } catch (_) {}
        }
      );
    } catch (err) {
      // 典型：Extension context invalidated（扩展重载后旧脚本通道断开）
      console.warn('[HMDAO][xunlei-bridge] sendMessage threw', reqId, String(err && err.message || err));
      try {
        window.postMessage(
          { __hmdao_type: 'XUNLEI_FETCH_RESULT', reqId, ok: false, status: 0, text: '', error: 'bridge-error:' + (err && err.message || err) },
          '*'
        );
      } catch (_) {}
    }
  });
})();
