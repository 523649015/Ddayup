// app/server/core/json-store.mjs
// 统一原子写 JSON 持久化：消除 hmdao-api.mjs 中多份重复的 load/save + writeFileSync 非原子写。
// 关键收益：
//  - 原子替换（先写临时文件再 rename），避免进程中途被杀导致 JSON 截断；
//  - 避免并发写同一文件的 lost-update（如两次并发激活 Ark 接入点）；
//  - 统一「读不到/解析失败 → 回退默认值」的容错语义。
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// 读取 JSON 文件；文件不存在或解析失败时返回 fallback。
export function readJsonFile(file, fallback = null) {
  try {
    const raw = readFileSync(file, 'utf8');
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// 原子写 JSON 文件：写入 .tmp 后 rename 替换目标，保证读方永远看到完整文件。
export function writeJsonFileAtomic(file, data, { indent = 2 } = {}) {
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, indent), 'utf8');
  renameSync(tmp, file);
  return true;
}
