/**
 * 需求1 — 资产文件夹持久化（测试）
 *
 * 修复：useAssetStore 的 persist `partialize` 现已包含 `folders` 与 `items`，
 * 并在重水合时按 id 补齐图片节点专用文件夹树（临时素材/图片节点/{宫格切分,海报,…}），
 * 同时于启动时从 IndexedDB 恢复本地媒体句柄映射，使刷新后素材不再空白。
 *
 * 覆盖：
 *   ✅ 新建/重命名/删除文件夹被持久化（刷新后可恢复，不回退默认名）
 *   ✅ 默认即存在图片节点分类树
 *   ✅ 模拟刷新后，用户新建并重命名的文件夹仍保留
 *   ✅ 新增素材(item)及其重命名、所属文件夹被持久化
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAssetStore } from '@/store/useAssetStore';

const STORAGE_KEY = 'hmdao-asset-library';

function readPersisted() {
  const raw = localStorage.getItem(STORAGE_KEY);
  expect(raw).not.toBeNull();
  return JSON.parse(raw as string);
}

describe('需求1：资产文件夹持久化', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('新建文件夹应被持久化（刷新后可恢复）', () => {
    const id = useAssetStore.getState().createFolder('临时素材-图片节点-宫格切分', 'root');
    expect(useAssetStore.getState().folders.some((f) => f.id === id)).toBe(true);

    const persisted = readPersisted();
    expect(persisted.state.folders?.some((f: { id: string }) => f.id === id)).toBe(true);
  });

  it('重命名文件夹后，新名称应被持久化（刷新后不回退旧名）', () => {
    const id = useAssetStore.getState().createFolder('临时素材-旧名', 'root');
    useAssetStore.getState().renameFolder(id, '临时素材-新名');

    const persisted = readPersisted();
    expect(
      persisted.state.folders?.some(
        (f: { id: string; name: string }) => f.id === id && f.name === '临时素材-新名',
      ),
    ).toBe(true);
  });

  it('删除文件夹后，该文件夹不应再出现在持久化状态中', () => {
    const id = useAssetStore.getState().createFolder('临时素材-待删除', 'root');
    useAssetStore.getState().deleteFolder(id);

    const persisted = readPersisted();
    expect(persisted.state.folders?.some((f: { id: string }) => f.id === id)).toBe(false);
  });

  it('默认即存在图片节点分类树', () => {
    const folders = useAssetStore.getState().folders;
    expect(folders.some((f) => f.id === 'temp-root' && f.name === '临时素材')).toBe(true);
    expect(folders.some((f) => f.id === 'img-node' && f.name === '图片节点')).toBe(true);
    expect(folders.some((f) => f.id === 'img-grid' && f.name === '宫格切分')).toBe(true);
    expect(folders.some((f) => f.id === 'img-poster' && f.name === '海报')).toBe(true);
    expect(folders.some((f) => f.id === 'img-brush' && f.name === '局部编辑')).toBe(true);
    expect(folders.some((f) => f.id === 'img-compare' && f.name === '对比')).toBe(true);
  });

  it('刷新后：用户新建并重命名的文件夹仍保留（模拟页面刷新）', async () => {
    const id = useAssetStore.getState().createFolder('临时素材-持久化校验', 'root');
    useAssetStore.getState().renameFolder(id, '临时素材-改名后');

    // 模拟刷新：重置模块并重新求值（重水合从 localStorage 读取）
    vi.resetModules();
    const { useAssetStore: reloaded } = await import('@/store/useAssetStore');
    expect(
      reloaded.getState().folders.some((f) => f.id === id && f.name === '临时素材-改名后'),
    ).toBe(true);
    // 图片节点分类树在刷新后也仍然存在
    expect(reloaded.getState().folders.some((f) => f.id === 'img-grid')).toBe(true);
  });

  it('新增素材(item)及其重命名、所属文件夹应被持久化', () => {
    const itemId = useAssetStore.getState().addItem({
      name: '原始名.png',
      type: 'image',
      url: 'data:image/png;base64,xxxx',
      folderId: 'img-grid',
      size: 10,
    });
    useAssetStore.getState().renameItem(itemId, '重命名后.png');

    const persisted = readPersisted();
    const found = persisted.state.items?.find((x: { id: string }) => x.id === itemId);
    expect(found).toBeTruthy();
    expect(found.name).toBe('重命名后.png');
    expect(found.folderId).toBe('img-grid');
  });
});
