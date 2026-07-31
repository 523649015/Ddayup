// ===== UI 通用纯工具函数 =====
// 无副作用、零依赖的纯函数，供 sidepanel.js / preview-render 等共享。
// 必须在 sidepanel.js 之前加载（全局单一来源，避免各文件重复定义）。
function escapeAttr(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
function truncate(s, n) {
  return String(s || '').length > n ? String(s).slice(0, n) + '…' : String(s || '');
}
// 读取当前预览资产（preview 按钮回调统一经过它取资产，避免重复全局访问）
function getPreviewAsset() {
  return window.__previewAsset || null;
}
