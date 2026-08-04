import { useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type ReactNode } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  AudioLines,
  BarChart3,
  Camera,
  Check,
  ChevronDown,
  Crop,
  Download,
  Expand,
  FolderOpen,
  Info,
  Image as ImageIcon,
  KeyRound,
  Languages,
  Loader2,
  Maximize2,
  Pause,
  Play,
  RotateCcw,
  Scissors,
  Send,
  Settings2,
  Sparkles,
  Subtitles,
  Upload,
  Video,
  Volume2,
  X,
  Zap,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { NodeModelBrowser } from '@/components/NodeModelBrowser';
import { ReferenceConditioningSummary } from '@/components/ReferenceInputsPanel';
import { ReferenceInputsPanel, type ReferenceBindingSection } from '@/components/ReferenceInputsPanel';
import { SourceBadge, relaySourceLabel } from '@/components/SourceBadge';
import { ModelActivationPrompt } from '@/components/ModelActivationPrompt';
import { LocalModelPanel } from '@/components/LocalModelPanel';
import {
  ANALYSIS_ENGINE_GROUPS,
  findAnalysisEngineOption,
  getVideoSemanticEngineOptions,
} from '@/config/analysisModelOptions';
import { useFloatingDraftEditors } from '@/hooks/useFloatingDraftEditors';
import { useGuardedFloatingPanelInteraction, type GuardedPanelInteractionProps } from '@/hooks/useGuardedFloatingPanelInteraction';
import { useNodeFloatingPanel } from '@/hooks/useNodeFloatingPanel';
import { useNodeToolLifecycle } from '@/hooks/useNodeToolLifecycle';
import { useUILanguage } from '@/i18n/ui';
import {
  collectConnectedReferenceInputs,
  collectReferenceBindingCandidates,
  summarizeReferenceInputs,
  type ReferenceBindingCandidate,
  type ReferenceRole,
  type ReferenceRoleOption,
  type ReferenceSettingsValue,
} from '@/lib/nodeReferenceGraph';
import { patchDebugBridge, readDebugBridge } from '@/services/debugBridge';
import {
  buildDebugGenerationBodyFromNode,
  classifyRenderableAssetIssue,
  describeGenerationError,
  generateNodeOutput,
  generateNodeOutputWithFallback,
  GenerationError,
  probeRenderableAssetIssue,
  resolveGenerationAccess,
  toRenderableAssetUrl,
  type RenderableAssetIssue,
  type GenerationAccess,
} from '@/services/generation';
import { ensureLocalMediaUrl, isLocalMediaHandle, isTransientBlobUrl, registerLocalMedia, revokeLocalMedia } from '@/services/localMediaRegistry';
import { enqueueLocalAssetPersistence } from '@/services/localAssetPersistenceQueue';
import { assistPrompt, type PromptAssistAction } from '@/services/promptAssist';
import {
  clipVideoLocallyStable,
  cropVideoLocally,
  enhanceVideoLocally,
  getLocalVideoRecorderDiagnostics,
  type LocalVideoAudioMixConfig,
  mixVideoAudioLocally,
  parseVideoLocallyEnhanced,
  primeFFmpegEngine,
  removeSubtitleLocally,
  splitVideoAudioLocally,
} from '@/services/ffmpegPipeline';
import {
  buildNodeWorkflowGraph,
  buildVideoModelCapabilityRequirements,
  completeWorkflowGraph,
  evaluateModelCapabilitySupport,
  readIdentityControllerConfig,
} from '@/services/workflowGraph';
import {
  buildRegionCapabilityRequirements,
  buildRegionContractMediaInputs,
  buildRegionContractPrompt,
  collectConnectedRegionContracts,
} from '@/services/regionContracts';
import { buildVerboseRegionContractNotice } from '@/services/regionContractNotice';
import { findProviderKeyState, providerKeyMatchesModel, useApiKeyStore, type ProviderKeyState } from '@/store/useApiKeyStore';
import { useAssetStore } from '@/store/useAssetStore';
import { useAuthStore } from '@/store/useAuthStore';
import { useBackendHealthStore } from '@/store/useBackendHealthStore';
import { useByokRuntimeStore } from '@/store/useByokRuntimeStore';
import { useCanvasStore } from '@/store/useCanvasStore';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import type { IdentityControllerConfig, MediaInput, MediaOutput, ModelCapabilityMatrix, NodeData, NodeType, WorkflowExecutionMode, WorkflowGraph } from '@/types';
import type { AssetItem } from '@/types/assets';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ErrorDetailBlock, GeneratingSkeleton, ProgressBadge, StatusBadge } from './NodeShellShared';
import { EditableNodeTitle } from './EditableNodeTitle';

import {
  AUDIO_SPLIT_MODEL_HELP,
  base64ToBlob,
  buildContractConnectedInput,
  choosePreferredVideoModel,
  clampCount,
  clampNumber,
  computeAllowedQualityOptions,
  createGeneratedAudioDescriptor,
  createGeneratedImageDescriptor,
  createGeneratedVideoDescriptor,
  createMediaDescriptor,
  dedupeVideoModels,
  defaultVideoToolConfig,
  deriveLinkedAudioMixConfig,
  FALLBACK_MODELS,
  fileToDataUrl,
  formatCurrency,
  formatEta,
  formatHdValue,
  getVideoOutcomeLabel,
  isVideoStyleTransferModel,
  mediaKindFromFile,
  mergeBoundedVideoDebugSnapshots,
  modelMatchesLocalKey,
  normalizeParsedStoryboardShots,
  normalizeVideoCost,
  OUTPUT_COUNT_OPTIONS,
  PARSE_SCENE_ENGINE_HELP,
  PARSE_SEMANTIC_ENGINE_HELP,
  parseLatencySeconds,
  pickPromptAssistProvider,
  readPrimaryVideoConstraint,
  recordFrom,
  resolvePreferredConditionedVideoModel,
  resolveProviderCompatibleVideoModel,
  shouldPreservePinnedVideoModelIdentifier,
  stopCanvasInteraction,
  SUBTITLE_ENGINE_HELP,
  TOOL_FEEDBACK,
  TOOL_LABELS,
  VIDEO_ASPECT_OPTIONS,
  VIDEO_MODE_BLUEPRINTS,
  VIDEO_MODE_OPTIONS,
  VIDEO_STYLE_PRESETS,
  VIDEO_TOOL_OPERATIONS,
  videoModelActivationSourceLabel,
  videoModelMatchesIdentifier,
  videoModelQualityCostMultiplier,
  videoRoutingHintText,
  workflowHandleStorage,
  type ClipSegment,
  type CropRect,
  type CropResizeHandle,
  type ParsedStoryboardShot,
  type ToolModelHelpEntry,
  type VideoMeta,
  type VideoModelOption,
  type VideoTool,
  type VideoUploadTarget,
  type WindowWithPicker,
} from './VideoNode.shared';

export function VideoNode({ selected, data, id }: NodeProps) {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const addNode = useCanvasStore((state) => state.addNode);
  const addConnectedNode = useCanvasStore((state) => state.addConnectedNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const removeEdge = useCanvasStore((state) => state.removeEdge);
  const setSelectedNodeIds = useCanvasStore((state) => state.setSelectedNodeIds);
  const selectedNodeIds = useCanvasStore((state) => state.selectedNodeIds);
  const canvas = useCanvasStore((state) => state.canvas);
  const canvasZoom = useCanvasStore((state) => Number(state.canvas?.viewport?.zoom || state.zoom || 1));
  const assetItems = useAssetStore((state) => state.items);
  const addAssetItem = useAssetStore((state) => state.addItem);
  const deleteAssetItems = useAssetStore((state) => state.deleteItems);
  const syncPersistedItems = useAssetStore((state) => state.syncPersistedItems);
  const apiKeys = useApiKeyStore((state) => state.keys);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const catalogItems = useModelCatalogStore((state) => state.models);
  const fetchCatalog = useModelCatalogStore((state) => state.fetchCatalog);
  const fetchBackendHealth = useBackendHealthStore((state) => state.fetchHealth);
  const byokRuntime = useByokRuntimeStore((state) => state.runtime);
  const fetchByokRuntime = useByokRuntimeStore((state) => state.fetchRuntime);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const uploadTargetRef = useRef<VideoUploadTarget>('main');
  const videoAssets = useMemo(() => assetItems.filter((item) => item.type === 'video'), [assetItems]);
  const [prompt, setPrompt] = useState(String(data?.prompt || ''));
  const [activation, setActivation] = useState<GenerationAccess | null>(null);
  const [promptAssistAction, setPromptAssistAction] = useState<PromptAssistAction | null>(null);
  const [promptAssistError, setPromptAssistError] = useState<string | null>(null);
  // 记录被「优化/翻译」替换前的原提示词，用于再次点击按钮时撤销切回原文
  const [assistBaseline, setAssistBaseline] = useState<{ action: PromptAssistAction; text: string } | null>(null);
  const submitRunIdRef = useRef('');
  const batchRegenerateTokenRef = useRef('');
  const migrationPanelTokenRef = useRef('');
  const promptCompositionRef = useRef(false);
  const toolEditSnapshotRef = useRef<Record<string, unknown> | null>(null);
  const [videoRenderError, setVideoRenderError] = useState<string | null>(null);
  const [restoredVideoUrl, setRestoredVideoUrl] = useState('');
  const [restoringVideoUrl, setRestoringVideoUrl] = useState(false);
  const isNodeSelected = selected || selectedNodeIds.includes(id);
  const isNodeExclusivelySelected = selectedNodeIds.length === 1 && selectedNodeIds[0] === id;
  const {
    ensureFocused: ensureVideoNodeFocused,
    markInteraction: markVideoPanelInteraction,
    sustainInteraction: sustainVideoPanelInteraction,
    stopInteraction: stopVideoPanelInteraction,
    panelInteractionProps: videoPanelInteractionProps,
  } = useGuardedFloatingPanelInteraction(id);
  const {
    activeKind: activeFloatingPanelKind,
    setOpen: setVideoFloatingPanelOpen,
    close: closeVideoFloatingPanel,
  } = useNodeFloatingPanel<
    'video-model-menu'
    | 'video-asset-menu'
    | 'video-tool-panel'
    | 'video-advanced-panel'
    | 'video-reference-panel'
    | 'video-crop-editor'
    | 'video-clip-editor'
  >(id, ensureVideoNodeFocused);
  const modelMenuOpen = activeFloatingPanelKind === 'video-model-menu';
  const assetMenuOpen = activeFloatingPanelKind === 'video-asset-menu';
  const toolPanelOpen = activeFloatingPanelKind === 'video-tool-panel';
  const advancedPanelOpen = activeFloatingPanelKind === 'video-advanced-panel';
  const referencePanelOpen = activeFloatingPanelKind === 'video-reference-panel';
  const cropEditorOpen = activeFloatingPanelKind === 'video-crop-editor';
  const clipEditorOpen = activeFloatingPanelKind === 'video-clip-editor';
  const isNodeInteractionActive = isNodeExclusivelySelected;
  const setModelMenuOpen = (next: boolean | ((open: boolean) => boolean)) => {
    sustainVideoPanelInteraction();
    setVideoFloatingPanelOpen('video-model-menu', next);
  };
  const setAssetMenuOpen = (next: boolean | ((open: boolean) => boolean)) => {
    sustainVideoPanelInteraction();
    setVideoFloatingPanelOpen('video-asset-menu', next);
  };
  const setToolPanelOpen = (next: boolean | ((open: boolean) => boolean)) => {
    sustainVideoPanelInteraction();
    setVideoFloatingPanelOpen('video-tool-panel', next);
  };
  const setAdvancedPanelOpen = (next: boolean | ((open: boolean) => boolean)) => {
    sustainVideoPanelInteraction();
    setVideoFloatingPanelOpen('video-advanced-panel', next);
  };
  const setReferencePanelOpen = (next: boolean | ((open: boolean) => boolean)) => {
    sustainVideoPanelInteraction();
    setVideoFloatingPanelOpen('video-reference-panel', next);
  };

  useEffect(() => {
    if (promptCompositionRef.current) return;
    setPrompt(String(data?.prompt || ''));
  }, [data?.prompt]);

  useEffect(() => {
    void fetchBackendHealth();
  }, [fetchBackendHealth]);

  const currentParams = useMemo(
    () => (data?.params && typeof data.params === 'object' ? (data.params as Record<string, unknown>) : {}),
    [data?.params],
  );
  const videoMeta = useMemo<VideoMeta | null>(() => {
    const raw = currentParams.videoMeta;
    if (!raw || typeof raw !== 'object') return null;
    const meta = raw as Partial<VideoMeta>;
    const width = Number(meta.width);
    const height = Number(meta.height);
    const duration = Number(meta.duration);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return { width, height, duration: Number.isFinite(duration) ? duration : 0 };
  }, [currentParams.videoMeta]);
  const referenceSettings = useMemo(
    () => (currentParams.referenceSettings && typeof currentParams.referenceSettings === 'object'
      ? currentParams.referenceSettings as Record<string, { role?: ReferenceRole; weight?: number; enabled?: boolean }>
      : {}),
    [currentParams.referenceSettings],
  );

  useEffect(() => {
    const manualInputs = Array.isArray(data?.inputs)
      ? data.inputs.filter((item) => item && typeof item === 'object')
      : [];
    const incomingEdges = Array.isArray(canvas?.edges)
      ? canvas.edges.filter((edge) => edge.target === id)
      : [];
    if (!manualInputs.length || !incomingEdges.length) return;

    const nextReferenceSettings = { ...referenceSettings };
    let changed = false;

    for (const input of manualInputs) {
      const handleId = String(input?.handleId || '').trim();
      const sourceNodeId = String(input?.sourceNodeId || '').trim();
      const role = String(input?.role || '').trim();
      const type = String(input?.type || '').trim();
      if (!handleId || !sourceNodeId || !role || role === 'primary' || !type) continue;

      const edge = incomingEdges.find((item) => item.source === sourceNodeId && String(item.targetHandle || '') === handleId);
      if (!edge) continue;

      const key = `${edge.id}:${edge.source}:${edge.targetHandle || 'default'}:${type}`;
      const current = nextReferenceSettings[key] || {};
      const nextWeight = Number(input?.weight);
      const nextEnabled = input?.enabled === undefined ? true : Boolean(input.enabled);
      if (
        current.role === role
        && Number(current.weight ?? NaN) === (Number.isFinite(nextWeight) ? nextWeight : Number(current.weight ?? NaN))
        && Boolean(current.enabled ?? true) === nextEnabled
      ) {
        continue;
      }

      nextReferenceSettings[key] = {
        ...current,
        role: role as ReferenceRole,
        weight: Number.isFinite(nextWeight) ? nextWeight : current.weight,
        enabled: nextEnabled,
      };
      changed = true;
    }

    if (!changed) return;
    updateNodeData(id, {
      params: {
        ...currentParams,
        referenceSettings: nextReferenceSettings,
      },
    });
  }, [canvas?.edges, currentParams, data?.inputs, id, referenceSettings, updateNodeData]);

  const connectedRegionContracts = useMemo(
    () => collectConnectedRegionContracts(canvas, id, 'video'),
    [canvas?.edges, canvas?.nodes, id],
  );
  const activeRegionContractEntry = connectedRegionContracts[0] || null;
  const activeRegionContract = activeRegionContractEntry?.contract || null;
  const contractMode = Boolean(activeRegionContract);
  const directConnectedInputs = useMemo(
    () => collectConnectedReferenceInputs(canvas, id, 'video', referenceSettings),
    [canvas?.edges, canvas?.nodes, data?.inputs, id, referenceSettings],
  );
  const contractConnectedInputs = useMemo(
    () => buildRegionContractMediaInputs(activeRegionContract).map((item) => buildContractConnectedInput(item, referenceSettings)),
    [activeRegionContract, referenceSettings],
  );
  const connectedInputs = useMemo(
    () => contractMode ? contractConnectedInputs : directConnectedInputs,
    [contractConnectedInputs, contractMode, directConnectedInputs],
  );
  const primaryInputs = useMemo(
    () => connectedInputs.filter((item) => item.channel === 'primary'),
    [connectedInputs],
  );
  const explicitReferenceInputs = useMemo(() => {
    const manualInputs = Array.isArray(data?.inputs)
      ? data.inputs.filter((item) => item && typeof item === 'object')
      : [];
    return connectedInputs
      .filter((item) => item.channel !== 'primary')
      .map((item) => {
        const explicitInput = manualInputs.find((candidate) => (
          String(candidate?.sourceNodeId || '') === String(item.sourceNodeId || '')
          && String(candidate?.handleId || '') === String(item.handleId || '')
          && String(candidate?.type || '') === String(item.type || '')
        ));
        if (!explicitInput) return item;
        const explicitRole = String(explicitInput.role || '').trim();
        const explicitWeight = Number(explicitInput.weight);
        const nextRole = item.roleOptions.some((option) => option.value === explicitRole)
          ? explicitRole as ReferenceRole
          : item.role;
        const nextWeight = Number.isFinite(explicitWeight)
          ? Math.max(0, Math.min(100, Math.round(explicitWeight)))
          : item.weight;
        const nextEnabled = explicitInput.enabled === undefined ? item.enabled : Boolean(explicitInput.enabled);
        return nextRole === item.role && nextWeight === item.weight && nextEnabled === item.enabled
          ? item
          : { ...item, role: nextRole, weight: nextWeight, enabled: nextEnabled };
      })
      .sort((left, right) => String(left.handleId || '').localeCompare(String(right.handleId || '')));
  }, [connectedInputs, data?.inputs]);
  const referenceInputs = useMemo(
    () => explicitReferenceInputs,
    [explicitReferenceInputs],
  );
  const referenceSummary = useMemo(() => summarizeReferenceInputs(connectedInputs), [connectedInputs]);
  const regionContractPrompt = useMemo(
    () => buildRegionContractPrompt(activeRegionContract),
    [activeRegionContract],
  );
  const regionCapabilityRequirements = useMemo(
    () => buildRegionCapabilityRequirements('video', activeRegionContract),
    [activeRegionContract],
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const activePrimaryInput = primaryInputs.find((item) => item.enabled !== false && item.url) || null;
    const activeImageReference = referenceInputs.find((item) => item.enabled !== false && item.type === 'image' && item.url) || null;
    const activeVideoReference = referenceInputs.find((item) => item.enabled !== false && item.type === 'video' && item.url) || null;
    const requestPreflight = (() => {
      try {
        const body = buildDebugGenerationBodyFromNode({
          type: 'video',
          data: {
            ...(data as unknown as NodeData),
            inputs: connectedInputs,
            params: {
              ...currentParams,
              sourceUrl: activePrimaryInput?.url || currentParams.sourceUrl,
              sourceMediaType: activePrimaryInput?.type || currentParams.sourceMediaType,
              referenceImageUrl: activeImageReference?.url || currentParams.referenceImageUrl,
              referenceVideoUrl: activeVideoReference?.url || currentParams.referenceVideoUrl,
              regionContract: activeRegionContract || currentParams.regionContract,
              contractMode,
              regionContractSourceNodeId: activeRegionContractEntry?.sourceNodeId || currentParams.regionContractSourceNodeId,
            },
          } as NodeData,
        });
        return {
          ok: true,
          model: String(body?.model || ''),
          generationMode: String(body?.generation_mode || ''),
          sourceMediaType: String(body?.source_media_type || ''),
          sourceUrl: String(body?.source_url || body?.reference_video_url || ''),
          primaryAssetCount: Array.isArray(body?.primary_assets) ? body.primary_assets.length : 0,
          referenceAssetCount: Array.isArray(body?.reference_assets) ? body.reference_assets.length : 0,
          connectedPrimaryCount: primaryInputs.length,
          connectedReferenceCount: referenceInputs.length,
          connectedPrimaryUrl: String(activePrimaryInput?.url || ''),
          connectedReferenceUrls: referenceInputs.map((item) => String(item.url || '')).filter(Boolean).slice(0, 6),
          regionContractSourceUrl: String(activeRegionContract?.source?.url || ''),
          contractMode,
        };
      } catch (error) {
        return {
          ok: false,
          error: String(error instanceof Error ? error.message : error || 'unknown-request-preflight-error'),
          connectedPrimaryCount: primaryInputs.length,
          connectedReferenceCount: referenceInputs.length,
          connectedPrimaryUrl: String(activePrimaryInput?.url || ''),
          connectedReferenceUrls: referenceInputs.map((item) => String(item.url || '')).filter(Boolean).slice(0, 6),
          regionContractSourceUrl: String(activeRegionContract?.source?.url || ''),
          contractMode,
        };
      }
    })();
    const currentDebugState = readDebugBridge() as Record<string, unknown> & {
      videoNodeSnapshots?: Record<string, unknown>;
    };
    patchDebugBridge({
      videoNodeSnapshots: mergeBoundedVideoDebugSnapshots(currentDebugState.videoNodeSnapshots, id, {
        connectedInputRoles: connectedInputs.map((item) => ({
          handleId: String(item.handleId || ''),
          role: String(item.role || ''),
          weight: Number(item.weight || 0),
          channel: String(item.channel || ''),
          type: String(item.type || ''),
        })),
        referenceRoles: referenceInputs.map((item) => String(item.role || '')),
        rawInputRoles: Array.isArray(data?.inputs)
          ? data.inputs.map((item) => ({
              handleId: String(item?.handleId || ''),
              role: String(item?.role || ''),
              weight: Number(item?.weight || 0),
              channel: String(item?.channel || ''),
              type: String(item?.type || ''),
            }))
          : [],
        referencePanelOpen,
        requestPreflight,
      }),
    });
    return () => {
      const latestDebugState = readDebugBridge() as Record<string, unknown> & {
        videoNodeSnapshots?: Record<string, unknown>;
      };
      if (!latestDebugState?.videoNodeSnapshots) return;
      const nextSnapshots = { ...latestDebugState.videoNodeSnapshots } as Record<string, unknown>;
      delete nextSnapshots[id];
      patchDebugBridge({
        videoNodeSnapshots: nextSnapshots,
      });
    };
  }, [activeRegionContract, activeRegionContractEntry?.sourceNodeId, connectedInputs, contractMode, currentParams, data, id, primaryInputs, referenceInputs, referencePanelOpen]);

  const bindingCandidates = useMemo(
    () => collectReferenceBindingCandidates(canvas, id, 'video'),
    [canvas?.nodes, id],
  );
  const videoImageReferenceHandleIds = useMemo(() => {
    const incomingEdges = canvas?.edges.filter((edge) => edge.target === id) || [];
    const manualInputs = Array.isArray(data?.inputs) ? data.inputs : [];
    const occupied = [
      ...incomingEdges
        .filter((edge) => edge.targetHandle === 'video-image-reference' || edge.targetHandle?.startsWith('video-image-reference-'))
        .map((edge) => {
          const raw = String(edge.targetHandle || 'video-image-reference');
          if (raw === 'video-image-reference') return 0;
          const suffix = Number.parseInt(raw.replace('video-image-reference-', ''), 10);
          return Number.isFinite(suffix) ? suffix : 0;
        }),
      ...manualInputs
        .map((item) => String(item?.handleId || ''))
        .filter((handleId) => handleId === 'video-image-reference' || handleId.startsWith('video-image-reference-'))
      .map((edge) => {
        const raw = String(edge || 'video-image-reference');
        if (raw === 'video-image-reference') return 0;
        const suffix = Number.parseInt(raw.replace('video-image-reference-', ''), 10);
        return Number.isFinite(suffix) ? suffix : 0;
      }),
    ];
    const highest = occupied.length > 0 ? Math.max(...occupied) : -1;
    return Array.from({ length: Math.max(1, highest + 2) }, (_, index) => `video-image-reference-${index}`);
  }, [canvas?.edges, data?.inputs, id]);
  const videoVideoReferenceHandleIds = useMemo(() => {
    const incomingEdges = canvas?.edges.filter((edge) => edge.target === id) || [];
    const manualInputs = Array.isArray(data?.inputs) ? data.inputs : [];
    const occupied = [
      ...incomingEdges
        .filter((edge) => edge.targetHandle === 'video-video-reference' || edge.targetHandle?.startsWith('video-video-reference-'))
        .map((edge) => {
          const raw = String(edge.targetHandle || 'video-video-reference');
          if (raw === 'video-video-reference') return 0;
          const suffix = Number.parseInt(raw.replace('video-video-reference-', ''), 10);
          return Number.isFinite(suffix) ? suffix : 0;
        }),
      ...manualInputs
        .map((item) => String(item?.handleId || ''))
        .filter((handleId) => handleId === 'video-video-reference' || handleId.startsWith('video-video-reference-'))
      .map((edge) => {
        const raw = String(edge || 'video-video-reference');
        if (raw === 'video-video-reference') return 0;
        const suffix = Number.parseInt(raw.replace('video-video-reference-', ''), 10);
        return Number.isFinite(suffix) ? suffix : 0;
      }),
    ];
    const highest = occupied.length > 0 ? Math.max(...occupied) : -1;
    return Array.from({ length: Math.max(1, highest + 2) }, (_, index) => `video-video-reference-${index}`);
  }, [canvas?.edges, data?.inputs, id]);
  const modelPinnedByUser = Boolean(currentParams.modelPinnedByUser);

  useEffect(() => {
    void fetchCatalog({ nodeType: 'video', force: true });
  }, [fetchCatalog]);
  useEffect(() => {
    void fetchByokRuntime();
  }, [fetchByokRuntime]);

  const [activeTool, setActiveTool] = useState<VideoTool | null>(
    typeof currentParams.videoTool === 'string' ? (currentParams.videoTool as VideoTool) : null,
  );
  const {
    getDraft: getFloatingDraft,
    hasAnyDraft: hasFloatingDraft,
    beginEdit: beginFloatingDraftEdit,
    updateDraft: updateFloatingDraft,
    cancelEdit: cancelFloatingDraftEdit,
    completeEdit: completeFloatingDraftEdit,
    clearDrafts: clearFloatingDrafts,
    syncDismissedEditors,
  } = useFloatingDraftEditors<
    Extract<VideoTool, 'crop' | 'clip'>,
    'video-crop-editor' | 'video-clip-editor',
    Record<string, unknown>,
    VideoTool
  >({
    tools: ['crop', 'clip'] as const,
    currentTool: activeTool,
    setCurrentTool: (tool) => setActiveTool(tool),
    buildToolConfig: (tool, seed) => ({ ...defaultVideoToolConfig(tool, currentParams, videoMeta), ...(seed || {}), tool }),
    persistToolConfig: persistVideoToolConfig,
    panelKindByTool: {
      crop: 'video-crop-editor',
      clip: 'video-clip-editor',
    },
    setPanelOpen: (kind, next) => setVideoFloatingPanelOpen(kind, next),
    isPanelOpen: (kind) => activeFloatingPanelKind === kind,
    rememberSnapshot: rememberToolEditSnapshot,
    restoreSnapshot: restoreToolEditSnapshot,
    clearSnapshot: () => {
      toolEditSnapshotRef.current = null;
    },
    getToolFromSnapshot: (snapshot) => (typeof snapshot?.videoTool === 'string' ? snapshot.videoTool as VideoTool : null),
  });
  const {
    getDraft: getDockedDraft,
    activeDraftTool: activeDockedDraftTool,
    hasAnyDraft: hasDockedDraft,
    beginEdit: beginDockedDraftEdit,
    updateDraft: updateDockedDraft,
    cancelEdit: cancelDockedDraftEdit,
    completeEdit: completeDockedDraftEdit,
    clearDrafts: clearDockedDrafts,
    syncDismissedEditors: syncDismissedDockedEditors,
  } = useFloatingDraftEditors<
    Extract<VideoTool, 'hd' | 'parse' | 'removeSubtitle' | 'audioSplit'>,
    'video-tool-panel',
    Record<string, unknown>,
    VideoTool
  >({
    tools: ['hd', 'parse', 'removeSubtitle', 'audioSplit'] as const,
    currentTool: activeTool,
    setCurrentTool: (tool) => setActiveTool(tool),
    buildToolConfig: (tool, seed) => ({ ...defaultVideoToolConfig(tool, currentParams, videoMeta), ...(seed || {}), tool }),
    persistToolConfig: persistVideoToolConfig,
    panelKindByTool: {
      hd: 'video-tool-panel',
      parse: 'video-tool-panel',
      removeSubtitle: 'video-tool-panel',
      audioSplit: 'video-tool-panel',
    },
    setPanelOpen: (kind, next) => setVideoFloatingPanelOpen(kind, next),
    isPanelOpen: (kind) => activeFloatingPanelKind === kind,
    rememberSnapshot: rememberToolEditSnapshot,
    restoreSnapshot: restoreToolEditSnapshot,
    clearSnapshot: () => {
      toolEditSnapshotRef.current = null;
    },
    getToolFromSnapshot: (snapshot) => (typeof snapshot?.videoTool === 'string' ? snapshot.videoTool as VideoTool : null),
  });
  const cropDraftConfig = getFloatingDraft('crop');
  const clipDraftConfig = getFloatingDraft('clip');
  const hasAnyToolDraft = hasFloatingDraft || hasDockedDraft;

  useEffect(() => {
    if (hasAnyToolDraft) return;
    setActiveTool(typeof currentParams.videoTool === 'string' ? (currentParams.videoTool as VideoTool) : null);
  }, [currentParams.videoTool, hasAnyToolDraft]);

  useEffect(() => {
    if (hasFloatingDraft) {
      closeVideoFloatingPanel('video-tool-panel');
      return;
    }
    if (!isNodeInteractionActive) {
      closeVideoFloatingPanel('video-tool-panel');
      return;
    }
    setToolPanelOpen(Boolean(currentParams.videoTool) && currentParams.videoTool !== 'crop' && currentParams.videoTool !== 'clip');
  }, [closeVideoFloatingPanel, currentParams.videoTool, hasFloatingDraft, isNodeInteractionActive, setToolPanelOpen]);

  useEffect(() => {
    if (!hasFloatingDraft) return;
    void syncDismissedEditors();
  }, [hasFloatingDraft, syncDismissedEditors]);

  useEffect(() => {
    if (!hasDockedDraft || toolPanelOpen || isNodeInteractionActive) return;
    void syncDismissedDockedEditors();
  }, [hasDockedDraft, isNodeInteractionActive, syncDismissedDockedEditors, toolPanelOpen]);

  const models = useMemo<VideoModelOption[]>(() => {
    const catalogModels = catalogItems.filter(
      (model) => model.nodeTypes.includes('video') && model.mode === 'video',
    );
    const sourceOptions: VideoModelOption[] = catalogModels.length > 0
      ? catalogModels.map((model) => {
          const localKey = findProviderKeyState(apiKeys, model.provider, 'video');
          const activated = Boolean(
            model.activated
            || modelMatchesLocalKey(
              {
                id: model.id,
                name: model.name,
                provider: model.provider,
                upstreamModel: String(model.model || model.id),
              },
              localKey,
              'video',
            ),
          );
          const cost = normalizeVideoCost(Number(model.price || 0), model.currency || 'CNY');
          return {
            id: model.id,
            name: model.name,
            description: model.description,
            cost: cost.cost,
            currency: cost.currency,
            latency: model.latency || '',
            provider: model.provider,
            providerLabel: model.providerMeta?.name || model.provider,
            upstreamModel: String(model.model || model.id),
            activated,
            discountLabel: model.discountLabel,
            maskedKey: model.maskedKey || localKey?.maskedKey,
            activationModelMatched: model.activationModelMatched ?? true,
            activationModel: model.activationModel || localKey?.model || '',
            activationRelaySource: model.activationRelaySource || null,
            capabilities: model.capabilities || null,
          };
        })
      : FALLBACK_MODELS.map((model) => {
          const cost = normalizeVideoCost(model.cost, model.currency || 'CNY');
          return { ...model, cost: cost.cost, currency: cost.currency };
        });
    return dedupeVideoModels(sourceOptions);
  }, [apiKeys, catalogItems]);
  const currentGenerationMode = String(currentParams.generationMode || 'textToVideo');
  const identityController = useMemo<IdentityControllerConfig>(
    () => readIdentityControllerConfig(currentParams.identityController, referenceInputs),
    [currentParams.identityController, referenceInputs],
  );
  const capabilityRequirements = useMemo(
    () => [
      ...buildVideoModelCapabilityRequirements({
        generationMode: currentGenerationMode,
        primaryInputs,
        referenceInputs,
        identityController,
      }),
      ...regionCapabilityRequirements,
    ],
    [currentGenerationMode, identityController, primaryInputs, referenceInputs, regionCapabilityRequirements],
  );
  const primaryVideoConstraint = useMemo(
    () => readPrimaryVideoConstraint(primaryInputs),
    [primaryInputs],
  );
  const modelsWithSupport = useMemo<VideoModelOption[]>(
    () => models.map((model) => {
      const support = evaluateModelCapabilitySupport(model.capabilities || undefined, capabilityRequirements);
      const modelText = videoRoutingHintText(model);
      const klingSourceConstraintHit = Boolean(
        primaryVideoConstraint
        && primaryVideoConstraint.supported === false
        && (videoModelMatchesIdentifier(model, 'kling-o3') || modelText.includes('kling')),
      );
      const seedancePrimaryVideoRouteGap = Boolean(
        primaryInputs.some((item) => item.enabled !== false && item.type === 'video')
        && videoModelMatchesIdentifier(model, 'seedance-v2'),
      );
      return {
        ...model,
        supportedForCurrentRequest: support.supported && !klingSourceConstraintHit && !seedancePrimaryVideoRouteGap,
        unsupportedReason: klingSourceConstraintHit
          ? primaryVideoConstraint?.reason || support.reason
          : seedancePrimaryVideoRouteGap
            ? '当前已接入的 Seedance V2 聚合链路尚未验证通过主视频编辑 / video_urls 协议。要做保运镜换主体与全能参考，建议优先切到 Kling V3 Omni；如果只是草案预演，可改用 Wan 2.2 I2V。'
          : support.reason,
      };
    }),
    [capabilityRequirements, models, primaryInputs, primaryVideoConstraint],
  );
  const selectableModels = useMemo(
    () => modelsWithSupport.filter((model) => model.supportedForCurrentRequest !== false),
    [modelsWithSupport],
  );

  const preferredModel = useMemo(
    () => choosePreferredVideoModel(selectableModels.length ? selectableModels : modelsWithSupport, currentGenerationMode),
    [currentGenerationMode, modelsWithSupport, selectableModels],
  );
  const selectedModelId = String(data?.model || preferredModel?.id || modelsWithSupport[0]?.id || FALLBACK_MODELS[0].id);
  const selectedModel = useMemo(
    () => [...modelsWithSupport, ...FALLBACK_MODELS]
      .find((item, index, items) => (
        items.findIndex((candidate) => candidate.id === item.id) === index
        && videoModelMatchesIdentifier(item, selectedModelId)
      )) || modelsWithSupport[0] || FALLBACK_MODELS[0],
    [modelsWithSupport, selectedModelId],
  );
  const allowedQualityOptions = useMemo(() => computeAllowedQualityOptions(selectedModel), [selectedModel]);

  const selectedModelCapabilityBoundaryMessage = selectedModel.supportedForCurrentRequest === false
    ? (selectedModel.unsupportedReason || '当前模型能力不足，无法满足当前视频工作流。')
    : '';
  const selectedModelCapabilityRecommendation = (preferredModel || selectableModels[0] || null)
    ? `${(preferredModel || selectableModels[0])!.providerLabel || (preferredModel || selectableModels[0])!.provider} · ${String((preferredModel || selectableModels[0])!.upstreamModel || (preferredModel || selectableModels[0])!.id)}`
    : '';
  const regionContractNotice = useMemo(
    () => buildVerboseRegionContractNotice(activeRegionContract, selectedModelCapabilityRecommendation),
    [activeRegionContract, selectedModelCapabilityRecommendation],
  );
  const selectedModelActivated = Boolean(
    (selectedModel?.activated && selectedModel.activationModelMatched !== false)
    || modelMatchesLocalKey(
      {
        id: selectedModel.id,
        name: selectedModel.name,
        provider: selectedModel.provider,
        upstreamModel: selectedModel.upstreamModel,
      },
      findProviderKeyState(apiKeys, selectedModel.provider, 'video'),
      'video',
    ),
  );
  const selectedCount = useMemo(() => clampCount(currentParams.count, 1), [currentParams.count]);
  const promptAssistProvider = useMemo(
    () => pickPromptAssistProvider(selectedModel.provider, apiKeys),
    [apiKeys, selectedModel.provider],
  );
  const canSubmitPrompt = Boolean(prompt.trim() || regionContractPrompt.trim());
  const selectedAspectRatio = String(data?.aspectRatio || currentParams.aspectRatio || '16:9');
  const selectedQuality = String(data?.quality || currentParams.quality || '720p');
  const selectedDuration = Math.max(1, Math.round(Number(data?.duration || currentParams.duration || 5)));
  const selectedMotionPreset = String(recordFrom(currentParams.videoToolConfig).motionPreset || currentParams.motionPreset || 'static');
  const localVideoAnalysis = useMemo(
    () => (
      currentParams.localVideoAnalysis
      && typeof currentParams.localVideoAnalysis === 'object'
      && !Array.isArray(currentParams.localVideoAnalysis)
        ? currentParams.localVideoAnalysis as Record<string, unknown>
        : null
    ),
    [currentParams.localVideoAnalysis],
  );
  const durationMultiplier = useMemo(() => Math.max(1, Number(data?.duration || currentParams.duration || 5) / 5), [currentParams.duration, data?.duration]);
  const estimatedSeconds = useMemo(
    () => parseLatencySeconds(selectedModel.latency) * selectedCount * durationMultiplier,
    [durationMultiplier, selectedCount, selectedModel.latency],
  );
  const estimatedCost = useMemo(
    () => Number(selectedModel.cost || 0) * selectedCount * durationMultiplier * videoModelQualityCostMultiplier(selectedModel, selectedQuality),
    [durationMultiplier, selectedCount, selectedModel, selectedQuality],
  );

  useEffect(() => {
    if (!preferredModel) return;
    const shouldHydrateDefault = !data?.model;
    const shouldPromoteActivatedDefault = !shouldHydrateDefault
      && !modelPinnedByUser
      && !selectedModelActivated
      && preferredModel.activated
      && selectedModel.id !== preferredModel.id;
    if (!shouldHydrateDefault && !shouldPromoteActivatedDefault) return;
    updateNodeData(id, {
      model: preferredModel.id,
      provider: preferredModel.provider,
      params: {
        ...currentParams,
        modelPinnedByUser,
      },
    });
  }, [currentParams, data?.model, id, modelPinnedByUser, preferredModel, selectedModel.id, selectedModelActivated, updateNodeData]);

  // 切换到文生视频/图生视频/首尾帧/参考生成时，按效果 + 性价比自适应推荐该模式最优（国内平台优先）模型。
  const adaptiveVideoModeRef = useRef(currentGenerationMode);
  useEffect(() => {
    if (adaptiveVideoModeRef.current === currentGenerationMode) return;
    adaptiveVideoModeRef.current = currentGenerationMode;
    if (!preferredModel || selectedModel.id === preferredModel.id) return;
    updateNodeData(id, {
      model: preferredModel.id,
      provider: preferredModel.provider,
      params: { ...currentParams, modelPinnedByUser: false },
    });
  }, [currentGenerationMode, currentParams, id, preferredModel, selectedModel.id, updateNodeData]);

  const videoUrl = useMemo(() => {
    const directUrl = typeof data?.videoUrl === 'string' ? data.videoUrl : '';
    const outputUrl = (data?.outputs as Array<{ url?: string }> | undefined)?.find((item) => item?.url)?.url ?? '';
    return directUrl || outputUrl;
  }, [data?.outputs, data?.videoUrl]);
  const originalVideoUrl = useMemo(() => {
    const outputs = data?.outputs as Array<{ metadata?: Record<string, unknown>; url?: string }> | undefined;
    const originalUrl = outputs?.find((item) => typeof item?.metadata?.originalUrl === 'string')?.metadata?.originalUrl;
    return typeof originalUrl === 'string' && originalUrl ? originalUrl : videoUrl;
  }, [data?.outputs, videoUrl]);
  const renderVideoUrl = useMemo(() => toRenderableAssetUrl(videoUrl, 'video'), [videoUrl]);
  const effectiveRenderVideoUrl = renderVideoUrl || restoredVideoUrl;

  const videoMimeType = useMemo(() => {
    const direct = typeof currentParams.videoMimeType === 'string' ? currentParams.videoMimeType.trim() : '';
    if (direct) return direct;
    const outputs = (data?.outputs as Array<{ metadata?: Record<string, unknown> }> | undefined) || [];
    const match = outputs.find((item) => typeof item?.metadata?.mimeType === 'string');
    return typeof match?.metadata?.mimeType === 'string' ? match.metadata.mimeType : '';
  }, [currentParams.videoMimeType, data?.outputs]);

  const activeVideoTool = activeTool || (typeof currentParams.videoTool === 'string' ? (currentParams.videoTool as VideoTool) : null);
  const videoToolConfig = useMemo(
    () => activeVideoTool ? defaultVideoToolConfig(activeVideoTool, currentParams, videoMeta) : recordFrom(currentParams.videoToolConfig),
    [activeVideoTool, currentParams, videoMeta],
  );
  const dockedDraftConfig = useMemo(() => {
    if (!activeVideoTool || activeVideoTool === 'crop' || activeVideoTool === 'clip') return null;
    return getDockedDraft(activeVideoTool as Extract<VideoTool, 'hd' | 'parse' | 'removeSubtitle' | 'audioSplit'>);
  }, [activeVideoTool, getDockedDraft]);
  const isClipEditing = clipEditorOpen && activeVideoTool === 'clip' && Boolean(clipDraftConfig);
  const isCropEditing = cropEditorOpen && activeVideoTool === 'crop' && Boolean(cropDraftConfig);
  const effectiveVideoToolConfig = isClipEditing && clipDraftConfig
    ? clipDraftConfig
    : isCropEditing && cropDraftConfig
      ? cropDraftConfig
      : dockedDraftConfig || videoToolConfig;
  const isRemoveSubtitleManualEditing = activeVideoTool === 'removeSubtitle'
    && String(recordFrom(effectiveVideoToolConfig).detectionMode || 'auto') === 'manual';
  const appliedClipPreviewRange = useMemo(() => {
    if (String(currentParams.videoTool || '') !== 'clip' || isClipEditing) return null;
    const config = recordFrom(currentParams.videoToolConfig);
    if (!config.appliedToAsset) return null;
    const rawStart = Number(config.clipPreviewStart ?? currentParams.clipPreviewStart);
    const rawEnd = Number(config.clipPreviewEnd ?? currentParams.clipPreviewEnd);
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) return null;
    const start = Math.max(0, rawStart);
    const end = Math.max(start + 0.05, rawEnd);
    return { start, end };
  }, [currentParams.clipPreviewEnd, currentParams.clipPreviewStart, currentParams.videoTool, currentParams.videoToolConfig, isClipEditing]);
  const selectedGenerationMode = currentGenerationMode;

  const hasVideo = Boolean(videoUrl || effectiveRenderVideoUrl);
  const hasRenderableVideo = Boolean(effectiveRenderVideoUrl);
  const toolViewportScale = useMemo(() => {
    const zoom = Math.max(0.1, canvasZoom || 1);
    const normalized = 1 / zoom;
    return Number(Math.max(0.9, Math.min(1.12, normalized)).toFixed(3));
  }, [canvasZoom]);

  useEffect(() => {
    if (!isNodeInteractionActive || !hasRenderableVideo) return;
    primeFFmpegEngine();
  }, [hasRenderableVideo, isNodeInteractionActive]);
  const displaySize = useMemo(() => getVideoDisplaySize(videoMeta), [videoMeta]);
  const confirmedCropRect = useMemo(
    () => (!isCropEditing && activeVideoTool === 'crop' && currentParams.localVideoEditTool !== 'crop' ? getVideoCropRect(videoToolConfig) : null),
    [activeVideoTool, currentParams.localVideoEditTool, isCropEditing, videoToolConfig],
  );
  const cropPreviewLayout = useMemo(
    () => getVideoCropPreviewLayout(displaySize, confirmedCropRect, videoMeta),
    [confirmedCropRect, displaySize, videoMeta],
  );
  const ratioText = videoMeta
    ? `${Math.round(videoMeta.width / gcd(videoMeta.width, videoMeta.height))}:${Math.round(videoMeta.height / gcd(videoMeta.width, videoMeta.height))}`
    : '16:9';
  const durationText = videoMeta?.duration ? `${Math.max(1, Math.round(videoMeta.duration))}s` : `${Math.max(1, Number(data?.duration || 5))}s`;
  const dimensionText = videoMeta ? `${Math.round(videoMeta.width)} x ${Math.round(videoMeta.height)}` : '';
  const generationProgress = useMemo(() => {
    const raw = currentParams.generationProgress;
    return Array.isArray(raw) ? raw : [];
  }, [currentParams.generationProgress]);
  const latestProgress = generationProgress.length > 0
    ? generationProgress[generationProgress.length - 1] as Record<string, unknown>
    : null;
  const compactGenerationStatus = useMemo(() => {
    const stage = String(latestProgress?.stage || '').trim().toLowerCase();
    const message = String(latestProgress?.message || '').trim().toLowerCase();
    if (stage.includes('queue') || stage.includes('queued') || message.includes('queue') || message.includes('排队')) {
      return '排队中';
    }
    if (stage.includes('upload') || stage.includes('submit') || message.includes('submit') || message.includes('提交')) {
      return '提交中';
    }
    if (stage.includes('deliver') || stage.includes('callback') || stage.includes('final') || message.includes('回填')) {
      return '回填中';
    }
    return '生成中';
  }, [latestProgress]);
  const lastErrorCategory = typeof currentParams.lastErrorCategory === 'string' ? currentParams.lastErrorCategory : '';
  const videoOutcome = useMemo(() => getVideoOutcomeLabel(data, currentParams), [currentParams, data]);
  const preflightVideoIssue = useMemo<RenderableAssetIssue | null>(
    () => classifyRenderableAssetIssue(originalVideoUrl, 'video'),
    [originalVideoUrl],
  );
  const effectiveVideoRenderError = videoRenderError || preflightVideoIssue?.detail || (
    hasVideo && !hasRenderableVideo && !restoringVideoUrl
      ? (
        isTransientBlobUrl(videoUrl)
          ? '这是旧画布里的历史本地缓存视频，浏览器重启后原始 blob 已失效，请重新上传或重新生成。'
          : '视频地址暂时不可用，建议重新上传或重新生成。'
      )
      : null
  );
  const effectiveVideoOutcome = useMemo(() => {
    if (effectiveVideoRenderError) {
      return {
        tone: 'error' as const,
        label: preflightVideoIssue?.summary || '资源渲染失败',
        reason: effectiveVideoRenderError,
      };
    }
    return videoOutcome;
  }, [effectiveVideoRenderError, preflightVideoIssue?.summary, videoOutcome]);

  useEffect(() => {
    setVideoRenderError(null);
  }, [effectiveRenderVideoUrl]);

  useEffect(() => {
    let cancelled = false;
    setRestoredVideoUrl('');
    setRestoringVideoUrl(false);
    if (!videoUrl || !isLocalMediaHandle(videoUrl) || renderVideoUrl) {
      return () => {
        cancelled = true;
      };
    }
    setRestoringVideoUrl(true);
    void ensureLocalMediaUrl(videoUrl).then((resolvedUrl) => {
      if (cancelled) return;
      if (resolvedUrl) {
        setRestoredVideoUrl(resolvedUrl);
        setVideoRenderError(null);
        return;
      }
      setVideoRenderError('当前本地视频缓存已失效，请重新上传，或重新执行裁剪/剪辑生成新的结果节点。');
    }).catch(() => {
      if (cancelled) return;
      setVideoRenderError('当前本地视频缓存恢复失败，请重新上传，或重新执行裁剪/剪辑生成新的结果节点。');
    }).finally(() => {
      if (!cancelled) {
        setRestoringVideoUrl(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [renderVideoUrl, videoUrl]);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) {
      return;
    }
    if (!effectiveRenderVideoUrl) {
      element.pause();
      element.removeAttribute('src');
      element.load();
      return;
    }
    element.pause();
    element.src = effectiveRenderVideoUrl;
    element.load();
  }, [effectiveRenderVideoUrl, videoMimeType]);

  function handleVideoRenderFailure(code = '', mimeText = '') {
    const genericMessage = isTransientBlobUrl(videoUrl)
      ? '这是旧画布里的历史本地缓存视频，浏览器重启后原始 blob 已失效，请重新上传或重新生成。'
      : `视频渲染失败${code}${mimeText}，请重试或重新上传。`;
    const eagerIssue = classifyRenderableAssetIssue(originalVideoUrl, 'video');
    if (eagerIssue) {
      setVideoRenderError(eagerIssue.detail);
      return;
    }
    void probeRenderableAssetIssue(effectiveRenderVideoUrl, originalVideoUrl, 'video').then((issue) => {
      setVideoRenderError(issue?.detail || genericMessage);
    }).catch(() => {
      setVideoRenderError(genericMessage);
    });
  }

  useEffect(() => {
    const element = videoRef.current;
    if (!element || !effectiveRenderVideoUrl || isClipEditing) return;

    let cancelled = false;
    const previewKey = [
      effectiveRenderVideoUrl,
      appliedClipPreviewRange?.start ?? 'full',
      appliedClipPreviewRange?.end ?? 'full',
    ].join('|');

    const primePreviewFrame = () => {
      if (cancelled) return;
      const duration = Number.isFinite(element.duration) && element.duration > 0 ? element.duration : 0;
      if (duration <= 0) return;
      const rangeStart = appliedClipPreviewRange?.start ?? 0;
      const safeTarget = Math.min(
        Math.max(rangeStart === 0 && duration > 0.05 ? 0.001 : rangeStart, 0),
        Math.max(0, duration - 0.001),
      );
      if (element.dataset.hmdaoPreviewPrimedKey === previewKey && Math.abs((element.currentTime || 0) - safeTarget) <= 0.02) {
        return;
      }
      try {
        element.pause();
        element.currentTime = safeTarget;
        element.dataset.hmdaoPreviewPrimedKey = previewKey;
      } catch {
        // noop
      }
    };

    if (element.readyState >= 1) {
      primePreviewFrame();
    }
    element.addEventListener('loadedmetadata', primePreviewFrame);
    element.addEventListener('canplay', primePreviewFrame);
    element.addEventListener('loadeddata', primePreviewFrame);
    return () => {
      cancelled = true;
      element.removeEventListener('loadedmetadata', primePreviewFrame);
      element.removeEventListener('canplay', primePreviewFrame);
      element.removeEventListener('loadeddata', primePreviewFrame);
    };
  }, [appliedClipPreviewRange?.end, appliedClipPreviewRange?.start, effectiveRenderVideoUrl, isClipEditing]);

  useEffect(() => {
    const element = videoRef.current;
    if (!element || !effectiveRenderVideoUrl || !appliedClipPreviewRange || isClipEditing) return;

    const epsilon = 0.03;
    const getBounds = () => {
      const duration = Number.isFinite(element.duration) && element.duration > 0 ? element.duration : appliedClipPreviewRange.end;
      const safeStart = Math.min(appliedClipPreviewRange.start, Math.max(0, duration - 0.05));
      const safeEnd = Math.max(safeStart + 0.05, Math.min(appliedClipPreviewRange.end, duration));
      return { safeStart, safeEnd };
    };

    const clampIntoRange = () => {
      const { safeStart, safeEnd } = getBounds();
      const nextTime = element.currentTime || 0;
      if (nextTime < safeStart - epsilon || nextTime > safeEnd) {
        try {
          element.currentTime = safeStart === 0 && safeEnd > 0.05 ? 0.001 : safeStart;
        } catch {
          // noop
        }
      }
    };

    const handleTimeUpdate = () => {
      const { safeStart, safeEnd } = getBounds();
      const nextTime = element.currentTime || 0;
      if (nextTime >= safeEnd - epsilon) {
        element.pause();
        try {
          element.currentTime = safeStart === 0 && safeEnd > 0.05 ? 0.001 : safeStart;
        } catch {
          // noop
        }
      }
    };

    clampIntoRange();
    element.addEventListener('loadedmetadata', clampIntoRange);
    element.addEventListener('seeked', clampIntoRange);
    element.addEventListener('play', clampIntoRange);
    element.addEventListener('timeupdate', handleTimeUpdate);
    return () => {
      element.removeEventListener('loadedmetadata', clampIntoRange);
      element.removeEventListener('seeked', clampIntoRange);
      element.removeEventListener('play', clampIntoRange);
      element.removeEventListener('timeupdate', handleTimeUpdate);
    };
  }, [appliedClipPreviewRange, effectiveRenderVideoUrl, isClipEditing]);

  function modeUploadPatch(target: VideoUploadTarget, file: File, url: string, kind: 'image' | 'video', assetId: string, dataUrl = '') {
    const base = {
      [`${target}Name`]: file.name,
      [`${target}AssetId`]: assetId,
      [`${target}MediaType`]: kind,
      modeMediaUpdatedAt: Date.now(),
    };
    if (target === 'sourceImage') {
      return {
        ...base,
        sourceUrl: url,
        sourceDataUrl: dataUrl || undefined,
        sourceAssetId: assetId,
        sourceMediaType: kind,
        imageToVideoSourceUrl: url,
        imageToVideoSourceDataUrl: dataUrl || undefined,
      };
    }
    if (target === 'firstFrame') {
      return { ...base, firstFrameUrl: url, firstFrameDataUrl: dataUrl || undefined };
    }
    if (target === 'lastFrame') {
      return { ...base, lastFrameUrl: url, lastFrameDataUrl: dataUrl || undefined };
    }
    if (target === 'referenceImage') {
      return {
        ...base,
        referenceImageUrl: url,
        referenceImageDataUrl: dataUrl || undefined,
        referenceAssetId: assetId,
        referenceMediaType: kind,
      };
    }
    if (target === 'referenceVideo') {
      return { ...base, referenceVideoUrl: url, referenceAssetId: assetId, referenceMediaType: kind };
    }
    return {
      ...base,
      sourceUrl: url,
      sourceDataUrl: dataUrl || undefined,
      sourceAssetId: assetId,
      sourceMediaType: kind,
    };
  }

  function probeVideoMeta(url: string, nextParams: Record<string, unknown>) {
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.src = url;
    probe.onloadedmetadata = () => {
      const nextMeta = {
        width: probe.videoWidth || 1280,
        height: probe.videoHeight || 720,
        duration: Number.isFinite(probe.duration) ? probe.duration : 0,
      };
      updateNodeData(id, {
        aspectRatio: nextMeta.width >= nextMeta.height ? '16:9' : '9:16',
        duration: Math.max(1, Math.round(nextMeta.duration || 5)),
        params: {
          ...nextParams,
          videoMeta: nextMeta,
        },
      });
    };
  }

  async function applyUploadedFile(file: File, target: VideoUploadTarget = 'main') {
    const url = registerLocalMedia(file);
    const renderUrl = toRenderableAssetUrl(url, mediaKindFromFile(file) === 'video' ? 'video' : 'image');
    const kind = mediaKindFromFile(file);
    if (kind === 'unknown') return;
    const dataUrl = kind === 'image' ? await fileToDataUrl(file) : '';
    const assetId = addAssetItem(createMediaDescriptor(file, url, kind, target));
    const nextParams = {
      ...currentParams,
      ...modeUploadPatch(target, file, url, kind, assetId, dataUrl),
    };

    if (target !== 'main') {
      updateNodeData(id, { params: nextParams });
      void persistUploadedFileInBackground(file, target, kind, url, assetId, dataUrl);
      return;
    }

    if (kind === 'image') {
      updateNodeData(id, {
        imageUrl: url,
        aspectRatio: String(currentParams.aspectRatio || data?.aspectRatio || '16:9'),
        params: {
          ...nextParams,
          generationMode: 'imageToVideo',
          sourceUrl: url,
          sourceDataUrl: dataUrl || undefined,
          sourceAssetId: assetId,
          sourceMediaType: 'image',
          imageToVideoSourceDataUrl: dataUrl || undefined,
        },
      });
      return;
    }

    updateNodeData(id, {
      videoUrl: url,
      status: 'completed',
      outputs: [
        {
          id: `video-${Date.now()}`,
          type: 'video',
          url,
          metadata: {
            source: 'upload',
            name: file.name,
            size: file.size,
            mimeType: file.type,
            managedUrl: true,
          },
        },
      ],
      params: nextParams,
    });
    probeVideoMeta(renderUrl || url, nextParams);
    void persistUploadedFileInBackground(file, target, kind, url, assetId, dataUrl);
  }

  async function openFilePicker(event?: { preventDefault: () => void; stopPropagation: () => void }, target: VideoUploadTarget = 'main') {
    if (event) stopVideoPanelInteraction(event);
    uploadTargetRef.current = target;

    const pickerWindow = window as WindowWithPicker;
    if (pickerWindow.showOpenFilePicker) {
      try {
        const [handle] = await pickerWindow.showOpenFilePicker({
          excludeAcceptAllOption: false,
          multiple: false,
          types: [
            {
              description: target === 'main' ? 'Videos or images' : 'Mode reference media',
              accept: {
                'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.svg'],
                'video/*': ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'],
              },
            },
          ],
        });
        if (!handle) return;
        const file = await handle.getFile();
        await applyUploadedFile(file, target);
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
      }
    }

    fileInputRef.current?.click();
  }

  function handleUploadFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    void applyUploadedFile(file, uploadTargetRef.current);
    event.target.value = '';
  }

  function chooseAsset(asset: AssetItem) {
    markVideoPanelInteraction();
    const nextMeta = asset.width && asset.height
      ? { width: asset.width, height: asset.height, duration: Number(asset.duration || 0) }
      : undefined;
    updateNodeData(id, {
      videoUrl: asset.url,
      status: 'completed',
      aspectRatio: nextMeta ? (nextMeta.width >= nextMeta.height ? '16:9' : '9:16') : String(data?.aspectRatio || '16:9'),
      duration: Math.max(1, Number(asset.duration || data?.duration || 5)),
      params: {
        ...currentParams,
        videoMeta: nextMeta || currentParams.videoMeta,
        sourceAssetId: asset.id,
      },
      outputs: [
        {
          id: `asset-${asset.id}-${Date.now()}`,
          type: 'video',
          url: asset.url,
          thumbnail: asset.thumbnail,
          metadata: {
            source: 'asset-library',
            name: asset.name,
            size: asset.size,
            width: asset.width,
            height: asset.height,
            duration: asset.duration,
          },
        },
      ],
    });
    setAssetMenuOpen(false);
  }

  function chooseModel(model: VideoModelOption) {
    markVideoPanelInteraction();
    const nextCapabilityBoundaryMessage = model.supportedForCurrentRequest === false
      ? (model.unsupportedReason || '当前模型能力不足，无法满足当前视频工作流。')
      : undefined;
    const shouldClearCapabilityError = currentParams.lastErrorStage === 'capability-matrix';
    updateNodeData(id, {
      ...(shouldClearCapabilityError ? { status: 'pending', error: undefined } : {}),
      model: model.id,
      provider: model.provider,
      params: {
        ...currentParams,
        modelPinnedByUser: true,
        capabilityBoundaryMessage: nextCapabilityBoundaryMessage,
        capabilityBoundaryStage: nextCapabilityBoundaryMessage ? 'capability-matrix' : undefined,
        capabilityBoundaryRecommendedModel: nextCapabilityBoundaryMessage ? selectedModelCapabilityRecommendation : undefined,
        lastError: shouldClearCapabilityError ? undefined : currentParams.lastError,
        lastErrorCategory: shouldClearCapabilityError ? undefined : currentParams.lastErrorCategory,
        lastErrorStage: shouldClearCapabilityError ? undefined : currentParams.lastErrorStage,
      },
    });
    setModelMenuOpen(false);
  }

  function setOutputCount(count: number) {
    markVideoPanelInteraction();
    updateNodeData(id, {
      params: {
        ...currentParams,
        count: clampCount(count, 1),
      },
    });
  }

  function writePrompt(value: string) {
    setPrompt(value);
    if (promptCompositionRef.current) return;
    updateNodeData(id, {
      prompt: value,
      params: {
        ...currentParams,
        prompt: value,
      },
    });
  }

  function updateVideoParams(patch: Record<string, unknown>) {
    markVideoPanelInteraction();
    const nextAspectRatio = typeof patch.aspectRatio === 'string' ? patch.aspectRatio : undefined;
    const nextQuality = typeof patch.quality === 'string' ? patch.quality : undefined;
    const nextDuration = typeof patch.duration === 'number' ? patch.duration : undefined;
    updateNodeData(id, {
      ...(nextAspectRatio ? { aspectRatio: nextAspectRatio } : {}),
      ...(nextQuality ? { quality: nextQuality } : {}),
      ...(nextDuration ? { duration: nextDuration } : {}),
      params: {
        ...currentParams,
        ...patch,
      },
    });
  }

  function persistVideoToolConfig(tool: VideoTool, patch: Record<string, unknown>) {
    markVideoPanelInteraction();
    const base = defaultVideoToolConfig(tool, currentParams, videoMeta);
    const nextConfig = { ...base, ...patch, tool };
    const feedback = TOOL_FEEDBACK[tool];
    updateNodeData(id, {
      params: {
        ...currentParams,
        videoTool: tool,
        videoToolOperation: VIDEO_TOOL_OPERATIONS[tool],
        videoToolConfig: nextConfig,
        videoToolFeedback: feedback,
        videoToolUpdatedAt: Date.now(),
        clip: tool === 'clip',
        crop: tool === 'crop',
        quality: currentParams.quality,
        parse: tool === 'parse',
        removeSubtitle: tool === 'removeSubtitle',
        audioSplit: tool === 'audioSplit',
      },
    });
  }

  function getLatestVideoNodeParams() {
    const latestNode = useCanvasStore.getState().canvas?.nodes.find((item) => item.id === id);
    const latestParams = latestNode?.data?.params;
    return latestParams && typeof latestParams === 'object'
      ? latestParams as typeof currentParams
      : currentParams;
  }

  function buildVideoToolLifecycleParams(tool: VideoTool, config: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const latestParams = getLatestVideoNodeParams();
    const workflowGraph = buildNodeWorkflowGraph({
      nodeId: id,
      nodeType: 'video',
      executionMode: tool === 'parse' ? 'analysis' : 'editing',
      generationMode: String(latestParams.generationMode || currentParams.generationMode || currentGenerationMode || ''),
      provider: typeof data?.provider === 'string' ? data.provider : selectedModel.provider,
      model: typeof data?.model === 'string' ? data.model : selectedModel.id,
      prompt,
      sourceMediaType: String(latestParams.sourceMediaType || currentParams.sourceMediaType || 'video'),
      toolOperation: VIDEO_TOOL_OPERATIONS[tool],
      primaryInputs,
      referenceInputs,
      identityController,
    });
    return {
      ...latestParams,
      videoTool: tool,
      videoToolOperation: VIDEO_TOOL_OPERATIONS[tool],
      videoToolConfig: config,
      workflowGraph,
      workflowTemplateVersion: workflowGraph.templateVersion,
      ...extra,
    };
  }

  async function persistUploadedFileInBackground(
    file: File,
    target: VideoUploadTarget,
    kind: 'image' | 'video',
    localHandle: string,
    tempAssetId: string,
    dataUrl = '',
  ) {
    try {
      const persisted = await enqueueLocalAssetPersistence(file, {
        folderId: 'root',
        sourceUrl: file.name,
      });
      const persistedAssetId = String(persisted.item.backendAssetId || persisted.item.id || '').trim();
      const persistedUrl = String(persisted.item.url || '').trim();
      if (!persistedAssetId || !persistedUrl) return;

      const latestNode = useCanvasStore.getState().getNodeById(id);
      const latestData = latestNode?.data && typeof latestNode.data === 'object' ? latestNode.data as NodeData : data;
      const latestParams = latestData?.params && typeof latestData.params === 'object'
        ? latestData.params as Record<string, unknown>
        : {};
      const slotAssetIdKey = `${target}AssetId`;
      if (String(latestParams[slotAssetIdKey] || '').trim() !== tempAssetId) return;

      syncPersistedItems([persisted.item]);
      deleteAssetItems([tempAssetId]);
      revokeLocalMedia(localHandle);

      const persistedPatch = modeUploadPatch(target, file, persistedUrl, kind, persistedAssetId, dataUrl);
      const nextParams: Record<string, unknown> = {
        ...latestParams,
        ...persistedPatch,
        [`${target}PersistedAssetId`]: persistedAssetId,
      };

      if (target === 'sourceImage' || target === 'main') {
        nextParams.sourcePersistedAssetId = persistedAssetId;
      }
      if (target === 'referenceImage' || target === 'referenceVideo') {
        nextParams.referencePersistedAssetId = persistedAssetId;
      }

      if (target !== 'main') {
        updateNodeData(id, { params: nextParams });
        return;
      }

      if (kind === 'image') {
        updateNodeData(id, {
          imageUrl: persistedUrl,
          params: {
            ...nextParams,
            generationMode: 'imageToVideo',
            sourceUrl: persistedUrl,
            sourceAssetId: persistedAssetId,
            sourcePersistedAssetId: persistedAssetId,
            sourceMediaType: 'image',
            imageToVideoSourceUrl: persistedUrl,
          },
        });
        return;
      }

      const nextOutputs = Array.isArray(latestData?.outputs) ? latestData.outputs : [];
      const settledParams = {
        ...nextParams,
        sourceUrl: persistedUrl,
        sourceAssetId: persistedAssetId,
        sourcePersistedAssetId: persistedAssetId,
        sourceMediaType: 'video',
      };
      updateNodeData(id, {
        videoUrl: persistedUrl,
        outputs: nextOutputs.map((output, index) => (
          index !== 0 || output?.type !== 'video'
            ? output
            : {
                ...output,
                url: persistedUrl,
                thumbnail: persisted.item.thumbnail || output.thumbnail || persistedUrl,
                metadata: {
                  ...(output?.metadata && typeof output.metadata === 'object' ? output.metadata : {}),
                  source: 'upload',
                  name: file.name,
                  size: file.size,
                  mimeType: file.type,
                  managedUrl: true,
                  sourceAssetId: persistedAssetId,
                  persistedAssetId,
                  originalUrl: localHandle,
                },
              }
        )),
        params: settledParams,
      });
      probeVideoMeta(toRenderableAssetUrl(persistedUrl, 'video') || persistedUrl, settledParams);
    } catch {
      // keep the optimistic local handle when persistence is unavailable
    }
  }
  const {
    setGenerating: setVideoToolGeneratingState,
    finalize: finalizeVideoToolState,
  } = useNodeToolLifecycle<VideoTool>({
    nodeId: id,
    updateNodeData,
    buildParams: buildVideoToolLifecycleParams,
  });

  function rememberToolEditSnapshot() {
    if (toolEditSnapshotRef.current) return;
    toolEditSnapshotRef.current = {
      videoTool: currentParams.videoTool,
      videoToolOperation: currentParams.videoToolOperation,
      videoToolConfig: currentParams.videoToolConfig,
      videoToolFeedback: currentParams.videoToolFeedback,
      videoToolUpdatedAt: currentParams.videoToolUpdatedAt,
      clip: currentParams.clip,
      crop: currentParams.crop,
      parse: currentParams.parse,
      removeSubtitle: currentParams.removeSubtitle,
      audioSplit: currentParams.audioSplit,
    };
  }

  function restoreToolEditSnapshot() {
    const snapshot = toolEditSnapshotRef.current;
    toolEditSnapshotRef.current = null;
    if (!snapshot) return null;
    updateNodeData(id, {
      params: {
        ...currentParams,
        ...snapshot,
      },
    });
    return snapshot;
  }

  function beginCropEditing(seed?: Record<string, unknown>) {
    markVideoPanelInteraction();
    beginFloatingDraftEdit('crop', seed);
    setToolPanelOpen(false);
  }

  function buildDerivedNodeWorkflowGraph(
    nextNodeId: string,
    nodeType: NodeType,
    tool: VideoTool,
    executionMode: WorkflowExecutionMode,
    options: {
      provider?: string;
      model?: string;
      sourceMediaType?: string;
      resultLabel?: string;
      resultUrl?: string;
      mimeType?: string;
      data?: Record<string, unknown>;
    } = {},
  ): WorkflowGraph {
    const baseGraph = buildNodeWorkflowGraph({
      nodeId: nextNodeId,
      nodeType,
      executionMode,
      generationMode: String(currentParams.generationMode || currentGenerationMode || ''),
      provider: options.provider || (nodeType === 'audio' || nodeType === 'storyboard' ? 'local' : selectedModel.provider),
      model: options.model || (nodeType === 'audio' ? 'ffmpeg-approximate' : nodeType === 'storyboard' ? 'local-storyboard-parser' : selectedModel.id),
      prompt,
      sourceMediaType: options.sourceMediaType || (nodeType === 'audio' ? 'audio' : nodeType === 'storyboard' ? 'text' : 'video'),
      toolOperation: VIDEO_TOOL_OPERATIONS[tool],
      primaryInputs,
      referenceInputs,
      identityController,
    });
    return completeWorkflowGraph(baseGraph, {
      outcome: 'completed',
      artifacts: [
        {
          stageKind: 'preprocess',
          label: '源节点引用',
          kind: 'reference-pack',
          data: {
            sourceNodeId: id,
            sourceNodeType: 'video',
            sourceVideoUrl: videoUrl || '',
          },
        },
        {
          stageKind: nodeType === 'storyboard' ? 'validate' : 'deliver',
          label: options.resultLabel || '本地工具结果',
          kind: nodeType === 'storyboard' ? 'validation-report' : 'media',
          storage: workflowHandleStorage(String(options.resultUrl || '')),
          mimeType: options.mimeType,
          url: /^https?:\/\//i.test(String(options.resultUrl || '')) ? String(options.resultUrl || '') : undefined,
          handle: isLocalMediaHandle(String(options.resultUrl || '')) ? String(options.resultUrl || '') : undefined,
          data: {
            sourceNodeId: id,
            sourceNodeType: 'video',
            localTool: tool,
            ...(options.data || {}),
          },
        },
      ],
    });
  }

  function buildSourceToolCompletionWorkflowGraph(
    tool: VideoTool,
    config: Record<string, unknown>,
    options: {
      derivedNodeId?: string;
      derivedNodeType?: NodeType;
      derivedNodeLabel?: string;
      derivedSourceUrl?: string;
      mimeType?: string;
      data?: Record<string, unknown>;
      outcome?: 'completed' | 'failed';
    } = {},
  ) {
    const baseGraph = buildNodeWorkflowGraph({
      nodeId: id,
      nodeType: 'video',
      executionMode: tool === 'parse' ? 'analysis' : 'editing',
      generationMode: String(currentParams.generationMode || currentGenerationMode || ''),
      provider: typeof data?.provider === 'string' ? data.provider : selectedModel.provider,
      model: typeof data?.model === 'string' ? data.model : selectedModel.id,
      prompt,
      sourceMediaType: String(currentParams.sourceMediaType || 'video'),
      toolOperation: VIDEO_TOOL_OPERATIONS[tool],
      primaryInputs,
      referenceInputs,
      identityController,
    });
    return completeWorkflowGraph(baseGraph, {
      outcome: options.outcome || 'completed',
      artifacts: [
        {
          stageKind: 'deliver',
          label: options.derivedNodeLabel || `${TOOL_LABELS[tool]}结果节点`,
          kind: options.derivedNodeType === 'storyboard' ? 'validation-report' : 'delivery-package',
          storage: workflowHandleStorage(String(options.derivedSourceUrl || '')),
          mimeType: options.mimeType,
          url: /^https?:\/\//i.test(String(options.derivedSourceUrl || '')) ? String(options.derivedSourceUrl || '') : undefined,
          handle: isLocalMediaHandle(String(options.derivedSourceUrl || '')) ? String(options.derivedSourceUrl || '') : undefined,
          data: {
            localTool: tool,
            derivedNodeId: options.derivedNodeId || '',
            derivedNodeType: options.derivedNodeType || '',
            ...(options.data || {}),
          },
        },
      ],
    });
  }

  function createDerivedCanvasNodeId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `video-derived-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  }

  function createLocalEditResultNode(
    tool: 'crop' | 'clip' | 'hd' | 'removeSubtitle' | 'audioSplit',
    outputHandle: string,
    output: {
      size: number;
      width: number;
      height: number;
      duration: number;
      mimeType?: string;
    },
    outputAssetId: string,
    nextToolConfig: Record<string, unknown>,
    outputName: string,
    audioMixConfig?: LocalVideoAudioMixConfig | null,
  ) {
    const sourceNode = canvas?.nodes.find((item) => item.id === id);
    const outgoingCount = canvas?.edges.filter((edge) => edge.source === id).length || 0;
    const nextNodeId = createDerivedCanvasNodeId();
    const nextNodePosition = {
      x: (sourceNode?.position.x || 0) + 420,
      y: (sourceNode?.position.y || 0) + outgoingCount * 42,
    };
    const baseLabel = typeof data?.label === 'string' && data.label.trim() ? data.label.trim() : '视频节点';
    const suffix = tool === 'crop'
      ? '裁剪'
      : tool === 'clip'
        ? '剪辑'
        : tool === 'hd'
          ? '高清'
          : tool === 'removeSubtitle'
            ? '去字幕'
            : '音频分离';
    const nextLabel = `${baseLabel} · ${suffix}`;
    const nextMeta = {
      width: output.width,
      height: output.height,
      duration: output.duration,
    };
    const audioApplied = Boolean(audioMixConfig?.linkedAudioSourceUrl);
    const workflowGraph = buildDerivedNodeWorkflowGraph(nextNodeId, 'video', tool, 'editing', {
      resultLabel: nextLabel,
      resultUrl: outputHandle,
      mimeType: output.mimeType || 'video/webm',
      data: {
        outputAssetId,
        width: output.width,
        height: output.height,
        duration: output.duration,
        linkedAudioApplied: audioApplied,
      },
    });

    const nextNodeData: Partial<NodeData> = {
      label: nextLabel,
      prompt,
      model: selectedModel.id,
      provider: selectedModel.provider,
      status: 'completed',
      aspectRatio: output.width >= output.height ? '16:9' : '9:16',
      duration: Math.max(1, Math.round(output.duration || 1)),
      videoUrl: outputHandle,
      outputs: [
        {
          id: `local-${tool}-${Date.now()}`,
          type: 'video',
          url: outputHandle,
          metadata: {
            source: `local-${tool}`,
            localTool: tool,
            name: outputName,
            managedUrl: true,
            size: output.size,
            mimeType: output.mimeType || 'video/webm',
            width: output.width,
            height: output.height,
            duration: output.duration,
            originalUrl: videoUrl,
            clipPreviewStart: tool === 'clip' ? Number(nextToolConfig.clipPreviewStart || 0) : undefined,
            clipPreviewEnd: tool === 'clip' ? Number(nextToolConfig.clipPreviewEnd || 0) : undefined,
          },
        },
      ],
      params: {
        ...currentParams,
        videoTool: tool,
        videoToolOperation: VIDEO_TOOL_OPERATIONS[tool],
        videoToolConfig: nextToolConfig,
        videoMeta: nextMeta,
        videoMimeType: output.mimeType || 'video/webm',
        sourceUrl: outputHandle,
        sourceMediaType: 'video',
        sourceAssetId: outputAssetId,
        generationProgress: [],
        localVideoEditTool: tool,
        localVideoEditAt: Date.now(),
        workflowGraph,
        workflowTemplateVersion: workflowGraph.templateVersion,
        localVideoDerivedNodeId: '',
        localVideoDerivedTool: '',
        localVideoDerivedLabel: '',
        localVideoDerivedAssetId: '',
        localVideoDerivedSourceUrl: '',
        localAudioDerivedNodeId: '',
        localAudioDerivedSourceUrl: '',
        localAudioDerivedLabel: '',
        localAudioVocalNodeId: '',
        localAudioVocalSourceUrl: '',
        localAudioVocalLabel: '',
        localAudioAccompanimentNodeId: '',
        localAudioAccompanimentSourceUrl: '',
        localAudioAccompanimentLabel: '',
        linkedAudioNodeId: audioApplied ? '' : currentParams.linkedAudioNodeId,
        linkedAudioSourceUrl: audioApplied ? '' : currentParams.linkedAudioSourceUrl,
        linkedAudioAssetId: audioApplied ? '' : currentParams.linkedAudioAssetId,
        linkedAudioUpdatedAt: audioApplied ? '' : currentParams.linkedAudioUpdatedAt,
        linkedAudioApplied: audioApplied,
        linkedAudioAppliedLabel: audioApplied ? audioMixConfig?.linkedAudioLabel || currentParams.linkedAudioLabel || '' : '',
        linkedAudioAppliedMode: audioApplied ? audioMixConfig?.linkedAudioMode || currentParams.linkedAudioMode || '' : '',
        linkedAudioAppliedBackend: audioApplied ? audioMixConfig?.linkedAudioBackend || currentParams.linkedAudioBackend || '' : '',
        linkedAudioAppliedMixMode: audioApplied ? audioMixConfig?.audioMixMode || '' : '',
        linkedAudioAppliedGain: audioApplied ? audioMixConfig?.audioGain || 0 : undefined,
        linkedVideoAppliedGain: audioApplied ? audioMixConfig?.videoGain || 0 : undefined,
        linkedAudioAppliedAt: audioApplied ? Date.now() : undefined,
        lastError: '',
        lastErrorCategory: '',
      },
    };
    addConnectedNode({
      nodeId: nextNodeId,
      type: 'video',
      position: nextNodePosition,
      data: nextNodeData,
      sourceId: id,
      sourceHandle: 'media-output',
      targetHandle: 'video-main',
    });
    setSelectedNodeIds([nextNodeId]);
    return { nodeId: nextNodeId, label: nextLabel };
  }

  function createAudioResultNode(
    audioHandle: string,
    audio: {
      size: number;
      duration: number;
      format: string;
      sampleRate?: number;
      channels?: number;
      mimeType?: string;
    },
    outputAssetId: string,
    outputName: string,
    branchLabel = '音频',
  ) {
    const sourceNode = canvas?.nodes.find((item) => item.id === id);
    const outgoingCount = canvas?.edges.filter((edge) => edge.source === id).length || 0;
    const nextNodeId = createDerivedCanvasNodeId();
    const nextNodePosition = {
      x: (sourceNode?.position.x || 0) + 420,
      y: (sourceNode?.position.y || 0) + outgoingCount * 52 + 180,
    };
    const baseLabel = typeof data?.label === 'string' && data.label.trim() ? data.label.trim() : '视频节点';
    const nextLabel = `${baseLabel} · ${branchLabel}`;
    const workflowGraph = buildDerivedNodeWorkflowGraph(nextNodeId, 'audio', 'audioSplit', 'editing', {
      provider: 'local',
      model: 'ffmpeg-approximate',
      sourceMediaType: 'audio',
      resultLabel: nextLabel,
      resultUrl: audioHandle,
      mimeType: audio.mimeType || 'audio/mpeg',
      data: {
        outputAssetId,
        duration: audio.duration,
        branchLabel,
        format: audio.format,
      },
    });

    const nextNodeData: Partial<NodeData> = {
      label: nextLabel,
      provider: 'local',
      model: 'ffmpeg-approximate',
      status: 'completed',
      outputs: [
        {
          id: `local-audio-${Date.now()}`,
          type: 'audio',
          url: audioHandle,
          metadata: {
            source: 'local-audioSplit',
            localTool: 'audioSplit',
            name: outputName,
            managedUrl: true,
            size: audio.size,
            mimeType: audio.mimeType || 'audio/mpeg',
            duration: audio.duration,
            format: audio.format,
            sampleRate: audio.sampleRate,
            channels: audio.channels,
            engine: 'ffmpeg-approximate',
            backend: 'fallback-local',
            backendLabel: '本地预览链',
            requestedBackend: 'fallback-local',
            backendAvailable: true,
            fallbackUsed: false,
            sourceAssetId: outputAssetId,
            branchLabel,
          },
        },
      ],
      params: {
        audioMode: 'bgm',
        audioBackend: 'fallback-local',
        audioMeta: {
          duration: audio.duration,
          format: audio.format,
          sampleRate: audio.sampleRate,
          channels: audio.channels,
          engine: 'ffmpeg-approximate',
          backend: 'fallback-local',
          backendLabel: '本地预览链',
          requestedBackend: 'fallback-local',
          backendAvailable: true,
          fallbackUsed: false,
        },
        sourceUrl: audioHandle,
        sourceMediaType: 'audio',
        sourceAssetId: outputAssetId,
        audioBranchLabel: branchLabel,
        workflowGraph,
        workflowTemplateVersion: workflowGraph.templateVersion,
      },
    };
    addConnectedNode({
      nodeId: nextNodeId,
      type: 'audio',
      position: nextNodePosition,
      data: nextNodeData,
      sourceId: id,
      sourceHandle: 'media-output',
    });
    return { nodeId: nextNodeId, label: nextLabel };
  }

  function createParseResultNode(
    analysis: Record<string, unknown>,
    nextToolConfig: Record<string, unknown>,
  ) {
    const sourceNode = canvas?.nodes.find((item) => item.id === id);
    const outgoingCount = canvas?.edges.filter((edge) => edge.source === id).length || 0;
    const nextNodeId = createDerivedCanvasNodeId();
    const nextNodePosition = {
      x: (sourceNode?.position.x || 0) + 460,
      y: (sourceNode?.position.y || 0) + outgoingCount * 68,
    };
    const shots = normalizeParsedStoryboardShots(analysis, videoMeta);
    const baseLabel = typeof data?.label === 'string' && data.label.trim() ? data.label.trim() : '视频节点';
    const nextLabel = `${baseLabel} · 解析分镜`;
    const summary = String(analysis.summary || '已完成本地视频解析。');
    const analysisEngine = String(analysis.analysisEngine || '');
    const tableRows = shots.map((item) => ({
      shotNumber: item.shotNumber,
      startTime: item.startTime,
      endTime: item.endTime,
      duration: item.duration,
      subjectCount: item.subjectCount,
      subjectSummary: item.subjectSummary,
      subjectTraits: item.subjectTraits,
      actionSummary: item.actionSummary,
      sceneSetting: item.sceneSetting,
      storyboardPurpose: item.storyboardPurpose,
      lensSuggestion: item.lensSuggestion,
      frameDescription: item.frameDescription,
      narrativeBeat: item.narrativeBeat,
      sceneType: item.sceneType,
      cameraAngle: item.cameraAngle,
      cameraMovement: item.cameraMovement,
      focusDepth: item.focusDepth,
      lighting: item.lighting,
      soundDesign: item.soundDesign,
      cameraPrompt: item.cameraPrompt,
      imagePrompt: item.imagePrompt,
      keyframePrompt: item.keyframePrompt,
      keyframeTime: item.keyframeTime,
      visualKeywords: item.visualKeywords,
      styleDescription: item.styleDescription,
      lightingMood: item.lightingMood,
      atmosphere: item.atmosphere,
      subjectMotion: item.subjectMotion,
      cameraMotionDetail: item.cameraMotionDetail,
      compositionDetail: item.compositionDetail,
      colorPalette: item.colorPalette,
      keyframeImageBase64: item.keyframeImageBase64,
      keyframeMimeType: item.keyframeMimeType,
      keyframeWidth: item.keyframeWidth,
      keyframeHeight: item.keyframeHeight,
      metrics: item.metrics,
    }));
    const workflowGraph = buildDerivedNodeWorkflowGraph(nextNodeId, 'storyboard', 'parse', 'analysis', {
      provider: 'local',
      model: analysisEngine || 'local-storyboard-parser',
      sourceMediaType: 'text',
      resultLabel: nextLabel,
      resultUrl: `hmdao-parse://${nextNodeId}`,
      mimeType: 'application/json',
      data: {
        summary,
        analysisEngine,
        parseRowCount: tableRows.length,
        parseShotCount: shots.length,
      },
    });

    const nextNodeData: Partial<NodeData> = {
      label: nextLabel,
      status: 'completed',
      content: summary,
      outputs: [
        {
          id: `video-parse-${Date.now()}`,
          type: 'text',
          url: `hmdao-parse://${nextNodeId}`,
          metadata: {
            source: 'local-parse',
            parseSummary: summary,
            parseRows: tableRows,
            parseShots: shots,
            analysisEngine,
            sourceNodeId: id,
          },
        },
      ],
      params: {
        sourceNodeId: id,
        sourceNodeType: 'video',
        videoTool: 'parse',
        videoToolOperation: VIDEO_TOOL_OPERATIONS.parse,
        videoToolConfig: nextToolConfig,
        parseSummary: summary,
        analysisEngine,
        parseRows: tableRows,
        parseShots: shots,
        parseCreatedAt: Date.now(),
        workflowGraph,
        workflowTemplateVersion: workflowGraph.templateVersion,
      },
    };
    addConnectedNode({
      nodeId: nextNodeId,
      type: 'storyboard',
      position: nextNodePosition,
      data: nextNodeData,
      sourceId: id,
      sourceHandle: 'media-output',
    });
    setSelectedNodeIds([nextNodeId]);
    return { nodeId: nextNodeId, label: nextLabel, rowCount: tableRows.length };
  }

  function createParseScriptNode(
    summary: string,
    rows: Array<{
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
    }>,
    sourceStoryboardNodeId: string,
  ) {
    const sourceNode = canvas?.nodes.find((item) => item.id === sourceStoryboardNodeId) || canvas?.nodes.find((item) => item.id === id);
    const baseLabel = typeof data?.label === 'string' && data.label.trim() ? data.label.trim() : '视频节点';
    const nextLabel = `${baseLabel} · 分镜脚本`;
    const scriptContent = [
      '视频分镜脚本',
      summary ? `总结：${summary}` : '',
      ...rows.map((row) => (
        `镜头 ${row.shotNumber}\n`
        + `时间：${row.startTime}s - ${row.endTime}s（${row.duration}s）\n`
        + `角色数：${row.subjectCount ?? ''}\n`
        + `角色概述：${row.subjectSummary || ''}\n`
        + `角色特征：${row.subjectTraits || ''}\n`
        + `动作：${row.actionSummary || ''}\n`
        + `场景：${row.sceneSetting || ''}\n`
        + `镜头目的：${row.storyboardPurpose || ''}\n`
        + `镜头建议：${row.lensSuggestion || ''}\n`
        + `景别：${row.sceneType}\n`
        + `机位：${row.cameraAngle}\n`
        + `运镜：${row.cameraMovement}\n`
        + `焦段景深：${row.focusDepth}\n`
        + `光线：${row.lighting}\n`
        + `风格：${row.styleDescription || ''}\n`
        + `氛围：${row.atmosphere || ''}\n`
        + `主体运动：${row.subjectMotion || ''}\n`
        + `运镜细节：${row.cameraMotionDetail || ''}\n`
        + `构图细节：${row.compositionDetail || ''}\n`
        + `色板：${Array.isArray(row.colorPalette) ? row.colorPalette.join(', ') : ''}\n`
        + `画面：${row.frameDescription}\n`
        + `叙事：${row.narrativeBeat}\n`
        + `声音：${row.soundDesign}\n`
        + `运镜提示词：${row.cameraPrompt || ''}\n`
        + `画面提示词：${row.imagePrompt || ''}\n`
        + `关键帧提示词：${row.keyframePrompt || ''}`
      )),
    ].filter(Boolean).join('\n\n');

    const nextNodeId = addConnectedNode({
      type: 'script',
      position: {
        x: (sourceNode?.position.x || 0) + 920,
        y: sourceNode?.position.y || 0,
      },
      sourceId: sourceStoryboardNodeId,
      data: {
        label: nextLabel,
        status: 'completed',
        content: scriptContent,
        params: {
          sourceNodeId: id,
          sourceNodeType: 'video',
          sourceStoryboardNodeId,
          scriptMode: 'storyboard-parse',
          parseSummary: summary,
          parseRows: rows,
        },
      },
    });
    return { nodeId: nextNodeId, label: nextLabel };
  }

  function createParseKeyframeNodes(
    shots: ParsedStoryboardShot[],
    sourceStoryboardNodeId: string,
  ) {
    const sourceNode = canvas?.nodes.find((item) => item.id === sourceStoryboardNodeId) || canvas?.nodes.find((item) => item.id === id);
    const baseLabel = typeof data?.label === 'string' && data.label.trim() ? data.label.trim() : '视频节点';
    const keyframeShots = shots
      .filter((shot) => String(shot.keyframeImageBase64 || '').trim().length > 0)
      .slice(0, 8);
    return keyframeShots.map((shot, index) => {
      const mimeType = String(shot.keyframeMimeType || 'image/jpeg');
      const blob = base64ToBlob(String(shot.keyframeImageBase64 || ''), mimeType);
      const imageHandle = registerLocalMedia(blob);
      const imageWidth = Math.max(2, Number(shot.keyframeWidth || 0) || Number(videoMeta?.width || 0) || 1280);
      const imageHeight = Math.max(2, Number(shot.keyframeHeight || 0) || Number(videoMeta?.height || 0) || 720);
      const assetId = addAssetItem(createGeneratedImageDescriptor(
        `${baseLabel}-关键帧-${shot.shotNumber}.jpg`,
        imageHandle,
        blob.size,
        imageWidth,
        imageHeight,
        ['local-parse', '关键帧氛围图'],
      ));
      const column = index % 2;
      const row = Math.floor(index / 2);
      const nextLabel = `${baseLabel} · 关键帧 ${shot.shotNumber}`;
      const nextNodeId = addConnectedNode({
        type: 'image',
        position: {
          x: (sourceNode?.position.x || 0) + 930 + column * 380,
          y: (sourceNode?.position.y || 0) + 210 + row * 240,
        },
        sourceId: sourceStoryboardNodeId,
        sourceHandle: 'media-output',
        data: {
          label: nextLabel,
          status: 'completed',
          prompt: shot.imagePrompt,
          content: shot.frameDescription,
          imageUrl: imageHandle,
          outputs: [
            {
              id: `video-parse-keyframe-${shot.shotNumber}-${Date.now()}`,
              type: 'image',
              url: imageHandle,
              thumbnail: imageHandle,
              prompt: shot.imagePrompt,
              metadata: {
                source: 'local-parse-keyframe',
                sourceNodeId: id,
                sourceStoryboardNodeId,
                shotNumber: shot.shotNumber,
                keyframeTime: shot.keyframeTime,
                assetId,
                styleDescription: shot.styleDescription || '',
                atmosphere: shot.atmosphere || '',
                colorPalette: shot.colorPalette || [],
              },
            },
          ],
          params: {
            sourceNodeId: id,
            sourceNodeType: 'video',
            sourceStoryboardNodeId,
            sourceMediaType: 'image',
            sourceAssetId: assetId,
            sourceUrl: imageHandle,
            parseShotNumber: shot.shotNumber,
            parseShotTime: shot.keyframeTime,
            parseSummary: shot.frameDescription,
            parseStyleDescription: shot.styleDescription || '',
            parseAtmosphere: shot.atmosphere || '',
            parseColorPalette: shot.colorPalette || [],
          },
        },
      });
      return {
        nodeId: nextNodeId,
        label: nextLabel,
        assetId,
      };
    });
  }

  function createClipPreviewResultNode(
    outputHandle: string,
    previewMeta: { width: number; height: number; duration: number },
    nextToolConfig: Record<string, unknown>,
    outputName: string,
  ) {
    const sourceNode = canvas?.nodes.find((item) => item.id === id);
    const outgoingCount = canvas?.edges.filter((edge) => edge.source === id).length || 0;
    const nextNodeId = createDerivedCanvasNodeId();
    const nextNodePosition = {
      x: (sourceNode?.position.x || 0) + 420,
      y: (sourceNode?.position.y || 0) + outgoingCount * 42,
    };
    const baseLabel = typeof data?.label === 'string' && data.label.trim() ? data.label.trim() : '视频节点';
    const nextLabel = `${baseLabel} · 剪辑`;
    const mimeType = String(currentParams.videoMimeType || 'video/webm');
    const sourceAssetId = typeof currentParams.sourceAssetId === 'string' ? currentParams.sourceAssetId : '';

    const nextNodeData: Partial<NodeData> = {
      label: nextLabel,
      prompt,
      model: selectedModel.id,
      provider: selectedModel.provider,
      status: 'completed',
      aspectRatio: previewMeta.width >= previewMeta.height ? '16:9' : '9:16',
      duration: Math.max(1, Math.round(previewMeta.duration || 1)),
      videoUrl: outputHandle,
      outputs: [
        {
          id: `local-clip-preview-${Date.now()}`,
          type: 'video',
          url: outputHandle,
          metadata: {
            source: 'local-clip-preview',
            localTool: 'clip',
            name: outputName,
            managedUrl: isLocalMediaHandle(outputHandle),
            mimeType,
            width: previewMeta.width,
            height: previewMeta.height,
            duration: previewMeta.duration,
            originalUrl: videoUrl,
            clipPreviewStart: Number(nextToolConfig.clipPreviewStart || 0),
            clipPreviewEnd: Number(nextToolConfig.clipPreviewEnd || previewMeta.duration),
          },
        },
      ],
      params: {
        ...currentParams,
        videoTool: 'clip',
        videoToolOperation: VIDEO_TOOL_OPERATIONS.clip,
        videoToolConfig: nextToolConfig,
        videoMeta: previewMeta,
        videoMimeType: mimeType,
        sourceUrl: outputHandle,
        sourceMediaType: 'video',
        sourceAssetId: sourceAssetId || undefined,
        generationProgress: [],
        localVideoEditTool: 'clip',
        localVideoEditAt: Date.now(),
        lastError: '',
        lastErrorCategory: '',
      },
    };
    addConnectedNode({
      nodeId: nextNodeId,
      type: 'video',
      position: nextNodePosition,
      data: nextNodeData,
      sourceId: id,
      sourceHandle: 'media-output',
      targetHandle: 'video-main',
    });
    setSelectedNodeIds([nextNodeId]);
    return { nodeId: nextNodeId, label: nextLabel };
  }

  async function confirmCropEditing() {
    const nextConfig = cropDraftConfig || defaultVideoToolConfig('crop', currentParams, videoMeta);
    const audioMixConfig = deriveLinkedAudioMixConfig(currentParams);
    persistVideoToolConfig('crop', nextConfig);

    if (!effectiveRenderVideoUrl) {
      updateNodeData(id, {
        status: 'error',
        error: '当前视频源已失效，无法执行裁剪。请重新上传原视频后再试。',
        params: {
          ...currentParams,
          lastError: '当前视频源已失效，无法执行裁剪。请重新上传原视频后再试。',
          lastErrorCategory: 'render',
          lastErrorStage: 'local-crop-source',
        },
      });
      completeFloatingDraftEdit('crop', 'crop');
      return;
    }

    if (videoUrl) {
      setVideoToolGeneratingState('crop', nextConfig, {
        progress: 6,
        message: '本地裁剪准备中',
        stage: 'local-crop',
      });

      const result = await cropVideoLocally(videoUrl || effectiveRenderVideoUrl, getVideoCropRect(nextConfig), audioMixConfig || undefined, (progress) => {
        setVideoToolGeneratingState('crop', nextConfig, {
          progress: progress.percent,
          message: progress.stage,
          stage: 'local-crop',
        });
      });

      if (result.success && result.data) {
        const output = result.data;
        const outputHandle = output.blob ? registerLocalMedia(output.blob) : output.url;
        if (!outputHandle) {
          finalizeVideoToolState('crop', nextConfig, {
            status: 'error',
            error: '本地裁剪成功，但结果地址为空。',
            errorCategory: 'local-crop-materialize',
            errorStage: 'local-crop',
          });
          completeFloatingDraftEdit('crop', 'crop');
          return;
        }
        const outputName = `cropped-${Date.now()}.${output.format === 'webm' ? 'webm' : 'mp4'}`;
        const persistedCropConfig = {
          ...nextConfig,
          x: 0,
          y: 0,
          widthPercent: 100,
          heightPercent: 100,
          appliedToAsset: true,
        };
        const outputAssetId = addAssetItem(createGeneratedVideoDescriptor(
          outputName,
          outputHandle,
          output.size,
          output.width,
          output.height,
          output.duration,
          'crop',
        ));
        const derivedResult = createLocalEditResultNode('crop', outputHandle, output, outputAssetId, persistedCropConfig, outputName, audioMixConfig);
        const workflowGraph = buildSourceToolCompletionWorkflowGraph('crop', persistedCropConfig, {
          derivedNodeId: derivedResult.nodeId,
          derivedNodeType: 'video',
          derivedNodeLabel: derivedResult.label,
          derivedSourceUrl: outputHandle,
          mimeType: output.mimeType || 'video/webm',
          data: { outputAssetId },
        });
        finalizeVideoToolState('crop', persistedCropConfig, {
          status: 'completed',
          params: {
            workflowGraph,
            workflowTemplateVersion: workflowGraph.templateVersion,
            localVideoEditTool: 'crop',
            localVideoEditAt: Date.now(),
            localVideoDerivedNodeId: derivedResult.nodeId,
            localVideoDerivedTool: 'crop',
            localVideoDerivedLabel: derivedResult.label,
            localVideoDerivedAssetId: outputAssetId,
            localVideoDerivedSourceUrl: outputHandle,
            localVideoOverwriteApplied: false,
            localVideoPreviousSourceUrl: '',
            localVideoPreviousVideoMeta: undefined,
          },
        });
      } else {
        const diagnostics = getLocalVideoRecorderDiagnostics();
        finalizeVideoToolState('crop', nextConfig, {
          status: 'completed',
          error: result.error || `本地裁剪失败。当前浏览器本地录制能力：${diagnostics.chosenMimeType || '不可用'}`,
          showNodeError: true,
          params: {
            localVideoEditTool: '',
            localVideoDerivedNodeId: '',
            localVideoDerivedTool: '',
            localVideoDerivedLabel: '',
            localRecorderDiagnostics: diagnostics,
          },
          errorStage: 'local-crop',
        });
      }
    }

    completeFloatingDraftEdit('crop', 'crop');
  }

  function cancelCropEditing() {
    const previousTool = cancelFloatingDraftEdit('crop');
    setToolPanelOpen(Boolean(previousTool) && previousTool !== 'crop' && previousTool !== 'clip');
  }

  function beginClipEditing(seed?: Record<string, unknown>) {
    markVideoPanelInteraction();
    const nextConfig = beginFloatingDraftEdit('clip', seed);
    setToolPanelOpen(false);
    const video = videoRef.current;
    if (video) {
      const startTime = clampNumber((nextConfig as Record<string, unknown>).startTime ?? 0, 0, selectedDuration, 0);
      video.pause();
      try {
        video.currentTime = startTime;
      } catch {
        // noop
      }
    }
  }

  async function confirmClipEditing() {
    const nextConfig = clipDraftConfig || defaultVideoToolConfig('clip', currentParams, videoMeta);
    const audioMixConfig = deriveLinkedAudioMixConfig(currentParams);
    persistVideoToolConfig('clip', nextConfig);

    if (!effectiveRenderVideoUrl) {
      updateNodeData(id, {
        status: 'error',
        error: '当前视频源已失效，无法执行剪辑。请重新上传原视频后再试。',
        params: {
          ...currentParams,
          lastError: '当前视频源已失效，无法执行剪辑。请重新上传原视频后再试。',
          lastErrorCategory: 'render',
          lastErrorStage: 'local-clip-source',
        },
      });
      completeFloatingDraftEdit('clip', 'clip');
      return;
    }

    if (videoUrl) {
      const clipSegments = readClipSegments(nextConfig, selectedDuration).map((segment) => ({
        startTime: segment.startTime,
        endTime: segment.endTime,
      }));
      const primarySegment = clipSegments[0] || { startTime: 0, endTime: Math.max(1, selectedDuration) };

      setVideoToolGeneratingState('clip', nextConfig, {
        progress: 6,
        message: '本地剪辑准备中',
        stage: 'local-clip',
      });

      const result = await clipVideoLocallyStable(videoUrl || effectiveRenderVideoUrl, clipSegments, audioMixConfig || undefined, (progress) => {
        setVideoToolGeneratingState('clip', nextConfig, {
          progress: progress.percent,
          message: progress.stage,
          stage: 'local-clip',
        });
      });

      if (result.success && result.data) {
        const output = result.data;
        const outputHandle = output.blob ? registerLocalMedia(output.blob) : output.url;
        if (!outputHandle) {
          finalizeVideoToolState('clip', nextConfig, {
            status: 'error',
            error: '本地剪辑成功，但结果地址为空。',
            errorCategory: 'local-clip-materialize',
            errorStage: 'local-clip',
          });
          completeFloatingDraftEdit('clip', 'clip');
          return;
        }
        const outputName = `trimmed-${Date.now()}.${output.format === 'webm' ? 'webm' : 'mp4'}`;
        const persistedClipConfig = {
          ...nextConfig,
          startTime: 0,
          endTime: output.duration,
          selectedSegmentIndex: 0,
          clipSegments: [{
            id: 'segment-1',
            startTime: 0,
            endTime: output.duration,
            label: '片段 1',
          }],
          appliedToAsset: true,
          clipPreviewStart: primarySegment.startTime,
          clipPreviewEnd: primarySegment.endTime,
        };
        const outputAssetId = addAssetItem(createGeneratedVideoDescriptor(
          outputName,
          outputHandle,
          output.size,
          output.width,
          output.height,
          output.duration,
          'clip',
        ));
        const derivedResult = createLocalEditResultNode('clip', outputHandle, output, outputAssetId, persistedClipConfig, outputName, audioMixConfig);
        const workflowGraph = buildSourceToolCompletionWorkflowGraph('clip', persistedClipConfig, {
          derivedNodeId: derivedResult.nodeId,
          derivedNodeType: 'video',
          derivedNodeLabel: derivedResult.label,
          derivedSourceUrl: outputHandle,
          mimeType: output.mimeType || 'video/webm',
          data: { outputAssetId },
        });
        finalizeVideoToolState('clip', persistedClipConfig, {
          status: 'completed',
          params: {
            workflowGraph,
            workflowTemplateVersion: workflowGraph.templateVersion,
            localVideoEditTool: 'clip',
            localVideoEditAt: Date.now(),
            localVideoDerivedNodeId: derivedResult.nodeId,
            localVideoDerivedTool: 'clip',
            localVideoDerivedLabel: derivedResult.label,
            localVideoDerivedAssetId: outputAssetId,
            localVideoDerivedSourceUrl: outputHandle,
            localVideoOverwriteApplied: false,
            localVideoPreviousSourceUrl: '',
            localVideoPreviousVideoMeta: undefined,
          },
        });
      } else {
        const diagnostics = getLocalVideoRecorderDiagnostics();
        finalizeVideoToolState('clip', nextConfig, {
          status: 'error',
          error: result.error || '本地剪辑失败，未生成新的真实视频文件。',
          errorCategory: 'local-clip-materialize',
          errorStage: 'local-clip',
          params: {
            localVideoEditTool: '',
            localVideoDerivedNodeId: '',
            localVideoDerivedTool: '',
            localVideoDerivedLabel: '',
            localRecorderDiagnostics: diagnostics,
          },
        });
      }
    }

    completeFloatingDraftEdit('clip', 'clip');
  }

  function cancelClipEditing() {
    const video = videoRef.current;
    if (video) video.pause();
    const previousTool = cancelFloatingDraftEdit('clip');
    setToolPanelOpen(Boolean(previousTool) && previousTool !== 'crop' && previousTool !== 'clip');
  }

  function cancelDockedToolEditing() {
    markVideoPanelInteraction();
    clearFloatingDrafts();
    const previousTool = cancelDockedDraftEdit(activeDockedDraftTool || 'hd');
    setActiveTool(previousTool);
    setToolPanelOpen(Boolean(previousTool) && previousTool !== 'crop' && previousTool !== 'clip');
  }

  async function applyDockedToolEditing(tool: Extract<VideoTool, 'hd' | 'parse' | 'removeSubtitle' | 'audioSplit'>) {
    markVideoPanelInteraction();
    const nextConfig = {
      ...defaultVideoToolConfig(tool, currentParams, videoMeta),
      ...(activeVideoTool === tool ? effectiveVideoToolConfig : {}),
      tool,
    };
    const audioMixConfig = deriveLinkedAudioMixConfig(currentParams);
    const requestConfig = audioMixConfig ? { ...nextConfig, ...audioMixConfig } : nextConfig;
    persistVideoToolConfig(tool, nextConfig);
    try {

      if (!effectiveRenderVideoUrl) {
        updateNodeData(id, {
          status: 'error',
          error: '当前视频源已失效，请重新上传原视频后再试。',
          params: {
            ...currentParams,
            lastError: '当前视频源已失效，请重新上传原视频后再试。',
            lastErrorCategory: 'render',
            lastErrorStage: `local-${tool}-source`,
          },
        });
        completeDockedDraftEdit(tool, tool);
        return;
      }

      setVideoToolGeneratingState(tool, nextConfig, {
        progress: 6,
        message: `${TOOL_LABELS[tool]}准备中`,
        stage: `local-${tool}`,
      });

    if (tool === 'parse') {
      const result = await parseVideoLocallyEnhanced(videoUrl || effectiveRenderVideoUrl, nextConfig, (progress) => {
        setVideoToolGeneratingState(tool, nextConfig, {
          progress: progress.percent,
          message: progress.stage,
          stage: 'local-parse',
        });
      });

      if (result.success && result.data) {
        const normalizedAnalysis = result.data as unknown as Record<string, unknown>;
        const rawParsedShots = normalizeParsedStoryboardShots(normalizedAnalysis, videoMeta);
        const sanitizedParseRows = rawParsedShots.map((item) => ({
          shotNumber: item.shotNumber,
          startTime: item.startTime,
          endTime: item.endTime,
          duration: item.duration,
          subjectCount: item.subjectCount,
          subjectSummary: item.subjectSummary,
          subjectTraits: item.subjectTraits,
          actionSummary: item.actionSummary,
          sceneSetting: item.sceneSetting,
          storyboardPurpose: item.storyboardPurpose,
          lensSuggestion: item.lensSuggestion,
          frameDescription: item.frameDescription,
          narrativeBeat: item.narrativeBeat,
          sceneType: item.sceneType,
          cameraAngle: item.cameraAngle,
          cameraMovement: item.cameraMovement,
          focusDepth: item.focusDepth,
          lighting: item.lighting,
          soundDesign: item.soundDesign,
          cameraPrompt: item.cameraPrompt,
          imagePrompt: item.imagePrompt,
          keyframePrompt: item.keyframePrompt,
          keyframeTime: item.keyframeTime,
          visualKeywords: item.visualKeywords,
          styleDescription: item.styleDescription,
          lightingMood: item.lightingMood,
          atmosphere: item.atmosphere,
          subjectMotion: item.subjectMotion,
          cameraMotionDetail: item.cameraMotionDetail,
          compositionDetail: item.compositionDetail,
          colorPalette: item.colorPalette,
          keyframeImageBase64: item.keyframeImageBase64,
          keyframeMimeType: item.keyframeMimeType,
          keyframeWidth: item.keyframeWidth,
          keyframeHeight: item.keyframeHeight,
          metrics: item.metrics,
        }));
        const sanitizedAnalysis = {
          ...normalizedAnalysis,
          parseRows: sanitizedParseRows,
        };
        const parseResultNode = createParseResultNode(sanitizedAnalysis, nextConfig);
        const workflowGraph = buildSourceToolCompletionWorkflowGraph(tool, nextConfig, {
          derivedNodeId: parseResultNode.nodeId,
          derivedNodeType: 'storyboard',
          derivedNodeLabel: parseResultNode.label,
          derivedSourceUrl: `hmdao-parse://${parseResultNode.nodeId}`,
          mimeType: 'application/json',
          data: {
            summary: result.data.summary,
            analysisEngine: result.data.analysisEngine || '',
            parseRowCount: sanitizedParseRows.length,
          },
        });
        finalizeVideoToolState(tool, nextConfig, {
          status: 'completed',
          params: {
            workflowGraph,
            workflowTemplateVersion: workflowGraph.templateVersion,
            localVideoEditTool: 'parse',
            localVideoEditAt: Date.now(),
            localVideoAnalysis: sanitizedAnalysis,
            localVideoAnalysisSummary: result.data.summary,
            localVideoAnalysisEngine: result.data.analysisEngine || '',
            localVideoDerivedNodeId: parseResultNode.nodeId,
            localVideoDerivedTool: 'parse',
            localVideoDerivedLabel: parseResultNode.label,
            localParseStoryboardNodeId: parseResultNode.nodeId,
            localParseScriptNodeId: '',
            localParseKeyframeNodeIds: [],
            localParseKeyframeCount: rawParsedShots.filter((item) => String(item.keyframeImageBase64 || '').trim().length > 0).length,
          },
        });
      } else {
        finalizeVideoToolState(tool, nextConfig, {
          status: 'error',
          error: result.error || '本地视频解析失败。',
          errorCategory: 'local-parse',
          errorStage: 'local-parse',
        });
      }

      completeDockedDraftEdit(tool, tool);
      return;
    }

    if (tool === 'audioSplit') {
      const result = await splitVideoAudioLocally(videoUrl || effectiveRenderVideoUrl, requestConfig, (progress) => {
        setVideoToolGeneratingState(tool, nextConfig, {
          progress: progress.percent,
          message: progress.stage,
          stage: 'local-audioSplit',
        });
      });

      if (result.success && result.data) {
        const output = result.data.video;
        const audio = result.data.audio;
        const vocal = result.data.vocal;
        const accompaniment = result.data.accompaniment;
        const outputHandle = output.blob ? registerLocalMedia(output.blob) : output.url;
        const audioHandle = audio.blob ? registerLocalMedia(audio.blob) : audio.url;
        const vocalHandle = vocal.blob ? registerLocalMedia(vocal.blob) : vocal.url;
        const accompanimentHandle = accompaniment.blob ? registerLocalMedia(accompaniment.blob) : accompaniment.url;
        if (!outputHandle || !audioHandle || !vocalHandle || !accompanimentHandle) {
          finalizeVideoToolState(tool, nextConfig, {
            status: 'error',
            error: '本地音频分离成功，但结果地址不完整。',
            errorCategory: 'local-audioSplit-materialize',
            errorStage: 'local-audioSplit',
          });
          completeDockedDraftEdit(tool, tool);
          return;
        }
        const outputName = `audio-split-${Date.now()}.${output.format === 'webm' ? 'webm' : 'mp4'}`;
        const audioName = `audio-split-${Date.now()}.${audio.format || 'mp3'}`;
        const vocalName = `audio-vocal-${Date.now()}.${vocal.format || 'mp3'}`;
        const accompanimentName = `audio-accompaniment-${Date.now()}.${accompaniment.format || 'mp3'}`;
        const persistedConfig = {
          ...nextConfig,
          appliedToAsset: true,
        };
        const outputAssetId = addAssetItem(createGeneratedVideoDescriptor(
          outputName,
          outputHandle,
          output.size,
          output.width,
          output.height,
          output.duration,
          'audioSplit',
        ));
        const audioAssetId = addAssetItem(createGeneratedAudioDescriptor(
          audioName,
          audioHandle,
          audio.size,
          audio.duration,
          'audioSplit',
          '完整音轨',
        ));
        const vocalAssetId = addAssetItem(createGeneratedAudioDescriptor(
          vocalName,
          vocalHandle,
          vocal.size,
          vocal.duration,
          'audioSplit',
          '纯人声',
        ));
        const accompanimentAssetId = addAssetItem(createGeneratedAudioDescriptor(
          accompanimentName,
          accompanimentHandle,
          accompaniment.size,
          accompaniment.duration,
          'audioSplit',
          '伴奏',
        ));
        const derivedResult = createLocalEditResultNode('audioSplit', outputHandle, output, outputAssetId, persistedConfig, outputName, audioMixConfig);
        const exportToWorkflow = Boolean(recordFrom(nextConfig).exportToWorkflow ?? true);
        const audioNode = exportToWorkflow
          ? createAudioResultNode(audioHandle, audio, audioAssetId, audioName, '完整音轨')
          : null;
        const vocalNode = exportToWorkflow
          ? createAudioResultNode(vocalHandle, vocal, vocalAssetId, vocalName, '纯人声')
          : null;
        const accompanimentNode = exportToWorkflow
          ? createAudioResultNode(accompanimentHandle, accompaniment, accompanimentAssetId, accompanimentName, '伴奏')
          : null;
        const workflowGraph = buildSourceToolCompletionWorkflowGraph(tool, persistedConfig, {
          derivedNodeId: derivedResult.nodeId,
          derivedNodeType: 'video',
          derivedNodeLabel: derivedResult.label,
          derivedSourceUrl: outputHandle,
          mimeType: output.mimeType || 'video/webm',
          data: {
            outputAssetId,
            audioAssetId,
            vocalAssetId,
            accompanimentAssetId,
            audioNodeId: audioNode?.nodeId || '',
            vocalNodeId: vocalNode?.nodeId || '',
            accompanimentNodeId: accompanimentNode?.nodeId || '',
          },
        });
        finalizeVideoToolState(tool, persistedConfig, {
          status: 'completed',
          params: {
            workflowGraph,
            workflowTemplateVersion: workflowGraph.templateVersion,
            localVideoEditTool: 'audioSplit',
            localVideoEditAt: Date.now(),
            localVideoDerivedNodeId: derivedResult.nodeId,
            localVideoDerivedTool: 'audioSplit',
            localVideoDerivedLabel: derivedResult.label,
            localVideoDerivedAssetId: outputAssetId,
            localVideoDerivedSourceUrl: outputHandle,
            localVideoOverwriteApplied: false,
            localVideoPreviousSourceUrl: '',
            localVideoPreviousVideoMeta: undefined,
            localAudioAssetId: audioAssetId,
            localAudioSourceUrl: audioHandle,
            localAudioDerivedNodeId: audioNode?.nodeId || '',
            localAudioDerivedLabel: audioNode?.label || '',
            localAudioVocalAssetId: vocalAssetId,
            localAudioVocalSourceUrl: vocalHandle,
            localAudioVocalNodeId: vocalNode?.nodeId || '',
            localAudioVocalLabel: vocalNode?.label || '',
            localAudioAccompanimentAssetId: accompanimentAssetId,
            localAudioAccompanimentSourceUrl: accompanimentHandle,
            localAudioAccompanimentNodeId: accompanimentNode?.nodeId || '',
            localAudioAccompanimentLabel: accompanimentNode?.label || '',
            localVideoProcessingEngine: result.data.processingEngine || '',
          },
        });
      } else {
        finalizeVideoToolState(tool, nextConfig, {
          status: 'error',
          error: result.error || '本地音频分离失败。',
          errorCategory: 'local-audioSplit',
          errorStage: 'local-audioSplit',
        });
      }

      completeDockedDraftEdit(tool, tool);
      return;
    }

    const result = tool === 'hd'
      ? await enhanceVideoLocally(videoUrl || effectiveRenderVideoUrl, requestConfig, (progress) => {
        setVideoToolGeneratingState(tool, nextConfig, {
          progress: progress.percent,
          message: progress.stage,
          stage: `local-${tool}`,
        });
      })
      : await removeSubtitleLocally(videoUrl || effectiveRenderVideoUrl, requestConfig, (progress) => {
        setVideoToolGeneratingState(tool, nextConfig, {
          progress: progress.percent,
          message: progress.stage,
          stage: `local-${tool}`,
        });
      });

    if (result.success && result.data) {
      const output = result.data;
      const outputHandle = output.blob ? registerLocalMedia(output.blob) : output.url;
      console.debug('[VideoNode] local tool result received', JSON.stringify({
        id,
        tool,
        outputHandle,
        width: output.width,
        height: output.height,
        duration: output.duration,
      }));
      if (!outputHandle) {
        finalizeVideoToolState(tool, nextConfig, {
          status: 'error',
          error: `${TOOL_LABELS[tool]}成功，但结果地址为空。`,
          errorCategory: `local-${tool}-materialize`,
          errorStage: `local-${tool}`,
        });
        completeDockedDraftEdit(tool, tool);
        return;
      }
      const outputName = `${tool}-${Date.now()}.${output.format === 'webm' ? 'webm' : 'mp4'}`;
      const persistedConfig = {
        ...nextConfig,
        appliedToAsset: true,
      };
      console.debug('[VideoNode] local tool asset insert start', JSON.stringify({ id, tool, outputName }));
      const outputAssetId = addAssetItem(createGeneratedVideoDescriptor(
        outputName,
        outputHandle,
        output.size,
        output.width,
        output.height,
        output.duration,
        tool,
      ));
      console.debug('[VideoNode] local tool asset insert done', JSON.stringify({ id, tool, outputAssetId }));
      const derivedResult = createLocalEditResultNode(tool, outputHandle, output, outputAssetId, persistedConfig, outputName, audioMixConfig);
      const canvasAfterDerived = useCanvasStore.getState().canvas;
      const derivedNodeAfterCreate = canvasAfterDerived?.nodes.find((item) => item.id === derivedResult.nodeId);
      console.debug('[VideoNode] local tool derived node created', JSON.stringify({
        id,
        tool,
        derivedResult,
        nodeCount: canvasAfterDerived?.nodes.length || 0,
        derivedNodeExists: Boolean(derivedNodeAfterCreate),
        derivedNodeVideoUrl: String(derivedNodeAfterCreate?.data?.videoUrl || ''),
      }));
      const workflowGraph = buildSourceToolCompletionWorkflowGraph(tool, persistedConfig, {
        derivedNodeId: derivedResult.nodeId,
        derivedNodeType: 'video',
        derivedNodeLabel: derivedResult.label,
        derivedSourceUrl: outputHandle,
        mimeType: output.mimeType || 'video/webm',
        data: {
          outputAssetId,
          processingEngine: output.processingEngine || '',
        },
      });
      finalizeVideoToolState(tool, persistedConfig, {
        status: 'completed',
        params: {
          workflowGraph,
          workflowTemplateVersion: workflowGraph.templateVersion,
          localVideoEditTool: tool,
          localVideoEditAt: Date.now(),
          localVideoDerivedNodeId: derivedResult.nodeId,
          localVideoDerivedTool: tool,
          localVideoDerivedLabel: derivedResult.label,
          localVideoDerivedAssetId: outputAssetId,
          localVideoDerivedSourceUrl: outputHandle,
          localVideoOverwriteApplied: false,
          localVideoPreviousSourceUrl: '',
          localVideoPreviousVideoMeta: undefined,
          localVideoProcessingEngine: output.processingEngine || '',
        },
      });
      const sourceAfterFinalize = useCanvasStore.getState().canvas?.nodes.find((item) => item.id === id);
      console.debug('[VideoNode] local tool source finalized', JSON.stringify({
        id,
        tool,
        derivedNodeId: derivedResult.nodeId,
        sourceDerivedNodeId: String(sourceAfterFinalize?.data?.params?.localVideoDerivedNodeId || ''),
        sourceStatus: String(sourceAfterFinalize?.data?.status || ''),
      }));
    } else {
      finalizeVideoToolState(tool, nextConfig, {
        status: 'error',
        error: result.error || `${TOOL_LABELS[tool]}失败。`,
      });
    }

      completeDockedDraftEdit(tool, tool);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[VideoNode] applyDockedToolEditing failed', { id, tool, message, error });
      finalizeVideoToolState(tool, nextConfig, {
        status: 'error',
        error: message || `${TOOL_LABELS[tool]}失败。`,
        errorCategory: `local-${tool}-exception`,
        errorStage: `local-${tool}`,
      });
      completeDockedDraftEdit(tool, tool);
    }
  }

  function selectTool(tool: VideoTool) {
    markVideoPanelInteraction();
    if (tool === 'crop') {
      beginCropEditing();
      return;
    }
    if (tool === 'clip') {
      beginClipEditing();
      return;
    }
    clearFloatingDrafts();
    clearDockedDrafts();
    beginDockedDraftEdit(tool);
  }

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const hostname = String(window.location.hostname || '').trim().toLowerCase();
    const allowLocalDebugBridge = import.meta.env.DEV || hostname === '127.0.0.1' || hostname === 'localhost';
    if (!allowLocalDebugBridge) return;
    const currentDebugState = readDebugBridge() as Record<string, unknown> & {
      videoNodeActions?: Record<string, {
        selectTool: (tool: VideoTool) => void;
        applyDockedToolEditing: (tool: Extract<VideoTool, 'hd' | 'parse' | 'removeSubtitle' | 'audioSplit'>) => Promise<void>;
      }>;
    };
    const nextVideoNodeActions = { ...(currentDebugState.videoNodeActions || {}) };
    nextVideoNodeActions[id] = {
      selectTool,
      applyDockedToolEditing,
    };
    patchDebugBridge({
      videoNodeActions: nextVideoNodeActions,
    });
    return () => {
      const latestDebugState = readDebugBridge() as Record<string, unknown> & {
        videoNodeActions?: Record<string, {
          selectTool: (tool: VideoTool) => void;
          applyDockedToolEditing: (tool: Extract<VideoTool, 'hd' | 'parse' | 'removeSubtitle' | 'audioSplit'>) => Promise<void>;
        }>;
      };
      if (!latestDebugState?.videoNodeActions) return;
      const remainingVideoNodeActions = { ...latestDebugState.videoNodeActions };
      delete remainingVideoNodeActions[id];
      patchDebugBridge({
        videoNodeActions: remainingVideoNodeActions,
      });
    };
  }, [applyDockedToolEditing, id, selectTool]);

  function changeToolConfig(patch: Record<string, unknown>) {
    markVideoPanelInteraction();
    const requestedTool = typeof patch.tool === 'string' && patch.tool in VIDEO_TOOL_OPERATIONS ? patch.tool as VideoTool : activeVideoTool || 'clip';
    if (requestedTool === 'crop') {
      updateFloatingDraft('crop', patch);
      setToolPanelOpen(false);
      return;
    }
    if (requestedTool === 'clip') {
      updateFloatingDraft('clip', patch);
      setToolPanelOpen(false);
      return;
    }
    clearFloatingDrafts();
    updateDockedDraft(requestedTool as Extract<VideoTool, 'hd' | 'parse' | 'removeSubtitle' | 'audioSplit'>, patch);
  }

  function updateReferenceSetting(key: string, patch: Record<string, unknown>) {
    updateNodeData(id, {
      params: {
        ...currentParams,
        referenceSettings: {
          ...referenceSettings,
          [key]: {
            ...(referenceSettings[key] || {}),
            ...patch,
          },
        },
      },
    });
  }

  function getNextManualHandleId(prefix: 'video-image-reference' | 'video-video-reference') {
    const occupied = referenceInputs
      .map((item) => String(item.handleId || ''))
      .filter((handleId) => handleId === prefix || handleId.startsWith(`${prefix}-`))
      .map((handleId) => {
        if (handleId === prefix) return 0;
        const suffix = Number.parseInt(handleId.replace(`${prefix}-`, ''), 10);
        return Number.isFinite(suffix) ? suffix : 0;
      });
    const nextIndex = occupied.length > 0 ? Math.max(...occupied) + 1 : 0;
    return `${prefix}-${nextIndex}`;
  }

  function bindReferenceCandidate(sectionKey: string, candidate: ReferenceBindingCandidate) {
    const existingInputs = Array.isArray(data?.inputs)
      ? data.inputs.filter((item) => item && typeof item === 'object')
      : [];
    const isPrimary = sectionKey === 'primary';
    const isImageReference = sectionKey === 'image-reference';
    const handleId = isPrimary
      ? 'video-main'
      : isImageReference
        ? getNextManualHandleId('video-image-reference')
        : getNextManualHandleId('video-video-reference');
    const channel = isPrimary ? 'primary' : isImageReference ? 'image-reference' : 'video-reference';
    const nextInput = {
      id: `${candidate.sourceNodeId}:${handleId}:${candidate.type}`,
      type: candidate.type,
      url: candidate.url,
      metadata: candidate.metadata,
      label: candidate.sourceNodeLabel,
      role: isPrimary ? 'primary' : isImageReference ? 'subject' : 'motion',
      weight: isPrimary ? 100 : 85,
      enabled: true,
      sourceNodeId: candidate.sourceNodeId,
      sourceNodeType: candidate.sourceNodeType,
      handleId,
      channel,
    };
    const preservedInputs = existingInputs.filter((item) => {
      if (isPrimary) {
        return String(item.channel || '') !== 'primary' && String(item.handleId || '') !== 'video-main';
      }
      return !(
        String(item.sourceNodeId || '') === candidate.sourceNodeId
        && String(item.channel || '') === channel
        && String(item.type || '') === candidate.type
      );
    });

    updateNodeData(id, {
      inputs: [...preservedInputs, nextInput],
      params: {
        ...currentParams,
        sourceUrl: isPrimary ? candidate.url : currentParams.sourceUrl,
        sourceMediaType: isPrimary ? candidate.type : currentParams.sourceMediaType,
        referenceImageUrl: isImageReference ? candidate.url : currentParams.referenceImageUrl,
      },
    });
    const duplicateEdges = (canvas?.edges || []).filter((edge) => {
      if (edge.target !== id) return false;
      const targetHandle = String(edge.targetHandle || '');
      if (isPrimary) return targetHandle === 'video-main';
      if (isImageReference) {
        return edge.source === candidate.sourceNodeId
          && (targetHandle === 'video-image-reference' || targetHandle.startsWith('video-image-reference-'));
      }
      return edge.source === candidate.sourceNodeId
        && (targetHandle === 'video-video-reference' || targetHandle.startsWith('video-video-reference-'));
    });
    duplicateEdges.forEach((edge) => removeEdge(edge.id));
    addEdge(candidate.sourceNodeId, id, {
      sourceHandle: 'media-output',
      targetHandle: handleId,
    });
  }

  function removeBoundReferenceInput(inputKey: string) {
    const existingInputs = Array.isArray(data?.inputs)
      ? data.inputs.filter((item) => item && typeof item === 'object')
      : [];
    const nextInputs = existingInputs.filter((item) => {
      const sourceNodeId = String(item?.sourceNodeId || '').trim();
      const handleId = String(item?.handleId || '').trim();
      const mediaType = String(item?.type || '').trim();
      const manualKey = `manual:${sourceNodeId}:${handleId || 'default'}:${mediaType}`;
      return manualKey !== inputKey;
    });
    updateNodeData(id, { inputs: nextInputs });
    const parts = String(inputKey || '').split(':');
    const sourceNodeId = String(parts[1] || '').trim();
    const handleId = String(parts[2] || '').trim();
    if (sourceNodeId && handleId) {
      (canvas?.edges || [])
        .filter((edge) => edge.target === id && edge.source === sourceNodeId && String(edge.targetHandle || '') === handleId)
        .forEach((edge) => removeEdge(edge.id));
    }
  }

  const referenceBindingSections = useMemo<ReferenceBindingSection[]>(
    () => [
      {
        key: 'primary',
        label: '绑定主素材',
        description: '从画布中选择图片或视频节点，作为视频生成或视频改写的主素材输入。',
        emptyText: '当前画布里暂无可用主素材节点。',
        applyLabel: '设为主素材',
        candidates: bindingCandidates.filter((item) => item.type === 'image' || item.type === 'video'),
      },
      {
        key: 'image-reference',
        label: '绑定图像参考',
        description: '绑定图片参考，用于主体、风格、构图或光影控制。',
        emptyText: '当前画布里暂无可用图片参考节点。',
        applyLabel: '添加图像参考',
        candidates: bindingCandidates.filter((item) => item.type === 'image'),
      },
      {
        key: 'video-reference',
        label: '绑定视频参考',
        description: '绑定视频参考，用于运镜、动作、节奏和镜头语言控制。',
        emptyText: '当前画布里暂无可用视频参考节点。',
        applyLabel: '添加视频参考',
        candidates: bindingCandidates.filter((item) => item.type === 'video'),
      },
    ],
    [bindingCandidates],
  );

  function beginPromptComposition() {
    promptCompositionRef.current = true;
  }

  function endPromptComposition(value: string) {
    promptCompositionRef.current = false;
    writePrompt(value);
  }

  async function handlePromptAssist(action: PromptAssistAction) {
    // 撤销：再次点击同一按钮时，切回原提示词
    if (assistBaseline && assistBaseline.action === action) {
      setPrompt(assistBaseline.text);
      setAssistBaseline(null);
      return;
    }
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt || promptAssistAction) return;
    markVideoPanelInteraction();
    setPromptAssistAction(action);
    setPromptAssistError(null);
    const baseline = normalizedPrompt; // 替换前的原文（可能是更早的优化/翻译结果）
    try {
      const nextPrompt = await assistPrompt({
        prompt: normalizedPrompt,
        action,
        target: 'video',
        provider: promptAssistProvider,
        apiKey: findProviderKeyState(apiKeys, promptAssistProvider)?.apiKey,
      });
      if (!nextPrompt) return;
      // 直接替换原提示词（非追加新版本），并记录原文以便撤销
      setAssistBaseline({ action, text: baseline });
      setPrompt(nextPrompt);
    } catch (error) {
      setPromptAssistError(error instanceof Error ? error.message : '提示词辅助失败，请稍后重试。');
    } finally {
      setPromptAssistAction(null);
    }
  }

  async function applyRemoteGeneratedAudioPostMix(
    generationResult: Partial<NodeData>,
    audioMixConfig: LocalVideoAudioMixConfig,
    baseParams: Record<string, unknown>,
  ) {
    const resultParams = generationResult.params && typeof generationResult.params === 'object'
      ? generationResult.params as Record<string, unknown>
      : {};
    const resultOutputs = Array.isArray(generationResult.outputs) ? generationResult.outputs : [];
    const primaryVideoOutput = resultOutputs.find((item) => item?.type === 'video' && typeof item.url === 'string' && item.url) || null;
    const sourceUrl = typeof generationResult.videoUrl === 'string' && generationResult.videoUrl
      ? generationResult.videoUrl
      : primaryVideoOutput?.url || '';

    if (!sourceUrl || !audioMixConfig.linkedAudioSourceUrl) {
      return generationResult;
    }

    const mixResult = await mixVideoAudioLocally(sourceUrl, audioMixConfig, (progress) => {
      updateNodeData(id, {
        status: 'generating',
        params: {
          ...baseParams,
          ...resultParams,
          generationProgress: [{
            progress: progress.percent,
            message: progress.stage,
            stage: 'local-audioMix-after-generate',
          }],
        },
      });
    });

    if (!mixResult.success || !mixResult.data) {
      return {
        ...generationResult,
        params: {
          ...resultParams,
          remoteVideoPostMixAttempted: true,
          remoteVideoPostMixApplied: false,
          remoteVideoPostMixError: mixResult.error || '远程视频生成后的本地音频后混失败。',
          remoteVideoPostMixAt: Date.now(),
        },
      } satisfies Partial<NodeData>;
    }

    const output = mixResult.data;
    const outputHandle = output.blob ? registerLocalMedia(output.blob) : output.url;
    if (!outputHandle) {
      return {
        ...generationResult,
        params: {
          ...resultParams,
          remoteVideoPostMixAttempted: true,
          remoteVideoPostMixApplied: false,
          remoteVideoPostMixError: '远程视频后混成功，但结果地址为空。',
          remoteVideoPostMixAt: Date.now(),
        },
      } satisfies Partial<NodeData>;
    }
    const outputName = `remote-postmix-${Date.now()}.${output.format === 'webm' ? 'webm' : 'mp4'}`;
    const outputAssetId = addAssetItem(createGeneratedVideoDescriptor(
      outputName,
      outputHandle,
      output.size,
      output.width,
      output.height,
      output.duration,
      'audioMix',
    ));

    const fallbackOutput: MediaOutput = {
      id: `video-${Date.now()}`,
      type: 'video',
      url: sourceUrl,
      prompt: generationResult.prompt || prompt,
      metadata: {},
    };
    const nextOutputs: MediaOutput[] = (resultOutputs.length > 0 ? resultOutputs : [fallbackOutput]).map((item, index) => {
      if (index !== 0 || item.type !== 'video') return item;
      const previousMetadata = item.metadata && typeof item.metadata === 'object'
        ? item.metadata as Record<string, unknown>
        : {};
      const remoteOriginalUrl = typeof previousMetadata.originalUrl === 'string' && previousMetadata.originalUrl
        ? previousMetadata.originalUrl
        : sourceUrl;
      return {
        ...item,
        url: outputHandle,
        metadata: {
          ...previousMetadata,
          originalUrl: remoteOriginalUrl,
          proxyUrl: undefined,
          managedUrl: true,
          localTool: 'audioMix',
          localAudioPostMix: true,
          linkedAudioAppliedLabel: audioMixConfig.linkedAudioLabel || '',
          linkedAudioAppliedMode: audioMixConfig.linkedAudioMode || '',
          linkedAudioAppliedBackend: audioMixConfig.linkedAudioBackend || '',
          linkedAudioAppliedMixMode: audioMixConfig.audioMixMode || '',
          linkedAudioAppliedGain: audioMixConfig.audioGain,
          linkedVideoAppliedGain: audioMixConfig.videoGain,
          processingEngine: output.processingEngine || '',
          size: output.size,
          width: output.width,
          height: output.height,
          duration: output.duration,
          sourceAssetId: outputAssetId,
          remoteGeneratedUrl: sourceUrl,
        },
      };
    });

    return {
      ...generationResult,
      videoUrl: outputHandle,
      outputs: nextOutputs,
      params: {
        ...resultParams,
        sourceUrl: outputHandle,
        sourceMediaType: 'video',
        sourceAssetId: outputAssetId,
        linkedAudioApplied: true,
        linkedAudioAppliedLabel: audioMixConfig.linkedAudioLabel || '',
        linkedAudioAppliedMode: audioMixConfig.linkedAudioMode || '',
        linkedAudioAppliedBackend: audioMixConfig.linkedAudioBackend || '',
        linkedAudioAppliedMixMode: audioMixConfig.audioMixMode || '',
        linkedAudioAppliedGain: audioMixConfig.audioGain,
        linkedVideoAppliedGain: audioMixConfig.videoGain,
        linkedAudioAppliedAt: Date.now(),
        remoteVideoPostMixAttempted: true,
        remoteVideoPostMixApplied: true,
        remoteVideoPostMixError: '',
        remoteVideoPostMixAssetId: outputAssetId,
        remoteVideoPostMixSourceUrl: outputHandle,
        remoteVideoPostMixEngine: output.processingEngine || '',
        remoteVideoPostMixAt: Date.now(),
        generationProgress: [],
      },
    } satisfies Partial<NodeData>;
  }

  async function submitPrompt() {
    const userPrompt = prompt.trim();
    const contractPromptText = regionContractPrompt.trim();
    const trimmed = userPrompt || contractPromptText;
    const executionPrompt = contractMode && contractPromptText
      ? [userPrompt, contractPromptText].filter(Boolean).join('\n\n')
      : trimmed;
    if (!trimmed || !executionPrompt || data?.status === 'generating') return;

    const nextInputs = [...primaryInputs, ...referenceInputs].map((item) => ({
      id: item.id,
      type: item.type,
      url: item.url,
      label: item.label,
      role: item.role,
      weight: item.weight,
      enabled: item.enabled,
      sourceNodeId: item.sourceNodeId,
      sourceNodeType: item.sourceNodeType,
      handleId: item.handleId,
      channel: item.channel,
    }));
    const activePrimary = primaryInputs.find((item) => item.enabled !== false);
    const activeReferences = referenceInputs.filter((item) => item.enabled !== false);
    const needsVideoStyleTransfer = activePrimary?.type === 'video' && activeReferences.some((item) => item.type === 'image');
    const inferredGenerationMode = currentGenerationMode === 'textToVideo' && activePrimary
      ? activePrimary.type === 'video'
        ? 'referenceVideo'
        : 'imageToVideo'
      : currentGenerationMode;
    const linkedAudioMixConfig = deriveLinkedAudioMixConfig(currentParams);
    const nextIdentityController = readIdentityControllerConfig(currentParams.identityController, activeReferences);
    const latestNode = useCanvasStore.getState().getNodeById(id);
    const latestNodeData = latestNode?.data as NodeData | undefined;
    const latestNodeParams = latestNodeData?.params && typeof latestNodeData.params === 'object'
      ? latestNodeData.params as Record<string, unknown>
      : currentParams;
    const latestSelectedModelId = String(latestNodeData?.model || data?.model || selectedModel.id || '').trim();
    const latestSelectedModel = [...modelsWithSupport, ...FALLBACK_MODELS]
      .find((item, index, items) => (
        items.findIndex((candidate) => candidate.id === item.id) === index
        && videoModelMatchesIdentifier(item, latestSelectedModelId)
      )) || selectedModel;
    const routingRequirements = [
      ...buildVideoModelCapabilityRequirements({
        generationMode: inferredGenerationMode,
        primaryInputs: activePrimary ? [activePrimary] : [],
        referenceInputs: activeReferences,
        identityController: nextIdentityController,
      }),
      ...regionCapabilityRequirements,
    ];
    const workflowGraph = buildNodeWorkflowGraph({
      nodeId: id,
      nodeType: 'video',
      executionMode: activeTool === 'parse' ? 'analysis' : activeTool ? 'editing' : 'generation',
      generationMode: inferredGenerationMode,
      provider: latestSelectedModel.provider,
      model: latestSelectedModelId || latestSelectedModel.id,
      prompt: executionPrompt,
      sourceMediaType: activePrimary?.type || String(latestNodeParams.sourceMediaType || currentParams.sourceMediaType || ''),
      toolOperation: typeof latestNodeParams.videoToolOperation === 'string' ? latestNodeParams.videoToolOperation : undefined,
      primaryInputs,
      referenceInputs,
      identityController: nextIdentityController,
    });
    const nextParamsBase: Record<string, unknown> = {
      ...currentParams,
      nodeId: id,
      sourceUrl: activePrimary?.url || currentParams.sourceUrl,
      sourceMediaType: activePrimary?.type || currentParams.sourceMediaType,
      referenceImageUrl: activeReferences.find((item) => item.type === 'image')?.url || currentParams.referenceImageUrl,
      referenceVideoUrl: activeReferences.find((item) => item.type === 'video')?.url || currentParams.referenceVideoUrl,
      generationMode: inferredGenerationMode,
      identityController: nextIdentityController,
      workflowGraph,
      referenceSummary,
      referenceSettings,
      regionContract: activeRegionContract || currentParams.regionContract,
      contractMode,
      contractSummary: regionContractNotice || undefined,
      regionContractSourceNodeId: activeRegionContractEntry?.sourceNodeId,
      ...(linkedAudioMixConfig || {}),
    };
    const allowPinnedExperimentalRoute = Boolean(
      latestNodeParams.modelPinnedByUser
      && latestSelectedModel.activated
      && latestSelectedModel.supportedForCurrentRequest === false
      && typeof latestSelectedModel.unsupportedReason === 'string'
      && latestSelectedModel.unsupportedReason.includes('主视频编辑 / video_urls 协议'),
    );
    const routingSelectedModel = allowPinnedExperimentalRoute
      ? latestSelectedModel
      : resolvePreferredConditionedVideoModel(
          models,
          latestSelectedModel,
          routingRequirements,
          {
            needsVideoStyleTransfer,
            hasSubjectImageReference: activeReferences.some((item) => item.type === 'image' && item.role === 'subject'),
            hasOmniImageReference: activeReferences.some((item) => item.type === 'image' && item.role === 'omni'),
            hasOmniVideoReference: activeReferences.some((item) => item.type === 'video' && item.role === 'omni'),
            hasVideoReference: activeReferences.some((item) => item.type === 'video'),
            hasPrimaryVideo: activePrimary?.type === 'video',
            hasPrimaryImage: activePrimary?.type === 'image',
            referenceRoleCount: new Set(
              activeReferences.flatMap((item) => {
                if (item.role !== 'omni') return [String(item.role || '')];
                return item.type === 'video'
                  ? ['motion', 'rhythm', 'style']
                  : ['subject', 'style', 'composition', 'lighting'];
              }).filter(Boolean),
            ).size,
          },
        );
    if (routingSelectedModel.supportedForCurrentRequest === false && !allowPinnedExperimentalRoute) {
      const blockingMessage = selectedModelCapabilityRecommendation
        ? `${selectedModelCapabilityBoundaryMessage} 推荐改用 ${selectedModelCapabilityRecommendation}。`
        : selectedModelCapabilityBoundaryMessage;
      updateNodeData(id, {
        status: 'error',
        error: blockingMessage,
        inputs: nextInputs,
        params: {
          ...nextParamsBase,
          capabilityBoundaryMessage: selectedModelCapabilityBoundaryMessage,
          capabilityBoundaryStage: 'capability-matrix',
          capabilityBoundaryRecommendedModel: selectedModelCapabilityRecommendation || undefined,
          lastError: blockingMessage,
          lastErrorCategory: 'routing',
          lastErrorStage: 'capability-matrix',
        },
      });
      return;
    }
    if (needsVideoStyleTransfer && !isVideoStyleTransferModel(routingSelectedModel)) {
      updateNodeData(id, {
        status: 'error',
        error: '当前选择的模型能力不匹配：文生/图生视频模型不能严格保留主视频运镜并套用参考图风格。请选择支持 V2V/视频参考的大模型，例如 Kling O3、Wan 2.2 I2V、fal/Replicate 的 V2V 模型，或接入自研 V2V 服务。',
        inputs: nextInputs,
        params: {
          ...nextParamsBase,
          lastError: '模型能力不匹配：请改选 Kling O3、Wan 2.2 I2V、fal/Replicate V2V 等支持视频参考的大模型。',
          lastErrorCategory: 'routing',
          lastErrorStage: 'video-style-transfer-routing',
        },
      });
      return;
    }

    const access = resolveGenerationAccess(
      'video',
      routingSelectedModel.upstreamModel || routingSelectedModel.id,
      routingSelectedModel.provider,
      apiKeys,
      isAuthenticated(),
      Boolean(
        (routingSelectedModel.activated && routingSelectedModel.activationModelMatched !== false)
        || modelMatchesLocalKey(
          {
            id: routingSelectedModel.id,
            name: routingSelectedModel.name,
            provider: routingSelectedModel.provider,
            upstreamModel: routingSelectedModel.upstreamModel,
          },
          findProviderKeyState(apiKeys, routingSelectedModel.provider, 'video'),
          'video',
        )
      ),
      {
        strictProvider: true,
        allowProviderOnlyActivation: false,
      },
    );
    if (!access.ok) {
      if (access.reason === 'auth') {
        window.location.href = '/login';
        return;
      }
      setActivation(access);
      return;
    }
    const latestModelId = String(latestNodeData?.model || data?.model || '').trim();
    const requestModel = resolveProviderCompatibleVideoModel(models, routingSelectedModel, access.provider, inferredGenerationMode);
    const forcePinnedKlingOmniRequest = (
      latestModelId === 'kling-v3-omni'
      && access.provider === 'kling'
      && primaryInputs.some((item) => item.enabled !== false && item.type === 'video')
    );
    const pinnedRequestModelId = shouldPreservePinnedVideoModelIdentifier(
      requestModel,
      latestModelId,
      Boolean(latestNodeParams.modelPinnedByUser),
    )
      || forcePinnedKlingOmniRequest
      ? latestModelId
      : requestModel.id;

    const runId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    submitRunIdRef.current = runId;
    const nextParams: Record<string, unknown> = {
      ...nextParamsBase,
      videoTool: activeTool,
      activeRunId: runId,
      generationProgress: [],
      lastError: undefined,
      lastErrorCategory: undefined,
      lastErrorStage: undefined,
      capabilityBoundaryMessage: allowPinnedExperimentalRoute ? routingSelectedModel.unsupportedReason : undefined,
      capabilityBoundaryStage: allowPinnedExperimentalRoute ? 'pinned-experimental-route' : undefined,
    };

    updateNodeData(id, {
      prompt: trimmed,
      model: pinnedRequestModelId,
      provider: access.provider,
      status: 'generating',
      error: undefined,
      inputs: nextInputs,
      params: nextParams,
    });

    try {
      let result = await generateNodeOutputWithFallback({
        nodeId: id,
        nodeType: 'video',
        prompt: executionPrompt,
        provider: access.provider,
        apiKey: access.apiKey || '',
        baseUrl: access.endpoint,
        model: pinnedRequestModelId || requestModel.upstreamModel || requestModel.id,
        persistedModel: pinnedRequestModelId || requestModel.id,
        onRequestBody: async (requestBody) => {
          const latestNode = useCanvasStore.getState().getNodeById(id);
          const latestRunId = latestNode?.data?.params && typeof latestNode.data.params === 'object'
            ? (latestNode.data.params as Record<string, unknown>).activeRunId
            : undefined;
          if (latestRunId !== runId || submitRunIdRef.current !== runId) return;
          const latestParams = latestNode?.data?.params && typeof latestNode.data.params === 'object'
            ? latestNode.data.params as Record<string, unknown>
            : nextParams;
          updateNodeData(id, {
            params: {
              ...latestParams,
              requestBody,
            },
          });
        },
        data: {
          ...(data as unknown as NodeData),
          prompt: executionPrompt,
          model: pinnedRequestModelId,
          provider: access.provider,
          status: 'generating',
          inputs: nextInputs,
          params: nextParams,
        },
      });
      if (linkedAudioMixConfig?.linkedAudioSourceUrl) {
        result = await applyRemoteGeneratedAudioPostMix(result, linkedAudioMixConfig, nextParams);
      }
      const latestNode = useCanvasStore.getState().getNodeById(id);
      const latestRunId = latestNode?.data?.params && typeof latestNode.data.params === 'object'
        ? (latestNode.data.params as Record<string, unknown>).activeRunId
        : undefined;
      if (latestRunId !== runId || submitRunIdRef.current !== runId) return;
      const resultParams = result.params && typeof result.params === 'object' ? result.params as Record<string, unknown> : {};
      updateNodeData(id, {
        ...result,
        inputs: nextInputs,
        params: {
          ...nextParamsBase,
          ...resultParams,
          userPrompt: trimmed,
          executionPrompt,
          referenceSettings,
          referenceSummary,
          generationMode: inferredGenerationMode,
        },
      });
    } catch (error) {
      const latestNode = useCanvasStore.getState().getNodeById(id);
      const latestRunId = latestNode?.data?.params && typeof latestNode.data.params === 'object'
        ? (latestNode.data.params as Record<string, unknown>).activeRunId
        : undefined;
      if (latestRunId !== runId || submitRunIdRef.current !== runId) return;
      const generationError = error instanceof GenerationError ? error : null;
      const message = describeGenerationError(error);
      const latestParams = latestNode?.data?.params && typeof latestNode.data.params === 'object'
        ? latestNode.data.params as Record<string, unknown>
        : nextParams;
      updateNodeData(id, {
        status: 'error',
        error: message,
        provider: generationError?.metadata.provider || latestNode?.data?.provider,
        model: generationError?.metadata.model || latestNode?.data?.model,
        inputs: nextInputs,
        params: {
          ...latestParams,
          generationProgress: generationError?.metadata.workflowProgress || [],
          lastError: message,
          lastErrorCategory: generationError?.metadata.category || 'request',
          lastErrorStage: generationError?.metadata.stage,
          lastRequestId: generationError?.metadata.requestId,
          requestBody: generationError?.metadata.requestBody || latestParams.requestBody,
          routedProvider: generationError?.metadata.provider || latestParams.routedProvider,
          routedModel: generationError?.metadata.model || latestParams.routedModel,
          failedAt: Date.now(),
        },
      });
    }
  }

  useEffect(() => {
    const batchToken = String(currentParams.migrationBatchRegenerateToken || '').trim();
    const handledToken = String(currentParams.migrationBatchRegenerateHandledToken || '').trim();
    if (!batchToken || batchToken === handledToken || batchRegenerateTokenRef.current === batchToken) return;
    batchRegenerateTokenRef.current = batchToken;
    updateNodeData(id, {
      params: {
        ...currentParams,
        migrationBatchRegenerateHandledToken: batchToken,
        migrationBatchRegenerateHandledAt: Date.now(),
      },
    });
    if (!canSubmitPrompt || data?.status === 'generating') return;
    void submitPrompt();
  }, [canSubmitPrompt, currentParams, data?.status, id, updateNodeData]);

  useEffect(() => {
    const panelToken = String(currentParams.migrationOpenPanelToken || '').trim();
    const panelMode = String(currentParams.migrationOpenPanelMode || 'panel').trim();
    if (!isNodeInteractionActive || !panelToken || migrationPanelTokenRef.current === panelToken) return;
    migrationPanelTokenRef.current = panelToken;
    setModelMenuOpen(false);
    setToolPanelOpen(true);
    setAssetMenuOpen(panelMode === 'reupload');
  }, [currentParams.migrationOpenPanelMode, currentParams.migrationOpenPanelToken, isNodeInteractionActive]);

  function downloadVideo() {
    if (!effectiveRenderVideoUrl) return;
    const anchor = document.createElement('a');
    anchor.href = effectiveRenderVideoUrl;
    anchor.download = 'hmdao-video.mp4';
    anchor.rel = 'noopener';
    anchor.click();
  }

  function openVideo() {
    if (!effectiveRenderVideoUrl) return;
    window.open(effectiveRenderVideoUrl, '_blank', 'noopener,noreferrer');
  }

  const nodeTestId = `video-node-${id}`;

  return (
    <div className="relative overflow-visible" data-testid={nodeTestId} data-node-id={id} data-node-type="video">
      <input ref={fileInputRef} type="file" accept="image/*,video/*" className="hidden" onChange={handleUploadFile} />

      {isNodeInteractionActive && data?.status !== 'generating' && !hasVideo ? (
        <div className="absolute -top-[62px] left-1/2 z-30 flex -translate-x-1/2 items-center gap-2">
          <ActionChip title="上传" onClick={openFilePicker} icon={<Upload className="h-4 w-4" />} />
          <ActionChip title="素材" onClick={() => setAssetMenuOpen((open) => !open)} icon={<FolderOpen className="h-4 w-4" />} />
        </div>
      ) : null}

      {isNodeInteractionActive && data?.status !== 'generating' && hasVideo ? (
        <VideoToolbar
          nodeId={id}
          activeTool={activeTool}
          onTool={selectTool}
          onUpload={openFilePicker}
          onToggleAssets={() => setAssetMenuOpen((open) => !open)}
          onDownload={downloadVideo}
          onOpen={openVideo}
        />
      ) : null}

      {isNodeInteractionActive && data?.status !== 'generating' && assetMenuOpen ? (
        <AssetPicker assets={videoAssets} onChoose={chooseAsset} emptyText="素材库暂无视频" panelInteractionProps={videoPanelInteractionProps} onInteract={stopVideoPanelInteraction} />
      ) : null}

      <div
        className={`relative rounded-lg transition-all duration-150 ${
          isNodeSelected ? 'ring-2 ring-[#9a9a9a] shadow-[0_0_0_1px_rgba(255,255,255,0.22)]' : 'ring-1 ring-[#343434]'
        } ${hasVideo ? 'bg-transparent' : 'w-[535px] bg-[#262626]'}`}
        style={hasVideo ? { width: displaySize.width } : undefined}
      >
                <div className="absolute -top-7 left-0 flex items-center gap-2">
          <EditableNodeTitle nodeId={id} icon={Play} label={data?.label} fallback="视频节点" />
          {hasVideo && dimensionText ? <span className="text-[11px] text-[#6f6f6f]">{dimensionText}</span> : null}
          {!hasVideo && data?.status ? <StatusBadge status={String(data.status) as 'idle' | 'generating' | 'completed' | 'error'} /> : null}
        </div>


{data?.status === 'generating' ? (
          <div className="rounded-lg bg-[#262626] px-7 py-9">
            <GeneratingSkeleton lines={5} />
            <div className="px-3">
              <ProgressBadge
                label={compactGenerationStatus}
                progress={Number(latestProgress?.progress)}
              />
            </div>
          </div>
        ) : hasRenderableVideo && !effectiveVideoRenderError ? (
          <div className="relative overflow-hidden rounded-lg bg-[#111] ring-1 ring-[#363636]" style={{ width: displaySize.width, height: displaySize.height }}>
            <div
              data-testid={`video-preview-viewport-${id}`}
              className="absolute overflow-hidden bg-black"
              style={cropPreviewLayout.viewportStyle}
            >
              <video
                ref={videoRef}
                key={`${videoUrl}-${effectiveRenderVideoUrl}-${videoMimeType || 'auto'}`}
                controls={isNodeInteractionActive && !isClipEditing}
                playsInline
                disablePictureInPicture
                preload="auto"
                className="absolute block bg-black [transform:translateZ(0)]"
                style={cropPreviewLayout.videoStyle}
                onLoadedMetadata={() => setVideoRenderError(null)}
                onLoadedData={() => setVideoRenderError(null)}
                onCanPlay={() => setVideoRenderError(null)}
                onError={(event) => {
                  const mediaError = event.currentTarget.error;
                  const code = mediaError?.code ? ` (code ${mediaError.code})` : '';
                  const mimeText = videoMimeType ? ` [${videoMimeType}]` : '';
                  handleVideoRenderFailure(code, mimeText);
                }}
                src={effectiveRenderVideoUrl || undefined}
              />
            </div>
            {restoringVideoUrl && !effectiveRenderVideoUrl ? (
              <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-black/60 text-[12px] text-white">
                正在恢复本地视频预览...
              </div>
            ) : null}
            <button
              type="button"
              onClick={openFilePicker}
              className="nodrag absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-lg bg-black/70 text-white ring-1 ring-white/10 hover:bg-black/85"
              title="替换视频"
            >
              <Upload className="h-3.5 w-3.5" />
            </button>
            <VideoToolPreviewOverlay
              nodeId={id}
              activeTool={activeVideoTool}
              config={effectiveVideoToolConfig}
              selectedDuration={selectedDuration}
              videoMeta={videoMeta}
              cropEditing={isCropEditing}
              subtitleEditing={isRemoveSubtitleManualEditing}
              onCropConfigChange={changeToolConfig}
              onSubtitleConfigChange={changeToolConfig}
              onCropConfirm={confirmCropEditing}
              onCropCancel={cancelCropEditing}
              panelInteractionProps={videoPanelInteractionProps}
              onPanelInteract={stopVideoPanelInteraction}
            />
          </div>
        ) : hasVideo && !hasRenderableVideo && restoringVideoUrl ? (
          <div className="flex h-[320px] items-center justify-center rounded-lg bg-[#111] text-[12px] text-[#d8d8d8] ring-1 ring-[#363636]">
            正在恢复本地视频预览...
          </div>
        ) : hasVideo && effectiveVideoRenderError ? (
          <MediaRenderErrorCard
            title={preflightVideoIssue?.summary || effectiveVideoOutcome?.label}
            message={effectiveVideoRenderError}
            legacyBlob={isTransientBlobUrl(videoUrl)}
            onRetry={openFilePicker}
            onRegenerate={canSubmitPrompt ? () => {
              void submitPrompt();
            } : undefined}
          />
        ) : (
          <EmptyVideoCard />
        )}

        {hasRenderableVideo && isClipEditing ? (
          <ClipEditorPanel
            nodeId={id}
            videoRef={videoRef}
            videoSrc={effectiveRenderVideoUrl}
            config={effectiveVideoToolConfig}
            selectedDuration={selectedDuration}
            onConfigChange={changeToolConfig}
            onConfirm={confirmClipEditing}
            onCancel={cancelClipEditing}
            panelInteractionProps={videoPanelInteractionProps}
            onPanelInteract={stopVideoPanelInteraction}
          />
        ) : null}

        {isNodeSelected && effectiveVideoOutcome ? (
          <div className={`border-t px-4 py-3 text-[12px] ${effectiveVideoOutcome.tone === 'success' ? 'border-emerald-500/20 bg-emerald-500/8 text-emerald-200' : effectiveVideoOutcome.tone === 'warning' ? 'border-amber-500/20 bg-amber-500/10 text-amber-200' : 'border-rose-500/20 bg-rose-500/10 text-rose-200'}`}>
            <div className="font-semibold">{effectiveVideoOutcome.label}</div>
            <div className="mt-1 opacity-90">{effectiveVideoOutcome.reason}</div>
          </div>
        ) : null}

        {contractMode ? (
          <div className="border-t border-sky-500/20 bg-sky-500/8 px-4 py-3 text-[12px] text-sky-100">
            <div className="font-semibold">打标签执行模式</div>
            <div className="mt-1">{regionContractNotice || '已接入打标签节点，当前节点将按上游标签协议执行。'}</div>
            {activeRegionContractEntry ? (
              <div className="mt-2 text-sky-200/90">合同来源：{activeRegionContractEntry.sourceNodeLabel}</div>
            ) : null}
          </div>
        ) : null}

        {data?.status === 'error' ? (
          <div className="px-4 pb-4">
            <ErrorDetailBlock category={lastErrorCategory} message={data?.error || currentParams.lastError} />
          </div>
        ) : null}

        <Handle
          type="target"
          id="video-contract"
          data-testid={`video-handle-contract-${id}`}
          title="打标签：连接 Tagging Node，按标签协议执行分区替换、背景融合与视频轨迹编辑。"
          aria-label="打标签端口：连接 Tagging Node，按标签协议执行分区替换、背景融合与视频轨迹编辑。"
          position={Position.Left}
          className="image-node-handle"
          style={{ ...handleLeft, top: hasVideo ? '20%' : '24%' }}
        >
          <span className="text-[10px] font-bold leading-none text-[#8a8a8a]">合</span>
        </Handle>
        <Handle
          type="target"
          id="video-main"
          data-testid={`video-handle-main-${id}`}
          title="主素材：连接参考视频或参考图，作为视频生成、改写、保持构图或保持运镜的基础输入。"
          aria-label="主素材端口：连接参考视频或参考图，作为视频生成、改写、保持构图或保持运镜的基础输入。"
          position={Position.Left}
          className="image-node-handle"
          style={{ ...handleLeft, top: hasVideo ? '34%' : '38%' }}
        >
          <span className="text-[10px] font-bold leading-none text-[#8a8a8a]">主</span>
        </Handle>
        <div
          className="pointer-events-none absolute -left-[106px] z-10 rounded-full bg-[#1d2330] px-2 py-0.5 text-[10px] font-semibold text-[#c7d6ff]"
          style={{ top: `calc(${hasVideo ? 20 : 24}% - 10px)` }}
        >
          打标签
        </div>
        {videoImageReferenceHandleIds.map((handleId, index) => (
          <Handle
            key={handleId}
            type="target"
            id={handleId}
            data-testid={`video-handle-image-reference-${id}-${index}`}
            title={`图像参考 ${index + 1}：连接参考图，用于角色、风格、主体、构图或光影参考。`}
            aria-label={`图像参考端口 ${index + 1}：连接参考图，用于角色、风格、主体、构图或光影参考。`}
            position={Position.Left}
            className="image-node-handle"
            style={{ ...handleLeft, top: `${hasVideo ? 52 + index * 10 : 56 + index * 10}%` }}
          >
            <span className="text-[10px] font-bold leading-none text-[#8a8a8a]">图</span>
          </Handle>
        ))}
        {videoVideoReferenceHandleIds.map((handleId, index) => (
          <Handle
            key={handleId}
            type="target"
            id={handleId}
            data-testid={`video-handle-video-reference-${id}-${index}`}
            title={`视频参考 ${index + 1}：连接参考视频，用于运镜、动作、节奏、时长或镜头语言参考。`}
            aria-label={`视频参考端口 ${index + 1}：连接参考视频，用于运镜、动作、节奏、时长或镜头语言参考。`}
            position={Position.Left}
            className="image-node-handle"
            style={{ ...handleLeft, top: `${hasVideo ? 70 + index * 10 : 74 + index * 10}%` }}
          >
            <span className="text-[10px] font-bold leading-none text-[#8a8a8a]">视</span>
          </Handle>
        ))}
        <Handle id="media-output" type="source" position={Position.Right} className="image-node-handle" style={handleRight}>
          <span className="text-xs font-bold leading-none text-[#8a8a8a]">+</span>
        </Handle>
      </div>

      {isNodeInteractionActive && data?.status !== 'generating' && activeVideoTool && toolPanelOpen && activeVideoTool !== 'crop' && activeVideoTool !== 'clip' ? (
        <VideoToolFloatingPanel
          nodeId={id}
          activeTool={activeVideoTool}
          config={effectiveVideoToolConfig}
          selectedDuration={selectedDuration}
          viewportScale={toolViewportScale}
          onToolConfigChange={changeToolConfig}
          onClose={cancelDockedToolEditing}
          onApply={() => {
            void applyDockedToolEditing(activeVideoTool);
          }}
          panelInteractionProps={videoPanelInteractionProps}
          onPanelInteract={stopVideoPanelInteraction}
        />
      ) : null}

      {isNodeInteractionActive && data?.status !== 'generating' && !isClipEditing && !(activeVideoTool && toolPanelOpen && activeVideoTool !== 'crop' && activeVideoTool !== 'clip') ? (
        <PromptPanel
          nodeId={id}
          prompt={prompt}
          capabilityBoundaryRecommendedModel={selectedModelCapabilityRecommendation}
          regionContractNotice={regionContractNotice}
          canSubmit={canSubmitPrompt}
          selectedModel={selectedModel}
          models={modelsWithSupport}
          modelMenuOpen={modelMenuOpen}
          ratioText={ratioText}
          durationText={durationText}
          selectedCount={selectedCount}
          estimatedCost={estimatedCost}
          estimatedSeconds={estimatedSeconds}
          identityController={identityController}
          linkedAudioLabel={String(currentParams.linkedAudioLabel || '')}
          linkedAudioMode={String(currentParams.linkedAudioMode || '')}
          promptAssistAction={promptAssistAction}
          promptAssistError={promptAssistError}
          assistBaselineAction={assistBaseline?.action ?? null}
          activeTool={activeVideoTool}
          advancedOpen={advancedPanelOpen}
          referencePanelOpen={referencePanelOpen}
          primaryInputs={primaryInputs}
          referenceInputs={referenceInputs}
          referenceBindingSections={referenceBindingSections}
          modeConfig={currentParams}
          videoToolConfig={effectiveVideoToolConfig}
          selectedAspectRatio={selectedAspectRatio}
          selectedQuality={selectedQuality}
          selectedDuration={selectedDuration}
          selectedMotionPreset={selectedMotionPreset}
          selectedGenerationMode={selectedGenerationMode}
          onPromptChange={(value: string) => {
            writePrompt(value);
            // 用户手动编辑后，撤销基线失效，避免撤销跳回旧内容
            setAssistBaseline(null);
          }}
          onPromptCompositionStart={beginPromptComposition}
          onPromptCompositionEnd={endPromptComposition}
          onToggleModelMenu={() => setModelMenuOpen((open) => !open)}
          onChooseModel={chooseModel}
          onUpload={openFilePicker}
          onModeUpload={(target) => openFilePicker(undefined, target)}
          onToggleAssetMenu={() => setAssetMenuOpen((open) => !open)}
          onToggleAdvancedPanel={() => setAdvancedPanelOpen((open) => !open)}
          onCountChange={setOutputCount}
          onToolSelect={selectTool}
          onPromptAssist={handlePromptAssist}
          onToggleReferencePanel={() => setReferencePanelOpen((open) => !open)}
          onReferenceRoleChange={(key, role) => updateReferenceSetting(key, { role })}
          onReferenceWeightChange={(key, weight) => updateReferenceSetting(key, { weight })}
          onReferenceEnabledChange={(key, enabled) => updateReferenceSetting(key, { enabled })}
          onBindReferenceInput={bindReferenceCandidate}
          onRemoveReferenceInput={removeBoundReferenceInput}
          onParamsChange={updateVideoParams}
          onToolConfigChange={changeToolConfig}
          onSubmit={submitPrompt}
          panelInteractionProps={videoPanelInteractionProps}
          onPanelInteract={stopVideoPanelInteraction}
        />
      ) : null}

      <ModelActivationPrompt
        open={Boolean(activation)}
        mode={activation?.mode || 'video'}
        provider={activation?.provider || selectedModel.provider}
        reason={activation?.reason || 'api-key'}
        onClose={() => setActivation(null)}
      />
    </div>
  );
}

function EmptyVideoCard() {
  return (
    <div className="px-7 py-10">
      <div className="mb-8 flex h-[92px] items-center justify-center">
        <Play className="h-14 w-14 fill-[#626262] text-[#626262]" />
      </div>
      <div className="mb-4 text-xs text-[#8f8f8f]">当前状态</div>
      <div className="space-y-4 text-[13px] font-semibold text-[#ececec]">
        <div className="flex items-center gap-2.5"><Scissors className="h-3.5 w-3.5" />导入视频后可进行剪辑与处理</div>
        <div className="flex items-center gap-2.5"><Sparkles className="h-3.5 w-3.5" />输入提示词后可直接生成视频</div>
      </div>
    </div>
  );
}

function MediaRenderErrorCard({
  title,
  message,
  legacyBlob,
  onRetry,
  onRegenerate,
}: {
  title?: string;
  message: string;
  legacyBlob?: boolean;
  onRetry: () => void;
  onRegenerate?: () => void;
}) {
  return (
    <div className="flex h-[300px] flex-col items-center justify-center gap-3 rounded-lg bg-[#1a1a1a] px-6 text-center">
      <div className="text-sm font-semibold text-[#f3f3f3]">{title || (legacyBlob ? '历史本地素材已失效' : '资源渲染失败')}</div>
      <div className="max-w-[280px] text-xs text-[#9f9f9f]">{message}</div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onRetry}
          className="nodrag rounded-md bg-[#2f2f2f] px-3 py-1.5 text-xs text-[#f0f0f0] hover:bg-[#3a3a3a]"
        >
          重新上传
        </button>
        {onRegenerate ? (
          <button
            type="button"
            onClick={onRegenerate}
            className="nodrag rounded-md bg-[#4d3a1f] px-3 py-1.5 text-xs text-[#ffe8bf] hover:bg-[#5b4628]"
          >
            重新生成
          </button>
        ) : null}
      </div>
    </div>
  );
}

function normalizeClipWindow(start: number, end: number, duration: number) {
  const safeDuration = Math.max(0.2, duration || 0.2);
  const safeStart = clampNumber(start, 0, safeDuration, 0);
  const safeEnd = clampNumber(end, 0.1, safeDuration, safeDuration);
  if (safeEnd <= safeStart + 0.05) {
    return {
      start: Math.max(0, Math.min(safeStart, safeDuration - 0.1)),
      end: Math.min(safeDuration, Math.max(safeStart + 0.1, safeEnd)),
    };
  }
  return { start: safeStart, end: safeEnd };
}

function formatTimelineTime(value: number) {
  const total = Math.max(0, Number.isFinite(value) ? value : 0);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toFixed(2).padStart(5, '0')}`;
}

function uniqueSortedTimes(values: number[]) {
  return [...new Set(values.map((value) => Number(value.toFixed(3))))].sort((left, right) => left - right);
}

function snapTimeToMarkers(time: number, markers: number[], thresholdSeconds: number) {
  let nextTime = time;
  let bestDistance = thresholdSeconds;
  for (const marker of markers) {
    const distance = Math.abs(marker - time);
    if (distance <= bestDistance) {
      bestDistance = distance;
      nextTime = marker;
    }
  }
  return nextTime;
}

function buildFallbackWaveform(barCount: number, duration: number) {
  return Array.from({ length: barCount }, (_, index) => {
    const phase = (index / Math.max(1, barCount - 1)) * Math.PI * 3.2;
    const harmonic = Math.sin(phase) * 0.38 + Math.cos(phase * 1.7) * 0.18;
    const drift = Math.sin((duration + index) * 0.41) * 0.08;
    return Math.max(0.12, Math.min(1, 0.48 + harmonic + drift));
  });
}

function buildWaveformPeaks(channelData: Float32Array, barCount: number) {
  if (!channelData.length || barCount <= 0) {
    return buildFallbackWaveform(Math.max(1, barCount), 0);
  }
  const blockSize = Math.max(1, Math.floor(channelData.length / barCount));
  const peaks = [];
  for (let index = 0; index < barCount; index += 1) {
    const start = index * blockSize;
    const end = Math.min(channelData.length, start + blockSize);
    let peak = 0;
    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      peak = Math.max(peak, Math.abs(channelData[sampleIndex] || 0));
    }
    peaks.push(Math.max(0.08, Math.min(1, peak)));
  }
  return peaks;
}

function relabelClipSegments(segments: ClipSegment[]) {
  return segments.map((segment, index) => ({
    ...segment,
    label: `片段 ${index + 1}`,
  }));
}

function normalizeClipSegment(segment: Partial<ClipSegment>, duration: number, index: number): ClipSegment {
  const normalized = normalizeClipWindow(
    Number(segment.startTime ?? 0),
    Number(segment.endTime ?? duration),
    duration,
  );
  return {
    id: typeof segment.id === 'string' && segment.id ? segment.id : `segment-${index + 1}`,
    startTime: normalized.start,
    endTime: normalized.end,
    label: typeof segment.label === 'string' && segment.label ? segment.label : `片段 ${index + 1}`,
  };
}

function readClipSegments(config: Record<string, unknown>, duration: number) {
  const raw = Array.isArray(config.clipSegments) ? config.clipSegments : [];
  if (raw.length === 0) {
    return [normalizeClipSegment({
      id: 'segment-1',
      startTime: Number(config.startTime ?? 0),
      endTime: Number(config.endTime ?? duration),
      label: '片段 1',
    }, duration, 0)];
  }
  const segments = raw
    .map((item, index) => normalizeClipSegment(item && typeof item === 'object' ? item as Partial<ClipSegment> : {}, duration, index))
    .sort((left, right) => left.startTime - right.startTime);
  return relabelClipSegments(segments);
}

function buildClipConfigPatch(
  config: Record<string, unknown>,
  duration: number,
  segments: ClipSegment[],
  selectedIndex: number,
  extras: Record<string, unknown> = {},
) {
  const normalizedSegments = relabelClipSegments(
    segments
      .map((segment, index) => normalizeClipSegment(segment, duration, index))
      .sort((left, right) => left.startTime - right.startTime),
  );
  const safeIndex = Math.max(0, Math.min(normalizedSegments.length - 1, selectedIndex));
  const activeSegment = normalizedSegments[safeIndex] || normalizedSegments[0];
  return {
    ...config,
    ...extras,
    tool: 'clip',
    clipSegments: normalizedSegments,
    selectedSegmentIndex: safeIndex,
    startTime: activeSegment?.startTime ?? 0,
    endTime: activeSegment?.endTime ?? duration,
  };
}

function ClipEditorPanel({
  nodeId,
  videoRef,
  videoSrc,
  config,
  selectedDuration,
  onConfigChange,
  onConfirm,
  onCancel,
  panelInteractionProps,
  onPanelInteract,
}: {
  nodeId: string;
  videoRef: { current: HTMLVideoElement | null };
  videoSrc: string;
  config: Record<string, unknown>;
  selectedDuration: number;
  onConfigChange: (patch: Record<string, unknown>) => void;
  onConfirm: () => void;
  onCancel: () => void;
  panelInteractionProps: GuardedPanelInteractionProps;
  onPanelInteract: (event: { stopPropagation: () => void }) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [thumbnails, setThumbnails] = useState<Array<{ time: number; src: string | null }>>([]);
  const dragStateRef = useRef<{ pointerId: number; handle: 'start' | 'end' | 'playhead'; } | null>(null);
  const clipSegments = useMemo(() => readClipSegments(config, selectedDuration), [config, selectedDuration]);
  const selectedSegmentIndex = Math.max(0, Math.min(clipSegments.length - 1, Number(config.selectedSegmentIndex ?? 0) || 0));
  const activeSegment = clipSegments[selectedSegmentIndex] || clipSegments[0];
  const clipStart = activeSegment?.startTime ?? 0;
  const clipEnd = activeSegment?.endTime ?? Math.max(0.1, selectedDuration);
  const clipLength = Math.max(0.1, clipEnd - clipStart);
  const startPercent = selectedDuration > 0 ? (clipStart / selectedDuration) * 100 : 0;
  const endPercent = selectedDuration > 0 ? (clipEnd / selectedDuration) * 100 : 100;
  const currentPercent = selectedDuration > 0 ? (currentTime / selectedDuration) * 100 : 0;
  const thumbnailTimes = useMemo(() => {
    const count = Math.min(7, Math.max(5, Math.round(selectedDuration || 5)));
    return Array.from({ length: count }, (_, index) => {
      const ratio = count === 1 ? 0.5 : index / (count - 1);
      return Number((ratio * Math.max(selectedDuration, 0.25)).toFixed(3));
    });
  }, [selectedDuration]);
  const snapEnabled = config.snapToKeyframes !== false;
  const snapMarkers = useMemo(() => {
    const secondMarkers = selectedDuration <= 12
      ? Array.from({ length: Math.max(0, Math.floor(selectedDuration) - 1) }, (_, index) => index + 1)
      : Array.from({ length: Math.max(0, Math.floor(selectedDuration / 2) - 1) }, (_, index) => (index + 1) * 2);
    const segmentMarkers = clipSegments.flatMap((segment) => [segment.startTime, segment.endTime]);
    return uniqueSortedTimes([0, selectedDuration, ...thumbnailTimes, ...segmentMarkers, ...(snapEnabled ? secondMarkers : [])]);
  }, [clipSegments, selectedDuration, snapEnabled, thumbnailTimes]);
  const snapThreshold = useMemo(() => Math.min(0.35, Math.max(0.08, selectedDuration / 40)), [selectedDuration]);

  function snapTime(value: number) {
    const bounded = clampNumber(value, 0, selectedDuration, 0);
    return snapEnabled ? snapTimeToMarkers(bounded, snapMarkers, snapThreshold) : bounded;
  }

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let frame = 0;
    const sync = () => {
      setCurrentTime(video.currentTime || 0);
      if (!video.paused && !video.ended) {
        frame = window.requestAnimationFrame(sync);
      }
    };
    const handlePlay = () => {
      setIsPlaying(true);
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(sync);
    };
    const handlePause = () => {
      setIsPlaying(false);
      window.cancelAnimationFrame(frame);
      setCurrentTime(video.currentTime || 0);
    };
    const handleSeeked = () => setCurrentTime(video.currentTime || 0);
    const handleTimeUpdate = () => {
      const next = video.currentTime || 0;
      if (next >= clipEnd) {
        video.pause();
        video.currentTime = clipStart;
        setCurrentTime(clipStart);
        return;
      }
      setCurrentTime(next);
    };

    setCurrentTime(video.currentTime || clipStart);
    setIsPlaying(!video.paused);
    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('seeked', handleSeeked);
    video.addEventListener('timeupdate', handleTimeUpdate);
    return () => {
      window.cancelAnimationFrame(frame);
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('seeked', handleSeeked);
      video.removeEventListener('timeupdate', handleTimeUpdate);
    };
  }, [clipEnd, clipStart, videoRef]);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const fallback = thumbnailTimes.map((time) => ({ time, src: null as string | null }));
    setThumbnails(fallback);
    if (!videoSrc || selectedDuration <= 0) {
      return () => {
        cancelled = true;
      };
    }

    const previewVideo = document.createElement('video');
    previewVideo.preload = 'auto';
    previewVideo.muted = true;
    previewVideo.playsInline = true;
    previewVideo.crossOrigin = 'anonymous';
    previewVideo.src = videoSrc;

    const waitForEvent = (eventName: 'loadedmetadata' | 'seeked' | 'error') => new Promise<void>((resolve, reject) => {
      const handleSuccess = () => {
        cleanup();
        resolve();
      };
      const handleError = () => {
        cleanup();
        reject(new Error(`thumbnail-${eventName}-failed`));
      };
      const cleanup = () => {
        previewVideo.removeEventListener(eventName, handleSuccess);
        previewVideo.removeEventListener('error', handleError);
      };
      previewVideo.addEventListener(eventName, handleSuccess, { once: true });
      previewVideo.addEventListener('error', handleError, { once: true });
    });

    const render = async () => {
      try {
        if (previewVideo.readyState < 1) {
          await waitForEvent('loadedmetadata');
        }
        const width = Math.max(200, Math.min(360, previewVideo.videoWidth || 320));
        const height = Math.max(112, Math.round(width / Math.max(0.5, (previewVideo.videoWidth || 16) / Math.max(1, previewVideo.videoHeight || 9))));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) {
          return;
        }
        const frames = [];
        for (const time of thumbnailTimes) {
          if (cancelled) return;
          try {
            const safeTime = Math.min(Math.max(0, time), Math.max(0, (previewVideo.duration || selectedDuration || 0.2) - 0.05));
            if (Math.abs((previewVideo.currentTime || 0) - safeTime) > 0.02) {
              const seekPromise = waitForEvent('seeked');
              previewVideo.currentTime = safeTime;
              await seekPromise;
            }
            context.drawImage(previewVideo, 0, 0, width, height);
            frames.push({ time, src: canvas.toDataURL('image/jpeg', 0.72) });
          } catch {
            frames.push({ time, src: null });
          }
        }
        if (!cancelled) {
          setThumbnails(frames);
        }
      } catch {
        if (!cancelled) {
          setThumbnails(fallback);
        }
      }
    };

    void render();
    return () => {
      cancelled = true;
      previewVideo.pause();
      previewVideo.removeAttribute('src');
      previewVideo.load();
    };
  }, [selectedDuration, thumbnailTimes, videoSrc]);

  function seekTo(time: number) {
    const video = videoRef.current;
    const bounded = clampNumber(time, 0, selectedDuration, 0);
    setCurrentTime(bounded);
    if (!video) return;
    try {
      video.currentTime = bounded;
    } catch {
      // noop
    }
  }

  function commitClipSegments(segments: ClipSegment[], nextSelectedIndex = selectedSegmentIndex, extras: Record<string, unknown> = {}) {
    onConfigChange(buildClipConfigPatch(config, selectedDuration, segments, nextSelectedIndex, extras));
  }

  function updateSelectedSegmentRange(start: number, end: number) {
    const nextSegments = clipSegments.map((segment, index) => (
      index === selectedSegmentIndex
        ? { ...segment, startTime: start, endTime: end }
        : segment
    ));
    commitClipSegments(nextSegments, selectedSegmentIndex);
  }

  function selectSegment(index: number) {
    commitClipSegments(clipSegments, index);
    const segment = clipSegments[index];
    if (segment) {
      seekTo(segment.startTime);
    }
  }

  function applyInPoint(time = currentTime) {
    const next = normalizeClipWindow(snapTime(time), clipEnd, selectedDuration);
    updateSelectedSegmentRange(next.start, next.end);
    if (currentTime < next.start) seekTo(next.start);
  }

  function applyOutPoint(time = currentTime) {
    const next = normalizeClipWindow(clipStart, snapTime(time), selectedDuration);
    updateSelectedSegmentRange(next.start, next.end);
    if (currentTime > next.end) seekTo(next.end);
  }

  function resetSelection() {
    commitClipSegments([{
      id: clipSegments[0]?.id || 'segment-1',
      startTime: 0,
      endTime: selectedDuration,
      label: '片段 1',
    }], 0);
    seekTo(0);
  }

  function splitAtCurrentTime() {
    const splitTime = snapTime(currentTime);
    if (splitTime <= clipStart + 0.1 || splitTime >= clipEnd - 0.1) return;
    const current = clipSegments[selectedSegmentIndex];
    if (!current) return;
    const nextSegments = [
      ...clipSegments.slice(0, selectedSegmentIndex),
      { ...current, endTime: splitTime },
      { ...current, id: `${current.id}-b`, startTime: splitTime, endTime: current.endTime },
      ...clipSegments.slice(selectedSegmentIndex + 1),
    ];
    commitClipSegments(nextSegments, selectedSegmentIndex + 1);
    seekTo(splitTime);
  }

  function removeSelectedSegment() {
    if (clipSegments.length <= 1) {
      resetSelection();
      return;
    }
    const nextSegments = clipSegments.filter((_, index) => index !== selectedSegmentIndex);
    const nextIndex = Math.max(0, Math.min(nextSegments.length - 1, selectedSegmentIndex - 1));
    commitClipSegments(nextSegments, nextIndex);
    const targetSegment = nextSegments[nextIndex];
    if (targetSegment) seekTo(targetSegment.startTime);
  }

  async function togglePlayback() {
    const video = videoRef.current;
    if (!video) return;
    if (!video.paused) {
      video.pause();
      return;
    }
    if ((video.currentTime || 0) < clipStart || (video.currentTime || 0) > clipEnd) {
      seekTo(clipStart);
    }
    try {
      await video.play();
    } catch {
      // noop
    }
  }

  function updateFromPosition(clientX: number, handle: 'start' | 'end' | 'playhead') {
    const bounds = trackRef.current?.getBoundingClientRect();
    if (!bounds || !bounds.width) return;
    const ratio = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width));
    const nextTime = snapTime(ratio * selectedDuration);
    if (handle === 'playhead') {
      seekTo(nextTime);
      return;
    }
    if (handle === 'start') {
      const next = normalizeClipWindow(nextTime, clipEnd, selectedDuration);
      updateSelectedSegmentRange(next.start, next.end);
      if (currentTime < next.start) seekTo(next.start);
      return;
    }
    const next = normalizeClipWindow(clipStart, nextTime, selectedDuration);
    updateSelectedSegmentRange(next.start, next.end);
    if (currentTime > next.end) seekTo(next.end);
  }

  function beginDrag(handle: 'start' | 'end' | 'playhead', event: ReactPointerEvent<HTMLDivElement>) {
    onPanelInteract(event);
    // 阻止冒泡：左右手柄是轨道的子元素，若不 stopPropagation，事件会冒泡到轨道的
    // onPointerDown(beginDrag('playhead'))，把拖拽状态覆盖成播放头、并在轨道重新捕获指针，
    // 导致"拖手柄却只移动播放头、手柄不动"。stopPropagation 保证只有当前手柄的拖拽生效。
    event.stopPropagation();
    dragStateRef.current = { pointerId: event.pointerId, handle };
    event.currentTarget.setPointerCapture(event.pointerId);
    updateFromPosition(event.clientX, handle);
  }

  function continueDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    onPanelInteract(event);
    updateFromPosition(event.clientX, dragState.handle);
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    onPanelInteract(event);
    dragStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) {
        return;
      }
      const delta = event.shiftKey ? 1 : 0.1;
      if (event.code === 'Space') {
        event.preventDefault();
        void togglePlayback();
        return;
      }
      if (event.key === 'i' || event.key === 'I') {
        event.preventDefault();
        applyInPoint();
        return;
      }
      if (event.key === 'o' || event.key === 'O') {
        event.preventDefault();
        applyOutPoint();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        onConfirm();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        seekTo(snapTime(currentTime - delta));
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        seekTo(snapTime(currentTime + delta));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [clipEnd, clipStart, currentTime, onCancel, onConfirm, selectedDuration]);

  return (
    <div className="relative mt-4 flex justify-center overflow-visible px-1">
      <div
        ref={panelRef}
        data-testid={`video-clip-editor-${nodeId}`}
        className="rounded-[32px] border border-white/10 bg-[#171717]/96 px-4 py-3 shadow-[0_24px_80px_rgba(0,0,0,0.42)] ring-1 ring-white/6 backdrop-blur"
        style={{
          width: 'min(860px, calc(100vw - 56px))',
          minWidth: 'min(680px, calc(100vw - 32px))',
          maxWidth: 'calc(100vw - 32px)',
        }}
        tabIndex={0}
        {...panelInteractionProps}
        onPointerDown={panelInteractionProps.onPointerDown || onPanelInteract}
        onMouseDown={panelInteractionProps.onMouseDown || onPanelInteract}
        onTouchStart={panelInteractionProps.onTouchStart || onPanelInteract}
        onWheel={panelInteractionProps.onWheel || onPanelInteract}
      >
        <div className="flex items-center gap-3">
          <button type="button" className="rounded-2xl border border-white/10 bg-white/5 p-2 text-[#f0f0f0] transition hover:bg-white/10" onClick={onCancel} data-testid={`video-clip-cancel-${nodeId}`}>
            <X className="h-4 w-4" />
          </button>
          <div className="h-8 w-px bg-white/10" />
          <button type="button" className="rounded-2xl border border-white/10 bg-white/5 p-2 text-[#ececec] transition hover:bg-white/10" onClick={togglePlayback} data-testid={`video-clip-play-${nodeId}`}>
            {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </button>

          <div className="min-w-0 flex-1">
            <div
              ref={trackRef}
              data-testid={`video-clip-track-${nodeId}`}
              className="relative h-[64px] overflow-hidden rounded-[20px] border border-white/8 bg-[#0f1014] shadow-inner"
              onPointerDown={(event) => beginDrag('playhead', event)}
              onPointerMove={continueDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              <div className="absolute inset-0 flex">
                {thumbnails.map((item, index) => (
                  <button
                    key={`${item.time}-${index}`}
                    type="button"
                    data-testid={`video-clip-thumb-${nodeId}-${index}`}
                    className="relative h-full flex-1 overflow-hidden"
                    onPointerDown={stopCanvasInteraction}
                    onClick={() => seekTo(item.time)}
                  >
                    {item.src ? (
                      <img src={item.src} alt={`剪辑缩略帧 ${index + 1}`} className="h-full w-full object-cover opacity-90" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center bg-[linear-gradient(135deg,#242838,#4a3477)] text-[10px] font-semibold text-white/80">
                        帧 {index + 1}
                      </div>
                    )}
                  </button>
                ))}
              </div>
              <div className="absolute inset-y-0 left-0 bg-black/55" style={{ width: `${startPercent}%` }} />
              <div className="absolute inset-y-0 right-0 bg-black/55" style={{ width: `${100 - endPercent}%` }} />
              {snapMarkers.filter((marker) => marker > 0 && marker < selectedDuration).map((marker, index) => (
                <div
                  key={`${marker}-${index}`}
                  data-testid={`video-clip-marker-${nodeId}-${index}`}
                  className="pointer-events-none absolute inset-y-2 w-px bg-white/20"
                  style={{ left: `${selectedDuration > 0 ? (marker / selectedDuration) * 100 : 0}%` }}
                />
              ))}
              <div
                className="absolute inset-y-1 rounded-[16px] border border-white bg-white/10 shadow-[0_10px_24px_rgba(255,255,255,0.14)]"
                style={{ left: `${startPercent}%`, width: `${Math.max(6, endPercent - startPercent)}%` }}
              >
                <div className="absolute inset-x-0 top-1 flex justify-center">
                  <div className="rounded-full bg-[#26223a]/92 px-2.5 py-0.5 text-[11px] font-semibold text-white shadow-lg">
                    {clipLength.toFixed(2)}s
                  </div>
                </div>
                <div
                  className="absolute inset-y-1 left-0 w-2.5 cursor-ew-resize rounded-l-[16px] border-r border-black/25 bg-white"
                  data-testid={`video-clip-start-handle-${nodeId}`}
                  onPointerDown={(event) => beginDrag('start', event)}
                  onPointerMove={continueDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                />
                <div
                  className="absolute inset-y-1 right-0 w-2.5 cursor-ew-resize rounded-r-[16px] border-l border-black/25 bg-white"
                  data-testid={`video-clip-end-handle-${nodeId}`}
                  onPointerDown={(event) => beginDrag('end', event)}
                  onPointerMove={continueDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                />
              </div>
              <div className="absolute inset-y-0 w-0.5 bg-[#c5f4ff]" style={{ left: `${currentPercent}%` }} />
              <div className="pointer-events-none absolute left-3 top-2 rounded-full bg-black/55 px-2 py-0.5 text-[10px] text-white/85" data-testid={`video-clip-current-time-${nodeId}`}>
                {formatTimelineTime(currentTime)}
              </div>
              <div className="pointer-events-none absolute bottom-2 right-3 rounded-full bg-black/55 px-2 py-0.5 text-[10px] text-white/70">
                {formatTimelineTime(selectedDuration)}
              </div>
            </div>
          </div>

          <button
            type="button"
            className={`rounded-2xl border px-3 py-2 text-[11px] transition ${snapEnabled ? 'border-cyan-300/40 bg-cyan-400/12 text-cyan-100' : 'border-white/10 bg-white/5 text-[#cfcfcf] hover:bg-white/10'}`}
            onClick={() => onConfigChange({ tool: 'clip', snapToKeyframes: !snapEnabled })}
            data-testid={`video-clip-snap-toggle-${nodeId}`}
          >
            吸附
          </button>
          <button type="button" className="rounded-2xl border border-white/10 bg-white/5 p-2 text-[#ececec] transition hover:bg-white/10" onClick={resetSelection} data-testid={`video-clip-reset-${nodeId}`}>
            <RotateCcw className="h-4 w-4" />
          </button>
          <button type="button" className="rounded-[20px] bg-white p-3 text-[#171717] transition hover:bg-[#f3f3f3]" onClick={onConfirm} data-testid={`video-clip-confirm-${nodeId}`}>
            <Check className="h-5 w-5" />
          </button>
        </div>
        <div className="mt-2 flex items-center justify-center text-[11px] text-[#a9a9a9]" data-testid={`video-clip-shortcuts-${nodeId}`}>
          拖动左右手柄调整范围，点击时间条跳转，空格播放，Enter 确认，Esc 取消。
        </div>
      </div>
    </div>
  );
}

function VideoToolbar({
  nodeId,
  activeTool,
  onTool,
  onUpload,
  onToggleAssets,
  onDownload,
  onOpen,
}: {
  nodeId: string;
  activeTool: VideoTool | null;
  onTool: (tool: VideoTool) => void;
  onUpload: () => void;
  onToggleAssets: () => void;
  onDownload: () => void;
  onOpen: () => void;
}) {
  return (
    <div
      className="absolute -top-[74px] left-1/2 z-40 flex h-[52px] w-max max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-1 overflow-x-auto rounded-xl bg-[#2a2a2a] px-3 shadow-2xl ring-1 ring-[#424242] [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
      onPointerDown={stopCanvasInteraction}
      onMouseDown={stopCanvasInteraction}
      onTouchStart={stopCanvasInteraction}
      onWheel={stopCanvasInteraction}
    >
      <IconToolButton title="上传" onClick={onUpload}><Upload className="h-4 w-4" /></IconToolButton>
      <IconToolButton title="素材库" onClick={onToggleAssets}><FolderOpen className="h-4 w-4" /></IconToolButton>
      <div className="mx-2 h-7 w-px bg-[#454545]" />
      <ToolbarButton nodeId={nodeId} tool="clip" activeTool={activeTool} onTool={onTool} icon={<Scissors className="h-4 w-4" />} />
      <ToolbarButton nodeId={nodeId} tool="crop" activeTool={activeTool} onTool={onTool} icon={<Crop className="h-4 w-4" />} />
      <ToolbarButton nodeId={nodeId} tool="hd" activeTool={activeTool} onTool={onTool} icon={<span className="rounded-sm border border-current px-0.5 text-[10px] leading-3">HD</span>} />
      <ToolbarButton nodeId={nodeId} tool="parse" activeTool={activeTool} onTool={onTool} icon={<BarChart3 className="h-4 w-4" />} />
      <ToolbarButton nodeId={nodeId} tool="removeSubtitle" activeTool={activeTool} onTool={onTool} icon={<Subtitles className="h-4 w-4" />} />
      <ToolbarButton nodeId={nodeId} tool="audioSplit" activeTool={activeTool} onTool={onTool} icon={<AudioLines className="h-4 w-4" />} />
      <div className="mx-2 h-7 w-px bg-[#454545]" />
      <IconToolButton title="下载" onClick={onDownload}><Download className="h-4 w-4" /></IconToolButton>
      <IconToolButton title="查看大图" onClick={onOpen}><Maximize2 className="h-4 w-4" /></IconToolButton>
    </div>
  );
}

function PromptPanel({
  nodeId,
  prompt,
  capabilityBoundaryRecommendedModel,
  regionContractNotice,
  canSubmit,
  selectedModel,
  models,
  modelMenuOpen,
  ratioText,
  durationText,
  selectedCount,
  estimatedCost,
  estimatedSeconds,
  identityController,
  linkedAudioLabel,
  linkedAudioMode,
  promptAssistAction,
  promptAssistError,
  assistBaselineAction,
  activeTool,
  advancedOpen,
  referencePanelOpen,
  primaryInputs,
  referenceInputs,
  modeConfig,
  videoToolConfig,
  selectedAspectRatio,
  selectedQuality,
  selectedDuration,
  selectedMotionPreset,
  selectedGenerationMode,
  onPromptChange,
  onPromptCompositionStart,
  onPromptCompositionEnd,
  onToggleModelMenu,
  onChooseModel,
  onUpload,
  onModeUpload,
  onToggleAssetMenu,
  onToggleAdvancedPanel,
  onCountChange,
  onToolSelect,
  onPromptAssist,
  onToggleReferencePanel,
  onReferenceRoleChange,
  onReferenceWeightChange,
  onReferenceEnabledChange,
  referenceBindingSections,
  onBindReferenceInput,
  onRemoveReferenceInput,
  onParamsChange,
  onToolConfigChange,
  onSubmit,
  panelInteractionProps,
  onPanelInteract,
}: {
  nodeId: string;
  prompt: string;
  capabilityBoundaryRecommendedModel: string;
  regionContractNotice: string;
  canSubmit: boolean;
  selectedModel: VideoModelOption;
  models: VideoModelOption[];
  modelMenuOpen: boolean;
  ratioText: string;
  durationText: string;
  selectedCount: number;
  estimatedCost: number;
  estimatedSeconds: number;
  identityController: IdentityControllerConfig;
  linkedAudioLabel: string;
  linkedAudioMode: string;
  promptAssistAction: PromptAssistAction | null;
  promptAssistError: string | null;
  assistBaselineAction: PromptAssistAction | null;
  activeTool: VideoTool | null;
  advancedOpen: boolean;
  referencePanelOpen: boolean;
  primaryInputs: ReturnType<typeof collectConnectedReferenceInputs>;
  referenceInputs: ReturnType<typeof collectConnectedReferenceInputs>;
  referenceBindingSections: ReferenceBindingSection[];
  modeConfig: Record<string, unknown>;
  videoToolConfig: Record<string, unknown>;
  selectedAspectRatio: string;
  selectedQuality: string;
  selectedDuration: number;
  selectedMotionPreset: string;
  selectedGenerationMode: string;
  onPromptChange: (value: string) => void;
  onPromptCompositionStart: () => void;
  onPromptCompositionEnd: (value: string) => void;
  onToggleModelMenu: () => void;
  onChooseModel: (model: VideoModelOption) => void;
  onUpload: () => void;
  onModeUpload: (target: VideoUploadTarget) => void;
  onToggleAssetMenu: () => void;
  onToggleAdvancedPanel: () => void;
  onCountChange: (count: number) => void;
  onToolSelect: (tool: VideoTool) => void;
  onPromptAssist: (action: PromptAssistAction) => void;
  onToggleReferencePanel: () => void;
  onReferenceRoleChange: (key: string, role: ReferenceRole) => void;
  onReferenceWeightChange: (key: string, weight: number) => void;
  onReferenceEnabledChange: (key: string, enabled: boolean) => void;
  onBindReferenceInput: (sectionKey: string, candidate: ReferenceBindingCandidate) => void;
  onRemoveReferenceInput: (key: string) => void;
  onParamsChange: (patch: Record<string, unknown>) => void;
  onToolConfigChange: (patch: Record<string, unknown>) => void;
  onSubmit: () => void;
  panelInteractionProps: GuardedPanelInteractionProps;
  onPanelInteract: (event: { stopPropagation: () => void }) => void;
}) {
  const { isZh } = useUILanguage();
  const referenceTotal = primaryInputs.length + referenceInputs.length;
  const activeToolLabel = activeTool ? TOOL_LABELS[activeTool] : '未选择';
  const selectedModeBlueprint = VIDEO_MODE_BLUEPRINTS[selectedGenerationMode] || VIDEO_MODE_BLUEPRINTS.textToVideo;
  const providerText = selectedModel.providerLabel || selectedModel.provider;
  const hasModeAssetActions = selectedGenerationMode !== 'textToVideo';
  const allowedQualityOptions = computeAllowedQualityOptions(selectedModel);
  const videoModelSections = useMemo(() => {
    const mapItem = (model: VideoModelOption) => ({
      id: model.id,
      title: model.name,
      providerLabel: model.providerLabel || model.provider,
      modelLabel: model.upstreamModel || model.id,
      description: model.description,
      selected: model.id === selectedModel.id,
      disabledReason: model.unsupportedReason || null,
      kind: 'video' as const,
      badges: [
        model.activated ? { label: '已激活', tone: 'free' as const } : null,
        model.discountLabel ? { label: model.discountLabel, tone: 'api' as const } : null,
      ].filter(Boolean),
      meta: [
        `耗时 ${model.latency || '未知'}`,
        `基准/视频 ${formatCurrency(model.cost, model.currency || 'CNY')}`,
      ].filter(Boolean),
    });
    return [
      {
        id: 'all',
        title: '模型列表',
        items: models.map(mapItem),
      },
    ];
  }, [models, selectedModel.id]);

  return (
    <div
      className="absolute left-1/2 top-full z-30 mt-4 w-[min(96vw,720px)] -translate-x-1/2"
      {...panelInteractionProps}
      onPointerDown={panelInteractionProps.onPointerDown || onPanelInteract}
      onMouseDown={panelInteractionProps.onMouseDown || onPanelInteract}
      onTouchStart={panelInteractionProps.onTouchStart || onPanelInteract}
      onWheel={panelInteractionProps.onWheel || onPanelInteract}
    >
      <div className="overflow-visible rounded-[22px] bg-[#2b2b2b] shadow-2xl ring-1 ring-[#3c3c3c]">
        <div className="border-b border-[#3a3a3a] px-4 pt-4 pb-3">
          <div className="flex flex-wrap items-center gap-2">
            {VIDEO_MODE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                data-testid={`video-mode-${nodeId}-${option.value}`}
                onPointerDown={stopCanvasInteraction}
                onClick={() => onParamsChange({ generationMode: option.value })}
                className={`nodrag rounded-full px-3 py-1.5 text-xs transition-colors ${selectedGenerationMode === option.value ? 'bg-[#6f6f6f] text-white' : 'bg-[#343434] text-[#d2d2d2] hover:bg-[#404040]'}`}
              >
                {option.label}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-2">
              <CompactActionButton icon={<Upload className="h-4 w-4" />} label="上传" onClick={onUpload} testId={`video-upload-${nodeId}`} />
              <CompactActionButton icon={<FolderOpen className="h-4 w-4" />} label="素材" onClick={onToggleAssetMenu} testId={`video-assets-${nodeId}`} />
              <CompactActionButton
                icon={<Settings2 className="h-4 w-4" />}
                label={advancedOpen ? '收起设置' : '高级设置'}
                onClick={onToggleAdvancedPanel}
                testId={`video-advanced-${nodeId}`}
                active={advancedOpen}
              />
              <button
                type="button"
                onPointerDown={stopCanvasInteraction}
                onClick={() => {
                  if (activeTool === 'crop') {
                    onToolSelect('crop');
                    return;
                  }
                  onToolSelect(activeTool || 'hd');
                }}
                className="nodrag rounded-lg border border-[#4a4a4a] bg-[#2f2f2f] p-2 text-[#cfcfcf] hover:bg-[#383838]"
                title={activeTool === 'crop' ? '进入画面内裁剪' : '打开当前工具面板'}
              >
                <Expand className="h-4 w-4" />
              </button>
            </div>
          </div>

          {hasModeAssetActions ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {selectedGenerationMode === 'imageToVideo' ? (
                <ModeAssetShortcut label="上传源图" hint="作为首帧或主体锚点" onClick={() => onModeUpload('sourceImage')} testId={`video-source-upload-${nodeId}`} />
              ) : null}
              {selectedGenerationMode === 'firstLastFrame' ? (
                <>
                  <ModeAssetShortcut label="上传首帧" hint="锁定视频开头画面" onClick={() => onModeUpload('firstFrame')} testId={`video-first-frame-upload-${nodeId}`} />
                  <ModeAssetShortcut label="上传尾帧" hint="锁定视频结尾画面" onClick={() => onModeUpload('lastFrame')} testId={`video-last-frame-upload-${nodeId}`} />
                </>
              ) : null}
              {selectedGenerationMode === 'referenceVideo' ? (
                <>
                  <ModeAssetShortcut label="上传参考图" hint="锁定风格与主体" onClick={() => onModeUpload('referenceImage')} testId={`video-reference-image-upload-${nodeId}`} />
                  <ModeAssetShortcut label="上传参考视频" hint="复用运镜和节奏" onClick={() => onModeUpload('referenceVideo')} testId={`video-reference-video-upload-${nodeId}`} />
                </>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="px-4 py-3">
          <textarea
            data-testid={`video-prompt-${nodeId}`}
            placeholder="描述你想要生成的画面内容，或在上传视频后追加镜头说明"
            value={prompt}
            onPointerDown={stopCanvasInteraction}
            onMouseDown={stopCanvasInteraction}
            onTouchStart={stopCanvasInteraction}
            onWheel={stopCanvasInteraction}
            onCompositionStart={onPromptCompositionStart}
            onCompositionEnd={(event) => onPromptCompositionEnd(event.currentTarget.value)}
            onKeyDown={(event) => event.stopPropagation()}
            onChange={(event) => onPromptChange(event.target.value)}
            aria-label="视频提示词"
            className="nodrag nopan nowheel min-h-[88px] w-full resize-none rounded-2xl bg-[#262626] px-4 py-3 text-sm text-[#e6e6e6] outline-none placeholder:text-[#8f8f8f]"
          />
          {promptAssistError ? (
            <div className="mt-2 space-y-2">
              {promptAssistError.includes('模型下载') || promptAssistError.includes('模型加载') || promptAssistError.includes('本地翻译') ? (
                <LocalModelPanel />
              ) : (
                <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs leading-5 text-rose-200">
                  <div className="font-semibold text-rose-300">提示词辅助失败</div>
                  <div className="mt-1">{promptAssistError}</div>
                </div>
              )}
              {promptAssistError.includes('API Key') || promptAssistError.includes('密钥') ? (
                <Link
                  to="/settings/api-keys"
                  className="inline-flex items-center gap-1 rounded-lg bg-rose-500/20 px-2.5 py-1.5 text-[11px] font-medium text-rose-300 hover:bg-rose-500/30 transition-colors"
                >
                  <KeyRound className="h-3 w-3" />
                  前往配置 API 密钥
                </Link>
              ) : null}
            </div>
          ) : null}
        </div>
        {capabilityBoundaryRecommendedModel ? (
          <div
            data-testid={`video-model-capability-boundary-${nodeId}`}
            className="mx-4 mb-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs leading-6 text-amber-100"
          >
            <div className="text-amber-300">推荐模型：{capabilityBoundaryRecommendedModel}</div>
          </div>
        ) : null}
        {regionContractNotice ? (
          <div className="mx-4 mb-3 rounded-2xl border border-sky-500/20 bg-sky-500/10 px-4 py-3 text-xs leading-6 text-sky-100">
            <div className="font-semibold text-sky-200">打标签摘要</div>
            <div className="mt-1">{regionContractNotice}</div>
          </div>
        ) : null}

        <div className="border-t border-[#3a3a3a] px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onPointerDown={stopCanvasInteraction}
              onClick={() => onPromptAssist('translate')}
              data-testid={`video-translate-${nodeId}`}
              className={`nodrag inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${assistBaselineAction === 'translate' ? 'border-[#f5a623] text-[#f5a623] hover:bg-[#f5a623]/10' : 'border-[#4a4a4a] text-[#d9d9d9] hover:bg-[#353535]'}`}
              disabled={!prompt.trim() || promptAssistAction !== null}
              title={assistBaselineAction === 'translate' ? '撤销翻译，恢复原始提示词' : '中→英 / 英→中 自动翻译提示词'}
            >
              {promptAssistAction === 'translate' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Languages className="h-3.5 w-3.5" />}
              {assistBaselineAction === 'translate' ? '撤销翻译' : '自动翻译'}
            </button>
            <button
              type="button"
              onPointerDown={stopCanvasInteraction}
              onClick={() => onPromptAssist('optimize')}
              data-testid={`video-optimize-${nodeId}`}
              className={`nodrag inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${assistBaselineAction === 'optimize' ? 'border-[#f5a623] text-[#f5a623] hover:bg-[#f5a623]/10' : 'border-[#4a4a4a] text-[#d9d9d9] hover:bg-[#353535]'}`}
              disabled={!prompt.trim() || promptAssistAction !== null}
              title={assistBaselineAction === 'optimize' ? '撤销优化，恢复原始提示词' : '自动优化成更适合模型生成的视频提示词'}
            >
              {promptAssistAction === 'optimize' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              {assistBaselineAction === 'optimize' ? '撤销优化' : '优化提示词'}
            </button>
            <button
              type="button"
              onPointerDown={stopCanvasInteraction}
              onClick={onToggleReferencePanel}
              className={`nodrag inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors ${referencePanelOpen ? 'border-[#5a7f79] bg-[#18302b] text-[#d8fff7]' : 'border-[#4a4a4a] text-[#d9d9d9] hover:bg-[#353535]'}`}
              data-testid={`video-reference-toggle-${nodeId}`}
              title="展开参考素材角色与权重设置"
            >
              <ImageIcon className="h-3.5 w-3.5" />
              参考素材
              <span className="rounded-full bg-black/20 px-1.5 py-0.5 text-[10px]">{referenceTotal}</span>
            </button>
            <span className="rounded-full bg-[#343434] px-3 py-1 text-[11px] text-[#d0d0d0]">平台 {providerText}</span>
            <span className={`rounded-full px-3 py-1 text-[11px] ${identityController.enabled ? 'bg-[#20342f] text-[#aaf2df]' : 'bg-[#343434] text-[#bdbdbd]'}`}>
              身份控制 {identityController.enabled ? (identityController.identityLockMode || 'reference') : '关闭'}
            </span>
            {linkedAudioLabel ? (
              <span className="rounded-full bg-[#22313f] px-3 py-1 text-[11px] text-[#cfe6ff]">
                音频复用 {linkedAudioLabel}{linkedAudioMode ? ` · ${linkedAudioMode}` : ''}
              </span>
            ) : null}
            <span className="rounded-md bg-[#1f1f1f] px-2.5 py-1.5 text-xs text-[#9ee6d9]">耗时 {formatEta(estimatedSeconds)}</span>
            <span className="rounded-md bg-[#1f1f1f] px-2.5 py-1.5 text-xs text-[#f3d38a]">费用 {formatCurrency(estimatedCost, selectedModel.currency || 'CNY')}</span>
          </div>
        </div>

        <div className="border-t border-[#3a3a3a] px-4 py-3">
          <ReferenceConditioningSummary
            nodeId={nodeId}
            primaryInputs={primaryInputs}
            references={referenceInputs}
            className="mb-3"
          />
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
            <div className="flex flex-wrap items-center gap-2">
              <select data-testid={`video-aspect-${nodeId}`} value={selectedAspectRatio} onChange={(event) => onParamsChange({ aspectRatio: event.target.value })} className="rounded-md border border-[#444] bg-[#1f1f1f] px-2.5 py-1.5 text-xs text-[#e7e7e7] outline-none">
                {VIDEO_ASPECT_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
              <select data-testid={`video-quality-${nodeId}`} value={allowedQualityOptions.includes(selectedQuality) ? selectedQuality : allowedQualityOptions[allowedQualityOptions.length - 1]} onChange={(event) => onParamsChange({ quality: event.target.value })} className="rounded-md border border-[#444] bg-[#1f1f1f] px-2.5 py-1.5 text-xs text-[#e7e7e7] outline-none">
                {allowedQualityOptions.map((option) => <option key={option} value={option}>{option.toUpperCase()}</option>)}
              </select>
              <label className="flex items-center gap-2 rounded-md border border-[#434343] px-2.5 py-1.5 text-xs text-[#d7d7d7]">
                <span>时长</span>
                <input data-testid={`video-duration-${nodeId}`} type="number" min={1} max={30} value={selectedDuration} onChange={(event) => onParamsChange({ duration: Number(event.target.value) || 5 })} className="w-12 bg-transparent text-right outline-none" />
                <span>s</span>
              </label>
              <label className="flex items-center gap-2 rounded-md border border-[#434343] px-2.5 py-1.5 text-xs text-[#d7d7d7]">
                <span>数量</span>
                <select
                  value={selectedCount}
                  onPointerDown={stopCanvasInteraction}
                  onMouseDown={stopCanvasInteraction}
                  onTouchStart={stopCanvasInteraction}
                  onWheel={stopCanvasInteraction}
                  onChange={(event) => onCountChange(Number(event.target.value))}
                  data-testid={`video-count-${nodeId}`}
                  className="nodrag nopan nowheel bg-transparent text-xs outline-none"
                >
                  {OUTPUT_COUNT_OPTIONS.map((count) => (
                    <option key={count} value={count} className="bg-[#1f1f1f]">
                      {count} 条
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="rounded-2xl border border-[#3d3d3d] bg-[#232323] px-3 py-2.5 text-xs text-[#d6d6d6]">
              <div className="font-medium text-[#f1f1f1]">{selectedModeBlueprint.title}</div>
              <div className="mt-1 leading-5 text-[#9f9f9f]">{selectedModeBlueprint.description}</div>
              <div className="mt-2 text-[11px] text-[#6fd8c4]">当前工具：{activeToolLabel}</div>
            </div>
          </div>
        </div>

        <div className="border-t border-[#3a3a3a] px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            {(Object.keys(VIDEO_TOOL_OPERATIONS) as VideoTool[]).map((tool) => (
              <button
                key={tool}
                type="button"
                data-testid={`video-tool-${nodeId}-${tool}`}
                onPointerDown={stopCanvasInteraction}
                onClick={() => onToolSelect(tool)}
                className={`nodrag rounded-full px-3 py-1.5 text-xs transition-colors ${activeTool === tool ? 'bg-[#6f6f6f] text-white' : 'bg-[#343434] text-[#e5e5e5] hover:bg-[#404040]'}`}
              >
                {TOOL_LABELS[tool]}
              </button>
            ))}
            <button
              type="button"
              onPointerDown={stopCanvasInteraction}
              onClick={onToggleAdvancedPanel}
              className="nodrag ml-auto inline-flex items-center gap-1.5 rounded-md border border-[#4a4a4a] px-3 py-1.5 text-xs text-[#d8d8d8] hover:bg-[#353535]"
            >
              <Settings2 className="h-3.5 w-3.5" />
              {advancedOpen ? '收起高级参数' : '展开高级参数'}
            </button>
          </div>
        </div>

        {referencePanelOpen ? (
          <div data-testid={`video-reference-panel-${nodeId}`}>
            <ReferenceInputsPanel
              nodeId={nodeId}
              title="参考素材管理"
              hint="主素材端口用于接参考图或参考视频；图像参考端口偏风格/主体，视频参考端口偏运镜/节奏。"
              primaryInputs={primaryInputs}
              references={referenceInputs}
              bindingSections={referenceBindingSections}
              onRoleChange={onReferenceRoleChange}
              onWeightChange={onReferenceWeightChange}
              onEnabledChange={onReferenceEnabledChange}
              onBindInput={onBindReferenceInput}
              onRemoveInput={onRemoveReferenceInput}
            />
          </div>
        ) : null}

        {advancedOpen ? (
          <div data-testid={`video-advanced-panel-${nodeId}`}>
            <VideoToolControls
              nodeId={nodeId}
              activeTool={activeTool}
              modeConfig={modeConfig}
              config={videoToolConfig}
              selectedAspectRatio={selectedAspectRatio}
              selectedQuality={selectedQuality}
              allowedQualityOptions={allowedQualityOptions}
              selectedDuration={selectedDuration}
              selectedMotionPreset={selectedMotionPreset}
              selectedGenerationMode={selectedGenerationMode}
              onParamsChange={onParamsChange}
              onModeUpload={onModeUpload}
              onToolSelect={onToolSelect}
              onToolConfigChange={onToolConfigChange}
            />
          </div>
        ) : null}

        <div className="relative flex items-center gap-3 border-t border-[#3a3a3a] px-4 py-3">
          <button
            type="button"
            onPointerDown={stopCanvasInteraction}
            onClick={onToggleModelMenu}
            data-testid={`video-model-toggle-${nodeId}`}
            className="nodrag flex h-8 items-center gap-2 rounded-md px-1 text-sm font-semibold text-[#f0f0f0] transition-colors hover:bg-[#3a3a3a]"
            aria-expanded={modelMenuOpen}
          >
            <BarChart3 className="h-4 w-4" />
            <span>{providerText} · {selectedModel.upstreamModel || selectedModel.name}</span>
            {selectedModel.activated ? (
              <span className="text-xs text-emerald-400">
                {selectedModel.activationModelMatched === false ? '平台已激活' : '已验证此模型'}
              </span>
            ) : null}
            {videoModelActivationSourceLabel(selectedModel) ? (
              <SourceBadge label={videoModelActivationSourceLabel(selectedModel) || 'via Relay'} tone="relay" />
            ) : null}
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${modelMenuOpen ? 'rotate-180' : ''}`} />
          </button>

          {modelMenuOpen ? (
            <div className="absolute bottom-[52px] left-3">
              <NodeModelBrowser
                title="视频节点模型池"
                sections={videoModelSections}
                onSelect={(item) => {
                  const model = models.find((entry) => entry.id === item.id);
                  if (!model) return;
                  onChooseModel(model);
                }}
                testId={`video-model-browser-${nodeId}`}
                itemTestIdPrefix={`video-model-option-${nodeId}`}
              />
            </div>
          ) : null}

          <span className="rounded-full bg-[#333] px-2.5 py-1 text-xs font-medium text-[#e4e4e4]">{ratioText} · {durationText}</span>

          <div className="ml-auto flex items-center gap-3 text-[#d7d7d7]">
            <span className="text-xs text-[#cfcfcf]">{selectedCount} 条</span>
            <span className="text-xs text-[#cfcfcf]">{formatCurrency(estimatedCost, selectedModel.currency || 'CNY')}</span>
            <Zap className="h-3.5 w-3.5 text-[#bdbdbd]" />
            <button
              type="button"
              onPointerDown={stopCanvasInteraction}
              onClick={onSubmit}
              data-testid={`video-generate-${nodeId}`}
              disabled={!canSubmit}
              className="nodrag flex h-8 w-8 items-center justify-center rounded-lg bg-[#bdbdbd] text-[#252525] transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
              title="生成"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function VideoModeControls({
  nodeId,
  mode,
  modeConfig,
  selectedMotionPreset,
  onParamsChange,
  onModeUpload,
}: {
  nodeId: string;
  mode: string;
  modeConfig: Record<string, unknown>;
  selectedMotionPreset: string;
  onParamsChange: (patch: Record<string, unknown>) => void;
  onModeUpload: (target: VideoUploadTarget) => void;
}) {
  const blueprint = VIDEO_MODE_BLUEPRINTS[mode] || VIDEO_MODE_BLUEPRINTS.textToVideo;
  const stylePreset = String(modeConfig.stylePreset || '电影感');
  const motionStrength = clampNumber(modeConfig.motionStrength ?? 0.62, 0, 1, 0.62);
  const referenceWeight = clampNumber(modeConfig.referenceWeight ?? 0.7, 0, 1, 0.7);
  const consistencyStrength = clampNumber(modeConfig.consistencyStrength ?? 0.8, 0, 1, 0.8);
  const firstFrameUrl = String(modeConfig.firstFrameUrl || '');
  const lastFrameUrl = String(modeConfig.lastFrameUrl || '');
  const referenceVideoUrl = String(modeConfig.referenceVideoUrl || '');
  const referenceImageUrl = String(modeConfig.referenceImageUrl || '');

  return (
    <div className="mx-4 mb-3 rounded-xl border border-[#404040] bg-[#202020] p-3 nodrag nopan nowheel" onPointerDown={stopCanvasInteraction} onMouseDown={stopCanvasInteraction} onTouchStart={stopCanvasInteraction} onWheel={stopCanvasInteraction}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-[#f3f3f3]">{blueprint.title}</div>
          <div className="mt-1 text-xs leading-5 text-[#a9a9a9]">{blueprint.description}</div>
          <div className="mt-1 text-[11px] text-[#6fd8c4]">技术路径：{blueprint.technique}</div>
        </div>
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {mode === 'textToVideo' ? (
          <>
            <label className="grid gap-1 text-xs text-[#d9d9d9]">
              <span>风格预设</span>
              <select value={stylePreset} onChange={(event) => onParamsChange({ stylePreset: event.target.value })} className="rounded-md border border-[#444] bg-[#1f1f1f] px-2 py-1 outline-none">
                {VIDEO_STYLE_PRESETS.map((preset) => <option key={preset} value={preset}>{preset}</option>)}
              </select>
            </label>
            <label className="grid gap-1 text-xs text-[#d9d9d9]">
              <span>运动强度</span>
              <input data-testid={`video-motion-strength-${nodeId}`} type="range" min={0} max={1} step={0.01} value={motionStrength} onChange={(event) => onParamsChange({ motionStrength: Number(event.target.value) })} />
            </label>
          </>
        ) : null}

        {mode === 'imageToVideo' ? (
          <>
            <button type="button" onPointerDown={stopCanvasInteraction} onClick={() => onModeUpload('sourceImage')} data-testid={`video-source-upload-${nodeId}`} className="rounded-lg border border-dashed border-[#5a5a5a] px-3 py-2 text-left text-xs text-[#d9d9d9] hover:bg-[#2e2e2e]">
              <div className="font-semibold text-[#f4f4f4]">上传源图</div>
              <div className="mt-1 text-[11px] text-[#a7a7a7]">作为首帧或主体锚点，写入 sourceUrl。</div>
            </button>
            <label className="grid gap-1 text-xs text-[#d9d9d9]">
              <span>主体一致性</span>
              <input data-testid={`video-consistency-${nodeId}`} type="range" min={0} max={1} step={0.01} value={consistencyStrength} onChange={(event) => onParamsChange({ consistencyStrength: Number(event.target.value) })} />
            </label>
          </>
        ) : null}

        {mode === 'firstLastFrame' ? (
          <>
            <button type="button" onPointerDown={stopCanvasInteraction} onClick={() => onModeUpload('firstFrame')} data-testid={`video-first-frame-upload-${nodeId}`} className="rounded-lg border border-dashed border-[#5a5a5a] px-3 py-2 text-left text-xs text-[#d9d9d9] hover:bg-[#2e2e2e]">
              <div className="font-semibold text-[#f4f4f4]">上传首帧</div>
              <div className="mt-1 text-[11px] text-[#a7a7a7]">{firstFrameUrl ? '首帧素材已写入' : '用于锁定视频开头画面'}</div>
            </button>
            <button type="button" onPointerDown={stopCanvasInteraction} onClick={() => onModeUpload('lastFrame')} data-testid={`video-last-frame-upload-${nodeId}`} className="rounded-lg border border-dashed border-[#5a5a5a] px-3 py-2 text-left text-xs text-[#d9d9d9] hover:bg-[#2e2e2e]">
              <div className="font-semibold text-[#f4f4f4]">上传尾帧</div>
              <div className="mt-1 text-[11px] text-[#a7a7a7]">{lastFrameUrl ? '尾帧素材已写入' : '用于锁定视频结尾画面'}</div>
            </button>
          </>
        ) : null}

        {mode === 'referenceVideo' ? (
          <>
            <button type="button" onPointerDown={stopCanvasInteraction} onClick={() => onModeUpload('referenceImage')} data-testid={`video-reference-image-upload-${nodeId}`} className="rounded-lg border border-dashed border-[#5a5a5a] px-3 py-2 text-left text-xs text-[#d9d9d9] hover:bg-[#2e2e2e]">
              <div className="font-semibold text-[#f4f4f4]">上传参考图</div>
              <div className="mt-1 text-[11px] text-[#a7a7a7]">{referenceImageUrl ? '参考图已就位' : '用于锁定构图、风格和主体'}</div>
            </button>
            <button type="button" onPointerDown={stopCanvasInteraction} onClick={() => onModeUpload('referenceVideo')} data-testid={`video-reference-video-upload-${nodeId}`} className="rounded-lg border border-dashed border-[#5a5a5a] px-3 py-2 text-left text-xs text-[#d9d9d9] hover:bg-[#2e2e2e]">
              <div className="font-semibold text-[#f4f4f4]">上传参考视频</div>
              <div className="mt-1 text-[11px] text-[#a7a7a7]">{referenceVideoUrl ? '参考视频已就位' : '用于复用镜头节奏和运动语言'}</div>
            </button>
            <label className="grid gap-1 text-xs text-[#d9d9d9] md:col-span-2">
              <span>参考权重</span>
              <input data-testid={`video-reference-weight-${nodeId}`} type="range" min={0} max={1} step={0.01} value={referenceWeight} onChange={(event) => onParamsChange({ referenceWeight: Number(event.target.value) })} />
            </label>
          </>
        ) : null}
      </div>
    </div>
  );
}

function VideoToolControls({
  nodeId,
  activeTool,
  modeConfig,
  config,
  selectedAspectRatio,
  selectedQuality,
  allowedQualityOptions,
  selectedDuration,
  selectedMotionPreset,
  selectedGenerationMode,
  onParamsChange,
  onModeUpload,
  onToolSelect,
  onToolConfigChange,
}: {
  nodeId: string;
  activeTool: VideoTool | null;
  modeConfig: Record<string, unknown>;
  config: Record<string, unknown>;
  selectedAspectRatio: string;
  selectedQuality: string;
  allowedQualityOptions: string[];
  selectedDuration: number;
  selectedMotionPreset: string;
  selectedGenerationMode: string;
  onParamsChange: (patch: Record<string, unknown>) => void;
  onModeUpload: (target: VideoUploadTarget) => void;
  onToolSelect: (tool: VideoTool) => void;
  onToolConfigChange: (patch: Record<string, unknown>) => void;
}) {
  const currentTool = activeTool || 'clip';
  const toolLabel = TOOL_LABELS[currentTool];
  return (
    <div className="border-t border-[#3b3b3b] px-4 py-3">
      <div className="mb-3 flex flex-wrap gap-2">
        {VIDEO_MODE_OPTIONS.map((option) => (
          <button key={option.value} type="button" data-testid={`video-mode-${nodeId}-${option.value}`} onClick={() => onParamsChange({ generationMode: option.value })} className={`rounded-full px-3 py-1 text-xs transition-colors ${selectedGenerationMode === option.value ? 'bg-[#6f6f6f] text-white' : 'bg-[#343434] text-[#d2d2d2] hover:bg-[#404040]'}`}>
            {option.label}
          </button>
        ))}
        <select data-testid={`video-aspect-${nodeId}`} value={selectedAspectRatio} onChange={(event) => onParamsChange({ aspectRatio: event.target.value })} className="rounded-md border border-[#444] bg-[#1f1f1f] px-2 py-1 text-xs text-[#e7e7e7] outline-none">
          {VIDEO_ASPECT_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
        <select data-testid={`video-quality-${nodeId}`} value={allowedQualityOptions.includes(selectedQuality) ? selectedQuality : allowedQualityOptions[allowedQualityOptions.length - 1]} onChange={(event) => onParamsChange({ quality: event.target.value })} className="rounded-md border border-[#444] bg-[#1f1f1f] px-2 py-1 text-xs text-[#e7e7e7] outline-none">
          {allowedQualityOptions.map((option) => <option key={option} value={option}>{option.toUpperCase()}</option>)}
        </select>
        <label className="flex items-center gap-2 rounded-md border border-[#434343] px-2.5 py-1.5 text-xs text-[#d7d7d7]">
          <span>时长</span>
          <input data-testid={`video-duration-${nodeId}`} type="number" min={1} max={30} value={selectedDuration} onChange={(event) => onParamsChange({ duration: Number(event.target.value) || 5 })} className="w-16 bg-transparent text-right outline-none" />
          <span>s</span>
        </label>
      </div>
      <VideoModeControls nodeId={nodeId} mode={selectedGenerationMode} modeConfig={modeConfig} selectedMotionPreset={selectedMotionPreset} onParamsChange={onParamsChange} onModeUpload={onModeUpload} />
      <div className="grid gap-2 md:grid-cols-2">
        <div className="rounded-lg border border-[#434343] bg-[#232323] p-3">
          <div className="mb-2 text-xs text-[#8e8e8e]">工具能力</div>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(VIDEO_TOOL_OPERATIONS) as VideoTool[]).map((tool) => (
              <button key={tool} type="button" data-testid={`video-tool-${nodeId}-${tool}`} onClick={() => onToolSelect(tool)} className={`rounded-md px-3 py-1 text-xs ${currentTool === tool ? 'bg-[#6f6f6f] text-white' : 'bg-[#343434] text-[#e5e5e5]'}`}>
                {TOOL_LABELS[tool]}
              </button>
            ))}
          </div>
          <div className="mt-3 text-xs text-[#8e8e8e]">当前工具：{toolLabel}</div>
          {currentTool === 'clip' ? <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-[#d8d8d8]"><label className="grid gap-1"><span>起点</span><input data-testid={`video-clip-start-${nodeId}`} type="number" min={0} max={selectedDuration} value={Number(config.startTime || 0)} onChange={(event) => onToolConfigChange({ tool: 'clip', startTime: Number(event.target.value) || 0 })} className="rounded-md border border-[#444] bg-[#1f1f1f] px-2 py-1 outline-none" /></label><label className="grid gap-1"><span>终点</span><input data-testid={`video-clip-end-${nodeId}`} type="number" min={1} max={selectedDuration} value={Number(config.endTime || selectedDuration)} onChange={(event) => onToolConfigChange({ tool: 'clip', endTime: Number(event.target.value) || selectedDuration })} className="rounded-md border border-[#444] bg-[#1f1f1f] px-2 py-1 outline-none" /></label></div> : null}
          {currentTool === 'crop' ? <div className="mt-3 rounded-lg border border-cyan-500/30 bg-cyan-500/8 px-3 py-2 text-xs leading-5 text-cyan-100">裁剪不会弹出参数面板。请直接在视频预览上拖拽裁剪网格，调整大小后点击画面内的“确认裁剪”。</div> : null}
          {currentTool === 'hd' ? <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-[#d8d8d8]"><label className="grid gap-1"><span>超分倍率</span><select data-testid={`video-hd-scale-${nodeId}`} value={String(config.scale || 2)} onChange={(event) => onToolConfigChange({ tool: 'hd', scale: Number(event.target.value) })} className="rounded-md border border-[#444] bg-[#1f1f1f] px-2 py-1 outline-none"><option value="2">2x</option><option value="4">4x</option></select></label><label className="grid gap-1"><span>帧率</span><select data-testid={`video-hd-fps-${nodeId}`} value={String(config.interpolate60fps ? '60' : '24')} onChange={(event) => onToolConfigChange({ tool: 'hd', interpolate60fps: event.target.value === '60' })} className="rounded-md border border-[#444] bg-[#1f1f1f] px-2 py-1 outline-none"><option value="24">24fps</option><option value="60">60fps</option></select></label><label className="grid gap-1"><span>细节增强</span><input data-testid={`video-hd-detail-${nodeId}`} type="range" min={0} max={1} step={0.01} value={Number(config.detailStrength ?? 0.58)} onChange={(event) => onToolConfigChange({ tool: 'hd', detailStrength: Number(event.target.value) })} /></label><label className="grid gap-1"><span>锐化</span><input data-testid={`video-hd-sharpen-${nodeId}`} type="range" min={0} max={1} step={0.01} value={Number(config.sharpen ?? 0.36)} onChange={(event) => onToolConfigChange({ tool: 'hd', sharpen: Number(event.target.value) })} /></label></div> : null}
          {currentTool === 'parse' ? <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-[#d8d8d8]"><label className="flex items-center justify-between rounded-md border border-[#444] px-2 py-1"><span>场景检测</span><input data-testid={`video-parse-scene-${nodeId}`} type="checkbox" checked={Boolean(config.sceneDetect)} onChange={(event) => onToolConfigChange({ tool: 'parse', sceneDetect: event.target.checked })} /></label><label className="grid gap-1"><span>抽样 FPS</span><input data-testid={`video-parse-fps-${nodeId}`} type="number" min={1} max={10} value={Number(config.sampleFps ?? 2)} onChange={(event) => onToolConfigChange({ tool: 'parse', sampleFps: Number(event.target.value) || 2 })} className="rounded-md border border-[#444] bg-[#1f1f1f] px-2 py-1 outline-none" /></label></div> : null}
          {currentTool === 'removeSubtitle' ? <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-[#d8d8d8]"><label className="flex items-center justify-between rounded-md border border-[#444] px-2 py-1"><span>自动识别</span><input data-testid={`video-remove-auto-${nodeId}`} type="checkbox" checked={String(config.detectionMode || 'auto') === 'auto'} onChange={(event) => onToolConfigChange({ tool: 'removeSubtitle', detectionMode: event.target.checked ? 'auto' : 'manual' })} /></label><label className="grid gap-1"><span>羽化</span><input data-testid={`video-remove-feather-${nodeId}`} type="number" min={0} max={32} value={Number(config.maskFeather ?? 8)} onChange={(event) => onToolConfigChange({ tool: 'removeSubtitle', maskFeather: Number(event.target.value) || 8 })} className="rounded-md border border-[#444] bg-[#1f1f1f] px-2 py-1 outline-none" /></label></div> : null}
          {currentTool === 'audioSplit' ? <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-[#d8d8d8]"><label className="flex items-center justify-between rounded-md border border-[#444] px-2 py-1"><span>保留人声</span><input data-testid={`video-audio-keep-${nodeId}`} type="checkbox" checked={Boolean(config.keepVocalInVideo)} onChange={(event) => onToolConfigChange({ tool: 'audioSplit', keepVocalInVideo: event.target.checked })} /></label><label className="flex items-center justify-between rounded-md border border-[#444] px-2 py-1"><span>导出工作流</span><input data-testid={`video-audio-export-${nodeId}`} type="checkbox" checked={Boolean(config.exportToWorkflow)} onChange={(event) => onToolConfigChange({ tool: 'audioSplit', exportToWorkflow: event.target.checked })} /></label></div> : null}
        </div>
        <div className="rounded-lg border border-[#434343] bg-[#232323] p-3">
          <div className="mb-2 text-xs text-[#8e8e8e]">当前工具配置</div>
          {currentTool === 'crop' ? (
            <div className="rounded-lg border border-cyan-500/25 bg-cyan-500/8 px-3 py-2 text-[11px] leading-5 text-cyan-100" data-testid={`video-tool-config-${nodeId}`}>
              裁剪参数改为直接在视频画面中编辑。确认后会把当前裁剪区域写入节点，用于后续裁剪处理。
            </div>
          ) : (
            <pre className="max-h-28 overflow-auto text-[11px] leading-5 text-[#d8d8d8]" data-testid={`video-tool-config-${nodeId}`}>{JSON.stringify(config, null, 2)}</pre>
          )}
        </div>
      </div>
    </div>
  );
}

function ToolModelLabel({
  label,
  help,
}: {
  label: string;
  help: ToolModelHelpEntry | null;
}) {
  if (!help) {
    return <span>{label}</span>;
  }
  return (
    <span className="flex items-center gap-1">
      <span>{label}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[#9ee6d9] transition hover:bg-white/10 hover:text-white"
            onPointerDown={stopCanvasInteraction}
            onMouseDown={stopCanvasInteraction}
            title={`${help.label}：${help.role} 优势：${help.advantage}`}
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[280px] rounded-xl border border-white/10 bg-[#111]/96 px-3 py-2 text-[11px] leading-5 text-white">
          <div className="font-semibold text-[#f4f4f4]">{help.label}</div>
          <div className="mt-1 text-[#d4d4d4]">作用：{help.role}</div>
          <div className="text-[#9ee6d9]">优势：{help.advantage}</div>
        </TooltipContent>
      </Tooltip>
    </span>
  );
}

function ToolModelHint({
  help,
  testId,
}: {
  help: ToolModelHelpEntry | null;
  testId?: string;
}) {
  if (!help) return null;
  return (
    <div data-testid={testId} className="rounded-lg border border-[#32524e] bg-[#16211f] px-3 py-2 text-[11px] leading-5 text-[#d6f6ef]">
      <div className="font-medium text-[#f2fffc]">{help.label}</div>
      <div>作用：{help.role}</div>
      <div>优势：{help.advantage}</div>
    </div>
  );
}

function VideoToolFloatingPanel({
  nodeId,
  activeTool,
  config,
  selectedDuration,
  viewportScale,
  onToolConfigChange,
  onClose,
  onApply,
  panelInteractionProps,
  onPanelInteract,
}: {
  nodeId: string;
  activeTool: VideoTool;
  config: Record<string, unknown>;
  selectedDuration: number;
  viewportScale: number;
  onToolConfigChange: (patch: Record<string, unknown>) => void;
  onClose: () => void;
  onApply: () => void;
  panelInteractionProps: GuardedPanelInteractionProps;
  onPanelInteract: (event: { stopPropagation: () => void }) => void;
}) {
  const { isZh } = useUILanguage();
  const byokRuntime = useByokRuntimeStore((state) => state.runtime);
  const fetchByokRuntime = useByokRuntimeStore((state) => state.fetchRuntime);
  const label = TOOL_LABELS[activeTool];
  const hdSummary = activeTool === 'hd'
    ? `${String(config.scale || 2)}x / ${config.interpolate60fps ? '60fps' : '24fps'} / ${formatHdValue(Number(config.detailStrength ?? 0.58))} / ${formatHdValue(Number(config.sharpen ?? 0.36))}`
    : '';
  const selectedSceneEngineHelp = PARSE_SCENE_ENGINE_HELP[String(config.sceneEngine || 'auto')] || PARSE_SCENE_ENGINE_HELP.auto;
  const selectedSemanticEngineHelp = PARSE_SEMANTIC_ENGINE_HELP[String(config.semanticEngine || 'auto')] || PARSE_SEMANTIC_ENGINE_HELP.auto;
  const selectedSubtitleEngineHelp = SUBTITLE_ENGINE_HELP[String(config.subtitleEngine || 'auto')] || SUBTITLE_ENGINE_HELP.auto;
  const selectedAudioSplitHelp = AUDIO_SPLIT_MODEL_HELP[String(config.stemModel || 'Demucs-v4')] || AUDIO_SPLIT_MODEL_HELP['Demucs-v4'];
  const semanticEngineOptions = useMemo(
    () => getVideoSemanticEngineOptions(byokRuntime),
    [byokRuntime],
  );
  const semanticEngineGroups = useMemo(
    () => ANALYSIS_ENGINE_GROUPS.map((group) => ({
      ...group,
      options: semanticEngineOptions.filter((option) => option.group === group.key),
    })).filter((group) => group.options.length > 0),
    [semanticEngineOptions],
  );
  const selectedSemanticEngineOption = useMemo(
    () => findAnalysisEngineOption(semanticEngineOptions, String(config.semanticEngine || 'auto')),
    [config.semanticEngine, semanticEngineOptions],
  );
  useEffect(() => {
    void fetchByokRuntime();
  }, [fetchByokRuntime]);

  // 解析面板采用与图片节点一致的交互：点击解析按钮后，面板并排出现在视频节点右侧，
  // 而非在节点下方展开，避免拥挤/遮挡。其余工具仍保持在节点下方展开。
  const isParseTool = activeTool === 'parse';

  return (
    <div
      className={
        isParseTool
          ? 'absolute left-full top-0 z-30 ml-3 w-[min(90vw,360px)]'
          : 'absolute left-1/2 top-full z-30 mt-4 w-[min(96vw,860px)] -translate-x-1/2'
      }
      {...panelInteractionProps}
      onPointerDown={panelInteractionProps.onPointerDown || onPanelInteract}
      onMouseDown={panelInteractionProps.onMouseDown || onPanelInteract}
      onTouchStart={panelInteractionProps.onTouchStart || onPanelInteract}
      onWheel={panelInteractionProps.onWheel || onPanelInteract}
    >
      <div
        data-testid={`video-tool-panel-${nodeId}`}
        className="nodrag nopan nowheel max-h-[72vh] w-full overflow-y-auto rounded-2xl border border-[#424242] bg-[#202020]/96 p-4 shadow-2xl backdrop-blur"
        style={{ transform: `scale(${viewportScale})`, transformOrigin: isParseTool ? 'top left' : 'top center' }}
      >
        <div className="mb-3 flex flex-col gap-3">
        <div>
          <div className="text-sm font-semibold text-[#f4f4f4]">{label}工具面板</div>
          <div className="mt-1 text-xs leading-5 text-[#9ee6d9]">{TOOL_FEEDBACK[activeTool]}</div>
          {activeTool === 'hd' ? (
            <div className="mt-2 inline-flex rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1 text-[11px] font-medium text-cyan-100" data-testid={`video-hd-summary-${nodeId}`}>
              {hdSummary}
            </div>
          ) : null}
        </div>
        </div>

        {activeTool === 'clip' ? (
          <div className="grid gap-3 text-xs text-[#d8d8d8]">
          <div className="grid grid-cols-2 gap-2">
            <label className="grid gap-1">
              <span>剪辑起点</span>
              <input data-testid={`video-clip-start-panel-${nodeId}`} type="number" min={0} max={selectedDuration} step={0.1} value={Number(config.startTime || 0)} onChange={(event) => onToolConfigChange({ tool: 'clip', startTime: Number(event.target.value) || 0 })} className="rounded-md border border-[#444] bg-[#1a1a1a] px-2 py-1 outline-none" />
            </label>
            <label className="grid gap-1">
              <span>剪辑终点</span>
              <input data-testid={`video-clip-end-panel-${nodeId}`} type="number" min={0.1} max={selectedDuration} step={0.1} value={Number(config.endTime || selectedDuration)} onChange={(event) => onToolConfigChange({ tool: 'clip', endTime: Number(event.target.value) || selectedDuration })} className="rounded-md border border-[#444] bg-[#1a1a1a] px-2 py-1 outline-none" />
            </label>
          </div>
          <input type="range" min={0} max={selectedDuration} step={0.1} value={Number(config.startTime || 0)} onChange={(event) => onToolConfigChange({ tool: 'clip', startTime: Number(event.target.value) })} />
          </div>
        ) : null}

        {activeTool === 'crop' ? (
          <div className="grid gap-3 text-xs text-[#d8d8d8]">
          <div className="grid grid-cols-4 gap-2">
            <RangeNumber label="X" testId={`video-crop-x-panel-${nodeId}`} value={Number(config.x ?? 8)} min={0} max={95} onChange={(value) => onToolConfigChange({ tool: 'crop', x: value })} />
            <RangeNumber label="Y" testId={`video-crop-y-panel-${nodeId}`} value={Number(config.y ?? 8)} min={0} max={95} onChange={(value) => onToolConfigChange({ tool: 'crop', y: value })} />
            <RangeNumber label="宽度" testId={`video-crop-width-panel-${nodeId}`} value={Number(config.widthPercent ?? 84)} min={5} max={100} onChange={(value) => onToolConfigChange({ tool: 'crop', widthPercent: value })} />
            <RangeNumber label="高度" testId={`video-crop-height-panel-${nodeId}`} value={Number(config.heightPercent ?? 72)} min={5} max={100} onChange={(value) => onToolConfigChange({ tool: 'crop', heightPercent: value })} />
          </div>
          <div className="rounded-lg border border-[#3d3d3d] bg-[#181818] px-3 py-2 text-[#a9a9a9]">裁剪框已实时显示在视频预览区，生成或处理时会作为像素裁剪参数提交。</div>
          </div>
        ) : null}

        {activeTool === 'hd' ? (
          <div className="grid grid-cols-2 gap-2 text-xs text-[#d8d8d8]">
          <label className="grid gap-1">
            <span>超分倍率</span>
            <select data-testid={`video-hd-scale-panel-${nodeId}`} value={String(config.scale || 2)} onChange={(event) => onToolConfigChange({ tool: 'hd', scale: Number(event.target.value) })} className="rounded-md border border-[#444] bg-[#1a1a1a] px-2 py-1 outline-none">
              <option value="2">2x</option>
              <option value="4">4x</option>
            </select>
          </label>
          <label className="grid gap-1">
            <span>帧率</span>
            <select data-testid={`video-hd-fps-panel-${nodeId}`} value={String(config.interpolate60fps ? '60' : '24')} onChange={(event) => onToolConfigChange({ tool: 'hd', interpolate60fps: event.target.value === '60' })} className="rounded-md border border-[#444] bg-[#1a1a1a] px-2 py-1 outline-none">
              <option value="24">24fps</option>
              <option value="60">60fps</option>
            </select>
          </label>
          <RangeNumber label="细节增强" testId={`video-hd-detail-panel-${nodeId}`} value={Number(config.detailStrength ?? 0.58)} min={0} max={1} step={0.01} onChange={(value) => onToolConfigChange({ tool: 'hd', detailStrength: value })} />
          <RangeNumber label="锐化" testId={`video-hd-sharpen-panel-${nodeId}`} value={Number(config.sharpen ?? 0.36)} min={0} max={1} step={0.01} onChange={(value) => onToolConfigChange({ tool: 'hd', sharpen: value })} />
          </div>
        ) : null}

        {activeTool === 'parse' ? (
          <div className="grid gap-3 text-xs text-[#d8d8d8]">
          <div className="grid grid-cols-2 gap-2">
            <ToggleRow label="场景检测" checked={Boolean(config.sceneDetect)} onChange={(checked) => onToolConfigChange({ tool: 'parse', sceneDetect: checked })} />
            <ToggleRow label="反推镜头语言" checked={Boolean(config.cameraLanguage ?? true)} onChange={(checked) => onToolConfigChange({ tool: 'parse', cameraLanguage: checked })} />
            <RangeNumber label="抽样 FPS" testId={`video-parse-fps-panel-${nodeId}`} value={Number(config.sampleFps ?? 2)} min={1} max={10} step={1} onChange={(value) => onToolConfigChange({ tool: 'parse', sampleFps: value })} />
            <label className="grid gap-1">
              <ToolModelLabel label="镜头切分引擎" help={selectedSceneEngineHelp} />
              <select data-testid={`video-parse-scene-engine-panel-${nodeId}`} value={String(config.sceneEngine || 'auto')} title={`${selectedSceneEngineHelp.label}：${selectedSceneEngineHelp.role}`} onChange={(event) => onToolConfigChange({ tool: 'parse', sceneEngine: event.target.value })} className="rounded-md border border-[#444] bg-[#1a1a1a] px-2 py-1 outline-none">
                <option value="auto" title="根据本机能力自动选择镜头切分方案。">自动</option>
                <option value="scenedetect" title={`${PARSE_SCENE_ENGINE_HELP.scenedetect.role}`}>PySceneDetect</option>
                <option value="transnetv2" title={`${PARSE_SCENE_ENGINE_HELP.transnetv2.role}`}>TransNetV2（已安装时）</option>
              </select>
            </label>
            <label className="grid gap-1">
              <ToolModelLabel label="视频分析模型" help={selectedSemanticEngineHelp} />
              <select data-testid={`video-parse-semantic-engine-panel-${nodeId}`} value={String(config.semanticEngine || 'auto')} title={`${selectedSemanticEngineOption.label}：${selectedSemanticEngineOption.hint}`} onChange={(event) => onToolConfigChange({ tool: 'parse', semanticEngine: event.target.value })} className="rounded-md border border-[#444] bg-[#1a1a1a] px-2 py-1 outline-none">
                {semanticEngineGroups.map((group) => (
                  <optgroup key={group.key} label={group.label}>
                    {group.options.map((option) => (
                      <option key={option.value} value={option.value} title={option.hint}>{option.label}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <div className="flex flex-wrap items-center gap-2">
                {selectedSemanticEngineOption.badge ? (
                  <SourceBadge label={selectedSemanticEngineOption.badge} tone={selectedSemanticEngineOption.tone} />
                ) : null}
                {selectedSemanticEngineOption.runtimeBadge ? (
                  <SourceBadge label={selectedSemanticEngineOption.runtimeBadge} tone="relay" />
                ) : null}
                {!selectedSemanticEngineOption.runtimeBadge && String(config.semanticEngine || 'auto') === 'custom-api' ? (
                  <SourceBadge label="待激活" tone="neutral" />
                ) : null}
              </div>
            </label>
          </div>
          </div>
        ) : null}

        {activeTool === 'removeSubtitle' ? (
          <div className="grid gap-3 text-xs text-[#d8d8d8]">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <label className="grid gap-1">
              <ToolModelLabel label="去字幕引擎" help={selectedSubtitleEngineHelp} />
              <select value={String(config.subtitleEngine || 'auto')} title={`${selectedSubtitleEngineHelp.label}：${selectedSubtitleEngineHelp.role} 优势：${selectedSubtitleEngineHelp.advantage}`} onChange={(event) => onToolConfigChange({ tool: 'removeSubtitle', subtitleEngine: event.target.value })} className="rounded-md border border-[#444] bg-[#1a1a1a] px-2 py-1 outline-none">
                <option value="auto">自动</option>
                <option value="opencv-telea">OpenCV Telea</option>
                <option value="video-subtitle-remover">video-subtitle-remover（已安装时）</option>
                <option value="propainter">ProPainter（已安装时）</option>
              </select>
              <ToolModelHint help={selectedSubtitleEngineHelp} testId={`video-remove-engine-help-${nodeId}`} />
            </label>
            <label className="grid gap-1">
              <span>识别模式</span>
              <select data-testid={`video-remove-mode-panel-${nodeId}`} value={String(config.detectionMode || 'auto')} onChange={(event) => onToolConfigChange({ tool: 'removeSubtitle', detectionMode: event.target.value })} className="rounded-md border border-[#444] bg-[#1a1a1a] px-2 py-1 outline-none">
                <option value="auto">自动识别</option>
                <option value="manual">手动区域</option>
              </select>
            </label>
            <RangeNumber label="蒙版羽化" testId={`video-remove-feather-panel-${nodeId}`} value={Number(config.maskFeather ?? 8)} min={0} max={32} step={1} onChange={(value) => onToolConfigChange({ tool: 'removeSubtitle', maskFeather: value })} />
            <ToggleRow label="时间一致性" checked={Boolean(config.temporalConsistency ?? true)} onChange={(checked) => onToolConfigChange({ tool: 'removeSubtitle', temporalConsistency: checked })} />
            {String(config.detectionMode || 'auto') === 'manual' ? (
              <>
                <RangeNumber label="区域 X" testId={`video-remove-region-x-panel-${nodeId}`} value={Number(config.regionX ?? 12)} min={0} max={95} step={1} onChange={(value) => onToolConfigChange({ tool: 'removeSubtitle', regionX: value })} />
                <RangeNumber label="区域 Y" testId={`video-remove-region-y-panel-${nodeId}`} value={Number(config.regionY ?? 80)} min={0} max={95} step={1} onChange={(value) => onToolConfigChange({ tool: 'removeSubtitle', regionY: value })} />
                <RangeNumber label="区域宽度" testId={`video-remove-region-width-panel-${nodeId}`} value={Number(config.regionWidth ?? 76)} min={4} max={100} step={1} onChange={(value) => onToolConfigChange({ tool: 'removeSubtitle', regionWidth: value })} />
                <RangeNumber label="区域高度" testId={`video-remove-region-height-panel-${nodeId}`} value={Number(config.regionHeight ?? 12)} min={4} max={100} step={1} onChange={(value) => onToolConfigChange({ tool: 'removeSubtitle', regionHeight: value })} />
              </>
            ) : null}
          </div>
          <div className="rounded-lg border border-[#3d3d3d] bg-[#181818] px-3 py-2 text-[#a9a9a9]">
            若未安装 `video-subtitle-remover` 或 `ProPainter`，系统会立即回退到 OpenCV / FFmpeg 本地链路，不会卡住界面。
          </div>
          </div>
        ) : null}

        {activeTool === 'audioSplit' ? (
          <div className="grid gap-3 text-xs text-[#d8d8d8]">
          <div className="grid grid-cols-2 gap-2">
            <label className="grid gap-1">
              <ToolModelLabel label="分离模型" help={selectedAudioSplitHelp} />
              <select data-testid={`video-audio-model-panel-${nodeId}`} value={String(config.stemModel || 'Demucs-v4')} title={`${selectedAudioSplitHelp.label}：${selectedAudioSplitHelp.role} 优势：${selectedAudioSplitHelp.advantage}`} onChange={(event) => onToolConfigChange({ tool: 'audioSplit', stemModel: event.target.value })} className="rounded-md border border-[#444] bg-[#1a1a1a] px-2 py-1 outline-none">
                <option value="Demucs-v4">Demucs-v4</option>
                <option value="UVR5-MDX-Net">UVR5-MDX-Net</option>
                <option value="MDX23C">MDX23C</option>
              </select>
              <ToolModelHint help={selectedAudioSplitHelp} testId={`video-audio-model-help-${nodeId}`} />
            </label>
            <ToggleRow label="保留人声到视频" checked={Boolean(config.keepVocalInVideo)} onChange={(checked) => onToolConfigChange({ tool: 'audioSplit', keepVocalInVideo: checked })} />
            <ToggleRow label="导出到工作流" checked={Boolean(config.exportToWorkflow ?? true)} onChange={(checked) => onToolConfigChange({ tool: 'audioSplit', exportToWorkflow: checked })} />
          </div>
          <div className="rounded-lg border border-[#3d3d3d] bg-[#181818] px-3 py-2 text-[#a9a9a9]">
            当前默认优先使用 Demucs 做免费本地分离；若后续补装 UVR5 / MDX23C，可继续扩成更细的人声、伴奏和噪声分支。
          </div>
          </div>
        ) : null}

        <div className="mt-4 flex w-full flex-wrap items-center justify-end gap-2 border-t border-white/10 pt-3">
          <button type="button" onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2 text-xs text-[#bdbdbd] hover:bg-[#333] hover:text-white">
            取消
          </button>
          <button type="button" onClick={onApply} data-testid={`video-tool-apply-${nodeId}`} className="rounded-xl bg-white px-4 py-2 text-xs font-semibold text-[#111] hover:bg-[#f1f1f1]">
            应用到当前节点
          </button>
        </div>
      </div>
    </div>
  );
}

function VideoToolPreviewOverlay({
  nodeId,
  activeTool,
  config,
  selectedDuration,
  videoMeta,
  cropEditing,
  subtitleEditing,
  onCropConfigChange,
  onSubtitleConfigChange,
  onCropConfirm,
  onCropCancel,
  panelInteractionProps,
  onPanelInteract,
}: {
  nodeId: string;
  activeTool: VideoTool | null;
  config: Record<string, unknown>;
  selectedDuration: number;
  videoMeta: VideoMeta | null;
  cropEditing: boolean;
  subtitleEditing: boolean;
  onCropConfigChange: (patch: Record<string, unknown>) => void;
  onSubtitleConfigChange: (patch: Record<string, unknown>) => void;
  onCropConfirm: () => void;
  onCropCancel: () => void;
  panelInteractionProps: GuardedPanelInteractionProps;
  onPanelInteract: (event: { stopPropagation: () => void }) => void;
}) {
  if (!activeTool) return null;
  const label = TOOL_LABELS[activeTool];
  const cropRect = getVideoCropRect(config);
  const subtitleRect = getSubtitleRegionRect(config);
  const clipStart = clampNumber(config.startTime ?? 0, 0, selectedDuration, 0);
  const clipEnd = clampNumber(config.endTime ?? selectedDuration, 0, selectedDuration, selectedDuration);
  const clipLeft = selectedDuration > 0 ? (Math.min(clipStart, clipEnd) / selectedDuration) * 100 : 0;
  const clipWidth = selectedDuration > 0 ? (Math.abs(clipEnd - clipStart) / selectedDuration) * 100 : 100;

  return (
    <div className={`absolute inset-0 z-20 ${cropEditing || subtitleEditing ? 'pointer-events-auto' : 'pointer-events-none'}`}>
      {activeTool !== 'parse' ? (
        <div className="absolute left-3 top-3 rounded-full bg-black/70 px-3 py-1 text-[11px] font-semibold text-[#9ee6d9] ring-1 ring-white/10">
          {label}已激活
        </div>
      ) : null}
      {activeTool === 'crop' ? (
        cropEditing ? (
          <VideoCropInteractiveOverlay
            nodeId={nodeId}
            rect={cropRect}
            videoMeta={videoMeta}
            onChange={(nextRect) => onCropConfigChange({ tool: 'crop', x: nextRect.x, y: nextRect.y, widthPercent: nextRect.width, heightPercent: nextRect.height })}
            onConfirm={onCropConfirm}
            onCancel={onCropCancel}
            panelInteractionProps={panelInteractionProps}
            onPanelInteract={onPanelInteract}
          />
        ) : (
          <>
            <div className="absolute inset-x-0 bottom-3 flex justify-center px-4">
              <div
                data-testid={`video-crop-applied-${nodeId}`}
                className="rounded-2xl bg-[#171717]/92 px-4 py-2 text-[11px] font-medium text-white shadow-2xl ring-1 ring-white/10 backdrop-blur"
              >
                {(() => {
                  const pixelSize = getCropPixelSize(cropRect, videoMeta);
                  const sizeText = pixelSize.width > 0 && pixelSize.height > 0 ? `${pixelSize.width} × ${pixelSize.height}` : `${Math.round(cropRect.width)}% × ${Math.round(cropRect.height)}%`;
                  return `已应用裁剪预览：${sizeText}，重新点击“裁剪”可继续微调`;
                })()}
              </div>
            </div>
          </>
        )
      ) : null}
      {activeTool === 'clip' ? (
        <div className="absolute bottom-5 left-5 right-5 h-2 rounded-full bg-white/20">
          <div className="h-full rounded-full bg-[#9ee6d9]" style={{ marginLeft: `${clipLeft}%`, width: `${Math.max(3, clipWidth)}%` }} />
        </div>
      ) : null}
      {activeTool === 'hd' ? (
        <div className="absolute bottom-5 left-5 rounded-xl bg-black/65 px-3 py-2 text-[11px] text-white ring-1 ring-white/10">
          高清预览：{String(config.scale || 2)}x / {config.interpolate60fps ? '60fps' : '24fps'} / 细节 {Number(config.detailStrength ?? 0.58).toFixed(2)}
        </div>
      ) : null}
      {activeTool === 'parse' ? (
        <div className="absolute bottom-5 left-5 right-5 flex items-end gap-2">
          {[18, 35, 52, 70, 86].map((left, index) => <span key={index} className="h-9 w-0.5 rounded-full bg-emerald-200/80" style={{ marginLeft: index === 0 ? `${left}%` : 0 }} />)}
        </div>
      ) : null}
      {activeTool === 'removeSubtitle' ? (
        subtitleEditing ? (
          <VideoSubtitleMaskOverlay
            nodeId={nodeId}
            rect={subtitleRect}
            videoMeta={videoMeta}
            onChange={(nextRect) => onSubtitleConfigChange({
              tool: 'removeSubtitle',
              regionX: nextRect.x,
              regionY: nextRect.y,
              regionWidth: nextRect.width,
              regionHeight: nextRect.height,
            })}
            panelInteractionProps={panelInteractionProps}
            onPanelInteract={onPanelInteract}
          />
        ) : (
          <div
            data-testid={`video-remove-mask-${nodeId}`}
            className="absolute rounded-xl border border-rose-200/80 bg-rose-400/18 shadow-[0_0_18px_rgba(251,113,133,0.35)]"
            style={{ left: `${subtitleRect.x}%`, top: `${subtitleRect.y}%`, width: `${subtitleRect.width}%`, height: `${subtitleRect.height}%` }}
          >
            <div className="flex h-full items-center justify-center text-[11px] font-semibold text-rose-100">字幕 / 水印处理区域</div>
          </div>
        )
      ) : null}
      {activeTool === 'audioSplit' ? (
        <div className="absolute bottom-5 left-5 right-5 flex h-10 items-end gap-1 rounded-lg bg-black/45 px-3 py-2">
          {Array.from({ length: 28 }).map((_, index) => <span key={index} className="w-1 flex-1 rounded-full bg-[#9ee6d9]/80" style={{ height: `${24 + ((index * 17) % 58)}%` }} />)}
        </div>
      ) : null}
    </div>
  );
}

function getVideoCropRect(config: Record<string, unknown>): CropRect {
  const x = clampNumber(config.x ?? 8, 0, 95, 8);
  const y = clampNumber(config.y ?? 8, 0, 95, 8);
  const width = clampNumber(config.widthPercent ?? 84, 5, 100 - x, 84);
  const height = clampNumber(config.heightPercent ?? 72, 5, 100 - y, 72);
  return { x, y, width, height };
}

function clampCropRect(rect: CropRect): CropRect {
  const x = clampNumber(rect.x, 0, 95, 8);
  const y = clampNumber(rect.y, 0, 95, 8);
  const width = clampNumber(rect.width, 5, 100 - x, 84);
  const height = clampNumber(rect.height, 5, 100 - y, 72);
  return { x, y, width, height };
}

function getCropPixelSize(rect: CropRect, videoMeta: VideoMeta | null) {
  const widthBase = videoMeta?.width || 0;
  const heightBase = videoMeta?.height || 0;
  return {
    width: widthBase > 0 ? Math.max(1, Math.round((rect.width / 100) * widthBase)) : 0,
    height: heightBase > 0 ? Math.max(1, Math.round((rect.height / 100) * heightBase)) : 0,
  };
}

function getSubtitleRegionRect(config: Record<string, unknown>): CropRect {
  const x = clampNumber(config.regionX ?? 12, 0, 95, 12);
  const y = clampNumber(config.regionY ?? 80, 0, 95, 80);
  const width = clampNumber(config.regionWidth ?? 76, 4, 100 - x, 76);
  const height = clampNumber(config.regionHeight ?? 12, 4, 100 - y, 12);
  return { x, y, width, height };
}

function getVideoCropPreviewLayout(displaySize: { width: number; height: number }, rect: CropRect | null, videoMeta: VideoMeta | null) {
  const fullViewport: CSSProperties = { inset: 0 };
  const fullVideo: CSSProperties = { inset: 0, width: '100%', height: '100%', objectFit: 'cover' };
  if (!rect) {
    return {
      viewportStyle: fullViewport,
      videoStyle: fullVideo,
    };
  }

  const cropWidthRatio = Math.max(0.05, rect.width / 100);
  const cropHeightRatio = Math.max(0.05, rect.height / 100);
  const containerWidth = Math.max(1, displaySize.width);
  const containerHeight = Math.max(1, displaySize.height);
  const sourceAspect = videoMeta && videoMeta.width > 0 && videoMeta.height > 0
    ? videoMeta.width / videoMeta.height
    : containerWidth / containerHeight;
  const cropAspect = sourceAspect * (cropWidthRatio / cropHeightRatio);
  const containerAspect = containerWidth / containerHeight;

  let viewportWidth = containerWidth;
  let viewportHeight = containerHeight;
  if (cropAspect > containerAspect) {
    viewportHeight = containerWidth / cropAspect;
  } else {
    viewportWidth = containerHeight * cropAspect;
  }

  return {
    viewportStyle: {
      left: (containerWidth - viewportWidth) / 2,
      top: (containerHeight - viewportHeight) / 2,
      width: viewportWidth,
      height: viewportHeight,
    },
    videoStyle: {
      left: `${-(rect.x / cropWidthRatio) * 100}%`,
      top: `${-(rect.y / cropHeightRatio) * 100}%`,
      width: `${100 / cropWidthRatio}%`,
      height: `${100 / cropHeightRatio}%`,
    },
  };
}

function VideoCropInteractiveOverlay({
  nodeId,
  rect,
  videoMeta,
  onChange,
  onConfirm,
  onCancel,
  panelInteractionProps,
  onPanelInteract,
}: {
  nodeId: string;
  rect: CropRect;
  videoMeta: VideoMeta | null;
  onChange: (nextRect: CropRect) => void;
  onConfirm: () => void;
  onCancel: () => void;
  panelInteractionProps: GuardedPanelInteractionProps;
  onPanelInteract: (event: { stopPropagation: () => void }) => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<{
    pointerId: number;
    handle: CropResizeHandle;
    startX: number;
    startY: number;
    startRect: CropRect;
  } | null>(null);
  const pixelSize = useMemo(() => getCropPixelSize(rect, videoMeta), [rect, videoMeta]);

  function beginDrag(handle: CropResizeHandle, event: ReactPointerEvent<HTMLDivElement>) {
    onPanelInteract(event);
    dragStateRef.current = {
      pointerId: event.pointerId,
      handle,
      startX: event.clientX,
      startY: event.clientY,
      startRect: rect,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function updateDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const dragState = dragStateRef.current;
    const overlay = overlayRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId || !overlay) return;
    onPanelInteract(event);
    const bounds = overlay.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const deltaX = ((event.clientX - dragState.startX) / bounds.width) * 100;
    const deltaY = ((event.clientY - dragState.startY) / bounds.height) * 100;
    const nextRect = { ...dragState.startRect };

    if (dragState.handle === 'move') {
      nextRect.x = dragState.startRect.x + deltaX;
      nextRect.y = dragState.startRect.y + deltaY;
    } else {
      if (dragState.handle.includes('w')) {
        nextRect.x = dragState.startRect.x + deltaX;
        nextRect.width = dragState.startRect.width - deltaX;
      }
      if (dragState.handle.includes('e')) {
        nextRect.width = dragState.startRect.width + deltaX;
      }
      if (dragState.handle.includes('n')) {
        nextRect.y = dragState.startRect.y + deltaY;
        nextRect.height = dragState.startRect.height - deltaY;
      }
      if (dragState.handle.includes('s')) {
        nextRect.height = dragState.startRect.height + deltaY;
      }
    }

    onChange(clampCropRect(nextRect));
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    onPanelInteract(event);
    dragStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <div
      ref={overlayRef}
      data-testid={`video-crop-editor-${nodeId}`}
      className="nodrag nopan nowheel absolute inset-0"
      {...panelInteractionProps}
      onPointerDown={panelInteractionProps.onPointerDown || onPanelInteract}
      onMouseDown={panelInteractionProps.onMouseDown || onPanelInteract}
      onTouchStart={panelInteractionProps.onTouchStart || onPanelInteract}
      onWheel={panelInteractionProps.onWheel || onPanelInteract}
    >
      <div className="absolute inset-0 bg-black/38" />
      <div className="pointer-events-none absolute left-3 top-12 rounded-lg bg-black/78 px-3 py-1.5 text-[11px] font-medium text-white ring-1 ring-white/10">
        {pixelSize.width > 0 && pixelSize.height > 0 ? `${pixelSize.width} × ${pixelSize.height}` : `${Math.round(rect.width)}% × ${Math.round(rect.height)}%`}
      </div>
      <div
        data-testid={`video-crop-box-${nodeId}`}
        className="absolute border-2 border-cyan-200 bg-cyan-300/10 shadow-[0_0_24px_rgba(125,211,252,0.45)]"
        style={{ left: `${rect.x}%`, top: `${rect.y}%`, width: `${rect.width}%`, height: `${rect.height}%` }}
      >
        <div
          className="absolute inset-0 z-10 cursor-move"
          onPointerDown={(event) => beginDrag('move', event)}
          onPointerMove={updateDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
        <div className="pointer-events-none grid h-full w-full grid-cols-3 grid-rows-3">
          {Array.from({ length: 9 }).map((_, index) => <div key={index} className="border border-white/25" />)}
        </div>
        {([
          { handle: 'nw', className: '-left-2 -top-2 cursor-nwse-resize' },
          { handle: 'ne', className: '-right-2 -top-2 cursor-nesw-resize' },
          { handle: 'sw', className: '-left-2 -bottom-2 cursor-nesw-resize' },
          { handle: 'se', className: '-right-2 -bottom-2 cursor-nwse-resize' },
          { handle: 'n', className: 'left-1/2 -top-2 -translate-x-1/2 cursor-ns-resize' },
          { handle: 's', className: 'left-1/2 -bottom-2 -translate-x-1/2 cursor-ns-resize' },
          { handle: 'w', className: '-left-2 top-1/2 -translate-y-1/2 cursor-ew-resize' },
          { handle: 'e', className: '-right-2 top-1/2 -translate-y-1/2 cursor-ew-resize' },
        ] as Array<{ handle: CropResizeHandle; className: string }>).map((item) => (
          <div
            key={item.handle}
            data-testid={`video-crop-handle-${nodeId}-${item.handle}`}
            className={`absolute z-20 h-4 w-4 rounded-full border-2 border-white bg-cyan-300 shadow-[0_0_12px_rgba(34,211,238,0.6)] ${item.className}`}
            onPointerDown={(event) => beginDrag(item.handle, event)}
            onPointerMove={updateDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          />
        ))}
      </div>
      <div className="absolute inset-x-0 bottom-3 flex justify-center px-4">
        <div className="flex min-w-[280px] items-center justify-between gap-3 rounded-2xl bg-[#171717]/95 px-4 py-3 text-white shadow-2xl ring-1 ring-white/10 backdrop-blur">
          <div className="text-sm font-medium">{pixelSize.width > 0 && pixelSize.height > 0 ? `${pixelSize.width} × ${pixelSize.height}` : `${Math.round(rect.width)}% × ${Math.round(rect.height)}%`}</div>
          <div className="flex items-center gap-2">
            <button type="button" data-testid={`video-crop-cancel-${nodeId}`} className="rounded-xl border border-white/12 px-3 py-1.5 text-xs text-[#d6d6d6] hover:bg-white/10" onClick={onCancel}>
              取消
            </button>
            <button type="button" data-testid={`video-crop-confirm-${nodeId}`} className="rounded-xl bg-white px-3 py-1.5 text-xs font-semibold text-[#111] hover:bg-[#f1f1f1]" onClick={onConfirm}>
              确认裁剪
            </button>
          </div>
        </div>
      </div>
      <div className="pointer-events-none absolute bottom-20 left-1/2 -translate-x-1/2 rounded-full bg-black/55 px-3 py-1 text-[11px] text-[#ececec]">
        拖动画面内裁剪框或四边控制点，直接调整输出区域
      </div>
    </div>
  );
}

function VideoSubtitleMaskOverlay({
  nodeId,
  rect,
  videoMeta,
  onChange,
  panelInteractionProps,
  onPanelInteract,
}: {
  nodeId: string;
  rect: CropRect;
  videoMeta: VideoMeta | null;
  onChange: (nextRect: CropRect) => void;
  panelInteractionProps: GuardedPanelInteractionProps;
  onPanelInteract: (event: { stopPropagation: () => void }) => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<{
    pointerId: number;
    handle: CropResizeHandle;
    startX: number;
    startY: number;
    startRect: CropRect;
  } | null>(null);
  const pixelSize = useMemo(() => getCropPixelSize(rect, videoMeta), [rect, videoMeta]);

  function beginDrag(handle: CropResizeHandle, event: ReactPointerEvent<HTMLDivElement>) {
    onPanelInteract(event);
    dragStateRef.current = {
      pointerId: event.pointerId,
      handle,
      startX: event.clientX,
      startY: event.clientY,
      startRect: rect,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function updateDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const dragState = dragStateRef.current;
    const overlay = overlayRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId || !overlay) return;
    onPanelInteract(event);
    const bounds = overlay.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const deltaX = ((event.clientX - dragState.startX) / bounds.width) * 100;
    const deltaY = ((event.clientY - dragState.startY) / bounds.height) * 100;
    const nextRect = { ...dragState.startRect };

    if (dragState.handle === 'move') {
      nextRect.x = dragState.startRect.x + deltaX;
      nextRect.y = dragState.startRect.y + deltaY;
    } else {
      if (dragState.handle.includes('w')) {
        nextRect.x = dragState.startRect.x + deltaX;
        nextRect.width = dragState.startRect.width - deltaX;
      }
      if (dragState.handle.includes('e')) {
        nextRect.width = dragState.startRect.width + deltaX;
      }
      if (dragState.handle.includes('n')) {
        nextRect.y = dragState.startRect.y + deltaY;
        nextRect.height = dragState.startRect.height - deltaY;
      }
      if (dragState.handle.includes('s')) {
        nextRect.height = dragState.startRect.height + deltaY;
      }
    }

    onChange(clampCropRect(nextRect));
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    onPanelInteract(event);
    dragStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <div
      ref={overlayRef}
      data-testid={`video-remove-editor-${nodeId}`}
      className="nodrag nopan nowheel absolute inset-0"
      {...panelInteractionProps}
      onPointerDown={panelInteractionProps.onPointerDown || onPanelInteract}
      onMouseDown={panelInteractionProps.onMouseDown || onPanelInteract}
      onTouchStart={panelInteractionProps.onTouchStart || onPanelInteract}
      onWheel={panelInteractionProps.onWheel || onPanelInteract}
    >
      <div
        data-testid={`video-remove-box-${nodeId}`}
        className="absolute border-2 border-rose-200 bg-rose-400/14 shadow-[0_0_22px_rgba(244,63,94,0.35)]"
        style={{ left: `${rect.x}%`, top: `${rect.y}%`, width: `${rect.width}%`, height: `${rect.height}%` }}
      >
        <div
          className="absolute inset-0 z-10 cursor-move"
          onPointerDown={(event) => beginDrag('move', event)}
          onPointerMove={updateDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,0.12)_1px,transparent_1px),linear-gradient(rgba(255,255,255,0.12)_1px,transparent_1px)] bg-[size:33.33%_33.33%]" />
        {([
          { handle: 'nw', className: '-left-2 -top-2 cursor-nwse-resize' },
          { handle: 'ne', className: '-right-2 -top-2 cursor-nesw-resize' },
          { handle: 'sw', className: '-left-2 -bottom-2 cursor-nesw-resize' },
          { handle: 'se', className: '-right-2 -bottom-2 cursor-nwse-resize' },
          { handle: 'n', className: 'left-1/2 -top-2 -translate-x-1/2 cursor-ns-resize' },
          { handle: 's', className: 'left-1/2 -bottom-2 -translate-x-1/2 cursor-ns-resize' },
          { handle: 'w', className: '-left-2 top-1/2 -translate-y-1/2 cursor-ew-resize' },
          { handle: 'e', className: '-right-2 top-1/2 -translate-y-1/2 cursor-ew-resize' },
        ] as Array<{ handle: CropResizeHandle; className: string }>).map((item) => (
          <div
            key={item.handle}
            data-testid={`video-remove-handle-${nodeId}-${item.handle}`}
            className={`absolute z-20 h-4 w-4 rounded-full border-2 border-white bg-rose-300 shadow-[0_0_12px_rgba(251,113,133,0.55)] ${item.className}`}
            onPointerDown={(event) => beginDrag(item.handle, event)}
            onPointerMove={updateDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          />
        ))}
      </div>
      <div className="pointer-events-none absolute left-3 top-12 rounded-lg bg-black/78 px-3 py-1.5 text-[11px] font-medium text-white ring-1 ring-white/10">
        {pixelSize.width > 0 && pixelSize.height > 0 ? `处理区域 ${pixelSize.width} × ${pixelSize.height}` : `${Math.round(rect.width)}% × ${Math.round(rect.height)}%`}
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-4">
        <div className="rounded-2xl bg-[#171717]/95 px-4 py-2 text-[11px] text-white shadow-2xl ring-1 ring-white/10 backdrop-blur">
          拖动红色框选择字幕 / 水印区域，完成后点击面板里的“应用到当前节点”
        </div>
      </div>
    </div>
  );
}

function RangeNumber({ label, testId, value, min, max, step = 1, onChange }: { label: string; testId: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void }) {
  return (
    <label className="grid gap-1">
      <span>{label}</span>
      <input data-testid={testId} type="range" min={min} max={max} step={step} value={Number.isFinite(value) ? value : min} onChange={(event) => onChange(Number(event.target.value))} />
      <input type="number" min={min} max={max} step={step} value={Number.isFinite(value) ? value : min} onChange={(event) => onChange(Number(event.target.value))} className="rounded-md border border-[#444] bg-[#1a1a1a] px-2 py-1 outline-none" />
    </label>
  );
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-center justify-between rounded-md border border-[#444] bg-[#1a1a1a] px-2 py-1">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function ToolbarButton({
  nodeId,
  tool,
  activeTool,
  onTool,
  icon,
}: {
  nodeId: string;
  tool: VideoTool;
  activeTool: VideoTool | null;
  onTool: (tool: VideoTool) => void;
  icon: ReactNode;
}) {
  const active = activeTool === tool;
  function activate(event: { preventDefault: () => void; stopPropagation: () => void }) {
    event.preventDefault();
    event.stopPropagation();
    onTool(tool);
  }
  return (
    <button
      type="button"
      aria-pressed={active}
      data-testid={`video-toolbar-${nodeId}-${tool}`}
      onPointerDown={activate}
      onClick={activate}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') activate(event);
      }}
      className={`nodrag flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-sm font-semibold transition-colors ${
        active ? 'bg-[#3e3e3e] text-white' : 'text-[#ececec] hover:bg-[#373737]'
      }`}
      title={TOOL_LABELS[tool]}
    >
      {icon}
      <span>{TOOL_LABELS[tool]}</span>
      <ChevronDown className="h-3.5 w-3.5 text-[#c8c8c8]" />
    </button>
  );
}

function IconToolButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onPointerDown={stopCanvasInteraction}
      onClick={onClick}
      className="nodrag flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[#eeeeee] transition-colors hover:bg-[#373737]"
      title={title}
    >
      {children}
    </button>
  );
}

function CompactActionButton({
  icon,
  label,
  onClick,
  testId,
  active = false,
}: {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  testId?: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onPointerDown={stopCanvasInteraction}
      onClick={onClick}
      data-testid={testId}
      className={`nodrag inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs transition-colors ${active ? 'border-[#5a7f79] bg-[#18302b] text-[#d8fff7]' : 'border-[#4a4a4a] bg-[#2f2f2f] text-[#d3d3d3] hover:bg-[#383838]'}`}
      title={label}
    >
      <span className="text-[#cfcfcf]">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

function ModeAssetShortcut({
  label,
  hint,
  onClick,
  testId,
}: {
  label: string;
  hint: string;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onPointerDown={stopCanvasInteraction}
      onClick={onClick}
      data-testid={testId}
      className="nodrag rounded-xl border border-dashed border-[#555] bg-[#262626] px-3 py-2 text-left hover:bg-[#303030]"
    >
      <div className="text-xs font-medium text-[#f0f0f0]">{label}</div>
      <div className="mt-1 text-[11px] text-[#a0a0a0]">{hint}</div>
    </button>
  );
}

function ActionChip({ title, onClick, icon }: { title: string; onClick: () => void; icon: ReactNode }) {
  return (
    <button
      type="button"
      onPointerDown={stopCanvasInteraction}
      onClick={onClick}
      className="nodrag flex h-8 items-center gap-1.5 rounded-lg bg-[#2f2f2f] px-3 text-sm font-semibold text-[#f0f0f0] shadow-lg ring-1 ring-[#444] hover:bg-[#3a3a3a]"
      title={title}
    >
      {icon}
      {title}
    </button>
  );
}

function AssetPicker({
  assets,
  onChoose,
  emptyText,
  panelInteractionProps,
  onInteract,
}: {
  assets: AssetItem[];
  onChoose: (asset: AssetItem) => void;
  emptyText: string;
  panelInteractionProps: GuardedPanelInteractionProps;
  onInteract: (event: { stopPropagation: () => void }) => void;
}) {
  return (
    <div
      className="absolute -top-[14px] left-1/2 z-50 max-h-[280px] w-[420px] -translate-x-1/2 translate-y-[58px] overflow-y-auto rounded-xl bg-[#242424] p-3 shadow-2xl ring-1 ring-[#4b4b4b]"
      {...panelInteractionProps}
      onPointerDown={panelInteractionProps.onPointerDown || onInteract}
      onMouseDown={panelInteractionProps.onMouseDown || onInteract}
      onTouchStart={panelInteractionProps.onTouchStart || onInteract}
      onWheel={panelInteractionProps.onWheel || onInteract}
    >
      <div className="mb-2 text-xs font-semibold text-[#d8d8d8]">选择素材</div>
      <div className="grid grid-cols-3 gap-2">
        {assets.length > 0 ? assets.map((asset) => (
          <button
            type="button"
            key={asset.id}
            onPointerDown={onInteract}
            onClick={() => onChoose(asset)}
            className="nodrag overflow-hidden rounded-lg bg-[#1b1b1b] text-left ring-1 ring-[#363636] hover:ring-[#888]"
            title={asset.name}
          >
            {asset.type === 'video' ? (
              <video src={toRenderableAssetUrl(asset.url, 'video')} className="h-20 w-full object-cover" muted playsInline preload="metadata" />
            ) : asset.thumbnail ? (
              <img src={toRenderableAssetUrl(asset.thumbnail, 'image')} alt="" className="h-20 w-full object-cover" />
            ) : (
              <div className="flex h-20 w-full items-center justify-center bg-[#101010]">
                <Video className="h-7 w-7 text-[#6f6f6f]" />
              </div>
            )}
            <div className="truncate px-2 py-1 text-[11px] text-[#d7d7d7]">{asset.name}</div>
          </button>
        )) : (
          <div className="col-span-3 rounded-lg border border-dashed border-[#555] px-3 py-5 text-center text-xs text-[#8f8f8f]">
            {emptyText}
          </div>
        )}
      </div>
    </div>
  );
}

function CropHint({ width, height }: { width: number; height: number }) {
  return (
    <div className="pointer-events-none absolute left-0 top-0 z-20 rounded-lg border-2 border-white/80" style={{ width, height }}>
      <div className="grid h-full w-full grid-cols-3 grid-rows-3">
        {Array.from({ length: 9 }).map((_, index) => (
          <div key={index} className="border border-white/25" />
        ))}
      </div>
    </div>
  );
}

function getVideoDisplaySize(meta: VideoMeta | null) {
  const ratio = meta && meta.height > 0 ? meta.width / meta.height : 16 / 9;
  if (ratio >= 1) {
    const width = 520;
    return { width, height: Math.round(width / ratio) };
  }
  const height = 535;
  return { width: Math.round(height * ratio), height };
}

function gcd(a: number, b: number): number {
  let x = Math.round(Math.abs(a));
  let y = Math.round(Math.abs(b));
  while (y) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1;
}

const handleLeft: CSSProperties = { left: -22 };
const handleRight: CSSProperties = { right: -22 };








