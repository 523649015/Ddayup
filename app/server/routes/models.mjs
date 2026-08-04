/**
 * 模型目录 路由组。
 *
 * 从 hmdao-api.mjs 的 route() 巨型 if 链中原样剥离（行为零变更）：
 *   GET|POST /api/models/reconcile  模型目录对账（?cached=1 读缓存；?provider= 过滤单平台）
 *   GET      /api/models/catalog    画布可用模型目录
 *   GET      /api/models/manifest   轻量清单（供前端 checkPresetUpdates 比对版本）
 *
 * 依赖通过 deps 注入。注意 catalogReconcileState 在主文件中是可重赋值的 let，
 * 必须以 getter（getCatalogReconcileState）注入而非值传递，否则拿到的是过期快照。
 */

export function registerModelsRoutes(router, deps) {
  const { send } = deps;

  // 模型目录对账：GET ?cached=1 读上次结果；POST（或 GET 无 cached）现场对账。
  // 可选 ?provider=bailian 只对账单个平台；默认对账全部已激活平台。
  router.register(['GET', 'POST'], '/api/models/reconcile', async (req, res, url) => {
    if (req.method === 'GET' && url.searchParams.get('cached') === '1') {
      return send(res, 200, { success: true, cached: true, ...deps.getCatalogReconcileState() });
    }
    const providerFilter = String(url.searchParams.get('provider') || '').trim();
    try {
      const results = await deps.reconcileModelCatalog(providerFilter);
      return send(res, 200, {
        success: true,
        updatedAt: deps.getCatalogReconcileState().updatedAt,
        providers: results,
      });
    } catch (error) {
      return send(res, 502, { success: false, error: { message: error?.message || 'reconcile failed' } });
    }
  });

  router.register('GET', '/api/models/catalog', (req, res, url) => {
    const mode = String(url.searchParams.get('mode') || '').trim();
    const nodeType = String(url.searchParams.get('nodeType') || '').trim();
    return send(res, 200, {
      success: true,
      updatedAt: new Date().toISOString(),
      models: deps.modelCatalogPayload({
        mode: mode || undefined,
        nodeType: nodeType || undefined,
      }),
    });
  });

  // 轻量模型清单：供前端 checkPresetUpdates 比对版本（当前返回空清单，
  // 以本地声明版本为准，避免 404 噪声）。
  router.register('GET', '/api/models/manifest', (req, res) => send(res, 200, {}));
}

export default registerModelsRoutes;
