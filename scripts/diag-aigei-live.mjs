// 实地验证：加载 Ddayup 扩展 + 真实登录态爱给页，点击试听，验证 audioPlays 是否被捕获
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.resolve(__dirname, '../app/package.json'));
const { chromium } = require('playwright');
const EXT_PATH = path.resolve(__dirname, '../extension');
const USER_DATA = 'f:/Work/HMDAODAO/tmp/chrome-aigei'; // 复制的已登录 profile
const CHROME_EXE = process.env.CHROME_EXE || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const ctx = await chromium.launchPersistentContext(USER_DATA, {
  headless: false, executablePath: CHROME_EXE,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-first-run'],
});

const page = await ctx.newPage();
page.on('console', (m) => { const t = m.text(); if (/hmdao|DIAG|音频|audio|试听/i.test(t)) console.log(`[page] ${t}`); });

console.log('打开爱给 class 页（已登录 profile）…');
await page.goto('https://www.aigei.com/music/class/', { waitUntil: 'domcontentloaded', timeout: 60000 });
// 等待扩展 MAIN 钩子注入
await page.waitForTimeout(3000);

// 校验扩展 MAIN 钩子是否生效
const hookState = await page.evaluate(() => ({
  captures: !!window.__hmdao_captures,
  audioCapture: !!window.__hmdao_audio_capture,
  audioPlaysLen: (window.__hmdao_captures && window.__hmdao_captures.audioPlays || []).length,
}));
console.log('扩展钩子状态:', JSON.stringify(hookState));

if (!hookState.captures) {
  console.log('⚠️ 扩展 MAIN 钩子未生效（__hmdao_captures 不存在），无法验证。请检查扩展是否加载。');
}

// 找试听按钮（已登录后应该存在）
const targets = await page.evaluate(() => {
  const res = [];
  document.querySelectorAll('a,button,span,div,i,em,li').forEach((el) => {
    if (el.offsetParent === null) return;
    const t = (el.textContent || '').trim();
    const cls = String(el.className || '');
    if (/试听/.test(t) || /audition|icon-play|play-btn|listen|sound-play/i.test(cls)) res.push({ tag: el.tagName, txt: t.slice(0, 15), cls: cls.slice(0, 40) });
  });
  return res.slice(0, 20);
});
console.log('试听候选数量:', targets.length);
console.log(JSON.stringify(targets.slice(0, 5), null, 2));

// 点击前快照
const before = await page.evaluate(() => (window.__hmdao_captures && window.__hmdao_captures.audioPlays || []).length);

// 逐个点击前 6 个试听候选
for (let i = 0; i < Math.min(targets.length, 6); i++) {
  const t = targets[i];
  try {
    const loc = page.locator(`text=${t.txt}`).first();
    if (await loc.count()) { await loc.click({ timeout: 3000 }); await page.waitForTimeout(1500); }
  } catch (_) {}
}

await page.waitForTimeout(2000);

const result = await page.evaluate(() => {
  const c = window.__hmdao_captures;
  if (!c) return { ok: false, reason: 'no captures' };
  const ap = c.audioPlays || [];
  return { ok: true, audioPlaysLen: ap.length, sample: ap.slice(0, 5) };
});

console.log('\n===== 验证结果 =====');
console.log('点击前 audioPlays 数:', before);
console.log('点击后 audioPlays:', JSON.stringify(result, null, 2));

if (result.ok && result.audioPlaysLen > before) {
  console.log('\n✅ 成功：扩展采集到了爱给试听音效！');
} else {
  console.log('\n❌ 失败：未采集到音效。需要换机制（Web Audio / MSE）。');
}

await page.waitForTimeout(500);
await ctx.close();
process.exit(0);
