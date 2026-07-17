/**
 * Phase 4：图片节点「局部编辑（笔刷）」路由服务测试
 *
 * 验收点：
 *   1️⃣ 注册本地修复处理器（Phase 7 的 LaMa）后，applyBrushEdit 走本地路径，
 *      结果写入「局部编辑」(img-brush) 文件夹，并返回 hmdao-local 句柄。
 *   2️⃣ 未注册本地处理器且未配置云端时，抛出友好的 BrushEditError(no-backend)，
 *      而非崩溃或静默失败。
 *   3️⃣ 本地处理器抛错时，包装为 BrushEditError(processing-failed)。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const registerLocalMediaMock = vi.fn((blob: Blob) => `hmdao-local://mock-${Date.now()}`);
vi.mock('@/services/localMediaRegistry', () => ({
  registerLocalMedia: (blob: Blob) => registerLocalMediaMock(blob),
  resolveLocalMediaUrl: (handle: string) => handle,
  revokeLocalMedia: vi.fn(),
  hydrateLocalMediaRegistry: vi.fn(),
}));

import { useAssetStore } from '@/store/useAssetStore';
import {
  applyBrushEdit,
  registerLocalInpaintHandler,
  getLocalInpaintHandler,
  BrushEditError,
} from '@/services/imageBrush';

const SRC = 'https://example.com/src.png';
const MASK = 'data:image/png;base64,AAAA';

describe('局部编辑路由服务', () => {
  beforeEach(() => {
    registerLocalInpaintHandler(null);
    useAssetStore.setState({ items: [], folders: [] });
    registerLocalMediaMock.mockClear();
  });

  afterEach(() => {
    registerLocalInpaintHandler(null);
  });

  it('注册本地处理器后走本地路径并写入 img-brush 文件夹', async () => {
    const handler = vi.fn(async () => ({
      blob: new Blob(['x'], { type: 'image/png' }),
      width: 512,
      height: 512,
      engine: 'lama',
    }));
    registerLocalInpaintHandler(handler);
    expect(getLocalInpaintHandler()).toBe(handler);

    const result = await applyBrushEdit({ imageUrl: SRC, mask: MASK, folderId: 'img-brush' });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(registerLocalMediaMock).toHaveBeenCalledTimes(1);
    expect(result.url.startsWith('hmdao-local://')).toBe(true);
    expect(result.width).toBe(512);
    expect(result.height).toBe(512);

    const items = useAssetStore.getState().items;
    expect(items.length).toBe(1);
    expect(items[0].folderId).toBe('img-brush');
    expect(items[0].type).toBe('image');
  });

  it('未注册本地处理器且无云端时抛出友好 no-backend 错误', async () => {
    let caught: BrushEditError | null = null;
    try {
      await applyBrushEdit({ imageUrl: SRC, mask: MASK });
    } catch (err) {
      caught = err as BrushEditError;
    }
    expect(caught).toBeInstanceOf(BrushEditError);
    expect(caught?.code).toBe('no-backend');
    expect(caught?.message).toContain('局部编辑');
  });

  it('本地处理器抛错时包装为 processing-failed', async () => {
    registerLocalInpaintHandler(async () => {
      throw new Error('lama-crash');
    });
    let caught: BrushEditError | null = null;
    try {
      await applyBrushEdit({ imageUrl: SRC, mask: MASK });
    } catch (err) {
      caught = err as BrushEditError;
    }
    expect(caught).not.toBeNull();
    expect(caught?.code).toBe('processing-failed');
  });
});
