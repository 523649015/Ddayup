// 一次性清理测试账号：先列出全部账号，再按前缀过滤删除。
// 用法：node _clean_test_accounts.mjs [--apply]
import fs from 'node:fs';
import path from 'node:path';

const APP_DIR = 'F:/Work/HMDAODAO/app';
const REPO_ROOT = path.resolve(APP_DIR, '..');
const candidates = [
  path.resolve(APP_DIR, '.hmdao-data', 'users.json'),
  path.resolve(REPO_ROOT, '.hmdao-data', 'users.json'),
];

const TEST_PREFIXES = ['verify_', 'shared_', 'test_', 't_', 'probe_', 'tmp_', 'smoke_'];
function isTest(u) {
  const email = (u.email || u.username || u.id || '').toString().toLowerCase();
  const id = (u.id || '').toString().toLowerCase();
  return TEST_PREFIXES.some(p => email.startsWith(p) || id.startsWith(p));
}

const apply = process.argv.includes('--apply');
let totalDeleted = 0;

for (const f of candidates) {
  if (!fs.existsSync(f)) { console.log(`SKIP (not exist): ${f}`); continue; }
  let users;
  try { users = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { console.log(`SKIP (parse error): ${f} -> ${e.message}`); continue; }
  if (!Array.isArray(users)) { console.log(`SKIP (not array): ${f}`); continue; }

  const tests = users.filter(isTest);
  console.log(`\n== ${f}`);
  console.log(`  total=${users.length} test-matched=${tests.length}`);
  for (const u of tests) {
    console.log(`   - ${(u.email || u.id)} (id=${(u.id||'')}) createdAt=${(u.createdAt||'')}`);
  }
  if (apply && tests.length) {
    const keep = users.filter(u => !isTest(u));
    const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(keep, null, 2), 'utf8');
    fs.renameSync(tmp, f);
    totalDeleted += tests.length;
    console.log(`  APPLIED: deleted ${tests.length}, remaining ${keep.length}`);
  }
}
console.log(`\nDONE. mode=${apply ? 'APPLY' : 'DRY-RUN'} totalDeleted=${totalDeleted}`);
