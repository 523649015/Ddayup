// 诊断 aigc 首页链接格式 + 验证详情页扫描
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
});
const page = await ctx.newPage();

await page.goto('https://aigc.xinpianchang.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => console.log('GOTO', e.message));
await page.waitForTimeout(4000);
for (let k = 0; k < 6; k++) { await page.evaluate(() => window.scrollBy(0, 1000)).catch(() => {}); await page.waitForTimeout(1000); }
await page.waitForTimeout(2000);

// 抓所有 a 链接（看 aigc 的路由格式）
const links = await page.evaluate(() => {
  const all = Array.from(document.querySelectorAll('a[href]')).map((a) => a.href);
  const uniq = [...new Set(all)];
  // 分类
  const xpc = uniq.filter((h) => /xinpianchang\.com/.test(h));
  return { total: uniq.length, xpcSample: xpc.slice(0, 15), anyDetail: xpc.filter((h) => /detail|work|p\/|\/a\d+/i.test(h)).slice(0, 10) };
});
console.log('首页 a 链接总数:', links.total);
console.log('xinpianchang 链接样例:', JSON.stringify(links.xpcSample, null, 1));
console.log('疑似详情页:', JSON.stringify(links.anyDetail));

// 点第一个 xinpianchang 链接进详情页，验证扫描
const detailUrl = links.xpcSample.find((h) => /xinpianchang\.com/.test(h)) || links.anyDetail[0];
if (detailUrl) {
  console.log('\n========== 详情页: ' + detailUrl + ' ==========');
  await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => console.log('GOTO', e.message));
  await page.waitForTimeout(4000);
  for (let k = 0; k < 4; k++) { await page.evaluate(() => window.scrollBy(0, 1000)).catch(() => {}); await page.waitForTimeout(1000); }
  await page.waitForTimeout(2000);
  const r = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img')).map((im) => im.getAttribute('src') || im.getAttribute('data-src') || '').filter(Boolean);
    const vids = Array.from(document.querySelectorAll('video')).map((v) => v.currentSrc || v.src || '').filter(Boolean);
    const html = document.documentElement.innerHTML;
    const imgUrls = (html.match(/https?:\/\/[^"'<\s)]+\.(jpg|jpeg|png|webp|gif|avif)(?:\?[^"'<\s)]*)?/gi) || []);
    const vidUrls = (html.match(/https?:\/\/[^"'<\s)]+\.(mp4|webm|m3u8|mov)(?:\?[^"'<\s)]*)?/gi) || []);
    return { title: document.title, imgs: imgs.length, vids: vids.length, imgUrls: imgUrls.length, vidUrls: vidUrls.length, imgSample: imgs.slice(0, 5), vidSample: vidUrls.slice(0, 5) };
  });
  console.log('详情页扫描:', JSON.stringify(r, null, 1));
}

await browser.close();
console.log('\nDIAG AIGC DETAIL DONE');
