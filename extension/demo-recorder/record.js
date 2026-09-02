/**
 * Ddayup 网页素材采集扩展 —— 演示视频自动录制（v2：用 Playwright recordVideo）
 *
 * 架构：
 *   1) Playwright 启动 Edge，启用 recordVideo（每个 page 自动录）
 *   2) 加载扩展 + 打开 B站视频页（主窗口）
 *   3) SW 调用 chrome.windows.create 创建侧栏独立窗口（加载 sidepanel.html）
 *   4) chrome.windows.update 调整两个窗口并排
 *   5) Playwright 自动化演示动作；每个 page 录制结束后拿到 .mp4
 *   6) 用 ffmpeg 拼接两个视频（左右并排）→ 最终演示视频
 *
 * 用法：node record.js [out.mp4]
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const EXT_DIR = path.resolve(__dirname, '..');
const OUT_DIR = path.resolve(__dirname, 'output');
const PROFILE = path.join(os.tmpdir(), 'hmdao-demo-profile');

const DEMO_URL = process.env.DEMO_URL || 'https://www.bilibili.com/video/BV1GJ411x7h7';
const OUT_FILE = process.argv[2] || `demo-${Date.now()}.mp4`;
const OUT_PATH = path.join(OUT_DIR, OUT_FILE);
const VIDEO_DIR = path.join(OUT_DIR, '_raw');

// 视频尺寸匹配 Playwright recordVideo.size（1280x720）
const MAIN_W = 1100, SIDE_W = 480, WIN_H = 720;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let t0 = Date.now();
async function step(label, ms) {
  const at = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[${String(at).padStart(5)}s] ▶ ${label}`);
  if (ms) await sleep(ms);
}

// 拼接两个视频为左右并排（精确裁剪：主取左 1100，侧取中心 480，紧贴布局）
function concatVideos(leftMp4, rightMp4, outMp4) {
  return new Promise((resolve, reject) => {
    const SIDE_X = Math.floor((1280 - SIDE_W) / 2);
    const args = [
      '-y',
      '-i', leftMp4,
      '-i', rightMp4,
      '-filter_complex',
        `[0:v]crop=${MAIN_W}:${WIN_H}:0:0,scale=${MAIN_W}:${WIN_H}[l];` +
        `[1:v]crop=${SIDE_W}:${WIN_H}:${SIDE_X}:0,scale=${SIDE_W}:${WIN_H}[r];` +
        `[l][r]hstack=2[v]`,
      '-map', '[v]',
      '-c:v', 'libopenh264',
      '-b:v', '2500k',
      '-pix_fmt', 'yuv420p',
      outMp4,
    ];
    const ff = spawn('ffmpeg', args, { stdio: 'inherit' });
    ff.on('exit', (c) => c === 0 ? resolve() : reject(new Error('ffmpeg exit ' + c)));
    ff.on('error', reject);
  });
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(VIDEO_DIR)) fs.mkdirSync(VIDEO_DIR, { recursive: true });
  // 清空 _raw（除调试：设环境变量 KEEP_RAW=1 保留）
  if (!process.env.KEEP_RAW) {
    for (const f of fs.readdirSync(VIDEO_DIR)) fs.unlinkSync(path.join(VIDEO_DIR, f));
  }

  let ctx = null;
  try {
    console.log('=== Ddayup 扩展演示录制 ===');
    console.log('演示站点:', DEMO_URL);
    console.log('输出文件:', OUT_PATH, '\n');

    ctx = await chromium.launchPersistentContext(PROFILE, {
      channel: 'msedge',
      headless: false,
      viewport: { width: MAIN_W, height: WIN_H },
      recordVideo: { dir: VIDEO_DIR, size: { width: 1280, height: 720 } },
      args: [
        `--disable-extensions-except=${EXT_DIR}`,
        `--load-extension=${EXT_DIR}`,
        `--window-size=${MAIN_W},${WIN_H}`,
        `--window-position=0,0`,
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    });

    await step('等待扩展加载', 3000);
    const sw = ctx.serviceWorkers()[0];
    if (!sw) throw new Error('扩展加载失败');
    const extId = new URL(sw.url()).host;
    console.log('扩展 ID:', extId);

    // ---- 主窗口打开 B站 ----
    // 关闭初始空白 page，确保 mainPage 是新创建的（有 recordVideo）
    for (const p of ctx.pages()) {
      if (p.url() === 'about:blank' || p.url() === 'chrome://newtab/') {
        await p.close().catch(() => {});
      }
    }
    const mainPage = await ctx.newPage();
    await mainPage.goto(DEMO_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await step('打开 B站视频页', 6000);
    await mainPage.waitForSelector('video', { timeout: 15000 }).catch(() => {});
    await sleep(2000);

    // ---- 创建侧栏独立窗口 + 调整并排 ----
    const winInfo = await sw.evaluate(async (id) => {
      const cur = await chrome.windows.getCurrent();
      const side = await chrome.windows.create({
        url: `chrome-extension://${id}/sidepanel.html`,
        type: 'normal',
        width: 480, height: 900,
        left: (cur.left || 0) + 1100, top: cur.top || 0,
        focused: false,
      });
      await chrome.windows.update(cur.id, { left: 0, top: 0, width: 1100, height: 900 });
      return { main: cur.id, side: side.id };
    }, extId);
    console.log('窗口:', winInfo);
    await step('打开 Ddayup 侧边栏窗口', 4000);

    // 找到侧栏 page
    let sidePage = ctx.pages().find(p => p.url().includes('sidepanel.html'));
    if (!sidePage) {
      // 多等一会
      await sleep(2000);
      sidePage = ctx.pages().find(p => p.url().includes('sidepanel.html'));
    }
    if (!sidePage) throw new Error('未找到侧栏 page');

    // ---- 点击重新扫描 ----
    const rescan = sidePage.locator('#rescan');
    if (await rescan.count()) {
      await rescan.hover();
      await sleep(400);
      await rescan.click();
      await step('点击「↻ 重新扫描」', 10000);
    }

    // 关闭可能误触发的 overlay
    await sidePage.evaluate(() => {
      document.querySelectorAll('.overlay.open').forEach((o) => o.classList.remove('open'));
    });
    await sleep(500);

    // ---- 展示采集结果（滚动） ----
    // 先等 #list 出现卡片
    try {
      await sidePage.locator('#list .card').first().waitFor({ timeout: 8000 });
    } catch (_) {
      console.log('⚠ 等卡片超时，继续');
    }
    const cards = sidePage.locator('#list .card');
    const count = await cards.count();
    console.log(`采集到素材卡片: ${count} 张`);
    if (count > 0) {
      // 滚到顶部
      await sidePage.evaluate(() => { const l = document.getElementById('list'); if (l) l.scrollTop = 0; });
      await sleep(1000);
      // 缓慢滚动展示
      for (let i = 0; i < 2; i++) {
        await sidePage.mouse.wheel(0, 240);
        await sleep(1200);
      }
      await sidePage.evaluate(() => { const l = document.getElementById('list'); if (l) l.scrollTop = 0; });
      await sleep(800);
    }
    await step('展示采集结果', 1500);

    // ---- 悬停预览（真实 hover，触发扩展的 hover 逻辑） ----
    if (count > 0) {
      const first = cards.first();
      await first.hover();
      await step('悬停卡片 → 预览', 5000);
    }

    // ---- 单击卡片 → 打开大预览窗（click() 单击=打开预览） ----
    if (count > 0) {
      await cards.first().click();
      await step('点击卡片 → 打开大预览', 7000);
      // 关闭预览
      const closeBtn = sidePage.locator('#closePreview');
      if (await closeBtn.count()) {
        await closeBtn.click().catch(() => {});
        await sleep(1500);
      } else {
        // 兜底：evaluate 关闭
        await sidePage.evaluate(() => {
          const o = document.getElementById('previewOverlay');
          if (o) o.classList.remove('open');
        });
        await sleep(1000);
      }
    }

    // ---- 展示「下载选中」入口（不真触发下载） ----
    const dl = sidePage.locator('#download');
    if (await dl.count()) {
      await dl.hover();
      await sleep(800);
      // 用高亮框视觉强调
      await sidePage.evaluate(() => {
        const dl = document.getElementById('download');
        if (dl) {
          dl.style.boxShadow = '0 0 18px #1a8cff';
          dl.style.transition = 'box-shadow .3s';
        }
      });
      await step('展示「下载选中」入口', 5000);
    }

    await step('演示结束', 2500);

    // ---- 关闭并保存两个视频 ----
    // 关键：先关所有 page（这会 finalize video），再 close context
    const mainVideoPath = await mainPage.video().path();
    const sideVideoPath = sidePage ? await sidePage.video().path() : null;
    console.log('主窗口视频:', mainVideoPath);
    console.log('侧栏视频:', sideVideoPath);

    await ctx.close();
    ctx = null;

    if (!mainVideoPath || !fs.existsSync(mainVideoPath)) throw new Error('主窗口视频未生成');
    if (!sideVideoPath || !fs.existsSync(sideVideoPath)) throw new Error('侧栏视频未生成');

    // ---- 拼接为左右并排 ----
    console.log('拼接两个窗口视频为最终演示视频...');
    await concatVideos(mainVideoPath, sideVideoPath, OUT_PATH);

    const size = fs.existsSync(OUT_PATH) ? (fs.statSync(OUT_PATH).size / 1024 / 1024).toFixed(2) : '?';
    console.log(`\n✅ 录制完成: ${OUT_PATH}  (${size} MB)`);
  } catch (e) {
    console.error('\n❌ 录制失败:', e.message);
    if (ctx) { try { await ctx.close(); } catch (_) {} }
    process.exitCode = 1;
  }
})();
