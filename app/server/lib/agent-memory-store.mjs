/**
 * agent-memory-store.mjs
 *
 * 单一职责：SmartAgent 记忆的持久化存储。
 * - 以 JSON 文件持久化到 DATA_DIR，进程重启不丢失（跨会话/跨端持久）。
 * - 按 scope（如 'global'、'user:<id>'、'session:<id>'）隔离。
 * - 每种 memory 类型（role/brand/style/workflow）独立读写。
 * 不依赖任何业务逻辑，仅提供纯数据 CRUD。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const APP_DIR = path.resolve(process.cwd(), 'app');
const DATA_DIR = process.env.HMDAO_DATA_DIR
  || path.resolve(APP_DIR, '.hmdao-data');
const STORE_FILE = path.join(DATA_DIR, 'agent-memory.json');

const VALID_MEMORY_TYPES = ['role', 'brand', 'style', 'workflow'];

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) {
    fs.writeFileSync(STORE_FILE, JSON.stringify({ scopes: {} }, null, 2), 'utf8');
  }
}

function readStore() {
  ensureStore();
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.scopes) return { scopes: {} };
    return parsed;
  } catch {
    return { scopes: {} };
  }
}

function writeStore(store) {
  ensureStore();
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), 'utf8');
}

function normalizeScope(scope) {
  if (!scope || typeof scope !== 'string') return 'global';
  const s = scope.trim().toLowerCase();
  return s || 'global';
}

function normalizeType(type) {
  return VALID_MEMORY_TYPES.includes(type) ? type : null;
}

/**
 * 读取某 scope 下所有记忆。
 * @returns {{role:string,brand:string,style:string,workflow:string}}
 */
export function getMemory(scope = 'global') {
  const s = normalizeScope(scope);
  const store = readStore();
  const entry = store.scopes[s];
  return {
    role: entry?.role || '',
    brand: entry?.brand || '',
    style: entry?.style || '',
    workflow: entry?.workflow || '',
  };
}

/**
 * 写入某条记忆。
 * @param {{type:string, content:string, scope?:string}} input
 */
export function setMemory({ type, content, scope = 'global' }) {
  const t = normalizeType(type);
  if (!t) throw new Error('无效的记忆类型：' + type);
  const s = normalizeScope(scope);
  const value = typeof content === 'string' ? content : '';
  const store = readStore();
  if (!store.scopes[s]) store.scopes[s] = {};
  store.scopes[s][t] = {
    content: value,
    updatedAt: new Date().toISOString(),
  };
  writeStore(store);
  return { type: t, scope: s, content: value };
}

/**
 * 批量写入（用于一次性同步整个 memory 对象）。
 * @param {{role?:string,brand?:string,style?:string,workflow?:string,scope?:string}} input
 */
export function setAllMemory({ role = '', brand = '', style = '', workflow = '', scope = 'global' } = {}) {
  const s = normalizeScope(scope);
  const store = readStore();
  if (!store.scopes[s]) store.scopes[s] = {};
  const now = new Date().toISOString();
  for (const t of VALID_MEMORY_TYPES) {
    const v = String(arguments[0]?.[t] ?? '');
    if (v) store.scopes[s][t] = { content: v, updatedAt: now };
  }
  writeStore(store);
  return getMemory(s);
}

/**
 * 删除某条记忆（清空该类型）。
 * @param {{type:string, scope?:string}} input
 */
export function deleteMemory({ type, scope = 'global' }) {
  const t = normalizeType(type);
  if (!t) throw new Error('无效的记忆类型：' + type);
  const s = normalizeScope(scope);
  const store = readStore();
  if (store.scopes[s]?.[t]) delete store.scopes[s][t];
  writeStore(store);
  return { type: t, scope: s };
}

/**
 * 返回给前端/智能体的精简上下文字符串（仅包含非空项）。
 */
export function memoryContextString(scope = 'global') {
  const m = getMemory(scope);
  const parts = [];
  if (m.role) parts.push(`【角色设定】${m.role}`);
  if (m.brand) parts.push(`【品牌信息】${m.brand}`);
  if (m.style) parts.push(`【风格偏好】${m.style}`);
  if (m.workflow) parts.push(`【工作流偏好】${m.workflow}`);
  return parts.join('\n');
}

export const __id = crypto.randomUUID();
