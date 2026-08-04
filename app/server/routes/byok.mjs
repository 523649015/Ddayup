/**
 * BYOK（Bring Your Own Key）平台激活 路由组。
 *
 * 从 hmdao-api.mjs 的 route() 巨型 if 链中原样剥离（行为零变更）：
 *   GET  /api/byok/providers        平台清单
 *   GET  /api/byok/runtime          已激活平台运行时快照
 *   POST /api/byok/relay/discover   聚合中转站模型发现
 *   POST /api/byok/relay/activate   聚合中转站批量激活
 *   POST /api/byok/validate         单平台 Key 校验并激活
 *   POST /api/byok/deactivate       平台去激活（或全部清空）
 *   POST /api/byok/validate-all     批量本地格式校验
 *
 * 依赖通过 deps 注入，避免与主文件产生循环 import。
 */

export function registerByokRoutes(router, deps) {
  const { send, readJson, maskKey } = deps;

  router.register('GET', '/api/byok/providers', (req, res) => send(res, 200, {
    success: true,
    providers: deps.providers,
  }));

  router.register('GET', '/api/byok/runtime', (req, res) => send(res, 200, {
    success: true,
    activatedProviders: deps.listActivatedProviderRecords()
      .map((record) => deps.publicActivatedProviderRecord(record))
      .filter(Boolean),
    selectedImageAnalysisRemote: deps.publicImageAnalysisRuntime(deps.pickActivatedCloudImageAnalysisRuntime()),
    recommendations: deps.buildRuntimeRecommendations(),
  }));

  router.register('POST', '/api/byok/relay/discover', async (req, res) => {
    const {
      endpoint = '',
      apiKey = '',
      relayPresetId = 'generic-openai-relay',
    } = await readJson(req);
    const discovery = await deps.fetchRelayModelIndex({
      endpoint: String(endpoint || '').trim(),
      apiKey: String(apiKey || '').trim(),
      relayPresetId: String(relayPresetId || 'generic-openai-relay').trim(),
    });
    return send(res, discovery.success ? 200 : discovery.status || 400, {
      success: discovery.success,
      endpoint: discovery.endpoint || deps.normalizeRelayEndpointInput(endpoint),
      relayPresetId: discovery.relayPresetId || String(relayPresetId || 'generic-openai-relay').trim(),
      relayName: discovery.relayName || null,
      models: discovery.models,
      recommended: discovery.recommended,
      message: discovery.message,
    });
  });

  router.register('POST', '/api/byok/relay/activate', async (req, res) => {
    const started = Date.now();
    const {
      endpoint = '',
      apiKey = '',
      relayPresetId = 'generic-openai-relay',
    } = await readJson(req);
    const normalizedEndpoint = deps.normalizeRelayEndpointInput(endpoint);
    const normalizedKey = String(apiKey || '').trim();
    const discovery = await deps.fetchRelayModelIndex({
      endpoint: normalizedEndpoint,
      apiKey: normalizedKey,
      relayPresetId: String(relayPresetId || 'generic-openai-relay').trim(),
    });
    if (!discovery.success) {
      return send(res, discovery.status || 400, {
        success: false,
        endpoint: discovery.endpoint || normalizedEndpoint,
        relayPresetId: discovery.relayPresetId || String(relayPresetId || 'generic-openai-relay').trim(),
        models: discovery.models,
        recommended: discovery.recommended,
        error: {
          title: 'Relay activation failed',
          message: discovery.message || '聚合平台模型激活失败',
        },
        latencyMs: Date.now() - started,
      });
    }

    const activationRecords = deps.buildRelayActivationRecords(discovery.models);
    if (!activationRecords.length) {
      return send(res, 400, {
        success: false,
        endpoint: normalizedEndpoint,
        relayPresetId: discovery.relayPresetId,
        models: discovery.models,
        recommended: discovery.recommended,
        error: {
          title: 'No compatible models',
          message: '当前中转站模型列表已返回，但暂未匹配到可直接同步到 DDUp 画布的主流模型',
        },
        latencyMs: Date.now() - started,
      });
    }

    for (const record of activationRecords) {
      deps.setActivatedProviderRecord(record.provider, record.mode, {
        model: record.model || null,
        apiKey: normalizedKey,
        maskedKey: maskKey(normalizedKey),
        endpoint: (discovery.endpoint || normalizedEndpoint) || undefined,
        activatedAt: Date.now(),
        relaySource: discovery.relayName || discovery.relayPresetId || 'relay',
        relayPresetId: String(relayPresetId || discovery.relayPresetId || 'generic-openai-relay').trim() || null,
        catalogModelIds: record.catalogModelIds,
        availableModels: record.availableModels,
        primaryPrice: record.primaryPrice,
        primaryCurrency: record.primaryCurrency,
      });
    }

    deps.broadcastCatalogUpdate('relay-provider-activated');
    return send(res, 200, {
      success: true,
      endpoint: discovery.endpoint || normalizedEndpoint,
      relayPresetId: discovery.relayPresetId,
      relayName: discovery.relayName,
      models: discovery.models,
      recommended: discovery.recommended,
      activations: activationRecords.map((record) => ({
        provider: record.provider,
        mode: record.mode,
        model: record.model,
        catalogModelIds: record.catalogModelIds,
        availableModels: record.availableModels,
        primaryPrice: record.primaryPrice,
        primaryCurrency: record.primaryCurrency,
        maskedKey: maskKey(normalizedKey),
      })),
      message: 'Activated ' + activationRecords.length + ' platform capability record(s) and synced them into the canvas model list.',
      latencyMs: Date.now() - started,
    });
  });

  router.register('POST', '/api/byok/validate', async (req, res) => {
    const started = Date.now();
    const {
      provider,
      apiKey,
      mode = 'llm',
      model,
      upstreamModel = '',
      endpoint = '',
      accessKeyId = '',
      secretKey = '',
    } = await readJson(req);
    const normalizedEndpoint = deps.normalizeRelayEndpointInput(endpoint);
    const known = deps.providers.find((item) => item.id === provider);
    if (!known) return send(res, 400, { success: false, provider, mode, maskedKey: '', error: { title: '未知平台', message: `平台 ${provider} 未配置。` } });
    if (!apiKey || String(apiKey).trim().length < 8) {
      return send(res, 400, { success: false, provider, mode, maskedKey: maskKey(apiKey), error: { title: 'API Key 无效', message: 'API Key 至少需要 8 个字符。' } });
    }
    const validationResult = await deps.validateByokProvider({ provider, apiKey, model, mode, endpoint: normalizedEndpoint });
    if (!validationResult.success) {
      return send(res, 400, {
        success: false,
        provider,
        mode,
        model,
        maskedKey: maskKey(String(apiKey).trim()),
        error: {
          title: validationResult.validated ? '远程校验失败' : '校验失败',
          message: validationResult.message || (known.name + ' 校验失败。'),
        },
        latencyMs: Date.now() - started,
      });
    }
    deps.setActivatedProviderRecord(provider, mode, {
      model: validationResult.model || String(upstreamModel || '').trim() || model || null,
      apiKey: String(apiKey).trim(),
      maskedKey: maskKey(String(apiKey).trim()),
      // 关键修复：AccessKey/SecretKey 必须落盘，否则每次重激活/重启都要重填，
      // 且 syncArkEndpoints 拿不到凭证就无法自动建 ep-xxxx（之前 ark-endpoints.json 一直为空的根因）。
      accessKeyId: String(accessKeyId || '').trim() || undefined,
      secretKey: String(secretKey || '').trim() || undefined,
      endpoint: normalizedEndpoint || undefined,
      activatedAt: Date.now(),
    });
    // 关键修复：激活火山方舟时一次性点亮该平台全部模式（图片 Seedream lite/pro/4.5、
    // 视频 Seedance、文本 LLM），避免「只激活了一个」的困惑。文本 LLM 仅在提供了
    // AccessKey/SecretKey（syncArkEndpoints 已为每个模型自动创建 ep-xxxx 接入点）时才点亮，
    // 否则保留「需接入点」提示，由用户去控制台创建接入点后在节点里选 ep-xxxx。
    if (provider === 'volcengine') {
      const volcModes = Array.from(new Set(deps.MODEL_CATALOG.filter((m) => m.provider === 'volcengine').map((m) => m.mode)));
      const akSkProvided = Boolean(accessKeyId && secretKey);
      for (const m of volcModes) {
        if (m === mode) continue; // 当前已激活的模式不重复写
        if (m === 'llm' && !akSkProvided) continue; // 文本 LLM 需接入点，无 AK/SK 不点亮
        deps.setActivatedProviderRecord(provider, m, {
          model: null,
          apiKey: String(apiKey).trim(),
          maskedKey: maskKey(String(apiKey).trim()),
          accessKeyId: String(accessKeyId || '').trim() || undefined,
          secretKey: String(secretKey || '').trim() || undefined,
          endpoint: normalizedEndpoint || undefined,
          activatedAt: Date.now(),
        });
      }
    }
    deps.broadcastCatalogUpdate('provider-activated');
    let arkEndpoints = undefined;
    // 重激活时若本次未填 AK/SK，回退用已落盘的凭证，避免「每次都要重填」。
    const savedVolc = provider === 'volcengine' ? deps.getActivatedProviderRecord('volcengine', '') : null;
    const effAccessKeyId = String(accessKeyId || '').trim() || (savedVolc && savedVolc.accessKeyId) || undefined;
    const effSecretKey = String(secretKey || '').trim() || (savedVolc && savedVolc.secretKey) || undefined;
    if (provider === 'volcengine' && effAccessKeyId && effSecretKey) {
      try {
        const volcModels = deps.MODEL_CATALOG.filter((m) => m.provider === 'volcengine');
        arkEndpoints = await deps.syncArkEndpoints(volcModels, {
          accessKeyId: String(effAccessKeyId).trim(),
          secretKey: String(effSecretKey).trim(),
        });
      } catch (e) {
        arkEndpoints = { error: e.message };
      }
    } else if (provider === 'volcengine') {
      arkEndpoints = { skipped: true, reason: 'ark 需同时提供 AccessKey/SecretKey 才能自动创建接入点；否则请在控制台创建后由下拉选择。' };
    }
    return send(res, 200, {
      success: true,
      provider,
      mode,
      model: validationResult.model || model,
      maskedKey: maskKey(String(apiKey).trim()),
      endpoint: normalizedEndpoint || undefined,
      arkEndpoints,
      message: validationResult.message || (known.name + ' completed remote validation and activation.'),
      latencyMs: Date.now() - started,
    });
  });

  router.register('POST', '/api/byok/deactivate', async (req, res) => {
    const { provider, mode } = await readJson(req);
    if (provider) {
      deps.deleteActivatedProviderRecord(provider, mode || '');
    } else {
      deps.hydrateActivatedProviderRecordsFromDisk();
      deps.activatedProviders.clear();
      deps.persistActivatedProviderRecordsToDisk();
    }
    deps.broadcastCatalogUpdate('provider-deactivated');
    return send(res, 200, { success: true, provider: provider || null, mode: mode || null });
  });

  router.register('POST', '/api/byok/validate-all', async (req, res) => {
    const { keys = [] } = await readJson(req);
    const results = keys.map((item) => ({
      success: Boolean(item.apiKey && String(item.apiKey).length >= 8),
      provider: item.provider,
      mode: item.mode || 'llm',
      maskedKey: maskKey(item.apiKey),
    }));
    return send(res, 200, {
      success: results.every((item) => item.success),
      results,
      summary: { total: results.length, success: results.filter((item) => item.success).length, failed: results.filter((item) => !item.success).length },
    });
  });
}

export default registerByokRoutes;
