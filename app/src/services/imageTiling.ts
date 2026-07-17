import { commitResultToAsset } from '@/services/assetWriteback';
import { resolveLocalMediaUrl } from '@/services/localMediaRegistry';
import { canvasToBlob, loadImageElement } from '@/services/canvasUtils';

export type TileSliceProvider = (
  source: CanvasImageSource,
  naturalWidth: number,
  naturalHeight: number,
  rows: number,
  cols: number,
) => Promise<Blob[]>;

/** 默认切片实现：用 canvas 逐格裁切 */
const canvasSliceProvider: TileSliceProvider = async (source, naturalWidth, naturalHeight, rows, cols) => {
  const tiles: Blob[] = [];
  const cellW = Math.floor(naturalWidth / cols);
  const cellH = Math.floor(naturalHeight / rows);
  if (cellW <= 0 || cellH <= 0) {
    throw new Error('sliceImageIntoTiles: 图像尺寸不足以切分为指定行列');
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const canvas = document.createElement('canvas');
      canvas.width = cellW;
      canvas.height = cellH;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('sliceImageIntoTiles: 无法获取 2D 上下文');
      ctx.drawImage(source, c * cellW, r * cellH, cellW, cellH, 0, 0, cellW, cellH);
      // eslint-disable-next-line no-await-in-loop
      tiles.push(await canvasToBlob(canvas));
    }
  }
  return tiles;
};

export interface SplitToLibraryOptions {
  sourceImageUrl: string;
  rows: number;
  cols: number;
  /** 归档文件夹 id，默认「宫格切分」(img-grid) */
  folderId?: string;
  /** 测试/自定义：直接提供已加载的图像源，跳过网络加载 */
  source?: HTMLImageElement | HTMLCanvasElement;
  /** 测试/自定义：切片实现，默认走 canvas */
  sliceProvider?: TileSliceProvider;
}

export interface SplitToLibraryResult {
  assetIds: string[];
  count: number;
}

/**
 * 宫格切分并入库：将源图按 rows×cols 切成等大小图块，
 * 逐块提交到指定素材文件夹（默认 img-grid），返回写入的 assetId 列表。
 * 真正的像素裁切在浏览器中由 canvas 完成；切分产物通过统一回写服务落地。
 */
export async function splitImageToLibrary(opts: SplitToLibraryOptions): Promise<SplitToLibraryResult> {
  const provider = opts.sliceProvider || canvasSliceProvider;
  const folderId = opts.folderId || 'img-grid';

  let source = opts.source;
  let natW = 0;
  let natH = 0;
  if (!source) {
    const resolved = resolveLocalMediaUrl(opts.sourceImageUrl) || opts.sourceImageUrl;
    source = await loadImageElement(resolved);
  }
  const img = source as HTMLImageElement;
  const canvas = source as HTMLCanvasElement;
  natW = img.naturalWidth || canvas.width || 0;
  natH = img.naturalHeight || canvas.height || 0;
  if (!natW || !natH) {
    throw new Error('splitImageToLibrary: 无法读取源图尺寸');
  }

  const tiles = await provider(source, natW, natH, opts.rows, opts.cols);
  const tileW = Math.floor(natW / opts.cols);
  const tileH = Math.floor(natH / opts.rows);
  const assetIds: string[] = [];
  tiles.forEach((blob, index) => {
    const r = Math.floor(index / opts.cols) + 1;
    const c = (index % opts.cols) + 1;
    const committed = commitResultToAsset({
      blob,
      name: `切分-r${r}-c${c}.png`,
      type: 'image',
      folderId,
      width: tileW,
      height: tileH,
      source: 'generate',
    });
    assetIds.push(committed.assetId);
  });
  return { assetIds, count: assetIds.length };
}
