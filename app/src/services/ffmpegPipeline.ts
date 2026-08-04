import { isLocalMediaHandle, readLocalMediaBlob } from '@/services/localMediaRegistry';

export interface FFmpegProgress {
  percent: number;
  stage: string;
  elapsedMs: number;
  estimatedRemainingMs: number;
}

export interface AudioExtractResult {
  blob?: Blob;
  url: string;
  assetId?: string;
  mimeType?: string;
  format: string;
  duration: number;
  size: number;
  sampleRate?: number;
  channels?: number;
}

export interface VideoTranscodeResult {
  blob?: Blob;
  url: string;
  assetId?: string;
  mimeType?: string;
  format: string;
  width: number;
  height: number;
  duration: number;
  size: number;
  processingEngine?: string;
}

export interface VideoAnalysisShot {
  id: string;
  time: number;
  label: string;
  shotSize?: string;
  cameraPrompt?: string;
  imagePrompt?: string;
  keyframePrompt?: string;
}

export interface VideoAnalysisParseRow {
  id?: string;
  shotNumber: number;
  startTime: number;
  endTime: number;
  duration: number;
  subjectCount?: number;
  subjectSummary?: string;
  subjectTraits?: string;
  actionSummary?: string;
  sceneSetting?: string;
  storyboardPurpose?: string;
  lensSuggestion?: string;
  frameDescription: string;
  narrativeBeat: string;
  sceneType: string;
  cameraAngle: string;
  cameraMovement: string;
  focusDepth: string;
  lighting: string;
  soundDesign: string;
  cameraPrompt?: string;
  imagePrompt?: string;
  keyframePrompt?: string;
  keyframeTime?: number;
  visualKeywords?: string[];
  styleDescription?: string;
  lightingMood?: string;
  atmosphere?: string;
  subjectMotion?: string;
  cameraMotionDetail?: string;
  compositionDetail?: string;
  colorPalette?: string[];
  keyframeImageBase64?: string;
  keyframeMimeType?: string;
  keyframeWidth?: number;
  keyframeHeight?: number;
  metrics?: Record<string, number>;
}

export interface VideoAnalysisResult {
  width: number;
  height: number;
  duration: number;
  sceneCount: number;
  sceneCuts: number[];
  sampleFps: number;
  summary: string;
  suggestedShots: VideoAnalysisShot[];
  parseRows?: VideoAnalysisParseRow[];
  analysisEngine?: string;
}

export interface VideoAudioSplitResult {
  video: VideoTranscodeResult;
  audio: AudioExtractResult;
  vocal: AudioExtractResult;
  accompaniment: AudioExtractResult;
  processingEngine?: string;
}

export interface PipelineResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface VideoCropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VideoClipSegment {
  startTime: number;
  endTime: number;
}

export interface LocalVideoAudioMixConfig {
  linkedAudioSourceUrl?: string;
  linkedAudioAssetId?: string;
  linkedAudioLabel?: string;
  linkedAudioMode?: string;
  linkedAudioBackend?: string;
  audioMixMode?: 'replace' | 'bgm-under' | 'voiceover-dub';
  audioGain?: number;
  videoGain?: number;
}

type LocalVideoEditOperation = 'crop' | 'clip' | 'hd' | 'parse' | 'removeSubtitle' | 'audioSplit' | 'audioMix' | 'motionblur';
const LOCAL_VIDEO_EDIT_TIMEOUT_MS: Record<LocalVideoEditOperation, number> = {
  crop: 120_000,
  clip: 120_000,
  hd: 240_000,
  parse: 240_000,
  removeSubtitle: 240_000,
  audioSplit: 240_000,
  audioMix: 180_000,
  motionblur: 240_000,
};
const LOCAL_MEDIA_FETCH_TIMEOUT_MS = 45_000;

function pickRecorderMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  const probe = typeof document !== 'undefined' ? document.createElement('video') : null;
  const candidates = [
    'video/webm;codecs=vp8',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp9,opus',
    'video/webm',
  ];
  const playableCandidates = candidates.filter((item) => {
    if (!MediaRecorder.isTypeSupported(item)) return false;
    if (!probe) return true;
    return probe.canPlayType(item) !== '';
  });
  return playableCandidates[0] || candidates.find((item) => MediaRecorder.isTypeSupported(item)) || '';
}

export function getLocalVideoRecorderDiagnostics() {
  if (typeof MediaRecorder === 'undefined') {
    return {
      supported: false,
      chosenMimeType: '',
      candidates: [],
    };
  }
  const probe = typeof document !== 'undefined' ? document.createElement('video') : null;
  const candidates = [
    'video/webm;codecs=vp8',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp9,opus',
    'video/webm',
  ].map((mimeType) => ({
    mimeType,
    recordable: MediaRecorder.isTypeSupported(mimeType),
    playable: probe ? probe.canPlayType(mimeType) !== '' : true,
  }));
  return {
    supported: candidates.some((item) => item.recordable && item.playable),
    chosenMimeType: pickRecorderMimeType(),
    candidates,
  };
}

export function checkFFmpegSupport(): { supported: boolean; issues: string[] } {
  const supported = typeof fetch === 'function';
  return {
    supported,
    issues: supported ? [] : ['当前环境无法访问本地视频处理服务。'],
  };
}

function extensionFromMimeType(mimeType: string) {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.includes('webm')) return 'webm';
  if (normalized.includes('quicktime')) return 'mov';
  if (normalized.includes('x-matroska') || normalized.includes('mkv')) return 'mkv';
  if (normalized.includes('avi')) return 'avi';
  return 'mp4';
}

function audioExtensionFromMimeType(mimeType: string) {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.includes('wav')) return 'wav';
  if (normalized.includes('ogg')) return 'ogg';
  if (normalized.includes('flac')) return 'flac';
  return 'mp3';
}

async function fetchVideoSourceFile(videoUrl: string) {
  if (isLocalMediaHandle(videoUrl)) {
    const localBlob = readLocalMediaBlob(videoUrl);
    if (!localBlob) {
      throw new Error(`video-fetch-failed:${videoUrl}:missing-local-blob`);
    }
    const bytes = new Uint8Array(await localBlob.arrayBuffer());
    const mimeType = localBlob.type || 'video/mp4';
    return {
      bytes,
      mimeType,
      extension: extensionFromMimeType(mimeType),
    };
  }

  const response = await fetchBlobWithTimeout(videoUrl);
  if (!response.ok) {
    throw new Error(`video-fetch-failed:${videoUrl}:${response.status}`);
  }
  const blob = await response.blob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const mimeType = blob.type || response.headers.get('content-type') || 'video/mp4';
  return {
    bytes,
    mimeType,
    extension: extensionFromMimeType(mimeType),
  };
}

async function fetchAudioSourceFile(audioUrl: string) {
  if (isLocalMediaHandle(audioUrl)) {
    const localBlob = readLocalMediaBlob(audioUrl);
    if (!localBlob) {
      throw new Error(`audio-fetch-failed:${audioUrl}:missing-local-blob`);
    }
    const bytes = new Uint8Array(await localBlob.arrayBuffer());
    const mimeType = localBlob.type || 'audio/wav';
    return {
      bytes,
      mimeType,
      extension: audioExtensionFromMimeType(mimeType),
    };
  }

  const response = await fetchBlobWithTimeout(audioUrl);
  if (!response.ok) {
    throw new Error(`audio-fetch-failed:${audioUrl}:${response.status}`);
  }
  const blob = await response.blob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const mimeType = blob.type || response.headers.get('content-type') || 'audio/wav';
  return {
    bytes,
    mimeType,
    extension: audioExtensionFromMimeType(mimeType),
  };
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, Math.min(bytes.length, index + chunkSize));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function fetchBlobWithTimeout(resourceUrl: string, timeoutMs = LOCAL_MEDIA_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => {
    controller.abort(new DOMException(`local-media-fetch-timeout:${timeoutMs}:${resourceUrl}`, 'AbortError'));
  }, timeoutMs);
  try {
    return await fetch(resourceUrl, { signal: controller.signal });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function requestServerLocalVideoEdit(
  operation: LocalVideoEditOperation,
  videoUrl: string,
  payload: Record<string, unknown>,
  onProgress?: (progress: FFmpegProgress) => void,
): Promise<PipelineResult<Record<string, unknown>>> {
  const startedAt = Date.now();
  const linkedAudioSourceUrl = typeof payload.linkedAudioSourceUrl === 'string' ? payload.linkedAudioSourceUrl.trim() : '';
  const remoteSourceUrl = /^https?:\/\//i.test(String(videoUrl || '').trim()) ? String(videoUrl).trim() : '';
  const remoteLinkedAudioUrl = /^https?:\/\//i.test(linkedAudioSourceUrl) ? linkedAudioSourceUrl : '';
  const sourceFile = remoteSourceUrl ? null : await fetchVideoSourceFile(videoUrl);
  const linkedAudioFile = !linkedAudioSourceUrl || remoteLinkedAudioUrl ? null : await fetchAudioSourceFile(linkedAudioSourceUrl);
  console.debug('[ffmpegPipeline] local-video source prepared', {
    operation,
    sourceUrl: videoUrl,
    remoteSourceUrl,
    sourceBytes: sourceFile?.bytes?.byteLength || 0,
    linkedAudioSourceUrl,
    linkedAudioBytes: linkedAudioFile?.bytes?.byteLength || 0,
    elapsedMs: Date.now() - startedAt,
  });
  onProgress?.({
    percent: remoteSourceUrl ? 10 : 12,
    stage: remoteSourceUrl ? '正在同步远程视频到本地处理服务' : '正在上传本地视频到处理服务',
    elapsedMs: 0,
    estimatedRemainingMs: 0,
  });

  const controller = new AbortController();
  const timeoutMs = LOCAL_VIDEO_EDIT_TIMEOUT_MS[operation] || 180_000;
  const timeoutId = window.setTimeout(() => controller.abort(new DOMException(`local-video-edit-timeout:${operation}:${timeoutMs}`, 'AbortError')), timeoutMs);
  let response: Response;
  try {
    console.debug('[ffmpegPipeline] local-video request dispatch', {
      operation,
      timeoutMs,
      elapsedMs: Date.now() - startedAt,
    });
    response = await fetch('/api/local-video/edit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    signal: controller.signal,
    body: JSON.stringify({
      operation,
      ...(sourceFile
        ? {
          inputMimeType: sourceFile.mimeType,
          inputBase64: bytesToBase64(sourceFile.bytes),
        }
        : {
          sourceUrl: remoteSourceUrl,
        }),
      ...(linkedAudioFile
        ? {
          linkedAudioMimeType: linkedAudioFile.mimeType,
          linkedAudioBase64: bytesToBase64(linkedAudioFile.bytes),
        }
        : remoteLinkedAudioUrl
          ? {
            linkedAudioSourceUrl: remoteLinkedAudioUrl,
          }
          : {}),
      ...payload,
    }),
  });
  } catch (error) {
    window.clearTimeout(timeoutId);
    const message = error instanceof Error ? error.message : String(error);
    const isAbort = error instanceof DOMException && error.name === 'AbortError';
    return {
      success: false,
      error: isAbort ? `local-video-edit-timeout:${operation}:${timeoutMs}` : message,
    };
  }

  const result = await response.json().catch(() => null) as {
    success?: boolean;
    error?: { message?: string };
    [key: string]: unknown;
  } | null;
  window.clearTimeout(timeoutId);

  if (!response.ok || !result?.success) {
    console.debug('[ffmpegPipeline] local-video request failed', {
      operation,
      status: response.status,
      error: result?.error?.message || '',
      elapsedMs: Date.now() - startedAt,
    });
    return {
      success: false,
      error: result?.error?.message || `local-video-edit-request-failed:${response.status}`,
    };
  }

  onProgress?.({
    percent: 100,
    stage: '本地视频处理完成',
    elapsedMs: 0,
    estimatedRemainingMs: 0,
  });

  console.debug('[ffmpegPipeline] local-video request completed', {
    operation,
    elapsedMs: Date.now() - startedAt,
    outputUrl: String(result.outputUrl || ''),
    width: Number(result.width || 0),
    height: Number(result.height || 0),
    duration: Number(result.duration || 0),
  });

  return {
    success: true,
    data: result,
  };
}

function toVideoResult(result: Record<string, unknown>): VideoTranscodeResult {
  const mimeType = String(result.mimeType || 'video/webm');
  const outputUrl = String(result.outputUrl || '').trim();
  const outputAssetId = String(result.outputAssetId || '').trim();
  const outputBase64 = String(result.outputBase64 || '');
  const blob = outputBase64 ? new Blob([base64ToBytes(outputBase64)], { type: mimeType }) : undefined;
  return {
    blob,
    url: outputUrl || (blob ? URL.createObjectURL(blob) : ''),
    assetId: outputAssetId || undefined,
    mimeType,
    format: String(result.format || 'webm'),
    width: Math.max(2, Number(result.width || 0)),
    height: Math.max(2, Number(result.height || 0)),
    duration: Math.max(0, Number(result.duration || 0)),
    size: Number(result.size || blob?.size || 0),
    processingEngine: String(result.processingEngine || ''),
  };
}

function toAudioResult(result: Record<string, unknown>): AudioExtractResult {
  const audioMimeType = String(result.audioMimeType || 'audio/mpeg');
  const audioUrl = String(result.audioOutputUrl || '').trim();
  const audioAssetId = String(result.audioOutputAssetId || '').trim();
  const audioBase64 = String(result.audioOutputBase64 || '');
  const blob = audioBase64 ? new Blob([base64ToBytes(audioBase64)], { type: audioMimeType }) : undefined;
  return {
    blob,
    url: audioUrl || (blob ? URL.createObjectURL(blob) : ''),
    assetId: audioAssetId || undefined,
    mimeType: audioMimeType,
    format: String(result.audioFormat || audioExtensionFromMimeType(audioMimeType)),
    duration: Math.max(0, Number(result.audioDuration || 0)),
    size: Number(result.audioSize || blob?.size || 0),
    sampleRate: Math.max(0, Number(result.audioSampleRate || 0)) || undefined,
    channels: Math.max(0, Number(result.audioChannels || 0)) || undefined,
  };
}

function toNamedAudioResult(result: Record<string, unknown>, prefix: string): AudioExtractResult {
  const audioMimeType = String(result[`${prefix}MimeType`] || 'audio/mpeg');
  const audioUrl = String(result[`${prefix}OutputUrl`] || '').trim();
  const audioAssetId = String(result[`${prefix}OutputAssetId`] || '').trim();
  const audioBase64 = String(result[`${prefix}OutputBase64`] || '');
  const blob = audioBase64 ? new Blob([base64ToBytes(audioBase64)], { type: audioMimeType }) : undefined;
  return {
    blob,
    url: audioUrl || (blob ? URL.createObjectURL(blob) : ''),
    assetId: audioAssetId || undefined,
    mimeType: audioMimeType,
    format: String(result[`${prefix}Format`] || audioExtensionFromMimeType(audioMimeType)),
    duration: Math.max(0, Number(result[`${prefix}Duration`] || 0)),
    size: Number(result[`${prefix}Size`] || blob?.size || 0),
    sampleRate: Math.max(0, Number(result[`${prefix}SampleRate`] || 0)) || undefined,
    channels: Math.max(0, Number(result[`${prefix}Channels`] || 0)) || undefined,
  };
}

async function requestVideoResult(
  operation: Extract<LocalVideoEditOperation, 'crop' | 'clip' | 'hd' | 'removeSubtitle' | 'audioMix' | 'motionblur'>,
  videoUrl: string,
  payload: Record<string, unknown>,
  onProgress?: (progress: FFmpegProgress) => void,
): Promise<PipelineResult<VideoTranscodeResult>> {
  const response = await requestServerLocalVideoEdit(operation, videoUrl, payload, onProgress);
  if (!response.success || !response.data) {
      return response as unknown as PipelineResult<VideoTranscodeResult>;
  }
  return {
    success: true,
    data: toVideoResult(response.data),
  };
}

export async function cropVideoLocally(
  videoUrl: string,
  rect: VideoCropRect,
  audioMixConfig?: LocalVideoAudioMixConfig,
  onProgress?: (progress: FFmpegProgress) => void,
): Promise<PipelineResult<VideoTranscodeResult>> {
  if (!videoUrl) {
    return { success: false, error: '未找到可裁剪的视频素材。' };
  }
  if (typeof fetch === 'undefined') {
    return { success: false, error: '当前环境不支持本地视频裁剪。' };
  }
  try {
    return await requestVideoResult('crop', videoUrl, { rect, ...(audioMixConfig || {}) }, onProgress);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '本地裁剪失败。',
    };
  }
}

export async function clipVideoLocally(
  videoUrl: string,
  segments: VideoClipSegment[],
  audioMixConfig?: LocalVideoAudioMixConfig,
  onProgress?: (progress: FFmpegProgress) => void,
): Promise<PipelineResult<VideoTranscodeResult>> {
  if (!videoUrl) {
    return { success: false, error: '未找到可剪辑的视频素材。' };
  }
  if (typeof fetch === 'undefined') {
    return { success: false, error: '当前环境不支持本地视频剪辑。' };
  }
  try {
    return await requestVideoResult('clip', videoUrl, { segments, ...(audioMixConfig || {}) }, onProgress);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '本地剪辑失败。',
    };
  }
}

export async function clipVideoLocallyStable(
  videoUrl: string,
  segments: VideoClipSegment[],
  audioMixConfig?: LocalVideoAudioMixConfig,
  onProgress?: (progress: FFmpegProgress) => void,
): Promise<PipelineResult<VideoTranscodeResult>> {
  return clipVideoLocally(videoUrl, segments, audioMixConfig, onProgress);
}

export async function enhanceVideoLocally(
  videoUrl: string,
  config: Record<string, unknown>,
  onProgress?: (progress: FFmpegProgress) => void,
): Promise<PipelineResult<VideoTranscodeResult>> {
  if (!videoUrl) {
    return { success: false, error: '未找到可增强的视频素材。' };
  }
  try {
    return await requestVideoResult('hd', videoUrl, config, onProgress);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '本地高清增强失败。',
    };
  }
}

/** 服务端 ffmpeg 真实运动模糊（电影感快门模拟）。返回带运动模糊的视频，用于后期节点的视频电影感工作流。 */
export async function applyMotionBlurVideoLocally(
  videoUrl: string,
  config: { strength?: number; fps?: number; shutterFrames?: number } = {},
  onProgress?: (progress: FFmpegProgress) => void,
): Promise<PipelineResult<VideoTranscodeResult>> {
  if (!videoUrl) {
    return { success: false, error: '未找到可加运动模糊的视频素材。' };
  }
  try {
    return await requestVideoResult('motionblur', videoUrl, config, onProgress);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '本地运动模糊失败。',
    };
  }
}
/*
export async function mixVideoAudioLocally(
  videoUrl: string,
  audioMixConfig: LocalVideoAudioMixConfig,
  onProgress?: (progress: FFmpegProgress) => void,
): Promise<PipelineResult<VideoTranscodeResult>> {
  if (!videoUrl) {
    return { success: false, error: '鏈壘鍒板彲鍚庢贩闊崇殑瑙嗛绱犳潗銆? };
  }
  if (!audioMixConfig?.linkedAudioSourceUrl) {
    return { success: false, error: '鏈壘鍒板彲澶嶇敤鐨勯煶棰戠礌鏉愩€? };
  }
  try {
    return await requestVideoResult('audioMix', videoUrl, { ...(audioMixConfig || {}) }, onProgress);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '鏈湴闊抽鍚庢贩澶辫触銆? ',
    };
  }
}
*/

export async function mixVideoAudioLocally(
  videoUrl: string,
  audioMixConfig: LocalVideoAudioMixConfig,
  onProgress?: (progress: FFmpegProgress) => void,
): Promise<PipelineResult<VideoTranscodeResult>> {
  if (!videoUrl) {
    return { success: false, error: '未找到可后混的目标视频。' };
  }
  if (!audioMixConfig?.linkedAudioSourceUrl) {
    return { success: false, error: '未找到可复用的音频素材。' };
  }
  try {
    return await requestVideoResult('audioMix', videoUrl, { ...(audioMixConfig || {}) }, onProgress);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '本地音频后混失败。',
    };
  }
}

export async function removeSubtitleLocally(
  videoUrl: string,
  config: Record<string, unknown>,
  onProgress?: (progress: FFmpegProgress) => void,
): Promise<PipelineResult<VideoTranscodeResult>> {
  if (!videoUrl) {
    return { success: false, error: '未找到可去字幕的视频素材。' };
  }
  try {
    return await requestVideoResult('removeSubtitle', videoUrl, config, onProgress);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '本地去字幕失败。',
    };
  }
}

export async function parseVideoLocally(
  videoUrl: string,
  config: Record<string, unknown>,
  onProgress?: (progress: FFmpegProgress) => void,
): Promise<PipelineResult<VideoAnalysisResult>> {
  return parseVideoLocallyEnhanced(videoUrl, config, onProgress);
}

export async function splitVideoAudioLocally(
  videoUrl: string,
  config: Record<string, unknown>,
  onProgress?: (progress: FFmpegProgress) => void,
): Promise<PipelineResult<VideoAudioSplitResult>> {
  if (!videoUrl) {
    return { success: false, error: '未找到可分离音频的视频素材。' };
  }
  try {
    const response = await requestServerLocalVideoEdit('audioSplit', videoUrl, config, onProgress);
    if (!response.success || !response.data) {
      return response as unknown as PipelineResult<VideoAudioSplitResult>;
    }
    if (
      !(response.data.audioOutputUrl || response.data.audioOutputBase64)
      || !(response.data.vocalOutputUrl || response.data.vocalOutputBase64)
      || !(response.data.accompanimentOutputUrl || response.data.accompanimentOutputBase64)
    ) {
      return { success: false, error: '本地音频分离没有返回完整音轨结果。' };
    }
    return {
      success: true,
      data: {
        video: toVideoResult(response.data),
        audio: toAudioResult(response.data),
        vocal: toNamedAudioResult(response.data, 'vocal'),
        accompaniment: toNamedAudioResult(response.data, 'accompaniment'),
        processingEngine: String(response.data.processingEngine || ''),
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '本地音频分离失败。',
    };
  }
}

export async function parseVideoLocallyEnhanced(
  videoUrl: string,
  config: Record<string, unknown>,
  onProgress?: (progress: FFmpegProgress) => void,
): Promise<PipelineResult<VideoAnalysisResult>> {
  if (!videoUrl) {
    return { success: false, error: '未找到可解析的视频素材。' };
  }
  try {
    const response = await requestServerLocalVideoEdit('parse', videoUrl, config, onProgress);
    if (!response.success || !response.data) {
      return response as unknown as PipelineResult<VideoAnalysisResult>;
    }
    const analysis = response.data.analysis && typeof response.data.analysis === 'object'
      ? response.data.analysis as Record<string, unknown>
      : null;
    if (!analysis) {
      return { success: false, error: '本地视频解析没有返回分析结果。' };
    }
    return {
      success: true,
      data: {
        width: Math.max(2, Number(analysis.width || 0)),
        height: Math.max(2, Number(analysis.height || 0)),
        duration: Math.max(0, Number(analysis.duration || 0)),
        sceneCount: Math.max(1, Number(analysis.sceneCount || 1)),
        sceneCuts: Array.isArray(analysis.sceneCuts)
          ? analysis.sceneCuts.map((item) => Number(item)).filter((item) => Number.isFinite(item))
          : [],
        sampleFps: Math.max(1, Number(analysis.sampleFps || 2)),
        summary: String(analysis.summary || ''),
        suggestedShots: Array.isArray(analysis.suggestedShots)
          ? analysis.suggestedShots.map((item, index) => {
            const shot = item && typeof item === 'object' ? item as Record<string, unknown> : {};
            return {
              id: String(shot.id || `shot-${index + 1}`),
              time: Number(shot.time || 0),
              label: String(shot.label || `镜头 ${index + 1}`),
              shotSize: String(shot.shotSize || ''),
              cameraPrompt: String(shot.cameraPrompt || ''),
              imagePrompt: String(shot.imagePrompt || ''),
              keyframePrompt: String(shot.keyframePrompt || ''),
            };
          })
          : [],
        parseRows: Array.isArray(analysis.parseRows)
          ? analysis.parseRows.filter((item) => item && typeof item === 'object').map((item) => item as VideoAnalysisParseRow)
          : [],
        analysisEngine: String(analysis.analysisEngine || ''),
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '本地视频解析失败。',
    };
  }
}

export async function extractAudioFromVideo(
  videoUrl: string,
  onProgress?: (progress: FFmpegProgress) => void,
): Promise<PipelineResult<AudioExtractResult>> {
  const result = await splitVideoAudioLocally(videoUrl, {}, onProgress);
  if (!result.success || !result.data) {
    return {
      success: false,
      error: result.error,
    };
  }
  return {
    success: true,
    data: result.data.audio,
  };
}

export async function repairVideo(
  videoUrl: string,
  onProgress?: (progress: FFmpegProgress) => void,
): Promise<PipelineResult<VideoTranscodeResult>> {
  return enhanceVideoLocally(videoUrl, {}, onProgress);
}

export function primeFFmpegEngine() {
  return;
}
