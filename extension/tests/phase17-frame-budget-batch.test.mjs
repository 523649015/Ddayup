// phase17-frame-budget-batch.test.mjs
// QA 回归（抽帧全局预算：分批懒加载 + 自动续批 + 失败集防死循环 + 自动停止）2026-09-12
// 验证「一次性硬上限」已改为「分批 + 自动续批」模型：
//   C1 预算耗尽后若视口内仍有「缺封面且未抽过且未永久失败」的视频卡 → 自动续批（抽帧调用次数 > 12）。
//   C2 抽帧失败的资产进入失败集后不再重试（同一资产最多抽 1 次）。
//   C3 所有卡都拿到封面或都进失败集后 pump 自动停止（无无限循环、测试在硬超时前结束）。
//   C4 并发护栏保留：window.__hmdao_coverFrameActive 始终 ≤ 2。
// 运行：node tests/phase17-frame-budget-batch.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '..');
const read = (f) => readFileSync(path.join(EXT, f), 'utf8');

setTimeout(() => { console.error('\n!! HARD TIMEOUT (20s) — 疑似抽帧 pump 死循环'); process.exit(3); }, 20000).unref();

let pass = 0, fail = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); console.log('  ✓', name); pass++; }
  catch (e) { console.log('  ✗', name, '\n      →', e && e.message); fail++; failures.push(name + ' :: ' + (e && e.message)); }
}
function section(t) { console.log('\n===', t, '==='); }

// 2MB 假视频字节（base64），供 HMDAO_FETCH_MEDIA 桩返回
const FAKE_B64 = Buffer.from(new Uint8Array(2 * 1024 * 1024).fill(7)).toString('base64');

let blobN = 0;
let maxObserved = 0; // 观测到的最大并发（window.__hmdao_coverFrameActive）

function makeFakeVideo() {
  const handlers = {};
  const el = {
    muted: false, preload: '', crossOrigin: '',
    videoWidth: 480, videoHeight: 270, currentTime: 0, duration: 1, width: 0, height: 0,
    addEventListener(type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
    removeAttribute() {}, pause() {},
    load() {
      // 记录当前并发（核心已在 load 前 HMDAO_FRAME_ACTIVE++ / __hmdao_coverFrameActive++）
      try { maxObserved = Math.max(maxObserved, (__sandbox.__hmdao_coverFrameActive | 0)); } catch (_) {}
      const fire = (t) => (handlers[t] || []).forEach((fn) => { try { fn({}); } catch (_) {} });
      // 模拟：元数据就绪(loadeddata) → 跳帧(seeked) → 抽首帧 → toBlob
      setTimeout(() => { fire('loadeddata'); setTimeout(() => fire('seeked'), 0); }, 0);
    },
    set src(v) { this._src = v; }, get src() { return this._src; },
  };
  return el;
}
function makeFakeCanvas() {
  return {
    width: 0, height: 0,
    getContext() { return { drawImage() {} }; },
    toBlob(cb) { cb({ __fakePng: true }); }, // 直接产出真值 → 核心 ok(burl) 成功分支
  };
}
function makeFakeGeneric() {
  const el = {
    style: { setProperty() {}, getPropertyValue() { return ''; } },
    dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {},
    setAttribute() {}, getAttribute() { return null; }, remove() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    textContent: '', innerHTML: '',
  };
  return el;
}
function fakeCreateElement(tag) {
  if (tag === 'video') return makeFakeVideo();
  if (tag === 'canvas') return makeFakeCanvas();
  return makeFakeGeneric();
}

function buildSandbox(chromeStub) {
  const listEl = {
    __hmdaoScrollBound: false,
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    appendChild() {}, removeChild() {},
    clientWidth: 300, clientHeight: 600, scrollTop: 0, paddingLeft: '10px',
    style: { setProperty() {}, getPropertyValue() { return ''; } },
    children: [],
  };
  const documentStub = {
    readyState: 'complete',
    addEventListener() {}, removeEventListener() {},
    body: { addEventListener() {}, appendChild() {}, style: {} },
    getElementById(id) { return id === 'list' ? listEl : null; },
    createElement: fakeCreateElement,
    querySelector() { return null; }, querySelectorAll() { return []; },
  };
  const sandbox = {
    console,
    setTimeout, clearTimeout, setImmediate, queueMicrotask,
    URL: { createObjectURL: () => 'blob:fake/' + (++blobN), revokeObjectURL() {} },
    Blob: function Blob(parts, opts) { this.parts = parts; this.type = (opts && opts.type) || ''; },
    atob: (s) => Buffer.from(String(s || ''), 'base64').toString('binary'),
    btoa: (s) => Buffer.from(String(s || ''), 'binary').toString('base64'),
    Math, JSON, Date, Promise, Map, Set, Array, Object, String, Number, Boolean,
    parseInt, parseFloat, isNaN, isFinite, Error, TypeError, Symbol,
    getComputedStyle: () => ({ paddingLeft: '10px', gap: '6px', rowGap: '6px', gridTemplateColumns: 'repeat(3, 1fr)' }),
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    innerHeight: 600,
    document: documentStub,
    chrome: chromeStub,
    addEventListener() {}, removeEventListener() {},
  };
  sandbox.window = sandbox; // window === 全局，保证 window.__hmdao_coverFrameActive 与裸引用一致
  return sandbox;
}

// 加载真实 card-render.js（经典脚本）进 vm 沙箱，并把调度器内部状态导出到全局，供测试断言
function loadCardRender(chromeStub) {
  const sandbox = buildSandbox(chromeStub);
  const exportTail = `
;var __HMDAO_FRAME_EXPORT = {
  hmdaoEnqueueFrameExtract: hmdaoEnqueueFrameExtract,
  hmdaoFramePump: hmdaoFramePump,
  hmdaoRunFrameExtract: hmdaoRunFrameExtract,
  hmdaoFrameKey: hmdaoFrameKey,
  get failed() { return HMDAO_FRAME_FAILED; },
  get queue() { return HMDAO_FRAME_QUEUE; },
  get budget() { return HMDAO_FRAME_BUDGET; },
  set budget(v) { HMDAO_FRAME_BUDGET = v; },
  get active() { return HMDAO_FRAME_ACTIVE; },
  get batch() { return HMDAO_FRAME_BATCH; }
};
// 测试桩：视口判定恒为真（视为所有卡都在可视区）
coverVisibleNow = function () { return true; };
`;
  const ctx = vm.createContext(sandbox);
  // 让 fake video 能观测到 vm 内的并发计数
  __sandbox = sandbox;
  vm.runInContext(read('card-render.js') + exportTail, ctx);
  return { ctx, sandbox, api: ctx.__HMDAO_FRAME_EXPORT };
}
let __sandbox = null;

// ================================================================
section('C. 抽帧预算：分批懒加载 + 自动续批 + 失败集防死循环 + 自动停止');
{
  const N = 30;
  const broken = new Set([
    'https://v.test/video5.mp4',
    'https://v.test/video15.mp4',
    'https://v.test/video25.mp4',
  ]);
  let fetchMediaCalls = 0;
  const callsByUrl = new Map();
  let successCount = 0;
  const chromeStub = {
    runtime: {
      sendMessage: (msg, cb) => {
        if (msg && msg.type === 'HMDAO_FETCH_MEDIA') {
          fetchMediaCalls++;
          callsByUrl.set(msg.url, (callsByUrl.get(msg.url) || 0) + 1);
          if (broken.has(msg.url)) cb({ ok: false, status: 0 });        // 永远抽帧失败
          else cb({ ok: true, b64: FAKE_B64, mime: 'video/mp4' });      // 2MB 假视频字节
        } else { cb({ ok: false }); }
      },
      lastError: null,
      onMessage: { addListener() {} },
      onInstalled: { addListener() {} },
    },
  };

  const { api } = loadCardRender(chromeStub);

  await check('C1 预算耗尽后若仍有缺失卡会自动续批（抽帧调用次数 = ' + N + ' > 12）', async () => {
    const assets = [];
    for (let i = 0; i < N; i++) {
      assets.push({ type: 'video', url: 'https://v.test/video' + i + '.mp4', cover: '' });
    }
    for (const a of assets) {
      const card = { dataset: {}, __frameQueued: false };
      api.hmdaoEnqueueFrameExtract(card, a, (burl) => { if (burl) successCount++; });
    }
    // 等待异步结算（视频事件走 setTimeout(0) 链）
    await new Promise((r) => setTimeout(r, 800));
    assert.ok(fetchMediaCalls > 12, '抽帧调用次数应超过一次性硬上限 12，实际=' + fetchMediaCalls);
    assert.equal(fetchMediaCalls, N, '应恰好抽帧 ' + N + ' 次（无重复、无死循环），实际=' + fetchMediaCalls);
  });

  await check('C2 抽帧失败的资产进入失败集后不再重试（同一资产最多抽 1 次）', async () => {
    for (const u of broken) {
      assert.equal(callsByUrl.get(u) || 0, 1, '失败资产 ' + u + ' 应只抽 1 次，实际=' + (callsByUrl.get(u) || 0));
      assert.ok(api.failed.has(u), '失败资产 ' + u + ' 应进入 HMDAO_FRAME_FAILED');
    }
    assert.equal(api.failed.size, broken.size, '失败集大小应=' + broken.size + '，实际=' + api.failed.size);
  });

  await check('C3 所有卡结算后 pump 自动停止（队列空 + 在途为 0 + 无无限循环）', async () => {
    assert.equal(api.queue.length, 0, '队列应已排空，实际=' + api.queue.length);
    assert.equal(api.active, 0, '在途抽帧数应为 0，实际=' + api.active);
    assert.equal(successCount, N - broken.size, '成功封面数应=' + (N - broken.size) + '，实际=' + successCount);
    // 末轮预算 = 12 - (N mod 12) = 6
    assert.equal(api.budget, 6, '末轮剩余预算应=6，实际=' + api.budget);
  });

  await check('C4 并发护栏保留：window.__hmdao_coverFrameActive 始终 ≤ 2', async () => {
    assert.ok(maxObserved <= 2, '观测到的最大并发应 ≤ 2，实际=' + maxObserved);
    assert.ok(__sandbox.__hmdao_coverFrameActive <= 2, '结束时并发计数应 ≤ 2，实际=' + __sandbox.__hmdao_coverFrameActive);
  });
}

console.log('\n==== phase17-frame-budget-batch 总结 ====');
console.log('通过 ' + pass + ' / 失败 ' + fail);
if (failures.length) { console.log('失败项：\n - ' + failures.join('\n - ')); process.exit(1); }
console.log('✅ 全部通过');
process.exit(0); // 源码可能留有 10s 超时定时器，强制退出避免 20s 硬超时
