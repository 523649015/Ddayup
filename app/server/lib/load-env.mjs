// 轻量 .env 加载器（零依赖）：
// 后端此前没有 dotenv，完全依赖 OS 环境变量，导致 app/.env 不生效。
// 本模块在 hmdao-api.mjs 顶部最先 import，读取 <APP_DIR>/.env 并注入 process.env，
// 仅当该变量在 process.env 中尚未定义时才覆盖（避免覆盖已显式 export 的环境变量）。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function resolveAppDir() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // server/lib/load-env.mjs -> 上溯两级到 app 目录
    return path.resolve(here, '..', '..');
  } catch {
    return process.cwd();
  }
}

export function loadDotEnvFile(envPath) {
  const target = envPath || path.resolve(resolveAppDir(), '.env');
  if (!existsSync(target)) return { loaded: false, path: target };
  const raw = readFileSync(target, 'utf8');
  let injected = 0;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // 去掉成对引号
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env) || process.env[key] === '') {
      process.env[key] = value;
      injected += 1;
    }
  }
  return { loaded: true, path: target, injected };
}

// 副作用：import 本模块即自动加载（排在 hmdao-api.mjs 最先 import）。
const result = loadDotEnvFile();
if (result.loaded) {
  // 仅用于调试，不影响逻辑
  // eslint-disable-next-line no-console
  console.log(`[load-env] 已加载 ${result.path}，注入 ${result.injected} 个环境变量`);
}

export default result;
