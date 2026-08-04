import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { readJsonStdin, runHmdaoImageAnalysisRuntime } from './local_image_wrapper_runtime.mjs';

// R1 防御：若环境变量指向的是 backend 目录而非 .py 脚本（历史数据/误配），
// 自动在其内部定位推理脚本，避免把目录当 Python 脚本跑 → PermissionError。
function resolveFlorenceScript(raw) {
  const value = String(raw || '').trim();
  if (!value) return value;
  try {
    const resolved = path.resolve(value);
    if (path.extname(resolved).toLowerCase() === '.py') return resolved;
    if (existsSync(resolved) && statSync(resolved).isDirectory()) {
      const inside = path.join(resolved, 'local_image_example_florence2.py');
      if (existsSync(inside)) return inside;
    }
  } catch { /* 忽略，返回原值 */ }
  return value;
}

const request = await readJsonStdin();
const runtimePath = resolveFlorenceScript(process.env.HMDAO_FLORENCE2_PATH);
const result = await runHmdaoImageAnalysisRuntime({
  backendName: 'florence2',
  backendLabel: 'Florence-2',
  runtimePath,
  request,
});
process.stdout.write(JSON.stringify(result));
