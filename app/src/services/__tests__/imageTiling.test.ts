/**
 * Phase 6（一）：宫格切分「切分并入库」测试
 *
 * 验收点：
 *   1️⃣ 3x3 切分把 9 张图块写入「宫格切分」(img-grid) 文件夹。
 *   2️⃣ 支持自定义 folderId。
 *   3️⃣ 切分数量与 assetId 数量一致，均为 image 类型。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/services/localMediaRegistry', () => ({
  registerLocalMedia: (b: Blob) => `hmdao-local://t-${Date.now()}`,
  resolveLocalMediaUrl: (h: string) => h,
  revokeLocalMedia: vi.fn(),
  hydrateLocalMediaRegistry: vi.fn(),
  isLocalMediaHandle: (r: string) => String(r || '').startsWith('hmdao-local://'),
}));

import { useAssetStore } from '@/store/useAssetStore';
import { splitImageToLibrary, type TileSliceProvider } from '@/services/imageTiling';

const fakeSource = { naturalWidth: 900, naturalHeight: 900 } as HTMLImageElement;
const fakeSlice: TileSliceProvider = async (_s, _w, _h, rows, cols) =>
  Array.from({ length: rows * cols }).map(() => new Blob(['x'], { type: 'image/png' }));

describe('splitImageToLibrary 宫格切分入库', () => {
  beforeEach(() => {
    useAssetStore.setState({ items: [], folders: [] });
  });

  it('3x3 切分写入 img-grid 共 9 张', async () => {
    const { assetIds, count } = await splitImageToLibrary({
      sourceImageUrl: 'x',
      rows: 3,
      cols: 3,
      source: fakeSource,
      sliceProvider: fakeSlice,
    });
    expect(count).toBe(9);
    expect(assetIds.length).toBe(9);

    const items = useAssetStore.getState().items;
    expect(items.length).toBe(9);
    expect(items.every((i) => i.folderId === 'img-grid')).toBe(true);
    expect(items.every((i) => i.type === 'image')).toBe(true);
  });

  it('支持自定义 folderId', async () => {
    await splitImageToLibrary({
      sourceImageUrl: 'x',
      rows: 2,
      cols: 2,
      folderId: 'img-multi',
      source: fakeSource,
      sliceProvider: fakeSlice,
    });
    const items = useAssetStore.getState().items;
    expect(items.length).toBe(4);
    expect(items.every((i) => i.folderId === 'img-multi')).toBe(true);
  });
});
