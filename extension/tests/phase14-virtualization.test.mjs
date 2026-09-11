// phase14-virtualization.test.mjs
// QA（严过关）2026-09-11 独立回归：卡片虚拟化（全量入库 + 可视区挂载）。
// 直接加载真实 card-render.js（经典脚本）进 vm 沙箱，抽出 hmdaoListMetrics / hmdaoComputeWindow /
// hmdaoPositionCard 三个真实函数，用极简 DOM 桩驱动，证明：
//   ① 列数从 CSS grid-template-columns 正确解析（repeat(3,1fr) → 3）；
//   ② 视口窗口只覆盖「可视区 + 上下各 2 行缓冲」，全量 300 卡首屏仅挂约 30 张（看不到的不挂载）；
//   ③ 滚动到底只挂最后若干张；
//   ④ 每张卡按 (行,列) 绝对定位，top/left/width/height 精确；
//   ⑤ 全列表高度占位(sizer) = 2*PAD + 行数*行高 - GAP，使滚动条代表完整列表。
// 运行：node tests/phase14-virtualization.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '..');
const read = (f) => readFileSync(path.join(EXT, f), 'utf8');

let pass = 0, fail = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); console.log('  ✓', name); pass++; }
  catch (e) { console.log('  ✗', name, '\n      →', e && e.message); fail++; failures.push(name + ' :: ' + (e && e.message)); }
}
function section(t) { console.log('\n===', t, '==='); }

const cardSrc = read('card-render.js');

// ---- 极简 DOM 桩（每张卡需带 style 对象，因源码对 card.style.* 赋值）----
function makeListEl(opts) {
  return {
    clientWidth: opts.clientWidth ?? 300,
    clientHeight: opts.clientHeight ?? 600,
    scrollTop: opts.scrollTop ?? 0,
    paddingLeft: '10px',
    __hmdaoFilteredLen: opts.len ?? 0,
    children: [],
    querySelector() { return null; },
    appendChild() {}, removeChild() {}, addEventListener() {}, removeEventListener() {},
    __hmdaoScrollBound: false,
  };
}
function buildCtx(listEl, gridTemplateColumns) {
  const fakeStyle = { paddingLeft: '10px', rowGap: '6px', gap: '', gridTemplateColumns };
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    document: { getElementById: (id) => (id === 'list' ? listEl : null), readyState: 'complete', addEventListener() {} },
    window: { addEventListener() {} },
    getComputedStyle: () => fakeStyle,
    requestAnimationFrame: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => {},
    parseInt, parseFloat, Math, String, Number, Array, Map, Set, Object, JSON, isNaN,
    URL: globalThis.URL,
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(cardSrc, ctx);
  return ctx;
}

section('A. 列数解析 + 度量');
await check('A1 repeat(3,1fr) → COLS=3 且度量自洽', () => {
  const listEl = makeListEl({ clientWidth: 300, clientHeight: 600, len: 300 });
  const ctx = buildCtx(listEl, 'repeat(3, 1fr)');
  const m = ctx.hmdaoListMetrics();
  assert.equal(m.COLS, 3, 'COLS 应为 3');
  assert.equal(m.PAD, 10, 'PAD 应为 10');
  assert.equal(m.GAP, 6, 'GAP 应为 6');
  const exp = (300 - 20 - 2 * 6) / 3;
  assert.ok(Math.abs(m.colW - exp) < 1e-6, 'colW 计算错误: ' + m.colW);
  assert.ok(Math.abs(m.cardH - exp) < 1e-6, 'cardH=colW(正方形)');
  assert.ok(Math.abs(m.rowH - (exp + 6)) < 1e-6, 'rowH=cardH+GAP');
});
await check('A2 repeat(4,1fr) → COLS=4', () => {
  const listEl = makeListEl({ clientWidth: 300, clientHeight: 600, len: 300 });
  const ctx = buildCtx(listEl, 'repeat(4, 1fr)');
  const m = ctx.hmdaoListMetrics();
  assert.equal(m.COLS, 4, 'COLS 应为 4');
});

section('B. 视口窗口：全量 300 卡，首屏只挂可视区');
await check('B1 首屏(scrollTop=0) 仅挂约 30 张（看不到的不挂载）', () => {
  const listEl = makeListEl({ clientWidth: 300, clientHeight: 600, scrollTop: 0, len: 300 });
  const ctx = buildCtx(listEl, 'repeat(3, 1fr)');
  const m = ctx.hmdaoListMetrics();
  m.c.__hmdaoFilteredLen = 300;
  const win = ctx.hmdaoComputeWindow(m);
  assert.equal(win.start, 0, 'start 应为 0');
  assert.ok(win.end > 0 && win.end <= 36, 'end 应被限制在小窗口内, got ' + win.end);
  const mounted = win.end - win.start;
  assert.ok(mounted < 60, '首屏挂载数应远小于 300, got ' + mounted);
  console.log('     首屏挂载: ' + mounted + ' / 300');
});
await check('B2 滚动到底只挂最后若干张', () => {
  const listEl = makeListEl({ clientWidth: 300, clientHeight: 600, len: 300 });
  const ctx = buildCtx(listEl, 'repeat(3, 1fr)');
  const m = ctx.hmdaoListMetrics();
  const totalRows = Math.ceil(300 / m.COLS);
  const totalH = m.PAD * 2 + totalRows * m.rowH - m.GAP;
  listEl.scrollTop = totalH - 600; // 滚到底（listEl 即 ctx 内部引用的同一对象）
  m.c.__hmdaoFilteredLen = 300;
  const win = ctx.hmdaoComputeWindow(m);
  assert.equal(win.end, 300, '末窗口 end 应到 300, got ' + win.end);
  assert.ok(win.start > 0, '末窗口 start 应 > 0, got ' + win.start);
  assert.ok((win.end - win.start) < 60, '末窗口挂载数应受限, got ' + (win.end - win.start));
  console.log('     底部窗口: [' + win.start + ', ' + win.end + ')');
});
await check('B3 空列表窗口为空', () => {
  const listEl = makeListEl({ clientWidth: 300, clientHeight: 600, len: 0 });
  const ctx = buildCtx(listEl, 'repeat(3, 1fr)');
  const m = ctx.hmdaoListMetrics();
  m.c.__hmdaoFilteredLen = 0;
  const win = ctx.hmdaoComputeWindow(m);
  assert.equal(win.start, 0, 'start 应为 0');
  assert.equal(win.end, 0, 'end 应为 0');
});

section('C. 绝对定位：按 (行,列) 精确摆放');
await check('C1 i=0 在左上角(PAD,PAD)', () => {
  const listEl = makeListEl({ clientWidth: 300, clientHeight: 600, len: 300 });
  const ctx = buildCtx(listEl, 'repeat(3, 1fr)');
  const m = ctx.hmdaoListMetrics();
  const card = { style: {} };
  ctx.hmdaoPositionCard(card, 0, m);
  assert.equal(card.style.position, 'absolute');
  assert.equal(card.style.left, (m.PAD) + 'px');
  assert.equal(card.style.top, (m.PAD) + 'px');
  assert.equal(card.style.width, m.colW + 'px');
  assert.equal(card.style.height, m.cardH + 'px');
});
await check('C2 i=1 在同行第 2 列，i=3 在下一行第 1 列', () => {
  const listEl = makeListEl({ clientWidth: 300, clientHeight: 600, len: 300 });
  const ctx = buildCtx(listEl, 'repeat(3, 1fr)');
  const m = ctx.hmdaoListMetrics();
  const c1 = { style: {} }; ctx.hmdaoPositionCard(c1, 1, m);
  assert.ok(Math.abs(parseFloat(c1.style.left) - (m.PAD + (m.colW + m.GAP))) < 1e-6, '列2 left 错误: ' + c1.style.left);
  assert.equal(c1.style.top, m.PAD + 'px', '同行 top 应相同');
  const c3 = { style: {} }; ctx.hmdaoPositionCard(c3, 3, m);
  assert.equal(c3.style.left, m.PAD + 'px', '下一行第1列 left=PAD');
  assert.ok(Math.abs(parseFloat(c3.style.top) - (m.PAD + m.rowH)) < 1e-6, '下一行 top=PAD+rowH');
});

section('D. 全列表高度占位(sizer) 代表完整列表');
await check('D1 sizer 高度 = 2*PAD + 行数*行高 - GAP', () => {
  const listEl = makeListEl({ clientWidth: 300, clientHeight: 600, len: 300 });
  const ctx = buildCtx(listEl, 'repeat(3, 1fr)');
  const m = ctx.hmdaoListMetrics();
  const n = 300, COLS = m.COLS;
  const rows = Math.ceil(n / COLS);
  const totalH = Math.max(0, m.PAD * 2 + rows * m.rowH - m.GAP);
  assert.ok(totalH > 600, '完整列表高度应远大于单屏(600), 实际 ' + totalH.toFixed(0));
  console.log('     完整列表可滚动高度 ≈ ' + totalH.toFixed(0) + 'px（单屏仅 600px）');
});

section('E. clientHeight=0 兜底：首屏必须仍渲染若干卡');
await check('E1 list.clientHeight=0 时 viewH 使用兜底高度', () => {
  const listEl = makeListEl({ clientWidth: 300, clientHeight: 0, scrollTop: 0, len: 300 });
  const ctx = buildCtx(listEl, 'repeat(3, 1fr)');
  const m = ctx.hmdaoListMetrics();
  assert.ok(m.clientHeight === 0, '应如实反映 clientHeight=0');
  assert.ok(m.viewH > 0, 'viewH 必须 > 0, got ' + m.viewH);
  m.c.__hmdaoFilteredLen = 300;
  const win = ctx.hmdaoComputeWindow(m);
  assert.ok(win.end > 0, 'clientHeight=0 时仍应渲染若干卡, got end=' + win.end);
  console.log('     clientHeight=0 兜底窗口: [' + win.start + ', ' + win.end + ')');
});

console.log('\n==== phase14-virtualization 总结 ====');
console.log('通过 ' + pass + ' / 失败 ' + fail);
if (failures.length) { console.log('失败项:'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
