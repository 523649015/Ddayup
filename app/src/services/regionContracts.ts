import type {
  Canvas,
  CanvasNode,
  MediaInput,
  NodeType,
  RegionBinding,
  RegionBindingMode,
  RegionBindingRole,
  RegionEditIntent,
  RegionKeyframe,
  RegionPackContract,
  RegionRect,
  RegionSpec,
  RegionStrictness,
  RegionTargetKind,
  RegionTrack,
  WorkflowCapabilityRequirement,
} from '@/types';
import { buildAssetLibraryContentUrl } from '@/api/assetLibrary';

export const REGION_SOURCE_HANDLE = 'region-output';

export function regionContractTargetHandle(nodeType: 'image' | 'video') {
  return nodeType === 'video' ? 'video-contract' : 'image-contract';
}

function inferSourceNodeType(mediaType: MediaInput['type']): NodeType {
  if (mediaType === 'video') return 'video';
  if (mediaType === 'audio') return 'audio';
  if (mediaType === 'text') return 'text';
  return 'image';
}

function regionBindingRoleToReferenceRole(binding: RegionBinding, region: RegionSpec): NonNullable<MediaInput['role']> {
  if (binding.bindingRole === 'subject-reference') return 'subject';
  if (binding.bindingRole === 'element-reference') return 'element';
  if (binding.bindingRole === 'background-reference') return 'lighting';
  if (binding.bindingRole === 'style-reference') {
    return region.editIntent === 'background_fuse' ? 'lighting' : 'style';
  }
  if (binding.bindingRole === 'video-reference') return 'motion';
  if (region.targetKind === 'background') return 'lighting';
  if (region.targetKind === 'subject' || region.targetKind === 'companion') return 'subject';
  if (region.targetKind === 'prop') return 'element';
  return 'style';
}

export function buildRegionContractMediaInputs(contract: RegionPackContract | null | undefined): MediaInput[] {
  if (!contract?.source?.url && !contract?.source?.persistedAssetId) return [];

  const inputs: MediaInput[] = [];
  const sourceType = contract.source.mediaType === 'video' ? 'video' : 'image';
  const counters = {
    subject: 0,
    lighting: 0,
    video: 0,
  };

  inputs.push({
    id: `region-contract:primary:${contract.source.nodeId || 'source'}`,
    type: sourceType,
    url: buildAssetLibraryContentUrl(contract.source.persistedAssetId) || contract.source.url,
    label: contract.source.nodeLabel || '打标签基底',
    role: 'primary',
    weight: 100,
    enabled: true,
    sourceNodeId: contract.source.nodeId,
    sourceNodeType: inferSourceNodeType(sourceType),
    handleId: sourceType === 'video' ? 'video-main' : 'image-main',
    channel: 'primary',
    metadata: {
      fromRegionContract: true,
      regionContractSource: true,
      regionContractSourceNodeId: contract.source.nodeId,
      regionContractSourceLabel: contract.source.nodeLabel,
      persistedAssetId: contract.source.persistedAssetId,
      originalUrl: contract.source.originalUrl,
      filePath: contract.source.filePath,
      width: contract.source.width,
      height: contract.source.height,
      duration: contract.source.duration,
    },
  });

  for (const region of contract.regions) {
    if (region.enabled === false) continue;
    for (const binding of region.bindings) {
      if (!binding.sourceAssetUrl) continue;
      const mediaType = binding.sourceMediaType === 'video'
        ? 'video'
        : binding.sourceMediaType === 'text'
          ? 'text'
          : 'image';
      const role = regionBindingRoleToReferenceRole(binding, region);
      const channel = mediaType === 'video' ? 'video-reference' : 'image-reference';
      const handleId = channel === 'video-reference'
        ? `video-video-reference-${counters.video++}`
        : role === 'subject' || role === 'element'
          ? `image-subject-reference-${counters.subject++}`
          : `image-lighting-reference-${counters.lighting++}`;
      inputs.push({
        id: `region-contract:${region.regionId}:${binding.slotId}`,
        type: mediaType,
        url: buildAssetLibraryContentUrl(binding.sourcePersistedAssetId) || binding.sourceAssetUrl,
        label: binding.sourceLabel || region.label || '打标签参考',
        role,
        weight: Math.max(0, Math.min(100, Math.round(Number(binding.weight || 80)))),
        enabled: true,
        sourceNodeId: binding.sourceNodeId,
        sourceNodeType: inferSourceNodeType(mediaType),
        handleId,
        channel,
        metadata: {
          fromRegionContract: true,
          regionId: region.regionId,
          regionLabel: region.label,
          regionTargetKind: region.targetKind,
          regionEditIntent: region.editIntent,
          regionStrictness: region.strictness,
          bindingRole: binding.bindingRole,
          preserveDetail: binding.preserveDetail,
          bindingDescription: binding.description,
          persistedAssetId: binding.sourcePersistedAssetId,
          originalUrl: binding.sourceOriginalUrl,
          filePath: binding.sourceFilePath,
        },
      });
    }
  }

  return inputs;
}

function clamp01(value: unknown, fallback: number) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(0, Math.min(1, next));
}

function clampInt(value: unknown, fallback: number, min = 0) {
  const next = Math.round(Number(value));
  if (!Number.isFinite(next)) return fallback;
  return Math.max(min, next);
}

function normalizeRegionRect(raw: unknown): RegionRect {
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const x = clamp01(input.x, 0.18);
  const y = clamp01(input.y, 0.18);
  const width = Math.max(0.04, Math.min(1 - x, clamp01(input.width, 0.24)));
  const height = Math.max(0.04, Math.min(1 - y, clamp01(input.height, 0.24)));
  return { x, y, width, height };
}

function normalizeBindingRole(value: unknown): RegionBindingRole {
  const next = String(value || '').trim();
  if (
    next === 'subject-reference'
    || next === 'element-reference'
    || next === 'background-reference'
    || next === 'style-reference'
    || next === 'video-reference'
  ) {
    return next;
  }
  return 'subject-reference';
}

function normalizeBindingMode(value: unknown): RegionBindingMode {
  const next = String(value || '').trim();
  if (next === 'reference_required' || next === 'reference_optional' || next === 'text_only') return next;
  return 'reference_optional';
}

function normalizeTargetKind(value: unknown): RegionTargetKind {
  const next = String(value || '').trim();
  if (next === 'subject' || next === 'prop' || next === 'companion' || next === 'background' || next === 'custom') return next;
  return 'custom';
}

function normalizeEditIntent(value: unknown): RegionEditIntent {
  const next = String(value || '').trim();
  if (next === 'replace_subject' || next === 'insert_element' || next === 'background_fuse' || next === 'remove_and_fill') return next;
  return 'insert_element';
}

function normalizeStrictness(value: unknown): RegionStrictness {
  const next = String(value || '').trim();
  if (next === 'exact_transfer' || next === 'guided_generate' || next === 'harmonize_only') return next;
  return 'guided_generate';
}

function normalizeKeyframe(raw: unknown, fallbackRect: RegionRect): RegionKeyframe {
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return {
    frame: clampInt(input.frame, 0),
    rect: normalizeRegionRect(input.rect || fallbackRect),
  };
}

function normalizeTrack(raw: unknown, fallbackRect: RegionRect): RegionTrack | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const input = raw as Record<string, unknown>;
  const mode = String(input.mode || 'manual');
  const startFrame = clampInt(input.startFrame, 0);
  const endFrame = clampInt(input.endFrame, Math.max(1, startFrame + 24));
  const keyframesRaw = Array.isArray(input.keyframes) ? input.keyframes : [];
  return {
    mode: mode === 'tracked' || mode === 'manual' ? mode : 'static',
    startFrame,
    endFrame,
    keyframes: keyframesRaw.length
      ? keyframesRaw.map((item) => normalizeKeyframe(item, fallbackRect))
      : [
          { frame: startFrame, rect: fallbackRect },
          { frame: endFrame, rect: fallbackRect },
        ],
    occlusionPolicy: String(input.occlusionPolicy || 'hold') === 'pause'
      ? 'pause'
      : String(input.occlusionPolicy || 'hold') === 'reacquire'
        ? 'reacquire'
        : 'hold',
  };
}

export function normalizeRegionBinding(raw: unknown): RegionBinding | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;
  const sourcePersistedAssetId = typeof input.sourcePersistedAssetId === 'string' ? input.sourcePersistedAssetId.trim() : '';
  const sourceAssetUrl = String(input.sourceAssetUrl || '').trim() || buildAssetLibraryContentUrl(sourcePersistedAssetId);
  if (!sourceAssetUrl) return null;
  const sourceMediaType = String(input.sourceMediaType || 'image').trim();
  return {
    slotId: String(input.slotId || `slot-${Math.random().toString(36).slice(2, 8)}`),
    sourceNodeId: String(input.sourceNodeId || '').trim(),
    sourceAssetUrl,
    sourcePersistedAssetId: sourcePersistedAssetId || undefined,
    sourceOriginalUrl: typeof input.sourceOriginalUrl === 'string' ? input.sourceOriginalUrl : undefined,
    sourceFilePath: typeof input.sourceFilePath === 'string' ? input.sourceFilePath : undefined,
    sourceMediaType: sourceMediaType === 'video' || sourceMediaType === 'text' ? sourceMediaType : 'image',
    bindingRole: normalizeBindingRole(input.bindingRole),
    preserveDetail: Boolean(input.preserveDetail ?? true),
    weight: Math.max(0, Math.min(100, Math.round(Number(input.weight ?? 80) || 80))),
    sourceLabel: typeof input.sourceLabel === 'string' ? input.sourceLabel : undefined,
    description: typeof input.description === 'string' ? input.description : undefined,
  };
}

export function normalizeRegionSpec(raw: unknown, sourceMediaType: 'image' | 'video'): RegionSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;
  const rect = normalizeRegionRect(input.geometry && typeof input.geometry === 'object'
    ? (input.geometry as Record<string, unknown>).rect
    : input.rect);
  const bindings = Array.isArray(input.bindings)
    ? input.bindings.map(normalizeRegionBinding).filter((item): item is RegionBinding => Boolean(item))
    : [];
  const frameRange = sourceMediaType === 'video'
    ? {
        startFrame: clampInt((input.frameRange as Record<string, unknown> | undefined)?.startFrame ?? input.startFrame, 0),
        endFrame: clampInt((input.frameRange as Record<string, unknown> | undefined)?.endFrame ?? input.endFrame, 24),
      }
    : undefined;
  return {
    regionId: String(input.regionId || input.id || `region-${Math.random().toString(36).slice(2, 8)}`),
    label: String(input.label || '未命名区域'),
    geometry: {
      rect,
      maskPoints: Array.isArray((input.geometry as Record<string, unknown> | undefined)?.maskPoints)
        ? ((input.geometry as Record<string, unknown>).maskPoints as Array<Record<string, unknown>>).map((item) => ({
            x: clamp01(item.x, rect.x + rect.width / 2),
            y: clamp01(item.y, rect.y + rect.height / 2),
            brushSize: Number(item.brushSize || 24) || 24,
          }))
        : undefined,
    },
    targetKind: normalizeTargetKind(input.targetKind),
    editIntent: normalizeEditIntent(input.editIntent),
    description: String(input.description || '').trim(),
    negativePrompt: typeof input.negativePrompt === 'string' ? input.negativePrompt : undefined,
    strictness: normalizeStrictness(input.strictness),
    bindingMode: normalizeBindingMode(input.bindingMode),
    bindings,
    enabled: input.enabled !== false,
    frameRange,
    keyframes: Array.isArray(input.keyframes)
      ? input.keyframes.map((item) => normalizeKeyframe(item, rect))
      : undefined,
    track: sourceMediaType === 'video' ? normalizeTrack(input.track, rect) : undefined,
  };
}

export function readRegionContract(raw: unknown): RegionPackContract | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;
  const sourceRaw = input.source && typeof input.source === 'object' ? input.source as Record<string, unknown> : {};
  const mediaType = String(sourceRaw.mediaType || 'image').trim() === 'video' ? 'video' : 'image';
  const sourceUrl = String(sourceRaw.url || '').trim();
  const persistedAssetId = typeof sourceRaw.persistedAssetId === 'string' ? sourceRaw.persistedAssetId.trim() : '';
  if (!sourceUrl && !persistedAssetId) return null;
  const regions = Array.isArray(input.regions)
    ? input.regions.map((item) => normalizeRegionSpec(item, mediaType)).filter((item): item is RegionSpec => Boolean(item))
    : [];
  const bindings = Array.isArray(input.bindings)
    ? input.bindings.map(normalizeRegionBinding).filter((item): item is RegionBinding => Boolean(item))
    : regions.flatMap((item) => item.bindings);
  const orderedRegionIdsRaw = Array.isArray((input.executionPlan as Record<string, unknown> | undefined)?.orderedRegionIds)
    ? ((input.executionPlan as Record<string, unknown>).orderedRegionIds as unknown[])
    : [];
  return {
    version: String(input.version || 'region-contract-v1'),
    source: {
      nodeId: typeof sourceRaw.nodeId === 'string' ? sourceRaw.nodeId : undefined,
      nodeLabel: typeof sourceRaw.nodeLabel === 'string' ? sourceRaw.nodeLabel : undefined,
      url: sourceUrl || buildAssetLibraryContentUrl(persistedAssetId),
      persistedAssetId: persistedAssetId || undefined,
      originalUrl: typeof sourceRaw.originalUrl === 'string' ? sourceRaw.originalUrl : undefined,
      filePath: typeof sourceRaw.filePath === 'string' ? sourceRaw.filePath : undefined,
      mediaType,
      width: Number(sourceRaw.width || 0) || undefined,
      height: Number(sourceRaw.height || 0) || undefined,
      duration: Number(sourceRaw.duration || 0) || undefined,
    },
    regions,
    bindings,
    executionPlan: {
      orderedRegionIds: orderedRegionIdsRaw.length
        ? orderedRegionIdsRaw.map((item) => String(item || '')).filter(Boolean)
        : regions.map((item) => item.regionId),
      strategy: 'region-contract-v1',
    },
    consistencyRequirements: Array.isArray(input.consistencyRequirements)
      ? input.consistencyRequirements.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    fallbackPolicy: String(input.fallbackPolicy || 'reject') === 'switch-model' ? 'switch-model' : 'reject',
    summary: typeof input.summary === 'string' ? input.summary : undefined,
    generatedAt: clampInt(input.generatedAt, Date.now()),
  };
}

export function readRegionContractFromNode(node: CanvasNode | null | undefined): RegionPackContract | null {
  if (!node) return null;
  const params = node.data?.params && typeof node.data.params === 'object'
    ? node.data.params as Record<string, unknown>
    : {};
  const fromParams = readRegionContract(params.regionContract);
  if (fromParams) return fromParams;
  const outputs = Array.isArray(node.data?.outputs) ? node.data.outputs : [];
  for (const output of outputs) {
    const contract = readRegionContract(output?.metadata && typeof output.metadata === 'object'
      ? (output.metadata as Record<string, unknown>).regionContract
      : undefined);
    if (contract) return contract;
  }
  return null;
}

export function collectConnectedRegionContracts(
  canvas: Canvas | null,
  targetNodeId: string,
  targetNodeType: 'image' | 'video',
) {
  if (!canvas) return [];
  const targetHandle = regionContractTargetHandle(targetNodeType);
  return (canvas.edges || [])
    .filter((edge) => edge.target === targetNodeId && String(edge.targetHandle || '') === targetHandle)
    .map((edge) => {
      const sourceNode = (canvas.nodes || []).find((node) => node.id === edge.source);
      const contract = sourceNode?.type === 'region' ? readRegionContractFromNode(sourceNode) : null;
      if (!sourceNode || !contract) return null;
      return {
        edgeId: edge.id,
        sourceNodeId: sourceNode.id,
        sourceNodeLabel: String(sourceNode.data?.label || 'Tagging Node'),
        contract,
      };
    })
    .filter((item): item is { edgeId: string; sourceNodeId: string; sourceNodeLabel: string; contract: RegionPackContract } => Boolean(item));
}

export function summarizeRegionContract(contract: RegionPackContract | null | undefined) {
  if (!contract) return '';
  const enabledRegions = contract.regions.filter((item) => item.enabled !== false);
  const exactCount = enabledRegions.filter((item) => item.strictness === 'exact_transfer').length;
  const backgroundCount = enabledRegions.filter((item) => item.editIntent === 'background_fuse').length;
  const trackedCount = enabledRegions.filter((item) => item.track && item.track.mode !== 'static').length;
  const regionLabels = enabledRegions
    .map((item) => String(item.label || '').trim())
    .filter(Boolean)
    .slice(0, 3);
  const parts = [
    `${enabledRegions.length} 个区域`,
    exactCount > 0 ? `精确迁移 ${exactCount}` : '',
    backgroundCount > 0 ? `背景融合 ${backgroundCount}` : '',
    trackedCount > 0 ? `视频轨迹 ${trackedCount}` : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

export function buildRegionContractPrompt(contract: RegionPackContract | null | undefined) {
  if (!contract) return '';
  const enabledRegions = contract.regions.filter((region) => region.enabled !== false);
  if (!enabledRegions.length) return '';
  const lines = [
    '[HMDAO region execution contract]',
    '- Treat the primary source as the locked composition anchor. Preserve camera angle, framing, crop, perspective, depth and scene layout unless a region explicitly requests otherwise.',
  ];
  for (const region of enabledRegions) {
    const intentText = region.editIntent === 'replace_subject'
      ? 'replace only the existing subject in this region'
      : region.editIntent === 'background_fuse'
        ? 'fuse or replace only the background layer in this region'
        : region.editIntent === 'insert_element'
          ? 'insert a new element into this region'
          : 'remove the marked content and fill naturally';
    const strictnessText = region.strictness === 'exact_transfer'
      ? 'This region requires exact identity transfer from its bound reference.'
      : region.strictness === 'harmonize_only'
        ? 'This region is atmosphere-only and must harmonize naturally without changing locked subject identity.'
        : 'This region may be guided by text while staying composition-consistent.';
    lines.push(`- REGION ${region.label || region.regionId}: ${region.description || intentText}`);
    lines.push(`  intent: ${intentText}. ${strictnessText}`);
    for (const binding of region.bindings) {
      if (binding.bindingRole === 'subject-reference') {
        lines.push('  binding: use the bound subject reference as the only authority for subject identity, silhouette, materials, fine details and replacement target.');
      } else if (binding.bindingRole === 'background-reference') {
        lines.push('  binding: use the bound background reference only for sky, palette, reflections, atmosphere, lighting direction and environmental finish.');
        lines.push('  binding: ignore any foreground vehicle, product, animal or person that may appear inside the background reference. Do not copy its identity or shape.');
      } else if (binding.bindingRole === 'style-reference') {
        lines.push('  binding: use the bound style reference only for finish, color, texture and mood. Do not let it override the locked composition or explicit subject identity.');
      } else if (binding.bindingRole === 'element-reference') {
        lines.push('  binding: use the bound element reference only for the inserted or swapped local object in this region.');
      } else if (binding.bindingRole === 'video-reference') {
        lines.push('  binding: use the bound video reference only for motion or timing constraints requested for this region.');
      }
      if (binding.description) {
        lines.push(`  binding detail: ${binding.description}`);
      }
    }
    if (region.negativePrompt) {
      lines.push(`  avoid: ${region.negativePrompt}`);
    }
  }
  return lines.join('\n');
}

export function buildRegionCapabilityRequirements(
  nodeType: 'image' | 'video',
  contract: RegionPackContract | null | undefined,
): WorkflowCapabilityRequirement[] {
  if (!contract) return [];
  const requirements: WorkflowCapabilityRequirement[] = [
    { key: 'supportsRegionPack', value: true, required: true },
  ];
  const enabledRegions = contract.regions.filter((item) => item.enabled !== false);
  if (enabledRegions.length > 1) requirements.push({ key: 'supportsMultiRegionExecution', value: true, required: true });
  if (enabledRegions.some((item) => item.strictness === 'exact_transfer')) {
    requirements.push({ key: 'supportsExactTransfer', value: true, required: true });
  }
  if (enabledRegions.some((item) => item.editIntent === 'background_fuse')) {
    requirements.push({ key: 'supportsBackgroundFuse', value: true, required: true });
  }
  if (enabledRegions.some((item) => item.bindings.length > 0)) {
    requirements.push({ key: 'supportsRegionSpecificBindings', value: true, required: true });
  }
  if (nodeType === 'video' && enabledRegions.some((item) => item.track || item.frameRange || contract.source.mediaType === 'video')) {
    requirements.push({ key: 'supportsTrackedVideoRegions', value: true, required: true });
  }
  return requirements;
}

export function serializeRegionPack(contract: RegionPackContract | null | undefined) {
  if (!contract) return undefined;
  return {
    version: contract.version,
    source: contract.source,
    regions: contract.regions,
    bindings: contract.bindings,
    executionPlan: contract.executionPlan,
    consistencyRequirements: contract.consistencyRequirements,
    fallbackPolicy: contract.fallbackPolicy,
    summary: contract.summary,
    generatedAt: contract.generatedAt,
  } as Record<string, unknown>;
}

export function buildRegionContractNotice(contract: RegionPackContract | null | undefined, recommendedModel = '') {
  if (!contract) return '';
  const summary = summarizeRegionContract(contract);
  return recommendedModel
    ? `${summary} · 将优先切换到 ${recommendedModel}`
    : summary;
}
