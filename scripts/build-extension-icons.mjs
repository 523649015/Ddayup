// 用 Playwright 把 extension/icons/icon.svg 渲染为 Edge 商店所需的 PNG (16/48/128)
// 比 sharp 更可靠：浏览器原生 SVG 栅格化，精确还原渐变/路径。
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const SRC = 'f:/Work/HMDAODAO/extension/icons/icon.svg';
const OUT_DIR = 'f:/Work/HMDAODAO/extension/icons';

const svg = fs.readFileSync(SRC, 'utf8');

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(`<!doctype html><html><body style="margin:0;padding:0;background:transparent">${svg}</body></html>`);

for (const size of [128, 48, 16]) {
  await page.setViewportSize({ width: size, height: size });
  const out = path.join(OUT_DIR, `icon-${size}.png`);
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: size, height: size }, omitBackground: true });
  console.log('wrote', out);
}
await browser.close();
console.log('DONE');
