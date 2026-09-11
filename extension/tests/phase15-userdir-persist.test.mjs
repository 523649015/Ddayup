// phase15-userdir-persist.test.mjs
// QA 回归（用户目录持久化 + 下载命中）2026-09-12
// 验证「按类型自定义保存路径」两处根因已修复：
//   ① 点击 .pathPick 选定目录后，对应 .pathText 必须从「未设置」变为目录名（不再卡在「未设置」）；
//   ② 下载入口（trySaveToUserDir / userDirHandleFor）能正确从【全局 saveHandles】拿到用户目录句柄并写入。
// 做法：把真实的 sidepanel.js（全局 saveHandles / setStatus / deriveMediaReferer）、
//       assetTypes.js（typeLabel / typeDirs）、bulk-actions.js（.pathPick 绑定 + 恢复）、
//       download.js（trySaveToUserDir / userDirHandleFor）整体加载进同一个 vm 上下文，
//       用最小 DOM / chrome / indexedDB 桩模拟侧栏运行，再驱动交互与下载路径。
// 运行：node tests/phase15-userdir-persist.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '..');
const read = (f) => readFileSync(path.join(EXT, f), 'utf8');

// 硬超时护栏：任何 await 卡死都在 20s 后暴露，避免整轮测试 hang 住
setTimeout(() => { console.error('\n!! HARD TIMEOUT (20s) — 疑似 await 卡死'); process.exit(3); }, 20000).unref();

let pass = 0, fail = 0;
const failures = [];
function withTimeout(p, ms, label) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('超时(>' + ms + 'ms): ' + label)), ms))]);
}
async function check(name, fn) {
  try { await fn(); console.log('  ✓', name); pass++; }
  catch (e) { console.log('  ✗', name, '\n      →', e && e.message); fail++; failures.push(name + ' :: ' + (e && e.message)); }
}
function section(t) { console.log('\n===', t, '==='); }

// ---------------------------------------------------------------- 最小桩
// 浏览器里 window 即全局对象；在 vm 里让 sandbox.window = sandbox，使 window.x 与裸 x 指向同一引用，
// 精确复现「var saveHandles 在 window 上、跨 <script> 共享」的真实语义。
function fakeEl() {
  return {
    dataset: {}, style: {}, disabled: false,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {},
    setAttribute() {}, getAttribute() { return null; }, remove() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    _tc: '',
    set onclick(f) { this._onclick = f; }, get onclick() { return this._onclick; },
    set textContent(v) { this._tc = v; }, get textContent() { return this._tc; },
    set innerHTML(v) {}, get innerHTML() { return ''; },
  };
}

function makeFakeIDB() {
  const store = new Map();
  const fire = (req, kind, arg) => setImmediate(() => {
    try { if (kind === 'success') req.onsuccess && req.onsuccess({ target: { result: arg } });
          else req.onerror && req.onerror({ target: { error: arg } }); } catch (_) {}
  });
  return {
    open() {
      const req = {
        onsuccess: null, onerror: null, onupgradeneeded: null,
        result: {
          objectStoreNames: { contains: () => true },
          createObjectStore() {},
          transaction() {
            const tx = { oncomplete: null, onerror: null };
            const fireComplete = () => setImmediate(() => { if (tx.oncomplete) tx.oncomplete(); });
            tx.objectStore = function () {
              return {
                put(value, key) { store.set(key, value); const r = { oncomplete: null, onerror: null }; setImmediate(() => r.oncomplete && r.oncomplete()); fireComplete(); return r; },
                get(key) { const r = { onsuccess: null, onerror: null, result: store.has(key) ? store.get(key) : null }; setImmediate(() => r.onsuccess && r.onsuccess({ target: { result: r.result } })); fireComplete(); return r; },
                delete(key) { store.delete(key); const r = { oncomplete: null, onerror: null }; setImmediate(() => r.oncomplete && r.oncomplete()); fireComplete(); return r; },
              };
            };
            return tx;
          },
        },
      };
      setImmediate(() => { req.onupgradeneeded && req.onupgradeneeded({ target: { result: req.result } }); req.onsuccess && req.onsuccess({ target: { result: req.result } }); });
      return req;
    },
    _store: store,
  };
}

const PATH_TYPES = ['image', 'video', 'audio', 'model', 'archive', 'netdisk'];

function buildSandbox() {
  const idb = makeFakeIDB();
  const pathPickButtons = PATH_TYPES.map((t) => ({ dataset: { type: t }, onclick: null }));
  const pathClearButtons = PATH_TYPES.map((t) => ({ dataset: { type: t }, onclick: null }));
  const pathTestButtons = PATH_TYPES.map((t) => ({ dataset: { type: t }, onclick: null }));
  const pathTexts = {}; // type -> { textContent }
  PATH_TYPES.forEach((t) => { pathTexts[t] = { textContent: '未设置' }; }); // 初始与 sidepanel.html 一致
  const documentStub = {
    addEventListener() {}, removeEventListener() {},
    body: fakeEl(),
    getElementById() { return fakeEl(); },
    querySelectorAll(sel) {
      if (sel === '.pathPick') return pathPickButtons;
      if (sel === '.pathClear') return pathClearButtons;
      if (sel === '.pathTest') return pathTestButtons;
      return [];
    },
    querySelector(sel) {
      const m = sel && sel.match(/^\.pathText\[data-type="(.+)"\]$/);
      if (m) { const t = m[1]; if (!pathTexts[t]) pathTexts[t] = { textContent: '未设置' }; return pathTexts[t]; }
      return null;
    },
  };

  const fakeDirHandle = (name) => ({
    name,
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    getFileHandle: async () => ({ createWritable: async () => ({ write: async () => {}, close: async () => {} }) }),
  });

  // 递归 chrome 桩：任何子命名空间（tabs/windows/downloads/storage…）都安全可用
  function deepStub() {
    const fn = function () { return deepStub(); };
    return new Proxy(fn, {
      get(t, k) {
        if (k === 'addListener' || k === 'removeListener' || k === 'addRules' || k === 'removeRules') return () => {};
        if (k === 'sendMessage') return async () => ({ ok: false, status: 0 });
        if (k === 'connect') return () => ({ onMessage: { addListener() {}, removeListener() {} }, postMessage() {}, onDisconnect: { addListener() {} } });
        if (k === 'getURL') return () => '';
        if (k === 'get' || k === 'set' || k === 'remove') return (...args) => { const cb = args[args.length - 1]; if (typeof cb === 'function') cb({}); };
        if (k === 'create' || k === 'query') return async () => ({});
        if (typeof k === 'symbol') return undefined;
        return deepStub();
      },
      apply() { return deepStub(); },
    });
  }

  const target = {
    console,
    setTimeout, clearTimeout, setImmediate, queueMicrotask,
    URL: globalThis.URL, Blob: globalThis.Blob, Promise,
    // window 级常用 API（sandbox.window = sandbox，所以挂这里即可）
    addEventListener() {}, removeEventListener() {}, postMessage() {}, dispatchEvent() { return false; },
    location: { href: 'sidepanel.html', hostname: 'localhost' },
    document: documentStub,
    indexedDB: idb,
    chrome: deepStub(),
    // 供下载链路使用的桩（真实文件未定义时回退到此；真实定义则覆盖）
    deriveFilename: (a) => (a && a.name) || (a && a.url ? a.url.split('/').pop() : 'file.bin'),
    deriveMediaReferer: (u, r) => r || '',
    fetchViaBackground: async () => ({ ok: false, status: 0 }),
    fetchMediaViaBackground: async () => ({ ok: false, status: 0 }),
    b64ToBytes: (s) => Uint8Array.from(Buffer.from(String(s || ''), 'base64')),
    sourceOrigin: () => '',
    pulseDownloadProgress: () => {},
    // 已知可选全局（真实页面可能为 undefined）；显式置 undefined 以免被代理当成 noop
    HMDaoLicense: undefined,
    // 测试可控的 showDirectoryPicker：返回带名称的目录句柄
    __fakeDirHandle: fakeDirHandle,
  };
  // ★关键：用 Proxy 做全局，未声明的跨文件符号（如 getPreviewAsset 等）安全回落为 noop，
  //   复现浏览器「所有 <script> 共享同一全局、加载顺序保证符号已存在」的语义；
  //   window 即全局，使 window.x 与裸 x 指向同一引用（var saveHandles 跨脚本共享）。
  const noop = function () { return undefined; };
  const proxy = new Proxy(target, {
    has() { return true; },
    get(t, k) {
      if (typeof k !== 'string') return t[k];
      if (k === 'window') return proxy;
      if (k in t) return t[k];
      if (k in globalThis) return globalThis[k]; // 真实内建（Object/Array/JSON/Map…）不回落 noop
      if (k === Symbol.unscopables || k === Symbol.toStringTag) return undefined;
      return noop;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  proxy.window = proxy;
  proxy.__state = { pathPickButtons, pathClearButtons, pathTestButtons, pathTexts, idb };
  return proxy;
}

function loadAll() {
  const sandbox = buildSandbox();
  const ctx = vm.createContext(sandbox);
  // 与 sidepanel.html 加载顺序一致：assetTypes → sidepanel → bulk-actions → download
  const src =
    read('assetTypes.js') + '\n' +
    read('sidepanel.js') + '\n' +
    read('bulk-actions.js') + '\n' +
    read('download.js') + '\n' +
    'window.__api = { trySaveToUserDir, userDirHandleFor, writeBlobToUserDir, tryWriteUserDirFromUrl, notifyUserDirSkipped, saveHandles: (typeof saveHandles !== "undefined" ? saveHandles : null) };';
  vm.runInContext(src, ctx);
  return { sandbox, ctx };
}

// ================================================================
section('A. .pathPick 点击 → .pathText 从「未设置」变为目录名（UI 不再卡死）');
{
  const { sandbox } = loadAll();
  const { pathPickButtons, pathTexts } = sandbox.__state;

  const imgBtn = pathPickButtons.find((b) => b.dataset.type === 'image');
  // 注入测试用目录选择器
  sandbox.window.showDirectoryPicker = async () => sandbox.__fakeDirHandle('我的图片');
  assert.equal(pathTexts['image'].textContent, '未设置', '初始必须为「未设置」');

  await check('A1 点击图片 .pathPick → 内存 saveHandles.image 被写入句柄', async () => {
    await withTimeout(imgBtn.onclick(), 5000, 'A1 onclick');
    assert.ok(sandbox.saveHandles.image, 'saveHandles.image 应为句柄');
    assert.equal(sandbox.saveHandles.image.name, '我的图片', '句柄名称应正确');
  });

  await check('A2 点击后 .pathText 立即变为目录名（不再是「未设置」）', async () => {
    // 重新加载并点击，单独断言 UI 文本（避免 A1 的 await 顺序干扰）
    const r2 = loadAll();
    const b2 = r2.sandbox.__state.pathPickButtons.find((x) => x.dataset.type === 'image');
    r2.sandbox.window.showDirectoryPicker = async () => r2.sandbox.__fakeDirHandle('我的图片');
    await withTimeout(b2.onclick(), 5000, 'A2 onclick');
    const sp = r2.sandbox.__state.pathTexts['image'];
    assert.notEqual(sp.textContent, '未设置', '点击后不得仍显示「未设置」');
    assert.ok(sp.textContent.includes('我的图片'), 'pathText 应包含目录名，实际=' + sp.textContent);
  });

  await check('A3 视频类型同样生效（覆盖全部 6 种类型绑定）', async () => {
    const r3 = loadAll();
    const b3 = r3.sandbox.__state.pathPickButtons.find((x) => x.dataset.type === 'video');
    r3.sandbox.window.showDirectoryPicker = async () => r3.sandbox.__fakeDirHandle('我的视频');
    await withTimeout(b3.onclick(), 5000, 'A3 onclick');
    const sp = r3.sandbox.__state.pathTexts['video'];
    assert.ok(sp.textContent.includes('我的视频'), 'video pathText 应为目录名，实际=' + sp.textContent);
  });

  await check('A4 网盘（netdisk）类型也正确写入并回显', async () => {
    const r4 = loadAll();
    const b4 = r4.sandbox.__state.pathPickButtons.find((x) => x.dataset.type === 'netdisk');
    r4.sandbox.window.showDirectoryPicker = async () => r4.sandbox.__fakeDirHandle('我的网盘');
    await withTimeout(b4.onclick(), 5000, 'A4 onclick');
    assert.equal(r4.sandbox.saveHandles.netdisk.name, '我的网盘');
    assert.ok(r4.sandbox.__state.pathTexts['netdisk'].textContent.includes('我的网盘'));
  });
}

// ================================================================
section('B. 下载入口能从全局 saveHandles 命中用户目录句柄');
{
  const { sandbox } = loadAll();
  const api = sandbox.__api;

  await check('B1 userDirHandleFor 按类型命中内存句柄', () => {
    const pics = sandbox.__fakeDirHandle('图片目录');
    sandbox.saveHandles.image = pics;
    assert.strictEqual(api.userDirHandleFor('image'), pics, '应按 image 命中');
  });

  await check('B2 netdisk 无独立句柄时回退 archive（P0 网盘复用归档目录）', () => {
    sandbox.saveHandles.archive = sandbox.__fakeDirHandle('归档目录');
    sandbox.saveHandles.netdisk = null;
    assert.strictEqual(api.userDirHandleFor('netdisk'), sandbox.saveHandles.archive, '网盘应回退到 archive');
    sandbox.saveHandles.netdisk = sandbox.__fakeDirHandle('网盘目录');
    assert.strictEqual(api.userDirHandleFor('netdisk'), sandbox.saveHandles.netdisk, '网盘有独立句柄时优先网盘');
  });

  await check('B3 未设置类型 → userDirHandleFor 返回 null（下载回退默认目录）', () => {
    sandbox.saveHandles.image = null;
    assert.strictEqual(api.userDirHandleFor('image'), null, '未设置应返回 null');
  });

  await check('B4 trySaveToUserDir：读到 saveHandles 句柄后真正写入用户目录（返回 true）', async () => {
    // 等恢复 Promise 跑完（无持久化句柄，静默跳过），再驱动下载
    await new Promise((r) => setImmediate(r));
    const written = [];
    const handle = {
      name: '图片目录',
      queryPermission: async () => 'granted',
      getFileHandle: async (name) => ({ createWritable: async () => ({ write: async (b) => written.push([name, b]), close: async () => {} }) }),
    };
    sandbox.saveHandles.image = handle;
    // 让 fetchViaBackground 返回真实字节
    sandbox.fetchViaBackground = async () => ({ ok: true, arrayBuffer: new Uint8Array([1, 2, 3, 4]) });
    const ok = await api.trySaveToUserDir({ type: 'image', url: 'https://cdn.example.com/a.jpg', name: 'a.jpg' });
    assert.equal(ok, true, '命中用户目录应返回 true（下载已落盘到用户目录）');
    assert.ok(written.length === 1, '应已向用户目录写入 1 个文件，实际=' + written.length);
    assert.equal(written[0][0], 'a.jpg', '写入文件名应匹配 deriveFilename 结果');
  });

  await check('B5 trySaveToUserDir：未设置该类型 → 返回 false（回退默认下载，不落用户目录）', async () => {
    sandbox.saveHandles.image = null;
    const ok = await api.trySaveToUserDir({ type: 'image', url: 'https://cdn.example.com/b.jpg', name: 'b.jpg' });
    assert.equal(ok, false, '未设置目录应回退默认下载（返回 false）');
  });

  await check('B6 流媒体（m3u8）不进「抓字节→写用户目录」路径，返回 false', async () => {
    const handle = sandbox.__fakeDirHandle('视频目录');
    sandbox.saveHandles.video = handle;
    const ok = await api.trySaveToUserDir({ type: 'video', url: 'https://x/y.m3u8?t=1', name: 'y.m3u8' });
    assert.equal(ok, false, '流媒体必须走后端拉流，返回 false');
  });
}

console.log(`\n=== phase15-userdir-persist 总结 ===\n通过 ${pass} / 失败 ${fail}`);
if (failures.length) { console.log('\n失败明细:'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
