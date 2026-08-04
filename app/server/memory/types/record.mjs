// 记忆记录的数据模型与校验（单一职责：定义记录结构与合法性约束）。
// 该模块不依赖任何存储实现，可被 store / manager 复用。

// 平台记忆的合法类别。扩展时只需在此追加。
export const MEMORY_CATEGORIES = ['asset', 'preference', 'context', 'note', 'workflow'];

export function normalizeCategory(category) {
  const c = String(category || 'note').trim().toLowerCase();
  return MEMORY_CATEGORIES.includes(c) ? c : 'note';
}

// 构造一条标准化的记忆记录。key 为同类别下唯一标识。
export function createMemoryRecord({ category, key, content, tags = [], metadata = {} } = {}) {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) throw new Error('memory-record-key-required');
  return {
    category: normalizeCategory(category),
    key: normalizedKey,
    content: String(content == null ? '' : content),
    tags: Array.isArray(tags) ? tags.map((t) => String(t)).filter(Boolean) : [],
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function validateMemoryRecord(record) {
  if (!record || typeof record !== 'object') return { valid: false, error: 'record-object-required' };
  if (!String(record.key || '').trim()) return { valid: false, error: 'key-required' };
  if (typeof record.content !== 'string') return { valid: false, error: 'content-string-required' };
  if (!MEMORY_CATEGORIES.includes(record.category)) return { valid: false, error: 'invalid-category' };
  return { valid: true };
}
