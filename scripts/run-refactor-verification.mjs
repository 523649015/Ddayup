#!/usr/bin/env node
// Master verification runner for the backend architecture-refactor effort.
// Executes all 9 refactoring-regression suites, aggregates PASS/FAIL counts
// (handles three reporter styles: '  PASS  ', '  ✓ ', and silent-on-pass),
// and emits a structured JSON report plus a human-readable summary.
// Exit code is non-zero if any suite fails or crashes.
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const TMP = path.join(HERE, 'tmp');
mkdirSync(TMP, { recursive: true });

const SUITES = [
  'test-verify-helpers.mjs',
  'test-parse-utils.mjs',
  'test-media-url-utils.mjs',
  'test-session-store.mjs',
  'test-operation-dispatch-utils.mjs',
  'test-operation-dispatch-helpers.mjs',
  'test-server-router-refactor.mjs',
  'test-ark-module-split.mjs',
  'test-local-post-backends.mjs',
  'test-lib-modules-contract.mjs',
  'test-runtime-version-utils.mjs',
  'test-lib-symbol-graph.mjs',
  'test-http-router-perf.mjs',
  'test-verify-browser-debug-port.mjs',
];

function countAssertCalls(file) {
  const src = readFileSync(file, 'utf8');
  const re = /^\s*(ok|check|eq)\(/gm; // excludes `function ok(` definitions
  let n = 0;
  while (re.exec(src)) n += 1;
  return n;
}

function runSuite(name) {
  const file = path.join(HERE, name);
  const res = spawnSync('node', [file], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 180000,
  });
  const out = String(res.stdout || '') + String(res.stderr || '');
  const lines = out.split('\n');
  let runtimePass = 0;
  let runtimeFail = 0;
  for (const l of lines) {
    if (/^\s*(PASS|✓)\s/.test(l)) runtimePass += 1;
    else if (/^\s*(FAIL|✗)\s/.test(l)) runtimeFail += 1;
  }
  // Silent reporters (e.g. media-url-utils prints only on failure) -> infer pass from source.
  const pass = runtimePass > 0 ? runtimePass : (runtimeFail === 0 ? countAssertCalls(file) : 0);
  const crashed = res.status !== 0 && runtimeFail === 0;
  return {
    name,
    pass,
    fail: runtimeFail,
    crashed,
    status: res.status,
    tail: lines.filter((l) => l.trim()).slice(-5),
  };
}

const startedAt = Date.now();
const results = SUITES.map(runSuite);
const elapsedMs = Date.now() - startedAt;

const totalPass = results.reduce((a, r) => a + r.pass, 0);
const totalFail = results.reduce((a, r) => a + r.fail, 0);
const anyCrash = results.some((r) => r.crashed);

console.log('\n================ REFACTOR VERIFICATION SUMMARY ================');
for (const r of results) {
  const flag = r.crashed ? 'CRASH' : r.fail > 0 ? 'FAIL ' : 'OK   ';
  console.log(`  [${flag}] ${r.name.padEnd(38)} pass=${r.pass} fail=${r.fail}`);
}
console.log('--------------------------------------------------------------');
console.log(`  TOTAL  pass=${totalPass}  fail=${totalFail}  crash=${anyCrash ? 1 : 0}  elapsed=${elapsedMs}ms`);
console.log('==============================================================\n');

const report = {
  generatedAt: new Date().toISOString(),
  suites: SUITES.length,
  totalPass,
  totalFail,
  anyCrash,
  elapsedMs,
  results,
};
writeFileSync(path.join(TMP, 'refactor-verification.json'), JSON.stringify(report, null, 2));

process.exit(totalFail > 0 || anyCrash ? 1 : 0);
