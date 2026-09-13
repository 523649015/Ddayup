// phase16-userdir-absolute-only.test.mjs
// QA 回归（自定义保存路径 · 绝对目录版）2026-09-12
// 背景：旧版「相对子目录兜底」(relDirs) 只能落到浏览器默认下载目录下，用户填绝对路径(D:\素材)
//       会被剥离盘符、落到默认目录并重复建文件夹 → 已彻底移除。
// 现统一为「选择目录」→ saveHandles[type]（File System Access API）写【任意绝对目录】。
// 本测试验证：
//   A. 源码/UI 层：相对子目录机制已彻底移除（HTML 无 pathInput/pathApply；JS 无 relDirs/userRelDirFor…）
//   B. 未设目录时 dlViaChrome 维持默认 filename（不再生成相对子目录，杜绝"重复建文件夹"）
//   C. pathPick 后 UI 显示「✅ 已设置：<目录名>」，pathClear 后回到「默认 Ddayup/<sub>/」基线
//   D. 设了绝对目录后 dlViaChrome 命中用户目录（返回 -1）且不再发起 chrome.downloads
// 运行：node tests/phase16-userdir-absolute-only.test.mjs
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
const SUBS = { image: 'images', video: 'videos', audio: 'audio', model: 'models', archive: 'archives', netdisk: 'netdisk' };

function buildSandbox() {
  const idb = makeFakeIDB();
  const pathPickButtons = PATH_TYPES.map((t) => ({ dataset: { type: t }, onclick: null }));
  const pathClearButtons = PATH_TYPES.map((t) => ({ dataset: { type: t }, onclick: null }));
  const pathTestButtons = PATH_TYPES.map((t) => ({ dataset: { type: t }, onclick: null }));
  const pathTexts = {};
  PATH_TYPES.forEach((t) => {
    pathTexts[t] = { textContent: `未设置 · 默认 Ddayup/${SUBS[t]}/`, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } } };
  });

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
      if (m) { const t = m[1]; if (!pathTexts[t]) pathTexts[t] = { textContent: '', classList: { add() {}, remove() {} } }; return pathTexts[t]; }
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
  const wrapFallthrough = (obj) => new Proxy(obj, {
    get(t, k) { if (k in t) return t[k]; if (typeof k === 'symbol') return undefined; return deepStub(); },
  });
  const chromeStub = new Proxy(ctrl, {
    get(t, k) {
      if (k in t) { const v = t[k]; if (v && typeof v === 'object' && !Array.isArray(v)) return wrapFallthrough(v); return v; }
      if (typeof k === 'symbol') return undefined;
      return deepStub();
    },
  });

  const fakeDirHandle = (name) => ({
    name,
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    getFileHandle: async () => ({ createWritable: async () => ({ write: async () => {}, close: async () => {} }) }),
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
    HmdaoProgress: { registerTask: () => 1, bindDownloadId() {}, fail() {}, cancel() {}, finish() {}, complete() {} },
    deriveFilename: (a) => (a && a.name) || (a && a.url ? a.url.split('/').pop() : 'file.bin'),
    deriveMediaReferer: (u, r) => r || '',
    fetchViaBackground: async () => ({ ok: true, arrayBuffer: new Uint8Array([1, 2, 3, 4]) }),
    fetchMediaViaBackground: async () => ({ ok: true, arrayBuffer: new Uint8Array([1, 2, 3, 4]), mime: 'image/jpeg' }),
    // ★2026-09-13：.pathPick 现优先调后端原生目录选择器（fetch）。此处桩成「后端不可用」，
    //   使测试走 FSA 兜底分支，且绝不触发真实网络请求（避免真的弹出系统目录框）。
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    b64ToBytes: (s) => Uint8Array.from(Buffer.from(String(s || ''), 'base64')),
    sourceOrigin: () => '',
    pulseDownloadProgress: () => {},
    HMDaoLicense: undefined,
    __fakeDirHandle: fakeDirHandle,
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
  proxy.__state = { pathPickButtons, pathClearButtons, pathTexts, idb, ctrl };
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
    'window.__api = { dlViaChrome, userDirHandleFor, tryWriteUserDirFromUrl, trySaveToUserDir, writeBlobToUserDir, saveHandles: (typeof saveHandles !== "undefined" ? saveHandles : null) };';
  vm.runInContext(src, ctx);
  return sandbox;
}

// ================================================================
section('A. UI 层：绝对路径输入框（通道二）+ 选择目录（通道一）并存；相对子目录机制仍彻底移除');
{
  const html = read('sidepanel.html');
  await check('A1 sidepanel.html 已删除绝对路径输入框/应用按钮，仅保留「选择目录」(pathPick)/测试/清除', () => {
    // ★2026-09-13 行为变更（用户诉求「去掉绝对路径手动输入填写功能，保留用户分类选择路径」）：
    //   pathInput/pathApply 已彻底移除；「选择目录」改走后端原生目录选择器（返回真实绝对路径）。
    assert.ok(!html.includes('pathInput'), 'HTML 不应再含 pathInput（手动绝对路径输入框已移除）');
    assert.ok(!html.includes('pathApply'), 'HTML 不应再含 pathApply（应用按钮已移除）');
    assert.ok(html.includes('pathPick'), 'HTML 应保留 pathPick（选择目录）');
    assert.ok(html.includes('pathTest'), 'HTML 应保留 pathTest（测试）');
    assert.ok(html.includes('pathClear'), 'HTML 应保留 pathClear（清除）');
    assert.ok(html.includes('系统目录选择框'), 'pathPick title 应说明弹出系统目录选择框');
  });

  await check('A2 JS 源码不再引用 relDirs / userRelDirFor / applyRelPath 等相对子目录符号', () => {
    const banned = ['relDirs', 'userRelDirFor', 'normalizeRelPath', 'applyRelPath', 'saveRelDir', 'loadRelDir', 'restoreRelDirs'];
    for (const f of ['bulk-actions.js', 'download.js']) {
      const src = read(f);
      for (const b of banned) assert.ok(!src.includes(b), `${f} 仍残留 ${b}`);
    }
    const sp = read('sidepanel.js');
    for (const b of ['var relDirs', 'userRelDirFor', 'applyRelPath']) assert.ok(!sp.includes(b), `sidepanel.js 仍残留 ${b}`);
  });

  await check('A3 bulk-actions.js 用 var 定义跨 <script> 共享的 dirPaths，并存到 dirPath:<type>', () => {
    const src = read('bulk-actions.js');
    assert.ok(/var\s+dirPaths\s*=\s*\{/.test(src), 'dirPaths 必须以 var 声明（跨 <script> 共享，供 download.js 读取）');
    assert.ok(src.includes("'dirPath:' + type"), '持久化键应为 dirPath:<type>');
  });

  await check('A4 download.js 具备后端绝对路径落盘通道（save-to-dir）且优先级高于句柄', () => {
    const src = read('download.js');
    assert.ok(src.includes('/api/media/save-to-dir'), 'download.js 应调用后端 save-to-dir 端点');
    assert.ok(src.includes('trySaveViaBackendDir'), '应存在统一后端落盘入口 trySaveViaBackendDir');
    assert.ok(src.includes('hasBackendDirFor'), '应存在 hasBackendDirFor 判定');
  });
}

// ================================================================
section('B. 未设目录：dlViaChrome 维持默认 filename（不生成相对子目录）');
{
  const sandbox = loadAll();
  const api = sandbox.__api;
  const { ctrl } = sandbox.__state;

  await check('B1 未设 image 目录 → chrome.downloads 的 filename 保持默认 Ddayup/images/xxx.jpg', async () => {
    await new Promise((r) => setImmediate(r));
    sandbox.saveHandles.image = null;
    ctrl._downloads.length = 0;
    const asset = { type: 'image', url: 'https://x.test/p/a.jpg', name: 'a.jpg' };
    await api.dlViaChrome({ url: asset.url, filename: 'Ddayup/images/a.jpg', asset, saveAs: false, conflictAction: 'uniquify' });
    assert.equal(ctrl._downloads.length, 1, '应恰好发起一次 chrome.downloads.download');
    assert.equal(ctrl._downloads[0].filename, 'Ddayup/images/a.jpg', '未设目录时 filename 不得被改写，实际=' + ctrl._downloads[0].filename);
    assert.equal(ctrl._downloads[0].asset, undefined, 'asset 不应透传给 chrome.downloads');
  });
}

// ================================================================
section('C. UI 状态：设置后显示「✅ 已设置」，清除后回到默认基线');
{
  const sandbox = loadAll();
  const { pathPickButtons, pathClearButtons, pathTexts } = sandbox.__state;

  await check('C1 初始态展示默认路径基线「默认 Ddayup/images/」', () => {
    assert.ok(String(pathTexts.image.textContent).includes('默认 Ddayup/images/'), '初始应显示默认基线，实际=' + pathTexts.image.textContent);
  });

  await check('C2 点击 .pathPick 选定「我的图片」→ pathText 变为「✅ 已设置：我的图片」', async () => {
    sandbox.window.showDirectoryPicker = async () => sandbox.__fakeDirHandle('我的图片');
    const btn = pathPickButtons.find((b) => b.dataset.type === 'image');
    await btn.onclick();
    assert.ok(String(pathTexts.image.textContent).includes('已设置'), '应显示「已设置」，实际=' + pathTexts.image.textContent);
    assert.ok(String(pathTexts.image.textContent).includes('我的图片'), '应包含目录名，实际=' + pathTexts.image.textContent);
  });

  await check('C3 点击 .pathClear 清除 → pathText 回到默认路径基线', async () => {
    const btn = pathClearButtons.find((b) => b.dataset.type === 'image');
    await btn.onclick();
    assert.ok(String(pathTexts.image.textContent).includes('默认 Ddayup/images/'), '清除后应回到默认基线，实际=' + pathTexts.image.textContent);
  });
}

// ================================================================
section('D. 设了绝对目录：dlViaChrome 命中用户目录（返回 -1，不再走 chrome.downloads）');
{
  const sandbox = loadAll();
  const api = sandbox.__api;
  const { ctrl } = sandbox.__state;

  await check('D1 设 image 目录 → dlViaChrome 直接写用户目录并返回 -1（跳过默认下载）', async () => {
    await new Promise((r) => setImmediate(r));
    const written = [];
    sandbox.saveHandles.image = {
      name: '我的图片',
      queryPermission: async () => 'granted',
      getFileHandle: async (name) => ({ createWritable: async () => ({ write: async () => written.push(name), close: async () => {} }) }),
    };
    ctrl._downloads.length = 0;
    const asset = { type: 'image', url: 'https://x.test/p/c.jpg', name: 'c.jpg', size: 1024 };
    const res = await api.dlViaChrome({ url: asset.url, filename: 'Ddayup/images/c.jpg', asset, saveAs: false, conflictAction: 'uniquify' });
    assert.equal(res, -1, '命中用户目录应返回 -1');
    assert.equal(ctrl._downloads.length, 0, '已写入用户目录后不得再发起 chrome.downloads');
    assert.ok(written.includes('c.jpg'), '应写入用户目录（文件名 c.jpg），实际=' + JSON.stringify(written));
  });
}

console.log('\n==== phase16-userdir-absolute-only 总结 ====');
console.log('通过 ' + pass + ' / 失败 ' + fail);
if (failures.length) { console.log('失败项：\n - ' + failures.join('\n - ')); process.exit(1); }
console.log('✅ 全部通过');
process.exit(0);
