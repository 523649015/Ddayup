// 自动化验证：加载扩展 + 打开迅雷分享页 + 执行探针 + 抓取全部相关 Console 日志
// 不依赖用户手动贴日志。用持久化 profile 以保留迅雷登录态（若本机已登录过）。
import { chromium } from 'playwright';
import fs from 'fs';

const EXT_PATH = 'f:/Work/HMDAODAO/extension';
const SHARE_URL = 'https://pan.xunlei.com/s/VOj-h8suAkW9oy_-90W8M4r9A1?pwd=qkva&path=%2F%E6%A4%8D%E7%89%A9%E5%A4%A7%E6%88%98%E5%B0%B8%E6%9D%82%E4%BA%A4%E7%89%88';
const FID = 'VOj-gdWBPeCnQdqryg0WRKi3A1';
const SHARE_ID = 'VOj-h8suAkW9oy_-90W8M4r9A1';
const PWD = 'qkva';
const PROFILE = 'f:/Work/HMDAODAO/tmp/chrome-xunlei-probe';

// 可选：用本机真实 Chrome 的 profile 目录（若你想带登录态）。留空则用上面的临时持久 profile。
// const PROFILE = 'C:/Users/123/AppData/Local/Google/Chrome/User Data';

const logs = [];
const want = (t) => /\[PROBE\]|\[HMDAO\]\[xunlei|\[BRIDGE-RAW\]|\[TEST\]|\[xunlei-bridge\]/.test(t);

async function main() {
  fs.mkdirSync(PROFILE, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-first-run',
    ],
  });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (want(t)) { logs.push(t); console.log('[PAGE]', t); }
  });
  page.on('pageerror', (e) => console.log('[PAGEERROR]', e.message));

  console.log('>> 打开分享页...');
  await page.goto(SHARE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => console.log('goto err', e.message));
  // 等扩展 content script 注入 + MAIN world 函数就绪
  await page.waitForTimeout(4000);

  const probeType = await page.evaluate(() => typeof window.__hmdao_xunlei_probe);
  console.log('>> __hmdao_xunlei_probe typeof =', probeType);

  if (probeType !== 'function') {
    console.log('!! 探针函数未注入，可能扩展未加载或 MAIN world 未就绪。等待更久再试...');
    await page.waitForTimeout(4000);
    const retry = await page.evaluate(() => typeof window.__hmdao_xunlei_probe);
    console.log('>> retry typeof =', retry);
  }

  // 注册 BRIDGE-RAW 监听
  await page.evaluate(() => {
    window.addEventListener('message', e => {
      if (e.data && e.data.__hmdao_type === 'XUNLEI_FETCH_RESULT')
        console.log('[BRIDGE-RAW]', e.data.status, e.data.error, (e.data.text || '').slice(0, 200));
    });
  });

  console.log('>> 执行探针（最多等 25s）...');
  await page.evaluate((args) => {
    return Promise.race([
      window.__hmdao_xunlei_probe(args.shareId, args.pwd, args.fid).catch(e => console.log('[PROBE] 探针抛错', String(e))),
      new Promise(r => setTimeout(() => { console.log('[PROBE] 探针 25s 软超时（Promise 仍未 settle）'); r(); }, 25000)),
    ]);
  }, { shareId: SHARE_ID, pwd: PWD, fid: FID });

  await page.waitForTimeout(2000);

  console.log('\n========== 捕获到的相关日志总数:', logs.length, '==========');
  for (const l of logs) console.log(l);

  // 顺带查 fileInfo 缓存
  const cache = await page.evaluate(() => {
    try { return JSON.stringify(window.__hmdao_captures?.xunleiShare?.fileInfo || 'no-xunleiShare', null, 1); }
    catch (e) { return 'err ' + e.message; }
  });
  console.log('\n>> fileInfo 缓存:\n', cache.slice(0, 1500));

  await ctx.close();
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
