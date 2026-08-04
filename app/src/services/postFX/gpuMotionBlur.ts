/**
 * 客户端 GPU 真实运动模糊管线（WebGPU + RAFT 光流 / RIFE 插帧 + WebCodecs 封装）
 *
 * 这是「一键电影感·视频」的最佳质量运动模糊来源，相比服务端 ffmpeg tblend 更快、更可控，
 * 且能在浏览器内对视频逐帧做「运动补偿的方向性模糊」（物体越动越糊、静止越清）。
 *
 * 原理（运动补偿帧累积，即真实快门拖影）：
 *   - RAFT 光流路径（默认，必选）：对相邻帧 A→B 估计逐像素光流，在着色器里沿光流方向把 B 向
 *     A 回退 S 个等距子样本并取均值 → 等效于「快门在时间上铺开」的运动模糊，最省算力
 *     （每对帧只需 1 次 RAFT 推理 + 1 次 GPU 绘制）。
 *   - RIFE 插帧路径（可选增强，useRife=true 时优先）：先用 RIFE 在 A、B 间合成 S-1 个运动补偿
 *     的中间帧（即「先插帧」），再把 [A, 中间帧…, B] 在 GPU 里直接求均值（即「再运动模糊」）。
 *     对快速/非线性运动比线性光流采样更真实（中间帧已是沿真实轨迹的高保真样本），代价是每对帧
 *     多 S-1 次 RIFE 推理。RIFE 模型缺失/加载失败/推理异常时自动回退到 RAFT 光流路径，保证一键可用。
 *
 * 封装：WebCodecs VideoEncoder + webm-muxer（即 WebAV 的编码内核，WebAV 本身即 WebCodecs + webm-muxer
 * 的高层封装），输出 webm；与后续「逐帧调色 / 智能景深」解耦，作为源视频的前处理阶段。
 *
 * 兼容性：无 WebGPU 或不支持 VideoEncoder 时 isGpuMotionBlurSupported() 返回 false，调用方回退到
 * 服务端 ffmpeg 模糊或客户端 RAFT JS 模糊。
 *
 * 注：项目未引入 @webgpu/types，WebGPU 相关类型统一用 any，运行时全局从 globalThis 取。
 */

import { createOrtSession, createTensor } from '@/services/localInference/ortEnv';
import { getCachedModel, cacheModel } from '@/services/storage';
import { estimateOpticalFlowRAFT, type OpticalFlowField } from './motionBlur';

/* ============ 运行时 GPU 全局 ============ */
const GPU_TEXTURE_USAGE = (globalThis as unknown as { GPUTextureUsage?: any }).GPUTextureUsage;
const GPU_BUFFER_USAGE = (globalThis as unknown as { GPUBufferUsage?: any }).GPUBufferUsage;

/* ============ 工具 ============ */
function yieldToUI(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}
function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      resolve();
    };
    video.addEventListener('seeked', onSeeked);
    video.currentTime = Math.min(Math.max(t, 0), (Number.isFinite(video.duration) ? video.duration : t) - 0.001);
  });
}

/* ============ 对外类型 ============ */
export type GpuMotionBlurEngine = 'webgpu-raft-flow' | 'webgpu-rife-framegen';

export interface GpuMotionBlurOptions {
  strength?: 'light' | 'auto' | 'strong';
  fps?: number;
  maxSide?: number;
  /** 优先使用 RIFE 插帧后累积（更真实），失败自动回退 RAFT 光流 */
  useRife?: boolean;
  /** RIFE ONNX 地址（缺省用面板预设 / 内置默认）；不可用时回退 RAFT */
  rifeUrl?: string;
  onProgress?: (progress: number, message: string) => void;
}

export interface GpuMotionBlurResult {
  ok: boolean;
  blob?: Blob;
  url?: string;
  engine?: GpuMotionBlurEngine;
  reason?: string;
}

const DEFAULT_RIFE_URL =
  '/api/hf-proxy/TensorStack/RIFE/resolve/main/model.onnx';

/** 浏览器是否具备客户端 GPU 运动模糊能力（WebGPU + VideoEncoder） */
export function isGpuMotionBlurSupported(): boolean {
  const hasGpu = typeof navigator !== 'undefined' && !!(navigator as unknown as { gpu?: unknown }).gpu;
  const hasEncoder = typeof (globalThis as unknown as { VideoEncoder?: unknown }).VideoEncoder !== 'undefined';
  return hasGpu && hasEncoder;
}

/* ============ WGSL 着色器 ============ */
// RAFT 光流路径：沿光流方向把 B 回退 S 个子样本取均值（运动补偿模糊）
const FLOW_ACCUM_WGSL = /* wgsl */ `
struct Params { texel: vec2f, S: u32, maxFlow: f32 };
@group(0) @binding(0) var sampF: sampler;   // 颜色用：线性过滤
@group(0) @binding(1) var sampN: sampler;   // 光流用：最近邻
@group(0) @binding(2) var texA: texture_2d<f32>;
@group(0) @binding(3) var texB: texture_2d<f32>;
@group(0) @binding(4) var texFlow: texture_2d<f32>;
@group(0) @binding(5) var<uniform> P: Params;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let dim = textureDimensions(texB);
  let uv = vec2f(pos.x, pos.y) / vec2f(f32(dim.x), f32(dim.y));
  let raw = textureSampleLevel(texFlow, sampN, uv, 0.0).rg;
  let flow = (raw - vec2f(0.5)) * 2.0 * P.maxFlow;
  var acc = vec3f(0.0);
  let S = P.S;
  for (var k: u32 = 0u; k <= S; k = k + 1u) {
    let tau = f32(k) / f32(S);
    let sUv = uv - tau * flow * P.texel;
    acc += textureSampleLevel(texB, sampF, sUv, 0.0).rgb;
  }
  return vec4f(acc / f32(S + 1u), 1.0);
}
`;

// RIFE 插帧路径：把 N 张帧（A + 中间帧 + B）直接求均值
const AVERAGE_WGSL = /* wgsl */ `
struct Params { count: u32, pad0: u32, pad1: u32, pad2: u32 };
@group(0) @binding(0) var sampF: sampler;
@group(0) @binding(1) var texArr: array<texture_2d<f32>, 8>;
@group(0) @binding(2) var<uniform> P: Params;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let dim = textureDimensions(texArr[0]);
  let uv = vec2f(pos.x, pos.y) / vec2f(f32(dim.x), f32(dim.y));
  var acc = vec3f(0.0);
  for (var k: u32 = 0u; k < P.count; k = k + 1u) {
    acc += textureSampleLevel(texArr[k], sampF, uv, 0.0).rgb;
  }
  return vec4f(acc / f32(P.count), 1.0);
}
`;

/* ============ GPU 管线封装 ============ */
interface GpuPipeline {
  device: any;
  queue: any;
  flowPipeline: any;
  avgPipeline: any;
  samplerF: any;
  samplerN: any;
  canvas: OffscreenCanvas;
  ctx: any;
  format: any;
  width: number;
  height: number;
}

async function initGpuPipeline(width: number, height: number): Promise<GpuPipeline> {
  const gpu = (navigator as unknown as { gpu: any }).gpu;
  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new Error('no-webgpu-adapter');
  const device = await adapter.requestDevice();
  const format = gpu.getPreferredCanvasFormat();

  const moduleFlow = device.createShaderModule({ code: FLOW_ACCUM_WGSL });
  const moduleAvg = device.createShaderModule({ code: AVERAGE_WGSL });

  const flowPipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: moduleFlow, entryPoint: 'vs' },
    fragment: { module: moduleFlow, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });
  const avgPipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: moduleAvg, entryPoint: 'vs' },
    fragment: { module: moduleAvg, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });

  const samplerF = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });
  const samplerN = device.createSampler({
    magFilter: 'nearest',
    minFilter: 'nearest',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('webgpu') as any;
  if (!ctx) throw new Error('no-webgpu-canvas-context');
  ctx.configure({ device, format, alphaMode: 'opaque' });

  return { device, queue: device.queue, flowPipeline, avgPipeline, samplerF, samplerN, canvas, ctx, format, width, height };
}

function copyCanvasToTexture(pl: GpuPipeline, canvas: HTMLCanvasElement): any {
  const tex = pl.device.createTexture({
    size: [canvas.width, canvas.height],
    format: 'rgba8unorm',
    usage:
      GPU_TEXTURE_USAGE.TEXTURE_BINDING |
      GPU_TEXTURE_USAGE.COPY_DST |
      GPU_TEXTURE_USAGE.RENDER_ATTACHMENT,
  });
  pl.queue.copyExternalImageToTexture(
    { source: canvas },
    { texture: tex },
    [canvas.width, canvas.height],
  );
  return tex;
}

/** 把 RAFT 光流（网格分辨率）上采样到帧分辨率，编码进 rgba8 画布（R/G = fx/fy）。 */
function makeFlowCanvas(field: OpticalFlowField, width: number, height: number): HTMLCanvasElement {
  const fw = field.width;
  const fh = field.height;
  const flow = field.flow;
  const maxFlow = 0.25 * Math.max(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const img = new ImageData(width, height);
  const sx = fw / width;
  const sy = fh / height;
  for (let y = 0; y < height; y++) {
    const gy = Math.min(fh - 1, Math.floor(y * sy));
    const gy1 = Math.min(fh - 1, gy + 1);
    const fyf = y * sy - gy;
    for (let x = 0; x < width; x++) {
      const gx = Math.min(fw - 1, Math.floor(x * sx));
      const gx1 = Math.min(fw - 1, gx + 1);
      const fxf = x * sx - gx;
      const i00 = (gy * fw + gx) * 2;
      const i10 = (gy * fw + gx1) * 2;
      const i01 = (gy1 * fw + gx) * 2;
      const i11 = (gy1 * fw + gx1) * 2;
      // 双线性插值光流（网格像素），再换算到帧像素位移
      const fxGrid =
        (flow[i00] * (1 - fxf) + flow[i10] * fxf) * (1 - fyf) +
        (flow[i01] * (1 - fxf) + flow[i11] * fxf) * fyf;
      const fyGrid =
        (flow[i00 + 1] * (1 - fxf) + flow[i10 + 1] * fxf) * (1 - fyf) +
        (flow[i01 + 1] * (1 - fxf) + flow[i11 + 1] * fxf) * fyf;
      const fx = fxGrid * (width / fw);
      const fy = fyGrid * (height / fh);
      const di = (y * width + x) * 4;
      img.data[di] = Math.max(0, Math.min(255, Math.round((fx / (2 * maxFlow) + 0.5) * 255)));
      img.data[di + 1] = Math.max(0, Math.min(255, Math.round((fy / (2 * maxFlow) + 0.5) * 255)));
      img.data[di + 2] = 0;
      img.data[di + 3] = 255;
    }
  }
  canvas.getContext('2d')!.putImageData(img, 0, 0);
  return canvas;
}

/** RAFT 光流路径：渲染一对帧的运动补偿模糊到管线画布。 */
function renderFlowAccum(
  pl: GpuPipeline,
  frameA: HTMLCanvasElement,
  frameB: HTMLCanvasElement,
  field: OpticalFlowField,
  S: number,
): void {
  const texA = copyCanvasToTexture(pl, frameA);
  const texB = copyCanvasToTexture(pl, frameB);
  const flowCanvas = makeFlowCanvas(field, pl.width, pl.height);
  const texFlow = copyCanvasToTexture(pl, flowCanvas);

  const maxFlow = 0.25 * Math.max(pl.width, pl.height);
  const uniform = new ArrayBuffer(16);
  const dv = new DataView(uniform);
  dv.setFloat32(0, 1 / pl.width, true); // texel.x
  dv.setFloat32(4, 1 / pl.height, true); // texel.y
  dv.setUint32(8, S, true); // S
  dv.setFloat32(12, maxFlow, true); // maxFlow
  const ubo = pl.device.createBuffer({
    size: 16,
    usage: GPU_BUFFER_USAGE.UNIFORM | GPU_BUFFER_USAGE.COPY_DST,
  });
  pl.queue.writeBuffer(ubo, 0, uniform);

  const bind = pl.device.createBindGroup({
    layout: pl.flowPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: pl.samplerF },
      { binding: 1, resource: pl.samplerN },
      { binding: 2, resource: texA.createView() },
      { binding: 3, resource: texB.createView() },
      { binding: 4, resource: texFlow.createView() },
      { binding: 5, resource: { buffer: ubo } },
    ],
  });

  const encoder = pl.device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: pl.ctx.getCurrentTexture().createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      },
    ],
  });
  pass.setPipeline(pl.flowPipeline);
  pass.setBindGroup(0, bind);
  pass.draw(3);
  pass.end();
  pl.queue.submit([encoder.finish()]);

  texA.destroy();
  texB.destroy();
  texFlow.destroy();
  ubo.destroy();
}

/** RIFE 插帧路径：把多张帧直接求均值渲染到管线画布。 */
function renderAverage(pl: GpuPipeline, frames: HTMLCanvasElement[]): void {
  const count = Math.min(8, frames.length);
  const textures = frames.slice(0, count).map((c) => copyCanvasToTexture(pl, c));
  while (textures.length < 8) textures.push(textures[textures.length - 1]); // 不足 8 张用末张补齐

  const uniform = new ArrayBuffer(16);
  new DataView(uniform).setUint32(0, count, true);
  const ubo = pl.device.createBuffer({
    size: 16,
    usage: GPU_BUFFER_USAGE.UNIFORM | GPU_BUFFER_USAGE.COPY_DST,
  });
  pl.queue.writeBuffer(ubo, 0, uniform);

  // 注意：WGSL `array<texture_2d<f32>, 8>` 在 bind group 中作为「单个 binding（binding 1）
  // 传入 8 个视图的数组」，而非 8 条重复 binding=1 的条目。
  const entries: any[] = [
    { binding: 0, resource: pl.samplerF },
    { binding: 1, resource: textures.map((t) => t.createView()) },
    { binding: 2, resource: { buffer: ubo } },
  ];

  const bind = pl.device.createBindGroup({
    layout: pl.avgPipeline.getBindGroupLayout(0),
    entries,
  });

  const encoder = pl.device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: pl.ctx.getCurrentTexture().createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      },
    ],
  });
  pass.setPipeline(pl.avgPipeline);
  pass.setBindGroup(0, bind);
  pass.draw(3);
  pass.end();
  pl.queue.submit([encoder.finish()]);

  textures.forEach((t) => t.destroy());
  ubo.destroy();
}

/* ============ RIFE 加载与插帧 ============ */
async function tryLoadRife(url?: string): Promise<any | null> {
  const rifeUrl = url || DEFAULT_RIFE_URL;
  if (!rifeUrl) return null;
  try {
    let data: ArrayBuffer | undefined;
    const cached = await getCachedModel('rife-frame-interpolation', '1.0.0');
    if (cached?.data) data = cached.data as ArrayBuffer;
    else {
      const res = await fetch(rifeUrl);
      if (!res.ok) throw new Error(`rife-fetch-${res.status}`);
      data = await res.arrayBuffer();
      await cacheModel('rife-frame-interpolation', '1.0.0', data).catch(() => {});
    }
    const session = await createOrtSession(data);
    return session;
  } catch (err) {
    console.warn('[gpuMotionBlur] RIFE 加载失败，回退 RAFT 光流：', err);
    return null;
  }
}

const RIFE_SIZE = 224;

/** RIFE 在 (a,b) 间时刻 t∈(0,1) 插一帧，返回画布。失败返回 null。 */
async function runRife(
  session: any,
  a: HTMLCanvasElement,
  b: HTMLCanvasElement,
  t: number,
): Promise<HTMLCanvasElement | null> {
  try {
    const build = (c: HTMLCanvasElement): Float32Array => {
      const cv = document.createElement('canvas');
      cv.width = cv.height = RIFE_SIZE;
      const ctx = cv.getContext('2d')!;
      ctx.drawImage(c, 0, 0, RIFE_SIZE, RIFE_SIZE);
      const d = ctx.getImageData(0, 0, RIFE_SIZE, RIFE_SIZE).data;
      const plane = RIFE_SIZE * RIFE_SIZE;
      const out = new Float32Array(3 * plane);
      for (let i = 0; i < plane; i++) {
        out[i] = d[i * 4] / 255;
        out[plane + i] = d[i * 4 + 1] / 255;
        out[2 * plane + i] = d[i * 4 + 2] / 255;
      }
      return out;
    };
    const inputs = session.inputNames as string[];
    const feeds: Record<string, unknown> = {};
    feeds[inputs[0]] = await createTensor('float32', build(a), [1, 3, RIFE_SIZE, RIFE_SIZE]);
    feeds[inputs[1]] = await createTensor('float32', build(b), [1, 3, RIFE_SIZE, RIFE_SIZE]);
    if (inputs.length >= 3) {
      feeds[inputs[2]] = await createTensor('float32', new Float32Array([t]), [1, 1, 1, 1]);
    }
    const out = await session.run(feeds);
    const outName = session.outputNames[0] as string;
    const res = out[outName];
    const arr = res.data as Float32Array;
    const dims = (res.dims as number[]) ?? [1, 3, RIFE_SIZE, RIFE_SIZE];
    const oh = dims.length === 4 ? dims[2] : RIFE_SIZE;
    const ow = dims.length === 4 ? dims[3] : RIFE_SIZE;
    const plane = oh * ow;
    const canvas = document.createElement('canvas');
    canvas.width = ow;
    canvas.height = oh;
    const img = new ImageData(ow, oh);
    for (let i = 0; i < plane; i++) {
      img.data[i * 4] = Math.max(0, Math.min(255, Math.round(arr[i] * 255)));
      img.data[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(arr[plane + i] * 255)));
      img.data[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(arr[2 * plane + i] * 255)));
      img.data[i * 4 + 3] = 255;
    }
    canvas.getContext('2d')!.putImageData(img, 0, 0);
    return canvas;
  } catch (err) {
    console.warn('[gpuMotionBlur] RIFE 插帧失败：', err);
    return null;
  }
}

/* ============ 源视频抽帧 ============ */
async function extractFrames(
  url: string,
  fps: number,
  maxSide: number,
): Promise<{ frames: HTMLCanvasElement[]; width: number; height: number; duration: number }> {
  const video = document.createElement('video');
  video.src = url;
  video.muted = true;
  video.crossOrigin = 'anonymous';
  video.playsInline = true;
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error('video-load-failed'));
  });
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const scale = Math.min(1, maxSide / Math.max(vw, vh));
  const pw = Math.max(2, Math.round(vw * scale));
  const ph = Math.max(2, Math.round(vh * scale));
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const total = Math.max(1, Math.floor(duration * fps));
  const frames: HTMLCanvasElement[] = [];
  for (let i = 0; i < total; i++) {
    await seekTo(video, i / fps);
    const c = document.createElement('canvas');
    c.width = pw;
    c.height = ph;
    c.getContext('2d')!.drawImage(video, 0, 0, pw, ph);
    frames.push(c);
    if (i % 5 === 0) await yieldToUI();
  }
  return { frames, width: pw, height: ph, duration };
}

/* ============ 封装（WebCodecs + webm-muxer） ============ */
async function pickCodec(
  width: number,
  height: number,
  fps: number,
): Promise<{ codec: string; muxerCodec: 'V8' | 'V9' } | null> {
  const VE = (globalThis as unknown as { VideoEncoder: any }).VideoEncoder;
  const candidates: Array<{ codec: string; muxerCodec: 'V8' | 'V9' }> = [
    { codec: 'vp09.00.10.08', muxerCodec: 'V9' },
    { codec: 'vp8', muxerCodec: 'V8' },
  ];
  for (const c of candidates) {
    try {
      const s = await VE.isConfigSupported({ codec: c.codec, width, height, framerate: fps });
      if (s?.supported) return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

/* ============ 主入口 ============ */
export async function applyGpuMotionBlurVideoLocally(
  srcUrl: string,
  opts: GpuMotionBlurOptions = {},
): Promise<GpuMotionBlurResult> {
  if (!isGpuMotionBlurSupported()) return { ok: false, reason: 'unsupported' };
  const fps = opts.fps ?? 12;
  const maxSide = opts.maxSide ?? 720;
  const strength = opts.strength ?? 'auto';
  const shutterNorm = strength === 'strong' ? 0.85 : strength === 'light' ? 0.25 : 0.5;
  // 子样本数（快门角度）：light 小、strong 大
  const S = Math.max(2, Math.min(8, Math.round(2 + shutterNorm * 6)));

  let extracted: { frames: HTMLCanvasElement[]; width: number; height: number; duration: number };
  try {
    extracted = await extractFrames(srcUrl, fps, maxSide);
  } catch (err) {
    return { ok: false, reason: `extract-failed: ${(err as Error)?.message ?? err}` };
  }
  const { frames, width, height, duration } = extracted;
  if (frames.length < 2) return { ok: false, reason: 'too-few-frames' };

  let pl: GpuPipeline;
  try {
    pl = await initGpuPipeline(width, height);
  } catch (err) {
    return { ok: false, reason: `gpu-init-failed: ${(err as Error)?.message ?? err}` };
  }

  // RIFE 可选增强
  let rifeSession: any = null;
  if (opts.useRife) {
    rifeSession = await tryLoadRife(opts.rifeUrl);
  }
  const engine: GpuMotionBlurEngine = rifeSession ? 'webgpu-rife-framegen' : 'webgpu-raft-flow';

  const codec = await pickCodec(width, height, fps);
  if (!codec) {
    pl.device.destroy();
    return { ok: false, reason: 'no-video-encoder' };
  }

  const { Muxer, ArrayBufferTarget } = await import('webm-muxer');
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: codec.muxerCodec, width, height, frameRate: fps },
    firstTimestampBehavior: 'offset',
  });
  const VE = (globalThis as unknown as { VideoEncoder: any }).VideoEncoder;
  const encoder = new VE({
    output: (chunk: any, meta: any) => muxer.addVideoChunk(chunk, meta),
    error: (e: Error) => console.error('[gpuMotionBlur] encoder error', e),
  });
  encoder.configure({ codec: codec.codec, width, height, bitrate: 8_000_000, framerate: fps });

  const rifeSamples = Math.min(S, 6); // 留出 A/B 两张，合计 ≤8 纹理
  for (let i = 0; i < frames.length; i++) {
    const a = frames[i];
    const b = frames[Math.min(i + 1, frames.length - 1)];
    try {
      if (i === frames.length - 1) {
        // 末帧：原样输出（避免复用上一帧画面）
        renderAverage(pl, [a]);
      } else if (rifeSession) {
        // 先插帧：生成 rifeSamples-1 个中间帧，再与 A/B 一起求均值
        const seq: HTMLCanvasElement[] = [a];
        let rifeOk = true;
        for (let k = 1; k < rifeSamples; k++) {
          const t = k / rifeSamples;
          const mid = await runRife(rifeSession, a, b, t);
          if (!mid) {
            rifeOk = false;
            break;
          }
          seq.push(mid);
        }
        if (rifeOk) {
          seq.push(b);
          renderAverage(pl, seq);
        } else {
          rifeSession = null; // 整段回退 RAFT
          const flow = await estimateOpticalFlowRAFT(a, b, 256);
          if (flow) renderFlowAccum(pl, a, b, flow, S);
          else renderAverage(pl, [a]);
        }
      } else {
        const flow = await estimateOpticalFlowRAFT(a, b, 256);
        if (flow) renderFlowAccum(pl, a, b, flow, S);
        else renderAverage(pl, [a]);
      }
    } catch (err) {
      console.warn('[gpuMotionBlur] 渲染第', i, '帧失败：', err);
      renderAverage(pl, [a]);
    }

    // 等待 GPU 完成当前帧渲染，再抓取为 VideoFrame
    await pl.queue.onSubmittedWorkDone();
    const VF = (globalThis as unknown as { VideoFrame: any }).VideoFrame;
    const vf = new VF(pl.canvas, {
      timestamp: Math.round((i * 1e6) / fps),
      duration: Math.round(1e6 / fps),
    });
    encoder.encode(vf);
    vf.close();
    opts.onProgress?.(
      Math.round(((i + 1) / frames.length) * 100),
      `GPU 运动模糊 ${i + 1}/${frames.length}（${engine}）`,
    );
    if (i % 4 === 0) await yieldToUI();
  }

  await encoder.flush();
  muxer.finalize();
  const buffer = (muxer.target as unknown as { buffer: ArrayBuffer }).buffer;
  const blob = new Blob([buffer], { type: 'video/webm' });
  const url = URL.createObjectURL(blob);
  pl.device.destroy();
  return { ok: true, blob, url, engine };
}
