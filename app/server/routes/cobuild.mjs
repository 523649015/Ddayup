/**
 * 需求共建（cobuild）路由组
 *
 * 由 hmdao-api.mjs 的 route() if 链逐字外移而来（分支体一字未改），
 * 通过 deps 注入访问主文件的模块级函数与常量，保证行为与迁移前完全一致。
 */

export function registerCobuildRoutes(router, deps) {
  const {
    crypto,
    getCobuildUserSafe,
    getUserFromRequest,
    maskEmailForDisplay,
    readCobuild,
    readJson,
    send,
    sendAuthError,
    writeCobuild,
  } = deps;

  router.register('GET', '/api/cobuild', async (req, res, url) => {
    const entries = await readCobuild();
    const limit = Number(url.searchParams.get('limit') || '0') || 0;
    const type = String(url.searchParams.get('type') || '').trim();
    let list = [...entries].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (type) list = list.filter((e) => e.type === type);
    if (limit > 0) list = list.slice(0, limit);
    return send(res, 200, {
      success: true,
      entries: list,
      total: entries.length,
    });
  });

  router.register('POST', '/api/cobuild', async (req, res, url) => {
    const body = await readJson(req);
    const userId = getUserFromRequest(req, body);
    if (!userId) return sendAuthError(res, 401, 'unauthenticated', '仅限已注册用户提交需求共建，请先登录后再操作。');
    const user = await getCobuildUserSafe(userId);
    if (!user) return sendAuthError(res, 401, 'unauthenticated', '仅限已注册用户提交需求共建，请先登录后再操作。');

    const message = String(body.message || '').trim();
    const donation = Number(body.donation || 0) || 0;
    if (!message && donation <= 0) {
      return send(res, 400, { success: false, error: { code: 'empty', message: '请填写反馈留言或选择打赏金额。' } });
    }
    if (message.length > 2000) {
      return send(res, 400, { success: false, error: { code: 'too_long', message: '留言内容过长（上限 2000 字）。' } });
    }
    if (donation < 0 || donation > 1000000) {
      return send(res, 400, { success: false, error: { code: 'invalid_amount', message: '打赏金额无效。' } });
    }

    const tags = Array.isArray(body.tags)
      ? body.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 6)
      : [];
    const hasMessage = Boolean(message);
    const hasDonation = donation > 0;
    const entryType = hasMessage && hasDonation ? 'both' : hasDonation ? 'donation' : 'suggestion';

    const entries = await readCobuild();
    const entry = {
      id: `cb_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      userId: user.id,
      userEmail: maskEmailForDisplay(user.email),
      message,
      tags,
      donation,
      type: entryType,
      likes: 0,
      likedBy: [],
      comments: [],
      createdAt: new Date().toISOString(),
    };
    entries.push(entry);
    await writeCobuild(entries);
    return send(res, 200, { success: true, entry, gaveDonation: hasDonation });
  });

  router.registerPattern('POST', /^\/api\/cobuild\/([^/]+)\/like$/, async (req, res, url) => {
    const likeMatch = url.pathname.match(/^\/api\/cobuild\/([^/]+)\/like$/);
    if (req.method === 'POST' && likeMatch) {
      const body = await readJson(req);
      const userId = getUserFromRequest(req, body);
      if (!userId) return sendAuthError(res, 401, 'unauthenticated', '仅限已注册用户操作，请先登录。');
      const entries = await readCobuild();
      const entry = entries.find((e) => e.id === likeMatch[1]);
      if (!entry) return send(res, 404, { success: false, error: { code: 'not_found', message: '记录不存在。' } });
      entry.likedBy = Array.isArray(entry.likedBy) ? entry.likedBy : [];
      const idx = entry.likedBy.indexOf(userId);
      if (idx >= 0) {
        entry.likedBy.splice(idx, 1);
      } else {
        entry.likedBy.push(userId);
      }
      entry.likes = entry.likedBy.length;
      await writeCobuild(entries);
      return send(res, 200, { success: true, likes: entry.likes, liked: idx < 0 });
    }
  });

  router.registerPattern('POST', /^\/api\/cobuild\/([^/]+)\/comment$/, async (req, res, url) => {
    const commentMatch = url.pathname.match(/^\/api\/cobuild\/([^/]+)\/comment$/);
    if (req.method === 'POST' && commentMatch) {
      const body = await readJson(req);
      const userId = getUserFromRequest(req, body);
      if (!userId) return sendAuthError(res, 401, 'unauthenticated', '仅限已注册用户操作，请先登录。');
      const user = await getCobuildUserSafe(userId);
      if (!user) return sendAuthError(res, 401, 'unauthenticated', '仅限已注册用户操作，请先登录。');
      const text = String(body.text || '').trim();
      if (!text) return send(res, 400, { success: false, error: { code: 'empty', message: '评论内容不能为空。' } });
      if (text.length > 1000) return send(res, 400, { success: false, error: { code: 'too_long', message: '评论过长（上限 1000 字）。' } });
      const entries = await readCobuild();
      const entry = entries.find((e) => e.id === commentMatch[1]);
      if (!entry) return send(res, 404, { success: false, error: { code: 'not_found', message: '记录不存在。' } });
      entry.comments = Array.isArray(entry.comments) ? entry.comments : [];
      entry.comments.push({
        id: `cm_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
        userId: user.id,
        userEmail: maskEmailForDisplay(user.email),
        text,
        createdAt: new Date().toISOString(),
      });
      await writeCobuild(entries);
      return send(res, 200, { success: true, comments: entry.comments });
    }
  });
}

export default registerCobuildRoutes;
