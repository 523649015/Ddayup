// 端到端复测 aigc.xinpianchang.com 在真实扩展机制下能否采到资产
// 与 verify-aigc.txt 区别：本次用 Playwright 加载扩展 + 真实 aigc 页面，
// 让扩展 SW / content script / scanTab 全链路自然跑起来，最后读侧栏收到的资产数。

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';

const ROOT = 'f:/Work/HMDAODAO';
const EXT = path.join(ROOT, 'extension');
const PROFILE_DIR = path.join(ROOT, 'tmp/edge-profile-aigc');
const LOG = (m) => console.log('[E2E]', m);
const OUT = path.join(ROOT, 'tmp/e2e-aigc-result.txt');
fs.mkdirSync(path.join(ROOT, 'tmp'), { recursive: true });

const out = (s) => { fs.appendFileSync(OUT, s + '\n'); process.stdout.write(s + '\n'); };

async function main() {
  fs.writeFileSync(OUT, '');
  out('=== E2E aigc.xinpianchang.com 复测 ===');

  // 启动持久化 profile + 加载扩展（让 SW / content script 真跑）
  // 每次强制重新加载（disable then enable），避免 MV3 扩展代码缓存
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disk-cache-size=1', // 禁磁盘缓存
    ],
    bypassCSP: true,
  });
  // 强制重新加载扩展
  const cdp = await ctx.newCDPSession(await ctx.newPage());
  await cdp.send('Extensions.setReloadOnReload', { reload: true }).catch(() => {});
  const swUrl = ctx.backgroundPages()[0]?.url?.() || 'n/a';
  out(`background SW url: ${swUrl}`);

  // 打开 aigc 首页 + 侧栏
  const page = await ctx.newPage();
  const consoleLogs = [];
  page.on('console', (msg) => consoleLogs.push(`[page] ${msg.type()}: ${msg.text()}`));
  page.on('pageerror', (err) => consoleLogs.push(`[pageerror] ${err.message}`));
  out('GOTO https://aigc.xinpianchang.com/ ...');
  await page.goto('https://aigc.xinpianchang.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  // 给 SPA 一些时间拉数据
  await page.waitForTimeout(5000);
  out('等待 5s 完成, 当前标题=' + await page.title());

  // 打开扩展侧栏：通过点击扩展图标或直接 page 侧 panel URL
  // MV3 side panel 不能在 playwright 直接打开，但可以通过 triggerAction / focus 模拟
  // 这里用另一种方式：直接调 background 让它对当前 tab 跑 scanTab
  // 找到 SW page
  const sw = ctx.backgroundPages()[0] || ctx.serviceWorkers()[0];
  if (!sw) { out('!! 找不到 background page / service worker'); }
  else {
    out(`SW 找到: ${sw.url()}`);
    // 调 scanTab(tabId)：通过 runtime.sendMessage
    const tabId = page._guid || null;
    const tabs = await ctx.pages().map(p => ({ url: p.url(), id: p._pageId }));
    out(`当前所有 page: ${JSON.stringify(tabs)}`);

    // 真正方式：通过 page.evaluate 拿扩展暴露的 API（如果有）
    // 否则只能通过 sw.evaluate 调
    try {
      const scanRes = await sw.evaluate(async (tabId) => {
        // 调 background 暴露的 scanTab 函数
        if (typeof globalThis.scanTab === 'function') {
          const assets = await globalThis.scanTab(tabId, { deep: true });
          return { ok: true, n: assets && assets.length, sample: (assets || []).slice(0, 5) };
        }
        return { ok: false, error: 'globalThis.scanTab not found' };
      }, tabs[0]?.id);
      out(`scanTab 结果: ${JSON.stringify(scanRes, null, 2)}`);
    } catch (e) {
      out(`scanTab 注入失败: ${e.message}`);
    }
  }

  out('--- console 捕获 ---');
  for (const l of consoleLogs.slice(-80)) out(l);

  await ctx.close();
  out('DONE');
}

main().catch((e) => { out('FATAL ' + e.message); process.exit(1); });
