/**
 * Phase 6（二）：海报「栅格化并入库」测试
 *
 * 验收点：
 *   1️⃣ 栅格化后的 PNG 写入「海报」(img-poster) 文件夹。
 *   2️⃣ 结果地址为本地媒体句柄，记录正确的宽高。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/services/localMediaRegistry', () => ({
  registerLocalMedia: (b: Blob) => `hmdao-local://poster-${Date.now()}`,
  resolveLocalMediaUrl: (h: string) => h,
  revokeLocalMedia: vi.fn(),
  hydrateLocalMediaRegistry: vi.fn(),
  isLocalMediaHandle: (r: string) => String(r || '').startsWith('hmdao-local://'),
}));

import { useAssetStore } from '@/store/useAssetStore';
import { commitPosterToLibrary, type PosterRasterProvider } from '@/services/posterRaster';

const fakeRaster: PosterRasterProvider = async () => new Blob(['png'], { type: 'image/png' });

describe('commitPosterToLibrary 海报栅格化入库', () => {
  beforeEach(() => {
    useAssetStore.setState({ items: [], folders: [] });
  });

  it('栅格化写入 img-poster 1 张并记录宽高', async () => {
    const { assetId, url } = await commitPosterToLibrary({
      svg: '<svg/>',
      width: 1280,
      height: 720,
      rasterProvider: fakeRaster,
    });
    expect(assetId).toBeTruthy();
    expect(url.startsWith('hmdao-local://')).toBe(true);

    const items = useAssetStore.getState().items;
    expect(items.length).toBe(1);
    expect(items[0].folderId).toBe('img-poster');
    expect(items[0].width).toBe(1280);
    expect(items[0].height).toBe(720);
    expect(items[0].type).toBe('image');
  });

  it('支持自定义名称与 folderId', async () => {
    await commitPosterToLibrary({
      svg: '<svg/>',
      width: 1024,
      height: 1024,
      name: '活动海报.png',
      folderId: 'img-node',
      rasterProvider: fakeRaster,
    });
    const item = useAssetStore.getState().items[0];
    expect(item.name).toBe('活动海报.png');
    expect(item.folderId).toBe('img-node');
  });
});
