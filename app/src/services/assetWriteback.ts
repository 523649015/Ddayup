import { registerLocalMedia } from '@/services/localMediaRegistry';
import { useAssetStore } from '@/store/useAssetStore';

export interface CommitAssetInput {
  /** 处理结果二进制（优先）；传入后会自动注册为本地媒体句柄 */
  blob?: Blob;
  /** 结果地址（hmdao-local:// 句柄或远端 url）；与 blob 二选一 */
  url?: string;
  name?: string;
  type?: 'image' | 'video' | 'audio' | 'text';
  /** 归档到的素材文件夹 id，缺省落到「图片节点」(img-node) */
  folderId?: string;
  prompt?: string;
  sourceUrl?: string;
  width?: number;
  height?: number;
  duration?: number;
  tags?: string[];
  smartCategories?: string[];
  source?: 'upload' | 'web' | 'crawl' | 'generate';
}

export interface CommitAssetResult {
  assetId: string;
  url: string;
}

function isRenderable(url: string): boolean {
  if (!url) return false;
  return (
    url.startsWith('http') ||
    url.startsWith('hmdao-local://') ||
    url.startsWith('blob:') ||
    url.startsWith('data:') ||
    url.startsWith('/api/media-proxy')
  );
}

/**
 * 统一的「结果回写素材库」入口。
 * 云端生成 / 高清放大 / 宫格切分 / 海报栅格化 / 局部编辑 等所有图片节点产出
 * 都通过这里落地到用户的素材文件夹，确保写入路径一致、刷新安全。
 * - 传入 blob 会自动注册为本地媒体句柄（IndexedDB 持久化）
 * - 传入 url 则原样归档（需为可渲染地址）
 * - folderId 缺省落到「图片节点」(img-node)
 */
export function commitResultToAsset(input: CommitAssetInput): CommitAssetResult {
  let url = input.url;
  if (input.blob) {
    url = registerLocalMedia(input.blob);
  }
  if (!url || !isRenderable(url)) {
    throw new Error('commitResultToAsset: 缺少有效的可渲染结果地址（blob 或 url）。');
  }

  const assetId = useAssetStore.getState().addItem({
    name: input.name || `${input.type || 'image'}-${Date.now()}`,
    type: input.type || 'image',
    url,
    thumbnail: url,
    folderId: input.folderId || 'img-node',
    size: input.blob?.size ?? 0,
    width: input.width,
    height: input.height,
    duration: input.duration,
    prompt: input.prompt,
    sourceUrl: input.sourceUrl,
    tags: input.tags,
    smartCategories: input.smartCategories,
    source: input.source || 'generate',
  });

  return { assetId, url };
}
