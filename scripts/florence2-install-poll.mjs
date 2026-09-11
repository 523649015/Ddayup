// 轮询 Florence-2 安装 job 进度，每 12s 打印一次 stage/progress/message，直到终态或超时。
const JOB_ID = 'abf7a372-20f4-43d4-9421-f2676637f99f';
const URL = `http://127.0.0.1:8792/api/health/local-post/runtime/install/${JOB_ID}`;
const MAX_MS = 30 * 60 * 1000;
const start = Date.now();

async function pollOnce() {
  const r = await fetch(URL);
  const j = await r.json();
  const job = j.job || j;
  const t = ((Date.now() - start) / 1000).toFixed(0).padStart(4);
  console.log(`[${t}s] status=${job.status} stage=${job.stage} progress=${job.progress}% msg=${job.message}${job.error ? ' ERR=' + job.error : ''}`);
  return job;
}

(async () => {
  while (Date.now() - start < MAX_MS) {
    let job;
    try {
      job = await pollOnce();
    } catch (e) {
      console.log('poll error:', e.message);
      await new Promise((r) => setTimeout(r, 12000));
      continue;
    }
    if (job.status === 'done' || job.status === 'failed' || job.status === 'canceled') {
      console.log('=== 终态:', job.status, '===');
      if (job.doctor) console.log('doctor:', JSON.stringify(job.doctor));
      process.exit(job.status === 'done' ? 0 : 1);
    }
    await new Promise((r) => setTimeout(r, 12000));
  }
  console.log('=== 轮询超时（安装仍在服务端后台进行）===');
  process.exit(2);
})();
