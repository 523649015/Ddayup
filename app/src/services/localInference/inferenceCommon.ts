/**
 * 本地推理公共能力：输入规格探测 + 瓦片推理（重叠羽化 + 主线程让出）
 *
 * 问题背景：
 * 1) 部分 ONNX（如 AXERA-TECH/Real-ESRGAN）是「固定 64×64 输入」的瓦片模型，
 *    直接喂整图会因输入空间尺寸不符而报 dimension 错误。必须切成 64×64 瓦片推理。
 * 2) onnxruntime-web 在 proxy=false / numThreads=1 下于「主线程」同步执行推理。
 *    连续跑上百个瓦片会长时间独占主线程 → 浏览器判定「页面无响应」甚至卡死。
 *    这里在每个瓦片之间用 setTimeout(0) 让出一次 macrotask，浏览器得以绘制与响应。
 * 3) 瓦片拼接在边界会产生拼缝；采用「重叠 + 互补权重羽化」混合，得到无缝结果。
 */

import { createTensor, type OrtSession } from './ortEnv';

const tileSizeCache = new WeakMap<OrtSession, number | null>();

/**
 * 探测模型输入空间尺寸规格：
 * - 64×64 可跑、128×128 失败 → 固定 64 瓦片模型
 * - 两者都可跑            → 动态输入（返回 null，由调用方自行决定分块大小）
 * - 64 失败              → 从报错里解析固定尺寸
 * inChannels 为模型真实输入通道数（esrgan=3，lama=4），探测张量需与之匹配。
 */
export async function detectTileSize(session: OrtSession, inChannels = 3): Promise<number | null> {
  if (tileSizeCache.has(session)) return tileSizeCache.get(session) ?? null;
  const inputName = session.inputNames[0];
  const tryRun = async (s: number): Promise<void> => {
    const dummy = new Float32Array(1 * inChannels * s * s);
    const t = await createTensor('float32', dummy, [1, inChannels, s, s]);
    await session.run({ [inputName]: t });
  };

  let size: number | null;
  let works64 = true;
  try {
    await tryRun(64);
  } catch {
    works64 = false;
  }

  if (works64) {
    let works128 = true;
    try {
      await tryRun(128);
    } catch {
      works128 = false;
    }
    size = works128 ? null : 64;
  } else {
    let parsed = 64;
    try {
      await tryRun(64);
    } catch (e) {
      const m = String((e as { message?: string })?.message ?? e ?? '');
      const nums = [...m.matchAll(/Expected:\s*(\d+)/g)].map((x) => Number(x[1]));
      parsed = nums.length >= 2 && nums[1] === nums[2] ? nums[1] : 64;
    }
    size = parsed;
  }

  tileSizeCache.set(session, size);
  return size;
}

export interface TiledRunOptions {
  iw: number;
  ih: number;
  /** 模型固定/分块输入边长 */
  T: number;
  inChannels: number;
  outChannels: number;
  /** 输出/输入空间比（esrgan=4，lama=1） */
  scale: number;
  /** 输入空间重叠像素（羽化用），必须 < T */
  overlap: number;
  /** 取出 (sx,sy) 起、sw×sh 大小的输入，返回长度 inChannels*T*T（不足 T 的边界由调用方零填充） */
  getInputTile: (sx: number, sy: number, sw: number, sh: number) => Float32Array;
  logTag?: string;
  onProgress?: (done: number, total: number) => void;
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** 生成覆盖 [0,dim) 的 T 宽窗口起点；stride=T-overlap，末窗贴边以保证全覆盖 */
function genStarts(dim: number, T: number, stride: number): number[] {
  if (dim <= T) return [0];
  const starts: number[] = [];
  let s = 0;
  while (s + T < dim) {
    starts.push(s);
    s += stride;
  }
  const last = starts[starts.length - 1];
  if (last + T < dim) starts.push(dim - T);
  return starts;
}

/**
 * 瓦片推理 + 重叠羽化混合 + 主线程让出。
 * 返回长度 iw*scale*ih*scale*outChannels 的浮点输出（已按权重归一化）。
 */
export async function tiledRun(session: OrtSession, opts: TiledRunOptions): Promise<Float32Array> {
  const { iw, ih, T, inChannels, outChannels, scale, overlap, getInputTile, logTag, onProgress } = opts;
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const safeOverlap = Math.max(0, Math.min(overlap, T - 1));
  const stride = Math.max(1, T - safeOverlap);
  const overlapOut = Math.round(safeOverlap * scale);

  const OW = iw * scale;
  const OH = ih * scale;
  const outLen = OW * OH * outChannels;
  const acc = new Float32Array(outLen);
  const wsum = new Float32Array(OW * OH);

  const xs = genStarts(iw, T, stride);
  const ys = genStarts(ih, T, stride);
  const total = xs.length * ys.length;
  let done = 0;

  for (let yi = 0; yi < ys.length; yi += 1) {
    const sy = ys[yi];
    for (let xi = 0; xi < xs.length; xi += 1) {
      const sx = xs[xi];
      const sw = Math.min(T, iw - sx);
      const sh = Math.min(T, ih - sy);
      const tile = getInputTile(sx, sy, sw, sh);
      const t = await createTensor('float32', tile, [1, inChannels, T, T]);
      // eslint-disable-next-line no-await-in-loop
      const res = await session.run({ [inputName]: t });
      const outTensor = res[outputName];
      const odims = (outTensor as { dims: readonly number[] }).dims;
      const OT = odims[2];
      const tileOut = outTensor.data as unknown as Float32Array;

      const leftBorder = sx <= 0;
      const rightBorder = sx + T >= iw;
      const topBorder = sy <= 0;
      const bottomBorder = sy + T >= ih;

      const outX0 = sx * scale;
      const outY0 = sy * scale;
      for (let y = 0; y < OT; y += 1) {
        let wy: number;
        if (!topBorder && y < overlapOut) wy = (y + 0.5) / overlapOut;
        else if (!bottomBorder && y >= OT - overlapOut) wy = (OT - 0.5 - y) / overlapOut;
        else wy = 1;
        const outY = outY0 + y;
        if (outY >= OH) break;
        const rowBase = outY * OW;
        for (let x = 0; x < OT; x += 1) {
          let wx: number;
          if (!leftBorder && x < overlapOut) wx = (x + 0.5) / overlapOut;
          else if (!rightBorder && x >= OT - overlapOut) wx = (OT - 0.5 - x) / overlapOut;
          else wx = 1;
          const outX = outX0 + x;
          if (outX >= OW) continue;
          const w = wx * wy;
          const oi = (rowBase + outX) * outChannels;
          const ii = (y * OT + x) * outChannels;
          for (let c = 0; c < outChannels; c += 1) {
            acc[oi + c] += tileOut[ii + c] * w;
          }
          wsum[rowBase + outX] += w;
        }
      }
      done += 1;
      if (onProgress) onProgress(done, total);
      else if (logTag && done % 12 === 0) console.log(`[${logTag}] 瓦片 ${done}/${total}`);
      // 让出主线程，浏览器得以绘制与响应，避免「页面无响应」
      // eslint-disable-next-line no-await-in-loop
      await tick();
    }
  }

  for (let p = 0; p < OW * OH; p += 1) {
    const w = wsum[p];
    const base = p * outChannels;
    if (w > 1e-6) {
      const inv = 1 / w;
      for (let c = 0; c < outChannels; c += 1) acc[base + c] *= inv;
    }
  }
  return acc;
}
