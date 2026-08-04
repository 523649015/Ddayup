/**
 * 自动调色分析（Auto Color Grade）。
 *
 * 「一键式处理」第一步：自动分析图片/视频当前色调，推算曝光 / 对比 / 饱和 / 色温建议，
 * 使后续辉光、颗粒、运动模糊、景深叠加在已校正的基底上，整体观感统一。
 * 视频取首帧采样，等价于「分析视频当前色调自动调色」。
 */

export interface AutoGradeResult {
  exposure: number;
  contrast: number;
  saturation: number;
  temperature: number;
  vibrance: number;
  /** 平均亮度 0..1（用于诊断） */
  avgLuma: number;
  /** 色彩温度诊断：>0 偏暖，<0 偏冷 */
  warmBias: number;
}

export function analyzeAutoGrade(source: HTMLImageElement | HTMLCanvasElement): AutoGradeResult {
  const canvas = source instanceof HTMLCanvasElement ? source : toCanvas(source);
  const w = Math.min(canvas.width, 256);
  const h = Math.min(canvas.height, 256);
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  const ctx = tmp.getContext('2d')!;
  ctx.drawImage(canvas, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;

  let sumL = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    sumL += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    sumR += r / 255;
    sumG += g / 255;
    sumB += b / 255;
  }
  const avgLuma = sumL / n;
  const avgR = sumR / n;
  const avgG = sumG / n;
  const avgB = sumB / n;

  // 曝光：偏暗则正补偿，偏亮则负补偿（目标亮度 ~0.5）
  const exposure = clamp((0.5 - avgLuma) * 0.9, -0.4, 0.4);
  // 对比：低对比图自动加一点对比
  const contrast = clamp((0.5 - Math.abs(avgLuma - 0.5)) * 0.5, 0, 0.3);
  // 饱和：灰图补饱和，过艳收敛
  const chroma = Math.abs(avgR - avgG) + Math.abs(avgG - avgB) + Math.abs(avgR - avgB);
  const saturation = clamp(1 + (0.18 - chroma) * 0.6, 0.8, 1.3);
  const vibrance = clamp((0.5 - avgLuma) * 0.2 + 0.12, 0, 0.3);
  // 色温：R>B 偏暖(+)，B>R 偏冷(-)
  const warmBias = avgR - avgB;
  const temperature = clamp(warmBias * 0.8, -0.3, 0.3);

  return { exposure, contrast, saturation, temperature, vibrance, avgLuma, warmBias };
}

function toCanvas(img: HTMLImageElement): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext('2d')!.drawImage(img, 0, 0);
  return c;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
