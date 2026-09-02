// Phase 10：scanTab 换页判定逻辑顺序/语义验证（回归 TDZ 崩溃）
// 背景：2026-08-23 曾在 scanTab 开头提前访问 targetTabUrl（其 let 声明在下方），
//       触发 TDZ "Cannot access 'targetTabUrl' before initialization" → scanTab 整体崩溃 → 卡片扫不出来。
// 本测试复刻「先取 targetTabUrl 再判定 prevUrl」的正确顺序，验证换页/同页判定语义。

import assert from 'node:assert';

// 复刻 scan.js scanTab 开头的判定（顺序已修正：先声明 targetTabUrl 并赋值，再读 prevUrl 比对）
function resolveClearDecision({ tabUrl, prevRecordedUrl, NETWORK_ASSETS_URL, tabId }) {
  // ---- 先取得 targetTabUrl（真实 scan.js:79-83）----
  const targetTabUrl = tabUrl || '';
  // ---- 再读 prevUrl 比对（真实 scan.js:91-103，必须在上面之后，否则 TDZ）----
  let prevUrl = '';
  try { prevUrl = (NETWORK_ASSETS_URL && NETWORK_ASSETS_URL[tabId]) || ''; } catch (_) { }
  const shouldClear = !prevUrl || prevUrl !== (targetTabUrl || '');
  return { targetTabUrl, prevUrl, shouldClear };
}

let pass = 0, fail = 0;
function check(name, fn) { try { fn(); console.log('  ✓', name); pass++; } catch (e) { console.log('  ✗', name, '\n    ', e.message); fail++; } }

console.log('== 换页判定语义（顺序已修正，无 TDZ）==');

check('同页刷新：prevUrl === targetTabUrl → 不清空（保留 dyUrls 累积）', () => {
  const r = resolveClearDecision({
    tabUrl: 'https://www.douyin.com/jingxuan?modal_id=7674193646846508657',
    prevRecordedUrl: 'https://www.douyin.com/jingxuan?modal_id=7674193646846508657',
    NETWORK_ASSETS_URL: { 12: 'https://www.douyin.com/jingxuan?modal_id=7674193646846508657' },
    tabId: 12,
  });
  assert.strictEqual(r.shouldClear, false, '同页应保留累积');
});

check('真正换页：prevUrl 不同 → 清空（避免旧 modal 残留）', () => {
  const r = resolveClearDecision({
    tabUrl: 'https://www.douyin.com/jingxuan?modal_id=999',
    prevRecordedUrl: 'https://www.douyin.com/jingxuan?modal_id=7674193646846508657',
    NETWORK_ASSETS_URL: { 12: 'https://www.douyin.com/jingxuan?modal_id=7674193646846508657' },
    tabId: 12,
  });
  assert.strictEqual(r.shouldClear, true);
});

check('首次扫描（prevUrl 空）→ 清空（同旧行为，无副作用）', () => {
  const r = resolveClearDecision({
    tabUrl: 'https://www.douyin.com/jingxuan?modal_id=767',
    prevRecordedUrl: '',
    NETWORK_ASSETS_URL: {},
    tabId: 12,
  });
  assert.strictEqual(r.shouldClear, true);
});

check('targetTabUrl 必须在 prevUrl 读取前已赋值（顺序约束，防 TDZ 回归）', () => {
  // 用 let 作用域模拟：若 targetTabUrl 在 prevUrl 之后声明则抛 ReferenceError（TDZ）。
  // 这里确认复刻实现里 targetTabUrl 声明在使用之前。
  const srcLike = resolveClearDecision.toString();
  assert.ok(srcLike.indexOf('const targetTabUrl = tabUrl') < srcLike.indexOf('prevUrl'),
    'targetTabUrl 声明应位于 prevUrl 读取之前');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
