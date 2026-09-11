/**
 * 构建后清理：移除生产运行时永不命中的 wasm 冗余拷贝。
 *
 * 背景：dist 体积 237.8 MB，其中 wasm 占 231.3 MB（97%）。
 * ONNX Runtime 在仓库中存在两份完整拷贝（各 75.9 MB）：
 *   - public/ort-wasm/      （仅 dev 分支使用）
 *   - public/ort-wasm-v1/   （生产实际使用）
 *
 * 生产不需要 dist/ort-wasm/ 的依据（已核对产物）：
 *   1) ortEnv.ts 显式设置 ort.env.wasm.wasmPaths = '/ort-wasm-v1/'
 *   2) translateCore.ts 为三元表达式：isDev ? '/ort-wasm/' : `${origin}/api/transformers/`
 *      生产构建 isDev === false，恒定走 /api/transformers/，'/ort-wasm/' 为死分支
 *
 * 保留 public/ort-wasm/：dev 模式（npm run dev:full）的 translateCore 仍走该路径。
 *
 * 安全护栏：仅删除白名单内的目录，且必须位于 dist 下、必须是目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

// 白名单：只有确认生产不会请求的目录才可列入
const PRUNABLE_DIRS = ['ort-wasm'];

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else total += fs.statSync(full).size;
    }
  };
  walk(dir);
  return total;
}

if (!fs.existsSync(DIST)) {
  console.log('[prune-wasm] dist 不存在，跳过清理。');
  process.exit(0);
}

let savedBytes = 0;

for (const name of PRUNABLE_DIRS) {
  const target = path.join(DIST, name);
  if (!fs.existsSync(target)) continue;

  const stat = fs.statSync(target);
  if (!stat.isDirectory()) continue;

  const size = dirSize(target);
  fs.rmSync(target, { recursive: true, force: true });
  savedBytes += size;
  console.log(`[prune-wasm] 已移除 dist/${name}/  (${(size / 1024 / 1024).toFixed(1)} MB)`);
}

if (savedBytes > 0) {
  console.log(`[prune-wasm] 共节省 ${(savedBytes / 1024 / 1024).toFixed(1)} MB`);
} else {
  console.log('[prune-wasm] 无可清理内容，dist 已是精简状态。');
}
