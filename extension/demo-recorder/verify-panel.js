// 验证：通过 service worker 调用 chrome.sidePanel.open() 打开真实侧边栏
const { chromium } = require('playwright');
const path = require('path');
const os = require('os');

const EXT = path.resolve(__dirname, '..');
const PROFILE = path.join(os.tmpdir(), 'hmdao-demo-verify');

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

  // 打开 B站视频页（作为活动 tab）
  const page = await ctx.newPage();
  await page.goto('https://www.bilibili.com/video/BV1GJ411x7h7', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 3000));
  const tabId = page._pageId ? null : null;  // 取不到内部 id，用 pages API
  console.log('当前 page url:', page.url());

  // 通过 service worker 打开真实侧边栏
  const sw = ctx.serviceWorkers()[0];
  if (!sw) { console.log('❌ 无 service worker'); await ctx.close(); process.exit(1); }
  console.log('SW URL:', sw.url());

  try {
    const opened = await sw.evaluate(async () => {
      const tabs = await new Promise((r) => chrome.tabs.query({ active: true, currentWindow: true }, r));
      const tid = tabs && tabs[0] ? tabs[0].id : null;
      if (!tid) return { ok: false, err: 'no active tab' };
      try {
        await chrome.sidePanel.open({ tabId: tid });
        return { ok: true, tabId: tid };
      } catch (e) {
        return { ok: false, err: e.message, tabId: tid };
      }
    });
    console.log('sidePanel.open 结果:', opened);
  } catch (e) {
    console.log('❌ evaluate 失败:', e.message);
  }

  await new Promise((r) => setTimeout(r, 4000));
  await ctx.close();
})().catch((e) => { console.error('验证出错:', e.message); process.exit(1); });
