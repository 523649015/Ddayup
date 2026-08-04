// Pure helpers and constants extracted from unreal-plugin-adapter.mjs for incremental
// decoupling. These are free of `this.` / class-state dependencies and are re-imported
// by the main adapter class. Side-effect free except for node built-ins (fs/os/path).
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractFirstMatch } from '../../../lib/str-utils.mjs';
import { UNREAL_PLUGIN_NAME } from '../shared.mjs';

function normalizeKey(filePath) {
  return path.normalize(String(filePath || '')).toLowerCase();
}

function formatTimestampTag(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function readFileTimestamp(filePath = '') {
  const normalizedPath = String(filePath || '').trim();
  if (!normalizedPath) {
    return { path: '', exists: false, mtimeMs: 0, iso: '' };
  }
  try {
    const stat = await fs.stat(normalizedPath);
    return {
      path: normalizedPath,
      exists: true,
      mtimeMs: Number(stat.mtimeMs || 0),
      iso: stat.mtime instanceof Date ? stat.mtime.toISOString() : '',
    };
  } catch {
    return { path: normalizedPath, exists: false, mtimeMs: 0, iso: '' };
  }
}

function extractAbsLogPath(commandLine = '') {
  const line = String(commandLine || '').trim();
  if (!line) return '';
  const quoted = extractFirstMatch(line, /-AbsLog="([^"]+)"/i);
  if (quoted) return quoted.replace(/\//g, '\\');
  const unquoted = extractFirstMatch(line, /-AbsLog=([A-Za-z]:[\\/][^\s]+)/i);
  return unquoted ? unquoted.replace(/\//g, '\\') : '';
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findLastMatchingLineInfo(lines, pattern) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (pattern.test(lines[index])) {
      return { index, line: lines[index] };
    }
  }
  return null;
}

function parseUnrealLogTimestampMs(line = '') {
  const match = /^\[(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2}):(\d{3})\]/.exec(String(line || ''));
  if (!match) return 0;
  const [, year, month, day, hour, minute, second, millisecond] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(millisecond));
}

const SIDECAR_STARTUP_PHASES = [
  { key: 'bridge-online', label: 'HMDao websocket connected', pattern: /HMDao Unreal Capture: WebSocket connected/i },
  { key: 'plugin-startup', label: 'HMDao plugin module started', pattern: /HMDao Unreal Capture: StartupModule|HMDao Unreal Capture: Connect ->/i },
  { key: 'plugin-mounted', label: 'HMDao plugin mounted', pattern: /Mounting (?:Engine|Project) plugin HMDaoUnrealCapture/i },
  { key: 'remote-control', label: 'Remote Control websocket ready', pattern: /LogRemoteControl: Web Remote Control WebSocket server started/i },
  { key: 'device-profile', label: 'Device profile resolved', pattern: /Active device profile:/i },
  { key: 'package-streaming', label: 'Package streaming and material load', pattern: /LogStreaming: Display: (?:FlushAsyncLoading|Flushing package |Package .* dynamic import)|WaitingForIo|CreateLinkerLoadExports/i },
  { key: 'editor-tooling', label: 'Editor asset tooling initialized', pattern: /LogMeshReduction:|LogMeshMerging:/i },
  { key: 'editor-domain', label: 'Editor domain initialized', pattern: /LogEditorDomain:/i },
  { key: 'asset-registry', label: 'Asset registry initialized', pattern: /LogAssetRegistry: FAssetRegistry took/i },
  { key: 'slate', label: 'Slate UI initialized', pattern: /LogSlate: SlateFontServices|LogSlate: Using FreeType|LogSlate: New Slate User Created|LogSlate: Slate User Registered/i },
  { key: 'turnkey', label: 'Turnkey SDK detection complete', pattern: /LogTurnkeySupport: Completed SDK detection/i },
  { key: 'shader-warmup', label: 'Shader warmup and target platform discovery', pattern: /LogShaderCompilers:|LogDerivedDataCache:|LogTargetPlatformManager:/i },
  { key: 'project-plugin', label: 'Project plugin mounted', pattern: /Mounting Project plugin HMDaoUnrealCapture/i },
];

function cameraCountFromBridgeState(bridgeState) {
  const cameraList = Array.isArray(bridgeState?.cameraList?.camera_list)
    ? bridgeState.cameraList.camera_list
    : Array.isArray(bridgeState?.cameraList?.cameras)
      ? bridgeState.cameraList.cameras
      : [];
  return cameraList.length;
}

function getAdaptiveStallThresholds(latestSnapshot, {
  stallAfterMs,
  minWaitBeforeStallMs,
} = {}) {
  const phaseKey = String(latestSnapshot?.phaseKey || '').trim().toLowerCase();
  if (phaseKey === 'log-wait' || phaseKey === 'stale-log') {
    return {
      stallAfterMs: Math.min(Number(stallAfterMs || 0) || 60000, 60000),
      minWaitBeforeStallMs: Math.min(Number(minWaitBeforeStallMs || 0) || 90000, 90000),
    };
  }
  if (phaseKey === 'turnkey') {
    return {
      stallAfterMs: Math.max(Number(stallAfterMs || 0), 20 * 60 * 1000),
      minWaitBeforeStallMs: Math.max(Number(minWaitBeforeStallMs || 0), 25 * 60 * 1000),
    };
  }
  if (['slate', 'asset-registry', 'shader-warmup', 'project-plugin', 'plugin-mounted', 'package-streaming', 'editor-tooling'].includes(phaseKey)) {
    return {
      stallAfterMs: Math.max(Number(stallAfterMs || 0), 12 * 60 * 1000),
      minWaitBeforeStallMs: Math.max(Number(minWaitBeforeStallMs || 0), 15 * 60 * 1000),
    };
  }
  return { stallAfterMs, minWaitBeforeStallMs };
}

const OFFICIAL_CAPTURE_MODE = 'official-sequencer-capture';
const CUSTOM_CAPTURE_MODE = 'custom-plugin-direct';
const OPTIONAL_LIVE_PREVIEW_MODE = 'pixel-streaming-live-preview';
const UNREAL_CONNECT_REQUEST_FILE = path.join(os.tmpdir(), 'hmdao_unreal_capture.request.json');
const UNREAL_PRIMARY_ACTIONS = ['detect', 'connect', 'install', 'reinstall', 'rebuild', 'repair', 'cleanup', 'remove', 'rollback'];
const UNREAL_OFFICIAL_PLUGIN_REQUIREMENTS = [
  { name: 'PythonScriptPlugin', label: 'Python Script Plugin', required: true, purpose: 'Python automation for compatibility-mode export checks' },
  { name: 'SequencerScripting', label: 'Sequencer Scripting', required: true, purpose: 'Read camera animation in compatibility mode' },
  { name: 'RemoteControl', label: 'Compatibility-mode camera control', required: true, purpose: 'On-demand compatibility camera control' },
  { name: 'MovieRenderPipeline', label: 'Movie Render Queue', required: true, purpose: 'Optional offline compatibility export' },
  { name: 'PixelStreaming', label: 'Pixel Streaming', required: false, heavy: true, purpose: 'Optional browser preview fallback' },
];
const PROJECT_PLUGIN_RECEIPT_PATH_FRAGMENT = `$(ProjectDir)/Plugins/${UNREAL_PLUGIN_NAME}/`;
const DEFAULT_DIRECT_BRIDGE_EXTRA_ARGS = [
  '-AutoDeclinePackageRecovery',
  '-KillAllPopUpBlockingWindows',
  '-NoPreviewPlatforms',
  '-NoZenAutoLaunch',
];
const D3D11_FALLBACK_EXTRA_ARGS = ['-d3d11'];
const QUICK_DIAGNOSTIC_TTL_MS = 15000;

const KNOWN_STARTUP_INTERFERERS = [
  { key: 'rtss', label: 'RivaTuner Statistics Server', pattern: /^rtss(?:64)?(?:\.exe)?$/i },
  { key: 'afterburner', label: 'MSI Afterburner', pattern: /^msiafterburner(?:\.exe)?$/i },
  { key: 'discord', label: 'Discord overlay host', pattern: /^discord(?:\.exe)?$/i },
  { key: 'nvidia-shadowplay', label: 'NVIDIA ShadowPlay / In-Game Overlay', pattern: /^nvcontainer(?:\.exe)?$/i, commandLinePattern: /\\NvContainer\\plugins\\SPUser\b/i },
  { key: 'qqpc', label: 'Tencent PC Manager / QQPC runtime', pattern: /^(?:QQPCTray|QQPCRTP|QQPCPatch|qmbsrv)(?:\.exe)?$/i },
  { key: 'nahimic', label: 'Nahimic audio overlay', pattern: /^nahimic(?:service|svc|companion)?(?:\.exe)?$/i },
  { key: 'sonic-studio', label: 'Sonic Studio / A-Volute audio overlay', pattern: /^(?:ss3svc32|ss3svc64|sonicstudio|a-volute)(?:\.exe)?$/i },
];

function getEnabledProjectPlugins(projectJson) {
  const enabled = new Set();
  const items = Array.isArray(projectJson?.Plugins) ? projectJson.Plugins : [];
  for (const item of items) {
    if (!item?.Enabled) continue;
    const pluginName = String(item?.Name || '').trim();
    if (pluginName) enabled.add(pluginName);
  }
  return enabled;
}

export {
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
};
