// phase23-pick-via-backend.e2e.mjs
// 真实浏览器 E2E（验收「选择目录」已改【后端原生目录选择器优先】这一修复的核心契约）：
//   在真 Chrome 里加载扩展，点击真实的「选择目录」按钮（.pathPick[data-type="image"]），
//   经由扩展【真实代码路径】fetch → __pickDirViaBackend → 后端 /api/settings/assets/pick-directory
//   → 拿到真实绝对路径 → saveDirPath → 写入 window.dirPaths.image。
//
//   全程【不伪造不 mock】：用 addInitScript 在页面侧把 pick-directory 的请求体改写为
//   { autoSelectPath: <验收目录> } 再转发给【真实后端】，后端据此直接返回已 path.resolve 的绝对路径
//   （与 phase20 验证过的契约一致），从而真实走完「点选择目录 → 落盘目录设上」的代码链路。
//
//   覆盖点：
//   1) 点击 .pathPick 后，window.dirPaths.image === 验收绝对路径（后端优先路径真的生效）。
//   2) 侧栏 .pathText 显示「✅ 已设置：<路径>」，且不再显示「尚未设置目录」。
//   3) 点击 .pathTest（probe-dir 验证目录可写）不报错。
//   4) 驱动真实函数 tryWriteUserDirFromUrl → 指定路径下确实出现文件，且 sha256 与源一致。
//
// 运行：node tests/phase23-pick-via-backend.e2e.mjs
// 前置：后端 127.0.0.1:3000（Vite，/api/* → 8792 API）可健康；不可用则测试内自行启动。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '..');
const APP = path.resolve(HERE, '../../app');
const API_BASE = 'http://127.0.0.1:3000';

// 从 app 的 node_modules 解析 playwright（扩展目录没装）
const requireApp = createRequire(path.join(APP, 'package.json'));
let chromium;
try { ({ chromium } = requireApp('playwright')); }
catch (e) { console.error('无法加载 playwright：', e && e.message); process.exit(2); }

// 极小但【可解码】的 1x1 JPEG
const FIXTURE_JPG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

let pass = 0, fail = 0, skip = false;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { console.log('  ✓', name); pass++; }
  else { console.log('  ✗', name, extra ? ('\n      → ' + extra) : ''); fail++; failures.push(name + (extra ? ' :: ' + extra : '')); }
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function healthOk(timeoutMs = 1500) {
  try {
    // 用确定存在的端点判定健康（/api/health 不存在）
    const r = await fetch(API_BASE + '/api/settings/assets', { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch (_) { return false; }
}

// 后端起不来时自行拉起；返回 { child } （child 为 null 表示复用已在运行的后端）
async function ensureBackend() {
  if (await healthOk()) { console.log('[e2e] 后端已在运行：', API_BASE); return { child: null }; }
  console.log('[e2e] 后端不可用，尝试启动 server/dev-full.mjs …');
  const child = spawn(process.execPath, ['server/dev-full.mjs'], { cwd: APP, stdio: 'ignore', windowsHide: true });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await healthOk(2000)) { console.log('[e2e] 后端已启动'); return { child }; }
    await sleep(1500);
  }
  throw new Error('后端启动超时（60s）');
}

// 起一个静态 fixture 服务，提供可解码图片字节
async function startFixtureServer() {
  const server = http.createServer((req, res) => {
    const u = (req.url || '').split('?')[0];
    if (u === '/fixture.jpg') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': String(FIXTURE_JPG.length) });
      res.end(FIXTURE_JPG);
    } else { res.writeHead(404); res.end('not found'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { server, port, base: `http://127.0.0.1:${port}` };
}

async function launchWithExtension(userDataDir) {
  const args = [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  // 先试有头（扩展 + headless 兼容性最好）
  try {
    const ctx = await chromium.launchPersistentContext(userDataDir, { headless: false, args, chromiumSandbox: false });
    return { ctx, mode: 'headed' };
  } catch (e) {
    console.warn('[e2e] headed 启动失败，回退 headless(new)：', e && e.message);
  }
  // 回退：新版无头模式（Playwright 用 --headless=new，支持 --load-extension）
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    args: [...args, '--headless=new'],
    chromiumSandbox: false,
  });
  return { ctx, mode: 'headless-new' };
}

async function extensionIdFrom(context) {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const m = /^chrome-extension:\/\/([^/]+)\//.exec(sw.url());
  if (!m) throw new Error('无法从 service worker URL 解析扩展 ID：' + sw.url());
  return m[1];
}

async function main() {
  // ★验收目标目录：默认即用户指定的真实绝对路径；可用 DDAYUP_TARGET_DIR 覆盖。
  const targetDir = process.env.DDAYUP_TARGET_DIR
    || 'C:\\Users\\123\\Downloads\\Ddayup素材';
  // 仅创建目录本身（不删除！清理时只删本测试产生的 e2e-* 文件，绝不 rmdir 用户目录）
  fs.mkdirSync(targetDir, { recursive: true });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddayup-e2e-p23-ud-'));
  let backend = { child: null };
  let fixture = null;
  let ctx = null;
  try {
    backend = await ensureBackend();
    fixture = await startFixtureServer();
    console.log('[e2e] fixture 服务：', fixture.base);

    // 先独立验证「后端 pick-directory 支持 autoSelectPath 返回真实绝对路径」这一基础契约
    // （与 phase20 一致；phase23 的 addInitScript 正是依赖该契约把请求体改写为 autoSelectPath）。
    const pickRes = await fetch(API_BASE + '/api/settings/assets/pick-directory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoSelectPath: targetDir }),
    });
    const pickJson = await pickRes.json().catch(() => ({}));
    ok('pick-directory 支持 autoSelectPath 并返回真实绝对路径',
      pickRes.ok && pickJson && pickJson.success === true
      && pickJson.path && path.resolve(pickJson.path) === path.resolve(targetDir),
      `status=${pickRes.status} body=${JSON.stringify(pickJson)}`);

    let launched;
    try {
      launched = await launchWithExtension(userDataDir);
    } catch (e) {
      console.error('\n!! SKIP：无法启动带扩展的浏览器 → ' + (e && e.message));
      console.error('   具体报错：', e);
      skip = true;
      return;
    }
    ctx = launched.ctx;
    console.log('[e2e] 浏览器模式：', launched.mode);

    const extId = await extensionIdFrom(ctx);
    console.log('[e2e] 扩展 ID：', extId, ' 验收目标目录：', targetDir);

    // ★核心：用 addInitScript 在页面侧拦截 pick-directory 请求，
    // 把请求体改写为 { autoSelectPath: <验收目录> } 再转发给真实后端。
    // 这样点击真实「选择目录」按钮时会走完 fetch → __pickDirViaBackend → 后端 → saveDirPath 全链路。
    await ctx.addInitScript((target) => {
      const realFetch = window.fetch ? window.fetch.bind(window) : null;
      window.fetch = async (url, opts) => {
        const u = String(url || '');
        if (u.includes('/api/settings/assets/pick-directory') && realFetch) {
          const newOpts = Object.assign({}, opts, {
            body: JSON.stringify({ autoSelectPath: target }),
          });
          try { return await realFetch(u, newOpts); }
          catch (e) { return { ok: false, status: 0, json: async () => ({ error: String(e && e.message || e) }) }; }
        }
        return realFetch ? realFetch(url, opts) : fetch(url, opts);
      };
    }, targetDir);

    const page = await ctx.newPage();
    page.on('console', (m) => { const t = m.text(); if (/\[Ddayup\]\[userdir\]/.test(t)) console.log('[page]', t); });
    await page.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'load' });
    await sleep(600);

    // 确保扩展真实函数已就绪
    await page.waitForFunction(
      () => typeof tryWriteUserDirFromUrl === 'function' && typeof __pickDirViaBackend === 'function',
      undefined, { timeout: 8000 },
    ).catch(() => {});

    // === 关键动作 1：点击真实「选择目录」按钮（按钮位于可折叠 <details> 内，用程序化 .click() 触发）===
    const pickClicked = await page.evaluate(() => {
      const btn = document.querySelector('.pathPick[data-type="image"]');
      if (!btn) return { ok: false, reason: '找不到 .pathPick[data-type="image"]' };
      btn.click();
      return { ok: true };
    });
    ok('真实 .pathPick[image] 按钮存在且可触发点击', pickClicked.ok, pickClicked.reason);

    // 等待后端返回路径并写入 window.dirPaths.image
    const picked = await page.waitForFunction(
      (d) => window.dirPaths && window.dirPaths.image === d,
      targetDir, { timeout: 15000 },
    ).then(() => true).catch(() => false);
    ok('点击「选择目录」后 window.dirPaths.image === 验收绝对路径（后端优先路径生效）', picked);

    const imgDir = await page.evaluate(() => window.dirPaths && window.dirPaths.image);
    ok('dirPaths.image 确为后端返回的真实绝对路径', imgDir === targetDir, '实际=' + imgDir);

    // === 关键动作 2：侧栏文案反映「已设置」，且不再显示「尚未设置目录」===
    const textState = await page.evaluate(() => {
      const sp = document.querySelector('.pathText[data-type="image"]');
      const t = sp ? sp.textContent || '' : '';
      return { text: t, hasSet: t.includes('已设置：'), hasUnset: t.includes('尚未设置目录') };
    });
    ok('侧栏 .pathText 显示「已设置：<路径>」', textState.hasSet, 'text=' + JSON.stringify(textState.text));
    ok('侧栏 .pathText 不再显示「尚未设置目录」', !textState.hasUnset, 'text=' + JSON.stringify(textState.text));

    // === 关键动作 3：点击「测试」按钮（probe-dir 验证目录可写），不应报错 ===
    const testClicked = await page.evaluate(() => {
      const btn = document.querySelector('.pathTest[data-type="image"]');
      if (!btn) return { ok: false, reason: '找不到 .pathTest[data-type="image"]' };
      btn.click();
      return { ok: true };
    });
    ok('真实 .pathTest[image] 按钮存在且可触发点击', testClicked.ok, testClicked.reason);
    await sleep(800);

    // === 关键动作 4：驱动真实函数 tryWriteUserDirFromUrl → 文件物理落盘到验收目录 ===
    const imgUrl = fixture.base + '/fixture.jpg';
    const okImg = await page.evaluate(async ({ u, fn }) => {
      const asset = { type: 'image', url: u, size: 0, name: fn };
      return await tryWriteUserDirFromUrl(asset, u, fn);
    }, { u: imgUrl, fn: 'e2e-pick.jpg' });
    ok('image 落盘调用返回 true（走后端通道）', okImg === true, '实际=' + okImg);

    // === 验收标准：指定路径下确实出现文件，且字节与源完全一致 ===
    const imgPath = path.join(targetDir, 'e2e-pick.jpg');
    ok('指定路径存在 e2e-pick.jpg', fs.existsSync(imgPath), imgPath);
    if (fs.existsSync(imgPath)) {
      const b = fs.readFileSync(imgPath);
      ok('e2e-pick.jpg 字节数正确', b.length === FIXTURE_JPG.length, `${b.length} vs ${FIXTURE_JPG.length}`);
      ok('e2e-pick.jpg sha256 与源一致', sha256(b) === sha256(FIXTURE_JPG));
    }
  } catch (e) {
    console.error('\n!! E2E 异常：', e && e.stack || e);
    fail++;
    failures.push('E2E exception :: ' + (e && e.message));
  } finally {
    try { if (ctx) await ctx.close(); } catch (_) {}
    try { if (fixture) fixture.server.close(); } catch (_) {}
    try { if (backend && backend.child) backend.child.kill(); } catch (_) {}
    // 只删除本测试产生的 e2e-* 文件，绝不 rmdir 用户的真实验收目录
    try {
      for (const f of ['e2e-pick.jpg']) {
        const p = path.join(targetDir, f);
        if (fs.existsSync(p)) fs.rmSync(p, { force: true });
      }
    } catch (_) {}
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
  }
}

await main();

if (skip) {
  console.log('\n==== phase23-pick-via-backend (E2E) ====');
  console.log('SKIP：本机无法启动带扩展的浏览器（未伪造通过）');
  console.log('TOTAL 0 / PASS 0 / FAIL 0 / SKIP 1');
  process.exit(0);
}

console.log('\n==== phase23-pick-via-backend (E2E) ====');
console.log(`TOTAL ${pass + fail} / PASS ${pass} / FAIL ${fail}`);
if (failures.length) { console.log('失败项：\n - ' + failures.join('\n - ')); process.exit(1); }
console.log('✅ 全部通过');
process.exit(0);
