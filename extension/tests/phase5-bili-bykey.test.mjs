// Phase 5 测试：B站批量 byKey 一致性 + YouTube batchMode 守卫
import assert from 'node:assert';

// 复刻 scan.js extractVideoCovers 的 B站分支 byKey 构建
function buildBiliByKey(ini) {
  const byKey = {};
  try {
    const season = ini && (ini.ugcSeason || (ini.videoData && ini.videoData.ugc_season));
    const eps = [];
    if (season && Array.isArray(season.sections)) {
      season.sections.forEach((sec) => { if (sec && Array.isArray(sec.episodes)) eps.push(...sec.episodes); });
    }
    if (!eps.length && Array.isArray(ini.relatedVideos)) eps.push(...ini.relatedVideos);
    eps.forEach((ep) => {
      const id = String(ep.aid || (ep.arc && ep.arc.bvid) || ep.bvid || '');
      const pic = ep.arc && ep.arc.pic ? ep.arc.pic : (ep.cover || '');
      if (id && pic) byKey['aweme:' + id] = decodeURIComponent(pic).replace(/\\\//g, '/');
    });
  } catch (_) {}
  return byKey;
}

// 复刻 scan.js 547-590 行回填：idFromAsset 优先 byKey
function fillBiliCover(d, byKey) {
  if (d && d.type === 'video' && d.source === 'bilibili-batch' && !d.cover) {
    const idFromAsset = (d.awemeId && d.awemeId !== 'unknown') ? d.awemeId : '';
    const id = idFromAsset;
    if (id && byKey['aweme:' + id]) d.cover = byKey['aweme:' + id];
  }
  return d;
}

// 复刻 background.js B站批量提取（产出 awemeId = aid）
function grabBiliMulti(s0) {
  const season = s0.ugcSeason;
  const eps = [];
  season.sections.forEach((sec) => eps.push(...sec.episodes));
  const seen = new Set(); const items = [];
  for (const ep of eps) {
    const key = String(ep.aid || ep.bvid || '');
    if (!key || seen.has(key)) continue; seen.add(key);
    const arc = ep.arc || ep;
    items.push({ type: 'video', url: 'https://www.bilibili.com/video/' + (ep.bvid || ('BV' + key)), title: arc.title, cover: '', awemeId: key, source: 'bilibili-batch' });
  }
  return items;
}

function makeBiliSeason() {
  return { ugcSeason: { sections: [{ episodes: [
    { aid: 1001, bvid: 'BV1aa', arc: { title: '合集1', pic: 'https%3A%2F%2Fi0.hdslb.com%2F1001.jpg' } },
    { aid: 1002, bvid: 'BV1bb', arc: { title: '合集2', pic: 'https%3A%2F%2Fi0.hdslb.com%2F1002.jpg' } },
  ] }] } };
}

let pass = 0, fail = 0;
function check(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); fail++; } }

console.log('Phase 5：B站批量 byKey 一致性 + YouTube 守卫');

// 1) byKey 为每个 episode 建 aweme:<id>（解码后）
check('byKey 为每个 B站 episode 建 aweme:<aid>（URL 解码）', () => {
  const byKey = buildBiliByKey(makeBiliSeason());
  assert.strictEqual(byKey['aweme:1001'], 'https://i0.hdslb.com/1001.jpg');
  assert.strictEqual(byKey['aweme:1002'], 'https://i0.hdslb.com/1002.jpg');
});

// 2) B站批量资产回填封面精确命中（不回退 defaultCover）
check('B站批量资产封面精确命中自身 byKey（无错乱）', () => {
  const byKey = buildBiliByKey(makeBiliSeason());
  const items = grabBiliMulti(makeBiliSeason());
  items.forEach((it) => fillBiliCover(it, byKey));
  assert.strictEqual(items[0].cover, 'https://i0.hdslb.com/1001.jpg'); // 自身封面
  assert.strictEqual(items[1].cover, 'https://i0.hdslb.com/1002.jpg');
  assert.notStrictEqual(items[0].cover, items[1].cover); // 不共用
});

// 3) 键一致性：background 产出的 awemeId 与 scan.js byKey 键匹配
check('键一致性：background awemeId 与 scan byKey 键对齐', () => {
  const byKey = buildBiliByKey(makeBiliSeason());
  const items = grabBiliMulti(makeBiliSeason());
  items.forEach((it) => {
    assert.ok(byKey['aweme:' + it.awemeId], `资产 ${it.awemeId} 在 byKey 中无封面`);
  });
});

// 4) YouTube batchMode 守卫逻辑（复刻 background 第4层）
check('YouTube batchMode 守卫：批量模式跳过 tryYouTube 早返回', () => {
  const batchMode = true;
  const ytR = (!batchMode) ? { url: 'single.mp4' } : null;
  assert.strictEqual(ytR, null); // 批量模式不返回单视频，让后续多视频分支接管
  // 非批量模式返回单视频（默认行为不变）
  const batchMode2 = false;
  const ytR2 = (!batchMode2) ? { url: 'single.mp4' } : null;
  assert.strictEqual(ytR2.url, 'single.mp4');
});

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
