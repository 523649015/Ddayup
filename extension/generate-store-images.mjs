import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

const ICONS_DIR = 'icons';
const OUT_DIR = 'store-assets';

// 确保输出目录存在
if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

const svgIcon = fs.readFileSync(path.join(ICONS_DIR, 'icon.svg'), 'utf8');

// 1. 生成 300x300 Extension logo（直接放大 SVG）
await sharp(Buffer.from(svgIcon), { density: 300 })
  .resize(300, 300, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toFile(path.join(OUT_DIR, 'logo-300x300.png'));

console.log('Generated logo-300x300.png');

// 2. 生成 440x280 Small promotional tile
const tileSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="440" height="280" viewBox="0 0 440 280">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0d1117"/>
      <stop offset="100%" stop-color="#161b22"/>
    </linearGradient>
    <radialGradient id="glow" cx="80%" cy="20%" r="60%">
      <stop offset="0%" stop-color="#7ddf64" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="#7ddf64" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="440" height="280" fill="url(#bg)"/>
  <rect width="440" height="280" fill="url(#glow)"/>
  
  <!-- 左侧装饰条 -->
  <rect x="0" y="0" width="6" height="280" fill="#7ddf64"/>
  
  <!-- 图标区域（144x144，居中偏左） -->
  <g transform="translate(60, 68) scale(1.125)">
    ${svgIcon.replace(/<\?xml.*?\?>/, '').replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, '')}
  </g>
  
  <!-- 右侧文字 -->
  <text x="220" y="110" font-family="Microsoft YaHei, PingFang SC, sans-serif" font-size="28" font-weight="bold" fill="#f0f6fc">Ddayup</text>
  <text x="220" y="150" font-family="Microsoft YaHei, PingFang SC, sans-serif" font-size="18" fill="#b6f0a3">网页素材采集扩展</text>
  <text x="220" y="188" font-family="Microsoft YaHei, PingFang SC, sans-serif" font-size="13" fill="#8b949e">一键采集图片 · 视频 · 音频 · 3D模型</text>
</svg>`;

await sharp(Buffer.from(tileSvg), { density: 72 })
  .resize(440, 280, { fit: 'fill' })
  .png()
  .toFile(path.join(OUT_DIR, 'small-promo-440x280.png'));

console.log('Generated small-promo-440x280.png');
console.log('Output dir:', path.resolve(OUT_DIR));
