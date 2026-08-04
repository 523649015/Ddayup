// P1-10 共享常量收敛（第一步）：服务端基础路径单点导出。
// 语义与原 hmdao-api.mjs 顶部定义完全一致：APP_DIR 取进程启动时的 cwd。
// ESM 模块在 import 阶段求值一次，与主文件原先的顶层 const 求值时机等价（imports 先于主体代码执行）。
import path from 'node:path';

export const APP_DIR = process.cwd();
export const REPO_ROOT = path.resolve(APP_DIR, '..');
export const DATA_DIR = path.resolve(APP_DIR, '.hmdao-data');
