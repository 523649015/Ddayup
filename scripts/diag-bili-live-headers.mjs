// 真实诊断：加载 Ddayup 扩展后，打开 B站播放页，捕获发往 bilivideo.com 的真实请求头，
// 并点击播放触发真实视频流，对比「扩展启用」vs「扩展禁用」两种情况。
//
// 用法：
//   node scripts/diag-bili-live-headers.mjs            # 启用扩展（实验组）
//   node scripts/diag-bili-live-headers.mjs noext     # 不加载扩展（对照组）

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(__dirname, '../extension');
const NOEXT = process.argv.includes('noext');
const BILI_VIDEO_URL = process.env.BILI_URL || 'https://www.bilibili.com/video/BV1GJ411x7h7';

console.log('==================== B站真实请求头诊断 ====================');
console.log('模式:', NOEXT ? '【对照组】不加载扩展（应正常播放）' : '【实验组】加载 Ddayup 扩展（应复现 403）');

const userDataDir = path.resolve(__dirname, NOEXT ? '../tmp/cdp-noext' : '../tmp/cdp-ext');
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: NOEXT
    ? ['--no-sandbox']
    : [`--no-sandbox`, `--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
});
const browser = context.browser();
const page = await context.newPage();

const biliRequests = [];
const biliFailures = [];
const pageErrors = [];
const consoleErrors = [];

page.on('request', (req) => {
  const u = req.url();
  if (/bilivideo\.(com|cn)/.test(u)) {
    biliRequests.push({
      url: u.slice(0, 80) + (u.length > 80 ? '…' : ''),
      referer: req.headers()['referer'] || '(无)',
      origin: req.headers()['origin'] || '(无)',
      resourceType: req.resourceType(),
    });
  }
});
page.on('requestfailed', (req) => {
  const u = req.url();
  if (/bilivideo\.(com|cn)/.test(u)) biliFailures.push({ url: u.slice(0, 80), error: req.failure()?.errorText });
});
page.on('response', (resp) => {
  const u = resp.url();
  if (/bilivideo\.(com|cn)/.test(u) && resp.status() >= 400) biliFailures.push({ url: u.slice(0, 80), status: resp.status() });
});
page.on('pageerror', (err) => pageErrors.push((err.stack || err.message).split('\n').slice(0, 4).map((s) => s.slice(0, 200)).join(' ⏎ ')));
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 160)); });

try {
  await page.goto(BILI_VIDEO_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
} catch (e) {
  console.log('⚠️ B站页面加载失败（可能网络不可达）:', e.message);
}

// 点击播放按钮触发真实 DASH 视频流（media 类型 m4s 请求）
try {
  await page.waitForSelector('video, .bpx-player-video, .bilibili-player-video', { timeout: 8000 });
  await page.click('video, .bpx-player-video, .bilibili-player-video', { timeout: 5000 }).catch(() => {});
} catch (_) {}
await page.waitForTimeout(12000);

console.log('\n--- bilivideo 请求头样本（前 8 条）---');
if (biliRequests.length === 0) console.log('（未捕获到 bilivideo 请求）');
else biliRequests.slice(0, 8).forEach((r, i) => {
  console.log(`[${i}] ${r.resourceType} ${r.url}`);
  console.log(`     referer=${r.referer}`);
  console.log(`     origin =${r.origin}`);
});

console.log('\n--- 失败/4xx 的 bilivideo 请求（前 10 条）---');
if (biliFailures.length === 0) console.log('（无失败/4xx 记录）');
else biliFailures.slice(0, 10).forEach((f, i) => console.log(`[${i}] status=${f.status || ''} err=${f.error || ''} ${f.url}`));

console.log('\n--- 页面 JS 异常（前 10 条）---');
if (pageErrors.length === 0) console.log('（无 pageerror）');
else pageErrors.slice(0, 10).forEach((e, i) => console.log(`[${i}] ${e}`));

console.log('\n--- 页面 console.error（前 10 条）---');
if (consoleErrors.length === 0) console.log('（无 console error）');
else consoleErrors.slice(0, 10).forEach((e, i) => console.log(`[${i}] ${e}`));

let probe = {};
try {
  probe = await page.evaluate(() => ({
    hasInjectMain: !!window.__hmdao_installed,
    hasModelCapture: !!window.__hmdao_model_capture || !!window.__hmdao_api_video_capture,
    biliPlayGuard: (typeof __hmdao_isBiliPlayPage === 'function') ? __hmdao_isBiliPlayPage() : 'n/a',
    modelCaptureSkipped: !!window.__hmdao_model_capture_skipped,
  }));
} catch (_) { probe = { note: '页面导航导致探针未执行（不影响诊断结论）' }; }
console.log('\n--- 扩展加载状态 ---');
console.log(JSON.stringify(probe));
if (!NOEXT && !probe.hasInjectMain) console.log('⚠️ 扩展未生效，实验组结果不可信！');

await browser.close();
console.log('\n==================== 诊断结束 ====================');
