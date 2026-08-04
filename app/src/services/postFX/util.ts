/**
 * postFX 共享工具：图片加载、画布转换、归一化、卷积与混合原语。
 *
 * 设计原则：
 *   - 所有后期效果引擎都是「纯函数 + 浏览器 ONNX」，不依赖未配置的服务器 ffmpeg wrapper。
 *   - 输入统一为 HTMLImageElement / HTMLCanvasElement，输出为 HTMLCanvasElement / Blob。
 *   - 这样按钮（调色/辉光/颗粒/景深/运动模糊/抠像）只是「功能调取入口」，
 *     真正的算法全部下沉到 app/src/services/postFX/* 模块，PostNode 只负责编排与预览。
 */

export function loadImageFromUrl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error(`postFX-load-failed:${url}`));
    img.src = url;
  });
}

export function imageToCanvas(img: HTMLImageElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  return canvas;
}

export function canvasToImageData(canvas: HTMLCanvasElement): ImageData {
  return canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0 || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}

/** 按 alpha 在 sharp 与 blurred 之间逐像素混合，得到「近处锐利、远处模糊」的合成图。 */
export function compositeByMask(
  sharp: ImageData,
  blurred: ImageData,
  mask: Float32Array,
  width: number,
  height: number,
): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d')!;
  const result = ctx.createImageData(width, height);
  const rd = result.data;
  for (let i = 0; i < width * height; i++) {
    const m = clamp(mask[i], 0, 1);
    const si = i * 4;
    rd[si] = sharp.data[si] * (1 - m) + blurred.data[si] * m;
    rd[si + 1] = sharp.data[si + 1] * (1 - m) + blurred.data[si + 1] * m;
    rd[si + 2] = sharp.data[si + 2] * (1 - m) + blurred.data[si + 2] * m;
    rd[si + 3] = 255;
  }
  ctx.putImageData(result, 0, 0);
  return out;
}

/** 高斯模糊（基于 canvas filter 的多趟近似，radius 越大越糊）。 */
export function gaussianBlurCanvas(
  source: HTMLCanvasElement,
  radius: number,
): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = source.width;
  out.height = source.height;
  const ctx = out.getContext('2d')!;
  ctx.filter = `blur(${radius}px)`;
  ctx.drawImage(source, 0, 0);
  ctx.filter = 'none';
  return out;
}

/** 用 CSS 滤镜把色彩调整（曝光/对比/饱和/色温）应用到画布，供自动调色与一键管线复用。 */
export function applyColorAdjustments(
  source: HTMLCanvasElement,
  color: {
    exposure?: number;
    contrast?: number;
    saturation?: number;
    temperature?: number;
    vibrance?: number;
  },
): HTMLCanvasElement {
  const {
    exposure = 0,
    contrast = 0,
    saturation = 1,
    temperature = 0,
    vibrance = 0,
  } = color;
  const filters: string[] = [];
  filters.push(`brightness(${clamp(1 + exposure * 0.55, 0.15, 2.4).toFixed(3)})`);
  filters.push(`contrast(${clamp(1 + contrast, 0.2, 2.2).toFixed(3)})`);
  filters.push(`saturate(${clamp(saturation + vibrance * 0.32, 0, 2.5).toFixed(3)})`);
  if (Math.abs(temperature) > 0.01) {
    filters.push(`sepia(${clamp(Math.abs(temperature) * 0.22, 0, 0.35).toFixed(3)})`);
  }
  const out = document.createElement('canvas');
  out.width = source.width;
  out.height = source.height;
  const ctx = out.getContext('2d')!;
  ctx.filter = filters.join(' ');
  ctx.drawImage(source, 0, 0);
  ctx.filter = 'none';
  return out;
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/png'): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('postFX-canvas-to-blob-failed'));
    }, type);
  });
}
