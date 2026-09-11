// 直接 import 后端真实检测函数，看它到底返回什么（不复刻、不猜测）
import { detectManagedLocalPostYtDlpPath } from '../app/server/lib/local-post-processing.mjs';
import { platformExecutableCandidates } from '../app/server/platform-utils.mjs';
import { existsSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';

// currentDir 由 local-post-constants 文档 + 实际 dir 结果确定
const cur = path.join(process.env.APPDATA || '', 'Ddayup', 'local-post-runtimes', 'ytdlp', 'current');

console.log('=== 后端真实检测结果 ===');
const detected = detectManagedLocalPostYtDlpPath();
console.log('detectManagedLocalPostYtDlpPath() =', JSON.stringify(detected));

console.log('\n=== 候选文件名 ===');
const cands = platformExecutableCandidates('yt-dlp');
console.log('platformExecutableCandidates("yt-dlp") =', JSON.stringify(cands));

console.log('\n=== currentDir 实际内容 ===');
console.log('currentDir =', cur);
console.log('existsSync(currentDir) =', existsSync(cur));
if (existsSync(cur)) {
  try {
    const { readdirSync } = await import('node:fs');
    for (const e of readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, e.name);
      const st = e.isFile() ? statSync(p) : null;
      console.log(`  ${e.isDirectory() ? '[D]' : '[F]'} ${e.name}${st ? `  (${st.size} bytes, mtime=${st.mtime.toISOString()})` : ''}`);
    }
  } catch (e) { console.log('  readdir 失败:', e.message); }
}

console.log('\n=== 判定 ===');
if (detected) {
  console.log('  ✅ 后端能检测到：', detected);
  console.log('  → 若 /api/health 仍报空，说明【health 结果被缓存】，需重启后端 或 触发刷新');
} else {
  console.log('  ❌ 后端检测函数返回空');
  console.log('  → 但文件存在于 currentDir，说明检测逻辑与实际落位不一致（路径/文件名/权限）');
  // 逐一验证候选文件是否存在
  for (const c of cands) {
    const p = path.join(cur, c);
    console.log(`    候选 ${c}: existsSync=${existsSync(p)}`);
  }
}
