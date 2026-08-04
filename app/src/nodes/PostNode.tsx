import { useCallback, useEffect, useMemo, useRef, useState, createContext, useContext, lazy, Suspense, memo, type ChangeEvent, type CSSProperties, type ReactNode } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Activity, Aperture, BarChart3, ChevronDown, ChevronRight, Clapperboard, Layers3, Link2, Loader2, RotateCcw, Settings2, Sparkles, Wand2 } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import {
  POST_BLOOM_PRESETS,
  POST_COLOR_PRESETS,
  POST_EFFECT_DESCRIPTORS,
  POST_EFFECT_ORDER,
  POST_GRAIN_PRESETS,
  countEnabledPostEffects,
  createDefaultPostEffects,
  mergePostEffects,
  type PostEffectId,
  type PostCurvePoint,
  type PostEffectsState,
  type PostMediaKind,
} from '@/config/postEffectPresets';
import { ModelActivationPrompt } from '@/components/ModelActivationPrompt';
import { PostComparePreview } from '@/components/post/PostComparePreview';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useNodeFloatingPanel } from '@/hooks/useNodeFloatingPanel';
import { toRenderableAssetUrl } from '@/services/generation';
import {
  applyPostProcessingLocally,
  buildPostPreviewDescriptor,
  validateMattingSetup,
} from '@/services/localPostProcessing';
import {
  applyCinematicOneClick,
  type CinematicStrength,
} from '@/services/postFX/pipeline';
import { applyMotionBlur, loadRaftModel, estimateOpticalFlowRAFT, isRaftReady, propagateAlphaByFlow } from '@/services/postFX/motionBlur';
import { applyCinematicFrame } from '@/services/postFX/pipeline';
import { removeBackground, composeRgbaFromAlpha, type MattingModelId } from '@/services/postFX/matting';
import { clamp } from '@/services/postFX/util';

// 多主体抠图面板按需加载（不打进主包，避免画布操作卡顿）
const MattingCapabilityPanel = lazy(() => import('@/components/image-tools/panels/MattingCapabilityPanel'));
import type { MattingExtractResult } from '@/components/image-tools/panels/MattingCapabilityPanel';
import { isDepthModelReady } from '@/services/depthEstimation';
import { analyzeAutoGrade } from '@/services/postFX/autoGrade';
import { readLocalMediaBlob, registerLocalMedia, ensureLocalMediaUrl, isLocalMediaHandle } from '@/services/localMediaRegistry';
import { loadModel } from '@/services/modelLoader';
import { applyMotionBlurVideoLocally } from '@/services/ffmpegPipeline';
import { applyGpuMotionBlurVideoLocally, isGpuMotionBlurSupported } from '@/services/postFX/gpuMotionBlur';
import { hasLocalModelRunner } from '@/services/localModelRunner';
import { activateLocalModel } from '@/services/localInference';
import { PRESET_MODELS } from '@/config/presetModels';
import { useAuthStore } from '@/store/useAuthStore';
import { useCanvasStore } from '@/store/useCanvasStore';
import { EditableNodeTitle } from './EditableNodeTitle';
import { ErrorDetailBlock, ProgressBadge, StatusBadge } from './NodeShellShared';

import {
  CollapsiblePanelSection,
  ControlsDisabledContext,
  CurveEditorField,
  EmptySourceCard,
  FieldLabel,
  inspectOcioConfigText,
  isSupportedOcioConfigName,
  normalizePostLabel,
  PanelSection,
  PreviewOverlay,
  presetCurvePoints,
  previewViewportSize,
  readSourceAssetFromNode,
  ScopeWorkbench,
  SelectField,
  SliderField,
  stopCanvasPointer,
  SUPPORTED_OCIO_CONFIG_EXTENSIONS,
  ToggleField,
  useMediaNaturalSize,
  WheelCard,
  workspaceTabClass,
  type ColorPanelSectionId,
  type CurveChannelKey,
  type LocalPostBackendStatus,
  type LocalPostDoctorReport,
  type LocalPostDoctorRuntime,
  type OcioConfigInspection,
  type OcioSetupValidation,
  type PostHealthStatus,
  type PostPanelKind,
} from './PostNode.parts';
export function PostNode({ id, data, selected }: NodeProps) {
  const canvas = useCanvasStore((state) => state.canvas);
  const addConnectedNode = useCanvasStore((state) => state.addConnectedNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const selectNode = useCanvasStore((state) => state.selectNode);

  const params = useMemo(
    () => (data.params && typeof data.params === 'object' ? data.params as Record<string, unknown> : {}),
    [data.params],
  );
  const nodePosition = useMemo(
    () => canvas?.nodes.find((node) => node.id === id)?.position || { x: 0, y: 0 },
    [canvas, id],
  );
  const effects = useMemo(
    () => mergePostEffects(params.postEffects as Partial<PostEffectsState> | null | undefined),
    [params.postEffects],
  );
  const enabledCount = useMemo(() => countEnabledPostEffects(effects), [effects]);
  const previewDescriptor = useMemo(() => buildPostPreviewDescriptor(effects), [effects]);
  const selectedEffectRef = useRef<PostEffectId>('color');

  const [activeEffect, setActiveEffect] = useState<PostEffectId>('color');
  const [colorWorkspaceTab, setColorWorkspaceTab] = useState<'curves' | 'scopes' | 'output'>('curves');
  const [curveChannelTab, setCurveChannelTab] = useState<CurveChannelKey>('master');
  const [colorSectionsCollapsed, setColorSectionsCollapsed] = useState<Record<ColorPanelSectionId, boolean>>({
    console: false,
    wheels: false,
    workspace: false,
  });
  const [compareEnabled, setCompareEnabled] = useState(true);
  const [isApplying, setIsApplying] = useState(false);
  const [mattingPanelOpen, setMattingPanelOpen] = useState(false);
  const [mattingSourceUrl, setMattingSourceUrl] = useState('');
  const [localError, setLocalError] = useState('');
  const [activation, setActivation] = useState<{ mode: 'image' | 'video'; provider: string; reason: 'auth' } | null>(null);
  const [warnings, setWarnings] = useState<string[]>(
    Array.isArray(params.postWarnings) ? params.postWarnings.map((item) => String(item)) : [],
  );
  const [postHealth, setPostHealth] = useState<PostHealthStatus>({ ocio: null, oiio: null, gmic: null, upscale: {} });
  const [isRefreshingRuntimes, setIsRefreshingRuntimes] = useState(false);
  const [runtimeDoctor, setRuntimeDoctor] = useState<LocalPostDoctorReport>({ checkedAt: '', runtimes: {} });
  const [isRunningRuntimeDoctor, setIsRunningRuntimeDoctor] = useState(false);
  const [ocioConfigInspection, setOcioConfigInspection] = useState<OcioConfigInspection>({
    status: 'idle',
    title: '尚未检测自定义 OCIO Config。',
    details: ['切换到“自定义 OCIO Config”并导入文件后，这里会显示结构校验结果。'],
    detectedSections: [],
    profileVersion: '',
    formatLabel: 'OCIO Config',
  });

  const maskPickerRef = useRef<HTMLInputElement | null>(null);
  const backgroundPickerRef = useRef<HTMLInputElement | null>(null);
  const trackPickerRef = useRef<HTMLInputElement | null>(null);
  const lutPickerRef = useRef<HTMLInputElement | null>(null);
  const ocioConfigPickerRef = useRef<HTMLInputElement | null>(null);
  const depthMaskPickerRef = useRef<HTMLInputElement | null>(null);
  const bokehPickerRef = useRef<HTMLInputElement | null>(null);

  const { isOpen, open, close } = useNodeFloatingPanel<PostPanelKind>(id, () => selectNode(id));
  const panelOpen = isOpen('post-panel');
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);

  const connectedSource = useMemo(() => {
    if (!canvas) return null;
    const incomingEdges = canvas.edges.filter((edge) => edge.target === id);
    for (const edge of incomingEdges) {
      const sourceNode = canvas.nodes.find((node) => node.id === edge.source);
      const asset = readSourceAssetFromNode(
        sourceNode ? { type: sourceNode.type, data: sourceNode.data as unknown as Record<string, unknown> } : null,
      );
      if (asset) return asset;
    }
    return null;
  }, [canvas, id]);

  const legacySourceUrl = typeof params.sourceUrl === 'string' ? params.sourceUrl : '';
  const legacySourceType = params.sourceMediaType === 'video' ? 'video' : 'image';
  const sourceAsset = connectedSource || (legacySourceUrl ? { kind: legacySourceType as PostMediaKind, url: legacySourceUrl } : null);
  const sourceKind = sourceAsset?.kind || null;
  const sourceUrl = sourceAsset ? toRenderableAssetUrl(sourceAsset.url, sourceAsset.kind) : '';
  const sourceInherited = Boolean(connectedSource);

  // 一键功能对各素材类型的支持矩阵：用于按钮置灰 + 调用前拦截，避免无效调用/报错。
  // 两者均支持图片与视频；若某功能未来不支持某类型，在此移除即可自动置灰并拒绝。
  const ONE_CLICK_SUPPORT: Record<'cinematic' | 'matting', Array<'image' | 'video'>> = {
    cinematic: ['image', 'video'],
    matting: ['image', 'video'],
  };
  const cinematicDisabled =
    isApplying || !sourceAsset || !ONE_CLICK_SUPPORT.cinematic.includes(sourceAsset.kind);
  const mattingDisabled =
    isApplying || !sourceAsset || !ONE_CLICK_SUPPORT.matting.includes(sourceAsset.kind);

  const outputKind = params.lastResultKind === 'video' ? 'video' : 'image';
  const resultUrlRaw = typeof params.lastResultUrl === 'string' ? params.lastResultUrl : '';
  const resultUrl = resultUrlRaw ? toRenderableAssetUrl(resultUrlRaw, outputKind) : '';
  const lastResultMeta = params.lastResultMeta && typeof params.lastResultMeta === 'object'
    ? params.lastResultMeta as Record<string, unknown>
    : {};
  const lastProcessingMeta = lastResultMeta.processingMeta && typeof lastResultMeta.processingMeta === 'object'
    ? lastResultMeta.processingMeta as Record<string, unknown>
    : {};

  const mediaMeta = useMediaNaturalSize(sourceKind, sourceUrl || resultUrl);
  const viewport = useMemo(() => previewViewportSize(sourceKind, mediaMeta), [mediaMeta, sourceKind]);
  const previewStyle: CSSProperties = {
    width: viewport.width,
    height: viewport.height,
    maxWidth: '100%',
  };
  const stackSummary = useMemo(
    () => POST_EFFECT_ORDER.map((effectId) => `${effects[effectId].enabled ? '[开]' : '[关]'} ${POST_EFFECT_DESCRIPTORS[effectId].shortLabel}`).join('  '),
    [effects],
  );
  const ocioResultSummary = useMemo(() => {
    const executionMode = String(lastProcessingMeta.ocioExecutionMode || '').trim();
    const backendLabel = String(lastProcessingMeta.ocioBackendLabel || '').trim();
    const validationMessage = String(lastProcessingMeta.ocioConfigValidationMessage || '').trim();
    const wrapperApplied = lastProcessingMeta.ocioWrapperApplied === true || String(lastProcessingMeta.ocioWrapperApplied || '').trim() === 'true';
    const wrapperConfigured = lastProcessingMeta.ocioWrapperConfigured === true || String(lastProcessingMeta.ocioWrapperConfigured || '').trim() === 'true';
    const executable = lastProcessingMeta.ocioConfigExecutable === true || String(lastProcessingMeta.ocioConfigExecutable || '').trim() === 'true';
    const structurallyValid = lastProcessingMeta.ocioConfigStructurallyValid === true || String(lastProcessingMeta.ocioConfigStructurallyValid || '').trim() === 'true';
    if (!executionMode && !backendLabel && !validationMessage) return null;

    let toneClass = 'border-emerald-500/20 bg-emerald-500/8 text-emerald-100';
    let title = 'OCIO 已执行';
    if (executionMode === 'wrapper-only') {
      title = wrapperApplied ? '仅 Wrapper 成功执行' : '仅 Wrapper 未完成';
      toneClass = wrapperApplied ? toneClass : 'border-rose-500/30 bg-rose-500/10 text-rose-100';
    } else if (executionMode === 'fallback-only') {
      title = '仅本地回退执行';
      toneClass = 'border-amber-500/30 bg-amber-500/10 text-amber-100';
    } else if (wrapperApplied) {
      title = '自动模式：已走 Wrapper';
    } else {
      title = '自动模式：已回退到本地链路';
      toneClass = 'border-amber-500/30 bg-amber-500/10 text-amber-100';
    }

    const details = [
      `执行模式：${executionMode === 'wrapper-only' ? '仅 Wrapper' : executionMode === 'fallback-only' ? '仅本地回退' : '自动优先 Wrapper'}`,
      `实际链路：${backendLabel || (wrapperApplied ? '外部 Wrapper' : '本地回退')}`,
      validationMessage ? `配置校验：${validationMessage}` : '',
      `结构状态：${structurallyValid ? (executable ? '结构完整，可执行' : '基础结构通过，执行路由不完整') : '结构未通过'}`,
      wrapperConfigured ? '后端已检测到外部 Wrapper' : '后端未检测到外部 Wrapper',
    ].filter(Boolean);

    return { title, toneClass, details };
  }, [lastProcessingMeta]);
  const upscaleResultSummary = useMemo(() => {
    const executionMode = String(lastProcessingMeta.upscaleExecutionMode || '').trim();
    const backendLabel = String(lastProcessingMeta.upscaleBackendLabel || '').trim();
    const resolvedRoute = String(lastProcessingMeta.upscaleResolvedRoute || '').trim();
    const fallbackReason = String(lastProcessingMeta.upscaleFallbackReason || '').trim();
    const model = String(lastProcessingMeta.upscaleModel || '').trim();
    const scale = Number(lastProcessingMeta.upscaleScale || 0);
    const wrapperApplied = lastProcessingMeta.upscaleWrapperApplied === true || String(lastProcessingMeta.upscaleWrapperApplied || '').trim() === 'true';
    const wrapperConfigured = lastProcessingMeta.upscaleWrapperConfigured === true || String(lastProcessingMeta.upscaleWrapperConfigured || '').trim() === 'true';
    if (!executionMode && !backendLabel && !resolvedRoute) return null;

    let title = '高清增强已执行';
    let toneClass = 'border-emerald-500/20 bg-emerald-500/8 text-emerald-100';
    if (executionMode === 'wrapper-only') {
      title = wrapperApplied ? '仅 Wrapper 成功执行高清增强' : '仅 Wrapper 未完成执行';
      toneClass = wrapperApplied ? toneClass : 'border-rose-500/30 bg-rose-500/10 text-rose-100';
    } else if (executionMode === 'fallback-only') {
      title = '仅本地回退执行高清增强';
      toneClass = 'border-amber-500/30 bg-amber-500/10 text-amber-100';
    } else if (!wrapperApplied) {
      title = '自动模式：已回退到本地增强链';
      toneClass = 'border-amber-500/30 bg-amber-500/10 text-amber-100';
    }

    const details = [
      `执行模式：${executionMode === 'wrapper-only' ? '仅 Wrapper' : executionMode === 'fallback-only' ? '仅本地回退' : '自动优先 Wrapper'}`,
      `实际链路：${backendLabel || (wrapperApplied ? '外部 Wrapper' : 'ffmpeg-post-stack')}`,
      `路由落点：${resolvedRoute || '未记录'}${model ? ` / ${model}` : ''}`,
      scale > 0 ? `输出倍率：${scale}x` : '',
      wrapperConfigured ? '后端已检测到外部高清 Wrapper' : '后端未检测到外部高清 Wrapper',
      fallbackReason ? `回退原因：${fallbackReason}` : '',
    ].filter(Boolean);
    return { title, toneClass, details };
  }, [lastProcessingMeta]);
  const gmicResultSummary = useMemo(() => {
    const backendLabel = String(lastProcessingMeta.gmicBackendLabel || '').trim();
    const fallbackReason = String(lastProcessingMeta.gmicFallbackReason || '').trim();
    const wrapperApplied = lastProcessingMeta.gmicWrapperApplied === true || String(lastProcessingMeta.gmicWrapperApplied || '').trim() === 'true';
    const wrapperConfigured = lastProcessingMeta.gmicWrapperConfigured === true || String(lastProcessingMeta.gmicWrapperConfigured || '').trim() === 'true';
    const stagesApplied = Array.isArray(lastProcessingMeta.gmicStagesApplied)
      ? lastProcessingMeta.gmicStagesApplied.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    if (!backendLabel && !fallbackReason && !stagesApplied.length) return null;

    return {
      title: wrapperApplied ? 'G\'MIC 真实处理已执行' : 'G\'MIC 未接管，当前走本地回退',
      toneClass: wrapperApplied
        ? 'border-emerald-500/20 bg-emerald-500/8 text-emerald-100'
        : 'border-amber-500/30 bg-amber-500/10 text-amber-100',
      details: [
        `实际链路：${backendLabel || (wrapperApplied ? 'G\'MIC CLI' : 'ffmpeg-post-fallback')}`,
        `执行阶段：${stagesApplied.length ? stagesApplied.join(' / ') : '未记录'}`,
        wrapperConfigured ? '后端已检测到 G\'MIC Runtime' : '后端未检测到 G\'MIC Runtime',
        fallbackReason ? `回退原因：${fallbackReason}` : '',
      ].filter(Boolean),
    };
  }, [lastProcessingMeta]);
  const oiioResultSummary = useMemo(() => {
    const backendLabel = String(lastProcessingMeta.oiioBackendLabel || '').trim();
    const wrapperApplied = lastProcessingMeta.oiioWrapperApplied === true || String(lastProcessingMeta.oiioWrapperApplied || '').trim() === 'true';
    const detectedConfigPath = String(lastProcessingMeta.oiioDetectedConfigPath || '').trim();
    if (!backendLabel && !detectedConfigPath && !wrapperApplied) return null;
    return {
      title: wrapperApplied ? 'OIIO 严格图片调色已执行' : 'OIIO 当前未接管本次调色',
      toneClass: wrapperApplied
        ? 'border-emerald-500/20 bg-emerald-500/8 text-emerald-100'
        : 'border-[#2d3236] bg-[#0f1317] text-[#c9d1d9]',
      details: [
        `实际链路：${backendLabel || '未记录'}`,
        `默认 OCIO Config：${detectedConfigPath || '未记录'}`,
        wrapperApplied ? '本次图片调色优先走了 OIIO + OpenColorIO。' : '当前如果没有可用 OIIO / OCIO Config，会继续走已有 OCIO wrapper 或 FFmpeg 回退。',
      ],
    };
  }, [lastProcessingMeta]);
  const ocioValidation = useMemo<OcioSetupValidation>(() => {
    const modeLabel = effects.color.ocioExecutionMode === 'wrapper-only'
      ? '仅 Wrapper'
      : effects.color.ocioExecutionMode === 'fallback-only'
        ? '仅本地回退'
        : '自动优先 Wrapper';
    const details: string[] = [`当前执行模式：${modeLabel}`];
    const hasCustomConfig = effects.color.ocioConfig === 'custom-file';
    const hasConfigFile = Boolean(effects.color.ocioConfigAssetName);
    const fileSupported = !hasConfigFile || isSupportedOcioConfigName(effects.color.ocioConfigAssetName);
    if (effects.color.ocioExecutionMode === 'wrapper-only' && !postHealth.ocio?.configured) {
      return {
        severity: 'error',
        title: '当前设置为仅 Wrapper，但后端没有可用的 OCIO Runtime。',
        details: [
          ...details,
          '请先配置 HMDAO_POST_OCIO_PATH 或 HMDAO_POST_OCIO_COMMAND，或者切回“自动：Wrapper 优先”。',
        ],
      };
    }
    if (hasCustomConfig && !hasConfigFile) {
      return {
        severity: effects.color.ocioExecutionMode === 'wrapper-only' ? 'error' : 'warn',
        title: effects.color.ocioExecutionMode === 'wrapper-only'
          ? '当前要求走自定义 .ocio，但还没有挂载 config 文件。'
          : '当前已切到自定义 .ocio，但还没有挂载 config 文件。',
        details: [
          ...details,
          '导入 .ocio / .yaml / .json / .cfg 文件后，后端才能建立真实配置链路。',
        ],
      };
    }
    if (hasCustomConfig && hasConfigFile && !fileSupported) {
      return {
        severity: effects.color.ocioExecutionMode === 'wrapper-only' ? 'error' : 'warn',
        title: '当前自定义 OCIO Config 文件扩展名不在支持范围内。',
        details: [
          ...details,
          `支持的扩展名：${SUPPORTED_OCIO_CONFIG_EXTENSIONS.join(', ')}`,
        ],
      };
    }
    if (hasCustomConfig && hasConfigFile && ocioConfigInspection.status === 'error') {
      return {
        severity: effects.color.ocioExecutionMode === 'wrapper-only' ? 'error' : 'warn',
        title: ocioConfigInspection.title,
        details: [...details, ...ocioConfigInspection.details],
      };
    }
    if (hasCustomConfig && hasConfigFile && ocioConfigInspection.status === 'warn') {
      return {
        severity: 'warn',
        title: ocioConfigInspection.title,
        details: [...details, ...ocioConfigInspection.details],
      };
    }
    if (effects.color.ocioExecutionMode === 'fallback-only' && hasCustomConfig) {
      return {
        severity: 'warn',
        title: '当前设置为仅本地回退，自定义 .ocio 不会走外部 Wrapper。',
        details: [
          ...details,
          '这一模式会保留近似色彩风格，但不会执行真实工作室 OCIO Runtime。',
        ],
      };
    }
    if (hasCustomConfig && hasConfigFile && !postHealth.ocio?.configured) {
      return {
        severity: 'warn',
        title: '自定义 .ocio 已挂载，但当前未检测到外部 Wrapper。',
        details: [
          ...details,
          '生成时会回退到本地近似调色链；如果需要真实工作室 OCIO，请先配置 HMDAO_POST_OCIO_PATH 或 HMDAO_POST_OCIO_COMMAND。',
        ],
      };
    }
    if (hasCustomConfig && hasConfigFile && postHealth.ocio?.configured) {
      return {
        severity: 'ok',
        title: '自定义 .ocio 已就绪，可走外部 Wrapper 执行。',
        details: [
          ...details,
          `当前文件：${effects.color.ocioConfigAssetName}`,
          ...ocioConfigInspection.details,
        ],
      };
    }
    return {
      severity: 'ok',
      title: '当前 OCIO 配置可正常执行。',
      details,
    };
  }, [effects.color, ocioConfigInspection, postHealth.ocio]);

  useEffect(() => {
    if (!panelOpen) return;
    setActiveEffect(selectedEffectRef.current);
  }, [panelOpen]);

  const loadPostHealth = useCallback(async (options: { refresh?: boolean } = {}) => {
    const endpoint = options.refresh ? '/api/health/local-post/refresh' : '/api/health';
    const method = options.refresh ? 'POST' : 'GET';
    const response = await fetch(endpoint, {
      method,
      headers: options.refresh ? { 'Content-Type': 'application/json' } : undefined,
    });
    if (!response.ok) {
      throw new Error(`运行时状态请求失败：HTTP ${response.status}`);
    }
    const payload = await response.json().catch(() => null) as {
      capabilities?: {
        localPostBackends?: {
          ocio?: LocalPostBackendStatus;
          oiio?: LocalPostBackendStatus;
          gmic?: LocalPostBackendStatus;
          upscale?: Record<string, LocalPostBackendStatus>;
        };
      };
    } | null;
    setPostHealth({
      ocio: payload?.capabilities?.localPostBackends?.ocio || null,
      oiio: payload?.capabilities?.localPostBackends?.oiio || null,
      gmic: payload?.capabilities?.localPostBackends?.gmic || null,
      upscale: payload?.capabilities?.localPostBackends?.upscale || {},
    });
  }, []);

  const refreshLocalPostRuntimes = useCallback(async () => {
    setIsRefreshingRuntimes(true);
    try {
      await loadPostHealth({ refresh: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : '运行时探测失败。';
      setLocalError(message);
    } finally {
      setIsRefreshingRuntimes(false);
    }
  }, [loadPostHealth]);

  const runRuntimeDoctor = useCallback(async (options: { force?: boolean } = {}) => {
    setIsRunningRuntimeDoctor(true);
    try {
      const response = await fetch(`/api/health/local-post/doctor${options.force ? '?force=1' : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forceRelease: Boolean(options.force) }),
      });
      if (!response.ok) {
        throw new Error(`运行时自检失败：HTTP ${response.status}`);
      }
      const payload = await response.json().catch(() => null) as ({
        checkedAt?: string;
        runtimes?: LocalPostDoctorReport['runtimes'];
      } & Record<string, unknown>) | null;
      setRuntimeDoctor({
        checkedAt: String(payload?.checkedAt || ''),
        runtimes: payload?.runtimes || {},
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '运行时自检失败。';
      setLocalError(message);
    } finally {
      setIsRunningRuntimeDoctor(false);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    async function loadHealthOnMount() {
      try {
        await loadPostHealth();
        if (disposed) return;
      } catch {
        if (!disposed) {
          setPostHealth({ ocio: null, oiio: null, gmic: null, upscale: {} });
        }
      }
    }
    void loadHealthOnMount();
    return () => {
      disposed = true;
    };
  }, [loadPostHealth]);

  useEffect(() => {
    let disposed = false;
    async function inspectOcioConfig() {
      const assetUrl = String(effects.color.ocioConfigAssetUrl || '').trim();
      const assetName = String(effects.color.ocioConfigAssetName || '').trim();
      if (!assetUrl || !assetName) {
        setOcioConfigInspection({
          status: 'idle',
          title: '尚未检测自定义 OCIO Config。',
          details: ['切换到“自定义 OCIO Config”并导入文件后，这里会显示结构校验结果。'],
          detectedSections: [],
          profileVersion: '',
          formatLabel: 'OCIO Config',
        });
        return;
      }
      setOcioConfigInspection((current) => ({
        ...current,
        status: 'loading',
        title: '正在检查 OCIO Config 结构...',
        details: ['正在读取 profile 版本、colorspaces、roles / displays / views 结构。'],
      }));
      try {
        const blob = readLocalMediaBlob(assetUrl);
        if (!blob) {
          if (disposed) return;
          setOcioConfigInspection({
            status: 'warn',
            title: '当前 OCIO Config 已挂载，但本地结构内容暂时不可读。',
            details: ['文件句柄已存在，但当前页面无法直接读取内容；生成时后端仍会再次校验真实文件结构。'],
            detectedSections: [],
            profileVersion: '',
            formatLabel: 'OCIO Config',
          });
          return;
        }
        const text = await blob.text();
        if (disposed) return;
        setOcioConfigInspection(inspectOcioConfigText(assetName, text));
      } catch (error) {
        if (disposed) return;
        setOcioConfigInspection({
          status: 'error',
          title: '读取当前 OCIO Config 失败。',
          details: [error instanceof Error ? error.message : 'unknown-ocio-read-error'],
          detectedSections: [],
          profileVersion: '',
          formatLabel: 'OCIO Config',
        });
      }
    }
    void inspectOcioConfig();
    return () => {
      disposed = true;
    };
  }, [effects.color.ocioConfigAssetName, effects.color.ocioConfigAssetUrl]);

  const updateEffects = useCallback((nextEffects: PostEffectsState) => {
    updateNodeData(id, {
      params: {
        ...params,
        postEffects: nextEffects,
      },
      status: 'idle',
      error: '',
    });
  }, [id, params, updateNodeData]);

  const patchEffect = useCallback(<K extends PostEffectId>(effectId: K, patch: Partial<PostEffectsState[K]>) => {
    const nextEffects = mergePostEffects({
      ...effects,
      [effectId]: {
        ...effects[effectId],
        ...patch,
      },
    });
    updateEffects(nextEffects);
  }, [effects, updateEffects]);

  const patchFirstTrack = useCallback((patch: Partial<PostEffectsState['tracking']['tracks'][number]>) => {
    if (!effects.tracking.tracks[0]) return;
    patchEffect('tracking', {
      enabled: true,
      tracks: [{ ...effects.tracking.tracks[0], ...patch }, ...effects.tracking.tracks.slice(1)],
    });
  }, [effects.tracking.tracks, patchEffect]);

  const toggleColorSection = useCallback((sectionId: ColorPanelSectionId) => {
    setColorSectionsCollapsed((current) => ({
      ...current,
      [sectionId]: !current[sectionId],
    }));
  }, []);

  const handleResetEffect = useCallback((effectId: PostEffectId) => {
    const defaults = createDefaultPostEffects();
    const nextEffects = mergePostEffects({
      ...effects,
      [effectId]: defaults[effectId],
    });
    updateEffects(nextEffects);
    setWarnings([]);
    setLocalError('');
  }, [effects, updateEffects]);

  function handleOpenEffect(effectId: PostEffectId) {
    selectedEffectRef.current = effectId;
    setActiveEffect(effectId);
    open('post-panel');
  }

  function handleMediaUpload(event: ChangeEvent<HTMLInputElement>, role: 'mask' | 'background' | 'track' | 'lut' | 'ocioConfig' | 'depthMask' | 'bokeh') {
    const file = event.target.files?.[0];
    if (!file) return;
    if (role === 'ocioConfig' && !isSupportedOcioConfigName(file.name || '')) {
      setLocalError(`当前 OCIO Config 文件扩展名不在支持范围内。支持：${SUPPORTED_OCIO_CONFIG_EXTENSIONS.join(', ')}`);
      event.target.value = '';
      return;
    }
    const handle = registerLocalMedia(file);

    if (role === 'mask') {
      patchEffect('matting', { enabled: true, maskUrl: handle });
    } else if (role === 'background') {
      patchEffect('matting', { enabled: true, backgroundUrl: handle, mode: 'replace-background' });
    } else if (role === 'lut') {
      patchEffect('color', {
        enabled: true,
        preset: 'custom',
        lutAssetUrl: handle,
        lutAssetName: file.name || 'custom.cube',
      });
    } else if (role === 'ocioConfig') {
      patchEffect('color', {
        enabled: true,
        ocioConfig: 'custom-file',
        ocioConfigAssetUrl: handle,
        ocioConfigAssetName: file.name || 'config.ocio',
      });
    } else if (role === 'depthMask') {
      patchEffect('dof', {
        enabled: true,
        maskMode: 'paint-mask',
        depthMaskUrl: handle,
        depthMaskAssetName: file.name || 'depth-mask.png',
      });
    } else if (role === 'bokeh') {
      patchEffect('dof', {
        enabled: true,
        shape: 'custom',
        bokehAssetUrl: handle,
        bokehAssetName: file.name || 'bokeh.png',
      });
    } else {
      const existingTracks = effects.tracking.tracks.slice();
      const nextTrack = existingTracks[0] || {
        id: uuidv4(),
        label: '跟踪 1',
        overlayUrl: '',
        overlayKind: file.type.startsWith('video/') ? 'video' : 'image',
        x: 50,
        y: 50,
        scale: 1,
        rotation: 0,
        opacity: 1,
        startTime: 0,
        endTime: Math.max(5, mediaMeta.duration || 5),
        blendMode: 'normal' as const,
        tracker: 'manual' as const,
      };
      nextTrack.overlayUrl = handle;
      nextTrack.overlayKind = file.type.startsWith('video/') ? 'video' : 'image';
      const nextTracks = existingTracks.length > 0 ? [nextTrack, ...existingTracks.slice(1)] : [nextTrack];
      patchEffect('tracking', { enabled: true, tracks: nextTracks });
    }

    event.target.value = '';
  }

  async function handleApplyStack() {
    if (!isAuthenticated()) {
      window.location.href = '/login';
      return;
    }
    if (!sourceAsset) {
      setLocalError('请先连接图片或视频素材，再执行后期处理。');
      return;
    }

    const mattingError = validateMattingSetup(effects.matting);
    if (mattingError) {
      setLocalError(mattingError);
      setActiveEffect('matting');
      open('post-panel');
      return;
    }
    if (effects.color.enabled && ocioValidation.severity === 'error') {
      setLocalError(ocioValidation.title);
      setActiveEffect('color');
      setColorWorkspaceTab('output');
      open('post-panel');
      return;
    }

    setLocalError('');
    setWarnings([]);
    setIsApplying(true);
    updateNodeData(id, {
      status: 'generating',
      error: '',
      params: {
        ...params,
        postEffects: effects,
        generationProgress: [{ progress: 18, message: '正在应用后期效果栈', stage: 'local-post' }],
      },
    });

    try {
      const result = await applyPostProcessingLocally({
        sourceUrl: sourceAsset.url,
        mediaKind: sourceAsset.kind,
        effects,
      });

      const nextLabel = `${normalizePostLabel(data.label, '后期结果')} 输出`;

      if (sourceAsset.kind === 'image') {
        addConnectedNode({
          type: 'image',
          position: {
            x: nodePosition.x + 700,
            y: nodePosition.y + 20,
          },
          sourceId: id,
          sourceHandle: 'post-output',
          data: {
            label: nextLabel,
            imageUrl: result.url,
            status: 'completed',
            outputs: [{
              id: `post-output-${Date.now()}`,
              type: 'image',
              url: result.url,
              metadata: {
                managedUrl: true,
                originalUrl: result.url,
                width: result.width,
                height: result.height,
                processingEngine: result.processingEngine,
                postEffects: effects,
                outputAssetId: result.assetId,
              },
            }],
            params: {
              sourceNodeId: id,
              imageMeta: { width: result.width, height: result.height },
              sourceMediaType: 'image',
              postEffects: effects,
            },
          },
        });
      } else {
        addConnectedNode({
          type: 'video',
          position: {
            x: nodePosition.x + 700,
            y: nodePosition.y + 20,
          },
          sourceId: id,
          sourceHandle: 'post-output',
          data: {
            label: nextLabel,
            videoUrl: result.url,
            quality: `${result.width}x${result.height}`,
            duration: result.duration,
            status: 'completed',
            outputs: [{
              id: `post-output-${Date.now()}`,
              type: 'video',
              url: result.url,
              metadata: {
                managedUrl: true,
                originalUrl: result.url,
                width: result.width,
                height: result.height,
                duration: result.duration,
                processingEngine: result.processingEngine,
                postEffects: effects,
                outputAssetId: result.assetId,
              },
            }],
            params: {
              sourceNodeId: id,
              videoMeta: { width: result.width, height: result.height, duration: result.duration },
              sourceMediaType: 'video',
              postEffects: effects,
            },
          },
        });
      }

      setWarnings(result.warnings);

      updateNodeData(id, {
        status: 'completed',
        error: '',
        params: {
          ...params,
          postEffects: effects,
          lastResultUrl: result.url,
          lastResultKind: sourceAsset.kind,
          lastResultMeta: {
            width: result.width,
            height: result.height,
            duration: result.duration,
            processingEngine: result.processingEngine,
            assetId: result.assetId,
            processingMeta: result.processingMeta,
          },
          postWarnings: result.warnings,
          generationProgress: [],
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '本地后期处理失败。';
      setLocalError(message);
      updateNodeData(id, {
        status: 'error',
        error: message,
        params: {
          ...params,
          postEffects: effects,
          generationProgress: [],
          lastError: message,
          lastErrorCategory: 'render',
          lastErrorStage: 'local-post',
        },
      });
    } finally {
      setIsApplying(false);
    }
  }

  /** 把客户端处理后得到的 Blob 注册为本地媒体并产出结果节点。 */
  function emitClientResultNode(
    blob: Blob,
    kind: 'image' | 'video',
    width: number,
    height: number,
    labelSuffix: string,
    extraMeta: Record<string, unknown> = {},
  ): void {
    const handle = registerLocalMedia(blob);
    const nextLabel = `${normalizePostLabel(data.label, '后期结果')} ${labelSuffix}`;
    if (kind === 'image') {
      addConnectedNode({
        type: 'image',
        position: { x: nodePosition.x + 700, y: nodePosition.y + 20 },
        sourceId: id,
        sourceHandle: 'post-output',
        data: {
          label: nextLabel,
          imageUrl: handle,
          status: 'completed',
          outputs: [{
            id: `post-output-${Date.now()}`,
            type: 'image',
            url: handle,
            metadata: {
              managedUrl: true,
              originalUrl: handle,
              width,
              height,
              processingEngine: 'postfx-client-pipeline',
              ...extraMeta,
            },
          }],
          params: { sourceNodeId: id, imageMeta: { width, height }, sourceMediaType: 'image' },
        },
      });
    }
  }

  /** 解析源素材为可直接用于 <img>/<video> 的真实 URL（hmdao-local:// 句柄 → blob URL）。 */
  async function resolveSourceMediaUrl(): Promise<string> {
    if (!sourceAsset) return '';
    if (isLocalMediaHandle(sourceAsset.url)) {
      const resolved = await ensureLocalMediaUrl(sourceAsset.url);
      return resolved || '';
    }
    return sourceAsset.url;
  }

  /** 取源素材为图片：图片直接加载；视频抽取首帧。 */
  async function loadSourceAsImage(): Promise<HTMLImageElement> {
    if (!sourceAsset) throw new Error('缺少素材');
    const srcUrl = await resolveSourceMediaUrl();
    if (!srcUrl) throw new Error('素材链接解析失败（本地媒体句柄无效或已被清理）');
    if (sourceAsset.kind === 'image') return loadImageFromUrlSafe(srcUrl);
    // 视频：抽取首帧
    const video = document.createElement('video');
    video.src = srcUrl;
    video.muted = true;
    video.crossOrigin = 'anonymous';
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error('video-frame-extract-failed'));
      video.load();
    });
    video.currentTime = 0;
    await new Promise<void>((resolve) => {
      video.onseeked = () => resolve();
    });
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    return loadImageFromUrlSafe(canvas.toDataURL('image/png'));
  }

  function loadImageFromUrlSafe(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`postFX-load-failed:${url}`));
      img.src = url;
    });
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function yieldToUI(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  /**
   * 按需确保某个后期模型就绪：已激活直接返回；已安装则激活；否则下载并激活。
   * 这样「一键电影感 / 一键抠像」等按钮在模型缺失时会自动拉取权重，而不是只抛错（空壳）。
   */
  async function ensurePresetModel(modelId: string): Promise<{ ok: boolean; reason?: string }> {
    const meta = PRESET_MODELS.find((m) => m.id === modelId);
    if (!meta) return { ok: false, reason: `unknown-model:${modelId}` };
    if (hasLocalModelRunner(modelId)) return { ok: true };
    // 不信任“已安装”标记：直接确保真实权重已在缓存（loadModel 对已缓存文件幂等，
    // 并会自动补齐缺失的外部权重，如 Depth Anything V3 的 model.onnx_data）。
    // 这样即便标记过期/缓存部分缺失，点击一键功能时也能自愈，避免只报 model-not-cached。
    setLocalError(`正在准备模型「${meta.name}」…`);
    const res = await loadModel({
      modelId,
      version: meta.version,
      url: meta.url,
      extraFiles: meta.extraFiles,
      timeout: 600000,
      retries: 2,
    });
    if (!res.success) return { ok: false, reason: res.error || '模型下载失败' };
    const act = await activateLocalModel(modelId, meta.version);
    if (!act.ok) return act;
    return { ok: true };
  }

  /** 把视频成片（Blob）注册为本地媒体并产出视频结果节点。 */
  function emitClientVideoResultNode(
    blob: Blob,
    width: number,
    height: number,
    duration: number,
    labelSuffix: string,
  ): void {
    const handle = registerLocalMedia(blob);
    const nextLabel = `${normalizePostLabel(data.label, '后期结果')} ${labelSuffix}`;
    addConnectedNode({
      type: 'video',
      position: { x: nodePosition.x + 700, y: nodePosition.y + 20 },
      sourceId: id,
      sourceHandle: 'post-output',
      data: {
        label: nextLabel,
        videoUrl: handle,
        quality: `${width}x${height}`,
        duration,
        status: 'completed',
        outputs: [{
          id: `post-output-${Date.now()}`,
          type: 'video',
          url: handle,
          metadata: {
            managedUrl: true,
            originalUrl: handle,
            width,
            height,
            duration,
            processingEngine: 'postfx-video-pipeline',
          },
        }],
        params: {
          sourceNodeId: id,
          videoMeta: { width, height, duration },
          sourceMediaType: 'video',
        },
      },
    });
  }

  function pickVideoMime(): string {
    if (typeof MediaRecorder === 'undefined') return 'video/webm';
    const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    for (const c of candidates) {
      if (MediaRecorder.isTypeSupported(c)) return c;
    }
    return 'video/webm';
  }

  /** 抽取视频在指定时间的帧到指定尺寸的画布（用于逐帧处理）。 */
  function grabVideoFrame(
    video: HTMLVideoElement,
    time: number,
    w: number,
    h: number,
  ): Promise<HTMLCanvasElement> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        video.onseeked = null;
        video.onerror = null;
      };
      video.onseeked = () => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        c.getContext('2d')!.drawImage(video, 0, 0, w, h);
        cleanup();
        resolve(c);
      };
      video.onerror = () => {
        cleanup();
        reject(new Error('video-seek-failed'));
      };
      video.currentTime = time;
    });
  }

  async function handleApplyMotionBlur() {
    if (!sourceAsset) {
      setLocalError('请先连接图片或视频素材。');
      return;
    }
    setLocalError('');
    setIsApplying(true);
    try {
      const img = await loadSourceAsImage();
      const canvas = applyMotionBlur(img, {
        length: effects.motionBlur.length,
        angle: effects.motionBlur.angle,
      });
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('to-blob-failed'))), 'image/png'),
      );
      emitClientResultNode(blob, 'image', canvas.width, canvas.height, '运动模糊', {
        engine: 'kornia-motion',
      });
    } catch (err) {
      setLocalError((err as Error)?.message || '运动模糊处理失败');
    } finally {
      setIsApplying(false);
    }
  }

  async function handleOneClickCinematic(strength: CinematicStrength = 'auto') {
    if (!sourceAsset) {
      setLocalError('请先连接图片或视频素材。');
      return;
    }
    if (!ONE_CLICK_SUPPORT.cinematic.includes(sourceAsset.kind)) {
      setLocalError('一键电影感仅支持图片或视频素材。');
      return;
    }
    setLocalError('');
    setIsApplying(true);
    updateNodeData(id, {
      status: 'generating',
      error: '',
      params: { ...params, generationProgress: [{ progress: 10, message: '一键电影感：智能分析自动调色 → 辉光 → 颗粒 → 智能运动模糊 → 智能景深（保留主体清晰）→ 智能锐化 → 发光智能光晕', stage: 'postfx' }] },
    });
    try {
      // 智能景深需要深度模型：按需下载并激活（默认 V3，已作为标准深度引擎）
      if (!isDepthModelReady()) {
        const ensured = await ensurePresetModel('depth-anything-v3-base');
        if (!ensured.ok) {
          setLocalError(`智能景深所需深度模型未就绪：${ensured.reason ?? ''}（请到模型下载面板安装 Depth Anything V3）`);
          return;
        }
      }
      if (sourceAsset.kind === 'video') {
        await handleOneClickCinematicVideo(strength);
        return;
      }
      const img = await loadSourceAsImage();
      const result = await applyCinematicOneClick(img, { strength });
      emitClientResultNode(result.blob, 'image', result.width, result.height, '一键电影感', {
        engines: result.engines,
        postEffects: effects,
      });
    } catch (err) {
      setLocalError((err as Error)?.message || '一键电影感处理失败（请确认景深模型已安装）');
    } finally {
      setIsApplying(false);
    }
  }

  /** 视频逐帧处理：自动调色 → 辉光 → 颗粒 → 运动模糊 → 智能景深，再重编码为 webm。 */
  async function handleOneClickCinematicVideo(strength: CinematicStrength = 'auto') {
    if (!sourceAsset || sourceAsset.kind !== 'video') return;
    const srcUrl = await resolveSourceMediaUrl();
    if (!srcUrl) throw new Error('视频素材链接解析失败（本地媒体句柄无效）');
    const MAX_SIDE = 720; // 处理分辨率上限，保证浏览器内重编码速度
    const FPS = 12; // 抽帧/重编码帧率（兼顾速度与流畅）

    // 视频电影感的运动模糊（顺序：源视频先做运动模糊 → 再逐帧调色/景深，这是最稳最真实的顺序，
    // 因为运动模糊与景深都是「拍摄期」镜头效果，应在调色前完成）。
    // 优先层级：
    //   1) 客户端 GPU 运动模糊（WebGPU + RAFT 光流 / RIFE 插帧后累积）——最真实、零服务端依赖；
    //   2) 服务端 ffmpeg 真实运动模糊（tblend / minterpolate 快门拖影）——稳定兜底；
    //   3) 服务端/客户端均不可用时，回退到客户端 RAFT 光流逐帧模糊（下方循环内处理）。
    const motionEnabled = strength !== 'light';
    let sourceForFrames = srcUrl;
    let blurEngine: 'gpu' | 'server' | '' = '';
    if (motionEnabled) {
      if (isGpuMotionBlurSupported()) {
        try {
          const gpu = await applyGpuMotionBlurVideoLocally(srcUrl, {
            strength,
            fps: FPS,
            useRife: true,
          });
          if (gpu.ok && gpu.url) {
            sourceForFrames = gpu.url;
            blurEngine = 'gpu';
          }
        } catch {
          /* 回退服务端 ffmpeg */
        }
      }
      if (!blurEngine) {
        try {
          const mb = await applyMotionBlurVideoLocally(srcUrl, {
            strength: strength === 'strong' ? 0.85 : 0.5,
            fps: FPS,
          });
          if (mb.success && mb.data?.url) {
            sourceForFrames = mb.data.url;
            blurEngine = 'server';
          }
        } catch {
          /* 回退客户端 RAFT 光流模糊 */
        }
      }
    }
    const serverBlurred = blurEngine !== '';

    const video = document.createElement('video');
    video.src = sourceForFrames;
    video.muted = true;
    video.crossOrigin = 'anonymous';
    video.playsInline = true;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('video-load-failed'));
    });

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const scale = Math.min(1, MAX_SIDE / Math.max(vw, vh));
    const pw = Math.max(2, Math.round(vw * scale));
    const ph = Math.max(2, Math.round(vh * scale));

    // 用首帧计算一次色调（时域一致），逐帧复用
    const firstFrame = await grabVideoFrame(video, 0, pw, ph);
    const grade = analyzeAutoGrade(firstFrame);

    // 运动模糊：服务端已做真实运动模糊时，客户端不再叠加（避免重复模糊）；
    // 否则优先用 RAFT 光流做逐帧方向性真实运动模糊（物体越动越糊、静止越清），
    // RAFT 模型缺失/加载失败时自动回退到全局角度模糊，保证一键可用。
    let useOpticalFlow = false;
    if (!serverBlurred) {
      try {
        if (!isRaftReady()) {
          const ensured = await ensurePresetModel('raft-optical-flow');
          if (ensured.ok) {
            const raftResult = await loadRaftModel();
            useOpticalFlow = raftResult.ok;
          }
        } else {
          useOpticalFlow = true;
        }
      } catch {
        useOpticalFlow = false;
      }
    }

    const out = document.createElement('canvas');
    out.width = pw;
    out.height = ph;
    const octx = out.getContext('2d')!;
    const stream = out.captureStream(FPS);
    const mime = pickVideoMime();

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    } catch {
      throw new Error('当前浏览器不支持 MediaRecorder 视频重编码');
    }
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    const encodeDone = new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: mime }));
    });

    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const totalFrames = Math.max(1, Math.floor(duration * FPS));
    const step = 1000 / FPS;

    recorder.start();
    let prevFrame: HTMLCanvasElement | null = null;
    for (let i = 0; i < totalFrames; i++) {
      const t = i / FPS;
      const frame = await grabVideoFrame(video, t, pw, ph);
      // 用上一帧 → 当前帧的 RAFT 光流驱动方向性运动模糊
      let opticalFlow;
      if (useOpticalFlow && prevFrame) {
        try {
          const flow = await estimateOpticalFlowRAFT(prevFrame, frame);
          if (flow) opticalFlow = flow;
        } catch {
          opticalFlow = undefined;
        }
      }
      const processed = await applyCinematicFrame(frame, {
        strength,
        grade,
        opticalFlow: serverBlurred ? undefined : opticalFlow,
        motionBlur: !serverBlurred,
      });
      octx.drawImage(processed, 0, 0);
      updateNodeData(id, {
        status: 'generating',
        error: '',
        params: {
          ...params,
          generationProgress: [{
            progress: Math.round(((i + 1) / totalFrames) * 100),
            message: `一键电影感·视频 ${i + 1}/${totalFrames}${
              blurEngine === 'gpu'
                ? '（客户端 GPU 真实运动模糊）'
                : blurEngine === 'server'
                  ? '（服务端真实运动模糊）'
                  : useOpticalFlow
                    ? '（RAFT 光流运动模糊）'
                    : ''
            }`,
            stage: 'postfx-video',
          }],
        },
      });
      await sleep(step);
      if (i % 4 === 0) await yieldToUI();
      prevFrame = frame;
    }
    recorder.stop();
    const blob = await encodeDone;
    emitClientVideoResultNode(blob, pw, ph, duration, '一键电影感·视频');
  }

  async function handleOneClickMatting() {
    if (!sourceAsset) {
      setLocalError('请先连接图片或视频素材。');
      return;
    }
    if (!ONE_CLICK_SUPPORT.matting.includes(sourceAsset.kind)) {
      setLocalError('一键智能抠图仅支持图片或视频素材。');
      return;
    }
    setLocalError('');

    // 视频素材走「逐帧视频抠像」（RAFT 光流时域连贯，减少边缘闪烁）
    if (sourceAsset.kind === 'video') {
      setIsApplying(true);
      try {
        await handleOneClickMattingVideo();
      } catch (err) {
        setLocalError((err as Error)?.message || '视频抠像失败');
      } finally {
        setIsApplying(false);
      }
      return;
    }

    // 图片素材打开多主体智能抠图面板（自动检测→选择→修正→批量出图）
    const srcUrl = await resolveSourceMediaUrl();
    if (!srcUrl) {
      setLocalError('素材链接解析失败。');
      return;
    }
    setMattingSourceUrl(srcUrl);
    setMattingPanelOpen(true);
  }

  /** 视频跟踪模式：面板选主体后→输出跟踪视频 */
  async function handleMattingTrack(subjectIds: number[], _srcUrl: string) {
    if (!sourceAsset || sourceAsset.kind !== 'video') return;
    setIsApplying(true); setLocalError('');
    try {
      // 调用已有的逐帧视频抠像(RAFT光流+BiRefNet)
      await handleOneClickMattingVideo();
    } catch (err) {
      setLocalError((err as Error)?.message || '视频跟踪失败');
    } finally {
      setIsApplying(false);
      setMattingPanelOpen(false);
    }
  }

  /** 面板确认提取→批量输出带透明通道的 PNG 结果节点 */
  async function handleMattingExtract(results: MattingExtractResult[]) {
    if (!sourceAsset) return;
    setIsApplying(true);
    setLocalError('');
    try {
      for (const r of results) {
        emitClientResultNode(r.blob, 'image', r.width, r.height, `抠图·${r.name}`, {
          engine: 'birefnet-matting',
          subjectId: r.id,
        });
      }
    } catch (err) {
      setLocalError((err as Error)?.message || '批量抠图输出失败');
    } finally {
      setIsApplying(false);
      setMattingPanelOpen(false);
    }
  }

  /** 确保抠像模型就绪：默认 BiRefNet。返回模型 id 或 null。 */
  async function ensureMattingModel(): Promise<MattingModelId | null> {
    if ((await ensurePresetModel('birefnet-matting')).ok) return 'birefnet-matting';
    setLocalError(
      '智能抠像模型未就绪：BiRefNet 下载/加载失败。请到模型下载面板重试安装。',
    );
    return null;
  }

  /**
   * 逐帧视频抠像（RAFT 光流时域连贯版）：
   * 每帧用本地抠像模型得到 alpha，并用「上一帧→当前帧」的 RAFT 光流把上一帧 alpha 反向变形、
   * 与当前帧 alpha 轻度混合，显著减少逐帧独立抠像带来的边缘闪烁/抖动。RAFT 缺失时退化为逐帧独立抠像。
   */
  async function handleOneClickMattingVideo(): Promise<void> {
    if (!sourceAsset || sourceAsset.kind !== 'video') return;
    const srcUrl = await resolveSourceMediaUrl();
    if (!srcUrl) throw new Error('视频素材链接解析失败（本地媒体句柄无效）');
    const MAX_SIDE = 720;
    const FPS = 12;

    const video = document.createElement('video');
    video.src = srcUrl;
    video.muted = true;
    video.crossOrigin = 'anonymous';
    video.playsInline = true;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('video-load-failed'));
    });

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const scale = Math.min(1, MAX_SIDE / Math.max(vw, vh));
    const pw = Math.max(2, Math.round(vw * scale));
    const ph = Math.max(2, Math.round(vh * scale));

    const modelId = await ensureMattingModel();
    if (!modelId) return;

    // RAFT 光流用于时域连贯（失败则退化为逐帧独立抠像，仍可用）
    let useFlow = false;
    try {
      if (!isRaftReady()) {
        const ensured = await ensurePresetModel('raft-optical-flow');
        if (ensured.ok) {
          const raftResult = await loadRaftModel();
          useFlow = raftResult.ok;
        }
      } else {
        useFlow = true;
      }
    } catch {
      useFlow = false;
    }

    const out = document.createElement('canvas');
    out.width = pw;
    out.height = ph;
    const octx = out.getContext('2d')!;
    const stream = out.captureStream(FPS);
    const mime = pickVideoMime();

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    } catch {
      throw new Error('当前浏览器不支持 MediaRecorder 视频重编码');
    }
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    const encodeDone = new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: mime }));
    });

    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const totalFrames = Math.max(1, Math.floor(duration * FPS));
    const step = 1000 / FPS;

    recorder.start();
    let prevAlpha: Float32Array | null = null;
    let prevFrame: HTMLCanvasElement | null = null;
    for (let i = 0; i < totalFrames; i++) {
      const t = i / FPS;
      const frame = await grabVideoFrame(video, t, pw, ph);
      const mres = await removeBackground(frame, {
        modelId,
        edgeFeather: effects.matting.edgeFeather / 32,
        despill: effects.matting.despill,
      });
      let alpha = mres.alpha;
      if (useFlow && prevAlpha && prevFrame) {
        try {
          const flow = await estimateOpticalFlowRAFT(prevFrame, frame);
          if (flow) {
            const warped = propagateAlphaByFlow(prevAlpha, flow, pw, ph);
            const blended = new Float32Array(pw * ph);
            for (let k = 0; k < pw * ph; k++) blended[k] = clamp(alpha[k] * 0.7 + warped[k] * 0.3, 0, 1);
            alpha = blended;
          }
        } catch {
          /* 光流失败则沿用当前帧 alpha */
        }
      }
      const rgba = composeRgbaFromAlpha(frame, alpha);
      octx.drawImage(rgba, 0, 0);
      updateNodeData(id, {
        status: 'generating',
        error: '',
        params: {
          ...params,
          generationProgress: [{
            progress: Math.round(((i + 1) / totalFrames) * 100),
            message: `一键抠图·视频 ${i + 1}/${totalFrames}${useFlow ? '（RAFT 时域连贯）' : ''}`,
            stage: 'matting-video',
          }],
        },
      });
      await sleep(step);
      if (i % 4 === 0) await yieldToUI();
      prevAlpha = mres.alpha;
      prevFrame = frame;
    }
    recorder.stop();
    const blob = await encodeDone;
    emitClientVideoResultNode(blob, pw, ph, duration, '一键抠图·视频');
  }

  function renderColorPanelBroken() {
    return null;
  }

  function renderRuntimeLinks(status: LocalPostBackendStatus | null, testId: string) {
    if (!status?.downloadUrl && !status?.docsUrl) return null;
    return (
      <div className="mt-3 flex flex-wrap gap-2" data-testid={testId}>
        {status.downloadUrl ? (
          <a
            href={status.downloadUrl}
            target="_blank"
            rel="noreferrer"
            className="nodrag rounded-full border border-[#2d3236] bg-[#121518] px-3 py-1.5 text-[11px] text-[#e7e7e7] transition hover:border-[#46515d] hover:bg-[#1b2024]"
            onPointerDown={stopCanvasPointer}
          >
            下载 Runtime
          </a>
        ) : null}
        {status.docsUrl ? (
          <a
            href={status.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="nodrag rounded-full border border-[#2d3236] bg-[#121518] px-3 py-1.5 text-[11px] text-[#9f9f9f] transition hover:border-[#46515d] hover:bg-[#1b2024] hover:text-[#e7e7e7]"
            onPointerDown={stopCanvasPointer}
          >
            查看文档
          </a>
        ) : null}
      </div>
    );
  }

  function renderRuntimeCapability(status: LocalPostBackendStatus | null) {
    if (!status) return '图片 / 视频能力未上报';
    const supportImage = status.supportsImage !== false;
    const supportVideo = status.supportsVideo === true;
    if (supportImage && supportVideo) return '支持图片 / 视频';
    if (supportImage) return '仅支持图片';
    if (supportVideo) return '仅支持视频';
    return '能力未声明';
  }

  function renderCommonInstallPaths(status: LocalPostBackendStatus | null) {
    const paths = Array.isArray(status?.commonInstallPaths) ? status.commonInstallPaths.filter(Boolean).slice(0, 3) : [];
    if (!paths.length) return '常见安装路径未预置';
    return paths.join(' / ');
  }

  function renderRefreshRuntimeButton(testId: string) {
    return (
      <button
        type="button"
        className="nodrag rounded-full border border-[#2d3236] bg-[#121518] px-3 py-1.5 text-[11px] text-[#e7e7e7] transition hover:border-[#46515d] hover:bg-[#1b2024] disabled:cursor-not-allowed disabled:opacity-60"
        onPointerDown={stopCanvasPointer}
        onClick={() => void refreshLocalPostRuntimes()}
        disabled={isRefreshingRuntimes}
        data-testid={testId}
      >
        {isRefreshingRuntimes ? '探测中...' : '一键探测'}
      </button>
    );
  }

  function renderRuntimeDoctorButton(testId: string) {
    return (
      <button
        type="button"
        className="nodrag rounded-full border border-[#24564a] bg-[#102a23] px-3 py-1.5 text-[11px] text-[#d8fff7] transition hover:border-[#2d7b66] hover:bg-[#123429] disabled:cursor-not-allowed disabled:opacity-60"
        onPointerDown={stopCanvasPointer}
        onClick={() => void runRuntimeDoctor({ force: true })}
        disabled={isRunningRuntimeDoctor}
        data-testid={testId}
      >
        {isRunningRuntimeDoctor ? '自检中...' : '安装后一键自检'}
      </button>
    );
  }

  function renderRuntimeDoctorStatusLabel(status: LocalPostDoctorRuntime['status']) {
    if (status === 'ok') return '自检通过';
    if (status === 'warn') return '部分通过';
    return '自检失败';
  }

  function renderRuntimeDoctorStatusClass(status: LocalPostDoctorRuntime['status']) {
    if (status === 'ok') return 'bg-emerald-500/12 text-emerald-200';
    if (status === 'warn') return 'bg-amber-500/12 text-amber-100';
    return 'bg-rose-500/12 text-rose-100';
  }

  function renderRuntimeDoctorPanel(runtime: LocalPostDoctorRuntime | undefined, testId: string) {
    if (!runtime) {
      return (
        <div className="mt-3 rounded-2xl border border-dashed border-[#2d3236] bg-[#0c1013] px-3 py-3 text-[11px] leading-5 text-[#8d97a2]" data-testid={testId}>
          安装完成后点“安装后一键自检”，这里会校验 `gmic.exe`、`oiiotool.exe` 或当前 OCIO config 是否真的能跑通，并同步检查最新版。
        </div>
      );
    }

    return (
      <div className="mt-3 rounded-2xl border border-[#2d3236] bg-[#0c1013] px-3 py-3 text-[11px] leading-5 text-[#9f9f9f]" data-testid={testId}>
        <div className="flex items-center justify-between gap-3">
          <div className="font-medium text-[#e7e7e7]">安装后一键自检</div>
          <div className={`rounded-full px-2 py-0.5 text-[10px] ${renderRuntimeDoctorStatusClass(runtime.status)}`}>
            {renderRuntimeDoctorStatusLabel(runtime.status)}
          </div>
        </div>
        <div className="mt-2 space-y-1.5">
          <div>自检结论：{runtime.summary}</div>
          {runtime.installedVersion ? <div>本机版本：{runtime.installedVersion}</div> : null}
          {runtime.detectedConfigPath ? <div>当前 Config：{runtime.detectedConfigPath}</div> : null}
          {runtime.configSummary ? <div>Config 校验：{runtime.configSummary}</div> : null}
          {runtime.checkedCommand?.length ? <div>检查命令：{runtime.checkedCommand.join(' ')}</div> : null}
          {runtime.elapsedMs ? <div>耗时：{runtime.elapsedMs} ms</div> : null}
          {runtime.update?.summary ? <div>更新检查：{runtime.update.summary}</div> : null}
          {runtime.update?.releaseUrl ? (
            <div>
              最新发布页：
              <a
                href={runtime.update.releaseUrl}
                target="_blank"
                rel="noreferrer"
                className="ml-1 text-[#7cc4ff] transition hover:text-[#9ad1ff]"
                onPointerDown={stopCanvasPointer}
              >
                {runtime.update.sourceLabel || '打开'}
              </a>
            </div>
          ) : null}
          {runtime.suggestions?.length ? <div>处理建议：{runtime.suggestions.join(' / ')}</div> : null}
          {runtime.stderr ? <div>错误输出：{runtime.stderr}</div> : null}
          {!runtime.stderr && runtime.stdout ? <div>命令输出：{runtime.stdout}</div> : null}
          {runtimeDoctor.checkedAt ? <div>最近自检：{runtimeDoctor.checkedAt}</div> : null}
        </div>
      </div>
    );
  }

  function renderRuntimeInlineHint({
    enabled,
    message,
    testId,
  }: {
    enabled: boolean;
    message: string;
    testId: string;
  }) {
    if (!enabled) return null;
    return (
      <div
        className="rounded-2xl border border-amber-500/20 bg-amber-500/8 px-3 py-2 text-[11px] leading-5 text-amber-100/90"
        data-testid={testId}
      >
        {message}
      </div>
    );
  }

  function renderColorPanel() {
    const curvePresetMap: Record<CurveChannelKey, Array<{ value: string; label: string }>> = {
      master: [
        { value: 'linear', label: '线性' },
        { value: 'soft-contrast', label: '柔和对比' },
        { value: 'film-s', label: '电影 S 曲线' },
        { value: 'lifted-matte', label: '哑光抬黑' },
      ],
      red: [
        { value: 'linear', label: '线性' },
        { value: 'film-warm', label: '暖高光' },
        { value: 'teal-shadows', label: '青影调' },
        { value: 'crisp-highlights', label: '高光提亮' },
      ],
      green: [
        { value: 'linear', label: '线性' },
        { value: 'film-balance', label: '胶片平衡' },
        { value: 'lift-shadows', label: '暗部抬升' },
        { value: 'crisp-highlights', label: '高光提亮' },
      ],
      blue: [
        { value: 'linear', label: '线性' },
        { value: 'teal-shadows', label: '青影调' },
        { value: 'cool-highlights', label: '冷高光' },
        { value: 'lift-shadows', label: '暗部抬升' },
      ],
    };

    const activeCurveConfig = curveChannelTab === 'master'
      ? {
          preset: effects.color.masterCurve,
          points: effects.color.masterCurvePoints,
          title: '主曲线编辑器',
          onPresetChange: (value: string) => patchEffect('color', { enabled: true, preset: 'custom', masterCurve: value as PostEffectsState['color']['masterCurve'], masterCurvePoints: presetCurvePoints(value, 'master') }),
          onPointsChange: (value: PostCurvePoint[]) => patchEffect('color', { enabled: true, preset: 'custom', masterCurvePoints: value }),
          onReset: () => patchEffect('color', { enabled: true, preset: 'custom', masterCurvePoints: presetCurvePoints(effects.color.masterCurve, 'master') }),
          selectTestId: `post-field-${id}-color-master-curve`,
          editorTestId: `post-field-${id}-color-master-curve-editor`,
        }
      : curveChannelTab === 'red'
        ? {
            preset: effects.color.redCurve,
            points: effects.color.redCurvePoints,
            title: '红通道编辑器',
            onPresetChange: (value: string) => patchEffect('color', { enabled: true, preset: 'custom', redCurve: value as PostEffectsState['color']['redCurve'], redCurvePoints: presetCurvePoints(value, 'red') }),
            onPointsChange: (value: PostCurvePoint[]) => patchEffect('color', { enabled: true, preset: 'custom', redCurvePoints: value }),
            onReset: () => patchEffect('color', { enabled: true, preset: 'custom', redCurvePoints: presetCurvePoints(effects.color.redCurve, 'red') }),
            selectTestId: `post-field-${id}-color-red-curve`,
            editorTestId: `post-field-${id}-color-red-curve-editor`,
          }
        : curveChannelTab === 'green'
          ? {
              preset: effects.color.greenCurve,
              points: effects.color.greenCurvePoints,
              title: '绿通道编辑器',
              onPresetChange: (value: string) => patchEffect('color', { enabled: true, preset: 'custom', greenCurve: value as PostEffectsState['color']['greenCurve'], greenCurvePoints: presetCurvePoints(value, 'green') }),
              onPointsChange: (value: PostCurvePoint[]) => patchEffect('color', { enabled: true, preset: 'custom', greenCurvePoints: value }),
              onReset: () => patchEffect('color', { enabled: true, preset: 'custom', greenCurvePoints: presetCurvePoints(effects.color.greenCurve, 'green') }),
              selectTestId: `post-field-${id}-color-green-curve`,
              editorTestId: `post-field-${id}-color-green-curve-editor`,
            }
          : {
              preset: effects.color.blueCurve,
              points: effects.color.blueCurvePoints,
              title: '蓝通道编辑器',
              onPresetChange: (value: string) => patchEffect('color', { enabled: true, preset: 'custom', blueCurve: value as PostEffectsState['color']['blueCurve'], blueCurvePoints: presetCurvePoints(value, 'blue') }),
              onPointsChange: (value: PostCurvePoint[]) => patchEffect('color', { enabled: true, preset: 'custom', blueCurvePoints: value }),
              onReset: () => patchEffect('color', { enabled: true, preset: 'custom', blueCurvePoints: presetCurvePoints(effects.color.blueCurve, 'blue') }),
              selectTestId: `post-field-${id}-color-blue-curve`,
              editorTestId: `post-field-${id}-color-blue-curve-editor`,
            };

    return (
      <div className="grid gap-5 2xl:grid-cols-[0.9fr_1.5fr]">
        <div className="space-y-4">
          <CollapsiblePanelSection
            title="主调色台"
            note="先确定整体曝光、反差和色温，再进入曲线与二级精调。"
            collapsed={colorSectionsCollapsed.console}
            onToggle={() => toggleColorSection('console')}
          >
            <div className="grid gap-3 lg:grid-cols-2">
              <SelectField
                title="色彩预设"
                value={effects.color.preset || 'neutral'}
                options={POST_COLOR_PRESETS.map((item) => ({ value: item.value, label: item.label }))}
                onChange={(value) => {
                  const preset = POST_COLOR_PRESETS.find((item) => item.value === value);
                  if (!preset) return;
                  patchEffect('color', {
                    enabled: true,
                    preset: value as PostEffectsState['color']['preset'],
                    ...preset.patch,
                  });
                }}
                testId={`post-field-${id}-color-preset`}
              />
              <ToggleField title="启用高级调色" checked={effects.color.enabled} onChange={(value) => patchEffect('color', { enabled: value })} testId={`post-field-${id}-color-enabled`} />
            </div>
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <SliderField title="曝光" value={effects.color.exposure} min={-1} max={1} step={0.01} onChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', exposure: value })} testId={`post-field-${id}-color-exposure`} />
              <SliderField title="对比度" value={effects.color.contrast} min={-0.5} max={0.8} step={0.01} onChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', contrast: value })} testId={`post-field-${id}-color-contrast`} />
              <SliderField title="饱和度" value={effects.color.saturation} min={0} max={2} step={0.01} onChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', saturation: value })} testId={`post-field-${id}-color-saturation`} />
              <SliderField title="自然饱和" value={effects.color.vibrance} min={-1} max={1} step={0.01} onChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', vibrance: value })} testId={`post-field-${id}-color-vibrance`} />
              <SliderField title="色温" value={effects.color.temperature} min={-1} max={1} step={0.01} onChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', temperature: value })} testId={`post-field-${id}-color-temperature`} />
              <SliderField title="色调偏移" value={effects.color.tint} min={-1} max={1} step={0.01} onChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', tint: value })} testId={`post-field-${id}-color-tint`} />
              <SliderField title="色相偏移" value={effects.color.hue} min={-180} max={180} step={1} onChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', hue: value })} testId={`post-field-${id}-color-hue`} />
            </div>
          </CollapsiblePanelSection>

          <CollapsiblePanelSection
            title="四路色轮"
            note="参考达芬奇的 primaries 逻辑，把偏色和强度放在同一块处理。"
            collapsed={colorSectionsCollapsed.wheels}
            onToggle={() => toggleColorSection('wheels')}
          >
            <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
              <WheelCard title="Lift" color={effects.color.liftColor} onColorChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', liftColor: value })} amount={effects.color.liftAmount} onAmountChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', liftAmount: value })} colorTestId={`post-field-${id}-color-lift-color`} amountTestId={`post-field-${id}-color-lift-amount`} />
              <WheelCard title="Gamma" color={effects.color.gammaColor} onColorChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', gammaColor: value })} amount={effects.color.gammaAmount} onAmountChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', gammaAmount: value })} colorTestId={`post-field-${id}-color-gamma-color`} amountTestId={`post-field-${id}-color-gamma-amount`} />
              <WheelCard title="Gain" color={effects.color.gainColor} onColorChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', gainColor: value })} amount={effects.color.gainAmount} onAmountChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', gainAmount: value })} colorTestId={`post-field-${id}-color-gain-color`} amountTestId={`post-field-${id}-color-gain-amount`} />
              <WheelCard title="Offset" color={effects.color.offsetColor} onColorChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', offsetColor: value })} amount={effects.color.offsetAmount} onAmountChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', offsetAmount: value })} colorTestId={`post-field-${id}-color-offset-color`} amountTestId={`post-field-${id}-color-offset-amount`} />
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <SliderField title="Lift 基准" value={effects.color.lift} min={-1} max={1} step={0.01} onChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', lift: value })} testId={`post-field-${id}-color-lift`} />
              <SliderField title="Gamma 基准" value={effects.color.gamma} min={0.2} max={2} step={0.01} onChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', gamma: value })} testId={`post-field-${id}-color-gamma`} />
              <SliderField title="Gain 基准" value={effects.color.gain} min={0.2} max={2} step={0.01} onChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', gain: value })} testId={`post-field-${id}-color-gain`} />
              <SliderField title="Offset 基准" value={effects.color.offset} min={-1} max={1} step={0.01} onChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', offset: value })} testId={`post-field-${id}-color-offset`} />
            </div>
          </CollapsiblePanelSection>
        </div>

        <CollapsiblePanelSection
          title="调色工作区"
          note="按曲线、示波器、输出管理分域展开，默认更像专业调色工作台。"
          collapsed={colorSectionsCollapsed.workspace}
          onToggle={() => toggleColorSection('workspace')}
        >
          {renderRuntimeInlineHint({
            enabled: !postHealth.oiio?.configured || !postHealth.ocio?.configured,
            message: '当前未检测到完整 OIIO / OCIO 运行时，严格调色功能会先保留参数编辑，但生成时可能回退到本地链路。可在“模型下载 > 后期运行时依赖”里安装后再点一键自检。',
            testId: `post-color-runtime-inline-hint-${id}`,
          })}
          <div className="mb-4 flex flex-wrap gap-2">
            {[
              { id: 'curves' as const, label: '曲线', icon: Aperture },
              { id: 'scopes' as const, label: '示波器', icon: BarChart3 },
              { id: 'output' as const, label: '输出管理', icon: Settings2 },
            ].map((item) => {
              const Icon = item.icon;
              const active = colorWorkspaceTab === item.id;
              return (
                <button key={item.id} type="button" onPointerDown={stopCanvasPointer} onClick={() => setColorWorkspaceTab(item.id)} data-testid={`post-color-workspace-tab-${item.id}-${id}`} className={`nodrag inline-flex items-center gap-2 rounded-2xl border px-3 py-2 text-xs font-medium transition ${workspaceTabClass(active)}`}>
                  <Icon className="h-4 w-4" />
                  {item.label}
                </button>
              );
            })}
          </div>

          {colorWorkspaceTab === 'curves' ? (
            <div className="grid gap-4 xl:grid-cols-[1.16fr_0.84fr]">
              <div className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  {([
                    { id: 'master', label: '主曲线' },
                    { id: 'red', label: '红通道' },
                    { id: 'green', label: '绿通道' },
                    { id: 'blue', label: '蓝通道' },
                  ] as Array<{ id: CurveChannelKey; label: string }>).map((item) => (
                    <button key={item.id} type="button" onPointerDown={stopCanvasPointer} onClick={() => setCurveChannelTab(item.id)} data-testid={`post-color-curve-tab-${item.id}-${id}`} className={`nodrag rounded-2xl border px-3 py-2 text-xs font-medium transition ${workspaceTabClass(curveChannelTab === item.id)}`}>
                      {item.label}
                    </button>
                  ))}
                </div>
                <SelectField title="当前通道预设" value={activeCurveConfig.preset} options={curvePresetMap[curveChannelTab]} onChange={activeCurveConfig.onPresetChange} testId={activeCurveConfig.selectTestId} />
                <CurveEditorField title={activeCurveConfig.title} channel={curveChannelTab} points={activeCurveConfig.points} onChange={activeCurveConfig.onPointsChange} onReset={activeCurveConfig.onReset} testId={activeCurveConfig.editorTestId} />
              </div>
              <PanelSection title="二级 HSL 与打印" note="曲线旁保留二级 HSL 和胶片打印，用于风格收口。">
                <div className="grid gap-3 lg:grid-cols-2">
                  <SliderField title="二级 HSL 中心" value={effects.color.secondaryHueCenter} min={0} max={360} step={1} onChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', secondaryHueCenter: value })} testId={`post-field-${id}-color-secondary-center`} />
                  <SliderField title="二级 HSL 范围" value={effects.color.secondaryHueRange} min={5} max={180} step={1} onChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', secondaryHueRange: value })} testId={`post-field-${id}-color-secondary-range`} />
                  <SliderField title="二级饱和偏置" value={effects.color.secondarySaturationBias} min={-1} max={1} step={0.01} onChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', secondarySaturationBias: value })} testId={`post-field-${id}-color-secondary-sat`} />
                  <SliderField title="二级亮度偏置" value={effects.color.secondaryLumaBias} min={-1} max={1} step={0.01} onChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', secondaryLumaBias: value })} testId={`post-field-${id}-color-secondary-luma`} />
                </div>
                <div className="mt-3">
                  <SelectField title="胶片打印模拟" value={effects.color.filmPrint} options={[{ value: 'none', label: '关闭' }, { value: 'kodak-2383', label: 'Kodak 2383' }, { value: 'kodak-5219', label: 'Kodak 5219' }, { value: 'fuji-3513', label: 'Fuji 3513' }]} onChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', filmPrint: value as PostEffectsState['color']['filmPrint'] })} testId={`post-field-${id}-color-film-print`} />
                </div>
              </PanelSection>
            </div>
          ) : null}

          {colorWorkspaceTab === 'scopes' ? (
            <ScopeWorkbench
              sourceKind={sourceKind}
              sourceUrl={resultUrl || sourceUrl}
              color={effects.color}
              linkedChannel={curveChannelTab}
              onLinkedChannelChange={setCurveChannelTab}
              testId={`post-color-scopes-${id}`}
            />
          ) : null}

          {colorWorkspaceTab === 'output' ? (
            <div className="grid gap-4 xl:grid-cols-[1.04fr_0.96fr]">
              <PanelSection title="色彩空间与 OCIO" note="支持内置、ACES 与自定义 OCIO config，为后续真实工作室色彩管理留出执行位。">
                <div className="grid gap-3 lg:grid-cols-2">
                  <SelectField title="输入色彩空间" value={effects.color.colorSpaceIn} options={[{ value: 'sRGB', label: 'sRGB' }, { value: 'Rec.709', label: 'Rec.709' }, { value: 'ACEScg', label: 'ACEScg' }]} onChange={(value) => patchEffect('color', { enabled: true, colorSpaceIn: value as PostEffectsState['color']['colorSpaceIn'] })} testId={`post-field-${id}-color-space-in`} />
                  <SelectField title="输出色彩空间" value={effects.color.colorSpaceOut} options={[{ value: 'sRGB', label: 'sRGB' }, { value: 'Rec.709', label: 'Rec.709' }, { value: 'DCI-P3', label: 'DCI-P3' }]} onChange={(value) => patchEffect('color', { enabled: true, colorSpaceOut: value as PostEffectsState['color']['colorSpaceOut'] })} testId={`post-field-${id}-color-space-out`} />
                  <SelectField title="OCIO 配置" value={effects.color.ocioConfig} options={[{ value: 'builtin', label: '内置基础配置' }, { value: 'aces-1.3', label: 'ACES 1.3' }, { value: 'custom-file', label: '自定义 OCIO Config' }]} onChange={(value) => patchEffect('color', { enabled: true, ocioConfig: value as PostEffectsState['color']['ocioConfig'] })} testId={`post-field-${id}-color-ocio-config`} />
                  <SelectField title="OCIO 输出视口" value={effects.color.ocioDisplay} options={[{ value: 'web-srgb', label: 'Web sRGB' }, { value: 'rec709-monitor', label: 'Rec.709 监看' }, { value: 'p3-cinema', label: 'P3 Cinema' }]} onChange={(value) => patchEffect('color', { enabled: true, ocioDisplay: value as PostEffectsState['color']['ocioDisplay'] })} testId={`post-field-${id}-color-ocio-display`} />
                  <SelectField title="OCIO 视图" value={effects.color.ocioView} options={[{ value: 'default', label: '默认视图' }, { value: 'filmic', label: 'Filmic' }, { value: 'aces', label: 'ACES' }]} onChange={(value) => patchEffect('color', { enabled: true, ocioView: value as PostEffectsState['color']['ocioView'] })} testId={`post-field-${id}-color-ocio-view`} />
                  <SelectField title="OCIO 执行" value={effects.color.ocioExecutionMode} options={[{ value: 'auto', label: '自动：Wrapper 优先' }, { value: 'wrapper-only', label: '仅 Wrapper' }, { value: 'fallback-only', label: '仅本地回退' }]} onChange={(value) => patchEffect('color', { enabled: true, ocioExecutionMode: value as PostEffectsState['color']['ocioExecutionMode'] })} testId={`post-field-${id}-color-ocio-execution-mode`} />
                </div>
                <div className="mt-3">
                  <SliderField title="OCIO 强度" value={effects.color.ocioLookStrength} min={0} max={1} step={0.01} onChange={(value) => patchEffect('color', { enabled: true, ocioLookStrength: value })} testId={`post-field-${id}-color-ocio-strength`} />
                </div>
              </PanelSection>
              <PanelSection title="LUT 与配置文件" note="LUT 与 OCIO config 拆分展示，便于确认当前真正挂载的文件。">
                <div className="grid gap-3">
                  <button type="button" className="nodrag rounded-2xl border border-[#2d3236] bg-[#121518] px-3 py-3 text-sm text-[#eef3f8] transition hover:border-[#46515d] hover:bg-[#1b2024]" onPointerDown={stopCanvasPointer} onClick={() => lutPickerRef.current?.click()} data-testid={`post-lut-button-${id}`}>导入 LUT</button>
                  <div className="rounded-2xl border border-dashed border-[#2d3236] bg-[#121518] px-3 py-3 text-xs text-[#9f9f9f]" data-testid={`post-lut-status-${id}`}>
                    <div className="font-medium text-[#e7e7e7]">{effects.color.lutAssetName ? `已接入 LUT：${effects.color.lutAssetName}` : '尚未接入 LUT 文件'}</div>
                    <div className="mt-1 leading-5">{effects.color.lutAssetName ? '当前会随本地后期请求一并上传，可继续叠加曲线、二级 HSL 和 OCIO 视图设置。' : '支持导入 .cube / .3dl LUT 文件；适合做胶片风格和品牌 Look 套版。'}</div>
                  </div>
                  <button type="button" className="nodrag rounded-2xl border border-[#2d3236] bg-[#121518] px-3 py-3 text-sm text-[#eef3f8] transition hover:border-[#46515d] hover:bg-[#1b2024]" onPointerDown={stopCanvasPointer} onClick={() => ocioConfigPickerRef.current?.click()}>导入 OCIO Config</button>
                  <div className="rounded-2xl border border-dashed border-[#2d3236] bg-[#121518] px-3 py-3 text-xs text-[#9f9f9f]">
                    <div className="font-medium text-[#e7e7e7]">{effects.color.ocioConfigAssetName ? `已接入 OCIO Config：${effects.color.ocioConfigAssetName}` : '尚未接入自定义 OCIO Config'}</div>
                    <div className="mt-1 leading-5">{effects.color.ocioConfig === 'custom-file' ? '当前会优先把自定义 config 路由到 OCIO wrapper；若 wrapper 不可用，结果区会明确显示回退原因。' : '如果需要走工作室自定义色彩管理，可切换到“自定义 OCIO Config”后导入 .ocio 文件。'}</div>
                  </div>
                  <div
                    className={`rounded-2xl border px-3 py-3 text-xs leading-5 ${
                      ocioValidation.severity === 'error'
                        ? 'border-rose-500/30 bg-rose-500/10 text-rose-100'
                        : ocioValidation.severity === 'warn'
                          ? 'border-amber-500/30 bg-amber-500/10 text-amber-100'
                          : 'border-emerald-500/20 bg-emerald-500/8 text-emerald-100'
                    }`}
                    data-testid={`post-ocio-validation-${id}`}
                    >
                    <div className="font-medium">{ocioValidation.title}</div>
                    <div className="mt-2 space-y-1">
                      {ocioValidation.details.map((detail, index) => (
                        <div key={`${detail}-${index}`}>{detail}</div>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-[#2d3236] bg-[#0f1317] px-3 py-3 text-xs text-[#9f9f9f]" data-testid={`post-oiio-runtime-status-${id}`}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="font-medium text-[#e7e7e7]">OIIO 严格图片调色</div>
                      <div className={`rounded-full px-2 py-0.5 text-[10px] ${postHealth.oiio?.configured ? 'bg-emerald-500/12 text-emerald-200' : 'bg-amber-500/12 text-amber-100'}`}>
                        {postHealth.oiio?.configured ? '已可接管图片调色' : '当前未接管'}
                      </div>
                    </div>
                    <div className="mt-2 space-y-1.5 leading-5">
                      <div>接管范围：图片色彩空间转换 / LUT / 自定义 OCIO Config</div>
                      <div>运行时：{postHealth.oiio?.runtimeName || 'OpenImageIO oiiotool'}</div>
                      <div>能力：{renderRuntimeCapability(postHealth.oiio)}</div>
                      <div>后端探测路径：{postHealth.oiio?.detectedPath || '未检测到 oiiotool.exe'}</div>
                      <div>默认 OCIO Config：{postHealth.oiio?.detectedConfigPath || '未检测到 HMDAO_POST_OIIO_OCIO_CONFIG / HMDAO_POST_OCIO_CONFIG / OCIO'}</div>
                      <div>环境变量：{postHealth.oiio?.envPath || 'HMDAO_POST_OIIO_PATH'}{postHealth.oiio?.envCommand ? ` / ${postHealth.oiio.envCommand}` : ''}</div>
                      <div>常见安装路径：{renderCommonInstallPaths(postHealth.oiio)}</div>
                      <div>安装提示：{postHealth.oiio?.installHint || '安装 oiiotool 后写入 HMDAO_POST_OIIO_PATH，并提供可用的 OCIO Config。'}</div>
                      <div>成功提示：{postHealth.oiio?.successHint || '探测成功后会自动接管图片严格调色。'}</div>
                      <div>上次 OIIO 链路：{String(lastProcessingMeta.oiioBackendLabel || '未记录')}</div>
                      <div>上次默认 Config：{String(lastProcessingMeta.oiioDetectedConfigPath || '未记录')}</div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {renderRefreshRuntimeButton(`post-oiio-runtime-refresh-${id}`)}
                      {renderRuntimeDoctorButton(`post-oiio-runtime-doctor-${id}`)}
                    </div>
                    {renderRuntimeDoctorPanel(runtimeDoctor.runtimes.oiio, `post-oiio-runtime-doctor-panel-${id}`)}
                    {renderRuntimeLinks(postHealth.oiio, `post-oiio-runtime-links-${id}`)}
                  </div>
                  <div className="rounded-2xl border border-[#2d3236] bg-[#0f1317] px-3 py-3 text-xs text-[#9f9f9f]" data-testid={`post-ocio-runtime-status-${id}`}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="font-medium text-[#e7e7e7]">OCIO Runtime 状态</div>
                      <div className={`rounded-full px-2 py-0.5 text-[10px] ${postHealth.ocio?.configured ? 'bg-emerald-500/12 text-emerald-200' : 'bg-amber-500/12 text-amber-100'}`}>
                        {postHealth.ocio?.configured ? '外部 Wrapper 已配置' : '当前走本地回退 / 示例链'}
                      </div>
                    </div>
                    <div className="mt-2 space-y-1.5 leading-5">
                      <div>当前配置模式：{effects.color.ocioConfig === 'custom-file' ? '自定义 .ocio' : effects.color.ocioConfig === 'aces-1.3' ? 'ACES 1.3' : '内置基础配置'}</div>
                      <div>当前文件状态：{effects.color.ocioConfigAssetName || '未挂载自定义 config 文件'}</div>
                      <div>执行模式：{effects.color.ocioExecutionMode === 'wrapper-only' ? '仅 Wrapper' : effects.color.ocioExecutionMode === 'fallback-only' ? '仅本地回退' : '自动优先 Wrapper'}</div>
                      <div>配置校验：{effects.color.ocioConfigAssetName ? (isSupportedOcioConfigName(effects.color.ocioConfigAssetName) ? '文件扩展名通过' : '文件扩展名不在支持范围') : '尚未挂载文件'}</div>
                      <div>结构校验：{ocioConfigInspection.status === 'loading' ? '正在检查内容结构' : ocioConfigInspection.title}</div>
                      <div>文件格式：{ocioConfigInspection.formatLabel}</div>
                      <div>Profile 版本：{ocioConfigInspection.profileVersion || '未检测到'}</div>
                      <div>检测到的结构：{ocioConfigInspection.detectedSections.length ? ocioConfigInspection.detectedSections.join(' / ') : '尚未识别'}</div>
                      <div>运行时：{postHealth.ocio?.runtimeName || 'OpenColorIO Runtime'}</div>
                      <div>能力：{renderRuntimeCapability(postHealth.ocio)}</div>
                      <div>后端探测路径：{postHealth.ocio?.detectedPath || '未检测到外部 runtime 路径'}</div>
                      <div>环境变量：{postHealth.ocio?.envPath || 'HMDAO_POST_OCIO_PATH'}{postHealth.ocio?.envCommand ? ` / ${postHealth.ocio.envCommand}` : ''}</div>
                      <div>常见安装路径：{renderCommonInstallPaths(postHealth.ocio)}</div>
                      <div>示例脚本：{postHealth.ocio?.exampleRuntimePath || 'server/local_post_example_ocio.py'}</div>
                      <div>安装提示：{postHealth.ocio?.installHint || '安装 OCIO Runtime 后把路径写入 HMDAO_POST_OCIO_PATH。'}</div>
                      <div>成功提示：{postHealth.ocio?.successHint || '探测成功后会优先走外部 OCIO 链路。'}</div>
                      <div>上次输出引擎：{String(lastResultMeta.processingEngine || '尚未生成')}</div>
                      <div>上次 OCIO 链路：{String(lastProcessingMeta.ocioBackendLabel || '未记录')}</div>
                      <div>上次执行模式：{String(lastProcessingMeta.ocioExecutionMode || '未记录')}</div>
                      <div>上次配置落点：{String(lastProcessingMeta.ocioConfigName || lastProcessingMeta.ocioConfigPath || '未记录')}</div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {renderRefreshRuntimeButton(`post-ocio-runtime-refresh-${id}`)}
                      {renderRuntimeDoctorButton(`post-ocio-runtime-doctor-${id}`)}
                    </div>
                    {renderRuntimeDoctorPanel(runtimeDoctor.runtimes.ocio, `post-ocio-runtime-doctor-panel-${id}`)}
                    {renderRuntimeLinks(postHealth.ocio, `post-ocio-runtime-links-${id}`)}
                  </div>
                </div>
              </PanelSection>
            </div>
          ) : null}
        </CollapsiblePanelSection>
      </div>
    );
  }

  function renderUpscalePanel() {
    const resolvedRoute = effects.upscale.routePolicy !== 'auto'
      ? effects.upscale.routePolicy
      : effects.upscale.model === 'supir-detail'
        ? 'supir'
        : effects.upscale.model === 'fsr-fast'
          ? 'fsr-preview'
          : 'realbasicvsr';
    const backendStatus = postHealth.upscale[resolvedRoute] || null;
    const executionModeLabel = effects.upscale.executionMode === 'wrapper-only'
      ? '仅 Wrapper'
      : effects.upscale.executionMode === 'fallback-only'
        ? '仅本地回退'
        : '自动优先 Wrapper';
    return (
      <div className="grid gap-4 xl:grid-cols-[1.06fr_0.94fr]">
        <PanelSection title="增强策略" note="把倍率、模型和调度并排展开，避免所有选项挤在一列。">
          {renderRuntimeInlineHint({
            enabled: !backendStatus?.configured,
            message: '当前未检测到所选高清运行时，参数仍可编辑，但生成会回退到本地预览链路。安装完成后刷新状态即可同步到节点。',
            testId: `post-upscale-runtime-inline-hint-${id}`,
          })}
          <div className="grid gap-3 lg:grid-cols-2">
            <ToggleField title="启用高清放大" checked={effects.upscale.enabled} onChange={(value) => patchEffect('upscale', { enabled: value })} testId={`post-field-${id}-upscale-enabled`} />
            <SelectField title="放大倍率" value={String(effects.upscale.scale)} options={[{ value: '1', label: '1x' }, { value: '2', label: '2x' }, { value: '4', label: '4x' }, { value: '8', label: '8x' }]} onChange={(value) => patchEffect('upscale', { enabled: true, scale: Number(value) as 1 | 2 | 4 | 8 })} testId={`post-field-${id}-upscale-scale`} />
            <SelectField title="质量模式" value={effects.upscale.mode} options={[{ value: 'preview', label: '快速预览' }, { value: 'balanced', label: '均衡输出' }, { value: 'detail', label: '细节优先' }]} onChange={(value) => patchEffect('upscale', { enabled: true, mode: value as PostEffectsState['upscale']['mode'] })} testId={`post-field-${id}-upscale-mode`} />
            <SelectField title="算法路线" value={effects.upscale.model} options={[{ value: 'fsr-fast', label: 'FSR 快速预览' }, { value: 'realesrgan-balanced', label: 'Real-ESRGAN 均衡' }, { value: 'realbasicvsr-video', label: 'RealBasicVSR 视频' }, { value: 'supir-detail', label: 'SUPIR 细节强化' }]} onChange={(value) => patchEffect('upscale', { enabled: true, model: value as PostEffectsState['upscale']['model'] })} testId={`post-field-${id}-upscale-model`} />
            <SelectField title="调度策略" value={effects.upscale.routePolicy} options={[{ value: 'auto', label: '自动推荐' }, { value: 'fsr-preview', label: 'FSR 预览' }, { value: 'realbasicvsr', label: 'RealBasicVSR' }, { value: 'supir', label: 'SUPIR 细节' }]} onChange={(value) => patchEffect('upscale', { enabled: true, routePolicy: value as PostEffectsState['upscale']['routePolicy'] })} testId={`post-field-${id}-upscale-route-policy`} />
            <SelectField title="执行模式" value={effects.upscale.executionMode} options={[{ value: 'auto', label: '自动：Wrapper 优先' }, { value: 'wrapper-only', label: '仅 Wrapper' }, { value: 'fallback-only', label: '仅本地回退' }]} onChange={(value) => patchEffect('upscale', { enabled: true, executionMode: value as PostEffectsState['upscale']['executionMode'] })} testId={`post-field-${id}-upscale-execution-mode`} />
          </div>
        </PanelSection>
        <PanelSection title="细节修复" note="把 Tile、显存档位和去噪锐化单独放右侧，适合边看预览边微调。">
          <div className="grid gap-3 lg:grid-cols-2">
            <SelectField title="Tile 分块" value={String(effects.upscale.tileSize)} options={[{ value: '512', label: '512' }, { value: '768', label: '768' }, { value: '1024', label: '1024' }]} onChange={(value) => patchEffect('upscale', { enabled: true, tileSize: Number(value) as PostEffectsState['upscale']['tileSize'] })} testId={`post-field-${id}-upscale-tile-size`} />
            <SelectField title="显存档位" value={effects.upscale.gpuTier} options={[{ value: 'auto', label: '自动' }, { value: '8g-safe', label: '8G 安全档' }, { value: 'max-quality', label: '极致画质' }]} onChange={(value) => patchEffect('upscale', { enabled: true, gpuTier: value as PostEffectsState['upscale']['gpuTier'] })} testId={`post-field-${id}-upscale-gpu-tier`} />
            <ToggleField title="接缝修复" checked={effects.upscale.seamFix} onChange={(value) => patchEffect('upscale', { enabled: true, seamFix: value })} testId={`post-field-${id}-upscale-seam-fix`} />
          </div>
          <div className="mt-3 grid gap-3">
            <SliderField title="去噪" value={effects.upscale.denoise} min={0} max={1} step={0.01} onChange={(value) => patchEffect('upscale', { enabled: true, denoise: value })} testId={`post-field-${id}-upscale-denoise`} />
            <SliderField title="锐化" value={effects.upscale.sharpen} min={0} max={1} step={0.01} onChange={(value) => patchEffect('upscale', { enabled: true, sharpen: value })} testId={`post-field-${id}-upscale-sharpen`} />
            <SliderField title="时序稳定" value={effects.upscale.temporalStability} min={0} max={1} step={0.01} onChange={(value) => patchEffect('upscale', { enabled: true, temporalStability: value })} testId={`post-field-${id}-upscale-temporal-stability`} />
          </div>
          <div className="mt-3 rounded-2xl border border-[#2d3236] bg-[#0f1317] px-3 py-3 text-xs text-[#9f9f9f]" data-testid={`post-upscale-runtime-status-${id}`}>
            <div className="flex items-center justify-between gap-3">
              <div className="font-medium text-[#e7e7e7]">高清 Runtime 状态</div>
              <div className={`rounded-full px-2 py-0.5 text-[10px] ${backendStatus?.configured ? 'bg-emerald-500/12 text-emerald-200' : 'bg-amber-500/12 text-amber-100'}`}>
                {backendStatus?.configured ? '外部 Wrapper 已配置' : '当前走本地回退 / 示例链'}
              </div>
            </div>
            <div className="mt-2 space-y-1.5 leading-5">
              <div>当前路由：{resolvedRoute}</div>
              <div>执行模式：{executionModeLabel}</div>
              <div>当前模型：{effects.upscale.model}</div>
              <div>倍率 / Tile：{effects.upscale.scale}x / {effects.upscale.tileSize}</div>
              <div>运行时：{backendStatus?.runtimeName || '高清 Wrapper'}</div>
              <div>能力：{renderRuntimeCapability(backendStatus)}</div>
              <div>后端探测路径：{backendStatus?.detectedPath || '未检测到外部 runtime 路径'}</div>
              <div>环境变量：{backendStatus?.envPath || '未记录'}{backendStatus?.envCommand ? ` / ${backendStatus.envCommand}` : ''}</div>
              <div>常见安装路径：{renderCommonInstallPaths(backendStatus)}</div>
              <div>Wrapper 脚本：{backendStatus?.wrapperScript || '未记录'}</div>
              <div>示例脚本：{backendStatus?.exampleRuntimePath || 'server/local_post_example_realbasicvsr.py'}</div>
              <div>安装提示：{backendStatus?.installHint || '请把外部高清运行入口写入对应 HMDAO_POST_*_PATH。'}</div>
              <div>成功提示：{backendStatus?.successHint || '探测成功后会优先走外部高清链路。'}</div>
              <div>上次输出引擎：{String(lastResultMeta.processingEngine || '尚未生成')}</div>
              <div>上次高清链路：{String(lastProcessingMeta.upscaleBackendLabel || '未记录')}</div>
              <div>上次回退原因：{String(lastProcessingMeta.upscaleFallbackReason || '未记录')}</div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {renderRefreshRuntimeButton(`post-upscale-runtime-refresh-${id}`)}
            </div>
            {renderRuntimeLinks(backendStatus, `post-upscale-runtime-links-${id}`)}
          </div>
        </PanelSection>
      </div>
    );
  }

  function renderBloomPanel() {
    return (
      <div className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
        <PanelSection title="辉光风格" note="先选预设和混合模式，再处理扩散参数。">
          {renderRuntimeInlineHint({
            enabled: !postHealth.gmic?.configured,
            message: '当前未检测到 G\'MIC CLI，Bloom / Grain 会临时走本地回退链路。安装 G\'MIC 后点一键自检，节点会自动切到真实处理。',
            testId: `post-gmic-runtime-inline-hint-${id}`,
          })}
          <div className="grid gap-3 lg:grid-cols-2">
            <ToggleField title="启用氛围辉光" checked={effects.bloom.enabled} onChange={(value) => patchEffect('bloom', { enabled: value })} testId={`post-field-${id}-bloom-enabled`} />
            <SelectField
              title="辉光预设"
              value={effects.bloom.preset}
              options={POST_BLOOM_PRESETS.map((item) => ({ value: item.value, label: item.label }))}
              onChange={(value) => {
                const preset = POST_BLOOM_PRESETS.find((item) => item.value === value);
                if (!preset) return;
                patchEffect('bloom', {
                  enabled: true,
                  preset: value as PostEffectsState['bloom']['preset'],
                  ...preset.patch,
                });
              }}
              testId={`post-field-${id}-bloom-preset`}
            />
            <SelectField title="混合模式" value={effects.bloom.blendMode} options={[{ value: 'screen', label: '滤色 Screen' }, { value: 'add', label: '叠加 Add' }, { value: 'softlight', label: '柔光 Soft Light' }]} onChange={(value) => patchEffect('bloom', { enabled: true, blendMode: value as PostEffectsState['bloom']['blendMode'] })} testId={`post-field-${id}-bloom-blend-mode`} />
          </div>
        </PanelSection>
        <PanelSection title="扩散参数" note="右侧保持宽松排版，避免半径和强度滑杆挤在一起。">
          <div className="grid gap-3">
            <SliderField title="阈值" value={effects.bloom.threshold} min={0.1} max={1} step={0.01} onChange={(value) => patchEffect('bloom', { enabled: true, threshold: value })} testId={`post-field-${id}-bloom-threshold`} />
            <SliderField title="辉光强度" value={effects.bloom.intensity} min={0} max={1.2} step={0.01} onChange={(value) => patchEffect('bloom', { enabled: true, intensity: value })} testId={`post-field-${id}-bloom-intensity`} />
            <SliderField title="扩散半径" value={effects.bloom.radius} min={1} max={48} step={1} onChange={(value) => patchEffect('bloom', { enabled: true, radius: value })} testId={`post-field-${id}-bloom-radius`} />
            <SliderField title="RGB 分离" value={effects.bloom.rgbSplit} min={0} max={0.2} step={0.01} onChange={(value) => patchEffect('bloom', { enabled: true, rgbSplit: value })} testId={`post-field-${id}-bloom-rgb-split`} />
            <SliderField title="镜头脏污强度" value={effects.bloom.dirtStrength} min={0} max={1} step={0.01} onChange={(value) => patchEffect('bloom', { enabled: true, dirtStrength: value })} testId={`post-field-${id}-bloom-dirt-strength`} />
          </div>
          <div className="mt-3 rounded-2xl border border-[#2d3236] bg-[#0f1317] px-3 py-3 text-xs text-[#9f9f9f]" data-testid={`post-gmic-runtime-status-${id}`}>
            <div className="flex items-center justify-between gap-3">
              <div className="font-medium text-[#e7e7e7]">G&apos;MIC Runtime 状态</div>
              <div className={`rounded-full px-2 py-0.5 text-[10px] ${postHealth.gmic?.configured ? 'bg-emerald-500/12 text-emerald-200' : 'bg-amber-500/12 text-amber-100'}`}>
                {postHealth.gmic?.configured ? '图片真实处理已接入' : '当前走 FFmpeg 回退'}
              </div>
            </div>
            <div className="mt-2 space-y-1.5 leading-5">
              <div>接管范围：Bloom / Grain / 细节修复</div>
              <div>运行时：{postHealth.gmic?.runtimeName || 'G\'MIC CLI'}</div>
              <div>能力：{renderRuntimeCapability(postHealth.gmic)}</div>
              <div>后端探测路径：{postHealth.gmic?.detectedPath || '未检测到 gmic.exe'}</div>
              <div>环境变量：{postHealth.gmic?.envPath || 'HMDAO_POST_GMIC_PATH'}{postHealth.gmic?.envCommand ? ` / ${postHealth.gmic.envCommand}` : ''}</div>
              <div>常见安装路径：{renderCommonInstallPaths(postHealth.gmic)}</div>
              <div>安装提示：{postHealth.gmic?.installHint || '安装 G\'MIC CLI 后把 gmic.exe 路径写入 HMDAO_POST_GMIC_PATH。'}</div>
              <div>成功提示：{postHealth.gmic?.successHint || '探测成功后 Bloom / Grain 会优先走 G\'MIC。'}</div>
              <div>上次 G&apos;MIC 链路：{String(lastProcessingMeta.gmicBackendLabel || '未记录')}</div>
              <div>上次执行阶段：{Array.isArray(lastProcessingMeta.gmicStagesApplied) && lastProcessingMeta.gmicStagesApplied.length ? (lastProcessingMeta.gmicStagesApplied as string[]).join(' / ') : '未记录'}</div>
              <div>上次回退原因：{String(lastProcessingMeta.gmicFallbackReason || '未记录')}</div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {renderRefreshRuntimeButton(`post-gmic-runtime-refresh-${id}`)}
              {renderRuntimeDoctorButton(`post-gmic-runtime-doctor-${id}`)}
            </div>
            {renderRuntimeDoctorPanel(runtimeDoctor.runtimes.gmic, `post-gmic-runtime-doctor-panel-${id}`)}
            {renderRuntimeLinks(postHealth.gmic, `post-gmic-runtime-links-${id}`)}
          </div>
        </PanelSection>
      </div>
    );
  }

  function renderDofPanel() {
    return (
      <div className="grid gap-4 xl:grid-cols-[1.02fr_0.98fr]">
        <PanelSection title="焦区与深度" note="左侧放焦区、深度引擎和过渡逻辑，便于先定清晰区域。">
          <div className="grid gap-3 lg:grid-cols-2">
            <ToggleField title="启用景深" checked={effects.dof.enabled} onChange={(value) => patchEffect('dof', { enabled: value })} testId={`post-field-${id}-dof-enabled`} />
            <SelectField title="景深模式" value={effects.dof.engine} options={[{ value: 'manual-focus-box', label: '手动焦区' }, { value: 'depth-anything-v3-base', label: 'Depth Anything V3 自动深度' }]} onChange={(value) => patchEffect('dof', { enabled: true, engine: value as PostEffectsState['dof']['engine'] })} testId={`post-field-${id}-dof-engine`} />
            <SelectField
              title="蒙版模式"
              value={effects.dof.maskMode}
              options={[{ value: 'focus-box', label: '焦区框' }, { value: 'paint-mask', label: '手绘蒙版（预留）' }]}
              onChange={(value) => patchEffect('dof', { enabled: true, maskMode: value as PostEffectsState['dof']['maskMode'] })}
              testId={`post-field-${id}-dof-mask-mode`}
            />
            <SelectField
              title="散景形状"
              value={effects.dof.shape}
              options={[{ value: 'round', label: '圆形' }, { value: 'hex', label: '六边形' }, { value: 'custom', label: '自定义（预留）' }]}
              onChange={(value) => patchEffect('dof', { enabled: true, shape: value as PostEffectsState['dof']['shape'] })}
              testId={`post-field-${id}-dof-shape`}
            />
            <ToggleField title="深度预览" checked={effects.dof.depthPreview} onChange={(value) => patchEffect('dof', { enabled: true, depthPreview: value })} testId={`post-field-${id}-dof-depth-preview`} />
          </div>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <SelectField
              title="过渡风格"
              value={effects.dof.transitionPreset}
              options={[{ value: 'hard', label: '硬切' }, { value: 'soft', label: '柔和' }, { value: 'cinematic', label: '电影感' }]}
              onChange={(value) => patchEffect('dof', { enabled: true, transitionPreset: value as PostEffectsState['dof']['transitionPreset'] })}
              testId={`post-field-${id}-dof-transition-preset`}
            />
            <SliderField title="自动深度权重" value={effects.dof.autoDepthStrength} min={0} max={1} step={0.01} onChange={(value) => patchEffect('dof', { enabled: true, autoDepthStrength: value })} testId={`post-field-${id}-dof-auto-depth-strength`} />
          </div>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <SliderField title="焦点 X" value={effects.dof.focusX} min={0} max={100} step={1} onChange={(value) => patchEffect('dof', { enabled: true, focusX: value })} testId={`post-field-${id}-dof-focus-x`} />
            <SliderField title="焦点 Y" value={effects.dof.focusY} min={0} max={100} step={1} onChange={(value) => patchEffect('dof', { enabled: true, focusY: value })} testId={`post-field-${id}-dof-focus-y`} />
            <SliderField title="焦区宽度" value={effects.dof.focusWidth} min={4} max={100} step={1} onChange={(value) => patchEffect('dof', { enabled: true, focusWidth: value })} testId={`post-field-${id}-dof-focus-width`} />
            <SliderField title="焦区高度" value={effects.dof.focusHeight} min={4} max={100} step={1} onChange={(value) => patchEffect('dof', { enabled: true, focusHeight: value })} testId={`post-field-${id}-dof-focus-height`} />
          </div>
        </PanelSection>
        <PanelSection title="模糊与素材" note="上传蒙版和 Bokeh 保持独立，不会和数值调节区互相遮挡。">
          <div className="grid gap-3">
            <SliderField title="虚化强度" value={effects.dof.blurStrength} min={0} max={1.2} step={0.01} onChange={(value) => patchEffect('dof', { enabled: true, blurStrength: value })} testId={`post-field-${id}-dof-blur-strength`} />
            <SliderField title="边缘羽化" value={effects.dof.feather} min={0} max={50} step={1} onChange={(value) => patchEffect('dof', { enabled: true, feather: value })} testId={`post-field-${id}-dof-feather`} />
            <SliderField title="自动深度融合" value={effects.dof.depthBlend} min={0} max={1} step={0.01} onChange={(value) => patchEffect('dof', { enabled: true, depthBlend: value })} testId={`post-field-${id}-dof-depth-blend`} />
            <SliderField title="手绘笔刷" value={effects.dof.brushSize} min={4} max={120} step={1} onChange={(value) => patchEffect('dof', { enabled: true, brushSize: value })} testId={`post-field-${id}-dof-brush-size`} />
            <ToggleField title="启用移轴效果" checked={effects.dof.tiltShift} onChange={(value) => patchEffect('dof', { enabled: true, tiltShift: value })} testId={`post-field-${id}-dof-tilt-shift`} />
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            className="nodrag rounded-xl border border-white/8 bg-[#111] px-3 py-2 text-sm text-[#ececec] hover:bg-[#181818]"
            onPointerDown={stopCanvasPointer}
            onClick={() => depthMaskPickerRef.current?.click()}
            data-testid={`post-depth-mask-button-${id}`}
          >
            导入深度蒙版
          </button>
          <button
            type="button"
            className="nodrag rounded-xl border border-white/8 bg-[#111] px-3 py-2 text-sm text-[#ececec] hover:bg-[#181818]"
            onPointerDown={stopCanvasPointer}
            onClick={() => bokehPickerRef.current?.click()}
            data-testid={`post-bokeh-button-${id}`}
          >
            导入自定义 Bokeh
          </button>
          </div>
          <div className="rounded-xl border border-dashed border-white/10 bg-[#111] px-3 py-3 text-xs text-[#9f9f9f]">
            <div className="font-medium text-[#e7e7e7]">
              {effects.dof.depthMaskAssetName ? `已接入深度蒙版：${effects.dof.depthMaskAssetName}` : '尚未接入手绘深度蒙版'}
            </div>
            <div className="mt-1">
              {effects.dof.bokehAssetName ? `自定义散景贴图：${effects.dof.bokehAssetName}` : '可上传 PNG 作为自定义散景贴图；未配置时默认使用圆形或六边形散景。'}
            </div>
          </div>
        </PanelSection>
      </div>
    );
  }

  function renderGrainPanel() {
    return (
      <div className="grid gap-4 xl:grid-cols-[0.88fr_1.12fr]">
        <PanelSection title="颗粒胶片感" note="预设和 ISO 放左侧，参数滑杆放右侧，观察会更直观。">
          <div className="grid gap-3 lg:grid-cols-2">
            <ToggleField title="启用电影颗粒" checked={effects.grain.enabled} onChange={(value) => patchEffect('grain', { enabled: value })} testId={`post-field-${id}-grain-enabled`} />
            <SelectField title="ISO 模拟" value={String(effects.grain.iso)} options={['100', '400', '800', '1600', '3200', '6400'].map((value) => ({ value, label: value }))} onChange={(value) => patchEffect('grain', { enabled: true, iso: Number(value) as PostEffectsState['grain']['iso'] })} testId={`post-field-${id}-grain-iso`} />
            <SelectField
              title="颗粒预设"
              value={effects.grain.preset}
              options={POST_GRAIN_PRESETS.map((item) => ({ value: item.value, label: item.label }))}
              onChange={(value) => {
                const preset = POST_GRAIN_PRESETS.find((item) => item.value === value);
                if (!preset) return;
                patchEffect('grain', {
                  enabled: true,
                  preset: value as PostEffectsState['grain']['preset'],
                  ...preset.patch,
                });
              }}
              testId={`post-field-${id}-grain-preset`}
            />
            <SelectField title="分布模型" value={effects.grain.distribution} options={[{ value: 'gaussian', label: '高斯' }, { value: 'poisson', label: '泊松' }, { value: 'lognormal', label: '对数正态' }]} onChange={(value) => patchEffect('grain', { enabled: true, distribution: value as PostEffectsState['grain']['distribution'] })} testId={`post-field-${id}-grain-distribution`} />
          </div>
        </PanelSection>
        <PanelSection title="颗粒控制" note="四条核心滑杆铺开显示，不再挤成竖排长列表。">
          <div className="grid gap-3">
            <SliderField title="颗粒强度" value={effects.grain.amount} min={0} max={1} step={0.01} onChange={(value) => patchEffect('grain', { enabled: true, amount: value })} testId={`post-field-${id}-grain-amount`} />
            <SliderField title="颗粒尺寸" value={effects.grain.size} min={0.5} max={4} step={0.1} onChange={(value) => patchEffect('grain', { enabled: true, size: value })} testId={`post-field-${id}-grain-size`} />
            <SliderField title="彩色颗粒" value={effects.grain.chroma} min={0} max={1} step={0.01} onChange={(value) => patchEffect('grain', { enabled: true, chroma: value })} testId={`post-field-${id}-grain-chroma`} />
            <SliderField title="暗部加重" value={effects.grain.shadowBoost} min={0} max={1} step={0.01} onChange={(value) => patchEffect('grain', { enabled: true, shadowBoost: value })} testId={`post-field-${id}-grain-shadow-boost`} />
          </div>
        </PanelSection>
      </div>
    );
  }

  function renderMattingPanel() {
    return (
      <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <PanelSection title="抠像逻辑" note="主体模式与执行路径独立展开，减少面板拥挤。">
          <div className="grid gap-3 lg:grid-cols-2">
            <ToggleField title="启用抠像 / 背景合成" checked={effects.matting.enabled} onChange={(value) => patchEffect('matting', { enabled: value })} testId={`post-field-${id}-matting-enabled`} />
            <ToggleField title="标签式分层" checked={effects.matting.tagLayering} onChange={(value) => patchEffect('matting', { enabled: true, tagLayering: value })} testId={`post-field-${id}-matting-tag-layering`} />
            <SelectField title="执行路径" value={effects.matting.engine} options={[{ value: 'upload-mask', label: '上传蒙版直通' }, { value: 'sam2-wrapper', label: 'SAM2 Wrapper（预留）' }, { value: 'rvm-wrapper', label: 'RVM Wrapper（预留）' }]} onChange={(value) => patchEffect('matting', { enabled: true, engine: value as PostEffectsState['matting']['engine'] })} testId={`post-field-${id}-matting-engine`} />
            <SelectField title="输出模式" value={effects.matting.mode} options={[{ value: 'keep-foreground', label: '保留前景' }, { value: 'replace-background', label: '替换背景' }, { value: 'remove-background', label: '移除背景' }]} onChange={(value) => patchEffect('matting', { enabled: true, mode: value as PostEffectsState['matting']['mode'] })} testId={`post-field-${id}-matting-mode`} />
          </div>
          <label className="mt-3 block">
            <FieldLabel title="主体提示" note="后续可复用到 SAM2 / RVM 执行链" />
            <input type="text" value={effects.matting.subjectPrompt} onChange={(event) => patchEffect('matting', { enabled: true, subjectPrompt: event.target.value })} onPointerDown={stopCanvasPointer} data-testid={`post-field-${id}-matting-subject-prompt`} className="nodrag w-full rounded-xl border border-white/8 bg-[#111] px-3 py-2 text-sm text-[#ececec] outline-none" placeholder="例如：人物主体、手持产品、车身主体" />
          </label>
        </PanelSection>
        <PanelSection title="蒙版与边缘" note="素材按钮放右侧，上方操作、下方精修，观察更方便。">
          <div className="grid gap-2 sm:grid-cols-2">
            <button type="button" className="nodrag rounded-xl border border-white/8 bg-[#111] px-3 py-2 text-sm text-[#ececec] hover:bg-[#181818]" onPointerDown={stopCanvasPointer} onClick={() => maskPickerRef.current?.click()} data-testid={`post-mask-button-${id}`}>上传蒙版</button>
            <button type="button" className="nodrag rounded-xl border border-white/8 bg-[#111] px-3 py-2 text-sm text-[#ececec] hover:bg-[#181818]" onPointerDown={stopCanvasPointer} onClick={() => backgroundPickerRef.current?.click()} data-testid={`post-background-button-${id}`}>选择背景</button>
          </div>
          <div className="mt-3 grid gap-3">
            <SliderField title="边缘羽化" value={effects.matting.edgeFeather} min={0} max={32} step={1} onChange={(value) => patchEffect('matting', { enabled: true, edgeFeather: value })} testId={`post-field-${id}-matting-edge-feather`} />
            <SliderField title="去溢色" value={effects.matting.despill} min={0} max={1} step={0.01} onChange={(value) => patchEffect('matting', { enabled: true, despill: value })} testId={`post-field-${id}-matting-despill`} />
            <ToggleField title="填充透明背景" checked={effects.matting.fillBackground} onChange={(value) => patchEffect('matting', { enabled: true, fillBackground: value })} testId={`post-field-${id}-matting-fill-background`} />
          </div>
        </PanelSection>
      </div>
    );
  }

  function renderTrackingPanel() {
    return (
      <div className="grid gap-4 xl:grid-cols-[0.96fr_1.04fr]">
        <PanelSection title="跟踪模式" note="引擎、模式和叠加入口在左侧，先定执行路径。">
          <div className="grid gap-3 lg:grid-cols-2">
            <ToggleField title="启用运动跟踪 / 素材叠加" checked={effects.tracking.enabled} onChange={(value) => patchEffect('tracking', { enabled: value })} testId={`post-field-${id}-tracking-enabled`} />
            <SelectField title="跟踪引擎" value={effects.tracking.trackerEngine} options={[{ value: 'manual', label: '手动叠加' }, { value: 'cotracker3-wrapper', label: 'CoTracker3 Wrapper（预留）' }]} onChange={(value) => patchEffect('tracking', { enabled: true, trackerEngine: value as PostEffectsState['tracking']['trackerEngine'] })} testId={`post-field-${id}-tracking-engine`} />
            <SelectField
              title="跟踪模式"
              value={effects.tracking.trackMode}
              options={[
                { value: 'point', label: '点跟踪' },
                { value: 'box', label: '框选跟踪' },
                { value: 'region', label: '区域跟踪' },
              ]}
              onChange={(value) => patchEffect('tracking', { enabled: true, trackMode: value as PostEffectsState['tracking']['trackMode'] })}
              testId={`post-field-${id}-tracking-mode`}
            />
            <ToggleField title="透视变换" checked={effects.tracking.perspectiveWarp} onChange={(value) => patchEffect('tracking', { enabled: true, perspectiveWarp: value })} testId={`post-field-${id}-tracking-perspective`} />
          </div>
          <button type="button" className="mt-3 nodrag rounded-xl border border-white/8 bg-[#111] px-3 py-2 text-sm text-[#ececec] hover:bg-[#181818]" onPointerDown={stopCanvasPointer} onClick={() => trackPickerRef.current?.click()} data-testid={`post-track-button-${id}`}>上传叠加素材</button>
        </PanelSection>
        <PanelSection title="叠加参数" note="位置、缩放和混合模式单独成区，避免与模式区互相遮挡。">
          <div className="grid gap-3 sm:grid-cols-2">
            <ToggleField title="锁定缩放" checked={effects.tracking.lockScale} onChange={(value) => patchEffect('tracking', { enabled: true, lockScale: value })} testId={`post-field-${id}-tracking-lock-scale`} />
            <ToggleField title="锁定旋转" checked={effects.tracking.lockRotation} onChange={(value) => patchEffect('tracking', { enabled: true, lockRotation: value })} testId={`post-field-${id}-tracking-lock-rotation`} />
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <ToggleField title="运动模糊匹配" checked={effects.tracking.motionBlur} onChange={(value) => patchEffect('tracking', { enabled: true, motionBlur: value })} testId={`post-field-${id}-tracking-motion-blur`} />
            <ToggleField title="遮挡感知" checked={effects.tracking.occlusionAware} onChange={(value) => patchEffect('tracking', { enabled: true, occlusionAware: value })} testId={`post-field-${id}-tracking-occlusion-aware`} />
          </div>
          {effects.tracking.tracks[0] ? (
            <>
              <div className="mt-3 grid gap-3 lg:grid-cols-2">
                <SliderField title="X 位置" value={effects.tracking.tracks[0].x} min={0} max={100} step={1} onChange={(value) => patchFirstTrack({ x: value })} testId={`post-field-${id}-tracking-x`} />
                <SliderField title="Y 位置" value={effects.tracking.tracks[0].y} min={0} max={100} step={1} onChange={(value) => patchFirstTrack({ y: value })} testId={`post-field-${id}-tracking-y`} />
                <SliderField title="缩放" value={effects.tracking.tracks[0].scale} min={0.1} max={3} step={0.01} onChange={(value) => patchFirstTrack({ scale: value })} testId={`post-field-${id}-tracking-scale`} />
                <SliderField title="旋转" value={effects.tracking.tracks[0].rotation} min={-180} max={180} step={1} onChange={(value) => patchFirstTrack({ rotation: value })} testId={`post-field-${id}-tracking-rotation`} />
                <SliderField title="透明度" value={effects.tracking.tracks[0].opacity} min={0} max={1} step={0.01} onChange={(value) => patchFirstTrack({ opacity: value })} testId={`post-field-${id}-tracking-opacity`} />
              </div>
              <SelectField
                title="混合模式"
                value={effects.tracking.tracks[0].blendMode}
                options={[
                  { value: 'normal', label: '正常' },
                  { value: 'screen', label: '滤色' },
                  { value: 'add', label: '叠加' },
                ]}
                onChange={(value) => patchFirstTrack({ blendMode: value as PostEffectsState['tracking']['tracks'][number]['blendMode'] })}
                testId={`post-field-${id}-tracking-blend-mode`}
              />
            </>
          ) : (
            <div className="rounded-xl border border-dashed border-white/10 px-3 py-4 text-sm text-[#8f8f8f]" data-testid={`post-tracking-empty-${id}`}>
              先上传一份 PNG、JPG 或 MP4 叠加素材，再继续调整位置、缩放和透明度。
            </div>
          )}
        </PanelSection>
      </div>
    );
  }

  function renderMotionBlurPanel() {
    return (
      <div className="grid gap-4 xl:grid-cols-[0.96fr_1.04fr]">
        <PanelSection title="运动模糊引擎" note="基于 RAFT 光流与 Kornia 运动核，按钮只是调取入口，算法在 postFX 模块。">
          <div className="grid gap-3 lg:grid-cols-2">
            <ToggleField title="启用运动模糊" checked={effects.motionBlur.enabled} onChange={(value) => patchEffect('motionBlur', { enabled: value })} testId={`post-field-${id}-motionblur-enabled`} />
            <SelectField
              title="执行引擎"
              value={effects.motionBlur.engine}
              options={[
                { value: 'kornia-motion', label: 'Kornia 运动核（角度模糊）' },
                { value: 'raft-flow', label: 'RAFT 光流（逐帧方向性）' },
              ]}
              onChange={(value) => patchEffect('motionBlur', { enabled: true, engine: value as PostEffectsState['motionBlur']['engine'] })}
              testId={`post-field-${id}-motionblur-engine`}
            />
            <ToggleField title="使用光流驱动" checked={effects.motionBlur.useOpticalFlow} onChange={(value) => patchEffect('motionBlur', { enabled: true, useOpticalFlow: value, engine: value ? 'raft-flow' : 'kornia-motion' })} testId={`post-field-${id}-motionblur-flow`} />
          </div>
          <div className="mt-3 rounded-xl border border-dashed border-white/10 bg-[#111] px-3 py-3 text-xs leading-5 text-[#9f9f9f]">
            <div className="font-medium text-[#e7e7e7]">实现说明</div>
            <div className="mt-1">
              Kornia 运动核：生成沿角度均布的运动核，旋转画布后做可分离 1D 卷积，等价 Kornia 的 motion_blur / filter2d。
              RAFT 光流：估计相邻帧运动矢量，沿光流方向做方向性模糊（需本地 RAFT 模型，缺失时自动回退角度模糊）。
            </div>
          </div>
        </PanelSection>
        <PanelSection title="模糊参数" note="长度与角度控制电影感拖影方向与强度。">
          <div className="grid gap-3">
            <SliderField title="模糊长度" value={effects.motionBlur.length} min={2} max={120} step={1} onChange={(value) => patchEffect('motionBlur', { enabled: true, length: value })} testId={`post-field-${id}-motionblur-length`} />
            <SliderField title="模糊角度" value={effects.motionBlur.angle} min={0} max={360} step={1} onChange={(value) => patchEffect('motionBlur', { enabled: true, angle: value })} testId={`post-field-${id}-motionblur-angle`} />
          </div>
          <button
            type="button"
            className="nodrag mt-3 inline-flex items-center gap-2 rounded-xl border border-[#00d4aa]/30 bg-[#0e2f2a] px-3 py-2 text-sm text-[#d8fff4] hover:bg-[#113a33]"
            onPointerDown={stopCanvasPointer}
            disabled={isApplying || !sourceAsset}
            onClick={() => void handleApplyMotionBlur()}
            data-testid={`post-motionblur-apply-${id}`}
          >
            {isApplying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
            应用运动模糊
          </button>
        </PanelSection>
      </div>
    );
  }

  function renderActivePanel() {
    switch (activeEffect) {
      case 'color':
        return renderColorPanel();
      case 'upscale':
        return renderUpscalePanel();
      case 'bloom':
        return renderBloomPanel();
      case 'dof':
        return renderDofPanel();
      case 'grain':
        return renderGrainPanel();
      case 'matting':
        return renderMattingPanel();
      case 'tracking':
        return renderTrackingPanel();
      case 'motionBlur':
        return renderMotionBlurPanel();
      default:
        return null;
    }
  }

  const headerStyle: CSSProperties = {
    width: 560,
    minHeight: 432,
  };

  const activeDescriptor = POST_EFFECT_DESCRIPTORS[activeEffect];
  const nodeStatus =
    data.status === 'generating'
    || data.status === 'completed'
    || data.status === 'error'
      ? data.status
      : 'idle';

  return (
    <ControlsDisabledContext.Provider value={isApplying}>
    <div className="relative overflow-visible" data-testid={`post-node-wrap-${id}`}>
      <div
        className={`group relative rounded-[28px] border border-white/10 bg-[#161616] shadow-[0_20px_60px_rgba(0,0,0,0.36)] transition-all ${selected ? 'ring-1 ring-[#00d4aa]/40' : ''}`}
        style={headerStyle}
        data-testid={`post-node-${id}`}
      >
        <Handle id="post-input" type="target" position={Position.Left} style={{ left: -18 }} className="!h-4 !w-4 !border-2 !border-white/80 !bg-[#111]" />
        <Handle id="post-output" type="source" position={Position.Right} style={{ right: -18 }} className="!h-4 !w-4 !border-2 !border-white/80 !bg-[#00d4aa]" />

        <div className="flex items-center justify-between gap-3 border-b border-white/8 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#ff7a1a]/15 text-[#ff9f52]">
            <Clapperboard className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <EditableNodeTitle
              nodeId={id}
              icon={Clapperboard}
              label={normalizePostLabel(data.label)}
              fallback="后期节点"
              className="truncate text-sm font-semibold text-white [&>svg]:hidden"
            />
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-[#9c9c9c]">
              <span>{sourceKind === 'video' ? '视频后期' : sourceKind === 'image' ? '图片后期' : '等待输入素材'}</span>
              <span>|</span>
              <span>{enabledCount > 0 ? `已启用 ${enabledCount} 个效果` : '尚未启用效果'}</span>
              <span>|</span>
              <span>{sourceInherited ? '输入端继承' : legacySourceUrl ? '兼容历史素材' : '未连接源节点'}</span>
            </div>
          </div>
        </div>
        <StatusBadge status={nodeStatus} />
        </div>

        <div className="px-4 py-4">
        {sourceUrl ? (
          <div className="mx-auto" style={previewStyle}>
            <PostComparePreview
              mediaKind={sourceKind || 'image'}
              beforeUrl={sourceUrl}
              afterUrl={compareEnabled && resultUrl ? resultUrl : undefined}
              afterStyle={compareEnabled && !resultUrl ? previewDescriptor.mediaStyle : undefined}
              afterLabel={resultUrl ? '真实结果' : '实时预览'}
              className="h-full w-full"
              containerTestId={`post-preview-${id}`}
              dividerTestId={`post-compare-divider-${id}`}
              beforeOverlay={null}
              afterOverlay={<PreviewOverlay descriptor={previewDescriptor} mediaKind={sourceKind} />}
            />
          </div>
        ) : (
          <EmptySourceCard />
        )}

        <div className="mt-3 flex items-center justify-between gap-2 rounded-2xl border border-white/8 bg-[#111] px-3 py-2 text-[11px] text-[#bdbdbd]">
          <span className="truncate">{stackSummary}</span>
          <button
            type="button"
            className={`nodrag rounded-full px-2.5 py-1 transition ${compareEnabled ? 'bg-[#00d4aa]/14 text-[#d5fff5]' : 'bg-white/6 text-[#b6b6b6]'}`}
            onPointerDown={stopCanvasPointer}
            onClick={() => setCompareEnabled((value) => !value)}
            data-testid={`post-compare-toggle-${id}`}
          >
            {compareEnabled ? '对比已开' : '开启对比'}
          </button>
        </div>

        {ocioResultSummary ? (
          <div className={`mt-3 rounded-2xl border px-3 py-3 text-xs leading-5 ${ocioResultSummary.toneClass}`} data-testid={`post-ocio-result-summary-${id}`}>
            <div className="font-medium">{ocioResultSummary.title}</div>
            <div className="mt-2 space-y-1">
              {ocioResultSummary.details.map((detail, index) => (
                <div key={`${detail}-${index}`}>{detail}</div>
              ))}
            </div>
          </div>
        ) : null}
        {upscaleResultSummary ? (
          <div className={`mt-3 rounded-2xl border px-3 py-3 text-xs leading-5 ${upscaleResultSummary.toneClass}`} data-testid={`post-upscale-result-summary-${id}`}>
            <div className="font-medium">{upscaleResultSummary.title}</div>
            <div className="mt-2 space-y-1">
              {upscaleResultSummary.details.map((detail, index) => (
                <div key={`${detail}-${index}`}>{detail}</div>
              ))}
            </div>
          </div>
        ) : null}
        {oiioResultSummary ? (
          <div className={`mt-3 rounded-2xl border px-3 py-3 text-xs leading-5 ${oiioResultSummary.toneClass}`} data-testid={`post-oiio-result-summary-${id}`}>
            <div className="font-medium">{oiioResultSummary.title}</div>
            <div className="mt-2 space-y-1">
              {oiioResultSummary.details.map((detail, index) => (
                <div key={`${detail}-${index}`}>{detail}</div>
              ))}
            </div>
          </div>
        ) : null}
        {gmicResultSummary ? (
          <div className={`mt-3 rounded-2xl border px-3 py-3 text-xs leading-5 ${gmicResultSummary.toneClass}`} data-testid={`post-gmic-result-summary-${id}`}>
            <div className="font-medium">{gmicResultSummary.title}</div>
            <div className="mt-2 space-y-1">
              {gmicResultSummary.details.map((detail, index) => (
                <div key={`${detail}-${index}`}>{detail}</div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="mt-3 flex flex-wrap gap-2">
          {POST_EFFECT_ORDER.map((effectId) => {
            const descriptor = POST_EFFECT_DESCRIPTORS[effectId];
            const enabled = effects[effectId].enabled;
            const active = panelOpen && activeEffect === effectId;
            return (
              <button
                key={effectId}
                type="button"
                disabled={isApplying}
                onPointerDown={stopCanvasPointer}
                onClick={() => handleOpenEffect(effectId)}
                data-testid={`post-tool-${id}-${effectId}`}
                className={`nodrag rounded-2xl border px-3 py-2 text-xs transition ${
                  active
                    ? 'border-[#00d4aa]/45 bg-[#0e2f2a] text-[#e5fff8]'
                    : enabled
                      ? 'border-[#ff9f52]/22 bg-[#271b11] text-[#ffe6d1]'
                      : 'border-white/8 bg-[#121212] text-[#d4d4d4] hover:bg-[#181818]'
                }`}
              >
                {descriptor.label}
              </button>
            );
          })}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="nodrag inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-[#111] px-3 py-2 text-sm text-[#ececec] hover:bg-[#1a1a1a] disabled:opacity-50"
            disabled={isApplying}
            onPointerDown={stopCanvasPointer}
            onClick={() => handleOpenEffect('matting')}
            data-testid={`post-matting-open-${id}`}
          >
            <Layers3 className="h-4 w-4" />
            抠像 / 合成
          </button>
          <button
            type="button"
            className="nodrag inline-flex items-center gap-2 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-[#d8fff4] hover:bg-emerald-500/16"
            disabled={isApplying || !sourceAsset}
            onPointerDown={stopCanvasPointer}
            onClick={() => void handleApplyStack()}
            data-testid={`post-generate-${id}`}
          >
            {isApplying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            生成结果节点
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="nodrag inline-flex items-center gap-2 rounded-2xl border border-[#ff9f52]/25 bg-[#271b11] px-3 py-2 text-xs font-medium text-[#ffe6d1] hover:bg-[#33220f] disabled:cursor-not-allowed disabled:opacity-50"
            disabled={cinematicDisabled}
            onPointerDown={stopCanvasPointer}
            onClick={() => void handleOneClickCinematic('auto')}
            data-testid={`post-oneclick-cinematic-${id}`}
          >
            <Wand2 className="h-4 w-4" />
            一键电影感
          </button>
          <button
            type="button"
            className="nodrag inline-flex items-center gap-2 rounded-2xl border border-[#00d4aa]/25 bg-[#0e2f2a] px-3 py-2 text-xs font-medium text-[#d8fff4] hover:bg-[#113a33] disabled:cursor-not-allowed disabled:opacity-50"
            disabled={mattingDisabled}
            onPointerDown={stopCanvasPointer}
            onClick={() => void handleOneClickMatting()}
            data-testid={`post-oneclick-matting-${id}`}
          >
            <Layers3 className="h-4 w-4" />
            一键智能抠图
          </button>
        </div>

        {Array.isArray(params.generationProgress) && params.generationProgress.length > 0 ? (
          <div className="mt-3">
            <ProgressBadge
              label={String((params.generationProgress as Array<Record<string, unknown>>).slice(-1)[0]?.message || '正在处理')}
              progress={Number((params.generationProgress as Array<Record<string, unknown>>).slice(-1)[0]?.progress || 0)}
            />
          </div>
        ) : null}

        {warnings.length > 0 ? (
          <div className="mt-3 rounded-2xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
            {warnings.map((item, index) => (
              <div key={`${item}-${index}`}>{item}</div>
            ))}
          </div>
        ) : null}

        {(localError || data.error) ? (
          <div className="mt-3">
            <ErrorDetailBlock category="render" message={localError || data.error} />
          </div>
        ) : null}

        </div>
      </div>

      <Sheet
        open={mattingPanelOpen && Boolean(mattingSourceUrl)}
        onOpenChange={(openState) => {
          if (!openState) {
            setMattingPanelOpen(false);
            setMattingSourceUrl('');
          }
        }}
      >
        <SheetContent
          side="right"
          className="w-[min(980px,calc(100vw-48px))] max-w-none border-l border-white/10 bg-[#0c0f13] p-0 text-white sm:max-w-none"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>一键智能抠图</SheetTitle>
            <SheetDescription>在右侧面板里完成主体识别、手动补选与透明 PNG 批量导出。</SheetDescription>
          </SheetHeader>
          {mattingSourceUrl ? (
            <Suspense fallback={null}>
              <MattingCapabilityPanel
                sourceImageUrl={mattingSourceUrl}
                mediaType={sourceAsset?.kind === 'video' ? 'video' : 'image'}
                onClose={() => { setMattingPanelOpen(false); setMattingSourceUrl(''); }}
                onExtract={handleMattingExtract}
                onTrack={sourceAsset?.kind === 'video' ? handleMattingTrack : undefined}
              />
            </Suspense>
          ) : null}
        </SheetContent>
      </Sheet>

      {panelOpen ? (
        <div
          className="absolute left-full top-0 z-50 ml-4 w-[720px] overflow-hidden rounded-[28px] border border-white/10 bg-[#0e0f11] shadow-[0_24px_80px_rgba(0,0,0,0.42)]"
          style={{ maxHeight: '82vh', maxWidth: 'min(720px, calc(100vw - 120px))' }}
          data-testid={`post-panel-${activeEffect}`}
          onPointerDown={stopCanvasPointer}
        >
          <div className="flex items-center justify-between gap-3 border-b border-white/8 px-4 py-3">
            <div className="text-sm font-semibold text-white">{activeDescriptor.label}</div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="nodrag inline-flex items-center gap-1.5 rounded-xl border border-white/8 bg-[#111] px-2.5 py-1.5 text-xs text-[#d0d0d0] hover:bg-[#171717] disabled:opacity-50"
                disabled={isApplying}
                onPointerDown={stopCanvasPointer}
                onClick={() => handleResetEffect(activeEffect)}
                data-testid={`post-reset-${activeEffect}-${id}`}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                重置
              </button>
              <button
                type="button"
                className="nodrag rounded-xl border border-white/8 bg-[#111] px-2.5 py-1.5 text-xs text-[#d0d0d0] hover:bg-[#171717]"
                onPointerDown={stopCanvasPointer}
                onClick={() => close('post-panel')}
              >
                关闭
              </button>
            </div>
          </div>
          <div className="max-h-[calc(82vh-60px)] overflow-y-auto p-4">
            <div className="space-y-4">
              {renderActivePanel()}
            </div>
          </div>
        </div>
      ) : null}

      <input
        ref={maskPickerRef}
        type="file"
        accept="image/*"
        className="hidden"
        data-testid={`post-mask-input-${id}`}
        onChange={(event) => handleMediaUpload(event, 'mask')}
      />
      <input
        ref={backgroundPickerRef}
        type="file"
        accept="image/*"
        className="hidden"
        data-testid={`post-background-input-${id}`}
        onChange={(event) => handleMediaUpload(event, 'background')}
      />
      <input
        ref={trackPickerRef}
        type="file"
        accept="image/*,video/*"
        className="hidden"
        data-testid={`post-track-input-${id}`}
        onChange={(event) => handleMediaUpload(event, 'track')}
      />
      <input
        ref={lutPickerRef}
        type="file"
        accept=".cube,.3dl,text/plain,application/octet-stream"
        className="hidden"
        data-testid={`post-lut-input-${id}`}
        onChange={(event) => handleMediaUpload(event, 'lut')}
      />
      <input
        ref={ocioConfigPickerRef}
        type="file"
        accept=".ocio,.yaml,.yml,.json,.cfg,.txt,application/octet-stream,text/plain"
        className="hidden"
        data-testid={`post-ocio-config-input-${id}`}
        onChange={(event) => handleMediaUpload(event, 'ocioConfig')}
      />
      <input
        ref={depthMaskPickerRef}
        type="file"
        accept="image/*"
        className="hidden"
        data-testid={`post-depth-mask-input-${id}`}
        onChange={(event) => handleMediaUpload(event, 'depthMask')}
      />
      <input
        ref={bokehPickerRef}
        type="file"
        accept="image/*"
        className="hidden"
        data-testid={`post-bokeh-input-${id}`}
        onChange={(event) => handleMediaUpload(event, 'bokeh')}
      />

      <ModelActivationPrompt
        open={Boolean(activation)}
        mode={activation?.mode || (sourceKind === 'image' ? 'image' : 'video')}
        provider={activation?.provider || 'DDUp 后期处理'}
        reason={activation?.reason || 'auth'}
        onClose={() => setActivation(null)}
      />
    </div>
    </ControlsDisabledContext.Provider>
  );
}

export default memo(PostNode);





