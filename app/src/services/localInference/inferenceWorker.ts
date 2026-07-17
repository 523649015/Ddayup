/**
 * 本地推理 Web Worker（承载全部 onnxruntime-web 计算）
 *
 * 为什么需要它：onnxruntime-web 在 proxy=false / numThreads=1 下于「主线程」同步执行
 * 推理，连续上百个瓦片会长时间独占主线程 → 浏览器判定「页面无响应」甚至卡死。
 * onnxruntime-web 自带包没有 worker 文件，无法用 proxy=true，因此这里自建一个
 * Worker：会话创建与瓦片推理全部在 Worker 内完成，主线程仅做图片解码/结果编码，
 * 推理期间页面保持流畅、可响应。
 *
 * 通信：
 *  - { type:'create', id, buffer }           → Worker 内创建会话
 *  - { type:'created'|'error', id }           → 创建结果
 *  - { type:'run', id, kind, rgba, w, h, mask? } → 推理，期间发 progress，结束发 result
 *  - { type:'dispose', id }                   → 释放会话
 */

import { createOrtSession, type OrtSession } from './ortEnv';
import { detectTileSize, tiledRun } from './inferenceCommon';

const sessions = new Map<string, OrtSession>();

interface CreateMsg { type: 'create'; id: string; buffer: ArrayBuffer }
interface RunMsg {
  type: 'run';
  id: string;
  kind: 'esrgan' | 'lama';
  rgba: ArrayBuffer;
  width: number;
  height: number;
  mask?: ArrayBuffer;
}
interface DisposeMsg { type: 'dispose'; id: string }
type InMsg = CreateMsg | RunMsg | DisposeMsg;

const ctx: any = self;

function clamp255(v: number): number {
  if (v < 0) return 0;
  if (v > 255) return 255;
  return v;
}

async function runModel(
  session: OrtSession,
  msg: RunMsg,
): Promise<{ out: Uint8ClampedArray; outWidth: number; outHeight: number }> {
  const { kind, rgba, width, height, mask } = msg;
  const inChannels = kind === 'esrgan' ? 3 : 4;
  const outChannels = 3;
  const scale = kind === 'esrgan' ? 4 : 1;
  const overlap = kind === 'esrgan' ? 16 : 32;
  const logTag = kind;

  // —— 预处理：RGBA → 模型输入通道（归一化到 [0,1]） ——
  const px = new Uint8ClampedArray(rgba);
  const pre = new Float32Array(width * height * inChannels);
  if (kind === 'esrgan') {
    for (let i = 0; i < width * height; i += 1) {
      pre[i * 3] = px[i * 4] / 255;
      pre[i * 3 + 1] = px[i * 4 + 1] / 255;
      pre[i * 3 + 2] = px[i * 4 + 2] / 255;
    }
  } else {
    const maskPx = mask ? new Uint8ClampedArray(mask) : null;
    for (let i = 0; i < width * height; i += 1) {
      pre[i * 4] = px[i * 4] / 255;
      pre[i * 4 + 1] = px[i * 4 + 1] / 255;
      pre[i * 4 + 2] = px[i * 4 + 2] / 255;
      const mv = maskPx
        ? (maskPx[i * 4] + maskPx[i * 4 + 1] + maskPx[i * 4 + 2]) / 3 / 255
        : 0;
      pre[i * 4 + 3] = mv > 0.5 ? 1 : mv;
    }
  }

  // 固定尺寸瓦片模型探测（Worker 内，不阻塞主线程）
  const T = (await detectTileSize(session, inChannels)) ?? (kind === 'esrgan' ? 64 : 256);

  const out = await tiledRun(session, {
    iw: width,
    ih: height,
    T,
    inChannels,
    outChannels,
    scale,
    overlap,
    logTag,
    getInputTile: (sx, sy, sw, sh) => {
      const buf = new Float32Array(inChannels * T * T);
      for (let y = 0; y < sh; y += 1) {
        for (let x = 0; x < sw; x += 1) {
          const si = ((sy + y) * width + (sx + x)) * inChannels;
          const ti = (y * T + x) * inChannels;
          for (let c = 0; c < inChannels; c += 1) buf[ti + c] = pre[si + c];
        }
      }
      return buf;
    },
  });

  // —— 后处理：模型输出（[0,1] 或 [0,255]）→ RGBA ——
  const OW = width * scale;
  const OH = height * scale;
  const outImage = new Uint8ClampedArray(OW * OH * 4);
  if (kind === 'esrgan') {
    let maxV = 0;
    for (let i = 0; i < OW * OH * 3; i += 1) if (out[i] > maxV) maxV = out[i];
    const mult = maxV <= 1.0001 ? 255 : 1;
    for (let i = 0; i < OW * OH; i += 1) {
      outImage[i * 4] = clamp255(out[i * 3] * mult);
      outImage[i * 4 + 1] = clamp255(out[i * 3 + 1] * mult);
      outImage[i * 4 + 2] = clamp255(out[i * 3 + 2] * mult);
      outImage[i * 4 + 3] = 255;
    }
  } else {
    for (let i = 0; i < OW * OH; i += 1) {
      outImage[i * 4] = clamp255(out[i * 3] * 255);
      outImage[i * 4 + 1] = clamp255(out[i * 3 + 1] * 255);
      outImage[i * 4 + 2] = clamp255(out[i * 3 + 2] * 255);
      outImage[i * 4 + 3] = 255;
    }
  }
  return { out: outImage, outWidth: OW, outHeight: OH };
}

ctx.onmessage = async (ev: MessageEvent<InMsg>): Promise<void> => {
  const msg = ev.data;
  try {
    if (msg.type === 'create') {
      const session = await createOrtSession(msg.buffer);
      sessions.set(msg.id, session);
      ctx.postMessage({ type: 'created', id: msg.id });
    } else if (msg.type === 'dispose') {
      const s = sessions.get(msg.id);
      if (s) {
        try {
          await s.release?.();
        } catch {
          /* noop */
        }
        sessions.delete(msg.id);
      }
      ctx.postMessage({ type: 'disposed', id: msg.id });
    } else if (msg.type === 'run') {
      const session = sessions.get(msg.id);
      if (!session) {
        ctx.postMessage({ type: 'error', id: msg.id, message: 'session-not-ready' });
        return;
      }
      const res = await runModel(session, msg);
      ctx.postMessage(
        { type: 'result', id: msg.id, out: res.out.buffer, outWidth: res.outWidth, outHeight: res.outHeight },
        [res.out.buffer],
      );
    }
  } catch (e) {
    const err = e as { message?: string };
    ctx.postMessage({ type: 'error', id: (msg as { id: string }).id, message: String(err?.message ?? e) });
  }
};
