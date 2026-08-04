import { spawnSync } from 'node:child_process';

import { promises as fs } from 'node:fs';

import os from 'node:os';

import path from 'node:path';

import { extractFirstMatch } from '../../lib/str-utils.mjs';

import {

  UNREAL_PLUGIN_NAME,

  UNREAL_PLUGIN_FRIENDLY_NAME,

  applyProjectPluginStates,

  backupUnrealState,

  copyIfExists,

  deriveUnrealEnvironmentSummary,

  discoverUnrealEngineInstalls,

  discoverRunningProcesses,

  discoverWindowsForProcessIds,

  discoverUnrealProjects,

  hasNonAsciiText,

  isWindowsProcessAlive,

  launchWindowsProcess,

  launchWindowsProcessViaStartProcess,

  listBackups,

  pathExists,

  probeTcp,

  readJsonFile,

  removeIfExists,

  restoreBackupRecord,

  runPowerShellFile,

  runPowerShellInline,

  sleep,

  stopWindowsProcessTree,

  summarizeCommandResult,

  updateUnrealProjectPluginState,

  waitForCondition,

} from './shared.mjs';



// Incremental decoupling: pure helpers/constants extracted to keep this file focused
// on the adapter class. Behavior is unchanged — these are re-imported below.
import {
  normalizeKey,
  formatTimestampTag,
  readFileTimestamp,
  extractAbsLogPath,
  escapeRegExp,
  findLastMatchingLineInfo,
  parseUnrealLogTimestampMs,
  SIDECAR_STARTUP_PHASES,
  cameraCountFromBridgeState,
  getAdaptiveStallThresholds,
  OFFICIAL_CAPTURE_MODE,
  CUSTOM_CAPTURE_MODE,
  OPTIONAL_LIVE_PREVIEW_MODE,
  UNREAL_CONNECT_REQUEST_FILE,
  UNREAL_PRIMARY_ACTIONS,
  UNREAL_OFFICIAL_PLUGIN_REQUIREMENTS,
  PROJECT_PLUGIN_RECEIPT_PATH_FRAGMENT,
  DEFAULT_DIRECT_BRIDGE_EXTRA_ARGS,
  D3D11_FALLBACK_EXTRA_ARGS,
  QUICK_DIAGNOSTIC_TTL_MS,
  KNOWN_STARTUP_INTERFERERS,
  getEnabledProjectPlugins,
} from './lib/unreal-adapter-pure.mjs';




export class UnrealPluginAdapter {

  constructor({

    repoRoot,

    backupRoot,

    installScriptPath = path.join(repoRoot, 'scripts', 'dcc', 'install-unreal-plugin.ps1'),

    getBridgeState = () => ({}),

  }) {

    this.id = 'unreal';

    this.label = 'Unreal Engine';

    this.pluginName = UNREAL_PLUGIN_FRIENDLY_NAME;

    this.adapterId = 'UnrealPluginAdapter';

    this.repoRoot = repoRoot;

    this.backupRoot = backupRoot;

    this.installScriptPath = installScriptPath;

    this.getBridgeState = getBridgeState;

    this.pluginSourcePath = path.join(repoRoot, 'plugins', 'unreal', UNREAL_PLUGIN_NAME);

    this.sidecarProjectPath = path.join(repoRoot, 'app', 'tmp-unreal-sidecar', 'HMDaoBuild.uproject');


    this.legacySidecarProjectDir = path.join(repoRoot, 'app', '.hmdao-data', 'tmp', 'unreal-ascii-build');
    this.quickDiagnosticCache = new Map();

  }



  async getCachedQuickDiagnostic(cacheKey, loadValue, ttlMs = QUICK_DIAGNOSTIC_TTL_MS) {

    const safeTtlMs = Math.max(1000, Number(ttlMs || 0));

    const current = this.quickDiagnosticCache.get(cacheKey);

    const now = Date.now();

    if (current?.value !== undefined && (now - Number(current.updatedAt || 0)) < safeTtlMs) {

      return current.value;

    }

    if (current?.pending) {

      return current.pending;

    }

    const pending = Promise.resolve()

      .then(() => loadValue())

      .then((value) => {

        this.quickDiagnosticCache.set(cacheKey, {

          value,

          updatedAt: Date.now(),

        });

        return value;

      })

      .catch((error) => {

        this.quickDiagnosticCache.delete(cacheKey);

        throw error;

      });

    this.quickDiagnosticCache.set(cacheKey, {

      value: current?.value,

      updatedAt: Number(current?.updatedAt || 0),

      pending,

    });

    return pending;

  }



  async writeConnectRequestFile(projectPath = '', reporter = null, {

    ttlMs = 35 * 60 * 1000,
    targetPid = 0,

  } = {}) {

    const safeTtlMs = Math.max(60000, Number(ttlMs || 0));

    const payload = {

      action: 'connect',

      projectPath: String(projectPath || '').trim(),
      targetPid: Math.max(0, Number(targetPid || 0)),

      requestedAt: Date.now(),

      expiresAt: Date.now() + safeTtlMs,

      source: 'hmdao-environment-manager',

    };

    await fs.writeFile(UNREAL_CONNECT_REQUEST_FILE, `${JSON.stringify(payload)}\n`, 'utf8');

    reporter?.info('Wrote HMDao Unreal on-demand connect request.', {

      requestFile: UNREAL_CONNECT_REQUEST_FILE,

      projectPath: payload.projectPath,
      targetPid: payload.targetPid,

      ttlMs: safeTtlMs,

    });

  }



  async getSidecarProjectCandidate() {

    if (!await pathExists(this.sidecarProjectPath)) return null;

    const stat = await fs.stat(this.sidecarProjectPath).catch(() => null);

    const payload = await readJsonFile(this.sidecarProjectPath, {});

    return {

      path: this.sidecarProjectPath,

      name: path.basename(this.sidecarProjectPath, path.extname(this.sidecarProjectPath)),

      folder: path.dirname(this.sidecarProjectPath),

      running: false,

      source: 'hmdao-sidecar',

      modifiedAt: stat?.mtimeMs || 0,

      engineAssociation: String(payload?.EngineAssociation || '').trim(),

    };

  }



  async discoverProjectsWithSidecar() {

    const [projects, sidecar] = await Promise.all([

      discoverUnrealProjects(),

      this.getSidecarProjectCandidate(),

    ]);

    const merged = new Map();

    for (const project of projects) {

      merged.set(normalizeKey(project.path), project);

    }

    if (sidecar) {

      const key = normalizeKey(sidecar.path);

      if (!merged.has(key)) {

        merged.set(key, sidecar);

      }

    }

    return Array.from(merged.values()).sort((left, right) => {

      if (left.running !== right.running) return left.running ? -1 : 1;

      if (left.source === 'hmdao-sidecar' && right.source !== 'hmdao-sidecar') return 1;

      if (right.source === 'hmdao-sidecar' && left.source !== 'hmdao-sidecar') return -1;

      return (right.modifiedAt || 0) - (left.modifiedAt || 0);

    });

  }

  matchEngineInstallByRoot(engineInstalls, engineRoot = '') {

    if (!engineRoot) return null;

    return engineInstalls.find((item) => normalizeKey(item.engineRoot) === normalizeKey(engineRoot)) || null;

  }

  resolveEngineRootFromHostProcess(processInfo = null) {

    const executablePath = String(processInfo?.path || '').trim();

    if (!executablePath) return '';

    const normalizedPath = path.normalize(executablePath);

    if (!/[\\/]Engine[\\/]Binaries[\\/]Win64[\\/]UnrealEditor(?:-Cmd)?\.exe$/i.test(normalizedPath)) return '';

    return path.resolve(path.dirname(normalizedPath), '..', '..', '..');

  }

  findMatchingHostProcessForProject(project, hostProcesses = [], windows = []) {

    if (!project || !hostProcesses.length) return null;

    const normalizedProjectPath = normalizeKey(project.path || '');
    const normalizedProjectName = String(
      project.name
      || path.basename(String(project.path || ''), path.extname(String(project.path || '')))
    ).trim().toLowerCase();
    const projectPid = Number(project?.pid || 0);
    const windowsByPid = new Map(
      windows
        .map((item) => [Number(item?.processId || item?.pid || 0), item])
        .filter(([pid]) => pid > 0),
    );
    const scoredMatches = hostProcesses
      .map((processInfo) => {
        const pid = Number(processInfo?.pid || 0);
        const commandLine = String(processInfo?.commandLine || '').trim();
        const normalizedCommandLine = normalizeKey(commandLine.replace(/"/g, ''));
        const windowInfo = windowsByPid.get(pid);
        const normalizedWindowTitle = String(windowInfo?.title || processInfo?.mainWindowTitle || '').trim().toLowerCase();
        let score = 0;
        if (projectPid > 0 && pid === projectPid) score += 4;
        if (normalizedProjectPath && normalizedCommandLine.includes(normalizedProjectPath)) score += 6;
        if (normalizedProjectName && normalizedWindowTitle.includes(normalizedProjectName)) score += 2;
        return {
          pid,
          score,
          processInfo,
        };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.pid - right.pid);

    return scoredMatches[0] || null;

  }

  findEngineInstall(engineInstalls, project, explicitEngineRoot = '', runtimeFallback = null) {
    const explicitMatch = this.matchEngineInstallByRoot(engineInstalls, explicitEngineRoot);
    if (explicitMatch) return explicitMatch;

    const runtimeMatch = this.matchEngineInstallByRoot(engineInstalls, String(runtimeFallback?.targetEngineRoot || '').trim());

    if (runtimeMatch) return runtimeMatch;
    if (!project?.engineAssociation) return engineInstalls[0] || null;

    const association = String(project.engineAssociation).trim();

    const exact = engineInstalls.find((item) => item.version.includes(association) || item.label.includes(association));

    if (exact) return exact;

    const parsed = extractFirstMatch(association, /(\d+(?:\.\d+)?)/);

    if (!parsed) return engineInstalls[0] || null;

    return engineInstalls.find((item) => item.version.includes(parsed) || item.label.includes(parsed)) || engineInstalls[0] || null;

  }



  resolveEditorExecutable(engineRoot) {

    return path.join(engineRoot, 'Engine', 'Binaries', 'Win64', 'UnrealEditor.exe');

  }



  getProjectPluginPath(project) {

    return project ? path.join(project.folder, 'Plugins', UNREAL_PLUGIN_NAME) : '';

  }



  getEnginePluginCandidatePaths(engineRoot = '') {

    if (!engineRoot) return [];

    return [

      path.join(engineRoot, 'Engine', 'Plugins', UNREAL_PLUGIN_NAME),

      path.join(engineRoot, 'Engine', 'Plugins', 'Marketplace', UNREAL_PLUGIN_NAME),

      path.join(engineRoot, 'Engine', 'Plugins', 'VirtualProduction', UNREAL_PLUGIN_NAME),

    ];

  }



  getEnginePluginBackupScanRoot(engineRoot = '') {

    return engineRoot ? path.join(engineRoot, 'Engine', 'Plugins', '_HMDaoBackups') : '';

  }



  getEnginePluginBackupStorageRoot(engineRoot = '') {

    return engineRoot ? path.join(engineRoot, 'Engine', '_HMDaoBackups') : '';

  }



  async inspectEnginePluginShadowCopies(engineRoot = '') {

    const backupScanRoot = this.getEnginePluginBackupScanRoot(engineRoot);

    if (!backupScanRoot || !await pathExists(backupScanRoot)) {

      return {

        count: 0,

        backupScanRoot,

        entries: [],

      };

    }



    const entries = [];

    const items = await fs.readdir(backupScanRoot, { withFileTypes: true }).catch(() => []);

    for (const item of items) {

      if (!item.isDirectory()) continue;

      const pluginRoot = path.join(backupScanRoot, item.name);

      if (!await pathExists(path.join(pluginRoot, `${UNREAL_PLUGIN_NAME}.uplugin`))) continue;

      entries.push(pluginRoot);

    }



    return {

      count: entries.length,

      backupScanRoot,

      entries,

    };

  }



  async relocateEnginePluginShadowCopies(engineRoot = '', reporter) {

    const duplicateInfo = await this.inspectEnginePluginShadowCopies(engineRoot);

    if (!duplicateInfo.count) return duplicateInfo;



    const destinationRoot = this.getEnginePluginBackupStorageRoot(engineRoot);

    await fs.mkdir(destinationRoot, { recursive: true });



    for (const entry of duplicateInfo.entries) {

      const leafName = path.basename(entry);

      let destinationPath = path.join(destinationRoot, leafName);

      if (normalizeKey(destinationPath) === normalizeKey(entry) || await pathExists(destinationPath)) {

        destinationPath = path.join(destinationRoot, `${leafName}-${Date.now()}`);

      }

      await fs.rename(entry, destinationPath).catch(async () => {

        await copyIfExists(entry, destinationPath);

        await removeIfExists(entry);

      });

    }



    const sourceItems = await fs.readdir(duplicateInfo.backupScanRoot, { withFileTypes: true }).catch(() => []);

    if (sourceItems.length === 0) {

      await removeIfExists(duplicateInfo.backupScanRoot);

    }



    reporter?.info('Relocated HMDao Unreal backup plugin copies out of Engine/Plugins so Unreal stops scanning them during startup.', {

      engineRoot,

      movedCount: duplicateInfo.count,

      sourceRoot: duplicateInfo.backupScanRoot,

      destinationRoot,

    });



    return duplicateInfo;

  }



  async listProjectTargetReceiptFiles(projectPath = '') {

    if (!projectPath) return [];

    const receiptDir = path.join(path.dirname(projectPath), 'Binaries', 'Win64');

    if (!await pathExists(receiptDir)) return [];

    const items = await fs.readdir(receiptDir, { withFileTypes: true }).catch(() => []);

    return items

      .filter((item) => item.isFile())

      .map((item) => item.name)

      .filter((name) => name.endsWith('.target') && !/backup|\.bak|pre-engine-plugin-rebuild/i.test(name))

      .map((name) => path.join(receiptDir, name));

  }



  async inspectProjectTargetReceiptResidue(projectPath = '') {

    const currentProjectPluginRoot = projectPath

      ? path.join(path.dirname(projectPath), 'Plugins', UNREAL_PLUGIN_NAME)

      : '';

    const currentProjectPluginInstalled = currentProjectPluginRoot

      ? await pathExists(path.join(currentProjectPluginRoot, `${UNREAL_PLUGIN_NAME}.uplugin`))

      : false;

    if (currentProjectPluginInstalled) return [];

    const files = await this.listProjectTargetReceiptFiles(projectPath);

    const staleFiles = [];

    for (const filePath of files) {

      const text = await fs.readFile(filePath, 'utf8').catch(() => '');

      if (text.includes(PROJECT_PLUGIN_RECEIPT_PATH_FRAGMENT)) {

        staleFiles.push(filePath);

      }

    }

    return staleFiles;

  }



  async sanitizeProjectTargetReceipt(filePath) {

    const currentText = await fs.readFile(filePath, 'utf8').catch(() => '');

    if (!currentText) return false;



    let payload;

    try {

      payload = JSON.parse(currentText);

    } catch {

      return false;

    }



    const stripStalePluginPathEntries = (value) => {

      if (Array.isArray(value)) {

        let changed = false;

        const nextItems = [];

        for (const item of value) {

          const nextItem = stripStalePluginPathEntries(item);

          if (nextItem.changed) changed = true;

          const entryPath = String(nextItem?.value?.Path || '');

          if (entryPath.includes(PROJECT_PLUGIN_RECEIPT_PATH_FRAGMENT)) {

            changed = true;

            continue;

          }

          nextItems.push(nextItem.value);

        }

        return { value: nextItems, changed };

      }



      if (value && typeof value === 'object') {

        let changed = false;

        const nextObject = {};

        for (const [key, child] of Object.entries(value)) {

          const nextChild = stripStalePluginPathEntries(child);

          nextObject[key] = nextChild.value;

          if (nextChild.changed) changed = true;

        }

        return { value: nextObject, changed };

      }



      return { value, changed: false };

    };



    const sanitized = stripStalePluginPathEntries(payload);

    const changed = Boolean(sanitized.changed);



    if (!changed) return false;

    await fs.writeFile(filePath, `${JSON.stringify(sanitized.value, null, '\t')}\n`, 'utf8');

    return true;

  }



  async sanitizeProjectTargetReceipts(projectPath = '', reporter) {

    const currentProjectPluginRoot = projectPath

      ? path.join(path.dirname(projectPath), 'Plugins', UNREAL_PLUGIN_NAME)

      : '';

    const currentProjectPluginInstalled = currentProjectPluginRoot

      ? await pathExists(path.join(currentProjectPluginRoot, `${UNREAL_PLUGIN_NAME}.uplugin`))

      : false;

    if (currentProjectPluginInstalled) return [];

    const files = await this.listProjectTargetReceiptFiles(projectPath);

    const changedFiles = [];

    for (const filePath of files) {

      if (!await this.sanitizeProjectTargetReceipt(filePath)) continue;

      changedFiles.push(filePath);

    }

    if (changedFiles.length > 0) {

      reporter?.info('Sanitized stale Unreal target receipts that still referenced a removed project-local HMDao plugin copy.', {

        projectPath,

        changedFiles,

      });

    }

    return changedFiles;

  }



  async pruneLegacySidecarResidue(reporter = null) {

    const sidecarDir = path.dirname(this.sidecarProjectPath);

    const cleanupTargets = [];

    if (this.legacySidecarProjectDir && this.legacySidecarProjectDir !== sidecarDir) {

      cleanupTargets.push(

        this.legacySidecarProjectDir,

        path.join(this.repoRoot, 'app', '.hmdao-data', 'tmp', 'manual-hmdao-cl.rsp'),

        path.join(this.repoRoot, 'app', '.hmdao-data', 'tmp', 'manual-hmdao-cl-flat.rsp'),

      );

    }

    let removedCount = 0;

    for (const targetPath of cleanupTargets) {

      if (await removeIfExists(targetPath)) removedCount += 1;

    }

    if (removedCount > 0) {

      reporter?.info('Removed legacy Unreal temporary host residue before startup.', {

        projectPath: this.sidecarProjectPath,

        removedCount,

        cleanupTargets,

      });

    }

    return { removedCount, cleanupTargets };

  }



  async stabilizeStartupResidue(projectPath = '', engineRoot = '', reporter) {

    const [shadowCopies, sanitizedReceipts, legacyResidue] = await Promise.all([

      this.relocateEnginePluginShadowCopies(engineRoot, reporter),

      this.sanitizeProjectTargetReceipts(projectPath, reporter),

      this.pruneLegacySidecarResidue(reporter),

    ]);

    return {

      movedShadowCopies: Number(shadowCopies?.count || 0),

      sanitizedReceipts,

      removedLegacySidecarResidue: Number(legacyResidue?.removedCount || 0),

    };

  }



  async enforceLightweightStartupDefaults(projectPath = '', engineRoot = '', reporter = null, options = {}) {
    const {

      normalizeGlobalEditorDdc = false,

      normalizeGlobalEditorStartup = false,

      normalizeProjectDdc = false,

      normalizeProjectStartup = false,

      normalizeRemoteControlStartup = false,

      projectStartupOptions = null,

    } = options || {};

    const residue = await this.stabilizeStartupResidue(projectPath, engineRoot, reporter);
    const [globalDdcNormalization, globalEditorStartupNormalization, projectDdcNormalization, projectStartupNormalization, remoteControlStartupNormalization] = await Promise.all([

      normalizeGlobalEditorDdc && engineRoot ? this.normalizeGlobalEditorDdcPolicy(engineRoot, reporter).catch(() => ({ changedCount: 0 })) : Promise.resolve({ changedCount: 0 }),
      normalizeGlobalEditorStartup && engineRoot ? this.normalizeGlobalEditorStartupPolicy(engineRoot, reporter).catch(() => ({ changedCount: 0 })) : Promise.resolve({ changedCount: 0 }),
      normalizeProjectDdc && projectPath ? this.normalizeProjectDdcPolicy(projectPath, reporter).catch(() => ({ changedCount: 0 })) : Promise.resolve({ changedCount: 0 }),
      normalizeProjectStartup && projectPath ? this.normalizeProjectStartupState(projectPath, reporter, projectStartupOptions || {}).catch(() => ({ changedCount: 0 })) : Promise.resolve({ changedCount: 0 }),
      normalizeRemoteControlStartup && projectPath ? this.normalizeRemoteControlStartupState(projectPath, reporter).catch(() => ({ changedCount: 0 })) : Promise.resolve({ changedCount: 0 }),
    ]);

    return {

      ...residue,

      globalDdcNormalized: Number(globalDdcNormalization?.changedCount || 0),

      globalEditorStartupNormalized: Number(globalEditorStartupNormalization?.changedCount || 0),

      projectDdcNormalized: Number(projectDdcNormalization?.changedCount || 0),

      projectStartupNormalized: Number(projectStartupNormalization?.changedCount || 0),

      remoteControlNormalized: Number(remoteControlStartupNormalization?.changedCount || 0),

    };

  }



  buildDirectBridgeLaunchArgs(projectPath, launchLogPath, ddcExtraArgs = [], profile = { id: 'default', extraArgs: [] }, options = {}) {

    const hideSplash = Boolean(options.hideSplash);

    const showEditorConsole = Boolean(options.showEditorConsole);

    const args = [

      projectPath,

      '-HMDaoConnect',

      `-AbsLog=${launchLogPath}`,

      ...DEFAULT_DIRECT_BRIDGE_EXTRA_ARGS,

      ...ddcExtraArgs,

      ...(Array.isArray(profile?.extraArgs) ? profile.extraArgs : []),

    ];

    if (showEditorConsole) {

      args.splice(2, 0, '-log');

    }

    if (hideSplash) {

      args.splice(2, 0, '-NoSplash');

    }

    return args;

  }



  async shouldRetryWithD3D11Fallback({ startupSnapshot, logPath = '', waitedMs = 0, phaseStableMs = 0 } = {}) {

    const phaseKey = String(startupSnapshot?.phaseKey || '').trim().toLowerCase();

    if (!['log-open', 'slate', 'asset-registry', 'shader-warmup', 'log-wait', 'stale-log'].includes(phaseKey)) {

      return false;

    }



    const logText = logPath ? await this.readRecentTextFile(logPath, 256 * 1024) : '';

    if ((phaseKey === 'log-wait' || phaseKey === 'stale-log') && !logText.trim()) {

      return true;

    }

    if (phaseKey === 'log-open' && waitedMs >= 3 * 60 * 1000 && !/HMDao Unreal Capture: StartupModule|LogSlate: Using FreeType|LogAssetRegistry: FAssetRegistry took/i.test(logText)) {

      return true;

    }

    if (phaseKey === 'shader-warmup' && waitedMs < 8 * 60 * 1000 && phaseStableMs < 6 * 60 * 1000) {

      return false;

    }

    if (!/LogD3D12RHI:|LogRHI: Using Default RHI: D3D12/i.test(logText)) {

      return false;

    }



    if (/HMDao Unreal Capture: StartupModule|HMDao Unreal Capture: WebSocket connected|LogRemoteControl: Web Remote Control WebSocket server started/i.test(logText)) {

      return false;

    }



    return true;

  }



  async describeLikelyStartupBlocker(projectPath = '', engineRoot = '') {

    const memoryPressure = await this.inspectSystemMemoryPressure();

    if (memoryPressure.constrained) {

      const heavyProcesses = (memoryPressure.topConsumers || [])

        .filter((item) => Number(item?.workingSetGb || 0) >= 0.35)

        .slice(0, 4)

        .map((item) => `${item.label} (${item.processName}${item.pid ? `, PID ${item.pid}` : ''}, ~${item.workingSetGb.toFixed(1)} GB WS)`)

        .join(', ');

      return `Only about ${memoryPressure.freeGb.toFixed(1)} GB of ${memoryPressure.totalGb.toFixed(1)} GB physical RAM is free right now. Unreal startup can stay in TargetPlatform / ShaderFormat discovery for many extra minutes and show Not Responding under this memory pressure.${heavyProcesses ? ` Large active processes: ${heavyProcesses}.` : ''} Free memory first, then retry Connect.`;

    }

    const startupInterferers = await this.inspectKnownStartupInterferers();

    if (startupInterferers.length) {

      return `Observed startup overlay or hook processes are still running: ${startupInterferers.map((item) => `${item.label} (${item.processName}${item.pid ? `, PID ${item.pid}` : ''})`).join(', ')}. Keep the default path on HMDao direct bridge, and if Connect still feels stalled, prefer a visible host-first Unreal launch before retrying.`;

    }

    const securityHardening = await this.inspectWindowsSecurityHardening();

    if (securityHardening?.vbsRunning || securityHardening?.kernelCiEnforced || securityHardening?.userCiEnforced) {

      return `Windows VBS / code integrity hardening is active (VBS=${securityHardening.vbsStatus || 0}, KernelCI=${securityHardening.kernelCiStatus || 0}, UserCI=${securityHardening.userCiStatus || 0}). This can stretch first launch and shader warmup time, so keep compatibility-mode features off unless you explicitly need them.`;

    }

    const ddcFailure = await this.hasRecentDerivedDataCacheFailure(projectPath, engineRoot);

    if (ddcFailure.failed) {

      const noZenWritableGraphAvailable = await this.hasInstalledNoZenLocalFallbackGraph(engineRoot);

      if (noZenWritableGraphAvailable) {

        return `Recent Unreal logs already show a fatal DDC writable-node failure at ${ddcFailure.logPath}. This connect launch already switches to InstalledNoZenLocalFallback to bypass the broken default DDC graph, so if the editor still produces no fresh log the next blocker is happening before normal editor initialization.`;

      }

      return `Recent Unreal logs already show a fatal DDC writable-node failure at ${ddcFailure.logPath}. Keep Zen/DDC writable, or use this launch's memory DDC fallback until the cache graph is repaired.`;

    }

    const slowStartupSignal = await this.inspectRecentSlowStartupSignals(projectPath, engineRoot);

    if (slowStartupSignal) return slowStartupSignal;

    return '';

  }



  async describeWindowState(pid = 0) {

    const resolvedPid = Number(pid || 0);

    if (!resolvedPid) return '';

    const windows = await discoverWindowsForProcessIds([resolvedPid]);

    if (!windows.length) {

      return `No top-level Unreal window was detected for PID ${resolvedPid}.`;

    }

    const visibleWindows = windows.filter((item) => item.visible);

    if (!visibleWindows.length) {

      const sample = windows.slice(0, 3).map((item) => `${item.className || 'unknown-class'}:${item.title || '<empty>'}`).join(', ');

      return `Unreal PID ${resolvedPid} created only hidden or message-only windows (${sample}).`;

    }

    const sample = visibleWindows.slice(0, 3).map((item) => `${item.className || 'unknown-class'}:${item.title || '<empty>'}`).join(', ');

    return `Visible Unreal window(s): ${sample}.`;

  }



  async readUpluginVersion(pluginDir = '') {
    if (!pluginDir) return '';
    const upluginPath = path.join(pluginDir, `${UNREAL_PLUGIN_NAME}.uplugin`);
    const json = await readJsonFile(upluginPath, null);
    if (!json || typeof json !== 'object') return '';
    return String(json.VersionName || json.Version || json.SemVersion || '').trim();
  }

  // Decide whether a project+engine duplicate install is actually a *conflict*.
  // Two installs only cause inconsistent Epic launch / bridge / status detection when
  // they can diverge at load time. If both copies carry the identical version (and that
  // version matches the latest repo source), they are benign: Unreal prefers the
  // project-local copy and the runtime/status detection stays consistent, so the DCC
  // panel should NOT keep blocking Connect with a "duplicate install" error.
  async analyzeDuplicateInstall(projectPluginPath = '', enginePluginPath = '') {
    const [projectVersion, engineVersion, sourceVersion] = await Promise.all([
      this.readUpluginVersion(projectPluginPath),
      this.readUpluginVersion(enginePluginPath),
      this.readUpluginVersion(this.pluginSourcePath),
    ]);
    const identical = Boolean(projectVersion) && projectVersion === engineVersion;
    return {
      benign: identical,
      latest: identical && Boolean(sourceVersion) && projectVersion === sourceVersion,
      projectVersion,
      engineVersion,
      sourceVersion,
    };
  }

  async resolveInstalledPlugin(project, engineRoot = '') {
    const projectPluginPath = this.getProjectPluginPath(project);

    const projectInstalled = Boolean(projectPluginPath) && await pathExists(projectPluginPath);

    let enginePluginPath = '';

    for (const candidatePath of this.getEnginePluginCandidatePaths(engineRoot)) {

      if (!await pathExists(candidatePath)) continue;

      enginePluginPath = candidatePath;

      break;

    }



    const engineInstalled = Boolean(enginePluginPath);

    const duplicateInstallStructural = projectInstalled && engineInstalled;

    // A duplicate is only a *blocking* conflict when the two installs can actually
    // diverge at load time (different versions). If the project-local and engine-level
    // copies are both present but carry the identical latest version, they are benign:
    // Unreal prefers the project-local copy and status detection stays consistent, so we
    // de-escalate and stop blocking Connect / showing the duplicate-install error.
    const duplicateAnalysis = duplicateInstallStructural
      ? await this.analyzeDuplicateInstall(projectPluginPath, enginePluginPath)
      : { benign: false, latest: false, projectVersion: '', engineVersion: '', sourceVersion: '' };

    const duplicateInstallBenign = duplicateAnalysis.benign;
    const duplicateInstallLatest = duplicateAnalysis.latest;
    const duplicateInstall = duplicateInstallStructural && !duplicateInstallBenign;

    const shadowCopies = await this.inspectEnginePluginShadowCopies(engineRoot);

    const visibleProjectPluginPath = projectInstalled ? projectPluginPath : '';

    const effectivePath = projectInstalled ? projectPluginPath : enginePluginPath || visibleProjectPluginPath;

    return {
      installed: projectInstalled || engineInstalled,
      effectivePath,
      projectPluginPath: visibleProjectPluginPath,
      projectInstalled,

      enginePluginPath,

      engineInstalled,

      duplicateInstall,

      duplicateInstallStructural,

      duplicateInstallBenign,

      duplicateInstallLatest,

      duplicateInstallVersions: {
        project: duplicateAnalysis.projectVersion,
        engine: duplicateAnalysis.engineVersion,
        source: duplicateAnalysis.sourceVersion,
      },

      engineShadowCopies: shadowCopies.count,

      engineShadowCopyPaths: shadowCopies.entries,

      installationScope: duplicateInstall

        ? 'project-shadowing-engine'

        : projectInstalled

          ? 'project'

          : engineInstalled

            ? 'engine'
            : '',
    };
  }

  async inspectPluginSync(effectivePluginPath = '', bridgeState = null) {
    const repoUpluginPath = path.join(this.pluginSourcePath, `${UNREAL_PLUGIN_NAME}.uplugin`);
    const repoModulePath = path.join(this.pluginSourcePath, 'Source', UNREAL_PLUGIN_NAME, 'Private', `${UNREAL_PLUGIN_NAME}Module.cpp`);
    const deployedUpluginPath = effectivePluginPath ? path.join(effectivePluginPath, `${UNREAL_PLUGIN_NAME}.uplugin`) : '';
    const deployedModulePath = effectivePluginPath ? path.join(effectivePluginPath, 'Source', UNREAL_PLUGIN_NAME, 'Private', `${UNREAL_PLUGIN_NAME}Module.cpp`) : '';
    const deployedBinaryPath = effectivePluginPath ? path.join(effectivePluginPath, 'Binaries', 'Win64', `UnrealEditor-${UNREAL_PLUGIN_NAME}.dll`) : '';

    const [repoUplugin, repoModule, deployedUplugin, deployedModule, deployedBinary, repoUpluginJson, deployedUpluginJson] = await Promise.all([
      readFileTimestamp(repoUpluginPath),
      readFileTimestamp(repoModulePath),
      readFileTimestamp(deployedUpluginPath),
      readFileTimestamp(deployedModulePath),
      readFileTimestamp(deployedBinaryPath),
      readJsonFile(repoUpluginPath, null),
      readJsonFile(deployedUpluginPath, null),
    ]);

    const sourceVersion = String(repoUpluginJson?.VersionName || repoUpluginJson?.Version || '').trim();
    const deployedVersion = String(deployedUpluginJson?.VersionName || deployedUpluginJson?.Version || '').trim();
    const runtimeVersion = String(bridgeState?.directBridgePlugin?.pluginVersion || '').trim();
    const latestRepoSourceMtimeMs = Number(repoModule.mtimeMs || 0);
    const latestDeployedSourceMtimeMs = Number(deployedModule.mtimeMs || 0);
    const latestKnownSourceMtimeMs = Math.max(latestRepoSourceMtimeMs, latestDeployedSourceMtimeMs);
    const deployedBinaryMtimeMs = Number(deployedBinary.mtimeMs || 0);
    const binaryOlderThanRepoSource = deployedBinary.exists && latestRepoSourceMtimeMs > 0
      ? deployedBinaryMtimeMs + 1000 < latestRepoSourceMtimeMs
      : false;
    const binaryOlderThanDeployedSource = deployedBinary.exists && latestDeployedSourceMtimeMs > 0
      ? deployedBinaryMtimeMs + 1000 < latestDeployedSourceMtimeMs
      : false;
    const versionMismatch = Boolean(sourceVersion && runtimeVersion && sourceVersion !== runtimeVersion);
    const runtimeInSync = Boolean(effectivePluginPath)
      && deployedBinary.exists
      && latestKnownSourceMtimeMs > 0
      && deployedBinaryMtimeMs + 1000 >= latestKnownSourceMtimeMs
      && !versionMismatch;
    const state = !effectivePluginPath
      ? 'idle'
      : !deployedBinary.exists
        ? 'warning'
        : runtimeInSync
          ? 'ready'
          : 'warning';
    const summary = !effectivePluginPath
      ? 'No deployed HMDao Unreal plugin path is available yet.'
      : !deployedBinary.exists
        ? `Deployed plugin path exists, but the runtime DLL is missing at ${deployedBinaryPath}.`
        : versionMismatch
          ? `Installed plugin files are already v${sourceVersion || 'unknown'}, but the running Unreal bridge is still reporting v${runtimeVersion}. Restart Unreal after reinstall so the latest DLL is actually loaded.`
          : runtimeInSync
            ? `Deployed runtime DLL is in sync.${sourceVersion ? ` Source v${sourceVersion}.` : ''} Binary timestamp: ${deployedBinary.iso || 'unknown'}.`
            : `Deployed runtime DLL is older than the repaired plugin source.${sourceVersion ? ` Source v${sourceVersion}.` : ''} Binary: ${deployedBinary.iso || 'unknown'}; latest source: ${latestKnownSourceMtimeMs > 0 ? new Date(latestKnownSourceMtimeMs).toISOString() : 'unknown'}. Rebuild or reinstall before relying on runtime behavior.`;

    return {
      state,
      summary,
      runtimeInSync,
      binaryOlderThanRepoSource,
      binaryOlderThanDeployedSource,
      sourceVersion,
      deployedVersion,
      runtimeVersion,
      versionMismatch,
      repoUplugin,
      repoModule,
      deployedUplugin,
      deployedModule,
      deployedBinary,
      latestRepoSourceMtimeMs,
      latestDeployedSourceMtimeMs,
      latestKnownSourceMtimeMs,
      deployedBinaryMtimeMs,
      repoSourceTimestamp: latestRepoSourceMtimeMs > 0 ? new Date(latestRepoSourceMtimeMs).toISOString() : '',
      deployedSourceTimestamp: latestDeployedSourceMtimeMs > 0 ? new Date(latestDeployedSourceMtimeMs).toISOString() : '',
      deployedBinaryTimestamp: deployedBinaryMtimeMs > 0 ? new Date(deployedBinaryMtimeMs).toISOString() : '',
    };
  }

  async inspectKnownStartupInterferers() {
    return this.getCachedQuickDiagnostic('startup-interferers', () => {

      const script = [

        '$ErrorActionPreference = "SilentlyContinue"',

        '$items = Get-CimInstance Win32_Process | Select-Object ProcessId, Name, CommandLine',

        '$items | ConvertTo-Json -Depth 3 -Compress',

      ].join('; ');

      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {

        encoding: 'utf8',

        windowsHide: true,

        timeout: 5000,

        maxBuffer: 1024 * 1024,

      });

      if (result.error || result.status !== 0 || !String(result.stdout || '').trim()) {

        return [];

      }

      try {

        const parsed = JSON.parse(String(result.stdout || '').trim());

        const values = Array.isArray(parsed) ? parsed : [parsed];

        const matches = [];

        const dedupe = new Set();

        for (const item of values) {

          const processName = String(item?.Name || '').trim();

          const commandLine = String(item?.CommandLine || '').trim();

          const pid = Number(item?.ProcessId || 0);

          if (!processName || !pid) continue;

          const hit = KNOWN_STARTUP_INTERFERERS.find((candidate) => {

            if (!candidate.pattern.test(processName)) return false;

            if (candidate.commandLinePattern && !candidate.commandLinePattern.test(commandLine)) return false;

            return true;

          });

          if (!hit) continue;

          const dedupeKey = `${hit.key}:${processName.toLowerCase()}`;

          if (dedupe.has(dedupeKey)) continue;

          dedupe.add(dedupeKey);

          matches.push({

            key: hit.key,

            label: hit.label,

            processName,

            commandLine,

            pid,

          });

        }

        return matches;

      } catch {

        return [];

      }

    });

  }



  async inspectWindowsSecurityHardening() {

    return this.getCachedQuickDiagnostic('security-hardening', () => {

      const script = [

        '$ErrorActionPreference = "SilentlyContinue"',

        '$item = Get-CimInstance -Namespace "root\\Microsoft\\Windows\\DeviceGuard" -ClassName Win32_DeviceGuard | Select-Object VirtualizationBasedSecurityStatus, CodeIntegrityPolicyEnforcementStatus, UsermodeCodeIntegrityPolicyEnforcementStatus',

        '$item | ConvertTo-Json -Depth 3 -Compress',

      ].join('; ');

      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {

        encoding: 'utf8',

        windowsHide: true,

        timeout: 5000,

        maxBuffer: 1024 * 1024,

      });

      if (result.error || result.status !== 0 || !String(result.stdout || '').trim()) {

        return {

          available: false,

          vbsRunning: false,

          kernelCiEnforced: false,

          userCiEnforced: false,

        };

      }

      try {

        const parsed = JSON.parse(String(result.stdout || '').trim());

        const vbsStatus = Number(parsed?.VirtualizationBasedSecurityStatus || 0);

        const kernelCiStatus = Number(parsed?.CodeIntegrityPolicyEnforcementStatus || 0);

        const userCiStatus = Number(parsed?.UsermodeCodeIntegrityPolicyEnforcementStatus || 0);

        return {

          available: true,

          vbsStatus,

          kernelCiStatus,

          userCiStatus,

          vbsRunning: vbsStatus === 2,

          kernelCiEnforced: kernelCiStatus === 2,

          userCiEnforced: userCiStatus === 2,

        };

      } catch {

        return {

          available: false,

          vbsRunning: false,

          kernelCiEnforced: false,

          userCiEnforced: false,

        };

      }

    }).catch(() => {

      return {

        available: false,

        vbsRunning: false,

        kernelCiEnforced: false,

        userCiEnforced: false,

      };

    });

  }



  async inspectSystemMemoryPressure() {

    return this.getCachedQuickDiagnostic('system-memory-pressure', () => {

      const script = [

        '$ErrorActionPreference = "SilentlyContinue"',

        '$os = Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize, FreePhysicalMemory',

        '$procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -match "^(node|blender|UnrealEditor)\\.exe$" } | Select-Object ProcessId, Name, CommandLine, WorkingSetSize',

        '@{ os = $os; processes = $procs } | ConvertTo-Json -Depth 5 -Compress',

      ].join('; ');

      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {

        encoding: 'utf8',

        windowsHide: true,

        timeout: 5000,

        maxBuffer: 1024 * 1024,

      });

      if (result.error || result.status !== 0 || !String(result.stdout || '').trim()) {

        return {

          available: false,

          constrained: false,

          totalGb: 0,

          freeGb: 0,

          freeRatio: 0,

          topConsumers: [],

        };

      }

      try {

        const parsed = JSON.parse(String(result.stdout || '').trim());

        const totalKb = Number(parsed?.os?.TotalVisibleMemorySize || 0);

        const freeKb = Number(parsed?.os?.FreePhysicalMemory || 0);

        const totalGb = totalKb > 0 ? (totalKb / 1024 / 1024) : 0;

        const freeGb = freeKb > 0 ? (freeKb / 1024 / 1024) : 0;

        const freeRatio = totalGb > 0 ? (freeGb / totalGb) : 0;

        const topConsumers = (Array.isArray(parsed?.processes) ? parsed.processes : [parsed?.processes])

          .filter(Boolean)

          .map((item) => {

            const processName = String(item?.Name || '').trim();

            const commandLine = String(item?.CommandLine || '').trim();

            const workingSetBytes = Number(item?.WorkingSetSize || 0);

            const pid = Number(item?.ProcessId || 0);

            const isVite = processName.toLowerCase() === 'node.exe' && /vite(?:\\.js)?/i.test(commandLine);

            return {

              processName,

              commandLine,

              pid,

              workingSetGb: workingSetBytes > 0 ? (workingSetBytes / 1024 / 1024 / 1024) : 0,

              label: isVite

                ? 'Vite dev server'

                : processName.toLowerCase() === 'blender.exe'

                  ? 'Blender background capture'

                  : processName.toLowerCase() === 'unrealeditor.exe'

                    ? 'Unreal Editor'

                    : processName || 'process',

            };

          })

          .sort((left, right) => right.workingSetGb - left.workingSetGb)

          .slice(0, 6);

        return {

          available: totalGb > 0,

          constrained: freeGb > 0 && (freeGb < 3 || freeRatio < 0.12),

          totalGb,

          freeGb,

          freeRatio,

          topConsumers,

        };

      } catch {

        return {

          available: false,

          constrained: false,

          totalGb: 0,

          freeGb: 0,

          freeRatio: 0,

          topConsumers: [],

        };

      }

    }).catch(() => {

      return {

        available: false,

        constrained: false,

        totalGb: 0,

        freeGb: 0,

        freeRatio: 0,

        topConsumers: [],

      };

    });

  }



  async inspectEditorProcessFallback() {

    const script = [

      '$ErrorActionPreference = "SilentlyContinue"',

      // Get-CimInstance exposes the full command line (including the .uproject path the
      // editor was launched with), which Get-Process does not. We need the command line
      // so findMatchingHostProcessForProject can match the running editor to the selected
      // .uproject by path (score += 6) instead of relying on the fragile window-title match.
      '$items = Get-CimInstance Win32_Process -Filter "Name LIKE \'UnrealEditor%\'" | Select-Object ProcessId, CommandLine, CreationDate',

      '$items | ConvertTo-Json -Depth 3 -Compress',

    ].join('; ');

    const result = await runPowerShellInline(script, { timeoutMs: 5000 });

    if (!result.ok || !String(result.stdout || '').trim()) return [];

    try {

      const parsed = JSON.parse(String(result.stdout || '').trim());

      const values = Array.isArray(parsed) ? parsed : [parsed];

      return values

        .map((item) => ({

          pid: Number(item?.ProcessId || item?.Id || 0),

          commandLine: String(item?.CommandLine || '').trim(),

          startedAt: String(item?.CreationDate || item?.StartTime || '').trim(),

        }))

        .filter((item) => item.pid > 0);

    } catch {

      return [];

    }

  }



  async inferRuntimeFromFallback(project, hostProcesses = []) {

    const effectiveHostProcesses = hostProcesses.length ? hostProcesses : await this.inspectEditorProcessFallback();

    const hostProcessRunning = effectiveHostProcesses.length > 0;

    if (!project || !hostProcessRunning) {

      return {

        hostProcesses: effectiveHostProcesses,

        hostProcessRunning,

        targetProjectRunning: false,

        targetPid: 0,
        targetEngineRoot: '',
      };

    }



    const processIds = effectiveHostProcesses.map((item) => Number(item?.pid || 0)).filter((value) => value > 0);

    const windows = processIds.length ? await discoverWindowsForProcessIds(processIds) : [];

    const matchingProcess = this.findMatchingHostProcessForProject(project, effectiveHostProcesses, windows);
    return {

      hostProcesses: effectiveHostProcesses,

      hostProcessRunning: true,

      targetProjectRunning: Boolean(matchingProcess),
      targetPid: Number(matchingProcess?.pid || 0),
      targetEngineRoot: this.resolveEngineRootFromHostProcess(matchingProcess?.processInfo || null),
    };

  }



  resolveRequestedIntegrationMode(options = {}, fallbackMode = CUSTOM_CAPTURE_MODE) {

    const value = String(

      options.integrationMode

      || options.captureMode

      || options.previewMode

      || options.mode

      || fallbackMode,

    ).trim().toLowerCase();

    if (value === CUSTOM_CAPTURE_MODE || value === 'custom' || value === 'direct-bridge') return CUSTOM_CAPTURE_MODE;

    if (value === OPTIONAL_LIVE_PREVIEW_MODE || value === 'pixel-streaming' || value === 'live-preview') return OPTIONAL_LIVE_PREVIEW_MODE;

    return OFFICIAL_CAPTURE_MODE;

  }



  buildPathCompatibility(project, engineInstall, pluginInstall) {

    const items = [

      { key: 'project', label: 'Project', path: project?.path || '' },

      { key: 'project-plugin', label: 'Project plugin folder', path: pluginInstall?.projectPluginPath || '' },

      { key: 'engine', label: 'Engine root', path: engineInstall?.engineRoot || '' },

      { key: 'plugin-source', label: 'HMDao plugin source', path: this.pluginSourcePath },

    ].filter((item) => item.path);

    const scanned = items.map((item) => ({

      ...item,

      containsNonAscii: hasNonAsciiText(item.path),

    }));

    const containsNonAscii = scanned.some((item) => item.containsNonAscii);

    return {

      containsNonAscii,

      safeForProjectCopy: true,

      safeForOfficialMode: true,

      avoidForcedEngineBuild: containsNonAscii,

      items: scanned,

      summary: containsNonAscii

        ? 'Non-ASCII paths were detected. Prefer one engine-level precompiled install per Unreal minor version, or reuse a precompiled project copy when available, so Epic Launcher does not fall back to a project-source plugin build.'

        : 'ASCII-only paths were detected for the current Unreal project and plugin paths.',

    };

  }



  async buildOfficialCapabilityStatus(project, projectJson) {

    const enabledPlugins = getEnabledProjectPlugins(projectJson);

    const pluginStates = UNREAL_OFFICIAL_PLUGIN_REQUIREMENTS.map((plugin) => ({

      ...plugin,

      enabled: enabledPlugins.has(plugin.name),

    }));

    const missingRequired = pluginStates.filter((plugin) => plugin.required && !plugin.enabled);

    const remoteControlReachable = await probeTcp(30010).catch(() => false);

    const remoteControlStartupPolicy = await this.inspectRemoteControlStartupPolicy(project?.path || '');

    const livePreviewReady = pluginStates.some((plugin) => plugin.name === 'PixelStreaming' && plugin.enabled);

    const guidance = [

      'Keep HMDao direct bridge as the default lightweight Unreal path for normal editor connections, viewport preview, and shot-animation capture.',

      'DCC should focus on camera and viewport data capture; final cinematic quality should come from downstream tagging and video-model generation, not editor-side sequence rendering.',

      'Use compatibility mode only when you explicitly need offline export validation or a browser-preview fallback.',

      'Enable Python Script Plugin, Sequencer Scripting, Remote Control API, and Movie Render Queue only for compatibility mode.',

      'Keep Remote Control web server autostart disabled in project config, then start it on demand only when you explicitly need compatibility-mode camera control.',

      'Only enable Pixel Streaming in compatibility mode when you explicitly need browser preview, because it increases startup and runtime load.',

      'Remote Control API can stay offline until you explicitly need on-demand camera control from compatibility mode.',

      'If you just changed plugin enablement in the .uproject, restart Unreal Editor once before final acceptance.',

    ];



    return {

      mode: OFFICIAL_CAPTURE_MODE,

      plugins: pluginStates,

      missingRequired,

      capturePrerequisitesReady: missingRequired.length === 0,

      livePreviewReady,

      remoteControlReachable,

      remoteControlStartupPolicy,

      restartRequired: Boolean(project?.running) && missingRequired.length > 0,

      guidedSteps: guidance,

    };

  }



  buildIntegrationState({ bridgeState, cameraCount, pluginInstalled, pluginEnabled, buildArtifactsPresent, officialStatus, targetProjectRunning = false }) {

    const directBridgeCapable = pluginInstalled && pluginEnabled && buildArtifactsPresent;

    const directBridgeOnline = Boolean(bridgeState?.directBridgeOnline) && pluginInstalled && pluginEnabled && buildArtifactsPresent && targetProjectRunning;

    const directBridgeReady = directBridgeOnline && cameraCount > 0;

    const recommendedMode = directBridgeCapable ? CUSTOM_CAPTURE_MODE : OFFICIAL_CAPTURE_MODE;

    const activeMode = directBridgeReady

      ? CUSTOM_CAPTURE_MODE

      : directBridgeCapable

        ? CUSTOM_CAPTURE_MODE

        : officialStatus.capturePrerequisitesReady

          ? OFFICIAL_CAPTURE_MODE

          : OFFICIAL_CAPTURE_MODE;

    return {

      recommendedMode,

      activeMode,

      supportedModes: [OFFICIAL_CAPTURE_MODE, CUSTOM_CAPTURE_MODE, OPTIONAL_LIVE_PREVIEW_MODE],

      directBridgeOnline,

      directBridgeReady,

      officialCaptureReady: officialStatus.capturePrerequisitesReady,

      optionalLivePreviewReady: officialStatus.livePreviewReady,

      previewProvider: directBridgeReady

        ? 'editor-direct'

        : officialStatus.livePreviewReady

          ? 'pixel-streaming'

          : 'sequencer-capture',

    };

  }



  buildGuidedActions({ project, engineInstall, pluginInstall, officialStatus, integration, pathCompatibility }) {

    return [

      {

        id: 'enable-official-unreal-capture',

        title: 'Prepare compatibility-mode offline export prerequisites',

        recommended: integration.recommendedMode === OFFICIAL_CAPTURE_MODE,

        restartRequired: true,

        changedByInstallAction: true,

        details: officialStatus.capturePrerequisitesReady

          ? 'Required built-in plugins are already enabled for compatibility-mode offline export.'

          : `Missing required built-in plugins: ${officialStatus.missingRequired.map((item) => item.label).join(', ')}`,

      },

      {

        id: 'install-engine-plugin',

        title: 'Install custom HMDao Unreal plugin',

        recommended: false,

        restartRequired: true,

        safeDefault: true,

        targetPath: pluginInstall?.enginePluginPath || pluginInstall?.projectPluginPath || this.getProjectPluginPath(project),

        details: engineInstall?.engineRoot

          ? 'Prefer one engine-level precompiled install per Unreal minor version so Epic Launcher startup stays light. Project-level copy-only remains available for isolation, and it now reuses a precompiled package whenever one is already available.'

          : 'No matching Unreal engine root is selected yet. Project-level copy-only is still supported for manual enable from the Unreal plugin list.',

      },

      {

        id: 'optional-live-preview',

        title: 'Enable compatibility-mode browser preview only if explicitly required',

        recommended: false,

        restartRequired: true,

        details: officialStatus.livePreviewReady

          ? 'Compatibility-mode browser preview is already enabled as an optional fallback path.'

          : 'Keep Pixel Streaming disabled for lighter startup unless you explicitly need compatibility-mode browser preview.',

      },

      {

        id: 'path-safety',

        title: 'Chinese / non-ASCII path compatibility',

        recommended: pathCompatibility.containsNonAscii,

        restartRequired: false,

        details: pathCompatibility.summary,

      },

      {

        id: 'engine-selection',

        title: 'Prefer one precompiled engine install per UE minor version',

        recommended: true,

        restartRequired: false,

        details: engineInstall?.engineRoot

          ? `Current engine selection: ${engineInstall.version || engineInstall.label} at ${engineInstall.engineRoot}. Keep one shared precompiled HMDao plugin per UE minor version here when possible, and only fall back to a project-local copy when you need isolation.`

          : 'No matching Unreal engine root was selected yet.',

      },

    ];

  }



  isSafeSidecarProject(project) {

    return normalizeKey(project?.path || '') === normalizeKey(this.sidecarProjectPath);

  }



  getSidecarLogPath(project) {

    const projectPath = project?.path || this.sidecarProjectPath;

    const projectDir = path.dirname(projectPath);

    const projectName = path.basename(projectPath, path.extname(projectPath));

    return path.join(projectDir, 'Saved', 'Logs', `${projectName}.log`);

  }



  getHmdaoLaunchLogPath(project) {

    const projectPath = project?.path || this.sidecarProjectPath;

    const projectDir = path.dirname(projectPath);

    const projectName = path.basename(projectPath, path.extname(projectPath));

    return path.join(projectDir, 'Saved', 'Logs', `${projectName}-hmdao-launch.log`);

  }



  getUserEditorLogPath(engineRoot = '') {

    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

    const engineMinorVersion = this.extractEngineMinorVersion(engineRoot);

    return path.join(localAppData, 'UnrealEngine', engineMinorVersion, 'Saved', 'Logs', 'Unreal.log');

  }



  async listProjectLaunchLogVariants(project) {

    const projectPath = project?.path || this.sidecarProjectPath;

    const projectDir = path.dirname(projectPath);

    const projectName = path.basename(projectPath, path.extname(projectPath));

    const logsDir = path.join(projectDir, 'Saved', 'Logs');

    if (!await pathExists(logsDir)) return [];

    const items = await fs.readdir(logsDir, { withFileTypes: true }).catch(() => []);

    return items

      .filter((item) => item.isFile() && new RegExp(`^${escapeRegExp(projectName)}-.*\\.log$`, 'i').test(item.name))

      .map((item) => path.join(logsDir, item.name));

  }



  async resolveStartupLogCandidate(project, engineRoot = '') {

    const processLogPath = extractAbsLogPath(project?.commandLine || '');

    const preferredLogPath = this.getHmdaoLaunchLogPath(project);

    const projectLogPath = this.getSidecarLogPath(project);

    const userEditorLogPath = this.getUserEditorLogPath(engineRoot);

    const variantLogPaths = await this.listProjectLaunchLogVariants(project);

    const processStartedAtMs = Math.max(0, Number(project?.startedAtMs || 0));

    const candidates = await Promise.all([

      ...(processLogPath ? [{ logPath: processLogPath, source: 'process-abslog' }] : []),

      { logPath: preferredLogPath, source: 'hmdao-launch' },

      { logPath: projectLogPath, source: 'project-default' },

      { logPath: userEditorLogPath, source: 'user-editor' },

      ...variantLogPaths.map((logPath) => ({ logPath, source: 'project-variant' })),

    ].map(async (item) => ({

      ...item,

      stat: await fs.stat(item.logPath).catch(() => null),

    })));



    const currentExpectedLogPath = processLogPath || preferredLogPath;

    const currentExpectedLog = candidates.find((item) => normalizeKey(item.logPath) === normalizeKey(currentExpectedLogPath));

    const currentRunAgeMs = processStartedAtMs > 0 ? Math.max(0, Date.now() - processStartedAtMs) : 0;

    const currentExpectedLogIsFresh = Boolean(currentExpectedLog?.stat) && (!processStartedAtMs || currentExpectedLog.stat.mtimeMs + 1000 >= processStartedAtMs);

    if (processStartedAtMs > 0 && currentRunAgeMs < 5 * 60 * 1000 && !currentExpectedLogIsFresh) {

      return {

        logPath: currentExpectedLogPath,

        source: currentExpectedLog?.source || (processLogPath ? 'process-abslog' : 'hmdao-launch'),

        stat: currentExpectedLogIsFresh ? currentExpectedLog.stat : null,

      };

    }



    if (processLogPath && processStartedAtMs > 0) {

      const processLogCandidate = candidates.find((item) => normalizeKey(item.logPath) === normalizeKey(processLogPath));

      if (processLogCandidate && !processLogCandidate.stat) {

        return {

          logPath: processLogPath,

          source: 'process-abslog',

          stat: null,

        };

      }

    }



    const existing = candidates.filter((item) => item.stat);

    if (!existing.length) {

      return {

        logPath: preferredLogPath,

        source: 'hmdao-launch',

        stat: null,

      };

    }



    const fresh = existing.filter((item) => !processStartedAtMs || item.stat.mtimeMs + 1000 >= processStartedAtMs);

    const sortable = fresh.length ? fresh : existing;

    sortable.sort((left, right) => {

      const timeDiff = Number(right.stat?.mtimeMs || 0) - Number(left.stat?.mtimeMs || 0);

      if (timeDiff !== 0) return timeDiff;

      return String(left.source).localeCompare(String(right.source));

    });

    return sortable[0];

  }



  async cleanupRuntimeFiles(reporter) {

    const sidecarDir = path.dirname(this.sidecarProjectPath);

    const cleanupTargets = [

      path.join(sidecarDir, 'Saved', 'Autosaves'),

      path.join(sidecarDir, 'Saved', 'Crashes'),

      path.join(sidecarDir, 'Saved', 'HMDaoCapture'),

      path.join(sidecarDir, 'Saved', 'Logs'),

      path.join(sidecarDir, 'DerivedDataCache'),

      path.join(os.tmpdir(), 'hmdao-stack-logs'),

      UNREAL_CONNECT_REQUEST_FILE,

    ];

    if (this.legacySidecarProjectDir && this.legacySidecarProjectDir !== sidecarDir) {

      cleanupTargets.push(

        this.legacySidecarProjectDir,

        path.join(this.repoRoot, 'app', '.hmdao-data', 'tmp', 'manual-hmdao-cl.rsp'),

        path.join(this.repoRoot, 'app', '.hmdao-data', 'tmp', 'manual-hmdao-cl-flat.rsp'),

      );

    }

    let removedCount = 0;

    for (const targetPath of cleanupTargets) {

      if (await removeIfExists(targetPath)) removedCount += 1;

    }

    reporter?.info('Cleaned Unreal sidecar cache and temp files.', {

      projectPath: this.sidecarProjectPath,

      removedCount,

      cleanupTargets,

    });

    return removedCount;

  }



  getZenLaunchConfig() {

    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

    const installDir = path.join(localAppData, 'UnrealEngine', 'Common', 'Zen', 'Install');

    return {

      port: 8558,

      installDir,

      serverExecutable: path.join(installDir, 'zenserver.exe'),

      dataDir: path.join(localAppData, 'UnrealEngine', 'Common', 'Zen', 'Data'),

    };

  }



  resolveZenToolExecutable(engineRoot = '') {

    if (!engineRoot) return '';

    return path.join(engineRoot, 'Engine', 'Binaries', 'Win64', 'zen.exe');

  }



  runZenTool(engineRoot = '', args = [], options = {}) {

    const executable = this.resolveZenToolExecutable(engineRoot);

    const timeoutMs = Math.max(1000, Number(options.timeoutMs || 15000));

    if (!executable) {

      return {

        ok: false,

        executable: '',

        code: -1,

        stdout: '',

        stderr: 'missing-engine-root',

        error: '',

        timedOut: false,

        timeoutMs,

      };

    }

    const result = spawnSync(executable, args, {

      cwd: path.dirname(executable),

      encoding: 'utf8',

      windowsHide: true,

      timeout: timeoutMs,

    });

    const timedOut = Boolean(result.error && String(result.error.code || '').toUpperCase() === 'ETIMEDOUT');

    return {

      ok: result.status === 0 && !timedOut,

      executable,

      code: Number.isInteger(result.status) ? result.status : -1,

      stdout: String(result.stdout || '').trim(),

      stderr: String(result.stderr || '').trim(),

      error: result.error ? String(result.error.message || result.error) : '',

      timedOut,

      timeoutMs,

    };

  }



  async inspectZenRuntime(engineRoot = '') {

    const config = this.getZenLaunchConfig();

    const ready = await probeTcp(config.port, '127.0.0.1', 500);

    const toolExecutable = this.resolveZenToolExecutable(engineRoot);

    const toolExists = toolExecutable ? await pathExists(toolExecutable) : false;

    // Keep status collection responsive even when Zen tooling itself is sluggish.

    const serviceStatus = toolExists ? this.runZenTool(engineRoot, ['service', 'status'], { timeoutMs: 900 }) : null;

    return {

      port: config.port,

      ready,

      toolExecutable,

      toolExists,

      serviceInstalled: Boolean(serviceStatus?.ok),

      serviceStatusText: String(serviceStatus?.stdout || serviceStatus?.stderr || serviceStatus?.error || '').trim(),

    };

  }



  extractEngineMinorVersion(engineRoot = '') {

    const version = extractFirstMatch(engineRoot, /UE[_-]?(\d+\.\d+)/i);

    return version || '5.7';

  }



  async readRecentTextFile(filePath, maxBytes = 65536) {

    try {

      const stat = await fs.stat(filePath);

      const handle = await fs.open(filePath, 'r');

      try {

        const start = Math.max(0, stat.size - maxBytes);

        const length = Math.max(0, stat.size - start);

        const buffer = Buffer.alloc(length);

        await handle.read(buffer, 0, length, start);

        return buffer.toString('utf8');

      } finally {

        await handle.close();

      }

    } catch {

      return '';

    }

  }



  buildPreciseStartupWhitelistPaths(projectPath = '', engineRoot = '') {

    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

    const projectDir = projectPath ? path.dirname(projectPath) : '';

    const values = [

      engineRoot ? this.resolveEditorExecutable(engineRoot) : '',

      engineRoot ? path.join(engineRoot, 'Engine', 'Binaries', 'Win64', 'ShaderCompileWorker.exe') : '',

      engineRoot ? path.join(engineRoot, 'Engine', 'Build', 'BatchFiles', 'RunUAT.bat') : '',

      engineRoot ? path.join(engineRoot, 'Engine', 'Content') : '',

      path.join(localAppData, 'UnrealEngine', 'Common', 'DerivedDataCache'),

      path.join(os.tmpdir(), 'UnrealShaderWorkingDir'),

      projectDir,

      projectDir ? path.join(projectDir, 'Content') : '',

      projectDir ? path.join(projectDir, 'DerivedDataCache') : '',

      projectDir ? path.join(projectDir, 'Intermediate') : '',

      this.pluginSourcePath,

    ];

    return [...new Set(values.filter(Boolean))];

  }



  formatPreciseStartupWhitelistHint(projectPath = '', engineRoot = '') {

    const values = this.buildPreciseStartupWhitelistPaths(projectPath, engineRoot);

    if (!values.length) {

      return 'Keep resident security or overlay tools running if needed, but add precise exclusions for Unreal editor, shader workers, DDC, and the HMDao project/plugin paths.';

    }

    return `Keep resident security or overlay tools running if needed, but add precise exclusions for: ${values.join(', ')}.`;

  }



  async inspectRecentSlowStartupSignals(projectPath = '', engineRoot = '') {

    if (!projectPath) return '';

    const startupLog = await this.resolveStartupLogCandidate({ path: projectPath }, engineRoot);

    const logPath = String(startupLog?.logPath || '').trim();

    if (!logPath) return '';

    const text = await this.readRecentTextFile(logPath, 768 * 1024);

    if (!text.trim()) return '';



    const lines = text.split(/\r?\n/g).filter(Boolean);

    const turnkeyStartLine = lines.find((line) => /LogTurnkeySupport: Running Turnkey device detection:/i.test(line));

    const turnkeyEndLine = lines.find((line) => /LogTurnkeySupport: Completed device detection: Code = 0/i.test(line));

    const turnkeyStartMs = parseUnrealLogTimestampMs(turnkeyStartLine);

    const turnkeyEndMs = parseUnrealLogTimestampMs(turnkeyEndLine);

    const turnkeyDurationMs = turnkeyStartMs > 0 && turnkeyEndMs > turnkeyStartMs

      ? turnkeyEndMs - turnkeyStartMs

      : 0;

    const slowDdcLine = findLastMatchingLineInfo(lines, /LogDerivedDataCache: Warning: .* is very slow .* consider disabling this cache store\./i)?.line || '';

    const streamingWaitLine = findLastMatchingLineInfo(lines, /LogStreaming: Display: Flushing package .*WaitingForIo.*partially loaded package|LogStreaming: Display: Package .* dynamic import/i)?.line || '';

    const hints = [];



    if (turnkeyDurationMs >= 2 * 60 * 1000) {

      hints.push(`Turnkey device detection recently took about ${Math.round(turnkeyDurationMs / 60000)} minutes before editor startup could continue`);

    }

    if (slowDdcLine) {

      const cachePath = extractFirstMatch(slowDdcLine, /LogDerivedDataCache: Warning: ([A-Za-z]:.*?): Loading /i)

        || extractFirstMatch(slowDdcLine, /LogDerivedDataCache: Warning: ([^:]+): Loading /i)

        || 'the local Unreal DDC cache';

      hints.push(`Unreal also logged extremely slow local DDC reads from ${cachePath}`);

    }

    if (streamingWaitLine) {

      hints.push('Unreal also reached recursive package streaming loads while opening engine materials, which usually means content I/O is still slow or being heavily scanned');

    }



    if (!hints.length) return '';

    return `${hints.join(', ')}. Prefer a visible host-first Unreal launch with compatibility-mode features off, then let HMDao attach after the editor window is responsive.`;

  }



  async hasRecentDerivedDataCacheFailure(projectPath = '', engineRoot = '') {

    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

    const engineMinorVersion = this.extractEngineMinorVersion(engineRoot);

    const projectLogPath = projectPath

      ? path.join(path.dirname(projectPath), 'Saved', 'Logs', `${path.basename(projectPath, path.extname(projectPath))}.log`)

      : '';

    const userEditorLogPath = path.join(localAppData, 'UnrealEngine', engineMinorVersion, 'Saved', 'Logs', 'Unreal.log');

    const crashSignature = /Unable to use default cache graph 'InstalledDerivedDataBackendGraph' because there are no writable nodes available/i;

    const zenofflineSignature = /ZenLocal: Unable to reach ZenServer HTTP service/i;



    for (const logPath of [projectLogPath, userEditorLogPath]) {

      if (!logPath) continue;

      const text = await this.readRecentTextFile(logPath);

      if (crashSignature.test(text) || zenofflineSignature.test(text)) {

        return { failed: true, logPath };

      }

    }

    return { failed: false, logPath: '' };

  }



  async hasInstalledNoZenLocalFallbackGraph(engineRoot = '') {

    if (!engineRoot) return false;

    const baseEngineIni = path.join(engineRoot, 'Engine', 'Config', 'BaseEngine.ini');

    const text = await this.readRecentTextFile(baseEngineIni, 512 * 1024);

    return /\[InstalledNoZenLocalFallback\]/i.test(text);

  }



  async ensureZenServerReady(engineRoot = '', reporter) {

    const config = this.getZenLaunchConfig();

    if (await probeTcp(config.port, '127.0.0.1', 500)) {

      return { ready: true, started: false, config };

    }

    reporter?.info('Attempting zen.exe up for Unreal DDC preflight.', {

      executable: this.resolveZenToolExecutable(engineRoot),

      port: config.port,

    });

    const zenTool = this.runZenTool(engineRoot, ['up'], { timeoutMs: 15000 });

    if (zenTool.ok) {

      const ready = await waitForCondition(

        async () => await probeTcp(config.port, '127.0.0.1', 500),

        { timeoutMs: 15000, intervalMs: 500 },

      );

      reporter?.info(

        ready

          ? 'Unreal Zen runtime is reachable after zen.exe up.'

          : 'zen.exe up returned success, but the Zen port still is not reachable.',

        {

          executable: zenTool.executable,

          port: config.port,

          stdout: zenTool.stdout,

        },

      );

      if (ready) {

        return { ready: true, started: true, startedBy: 'zen-up', config };

      }

    } else if (zenTool.timedOut) {

      reporter?.warn('zen.exe up timed out before Unreal DDC preflight could confirm the runtime.', {

        executable: zenTool.executable,

        port: config.port,

        timeoutMs: zenTool.timeoutMs,

      });

    } else if (zenTool.executable) {

      reporter?.warn('zen.exe up did not bring the Zen runtime online before direct launch fallback.', {

        executable: zenTool.executable,

        port: config.port,

        stderr: zenTool.stderr || zenTool.error || zenTool.stdout || 'unknown error',

      });

    }

    if (!await pathExists(config.serverExecutable)) {

      reporter?.warn('Unreal Zen server executable was not found for DDC preflight.', {

        serverExecutable: config.serverExecutable,

      });

      return { ready: false, started: false, config };

    }



    await fs.mkdir(config.dataDir, { recursive: true }).catch(() => {});

    const launchArgs = [

      '--port', String(config.port),

      '--data-dir', config.dataDir,

      '--http', 'asio',

      '--gc-cache-duration-seconds', '1209600',

      '--gc-interval-seconds', '21600',

      '--gc-low-diskspace-threshold', '2147483648',

      '--cache-bucket-limit-overwrites',

      '--quiet',

      '--http-forceloopback',

    ];



    reporter?.info('Starting Unreal Zen server before editor launch to keep DDC writable.', {

      serverExecutable: config.serverExecutable,

      dataDir: config.dataDir,

      port: config.port,

    });

    const launchResult = await launchWindowsProcess(config.serverExecutable, launchArgs, {

      cwd: config.installDir,

    });

    if (!launchResult.ok) {

      reporter?.warn('Failed to launch Unreal Zen server for DDC preflight.', {

        serverExecutable: config.serverExecutable,

        error: launchResult.error || 'unknown error',

      });

      return { ready: false, started: false, config };

    }



    const ready = await waitForCondition(

      async () => await probeTcp(config.port, '127.0.0.1', 500),

      { timeoutMs: 15000, intervalMs: 500 },

    );

    reporter?.info(

      ready

        ? 'Unreal Zen server is reachable for DDC preflight.'

        : 'Unreal Zen server still is not reachable after launch attempt.',

      {

        port: config.port,

        dataDir: config.dataDir,

        pid: launchResult.pid,

      },

    );

    return { ready, started: true, pid: launchResult.pid, config };

  }



  async prepareDdcLaunchStrategy({ projectPath, engineRoot, reporter }) {

    const ddcFailure = await this.hasRecentDerivedDataCacheFailure(projectPath, engineRoot);

    const noZenWritableGraphAvailable = await this.hasInstalledNoZenLocalFallbackGraph(engineRoot);

    if (ddcFailure.failed) {

      if (noZenWritableGraphAvailable) {

        reporter?.warn('Recent Unreal logs already show a fatal DDC writable-node failure. Switching this launch to InstalledNoZenLocalFallback so the editor uses a writable local cache without depending on Zen.', {

          projectPath,

          engineRoot,

          logPath: ddcFailure.logPath,

        });

        return {

          extraArgs: ['-ddc=InstalledNoZenLocalFallback', '-NoZen'],

          fallbackMode: 'installed-no-zen-local-fallback-preemptive',

          zenStarted: false,

        };

      }

      reporter?.warn('Recent Unreal logs already show a fatal DDC writable-node failure. Forcing in-memory DDC for this launch before opening the editor.', {

        projectPath,

        engineRoot,

        logPath: ddcFailure.logPath,

      });

      return {

        extraArgs: ['-DDC-ForceMemoryCache'],

        fallbackMode: 'memory-ddc-preemptive',

        zenStarted: false,

      };

    }



    const zenState = await this.ensureZenServerReady(engineRoot, reporter);

    if (zenState.ready) {

      return {

        extraArgs: [],

        fallbackMode: 'default-ddc',

        zenStarted: zenState.started,

      };

    }



    if (noZenWritableGraphAvailable) {

      reporter?.warn('Zen/DDC preflight could not confirm a writable Zen backend. Switching this launch to InstalledNoZenLocalFallback so Unreal can keep using a writable local cache without waiting on Zen.', {

        projectPath,

        engineRoot,

        zenStarted: zenState.started,

      });

      return {

        extraArgs: ['-ddc=InstalledNoZenLocalFallback', '-NoZen'],

        fallbackMode: 'installed-no-zen-local-fallback',

        zenStarted: zenState.started,

      };

    }



    reporter?.warn('Zen/DDC preflight could not confirm a writable DDC backend. Unreal will be launched on its default cache graph.', {

      projectPath,

      engineRoot,

      zenStarted: zenState.started,

    });

    return {

      extraArgs: [],

      fallbackMode: 'default-ddc-unverified',

      zenStarted: zenState.started,

    };

  }



  async upsertIniSetting(filePath, sectionName, key, value) {

    const sectionHeader = `[${sectionName}]`;

    const sectionPattern = new RegExp(`(${escapeRegExp(sectionHeader)}[\\s\\S]*?)(?:\\n(?=\\[)|$)`);

    const nextLine = `${key}=${value}`;

    const currentText = await fs.readFile(filePath, 'utf8').catch(() => '');

    const sanitized = currentText

      .replace(/^\uFEFF/, '')

      .replace(/^(?:\?{2,}|[^\[]+(?=\[))/u, '')

      .replace(/^\[\r?\n(?:\r?\n)*(?=\[)/, '');

    const normalized = sanitized.replace(/\r\n/g, '\n');



    let nextText = normalized;

    if (sectionPattern.test(normalized)) {

      nextText = normalized.replace(sectionPattern, (match, body) => {

        const blockText = String(body || '');

        const lines = blockText.replace(/\r\n/g, '\n').split('\n');

        const deduped = [];

        let replaced = false;

        for (const line of lines) {

          if (!line.trim()) {

            deduped.push(line);

            continue;

          }

          if (line.trim() === sectionHeader) {

            deduped.push(sectionHeader);

            continue;

          }

          if (line.trim().toLowerCase().startsWith(`${String(key || '').trim().toLowerCase()}=`)) {

            if (!replaced) {

              deduped.push(nextLine);

              replaced = true;

            }

            continue;

          }

          deduped.push(line);

        }

        if (!replaced) deduped.push(nextLine);

        let block = deduped.join('\n').replace(/\n{3,}/g, '\n\n');

        if (!block.endsWith('\n')) block += '\n';

        return block;

      });

    } else {

      const prefix = normalized && !normalized.endsWith('\n') ? `${normalized}\n\n` : normalized ? `${normalized}\n` : '';

      nextText = `${prefix}${sectionHeader}\n${nextLine}\n`;

    }



    if (nextText === normalized) return false;

    await fs.mkdir(path.dirname(filePath), { recursive: true });

    await fs.writeFile(filePath, nextText.replace(/\n/g, '\r\n'), 'utf8');

    return true;

  }



  readIniSettingValue(sourceText = '', sectionName = '', key = '') {

    const sectionHeader = `[${sectionName}]`;

    const lines = String(sourceText || '').replace(/\r\n/g, '\n').split('\n');

    let insideSection = false;

    for (const line of lines) {

      const trimmed = line.trim();

      if (!trimmed) continue;

      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {

        insideSection = trimmed === sectionHeader;

        continue;

      }

      if (!insideSection) continue;

      if (!trimmed.toLowerCase().startsWith(`${String(key || '').trim().toLowerCase()}=`)) continue;

      return trimmed.slice(String(key || '').length + 1).trim();

    }

    return '';

  }



  parseIniBoolean(value, fallback = false) {

    const normalized = String(value || '').trim().toLowerCase();

    if (!normalized) return fallback;

    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;

    if (['false', '0', 'no', 'off'].includes(normalized)) return false;

    return fallback;

  }



  async inspectProjectDdcPolicy(projectPath = '') {

    if (!projectPath || !await pathExists(projectPath)) {

      return {

        configPath: '',

        configured: false,

        keepsStartupLight: false,

        localCachePath: '',

      };

    }



    const configPath = path.join(path.dirname(projectPath), 'Config', 'DefaultEngine.ini');

    const sourceText = await fs.readFile(configPath, 'utf8').catch(() => '');

    const sanitized = sourceText

      .replace(/^\uFEFF/, '')

      .replace(/^(?:\?{2,}|[^\[]+(?=\[))/u, '')

      .replace(/^\[\r?\n(?:\r?\n)*(?=\[)/, '');

    const expectedLocalCachePath = '%GAMEDIR%DerivedDataCache/Local';

    const rootValue = this.readIniSettingValue(sanitized, 'InstalledDerivedDataBackendGraph', 'Root');

    const hierarchyValue = this.readIniSettingValue(sanitized, 'InstalledDerivedDataBackendGraph', 'Hierarchy') || rootValue;

    const localValue = this.readIniSettingValue(sanitized, 'InstalledDerivedDataBackendGraph', 'Local');

    const autoLaunchValue = this.readIniSettingValue(sanitized, 'Zen', 'AutoLaunch');

    const localPathMatches = /Path="?(%GAMEDIR%DerivedDataCache\/Local)"?/i.test(localValue);

    const localExplicitlyWritable = /DeleteOnly\s*=\s*false/i.test(localValue) && !/ReadOnly\s*=\s*true/i.test(localValue);

    const rootExcludesZenLocal = hierarchyValue.includes('Inner=Local') && !hierarchyValue.includes('Inner=ZenLocal');

    const autoLaunchDisabled = this.parseIniBoolean(autoLaunchValue, false) === false;



    return {

      configPath,

      configured: Boolean(sanitized.trim()),

      keepsStartupLight: rootExcludesZenLocal && localPathMatches && localExplicitlyWritable && autoLaunchDisabled,

      localCachePath: expectedLocalCachePath,

      hierarchyValue,

      rootValue,

      localValue,

      autoLaunchValue,

    };

  }



  getGlobalEditorDdcConfigPath() {

    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

    return path.join(localAppData, 'Unreal Engine', 'Engine', 'Config', 'UserEngine.ini');

  }



  getLegacyGlobalEditorDdcConfigPath(engineRoot = '') {

    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

    const engineMinorVersion = this.extractEngineMinorVersion(engineRoot);

    return path.join(localAppData, 'UnrealEngine', engineMinorVersion, 'Saved', 'Config', 'WindowsEditor', 'Engine.ini');

  }



  getLegacyGlobalEditorConfigDir(engineRoot = '') {

    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

    const engineMinorVersion = this.extractEngineMinorVersion(engineRoot);

    return path.join(localAppData, 'UnrealEngine', engineMinorVersion, 'Saved', 'Config', 'WindowsEditor');

  }



  getGlobalEditorDdcConfigTargets(engineRoot = '') {

    return Array.from(new Set(

      [this.getGlobalEditorDdcConfigPath(), this.getLegacyGlobalEditorDdcConfigPath(engineRoot)]

        .map((item) => String(item || '').trim())

        .filter(Boolean),

    ));

  }



  async inspectGlobalEditorDdcPolicy(engineRoot = '') {

    const targetPolicies = [];

    for (const configPath of this.getGlobalEditorDdcConfigTargets(engineRoot)) {

      const sourceText = configPath ? await fs.readFile(configPath, 'utf8').catch(() => '') : '';

    const sanitized = sourceText

      .replace(/^\uFEFF/, '')

      .replace(/^(?:\?{2,}|[^\[]+(?=\[))/u, '')

      .replace(/^\[\r?\n(?:\r?\n)*(?=\[)/, '');

    const expectedLocalCachePath = '%ENGINEVERSIONAGNOSTICUSERDIR%DerivedDataCache';

    const rootValue = this.readIniSettingValue(sanitized, 'InstalledDerivedDataBackendGraph', 'Root');

    const hierarchyValue = this.readIniSettingValue(sanitized, 'InstalledDerivedDataBackendGraph', 'Hierarchy') || rootValue;

    const localValue = this.readIniSettingValue(sanitized, 'InstalledDerivedDataBackendGraph', 'Local');

    const autoLaunchValue = this.readIniSettingValue(sanitized, 'Zen', 'AutoLaunch');

    const localPathMatches = /Path="?(%ENGINEVERSIONAGNOSTICUSERDIR%DerivedDataCache)"?/i.test(localValue);

    const localExplicitlyWritable = /DeleteOnly\s*=\s*false/i.test(localValue) && !/ReadOnly\s*=\s*true/i.test(localValue);

    const rootExcludesZenLocal = hierarchyValue.includes('Inner=Local') && !hierarchyValue.includes('Inner=ZenLocal');

    const autoLaunchDisabled = !autoLaunchValue || this.parseIniBoolean(autoLaunchValue, false) === false;



    targetPolicies.push({

      configPath,

      configured: Boolean(sanitized.trim()),

      keepsEpicLaunchStable: rootExcludesZenLocal && localPathMatches && localExplicitlyWritable,

      keepsStartupLight: rootExcludesZenLocal && localPathMatches && localExplicitlyWritable && autoLaunchDisabled,

      localCachePath: expectedLocalCachePath,

      hierarchyValue,

      rootValue,

      localValue,

      autoLaunchValue,

    });

    }



    const expectedLocalCachePath = '%ENGINEVERSIONAGNOSTICUSERDIR%DerivedDataCache';

    const primaryConfigPath = this.getGlobalEditorDdcConfigPath();

    const primaryPolicy = targetPolicies.find((item) => normalizeKey(item.configPath) === normalizeKey(primaryConfigPath)) || targetPolicies[0] || null;

    const effectivePolicy = targetPolicies.find((item) => item.keepsEpicLaunchStable) || primaryPolicy || {

      configPath: primaryConfigPath,

      configured: false,

      keepsEpicLaunchStable: false,

      keepsStartupLight: false,

      localCachePath: expectedLocalCachePath,

      hierarchyValue: '',

      rootValue: '',

      localValue: '',

      autoLaunchValue: '',

    };



    return {

      ...effectivePolicy,

      configPath: primaryConfigPath,

      primaryConfigPath,

      targetPolicies,

    };

  }



  async inspectGlobalEditorStartupPolicy(engineRoot = '') {

    const targetPolicies = [];

    for (const configPath of this.getGlobalEditorDdcConfigTargets(engineRoot)) {

      const sourceText = configPath ? await fs.readFile(configPath, 'utf8').catch(() => '') : '';

      const sanitized = sourceText

        .replace(/^\uFEFF/, '')

        .replace(/^(?:\?{2,}|[^\[]+(?=\[))/u, '')

        .replace(/^\[\r?\n(?:\r?\n)*(?=\[)/, '');

      const homeScreenValue = this.readIniSettingValue(sanitized, 'ConsoleVariables', 'HomeScreen.EnableHomeScreen');

      const homeScreenDisabled = homeScreenValue

        ? this.parseIniBoolean(homeScreenValue, true) === false

        : false;

      targetPolicies.push({

        configPath,

        configured: Boolean(sanitized.trim()),

        homeScreenValue,

        homeScreenDisabled,

      });

    }

    const primaryConfigPath = this.getGlobalEditorDdcConfigPath();

    const primaryPolicy = targetPolicies.find((item) => normalizeKey(item.configPath) === normalizeKey(primaryConfigPath)) || targetPolicies[0] || null;

    const effectivePolicy = targetPolicies.find((item) => item.homeScreenDisabled) || primaryPolicy || {

      configPath: primaryConfigPath,

      configured: false,

      homeScreenValue: '',

      homeScreenDisabled: false,

    };

    const layoutPath = path.join(this.getLegacyGlobalEditorConfigDir(engineRoot), 'EditorLayout.ini');

    const layoutText = await fs.readFile(layoutPath, 'utf8').catch(() => '');

    const layoutReferencesHomeScreen = /\bHomeScreen\b/.test(layoutText);

    return {

      ...effectivePolicy,

      configPath: primaryConfigPath,

      primaryConfigPath,

      targetPolicies,

      layoutPath,

      layoutPresent: Boolean(layoutText),

      layoutReferencesHomeScreen,

      keepsNoProjectLaunchLight: effectivePolicy.homeScreenDisabled,

    };

  }



  async normalizeGlobalEditorDdcPolicy(engineRoot = '', reporter = null) {

    if (!engineRoot) {

      return { changedCount: 0, policy: await this.inspectGlobalEditorDdcPolicy(engineRoot) };

    }



    let changedCount = 0;

    const configTargets = this.getGlobalEditorDdcConfigTargets(engineRoot);

    for (const configPath of configTargets) {

      if (await this.upsertIniSetting(configPath, 'Zen', 'AutoLaunch', 'false')) changedCount += 1;

      if (await this.upsertIniSetting(

        configPath,

        'InstalledDerivedDataBackendGraph',

        'Root',

        '(Type=KeyLength, Length=120, Inner=AsyncPut)',

      )) changedCount += 1;

      if (await this.upsertIniSetting(

        configPath,

        'InstalledDerivedDataBackendGraph',

        'AsyncPut',

        '(Type=AsyncPut, Inner=Hierarchy)',

      )) changedCount += 1;

      if (await this.upsertIniSetting(

        configPath,

        'InstalledDerivedDataBackendGraph',

        'Hierarchy',

        '(Type=Hierarchical, Inner=EnginePak, Inner=Local)',

      )) changedCount += 1;

      if (await this.upsertIniSetting(

        configPath,

        'InstalledDerivedDataBackendGraph',

        'Local',

        '(Type=FileSystem, DeleteOnly=false, ReadOnly=false, UnusedFileAge=34, Path="%ENGINEVERSIONAGNOSTICUSERDIR%DerivedDataCache", EnvPathOverride=UE-LocalDataCachePath, EditorOverrideSetting=LocalDerivedDataCache)',

      )) changedCount += 1;

      if (await this.upsertIniSetting(

        configPath,

        'InstalledDerivedDataBackendGraph',

        'Pak',

        '(Type=ReadPak, Filename="%GAMEDIR%DerivedDataCache/DDC.ddp")',

      )) changedCount += 1;

      if (await this.upsertIniSetting(

        configPath,

        'InstalledDerivedDataBackendGraph',

        'CompressedPak',

        '(Type=ReadPak, Filename="%GAMEDIR%DerivedDataCache/Compressed.ddp", Compressed=true)',

      )) changedCount += 1;

      if (await this.upsertIniSetting(

        configPath,

        'InstalledDerivedDataBackendGraph',

        'EnginePak',

        '(Type=ReadPak, Filename=../../../Engine/DerivedDataCache/Compressed.ddp, Compressed=true)',

      )) changedCount += 1;

      if (await this.upsertIniSetting(

        configPath,

        'InstalledDerivedDataBackendGraph',

        'EnterprisePak',

        '(Type=ReadPak, Filename=../../../Enterprise/DerivedDataCache/Compressed.ddp, Compressed=true)',

      )) changedCount += 1;

      if (await this.upsertIniSetting(

        configPath,

        'InstalledNoZenLocalFallback',

        'Root',

        '(Type=Hierarchical, Inner=Pak, Inner=CompressedPak, Inner=EnginePak, Inner=EnterprisePak, Inner=Local)',

      )) changedCount += 1;

      if (await this.upsertIniSetting(

        configPath,

        'InstalledNoZenLocalFallback',

        'Local',

        '(Type=FileSystem, DeleteOnly=false, ReadOnly=false, UnusedFileAge=34, Path="%ENGINEVERSIONAGNOSTICUSERDIR%DerivedDataCache", EnvPathOverride=UE-LocalDataCachePath, EditorOverrideSetting=LocalDerivedDataCache)',

      )) changedCount += 1;

      if (await this.upsertIniSetting(

        configPath,

        'InstalledNoZenLocalFallback',

        'Shared',

        '(Type=FileSystem, UnusedFileAge=10, FoldersToClean=10, ConsiderSlowAt=70, Path=?EpicDDC, EnvPathOverride=UE-SharedDataCachePath, EditorOverrideSetting=SharedDerivedDataCache, CommandLineOverride=SharedDataCachePath)',

      )) changedCount += 1;

      if (await this.upsertIniSetting(

        configPath,

        'InstalledNoZenLocalFallback',

        'Cloud',

        '(Type=Cloud, ServerID=Cloud, EnvHostOverride=UE-CloudDataCacheHost, CommandLineHostOverride=CloudDataCacheHost, CommandLineOAuthSecretOverride="CloudDataCacheOAuthSecret", OAuthAccessTokenEnvOverride="UE-CloudDataCacheAccessToken", EnvHttpVersionOverride="UE-CloudDataCacheHttpVersion", CommandLineHttpVersionOverride="CloudDataCacheHttpVersion", EnvOAuthProviderIdentifierOverride="UE-CloudDataCacheOAuthProviderIdentifier", CommandLineOAuthProviderIdentifierOverride="CloudDataCacheOAuthProviderIdentifier")',

      )) changedCount += 1;

      if (await this.upsertIniSetting(

        configPath,

        'InstalledNoZenLocalFallback',

        'Pak',

        '(Type=ReadPak, Filename="%GAMEDIR%DerivedDataCache/DDC.ddp")',

      )) changedCount += 1;

      if (await this.upsertIniSetting(

        configPath,

        'InstalledNoZenLocalFallback',

        'CompressedPak',

        '(Type=ReadPak, Filename="%GAMEDIR%DerivedDataCache/Compressed.ddp", Compressed=true)',

      )) changedCount += 1;

      if (await this.upsertIniSetting(

        configPath,

        'InstalledNoZenLocalFallback',

        'EnginePak',

        '(Type=ReadPak, Filename=../../../Engine/DerivedDataCache/Compressed.ddp, Compressed=true)',

      )) changedCount += 1;

      if (await this.upsertIniSetting(

        configPath,

        'InstalledNoZenLocalFallback',

        'EnterprisePak',

        '(Type=ReadPak, Filename=../../../Enterprise/DerivedDataCache/Compressed.ddp, Compressed=true)',

      )) changedCount += 1;

    }

    if (changedCount > 0) {

      reporter?.info('Normalized Unreal global editor DDC defaults for Epic Games / no-project startup.', {

        engineRoot,

        configTargets,

        changedCount,

      });

    }

    return {

      changedCount,

      policy: await this.inspectGlobalEditorDdcPolicy(engineRoot),

    };

  }



  async normalizeGlobalEditorStartupPolicy(engineRoot = '', reporter = null) {

    if (!engineRoot) {

      return { changedCount: 0, configChangedCount: 0, layoutResetCount: 0, policy: await this.inspectGlobalEditorStartupPolicy(engineRoot) };

    }



    let configChangedCount = 0;

    for (const configPath of this.getGlobalEditorDdcConfigTargets(engineRoot)) {

      if (await this.upsertIniSetting(configPath, 'ConsoleVariables', 'HomeScreen.EnableHomeScreen', 'False')) {

        configChangedCount += 1;

      }

    }



    let layoutResetCount = 0;

    const startupPolicy = await this.inspectGlobalEditorStartupPolicy(engineRoot);

    const layoutPath = startupPolicy.layoutPath;

    if (startupPolicy.layoutReferencesHomeScreen && layoutPath && await pathExists(layoutPath)) {

      const backupPath = `${layoutPath}.hmdao-startup-reset-${formatTimestampTag()}.bak`;

      let backedUp = false;

      try {

        await fs.rename(layoutPath, backupPath);

        backedUp = true;

      } catch {

        try {

          await fs.copyFile(layoutPath, backupPath);

          await removeIfExists(layoutPath);

          backedUp = true;

        } catch {

          backedUp = false;

        }

      }

      if (backedUp) layoutResetCount += 1;

    }



    const changedCount = configChangedCount + layoutResetCount;

    if (changedCount > 0) {

      reporter?.info('Normalized Unreal no-project startup UI for a lighter host-first launch.', {

        engineRoot,

        configTargets: this.getGlobalEditorDdcConfigTargets(engineRoot),

        configChangedCount,

        layoutResetCount,

      });

    }



    return {

      changedCount,

      configChangedCount,

      layoutResetCount,

      policy: await this.inspectGlobalEditorStartupPolicy(engineRoot),

    };

  }



  async normalizeProjectDdcPolicy(projectPath, reporter = null) {

    if (!projectPath || !await pathExists(projectPath)) {

      return { changedCount: 0, policy: await this.inspectProjectDdcPolicy(projectPath) };

    }



    const configPath = path.join(path.dirname(projectPath), 'Config', 'DefaultEngine.ini');

    let changedCount = 0;

    if (await this.upsertIniSetting(configPath, 'Zen', 'AutoLaunch', 'false')) changedCount += 1;

    if (await this.upsertIniSetting(

      configPath,

      'InstalledDerivedDataBackendGraph',

      'Root',

      '(Type=KeyLength, Length=120, Inner=AsyncPut)',

    )) changedCount += 1;

    if (await this.upsertIniSetting(

      configPath,

      'InstalledDerivedDataBackendGraph',

      'AsyncPut',

      '(Type=AsyncPut, Inner=Hierarchy)',

    )) changedCount += 1;

    if (await this.upsertIniSetting(

      configPath,

      'InstalledDerivedDataBackendGraph',

      'Hierarchy',

      '(Type=Hierarchical, Inner=Local)',

    )) changedCount += 1;

    if (await this.upsertIniSetting(

      configPath,

      'InstalledDerivedDataBackendGraph',

      'Local',

      '(Type=FileSystem, DeleteOnly=false, ReadOnly=false, UnusedFileAge=34, Path="%GAMEDIR%DerivedDataCache/Local", EnvPathOverride=UE-LocalDataCachePath, EditorOverrideSetting=LocalDerivedDataCache)',

    )) changedCount += 1;

    if (await this.upsertIniSetting(

      configPath,

      'InstalledDerivedDataBackendGraph',

      'Pak',

      '(Type=ReadPak, Filename="%GAMEDIR%DerivedDataCache/DDC.ddp")',

    )) changedCount += 1;

    if (await this.upsertIniSetting(

      configPath,

      'InstalledDerivedDataBackendGraph',

      'CompressedPak',

      '(Type=ReadPak, Filename="%GAMEDIR%DerivedDataCache/Compressed.ddp", Compressed=true)',

    )) changedCount += 1;

    if (await this.upsertIniSetting(

      configPath,

      'InstalledDerivedDataBackendGraph',

      'EnginePak',

      '(Type=ReadPak, Filename=../../../Engine/DerivedDataCache/Compressed.ddp, Compressed=true)',

    )) changedCount += 1;

    if (await this.upsertIniSetting(

      configPath,

      'InstalledDerivedDataBackendGraph',

      'EnterprisePak',

      '(Type=ReadPak, Filename=../../../Enterprise/DerivedDataCache/Compressed.ddp, Compressed=true)',

    )) changedCount += 1;

    if (await this.upsertIniSetting(

      configPath,

      'InstalledNoZenLocalFallback',

      'Root',

      '(Type=Hierarchical, Inner=Pak, Inner=CompressedPak, Inner=EnginePak, Inner=EnterprisePak, Inner=Local)',

    )) changedCount += 1;

    if (await this.upsertIniSetting(

      configPath,

      'InstalledNoZenLocalFallback',

      'Local',

      '(Type=FileSystem, DeleteOnly=false, ReadOnly=false, UnusedFileAge=34, Path="%GAMEDIR%DerivedDataCache/Local", EnvPathOverride=UE-LocalDataCachePath, EditorOverrideSetting=LocalDerivedDataCache)',

    )) changedCount += 1;

    if (await this.upsertIniSetting(

      configPath,

      'InstalledNoZenLocalFallback',

      'Shared',

      '(Type=FileSystem, UnusedFileAge=10, FoldersToClean=10, ConsiderSlowAt=70, Path=?EpicDDC, EnvPathOverride=UE-SharedDataCachePath, EditorOverrideSetting=SharedDerivedDataCache, CommandLineOverride=SharedDataCachePath)',

    )) changedCount += 1;

    if (await this.upsertIniSetting(

      configPath,

      'InstalledNoZenLocalFallback',

      'Cloud',

      '(Type=Cloud, ServerID=Cloud, EnvHostOverride=UE-CloudDataCacheHost, CommandLineHostOverride=CloudDataCacheHost, CommandLineOAuthSecretOverride="CloudDataCacheOAuthSecret", OAuthAccessTokenEnvOverride="UE-CloudDataCacheAccessToken", EnvHttpVersionOverride="UE-CloudDataCacheHttpVersion", CommandLineHttpVersionOverride="CloudDataCacheHttpVersion", EnvOAuthProviderIdentifierOverride="UE-CloudDataCacheOAuthProviderIdentifier", CommandLineOAuthProviderIdentifierOverride="CloudDataCacheOAuthProviderIdentifier")',

    )) changedCount += 1;

    if (await this.upsertIniSetting(

      configPath,

      'InstalledNoZenLocalFallback',

      'Pak',

      '(Type=ReadPak, Filename="%GAMEDIR%DerivedDataCache/DDC.ddp")',

    )) changedCount += 1;

    if (await this.upsertIniSetting(

      configPath,

      'InstalledNoZenLocalFallback',

      'CompressedPak',

      '(Type=ReadPak, Filename="%GAMEDIR%DerivedDataCache/Compressed.ddp", Compressed=true)',

    )) changedCount += 1;

    if (await this.upsertIniSetting(

      configPath,

      'InstalledNoZenLocalFallback',

      'EnginePak',

      '(Type=ReadPak, Filename=../../../Engine/DerivedDataCache/Compressed.ddp, Compressed=true)',

    )) changedCount += 1;

    if (await this.upsertIniSetting(

      configPath,

      'InstalledNoZenLocalFallback',

      'EnterprisePak',

      '(Type=ReadPak, Filename=../../../Enterprise/DerivedDataCache/Compressed.ddp, Compressed=true)',

    )) changedCount += 1;

    if (changedCount > 0) {

      reporter?.info('Normalized Unreal project DDC defaults for a lighter standalone editor launch.', {

        projectPath,

        configPath,

        changedCount,

      });

    }

    return {

      changedCount,

      policy: await this.inspectProjectDdcPolicy(projectPath),

    };

  }



  async inspectRemoteControlStartupPolicy(projectPath = '') {

    const projectDir = projectPath ? path.dirname(projectPath) : '';

    const configPath = projectDir ? path.join(projectDir, 'Config', 'DefaultRemoteControl.ini') : '';

    const sourceText = configPath ? await fs.readFile(configPath, 'utf8').catch(() => '') : '';

    const sectionName = '/Script/RemoteControlCommon.RemoteControlSettings';

    const autoStartWebServer = this.parseIniBoolean(

      this.readIniSettingValue(sourceText, sectionName, 'bAutoStartWebServer'),

      true,

    );

    const autoStartWebSocketServer = this.parseIniBoolean(

      this.readIniSettingValue(sourceText, sectionName, 'bAutoStartWebSocketServer'),

      true,

    );

    return {

      configPath,

      configured: Boolean(sourceText.trim()),

      autoStartWebServer,

      autoStartWebSocketServer,

      keepsStartupLight: !autoStartWebServer && !autoStartWebSocketServer,

    };

  }



  async normalizeRemoteControlStartupState(projectPath, reporter = null) {

    if (!projectPath || !await pathExists(projectPath)) return { changedCount: 0, policy: null };

    const projectDir = path.dirname(projectPath);

    const configPath = path.join(projectDir, 'Config', 'DefaultRemoteControl.ini');

    const sectionName = '/Script/RemoteControlCommon.RemoteControlSettings';

    let changedCount = 0;

    if (await this.upsertIniSetting(configPath, sectionName, 'bAutoStartWebServer', 'False')) changedCount += 1;

    if (await this.upsertIniSetting(configPath, sectionName, 'bAutoStartWebSocketServer', 'False')) changedCount += 1;

    if (changedCount > 0) {

      reporter?.info('Normalized Unreal Remote Control startup policy for lightweight editor launch.', {

        projectPath,

        configPath,

        changedCount,

      });

    }

    return {

      changedCount,

      policy: await this.inspectRemoteControlStartupPolicy(projectPath),

    };

  }



  async normalizeProjectStartupState(projectPath, reporter, {

    includeProjectDefaults = false,

    startupMap = '',

    normalizeDdcPolicy = true,

  } = {}) {

    if (!projectPath || !await pathExists(projectPath)) return;

    const projectDir = path.dirname(projectPath);

    const updates = [

      [path.join(projectDir, 'Saved', 'Config', 'WindowsEditor', 'EditorPerProjectUserSettings.ini'), '/Script/UnrealEd.EditorLoadingSavingSettings', 'LoadLevelAtStartup', 'None'],

      [path.join(projectDir, 'Saved', 'Config', 'WindowsEditor', 'EditorPerProjectUserSettings.ini'), '/Script/UnrealEd.EditorLoadingSavingSettings', 'RestoreOpenAssetTabsOnRestart', 'NeverRestore'],

      [path.join(projectDir, 'Saved', 'Config', 'WindowsEditor', 'EditorPerProjectUserSettings.ini'), '/Script/UnrealEd.EditorLoadingSavingSettings', 'bDetectChangesOnStartup', 'False'],

      [path.join(projectDir, 'Saved', 'Config', 'WindowsEditor', 'EditorPerProjectUserSettings.ini'), 'EditorStartup', 'LastLevel', ''],

      [path.join(projectDir, 'Saved', 'Config', 'WindowsEditor', 'EditorPerProjectUserSettings.ini'), 'AssetEditorSubsystem', 'CleanShutdown', 'True'],

    ];

    if (includeProjectDefaults) {

      updates.unshift(

        [path.join(projectDir, 'Config', 'DefaultEditorPerProjectUserSettings.ini'), '/Script/UnrealEd.EditorLoadingSavingSettings', 'LoadLevelAtStartup', 'None'],

        [path.join(projectDir, 'Config', 'DefaultEditorPerProjectUserSettings.ini'), '/Script/UnrealEd.EditorLoadingSavingSettings', 'RestoreOpenAssetTabsOnRestart', 'NeverRestore'],

        [path.join(projectDir, 'Config', 'DefaultEditorPerProjectUserSettings.ini'), '/Script/UnrealEd.EditorLoadingSavingSettings', 'bDetectChangesOnStartup', 'False'],

      );

      if (startupMap) {

        updates.unshift([path.join(projectDir, 'Config', 'DefaultEngine.ini'), '/Script/EngineSettings.GameMapsSettings', 'EditorStartupMap', startupMap]);

      }

    }

    let changedCount = 0;

    for (const [filePath, sectionName, key, value] of updates) {

      if (await this.upsertIniSetting(filePath, sectionName, key, value)) changedCount += 1;

    }

    if (changedCount > 0) {

      reporter?.info('Normalized Unreal editor startup settings for a lighter isolated launch.', {

        projectPath,

        changedCount,

        includeProjectDefaults,

        startupMap: startupMap || null,

      });

    }

    if (normalizeDdcPolicy) {

      await this.normalizeProjectDdcPolicy(projectPath, reporter);

    }

  }



  async normalizeSafeSidecarStartupState(reporter) {

    if (!await pathExists(this.sidecarProjectPath)) return;

    await this.normalizeProjectStartupState(this.sidecarProjectPath, reporter, {

      includeProjectDefaults: true,

      startupMap: '/Engine/Maps/Entry',

    });

  }



  async readProjectStartupSnapshot(project, engineRoot = '') {

    if (!project?.path) return null;

    const startupLog = await this.resolveStartupLogCandidate(project, engineRoot);

    const logPath = startupLog.logPath;

    const stat = startupLog.stat;

    const processStartedAtMs = Math.max(0, Number(project?.startedAtMs || 0));

    if (!stat) {

      return processStartedAtMs > 0 ? {

        logPath,

        logSource: startupLog.source,

        lastWriteTimeMs: 0,

        ageMs: 0,

        phaseKey: 'log-wait',

        phaseLabel: 'Current Unreal run has not written any startup log yet',

        phaseLine: '',

        lineCount: 0,

      } : null;

    }

    if (processStartedAtMs > 0 && stat.mtimeMs + 1000 < processStartedAtMs) {

      return {

        logPath,

        logSource: startupLog.source,

        lastWriteTimeMs: stat.mtimeMs,

        ageMs: Math.max(0, Date.now() - stat.mtimeMs),

        phaseKey: 'stale-log',

        phaseLabel: 'Only a stale Unreal log from an older run is available',

        phaseLine: '',

        lineCount: 0,

      };

    }

    const text = await fs.readFile(logPath, 'utf8').catch(() => '');

    const lines = text.split(/\r?\n/g).filter(Boolean);

    const ageMs = Math.max(0, Date.now() - stat.mtimeMs);



    let bestPhase = null;

    for (const phase of SIDECAR_STARTUP_PHASES) {

      const match = findLastMatchingLineInfo(lines, phase.pattern);

      if (!match) continue;

      if (!bestPhase || match.index > bestPhase.index) {

        bestPhase = {

          index: match.index,

          key: phase.key,

          label: phase.label,

          line: match.line,

        };

      }

    }



    if (bestPhase) {

      return {

        logPath,

        logSource: startupLog.source,

        lastWriteTimeMs: stat.mtimeMs,

        ageMs,

        phaseKey: bestPhase.key,

        phaseLabel: bestPhase.label,

        phaseLine: bestPhase.line,

        lineCount: lines.length,

      };

    }



    return {

      logPath,

      logSource: startupLog.source,

      lastWriteTimeMs: stat.mtimeMs,

      ageMs,

      phaseKey: 'log-open',

      phaseLabel: 'Unreal log opened',

      phaseLine: lines.at(-1) || '',

      lineCount: lines.length,

    };

  }



  async readSidecarStartupSnapshot(project) {

    if (!this.isSafeSidecarProject(project)) return null;

    return this.readProjectStartupSnapshot(project);

  }



  async waitForDirectBridge(reporter, {

    project = null,

    projectPath,

    engineRoot = '',

    timeoutMs,

    cameraTimeoutMs = 90000,

    intervalMs = 1500,

    progressEveryMs = 30000,

    snapshotRefreshMs = 5000,

    stallAfterMs = 120000,

    minWaitBeforeStallMs = 180000,

  } = {}) {

    const startedAt = Date.now();

    let lastProgressAt = 0;

    let lastSnapshotReadAt = 0;

    let latestSnapshot = null;

    let lastPhaseKey = '';

    let phaseStableSinceMs = startedAt;



    while (Date.now() - startedAt < timeoutMs) {

      const waitedMs = Date.now() - startedAt;

      if (project && (Date.now() - lastSnapshotReadAt >= snapshotRefreshMs)) {

        latestSnapshot = await this.readProjectStartupSnapshot(project, engineRoot);

        lastSnapshotReadAt = Date.now();

        const nextPhaseKey = String(latestSnapshot?.phaseKey || '').trim().toLowerCase();

        if (nextPhaseKey !== lastPhaseKey) {

          lastPhaseKey = nextPhaseKey;

          phaseStableSinceMs = Date.now();

        }

      }

      if (project?.pid) {

        let processAlive = await isWindowsProcessAlive(project.pid);

        if (!processAlive) {

          const fallbackHostProcesses = await this.inspectEditorProcessFallback();

          const runtimeFallback = await this.inferRuntimeFromFallback(project, fallbackHostProcesses);

          const fallbackPid = Number(runtimeFallback?.targetPid || fallbackHostProcesses[0]?.pid || 0);

          processAlive = fallbackPid > 0 ? await isWindowsProcessAlive(fallbackPid) : false;

          if (processAlive && fallbackPid && fallbackPid !== Number(project.pid || 0)) {

            reporter?.info('Unreal bridge wait recovered from a stale project pid and switched to a live editor process.', {

              projectPath,

              previousPid: project.pid,

              fallbackPid,

            });

            project = { ...project, pid: fallbackPid, running: true };

          }

        }

        if (!processAlive) {

          reporter?.warn('Unreal Editor exited before HMDao direct bridge came online.', {

            projectPath,

            pid: project.pid,

            waitedSeconds: Math.round(waitedMs / 1000),

            startupPhase: latestSnapshot?.phaseLabel || 'unknown phase',

          });

          return {

            ok: false,

            waitedMs,

            cameraCount: 0,

            stalled: true,

            exited: true,

            startupSnapshot: latestSnapshot,

          };

        }

      }



      const bridgeState = this.getBridgeState() || {};

      if (bridgeState.directBridgeOnline) {

        const camerasReady = await waitForCondition(() => {

          const nextState = this.getBridgeState() || {};

          return cameraCountFromBridgeState(nextState) > 0;

        }, {

          timeoutMs: cameraTimeoutMs,

          intervalMs: 1000,

        });

        if (camerasReady) {

          const nextState = this.getBridgeState() || {};

          const cameraCount = cameraCountFromBridgeState(nextState);

          return {

            ok: true,

            waitedMs: Date.now() - startedAt,

            cameraCount,

            startupSnapshot: latestSnapshot,

          };

        }

        throw new Error(`HMDao direct bridge connected, but Unreal still did not return any camera/view source within ${Math.round(cameraTimeoutMs / 1000)} seconds. The plugin should eventually return at least the Editor Viewport fallback, so this points to an incomplete bridge state handshake rather than "no camera in scene" by itself.`);

      }



      const adaptiveThresholds = getAdaptiveStallThresholds(latestSnapshot, {

        stallAfterMs,

        minWaitBeforeStallMs,

      });

      const startupHasNoFreshLog = ['log-wait', 'stale-log'].includes(String(latestSnapshot?.phaseKey || ''))

        && waitedMs >= adaptiveThresholds.stallAfterMs;

      if (startupHasNoFreshLog) {

        reporter?.warn('Unreal Editor did not write any fresh startup log before HMDao direct bridge timeout.', {

          projectPath,

          waitedSeconds: Math.round(waitedMs / 1000),

          startupPhase: latestSnapshot.phaseLabel,

        });

        return {

          ok: false,

          waitedMs,

          cameraCount: 0,

          stalled: true,

          noFreshLog: true,

          startupSnapshot: latestSnapshot,

        };

      }

      const startupLooksStalled = latestSnapshot

        && latestSnapshot.phaseKey !== 'stale-log'

        && latestSnapshot.ageMs >= adaptiveThresholds.stallAfterMs

        && (waitedMs >= adaptiveThresholds.minWaitBeforeStallMs || latestSnapshot.ageMs >= adaptiveThresholds.minWaitBeforeStallMs);

      if (startupLooksStalled) {

        reporter?.warn('Unreal Editor startup appears stalled before HMDao direct bridge came online.', {

          projectPath,

          waitedSeconds: Math.round(waitedMs / 1000),

          startupPhase: latestSnapshot.phaseLabel,

          phaseAgeSeconds: Math.round(latestSnapshot.ageMs / 1000),

          phaseLine: latestSnapshot.phaseLine,

        });

        return {

          ok: false,

          waitedMs,

          cameraCount: 0,

          stalled: true,

          startupSnapshot: latestSnapshot,

        };

      }

      const phaseStableMs = Math.max(0, Date.now() - phaseStableSinceMs);

      const startupLooksPhaseBound = latestSnapshot

        && ['log-open', 'slate', 'asset-registry', 'shader-warmup'].includes(String(latestSnapshot.phaseKey || '').trim().toLowerCase())

        && phaseStableMs >= adaptiveThresholds.stallAfterMs

        && waitedMs >= adaptiveThresholds.minWaitBeforeStallMs;

      if (startupLooksPhaseBound) {

        reporter?.warn('Unreal Editor stayed in the same early startup phase for too long before HMDao direct bridge came online.', {

          projectPath,

          waitedSeconds: Math.round(waitedMs / 1000),

          startupPhase: latestSnapshot.phaseLabel,

          phaseStableSeconds: Math.round(phaseStableMs / 1000),

          phaseLine: latestSnapshot.phaseLine,

        });

        return {

          ok: false,

          waitedMs,

          cameraCount: 0,

          stalled: true,

          phaseBound: true,

          phaseStableMs,

          startupSnapshot: latestSnapshot,

        };

      }



      if (Date.now() - lastProgressAt >= progressEveryMs) {

        lastProgressAt = Date.now();

        reporter?.info('Waiting for Unreal Editor startup before HMDao direct bridge comes online.', {

          projectPath,

          waitedSeconds: Math.round(waitedMs / 1000),

          startupPhase: latestSnapshot?.phaseLabel || '',

          phaseAgeSeconds: latestSnapshot ? Math.round(latestSnapshot.ageMs / 1000) : null,

          phaseStableSeconds: latestSnapshot ? Math.round(phaseStableMs / 1000) : null,

        });

      }



      await sleep(intervalMs);

    }



    return {

      ok: false,

      waitedMs: Date.now() - startedAt,

      cameraCount: 0,

      stalled: false,

      phaseStableMs: Math.max(0, Date.now() - phaseStableSinceMs),

      startupSnapshot: latestSnapshot,

    };

  }



  getRunningProjectConnectWaitOptions(project, startupSnapshot) {
    const uptimeMs = Math.max(0, Date.now() - Number(project?.startedAtMs || 0));
    const startupGraceWindowMs = 12 * 60 * 1000;
    const startupPhaseKey = String(startupSnapshot?.phaseKey || '').trim().toLowerCase();
    const logIsFresh = Boolean(startupSnapshot?.lastWriteTimeMs) && Number(startupSnapshot?.ageMs || 0) < 300000;
    const longWaitPhase = ['project-plugin', 'shader-warmup', 'slate', 'turnkey', 'asset-registry', 'editor-domain', 'remote-control'].includes(startupPhaseKey);
    const startupSignalPresent = Boolean(startupSnapshot)
      && !['bridge-online', 'plugin-startup', 'stale-log'].includes(startupPhaseKey)
      && (logIsFresh || longWaitPhase);
    const recentlyLaunched = uptimeMs > 0 && uptimeMs < startupGraceWindowMs;
    const startupStillInFlight = startupSignalPresent && (uptimeMs <= 0 || uptimeMs < startupGraceWindowMs);

    if (startupStillInFlight || recentlyLaunched) {
      return {
        timeoutMs: 600000,
        stallAfterMs: 180000,
        minWaitBeforeStallMs: 240000,
        uptimeMs,
      };
    }

    return {
      timeoutMs: 120000,
      stallAfterMs: 90000,
      minWaitBeforeStallMs: 90000,
      uptimeMs,
    };
  }


  async stopSafeSidecar(project, reporter) {

    if (!this.isSafeSidecarProject(project)) return false;

    if (!project?.pid) return false;



    reporter?.warn('HMDao safe sidecar is running without a direct bridge. Restarting the safe sidecar automatically.', {

      projectPath: project.path,

      pid: project.pid,

    });

    const stopResult = await stopWindowsProcessTree(project.pid);

    if (!stopResult.ok) {

      reporter?.warn('Safe sidecar stop request returned a non-zero result.', {

        projectPath: project.path,

        pid: project.pid,

        stderr: stopResult.stderr || '',

      });

    }



    await waitForCondition(async () => {

      const projects = await this.discoverProjectsWithSidecar();

      const nextProject = projects.find((item) => normalizeKey(item.path) === normalizeKey(project.path));

      return !nextProject?.running;

    }, {

      timeoutMs: 15000,

      intervalMs: 750,

    });



    return true;

  }



  async legacyGetStatusForReferenceOnly() {

    const [engineInstalls, projects, backups, hostProcesses, startupInterferers, securityHardening, memoryPressure] = await Promise.all([

      discoverUnrealEngineInstalls(),

      this.discoverProjectsWithSidecar(),

      listBackups(this.backupRoot, this.id),

      discoverRunningProcesses('^UnrealEditor'),

      this.inspectKnownStartupInterferers(),

      this.inspectWindowsSecurityHardening(),

      this.inspectSystemMemoryPressure(),

    ]);

    const project = projects[0] || null;

    const hasSecurityHookInterferer = startupInterferers.some((item) => item.key === 'qqpc');

    const hasSystemSecurityHardening = Boolean(securityHardening?.vbsRunning || securityHardening?.kernelCiEnforced || securityHardening?.userCiEnforced);

    const runtimeFallback = await this.inferRuntimeFromFallback(project, hostProcesses);

    const hostProcessRunning = runtimeFallback.hostProcessRunning;

    const targetProjectRunning = Boolean(project?.running) || runtimeFallback.targetProjectRunning;

    const projectJson = project ? await readJsonFile(project.path, {}) : {};

    const engineInstall = project ? this.findEngineInstall(engineInstalls, project, '', runtimeFallback) : engineInstalls[0] || null;
    const pluginInstall = project

      ? await this.resolveInstalledPlugin(project, engineInstall?.engineRoot || '')

      : { installed: false, effectivePath: '', projectPluginPath: '', installationScope: '' };

    const pluginPath = pluginInstall.effectivePath;

    const pluginInstalled = pluginInstall.installed;

    const pluginEnabled = Array.isArray(projectJson?.Plugins)
      ? projectJson.Plugins.some((item) => String(item?.Name || '').trim() === UNREAL_PLUGIN_NAME && Boolean(item?.Enabled))
      : false;
    const buildArtifactsPresent = pluginInstalled ? await pathExists(path.join(pluginPath, 'Binaries')) : false;
    const bridgeState = this.getBridgeState() || {};
    const pluginSync = await this.inspectPluginSync(pluginPath, bridgeState);
    const cameraCount = cameraCountFromBridgeState(bridgeState);

    const zenRuntime = await this.inspectZenRuntime(engineInstall?.engineRoot || '');

    const globalEditorStartupPolicy = await this.inspectGlobalEditorStartupPolicy(engineInstall?.engineRoot || '');

    const staleReceiptFiles = project && !pluginInstall.projectInstalled

      ? await this.inspectProjectTargetReceiptResidue(project.path)

      : [];

    const summary = deriveUnrealStateSummary({

      project,

      pluginInstalled,

      pluginEnabled,

      buildArtifactsPresent,

      directBridgeOnline: Boolean(bridgeState?.directBridgeOnline),

      cameraCount,

    });



    return {

      id: this.id,

      adapter: {

        id: this.adapterId,

        label: this.adapterId,

      },

      label: this.label,

      pluginName: this.pluginName,

      pluginSourcePath: this.pluginSourcePath,

      summary: summary.summary,

      level: summary.level,

      recommendedAction: !project

        ? 'detect'

        : !pluginInstalled

          ? 'install'

          : !pluginEnabled || !buildArtifactsPresent

            ? 'repair'

            : !bridgeState?.directBridgeOnline || cameraCount <= 0

              ? 'connect'

              : 'ready',

      host: {

        engineInstalls,
        resolvedEngineRoot: engineInstall?.engineRoot || '',
        resolvedEngineVersion: engineInstall?.version || engineInstall?.label || '',
        runningProjectDetected: projects.some((item) => item.running),

      },

      project: project ? {

        ...project,

        pluginPath,

        projectPluginPath: pluginInstall.projectPluginPath,

      } : null,

      projects,

      plugin: {

        installed: pluginInstalled,

        enabledInProject: pluginEnabled,

        buildArtifactsPresent,

        installationScope: pluginInstall.installationScope || null,

        effectivePath: pluginPath || null,

        projectPluginPath: pluginInstall.projectPluginPath || null,

        directBridgeOnline: Boolean(bridgeState?.directBridgeOnline),

        cameraCount,

        lastBackup: backups[0] || null,

        backups: backups.slice(0, 5),

      },

      runtime: {

        zen: zenRuntime,

        startupSnapshot,

      },

      layers: [

        {

          key: 'ddc-zen',

          label: 'DDC / Zen',

          state: zenRuntime.ready ? 'ready' : 'warning',

          detail: zenRuntime.ready

            ? `Zen runtime is reachable on 127.0.0.1:${zenRuntime.port}.`

            : zenRuntime.toolExists

              ? zenRuntime.serviceInstalled

                ? `Zen service exists but is not reachable yet. ${zenRuntime.serviceStatusText || ''}`.trim()

                : 'Zen service is not installed. Connect will preflight Zen automatically before editor launch, and only fall back to memory DDC for that launch if needed.'

              : 'zen.exe was not found under the selected Unreal engine root.',

        },

        {

          key: 'project-browser-startup-ui',

          label: 'Project browser startup UI',

          state: globalEditorStartupPolicy.keepsNoProjectLaunchLight ? 'ready' : 'warning',

          detail: globalEditorStartupPolicy.keepsNoProjectLaunchLight

            ? 'No-project Unreal startup is pinned to the classic project browser instead of the web Home Panel.'

            : 'No-project Unreal startup still prefers the web Home Panel. HMDao no longer flips this globally, because changing editor startup UI had too much cross-session side effect.',
        },

        {

          key: 'engine-install',

          label: 'Engine Install',

          state: engineInstall ? 'ready' : 'warning',

          detail: engineInstall

            ? `${engineInstall.version} - ${engineInstall.engineRoot}`

            : 'No Unreal Engine install was detected.',

        },

        {

          key: 'project',

          label: 'Target Project',

          state: project ? 'ready' : 'warning',

          detail: project

            ? `${project.path}${project.source === 'hmdao-sidecar' ? ' - HMDao safe sidecar' : ''}`

            : 'No available .uproject was detected.',

        },

        {

          key: 'plugin-install',

          label: 'Plugin Files',

          state: pluginInstalled ? 'ready' : 'warning',

          detail: pluginInstalled ? pluginPath : 'HMDaoUnrealCapture is not installed in the project or engine plugin folders.',

        },

        {

          key: 'plugin-enable',

          label: 'Plugin Enabled',

          state: pluginEnabled ? 'ready' : 'warning',

          detail: pluginEnabled ? 'HMDaoUnrealCapture is enabled in the current .uproject.' : 'HMDaoUnrealCapture is not enabled in the current .uproject.',

        },

        {

          key: 'build',

          label: 'Build Artifacts',

          state: buildArtifactsPresent ? 'ready' : 'warning',

          detail: buildArtifactsPresent ? 'Plugin binaries were found.' : 'Plugin binaries were not found yet. Build the plugin once after install.',

        },

        {

          key: 'bridge',

          label: 'Editor Direct Bridge',

          state: bridgeState?.directBridgeOnline ? 'ready' : 'warning',

          detail: bridgeState?.directBridgeOnline

            ? `HMDao received the Unreal direct bridge. Active browser clients: ${Number(bridgeState?.clientCount || 0)}.`

            : 'The plugin files are ready, but Unreal has not connected its direct editor bridge to HMDao yet.',

        },

        {

          key: 'camera',

          label: 'Camera Sources',

          state: cameraCount > 0 ? 'ready' : 'warning',

          detail: cameraCount > 0

            ? `${cameraCount} available camera/view source(s) were enumerated, including Editor Viewport fallback when no explicit cinematic camera is selected.`

            : 'No camera/view source has been returned yet. Once the bridge answers query_state, HMDao should still be able to fall back to Editor Viewport when no explicit cinematic camera is available.',

        },

      ],

      notes: [

        'Environment Manager can auto-detect Unreal Engine installs, running .uproject targets, and the HMDao safe sidecar.',

        'Prefer copy-only install plus manual enable from the plugin list instead of always-on engine startup hooks.',

        'If the plugin is installed but the bridge is offline, try Connect first. If the project is already open and the bridge stays offline, the issue is in the Unreal runtime path rather than file installation.',

      ],

      actions: ['detect', 'connect', 'install', 'update', 'repair', 'cleanup', 'remove', 'rollback'],

    };

  }



  async getStatus(_options = {}) {
    const [engineInstalls, projects, backups, hostProcesses, startupInterferers, securityHardening, memoryPressure] = await Promise.all([

      discoverUnrealEngineInstalls(),

      this.discoverProjectsWithSidecar(),

      listBackups(this.backupRoot, this.id),

      discoverRunningProcesses('^UnrealEditor'),

      this.inspectKnownStartupInterferers(),

      this.inspectWindowsSecurityHardening(),

      this.inspectSystemMemoryPressure(),

    ]);

    const project = projects[0] || null;

    const hasSecurityHookInterferer = startupInterferers.some((item) => item.key === 'qqpc');

    const hasSystemSecurityHardening = Boolean(securityHardening?.vbsRunning || securityHardening?.kernelCiEnforced || securityHardening?.userCiEnforced);

    const runtimeFallback = await this.inferRuntimeFromFallback(project, hostProcesses);

    const hostProcessRunning = runtimeFallback.hostProcessRunning;

    const targetProjectRunning = Boolean(project?.running) || runtimeFallback.targetProjectRunning;

    const projectJson = project ? await readJsonFile(project.path, {}) : {};

    const engineInstall = project ? this.findEngineInstall(engineInstalls, project, '', runtimeFallback) : engineInstalls[0] || null;
    const pluginInstall = project

      ? await this.resolveInstalledPlugin(project, engineInstall?.engineRoot || '')

      : { installed: false, effectivePath: '', projectPluginPath: '', installationScope: '' };

    const pluginPath = pluginInstall.effectivePath;

    const pluginInstalled = pluginInstall.installed;

    const pluginEnabled = Array.isArray(projectJson?.Plugins)
      ? projectJson.Plugins.some((item) => String(item?.Name || '').trim() === UNREAL_PLUGIN_NAME && Boolean(item?.Enabled))
      : false;
    const buildArtifactsPresent = pluginInstalled ? await pathExists(path.join(pluginPath, 'Binaries')) : false;
    const bridgeState = this.getBridgeState() || {};
    const pluginSync = await this.inspectPluginSync(pluginPath, bridgeState);
    const cameraCount = cameraCountFromBridgeState(bridgeState);

    const directBridgeOnline = Boolean(bridgeState?.directBridgeOnline);

    const effectiveDirectBridgeOnline = targetProjectRunning && directBridgeOnline;

    const directBridgeReadyForTargetProject = targetProjectRunning && directBridgeOnline && cameraCount > 0;

    const officialStatus = await this.buildOfficialCapabilityStatus(project, projectJson);

    const ddcPolicy = await this.inspectProjectDdcPolicy(project?.path || '');

    const globalEditorDdcPolicy = await this.inspectGlobalEditorDdcPolicy(engineInstall?.engineRoot || '');

    const globalEditorStartupPolicy = await this.inspectGlobalEditorStartupPolicy(engineInstall?.engineRoot || '');

    const zenRuntime = await this.inspectZenRuntime(engineInstall?.engineRoot || '');

    const staleReceiptFiles = project && !pluginInstall.projectInstalled

      ? await this.inspectProjectTargetReceiptResidue(project.path)

      : [];

    const integration = this.buildIntegrationState({

      bridgeState,

      cameraCount,

      pluginInstalled,

      pluginEnabled,

      buildArtifactsPresent,

      officialStatus,

      targetProjectRunning,

    });

    const startupSnapshot = targetProjectRunning && !directBridgeReadyForTargetProject

      ? await this.readProjectStartupSnapshot(project, engineInstall?.engineRoot || '')

      : null;

    const windowStateHint = hostProcessRunning && !directBridgeReadyForTargetProject

      ? await this.describeWindowState(project?.pid || hostProcesses[0]?.pid || 0)

      : '';

    const startupHasNoFreshLog = ['log-wait', 'stale-log'].includes(String(startupSnapshot?.phaseKey || '').trim().toLowerCase());

    const startupPhaseKey = String(startupSnapshot?.phaseKey || '').trim().toLowerCase();

    const startupPhaseLabel = String(startupSnapshot?.phaseLabel || '').trim();

    const noTopLevelWindowDetected = /No top-level Unreal window/i.test(String(windowStateHint || ''));

    const startupPhaseBlocked = Boolean(startupSnapshot) && !directBridgeReadyForTargetProject && !['plugin-startup', 'bridge-online'].includes(startupPhaseKey);

    const backgroundResidueDetected = Boolean(pluginInstall.duplicateInstall || Number(pluginInstall.engineShadowCopies || 0) > 0 || staleReceiptFiles.length > 0);

    const configPollutionDetected = Boolean(

      !globalEditorDdcPolicy.keepsEpicLaunchStable

      || !globalEditorStartupPolicy.keepsNoProjectLaunchLight

      || (project && !ddcPolicy.keepsStartupLight)

      || !(officialStatus.remoteControlStartupPolicy?.keepsStartupLight ?? true)

    );

    const startupProbeCategory = backgroundResidueDetected

      ? 'background-residue'

      : startupPhaseBlocked || (hostProcessRunning && !directBridgeReadyForTargetProject && startupHasNoFreshLog)

        ? 'host-stuck'

        : configPollutionDetected

          ? 'config-pollution'

          : directBridgeReadyForTargetProject

            ? 'ready'

            : project || hostProcessRunning

              ? 'waiting'

              : 'unavailable';

    const startupProbeReason = startupProbeCategory === 'background-residue'

      ? pluginInstall.duplicateInstall

        ? 'Duplicate Unreal plugin install scopes are still conflicting.'

        : Number(pluginInstall.engineShadowCopies || 0) > 0

          ? `Unreal is still scanning ${pluginInstall.engineShadowCopies} leftover HMDao engine plugin backup copies.`

          : `The selected project still carries ${staleReceiptFiles.length} stale HMDao target receipt file(s).`

      : startupProbeCategory === 'host-stuck'

        ? startupPhaseLabel

          ? `Unreal startup is still blocked before HMDao direct bridge becomes ready. Current phase: ${startupPhaseLabel}.`

          : 'Unreal host startup is still blocked before the editor becomes connectable.'

        : startupProbeCategory === 'config-pollution'

          ? 'Unreal startup defaults are still heavier than the intended lightweight host-first path.'

          : startupProbeCategory === 'ready'

            ? 'Unreal startup looks healthy.'

            : project

              ? 'Unreal startup is waiting for the selected project/editor session to become connectable.'

              : 'No Unreal project is selected yet.';

    const startupProbeDetail = startupProbeCategory === 'background-residue'

      ? pluginInstall.duplicateInstall

        ? `Project-local and engine-level HMDao plugin installs are both present. Project: ${pluginInstall.projectPluginPath}; engine: ${pluginInstall.enginePluginPath}.`

        : Number(pluginInstall.engineShadowCopies || 0) > 0

          ? `Cleanup should relocate ${pluginInstall.engineShadowCopies} backup plugin copy/copies out of Engine/Plugins scan roots before the next Epic or standalone launch.`

          : `Cleanup should sanitize ${staleReceiptFiles.length} stale target receipt file(s) before the next Unreal launch.`

      : startupProbeCategory === 'host-stuck'

        ? [

            startupPhaseLabel ? `Current phase: ${startupPhaseLabel}.` : '',

            startupHasNoFreshLog ? 'Unreal is not producing a fresh startup log yet.' : '',

            windowStateHint ? `Window state: ${windowStateHint}` : '',

          ].filter(Boolean).join(' ')

        : startupProbeCategory === 'config-pollution'

          ? [

              !globalEditorDdcPolicy.keepsEpicLaunchStable ? 'Global Epic-launch DDC policy is not pinned to a writable lightweight cache.' : '',

              !globalEditorStartupPolicy.keepsNoProjectLaunchLight ? 'No-project startup still prefers the heavier Home Panel path.' : '',

              project && !ddcPolicy.keepsStartupLight ? 'Project DDC defaults are not pinned to the lightweight local writable cache path yet.' : '',

              !(officialStatus.remoteControlStartupPolicy?.keepsStartupLight ?? true) ? 'Remote Control autostart policy is still heavier than the on-demand default.' : '',

            ].filter(Boolean).join(' ')

          : startupProbeCategory === 'ready'

            ? 'The current Unreal install, startup defaults, and project readiness all look compatible with the default lightweight HMDao attach path.'

            : 'Launch Unreal visibly first, then return to HMDao and click Connect after the editor window is responsive.';

    const startupProbe = {

      category: startupProbeCategory,

      reason: startupProbeReason,

      detail: startupProbeDetail,

      phaseKey: startupPhaseKey || '',

      phaseLabel: startupPhaseLabel || '',

      windowState: windowStateHint || '',

      hasNoFreshLog: startupHasNoFreshLog,

    };

    const pathCompatibility = this.buildPathCompatibility(project, engineInstall, pluginInstall);

    const summary = deriveUnrealEnvironmentSummary({

      project,

      pluginInstalled,

      pluginEnabled,

      buildArtifactsPresent,

      directBridgeOnline: effectiveDirectBridgeOnline,

      cameraCount: targetProjectRunning ? cameraCount : 0,

      officialCaptureReady: officialStatus.capturePrerequisitesReady,

      officialMissingCount: officialStatus.missingRequired.length,

      recommendedIntegrationMode: integration.recommendedMode,

    });

    let runtimeAwareSummary = startupProbeCategory === 'config-pollution'

      ? {

        level: 'warning',

        summary: 'Unreal startup defaults are still heavier than the intended lightweight path. Run Quick Check before judging Epic or standalone startup speed.',

      }

      : startupProbeCategory === 'host-stuck'

        ? {

          level: 'warning',

          summary: startupProbeReason,

        }

        : !project

          ? summary

          : !targetProjectRunning

            ? {

              level: 'warning',

              summary: 'A target Unreal project is selected, but Unreal is not running yet. Open Unreal from Epic Games Launcher, load the project into a visible editor window, then return to HMDao and click Connect.',

            }

            : summary;

    if (startupSnapshot && !['plugin-startup', 'bridge-online'].includes(startupSnapshot.phaseKey)) {

      const waitingForPhase = startupSnapshot.phaseKey === 'plugin-mounted'

        ? 'Unreal target project is running, and the HMDao plugin has been mounted, but the module has not started yet.'

        : startupSnapshot.phaseKey === 'turnkey'

          ? 'Unreal target project is running, but editor boot is still finishing heavy startup work after Turnkey.'

          : startupSnapshot.phaseKey === 'editor-tooling'

            ? 'Unreal target project is running, but editor boot is still initializing asset tooling after slow package streaming, so the HMDao module is not ready yet.'

          : startupSnapshot.phaseKey === 'package-streaming'

            ? 'Unreal target project is running, but editor boot is still blocked in package streaming and engine material loads before the HMDao module can start.'

            : 'Unreal target project is running, but startup has not reached the HMDao plugin module yet.';

      const windowClause = startupHasNoFreshLog && windowStateHint

        ? ` Window state: ${windowStateHint}`

        : '';

      runtimeAwareSummary = {

        level: 'warning',

        summary: `${waitingForPhase} Current phase: ${startupSnapshot.phaseLabel}.${windowClause}`,

      };

    }

    if (targetProjectRunning && startupHasNoFreshLog && noTopLevelWindowDetected && !directBridgeReadyForTargetProject) {

      runtimeAwareSummary = {

        level: 'warning',

        summary: 'Unreal target project process exists, but this session still has no visible editor window and no fresh startup log. HMDao cannot connect to this hidden or non-interactive launch. Close that Unreal process, reopen the project into a visible editor window, then click Connect again.',

      };

    }

    if (pluginInstall.duplicateInstall) {

      runtimeAwareSummary = {

        level: 'warning',

        summary: 'HMDao Unreal plugin is installed in both the project and the engine scan paths. Keep only one install scope, otherwise Unreal startup and bridge detection can become inconsistent.',

      };

    } else if (Number(pluginInstall.engineShadowCopies || 0) > 0) {

      runtimeAwareSummary = {

        level: 'warning',

        summary: `Unreal is still scanning ${pluginInstall.engineShadowCopies} HMDao backup plugin copy/copies under Engine/Plugins. Run Cleanup once so startup no longer sees those leftover scan roots.`,

      };

    } else if (staleReceiptFiles.length > 0) {

      runtimeAwareSummary = {

        level: 'warning',

        summary: `The selected project still has ${staleReceiptFiles.length} stale HMDao target receipt file(s). Run Cleanup once so Unreal no longer carries old plugin build residue into startup checks.`,

      };

    } else if (project && hostProcessRunning && !targetProjectRunning) {

      const windowClause = windowStateHint ? ` Window state: ${windowStateHint}` : '';

      runtimeAwareSummary = {

        level: 'warning',

        summary: `Unreal is open, but HMDao is still waiting for the current editor session to finish becoming connectable.${windowClause} Once the visible editor window is fully ready, click Connect again.`,

      };

    }

    const guidedActions = this.buildGuidedActions({

      project,

      engineInstall,

      pluginInstall,

      officialStatus,

      integration,

      pathCompatibility,

    });



    return {

      id: this.id,

      adapter: {

        id: this.adapterId,

        label: this.adapterId,

      },

      label: this.label,

      pluginName: this.pluginName,

      pluginSourcePath: this.pluginSourcePath,

      summary: runtimeAwareSummary.summary,

      level: runtimeAwareSummary.level,

      recommendedAction: !project

        ? 'detect'

        : pluginInstall.duplicateInstall

            ? 'reinstall'

            : Number(pluginInstall.engineShadowCopies || 0) > 0 || staleReceiptFiles.length > 0

              ? 'cleanup'

            : !targetProjectRunning

              ? 'connect'

              : integration.recommendedMode === OFFICIAL_CAPTURE_MODE

                ? officialStatus.capturePrerequisitesReady

                  ? 'ready'

                  : 'install'

                : !pluginInstalled

                  ? 'install'

                  : !pluginEnabled

                    ? 'install'

                    : !buildArtifactsPresent

                      ? 'rebuild'

                      : !directBridgeReadyForTargetProject

                        ? 'connect'

                        : 'ready',

      integration,

      official: {

        ...officialStatus,

        pluginNames: officialStatus.plugins.map((item) => item.name),

      },

      compatibility: pathCompatibility,

      guidance: {

        guidedActions,

        restartRequired: officialStatus.restartRequired,

      },

      host: {

        engineInstalls,
        resolvedEngineRoot: engineInstall?.engineRoot || '',
        resolvedEngineVersion: engineInstall?.version || engineInstall?.label || '',
        hostProcessRunning,
        runningProjectDetected: projects.some((item) => item.running) || targetProjectRunning,

        targetProjectRunning,

        startupProbe,

      },

      project: project ? {

        ...project,

        pid: project.pid || runtimeFallback.targetPid || undefined,

        running: targetProjectRunning,

        pluginPath,

        projectPluginPath: pluginInstall.projectPluginPath,

      } : null,

      projects: projects.map((item) => normalizeKey(item.path) === normalizeKey(project?.path || '')

        ? {

          ...item,

          pid: item.pid || runtimeFallback.targetPid || undefined,

          running: targetProjectRunning,

        }

        : item),

      plugin: {

        installed: pluginInstalled,

        enabledInProject: pluginEnabled,

        buildArtifactsPresent,

        installationScope: pluginInstall.installationScope || null,

        effectivePath: pluginPath || null,

        projectPluginPath: pluginInstall.projectPluginPath || null,

        projectInstalled: Boolean(pluginInstall.projectInstalled),

        enginePluginPath: pluginInstall.enginePluginPath || null,

        engineInstalled: Boolean(pluginInstall.engineInstalled),

        duplicateInstall: Boolean(pluginInstall.duplicateInstall),
        engineShadowCopies: Number(pluginInstall.engineShadowCopies || 0),
        engineShadowCopyPaths: Array.isArray(pluginInstall.engineShadowCopyPaths) ? pluginInstall.engineShadowCopyPaths : [],
        staleTargetReceiptFiles: staleReceiptFiles,
        directBridgeOnline: effectiveDirectBridgeOnline,
        directBridgeReadyForTargetProject,
        directBridgeClientCount: targetProjectRunning ? Number(bridgeState?.clientCount || 0) : 0,
        cameraCount: targetProjectRunning ? cameraCount : 0,
        syncState: pluginSync,
        lastBackup: backups[0] || null,
        backups: backups.slice(0, 5),
      },
      runtime: {

        zen: zenRuntime,

        startupSnapshot,

        windowState: windowStateHint || null,

        memoryPressure,

        ddcPolicy,

        globalEditorDdcPolicy,

        globalEditorStartupPolicy,

      },

      layers: [

        {

          key: 'editor-runtime',

          label: 'Editor process',

          state: hostProcessRunning ? 'ready' : 'warning',

          detail: hostProcessRunning

            ? `Detected ${hostProcesses.length} Unreal Editor process(es).`

            : 'No Unreal Editor process is running right now.',

        },

        {

          key: 'target-project-runtime',

          label: 'Target project runtime',

          state: targetProjectRunning ? 'ready' : 'warning',

          detail: project

            ? targetProjectRunning

              ? `${project.path} is the running target project.`

              : `${project.path} is selected, but it is not the running Unreal project yet.`

            : 'No target Unreal project is selected yet.',

        },

        ...(startupSnapshot ? [{

          key: 'startup-phase',

          label: 'Editor startup phase',

          state: directBridgeReadyForTargetProject ? 'ready' : 'warning',

          detail: `${startupSnapshot.phaseLabel}. Last log update ${Math.round((startupSnapshot.ageMs || 0) / 1000)}s ago from ${path.basename(startupSnapshot.logPath || '') || 'startup log'}.${startupHasNoFreshLog && windowStateHint ? ` ${windowStateHint}` : ''}`,

        }] : []),

        {

          key: 'ddc-zen',

          label: 'DDC / Zen',

          state: zenRuntime.ready ? 'ready' : 'warning',

          detail: zenRuntime.ready

            ? `Zen runtime is reachable on 127.0.0.1:${zenRuntime.port}.`

            : zenRuntime.toolExists

              ? zenRuntime.serviceInstalled

                ? `Zen service exists but is not reachable yet. ${zenRuntime.serviceStatusText || ''}`.trim()

                : 'Zen service is not installed. Connect will preflight Zen automatically before editor launch, and only fall back to memory DDC for that launch if needed.'

              : 'zen.exe was not found under the selected Unreal engine root.',

        },

        {

          key: 'project-ddc-policy',

          label: 'Project DDC policy',

          state: ddcPolicy.keepsStartupLight ? 'ready' : 'warning',

          detail: project

            ? ddcPolicy.keepsStartupLight

              ? `Project config keeps Unreal on a project-local writable DDC path at ${ddcPolicy.localCachePath} and disables Zen autolaunch.`

              : 'Project config is using Unreal\'s own defaults here. HMDao will prefer launch-local fallbacks instead of silently rewriting project startup policy.'
            : 'No target project is selected, so HMDao cannot inspect per-project DDC defaults yet.',

        },

        {

          key: 'engine-launch-ddc-policy',

          label: 'Epic Games / project browser startup',

          state: globalEditorDdcPolicy.keepsEpicLaunchStable ? 'ready' : 'warning',

          detail: globalEditorDdcPolicy.keepsEpicLaunchStable

            ? `Global editor config keeps installed-build Unreal on a writable local cache at ${globalEditorDdcPolicy.localCachePath} even when no project is open.`

            : `Epic Games / no-project Unreal startup is still relying on Unreal's own installed-build DDC policy. HMDao no longer rewrites ${path.basename(globalEditorDdcPolicy.configPath || 'Engine.ini')} automatically; retest Epic startup directly and use launch-local DDC fallback only when needed.`,
        },

        {

          key: 'project-browser-startup-ui',

          label: 'Project browser startup UI',

          state: globalEditorStartupPolicy.keepsNoProjectLaunchLight ? 'ready' : 'warning',

          detail: globalEditorStartupPolicy.keepsNoProjectLaunchLight

            ? 'No-project Unreal startup is pinned to the classic project browser instead of the web Home Panel.'

            : 'No-project Unreal startup still prefers the web Home Panel. HMDao no longer flips this globally, because changing editor startup UI had too much cross-session side effect.',
        },

        {

          key: 'engine-install',

          label: 'Engine install',

          state: engineInstall ? 'ready' : 'warning',

          detail: engineInstall

            ? `${engineInstall.version || engineInstall.label} - ${engineInstall.engineRoot}`

            : 'No matching Unreal Engine installation was detected.',

        },

        {

          key: 'project',

          label: 'Project',

          state: targetProjectRunning ? 'ready' : project ? 'warning' : 'warning',

          detail: project

            ? `${project.path}${project.source === 'hmdao-sidecar' ? ' - HMDao safe sidecar' : ''}`

            : 'No usable .uproject was detected.',

        },

        {

          key: 'path-compatibility',

          label: 'Path compatibility',

          state: 'ready',

          detail: pathCompatibility.summary,

        },

        {

          key: 'official-capture',

          label: 'Compatibility-mode offline export',

          state: officialStatus.capturePrerequisitesReady ? 'ready' : 'warning',

          detail: officialStatus.capturePrerequisitesReady

            ? 'Required built-in plugins are enabled for optional offline export validation.'

            : `Missing: ${officialStatus.missingRequired.map((item) => item.label).join(', ')}`,

        },

        {

          key: 'remote-control',

          label: 'Compatibility-mode camera control',

          state: officialStatus.remoteControlReachable ? 'ready' : 'warning',

          detail: officialStatus.remoteControlReachable

            ? '127.0.0.1:30010 is reachable.'

            : 'Compatibility-mode camera control is offline right now. That can be normal until you explicitly need on-demand camera control.',

        },

        {

          key: 'remote-control-startup-policy',

          label: 'Compatibility camera-control startup policy',

          state: officialStatus.remoteControlStartupPolicy?.keepsStartupLight ? 'ready' : 'warning',

          detail: officialStatus.remoteControlStartupPolicy?.keepsStartupLight

            ? `Project config keeps Remote Control autostart disabled via ${officialStatus.remoteControlStartupPolicy.configPath || 'DefaultRemoteControl.ini'}.`

            : 'Project config still allows Remote Control web server autostart by default. HMDao no longer rewrites DefaultRemoteControl.ini during copy-only install, so adjust it only if you explicitly need compatibility-mode camera control.',

        },

        {

          key: 'pixel-streaming',

          label: 'Compatibility browser preview',

          state: officialStatus.livePreviewReady ? 'ready' : 'warning',

          detail: officialStatus.livePreviewReady

            ? 'Pixel Streaming is enabled for compatibility-mode browser preview.'

            : 'Pixel Streaming stays disabled by default to keep startup light outside compatibility mode.',

        },

        {

          key: 'memory-pressure',

          label: 'System memory headroom',

          state: memoryPressure.constrained ? 'warning' : 'ready',

          detail: memoryPressure.available

            ? memoryPressure.constrained

              ? `Only ${memoryPressure.freeGb.toFixed(1)} GB of ${memoryPressure.totalGb.toFixed(1)} GB RAM is free. Large active processes: ${(memoryPressure.topConsumers || []).filter((item) => Number(item?.workingSetGb || 0) >= 0.35).slice(0, 4).map((item) => `${item.label} (${item.processName}, PID ${item.pid}, ~${item.workingSetGb.toFixed(1)} GB WS)`).join(', ')}.`

              : `${memoryPressure.freeGb.toFixed(1)} GB of ${memoryPressure.totalGb.toFixed(1)} GB RAM is currently free.`

            : 'System memory telemetry is unavailable right now.',

        },

        {

          key: 'startup-interferers',

          label: 'Observed startup overlays',

          state: startupInterferers.length ? 'warning' : 'ready',

          detail: startupInterferers.length

            ? `Detected ${startupInterferers.map((item) => `${item.label} (${item.processName}, PID ${item.pid})`).join(', ')}. They can stretch Unreal startup or first-frame readiness. Keep the default path on HMDao direct bridge, and if Connect feels stalled, prefer a visible host-first Unreal launch before retrying.`

            : 'No common overlay or audio-hook processes known for stretching Unreal startup were detected.',

        },

        {

          key: 'security-hardening',

          label: 'Windows startup hardening',

          state: hasSystemSecurityHardening ? 'warning' : 'ready',

          detail: hasSystemSecurityHardening

            ? `VBS=${securityHardening.vbsStatus || 0}, KernelCI=${securityHardening.kernelCiStatus || 0}, UserCI=${securityHardening.userCiStatus || 0}. This can lengthen first launch and shader warmup time, so focus first on a visible host-first launch and keeping compatibility-mode features off unless you explicitly need them.`

            : 'No elevated VBS or code integrity policy state was detected for this Windows session.',

        },

        {
          key: 'custom-plugin-install',
          label: 'Custom HMDao plugin files',
          state: pluginInstall.duplicateInstall || Number(pluginInstall.engineShadowCopies || 0) > 0 || staleReceiptFiles.length > 0 ? 'warning' : pluginInstalled ? 'ready' : 'warning',

          detail: pluginInstall.duplicateInstall

            ? `Project-local plugin is shadowing the engine-level install. Reinstall to keep only one precompiled engine plugin. Project: ${pluginInstall.projectPluginPath}; engine: ${pluginInstall.enginePluginPath}.`

            : Number(pluginInstall.engineShadowCopies || 0) > 0

              ? `Unreal is still scanning ${pluginInstall.engineShadowCopies} HMDao backup plugin copy/copies under Engine/Plugins. Cleanup or reconnect will relocate them out of the plugin scan root.`

              : staleReceiptFiles.length > 0

                ? `The project still has ${staleReceiptFiles.length} stale target receipt file(s) that reference a removed project-local HMDao plugin copy. Cleanup or reconnect will sanitize them.`

            : pluginInstall.installationScope === 'project' && engineInstall?.engineRoot

              ? `Project-local precompiled HMDao plugin is installed at ${pluginInstall.projectPluginPath}. This copy-only setup supports Chinese / non-ASCII paths and manual enable from the Unreal plugin list; move to one shared engine-level install only if you want to reuse the same plugin across multiple projects.`

            : pluginInstalled
              ? pluginPath
              : 'HMDao custom Unreal plugin is not installed yet.',
        },
        {
          key: 'custom-plugin-sync',
          label: 'Plugin sync',
          state: pluginSync.state,
          detail: pluginSync.summary,
        },
        {
          key: 'custom-plugin-bridge',
          label: 'Custom direct bridge',

          state: directBridgeReadyForTargetProject ? 'ready' : effectiveDirectBridgeOnline ? 'warning' : 'warning',

          detail: directBridgeReadyForTargetProject

            ? `HMDao direct bridge is online with ${cameraCount} camera/view source(s).`

            : effectiveDirectBridgeOnline

              ? targetProjectRunning

                ? 'HMDao direct bridge is online, but Unreal has not returned its camera/view list yet. When no explicit camera is available, HMDao should still fall back to Editor Viewport after query_state completes.'

                : 'A HMDao direct bridge is online, but the selected target project is not the running editor instance yet.'

              : 'Custom direct bridge is optional and currently not ready.',

        },

      ],

      notes: [

        'Default recommendation is the custom direct bridge on top of one shared engine-level precompiled install per Unreal minor version. Use a project-local copy only when you explicitly need isolation or version divergence.',

        'Project-local precompiled plugin copies are supported for copy-only + manual enable, including Chinese / non-ASCII paths. Avoid keeping both project-local and engine-level copies at the same time, otherwise the project copy will shadow the shared engine plugin.',

        'Copy-only install stays read-only and keeps Unreal startup untouched. Repair can now persist the lightweight DDC policy, switch no-project startup to the classic project browser, and reset stale per-version layout state without adding always-on hooks.',

        'Compatibility-mode camera control can stay offline until you explicitly need it; it is no longer treated as a startup health requirement by itself.',

        'Only enable compatibility-mode browser preview if you explicitly need it; otherwise keep startup lighter for editor stability.',

        'Connect launches Unreal without the extra editor console and keeps file logging enabled. If startup still stalls in Turnkey or shader warmup, prefer a visible host-first Unreal launch and then let HMDao send the on-demand connect request into that session.',

        ...(memoryPressure.constrained ? ['Low free RAM can stretch Unreal startup by many minutes even when the editor is still making progress. Restart stale Vite or other heavy dev processes before judging a Connect launch as hung.'] : []),

        ...(startupInterferers.length || hasSystemSecurityHardening ? ['If startup is still abnormally slow, keep compatibility-mode features off, launch Unreal visibly first, and let HMDao attach after the editor window is responsive.'] : []),

        

      ],

      actions: UNREAL_PRIMARY_ACTIONS,

    };

  }



  async runAction(action, options = {}, reporter = null) {

    const normalizedAction = action === 'update' ? 'reinstall' : action;

    if (normalizedAction === 'repair') {

      const [projects, engineInstalls, hostProcesses, startupInterferers, securityHardening] = await Promise.all([
        this.discoverProjectsWithSidecar(),

        discoverUnrealEngineInstalls(),

        discoverRunningProcesses('^UnrealEditor'),
        this.inspectKnownStartupInterferers(),

        this.inspectWindowsSecurityHardening(),

      ]);

      const requestedProjectPath = String(options.projectPath || '').trim();

      const project = projects.find((item) => normalizeKey(item.path) === normalizeKey(requestedProjectPath)) || projects[0] || null;

      const projectPath = requestedProjectPath || project?.path || '';
      const runtimeFallback = await this.inferRuntimeFromFallback(project, hostProcesses);
      const resolvedEngineInstall = this.findEngineInstall(

        engineInstalls,

        project,

        String(options.engineRoot || '').trim(),
        runtimeFallback,
      );

      const engineRoot = resolvedEngineInstall?.engineRoot || '';

      const pluginState = project

        ? await this.resolveInstalledPlugin(project, engineRoot)

        : { installed: false, effectivePath: '', projectPluginPath: '', installationScope: '' };

      const ddcPolicy = { changedCount: 0, policy: await this.inspectProjectDdcPolicy(projectPath) };

      const globalEditorDdcPolicy = { changedCount: 0, policy: await this.inspectGlobalEditorDdcPolicy(engineRoot) };

      const globalEditorStartupPolicy = { changedCount: 0, policy: await this.inspectGlobalEditorStartupPolicy(engineRoot) };

      const remoteControlStartupPolicy = await this.inspectRemoteControlStartupPolicy(projectPath);

      const projectJson = project ? await readJsonFile(project.path, {}) : {};

      let pluginEnabled = Array.isArray(projectJson?.Plugins)

        ? projectJson.Plugins.some((item) => String(item?.Name || '').trim() === UNREAL_PLUGIN_NAME && Boolean(item?.Enabled))

        : false;

      const buildArtifactsPresent = pluginState.installed ? await pathExists(path.join(pluginState.effectivePath, 'Binaries')) : false;

      const staleReceiptFiles = project && !pluginState.projectInstalled

        ? await this.inspectProjectTargetReceiptResidue(project.path)

        : [];

      const bridgeState = this.getBridgeState() || {};

      const targetProjectRunning = Boolean(project?.running);

      const directBridgeOnline = targetProjectRunning && Boolean(bridgeState?.directBridgeOnline);

      const cameraCount = targetProjectRunning ? cameraCountFromBridgeState(bridgeState) : 0;

      const findings = [

        `project=${projectPath || 'missing'}`,

        `engineRoot=${engineRoot || 'missing'}`,

        `pluginInstalled=${pluginState.installed ? 'yes' : 'no'}`,

        `pluginEnabled=${pluginEnabled ? 'yes' : 'no'}`,

        `buildArtifacts=${buildArtifactsPresent ? 'yes' : 'no'}`,

        `duplicateInstall=${pluginState.duplicateInstall ? 'yes' : 'no'}`,

        `engineShadowCopies=${Number(pluginState.engineShadowCopies || 0)}`,

        `staleTargetReceipts=${staleReceiptFiles.length}`,

        `directBridge=${directBridgeOnline ? 'online' : 'offline'}`,

        `cameraCount=${cameraCount}`,

        `startupInterferers=${startupInterferers.length}`,

        `ddcPolicy=${ddcPolicy.policy?.keepsStartupLight ? 'project-local' : 'needs-normalize'}`,

        `globalDdcPolicy=${globalEditorDdcPolicy.policy?.keepsEpicLaunchStable ? 'engine-global' : 'needs-normalize'}`,

        `projectBrowserStartup=${globalEditorStartupPolicy.policy?.keepsNoProjectLaunchLight ? 'classic' : 'home-screen'}`,

        `rcStartup=${remoteControlStartupPolicy?.keepsStartupLight ? 'on-demand' : 'auto'}`,

        `vbs=${securityHardening?.vbsRunning ? 'on' : 'off'}`,

        `kernelCi=${securityHardening?.kernelCiEnforced ? 'enforced' : 'off'}`,

      ];

      if (!engineRoot) {
        reporter?.warn('Completed Unreal quick repair check without an engine root.', { findings });
        return {
          message: `Unreal quick check completed: ${findings.join(', ')}. Select an engine root before install, reinstall, or rebuild.`,

        };

      }

      const safeNormalize = async (key, run, fallback = { changedCount: 0 }) => {

        try {

          return await run();

        } catch (error) {

          const message = error instanceof Error ? error.message : String(error);

          findings.push(`${key}Error=${message}`);

          reporter?.warn('Unreal quick repair skipped a normalization step.', {

            key,

            error: message,

          });

          return fallback;

        }

      };

      let enabledByRepair = false;

      if (pluginState.installed && !pluginEnabled && !targetProjectRunning) {

        const enableResult = await safeNormalize(

          'enableProjectPlugin',

          () => updateUnrealProjectPluginState(projectPath, true),

          { changed: false, changedPlugins: [] },

        );

        if (enableResult?.changed) {

          pluginEnabled = true;

          enabledByRepair = true;

          findings.push('projectPluginEnabledByRepair=yes');

          reporter?.info('Unreal quick repair enabled HMDao Unreal Capture in the project descriptor.', {

            projectPath,

            changedPlugins: enableResult.changedPlugins || [],

          });

        }

      }

      const startupDefaults = await safeNormalize('startupDefaults', () => this.enforceLightweightStartupDefaults(projectPath, engineRoot, reporter), {

        movedShadowCopies: 0,

        sanitizedReceipts: [],

        globalDdcNormalized: 0,

        globalEditorStartupNormalized: 0,

        projectDdcNormalized: 0,

        projectStartupNormalized: 0,

        remoteControlNormalized: 0,

      });

      const refreshedRemoteControlStartupPolicy = await this.inspectRemoteControlStartupPolicy(projectPath);

      const refreshedDdcPolicy = await this.inspectProjectDdcPolicy(projectPath);

      const refreshedGlobalEditorDdcPolicy = await this.inspectGlobalEditorDdcPolicy(engineRoot);

      const refreshedGlobalEditorStartupPolicy = await this.inspectGlobalEditorStartupPolicy(engineRoot);

      findings.push(`shadowCopiesRelocated=${Number(startupDefaults?.movedShadowCopies || 0)}`);

      findings.push(`staleTargetReceiptsSanitized=${Array.isArray(startupDefaults?.sanitizedReceipts) ? startupDefaults.sanitizedReceipts.length : 0}`);

      findings.push(`globalDdcNormalized=${Number(startupDefaults?.globalDdcNormalized || 0)}`);

      findings.push(`projectBrowserStartupNormalized=${Number(startupDefaults?.globalEditorStartupNormalized || 0)}`);

      findings.push(`projectDdcNormalized=${Number(startupDefaults?.projectDdcNormalized || 0)}`);

      findings.push(`projectStartupNormalized=${Number(startupDefaults?.projectStartupNormalized || 0)}`);

      findings.push(`remoteControlNormalized=${Number(startupDefaults?.remoteControlNormalized || 0)}`);

      findings.push(`globalDdcReady=${refreshedGlobalEditorDdcPolicy.keepsEpicLaunchStable ? 'yes' : 'no'}`);

      findings.push(`projectBrowserStartupReady=${refreshedGlobalEditorStartupPolicy.keepsNoProjectLaunchLight ? 'yes' : 'no'}`);

      findings.push(`projectDdcReady=${refreshedDdcPolicy.keepsStartupLight ? 'yes' : 'no'}`);

      const shouldPromoteSharedEngineInstall = Boolean(engineRoot)

        && !targetProjectRunning

        && Boolean(pluginState.projectInstalled)

        && (Boolean(pluginState.duplicateInstall) || !Boolean(pluginState.engineInstalled) || String(pluginState.installationScope || '') !== 'engine');

      if (shouldPromoteSharedEngineInstall) {

        findings.push('engineInstallPromotion=repair-reinstall');

        reporter?.info('Unreal quick repair is promoting HMDao to one shared engine-level precompiled install before the next launch.', {

          projectPath,

          engineRoot,

          installationScope: pluginState.installationScope || '',

        });

        const reinstallResult = await this.runAction('reinstall', {

          ...options,

          projectPath,

          engineRoot,

          installScope: 'engine',

          engineLevel: true,

        }, reporter);

        return {

          message: `${reinstallResult.message} Startup defaults were also normalized for lighter Epic / host-first launch behavior.`,

        };

      }

      if (targetProjectRunning && pluginState.installed && pluginEnabled && buildArtifactsPresent && !directBridgeOnline) {

        const startupSnapshot = await this.readProjectStartupSnapshot(project, engineRoot);

        const runningHostWaitOptions = this.getRunningProjectConnectWaitOptions(project, startupSnapshot);

        await this.writeConnectRequestFile(projectPath, reporter, {

          ttlMs: Math.max(120000, runningHostWaitOptions.timeoutMs + 5 * 60 * 1000),
          targetPid: Number(project?.pid || 0),

        });

        findings.push('repairBridgeRequest=sent');

        reporter?.info('Unreal quick repair requested the running editor session to bring the HMDao direct bridge online.', {

          projectPath,

          pid: project?.pid || 0,

          timeoutMs: runningHostWaitOptions.timeoutMs,

          stallAfterMs: runningHostWaitOptions.stallAfterMs,

          minWaitBeforeStallMs: runningHostWaitOptions.minWaitBeforeStallMs,

          startupPhase: startupSnapshot?.phaseLabel || '',

          phaseLine: startupSnapshot?.phaseLine || '',

        });

        const repairBridgeWait = await this.waitForDirectBridge(reporter, {

          project,

          projectPath,

          engineRoot,

          timeoutMs: runningHostWaitOptions.timeoutMs,

          stallAfterMs: runningHostWaitOptions.stallAfterMs,

          minWaitBeforeStallMs: runningHostWaitOptions.minWaitBeforeStallMs,

        });

        findings.push(`repairBridgeReady=${repairBridgeWait.ok ? 'yes' : 'no'}`);

        if (repairBridgeWait.ok) {

          reporter?.info('Unreal quick repair brought the HMDao direct bridge online in the running target project.', {

            projectPath,

            pid: project?.pid || 0,

            waitedMs: repairBridgeWait.waitedMs,

            cameraCount: repairBridgeWait.cameraCount,

          });

          return {

            message: `Unreal quick repair completed: ${findings.join(', ')}. The running Unreal Editor accepted the HMDao connect request and direct bridge is now online for ${projectPath}.`,

          };

        }

      }

      const zenProbe = await probeTcp(this.getZenLaunchConfig().port, '127.0.0.1', 500);

      const zenAction = 'probe-only';

      findings.push(`zen=${zenProbe ? 'ready' : 'offline'}`);

      findings.push(`zenAction=${zenAction}`);

      reporter?.info('Completed Unreal quick repair check.', { findings });

      if (pluginState.duplicateInstall) {

        return {

          message: `Unreal quick check completed: ${findings.join(', ')}. A project-local HMDao plugin is shadowing the engine-level install; use Reinstall to keep only one shared precompiled engine plugin.`,

        };

      }

      if (Number(pluginState.engineShadowCopies || 0) > 0 || staleReceiptFiles.length > 0) {

        return {

          message: `Unreal quick check completed: ${findings.join(", ")}. Cleanup is recommended before the next launch because Unreal still sees ${Number(pluginState.engineShadowCopies || 0)} backup plugin scan root(s) and ${staleReceiptFiles.length} stale HMDao target receipt file(s).`,

        };

      }

      if (startupInterferers.length) {

        return {

          message: `Unreal quick check completed: ${findings.join(', ')}. Observed startup overlays or hooks: ${startupInterferers.map((item) => `${item.label} (${item.processName})`).join(', ')}. Keep compatibility-mode features off, and if Connect still feels stalled, prefer a visible host-first Unreal launch before retrying.`,

        };

      }

      if (securityHardening?.vbsRunning || securityHardening?.kernelCiEnforced || securityHardening?.userCiEnforced) {

        return {

          message: `Unreal quick check completed: ${findings.join(', ')}. Windows VBS / code integrity hardening is active. This can lengthen first launch and shader warmup time, so keep compatibility-mode features off unless you explicitly need them.`,

        };

      }

      if (!refreshedRemoteControlStartupPolicy?.keepsStartupLight) {

        return {

          message: `Unreal quick check completed: ${findings.join(', ')}. Compatibility-mode camera control is still allowed to autostart from project config. Run Connect once or reinstall the project integration to normalize DefaultRemoteControl.ini so it stays on-demand by default.`,

        };

      }

      if (!refreshedGlobalEditorDdcPolicy.keepsEpicLaunchStable) {

        return {

          message: `Unreal quick check completed: ${findings.join(', ')}. HMDao did not rewrite the global Epic-launch DDC policy; the editor still does not present a stable writable local cache on its own. Reopen Epic Launcher and retest UE standalone startup before Connect.`,
        };

      }

      if (!refreshedDdcPolicy.keepsStartupLight) {

        return {

          message: `Unreal quick check completed: ${findings.join(', ')}. HMDao already tried to normalize the project DDC defaults, but the project still does not look light enough for a clean host-first launch.`,

        };

      }

      if (!refreshedGlobalEditorStartupPolicy.keepsNoProjectLaunchLight) {

        return {

          message: `Unreal quick check completed: ${findings.join(', ')}. HMDao already tried to switch no-project startup to the classic project browser, but the effective user config still prefers the web Home Panel. Reset the per-version WindowsEditor layout files once, then retest a standalone Unreal launch before Connect.`,

        };

      }

      if (pluginState.installed && pluginEnabled && !buildArtifactsPresent) {

        return {

          message: `Unreal quick check completed: ${findings.join(', ')}. Plugin binaries are missing; use Rebuild explicitly instead of running a heavy repair automatically.`,

        };

      }

      if (!pluginState.installed || !pluginEnabled) {

        return {

          message: `Unreal quick check completed: ${findings.join(', ')}. Use Install to prepare the recommended precompiled plugin layout when you are ready, then enable HMDao Unreal Capture from the Unreal plugin list.`,

        };

      }

      if (enabledByRepair) {

        return {

          message: `Unreal quick check completed: ${findings.join(', ')}. HMDao Unreal Capture has been enabled in the project descriptor. Restart Unreal once, then reconnect from the DCC node to bring the direct bridge online.`,

        };

      }

      return {

        message: `Unreal quick check completed: ${findings.join(', ')}. No heavy repair was triggered.`,

      };

    }



    const status = await this.getStatus();

    const projects = Array.isArray(status.projects) ? status.projects : [];

    const projectPath = String(options.projectPath || '').trim() || status.project?.path || projects[0]?.path || '';

    const project = projects.find((item) => normalizeKey(item.path) === normalizeKey(projectPath)) || status.project || null;

    const resolvedEngineInstall = this.findEngineInstall(

      status.host.engineInstalls || [],

      project,

      String(options.engineRoot || '').trim(),
      normalizeKey(project?.path || '') === normalizeKey(status.project?.path || '')
        ? { targetEngineRoot: String(status.host?.resolvedEngineRoot || '').trim() }
        : null,
    );

    const engineRoot = resolvedEngineInstall?.engineRoot || '';

    const integrationMode = this.resolveRequestedIntegrationMode(options, status.integration?.recommendedMode || CUSTOM_CAPTURE_MODE);

    const pluginState = status.plugin || {};



    if (normalizedAction === 'cleanup') {

      const removedCount = await this.cleanupRuntimeFiles(reporter);

      const startupDefaults = await this.enforceLightweightStartupDefaults(projectPath, engineRoot, reporter);

      const sanitizedReceiptCount = Array.isArray(startupDefaults.sanitizedReceipts) ? startupDefaults.sanitizedReceipts.length : 0;

      return {

        message: `Unreal cleanup completed: runtimeRemoved=${removedCount}, legacyTempResidueRemoved=${Number(startupDefaults.removedLegacySidecarResidue || 0)}, shadowCopiesRelocated=${Number(startupDefaults.movedShadowCopies || 0)}, staleTargetReceiptsSanitized=${sanitizedReceiptCount}, globalDdcNormalized=${Number(startupDefaults.globalDdcNormalized || 0)}, projectBrowserStartupNormalized=${Number(startupDefaults.globalEditorStartupNormalized || 0)}, projectDdcNormalized=${Number(startupDefaults.projectDdcNormalized || 0)}, projectStartupNormalized=${Number(startupDefaults.projectStartupNormalized || 0)}. HMDao now leaves Unreal startup policy unchanged unless a future flow explicitly opts into a config rewrite.`,
      };

    }



    if (!projectPath) {

      throw new Error('No Unreal project was detected. Select or open a .uproject first.');

    }



    if (normalizedAction === 'connect') {

      const bridgeState = this.getBridgeState() || {};

      const currentCameraCount = cameraCountFromBridgeState(bridgeState);

      const hostProcessRunning = Boolean(status?.host?.hostProcessRunning);

      const targetProjectRunning = Boolean(project?.running || status?.host?.targetProjectRunning);

      if (targetProjectRunning && bridgeState.directBridgeOnline && currentCameraCount > 0) {
        return {
          message: 'HMDao Unreal Capture is already online and streaming real camera data.',
        };
      }
      if (hostProcessRunning && !targetProjectRunning) {
        throw new Error('Unreal is already open, but HMDao still cannot confirm that the visible editor session is ready for connection. Wait for the editor window to finish loading, then click Connect again.');
      }


      if (integrationMode !== CUSTOM_CAPTURE_MODE) {

        const official = status.official || {};

        if (!official.capturePrerequisitesReady) {

          const missing = Array.isArray(official.missingRequired)

            ? official.missingRequired.map((item) => item.label).join(', ')

            : 'compatibility-mode offline export prerequisites';

          throw new Error(`Compatibility-mode offline export is not ready yet. Enable these project plugins first: ${missing}.`);

        }

        reporter?.info('Compatibility-mode Unreal capture selected. Skipping risky direct-bridge launch flow.', {

          projectPath,

          integrationMode,

          remoteControlReachable: Boolean(official.remoteControlReachable),

          restartRequired: Boolean(official.restartRequired),

        });

        return {

          message: official.remoteControlReachable

            ? 'Compatibility-mode offline export prerequisites are ready, and compatibility camera control is reachable if you need it.'

            : 'Compatibility-mode offline export prerequisites are ready. Compatibility camera control can stay offline until you explicitly need it.',

          integrationMode,

          restartRequired: Boolean(official.restartRequired),

          guidedSteps: official.guidedSteps || [],

        };

      }



      const isSafeSidecarProject = this.isSafeSidecarProject(project);

      if (isSafeSidecarProject) {

        await this.normalizeSafeSidecarStartupState(reporter);

      }

      if (hostProcessRunning) {

        if (!isSafeSidecarProject) {

          const startupSnapshot = await this.readProjectStartupSnapshot(project, engineRoot);

          const runningHostWaitOptions = this.getRunningProjectConnectWaitOptions(project, startupSnapshot);

          await this.writeConnectRequestFile(projectPath, reporter, {

            ttlMs: runningHostWaitOptions.timeoutMs + 5 * 60 * 1000,
            targetPid: Number(project?.pid || 0),

          });

          reporter?.info('Waiting for the running Unreal target project to finish startup and accept the HMDao direct bridge request.', {

            projectPath,

            pid: project.pid || 0,

            timeoutMs: runningHostWaitOptions.timeoutMs,

            stallAfterMs: runningHostWaitOptions.stallAfterMs,

            minWaitBeforeStallMs: runningHostWaitOptions.minWaitBeforeStallMs,

            uptimeMs: runningHostWaitOptions.uptimeMs,

            startupPhase: startupSnapshot?.phaseLabel || '',

            phaseLine: startupSnapshot?.phaseLine || '',

          });

          const runningHostWait = await this.waitForDirectBridge(reporter, {

            project,

            projectPath,

            engineRoot,

            timeoutMs: runningHostWaitOptions.timeoutMs,

            stallAfterMs: runningHostWaitOptions.stallAfterMs,

            minWaitBeforeStallMs: runningHostWaitOptions.minWaitBeforeStallMs,

          });

          if (runningHostWait.ok) {

            return {

              message: 'The running Unreal Editor accepted the HMDao on-demand connect request. Direct bridge is ready for ' + projectPath + '.',

            };

          }

          const shouldSuggestFreshFallbackRelaunch = await this.shouldRetryWithD3D11Fallback({

            startupSnapshot: runningHostWait?.startupSnapshot,

            logPath: runningHostWait?.startupSnapshot?.logPath || '',

            waitedMs: runningHostWait?.waitedMs || 0,

            phaseStableMs: runningHostWait?.phaseStableMs || 0,

          });

          throw new Error(shouldSuggestFreshFallbackRelaunch

            ? 'The running Unreal Editor is still stuck before the HMDao module comes online: ' + projectPath + '. Restart Unreal manually from Epic Games Launcher, wait for the visible editor window, and then click Connect again.'

            : 'The running Unreal Editor is open, but HMDao direct bridge is still offline: ' + projectPath + '. Wait for the visible editor window to finish loading, confirm the latest HMDao Unreal Capture plugin is enabled, and then click Connect again.');

        }



        reporter?.info('HMDao safe sidecar is already running. Waiting for the existing sidecar startup to finish before restarting it.', {

          projectPath,

          pid: project.pid || 0,

        });

        const existingRun = await this.waitForDirectBridge(reporter, {

          project,

          projectPath,

          engineRoot,

          timeoutMs: 900000,

          stallAfterMs: 420000,

          minWaitBeforeStallMs: 600000,

        });

        if (existingRun.ok) {

          reporter?.info('Unreal direct bridge is online from the existing HMDao safe sidecar.', {

            projectPath,

            pid: project.pid || 0,

            waitedMs: existingRun.waitedMs,

            cameraCount: existingRun.cameraCount,

          });

          return {

            message: `Unreal Editor is online and HMDao direct bridge is ready. Reused running safe sidecar PID: ${project.pid || 'unknown'}.`,

          };

        }



        if (existingRun.stalled) {

          reporter?.warn('Existing HMDao safe sidecar startup appears stalled before the direct bridge came online. Restarting it automatically.', {

            projectPath,

            pid: project.pid || 0,

            startupPhase: existingRun.startupSnapshot?.phaseLabel || '',

            phaseLine: existingRun.startupSnapshot?.phaseLine || '',

          });

        }



        await this.stopSafeSidecar(project, reporter);

      }



      if (!engineRoot) {

        throw new Error(`No matching Unreal Engine installation was found for ${projectPath}. Select an engine root first.`);

      }



      await this.enforceLightweightStartupDefaults(projectPath, engineRoot, reporter, {

        normalizeProjectStartup: true,

        projectStartupOptions: {

          normalizeDdcPolicy: false,

        },

      });



      const editorExecutable = this.resolveEditorExecutable(engineRoot);

      if (!await pathExists(editorExecutable)) {

        throw new Error(`UnrealEditor.exe was not found: ${editorExecutable}`);

      }



      // Prefer the normal writable DDC graph, but preflight Zen/DDC and only

      // fall back to an in-memory cache when recent logs prove the writable

      // cache graph is unavailable.

      const ddcLaunchStrategy = await this.prepareDdcLaunchStrategy({

        projectPath,

        engineRoot,

        reporter,

      });

      const launchLogPath = this.getHmdaoLaunchLogPath({ path: projectPath });

      const fallbackStartupLogPath = this.getSidecarLogPath({ path: projectPath });

      await fs.mkdir(path.dirname(launchLogPath), { recursive: true }).catch(() => {});

      await removeIfExists(launchLogPath);

      if (normalizeKey(fallbackStartupLogPath) !== normalizeKey(launchLogPath)) {

        await removeIfExists(fallbackStartupLogPath);

      }

      const launchProfiles = [

        {

          id: 'default',

          label: 'default RHI profile',

          extraArgs: [],

        },

        {
          id: 'd3d11-fallback',
          label: 'lightweight D3D11 fallback',
          extraArgs: D3D11_FALLBACK_EXTRA_ARGS,
        },
      ];

      const maxLaunchAttempts = launchProfiles.length;

      let launchResult = null;

      let launchWait = null;



      for (let attempt = 1; attempt <= maxLaunchAttempts; attempt += 1) {

        const launchProfile = launchProfiles[Math.min(attempt - 1, launchProfiles.length - 1)];

        const launchArgs = this.buildDirectBridgeLaunchArgs(

          projectPath,

          launchLogPath,

          ddcLaunchStrategy.extraArgs,

          launchProfile,

          {

            hideSplash: false,

            showEditorConsole: false,

          },

        );

        await this.writeConnectRequestFile(projectPath, reporter, {

          ttlMs: 35 * 60 * 1000,

        });

        reporter?.info('Launching Unreal Editor for HMDao direct bridge.', {

          projectPath,

            engineRoot,

            editorExecutable,

            launchArgs,

            launchProfile: launchProfile.label,

            ddcFallbackMode: ddcLaunchStrategy.fallbackMode,

            attempt,

          });

        const launchStartedAtMs = Date.now();

        launchResult = await launchWindowsProcessViaStartProcess(editorExecutable, launchArgs, {

          cwd: path.dirname(editorExecutable),

          windowsHide: false,

        });

        if (!launchResult.ok) {

          throw new Error(String(launchResult.error || '').includes('background launch disabled')
            ? `Unreal is not running yet. To keep startup predictable, HMDao will wait for you to open ${projectPath} in the visible Unreal Editor first. Once the editor window is fully open, click Connect again.`
            : `Failed to launch Unreal Editor: ${launchResult.error || 'unknown error'}`);
        }



        const isDefaultRhiAttempt = launchProfile.id === 'default';

        launchWait = await this.waitForDirectBridge(reporter, {

          project: { path: projectPath, pid: launchResult.pid, running: true, startedAtMs: launchStartedAtMs },

          projectPath,

          engineRoot,

          timeoutMs: 1800000,

          stallAfterMs: isDefaultRhiAttempt ? 180000 : 420000,

          minWaitBeforeStallMs: isDefaultRhiAttempt ? 240000 : 600000,

        });

        if (launchWait.ok) break;



        const shouldRetryWithD3D11 = attempt < maxLaunchAttempts

          && launchProfile.id === 'default'

          && await this.shouldRetryWithD3D11Fallback({

            startupSnapshot: launchWait?.startupSnapshot,

            logPath: launchWait?.startupSnapshot?.logPath || launchLogPath,

            waitedMs: launchWait?.waitedMs || 0,

            phaseStableMs: launchWait?.phaseStableMs || 0,

          });

        if (shouldRetryWithD3D11) {

          reporter?.warn('Unreal Editor stalled before the HMDao bridge came online while using the default RHI path. Retrying once with a lighter D3D11 fallback profile.', {

            projectPath,

            pid: launchResult.pid,

            startupPhase: launchWait?.startupSnapshot?.phaseLabel || '',

            phaseLine: launchWait?.startupSnapshot?.phaseLine || '',

          });

          await stopWindowsProcessTree(launchResult.pid);

          await sleep(2000);

          continue;

        }



        if (!(isSafeSidecarProject && launchWait.stalled && attempt < maxLaunchAttempts)) {

          break;

        }



        reporter?.warn('Fresh HMDao safe sidecar startup stalled before the direct bridge came online. Restarting once automatically.', {

          projectPath,

          pid: launchResult.pid,

          startupPhase: launchWait.startupSnapshot?.phaseLabel || '',

          phaseLine: launchWait.startupSnapshot?.phaseLine || '',

        });

        await this.stopSafeSidecar({ path: projectPath, pid: launchResult.pid }, reporter);

      }



      if (!launchWait?.ok) {

        const startupPhase = launchWait?.startupSnapshot?.phaseLabel || 'unknown phase';

        const startupHint = await this.describeLikelyStartupBlocker(projectPath, engineRoot);

        const windowHint = await this.describeWindowState(launchResult?.pid || 0);

        const combinedHint = [startupHint, windowHint].filter(Boolean).join(' ');

        if (launchWait?.exited) {

          throw new Error(`Unreal Editor exited before HMDao direct bridge came online. Last startup phase: ${startupPhase}.${combinedHint ? ` ${combinedHint}` : ' Check Saved/Crashes and Environment Manager logs before retrying Connect.'}`);

        }

        if (launchWait?.noFreshLog) {

          throw new Error(`Unreal Editor did not produce a fresh startup log within 60 seconds. Last startup phase: ${startupPhase}.${combinedHint ? ` ${combinedHint}` : ' This usually means the editor is blocked before normal initialization or launched into a hidden/non-interactive state.'}`);

        }

        if (launchWait?.stalled) {

          throw new Error(`Unreal Editor startup stalled before HMDao direct bridge came online. Last startup phase: ${startupPhase}.${combinedHint ? ` ${combinedHint}` : ' Check Environment Manager logs for the exact Unreal startup phase and last log line.'}`);

        }

        throw new Error(`Unreal Editor started, but HMDao direct bridge did not come online within 15 minutes. Last startup phase: ${startupPhase}.`);

      }



      reporter?.info('Unreal direct bridge is online.', {

        pid: launchResult?.pid || 0,

        projectPath,

        engineRoot,

        waitedMs: launchWait.waitedMs,

        cameraCount: launchWait.cameraCount,

      });

      return {

        message: `Unreal Editor is online and HMDao direct bridge is ready. Launch PID: ${launchResult?.pid || 0}.`,

      };

    }



    if (normalizedAction === 'rollback') {

      reporter?.info('Rolling back Unreal plugin environment.', { projectPath });

      const backupItem = (await listBackups(this.backupRoot, this.id))[0];

      if (!backupItem) {

        throw new Error('No Unreal backup is available for rollback.');

      }

      await restoreBackupRecord(backupItem);

      reporter?.info('Unreal plugin environment rolled back.', { projectPath, backupId: backupItem.id });

      return {

        message: `Rolled back Unreal project plugin state: ${projectPath}`,

        backupId: backupItem.id,

      };

    }



    const backup = await backupUnrealState(this.backupRoot, normalizedAction, projectPath, {

      enginePluginPaths: this.getEnginePluginCandidatePaths(engineRoot),

    });

    reporter?.info('Created Unreal environment backup.', { projectPath, backupId: backup.id, action: normalizedAction });



    try {

      if (normalizedAction === 'remove') {

        await removeIfExists(path.join(path.dirname(projectPath), 'Plugins', UNREAL_PLUGIN_NAME));

        for (const candidatePath of this.getEnginePluginCandidatePaths(engineRoot)) {

          await removeIfExists(candidatePath);

        }

        await updateUnrealProjectPluginState(projectPath, false);

        reporter?.info('Removed Unreal plugin files.', { projectPath });

        return {

          message: `Removed ${UNREAL_PLUGIN_FRIENDLY_NAME} from ${projectPath}.`,

          backupId: backup.id,

        };

      }



      if (normalizedAction === 'install-official' && integrationMode !== CUSTOM_CAPTURE_MODE) {

        const shouldEnableLivePreview = integrationMode === OPTIONAL_LIVE_PREVIEW_MODE || Boolean(options.enablePixelStreaming);

        const pluginStates = UNREAL_OFFICIAL_PLUGIN_REQUIREMENTS

          .filter((item) => item.required || (shouldEnableLivePreview && item.name === 'PixelStreaming'))

          .map((item) => ({ name: item.name, enabled: true }));

        const changeSet = await applyProjectPluginStates(projectPath, pluginStates);

        reporter?.info('Enabled compatibility-mode Unreal plugins in the project descriptor.', {

          projectPath,

          integrationMode,

          changedPlugins: changeSet.changedPlugins,

          shouldEnableLivePreview,

        });

        return {

          message: changeSet.changed

            ? `Enabled compatibility-mode Unreal plugins for ${path.basename(projectPath)}. Restart Unreal once, then use compatibility mode only when you explicitly need offline export validation or browser-preview fallback.`

            : `Compatibility-mode Unreal plugins were already enabled for ${path.basename(projectPath)}. If Unreal was open, restart it once before final compatibility validation.`,

          backupId: backup.id,

          integrationMode,

          restartRequired: true,

          changedPlugins: changeSet.changedPlugins,

        };

      }



      const requestedInstallScope = String(options.installScope || '').trim().toLowerCase();

      const installScope = requestedInstallScope === 'project' && options.engineLevel !== true

        ? 'project'

        : engineRoot

          ? 'engine'

          : 'project';

      if (installScope === 'engine' && !engineRoot) {

        throw new Error(`No matching Unreal Engine installation was found for ${projectPath}. Engine-level precompiled install requires a valid engine root.`);

      }

      const explicitPrecompiledPackagePath = String(
        options.precompiledPackagePath || options.precompiledPackageRoot || ''
      ).trim();

      const forceBuild = normalizedAction === 'rebuild' || options.build === true;
      if (explicitPrecompiledPackagePath && forceBuild) {
        throw new Error('Do not request a rebuild while also supplying an external precompiled HMDao Unreal package. Use one packaged plugin source of truth at a time.');
      }

      // --- Keep ONLY the latest install: remove the stale opposite-scope copy ---
      // Reinstall / Rebuild always write the freshest plugin source into the chosen
      // scope, so any install found in the OTHER scope is by definition the old
      // version. Delete it so the environment ends up with exactly one, newest copy
      // (the project-local vs engine-level duplicate no longer triggers warnings).
      const preInstallState = project
        ? await this.resolveInstalledPlugin(project, engineRoot)
        : {
            installed: false,
            projectInstalled: false,
            engineInstalled: false,
            projectPluginPath: '',
            enginePluginPath: '',
            duplicateInstall: false,
          };

      const staleRemoval = { removedPath: '', reason: '' };
      if (preInstallState.duplicateInstall || preInstallState.duplicateInstallStructural) {
        const stalePath = installScope === 'engine'
          ? preInstallState.projectPluginPath
          : preInstallState.enginePluginPath;
        if (stalePath && await pathExists(stalePath)) {
          try {
            await removeIfExists(stalePath);
            staleRemoval.removedPath = stalePath;
            staleRemoval.reason = installScope === 'engine'
              ? '已删除项目级旧副本，仅保留引擎级最新安装'
              : '已删除引擎级旧副本，仅保留项目级最新安装';
            reporter?.info('Unreal plugin reinstall removed the stale opposite-scope install.', {
              installScope,
              removedPath: stalePath,
            });
          } catch (removeError) {
            reporter?.warn('Unreal plugin reinstall could not delete the stale opposite-scope copy (likely locked by a running Unreal Editor). The new copy was still installed.', {
              stalePath,
              error: removeError instanceof Error ? removeError.message : String(removeError),
            });
          }
        }
      }

      const args = ['-UProject', projectPath, '-InstallScope', installScope];

      if (engineRoot) args.push('-EngineRoot', engineRoot);
      if (explicitPrecompiledPackagePath) args.push('-PrecompiledPackage', explicitPrecompiledPackagePath);

      if (forceBuild && engineRoot) args.push('-Build');



      reporter?.info('Running Unreal plugin install script.', { projectPath, engineRoot, installScope, explicitPrecompiledPackagePath, args, normalizedAction, forceBuild });
      const scriptResult = await runPowerShellFile(this.installScriptPath, args);

      if (!scriptResult.ok) {
        const rawDetail = summarizeCommandResult(scriptResult, '');
        const staleHintPath = installScope === 'engine'
          ? path.join(path.dirname(projectPath), 'Plugins', UNREAL_PLUGIN_NAME)
          : (this.getEnginePluginCandidatePaths(engineRoot)[0] || 'Engine/Plugins/Marketplace/HMDaoUnrealCapture');
        // Localize the most common raw English error fragments so the panel stays Chinese.
        const lockedByEditor = /EPERM|operation not permitted|unlink|being used by another process/i.test(rawDetail);
        const localizedDetail = rawDetail
          .replace(/EPERM: operation not permitted, unlink '([^']+)'/gi, '文件被占用，无法删除：$1')
          .replace(/EPERM/gi, '权限不足（文件被占用）')
          .replace(/operation not permitted/gi, '操作不被允许（文件可能被占用）')
          .replace(/The process cannot access the file because it is being used by another process\./gi, '该文件正被另一个进程占用，无法访问。')
          .replace(/unlink '([^']+)'/gi, '删除文件失败：$1');
        const lockHint = lockedByEditor
          ? '\n⚠️ 检测到插件 DLL 被 Unreal 编辑器占用（文件锁定）。请先在任务管理器确认已无 UnrealEditor.exe 进程，再重新点击“重建/重装”。\n'
          : '';
        throw new Error(
          `${UNREAL_PLUGIN_FRIENDLY_NAME} ${normalizedAction} 失败。请按以下步骤排查后重试：\n` +
          `1. 完全关闭 Unreal 编辑器（任务管理器确认无 UnrealEditor.exe 进程），避免文件被占用。\n` +
          `2. 若面板仍提示“两份安装并存”，请手动删除其中一份旧副本：` +
          (installScope === 'engine' ? `项目目录下的 ${staleHintPath}` : `引擎目录下的 ${staleHintPath}`) + `。\n` +
          `3. 在 DCC 环境管理面板先执行一次 Cleanup（清理引擎备份副本与残留 receipt），再重新点击“重建/重装”。\n` +
          `4. 确认引擎路径正确（当前引擎根：${engineRoot || '未检测到'}）。\n` +
          `5. 若仍失败，查看以下日志：\n${lockHint}${localizedDetail}`
        );
      }



      reporter?.info('Unreal plugin install script completed.', { projectPath, engineRoot, installScope });
      // Relocate any leftover engine shadow copies and sanitize stale target
      // receipts so the environment no longer reports an old/duplicate install.
      let postCleanup = null;
      try {
        postCleanup = await this.enforceLightweightStartupDefaults(projectPath, engineRoot, reporter);
      } catch (cleanupError) {
        reporter?.warn('Unreal plugin reinstall finished, but startup-residue cleanup could not run.', {
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }

      const keptScopeLabel = installScope === 'engine' ? '引擎级' : '项目级';
      const keptInstallPath = installScope === 'engine'
        ? (this.getEnginePluginCandidatePaths(engineRoot)[0] || '')
        : path.join(path.dirname(projectPath), 'Plugins', UNREAL_PLUGIN_NAME);
      const staleText = staleRemoval.removedPath
        ? `，并已删除旧版本副本（${staleRemoval.removedPath}）`
        : (preInstallState.duplicateInstall || preInstallState.duplicateInstallStructural
          ? '（另一份旧副本被占用未能删除，请重启 Unreal 后手动删除，再执行一次 Cleanup）'
          : '');
      const buildText = forceBuild
        ? '新插件已使用 UnrealBuildTool 重新编译。'
        : '已部署最新预编译插件。';

      reporter?.info('Unreal plugin reinstall completed with a single latest install kept.', {
        installScope,
        keptInstallPath,
        removedStalePath: staleRemoval.removedPath || '',
      });

      return {
        message: `重建/重装成功：${buildText}已保留最新的${keptScopeLabel}插件安装（${keptInstallPath}）${staleText}。请重启 Unreal 编辑器使最新插件生效，然后在 DCC 环境管理面板点击“连接”验证桥接。`,
        backupId: backup.id,

        integrationMode,
        restartRequired: true,

        keptInstallPath,
        removedStalePath: staleRemoval.removedPath || '',
        cleanup: postCleanup
          ? {
            movedShadowCopies: Number(postCleanup.movedShadowCopies || 0),
            sanitizedReceipts: Array.isArray(postCleanup.sanitizedReceipts) ? postCleanup.sanitizedReceipts.length : 0,
          }
          : null,
      };

    } catch (error) {

      reporter?.error('Unreal plugin action failed, restoring backup.', {

        projectPath,

        backupId: backup.id,

        error: error instanceof Error ? error.message : String(error),

      });

      const backups = await listBackups(this.backupRoot, this.id);

      const restoreTarget = backups.find((item) => item.id === backup.id);

      if (restoreTarget) await restoreBackupRecord(restoreTarget);

      throw error;

    }

  }

}











































