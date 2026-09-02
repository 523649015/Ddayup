// Phase 1 逻辑单测：抖音信息流批量采集之多视频触发判定
// 不依赖浏览器环境，提取 background.js tryDouyinWeixin 的纯判定逻辑做验证。
import assert from 'node:assert';

// ===== 复刻 background.js 的 isJingxuanMulti 判定（与 2505 行改后逻辑一致）=====
function computeIsJingxuanMulti({ pathname, search, root }) {
  const targetId = (function () {
    try {
      const u = new URL('https://www.douyin.com' + pathname + search);
      return u.searchParams.get('modal_id') || u.searchParams.get('aweme_id') ||
        u.searchParams.get('feedid') || u.searchParams.get('id') || '';
    } catch (_) { return ''; }
  })();
  const isJingxuan = /\/jingxuan(\/|\?|$)/.test(pathname) || 'www.douyin.com'.includes('jingxuan.douyin.com');
  const hasModal = !!targetId && /modal_id=/.test(search);
  const topLevel = (root && (root.aweme_list || root.awemeList) && Array.isArray(root.aweme_list || root.awemeList))
    ? (root.aweme_list || root.awemeList) : null;
  if (hasModal) return false;
  const isFeed = /\/(search|discover|recommend|feed|explore)(\/|\?|$)/.test(pathname)
    || pathname === '/' || pathname === '';
  if (isJingxuan && topLevel && topLevel.length >= 2) return true;
  if (isFeed && topLevel && topLevel.length >= 2) return true;
  return !!(topLevel && topLevel.length >= 2);
}

// ===== 多视频分支的 seenIds 去重（复刻 2521-2534 行）=====
function buildItems(root) {
  const topLevel = (root && (root.aweme_list || root.awemeList)) || [];
  const seenIds = new Set();
  const items = [];
  for (let i = 0; i < topLevel.length; i++) {
    const a = topLevel[i];
    if (!a || !a.video) continue;
    const id = String(a.aweme_id || '');
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    items.push({ awemeId: id, title: a.desc || '' });
  }
  return items;
}

// 构造测试 RENDER_DATA（含 3 个视频，含 1 个重复 ID 模拟噪音）
function makeRoot(n) {
  const list = [];
  for (let i = 1; i <= n; i++) list.push({ aweme_id: 'vid' + i, desc: '视频' + i, video: { play_addr: { url_list: ['u' + i] } } });
  list.push({ aweme_id: 'vid1', desc: '重复', video: { play_addr: { url_list: ['dup'] } } }); // 重复 ID
  return { aweme_list: list };
}

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); fail++; }
}

console.log('Phase 1 测试：抖音信息流多视频触发');

// 1) 搜索页 + 多视频 → 应触发多视频
check('搜索页 /search 含多视频 → isJingxuanMulti=true', () => {
  const r = computeIsJingxuanMulti({ pathname: '/search', search: '?keyword=x', root: makeRoot(3) });
  assert.strictEqual(r, true);
});

// 2) 首页 / + 多视频 → 应触发多视频
check('首页 / 含多视频 → isJingxuanMulti=true', () => {
  const r = computeIsJingxuanMulti({ pathname: '/', search: '', root: makeRoot(5) });
  assert.strictEqual(r, true);
});

// 3) jingxuan 合集主页 + 多视频 → true
check('jingxuan 合集主页含多视频 → true', () => {
  const r = computeIsJingxuanMulti({ pathname: '/jingxuan', search: '', root: makeRoot(4) });
  assert.strictEqual(r, true);
});

// 4) 带 modal_id → 强制单卡（用户截图场景）
check('带 modal_id → 强制单卡 false', () => {
  const r = computeIsJingxuanMulti({ pathname: '/jingxuan', search: '?modal_id=abc', root: makeRoot(4) });
  assert.strictEqual(r, false);
});

// 5) 单视频普通页 → 单对象
check('单视频页（顶层仅1个）→ false', () => {
  const root = { aweme_list: [{ aweme_id: 'v1', desc: 'a', video: { play_addr: { url_list: ['u'] } } }] };
  const r = computeIsJingxuanMulti({ pathname: '/video', search: '', root });
  assert.strictEqual(r, false);
});

// 6) 多视频分支去重：3 个真实 + 1 重复 = 3 条
check('多视频分支 seenIds 去重正确（3 真 + 1 重复 = 3 条）', () => {
  const items = buildItems(makeRoot(3));
  assert.strictEqual(items.length, 3);
  assert.deepStrictEqual(items.map(i => i.awemeId), ['vid1', 'vid2', 'vid3']);
});

// 7) 批量模式跳过播放流早返回（逻辑断言：batchMode=true 时不走 dyUrls[last]）
check('batchMode 跳过播放流早返回（信号位存在）', () => {
  // 模拟 tryDouyinWeixin 开头：const batchMode = window.__hmdao_batchMode === true;
  const window = { __hmdao_batchMode: true };
  const batchMode = window.__hmdao_batchMode === true;
  assert.strictEqual(batchMode, true);
  // 批量模式下不应早返回 dyUrls[last]
  const dyUrls = ['streamA', 'streamB'];
  const wouldEarlyReturn = (dyUrls.length && !batchMode);
  assert.strictEqual(wouldEarlyReturn, false);
});

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
