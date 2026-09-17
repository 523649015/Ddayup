// Shared types, constants and pure helpers extracted from SmartAgent.tsx.
// Moved verbatim — no behavior change.
import type { RefObject } from 'react';
import { Bot, GitBranch, Sparkles, type LucideIcon } from 'lucide-react';
import type { IntentResult } from '@/services/agentService';
import {
  defaultRequirementsForTask,
  resolveModelForTask,
  withReferenceRequirements,
  type ModelCandidate,
  type ModelResolution,
} from '@/services/modelFallback';
import type { WorkflowPlan } from '@/store/useCanvasStore';
import type { NodeType } from '@/types';

export type WorkflowStepState = {
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  workflowStatus?: 'planning' | 'awaiting-approval' | 'creating' | 'completed' | 'failed' | 'paused';
  workflowSteps?: WorkflowStepState[];
};

export type AgentModel = {
  id: string;
  name: string;
  desc: string;
  icon: LucideIcon;
  color: string;
};

export type AgentSkill = {
  id: string;
  name: string;
  desc: string;
};

export type WorkflowTemplate = {
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

export type CheckpointStage = 'plan' | 'execute' | 'deliver';

export type ExecutionArtifact = {
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
  /** 该步骤是否因免费模型不支持任务而自动切换到付费模型 */
  autoSwitched?: boolean;
  /** 模型选择/回退的可读原因（含免费优先与回退说明） */
  fallbackReason?: string;
};

export type ExecutionState = {
  status: 'idle' | 'planning' | 'awaiting-approval' | 'creating' | 'completed' | 'failed' | 'paused';
  currentStep: string;
  summary: string;
  steps: WorkflowStepState[];
  artifacts: ExecutionArtifact[];
  updatedAt: number;
};

export type AgentTraceEvent = {
  id: string;
  kind: 'router' | 'checkpoint' | 'plan' | 'step' | 'artifact' | 'deliver' | 'memory' | 'rollback' | 'replay' | 'error';
  label: string;
  detail: string;
  status: 'info' | 'running' | 'done' | 'warning' | 'error';
  at: number;
};

export type AgentTraceRun = {
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

export type RouteRecommendation = {
  id: 'free' | 'balanced' | 'speed' | 'quality';
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

export type PendingRun = {
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

export const NODE_WIDTH = 380;
export const NODE_GAP_X = 120;
export const NODE_GAP_Y = 60;
export const SMART_AGENT_LAUNCHER_SIZE = 36;
export const TRACE_STORAGE_KEY = 'hmdao-smart-agent-traces';
export const MAX_TRACE_RUNS = 8;

export const MODELS: AgentModel[] = [
  { id: 'workflow', name: 'Workflow', desc: '适合工作流规划、批量节点编排和自动执行。', icon: Sparkles, color: '#00d4aa' },
  { id: 'vision', name: 'Vision', desc: '适合理解图片、视频与参考素材之间的关系。', icon: Bot, color: '#1a8cff' },
  { id: 'planning', name: 'Planner', desc: '适合复杂多阶段执行、检查点和人工确认。', icon: GitBranch, color: '#f59e0b' },
];

export const SKILLS: AgentSkill[] = [
  { id: 'poster', name: '海报创作', desc: '海报、KV、活动主视觉' },
  { id: 'product', name: '电商物料', desc: '商品图、卖点图、短视频' },
  { id: 'brand', name: '品牌内容', desc: '品牌视觉、脚本、宣传片' },
  { id: 'story', name: '叙事短片', desc: '故事设定、分镜与预演视频' },
];

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
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

export function parseStorage<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function persistStorage(key: string, value: unknown) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage errors and keep the runtime usable.
  }
}

// SSE 事件块解析（用于后端流式智能体 /api/agent/chat）
export function parseSseBlock(raw: string): { event: string; data: any } | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  try { return { event, data: JSON.parse(dataLines.join('\n')) }; } catch { return null; }
}

export function detectIntent(input: string): IntentResult | null {
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

export function buildPlan(name: string, description: string, steps: WorkflowTemplate['steps'], input: string): WorkflowPlan {
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

export function cloneWorkflowPlan(plan: WorkflowPlan): WorkflowPlan {
  return JSON.parse(JSON.stringify(plan)) as WorkflowPlan;
}

export function cloneRouteRecommendation(route: RouteRecommendation): RouteRecommendation {
  return {
    ...route,
    capabilities: [...route.capabilities],
  };
}

export function clampValue(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 画布宿主可用区域。
 *
 * @param reservedRight 右侧被常驻面板（如 docked AI 面板）占用的宽度。
 *   传入后返回的 width / right 会相应收窄，使依赖它的钳制逻辑自动避让，
 *   不必在每处调用点重复减一次。
 */
export function getCanvasHostBounds(canvasHostRef?: RefObject<HTMLDivElement | null>, reservedRight = 0) {
  const hostRect = canvasHostRef?.current?.getBoundingClientRect();
  const base = hostRect || (typeof window === 'undefined'
    ? { left: 0, top: 0, width: 1280, height: 720, bottom: 720 }
    : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight, bottom: window.innerHeight });

  const minWidth = 160;
  // 内缩不能超过可用宽度，否则宿主被挤没，钳制结果会变成负坐标。
  const inset = Math.max(0, Math.min(reservedRight, Math.max(0, base.width - minWidth)));
  const width = Math.max(minWidth, base.width - inset);

  return {
    left: base.left,
    top: base.top,
    width,
    height: base.height,
    right: base.left + width,
    bottom: base.bottom,
    x: base.left,
    y: base.top,
    toJSON: () => ({}),
  } as DOMRect;
}

export function clampLauncherPosition(
  x: number,
  y: number,
  canvasHostRef?: RefObject<HTMLDivElement | null>,
  size = SMART_AGENT_LAUNCHER_SIZE,
  reservedRight = 0,
) {
  const host = getCanvasHostBounds(canvasHostRef, reservedRight);
  const paddingX = 12;
  const paddingTop = 12;
  const paddingBottom = 20;
  return {
    x: clampValue(x, paddingX, Math.max(paddingX, host.width - size - paddingX)),
    y: clampValue(y, paddingTop, Math.max(paddingTop, host.height - size - paddingBottom)),
  };
}

export function inferNeeds(plan: WorkflowPlan) {
  return {
    hasVideo: plan.steps.some((step) => step.type === 'video'),
    hasImage: plan.steps.some((step) => step.type === 'image'),
    hasStoryboard: plan.steps.some((step) => step.type === 'storyboard'),
    hasScript: plan.steps.some((step) => step.type === 'script' || step.type === 'text'),
  };
}

/** 步骤是否携带参考图输入（影响能力要求：需 imageToImage 而非 textToImage） */
export function stepHasReferenceInput(step: WorkflowPlan['steps'][number]): boolean {
  const data = step.data as { referenceInputs?: unknown[]; inputs?: Array<{ channel?: string }> } | undefined;
  if (Array.isArray(data?.referenceInputs) && data.referenceInputs.length > 0) return true;
  if (Array.isArray(data?.inputs) && data.inputs.some((i) => i?.channel === 'reference')) return true;
  return false;
}

/**
 * 为单个步骤解析「免费优先 + 能力满足 + 按优先级」的模型。
 * 若免费模型不满足任务能力要求（如带参考图但免费模型只支持文生图），
 * 自动切换到下一个有能力的付费模型，并返回可读原因。
 */
export function resolveStepModel(step: WorkflowPlan['steps'][number]): ModelResolution | null {
  const base = defaultRequirementsForTask(step.type);
  const requirements = stepHasReferenceInput(step) ? withReferenceRequirements(base) : base;
  return resolveModelForTask(step.type, { preferFree: true, requirements });
}

export function buildRouteRecommendations(plan: WorkflowPlan, skillId: string): RouteRecommendation[] {
  const needs = inferNeeds(plan);
  const qualityRecommended = skillId === 'brand' || skillId === 'poster';
  const speedRecommended = skillId === 'product';

  // 免费优先路线：文本/图片/视频均解析为「免费能力优先、不行则按优先级切换」的模型
  const textRes = resolveModelForTask('text', { preferFree: true });
  const imageRes = resolveModelForTask('image', { preferFree: true });
  const videoRes = resolveModelForTask('video', { preferFree: true });
  const freeRoute: RouteRecommendation = {
    id: 'free',
    name: '免费优先路线',
    providerLabel: '免费额度模型 · 自动回退',
    etaLabel: '约 1 - 4 分钟',
    costLabel: '成本最低',
    fitLabel: '免费额度优先',
    summary: '优先使用免费额度模型，若免费模型不支持当前任务（如参考图/换主体），自动按优先级切换到能支持的模型。',
    capabilities: [
      textRes?.isFree ? '文本：免费模型' : '文本：已回退到付费模型',
      imageRes?.isFree ? '图片：免费模型' : '图片：已回退到付费模型',
      videoRes?.isFree ? '视频：免费模型' : '视频：已回退到付费模型',
    ],
    textProvider: textRes?.provider || 'openai',
    textModel: textRes?.model || 'qwen3.7-flash',
    imageProvider: imageRes?.provider || 'fal',
    imageModel: imageRes?.model || 'flux-pro',
    videoProvider: videoRes?.provider || 'fal',
    videoModel: videoRes?.model || 'seedance-v2',
    estimatedCost: 0,
    estimatedEtaSeconds: needs.hasVideo ? 150 : 70,
    recommended: !qualityRecommended && !speedRecommended,
  };

  return [freeRoute,
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
      textModel: 'qwen3.7-flash',
      imageProvider: 'fal',
      imageModel: 'flux-pro',
      videoProvider: 'fal',
      videoModel: 'seedance-v2',
      estimatedCost: needs.hasVideo ? 8.4 : 2.1,
      estimatedEtaSeconds: needs.hasVideo ? 210 : 95,
      recommended: false,
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

export function applyRouteToPlan(plan: WorkflowPlan, route: RouteRecommendation): WorkflowPlan {
  return {
    ...plan,
    steps: plan.steps.map((step) => {
      const data = { ...(step.data || {}) } as Record<string, unknown>;
      // 该步骤「免费优先 + 能力感知」的解析（含按优先级回退链），供运行期回退消费
      const res = resolveStepModel(step);
      const fallbackChain: Array<{ provider: string; model: string; isFree: boolean }> =
        res?.fallbackChain.map((c: ModelCandidate) => ({ provider: c.provider, model: c.model, isFree: c.isFree })) ?? [];

      // 免费路线：直接使用解析出的免费优先模型（不满足能力则已自动切换到付费）
      const isFreeRoute = route.id === 'free';
      const textProvider = isFreeRoute && res && (step.type === 'text' || step.type === 'script' || step.type === 'storyboard') ? res.provider : route.textProvider;
      const textModel = isFreeRoute && res && (step.type === 'text' || step.type === 'script' || step.type === 'storyboard') ? res.model : route.textModel;
      const imageProvider = isFreeRoute && res && step.type === 'image' ? res.provider : route.imageProvider;
      const imageModel = isFreeRoute && res && step.type === 'image' ? res.model : route.imageModel;
      const videoProvider = isFreeRoute && res && step.type === 'video' ? res.provider : route.videoProvider;
      const videoModel = isFreeRoute && res && step.type === 'video' ? res.model : route.videoModel;

      if (step.type === 'text' || step.type === 'script' || step.type === 'storyboard') {
        return {
          ...step,
          data: {
            ...data,
            provider: textProvider,
            model: textModel,
            routeName: route.name,
            routeId: route.id,
            modelFallbackChain: isFreeRoute ? fallbackChain : undefined,
            modelFallbackReason: isFreeRoute ? (res?.reason ?? '') : '',
            autoSwitchedModel: isFreeRoute ? (res?.autoSwitched ?? false) : undefined,

          },
        };
      }
      if (step.type === 'image') {
        return {
          ...step,
          data: {
            ...data,
            provider: imageProvider,
            model: imageModel,
            routeName: route.name,
            routeId: route.id,
            modelFallbackChain: isFreeRoute ? fallbackChain : undefined,
            modelFallbackReason: isFreeRoute ? (res?.reason ?? '') : '',
            autoSwitchedModel: isFreeRoute ? (res?.autoSwitched ?? false) : undefined,

          },
        };
      }
      if (step.type === 'video') {
        return {
          ...step,
          data: {
            ...data,
            provider: videoProvider,
            model: videoModel,
            routeName: route.name,
            routeId: route.id,
            modelFallbackChain: isFreeRoute ? fallbackChain : undefined,
            modelFallbackReason: isFreeRoute ? (res?.reason ?? '') : '',
            autoSwitchedModel: isFreeRoute ? (res?.autoSwitched ?? false) : undefined,

          },
        };
      }
      return step;
    }),
  };
}

export function estimateStepCost(stepType: NodeType, route: RouteRecommendation) {
  if (stepType === 'video') return route.id === 'quality' ? 8.8 : route.id === 'speed' ? 3.6 : 6.2;
  if (stepType === 'image') return route.id === 'quality' ? 1.4 : route.id === 'speed' ? 0.55 : 0.9;
  if (stepType === 'text' || stepType === 'script' || stepType === 'storyboard') return route.id === 'speed' ? 0.12 : 0.25;
  return 0;
}

export function estimateStepEtaSeconds(stepType: NodeType, route: RouteRecommendation) {
  if (stepType === 'video') return route.id === 'quality' ? 145 : route.id === 'speed' ? 55 : 95;
  if (stepType === 'image') return route.id === 'quality' ? 32 : route.id === 'speed' ? 12 : 22;
  if (stepType === 'text' || stepType === 'script' || stepType === 'storyboard') return route.id === 'speed' ? 8 : 14;
  return 10;
}

export function describeExecutionStep(steps: WorkflowStepState[], status: ExecutionState['status'], pendingCheckpoint?: CheckpointStage | null) {
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

export function buildExecutionArtifacts(plan: WorkflowPlan, statuses: WorkflowStepState[], route: RouteRecommendation, nodeIds: string[] = []): ExecutionArtifact[] {
  return plan.steps.map((step, index) => {
    const stepStatus = statuses[index]?.status || 'pending';
    const provider = String((step.data as Record<string, unknown>)?.provider || (
      step.type === 'image' ? route.imageProvider : step.type === 'video' ? route.videoProvider : route.textProvider
    ));
    const model = String((step.data as Record<string, unknown>)?.model || (
      step.type === 'image' ? route.imageModel : step.type === 'video' ? route.videoModel : route.textModel
    ));
    const autoSwitched = Boolean((step.data as Record<string, unknown>)?.autoSwitchedModel);
    const fallbackReason = String((step.data as Record<string, unknown>)?.modelFallbackReason || '');
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
      autoSwitched,
      fallbackReason,
    };
  });
}

export function formatRelativeTime(timestamp: number) {
  const deltaMinutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
  if (deltaMinutes < 1) return '刚刚';
  if (deltaMinutes < 60) return `${deltaMinutes} 分钟前`;
  const hours = Math.round(deltaMinutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  return `${days} 天前`;
}

