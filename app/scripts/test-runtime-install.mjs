/**
 * 运行时「一键安装 / 一键卸载」回归测试。
 *
 * 覆盖点：
 *   1. 自定义路径校验（合法路径放行 / 危险目录拦截）
 *   2. 安装到中文自定义目录（验证中文路径 + 文件真实落地）
 *   3. 卸载是否清干净（目录 + manifest）
 *   4. 非法 runtimeKey 是否被拒绝
 *   5. 测试结束后把环境恢复原状
 *
 * 用法（需先启动画布后端 npm run dev:full）：
 *   node scripts/test-runtime-install.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const BASE = process.env.HMDAO_API_BASE || 'http://127.0.0.1:8792';
const RUNTIME_KEY = 'ytdlp';
// 必须放在项目目录之外：后端安全策略会拒绝写入 APP_DIR（项目源码目录），
// 放在项目内会被 target-dir-not-allowed 拦掉（这正是防护生效的证明，但不是本测试的意图）。
const TEST_ROOT = process.env.HMDAO_RUNTIME_TEST_DIR || path.join(os.tmpdir(), 'hmdao-runtime-install-test');
// 中文目录：验证自定义路径 + 中文编码是否被正确处理
const CUSTOM_DIR = path.join(TEST_ROOT, '自定义目录', '运行时');

let passed = 0;
let failed = 0;

function report(ok, label, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}${detail ? `  (${detail})` : ''}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ''}`);
  }
}

async function api(pathname, method = 'GET', body = null) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: { raw: text } };
  }
}

async function waitJob(jobId, timeoutMs = 240000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const r = await api(`/api/health/local-post/runtime/install/${jobId}`);
    const job = r.body?.job;
    if (!job) throw new Error(`job ${jobId} not found`);
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('job timeout');
}

function findFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
}

async function main() {
  console.log('=== 运行时安装/卸载回归测试 ===');
  console.log(`后端: ${BASE}`);
  console.log(`测试目录: ${CUSTOM_DIR}\n`);

  // 记录初始状态，便于最后恢复
  const initial = await api('/api/health');
  if (initial.status !== 200) {
    console.error('后端未就绪，请先运行 npm run dev:full');
    process.exit(1);
  }
  const initialYtdlp = initial.body?.capabilities?.localPostBackends?.[RUNTIME_KEY] || {};
  console.log(`初始 ${RUNTIME_KEY} 状态: configured=${initialYtdlp.configured}`);
  console.log(`初始路径: ${initialYtdlp.detectedPath || '(无)'}\n`);

  // ---- 1. 路径校验 ----
  console.log('[1] 自定义路径校验');
  const bad = await api('/api/health/local-post/runtime/validate-path', 'POST', {
    path: process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc',
  });
  report(bad.body?.forbidden === true, '危险目录应被拦截', `forbidden=${bad.body?.forbidden}`);

  const good = await api('/api/health/local-post/runtime/validate-path', 'POST', { path: CUSTOM_DIR });
  report(good.body?.ok === true, '普通自定义目录应放行', `ok=${good.body?.ok}`);

  // ---- 2. 非法 runtimeKey ----
  console.log('\n[2] 非法 runtimeKey 校验');
  const bogus = await api('/api/health/local-post/runtime/install', 'POST', { runtimeKey: 'not-a-real-runtime' });
  report(bogus.status === 400, '非法 runtimeKey 应返回 400', `status=${bogus.status}`);

  // ---- 3. 安装到中文自定义目录 ----
  console.log('\n[3] 安装到中文自定义目录');
  const installRes = await api('/api/health/local-post/runtime/install', 'POST', {
    runtimeKey: RUNTIME_KEY,
    requestedAction: 'install',
    targetDir: CUSTOM_DIR,
  });
  const jobId = installRes.body?.job?.id;
  report(Boolean(jobId), '安装任务应创建成功', `jobId=${jobId || '无'}`);

  if (!jobId) {
    console.log('\n无法继续，安装任务未创建');
    process.exit(1);
  }

  const job = await waitJob(jobId);
  report(job.status === 'succeeded', '安装任务应成功', `status=${job.status} err=${job.error || '无'}`);
  report(job.verified === true, '安装后自检应通过', `verified=${job.verified}`);

  const files = findFiles(CUSTOM_DIR);
  report(files.length > 0, '中文目录下应有真实文件', `${files.length} 个文件`);
  if (files.length) {
    console.log(`        示例: ${files[0]}`);
  }

  // 后端应能探测到新路径（中文路径不乱码）
  const afterInstall = await api('/api/health/local-post/refresh', 'POST');
  const detected = afterInstall.body?.capabilities?.localPostBackends?.[RUNTIME_KEY] || {};
  const detectedPath = String(detected.detectedPath || '');
  report(detected.configured === true, '后端应识别为已配置', `configured=${detected.configured}`);
  report(detectedPath.includes('自定义目录'), '探测路径应保留中文目录名', detectedPath);
  if (detectedPath) {
    report(fs.existsSync(detectedPath), '探测到的可执行文件应真实存在', detectedPath);
  }

  // ---- 4. 卸载 ----
  console.log('\n[4] 一键卸载');
  const uninstallRes = await api('/api/health/local-post/runtime/uninstall', 'POST', {
    runtimeKey: RUNTIME_KEY,
  });
  report(uninstallRes.body?.success === true, '卸载请求应成功', `success=${uninstallRes.body?.success}`);

  const remaining = findFiles(CUSTOM_DIR);
  report(remaining.length === 0, '卸载后目录应被清空', `${remaining.length} 个残留文件`);

  // ---- 5. 恢复原状 ----
  console.log('\n[5] 恢复初始状态');
  if (initialYtdlp.configured) {
    const restore = await api('/api/health/local-post/runtime/install', 'POST', {
      runtimeKey: RUNTIME_KEY,
      requestedAction: 'install',
    });
    const restoreId = restore.body?.job?.id;
    if (restoreId) {
      const restoreJob = await waitJob(restoreId);
      report(restoreJob.status === 'succeeded', '应恢复到默认目录', `status=${restoreJob.status}`);
    } else {
      report(false, '恢复安装任务未创建');
    }
  } else {
    console.log('  跳过：初始未安装该运行时');
  }

  // 清理测试目录
  if (fs.existsSync(TEST_ROOT)) {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  }

  console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('\n测试异常终止:', error.message);
  process.exit(1);
});
