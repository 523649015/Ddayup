// LEGACY NOTICE:
// Unreal 当前仍保留 Pixel Streaming 兼容链路，但主路线已经切换到
// Unreal Editor Direct WebSocket provider。完整设计见
// docs/Unreal-New-Integration-Design.md
export type DccEngine = 'blender' | 'unreal';

export type DccConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error';
export type DccCaptureStatus = 'idle' | 'capturing' | 'recording' | 'error';
export type DccConnectionMode = 'offline' | 'real' | 'mock';
export type DccFrameSource = 'plugin' | 'mock' | 'browser' | 'pixel-streaming' | 'editor-direct';
export type DccIntegrationMode = 'websocket' | 'editor-direct' | 'pixel-streaming';
export type DccPreviewProvider = 'websocket' | 'editor-direct' | 'ndi-bridge' | 'spout-bridge' | 'pixel-streaming-legacy';
export type DccRuntimeStage = 'host' | 'plugin' | 'bridge' | 'frame';
export type DccRuntimeStageState = 'idle' | 'waiting' | 'ready' | 'error';

const ENABLE_UNREAL_PIXEL_STREAMING_LEGACY = typeof import.meta !== 'undefined'
  && import.meta.env?.VITE_HMDAO_ENABLE_UNREAL_PIXEL_STREAMING_LEGACY === '1';

export interface DccResolution {
  label: string;
  width: number;
  height: number;
}

export interface DccCameraOption {
  name: string;
  id?: string;
  label?: string;
  active?: boolean;
  engine?: DccEngine;
}

export interface DccAnimationRange {
  startFrame: number;
  endFrame: number;
  currentFrame?: number;
  fps: number;
  /** Whether an active Level Sequence is currently open in the Sequencer. */
  hasSequence?: boolean;
  /** Whether at least one camera exists in the scene (so a shot can be captured). */
  hasCamera?: boolean;
}

export interface DccRecordingOptions {
  startFrame: number;
  endFrame: number;
  fps: number;
  width: number;
  height: number;
  cameraName?: string;
  cameraId?: string;
}

export interface DccEngineConfig {
  id: DccEngine;
  label: string;
  port: number;
  pluginName: string;
  setupSteps: string[];
  integration: DccIntegrationMode;
  previewProvider: DccPreviewProvider;
}

export interface DccConnectionOptions {
  engine: DccEngine;
  resolution: DccResolution;
  cameraName?: string;
  cameraId?: string;
  allowMockFallback?: boolean;
  previewProvider?: DccPreviewProvider;
  pixelStreamingUrl?: string;
  remoteControlUrl?: string;
  pixelRestApiReachable?: boolean;
  pixelRestApiUrl?: string;
  pixelStreamerConnected?: boolean;
  pixelStreamerCount?: number;
  pixelPlayerCount?: number;
  controlObjectPath?: string;
  controlCameraFunction?: string;
  controlConfigured?: boolean;
  controlConfigSource?: string;
  controlSignalUrl?: string;
}

export interface DccFrame {
  url: string;
  width: number;
  height: number;
  cameraName: string;
  source: DccFrameSource;
  receivedAt: number;
  latencyMs?: number;
}

export interface DccCaptureResult extends DccFrame {
  sizeBytes?: number;
  filePath?: string;
  durationMs?: number;
  mimeType?: string;
  managedUrl?: boolean;
  thumbnailUrl?: string;
  startFrame?: number;
  endFrame?: number;
  fps?: number;
}

export interface DccConnectionSnapshot {
  status: DccConnectionStatus;
  captureStatus: DccCaptureStatus;
  message: string;
  runtimeStage: DccRuntimeStage;
  runtimeStageState: DccRuntimeStageState;
  runtimeStageLabel: string;
  cameras: DccCameraOption[];
  selectedCamera: string;
  selectedCameraId?: string;
  animationRange: DccAnimationRange;
  lastFrame: DccFrame | null;
  fps: number;
  recordingLockedBy: DccEngine | null;
  connectionMode: DccConnectionMode;
  integration: DccIntegrationMode;
  previewProvider?: DccPreviewProvider;
  pixelStreamingUrl?: string;
  remoteControlUrl?: string;
  pixelRestApiReachable?: boolean;
  pixelRestApiUrl?: string;
  pixelStreamerConnected?: boolean;
  pixelStreamerCount?: number;
  pixelPlayerCount?: number;
  controlObjectPath?: string;
  controlCameraFunction?: string;
  controlConfigured?: boolean;
  controlConfigSource?: string;
  controlSignalUrl?: string;
}

export type DccEvent =
  | { type: 'state'; snapshot: DccConnectionSnapshot }
  | { type: 'frame'; frame: DccFrame }
  | { type: 'capture'; result: DccCaptureResult }
  | { type: 'recording'; result: DccCaptureResult }
  | { type: 'recording-stop'; message?: string }
  | { type: 'error'; message: string };

export type DccEventHandler = (event: DccEvent) => void;

export const DCC_ENGINES: DccEngineConfig[] = [
  {
    id: 'blender',
    label: 'Blender',
    port: 8766,
    pluginName: 'HMDao Blender Capture 插件',
    integration: 'websocket',
    previewProvider: 'websocket',
    setupSteps: [
      '在 Blender 中打开 编辑 > 偏好设置 > 插件，安装并启用 HMDao Blender Capture 插件。',
      '如需预览指定摄像机，请确认场景中至少存在一个 Camera，并先保存当前 Blender 工程。',
      '在插件侧栏中启动 HMDao Capture Service，确认本地 8766 端口已经监听。',
    ],
  },
  {
    id: 'unreal',
    label: '虚幻引擎',
    port: 8792,
    pluginName: 'HMDao Unreal Capture 插件',
    integration: 'editor-direct',
    previewProvider: 'editor-direct',
    setupSteps: [
      '在 Unreal Editor 中安装并启用 HMDao Unreal Capture 插件。',
      '保持“宿主先启动，再点击 Connect 按需激活”的流程，不再依赖 Standalone Game 或 Additional Launch Parameters。',
      '只有在兼容模式下明确需要旧链路时，才切换到 Pixel Streaming Legacy。',
    ],
  },
];

export const DEFAULT_UNREAL_PIXEL_STREAMING_URL = 'http://127.0.0.1:1025/player.html';
export const DEFAULT_UNREAL_REMOTE_CONTROL_URL = 'http://127.0.0.1:30010';

export const DCC_RESOLUTIONS: DccResolution[] = [
  { label: '1920 x 1080', width: 1920, height: 1080 },
  { label: '1280 x 720', width: 1280, height: 720 },
  { label: '1080 x 1920', width: 1080, height: 1920 },
  { label: '2048 x 2048', width: 2048, height: 2048 },
];

export const DEFAULT_DCC_ANIMATION_RANGE: DccAnimationRange = {
  startFrame: 1,
  endFrame: 120,
  currentFrame: 1,
  fps: 24,
  hasSequence: false,
  hasCamera: false,
};

export function getDccEngineConfig(engine: DccEngine): DccEngineConfig {
  return DCC_ENGINES.find((item) => item.id === engine) || DCC_ENGINES[0];
}

export function normalizeDccEngine(value: unknown): DccEngine {
  return value === 'unreal' ? 'unreal' : 'blender';
}

export function normalizePreviewProvider(value: unknown, fallback: DccPreviewProvider = 'websocket'): DccPreviewProvider {
  if (value === 'editor-direct' || value === 'ndi-bridge' || value === 'spout-bridge' || value === 'pixel-streaming-legacy') {
    return value;
  }
  return fallback;
}

export function isUnrealLegacyPreviewEnabled(): boolean {
  return ENABLE_UNREAL_PIXEL_STREAMING_LEGACY;
}

export function defaultDccPreviewProvider(engine: DccEngine): DccPreviewProvider {
  return engine === 'unreal' ? 'editor-direct' : 'websocket';
}

export function coerceDccPreviewProvider(engine: DccEngine, value: unknown): DccPreviewProvider {
  const normalized = normalizePreviewProvider(value, defaultDccPreviewProvider(engine));
  if (engine === 'unreal' && normalized === 'pixel-streaming-legacy' && !ENABLE_UNREAL_PIXEL_STREAMING_LEGACY) {
    return 'editor-direct';
  }
  return normalized;
}

export function normalizeDccResolution(value: unknown): DccResolution {
  if (value && typeof value === 'object') {
    const raw = value as Partial<DccResolution>;
    const width = Number(raw.width);
    const height = Number(raw.height);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { label: raw.label || `${width} x ${height}`, width, height };
    }
  }
  return DCC_RESOLUTIONS[0];
}
