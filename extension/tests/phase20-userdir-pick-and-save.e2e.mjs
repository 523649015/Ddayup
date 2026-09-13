// phase20-userdir-pick-and-save.e2e.mjs
// 真实浏览器 E2E（本次验收核心）：在真 Chrome 里加载扩展，设置某类型保存目录（真实绝对路径），
// 再在页面上下文调用扩展【真实函数】tryWriteUserDirFromUrl 触发落盘（=「从侧栏下载」），
// 断言【指定路径下确实出现文件且 sha256 与源一致】才算验收成功。
//
// 覆盖点：
//   1) image 走「已设置路径 → 后端流式写盘」（小文件）
//   2) video  走同一通道，且【不被 60MB / 体积未知护栏拦下】（用数 MB 随机二进制模拟视频）
//   3) 反例：清空 dirPath 后重试 → 必须返回 false 且不产生新文件（未设置时不得误写）
//
// 运行：node tests/phase20-userdir-pick-and-save.e2e.mjs
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
// 数 MB 随机二进制（模拟视频；远小于 60MB，但用于证明「走同一后端通道、无体积护栏拦截」）
const FIXTURE_MP4 = Buffer.concat([Buffer.from('E2E.VIDEO.FIXTURE.'), crypto.randomBytes(4 * 1024 * 1024)]);

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

// 起一个静态 fixture 服务，提供可解码图片与「视频」字节
async function startFixtureServer() {
  const server = http.createServer((req, res) => {
    const u = (req.url || '').split('?')[0];
    if (u === '/fixture.jpg') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': String(FIXTURE_JPG.length) });
      res.end(FIXTURE_JPG);
    } else if (u === '/fixture.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(FIXTURE_MP4.length) });
      res.end(FIXTURE_MP4);
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
  // 运行前先清掉上次可能遗留的 e2e-* 文件，保证断言幂等（绝不碰用户其他文件）
  for (const f of fs.readdirSync(targetDir)) {
    if (/^e2e-image.*\.jpg$/.test(f) || f === 'e2e-video.mp4') {
      try { fs.rmSync(path.join(targetDir, f), { force: true }); } catch (_) {}
    }
  }
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddayup-e2e-ud-'));
  let backend = { child: null };
  let fixture = null;
  let ctx = null;
  try {
    backend = await ensureBackend();
    fixture = await startFixtureServer();
    console.log('[e2e] fixture 服务：', fixture.base);

    // === 回归：pick-directory 端点（此前 500，本次修复的语法错误）===
    // 用 autoSelectPath 绕过原生对话框，直接验证「返回真实绝对路径」这一核心契约。
    const pickRes = await fetch(API_BASE + '/api/settings/assets/pick-directory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoSelectPath: targetDir }),
    });
    const pickJson = await pickRes.json().catch(() => ({}));
    ok('pick-directory 不再返回 500（已修复 PowerShell 未闭合引号）',
      pickRes.ok && pickJson && pickJson.success === true, `status=${pickRes.status} body=${JSON.stringify(pickJson)}`);
    ok('pick-directory 返回真实绝对路径', pickJson && pickJson.path
      && path.resolve(pickJson.path) === path.resolve(targetDir), JSON.stringify(pickJson));

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

    const page = await ctx.newPage();
    page.on('console', (m) => { const t = m.text(); if (/\[Ddayup\]\[userdir\]/.test(t)) console.log('[page]', t); });
    await page.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'load' });
    await sleep(500);

    // 用真实 chrome.storage 写入目标绝对路径（模拟「已设置」），再重载让 restoreDirPaths 生效
    await page.evaluate(({ dir }) => chrome.storage.local.set({ 'dirPath:image': dir, 'dirPath:video': dir }), { dir: targetDir });
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(
      (d) => window.dirPaths && window.dirPaths.image === d && window.dirPaths.video === d,
      targetDir, { timeout: 8000 },
    ).catch(() => {});
    const restored = await page.evaluate(() => ({ image: window.dirPaths && window.dirPaths.image, video: window.dirPaths && window.dirPaths.video }));
    ok('已设置目录恢复进内存 dirPaths（image/video = 验收目录）',
      restored.image === targetDir && restored.video === targetDir, JSON.stringify(restored));

    // === 关键：调用扩展真实函数从「侧栏」落盘 ===
    const imgUrl = fixture.base + '/fixture.jpg';
    const vidUrl = fixture.base + '/fixture.mp4';
    const okImg = await page.evaluate(async (u) => {
      const asset = { type: 'image', url: u, size: 0, name: 'e2e-image.jpg' };
      return await tryWriteUserDirFromUrl(asset, u, 'e2e-image.jpg');
    }, imgUrl);
    const okVid = await page.evaluate(async (u) => {
      const asset = { type: 'video', url: u, size: 0, name: 'e2e-video.mp4' };
      return await tryWriteUserDirFromUrl(asset, u, 'e2e-video.mp4');
    }, vidUrl);

    ok('image 落盘调用返回 true（走后端通道）', okImg === true, '实际=' + okImg);
    ok('video 落盘调用返回 true（走同一后端通道，未被 60MB/体积未知护栏拦下）', okVid === true, '实际=' + okVid);

    // === 验收标准：指定路径下确实出现文件，且字节与源完全一致 ===
    const imgPath = path.join(targetDir, 'e2e-image.jpg');
    const vidPath = path.join(targetDir, 'e2e-video.mp4');
    ok('指定路径存在 e2e-image.jpg', fs.existsSync(imgPath), imgPath);
    ok('指定路径存在 e2e-video.mp4', fs.existsSync(vidPath), vidPath);
    if (fs.existsSync(imgPath)) {
      const b = fs.readFileSync(imgPath);
      ok('e2e-image.jpg 字节数正确', b.length === FIXTURE_JPG.length, `${b.length} vs ${FIXTURE_JPG.length}`);
      ok('e2e-image.jpg sha256 与源一致', sha256(b) === sha256(FIXTURE_JPG));
    }
    if (fs.existsSync(vidPath)) {
      const b = fs.readFileSync(vidPath);
      ok('e2e-video.mp4 字节数正确', b.length === FIXTURE_MP4.length, `${b.length} vs ${FIXTURE_MP4.length}`);
      ok('e2e-video.mp4 sha256 与源一致', sha256(b) === sha256(FIXTURE_MP4));
    }

    // === 同名去重（2026-09-15 修复）：再次下载同名文件必须落为「name (2).ext」，绝不覆盖原名 ===
    const okImgDup = await page.evaluate(async (u) => {
      const asset = { type: 'image', url: u, size: 0, name: 'e2e-image.jpg' };
      return await tryWriteUserDirFromUrl(asset, u, 'e2e-image.jpg');
    }, imgUrl);
    ok('同名去重：再次下载同名返回 true', okImgDup === true, '实际=' + okImgDup);
    const dupPath = path.join(targetDir, 'e2e-image (2).jpg');
    ok('同名去重：生成 e2e-image (2).jpg（未覆盖原名）', fs.existsSync(dupPath), dupPath);
    const origPath = path.join(targetDir, 'e2e-image.jpg');
    ok('同名去重：原 e2e-image.jpg 未被覆盖（字节数不变）',
      fs.existsSync(origPath) && fs.readFileSync(origPath).length === FIXTURE_JPG.length);
    if (fs.existsSync(dupPath)) {
      const b = fs.readFileSync(dupPath);
      ok('同名去重：e2e-image (2).jpg 字节数正确', b.length === FIXTURE_JPG.length, `${b.length} vs ${FIXTURE_JPG.length}`);
      ok('同名去重：e2e-image (2).jpg sha256 与源一致', sha256(b) === sha256(FIXTURE_JPG));
    }

    // === 反例：清空 dirPath → 必须 false 且不产生新文件 ===
    const before = new Set(fs.readdirSync(targetDir));
    await page.evaluate(() => {
      try { window.dirPaths.image = null; window.dirPaths.video = null; } catch (_) {}
      return chrome.storage.local.remove(['dirPath:image', 'dirPath:video']);
    });
    const okImg2 = await page.evaluate(async (u) => {
      const asset = { type: 'image', url: u, size: 0, name: 'e2e-image-2.jpg' };
      return await tryWriteUserDirFromUrl(asset, u, 'e2e-image-2.jpg');
    }, imgUrl);
    const after = fs.readdirSync(targetDir);
    const added = after.filter((f) => !before.has(f));
    ok('反例：清空 dirPath 后重试返回 false', okImg2 === false, '实际=' + okImg2);
    ok('反例：清空 dirPath 后未产生新文件', added.length === 0, JSON.stringify(added));
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
      for (const f of ['e2e-image.jpg', 'e2e-video.mp4', 'e2e-image-2.jpg', 'e2e-image (2).jpg']) {
        const p = path.join(targetDir, f);
        if (fs.existsSync(p)) fs.rmSync(p, { force: true });
      }
    } catch (_) {}
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
  }
}

await main();

if (skip) {
  console.log('\n==== phase20-userdir-pick-and-save (E2E) ====');
  console.log('SKIP：本机无法启动带扩展的浏览器（未伪造通过）');
  console.log('TOTAL 0 / PASS 0 / FAIL 0 / SKIP 1');
  process.exit(0);
}

console.log('\n==== phase20-userdir-pick-and-save (E2E) ====');
console.log(`TOTAL ${pass + fail} / PASS ${pass} / FAIL ${fail}`);
if (failures.length) { console.log('失败项：\n - ' + failures.join('\n - ')); process.exit(1); }
console.log('✅ 全部通过');
process.exit(0);
