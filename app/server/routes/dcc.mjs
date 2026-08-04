// routes/dcc.mjs
// DCC（虚幻/Blender）网关路由组：从 hmdao-api.mjs 的 route() if 链迁移而来。
// 依赖以显式注入传递，避免子模块反向 import 主文件造成循环依赖。
// 所有 handler 体为原 route() 分支的逐字搬迁，业务逻辑未改动。

export function registerDccRoutes(router, deps) {
  const {
    send,
    readJson,
    DCC_ENVIRONMENT_MANAGER,
    DCC_ENGINES,
    summarizeCurrentUnrealEnvironment,
    probeTcp,
    isUnrealDirectBridgeOnline,
    UNREAL_DIRECT_BRIDGE,
    DCC_RECORDING_LOCK,
    ENABLE_UNREAL_PIXEL_STREAMING_LEGACY,
    DEFAULT_UNREAL_PIXEL_URL,
    DEFAULT_UNREAL_REMOTE_URL,
    UNREAL_PIXEL_STREAMING_LEGACY,
    getUnrealControlConfig,
    readUnrealConfig,
    writeUnrealConfig,
  } = deps;

  // GET /api/dcc/status
  router.register('GET', '/api/dcc/status', async (req, res, url) => {
    const probeEngine = url.searchParams.get('engine') === 'blender'
      ? 'blender'
      : url.searchParams.get('engine') === 'unreal'
        ? 'unreal'
        : '';
    const pluginStatus = await DCC_ENVIRONMENT_MANAGER.getStatus({
      force: url.searchParams.get('force') === '1',
      probeEngine,
    });
    const engines = {};
    for (const [id, config] of Object.entries(DCC_ENGINES)) {
      const isUnreal = id === 'unreal';
      const pluginEngine = pluginStatus?.engines?.[id] || null;
      const currentEnvironmentSummary = isUnreal
        ? summarizeCurrentUnrealEnvironment(pluginEngine)
        : pluginEngine
          ? {
            level: pluginEngine.level,
            summary: pluginEngine.summary,
            recommendedAction: pluginEngine.recommendedAction,
            adapter: pluginEngine.adapter || null,
          }
          : null;
      engines[id] = {
        ...config,
        reachable: isUnreal
          ? Boolean(pluginEngine?.plugin?.directBridgeReadyForTargetProject)
          : pluginEngine
            ? Boolean(pluginEngine?.plugin?.serviceReachable || pluginEngine?.plugin?.readyForLiveCapture)
            : await probeTcp(config.port),
        gateway: true,
        requiredPlugin: !isUnreal,
        integration: isUnreal
          ? (pluginEngine?.integration?.activeMode || pluginEngine?.integration?.recommendedMode || 'editor-direct')
          : 'websocket',
        previewProvider: isUnreal
          ? (pluginEngine?.integration?.previewProvider || 'editor-direct')
          : 'websocket',
        wsPath: isUnreal ? '/ws/dcc/unreal' : '/ws/dcc-capture',
        directBridgeOnline: isUnreal
          ? Boolean(pluginEngine?.host?.targetProjectRunning) && Boolean(pluginEngine?.plugin?.directBridgeOnline ?? isUnrealDirectBridgeOnline())
          : undefined,
        directBridgeClientCount: isUnreal
          ? Boolean(pluginEngine?.host?.targetProjectRunning)
            ? Number(pluginEngine?.plugin?.directBridgeClientCount ?? UNREAL_DIRECT_BRIDGE.browsers.size)
            : 0
          : undefined,
        pluginInstalled: isUnreal ? Boolean(pluginEngine?.plugin?.installed) : undefined,
        pluginEnabledInProject: isUnreal ? Boolean(pluginEngine?.plugin?.enabledInProject) : undefined,
        hostProcessRunning: isUnreal ? Boolean(pluginEngine?.host?.hostProcessRunning) : undefined,
        targetProjectRunning: isUnreal ? Boolean(pluginEngine?.host?.targetProjectRunning) : undefined,
        directBridgeReadyForTargetProject: isUnreal ? Boolean(pluginEngine?.plugin?.directBridgeReadyForTargetProject) : undefined,
        cameraCount: isUnreal
          ? (Boolean(pluginEngine?.host?.targetProjectRunning) ? Number(pluginEngine?.plugin?.cameraCount || 0) : 0)
          : undefined,
        projectPath: isUnreal ? (pluginEngine?.project?.path || null) : undefined,
        directBridgePlugin: isUnreal && Boolean(pluginEngine?.host?.targetProjectRunning) ? UNREAL_DIRECT_BRIDGE.pluginInfo : undefined,
        pixelStreamingUrl: isUnreal && ENABLE_UNREAL_PIXEL_STREAMING_LEGACY ? DEFAULT_UNREAL_PIXEL_URL : undefined,
        remoteControlUrl: isUnreal ? DEFAULT_UNREAL_REMOTE_URL : undefined,
        installPath: id === 'blender'
          ? 'plugins/blender/hmdao_blender_capture'
          : pluginEngine?.plugin?.effectivePath || 'plugins/unreal/HMDaoUnrealCapture',
        environmentManager: currentEnvironmentSummary,
        runtimeState: pluginEngine?.runtimeState || currentEnvironmentSummary?.runtimeState || null,
        official: isUnreal ? pluginEngine?.official || null : undefined,
        guidance: isUnreal ? pluginEngine?.guidance || null : undefined,
        compatibility: isUnreal ? pluginEngine?.compatibility || null : undefined,
      };
    }
    return send(res, 200, {
      success: true,
      service: 'hmdao-dcc-gateway',
      wsPath: '/ws/dcc-capture',
      environmentManagerPath: '/api/dcc/environment/status',
      environmentManagerActionPath: '/api/dcc/environment/action',
      environmentManagerJobsPath: '/api/dcc/environment/jobs',
      environmentManagerLogsPath: '/api/dcc/environment/logs',
      pluginManagerPath: '/api/dcc/plugins/status',
      pluginManagerActionPath: '/api/dcc/plugins/action',
      mockFallback: true,
      features: {
        blenderWebSocketGateway: true,
        unrealEditorDirectAdapter: true,
        unrealPixelStreamingLegacyAdapter: ENABLE_UNREAL_PIXEL_STREAMING_LEGACY,
        unrealRemoteControlAdapter: true,
      },
      recordingLockedBy: DCC_RECORDING_LOCK.engine,
      engines,
    });
  });

  // GET /api/dcc/environment/status | /api/dcc/plugins/status
  router.register('GET', '/api/dcc/environment/status', dccEnvStatus);
  router.register('GET', '/api/dcc/plugins/status', dccEnvStatus);
  async function dccEnvStatus(req, res, url) {
    const probeEngine = url.searchParams.get('engine') === 'blender'
      ? 'blender'
      : url.searchParams.get('engine') === 'unreal'
        ? 'unreal'
        : '';
    const status = await DCC_ENVIRONMENT_MANAGER.getStatus({
      force: url.searchParams.get('force') === '1',
      probeEngine,
    });
    return send(res, 200, status);
  }

  // GET /api/dcc/environment/jobs
  router.register('GET', '/api/dcc/environment/jobs', async (req, res, url) => {
    const jobs = await DCC_ENVIRONMENT_MANAGER.listJobs({
      engine: url.searchParams.get('engine') || '',
      status: url.searchParams.get('status') || '',
      limit: url.searchParams.get('limit') || '',
    });
    return send(res, 200, { success: true, jobs });
  });

  // GET /api/dcc/environment/logs
  router.register('GET', '/api/dcc/environment/logs', async (req, res, url) => {
    const logs = await DCC_ENVIRONMENT_MANAGER.listLogs({
      engine: url.searchParams.get('engine') || '',
      jobId: url.searchParams.get('jobId') || '',
      level: url.searchParams.get('level') || '',
      limit: url.searchParams.get('limit') || '',
    });
    return send(res, 200, { success: true, logs });
  });

  // POST /api/dcc/environment/action | /api/dcc/plugins/action
  router.register('POST', '/api/dcc/environment/action', dccEnvAction);
  router.register('POST', '/api/dcc/plugins/action', dccEnvAction);
  async function dccEnvAction(req, res, url) {
    const payload = await readJson(req);
    try {
      const result = await DCC_ENVIRONMENT_MANAGER.runAction(payload);
      return send(res, 200, result);
    } catch (error) {
      return send(res, 400, {
        success: false,
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  // POST /api/dcc/unreal/pixel-streaming/start | GET /api/dcc/unreal/pixel-proxy* | GET /api/dcc/unreal/status
  router.register('POST', '/api/dcc/unreal/pixel-streaming/start', dccUnrealPixel);
  router.registerPrefix('GET', '/api/dcc/unreal/pixel-proxy', dccUnrealPixel);
  router.register('GET', '/api/dcc/unreal/status', dccUnrealPixel);
  async function dccUnrealPixel(req, res, url) {
    if (!ENABLE_UNREAL_PIXEL_STREAMING_LEGACY) {
      return send(res, 404, { success: false, error: { message: 'Unreal Pixel Streaming legacy path is disabled by default.' } });
    }
    if (await UNREAL_PIXEL_STREAMING_LEGACY.handle(req, res, url)) return;
  }

  // GET /api/dcc/unreal/config
  router.register('GET', '/api/dcc/unreal/config', async (req, res) => {
    const controlConfig = await getUnrealControlConfig();
    return send(res, 200, { success: true, ...controlConfig });
  });

  // POST /api/dcc/unreal/config
  router.register('POST', '/api/dcc/unreal/config', async (req, res) => {
    const body = await readJson(req);
    const current = await readUnrealConfig();
    const next = {
      ...current,
      controlObjectPath: String(body.controlObjectPath || body.objectPath || '').trim(),
      cameraFunction: String(body.cameraFunction || body.functionName || 'SetHMDaoCamera').trim() || 'SetHMDaoCamera',
      signalUrl: String(body.signalUrl || current.signalUrl || process.env.HMDAO_UNREAL_SIGNAL_URL || 'ws://127.0.0.1:8888').trim(),
    };
    await writeUnrealConfig(next);
    const controlConfig = await getUnrealControlConfig();
    return send(res, 200, { success: true, ...controlConfig });
  });
}
