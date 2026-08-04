/**
 * agentLongTermMemory.ts
 *
 * 单一职责：SmartAgent「长期记忆」（role/brand/style/workflow 四层）与后端持久化同步。
 * - 后端 /api/agent/memory 为权威源（跨会话/跨端持久）。
 * - localStorage 作为离线兜底，避免后端不可用（如本地未起服务）时无法工作。
 * - 所有写操作双写（后端 + localStorage）；读操作优先后端，失败回退 localStorage。
 */

export type LongTermMemoryLayer = 'role' | 'brand' | 'style' | 'workflow';

export interface LongTermMemory {
  role: string;
  brand: string;
  style: string;
  workflow: string;
}

const STORAGE_KEY = 'hmdao-agent-longterm-memory';
const LAYERS: LongTermMemoryLayer[] = ['role', 'brand', 'style', 'workflow'];

export function emptyLongTermMemory(): LongTermMemory {
  return { role: '', brand: '', style: '', workflow: '' };
}

function readLocal(): LongTermMemory {
  if (typeof window === 'undefined') return emptyLongTermMemory();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyLongTermMemory();
    const obj = JSON.parse(raw) as Partial<LongTermMemory>;
    return {
      role: typeof obj.role === 'string' ? obj.role : '',
      brand: typeof obj.brand === 'string' ? obj.brand : '',
      style: typeof obj.style === 'string' ? obj.style : '',
      workflow: typeof obj.workflow === 'string' ? obj.workflow : '',
    };
  } catch {
    return emptyLongTermMemory();
  }
}

function writeLocal(memory: LongTermMemory) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(memory));
}

async function fetchMemory(): Promise<LongTermMemory> {
  const resp = await fetch('/api/agent/memory?scope=global', { headers: { Accept: 'application/json' } });
  if (!resp.ok) throw new Error('读取记忆失败：' + resp.status);
  const data = await resp.json();
  const mem = (data && data.memory) || {};
  return {
    role: typeof mem.role === 'string' ? mem.role : '',
    brand: typeof mem.brand === 'string' ? mem.brand : '',
    style: typeof mem.style === 'string' ? mem.style : '',
    workflow: typeof mem.workflow === 'string' ? mem.workflow : '',
  };
}

/** 读取长期记忆：优先后端，失败回退本地缓存。 */
export async function loadLongTermMemory(): Promise<LongTermMemory> {
  try {
    const remote = await fetchMemory();
    writeLocal(remote);
    return remote;
  } catch {
    return readLocal();
  }
}

/** 全量写入：双写到后端与本地。 */
export async function saveLongTermMemory(memory: LongTermMemory): Promise<LongTermMemory> {
  writeLocal(memory);
  try {
    const resp = await fetch('/api/agent/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'global', memory }),
    });
    if (!resp.ok) throw new Error('写入记忆失败：' + resp.status);
    const data = await resp.json();
    if (data && data.memory) return data.memory as LongTermMemory;
  } catch {
    /* 离线：仅写本地 */
  }
  return memory;
}

/** 单条清空：后端 DELETE，本地同步。 */
export async function clearLongTermMemoryLayer(layer: LongTermMemoryLayer): Promise<LongTermMemory> {
  const current = readLocal();
  current[layer] = '';
  writeLocal(current);
  try {
    const resp = await fetch('/api/agent/memory', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'global', type: layer }),
    });
    if (!resp.ok) throw new Error('清空记忆失败：' + resp.status);
  } catch {
    /* 离线：仅本地 */
  }
  return current;
}

export const LONG_TERM_MEMORY_LAYERS = LAYERS;
