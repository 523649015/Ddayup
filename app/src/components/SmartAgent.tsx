import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
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
  GitBranch,
  Key,
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
import type { NodeType } from '@/types';

type WorkflowStepState = {
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
};

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  workflowStatus?: 'planning' | 'awaiting-approval' | 'creating' | 'completed' | 'failed' | 'paused';
  workflowSteps?: WorkflowStepState[];
};

type AgentModel = {
  id: string;
  name: string;
  desc: string;
  icon: LucideIcon;
  color: string;
};

type AgentSkill = {
  id: string;
  name: string;
  desc: string;
};

type WorkflowTemplate = {
  id: string;
  skillId: string;
  name: string;
  keywords: string[];
  description: string;
  steps: Array<{
    type: NodeType;
    label: string;
    buildData: (input: string) => Record<string, unknown>;
  }>;
};

type CheckpointStage = 'plan' | 'execute' | 'deliver';

type ExecutionArtifact = {
  id: string;
  title: string;
  detail: string;
  status: 'pending' | 'ready' | 'error';
  nodeId?: string;
  sourceStep: string;
  provider: string;
  model: string;
  etaSeconds: number;
  estimatedCost: number;
  version: string;
};

type ExecutionState = {
  status: 'idle' | 'planning' | 'awaiting-approval' | 'creating' | 'completed' | 'failed' | 'paused';
  currentStep: string;
  summary: string;
  steps: WorkflowStepState[];
  artifacts: ExecutionArtifact[];
  updatedAt: number;
};

type AgentTraceEvent = {
  id: string;
  kind: 'router' | 'checkpoint' | 'plan' | 'step' | 'artifact' | 'deliver' | 'memory' | 'rollback' | 'replay' | 'error';
  label: string;
  detail: string;
  status: 'info' | 'running' | 'done' | 'warning' | 'error';
  at: number;
};

type AgentTraceRun = {
  id: string;
  input: string;
  planName: string;
  skillId: string;
  skillName: string;
  templateId: string;
  routeId: string;
  routeName: string;
  status: 'draft' | 'awaiting-plan' | 'awaiting-execute' | 'running' | 'awaiting-deliver' | 'completed' | 'failed' | 'rolled-back';
  checkpointMode: boolean;
  createdAt: number;
  updatedAt: number;
  nodeIds: string[];
  events: AgentTraceEvent[];
  artifacts: ExecutionArtifact[];
  planSnapshot: WorkflowPlan;
  routeSnapshot: RouteRecommendation;
  replaySourceTraceId?: string;
  version: number;
};

type RouteRecommendation = {
  id: 'balanced' | 'speed' | 'quality';
  name: string;
  providerLabel: string;
  etaLabel: string;
  costLabel: string;
  fitLabel: string;
  summary: string;
  capabilities: string[];
  textProvider: string;
  textModel: string;
  imageProvider: string;
  imageModel: string;
  videoProvider: string;
  videoModel: string;
  estimatedCost: number;
  estimatedEtaSeconds: number;
  recommended: boolean;
};

type PendingRun = {
  traceId: string;
  templateId: string;
  input: string;
  detectedIntent: IntentResult;
  plan: WorkflowPlan;
  route: RouteRecommendation;
  checkpointStage: CheckpointStage;
  beforeSnapshot: string;
  createdNodeIds: string[];
  replaySourceTraceId?: string;
};

const NODE_WIDTH = 380;
const NODE_GAP_X = 120;
const NODE_GAP_Y = 60;
const SMART_AGENT_LAUNCHER_SIZE = 36;
const TRACE_STORAGE_KEY = 'hmdao-smart-agent-traces';
const MAX_TRACE_RUNS = 8;

const MODELS: AgentModel[] = [
  { id: 'workflow', name: 'Workflow', desc: '适合工作流规划、批量节点编排和自动执行。', icon: Sparkles, color: '#00d4aa' },
  { id: 'vision', name: 'Vision', desc: '适合理解图片、视频与参考素材之间的关系。', icon: Bot, color: '#1a8cff' },
  { id: 'planning', name: 'Planner', desc: '适合复杂多阶段执行、检查点和人工确认。', icon: GitBranch, color: '#f59e0b' },
];

const SKILLS: AgentSkill[] = [
  { id: 'poster', name: '海报创作', desc: '海报、KV、活动主视觉' },
  { id: 'product', name: '电商物料', desc: '商品图、卖点图、短视频' },
  { id: 'brand', name: '品牌内容', desc: '品牌视觉、脚本、宣传片' },
  { id: 'story', name: '叙事短片', desc: '故事设定、分镜与预演视频' },
];

const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'poster',
    skillId: 'poster',
    name: '海报创作流程',
    description: '从创意文案到主视觉海报的自动化工作流。',
    keywords: ['海报', '主视觉', 'banner', '封面', '活动图'],
    steps: [
      {
        type: 'text',
        label: '创意文案',
        buildData: (input) => ({
          label: '创意文案',
          prompt: input,
          content: `主题：${input}\n卖点：\n风格：\n品牌语气：`,
        }),
      },
      {
        type: 'image',
        label: '视觉参考',
        buildData: (input) => ({
          label: '视觉参考',
          prompt: `${input}，输出情绪板、配色方向与构图参考`,
          provider: 'fal',
          model: 'flux-pro',
        }),
      },
      {
        type: 'image',
        label: '成品海报',
        buildData: (input) => ({
          label: '成品海报',
          prompt: `${input}，高质量海报，画面完整，排版清晰，品牌感强`,
          provider: 'fal',
          model: 'flux-pro',
        }),
      },
    ],
  },
  {
    id: 'product',
    skillId: 'product',
    name: '电商物料流程',
    description: '从商品卖点到主图和短视频的自动化工作流。',
    keywords: ['电商', '商品', '卖点', '主图', '详情页', '短视频'],
    steps: [
      {
        type: 'text',
        label: '卖点提炼',
        buildData: (input) => ({
          label: '卖点提炼',
          prompt: input,
          content: `商品：${input}\n核心卖点：\n目标人群：\n使用场景：`,
        }),
      },
      {
        type: 'image',
        label: '商品主图',
        buildData: (input) => ({
          label: '商品主图',
          prompt: `${input}，电商主图，突出材质、卖点和购买冲动`,
          provider: 'fal',
          model: 'flux-pro',
        }),
      },
      {
        type: 'video',
        label: '产品短视频',
        buildData: (input) => ({
          label: '产品短视频',
          prompt: `${input}，产品展示短视频，镜头利落，节奏干净`,
          provider: 'fal',
          model: 'seedance-v2',
          duration: 5,
        }),
      },
    ],
  },
  {
    id: 'brand',
    skillId: 'brand',
    name: '品牌内容流程',
    description: '从品牌定位到宣传片和视觉内容的自动化工作流。',
    keywords: ['品牌', '宣传', 'vi', 'campaign', 'logo'],
    steps: [
      {
        type: 'text',
        label: '品牌策略',
        buildData: (input) => ({
          label: '品牌策略',
          prompt: input,
          content: `品牌主题：${input}\n目标受众：\n调性关键词：\n传播场景：`,
        }),
      },
      {
        type: 'script',
        label: '宣传脚本',
        buildData: (input) => ({
          label: '宣传脚本',
          prompt: `${input}，输出宣传片脚本与镜头建议`,
        }),
      },
      {
        type: 'video',
        label: '品牌宣传片',
        buildData: (input) => ({
          label: '品牌宣传片',
          prompt: `${input}，品牌宣传片，镜头流畅，质感高级`,
          provider: 'fal',
          model: 'seedance-v2',
          duration: 8,
        }),
      },
    ],
  },
  {
    id: 'story',
    skillId: 'story',
    name: '叙事短片流程',
    description: '从故事设定到分镜和预演视频的自动化工作流。',
    keywords: ['剧情', '短片', '故事', '分镜', '脚本'],
    steps: [
      {
        type: 'text',
        label: '故事设定',
        buildData: (input) => ({
          label: '故事设定',
          prompt: input,
          content: `主题：${input}\n人物：\n场景：\n情绪走向：`,
        }),
      },
      {
        type: 'storyboard',
        label: '分镜规划',
        buildData: (input) => ({
          label: '分镜规划',
          prompt: `${input}，输出镜头顺序、氛围与节奏建议`,
        }),
      },
      {
        type: 'video',
        label: '预演视频',
        buildData: (input) => ({
          label: '预演视频',
          prompt: `${input}，电影感预演视频，情绪完整，镜头明确`,
          provider: 'fal',
          model: 'seedance-v2',
          duration: 5,
        }),
      },
    ],
  },
];

function parseStorage<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function persistStorage(key: string, value: unknown) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage errors and keep the runtime usable.
  }
}

function detectIntent(input: string): IntentResult | null {
  const normalized = input.toLowerCase();
  const template = WORKFLOW_TEMPLATES.find((item) => item.keywords.some((keyword) => normalized.includes(keyword.toLowerCase())));
  if (!template) return null;
  return {
    skillId: template.skillId,
    skillName: template.name,
    confidence: 0.78,
    extractedParams: { raw: input },
    suggestedSteps: template.steps.map((step) => ({ type: step.type, label: step.label, prompt: input })),
  };
}

function buildPlan(name: string, description: string, steps: WorkflowTemplate['steps'], input: string): WorkflowPlan {
  const yBase = 200;
  return {
    id: `plan-${Date.now()}`,
    name,
    description,
    steps: steps.map((step, index) => ({
      type: step.type,
      label: step.label,
      position: {
        x: 120 + index * (NODE_WIDTH + NODE_GAP_X),
        y: yBase + (index % 2 === 0 ? 0 : NODE_GAP_Y),
      },
      data: step.buildData(input),
    })),
    connections: steps.slice(0, -1).map((_, index) => ({ from: index, to: index + 1 })),
  };
}

function cloneWorkflowPlan(plan: WorkflowPlan): WorkflowPlan {
  return JSON.parse(JSON.stringify(plan)) as WorkflowPlan;
}

function cloneRouteRecommendation(route: RouteRecommendation): RouteRecommendation {
  return {
    ...route,
    capabilities: [...route.capabilities],
  };
}

function clampValue(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getCanvasHostBounds(canvasHostRef?: RefObject<HTMLDivElement | null>) {
  const hostRect = canvasHostRef?.current?.getBoundingClientRect();
  if (hostRect) {
    return hostRect;
  }
  if (typeof window === 'undefined') {
    return {
      left: 0,
      top: 0,
      width: 1280,
      height: 720,
      right: 1280,
      bottom: 720,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  }
  return {
    left: 0,
    top: 0,
    width: window.innerWidth,
    height: window.innerHeight,
    right: window.innerWidth,
    bottom: window.innerHeight,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

function clampLauncherPosition(
  x: number,
  y: number,
  canvasHostRef?: RefObject<HTMLDivElement | null>,
  size = SMART_AGENT_LAUNCHER_SIZE,
) {
  const host = getCanvasHostBounds(canvasHostRef);
  const paddingX = 12;
  const paddingTop = 12;
  const paddingBottom = 20;
  return {
    x: clampValue(x, paddingX, Math.max(paddingX, host.width - size - paddingX)),
    y: clampValue(y, paddingTop, Math.max(paddingTop, host.height - size - paddingBottom)),
  };
}

function inferNeeds(plan: WorkflowPlan) {
  return {
    hasVideo: plan.steps.some((step) => step.type === 'video'),
    hasImage: plan.steps.some((step) => step.type === 'image'),
    hasStoryboard: plan.steps.some((step) => step.type === 'storyboard'),
    hasScript: plan.steps.some((step) => step.type === 'script' || step.type === 'text'),
  };
}

function buildRouteRecommendations(plan: WorkflowPlan, skillId: string): RouteRecommendation[] {
  const needs = inferNeeds(plan);
  const qualityRecommended = skillId === 'brand' || skillId === 'poster';
  const speedRecommended = skillId === 'product';
  return [
    {
      id: 'balanced',
      name: '平衡路线',
      providerLabel: 'OpenAI / Fal / Seedance',
      etaLabel: '约 2 - 4 分钟',
      costLabel: '成本中等',
      fitLabel: '综合推荐',
      summary: '兼顾速度、稳定性和画质，适合大多数海报、脚本与短视频任务。',
      capabilities: [
        needs.hasScript ? '脚本与文案稳定' : '规划过程稳定',
        needs.hasImage ? '图片节点默认可用' : '流程整体更轻量',
        needs.hasVideo ? '视频节点质量均衡' : '交付节奏自然',
      ],
      textProvider: 'openai',
      textModel: 'gpt-4o',
      imageProvider: 'fal',
      imageModel: 'flux-pro',
      videoProvider: 'fal',
      videoModel: 'seedance-v2',
      estimatedCost: needs.hasVideo ? 8.4 : 2.1,
      estimatedEtaSeconds: needs.hasVideo ? 210 : 95,
      recommended: !qualityRecommended && !speedRecommended,
    },
    {
      id: 'speed',
      name: '极速路线',
      providerLabel: 'DeepSeek / SiliconFlow / Wan',
      etaLabel: '约 1 - 2 分钟',
      costLabel: '成本较低',
      fitLabel: '适合快速试稿',
      summary: '优先缩短等待时间，适合电商试稿、预演和批量打样。',
      capabilities: [
        '出结果更快',
        needs.hasVideo ? '适合视频预演' : '适合多轮尝试',
        '适合先做草稿再细修',
      ],
      textProvider: 'deepseek',
      textModel: 'deepseek-chat',
      imageProvider: 'siliconflow',
      imageModel: 'Qwen/Qwen-Image',
      videoProvider: 'siliconflow',
      videoModel: 'Wan-AI/Wan2.2-I2V-A14B',
      estimatedCost: needs.hasVideo ? 4.6 : 1.2,
      estimatedEtaSeconds: needs.hasVideo ? 110 : 55,
      recommended: speedRecommended,
    },
    {
      id: 'quality',
      name: '高保真路线',
      providerLabel: 'OpenAI / Fal 高质量 / Seedance 高质量',
      etaLabel: '约 3 - 6 分钟',
      costLabel: '成本较高',
      fitLabel: '适合正式交付',
      summary: '优先保证画面一致性和观感，适合品牌主视觉、海报和宣传片。',
      capabilities: [
        '适合品牌一致性',
        needs.hasImage ? '海报与主视觉质量更稳' : '故事表达更完整',
        needs.hasVideo ? '更适合正式宣传视频' : '更适合交付前精修',
      ],
      textProvider: 'openai',
      textModel: 'gpt-4.1',
      imageProvider: 'fal',
      imageModel: 'flux-pro',
      videoProvider: 'fal',
      videoModel: 'seedance-v2',
      estimatedCost: needs.hasVideo ? 11.8 : 3.4,
      estimatedEtaSeconds: needs.hasVideo ? 320 : 150,
      recommended: qualityRecommended,
    },
  ];
}

function applyRouteToPlan(plan: WorkflowPlan, route: RouteRecommendation): WorkflowPlan {
  return {
    ...plan,
    steps: plan.steps.map((step) => {
      const data = { ...(step.data || {}) };
      if (step.type === 'text' || step.type === 'script' || step.type === 'storyboard') {
        return {
          ...step,
          data: {
            ...data,
            provider: route.textProvider,
            model: route.textModel,
            routeName: route.name,
            routeId: route.id,
          },
        };
      }
      if (step.type === 'image') {
        return {
          ...step,
          data: {
            ...data,
            provider: route.imageProvider,
            model: route.imageModel,
            routeName: route.name,
            routeId: route.id,
          },
        };
      }
      if (step.type === 'video') {
        return {
          ...step,
          data: {
            ...data,
            provider: route.videoProvider,
            model: route.videoModel,
            routeName: route.name,
            routeId: route.id,
          },
        };
      }
      return step;
    }),
  };
}

function estimateStepCost(stepType: NodeType, route: RouteRecommendation) {
  if (stepType === 'video') return route.id === 'quality' ? 8.8 : route.id === 'speed' ? 3.6 : 6.2;
  if (stepType === 'image') return route.id === 'quality' ? 1.4 : route.id === 'speed' ? 0.55 : 0.9;
  if (stepType === 'text' || stepType === 'script' || stepType === 'storyboard') return route.id === 'speed' ? 0.12 : 0.25;
  return 0;
}

function estimateStepEtaSeconds(stepType: NodeType, route: RouteRecommendation) {
  if (stepType === 'video') return route.id === 'quality' ? 145 : route.id === 'speed' ? 55 : 95;
  if (stepType === 'image') return route.id === 'quality' ? 32 : route.id === 'speed' ? 12 : 22;
  if (stepType === 'text' || stepType === 'script' || stepType === 'storyboard') return route.id === 'speed' ? 8 : 14;
  return 10;
}

function describeExecutionStep(steps: WorkflowStepState[], status: ExecutionState['status'], pendingCheckpoint?: CheckpointStage | null) {
  if (status === 'awaiting-approval' && pendingCheckpoint === 'plan') return '等待人工确认：计划完成';
  if (status === 'awaiting-approval' && pendingCheckpoint === 'execute') return '等待人工确认：准备执行';
  if (status === 'awaiting-approval' && pendingCheckpoint === 'deliver') return '等待人工确认：准备交付';
  const running = steps.find((step) => step.status === 'running');
  if (running) return `当前步骤：${running.label}`;
  const pending = steps.find((step) => step.status === 'pending');
  if (pending) return `下一步：${pending.label}`;
  const failed = steps.find((step) => step.status === 'error');
  if (failed) return `失败步骤：${failed.label}`;
  const lastDone = [...steps].reverse().find((step) => step.status === 'done');
  if (lastDone) return `已完成：${lastDone.label}`;
  return '等待新的工作流指令';
}

function buildExecutionArtifacts(plan: WorkflowPlan, statuses: WorkflowStepState[], route: RouteRecommendation, nodeIds: string[] = []): ExecutionArtifact[] {
  return plan.steps.map((step, index) => {
    const stepStatus = statuses[index]?.status || 'pending';
    const provider = String((step.data as Record<string, unknown>)?.provider || (
      step.type === 'image' ? route.imageProvider : step.type === 'video' ? route.videoProvider : route.textProvider
    ));
    const model = String((step.data as Record<string, unknown>)?.model || (
      step.type === 'image' ? route.imageModel : step.type === 'video' ? route.videoModel : route.textModel
    ));
    return {
      id: `${plan.id}-artifact-${index}`,
      title: step.label,
      detail: stepStatus === 'done'
        ? `已生成 ${step.type} 节点${nodeIds[index] ? ` · ${nodeIds[index]}` : ''}`
        : stepStatus === 'running'
          ? '正在生成节点'
          : stepStatus === 'error'
            ? '生成失败，等待重试'
            : `待生成 ${step.type} 节点`,
      status: stepStatus === 'done' ? 'ready' : stepStatus === 'error' ? 'error' : 'pending',
      nodeId: nodeIds[index],
      sourceStep: step.label,
      provider,
      model,
      etaSeconds: estimateStepEtaSeconds(step.type, route),
      estimatedCost: estimateStepCost(step.type, route),
      version: `${route.id}-v${index + 1}`,
    };
  });
}

function formatRelativeTime(timestamp: number) {
  const deltaMinutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
  if (deltaMinutes < 1) return '刚刚';
  if (deltaMinutes < 60) return `${deltaMinutes} 分钟前`;
  const hours = Math.round(deltaMinutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  return `${days} 天前`;
}

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
  const [selectedRouteId, setSelectedRouteId] = useState<RouteRecommendation['id']>('balanced');
  const [pendingRun, setPendingRun] = useState<PendingRun | null>(null);
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
    const host = getCanvasHostBounds(canvasHostRef);
    setPosition(clampLauncherPosition(
      host.width - SMART_AGENT_LAUNCHER_SIZE - 24,
      host.height - SMART_AGENT_LAUNCHER_SIZE - 96,
      canvasHostRef,
    ));
  }, [canvasHostRef]);

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
      const host = getCanvasHostBounds(canvasHostRef);
      setPosition((current) => clampLauncherPosition(current.x, current.y, canvasHostRef));
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
  }, [canvasHostRef]);

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
    const host = getCanvasHostBounds(canvasHostRef);
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
  }, [canvasHostRef, isMobile, panelSize.height, panelSize.width, position.x, position.y]);

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
      setPosition(clampLauncherPosition(dragRef.current.initX + dx, dragRef.current.initY + dy, canvasHostRef));
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
  }, [canvasHostRef]);

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
    rememberRun(finishedTrace);
    setExecutionState({
      status: 'completed',
      currentStep: describeExecutionStep(completedSteps, 'completed'),
      summary: `已完成《${run.plan.name}》，结果已交付并写入长期记忆。`,
      steps: completedSteps,
      artifacts: nextArtifacts,
      updatedAt: Date.now(),
    });
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
    rememberRun(nextTrace);
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

  const handleSend = useCallback(async () => {
    const userInput = input.trim();
    if (!userInput || isLoading) return;

    setMessages((prev) => [...prev, { id: `user-${Date.now()}`, role: 'user', content: userInput, timestamp: Date.now() }]);
    setInput('');
    setIsLoading(true);

    try {
      let detectedIntent: IntentResult | null = null;
      let plan: WorkflowPlan | null = null;
      let detectorLabel = '本地模板';

      try {
        const agentService = await import('@/services/agentService');
        const agentConfig = agentService.getAgentConfig();
        const remoteIntent = await agentService.detectIntent(userInput, agentConfig);
        if (remoteIntent?.suggestedSteps?.length) {
          detectedIntent = remoteIntent;
          plan = agentService.intentToWorkflowPlan(remoteIntent);
          detectorLabel = '智能规划';
        }
      } catch {
        // Fallback to local planning to keep the panel responsive.
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
          content: `${detectorLabel}已识别：${detectedIntent.skillName}（置信度 ${Math.round(detectedIntent.confidence * 100)}%）`,
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
                    <div className="flex items-end gap-2 rounded-xl border border-[#3a3a3c] bg-[#2a2a2c] px-3 py-2 transition-colors focus-within:border-[#00d4aa]">
                      <textarea
                        value={input}
                        onChange={(event) => setInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && !event.shiftKey) {
                            event.preventDefault();
                            void handleSend();
                          }
                        }}
                        placeholder="描述你想创建的内容，例如：做一张品牌海报，并在执行前让我确认路线和交付。"
                        rows={1}
                        aria-label="输入工作流需求"
                        className="max-h-[96px] flex-1 resize-none bg-transparent text-xs text-[#e6edf3] outline-none placeholder:text-[#5a5a5c]"
                      />
                      <button
                        type="button"
                        onClick={() => void handleSend()}
                        disabled={!input.trim() || isLoading}
                        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors ${
                          input.trim() && !isLoading ? 'bg-[#00d4aa] text-[#0d1117] hover:bg-[#00e5b3]' : 'bg-[#21262d] text-[#6e7681]'
                        }`}
                        title="发送"
                      >
                        <Send className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <p className="mt-1 text-center text-[10px] text-[#5a5a5c]">Shift+Enter 换行，Enter 发送</p>
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
