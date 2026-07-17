import { dccGatewayFetch } from './dccGateway';



export type DccPluginEngine = 'unreal' | 'blender';

export type DccPluginAction = 'detect' | 'connect' | 'install' | 'update' | 'reinstall' | 'rebuild' | 'repair' | 'cleanup' | 'remove' | 'rollback';



export interface DccRuntimeStatePayload {

  stage?: 'host' | 'plugin' | 'bridge' | 'frame' | string;

  state?: 'idle' | 'waiting' | 'ready' | 'error' | string;

  label?: string;

  message?: string;

  reason?: string;

  dedupeKey?: string;

}



export interface DccPluginLayer {

  key: string;

  label: string;

  state: 'ready' | 'warning' | 'error' | 'unknown' | string;

  detail: string;

}



export interface DccPluginBackup {

  id: string;

  createdAt: string;

}



export interface UnrealEngineInstallCandidate {

  engineRoot: string;

  source: string;

  label: string;

  version: string;

  buildBatExists: boolean;

}



export interface UnrealProjectCandidate {

  path: string;

  name: string;

  folder: string;

  running: boolean;

  source: string;

  modifiedAt: number;

  engineAssociation: string;

}



export interface BlenderVersionCandidate {

  version: string;

  versionPath: string;

  addonPath: string;

  installed: boolean;

  running: boolean;

}



export interface BlenderInstallationCandidate {

  label: string;

  version: string;

  executablePath: string;

  installRoot: string;

  source: string;

}



export interface DccEnvironmentJob {

  id: string;

  engine: DccPluginEngine;

  adapter: string;

  action: DccPluginAction;

  status: 'queued' | 'pending' | 'running' | 'completed' | 'failed' | string;

  title?: string;

  message?: string | null;

  error?: string | null;

  backupId?: string | null;

  createdAt: string;

  startedAt?: string | null;

  endedAt?: string | null;

  runtimeState?: DccRuntimeStatePayload | null;

  shortMessage?: string | null;

  dedupeKey?: string | null;

}



export interface DccEnvironmentLogEntry {

  id: string;

  timestamp: string;

  level: 'info' | 'warn' | 'error' | string;

  scope: string;

  engine?: DccPluginEngine;

  jobId?: string;

  message: string;

  context?: Record<string, unknown> | null;

  runtimeState?: DccRuntimeStatePayload | null;

  shortMessage?: string | null;

  dedupeKey?: string | null;

}



type UnrealEngineStatus = {

  id: 'unreal';

  adapter?: {

    id: string;

    label: string;

  };

  label: string;

  pluginName: string;

  summary: string;

  level: string;

  recommendedAction: string;

  integration?: {

    recommendedMode?: string;

    activeMode?: string;

    supportedModes?: string[];

    directBridgeOnline?: boolean;

    directBridgeReady?: boolean;

    officialCaptureReady?: boolean;

    optionalLivePreviewReady?: boolean;

    previewProvider?: string;

  };

  runtimeState?: DccRuntimeStatePayload | null;

  official?: {

    mode?: string;

    plugins?: Array<{

      name: string;

      label: string;

      required: boolean;

      enabled: boolean;

      purpose?: string;

      heavy?: boolean;

    }>;

    pluginNames?: string[];

    missingRequired?: Array<{ name: string; label: string }>;

    capturePrerequisitesReady?: boolean;

    livePreviewReady?: boolean;

    remoteControlReachable?: boolean;

    restartRequired?: boolean;

    guidedSteps?: string[];

  };

  compatibility?: {

    containsNonAscii?: boolean;

    safeForProjectCopy?: boolean;

    safeForOfficialMode?: boolean;

    avoidForcedEngineBuild?: boolean;

    summary?: string;

    items?: Array<{ key: string; label: string; path: string; containsNonAscii: boolean }>;

  };

  guidance?: {

    restartRequired?: boolean;

    guidedActions?: Array<{

      id: string;

      title: string;

      recommended?: boolean;

      restartRequired?: boolean;

      details?: string;

      targetPath?: string;

      safeDefault?: boolean;

      changedByInstallAction?: boolean;

    }>;

  };

  host: {
    engineInstalls: UnrealEngineInstallCandidate[];

    resolvedEngineRoot?: string;

    resolvedEngineVersion?: string;
    hostProcessRunning?: boolean;
    runningProjectDetected: boolean;
    targetProjectRunning?: boolean;
    startupProbe?: {
      category?: 'background-residue' | 'host-stuck' | 'config-pollution' | 'ready' | 'waiting' | 'unavailable';
      reason?: string;
      detail?: string;
      phaseKey?: string;
      phaseLabel?: string;
      windowState?: string;
      hasNoFreshLog?: boolean;
    };
  };

  project: (UnrealProjectCandidate & { pluginPath: string }) | null;

  projects: UnrealProjectCandidate[];

  plugin: {

    installed: boolean;

    enabledInProject: boolean;

    buildArtifactsPresent: boolean;

    installationScope?: string | null;

    effectivePath?: string | null;

    projectPluginPath?: string | null;

    projectInstalled?: boolean;

    enginePluginPath?: string | null;

    engineInstalled?: boolean;

    duplicateInstall?: boolean;

    engineShadowCopies?: number;

    engineShadowCopyPaths?: string[];

    staleTargetReceiptFiles?: string[];

    syncState?: {

      state: 'idle' | 'ready' | 'warning';

      summary: string;

      runtimeInSync: boolean;

      binaryOlderThanRepoSource?: boolean;

      binaryOlderThanDeployedSource?: boolean;

      repoSourceTimestamp?: string;

      deployedSourceTimestamp?: string;

      deployedBinaryTimestamp?: string;
    };

    directBridgeOnline: boolean;

    directBridgeReadyForTargetProject?: boolean;

    cameraCount: number;

    lastBackup: DccPluginBackup | null;

    backups: DccPluginBackup[];

  };

  layers: DccPluginLayer[];

  notes: string[];

  actions: DccPluginAction[];

};



type BlenderEngineStatus = {

  id: 'blender';

  adapter?: {

    id: string;

    label: string;

  };

  label: string;

  pluginName: string;

  summary: string;

  level: string;

  recommendedAction: string;

  runtimeState?: DccRuntimeStatePayload | null;

  host: {

    versions: BlenderVersionCandidate[];

    installations: BlenderInstallationCandidate[];

    runningHosts?: Array<{ pid?: number; commandLine?: string }>;

    hiddenRunningHosts?: Array<{ pid?: number; commandLine?: string }>;

    headlessRunningHosts?: Array<{ pid?: number; commandLine?: string }>;

    startupProbe?: {

      ran?: boolean;

      executablePath?: string;

      cliOk?: boolean;

      cliReason?: string;

      backgroundOk?: boolean;

      backgroundReason?: string;

      profile?: string;

      category?: 'background-residue' | 'host-stuck' | 'config-pollution' | 'ready' | 'waiting' | 'unavailable';

    };

  };

  plugin: {

    installedVersions: string[];

    serviceReachable: boolean;

    readyForLiveCapture?: boolean;

    addonEnabledInRunningHost?: boolean;

    addonEnabledInHeadlessHost?: boolean;

    addonRuntimeState?: {

      present?: boolean;

      fresh?: boolean;

      enabled?: boolean;

      serviceRunning?: boolean;

      pid?: number;

      heartbeatAgeMs?: number;

      path?: string;

      note?: string;

      pluginVersion?: string;

    };

    lastBackup: DccPluginBackup | null;

    backups: DccPluginBackup[];

  };

  layers: DccPluginLayer[];

  notes: string[];

  actions: DccPluginAction[];

};



export interface DccPluginStatusResponse {

  success: true;

  generatedAt: string;

  robotReady: boolean;

  manager?: {

    id: string;

    label: string;

    adapters: Array<{ id: string; engine: DccPluginEngine }>;

    jobSummary?: {

      total: number;

      running: number;

      failed: number;

      completed: number;

      latest: DccEnvironmentJob | null;

    };

  };

  paths: {

    status: string;

    action: string;

    jobs?: string;

    logs?: string;

    legacyStatus?: string;

    legacyAction?: string;

  };

  engines: {

    unreal: UnrealEngineStatus;

    blender: BlenderEngineStatus;

  };

}



export interface DccPluginActionResponse {

  success: true;

  action: DccPluginAction;

  engine: DccPluginEngine;

  adapter?: string;

  message: string;

  backupId?: string;

  job?: DccEnvironmentJob;

  status: DccPluginStatusResponse;

}



function assertOk(response: Response, fallback: string) {

  if (response.ok) return;

  throw new Error(fallback);

}



async function parseJson<T>(response: Response) {

  return await response.json().catch(() => null) as ({ error?: { message?: string } } & Partial<T>) | null;

}



export async function fetchDccPluginManagerStatus(force = false, engine?: DccPluginEngine) {

  const params = new URLSearchParams();

  if (force) params.set('force', '1');

  if (engine === 'unreal' || engine === 'blender') params.set('engine', engine);

  const query = params.toString();

  const primary = `/api/dcc/environment/status${query ? `?${query}` : ''}`;

  const legacy = `/api/dcc/plugins/status${query ? `?${query}` : ''}`;

  const response = await dccGatewayFetch(primary, {}, { fallbackPathname: legacy });

  const data = await parseJson<DccPluginStatusResponse>(response);

  if (!response.ok || !data?.engines) {

    throw new Error(data?.error?.message || `Failed to load DCC environment status: HTTP ${response.status}`);

  }

  return data as DccPluginStatusResponse;

}



export async function runDccPluginManagerAction(payload: {

  engine: DccPluginEngine;

  action: DccPluginAction;

  projectPath?: string;

  engineRoot?: string;

  version?: string;

  allVersions?: boolean;

  build?: boolean;

  integrationMode?: string;

  captureMode?: string;

  previewMode?: string;

  enablePixelStreaming?: boolean;

  installScope?: 'project' | 'engine';

  engineLevel?: boolean;

}) {

  const response = await dccGatewayFetch('/api/dcc/environment/action', {

    method: 'POST',

    headers: {

      'Content-Type': 'application/json',

    },

    credentials: 'include',

    body: JSON.stringify(payload),

  }, { fallbackPathname: '/api/dcc/plugins/action' });

  const data = await parseJson<DccPluginActionResponse>(response);

  if (!response.ok || !data?.status) {

    throw new Error(data?.error?.message || `Failed to run DCC environment action: HTTP ${response.status}`);

  }

  assertOk(response, 'DCC environment action failed');

  return data as DccPluginActionResponse;

}



export async function fetchDccEnvironmentJobs(limit = 12) {

  const response = await dccGatewayFetch(`/api/dcc/environment/jobs?limit=${encodeURIComponent(String(limit))}`);

  const data = await parseJson<{ success: true; jobs: DccEnvironmentJob[] }>(response);

  if (response.status === 404) return [];

  if (!response.ok || !Array.isArray(data?.jobs)) {

    throw new Error(data?.error?.message || `Failed to load DCC environment jobs: HTTP ${response.status}`);

  }

  return data.jobs;

}



export async function fetchDccEnvironmentLogs(limit = 24) {

  const response = await dccGatewayFetch(`/api/dcc/environment/logs?limit=${encodeURIComponent(String(limit))}`);

  const data = await parseJson<{ success: true; logs: DccEnvironmentLogEntry[] }>(response);

  if (response.status === 404) return [];

  if (!response.ok || !Array.isArray(data?.logs)) {

    throw new Error(data?.error?.message || `Failed to load DCC environment logs: HTTP ${response.status}`);

  }

  return data.logs;

}



