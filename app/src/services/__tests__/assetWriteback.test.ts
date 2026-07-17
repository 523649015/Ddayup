/**
 * Phase 5：统一的「结果回写素材库」服务 commitResultToAsset 测试
 *
 * 验收点：
 *   1️⃣ 传入 blob 会自动注册为本地媒体句柄并写入指定文件夹（默认 img-node）。
 *   2️⃣ 仅传入 hmdao-local:// url（无 blob）时原样归档到目标文件夹。
 *   3️⃣ 既无 blob 也无有效 url 时抛出明确错误，绝不静默落地。
 *   4️⃣ 传 width/height/prompt/source 等元数据能正确写入素材项。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const registerLocalMediaMock = vi.fn((blob: Blob) => `hmdao-local://asset-${Date.now()}`);
vi.mock('@/services/localMediaRegistry', () => ({
  registerLocalMedia: (blob: Blob) => registerLocalMediaMock(blob),
  resolveLocalMediaUrl: (handle: string) => handle,
  revokeLocalMedia: vi.fn(),
  hydrateLocalMediaRegistry: vi.fn(),
  isLocalMediaHandle: (raw: string) => String(raw || '').startsWith('hmdao-local://'),
}));

import { useAssetStore } from '@/store/useAssetStore';
import { commitResultToAsset } from '@/services/assetWriteback';

describe('commitResultToAsset 统一回写', () => {
  beforeEach(() => {
    useAssetStore.setState({ items: [], folders: [] });
    registerLocalMediaMock.mockClear();
  });

  it('blob 自动注册为本地句柄并写入目标文件夹', () => {
    const blob = new Blob(['img'], { type: 'image/png' });
    const result = commitResultToAsset({
      blob,
      name: '高清-output.png',
      folderId: 'img-hd',
      width: 1024,
      height: 1024,
      prompt: 'upscale',
      source: 'generate',
    });

    expect(registerLocalMediaMock).toHaveBeenCalledTimes(1);
    expect(result.url.startsWith('hmdao-local://')).toBe(true);

    const items = useAssetStore.getState().items;
    expect(items.length).toBe(1);
    expect(items[0].folderId).toBe('img-hd');
    expect(items[0].width).toBe(1024);
    expect(items[0].height).toBe(1024);
    expect(items[0].prompt).toBe('upscale');
    expect(items[0].type).toBe('image');
  });

  it('仅传 hmdao-local url 时原样归档到默认 img-node', () => {
    const result = commitResultToAsset({
      url: 'hmdao-local://existing',
      name: '切分-1.png',
      source: 'generate',
    });
    expect(registerLocalMediaMock).not.toHaveBeenCalled();
    expect(result.url).toBe('hmdao-local://existing');

    const items = useAssetStore.getState().items;
    expect(items[0].folderId).toBe('img-node');
  });

  it('无 blob 且无有效 url 时抛出明确错误', () => {
    expect(() => commitResultToAsset({ name: 'bad' } as never)).toThrow(/有效的可渲染结果/);
    expect(useAssetStore.getState().items.length).toBe(0);
  });

  it('video 类型与元数据贯通写入', () => {
    const result = commitResultToAsset({
      url: 'https://example.com/clip.mp4',
      type: 'video',
      name: '成片.mp4',
      folderId: 'img-node',
      width: 1920,
      height: 1080,
      source: 'generate',
    });
    expect(result.url).toBe('https://example.com/clip.mp4');
    const item = useAssetStore.getState().items[0];
    expect(item.type).toBe('video');
    expect(item.width).toBe(1920);
    expect(item.height).toBe(1080);
  });
});
