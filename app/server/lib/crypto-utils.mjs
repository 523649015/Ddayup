// 轻量加密工具（从主文件 hmdao-api.mjs 单源化，行为零变更）。
// 仅依赖 node:crypto，保持纯函数、零模块可变状态。
import crypto from 'node:crypto';

// 计算 Buffer 的 SHA-256 十六进制摘要。
export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export default { sha256 };
