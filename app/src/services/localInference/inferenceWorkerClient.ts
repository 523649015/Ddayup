/**
 * 本地推理 Worker 客户端（主线程侧）
 *
 * 单例持有一个 Web Worker，承载所有 onnxruntime-web 计算。
 * 主线程仅负责图片解码（loadSourceBitmap/drawImage）与结果编码（canvas → blob），
 * 推理（含 144+ 瓦片）全部在 Worker 内完成，页面保持流畅、不会「未响应」。
 */

import type { LocalModelRunInput, LocalModelRunOutput } from '@/services/localModelRunner';
import {
  loadSourceBitmap,
  loadMaskBitmap,
  bitmapToImageData,
  imageDataToBlob,
} from './imageSource';

let worker: Worker | null = null;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./inferenceWorker.ts', import.meta.url), {
      type: 'module',
    });
  }
  return worker;
}

/** 在 Worker 内创建 ORT 会话（转移 buffer 所有权，主线程不再持有） */
export function createSessionInWorker(id: string, buffer: ArrayBuffer): Promise<void> {
  const w = getWorker();
  return new Promise<void>((resolve, reject) => {
    const onMsg = (e: MessageEvent): void => {
      const m = e.data;
      if (!m || m.id !== id) return;
      if (m.type === 'created') {
        cleanup();
        resolve();
      } else if (m.type === 'error') {
        cleanup();
        reject(new Error(m.message));
      }
    };
    const onErr = (err: ErrorEvent): void => {
      cleanup();
      reject(err);
    };
    const cleanup = (): void => {
      w.removeEventListener('message', onMsg);
      w.removeEventListener('error', onErr);
    };
    w.addEventListener('message', onMsg);
    w.addEventListener('error', onErr);
    w.postMessage({ type: 'create', id, buffer }, [buffer]);
  });
}

/** 释放 Worker 内会话，释放显存/内存 */
export function disposeSessionInWorker(id: string): void {
  try {
    getWorker().postMessage({ type: 'dispose', id });
  } catch {
    /* noop */
  }
}

interface RunResult {
  out: ArrayBuffer;
  outWidth: number;
  outHeight: number;
}

function runInWorker(opts: {
  id: string;
  kind: 'esrgan' | 'lama';
  rgba: ArrayBuffer;
  width: number;
  height: number;
  mask?: ArrayBuffer;
}): Promise<RunResult> {
  const w = getWorker();
  return new Promise<RunResult>((resolve, reject) => {
    const onMsg = (e: MessageEvent): void => {
      const m = e.data;
      if (!m || m.id !== opts.id) return;
      if (m.type === 'result') {
        cleanup();
        resolve({ out: m.out, outWidth: m.outWidth, outHeight: m.outHeight });
      } else if (m.type === 'error') {
        cleanup();
        reject(new Error(m.message));
      }
    };
    const onErr = (err: ErrorEvent): void => {
      cleanup();
      reject(err);
    };
    const cleanup = (): void => {
      w.removeEventListener('message', onMsg);
      w.removeEventListener('error', onErr);
    };
    w.addEventListener('message', onMsg);
    w.addEventListener('error', onErr);
    const transfer: ArrayBuffer[] = opts.mask ? [opts.rgba, opts.mask] : [opts.rgba];
    w.postMessage(
      {
        type: 'run',
        id: opts.id,
        kind: opts.kind,
        rgba: opts.rgba,
        width: opts.width,
        height: opts.height,
        mask: opts.mask,
      },
      transfer,
    );
  });
}

/** Real-ESRGAN x4 运行器：主线程解码 → Worker 推理 → 主线程编码 */
export function createEsrganRunner(modelId: string): (input: LocalModelRunInput) => Promise<LocalModelRunOutput> {
  const MAX_INPUT_EDGE = 768;
  return async (input: LocalModelRunInput): Promise<LocalModelRunOutput> => {
    const bitmap = await loadSourceBitmap(input.imageUrl);
    const scale = Math.min(1, MAX_INPUT_EDGE / Math.max(bitmap.width, bitmap.height));
    const iw = Math.max(1, Math.round(bitmap.width * scale));
    const ih = Math.max(1, Math.round(bitmap.height * scale));
    const imageData = bitmapToImageData(bitmap, iw, ih);
    bitmap.close?.();

    const res = await runInWorker({
      id: modelId,
      kind: 'esrgan',
      rgba: imageData.data.buffer,
      width: iw,
      height: ih,
    });
    const outImage = new ImageData(new Uint8ClampedArray(res.out), res.outWidth, res.outHeight);
    const blob = await imageDataToBlob(outImage);
    return { blob, width: res.outWidth, height: res.outHeight, engine: 'real-esrgan-x4' };
  };
}

/** LaMa 局部修复运行器：主线程解码源图+蒙版 → Worker 推理 → 主线程编码 */
export function createLamaRunner(modelId: string): (input: LocalModelRunInput) => Promise<LocalModelRunOutput> {
  return async (input: LocalModelRunInput): Promise<LocalModelRunOutput> => {
    const maskDataUrl = typeof input.options?.mask === 'string' ? input.options.mask : '';
    if (!maskDataUrl) {
      throw new Error('LaMa 修复需要先涂抹出要修改的区域（蒙版）');
    }
    const bitmap = await loadSourceBitmap(input.imageUrl);
    const maskBitmap = await loadMaskBitmap(maskDataUrl);
    const iw = bitmap.width;
    const ih = bitmap.height;
    const srcImage = bitmapToImageData(bitmap, iw, ih);
    bitmap.close?.();
    const maskImage = bitmapToImageData(maskBitmap, iw, ih);
    maskBitmap.close?.();

    const res = await runInWorker({
      id: modelId,
      kind: 'lama',
      rgba: srcImage.data.buffer,
      width: iw,
      height: ih,
      mask: maskImage.data.buffer,
    });
    const outImage = new ImageData(new Uint8ClampedArray(res.out), res.outWidth, res.outHeight);
    const blob = await imageDataToBlob(outImage);
    return { blob, width: res.outWidth, height: res.outHeight, engine: 'lama' };
  };
}
