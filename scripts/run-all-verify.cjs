const { execFileSync } = require('child_process');
const path = require('path');
const scripts = [
  'verify-manifest-fields.mjs',
  'verify-extension-offline.mjs',
  'verify-installer-id.mjs',
  'verify-platform-coverage.mjs',
  'verify-douyin-cover-relay.mjs',
  'verify-douyin-referer-fix.mjs',
  'verify-cover-extract.mjs',
  'verify-card-thumb-fallback.mjs',
  'verify-native-exe.cjs',
  'verify-free-mode.mjs',
  'verify-login-default.mjs',
  'verify-thumb-cache.mjs',
];
let totalPass = 0, totalFail = 0;
for (const s of scripts) {
  process.stdout.write(`\n=== ${s} ===\n`);
  let out = '';
  try {
    out = execFileSync('node', ['scripts/' + s], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
  }
  process.stdout.write(out);
  const pm = out.match(/PASS=(\d+)/);
  const fm = out.match(/FAIL=(\d+)/);
  if (pm) totalPass += parseInt(pm[1], 10);
  if (fm) totalFail += parseInt(fm[1], 10);
}
console.log(`\n==== 汇总: TOTAL_PASS=${totalPass} TOTAL_FAIL=${totalFail} ====`);
process.exit(totalFail === 0 ? 0 : 1);
