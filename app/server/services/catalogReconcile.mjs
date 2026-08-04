// 模型目录自动对账服务（从 hmdao-api.mjs 171..301 迁移）：检测上游「下架 / 新增」模型。
// 思路：对每个已激活平台调用其 /models 实时清单，与本地 MODEL_CATALOG 做 diff：
//   removed = 目录里登记、但上游已不存在（疑似下架，生成会失败，应及时替换）
//   added   = 上游存在、但目录未登记（新增模型，可考虑补登）
// 火山方舟特殊：/models 返回的是「已部署推理接入点」而非模型名，因此改核对
// Ark（providers/ark.mjs）缓存的 ep-xxxx 是否仍存活。
// 工厂模式：BYOK 服务函数经 deps 注入（本服务必须在 byok 服务之后接线）；
// catalogReconcileState 为服务内部状态，主文件经 getCatalogReconcileState() 读取。
import path from 'node:path';
import process from 'node:process';
import { readJsonFile, writeJsonFileAtomic } from '../core/json-store.mjs';
import { getAllArkEndpoints } from '../providers/ark.mjs';
import { MODEL_CATALOG } from './modelCatalogData.mjs';

export function createCatalogReconcileService(deps = {}) {
  const {
    DATA_DIR,
    PROVIDER_BASE_URLS,
    getActivatedProviderRecord,
    normalizeRelayEndpointInput,
    requestRelayModelsEndpoint,
    extractFirstString,
    normalizeCatalogIdentifier,
    hydrateActivatedProviderRecordsFromDisk,
    listActivatedProviderRecords,
  } = deps;

  const CATALOG_RECONCILE_FILE = path.join(DATA_DIR, 'catalog-reconcile.json');
  const RECONCILABLE_PROVIDERS = ['bailian', 'siliconflow', 'volcengine', 'deepseek', 'zhipu', 'minimax', 'modelscope', 'openai'];
  let catalogReconcileState = { updatedAt: '', providers: {} };

  function loadCatalogReconcileState() {
    const parsed = readJsonFile(CATALOG_RECONCILE_FILE, null);
    if (parsed && typeof parsed === 'object') {
      catalogReconcileState = { updatedAt: parsed.updatedAt || '', providers: parsed.providers || {} };
    }
  }
  function saveCatalogReconcileState() {
    try {
      writeJsonFileAtomic(CATALOG_RECONCILE_FILE, catalogReconcileState);
    } catch (e) { console.error('[reconcile] save state failed:', e.message); }
  }
  loadCatalogReconcileState();

  async function fetchLiveProviderModelIds(providerId) {
    const record = getActivatedProviderRecord(providerId, '');
    const apiKey = String(record?.apiKey || '').trim();
    if (!apiKey) return { ok: false, reason: 'not-activated' };
    const baseUrl = normalizeRelayEndpointInput(record?.endpoint || PROVIDER_BASE_URLS[providerId] || '');
    if (!baseUrl) return { ok: false, reason: 'no-base-url' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await requestRelayModelsEndpoint(`${baseUrl}/models`, apiKey, controller.signal, 20000);
      if (!response.ok) return { ok: false, reason: `http-${response.status}` };
      let payload = null;
      try { payload = response.text ? JSON.parse(response.text) : null; } catch { /* 非 JSON */ }
      const items = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
      const ids = items
        .map((item) => extractFirstString(item?.id) || extractFirstString(item?.model) || extractFirstString(item?.name))
        .filter(Boolean);
      return { ok: true, ids };
    } catch (error) {
      return { ok: false, reason: error?.name === 'AbortError' ? 'timeout' : (error?.message || 'fetch-failed') };
    } finally {
      clearTimeout(timer);
    }
  }

  async function reconcileProviderCatalog(providerId) {
    const live = await fetchLiveProviderModelIds(providerId);
    const entries = MODEL_CATALOG.filter((m) => m.provider === providerId);
    const result = {
      provider: providerId,
      checkedAt: new Date().toISOString(),
      ok: live.ok,
      catalogCount: entries.length,
    };
    if (!live.ok) {
      result.reason = live.reason;
      return result;
    }
    const liveSet = new Set(live.ids.map((id) => normalizeCatalogIdentifier(id)));
    result.liveCount = live.ids.length;
    if (providerId === 'volcengine') {
      // Ark：核对缓存接入点存活；上游多出的接入点视为「新增」。
      const cachedEps = new Set();
      const removed = [];
      for (const [catalogId, v] of getAllArkEndpoints()) {
        const ep = normalizeCatalogIdentifier(v?.endpointId);
        if (!ep) continue;
        cachedEps.add(ep);
        if (!liveSet.has(ep)) {
          removed.push({ id: catalogId, endpointId: v.endpointId, upstreamModel: v.modelVersion || '', reason: 'endpoint-missing' });
        }
      }
      result.removed = removed;
      result.added = live.ids
        .filter((id) => !cachedEps.has(normalizeCatalogIdentifier(id)))
        .map((id) => ({ id }));
    } else {
      result.removed = entries
        .filter((m) => {
          const upstream = normalizeCatalogIdentifier(m.upstreamModel || m.id);
          return upstream && !liveSet.has(upstream);
        })
        .map((m) => ({ id: m.id, name: m.name, mode: m.mode, upstreamModel: m.upstreamModel || m.id, reason: 'missing-upstream' }));
      const catalogUpstreams = new Set(entries.map((m) => normalizeCatalogIdentifier(m.upstreamModel || m.id)));
      result.added = live.ids
        .filter((id) => !catalogUpstreams.has(normalizeCatalogIdentifier(id)))
        .map((id) => ({ id }));
    }
    return result;
  }

  async function reconcileModelCatalog(providerFilter = '') {
    hydrateActivatedProviderRecordsFromDisk();
    const activatedIds = new Set(listActivatedProviderRecords().map((r) => r.provider));
    const targets = providerFilter
      ? [providerFilter]
      : RECONCILABLE_PROVIDERS.filter((p) => activatedIds.has(p));
    const results = {};
    for (const p of targets) {
      results[p] = await reconcileProviderCatalog(p);
    }
    catalogReconcileState = {
      updatedAt: new Date().toISOString(),
      providers: { ...catalogReconcileState.providers, ...results },
    };
    saveCatalogReconcileState();
    return results;
  }

  // 目录条目生命周期标注：live（上游确认在售）/ missing（疑似下架）/ unknown（未对账）
  function catalogLifecycleFor(item) {
    const providerState = catalogReconcileState.providers?.[item?.provider];
    if (!providerState || !providerState.ok) return 'unknown';
    const removed = Array.isArray(providerState.removed) ? providerState.removed : [];
    if (removed.some((r) => r.id === item.id || (r.upstreamModel && normalizeCatalogIdentifier(r.upstreamModel) === normalizeCatalogIdentifier(item.upstreamModel || item.id)))) {
      return 'missing';
    }
    return 'live';
  }

  // 后台定时对账（默认 6 小时，可用 HMDAO_CATALOG_RECONCILE_INTERVAL_MS 覆盖，0 关闭）
  const CATALOG_RECONCILE_INTERVAL_MS = Number(process.env.HMDAO_CATALOG_RECONCILE_INTERVAL_MS ?? 6 * 3600 * 1000);
  if (Number.isFinite(CATALOG_RECONCILE_INTERVAL_MS) && CATALOG_RECONCILE_INTERVAL_MS > 0 && !process.env.HMDAO_TEST_NO_SERVER) {
    const reconcileTimer = setInterval(() => {
      reconcileModelCatalog().catch((e) => console.error('[reconcile] periodic run failed:', e.message));
    }, CATALOG_RECONCILE_INTERVAL_MS);
    reconcileTimer.unref?.();
  }

  return {
    loadCatalogReconcileState,
    saveCatalogReconcileState,
    fetchLiveProviderModelIds,
    reconcileProviderCatalog,
    reconcileModelCatalog,
    catalogLifecycleFor,
    getCatalogReconcileState: () => catalogReconcileState,
  };
}
