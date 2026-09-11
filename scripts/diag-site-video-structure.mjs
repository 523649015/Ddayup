// 深度拆解：监听动态 XHR/fetch 响应里出现的视频 CDN 与 JSON 视频字段
import { chromium } from 'playwright';

const TARGETS = [
  'https://www.liblib.art/search?keyword=3d%E6%A8%A1%E5%9E%8B&type=text',
  'https://www.yunqiaowang.cn/70812.html',
];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36' });
const page = await ctx.newPage();

for (const url of TARGETS) {
  console.log('\n===== ' + url + ' =====');
  const mediaReq = [];
  const apiVideoHits = [];
  page.on('response', (r) => {
    const ct = (r.headers()['content-type'] || '').toLowerCase();
    const u = r.url();
    if (ct.startsWith('video/') || /\.(mp4|webm|m3u8|m4s|mov)(\?|$)/i.test(u)) {
      mediaReq.push({ ct, u: u.slice(0, 160), status: r.status() });
    }
    // 捕获接口 JSON 里的视频直链 / 平台字段
    if (ct.includes('json') && (u.includes('api') || u.includes('search') || u.includes('list') || u.includes('video'))) {
      r.text().then((t) => {
        const hits = t.match(/https?:\/\/[^"'`\s)]+\.(mp4|webm|m3u8|mov)(\?[^"'`\s)]*)?/gi) || [];
        const yt = t.match(/https?:\/\/[^"'`\s)]*(youtube\.com|youtu\.be|bilibili\.com)[^"'`\s)]*/gi) || [];
        if (hits.length || yt.length) apiVideoHits.push({ u: u.slice(0, 90), hits: hits.slice(0, 5), yt: yt.slice(0, 5) });
      }).catch(() => {});
    }
  });
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  } catch (e) {
    console.log('GOTO ERROR: ' + (e && e.message));
  }
  // 滚动触发懒加载
  for (let k = 0; k < 5; k++) {
    await page.evaluate(() => window.scrollBy(0, 800)).catch(() => {});
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(3000);

  const report = await page.evaluate(() => {
    const out = { videos: [], iframes: [], htmlSnippets: [], hasCanvas: 0 };
    document.querySelectorAll('video').forEach((v, i) => {
      out.videos.push({ i, src: (v.currentSrc || v.src || '').slice(0, 140), poster: (v.poster || '').slice(0, 100) });
    });
    document.querySelectorAll('iframe').forEach((f, i) => {
      out.iframes.push({ i, src: (f.src || f.getAttribute('data-src') || '').slice(0, 160) });
    });
    out.hasCanvas = document.querySelectorAll('canvas').length;
    const html = document.documentElement.innerHTML;
    out.htmlSnippets = (html.match(/https?:\/\/[^"'<\s)]+\.(mp4|webm|m3u8|mov)(\?[^"'<\s)]*)?/gi) || []).slice(0, 12).map((s) => s.slice(0, 160));
    out.title = document.title;
    return out;
  });

  console.log = console.log;
  console.log('title:', report.title, '| canvas:', report.hasCanvas);
  console.log('videos(' + report.videos.length + '):', JSON.stringify(report.videos));
  console.log('iframes(' + report.iframes.length + '):', JSON.stringify(report.iframes));
  console.log('html 直链(' + report.htmlSnippets.length + '):', JSON.stringify(report.htmlSnippets));
  console.log('network video响应(' + mediaReq.length + '):', JSON.stringify(mediaReq.slice(0, 12)));
  console.log('API JSON 视频命中(' + apiVideoHits.length + '):', JSON.stringify(apiVideoHits.slice(0, 8), null, 1));
}

await browser.close();
console.log('\nDIAG2 DONE');
