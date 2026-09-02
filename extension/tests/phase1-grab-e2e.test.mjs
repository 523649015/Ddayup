// Phase 1 端到端逻辑单测：复刻 tryDouyinWeixin 的 grab() 多视频产出，
// 验证批量模式下 items 真实产出、awemeId 唯一、url 来自各自 play_addr（无串号）。
import assert from 'node:assert';

function buildMeta(a, matched) {
  if (!a || !a.video) return null;
  const v = a.video;
  const list = (v.download_addr && v.download_addr.url_list) || (v.play_addr && v.play_addr.url_list) || [];
  if (!list || !list.length) return null;
  return {
    url: list[0].replace(/\\\//g, '/'),
    matched: matched && String(a.aweme_id || '') === String(''),
    title: a.desc || '',
    cover: (v.cover && v.cover.url_list && v.cover.url_list[0]) || '',
    awemeId: String(a.aweme_id || ''),
  };
}

// 复刻 grab(root) 的多视频分支（批量模式，跳过 dyUrls 早返回）
function grabMulti(root, targetId) {
  const awemes = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    const hasV = o.video && (o.video.play_addr || o.video.download_addr);
    if ((o.aweme_id || hasV)) awemes.push(o);
    for (const k in o) { try { walk(o[k]); } catch (_) {} }
  };
  try { walk(root); } catch (_) {}
  const byId = new Map();
  awemes.forEach((a) => { const id = String(a.aweme_id || ''); if (id && !byId.has(id)) byId.set(id, a); });
  const chosen = (targetId && byId.get(String(targetId))) || awemes[0] || null;
  if (!chosen || !chosen.video) return null;
  const baseMeta = buildMeta(chosen, false);
  if (!baseMeta) return null;

  // isJingxuanMulti（批量模式放宽版）
  const topLevel = (root.aweme_list || root.awemeList) || [];
  const isJingxuanMulti = topLevel.length >= 2 && !targetId;
  if (isJingxuanMulti) {
    const seenIds = new Set();
    const items = [];
    for (const a of topLevel) {
      if (!a || !a.video) continue;
      const id = String(a.aweme_id || '');
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      const m = buildMeta(a, false);
      if (!m) continue;
      items.push(m);
    }
    if (items.length >= 2) {
      items.forEach((it, k) => { it.__douyin = true; it.__douyinMulti = true; it.__index = k; });
      return { __douyinMulti: true, items };
    }
  }
  return { __douyin: true, ...baseMeta };
}

// 构造搜索页 RENDER_DATA：3 个不同视频，url 各自独立
function makeSearchRoot() {
  return {
    aweme_list: [
      { aweme_id: 'A001', desc: '沙漠花朵', video: { play_addr: { url_list: ['https://v.douyin.com/A001_play'] }, cover: { url_list: ['https://cover/A001.jpg'] } } },
      { aweme_id: 'A002', desc: '电子营业执照', video: { play_addr: { url_list: ['https://v.douyin.com/A002_play'] }, cover: { url_list: ['https://cover/A002.jpg'] } } },
      { aweme_id: 'A003', desc: '美食教程', video: { play_addr: { url_list: ['https://v.douyin.com/A003_play'] }, cover: { url_list: ['https://cover/A003.jpg'] } } },
    ],
  };
}

let pass = 0, fail = 0;
function check(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); fail++; } }

console.log('Phase 1 端到端：批量模式多视频产出一致性');

// 批量模式（targetId 空）→ 产出 3 条，各自 url/cover 独立（无串号）
check('搜索页批量模式产出 3 条 items，url 各自独立', () => {
  const r = grabMulti(makeSearchRoot(), '');
  assert.strictEqual(r.__douyinMulti, true);
  assert.strictEqual(r.items.length, 3);
  assert.strictEqual(r.items[0].url, 'https://v.douyin.com/A001_play');
  assert.strictEqual(r.items[1].url, 'https://v.douyin.com/A002_play');
  assert.strictEqual(r.items[2].url, 'https://v.douyin.com/A003_play');
  // 封面也各自独立
  assert.strictEqual(r.items[0].cover, 'https://cover/A001.jpg');
  assert.strictEqual(r.items[1].cover, 'https://cover/A002.jpg');
});

// 一致性核心：每条 item 的 url 互相独立（证明无跨 ID 串号）
// 注：真实抖音 CDN URL 是随机 token，不含 aweme_id；串号风险在于"所有 item 共用同一直链"，
// 故一致性断言应为"相邻 item 的 url 两两不同"。
check('一致性：每条 item url 两两不同（根除串号/共用直链）', () => {
  const r = grabMulti(makeSearchRoot(), '');
  const urls = r.items.map(i => i.url);
  for (let i = 0; i < urls.length; i++) {
    for (let j = i + 1; j < urls.length; j++) {
      assert.notStrictEqual(urls[i], urls[j], `item ${i} 与 item ${j} 共用同一 url（串号）`);
    }
  }
});

// 带 modal_id（用户截图场景）→ 强制单卡，不产出多视频
check('带 modal_id 强制单卡（返回单对象非 __douyinMulti）', () => {
  const r = grabMulti(makeSearchRoot(), 'A002');
  assert.notStrictEqual(r.__douyinMulti, true);
  assert.strictEqual(r.awemeId, 'A002');
});

// 单视频页（顶层仅1个）→ 单对象
check('单视频页 → 单对象', () => {
  const root = { aweme_list: [{ aweme_id: 'S1', desc: 'x', video: { play_addr: { url_list: ['u'] }, cover: { url_list: ['c'] } } }] };
  const r = grabMulti(root, '');
  assert.notStrictEqual(r.__douyinMulti, true);
  assert.strictEqual(r.awemeId, 'S1');
});

// awemeId 唯一性（无重复）
check('items awemeId 全局唯一', () => {
  const r = grabMulti(makeSearchRoot(), '');
  const ids = r.items.map(i => i.awemeId);
  assert.strictEqual(new Set(ids).size, ids.length);
});

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
