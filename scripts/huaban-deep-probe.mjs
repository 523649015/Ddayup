// 深度探针：弄清 huaban 详情页真实数据结构 + API 返回，定位为什么扩展采不到
import { chromium } from 'playwright';

const log = (...a) => console.log(...a);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
});
const page = await ctx.newPage();

const apiLog = [];
page.on('response', async (r) => {
  try {
    const u = r.url();
    if (/huaban\.com|api\.huaban|hbimg|upaiyun|captcha|eo\.qq/.test(u)) {
      apiLog.push({ status: r.status(), url: u, type: r.headers()['content-type'] || '' });
    }
  } catch (_) {}
});

const URL = process.argv[2] || 'https://huaban.com/pins/7090556023';
log('=== probing', URL, '===');

try {
  const resp = await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 25000 });
  log('goto status:', resp && resp.status());
  await page.waitForTimeout(5000);

  const dump = await page.evaluate(() => {
    const out = { title: document.title, url: location.href };
    // 1) 找 captcha
    out.captcha = !!document.querySelector('.captcha, #captcha, iframe[src*="captcha"], .security-verification, .vcode');
    // 2) window.app 结构
    out.windowKeys = Object.keys(window).filter((k) => /app|pin|board|initial|state|data|page/i.test(k));
    // 3) 试读 window.app
    try {
      if (window.app) {
        const a = window.app;
        out.appType = typeof a;
        out.appKeys = Object.keys(a).slice(0, 20);
        // 找 pins
        if (a.pins) {
          out.pinsType = typeof a.pins;
          out.pinsKeys = typeof a.pins === 'object' ? Object.keys(a.pins).slice(0, 20) : null;
          const firstPin = typeof a.pins === 'object' ? Object.values(a.pins)[0] : null;
          out.firstPinSample = firstPin ? JSON.stringify(firstPin).slice(0, 800) : null;
        }
      }
    } catch (e) { out.appErr = e.message; }
    // 4) 所有 hbimg 链接（DOM 已渲染）
    out.imgs = Array.from(document.querySelectorAll('img')).map((i) => i.src).filter(Boolean).slice(0, 30);
    // 5) 找图片容器
    out.imgContainers = document.querySelectorAll('.pin, .pin-image, [data-id], .image-container, .waterfall-item').length;
    return out;
  });
  log('title:', dump.title);
  log('captcha present:', dump.captcha);
  log('windowKeys:', JSON.stringify(dump.windowKeys));
  log('appType:', dump.appType, 'appKeys:', JSON.stringify(dump.appKeys));
  log('pinsKeys:', JSON.stringify(dump.pinsKeys));
  if (dump.firstPinSample) log('firstPinSample:', dump.firstPinSample.slice(0, 600));
  log('imgContainers:', dump.imgContainers);
  log('imgs in DOM:', dump.imgs.length);
  dump.imgs.slice(0, 10).forEach((u) => log('  img:', u.slice(0, 160)));

  // 6) 直接试 huaban API（看无 cookie 返回什么）
  const apiTest = await page.evaluate(async (pinId) => {
    try {
      const r = await fetch('https://api.huaban.com/pins/' + pinId + '?fetch=1', {
        credentials: 'include',
        headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      });
      const txt = await r.text();
      return { status: r.status, bodyHead: txt.slice(0, 500) };
    } catch (e) { return { err: e.message }; }
  }, '7090556023');
  log('API test:', JSON.stringify(apiTest).slice(0, 600));

  log('--- apiLog (' + apiLog.length + ') ---');
  apiLog.slice(0, 25).forEach((r) => log('  ', r.status, r.type, r.url.slice(0, 130)));
} catch (e) {
  log('ERR:', e.message);
}
await browser.close();
