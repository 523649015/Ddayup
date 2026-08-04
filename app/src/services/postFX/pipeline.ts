/**
 * 一键式后期管线（One-Click Post Pipeline）。
 *
 * 把按钮背后的算法编排成可独立运行的客户端链路，无需依赖服务器 ffmpeg wrapper：
 *   自动调色 → 辉光 → 电影颗粒 → 运动模糊 → 智能景深（主体锐利/背景模糊）
 * 以及独立的「一键智能抠像」。所有步骤均为纯浏览器 Canvas / ONNX 实现。
 *
 * 用法（PostNode 中新增的一键按钮直接调用）：
 *   const result = await applyCinematicOneClick(sourceUrl, { strength: 'auto' });
 *   // result.blob 作为结果节点输出
 */

import { analyzeAutoGrade, type AutoGradeResult } from './autoGrade';
import { applyMotionBlur, applyMotionBlurFromFlow, type OpticalFlowField } from './motionBlur';
import { applySmartDof } from './depthDof';
import { removeBackground, type MattingOptions, type MattingResult } from './matting';
import {
  labelConnectedComponents,
  extractComponentAlpha,
  cropComponentCanvas,
  type ComponentLabel,
} from './connectedComponents';
import {
  applyColorAdjustments,
  canvasToBlob,
  clamp,
  gaussianBlurCanvas,
  imageToCanvas,
  loadImageFromUrl,
} from './util';

export type CinematicStrength = 'light' | 'auto' | 'strong';

export interface CinematicOptions {
  strength?: CinematicStrength;
  /** 强制开启/关闭某步（默认按 strength 决定） */
  bloom?: boolean;
  grain?: boolean;
  motionBlur?: boolean;
  depthOfField?: boolean;
  /** 智能锐化（保留主体清晰） */
  sharpen?: boolean;
  /** 发光智能光晕（增强氛围） */
  glow?: boolean;
  /** 运动模糊角度（度） */
  motionAngle?: number;
  /** 运动模糊长度（像素） */
  motionLength?: number;
  /** 锐化强度 */
  sharpenAmount?: number;
  /** 光晕强度 */
  glowIntensity?: number;
}

const STRENGTH_PRESET: Record<CinematicStrength, {
  bloom: boolean; grain: boolean; motion: boolean; dof: boolean; sharpen: boolean; glow: boolean;
  bloomIntensity: number; grainAmount: number; motionLength: number; dofStrength: number;
  sharpenAmount: number; glowIntensity: number;
}> = {
  light: { bloom: true, grain: true, motion: false, dof: false, sharpen: true, glow: true, bloomIntensity: 0.22, grainAmount: 0.12, motionLength: 10, dofStrength: 0.2, sharpenAmount: 0.3, glowIntensity: 0.18 },
  auto: { bloom: true, grain: true, motion: true, dof: true, sharpen: true, glow: true, bloomIntensity: 0.36, grainAmount: 0.22, motionLength: 18, dofStrength: 0.34, sharpenAmount: 0.55, glowIntensity: 0.3 },
  strong: { bloom: true, grain: true, motion: true, dof: true, sharpen: true, glow: true, bloomIntensity: 0.5, grainAmount: 0.32, motionLength: 30, dofStrength: 0.5, sharpenAmount: 0.85, glowIntensity: 0.5 },
};

/** 简易天花板辉光：阈值提取高光 → 模糊 → 滤色叠加。 */
function applyBloom(source: HTMLCanvasElement, intensity: number): HTMLCanvasElement {
  const w = source.width;
  const h = source.height;
  const srcData = source.getContext('2d')!.getImageData(0, 0, w, h);
  const bright = document.createElement('canvas');
  bright.width = w;
  bright.height = h;
  const bctx = bright.getContext('2d')!;
  const bimg = bctx.createImageData(w, h);
  const threshold = 0.72;
  for (let i = 0; i < w * h; i++) {
    const si = i * 4;
    const l = (srcData.data[si] * 0.2126 + srcData.data[si + 1] * 0.7152 + srcData.data[si + 2] * 0.0722) / 255;
    const k = Math.max(0, (l - threshold) / (1 - threshold)) * intensity;
    bimg.data[si] = srcData.data[si] * k;
    bimg.data[si + 1] = srcData.data[si + 1] * k;
    bimg.data[si + 2] = srcData.data[si + 2] * k;
    bimg.data[si + 3] = 255;
  }
  bctx.putImageData(bimg, 0, 0);
  const blurred = gaussianBlurCanvas(bright, clamp(intensity * 24, 6, 40));
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d')!;
  octx.drawImage(source, 0, 0);
  octx.globalCompositeOperation = 'screen';
  octx.drawImage(blurred, 0, 0);
  octx.globalCompositeOperation = 'source-over';
  return out;
}

/** 胶片颗粒：基于随机噪声的叠加层。 */
function applyGrain(source: HTMLCanvasElement, amount: number, seed = 1234): HTMLCanvasElement {
  const w = source.width;
  const h = source.height;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d')!;
  octx.drawImage(source, 0, 0);
  const noise = octx.createImageData(w, h);
  let s = seed;
  for (let i = 0; i < w * h; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const n = ((s / 0x7fffffff) - 0.5) * amount * 90;
    const si = i * 4;
    noise.data[si] = noise.data[si + 1] = noise.data[si + 2] = 128 + n;
    noise.data[si + 3] = Math.abs(n) * 1.6;
  }
  const noiseCanvas = document.createElement('canvas');
  noiseCanvas.width = w;
  noiseCanvas.height = h;
  noiseCanvas.getContext('2d')!.putImageData(noise, 0, 0);
  octx.globalCompositeOperation = 'overlay';
  octx.globalAlpha = clamp(amount * 0.9, 0.04, 0.48);
  octx.drawImage(noiseCanvas, 0, 0);
  octx.globalAlpha = 1;
  octx.globalCompositeOperation = 'source-over';
  return out;
}

/** 智能锐化：非锐化掩膜（Unsharp Mask），按局部高频幅度自适应。
 *  平坦/低对比区域（多为噪声或天空）不放大，仅强化主体边缘细节 → 保留主体清晰、不产生噪点。 */
function applySharpen(source: HTMLCanvasElement, amount: number): HTMLCanvasElement {
  const w = source.width;
  const h = source.height;
  const sd = source.getContext('2d')!.getImageData(0, 0, w, h);
  // 1.4px 低通得到模糊版，做差得到高频（边缘/细节）
  const blurred = gaussianBlurCanvas(source, 1.4);
  const bd = blurred.getContext('2d')!.getImageData(0, 0, w, h);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d')!;
  const oimg = octx.createImageData(w, h);
  const s = sd.data;
  const b = bd.data;
  for (let i = 0; i < w * h; i++) {
    const si = i * 4;
    for (let c = 0; c < 3; c++) {
      const orig = s[si + c];
      const diff = orig - b[si + c];
      // 高频自适应：低频（平坦）区域 edge→0 不被放大；边缘细节 edge→1 全锐化
      const edge = Math.min(1, Math.abs(diff) / 22);
      const v = orig + diff * amount * edge;
      oimg.data[si + c] = clamp(Math.round(v), 0, 255);
    }
    oimg.data[si + 3] = 255;
  }
  octx.putImageData(oimg, 0, 0);
  return out;
}

/** 发光智能光晕：提取中高光区域 → 暖色调柔化 → 滤色叠加，营造氛围光晕。
 *  作为合成出片前的最后一步，让高光发散出柔和暖光，增强电影氛围感。 */
function applyGlow(source: HTMLCanvasElement, intensity: number): HTMLCanvasElement {
  const w = source.width;
  const h = source.height;
  const sd = source.getContext('2d')!.getImageData(0, 0, w, h);
  // 提取 0.35~1 亮度的「发光」区域（软阈值），并染上暖色（R 强、B 弱）增强氛围
  const bright = document.createElement('canvas');
  bright.width = w;
  bright.height = h;
  const bctx = bright.getContext('2d')!;
  const bimg = bctx.createImageData(w, h);
  const warm = [1.0, 0.9, 0.74];
  for (let i = 0; i < w * h; i++) {
    const si = i * 4;
    const l = (sd.data[si] * 0.2126 + sd.data[si + 1] * 0.7152 + sd.data[si + 2] * 0.0722) / 255;
    const k = Math.max(0, Math.min(1, (l - 0.35) / 0.65)) * intensity;
    bimg.data[si] = sd.data[si] * warm[0] * k;
    bimg.data[si + 1] = sd.data[si + 1] * warm[1] * k;
    bimg.data[si + 2] = sd.data[si + 2] * warm[2] * k;
    bimg.data[si + 3] = 255;
  }
  bctx.putImageData(bimg, 0, 0);
  const blurred = gaussianBlurCanvas(bright, clamp(intensity * 18, 8, 42));
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d')!;
  octx.drawImage(source, 0, 0);
  octx.globalCompositeOperation = 'screen';
  octx.drawImage(blurred, 0, 0);
  octx.globalCompositeOperation = 'source-over';
  return out;
}

export interface CinematicResult {
  blob: Blob;
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  engines: string[];
}

/** 一键电影感：自动调色 + 辉光 + 颗粒 + 运动模糊 + 智能景深。 */
export async function applyCinematicOneClick(
  source: HTMLImageElement | HTMLCanvasElement | string,
  options: CinematicOptions = {},
): Promise<CinematicResult> {
  const strength = options.strength ?? 'auto';
  const preset = STRENGTH_PRESET[strength];
  const img = typeof source === 'string' ? await loadImageFromUrl(source) : source;
  const baseCanvas = img instanceof HTMLCanvasElement ? img : imageToCanvas(img);
  const engines: string[] = [];

  // 1) 自动调色
  const grade = analyzeAutoGrade(baseCanvas);
  let current = applyColorAdjustments(baseCanvas, grade);
  engines.push('auto-grade');

  // 2) 辉光
  if (options.bloom ?? preset.bloom) {
    current = applyBloom(current, preset.bloomIntensity);
    engines.push('bloom');
  }

  // 3) 电影颗粒
  if (options.grain ?? preset.grain) {
    current = applyGrain(current, preset.grainAmount);
    engines.push('grain');
  }

  // 4) 运动模糊
  if (options.motionBlur ?? preset.motion) {
    const length = options.motionLength ?? preset.motionLength;
    current = applyMotionBlur(current, {
      length,
      angle: options.motionAngle ?? 0,
    });
    engines.push('motion-blur');
  }

  // 5) 智能景深（主体锐利、背景模糊）
  if (options.depthOfField ?? preset.dof) {
    if (img instanceof HTMLImageElement || img instanceof HTMLCanvasElement) {
      current = await applySmartDof(current, {
        blurStrength: preset.dofStrength,
        imageUrl: typeof source === 'string' ? source : undefined,
      });
      engines.push('smart-dof');
    }
  }

  // 6) 智能锐化（保留主体清晰，仅强化边缘细节、不放大噪声）
  if (options.sharpen ?? preset.sharpen) {
    current = applySharpen(current, options.sharpenAmount ?? preset.sharpenAmount);
    engines.push('smart-sharpen');
  }

  // 7) 发光智能光晕（增强氛围，合成出片前的最后一步）
  if (options.glow ?? preset.glow) {
    current = applyGlow(current, options.glowIntensity ?? preset.glowIntensity);
    engines.push('glow');
  }

  const blob = await canvasToBlob(current, 'image/png');
  return {
    blob,
    canvas: current,
    width: current.width,
    height: current.height,
    engines,
  };
}

/** 一键智能抠像（精确到发丝）。 */
export async function applyMattingOneClick(
  source: HTMLImageElement | HTMLCanvasElement | string,
  options: MattingOptions = {},
): Promise<MattingResult & { blob: Blob }> {
  const img = typeof source === 'string' ? await loadImageFromUrl(source) : source;
  const result = await removeBackground(img, options);
  const blob = await canvasToBlob(result.canvas, 'image/png');
  return { ...result, blob };
}

/** 多主体抠图结果项 */
export interface SubjectExtract {
  id: number;
  /** cropped RGBA canvas */
  canvas: HTMLCanvasElement;
  /** cropped RGBA blob (PNG) */
  blob: Blob;
  /** 主体在原图中的包围盒 */
  bbox: { x: number; y: number; width: number; height: number };
  /** 主体 alpha 全长遮罩（W*H，仅该主体像素有值） */
  alpha: Float32Array;
  /** 像素数 */
  pixelCount: number;
  /** 包围盒占比 */
  coverage: number;
}

/**
 * 多主体自动检测 + 提取：BiRefNet 推理 → 连通域分析拆分 → 逐主体裁剪。
 * 返回检测到的所有主体（按面积从大到小排序）。
 * @param minArea 最小主体面积（像素），< 此值的噪声忽略
 * @param padPx  裁剪包围盒 padding
 */
export async function detectAndExtractSubjects(
  source: HTMLImageElement | HTMLCanvasElement | string,
  options: MattingOptions & { minArea?: number; padPx?: number } = {},
): Promise<{ subjects: SubjectExtract[]; fullAlpha: Float32Array; srcW: number; srcH: number }> {
  const img = typeof source === 'string' ? await loadImageFromUrl(source) : source;
  const result = await removeBackground(img, options);

  const srcCanvas = img instanceof HTMLCanvasElement ? img : imageToCanvas(img);
  const srcW = srcCanvas.width;
  const srcH = srcCanvas.height;

  const minArea = options.minArea ?? 256;
  const padPx = options.padPx ?? 16;

  const { labels, components } = labelConnectedComponents(
    result.alpha,
    srcW,
    srcH,
    minArea,
    0.3,
  );

  const subjects: SubjectExtract[] = [];
  for (const comp of components) {
    const compAlpha = extractComponentAlpha(labels, result.alpha, comp.id, srcW, srcH);
    const canvas = cropComponentCanvas(srcCanvas, compAlpha, srcW, comp.bbox, padPx);
    const blob = await canvasToBlob(canvas, 'image/png');
    subjects.push({
      id: comp.id,
      canvas,
      blob,
      bbox: comp.bbox,
      alpha: compAlpha,
      pixelCount: comp.pixelCount,
      coverage: comp.pixelCount / (comp.bbox.width * comp.bbox.height),
    });
  }

  // 按面积降序
  subjects.sort((a, b) => b.pixelCount - a.pixelCount);

  return { subjects, fullAlpha: result.alpha, srcW, srcH };
}

/**
 * 生成主体检测预览图（原始图 + 半透明色块覆盖在每个主体区域）。
 * @param source       原图 canvas
 * @param components   检测到的组件列表
 * @param labels       连通域标签图
 * @param srcW/srcH    原图尺寸
 */
export function renderSubjectPreview(
  source: HTMLCanvasElement,
  components: ComponentLabel[],
  labels: Int32Array,
  srcW: number,
  srcH: number,
): HTMLCanvasElement {
  const colors = [
    [66, 133, 244, 100],   // 蓝
    [234, 67, 53, 100],    // 红
    [52, 168, 83, 100],    // 绿
    [251, 188, 4, 100],    // 黄
    [171, 71, 188, 100],   // 紫
    [0, 172, 193, 100],    // 青
    [255, 112, 67, 100],   // 橙
    [121, 85, 72, 100],    // 棕
  ];

  const out = document.createElement('canvas');
  out.width = srcW;
  out.height = srcH;
  const octx = out.getContext('2d')!;
  octx.drawImage(source, 0, 0);

  const imgData = octx.getImageData(0, 0, srcW, srcH);
  for (let i = 0; i < srcW * srcH; i++) {
    const lid = labels[i];
    if (lid === 0) continue;
    const c = colors[(lid - 1) % colors.length];
    const si = i * 4;
    const a = c[3] / 255;
    imgData.data[si] = Math.round(imgData.data[si] * (1 - a) + c[0] * a);
    imgData.data[si + 1] = Math.round(imgData.data[si + 1] * (1 - a) + c[1] * a);
    imgData.data[si + 2] = Math.round(imgData.data[si + 2] * (1 - a) + c[2] * a);
    // alpha 不变
  }
  octx.putImageData(imgData, 0, 0);

  // 画包围盒 + 编号
  octx.strokeStyle = 'rgba(255,255,255,0.8)';
  octx.lineWidth = 2;
  octx.font = 'bold 14px Inter, sans-serif';
  octx.textAlign = 'center';
  octx.textBaseline = 'middle';
  for (const comp of components) {
    const { x, y, width: w, height: h } = comp.bbox;
    octx.strokeRect(x, y, w, h);
    // 编号圆形背景
    const color = colors[comp.id % colors.length];
    const cx = x + w / 2;
    const cy = y + h / 2;
    octx.fillStyle = `rgb(${color[0]},${color[1]},${color[2]})`;
    octx.beginPath();
    octx.arc(cx, cy, 14, 0, Math.PI * 2);
    octx.fill();
    octx.fillStyle = '#fff';
    octx.fillText(String(comp.id + 1), cx, cy);
  }

  return out;
}

/**
 * 对单帧画布应用「一键电影感」全部步骤（自动调色 → 辉光 → 颗粒 → 运动模糊 → 智能景深）。
 * 供图片与视频逐帧复用：视频可按需传入预计算的 grade（首帧）以保时域一致。
 * @returns 处理后的画布
 */
export async function applyCinematicFrame(
  source: HTMLCanvasElement,
  options: CinematicOptions & { grade?: AutoGradeResult; opticalFlow?: OpticalFlowField } = {},
): Promise<HTMLCanvasElement> {
  const strength = options.strength ?? 'auto';
  const preset = STRENGTH_PRESET[strength];

  const grade = options.grade ?? analyzeAutoGrade(source);
  let current = applyColorAdjustments(source, grade);

  if (options.bloom ?? preset.bloom) {
    current = applyBloom(current, preset.bloomIntensity);
  }
  if (options.grain ?? preset.grain) {
    current = applyGrain(current, preset.grainAmount);
  }
  if (options.motionBlur ?? preset.motion) {
    if (options.opticalFlow) {
      current = applyMotionBlurFromFlow(current, options.opticalFlow, {
        maxLength: options.motionLength ?? preset.motionLength,
      });
    } else {
      current = applyMotionBlur(current, {
        length: options.motionLength ?? preset.motionLength,
        angle: options.motionAngle ?? 0,
      });
    }
  }
  if (options.depthOfField ?? preset.dof) {
    current = await applySmartDof(current, { blurStrength: preset.dofStrength });
  }
  // 智能锐化（保留主体清晰，仅强化边缘细节）
  if (options.sharpen ?? preset.sharpen) {
    current = applySharpen(current, options.sharpenAmount ?? preset.sharpenAmount);
  }
  // 发光智能光晕（增强氛围，合成出片前最后一步）
  if (options.glow ?? preset.glow) {
    current = applyGlow(current, options.glowIntensity ?? preset.glowIntensity);
  }
  return current;
}
