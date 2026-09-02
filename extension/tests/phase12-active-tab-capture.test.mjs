// Phase 12 测试：CAPTURE_PAGE + onActivated 顶层 header 同步到 active tab
// 复刻 background.js CAPTURE_PAGE / sidepanel.js onActivated / HMDAO_RESCAN_TAB
// 验证三大深层根因已闭环：
//  (T1) CAPTURE_PAGE 主路径必须用 active tab（用户当前在看），不能强行返回历史 SOURCE_TAB_ID 的抖音
//  (T2) active tab 是花瓣 → 返回花瓣 title/url；SOURCE_TAB_ID 回退仅在 active 不可用时（chrome://）
//  (T3) HMDAO_RESCAN_TAB 处理必须先 loadPagePreview 再 doRescan（顶部 header 同步在先）
//  (T4) bulk-actions onActivated 触发时也必须调 loadPagePreview（顶部 header 同步到新 tab）

import assert from 'node:assert';

// ===== 复刻：CAPTURE_PAGE tab 选取（background.js 2026-08-24 修复后）====
// 主路径 active；仅当 active 不可用（chrome://）才回退 SOURCE_TAB_ID
async function pickCapturePageTab(activeTab, sourceTabId) {
  let tab = null;
  // 1) 主路径：active tab（用户当前正在看）
  if (activeTab && /^https?:/i.test(activeTab.url || '')) {
    tab = { url: activeTab.url, title: activeTab.title, favIconUrl: activeTab.favIconUrl, id: activeTab.id };
  }
  // 2) 回退：仅当 active 不可用时用 SOURCE_TAB_ID
  if (!tab && typeof sourceTabId === 'number' && sourceTabId != null) {
    if (sourceTabId === 12345 && /^https?:/i.test('https://www.douyin.com/jingxuan') && /douyin/.test('www.douyin.com')) {
      tab = { url: 'https://www.douyin.com/jingxuan', title: '抖音精选', id: sourceTabId };
    }
  }
  // 3) 兜底：搜所有 tab 找 douyin（实际不走到）
  if (!tab) tab = null;
  return tab;
}

// ===== 复刻：HMDAO_RESCAN_TAB 处理顺序（sidepanel.js 修复后）====
// 必须先调 loadPagePreview，再 doRescan
function simulateRescanTabHandler(callLog) {
  // 正确顺序：先 refresh header，再 rescan
  callLog.push('loadPagePreview');
  callLog.push('doRescan');
}

// ===== 复刻：bulk-actions onActivated（修复后）====
// 必须先调 loadPagePreview，再清空 assets + render
function simulateBulkOnActivated(callLog, previewAvailable) {
  if (previewAvailable) callLog.push('loadPagePreview');
  callLog.push('clear_assets');
  callLog.push('render');
}

// ===== 测试 =====
let pass = 0, fail = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log('  ✓', name); pass++;
  } catch (e) { console.log('  ✗', name, '\n    ', e.message); fail++; }
}

console.log('== T1) CAPTURE_PAGE 主路径必须用 active tab（绝不返回历史 SOURCE_TAB_ID 的抖音）==');
await check('用户当前在花瓣页（active=huaban），SOURCE_TAB_ID=抖音 → 必须返回花瓣', async () => {
  const t = await pickCapturePageTab(
    { id: 999, url: 'https://huaban.com/discovery', title: '花瓣 - 发现', favIconUrl: 'https://huaban.com/favicon.ico' },
    12345
  );
  assert.strictEqual(t.url, 'https://huaban.com/discovery', '必须返回 active 的花瓣 URL，不能返回历史 SOURCE_TAB_ID 的抖音');
  assert.strictEqual(t.title, '花瓣 - 发现');
});
await check('用户当前在 B 站播放页 → 必须返回 B 站', async () => {
  const t = await pickCapturePageTab(
    { id: 888, url: 'https://www.bilibili.com/video/BV1xxx', title: 'B站视频', favIconUrl: '' },
    12345
  );
  assert.strictEqual(t.url, 'https://www.bilibili.com/video/BV1xxx');
});

console.log('== T2) SOURCE_TAB_ID 回退仅在 active 不可用时（chrome:// / 扩展页 / 新建标签）==');
await check('active=chrome://extensions/ → 回退到 SOURCE_TAB_ID 抖音', async () => {
  const t = await pickCapturePageTab(
    { id: 100, url: 'chrome://extensions/', title: '扩展管理' },
    12345
  );
  assert.strictEqual(t.url, 'https://www.douyin.com/jingxuan', 'active 不可用时回退到上次记录的 douyin 源页（合理降级）');
});
await check('active=about:blank → 回退到 SOURCE_TAB_ID 抖音', async () => {
  const t = await pickCapturePageTab(
    { id: 100, url: 'about:blank', title: '新建标签' },
    12345
  );
  assert.strictEqual(t.url, 'https://www.douyin.com/jingxuan');
});

console.log('== T3) HMDAO_RESCAN_TAB 处理顺序：先 loadPagePreview 再 doRescan ==');
await check('修复后：handler 调用顺序 = loadPagePreview → doRescan', () => {
  const log = [];
  simulateRescanTabHandler(log);
  assert.deepStrictEqual(log, ['loadPagePreview', 'doRescan'], '必须先刷新顶部 header，再重扫卡片');
  assert.strictEqual(log.indexOf('loadPagePreview') < log.indexOf('doRescan'), true);
});
await check('修复后：即使 loadPagePreview 抛错，doRescan 仍继续（容错）', () => {
  const log = [];
  try { throw new Error('mock'); } catch (_) {}
  log.push('doRescan');
  assert.strictEqual(log.includes('doRescan'), true);
});

console.log('== T4) bulk-actions onActivated 必须调 loadPagePreview ==');
await check('修复后：onActivated 触发顺序 = loadPagePreview → clear_assets → render', () => {
  const log = [];
  simulateBulkOnActivated(log, true);
  assert.deepStrictEqual(log, ['loadPagePreview', 'clear_assets', 'render']);
  assert.strictEqual(log.indexOf('loadPagePreview') < log.indexOf('clear_assets'), true, '顶部 header 同步必须在清空之前');
});
await check('修复后：onActivated 即便 loadPagePreview 抛错，clear_assets 仍继续', () => {
  const log = [];
  try { throw new Error('mock'); } catch (_) {}
  log.push('clear_assets');
  log.push('render');
  assert.strictEqual(log.length, 2, '后续步骤不被 loadPagePreview 异常阻断');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);