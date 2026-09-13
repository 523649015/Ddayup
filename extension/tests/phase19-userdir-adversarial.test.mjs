// QA 对抗性用例（独立于工程师的 phase16/18），验证「后端绝对路径通道」的边界与回退。
// ★2026-09-12 由 tests/_qa_tmp/qa-adversarial-userdir.test.mjs 提升为正式用例（phase19）：
//   保留原 6 条断言与说明，并新增 Section Y —— Service Worker 网盘深解析通道的自定义目录接入。
// 运行：node tests/phase19-userdir-adversarial.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '..');
const read = (f) => readFileSync(path.join(EXT, f), 'utf8');

setTimeout(() => { console.error('\n!! HARD TIMEOUT (25s)'); process.exit(3); }, 25000).unref();

let pass = 0, fail = 0; const failures = [];
async function check(name, fn) {
  try { await fn(); console.log('  ✓', name); pass++; }
  catch (e) { console.log('  ✗', name, '\n      →', e && e.message); fail++; failures.push(name + ' :: ' + (e && e.message)); }
}

function fakeEl() {
  return { dataset: {}, style: {}, disabled: false, value: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {},
    setAttribute() {}, getAttribute() { return null; }, remove() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, _tc: '',
    set onclick(f) { this._onclick = f; }, get onclick() { return this._onclick; },
    set textContent(v) { this._tc = v; }, get textContent() { return this._tc; },
    set innerHTML(v) {}, get innerHTML() { return ''; } };
}
function makeFakeIDB() {
  const store = new Map();
  return { open() { const req = { onsuccess: null, onerror: null, onupgradeneeded: null,
    result: { objectStoreNames: { contains: () => true }, createObjectStore() {},
      transaction() { const tx = { oncomplete: null, onerror: null };
        tx.objectStore = function () { return {
          put(v, k) { store.set(k, v); const r = {}; setImmediate(() => r.oncomplete && r.oncomplete()); return r; },
          get(k) { const r = { result: store.has(k) ? store.get(k) : null }; setImmediate(() => r.onsuccess && r.onsuccess({ target: { result: r.result } })); return r; },
          delete(k) { store.delete(k); const r = {}; setImmediate(() => r.oncomplete && r.oncomplete()); return r; } }; };
        return tx; } } };
    setImmediate(() => { req.onupgradeneeded && req.onupgradeneeded({ target: { result: req.result } }); req.onsuccess && req.onsuccess({ target: { result: req.result } }); });
    return req; } };
}
const PATH_TYPES = ['image', 'video', 'audio', 'model', 'archive', 'netdisk'];
const SUBS = { image: 'images', video: 'videos', audio: 'audio', model: 'models', archive: 'archives', netdisk: 'netdisk' };
function buildSandbox() {
  const idb = makeFakeIDB(); const storageMap = new Map();
  const btns = () => PATH_TYPES.map((t) => fakeEl({ dataset: { type: t } }));
  const pathApply = btns(), pathInputs = {};
  PATH_TYPES.forEach((t) => { pathInputs[t] = fakeEl({ dataset: { type: t }, value: '' }); });
  const pathTexts = {}; PATH_TYPES.forEach((t) => { pathTexts[t] = fakeEl({ textContent: `未设置 · 默认 Ddayup/${SUBS[t]}/` }); });
  const elById = {};
  const documentStub = {
    addEventListener() {}, removeEventListener() {}, body: fakeEl(),
    getElementById(id) { if (!elById[id]) elById[id] = fakeEl(); return elById[id]; },
    createElement() { return fakeEl(); },
    querySelectorAll(sel) { if (sel === '.pathApply') return pathApply; if (sel === '.pathInput') return PATH_TYPES.map((t) => pathInputs[t]); return []; },
    querySelector(sel) { let m = sel && sel.match(/^\.pathText\[data-type="(.+)"\]$/); if (m) return pathTexts[m[1]] || null;
      m = sel && sel.match(/^\.pathInput\[data-type="(.+)"\]$/); if (m) return pathInputs[m[1]] || null; return null; },
  };
  const ctrl = { _downloads: [],
    downloads: { download: async (o) => { ctrl._downloads.push(o); return ctrl._downloads.length; }, onChanged: { addListener() {}, removeListener() {} }, onDeterminingFilename: { addListener() {} } },
    storage: { local: { get: (keys, cb) => { const out = {}; const list = Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : Object.keys(keys || {})); for (const k of list) if (storageMap.has(k)) out[k] = storageMap.get(k); if (typeof cb === 'function') cb(out); },
      set: (obj, cb) => { for (const k of Object.keys(obj || {})) storageMap.set(k, obj[k]); if (typeof cb === 'function') cb(); }, remove: (k, cb) => { storageMap.delete(k); if (typeof cb === 'function') cb(); } }, _map: storageMap },
    tabs: { query: async () => [{}] }, scripting: { executeScript: async () => [{}] },
    runtime: { sendMessage: async () => ({ ok: false }), lastError: null, onMessage: { addListener() {}, removeListener() {} }, onInstalled: { addListener() {} } } };
  const fetchCalls = [];
  let fetchImpl = async () => ({ ok: false, status: 0, json: async () => ({}) });
  function deepStub() { const fn = function () { return deepStub(); }; return new Proxy(fn, { get(t, k) {
    if (['addListener','removeListener','addRules','removeRules'].includes(k)) return () => {};
    if (k === 'sendMessage') return async () => ({ ok: false, status: 0 });
    if (k === 'connect') return () => ({ onMessage: { addListener() {}, removeListener() {} }, postMessage() {}, onDisconnect: { addListener() {} } });
    if (k === 'getURL') return () => '';
    if (k === 'get' || k === 'set' || k === 'remove') return (...args) => { const cb = args[args.length - 1]; if (typeof cb === 'function') cb({}); };
    if (k === 'create' || k === 'query') return async () => ({});
    if (typeof k === 'symbol') return undefined; return deepStub(); }, apply() { return deepStub(); } }); }
  const wrapFallthrough = (obj) => new Proxy(obj, { get(t, k) { if (k in t) return t[k]; if (typeof k === 'symbol') return undefined; return deepStub(); } });
  const chromeStub = new Proxy(ctrl, { get(t, k) { if (k in t) { const v = t[k]; if (v && typeof v === 'object' && !Array.isArray(v)) return wrapFallthrough(v); return v; } if (typeof k === 'symbol') return undefined; return deepStub(); } });
  const target = { console, setTimeout, clearTimeout, setImmediate, queueMicrotask, URL: globalThis.URL, Blob: globalThis.Blob, Promise, atob: globalThis.atob, btoa: globalThis.btoa,
    addEventListener() {}, removeEventListener() {}, postMessage() {}, dispatchEvent() { return false; },
    location: { href: 'sidepanel.html', hostname: 'localhost' }, document: documentStub, indexedDB: idb, chrome: chromeStub,
    fetch: (url, opts) => { fetchCalls.push({ url, opts }); return fetchImpl(url, opts); },
    deriveFilename: (a) => (a && a.name) || (a && a.url ? a.url.split('/').pop() : 'file.bin'),
    deriveMediaReferer: (u, r) => r || '', sourceOrigin: () => '', apiBaseUrl: () => 'http://127.0.0.1:3000', getCloudApiBase: async () => 'http://127.0.0.1:3000',
    ensureBackendRunningNative: async () => ({ ok: false, nativeUnavailable: true }), startBackendViaNative: async () => ({ ok: false }),
    setStatus: (t) => { target.__lastStatus = String(t); }, warnStatus: (t) => { target.__lastStatus = String(t); },
    pulseDownloadProgress: () => {}, finishDownloadProgress: () => {}, updateDownloadProgress: () => {},
    b64ToBytes: (s) => Uint8Array.from(Buffer.from(String(s || ''), 'base64')),
    HmdaoProgress: { registerTask: () => 1, bindDownloadId() {}, fail() {}, cancel() {}, complete() {} }, typeLabel: (t) => t, HMDaoLicense: undefined };
  const noop = function () { return undefined; };
  const proxy = new Proxy(target, { has() { return true; }, get(t, k) { if (typeof k !== 'string') return t[k]; if (k === 'window') return proxy; if (k in t) return t[k]; if (k in globalThis) return globalThis[k]; if (k === Symbol.unscopables || k === Symbol.toStringTag) return undefined; return noop; }, set(t, k, v) { t[k] = v; return true; } });
  proxy.window = proxy;
  proxy.__state = { ctrl, storageMap, fetchCalls, elById, setFetch: (f) => { fetchImpl = f; } };
  return proxy;
}
function loadAll() {
  const sandbox = buildSandbox(); const ctx = vm.createContext(sandbox);
  const src = read('assetTypes.js') + '\n' + read('sidepanel.js') + '\n' + read('bulk-actions.js') + '\n' + read('download.js') + '\n' +
    'window.__api = { dlViaChrome, trySaveViaBackendDir, hasBackendDirFor, backendDirFor, writeBlobToUserDir, tryWriteUserDirFromUrl, dirPaths, saveDirPath };';
  vm.runInContext(src, ctx);
  return sandbox;
}
const tick = () => new Promise((r) => setImmediate(r));

console.log('\n==== QA 对抗性用例：后端绝对路径通道边界 ====');

await check('X1 未设置绝对路径 → 绝不调用 save-to-dir，且文件名保持默认（默认路径行为未被破坏）', async () => {
  const s = loadAll(); await tick();
  s.__state.ctrl._downloads.length = 0;
  s.__api.dirPaths.image = null;
  s.__state.setFetch(async (url) => { throw new Error('不该调用后端: ' + url); });
  const a = { type: 'image', url: 'https://x.test/p/a.jpg', name: 'a.jpg' };
  const res = await s.__api.dlViaChrome({ url: a.url, filename: 'Ddayup/images/a.jpg', asset: a, saveAs: false, conflictAction: 'uniquify' });
  assert.notEqual(res, -1, '未设置时不得走用户目录');
  assert.equal(s.__state.ctrl._downloads.length, 1);
  assert.equal(s.__state.ctrl._downloads[0].filename, 'Ddayup/images/a.jpg', 'filename 必须保持默认');
  assert.ok(!s.__state.fetchCalls.some((c) => String(c.url).includes('save-to-dir')), '未设置时不得请求后端');
});

await check('X2 后端返回 500（非 serviceDown）→ 回退默认下载且状态明确含原因（不静默）', async () => {
  const s = loadAll(); await tick();
  s.__state.ctrl._downloads.length = 0;
  s.__api.dirPaths.video = 'D:/素材/视频';
  s.__state.setFetch(async () => ({ ok: false, status: 500, json: async () => ({ success: false, error: '磁盘只读' }) }));
  const a = { type: 'video', url: 'https://x.test/p/v.mp4', name: 'v.mp4' };
  const res = await s.__api.dlViaChrome({ url: a.url, filename: 'Ddayup/videos/v.mp4', asset: a, saveAs: false, conflictAction: 'uniquify' });
  assert.notEqual(res, -1, '后端失败不得返回 -1');
  assert.equal(s.__state.ctrl._downloads.length, 1, '必须回退 chrome.downloads');
  const st = String((s.__state.elById.status && s.__state.elById.status.textContent) || '');
  assert.ok(st.includes('未存入') && st.includes('磁盘只读'), '状态须含原因，实际=' + st);
});

await check('X3 后端网络异常（首次断 + 拉起后仍断）→ 提示「本地服务未启动」并回退（不抛未捕获异常）', async () => {
  const s = loadAll(); await tick();
  s.__state.ctrl._downloads.length = 0;
  s.__api.dirPaths.audio = 'D:/素材/音频';
  s.__state.setFetch(async () => { throw new Error('Failed to fetch'); });
  s.ensureBackendRunningNative = async () => ({ ok: false, nativeUnavailable: true });
  const a = { type: 'audio', url: 'https://x.test/p/a.mp3', name: 'a.mp3' };
  let threw = false;
  let res;
  try { res = await s.__api.dlViaChrome({ url: a.url, filename: 'Ddayup/audio/a.mp3', asset: a, saveAs: false, conflictAction: 'uniquify' }); }
  catch (e) { threw = true; }
  assert.equal(threw, false, '不得抛未捕获异常');
  assert.notEqual(res, -1);
  assert.equal(s.__state.ctrl._downloads.length, 1);
  const st = String((s.__state.elById.status && s.__state.elById.status.textContent) || '');
  assert.ok(st.includes('本地服务未启动'), '状态须含「本地服务未启动」，实际=' + st);
});

await check('X4 blob 资产在有后端路径时走 dataBase64 通道（不拉整段进内存，且 payload.dir 正确）', async () => {
  const s = loadAll(); await tick();
  s.__api.dirPaths.model = 'D:/素材/模型';
  let captured = null;
  s.__state.setFetch(async (url, opts) => { captured = { url, body: JSON.parse(opts.body) }; return { ok: true, status: 200, json: async () => ({ success: true, savedPath: 'D:/素材/模型/m.glb', bytes: 3 }) }; });
  const blob = new Blob([new Uint8Array([1, 2, 3])]);
  const ok = await s.__api.writeBlobToUserDir('model', 'm.glb', blob);
  assert.equal(ok, true, '应写入成功');
  assert.ok(captured && String(captured.url).includes('/api/media/save-to-dir'));
  assert.equal(captured.body.dir, 'D:/素材/模型', 'payload.dir 必须是设置的绝对路径');
  assert.ok(typeof captured.body.dataBase64 === 'string' && captured.body.dataBase64.length > 0, '应携带 dataBase64');
  assert.ok(!captured.body.url, 'blob 通道不应带 url');
});

await check('X5 恶意文件名（URL 编码穿越 + 超长 + 保留名）原样交后端，不本地崩溃、不本地拼接越界路径', async () => {
  const s = loadAll(); await tick();
  s.__api.dirPaths.archive = 'D:/素材/归档';
  const cases = ['..%2f..%2fevil.txt', 'L'.repeat(300) + '.txt', 'CON', '../../evil.txt'];
  for (const name of cases) {
    let captured = null;
    s.__state.setFetch(async (url, opts) => { captured = JSON.parse(opts.body); return { ok: true, status: 200, json: async () => ({ success: true, savedPath: 'D:/素材/归档/x', bytes: 1 }) }; });
    await s.__api.trySaveViaBackendDir({ type: 'archive' }, 'https://x.test/p/f.zip', name);
    assert.ok(captured, '应发出请求: ' + name);
    assert.equal(captured.dir, 'D:/素材/归档');
    assert.equal(captured.filename, name, '原始文件名交给后端（由后端清洗），实际=' + captured.filename);
    assert.equal(captured.dir, 'D:/素材/归档', '扩展侧不得把文件名拼进 dir（越界只能由后端清洗）');
  }
});

await check('X6 netdisk 复用 archive 的后端绝对路径（hasBackendDirFor 对 netdisk 生效）', async () => {
  const s = loadAll(); await tick();
  s.__api.dirPaths.archive = 'D:/素材/归档';
  s.__api.dirPaths.netdisk = null;
  // netdisk 无独立路径 → hasBackendDirFor(netdisk) 为 false（设计如此：各自独立）；这里断言不会误判为 archive
  assert.equal(s.__api.hasBackendDirFor('netdisk'), false, 'netdisk 未设置时应为 false');
  s.__api.dirPaths.netdisk = 'D:/素材/网盘';
  assert.equal(s.__api.hasBackendDirFor('netdisk'), true);
});

// ================================================================
// Y. Service Worker 网盘深解析通道（router.js）接入自定义绝对目录
// ------------------------------------------------------------------
// SW 读不到侧栏 dirPaths，但能读 chrome.storage.local 的 dirPath:<type>。
// 断言：有 dirPath:netdisk → 不得调用 chrome.downloads.download（走 save-to-dir）；
//       无 → 必须回退 chrome.downloads.download（默认 Ddayup/netdisk/）。
// ================================================================
function loadRouter({ storage = {}, fetchImpl }) {
  const downloads = []; const warns = [];
  const ctrl = {
    storage: { local: {
      get: (keys, cb) => { const out = {}; const list = Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : Object.keys(keys || {})); for (const k of list) if (Object.prototype.hasOwnProperty.call(storage, k)) out[k] = storage[k]; if (typeof cb === 'function') cb(out); return Promise.resolve(out); },
      set: async () => {}, remove: async () => {} } },
    downloads: {
      download: (opts, cb) => { downloads.push(opts); if (typeof cb === 'function') setImmediate(cb); return downloads.length; },
      onCreated: { addListener() {}, removeListener() {} }, onChanged: { addListener() {}, removeListener() {} } },
    runtime: { lastError: null, getURL: (p) => p, sendMessage: async () => ({ ok: false }) },
    tabs: { query: async () => [], get: async () => ({ id: 1 }), create: async () => ({ id: 1 }), remove: async () => {}, update: async () => {} },
    scripting: { executeScript: async () => [{ result: { clicked: false } }] },
  };
  function deepStub() { const fn = function () { return deepStub(); }; return new Proxy(fn, { get(t, k) {
    if (['addListener','removeListener'].includes(k)) return () => {};
    if (k === 'sendMessage') return async () => ({ ok: false });
    if (typeof k === 'symbol') return undefined; return deepStub(); }, apply() { return deepStub(); } }); }
  const sandbox = {
    console: { log() {}, info() {}, error() {}, warn: (...a) => warns.push(a.map(String).join(' ')) },
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, queueMicrotask,
    URL: globalThis.URL, fetch: fetchImpl, AbortSignal: globalThis.AbortSignal,
    chrome: new Proxy(ctrl, { get(t, k) { if (k in t) return t[k]; if (typeof k === 'symbol') return undefined; return deepStub(); } }),
    handleNetdiskResolve: async () => ({ ok: true, tree: [{ name: 'file.zip', fileId: 'f1', direct: 'https://tc.xunlei.com/file.zip', isDir: false }] }),
  };
  sandbox.globalThis = sandbox;
  const noop = function () { return undefined; };
  const proxy = new Proxy(sandbox, { has() { return true; }, get(t, k) { if (typeof k !== 'string') return t[k]; if (k === 'self') return proxy; if (k in t) return t[k]; if (k in globalThis) return globalThis[k]; return noop; }, set(t, k, v) { t[k] = v; return true; } });
  const ctx = vm.createContext(proxy);
  const src = read('shared/messages.js') + '\n' + read('router.js') + '\n' + 'globalThis.__HANDLERS = HANDLERS;';
  vm.runInContext(src, ctx);
  return { proxy, downloads, warns };
}

function invokeNetdisk(harness, msg) {
  return new Promise((resolve) => {
    let done = false;
    const sendResponse = (r) => { if (!done) { done = true; resolve(r); } };
    const fn = harness.proxy.__HANDLERS['HMDAO_NETDISK_DOWNLOAD'];
    assert.ok(typeof fn === 'function', 'router.js 应注册 HMDAO_NETDISK_DOWNLOAD handler');
    fn(msg, {}, sendResponse);
    setTimeout(() => { if (!done) resolve({ __timeout: true }); }, 4000);
  });
}
const NETDISK_MSG = { type: 'HMDAO_NETDISK_DOWNLOAD', url: 'https://pan.xunlei.com/s/abc', name: 'file.zip', fileId: 'f1' };

console.log('\n==== SW 网盘深解析通道（router.js）====');

await check('Y1 dirPath:netdisk 有值 → 走 save-to-dir，且【不】调用 chrome.downloads.download', async () => {
  const calls = [];
  const h = loadRouter({
    storage: { 'dirPath:netdisk': 'D:/素材/网盘' },
    fetchImpl: async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200, json: async () => ({ success: true, savedPath: 'D:/素材/网盘/file.zip', bytes: 10 }) }; },
  });
  const res = await invokeNetdisk(h, NETDISK_MSG);
  assert.ok(!res.__timeout, 'handler 应在超时前响应');
  assert.ok(calls.length === 1 && String(calls[0].url).includes('/api/media/save-to-dir'), '应调用后端 save-to-dir');
  assert.equal(calls[0].body.dir, 'D:/素材/网盘');
  assert.equal(calls[0].body.filename, 'file.zip');
  assert.equal(h.downloads.length, 0, '已写入用户目录后【不得】再 chrome.downloads.download');
});

await check('Y2 无 dirPath:netdisk/archive → 必须回退 chrome.downloads.download（Ddayup/netdisk/）', async () => {
  const h = loadRouter({
    storage: {},
    fetchImpl: async () => { throw new Error('不该调用后端'); },
  });
  const res = await invokeNetdisk(h, NETDISK_MSG);
  assert.ok(!res.__timeout, 'handler 应响应');
  assert.equal(h.downloads.length, 1, '无自定义目录时必须回退默认下载');
  assert.equal(h.downloads[0].filename, 'Ddayup/netdisk/file.zip', '默认落 Ddayup/netdisk/');
});

await check('Y3 dirPath:netdisk 有值但后端 500 → 回退 chrome.downloads.download，且 console.warn 明示原因', async () => {
  const h = loadRouter({
    storage: { 'dirPath:netdisk': 'D:/素材/网盘' },
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ success: false, error: '磁盘只读' }) }),
  });
  const res = await invokeNetdisk(h, NETDISK_MSG);
  assert.ok(!res.__timeout, 'handler 应响应');
  assert.equal(h.downloads.length, 1, '后端失败必须回退默认下载');
  assert.ok(h.warns.some((w) => w.includes('写入失败')), 'SW 须 console.warn 明示写入失败，实际=' + JSON.stringify(h.warns));
});

console.log('\n通过 ' + pass + ' / 失败 ' + fail);
if (failures.length) { console.log('失败项：\n - ' + failures.join('\n - ')); process.exit(1); }
console.log('✅ 全部通过');
process.exit(0);
