/**
 * HMDao Compute Worker — 在独立线程中执行重计算
 *
 * Phase 6 P2: 此文件由 Vite 作为 Web Worker 打包。
 * 支持的离线任务：图像缩放、哈希计算、JSON 序列化。
 */

// ===== 消息类型（与 computeWorker.ts 保持一致） =====

interface ComputeRequest {
  id: string;
  type: string;
  payload: unknown;
}

interface ComputeResponse {
  id: string;
  type: string;
  result?: unknown;
  error?: string;
}

// ===== 任务处理器注册 =====

const handlers: Record<string, (payload: unknown) => Promise<unknown> | unknown> = {
  'canvas.serialize': (payload) => {
    try {
      return JSON.stringify(payload);
    } catch (e) {
      throw new Error(`序列化失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  'canvas.deserialize': (payload) => {
    try {
      return JSON.parse(payload as string);
    } catch (e) {
      throw new Error(`反序列化失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  'hash.compute': async (payload) => {
    const { data, algorithm = 'SHA-256' } = payload as { data: string; algorithm?: string };
    const encoder = new TextEncoder();
    const encoded = encoder.encode(data);
    const hashBuffer = await crypto.subtle.digest(algorithm, encoded);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  },

  'image.resize': async (payload) => {
    const { imageData, targetWidth, targetHeight } = payload as {
      imageData: ImageData;
      targetWidth: number;
      targetHeight: number;
    };
    // 使用 OffscreenCanvas 进行图像缩放
    const canvas = new OffscreenCanvas(targetWidth, targetHeight);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 OffscreenCanvas 2D 上下文');

    // 通过 ImageBitmap 渲染
    const bitmap = await createImageBitmap(imageData);
    ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    bitmap.close();

    return ctx.getImageData(0, 0, targetWidth, targetHeight);
  },
};

// ===== 消息监听 =====

self.onmessage = async (e: MessageEvent<ComputeRequest>) => {
  const { id, type, payload } = e.data;
  const handler = handlers[type];

  if (!handler) {
    const response: ComputeResponse = { id, type, error: `未知任务类型: ${type}` };
    self.postMessage(response);
    return;
  }

  try {
    const result = await handler(payload);
    const response: ComputeResponse = { id, type, result };
    self.postMessage(response);
  } catch (err) {
    const response: ComputeResponse = {
      id,
      type,
      error: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(response);
  }
};
