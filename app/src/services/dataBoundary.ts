import type { Canvas, CanvasNode, NodeData, NodeType } from '@/types';

export interface CanvasValidationResult {
  success: boolean;
  data?: Canvas;
  errors: string[];
}

export interface ValidationResult<T> {
  valid: boolean;
  data?: T;
  errors: string[];
}

const NODE_TYPES = new Set<NodeType>(['text', 'image', 'video', 'audio', 'storyboard', 'aiapp', 'threed', 'script', 'dcc', 'post', 'region']);
const STATUSES = new Set(['idle', 'pending', 'generating', 'completed', 'error']);

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function normalizeHandleId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'null' || trimmed === 'undefined') return undefined;
  return trimmed;
}

function normalizeNodeData(raw: unknown, type: NodeType): NodeData {
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const status = asString(input.status, 'idle');
  return {
    label: asString(input.label, type),
    content: asString(input.content),
    prompt: asString(input.prompt),
    provider: asString(input.provider),
    model: asString(input.model),
    status: STATUSES.has(status) ? status as NodeData['status'] : 'idle',
    outputs: Array.isArray(input.outputs) ? input.outputs as NodeData['outputs'] : [],
    inputs: Array.isArray(input.inputs) ? input.inputs as NodeData['inputs'] : [],
    imageUrl: asString(input.imageUrl),
    videoUrl: asString(input.videoUrl),
    error: asString(input.error),
    params: input.params && typeof input.params === 'object' ? input.params as Record<string, unknown> : {},
    aspectRatio: asString(input.aspectRatio),
    quality: asString(input.quality),
    duration: asNumber(input.duration, 0),
    cost: asNumber(input.cost, 0),
    createdAt: asNumber(input.createdAt, Date.now()),
    updatedAt: asNumber(input.updatedAt, Date.now()),
  };
}

export function validateCanvasImport(data: unknown): CanvasValidationResult {
  const errors: string[] = [];
  if (!data || typeof data !== 'object') return { success: false, errors: ['画布数据必须是对象'] };
  const raw = data as Record<string, unknown>;
  const nodesRaw = Array.isArray(raw.nodes) ? raw.nodes : [];
  const edgesRaw = Array.isArray(raw.edges) ? raw.edges : [];

  const nodes: CanvasNode[] = [];
  for (const item of nodesRaw) {
    if (!item || typeof item !== 'object') {
      errors.push('节点必须是对象');
      continue;
    }
    const node = item as Record<string, unknown>;
    const type = asString(node.type, 'text') as NodeType;
    if (!NODE_TYPES.has(type)) {
      errors.push(`不支持的节点类型: ${String(node.type)}`);
      continue;
    }
    const position = node.position && typeof node.position === 'object' ? node.position as Record<string, unknown> : {};
    nodes.push({
      id: asString(node.id, crypto.randomUUID()),
      type,
      position: { x: asNumber(position.x, 0), y: asNumber(position.y, 0) },
      data: normalizeNodeData(node.data, type),
      selected: Boolean(node.selected),
    });
  }

  const edges = edgesRaw
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    .map((edge) => ({
      id: asString(edge.id, crypto.randomUUID()),
      source: asString(edge.source),
      target: asString(edge.target),
      sourceHandle: normalizeHandleId(edge.sourceHandle),
      targetHandle: normalizeHandleId(edge.targetHandle),
      type: asString(edge.type, 'smoothstep') as Canvas['edges'][number]['type'],
      pending: Boolean(edge.pending),
    }))
    .filter((edge) => edge.source && edge.target);

  if (errors.length > 0) return { success: false, errors };

  return {
    success: true,
    errors: [],
    data: {
      id: asString(raw.id, crypto.randomUUID()),
      title: asString(raw.title, 'DDUp'),
      nodes,
      edges,
      viewport: raw.viewport && typeof raw.viewport === 'object'
        ? {
            x: asNumber((raw.viewport as Record<string, unknown>).x, 0),
            y: asNumber((raw.viewport as Record<string, unknown>).y, 0),
            zoom: asNumber((raw.viewport as Record<string, unknown>).zoom, 1),
          }
        : { x: 0, y: 0, zoom: 1 },
      createdAt: asNumber(raw.createdAt, Date.now()),
      updatedAt: asNumber(raw.updatedAt, Date.now()),
    },
  };
}

export function validateGenerateRequest(params: {
  nodeId?: string;
  prompt?: string;
  provider?: string;
  model?: string;
}): ValidationResult<{ nodeId: string; prompt: string; provider: string; model: string }> {
  const errors: string[] = [];
  if (!params.nodeId) errors.push('缺少节点 ID');
  if (!params.prompt?.trim()) errors.push('提示词不能为空');
  if ((params.prompt?.length || 0) > 4000) errors.push('提示词不能超过 4000 字符');
  if (!params.provider) errors.push('缺少模型平台');
  if (!params.model) errors.push('缺少模型 ID');
  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    errors: [],
    data: {
      nodeId: params.nodeId!,
      prompt: params.prompt!.trim(),
      provider: params.provider!,
      model: params.model!,
    },
  };
}

export function deriveNodeDisplayData(node: CanvasNode) {
  const status = node.data.status || 'idle';
  const statusMap = {
    pending: { text: 'Pending', color: '#6e7681' },
    idle: { text: '待生成', color: '#6e7681' },
    generating: { text: '生成中', color: '#00d4aa' },
    completed: { text: '已完成', color: '#22c55e' },
    error: { text: '生成失败', color: '#ef4444' },
  } as const;
  const current = statusMap[status] || statusMap.idle;
  return {
    title: node.data.label || '未命名节点',
    subtitle: `${node.data.provider || '未配置'} / ${node.data.model || '未配置模型'}`,
    statusText: current.text,
    statusColor: current.color,
    hasOutput: Boolean(node.data.outputs?.length || node.data.imageUrl || node.data.videoUrl),
    outputCount: node.data.outputs?.length || 0,
    isGenerating: status === 'generating',
  };
}

export function safeSerializeCanvas(data: unknown): string {
  const seen = new WeakSet();
  return JSON.stringify(data, (_key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    if (typeof value === 'function' || typeof value === 'symbol') return undefined;
    if (value instanceof Error) return { message: value.message, stack: value.stack };
    return value;
  }, 2);
}

export function safeDeserializeCanvas(json: string): { success: boolean; data?: unknown; errors: string[] } {
  try {
    const parsed = JSON.parse(json);
    return validateCanvasImport(parsed);
  } catch (error) {
    return { success: false, errors: [`JSON 解析失败: ${error instanceof Error ? error.message : String(error)}`] };
  }
}
