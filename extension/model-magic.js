// 模型/归档二进制校验 + 下载型 API 识别（UMD：浏览器 Service Worker 与 Node 测试共用）。
// 对应「技术验证 5：二进制魔数校验（防 URL 伪装，高精度）」与「技术验证 1：接口特征识别」。
//
// 为什么需要它（针对 aigei.com / cgmodel.com 的真实行为）：
//   - 这类站的模型文件不是静态 <a href>，而是「点击下载 → 后端签名 → 限时 URL → 真字节经网络到达」。
//   - 签名 URL 过期 / 防盗链拦截时，源站会返回 HTML/JSON 错误页伪装成文件（爱给网音频已证实此问题）。
//   - 仅凭 URL 后缀（技术验证 2/3）在 DOM 里根本抓不到文件地址；必须在「网络层捕获 + 落盘前校验魔数」。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.verifyModelBinarySignature = api.verifyModelBinarySignature;
    root.MAGIC_CHECKS = api.MAGIC_CHECKS;
    root.DOWNLOAD_API_RE = api.DOWNLOAD_API_RE;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  // 二进制魔数：ZIP 504B0304 / GLB 676C5446 / FBX "Kaydara FBX Binary" / RAR / 7Z / GZIP
  const MAGIC_CHECKS = [
    { kind: 'zip', re: /^PK\x03\x04/, note: 'ZIP 压缩包 (50 4B 03 04)' },
    { kind: 'zip-empty', re: /^PK\x05\x06/, note: 'ZIP 空归档 (50 4B 05 06)' },
    { kind: 'gz', re: /^\x1f\x8b/, note: 'GZIP (1F 8B)' },
    { kind: 'rar', re: /^Rar!\x1a\x07/, note: 'RAR (52 61 72 21 1A 07)' },
    { kind: '7z', re: /^7z\xbc\xaf\x27\x1c/, note: '7Z (37 7A BC AF 27 1C)' },
    { kind: 'glb', re: /^glTF/, note: 'GLB (67 6C 54 46)' },
    { kind: 'fbx', re: /^Kaydara FBX Binary/, note: 'FBX 二进制 (Kaydara FBX Binary)' },
    { kind: 'pdf', re: /^%PDF/, note: 'PDF (非模型，仅识别)' },
  ];

  // 下载型 API 路径特征（技术验证 1）：路径含 /download /resource /package 等，
  // POST 通常携带模型唯一 ID；其「响应」才是真实文件地址（经签名/重定向）。
  const DOWNLOAD_API_RE = /\/(download|resource|package|file|geturl|getUrl|attachment|modelDownload|down|downfile|getFile)\b/i;

  // bytes: Uint8Array / Buffer（前若干字节即可）
  // 返回 { kind, ok, spoofed, note }
  function verifyModelBinarySignature(bytes) {
    if (!bytes || (!bytes.length && bytes.length !== 0)) return { kind: null, ok: false, spoofed: false, note: '无字节' };
    if (bytes.length === 0) return { kind: null, ok: false, spoofed: false, note: '空字节' };
    const head = Array.from(bytes.slice(0, 64));
    const s = head.map((b) => String.fromCharCode(b & 0xff)).join('');
    // 先判伪装：HTML/JSON 错误页（爱给等站签名过期 / 防盗链拦截时返回）
    if (/^\s*(<!doctype|<html|<head|<\?xml|\{)/i.test(s)) {
      return { kind: 'spoof-html', ok: false, spoofed: true, note: '返回的是网页/JSON 而非模型（防盗链或签名过期）' };
    }
    for (const c of MAGIC_CHECKS) {
      if (c.re.test(s)) return { kind: c.kind, ok: true, spoofed: false, note: c.note };
    }
    // TAR：在偏移 257 处有 "ustar"
    if (bytes.length > 262) {
      const ustar = Array.from(bytes.slice(257, 262)).map((b) => String.fromCharCode(b & 0xff)).join('');
      if (ustar === 'ustar') return { kind: 'tar', ok: true, spoofed: false, note: 'TAR (ustar)' };
    }
    // 文本类模型（obj/stl/dae/ply/mtl/x3d）无统一魔数，靠扩展名；此处无法判定，标记为 unknown（不报错）
    return { kind: 'unknown', ok: true, spoofed: false, note: '无已知二进制魔数（可能是文本格式 .obj/.stl/.dae 或未知包）' };
  }

  return { verifyModelBinarySignature, MAGIC_CHECKS, DOWNLOAD_API_RE };
});
