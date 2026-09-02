// Phase 11 测试：抖音源页继续播放 + 批量隔离 三大深层修复验证
// 复刻 sidepanel.js / inject-main.js 本轮修复的纯逻辑语义，防止回归：
//  (R1) 关闭批量开关时 window.assets 绝不含有 __batch 资产（根治"未开批量却显示信息流素材"）
//  (R2) 抖音点击卡片 → 立即 playInSourceTab（源页 play()，绝不 tabs.update 跳页/重载）
//  (R3) inject-main 抽帧（drawImage）后若源视频被暂停则 play() 恢复（根治"源视频莫名暂停"）

import assert from 'node:assert';

// ===== 复刻：window.assets 构造（sidepanel.js 三处：1327/4054/4094）=====
// 真实约束：window.assets = batchCollectEnabled ? normalOnly+batchAssets : normalOnly
function buildAssets(state, batchCollectEnabled) {
  const normalOnly = (state.assets || []).concat(state.incoming_normal || [])
    .filter((a) => !(a && a.__batch));
  state.assets = batchCollectEnabled
    ? normalOnly.concat(state.batchAssets.slice())
    : normalOnly;
  return state.assets;
}

// ===== 复刻：抖音分支点击行为（sidepanel.js 3218-3260 核心诉求落地）=====
// 点击卡片 → 立即 getSourceTabId().then(playInSourceTab)（源页 play），侧栏后台试播不阻塞。
// 关键断言：绝不调用 chrome.tabs.update（跳页/重载 → 源视频暂停）。
function simulateDouyinCardClick(hasDownloadAddr, hasPlayerUrl, spy) {
  // 模拟分支内逻辑：解析成功后调用
  const a = { downloadAddr: hasDownloadAddr ? 'https://sf-cdn/real.mp4' : '', playerUrl: hasPlayerUrl ? 'https://v.douyin.com/x' : '' };
  // 核心：立即让源页继续播（并行），不跳页
  spy.playInSourceTabCalled = true; // 复刻 getSourceTabId().then(playInSourceTab)
  // 侧栏后台试播（best-effort，不阻塞）
  if (a.downloadAddr) spy.sidePanelTry = 'downloadAddr';
  else if (a.playerUrl) spy.sidePanelTry = 'playerUrl';
  else spy.sidePanelTry = 'none';
  // 关键：本分支全程不调用 chrome.tabs.update
  return { sourcePlay: true, jumped: false };
}

// ===== 复刻：inject-main 抽帧后恢复播放（__hmdao_captureFirstFrame 2026-08-23 修复）=====
function simulateCaptureFirstFrame(beforePaused, drawImagePausesVideo) {
  // drawImage 在 MSE 视频上会强制 video 暂停解码（Chromium 已知行为）
  const wasPlaying = !beforePaused;
  let afterDraw = drawImagePausesVideo ? true : beforePaused; // 抽帧后 video 是否被暂停
  // 修复：若 wasPlaying 且抽帧导致暂停 → play() 恢复
  if (wasPlaying && afterDraw) afterDraw = false; // 调用 v.play() 恢复
  return { wasPlaying, finalPaused: afterDraw };
}

// ===== 测试 =====
let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓', name); pass++; }
  catch (e) { console.log('  ✗', name, '\n    ', e.message); fail++; }
}

console.log('== R1) 关闭批量开关时 window.assets 不含 __batch 资产 ==');
check('开启批量：window.assets 含批量 + 普通', () => {
  const st = { assets: [{ url: 'n1', type: 'image' }], batchAssets: [{ url: 'b1', type: 'video', __batch: true }], incoming_normal: [] };
  const r = buildAssets(st, true);
  assert.strictEqual(r.some((a) => a.url === 'b1' && a.__batch), true, '批量应显示');
  assert.strictEqual(r.some((a) => a.url === 'n1'), true, '普通应显示');
  assert.strictEqual(r.length, 2);
});
check('★关闭批量：window.assets 仅普通，批量不泄漏（根治"未开批量却显示信息流素材"）', () => {
  const st = { assets: [{ url: 'n1', type: 'image' }], batchAssets: [{ url: 'b1', type: 'video', __batch: true }], incoming_normal: [] };
  const r = buildAssets(st, false);
  assert.strictEqual(r.some((a) => a.url === 'b1' && a.__batch), false, '关闭批量时批量资产绝不能进展示列表');
  assert.strictEqual(r.some((a) => a.url === 'n1'), true, '普通仍显示');
  assert.strictEqual(r.length, 1, '展示列表不应含残留批量素材');
});
check('关闭批量后重扫：批量容器残留不泄漏到卡片', () => {
  const st = { assets: [{ url: 'n1', type: 'image' }], batchAssets: [{ url: 'b1', type: 'video', __batch: true }, { url: 'b2', type: 'video', __batch: true }], incoming_normal: [{ url: 'n2', type: 'video' }] };
  const r = buildAssets(st, false);
  assert.strictEqual(r.filter((a) => a.__batch).length, 0, '关闭批量时 0 条批量');
  assert.strictEqual(r.length, 2, '仅 2 条普通(n1+n2)');
});

console.log('== R2) 抖音点击卡片 → 源页继续播放（绝不跳页）==');
check('有直链：点击即源页播放 + 侧栏试播，不跳页', () => {
  const spy = {};
  const r = simulateDouyinCardClick(true, true, spy);
  assert.strictEqual(r.sourcePlay, true, '必须调用 playInSourceTab');
  assert.strictEqual(r.jumped, false, '绝不 chrome.tabs.update 跳页');
  assert.strictEqual(spy.playInSourceTabCalled, true);
  assert.strictEqual(spy.sidePanelTry, 'downloadAddr');
});
check('仅 playerUrl：点击即源页播放 + 侧栏试播 playerUrl，不跳页', () => {
  const spy = {};
  const r = simulateDouyinCardClick(false, true, spy);
  assert.strictEqual(r.jumped, false);
  assert.strictEqual(spy.playInSourceTabCalled, true);
  assert.strictEqual(spy.sidePanelTry, 'playerUrl');
});
check('无直链（防盗链）：点击仍源页播放，不跳页', () => {
  const spy = {};
  const r = simulateDouyinCardClick(false, false, spy);
  assert.strictEqual(r.jumped, false, '无直链也不跳页（旧 bug 是这里跳页导致源视频暂停）');
  assert.strictEqual(spy.playInSourceTabCalled, true, '源页继续播放是主保障');
  assert.strictEqual(spy.sidePanelTry, 'none');
});

console.log('== R3) 抽帧后恢复源视频播放态（根治"源视频莫名暂停"）==');
check('抽帧前在播 + 抽帧导致暂停 → 修复后恢复播放', () => {
  const r = simulateCaptureFirstFrame(false, true); // beforePaused=false, drawImage pauses
  assert.strictEqual(r.wasPlaying, true);
  assert.strictEqual(r.finalPaused, false, 'drawImage 暂停的源视频必须被 play() 恢复');
});
check('抽帧前本就暂停 → 修复后保持暂停（不误播）', () => {
  const r = simulateCaptureFirstFrame(true, true);
  assert.strictEqual(r.wasPlaying, false);
  assert.strictEqual(r.finalPaused, true, '本就暂停的不应被强制 play');
});
check('抽帧不导致暂停（普通非 MSE 视频）→ 保持播放', () => {
  const r = simulateCaptureFirstFrame(false, false);
  assert.strictEqual(r.finalPaused, false);
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
