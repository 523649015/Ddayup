import { commitResultToAsset } from '@/services/assetWriteback';
import { canvasToBlob, loadImageElement } from '@/services/canvasUtils';

export type PosterRasterProvider = (svg: string, width: number, height: number) => Promise<Blob>;

/** 默认栅格化实现：SVG → Blob → Image → canvas → PNG Blob */
const svgRasterProvider: PosterRasterProvider = async (svg, width, height) => {
  const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);
  try {
    const img = await loadImageElement(url);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('posterRaster: 无法获取 2D 上下文');
    ctx.drawImage(img, 0, 0, width, height);
    return await canvasToBlob(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
};

export interface CommitPosterOptions {
  svg: string;
  width: number;
  height: number;
  /** 归档文件夹 id，默认「海报」(img-poster) */
  folderId?: string;
  name?: string;
  /** 测试/自定义：栅格化实现，默认走 SVG→canvas */
  rasterProvider?: PosterRasterProvider;
}

export interface CommitPosterResult {
  assetId: string;
  url: string;
}

/**
 * 海报栅格化并入库：将可编辑海报（SVG）渲染为 PNG，提交到素材文件夹
 * （默认 img-poster）。结果地址为刷新安全的本地媒体句柄。
 */
export async function commitPosterToLibrary(opts: CommitPosterOptions): Promise<CommitPosterResult> {
  const provider = opts.rasterProvider || svgRasterProvider;
  const blob = await provider(opts.svg, opts.width, opts.height);
  const committed = commitResultToAsset({
    blob,
    name: opts.name || `海报-${Date.now()}.png`,
    type: 'image',
    folderId: opts.folderId || 'img-poster',
    width: opts.width,
    height: opts.height,
    source: 'generate',
  });
  return { assetId: committed.assetId, url: committed.url };
}
