#!/usr/bin/env node
/**
 * 端点延迟基准采样（重构前/后性能对比用）。
 *
 * 用法：
 *   node scripts/bench-endpoints.mjs before   # 采样并写入 tmp/bench-before.json
 *   node scripts/bench-endpoints.mjs after    # 采样并写入 tmp/bench-after.json，同时打印对比
 *
 * 关注指标：avg / p50 / p95 / max。p95 尖峰是同步阻塞（spawnSync 等）的典型信号。
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'tmp');
const BACKEND = process.env.HMDAO_BACKEND || 'http://127.0.0.1:8792';

const TARGETS = [
  ['GET', '/api/health', null],
  ['GET', '/api/health/platform', null],
  ['GET', '/api/dcc/status', null],
  ['GET', '/api/byok/providers', null],
  ['GET', '/api/byok/runtime', null],
  ['GET', '/api/models/catalog', null],
  ['GET', '/api/models/manifest', null],
  ['GET', '/api/assets/library', null],
  ['GET', '/api/assets/duplicates/persisted', null],
  ['GET', '/api/settings/assets', null],
  ['GET', '/api/settings/dispatch', null],
  ['GET', '/api/health/local-post/runtime/install-jobs', null],
];

const SAMPLES = Number(process.env.BENCH_SAMPLES || 8);

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

async function sample(method, p, body) {
  const times = [];
  let status = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const opts = { method, headers: { 'content-type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const t0 = performance.now();
    try {
      const r = await fetch(BACKEND + p, opts);
      await r.text();
      status = r.status;
    } catch {
      status = -1;
    }
    times.push(Math.round((performance.now() - t0) * 100) / 100);
  }
  const sorted = [...times].sort((a, b) => a - b);
  return {
    endpoint: `${method} ${p}`,
    status,
    avg: Math.round((times.reduce((a, b) => a + b, 0) / times.length) * 100) / 100,
    p50: pct(sorted, 50),
    p95: pct(sorted, 95),
    max: sorted[sorted.length - 1],
  };
}

/**
 * 事件循环阻塞专项：
 * /api/dcc/status?force=1 会触发 Unreal 适配器的 PowerShell 全进程扫描（Get-CimInstance）。
 * 若该扫描用 spawnSync 执行，会同步卡死事件循环 1~2s —— 表现为「此期间所有并发请求一起卡住」。
 * 因此这里在触发扫描的同时持续 ping 一个极轻量端点，用 ping 的 max 延迟度量阻塞程度。
 */
async function measureEventLoopBlocking() {
  const pings = [];
  let stop = false;
  const pinger = (async () => {
    while (!stop) {
      const t0 = performance.now();
      try { await fetch(BACKEND + '/api/health/local-post/runtime/install-jobs').then((r) => r.text()); }
      catch { /* ignore */ }
      pings.push(Math.round((performance.now() - t0) * 100) / 100);
      await new Promise((r) => setTimeout(r, 20));
    }
  })();

  const t0 = performance.now();
  let heavyStatus = 0;
  try {
    const r = await fetch(BACKEND + '/api/dcc/status?force=1');
    await r.text();
    heavyStatus = r.status;
  } catch { heavyStatus = -1; }
  const heavyMs = Math.round((performance.now() - t0) * 100) / 100;

  stop = true;
  await pinger;

  const sorted = [...pings].sort((a, b) => a - b);
  return {
    heavyEndpoint: 'GET /api/dcc/status?force=1',
    heavyStatus,
    heavyMs,
    pingCount: pings.length,
    pingAvg: pings.length ? Math.round((pings.reduce((a, b) => a + b, 0) / pings.length) * 100) / 100 : 0,
    pingP95: pct(sorted, 95),
    pingMax: sorted.length ? sorted[sorted.length - 1] : 0,
  };
}

async function main() {
  const phase = (process.argv[2] || 'after').toLowerCase();
  if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });

  // 预热一轮，排除首次冷启动/懒加载噪声
  for (const [m, p, b] of TARGETS) {
    try {
      const o = { method: m, headers: { 'content-type': 'application/json' } };
      if (b) o.body = JSON.stringify(b);
      await fetch(BACKEND + p, o).then((r) => r.text());
    } catch { /* ignore */ }
  }

  const rows = [];
  for (const [m, p, b] of TARGETS) rows.push(await sample(m, p, b));

  const blocking = await measureEventLoopBlocking();

  const out = { phase, backend: BACKEND, samples: SAMPLES, at: new Date().toISOString(), rows, blocking };
  const file = path.join(TMP, `bench-${phase}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2), 'utf8');

  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\n=== 端点延迟采样 [${phase}] （每端点 ${SAMPLES} 次，已预热） ===\n`);
  console.log(pad('端点', 52) + pad('状态', 6) + pad('avg', 10) + pad('p50', 10) + pad('p95', 10) + 'max');
  console.log('-'.repeat(98));
  for (const r of rows) {
    console.log(pad(r.endpoint, 52) + pad(r.status, 6) + pad(r.avg + 'ms', 10) + pad(r.p50 + 'ms', 10) + pad(r.p95 + 'ms', 10) + r.max + 'ms');
  }
  console.log('\n--- 事件循环阻塞专项 ---');
  console.log(`  重负载端点        : ${blocking.heavyEndpoint} -> ${blocking.heavyStatus} (${blocking.heavyMs}ms)`);
  console.log(`  并发轻 ping 次数  : ${blocking.pingCount}`);
  console.log(`  ping avg / p95 / max : ${blocking.pingAvg}ms / ${blocking.pingP95}ms / ${blocking.pingMax}ms`);
  console.log(`  判定              : ${blocking.pingMax > 300 ? '\x1b[31m事件循环被阻塞\x1b[0m' : '\x1b[32m事件循环未阻塞\x1b[0m'}`);

  console.log(`\n已写入 ${path.relative(ROOT, file)}`);

  // 对比
  const beforeFile = path.join(TMP, 'bench-before.json');
  if (phase === 'after' && existsSync(beforeFile)) {
    const before = JSON.parse(readFileSync(beforeFile, 'utf8'));
    const map = new Map(before.rows.map((r) => [r.endpoint, r]));
    console.log('\n=== 重构前后对比（p95 为主指标） ===\n');
    console.log(pad('端点', 52) + pad('before p95', 14) + pad('after p95', 14) + '变化');
    console.log('-'.repeat(98));
    let improved = 0; let regressed = 0;
    for (const r of rows) {
      const b = map.get(r.endpoint);
      if (!b) { console.log(pad(r.endpoint, 52) + pad('-', 14) + pad(r.p95 + 'ms', 14) + '新增'); continue; }
      const delta = r.p95 - b.p95;
      const ratio = b.p95 > 0 ? (delta / b.p95) * 100 : 0;
      // 只有绝对变化 > 5ms 且相对变化 > 20% 才算显著
      let tag = '持平';
      if (delta < -5 && ratio < -20) { tag = `\x1b[32m改善 ${Math.round(-ratio)}%\x1b[0m`; improved++; }
      else if (delta > 5 && ratio > 20) { tag = `\x1b[31m退化 ${Math.round(ratio)}%\x1b[0m`; regressed++; }
      console.log(pad(r.endpoint, 52) + pad(b.p95 + 'ms', 14) + pad(r.p95 + 'ms', 14) + tag);
    }
    console.log(`\n显著改善 ${improved} 项 / 显著退化 ${regressed} 项`);

    if (before.blocking) {
      console.log('\n--- 事件循环阻塞对比 ---');
      console.log(pad('指标', 30) + pad('before', 16) + pad('after', 16) + '结论');
      console.log('-'.repeat(80));
      const bb = before.blocking;
      const rows2 = [
        ['并发 ping max', bb.pingMax, blocking.pingMax],
        ['并发 ping p95', bb.pingP95, blocking.pingP95],
        ['并发 ping avg', bb.pingAvg, blocking.pingAvg],
      ];
      for (const [k, b1, a1] of rows2) {
        const better = a1 < b1 * 0.5;
        console.log(pad(k, 30) + pad(b1 + 'ms', 16) + pad(a1 + 'ms', 16) + (better ? '\x1b[32m显著改善\x1b[0m' : a1 > b1 * 2 ? '\x1b[31m退化\x1b[0m' : '持平'));
      }
      console.log(`${pad('阻塞判定', 30)}${pad(bb.pingMax > 300 ? '阻塞' : '未阻塞', 16)}${pad(blocking.pingMax > 300 ? '阻塞' : '未阻塞', 16)}`);
    }
    process.exit(regressed > 0 ? 1 : 0);
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
