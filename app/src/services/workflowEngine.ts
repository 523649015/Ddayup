/**
 * HMDao ComfyUI 工作流引擎 — 解析 + 调度 + 执行追踪
 *
 * 核心能力：
 * 1. ComfyUI JSON → HMDao WorkflowPlan 双向转换
 * 2. 拓扑排序依赖解析 — 上游节点完成后才触发下游
 * 3. 并行执行 — 无依赖节点并发运行
 * 4. 进度追踪 + 实时推送（集成 realtime.ts WSManager）
 * 5. 错误隔离 — 单节点失败不阻塞无依赖的兄弟节点
 *
 * 架构：
 * - WorkflowEngine 类：有状态执行引擎，管理一次工作流运行的生命周期
 * - 每个节点执行通过 NodeExecutor 接口抽象，支持不同 Provider
 * - 集成 serviceErrorBoundary 熔断器
 */

import { wrapService, type ServiceResult } from '@/services/serviceErrorBoundary';
import { classifyError, logError } from '@/engine/safe-fetch';
import type { WorkflowPlan, WorkflowStep } from '@/store/useCanvasStore';
import type { NodeType, NodeData } from '@/types';

// ===== 类型定义 =====

/** 节点执行状态 */
export type NodeExecStatus = 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'skipped';

/** 单个节点的执行结果 */
export interface NodeExecResult {
  nodeId: string;
  stepIndex: number;
  status: NodeExecStatus;
  outputs?: Array<{ type: string; url: string; metadata?: Record<string, unknown> }>;
  error?: string;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
}

/** 工作流执行状态 */
export type WorkflowExecStatus = 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

/** 工作流执行结果 */
export interface WorkflowExecResult {
  planId: string;
  status: WorkflowExecStatus;
  nodeResults: Map<number, NodeExecResult>;  // stepIndex → result
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  startedAt: number;
  completedAt?: number;
  totalDurationMs?: number;
}

/** 进度回调 */
export type WorkflowProgressCallback = (result: WorkflowExecResult) => void;

/** 节点执行器接口 — 由各 Provider 实现 */
export interface NodeExecutor {
  /** 执行器名称 */
  name: string;
  /** 支持的节点类型 */
  supportedTypes: NodeType[];
  /** 执行单个节点 */
  execute: (nodeId: string, step: WorkflowStep, signal: AbortSignal) => Promise<NodeExecResult>;
}

/** 引擎配置 */
export interface WorkflowEngineConfig {
  /** 最大并行节点数 */
  maxParallel?: number;
  /** 单节点超时 (ms) */
  nodeTimeout?: number;
  /** 失败策略: 'stop' 停止全部 | 'continue' 继续无依赖节点 */
  failureStrategy?: 'stop' | 'continue';
  /** 进度回调 */
  onProgress?: WorkflowProgressCallback;
  /** 节点状态变更回调 */
  onNodeStatusChange?: (stepIndex: number, status: NodeExecStatus, result?: NodeExecResult) => void;
}

// ===== 默认配置 =====

const DEFAULT_CONFIG: Required<WorkflowEngineConfig> = {
  maxParallel: 3,
  nodeTimeout: 300000,  // 5 分钟
  failureStrategy: 'continue',
  onProgress: () => {},
  onNodeStatusChange: () => {},
};

// ===== ComfyUI JSON 类型 =====

interface ComfyUIWorkflow {
  last_node_id: number;
  last_link_id: number;
  nodes: Array<{
    id: number;
    type: string;
    pos: [number, number];
    size: { 0: number; 1: number };
    flags: Record<string, unknown>;
    order: number;
    mode: number;
    inputs?: Array<{ name: string; type: string; link: number | null }>;
    outputs?: Array<{ name: string; type: string; links: number[] | null }>;
    properties?: Record<string, unknown>;
    widgets_values?: unknown[];
  }>;
  links: Array<[number, number, number, number, number, string]>;
  groups: unknown[];
  config: Record<string, unknown>;
  extra: Record<string, unknown>;
}

// ===== ComfyUI 节点类型 → HMDao NodeType 映射 =====

const COMFY_TO_HMDAO_TYPE: Record<string, NodeType> = {
  // 加载节点 → 输入源
  'LoadImage': 'image',
  'LoadVideo': 'video',
  'LoadAudio': 'audio',
  'VHS_LoadVideo': 'video',
  // 生成节点
  'KSampler': 'image',
  'KSamplerAdvanced': 'image',
  'EmptyLatentImage': 'image',
  // 提示词
  'CLIPTextEncode': 'text',
  'CLIPTextEncodeSDXL': 'text',
  // 输出
  'SaveImage': 'image',
  'VHS_VideoCombine': 'video',
  'SaveAudio': 'audio',
  // 控制
  'ControlNetApply': 'image',
  'ControlNetApplyAdvanced': 'image',
  // 放大
  'UpscaleImage': 'image',
  'ImageScale': 'image',
  'UltimateSDUpscale': 'image',
  // 视频
  'VHS_VideoCombine': 'video',
  'FrameInterpolator': 'video',
};

/**
 * 将 ComfyUI 节点类型映射到 HMDao NodeType
 */
function mapComfyTypeToHMDao(comfyType: string): NodeType {
  // 精确匹配
  if (COMFY_TO_HMDAO_TYPE[comfyType]) {
    return COMFY_TO_HMDAO_TYPE[comfyType];
  }
  // 模糊匹配
  if (comfyType.includes('Load') || comfyType.includes('Input')) return 'image';
  if (comfyType.includes('Sampler') || comfyType.includes('Generate')) return 'image';
  if (comfyType.includes('Text') || comfyType.includes('CLIP') || comfyType.includes('Prompt')) return 'text';
  if (comfyType.includes('Video') || comfyType.includes('VHS')) return 'video';
  if (comfyType.includes('Audio') || comfyType.includes('Speech')) return 'audio';
  if (comfyType.includes('Save') || comfyType.includes('Output') || comfyType.includes('Preview')) return 'image';
  // 默认
  return 'image';
}

// ===== ComfyUI JSON 解析 =====

/**
 * 解析 ComfyUI workflow JSON → HMDao WorkflowPlan
 *
 * ComfyUI JSON 格式：
 * - nodes: 节点数组，每个节点有 id, type, pos, widgets_values
 * - links: 连接数组 [linkId, fromNode, fromSlot, toNode, toSlot, type]
 */
export function parseComfyUIWorkflow(comfyJson: string): { plan: WorkflowPlan; warnings: string[] } {
  const warnings: string[] = [];

  let raw: ComfyUIWorkflow;
  try {
    raw = JSON.parse(comfyJson);
  } catch {
    throw new Error('ComfyUI JSON 解析失败：格式无效');
  }

  if (!raw.nodes || !Array.isArray(raw.nodes)) {
    throw new Error('ComfyUI JSON 格式错误：缺少 nodes 数组');
  }

  // 构建 id→index 映射
  const idToIndex = new Map<number, number>();
  raw.nodes.forEach((node, i) => idToIndex.set(node.id, i));

  // 转换节点
  const steps: WorkflowStep[] = raw.nodes.map((node, i) => {
    const hmdaoType = mapComfyTypeToHMDao(node.type);
    const prompt = extractPromptFromComfyNode(node);

    return {
      type: hmdaoType,
      label: `${node.type} (ID:${node.id})`,
      position: {
        x: (node.pos?.[0] || 0) * 0.5 + 100,  // ComfyUI 坐标缩放
        y: (node.pos?.[1] || 0) * 0.5 + 100,
      },
      data: {
        label: `${node.type} (ID:${node.id})`,
        prompt: prompt || undefined,
        provider: hmdaoType === 'video' ? 'fal' : hmdaoType === 'audio' ? 'minimax' : 'fal',
        model: hmdaoType === 'video' ? 'seedance-v2' : hmdaoType === 'audio' ? 'speech-2.8-turbo' : 'flux-pro',
        status: 'idle' as const,
        params: { comfyNodeType: node.type, comfyNodeId: node.id, widgetsValues: node.widgets_values },
      } as Partial<NodeData>,
    };
  });

  // 转换连接
  const connections: { from: number; to: number }[] = [];
  if (raw.links && Array.isArray(raw.links)) {
    for (const link of raw.links) {
      // link 格式: [linkId, fromNodeId, fromSlot, toNodeId, toSlot, type]
      const fromNodeId = link[1];
      const toNodeId = link[3];
      const fromIndex = idToIndex.get(fromNodeId);
      const toIndex = idToIndex.get(toNodeId);

      if (fromIndex !== undefined && toIndex !== undefined) {
        connections.push({ from: fromIndex, to: toIndex });
      } else {
        warnings.push(`连接 ${link[0]}: 节点 ${fromNodeId}→${toNodeId} 无法映射`);
      }
    }
  }

  const plan: WorkflowPlan = {
    id: `comfy-${Date.now()}`,
    name: `ComfyUI 导入 - ${new Date().toLocaleString('zh-CN')}`,
    description: `从 ComfyUI 导入的工作流，包含 ${steps.length} 个节点`,
    steps,
    connections,
  };

  return { plan, warnings };
}

/**
 * 从 ComfyUI 节点提取 prompt 文本
 */
function extractPromptFromComfyNode(node: ComfyUIWorkflow['nodes'][0]): string | null {
  // CLIPTextEncode 节点的 widgets_values[0] 通常是 prompt
  if ((node.type === 'CLIPTextEncode' || node.type === 'CLIPTextEncodeSDXL') && node.widgets_values?.[0]) {
    return String(node.widgets_values[0]);
  }
  // 其他节点的 title/properties
  if (node.properties?.['Node name for S&R']) {
    return String(node.properties['Node name for S&R']);
  }
  return null;
}

/**
 * 将 HMDao WorkflowPlan 导出为 ComfyUI JSON 格式
 */
export function exportToComfyUIWorkflow(plan: WorkflowPlan): string {
  const nodes: ComfyUIWorkflow['nodes'] = plan.steps.map((step, i) => ({
    id: i + 1,
    type: (step.data?.params?.comfyNodeType as string) || mapHMDaoTypeToComfy(step.type),
    pos: [step.position.x * 2, step.position.y * 2],
    size: { 0: 200, 1: 100 },
    flags: {},
    order: i,
    mode: 0,
    widgets_values: step.data?.prompt ? [step.data.prompt] : [],
    properties: { 'Node name for S&R': step.label },
  }));

  const links: ComfyUIWorkflow['links'] = plan.connections.map((conn, i) => [
    i + 1,
    conn.from + 1,
    0,
    conn.to + 1,
    0,
    'basic',
  ]);

  const comfyWorkflow: ComfyUIWorkflow = {
    last_node_id: nodes.length,
    last_link_id: links.length,
    nodes,
    links,
    groups: [],
    config: {},
    extra: { exportedFrom: 'HMDao', exportedAt: new Date().toISOString() },
  };

  return JSON.stringify(comfyWorkflow, null, 2);
}

/** HMDao → ComfyUI 反向映射 */
function mapHMDaoTypeToComfy(type: NodeType): string {
  const map: Record<NodeType, string> = {
    text: 'CLIPTextEncode',
    image: 'KSampler',
    video: 'VHS_VideoCombine',
    audio: 'SaveAudio',
    post: 'KSampler',
    script: 'CLIPTextEncode',
    storyboard: 'CLIPTextEncode',
    aiapp: 'KSampler',
    threed: 'KSampler',
    dcc: 'LoadImage',
    region: 'CLIPTextEncode',
  };
  return map[type] || 'KSampler';
}

// ===== 拓扑排序 =====

/**
 * 对工作流步骤进行拓扑排序，返回按依赖顺序排列的层级
 * 同一层级的节点无相互依赖，可并行执行
 */
export function topologicalSort(plan: WorkflowPlan): number[][] {
  const n = plan.steps.length;

  // 构建邻接表和入度
  const adj: number[][] = Array.from({ length: n }, () => []);
  const inDegree: number[] = Array.from({ length: n }, () => 0);

  for (const conn of plan.connections) {
    if (conn.from >= 0 && conn.from < n && conn.to >= 0 && conn.to < n) {
      adj[conn.from].push(conn.to);
      inDegree[conn.to]++;
    }
  }

  // Kahn 算法分层
  const levels: number[][] = [];
  const queue: number[] = [];

  // 第一层：入度为 0 的节点
  for (let i = 0; i < n; i++) {
    if (inDegree[i] === 0) queue.push(i);
  }

  while (queue.length > 0) {
    const levelSize = queue.length;
    const currentLevel: number[] = [];

    for (let i = 0; i < levelSize; i++) {
      const node = queue.shift()!;
      currentLevel.push(node);

      for (const neighbor of adj[node]) {
        inDegree[neighbor]--;
        if (inDegree[neighbor] === 0) {
          queue.push(neighbor);
        }
      }
    }

    levels.push(currentLevel);
  }

  // 检测环 — 如果有节点未被访问
  const visited = new Set(levels.flat());
  if (visited.size < n) {
    const unvisited: number[] = [];
    for (let i = 0; i < n; i++) {
      if (!visited.has(i)) unvisited.push(i);
    }
    // 将未访问节点追加到最后（打破环）
    levels.push(unvisited);
  }

  return levels;
}

// ===== 工作流执行引擎 =====

/**
 * WorkflowEngine — 有状态的工作流执行引擎
 *
 * 使用方式：
 * ```typescript
 * const engine = new WorkflowEngine(plan, executors, config);
 * const result = await engine.run();
 * ```
 */
export class WorkflowEngine {
  private plan: WorkflowPlan;
  private executors: NodeExecutor[];
  private config: Required<WorkflowEngineConfig>;
  private abortController: AbortController;
  private result: WorkflowExecResult;
  private runningCount = 0;

  constructor(
    plan: WorkflowPlan,
    executors: NodeExecutor[],
    config?: WorkflowEngineConfig,
  ) {
    this.plan = plan;
    this.executors = executors;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.abortController = new AbortController();
    this.result = {
      planId: plan.id,
      status: 'idle',
      nodeResults: new Map(),
      totalSteps: plan.steps.length,
      completedSteps: 0,
      failedSteps: 0,
      startedAt: 0,
    };
  }

  /**
   * 执行工作流
   */
  async run(): Promise<WorkflowExecResult> {
    this.result.status = 'running';
    this.result.startedAt = Date.now();
    this.config.onProgress(this.result);

    try {
      const levels = topologicalSort(this.plan);

      for (const level of levels) {
        if (this.abortController.signal.aborted) break;

        // 同一层级并行执行，受 maxParallel 限制
        await this.executeLevel(level);

        // 检查是否需要停止
        if (this.config.failureStrategy === 'stop' && this.result.failedSteps > 0) {
          this.result.status = 'failed';
          break;
        }
      }

      if (!this.abortController.signal.aborted && this.result.status !== 'failed') {
        this.result.status = this.result.failedSteps > 0 ? 'failed' : 'completed';
      }
    } catch (err) {
      this.result.status = 'failed';
      logError(err instanceof Error ? err : new Error(String(err)), {
        category: classifyError(err),
        module: 'workflowEngine',
        function: 'run',
        planId: this.plan.id,
      });
    }

    this.result.completedAt = Date.now();
    this.result.totalDurationMs = this.result.completedAt - this.result.startedAt;
    this.config.onProgress(this.result);

    return this.result;
  }

  /**
   * 取消执行
   */
  cancel(): void {
    this.abortController.abort();
    this.result.status = 'cancelled';
    this.result.completedAt = Date.now();
    this.result.totalDurationMs = this.result.completedAt - this.result.startedAt;
  }

  /**
   * 获取当前执行状态
   */
  getStatus(): WorkflowExecResult {
    return { ...this.result, nodeResults: new Map(this.result.nodeResults) };
  }

  /**
   * 执行一个层级的所有节点
   */
  private async executeLevel(level: number[]): Promise<void> {
    const pending = [...level];

    // 并发执行，受 maxParallel 限制
    const executeNext = async (): Promise<void> => {
      while (pending.length > 0 && this.runningCount < this.config.maxParallel) {
        if (this.abortController.signal.aborted) return;

        const stepIndex = pending.shift()!;
        this.runningCount++;

        try {
          await this.executeNode(stepIndex);
        } finally {
          this.runningCount--;
        }
      }
    };

    // 启动初始并发
    const workers: Promise<void>[] = [];
    const workerCount = Math.min(this.config.maxParallel, pending.length);
    for (let i = 0; i < workerCount; i++) {
      workers.push(executeNext());
    }

    await Promise.all(workers);

    // 处理剩余节点
    while (pending.length > 0 && !this.abortController.signal.aborted) {
      await executeNext();
    }
  }

  /**
   * 执行单个节点
   */
  private async executeNode(stepIndex: number): Promise<void> {
    const step = this.plan.steps[stepIndex];
    if (!step) return;

    // 查找匹配的执行器
    const executor = this.executors.find((e) => e.supportedTypes.includes(step.type));

    const nodeResult: NodeExecResult = {
      nodeId: '',
      stepIndex,
      status: 'running',
      startedAt: Date.now(),
    };

    this.result.nodeResults.set(stepIndex, nodeResult);
    this.config.onNodeStatusChange(stepIndex, 'running', nodeResult);

    if (!executor) {
      // 无匹配执行器 → 跳过
      nodeResult.status = 'skipped';
      nodeResult.completedAt = Date.now();
      nodeResult.durationMs = nodeResult.completedAt - nodeResult.startedAt;
      this.result.completedSteps++;
      this.config.onNodeStatusChange(stepIndex, 'skipped', nodeResult);
      return;
    }

    try {
      // 带超时的节点执行
      const execPromise = executor.execute(
        `wf-${this.plan.id}-step-${stepIndex}`,
        step,
        this.abortController.signal,
      );

      const timeoutPromise = new Promise<NodeExecResult>((_, reject) => {
        setTimeout(() => reject(new Error(`节点执行超时 (${this.config.nodeTimeout}ms)`)), this.config.nodeTimeout);
      });

      const result = await Promise.race([execPromise, timeoutPromise]);

      nodeResult.status = result.status;
      nodeResult.outputs = result.outputs;
      nodeResult.error = result.error;
      nodeResult.completedAt = Date.now();
      nodeResult.durationMs = nodeResult.completedAt - nodeResult.startedAt;

      if (result.status === 'completed') {
        this.result.completedSteps++;
      } else {
        this.result.failedSteps++;
      }
    } catch (err) {
      nodeResult.status = 'failed';
      nodeResult.error = err instanceof Error ? err.message : String(err);
      nodeResult.completedAt = Date.now();
      nodeResult.durationMs = nodeResult.completedAt - nodeResult.startedAt;
      this.result.failedSteps++;

      logError(err instanceof Error ? err : new Error(String(err)), {
        category: classifyError(err),
        module: 'workflowEngine',
        function: 'executeNode',
        stepIndex,
        stepType: step.type,
        stepLabel: step.label,
      });
    }

    this.config.onNodeStatusChange(stepIndex, nodeResult.status, nodeResult);
    this.config.onProgress(this.result);
  }
}

// ===== 便捷工厂函数 =====

/**
 * 创建并运行工作流
 */
export async function runWorkflow(
  plan: WorkflowPlan,
  executors: NodeExecutor[],
  config?: WorkflowEngineConfig,
): Promise<WorkflowExecResult> {
  const engine = new WorkflowEngine(plan, executors, config);
  return engine.run();
}

// ===== 带错误边界的包装 =====

export const safeParseComfyUIWorkflow = wrapService(
  (comfyJson: string) => {
    const result = parseComfyUIWorkflow(comfyJson);
    return Promise.resolve(result);
  },
  { name: 'comfyui.parseWorkflow', timeout: 10000, retries: 0 },
);

export const safeExportToComfyUIWorkflow = wrapService(
  (plan: WorkflowPlan) => {
    const result = exportToComfyUIWorkflow(plan);
    return Promise.resolve(result);
  },
  { name: 'comfyui.exportWorkflow', timeout: 5000, retries: 0 },
);
