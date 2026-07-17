/**
 * Phase 7：本地开源模型路由测试（HD→Real-ESRGAN / 去背→@imgly / brush→LaMa）
 *
 * 验收点：
 *   1️⃣ HD 未安装时抛 no-model；安装后放大并入库 img-hd。
 *   2️⃣ 去背未安装时抛 no-model；安装后入库 img-bg。
 *   3️⃣ LaMa 接入后，brush 走本地修复并入库 img-brush。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/services/localMediaRegistry', () => ({
  registerLocalMedia: (b: Blob) => `hmdao-local://m-${Date.now()}`,
  resolveLocalMediaUrl: (h: string) => h,
  revokeLocalMedia: vi.fn(),
  hydrateLocalMediaRegistry: vi.fn(),
  isLocalMediaHandle: (r: string) => String(r || '').startsWith('hmdao-local://'),
}));

import { useAssetStore } from '@/store/useAssetStore';
import {
  runLocalHdUpscale,
  removeImageBackground,
  wireLamaToInpaint,
  LocalModelError,
} from '@/services/imageModelRouting';
import { registerLocalModelRunner } from '@/services/localModelRunner';
import { applyBrushEdit } from '@/services/imageBrush';

const hdOut = { blob: new Blob(['x'], { type: 'image/png' }), width: 2048, height: 2048, engine: 'real-esrgan' };
const bgOut = { blob: new Blob(['x'], { type: 'image/png' }), width: 1024, height: 1024, engine: 'imgly' };
const lamaOut = { blob: new Blob(['x'], { type: 'image/png' }), width: 512, height: 512, engine: 'lama' };

describe('本地模型路由', () => {
  beforeEach(() => {
    useAssetStore.setState({ items: [], folders: [] });
    registerLocalModelRunner('real-esrgan-x4', null);
    registerLocalModelRunner('imgly-bgremoval', null);
    registerLocalModelRunner('lama-inpaint', null);
  });

  it('HD 未安装时抛 no-model', async () => {
    await expect(runLocalHdUpscale('u')).rejects.toBeInstanceOf(LocalModelError);
    await expect(runLocalHdUpscale('u')).rejects.toMatchObject({ code: 'no-model' });
  });

  it('HD 安装后放大并入库 img-hd', async () => {
    registerLocalModelRunner('real-esrgan-x4', async () => hdOut);
    const { url, assetId } = await runLocalHdUpscale('u');
    expect(assetId).toBeTruthy();
    expect(url.startsWith('hmdao-local://')).toBe(true);
    const items = useAssetStore.getState().items;
    expect(items.length).toBe(1);
    expect(items[0].folderId).toBe('img-hd');
    expect(items[0].width).toBe(2048);
  });

  it('去背未安装时抛 no-model', async () => {
    await expect(removeImageBackground('u')).rejects.toMatchObject({ code: 'no-model' });
  });

  it('去背安装后入库 img-bg', async () => {
    registerLocalModelRunner('imgly-bgremoval', async () => bgOut);
    const { assetId } = await removeImageBackground('u');
    expect(assetId).toBeTruthy();
    const item = useAssetStore.getState().items[0];
    expect(item.folderId).toBe('img-bg');
    expect(item.width).toBe(1024);
  });

  it('LaMa 接入后 brush 走本地修复并入库 img-brush', async () => {
    registerLocalModelRunner('lama-inpaint', async () => lamaOut);
    wireLamaToInpaint();
    const result = await applyBrushEdit({
      imageUrl: 'https://example.com/u.png',
      mask: 'data:image/png;base64,mask',
      folderId: 'img-brush',
    });
    expect(result.url.startsWith('hmdao-local://')).toBe(true);
    const item = useAssetStore.getState().items[0];
    expect(item.folderId).toBe('img-brush');
    expect(item.width).toBe(512);
  });
});
