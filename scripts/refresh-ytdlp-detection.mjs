// 安装 yt-dlp 后，必须清「运行时检测缓存」才能被 /api/health 识别。
// 后端已提供专用端点：POST /api/health/local-post/refresh
//   （health.mjs:134 → deps.clearLocalPostRuntimeDetectionCache()）
// 本脚本：清缓存 → 查 health → 验证 formats 接口是否从 503 恢复。
//
// 用法：node scripts/refresh-ytdlp-detection.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';

const BASE = 'http://127.0.0.1:3000';
const TEST = 'https://www.douyin.com/video/7678346515106106634';

async function jfetch(url, opts = {}) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(60000) });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch (_) {}
  return { status: r.status, json: j, text: t };
}

console.log('=== before: health.localPostBackends.ytdlp ===');
const before = await jfetch(`${BASE}/api/health`);
console.log('  ', JSON.stringify(before.json?.capabilities?.localPostBackends?.ytdlp || {}));

console.log('\n=== POST /api/health/local-post/refresh （清检测缓存）===');
const rf = await jfetch(`${BASE}/api/health/local-post/refresh`, { method: 'POST' });
console.log('  status =', rf.status);
const afterYtdlp = rf.json?.capabilities?.localPostBackends?.ytdlp || {};
console.log('  ytdlp  =', JSON.stringify(afterYtdlp));

console.log('\n=== after: 重新查 /api/health ===');
const after = await jfetch(`${BASE}/api/health`);
console.log('  ', JSON.stringify(after.json?.capabilities?.localPostBackends?.ytdlp || {}));

console.log('\n=== 验证 /api/platform/ytdlp?action=formats ===');
const fmt = await jfetch(`${BASE}/api/platform/ytdlp?action=formats&url=${encodeURIComponent(TEST)}`, { credentials: 'omit' });
console.log('  status =', fmt.status);
console.log('  body   =', (fmt.text || '').slice(0, 300).replace(/\s+/g, ' '));

console.log('\n=== 结论 ===');
const ok = !!(afterYtdlp.detectedPath || afterYtdlp.configured);
if (ok) {
  console.log('  ✅ yt-dlp 已被识别：', afterYtdlp.detectedPath || '(configured)');
} else {
  console.log('  ⚠ 仍未识别。请检查：');
  console.log('     1) 后端实际 managedRuntimeDir 与文件落位是否一致');
  console.log('     2) current/yt-dlp.exe 是否可执行（onedir 需 _internal/）');
}
console.log(fmt.status === 200 ? '  ✅ formats 接口已恢复 200' : `  ${fmt.status === 503 ? '⚠ formats 仍 503' : 'ℹ formats 返回 ' + fmt.status}`);
