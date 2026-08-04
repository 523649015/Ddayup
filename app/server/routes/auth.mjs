/**
 * 本地账号认证路由组（注册 / 登录 / 重置密码 / 刷新会话 / 登出）。
 *
 * 从 hmdao-api.mjs 的 route() 巨型 if 链中原样剥离，**行为零变更**：
 * 状态码、错误码、错误文案、响应字段均与拆分前逐字一致。
 *
 * 依赖通过 deps 注入，避免与主文件产生循环 import。
 */

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
    const { email, password } = await readJson(req);
    const users = await readUsers();
    const user = users.find((item) => item.email === normalizeLocalEmail(email));
    if (!user) {
      return sendAuthError(res, 404, 'user_not_found', '该邮箱尚未注册，请先创建账号');
    }
    if (!verifyPassword(String(password || ''), user)) {
      return sendAuthError(res, 401, 'invalid_credentials', '密码错误，请重试或重置密码');
    }
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
