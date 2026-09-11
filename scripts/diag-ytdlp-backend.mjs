// 诊断：本地后端 yt-dlp 服务是否可用（定位"之前能下载 / 现在 503"的根因）
//
// 用户日志实证：
//   127.0.0.1:3000/api/platform/ytdlp?action=formats&url=...douyin... → 503 (Service Unavailable)
//   对应代码：sidepanel.js:3737（取分辨率列表）、3944（extract 直链）、download.js:548（下载）
//
// 本脚本逐层探测：
//   ① 3000 端口是否存活（ui-static-proxy）
//   ② 8792 端口是否存活（hmdao-api 真身）
//   ③ /api/health 是否返回 ok + ytdlp 状态
//   ④ /api/platform/ytdlp?action=formats 实际返回码
//   ⑤ yt-dlp 二进制是否在 PATH
//
// 用法：node scripts/diag-ytdlp-backend.mjs

const BASE = 'http://127.0.0.1:3000';
const DIRECT = 'http://127.0.0.1:8792';
const TEST_URL = 'https://www.douyin.com/video/7678346515106106634';

let problems = [];

async function probe(label, url, opts = {}) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(8000) });
    const ms = Date.now() - t0;
    let bodyPreview = '';
    try {
      const t = await r.text();
      bodyPreview = t.slice(0, 200).replace(/\s+/g, ' ');
    } catch (_) {}
    console.log(`  [${r.status}] ${label}  (${ms}ms)`);
    if (bodyPreview) console.log(`         body: ${bodyPreview}`);
    return { ok: r.ok, status: r.status, body: bodyPreview };
  } catch (e) {
    console.log(`  [ERR] ${label}  → ${e && (e.name === 'TimeoutError' ? 'timeout' : e.message)}`);
    return { ok: false, error: e && e.message };
  }
}

console.log('=== ① 3000（ui-static-proxy）存活探测 ===');
const p3000 = await probe('GET /api/health', `${BASE}/api/health`);
if (!p3000.ok) problems.push('3000 端口不可达 → ui-static-proxy 未启动');

console.log('\n=== ② 8792（hmdao-api 真身）存活探测 ===');
const p8792 = await probe('GET /api/health', `${DIRECT}/api/health`);
if (!p8792.ok) problems.push('8792 端口不可达 → hmdao-api 未启动（这才是根因）');

console.log('\n=== ③ /api/health 的 ytdlp 字段 ===');
if (p3000.ok && p3000.body) {
  try {
    const j = JSON.parse(p3000.body.length > 2 ? (await (await fetch(`${BASE}/api/health`)).text()) : '{}');
    const lp = j.localPostBackends || j.localPost || {};
    const ytdlp = lp.ytdlp || {};
    console.log('  localPostBackends.ytdlp =', JSON.stringify(ytdlp));
    if (ytdlp && ytdlp.status && ytdlp.status !== 'ok') {
      problems.push(`yt-dlp 状态 = ${ytdlp.status}（非 ok）`);
    }
    if (ytdlp && !ytdlp.detectedPath) {
      problems.push('yt-dlp detectedPath 为空 → 未安装/未识别');
    }
  } catch (e) {
    console.log('  (解析 health JSON 失败:', e.message, ')');
  }
}

console.log('\n=== ④ ytdlp?action=formats 实际返回（日志中 503 的那条）===');
const fmtUrl = `${BASE}/api/platform/ytdlp?action=formats&url=${encodeURIComponent(TEST_URL)}`;
const pf = await probe('GET ytdlp?action=formats (3000)', fmtUrl, { credentials: 'omit' });
if (pf.status === 503) {
  problems.push('★ ytdlp formats 返回 503 → 后端 yt-dlp 服务不可用（与用户日志一致）');
}

console.log('\n=== ⑤ yt-dlp 二进制是否在 PATH ===');
{
  const { execSync } = await import('node:child_process');
  for (const cmd of ['yt-dlp --version', 'yt-dlp.exe --version']) {
    try {
      const v = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 }).toString().trim();
      console.log(`  ✓ ${cmd.split(' ')[0]} = ${v}`);
    } catch (_) {
      console.log(`  ✗ ${cmd.split(' ')[0]} 不可用`);
    }
  }
}

console.log('\n=== 结论 ===');
if (problems.length) {
  problems.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
  console.log('\n  → 方向：这是【后端/环境】问题，不是扩展前端代码 bug。');
  console.log('    修复优先级：重启 hmdao-api（8792）> 重启 ui-static-proxy（3000）> 安装/识别 yt-dlp');
} else {
  console.log('  ✓ 未发现明显问题（若用户侧仍 503，需在用户机器上跑本脚本）');
}
