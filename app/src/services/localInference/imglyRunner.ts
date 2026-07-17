/**
 * @imgly/background-removal 真实去背（浏览器端 WASM）
 *
 * 模型权重由 @imgly 包在首次推理时自动下载（生产环境经 CDN，无 COEP 限制），
 * 这里只是把其能力包装成本地运行器注册到注册表。无需像 onnx 模型那样
 * 预先下载权重文件。
 */

import type { LocalModelRunner, LocalModelRunInput, LocalModelRunOutput } from '@/services/localModelRunner';
import { loadSourceBitmap } from './imageSource';

export function createImglyRunner(): LocalModelRunner {
  return async (input: LocalModelRunInput): Promise<LocalModelRunOutput> => {
    const bitmap = await loadSourceBitmap(input.imageUrl);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建画布上下文');
    ctx.drawImage(bitmap, 0, 0);
    const sourceBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas.toBlob 失败'))), 'image/png');
    });
    bitmap.close?.();

    const { removeBackground } = await import('@imgly/background-removal');
    const outBlob = await removeBackground(sourceBlob, {
      model: 'isnet_fp16',
      output: { format: 'image/png' },
    });
    return { blob: outBlob, width: canvas.width, height: canvas.height, engine: 'imgly' };
  };
}
