import path from 'node:path';
import { BlenderPluginAdapter } from './adapters/blender-plugin-adapter.mjs';
import { UnrealPluginAdapter } from './adapters/unreal-plugin-adapter.mjs';
import { ensureDir, nowIso, readJsonFile, slugify, writeJsonFile } from './adapters/shared.mjs';
import { classifyDccActivity, deriveDccRuntimeState, sanitizeDccText } from './runtime-state.mjs';

function createLogStore(filePath, maxEntries = 800) {
  let cache = null;

  async function load() {
    if (cache) return cache;
    const payload = await readJsonFile(filePath, []);
    cache = Array.isArray(payload) ? payload : [];
    return cache;
  }

  async function save(entries) {
    cache = entries.slice(-maxEntries);
    await writeJsonFile(filePath, cache);
  }

  return {
    async append(entry) {
      const items = await load();
      const runtimeState = entry.runtimeState || classifyDccActivity(entry.engine, entry.message, {
        level: entry.level,
        action: entry.action,
      });
      const message = sanitizeDccText(entry.message, runtimeState.message || 'DCC 环境状态已更新。');
      const shortMessage = sanitizeDccText(entry.shortMessage, runtimeState.label || message);
      const next = [
        ...items,
        {
          id: `${Date.now()}-${slugify(entry.scope || entry.engine || entry.level || 'log')}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: nowIso(),
          ...entry,
          message,
          shortMessage,
          runtimeState,
          dedupeKey: entry.dedupeKey || runtimeState.dedupeKey,
        },
      ];
      await save(next);
      return next.at(-1);
    },
    async list(filters = {}) {
      const items = await load();
      const limit = Math.max(1, Math.min(500, Number(filters.limit || 50)));
      return items
        .filter((item) => !filters.engine || item.engine === filters.engine)
        .filter((item) => !filters.jobId || item.jobId === filters.jobId)
        .filter((item) => !filters.level || item.level === filters.level)
        .slice(-limit)
        .reverse();
    },
  };
}

function createJobStore(filePath, maxEntries = 200) {
  let cache = null;

  async function load() {
    if (cache) return cache;
    const payload = await readJsonFile(filePath, []);
    cache = Array.isArray(payload) ? payload : [];
    return cache;
  }

  async function save(entries) {
    cache = entries.slice(-maxEntries);
    await writeJsonFile(filePath, cache);
  }

  return {
    async create(payload) {
      const items = await load();
      const runtimeState = payload.runtimeState || classifyDccActivity(payload.engine, payload.message || payload.title || `${payload.action} queued`, {
        level: payload.status === 'failed' ? 'error' : 'info',
        action: payload.action,
      });
      const job = {
        id: `${Date.now()}-${payload.engine}-${payload.action}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: nowIso(),
        startedAt: null,
        endedAt: null,
        status: 'pending',
        ...payload,
        runtimeState,
        shortMessage: sanitizeDccText(payload.shortMessage, runtimeState.label || payload.title || payload.message || `${payload.action}`),
        dedupeKey: payload.dedupeKey || runtimeState.dedupeKey,
      };
      await save([...items, job]);
      return job;
    },
    async update(jobId, patch) {
      const items = await load();
      const next = items.map((item) => {
        if (item.id !== jobId) return item;
        const merged = { ...item, ...patch };
        const runtimeState = merged.runtimeState || classifyDccActivity(merged.engine, merged.message || merged.title || merged.action, {
          level: merged.status === 'failed' ? 'error' : 'info',
          action: merged.action,
        });
        return {
          ...merged,
          runtimeState,
          shortMessage: sanitizeDccText(merged.shortMessage, runtimeState.label || merged.message || merged.title || merged.action),
          dedupeKey: merged.dedupeKey || runtimeState.dedupeKey,
        };
      });
      await save(next);
      return next.find((item) => item.id === jobId) || null;
    },
    async list(filters = {}) {
      const items = await load();
      const limit = Math.max(1, Math.min(200, Number(filters.limit || 20)));
      return items
        .filter((item) => !filters.engine || item.engine === filters.engine)
        .filter((item) => !filters.status || item.status === filters.status)
        .slice(-limit)
        .reverse();
    },
    async summarize() {
      const items = await load();
      return {
        total: items.length,
        running: items.filter((item) => item.status === 'running').length,
        failed: items.filter((item) => item.status === 'failed').length,
        completed: items.filter((item) => item.status === 'completed').length,
        latest: items.at(-1) || null,
      };
    },
  };
}

export function createDccEnvironmentManager({
  repoRoot,
  dataDir,
  getUnrealBridgeState,
} = {}) {
  const runtimeDir = path.join(dataDir, 'dcc-environment-manager');
  const backupRoot = path.join(dataDir, 'dcc-plugin-backups');
  const logStore = createLogStore(path.join(runtimeDir, 'logs.json'));
  const jobStore = createJobStore(path.join(runtimeDir, 'jobs.json'));
  const adapters = {
    unreal: new UnrealPluginAdapter({ repoRoot, backupRoot, getBridgeState: getUnrealBridgeState }),
    blender: new BlenderPluginAdapter({ repoRoot, backupRoot }),
  };
  let cache = { expiresAt: 0, value: null, probeEngine: '' };
  let pendingRefresh = null;

  async function log(entry) {
    await ensureDir(runtimeDir);
    return logStore.append(entry);
  }

  function createReporter({ engine, scope, jobId }) {
    return {
      info(message, context) {
        const runtimeState = classifyDccActivity(engine, message, { level: 'info', action: context?.action });
        return log({ level: 'info', engine, scope, jobId, message, shortMessage: runtimeState.label, runtimeState, dedupeKey: runtimeState.dedupeKey, context: context || null, action: context?.action || null });
      },
      warn(message, context) {
        const runtimeState = classifyDccActivity(engine, message, { level: 'warn', action: context?.action });
        return log({ level: 'warn', engine, scope, jobId, message, shortMessage: runtimeState.label, runtimeState, dedupeKey: runtimeState.dedupeKey, context: context || null, action: context?.action || null });
      },
      error(message, context) {
        const runtimeState = classifyDccActivity(engine, message, { level: 'error', action: context?.action });
        return log({ level: 'error', engine, scope, jobId, message, shortMessage: runtimeState.label, runtimeState, dedupeKey: runtimeState.dedupeKey, context: context || null, action: context?.action || null });
      },
    };
  }

  function normalizeProbeEngine(value) {
    return value === 'blender' || value === 'unreal' ? value : '';
  }

  async function buildStatus({ probeEngine = '' } = {}) {
    const explicitProbeEngine = normalizeProbeEngine(probeEngine);
    const previousEngines = cache.value?.engines || {};
    const [requestedRaw, jobSummary] = await Promise.all([
      explicitProbeEngine ? adapters[explicitProbeEngine].getStatus() : null,
      jobStore.summarize(),
    ]);
    const unrealRaw = explicitProbeEngine === 'unreal'
      ? requestedRaw
      : explicitProbeEngine
        ? previousEngines.unreal || null
        : await adapters.unreal.getStatus();
    const blenderRaw = explicitProbeEngine === 'blender'
      ? requestedRaw
      : explicitProbeEngine
        ? previousEngines.blender || null
        : await adapters.blender.getStatus();
    const unreal = unrealRaw
      ? {
          ...unrealRaw,
          runtimeState: deriveDccRuntimeState('unreal', unrealRaw),
        }
      : null;
    const blender = blenderRaw
      ? {
          ...blenderRaw,
          runtimeState: deriveDccRuntimeState('blender', blenderRaw),
        }
      : null;
    return {
      success: true,
      generatedAt: nowIso(),
      robotReady: true,
      manager: {
        id: 'dcc-environment-manager',
        label: 'DCC Environment Manager',
        adapters: [
          { id: adapters.unreal.adapterId, engine: 'unreal' },
          { id: adapters.blender.adapterId, engine: 'blender' },
        ],
        jobSummary,
      },
      paths: {
        status: '/api/dcc/environment/status',
        action: '/api/dcc/environment/action',
        jobs: '/api/dcc/environment/jobs',
        logs: '/api/dcc/environment/logs',
        legacyStatus: '/api/dcc/plugins/status',
        legacyAction: '/api/dcc/plugins/action',
      },
      engines: {
        unreal,
        blender,
      },
    };
  }

  async function refreshStatus({ probeEngine = '' } = {}) {
    const explicitProbeEngine = normalizeProbeEngine(probeEngine);
    if (pendingRefresh?.probeEngine === explicitProbeEngine) {
      return pendingRefresh.promise;
    }
    let refreshPromise = null;
    refreshPromise = (async () => {
      try {
        const value = await buildStatus({ probeEngine: explicitProbeEngine });
        cache = {
          value,
          expiresAt: Date.now() + 3000,
          probeEngine: explicitProbeEngine,
        };
        return value;
      } finally {
        if (pendingRefresh?.promise === refreshPromise) {
          pendingRefresh = null;
        }
      }
    })();
    pendingRefresh = {
      probeEngine: explicitProbeEngine,
      promise: refreshPromise,
    };
    return refreshPromise;
  }

  async function getStatus({ force = false, probeEngine = '' } = {}) {
    const explicitProbeEngine = normalizeProbeEngine(probeEngine);
    if (force) {
      return refreshStatus({ probeEngine: explicitProbeEngine });
    }
    const cacheMatchesProbe = cache.probeEngine === explicitProbeEngine;
    if (cache.value && cacheMatchesProbe) {
      if (cache.expiresAt <= Date.now() && pendingRefresh?.probeEngine !== explicitProbeEngine) {
        refreshStatus({ probeEngine: explicitProbeEngine }).catch(() => {});
      }
      return cache.value;
    }
    return refreshStatus({ probeEngine: explicitProbeEngine });
  }

  async function cleanupStaleJobs(engine) {
    const jobs = await jobStore.list({ engine, limit: 200 });
    const staleStatuses = new Set(['queued', 'pending', 'running']);
    const staleBeforeMs = Date.now() - (15 * 60 * 1000);
    let cleaned = 0;

    for (const job of jobs) {
      if (!staleStatuses.has(String(job.status || ''))) continue;
      const startedAtMs = job.startedAt ? Date.parse(job.startedAt) : 0;
      const createdAtMs = job.createdAt ? Date.parse(job.createdAt) : 0;
      const referenceMs = startedAtMs || createdAtMs;
      if (!referenceMs || Number.isNaN(referenceMs) || referenceMs > staleBeforeMs) continue;
      const runtimeState = classifyDccActivity(engine, 'Marked stale during DCC environment cleanup.', { level: 'error', action: job.action });
      await jobStore.update(job.id, {
        status: 'failed',
        endedAt: nowIso(),
        message: 'Marked stale during DCC environment cleanup.',
        error: 'Marked stale during DCC environment cleanup.',
        runtimeState,
        shortMessage: runtimeState.label,
        dedupeKey: runtimeState.dedupeKey,
      });
      cleaned += 1;
    }

    return cleaned;
  }

  async function runAction(request = {}) {
    const engine = request.engine === 'blender' ? 'blender' : 'unreal';
    const action = String(request.action || 'detect').trim().toLowerCase();
    const adapter = adapters[engine];
    if (!adapter) throw new Error(`Unsupported DCC environment engine: ${engine}`);

    const supportedActions = ['detect', 'connect', 'install', 'update', 'reinstall', 'rebuild', 'repair', 'cleanup', 'remove', 'rollback'];
    if (!supportedActions.includes(action)) {
      throw new Error(`Unsupported DCC environment action: ${action}`);
    }

    const queuedState = classifyDccActivity(engine, `${action} queued`, { level: 'info', action });
    const job = await jobStore.create({
      engine,
      adapter: adapter.adapterId,
      action,
      request,
      status: 'queued',
      title: `${adapter.label} ${action}`,
      runtimeState: queuedState,
      shortMessage: queuedState.label,
      dedupeKey: queuedState.dedupeKey,
    });
    const reporter = createReporter({ engine, scope: adapter.adapterId, jobId: job.id });
    await reporter.info('DCC environment job queued.', { action, request });
    const runningState = classifyDccActivity(engine, `${action} running`, { level: 'info', action });
    await jobStore.update(job.id, {
      status: 'running',
      startedAt: nowIso(),
      runtimeState: runningState,
      shortMessage: runningState.label,
      dedupeKey: runningState.dedupeKey,
    });

    try {
      if (action === 'detect') {
        const message = 'DCC environment status refreshed.';
        const completedState = classifyDccActivity(engine, message, { level: 'info', action });
        const finishedJob = await jobStore.update(job.id, {
          status: 'completed',
          endedAt: nowIso(),
          message,
          runtimeState: completedState,
          shortMessage: completedState.label,
          dedupeKey: completedState.dedupeKey,
        });
        await reporter.info('DCC environment detection completed.', { action });
        const status = await getStatus({ force: true, probeEngine: engine });
        return {
          success: true,
          action,
          engine,
          adapter: adapter.adapterId,
          job: finishedJob,
          message,
          status,
        };
      }

      const result = await adapter.runAction(action, request, reporter);
      if (action === 'cleanup') {
        const cleanedJobs = await cleanupStaleJobs(engine);
        if (cleanedJobs > 0) {
          await reporter.info('Cleaned stale DCC environment jobs during runtime cleanup.', { cleanedJobs, action });
        }
      }
      const completedState = classifyDccActivity(engine, result.message, { level: 'info', action });
      const finishedJob = await jobStore.update(job.id, {
        status: 'completed',
        endedAt: nowIso(),
        message: result.message,
        backupId: result.backupId || null,
        runtimeState: completedState,
        shortMessage: completedState.label,
        dedupeKey: completedState.dedupeKey,
      });
      await reporter.info('DCC environment job completed.', { action, backupId: result.backupId || null });
      const status = await getStatus({ force: action !== 'repair', probeEngine: engine });
      return {
        success: true,
        action,
        engine,
        adapter: adapter.adapterId,
        job: finishedJob,
        ...result,
        status,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedState = classifyDccActivity(engine, message, { level: 'error', action });
      const failedJob = await jobStore.update(job.id, {
        status: 'failed',
        endedAt: nowIso(),
        message,
        error: message,
        runtimeState: failedState,
        shortMessage: failedState.label,
        dedupeKey: failedState.dedupeKey,
      });
      await reporter.error('DCC environment job failed.', { action, error: message });
      cache = { expiresAt: 0, value: null, probeEngine: '' };
      const wrapped = new Error(message);
      wrapped.job = failedJob;
      throw wrapped;
    }
  }

  return {
    getStatus,
    runAction,
    async listJobs(filters = {}) {
      return await jobStore.list(filters);
    },
    async listLogs(filters = {}) {
      return await logStore.list(filters);
    },
  };
}
