/**
 * 本地推理的图片源加载与画布工具
 *
 * 图片地址可能是：
 *  - hmdao-local://<id> 句柄（需经本地媒体注册表解析）
 *  - http(s):/blob:/data: 等可直接 fetch 的地址
 * 统一转成 ImageBitmap / ImageData / Blob，供 ONNX 预处理使用。
 */

import {
  isLocalMediaHandle,
  readLocalMediaBlob,
  ensureLocalMediaUrl,
} from '@/services/localMediaRegistry';

/** 把一个源图片地址加载为 ImageBitmap */
export async function loadSourceBitmap(imageUrl: string): Promise<ImageBitmap> {
  let blob: Blob | null = null;

  if (isLocalMediaHandle(imageUrl)) {
    blob = readLocalMediaBlob(imageUrl);
    if (!blob) {
      const objectUrl = await ensureLocalMediaUrl(imageUrl);
      if (objectUrl) {
        const res = await fetch(objectUrl);
        if (res.ok) blob = await res.blob();
      }
    }
  } else {
    const res = await fetch(imageUrl);
    if (!res.ok) throw new Error(`源图片加载失败：HTTP ${res.status}`);
    blob = await res.blob();
  }

  if (!blob) throw new Error('无法获取源图片数据');
  return createImageBitmap(blob, { imageOrientation: 'none' });
}

/** 把 dataURL（如笔刷蒙版）加载为 ImageBitmap */
export async function loadMaskBitmap(maskDataUrl: string): Promise<ImageBitmap> {
  if (!maskDataUrl.startsWith('data:')) {
    throw new Error('蒙版格式无效，应为 dataURL');
  }
  const res = await fetch(maskDataUrl);
  if (!res.ok) throw new Error(`蒙版加载失败：HTTP ${res.status}`);
  const blob = await res.blob();
  return createImageBitmap(blob, { imageOrientation: 'none' });
}

/** ImageBitmap → ImageData（可指定目标尺寸做 resize） */
export function bitmapToImageData(bitmap: ImageBitmap, width?: number, height?: number): ImageData {
  const w = width ?? bitmap.width;
  const h = height ?? bitmap.height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');
  ctx.drawImage(bitmap, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

/** ImageData → Blob（PNG） */
export async function imageDataToBlob(data: ImageData, type = 'image/png'): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = data.width;
  canvas.height = data.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');
  ctx.putImageData(data, 0, 0);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob 失败'))),
      type,
    );
  });
}

export function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
