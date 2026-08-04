/**
 * 端到端测试桩（仅 DEV / 测试构建注入，生产构建会被 tree-shake 剔除，无残留）。
 *
 * 目的：让 Playwright（真实 Chrome/Edge + WebGPU）能直接调用应用内部管线，
 * 验证「一键电影感·视频」的 RAFT + WebGPU + WebCodecs 真实出片，而无需脆弱的 UI 选择器。
 *
 * 该模块不引入任何全局副作用；仅在 `import.meta.env.DEV` 为真时由 main.tsx 动态加载，
 * 生产 `npm run build` 中 `if (import.meta.env.DEV)` 被判定为 false，整段被摇树移除。
 */

import { applyGpuMotionBlurVideoLocally } from '@/services/postFX/gpuMotionBlur';
import { applyCinematicOneClick, applyMattingOneClick } from '@/services/postFX/pipeline';
import { useAssetStore } from '@/store/useAssetStore';
import type { AssetItem } from '@/types/assets';

/** 生成一段合成测试视频（canvas 逐帧 + MediaRecorder），返回 object URL，供 GPU 运动模糊管线消费。 */
export async function makeTestVideoUrl(durationFrames = 12, size = 128): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const stream = canvas.captureStream(12);
  const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
  const chunks: BlobPart[] = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  const stopped = new Promise<void>((resolve) => {
    rec.onstop = () => resolve();
  });
  rec.start();
  for (let i = 0; i < durationFrames; i++) {
    ctx.fillStyle = `hsl(${(i * 30) % 360}, 70%, 50%)`;
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000';
    ctx.fillRect((i * 8) % size, 40, 24, 24);
    await new Promise((r) => requestAnimationFrame(r));
  }
  rec.stop();
  await stopped;
  const blob = new Blob(chunks, { type: 'video/webm' });
  return URL.createObjectURL(blob);
}

/** 向资产库写入一张测试图片素材（返回其 url），用于验证「素材可从资产库引用」。 */
export function addTestImageAsset(name = 'e2e-test-image', size = 64): string {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#336699';
  ctx.fillRect(0, 0, size, size);
  const url = canvas.toDataURL('image/png');
  const asset: Omit<AssetItem, 'id' | 'createdAt' | 'updatedAt'> = {
    name,
    type: 'image',
    url,
    thumbnail: url,
    folderId: 'web',
    size: size * size * 4,
    tags: [],
    smartCategories: [],
    source: 'generate',
  };
  useAssetStore.getState().addItem(asset);
  return url;
}

interface HmdaoTestApi {
  makeTestVideoUrl: typeof makeTestVideoUrl;
  addTestImageAsset: typeof addTestImageAsset;
  applyGpuMotionBlurVideoLocally: typeof applyGpuMotionBlurVideoLocally;
  applyCinematicOneClick: typeof applyCinematicOneClick;
  applyMattingOneClick: typeof applyMattingOneClick;
}

export function installTestHarness(): void {
  (window as unknown as { HMDAO_TEST?: HmdaoTestApi }).HMDAO_TEST = {
    makeTestVideoUrl,
    addTestImageAsset,
    applyGpuMotionBlurVideoLocally,
    applyCinematicOneClick,
    applyMattingOneClick,
  };
}
