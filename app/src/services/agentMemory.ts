import { useEffect, useMemo, useState } from 'react';
import type { NodeType, WorkflowMemoryReference, WorkflowPlan } from '@/types';

export type AgentMemoryLayer = 'role' | 'brand' | 'style' | 'workflow';

export interface SharedAgentMemory {
  id: string;
  layer: AgentMemoryLayer;
  title: string;
  summary: string;
  tags: string[];
  promptSample: string;
  routeName: string;
  linkedSkillId: string;
  nodeTypes: NodeType[];
  sourceTraceId: string | undefined;
  sourceTemplateId: string | undefined;
  updatedAt: number;
}

export interface AgentMemoryTraceSeed {
  traceId: string;
  templateId: string;
  input: string;
  planName: string;
  skillId: string;
  skillName: string;
  routeName: string;
  planSnapshot: WorkflowPlan;
}

export interface SharedMemorySuggestion {
  memory: SharedAgentMemory;
  layer: AgentMemoryLayer;
  score: number;
  reason: string;
}

const MEMORY_STORAGE_KEY = 'hmdao-smart-agent-memory';
const MEMORY_EVENT_NAME = 'hmdao-agent-memory-updated';
const MAX_MEMORY_ITEMS = 24;

const LAYER_LABELS: Record<AgentMemoryLayer, string> = {
  role: '角色',
  brand: '品牌',
  style: '风格',
  workflow: '链路',
};

const LAYER_PRIORITY: Record<NodeType, AgentMemoryLayer[]> = {
  image: ['style', 'role', 'brand', 'workflow'],
  video: ['role', 'style', 'workflow', 'brand'],
  post: ['style', 'brand', 'workflow', 'role'],
  audio: ['workflow', 'brand', 'style', 'role'],
  text: ['workflow', 'brand', 'role', 'style'],
  script: ['workflow', 'brand', 'role', 'style'],
  storyboard: ['workflow', 'style', 'role', 'brand'],
  aiapp: ['workflow', 'brand', 'style', 'role'],
  threed: ['role', 'workflow', 'style', 'brand'],
  dcc: ['workflow', 'style', 'role', 'brand'],
  region: ['workflow', 'style', 'role', 'brand'],
  comfyui: ['workflow', 'style', 'role', 'brand'],
};

function tokenize(input: string) {
  return Array.from(new Set(
    input
      .toLowerCase()
      .split(/[\s,.;:!?/\\|()[\]{}"'`~@#$%^&*+=<>，。！？；：、\r\n\t]+/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2)
      .slice(0, 18),
  ));
}

function compactText(input: string, limit = 84) {
  const normalized = input.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1)}…`;
}

function normalizeNodeTypes(value: unknown): NodeType[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  )) as NodeType[];
}

function normalizeLayer(value: unknown): AgentMemoryLayer {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'role' || raw === 'brand' || raw === 'style' || raw === 'workflow') return raw;
  if (raw === 'character') return 'role';
  return 'workflow';
}

function readStorage() {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(MEMORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown[];
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item, index) => {
      const source = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      const title = String(source.title || '').trim();
      const promptSample = String(source.promptSample || '').trim();
      return {
        id: typeof source.id === 'string' && source.id.trim() ? source.id : `memory-${Date.now()}-${index}`,
        layer: normalizeLayer(source.layer ?? source.kind),
        title: title || '共享记忆',
        summary: String(source.summary || '').trim() || promptSample || '暂无摘要',
        tags: Array.isArray(source.tags) ? source.tags.map((tag) => String(tag || '').trim()).filter(Boolean).slice(0, 8) : [],
        promptSample,
        routeName: String(source.routeName || '').trim(),
        linkedSkillId: String(source.linkedSkillId || '').trim(),
        nodeTypes: normalizeNodeTypes(source.nodeTypes),
        sourceTraceId: typeof source.sourceTraceId === 'string' ? source.sourceTraceId : undefined,
        sourceTemplateId: typeof source.sourceTemplateId === 'string' ? source.sourceTemplateId : undefined,
        updatedAt: Number(source.updatedAt) || Date.now(),
      } satisfies SharedAgentMemory;
    });
  } catch {
    return [];
  }
}

function emitMemoryUpdate(memories: SharedAgentMemory[]) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(MEMORY_EVENT_NAME, { detail: memories }));
}

function writeStorage(memories: SharedAgentMemory[]) {
  if (typeof window === 'undefined') return memories;
  const next = memories.slice(0, MAX_MEMORY_ITEMS);
  window.localStorage.setItem(MEMORY_STORAGE_KEY, JSON.stringify(next));
  emitMemoryUpdate(next);
  return next;
}

function inferLayers(seed: AgentMemoryTraceSeed, nodeTypes: NodeType[]) {
  const text = `${seed.planName} ${seed.skillName} ${seed.input}`.toLowerCase();
  const layers = new Set<AgentMemoryLayer>(['workflow']);
  if (/(角色|人物|主角|主体|模特|演员|肖像|ip|character|subject|hero)/i.test(text)) layers.add('role');
  if (/(品牌|logo|vi|campaign|企业|店铺|brand)/i.test(text) || seed.skillId === 'brand') layers.add('brand');
  if (
    /(风格|海报|光影|氛围|色调|构图|镜头|质感|写实|动漫|胶片|插画|style|look|lighting|mood|poster)/i.test(text)
    || nodeTypes.includes('image')
    || nodeTypes.includes('post')
    || nodeTypes.includes('video')
  ) {
    layers.add('style');
  }
  return Array.from(layers);
}

function summarizeLayer(seed: AgentMemoryTraceSeed, layer: AgentMemoryLayer, nodeTypes: NodeType[]) {
  const promptBrief = compactText(seed.input, 72);
  if (layer === 'workflow') {
    return `${seed.routeName} · ${seed.skillName} · ${nodeTypes.join(' / ') || 'workflow'} · ${seed.planSnapshot.steps.length} 步`;
  }
  if (layer === 'brand') {
    return `品牌调性与交付口径：${promptBrief}`;
  }
  if (layer === 'style') {
    return `风格、光影、构图与观感线索：${promptBrief}`;
  }
  return `角色/主体一致性线索：${promptBrief}`;
}

function buildLayerTitle(seed: AgentMemoryTraceSeed, layer: AgentMemoryLayer) {
  return `${LAYER_LABELS[layer]}记忆 · ${seed.planName}`;
}

export function buildMemoriesFromTrace(seed: AgentMemoryTraceSeed): SharedAgentMemory[] {
  const nodeTypes = Array.from(new Set(seed.planSnapshot.steps.map((step) => step.type)));
  const tags = Array.from(new Set([seed.skillName, ...tokenize(seed.input)])).slice(0, 8);
  return inferLayers(seed, nodeTypes).map((layer, index) => ({
    id: `${seed.traceId}:${layer}:${index}`,
    layer,
    title: buildLayerTitle(seed, layer),
    summary: summarizeLayer(seed, layer, nodeTypes),
    tags,
    promptSample: compactText(seed.input, 160),
    routeName: seed.routeName,
    linkedSkillId: seed.skillId,
    nodeTypes,
    sourceTraceId: seed.traceId,
    sourceTemplateId: seed.templateId,
    updatedAt: Date.now(),
  }));
}

export function rememberAgentTraceRun(seed: AgentMemoryTraceSeed) {
  const memories = buildMemoriesFromTrace(seed);
  const existing = readStorage();
  const inserted: SharedAgentMemory[] = [];
  const updated: SharedAgentMemory[] = [];
  const next = [...existing];

  for (const candidate of memories) {
    const duplicate = next.find((item) =>
      item.layer === candidate.layer
      && item.title === candidate.title
      && item.promptSample === candidate.promptSample
      && item.routeName === candidate.routeName,
    );
    if (duplicate) {
      const merged = {
        ...duplicate,
        summary: candidate.summary,
        tags: Array.from(new Set([...duplicate.tags, ...candidate.tags])).slice(0, 8),
        nodeTypes: Array.from(new Set([...duplicate.nodeTypes, ...candidate.nodeTypes])) as NodeType[],
        linkedSkillId: candidate.linkedSkillId,
        sourceTraceId: candidate.sourceTraceId,
        sourceTemplateId: candidate.sourceTemplateId,
        updatedAt: Date.now(),
      };
      const duplicateIndex = next.findIndex((item) => item.id === duplicate.id);
      next.splice(duplicateIndex, 1, merged);
      updated.push(merged);
      continue;
    }
    next.unshift(candidate);
    inserted.push(candidate);
  }

  const persisted = writeStorage(next.sort((left, right) => right.updatedAt - left.updatedAt));
  return { inserted, updated, nextGraph: persisted };
}

export function readSharedAgentMemories() {
  return readStorage();
}

export function resolveSharedAgentMemories(ids: string[]) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const wanted = new Set(ids.map((item) => String(item || '').trim()).filter(Boolean));
  if (!wanted.size) return [];
  return readStorage().filter((memory) => wanted.has(memory.id));
}

export function serializeSharedMemoryReferences(memories: SharedAgentMemory[]): WorkflowMemoryReference[] {
  return memories.map((memory) => ({
    id: memory.id,
    layer: memory.layer,
    title: memory.title,
    summary: memory.summary,
    routeName: memory.routeName,
    linkedSkillId: memory.linkedSkillId,
    nodeTypes: [...memory.nodeTypes],
    tags: [...memory.tags],
    sourceTraceId: memory.sourceTraceId,
    sourceTemplateId: memory.sourceTemplateId,
    updatedAt: memory.updatedAt,
  }));
}

function computeSuggestionScore(memory: SharedAgentMemory, promptTokens: string[], nodeType: NodeType) {
  const haystack = `${memory.title} ${memory.summary} ${memory.tags.join(' ')} ${memory.promptSample}`.toLowerCase();
  const overlap = promptTokens.reduce((score, token) => (haystack.includes(token) ? score + 16 : score), 0);
  const nodeTypeBoost = memory.nodeTypes.includes(nodeType) ? 18 : 0;
  const layerPriority = LAYER_PRIORITY[nodeType]?.indexOf(memory.layer) ?? 3;
  const layerBoost = Math.max(0, 10 - layerPriority * 2);
  const freshnessBoost = Math.max(0, 8 - Math.floor((Date.now() - memory.updatedAt) / 86400000));
  return overlap + nodeTypeBoost + layerBoost + freshnessBoost;
}

export function getSharedMemorySuggestions(params: {
  prompt: string;
  nodeType: NodeType;
  limit?: number;
}) {
  const { prompt, nodeType, limit = 6 } = params;
  const tokens = tokenize(prompt);
  const memories = readStorage();
  const ranked = memories
    .map((memory) => {
      const score = computeSuggestionScore(memory, tokens, nodeType);
      return {
        memory,
        layer: memory.layer,
        score,
        reason: memory.nodeTypes.includes(nodeType)
          ? `与当前${nodeType}节点直接相关`
          : `可复用${LAYER_LABELS[memory.layer]}上下文`,
      } satisfies SharedMemorySuggestion;
    })
    .filter((item) => item.score > 0 || item.memory.nodeTypes.includes(nodeType))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);

  const grouped = (['role', 'brand', 'style', 'workflow'] as AgentMemoryLayer[]).map((layer) => ({
    layer,
    items: ranked.filter((item) => item.layer === layer).slice(0, 2),
  })).filter((group) => group.items.length > 0);

  return { ranked, grouped };
}

export function useSharedAgentMemoryGraph() {
  const [memoryGraph, setMemoryGraph] = useState<SharedAgentMemory[]>(() => readStorage());

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const sync = (event?: Event) => {
      const detail = event && 'detail' in event ? (event as CustomEvent<SharedAgentMemory[]>).detail : null;
      setMemoryGraph(Array.isArray(detail) ? detail : readStorage());
    };
    window.addEventListener(MEMORY_EVENT_NAME, sync as EventListener);
    window.addEventListener('storage', sync as EventListener);
    return () => {
      window.removeEventListener(MEMORY_EVENT_NAME, sync as EventListener);
      window.removeEventListener('storage', sync as EventListener);
    };
  }, []);

  return useMemo(() => memoryGraph, [memoryGraph]);
}
