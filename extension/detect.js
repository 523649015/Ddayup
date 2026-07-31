// Content script：注入到 Ddayup Web App 页面（http://127.0.0.1:3000）
// 职责：
//  1) 暴露检测标志 window.__hmdaoExtInstalled，供 Web App 检测扩展是否安装
//  2) 响应 Web App 的 postMessage 握手（HMDAO_EXT_PING -> HMDAO_EXT_PONG）
//  3) 转发扩展侧栏发来的指令到页面（刷新资产库 / 导入网页资源 / 找相似）
//  4) 在 document_start 把 fetch/XHR 拦截脚本注入页面 MAIN world，捕获 B 站 / YouTube 的 player API 响应
//
// 所有变更放底层，隔离一切外界依赖。
(function () {
  // 版本标记：供网页端「检测是否已安装」直接显示扩展 build 号，一眼分辨新旧。
  // 改了 detect.js 后请同步更新此值。
  const HMDAO_DETECT_BUILD = '2026-07-25-detect-v1';
  try {
    window.__hmdaoExtInstalled = true;
    window.__hmdaoExtBuild = HMDAO_DETECT_BUILD;
  } catch (_) { /* ignore */ }

  // 向 background 上报本组件 build，汇总到统一入口 HMDAO_GET_BUILDS
  if (chrome && chrome.runtime) {
    try { chrome.runtime.sendMessage({ type: 'HMDAO_REPORT_BUILD', component: 'detect', build: HMDAO_DETECT_BUILD }); } catch (_) {}
  }

  // ===== 4) MAIN world 拦截器 =====
  // 注意：拦截器已改为独立文件 inject-main.js，由 manifest 以 "world":"MAIN" 注入。
  // 浏览器直接执行，不再用 inline <script>（会被 B站/YouTube 的 CSP script-src 'self' 拦截）。
  // 此处不再做任何 inline 注入，彻底消除 "Refused to execute inline script" 报错。

  // 把扩展指令统一转成页面自定义事件，供 Web App（extensionBridge.ts）监听。
  function forward(type, detail) {
    const map = {
      HMDAO_REFRESH_ASSETS: 'hmdao:assets-updated',
      HMDAO_IMPORT_ASSETS: 'hmdao:import-web-assets',
      HMDAO_FIND_SIMILAR: 'hmdao:find-similar',
      HMDAO_AI_CHAT: 'hmdao:ai-chat',
      HMDAO_RUN_AGENT_WORKFLOW: 'hmdao:run-agent-workflow',
    };
    const ev = map[type];
    if (ev) window.dispatchEvent(new CustomEvent(ev, { detail: detail || {} }));
  }

  // ===== 3A) 页面侧 postMessage 通道（Web App -> content script 握手 / 事件） =====
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'HMDAO_EXT_PING') {
      window.postMessage({ type: 'HMDAO_EXT_PONG', version: chrome.runtime.getManifest().version, build: HMDAO_DETECT_BUILD }, '*');
    } else if (d.type === 'HMDAO_GET_BUILDS') {
      // 统一入口：Web App 经此向 background 查询全部组件 build
      if (chrome && chrome.runtime) {
        chrome.runtime.sendMessage({ type: 'HMDAO_GET_BUILDS' }, (resp) => {
          window.postMessage({ type: 'HMDAO_BUILDS', builds: (resp && resp.builds) || null }, '*');
        });
      }
    } else if (d.type === 'HMDAO_MAIN_BUILD') {
      // inject-main 运行在 MAIN world 无法用 chrome.runtime，转由 content script 代为上报
      if (chrome && chrome.runtime) {
        try { chrome.runtime.sendMessage({ type: 'HMDAO_REPORT_BUILD', component: 'injectMain', build: d.build || null }); } catch (_) {}
      }
    } else if (d.type === 'HMDAO_REFRESH_ASSETS' || d.type === 'HMDAO_IMPORT_ASSETS' || d.type === 'HMDAO_FIND_SIMILAR') {
      forward(d.type, d);
    }
  });

  // ===== 3B) 扩展侧 chrome.runtime 通道（background.js 用 chrome.tabs.sendMessage 下发） =====
  // 注意：chrome.tabs.sendMessage 投递到 content script 的 chrome.runtime.onMessage，
  // 与上面的 window.postMessage 是【不同通道】；此前只监听 window 导致导入指令永远收不到。
  // 这里补上 chrome.runtime.onMessage，才能真正打通「侧栏导入 -> Web App 入库」链路。
  if (chrome && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || !msg.type) return;
      if (msg.type === 'HMDAO_AI_CHAT') {
        // payload 内含 {text, mode}，作为自定义事件 detail 直接传给 Web App（扩展 AI 助手）
        window.dispatchEvent(new CustomEvent('hmdao:ai-chat', { detail: msg.payload || {} }));
      } else if (msg.type === 'HMDAO_RUN_AGENT_WORKFLOW') {
        // 扩展机器人上传的素材 → 触发画布 SmartAgent 媒体工作流
        window.dispatchEvent(new CustomEvent('hmdao:run-agent-workflow', { detail: msg.payload || {} }));
      } else if (msg.type === 'HMDAO_REFRESH_ASSETS' || msg.type === 'HMDAO_IMPORT_ASSETS' || msg.type === 'HMDAO_FIND_SIMILAR') {
        forward(msg.type, msg);
      }
    });
  }

  // 网页(智能机器人后端)算完后，把结果回传给扩展侧栏
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || d.type !== 'hmdao:ai-chat-reply') return;
    if (chrome && chrome.runtime) {
      chrome.runtime.sendMessage({ type: 'HMDAO_AI_CHAT_REPLY', ok: !!d.ok, text: d.text, error: d.error });
    }
  });
})();
