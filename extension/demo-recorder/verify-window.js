// 验证 SW 能否通过 chrome.windows.create 创建独立窗口显示 sidepanel
const { chromium } = require('playwright');
const path = require('path');
const os = require('os');

const EXT = path.resolve(__dirname, '..');
const PROFILE = path.join(os.tmpdir(), 'hmdao-verify-window');

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'msedge',
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--start-maximized',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  await new Promise((r) => setTimeout(r, 3000));
  const sw = ctx.serviceWorkers()[0];
  if (!sw) { console.log('❌ 无 SW'); await ctx.close(); process.exit(1); }

  // 取扩展 ID
  const extId = new URL(sw.url()).host;
  console.log('扩展 ID:', extId);

  // 打开一个网页（背景活动 tab）
  const page = await ctx.newPage();
  await page.goto('https://www.bilibili.com/video/BV1GJ411x7h7', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 2000));

  // SW 试调 windows.create
  try {
    const r = await sw.evaluate(async (id) => {
      try {
        const w = await chrome.windows.create({
          url: `chrome-extension://${id}/sidepanel.html`,
          type: 'normal',
          width: 480, height: 900,
          left: 1410, top: 0,
        });
        return { ok: true, id: w.id, left: w.left, top: w.top, w: w.width, h: w.height };
      } catch (e) {
        return { ok: false, err: e.message };
      }
    }, extId);
    console.log('windows.create 结果:', r);
  } catch (e) {
    console.log('❌ SW evaluate 失败:', e.message);
  }

  await new Promise((r) => setTimeout(r, 4000));
  // 列出所有 page
  console.log('当前所有 page url:');
  for (const p of ctx.pages()) {
    console.log('  -', p.url());
  }
  await ctx.close();
})().catch((e) => { console.error('错误:', e.message); process.exit(1); });
