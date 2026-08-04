/**
 * 需求2 — 模型/插件安装态真实检测 + 修复态提示（测试）
 *
 * 覆盖：
 *   ✅ listCachedModels 枚举 IndexedDB 中已缓存模型
 *   ✅ initPresetInstalledState 后 getPresetInstallState 仅在真实缓存完整时返回已安装
 *   ✅ 模拟刷新后仍能从 IndexedDB 恢复已安装态
 *   ✅ 已安装版本落后时 getPresetUpdateInfo.updateAvailable 为 true
 *   ✅ 仅有安装标记但缓存缺失时，状态转为 needs-repair
 *   ✅ 拆分式模型缺失外部权重时，状态转为 needs-repair
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cacheModel, closeDB } from '@/services/storage';
import { listCachedModels } from '@/services/modelLoader';
import { PRESET_MODELS } from '@/config/presetModels';

const REAL_ESRGAN = PRESET_MODELS.find((m) => m.id === 'real-esrgan-x4')!;
const DEPTH_V3 = PRESET_MODELS.find((m) => m.id === 'depth-anything-v3-base')!;

describe('需求2：模型安装态从真实缓存检测', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(async () => {
    try {
      await closeDB();
    } catch {
      /* noop */
    }
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase('hmdao-storage');
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  });

  it('listCachedModels 枚举已缓存的 preset 模型', async () => {
    await cacheModel('real-esrgan-x4', '1.0.0', new ArrayBuffer(16));

    const list = await listCachedModels();
    expect(list.some((m) => m.modelId === 'real-esrgan-x4' && m.version === '1.0.0')).toBe(true);
  });

  it('initPresetInstalledState 后仅在真实缓存存在时返回已安装记录', async () => {
    await cacheModel('real-esrgan-x4', '1.0.0', new ArrayBuffer(16));
    const mod = await import('@/services/presetModelInstall');
    await mod.initPresetInstalledState();

    expect(mod.getPresetInstallState('real-esrgan-x4')).toEqual({
      modelId: 'real-esrgan-x4',
      version: '1.0.0',
    });
    expect(mod.getPresetInstallHealth('real-esrgan-x4').status).toBe('installed');
  });

  it('刷新后：仅依赖 IndexedDB 仍判定为已安装', async () => {
    await cacheModel('real-esrgan-x4', '1.0.0', new ArrayBuffer(16));
    const mod = await import('@/services/presetModelInstall');
    await mod.initPresetInstalledState();
    expect(mod.getPresetInstallState('real-esrgan-x4')).not.toBeNull();

    mod.clearPresetInstalled('real-esrgan-x4');
    localStorage.removeItem('hmdao_preset_installed');
    expect(mod.getPresetInstallState('real-esrgan-x4')).toBeNull();

    await mod.initPresetInstalledState();
    expect(mod.getPresetInstallState('real-esrgan-x4')).not.toBeNull();
    expect(mod.getPresetInstallHealth('real-esrgan-x4').status).toBe('installed');
  });

  it('已安装版本落后时提示更新', async () => {
    await cacheModel('real-esrgan-x4', '0.9.0', new ArrayBuffer(16));
    const mod = await import('@/services/presetModelInstall');
    await mod.initPresetInstalledState();

    const info = mod.getPresetUpdateInfo(REAL_ESRGAN);
    expect(info.installedVersion).toBe('0.9.0');
    expect(info.latestVersion).toBe('1.0.0');
    expect(info.updateAvailable).toBe(true);
  });

  it('仅有安装标记但主缓存缺失时转为待修复', async () => {
    localStorage.setItem(
      'hmdao_preset_installed',
      JSON.stringify({
        'birefnet-matting': { modelId: 'birefnet-matting', version: '1.0.0' },
      }),
    );
    const mod = await import('@/services/presetModelInstall');
    await mod.initPresetInstalledState();

    expect(mod.getPresetInstallState('birefnet-matting')).toBeNull();
    expect(mod.getPresetInstallHealth('birefnet-matting')).toMatchObject({
      status: 'needs-repair',
      hasMarker: true,
      hasMainCache: false,
      missingFiles: ['model'],
    });
  });

  it('拆分式模型缺少外部权重时转为待修复', async () => {
    await cacheModel(DEPTH_V3.id, DEPTH_V3.version, new ArrayBuffer(16));
    const mod = await import('@/services/presetModelInstall');
    await mod.initPresetInstalledState();

    expect(mod.getPresetInstallState(DEPTH_V3.id)).toBeNull();
    expect(mod.getPresetInstallHealth(DEPTH_V3.id)).toMatchObject({
      status: 'needs-repair',
      hasMainCache: true,
      missingFiles: ['model.onnx_data'],
    });
  });
});
