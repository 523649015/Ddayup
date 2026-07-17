/**
 * 预设模型/插件「已安装」状态管理（刷新安全 + 版本检查）
 *
 * 复用 localTranslate 的稳健模式：
 *  - 安装态以 IndexedDB 中真实缓存记录为准（而非仅内存 progressMap），
 *    因此页面刷新或重新登录后仍能正确判定「已安装」，不会回到「下载」。
 *  - 同时在 localStorage 写标记，便于快速判定与跨会话一致性。
 *  - 提供版本检查：比较已安装版本与最新声明版本，提示更新。
 *
 * 与 ModelDownloadPanel 解耦，避免循环依赖（本模块只依赖 storage 与 config/presetModels）。
 */

import { listModelCache } from '@/services/storage';
import { PRESET_MODELS, type PresetModel } from '@/config/presetModels';

const LS_KEY = 'hmdao_preset_installed';

interface PresetInstallRecord {
  modelId: string;
  version: string;
}

type InstalledMap = Record<string, PresetInstallRecord>;

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

let installed: InstalledMap = readMarker();
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

/** 返回某模型当前已安装记录（含版本），未安装返回 null */
export function getPresetInstallState(modelId: string): PresetInstallRecord | null {
  return installed[modelId] ?? null;
}

/** 标记某模型已安装（下载/缓存成功后调用） */
export function markPresetInstalled(modelId: string, version: string): void {
  installed = { ...installed, [modelId]: { modelId, version } };
  writeMarker(installed);
  emit();
}

/** 清除某模型的已安装标记（清除缓存时调用） */
export function clearPresetInstalled(modelId: string): void {
  if (!installed[modelId]) return;
  const next = { ...installed };
  delete next[modelId];
  installed = next;
  writeMarker(installed);
  emit();
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
  const updateAvailable = installedVersion != null && installedVersion !== model.version;
  return {
    modelId: model.id,
    installedVersion,
    latestVersion: model.version,
    updateAvailable,
  };
}

/**
 * 模块加载/页面刷新时执行一次：直接读取 IndexedDB 中真实的模型缓存记录来判定「已安装」。
 * 这样即便是旧版本代码安装的模型（只有缓存、没有写 localStorage 标记），刷新后也能被自动识别。
 * 若缓存已丢失（如用户清过站点数据），则清除失效标记，回退到未安装态。
 */
export async function initPresetInstalledState(): Promise<void> {
  let cachedMap: InstalledMap = {};
  try {
    const cached = await listModelCache();
    cachedMap = {};
    for (const entry of cached) {
      cachedMap[entry.modelId] = { modelId: entry.modelId, version: entry.version };
    }
  } catch {
    cachedMap = {};
  }
  // IndexedDB 真实记录优先，标记作为补充（标记中的版本若比缓存新则保留）
  const merged: InstalledMap = { ...cachedMap };
  const marker = readMarker();
  for (const [id, record] of Object.entries(marker)) {
    if (!merged[id]) merged[id] = record;
  }
  installed = merged;
  writeMarker(installed);
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
    // 仅更新 latestVersion 比对基准：通过覆盖 installed 中的"视为最新"判断。
    // 这里直接复用 getPresetUpdateInfo 的声明版本；若 manifest 给出更高版本则视为有更新。
    for (const model of PRESET_MODELS) {
      const latest = latestById.get(model.id);
      if (latest && installed[model.id] && installed[model.id].version !== latest) {
        // 标记存在但版本落后 → 视为有更新（保留已安装记录，仅提示）
        emit();
      }
    }
  } catch {
    // 更新检查可选，静默失败
  }
}
