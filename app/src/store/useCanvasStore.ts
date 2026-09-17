import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { persist } from 'zustand/middleware';
import { v4 as uuidv4 } from 'uuid';
import type {
  Canvas,
  CanvasEdge,
  CanvasNode,
  HistoryEntry,
  NodeType,
  NodeData,
  AppState,
  SidebarTab,
  AssetItem,
  Workflow,
  NodeGroup,
  MediaOutput,
  FloatingPanelState,
  WorkflowPlan,
} from '@/types';
import { safeSerializeCanvas, safeDeserializeCanvas } from '@/services/dataBoundary';
import { isLocalMediaHandle } from '@/services/localMediaRegistry';

export type { WorkflowPlan, WorkflowStep } from '@/types';

type Language = 'zh' | 'en';
const CANVAS_LANGUAGE_EXPLICIT_KEY = 'hmdao-canvas-language-explicit';
const MAX_CANVAS_HISTORY = 80;

const NODE_LABELS: Record<NodeType, Record<Language, string>> = {
  text: { zh: '文本节点', en: 'Text' },
  image: { zh: '图片节点', en: 'Image' },
  video: { zh: '视频节点', en: 'Video' },
  audio: { zh: '音频节点', en: 'Audio' },
  post: { zh: '后期节点', en: 'Post' },
  script: { zh: '脚本节点', en: 'Script Builder' },
  storyboard: { zh: '分镜节点', en: 'Storyboard Grid' },
  aiapp: { zh: 'AI 应用', en: 'AI App' },
  threed: { zh: '3D 世界', en: '3D World' },
  dcc: { zh: 'DCC 捕捉', en: 'DCC Capture' },
  region: { zh: '打标签节点', en: 'Tagging Node' },
  comfyui: { zh: 'ComfyUI 工作流', en: 'ComfyUI Workflow' },
};

const LEGACY_NODE_LABELS: Partial<Record<NodeType, string[]>> = {
  text: ['文本节点'],
  image: ['图片节点'],
  video: ['视频节点', '视频输出'],
  audio: ['闊抽鑺傜偣'],
  post: ['后期节点'],
  script: ['鑴氭湰鑺傜偣', '脚本拆解'],
  storyboard: ['分镜节点'],
  aiapp: ['AI 应用'],
  threed: ['3D 世界'],
  dcc: ['DCC 捕捉'],
};

const BROKEN_NODE_LABEL_RE = /\uFFFD|\u951f|\?{2,}|[\u95c2\u5a75\u6fe1\u6fde\u951b\u93c8]/;
const BROKEN_NODE_LABEL_HINTS = new Set(['鎻', '掍', '欢', '铏', '氬', '够', '鍔', '犺', '浇', '妫', '绛', '緟', '鏉', '块', '厤', '鍣']);

function isBrokenNodeLabel(value: string) {
  if (BROKEN_NODE_LABEL_RE.test(value)) return true;
  const suspiciousCount = [...value].reduce((count, char) => count + (BROKEN_NODE_LABEL_HINTS.has(char) ? 1 : 0), 0);
  return value.length <= 24 && suspiciousCount >= 2;
}

const BASE_NODE_DATA: Record<NodeType, Omit<Partial<NodeData>, 'label'>> = {
  text: {
    content: '',
    provider: 'bailian',
    model: 'qwen3.7-flash',
    status: 'idle',
    cost: 0,
  },
  image: {
    provider: 'fal',
    model: 'flux-pro',
    status: 'idle',
    aspectRatio: '1:1',
    quality: 'standard',
    cost: 0.38,
  },
  video: {
    provider: 'fal',
    model: 'seedance-v2',
    status: 'idle',
    aspectRatio: '16:9',
    duration: 5,
    quality: '720p',
    cost: 6,
  },
  audio: {
    provider: 'minimax',
    model: 'speech-2.8-turbo',
    status: 'idle',
    cost: 0.37,
  },
  post: {
    provider: 'local',
    model: 'ffmpeg-post-stack',
    status: 'idle',
    cost: 0,
    params: {
      sourceMediaType: 'image',
    },
  },
  script: {
    status: 'idle',
    cost: 0,
  },
  storyboard: {
    status: 'idle',
    cost: 0,
  },
  aiapp: {
    status: 'idle',
    cost: 0,
  },
  threed: {
    status: 'idle',
    cost: 0,
  },
  dcc: {
    provider: 'dcc',
    model: 'blender',
    status: 'idle',
    cost: 0,
    params: {
      engine: 'blender',
      resolution: { width: 1920, height: 1080 },
    },
  },
  region: {
    provider: 'local',
    model: 'region-contract-v1',
    status: 'idle',
    cost: 0,
    params: {
      sourceMediaType: 'image',
      regionContract: {
        version: 'region-contract-v1',
        source: { url: '', mediaType: 'image' },
        regions: [],
        bindings: [],
        executionPlan: { orderedRegionIds: [], strategy: 'region-contract-v1' },
        consistencyRequirements: [],
        fallbackPolicy: 'reject',
      },
    },
  },
  comfyui: {
    provider: 'comfyui',
    model: 'comfyui-gateway',
    status: 'idle',
    cost: 0,
  },
};

const DEFAULT_ASSET_CATEGORIES: Record<Language, string[]> = {
  zh: ['默认', '角色', '场景', '道具', '背景'],
  en: ['Default', 'Character', 'Scene', 'Prop', 'Background'],
};

const HISTORY_ACTION_LABELS = {
  addNode: { zh: '添加节点', en: 'Add node' },
  deleteNode: { zh: '删除节点', en: 'Delete node' },
  moveNode: { zh: '移动节点', en: 'Move node' },
} as const;

function getNodeLabel(type: NodeType, language: Language) {
  return NODE_LABELS[type][language] || NODE_LABELS[type].zh;
}

function repairLegacyNodeLabel(label: unknown, type: NodeType | undefined) {
  const raw = typeof label === 'string' ? label.trim() : '';
  if (!type) return raw;
  if (!raw || isBrokenNodeLabel(raw)) return NODE_LABELS[type].zh;
  return (LEGACY_NODE_LABELS[type] || []).includes(raw) ? NODE_LABELS[type].zh : raw;
}

function getDefaultNodeData(type: NodeType, language: Language): Partial<NodeData> {
  return {
    ...BASE_NODE_DATA[type],
    label: getNodeLabel(type, language),
  };
}

function getHistoryActionLabel(action: keyof typeof HISTORY_ACTION_LABELS, language: Language) {
  return HISTORY_ACTION_LABELS[action][language];
}

const DEFAULT_TARGET_HANDLE_BY_TYPE: Partial<Record<NodeType, string>> = {
  image: 'image-main',
  video: 'video-main',
  audio: 'audio-input',
  storyboard: 'input',
  post: 'post-input',
  region: 'region-main',
};

const DEFAULT_SOURCE_HANDLE_BY_TYPE: Partial<Record<NodeType, string>> = {
  image: 'media-output',
  video: 'media-output',
  audio: 'audio-output',
  storyboard: 'storyboard-output',
  post: 'post-output',
  dcc: 'dcc-output',
  region: 'region-output',
};

const deferredEdgeTimers = new Map<string, number>();
const deferredEdgeAttempts = new Map<string, number>();
function buildDeferredEdgeKey(edge: { source: string; target: string; sourceHandle?: string; targetHandle?: string }) {
  return [
    edge.source,
    edge.target,
    edge.sourceHandle || '',
    edge.targetHandle || '',
  ].join('::');
}

function hasMountedHandle(nodeId: string, handleId: string | undefined, type: 'source' | 'target') {
  if (typeof document === 'undefined') return true;
  const escapedNodeId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(nodeId) : nodeId;
  if (!handleId) {
    return Boolean(document.querySelector(`.react-flow__handle.${type}[data-nodeid="${escapedNodeId}"]`));
  }
  const escapedHandleId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(handleId) : handleId;
  return Boolean(document.querySelector(`.react-flow__handle.${type}[data-nodeid="${escapedNodeId}"][data-handleid="${escapedHandleId}"]`));
}

function shouldDeferEdgeUntilMounted(edge: { source: string; target: string; sourceHandle?: string; targetHandle?: string }) {
  if (typeof window === 'undefined') return false;
  if (!hasMountedHandle(edge.source, edge.sourceHandle, 'source')) return true;
  if (!hasMountedHandle(edge.target, edge.targetHandle, 'target')) return true;
  return false;
}

function clearDeferredEdgeState(edgeKey: string) {
  const timer = deferredEdgeTimers.get(edgeKey);
  if (typeof window !== 'undefined' && timer !== undefined) {
    window.clearTimeout(timer);
  }
  deferredEdgeTimers.delete(edgeKey);
  deferredEdgeAttempts.delete(edgeKey);
}

function clearAllDeferredEdges() {
  if (typeof window !== 'undefined') {
    for (const timer of deferredEdgeTimers.values()) {
      window.clearTimeout(timer);
    }
  }
  deferredEdgeTimers.clear();
  deferredEdgeAttempts.clear();
}

function clearDeferredEdgesForNode(nodeId: string) {
  const keys = Array.from(deferredEdgeTimers.keys()).filter((key) => key.startsWith(`${nodeId}::`) || key.includes(`::${nodeId}::`));
  for (const key of keys) {
    clearDeferredEdgeState(key);
  }
}

function normalizeHandleId(value: string | null | undefined) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'null' || trimmed === 'undefined') return undefined;
  return trimmed;
}

function normalizeSourceHandleId(value: string | null | undefined) {
  return normalizeHandleId(value);
}

function normalizeEdgeHandles<T extends { source: string; target: string; sourceHandle?: string; targetHandle?: string }>(
  edge: T,
  nodes: CanvasNode[] | undefined,
): T {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return edge;
  }
  const sourceNode = nodes.find((node) => node.id === edge.source);
  const targetNode = nodes.find((node) => node.id === edge.target);
  const currentSourceHandle = normalizeSourceHandleId(edge.sourceHandle);
  const currentTargetHandle = normalizeHandleId(edge.targetHandle);
  const nextSourceHandle = currentSourceHandle || (sourceNode ? DEFAULT_SOURCE_HANDLE_BY_TYPE[sourceNode.type] : undefined);
  const nextTargetHandle = currentTargetHandle || (targetNode ? DEFAULT_TARGET_HANDLE_BY_TYPE[targetNode.type] : undefined);
  if (nextSourceHandle === edge.sourceHandle && nextTargetHandle === edge.targetHandle) {
    return edge;
  }
  return {
    ...edge,
    sourceHandle: nextSourceHandle,
    targetHandle: nextTargetHandle,
  };
}

function normalizeCanvasEdges<T extends { source: string; target: string; sourceHandle?: string; targetHandle?: string }>(
  edges: T[] | undefined,
  nodes: CanvasNode[] | undefined,
): T[] {
  return Array.isArray(edges) ? edges.map((edge) => normalizeEdgeHandles(edge, nodes)) : [];
}

function findEdgeIndex(
  edges: Array<{ source: string; target: string; sourceHandle?: string; targetHandle?: string }>,
  nextEdge: { source: string; target: string; sourceHandle?: string; targetHandle?: string },
) {
  return edges.findIndex(
    (edge) => edge.source === nextEdge.source
      && edge.target === nextEdge.target
      && (edge.sourceHandle || '') === (nextEdge.sourceHandle || '')
      && (edge.targetHandle || '') === (nextEdge.targetHandle || ''),
  );
}

function edgeExists(
  edges: Array<{ source: string; target: string; sourceHandle?: string; targetHandle?: string }>,
  nextEdge: { source: string; target: string; sourceHandle?: string; targetHandle?: string },
) {
  return findEdgeIndex(edges, nextEdge) >= 0;
}

function removeEdgeBoundInputsFromNode(node: CanvasNode, edge: Pick<CanvasEdge, 'source' | 'targetHandle'>) {
  const existingInputs = Array.isArray(node.data.inputs)
    ? node.data.inputs.filter((item) => item && typeof item === 'object')
    : [];
  if (!existingInputs.length) return false;

  const targetHandle = String(edge.targetHandle || '').trim();
  const nextInputs = existingInputs.filter((item) => {
    const sourceNodeId = String(item?.sourceNodeId || '').trim();
    const handleId = String(item?.handleId || '').trim();
    return !(sourceNodeId === edge.source && handleId === targetHandle);
  });
  if (nextInputs.length === existingInputs.length) return false;

  node.data.inputs = nextInputs;
  return true;
}

function removeEdgeReferenceSettingsFromNode(node: CanvasNode, edge: Pick<CanvasEdge, 'id' | 'source' | 'targetHandle'>) {
  const params = node.data.params && typeof node.data.params === 'object'
    ? node.data.params as Record<string, unknown>
    : null;
  const referenceSettings = params?.referenceSettings && typeof params.referenceSettings === 'object'
    ? params.referenceSettings as Record<string, unknown>
    : null;
  if (!referenceSettings) return false;

  const targetHandle = String(edge.targetHandle || 'default').trim() || 'default';
  const edgePrefix = `${edge.id}:${edge.source}:${targetHandle}:`;
  const manualPrefix = `manual:${edge.source}:${targetHandle}:`;
  const nextReferenceSettings = Object.fromEntries(
    Object.entries(referenceSettings).filter(([key]) => !key.startsWith(edgePrefix) && !key.startsWith(manualPrefix)),
  );
  if (Object.keys(nextReferenceSettings).length === Object.keys(referenceSettings).length) return false;

  node.data.params = {
    ...params,
    referenceSettings: nextReferenceSettings,
  };
  return true;
}

function cleanupRemovedEdgeBindings(canvas: Canvas, edge: CanvasEdge) {
  const targetNode = canvas.nodes.find((node) => node.id === edge.target);
  if (!targetNode) return false;

  const inputsChanged = removeEdgeBoundInputsFromNode(targetNode, edge);
  const referenceSettingsChanged = removeEdgeReferenceSettingsFromNode(targetNode, edge);
  return inputsChanged || referenceSettingsChanged;
}

function upsertCanvasEdge(
  edges: Array<{
    id: string;
    source: string;
    target: string;
    sourceHandle?: string;
    targetHandle?: string;
    type?: 'default' | 'smoothstep' | 'straight';
    pending?: boolean;
  }>,
  nextEdge: { source: string; target: string; sourceHandle?: string; targetHandle?: string },
  pending: boolean,
) {
  const edgeIndex = findEdgeIndex(edges, nextEdge);
  if (edgeIndex >= 0) {
    const existing = edges[edgeIndex];
    const nextPending = pending ? true : undefined;
    const changed =
      existing.sourceHandle !== nextEdge.sourceHandle
      || existing.targetHandle !== nextEdge.targetHandle
      || existing.type !== 'smoothstep'
      || existing.pending !== nextPending;
    if (!changed) {
      return false;
    }
    edges[edgeIndex] = {
      ...existing,
      sourceHandle: nextEdge.sourceHandle,
      targetHandle: nextEdge.targetHandle,
      type: 'smoothstep',
      pending: nextPending,
    };
    return true;
  }
  edges.push({
    id: uuidv4(),
    source: nextEdge.source,
    target: nextEdge.target,
    sourceHandle: nextEdge.sourceHandle,
    targetHandle: nextEdge.targetHandle,
    type: 'smoothstep',
    pending: pending ? true : undefined,
  });
  return true;
}

interface CanvasStore extends AppState {
  // Actions
  createCanvas: (title?: string) => void;
  setCanvasViewport: (viewport: { x: number; y: number; zoom: number; width?: number; height?: number }) => void;
  addNode: (type: NodeType, position?: { x: number; y: number }) => string;
  addConnectedNode: (options: {
    nodeId?: string;
    type: NodeType;
    position?: { x: number; y: number };
    data?: Partial<NodeData>;
    sourceId?: string | null;
    sourceHandle?: string | null;
    targetHandle?: string | null;
    sourceData?: { nodeId: string; data: Partial<NodeData> } | null;
    select?: boolean;
  }) => string;
  updateNodeData: (nodeId: string, data: Partial<NodeData>) => void;
  removeNode: (nodeId: string) => void;
  removeNodes: (nodeIds: string[]) => void;
  moveNode: (nodeId: string, position: { x: number; y: number }) => void;
  moveNodes: (positions: Record<string, { x: number; y: number }>) => void;
  commitMoveHistory: () => void;
  selectNode: (nodeId: string, multi?: boolean) => void;
  deselectAll: () => void;
  setSelectionGuard: (durationMs?: number) => void;
  addEdge: (source: string, target: string, handles?: { sourceHandle?: string | null; targetHandle?: string | null }) => void;
  removeEdge: (edgeId: string) => void;
  duplicateNode: (nodeId: string) => void;
  undo: (steps?: number) => void;
  undoSteps: (steps: number) => void;
  redo: (steps?: number) => void;
  clearHistory: () => void;
  setSelectedNodeIds: (nodeIds: string[]) => void;
  requestViewportFocus: (nodeId: string | null) => void;
  consumeViewportFocus: (nodeId?: string | null) => void;
  openFloatingPanel: (panel: FloatingPanelState) => void;
  closeFloatingPanel: (nodeId?: string, kind?: string) => void;

  // Generation
  setGenerating: (nodeId: string, isGenerating: boolean) => void;
  addOutput: (nodeId: string, output: MediaOutput) => void;

  // UI
  setSidebarTab: (tab: SidebarTab) => void;
  toggleSidebar: () => void;
  toggleAIPanel: () => void;
  toggleAssetPanel: () => void;
  toggleDarkMode: () => void;
  setShowShortcuts: (show: boolean) => void;
  setLanguage: (lang: 'zh' | 'en') => void;
  importWorkflowOpen: boolean;
  openImportWorkflow: () => void;
  closeImportWorkflow: () => void;

  // Assets
  addAsset: (asset: AssetItem) => void;
  removeAsset: (assetId: string) => void;

  // Import/Export
  exportCanvas: () => string;
  importCanvas: (json: string) => void;

  // Workflows
  workflows: Workflow[];
  saveWorkflow: (name: string, description?: string, color?: string) => void;
  deleteWorkflow: (workflowId: string) => void;
  loadWorkflow: (workflowId: string) => void;
  renameWorkflow: (workflowId: string, newName: string) => void;

  // Node Groups
  groups: NodeGroup[];
  createGroup: (nodeIds: string[], name: string, color: string) => string;
  deleteGroup: (groupId: string) => void;
  ungroup: (groupId: string) => void;
  renameGroup: (groupId: string, newName: string) => void;
  updateGroupColor: (groupId: string, color: string) => void;
  addNodesToGroup: (groupId: string, nodeIds: string[]) => void;
  removeNodesFromGroup: (groupId: string, nodeIds: string[]) => void;
  arrangeGroup: (groupId: string, mode: 'grid' | 'horizontal' | 'vertical') => void;

  // Agentic Workflow
  createWorkflowFromPlan: (plan: WorkflowPlan) => Promise<{ success: boolean; nodeIds: string[]; error?: string }>;
  rollbackWorkflow: (nodeIds: string[]) => void;

  // Helpers
  getSelectedNodes: () => CanvasNode[];
  getNodeById: (id: string) => CanvasNode | undefined;
  getNodesInGroup: (groupId: string) => CanvasNode[];
}

const createNewCanvas = (title?: string, language: Language = 'zh'): Canvas => ({
  id: uuidv4(),
  title: title || (language === 'en' ? 'Untitled Canvas' : '未命名画布'),
  nodes: [],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1, width: 1280, height: 720 },
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

function cloneHistoryEntry(type: string, canvas: Canvas, selectedNodeIds: string[]): HistoryEntry {
  return {
    type,
    nodes: canvas.nodes.map((node) => ({ ...node, data: { ...node.data } })),
    edges: canvas.edges.map((edge) => ({ ...edge })),
    selectedNodeIds: [...selectedNodeIds],
    timestamp: Date.now(),
  };
}

function trimHistoryEntries(history: HistoryEntry[]): HistoryEntry[] {
  if (history.length <= MAX_CANVAS_HISTORY) {
    return history;
  }
  return history.slice(history.length - MAX_CANVAS_HISTORY);
}

function pushHistoryEntry(state: {
  canvas: Canvas | null;
  history: HistoryEntry[];
  historyIndex: number;
  selectedNodeIds: string[];
}, type: string) {
  if (!state.canvas) return;
  const nextHistory = state.history.slice(0, state.historyIndex + 1);
  nextHistory.push(cloneHistoryEntry(type, state.canvas, state.selectedNodeIds));
  state.history = trimHistoryEntries(nextHistory);
  state.historyIndex = state.history.length - 1;
}

function getViewportAwareSpawnPosition(canvas: Canvas | null | undefined) {
  const viewport = canvas?.viewport;
  if (!viewport) {
    return { x: 420, y: 220 };
  }
  const zoom = Number(viewport.zoom || 1) || 1;
  const width = Number(viewport.width || 1280) || 1280;
  const height = Number(viewport.height || 720) || 720;
  const centerX = (-Number(viewport.x || 0) + width / 2) / zoom;
  const centerY = (-Number(viewport.y || 0) + height / 2) / zoom;
  return {
    x: Math.round(centerX - 140),
    y: Math.round(centerY - 120),
  };
}

function revokeManagedOutputUrls(data?: Partial<NodeData>) {
  const urls = new Set<string>();
  const outputs = Array.isArray(data?.outputs) ? data.outputs : [];
  for (const output of outputs) {
    if (output?.url && output.metadata && (output.metadata as Record<string, unknown>).managedUrl) {
      urls.add(output.url);
    }
  }
  for (const url of urls) {
    if (isLocalMediaHandle(url)) {
      continue;
    }
    if (url.startsWith('blob:')) {
      URL.revokeObjectURL(url);
    }
  }
}

function sanitizePersistedValue(value: unknown, key = ''): unknown {
  if (typeof value === 'string') {
    if (/DataUrl$/i.test(key)) return undefined;
    if (value.startsWith('blob:')) {
      return undefined;
    }
    if (value.startsWith('data:') && value.length > 4096) {
      return `[inline-media:${value.length}]`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePersistedValue(item)).filter((item) => item !== undefined);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([entryKey, entryValue]) => [entryKey, sanitizePersistedValue(entryValue, entryKey)])
        .filter(([, entryValue]) => entryValue !== undefined),
    );
  }
  return value;
}

// 判断一个值是否是浏览器可直接渲染的资源地址。
// 历史数据里出现过把素材 ID（裸 UUID，如 a6433503-xxxx-...）直接塞进 imageUrl/videoUrl 的情况，
// 渲染时会被当作相对 URL 请求（http://host/<uuid>），后端必然 404，且每次加载都复现。
// 这类不可渲染的值在持久化阶段统一丢弃，避免陈旧引用无限期留存。
function isRenderableAssetUrl(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const value = raw.trim();
  if (!value) return false;
  if (/^(?:https?:\/\/|data:|blob:|file:)/i.test(value)) return true;
  if (value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) return true;
  return false;
}

function sanitizePersistedNodeData(data: NodeData): NodeData {
  const next = sanitizePersistedValue(data) as NodeData;
  const out: NodeData = { ...next };
  // 只丢弃「不可渲染」的值（裸 UUID 等）；正常 URL 一律保留，不误伤可用素材。
  if (out.imageUrl != null && !isRenderableAssetUrl(out.imageUrl)) out.imageUrl = '';
  if (out.videoUrl != null && !isRenderableAssetUrl(out.videoUrl)) out.videoUrl = '';
  return out;
}

function migratePersistedNodeData(data: NodeData, type?: NodeType): NodeData {
  const next = sanitizePersistedValue(data) as NodeData;
  const repairedLabel = repairLegacyNodeLabel(next.label, type);
  const hadBrokenImage = typeof data.imageUrl === 'string' && data.imageUrl.startsWith('blob:');
  const hadBrokenVideo = typeof data.videoUrl === 'string' && data.videoUrl.startsWith('blob:');
  if (!hadBrokenImage && !hadBrokenVideo) {
    return repairedLabel && repairedLabel !== next.label ? { ...next, label: repairedLabel } : next;
  }
  const params = next.params && typeof next.params === 'object' ? next.params as Record<string, unknown> : {};
  return {
    ...next,
    label: repairedLabel || next.label,
    imageUrl: hadBrokenImage ? '' : next.imageUrl,
    videoUrl: hadBrokenVideo ? '' : next.videoUrl,
    error: next.error || '历史本地素材已失效，请重新上传，或重新生成新的节点结果。',
    params: {
      ...params,
      legacyBlobInvalid: true,
      lastError: typeof params.lastError === 'string' && params.lastError.trim()
        ? params.lastError
        : '历史本地素材已失效，请重新上传，或重新生成新的节点结果。',
      lastErrorCategory: typeof params.lastErrorCategory === 'string' && params.lastErrorCategory.trim()
        ? params.lastErrorCategory
        : 'render',
    },
  };
}

// Demo workflows
const demoWorkflows: Workflow[] = [
  {
    id: 'wf-1',
    name: '图片海报生成',
    description: '从参考图到提示词再到成图的基础海报工作流。',
    nodes: [
      { id: 'n1', type: 'image', position: { x: 100, y: 100 }, data: { label: '参考图片', status: 'idle', provider: 'fal', model: 'flux-pro' } },
      { id: 'n2', type: 'text', position: { x: 400, y: 100 }, data: { label: '提示词', status: 'idle', content: '生成一张电影感汽车海报。' } },
      { id: 'n3', type: 'image', position: { x: 700, y: 100 }, data: { label: '输出海报', status: 'idle', provider: 'fal', model: 'flux-pro' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2', type: 'smoothstep' },
      { id: 'e2', source: 'n2', target: 'n3', type: 'smoothstep' },
    ],
    color: '#00d4aa',
    createdAt: Date.now() - 86400000,
    updatedAt: Date.now(),
  },
  {
    id: 'wf-2',
    name: '文案到视频分镜',
    description: '先产出脚本，再连接视频节点生成镜头预演。',
    nodes: [
      { id: 'n4', type: 'text', position: { x: 100, y: 300 }, data: { label: '创意文案', status: 'idle', content: '写一支 15 秒汽车广告脚本。' } },
      { id: 'n5', type: 'script', position: { x: 400, y: 300 }, data: { label: '脚本拆解', status: 'idle' } },
      { id: 'n6', type: 'video', position: { x: 700, y: 300 }, data: { label: '视频输出', status: 'idle', provider: 'fal', model: 'seedance-v2' } },
    ],
    edges: [
      { id: 'e3', source: 'n4', target: 'n5', type: 'smoothstep' },
      { id: 'e4', source: 'n5', target: 'n6', type: 'smoothstep' },
    ],
    color: '#1a8cff',
    createdAt: Date.now() - 172800000,
    updatedAt: Date.now(),
  },
  {
    id: 'wf-dcc-blender-image-poster',
    name: 'Blender 截图生成海报',
    description: '从 Blender 摄像机截图进入图片节点，在保持原构图的前提下替换主体并生成可编辑海报。',
    nodes: [
      {
        id: 'dcc-blender-capture',
        type: 'dcc',
        position: { x: 80, y: 520 },
        data: {
          label: 'Blender 截图',
          provider: 'dcc',
          model: 'blender',
          status: 'idle',
          params: {
            engine: 'blender',
            resolution: { width: 1280, height: 720, label: '1280 x 720' },
            captureIntent: 'capture-camera-view',
          },
        },
      },
      {
        id: 'dcc-blender-prompt',
        type: 'text',
        position: { x: 390, y: 520 },
        data: {
          label: '海报提示词',
          status: 'idle',
          content: '保持 Blender 摄像机原构图、透视和镜头焦段不变，按用户提示词自动识别并替换画面主体，输出适合海报排版的高质量静态画面。',
        },
      },
      {
        id: 'dcc-blender-image',
        type: 'image',
        position: { x: 760, y: 520 },
        data: {
          label: '海报输出',
          provider: 'siliconflow',
          model: 'lib-image',
          status: 'idle',
          aspectRatio: '16:9',
          params: {
            workflowTemplate: 'dcc-blender-image-poster',
            resolution: { width: 1280, height: 720, label: '1280x720', aspectRatio: '16:9' },
            promptStrategy: 'preserve-composition-replace-subject',
            posterLayout: {
              enabled: true,
              title: '主标题可编辑',
              subtitle: '副标题可编辑',
              tagline: 'BLENDER CAMERA POSTER',
              footer: 'DDUp 可编辑海报层',
              logoText: 'DDUp',
              badgeText: '720P',
              cornerText: '01',
              showLogo: true,
              showBadge: true,
              showDecor: true,
              align: 'left',
              theme: 'cinematic',
              editor: { elements: [] },
            },
          },
        },
      },
    ],
    edges: [
      { id: 'e-dcc-blender-capture-prompt', source: 'dcc-blender-capture', target: 'dcc-blender-prompt', type: 'smoothstep' },
      { id: 'e-dcc-blender-prompt-image', source: 'dcc-blender-prompt', target: 'dcc-blender-image', type: 'smoothstep' },
      { id: 'e-dcc-blender-capture-image', source: 'dcc-blender-capture', target: 'dcc-blender-image', type: 'smoothstep' },
    ],
    color: '#00d4aa',
    createdAt: Date.now() - 259200000,
    updatedAt: Date.now(),
  },
  {
    id: 'wf-dcc-unreal-video-replace',
    name: 'Unreal 录制替换主体',
    description: '从 Unreal 摄像机动画录制进入视频节点，保持原运镜和节奏不变，先输出 480p 预览视频。',
    nodes: [
      {
        id: 'dcc-unreal-record',
        type: 'dcc',
        position: { x: 80, y: 900 },
        data: {
          label: 'Unreal 录制',
          provider: 'dcc',
          model: 'unreal',
          status: 'idle',
          params: {
            engine: 'unreal',
            resolution: { width: 854, height: 480, label: '854 x 480' },
            startFrame: 1,
            endFrame: 72,
            recordFps: 24,
            captureIntent: 'record-camera-animation',
          },
        },
      },
      {
        id: 'dcc-unreal-prompt',
        type: 'text',
        position: { x: 390, y: 900 },
        data: {
          label: '视频提示词',
          status: 'idle',
          content: '保持原始运镜、景别、节奏和镜头路径不变，按用户提示词自动识别并替换视频主体，输出自然连贯的预览视频。',
        },
      },
      {
        id: 'dcc-unreal-video',
        type: 'video',
        position: { x: 760, y: 900 },
        data: {
          label: '视频输出',
          provider: 'bailian',
          model: 'bailian-wan22-i2v-plus',
          status: 'idle',
          aspectRatio: '16:9',
          quality: '480p',
          duration: 5,
          params: {
            workflowTemplate: 'dcc-unreal-video-replace',
            generationMode: 'referenceVideo',
            promptStrategy: 'preserve-camera-motion-replace-subject',
            videoOutputQuality: '480p',
            modelRouting: {
              preferredProvider: 'bailian',
              preferredModel: 'bailian-wan22-i2v-plus',
              upstreamModel: 'wan2.2-i2v-plus',
              fallbacks: [
                { provider: 'bailian', model: 'bailian-wan22-i2v-plus', upstreamModel: 'wan2.2-i2v-plus', when: 'active-key-and-balance' },
                { provider: 'siliconflow', model: 'wan22-i2v-a14b', upstreamModel: 'Wan-AI/Wan2.2-I2V-A14B', when: 'bailian-unavailable-or-insufficient-balance' },
              ],
            },
            quality: '480p',
            resolution: { width: 854, height: 480, label: '854x480', aspectRatio: '16:9' },
          },
        },
      },
    ],
    edges: [
      { id: 'e-dcc-unreal-record-prompt', source: 'dcc-unreal-record', target: 'dcc-unreal-prompt', type: 'smoothstep' },
      { id: 'e-dcc-unreal-prompt-video', source: 'dcc-unreal-prompt', target: 'dcc-unreal-video', type: 'smoothstep' },
      { id: 'e-dcc-unreal-record-video', source: 'dcc-unreal-record', target: 'dcc-unreal-video', type: 'smoothstep' },
    ],
    color: '#1a8cff',
    createdAt: Date.now() - 345600000,
    updatedAt: Date.now(),
  },
];

const BUILTIN_WORKFLOW_IDS = new Set(demoWorkflows.map((workflow) => workflow.id));

function cloneWorkflow(workflow: Workflow): Workflow {
  const nodes = workflow.nodes.map((node) => ({
    ...node,
    position: { ...node.position },
    data: { ...node.data },
  }));
  return {
    ...workflow,
    nodes,
    edges: normalizeCanvasEdges(workflow.edges.map((edge) => ({ ...edge })), nodes),
  };
}

function ensureBuiltinWorkflows(workflows: Workflow[] | undefined): Workflow[] {
  const custom = Array.isArray(workflows)
    ? workflows
      .filter((workflow) => !BUILTIN_WORKFLOW_IDS.has(workflow.id))
      .map(cloneWorkflow)
    : [];
  return [...demoWorkflows.map(cloneWorkflow), ...custom];
}

// 把分组里的 nodeIds 对账到「当前画布真实存在的节点」，剔除 phantom ID（已删除/不存在的 id），
// 并删除因此变空的组。用于任何会替换/恢复 canvas.nodes 的路径，从源头消除
// 分组节点计数与主画布不一致的状态管理问题。groups 未被改动时返回原引用，避免无谓的渲染。
function pruneGroupsToLiveNodes(groups: NodeGroup[], liveNodeIds: Set<string>): NodeGroup[] {
  let mutated = false;
  const pruned = groups
    .map((group) => {
      if (!group || !Array.isArray(group.nodeIds)) return group;
      const filtered = group.nodeIds.filter((id) => liveNodeIds.has(id));
      if (filtered.length === group.nodeIds.length) return group;
      mutated = true;
      return { ...group, nodeIds: filtered };
    })
    .filter((group) => {
      if (!group) return false;
      if (group.nodeIds.length === 0) {
        mutated = true;
        return false;
      }
      return true;
    });
  return mutated ? pruned : groups;
}

export const useCanvasStore = create<CanvasStore>()(
  persist(
    immer((set, get) => ({
    // Initial State
    canvas: createNewCanvas('DDUp'),
    selectedNodeIds: [],
    selectionGuardUntil: 0,
    pendingViewportFocusNodeId: null,
    pendingViewportFocusNonce: 0,
    zoom: 1,

    activeSidebarTab: 'add',
    sidebarCollapsed: false,
    showAIPanel: true,
    showAssetPanel: false,
    showTemplatePanel: false,
    importWorkflowOpen: false,
    showSettings: false,
    showShortcuts: false,
    darkMode: true,
    language: 'zh',
    floatingPanel: null,

    history: [],
    historyIndex: -1,

    generatingNodes: new Set(),
    queueStatus: { total: 0, pending: 0, running: 0, completed: 0, failed: 0 },

    assets: [],
    assetCategories: DEFAULT_ASSET_CATEGORIES.zh,

    workflows: ensureBuiltinWorkflows(demoWorkflows),

    groups: [],

    apiKeys: {},
    defaultProviders: {
      text: 'openai',
      image: 'fal',
      video: 'fal',
      audio: 'minimax',
    },

    // Actions
    createCanvas: (title) => {
      clearAllDeferredEdges();
      set((state) => {
        state.canvas = createNewCanvas(title, state.language);
        // 新建画布的节点是全新的，旧分组里残留的 nodeIds 全部失效，直接清空分组。
        state.groups = pruneGroupsToLiveNodes(state.groups, new Set(state.canvas.nodes.map((node) => node.id)));
        state.selectedNodeIds = [];
        state.floatingPanel = null;
        state.pendingViewportFocusNodeId = null;
        state.pendingViewportFocusNonce = 0;
        state.history = [];
        state.historyIndex = -1;
      });
    },

    setCanvasViewport: (viewport) => {
      set((state) => {
        if (!state.canvas) return;
        state.canvas.viewport = {
          x: Number(viewport.x || 0),
          y: Number(viewport.y || 0),
          zoom: Number(viewport.zoom || 1) || 1,
          width: viewport.width,
          height: viewport.height,
        };
        state.zoom = Number(viewport.zoom || 1) || 1;
      });
    },

    addNode: (type, position) => {
      // Prevent pathological UUID collisions before inserting a new node.
      const state = get();
      const existingIds = new Set(state.canvas?.nodes.map((n) => n.id) ?? []);
      let id = uuidv4();
      while (existingIds.has(id)) id = uuidv4();

      const pos = position || getViewportAwareSpawnPosition(state.canvas);

      set((state) => {
        if (!state.canvas) return;
        const defaultData = getDefaultNodeData(type, state.language);
        const newNode: CanvasNode = {
          id,
          type,
          position: pos,
          selected: false,
          data: {
            ...defaultData,
            label: defaultData.label || type,
            createdAt: Date.now(),
          } as NodeData,
        };
        state.canvas.nodes.push(newNode);
        state.canvas.updatedAt = Date.now();
        state.selectedNodeIds = [id];
        state.floatingPanel = null;
        state.pendingViewportFocusNodeId = id;
        state.pendingViewportFocusNonce = Date.now();

        pushHistoryEntry(state, getHistoryActionLabel('addNode', state.language));
      });

      return id;
    },

    addConnectedNode: (options) => {
      const state = get();
      const existingIds = new Set(state.canvas?.nodes.map((n) => n.id) ?? []);
      let id = typeof options.nodeId === 'string' && options.nodeId.trim() ? options.nodeId.trim() : uuidv4();
      while (existingIds.has(id)) id = uuidv4();

      const pos = options.position || getViewportAwareSpawnPosition(state.canvas);
      let deferredConnection:
        | { source: string; target: string; sourceHandle?: string; targetHandle?: string }
        | null = null;

      set((draft) => {
        if (!draft.canvas) return;
        const defaultData = getDefaultNodeData(options.type, draft.language);
        const newNode: CanvasNode = {
          id,
          type: options.type,
          position: pos,
          selected: false,
          data: {
            ...defaultData,
            label: defaultData.label || options.type,
            createdAt: Date.now(),
            ...(options.data || {}),
            updatedAt: Date.now(),
          } as NodeData,
        };
        draft.canvas.nodes.push(newNode);

        const sourceId = typeof options.sourceId === 'string' ? options.sourceId.trim() : '';
        if (sourceId) {
          const sourceNode = draft.canvas.nodes.find((node) => node.id === sourceId);
          if (sourceNode) {
            const normalized = normalizeEdgeHandles({
              source: sourceId,
              target: id,
              sourceHandle: options.sourceHandle || undefined,
              targetHandle: options.targetHandle || undefined,
            }, draft.canvas.nodes);
            const pending = shouldDeferEdgeUntilMounted(normalized);
            if (upsertCanvasEdge(draft.canvas.edges, normalized, pending)) {
              draft.canvas.updatedAt = Date.now();
            }
            if (pending) {
              deferredConnection = {
                source: sourceId,
                target: id,
                sourceHandle: normalized.sourceHandle,
                targetHandle: normalized.targetHandle,
              };
            }
          }
        }

        if (options.sourceData?.nodeId) {
          const sourceNode = draft.canvas.nodes.find((node) => node.id === options.sourceData?.nodeId);
          if (sourceNode) {
            const patch = options.sourceData.data || {};
            const shouldRevoke =
              Object.prototype.hasOwnProperty.call(patch, 'outputs') ||
              Object.prototype.hasOwnProperty.call(patch, 'imageUrl') ||
              Object.prototype.hasOwnProperty.call(patch, 'videoUrl');
            if (shouldRevoke) revokeManagedOutputUrls(sourceNode.data);
            sourceNode.data = { ...sourceNode.data, ...patch, updatedAt: Date.now() };
          }
        }

        draft.canvas.updatedAt = Date.now();
        draft.selectionGuardUntil = Date.now() + 180;
        draft.selectedNodeIds = options.select === false ? draft.selectedNodeIds : [id];
        draft.floatingPanel = null;
        draft.pendingViewportFocusNodeId = id;
        draft.pendingViewportFocusNonce = Date.now();

        pushHistoryEntry(draft, getHistoryActionLabel('addNode', draft.language));
      });

      const rawDeferredConnection = deferredConnection as unknown as {
        source: string;
        target: string;
        sourceHandle?: string;
        targetHandle?: string;
      } | null;
      const pendingConnection: {
        source: string;
        target: string;
        sourceHandle?: string;
        targetHandle?: string;
      } | null = rawDeferredConnection
        ? {
            source: rawDeferredConnection.source,
            target: rawDeferredConnection.target,
            sourceHandle: rawDeferredConnection.sourceHandle,
            targetHandle: rawDeferredConnection.targetHandle,
          }
        : null;
      if (pendingConnection) {
        window.setTimeout(() => {
          get().addEdge(pendingConnection.source, pendingConnection.target, {
            sourceHandle: pendingConnection.sourceHandle || null,
            targetHandle: pendingConnection.targetHandle || null,
          });
        }, 0);
      }

      return id;
    },

    updateNodeData: (nodeId, data) => {
      set((state) => {
        if (!state.canvas) return;
        const node = state.canvas.nodes.find((n) => n.id === nodeId);
        if (node) {
          const shouldRevoke =
            Object.prototype.hasOwnProperty.call(data, 'outputs') ||
            Object.prototype.hasOwnProperty.call(data, 'imageUrl') ||
            Object.prototype.hasOwnProperty.call(data, 'videoUrl');
          if (shouldRevoke) revokeManagedOutputUrls(node.data);
          node.data = { ...node.data, ...data, updatedAt: Date.now() };
          state.selectionGuardUntil = Date.now() + 180;
          state.canvas.updatedAt = Date.now();
        }
      });
    },

    removeNode: (nodeId) => {
      clearDeferredEdgesForNode(nodeId);
      set((state) => {
        if (!state.canvas) return;
        const node = state.canvas.nodes.find((item) => item.id === nodeId);
        if (node) revokeManagedOutputUrls(node.data);
        state.canvas.nodes = state.canvas.nodes.filter((n) => n.id !== nodeId);
        state.canvas.edges = state.canvas.edges.filter(
          (e) => e.source !== nodeId && e.target !== nodeId
        );
        state.selectedNodeIds = state.selectedNodeIds.filter((id) => id !== nodeId);
        // Also remove from groups
        state.groups.forEach((g) => {
          g.nodeIds = g.nodeIds.filter((nid) => nid !== nodeId);
        });
        state.canvas.updatedAt = Date.now();

        pushHistoryEntry(state, getHistoryActionLabel('deleteNode', state.language));
      });
    },

    removeNodes: (nodeIds) => {
      const uniqueIds = Array.from(new Set(nodeIds)).filter(Boolean);
      if (uniqueIds.length === 0) return;
      clearAllDeferredEdges();
      set((state) => {
        if (!state.canvas) return;
        const removedIdSet = new Set(uniqueIds);
        const nextEdges = state.canvas.edges.filter((edge) => !removedIdSet.has(edge.source) && !removedIdSet.has(edge.target));
        const removedEdges = state.canvas.edges.filter((edge) => removedIdSet.has(edge.source) || removedIdSet.has(edge.target));
        state.canvas.nodes
          .filter((node) => removedIdSet.has(node.id))
          .forEach((node) => revokeManagedOutputUrls(node.data));
        state.canvas.nodes = state.canvas.nodes.filter((node) => !removedIdSet.has(node.id));
        state.canvas.edges = nextEdges;
        removedEdges.forEach((edge) => {
          cleanupRemovedEdgeBindings(state.canvas!, edge);
          clearDeferredEdgesForNode(edge.source);
          clearDeferredEdgesForNode(edge.target);
        });
        state.selectedNodeIds = state.selectedNodeIds.filter((id) => !removedIdSet.has(id));
        state.groups.forEach((group) => {
          group.nodeIds = group.nodeIds.filter((nodeId) => !removedIdSet.has(nodeId));
        });
        state.canvas.updatedAt = Date.now();
        pushHistoryEntry(state, getHistoryActionLabel('deleteNode', state.language));
      });
    },

    moveNode: (nodeId, position) => {
      set((state) => {
        if (!state.canvas) return;
        const node = state.canvas.nodes.find((n) => n.id === nodeId);
        if (node) {
          node.position = position;
          state.canvas.updatedAt = Date.now();
        }
      });
    },

    moveNodes: (positions) => {
      set((state) => {
        if (!state.canvas) return;
        let changed = false;
        for (const node of state.canvas.nodes) {
          const next = positions[node.id];
          if (!next) continue;
          if (node.position.x !== next.x || node.position.y !== next.y) {
            node.position = next;
            changed = true;
          }
        }
        if (changed) state.canvas.updatedAt = Date.now();
      });
    },

    // Persist move history once a drag operation finishes.
    commitMoveHistory: () => {
      const state = get();
      if (!state.canvas) return;
      set((s) => {
        if (!s.canvas) return;
        pushHistoryEntry(s, getHistoryActionLabel('moveNode', s.language));
      });
    },

    selectNode: (nodeId, multi) => {
      set((state) => {
        if (!state.canvas) return;
        if (multi) {
          if (state.selectedNodeIds.includes(nodeId)) {
            state.selectedNodeIds = state.selectedNodeIds.filter((id) => id !== nodeId);
          } else {
            state.selectedNodeIds.push(nodeId);
          }
        } else {
          state.selectedNodeIds = [nodeId];
        }
        if (state.floatingPanel && !state.selectedNodeIds.includes(state.floatingPanel.nodeId)) {
          state.floatingPanel = null;
        }
      });
    },

    setSelectedNodeIds: (nodeIds) => {
      set((state) => {
        if (!state.canvas) return;
        const uniqueIds = Array.from(new Set(nodeIds)).filter(Boolean);
        if (
          uniqueIds.length === state.selectedNodeIds.length &&
          uniqueIds.every((id, index) => id === state.selectedNodeIds[index])
        ) {
          return;
        }
        state.selectedNodeIds = uniqueIds;
        if (uniqueIds.length === 0) {
          state.floatingPanel = null;
          return;
        }
        if (state.floatingPanel && !uniqueIds.includes(state.floatingPanel.nodeId)) {
          state.floatingPanel = null;
        }
      });
    },

    requestViewportFocus: (nodeId) => {
      set((state) => {
        state.pendingViewportFocusNodeId = nodeId ? String(nodeId) : null;
        state.pendingViewportFocusNonce = Date.now();
      });
    },

    consumeViewportFocus: (nodeId) => {
      set((state) => {
        if (!state.pendingViewportFocusNodeId) return;
        if (nodeId && state.pendingViewportFocusNodeId !== String(nodeId)) return;
        state.pendingViewportFocusNodeId = null;
      });
    },

    openFloatingPanel: (panel) => {
      set((state) => {
        if (
          state.floatingPanel
          && state.floatingPanel.nodeId === panel.nodeId
          && state.floatingPanel.kind === panel.kind
        ) {
          return;
        }
        state.floatingPanel = panel;
      });
    },

    closeFloatingPanel: (nodeId, kind) => {
      set((state) => {
        if (!state.floatingPanel) return;
        if (nodeId && state.floatingPanel.nodeId !== nodeId) return;
        if (kind && state.floatingPanel.kind !== kind) return;
        state.floatingPanel = null;
      });
    },

    deselectAll: () => {
      set((state) => {
        state.selectedNodeIds = [];
        state.floatingPanel = null;
      });
    },

    setSelectionGuard: (durationMs = 220) => {
      set((state) => {
        const nextUntil = Date.now() + Math.max(0, durationMs);
        state.selectionGuardUntil = Math.max(Number(state.selectionGuardUntil || 0), nextUntil);
      });
    },

    addEdge: (source, target, handles) => {
      const state = get();
      if (!state.canvas) return;
      const sourceNode = state.canvas.nodes.find((node) => node.id === source);
      const targetNode = state.canvas.nodes.find((node) => node.id === target);
      if (!sourceNode || !targetNode) {
        return;
      }
      const normalized = normalizeEdgeHandles({
        source,
        target,
        sourceHandle: handles?.sourceHandle || undefined,
        targetHandle: handles?.targetHandle || undefined,
      }, state.canvas.nodes);
      const edgeKey = buildDeferredEdgeKey(normalized);
      const edgeIndex = findEdgeIndex(state.canvas.edges, normalized);
      const existingEdge = edgeIndex >= 0 ? state.canvas.edges[edgeIndex] : undefined;
      const handlesMounted = !shouldDeferEdgeUntilMounted(normalized);
      if (existingEdge && !existingEdge.pending && handlesMounted) {
        clearDeferredEdgeState(edgeKey);
        return;
      }

      const attempt = deferredEdgeAttempts.get(edgeKey) || 0;
      const shouldWaitForLayout = typeof window !== 'undefined' && attempt === 0 && !handlesMounted;
      let scheduledDeferredRetry = false;
      if (shouldWaitForLayout || !handlesMounted) {
        if (attempt < 12 && typeof window !== 'undefined') {
          deferredEdgeAttempts.set(edgeKey, attempt + 1);
          const previousTimer = deferredEdgeTimers.get(edgeKey);
          if (previousTimer) {
            window.clearTimeout(previousTimer);
          }
          const delayMs = shouldWaitForLayout ? 180 : Math.min(40 + attempt * 25, 260);
          const timer = window.setTimeout(() => {
            deferredEdgeTimers.delete(edgeKey);
            const latestState = get();
            if (!latestState.canvas) {
              clearDeferredEdgeState(edgeKey);
              return;
            }
            const sourceStillExists = latestState.canvas.nodes.some((node) => node.id === source);
            const targetStillExists = latestState.canvas.nodes.some((node) => node.id === target);
            if (!sourceStillExists || !targetStillExists) {
              clearDeferredEdgeState(edgeKey);
              return;
            }
            latestState.addEdge(source, target, {
              sourceHandle: normalized.sourceHandle || null,
              targetHandle: normalized.targetHandle || null,
            });
          }, delayMs);
          deferredEdgeTimers.set(edgeKey, timer);
          scheduledDeferredRetry = true;
        }
      }

      if (!scheduledDeferredRetry) {
        clearDeferredEdgeState(edgeKey);
      }
      const enforceSinglePostSource = targetNode.type === 'post' && normalized.targetHandle === 'post-input';
      set((draft) => {
        if (!draft.canvas) return;
        let changed = false;
        if (enforceSinglePostSource) {
          const removedEdges = draft.canvas.edges.filter((edge) => (
            edge.target === normalized.target
            && (edge.targetHandle || '') === (normalized.targetHandle || '')
            && edge.id !== existingEdge?.id
            && edge.source !== normalized.source
          ));
          if (removedEdges.length > 0) {
            draft.canvas.edges = draft.canvas.edges.filter((edge) => !removedEdges.some((removed) => removed.id === edge.id));
            removedEdges.forEach((edge) => {
              cleanupRemovedEdgeBindings(draft.canvas!, edge as CanvasEdge);
            });
            changed = true;
          }
        }
        if (upsertCanvasEdge(draft.canvas.edges, normalized, !handlesMounted)) {
          changed = true;
        }
        if (changed) {
          draft.canvas.updatedAt = Date.now();
        }
      });
    },

    removeEdge: (edgeId) => {
      set((state) => {
        if (!state.canvas) return;
        const edge = state.canvas.edges.find((item) => item.id === edgeId);
        state.canvas.edges = state.canvas.edges.filter((e) => e.id !== edgeId);
        if (edge) cleanupRemovedEdgeBindings(state.canvas, edge);
        state.canvas.updatedAt = Date.now();
      });
    },

    duplicateNode: (nodeId) => {
      const state = get();
      const node = state.canvas?.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const newId = get().addNode(node.type, {
        x: node.position.x + 40,
        y: node.position.y + 40,
      });
      set((s) => {
        const newNode = s.canvas?.nodes.find((n) => n.id === newId);
        if (newNode) {
          newNode.data = { ...node.data };
        }
      });
    },

    undo: (steps = 1) => {
      get().undoSteps(steps);
    },

    undoSteps: (steps: number) => {
      const state = get();
      if (state.historyIndex < 0 || !state.canvas) return;
      const clampedSteps = Math.max(1, Math.min(steps, state.historyIndex + 1));
      const targetIndex = state.historyIndex - clampedSteps;
      const snapshot = state.history[targetIndex];
      if (!snapshot) return;
      set((s) => {
        if (!s.canvas) return;
        s.canvas.nodes = snapshot.nodes.map((n: CanvasNode) => ({ ...n, data: { ...n.data } }));
        s.canvas.edges = snapshot.edges.map((e) => ({ ...e }));
        s.canvas.updatedAt = Date.now();
        s.selectedNodeIds = [...snapshot.selectedNodeIds];
        // 历史快照不记录分组，恢复节点后需把分组对账到当前真实节点，避免 phantom ID。
        s.groups = pruneGroupsToLiveNodes(s.groups, new Set(s.canvas.nodes.map((node) => node.id)));
        s.historyIndex = targetIndex;
      });
    },

    redo: (steps = 1) => {
      const state = get();
      const maxIndex = state.history.length - 1;
      if (state.historyIndex >= maxIndex || !state.canvas) return;
      const clampedSteps = Math.max(1, Math.min(steps, maxIndex - state.historyIndex));
      const targetIndex = state.historyIndex + clampedSteps;
      const snapshot = state.history[targetIndex];
      if (!snapshot) return;
      set((s) => {
        if (!s.canvas) return;
        s.canvas.nodes = snapshot.nodes.map((n: CanvasNode) => ({ ...n, data: { ...n.data } }));
        s.canvas.edges = snapshot.edges.map((e) => ({ ...e }));
        s.canvas.updatedAt = Date.now();
        s.selectedNodeIds = [...snapshot.selectedNodeIds];
        s.groups = pruneGroupsToLiveNodes(s.groups, new Set(s.canvas.nodes.map((node) => node.id)));
        s.historyIndex = targetIndex;
      });
    },

    clearHistory: () => {
      set((s) => {
        if (!s.canvas) return;
        // Roll the canvas back to the earliest recorded state (history[0]) so the
        // cleared history and the live canvas stay consistent. If no history exists,
        // just reset the index.
        if (s.history.length > 0 && s.history[0]) {
          const snap = s.history[0];
          s.canvas.nodes = snap.nodes.map((n: CanvasNode) => ({ ...n, data: { ...n.data } }));
          s.canvas.edges = snap.edges.map((e) => ({ ...e }));
          s.canvas.updatedAt = Date.now();
          s.selectedNodeIds = [...snap.selectedNodeIds];
          s.groups = pruneGroupsToLiveNodes(s.groups, new Set(s.canvas.nodes.map((node) => node.id)));
        }
        s.history = [];
        s.historyIndex = -1;
      });
    },

    setGenerating: (nodeId, isGenerating) => {
      set((state) => {
        if (isGenerating) {
          state.generatingNodes.add(nodeId);
        } else {
          state.generatingNodes.delete(nodeId);
        }
      });
    },

    addOutput: (nodeId, output) => {
      set((state) => {
        if (!state.canvas) return;
        const node = state.canvas.nodes.find((n) => n.id === nodeId);
        if (node) {
          if (!node.data.outputs) node.data.outputs = [];
          node.data.outputs.push(output);
          node.data.status = 'completed';
          node.data.updatedAt = Date.now();
        }
      });
    },

    setSidebarTab: (tab) => {
      set((state) => {
        state.activeSidebarTab = tab;
      });
    },

    openImportWorkflow: () => set((state) => { state.importWorkflowOpen = true; }),
    closeImportWorkflow: () => set((state) => { state.importWorkflowOpen = false; }),

    toggleSidebar: () => {
      set((state) => {
        state.sidebarCollapsed = !state.sidebarCollapsed;
      });
    },

    toggleAIPanel: () => {
      set((state) => {
        state.showAIPanel = !state.showAIPanel;
      });
    },

    toggleAssetPanel: () => {
      set((state) => {
        state.showAssetPanel = !state.showAssetPanel;
      });
    },

    toggleDarkMode: () => {
      set((state) => {
        state.darkMode = !state.darkMode;
      });
    },

    setShowShortcuts: (show) => {
      set((state) => {
        state.showShortcuts = show;
      });
    },

    setLanguage: (lang) => {
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(CANVAS_LANGUAGE_EXPLICIT_KEY, lang);
        } catch {
          // Ignore localStorage write issues and keep runtime state intact.
        }
      }
      set((state) => {
        const previousDefaults = DEFAULT_ASSET_CATEGORIES[state.language];
        state.language = lang;
        const nextDefaults = DEFAULT_ASSET_CATEGORIES[lang];
        if (
          state.assetCategories.length === previousDefaults.length &&
          state.assetCategories.every((item, index) => item === previousDefaults[index])
        ) {
          state.assetCategories = [...nextDefaults];
        }
      });
    },

    addAsset: (asset) => {
      set((state) => {
        state.assets.push(asset);
      });
    },

    removeAsset: (assetId) => {
      set((state) => {
        state.assets = state.assets.filter((a) => a.id !== assetId);
      });
    },

    exportCanvas: () => {
      const state = get();
      return safeSerializeCanvas(state.canvas);
    },

    importCanvas: (json) => {
      const result = safeDeserializeCanvas(json);
      if (!result.success) {
        console.error('Failed to import canvas:', result.errors);
        return;
      }
      clearAllDeferredEdges();
      const canvas = result.data as Canvas;
      const normalizedCanvas: Canvas = {
        ...canvas,
        edges: normalizeCanvasEdges(canvas.edges, canvas.nodes),
      };
      set((state) => {
        state.canvas = normalizedCanvas;
        // 导入的画布是独立文档（当前模型下不含分组），重置分组避免旧分组残留 phantom ID。
        state.groups = pruneGroupsToLiveNodes(state.groups, new Set(normalizedCanvas.nodes.map((node) => node.id)));
        state.selectedNodeIds = [];
      });
    },

    // ===== Workflows =====
    saveWorkflow: (name, description, color) => {
      const state = get();
      if (!state.canvas) return;
      const selected = new Set(state.selectedNodeIds);
      const nodesToSave = selected.size > 0
        ? state.canvas.nodes.filter((node) => selected.has(node.id))
        : state.canvas.nodes;
      const nodeIds = new Set(nodesToSave.map((node) => node.id));
      const edgesToSave = state.canvas.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
      set((s) => {
        const workflowNodes = nodesToSave.map((n) => ({ ...n, data: { ...n.data } }));
        const wf: Workflow = {
          id: uuidv4(),
          name,
          description,
          nodes: workflowNodes,
          edges: normalizeCanvasEdges(edgesToSave.map((e) => ({ ...e })), workflowNodes),
          color: color || '#00d4aa',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        s.workflows.push(wf);
      });
    },

    deleteWorkflow: (workflowId) => {
      set((state) => {
        state.workflows = state.workflows.filter((w) => w.id !== workflowId);
      });
    },

    loadWorkflow: (workflowId) => {
      const wf = get().workflows.find((w) => w.id === workflowId);
      if (!wf) return;
      clearAllDeferredEdges();
      set((state) => {
        // Create new canvas with workflow data
        const offset = { x: 50, y: 50 };
        const workflowNodes = wf.nodes.map((n) => ({
          ...n,
          position: { x: n.position.x + offset.x, y: n.position.y + offset.y },
        }));
        state.canvas = {
          ...state.canvas!,
          nodes: workflowNodes,
          edges: normalizeCanvasEdges(wf.edges.map((e) => ({ ...e })), workflowNodes),
          updatedAt: Date.now(),
        };
        // 工作流载入替换了画布节点，旧分组里指向被替换节点的 id 失效，需对账。
        state.groups = pruneGroupsToLiveNodes(state.groups, new Set(workflowNodes.map((node) => node.id)));
        state.selectedNodeIds = [];
      });
    },

    renameWorkflow: (workflowId, newName) => {
      set((state) => {
        const wf = state.workflows.find((w) => w.id === workflowId);
        if (wf) {
          wf.name = newName;
          wf.updatedAt = Date.now();
        }
      });
    },

    // ===== Node Groups =====
    createGroup: (nodeIds, name, color) => {
      const id = uuidv4();
      set((state) => {
        state.groups.forEach((group) => {
          group.nodeIds = group.nodeIds.filter((nodeId) => !nodeIds.includes(nodeId));
        });
        state.groups.push({
          id,
          name,
          color,
          nodeIds: Array.from(new Set(nodeIds)),
          createdAt: Date.now(),
        });
      });
      return id;
    },

    deleteGroup: (groupId) => {
      set((state) => {
        state.groups = state.groups.filter((g) => g.id !== groupId);
      });
    },

    ungroup: (groupId) => {
      set((state) => {
        state.groups = state.groups.filter((g) => g.id !== groupId);
      });
    },

    renameGroup: (groupId, newName) => {
      set((state) => {
        const group = state.groups.find((g) => g.id === groupId);
        if (group) group.name = newName;
      });
    },

    updateGroupColor: (groupId, color) => {
      set((state) => {
        const group = state.groups.find((g) => g.id === groupId);
        if (group) group.color = color;
      });
    },

    addNodesToGroup: (groupId, nodeIds) => {
      set((state) => {
        const target = state.groups.find((g) => g.id === groupId);
        if (!target) return;
        // 防御性过滤：只接受画布上真实存在的节点，避免把已删除/不存在的 id 写入
        // group.nodeIds 产生 phantom ID（导致小窗口计数与主画布不一致）。
        const liveNodeIds = state.canvas ? new Set(state.canvas.nodes.map((node) => node.id)) : new Set<string>();
        const validNodeIds = nodeIds.filter((id) => liveNodeIds.has(id));
        if (validNodeIds.length === 0) return;
        state.groups.forEach((group) => {
          if (group.id !== groupId) group.nodeIds = group.nodeIds.filter((nodeId) => !validNodeIds.includes(nodeId));
        });
        target.nodeIds = Array.from(new Set([...target.nodeIds, ...validNodeIds]));
      });
    },

    removeNodesFromGroup: (groupId, nodeIds) => {
      set((state) => {
        const group = state.groups.find((g) => g.id === groupId);
        if (group) group.nodeIds = group.nodeIds.filter((nodeId) => !nodeIds.includes(nodeId));
      });
    },

    arrangeGroup: (groupId, mode) => {
      const state = get();
      const group = state.groups.find((g) => g.id === groupId);
      const nodes = state.canvas?.nodes.filter((node) => group?.nodeIds.includes(node.id)) || [];
      if (!group || nodes.length === 0) return;
      const left = Math.min(...nodes.map((node) => node.position.x));
      const top = Math.min(...nodes.map((node) => node.position.y));
      const gapX = 600;
      const gapY = 380;
      const cols = mode === 'grid' ? Math.ceil(Math.sqrt(nodes.length)) : nodes.length;
      const positions: Record<string, { x: number; y: number }> = {};
      nodes.forEach((node, index) => {
        const col = mode === 'vertical' ? 0 : mode === 'horizontal' ? index : index % cols;
        const row = mode === 'horizontal' ? 0 : mode === 'vertical' ? index : Math.floor(index / cols);
        positions[node.id] = { x: left + col * gapX, y: top + row * gapY };
      });
      get().moveNodes(positions);
      get().commitMoveHistory();
    },

    getSelectedNodes: () => {
      const state = get();
      return state.canvas?.nodes.filter((n) => state.selectedNodeIds.includes(n.id)) || [];
    },

    getNodeById: (id) => {
      return get().canvas?.nodes.find((n) => n.id === id);
    },

    getNodesInGroup: (groupId) => {
      const state = get();
      const group = state.groups.find((g) => g.id === groupId);
      if (!group) return [];
      return state.canvas?.nodes.filter((n) => group.nodeIds.includes(n.id)) || [];
    },

    // ===== Agentic Workflow =====
    createWorkflowFromPlan: async (plan: WorkflowPlan) => {
      const createdNodeIds: string[] = [];
      try {
        // Phase 1: Create all nodes
        for (let i = 0; i < plan.steps.length; i++) {
          const step = plan.steps[i];
          const nodeId = get().addNode(step.type, step.position);
          if (!nodeId) throw new Error(`Failed to create node at step ${i}`);

          // Apply custom data if provided
          if (step.data) {
            get().updateNodeData(nodeId, step.data);
          }
          // 回填手动参考输入的 sourceNodeId：规划期无法预知节点 id，而
          // collectConnectedReferenceInputs 要求手动输入 sourceNodeId 非空才会被识别为可用主输入。
          // 这里把空 sourceNodeId 的手动输入绑定到本节点自身，使智能体创建的媒体节点能正确以附件为主输入。
          const rawInputs = (step.data as { inputs?: unknown } | undefined)?.inputs;
          if (Array.isArray(rawInputs)) {
            const normalized = (rawInputs as Array<Record<string, unknown>>).map((inp) => ({
              ...inp,
              sourceNodeId:
                typeof inp.sourceNodeId === 'string' && inp.sourceNodeId ? inp.sourceNodeId : nodeId,
            }));
            get().updateNodeData(nodeId, { inputs: normalized } as Partial<NodeData>);
          }
          createdNodeIds.push(nodeId);
        }

        // Phase 2: Create connections
        for (const conn of plan.connections) {
          const sourceId = createdNodeIds[conn.from];
          const targetId = createdNodeIds[conn.to];
          if (sourceId && targetId) {
            get().addEdge(sourceId, targetId);
          }
        }

        // Phase 3: Auto-group the workflow nodes
        if (createdNodeIds.length > 1) {
          get().createGroup(createdNodeIds, plan.name, '#00d4aa');
        }

        return { success: true, nodeIds: createdNodeIds };
      } catch (error) {
        // Rollback on failure
        console.error('Workflow creation failed:', error);
        get().rollbackWorkflow(createdNodeIds);
        return {
          success: false,
          nodeIds: createdNodeIds,
          error: error instanceof Error ? error.message : '鏈煡閿欒',
        };
      }
    },

    rollbackWorkflow: (nodeIds: string[]) => {
      nodeIds.forEach((id) => {
        get().removeNode(id);
      });
    },
    })),
    {
      name: 'hmdao-canvas-store',
      version: 2,
      // 旧版本（无 version，视为 0）的持久化画布可能包含指向已删除素材的孤儿引用
      // （如 /api/assets/content/<id> 反复 404）。新建工程时这些旧画布数据应丢弃，
      // 回退到初始空白画布，避免控制台刷 404 与潜在崩溃。
      migrate: (persisted, version) => {
        const p = (persisted && typeof persisted === 'object' ? persisted : {}) as Record<string, unknown>;
        if (version < 1) {
          delete p.canvas;
          return p;
        }
        // v2：一次性清理历史节点里不可渲染的死引用（裸 UUID / 已删除素材 ID）。
        // 这类值每次加载都会发起注定 404 的请求，且不会自行消失，必须在迁移阶段修掉。
        if (version < 2) {
          const canvas = p.canvas as { nodes?: Array<{ data?: Record<string, unknown> }> } | undefined;
          if (canvas && Array.isArray(canvas.nodes)) {
            canvas.nodes = canvas.nodes.map((node) => {
              const data = node?.data;
              if (!data || typeof data !== 'object') return node;
              const next = { ...data };
              if ('imageUrl' in next && !isRenderableAssetUrl(next.imageUrl)) next.imageUrl = '';
              if ('videoUrl' in next && !isRenderableAssetUrl(next.videoUrl)) next.videoUrl = '';
              return { ...node, data: next };
            });
          }
        }
        return p;
      },
      partialize: (state) => ({
        canvas: state.canvas
          ? {
              ...state.canvas,
              nodes: state.canvas.nodes.map((node) => ({
                ...node,
                data: sanitizePersistedNodeData(node.data),
                selected: false,
              })),
              edges: normalizeCanvasEdges(state.canvas.edges, state.canvas.nodes),
            }
          : state.canvas,
        selectedNodeIds: [],
        zoom: state.zoom,
        activeSidebarTab: state.activeSidebarTab,
        sidebarCollapsed: state.sidebarCollapsed,
        showAIPanel: state.showAIPanel,
        showAssetPanel: state.showAssetPanel,
        showTemplatePanel: state.showTemplatePanel,
        showSettings: state.showSettings,
        showShortcuts: state.showShortcuts,
        darkMode: state.darkMode,
        language: state.language,
        assets: state.assets,
        assetCategories: state.assetCategories,
        workflows: state.workflows,
        groups: state.groups,
        apiKeys: state.apiKeys,
        defaultProviders: state.defaultProviders,
      }),
      merge: (persisted, current) => {
        const next = {
          ...current,
          ...(persisted || {}),
        } as typeof current;
        let explicitLanguage = '';
        if (typeof window !== 'undefined') {
          try {
            explicitLanguage = String(window.localStorage.getItem(CANVAS_LANGUAGE_EXPLICIT_KEY) || '').trim().toLowerCase();
          } catch {
            explicitLanguage = '';
          }
        }
        next.language = explicitLanguage === 'en' || explicitLanguage === 'zh'
          ? explicitLanguage
          : 'zh';
        if (next.canvas?.nodes?.length) {
          next.canvas = {
            ...next.canvas,
            nodes: next.canvas.nodes.map((node) => ({
              ...node,
              data: migratePersistedNodeData(node.data, node.type),
              selected: false,
            })),
          };
          next.canvas.edges = normalizeCanvasEdges(next.canvas.edges, next.canvas.nodes);
        }
        // 防御性对账：rehydrate 时剔除 groups.nodeIds 中已不存在的 phantom ID，
        // 避免 localStorage 旧数据导致小窗口（chip）节点数与主画布不一致。
        if (Array.isArray(next.groups) && next.canvas?.nodes) {
          const liveNodeIds = new Set(next.canvas.nodes.map((node) => node.id));
          let groupsMutated = false;
          next.groups = next.groups
            .map((group) => {
              if (!group || !Array.isArray(group.nodeIds)) return group;
              const filtered = group.nodeIds.filter((id) => liveNodeIds.has(id));
              if (filtered.length === group.nodeIds.length) return group;
              groupsMutated = true;
              return { ...group, nodeIds: filtered };
            })
            .filter((group) => {
              if (!group) return false;
              if (group.nodeIds.length === 0) {
                groupsMutated = true;
                return false;
              }
              return true;
            });
          if (groupsMutated) {
            // 标记需要持久化（zustand persist 中间件会基于引用变化判定）
            next.groups = [...next.groups];
          }
        }
        const persistedRecord = persisted && typeof persisted === 'object' ? persisted as { workflows?: unknown } : {};
        next.workflows = ensureBuiltinWorkflows(Array.isArray(persistedRecord.workflows) ? persistedRecord.workflows : current.workflows);
        return next;
      },
    },
  )
);





