// LEGACY NOTICE:
// Unreal Pixel Streaming and Remote Control legacy compatibility stays in this file only for explicit fallback cases.
// The normal Unreal path should stay on HMDao Unreal Capture + /ws/dcc/unreal editor-direct bridging.
import {
  type DccCameraOption,
  type DccCaptureResult,
  type DccConnectionOptions,
  type DccConnectionSnapshot,
  type DccAnimationRange,
  type DccEvent,
  type DccEventHandler,
  type DccFrame,
  type DccRecordingOptions,
  type DccRuntimeStage,
  type DccRuntimeStageState,
  DEFAULT_DCC_ANIMATION_RANGE,
  DEFAULT_UNREAL_PIXEL_STREAMING_URL,
  DEFAULT_UNREAL_REMOTE_CONTROL_URL,
  coerceDccPreviewProvider,
  defaultDccPreviewProvider,
  getDccEngineConfig,
} from './types';
import { sanitizeDccVisibleText } from './runtimeState';

let activeRecordingEngine: DccConnectionOptions['engine'] | null = null;
let activeConnectionManager: DccConnectionManager | null = null;
const HOST_STATUS_POLL_MS = 3000;
const MAX_DCC_RECORD_FPS = 240;

type DccGatewayRuntimeEngineStatus = {
  reachable?: boolean;
  directBridgeOnline?: boolean;
  directBridgeReadyForTargetProject?: boolean;
  hostProcessRunning?: boolean;
  targetProjectRunning?: boolean;
  pluginInstalled?: boolean;
  pluginEnabledInProject?: boolean;
  cameraCount?: number;
  projectPath?: string | null;
  integration?: {
    recommendedMode?: string;
    activeMode?: string;
    directBridgeOnline?: boolean;
    directBridgeReady?: boolean;
    officialCaptureReady?: boolean;
    previewProvider?: string;
  } | null;
  official?: {
    capturePrerequisitesReady?: boolean;
    remoteControlReachable?: boolean;
    restartRequired?: boolean;
    missingRequired?: Array<{ name?: string; label?: string }>;
  } | null;
  environmentManager?: {
    level?: string;
    summary?: string;
    recommendedAction?: string;
  } | null;
};

type DccGatewayRuntimeStatusPayload = {
  success?: boolean;
  engines?: {
    unreal?: DccGatewayRuntimeEngineStatus;
    blender?: DccGatewayRuntimeEngineStatus;
  };
};

function isOutdatedBlenderRuntime(status: DccGatewayRuntimeEngineStatus | null): boolean {
  const summary = String(status?.environmentManager?.summary || '').trim();
  return /installed add-on files are already v/i.test(summary) && /restart blender|disable and re-enable the add-on/i.test(summary);
}

function normalizeUrl(value: unknown, fallback: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  const normalized = (raw || fallback).replace(/\/$/, '');
  if (fallback === DEFAULT_UNREAL_PIXEL_STREAMING_URL && (normalized === 'http://127.0.0.1' || normalized === 'http://localhost')) {
    return DEFAULT_UNREAL_PIXEL_STREAMING_URL;
  }
  if (fallback === DEFAULT_UNREAL_PIXEL_STREAMING_URL && (normalized === 'http://127.0.0.1:1025' || normalized === 'http://localhost:1025')) {
    return DEFAULT_UNREAL_PIXEL_STREAMING_URL;
  }
  return normalized;
}

function toDataUrl(payload: string, mimeType?: string): string {
  const raw = payload.trim();
  if (!raw) return '';
  if (/^(data:|blob:|https?:\/\/)/i.test(raw)) {
    return raw;
  }
  const safeMimeType = (mimeType || 'image/png').trim() || 'image/png';
  return `data:${safeMimeType};base64,${raw}`;
}

function readNestedRecord(raw: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = raw[key];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function toProxyRenderableUrl(url: string, mimeType: string): string {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (raw.startsWith('/api/media-proxy?') || /^(data:|blob:|https?:\/\/)/i.test(raw)) {
    return raw;
  }
  if (raw.startsWith('file:///') || /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\')) {
    const kind = mimeType.startsWith('video/') ? 'video' : mimeType.startsWith('audio/') ? 'audio' : 'image';
    return `/api/media-proxy?${new URLSearchParams({ url: raw, kind }).toString()}`;
  }
  return raw;
}

function readFrameUrl(raw: Record<string, unknown>, fallbackMimeType = 'image/png'): string {
  const mimeType = typeof raw.mimeType === 'string'
    ? raw.mimeType
    : typeof raw.mime_type === 'string'
      ? raw.mime_type
      : fallbackMimeType;
  const directUrl = typeof raw.preview_url === 'string'
    ? raw.preview_url
    : typeof raw.url === 'string'
      ? raw.url
      : typeof raw.video_url === 'string'
        ? raw.video_url
        : typeof raw.recording_url === 'string'
          ? raw.recording_url
          : typeof raw.file_url === 'string'
            ? raw.file_url
            : typeof raw.filePath === 'string'
              ? raw.filePath
              : typeof raw.file_path === 'string'
                ? raw.file_path
            : '';
  if (directUrl) return toProxyRenderableUrl(directUrl, mimeType);
  const payload = typeof raw.payload === 'string'
    ? raw.payload
    : typeof raw.img === 'string'
      ? raw.img
      : typeof raw.img_base64 === 'string'
        ? raw.img_base64
        : '';
  return toDataUrl(payload, mimeType);
}

function readCaptureThumbnailUrl(raw: Record<string, unknown>, fallbackMimeType = 'image/jpeg'): string {
  const directUrl = typeof raw.thumbnail_url === 'string'
    ? raw.thumbnail_url
    : typeof raw.thumbnailUrl === 'string'
      ? raw.thumbnailUrl
      : typeof raw.first_frame_url === 'string'
        ? raw.first_frame_url
        : typeof raw.firstFrameUrl === 'string'
          ? raw.firstFrameUrl
          : '';
  if (directUrl) return toProxyRenderableUrl(directUrl, fallbackMimeType);
  const payload = typeof raw.thumbnail_payload === 'string'
    ? raw.thumbnail_payload
    : typeof raw.thumbnail_base64 === 'string'
      ? raw.thumbnail_base64
      : '';
  return toDataUrl(payload, fallbackMimeType);
}

function frameFromPayload(raw: Record<string, unknown>, fallback: DccConnectionOptions): DccFrame | null {
  const asset = readNestedRecord(raw, 'asset');
  const merged = asset ? { ...asset, ...raw } : raw;
  const url = readFrameUrl(merged, typeof asset?.mimeType === 'string' ? asset.mimeType : 'image/png');
  if (!url) return null;
  const width = Number(raw.width || asset?.width || fallback.resolution.width);
  const height = Number(raw.height || asset?.height || fallback.resolution.height);
  return {
    url,
    width: Number.isFinite(width) && width > 0 ? width : fallback.resolution.width,
    height: Number.isFinite(height) && height > 0 ? height : fallback.resolution.height,
    cameraName: String(raw.camera_name || raw.selected_camera || asset?.cameraName || fallback.cameraName || 'Viewport'),
    source: raw.mock ? 'mock' : 'plugin',
    receivedAt: Date.now(),
    latencyMs: Number(raw.latency_ms || 0),
  };
}

function captureFromPayload(raw: Record<string, unknown>, fallback: DccConnectionOptions): DccCaptureResult | null {
  const asset = readNestedRecord(raw, 'asset');
  const merged = asset ? { ...asset, ...raw } : raw;
  const frame = frameFromPayload(merged, fallback);
  if (!frame) return null;
  const mimeType = String(raw.mime_type || raw.mimeType || asset?.mime_type || asset?.mimeType || '').trim();
  const thumbnailMimeType = String(raw.thumbnail_mime_type || raw.thumbnailMimeType || asset?.thumbnail_mime_type || asset?.thumbnailMimeType || 'image/jpeg').trim() || 'image/jpeg';
  const durationMs = Number(raw.duration_ms || raw.durationMs || asset?.duration_ms || asset?.durationMs || 0);
  const startFrame = Number(raw.start_frame ?? raw.startFrame ?? asset?.start_frame ?? asset?.startFrame);
  const endFrame = Number(raw.end_frame ?? raw.endFrame ?? asset?.end_frame ?? asset?.endFrame);
  const fps = Number(raw.fps ?? raw.frame_rate ?? asset?.fps ?? asset?.frame_rate);
  const thumbnailUrl = readCaptureThumbnailUrl(merged, thumbnailMimeType);
  return {
    ...frame,
    sizeBytes: Number(raw.size_bytes || raw.sizeBytes || asset?.size_bytes || asset?.sizeBytes || 0),
    filePath: String(raw.file_path || raw.filePath || asset?.file_path || asset?.filePath || ''),
    durationMs: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : undefined,
    mimeType: mimeType || undefined,
    managedUrl: Boolean(raw.managed_url || raw.managedUrl || asset?.managed_url || asset?.managedUrl),
    thumbnailUrl: thumbnailUrl || undefined,
    startFrame: Number.isFinite(startFrame) ? Math.max(0, Math.round(startFrame)) : undefined,
    endFrame: Number.isFinite(endFrame) ? Math.max(0, Math.round(endFrame)) : undefined,
    fps: Number.isFinite(fps) && fps > 0 ? Math.min(MAX_DCC_RECORD_FPS, Math.round(fps)) : undefined,
  };
}

function normalizeCameras(value: unknown, fallbackEngine: DccConnectionOptions['engine']): DccCameraOption[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): DccCameraOption | null => {
      if (typeof item === 'string') return { name: item, engine: fallbackEngine };
      if (item && typeof item === 'object') {
        const raw = item as Record<string, unknown>;
        const name = String(raw.name || raw.camera_name || raw.label || raw.id || '').trim();
        if (!name) return null;
        return {
          id: typeof raw.id === 'string' ? raw.id : name,
          name,
          label: typeof raw.label === 'string' ? raw.label : name,
          active: Boolean(raw.active || raw.selected),
          engine: fallbackEngine,
        };
      }
      return null;
    })
    .filter((item): item is DccCameraOption => item !== null);
}

function animationRangeFromPayload(raw: Record<string, unknown>, current: DccAnimationRange): DccAnimationRange {
  const startFrame = Number(raw.start_frame ?? raw.startFrame ?? raw.frame_start ?? raw.animation_start ?? current.startFrame);
  const endFrame = Number(raw.end_frame ?? raw.endFrame ?? raw.frame_end ?? raw.animation_end ?? current.endFrame);
  const currentFrame = Number(raw.current_frame ?? raw.currentFrame ?? raw.frame_current ?? current.currentFrame ?? startFrame);
  const fps = Number(raw.fps ?? raw.frame_rate ?? current.fps);
  const hasSequenceRaw = raw.has_sequence ?? raw.hasSequence;
  const hasCameraRaw = raw.has_camera ?? raw.hasCamera;
  const hasSequence = typeof hasSequenceRaw === 'boolean'
    ? hasSequenceRaw
    : (typeof hasSequenceRaw === 'string' ? hasSequenceRaw === 'true' : current.hasSequence ?? false);
  const hasCamera = typeof hasCameraRaw === 'boolean'
    ? hasCameraRaw
    : (typeof hasCameraRaw === 'string' ? hasCameraRaw === 'true' : current.hasCamera ?? false);
  return {
    startFrame: Number.isFinite(startFrame) ? Math.max(0, Math.round(startFrame)) : current.startFrame,
    endFrame: Number.isFinite(endFrame) ? Math.max(0, Math.round(endFrame)) : current.endFrame,
    currentFrame: Number.isFinite(currentFrame) ? Math.max(0, Math.round(currentFrame)) : current.currentFrame,
    fps: Number.isFinite(fps) && fps > 0 ? Math.min(MAX_DCC_RECORD_FPS, Math.round(fps)) : current.fps,
    hasSequence,
    hasCamera,
  };
}

function runtimeStageLabel(engine: DccConnectionOptions['engine'], stage: DccRuntimeStage, state: DccRuntimeStageState): string {
  if (stage === 'plugin') return state === 'error' ? '插件阶段异常' : state === 'ready' ? '插件已就绪' : '等待插件就绪';
  if (stage === 'bridge') return state === 'error' ? '桥接不可用' : state === 'ready' ? '桥接已上线' : '等待桥接上线';
  if (stage === 'frame') return state === 'error' ? '预览/录制异常' : state === 'ready' ? '首帧预览已就绪' : '等待首帧预览';
  return engine === 'unreal'
    ? (state === 'error' ? 'Unreal 未就绪' : state === 'ready' ? 'Unreal 已就绪' : '等待 Unreal 启动')
    : (state === 'error' ? 'Blender 未就绪' : state === 'ready' ? 'Blender 已就绪' : '等待 Blender 启动');
}

function runtimeStagePatch(engine: DccConnectionOptions['engine'], stage: DccRuntimeStage, state: DccRuntimeStageState) {
  return {
    runtimeStage: stage,
    runtimeStageState: state,
    runtimeStageLabel: runtimeStageLabel(engine, stage, state),
  };
}

export class DccConnectionManager {
  private ws: WebSocket | null = null;
  private listeners = new Set<DccEventHandler>();
  private fpsSamples: number[] = [];
  private lastFrameAt = 0;
  private previewPollTimer = 0;
  private hostStatusPollTimer = 0;
  private deferredPreviewTimer = 0;
  private deferredUnrealQueryTimer = 0;
  private options: DccConnectionOptions | null = null;
  private frameWatchdog = 0;
  private gatewayBaseUrl = '';
  private transport: 'websocket' | 'editor-direct' | 'pixel-streaming' | null = null;
  private suppressNextCloseFailure = false;
  private snapshot: DccConnectionSnapshot = {
    status: 'idle',
    captureStatus: 'idle',
    message: '尚未连接 DCC 引擎。请先启动 Blender 或虚幻插件，然后点击连接。',
    runtimeStage: 'host',
    runtimeStageState: 'idle',
    runtimeStageLabel: '等待宿主启动',
    cameras: [],
    selectedCamera: '',
    selectedCameraId: '',
    animationRange: DEFAULT_DCC_ANIMATION_RANGE,
    lastFrame: null,
    fps: 0,
    recordingLockedBy: null,
    connectionMode: 'offline',
    integration: 'websocket',
  };

  subscribe(listener: DccEventHandler): () => void {
    this.listeners.add(listener);
    listener({ type: 'state', snapshot: this.snapshot });
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): DccConnectionSnapshot {
    return this.snapshot;
  }

  async connect(options: DccConnectionOptions): Promise<void> {
    this.disconnect(false);
    if (activeConnectionManager && activeConnectionManager !== this) {
      activeConnectionManager.disconnectForPeer(options.engine);
    }
    activeConnectionManager = this;
    this.options = options;
    const config = getDccEngineConfig(options.engine);
    const previewProvider = coerceDccPreviewProvider(options.engine, options.previewProvider || config.previewProvider);
    if (previewProvider === 'pixel-streaming-legacy') {
      await this.connectPixelStreaming({ ...options, previewProvider });
      return;
    }

    this.update({
      status: 'connecting',
      captureStatus: 'idle',
      message: `正在连接 ${config.label}，本地端口 ${config.port}...`,
      selectedCamera: options.cameraName || '',
      selectedCameraId: options.cameraId || '',
      cameras: [],
      lastFrame: null,
      fps: 0,
      recordingLockedBy: activeRecordingEngine,
      connectionMode: 'offline',
      integration: config.integration,
      previewProvider,
    });
    const gateway = await this.resolveGateway(options.engine);
    if (!gateway) {
      this.update({
        status: 'error',
        captureStatus: 'error',
        message: 'HMDao DCC 网关未启动或仍是旧后端。请重启 npm run dev:full，或确认 127.0.0.1:8792 已加载最新 hmdao-api.mjs。',
      });
      return;
    }
    const url = this.wsUrlForGateway(gateway, options.engine);
    const ws = new WebSocket(url);
    this.ws = ws;
    this.transport = options.engine === 'unreal' ? 'editor-direct' : 'websocket';

    const timeout = window.setTimeout(() => {
      if (this.ws === ws && ws.readyState !== WebSocket.OPEN) {
        ws.close();
        this.fail(`无法连接 HMDao DCC 网关。请确认后端服务正在运行，并检查 ${config.pluginName}。`);
      }
    }, 4500);
    ws.onopen = () => {
      if (this.ws !== ws) {
        window.clearTimeout(timeout);
        return;
      }
      window.clearTimeout(timeout);
      this.update({
        status: 'connecting',
        captureStatus: 'idle',
        message: `${config.label} 网关已连接，正在等待真实插件确认并启动预览。`,
      });
      this.startHostStatusPolling();
      this.send({
        type: 'connect',
        engine: options.engine,
        w: options.resolution.width,
        h: options.resolution.height,
        allow_mock: options.allowMockFallback !== false,
        require_real: options.allowMockFallback === false,
      });
      this.send({ type: 'query_animation_range' });
      if (options.engine !== 'unreal') {
        this.send({ type: 'query_camera' });
        this.startPreview(options.cameraName || undefined, options.cameraId || undefined);
        this.startFrameWatchdog();
      }
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      try {
        this.handleMessage(JSON.parse(event.data) as Record<string, unknown>);
      } catch {
        this.emit({ type: 'error', message: 'DCC 插件消息解析失败。' });
      }
    };

    ws.onerror = () => {
      if (this.ws !== ws) {
        window.clearTimeout(timeout);
        return;
      }
      window.clearTimeout(timeout);
      this.fail(`HMDao DCC 网关连接失败。请确认 npm run dev:full 正在运行。`);
    };

    ws.onclose = () => {
      if (this.ws !== ws) {
        window.clearTimeout(timeout);
        return;
      }
      window.clearTimeout(timeout);
      const suppressFailure = this.suppressNextCloseFailure;
      this.suppressNextCloseFailure = false;
      if (this.ws === ws) this.ws = null;
      this.stopFrameWatchdog();
      this.clearDeferredTimers();
      this.stopHostStatusPolling();
      if (this.transport !== 'pixel-streaming') this.transport = null;
      if (activeConnectionManager === this) {
        activeConnectionManager = null;
      }
      if (suppressFailure) {
        return;
      }
      const wasConnecting = this.snapshot.status === 'connecting';
      const wasConnected = this.snapshot.status === 'connected';
      const disconnectBeforeFailure = wasConnecting || wasConnected;
      if (disconnectBeforeFailure) {
        this.releaseTransport(
          wasConnecting
            ? `${config.label} 连接在预览启动前已关闭。`
            : `${config.label} 连接已断开。若 Unreal Editor 或 Blender 已关闭，请先重新打开宿主后再连接。`,
          {
            status: wasConnecting ? 'error' : 'idle',
            emitError: wasConnecting,
          },
        );
        return;
      }
      if (wasConnecting || wasConnected) {
        this.update({ lastFrame: null, fps: 0, connectionMode: 'offline', captureStatus: 'error' });
        this.fail(wasConnecting
          ? `${config.label} 连接在预览启动前已关闭。`
          : `${config.label} 连接已断开。若 Unreal Editor 意外关闭，请重启后再点击连接。`);
      }
    };
  }

  disconnect(updateState = true): void {
    this.stopFrameWatchdog();
    this.clearDeferredTimers();
    this.stopPreviewPolling();
    this.stopHostStatusPolling();
    if (this.options?.engine && activeRecordingEngine === this.options.engine) activeRecordingEngine = null;
    if (activeConnectionManager === this) activeConnectionManager = null;
    if (this.ws) {
      try { this.send({ type: 'stop_preview' }); } catch { /* noop */ }
      if (this.options?.engine === 'unreal') {
        try { this.send({ type: 'disconnect', engine: 'unreal' }); } catch { /* noop */ }
      }
      this.ws.close();
      this.ws = null;
    }
    this.options = null;
    this.gatewayBaseUrl = '';
    this.lastFrameAt = 0;
    this.fpsSamples = [];
    this.transport = null;
    if (updateState) {
      this.update({
        status: 'idle',
        captureStatus: 'idle',
        message: '尚未连接 DCC 引擎。请先启动 Blender 或虚幻插件，然后点击连接。',
        cameras: [],
        selectedCamera: '',
        selectedCameraId: '',
        fps: 0,
        recordingLockedBy: activeRecordingEngine,
        connectionMode: 'offline',
        integration: 'websocket',
        previewProvider: undefined,
        pixelStreamingUrl: '',
        remoteControlUrl: '',
      });
    }
  }


  setCamera(cameraName: string, cameraId?: string): void {
    if (this.transport === 'pixel-streaming') {
      void this.setPixelStreamingCamera(cameraName);
      return;
    }
    this.stopFrameWatchdog();
    this.update({ selectedCamera: cameraName, selectedCameraId: cameraId || '' });
    if (this.options) this.options = { ...this.options, cameraName, cameraId };
    this.send({ type: 'set_camera', camera_name: cameraName, camera_id: cameraId });
    this.send({ type: 'query_animation_range', camera_name: cameraName, camera_id: cameraId });
    this.startPreview(cameraName, cameraId);
    this.startFrameWatchdog();
  }
  setResolution(width: number, height: number): void {
    if (this.options) this.options = { ...this.options, resolution: { label: `${width} x ${height}`, width, height } };
    this.startPreview(this.snapshot.selectedCamera || undefined, this.snapshot.selectedCameraId || undefined);
    this.startFrameWatchdog();
  }

  pausePreview(): void {
    if (this.transport === 'pixel-streaming') return;
    this.stopFrameWatchdog();
    this.stopPreviewPolling();
    try { this.send({ type: 'stop_preview' }); } catch { /* noop */ }
    this.update({ lastFrame: null, fps: 0, message: 'DCC 预览已暂停，可随时恢复。' });
  }

  resumePreview(): void {
    if (!this.options) return;
    if (this.transport === 'pixel-streaming') return;
    this.startPreview(this.snapshot.selectedCamera || this.options.cameraName || undefined, this.snapshot.selectedCameraId || this.options.cameraId || undefined);
    this.startFrameWatchdog();
    this.update({ message: 'DCC 预览已恢复。' });
  }

  requestCameras(): void {
    if (!this.options) return;
    if (this.transport === 'pixel-streaming') {
      void this.refreshPixelStreamingStatus(this.options);
      return;
    }
    const socketOpen = this.ws?.readyState === WebSocket.OPEN;
    if (!socketOpen || this.snapshot.status !== 'connected') {
      const reconnectOptions = {
        ...this.options,
        cameraName: this.snapshot.selectedCamera || this.options.cameraName,
        cameraId: this.snapshot.selectedCameraId || this.options.cameraId,
      };
      this.update({
        status: 'connecting',
        captureStatus: 'idle',
        message: '正在重新连接 DCC 引擎并刷新摄像机列表...',
        lastFrame: null,
        fps: 0,
      });
      void this.connect(reconnectOptions);
      return;
    }
    this.send({ type: 'query_camera' });
    this.send({ type: 'query_animation_range', camera_name: this.snapshot.selectedCamera || undefined, camera_id: this.snapshot.selectedCameraId || undefined });
    if (this.options.engine === 'unreal') {
      this.scheduleDeferredPreview(this.snapshot.selectedCamera || undefined, this.snapshot.selectedCameraId || undefined);
      return;
    }
    this.startPreview(this.snapshot.selectedCamera || undefined, this.snapshot.selectedCameraId || undefined);
    this.startFrameWatchdog();
  }

  capture(width: number, height: number): void {
    if (!this.isConnected()) {
      this.fail('请先连接 Blender 或虚幻引擎，再进行截图。');
      return;
    }
    if (this.transport === 'pixel-streaming') {
      this.update({
        captureStatus: 'error',
        message: '兼容模式浏览器预览是 WebRTC iframe，浏览器不能直接截图跨源视频帧。DCC 节点默认只负责镜头动画与实时预览采集；如需最终电影质感输出，请把镜头数据交给后续打标签与视频模型链路。',
      });
      return;
    }
    this.update({ captureStatus: 'capturing', message: '正在抓取当前摄像机的高画质画面...' });
    this.send({
      type: 'capture_by_camera',
      camera_name: this.snapshot.selectedCamera || undefined,
      camera_id: this.snapshot.selectedCameraId || undefined,
      w: width,
      h: height,
      format: 'webp',
      quality: 95,
    });
  }

  beginRecording(options: DccRecordingOptions): boolean {
    const engine = this.options?.engine;
    if (!engine || !this.isConnected()) {
      this.fail('请先连接 Blender 或虚幻引擎，再开始录制。');
      return false;
    }
    if (activeRecordingEngine && activeRecordingEngine !== engine) {
      const config = getDccEngineConfig(activeRecordingEngine);
      this.update({
        captureStatus: 'error',
        message: `${config.label} 正在录制中。请等待当前录制完成后再切换引擎。`,
        recordingLockedBy: activeRecordingEngine,
      });
      return false;
    }
    activeRecordingEngine = engine;
    // NOTE: The Unreal editor-direct plugin does NOT stream live frames back while
    // recording (it only writes frames to disk). The old code stopped the preview
    // poll here, which froze the node on the last pre-record frame and looked like
    // "no preview animation". We now keep a *throttled* snapshot poll running during
    // recording so the node stays alive. The poll only grabs lightweight JPEG captures
    // and never disturbs the real-time playback-driven recording.
    this.update({
      captureStatus: 'recording',
      message: `正在录制 ${options.startFrame}-${options.endFrame} 帧，预览画面保持实时刷新。`,
      recordingLockedBy: activeRecordingEngine,
    });
    this.send({
      type: 'start_recording',
      camera_name: options.cameraName || this.snapshot.selectedCamera || undefined,
      camera_id: options.cameraId || this.snapshot.selectedCameraId || undefined,
      start_frame: options.startFrame,
      end_frame: options.endFrame,
      fps: options.fps,
      w: options.width,
      h: options.height,
      // Double-safety: the Unreal plugin's playback-driven recording path reads the
      // recording resolution from `captureWidth`/`captureHeight` (fallback
      // `recordWidth`/`recordHeight`), NOT `w`/`h`/`width`/`height` (those drive the
      // live preview). Mirror the chosen resolution here so the panel selection is
      // honored even if the backend normalization is skipped.
      captureWidth: options.width,
      captureHeight: options.height,
      recordWidth: options.width,
      recordHeight: options.height,
      // Chromium playback is more reliable with the Unreal direct bridge when the host encodes MP4.
      // Request MP4 here so the returned recording can render directly in the node and region views.
      format: 'mp4',
      quality: 95,
    });
    if (engine === 'unreal' && this.transport === 'editor-direct') {
      // Keep a throttled live snapshot poll during recording (captureStatus is
      // already 'recording' here, so startUnrealPreviewPolling uses the faster
      // in-recording interval). This is what keeps the node preview from freezing.
      this.startUnrealPreviewPolling(
        this.snapshot.selectedCamera || this.options?.cameraName || undefined,
        this.snapshot.selectedCameraId || this.options?.cameraId || undefined,
      );
    }
    return true;
  }

  requestStopRecording(): void {
    if (this.transport === 'pixel-streaming') {
      this.finishRecording('兼容模式浏览器预览录制已在本地完成。');
      return;
    }
    this.send({ type: 'stop_recording', camera_name: this.snapshot.selectedCamera || undefined, camera_id: this.snapshot.selectedCameraId || undefined });
  }

  finishRecording(message = '录制已完成，实时预览保持连接。'): void {
    if (this.options?.engine && activeRecordingEngine === this.options.engine) activeRecordingEngine = null;
    this.update({ captureStatus: 'idle', message, recordingLockedBy: activeRecordingEngine });
    if (this.shouldUseUnrealCapturePolling()) {
      this.startUnrealPreviewPolling(
        this.snapshot.selectedCamera || this.options?.cameraName || undefined,
        this.snapshot.selectedCameraId || this.options?.cameraId || undefined,
      );
    }
  }

  completeLocalRecording(result: DccCaptureResult, message = '录制已完成，视频已回传到画布节点。'): void {
    this.finishRecording(message);
    this.emit({ type: 'recording', result });
  }

  isConnected(): boolean {
    if (this.transport === 'pixel-streaming') return this.snapshot.status === 'connected';
    return this.ws?.readyState === WebSocket.OPEN && this.snapshot.status === 'connected';
  }

  private async connectPixelStreaming(options: DccConnectionOptions): Promise<void> {
    const config = getDccEngineConfig(options.engine);
    this.transport = 'pixel-streaming';
    this.update({
      status: 'connecting',
      captureStatus: 'idle',
      message: `正在连接 ${config.label}，本地端口 ${config.port}...`,
      selectedCamera: options.cameraName || '',
      selectedCameraId: options.cameraId || '',
      cameras: [],
      lastFrame: null,
      fps: 0,
      recordingLockedBy: activeRecordingEngine,
      connectionMode: 'offline',
      integration: config.integration,
      previewProvider: 'pixel-streaming-legacy',
    });
    let statusResult = await this.fetchPixelStreamingStatus(options);
    if (!statusResult) {
      await this.startPixelStreamingFrontend();
      statusResult = await this.fetchPixelStreamingStatus(options);
    }
    if (!statusResult) {
      this.update({
        status: 'error',
        captureStatus: 'error',
        message: '当前 HMDao 后端未加载 Unreal 兼容模式预览适配器。默认请继续使用直连模式；只有明确需要旧链路时，再开启兼容模式并重启后端。',
      });
      return;
    }

    this.gatewayBaseUrl = statusResult.gateway;
    this.applyPixelStreamingStatus(options, statusResult.data);
  }

  private async startPixelStreamingFrontend(): Promise<void> {
    const gateway = this.gatewayBaseUrl || this.gatewayCandidates()[0] || '';
    if (!gateway) return;
    try {
      await fetch(`${gateway}/api/dcc/unreal/pixel-streaming/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      await new Promise((resolve) => window.setTimeout(resolve, 2200));
    } catch {
      /* noop */
    }
  }

  private async refreshPixelStreamingStatus(options: DccConnectionOptions, knownGateway?: string): Promise<void> {
    const statusResult = await this.fetchPixelStreamingStatus(options, knownGateway || this.gatewayBaseUrl);
    if (!statusResult) {
      this.update({
        status: 'error',
        captureStatus: 'error',
        connectionMode: 'offline',
        integration: 'pixel-streaming',
        previewProvider: 'pixel-streaming-legacy',
        message: '当前 HMDao 后端未加载 Unreal 兼容模式预览适配器。默认请继续使用直连模式；只有明确需要旧链路时，再开启兼容模式并重启后端。',
      });
      return;
    }
    this.gatewayBaseUrl = statusResult.gateway;
    this.applyPixelStreamingStatus(options, statusResult.data);
  }

  private async fetchPixelStreamingStatus(options: DccConnectionOptions, preferredGateway?: string): Promise<{ gateway: string; data: Record<string, unknown> } | null> {
    const candidates = Array.from(new Set([preferredGateway, ...this.gatewayCandidates()].filter(Boolean)));
    const pixelStreamingUrl = normalizeUrl(options.pixelStreamingUrl, this.snapshot.pixelStreamingUrl || DEFAULT_UNREAL_PIXEL_STREAMING_URL);
    const remoteControlUrl = normalizeUrl(options.remoteControlUrl, this.snapshot.remoteControlUrl || DEFAULT_UNREAL_REMOTE_CONTROL_URL);
    for (const gateway of candidates) {
      if (!gateway) continue;
      const url = new URL(`${gateway}/api/dcc/unreal/status`);
      url.searchParams.set('pixelUrl', pixelStreamingUrl);
      url.searchParams.set('remoteUrl', remoteControlUrl);
      try {
        const response = await fetch(url.toString(), { cache: 'no-store' });
        if (response.status === 404) continue;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as Record<string, unknown>;
        if (data?.service !== 'hmdao-unreal-pixel-streaming-adapter') continue;
        return { gateway, data };
      } catch {
        /* try next gateway */
      }
    }
    return null;
  }

  private applyPixelStreamingStatus(options: DccConnectionOptions, data: Record<string, unknown>): void {
    const pixelStreamingUrl = normalizeUrl(data.pixelStreamingUrl, options.pixelStreamingUrl || this.snapshot.pixelStreamingUrl || DEFAULT_UNREAL_PIXEL_STREAMING_URL);
    const remoteControlUrl = normalizeUrl(data.remoteControlUrl, options.remoteControlUrl || this.snapshot.remoteControlUrl || DEFAULT_UNREAL_REMOTE_CONTROL_URL);
    const cameras = normalizeCameras(data.cameras, 'unreal');
    const selectedCamera = String(data.selectedCamera || data.selected_camera || options.cameraName || cameras.find((camera) => camera.active)?.name || cameras[0]?.name || 'Pixel Streaming');
    const pixelReachable = Boolean(data.pixelReachable);
    const remoteReachable = Boolean(data.remoteReachable);
    const pixelRestApiReachable = Boolean(data.pixelRestApiReachable);
    const pixelRestApiUrl = typeof data.pixelRestApiUrl === 'string' ? data.pixelRestApiUrl : '';
    const pixelStreamerCount = Math.max(0, Number(data.pixelStreamerCount || 0));
    const pixelPlayerCount = Math.max(0, Number(data.pixelPlayerCount || 0));
    const pixelStreamerConnected = Boolean(data.pixelStreamerConnected ?? (pixelStreamerCount > 0));
    const pixelHint = typeof data.pixelHint === 'string' ? data.pixelHint.trim() : '';
    const pixelConfigMode = typeof data.pixelConfigMode === 'string' ? data.pixelConfigMode : 'http-url';
    const pixelSuggestedUrl = typeof data.pixelSuggestedUrl === 'string' ? data.pixelSuggestedUrl : pixelStreamingUrl;
    const pixelConfiguredUrl = typeof data.pixelConfiguredUrl === 'string' ? data.pixelConfiguredUrl : pixelStreamingUrl;
    const previewReady = pixelReachable && (!pixelRestApiReachable || pixelStreamerConnected);
    const signalUrl = typeof data.controlSignalUrl === 'string' && data.controlSignalUrl ? data.controlSignalUrl : 'ws://127.0.0.1:8888';
    const message = pixelReachable
      ? pixelRestApiReachable && !pixelStreamerConnected
        ? `兼容模式浏览器预览页已启动，但还没有检测到 Unreal Streamer 连接到 ${signalUrl}。请在 UE 中开启 Pixel Streaming 推流，并确认 SignallingWebServer 的 streamer 数量大于 0。`
        : remoteReachable
          ? 'Unreal 兼容模式浏览器预览已接入，兼容相机控制接口可用；预览来自 UE WebRTC 实时画面。'
          : 'Unreal 兼容模式浏览器预览已接入；兼容相机控制接口未连通，相机切换将使用 HMDao 本地列表。'
      : pixelConfigMode === 'websocket-url'
        ? `当前兼容模式预览地址填成了 WebSocket/Streamer：${pixelConfiguredUrl}。请改填浏览器播放器页面，例如 ${pixelSuggestedUrl}。`
        : pixelHint || `未检测到兼容模式浏览器预览前端。请先启动 Pixel Streaming Signalling/Web Frontend，并确认浏览器能打开 ${pixelSuggestedUrl}。`;

    this.update({
      status: previewReady ? 'connected' : 'error',
      captureStatus: previewReady ? 'idle' : 'error',
      connectionMode: previewReady ? 'real' : 'offline',
      integration: 'pixel-streaming',
      message,
      cameras: cameras.length ? cameras : [{ name: selectedCamera, label: selectedCamera, active: true, engine: 'unreal' }],
      selectedCamera,
      animationRange: animationRangeFromPayload(data.timeline as Record<string, unknown> || data, this.snapshot.animationRange),
      pixelStreamingUrl,
      remoteControlUrl,
      pixelRestApiReachable,
      pixelRestApiUrl,
      pixelStreamerConnected,
      pixelStreamerCount,
      pixelPlayerCount,
      controlObjectPath: typeof data.controlObjectPath === 'string' ? data.controlObjectPath : '',
      controlCameraFunction: typeof data.controlCameraFunction === 'string' ? data.controlCameraFunction : 'SetHMDaoCamera',
      controlConfigured: Boolean(data.controlConfigured),
      controlConfigSource: typeof data.controlConfigSource === 'string' ? data.controlConfigSource : 'unset',
      controlSignalUrl: typeof data.controlSignalUrl === 'string' ? data.controlSignalUrl : '',
      fps: previewReady ? 60 : 0,
    });
  }

  private async setPixelStreamingCamera(cameraName: string): Promise<void> {
    this.update({ selectedCamera: cameraName, message: `正在通过兼容模式相机控制切换到 ${cameraName}...` });
    if (this.options) this.options = { ...this.options, cameraName };
    const gateway = this.gatewayBaseUrl || await this.resolveGateway('unreal');
    if (!gateway) {
      this.update({ message: 'HMDao API 未启动，无法调用 Unreal 兼容模式相机控制。' });
      return;
    }
    try {
      const response = await fetch(`${gateway}/api/dcc/unreal/camera`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cameraName,
          remoteUrl: this.snapshot.remoteControlUrl || this.options?.remoteControlUrl || DEFAULT_UNREAL_REMOTE_CONTROL_URL,
        }),
      });
      const data = await response.json().catch(() => ({}));
      this.update({
        selectedCamera: cameraName,
        message: data?.remoteCalled
          ? `已通过兼容模式相机控制切换到 ${cameraName}。`
          : `已在 HMDao 中选择 ${cameraName}；如需驱动 UE 视角，请配置 HMDAO_UNREAL_CONTROL_OBJECT_PATH。`,
      });
    } catch (error) {
      this.update({ message: `兼容模式相机切换失败：${error instanceof Error ? error.message : String(error)}` });
    }
  }

  private handleMessage(raw: Record<string, unknown>): void {
    const type = String(raw.type || '');
    if (type === 'connected' || type === 'engine_switched') {
      const connectionMode = raw.mode === 'mock' ? 'mock' : 'real';
      if (this.options?.allowMockFallback === false && connectionMode === 'mock') {
        this.fail(typeof raw.message === 'string' && raw.message
          ? raw.message
          : `未检测到真实 ${this.options?.engine === 'unreal' ? 'Unreal' : 'Blender'} 插件，请先确认 DCC 侧真实桥接已连上 HMDao。`);
        return;
      }
      if (this.options?.engine === 'blender' && connectionMode === 'mock') {
        this.fail(typeof raw.message === 'string' && raw.message
          ? raw.message
          : '未检测到真实 Blender 插件，请在 Blender 中启动 HMDao Blender Capture 服务。');
        return;
      }
      const message = typeof raw.message === 'string' && raw.message
        ? raw.message
        : connectionMode === 'mock'
          ? '未检测到真实 DCC 插件，当前为本地测试预览，不代表 Blender/虚幻实际摄像机画面。'
          : '真实插件已连接，预览来自当前 DCC 软件摄像机。';
      this.update({ status: 'connected', captureStatus: 'idle', connectionMode, message, ...runtimeStagePatch(this.options?.engine || 'blender', 'bridge', 'ready') });
      if (this.options?.engine === 'unreal' && connectionMode === 'real') {
        this.scheduleUnrealBootstrapQueries();
      } else {
        this.requestCameras();
        this.startPreview(this.snapshot.selectedCamera || this.options?.cameraName || undefined, this.snapshot.selectedCameraId || this.options?.cameraId || undefined);
        if (this.options?.engine === 'blender' && connectionMode === 'real') {
          this.requestPreviewFallbackFrame(this.snapshot.selectedCamera || this.options?.cameraName || undefined, this.snapshot.selectedCameraId || this.options?.cameraId || undefined);
        }
      }
      return;
    }
    if (type === 'camera_list') {
      const cameras = normalizeCameras(raw.camera_list ?? raw.cameras, this.options?.engine || 'blender');
      const activeCamera = cameras.find((camera) => camera.active);
      const selectedCamera = String(raw.selected_camera || raw.camera_name || activeCamera?.name || cameras[0]?.name || this.snapshot.selectedCamera || '视口');
      const selectedCameraId = String(raw.selected_camera_id || activeCamera?.id || cameras[0]?.id || '');
      this.update({ cameras, selectedCamera, selectedCameraId, ...runtimeStagePatch(this.options?.engine || 'blender', 'frame', 'waiting') });
      if (this.options) {
        this.options = { ...this.options, cameraName: selectedCamera, cameraId: selectedCameraId };
        if (this.options.engine === 'unreal') {
          this.scheduleDeferredPreview(selectedCamera, selectedCameraId);
        } else {
          this.startPreview(selectedCamera, selectedCameraId);
          if (this.snapshot.connectionMode === 'real') {
            this.requestPreviewFallbackFrame(selectedCamera, selectedCameraId);
          }
        }
      }
      return;
    }
    if (type === 'animation_range' || type === 'timeline' || type === 'scene_info') {
      const parsedRange = animationRangeFromPayload(raw, this.snapshot.animationRange);
      console.log('[HMDAO-DCC-DIAG] animation_range <-', { start: parsedRange.startFrame, end: parsedRange.endFrame, fps: parsedRange.fps });
      this.update({ animationRange: parsedRange });
      return;
    }
    if (type === 'frame') {
      const frame = this.options ? frameFromPayload(raw, this.options) : null;
      if (frame) this.acceptFrame(frame);
      return;
    }
    if (type === 'capture_done' || type === 'capture_by_camera_done') {
      const result = this.options ? captureFromPayload(raw, this.options) : null;
      if (result) {
        const keepRecordingState = this.snapshot.captureStatus === 'recording';
        this.acceptFrame(result);
        if (this.snapshot.captureStatus !== 'capturing') {
          this.update({
            captureStatus: keepRecordingState ? 'recording' : 'idle',
            message: result.source === 'mock'
              ? 'Fallback preview refreshed from a mock capture frame.'
              : keepRecordingState
                ? `Recording ${this.snapshot.animationRange.startFrame}-${this.snapshot.animationRange.endFrame} while Unreal preview refresh stays live.`
                : this.options?.engine === 'unreal'
                ? 'HMDao is refreshing the Unreal preview through low-impact live captures to keep the editor responsive.'
                : 'Realtime preview frames are unavailable, so HMDao switched to static live capture refresh.',
          });
          return;
        }
        const prefix = result.source === 'mock' ? '已生成本地测试截图' : '已抓取真实摄像机截图';
        this.update({ captureStatus: 'idle', message: `${prefix} ${result.width} x ${result.height}。`, lastFrame: result });
        this.emit({ type: 'capture', result });
      } else {
        this.fail(String(raw.error || raw.tip_msg || '截图返回为空，请检查当前摄像机画面。'));
      }
      return;
    }
    if (type === 'recording_done' || type === 'record_done') {
      const result = this.options ? captureFromPayload(raw, this.options) : null;
      if (!result) {
        this.fail(this.options?.engine === 'unreal'
          ? '引擎录制流程已结束，但 Unreal 没有回传可保存的视频结果。请回到 DCC 环境管理器先做 Quick Check / Cleanup，再重新 Connect 后重试录制。'
          : '录制流程已结束，但 Blender 没有回传可保存的视频结果。请回到 DCC 环境管理器确认可见会话和 8766 服务都已就绪后再重试录制。');
        return;
      }
      this.finishRecording('引擎录制已完成，视频已回传到画布节点。');
      this.emit({ type: 'recording', result });
      return;
    }
    if (type === 'recording_started') {
      console.log('[HMDAO-DCC-DIAG] recording_started <- plugin received', {
        start_frame: raw.start_frame,
        end_frame: raw.end_frame,
        fps: raw.fps,
      });
      this.update({
        captureStatus: 'recording',
        selectedCamera: String(raw.camera_name || this.snapshot.selectedCamera || ''),
        selectedCameraId: String(raw.camera_id || this.snapshot.selectedCameraId || ''),
        recordingLockedBy: this.options?.engine || activeRecordingEngine,
      });
      return;
    }
    if (type === 'recording_stopped') {
      const selectedCamera = String(raw.camera_name || this.snapshot.selectedCamera || '');
      const selectedCameraId = String(raw.camera_id || this.snapshot.selectedCameraId || '');
      const isBlenderLocalRecording = this.options?.engine === 'blender'
        && this.transport === 'websocket'
        && this.snapshot.captureStatus === 'recording';
      if (isBlenderLocalRecording) {
        this.update({
          selectedCamera,
          selectedCameraId,
          message: 'Blender 已完成节点帧范围输出，正在封装录制视频。',
          recordingLockedBy: this.options?.engine || activeRecordingEngine,
        });
        this.emit({ type: 'recording-stop', message: 'Blender 已完成节点帧范围输出，正在封装录制视频。' });
        return;
      }
      this.update({
        captureStatus: 'idle',
        selectedCamera,
        selectedCameraId,
        recordingLockedBy: null,
      });
      return;
    }
    if (type === 'error' || type === 'connect_error') {
      this.fail(String(raw.message || raw.error || 'DCC 引擎返回错误。'));
    }
  }

  private acceptFrame(frame: DccFrame): void {
    this.stopFrameWatchdog();
    if (this.lastFrameAt) {
      const delta = frame.receivedAt - this.lastFrameAt;
      if (delta > 0) this.fpsSamples.push(1000 / delta);
      if (this.fpsSamples.length > 40) this.fpsSamples.shift();
    }
    this.lastFrameAt = frame.receivedAt;
    const fps = this.fpsSamples.length ? this.fpsSamples.reduce((sum, value) => sum + value, 0) / this.fpsSamples.length : 0;
    this.update({ lastFrame: frame, fps, ...runtimeStagePatch(this.options?.engine || 'blender', 'frame', 'ready') });
    this.emit({ type: 'frame', frame });
    this.startFrameWatchdog();
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  private clearDeferredTimers(): void {
    this.stopPreviewPolling();
    if (this.deferredPreviewTimer) {
      window.clearTimeout(this.deferredPreviewTimer);
      this.deferredPreviewTimer = 0;
    }
    if (this.deferredUnrealQueryTimer) {
      window.clearTimeout(this.deferredUnrealQueryTimer);
      this.deferredUnrealQueryTimer = 0;
    }
  }

  disconnectForPeer(nextEngine: DccConnectionOptions['engine']): void {
    const nextLabel = getDccEngineConfig(nextEngine).label;
    this.suppressNextCloseFailure = true;
    this.disconnect(false);
    this.update({
      status: 'idle',
      captureStatus: 'idle',
      message: `已释放当前 DCC 连接，避免和 ${nextLabel} 同时预览造成卡顿。`,
      cameras: [],
      selectedCamera: '',
      selectedCameraId: '',
      lastFrame: null,
      fps: 0,
      recordingLockedBy: activeRecordingEngine,
      connectionMode: 'offline',
    });
  }

  private scheduleUnrealBootstrapQueries(): void {
    this.clearDeferredTimers();
    this.deferredUnrealQueryTimer = window.setTimeout(() => {
      this.deferredUnrealQueryTimer = 0;
      this.send({ type: 'query_camera' });
      this.send({
        type: 'query_animation_range',
        camera_name: this.snapshot.selectedCamera || this.options?.cameraName || undefined,
        camera_id: this.snapshot.selectedCameraId || this.options?.cameraId || undefined,
      });
    }, 900);
  }

  private scheduleDeferredPreview(cameraName?: string, cameraId?: string): void {
    if (!this.options) return;
    if (this.options.engine !== 'unreal') {
      this.startPreview(cameraName, cameraId);
      this.startFrameWatchdog();
      return;
    }
    if (this.deferredPreviewTimer) window.clearTimeout(this.deferredPreviewTimer);
    this.deferredPreviewTimer = window.setTimeout(() => {
      this.deferredPreviewTimer = 0;
      this.startPreview(cameraName, cameraId);
      this.startFrameWatchdog();
    }, 350);
  }

  private startPreview(cameraName?: string, cameraId?: string): void {
    if (!this.options) return;
    if (this.shouldUseUnrealCapturePolling()) {
      this.startUnrealPreviewPolling(cameraName, cameraId);
      return;
    }
    this.send({
      type: 'start_preview',
      camera_name: cameraName || this.snapshot.selectedCamera || this.options.cameraName || undefined,
      camera_id: cameraId || this.snapshot.selectedCameraId || this.options.cameraId || undefined,
      w: this.options.resolution.width,
      h: this.options.resolution.height,
      fps: 8,
      quality: 82,
      format: 'webp',
    });
  }

  private requestPreviewFallbackFrame(cameraName?: string, cameraId?: string): void {
    if (!this.options) return;
    this.send({
      type: 'capture_by_camera',
      camera_name: cameraName || this.snapshot.selectedCamera || this.options.cameraName || undefined,
      camera_id: cameraId || this.snapshot.selectedCameraId || this.options.cameraId || undefined,
      w: this.options.resolution.width,
      h: this.options.resolution.height,
      // Unreal PNG frames can decode as black in Chromium even though the raw bytes are valid.
      // Request JPEG for the live preview polling path so the browser preview, screenshot thumbnail,
      // and recording first-frame snapshot all stay renderable in the app.
      format: this.options.engine === 'unreal' ? 'jpeg' : 'webp',
      quality: 82,
    });
  }

  private shouldUseUnrealCapturePolling(): boolean {
    return Boolean(
      this.options
      && this.options.engine === 'unreal'
      && this.transport === 'editor-direct'
      && this.snapshot.connectionMode === 'real',
    );
  }

  private startUnrealPreviewPolling(cameraName?: string, cameraId?: string): void {
    if (!this.options) return;
    this.stopPreviewPolling();
    this.requestPreviewFallbackFrame(cameraName, cameraId);
    const intervalMs = this.snapshot.captureStatus === 'recording' ? 350 : 1000;
    this.previewPollTimer = window.setInterval(() => {
      if (!this.shouldUseUnrealCapturePolling()) {
        this.stopPreviewPolling();
        return;
      }
      this.requestPreviewFallbackFrame(
        cameraName || this.snapshot.selectedCamera || this.options?.cameraName || undefined,
        cameraId || this.snapshot.selectedCameraId || this.options?.cameraId || undefined,
      );
    }, intervalMs);
  }

  private stopPreviewPolling(): void {
    if (this.previewPollTimer) {
      window.clearInterval(this.previewPollTimer);
      this.previewPollTimer = 0;
    }
  }

  private startHostStatusPolling(): void {
    this.stopHostStatusPolling();
    if (!this.options || this.options.allowMockFallback !== false) return;
    this.hostStatusPollTimer = window.setInterval(() => {
      void this.verifyHostStillReady();
    }, HOST_STATUS_POLL_MS);
    void this.verifyHostStillReady();
  }

  private stopHostStatusPolling(): void {
    if (this.hostStatusPollTimer) {
      window.clearInterval(this.hostStatusPollTimer);
      this.hostStatusPollTimer = 0;
    }
  }

  private async verifyHostStillReady(): Promise<void> {
    const options = this.options;
    if (!options || !this.gatewayBaseUrl) return;
    if (this.snapshot.status !== 'connecting' && this.snapshot.status !== 'connected') return;
    const runtimeStatus = await this.fetchRuntimeStatus(options.engine);
    if (!runtimeStatus) return;
    if (!this.options || this.options.engine !== options.engine) return;
    if (this.isRuntimeReady(options.engine, runtimeStatus)) return;
    this.releaseTransport(this.runtimeUnavailableMessage(options.engine, runtimeStatus), {
      status: this.snapshot.status === 'connecting' ? 'error' : 'idle',
      emitError: this.snapshot.status === 'connecting',
    });
  }

  private fail(message: string): void {
    if (this.options?.engine && activeRecordingEngine === this.options.engine) activeRecordingEngine = null;
    const fallbackMessage = this.options?.engine === 'unreal'
      ? 'Unreal connection failed. Confirm HMDao Unreal Capture and the editor session are both ready.'
      : 'Blender connection failed. Confirm HMDao Blender Capture and the 8766 service are both ready.';
    const safeMessage = sanitizeDccVisibleText(message, fallbackMessage);
    this.update({
      status: 'error',
      captureStatus: 'error',
      message: safeMessage,
      recordingLockedBy: activeRecordingEngine,
      lastFrame: null,
      fps: 0,
      connectionMode: 'offline',
    });
    this.emit({ type: 'error', message: safeMessage });
  }

  private releaseTransport(
    message: string,
    options: { status?: DccConnectionSnapshot['status']; emitError?: boolean } = {},
  ): void {
    const nextStatus = options.status || 'idle';
    const activeEngine = this.options?.engine || 'blender';
    const nextIntegration = activeEngine === 'unreal' ? 'editor-direct' : 'websocket';
    const nextPreviewProvider = defaultDccPreviewProvider(activeEngine);

    this.stopFrameWatchdog();
    this.clearDeferredTimers();
    this.stopPreviewPolling();
    this.stopHostStatusPolling();
    if (this.options?.engine && activeRecordingEngine === this.options.engine) activeRecordingEngine = null;
    if (activeConnectionManager === this) activeConnectionManager = null;
    this.suppressNextCloseFailure = true;
    if (this.ws) {
      try { this.send({ type: 'stop_preview' }); } catch { /* noop */ }
      try { this.ws.close(); } catch { /* noop */ }
      this.ws = null;
    }
    this.options = null;
    this.gatewayBaseUrl = '';
    this.lastFrameAt = 0;
    this.fpsSamples = [];
    this.transport = null;
    this.update({
      status: nextStatus,
      captureStatus: nextStatus === 'error' ? 'error' : 'idle',
      message,
      cameras: [],
      selectedCamera: '',
      selectedCameraId: '',
      lastFrame: null,
      fps: 0,
      recordingLockedBy: activeRecordingEngine,
      connectionMode: 'offline',
      integration: nextIntegration,
      previewProvider: nextPreviewProvider,
      pixelStreamingUrl: '',
      remoteControlUrl: '',
      pixelRestApiReachable: false,
      pixelRestApiUrl: '',
      pixelStreamerConnected: false,
      pixelStreamerCount: 0,
      pixelPlayerCount: 0,
      controlObjectPath: '',
      controlCameraFunction: '',
      controlConfigured: false,
      controlConfigSource: '',
      controlSignalUrl: '',
    });
    if (options.emitError) {
      this.emit({ type: 'error', message });
    }
  }

  private async resolveGateway(engine: DccConnectionOptions['engine']): Promise<string> {
    const candidates = this.gatewayCandidates();
    for (const base of candidates) {
      try {
        const statusUrl = new URL('/api/dcc/status', base);
        statusUrl.searchParams.set('engine', engine);
        const response = await fetch(statusUrl.toString(), { cache: 'no-store' });
        if (!response.ok) continue;
        const data = await response.json();
        if (data?.success && data?.engines?.[engine]) {
          this.gatewayBaseUrl = base;
          return base;
        }
      } catch {
        /* try next gateway */
      }
    }
    return '';
  }

  private gatewayCandidates(): string[] {
    const envBase = typeof import.meta.env.VITE_HMDAO_API_BASE === 'string' ? import.meta.env.VITE_HMDAO_API_BASE.trim() : '';
    const current = window.location.origin;
    const loopback = ['http://127.0.0.1:8792', 'http://localhost:8792', 'http://127.0.0.1:8787', 'http://localhost:8787'];
    const currentIsViteDev = /\/\/(localhost|127\.0\.0\.1):3000$/i.test(current);
    const ordered = currentIsViteDev
      ? [envBase, ...loopback, current]
      : [envBase, current, ...loopback];
    return Array.from(new Set(ordered.filter(Boolean).map((item) => item.replace(/\/$/, ''))));
  }

  private wsUrlForGateway(base: string, engine: DccConnectionOptions['engine']): string {
    const url = new URL(base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    if (engine === 'unreal') {
      url.pathname = '/ws/dcc/unreal';
      url.search = '?role=browser';
    } else {
      url.pathname = '/ws/dcc-capture';
      url.search = `?engine=${encodeURIComponent(engine)}`;
    }
    return url.toString();
  }

  private async fetchRuntimeStatus(engine: DccConnectionOptions['engine']): Promise<DccGatewayRuntimeEngineStatus | null> {
    const gateway = this.gatewayBaseUrl || await this.resolveGateway(engine);
    if (!gateway) return null;
    try {
      const statusUrl = new URL('/api/dcc/status', gateway);
      statusUrl.searchParams.set('engine', engine);
      const response = await fetch(statusUrl.toString(), { cache: 'no-store' });
      if (!response.ok) return null;
      const data = await response.json().catch(() => null) as DccGatewayRuntimeStatusPayload | null;
      if (!data?.engines) return null;
      return engine === 'unreal'
        ? data.engines.unreal || null
        : data.engines.blender || null;
    } catch {
      return null;
    }
  }

  private isRuntimeReady(engine: DccConnectionOptions['engine'], status: DccGatewayRuntimeEngineStatus | null): boolean {
    if (!status) return false;
    if (engine === 'blender') return Boolean(status.reachable) && !isOutdatedBlenderRuntime(status);
    return Boolean(status.directBridgeReadyForTargetProject);
  }

  private runtimeUnavailableMessage(engine: DccConnectionOptions['engine'], status: DccGatewayRuntimeEngineStatus | null): string {
    if (engine === 'blender') {
      if (isOutdatedBlenderRuntime(status)) {
        return 'Blender 当前还在运行旧版 HMDao Blender Capture。请重启 Blender，或在 Add-ons 里禁用再启用一次 HMDao Blender Capture，让运行态切到最新版本后再重新 Connect 和 Record。';
      }
      return 'Blender 或 HMDao Blender Capture 服务已停止，节点已自动断开。请先打开 Blender，并在可见 UI 中启动 HMDao Capture Service 后再连接。';
    }
    if (!status?.pluginInstalled) {
      return 'HMDao Unreal Capture 还没有复制到当前 Unreal 引擎或工程，节点已自动断开。请先在 DCC 环境面板执行安装，再回到 Unreal 插件列表勾选启用。';
    }
    if (!status?.pluginEnabledInProject) {
      if (status.integration?.recommendedMode === 'official-sequencer-capture' && status.official?.capturePrerequisitesReady) {
        return '当前 Unreal 工程已经具备兼容模式离线输出前置项，但 DCC 节点的实时预览和镜头动画采集仍需要启用 HMDao Unreal Capture 直连插件。请在当前项目启用 HMDao Unreal Capture 并重启 Unreal 后再连接。';
      }
      return 'HMDao Unreal Capture 文件已存在，但当前 Unreal 工程还没有勾选启用，节点已自动断开。请在 Plugins 列表里启用插件并重启 Unreal。';
    }
    if (!status?.hostProcessRunning) {
      return 'Unreal 编辑器当前未启动，节点已自动断开。请先在 Epic Games Launcher 中选择对应版本并打开目标项目，进入可见主窗口后再连接。';
    }
    if (!status?.targetProjectRunning) {
      return 'Unreal 已启动，但 HMDao 还没有识别到可连接的编辑器会话，节点已自动断开。请确认可见主窗口已经完全打开，然后再点连接。';
    }
    if (!status.directBridgeOnline) {
      if (status.integration?.recommendedMode === 'official-sequencer-capture' && status.official?.capturePrerequisitesReady) {
        return status.official?.remoteControlReachable
          ? '当前 Unreal 工程已具备兼容模式离线输出条件，但 HMDao 直连预览桥还未上线。若要使用节点内实时预览与镜头动画采集，请等待 HMDao Unreal Capture 完成启动后再连接。'
          : '当前 Unreal 工程已具备兼容模式离线输出条件，但 HMDao 直连预览桥还未上线。DCC 默认链路仍以直连采集镜头信息为主；若要使用节点内实时预览与镜头动画采集，请先让 HMDao Unreal Capture 直连插件上线。';
      }
      return 'Unreal 已运行，但 HMDao Unreal Capture 直连桥接还未在线，节点已自动断开。请确认插件已启用并完成 StartupModule 初始化后再连接。';
    }
    return (status.cameraCount || 0) > 0
      ? 'Unreal 直连桥接已恢复，但节点还没拿到首帧预览，已自动断开一次。请再点一次连接，或先把关卡视口和当前镜头时间线切回前台。'
      : 'Unreal 已运行，但还没有可用摄像机或视口源，节点已自动断开。请确认场景里有可捕获视口/相机后再连接。';
  }

  private startFrameWatchdog(): void {
    this.stopFrameWatchdog();
    if (!this.isConnected()) return;
    this.frameWatchdog = window.setTimeout(() => {
      if (!this.options || this.snapshot.lastFrame) return;
      const message = this.snapshot.connectionMode === 'mock'
        ? '当前为本地测试预览，正在生成测试首帧；这不是 Blender/虚幻实际摄像机画面。'
        : '真实插件已连接，正在等待当前摄像机首帧画面。若长时间无画面，请检查插件是否正在推流。';
      this.update({ message, ...runtimeStagePatch(this.options.engine, 'frame', 'waiting') });
      if (this.options.engine === 'unreal' && this.snapshot.connectionMode === 'real') {
        this.requestPreviewFallbackFrame(
          this.snapshot.selectedCamera || this.options.cameraName || undefined,
          this.snapshot.selectedCameraId || this.options.cameraId || undefined,
        );
      } else if (this.options.engine === 'blender' && this.snapshot.connectionMode === 'real') {
        this.requestPreviewFallbackFrame(
          this.snapshot.selectedCamera || this.options.cameraName || undefined,
          this.snapshot.selectedCameraId || this.options.cameraId || undefined,
        );
      } else {
        this.startPreview(this.snapshot.selectedCamera || this.options.cameraName || undefined, this.snapshot.selectedCameraId || this.options.cameraId || undefined);
      }
    }, 1800);
  }

  private stopFrameWatchdog(): void {
    if (this.frameWatchdog) window.clearTimeout(this.frameWatchdog);
    this.frameWatchdog = 0;
  }

  private update(patch: Partial<DccConnectionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit({ type: 'state', snapshot: this.snapshot });
  }

  private emit(event: DccEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}














