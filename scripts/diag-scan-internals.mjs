import { createRequire } from 'module';
import http from 'http';
const require = createRequire('file:///f:/Work/HMDAODAO/app/package.json');
const { chromium } = require('playwright');
const EXT_PATH = 'f:/Work/HMDAODAO/extension';
const PORT = 19120;
const PAGES = {
  '/yunqiaowang.html': `<!doctype html><html><head><meta charset="utf-8"><title>云桥网 镜像</title></head><body>
    <h1>3D 模型演示视频</h1>
    <div class="player"><iframe src="https://player.youku.com/embed/XNjUzMzE5NzY0MA==" width="640" height="360"></iframe></div>
    <p>视频由优酷提供</p>
  </body></html>`,
};
const LIBLIB_JSON = JSON.stringify({ items: [{ id: 'm1', cover: 'x', videoUrl: 'https://liblibai-online.liblib.cloud/preview/m1.mp4?sign=abc' }] });
const server = http.createServer((req, res) => {
  const u = req.url.split('#')[0];
  if (PAGES[u]) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(PAGES[u]); }
  if (u.startsWith('/api/www/model/search')) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(LIBLIB_JSON); }
  res.writeHead(404); res.end('nf');
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${PORT}`;
const ctx = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`] });
try {
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  console.log('extId', extId);
  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  const p = await ctx.newPage();
  await p.goto(BASE + '/yunqiaowang.html');
  await p.waitForTimeout(1200);
  // dump 源页 captures
  const dbg = await p.evaluate(() => ({
    hasCaptures: !!window.__hmdao_captures,
    keys: window.__hmdao_captures ? Object.keys(window.__hmdao_captures) : [],
    apiVideos: window.__hmdao_captures ? window.__hmdao_captures.apiVideos : 'n/a',
    iframes: Array.from(document.querySelectorAll('iframe')).map((f) => f.src),
  }));
  console.log('SRC DBG:', JSON.stringify(dbg, null, 1));
  // 手动触发扫描
  await panel.evaluate(() => new Promise((res) => chrome.storage.local.remove('lastScan', res)));
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'HMDAO_SCAN_REQUEST' }));
  let last = [];
  for (let i = 0; i < 15; i++) {
    await p.waitForTimeout(400);
    const s = await panel.evaluate(() => new Promise((res) => chrome.storage.local.get('lastScan', (r) => res(r.lastScan || []))));
    if (s && s.length) { last = s; if (i > 3) break; }
  }
  console.log('LAST SCAN:', JSON.stringify(last, null, 1));
  await ctx.close(); server.close(); process.exit(0);
} catch (e) { console.error('ERR', e && e.stack || e); await ctx.close(); server.close(); process.exit(2); }
