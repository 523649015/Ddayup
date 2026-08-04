import type { AssetItem } from '@/types/assets';
import type { AssetImportResult } from '@/api/assetLibrary';

export interface ExtractedFrame {
  dataUrl: string;
  t: number;
}

/**
 * 从视频抽取若干帧（DOM 环境：video + canvas）。
 * 纯浏览器能力：在 Node 测试环境中返回空数组（由调用方注入 frames 以测试推理编排）。
 */
export async function extractVideoFrames(
  file: Blob,
  options: { maxFrames?: number } = {},
): Promise<ExtractedFrame[]> {
  const maxFrames = options.maxFrames ?? 4;
  if (typeof document === 'undefined' || typeof window === 'undefined') return [];
  return new Promise<ExtractedFrame[]>((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    const objectUrl = URL.createObjectURL(file);
    video.src = objectUrl;
    const cleanup = () => URL.revokeObjectURL(objectUrl);
    video.onerror = () => {
      cleanup();
      resolve([]);
    };
    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      const count = duration > 0 ? Math.min(maxFrames, Math.max(1, Math.floor(duration))) : 1;
      const times = Array.from({ length: count }, (_, i) => (duration * (i + 1)) / (count + 1));
      const frames: ExtractedFrame[] = [];
      let idx = 0;
      const captureNext = () => {
        if (idx >= times.length) {
          cleanup();
          resolve(frames);
          return;
        }
        video.currentTime = times[idx++];
      };
      video.onseeked = () => {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth || 320;
        canvas.height = video.videoHeight || 180;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          captureNext();
          return;
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        try {
          frames.push({ dataUrl: canvas.toDataURL('image/jpeg', 0.7), t: video.currentTime });
        } catch {
          /* 忽略解码失败的单帧 */
        }
        captureNext();
      };
      captureNext();
    };
  });
}

export interface ReasonAboutVideoParams {
  asset: AssetItem | AssetImportResult;
  /** 已抽取的帧（测试可注入，避免依赖 DOM） */
  frames?: ExtractedFrame[];
  engine?: string;
  provider?: string;
  model?: string;
}

export interface VideoReasoningResult {
  reasoning: string;
  framesAnalyzed: number;
  frameTimestamps: number[];
}

async function fetchAssetBlob(asset: AssetItem): Promise<Blob> {
  const url = asset.url || asset.thumbnail || asset.filePath;
  if (!url) throw new Error('asset-blob-url-missing');
  return (await fetch(url)).blob();
}

/**
 * 推理视频：抽取关键帧 → 取中间帧交给视觉模型分析 → 结合帧时间点整理成可读推理文本。
 * 复用现有本地图像分析端点 /api/local-image/analyze（与图片分析同一视觉后端）。
 */
export async function reasonAboutVideo(params: ReasonAboutVideoParams): Promise<VideoReasoningResult> {
  // 防御：兼容传入 importLocalAssetFile 返回的 { item, duplicate } 包装对象
  const asset = ('item' in params.asset ? params.asset.item : params.asset) as AssetItem;
  const frames =
    params.frames && params.frames.length
      ? params.frames
      : await extractVideoFrames(await fetchAssetBlob(asset));
  if (!frames.length) throw new Error('no-video-frames');

  const mid = frames[Math.floor(frames.length / 2)];
  const blob = await (await fetch(mid.dataUrl)).blob();
  const form = new FormData();
  form.append('file', blob, 'frame.jpg');
  form.append('itemId', asset.id);
  form.append('name', asset.name || 'frame');
  if (params.engine) form.append('engine', params.engine);
  if (params.provider) form.append('provider', params.provider);
  if (params.model) form.append('model', params.model);

  const response = await fetch('/api/local-image/analyze', { method: 'POST', body: form });
  const data = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    error?: { message?: string } | string;
    analysis?: { summary?: string; subject?: string; style?: string; scene?: string; mood?: string };
  };
  if (!response.ok || !data.success || !data.analysis) {
    const msg = typeof data.error === 'string' ? data.error : data.error?.message || 'video-reason-failed';
    throw new Error(msg);
  }

  const a = data.analysis;
  const parts = [
    a.summary,
    a.subject && `主体：${a.subject}`,
    a.style && `风格：${a.style}`,
    a.scene && `场景：${a.scene}`,
    a.mood && `情绪：${a.mood}`,
  ].filter(Boolean);
  const description = parts.join('；') || '（无可用描述）';
  const timestamps = frames.map((f) => Number(f.t.toFixed(2)));
  const motionNote = `（已抽取 ${frames.length} 帧，关键帧时间：${timestamps.join('s / ')}s）`;
  return {
    reasoning: `${description}\n${motionNote}`,
    framesAnalyzed: frames.length,
    frameTimestamps: timestamps,
  };
}
