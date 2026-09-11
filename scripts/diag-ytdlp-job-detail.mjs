// 查 yt-dlp 安装任务详情：succeeded 但 health 不认，到底是"装了没识别"还是"假成功"
const BASE = 'http://127.0.0.1:3000';

const r = await fetch(`${BASE}/api/health/local-post/runtime/install-jobs?runtimeKey=ytdlp`, { signal: AbortSignal.timeout(15000) });
const j = await r.json();
const jobs = j.jobs || j.data || [];
console.log('=== install-jobs (ytdlp) ===');
console.log(JSON.stringify(jobs, null, 2).slice(0, 3000));

console.log('\n=== health 全量 localPostBackends ===');
const h = await (await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(15000) })).json();
console.log(JSON.stringify(h.localPostBackends || {}, null, 2).slice(0, 1500));

console.log('\n=== 关键判定 ===');
const j0 = jobs[0] || {};
const ytdlp = (h.localPostBackends || {}).ytdlp || {};
console.log('job.status          =', j0.status);
console.log('job.installedVersion=', JSON.stringify(j0.installedVersion));
console.log('job.targetVersion   =', JSON.stringify(j0.targetVersion));
console.log('job.error           =', JSON.stringify(j0.error));
console.log('job.stage/message   =', j0.stage, '|', j0.message);
console.log('health.ytdlp        =', JSON.stringify(ytdlp));
console.log('');
if (j0.installedVersion && !ytdlp.detectedPath) {
  console.log('→ 判定【装了但没识别】：已装版本=' + j0.installedVersion + '，但 health 没探测到路径。');
  console.log('  可能：① 后端探测路径与安装路径不一致 ② health 结果有缓存需刷新 ③ 后端需重启加载');
} else if (!j0.installedVersion) {
  console.log('→ 判定【假成功】：任务报 succeeded 但 installedVersion 为空（实际没装上）');
} else {
  console.log('→ 已识别：detectedPath =', ytdlp.detectedPath);
}
