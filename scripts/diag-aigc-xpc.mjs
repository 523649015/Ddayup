// 诊断 aigc.xinpianchang.com 为什么扫描不到资产
// 拆解：DOM <img>/<video> / 内联 JSON 全局变量 / 网络媒体响应 / 我的 scan.js aigc 提取逻辑复现
import { chromium } from 'playwright';

const TARGETS = [
  'https://aigc.xinpianchang.com/',
  // 作品详情页（如果有，从首页抓一个真实链接）
];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
});
const page = await ctx.newPage();

const mediaResp = [];
const apiHits = [];
page.on('response', (r) => {
  const ct = (r.headers()['content-type'] || '').toLowerCase();
  const u = r.url();
  if (ct.startsWith('image/') || ct.startsWith('video/') || /\.(mp4|webm|m3u8|m4s|mov|jpg|jpeg|png|webp|gif)(\?|$)/i.test(u)) {
    mediaResp.push({ ct, u: u.slice(0, 200), status: r.status() });
  }
  if (ct.includes('json') && (u.includes('api') || u.includes('mod-api') || u.includes('list') || u.includes('detail') || u.includes('video'))) {
    r.text().then((t) => {
      const img = t.match(/https?:\/\/[^"'`\s)]+\.(jpg|jpeg|png|webp|gif|avif)(?:\?[^"'`\s)]*)?/gi) || [];
      const vid = t.match(/https?:\/\/[^"'`\s)]+\.(mp4|webm|m3u8|mov)(?:\?[^"'`\s)]*)?/gi) || [];
      if (img.length || vid.length) apiHits.push({ u: u.slice(0, 110), img: img.slice(0, 4), vid: vid.slice(0, 4) });
    }).catch(() => {});
  }
});

async function diag(url) {
  console.log('\n========== ' + url + ' ==========');
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    console.log('GOTO ERROR: ' + (e && e.message));
  }
  // 等 SPA 渲染 + 滚动触发懒加载
  await page.waitForTimeout(4000);
  for (let k = 0; k < 6; k++) {
    await page.evaluate(() => window.scrollBy(0, 1000)).catch(() => {});
    await page.waitForTimeout(1200);
  }
  await page.waitForTimeout(2000);

  const report = await page.evaluate(() => {
    const out = { imgs: [], vids: [], jsonGlobals: {}, nextData: null, scripts: [], htmlImgUrls: [], htmlVidUrls: [] };
    // 1) <img>
    document.querySelectorAll('img').forEach((im, i) => {
      const src = im.getAttribute('src') || im.getAttribute('data-src') || im.getAttribute('data-original') || im.getAttribute('data-lazy') || '';
      if (src) out.imgs.push({ i, src: src.slice(0, 160), lazy: !im.getAttribute('src') && !!im.getAttribute('data-src') });
    });
    // 2) <video>
    document.querySelectorAll('video').forEach((v, i) => {
      out.vids.push({ i, src: (v.currentSrc || v.src || '').slice(0, 160), poster: (v.poster || '').slice(0, 100) });
    });
    // 3) 内联 JSON 全局变量
    ['__INITIAL_STATE__', '__NEXT_DATA__', 'initialState', 'pageData', 'serverData', 'window.__INITIAL_STATE__'].forEach((k) => {
      try { if (window[k] !== undefined) out.jsonGlobals[k] = JSON.stringify(window[k]).slice(0, 300); } catch (_) {}
    });
    // 4) __NEXT_DATA__ script
    const nd = document.getElementById('__NEXT_DATA__');
    if (nd) out.nextData = (nd.textContent || '').slice(0, 400);
    // 5) 内联 script 里含媒体 URL 的
    document.querySelectorAll('script:not([src])').forEach((s, i) => {
      const t = s.textContent || '';
      if (/(xinpianchang|xpccdn|cover|image|video|mp4|webm)/i.test(t)) out.scripts.push({ i, len: t.length, head: t.slice(0, 120) });
    });
    // 6) HTML 裸 URL
    const html = document.documentElement.innerHTML;
    out.htmlImgUrls = (html.match(/https?:\/\/[^"'<\s)]+\.(jpg|jpeg|png|webp|gif|avif)(?:\?[^"'<\s)]*)?/gi) || []).slice(0, 10).map((s) => s.slice(0, 160));
    out.htmlVidUrls = (html.match(/https?:\/\/[^"'<\s)]+\.(mp4|webm|m3u8|mov)(?:\?[^"'<\s)]*)?/gi) || []).slice(0, 10).map((s) => s.slice(0, 160));
    out.title = document.title;
    return out;
  });

  console.log('title:', report.title);
  console.log('imgs(' + report.imgs.length + '):', JSON.stringify(report.imgs.slice(0, 8)));
  console.log('vids(' + report.vids.length + '):', JSON.stringify(report.vids));
  console.log('jsonGlobals keys:', Object.keys(report.jsonGlobals));
  console.log('nextData head:', report.nextData);
  console.log('inline scripts w/ media(' + report.scripts.length + '):', JSON.stringify(report.scripts.slice(0, 4)));
  console.log('HTML img urls(' + report.htmlImgUrls.length + '):', JSON.stringify(report.htmlImgUrls));
  console.log('HTML vid urls(' + report.htmlVidUrls.length + '):', JSON.stringify(report.htmlVidUrls));
  console.log('NETWORK media resp(' + mediaResp.length + '):', JSON.stringify(mediaResp.slice(0, 15).map((m) => ({ ct: m.ct, u: m.u, s: m.status }))));
  console.log('API JSON hits(' + apiHits.length + '):', JSON.stringify(apiHits.slice(0, 8)));

  // 找一个真实作品详情链接，供下一步诊断
  const links = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a[href]'))
      .map((a) => a.href)
      .filter((h) => /aigc\.xinpianchang\.com\/(detail|\w+)\/\w+/.test(h) || /xinpianchang\.com\/(a\d+|detail)/.test(h))
      .slice(0, 6);
  });
  console.log('作品链接候选:', JSON.stringify(links));
  return links;
}

let detailLinks = [];
try { detailLinks = await diag(TARGETS[0]); } catch (e) { console.log('DIAG ERR', e); }

if (detailLinks.length) {
  try { await diag(detailLinks[0]); } catch (e) { console.log('DETAIL DIAG ERR', e); }
}

await browser.close();
console.log('\nDIAG AIGC DONE');
