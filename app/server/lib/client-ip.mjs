/**
 * 客户端真实 IP 与「可信回环」判定（单一实现，消除重复）。
 *
 * 背景（必须遵守，否则会写出安全漏洞）：
 *   线上 nginx 反代（deploy/nginx-hmdao.conf 的 location /api/）把请求转发到 127.0.0.1:8792，
 *   因此服务进程看到的 `req.socket.remoteAddress` **恒为 127.0.0.1**。
 *   只看 socket 会把【所有公网请求】误判为"本机"，从而绕过授权闸门。
 *   必须优先取反代注入的 `X-Forwarded-For` 首跳（nginx 用 $proxy_add_x_forwarded_for，
 *   首跳即真实客户端），`X-Real-IP` 次之，最后才回落 socket（本机直连 / 无代理场景）。
 *
 * 收敛来源：此前 routes/auth.mjs 的 getClientIp、routes/extension-license.mjs 的 extClientIp
 * 各写了一份等价实现；routes/media.mjs 的 isLoopback 则只看 socket（反代场景会误放行，属缺陷）。
 */

const LOOPBACK_LITERALS = new Set([
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
  '::ffff:7f00:1',
  'localhost',
]);

/** 真实客户端 IP（XFF 首跳 → X-Real-IP → socket），取不到返回 'unknown'。 */
export function clientIp(req) {
  const headers = (req && req.headers) || {};
  const xff = headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  const real = headers['x-real-ip'];
  if (typeof real === 'string' && real.trim()) return real.trim();
  return (req && req.socket && req.socket.remoteAddress) || 'unknown';
}

/** 是否为回环地址（含 127.0.0.0/8 与 IPv6 映射写法）。 */
export function isLoopbackAddress(ip) {
  const value = String(ip || '').trim().toLowerCase();
  if (!value) return false;
  if (LOOPBACK_LITERALS.has(value)) return true;
  return /^127\./.test(value);
}

/**
 * 仅当【真实客户端】为回环时才算「本机直连」。
 * ⚠ 不要用 `req.socket.remoteAddress` 单独判定：经 nginx 反代后它对公网请求同样是 127.0.0.1。
 */
export function isTrustedLoopbackRequest(req) {
  return isLoopbackAddress(clientIp(req));
}
