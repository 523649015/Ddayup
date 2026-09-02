// 技术验证：Playwright 驱动 Edge 加载扩展 + 打开侧边栏
const { chromium } = require('playwright');
const path = require('path');
const os = require('os');
const fs = require('fs');

const EXT = path.resolve(__dirname, '..');           // extension 目录
const PROFILE = path.join(os.tmpdir(), 'hmdao-demo-profile');

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'msedge',
    headless: false,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--auto-open-devtools-for-tabs=false',
    ],
    viewport: { width: 1600, height: 900 },
  });

  // 等扩展加载，拿到扩展 ID
  await new Promise((r) => setTimeout(r, 2500));
  let extId = null;
  const sw = ctx.serviceWorkers();
  if (sw.length) {
    extId = new URL(sw[0].url()).host;
    console.log('扩展 ID(来自 SW):', extId);
  } else {
    // 回退：从扩展管理页或 chrome-extension 协议枚举
    const p = await ctx.newPage();
    await p.goto('edge://extensions');
    await new Promise((r) => setTimeout(r, 1500));
    extId = await p.evaluate(() => {
      const mgr = document.querySelector('extensions-manager');
      const items = mgr && mgr.shadowRoot && mgr.shadowRoot.querySelectorAll('extensions-item');
      if (items && items.length) return items[0].id || null;
      return null;
    });
    console.log('扩展 ID(来自管理页):', extId);
    await p.close();
  }

  if (!extId) { console.log('❌ 未拿到扩展 ID'); await ctx.close(); process.exit(1); }

  // 打开侧边栏页面
  const side = await ctx.newPage();
  await side.goto(`chrome-extension://${extId}/sidepanel.html`);
  await new Promise((r) => setTimeout(r, 1500));
  const title = await side.title();
  const hasScanBtn = await side.evaluate(() => {
    const b = document.getElementById('scanBtn') || document.getElementById('rescanBtn');
    return !!b;
  });
  console.log('侧栏标题:', title);
  console.log('侧栏扫描按钮存在:', hasScanBtn);

  console.log('✅ 技术验证通过 —— 扩展已加载，侧栏可打开');
  await new Promise((r) => setTimeout(r, 1000));
  await ctx.close();
})().catch((e) => { console.error('验证失败:', e.message); process.exit(1); });
