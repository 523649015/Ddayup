// P1-10 共享常量收敛（第一步）：服务端基础路径单点导出。
// 语义与原 hmdao-api.mjs 顶部定义完全一致：APP_DIR 取进程启动时的 cwd。
// ESM 模块在 import 阶段求值一次，与主文件原先的顶层 const 求值时机等价（imports 先于主体代码执行）。
import path from 'node:path';
import fs from 'node:fs';

export const APP_DIR = process.cwd();
export const REPO_ROOT = path.resolve(APP_DIR, '..');
// 数据目录可配置：云端部署时通过 HMDAO_DATA_DIR 指向持久化挂载卷（如 /data），
// 用户库(users.json)、已激活 provider、工作流/会话元数据等都落在这里，避免容器重启丢失。
//
// ★2026-08-21 修复路径错配（与原 cwd 绑定的 .hmdao-data 错位）：
// 后端启动方式历史上分两种：① 在仓库根 `node app/server/hmdao-api.mjs` → cwd=repo 根 →
// DATA_DIR=<repo 根>/.hmdao-data（空目录）；② 在 app/ 子目录 `node server/hmdao-api.mjs` →
// cwd=app/ → DATA_DIR=app/.hmdao-data（实际用户数据）。两种启动方式会产生两个独立的
// users.json，先前注册的用户位于 app/.hmdao-data，但登录时若 cwd=仓库根就读不到，导致
// "之前注册过，重置 7 天试用，今天登录不上"的根因。
//
// 修复策略：自动探测。若 cwd 下没有 .hmdao-data，但存在 app/.hmdao-data，则回退到
// app/.hmdao-data（兼容历史上"在 app/ 子目录启动"的部署）。HMDAO_DATA_DIR 环境变量
// 仍享有最高优先级（云端部署用）。
function resolveDataDir() {
  if (process.env.HMDAO_DATA_DIR) return path.resolve(process.env.HMDAO_DATA_DIR);
  const here = path.resolve(APP_DIR, '.hmdao-data');
  const sibling = path.resolve(APP_DIR, 'app', '.hmdao-data');
  try {
    const hereExists = fs.existsSync(here);
    const siblingExists = fs.existsSync(sibling);
    // 显式配置：sibling 存在但 here 不存在 → 优先 sibling（兼容历史上"在 app/ 子目录启动"）。
    if (siblingExists && !hereExists) return sibling;
    // ★两边都存在时，比较 users.json 用户数量（数据越多越可能是真实主目录）。
    // 这修复了"在 repo 根启动时 cwd/.hmdao-data/users.json 已被旧测试污染为空文件"导致
    // "原本注册在 app/.hmdao-data 的用户登录不上"的根因。
    if (hereExists && siblingExists) {
      try {
        const hereUsers = JSON.parse(fs.readFileSync(path.join(here, 'users.json'), 'utf8'));
        const sibUsers = JSON.parse(fs.readFileSync(path.join(sibling, 'users.json'), 'utf8'));
        const hereLen = Array.isArray(hereUsers) ? hereUsers.length : (hereUsers.users || []).length;
        const sibLen = Array.isArray(sibUsers) ? sibUsers.length : (sibUsers.users || []).length;
        if (sibLen > hereLen) return sibling;
      } catch (_) {}
    }
  } catch (_) {}
  return here;
}
export const DATA_DIR = resolveDataDir();
