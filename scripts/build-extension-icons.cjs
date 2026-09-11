// 将 extension/icons/icon.svg 栅格化为 Edge 商店所需的 PNG 图标 (16/48/128)
// 使用 app/node_modules 下的 sharp（libvips 支持 SVG 输入）。
const fs = require('fs');
const path = require('path');
const sharp = require('f:/Work/HMDAODAO/app/node_modules/sharp');

const SRC = 'f:/Work/HMDAODAO/extension/icons/icon.svg';
const OUT_DIR = 'f:/Work/HMDAODAO/extension/icons';

(async () => {
  const svg = fs.readFileSync(SRC);
  for (const size of [16, 48, 128]) {
    const out = path.join(OUT_DIR, `icon-${size}.png`);
    await sharp(svg, { density: 384 }).resize(size, size).png().toFile(out);
    console.log('wrote', out);
  }
  console.log('DONE');
})().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
