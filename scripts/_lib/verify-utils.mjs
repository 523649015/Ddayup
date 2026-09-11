// 共享验证辅助：统一 pass/fail 计数、check/assert 断言、srcHas 源文件静态确认。
// 供 scripts/ 下的 verify-*.mjs 与决策回归门禁复用，避免样板散落导致的易错重复。
import fs from 'node:fs';

export function makeChecker(prefix = '') {
  let pass = 0;
  let fail = 0;
  function check(name, cond) {
    if (cond) { pass++; console.log(`  ✓ ${prefix}${name}`); }
    else { fail++; console.log(`  ✗ ${prefix}${name}`); }
  }
  function assert(cond, msg) {
    if (cond) { pass++; console.log(`  ✅ ${prefix}${msg}`); }
    else { fail++; console.error(`  ❌ ${prefix}${msg}`); }
  }
  function srcHas(file, snippet) {
    const text = fs.readFileSync(file, 'utf8');
    return text.includes(snippet);
  }
  function summary() {
    console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
    return fail === 0 ? 0 : 1;
  }
  function exit() {
    process.exit(summary());
  }
  return { get pass() { return pass; }, get fail() { return fail; }, check, assert, srcHas, summary, exit };
}

export { fs };
