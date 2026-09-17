import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import {
  AlertCircle,
  Bot,
  BrainCircuit,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Eye,
  EyeOff,
  Film,
  GitBranch,
  Image as ImageIcon,
  Key,
  Paperclip,
  Upload,
  Loader2,
  PackageSearch,
  PauseCircle,
  Play,
  RotateCcw,
  Route,
  Save,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  User,
  Wand2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { validateByokKey } from '@/api/byok';
import type { IntentResult } from '@/services/agentService';
import {
  rememberAgentTraceRun,
  useSharedAgentMemoryGraph,
} from '@/services/agentMemory';
import { useCanvasStore, type WorkflowPlan } from '@/store/useCanvasStore';
import { useGenerationQueueStore } from '@/store/useGenerationQueueStore';
import { staggerNodeEntrance } from '@/lib/canvasGroupAnimation';
import { AI_PANEL_DOCK_WIDTH } from './AIPanel';
import { GenerationProgressCard } from './GenerationProgressCard';
import { importLocalAssetFile } from '@/api/assetLibrary';
import type { AssetItem } from '@/types/assets';
import { analyzeAssetImage } from '@/services/assetImageAnalysis';
import { deepAnalyzeImage } from '@/services/aiDeepAnalysisService';
import type { AIDeepAnalysis } from '@/types/assets';
import { reasonAboutVideo, extractVideoFrames } from '@/services/assetVideoReasoning';
import { buildMediaAwarePlan, wantGenerationFromMedia } from '@/services/agentMediaWorkflow';
import { formatReferenceAnalysisMessage } from '@/services/agentAnalysisChat';
import { onRunAgentWorkflow, onDeepAnalysisToAgent, type AgentWorkflowRef, type DeepAnalysisToAgentRef } from '@/services/extensionBridge';
import {
  resolveModelForTask,
  withReferenceRequirements,
  defaultRequirementsForTask,
  type ModelResolution,
  type ModelCandidate,
} from '@/services/modelFallback';
import type { NodeType } from '@/types';

/** 把 AIDeepAnalysisPanel 的深度分析结果，转成 SmartAgent 媒体工作流需要的分析/推理文案 */
function deepAnalysisToMediaText(analysis: AIDeepAnalysis): { analysisText: string; reasoningText: string } {
  const parts = [
    analysis.compositePrompt,
    analysis.subject && `主体：${analysis.subject}`,
    analysis.style && `风格：${analysis.style}`,
    analysis.scene && `场景：${analysis.scene}`,
    analysis.lighting && `光影：${analysis.lighting}`,
    analysis.composition && `构图：${analysis.composition}`,
    analysis.camera && `镜头/运镜：${analysis.camera}`,
    analysis.subjectColors && `主体颜色：${analysis.subjectColors}`,
    analysis.subjectDetails && `主体细节：${analysis.subjectDetails}`,
    analysis.action && `动作：${analysis.action}`,
    analysis.expression && `表情：${analysis.expression}`,
    analysis.vfx && `特效：${analysis.vfx}`,
    analysis.mood && `情绪：${analysis.mood}`,
  ].filter(Boolean);
  const analysisText = parts.join('；') || '已深度分析图片';
  const promptZh = (analysis.promptZh || '').trim();
  const promptEn = (analysis.promptEn || '').trim();
  let analysisTextFinal = analysisText;
  if (promptZh || promptEn) {
    analysisTextFinal += `\n\n📋 可复制提示词（用于复现/生成同样的画面）：`;
    if (promptZh) analysisTextFinal += `\n中文：${promptZh}`;
    if (promptEn) analysisTextFinal += `\n英文：${promptEn}`;
  }
  const reasoningText = analysis.compositePrompt || analysisTextFinal;
  return { analysisText: analysisTextFinal, reasoningText };
}

import {
  applyRouteToPlan,
  buildExecutionArtifacts,
  buildPlan,
  buildRouteRecommendations,
  clampLauncherPosition,
  clampValue,
  cloneRouteRecommendation,
  cloneWorkflowPlan,
  describeExecutionStep,
  detectIntent,
  formatRelativeTime,
  getCanvasHostBounds,
  MAX_TRACE_RUNS,
  MODELS,
  parseSseBlock,
  parseStorage,
  persistStorage,
  SKILLS,
  SMART_AGENT_LAUNCHER_SIZE,
  TRACE_STORAGE_KEY,
  WORKFLOW_TEMPLATES,
  type AgentModel,
  type AgentTraceEvent,
  type AgentTraceRun,
  type ChatMessage,
  type CheckpointStage,
  type ExecutionArtifact,
  type ExecutionState,
  type PendingRun,
  type RouteRecommendation,
  type WorkflowStepState,
} from './SmartAgent.shared';
interface SmartAgentProps {
  isMobile?: boolean;
  canvasHostRef?: RefObject<HTMLDivElement | null>;
}

export function SmartAgent({ isMobile = false, canvasHostRef }: SmartAgentProps) {
  const {
    createWorkflowFromPlan,
    saveWorkflow,
    exportCanvas,
    importCanvas,
    requestViewportFocus,
  } = useCanvasStore();

  const [isOpen, setIsOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState<AgentModel>(MODELS[0]);
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [showModelSelect, setShowModelSelect] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [panelSize, setPanelSize] = useState({ width: 620, height: 760 });
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [byokProvider, setByokProvider] = useState('openai');
  const [byokKey, setByokKey] = useState('');
  const [byokShowKey, setByokShowKey] = useState(false);
  const [byokValidating, setByokValidating] = useState(false);
  const [byokResult, setByokResult] = useState<{ success: boolean; message: string } | null>(null);
  const [checkpointMode, setCheckpointMode] = useState(true);
  const [routeRecommendations, setRouteRecommendations] = useState<RouteRecommendation[]>([]);
  const [selectedRouteId, setSelectedRouteId] = useState<RouteRecommendation['id']>('free');
  const [pendingRun, setPendingRun] = useState<PendingRun | null>(null);

  /** 智能体面板当前附带的媒体（图片/视频）：由上传或拖拽进入，分析/推理后成为工作流主输入 */
  type AttachedMediaState = {
    kind: 'image' | 'video';
    fileName: string;
    asset: AssetItem;
    status: 'ready' | 'error';
    analysis?: string;
    reasoning?: string;
    error?: string;
  };
  const [attachedMedia, setAttachedMedia] = useState<AttachedMediaState | null>(null);
  const [mediaProcessing, setMediaProcessing] = useState(false);
  const [mediaDragOver, setMediaDragOver] = useState(false);
  const mediaFileInputRef = useRef<HTMLInputElement | null>(null);
  const [traceRuns, setTraceRuns] = useState<AgentTraceRun[]>(() => parseStorage<AgentTraceRun[]>(TRACE_STORAGE_KEY, []));
  const memoryGraph = useSharedAgentMemoryGraph();
  const [activeTraceId, setActiveTraceId] = useState<string>('');
  const [executionState, setExecutionState] = useState<ExecutionState>({
    status: 'idle',
    currentStep: '等待新的工作流指令',
    summary: '机器人会在这里展示执行时间线、当前步骤、检查点和产物来源。',
    steps: [],
    artifacts: [],
    updatedAt: Date.now(),
  });
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content: '我会帮你规划画布工作流，并把执行轨迹、人工确认、长期记忆和产物来源一起记录下来。',
      timestamp: Date.now(),
    },
  ]);

  // 右侧 docked AI 面板开启时，把智能体浮层的可用区域右侧内缩，
  // 避免两者重叠（docked 面板 z-[60]，智能体 z-[90]，重叠会互相遮挡）。
  const showAIPanel = useCanvasStore((state) => state.showAIPanel);
  const dockInset = showAIPanel && !isMobile ? AI_PANEL_DOCK_WIDTH + 24 : 0;

  const dragRef = useRef<{ startX: number; startY: number; initX: number; initY: number } | null>(null);
  const dragMovedRef = useRef(false);
  const dragActiveRef = useRef(false);
  const resizeRef = useRef<{ startX: number; startY: number; width: number; height: number } | null>(null);
  const buttonRef = useRef<HTMLDivElement>(null);
  const glassesRef = useRef<HTMLDivElement>(null);
  const leftPupilRef = useRef<HTMLSpanElement>(null);
  const rightPupilRef = useRef<HTMLSpanElement>(null);
  const gazePointRef = useRef<{ x: number; y: number; active: boolean }>({ x: 0, y: 0, active: false });
  const gazeFrameRef = useRef<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const snapshotVaultRef = useRef<Record<string, { beforeSnapshot: string; afterSnapshot?: string }>>({});

  useEffect(() => {
    const host = getCanvasHostBounds(canvasHostRef, dockInset);
    setPosition(clampLauncherPosition(
      host.width - SMART_AGENT_LAUNCHER_SIZE - 24,
      host.height - SMART_AGENT_LAUNCHER_SIZE - 96,
      canvasHostRef,
      undefined,
      dockInset,
    ));
  }, [canvasHostRef]);

  // 右侧面板「打开」时把浮层收进可用区域，避免被 docked 面板压住。
  // 关闭时不动位置：用户可能已把浮层拖到喜欢的地方，没必要强行挪回去。
  useEffect(() => {
    if (dockInset === 0) return;
    setPosition((current) => clampLauncherPosition(
      current.x,
      current.y,
      canvasHostRef,
      undefined,
      dockInset,
    ));
  }, [canvasHostRef, dockInset]);

  useEffect(() => {
    persistStorage(TRACE_STORAGE_KEY, traceRuns);
  }, [traceRuns]);

  useEffect(() => {
    if (!activeTraceId && traceRuns[0]) {
      setActiveTraceId(traceRuns[0].id);
    }
  }, [activeTraceId, traceRuns]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handleResize = () => {
      const host = getCanvasHostBounds(canvasHostRef, dockInset);
      setPosition((current) => clampLauncherPosition(current.x, current.y, canvasHostRef, undefined, dockInset));
      setPanelSize((current) => ({
        width: Math.min(current.width, Math.max(320, host.width - 24)),
        height: Math.min(current.height, Math.max(360, host.height - 24)),
      }));
    };
    const canvasHostElement = canvasHostRef?.current ?? null;
    const resizeObserver = typeof ResizeObserver !== 'undefined' && canvasHostElement
      ? new ResizeObserver(handleResize)
      : null;
    if (resizeObserver && canvasHostElement) {
      resizeObserver.observe(canvasHostElement);
    }
    window.addEventListener('resize', handleResize);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', handleResize);
    };
  }, [canvasHostRef, dockInset]);

  const syncLauncherGaze = useCallback(() => {
    gazeFrameRef.current = null;
    const shell = buttonRef.current;
    if (!shell) return;
    const rect = shell.getBoundingClientRect();
    const pointer = gazePointRef.current;
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const deltaX = pointer.active ? clampValue((pointer.x - centerX) / 14, -5, 5) : 0;
    const deltaY = pointer.active ? clampValue((pointer.y - centerY) / 18, -4, 4) : 0;
    if (glassesRef.current) {
      glassesRef.current.style.transform = `translate3d(${(deltaX * 0.3).toFixed(2)}px, ${(deltaY * 0.28).toFixed(2)}px, 0) rotate(${(deltaX * 0.7).toFixed(2)}deg)`;
    }
    [leftPupilRef.current, rightPupilRef.current].forEach((node) => {
      if (!node) return;
      node.style.transform = `translate3d(${(deltaX * 0.3).toFixed(2)}px, ${(deltaY * 0.3).toFixed(2)}px, 0)`;
    });
  }, []);

  const requestLauncherGazeSync = useCallback(() => {
    if (gazeFrameRef.current !== null || typeof window === 'undefined') return;
    gazeFrameRef.current = window.requestAnimationFrame(syncLauncherGaze);
  }, [syncLauncherGaze]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handlePointerMove = (event: PointerEvent) => {
      gazePointRef.current = {
        x: event.clientX,
        y: event.clientY,
        active: true,
      };
      requestLauncherGazeSync();
    };
    const resetGaze = () => {
      gazePointRef.current.active = false;
      requestLauncherGazeSync();
    };
    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    window.addEventListener('blur', resetGaze);
    return () => {
      if (gazeFrameRef.current !== null) {
        window.cancelAnimationFrame(gazeFrameRef.current);
      }
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('blur', resetGaze);
    };
  }, [requestLauncherGazeSync]);

  useEffect(() => {
    if (gazePointRef.current.active) {
      requestLauncherGazeSync();
    }
  }, [position.x, position.y, requestLauncherGazeSync]);

  const selectedSkillMeta = useMemo(() => SKILLS.find((item) => item.id === selectedSkill) || null, [selectedSkill]);
  const activeTrace = useMemo(() => traceRuns.find((trace) => trace.id === activeTraceId) || traceRuns[0] || null, [activeTraceId, traceRuns]);
  const desktopPanelPosition = useMemo(() => {
    if (isMobile) return null;
    const host = getCanvasHostBounds(canvasHostRef, dockInset);
    const spacing = 18;
    const preferredRight = position.x + SMART_AGENT_LAUNCHER_SIZE + spacing;
    const preferredLeft = position.x - panelSize.width - spacing;
    const preferredTop = position.y - 36;
    const minInset = 12;
    const maxLeft = Math.max(minInset, host.width - panelSize.width - minInset);
    const nextLeft = preferredRight <= maxLeft
      ? preferredRight
      : preferredLeft >= minInset
        ? preferredLeft
        : clampValue(preferredRight, minInset, maxLeft);
    return {
      left: nextLeft,
      top: clampValue(preferredTop, minInset, Math.max(minInset, host.height - panelSize.height - minInset)),
    };
  }, [canvasHostRef, dockInset, isMobile, panelSize.height, panelSize.width, position.x, position.y]);

  const appendTraceEvent = useCallback((traceId: string, event: Omit<AgentTraceEvent, 'id' | 'at'>) => {
    const nextEvent: AgentTraceEvent = {
      id: `${traceId}-event-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      at: Date.now(),
      ...event,
    };
    setTraceRuns((prev) => prev.map((trace) => (
      trace.id === traceId
        ? { ...trace, updatedAt: Date.now(), events: [nextEvent, ...trace.events].slice(0, 20) }
        : trace
    )));
    return nextEvent;
  }, []);

  const updateTraceRun = useCallback((traceId: string, updater: (trace: AgentTraceRun) => AgentTraceRun) => {
    setTraceRuns((prev) => prev.map((trace) => (trace.id === traceId ? updater(trace) : trace)));
  }, []);

  const createTraceRun = useCallback((
    inputText: string,
    plan: WorkflowPlan,
    intent: IntentResult,
    route: RouteRecommendation,
    options?: {
      templateId?: string;
      sourceTraceId?: string;
      checkpointMode?: boolean;
    },
  ) => {
    const traceId = `trace-${Date.now()}`;
    const nextCheckpointMode = options?.checkpointMode ?? checkpointMode;
    const nextTrace: AgentTraceRun = {
      id: traceId,
      input: inputText,
      planName: plan.name,
      skillId: intent.skillId,
      skillName: intent.skillName,
      templateId: options?.templateId || intent.skillId,
      routeId: route.id,
      routeName: route.name,
      status: nextCheckpointMode ? 'awaiting-plan' : 'running',
      checkpointMode: nextCheckpointMode,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      nodeIds: [],
      events: [],
      artifacts: [],
      planSnapshot: cloneWorkflowPlan(plan),
      routeSnapshot: cloneRouteRecommendation(route),
      replaySourceTraceId: options?.sourceTraceId,
      version: 1,
    };
    setTraceRuns((prev) => [nextTrace, ...prev].slice(0, MAX_TRACE_RUNS));
    setActiveTraceId(traceId);
    return traceId;
  }, [checkpointMode]);

  const rememberRun = useCallback((trace: AgentTraceRun) => {
    const result = rememberAgentTraceRun({
      traceId: trace.id,
      templateId: trace.templateId,
      input: trace.input,
      planName: trace.planName,
      skillId: trace.skillId,
      skillName: trace.skillName,
      routeName: trace.routeName,
      planSnapshot: trace.planSnapshot,
    });
    if (result.inserted.length) {
      appendTraceEvent(trace.id, {
        kind: 'memory',
        label: '写入长期记忆',
        detail: `已沉淀 ${result.inserted.length} 条共享记忆，可供图片、视频和后期节点复用。`,
        status: 'done',
      });
    } else if (result.updated.length) {
      appendTraceEvent(trace.id, {
        kind: 'memory',
        label: '刷新长期记忆',
        detail: `已更新 ${result.updated.length} 条共享记忆，保留原有复用关系。`,
        status: 'info',
      });
    }
  }, [appendTraceEvent]);

  const setExecutionForCheckpoint = useCallback((plan: WorkflowPlan, route: RouteRecommendation, stage: CheckpointStage, statuses: WorkflowStepState[]) => {
    setExecutionState({
      status: 'awaiting-approval',
      currentStep: describeExecutionStep(statuses, 'awaiting-approval', stage),
      summary: stage === 'plan'
        ? '计划已生成，等待你确认后再进入执行。'
        : stage === 'execute'
          ? '路线已选定，等待你确认后创建节点与连线。'
          : '节点已创建完成，等待你确认是否正式交付并写入长期记忆。',
      steps: statuses,
      artifacts: buildExecutionArtifacts(plan, statuses, route, pendingRun?.createdNodeIds || []),
      updatedAt: Date.now(),
    });
  }, [pendingRun?.createdNodeIds]);

  const startLauncherDrag = useCallback((clientX: number, clientY: number) => {
    if (!buttonRef.current) return;
    dragMovedRef.current = false;
    dragActiveRef.current = true;
    const host = getCanvasHostBounds(canvasHostRef);
    const rect = buttonRef.current.getBoundingClientRect();
    dragRef.current = {
      startX: clientX,
      startY: clientY,
      initX: rect.left - host.left,
      initY: rect.top - host.top,
    };

    const handleMove = (moveEvent: MouseEvent | PointerEvent) => {
      if (!dragRef.current || !dragActiveRef.current) return;
      const dx = moveEvent.clientX - dragRef.current.startX;
      const dy = moveEvent.clientY - dragRef.current.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        dragMovedRef.current = true;
      }
      setPosition(clampLauncherPosition(dragRef.current.initX + dx, dragRef.current.initY + dy, canvasHostRef, undefined, dockInset));
    };

    const handleUp = () => {
      dragRef.current = null;
      dragActiveRef.current = false;
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      window.setTimeout(() => {
        dragMovedRef.current = false;
      }, 0);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    // dockInset 必须进依赖：否则面板开合后拖拽仍按旧边界钳制，浮层会被压在面板下。
  }, [canvasHostRef, dockInset]);

  const handleDragHandlePointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    startLauncherDrag(event.clientX, event.clientY);
  }, [startLauncherDrag]);

  const handleDragHandleMouseDown = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    if (typeof window !== 'undefined' && 'PointerEvent' in window) return;
    event.stopPropagation();
    startLauncherDrag(event.clientX, event.clientY);
  }, [startLauncherDrag]);

  const handleLauncherClick = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    if (dragMovedRef.current) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    setIsOpen(true);
  }, []);

  const startPanelResize = useCallback((clientX: number, clientY: number) => {
    if (isMobile) return;
    const host = getCanvasHostBounds(canvasHostRef);
    resizeRef.current = {
      startX: clientX,
      startY: clientY,
      width: panelSize.width,
      height: panelSize.height,
    };

    const handleMove = (moveEvent: MouseEvent | PointerEvent) => {
      if (!resizeRef.current) return;
      const nextWidth = resizeRef.current.width + (moveEvent.clientX - resizeRef.current.startX);
      const nextHeight = resizeRef.current.height + (moveEvent.clientY - resizeRef.current.startY);
      setPanelSize({
        width: Math.max(320, Math.min(nextWidth, host.width - 24)),
        height: Math.max(360, Math.min(nextHeight, host.height - 24)),
      });
    };

    const handleUp = () => {
      resizeRef.current = null;
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  }, [canvasHostRef, isMobile, panelSize.height, panelSize.width]);

  const handlePanelResizePointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    startPanelResize(event.clientX, event.clientY);
  }, [startPanelResize]);

  const handlePanelResizeMouseDown = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    if (typeof window !== 'undefined' && 'PointerEvent' in window) return;
    event.preventDefault();
    event.stopPropagation();
    startPanelResize(event.clientX, event.clientY);
  }, [startPanelResize]);

  const cancelPendingRun = useCallback((reason: string) => {
    if (!pendingRun) return;
    appendTraceEvent(pendingRun.traceId, {
      kind: 'checkpoint',
      label: '取消执行',
      detail: reason,
      status: 'warning',
    });
    updateTraceRun(pendingRun.traceId, (trace) => ({
      ...trace,
      status: 'failed',
      updatedAt: Date.now(),
    }));
    setExecutionState((current) => ({
      ...current,
      status: 'paused',
      currentStep: '执行已取消',
      summary: reason,
      updatedAt: Date.now(),
    }));
    setPendingRun(null);
  }, [appendTraceEvent, pendingRun, updateTraceRun]);

  const runWorkflowPlan = useCallback(async (run: PendingRun) => {
   try {
    const workflowSteps: WorkflowStepState[] = run.plan.steps.map((step) => ({ label: step.label, status: 'pending' }));
    appendTraceEvent(run.traceId, {
      kind: 'checkpoint',
      label: '执行已获批准',
      detail: `开始按 ${run.route.name} 创建节点与连线。`,
      status: 'done',
    });
    updateTraceRun(run.traceId, (trace) => ({
      ...trace,
      status: 'running',
      updatedAt: Date.now(),
    }));
    setExecutionState({
      status: 'creating',
      currentStep: describeExecutionStep(workflowSteps, 'creating'),
      summary: `正在执行《${run.plan.name}》，路线为 ${run.route.name}。`,
      steps: workflowSteps,
      artifacts: buildExecutionArtifacts(run.plan, workflowSteps, run.route),
      updatedAt: Date.now(),
    });

    const messageId = `plan-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      {
        id: messageId,
        role: 'system',
        content: `开始执行《${run.plan.name}》。`,
        timestamp: Date.now(),
        workflowStatus: 'creating',
        workflowSteps,
      },
    ]);

    // 计划步骤入队：右侧进度卡 / 左下占位卡实时反映「共 N 个任务，已完成 M 个」（G12 / G13）。
    const queueTaskIds = useGenerationQueueStore.getState().enqueueMany(
      workflowSteps.map((step) => ({ label: step.label || '步骤' })),
    );

    for (let index = 0; index < workflowSteps.length; index += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 240));
      const nextSteps = workflowSteps.map((step, stepIndex) => {
        if (stepIndex < index) return { ...step, status: 'done' as const };
        if (stepIndex === index) return { ...step, status: 'running' as const };
        return step;
      });
      setExecutionState({
        status: 'creating',
        currentStep: describeExecutionStep(nextSteps, 'creating'),
        summary: `正在执行《${run.plan.name}》，步骤 ${index + 1}/${workflowSteps.length}。`,
        steps: nextSteps,
        artifacts: buildExecutionArtifacts(run.plan, nextSteps, run.route),
        updatedAt: Date.now(),
      });
      appendTraceEvent(run.traceId, {
        kind: 'step',
        label: nextSteps[index]?.label || `步骤 ${index + 1}`,
        detail: `执行节点阶段 ${index + 1}/${workflowSteps.length}`,
        status: 'running',
      });
      useGenerationQueueStore.getState().markSuccess(queueTaskIds[index]);
      setMessages((prev) =>
        prev.map((message) => {
          if (message.id !== messageId || !message.workflowSteps) return message;
          return {
            ...message,
            workflowStatus: 'creating',
            workflowSteps: message.workflowSteps.map((step, stepIndex) => {
              if (stepIndex < index) return { ...step, status: 'done' };
              if (stepIndex === index) return { ...step, status: 'running' };
              return step;
            }),
          };
        }),
      );
    }

    const startedAt = Date.now();
    const result = await createWorkflowFromPlan(run.plan);
    if (!result.success) {
      // 未完成的步骤标记为失败，避免进度卡永远停在「已完成 M/N」的中间态。
      const queueStore = useGenerationQueueStore.getState();
      queueTaskIds.forEach((taskId) => {
        const task = queueStore.tasks.find((item) => item.id === taskId);
        if (task && task.status !== 'success') queueStore.markFailed(taskId, result.error || '创建失败');
      });
      const failedSteps = workflowSteps.map((step, index) => ({
        ...step,
        status: index < (result.nodeIds?.length || 0) ? 'done' as const : 'error' as const,
      }));
      setExecutionState({
        status: 'failed',
        currentStep: describeExecutionStep(failedSteps, 'failed'),
        summary: `工作流创建失败：${result.error || '未知错误'}`,
        steps: failedSteps,
        artifacts: buildExecutionArtifacts(run.plan, failedSteps, run.route, result.nodeIds),
        updatedAt: Date.now(),
      });
      appendTraceEvent(run.traceId, {
        kind: 'error',
        label: '创建失败',
        detail: result.error || '未知错误',
        status: 'error',
      });
      updateTraceRun(run.traceId, (trace) => ({
        ...trace,
        status: 'failed',
        nodeIds: result.nodeIds,
        artifacts: buildExecutionArtifacts(run.plan, failedSteps, run.route, result.nodeIds),
        updatedAt: Date.now(),
      }));
      setMessages((prev) => [
        ...prev,
        {
          id: `failed-${Date.now()}`,
          role: 'assistant',
          content: `工作流创建失败：${result.error || '未知错误'}`,
          timestamp: Date.now(),
        },
      ]);
      setPendingRun(null);
      return;
    }

    const completedSteps = workflowSteps.map((step) => ({ ...step, status: 'done' as const }));
    const nextArtifacts = buildExecutionArtifacts(run.plan, completedSteps, run.route, result.nodeIds);
    const afterSnapshot = exportCanvas();
    snapshotVaultRef.current[run.traceId] = {
      ...(snapshotVaultRef.current[run.traceId] || { beforeSnapshot: run.beforeSnapshot }),
      afterSnapshot,
    };
    updateTraceRun(run.traceId, (trace) => ({
      ...trace,
      status: checkpointMode ? 'awaiting-deliver' : 'completed',
      nodeIds: result.nodeIds,
      artifacts: nextArtifacts,
      updatedAt: Date.now(),
      version: trace.version + 1,
    }));
    appendTraceEvent(run.traceId, {
      kind: 'artifact',
      label: '节点产物已生成',
      detail: `已创建 ${result.nodeIds.length} 个节点，耗时 ${Math.max(1, Math.round((Date.now() - startedAt) / 1000))} 秒。`,
      status: 'done',
    });
    // 新节点按序号错峰入场（G08）。延后一帧执行：此时 React 尚未把节点渲染到 DOM，
    // 立即查询会取不到元素导致动画静默丢失。
    window.setTimeout(() => staggerNodeEntrance(result.nodeIds), 60);
    setMessages((prev) => [
      ...prev,
      {
        id: `success-${Date.now()}`,
        role: 'assistant',
        content: checkpointMode
          ? `工作流节点已创建完成，等待你确认是否正式交付《${run.plan.name}》。`
          : `工作流《${run.plan.name}》已创建完成。`,
        timestamp: Date.now(),
        workflowStatus: checkpointMode ? 'paused' : 'completed',
        workflowSteps: completedSteps,
      },
    ]);

    const nextPendingRun: PendingRun = {
      ...run,
      createdNodeIds: result.nodeIds,
      checkpointStage: 'deliver',
    };
    setPendingRun(checkpointMode ? nextPendingRun : null);

    if (checkpointMode) {
      setExecutionForCheckpoint(run.plan, run.route, 'deliver', completedSteps);
      return;
    }

    saveWorkflow(run.plan.name, run.plan.description, '#00d4aa');
    requestViewportFocus(result.nodeIds[result.nodeIds.length - 1] || null);
    const finishedTrace = {
      ...(traceRuns.find((trace) => trace.id === run.traceId) || {
        id: run.traceId,
        input: run.input,
        planName: run.plan.name,
        skillId: run.detectedIntent.skillId,
        skillName: run.detectedIntent.skillName,
        templateId: run.templateId,
        routeId: run.route.id,
        routeName: run.route.name,
        status: 'completed' as const,
        checkpointMode,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        nodeIds: result.nodeIds,
        events: [],
        artifacts: nextArtifacts,
        planSnapshot: cloneWorkflowPlan(run.plan),
        routeSnapshot: cloneRouteRecommendation(run.route),
        replaySourceTraceId: run.replaySourceTraceId,
        version: 1,
      }),
      nodeIds: result.nodeIds,
      artifacts: nextArtifacts,
    } as AgentTraceRun;
    // 后置副作用（写入长期记忆/存档）失败不得阻塞「已完成」状态，
    // 否则异常会冒泡到外层 catch，执行浮层永远停在「正在创建节点」。
    try {
      rememberRun(finishedTrace);
    } catch (memErr) {
      console.warn('[runWorkflowPlan] 写入长期记忆失败（不影响已创建节点）:', memErr);
    }
    setExecutionState({
      status: 'completed',
      currentStep: describeExecutionStep(completedSteps, 'completed'),
      summary: `已完成《${run.plan.name}》，结果已交付并写入长期记忆。`,
      steps: completedSteps,
      artifacts: nextArtifacts,
      updatedAt: Date.now(),
    });
   } catch (wfErr) {
    // R6：任何未预期异常都让执行浮层进入 failed，绝不永久停在「正在创建节点」。
    const msg = wfErr instanceof Error ? wfErr.message : String(wfErr);
    console.error('[runWorkflowPlan] 执行异常：', wfErr);
    const failedSteps = run.plan.steps.map((step) => ({ ...step, status: 'error' as const }));
    setExecutionState({
      status: 'failed',
      currentStep: describeExecutionStep(failedSteps, 'failed'),
      summary: `工作流执行异常：${msg}`,
      steps: failedSteps,
      artifacts: buildExecutionArtifacts(run.plan, failedSteps, run.route),
      updatedAt: Date.now(),
    });
    setMessages((prev) => [
      ...prev,
      {
        id: `wf-error-${Date.now()}`,
        role: 'assistant',
        content: `工作流执行出现异常：${msg}`,
        timestamp: Date.now(),
      },
    ]);
    setPendingRun(null);
  }
  }, [
    appendTraceEvent,
    checkpointMode,
    createWorkflowFromPlan,
    exportCanvas,
    rememberRun,
    requestViewportFocus,
    saveWorkflow,
    setExecutionForCheckpoint,
    traceRuns,
    updateTraceRun,
  ]);

  const finalizeDelivery = useCallback(() => {
    if (!pendingRun || pendingRun.checkpointStage !== 'deliver') return;
    const completedSteps = executionState.steps.length
      ? executionState.steps
      : pendingRun.plan.steps.map((step) => ({ label: step.label, status: 'done' as const }));
    saveWorkflow(pendingRun.plan.name, pendingRun.plan.description, '#00d4aa');
    requestViewportFocus(pendingRun.createdNodeIds[pendingRun.createdNodeIds.length - 1] || null);
    appendTraceEvent(pendingRun.traceId, {
      kind: 'deliver',
      label: '交付已确认',
      detail: `已正式交付 ${pendingRun.createdNodeIds.length} 个节点，并同步长期记忆。`,
      status: 'done',
    });
    const nextTrace = {
      ...(traceRuns.find((trace) => trace.id === pendingRun.traceId) || {
        id: pendingRun.traceId,
        input: pendingRun.input,
        planName: pendingRun.plan.name,
        skillId: pendingRun.detectedIntent.skillId,
        skillName: pendingRun.detectedIntent.skillName,
        templateId: pendingRun.templateId,
        routeId: pendingRun.route.id,
        routeName: pendingRun.route.name,
        status: 'completed' as const,
        checkpointMode,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        nodeIds: pendingRun.createdNodeIds,
        events: [],
        artifacts: buildExecutionArtifacts(pendingRun.plan, completedSteps, pendingRun.route, pendingRun.createdNodeIds),
        planSnapshot: cloneWorkflowPlan(pendingRun.plan),
        routeSnapshot: cloneRouteRecommendation(pendingRun.route),
        replaySourceTraceId: pendingRun.replaySourceTraceId,
        version: 1,
      }),
      status: 'completed' as const,
      nodeIds: pendingRun.createdNodeIds,
      artifacts: buildExecutionArtifacts(pendingRun.plan, completedSteps, pendingRun.route, pendingRun.createdNodeIds),
      updatedAt: Date.now(),
    } as AgentTraceRun;
    updateTraceRun(pendingRun.traceId, () => nextTrace);
    // 后置副作用（写入长期记忆/存档）失败不得阻塞「已完成」状态，
    // 否则异常会冒泡到外层 catch，执行浮层永远停在中间态。
    try {
      rememberRun(nextTrace);
    } catch (memErr) {
      console.warn('[finalizeDelivery] 写入长期记忆失败（不影响已交付节点）:', memErr);
    }
    setExecutionState({
      status: 'completed',
      currentStep: describeExecutionStep(completedSteps, 'completed'),
      summary: `已完成《${pendingRun.plan.name}》，交付成功并保留来源轨迹。`,
      steps: completedSteps,
      artifacts: buildExecutionArtifacts(pendingRun.plan, completedSteps, pendingRun.route, pendingRun.createdNodeIds),
      updatedAt: Date.now(),
    });
    setPendingRun(null);
  }, [
    appendTraceEvent,
    executionState.steps,
    pendingRun,
    rememberRun,
    requestViewportFocus,
    saveWorkflow,
    updateTraceRun,
  ]);

  const approveCheckpoint = useCallback(async () => {
    if (!pendingRun) return;
    if (pendingRun.checkpointStage === 'plan') {
      appendTraceEvent(pendingRun.traceId, {
        kind: 'checkpoint',
        label: '计划已确认',
        detail: '已通过计划阶段，等待执行确认。',
        status: 'done',
      });
      updateTraceRun(pendingRun.traceId, (trace) => ({
        ...trace,
        status: 'awaiting-execute',
        updatedAt: Date.now(),
      }));
      const nextRun = {
        ...pendingRun,
        checkpointStage: 'execute' as const,
      };
      setPendingRun(nextRun);
      setExecutionForCheckpoint(nextRun.plan, nextRun.route, 'execute', executionState.steps.length ? executionState.steps : nextRun.plan.steps.map((step) => ({
        label: step.label,
        status: 'pending',
      })));
      return;
    }
    if (pendingRun.checkpointStage === 'execute') {
      await runWorkflowPlan(pendingRun);
      return;
    }
    finalizeDelivery();
  }, [appendTraceEvent, executionState.steps, finalizeDelivery, pendingRun, runWorkflowPlan, setExecutionForCheckpoint, updateTraceRun]);

  const rollbackTraceRun = useCallback((traceId: string) => {
    const snapshot = snapshotVaultRef.current[traceId];
    if (!snapshot?.beforeSnapshot) return;
    importCanvas(snapshot.beforeSnapshot);
    updateTraceRun(traceId, (trace) => ({
      ...trace,
      status: 'rolled-back',
      updatedAt: Date.now(),
    }));
    appendTraceEvent(traceId, {
      kind: 'rollback',
      label: '已回退到执行前',
      detail: '本次运行创建的节点已从画布恢复到执行前状态。',
      status: 'warning',
    });
    setExecutionState((current) => ({
      ...current,
      status: 'paused',
      currentStep: '已执行回退',
      summary: '画布已恢复到本次运行前的状态。',
      updatedAt: Date.now(),
    }));
    if (pendingRun?.traceId === traceId) {
      setPendingRun(null);
    }
  }, [appendTraceEvent, importCanvas, pendingRun?.traceId, updateTraceRun]);

  const replayTraceRun = useCallback((trace: AgentTraceRun) => {
    const replayRoute = cloneRouteRecommendation(trace.routeSnapshot);
    const replayPlan = applyRouteToPlan(cloneWorkflowPlan(trace.planSnapshot), replayRoute);
    const replayIntent: IntentResult = {
      skillId: trace.skillId,
      skillName: trace.skillName,
      confidence: 1,
      extractedParams: {
        replayOfTraceId: trace.id,
        templateId: trace.templateId,
      },
      suggestedSteps: replayPlan.steps.map((step) => ({
        type: step.type,
        label: step.label,
        prompt: String((step.data as Record<string, unknown> | undefined)?.prompt || trace.input),
      })),
    };
    const replayRoutes = buildRouteRecommendations(replayPlan, trace.skillId);
    const beforeSnapshot = exportCanvas();
    const workflowSteps: WorkflowStepState[] = replayPlan.steps.map((step) => ({ label: step.label, status: 'pending' }));
    const replayTraceId = createTraceRun(trace.input, replayPlan, replayIntent, replayRoute, {
      templateId: trace.templateId,
      sourceTraceId: trace.id,
      checkpointMode: trace.checkpointMode,
    });
    snapshotVaultRef.current[replayTraceId] = { beforeSnapshot };
    const nextPendingRun: PendingRun = {
      traceId: replayTraceId,
      templateId: trace.templateId,
      input: trace.input,
      detectedIntent: replayIntent,
      plan: replayPlan,
      route: replayRoute,
      checkpointStage: trace.checkpointMode ? 'plan' : 'execute',
      beforeSnapshot,
      createdNodeIds: [],
      replaySourceTraceId: trace.id,
    };
    setCheckpointMode(trace.checkpointMode);
    setRouteRecommendations(replayRoutes);
    setSelectedRouteId(replayRoute.id);
    setSelectedSkill(trace.skillId);
    setPendingRun(nextPendingRun);
    setExecutionState({
      status: trace.checkpointMode ? 'awaiting-approval' : 'planning',
      currentStep: describeExecutionStep(workflowSteps, trace.checkpointMode ? 'awaiting-approval' : 'planning', trace.checkpointMode ? 'plan' : null),
      summary: trace.checkpointMode
        ? `已按原路线 ${trace.routeName} 恢复复盘，等待你从原 checkpoint 重新确认。`
        : `已按原路线 ${trace.routeName} 恢复复盘，马上继续执行。`,
      steps: workflowSteps,
      artifacts: buildExecutionArtifacts(replayPlan, workflowSteps, replayRoute),
      updatedAt: Date.now(),
    });
    appendTraceEvent(replayTraceId, {
      kind: 'replay',
      label: '一键复盘已就绪',
      detail: `已沿用原模板 ${trace.templateId}、原路线 ${trace.routeName} 和原 checkpoint 规则重建新运行。`,
      status: 'done',
    });
    setMessages((prev) => [
      ...prev,
      {
        id: `replay-${Date.now()}`,
        role: 'system',
        content: `已从 ${trace.planName} 创建一条新的复盘运行，保留原路线、原 checkpoint 与节点模板。`,
        timestamp: Date.now(),
        workflowStatus: trace.checkpointMode ? 'awaiting-approval' : 'planning',
        workflowSteps,
      },
    ]);
    if (!trace.checkpointMode) {
      void runWorkflowPlan(nextPendingRun);
    }
    setIsOpen(true);
  }, [appendTraceEvent, createTraceRun, exportCanvas, runWorkflowPlan]);

  const focusArtifactNode = useCallback((artifact: ExecutionArtifact) => {
    if (!artifact.nodeId) return;
    requestViewportFocus(artifact.nodeId);
  }, [requestViewportFocus]);

  const saveMemoryFromTrace = useCallback((trace: AgentTraceRun) => {
    rememberRun(trace);
  }, [rememberRun]);

  const handleMediaFiles = useCallback(async (fileList: FileList | File[]) => {
    const file = Array.from(fileList)[0];
    if (!file) return;
    const isVideo = file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|avi|mkv|flv|wmv)$/i.test(file.name);
    const kind: 'image' | 'video' = isVideo ? 'video' : 'image';
    setMediaProcessing(true);
    try {
      const asset = await importLocalAssetFile(file, { type: kind });
      // 注意：importLocalAssetFile 返回 { item, duplicate } 包装对象，
      // analyzeAssetImage / reasonAboutVideo 需要的是内部真实素材 asset.item。
      const realItem = asset.item;
      if (kind === 'image') {
        const a = await analyzeAssetImage({ item: realItem });
        const parts = [
          a.summary,
          a.subject && `主体：${a.subject}`,
          a.style && `风格：${a.style}`,
          a.scene && `场景：${a.scene}`,
          a.lighting && `光影：${a.lighting}`,
          a.composition && `构图：${a.composition}`,
          a.camera && `镜头/运镜：${a.camera}`,
          a.subjectColors && `主体颜色：${a.subjectColors}`,
          a.subjectDetails && `主体细节：${a.subjectDetails}`,
          a.action && `动作：${a.action}`,
          a.expression && `表情：${a.expression}`,
          a.vfx && `特效：${a.vfx}`,
          a.mood && `情绪：${a.mood}`,
        ].filter(Boolean);
        let analysisText = parts.join('；') || '已分析图片内容';
        const promptZh = (a.promptZh || '').trim();
        const promptEn = (a.promptEn || '').trim();
        if (promptZh || promptEn) {
          analysisText += `\n\n📋 可复制提示词（用于复现/生成同样的画面）：`;
          if (promptZh) analysisText += `\n中文：${promptZh}`;
          if (promptEn) analysisText += `\n英文：${promptEn}`;
        }
        // R5：后端分析失败时（如 Florence-2 崩溃回退）透传 warnings，让用户在面板可见。
        if (a?.warnings?.length) analysisText += `\n⚠️ ${a.warnings.join('；')}`;
        setAttachedMedia({ kind, fileName: file.name, asset: realItem, status: 'ready', analysis: analysisText });
      } else {
        const frames = await extractVideoFrames(file);
        const r = await reasonAboutVideo({ asset: realItem, frames });
        setAttachedMedia({ kind, fileName: file.name, asset: realItem, status: 'ready', reasoning: r.reasoning });
      }
    } catch (err) {
      setAttachedMedia({
        kind,
        fileName: file.name,
        asset: { id: '', type: kind, url: '', name: file.name } as AssetItem,
        status: 'error',
        error: err instanceof Error ? err.message : '媒体处理失败',
      });
    } finally {
      setMediaProcessing(false);
    }
  }, []);

  const handleRemoveMedia = useCallback(() => {
    setAttachedMedia(null);
  }, []);

  const handleMediaDrop = useCallback(
    async (e: ReactDragEvent) => {
      e.preventDefault();
      setMediaDragOver(false);
      if (mediaProcessing) return;
      const files = e.dataTransfer?.files;
      if (files && files.length) await handleMediaFiles(files);
    },
    [handleMediaFiles, mediaProcessing],
  );

  const handleMediaDragOver = useCallback((e: ReactDragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    setMediaDragOver(true);
  }, []);

  const handleMediaDragLeave = useCallback((e: ReactDragEvent) => {
    e.preventDefault();
    setMediaDragOver(false);
  }, []);

  /** 媒体工作流核心：分析/推理文本 + 资产 → 规划 plan → 建 PendingRun → 视检查点模式执行。
   *  供「面板内上传/拖拽」与「扩展机器人上传」两条路径复用。 */
  const runMediaPlan = useCallback(
    async (opts: {
      kind: 'image' | 'video';
      asset: { id: string; url: string; name: string };
      fileName: string;
      analysisText?: string;
      reasoningText?: string;
      userText: string;
    }) => {
      const { kind, asset, fileName, analysisText, reasoningText, userText } = opts;
      const mediaPlan = buildMediaAwarePlan({
        kind,
        asset: { id: asset.id, url: asset.url, name: asset.name },
        analysisText: kind === 'image' ? analysisText : undefined,
        reasoningText: kind === 'video' ? reasoningText : undefined,
        userText,
      });
      const mediaIntent: IntentResult = {
        skillId: kind === 'image' ? 'media-image' : 'media-video',
        skillName: kind === 'image' ? '图片分析工作流' : '视频推理工作流',
        confidence: 1,
        extractedParams: { attachedMedia: 'true', kind },
        suggestedSteps: mediaPlan.steps.map((s) => ({ type: s.type, label: s.label, prompt: '' })),
      };
      const mediaRoutes = buildRouteRecommendations(mediaPlan, mediaIntent.skillId);
      const mediaRoute = mediaRoutes.find((r) => r.recommended) || mediaRoutes[0];
      const mediaRoutedPlan = applyRouteToPlan(mediaPlan, mediaRoute);
      const mediaTraceId = createTraceRun(userText, mediaRoutedPlan, mediaIntent, mediaRoute, {
        templateId: 'media-' + kind,
      });
      const beforeSnapshot = exportCanvas();
      snapshotVaultRef.current[mediaTraceId] = { beforeSnapshot };
      const workflowSteps: WorkflowStepState[] = mediaRoutedPlan.steps.map((step) => ({ label: step.label, status: 'pending' }));
      const mediaPendingRun: PendingRun = {
        traceId: mediaTraceId,
        templateId: 'media-' + kind,
        input: userText,
        detectedIntent: mediaIntent,
        plan: mediaRoutedPlan,
        route: mediaRoute,
        checkpointStage: checkpointMode ? 'plan' : 'execute',
        beforeSnapshot,
        createdNodeIds: [],
      };
      setPendingRun(mediaPendingRun);
      appendTraceEvent(mediaTraceId, {
        kind: 'router',
        label: '媒体路线推荐',
        detail: `${mediaRoute.name} 路 ${mediaRoute.summary}`,
        status: 'done',
      });
      appendTraceEvent(mediaTraceId, {
        kind: 'plan',
        label: '已生成媒体工作流',
        detail: `识别为 ${mediaIntent.skillName}，共 ${mediaRoutedPlan.steps.length} 个步骤。`,
        status: 'done',
      });
      setMessages((prev) => [
        ...prev,
        {
          id: `user-${Date.now()}`,
          role: 'user',
          content: `📎 ${kind === 'image' ? '图片' : '视频'}附件：${fileName}${userText ? '\n' + userText : ''}`,
          timestamp: Date.now(),
        },
        {
          id: `intent-${Date.now()}`,
          role: 'system',
          content: `已${kind === 'image' ? '分析图片' : '推理视频'}（${fileName}），识别为 ${mediaIntent.skillName}（置信度 100%）`,
          timestamp: Date.now(),
          workflowStatus: checkpointMode ? 'awaiting-approval' : 'planning',
          workflowSteps,
        },
        {
          // 关键修复：把 Florence-2（免费）视觉分析结果直接返回到聊天面板，
          // 否则用户只看到「正在创建节点」而永远看不到真实风格分析。
          id: `analysis-${Date.now()}`,
          role: 'assistant',
          content: formatReferenceAnalysisMessage({ kind, analysisText, reasoningText, fileName }),
          timestamp: Date.now(),
        },
      ]);
      const isMediaGen = wantGenerationFromMedia(userText, kind);
      setExecutionState({
        status: checkpointMode && isMediaGen ? 'awaiting-approval' : 'planning',
        currentStep: describeExecutionStep(workflowSteps, checkpointMode && isMediaGen ? 'awaiting-approval' : 'planning', checkpointMode && isMediaGen ? 'plan' : null),
        summary: checkpointMode && isMediaGen
          ? '媒体计划和推荐路线已就绪，等待你确认后再继续。'
          : `已为你选择 ${mediaRoute.name}，马上开始执行。`,
        steps: workflowSteps,
        artifacts: buildExecutionArtifacts(mediaRoutedPlan, workflowSteps, mediaRoute),
        updatedAt: Date.now(),
      });
      if (!checkpointMode) {
        // R4：纯分析意图（如「分析参考图风格」）只把分析结果返回聊天面板，不创建任何节点，
        // 避免用户看到「正在创建节点」却永远卡住、且拿不到分析结果。
        if (wantGenerationFromMedia(userText, kind)) {
          await runWorkflowPlan(mediaPendingRun);
        } else {
          setExecutionState({
            status: 'completed',
            currentStep: '已完成素材分析',
            summary: `已分析${kind === 'image' ? '图片' : '视频'}（${fileName}），分析结果已返回聊天面板，未创建生成节点。`,
            steps: workflowSteps.map((s) => ({ ...s, status: 'done' as const })),
            artifacts: [],
            updatedAt: Date.now(),
          });
        }
      }
    },
    [checkpointMode, runWorkflowPlan],
  );

  // 扩展机器人上传的素材 → 复用画布媒体工作流（与面板内上传同一条链路）
  useEffect(() => {
    const off = onRunAgentWorkflow(async (ref: AgentWorkflowRef) => {
      if (isLoading || mediaProcessing) return;
      const asset = ref.asset;
      if (!asset || !asset.url) return;
      const kind: 'image' | 'video' = asset.type === 'video' ? 'video' : 'image';
      const fileName = asset.name || (kind === 'image' ? '图片' : '视频');
      setIsLoading(true);
      try {
        if (kind === 'image') {
          let analysisText: string | undefined;
          let reasoningText: string | undefined;
          // 扩展机器人若请求「深度分析」，复用 AIDeepAnalysisPanel 同款 VLM 管线，效果等同面板「发送给机器人」
          if (ref.deepAnalyze) {
            try {
              const itemToAnalyze: AssetItem = {
                id: asset.id || '',
                url: asset.url,
                name: fileName,
                type: 'image',
                thumbnail: asset.url,
                folderId: 'web',
                size: 0,
                tags: [],
                smartCategories: [],
                source: 'upload',
                createdAt: Date.now(),
                updatedAt: Date.now(),
              };
              const deep = await deepAnalyzeImage(itemToAnalyze, {});
              const t = deepAnalysisToMediaText(deep);
              analysisText = t.analysisText;
              reasoningText = t.reasoningText;
            } catch {
              analysisText = '已上传图片（深度分析失败，使用基础分析）';
            }
          }
          if (!analysisText) {
            try {
              const a = await analyzeAssetImage({ item: { id: asset.id || '', url: asset.url, name: fileName } as AssetItem });
              const parts = [
                a.summary,
                a.subject && `主体：${a.subject}`,
                a.style && `风格：${a.style}`,
                a.scene && `场景：${a.scene}`,
                a.lighting && `光影：${a.lighting}`,
              a.composition && `构图：${a.composition}`,
              a.camera && `镜头/运镜：${a.camera}`,
              a.subjectColors && `主体颜色：${a.subjectColors}`,
              a.subjectDetails && `主体细节：${a.subjectDetails}`,
              a.action && `动作：${a.action}`,
              a.expression && `表情：${a.expression}`,
              a.vfx && `特效：${a.vfx}`,
              a.mood && `情绪：${a.mood}`,
              ].filter(Boolean);
              analysisText = parts.join('；') || '已分析图片内容';
              const promptZh = (a.promptZh || '').trim();
              const promptEn = (a.promptEn || '').trim();
              if (promptZh || promptEn) {
                analysisText += `\n\n📋 可复制提示词（用于复现/生成同样的画面）：`;
                if (promptZh) analysisText += `\n中文：${promptZh}`;
                if (promptEn) analysisText += `\n英文：${promptEn}`;
              }
              // R5：透传后端回退 warnings（如 Florence-2 调用失败已用基础分析兜底）。
              if (a?.warnings?.length) analysisText += `\n⚠️ ${a.warnings.join('；')}`;
            } catch (anaErr) {
              // R5：分析请求本身失败要明确提示，而不是静默落到「已上传图片」。
              analysisText = `参考图分析失败：${anaErr instanceof Error ? anaErr.message : '未知错误'}（可能 Florence-2 未配置或调用出错）`;
            }
          }
          await runMediaPlan({
            kind,
            asset: { id: asset.id || '', url: asset.url, name: fileName },
            fileName,
            analysisText,
            reasoningText,
            userText: ref.userText || (ref.deepAnalyze ? '深度分析这张图片并生成工作流' : '分析这张图片'),
          });
        } else {
          let reasoningText: string | undefined;
          try {
            const resp = await fetch(asset.url);
            const blob = await resp.blob();
            const file = new File([blob], fileName, { type: blob.type || 'video/mp4' });
            const frames = await extractVideoFrames(file);
            const r = await reasonAboutVideo({ asset: { id: asset.id || '', url: asset.url, name: fileName } as AssetItem, frames });
            reasoningText = r.reasoning;
          } catch {
            reasoningText = undefined;
          }
          await runMediaPlan({
            kind,
            asset: { id: asset.id || '', url: asset.url, name: fileName },
            fileName,
            reasoningText,
            userText: ref.userText || '分析这段视频',
          });
        }
      } catch (error) {
        setMessages((prev) => [
          ...prev,
          { id: `error-${Date.now()}`, role: 'system', content: `扩展素材触发工作流失败：${error instanceof Error ? error.message : '未知错误'}`, timestamp: Date.now() },
        ]);
      } finally {
        setIsLoading(false);
      }
    });
    return off;
  }, [isLoading, mediaProcessing, runMediaPlan]);

  // AIDeepAnalysisPanel「发送给机器人」：把已算好的深度分析结果直接生成媒体工作流
  useEffect(() => {
    const off = onDeepAnalysisToAgent(async (ref: DeepAnalysisToAgentRef) => {
      if (isLoading || mediaProcessing) return;
      const { item, analysis } = ref;
      if (!item || !analysis) return;
      setIsLoading(true);
      try {
        const asset = { id: item.id || '', url: item.url || '', name: item.name || '图片' };
        const { analysisText, reasoningText } = deepAnalysisToMediaText(analysis);
        await runMediaPlan({
          kind: 'image',
          asset,
          fileName: asset.name,
          analysisText,
          reasoningText,
          userText: ref.userText || '基于深度分析结果生成工作流',
        });
      } catch (error) {
        setMessages((prev) => [
          ...prev,
          { id: `error-${Date.now()}`, role: 'system', content: `深度分析联动失败：${error instanceof Error ? error.message : '未知错误'}`, timestamp: Date.now() },
        ]);
      } finally {
        setIsLoading(false);
      }
    });
    return off;
  }, [isLoading, mediaProcessing, runMediaPlan]);

  // P2.b：调用后端流式智能体（SSE，/api/agent/chat）。失败/超时抛错，由 handleSend 回退到本地规则。
  // 仅依赖稳定的 setMessages；历史与画布摘要由调用方传入，避免闭包陈旧。
  const runBackendAgent = useCallback(async (
    userInput: string,
    history: { role: 'user' | 'assistant'; content: string }[],
    canvasSummary: string,
  ): Promise<{ intent: IntentResult; assistantId: string }> => {
    const assistantId = `agent-${Date.now()}`;
    const thinkingParts: string[] = [];
    const textParts: string[] = [];
    let planObj: any = null;
    const render = () => {
      const thinking = thinkingParts.join('');
      const text = textParts.join('');
      const content = (thinking ? '💭 ' + thinking + '\n' : '') + text;
      setMessages((prev) => {
        const exists = prev.find((m) => m.id === assistantId);
        if (exists) {
          return prev.map((m) => (m.id === assistantId
            ? { ...m, content, workflowStatus: planObj ? 'completed' : 'planning' }
            : m));
        }
        return [...prev, { id: assistantId, role: 'assistant', content, timestamp: Date.now(), workflowStatus: 'planning' }];
      });
    };
    render();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      const resp = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: userInput, history: history.slice(-6), canvasSummary, scope: 'global' }),
        signal: controller.signal,
      });
      if (!resp.ok || !resp.body) throw new Error('智能体端点返回 ' + resp.status);
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const ev = parseSseBlock(raw);
          if (!ev) continue;
          if (ev.event === 'thinking') thinkingParts.push((ev.data?.delta as string) || '');
          else if (ev.event === 'message') textParts.push((ev.data?.delta as string) || '');
          else if (ev.event === 'plan') planObj = ev.data;
          else if (ev.event === 'error') throw new Error((ev.data?.message as string) || '智能体出错');
          render();
        }
      }
    } finally {
      clearTimeout(timeout);
    }
    if (!planObj) throw new Error('智能体未返回计划');
    const extractedParams: Record<string, string> = {};
    const rp = (planObj.extractedParams || {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(rp)) extractedParams[k] = typeof v === 'string' ? v : JSON.stringify(v);
    const intent: IntentResult = {
      skillId: planObj.skillId,
      skillName: planObj.skillName,
      confidence: typeof planObj.confidence === 'number' ? planObj.confidence : 0.6,
      extractedParams,
      suggestedSteps: Array.isArray(planObj.suggestedSteps)
        ? planObj.suggestedSteps.map((s: Record<string, unknown>) => ({
            type: (s.type as NodeType) || ('text' as NodeType),
            label: typeof s.label === 'string' ? s.label : '',
            prompt: typeof s.prompt === 'string' ? s.prompt : '',
          }))
        : [],
    };
    return { intent, assistantId };
  }, [setMessages]);

  const handleSend = useCallback(async () => {
    const userInput = input.trim();
    if ((!userInput && !attachedMedia) || isLoading || mediaProcessing) return;

    setInput('');
    setIsLoading(true);

    // 媒体优先：用户上传/拖入了图片或视频 → 分析/推理后规划媒体工作流
    if (attachedMedia) {
      if (attachedMedia.status === 'error') {
        setMessages((prev) => [
          ...prev,
          { id: `error-${Date.now()}`, role: 'system', content: `媒体处理失败：${attachedMedia.error || '未知错误'}`, timestamp: Date.now() },
        ]);
        setIsLoading(false);
        return;
      }
      const mediaText = userInput || (attachedMedia.kind === 'image' ? '分析这张图片' : '分析这段视频');
      try {
        await runMediaPlan({
          kind: attachedMedia.kind,
          asset: { id: attachedMedia.asset.id, url: attachedMedia.asset.url, name: attachedMedia.asset.name },
          fileName: attachedMedia.fileName,
          analysisText: attachedMedia.kind === 'image' ? attachedMedia.analysis : undefined,
          reasoningText: attachedMedia.kind === 'video' ? attachedMedia.reasoning : undefined,
          userText: mediaText,
        });
      } catch (error) {
        setMessages((prev) => [
          ...prev,
          { id: `error-${Date.now()}`, role: 'system', content: `处理媒体请求时出错：${error instanceof Error ? error.message : '未知错误'}`, timestamp: Date.now() },
        ]);
      } finally {
        setAttachedMedia(null);
        setIsLoading(false);
      }
      return;
    }

    setMessages((prev) => [...prev, { id: `user-${Date.now()}`, role: 'user', content: userInput, timestamp: Date.now() }]);
    setIsLoading(true);

    let detectedIntent: IntentResult | null = null;
    let plan: WorkflowPlan | null = null;
    let detectorLabel = '本地模板';

    try {
      // P2.b：优先走后端流式智能体（无需用户 key，含思考流式展示）；失败/超时完整回退既有路径
      try {
        const history = messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .slice(-6)
          .map((m) => ({ role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant', content: m.content }));
        const st = useCanvasStore.getState().canvas;
        const nodeCounts: Record<string, number> = {};
        (st?.nodes || []).forEach((n: any) => { const t = n?.type || 'unknown'; nodeCounts[t] = (nodeCounts[t] || 0) + 1; });
        const canvasSummary = `节点数 ${st?.nodes?.length || 0}（${Object.entries(nodeCounts).map(([k, v]) => `${k}:${v}`).join(', ')}），连线 ${(st?.edges || []).length}`;
        const { intent: backendIntent } = await runBackendAgent(userInput, history, canvasSummary);
        if (backendIntent) {
          detectedIntent = backendIntent;
          detectorLabel = '智能体';
        }
      } catch (e) {
        console.warn('[SmartAgent] 后端智能体不可用，回退本地规则：', e);
      }
      if (detectedIntent && !plan) {
        try {
          const agentService = await import('@/services/agentService');
          plan = agentService.intentToWorkflowPlan(detectedIntent);
        } catch { /* ignore */ }
      }

      if (!detectedIntent) {
        const agentService = await import('@/services/agentService');
        const agentConfig = agentService.getAgentConfig();
        const remoteIntent = await agentService.detectIntent(userInput, agentConfig);
        if (remoteIntent?.suggestedSteps?.length) {
          detectedIntent = remoteIntent;
          plan = agentService.intentToWorkflowPlan(remoteIntent);
          detectorLabel = '智能规划';
        }
      }

      if (!plan) {
        const localIntent = detectIntent(userInput);
        detectedIntent = localIntent;
        const template = localIntent
          ? WORKFLOW_TEMPLATES.find((item) => item.skillId === localIntent.skillId)
          : null;
        if (localIntent && template) {
          plan = buildPlan(template.name, template.description, template.steps, userInput);
        }
      }

      if (!plan || !detectedIntent) {
        setMessages((prev) => [
          ...prev,
          {
            id: `assistant-${Date.now()}`,
            role: 'assistant',
            content: '我还没识别出明确的流程类型。你可以直接说“做一张海报”“生成电商短视频”或“规划品牌宣传片”这类更具体的目标。',
            timestamp: Date.now(),
          },
        ]);
        setExecutionState({
          status: 'paused',
          currentStep: '等待更明确的目标',
          summary: '没有识别出可执行工作流，请补充更具体的海报、品牌或视频目标。',
          steps: [],
          artifacts: [],
          updatedAt: Date.now(),
        });
        return;
      }

      const activeIntent = detectedIntent;
      const template = WORKFLOW_TEMPLATES.find((item) => item.skillId === activeIntent?.skillId);
      const basePlan = plan || (template ? buildPlan(template.name, template.description, template.steps, userInput) : null);
      if (!basePlan) return;

      if (!activeIntent) return;
      const routes = buildRouteRecommendations(basePlan, activeIntent.skillId);
      const recommendedRoute = routes.find((route) => route.recommended) || routes[0];
      setRouteRecommendations(routes);
      setSelectedRouteId(recommendedRoute.id);
      setSelectedSkill(activeIntent.skillId);
      const routedPlan = applyRouteToPlan(basePlan, recommendedRoute);
      const traceId = createTraceRun(userInput, routedPlan, activeIntent, recommendedRoute, {
        templateId: template?.id || activeIntent.skillId,
      });
      const beforeSnapshot = exportCanvas();
      snapshotVaultRef.current[traceId] = { beforeSnapshot };
      const workflowSteps: WorkflowStepState[] = routedPlan.steps.map((step) => ({ label: step.label, status: 'pending' }));
      const nextPendingRun: PendingRun = {
        traceId,
        templateId: template?.id || detectedIntent.skillId,
        input: userInput,
        detectedIntent,
        plan: routedPlan,
        route: recommendedRoute,
        checkpointStage: checkpointMode ? 'plan' : 'execute',
        beforeSnapshot,
        createdNodeIds: [],
      };
      setPendingRun(nextPendingRun);
      appendTraceEvent(traceId, {
        kind: 'router',
        label: '路线推荐已生成',
        detail: `${recommendedRoute.name} 路 ${recommendedRoute.summary}`,
        status: 'done',
      });
      appendTraceEvent(traceId, {
        kind: 'plan',
        label: '已生成计划草案',
        detail: `${detectorLabel}识别为 ${detectedIntent.skillName}，共 ${routedPlan.steps.length} 个步骤。`,
        status: 'done',
      });
      setMessages((prev) => [
        ...prev,
        {
          id: `intent-${Date.now()}`,
          role: 'system',
          content: `${detectorLabel}已识别：${detectedIntent!.skillName}（置信度 ${Math.round(detectedIntent!.confidence * 100)}%）`,
          timestamp: Date.now(),
          workflowStatus: checkpointMode ? 'awaiting-approval' : 'planning',
          workflowSteps,
        },
      ]);
      setExecutionState({
        status: checkpointMode ? 'awaiting-approval' : 'planning',
        currentStep: describeExecutionStep(workflowSteps, checkpointMode ? 'awaiting-approval' : 'planning', checkpointMode ? 'plan' : null),
        summary: checkpointMode
          ? '计划和推荐路线已就绪，等待你确认后再继续。'
          : `已为你选择 ${recommendedRoute.name}，马上开始执行。`,
        steps: workflowSteps,
        artifacts: buildExecutionArtifacts(routedPlan, workflowSteps, recommendedRoute),
        updatedAt: Date.now(),
      });
      if (!checkpointMode) {
        await runWorkflowPlan(nextPendingRun);
      }
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          id: `error-${Date.now()}`,
          role: 'system',
          content: `处理请求时出错：${error instanceof Error ? error.message : '未知错误'}`,
          timestamp: Date.now(),
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  }, [
    appendTraceEvent,
    checkpointMode,
    createTraceRun,
    exportCanvas,
    input,
    isLoading,
    messages,
    runBackendAgent,
    runWorkflowPlan,
  ]);

  const switchRoute = useCallback((routeId: RouteRecommendation['id']) => {
    setSelectedRouteId(routeId);
    setPendingRun((current) => {
      if (!current) return current;
      const nextRoute = routeRecommendations.find((item) => item.id === routeId);
      if (!nextRoute) return current;
      const nextPlan = applyRouteToPlan(current.plan, nextRoute);
      appendTraceEvent(current.traceId, {
        kind: 'router',
        label: '手动切换路线',
        detail: `已切换到 ${nextRoute.name}`,
        status: 'info',
      });
      updateTraceRun(current.traceId, (trace) => ({
        ...trace,
        routeId: nextRoute.id,
        routeName: nextRoute.name,
        routeSnapshot: cloneRouteRecommendation(nextRoute),
        planSnapshot: cloneWorkflowPlan(nextPlan),
        updatedAt: Date.now(),
      }));
      setExecutionState((prev) => ({
        ...prev,
        summary: `已切换到 ${nextRoute.name}：${nextRoute.summary}`,
        artifacts: buildExecutionArtifacts(nextPlan, prev.steps.length ? prev.steps : nextPlan.steps.map((step) => ({
          label: step.label,
          status: 'pending',
        })), nextRoute, current.createdNodeIds),
        updatedAt: Date.now(),
      }));
      return {
        ...current,
        route: nextRoute,
        plan: nextPlan,
      };
    });
  }, [appendTraceEvent, routeRecommendations, updateTraceRun]);

  const renderWorkflowStatus = (message: ChatMessage) => {
    if (!message.workflowSteps) return null;
    return (
      <div className="ml-9 mt-1.5 rounded-xl border border-[#2a2a2c] bg-[#161b22] p-3">
        <div className="mb-2 flex items-center gap-2">
          {message.workflowStatus === 'planning' ? <GitBranch className="h-3.5 w-3.5 text-[#1a8cff]" /> : null}
          {message.workflowStatus === 'awaiting-approval' ? <PauseCircle className="h-3.5 w-3.5 text-[#f59e0b]" /> : null}
          {message.workflowStatus === 'creating' ? <Loader2 className="h-3.5 w-3.5 animate-spin text-[#00d4aa]" /> : null}
          {message.workflowStatus === 'completed' ? <CheckCircle2 className="h-3.5 w-3.5 text-[#00d4aa]" /> : null}
          {message.workflowStatus === 'failed' ? <AlertCircle className="h-3.5 w-3.5 text-[#ef4444]" /> : null}
          {message.workflowStatus === 'paused' ? <PauseCircle className="h-3.5 w-3.5 text-[#f59e0b]" /> : null}
          <span className="text-xs font-medium text-[#e6edf3]">
            {message.workflowStatus === 'planning' && '正在规划'}
            {message.workflowStatus === 'awaiting-approval' && '等待确认'}
            {message.workflowStatus === 'creating' && '正在创建节点'}
            {message.workflowStatus === 'completed' && '创建完成'}
            {message.workflowStatus === 'failed' && '创建失败'}
            {message.workflowStatus === 'paused' && '已暂停'}
          </span>
        </div>
        <div className="space-y-1">
          {message.workflowSteps.map((step, index) => (
            <div key={`${message.id}-${index}`} className="flex items-center gap-2">
              {step.status === 'pending' ? <div className="h-3.5 w-3.5 rounded-full border border-[#3a3a3c]" /> : null}
              {step.status === 'running' ? <Loader2 className="h-3.5 w-3.5 animate-spin text-[#00d4aa]" /> : null}
              {step.status === 'done' ? <CheckCircle2 className="h-3.5 w-3.5 text-[#00d4aa]" /> : null}
              {step.status === 'error' ? <AlertCircle className="h-3.5 w-3.5 text-[#ef4444]" /> : null}
              <span
                className={`text-[11px] ${
                  step.status === 'done'
                    ? 'text-[#00d4aa]'
                    : step.status === 'running'
                      ? 'text-[#e6edf3]'
                      : step.status === 'error'
                        ? 'text-[#ef4444]'
                        : 'text-[#6e7681]'
                }`}
              >
                {step.label}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <>
      <style>{`
        @keyframes smart-agent-blink {
          0%, 8%, 44%, 46%, 100% { transform: scaleY(0); }
          4%, 45% { transform: scaleY(1); }
        }
        @keyframes smart-agent-float {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-3px); }
        }
      `}</style>
      {!isOpen ? (
        <div
          ref={buttonRef}
          data-testid="smart-agent-launcher"
          className="absolute z-[90]"
          style={{ left: `${position.x}px`, top: `${position.y}px` }}
        >
          <button
            type="button"
            onClick={handleLauncherClick}
            onPointerDown={handleDragHandlePointerDown}
            onMouseDown={handleDragHandleMouseDown}
            className="group relative flex h-[36px] w-[36px] cursor-grab items-center justify-center rounded-[12px] border border-white/14 bg-[linear-gradient(180deg,#3af5cc,#0ea58b)] shadow-[0_10px_24px_rgba(2,16,18,0.34)] transition-transform duration-200 hover:scale-[1.04] active:cursor-grabbing active:scale-[0.98]"
            title="打开智能机器人"
            aria-label="打开智能机器人"
            style={{ touchAction: 'none' }}
          >
            <span className="pointer-events-none absolute -inset-1.5 rounded-full bg-[#00d4aa]/24 blur-md transition-opacity duration-300 group-hover:opacity-100" />
            <span className="pointer-events-none absolute inset-[1px] rounded-[11px] bg-[radial-gradient(circle_at_30%_18%,rgba(255,255,255,0.86),rgba(255,255,255,0)_36%),linear-gradient(180deg,rgba(255,255,255,0.18),rgba(0,0,0,0.1))]" />
            <span
              className="pointer-events-none relative block h-[26px] w-[26px]"
              style={{ animation: 'smart-agent-float 4.6s ease-in-out infinite' }}
            >
              <span className="absolute inset-x-1 bottom-[1px] h-[4px] rounded-full bg-[#042b2a]/18 blur-[2px]" />
              <span className="absolute left-1/2 top-[2px] h-[5px] w-[5px] -translate-x-1/2 rounded-full bg-[#fff6d5] shadow-[0_0_0_1px_rgba(4,43,42,0.08)]" />
              <span className="absolute left-1/2 top-0 h-[4px] w-[1.5px] -translate-x-1/2 rounded-full bg-[#0d6e61]" />
              <span className="absolute inset-x-[3px] top-[5px] h-[17px] rounded-[8px] bg-[linear-gradient(180deg,#fffceb,#dffef7_60%,#8be5d5)] shadow-[inset_0_-2px_5px_rgba(4,38,35,0.12)]" />
              <span className="absolute left-1/2 top-[8px] -translate-x-1/2">
                <span
                  ref={glassesRef}
                  className="flex items-center gap-[1px] will-change-transform"
                >
                  <span className="relative flex h-[7.5px] w-[7.5px] items-center justify-center rounded-full border border-[#133243] bg-[#d7f7ff]/90 shadow-[inset_0_1px_1px_rgba(255,255,255,0.7)]">
                    <span ref={leftPupilRef} className="h-[2.25px] w-[2.25px] rounded-full bg-[#102034] transition-transform duration-75" />
                    <span
                      className="absolute inset-[0.5px] origin-top rounded-full bg-[#fff7d6]"
                      style={{ transform: 'scaleY(0)', animation: 'smart-agent-blink 5.8s ease-in-out infinite' }}
                    />
                  </span>
                  <span className="h-[1.5px] w-[3.5px] rounded-full bg-[#133243]" />
                  <span className="relative flex h-[7.5px] w-[7.5px] items-center justify-center rounded-full border border-[#133243] bg-[#d7f7ff]/90 shadow-[inset_0_1px_1px_rgba(255,255,255,0.7)]">
                    <span ref={rightPupilRef} className="h-[2.25px] w-[2.25px] rounded-full bg-[#102034] transition-transform duration-75" />
                    <span
                      className="absolute inset-[0.5px] origin-top rounded-full bg-[#fff7d6]"
                      style={{ transform: 'scaleY(0)', animation: 'smart-agent-blink 5.8s ease-in-out infinite 120ms' }}
                    />
                  </span>
                </span>
              </span>
              <span className="absolute left-1/2 top-[16px] h-[2px] w-[8px] -translate-x-1/2 rounded-full bg-[#0d7b67]/70" />
              <span className="absolute bottom-[2px] left-[5px] h-[4px] w-[4px] rounded-full border border-white/18 bg-[#0f8b76]" />
              <span className="absolute bottom-[2px] right-[5px] h-[4px] w-[4px] rounded-full border border-white/18 bg-[#0f8b76]" />
            </span>
          </button>
        </div>
      ) : null}

      {isOpen ? (
        <div
          data-testid="smart-agent-panel"
          className={`absolute z-[90] flex flex-col overflow-hidden rounded-2xl border border-[#2a2a2c] bg-[#1c1c1e] shadow-2xl ${
            isMobile ? 'inset-2 rounded-xl' : ''
          }`}
          style={isMobile ? undefined : {
            width: panelSize.width,
            height: panelSize.height,
            left: desktopPanelPosition?.left ?? 12,
            top: desktopPanelPosition?.top ?? 12,
          }}
        >
          <div className="flex shrink-0 items-center gap-3 border-b border-[#2a2a2c] px-4 py-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#00d4aa]/15">
              <Bot className="h-4 w-4 text-[#00d4aa]" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-sm font-semibold text-[#e6edf3]">智能机器人</h3>
              <p className="truncate text-[10px] text-[#6e7681]">Trace / Replay、人工确认、记忆图谱与产物来源面板</p>
            </div>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-[#8b949e] hover:bg-[#2a2a2c]"
              title="关闭"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <>
                  <div className="flex shrink-0 items-center gap-2 border-b border-[#2a2a2c] px-3 py-2">
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => setShowModelSelect((current) => !current)}
                        className="flex items-center gap-1.5 rounded-lg bg-[#2a2a2c] px-2.5 py-1.5 text-xs text-[#c9d1d9] transition-colors hover:bg-[#3a3a3c]"
                        title={`当前模式：${selectedModel.name}`}
                      >
                        <selectedModel.icon className="h-3.5 w-3.5" style={{ color: selectedModel.color }} />
                        {selectedModel.name}
                        <ChevronDown className="h-3 w-3 text-[#8b949e]" />
                      </button>
                      {showModelSelect ? (
                        <div className="absolute left-0 top-full z-50 mt-1 w-56 rounded-xl border border-[#3a3a3c] bg-[#1c1c1e] py-1 shadow-2xl">
                          {MODELS.map((model) => (
                            <button
                              key={model.id}
                              type="button"
                              onClick={() => {
                                setSelectedModel(model);
                                setShowModelSelect(false);
                              }}
                              className={`flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors ${
                                selectedModel.id === model.id ? 'bg-[#00d4aa]/10' : 'hover:bg-[#2a2a2c]'
                              }`}
                            >
                              <model.icon className="mt-0.5 h-4 w-4 shrink-0" style={{ color: model.color }} />
                              <div className="min-w-0">
                                <div className="text-xs font-medium text-[#c9d1d9]">{model.name}</div>
                                <div className="text-[10px] text-[#6e7681]">{model.desc}</div>
                              </div>
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>

                    <button
                      type="button"
                      onClick={() => setShowSkills((current) => !current)}
                      className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
                        showSkills || selectedSkill
                          ? 'bg-[#00d4aa]/15 text-[#00d4aa]'
                          : 'bg-[#2a2a2c] text-[#8b949e] hover:bg-[#3a3a3c]'
                      }`}
                      title="选择工作流技能"
                    >
                      <Wand2 className="h-3.5 w-3.5" />
                      {selectedSkillMeta?.name || '选择技能'}
                      <ChevronDown className="h-3 w-3" />
                    </button>

                    <button
                      type="button"
                      data-testid="smart-agent-checkpoint-toggle"
                      onClick={() => setCheckpointMode((current) => !current)}
                      className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
                        checkpointMode ? 'bg-[#1a8cff]/15 text-[#7cc4ff]' : 'bg-[#2a2a2c] text-[#8b949e]'
                      }`}
                      title="切换人工确认"
                    >
                      <ShieldCheck className="h-3.5 w-3.5" />
                      {checkpointMode ? '人工确认开' : '人工确认关'}
                    </button>

                    <div className="flex-1" />

                    <button
                      type="button"
                      onClick={() => setShowSettings((current) => !current)}
                      className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${
                        showSettings ? 'bg-[#00d4aa]/15 text-[#00d4aa]' : 'text-[#8b949e] hover:bg-[#2a2a2c]'
                      }`}
                      title="BYOK 设置"
                    >
                      <Settings className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {showSettings ? (
                    <div className="shrink-0 space-y-3 border-b border-[#2a2a2c] px-3 py-3">
                      <div className="flex items-center gap-2">
                        <Key className="h-3.5 w-3.5 text-[#fbbf24]" />
                        <span className="text-xs font-medium text-[#e6edf3]">临时 API Key 校验</span>
                        <span className="text-[10px] text-[#6e7681]">只做连通性验证，不会自动触发生成</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <select
                          value={byokProvider}
                          onChange={(event) => {
                            setByokProvider(event.target.value);
                            setByokResult(null);
                          }}
                          className="rounded-lg border border-[#30363d] bg-[#0d1117] px-2 py-1.5 text-xs text-[#c9d1d9]"
                          aria-label="选择平台"
                        >
                          <option value="openai">OpenAI</option>
                          <option value="deepseek">DeepSeek</option>
                          <option value="zhipu">智谱</option>
                          <option value="dashscope">阿里云百炼</option>
                          <option value="siliconflow">硅基流动</option>
                          <option value="minimax">MiniMax</option>
                        </select>
                        <div className="relative flex-1">
                          <input
                            type={byokShowKey ? 'text' : 'password'}
                            value={byokKey}
                            onChange={(event) => {
                              setByokKey(event.target.value);
                              setByokResult(null);
                            }}
                            placeholder="sk-..."
                            className="w-full rounded-lg border border-[#30363d] bg-[#0d1117] px-2.5 py-1.5 pr-8 text-xs text-[#e6edf3] outline-none focus:border-[#00d4aa]"
                            aria-label="API Key"
                          />
                          <button
                            type="button"
                            onClick={() => setByokShowKey((current) => !current)}
                            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[#8b949e] transition-colors hover:text-white"
                            title={byokShowKey ? '隐藏' : '显示'}
                          >
                            {byokShowKey ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                          </button>
                        </div>
                        <button
                          type="button"
                          disabled={!byokKey.trim() || byokValidating}
                          onClick={async () => {
                            if (!byokKey.trim()) return;
                            setByokValidating(true);
                            setByokResult(null);
                            try {
                              const result = await validateByokKey(byokProvider, byokKey.trim());
                              setByokResult({
                                success: result.success,
                                message: result.success
                                  ? `校验通过：${result.maskedKey}${result.latencyMs ? ` · ${result.latencyMs}ms` : ""}`
                                  : result.error?.message || result.message || '校验失败',
                              });
                            } catch (error) {
                              setByokResult({
                                success: false,
                                message: error instanceof Error ? error.message : '网络错误',
                              });
                            } finally {
                              setByokValidating(false);
                            }
                          }}
                          className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                            !byokKey.trim() || byokValidating
                              ? 'cursor-not-allowed bg-[#21262d] text-[#6e7681]'
                              : 'bg-[#00d4aa] text-[#0d1117] hover:bg-[#00e5b3]'
                          }`}
                        >
                          {byokValidating ? <Loader2 className="h-3 w-3 animate-spin" /> : '校验'}
                        </button>
                      </div>
                      {byokResult ? (
                        <div className={`flex items-center gap-1.5 text-xs ${byokResult.success ? 'text-[#00d4aa]' : 'text-[#f85149]'}`}>
                          {byokResult.success ? <CheckCircle2 className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
                          {byokResult.message}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {showSkills ? (
                    <div className="grid shrink-0 grid-cols-2 gap-2 border-b border-[#2a2a2c] px-3 py-2">
                      {SKILLS.map((skill) => {
                        const active = selectedSkill === skill.id;
                        return (
                          <button
                            key={skill.id}
                            type="button"
                            onClick={() => {
                              setSelectedSkill(active ? null : skill.id);
                              setShowSkills(false);
                            }}
                            className={`rounded-xl px-3 py-2 text-left transition-colors ${
                              active ? 'bg-[#00d4aa]/15 ring-1 ring-[#00d4aa]/30' : 'bg-[#2a2a2c] hover:bg-[#3a3a3c]'
                            }`}
                          >
                            <div className="text-xs font-medium text-[#c9d1d9]">{skill.name}</div>
                            <div className="mt-1 text-[10px] text-[#6e7681]">{skill.desc}</div>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}

                  <div className={`flex-1 min-h-0 ${isMobile ? 'flex flex-col gap-3 px-4 py-3' : 'grid min-h-0 grid-cols-[minmax(0,1fr)_270px] gap-3 px-4 py-3'}`}>
                    <div className="space-y-3 overflow-y-auto pr-1">
                      {messages.map((message) => (
                        <div key={message.id}>
                          {message.role !== 'system' ? (
                            <div className={`flex gap-2 ${message.role === 'user' ? 'flex-row-reverse' : ''}`}>
                              <div
                                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
                                  message.role === 'assistant' ? 'bg-[#00d4aa]/15' : 'bg-[#1a8cff]/15'
                                }`}
                              >
                                {message.role === 'assistant' ? (
                                  <Sparkles className="h-3.5 w-3.5 text-[#00d4aa]" />
                                ) : (
                                  <User className="h-3.5 w-3.5 text-[#1a8cff]" />
                                )}
                              </div>
                              <div
                                className={`max-w-[82%] rounded-xl px-3 py-2 text-xs leading-relaxed whitespace-pre-line ${
                                  message.role === 'assistant' ? 'bg-[#2a2a2c] text-[#c9d1d9]' : 'bg-[#00d4aa]/15 text-[#00d4aa]'
                                }`}
                              >
                                {message.content}
                              </div>
                            </div>
                          ) : (
                            <div className="rounded-xl border border-[#2a2a2c] bg-[#161b22] px-3 py-2 text-[11px] text-[#8b949e]">
                              {message.content}
                            </div>
                          )}
                          {renderWorkflowStatus(message)}
                        </div>
                      ))}

                      {isLoading ? (
                        <div className="flex gap-2">
                          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#00d4aa]/15">
                            <Sparkles className="h-3.5 w-3.5 text-[#00d4aa]" />
                          </div>
                          <div className="flex items-center gap-1.5 rounded-xl bg-[#2a2a2c] px-3 py-2">
                            <Loader2 className="h-3 w-3 animate-spin text-[#8b949e]" />
                            <span className="text-xs text-[#8b949e]">正在分析需求并生成 Trace / Router / Plan…</span>
                          </div>
                        </div>
                      ) : null}
                      <div ref={messagesEndRef} />
                    </div>

                    <aside
                      data-testid="smart-agent-execution-rail"
                      className="flex min-h-0 flex-col gap-3 overflow-y-auto rounded-2xl border border-[#2a2a2c] bg-[#111318] p-3"
                    >
                      <div className="rounded-xl border border-[#2a2a2c] bg-[#161b22] p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-[#6e7681]">当前步骤</div>
                          <div className="rounded-full bg-[#222830] px-2 py-0.5 text-[10px] text-[#9bb4c7]">{executionState.status}</div>
                        </div>
                        <div data-testid="smart-agent-current-step" className="mt-2 text-sm font-semibold text-[#e6edf3]">
                          {executionState.currentStep}
                        </div>
                        <p className="mt-2 text-[11px] leading-5 text-[#8b949e]">{executionState.summary}</p>
                      </div>

                      <div
                        data-testid="smart-agent-checkpoint-panel"
                        className="rounded-xl border border-[#2a2a2c] bg-[#161b22] p-3"
                      >
                        <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-[#6e7681]">
                          <ShieldCheck className="h-3.5 w-3.5 text-[#7cc4ff]" />
                          Checkpoint / Human-in-the-loop
                        </div>
                        <p className="text-[11px] leading-5 text-[#8b949e]">
                          {pendingRun
                            ? `当前等待 ${pendingRun.checkpointStage === 'plan' ? '计划确认' : pendingRun.checkpointStage === 'execute' ? '执行确认' : '交付确认'}。`
                            : checkpointMode
                              ? '已开启人工确认。下一次规划会依次停在计划、执行和交付前。'
                              : '当前关闭人工确认，可切回“人工确认开”进入更稳的审查模式。'}
                        </p>
                        {pendingRun ? (
                          <div className="mt-3 flex gap-2">
                            <button
                              type="button"
                              data-testid="smart-agent-checkpoint-approve"
                              onClick={() => void approveCheckpoint()}
                              className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-[#00d4aa] px-3 py-2 text-xs font-medium text-[#0d1117] hover:bg-[#00e5b3]"
                            >
                              <CheckCheck className="h-3.5 w-3.5" />
                              {pendingRun.checkpointStage === 'deliver' ? '确认交付' : pendingRun.checkpointStage === 'execute' ? '开始执行' : '确认计划'}
                            </button>
                            <button
                              type="button"
                              data-testid="smart-agent-checkpoint-cancel"
                              onClick={() => cancelPendingRun('已取消当前工作流。')}
                              className="flex items-center justify-center gap-1 rounded-lg border border-[#3a3a3c] px-3 py-2 text-xs text-[#c9d1d9] hover:bg-[#222830]"
                            >
                              <X className="h-3.5 w-3.5" />
                              取消
                            </button>
                          </div>
                        ) : null}
                      </div>

                      {/* 生成任务进度聚合（G13）：与右侧 docked 面板共用同一份队列真源。 */}
                      <div data-testid="smart-agent-queue-aggregate">
                        <GenerationProgressCard />
                      </div>

                      <div
                        data-testid="smart-agent-router-panel"
                        className="rounded-xl border border-[#2a2a2c] bg-[#161b22] p-3"
                      >
                        <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-[#6e7681]">
                          <Route className="h-3.5 w-3.5 text-[#f59e0b]" />
                          Tool Capability Router
                        </div>
                        <div className="space-y-2">
                          {routeRecommendations.length === 0 ? (
                            <div className="rounded-xl border border-dashed border-[#2a2a2c] px-3 py-2 text-[11px] text-[#6e7681]">
                              规划完成后，这里会按能力、成本和时延给出推荐路线。
                            </div>
                          ) : routeRecommendations.map((route) => (
                            <button
                              key={route.id}
                              type="button"
                              data-testid={`smart-agent-route-${route.id}`}
                              onClick={() => switchRoute(route.id)}
                              className={`w-full rounded-xl border px-3 py-2 text-left transition-colors ${
                                selectedRouteId === route.id
                                  ? 'border-[#00d4aa]/45 bg-[#0f1c1a]'
                                  : 'border-[#2a2a2c] bg-[#12171d] hover:bg-[#1b2128]'
                              }`}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div className="text-[11px] font-medium text-[#e6edf3]">{route.name}</div>
                                {route.recommended ? (
                                  <span className="rounded-full bg-[#00d4aa]/15 px-2 py-0.5 text-[10px] text-[#00d4aa]">推荐</span>
                                ) : null}
                              </div>
                              <div className="mt-1 text-[10px] text-[#8b949e]">{route.summary}</div>
                              <div className="mt-2 flex flex-wrap gap-1 text-[10px] text-[#9ab0c2]">
                                <span className="rounded-full bg-[#20262f] px-2 py-0.5">{route.providerLabel}</span>
                                <span className="rounded-full bg-[#20262f] px-2 py-0.5">{route.etaLabel}</span>
                                <span className="rounded-full bg-[#20262f] px-2 py-0.5">{route.costLabel}</span>
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="rounded-xl border border-[#2a2a2c] bg-[#161b22] p-3">
                        <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-[#6e7681]">
                          <Clock3 className="h-3.5 w-3.5 text-[#7cc4ff]" />
                          执行时间线
                        </div>
                        <div data-testid="smart-agent-execution-timeline" className="space-y-2">
                          {activeTrace?.events?.length ? activeTrace.events.map((event) => (
                            <div key={event.id} className="rounded-xl border border-[#2a2a2c] bg-[#12171d] px-3 py-2">
                              <div className="flex items-center justify-between gap-2">
                                <div className="text-[11px] font-medium text-[#e6edf3]">{event.label}</div>
                                <div className={`text-[10px] ${
                                  event.status === 'done'
                                    ? 'text-[#00d4aa]'
                                    : event.status === 'running'
                                      ? 'text-[#7cc4ff]'
                                      : event.status === 'warning'
                                        ? 'text-[#f59e0b]'
                                        : event.status === 'error'
                                          ? 'text-[#ef4444]'
                                          : 'text-[#8b949e]'
                                }`}
                                >
                                  {formatRelativeTime(event.at)}
                                </div>
                              </div>
                              <p className="mt-1 text-[10px] leading-5 text-[#8b949e]">{event.detail}</p>
                            </div>
                          )) : (
                            <div className="rounded-xl border border-dashed border-[#2a2a2c] px-3 py-2 text-[11px] text-[#6e7681]">
                              发送需求后，这里会记录每一步动作、节点变更和交付动作。
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="rounded-xl border border-[#2a2a2c] bg-[#161b22] p-3">
                        <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-[#6e7681]">
                          <PackageSearch className="h-3.5 w-3.5 text-[#00d4aa]" />
                          Artifact Provenance Card
                        </div>
                        <div data-testid="smart-agent-artifact-cards" className="space-y-2">
                          {executionState.artifacts.length ? executionState.artifacts.map((artifact) => (
                            <div key={artifact.id} className="rounded-xl border border-[#2a2a2c] bg-[#12171d] px-3 py-2">
                              <div className="flex items-center justify-between gap-2">
                                <div className="truncate text-[11px] font-medium text-[#e6edf3]">{artifact.title}</div>
                                <span
                                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${
                                    artifact.status === 'ready'
                                      ? 'bg-[#00d4aa]/15 text-[#00d4aa]'
                                      : artifact.status === 'error'
                                        ? 'bg-[#ef4444]/15 text-[#ef4444]'
                                        : 'bg-[#2a2a2c] text-[#8b949e]'
                                  }`}
                                >
                                  {artifact.status === 'ready' ? '已产出' : artifact.status === 'error' ? '失败' : '排队中'}
                                </span>
                              </div>
                              <div className="mt-1 text-[10px] leading-5 text-[#8b949e]">{artifact.detail}</div>
                              <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] text-[#9ab0c2]">
                                <div>来源：{artifact.sourceStep}</div>
                                <div>版本：{artifact.version}</div>
                                <div>模型：{artifact.provider} / {artifact.model}</div>
                                {artifact.autoSwitched ? (
                                  <div className="col-span-2 mt-1 rounded bg-[#9e6a03]/15 px-1.5 py-0.5 text-[9px] text-[#e3b341]">
                                    已自动切换模型：免费模型不支持该任务，按优先级切到能支持的模型
                                  </div>
                                ) : (
                                  <div className="text-[#3fb950]">免费优先</div>
                                )}
                                <div>耗时：约 {artifact.etaSeconds}s</div>
                                <div>成本：约 ¥{artifact.estimatedCost.toFixed(2)}</div>
                                <div>节点：{artifact.nodeId || '待生成'}</div>
                              </div>
                              <div className="mt-2 flex gap-2">
                                <button
                                  type="button"
                                  data-testid={`smart-agent-artifact-focus-${artifact.id}`}
                                  onClick={() => focusArtifactNode(artifact)}
                                  disabled={!artifact.nodeId}
                                  className={`rounded-lg px-2.5 py-1 text-[10px] ${
                                    artifact.nodeId
                                      ? 'bg-[#1a8cff]/15 text-[#7cc4ff] hover:bg-[#1a8cff]/20'
                                      : 'bg-[#20262f] text-[#5f6b77]'
                                  }`}
                                >
                                  聚焦节点
                                </button>
                                <button
                                  type="button"
                                  data-testid={`smart-agent-artifact-rollback-${artifact.id}`}
                                  onClick={() => activeTrace && rollbackTraceRun(activeTrace.id)}
                                  className="rounded-lg bg-[#ef4444]/10 px-2.5 py-1 text-[10px] text-[#ef8f8f] hover:bg-[#ef4444]/15"
                                >
                                  可回退
                                </button>
                              </div>
                            </div>
                          )) : (
                            <div className="rounded-xl border border-dashed border-[#2a2a2c] px-3 py-2 text-[11px] text-[#6e7681]">
                              生成后的节点、来源模型、成本、版本与回退动作会显示在这里。
                            </div>
                          )}
                        </div>
                      </div>

                      <div
                        data-testid="smart-agent-trace-panel"
                        className="rounded-xl border border-[#2a2a2c] bg-[#161b22] p-3"
                      >
                        <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-[#6e7681]">
                          <RotateCcw className="h-3.5 w-3.5 text-[#f59e0b]" />
                          Agent Trace + Replay
                        </div>
                        <div className="space-y-2">
                          {traceRuns.length ? traceRuns.slice(0, 4).map((trace) => (
                            <div key={trace.id} className={`rounded-xl border px-3 py-2 ${activeTrace?.id === trace.id ? 'border-[#00d4aa]/35 bg-[#0f1c1a]' : 'border-[#2a2a2c] bg-[#12171d]'}`}>
                              <button
                                type="button"
                                onClick={() => setActiveTraceId(trace.id)}
                                className="w-full text-left"
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <div className="truncate text-[11px] font-medium text-[#e6edf3]">{trace.planName}</div>
                                  <div className="text-[10px] text-[#8b949e]">{trace.status}</div>
                                </div>
                                <div className="mt-1 text-[10px] leading-5 text-[#8b949e]">
                                  {trace.routeName} · {trace.skillName} · 模板 {trace.templateId}
                                  {trace.replaySourceTraceId ? ` · 复盘自 ${trace.replaySourceTraceId}` : ''}
                                </div>
                              </button>
                              <div className="mt-2 flex gap-2">
                                <button
                                  type="button"
                                  data-testid={`smart-agent-replay-${trace.id}`}
                                  onClick={() => replayTraceRun(trace)}
                                  className="rounded-lg bg-[#1a8cff]/15 px-2.5 py-1 text-[10px] text-[#7cc4ff] hover:bg-[#1a8cff]/20"
                                >
                                  <span className="inline-flex items-center gap-1"><Play className="h-3 w-3" />一键复盘</span>
                                </button>
                                <button
                                  type="button"
                                  data-testid={`smart-agent-save-memory-${trace.id}`}
                                  onClick={() => saveMemoryFromTrace(trace)}
                                  className="rounded-lg bg-[#00d4aa]/15 px-2.5 py-1 text-[10px] text-[#00d4aa] hover:bg-[#00d4aa]/20"
                                >
                                  <span className="inline-flex items-center gap-1"><Save className="h-3 w-3" />写入记忆</span>
                                </button>
                              </div>
                            </div>
                          )) : (
                            <div className="rounded-xl border border-dashed border-[#2a2a2c] px-3 py-2 text-[11px] text-[#6e7681]">
                              暂无 Trace。完成一次规划后，这里会保留可回放轨迹。
                            </div>
                          )}
                        </div>
                      </div>

                      <div
                        data-testid="smart-agent-memory-panel"
                        className="rounded-xl border border-[#2a2a2c] bg-[#161b22] p-3"
                      >
                        <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-[#6e7681]">
                          <BrainCircuit className="h-3.5 w-3.5 text-[#00d4aa]" />
                          Memory Graph
                        </div>
                        <div className="space-y-2">
                          {memoryGraph.length ? memoryGraph.slice(0, 5).map((memory) => (
                            <div key={memory.id} className="rounded-xl border border-[#2a2a2c] bg-[#12171d] px-3 py-2">
                              <div className="flex items-center justify-between gap-2">
                                <div className="truncate text-[11px] font-medium text-[#e6edf3]">{memory.title}</div>
                                <div className="text-[10px] text-[#8b949e]">{formatRelativeTime(memory.updatedAt)}</div>
                              </div>
                              <div className="mt-1 text-[10px] text-[#8b949e]">{memory.summary}</div>
                              <div className="mt-2 flex flex-wrap gap-1">
                                <span className="rounded-full bg-[#1a8cff]/12 px-2 py-0.5 text-[10px] text-[#8cc8ff]">{memory.layer}</span>
                                {memory.nodeTypes.map((nodeType) => (
                                  <span key={`${memory.id}-${nodeType}`} className="rounded-full bg-[#20262f] px-2 py-0.5 text-[10px] text-[#9ab0c2]">
                                    {nodeType}
                                  </span>
                                ))}
                              </div>
                              <div className="mt-2 flex flex-wrap gap-1">
                                {memory.tags.map((tag) => (
                                  <span key={`${memory.id}-${tag}`} className="rounded-full bg-[#20262f] px-2 py-0.5 text-[10px] text-[#9ab0c2]">
                                    {tag}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )) : (
                            <div className="rounded-xl border border-dashed border-[#2a2a2c] px-3 py-2 text-[11px] text-[#6e7681]">
                              长期记忆为空。交付确认后，品牌风格和常用工作流会沉淀到这里。
                            </div>
                          )}
                        </div>
                      </div>
                    </aside>
                  </div>

                  <div className="shrink-0 border-t border-[#2a2a2c] px-3 py-2">
                    {selectedSkillMeta ? (
                      <div className="mb-1 flex items-center gap-2 px-1">
                        <span className="text-[10px] text-[#00d4aa]">当前技能：{selectedSkillMeta.name}</span>
                        <button
                          type="button"
                          onClick={() => setSelectedSkill(null)}
                          className="text-[10px] text-[#6e7681] hover:text-[#c9d1d9]"
                        >
                          清除
                        </button>
                      </div>
                    ) : null}
                    <div
                      className={`relative flex items-end gap-2 rounded-xl border bg-[#2a2a2c] px-3 py-2 transition-colors focus-within:border-[#00d4aa] ${
                        mediaDragOver ? 'border-[#00d4aa]' : 'border-[#3a3a3c]'
                      }`}
                      onDragOver={handleMediaDragOver}
                      onDragLeave={handleMediaDragLeave}
                      onDrop={handleMediaDrop}
                    >
                      {mediaDragOver ? (
                        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-[#0d1117]/80 text-[11px] text-[#00d4aa]">
                          松开以添加图片 / 视频
                        </div>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => mediaFileInputRef.current?.click()}
                        disabled={mediaProcessing}
                        title="上传图片或视频"
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#21262d] text-[#8b949e] hover:text-[#c9d1d9] disabled:opacity-50"
                      >
                        <Paperclip className="h-3.5 w-3.5" />
                      </button>
                      <textarea
                        value={input}
                        onChange={(event) => setInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && !event.shiftKey) {
                            event.preventDefault();
                            void handleSend();
                          }
                        }}
                        placeholder="描述你想创建的内容，或拖入 / 上传图片、视频让我分析。"
                        rows={1}
                        aria-label="输入工作流需求"
                        className="max-h-[96px] flex-1 resize-none bg-transparent text-xs text-[#e6edf3] outline-none placeholder:text-[#5a5a5c]"
                      />
                      <button
                        type="button"
                        onClick={() => void handleSend()}
                        disabled={(attachedMedia?.status !== 'ready' && !input.trim()) || isLoading || mediaProcessing}
                        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors ${
                          (input.trim() || attachedMedia?.status === 'ready') && !isLoading && !mediaProcessing
                            ? 'bg-[#00d4aa] text-[#0d1117] hover:bg-[#00e5b3]'
                            : 'bg-[#21262d] text-[#6e7681]'
                        }`}
                        title="发送"
                      >
                        <Send className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <input
                      ref={mediaFileInputRef}
                      type="file"
                      accept="image/*,video/*"
                      className="hidden"
                      onChange={(event) => {
                        const files = event.target.files;
                        if (files && files.length) void handleMediaFiles(files);
                        event.target.value = '';
                      }}
                    />
                    {attachedMedia ? (
                      <div className="mt-1 flex items-center gap-2 rounded-lg border border-[#2a2a2c] bg-[#1c1c1e] px-2 py-1">
                        {attachedMedia.kind === 'image' ? (
                          <ImageIcon className="h-3.5 w-3.5 shrink-0 text-[#00d4aa]" />
                        ) : (
                          <Film className="h-3.5 w-3.5 shrink-0 text-[#00d4aa]" />
                        )}
                        <span className="max-w-[180px] truncate text-[10px] text-[#c9d1d9]">{attachedMedia.fileName}</span>
                        {mediaProcessing ? (
                          <Loader2 className="h-3 w-3 animate-spin text-[#8b949e]" />
                        ) : attachedMedia.status === 'ready' ? (
                          <span className="text-[10px] text-[#3fb950]">{attachedMedia.kind === 'image' ? '已分析' : '已推理'}</span>
                        ) : (
                          <span className="text-[10px] text-[#f85149]">失败</span>
                        )}
                        <button
                          type="button"
                          onClick={handleRemoveMedia}
                          className="ml-auto text-[#6e7681] hover:text-[#c9d1d9]"
                          title="移除"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ) : null}
                    <p className="mt-1 text-center text-[10px] text-[#5a5a5c]">
                      可拖入或上传图片 / 视频 · Shift+Enter 换行，Enter 发送
                    </p>
                  </div>
            </>

          {!isMobile ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-end px-3 pb-2">
              <button
                type="button"
                data-testid="smart-agent-resize-handle"
                onPointerDown={handlePanelResizePointerDown}
                onMouseDown={handlePanelResizeMouseDown}
                className="pointer-events-auto flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-[#111318]/90 text-[#8b949e] transition-colors hover:border-[#00d4aa]/40 hover:text-[#00d4aa]"
                title="拖拽缩放面板"
                style={{ touchAction: 'none' }}
              >
                <span className="grid grid-cols-2 gap-[2px]">
                  <span className="h-[3px] w-[3px] rounded-full bg-current" />
                  <span className="h-[3px] w-[3px] rounded-full bg-current" />
                  <span className="h-[3px] w-[3px] rounded-full bg-current" />
                  <span className="h-[3px] w-[3px] rounded-full bg-current" />
                </span>
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
