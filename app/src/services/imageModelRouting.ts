import { commitResultToAsset } from '@/services/assetWriteback';
import { getLocalModelRunner } from '@/services/localModelRunner';
import { registerLocalInpaintHandler } from '@/services/imageBrush';

export type LocalModelErrorCode = 'no-model' | 'run-failed';

export class LocalModelError extends Error {
  code: LocalModelErrorCode;
  constructor(code: LocalModelErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'LocalModelError';
  }
}

/**
 * 本地高清放大（Real-ESRGAN x4）：模型安装后走浏览器端推理，结果入库「高清」(img-hd)。
 * 未安装时给出明确引导，绝不静默失败。
 */
export async function runLocalHdUpscale(
  imageUrl: string,
  folderId = 'img-hd',
): Promise<{ url: string; assetId: string }> {
  const runner = getLocalModelRunner('real-esrgan-x4');
  if (!runner) {
    throw new LocalModelError('no-model', '请先在「模型下载」安装 Real-ESRGAN x4 本地模型');
  }
  let out;
  try {
    out = await runner({ imageUrl });
  } catch (err) {
    throw new LocalModelError('run-failed', `本地高清放大失败：${err instanceof Error ? err.message : String(err)}`);
  }
  const committed = commitResultToAsset({
    blob: out.blob,
    name: `高清-${Date.now()}.png`,
    type: 'image',
    folderId,
    width: out.width,
    height: out.height,
    source: 'generate',
  });
  return { url: committed.url, assetId: committed.assetId };
}

/**
 * 智能去背（@imgly/background-removal）：模型安装后走浏览器端推理，结果入库「去背」(img-bg)。
 */
export async function removeImageBackground(
  imageUrl: string,
  folderId = 'img-bg',
): Promise<{ url: string; assetId: string }> {
  const runner = getLocalModelRunner('imgly-bgremoval');
  if (!runner) {
    throw new LocalModelError('no-model', '请先在「模型下载」安装 @imgly/background-removal 本地模型');
  }
  let out;
  try {
    out = await runner({ imageUrl });
  } catch (err) {
    throw new LocalModelError('run-failed', `智能去背失败：${err instanceof Error ? err.message : String(err)}`);
  }
  const committed = commitResultToAsset({
    blob: out.blob,
    name: `去背-${Date.now()}.png`,
    type: 'image',
    folderId,
    width: out.width,
    height: out.height,
    source: 'generate',
  });
  return { url: committed.url, assetId: committed.assetId };
}

/**
 * 把已安装的 LaMa 运行器接入「局部编辑（笔刷）」修复链。
 * 仅在 LaMa 模型安装后调用；brush 在本地处理器存在时优先走 LaMa，否则提示安装。
 */
export function wireLamaToInpaint(): void {
  registerLocalInpaintHandler(async (input) => {
    const runner = getLocalModelRunner('lama-inpaint');
    if (!runner) throw new Error('lama-inpaint 运行器未注册');
    const out = await runner({
      imageUrl: input.imageUrl,
      options: { mask: input.mask, prompt: input.prompt },
    });
    return { blob: out.blob, width: out.width ?? 0, height: out.height ?? 0, engine: out.engine };
  });
}
