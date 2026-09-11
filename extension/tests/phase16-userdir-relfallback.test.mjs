// phase16-userdir-relfallback.test.mjs
// QA 回归（双保险：相对子目录兜底）2026-09-12
// 验证「按类型自定义保存路径」的双保险链路：当浏览器不支持 showDirectoryPicker（绝对目录）时，
// 用户在文本框填入相对子目录名，下载必须落到「浏览器下载目录/Ddayup/<相对子目录>/」。
//   C1 文本框填相对子目录 → relDirs[type] 设置 + .pathText 回显「✓ 相对：...」
//   C2 输入绝对盘符路径 D:/素材/图片 → 自动剥离盘符，落相对子目录并提示
//   C3 userRelDirFor 返回相对子目录片段
//   C4 dlViaChrome 在无绝对 handle、有 relDirs 时，chrome.downloads.download 的 filename 改为 Ddayup/<rel>/<name>
//   C5 netdisk 无独立 relDirs 时复用 archive 的 relDirs
// 运行：node tests/phase16-userdir-relfallback.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '..');
const read = (f) => readFileSync(path.join(EXT, f), 'utf8');

setTimeout(() => { console.error('\n!! HARD TIMEOUT (20s) — 疑似 await 卡死'); process.exit(3); }, 20000).unref();

let pass = 0, fail = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); console.log('  ✓', name); pass++; }
  catch (e) { console.log('  ✗', name, '\n      →', e && e.message); fail++; failures.push(name + ' :: ' + (e && e.message)); }
}
function section(t) { console.log('\n===', t, '==='); }

function fakeEl() {
  return {
    dataset: {}, style: {}, disabled: false, value: '',
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
  const pathApplyButtons = PATH_TYPES.map((t) => ({ dataset: { type: t }, onclick: null }));
  const pathInputEls = {}; PATH_TYPES.forEach((t) => { pathInputEls[t] = { dataset: { type: t }, value: '', addEventListener() {}, removeEventListener() {} }; });
  const pathTexts = {}; PATH_TYPES.forEach((t) => { pathTexts[t] = { textContent: '未设置', classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } } }; });

  const documentStub = {
    addEventListener() {}, removeEventListener() {},
    body: fakeEl(),
    getElementById() { return fakeEl(); },
    querySelectorAll(sel) {
      if (sel === '.pathPick') return pathPickButtons;
      if (sel === '.pathClear') return pathClearButtons;
      if (sel === '.pathTest') return pathTestButtons;
      if (sel === '.pathApply') return pathApplyButtons;
      if (sel === '.pathInput') return PATH_TYPES.map((t) => pathInputEls[t]);
      return [];
    },
    querySelector(sel) {
      let m = sel && sel.match(/^\.pathText\[data-type="(.+)"\]$/);
      if (m) { const t = m[1]; if (!pathTexts[t]) pathTexts[t] = { textContent: '未设置' }; return pathTexts[t]; }
      m = sel && sel.match(/^\.pathInput\[data-type="(.+)"\]$/);
      if (m) { const t = m[1]; if (!pathInputEls[t]) pathInputEls[t] = { dataset: { type: t }, value: '', addEventListener() {}, removeEventListener() {} }; return pathInputEls[t]; }
      return null;
    },
  };

  const deepStub = () => {
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
  };

  // 可控 chrome：已知项精确捕获，未知项回落 deepStub（安全）
  const ctrl = {
    _downloads: [],
    downloads: {
      download: async (o) => { ctrl._downloads.push(o); return ctrl._downloads.length; },
      onChanged: { addListener() {}, removeListener() {} },
      onDeterminingFilename: { addListener() {} },
    },
    storage: { local: { get: (k, cb) => cb && cb({}), set() {}, remove() {} } },
    tabs: { query: async () => [{}] },
    scripting: { executeScript: async () => [{}] },
    runtime: { sendMessage: async () => ({ ok: false }), lastError: null, onMessage: { addListener() {}, removeListener() {} }, onInstalled: { addListener() {} } },
  };
  // 已知项精确捕获；其未知子键回落 deepStub（如 tabs.onActivated、storage.onChanged 等）
  const wrapFallthrough = (obj) => new Proxy(obj, {
    get(t, k) { if (k in t) return t[k]; if (typeof k === 'symbol') return undefined; return deepStub(); },
  });
  const chromeStub = new Proxy(ctrl, {
    get(t, k) {
      if (k in t) {
        const v = t[k];
        if (v && typeof v === 'object' && !Array.isArray(v)) return wrapFallthrough(v);
        return v;
      }
      if (typeof k === 'symbol') return undefined;
      return deepStub();
    },
  });

  const target = {
    console,
    setTimeout, clearTimeout, setImmediate, queueMicrotask,
    URL: globalThis.URL, Blob: globalThis.Blob, Promise,
    addEventListener() {}, removeEventListener() {}, postMessage() {}, dispatchEvent() { return false; },
    location: { href: 'sidepanel.html', hostname: 'localhost' },
    document: documentStub,
    indexedDB: idb,
    chrome: chromeStub,
    HmdaoProgress: { registerTask: () => 1, bindDownloadId() {}, fail() {}, cancel() {}, finish() {} },
    deriveFilename: (a) => (a && a.name) || (a && a.url ? a.url.split('/').pop() : 'file.bin'),
    deriveMediaReferer: (u, r) => r || '',
    fetchViaBackground: async () => ({ ok: false, status: 0 }),
    fetchMediaViaBackground: async () => ({ ok: false, status: 0 }),
    b64ToBytes: (s) => Uint8Array.from(Buffer.from(String(s || ''), 'base64')),
    sourceOrigin: () => '',
    pulseDownloadProgress: () => {},
    HMDaoLicense: undefined,
  };
  const noop = function () { return undefined; };
  const proxy = new Proxy(target, {
    has() { return true; },
    get(t, k) {
      if (typeof k !== 'string') return t[k];
      if (k === 'window') return proxy;
      if (k in t) return t[k];
      if (k in globalThis) return globalThis[k];
      if (k === Symbol.unscopables || k === Symbol.toStringTag) return undefined;
      return noop;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  proxy.window = proxy;
  proxy.__state = { pathPickButtons, pathClearButtons, pathTestButtons, pathApplyButtons, pathInputEls, pathTexts, idb, ctrl };
  return proxy;
}

function loadAll() {
  const sandbox = buildSandbox();
  const ctx = vm.createContext(sandbox);
  const src =
    read('assetTypes.js') + '\n' +
    read('sidepanel.js') + '\n' +
    read('bulk-actions.js') + '\n' +
    read('download.js') + '\n' +
    'window.__api = { userRelDirFor, dlViaChrome, applyRelPath, userDirHandleFor, tryWriteUserDirFromUrl, relDirs: (typeof relDirs !== "undefined" ? relDirs : null), saveHandles: (typeof saveHandles !== "undefined" ? saveHandles : null) };';
  vm.runInContext(src, ctx);
  return sandbox;
}

// ================================================================
section('C. 双保险：相对子目录兜底');
{
  const sandbox = loadAll();
  const { pathInputEls, pathTexts, ctrl } = sandbox.__state;
  const api = sandbox.__api;

  // C1 文本框填相对子目录 → relDirs 设置 + UI 回显
  await check('C1 .pathInput 填「浏览器下载素材/图片」→ relDirs.image 设置且 .pathText 回显「✓ 相对：浏览器下载素材/图片」', async () => {
    pathInputEls['image'].value = '浏览器下载素材/图片';
    api.applyRelPath('image');
    assert.equal(api.relDirs.image, '浏览器下载素材/图片', 'relDirs.image 应被设置');
    assert.ok(String(pathTexts['image'].textContent).includes('✓ 相对：浏览器下载素材/图片'), 'pathText 应回显相对子目录，实际=' + pathTexts['image'].textContent);
  });

  // C2 输入绝对盘符路径 → 自动剥离盘符，落相对子目录并提示
  await check('C2 填「D:/素材/图片」→ 剥离盘符，relDirs.image=素材/图片 且提示已去掉盘符', async () => {
    pathInputEls['image'].value = 'D:/素材/图片';
    api.applyRelPath('image');
    assert.equal(api.relDirs.image, '素材/图片', '应剥离 D: 前缀');
    assert.ok(String(pathTexts['image'].textContent).includes('已去掉盘符'), '应提示已去掉盘符，实际=' + pathTexts['image'].textContent);
  });

  // C3 userRelDirFor 返回相对子目录片段（不含前导 /）
  await check('C3 userRelDirFor("image") 返回「素材/图片」', async () => {
    assert.equal(api.userRelDirFor('image'), '素材/图片');
  });

  // C4 dlViaChrome：无绝对 handle、有 relDirs → chrome.downloads.download 的 filename 改为 Ddayup/<rel>/<name>
  await check('C4 dlViaChrome 改写 filename 落到 Ddayup/素材/图片/xxx.jpg（不再默认 Ddayup/image/）', async () => {
    ctrl._downloads.length = 0;
    const asset = { type: 'image', url: 'https://x.test/p/photo.jpg', name: 'photo.jpg' };
    const res = await api.dlViaChrome({ url: asset.url, filename: 'Ddayup/image/photo.jpg', asset, saveAs: false, conflictAction: 'uniquify' });
    assert.ok(res != null, 'dlViaChrome 应返回下载 id');
    assert.equal(ctrl._downloads.length, 1, '应恰好发起一次 chrome.downloads.download');
    const dl = ctrl._downloads[0];
    assert.equal(dl.filename, 'Ddayup/素材/图片/photo.jpg', 'filename 应改写为相对子目录，实际=' + dl.filename);
    assert.equal(dl.asset, undefined, 'asset 不应透传给 chrome.downloads（否则抛 Unexpected property）');
  });

  // C5 netdisk 无独立 relDirs 时复用 archive
  await check('C5 netdisk 复用 archive 的相对子目录', async () => {
    const { pathInputEls: pi2, pathTexts: pt2 } = sandbox.__state;
    pi2['archive'].value = '网盘归档/资料';
    api.applyRelPath('archive');
    assert.equal(api.relDirs.archive, '网盘归档/资料');
    assert.equal(api.userRelDirFor('netdisk'), '网盘归档/资料', 'netdisk 应复用 archive 的相对子目录');
  });

  // C6 无绝对 handle 且无 relDirs → 维持默认 filename（不破坏原行为）
  await check('C6 彻底未设置 → 维持原默认 filename（双保险不干扰默认行为）', async () => {
    ctrl._downloads.length = 0;
    api.relDirs.image = null;
    const asset = { type: 'image', url: 'https://x.test/p/other.jpg', name: 'other.jpg' };
    await api.dlViaChrome({ url: asset.url, filename: 'Ddayup/image/other.jpg', asset, saveAs: false, conflictAction: 'uniquify' });
    assert.equal(ctrl._downloads[0].filename, 'Ddayup/image/other.jpg', '未设置时应保持默认 filename');
  });
}

console.log('\n==== phase16-userdir-relfallback 总结 ====');
console.log('通过 ' + pass + ' / 失败 ' + fail);
if (failures.length) { console.log('失败项：\n - ' + failures.join('\n - ')); process.exit(1); }
console.log('✅ 全部通过');
process.exit(0); // 源码可能留有定时/连接句柄，强制退出避免 20s 硬超时
