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
import { buildPlatformInfo } from '../platform-utils.mjs';
import { checkExtensionEntitlement } from './extension-license.mjs';
import { isTrustedLoopbackRequest } from '../lib/client-ip.mjs';

// ★2026-09-16 修复（E）：exampleRuntimePath 此前把 'oiiotool.exe' / 'yt-dlp.exe' / 'aria2c.exe'
// 写死，在 Linux / macOS 上展示的是不存在的文件名。现按平台后缀生成（纯函数，无副作用）。
const EXE_SUFFIX = buildPlatformInfo().exeSuffix;

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
    resolveLocalPostAria2Backend,
    resolveLocalPostFfmpegBackend,
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
    oiio: buildLocalPostBackendStatus('oiio', oiioBackend, `oiiotool${EXE_SUFFIX}`),
    gmic: buildLocalPostBackendStatus('gmic', gmicBackend, `gmic${EXE_SUFFIX}`),
    ytdlp: buildLocalPostBackendStatus('ytdlp', resolveLocalPostYtDlpBackend(), `yt-dlp${EXE_SUFFIX}`),
    florence2: buildLocalPostBackendStatus('florence2', resolveLocalPostFlorence2Backend(), path.resolve(APP_DIR, 'server', 'local_image_example_florence2.py')),
    // Step 2/3/5: aria2 + ffmpeg 是网盘/视频素材下载引擎组，此前漏装在 localPostBackends 快照里，
    // 导致面板读 localPostBackends?.aria2 永远为空、卡片状态缺失（消息不对称）。
    aria2: buildLocalPostBackendStatus('aria2', resolveLocalPostAria2Backend(), `aria2c${EXE_SUFFIX}`),
    ffmpeg: buildLocalPostBackendStatus('ffmpeg', resolveLocalPostFfmpegBackend(), `ffmpeg${EXE_SUFFIX}`),
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

// ===== 运行时写操作闸门（2026-09-16 收紧）=====
// 旧实现 `requireApiKey` 只在【配置了 HMDAO_API_KEY】时才校验，线上没配 → 等于匿名全放行，
// 任何人都能触发服务器下载/安装运行时（带宽与磁盘被白嫖）。
//
// 新闸门放行仅限三类：
//   ① 运维通道：HMDAO_API_KEY 匹配（保留原语义，便于脚本/运维一键安装）
//   ② 本机直连：真实客户端为回环（本机开发、本机 Web 面板「一键安装」不受影响）
//   ③ 已授权设备：body/query 的 deviceId 经授权判定为 trial / paid
// 拒绝语义：无 deviceId → 401 NO_DEVICE；有但 none/expired → 402 LICENSE_REQUIRED（带 mode）。
//
// ⚠ 调用方必须先 `readJson(req)` 再调用本函数（deviceId 在 body 里）。
// ⚠ 回环判定必须用 XFF 首跳（nginx 反代后 socket 恒为 127.0.0.1），见 lib/client-ip.mjs。
export async function requireRuntimeWrite(deps, req, res, body) {
  const expect = String(process.env.HMDAO_API_KEY || '').trim();
  if (expect) {
    const auth = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
    const fromHeader = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const fromQuery = req.url ? (new URL(req.url, 'http://x').searchParams.get('apiKey') || '') : '';
    if (fromHeader === expect || fromQuery === expect) return true;
  }

  if (isTrustedLoopbackRequest(req)) return true;

  const fromQuery = req.url ? (new URL(req.url, 'http://x').searchParams.get('deviceId') || '') : '';
  const deviceId = String((body && body.deviceId) || fromQuery || '').trim();
  if (!deviceId) {
    deps.send(res, 401, {
      success: false,
      error: {
        code: 'NO_DEVICE',
        message: '缺少设备标识：请从扩展内发起安装，或先在扩展内登录 / 开启试用',
      },
    });
    return false;
  }

  const dataDir = deps.DATA_DIR;
  if (!dataDir) {
    deps.send(res, 500, { success: false, error: { code: 'GATE_MISCONFIGURED', message: '服务端缺少 DATA_DIR 依赖' } });
    return false;
  }
  const { entitled, mode } = await checkExtensionEntitlement(dataDir, deviceId);
  if (!entitled) {
    deps.send(res, 402, {
      success: false,
      mode,
      error: {
        code: 'LICENSE_REQUIRED',
        message: mode === 'expired'
          ? '试用已到期：请订阅后重试运行时安装'
          : '需要先在扩展内开启试用或完成订阅后再安装运行时',
      },
    });
    return false;
  }
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
    if (!(await requireRuntimeWrite(deps, req, res, body))) return undefined;
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
    if (!(await requireRuntimeWrite(deps, req, res, body))) return undefined;
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
    if (!(await requireRuntimeWrite(deps, req, res, body))) return undefined;
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
    if (!(await requireRuntimeWrite(deps, req, res, body))) return undefined;
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

  router.registerPrefix('GET', '/api/health/local-post/runtime/install/', async (req, res, url) => {
    // 只读任务查询同样收口：避免匿名枚举安装任务（含下载地址/路径等运行细节）
    if (!(await requireRuntimeWrite(deps, req, res, {}))) return undefined;
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
