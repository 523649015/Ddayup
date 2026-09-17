// ===== UI 通用纯工具函数 =====
// 无副作用、零依赖的纯函数，供 sidepanel.js / preview-render 等共享。
// 必须在 sidepanel.js 之前加载（全局单一来源，避免各文件重复定义）。
function escapeAttr(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
function escapeHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function truncate(s, n) {
  return String(s || '').length > n ? String(s).slice(0, n) + '…' : String(s || '');
}
// 读取当前预览资产（preview 按钮回调统一经过它取资产，避免重复全局访问）
function getPreviewAsset() {
  return window.__previewAsset || null;
}
// 扩展端设备授权标识读取（供服务端下载/采集代理闸门校验 entitlement 用）。
// 服务端 merge-dash/hls/file、save-to-dir、probe-dir、ytdlp/ytdlp-file 会在请求里携带
// deviceId(+token)，服务端据此判定 trial/paid 放行、none/expired 拒绝。绕过扩展端 gate() 也无处遁形。
async function getExtDeviceAuth() {
  try {
    const s = await chrome.storage.local.get(['hmdaoDeviceId', 'hmdaoToken']);
    return {
      deviceId: String((s && s.hmdaoDeviceId) || '').trim(),
      token: String((s && s.hmdaoToken) || '').trim(),
    };
  } catch (_) {
    return { deviceId: '', token: '' };
  }
}
// 给 GET 端点 URL 追加设备授权标识（deviceId + token），供服务端闸门校验。
function withDeviceAuth(url, auth) {
  if (!auth || !auth.deviceId) return url;
  const sep = url.indexOf('?') >= 0 ? '&' : '?';
  return url + sep + 'deviceId=' + encodeURIComponent(auth.deviceId) + '&token=' + encodeURIComponent(auth.token || '');
}
// 给 POST 请求体追加设备授权标识。
function withDeviceAuthBody(body, auth) {
  if (!auth || !auth.deviceId) return body;
  return Object.assign({}, body, { deviceId: auth.deviceId, token: auth.token || '' });
}
