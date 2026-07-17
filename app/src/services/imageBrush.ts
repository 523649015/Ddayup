import { commitResultToAsset } from '@/services/assetWriteback';

export interface BrushEditInput {
  /** 待修复的源图片（渲染可用地址，可为 hmdao-local:// 或 https://） */
  imageUrl: string;
  /** 笔刷蒙版 dataURL，白色区域为需要修复/重绘的部分 */
  mask: string;
  /** 可选的文字提示（局部重绘时用） */
  prompt?: string;
  /** 结果归档到的素材文件夹 id，默认「局部编辑」 */
  folderId?: string;
}

export interface BrushEditOutput {
  blob: Blob;
  width: number;
  height: number;
  engine: string;
}

export interface BrushEditResult {
  /** 结果地址（hmdao-local:// 句柄或远端 url） */
  url: string;
  assetId: string;
  width: number;
  height: number;
}

/** 本地修复处理器（Phase 7 接入 LaMa / lama-cleaner 时注册） */
export type LocalInpaintHandler = (input: BrushEditInput) => Promise<BrushEditOutput>;

let localInpaintHandler: LocalInpaintHandler | null = null;

export function registerLocalInpaintHandler(handler: LocalInpaintHandler | null): void {
  localInpaintHandler = handler;
}

export function getLocalInpaintHandler(): LocalInpaintHandler | null {
  return localInpaintHandler;
}

export type BrushEditErrorCode = 'no-backend' | 'processing-failed' | 'invalid-input';

export class BrushEditError extends Error {
  code: BrushEditErrorCode;
  constructor(code: BrushEditErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'BrushEditError';
  }
}

function isRenderableImage(url: string): boolean {
  if (!url) return false;
  if (
    url.startsWith('http') ||
    url.startsWith('hmdao-local://') ||
    url.startsWith('blob:') ||
    url.startsWith('data:') ||
    url.startsWith('/api/media-proxy')
  ) {
    return true;
  }
  return false;
}

/**
 * 局部编辑（笔刷）处理路由：
 *   1️⃣ 本地修复模型优先（LaMa 等，Phase 7 注册）
 *   2️⃣ 否则云端 API（后续阶段接入）
 *   3️⃣ 都没有 → 友好提示，绝不静默失败或崩溃
 */
export async function applyBrushEdit(input: BrushEditInput): Promise<BrushEditResult> {
  if (!isRenderableImage(input.imageUrl)) {
    throw new BrushEditError('invalid-input', '局部编辑缺少有效的源图片。');
  }
  if (!input.mask) {
    throw new BrushEditError('invalid-input', '局部编辑需要先涂抹出要修改的区域。');
  }

  if (localInpaintHandler) {
    let output: BrushEditOutput;
    try {
      output = await localInpaintHandler(input);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new BrushEditError('processing-failed', `本地修复处理失败：${reason}`);
    }
    const committed = commitResultToAsset({
      blob: output.blob,
      name: `局部编辑-${Date.now()}.png`,
      type: 'image',
      folderId: input.folderId || 'img-brush',
      width: output.width,
      height: output.height,
      source: 'generate',
    });
    return {
      url: committed.url,
      assetId: committed.assetId,
      width: output.width,
      height: output.height,
    };
  }

  // 本地无模型：Phase 7 之后此处接入云端 API；当前给出明确引导。
  throw new BrushEditError(
    'no-backend',
    '局部编辑需要先安装本地修复模型（如 LaMa），或在「模型下载」中配置支持图生图的 API Key。',
  );
}
