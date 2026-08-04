// 本地账号认证相关的「纯」工具函数，从 hmdao-api.mjs 剥离（行为零变更）。
//
// 说明：仅抽离不依赖主文件运行时状态的函数。以下依赖主文件状态的函数
// 仍保留在 hmdao-api.mjs 并经由 deps 注入路由：
//   - createSession / deleteSessionsForUser 依赖 sessions / accessSessions Map
//   - sendAuthError 依赖 send() 响应辅助
// 后续若需进一步收敛，可将 sessions / accessSessions 也显式注入后再迁移。

import crypto from 'node:crypto';

export function normalizeLocalEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function isValidLocalEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeLocalEmail(value));
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, user) {
  return hashPassword(password, user.salt).hash === user.passwordHash;
}

export function publicUser(user) {
  return { id: user.id, email: user.email, created_at: user.createdAt };
}

export default {
  normalizeLocalEmail,
  isValidLocalEmail,
  hashPassword,
  verifyPassword,
  publicUser,
};
