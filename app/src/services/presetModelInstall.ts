/**
 * 预设模型/插件「已安装」状态管理（刷新安全 + 真缓存校验 + 版本检查）
 *
 * 规则：
 *  - 只有「安装标记 + 真实缓存完整」同时满足时，才对外判定为已安装。
 *  - 若只剩 localStorage 标记、主模型或外部权重丢失，则显示为「待修复」而非「已安装」。
 *  - 仍保留安装标记，便于面板提供「修复 / 重新下载」入口。
 */

import { getCachedModel, listModelCache } from '@/services/storage';
import { PRESET_MODELS, type PresetModel } from '@/config/presetModels';

const LS_KEY = 'hmdao_preset_installed';

interface PresetInstallRecord {
  modelId: string;
  version: string;
}

type InstalledMap = Record<string, PresetInstallRecord>;

export interface PresetInstallHealth {
  modelId: string;
  status: 'not-installed' | 'installed' | 'needs-repair';
  installedVersion: string | null;
  markerVersion: string | null;
  cachedVersion: string | null;
  hasMarker: boolean;
  hasMainCache: boolean;
  missingFiles: string[];
  message: string;
}

function readMarker(): InstalledMap {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '{}') as InstalledMap;
  } catch {
    return {};
  }
}

function writeMarker(map: InstalledMap): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(map));
  } catch {
    // 存储不可用时忽略
  }
}

function shouldValidateCache(model: PresetModel | undefined): boolean {
  return Boolean(model?.url);
}

function buildNotInstalledHealth(modelId: string): PresetInstallHealth {
  return {
    modelId,
    status: 'not-installed',
    installedVersion: null,
    markerVersion: null,
    cachedVersion: null,
    hasMarker: false,
    hasMainCache: false,
    missingFiles: [],
    message: '未安装',
  };
}

function buildInstalledHealth(
  modelId: string,
  installedVersion: string,
  markerVersion: string | null,
  cachedVersion: string | null,
  hasMainCache: boolean,
  message = '已安装',
): PresetInstallHealth {
  return {
    modelId,
    status: 'installed',
    installedVersion,
    markerVersion,
    cachedVersion,
    hasMarker: markerVersion != null,
    hasMainCache,
    missingFiles: [],
    message,
  };
}

function buildRepairHealth(
  modelId: string,
  installedVersion: string | null,
  markerVersion: string | null,
  cachedVersion: string | null,
  hasMainCache: boolean,
  missingFiles: string[],
  message: string,
): PresetInstallHealth {
  return {
    modelId,
    status: 'needs-repair',
    installedVersion,
    markerVersion,
    cachedVersion,
    hasMarker: markerVersion != null,
    hasMainCache,
    missingFiles,
    message,
  };
}

let installed: InstalledMap = {};
let installHealthMap: Record<string, PresetInstallHealth> = {};
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((fn) => fn());
}

export function subscribePresetInstall(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 返回某模型当前真实可用的已安装记录（缓存缺失时返回 null） */
export function getPresetInstallState(modelId: string): PresetInstallRecord | null {
  return installed[modelId] ?? null;
}

/** 返回某模型的安装健康状态，用于面板展示「已安装 / 待修复 / 未安装」 */
export function getPresetInstallHealth(modelId: string): PresetInstallHealth {
  return installHealthMap[modelId] ?? buildNotInstalledHealth(modelId);
}

/** 标记某模型已安装（下载/缓存成功后调用） */
export function markPresetInstalled(modelId: string, version: string): void {
  const nextMarker = { ...readMarker(), [modelId]: { modelId, version } };
  const model = PRESET_MODELS.find((item) => item.id === modelId);
  installed = { ...installed, [modelId]: { modelId, version } };
  installHealthMap = {
    ...installHealthMap,
    [modelId]: buildInstalledHealth(
      modelId,
      version,
      version,
      shouldValidateCache(model) ? version : null,
      shouldValidateCache(model),
    ),
  };
  writeMarker(nextMarker);
  emit();
}

/** 清除某模型的已安装标记（清除缓存时调用） */
export function clearPresetInstalled(modelId: string): void {
  const marker = readMarker();
  const hadMarker = Boolean(marker[modelId]);
  if (hadMarker) delete marker[modelId];

  const nextInstalled = { ...installed };
  delete nextInstalled[modelId];
  installed = nextInstalled;
  installHealthMap = {
    ...installHealthMap,
    [modelId]: buildNotInstalledHealth(modelId),
  };

  if (hadMarker || installHealthMap[modelId] || nextInstalled[modelId]) {
    writeMarker(marker);
    emit();
  }
}

export interface PresetUpdateInfo {
  modelId: string;
  installedVersion: string | null;
  latestVersion: string;
  updateAvailable: boolean;
}

/** 计算某模型的版本更新信息（离线优先：以声明的最新版本为准） */
export function getPresetUpdateInfo(model: PresetModel): PresetUpdateInfo {
  const record = installed[model.id];
  const installedVersion = record?.version ?? null;
  if (model.supersededBy) {
    const successor = PRESET_MODELS.find((m) => m.id === model.supersededBy);
    if (successor && installedVersion != null) {
      return {
        modelId: model.id,
        installedVersion,
        latestVersion: successor.version,
        updateAvailable: true,
      };
    }
  }
  const updateAvailable = installedVersion != null && installedVersion !== model.version;
  return {
    modelId: model.id,
    installedVersion,
    latestVersion: model.version,
    updateAvailable,
  };
}

async function resolveInstallHealth(
  modelId: string,
  markerRecord: PresetInstallRecord | undefined,
  cachedVersions: string[],
): Promise<{ record: PresetInstallRecord | null; health: PresetInstallHealth }> {
  const model = PRESET_MODELS.find((item) => item.id === modelId);
  const markerVersion = markerRecord?.version ?? null;
  const exactMarkerVersion = markerVersion && cachedVersions.includes(markerVersion) ? markerVersion : null;
  const preferredCachedVersion =
    exactMarkerVersion ??
    (model && cachedVersions.includes(model.version) ? model.version : null) ??
    cachedVersions[0] ??
    null;

  if (!markerVersion && !preferredCachedVersion) {
    return { record: null, health: buildNotInstalledHealth(modelId) };
  }

  if (!shouldValidateCache(model)) {
    const installedVersion = preferredCachedVersion ?? markerVersion;
    if (!installedVersion) {
      return { record: null, health: buildNotInstalledHealth(modelId) };
    }
    return {
      record: { modelId, version: installedVersion },
      health: buildInstalledHealth(
        modelId,
        installedVersion,
        markerVersion,
        preferredCachedVersion,
        preferredCachedVersion != null,
        preferredCachedVersion && !markerVersion ? '已从缓存恢复' : '已安装',
      ),
    };
  }

  if (!preferredCachedVersion) {
    return {
      record: null,
      health: buildRepairHealth(
        modelId,
        markerVersion,
        markerVersion,
        null,
        false,
        ['model'],
        '安装标记存在，但主模型缓存缺失，需修复或重新下载',
      ),
    };
  }

  const mainCache = await getCachedModel(modelId, preferredCachedVersion);
  if (!mainCache?.data || mainCache.data.byteLength === 0) {
    return {
      record: null,
      health: buildRepairHealth(
        modelId,
        markerVersion ?? preferredCachedVersion,
        markerVersion,
        preferredCachedVersion,
        false,
        ['model'],
        '主模型缓存损坏或为空，请修复后重试',
      ),
    };
  }

  const missingFiles: string[] = [];
  for (const ef of model?.extraFiles ?? []) {
    const extraCache = await getCachedModel(modelId, `${preferredCachedVersion}#${ef.name}`);
    if (!extraCache?.data || extraCache.data.byteLength === 0) {
      missingFiles.push(ef.name);
    }
  }

  if (missingFiles.length > 0) {
    return {
      record: null,
      health: buildRepairHealth(
        modelId,
        markerVersion ?? preferredCachedVersion,
        markerVersion,
        preferredCachedVersion,
        true,
        missingFiles,
        `外部权重缺失：${missingFiles.join('、')}，请修复后重试`,
      ),
    };
  }

  return {
    record: { modelId, version: preferredCachedVersion },
    health: buildInstalledHealth(
      modelId,
      preferredCachedVersion,
      markerVersion,
      preferredCachedVersion,
      true,
      preferredCachedVersion && !markerVersion ? '已从缓存恢复' : '已安装',
    ),
  };
}

/**
 * 模块加载/页面刷新时执行一次：
 *  - 从 IndexedDB 真实缓存恢复已安装状态；
 *  - 将仅有标记但缓存缺失的模型标记为待修复；
 *  - 兼容旧版本仅写缓存、未写 localStorage 标记的模型。
 */
export async function initPresetInstalledState(): Promise<void> {
  let cachedVersionsById: Record<string, string[]> = {};
  try {
    const cached = await listModelCache();
    cachedVersionsById = {};
    for (const entry of cached) {
      if (entry.version.includes('#')) continue;
      cachedVersionsById[entry.modelId] ??= [];
      cachedVersionsById[entry.modelId].push(entry.version);
    }
  } catch {
    cachedVersionsById = {};
  }

  const marker = readMarker();
  const nextInstalled: InstalledMap = {};
  const nextHealth: Record<string, PresetInstallHealth> = {};
  const allIds = new Set<string>([
    ...Object.keys(marker),
    ...Object.keys(cachedVersionsById),
    ...PRESET_MODELS.map((model) => model.id),
  ]);

  for (const modelId of allIds) {
    const resolved = await resolveInstallHealth(modelId, marker[modelId], cachedVersionsById[modelId] ?? []);
    nextHealth[modelId] = resolved.health;
    if (resolved.record) nextInstalled[modelId] = resolved.record;
  }

  installed = nextInstalled;
  installHealthMap = nextHealth;

  const mergedMarker: InstalledMap = { ...marker };
  for (const [id, record] of Object.entries(nextInstalled)) {
    if (!mergedMarker[id]) mergedMarker[id] = record;
  }
  writeMarker(mergedMarker);
  emit();
}

/**
 * 检查更新：以声明的最新版本为准（离线优先）。
 * 若后端提供 /api/models/manifest（JSON: { id: version }），则以其为准进行更精确比对；
 * 请求失败则静默回退到声明版本比对，不影响主流程。
 */
export async function checkPresetUpdates(): Promise<void> {
  try {
    const response = await fetch('/api/models/manifest', { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return;
    const manifest = (await response.json()) as Record<string, string> | null;
    if (!manifest) return;
    const latestById = new Map<string, string>();
    for (const model of PRESET_MODELS) {
      const fromManifest = manifest[model.id];
      if (fromManifest) latestById.set(model.id, fromManifest);
    }
    for (const model of PRESET_MODELS) {
      const latest = latestById.get(model.id);
      if (latest && installed[model.id] && installed[model.id].version !== latest) {
        emit();
      }
    }
  } catch {
    // 更新检查可选，静默失败
  }
}
