/**
 * AI 鏅鸿兘鎶犲儚锛圡atting锛夆€斺€?绮剧‘鍒板彂涓濈殑鍏嶈垂寮€婧愭柟妗堛€?
 *
 * 榛樿妯″瀷锛欱iRefNet锛堝紑婧?SOTA锛孉pache-2.0锛屽厤鐧诲綍/鍏嶄护鐗岋級锛屽彂涓濅笌闀傜┖缁嗚妭鏈€寮恒€?
 * 鍘?RMBG-2.0 涓?Hugging Face 鍙楅檺(gated)妯″瀷銆佹棤娉曠粡闈㈡澘涓嬭浇锛屽凡涓嬫灦骞剁敱 BiRefNet 骞虫浛銆?
 *
 * 娴佺▼锛歄NNX 鎺ㄧ悊寰楀埌鍗曢€氶亾 alpha 鈫?涓婇噰鏍峰洖鍘熷浘 鈫?杈圭紭缇藉寲 + 鍘绘孩鑹?鈫?杈撳嚭甯﹂€忔槑閫氶亾 RGBA銆?
 * 鑻ユ棤鏈湴鏉冮噸鍒欏洖閫€鍒般€屼笂浼犺挋鐗堢洿閫氥€嶏紙娌跨敤鏃ч摼璺級銆?
 */

import { createOrtSession, createTensor, getWasmHeapBytes } from '@/services/localInference/ortEnv';
import { PRESET_MODELS } from '@/config/presetModels';
import { loadModel } from '@/services/modelLoader';
import { getCachedModel } from '@/services/storage';
import { clamp, imageToCanvas, loadImageFromUrl } from './util';

export const MATTING_MODEL_IDS = {
  birefnet: 'birefnet-matting',
} as const;

export type MattingModelId = (typeof MATTING_MODEL_IDS)[keyof typeof MATTING_MODEL_IDS];
// 升到 1.3.0：改用 int8 权重（birefnet_uint8.onnx，由 quant_dynamic.py 动态量化生成）。
// 关键根因链（2026-07-19 验证）：
//  - fp16 模型 → WebGL EP 不支持 fp16 计算 → 整体甩回 CPU 跑 fp32 → 1024² 峰值 > 4GB → bad_alloc；
//  - fp32 模型 → 即便 WebGL 接手，部分算子仍回退 CPU，CPU fp32@1024² 峰值同样 > 4GB → bad_alloc；
//  - int8 模型 → 权重 QLinearConv/QLinearMatMul 是 WebGL EP 完整支持的算子，BiRefNet 整体可在
//    GPU 上跑，权重/激活驻留显存，彻底绕开 4GB WASM 堆上限。
// 输入/输出仍是 fp32（动态量化只量化权重，ORT 对 QLinear 算子透明处理），前端加载逻辑无需改动。
// 旧 1.2.0 fp32 缓存因版本号变更而失效，浏览器会重新向后端拉取（后端直接服务本地已量化文件）。
// 注意：WebGPU EP 对 BiRefNet 会生成超限着色器（computeSliceOffsets 非法），故仍禁用，只用 WebGL。
export const MATTING_MODEL_VERSION = '1.3.0';

const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];

/**
 * 鎺ㄧ悊鍒嗚鲸鐜囧€欓€夛紙鐢卞ぇ鍒板皬锛夈€?
 * BiRefNet 鍦?1024虏 鍗曠嚎绋?WASM 涓嬫瀬鏄撳洜 4GB 鍫嗕笂闄愯Е鍙?bad_alloc锛?
 * 鐜板凡榛樿璧?GPU 鎵ц鍚庣锛坵ebgpu/webgl锛岃 ortEnv锛夌粫寮€璇ラ檺鍒躲€?
 * 姝ゅ淇濈暀銆岄€愮骇闄嶅垎杈ㄧ巼閲嶈瘯銆嶄綔涓哄厹搴曪細褰?GPU 鏄惧瓨浠嶄笉瓒虫垨妯″瀷杈撳叆涓哄姩鎬佺淮搴︽椂锛?
 * 闄嶄綆鍒嗚鲸鐜囧彲璁╂帹鐞嗗湪鏇翠綆鍐呭瓨涓嬭窇閫氾紙浠ｄ环鏄竟缂樼簿搴︾暐闄嶏級銆?
 *
 * 鍏抽敭淇锛氬垎杈ㄧ巼鍥為€€鍙簲澶嶇敤鍚屼竴涓?ONNX 浼氳瘽锛屼笉鑳戒负姣忎竴妗ｅ昂瀵搁噸寤轰竴娆′細璇濄€?
 * 鍚﹀垯 1024 棣栨鎺ㄧ悊澶辫触鍚庯紝浼氬湪 896/768/640/512 涓婇噸澶嶈Е鍙戞槀璐电殑 session create锛?
 * 鎶婂師鏈彲鎭㈠鐨勬帹鐞嗗け璐ユ斁澶ф垚杩炵画鐨?std::bad_alloc銆?
 */
// BiRefNet 原生在 1024² 训练/导出，onnx-community/BiRefNet-ONNX 的输入维度通常固定或动态为 1024。
// 关键点：之前候选漏了 1024，若模型输入维度固定为 1024，则 960/768/640 全部维度不匹配、
// session.run 在每一档都抛 "invalid dimensions" → 静默回退 @imgly（仅 console.warn，无红色报错）。
// 因此把 1024 放在最前优先尝试；GPU(WebGL) 下 1024² 不会 OOM（权重驻留显存）。
const MATTING_SIZE_CANDIDATES = [1024, 960, 768, 640] as const;
let mattingInputSize: number = MATTING_SIZE_CANDIDATES[0];

let activeSession: { id: MattingModelId; session: Awaited<ReturnType<typeof createOrtSession>>; engine?: string } | null = null;

// 最近一次抠像的失败诊断（供面板展示 BiRefNet 失效的真实原因，而非仅显示 @imgly 黄标）
let mattingDiagnostic = '';
export function getMattingDiagnostic(): string {
  return mattingDiagnostic;
}

async function ensureMattingModelCached(id: MattingModelId): Promise<{ ok: boolean; reason?: string }> {
  const meta = PRESET_MODELS.find((item) => item.id === id);
  if (!meta) return { ok: false, reason: `unknown-model:${id}` };
  const result = await loadModel({
    modelId: meta.id,
    version: meta.version,
    url: meta.url,
    extraFiles: meta.extraFiles,
    timeout: 600000,
    retries: 2,
  });
  if (!result.success) return { ok: false, reason: result.error || 'model-download-failed' };
  return { ok: true };
}

function normalizeMattingSize(size: number): number {
  return MATTING_SIZE_CANDIDATES.includes(size as (typeof MATTING_SIZE_CANDIDATES)[number])
    ? size
    : MATTING_SIZE_CANDIDATES[0];
}

export async function loadMattingModel(
  id: MattingModelId = MATTING_MODEL_IDS.birefnet,
  preferredSize: number = mattingInputSize,
): Promise<{ ok: boolean; reason?: string; engine?: string }> {
  mattingInputSize = normalizeMattingSize(preferredSize);
  if (activeSession?.id === id) return { ok: true, engine: 'cached' };
  let cached = await getCachedModel(id, MATTING_MODEL_VERSION);
  // 缓存缺失时先按声明 URL 自动补下载（与面板「下载」链路对齐），
  // 使「点过激活但从未真下载」或旧版本残留时也能自愈，而非直接报 model-not-cached。
  if (!cached?.data) {
    console.info(`[matting] 本地未命中 ${id}@${MATTING_MODEL_VERSION}，尝试自动下载…`);
    const dl = await ensureMattingModelCached(id);
    if (!dl.ok) return { ok: false, reason: dl.reason || 'model-download-failed' };
    cached = await getCachedModel(id, MATTING_MODEL_VERSION);
  }
  if (!cached?.data) return { ok: false, reason: 'model-not-cached' };
  if (activeSession) {
    try { activeSession.session.release(); } catch { /* noop */ }
    activeSession = null;
  }
  const ci = typeof crossOriginIsolated !== 'undefined' ? String(crossOriginIsolated) : '?';
  // ① 首选: WebGL EP（int8 权重 QLinear 算子由 WebGL 完整支持，整图在 GPU 跑，绕开 WASM 线性堆 OOM）。
  // 关键：绝不能把 webgpu 放进 EP 列表首部！onnxruntime-web 的 WebGPU EP 对 BiRefNet 这类
  // 「大 Concat/Split + 深嵌套」模型会生成超出 WebGPU 单阶段 storage buffer 上限的着色器
  // （如 computeSliceOffsets Invalid ComputePipeline），且这种失败只在 OrtRun 时才暴露 → 节点
  // 被甩回 CPU/WASM 在 256MB 堆里 bad_alloc。故按架构结论（ortEnv.ts）禁用 webgpu，直接 WebGL。
  try {
    const session = await createOrtSession(cached.data as ArrayBuffer, undefined, { skipWasmOnly: true });
    activeSession = { id, session, engine: 'webgl' };
    console.info(`[matting] ✅ BiRefNet=WebGL | crossOriginIsolated=${ci}`);
    return { ok: true, engine: 'webgl' };
  } catch (err) {
    console.warn('[matting] ❌ WebGL失败,回退WASM:', (err as Error)?.message?.substring(0, 150));
  }
  // ② 回退: WASM EP（堆已上调至 2GB；仅当 WebGL 不可用时的最后手段）
  try {
    const session = await createOrtSession(cached.data as ArrayBuffer, undefined, { skipWasmOnly: false });
    activeSession = { id, session, engine: 'wasm' };
    console.info('[matting] ⚡ BiRefNet=WASM(1024²)');
    return { ok: true, engine: 'wasm' };
  } catch (wasmErr) {
    console.error('[matting] ❌ WASM也失败→回退@imgly:', (wasmErr as Error)?.message?.substring(0, 150));
    return { ok: false, reason: 'session-create-double-fail' };
  }
}

export function isMattingReady(): boolean {
  return activeSession !== null;
}

export interface MattingOptions {
  modelId?: MattingModelId;
  edgeFeather?: number; // 0..1 杈圭紭缇藉寲
  despill?: number; // 0..1 鍘绘孩鑹诧紙鍑忓幓鑳屾櫙鑹叉畫鐣欙級
  fillBackground?: string; // 鍚堟垚搴曡壊锛堢┖ = 閫忔槑锛?
}

export interface MattingResult {
  canvas: HTMLCanvasElement;
  alpha: Float32Array;
  width: number;
  height: number;
}

export function composeRgbaFromAlpha(
  source: HTMLImageElement | HTMLCanvasElement,
  alpha: Float32Array,
): HTMLCanvasElement {
  const srcCanvas = source instanceof HTMLCanvasElement ? source : imageToCanvas(source);
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const src = srcCanvas.getContext('2d')!.getImageData(0, 0, w, h);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d')!;
  const img = octx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const si = i * 4;
    img.data[si] = src.data[si];
    img.data[si + 1] = src.data[si + 1];
    img.data[si + 2] = src.data[si + 2];
    img.data[si + 3] = clamp(alpha[i] ?? 0, 0, 1) * 255;
  }
  octx.putImageData(img, 0, 0);
  return out;
}

async function removeBackgroundWithImgly(
  source: HTMLImageElement | HTMLCanvasElement,
  options: MattingOptions = {},
): Promise<MattingResult> {
  const srcCanvas = source instanceof HTMLCanvasElement ? source : imageToCanvas(source);
  const sourceBlob = await new Promise<Blob>((resolve, reject) => {
    srcCanvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas.toBlob 澶辫触'))), 'image/png');
  });
  const { removeBackground } = await import('@imgly/background-removal');
  const outBlob = await removeBackground(sourceBlob, {
    model: 'isnet_quint8',
    device: 'cpu',
    proxyToWorker: false,
    output: { format: 'image/png' },
  });
  const outUrl = URL.createObjectURL(outBlob);
  try {
    const outImg = await loadImageFromUrl(outUrl);
    const outCanvas = imageToCanvas(outImg);
    const w = outCanvas.width;
    const h = outCanvas.height;
    const data = outCanvas.getContext('2d')!.getImageData(0, 0, w, h).data;
    const alpha = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) alpha[i] = (data[i * 4 + 3] || 0) / 255;
    if (options.fillBackground) {
      const bg = document.createElement('canvas');
      bg.width = w;
      bg.height = h;
      const bctx = bg.getContext('2d')!;
      bctx.fillStyle = options.fillBackground;
      bctx.fillRect(0, 0, w, h);
      bctx.drawImage(outCanvas, 0, 0);
      return { canvas: bg, alpha, width: w, height: h };
    }
    return { canvas: outCanvas, alpha, width: w, height: h };
  } finally {
    URL.revokeObjectURL(outUrl);
  }
}

/** 鐢ㄤ笂浼犺挋鐗堬紙鐏板害鍥撅紝鐧?鍓嶆櫙锛夊悎鎴愰€忔槑鍥撅紙鍥為€€璺緞锛夈€?*/
export function matteFromUploadedMask(
  source: HTMLImageElement | HTMLCanvasElement,
  mask: HTMLImageElement | HTMLCanvasElement,
  options: MattingOptions = {},
): MattingResult {
  const srcCanvas = source instanceof HTMLCanvasElement ? source : imageToCanvas(source);
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const srcData = srcCanvas.getContext('2d')!.getImageData(0, 0, w, h).data;

  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = w;
  maskCanvas.height = h;
  const mctx = maskCanvas.getContext('2d')!;
  mctx.drawImage(mask instanceof HTMLCanvasElement ? mask : mask, 0, 0, w, h);
  const maskData = mctx.getImageData(0, 0, w, h).data;

  return assembleMatte(srcData, maskData, w, h, options);
}

/** 鍦ㄦ寚瀹氬垎杈ㄧ巼涓嬫帹鐞?alpha 閬僵锛屽苟涓婇噰鏍峰洖鍘熷浘灏哄锛岃繑鍥?RGBA 鎺╃爜鍍忕礌鏁版嵁銆?*/
async function runMattingAtSize(
  session: Awaited<ReturnType<typeof createOrtSession>>,
  size: number,
  srcCanvas: HTMLCanvasElement,
  w: number,
  h: number,
): Promise<Uint8ClampedArray> {
  const pre = document.createElement('canvas');
  pre.width = pre.height = size;
  const pctx = pre.getContext('2d')!;
  pctx.drawImage(srcCanvas, 0, 0, size, size);
  const pdata = pctx.getImageData(0, 0, size, size).data;
  const tensor = new Float32Array(1 * 3 * size * size);
  for (let i = 0; i < size * size; i++) {
    for (let c = 0; c < 3; c++) {
      const val = pdata[i * 4 + c] / 255;
      tensor[c * size * size + i] = (val - IMAGENET_MEAN[c]) / IMAGENET_STD[c];
    }
  }
  // ONNX 模型期望 5D 输入 [N, C, 1, H, W]（onnx-community 导出格式），
  // 若传 4D [N, C, H, W] 会报 "Invalid rank for input: pixel_values Got 4 Expected: 5"。
  // 自适应 rank：先试本模型要求的 5D[1,3,1,H,W]，失败再退 4D[1,3,H,W]。
  // 两种 rank 的输入数据布局相同（中间那个 1 维不改变索引），仅张量 shape 不同。
  let raw: Float32Array | undefined;
  let lastRunErr: unknown;
  for (const dims of [[1, 3, 1, size, size], [1, 3, size, size]] as number[][]) {
    try {
      const inputTensor = await createTensor('float32', tensor, dims);
      console.info(`[matting] ▶ run rank=${dims.length}D @${size} in=${session.inputNames[0]} out=${session.outputNames[0]}`);
      const result = await session.run({ [session.inputNames[0]]: inputTensor });
      raw = (result[session.outputNames[0]] as { data: Float32Array }).data;
      break;
    } catch (err) {
      lastRunErr = err;
      console.warn(`[matting] run rank=${dims.length}D @${size} 失败，尝试下一 rank：`, (err as Error)?.message);
    }
  }
  if (!raw) throw lastRunErr instanceof Error ? lastRunErr : new Error('matting-run-failed');

  // 涓婇噰鏍峰洖鍘熷浘
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = maskCanvas.height = size;
  const mctx = maskCanvas.getContext('2d')!;
  const mimg = mctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = clamp(raw[i], 0, 1) * 255;
    mimg.data[i * 4] = mimg.data[i * 4 + 1] = mimg.data[i * 4 + 2] = v;
    mimg.data[i * 4 + 3] = 255;
  }
  mctx.putImageData(mimg, 0, 0);
  const up = document.createElement('canvas');
  up.width = w;
  up.height = h;
  const uctx = up.getContext('2d')!;
  uctx.imageSmoothingEnabled = true;
  uctx.imageSmoothingQuality = 'high';
  uctx.drawImage(maskCanvas, 0, 0, w, h);
  return uctx.getImageData(0, 0, w, h).data;
}

/** ONNX 鎺ㄧ悊鎶犲儚涓昏矾寰勶紙鍚垎杈ㄧ巼鑷€傚簲鍏滃簳锛夈€?*/
export async function removeBackground(
  source: HTMLImageElement | HTMLCanvasElement,
  options: MattingOptions = {},
): Promise<MattingResult> {
  const modelId = options.modelId ?? MATTING_MODEL_IDS.birefnet;
  mattingDiagnostic = '';
  if (!activeSession || activeSession.id !== modelId) {
    let loaded = await loadMattingModel(modelId);
    if (!loaded.ok && loaded.reason === 'model-not-cached') {
      const repaired = await ensureMattingModelCached(modelId);
      if (repaired.ok) {
        loaded = await loadMattingModel(modelId);
      } else {
        loaded = { ok: false, reason: repaired.reason || loaded.reason };
      }
    }
    if (!loaded.ok) {
      const initialReason = loaded.reason ?? 'unknown';
      // 释放 BiRefNet 失败创建的残留会话内存
      if (activeSession) {
        try { activeSession.session.release(); } catch { /* noop */ }
        activeSession = null;
      }
      const shouldFallbackToImgly = /model-not-cached|bad_alloc|session-create-failed|session-create-double-fail|Can't create a session/i.test(initialReason);
      if (shouldFallbackToImgly) {
        console.warn('[matting] BiRefNet unavailable, falling back to @imgly/background-removal', initialReason);
        mattingDiagnostic = `BiRefNet 初始化失败(${initialReason}) → 已回退 @imgly`;
        try {
          return await removeBackgroundWithImgly(source, options);
        } catch (fallbackErr) {
          throw new Error(`鎶犲儚妯″瀷鏈氨缁紙BiRefNet 涓?@imgly 鍧囦笉鍙敤锛夛細${(fallbackErr as Error)?.message ?? initialReason}`);
        }
      }
      throw new Error(`鎶犲儚妯″瀷鏈氨缁細${loaded.reason}`);
    }
  }
  const srcCanvas = source instanceof HTMLCanvasElement ? source : imageToCanvas(source);
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const srcData = srcCanvas.getContext('2d')!.getImageData(0, 0, w, h).data;
  const session = activeSession!.session;
  // BiRefNet 原生固定 1024² 输入（input_image 维度锁死 [1,3,1024,1024]）。
  // 任意源图都会经 runMattingAtSize 被 resize 到 1024² 再推理，源图尺寸无关紧要。
  // 960/768/640 等低分辨率候选对“固定形状模型”一律非法（维度不匹配），
  // 故只在原生 1024 推理一次；失败即换执行后端重试，避免误导性维度报错刷屏。
  const size = normalizeMattingSize(mattingInputSize);
  mattingInputSize = size;

  let firstErr: unknown;
  // ① 当前会话（WebGL）在原生 1024 上的推理
  try {
    const upData = await runMattingAtSize(session, size, srcCanvas, w, h);
    return assembleMatte(srcData, upData, w, h, options);
  } catch (err) {
    firstErr = err;
    console.warn('[matting] ⚠️ WebGL 推理 @1024 失败，准备回退 WASM(CPU)：', (err as Error)?.message);
  }

  // ② WASM(CPU) 后端重试（4GB 堆上限 + COOP✓ 多线程加速；算子覆盖最全）
  // 关键：先释放旧的 WebGL 会话，避免两个 ~973MB 会话同时驻留内存导致峰值翻倍加剧 OOM。
  if (activeSession) {
    try { activeSession.session.release(); } catch { /* noop */ }
    activeSession = null;
  }
  try {
    const cached = await getCachedModel(modelId, MATTING_MODEL_VERSION);
    if (cached?.data) {
      const wasmSession = await createOrtSession(cached.data as ArrayBuffer, undefined, { skipWasmOnly: false });
      const upData = await runMattingAtSize(wasmSession, size, srcCanvas, w, h);
      activeSession = { id: modelId, session: wasmSession, engine: 'wasm' };
      mattingDiagnostic = '';
      console.info('[matting] ✅ 已用 WASM(CPU)@1024 完成推理');
      return assembleMatte(srcData, upData, w, h, options);
    }
  } catch (err) {
    console.warn('[matting] ❌ WASM(CPU) 推理 @1024 也失败：', (err as Error)?.message);
  }

  // ③ 两个后端都失败 → 释放并回退 @imgly（展示第一次的真实原因）
  const finalMessage = (firstErr as Error)?.message ?? '';
  if (activeSession) { try { activeSession.session.release(); } catch { /* noop */ } activeSession = null; }
  const heapBytes = await getWasmHeapBytes();
  console.warn('[matting] ❌ BiRefNet 多后端均失败 | wasmHeapBytes=', heapBytes, '| firstErr=', finalMessage);
  const shouldFallbackToImgly = /bad_alloc|session-create-failed|session-create-double-fail|Can't create a session|invalid rank|invalid dimensions|input_image|not supported|ORT_RUNTIME/i.test(finalMessage);
  if (shouldFallbackToImgly) {
    console.warn('[matting] BiRefNet 推理失败，回退 @imgly：', finalMessage);
    const heapMb = heapBytes > 0 ? ` | wasm堆=${(heapBytes / 1048576) | 0}MB` : '';
    mattingDiagnostic = `BiRefNet 推理失败(${finalMessage})${heapMb} → 已回退 @imgly`;
    try {
      return await removeBackgroundWithImgly(source, options);
    } catch (fallbackErr) {
      throw new Error(
        `抠像推理失败（BiRefNet 与 @imgly 均不可用）：${(fallbackErr as Error)?.message ?? finalMessage}`,
      );
    }
  }
  throw new Error(
    `抠像推理失败（WebGL 与 WASM 后端均失败）：${finalMessage}`,
  );
}

function assembleMatte(
  srcData: Uint8ClampedArray,
  maskData: Uint8ClampedArray,
  w: number,
  h: number,
  options: MattingOptions,
): MattingResult {
  const feather = clamp(options.edgeFeather ?? 0.15, 0, 1);
  const despill = clamp(options.despill ?? 0.2, 0, 1);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  const alpha = new Float32Array(w * h);
  // 缇藉寲锛氬 mask 鍋氳交搴?box 妯＄硦锛?x3 澶氭锛夊悗鍐嶆槧灏勫埌 alpha 鏂滃潯
  const feathered = featherMask(maskData, w, h, Math.round(feather * 4) + 1);
  for (let i = 0; i < w * h; i++) {
    let a = feathered[i] / 255;
    // 鍘绘孩鑹诧細闄嶄綆鑳屾櫙娈嬬暀鐨勫僵杈癸紙绠€鍗曟寜 alpha 鍙嶅悜琛板噺楗卞拰锛?
    const si = i * 4;
    let r = srcData[si];
    let g = srcData[si + 1];
    let b = srcData[si + 2];
    if (despill > 0) {
      const gray = (r + g + b) / 3;
      const k = 1 - (1 - a) * despill;
      r = gray + (r - gray) * k;
      g = gray + (g - gray) * k;
      b = gray + (b - gray) * k;
    }
    alpha[i] = a;
    img.data[si] = r;
    img.data[si + 1] = g;
    img.data[si + 2] = b;
    img.data[si + 3] = a * 255;
  }
  ctx.putImageData(img, 0, 0);
  if (options.fillBackground) {
    const bg = document.createElement('canvas');
    bg.width = w;
    bg.height = h;
    const bctx = bg.getContext('2d')!;
    bctx.fillStyle = options.fillBackground;
    bctx.fillRect(0, 0, w, h);
    bctx.drawImage(out, 0, 0);
    return { canvas: bg, alpha, width: w, height: h };
  }
  return { canvas: out, alpha, width: w, height: h };
}

function featherMask(mask: Uint8ClampedArray, w: number, h: number, passes: number): Float32Array {
  let buf = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) buf[i] = mask[i * 4];
  for (let p = 0; p < passes; p++) {
    const next = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        let cnt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            sum += buf[ny * w + nx];
            cnt++;
          }
        }
        next[y * w + x] = sum / cnt;
      }
    }
    buf = next;
  }
  return buf;
}

export async function removeBackgroundFromUrl(
  url: string,
  options: MattingOptions = {},
): Promise<MattingResult> {
  const img = await loadImageFromUrl(url);
  return removeBackground(img, options);
}









