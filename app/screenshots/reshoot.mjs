import { chromium } from 'playwright';
import fs from 'node:fs';

const ROUTES = [
  { url: 'http://127.0.0.1:4100/landing', file: 'F:\\Work\\HMDAODAO\\app\\screenshots\\landing.png' },
  { url: 'http://127.0.0.1:4100/services', file: 'F:\\Work\\HMDAODAO\\app\\screenshots\\services.png' },
  { url: 'http://127.0.0.1:4100/pricing', file: 'F:\\Work\\HMDAODAO\\app\\screenshots\\pricing.png' },
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
for (const r of ROUTES) {
  await page.goto(r.url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await page.screenshot({ path: r.file, fullPage: true });
  console.log('saved', r.file, fs.statSync(r.file).size);
}
await browser.close();