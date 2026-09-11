// 测试：公开 board 是否无需登录就能拿到 window.app 数据
import { chromium } from 'playwright';

const log = (...a) => console.log(...a);
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
});
const page = await ctx.newPage();

// 找一个公开 board（花瓣首页推荐 board，通常公开）
const URL = process.argv[2] || 'https://huaban.com/boards/25439500';
log('=== probing board', URL, '===');

try {
  const resp = await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 25000 });
  log('goto status:', resp && resp.status());
  await page.waitForTimeout(6000);

  const dump = await page.evaluate(() => {
    const out = { title: document.title, captcha: !!document.querySelector('.captcha, iframe[src*="captcha"]') };
    out.imgs = Array.from(document.querySelectorAll('img')).map((i) => i.src).filter(Boolean).slice(0, 20);
    out.imgContainers = document.querySelectorAll('.pin, [data-id], .waterfall-item').length;
    // 试 window.app
    try {
      if (window.app) {
        out.appKeys = Object.keys(window.app);
        out.appPinsType = typeof window.app.pins;
        if (window.app.pins) {
          out.appPinsKeys = Object.keys(window.app.pins);
          // Backbone 集合
          const byId = window.app.pins._byId || window.app.pins.models;
          if (byId) {
            const arr = Array.isArray(byId) ? byId : Object.values(byId);
            out.pinCount = arr.length;
            const first = arr[0];
            if (first) {
              const json = first.toJSON ? first.toJSON() : (first.attributes || first);
              out.firstPin = JSON.stringify(json).slice(0, 600);
            }
          }
        }
      }
    } catch (e) { out.appErr = e.message; }
    return out;
  });
  log('captcha:', dump.captcha, 'title:', dump.title);
  log('imgContainers:', dump.imgContainers, 'imgs:', dump.imgs.length);
  dump.imgs.slice(0, 8).forEach((u) => log('  img:', u.slice(0, 140)));
  log('appKeys:', JSON.stringify(dump.appKeys));
  log('appPinsKeys:', JSON.stringify(dump.appPinsKeys));
  log('pinCount:', dump.pinCount);
  if (dump.firstPin) log('firstPin:', dump.firstPin.slice(0, 500));
} catch (e) {
  log('ERR:', e.message);
}
await browser.close();
