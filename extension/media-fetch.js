// ===== 后台通讯 / 媒体字节拉取（抽离自 sidepanel.js）=====
// 侧栏 → background 的通用通讯封装层；依赖 sidepanel.js 全局 b64ToBytes / window.__sourcePageUrl。
// 本文件在 sidepanel.js 之后加载，纯物理拆分（共享全局作用域），行为零改变。

// 通用后台 fetch：透传任意选项到 HMDAO_FETCH
async function fetchViaBackground(url, options = {}) {
  return await chrome.runtime.sendMessage({ type: 'HMDAO_FETCH', url, ...options });
}

// 后台带 Referer 拉取媒体字节（ArrayBuffer），绕过侧栏 <video>/<a download> 的签名/Referer 限制
async function fetchMediaViaBackground(url, referer) {
  return await chrome.runtime.sendMessage({ type: 'HMDAO_FETCH_MEDIA', url, referer });
}

// 通过后台 relay（credentials:'omit'）拉取第三方图片字节 → blob: URL。
// 根因：侧栏直接 img.src=第三方URL 时，源站响应里的 Set-Cookie 会被 Chrome 当作第三方 Cookie 拦截，
// 在 Issues 面板报「Third-party cookie will be blocked」。走 blob 后侧栏不再直连第三方源，消除告警。
async function loadImageViaRelay(url, referer) {
  try {
    const r = await fetchMediaViaBackground(url, referer || window.__sourcePageUrl || '');
    if (r && r.ok && r.b64) {
      const bytes = b64ToBytes(r.b64);
      if (bytes && bytes.length) {
        const mime = (r.mime && r.mime.startsWith('image/')) ? r.mime : 'image/*';
        return URL.createObjectURL(new Blob([bytes], { type: mime }));
      }
    }
  } catch (_) {}
  return null;
}
