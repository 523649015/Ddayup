import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  Box,
  Camera,
  Download,
  Gamepad2,
  Loader2,
  MonitorUp,
  Pause,
  Play,
  Plug,
  Radio,
  RefreshCcw,
  ScanLine,
  Square,
  Unplug,
  Video,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import type { AssetItem } from '@/types/assets';
import { useCanvasStore } from '@/store/useCanvasStore';
import { useAssetStore } from '@/store/useAssetStore';
import {
  extractPersistedAssetIdFromUrl,
  importLocalAssetFile,
  importReferencedLocalAsset,
  resolvePersistedAssetLibraryUrl,
} from '@/api/assetLibrary';
import { dccGatewayFetch } from '@/api/dccGateway';
import { runDccPluginManagerAction } from '@/api/dccPluginManager';
import {
  ensureLocalMediaUrl,
  isLocalMediaHandle,
  isTransientBlobUrl,
  readLocalMediaBlob,
  registerLocalMediaPersisted,
  resolveLocalMediaUrl,
} from '@/services/localMediaRegistry';
import { toRenderableAssetUrl } from '@/services/generation';
import { DccConnectionManager } from '@/services/dcc/connection';
import { DccPreviewRenderer } from '@/services/dcc/previewRenderer';
import { DccRecorder, type DccRecordingResult } from '@/services/dcc/recorder';
import { sanitizeDccVisibleText, summarizeDccSnapshot } from '@/services/dcc/runtimeState';
import { patchDebugBridge, readDebugBridge } from '@/services/debugBridge';
import {
  DCC_ENGINES,
  DCC_RESOLUTIONS,
  DEFAULT_DCC_ANIMATION_RANGE,
  type DccCameraOption,
  type DccCaptureResult,
  type DccConnectionOptions,
  type DccConnectionSnapshot,
  type DccEngine,
  type DccEvent,
  type DccFrame,
  type DccFrameSource,
  type DccResolution,
  defaultDccPreviewProvider,
  getDccEngineConfig,
  normalizeDccEngine,
  normalizeDccResolution,
} from '@/services/dcc/types';
import { useGuardedFloatingPanelInteraction } from '@/hooks/useGuardedFloatingPanelInteraction';
import { EditableNodeTitle } from './EditableNodeTitle';

const ENGINE_ICONS: Record<DccEngine, typeof Box> = {
  blender: Box,
  unreal: Gamepad2,
};

const DCC_ASSET_FOLDER_ID = 'dcc';
const DCC_ENVIRONMENT_MONITOR_EVENT = 'hmdao:dcc-environment-monitor';
const MAX_DCC_RECORD_FPS = 240;

const DCC_VIDEO_OUTPUT_OPTIONS = [
  { value: '480p', label: '480p' },
  { value: '720p', label: '720p' },
  { value: '1080p', label: '1080p' },
  { value: '1440p', label: '1440p' },
] as const;

const DCC_NODE_ENGINE_LABELS: Record<DccEngine, string> = {
  blender: 'Blender',
  unreal: 'Unreal Engine',
};

const DCC_NODE_PLUGIN_LABELS: Record<DccEngine, string> = {
  blender: 'HMDao Blender Capture',
  unreal: 'HMDao Unreal Capture',
};

const UNREAL_PROJECT_REQUIRED_NOTICE_KEY = 'unreal-project-required';
const UNREAL_PROJECT_REQUIRED_NOTICE_MESSAGE = '\u5148\u8981\u6253\u5f00\u865a\u5e7b\u9879\u76ee\u624d\u80fd\u8fde\u63a5\u3002';
const UNREAL_PROJECT_REQUIRED_NOTICE_DETAIL = '\u8bf7\u5148\u7528\u5f53\u524d\u9009\u4e2d\u7684 .uproject \u6b63\u5e38\u6253\u5f00 Unreal \u7f16\u8f91\u5668\uff0c\u786e\u8ba4\u9879\u76ee\u7a97\u53e3\u548c\u5173\u5361\u89c6\u53e3\u5df2\u52a0\u8f7d\u5b8c\u6210\uff0c\u7136\u540e\u56de\u5230 DCC \u8282\u70b9\u518d\u70b9 Connect\u3002';

type DccVideoOutputQuality = (typeof DCC_VIDEO_OUTPUT_OPTIONS)[number]['value'];

const DEFAULT_SNAPSHOT: DccConnectionSnapshot = {
  status: 'idle',
  captureStatus: 'idle',
  message: 'Connect the DCC plugin to start live preview. Unreal requires HMDao Unreal Capture.',
  runtimeStage: 'host',
  runtimeStageState: 'idle',
  runtimeStageLabel: '\u7b49\u5f85\u5bbf\u4e3b\u542f\u52a8',
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

function asPositiveInt(value: unknown, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) ? Math.max(0, Math.round(num)) : fallback;
}

function normalizeDccVideoOutputQuality(value: unknown): DccVideoOutputQuality {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === '720p') return '720p';
  if (normalized === '1080p') return '1080p';
  if (normalized === '1440p') return '1440p';
  return '480p';
}

function dccVideoResolutionForQuality(quality: DccVideoOutputQuality) {
  if (quality === '1440p') return { width: 2560, height: 1440, label: '2560x1440', aspectRatio: '16:9' as const };
  if (quality === '1080p') return { width: 1920, height: 1080, label: '1920x1080', aspectRatio: '16:9' as const };
  if (quality === '720p') return { width: 1280, height: 720, label: '1280x720', aspectRatio: '16:9' as const };
  return { width: 854, height: 480, label: '854x480', aspectRatio: '16:9' as const };
}

function dccVideoQualityIntentLabel(quality: DccVideoOutputQuality): string {
  if (quality === '1440p') return '1440p';
  if (quality === '1080p') return '1080p';
  if (quality === '720p') return '720p';
  return '480p';
}

function clampResolutionInput(value: unknown, fallback: number): number {
  const next = Number(value);
  return Number.isFinite(next) ? Math.max(256, Math.min(4096, Math.round(next))) : fallback;
}

function getPreviewShellWidth(resolution: DccResolution) {
  const ratio = resolution.height > 0 ? resolution.width / resolution.height : 16 / 9;
  if (ratio >= 1.2) return 535;
  if (ratio >= 0.9) return 430;
  return 320;
}

function stopPointerPropagation(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element
    && Boolean(target.closest('button, input, select, textarea, label, [data-dcc-interactive="true"]'));
}

function isSameResolution(left: DccResolution, right: DccResolution): boolean {
  return left.width === right.width && left.height === right.height && left.label === right.label;
}

type PersistedDccMedia = {
  url: string;
  thumbnailUrl: string;
  assetLibraryUrl?: string;
  assetId?: string;
  persistedAssetId?: string;
  managedUrl: boolean;
  originalUrl: string;
  sourceUrl: string;
  filePath?: string;
  persistedItem?: AssetItem;
};

function fileExtensionFromMimeType(mimeType: string, fallback: string): string {
  const normalized = String(mimeType || '').trim().toLowerCase();
  if (normalized.includes('png')) return 'png';
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('gif')) return 'gif';
  if (normalized.includes('mp4')) return 'mp4';
  if (normalized.includes('quicktime') || normalized.includes('mov')) return 'mov';
  if (normalized.includes('webm')) return 'webm';
  return fallback;
}

function isPersistedAssetLibraryUrl(url: string): boolean {
  const normalized = String(url || '').trim();
  return normalized.startsWith('/api/assets/content/') || normalized.includes('/api/assets/content/');
}

function shouldSkipAssetLibraryInsertion(assetStoreSynchronized: boolean | undefined, assetUrl: string) {
  return Boolean(assetStoreSynchronized) || isPersistedAssetLibraryUrl(assetUrl);
}

function normalizePersistedAssetId(value: unknown, url?: string) {
  const explicit = typeof value === 'string' ? value.trim() : '';
  if (explicit) return explicit;
  return extractPersistedAssetIdFromUrl(url);
}

function resolvePreferredDccMediaUrl(
  kind: 'image' | 'video',
  options: {
    url?: string;
    filePath?: string;
    persistedAssetId?: string;
    assetLibraryUrl?: string;
  },
) {
  const rawUrl = typeof options.url === 'string' ? options.url.trim() : '';
  const filePath = typeof options.filePath === 'string' ? options.filePath.trim() : '';
  const persistedUrl = String(
    options.assetLibraryUrl
    || resolvePersistedAssetLibraryUrl(rawUrl, options.persistedAssetId)
    || '',
  ).trim();
  const renderableRawUrl = rawUrl ? toRenderableAssetUrl(rawUrl, kind) : '';
  const renderableFileUrl = filePath ? toRenderableAssetUrl(filePath, kind) : '';
  if (kind === 'video') {
    // Prefer a directly streamable file/proxy URL for DCC recordings so node playback
    // does not depend on the asset-library catalog route resolving immediately.
    return renderableFileUrl || renderableRawUrl || persistedUrl || rawUrl;
  }
  return persistedUrl || renderableFileUrl || renderableRawUrl || rawUrl;
}

function dccAssetEngineTag(engine: DccEngine): string {
  return engine === 'blender' ? 'Blender' : 'Unreal';
}

function dccAssetTags(engine: DccEngine, kind: 'capture' | 'recording' | 'thumbnail'): string[] {
  return [
    'DCC',
    dccAssetEngineTag(engine),
    kind === 'capture' ? '\u622a\u56fe' : kind === 'recording' ? '\u5f55\u5236' : '\u9996\u5e27',
  ];
}

function dccAssetSmartCategories(kind: 'capture' | 'recording' | 'thumbnail'): string[] {
  return [
    'DCC\u6355\u83b7',
    kind === 'capture' ? 'DCC\u622a\u56fe' : kind === 'recording' ? 'DCC\u5f55\u5236' : 'DCC\u9996\u5e27',
  ];
}

function notifyDccEnvironmentMonitor(reason: 'connect' | 'failure', engine: DccEngine) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent(DCC_ENVIRONMENT_MONITOR_EVENT, {
    detail: { engine, reason },
  }));
}

function getVisibleEngineLabel(engine: DccEngine, candidate?: string) {
  return sanitizeDccVisibleText(candidate, DCC_NODE_ENGINE_LABELS[engine]);
}

function getVisiblePluginLabel(engine: DccEngine, candidate?: string) {
  return sanitizeDccVisibleText(candidate, DCC_NODE_PLUGIN_LABELS[engine]);
}

function getDisconnectedGuideMessage(engine: DccEngine, candidate?: string) {
  const fallback = engine === 'unreal'
    ? '\u8bf7\u5148\u6b63\u5e38\u6253\u5f00 Unreal Editor \u548c\u9009\u4e2d\u7684\u9879\u76ee\uff0c\u7136\u540e\u518d\u56de\u5230 DCC \u8282\u70b9\u70b9\u51fb Connect\u3002'
    : '\u8bf7\u5148\u6b63\u5e38\u6253\u5f00 Blender \u4e3b\u7a97\u53e3\uff0c\u7136\u540e\u518d\u56de\u5230 DCC \u8282\u70b9\u70b9\u51fb Connect\u3002';
  return sanitizeDccVisibleText(candidate, fallback);
}
function dccNodeFailureRecoveryHint(engine: DccEngine, kind: 'connect' | 'capture' | 'recording' | 'save') {
  if (engine === 'unreal') {
    if (kind === 'connect') {
      return '\u6253\u5f00 DCC \u73af\u5883\u7ba1\u7406\u5668\uff0c\u5148\u770b\u542f\u52a8\u8bca\u65ad\uff1b\u901a\u5e38\u5148 Quick Check\uff0c\u518d\u6309\u63d0\u793a Open Project / Cleanup / Connect\u3002';
    }
    if (kind === 'capture') {
      return '\u6253\u5f00 DCC \u73af\u5883\u7ba1\u7406\u5668\uff0c\u786e\u8ba4\u5de5\u7a0b\u5df2\u5c31\u7eea\u3001\u6865\u63a5\u5df2\u4e0a\u7ebf\u4e14\u76f8\u673a\u5217\u8868\u53ef\u89c1\u540e\uff0c\u518d\u91cd\u8bd5\u622a\u56fe\u3002';
    }
    return '\u6253\u5f00 DCC \u73af\u5883\u7ba1\u7406\u5668\uff0c\u5148\u505a Quick Check\uff1b\u5982\u4ecd\u5931\u8d25\uff0c\u518d Cleanup \u5e76\u91cd\u65b0 Connect \u540e\u91cd\u8bd5\u5f55\u5236\u6216\u4fdd\u5b58\u3002';
  }
  if (kind === 'connect') {
    return '\u6253\u5f00 DCC \u73af\u5883\u7ba1\u7406\u5668\uff0c\u5148\u6e05\u7406\u540e\u53f0\u6b8b\u7559\uff0c\u518d\u786e\u8ba4\u53ef\u89c1 Blender \u4f1a\u8bdd\u5df2\u52a0\u8f7d HMDao Blender Capture \u540e\u91cd\u65b0 Connect\u3002';
  }
  if (kind === 'capture') {
    return '\u6253\u5f00 DCC \u73af\u5883\u7ba1\u7406\u5668\uff0c\u786e\u8ba4 8766 \u670d\u52a1\u6765\u81ea\u53ef\u89c1 Blender \u4f1a\u8bdd\u540e\uff0c\u518d\u91cd\u8bd5\u622a\u56fe\u3002';
  }
  return '\u6253\u5f00 DCC \u73af\u5883\u7ba1\u7406\u5668\uff0c\u786e\u8ba4\u63d2\u4ef6\u5df2\u6302\u8fdb\u53ef\u89c1 Blender \u4f1a\u8bdd\u4e14 8766 \u5df2\u5c31\u7eea\u540e\uff0c\u518d\u91cd\u8bd5\u5f55\u5236\u6216\u4fdd\u5b58\u3002';
}

function buildDccNodeFailureMessage(engine: DccEngine, message: string, kind: 'connect' | 'capture' | 'recording' | 'save') {
  const fallback = engine === 'unreal'
    ? 'Unreal \u64cd\u4f5c\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5 HMDao Unreal Capture \u3001\u76ee\u6807\u5de5\u7a0b\u548c\u73af\u5883\u7ba1\u7406\u5668\u8bca\u65ad\u3002'
    : 'Blender \u64cd\u4f5c\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5 HMDao Blender Capture \u3001\u53ef\u89c1\u4f1a\u8bdd\u548c 8766 \u670d\u52a1\u3002';
  const safeMessage = sanitizeDccVisibleText(message, fallback);
  if (/DCC \u73af\u5883\u7ba1\u7406\u5668/.test(safeMessage)) {
    return safeMessage;
  }
  return `${safeMessage} ${dccNodeFailureRecoveryHint(engine, kind)}`.trim();
}

function resolveDccBlockingNotice(engine: DccEngine, message: string) {
  if (engine !== 'unreal') return null;
  if (!message.includes(UNREAL_PROJECT_REQUIRED_NOTICE_DETAIL)) return null;
  return {
    key: UNREAL_PROJECT_REQUIRED_NOTICE_KEY,
    message: UNREAL_PROJECT_REQUIRED_NOTICE_MESSAGE,
    detail: UNREAL_PROJECT_REQUIRED_NOTICE_DETAIL,
  };
}

async function readDccMediaBlob(url: string): Promise<Blob> {
  if (isLocalMediaHandle(url)) {
    const cachedBlob = readLocalMediaBlob(url);
    if (cachedBlob) return cachedBlob;
    const resolvedUrl = await ensureLocalMediaUrl(url);
    if (!resolvedUrl) {
      throw new Error('Failed to resolve the local DCC media handle.');
    }
    const response = await fetch(resolvedUrl);
    if (!response.ok) {
      throw new Error(`Failed to read local DCC media: HTTP ${response.status}`);
    }
    return await response.blob();
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to read DCC media: HTTP ${response.status}`);
  }
  return await response.blob();
}

async function persistDccCaptureAsset(
  result: DccCaptureResult,
  options: {
    type: 'image' | 'video';
    fileName: string;
    fallbackMimeType: string;
    duration?: number;
    folderId?: string;
    tags?: string[];
    smartCategories?: string[];
  },
): Promise<PersistedDccMedia> {
  const originalUrl = String(result.url || '').trim();
  const normalizedFilePath = typeof result.filePath === 'string' ? result.filePath.trim() : '';
  if (!originalUrl) {
    throw new Error('DCC result url is required.');
  }
  if (isPersistedAssetLibraryUrl(originalUrl)) {
    const persistedAssetId = normalizePersistedAssetId(undefined, originalUrl);
    return {
      url: originalUrl,
      thumbnailUrl: originalUrl,
      assetId: persistedAssetId || undefined,
      persistedAssetId: persistedAssetId || undefined,
      managedUrl: true,
      originalUrl,
      sourceUrl: normalizedFilePath || originalUrl,
      filePath: normalizedFilePath || undefined,
    };
  }

  try {
    if (normalizedFilePath && !isLocalMediaHandle(normalizedFilePath) && !isTransientBlobUrl(normalizedFilePath)) {
      const persistedImport = await importReferencedLocalAsset(normalizedFilePath, {
        name: options.fileName,
        type: options.type,
        folderId: options.folderId || DCC_ASSET_FOLDER_ID,
        tags: options.tags,
        smartCategories: options.smartCategories,
        width: result.width,
        height: result.height,
        duration: options.duration,
        sourceUrl: originalUrl || normalizedFilePath,
      });
      return {
        url: persistedImport.item.url,
        thumbnailUrl: persistedImport.item.thumbnail || persistedImport.item.url,
        assetLibraryUrl: persistedImport.item.url,
        assetId: persistedImport.item.id,
        persistedAssetId: normalizePersistedAssetId(
          persistedImport.item.backendAssetId || persistedImport.item.id,
          persistedImport.item.url,
        ) || undefined,
        managedUrl: true,
        originalUrl,
        sourceUrl: normalizedFilePath,
        filePath: normalizedFilePath,
        persistedItem: persistedImport.item,
      };
    }

    const blob = await readDccMediaBlob(originalUrl);
    const mimeType = String(result.mimeType || blob.type || options.fallbackMimeType || '').trim() || options.fallbackMimeType;
    const persistedImport = await importLocalAssetFile(
      new File([blob], options.fileName, { type: mimeType }),
      {
        folderId: options.folderId || DCC_ASSET_FOLDER_ID,
        tags: options.tags,
        smartCategories: options.smartCategories,
        width: result.width,
        height: result.height,
        duration: options.duration,
        sourceUrl: originalUrl,
      },
    );
    return {
      url: persistedImport.item.url,
      thumbnailUrl: persistedImport.item.thumbnail || persistedImport.item.url,
      assetLibraryUrl: persistedImport.item.url,
      assetId: persistedImport.item.id,
      persistedAssetId: normalizePersistedAssetId(
        persistedImport.item.backendAssetId || persistedImport.item.id,
        persistedImport.item.url,
      ) || undefined,
      managedUrl: true,
      originalUrl,
      sourceUrl: originalUrl,
      filePath: normalizedFilePath || undefined,
      persistedItem: persistedImport.item,
    };
  } catch {
    if (isTransientBlobUrl(originalUrl)) {
      const localHandle = await registerLocalMediaPersisted(await readDccMediaBlob(originalUrl));
      return {
        url: localHandle,
        thumbnailUrl: localHandle,
        managedUrl: true,
        originalUrl,
        sourceUrl: originalUrl,
        filePath: normalizedFilePath || undefined,
      };
    }
    return {
      url: originalUrl,
      thumbnailUrl: originalUrl,
      managedUrl: Boolean(result.managedUrl) || isLocalMediaHandle(originalUrl),
      originalUrl,
      sourceUrl: normalizedFilePath || originalUrl,
      filePath: normalizedFilePath || undefined,
    };
  } finally {
    if (isTransientBlobUrl(originalUrl)) {
      URL.revokeObjectURL(originalUrl);
    }
  }
}

export function DCCCaptureNode({ selected, data, id }: NodeProps) {
  const nodeTestId = `dcc-node-${id}`;
  const addConnectedNode = useCanvasStore((state) => state.addConnectedNode);
  const getNodeById = useCanvasStore((state) => state.getNodeById);
  const selectedNodeIds = useCanvasStore((state) => state.selectedNodeIds);
  const setSelectedNodeIds = useCanvasStore((state) => state.setSelectedNodeIds);
  const activeSidebarTab = useCanvasStore((state) => state.activeSidebarTab);
  const sidebarCollapsed = useCanvasStore((state) => state.sidebarCollapsed);
  const setSidebarTab = useCanvasStore((state) => state.setSidebarTab);
  const toggleSidebar = useCanvasStore((state) => state.toggleSidebar);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const addAssetItem = useAssetStore((state) => state.addItem);
  const syncPersistedItems = useAssetStore((state) => state.syncPersistedItems);
  const {
    markInteraction: markDccPanelInteraction,
    stopInteraction: stopDccPanelInteraction,
    panelInteractionProps: dccPanelInteractionProps,
  } = useGuardedFloatingPanelInteraction(id);

  const params = (data?.params && typeof data.params === 'object' ? data.params : {}) as Record<string, unknown>;
  const [engine, setEngine] = useState<DccEngine>(normalizeDccEngine(params.engine || 'unreal'));
  const [resolution, setResolution] = useState<DccResolution>(normalizeDccResolution(params.resolution));
  const [snapshot, setSnapshot] = useState<DccConnectionSnapshot>(DEFAULT_SNAPSHOT);
  const [startFrame, setStartFrame] = useState(() => asPositiveInt(params.startFrame, DEFAULT_DCC_ANIMATION_RANGE.startFrame));
  const [endFrame, setEndFrame] = useState(() => asPositiveInt(params.endFrame, DEFAULT_DCC_ANIMATION_RANGE.endFrame));
  const [recordFps, setRecordFps] = useState(() => asPositiveInt(params.recordFps, DEFAULT_DCC_ANIMATION_RANGE.fps));
  const [videoOutputQuality, setVideoOutputQuality] = useState<DccVideoOutputQuality>(() => normalizeDccVideoOutputQuality(params.videoOutputQuality || params.quality || '480p'));
  const [customWidth, setCustomWidth] = useState(() => String(asPositiveInt((params.resolution as { width?: number } | undefined)?.width, resolution.width)));
  const [customHeight, setCustomHeight] = useState(() => String(asPositiveInt((params.resolution as { height?: number } | undefined)?.height, resolution.height)));
  const [captureUrl, setCaptureUrl] = useState(String(params.captureUrl || data?.imageUrl || ''));
  const [recordingUrl, setRecordingUrl] = useState(String(params.recordingUrl || data?.videoUrl || ''));
  const [previewPaused, setPreviewPaused] = useState(false);
  const [isDocumentHidden, setIsDocumentHidden] = useState(() => (typeof document !== 'undefined' ? document.hidden : false));
  const [nodeNotice, setNodeNotice] = useState<{ key: string; message: string; detail?: string } | null>(null);
  const [dismissedNodeNoticeKey, setDismissedNodeNoticeKey] = useState('');

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<DccPreviewRenderer | null>(null);
  const connectionRef = useRef<DccConnectionManager | null>(null);
  const recorderRef = useRef<DccRecorder | null>(null);
  const recordingStopTimerRef = useRef<number | null>(null);
  const selectionSyncTimersRef = useRef<number[]>([]);
  const recordingSourceRef = useRef<DccFrameSource>('browser');
  const lastRecordingRequestRef = useRef<{ startFrame: number; endFrame: number; fps: number } | null>(null);
  const lastSavedRecordingKeyRef = useRef('');
  const handleDccEventRef = useRef<(event: DccEvent) => void>(() => {});
  const browserRecordingFinalizingRef = useRef(false);
  const autoPausedRef = useRef(false);
  const resultPreviewFreezeTimerRef = useRef<number | null>(null);
  const hasManualRecordingRangeRef = useRef(
    params.startFrame !== undefined ||
    params.endFrame !== undefined ||
    params.recordFps !== undefined,
  );
  const manualFpsRef = useRef(false);
  const pendingControlStateRef = useRef<Partial<{
    engine: DccEngine;
    resolution: DccResolution;
    startFrame: number;
    endFrame: number;
    recordFps: number;
    videoOutputQuality: DccVideoOutputQuality;
  }>>({});
  const latestRef = useRef({ engine, resolution, selectedCamera: '', selectedCameraId: '', params, startFrame, endFrame, recordFps, videoOutputQuality });

  const engineConfig = getDccEngineConfig(engine);
  const visibleEngineLabel = getVisibleEngineLabel(engine, engineConfig.label);
  const EngineIcon = ENGINE_ICONS[engine];
  const connected = snapshot.status === 'connected';
  const connecting = snapshot.status === 'connecting';
  const capturing = snapshot.captureStatus === 'capturing';
  const recording = snapshot.captureStatus === 'recording';
  const useHostManagedRecording = engine === 'unreal' || (engine === 'blender' && snapshot.connectionMode === 'real');
  const isNodeSelected = selected || selectedNodeIds.includes(id);
  const isNodeExclusivelySelected = (selectedNodeIds.length === 1 && selectedNodeIds[0] === id) || (selected && selectedNodeIds.length <= 1);
  const persistedEngine = normalizeDccEngine(params.engine || engine);
  const selectedCamera = snapshot.selectedCamera || (persistedEngine === engine ? String(params.selectedCamera || '') : '');
  const selectedCameraId = snapshot.selectedCameraId || (persistedEngine === engine ? String(params.selectedCameraId || '') : '');
  const cameras = snapshot.cameras.length ? snapshot.cameras : [{ id: selectedCameraId || undefined, name: selectedCamera || 'Viewport' }];
  const cameraOptions = cameras.map((camera, index) => ({
    value: camera.id || camera.name,
    label: sanitizeDccVisibleText(camera.label || camera.name, camera.id ? `Camera ${index + 1}` : '\u89c6\u53e3'),
  }));
  const runtimePresentation = summarizeDccSnapshot(engine, snapshot);
  const visibleSelectedCamera = sanitizeDccVisibleText(selectedCamera || cameraOptions[0]?.label || '\u89c6\u53e3', '\u89c6\u53e3');
  const visibleStatusMessage = runtimePresentation.message;
  const activeNodeNotice = nodeNotice && nodeNotice.key !== dismissedNodeNoticeKey ? nodeNotice : null;
  const previewShellWidth = getPreviewShellWidth(resolution);
  const previewFrameStyle: CSSProperties = { aspectRatio: `${resolution.width} / ${resolution.height}` };
  const previewShellStyle: CSSProperties = { width: `${previewShellWidth}px` };
  const floatingPanelStyle: CSSProperties = {
    width: `${previewShellWidth}px`,
    maxWidth: 'calc(100vw - 48px)',
  };

  latestRef.current = { engine, resolution, selectedCamera, selectedCameraId, params, startFrame, endFrame, recordFps, videoOutputQuality };
  handleDccEventRef.current = handleDccEvent;

  useEffect(() => {
    const currentBridge = readDebugBridge();
    const currentRuntimeState = currentBridge.dccNodeRuntimeState && typeof currentBridge.dccNodeRuntimeState === 'object'
      ? currentBridge.dccNodeRuntimeState as Record<string, unknown>
      : {};
    patchDebugBridge({
      dccNodeRuntimeState: {
        ...currentRuntimeState,
        [id]: {
          engine,
          connected,
          recording,
          previewPaused,
          snapshotStatus: snapshot.status,
          snapshotCaptureStatus: snapshot.captureStatus,
          connectionMode: snapshot.connectionMode,
          selectedCamera,
          selectedCameraId,
          startFrame,
          endFrame,
          recordFps,
          resolution,
          videoOutputQuality,
        },
      },
    });
  }, [
    connected,
    endFrame,
    engine,
    id,
    previewPaused,
    recordFps,
    recording,
    resolution,
    selectedCamera,
    selectedCameraId,
    snapshot.captureStatus,
    snapshot.connectionMode,
    snapshot.status,
    startFrame,
    videoOutputQuality,
  ]);

  useEffect(() => {
    const pending = pendingControlStateRef.current;
    const nextEngine = normalizeDccEngine(params.engine || 'unreal');
    if (pending.engine) {
      if (nextEngine === pending.engine) {
        delete pending.engine;
      } else if (engine !== pending.engine && nextEngine !== engine) {
        setEngine(nextEngine);
      }
    } else if (nextEngine !== engine) {
      setEngine(nextEngine);
    }

    const nextResolution = normalizeDccResolution(params.resolution);
    if (pending.resolution) {
      if (isSameResolution(nextResolution, pending.resolution)) {
        delete pending.resolution;
      } else if (!isSameResolution(resolution, pending.resolution) && !isSameResolution(nextResolution, resolution)) {
        setResolution(nextResolution);
        setCustomWidth(String(nextResolution.width));
        setCustomHeight(String(nextResolution.height));
      }
    } else if (!isSameResolution(nextResolution, resolution)) {
      setResolution(nextResolution);
      setCustomWidth(String(nextResolution.width));
      setCustomHeight(String(nextResolution.height));
    }

    const nextStartFrame = asPositiveInt(params.startFrame, DEFAULT_DCC_ANIMATION_RANGE.startFrame);
    if (pending.startFrame !== undefined) {
      if (nextStartFrame === pending.startFrame) {
        delete pending.startFrame;
      } else if (startFrame !== pending.startFrame && nextStartFrame !== startFrame) {
        setStartFrame(nextStartFrame);
      }
    } else if (nextStartFrame !== startFrame) {
      setStartFrame(nextStartFrame);
    }

    const nextEndFrame = asPositiveInt(params.endFrame, DEFAULT_DCC_ANIMATION_RANGE.endFrame);
    if (pending.endFrame !== undefined) {
      if (nextEndFrame === pending.endFrame) {
        delete pending.endFrame;
      } else if (endFrame !== pending.endFrame && nextEndFrame !== endFrame) {
        setEndFrame(nextEndFrame);
      }
    } else if (nextEndFrame !== endFrame) {
      setEndFrame(nextEndFrame);
    }

    const nextRecordFps = asPositiveInt(params.recordFps, DEFAULT_DCC_ANIMATION_RANGE.fps);
    if (pending.recordFps !== undefined) {
      if (nextRecordFps === pending.recordFps) {
        delete pending.recordFps;
      } else if (recordFps !== pending.recordFps && nextRecordFps !== recordFps) {
        setRecordFps(nextRecordFps);
      }
    } else if (nextRecordFps !== recordFps) {
      setRecordFps(nextRecordFps);
    }

    const nextVideoOutputQuality = normalizeDccVideoOutputQuality(params.videoOutputQuality || params.quality || '480p');
    if (pending.videoOutputQuality) {
      if (nextVideoOutputQuality === pending.videoOutputQuality) {
        delete pending.videoOutputQuality;
      } else if (videoOutputQuality !== pending.videoOutputQuality && nextVideoOutputQuality !== videoOutputQuality) {
        setVideoOutputQuality(nextVideoOutputQuality);
      }
    } else if (nextVideoOutputQuality !== videoOutputQuality) {
      setVideoOutputQuality(nextVideoOutputQuality);
    }
  }, [endFrame, engine, params, recordFps, resolution, startFrame, videoOutputQuality]);

  // Keep the frame-rate input aligned with the connected sequence's real display rate
  // unless the user has manually chosen a different rate. This prevents the recorder from
  // silently downsampling the frame range when the default 24fps differs from the sequence rate.
  // We skip the sync while the user is actively typing in the fps box (or has typed a custom
  // value) so the streaming display-rate updates never steal focus / close the panel mid-edit.
  useEffect(() => {
    if (manualFpsRef.current) return;
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    if (active && active.getAttribute && active.getAttribute('data-testid') === `dcc-fps-${id}`) {
      return;
    }
    const displayFps = Number.isFinite(snapshot.animationRange.fps)
      ? Math.min(MAX_DCC_RECORD_FPS, Math.max(1, Math.round(Number(snapshot.animationRange.fps))))
      : 0;
    if (displayFps >= 1 && displayFps !== recordFps) {
      setRecordFps(displayFps);
      // Persist so the params-driven reconcile effect converges instead of
      // restoring the old saved fps every render (which would fight this effect
      // and cause an infinite render loop / "Maximum update depth").
      persist({ recordFps: displayFps });
    }
  }, [snapshot.animationRange.fps, recordFps, id]);

  useEffect(() => {
    if (!canvasRef.current) return;
    const renderer = new DccPreviewRenderer(canvasRef.current);
    rendererRef.current = renderer;
    renderer.start();
    return () => {
      renderer.stop();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    const manager = new DccConnectionManager();
    const recorder = new DccRecorder();
    connectionRef.current = manager;
    recorderRef.current = recorder;
    const unsubscribe = manager.subscribe((event) => handleDccEventRef.current(event));
    return () => {
      unsubscribe();
      if (recordingStopTimerRef.current) window.clearTimeout(recordingStopTimerRef.current);
      if (resultPreviewFreezeTimerRef.current) {
        window.clearTimeout(resultPreviewFreezeTimerRef.current);
        resultPreviewFreezeTimerRef.current = null;
      }
      if (selectionSyncTimersRef.current.length > 0) {
        selectionSyncTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
        selectionSyncTimersRef.current = [];
      }
      manager.disconnect(false);
      recorder.dispose();
      connectionRef.current = null;
      recorderRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const handleVisibilityChange = () => setIsDocumentHidden(document.hidden);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  useEffect(() => {
    const manager = connectionRef.current;
    const renderer = rendererRef.current;
    if (!manager || !renderer || !connected || recording) {
      if (!isDocumentHidden) {
        autoPausedRef.current = false;
      }
      return;
    }
    if (isDocumentHidden) {
      if (!previewPaused) {
        autoPausedRef.current = true;
        setPreviewPaused(true);
        manager.pausePreview();
        renderer.pause();
      }
      return;
    }
    if (autoPausedRef.current && previewPaused) {
      autoPausedRef.current = false;
      setPreviewPaused(false);
      renderer.resume();
      manager.resumePreview();
    }
  }, [connected, isDocumentHidden, previewPaused, recording]);

  function persist(partial: Record<string, unknown>, nextEngine = engine) {
    const pending = pendingControlStateRef.current;
    pending.engine = nextEngine;
    if (partial.resolution) {
      pending.resolution = normalizeDccResolution(partial.resolution);
    }
    if (partial.startFrame !== undefined) {
      pending.startFrame = asPositiveInt(partial.startFrame, startFrame);
    }
    if (partial.endFrame !== undefined) {
      pending.endFrame = asPositiveInt(partial.endFrame, endFrame);
    }
    if (partial.recordFps !== undefined) {
      pending.recordFps = asPositiveInt(partial.recordFps, recordFps);
    }
    if (partial.videoOutputQuality !== undefined || partial.quality !== undefined) {
      pending.videoOutputQuality = normalizeDccVideoOutputQuality(partial.videoOutputQuality || partial.quality || videoOutputQuality);
    }
    updateNodeData(id, {
      provider: 'dcc',
      model: nextEngine,
      params: {
        ...params,
        engine: nextEngine,
        selectedCamera,
        selectedCameraId,
        resolution,
        startFrame,
        endFrame,
        recordFps,
        videoOutputQuality,
        ...partial,
      },
    });
  }

  function applyNodeFailure(
    kind: 'connect' | 'capture' | 'recording' | 'save',
    error: unknown,
    options: { preserveConnection?: boolean; clearPreview?: boolean } = {},
  ) {
    const currentEngine = latestRef.current.engine;
    const rawMessage = error instanceof Error ? error.message : String(error || 'DCC operation failed');
    const message = buildDccNodeFailureMessage(currentEngine, rawMessage, kind);
    console.error('[DCCCaptureNode] operation failed', {
      kind,
      engine: currentEngine,
      rawMessage,
      message,
      error,
    });
    setSnapshot((current) => ({
      ...current,
      status: options.preserveConnection ? current.status : 'error',
      captureStatus: 'error',
      message,
    }));
    if (options.clearPreview) {
      rendererRef.current?.clear();
    }
    notifyDccEnvironmentMonitor('failure', currentEngine);
  }

  function handleDccEvent(event: DccEvent) {
    if (event.type === 'state') {
      if (event.snapshot.captureStatus !== 'recording' && recordingStopTimerRef.current) {
        window.clearTimeout(recordingStopTimerRef.current);
        recordingStopTimerRef.current = null;
      }
      setSnapshot(event.snapshot);
      if (event.snapshot.status !== 'connected') {
        setPreviewPaused(false);
      }
      if (event.snapshot.status === 'connected') {
        setNodeNotice(null);
        setDismissedNodeNoticeKey('');
      }
      if (event.snapshot.status === 'error') {
        notifyDccEnvironmentMonitor('failure', latestRef.current.engine);
      }
      if (event.snapshot.status !== 'connected' && !event.snapshot.lastFrame) {
        rendererRef.current?.clear();
      }
    }
    if (event.type === 'frame') drawFrame(event.frame);
    if (event.type === 'capture') {
      void saveCapture(event.result).catch((error) => {
        applyNodeFailure('capture', error, { preserveConnection: true });
      });
    }
    if (event.type === 'recording') {
      if (recordingStopTimerRef.current) {
        window.clearTimeout(recordingStopTimerRef.current);
        recordingStopTimerRef.current = null;
      }
      void saveEngineRecording(event.result).catch((error) => {
        applyNodeFailure('recording', error, { preserveConnection: true });
      });
    }
    if (event.type === 'recording-stop') {
      void finalizeBrowserRecording(event.message || '\u0050\u006c\u0075\u0067\u0069\u006e \u5df2\u5b8c\u6210\u5f55\u5236\u8bf7\u6c42\uff0c\u6b63\u5728\u5199\u5165\u89c6\u9891\u8282\u70b9\u3002');
    }
  }

  function drawFrame(frame: DccFrame) {
    rendererRef.current?.setFrame(frame);
  }

  function previewCapturedResult(frame: DccFrame, freeze = false) {
    const renderer = rendererRef.current;
    if (!renderer) return;
    if (resultPreviewFreezeTimerRef.current) {
      window.clearTimeout(resultPreviewFreezeTimerRef.current);
      resultPreviewFreezeTimerRef.current = null;
    }
    renderer.resume();
    renderer.setFrame(frame);
    if (!freeze) return;
    resultPreviewFreezeTimerRef.current = window.setTimeout(() => {
      resultPreviewFreezeTimerRef.current = null;
      autoPausedRef.current = false;
      setPreviewPaused(true);
      connectionRef.current?.pausePreview();
      rendererRef.current?.pause();
    }, 240);
  }
  async function ensureRealHostReady() {
    try {
      const statusParams = new URLSearchParams({ engine });
      const response = await dccGatewayFetch(`/api/dcc/status?${statusParams.toString()}`);
      if (!response.ok) {
        throw new Error('HMDao DCC status service is unavailable. Please confirm the local 8792 service is running.');
      }
      const payload = await response.json().catch(() => null) as {
        engines?: {
          unreal?: {
            reachable?: boolean;
            hostProcessRunning?: boolean;
            directBridgeOnline?: boolean;
            directBridgeReadyForTargetProject?: boolean;
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
          blender?: {
            reachable?: boolean;
            environmentManager?: {
              summary?: string;
            } | null;
          };
        };
      } | null;
      if (engine === 'blender') {
        if (payload?.engines?.blender?.reachable) return;
        await runDccPluginManagerAction({ engine: 'blender', action: 'connect' });
        return;
      }
      const unrealStatus = payload?.engines?.unreal;
      if (unrealStatus?.directBridgeReadyForTargetProject || unrealStatus?.directBridgeOnline) return;
      if (!unrealStatus?.pluginInstalled) {
        throw new Error('HMDao Unreal Capture is not installed in the current Unreal engine or project. Install it from the DCC environment panel, then enable it in the Unreal plugin list.');
      }
      if (!unrealStatus?.pluginEnabledInProject) {
        if (unrealStatus?.integration?.recommendedMode === 'official-sequencer-capture' && unrealStatus?.official?.capturePrerequisitesReady) {
          throw new Error('The current Unreal project already satisfies the compatibility-mode offline export prerequisites, but DCC node live preview and shot-animation capture still require HMDao Unreal Capture direct bridge to be enabled in this project. Enable the plugin, restart Unreal, and then click Connect again.');
        }
        throw new Error('HMDao Unreal Capture has been copied, but it is not enabled in the current Unreal project yet. Enable it in Plugins and restart Unreal before reconnecting.');
      }
      if (!unrealStatus?.hostProcessRunning) {
        throw new Error('Unreal Editor is not running. Open the target project from Epic Games Launcher, wait for the visible main window, then reconnect from HMDao.');
      }
      if (!unrealStatus?.targetProjectRunning) {
        // The running editor could not be matched to the selected .uproject by path
        // (e.g. it was launched via Epic Games Launcher / double-click and host detection
        // missed the command line). The HMDao Unreal Capture plugin auto-connects to
        // whichever editor is running through the on-demand bridge request file, so we
        // proceed instead of hard-failing. Surface a non-blocking notice so the user can
        // verify the correct project is open before recording.
        console.warn('[HMDAO-DCC] target project not matched by host detection; proceeding to connect the running editor.');
        setNodeNotice({
          key: 'unreal-project-mismatch',
          message: '已连接的 Unreal 编辑器未匹配到当前选中的 .uproject，请确认打开的是同一个项目。若场景/序列/相机无误，可继续录制。',
        });
      }
      await runDccPluginManagerAction({
        engine: 'unreal',
        action: 'connect',
        projectPath: typeof unrealStatus?.projectPath === 'string' ? unrealStatus.projectPath : undefined,
      });
    } catch (error) {
      if (error instanceof Error) {
        if (/failed to fetch/i.test(error.message)) {
          throw new Error('HMDao DCC status service is currently unreachable. Confirm the local 127.0.0.1:8792 backend is still running, then retry the connection.');
        }
        throw error;
      }
      throw new Error(String(error || 'DCC host is not ready'));
    }
  }

  async function waitForLiveConnection(timeoutMs: number) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const status = connectionRef.current?.getSnapshot().status;
      if (status === 'connected') return true;
      if (status === 'error') return false;
      await new Promise((resolve) => window.setTimeout(resolve, 120));
    }
    return false;
  }

  async function connect() {
    markDccPanelInteraction(720);
    notifyDccEnvironmentMonitor('connect', engine);
    setDismissedNodeNoticeKey('');
    autoPausedRef.current = false;
    setPreviewPaused(false);
    rendererRef.current?.resume();
    setSnapshot((current) => ({
      ...current,
      status: 'connecting',
      message: engine === 'unreal'
        ? 'Checking Unreal runtime status...'
        : 'Checking Blender capture service status...',
    }));
    const activeCamera = snapshot.cameras.find((camera) => camera.name === selectedCamera || camera.id === selectedCameraId);
    const connectOptions: DccConnectionOptions = {
      engine,
      resolution,
      cameraName: activeCamera?.name || undefined,
      cameraId: activeCamera?.id || undefined,
      allowMockFallback: false,
      previewProvider: defaultDccPreviewProvider(engine),
    };
    try {
      await ensureRealHostReady();
    } catch (error) {
      const blockingNotice = resolveDccBlockingNotice(engine, error instanceof Error ? error.message : String(error || ''));
      if (blockingNotice) {
        setNodeNotice(blockingNotice);
      }
      applyNodeFailure('connect', error, { clearPreview: true });
      return;
    }
    try {
      await connectionRef.current?.connect(connectOptions);
    } catch (error) {
      applyNodeFailure('connect', error, { clearPreview: true });
      return;
    }
    setNodeNotice(null);
    persist({
      engine,
      resolution,
      selectedCamera: activeCamera?.name || '',
      selectedCameraId: activeCamera?.id || '',
      previewProvider: defaultDccPreviewProvider(engine),
    });
    const connectedQuickly = await waitForLiveConnection(engine === 'unreal' ? 1600 : 1000);
    if (connectedQuickly) return;
    const currentSnapshot = connectionRef.current?.getSnapshot();
    if (currentSnapshot?.status === 'error') {
      setSnapshot(currentSnapshot);
      notifyDccEnvironmentMonitor('failure', engine);
    }
  }

  function disconnect() {
    markDccPanelInteraction(720);
    autoPausedRef.current = false;
    setPreviewPaused(false);
    rendererRef.current?.resume();
    connectionRef.current?.disconnect();
    setSnapshot({
      ...DEFAULT_SNAPSHOT,
      message: 'Disconnected from ' + engineConfig.label + '. Click Connect to restore the preview.',
    });
  }

  function chooseEngine(next: DccEngine) {
    if (recording) return;
    markDccPanelInteraction(720);
    const nextConfig = getDccEngineConfig(next);
    pendingControlStateRef.current.engine = next;
    setEngine(next);
    setNodeNotice(null);
    setDismissedNodeNoticeKey('');
    setPreviewPaused(false);
    setSnapshot({
      ...DEFAULT_SNAPSHOT,
      message: '\u5df2\u5207\u6362\u5230 ' + nextConfig.label + '\u3002\u5982\u9700\u771f\u5b9e\u9884\u89c8\uff0c\u8bf7\u91cd\u65b0\u8fde\u63a5\u5e76\u7b49\u5f85\u672c\u5730\u63d2\u4ef6\u5b8c\u6210\u63e1\u624b\u3002',
    });
    setCaptureUrl('');
    setRecordingUrl('');
    connectionRef.current?.disconnect();
    rendererRef.current?.clear();
    updateNodeData(id, {
      provider: 'dcc',
      model: next,
      status: 'idle',
      imageUrl: undefined,
      videoUrl: undefined,
      outputs: [],
      params: {
        ...params,
        engine: next,
        selectedCamera: '',
        selectedCameraId: '',
        captureUrl: '',
        recordingUrl: '',
        resolution,
        startFrame,
        endFrame,
        recordFps,
        videoOutputQuality,
        previewProvider: defaultDccPreviewProvider(next),
      },
    });
  }

  function chooseCamera(camera: DccCameraOption) {
    markDccPanelInteraction(720);
    if (previewPaused) {
      autoPausedRef.current = false;
      setPreviewPaused(false);
      rendererRef.current?.resume();
      connectionRef.current?.resumePreview();
    }
    connectionRef.current?.setCamera(camera.name, camera.id);
    persist({ selectedCamera: camera.name, selectedCameraId: camera.id || '' });
  }

  function chooseResolution(next: DccResolution) {
    markDccPanelInteraction(720);
    pendingControlStateRef.current.resolution = next;
    setResolution(next);
    setCustomWidth(String(next.width));
    setCustomHeight(String(next.height));
    connectionRef.current?.setResolution(next.width, next.height);
    persist({ resolution: next });
  }

  function applyCustomResolution() {
    const width = clampResolutionInput(customWidth, resolution.width);
    const height = clampResolutionInput(customHeight, resolution.height);
    chooseResolution({ width, height, label: `${width} x ${height}` });
  }

  function openDccEnvironmentPanel() {
    markDccPanelInteraction(720);
    if (sidebarCollapsed) {
      toggleSidebar();
    }
    if (activeSidebarTab !== 'dcc') {
      setSidebarTab('dcc');
    }
  }

  function updateRecordingRange(field: 'startFrame' | 'endFrame' | 'recordFps', value: string) {
    markDccPanelInteraction(720);
    hasManualRecordingRangeRef.current = true;
    const fallback = field === 'startFrame' ? startFrame : field === 'endFrame' ? endFrame : recordFps;
    const next = asPositiveInt(value, fallback);
    if (field === 'startFrame') {
      setStartFrame(next);
      if (endFrame < next) setEndFrame(next);
      persist({ startFrame: next, endFrame: Math.max(endFrame, next) });
      return;
    }
    if (field === 'endFrame') {
      const safeEnd = Math.max(startFrame, next);
      setEndFrame(safeEnd);
      persist({ endFrame: safeEnd });
      return;
    }
    const safeFps = Math.min(MAX_DCC_RECORD_FPS, Math.max(1, next));
    manualFpsRef.current = true;
    setRecordFps(safeFps);
    persist({ recordFps: safeFps });
  }

  function updateVideoOutputPreference(value: string) {
    markDccPanelInteraction(720);
    const next = normalizeDccVideoOutputQuality(value);
    setVideoOutputQuality(next);
    persist({ videoOutputQuality: next });
  }

  function getEffectiveRecordingSettings() {
    const safeStartFrame = Math.max(0, Math.round(Number(startFrame || 0)));
    const safeEndFrame = Math.max(safeStartFrame, Math.round(Number(endFrame || safeStartFrame)));
    const displayFps = Number.isFinite(snapshot.animationRange.fps) ? Math.round(Number(snapshot.animationRange.fps)) : 0;
    const safeFps = manualFpsRef.current
      ? Math.min(MAX_DCC_RECORD_FPS, Math.max(1, Math.round(Number(recordFps || displayFps || 12))))
      : Math.min(MAX_DCC_RECORD_FPS, Math.max(1, displayFps || Math.round(Number(recordFps || 12))));
    return {
      startFrame: safeStartFrame,
      endFrame: safeEndFrame,
      fps: safeFps,
    };
  }

  function captureFrame() {
    if (!connected) return;
    if (previewPaused) {
      autoPausedRef.current = false;
      setPreviewPaused(false);
      rendererRef.current?.resume();
      connectionRef.current?.resumePreview();
    }
    connectionRef.current?.capture(resolution.width, resolution.height);
  }

  async function saveCapture(result: DccCaptureResult) {
    const current = latestRef.current;
    const cameraName = result.cameraName || current.selectedCamera || '\u89c6\u53e3';
    const captureTags = dccAssetTags(current.engine, 'capture');
    const captureSmartCategories = dccAssetSmartCategories('capture');
    const persisted = await persistDccCaptureAsset(result, {
      type: 'image',
      fileName: 'dcc-capture-' + Date.now() + '.' + fileExtensionFromMimeType(result.mimeType || 'image/webp', 'webp'),
      fallbackMimeType: result.mimeType || 'image/webp',
      folderId: DCC_ASSET_FOLDER_ID,
      tags: captureTags,
      smartCategories: captureSmartCategories,
    });
    const imageMeta = {
      width: result.width,
      height: result.height,
    };
    const captureAssetUrl = resolvePreferredDccMediaUrl('image', {
      url: persisted.url,
      filePath: persisted.filePath,
      persistedAssetId: persisted.persistedAssetId,
      assetLibraryUrl: persisted.assetLibraryUrl,
    });
    if (persisted.persistedItem) {
      syncPersistedItems([persisted.persistedItem]);
    } else {
      addAssetItem({
        name: '\u0044\u0043\u0043\u622a\u56fe-' + Date.now() + '.' + fileExtensionFromMimeType(result.mimeType || 'image/webp', 'webp'),
        type: 'image',
        url: captureAssetUrl,
        thumbnail: persisted.thumbnailUrl || captureAssetUrl,
        folderId: DCC_ASSET_FOLDER_ID,
        size: result.sizeBytes || 0,
        width: result.width,
        height: result.height,
        tags: captureTags,
        smartCategories: captureSmartCategories,
        source: 'generate',
        sourceUrl: persisted.sourceUrl,
      });
    }
    setCaptureUrl(captureAssetUrl);
    updateNodeData(id, {
      imageUrl: captureAssetUrl,
      status: 'completed',
      provider: 'dcc',
      model: current.engine,
      params: {
        ...current.params,
        engine: current.engine,
        selectedCamera: cameraName,
        captureUrl: captureAssetUrl,
        captureAssetId: persisted.assetId,
        capturePersistedAssetId: persisted.persistedAssetId,
        captureSourceUrl: persisted.sourceUrl,
        captureOriginalUrl: persisted.originalUrl,
        captureFilePath: persisted.filePath,
        imageMeta,
      },
      outputs: [{
        id: 'dcc-capture-' + Date.now(),
        type: 'image',
        url: captureAssetUrl,
        metadata: {
          engine: current.engine,
          cameraName,
          source: result.source,
          managedUrl: persisted.managedUrl,
          sourceAssetId: persisted.assetId,
          persistedAssetId: persisted.persistedAssetId,
          sourceUrl: persisted.sourceUrl,
          originalUrl: persisted.originalUrl,
          filePath: persisted.filePath,
        },
      }],
    });
    createConnectedRegionNode('image', engineLabel(current.engine) + ' \u622a\u56fe\u6253\u6807\u7b7e\u8282\u70b9', {
      imageUrl: captureAssetUrl,
      imageMeta,
      persistedAssetId: persisted.persistedAssetId,
      sourceUrl: persisted.sourceUrl,
      originalUrl: persisted.originalUrl,
      filePath: persisted.filePath,
    });
    previewCapturedResult({
      url: persisted.thumbnailUrl || captureAssetUrl,
      width: result.width,
      height: result.height,
      cameraName,
      source: result.source,
      receivedAt: Date.now(),
    }, true);
  }

  function startRecording() {
    const recorder = recorderRef.current;
    if (!connected || (!useHostManagedRecording && (!recorder || recorder.isRecording || !rendererRef.current))) return;

    // Pre-recording sanity check: warn (and abort) when there is no active Level Sequence
    // or no camera to drive the shot. Without a sequence the engine would step nothing and
    // the captured clip would be frozen, which is the classic "recording is static" symptom.
    if (engine === 'unreal') {
      const range = snapshot.animationRange;
      if (!range.hasSequence) {
        setNodeNotice({
          key: 'unreal-no-sequence',
          message: '录制前请先在 Unreal 的 Sequencer 中打开一个 Level Sequence（含动画的镜头）。当前未检测到打开的序列，录制到的将是静止画面。打开序列后重试录制。',
        });
        return;
      }
      if (!range.hasCamera) {
        setNodeNotice({
          key: 'unreal-no-camera',
          message: '当前场景中没有可录制的相机。请在序列中绑定一个相机（或用变换轨道驱动相机），否则录制到的将是静止画面。',
        });
        return;
      }
    }

    const recordingSettings = getEffectiveRecordingSettings();
    console.log('[HMDAO-DCC-DIAG] startRecording ->', {
      start: recordingSettings.startFrame,
      end: recordingSettings.endFrame,
      fps: recordingSettings.fps,
      manualFps: manualFpsRef.current,
      displayFps: snapshot.animationRange.fps,
    });
    const durationMs = Math.max(1000, ((Math.abs(recordingSettings.endFrame - recordingSettings.startFrame) + 1) / Math.max(1, recordingSettings.fps)) * 1000);
    // Engine-side (Unreal/Blender) capture is driven by editor ticks and runs far
    // slower than the nominal fps (often 2-3 fps at 1080p because each tick does a
    // SceneCapture2D + png/jpeg encode). A timeout based only on the nominal clip
    // duration cuts the capture short, so for the engine path budget per frame
    // generously and let the engine report completion via recording_done. The timeout
    // stays only as a safety net if the engine never signals done.
    const frameCountEstimate = Math.abs(recordingSettings.endFrame - recordingSettings.startFrame) + 1;
    const emergencyTimeoutMs = useHostManagedRecording && engine === 'blender'
      ? Math.max(durationMs + 60000, durationMs * 20, 90000)
      : Math.max(frameCountEstimate * 1000 + 20000, durationMs + 15000, durationMs * 4);
    if (previewPaused) {
      autoPausedRef.current = false;
      setPreviewPaused(false);
      rendererRef.current?.resume();
      connectionRef.current?.resumePreview();
    }
    lastRecordingRequestRef.current = recordingSettings;
    const accepted = connectionRef.current?.beginRecording({
      startFrame: recordingSettings.startFrame,
      endFrame: recordingSettings.endFrame,
      fps: recordingSettings.fps,
      width: resolution.width,
      height: resolution.height,
      cameraName: selectedCamera || undefined,
    });
    if (!accepted) return;
    if (recordingStopTimerRef.current) window.clearTimeout(recordingStopTimerRef.current);
    recordingStopTimerRef.current = window.setTimeout(() => {
      if (useHostManagedRecording) {
        connectionRef.current?.requestStopRecording();
        return;
      }
      void finalizeBrowserRecording('\u5f55\u5236\u8d85\u65f6\u5df2\u81ea\u52a8\u505c\u6b62\uff0c\u5f53\u524d\u89c6\u9891\u4f1a\u6309\u5df2\u91c7\u96c6\u7684\u5185\u5bb9\u5199\u5165\u8282\u70b9\u3002');
    }, emergencyTimeoutMs);
    if (useHostManagedRecording) {
      recordingSourceRef.current = 'editor-direct';
      return;
    }
    try {
      browserRecordingFinalizingRef.current = false;
      recordingSourceRef.current = 'browser';
      const renderer = rendererRef.current;
      if (!recorder || !renderer) {
        throw new Error('Preview renderer is unavailable');
      }
      recorder.start(renderer.captureStream(recordingSettings.fps));
    } catch {
      connectionRef.current?.finishRecording(buildDccNodeFailureMessage(latestRef.current.engine, '\u6d4f\u89c8\u5668\u5f55\u5236\u5668\u542f\u52a8\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u5f53\u524d\u6d4f\u89c8\u5668\u662f\u5426\u652f\u6301 MediaRecorder\u3002', 'recording'));
      notifyDccEnvironmentMonitor('failure', latestRef.current.engine);
    }
  }
  async function finalizeBrowserRecording(message = '\u5f55\u5236\u5df2\u5b8c\u6210\uff0c\u89c6\u9891\u5df2\u5199\u5165\u8282\u70b9\u3002') {
    if (browserRecordingFinalizingRef.current) return;
    if (!recorderRef.current?.isRecording) return;
    browserRecordingFinalizingRef.current = true;
    try {
      if (recordingStopTimerRef.current) {
        window.clearTimeout(recordingStopTimerRef.current);
        recordingStopTimerRef.current = null;
      }
      const result = await recorderRef.current.stop();
      const localResult = await saveLocalRecording(result, recordingSourceRef.current);
      connectionRef.current?.completeLocalRecording(localResult, message);
      setPreviewPaused(true);
      connectionRef.current?.pausePreview();
      rendererRef.current?.pause();
    } catch {
      connectionRef.current?.finishRecording(buildDccNodeFailureMessage(latestRef.current.engine, '\u5f55\u5236\u505c\u6b62\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5\u3002', 'recording'));
      notifyDccEnvironmentMonitor('failure', latestRef.current.engine);
    } finally {
      browserRecordingFinalizingRef.current = false;
    }
  }

  async function stopRecording() {
    if (useHostManagedRecording) {
      if (recordingStopTimerRef.current) {
        window.clearTimeout(recordingStopTimerRef.current);
        recordingStopTimerRef.current = null;
      }
      connectionRef.current?.requestStopRecording();
      return;
    }
    if (!recorderRef.current?.isRecording) return;
    await finalizeBrowserRecording('\u5f55\u5236\u5df2\u5b8c\u6210\uff0c\u89c6\u9891\u5df2\u5199\u5165\u8282\u70b9\u3002');
  }
  function togglePreviewPause() {
    if (!connected || recording) return;
    const nextPaused = !previewPaused;
    autoPausedRef.current = false;
    setPreviewPaused(nextPaused);
    if (nextPaused) {
      connectionRef.current?.pausePreview();
      rendererRef.current?.pause();
      return;
    }
    rendererRef.current?.resume();
    connectionRef.current?.resumePreview();
  }

  async function saveEngineRecording(result: DccCaptureResult) {
    const current = latestRef.current;
    const fallbackRecordingSettings = lastRecordingRequestRef.current || getEffectiveRecordingSettings();
    const recordingSettings = {
      startFrame: Number.isFinite(result.startFrame) ? Number(result.startFrame) : fallbackRecordingSettings.startFrame,
      endFrame: Number.isFinite(result.endFrame) ? Number(result.endFrame) : fallbackRecordingSettings.endFrame,
      fps: Number.isFinite(result.fps) && Number(result.fps) > 0 ? Number(result.fps) : fallbackRecordingSettings.fps,
    };
    const durationMs = Number.isFinite(result.durationMs) && Number(result.durationMs) > 0
      ? Number(result.durationMs)
      : Math.max(0, ((recordingSettings.endFrame - recordingSettings.startFrame + 1) / Math.max(1, recordingSettings.fps)) * 1000);
    const recordingTags = dccAssetTags(current.engine, 'recording');
    const recordingSmartCategories = dccAssetSmartCategories('recording');
    const persisted = await persistDccCaptureAsset(result, {
      type: 'video',
      fileName: 'dcc-recording-' + Date.now() + '.' + fileExtensionFromMimeType(result.mimeType || 'video/mp4', 'mp4'),
      fallbackMimeType: result.mimeType || 'video/mp4',
      duration: Math.max(1, Math.round(durationMs / 1000)),
      folderId: DCC_ASSET_FOLDER_ID,
      tags: recordingTags,
      smartCategories: recordingSmartCategories,
    });
    if (persisted.persistedItem) {
      syncPersistedItems([persisted.persistedItem]);
    }
    const fallbackThumbnailUrl = result.thumbnailUrl || await snapshotCompactFirstFrame();
    const persistedThumbnailUrl = await persistDccThumbnailAsset(fallbackThumbnailUrl, {
      width: result.width,
      height: result.height,
      cameraName: result.cameraName || selectedCamera || 'Viewport',
      source: result.source,
    });
    const previewUrl = persistedThumbnailUrl || persisted.thumbnailUrl || fallbackThumbnailUrl;
    const recordingPlaybackUrl = resolvePreferredDccMediaUrl('video', {
      url: persisted.originalUrl || persisted.url,
      filePath: persisted.filePath,
      persistedAssetId: persisted.persistedAssetId,
      assetLibraryUrl: persisted.assetLibraryUrl || persisted.url,
    });
    saveRecordingOutput({
      url: recordingPlaybackUrl,
      assetUrl: recordingPlaybackUrl,
      derivedUrl: persisted.assetLibraryUrl || persisted.url,
      durationMs,
      sizeBytes: result.sizeBytes || 0,
      mimeType: result.mimeType || 'video/mp4',
      width: result.width,
      height: result.height,
      cameraName: result.cameraName,
      source: result.source,
      firstFrameUrl: persistedThumbnailUrl || persisted.thumbnailUrl || fallbackThumbnailUrl,
      managedUrl: persisted.managedUrl,
      filePath: persisted.filePath,
      sourceAssetId: persisted.assetId,
      persistedAssetId: persisted.persistedAssetId,
      sourceUrl: persisted.sourceUrl,
      originalUrl: persisted.originalUrl,
      assetStoreSynchronized: Boolean(persisted.persistedItem) || isPersistedAssetLibraryUrl(persisted.url),
      startFrame: recordingSettings.startFrame,
      endFrame: recordingSettings.endFrame,
      fps: recordingSettings.fps,
    });
    if (previewUrl) {
      previewCapturedResult({
        url: previewUrl,
        width: result.width,
        height: result.height,
        cameraName: result.cameraName || selectedCamera || 'Viewport',
        source: result.source,
        receivedAt: Date.now(),
      }, true);
    }
  }
  async function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error('Failed to read the local media file.'));
      reader.onload = () => resolve(String(reader.result || ''));
      reader.readAsDataURL(blob);
    });
  }

  async function snapshotCompactFirstFrame(): Promise<string> {
    try {
      const blob = await rendererRef.current?.snapshot('image/jpeg', 0.62);
      return blob ? await blobToDataUrl(blob) : '';
    } catch {
      return '';
    }
  }

  async function persistDccThumbnailAsset(
    thumbnailUrl: string,
    options: { width: number; height: number; cameraName: string; source: DccFrameSource; mimeType?: string },
  ) {
    const normalizedThumbnailUrl = String(thumbnailUrl || '').trim();
    if (!normalizedThumbnailUrl) return '';
    const fallbackMimeType = String(options.mimeType || (normalizedThumbnailUrl.startsWith('data:image/png') ? 'image/png' : 'image/jpeg')).trim() || 'image/jpeg';
    const currentEngine = latestRef.current.engine;
    const thumbnailTags = dccAssetTags(currentEngine, 'thumbnail');
    const thumbnailSmartCategories = dccAssetSmartCategories('thumbnail');
    try {
      const persisted = await persistDccCaptureAsset({
        url: normalizedThumbnailUrl,
        width: Math.max(1, options.width),
        height: Math.max(1, options.height),
        cameraName: options.cameraName,
        source: options.source,
        receivedAt: Date.now(),
        mimeType: fallbackMimeType,
      }, {
        type: 'image',
        fileName: 'dcc-thumbnail-' + Date.now() + '.' + fileExtensionFromMimeType(fallbackMimeType, 'jpg'),
        fallbackMimeType,
        folderId: DCC_ASSET_FOLDER_ID,
        tags: thumbnailTags,
        smartCategories: thumbnailSmartCategories,
      });
      if (persisted.persistedItem) {
        syncPersistedItems([persisted.persistedItem]);
      } else if (!isPersistedAssetLibraryUrl(persisted.url)) {
        addAssetItem({
          name: '\u0044\u0043\u0043\u9996\u5e27-' + Date.now() + '.' + fileExtensionFromMimeType(fallbackMimeType, 'jpg'),
          type: 'image',
          url: persisted.url,
          thumbnail: persisted.thumbnailUrl || persisted.url,
          folderId: DCC_ASSET_FOLDER_ID,
          width: options.width,
          height: options.height,
          size: 0,
          tags: thumbnailTags,
          smartCategories: thumbnailSmartCategories,
          source: 'generate',
          sourceUrl: persisted.sourceUrl,
        });
      }
      return persisted.thumbnailUrl || persisted.url;
    } catch {
      return normalizedThumbnailUrl;
    }
  }

  async function saveLocalRecording(result: DccRecordingResult, source: DccFrameSource): Promise<DccCaptureResult> {
    const current = latestRef.current;
    const recordingSettings = lastRecordingRequestRef.current || getEffectiveRecordingSettings();
    const durationMs = Math.max(0, ((Math.abs(recordingSettings.endFrame - recordingSettings.startFrame) + 1) / Math.max(1, recordingSettings.fps)) * 1000);
    const durationSeconds = Math.max(1, Math.round(durationMs / 1000));
    const firstFrameUrl = await snapshotCompactFirstFrame();
    const persistedFirstFrameUrl = await persistDccThumbnailAsset(firstFrameUrl, {
      width: resolution.width,
      height: resolution.height,
      cameraName: selectedCamera || 'Viewport',
      source,
      mimeType: 'image/jpeg',
    });
    try {
      const persistedImport = await importLocalAssetFile(
        new File(
          [result.blob],
          'dcc-recording-' + Date.now() + '.' + fileExtensionFromMimeType(result.mimeType || result.blob.type || 'video/webm', 'webm'),
          { type: result.mimeType || result.blob.type || 'video/webm' },
        ),
        {
          folderId: DCC_ASSET_FOLDER_ID,
          tags: dccAssetTags(current.engine, 'recording'),
          smartCategories: dccAssetSmartCategories('recording'),
          width: resolution.width,
          height: resolution.height,
          duration: durationSeconds,
          sourceUrl: 'dcc-browser-recording',
        },
      );
      syncPersistedItems([persistedImport.item]);
      return {
        url: persistedImport.item.url,
        width: resolution.width,
        height: resolution.height,
        cameraName: selectedCamera || 'Viewport',
        source,
        receivedAt: Date.now(),
        sizeBytes: result.sizeBytes,
        durationMs,
        mimeType: result.mimeType || result.blob.type || 'video/webm',
        managedUrl: true,
        thumbnailUrl: persistedFirstFrameUrl || firstFrameUrl || persistedImport.item.thumbnail || persistedImport.item.url,
      };
    } catch {
      const outputHandle = await registerLocalMediaPersisted(result.blob);
      return {
        url: outputHandle,
        width: resolution.width,
        height: resolution.height,
        cameraName: selectedCamera || 'Viewport',
        source,
        receivedAt: Date.now(),
        sizeBytes: result.sizeBytes,
        durationMs,
        mimeType: result.mimeType || 'video/webm',
        managedUrl: true,
        thumbnailUrl: persistedFirstFrameUrl || firstFrameUrl,
      };
    } finally {
      if (result.url.startsWith('blob:')) {
        URL.revokeObjectURL(result.url);
      }
    }
  }
  function saveRecordingOutput(result: {
    url: string;
    derivedUrl?: string;
    assetUrl?: string;
    filePath?: string;
    durationMs: number;
    sizeBytes: number;
    mimeType: string;
    width: number;
    height: number;
    cameraName: string;
    source: DccFrameSource;
    firstFrameUrl?: string;
    managedUrl?: boolean;
    startFrame?: number;
    endFrame?: number;
    fps?: number;
    sourceAssetId?: string;
    persistedAssetId?: string;
    sourceUrl?: string;
    originalUrl?: string;
    assetStoreSynchronized?: boolean;
  }) {
    const current = latestRef.current;
    const safeCamera = result.cameraName || current.selectedCamera || 'Viewport';
    const startFrameUsed = Math.max(0, Math.round(Number(result.startFrame ?? lastRecordingRequestRef.current?.startFrame ?? current.startFrame)));
    const endFrameUsed = Math.max(startFrameUsed, Math.round(Number(result.endFrame ?? lastRecordingRequestRef.current?.endFrame ?? current.endFrame)));
    const fpsUsed = Math.min(MAX_DCC_RECORD_FPS, Math.max(1, Math.round(Number(result.fps ?? lastRecordingRequestRef.current?.fps ?? current.recordFps))));
    const durationSeconds = Math.max(1, Math.round(result.durationMs / 1000));
    const videoMeta = {
      width: result.width,
      height: result.height,
      duration: durationSeconds,
    };
    const outputMetadata = {
      engine: current.engine,
      cameraName: safeCamera,
      durationMs: result.durationMs,
      source: result.source,
      mimeType: result.mimeType,
      width: result.width,
      height: result.height,
      managedUrl: Boolean(result.managedUrl),
      sourceAssetId: result.sourceAssetId,
      persistedAssetId: result.persistedAssetId,
      sourceUrl: result.sourceUrl,
      originalUrl: result.originalUrl,
      filePath: result.filePath,
    };
    const assetUrl = result.assetUrl || result.url;
    const derivedUrl = result.derivedUrl || result.url;
    const firstFrameUrl = result.firstFrameUrl || captureUrl || '';
    const stableOutputId = result.filePath || assetUrl || derivedUrl || result.url;
    const recordingKey = [
      stableOutputId,
      derivedUrl,
      result.sizeBytes,
      result.width,
      result.height,
      safeCamera,
      startFrameUsed,
      endFrameUsed,
      fpsUsed,
    ].join('|');
    if (recordingKey === lastSavedRecordingKeyRef.current) {
      return;
    }
    lastSavedRecordingKeyRef.current = recordingKey;
    setRecordingUrl(assetUrl);
    if (!shouldSkipAssetLibraryInsertion(result.assetStoreSynchronized, assetUrl)) {
      const recordingTags = dccAssetTags(current.engine, 'recording');
      const recordingSmartCategories = dccAssetSmartCategories('recording');
      addAssetItem({
        name: '\u0044\u0043\u0043\u5f55\u5236-' + Date.now() + '.' + fileExtensionFromMimeType(result.mimeType || 'video/mp4', 'mp4'),
        type: 'video',
        url: assetUrl,
        thumbnail: firstFrameUrl || assetUrl,
        folderId: DCC_ASSET_FOLDER_ID,
        size: result.sizeBytes,
        width: result.width,
        height: result.height,
        duration: durationSeconds,
        tags: recordingTags,
        smartCategories: recordingSmartCategories,
        source: 'generate',
        sourceUrl: result.sourceUrl,
      });
    }
    updateNodeData(id, {
      videoUrl: assetUrl,
      status: 'completed',
      provider: 'dcc',
      model: current.engine,
      duration: durationSeconds,
      aspectRatio: result.width >= result.height ? '16:9' : '9:16',
      params: {
        ...current.params,
        engine: current.engine,
        selectedCamera: safeCamera,
        startFrame: startFrameUsed,
        endFrame: endFrameUsed,
        recordFps: fpsUsed,
        recordingUrl: assetUrl,
        recordingAssetId: result.sourceAssetId,
        recordingPersistedAssetId: result.persistedAssetId,
        recordingSourceUrl: result.sourceUrl,
        recordingOriginalUrl: result.originalUrl,
        recordingFilePath: result.filePath,
        firstFrameUrl: firstFrameUrl || undefined,
        videoMeta,
        videoMimeType: result.mimeType,
      },
      outputs: [{ id: 'dcc-recording-' + Date.now(), type: 'video', url: assetUrl, metadata: { ...outputMetadata, managedUrl: Boolean(result.managedUrl) } }],
    });
    createConnectedRegionNode('video', engineLabel(current.engine) + ' \u5f55\u5236\u6253\u6807\u7b7e\u8282\u70b9', {
      videoUrl: assetUrl,
      videoMeta,
      persistedAssetId: result.persistedAssetId,
      sourceUrl: result.sourceUrl,
      originalUrl: result.originalUrl,
      filePath: result.filePath,
    });
  }
  useEffect(() => {
    if (!connected || recording || snapshot.connectionMode !== 'real' || hasManualRecordingRangeRef.current) return;
    const nextStartFrame = Math.max(0, Math.round(Number(snapshot.animationRange.startFrame || 0)));
    const nextEndFrame = Math.max(nextStartFrame, Math.round(Number(snapshot.animationRange.endFrame || nextStartFrame)));
    const nextFps = Math.min(MAX_DCC_RECORD_FPS, Math.max(1, Math.round(Number(snapshot.animationRange.fps || recordFps))));
    if (startFrame === nextStartFrame && endFrame === nextEndFrame && recordFps === nextFps) return;
    pendingControlStateRef.current.startFrame = nextStartFrame;
    pendingControlStateRef.current.endFrame = nextEndFrame;
    pendingControlStateRef.current.recordFps = nextFps;
    setStartFrame(nextStartFrame);
    setEndFrame(nextEndFrame);
    setRecordFps(nextFps);
    persist({
      startFrame: nextStartFrame,
      endFrame: nextEndFrame,
      recordFps: nextFps,
    });
  }, [
    connected,
    endFrame,
    recordFps,
    recording,
    snapshot.animationRange.endFrame,
    snapshot.animationRange.fps,
    snapshot.animationRange.startFrame,
    snapshot.connectionMode,
    startFrame,
  ]);



  function createConnectedMediaNode(
    sourceMediaType: 'image' | 'video',
    payload: {
      url: string;
      thumbnailUrl?: string;
      width: number;
      height: number;
      duration?: number;
      label?: string;
      metadata: Record<string, unknown>;
    },
  ) {
    if (!payload.url) return;
    const sourceNode = getNodeById(id);
    const baseX = sourceNode?.position.x ?? 0;
    const baseY = sourceNode?.position.y ?? 0;
    const sourceLabel = typeof data?.label === 'string' && data.label.trim() ? data.label.trim() : 'DCC Capture';
    const nextLabel = payload.label || (sourceMediaType === 'image' ? `${sourceLabel} capture` : `${sourceLabel} recording`);
    addConnectedNode({
      type: sourceMediaType,
      position: {
        x: baseX + 600,
        y: baseY + (sourceMediaType === 'image' ? -168 : 420),
      },
      data: {
        label: nextLabel,
        provider: 'dcc',
        model: latestRef.current.engine,
        status: 'completed',
        aspectRatio: payload.width >= payload.height ? '16:9' : '9:16',
        duration: sourceMediaType === 'video' ? payload.duration : undefined,
        imageUrl: sourceMediaType === 'image' ? payload.url : '',
        videoUrl: sourceMediaType === 'video' ? payload.url : '',
        params: {
          source: 'dcc-output',
          sourceNodeId: id,
          sourceNodeType: 'dcc',
          sourceNodeLabel: sourceLabel,
          sourceUrl: payload.url,
          dccMeta: payload.metadata,
          ...(sourceMediaType === 'image'
            ? {
                imageMeta: {
                  width: payload.width,
                  height: payload.height,
                },
              }
            : {
                firstFrameUrl: payload.thumbnailUrl || undefined,
                videoMeta: {
                  width: payload.width,
                  height: payload.height,
                  duration: payload.duration ?? 0,
                },
              }),
        },
        outputs: [{
          id: 'dcc-materialized-' + sourceMediaType + '-' + Date.now(),
          type: sourceMediaType,
          url: payload.url,
          thumbnail: sourceMediaType === 'video' ? payload.thumbnailUrl || payload.url : payload.url,
          metadata: payload.metadata,
        }],
      },
      sourceId: id,
      sourceHandle: 'dcc-output',
      targetHandle: sourceMediaType === 'image' ? 'image-main' : 'video-main',
      select: false,
    });
  }
  function refreshConnection() {
    markDccPanelInteraction(720);
    if (previewPaused) {
      autoPausedRef.current = false;
      setPreviewPaused(false);
      rendererRef.current?.resume();
      connectionRef.current?.resumePreview();
    }
    connectionRef.current?.requestCameras();
  }

  function clearPendingSelectionSync() {
    if (selectionSyncTimersRef.current.length === 0) return;
    selectionSyncTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
    selectionSyncTimersRef.current = [];
  }

  function scheduleNodeSelectionSync() {
    clearPendingSelectionSync();
    const syncSelection = () => {
      const store = useCanvasStore.getState();
      const currentIds = Array.isArray(store.selectedNodeIds) ? store.selectedNodeIds : [];
      if (currentIds.length === 1 && currentIds[0] === id) return;
      store.setSelectionGuard?.(720);
      store.setSelectedNodeIds([id]);
    };

    selectionSyncTimersRef.current = [
      window.setTimeout(syncSelection, 0),
      window.setTimeout(syncSelection, 96),
      window.setTimeout(syncSelection, 220),
    ];
  }

  function syncNodeSelection() {
    if (selectedNodeIds.length === 1 && selectedNodeIds[0] === id) return;
    scheduleNodeSelectionSync();
  }

  function handleNodeSelectionPointer(event: { target: EventTarget | null }) {
    if (isInteractiveTarget(event.target)) return;
    syncNodeSelection();
  }

  function createConnectedRegionNode(
    sourceMediaType: 'image' | 'video',
    label?: string,
    overrides?: {
      imageUrl?: string;
      videoUrl?: string;
      imageMeta?: Record<string, unknown>;
      videoMeta?: Record<string, unknown>;
      persistedAssetId?: string;
      sourceUrl?: string;
      originalUrl?: string;
      filePath?: string;
    },
  ) {
    const canvasState = useCanvasStore.getState();
    const existingRegionNode = canvasState.canvas?.nodes.find((node) => {
      if (node.type !== 'region') return false;
      const params = node.data?.params && typeof node.data.params === 'object'
        ? node.data.params as Record<string, unknown>
        : {};
      const sourceNodeId = String(params.sourceNodeId || '').trim();
      const mediaType = String(params.sourceMediaType || '').trim();
      const hasSourceEdge = canvasState.canvas?.edges.some((edge) => edge.source === id && edge.target === node.id);
      return sourceNodeId === id && mediaType === sourceMediaType && Boolean(hasSourceEdge);
    }) || null;
    const sourceNode = getNodeById(id);
    const baseX = sourceNode?.position.x ?? 0;
    const baseY = sourceNode?.position.y ?? 0;
    const sourceData = sourceNode?.data && typeof sourceNode.data === 'object'
      ? sourceNode.data as { label?: string; imageUrl?: string; videoUrl?: string; params?: Record<string, unknown> }
      : null;
    const sourceParams = sourceData?.params && typeof sourceData.params === 'object'
      ? sourceData.params as Record<string, unknown>
      : {};
    const imageMeta = sourceParams.imageMeta && typeof sourceParams.imageMeta === 'object'
      ? sourceParams.imageMeta as Record<string, unknown>
      : undefined;
    const videoMeta = sourceParams.videoMeta && typeof sourceParams.videoMeta === 'object'
      ? sourceParams.videoMeta as Record<string, unknown>
      : undefined;
    const nextImageMeta = overrides?.imageMeta || imageMeta;
    const nextVideoMeta = overrides?.videoMeta || videoMeta;
    const rawMediaUrl = sourceMediaType === 'image'
      ? String(overrides?.imageUrl || sourceData?.imageUrl || '')
      : String(overrides?.videoUrl || sourceData?.videoUrl || '');
    const sourceFilePath = sourceMediaType === 'image'
      ? String(overrides?.filePath || sourceParams.captureFilePath || '')
      : String(overrides?.filePath || sourceParams.recordingFilePath || '');
    const nextPersistedAssetId = normalizePersistedAssetId(
      overrides?.persistedAssetId
        || (sourceMediaType === 'image' ? sourceParams.capturePersistedAssetId : sourceParams.recordingPersistedAssetId),
      rawMediaUrl,
    );
    const nextMediaUrl = resolvePreferredDccMediaUrl(sourceMediaType, {
      url: rawMediaUrl,
      filePath: sourceFilePath,
      persistedAssetId: nextPersistedAssetId,
    });
    const nextLabel = label || (sourceMediaType === 'image' ? '\u622a\u56fe\u6253\u6807\u7b7e\u8282\u70b9' : '\u5f55\u5236\u6253\u6807\u7b7e\u8282\u70b9');
    if (existingRegionNode) {
      const regionParams = existingRegionNode.data?.params && typeof existingRegionNode.data.params === 'object'
        ? existingRegionNode.data.params as Record<string, unknown>
        : {};
      updateNodeData(existingRegionNode.id, {
        label: nextLabel,
        imageUrl: sourceMediaType === 'image' ? nextMediaUrl : '',
        videoUrl: sourceMediaType === 'video' ? nextMediaUrl : '',
        params: {
          ...regionParams,
          sourceMediaType,
          sourceNodeId: id,
          sourceNodeLabel: typeof sourceData?.label === 'string' ? sourceData.label : data?.label,
          sourcePersistedAssetId: nextPersistedAssetId || undefined,
          sourceUrl: overrides?.sourceUrl || rawMediaUrl || undefined,
          sourceOriginalUrl: overrides?.originalUrl || undefined,
          sourceFilePath: overrides?.filePath || undefined,
          ...(nextImageMeta ? { imageMeta: nextImageMeta } : {}),
          ...(nextVideoMeta ? { videoMeta: nextVideoMeta } : {}),
        },
      });
      setSelectedNodeIds([existingRegionNode.id]);
      return;
    }
    addConnectedNode({
      type: 'region',
      position: {
        x: baseX + 600,
        y: baseY + (sourceMediaType === 'image' ? -24 : 260),
      },
      data: {
        imageUrl: sourceMediaType === 'image' ? nextMediaUrl : '',
        videoUrl: sourceMediaType === 'video' ? nextMediaUrl : '',
        label: nextLabel,
        params: {
          sourceMediaType,
          sourceNodeId: id,
          sourceNodeLabel: typeof sourceData?.label === 'string' ? sourceData.label : data?.label,
          sourcePersistedAssetId: nextPersistedAssetId || undefined,
          sourceUrl: overrides?.sourceUrl || rawMediaUrl || undefined,
          sourceOriginalUrl: overrides?.originalUrl || undefined,
          sourceFilePath: overrides?.filePath || undefined,
          ...(nextImageMeta ? { imageMeta: nextImageMeta } : {}),
          ...(nextVideoMeta ? { videoMeta: nextVideoMeta } : {}),
        },
      },
      sourceId: id,
      sourceHandle: 'dcc-output',
      targetHandle: 'region-main',
      select: true,
    });
  }

  function download(url: string, name: string) {

    if (!url) return;
    const anchor = document.createElement('a');
    anchor.href = resolveLocalMediaUrl(url) || url;
    anchor.download = name;
    anchor.rel = 'noopener';
    anchor.click();
  }

  return (
    <div
      className="relative overflow-visible"
      data-testid={nodeTestId}
      data-node-id={id}
      data-node-type="dcc"
      onPointerDownCapture={handleNodeSelectionPointer}
      onMouseDownCapture={handleNodeSelectionPointer}
    >
      {isNodeExclusivelySelected ? (
        <div
          {...dccPanelInteractionProps}
          className="nodrag absolute bottom-full left-1/2 z-40 mb-4 flex min-h-[52px] w-full max-w-full -translate-x-1/2 flex-wrap items-center justify-center gap-2 rounded-xl bg-[#2a2a2a] px-3 py-2 shadow-2xl ring-1 ring-[#424242]"
          style={floatingPanelStyle}
        >
          <ToolbarButton title="连接" testId={`dcc-connect-${id}`} onClick={connect} disabled={connected || connecting}>{connecting ? <Loader2 className='h-4 w-4 animate-spin' /> : <Plug className='h-4 w-4' />}</ToolbarButton>
          <ToolbarButton title="断开" testId={`dcc-disconnect-${id}`} onClick={disconnect} disabled={!connected}><Unplug className='h-4 w-4' /></ToolbarButton>
          <ToolbarButton title="截图" testId={`dcc-capture-${id}`} onClick={captureFrame} disabled={!connected || capturing}>{capturing ? <Loader2 className='h-4 w-4 animate-spin' /> : <Camera className='h-4 w-4' />}</ToolbarButton>
          {recording ? <ToolbarButton title="停止" testId={`dcc-stop-${id}`} onClick={stopRecording}><Square className='h-4 w-4' /></ToolbarButton> : <ToolbarButton title="录制" testId={`dcc-record-${id}`} onClick={startRecording} disabled={!connected}><Video className='h-4 w-4' /></ToolbarButton>}
          <ToolbarButton title={previewPaused ? "\u6062\u590d\u9884\u89c8" : "\u6682\u505c\u9884\u89c8"} testId={`dcc-pause-${id}`} onClick={togglePreviewPause} disabled={!connected || recording}>{previewPaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}</ToolbarButton>
          <div className="mx-1 h-7 w-px bg-[#444]" />
          <ToolbarButton title="下载截图" onClick={() => download(captureUrl, 'dcc-capture-' + Date.now() + '.webp')} disabled={!captureUrl}><Download className='h-4 w-4' /></ToolbarButton>
          <ToolbarButton title="下载录制" onClick={() => download(recordingUrl, 'dcc-recording-' + Date.now() + '.mp4')} disabled={!recordingUrl}><Video className='h-4 w-4' /></ToolbarButton>
        </div>
      ) : null}
      <div className={`relative rounded-lg bg-[#262626] transition-all duration-150 ${isNodeSelected ? 'ring-2 ring-[#9a9a9a] shadow-[0_0_0_1px_rgba(255,255,255,0.22)]' : 'ring-1 ring-[#343434]'}`} style={previewShellStyle}>
        <EditableNodeTitle nodeId={id} icon={MonitorUp} label={data?.label} fallback="DCC 捕捉节点" className='absolute -top-7 left-0' />
        <div className="relative overflow-hidden rounded-lg bg-black" style={previewFrameStyle}>
          <canvas ref={canvasRef} width={resolution.width} height={resolution.height} className="block h-full w-full bg-black object-cover [transform:translateZ(0)]" />
          {!connected ? <ConnectionGuide config={engineConfig} message={snapshot.message} /> : null}
          <div className="absolute left-3 top-3 flex items-center gap-2 rounded-lg bg-black/55 px-2 py-1 text-xs text-white">
            <EngineIcon className="h-3.5 w-3.5" />
            {visibleEngineLabel}
          </div>
          <div className="absolute right-3 top-3 flex items-center gap-2 rounded-lg bg-black/55 px-2 py-1 text-xs text-white">
            {connected ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
            {connected ? `${Math.round(snapshot.fps)} fps` : runtimePresentation.label}
          </div>
          {recording ? (
            <div className="absolute bottom-3 left-3 flex items-center gap-2 rounded-lg bg-red-600/85 px-2.5 py-1 text-xs font-semibold text-white shadow-lg">
              <Radio className="h-3.5 w-3.5 animate-pulse" />
              {"\u6b63\u5728\u5f55\u5236\u5b9e\u65f6\u9884\u89c8"}
            </div>
          ) : null}
          {previewPaused && connected ? (
            <div className="absolute bottom-3 right-3 rounded-lg bg-black/65 px-2.5 py-1 text-xs text-white shadow-lg">{"\u9884\u89c8\u5df2\u6682\u505c\uff0c\u5df2\u91ca\u653e\u9884\u89c8\u5360\u7528"}</div>
          ) : null}
        </div>
        <Handle type="target" position={Position.Left} className="image-node-handle" style={handleLeft}><span className="text-xs font-bold leading-none text-[#8a8a8a]">+</span></Handle>
        <Handle id="dcc-output" type="source" position={Position.Right} className="image-node-handle" style={handleRight}><span className="text-xs font-bold leading-none text-[#8a8a8a]">+</span></Handle>
      </div>

      {isNodeExclusivelySelected ? (
        <div
          {...dccPanelInteractionProps}
          className="absolute left-1/2 top-full z-30 mt-4 w-full max-w-full -translate-x-1/2"
          style={floatingPanelStyle}
        >
          <div
            {...dccPanelInteractionProps}
            className="nopan nodrag overflow-visible rounded-lg bg-[#2b2b2b] shadow-2xl ring-1 ring-[#3c3c3c]"
          >
            <div className="grid grid-cols-2 gap-2 px-3 pt-3">
              <NativeSelect label="引擎" testId={`dcc-engine-${id}`} value={engine} disabled={recording} onChange={(value) => chooseEngine(value as DccEngine)} options={DCC_ENGINES.map((item) => ({ value: item.id, label: getVisibleEngineLabel(item.id, item.label) }))} />
              <NativeSelect label="相机" testId={`dcc-camera-${id}`} value={selectedCameraId || selectedCamera || cameras[0]?.id || cameras[0]?.name || '未选择相机'} disabled={!connected} onChange={(value) => chooseCamera(cameras.find((camera) => (camera.id || camera.name) === value) || { id: value, name: value })} options={cameraOptions} />
              <NativeSelect label="分辨率" testId={`dcc-resolution-${id}`} value={resolution.label} onChange={(value) => { const next = DCC_RESOLUTIONS.find((item) => item.label === value); if (next) chooseResolution(next); }} options={DCC_RESOLUTIONS.map((item) => ({ value: item.label, label: item.label }))} />
              <button type='button' data-dcc-interactive='true' data-testid={`dcc-refresh-${id}`} onPointerDown={stopPointerPropagation} onMouseDown={stopPointerPropagation} onClick={refreshConnection} disabled={connecting || recording} className='nodrag nopan nowheel flex h-12 flex-col items-center justify-center gap-1 rounded-lg border border-[#4a4a4a] text-xs text-[#cfcfcf] hover:bg-[#353535] disabled:opacity-40' title="刷新状态"><RefreshCcw className='h-4 w-4' />刷新</button>
            </div>
            <div className="grid grid-cols-1 gap-2 px-3 pt-3 sm:grid-cols-3">
              <FrameInput label="起始帧" testId={`dcc-start-frame-${id}`} value={startFrame} onChange={(value) => updateRecordingRange('startFrame', value)} />
              <FrameInput label="结束帧" testId={`dcc-end-frame-${id}`} value={endFrame} onChange={(value) => updateRecordingRange('endFrame', value)} />
              <FrameInput label="帧率" testId={`dcc-fps-${id}`} value={recordFps} onChange={(value) => updateRecordingRange('recordFps', value)} />
            </div>
            <div className="grid grid-cols-1 gap-2 px-3 pt-3 sm:grid-cols-2">
              <NativeSelect
                label="视频质量"
                testId={`dcc-video-quality-${id}`}
                value={videoOutputQuality}
                onChange={updateVideoOutputPreference}
                options={DCC_VIDEO_OUTPUT_OPTIONS.map((item) => ({ value: item.value, label: item.label }))}
              />
              <FrameInput label="宽度" testId={`dcc-resolution-width-${id}`} value={Number(customWidth) || resolution.width} onChange={setCustomWidth} />
              <FrameInput label="高度" testId={`dcc-resolution-height-${id}`} value={Number(customHeight) || resolution.height} onChange={setCustomHeight} />
              <button
                type="button"
                data-dcc-interactive="true"
                data-testid={`dcc-resolution-apply-${id}`}
                onPointerDown={stopPointerPropagation}
                onMouseDown={stopPointerPropagation}
                onClick={applyCustomResolution}
                className="nodrag nopan nowheel flex h-12 flex-col items-center justify-center gap-1 rounded-lg border border-[#4a4a4a] text-xs text-[#cfcfcf] hover:bg-[#353535]"
                title={"\u5e94\u7528\u5f53\u524d\u5bbd\u9ad8\u8bbe\u7f6e"}
              >
                {"\u5e94\u7528\u5bbd\u9ad8"}
              </button>
            </div>
            <div className="mx-3 mt-3 rounded-lg border border-[#3a454f] bg-[#111b23] px-3 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-white">{"DCC \u73af\u5883\u9762\u677f"}</div>
                </div>
                <button
                  type="button"
                  data-dcc-interactive="true"
                  onPointerDown={stopPointerPropagation}
                  onMouseDown={stopPointerPropagation}
                  onClick={openDccEnvironmentPanel}
                  className="nodrag nopan nowheel inline-flex shrink-0 items-center gap-1 rounded-lg border border-[#4a6475] px-3 py-2 text-xs font-semibold text-[#d9f2ff] hover:bg-[#193041]"
                >
                  <MonitorUp className="h-3.5 w-3.5" />
                  {"\u6253\u5f00 DCC \u9762\u677f"}
                </button>
              </div>
            </div>
            {activeNodeNotice ? (
              <div className="mx-3 mt-3 rounded-lg border border-[#6a4b24] bg-[#2c2113] px-3 py-3 text-sm text-[#f3d7aa]">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-semibold text-[#ffe7bf]">{activeNodeNotice.message}</div>
                    {activeNodeNotice.detail ? (
                      <div className="mt-1 text-xs leading-5 text-[#d8bc8f]">{activeNodeNotice.detail}</div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    data-dcc-interactive="true"
                    onPointerDown={stopPointerPropagation}
                    onMouseDown={stopPointerPropagation}
                    onClick={() => setDismissedNodeNoticeKey(activeNodeNotice.key)}
                    className="nodrag nopan nowheel inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[#d8bc8f] hover:bg-[#46331b] hover:text-[#fff1d8]"
                    title={"关闭提示"}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ) : null}
            <div className="px-4 py-4 text-sm text-[#a8a8a8]" title={visibleStatusMessage}>{visibleStatusMessage}</div>
            <div className="flex items-center gap-3 border-t border-[#3a3a3a] px-4 py-3 text-xs text-[#8f8f8f]">
              <EngineIcon className="h-3.5 w-3.5 text-[#e4e4e4]" />
              <span>{visibleEngineLabel}</span>
              <span>{resolution.label}</span>
              <span className="max-w-[150px] truncate">{visibleSelectedCamera}</span>
              <span>{runtimePresentation.label}</span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ConnectionGuide({ config, message }: { config: ReturnType<typeof getDccEngineConfig>; message: string }) {
  const fallbackConfig = getDccEngineConfig(config.id);
  const pluginName = getVisiblePluginLabel(config.id, config.pluginName || fallbackConfig.pluginName);
  const guideMessage = getDisconnectedGuideMessage(config.id, message);
  return (
    <div className="absolute inset-0 flex flex-col justify-end bg-black/72 p-4 text-sm text-[#d7d7d7]">
      <div className="rounded-xl border border-white/10 bg-black/45 px-4 py-3 backdrop-blur-sm">
        <div className="flex items-center gap-2 text-sm font-semibold text-white"><MonitorUp className="h-4 w-4" />{pluginName}</div>
        <div className="mt-2 text-xs leading-5 text-[#d7d7d7]">{guideMessage}</div>
      </div>
    </div>
  );
}

function NativeSelect({ label, testId, value, disabled, onChange, options }: { label: string; testId?: string; value: string; disabled?: boolean; onChange: (value: string) => void; options: Array<{ value: string; label: string }> }) {
  return (
    <label data-dcc-interactive="true" onPointerDown={stopPointerPropagation} onMouseDown={stopPointerPropagation} className="nodrag nopan nowheel flex h-12 flex-col justify-center gap-1 rounded-lg border border-[#4a4a4a] bg-[#242424] px-3 text-xs text-[#cfcfcf]">
      <span className="flex items-center gap-1.5 font-semibold text-[#e8e8e8]"><ScanLine className="h-3.5 w-3.5" />{label}</span>
      <select data-dcc-interactive="true" data-testid={testId} value={value} disabled={disabled} onPointerDown={stopPointerPropagation} onMouseDown={stopPointerPropagation} onChange={(event) => onChange(event.target.value)} className="nodrag nopan nowheel w-full bg-transparent text-xs outline-none disabled:opacity-50">
        {options.map((item) => <option key={item.value} value={item.value} className="bg-[#242424] text-[#eeeeee]">{item.label}</option>)}
      </select>
    </label>
  );
}

function FrameInput({
  label,
  testId,
  value,
  onChange,
  commitDelayMs = 350,
}: {
  label: string;
  testId?: string;
  value: number;
  onChange: (value: string) => void;
  commitDelayMs?: number;
}) {
  const [text, setText] = useState(() => (value === undefined || value === null ? '' : String(value)));
  const editTimerRef = useRef<number | null>(null);
  const focusedRef = useRef(false);
  const lastCommittedRef = useRef<string>(text);

  // Keep local buffer in sync with external value, but never clobber an in-progress edit.
  useEffect(() => {
    const next = value === undefined || value === null ? '' : String(value);
    if (!focusedRef.current && next !== text) {
      setText(next);
      lastCommittedRef.current = next;
    }
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = useCallback(
    (raw: string) => {
      lastCommittedRef.current = raw;
      onChange(raw);
    },
    [onChange],
  );

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const raw = event.target.value;
      setText(raw);
      if (editTimerRef.current !== null) {
        window.clearTimeout(editTimerRef.current);
      }
      editTimerRef.current = window.setTimeout(() => {
        editTimerRef.current = null;
        commit(raw);
      }, commitDelayMs);
    },
    [commit, commitDelayMs],
  );

  const handleBlur = useCallback(() => {
    focusedRef.current = false;
    if (editTimerRef.current !== null) {
      window.clearTimeout(editTimerRef.current);
      editTimerRef.current = null;
    }
    if (text !== lastCommittedRef.current) {
      commit(text);
    }
  }, [commit, text]);

  const handleFocus = useCallback(() => {
    focusedRef.current = true;
  }, []);

  useEffect(() => {
    return () => {
      if (editTimerRef.current !== null) {
        window.clearTimeout(editTimerRef.current);
      }
    };
  }, []);

  return (
    <label data-dcc-interactive="true" onPointerDown={stopPointerPropagation} onMouseDown={stopPointerPropagation} className="nodrag nopan nowheel flex h-12 flex-col justify-center gap-1 rounded-lg border border-[#464646] bg-[#242424] px-3 text-xs text-[#9d9d9d]">
      <span>{label}</span>
      <input
        data-dcc-interactive="true"
        data-testid={testId}
        value={text}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onPointerDown={stopPointerPropagation}
        onMouseDown={stopPointerPropagation}
        onChange={handleChange}
        inputMode="numeric"
        className="nodrag nopan nowheel w-full bg-transparent text-sm font-semibold text-[#f1f1f1] outline-none"
      />
    </label>
  );
}

function ToolbarButton({ title, testId, disabled, onClick, children }: { title: string; testId?: string; disabled?: boolean; onClick?: () => void; children: import('react').ReactNode }) {
  return (
    <button
      type="button"
      data-dcc-interactive="true"
      data-testid={testId}
      disabled={disabled}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => { event.stopPropagation(); onClick?.(); }}
      className="flex h-9 w-9 items-center justify-center rounded-lg text-[#d7d7d7] transition-colors hover:bg-[#3a3a3a] disabled:cursor-not-allowed disabled:opacity-35"
      title={title}
    >
      {children}
    </button>
  );
}

function engineLabel(engine: DccEngine): string {
  return DCC_NODE_ENGINE_LABELS[engine];
}

export default DCCCaptureNode;

const handleLeft: CSSProperties = {
  left: -10,
  top: '50%',
  width: 20,
  height: 20,
  borderRadius: 999,
  border: '1px solid #5f5f5f',
  background: '#2b2b2b',
};

const handleRight: CSSProperties = {
  right: -10,
  top: '50%',
  width: 20,
  height: 20,
  borderRadius: 999,
  border: '1px solid #5f5f5f',
  background: '#2b2b2b',
};












