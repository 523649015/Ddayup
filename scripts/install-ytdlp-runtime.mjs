// 通过后端 HTTP 一键安装接口安装 yt-dlp 运行时，并轮询直到就绪
//
// 背景：扩展侧 autoEnsureYtDlpAndRetry (download.js:464) 走 native host 的 ytdlp.ensure，
//       native 不可用时直接放弃 → 只提示手动安装。但后端其实提供了 HTTP 一键安装：
//         POST /api/health/local-post/runtime/install  body { runtimeKey: 'ytdlp' }
//       本脚本直接走这条路，验证能否把 yt-dlp 装上（解开 503 ytdlp-missing 的死结）。
//
// 用法：node scripts/install-ytdlp-runtime.mjs

const BASE = 'http://127.0.0.1:3000';

async function postInstall() {
  console.log('→ POST /api/health/local-post/runtime/install { runtimeKey: "ytdlp" }');
  const r = await fetch(`${BASE}/api/health/local-post/runtime/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runtimeKey: 'ytdlp' }),
    signal: AbortSignal.timeout(30000),
  });
  const t = await r.text();
  console.log(`  [${r.status}] ${t.slice(0, 300).replace(/\s+/g, ' ')}`);
  try { return JSON.parse(t); } catch (_) { return { status: r.status, raw: t }; }
}

async function getJobs() {
  const r = await fetch(`${BASE}/api/health/local-post/runtime/install-jobs?runtimeKey=ytdlp`, {
    signal: AbortSignal.timeout(15000),
  });
  const t = await r.text();
  try {
    const j = JSON.parse(t);
    const arr = j.jobs || j.data || (Array.isArray(j) ? j : []);
    return arr;
  } catch (_) { return []; }
}

async function healthYtdlp() {
  const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  const lp = j.localPostBackends || {};
  return lp.ytdlp || {};
}

const first = await postInstall();
console.log('\n=== 轮询安装状态（最多 3 分钟）===');
let ready = false;
for (let i = 0; i < 36; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const jobs = await getJobs();
  const y = await healthYtdlp().catch(() => ({}));
  const j0 = jobs[0] || {};
  console.log(`  [${(i + 1) * 5}s] job=${j0.status || j0.state || '?'} progress=${j0.progress ?? j0.percent ?? '?'} | health.ytdlp=${JSON.stringify(y).slice(0, 120)}`);
  if (y && (y.status === 'ok' || y.detectedPath)) { ready = true; break; }
  if (j0.status === 'failed' || j0.state === 'failed') { console.log('  安装任务失败'); break; }
  if (j0.status === 'done' || j0.status === 'completed' || j0.state === 'done') {
    const y2 = await healthYtdlp().catch(() => ({}));
    if (y2 && (y2.status === 'ok' || y2.detectedPath)) ready = true;
    break;
  }
}

console.log('\n=== 验证 yt-dlp 接口是否恢复 ===');
const TEST = 'https://www.douyin.com/video/7678346515106106634';
const fmt = await fetch(`${BASE}/api/platform/ytdlp?action=formats&url=${encodeURIComponent(TEST)}`, {
  signal: AbortSignal.timeout(60000),
});
const ft = await fmt.text();
console.log(`  [${fmt.status}] action=formats → ${ft.slice(0, 220).replace(/\s+/g, ' ')}`);

console.log('\n=== 结论 ===');
console.log(ready ? '  ✅ yt-dlp 已就绪' : '  ⚠ yt-dlp 仍未就绪（见上方 job 状态 / 安装日志）');
console.log(fmt.status === 200 ? '  ✅ formats 接口恢复 200' : `  ⚠ formats 仍返回 ${fmt.status}`);
