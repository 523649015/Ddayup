/**
 * 本地账号认证路由组（注册 / 登录 / 重置密码 / 刷新会话 / 登出）。
 *
 * 从 hmdao-api.mjs 的 route() 巨型 if 链中原样剥离，**行为零变更**：
 * 状态码、错误码、错误文案、响应字段均与拆分前逐字一致。
 *
 * 依赖通过 deps 注入，避免与主文件产生循环 import。
 */

import { clientIp } from '../lib/client-ip.mjs';

/**
 * 注册认证路由组。
 * @param {ReturnType<import('../core/http-router.mjs').createHttpRouter>} router
 * @param {object} deps 由 hmdao-api.mjs 注入的依赖集合
 */
export function registerAuthRoutes(router, deps) {
  const {
    send,
    readJson,
    sendAuthError,
    normalizeLocalEmail,
    isValidLocalEmail,
    readUsers,
    writeUsers,
    hashPassword,
    verifyPassword,
    publicUser,
    createSession,
    deleteSessionsForUser,
    sessions,
    randomUUID,
  } = deps;

  const MIN_PASSWORD_LENGTH = 8;

  // P3-安全：登录防爆破。内存级限流（单进程足够；多实例需外接 Redis，见下方注释）。
  // - 账户维度：同一 email 连续失败 MAX_FAILS 次后锁定 LOCK_MS 毫秒。
  // - IP 维度：同一来源每分钟最多 MAX_PER_MIN 次尝试（粗粒度防批量爆破）。
  // 注：多实例水平扩展时，这些 Map 不共享，应改为 Redis 计数器；当前 pm2 instances:1。
  const MAX_FAILS = 5;
  const LOCK_MS = 15 * 60 * 1000;
  const MAX_PER_MIN = 20;
  const accountFails = new Map(); // key: email -> { count, lockedUntil }
  const ipWindow = new Map();     // key: ip -> { count, resetAt }
  // ★2026-09-16：客户端 IP 取法统一收敛到 lib/client-ip.mjs（此前本文件与
  //   routes/extension-license.mjs 各写一份等价实现，行为一致但属重复代码）。

  /**
   * 注册与重置密码共用的入参校验。
   * 原实现在两处各写了一遍完全相同的 6 行校验，此处收敛为单一实现，
   * 错误码与文案保持逐字一致。
   * @returns {{ ok: true, email: string } | { ok: false, send: () => any }}
   */
  function validateCredentials(res, email, password) {
    const normalized = normalizeLocalEmail(email);
    if (!normalized || !isValidLocalEmail(normalized)) {
      return { ok: false, send: () => sendAuthError(res, 400, 'invalid_email', '请输入有效的邮箱地址') };
    }
    if (!password || String(password).length < MIN_PASSWORD_LENGTH) {
      return { ok: false, send: () => sendAuthError(res, 400, 'weak_password', '密码至少需 8 个字符') };
    }
    return { ok: true, email: normalized };
  }

  router.register('POST', '/api/auth/register', async (req, res) => {
    const { email, password } = await readJson(req);
    const check = validateCredentials(res, email, password);
    if (!check.ok) return check.send();

    const users = await readUsers();
    if (users.some((user) => user.email === check.email)) {
      return sendAuthError(res, 409, 'user_already_exists', '该邮箱已注册，请直接登录或重置密码');
    }
    const passwordData = hashPassword(String(password));
    const user = {
      id: randomUUID(),
      email: check.email,
      salt: passwordData.salt,
      passwordHash: passwordData.hash,
      createdAt: new Date().toISOString(),
    };
    users.push(user);
    await writeUsers(users);
    return send(res, 200, { success: true, user: publicUser(user), session: createSession(user) });
  });

  router.register('POST', '/api/auth/login', async (req, res) => {
    // ---- 速率限制 / 失败锁定 ----
    const ip = clientIp(req);
    const now = Date.now();

    // IP 维度：滑动窗口（每分钟 MAX_PER_MIN 次）
    const ipState = ipWindow.get(ip) || { count: 0, resetAt: now + 60_000 };
    if (now > ipState.resetAt) { ipState.count = 0; ipState.resetAt = now + 60_000; }
    ipState.count += 1;
    ipWindow.set(ip, ipState);
    if (ipState.count > MAX_PER_MIN) {
      return sendAuthError(res, 429, 'too_many_requests', '请求过于频繁，请稍后再试');
    }

    const { email, password } = await readJson(req);
    const normalizedEmail = normalizeLocalEmail(email);

    // 账户维度：锁定期内直接拒绝
    const acct = accountFails.get(normalizedEmail);
    if (acct && acct.lockedUntil > now) {
      const remainMin = Math.ceil((acct.lockedUntil - now) / 60_000);
      return sendAuthError(res, 429, 'account_locked', `账户已临时锁定，请 ${remainMin} 分钟后再试`);
    }

    const users = await readUsers();
    const user = users.find((item) => item.email === normalizedEmail);
    if (!user) {
      return sendAuthError(res, 404, 'user_not_found', '该邮箱尚未注册，请先创建账号');
    }
    if (!verifyPassword(String(password || ''), user)) {
      // 失败计数 + 锁定
      const next = { count: (acct?.count || 0) + 1, lockedUntil: acct?.lockedUntil || 0 };
      if (next.count >= MAX_FAILS) next.lockedUntil = now + LOCK_MS;
      accountFails.set(normalizedEmail, next);
      const remain = MAX_FAILS - next.count;
      return sendAuthError(res, 401, 'invalid_credentials', remain > 0 ? `密码错误，还可尝试 ${remain} 次` : '密码错误次数过多，账户已锁定 15 分钟');
    }
    // 成功：清零失败计数
    accountFails.delete(normalizedEmail);
    return send(res, 200, { success: true, user: publicUser(user), session: createSession(user) });
  });

  router.register('POST', '/api/auth/reset-password', async (req, res) => {
    const { email, password } = await readJson(req);
    const check = validateCredentials(res, email, password);
    if (!check.ok) return check.send();

    const users = await readUsers();
    const userIndex = users.findIndex((item) => item.email === check.email);
    if (userIndex < 0) {
      return sendAuthError(res, 404, 'user_not_found', '该邮箱尚未注册，请先创建账号');
    }
    const passwordData = hashPassword(String(password));
    users[userIndex] = {
      ...users[userIndex],
      salt: passwordData.salt,
      passwordHash: passwordData.hash,
      updatedAt: new Date().toISOString(),
    };
    await writeUsers(users);
    // 改密后强制吊销该用户全部会话，避免旧 refresh_token 继续可用。
    deleteSessionsForUser(users[userIndex].id);
    return send(res, 200, {
      success: true,
      message: '密码已更新，请使用新密码登录',
      user: publicUser(users[userIndex]),
    });
  });

  router.register('POST', '/api/auth/refresh', async (req, res) => {
    const { refresh_token: refreshToken } = await readJson(req);
    const session = sessions.get(refreshToken);
    if (!session || Date.now() > session.expiresAt) {
      return send(res, 401, { success: false, error: { message: 'Session expired.' } });
    }
    const users = await readUsers();
    const user = users.find((item) => item.id === session.userId);
    if (!user) return send(res, 404, { success: false, error: { message: 'User not found.' } });
    return send(res, 200, { success: true, session: createSession(user) });
  });

  router.register('POST', '/api/auth/logout', async (req, res) => {
    const { refresh_token: refreshToken } = await readJson(req);
    if (refreshToken) sessions.delete(refreshToken);
    return send(res, 200, { success: true });
  });

  return router;
}
