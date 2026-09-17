/**
 * 素材库 + 本地设置 路由组。
 *
 * 从 hmdao-api.mjs 的 route() 巨型 if 链中原样剥离（行为零变更）：
 *   GET|PUT  /api/settings/dispatch          调度配置读写
 *   GET|PUT  /api/settings/assets            素材库存储路径读写
 *   POST     /api/settings/assets/pick-directory  本地目录选择器
 *   GET      /api/assets/library             素材库全量清单
 *   GET      /api/assets/duplicates          现场查重（并持久化结果）
 *   GET      /api/assets/duplicates/persisted 读取上次查重结果
 *   POST     /api/assets/delete              批量删除
 *   POST     /api/assets/prune-missing       清理丢失条目
 *   POST     /api/assets/restore             恢复条目
 *   POST     /api/assets/validate            媒体可用性探测
 *   POST     /api/assets/repair              媒体转码修复
 *   POST     /api/assets/import              单条导入（含 multipart）
 *   POST     /api/assets/import-directory    目录批量导入
 *   GET|HEAD /api/assets/content/*           素材字节流（前缀路由）
 *
 * 依赖通过 deps 注入，避免与主文件产生循环 import。
 */

export function registerAssetsRoutes(router, deps) {
  const { send, readJson, getUserFromRequest } = deps;

  // ---- 设置 ----
  router.register('GET', '/api/settings/dispatch', async (req, res) => {
    const config = await deps.loadOperationDispatchConfig({ force: true });
    return send(res, 200, {
      success: true,
      path: deps.OPERATION_DISPATCH_CONFIG_FILE,
      config,
    });
  });

  router.register('PUT', '/api/settings/dispatch', async (req, res) => {
    const body = await readJson(req);
    const nextConfig = body?.config && typeof body.config === 'object' ? body.config : body;
    if (!nextConfig || typeof nextConfig !== 'object' || Array.isArray(nextConfig)) {
      return send(res, 400, { success: false, error: { message: 'Dispatch config must be an object.' } });
    }
    const config = await deps.saveOperationDispatchConfig(nextConfig);
    return send(res, 200, {
      success: true,
      path: deps.OPERATION_DISPATCH_CONFIG_FILE,
      config,
    });
  });

  router.register('GET', '/api/settings/assets', async (req, res) => {
    const settings = await deps.readAssetLibrarySettings();
    return send(res, 200, {
      success: true,
      path: deps.ASSET_LIBRARY_SETTINGS_FILE,
      catalogPath: deps.ASSET_LIBRARY_CATALOG_FILE,
      storagePath: settings.storagePath,
      defaultStoragePath: deps.DEFAULT_ASSET_LIBRARY_STORAGE_DIR,
    });
  });

  router.register('PUT', '/api/settings/assets', async (req, res) => {
    const body = await readJson(req);
    const storagePath = String(body?.storagePath || '').trim();
    if (!storagePath) {
      return send(res, 400, { success: false, error: { message: 'Asset library storage path is required.' } });
    }
    const settings = await deps.writeAssetLibrarySettings(storagePath);
    return send(res, 200, {
      success: true,
      path: deps.ASSET_LIBRARY_SETTINGS_FILE,
      catalogPath: deps.ASSET_LIBRARY_CATALOG_FILE,
      storagePath: settings.storagePath,
      defaultStoragePath: deps.DEFAULT_ASSET_LIBRARY_STORAGE_DIR,
    });
  });

  router.register('POST', '/api/settings/assets/pick-directory', async (req, res) => {
    try {
      const body = await readJson(req);
      const settings = await deps.readAssetLibrarySettings();
      const picked = await deps.pickLocalDirectory(
        String(body?.initialPath || settings.storagePath || deps.DEFAULT_ASSET_LIBRARY_STORAGE_DIR),
        String(body?.autoSelectPath || ''),
      );
      if (picked.canceled || !picked.path) {
        return send(res, 200, { success: true, canceled: true, path: '' });
      }
      return send(res, 200, {
        success: true,
        canceled: false,
        path: picked.path,
      });
    } catch (error) {
      // FolderBrowserDialog 在「无交互桌面 / 服务会话」环境会抛 InvalidOperationException；
      // 返回结构化错误（而非 500）让前端给出明确提示，避免静默失败。
      const message = String((error && error.message) || error || 'pick-directory-failed');
      console.error(`[api] pick-directory failed: ${message}`);
      return send(res, 200, { success: false, canceled: false, path: '', error: message });
    }
  });

  // ---- 素材库（按用户硬隔离：所有操作须携带有效登录态，未登录返回 401）----
  const requireUserId = (req, res) => {
    const userId = getUserFromRequest(req);
    if (!userId) {
      send(res, 401, { success: false, error: { code: 'UNAUTHENTICATED', message: '请先登录' } });
      return null;
    }
    return userId;
  };

  router.register('GET', '/api/assets/library', async (req, res) => {
    const userId = requireUserId(req, res);
    if (!userId) return undefined;
    const items = await deps.readAssetLibraryCatalog(userId);
    return send(res, 200, { success: true, items });
  });

  router.register('GET', '/api/assets/duplicates', async (req, res) => {
    const userId = requireUserId(req, res);
    if (!userId) return undefined;
    const items = await deps.readAssetLibraryCatalog(userId);
    const groups = deps.buildAssetLibraryDuplicateGroups(items);
    const duplicateIds = groups.flatMap((group) => group.duplicateIds);
    // 持久化：把本次计算结果写入缓存文件，供「去重看板常驻视图」直接读取，
    // 避免每次打开都重算，也使结果在多次会话间稳定可见。
    await deps.writeAssetLibraryDuplicates(userId, groups).catch(() => undefined);
    return send(res, 200, {
      success: true,
      groups,
      duplicateIds,
      total: duplicateIds.length,
    });
  });

  router.register('GET', '/api/assets/duplicates/persisted', async (req, res) => {
    const userId = requireUserId(req, res);
    if (!userId) return undefined;
    const groups = await deps.readAssetLibraryDuplicates(userId).catch(() => []);
    const duplicateIds = groups.flatMap((group) => group.duplicateIds);
    return send(res, 200, {
      success: true,
      groups,
      duplicateIds,
      total: duplicateIds.length,
    });
  });

  router.register('POST', '/api/assets/delete', async (req, res) => {
    const userId = requireUserId(req, res);
    if (!userId) return undefined;
    const body = await readJson(req);
    const assetIds = Array.isArray(body?.assetIds) ? body.assetIds : [];
    const deletedIds = await deps.deleteAssetLibraryItems(userId, assetIds);
    return send(res, 200, { success: true, deletedIds });
  });

  router.register('POST', '/api/assets/prune-missing', async (req, res) => {
    const userId = requireUserId(req, res);
    if (!userId) return undefined;
    const result = await deps.pruneMissingAssetLibraryItems(userId);
    return send(res, 200, { success: true, ...result });
  });

  router.register('POST', '/api/assets/restore', async (req, res) => {
    const userId = requireUserId(req, res);
    if (!userId) return undefined;
    const body = await readJson(req);
    const inputItems = Array.isArray(body?.items) ? body.items : [];
    const restoredIds = await deps.restoreAssetLibraryItems(userId, inputItems);
    return send(res, 200, { success: true, restoredIds });
  });

  router.register('POST', '/api/assets/validate', async (req, res) => {
    const userId = requireUserId(req, res);
    if (!userId) return undefined;
    const body = await readJson(req);
    const assetId = String(body?.assetId || '').trim();
    const item = await deps.findAssetLibraryItem(userId, assetId);
    if (!item) return send(res, 404, { success: false, error: { message: 'asset-not-found' } });
    if (String(item.storageLabel || '').trim().toLowerCase() === 'reference') {
      return send(res, 200, { success: true, state: 'reference', canTranscode: false, type: item.type });
    }
    const probe = await deps.probeAssetMedia(item.filePath);
    return send(res, 200, {
      success: true,
      state: probe.state,
      canTranscode: probe.canTranscode,
      detail: probe.detail,
      type: item.type,
    });
  });

  router.register('POST', '/api/assets/repair', async (req, res) => {
    const userId = requireUserId(req, res);
    if (!userId) return undefined;
    const body = await readJson(req);
    const assetId = String(body?.assetId || '').trim();
    const items = await deps.readAssetLibraryCatalog(userId);
    const item = items.find((entry) => String(entry.id || '') === assetId || String(entry.backendAssetId || '') === assetId);
    if (!item) return send(res, 404, { success: false, error: { message: 'asset-not-found' } });
    if (String(item.storageLabel || '').trim().toLowerCase() === 'reference') {
      return send(res, 400, { success: false, error: { message: 'reference-cannot-repair' } });
    }
    const repaired = await deps.repairAssetLibraryItem(item);
    const updatedItems = items.map((entry) => {
      if (String(entry.id || '') === assetId || String(entry.backendAssetId || '') === assetId) {
        return {
          ...entry,
          filePath: repaired.filePath,
          size: repaired.size,
          contentHash: repaired.contentHash,
          updatedAt: Date.now(),
        };
      }
      return entry;
    });
    await deps.writeAssetLibraryCatalog(userId, updatedItems);
    return send(res, 200, {
      success: true,
      url: deps.buildAssetLibraryContentUrl(assetId),
      size: repaired.size,
      contentHash: repaired.contentHash,
    });
  });

  router.register('POST', '/api/assets/import', async (req, res) => {
    const userId = requireUserId(req, res);
    if (!userId) return undefined;
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    const body = contentType.includes('multipart/form-data')
      ? await deps.readAssetLibraryImportMultipart(req)
      : await readJson(req);
    const result = await deps.processAssetLibraryImportRequest(userId, body);
    return send(res, 200, {
      success: true,
      item: result.item,
      storagePath: result.storagePath,
      duplicate: Boolean(result.duplicate),
    });
  });

  router.register('POST', '/api/assets/import-directory', async (req, res) => {
    const userId = requireUserId(req, res);
    if (!userId) return undefined;
    const body = await readJson(req);
    const result = await deps.processAssetLibraryImportDirectory(userId, body);
    return send(res, 200, {
      success: true,
      canceled: result.canceled,
      path: result.path,
      items: result.items,
      report: result.report,
    });
  });

  // 素材字节流。注意：必须是前缀路由，且仅 GET/HEAD，
  // 与上方 /api/assets/* 精确路径不冲突（精确表优先于前缀表命中）。
  router.registerPrefix(['GET', 'HEAD'], '/api/assets/content/', async (req, res, url) => {
    const userId = requireUserId(req, res);
    if (!userId) return undefined;
    const assetId = deps.sanitizeLocalAssetId(url.pathname.slice('/api/assets/content/'.length));
    if (!assetId) {
      return send(res, 400, { success: false, error: { message: 'invalid-asset-id' } });
    }
    const item = await deps.findAssetLibraryItem(userId, assetId);
    if (!item?.filePath) {
      return send(res, 404, { success: false, error: { message: 'asset-not-found' } });
    }
    try {
      await deps.sendLocalFileStream(req, res, item.filePath, {
        mimeType: deps.mediaMimeTypeFromExtension(item.filePath, 'application/octet-stream'),
        contentDisposition: deps.buildSafeInlineContentDisposition(item.filePath),
      });
    } catch (e) {
      const code = (e && e.code) || '';
      console.error(`[api] /api/assets/content missing file for asset ${assetId}: ${item.filePath} (${code})`);
      if (code === 'ENOENT' || !res.headersSent) {
        return send(res, 404, { success: false, error: { message: 'asset-file-missing', assetId } });
      }
    }
    return undefined;
  });
}

export default registerAssetsRoutes;
