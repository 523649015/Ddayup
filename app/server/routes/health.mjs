/**
 * 健康检查 / 本地后处理运行时管理 路由组。
 *
 * 从 hmdao-api.mjs 的 route() 巨型 if 链中原样剥离（行为零变更），
 * 并消除了 `/api/health` 与 `/api/health/local-post/refresh` 之间
 * 完全重复的 localPostBackends 快照构建逻辑（原先两处各写一遍）。
 *
 * 依赖通过 deps 注入，避免与主文件产生循环 import。
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 构建本地后处理运行时能力快照。
 * 原 hmdao-api.mjs 中 /api/health 与 /api/health/local-post/refresh 各自内联了一份
 * 完全相同的 18 行构建代码，此处统一收敛为单一实现。
 */
export function buildLocalPostBackendsSnapshot(deps) {
  const {
    APP_DIR,
    resolveLocalPostOcioBackend,
    resolveLocalPostOiioBackend,
    resolveLocalPostGmicBackend,
    resolveLocalPostUpscaleBackend,
    resolveLocalPostYtDlpBackend,
    resolveLocalPostFlorence2Backend,
    buildLocalPostBackendStatus,
  } = deps;

  const ocioBackend = resolveLocalPostOcioBackend({ ocioExecutionMode: 'auto' });
  const oiioBackend = resolveLocalPostOiioBackend({ ocioExecutionMode: 'auto' }, 'image', '');
  const gmicBackend = resolveLocalPostGmicBackend();
  const fsrBackend = resolveLocalPostUpscaleBackend({ routePolicy: 'fsr-preview', executionMode: 'auto' }, 'image');
  const realbasicvsrBackend = resolveLocalPostUpscaleBackend({ routePolicy: 'realbasicvsr', executionMode: 'auto' }, 'video');
  const supirBackend = resolveLocalPostUpscaleBackend({ routePolicy: 'supir', executionMode: 'auto' }, 'image');

  return {
    ocio: buildLocalPostBackendStatus('ocio', ocioBackend, path.resolve(APP_DIR, 'server', 'local_post_example_ocio.py')),
    oiio: buildLocalPostBackendStatus('oiio', oiioBackend, 'oiiotool.exe'),
    gmic: buildLocalPostBackendStatus('gmic', gmicBackend, 'gmic.exe'),
    ytdlp: buildLocalPostBackendStatus('ytdlp', resolveLocalPostYtDlpBackend(), 'yt-dlp.exe'),
    florence2: buildLocalPostBackendStatus('florence2', resolveLocalPostFlorence2Backend(), path.resolve(APP_DIR, 'server', 'local_image_example_florence2.py')),
    upscale: {
      'fsr-preview': buildLocalPostBackendStatus('fsr-preview', fsrBackend, path.resolve(APP_DIR, 'server', 'local_post_example_fsr.py')),
      realbasicvsr: buildLocalPostBackendStatus('realbasicvsr', realbasicvsrBackend, path.resolve(APP_DIR, 'server', 'local_post_example_realbasicvsr.py')),
      supir: buildLocalPostBackendStatus('supir', supirBackend, path.resolve(APP_DIR, 'server', 'local_post_example_supir.py')),
    },
  };
}

/** 统一的「不支持的运行时」参数校验，原先在 5 个分支里各写一遍。 */
function rejectUnsupportedRuntime(deps, res, runtimeKey) {
  const { send, LOCAL_POST_INSTALLABLE_RUNTIMES } = deps;
  if (LOCAL_POST_INSTALLABLE_RUNTIMES[runtimeKey]) return false;
  send(res, 400, {
    success: false,
    error: { message: `unsupported-runtime:${runtimeKey || 'unknown'}` },
  });
  return true;
}

function failure(deps, res, status, error, extra = {}) {
  deps.send(res, status, {
    success: false,
    ...extra,
    error: { message: error instanceof Error ? error.message : String(error) },
  });
}

export function registerHealthRoutes(router, deps) {
  const { send, readJson } = deps;

  router.register('GET', '/api/health', (req, res) => send(res, 200, {
    success: true,
    service: 'hmdao-api',
    time: new Date().toISOString(),
    realApiEnabled: deps.isRealApiProxyEnabled(),
    realApiDiagnostics: {
      enabled: deps.isRealApiProxyEnabled(),
      source: process.env.HMDAO_REAL_API === '1' ? 'env' : 'activated-provider',
      apiPort: deps.PORT,
      litellmBaseUrlConfigured: Boolean(String(process.env.HMDAO_LITELLM_BASE_URL || '').trim()),
      litellmApiKeyConfigured: Boolean(String(process.env.HMDAO_LITELLM_API_KEY || '').trim()),
    },
    capabilities: {
      dccGateway: true,
      dccStatusPath: '/api/dcc/status',
      dccWsPath: '/ws/dcc-capture',
      unrealDccWsPath: '/ws/dcc/unreal',
      workflowGateway: true,
      workflowWsPath: '/ws/workflow',
      catalogWsPath: '/ws/catalog',
      localPostBackends: buildLocalPostBackendsSnapshot(deps),
    },
  }));

  // P1-1: 运行平台自动识别端点（前端按 OS 呈现安装说明/按钮，macOS 全链路入口）
  router.register('GET', '/api/health/platform', (req, res) => {
    const info = deps.buildPlatformInfo();
    return send(res, 200, {
      success: true,
      platform: info.platform,
      arch: info.arch,
      isWindows: info.isWindows,
      isMac: info.isMac,
      isLinux: info.isLinux,
      homebrewPrefix: info.homebrewPrefix,
      release: info.release,
      exeSuffix: info.exeSuffix,
      supportsNativeDirectoryPicker: info.supportsNativeDirectoryPicker,
    });
  });

  router.register('POST', '/api/health/local-post/refresh', (req, res) => {
    deps.clearLocalPostRuntimeDetectionCache();
    return send(res, 200, {
      success: true,
      refreshedAt: new Date().toISOString(),
      capabilities: {
        localPostBackends: buildLocalPostBackendsSnapshot(deps),
      },
    });
  });

  router.register(['GET', 'POST'], '/api/health/local-post/doctor', async (req, res, url) => {
    let body = {};
    if (req.method === 'POST') {
      body = await readJson(req).catch(() => ({}));
    }
    const forceRelease = url.searchParams.get('force') === '1' || body?.forceRelease === true;
    const report = await deps.buildLocalPostDoctorReport({ forceRelease });
    return send(res, 200, { success: true, ...report });
  });

  router.register('GET', '/api/health/local-post/runtime/install-jobs', (req, res, url) => {
    const runtimeKey = String(url.searchParams.get('runtimeKey') || '').trim();
    const jobs = Array.from(deps.LOCAL_POST_RUNTIME_INSTALL_JOBS.values())
      .filter((job) => !runtimeKey || job.runtimeKey === runtimeKey)
      .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))
      .map((job) => deps.toRuntimeInstallJobResponse(job));
    return send(res, 200, { success: true, jobs });
  });

  // P2-1: 安装目录即时校验（前端选/填目录后即时反馈，不等待安装报错）
  router.register('POST', '/api/health/local-post/runtime/validate-path', async (req, res) => {
    const body = await readJson(req).catch(() => ({}));
    const rawPath = String(body?.path || '').trim();
    const platformInfo = deps.buildPlatformInfo();
    const forbidden = rawPath
      ? deps.isForbiddenInstallTarget(rawPath, platformInfo, [path.resolve(deps.APP_DIR)])
      : false;
    // ⚠ 行为修正（本次拆分中唯一的非等价变更，已刻意保留并单独记录）：
    // 原实现位于 hmdao-api.mjs 中，那里 `fs` 绑定的是 `promises as fs`（node:fs/promises），
    // 因此 `fs.existsSync` 恒为 undefined，调用必然抛 TypeError 并被 catch 吞掉，
    // 导致 exists 永远返回 false。前端 ModelDownloadPanel 依赖该字段区分
    // 「目录可用（已存在）」与「目录可用（将自动创建）」，故实际永远只显示后者。
    // 本模块 `fs` 为完整的 node:fs，existsSync 可用，语义恢复为设计意图。
    let exists = false;
    try { exists = Boolean(rawPath) && fs.existsSync(rawPath); } catch { exists = false; }
    return send(res, 200, {
      ok: !forbidden,
      forbidden,
      reason: forbidden ? 'target-dir-not-allowed' : null,
      exists,
      platform: platformInfo.isWindows ? 'win32' : platformInfo.isMac ? 'darwin' : 'linux',
    });
  });

  // P3-4: 暴露托管运行时目录所在磁盘的可用/总容量，供前端「安装前体积预警」复用。
  router.register('GET', '/api/health/local-post/disk', async (req, res) => {
    const dirPath = deps.LOCAL_POST_MANAGED_RUNTIME_DIR;
    const [freeBytes, totalBytes] = await Promise.all([
      deps.getAvailableDiskBytes(dirPath),
      deps.getDiskTotalBytes(dirPath),
    ]);
    return send(res, 200, {
      ok: true,
      dir: String(dirPath || ''),
      freeBytes: typeof freeBytes === 'number' ? freeBytes : null,
      totalBytes: typeof totalBytes === 'number' ? totalBytes : null,
    });
  });

  router.register('POST', '/api/health/local-post/runtime/install', async (req, res) => {
    const body = await readJson(req).catch(() => ({}));
    const runtimeKey = String(body?.runtimeKey || '').trim();
    if (rejectUnsupportedRuntime(deps, res, runtimeKey)) return undefined;
    const job = await deps.startRuntimeInstallJob(runtimeKey, {
      requestedAction: String(body?.requestedAction || 'install').trim() || 'install',
      targetDir: String(body?.targetDir || '').trim(),
    });
    return send(res, 200, { success: true, job: deps.toRuntimeInstallJobResponse(job) });
  });

  router.register('POST', '/api/health/local-post/runtime/uninstall', async (req, res) => {
    const body = await readJson(req).catch(() => ({}));
    const runtimeKey = String(body?.runtimeKey || '').trim();
    if (rejectUnsupportedRuntime(deps, res, runtimeKey)) return undefined;
    try {
      const result = await deps.uninstallManagedLocalPostRuntime(runtimeKey);
      return send(res, 200, { success: true, ...result });
    } catch (error) {
      return failure(deps, res, 500, error);
    }
  });

  // P3-9：列出可回滚的备份点
  router.register('GET', '/api/health/local-post/runtime/backups', (req, res, url) => {
    const runtimeKey = String(url.searchParams.get('runtimeKey') || '').trim();
    if (rejectUnsupportedRuntime(deps, res, runtimeKey)) return undefined;
    try {
      const backups = deps.listManagedLocalPostBackups(runtimeKey);
      return send(res, 200, { success: true, runtimeKey, backups, count: backups.length });
    } catch (error) {
      return failure(deps, res, 500, error);
    }
  });

  // P3-9：回滚到指定（或最新）备份点
  router.register('POST', '/api/health/local-post/runtime/rollback', async (req, res) => {
    const body = await readJson(req).catch(() => ({}));
    const runtimeKey = String(body?.runtimeKey || '').trim();
    const backupId = body?.backupId != null ? String(body.backupId) : null;
    if (rejectUnsupportedRuntime(deps, res, runtimeKey)) return undefined;
    try {
      const result = await deps.rollbackManagedLocalPostRuntime(runtimeKey, { backupId });
      return send(res, 200, { success: true, ...result });
    } catch (error) {
      return failure(deps, res, 409, error, { code: error?.code || 'ROLLBACK_FAILED' });
    }
  });

  // P3-3：清理旧版本残留的临时产物（staging / 下载缓存，可选清理备份）
  router.register('POST', '/api/health/local-post/runtime/cleanup', async (req, res) => {
    const body = await readJson(req).catch(() => ({}));
    const runtimeKey = String(body?.runtimeKey || '').trim();
    const removeBackups = Boolean(body?.removeBackups);
    if (rejectUnsupportedRuntime(deps, res, runtimeKey)) return undefined;
    try {
      const result = deps.cleanupManagedLocalPostRuntimeTemp(runtimeKey, { removeBackups });
      return send(res, 200, { success: true, ...result });
    } catch (error) {
      return failure(deps, res, 500, error);
    }
  });

  router.registerPrefix('GET', '/api/health/local-post/runtime/install/', (req, res, url) => {
    const jobId = decodeURIComponent(url.pathname.slice('/api/health/local-post/runtime/install/'.length));
    const job = deps.getRuntimeInstallJob(jobId);
    if (!job) {
      return send(res, 404, { success: false, error: { message: 'runtime-install-job-not-found' } });
    }
    return send(res, 200, { success: true, job: deps.toRuntimeInstallJobResponse(job) });
  });

  return router;
}

export default registerHealthRoutes;
