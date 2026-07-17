import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  BLENDER_PLUGIN_FRIENDLY_NAME,
  BLENDER_PLUGIN_NAME,
  backupBlenderState,
  discoverRunningProcesses,
  deriveBlenderStateSummary,
  discoverBlenderInstallations,
  discoverBlenderVersions,
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
  stopWindowsProcessTree,
  normalizeLineBreaks,
  summarizeCommandResult,
  waitForCondition,
} from './shared.mjs';

const BLENDER_REQUEST_FILE = path.join(os.tmpdir(), 'hmdao_blender_capture.request.json');
const BLENDER_STATUS_FILE = path.join(os.tmpdir(), 'hmdao_blender_capture.status.json');
const BLENDER_PYTHON_PROBE_FILE = path.join(os.tmpdir(), 'hmdao_blender_probe.txt');
const BLENDER_BACKGROUND_OPENGL_ARGS = ['--gpu-backend', 'opengl'];
const BLENDER_STATUS_STALE_MS = 15_000;

const BLENDER_PLUGIN_SOURCE_VERSION_RE = /PLUGIN_VERSION\s*=\s*["']([^"']+)["']/;

function extractBlenderPluginVersion(sourceText = '') {
  const match = String(sourceText || '').match(BLENDER_PLUGIN_SOURCE_VERSION_RE);
  return match?.[1]?.trim() || '';
}

export class BlenderPluginAdapter {
  constructor({
    repoRoot,
    backupRoot,
    installScriptPath = path.join(repoRoot, 'scripts', 'dcc', 'install-blender-plugin.ps1'),
    connectScriptPath = path.join(repoRoot, 'scripts', 'dcc', 'start-blender-capture-headless.py'),
  }) {
    this.id = 'blender';
    this.label = 'Blender';
    this.pluginName = BLENDER_PLUGIN_FRIENDLY_NAME;
    this.adapterId = 'BlenderPluginAdapter';
    this.repoRoot = repoRoot;
    this.backupRoot = backupRoot;
    this.installScriptPath = installScriptPath;
    this.connectScriptPath = connectScriptPath;
    this.pluginSourcePath = path.join(repoRoot, 'plugins', 'blender', BLENDER_PLUGIN_NAME);
  }

  async readPluginSourceVersion() {

    const sourceFile = path.join(this.pluginSourcePath, '__init__.py');

    const text = await fs.readFile(sourceFile, 'utf8').catch(() => '');

    return extractBlenderPluginVersion(text);

  }

  isHmdaoHeadlessProcess(processInfo = {}) {
    const commandLine = String(processInfo?.commandLine || '').toLowerCase();
    return commandLine.includes('start-blender-capture-headless.py')
      || (commandLine.includes('--background') && commandLine.includes('hmdao_blender_capture'));
  }

  describeLockedAddonMessage(errorText = '', targets = []) {
    const normalized = String(errorText || '');
    if (/HMDao Blender Capture files .*Blender/i.test(normalized)) {
      return normalizeLineBreaks(normalized).split('\\n')[0] || normalized;
    }
    if (!/EPERM|access is denied|being used by another process|operation not permitted/i.test(normalized)) {
      return '';
    }
    if (!/hmdao_blender_capture|__init__\\.py/i.test(normalized)) {
      return '';
    }
    const versions = Array.isArray(targets)
      ? targets.map((item) => String(item?.version || '').trim()).filter(Boolean)
      : [];
    const versionHint = versions.length ? ` Blender ${versions.join(', ')}` : ' Blender';
    return `${BLENDER_PLUGIN_FRIENDLY_NAME} files are currently locked by a running${versionHint} session. Restart Blender, or disable and re-enable HMDao Blender Capture in Preferences > Add-ons, then retry Repair or Reinstall.`;
  }

  isVisibleBlenderUiProcess(processInfo = {}) {
    if (this.isHmdaoHeadlessProcess(processInfo)) return false;
    const mainWindowHandle = Number(processInfo?.mainWindowHandle || 0);
    const mainWindowTitle = String(processInfo?.mainWindowTitle || '').trim();
    return mainWindowHandle > 0 || mainWindowTitle.length > 0;
  }

  async cleanupOrphanedHeadlessProcesses(reporter = null) {
    const running = await discoverRunningProcesses('^blender(?:\\.exe)?$');
    const headless = running.filter((item) => this.isHmdaoHeadlessProcess(item));
    if (!headless.length) {
      return { removed: 0, running };
    }

    let removed = 0;
    for (const processInfo of headless) {
      let stopResult = await stopWindowsProcessTree(processInfo.pid);
      let stillAlive = await isWindowsProcessAlive(processInfo.pid);
      if (!stopResult.ok || stillAlive) {
        const fallbackStop = await runPowerShellInline([
          `$proc = Get-Process -Id ${Number(processInfo.pid || 0)} -ErrorAction SilentlyContinue`,
          'if ($proc) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 300 }',
          `"alive=$([bool](Get-Process -Id ${Number(processInfo.pid || 0)} -ErrorAction SilentlyContinue))"`,
        ].join('; '), {
          windowsHide: true,
        });
        stillAlive = /alive=True/i.test(String(fallbackStop.stdout || ''));
        stopResult = {
          ok: fallbackStop.ok && !stillAlive,
          error: fallbackStop.ok && !stillAlive ? '' : (fallbackStop.error || stopResult.error || 'fallback-stop-failed'),
        };
      }
      if (stopResult.ok) removed += 1;
    }
    if (removed > 0) {
      reporter?.warn('Stopped orphaned HMDao Blender headless process(es) before retrying connect.', {
        removed,
        pids: headless.map((item) => item.pid),
      });
    }
    return {
      removed,
      running: running.filter((item) => !this.isHmdaoHeadlessProcess(item)),
    };
  }

  async readHeadlessRuntimeLogTail(maxLines = 20) {
    const logPath = path.join(os.tmpdir(), 'hmdao_blender_headless_runtime.log');
    const text = await fs.readFile(logPath, 'utf8').catch(() => '');
    if (!text) return '';
    return text.split(/\r?\n/g).filter(Boolean).slice(-Math.max(1, maxLines)).join(' | ');
  }

  async readPendingStartRequest() {
    const text = await fs.readFile(BLENDER_REQUEST_FILE, 'utf8').catch(() => '');
    if (!text.trim()) return null;
    try {
      const payload = JSON.parse(text);
      if (!payload || typeof payload !== 'object') return null;
      const expiresAt = Number(payload.expiresAt || 0);
      if (expiresAt && expiresAt < Date.now()) return null;
      return payload;
    } catch {
      return null;
    }
  }

  async readAddonRuntimeState() {
    const state = await readJsonFile(BLENDER_STATUS_FILE, null);
    if (!state || typeof state !== 'object') {
      return {
        present: false,
        fresh: false,
        enabled: false,
        serviceRunning: false,
        pid: 0,
        heartbeatAgeMs: Number.POSITIVE_INFINITY,
        path: BLENDER_STATUS_FILE,
        note: '',
      };
    }
    const pid = Number(state.pid || 0);
    const heartbeatTs = Number(state.heartbeatTs || 0);
    const heartbeatAgeMs = heartbeatTs > 0 ? Math.max(0, Date.now() - heartbeatTs) : Number.POSITIVE_INFINITY;
    const fresh = Boolean(pid > 0 && heartbeatTs > 0 && heartbeatAgeMs <= BLENDER_STATUS_STALE_MS && await isWindowsProcessAlive(pid));
    return {
      present: true,
      fresh,
      enabled: fresh && Boolean(state.enabled),
      serviceRunning: fresh && Boolean(state.serviceRunning),
      pid,
      heartbeatAgeMs,
      path: BLENDER_STATUS_FILE,
      note: String(state.note || '').trim(),
      pluginVersion: String(state.pluginVersion || '').trim(),
    };
  }

  async isCaptureServiceReachable() {
    const tcpReachable = await probeTcp(8766, '127.0.0.1', 3000).catch(() => false);
    if (tcpReachable) return true;
    const result = await runPowerShellInline([
      '$listener = Get-NetTCPConnection -State Listen -LocalPort 8766 -ErrorAction SilentlyContinue | Select-Object -First 1',
      'if ($listener) { "true" } else { "false" }',
    ].join('; '), {
      windowsHide: true,
    });
    return result.ok && /true/i.test(String(result.stdout || '').trim());
  }

  async runBasicCliProbe(installation, reporter = null) {
    const launchResult = await launchWindowsProcessViaStartProcess(
      installation.executablePath,
      ['--version'],
      {
        cwd: installation.installRoot || path.dirname(installation.executablePath),
        windowsHide: false,
      },
    );
    if (!launchResult.ok) {
      return {
        ok: false,
        reason: `Failed to launch Blender CLI probe: ${launchResult.error || 'unknown error'}`,
      };
    }

    const exitedQuickly = await waitForCondition(async () => !(await isWindowsProcessAlive(launchResult.pid)), {
      timeoutMs: 20000,
      intervalMs: 500,
    });
    if (!exitedQuickly) {
      await stopWindowsProcessTree(launchResult.pid);
      reporter?.warn('Blender basic CLI probe did not exit quickly before connect.', {
        executablePath: installation.executablePath,
        pid: launchResult.pid,
      });
      return {
        ok: false,
        reason: 'Blender did not complete a basic --version CLI probe within 20 seconds.',
      };
    }

    return {
      ok: true,
      reason: '',
      pid: launchResult.pid,
    };
  }

  async runBackgroundPythonProbe(installation, reporter = null, options = {}) {
    const cliProbe = options?.cliProbe || await this.runBasicCliProbe(installation, reporter);
    if (!cliProbe.ok) {
      reporter?.warn('Blender basic CLI probe was slow, but continuing with the background Python probe before treating the host as unusable.', {
        executablePath: installation.executablePath,
        reason: cliProbe.reason,
      });
    }

    await removeIfExists(BLENDER_PYTHON_PROBE_FILE);
    const probeExpression = `import pathlib, tempfile; pathlib.Path(tempfile.gettempdir(), 'hmdao_blender_probe.txt').write_text('ok', encoding='utf-8')`;
    const profiles = [
      { id: 'default', extraArgs: [] },
      { id: 'opengl-fallback', extraArgs: BLENDER_BACKGROUND_OPENGL_ARGS },
    ];

    for (const profile of profiles) {
      await removeIfExists(BLENDER_PYTHON_PROBE_FILE);
      const launchResult = await launchWindowsProcess(
        installation.executablePath,
        ['--background', '--factory-startup', ...profile.extraArgs, '--python-expr', probeExpression],
        {
          cwd: installation.installRoot || path.dirname(installation.executablePath),
          windowsHide: true,
          detached: true,
          stdio: 'ignore',
        },
      );
      if (!launchResult.ok) {
        return {
          ok: false,
          reason: `Failed to launch Blender background probe: ${launchResult.error || 'unknown error'}`,
          cliOk: cliProbe.ok,
          cliReason: cliProbe.reason,
          profile: profile.id,
        };
      }

      const wroteProbe = await waitForCondition(async () => await pathExists(BLENDER_PYTHON_PROBE_FILE), {
        timeoutMs: 25000,
        intervalMs: 500,
      });
      if (wroteProbe) {
        await stopWindowsProcessTree(launchResult.pid);
        if (profile.id !== 'default') {
          reporter?.warn('Blender background Python probe succeeded only after forcing the OpenGL backend.', {
            executablePath: installation.executablePath,
            pid: launchResult.pid,
            profile: profile.id,
          });
        }
        return {
          ok: true,
          reason: '',
          pid: launchResult.pid,
          profile: profile.id,
          cliOk: cliProbe.ok,
          cliReason: cliProbe.reason,
        };
      }

      await stopWindowsProcessTree(launchResult.pid);
      reporter?.warn('Blender background Python probe did not execute before connect.', {
        executablePath: installation.executablePath,
        pid: launchResult.pid,
        profile: profile.id,
      });
    }

    return {
      ok: false,
      reason: 'Blender background startup did not execute even a minimal Python probe within 25 seconds, including an OpenGL fallback attempt.',
      cliOk: cliProbe.ok,
      cliReason: cliProbe.reason,
      profile: 'failed',
    };
  }

  async requestRunningBlenderToStartService(reporter = null) {
    const discovered = await discoverRunningProcesses('^blender(?:\\.exe)?$');
    const addonRuntimeState = await this.readAddonRuntimeState();
    const running = discovered.filter((item) => this.isVisibleBlenderUiProcess(item));
    if (!running.length && addonRuntimeState.enabled && Number(addonRuntimeState.pid || 0) > 0) {
      const runtimeHost = discovered.find((item) => Number(item.pid || 0) === Number(addonRuntimeState.pid || 0));
      if (runtimeHost) {
        reporter?.info('Blender start request is targeting the active HMDao add-on runtime even though the current session is not exposing a visible window handle yet.', {
          pid: runtimeHost.pid,
          source: runtimeHost.source,
        });
        running.push(runtimeHost);
      }
    }
    if (!running.length) return { requested: false, running };
    const payload = {
      action: 'start_server',
      requestedAt: Date.now(),
      expiresAt: Date.now() + 120000,
      source: 'hmdao-environment-manager',
    };
    await fs.writeFile(BLENDER_REQUEST_FILE, `${JSON.stringify(payload)}\n`, 'utf8');
    reporter?.info('Requested the running Blender session to start HMDao capture on demand.', {
      requestFile: BLENDER_REQUEST_FILE,
      runningCount: running.length,
    });
    return { requested: true, running };
  }

  async getStatus(options = {}) {
    const explicitStartupProbe = options?.explicitStartupProbe === true;
    const [versions, installations, serviceReachable, backups, runningHosts, pendingStartRequest, addonRuntimeState, pluginSourceVersion] = await Promise.all([
      discoverBlenderVersions(),
      discoverBlenderInstallations(),
      this.isCaptureServiceReachable(),
      listBackups(this.backupRoot, this.id),
      discoverRunningProcesses('^blender(?:\.exe)?$'),
      this.readPendingStartRequest(),
      this.readAddonRuntimeState(),

      this.readPluginSourceVersion(),
    ]);
    const summary = deriveBlenderStateSummary({ versions, installations, serviceReachable });
    const installedVersions = versions.filter((item) => item.installed);
    const primaryInstallation = installations[0] || null;
    const visibleRunningHosts = runningHosts.filter((item) => this.isVisibleBlenderUiProcess(item));
    const hiddenRunningHosts = runningHosts.filter((item) => !this.isHmdaoHeadlessProcess(item) && !this.isVisibleBlenderUiProcess(item));
    const headlessRunningHosts = runningHosts.filter((item) => this.isHmdaoHeadlessProcess(item));
    const addonEnabledInVisibleHost = Boolean(addonRuntimeState.enabled)
      && visibleRunningHosts.some((item) => Number(item.pid || 0) === addonRuntimeState.pid);
    const addonEnabledInHeadlessHost = Boolean(addonRuntimeState.enabled)
      && headlessRunningHosts.some((item) => Number(item.pid || 0) === addonRuntimeState.pid);
    const runtimePluginVersion = String(addonRuntimeState.pluginVersion || '').trim();

    const versionMismatch = Boolean(pluginSourceVersion && runtimePluginVersion && pluginSourceVersion !== runtimePluginVersion);

    const readyForLiveCapture = Boolean(serviceReachable) && addonEnabledInVisibleHost;
    const pendingRequestDetail = pendingStartRequest
      ? `A pending HMDao start request is still waiting at ${BLENDER_REQUEST_FILE}, so the current Blender UI session has not consumed the on-demand capture request yet.`
      : '';

    let startupProbeRaw = null;
    if (explicitStartupProbe && primaryInstallation && visibleRunningHosts.length === 0) {
      startupProbeRaw = await this.runBackgroundPythonProbe(primaryInstallation, null);
    }

    const startupProbeCategory = headlessRunningHosts.length > 0 && visibleRunningHosts.length === 0
      ? 'background-residue'
      : hiddenRunningHosts.length > 0 && visibleRunningHosts.length === 0
        ? 'host-stuck'
        : startupProbeRaw && startupProbeRaw.cliOk === false
          ? 'host-stuck'
          : startupProbeRaw && startupProbeRaw.ok === false
            ? 'host-stuck'
            : startupProbeRaw && startupProbeRaw.ok && visibleRunningHosts.length === 0
              ? 'config-pollution'
              : visibleRunningHosts.length > 0
                ? 'ready'
                : primaryInstallation
                  ? 'waiting'
                  : 'unavailable';

    const startupProbe = primaryInstallation
      ? {
          ran: Boolean(startupProbeRaw),
          executablePath: primaryInstallation.executablePath,
          cliOk: startupProbeRaw ? Boolean(startupProbeRaw.cliOk) : undefined,
          cliReason: startupProbeRaw?.cliReason || '',
          backgroundOk: startupProbeRaw ? Boolean(startupProbeRaw.ok) : undefined,
          backgroundReason: startupProbeRaw?.reason || '',
          profile: startupProbeRaw?.profile || '',
          category: startupProbeCategory,
        }
      : null;

    const effectiveSummary = versionMismatch && visibleRunningHosts.length > 0

      ? {

          level: 'warning',

          summary: `Blender is still running HMDao Blender Capture v${runtimePluginVersion}, while the installed add-on files are already v${pluginSourceVersion}. Restart Blender, or disable and re-enable the add-on once, before retrying Connect or Record.`,

        }

      : serviceReachable && headlessRunningHosts.length > 0 && visibleRunningHosts.length === 0
      ? {
          level: 'warning',
          summary: 'HMDao Blender capture service is online through a background helper, but no visible Blender UI session is running.',
        }
      : startupProbeCategory === 'config-pollution' && visibleRunningHosts.length === 0
        ? {
            level: 'warning',
            summary: 'Blender clean startup probe passed, so the current slowdown is more likely in user config or third-party add-ons.',
          }
      : startupProbeCategory === 'host-stuck' && visibleRunningHosts.length === 0
        ? {
            level: 'warning',
            summary: 'Blender minimal startup probe failed before a visible window appeared. The host itself is stalled in startup or graphics initialization.',
          }
      : visibleRunningHosts.length > 0 && !addonEnabledInVisibleHost
        ? {
            level: 'warning',
            summary: 'Blender is running, but the current visible session has not loaded the HMDao Blender Capture add-on yet.',
          }
      : hiddenRunningHosts.length > 0 && visibleRunningHosts.length === 0
        ? {
            level: 'warning',
            summary: 'Blender processes are running, but no visible Blender window is available yet. Wait for the UI to appear, or close orphaned background Blender processes before retrying Connect.',
          }
      : summary;

    return {
      id: this.id,
      adapter: {
        id: this.adapterId,
        label: this.adapterId,
      },
      label: this.label,
      pluginName: this.pluginName,
      pluginSourcePath: this.pluginSourcePath,
      summary: effectiveSummary.summary,
      level: effectiveSummary.level,
      recommendedAction: versionMismatch

        ? 'repair'

        : startupProbeCategory === 'background-residue'
        ? 'cleanup'
        : startupProbeCategory === 'host-stuck'
          ? 'repair'
          : startupProbeCategory === 'config-pollution'
            ? 'repair'
            : !versions.length && installations.length
              ? 'connect'
              : !versions.length && !installations.length
                ? 'detect'
                : !installedVersions.length
                  ? 'install'
                  : visibleRunningHosts.length > 0 && !addonEnabledInVisibleHost
                    ? 'connect'
                    : !readyForLiveCapture
                      ? 'connect'
                      : headlessRunningHosts.length > 0 && visibleRunningHosts.length === 0
                        ? 'cleanup'
                        : 'ready',
      host: {
        versions,
        installations,
        runningHosts: visibleRunningHosts,
        hiddenRunningHosts,
        headlessRunningHosts,
        startupProbe,
      },
      plugin: {
        installedVersions: installedVersions.map((item) => item.version),

        sourceVersion: pluginSourceVersion,

        runtimeVersion: runtimePluginVersion,

        versionMismatch,
        serviceReachable,
        readyForLiveCapture,
        addonEnabledInRunningHost: addonEnabledInVisibleHost,
        addonEnabledInHeadlessHost: addonEnabledInHeadlessHost,
        addonRuntimeState,
        lastBackup: backups[0] || null,
        backups: backups.slice(0, 5),
      },
      layers: [
        {
          key: 'installation',
          label: 'Installation',
          state: installations.length ? 'ready' : 'warning',
          detail: primaryInstallation
            ? `${primaryInstallation.label} - ${primaryInstallation.executablePath}`
            : 'No Blender installation path was detected yet.',
        },
        {
          key: 'startup-probe',
          label: 'Startup probe',
          state: startupProbeCategory === 'background-residue' || startupProbeCategory === 'host-stuck' || startupProbeCategory === 'config-pollution'
            ? 'warning'
            : startupProbeCategory === 'ready'
              ? 'ready'
              : 'idle',
          detail: !primaryInstallation
            ? 'No Blender executable was detected yet, so no startup probe could run.'
            : startupProbeCategory === 'background-residue'
              ? 'The current startup problem is dominated by orphan HMDao helper residue. Clean that first before judging Blender itself.'
              : startupProbeCategory === 'config-pollution'
                ? `Clean startup probe succeeded${startupProbeRaw?.profile && startupProbeRaw.profile !== 'failed' ? ` (profile=${startupProbeRaw.profile})` : ''}. Blender itself looks healthy, so current slowdown is more likely in user config or third-party add-ons.`
                : startupProbeCategory === 'host-stuck'
                  ? `Blender minimal startup probe failed: ${startupProbeRaw?.reason || startupProbeRaw?.cliReason || 'unknown reason'}. This points to Blender host startup or graphics initialization, not HMDao preview startup.`
                  : visibleRunningHosts.length > 0
                    ? 'A visible Blender UI session is already running, so no clean startup probe is needed right now.'
                    : 'Startup probe is waiting for a manual scan.',
        },
        {
          key: 'profiles',
          label: 'User profiles',
          state: versions.length ? 'ready' : 'warning',
          detail: versions.length
            ? `Detected ${versions.length} Blender profile director${versions.length === 1 ? 'y' : 'ies'}.`
            : 'No Blender user profile directory was detected yet. Blender creates it automatically after the first normal launch.',
        },
        {
          key: 'addon',
          label: 'Add-on files',
          state: installedVersions.length ? (versionMismatch ? 'warning' : 'ready') : 'warning',
          detail: installedVersions.length
            ? `Installed to ${installedVersions.map((item) => item.version).join(', ')}${pluginSourceVersion ? ` / source v${pluginSourceVersion}` : ''}${runtimePluginVersion ? ` / runtime v${runtimePluginVersion}` : ''}${versionMismatch ? ' (restart Blender to load the latest add-on code)' : ''}`
            : 'The hmdao_blender_capture add-on folder was not detected yet.',
        },
        {
          key: 'addon-enable',
          label: 'Add-on enable state',
          state: addonEnabledInVisibleHost ? 'ready' : 'warning',
          detail: addonEnabledInVisibleHost
            ? `The visible Blender session has loaded HMDao Blender Capture (PID ${addonRuntimeState.pid}).`
            : visibleRunningHosts.length > 0
              ? `Blender is running, but HMDao Blender Capture has not registered inside the visible session yet. Enable the add-on in Preferences > Add-ons, then open the HMDao sidebar and start the capture service once.${pendingRequestDetail ? ` ${pendingRequestDetail}` : ''}`
              : hiddenRunningHosts.length > 0
                ? 'Blender processes are running, but no visible Blender window has appeared yet. Wait for the UI to open before validating HMDao capture.'
                : addonEnabledInHeadlessHost
                  ? `HMDao Blender Capture is only registered inside a background helper process (PID ${addonRuntimeState.pid}). Cleanup it before validating a visible host-first workflow.`
                  : 'No visible Blender session with HMDao Blender Capture loaded was detected yet.',
        },
        {
          key: 'service',
          label: 'Capture service',
          state: readyForLiveCapture ? 'ready' : 'warning',
          detail: readyForLiveCapture
            ? '127.0.0.1:8766 is online from a visible Blender session.'
            : serviceReachable
              ? '127.0.0.1:8766 is online, but the source is not a visible Blender UI session yet.'
              : hiddenRunningHosts.length > 0
                ? 'Blender processes exist, but no visible window is ready yet and 8766 is still offline. Wait for the UI to appear, or clean up background Blender processes before retrying.'
                : '127.0.0.1:8766 is offline right now. You can use Connect to start the Blender capture service on demand.',
        },
        {
          key: 'preview-startup-load',
          label: 'Preview startup load',
          state: 'ready',
          detail: 'Preview stays off until you explicitly start it. During the first 20 seconds after preview starts, Blender throttles capture down to 2 fps to keep the UI responsive.',
        },
        {
          key: 'headless-helper',
          label: 'Headless helper',
          state: headlessRunningHosts.length > 0 && visibleRunningHosts.length === 0 ? 'warning' : 'ready',
          detail: headlessRunningHosts.length > 0 && visibleRunningHosts.length === 0
            ? `HMDao background helper is still running for Blender on ${headlessRunningHosts.map((item) => `PID ${item.pid}`).join(', ')}. Use Cleanup if you want to return to a clean host state before opening visible Blender UI.`
            : 'No orphaned HMDao Blender headless helper was detected.',
        },
      ],
      notes: [
        'Environment Manager auto-detects installed Blender executables and user profile directories.',
        'If the profile directory still does not appear after the first install, run Connect once to start Blender normally, then run Install again if needed.',
        ...(startupProbeCategory === 'config-pollution' && primaryInstallation
          ? [`Clean startup probe succeeded. If normal Blender still hangs, test "${primaryInstallation.executablePath}" --factory-startup and audit user add-ons/config before blaming HMDao.`]
          : []),
        ...(startupProbeCategory === 'host-stuck' && primaryInstallation
          ? [`Minimal Blender startup probe already failed for "${primaryInstallation.executablePath}". That points to Blender host startup or graphics initialization rather than HMDao preview load.`]
          : []),
        'When 8766 is online, the DCC node reads real Blender camera preview directly instead of falling back to mock data.',
        ...(headlessRunningHosts.length > 0 && visibleRunningHosts.length === 0 ? ['Current 8766 reachability comes from an HMDao headless helper only. Use Cleanup to stop it, then open visible Blender UI and start capture manually from the HMDao panel when you want a clean manual host-first flow.'] : []),
        'Copying the add-on into the Blender add-ons folder does not force startup work. Enable it manually in Preferences, then start the HMDao capture service only when you actually need preview.',
        'Blender stays a thin bridge plugin: preview capture starts only on demand, and startup warmup stays intentionally low so the host UI is less likely to appear frozen.',
        'For the most stable production setup, keep preview encoding and transfer in an external helper or sidecar instead of pushing heavy render work into Blender startup.',
      ],
      actions: ['detect', 'connect', 'install', 'reinstall', 'repair', 'cleanup', 'remove', 'rollback'],
    };
  }

  pickInstallation(status, requestedVersion = '') {
    const installations = Array.isArray(status?.host?.installations) ? status.host.installations : [];
    if (!installations.length) return null;
    if (!requestedVersion) return installations[0];
    return installations.find((item) => item.version === requestedVersion || item.label.includes(requestedVersion)) || installations[0];
  }

  async runAction(action, options = {}, reporter = null) {
    if (action === 'repair') {
      const [versions, installations, serviceReachable, runningHosts] = await Promise.all([
        discoverBlenderVersions(),
        discoverBlenderInstallations(),
        this.isCaptureServiceReachable(),
        discoverRunningProcesses('^blender(?:\\.exe)?$'),
      ]);
      const installedCount = versions.filter((item) => item.installed).length;
      const visibleRunningHosts = runningHosts.filter((item) => this.isVisibleBlenderUiProcess(item));
      const hiddenRunningHosts = runningHosts.filter((item) => !this.isHmdaoHeadlessProcess(item) && !this.isVisibleBlenderUiProcess(item));
      const headlessRunningHosts = runningHosts.filter((item) => this.isHmdaoHeadlessProcess(item));
      const headlessCleanup = headlessRunningHosts.length > 0 ? await this.cleanupOrphanedHeadlessProcesses(reporter) : { removed: 0 };
      const staleRequestRemoved = await removeIfExists(BLENDER_REQUEST_FILE);
      const staleStatusRemoved = await removeIfExists(BLENDER_STATUS_FILE);
      const staleProbeRemoved = await removeIfExists(BLENDER_PYTHON_PROBE_FILE);
      const findings = [
        `installations=${installations.length}`,
        `profiles=${versions.length}`,
        `addonInstalled=${installedCount > 0 ? 'yes' : 'no'}`,
        `visibleRunningHosts=${visibleRunningHosts.length}`,
        `hiddenRunningHosts=${hiddenRunningHosts.length}`,
        `headlessRunningHosts=${headlessRunningHosts.length}`,
        `serviceReachable=${serviceReachable ? 'yes' : 'no'}`,
      ];
      if (staleRequestRemoved) {
        findings.push('staleRequest=cleared');
      }
      if (staleStatusRemoved) {
        findings.push('staleStatus=cleared');
      }
      if (staleProbeRemoved) {
        findings.push('startupProbeFile=cleared');
      }
      if (Number(headlessCleanup?.removed || 0) > 0) {
        findings.push(`headlessCleaned=${Number(headlessCleanup.removed || 0)}`);
      }
      if (installations[0] && visibleRunningHosts.length === 0) {
        findings.push('startupProbe=skipped');
      }
      if (!serviceReachable && installedCount > 0 && visibleRunningHosts.length > 0) {
        const repairStartRequest = await this.requestRunningBlenderToStartService(reporter);
        if (repairStartRequest.requested) {
          const repairStartedService = await waitForCondition(() => this.isCaptureServiceReachable(), {
            timeoutMs: 12000,
            intervalMs: 1000,
          });
          findings.push(`repairStartRequest=${repairStartRequest.requested ? 'sent' : 'skipped'}`);
          if (repairStartedService) {
            reporter?.info('Blender quick repair started the HMDao capture service in the running visible session.', {
              findings,
              requestFile: BLENDER_REQUEST_FILE,
              runningCount: repairStartRequest.running.length,
            });
            return {
              message: `Blender quick repair completed: ${findings.join(', ')}. The running Blender session accepted the HMDao start request and 127.0.0.1:8766 is now online.`,
            };
          }
          findings.push('repairStartTimedOut=yes');
        }
      }
      reporter?.info('Completed Blender quick repair check.', {
        findings,
      });
      if (serviceReachable) {
        return {
          message: `Blender quick check passed: ${findings.join(', ')}. No heavy repair was needed.`,
        };
      }
      if (installedCount > 0 && visibleRunningHosts.length > 0) {
        return {
          message: `Blender quick check completed: ${findings.join(', ')}. The add-on files are present; use Connect to start the capture service without reinstalling the plugin.`,
        };
      }
      if (installedCount > 0 && hiddenRunningHosts.length > 0) {
        return {
          message: `Blender quick check completed: ${findings.join(', ')}. Blender itself looks stuck in a graphics/background-process state before a visible window is ready. Wait for the UI to appear, or close the background Blender processes and retry Connect.`,
        };
      }
      if (installedCount > 0 && headlessRunningHosts.length > 0) {
        return {
          message: `Blender quick check completed: ${findings.join(', ')}. Only an HMDao headless helper was keeping the runtime alive. Repair already cleared orphan helpers; reopen visible Blender and retry Connect if the UI still feels stuck.`,
        };
      }
      if (installedCount > 0) {
        return {
          message: `Blender quick check completed: ${findings.join(', ')}. The add-on is installed but the capture service is offline. HMDao did not auto-start Blender; open a visible Blender window first, then retry Connect.`,
        };
      }
      return {
        message: `Blender quick check completed: ${findings.join(', ')}. The add-on is missing; use Install or Reinstall explicitly when you are ready.`,
      };
    }

    const status = await this.getStatus();
    const requestedVersion = String(options.version || '').trim();
    const allVersions = options.allVersions === true;
    const effectiveRequestedVersion = requestedVersion || (!allVersions ? status.host.versions[0]?.version || '' : '');
    const targets = allVersions
      ? status.host.versions
      : status.host.versions.filter((item) => item.version === effectiveRequestedVersion);

    if (action === 'cleanup') {
      const headlessCleanup = await this.cleanupOrphanedHeadlessProcesses(reporter);
      const cleanupTargets = targets.flatMap((item) => [
        path.join(item.addonPath, '__pycache__'),
        path.join(item.addonPath, 'operators', '__pycache__'),
        path.join(item.addonPath, 'server', '__pycache__'),
      ]);
      cleanupTargets.push(path.join(os.tmpdir(), 'hmdao_blender_headless_runtime.log'));
      cleanupTargets.push(BLENDER_REQUEST_FILE);
      cleanupTargets.push(BLENDER_STATUS_FILE);
      cleanupTargets.push(BLENDER_PYTHON_PROBE_FILE);

      let removedCount = 0;
      removedCount += Number(headlessCleanup?.removed || 0);
      for (const targetPath of cleanupTargets) {
        if (await removeIfExists(targetPath)) removedCount += 1;
      }

      for (const target of targets) {
        const parentDir = path.dirname(target.addonPath);
        const entries = await fs.readdir(parentDir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name !== '__pycache__') continue;
          if (await removeIfExists(path.join(parentDir, entry.name))) removedCount += 1;
        }
      }

      reporter?.info('Cleaned Blender runtime cache files.', {
        requestedVersion: effectiveRequestedVersion,
        allVersions,
        removedCount,
        stoppedHeadless: Number(headlessCleanup?.removed || 0),
      });
      return {
        message: removedCount > 0
          ? `Cleaned ${removedCount} Blender cache or temp path(s).`
          : 'No Blender cache or temp files needed cleanup.',
      };
    }

    if (action === 'connect') {
      if (status.plugin.serviceReachable) {
        return {
          message: 'HMDao Blender Capture service is already online on 127.0.0.1:8766.',
        };
      }

      await removeIfExists(BLENDER_REQUEST_FILE);
      await removeIfExists(BLENDER_STATUS_FILE);
      await removeIfExists(BLENDER_PYTHON_PROBE_FILE);
      await this.cleanupOrphanedHeadlessProcesses(reporter);
      const requestResult = await this.requestRunningBlenderToStartService(reporter);
      if (requestResult.requested) {
        const readyFromRunningHost = await waitForCondition(() => this.isCaptureServiceReachable(), {
          timeoutMs: 20000,
          intervalMs: 1000,
        });
        if (readyFromRunningHost) {
          reporter?.info('The running Blender session accepted the HMDao on-demand start request.', {
            requestFile: BLENDER_REQUEST_FILE,
            runningCount: requestResult.running.length,
          });
          return {
            message: 'The running Blender session started HMDao capture on demand. DCC real preview is ready on 127.0.0.1:8766.',
          };
        }
        const pendingStartRequest = await this.readPendingStartRequest();
        throw new Error(pendingStartRequest
          ? 'Blender is already running, but the current Blender session did not consume the HMDao on-demand start request. In the visible Blender UI, enable HMDao Blender Capture for this session and then click Start HMDao Capture Service once.'
          : 'Blender is already running, but the installed HMDao add-on did not start its capture service in time. Enable the add-on once in Blender, or use Reinstall only if the add-on files are broken.');
      }
      const installation = this.pickInstallation(status, requestedVersion);
      if (!installation?.executablePath) {
        throw new Error('No Blender executable was detected. Install Blender first or open it once so the Environment Manager can discover it.');
      }
      reporter?.info('Blender connect stayed in visible host-first mode because no running UI session was detected.', {
        executablePath: installation.executablePath,
        requestedVersion: effectiveRequestedVersion,
        startupProbe: 'skipped',
      });
      return {
        message: `No visible Blender session is running yet. Open Blender normally from ${installation.executablePath}, wait until the main window is fully visible, then retry Connect. HMDao did not auto-launch Blender or any hidden helper.`,
      };
    }

    if (!targets.length) {
      const installationHint = Array.isArray(status.host.installations) && status.host.installations.length
        ? 'Blender is installed, but no user profile was found yet. Run Connect once to let Blender generate its config folder, then install again.'
        : 'No Blender version profile was detected.';
      throw new Error(installationHint);
    }

    if (action === 'rollback') {
      reporter?.info('Rolling back Blender plugin environment.', { versions: targets.map((item) => item.version) });
      const backupItem = (await listBackups(this.backupRoot, this.id))[0];
      if (!backupItem) {
        throw new Error('No Blender backup is available for rollback.');
      }
      await restoreBackupRecord(backupItem);
      reporter?.info('Blender plugin environment rolled back.', { backupId: backupItem.id });
      return {
        message: `Rolled back Blender plugin state for ${targets.map((item) => item.version).join(', ')}.`,
        backupId: backupItem.id,
      };
    }

    const backup = await backupBlenderState(this.backupRoot, action, targets);
    reporter?.info('Created Blender environment backup.', {
      backupId: backup.id,
      action,
      versions: targets.map((item) => item.version),
    });

    try {
      if (action === 'remove') {
        for (const target of targets) {
          await removeIfExists(target.addonPath);
        }
        reporter?.info('Removed Blender plugin files.', { versions: targets.map((item) => item.version) });
        return {
          message: `Removed Blender plugin from ${targets.map((item) => item.version).join(', ')}.`,
          backupId: backup.id,
        };
      }

      const normalizedAction = action === 'update' ? 'reinstall' : action;
      const args = allVersions ? ['-AllVersions'] : ['-BlenderVersion', effectiveRequestedVersion];
      reporter?.info('Running Blender plugin install script.', { args, versions: targets.map((item) => item.version) });
      const scriptResult = await runPowerShellFile(this.installScriptPath, args);
      if (!scriptResult.ok) {
        const failureSummary = summarizeCommandResult(scriptResult, `${BLENDER_PLUGIN_FRIENDLY_NAME} ${normalizedAction} failed.`);
        const firstFailureLine = normalizeLineBreaks(failureSummary).split('\n')[0] || '';
        const lockedAddonMessage = firstFailureLine.includes('HMDao Blender Capture files')
          ? firstFailureLine
          : this.describeLockedAddonMessage(failureSummary, targets);
        throw new Error(lockedAddonMessage || failureSummary);
      }
      reporter?.info('Blender plugin install script completed.', { versions: targets.map((item) => item.version) });
      return {
        message: summarizeCommandResult(scriptResult, `${BLENDER_PLUGIN_FRIENDLY_NAME} ${normalizedAction} completed.`),
        backupId: backup.id,
      };
    } catch (error) {
      reporter?.error('Blender plugin action failed, restoring backup.', {
        backupId: backup.id,
        error: error instanceof Error ? error.message : String(error),
      });
      const backups = await listBackups(this.backupRoot, this.id);
      const restoreTarget = backups.find((item) => item.id === backup.id);
      if (restoreTarget) {
        try {
          await restoreBackupRecord(restoreTarget);
        } catch (restoreError) {
          reporter?.warn('Blender plugin backup restore also failed after the primary action error.', {
            backupId: backup.id,
            restoreError: restoreError instanceof Error ? restoreError.message : String(restoreError),
          });
        }
      }
      throw error;
    }
  }
}





