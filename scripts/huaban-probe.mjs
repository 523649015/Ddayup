// 探针：花瓣 huaban.com/pins/7090556023 真实页面数据流
import { chromium } from 'playwright';

const log = (...a) => console.log(...a);
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
});
const page = await ctx.newPage();

const apiHits = [];
page.on('response', async (r) => {
  try {
    const u = r.url();
    if (/huaban\.com|hbimg|upaiyun|bdimg/.test(u)) {
      apiHits.push({ status: r.status(), url: u });
    }
  } catch (_) {}
});

try {
  await page.goto('https://huaban.com/pins/7090556023', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await new Promise((r) => setTimeout(r, 6000));
  log('title=', await page.title());
  const data = await page.evaluate(() => {
    const out = { imgs: [], videos: [], hasPin: !!window.pin, hasApp: !!window.app, hasInit: !!window.__INITIAL_STATE__, hasNext: !!window.__NEXT_DATA__, appKeys: window.app ? Object.keys(window.app) : null, scripts: [] };
    out.imgs = Array.from(document.querySelectorAll('img')).map((i) => i.src).filter(Boolean).slice(0, 50);
    out.videos = Array.from(document.querySelectorAll('video source, video[src]')).map((v) => v.src || v.getAttribute('src')).filter(Boolean).slice(0, 30);
    // 找内嵌 JSON
    const scs = Array.from(document.querySelectorAll('script')).slice(0, 30);
    for (const s of scs) {
      const t = s.textContent || '';
      if (t.length > 200 && t.length < 500000 && /pin|board|hbimg|file/.test(t)) {
        out.scripts.push(t.slice(0, 500));
      }
    }
    return out;
  });
  log('imgs:', data.imgs.length);
  data.imgs.slice(0, 15).forEach((u) => log('  img:', u.slice(0, 200)));
  log('videos:', data.videos.length);
  data.videos.forEach((u) => log('  vid:', u.slice(0, 200)));
  log('hasApp=', data.hasApp, 'keys=', JSON.stringify(data.appKeys));
  log('init scripts:', data.scripts.length);
  data.scripts.slice(0, 3).forEach((s, i) => log('  script[' + i + ']:', s));
  log('api responses captured:', apiHits.length);
  apiHits.slice(0, 30).forEach((r) => log('  api', r.status, r.url.slice(0, 220)));
} catch (e) {
  log('err:', e.message);
}
await browser.close();
