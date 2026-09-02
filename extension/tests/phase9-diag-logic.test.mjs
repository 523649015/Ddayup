// Phase 9：真机诊断函数 __hmdaoRunFullDiag 的「判定矩阵」逻辑验证
// 复刻诊断结论判定，确保真机运行时不会误报（如把"生效"判成"失败"）。

import assert from 'node:assert';

// 复刻诊断判定（与 sidepanel.js __hmdaoRunFullDiag 内 L() 一致）
function diagConclusions(sidepanel, lastScan, page) {
  const out = {};
  out.A = sidepanel.window_assets_total > 0;                                  // 断裂A 回填
  out.consistent = sidepanel.consistent;                                      // 一致性
  out.D = sidepanel.batchAssets_total === sidepanel.batchVisibleInAssets;      // 隔离D 可见
  out.B = !!(lastScan && (lastScan.assets || []).length);                     // 持久化B
  if (page && !page.error) {
    out.C = page.dyUrlsCount > 0;                                             // 累积C 未误清空
    out.precise = !!page.curAwemeId && page.curAwemeId !== '(空)';             // 精准 curAwemeId
  }
  return out;
}

let pass = 0, fail = 0;
function check(name, fn) { try { fn(); console.log('  ✓', name); pass++; } catch (e) { console.log('  ✗', name, '\n    ', e.message); fail++; } }

console.log('== 诊断判定矩阵 ==');

check('全部生效场景：A/B/C/D/一致性/精准 全 true', () => {
  const sp = { window_assets_total: 5, consistent: true, batchAssets_total: 3, batchVisibleInAssets: 3 };
  const ls = { assets: new Array(5), url: 'u', ts: 1 };
  const page = { dyUrlsCount: 2, curAwemeId: 'A1' };
  const c = diagConclusions(sp, ls, page);
  assert.deepStrictEqual(c, { A: true, consistent: true, D: true, B: true, C: true, precise: true });
});

check('断裂A 未修复（window.assets 空）：A=false 但 D/B 仍可 true（诊断要能区分）', () => {
  const sp = { window_assets_total: 0, consistent: true, batchAssets_total: 3, batchVisibleInAssets: 3 };
  const ls = { assets: new Array(5) };
  const page = { dyUrlsCount: 2, curAwemeId: 'A1' };
  const c = diagConclusions(sp, ls, page);
  assert.strictEqual(c.A, false, 'A 应判为未回填');
  assert.strictEqual(c.B, true, 'B 持久化独立判定');
  assert.strictEqual(c.D, true, 'D 隔离独立判定');
});

check('批量资产未展示（隔离失效）：D=false', () => {
  const sp = { window_assets_total: 5, consistent: false, batchAssets_total: 3, batchVisibleInAssets: 0 };
  const ls = { assets: new Array(5) };
  const page = { dyUrlsCount: 2, curAwemeId: 'A1' };
  const c = diagConclusions(sp, ls, page);
  assert.strictEqual(c.D, false, '批量未在 window.assets 展示应判失效');
  assert.strictEqual(c.consistent, false, '一致性应判 false');
});

check('持久化丢失（刷新无法恢复）：B=false', () => {
  const sp = { window_assets_total: 5, consistent: true, batchAssets_total: 0, batchVisibleInAssets: 0 };
  const ls = null; // lastScan 空
  const page = { dyUrlsCount: 2, curAwemeId: 'A1' };
  const c = diagConclusions(sp, ls, page);
  assert.strictEqual(c.B, false);
});

check('源页 dyUrls 被误清空（根因C 未修）：C=false', () => {
  const sp = { window_assets_total: 5, consistent: true, batchAssets_total: 3, batchVisibleInAssets: 3 };
  const ls = { assets: new Array(5) };
  const page = { dyUrlsCount: 0, curAwemeId: '(空)' };
  const c = diagConclusions(sp, ls, page);
  assert.strictEqual(c.C, false, 'dyUrls 空应判误清空');
});

check('curAwemeId 空（真机 MSE 风险，非 bug）：precise=false 但仍能运行', () => {
  const sp = { window_assets_total: 5, consistent: true, batchAssets_total: 3, batchVisibleInAssets: 3 };
  const ls = { assets: new Array(5) };
  const page = { dyUrlsCount: 2, curAwemeId: '(空)' };
  const c = diagConclusions(sp, ls, page);
  assert.strictEqual(c.precise, false);
  assert.strictEqual(c.A, true, '其它项仍正确');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
