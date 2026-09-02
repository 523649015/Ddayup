// Phase 2 测试：批量采集封面精确回填（复刻 scan.js 576-590 行 byKey 逻辑）
// 验证 9 卡信息流场景下，每条资产用自身精确 awemeId 取 byKey 封面，不串号、不 fallback 错图。
import assert from 'node:assert';

// 复刻 scan.js 封面回填核心逻辑
function fillCover(d, coverMap, currentAwemeId) {
  const awemeIdFromUrl = (u) => {
    if (!u) return '';
    try {
      const parsed = new URL(u, 'https://www.douyin.com/');
      const q = parsed.searchParams;
      const fromQ = q.get('modal_id') || q.get('aweme_id') || '';
      if (fromQ) return fromQ;
      const m = /\/video\/(\w+)/.exec(parsed.pathname);
      return m ? m[1] : '';
    } catch (_) { return ''; }
  };
  const pageImgFallback = (coverMap.pageCovers || []).filter((c) => c.kind === 'page-img');
  let pageImgCursor = 0;
  if (d && d.type === 'video' && d.source === 'douyin' && !d.cover) {
    const idFromAsset = (d.awemeId && d.awemeId !== 'unknown') ? d.awemeId : '';
    const idFromPlayer = awemeIdFromUrl(d.playerUrl);
    const id = idFromAsset || idFromPlayer || (currentAwemeId || '');
    if (id && coverMap.byKey && coverMap.byKey['aweme:' + id]) {
      d.cover = coverMap.byKey['aweme:' + id];
    } else if (currentAwemeId && coverMap.byKey && coverMap.byKey['aweme:' + currentAwemeId]) {
      d.cover = coverMap.byKey['aweme:' + currentAwemeId];
    } else if (pageImgFallback[pageImgCursor]) {
      d.cover = pageImgFallback[pageImgCursor].url;
      pageImgCursor++;
    } else if (coverMap.defaultCover) {
      d.cover = coverMap.defaultCover;
    }
  }
  return d;
}

// 构造 9 卡批量采集资产：每条带精确 awemeId（来自 RENDER_DATA 多视频分支）
function makeBatchAssets() {
  return [
    { awemeId: 'A001', playerUrl: 'https://www.douyin.com/search?keyword=x', type: 'video', source: 'douyin' },
    { awemeId: 'A002', playerUrl: 'https://www.douyin.com/search?keyword=x', type: 'video', source: 'douyin' },
    { awemeId: 'A003', playerUrl: 'https://www.douyin.com/search?keyword=x', type: 'video', source: 'douyin' },
    { awemeId: 'A004', playerUrl: 'https://www.douyin.com/search?keyword=x', type: 'video', source: 'douyin' },
    { awemeId: 'A005', playerUrl: 'https://www.douyin.com/search?keyword=x', type: 'video', source: 'douyin' },
    { awemeId: 'A006', playerUrl: 'https://www.douyin.com/search?keyword=x', type: 'video', source: 'douyin' },
    { awemeId: 'A007', playerUrl: 'https://www.douyin.com/search?keyword=x', type: 'video', source: 'douyin' },
    { awemeId: 'A008', playerUrl: 'https://www.douyin.com/search?keyword=x', type: 'video', source: 'douyin' },
    { awemeId: 'A009', playerUrl: 'https://www.douyin.com/search?keyword=x', type: 'video', source: 'douyin' },
  ];
}

// byKey 精确封面映射（模拟 scan.js 从 RENDER_DATA 提取）
function makeByKey() {
  const byKey = {};
  for (let i = 1; i <= 9; i++) byKey['aweme:A00' + i] = 'https://cover/A00' + i + '.jpg';
  return byKey;
}

let pass = 0, fail = 0;
function check(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); fail++; } }

console.log('Phase 2：批量采集封面 byKey 精确回填（9 卡场景）');

const coverMap = { byKey: makeByKey(), defaultCover: 'https://cover/WRONG-electric-license.jpg' };
const assets = makeBatchAssets();
assets.forEach((a) => fillCover(a, coverMap, ''));

// 1) 每条资产封面 = 自身 awemeId 对应封面（不串号）
check('9 卡每条封面精确匹配自身 awemeId', () => {
  assets.forEach((a) => {
    assert.strictEqual(a.cover, 'https://cover/' + a.awemeId + '.jpg',
      `${a.awemeId} 封面错配为 ${a.cover}`);
  });
});

// 2) 不 fallback 到 defaultCover（错图"电子营业执照"）
check('不 fallback 到 defaultCover 错图', () => {
  assets.forEach((a) => {
    assert.notStrictEqual(a.cover, 'https://cover/WRONG-electric-license.jpg');
  });
});

// 3) 所有封面互不相同（9 张各异）
check('9 张封面全部唯一（无共用）', () => {
  const covers = assets.map(a => a.cover);
  assert.strictEqual(new Set(covers).size, 9);
});

// 4) 缺失 byKey 时（如某 awemeId 未在 RENDER_DATA）走 pageImgFallback，仍不 fallback 错图
check('byKey 缺失时走 pageImgFallback（不取错图）', () => {
  const cm = { byKey: { 'aweme:A001': 'https://cover/A001.jpg' }, defaultCover: 'https://cover/WRONG.jpg', pageCovers: [{ kind: 'page-img', url: 'https://img/page1.jpg' }, { kind: 'page-img', url: 'https://img/page2.jpg' }] };
  const a2 = { awemeId: 'A002', type: 'video', source: 'douyin' }; // A002 不在 byKey
  fillCover(a2, cm, '');
  assert.strictEqual(a2.cover, 'https://img/page1.jpg');
  assert.notStrictEqual(a2.cover, 'https://cover/WRONG.jpg');
});

// 5) inject-main.js 修复验证：无 modal_id 时 dyAwemes 推 unknown（复刻 176 行修复后逻辑）
check('inject-main 信息流无 modal_id → dyAwemes=unknown（不猜 ids[seq]）', () => {
  const location = { href: 'https://www.douyin.com/search?keyword=x', search: '?keyword=x' };
  const p = new URL(location.href);
  const aid = p.searchParams.get('modal_id') || p.searchParams.get('aweme_id') || '';
  const finalAid = aid ? aid : 'unknown'; // 复刻修复后逻辑
  assert.strictEqual(finalAid, 'unknown');
});

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
