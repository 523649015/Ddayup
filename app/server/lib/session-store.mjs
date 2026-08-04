// 会话存储模块（从 app/server/hmdao-api.mjs 抽离，行为零变更）。
//
// sessions / accessSessions 是登录态的模块级可变 Map。经由顶部 import 在主文件与各
// 路由组（auth/cobuild 等）之间共享。ES 模块对其采用 live binding：本模块导出 const Map，
// 主文件与各路由组对同一个 Map 实例做 .set/.delete/.get 变更，引用始终一致。
import crypto from 'node:crypto';

// 刷新令牌 -> { userId, expiresAt }（7 天）
export const sessions = new Map();
// 访问令牌 -> { userId, expiresAt }（2 小时）
export const accessSessions = new Map();

export function createSession(user) {
  const accessToken = crypto.randomBytes(24).toString('hex');
  const refreshToken = crypto.randomBytes(24).toString('hex');
  const expiresAt = Date.now() + 2 * 60 * 60 * 1000;
  sessions.set(refreshToken, { userId: user.id, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 });
  accessSessions.set(accessToken, { userId: user.id, expiresAt });
  return { access_token: accessToken, refresh_token: refreshToken, expires_at: expiresAt };
}

export function deleteSessionsForUser(userId) {
  for (const [refreshToken, session] of sessions.entries()) {
    if (session?.userId === userId) {
      sessions.delete(refreshToken);
    }
  }
}
