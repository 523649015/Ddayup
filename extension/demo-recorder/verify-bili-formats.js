// 验证：B站前端多分辨率枚举（HMDAO_BILI_LIST_QUALITIES）——不依赖后端 yt-dlp
const { chromium } = require('playwright');
const path = require('path');
const os = require('os');

const EXT = path.resolve(__dirname, '..');
const PROFILE = path.join(os.tmpdir(), 'hmdao-verify-bili');
const URL_ = process.env.DEMO_URL || 'https://www.bilibili.com/video/BV1GJ411x7h7';

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'msedge',
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  await new Promise((r) => setTimeout(r, 3000));
  const sw = ctx.serviceWorkers()[0];
  if (!sw) { console.log('❌ 无 SW'); await ctx.close(); process.exit(1); }
  console.log('扩展 ID:', new URL(sw.url()).host);

  const page = await ctx.newPage();
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 7000));  // 等 __INITIAL_STATE__ 就绪

  // 直接发消息给 background（模拟侧栏调用）
  const res = await page.evaluate(async (tabId) => {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'HMDAO_BILI_LIST_QUALITIES', tabId });
      return r;
    } catch (e) { return { err: String(e) }; }
  }, 0).catch((e) => ({ err: 'eval fail: ' + e.message }));
  console.log('\n=== 侧栏视角发消息（tabId=0 会失败，预期）===');
  console.log(res);

  // 正确方式：用真实 tabId（从 SW 侧 query）
  const r2 = await sw.evaluate(async () => {
    const tabs = await new Promise((r) => chrome.tabs.query({ active: true, currentWindow: true }, r));
    const tid = tabs && tabs[0] ? tabs[0].id : null;
    if (!tid) return { ok: false, err: 'no tab' };
    // 直接调本 SW 里的注入逻辑：重新走一遍 executeScript
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tid },
      world: 'MAIN',
      func: () => {
        // 仅探测：页面是否已有 __INITIAL_STATE__ 与 wbi 密钥（验证前置条件）
        try {
          const s0 = window.__INITIAL_STATE__ || {};
          const wbi = (s0.videoData && s0.videoData.wbi) || s0.defaultWbiKey || null;
          return {
            hasState: !!s0.videoData,
            aid: s0.videoData && s0.videoData.aid,
            cid: s0.videoData && s0.videoData.cid,
            hasWbi: !!(wbi && wbi.wbiImgKey && wbi.wbiSubKey),
            title: (s0.videoData && s0.videoData.title) || '',
          };
        } catch (e) { return { err: String(e) }; }
      },
    });
    return { tabId: tid, probe: res && res.result };
  });
  console.log('\n=== SW 注入探测（页面前置条件）===');
  console.log(r2);

  await new Promise((r) => setTimeout(r, 2000));
  await ctx.close();
})().catch((e) => { console.error('错误:', e.message); process.exit(1); });
