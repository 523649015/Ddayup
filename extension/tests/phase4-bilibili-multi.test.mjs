// Phase 4 测试：B站合集/列表批量采集多视频提取（复刻 background.js B站分支 batchMode 逻辑）
import assert from 'node:assert';

// 复刻 B站 batchMode 合集提取逻辑
function grabBiliMulti(s0, batchMode) {
  if (!batchMode) return null;
  try {
    const season = s0.ugcSeason || (s0.videoData && s0.videoData.ugc_season);
    const eps = [];
    if (season && Array.isArray(season.sections)) {
      season.sections.forEach((sec) => { if (sec && Array.isArray(sec.episodes)) eps.push(...sec.episodes); });
    }
    if (!eps.length && Array.isArray(s0.relatedVideos)) eps.push(...s0.relatedVideos);
    if (eps.length >= 2) {
      const seen = new Set();
      const items = [];
      for (const ep of eps) {
        const aid = ep.aid || null;
        const bvid = ep.bvid || (ep.arc && ep.arc.bvid);
        const key = String(aid || bvid || '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const arc = ep.arc || ep;
        items.push({
          url: 'https://www.bilibili.com/video/' + (bvid || ('BV' + key)),
          title: (arc.title || ep.title || 'B站视频'),
          cover: (arc.pic || ep.cover || ''),
          awemeId: key,
          source: 'bilibili-batch',
        });
      }
      if (items.length >= 2) {
        items.forEach((it, k) => { it.__biliMulti = true; it.__index = k; });
        return { __biliMulti: true, items };
      }
    }
  } catch (_) {}
  return null;
}

// 构造 B站合集页 __INITIAL_STATE__
function makeBiliSeason() {
  return {
    ugcSeason: {
      sections: [
        { episodes: [
          { aid: 1001, bvid: 'BV1aa', arc: { title: '合集第1集', pic: 'https://i0.hdslb.com/cover/1001.jpg' } },
          { aid: 1002, bvid: 'BV1bb', arc: { title: '合集第2集', pic: 'https://i0.hdslb.com/cover/1002.jpg' } },
          { aid: 1003, bvid: 'BV1cc', arc: { title: '合集第3集', pic: 'https://i0.hdslb.com/cover/1003.jpg' } },
        ] },
        { episodes: [
          { aid: 1004, bvid: 'BV1dd', arc: { title: '合集第4集', pic: 'https://i0.hdslb.com/cover/1004.jpg' } },
        ] },
      ],
    },
  };
}

// 构造单视频页（relatedVideos 推荐列表）
function makeBiliRelated() {
  return {
    relatedVideos: [
      { aid: 2001, bvid: 'BV2aa', arc: { title: '推荐1', pic: 'https://i0.hdslb.com/cover/2001.jpg' } },
      { aid: 2002, bvid: 'BV2bb', arc: { title: '推荐2', pic: 'https://i0.hdslb.com/cover/2002.jpg' } },
      { aid: 2003, bvid: 'BV2cc', arc: { title: '推荐3', pic: 'https://i0.hdslb.com/cover/2003.jpg' } },
    ],
  };
}

let pass = 0, fail = 0;
function check(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); fail++; } }

console.log('Phase 4：B站合集/列表批量采集');

// 1) 合集页批量模式 → 产出 4 条（跨 sections 合并），__biliMulti 标记
check('合集页批量模式产出 4 条（跨 sections 合并），__biliMulti 标记', () => {
  const r = grabBiliMulti(makeBiliSeason(), true);
  assert.strictEqual(r.__biliMulti, true);
  assert.strictEqual(r.items.length, 4);
});

// 2) 单视频页 relatedVideos → 产出 3 条
check('单视频页 relatedVideos 批量模式产出 3 条', () => {
  const r = grabBiliMulti(makeBiliRelated(), true);
  assert.strictEqual(r.__biliMulti, true);
  assert.strictEqual(r.items.length, 3);
});

// 3) 非批量模式（默认）→ 不产出多视频（走单视频路径）
check('非批量模式 → 返回 null（不干扰单视频）', () => {
  const r = grabBiliMulti(makeBiliSeason(), false);
  assert.strictEqual(r, null);
});

// 4) 封面/标题/awemeId 透传（一致性）
check('封面/标题/awemeId 各自透传（无串号）', () => {
  const r = grabBiliMulti(makeBiliSeason(), true);
  assert.strictEqual(r.items[0].cover, 'https://i0.hdslb.com/cover/1001.jpg');
  assert.strictEqual(r.items[0].title, '合集第1集');
  assert.strictEqual(r.items[0].awemeId, '1001');
  assert.strictEqual(r.items[3].cover, 'https://i0.hdslb.com/cover/1004.jpg');
});

// 5) ID 唯一（无重复）
check('awemeId 全局唯一', () => {
  const r = grabBiliMulti(makeBiliSeason(), true);
  const ids = r.items.map(i => i.awemeId);
  assert.strictEqual(new Set(ids).size, ids.length);
});

// 6) url 各自独立（无共用直链）
check('url 两两不同（无串号）', () => {
  const r = grabBiliMulti(makeBiliSeason(), true);
  const urls = r.items.map(i => i.url);
  for (let i = 0; i < urls.length; i++)
    for (let j = i + 1; j < urls.length; j++)
      assert.notStrictEqual(urls[i], urls[j]);
});

// 7) 不足 2 条不触发多视频（单集合集）
check('合集仅 1 集 → 不触发多视频', () => {
  const s0 = { ugcSeason: { sections: [{ episodes: [{ aid: 1, bvid: 'BVx', arc: { title: 'a', pic: 'p' } }] }] } };
  const r = grabBiliMulti(s0, true);
  assert.strictEqual(r, null);
});

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
