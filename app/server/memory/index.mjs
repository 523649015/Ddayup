// 记忆管理器（单一职责：编排存储、记录模型与召回）。
// 对外暴露 remember / recall / forget / list 四个核心能力，供 MCP 工具与后端复用。
import path from 'node:path';
import { FileMemoryStore } from './store/file-store.mjs';
import { createMemoryRecord, validateMemoryRecord } from './types/record.mjs';
import { scoreRelevance } from './embed/score.mjs';

// 默认记忆落盘位置：与平台其他本地数据一致的 .hmdao-data 目录。
const DEFAULT_MEMORY_FILE = path.resolve(
  process.env.HMDAO_DATA_DIR || path.join(process.cwd(), '.hmdao-data'),
  'memory.json',
);

export class MemoryManager {
  constructor({ store } = {}) {
    this.store = store || new FileMemoryStore({ filePath: DEFAULT_MEMORY_FILE });
  }

  // 写入或更新一条记忆。
  async remember(input = {}) {
    const record = createMemoryRecord(input);
    const check = validateMemoryRecord(record);
    if (!check.valid) throw new Error(`memory-invalid:${check.error}`);
    return this.store.put(record);
  }

  // 按关键词召回相关记忆，可限定类别与返回条数。
  async recall(query, { category, limit = 10, minScore = 0 } = {}) {
    const records = await this.store.list({ category });
    return records
      .map((r) => {
        const haystack = [r.content, r.key, (r.tags || []).join(' ')].join(' ');
        return { record: r, score: scoreRelevance(query, haystack) };
      })
      .filter((entry) => entry.score > 0 && entry.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => ({ ...entry.record, score: Number(entry.score.toFixed(3)) }));
  }

  // 删除指定类别与键的记忆。
  async forget(category, key) {
    if (!category || !key) throw new Error('memory-forget-requires-category-and-key');
    return this.store.delete(category, key);
  }

  // 列出记忆，可按类别过滤。
  async list({ category } = {}) {
    return this.store.list({ category });
  }
}

// 默认单例：确保跨会话、跨模块共用同一份记忆。
export const defaultMemory = new MemoryManager();
export default defaultMemory;
