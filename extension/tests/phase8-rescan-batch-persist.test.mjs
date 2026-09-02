// Phase 8 测试：抖音源页播放功能底层修复验证
// 复刻 sidepanel.js / scan.js 本轮修复的纯逻辑语义，验证四大断裂已闭环：
//  A) SCAN_RESULT 必须回填 window.assets（不再只写 __hmdaoAssets 计数）
//  B) 侧栏初始化从 lastScan 持久化回填（刷新/重开不丢）
//  C) scanTab 仅在 URL 真正变化时清空源页累积（刷新/切tab回原页不丢 dyUrls）
//  D) doRescan 增量合并 + 换页重置；批量资产独立容器(batchAssets)重扫不清空
//  E) 批量扫描产出的视频归 batchAssets，图片/音频/文档/模型归普通资产（不进批量）

import assert from 'node:assert';

// ===== 复刻：SCAN_RESULT 分流 + window.assets 合并展示约定 =====
// 真实约束：window.assets 始终 = 普通(去__batch) + 批量副本；render 读 window.assets。
function applyScanResult(state, msg) {
  const { batchAssets } = state;
  if (!Array.isArray(state.assets)) state.assets = [];
  const scanBatchMode = !!msg.batchMode;
  const incoming = msg.assets || [];
  const incoming_normal = [];
  for (const a of incoming) {
    if (!a) continue;
    const isBatchItem = a.__batch || (scanBatchMode && a.type === 'video');
    if (isBatchItem) {
      if (!batchAssets.some((x) => x.url === a.url)) batchAssets.push(Object.assign({}, a, { __batch: true }));
    } else {
      if (!incoming_normal.some((x) => x.url === a.url)) incoming_normal.push(a);
    }
  }
  const existingNormal = (state.assets || []).filter((a) => !(a && a.__batch));
  const normalMerged = existingNormal.concat(incoming_normal.filter((a) => !existingNormal.some((x) => x.url === a.url)));
  const batchMerged = batchAssets.concat(
    (state.assets || []).filter((a) => a && a.__batch).filter((a) => !batchAssets.some((b) => b.url === a.url))
  );
  state.assets = normalMerged.concat(batchMerged);
  state.__hmdaoAssets = state.assets.slice();
  return state;
}

// ===== 复刻：doRescan 的换页/同页判定 + 重置/合并 =====
function doRescanMerge(state, activeUrl, downloadingUrls) {
  const urlChanged = !state.currentSourceUrl || (activeUrl && activeUrl !== state.currentSourceUrl);
  if (activeUrl) state.currentSourceUrl = activeUrl;
  const preserved = (downloadingUrls || []).length && Array.isArray(state.assets)
    ? state.assets.filter((a) => downloadingUrls.includes(a.url))
    : [];
  if (urlChanged) {
    // 换页：保留「正在下载的普通资产」+「全部批量资产」
    const keep = state.batchAssets.concat(preserved.filter((a) => !state.batchAssets.some((b) => b.url === a.url)));
    state.assets = keep.slice();
  } else {
    // 同页：保留现有列表 + 正在下载的（SCAN_RESULT 后续回填）
    const merged = state.assets.concat(preserved.filter((a) => !state.assets.some((x) => x.url === a.url)));
    state.assets = merged;
  }
  state.__hmdaoAssets = state.assets.slice();
  return { urlChanged };
}

// ===== 复刻：scan.js 换页清空源页累积判定 =====
function shouldClearCaptures(prevUrl, targetUrl) {
  return !prevUrl || prevUrl !== (targetUrl || '');
}

// ===== 复刻：lastScan 持久化回填 =====
function loadLastScan(state, ls) {
  if (ls && Array.isArray(ls.assets) && ls.assets.length) {
    if (!Array.isArray(state.assets)) state.assets = [];
    for (const a of ls.assets) {
      if (a && a.__batch) {
        if (!state.batchAssets.some((x) => x.url === a.url)) state.batchAssets.push(a);
      } else {
        if (!state.assets.some((x) => x.url === a.url)) state.assets.push(a);
      }
    }
    if (ls.url) state.currentSourceUrl = ls.url;
    const normalOnly = (state.assets || []).filter((a) => !(a && a.__batch));
    state.assets = normalOnly.concat(state.batchAssets.slice());
    state.__hmdaoAssets = state.assets.slice();
  }
}

// ===== 测试 =====
let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓', name); pass++; }
  catch (e) { console.log('  ✗', name, '\n    ', e.message); fail++; }
}

console.log('== A) SCAN_RESULT 回填 window.assets ==');
check('空列表收到扫描结果→window.assets 被填充', () => {
  const st = { assets: [], batchAssets: [], __hmdaoAssets: [] };
  applyScanResult(st, { assets: [{ url: 'v1', type: 'video' }], batchMode: false });
  assert.strictEqual(st.assets.length, 1);          // 旧 bug：这里会是 0（只写 __hmdaoAssets）
  assert.strictEqual(st.assets[0].url, 'v1');
});

console.log('== D) 批量隔离：批量扫描视频归 batchAssets，重扫不清空 ==');
check('批量扫描模式视频进入 batchAssets 且带 __batch', () => {
  const st = { assets: [], batchAssets: [], __hmdaoAssets: [] };
  applyScanResult(st, { assets: [{ url: 'bv1', type: 'video', awemeId: 'A1' }], batchMode: true });
  assert.strictEqual(st.batchAssets.length, 1);
  assert.strictEqual(st.assets.some((a) => a.url === 'bv1' && a.__batch), true);
});
check('批量模式下图片/音频/文档/模型不进 batch（归普通）', () => {
  const st = { assets: [], batchAssets: [], __hmdaoAssets: [] };
  applyScanResult(st, {
    assets: [
      { url: 'bv1', type: 'video', awemeId: 'A1' },
      { url: 'img1', type: 'image' },
      { url: 'aud1', type: 'audio' },
      { url: 'doc1', type: 'doc' },
      { url: 'mdl1', type: 'model' },
    ], batchMode: true,
  });
  assert.strictEqual(st.batchAssets.length, 1);     // 仅 1 条视频
  assert.strictEqual(st.assets.filter((a) => !a.__batch).length, 4); // 4 条普通
});
check('doRescan 同页重扫不清空批量资产', () => {
  const st = { assets: [], batchAssets: [], currentSourceUrl: 'https://v.douyin.com/abc', __hmdaoAssets: [] };
  applyScanResult(st, { assets: [{ url: 'bv1', type: 'video', awemeId: 'A1' }], batchMode: true });
  // 同页再次扫描
  doRescanMerge(st, 'https://v.douyin.com/abc', []);
  assert.strictEqual(st.assets.some((a) => a.url === 'bv1' && a.__batch), true, '批量资产仍在');
});
check('doRescan 换页只清普通、保留批量', () => {
  const st = { assets: [], batchAssets: [], currentSourceUrl: 'https://v.douyin.com/abc', __hmdaoAssets: [] };
  applyScanResult(st, { assets: [{ url: 'bv1', type: 'video', awemeId: 'A1' }, { url: 'img1', type: 'image' }], batchMode: true });
  assert.strictEqual(st.assets.length, 2);
  // 切到新 URL
  const r = doRescanMerge(st, 'https://v.douyin.com/xyz', []);
  assert.strictEqual(r.urlChanged, true);
  assert.strictEqual(st.assets.some((a) => a.url === 'bv1' && a.__batch), true, '批量保留');
  assert.strictEqual(st.assets.some((a) => a.url === 'img1'), false, '普通被重置');
});

console.log('== C) scanTab 仅在 URL 真正变化时清空源页累积 ==');
check('同页重扫不清空 dyUrls（保留累积）', () => {
  assert.strictEqual(shouldClearCaptures('https://v.douyin.com/abc', 'https://v.douyin.com/abc'), false);
});
check('换页才清空 dyUrls', () => {
  assert.strictEqual(shouldClearCaptures('https://v.douyin.com/abc', 'https://v.douyin.com/xyz'), true);
  assert.strictEqual(shouldClearCaptures('', 'https://v.douyin.com/abc'), true);
});

console.log('== B) lastScan 持久化回填（刷新/重开不丢）==');
check('初始化从 lastScan 恢复普通+批量并填 URL', () => {
  const st = { assets: [], batchAssets: [], currentSourceUrl: '', __hmdaoAssets: [] };
  loadLastScan(st, {
    url: 'https://v.douyin.com/abc',
    assets: [{ url: 'bv1', type: 'video', __batch: true }, { url: 'img1', type: 'image' }],
    ts: Date.now(),
  });
  assert.strictEqual(st.currentSourceUrl, 'https://v.douyin.com/abc');
  assert.strictEqual(st.batchAssets.length, 1);
  assert.strictEqual(st.assets.filter((a) => !a.__batch).length, 1); // 普通(img1)
  assert.strictEqual(st.assets.some((a) => a.url === 'bv1' && a.__batch), true); // 批量显示
});

console.log('== 增量去重 ==');
check('同 url 重复扫描不重复添加', () => {
  const st = { assets: [], batchAssets: [], __hmdaoAssets: [] };
  applyScanResult(st, { assets: [{ url: 'v1', type: 'video' }], batchMode: false });
  applyScanResult(st, { assets: [{ url: 'v1', type: 'video' }], batchMode: false });
  assert.strictEqual(st.assets.length, 1);
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
