/**
 * 需求2 — 模型/插件安装态真实检测 + 版本检查（测试）
 *
 * 修复：模型下载面板「已安装」判定现已基于 IndexedDB 中真实缓存记录
 * （presetModelInstall.initPresetInstalledState），刷新/重登后不再回到「下载」；
 * 并提供版本检查（getPresetUpdateInfo）提示更新。
 *
 * 覆盖：
 *   ✅ listCachedModels 枚举 IndexedDB 中已缓存模型
 *   ✅ initPresetInstalledState 后 getPresetInstallState 返回已安装记录
 *   ✅ 模拟刷新（清空内存态与标记）后，再次 init 仍从 IndexedDB 判为已安装（核心 Bug 修复）
 *   ✅ 已安装版本落后时 getPresetUpdateInfo.updateAvailable 为 true
 *   ✅ 清除缓存后 clearPresetInstalled 回退未安装
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cacheModel, closeDB } from '@/services/storage';
import { listCachedModels } from '@/services/modelLoader';
import { PRESET_MODELS } from '@/config/presetModels';

const REAL_ESRGAN = PRESET_MODELS.find((m) => m.id === 'real-esrgan-x4')!;

describe('需求2：模型安装态从 IndexedDB 真实检测', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(async () => {
    // 关闭并删除 fake IndexedDB，避免连接残留导致进程不退出 / 跨用例污染
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

  it('不同版本的同一模型都应被枚举', async () => {
    await cacheModel('lama', '1.0.0', new ArrayBuffer(8));
    await cacheModel('lama', '1.1.0', new ArrayBuffer(8));

    const list = await listCachedModels();
    expect(list.filter((m) => m.modelId === 'lama').map((m) => m.version).sort()).toEqual([
      '1.0.0',
      '1.1.0',
    ]);
  });

  it('initPresetInstalledState 后 getPresetInstallState 返回已安装记录', async () => {
    await cacheModel('real-esrgan-x4', '1.0.0', new ArrayBuffer(16));
    const mod = await import('@/services/presetModelInstall');
    await mod.initPresetInstalledState();

    expect(mod.getPresetInstallState('real-esrgan-x4')).toEqual({
      modelId: 'real-esrgan-x4',
      version: '1.0.0',
    });
  });

  it('刷新后：仅依赖 IndexedDB 仍判定为已安装（修复刷新后回到「下载」）', async () => {
    await cacheModel('real-esrgan-x4', '1.0.0', new ArrayBuffer(16));
    const mod = await import('@/services/presetModelInstall');
    await mod.initPresetInstalledState();
    expect(mod.getPresetInstallState('real-esrgan-x4')).not.toBeNull();

    // 模拟刷新：内存态与 localStorage 标记清空（等同于页面重新加载后模块重新求值）
    mod.clearPresetInstalled('real-esrgan-x4');
    localStorage.removeItem('hmdao_preset_installed');
    expect(mod.getPresetInstallState('real-esrgan-x4')).toBeNull();

    // 面板挂载会再次调用 initPresetInstalledState，从 IndexedDB 真实记录重新判定
    await mod.initPresetInstalledState();
    expect(mod.getPresetInstallState('real-esrgan-x4')).not.toBeNull();
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

  it('清除缓存后回退未安装', async () => {
    await cacheModel('real-esrgan-x4', '1.0.0', new ArrayBuffer(16));
    const mod = await import('@/services/presetModelInstall');
    await mod.initPresetInstalledState();
    expect(mod.getPresetInstallState('real-esrgan-x4')).not.toBeNull();

    mod.clearPresetInstalled('real-esrgan-x4');
    expect(mod.getPresetInstallState('real-esrgan-x4')).toBeNull();
  });
});
