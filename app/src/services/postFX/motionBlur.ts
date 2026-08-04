/**
 * 运动模糊（Motion Blur）—— Kornia 风格运动核 + RAFT 光流接口。
 *
 * 算法：
 *   - 图像运动模糊：生成 Kornia `motion_blur` 同构的线性运动核（沿 angle 方向均布），
 *     通过「旋转画布→水平 1D 卷积→旋转回」实现可分离卷积，等效于 Kornia 的 filter2d(motion_kernel)。
 *   - 视频运动模糊：RAFT 光流估计相邻帧运动矢量，沿光流方向做局部方向性模糊，
 *     得到「物体越动越糊、静止越清」的电影感运动模糊。
 *   - RAFT 权重缺失时优雅回退到全局方向性运动模糊（仍可一键使用）。
 *
 * 模型（最新免费开源）：
 *   - RAFT：facebookresearch/raft (MIT)，ONNX 导出约 10–23MB。光流（flow）作为运动矢量。
 *   - Kornia：官方开源计算机视觉库，motion_blur / filter2d 提供理论基线，本实现按其行为复现。
 */

import { createOrtSession, createTensor } from '@/services/localInference/ortEnv';
import { getCachedModel } from '@/services/storage';
import { clamp, imageToCanvas, loadImageFromUrl } from './util';

export const RAFT_MODEL_ID = 'raft-optical-flow';
export const RAFT_MODEL_VERSION = '1.0.0';

export interface MotionBlurOptions {
  /** 模糊长度（像素 / 强度） */
  length?: number;
  /** 模糊角度（度），仅全局模式使用 */
  angle?: number;
  /** 是否使用 RAFT 光流（视频逐帧更真实） */
  useOpticalFlow?: boolean;
}

let raftSession: Awaited<ReturnType<typeof createOrtSession>> | null = null;

export async function loadRaftModel(): Promise<{ ok: boolean; reason?: string }> {
  if (raftSession) return { ok: true };
  const cached = await getCachedModel(RAFT_MODEL_ID, RAFT_MODEL_VERSION);
  if (!cached?.data) return { ok: false, reason: 'model-not-cached' };
  try {
    raftSession = await createOrtSession(cached.data as ArrayBuffer);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `session-create-failed: ${(err as Error)?.message}` };
  }
}

export function isRaftReady(): boolean {
  return raftSession !== null;
}

/** 生成 Kornia 风格线性运动核（size×size，沿 angle 方向均布并归一化）。 */
function buildMotionKernel(size: number, angleDeg: number): Float32Array {
  const kernel = new Float32Array(size * size);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const rad = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  // 沿方向轴在 [-1,1] 采样，离中心越近权重越高
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ox = x - cx;
      const oy = y - cy;
      const proj = (ox * dx + oy * dy) / (size / 2); // [-1,1]
      if (Math.abs(proj) <= 1) {
        // 中心高、两端低的帽形权重（Kornia motion_blur 类似）
        kernel[y * size + x] = Math.cos((proj * Math.PI) / 2);
      }
    }
  }
  let sum = 0;
  for (const v of kernel) sum += v;
  if (sum > 0) for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  return kernel;
}

/** 旋转画布到指定角度，便于水平方向卷积。 */
function rotateCanvas(canvas: HTMLCanvasElement, angleDeg: number): HTMLCanvasElement {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const w = canvas.width;
  const h = canvas.height;
  const nw = Math.ceil(w * cos + h * sin);
  const nh = Math.ceil(w * sin + h * cos);
  const out = document.createElement('canvas');
  out.width = nw;
  out.height = nh;
  const ctx = out.getContext('2d')!;
  ctx.translate(nw / 2, nh / 2);
  ctx.rotate(rad);
  ctx.drawImage(canvas, -w / 2, -h / 2);
  return out;
}

/** 水平方向 1D 卷积（核为 size 长、中心对齐）。 */
function convolveHorizontal(canvas: HTMLCanvasElement, kernel: Float32Array): HTMLCanvasElement {
  const size = Math.round(Math.sqrt(kernel.length)) || kernel.length;
  const half = Math.floor(size / 2);
  const src = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext('2d')!;
  const dst = ctx.createImageData(canvas.width, canvas.height);
  const sd = src.data;
  const dd = dst.data;
  const { width, height } = canvas;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = -half; k <= half; k++) {
        const sx = clamp(x + k, 0, width - 1);
        const si = (y * width + sx) * 4;
        const wgt = kernel[k + half];
        r += sd[si] * wgt;
        g += sd[si + 1] * wgt;
        b += sd[si + 2] * wgt;
      }
      const di = (y * width + x) * 4;
      dd[di] = r;
      dd[di + 1] = g;
      dd[di + 2] = b;
      dd[di + 3] = sd[(y * width + x) * 4 + 3];
    }
  }
  ctx.putImageData(dst, 0, 0);
  return out;
}

/** 对单张图应用全局方向性运动模糊（Kornia 风格）。 */
export function applyMotionBlur(
  source: HTMLImageElement | HTMLCanvasElement,
  options: MotionBlurOptions = {},
): HTMLCanvasElement {
  const length = clamp(options.length ?? 18, 2, 120);
  const angle = options.angle ?? 0;
  const canvas = source instanceof HTMLCanvasElement ? source : imageToCanvas(source);

  const size = Math.max(3, Math.round(length) | 1); // 奇数核
  const kernel = buildMotionKernel(size, 0); // 水平核，后面旋转画布

  const rotated = rotateCanvas(canvas, angle);
  const convolved = convolveHorizontal(rotated, kernel);
  const back = rotateCanvas(convolved, -angle);

  // 裁回原尺寸
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext('2d')!;
  const dw = (back.width - canvas.width) / 2;
  const dh = (back.height - canvas.height) / 2;
  ctx.drawImage(back, dw, dh, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
  return out;
}

export interface OpticalFlowField {
  /** 长度 2*H*W 的扁平数组，按 [2][H][W] 布局存放每个像素的 (fx, fy) 位移 */
  flow: Float32Array;
  width: number;
  height: number;
}

const FLOW_MEAN = [0.485, 0.456, 0.406];
const FLOW_STD = [0.229, 0.224, 0.225];

/**
 * RAFT 光流估计：输入前后两帧，返回 flow[2][h][w]。
 * 兼容两种 ONNX 导出格式：
 *   - 单输入（OpenCV Zoo，如 opencv/optical_flow_estimation_raft）：6 通道 [1,6,H,W]，
 *     两帧 BGR 各 /255 后拼接；输出 [1,2,H,W]。
 *   - 双输入（作者 raft_onnx）：分别输入两帧 RGB（ImageNet 归一化）。
 * 仅在 loadRaftModel() 成功后可用；否则调用方应当回退到全局运动模糊。
 */
export async function estimateOpticalFlowRAFT(
  frameA: HTMLCanvasElement,
  frameB: HTMLCanvasElement,
  inputSize = 256,
): Promise<OpticalFlowField | null> {
  if (!raftSession) return null;
  const numInputs = raftSession.inputNames.length;

  // OpenCV 约定：BGR + /255（单输入 6 通道拼接时按 [img1_BGR, img2_BGR] 排列）
  const buildBgr = (c: HTMLCanvasElement) => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = inputSize;
    const ctx = cv.getContext('2d')!;
    ctx.drawImage(c, 0, 0, inputSize, inputSize);
    const data = ctx.getImageData(0, 0, inputSize, inputSize).data;
    const plane = inputSize * inputSize;
    const out = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      out[i] = data[i * 4 + 2] / 255;
      out[plane + i] = data[i * 4 + 1] / 255;
      out[2 * plane + i] = data[i * 4] / 255;
    }
    return out;
  };
  // 作者 raft_onnx 约定：RGB + ImageNet 归一化
  const buildRgbNorm = (c: HTMLCanvasElement) => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = inputSize;
    const ctx = cv.getContext('2d')!;
    ctx.drawImage(c, 0, 0, inputSize, inputSize);
    const data = ctx.getImageData(0, 0, inputSize, inputSize).data;
    const plane = inputSize * inputSize;
    const out = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      for (let ch = 0; ch < 3; ch++) {
        const v = data[i * 4 + ch] / 255;
        out[ch * plane + i] = (v - FLOW_MEAN[ch]) / FLOW_STD[ch];
      }
    }
    return out;
  };

  let result: Awaited<ReturnType<typeof raftSession.run>>;
  if (numInputs >= 2) {
    result = await raftSession.run({
      [raftSession.inputNames[0]]: await createTensor('float32', buildRgbNorm(frameA), [1, 3, inputSize, inputSize]),
      [raftSession.inputNames[1]]: await createTensor('float32', buildRgbNorm(frameB), [1, 3, inputSize, inputSize]),
    });
  } else {
    const a = buildBgr(frameA);
    const b = buildBgr(frameB);
    const combined = new Float32Array(6 * inputSize * inputSize);
    combined.set(a, 0);
    combined.set(b, 3 * inputSize * inputSize);
    result = await raftSession.run({
      [raftSession.inputNames[0]]: await createTensor('float32', combined, [1, 6, inputSize, inputSize]),
    });
  }

  const out = result[raftSession.outputNames[0]] as { data: Float32Array; dims?: readonly number[] };
  const dims = out.dims ?? [1, 2, inputSize, inputSize];
  let fH: number;
  let fW: number;
  if (dims.length === 4) { fH = dims[2]; fW = dims[3]; }
  else if (dims.length === 3) { fH = dims[1]; fW = dims[2]; }
  else { const side = Math.max(1, Math.floor(Math.sqrt(out.data.length / 2))); fH = fW = side; }
  return { flow: out.data as Float32Array, width: fW, height: fH };
}

/**
 * 基于 RAFT 光流场的逐像素方向性运动模糊：运动越大的区域越糊、静止区域保持清晰，
 * 得到「物体越动越糊、静止越清」的电影感运动模糊（区别于全局角度模糊）。
 * @param field RAFT 估计的相邻帧光流（坐标系为 flow 网格分辨率）
 * @param options.maxLength 单像素最大拖影长度（帧像素）
 * @param options.threshold 低于该位移视为静止（不模糊）
 */
export function applyMotionBlurFromFlow(
  source: HTMLCanvasElement,
  field: OpticalFlowField,
  options: { maxLength?: number; threshold?: number } = {},
): HTMLCanvasElement {
  const maxLength = clamp(options.maxLength ?? 18, 2, 120);
  const threshold = options.threshold ?? 0.8;
  const { width: W, height: H } = source;
  const sctx = source.getContext('2d')!;
  const sd = sctx.getImageData(0, 0, W, H).data;
  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const octx = out.getContext('2d')!;
  const dst = octx.createImageData(W, H);
  const dd = dst.data;

  const fw = field.width;
  const fh = field.height;
  const flow = field.flow;
  const scaleX = W / fw; // 光流网格 → 帧像素
  const scaleY = H / fh;
  const STEPS = 8;

  for (let y = 0; y < H; y++) {
    const gyf = (y / (H - 1)) * (fh - 1);
    const gyi = Math.floor(gyf);
    const gyfFrac = gyf - gyi;
    const gyi1 = Math.min(gyi + 1, fh - 1);
    for (let x = 0; x < W; x++) {
      const gxf = (x / (W - 1)) * (fw - 1);
      const gxi = Math.floor(gxf);
      const gxfFrac = gxf - gxi;
      const gxi1 = Math.min(gxi + 1, fw - 1);

      const i00 = (gyi * fw + gxi) * 2;
      const i10 = (gyi * fw + gxi1) * 2;
      const i01 = (gyi1 * fw + gxi) * 2;
      const i11 = (gyi1 * fw + gxi1) * 2;

      const fx = ((flow[i00] * (1 - gxfFrac) + flow[i10] * gxfFrac) * (1 - gyfFrac)
        + (flow[i01] * (1 - gxfFrac) + flow[i11] * gxfFrac) * gyfFrac) * scaleX;
      const fy = ((flow[i00 + 1] * (1 - gxfFrac) + flow[i10 + 1] * gxfFrac) * (1 - gyfFrac)
        + (flow[i01 + 1] * (1 - gxfFrac) + flow[i11 + 1] * gxfFrac) * gyfFrac) * scaleY;

      const di = (y * W + x) * 4;
      const mag = Math.hypot(fx, fy);
      if (mag < threshold) {
        dd[di] = sd[di]; dd[di + 1] = sd[di + 1]; dd[di + 2] = sd[di + 2]; dd[di + 3] = sd[di + 3];
        continue;
      }
      const len = Math.min(mag, maxLength);
      const steps = Math.max(1, Math.round((len / maxLength) * STEPS));
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let k = 0; k <= steps; k++) {
        const f = k / steps;
        const sx = clamp(x - fx * f, 0, W - 1);
        const sy = clamp(y - fy * f, 0, H - 1);
        const sxi = Math.floor(sx);
        const syi = Math.floor(sy);
        const sxf = sx - sxi;
        const syf = sy - syi;
        const sxi1 = Math.min(sxi + 1, W - 1);
        const syi1 = Math.min(syi + 1, H - 1);
        const a0 = (syi * W + sxi) * 4;
        const a1 = (syi * W + sxi1) * 4;
        const a2 = (syi1 * W + sxi) * 4;
        const a3 = (syi1 * W + sxi1) * 4;
        const w00 = (1 - sxf) * (1 - syf);
        const w10 = sxf * (1 - syf);
        const w01 = (1 - sxf) * syf;
        const w11 = sxf * syf;
        r += sd[a0] * w00 + sd[a1] * w10 + sd[a2] * w01 + sd[a3] * w11;
        g += sd[a0 + 1] * w00 + sd[a1 + 1] * w10 + sd[a2 + 1] * w01 + sd[a3 + 1] * w11;
        b += sd[a0 + 2] * w00 + sd[a1 + 2] * w10 + sd[a2 + 2] * w01 + sd[a3 + 2] * w11;
        a += sd[a0 + 3] * w00 + sd[a1 + 3] * w10 + sd[a2 + 3] * w01 + sd[a3 + 3] * w11;
      }
      dd[di] = r / (steps + 1);
      dd[di + 1] = g / (steps + 1);
      dd[di + 2] = b / (steps + 1);
      dd[di + 3] = a / (steps + 1);
    }
  }
  octx.putImageData(dst, 0, 0);
  return out;
}

/** 便捷入口：URL + 全局方向性运动模糊。 */
export async function applyMotionBlurFromUrl(
  url: string,
  options: MotionBlurOptions = {},
): Promise<HTMLCanvasElement> {
  const img = await loadImageFromUrl(url);
  return applyMotionBlur(img, options);
}

/**
 * 用 RAFT 光流将「上一帧的 alpha 遮罩」反向变形到当前帧坐标系（backward warping），
 * 用于逐帧视频抠像的时域连贯：把上一帧已抠好的前景沿光流「搬」到当前帧，
 * 与当前帧直接抠像结果做轻度混合，显著减少边缘闪烁/抖动。
 * @param prevAlpha 上一帧 alpha（长度 w*h，取值 0..1）
 * @param field 当前帧 → 上一帧 的 RAFT 光流（坐标系为 flow 网格分辨率）
 * @returns 变形后的上一帧 alpha（长度 w*h）
 */
export function propagateAlphaByFlow(
  prevAlpha: Float32Array,
  field: OpticalFlowField,
  w: number,
  h: number,
): Float32Array {
  const fw = field.width;
  const fh = field.height;
  const flow = field.flow;
  const scaleX = w / fw; // 光流网格 → 帧像素
  const scaleY = h / fh;
  const out = new Float32Array(w * h);

  for (let y = 0; y < h; y++) {
    const gyf = (y / (h - 1)) * (fh - 1);
    const gyi = Math.floor(gyf);
    const gyfFrac = gyf - gyi;
    const gyi1 = Math.min(gyi + 1, fh - 1);
    for (let x = 0; x < w; x++) {
      const gxf = (x / (w - 1)) * (fw - 1);
      const gxi = Math.floor(gxf);
      const gxfFrac = gxf - gxi;
      const gxi1 = Math.min(gxi + 1, fw - 1);

      const i00 = (gyi * fw + gxi) * 2;
      const i10 = (gyi * fw + gxi1) * 2;
      const i01 = (gyi1 * fw + gxi) * 2;
      const i11 = (gyi1 * fw + gxi1) * 2;

      const fx = ((flow[i00] * (1 - gxfFrac) + flow[i10] * gxfFrac) * (1 - gyfFrac)
        + (flow[i01] * (1 - gxfFrac) + flow[i11] * gxfFrac) * gyfFrac) * scaleX;
      const fy = ((flow[i00 + 1] * (1 - gxfFrac) + flow[i10 + 1] * gxfFrac) * (1 - gyfFrac)
        + (flow[i01 + 1] * (1 - gxfFrac) + flow[i11 + 1] * gxfFrac) * gyfFrac) * scaleY;

      // 当前像素在上一帧中的位置（光流指向运动方向，故回退）
      const sx = clamp(x - fx, 0, w - 1);
      const sy = clamp(y - fy, 0, h - 1);
      const sxi = Math.floor(sx);
      const syi = Math.floor(sy);
      const sxf = sx - sxi;
      const syf = sy - syi;
      const sxi1 = Math.min(sxi + 1, w - 1);
      const syi1 = Math.min(syi + 1, h - 1);

      const a0 = syi * w + sxi;
      const a1 = syi * w + sxi1;
      const a2 = syi1 * w + sxi;
      const a3 = syi1 * w + sxi1;
      out[y * w + x] =
        prevAlpha[a0] * (1 - sxf) * (1 - syf) +
        prevAlpha[a1] * sxf * (1 - syf) +
        prevAlpha[a2] * (1 - sxf) * syf +
        prevAlpha[a3] * sxf * syf;
    }
  }
  return out;
}
