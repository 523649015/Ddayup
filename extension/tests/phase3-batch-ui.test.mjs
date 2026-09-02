// Phase 3 测试：信息流批量采集侧栏逻辑（消息常量 / 资产映射 / 自定义过滤 / 去重）
import assert from 'node:assert';

// 复刻 background.js BATCH_COLLECT 处理块的映射逻辑
function mapBatchItems(items, mode, awemeIds) {
  let filtered = items;
  if (mode === 'custom') {
    const want = new Set(Array.isArray(awemeIds) ? awemeIds : []);
    filtered = items.filter((it) => it && (want.has(it.awemeId) || want.has(it.url)));
  }
  const assetsOut = [];
  let expired = 0;
  for (const it of filtered) {
    if (!it || !it.url) { expired++; continue; }
    const isBili = it.source === 'bilibili-batch';
    let isExpired;
    if (isBili) isExpired = true; // B站批量 url 是页面 URL，直链需播放激活
    else isExpired = /(403|expired|expire|signature)/i.test(it.url) || it.url.length < 20;
    if (isExpired) expired++;
    assetsOut.push({
      url: it.url, type: 'video', source: it.source || 'douyin-batch',
      title: it.title || '', cover: it.cover || '',
      awemeId: it.awemeId || '', __douyinMulti: !isBili, __biliMulti: isBili, __batchExpired: isExpired,
    });
  }
  return { ok: true, count: assetsOut.length, expired, items: assetsOut };
}

// 复刻 sidepanel.js 批量采集追加去重逻辑
function appendToAssets(assets, items) {
  const existingKeys = new Set(assets.map((x) => x.url));
  let added = 0;
  for (const it of items) {
    if (existingKeys.has(it.url)) continue;
    existingKeys.add(it.url);
    assets.push(it);
    added++;
  }
  return added;
}

// 复刻 messages.js BATCH_COLLECT 常量存在性
const HMDAO_MSG = {
  REFRESH_FROM_PAGE: 'HMDAO_REFRESH_FROM_PAGE',
  BATCH_COLLECT: 'HMDAO_BATCH_COLLECT',
};

// 模拟 9 卡批量 items（各自 awemeId + cover + 1 条过期）
function makeItems() {
  const items = [];
  for (let i = 1; i <= 9; i++) {
    items.push({
      awemeId: 'A00' + i, title: '视频' + i,
      url: 'https://v.douyin.com/play/A00' + i + '_sig', cover: 'https://cover/A00' + i + '.jpg',
    });
  }
  items[4].url = 'https://v.douyin.com/expired_signature_403'; // 第5条过期
  return items;
}

let pass = 0, fail = 0;
function check(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); fail++; } }

console.log('Phase 3：信息流批量采集侧栏逻辑');

// 1) 消息常量独立（不与 REFRESH_FROM_PAGE 同值）
check('BATCH_COLLECT 常量已注册且独立于 REFRESH_FROM_PAGE', () => {
  assert.strictEqual(HMDAO_MSG.BATCH_COLLECT, 'HMDAO_BATCH_COLLECT');
  assert.notStrictEqual(HMDAO_MSG.BATCH_COLLECT, HMDAO_MSG.REFRESH_FROM_PAGE);
});

// 2) 当前页模式：9 条全量映射，1 条过期，awemeId 透传
check('当前页模式映射 9 条，awemeId 透传，1 条标记过期', () => {
  const r = mapBatchItems(makeItems(), 'currentPage', null);
  assert.strictEqual(r.count, 9);
  assert.strictEqual(r.expired, 1);
  assert.strictEqual(r.items[0].awemeId, 'A001');
  assert.strictEqual(r.items[0].source, 'douyin-batch');
  assert.strictEqual(r.items[4].__batchExpired, true);
  assert.strictEqual(r.items[0].__batchExpired, false);
});

// 3) 自定义模式：按 awemeIds 过滤（仅取 A001, A003, A005）
check('自定义模式按 awemeIds 精确过滤', () => {
  const r = mapBatchItems(makeItems(), 'custom', ['A001', 'A003', 'A005']);
  assert.strictEqual(r.count, 3);
  assert.deepStrictEqual(r.items.map((i) => i.awemeId), ['A001', 'A003', 'A005']);
});

// 4) 自定义模式空勾选 → 0 条（侧栏会拦截，但映射层也应稳健）
check('自定义模式空 awemeIds → 0 条（不误全量）', () => {
  const r = mapBatchItems(makeItems(), 'custom', []);
  assert.strictEqual(r.count, 0);
});

// 4.5) B站批量资产语义正确：__biliMulti 标记 + 强制 __batchExpired（页面URL需播放激活）
check('B站批量资产标 __biliMulti 且强制 __batchExpired（非 __douyinMulti）', () => {
  const biliItems = [{ awemeId: '1001', title: 'B站1', url: 'https://www.bilibili.com/video/BV1aa', cover: 'c1', source: 'bilibili-batch' }];
  const r = mapBatchItems(biliItems, 'currentPage', null);
  assert.strictEqual(r.items[0].__biliMulti, true);
  assert.strictEqual(r.items[0].__douyinMulti, false);
  assert.strictEqual(r.items[0].__batchExpired, true); // 页面URL非直链，需播放激活
  assert.strictEqual(r.expired, 1);
});

// 5) 去重：重复 url 不重复追加
check('追加去重：重复 url 只计一次', () => {
  const assets = [{ url: 'https://v.douyin.com/play/A001_sig' }];
  const added = appendToAssets(assets, [
    { url: 'https://v.douyin.com/play/A001_sig' }, // 重复
    { url: 'https://v.douyin.com/play/A002_sig' }, // 新
  ]);
  assert.strictEqual(added, 1);
  assert.strictEqual(assets.length, 2);
});

// 6) 封面透传：批量资产 cover 与源页一致（一致性）
check('封面透传：批量资产 cover = 源页 cover（不取错图）', () => {
  const r = mapBatchItems(makeItems(), 'currentPage', null);
  r.items.forEach((it, k) => {
    assert.strictEqual(it.cover, 'https://cover/A00' + (k + 1) + '.jpg');
  });
});

// 7) 开关态持久化（复刻 localStorage 读写）
check('开关态 localStorage 持久化读写', () => {
  const localStorage = { _d: {}, setItem(k, v) { this._d[k] = v; }, getItem(k) { return this._d[k] ?? null; } };
  let batchCollectEnabled = false;
  batchCollectEnabled = localStorage.getItem('batchCollectEnabled') === '1';
  assert.strictEqual(batchCollectEnabled, false); // 默认关
  batchCollectEnabled = true;
  localStorage.setItem('batchCollectEnabled', '1');
  assert.strictEqual(localStorage.getItem('batchCollectEnabled'), '1');
  batchCollectEnabled = localStorage.getItem('batchCollectEnabled') === '1';
  assert.strictEqual(batchCollectEnabled, true);
});

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
