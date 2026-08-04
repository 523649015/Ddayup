// 文件型记忆存储（单一职责：持久化与基础查询）。
// 采用 JSON 文件落盘、按 records 数组存储；可整体替换为数据库实现而不影响上层。
import { promises as fs } from 'node:fs';
import path from 'node:path';

export class FileMemoryStore {
  constructor({ filePath } = {}) {
    if (!filePath) throw new Error('file-path-required');
    this.filePath = path.resolve(filePath);
    this.cache = null;
  }

  async _ensureDir() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
  }

  async _load() {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const normalized = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      const parsed = JSON.parse(normalized);
      this.cache = parsed && typeof parsed === 'object' ? parsed : { records: [] };
    } catch {
      this.cache = { records: [] };
    }
    if (!Array.isArray(this.cache.records)) this.cache.records = [];
    return this.cache;
  }

  async _persist() {
    await this._ensureDir();
    await fs.writeFile(this.filePath, JSON.stringify(this.cache, null, 2), 'utf8');
  }

  // 写入或更新一条记录（按 category + key 去重）。
  async put(record) {
    const data = await this._load();
    const idx = data.records.findIndex((r) => r.category === record.category && r.key === record.key);
    const next = { ...record, updatedAt: Date.now() };
    if (idx >= 0) {
      next.createdAt = data.records[idx].createdAt || Date.now();
      data.records[idx] = next;
    } else {
      data.records.push(next);
    }
    await this._persist();
    return next;
  }

  async get(category, key) {
    const data = await this._load();
    return data.records.find((r) => r.category === category && r.key === key) || null;
  }

  async delete(category, key) {
    const data = await this._load();
    const before = data.records.length;
    data.records = data.records.filter((r) => !(r.category === category && r.key === key));
    const removed = data.records.length !== before;
    if (removed) await this._persist();
    return removed;
  }

  async list({ category } = {}) {
    const data = await this._load();
    const records = category ? data.records.filter((r) => r.category === category) : data.records;
    return [...records].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  }

  async clear() {
    this.cache = { records: [] };
    await this._persist();
  }
}
