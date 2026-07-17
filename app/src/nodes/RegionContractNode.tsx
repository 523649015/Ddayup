import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  Crosshair,
  Image as ImageIcon,
  Link2,
  Plus,
  Tags,
  Trash2,
  Video,
} from 'lucide-react';
import { useGuardedFloatingPanelInteraction } from '@/hooks/useGuardedFloatingPanelInteraction';
import { useNodeFloatingPanel } from '@/hooks/useNodeFloatingPanel';
import { extractPersistedAssetIdFromUrl, resolvePersistedAssetLibraryUrl } from '@/api/assetLibrary';
import { toRenderableAssetUrl } from '@/services/generation';
import { ensureLocalMediaUrl } from '@/services/localMediaRegistry';
import { readRegionContract } from '@/services/regionContracts';
import { useCanvasStore } from '@/store/useCanvasStore';
import type {
  CanvasNode,
  RegionBinding,
  RegionBindingMode,
  RegionBindingRole,
  RegionEditIntent,
  RegionPackContract,
  RegionRect,
  RegionSpec,
  RegionStrictness,
  RegionTargetKind,
} from '@/types';
import { EditableNodeTitle } from './EditableNodeTitle';

type SourceMediaType = 'image' | 'video';
type ReferenceMediaType = 'image' | 'video' | 'text';
type DrawMode = 'box' | 'arrow' | 'brush';
type EditorMode = 'create' | 'edit';
type PanelStage = 'mode' | 'drawing' | 'edit';

interface SourceCandidate {
  nodeId: string;
  nodeLabel: string;
  url: string;
  persistedAssetId?: string;
  originalUrl?: string;
  filePath?: string;
  mediaType: SourceMediaType;
  sourceHandle?: string;
  width?: number;
  height?: number;
  duration?: number;
}

interface ReferenceCandidate {
  nodeId: string;
  nodeLabel: string;
  url: string;
  persistedAssetId?: string;
  originalUrl?: string;
  filePath?: string;
  mediaType: ReferenceMediaType;
  description?: string;
}

interface ArrowDraft {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

interface BrushDraftPoint {
  x: number;
  y: number;
  brushSize: number;
}

const REGION_REFERENCE_DRAG_MIME = 'application/x-hmdaodao-region-reference';

const REGION_TARGET_KIND_OPTIONS: Array<{ value: RegionTargetKind; label: string }> = [
  { value: 'subject', label: '主体' },
  { value: 'prop', label: '道具' },
  { value: 'companion', label: '陪体' },
  { value: 'background', label: '背景' },
  { value: 'custom', label: '自定义' },
];

const REGION_EDIT_INTENT_OPTIONS: Array<{ value: RegionEditIntent; label: string }> = [
  { value: 'replace_subject', label: '替换主体' },
  { value: 'insert_element', label: '插入元素' },
  { value: 'background_fuse', label: '背景融合' },
  { value: 'remove_and_fill', label: '移除并补全' },
];

const REGION_STRICTNESS_OPTIONS: Array<{ value: RegionStrictness; label: string }> = [
  { value: 'exact_transfer', label: '精确迁移' },
  { value: 'guided_generate', label: '引导生成' },
  { value: 'harmonize_only', label: '只做融合' },
];

const REGION_BINDING_MODE_OPTIONS: Array<{ value: RegionBindingMode; label: string }> = [
  { value: 'reference_required', label: '必须参考' },
  { value: 'reference_optional', label: '参考优先' },
  { value: 'text_only', label: '仅文字描述' },
];

const REGION_BINDING_ROLE_OPTIONS: Array<{ value: RegionBindingRole; label: string }> = [
  { value: 'subject-reference', label: '主体参考' },
  { value: 'element-reference', label: '元素参考' },
  { value: 'background-reference', label: '背景参考' },
  { value: 'style-reference', label: '风格参考' },
  { value: 'video-reference', label: '视频参考' },
];

const DRAW_MODE_OPTIONS: Array<{ value: DrawMode; label: string; description: string }> = [
  { value: 'box', label: '矩形框选', description: '适合锁定完整角色、道具或局部大区域。' },
  { value: 'arrow', label: '箭头标记', description: '适合指出替换重点、运动方向或局部细节。' },
  { value: 'brush', label: '手动涂抹', description: '适合沿角色轮廓手工描出，更利于精细替换。' },
];

function stopCanvasInteraction(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

function stopCanvasGesture(event: { stopPropagation: () => void; preventDefault?: () => void }) {
  event.preventDefault?.();
  event.stopPropagation();
}

function recordFrom(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function normalizePersistedAssetId(value: unknown, url?: string) {
  const explicit = typeof value === 'string' ? value.trim() : '';
  if (explicit) return explicit;
  return extractPersistedAssetIdFromUrl(url);
}

function readNodeMediaReference(node: CanvasNode | null | undefined, mediaType: 'image' | 'video') {
  const outputs = Array.isArray(node?.data?.outputs) ? node.data.outputs : [];
  const params = recordFrom(node?.data?.params);
  const directUrl = mediaType === 'image'
    ? (typeof node?.data?.imageUrl === 'string' ? node.data.imageUrl : '')
    : (typeof node?.data?.videoUrl === 'string' ? node.data.videoUrl : '');
  const primaryOutput = outputs.find((item) => item?.type === mediaType && typeof item.url === 'string' && item.url === directUrl)
    || outputs.find((item) => item?.type === mediaType && typeof item.url === 'string' && item.url)
    || null;
  const metadata = recordFrom(primaryOutput?.metadata);
  const persistedAssetId = normalizePersistedAssetId(
    metadata.persistedAssetId
      || (mediaType === 'image' ? params.capturePersistedAssetId : params.recordingPersistedAssetId)
      || params.sourcePersistedAssetId,
    directUrl || primaryOutput?.url,
  );
  return {
    url: resolvePersistedAssetLibraryUrl(directUrl || primaryOutput?.url || '', persistedAssetId),
    persistedAssetId: persistedAssetId || undefined,
    originalUrl: typeof metadata.originalUrl === 'string'
      ? metadata.originalUrl
      : typeof params.sourceOriginalUrl === 'string'
        ? params.sourceOriginalUrl
        : mediaType === 'image' && typeof params.captureOriginalUrl === 'string'
          ? params.captureOriginalUrl
          : mediaType === 'video' && typeof params.recordingOriginalUrl === 'string'
            ? params.recordingOriginalUrl
            : undefined,
    filePath: typeof metadata.filePath === 'string'
      ? metadata.filePath
      : typeof params.sourceFilePath === 'string'
        ? params.sourceFilePath
        : undefined,
  };
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function clampFrame(value: unknown, fallback: number) {
  const next = Math.round(Number(value));
  if (!Number.isFinite(next)) return fallback;
  return Math.max(0, next);
}

function serializeContract(contract: RegionPackContract | null | undefined) {
  if (!contract) return '';
  try {
    return JSON.stringify(contract);
  } catch {
    return '';
  }
}

function makeRegionId() {
  return `region-${Math.random().toString(36).slice(2, 8)}`;
}

function makeSlotId() {
  return `slot-${Math.random().toString(36).slice(2, 8)}`;
}

function cloneRegion(region: RegionSpec): RegionSpec {
  return {
    ...region,
    geometry: {
      ...region.geometry,
      rect: { ...region.geometry.rect },
      maskPoints: region.geometry.maskPoints?.map((point) => ({ ...point })),
    },
    bindings: region.bindings.map((binding) => ({ ...binding })),
    frameRange: region.frameRange ? { ...region.frameRange } : undefined,
    keyframes: region.keyframes?.map((keyframe) => ({
      ...keyframe,
      rect: { ...keyframe.rect },
    })),
    track: region.track
      ? {
          ...region.track,
          keyframes: region.track.keyframes.map((keyframe) => ({
            ...keyframe,
            rect: { ...keyframe.rect },
          })),
        }
      : undefined,
  };
}

function makeEmptyContract(mediaType: SourceMediaType): RegionPackContract {
  return {
    version: 'region-contract-v1',
    source: { url: '', mediaType },
    regions: [],
    bindings: [],
    executionPlan: { orderedRegionIds: [], strategy: 'region-contract-v1' },
    consistencyRequirements: [],
    fallbackPolicy: 'reject',
    summary: '',
    generatedAt: Date.now(),
  };
}

function buildDefaultRegion(rect: RegionRect, mediaType: SourceMediaType, index: number): RegionSpec {
  return {
    regionId: makeRegionId(),
    label: `标签 ${index}`,
    geometry: { rect },
    targetKind: 'custom',
    editIntent: 'insert_element',
    description: '',
    strictness: 'guided_generate',
    bindingMode: 'reference_optional',
    bindings: [],
    enabled: true,
    ...(mediaType === 'video'
      ? {
          frameRange: { startFrame: 0, endFrame: 24 },
          track: {
            mode: 'static' as const,
            startFrame: 0,
            endFrame: 24,
            keyframes: [
              { frame: 0, rect },
              { frame: 24, rect },
            ],
            occlusionPolicy: 'hold' as const,
          },
        }
      : {}),
  };
}

function pickBindingRole(candidate: ReferenceCandidate, region: RegionSpec): RegionBindingRole {
  if (candidate.mediaType === 'video') return 'video-reference';
  if (region.targetKind === 'background' || region.editIntent === 'background_fuse') return 'background-reference';
  if (candidate.mediaType === 'text') return 'style-reference';
  if (region.targetKind === 'prop' || region.editIntent === 'insert_element') return 'element-reference';
  return 'subject-reference';
}

function buildConsistencyRequirements(contract: RegionPackContract) {
  const requirements = new Set<string>();
  requirements.add(contract.source.mediaType === 'video' ? 'preserve_camera_motion' : 'preserve_composition');
  contract.regions.forEach((region) => {
    if (region.strictness === 'exact_transfer') requirements.add('preserve_subject_detail');
    if (region.editIntent === 'background_fuse') requirements.add('background_depth_consistency');
    if (region.bindings.some((binding) => binding.preserveDetail)) requirements.add('reference_detail_lock');
    if (region.track && region.track.mode !== 'static') requirements.add('temporal_region_consistency');
  });
  return Array.from(requirements);
}

function regionSummary(contract: RegionPackContract) {
  const enabledRegions = contract.regions.filter((region) => region.enabled !== false);
  const labels = enabledRegions.slice(0, 4).map((region) => region.label).filter(Boolean);
  const headline = [
    contract.source.mediaType === 'video' ? '视频打标签' : '图片打标签',
    `${enabledRegions.length} 个标签`,
    enabledRegions.some((region) => region.strictness === 'exact_transfer') ? '含精确迁移' : '',
    enabledRegions.some((region) => region.editIntent === 'background_fuse') ? '含背景融合' : '',
  ].filter(Boolean);
  return labels.length > 0 ? `${headline.join(' · ')} · ${labels.join(' / ')}` : headline.join(' · ');
}

function finalizeContract(base: RegionPackContract, source: SourceCandidate | null): RegionPackContract {
  const regions = base.regions.map((region) => cloneRegion(region));
  const resolvedSource = source
      ? {
          nodeId: source.nodeId,
          nodeLabel: source.nodeLabel,
          url: source.url,
          persistedAssetId: source.persistedAssetId,
          originalUrl: source.originalUrl,
          filePath: source.filePath,
          mediaType: source.mediaType,
          width: source.width,
          height: source.height,
        duration: source.duration,
      }
    : base.source?.url
      ? base.source
      : {
          url: '',
          mediaType: 'image' as const,
        };

  const nextContract: RegionPackContract = {
    version: base.version || 'region-contract-v1',
    source: resolvedSource,
    regions,
    bindings: regions.flatMap((region) => region.bindings),
    executionPlan: {
      orderedRegionIds: regions.map((region) => region.regionId),
      strategy: 'region-contract-v1',
    },
    consistencyRequirements: buildConsistencyRequirements({
      ...base,
      source: resolvedSource,
      regions,
    }),
    fallbackPolicy: base.fallbackPolicy || 'reject',
    summary: '',
    generatedAt: base.generatedAt || 0,
  };
  nextContract.summary = regionSummary(nextContract);
  return nextContract;
}

function readNodeLabel(node: CanvasNode | null | undefined, fallback: string) {
  const label = typeof node?.data?.label === 'string' ? node.data.label.trim() : '';
  return label || fallback;
}

function readImageMeta(node: CanvasNode | null | undefined) {
  const params = recordFrom(node?.data?.params);
  const meta = recordFrom(params.imageMeta);
  return {
    width: Number(meta.width || 0) || undefined,
    height: Number(meta.height || 0) || undefined,
  };
}

function readVideoMeta(node: CanvasNode | null | undefined) {
  const params = recordFrom(node?.data?.params);
  const meta = recordFrom(params.videoMeta);
  return {
    width: Number(meta.width || 0) || undefined,
    height: Number(meta.height || 0) || undefined,
    duration: Number(meta.duration || node?.data?.duration || 0) || undefined,
  };
}

function resolveSourceHandleForNode(node: CanvasNode | null | undefined) {
  if (!node) return 'media-output';
  if (node.type === 'dcc') return 'dcc-output';
  if (node.type === 'region') return 'region-output';
  return 'media-output';
}

function extractSourceCandidate(node: CanvasNode | null | undefined, preferredMediaType: SourceMediaType): SourceCandidate | null {
  if (!node) return null;
  const imageReference = readNodeMediaReference(node, 'image');
  const videoReference = readNodeMediaReference(node, 'video');
  const imageUrl = imageReference.url;
  const videoUrl = videoReference.url;
  const preferVideo = preferredMediaType === 'video';
  const pickedType: SourceMediaType | null = preferVideo
    ? (videoUrl ? 'video' : imageUrl ? 'image' : null)
    : (imageUrl ? 'image' : videoUrl ? 'video' : null);

  if (!pickedType) return null;

  const meta = pickedType === 'video' ? readVideoMeta(node) : readImageMeta(node);
  return {
    nodeId: node.id,
    nodeLabel: readNodeLabel(node, pickedType === 'video' ? '视频基底' : '图片基底'),
    url: pickedType === 'video' ? videoUrl : imageUrl,
    persistedAssetId: pickedType === 'video' ? videoReference.persistedAssetId : imageReference.persistedAssetId,
    originalUrl: pickedType === 'video' ? videoReference.originalUrl : imageReference.originalUrl,
    filePath: pickedType === 'video' ? videoReference.filePath : imageReference.filePath,
    mediaType: pickedType,
    width: meta.width,
    height: meta.height,
    duration: 'duration' in meta && typeof meta.duration === 'number' ? meta.duration : undefined,
  };
}

function readEmbeddedSourceCandidate(
  nodeId: string,
  data: NodeProps['data'],
  preferredMediaType: SourceMediaType,
  contractSource?: RegionPackContract['source'],
): SourceCandidate | null {
  const imageUrl = typeof data?.imageUrl === 'string' && data.imageUrl ? data.imageUrl : '';
  const videoUrl = typeof data?.videoUrl === 'string' && data.videoUrl ? data.videoUrl : '';
  const preferVideo = preferredMediaType === 'video';
  const pickedType: SourceMediaType | null = preferVideo
    ? (videoUrl ? 'video' : imageUrl ? 'image' : null)
    : (imageUrl ? 'image' : videoUrl ? 'video' : null);

  if (pickedType) {
    const params = recordFrom(data?.params);
    const meta = recordFrom(pickedType === 'video' ? params.videoMeta : params.imageMeta);
    const rawUrl = pickedType === 'video' ? videoUrl : imageUrl;
    const persistedAssetId = normalizePersistedAssetId(
      params.sourcePersistedAssetId
        || (pickedType === 'image' ? params.capturePersistedAssetId : params.recordingPersistedAssetId),
      rawUrl,
    );
    return {
      nodeId,
      nodeLabel: typeof data?.label === 'string' && data.label.trim()
        ? data.label.trim()
        : pickedType === 'video'
          ? '视频打标签节点'
          : '图片打标签节点',
      url: resolvePersistedAssetLibraryUrl(rawUrl, persistedAssetId),
      persistedAssetId: persistedAssetId || undefined,
      originalUrl: typeof params.sourceOriginalUrl === 'string'
        ? params.sourceOriginalUrl
        : pickedType === 'image' && typeof params.captureOriginalUrl === 'string'
          ? params.captureOriginalUrl
          : pickedType === 'video' && typeof params.recordingOriginalUrl === 'string'
            ? params.recordingOriginalUrl
            : undefined,
      filePath: typeof params.sourceFilePath === 'string' ? params.sourceFilePath : undefined,
      mediaType: pickedType,
      width: Number(meta.width || 0) || undefined,
      height: Number(meta.height || 0) || undefined,
      duration: Number(meta.duration || data?.duration || 0) || undefined,
    };
  }

  if (!contractSource?.url) return null;
  return {
    nodeId,
    nodeLabel: typeof data?.label === 'string' && data.label.trim()
      ? data.label.trim()
      : contractSource.mediaType === 'video'
        ? '视频打标签节点'
        : '图片打标签节点',
    url: resolvePersistedAssetLibraryUrl(contractSource.url, contractSource.persistedAssetId),
    persistedAssetId: contractSource.persistedAssetId,
    originalUrl: contractSource.originalUrl,
    filePath: contractSource.filePath,
    mediaType: contractSource.mediaType === 'video' ? 'video' : 'image',
    width: Number(contractSource.width || 0) || undefined,
    height: Number(contractSource.height || 0) || undefined,
    duration: Number(contractSource.duration || 0) || undefined,
  };
}

function extractReferenceCandidate(node: CanvasNode | null | undefined): ReferenceCandidate | null {
  if (!node) return null;

  const imageReference = readNodeMediaReference(node, 'image');
  const videoReference = readNodeMediaReference(node, 'video');
  const imageUrl = imageReference.url;
  const videoUrl = videoReference.url;

  if (imageUrl) {
    return {
      nodeId: node.id,
      nodeLabel: readNodeLabel(node, '图片参考'),
      url: imageUrl,
      persistedAssetId: imageReference.persistedAssetId,
      originalUrl: imageReference.originalUrl,
      filePath: imageReference.filePath,
      mediaType: 'image',
    };
  }

  if (videoUrl) {
    return {
      nodeId: node.id,
      nodeLabel: readNodeLabel(node, '视频参考'),
      url: videoUrl,
      persistedAssetId: videoReference.persistedAssetId,
      originalUrl: videoReference.originalUrl,
      filePath: videoReference.filePath,
      mediaType: 'video',
    };
  }

  const text = typeof node.data?.content === 'string' && node.data.content.trim()
    ? node.data.content.trim()
    : typeof node.data?.prompt === 'string' && node.data.prompt.trim()
      ? node.data.prompt.trim()
      : '';
  if (!text) return null;

  return {
    nodeId: node.id,
    nodeLabel: readNodeLabel(node, '文字说明'),
    url: `text://${node.id}`,
    mediaType: 'text',
    description: text,
  };
}

function formatPercent(value: number) {
  return `${Math.round(clamp01(value) * 100)}%`;
}

function toDraftRect(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  bounds: DOMRect,
): RegionRect {
  const x0 = clamp01(Math.min(startX, endX) / Math.max(bounds.width, 1));
  const y0 = clamp01(Math.min(startY, endY) / Math.max(bounds.height, 1));
  const x1 = clamp01(Math.max(startX, endX) / Math.max(bounds.width, 1));
  const y1 = clamp01(Math.max(startY, endY) / Math.max(bounds.height, 1));
  return {
    x: x0,
    y: y0,
    width: Math.max(0.02, x1 - x0),
    height: Math.max(0.02, y1 - y0),
  };
}

function hasArrowMarker(region: RegionSpec) {
  return Array.isArray(region.geometry.maskPoints) && region.geometry.maskPoints.length === 2;
}

function hasBrushMarker(region: RegionSpec) {
  return Array.isArray(region.geometry.maskPoints) && region.geometry.maskPoints.length > 2;
}

function regionDrawMode(region: RegionSpec): DrawMode {
  if (hasBrushMarker(region)) return 'brush';
  if (hasArrowMarker(region)) return 'arrow';
  return 'box';
}

function buildDefaultBrushPoints(rect: RegionRect): BrushDraftPoint[] {
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const size = 18;
  return [
    { x: clamp01(rect.x + rect.width * 0.2), y: clamp01(centerY), brushSize: size },
    { x: clamp01(rect.x + rect.width * 0.38), y: clamp01(rect.y + rect.height * 0.28), brushSize: size },
    { x: clamp01(centerX), y: clamp01(centerY), brushSize: size },
    { x: clamp01(rect.x + rect.width * 0.68), y: clamp01(rect.y + rect.height * 0.72), brushSize: size },
    { x: clamp01(rect.x + rect.width * 0.82), y: clamp01(rect.y + rect.height * 0.42), brushSize: size },
  ];
}

function brushPointsToRect(points: BrushDraftPoint[]): RegionRect {
  if (!points.length) {
    return { x: 0.4, y: 0.4, width: 0.2, height: 0.2 };
  }
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const padding = Math.max(0.02, Math.min(0.08, Math.max(...points.map((point) => (point.brushSize || 18) / 300))));
  const x0 = clamp01(Math.min(...xs) - padding);
  const y0 = clamp01(Math.min(...ys) - padding);
  const x1 = clamp01(Math.max(...xs) + padding);
  const y1 = clamp01(Math.max(...ys) + padding);
  return {
    x: x0,
    y: y0,
    width: Math.max(0.02, x1 - x0),
    height: Math.max(0.02, y1 - y0),
  };
}

function applyRegionDrawMode(region: RegionSpec, mode: DrawMode): RegionSpec {
  if (mode === 'box') {
    return {
      ...region,
      geometry: {
        ...region.geometry,
        maskPoints: undefined,
      },
    };
  }
  if (mode === 'arrow') {
    const points = region.geometry.maskPoints || [];
    const start = points[0] || {
      x: clamp01(region.geometry.rect.x + region.geometry.rect.width * 0.22),
      y: clamp01(region.geometry.rect.y + region.geometry.rect.height * 0.28),
      brushSize: 18,
    };
    const end = points[points.length - 1] || {
      x: clamp01(region.geometry.rect.x + region.geometry.rect.width * 0.78),
      y: clamp01(region.geometry.rect.y + region.geometry.rect.height * 0.72),
      brushSize: 18,
    };
    return {
      ...region,
      geometry: {
        ...region.geometry,
        maskPoints: [start, end],
      },
    };
  }
  return {
    ...region,
    geometry: {
      ...region.geometry,
      maskPoints: hasBrushMarker(region) ? region.geometry.maskPoints : buildDefaultBrushPoints(region.geometry.rect),
    },
  };
}

function applyRegionTrackBounds(region: RegionSpec) {
  if (!region.track && !region.frameRange) return region;
  const startFrame = region.frameRange?.startFrame ?? region.track?.startFrame ?? 0;
  const endFrame = Math.max(startFrame, region.frameRange?.endFrame ?? region.track?.endFrame ?? 24);
  return {
    ...region,
    frameRange: { startFrame, endFrame },
    track: {
      mode: region.track?.mode || 'static',
      startFrame,
      endFrame,
      keyframes: [
        { frame: startFrame, rect: region.geometry.rect },
        { frame: endFrame, rect: region.geometry.rect },
      ],
      occlusionPolicy: region.track?.occlusionPolicy || 'hold',
    },
  };
}

function finalizeRegionDraft(region: RegionSpec) {
  const trimmedDescription = region.description.trim();
  const trimmedNegativePrompt = region.negativePrompt?.trim() || '';
  const hasBindings = region.bindings.length > 0;
  let bindingMode = region.bindingMode;

  if (!hasBindings && trimmedDescription) {
    bindingMode = 'text_only';
  } else if (hasBindings && bindingMode === 'text_only') {
    bindingMode = 'reference_optional';
  }

  return applyRegionTrackBounds({
    ...region,
    label: region.label.trim() || region.label,
    description: trimmedDescription,
    negativePrompt: trimmedNegativePrompt || undefined,
    bindingMode,
  });
}

function drawModeLabel(drawMode: DrawMode | null) {
  if (drawMode === 'arrow') return '箭头标记';
  if (drawMode === 'brush') return '手动涂抹';
  if (drawMode === 'box') return '矩形框选';
  return '未选择';
}

export function RegionContractNode(props: NodeProps) {
  const { id, data, selected } = props;
  const addEdge = useCanvasStore((state) => state.addEdge);
  const removeEdge = useCanvasStore((state) => state.removeEdge);
  const selectedNodeIds = useCanvasStore((state) => state.selectedNodeIds);
  const setSelectedNodeIds = useCanvasStore((state) => state.setSelectedNodeIds);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const canvas = useCanvasStore((state) => state.canvas);

  const previewRef = useRef<HTMLDivElement | null>(null);
  const nodeShellRef = useRef<HTMLDivElement | null>(null);
  const drawingStartRef = useRef<{ x: number; y: number; mode: DrawMode } | null>(null);
  const persistedSignatureRef = useRef('');
  const selectionSyncTimersRef = useRef<number[]>([]);

  const currentParams = recordFrom(data?.params);
  const preferredMediaType: SourceMediaType = String(currentParams.sourceMediaType || 'image') === 'video' ? 'video' : 'image';

  const {
    ensureFocused,
    sustainInteraction,
  } = useGuardedFloatingPanelInteraction(id);
  const {
    activeKind: activeFloatingPanelKind,
    open: openFloatingPanel,
    close: closeFloatingPanel,
  } = useNodeFloatingPanel<'tagging-editor'>(id, ensureFocused);
  const taggingPanelOpen = activeFloatingPanelKind === 'tagging-editor';
  const isNodeSelected = selected || selectedNodeIds.includes(id);

  const [contract, setContract] = useState<RegionPackContract>(() => {
    const saved = readRegionContract(currentParams.regionContract);
    return saved || makeEmptyContract(preferredMediaType);
  });
  const [selectedRegionId, setSelectedRegionId] = useState('');
  const [resolvedPreviewUrl, setResolvedPreviewUrl] = useState('');
  const [selectedDrawMode, setSelectedDrawMode] = useState<DrawMode>('box');
  const [drawMode, setDrawMode] = useState<DrawMode | null>(null);
  const [draftRect, setDraftRect] = useState<RegionRect | null>(null);
  const [draftArrow, setDraftArrow] = useState<ArrowDraft | null>(null);
  const [draftBrushPoints, setDraftBrushPoints] = useState<BrushDraftPoint[]>([]);
  const [referenceDropActive, setReferenceDropActive] = useState(false);
  const [panelStage, setPanelStage] = useState<PanelStage>('mode');
  const [editorMode, setEditorMode] = useState<EditorMode | null>(null);
  const [editorRegion, setEditorRegion] = useState<RegionSpec | null>(null);
  const [panelSide, setPanelSide] = useState<'left' | 'right'>('right');

  const connectedEdges = useMemo(
    () => (canvas?.edges || []).filter((edge) => edge.target === id),
    [canvas?.edges, id],
  );

  const sourceCandidates = useMemo(
    () => connectedEdges
      .filter((edge) => String(edge.targetHandle || '') === 'region-main')
      .map((edge) => extractSourceCandidate((canvas?.nodes || []).find((node) => node.id === edge.source), preferredMediaType))
      .filter((item): item is SourceCandidate => Boolean(item)),
    [canvas?.nodes, connectedEdges, preferredMediaType],
  );

  const embeddedSource = useMemo(
    () => readEmbeddedSourceCandidate(id, data, preferredMediaType, contract.source),
    [contract.source, data, id, preferredMediaType],
  );
  const baseSource = sourceCandidates[0] || embeddedSource || null;

  const referenceCandidates = useMemo(
    () => connectedEdges
      .filter((edge) => {
        const targetHandle = String(edge.targetHandle || '');
        return targetHandle === 'region-image-reference'
          || targetHandle === 'region-video-reference';
      })
      .map((edge) => extractReferenceCandidate((canvas?.nodes || []).find((node) => node.id === edge.source)))
      .filter((item): item is ReferenceCandidate => Boolean(item)),
    [canvas?.nodes, connectedEdges],
  );

  const availableReferenceCandidates = useMemo(
    () => (canvas?.nodes || [])
      .filter((node) => node.id !== id && node.id !== baseSource?.nodeId)
      .map((node) => extractReferenceCandidate(node))
      .filter((item): item is ReferenceCandidate => Boolean(item))
      .filter((candidate, index, all) => (
        all.findIndex((item) => item.nodeId === candidate.nodeId && item.url === candidate.url) === index
      )),
    [baseSource?.nodeId, canvas?.nodes, id],
  );

  const referencePoolCandidates = useMemo(
    () => {
      const combined = [...referenceCandidates, ...availableReferenceCandidates];
      return combined.filter((candidate, index, all) => (
        all.findIndex((item) => item.nodeId === candidate.nodeId && item.url === candidate.url) === index
      ));
    },
    [availableReferenceCandidates, referenceCandidates],
  );

  const availableBaseCandidates = useMemo(
    () => (canvas?.nodes || [])
      .filter((node) => node.id !== id)
      .map((node) => extractSourceCandidate(node, preferredMediaType))
      .filter((item): item is SourceCandidate => Boolean(item))
      .filter((candidate, index, all) => (
        all.findIndex((item) => item.nodeId === candidate.nodeId && item.mediaType === candidate.mediaType) === index
      )),
    [canvas?.nodes, id, preferredMediaType],
  );

  const externalContract = useMemo(
    () => readRegionContract(currentParams.regionContract),
    [currentParams.regionContract],
  );
  const contractSignature = useMemo(() => serializeContract(contract), [contract]);
  const externalSignature = useMemo(() => serializeContract(externalContract), [externalContract]);

  useEffect(() => {
    if (!externalContract || !externalSignature) return;
    if (externalSignature === contractSignature) return;
    if (externalSignature === persistedSignatureRef.current) return;
    setContract(externalContract);
  }, [contractSignature, externalContract, externalSignature]);

  const effectiveContract = useMemo(
    () => finalizeContract(contract, baseSource),
    [baseSource, contract],
  );
  const effectiveSignature = useMemo(() => serializeContract(effectiveContract), [effectiveContract]);

  useEffect(() => {
    let cancelled = false;
    const rawUrl = String(baseSource?.url || '').trim();
    const mediaType = baseSource?.mediaType || 'image';
    const initialUrl = toRenderableAssetUrl(rawUrl, mediaType);

    if (initialUrl) {
      setResolvedPreviewUrl(initialUrl);
      return () => {
        cancelled = true;
      };
    }

    setResolvedPreviewUrl('');
    if (!rawUrl) {
      return () => {
        cancelled = true;
      };
    }

    void ensureLocalMediaUrl(rawUrl).then((resolvedUrl) => {
      if (cancelled) return;
      setResolvedPreviewUrl(toRenderableAssetUrl(resolvedUrl || rawUrl, mediaType) || resolvedUrl || '');
    });

    return () => {
      cancelled = true;
    };
  }, [baseSource?.mediaType, baseSource?.url]);

  useEffect(() => {
    if (effectiveSignature === persistedSignatureRef.current) return;
    persistedSignatureRef.current = effectiveSignature;

    const latestNode = useCanvasStore.getState().getNodeById(id);
    const latestParams = recordFrom(latestNode?.data?.params);
    updateNodeData(id, {
      status: effectiveContract.source.url
        ? (effectiveContract.regions.length > 0 ? 'completed' : 'idle')
        : 'idle',
      content: effectiveContract.summary,
      imageUrl: effectiveContract.source.mediaType === 'image' ? effectiveContract.source.url : '',
      videoUrl: effectiveContract.source.mediaType === 'video' ? effectiveContract.source.url : '',
      outputs: [{
        id: `region-pack-${id}`,
        type: 'text',
        url: `region-pack://${id}`,
        metadata: { regionContract: effectiveContract },
      }],
      params: {
        ...latestParams,
        sourceMediaType: effectiveContract.source.mediaType,
        regionContract: effectiveContract,
      },
    });
  }, [effectiveContract, effectiveSignature, id, updateNodeData]);

  useEffect(() => {
    if (!selectedRegionId && effectiveContract.regions[0]) {
      setSelectedRegionId(effectiveContract.regions[0].regionId);
      return;
    }
    if (selectedRegionId && !effectiveContract.regions.some((region) => region.regionId === selectedRegionId)) {
      setSelectedRegionId(effectiveContract.regions[0]?.regionId || '');
    }
  }, [effectiveContract.regions, selectedRegionId]);

  useEffect(() => {
    if (!taggingPanelOpen) return;

    const updatePanelSide = () => {
      const bounds = nodeShellRef.current?.getBoundingClientRect();
      if (!bounds) return;

      const panelWidth = 420;
      const gap = 16;
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
      const spaceRight = viewportWidth - bounds.right;
      const spaceLeft = bounds.left;

      if (spaceRight >= panelWidth + gap || spaceRight >= spaceLeft) {
        setPanelSide('right');
        return;
      }

      setPanelSide('left');
    };

    updatePanelSide();
    window.addEventListener('resize', updatePanelSide);
    return () => window.removeEventListener('resize', updatePanelSide);
  }, [taggingPanelOpen]);

  const selectedRegion = effectiveContract.regions.find((region) => region.regionId === selectedRegionId) || null;

  useEffect(() => () => {
    if (selectionSyncTimersRef.current.length === 0) return;
    selectionSyncTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
    selectionSyncTimersRef.current = [];
  }, []);

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

  function patchContract(updater: (previous: RegionPackContract) => RegionPackContract) {
    setContract((previous) => {
      const next = updater(previous);
      return {
        ...next,
        generatedAt: Date.now(),
      };
    });
  }

  function openTaggingPanel() {
    sustainInteraction();
    openFloatingPanel('tagging-editor');
    setPanelStage('mode');
    setDrawMode(null);
    setDraftRect(null);
    setDraftArrow(null);
    setDraftBrushPoints([]);
    setEditorMode(null);
    setEditorRegion(null);
  }

  function keepPanelFocused(event: { stopPropagation: () => void }) {
    sustainInteraction();
    event.stopPropagation();
  }

  function closeTaggingPanel() {
    closeFloatingPanel('tagging-editor');
    setDrawMode(null);
    setDraftRect(null);
    setDraftArrow(null);
    setDraftBrushPoints([]);
    setPanelStage('mode');
    if (editorMode === 'create') {
      setEditorMode(null);
      setEditorRegion(null);
    }
  }

  function startDraw(nextMode: DrawMode) {
    sustainInteraction();
    openFloatingPanel('tagging-editor');
    setSelectedDrawMode(nextMode);
    setDrawMode(nextMode);
    setPanelStage('drawing');
    setEditorMode('create');
    setEditorRegion(null);
    setDraftRect(null);
    setDraftArrow(null);
    setDraftBrushPoints([]);
  }

  function openEditorForCreate(rect: RegionRect, mode: DrawMode, arrow?: ArrowDraft | null, brushPoints?: BrushDraftPoint[]) {
    const nextRegion = buildDefaultRegion(
      rect,
      baseSource?.mediaType || preferredMediaType,
      effectiveContract.regions.length + 1,
    );
    if (mode === 'arrow' && arrow) {
      nextRegion.geometry.maskPoints = [
        { x: clamp01(arrow.startX), y: clamp01(arrow.startY), brushSize: 18 },
        { x: clamp01(arrow.endX), y: clamp01(arrow.endY), brushSize: 18 },
      ];
    }
    if (mode === 'brush' && brushPoints && brushPoints.length >= 2) {
      nextRegion.geometry.maskPoints = brushPoints.map((point) => ({
        x: clamp01(point.x),
        y: clamp01(point.y),
        brushSize: point.brushSize || 18,
      }));
    }
    setSelectedRegionId(nextRegion.regionId);
    setEditorMode('create');
    setEditorRegion(nextRegion);
    setPanelStage('edit');
    setDrawMode(null);
    sustainInteraction();
    openFloatingPanel('tagging-editor');
  }

  function openEditorForEdit(region: RegionSpec) {
    setSelectedRegionId(region.regionId);
    setEditorMode('edit');
    setEditorRegion(cloneRegion(region));
    setSelectedDrawMode(regionDrawMode(region));
    setPanelStage('edit');
    setDrawMode(null);
    sustainInteraction();
    openFloatingPanel('tagging-editor');
  }

  function updateEditorRegion(updater: (region: RegionSpec) => RegionSpec) {
    setEditorRegion((previous) => (previous ? updater(previous) : previous));
  }

  function updateEditorDrawMode(nextMode: DrawMode) {
    setSelectedDrawMode(nextMode);
    updateEditorRegion((region) => applyRegionDrawMode(region, nextMode));
  }

  function confirmEditor() {
    if (!editorRegion) return;
    const finalizedRegion = finalizeRegionDraft(editorRegion);
    patchContract((previous) => {
      if (editorMode === 'edit') {
        return {
          ...previous,
          regions: previous.regions.map((region) => (
            region.regionId === finalizedRegion.regionId ? cloneRegion(finalizedRegion) : region
          )),
        };
      }
      return {
        ...previous,
        regions: [...previous.regions, cloneRegion(finalizedRegion)],
      };
    });
    setSelectedRegionId(finalizedRegion.regionId);
    setEditorMode(null);
    setEditorRegion(null);
    setPanelStage('mode');
    closeFloatingPanel('tagging-editor');
  }

  function removeRegion(regionId: string) {
    patchContract((previous) => ({
      ...previous,
      regions: previous.regions.filter((region) => region.regionId !== regionId),
    }));
    if (selectedRegionId === regionId) {
      setSelectedRegionId('');
    }
    if (editorRegion?.regionId === regionId) {
      setEditorRegion(null);
      setEditorMode(null);
      setPanelStage('mode');
      closeFloatingPanel('tagging-editor');
    }
  }

  function toggleEditorBinding(candidate: ReferenceCandidate) {
    updateEditorRegion((region) => {
      const existing = region.bindings.find((binding) => (
        binding.sourceNodeId === candidate.nodeId && binding.sourceAssetUrl === candidate.url
      ));
      if (existing) {
        return {
          ...region,
          bindings: region.bindings.filter((binding) => binding.slotId !== existing.slotId),
        };
      }

      const nextBinding: RegionBinding = {
        slotId: makeSlotId(),
        sourceNodeId: candidate.nodeId,
        sourceAssetUrl: candidate.url,
        sourcePersistedAssetId: candidate.persistedAssetId,
        sourceOriginalUrl: candidate.originalUrl,
        sourceFilePath: candidate.filePath,
        sourceMediaType: candidate.mediaType,
        bindingRole: pickBindingRole(candidate, region),
        preserveDetail: true,
        weight: 90,
        sourceLabel: candidate.nodeLabel,
        description: candidate.description,
      };

      return {
        ...region,
        bindings: [...region.bindings, nextBinding],
      };
    });
  }

  function addEditorBinding(candidate: ReferenceCandidate) {
    updateEditorRegion((region) => {
      const existing = region.bindings.find((binding) => (
        binding.sourceNodeId === candidate.nodeId && binding.sourceAssetUrl === candidate.url
      ));
      if (existing) return region;

      const nextBinding: RegionBinding = {
        slotId: makeSlotId(),
        sourceNodeId: candidate.nodeId,
        sourceAssetUrl: candidate.url,
        sourcePersistedAssetId: candidate.persistedAssetId,
        sourceOriginalUrl: candidate.originalUrl,
        sourceFilePath: candidate.filePath,
        sourceMediaType: candidate.mediaType,
        bindingRole: pickBindingRole(candidate, region),
        preserveDetail: true,
        weight: 90,
        sourceLabel: candidate.nodeLabel,
        description: candidate.description,
      };

      return {
        ...region,
        bindings: [...region.bindings, nextBinding],
      };
    });
  }

  function handleReferenceDragStart(event: ReactDragEvent<HTMLButtonElement>, candidate: ReferenceCandidate) {
    stopCanvasGesture(event);
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData(REGION_REFERENCE_DRAG_MIME, JSON.stringify({
      nodeId: candidate.nodeId,
      url: candidate.url,
    }));
    sustainInteraction();
  }

  function findDraggedReferenceCandidate(event: ReactDragEvent<HTMLDivElement>) {
    const raw = event.dataTransfer.getData(REGION_REFERENCE_DRAG_MIME);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { nodeId?: string; url?: string };
      return referencePoolCandidates.find((candidate) => (
        candidate.nodeId === parsed.nodeId && candidate.url === parsed.url
      )) || null;
    } catch {
      return null;
    }
  }

  function handleReferenceDragOver(event: ReactDragEvent<HTMLDivElement>) {
    const candidate = findDraggedReferenceCandidate(event);
    if (!candidate) return;
    stopCanvasGesture(event);
    event.dataTransfer.dropEffect = 'copy';
    setReferenceDropActive(true);
  }

  function handleReferenceDragLeave(event: ReactDragEvent<HTMLDivElement>) {
    stopCanvasInteraction(event);
    setReferenceDropActive(false);
  }

  function handleReferenceDrop(event: ReactDragEvent<HTMLDivElement>) {
    const candidate = findDraggedReferenceCandidate(event);
    stopCanvasGesture(event);
    setReferenceDropActive(false);
    if (!candidate) return;
    addEditorBinding(candidate);
  }

  function connectBaseCandidate(candidate: SourceCandidate) {
    sustainInteraction();
    connectedEdges
      .filter((edge) => String(edge.targetHandle || '') === 'region-main')
      .forEach((edge) => removeEdge(edge.id));
    addEdge(candidate.nodeId, id, {
      sourceHandle: resolveSourceHandleForNode((canvas?.nodes || []).find((node) => node.id === candidate.nodeId)),
      targetHandle: 'region-main',
    });
  }

  function handlePreviewPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!previewRef.current || !baseSource?.url || !drawMode) return;
    if ((event.target as HTMLElement)?.dataset?.regionBox === 'true') return;
    stopCanvasGesture(event);
    previewRef.current.setPointerCapture?.(event.pointerId);

    const bounds = previewRef.current.getBoundingClientRect();
    const offsetX = event.clientX - bounds.left;
    const offsetY = event.clientY - bounds.top;
    drawingStartRef.current = { x: offsetX, y: offsetY, mode: drawMode };
    const normalizedPoint = {
      x: clamp01(offsetX / Math.max(bounds.width, 1)),
      y: clamp01(offsetY / Math.max(bounds.height, 1)),
      brushSize: 18,
    };

    setDraftRect({
      x: clamp01(offsetX / Math.max(bounds.width, 1)),
      y: clamp01(offsetY / Math.max(bounds.height, 1)),
      width: 0.02,
      height: 0.02,
    });
    setDraftArrow({
      startX: clamp01(offsetX / Math.max(bounds.width, 1)),
      startY: clamp01(offsetY / Math.max(bounds.height, 1)),
      endX: clamp01(offsetX / Math.max(bounds.width, 1)),
      endY: clamp01(offsetY / Math.max(bounds.height, 1)),
    });
    setDraftBrushPoints(drawMode === 'brush' ? [normalizedPoint] : []);
  }

  function handlePreviewPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!previewRef.current || !drawingStartRef.current) return;
    stopCanvasGesture(event);

    const bounds = previewRef.current.getBoundingClientRect();
    const currentX = event.clientX - bounds.left;
    const currentY = event.clientY - bounds.top;

    const nextRect = toDraftRect(
      drawingStartRef.current.x,
      drawingStartRef.current.y,
      currentX,
      currentY,
      bounds,
    );
    setDraftRect(nextRect);
    setDraftArrow({
      startX: clamp01(drawingStartRef.current.x / Math.max(bounds.width, 1)),
      startY: clamp01(drawingStartRef.current.y / Math.max(bounds.height, 1)),
      endX: clamp01(currentX / Math.max(bounds.width, 1)),
      endY: clamp01(currentY / Math.max(bounds.height, 1)),
    });
    if (drawingStartRef.current.mode === 'brush') {
      const nextPoint = {
        x: clamp01(currentX / Math.max(bounds.width, 1)),
        y: clamp01(currentY / Math.max(bounds.height, 1)),
        brushSize: 18,
      };
      setDraftBrushPoints((previous) => {
        const last = previous[previous.length - 1];
        if (last) {
          const dx = (last.x - nextPoint.x) * bounds.width;
          const dy = (last.y - nextPoint.y) * bounds.height;
          if ((dx * dx) + (dy * dy) < 16) return previous;
        }
        const next = [...previous, nextPoint];
        setDraftRect(brushPointsToRect(next));
        return next;
      });
    }
  }

  function handlePreviewPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (!previewRef.current || !drawingStartRef.current || !draftRect) return;
    stopCanvasGesture(event);
    previewRef.current.releasePointerCapture?.(event.pointerId);

    const start = drawingStartRef.current;
    const arrow = draftArrow;
    if (start.mode === 'brush') {
      if (draftBrushPoints.length >= 2) {
        openEditorForCreate(draftRect, start.mode, arrow, draftBrushPoints);
      }
    } else if (draftRect.width >= 0.03 && draftRect.height >= 0.03) {
      openEditorForCreate(draftRect, start.mode, arrow);
    }

    drawingStartRef.current = null;
    setDraftRect(null);
    setDraftArrow(null);
    setDraftBrushPoints([]);
  }

  function handlePreviewPointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    stopCanvasGesture(event);
    previewRef.current?.releasePointerCapture?.(event.pointerId);
    drawingStartRef.current = null;
    setDraftRect(null);
    setDraftArrow(null);
    setDraftBrushPoints([]);
  }

  function renderReferenceIcon(candidate: ReferenceCandidate) {
    if (candidate.mediaType === 'image') return <ImageIcon className="h-3.5 w-3.5 text-[#98ead7]" />;
    if (candidate.mediaType === 'video') return <Video className="h-3.5 w-3.5 text-[#cfe6ff]" />;
    return null;
  }

  return (
    <div
      className="relative overflow-visible"
      data-testid={`tagging-node-${id}`}
      data-node-id={id}
      data-node-type="region"
      onPointerDownCapture={syncNodeSelection}
      onMouseDownCapture={syncNodeSelection}
    >
      <div
        ref={nodeShellRef}
        className={`relative w-[560px] rounded-lg bg-[#262626] transition-all duration-150 ${isNodeSelected ? 'ring-2 ring-[#9a9a9a] shadow-[0_0_0_1px_rgba(255,255,255,0.22)]' : 'ring-1 ring-[#343434]'}`}
      >
        <EditableNodeTitle nodeId={id} icon={Tags} label={data?.label} fallback="打标签节点" className="absolute -top-7 left-0" />

        <div className="border-b border-[#353535] px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-[#f5f5f5]">打标签节点</div>
              <div className="mt-1 text-xs text-[#a3a3a3]">
                在这里标记要改的区域，绑定参考素材或文字说明。确认后再把完整协议落实到节点输出。
              </div>
            </div>
            <span className={`rounded-full px-3 py-1 text-[11px] ${baseSource?.mediaType === 'video' ? 'bg-[#22313f] text-[#cfe6ff]' : 'bg-[#1c2d2a] text-[#98ead7]'}`}>
              {baseSource?.mediaType === 'video' ? '视频打标签' : '图片打标签'}
            </span>
          </div>

          <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
            <span className="rounded-full bg-[#343434] px-3 py-1 text-[#d7d7d7]">
              {baseSource ? `基底：${baseSource.nodeLabel}` : '等待连接 DCC / 图片 / 视频基底'}
            </span>
            <span className="rounded-full bg-[#343434] px-3 py-1 text-[#d7d7d7]">
              {referenceCandidates.length} 个参考输入
            </span>
            {effectiveContract.summary ? (
              <span className="rounded-full bg-[#1d2330] px-3 py-1 text-[#c7d6ff]">
                {effectiveContract.summary}
              </span>
            ) : null}
          </div>
        </div>

        <div className="p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="text-xs text-[#9c9c9c]">
              点击“添加打标签”后会弹出独立面板，先选择标记方式，再在预览上拖拽，最后确认后才写回节点。
            </div>
            <button
              type="button"
              data-testid={`tagging-open-panel-${id}`}
              onPointerDown={stopCanvasInteraction}
              onClick={openTaggingPanel}
              className="inline-flex items-center gap-1.5 rounded-md border border-[#4a4a4a] px-3 py-1.5 text-xs text-[#e6e6e6] hover:bg-[#353535]"
            >
              <Plus className="h-3.5 w-3.5" />
              添加打标签
            </button>
          </div>

          <div
            ref={previewRef}
            data-testid={`tagging-preview-${id}`}
            className={`nodrag nopan nowheel relative h-[300px] select-none overflow-hidden rounded-xl border border-[#3b3b3b] bg-[#171717] ${drawMode ? 'cursor-crosshair' : ''}`}
            onPointerDown={handlePreviewPointerDown}
            onPointerMove={handlePreviewPointerMove}
            onPointerUp={handlePreviewPointerUp}
            onPointerLeave={handlePreviewPointerUp}
            onPointerCancel={handlePreviewPointerCancel}
          >
            {baseSource?.url ? (
              resolvedPreviewUrl ? (
                baseSource.mediaType === 'video' ? (
                  <video data-testid={`tagging-preview-video-${id}`} src={resolvedPreviewUrl} className="h-full w-full object-cover" muted loop autoPlay playsInline draggable={false} />
                ) : (
                  <img data-testid={`tagging-preview-image-${id}`} src={resolvedPreviewUrl} alt={baseSource.nodeLabel} className="h-full w-full object-cover" draggable={false} />
                )
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                  <Crosshair className="h-8 w-8 text-[#666]" />
                  <div className="text-sm font-medium text-[#e6e6e6]">正在加载基底预览</div>
                </div>
              )
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                <Crosshair className="h-10 w-10 text-[#666]" />
                <div className="text-sm font-medium text-[#e6e6e6]">先接入 DCC 构图基底</div>
                <div className="max-w-[320px] text-xs leading-5 text-[#9b9b9b]">
                  把 DCC 截图、DCC 录屏、图片节点或视频节点接到左侧“基底”端口后，就可以在这里直接打标签。
                </div>
              </div>
            )}

            {!baseSource && availableBaseCandidates.length > 0 ? (
              <div className="absolute inset-x-4 bottom-4 z-10 rounded-xl border border-[#313131] bg-[#111111e6] px-3 py-3 text-left shadow-xl backdrop-blur">
                <div className="text-xs font-semibold text-[#ececec]">快速设为基底</div>
                <div className="mt-1 text-[11px] leading-5 text-[#9b9b9b]">
                  如果拖线不方便，也可以直接从当前画布素材里选一个，一键接到“基底”端口。
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {availableBaseCandidates.slice(0, 4).map((candidate) => (
                    <button
                      key={`base-candidate-${candidate.nodeId}-${candidate.mediaType}`}
                      type="button"
                      data-testid={`tagging-connect-base-${id}-${candidate.nodeId}`}
                      onPointerDown={stopCanvasInteraction}
                      onClick={() => connectBaseCandidate(candidate)}
                      className="rounded-lg border border-[#3d3d3d] bg-[#1a1a1a] px-3 py-2 text-left hover:bg-[#232323]"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-xs font-medium text-[#f1f1f1]">{candidate.nodeLabel}</div>
                          <div className="mt-1 text-[11px] text-[#9b9b9b]">
                            {candidate.mediaType === 'video' ? '视频基底' : '图片基底'}
                          </div>
                        </div>
                        <span className="rounded-full bg-[#243730] px-2 py-0.5 text-[10px] text-[#bff2dc]">设为基底</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {drawMode ? (
              <div className="pointer-events-none absolute left-3 top-3 rounded-full bg-black/55 px-3 py-1 text-[11px] text-white">
                {drawMode === 'box' ? '正在框选区域' : '正在绘制箭头标记'}
              </div>
            ) : null}

            <div className="pointer-events-none absolute inset-0">
              <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
                <defs>
                  <marker id={`tagging-arrow-${id}`} markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                    <path d="M0,0 L0,6 L6,3 z" fill="#ffe59b" />
                  </marker>
                </defs>
                {effectiveContract.regions.filter(hasArrowMarker).map((region) => {
                  const points = region.geometry.maskPoints || [];
                  const start = points[0];
                  const end = points[1];
                  return (
                    <line
                      key={`arrow-${region.regionId}`}
                      x1={start.x * 100}
                      y1={start.y * 100}
                      x2={end.x * 100}
                      y2={end.y * 100}
                      stroke={region.regionId === selectedRegionId ? '#98ead7' : '#ffe59b'}
                      strokeWidth="0.8"
                      markerEnd={`url(#tagging-arrow-${id})`}
                    />
                  );
                })}
                {effectiveContract.regions.filter(hasBrushMarker).map((region) => {
                  const points = region.geometry.maskPoints || [];
                  const polyline = points.map((point) => `${point.x * 100},${point.y * 100}`).join(' ');
                  if (!polyline) return null;
                  return (
                    <polyline
                      key={`brush-${region.regionId}`}
                      points={polyline}
                      fill="none"
                      stroke={region.regionId === selectedRegionId ? '#98ead7' : '#f3d38a'}
                      strokeWidth="1.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  );
                })}
                {draftArrow && drawMode === 'arrow' ? (
                  <line
                    x1={draftArrow.startX * 100}
                    y1={draftArrow.startY * 100}
                    x2={draftArrow.endX * 100}
                    y2={draftArrow.endY * 100}
                    stroke="#7dd3fc"
                    strokeWidth="0.8"
                    strokeDasharray="2 2"
                    markerEnd={`url(#tagging-arrow-${id})`}
                  />
                ) : null}
                {draftBrushPoints.length > 1 && drawMode === 'brush' ? (
                  <polyline
                    points={draftBrushPoints.map((point) => `${point.x * 100},${point.y * 100}`).join(' ')}
                    fill="none"
                    stroke="#7dd3fc"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeDasharray="2 2"
                  />
                ) : null}
              </svg>

              {effectiveContract.regions.map((region, index) => (
                <button
                  key={region.regionId}
                  type="button"
                  data-region-box="true"
                  onPointerDown={(event) => {
                    stopCanvasInteraction(event);
                    setSelectedRegionId(region.regionId);
                  }}
                  onClick={(event) => {
                    stopCanvasInteraction(event);
                    openEditorForEdit(region);
                  }}
                  className={`nodrag nopan nowheel pointer-events-auto absolute rounded-xl border-2 text-left ${region.regionId === selectedRegionId ? 'border-[#98ead7] bg-[#00d4aa]/12' : 'border-[#f3d38a] bg-[#f3d38a]/10'}`}
                  style={{
                    left: `${region.geometry.rect.x * 100}%`,
                    top: `${region.geometry.rect.y * 100}%`,
                    width: `${region.geometry.rect.width * 100}%`,
                    height: `${region.geometry.rect.height * 100}%`,
                  }}
                >
                  <span className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-semibold text-white">
                    {region.label || `标签 ${index + 1}`}
                  </span>
                </button>
              ))}

              {draftRect ? (
                <div
                  className="absolute rounded-xl border-2 border-dashed border-sky-300 bg-sky-400/10"
                  style={{
                    left: `${draftRect.x * 100}%`,
                    top: `${draftRect.y * 100}%`,
                    width: `${draftRect.width * 100}%`,
                    height: `${draftRect.height * 100}%`,
                  }}
                />
              ) : null}
            </div>
          </div>
        </div>

        <div className="grid gap-4 border-t border-[#353535] p-4 lg:grid-cols-[220px_minmax(0,1fr)]">
          <div className="space-y-2">
            <div className="text-xs font-semibold text-[#d9d9d9]">标签列表</div>
            {effectiveContract.regions.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[#454545] px-3 py-4 text-xs leading-5 text-[#9b9b9b]">
                还没有标签。点击“添加打标签”后会在独立面板里创建和编辑，确认后再落实到节点上。
              </div>
            ) : (
              effectiveContract.regions.map((region) => (
                <div
                  key={region.regionId}
                  className={`rounded-xl border px-3 py-2 ${selectedRegionId === region.regionId ? 'border-[#5fae9f] bg-[#1d302b]' : 'border-[#3d3d3d] bg-[#202020]'}`}
                >
                  <button
                    type="button"
                    onPointerDown={stopCanvasInteraction}
                    onClick={() => openEditorForEdit(region)}
                    className="w-full text-left"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="truncate text-sm font-medium text-[#f2f2f2]">{region.label || '未命名标签'}</div>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] ${region.enabled === false ? 'bg-[#472728] text-[#ffb4b4]' : 'bg-[#25372f] text-[#bff2dc]'}`}>
                        {region.enabled === false ? '关闭' : '启用'}
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] text-[#a3a3a3]">{region.description || '等待填写说明'}</div>
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="space-y-3">
            <div className="rounded-2xl border border-[#3d3d3d] bg-[#202020] p-4">
              <div className="text-sm font-semibold text-[#f4f4f4]">节点摘要</div>
              <div className="mt-1 text-xs text-[#9f9f9f]">
                节点本体只显示预览和摘要，详细编辑全部放到独立弹出的打标签面板里。
              </div>
              {selectedRegion ? (
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <div className="rounded-xl border border-[#323232] bg-[#171717] px-3 py-3">
                    <div className="text-xs text-[#8f8f8f]">当前标签</div>
                    <div className="mt-1 text-sm text-[#f1f1f1]">{selectedRegion.label}</div>
                  </div>
                  <div className="rounded-xl border border-[#323232] bg-[#171717] px-3 py-3">
                    <div className="text-xs text-[#8f8f8f]">标记方式</div>
                    <div className="mt-1 text-sm text-[#f1f1f1]">{hasArrowMarker(selectedRegion) ? '箭头标记' : '矩形框选'}</div>
                  </div>
                  <div className="rounded-xl border border-[#323232] bg-[#171717] px-3 py-3 md:col-span-2">
                    <div className="text-xs text-[#8f8f8f]">摘要说明</div>
                    <div className="mt-1 text-sm leading-6 text-[#f1f1f1]">{selectedRegion.description || '未填写说明'}</div>
                  </div>
                </div>
              ) : (
                <div className="mt-4 rounded-xl border border-dashed border-[#454545] px-3 py-4 text-sm text-[#a0a0a0]">
                  选中一个标签后，这里会显示它的简要摘要。点击标签可重新打开独立编辑面板。
                </div>
              )}
            </div>
          </div>
        </div>

        <Handle data-testid={`tagging-handle-main-${id}`} id="region-main" type="target" position={Position.Left} className="image-node-handle" style={{ left: -22, top: '24%' }}>
          <span className="text-[10px] font-bold leading-none text-[#8a8a8a]">基</span>
        </Handle>
        <Handle data-testid={`tagging-handle-image-reference-${id}`} id="region-image-reference" type="target" position={Position.Left} className="image-node-handle" style={{ left: -22, top: '48%' }}>
          <span className="text-[10px] font-bold leading-none text-[#8a8a8a]">图</span>
        </Handle>
        <Handle data-testid={`tagging-handle-video-reference-${id}`} id="region-video-reference" type="target" position={Position.Left} className="image-node-handle" style={{ left: -22, top: '66%' }}>
          <span className="text-[10px] font-bold leading-none text-[#8a8a8a]">视</span>
        </Handle>
        <Handle data-testid={`tagging-handle-text-reference-${id}`} id="region-text-reference" type="target" position={Position.Left} className="hidden image-node-handle" style={{ left: -22, top: '82%' }}>
          <span className="text-[10px] font-bold leading-none text-[#8a8a8a]">文</span>
        </Handle>
        <Handle data-testid={`tagging-handle-output-${id}`} id="region-output" type="source" position={Position.Right} className="image-node-handle" style={{ right: -22, top: '52%' }}>
          <span className="text-xs font-bold leading-none text-[#8a8a8a]">+</span>
        </Handle>

        <div className="pointer-events-none absolute -left-[108px] top-[calc(24%-10px)] rounded-full bg-[#1c242b] px-2 py-0.5 text-[10px] font-semibold text-[#d7e9f7]">基底</div>
        <div className="pointer-events-none absolute -left-[108px] top-[calc(48%-10px)] rounded-full bg-[#18332d] px-2 py-0.5 text-[10px] font-semibold text-[#aaf2df]">图参考</div>
        <div className="pointer-events-none absolute -left-[108px] top-[calc(66%-10px)] rounded-full bg-[#22313f] px-2 py-0.5 text-[10px] font-semibold text-[#cfe6ff]">视参考</div>
        <div className="pointer-events-none absolute -left-[108px] top-[calc(82%-10px)] rounded-full bg-[#302111] px-2 py-0.5 text-[10px] font-semibold text-[#f6d089]">文说明</div>
      </div>

      {taggingPanelOpen ? (
        <div
          data-testid={`tagging-panel-${id}`}
          className={`nodrag nopan nowheel absolute top-0 z-40 max-h-[calc(100vh-96px)] w-[420px] overflow-y-auto rounded-2xl border border-[#3d3d3d] bg-[#171717] p-4 shadow-2xl ${panelSide === 'left' ? 'right-[calc(100%+16px)]' : 'left-[calc(100%+16px)]'}`}
          onPointerDown={keepPanelFocused}
          onPointerUp={keepPanelFocused}
          onMouseDown={keepPanelFocused}
          onMouseUp={keepPanelFocused}
          onTouchStart={keepPanelFocused}
          onWheel={keepPanelFocused}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-[#f4f4f4]">打标签编辑面板</div>
              <div className="mt-1 text-xs leading-5 text-[#9f9f9f]">
                这里负责选择标记方式、填写标签要求、映射参考素材。只有确认后，节点上的标签合同才会更新。
              </div>
            </div>
            <button
              type="button"
              onClick={closeTaggingPanel}
              className="rounded-md border border-[#464646] px-2 py-1 text-[11px] text-[#d8d8d8] hover:bg-[#2a2a2a]"
            >
              关闭
            </button>
          </div>

          {panelStage === 'mode' ? (
            <div className="mt-4 space-y-3">
              <div className="rounded-xl border border-[#313131] bg-[#111] px-3 py-3 text-xs leading-6 text-[#cfcfcf]">
                1. 先选择标记方式。
                <br />
                2. 再回到左侧预览图上框选、画箭头，或沿目标轮廓手动涂抹。
                <br />
                3. 放开鼠标后，这里会自动切到标签编辑表单。
              </div>
              <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(112px,1fr))]">
                {DRAW_MODE_OPTIONS.map((option) => {
                  const active = selectedDrawMode === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      data-testid={`tagging-draw-${option.value}-${id}`}
                      onClick={() => startDraw(option.value)}
                      className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${active ? 'border-[#6ea697] bg-[#20332d] text-[#ecfff9]' : 'border-[#404040] bg-[#232323] text-[#f0f0f0] hover:bg-[#2c2c2c]'}`}
                    >
                      <div className="break-words text-sm font-medium">{option.label}</div>
                      <div className={`mt-1 break-words text-[11px] leading-5 ${active ? 'text-[#bfe7dc]' : 'text-[#9b9b9b]'}`}>
                        {option.description}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {panelStage === 'drawing' ? (
            <div className="mt-4 space-y-3">
              <div className="rounded-xl border border-[#313131] bg-[#111] px-3 py-3">
                <div className="text-xs text-[#8f8f8f]">当前方式</div>
                <div className="mt-1 text-sm font-medium text-[#f1f1f1]">{drawModeLabel(drawMode)}</div>
              </div>
              <div className="rounded-xl border border-dashed border-[#4b6272] bg-[#111] px-3 py-4 text-sm leading-6 text-[#cfd9e0]">
                {drawMode === 'brush'
                  ? '已进入手动涂抹模式。请回到左侧预览图上按住并沿目标轮廓描画，松开后这里会自动切到详细编辑。'
                  : '已进入打标签模式。请回到左侧预览图上拖拽完成标记，完成后这里会自动切到详细编辑。'}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setDrawMode(null);
                    setPanelStage('mode');
                    setDraftRect(null);
                    setDraftArrow(null);
                    setDraftBrushPoints([]);
                  }}
                  className="rounded-md border border-[#4a4a4a] px-3 py-1.5 text-xs text-[#e6e6e6] hover:bg-[#353535]"
                >
                  重新选择方式
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDrawMode(null);
                    setPanelStage('mode');
                    setDraftRect(null);
                    setDraftArrow(null);
                    setDraftBrushPoints([]);
                  }}
                  className="rounded-md border border-[#5b3335] px-3 py-1.5 text-xs text-[#ffcbcb] hover:bg-[#3a2324]"
                >
                  取消本次打标签
                </button>
              </div>
            </div>
          ) : null}

          {panelStage === 'edit' && editorRegion ? (
            <div className="mt-4 grid gap-3">
              <div className="rounded-xl border border-[#313131] bg-[#111] px-3 py-3 text-xs text-[#cfd9e0]">
                当前标记方式：{drawModeLabel(regionDrawMode(editorRegion))}。所有修改先保留在这个面板里，确认后才写回节点。
              </div>

              <div className="grid gap-2">
                <div className="text-xs font-medium text-[#d8d8d8]">标记方式</div>
                <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(112px,1fr))]">
                  {DRAW_MODE_OPTIONS.map((option) => {
                    const active = regionDrawMode(editorRegion) === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => updateEditorDrawMode(option.value)}
                        className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${active ? 'border-[#6ea697] bg-[#20332d] text-[#ecfff9]' : 'border-[#404040] bg-[#171717] text-[#ededed] hover:bg-[#202020]'}`}
                      >
                        <div className="break-words text-sm font-medium">{option.label}</div>
                        <div className={`mt-1 break-words text-[11px] leading-5 ${active ? 'text-[#bfe7dc]' : 'text-[#9b9b9b]'}`}>
                          {option.description}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <label className="grid gap-1 text-xs text-[#d8d8d8]">
                <span>标签名</span>
                <input
                  value={editorRegion.label}
                  onChange={(event) => updateEditorRegion((region) => ({ ...region, label: event.target.value }))}
                  className="rounded-md border border-[#444] bg-[#111] px-3 py-2 text-sm text-[#f0f0f0] outline-none"
                />
                <span className="text-[11px] leading-5 text-[#8f8f8f]">
                  直接在这里写区域说明就会进入区域协议，下一个图片/视频节点会直接读取，不需要额外文字接口。
                </span>
              </label>

              <label className="grid gap-1 text-xs text-[#d8d8d8]">
                <span>标签说明</span>
                <textarea
                  value={editorRegion.description}
                  onChange={(event) => updateEditorRegion((region) => ({ ...region, description: event.target.value }))}
                  placeholder="例如：把这里换成参考图里的香水，保留瓶身全部细节，只做落位和边缘融合。"
                  className="min-h-[88px] rounded-md border border-[#444] bg-[#111] px-3 py-2 text-sm text-[#f0f0f0] outline-none placeholder:text-[#8f8f8f]"
                />
              </label>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1 text-xs text-[#d8d8d8]">
                  <span>目标类型</span>
                  <select
                    value={editorRegion.targetKind}
                    onChange={(event) => updateEditorRegion((region) => ({ ...region, targetKind: event.target.value as RegionTargetKind }))}
                    className="rounded-md border border-[#444] bg-[#111] px-3 py-2 text-sm text-[#f0f0f0] outline-none"
                  >
                    {REGION_TARGET_KIND_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>

                <label className="grid gap-1 text-xs text-[#d8d8d8]">
                  <span>编辑意图</span>
                  <select
                    value={editorRegion.editIntent}
                    onChange={(event) => updateEditorRegion((region) => ({ ...region, editIntent: event.target.value as RegionEditIntent }))}
                    className="rounded-md border border-[#444] bg-[#111] px-3 py-2 text-sm text-[#f0f0f0] outline-none"
                  >
                    {REGION_EDIT_INTENT_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>

                <label className="grid gap-1 text-xs text-[#d8d8d8]">
                  <span>严格度</span>
                  <select
                    value={editorRegion.strictness}
                    onChange={(event) => updateEditorRegion((region) => ({ ...region, strictness: event.target.value as RegionStrictness }))}
                    className="rounded-md border border-[#444] bg-[#111] px-3 py-2 text-sm text-[#f0f0f0] outline-none"
                  >
                    {REGION_STRICTNESS_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>

                <label className="grid gap-1 text-xs text-[#d8d8d8]">
                  <span>绑定模式</span>
                  <select
                    value={editorRegion.bindingMode}
                    onChange={(event) => updateEditorRegion((region) => ({ ...region, bindingMode: event.target.value as RegionBindingMode }))}
                    className="rounded-md border border-[#444] bg-[#111] px-3 py-2 text-sm text-[#f0f0f0] outline-none"
                  >
                    {REGION_BINDING_MODE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="grid gap-1 text-xs text-[#d8d8d8]">
                <span>负向约束</span>
                <input
                  value={editorRegion.negativePrompt || ''}
                  onChange={(event) => updateEditorRegion((region) => ({ ...region, negativePrompt: event.target.value }))}
                  placeholder="例如：不要变形，不要额外文字，不要卡通感"
                  className="rounded-md border border-[#444] bg-[#111] px-3 py-2 text-sm text-[#f0f0f0] outline-none placeholder:text-[#8f8f8f]"
                />
              </label>

              <div className={`rounded-xl border px-3 py-3 transition-colors ${referenceDropActive ? 'border-[#5fae9f] bg-[#18302b]' : 'border-[#313131] bg-[#111]'}`} data-testid={`tagging-binding-dropzone-${id}`} onDragOver={handleReferenceDragOver} onDragEnter={handleReferenceDragOver} onDragLeave={handleReferenceDragLeave} onDrop={handleReferenceDrop}>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="text-xs font-semibold text-[#eaeaea]">映射参考素材</div>
                  <span className="rounded-full bg-[#2a2a2a] px-2 py-0.5 text-[10px] text-[#bdbdbd]">
                    {editorRegion.bindings.length} 个已绑定
                  </span>
                </div>

                <div className={`mb-3 rounded-lg border border-dashed px-3 py-2 text-[11px] leading-5 ${referenceDropActive ? 'border-[#84d8c7] bg-[#16332d] text-[#dbfff7]' : 'border-[#3f3f3f] bg-[#151515] text-[#a7a7a7]'}`}>
                  把主体、光影、背景参考图或参考视频拖到这里即可直接绑定；也可以点击下方素材卡片逐个映射，不限制数量。
                </div>
                {referencePoolCandidates.length === 0 ? (
                  <div className="text-xs leading-5 text-[#9b9b9b]">
                    当前没有连入参考节点。可以把图片、视频或文字节点接到左侧参考端口后，再回来映射到这个标签。
                  </div>
                ) : (
                  <div className="grid gap-2">
                    {referencePoolCandidates.map((candidate) => {
                      const bound = editorRegion.bindings.find((binding) => (
                        binding.sourceNodeId === candidate.nodeId && binding.sourceAssetUrl === candidate.url
                      ));
                      return (
                        <button
                          key={`${candidate.nodeId}:${candidate.url}`}
                          type="button"
                          draggable
                          data-testid={`tagging-reference-candidate-${id}-${candidate.nodeId}`}
                          onDragStart={(event) => handleReferenceDragStart(event, candidate)}
                          onClick={() => toggleEditorBinding(candidate)}
                          className={`nodrag nopan nowheel rounded-xl border px-3 py-2 text-left ${bound ? 'border-[#5a7f79] bg-[#18302b]' : 'border-[#3d3d3d] bg-[#171717] hover:bg-[#202020]'}`}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 text-sm font-medium text-[#f1f1f1]">
                                {renderReferenceIcon(candidate)}
                                <span className="truncate">{candidate.nodeLabel}</span>
                              </div>
                              {candidate.description ? (
                                <div className="mt-1 text-xs text-[#9b9b9b]">{candidate.description}</div>
                              ) : null}
                            </div>
                            <span className="inline-flex items-center gap-1 text-[11px] text-[#d9d9d9]">
                              <Link2 className="h-3.5 w-3.5" />
                              {bound ? '已映射' : '点击映射'}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {editorRegion.bindings.length > 0 ? (
                <div className="grid gap-2">
                  {editorRegion.bindings.map((binding) => (
                    <div key={binding.slotId} className="rounded-xl border border-[#313131] bg-[#111] p-3">
                      <div className="text-xs font-semibold text-[#ededed]">{binding.sourceLabel || '参考素材'}</div>
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        <label className="grid gap-1 text-xs text-[#d8d8d8]">
                          <span>绑定角色</span>
                          <select
                            value={binding.bindingRole}
                            onChange={(event) => updateEditorRegion((region) => ({
                              ...region,
                              bindings: region.bindings.map((item) => (
                                item.slotId === binding.slotId
                                  ? { ...item, bindingRole: event.target.value as RegionBindingRole }
                                  : item
                              )),
                            }))}
                            className="rounded-md border border-[#444] bg-[#151515] px-3 py-2 text-sm text-[#f0f0f0] outline-none"
                          >
                            {REGION_BINDING_ROLE_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                        </label>

                        <label className="grid gap-1 text-xs text-[#d8d8d8]">
                          <span>权重</span>
                          <input
                            type="range"
                            min={0}
                            max={100}
                            value={binding.weight}
                            onChange={(event) => updateEditorRegion((region) => ({
                              ...region,
                              bindings: region.bindings.map((item) => (
                                item.slotId === binding.slotId
                                  ? { ...item, weight: Number(event.target.value) }
                                  : item
                              )),
                            }))}
                          />
                        </label>
                      </div>

                      <label className="mt-2 inline-flex items-center gap-2 text-xs text-[#d8d8d8]">
                        <input
                          type="checkbox"
                          checked={binding.preserveDetail}
                          onChange={(event) => updateEditorRegion((region) => ({
                            ...region,
                            bindings: region.bindings.map((item) => (
                              item.slotId === binding.slotId
                                ? { ...item, preserveDetail: event.target.checked }
                                : item
                            )),
                          }))}
                        />
                        保留参考素材细节
                      </label>
                    </div>
                  ))}
                </div>
              ) : null}

              {effectiveContract.source.mediaType === 'video' ? (
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="grid gap-1 text-xs text-[#d8d8d8]">
                    <span>开始帧</span>
                    <input
                      type="number"
                      min={0}
                      value={editorRegion.frameRange?.startFrame ?? editorRegion.track?.startFrame ?? 0}
                      onChange={(event) => updateEditorRegion((region) => ({
                        ...region,
                        frameRange: {
                          startFrame: clampFrame(event.target.value, 0),
                          endFrame: Math.max(
                            clampFrame(event.target.value, 0),
                            region.frameRange?.endFrame ?? region.track?.endFrame ?? 24,
                          ),
                        },
                      }))}
                      className="rounded-md border border-[#444] bg-[#111] px-3 py-2 text-sm text-[#f0f0f0] outline-none"
                    />
                  </label>

                  <label className="grid gap-1 text-xs text-[#d8d8d8]">
                    <span>结束帧</span>
                    <input
                      type="number"
                      min={0}
                      value={editorRegion.frameRange?.endFrame ?? editorRegion.track?.endFrame ?? 24}
                      onChange={(event) => updateEditorRegion((region) => {
                        const startFrame = region.frameRange?.startFrame ?? region.track?.startFrame ?? 0;
                        return {
                          ...region,
                          frameRange: {
                            startFrame,
                            endFrame: Math.max(startFrame, clampFrame(event.target.value, 24)),
                          },
                        };
                      })}
                      className="rounded-md border border-[#444] bg-[#111] px-3 py-2 text-sm text-[#f0f0f0] outline-none"
                    />
                  </label>

                  <label className="grid gap-1 text-xs text-[#d8d8d8]">
                    <span>轨迹模式</span>
                    <select
                      value={editorRegion.track?.mode || 'static'}
                      onChange={(event) => updateEditorRegion((region) => ({
                        ...region,
                        track: {
                          mode: event.target.value as 'static' | 'manual' | 'tracked',
                          startFrame: region.frameRange?.startFrame ?? 0,
                          endFrame: region.frameRange?.endFrame ?? 24,
                          keyframes: [
                            { frame: region.frameRange?.startFrame ?? 0, rect: region.geometry.rect },
                            { frame: region.frameRange?.endFrame ?? 24, rect: region.geometry.rect },
                          ],
                          occlusionPolicy: region.track?.occlusionPolicy || 'hold',
                        },
                      }))}
                      className="rounded-md border border-[#444] bg-[#111] px-3 py-2 text-sm text-[#f0f0f0] outline-none"
                    >
                      <option value="static">静态</option>
                      <option value="manual">手动</option>
                      <option value="tracked">跟踪</option>
                    </select>
                  </label>
                </div>
              ) : null}

              <label className="inline-flex items-center gap-2 text-xs text-[#d8d8d8]">
                <input
                  type="checkbox"
                  checked={editorRegion.enabled !== false}
                  onChange={(event) => updateEditorRegion((region) => ({ ...region, enabled: event.target.checked }))}
                />
                启用这个标签
              </label>

              <div className="flex items-center justify-between gap-3">
                <div className="text-[11px] leading-5 text-[#9f9f9f]">
                  这里只有编辑草稿，点击确认后才会真正落实到打标签节点和下游协议里。
                </div>
                <div className="flex items-center gap-2">
                  {editorMode === 'edit' ? (
                    <button
                      type="button"
                      onClick={() => removeRegion(editorRegion.regionId)}
                      className="inline-flex items-center gap-1 rounded-md border border-[#5b3335] px-2.5 py-1.5 text-xs text-[#ffcbcb] hover:bg-[#3a2324]"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      删除
                    </button>
                  ) : null}
                  <button
                    type="button"
                    data-testid={`tagging-confirm-${id}`}
                    onClick={confirmEditor}
                    className="rounded-md border border-[#5fae9f] bg-[#1d302b] px-3 py-1.5 text-xs text-[#d8fff7] hover:bg-[#234137]"
                  >
                    确认后落实到节点
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
