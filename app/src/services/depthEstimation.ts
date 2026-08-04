/**
 * 浏览器端深度估计服务（Depth Anything V2 ONNX）—— 已优化
 *
 * 优化点：
 *   1. 深度图 LRU 缓存：同一素材图只推理一次，后续拖拽 < 5ms
 *   2. 输入降分辨率：518→320，推理快 2.6×（320 像素 = 518 的 38%，适合 small 模型）
 *   3. 上采样用缩放而不是双线性逐像素：createImageBitmap + drawImage
 */

import { createOrtSession } from './localInference/ortEnv';
import type { OrtSession } from './localInference/ortEnv';
import { getCachedModel } from '@/services/storage';

interface DepthModelSpec {
  id: string;
  version: string;
  /** 推理输入边长（V3 用 518，V2 用 320） */
  inputSize: number;
}

const DEPTH_MODELS: Record<string, DepthModelSpec> = {
  'depth-anything-v2-small': { id: 'depth-anything-v2-small', version: '1.0.0', inputSize: 320 },
  'depth-anything-v3-base': { id: 'depth-anything-v3-base', version: '2.0.0', inputSize: 518 },
};

const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];

/** 深度缓存上限 */
const CACHE_MAX = 6;

let cachedSession: OrtSession | null = null;
let activeModelId = '';
let activeInputSize = 320;

// ========== LRU 深度缓存 ==========
type CacheEntry = { depth: Float32Array; srcW: number; srcH: number; ts: number };
const depthCache = new Map<string, CacheEntry>();

function cacheKey(imageUrl: string): string {
  // 用 url 后 48 字符做简易 hash（够区分同批次素材）
  const raw = imageUrl || '';
  if (raw.length <= 48) return raw;
  return raw.slice(raw.length - 48);
}

function evictLru(): void {
  if (depthCache.size < CACHE_MAX) return;
  let oldestKey = '';
  let oldestTs = Infinity;
  for (const [k, v] of depthCache) {
    if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; }
  }
  if (oldestKey) depthCache.delete(oldestKey);
}

export function clearDepthCache(): void {
  depthCache.clear();
}

export interface DepthResult { width: number; height: number; data: Float32Array }

/**
 * 加载深度模型。
 * @param id 指定模型 id（'depth-anything-v2-small' | 'depth-anything-v3-base'）；
 *           省略时自动选择：已安装的 V3 优先，否则 V2。
 * 返回失败原因；V3 若因外部权重（model.onnx_data）无法在浏览器端加载，会自动回退到 V2。
 */
export async function loadDepthModel(id?: string): Promise<{ ok: boolean; reason?: string; usedId?: string }> {
  if (cachedSession && (!id || id === activeModelId)) {
    return { ok: true, usedId: activeModelId };
  }

  const candidates: DepthModelSpec[] = id
    ? [DEPTH_MODELS[id]].filter(Boolean)
    : [DEPTH_MODELS['depth-anything-v3-base'], DEPTH_MODELS['depth-anything-v2-small']].filter((m) => m);

  let lastErr: { id: string; err: unknown } | null = null;
  for (const spec of candidates) {
    const cached = await getCachedModel(spec.id, spec.version);
    if (!cached || !cached.data) {
      lastErr = { id: spec.id, err: 'model-not-cached' };
      continue;
    }
    // 组装外部权重（如 V3 的 model.onnx_data）供 ORT Web 解析拆分模型。
    // 若该外部权重缺失，仍先尝试「无外部权重」创建（部分二次导出会把权重内联），
    // 失败再记录真实错误，避免把「会话创建失败」误报成「模型未缓存」。
    const ext = await getCachedModel(spec.id, `${spec.version}#model.onnx_data`);
    const externalData = ext?.data
      ? [{ path: 'model.onnx_data', data: new Uint8Array(ext.data) }]
      : undefined;
    const attempts: ({ path: string; data: Uint8Array }[] | undefined)[] = externalData
      ? [externalData, undefined]
      : [undefined];
    for (const ed of attempts) {
      try {
        cachedSession = await createOrtSession(cached.data as ArrayBuffer, ed);
        activeModelId = spec.id;
        activeInputSize = spec.inputSize;
        return { ok: true, usedId: spec.id };
      } catch (err) {
        lastErr = { id: spec.id, err };
        console.warn(
          `[depthEstimation] 加载 ${spec.id}${ed ? '（含外部权重）' : '（无外部权重）'} 失败，尝试下一个候选：`,
          (err as Error)?.message,
        );
        cachedSession = null;
      }
    }
  }
  // 返回真实失败原因（而非笼统的 model-not-cached），便于定位是权重缺失还是会话创建失败。
  const reason = lastErr
    ? `load-failed:${lastErr.id}:${String((lastErr.err as Error)?.message ?? lastErr.id)}`
    : 'model-not-cached';
  return { ok: false, reason };
}

/** 当前激活的深度模型 id（用于诊断） */
export function getActiveDepthModelId(): string {
  return activeModelId;
}

export function disposeDepthModel(): void {
  if (cachedSession) { cachedSession.release(); cachedSession = null; }
  activeModelId = '';
  depthCache.clear();
}

export function isDepthModelReady(): boolean { return cachedSession !== null; }

/**
 * 获取深度图（缓存优先）。
 * @param image   源图 HTMLImageElement
 * @param imageUrl 图片 URL（用于缓存 key）
 */
export async function estimateDepth(image: HTMLImageElement, imageUrl?: string): Promise<DepthResult> {
  const session = cachedSession;
  if (!session) throw new Error('深度模型未加载，请先在模型面板安装 Depth Anything（V2 或 V3）');

  const inputSize = activeInputSize || 320;
  const key = imageUrl ? cacheKey(imageUrl) : '';
  if (key) {
    const entry = depthCache.get(key);
    if (entry && entry.srcW === image.naturalWidth && entry.srcH === image.naturalHeight) {
      entry.ts = Date.now();
      return { width: entry.srcW, height: entry.srcH, data: entry.depth };
    }
  }

  const srcW = image.naturalWidth;
  const srcH = image.naturalHeight;

  // Step 1: 缩放到输入尺寸
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = inputSize;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(image, 0, 0, inputSize, inputSize);
  const imgData = ctx.getImageData(0, 0, inputSize, inputSize);
  const pixels = imgData.data;

  // Step 2: 归一化 → Float32Array
  const channels = 3;
  const plane = inputSize * inputSize;
  const tensorData = new Float32Array(1 * channels * plane);
  for (let i = 0; i < plane; i++) {
    const pi = i * 4;
    for (let c = 0; c < channels; c++) {
      const val = pixels[pi + c] / 255;
      tensorData[i + c * plane] = (val - IMAGENET_MEAN[c]) / IMAGENET_STD[c];
    }
  }

  // Step 3: 推理
  const { createTensor } = await import('./localInference/ortEnv');
  // 不同导出格式的 Depth Anything 对输入 rank 要求不同：
  //   - 标准 onnx-community 导出（V2 small / V3 base）：4D [N, C, H, W]
  //   - 个别二次导出：5D [N, C, 1, H, W]
  // 同一份 tensor 数据在两种 rank 下扁平布局完全相同（中间维=1），故只改 dims 即可。
  // 优先从会话元数据读取真实期望 rank；读不到则按 4D 试跑，用报错里的 "Expected: N" 兜底重试。
  const readInputRank = (sess: unknown, name: string): number | null => {
    try {
      const meta = (sess as { inputMetadata?: Record<string, { dimensions?: number[] }> }).inputMetadata;
      const dims = meta?.[name]?.dimensions;
      if (dims && dims.length >= 4) return dims.length;
    } catch {
      /* 元数据不可用，交由试跑兜底 */
    }
    return null;
  };
  const inputName = session.inputNames[0];
  const expectedRank = readInputRank(session, inputName);
  const buildInput = (rank: number) =>
    createTensor('float32', tensorData, rank === 5 ? [1, channels, 1, inputSize, inputSize] : [1, channels, inputSize, inputSize]);
  let results: Awaited<ReturnType<typeof session.run>>;
  try {
    results = await session.run({ [inputName]: await buildInput(expectedRank ?? 4) });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    const m = msg.match(/Expected:\s*(\d+)/i);
    if (m) {
      // 报错明确告知期望 rank，按它重试一次（兼容元数据误报 / 未知模型）
      results = await session.run({ [inputName]: await buildInput(Number(m[1])) });
    } else {
      throw e;
    }
  }

  // Step 4: 从通用 NCHW / NHW 输出中提取单通道深度图（兼容 V2/V3 不同输出形状）
  const output = results[session.outputNames[0]];
  const odims = (output as { dims: readonly number[] }).dims;
  const outData = output.data as Float32Array;
  const extracted = extractDepthPlane(outData, [...odims]);
  const depthW = extracted.width;
  const depthH = extracted.height;
  const depthRaw = extracted.data;

  // Step 5: 缩放回原图分辨率
  const scaleCanvas = document.createElement('canvas');
  scaleCanvas.width = depthW;
  scaleCanvas.height = depthH;
  const sCtx = scaleCanvas.getContext('2d')!;
  const sImg = sCtx.createImageData(depthW, depthH);
  for (let i = 0; i < depthW * depthH; i++) {
    const v = Math.round((depthRaw[i] || 0) * 255);
    const si = i * 4;
    sImg.data[si] = sImg.data[si + 1] = sImg.data[si + 2] = v;
    sImg.data[si + 3] = 255;
  }
  sCtx.putImageData(sImg, 0, 0);

  const outCanvas = document.createElement('canvas');
  outCanvas.width = srcW;
  outCanvas.height = srcH;
  const oCtx = outCanvas.getContext('2d')!;
  oCtx.imageSmoothingEnabled = true;
  oCtx.imageSmoothingQuality = 'high';
  oCtx.drawImage(scaleCanvas, 0, 0, srcW, srcH);
  const outImgData = oCtx.getImageData(0, 0, srcW, srcH);

  const fullDepth = new Float32Array(srcW * srcH);
  for (let i = 0; i < srcW * srcH; i++) {
    fullDepth[i] = outImgData.data[i * 4] / 255;
  }

  // 写入缓存
  if (key) {
    evictLru();
    depthCache.set(key, { depth: fullDepth, srcW, srcH, ts: Date.now() });
  }

  return { width: srcW, height: srcH, data: fullDepth };
}

/**
 * 从 ONNX 输出张量中提取单通道深度平面，兼容多种输出布局：
 *   - [N, C, H, W]（C=1，如 DA3）：取前 H*W
 *   - [N, H, W]（无通道维）：直接 H*W
 *   - 其它：按平方根近似为正方形
 */
function extractDepthPlane(
  data: Float32Array,
  dims: number[],
): { data: Float32Array; width: number; height: number } {
  if (dims.length === 4 && dims[1] === 1) {
    const h = dims[2];
    const w = dims[3];
    return { data: Float32Array.from(data.subarray(0, h * w)), width: w, height: h };
  }
  if (dims.length === 3) {
    const h = dims[1];
    const w = dims[2];
    return { data: Float32Array.from(data.subarray(0, h * w)), width: w, height: h };
  }
  const side = Math.max(1, Math.floor(Math.sqrt(data.length)));
  return { data: Float32Array.from(data.subarray(0, side * side)), width: side, height: side };
}
