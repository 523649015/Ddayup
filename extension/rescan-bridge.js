// rescan-bridge.js —— ISOLATED 世界桥接脚本（把 MAIN 世界的重扫请求转发给 background）
//
// 【背景 / 致命根因】
//   inject-main.js 在 manifest 里注册为 `"world": "MAIN"` —— 这是必须的，否则读不到
//   window.player / window.__hmdao_captures 等页面全局。但 MAIN 世界脚本【没有 chrome.* API】，
//   于是 inject-main 里所有
//       chrome.runtime.sendMessage({ type: 'HMDAO_RESCAN_TAB' })
//   都被 `typeof chrome !== 'undefined' && chrome.runtime && ...` 这个守卫【静默跳过】，
//   连一条日志都没有。这就是「切集自动重扫」从来没生效过、侧栏永远停在首集的真凶。
//
// 【解决方案】
//   MAIN 世界 → dispatch window 自定义事件 `hmdao:request-rescan`
//   → 本脚本（ISOLATED 世界，拥有 chrome.*）接收并转发给 background 的 HMDAO_RESCAN_TAB handler。
//
// 注：background 另外还有 webNavigation.onHistoryStateUpdated 兜住 SPA pushState 的 URL 变化，
//     两条通道互补（本桥更精确：inject-main 检测到真实"换集"就触发，不依赖 URL 是否变化）。
(function () {
  if (window.__hmdaoRescanBridgeInstalled) return;
  window.__hmdaoRescanBridgeInstalled = true;

  // ★MV3 限制：重载扩展后，【已经打开的页面】里的旧内容脚本不会重新注入，
  //   但它们的 chrome.runtime 已失效 → 任何 sendMessage 都会抛
  //   "Extension context invalidated."。此时唯一解法是【刷新页面】。
  //   这里把该情况识别出来并给出明确指引，避免被误判成代码 bug。
  function isContextDead(err) {
    const m = String((err && err.message) || err || '');
    return /Extension context invalidated/i.test(m);
  }
  // 只提示一次，避免反复刷屏（用户扩展错误页告警堆积）
  let __warnedRefresh = false;
  function warnRefresh() {
    if (__warnedRefresh) return;
    __warnedRefresh = true;
    console.warn(
      '[HMDAO][bridge] ⚠ 扩展上下文已失效（扩展刚被重载过）\n' +
      '  → 解决办法：请【刷新本页面】（按 F5 / Ctrl+R）。\n' +
      '  → 原因：MV3 限制，重载扩展后已打开的页面里的旧内容脚本不会重新注入，\n' +
      '     必须刷新页面，新的内容脚本才会连上扩展。这不是代码故障。'
    );
  }

  function forward(ev) {
    try {
      // 发送前先自检：chrome.runtime.id 不存在即代表上下文已失效
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
        warnRefresh();
        return;
      }
      const d = (ev && ev.detail) || {};
      const p = chrome.runtime.sendMessage({ type: 'HMDAO_RESCAN_TAB', awemeId: d.awemeId || '' });
      if (p && typeof p.then === 'function') {
        p.then(() => {
          console.log('[HMDAO][bridge] 已转发重扫请求 awemeId=' + (d.awemeId || ''));
        }).catch((e) => {
          if (isContextDead(e)) warnRefresh();
          else console.warn('[HMDAO][bridge] 转发重扫请求失败：', e && e.message);
        });
      } else {
        console.log('[HMDAO][bridge] 已转发重扫请求 awemeId=' + (d.awemeId || ''));
      }
    } catch (e) {
      if (isContextDead(e)) warnRefresh();
      else console.warn('[HMDAO][bridge] 转发重扫请求失败：', e && e.message);
    }
  }

  window.addEventListener('hmdao:request-rescan', forward, false);
  console.log('[HMDAO] rescan-bridge 已装载（ISOLATED 世界）');
})();
