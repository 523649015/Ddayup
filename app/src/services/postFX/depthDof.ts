/**
 * 智能景深（Smart Depth-of-Field）—— 浏览器端真实深度驱动。
 *
 * 修复点（对比旧逻辑）：
 *   旧 server 链路依赖默认未配置的 Depth Anything CLI wrapper，回退到「整图模糊 + 手动矩形锐化」，
 *   既非深度驱动、也常把主体一并模糊（maskedmerge 的 0/1 硬边 + 焦点盒位置错即糊主体）。
 *   本模块改用项目已有的浏览器端 Depth Anything V2（estimateDepth），构建「近=锐利 / 远=模糊」
 *   的连续混合权重图：
 *     - 主体（近处）权重=0 → 完全保留锐利细节；
 *     - 背景（远处）权重=1 → 整体高斯模糊；
 *     - 中间用 smoothstep 平滑过渡，无硬边、无溢糊主体。
 *   可用于图片与视频（逐帧）。
 */

import { estimateDepth, isDepthModelReady, loadDepthModel } from '@/services/depthEstimation';
import {
  clamp,
  compositeByMask,
  gaussianBlurCanvas,
  imageToCanvas,
  loadImageFromUrl,
  smoothstep,
} from './util';

export interface SmartDofOptions {
  /** 模糊强度 0..1（控制最大模糊半径） */
  blurStrength?: number;
  /** 自动景深强度 0..1（越大，越远才被判定为失焦） */
  autoDepthStrength?: number;
  /** 焦点偏置 0..1（0=贴最近主体，1=焦点后移） */
  focusBias?: number;
  /** 过渡柔和度 0..1（越大边缘越柔） */
  feather?: number;
  /** 源图 URL（用于深度缓存 key） */
  imageUrl?: string;
}

/**
 * 对一张图应用智能景深。
 * @returns 合成后的画布（主体锐利、背景模糊）
 */
export async function applySmartDof(
  source: HTMLImageElement | HTMLCanvasElement,
  options: SmartDofOptions = {},
): Promise<HTMLCanvasElement> {
  const {
    blurStrength = 0.34,
    autoDepthStrength = 0.68,
    focusBias = 0,
    feather = 0.4,
    imageUrl,
  } = options;

  const width = source instanceof HTMLCanvasElement ? source.width : source.naturalWidth;
  const height = source instanceof HTMLCanvasElement ? source.height : source.naturalHeight;

  if (!isDepthModelReady()) {
    const loaded = await loadDepthModel();
    if (!loaded.ok) {
      throw new Error(`景深模型未就绪：${loaded.reason ?? 'unknown'}`);
    }
  }

  const img = source instanceof HTMLCanvasElement ? await canvasToImage(source) : source;
  const depth = await estimateDepth(img, imageUrl);

  // 归一化深度：nd=1 近（主体），nd=0 远（背景）
  let dMin = Infinity;
  let dMax = -Infinity;
  for (let i = 0; i < depth.data.length; i++) {
    const v = depth.data[i];
    if (v < dMin) dMin = v;
    if (v > dMax) dMax = v;
  }
  const dRange = dMax - dMin || 1;

  const focusFarStart = clamp(1 - autoDepthStrength * 0.7 - focusBias * 0.2, 0.1, 0.95);
  const focusFarEnd = clamp(focusFarStart + 0.12 + feather * 0.35, focusFarStart + 0.02, 1);

  const sharpCanvas = imageToCanvas(img);
  const sharpData = sharpCanvas.getContext('2d')!.getImageData(0, 0, width, height);

  // 背景最大模糊半径：与画布短边成比例，保证观感一致
  const maxBlur = clamp(blurStrength, 0, 1) * Math.max(6, Math.min(width, height) * 0.03);
  const blurredCanvas = gaussianBlurCanvas(sharpCanvas, maxBlur);
  const blurredData = blurredCanvas.getContext('2d')!.getImageData(0, 0, width, height);

  const mask = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const nd = (depth.data[i] - dMin) / dRange; // 0 远 -> 1 近
    const far = 1 - nd; // 0 近 -> 1 远
    // 只有「足够远」的区域才进入模糊，近处主体保持 0（锐利）
    mask[i] = smoothstep(focusFarStart, focusFarEnd, far);
  }

  return compositeByMask(sharpData, blurredData, mask, width, height);
}

async function canvasToImage(canvas: HTMLCanvasElement): Promise<HTMLImageElement> {
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas-to-blob-failed'))), 'image/png'),
  );
  const url = URL.createObjectURL(blob);
  const img = await loadImageFromUrl(url);
  URL.revokeObjectURL(url);
  return img;
}

/** 便捷入口：直接传 URL。 */
export async function applySmartDofFromUrl(
  url: string,
  options: SmartDofOptions = {},
): Promise<HTMLCanvasElement> {
  const img = await loadImageFromUrl(url);
  return applySmartDof(img, { ...options, imageUrl: url });
}
