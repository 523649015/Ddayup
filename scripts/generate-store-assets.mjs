import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../dist-store/store-assets');
const SVG_ICON = fs.readFileSync(path.resolve(__dirname, '../extension/icons/icon.svg'), 'utf8');

fs.mkdirSync(OUT_DIR, { recursive: true });

const mascotSvg = SVG_ICON.replace('<svg', '<svg id="mascot"');

const logoHtml = `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { width: 300px; height: 300px; background: #0d1117; display: flex; align-items: center; justify-content: center; overflow: hidden; }
#mascot { width: 240px; height: 240px; filter: drop-shadow(0 12px 24px rgba(0,0,0,0.35)); }
</style></head>
<body>${mascotSvg}</body></html>
`;

const smallPromoHtml = `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { width: 440px; height: 280px; background: linear-gradient(135deg, #0d1117 0%, #161b22 100%); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; overflow: hidden; position: relative; }
.wrap { display: flex; align-items: center; height: 100%; padding: 28px; gap: 22px; }
#mascot { width: 128px; height: 128px; flex-shrink: 0; filter: drop-shadow(0 8px 20px rgba(76,176,77,0.25)); }
.text { color: #fff; }
h1 { font-size: 32px; font-weight: 800; letter-spacing: -0.5px; margin-bottom: 6px; background: linear-gradient(90deg, #b6f0a3, #7ddf64); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
.tagline { font-size: 15px; color: #c9d1d9; line-height: 1.45; }
.chips { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 6px; }
.chip { background: rgba(124,223,100,0.12); color: #7ddf64; border: 1px solid rgba(124,223,100,0.25); font-size: 11px; padding: 4px 8px; border-radius: 999px; font-weight: 600; }
.corner { position: absolute; top: -40px; right: -40px; width: 160px; height: 160px; background: radial-gradient(circle, rgba(124,223,100,0.12) 0%, transparent 70%); }
</style></head>
<body><div class="corner"></div><div class="wrap">${mascotSvg}<div class="text"><h1>Ddayup</h1><div class="tagline">Collect images, videos, audio & 3D models from any webpage in one click.</div><div class="chips"><span class="chip">Images</span><span class="chip">Video</span><span class="chip">Audio</span><span class="chip">3D</span></div></div></div></body></html>
`;

const largePromoHtml = `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { width: 1400px; height: 560px; background: linear-gradient(110deg, #0d1117 0%, #111820 55%, #0d1a12 100%); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; overflow: hidden; position: relative; }
.wrap { display: flex; align-items: center; height: 100%; padding: 80px; gap: 60px; }
.left { flex: 1; color: #fff; z-index: 2; }
.badge { display: inline-flex; align-items: center; gap: 6px; background: rgba(124,223,100,0.12); border: 1px solid rgba(124,223,100,0.25); color: #7ddf64; font-size: 14px; font-weight: 700; padding: 6px 12px; border-radius: 999px; margin-bottom: 20px; }
.badge::before { content: ""; width: 8px; height: 8px; background: #7ddf64; border-radius: 50%; box-shadow: 0 0 10px #7ddf64; }
h1 { font-size: 72px; font-weight: 900; letter-spacing: -2px; margin-bottom: 14px; background: linear-gradient(90deg, #b6f0a3, #7ddf64); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
p { font-size: 24px; color: #b4bcd0; line-height: 1.5; max-width: 520px; }
.features { margin-top: 32px; display: flex; gap: 18px; }
.feat { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 14px; padding: 18px 22px; color: #e6edf3; font-size: 16px; font-weight: 600; }
.right { width: 560px; height: 420px; background: rgba(13,17,23,0.65); border: 1px solid rgba(255,255,255,0.08); border-radius: 24px; padding: 28px; box-shadow: 0 30px 70px rgba(0,0,0,0.45); backdrop-filter: blur(8px); z-index: 2; }
.panel-head { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; }
.dot { width: 12px; height: 12px; border-radius: 50%; background: #ff5f57; }
.dot:nth-child(2) { background: #febc2e; }
.dot:nth-child(3) { background: #28c840; }
.panel-title { margin-left: 8px; font-size: 15px; color: #c9d1d9; font-weight: 600; }
.item { display: flex; align-items: center; gap: 14px; padding: 14px; border-radius: 12px; background: rgba(255,255,255,0.03); margin-bottom: 10px; }
.thumb { width: 48px; height: 36px; border-radius: 6px; background: linear-gradient(135deg, #2a3142, #1c2128); display: flex; align-items: center; justify-content: center; color: #8b949e; font-size: 11px; font-weight: 700; }
.thumb.vid { background: linear-gradient(135deg, #3d2a42, #281c2e); color: #d2a8e8; }
.thumb.audio { background: linear-gradient(135deg, #2a3d42, #1c282e); color: #79c0ff; }
.info { flex: 1; }
.title { color: #e6edf3; font-size: 14px; font-weight: 600; margin-bottom: 3px; }
.meta { color: #8b949e; font-size: 12px; }
.btn { background: #238636; color: #fff; font-size: 12px; font-weight: 700; padding: 6px 12px; border-radius: 6px; }
.glow { position: absolute; width: 700px; height: 700px; background: radial-gradient(circle, rgba(124,223,100,0.10) 0%, transparent 60%); top: -180px; right: -180px; }
</style></head>
<body><div class="glow"></div><div class="wrap"><div class="left"><div class="badge">Browser Extension</div><h1>Ddayup Collector</h1><p>Scan any page, preview media instantly, and download images, videos, audio & 3D models to your local library.</p><div class="features"><div class="feat">One-click scan</div><div class="feat">Batch download</div><div class="feat">Local first</div></div></div><div class="right"><div class="panel-head"><div class="dot"></div><div class="dot"></div><div class="dot"></div><div class="panel-title">Ddayup Side Panel</div></div><div class="item"><div class="thumb">IMG</div><div class="info"><div class="title">unsplash_photo.jpg</div><div class="meta">2.4 MB · image/jpeg</div></div><div class="btn">Save</div></div><div class="item"><div class="thumb vid">VID</div><div class="info"><div class="title">youtube_1080p.mp4</div><div class="meta">18.7 MB · video/mp4</div></div><div class="btn">Save</div></div><div class="item"><div class="thumb audio">AUD</div><div class="info"><div class="title">ui_click.wav</div><div class="meta">0.2 MB · audio/wav</div></div><div class="btn">Save</div></div></div></div></body></html>
`;

const screenshotHtml = `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { width: 1280px; height: 800px; background: #e5e7eb; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; overflow: hidden; display: flex; }
.browser { flex: 1; background: #fff; display: flex; flex-direction: column; }
.browser-bar { height: 44px; background: #f3f4f6; border-bottom: 1px solid #d1d5db; display: flex; align-items: center; padding: 0 16px; gap: 10px; }
.circ { width: 12px; height: 12px; border-radius: 50%; background: #d1d5db; }
.circ:first-child { background: #ff5f57; }
.circ:nth-child(2) { background: #febc2e; }
.circ:nth-child(3) { background: #28c840; }
.addr { flex: 1; height: 28px; background: #fff; border: 1px solid #d1d5db; border-radius: 16px; display: flex; align-items: center; padding: 0 14px; color: #6b7280; font-size: 13px; }
.page { flex: 1; padding: 40px; background: linear-gradient(180deg, #f9fafb 0%, #eef2ff 100%); }
.page h2 { font-size: 28px; color: #111827; margin-bottom: 12px; }
.page p { color: #4b5563; line-height: 1.6; max-width: 640px; }
.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-top: 28px; }
.card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; height: 140px; box-shadow: 0 2px 8px rgba(0,0,0,0.04); }
.sidepanel { width: 360px; background: #0d1117; border-left: 1px solid #30363d; display: flex; flex-direction: column; color: #c9d1d9; }
.sp-head { height: 56px; border-bottom: 1px solid #30363d; display: flex; align-items: center; padding: 0 18px; gap: 10px; }
.sp-head svg { width: 26px; height: 26px; }
.sp-title { font-size: 16px; font-weight: 700; color: #fff; }
.sp-sub { margin-left: auto; font-size: 12px; color: #7ddf64; background: rgba(124,223,100,0.12); padding: 4px 8px; border-radius: 999px; }
.sp-toolbar { padding: 14px 18px; display: flex; gap: 8px; }
.sp-btn { flex: 1; background: #238636; color: #fff; border-radius: 8px; padding: 9px 0; text-align: center; font-size: 13px; font-weight: 700; }
.sp-btn.sec { background: #21262d; color: #c9d1d9; }
.sp-list { flex: 1; overflow-y: auto; padding: 0 14px 14px; }
.sp-item { display: flex; align-items: center; gap: 12px; padding: 12px; border-radius: 10px; background: rgba(255,255,255,0.03); margin-bottom: 8px; border: 1px solid rgba(255,255,255,0.05); }
.sp-thumb { width: 44px; height: 34px; border-radius: 6px; background: #21262d; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; color: #8b949e; }
.sp-thumb.vid { color: #d2a8e8; }
.sp-thumb.audio { color: #79c0ff; }
.sp-info { flex: 1; }
.sp-name { font-size: 13px; font-weight: 600; color: #e6edf3; margin-bottom: 2px; }
.sp-meta { font-size: 11px; color: #8b949e; }
.sp-action { color: #7ddf64; font-size: 12px; font-weight: 700; }
</style></head>
<body>
<div class="browser">
  <div class="browser-bar"><div class="circ"></div><div class="circ"></div><div class="circ"></div><div class="addr">pexels.com — free stock photos</div></div>
  <div class="page">
    <h2>Free stock photos & videos</h2>
    <p>Browse millions of royalty-free images and videos shared by talented creators. Ddayup scans this page and lists every downloadable asset in the side panel.</p>
    <div class="grid"><div class="card"></div><div class="card"></div><div class="card"></div><div class="card"></div><div class="card"></div><div class="card"></div></div>
  </div>
</div>
<div class="sidepanel">
  <div class="sp-head">${SVG_ICON.replace('width="128"', 'width="26"').replace('height="128"', 'height="26"').replace('viewBox="0 0 128 128"', 'viewBox="0 0 128 128"')}<div class="sp-title">Ddayup</div><div class="sp-sub">7 assets</div></div>
  <div class="sp-toolbar"><div class="sp-btn">Scan page</div><div class="sp-btn sec">Import all</div></div>
  <div class="sp-list">
    <div class="sp-item"><div class="sp-thumb">IMG</div><div class="sp-info"><div class="sp-name">mountain_sunset.jpg</div><div class="sp-meta">1.8 MB · 3840×2160</div></div><div class="sp-action">Save</div></div>
    <div class="sp-item"><div class="sp-thumb vid">VID</div><div class="sp-info"><div class="sp-name">ocean_waves_4k.mp4</div><div class="sp-meta">24.5 MB · 00:15</div></div><div class="sp-action">Save</div></div>
    <div class="sp-item"><div class="sp-thumb audio">AUD</div><div class="sp-info"><div class="sp-name">nature_ambience.mp3</div><div class="sp-meta">4.2 MB · 02:10</div></div><div class="sp-action">Save</div></div>
    <div class="sp-item"><div class="sp-thumb">IMG</div><div class="sp-info"><div class="sp-name">forest_path.jpg</div><div class="sp-meta">2.1 MB · 1920×1280</div></div><div class="sp-action">Save</div></div>
  </div>
</div>
</body></html>
`;

const jobs = [
  { name: 'extension-logo', w: 300, h: 300, html: logoHtml },
  { name: 'small-promo-tile', w: 440, h: 280, html: smallPromoHtml },
  { name: 'large-promo-tile', w: 1400, h: 560, html: largePromoHtml },
  { name: 'screenshot-1', w: 1280, h: 800, html: screenshotHtml },
];

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const job of jobs) {
    await page.setViewportSize({ width: job.w, height: job.h });
    await page.setContent(job.html, { waitUntil: 'networkidle' });
    const outPath = path.join(OUT_DIR, `${job.name}.png`);
    await page.screenshot({ path: outPath, type: 'png', clip: { x: 0, y: 0, width: job.w, height: job.h } });
    const stat = fs.statSync(outPath);
    console.log(`Generated ${outPath} (${stat.size} bytes, ${job.w}x${job.h})`);
  }
  await browser.close();
  console.log('All store assets generated.');
}

main().catch(err => { console.error(err); process.exit(1); });
