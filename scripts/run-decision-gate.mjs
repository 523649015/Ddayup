// 决策回归门禁（本地预跑）：串跑所有 verify-*-logic.mjs，硬门禁全过才退出 0。
// 与 .github/workflows/ci-cd.yml 的 bash 串跑互补：本地改 verify 脚本后可先本跑确认不破基线。
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { makeChecker } from './_lib/verify-utils.mjs';

const gate = makeChecker('[gate] ');
const dir = fileURLToPath(new URL('.', import.meta.url));
const files = readdirSync(dir).filter((f) => /^verify-.*-logic\.mjs$/.test(f)).sort();

let childFail = 0;
for (const f of files) {
  try {
    execFileSync('node', [join(dir, f)], { encoding: 'utf8', stdio: 'pipe' });
    gate.check(`脚本通过: ${f}`, true);
  } catch {
    childFail++;
    gate.check(`脚本通过: ${f}`, false);
  }
}
gate.check('无脚本失败', childFail === 0);
gate.exit();
