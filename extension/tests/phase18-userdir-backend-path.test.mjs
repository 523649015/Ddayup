// phase18-userdir-backend-path.test.mjs
// QA 回归（自定义保存路径 · 绝对路径 / 后端落盘通道）2026-09-12
// 背景：chrome.downloads.download 只能写「浏览器默认下载目录 + 相对子目录」，无法写任意绝对目录；
//       File System Access API 在 side panel 里不可靠（句柄常为 null）。
//       新增通道二：用户填【绝对路径】→ 交本地后端 127.0.0.1:3000 /api/media/save-to-dir 流式写盘。
// 本测试验证：
//   A. 后端路由 /api/media/save-to-dir：绝对路径校验、文件名防穿越、dataBase64/url 两种落盘、probe-dir。
//   B. 扩展 bulk-actions.js：dirPaths 持久化到 chrome.storage.local 键 dirPath:<type>，恢复 + UI 显示。
//   C. 扩展 .pathApply：非绝对路径被拒；合法绝对路径被保存并显示「✅ 已设置：<路径>」。
//   D. 下载优先级：设定绝对路径后 dlViaChrome 命中后端通道（return -1，不发 chrome.downloads）。
//   E. 后端不可用：不静默、明确回退（落默认下载 + 状态提示「本地服务未启动」）。
// 运行：node tests/phase18-userdir-backend-path.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '..');
const APP = path.resolve(HERE, '../../app');
const read = (f) => readFileSync(path.join(EXT, f), 'utf8');

setTimeout(() => { console.error('\n!! HARD TIMEOUT (40s) — 疑似 await 卡死'); process.exit(3); }, 40000).unref();

let pass = 0, fail = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); console.log('  ✓', name); pass++; }
  catch (e) { console.log('  ✗', name, '\n      →', e && e.message); fail++; failures.push(name + ' :: ' + (e && e.message)); }
}
function section(t) { console.log('\n===', t, '==='); }

// ================================================================
// A. 后端路由：/api/media/save-to-dir + /api/media/probe-dir
// ================================================================
async function loadMediaRoutes() {
  const mod = await import(pathToFileURL(path.join(APP, 'server/routes/media.mjs')).href);
  const routes = new Map();
  const router = {
    register(methods, p, handler) {
      for (const m of (Array.isArray(methods) ? methods : [methods])) routes.set(m + ' ' + p, handler);
    },
    registerPrefix() {},
  };
  const send = (res, status, payload) => { res.status = status; res.body = payload; res.ended = true; };
  const readJson = async (req) => (req && req.__body) || {};
  mod.registerMediaRoutes(router, {
    execFileAsync: async () => ({ stdout: '', stderr: '' }),
    handleCuratorPreviewProxy: async () => {},
    https: {},
    proxyHuggingFace: async () => {},
    proxyRemoteMediaAsset: async () => {},
    readJson,
    resolveLocalPostFfmpegBackend: () => ({ detectedPath: '' }),
    resolveYtDlpPath: () => '',
    runCommand: async () => ({ stdout: '' }),
    send,
    serveLocalModel: async () => {},
    serveTransformersModule: async () => {},
  });
  const invoke = async (method, p, body) => {
    const h = routes.get(method + ' ' + p);
    assert.ok(h, `路由 ${method} ${p} 未注册`);
    const res = {};
    // ★2026-09-13 F3 回归：save-to-dir / probe-dir 在环回（127.0.0.1）时跳过设备授权网关。
    // 真实 HTTP 请求来自本机时 req.socket.remoteAddress === '127.0.0.1'，isLoopback(req) 为真、gateEntitlement 被跳过。
    // 单测桩需模拟该环回请求，才能正确验证路由自身的「绝对路径校验 / 写盘 / 400」逻辑（否则被网关 402 短路）。
    await h({ method, __body: body, socket: { remoteAddress: '127.0.0.1' } }, res, new URL('http://127.0.0.1' + p));
    return res;
  };
  return { invoke };
}

async function runBackendTests() {
  const { invoke } = await loadMediaRoutes();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ddayup-dir-'));

  await check('A1 相对 dir → 400（必须是绝对路径）', async () => {
    const r = await invoke('POST', '/api/media/save-to-dir', { dir: '素材/图片', filename: 'a.bin', dataBase64: 'AAEC' });
    assert.equal(r.status, 400, '相对路径应被拒（400），实际=' + r.status);
  });

  await check('A2 dataBase64 分支：写入目标目录且字节正确', async () => {
    const bytes = Buffer.from([1, 2, 3, 4, 5]);
    const r = await invoke('POST', '/api/media/save-to-dir', {
      dir: tmp, filename: 'ok.bin', dataBase64: bytes.toString('base64'),
    });
    assert.equal(r.status, 200, '应成功');
    assert.equal(r.body.success, true);
    assert.equal(r.body.bytes, bytes.length);
    const onDisk = fs.readFileSync(r.body.savedPath);
    assert.ok(onDisk.equals(bytes), '落盘字节应一致');
    assert.ok(path.resolve(r.body.savedPath).startsWith(path.resolve(tmp)), 'savedPath 必须在 dir 内');
  });

  await check('A3 文件名防穿越：../../evil 被清洗，绝不写到 dir 之外', async () => {
    const r = await invoke('POST', '/api/media/save-to-dir', {
      dir: tmp, filename: '../../evil.txt', dataBase64: 'QQ==',
    });
    assert.equal(r.status, 200, '清洗后应成功（而非越界写入）');
    const sp = path.resolve(r.body.savedPath);
    assert.ok(sp.startsWith(path.resolve(tmp) + path.sep), 'savedPath 必须仍在 dir 内，实际=' + sp);
    assert.ok(!fs.existsSync(path.resolve(tmp, '../../evil.txt')), '不得在 dir 外生成文件');
    assert.ok(!/[\\/]/.test(path.basename(r.body.savedPath)), '文件名不得含分隔符');
  });

  await check('A4 url 分支：后端流式拉取并写盘（含 Referer）', async () => {
    const payload = Buffer.from('HELLO-STREAM-'.repeat(64));
    const srv = http.createServer((req, res) => { res.writeHead(200); res.end(payload); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    try {
      const r = await invoke('POST', '/api/media/save-to-dir', {
        dir: tmp, filename: 'stream.bin', url: `http://127.0.0.1:${port}/x`, referer: 'https://example.com/',
      });
      assert.equal(r.status, 200, '应成功，body=' + JSON.stringify(r.body));
      assert.equal(r.body.bytes, payload.length);
      assert.ok(fs.readFileSync(r.body.savedPath).equals(payload), '流式落盘内容应一致');
    } finally { srv.close(); }
  });

  await check('A5 非 http(s) url → 400', async () => {
    const r = await invoke('POST', '/api/media/save-to-dir', { dir: tmp, filename: 'x.bin', url: 'ftp://x/y' });
    assert.equal(r.status, 400);
  });

  await check('A6 缺少 url 与 dataBase64 → 400', async () => {
    const r = await invoke('POST', '/api/media/save-to-dir', { dir: tmp, filename: 'x.bin' });
    assert.equal(r.status, 400);
  });

  await check('A7 probe-dir：合法目录 ok:true 且清理探针文件', async () => {
    const sub = path.join(tmp, 'probe-sub');
    const r = await invoke('POST', '/api/media/probe-dir', { dir: sub });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true, '应可写');
    assert.ok(fs.existsSync(sub), '应递归建目录');
    const leftovers = fs.readdirSync(sub).filter((f) => f.startsWith('.ddayup-dir-test-'));
    assert.equal(leftovers.length, 0, '探针文件应被清理，实际=' + JSON.stringify(leftovers));
  });

  await check('A8 probe-dir：相对路径 → 400', async () => {
    const r = await invoke('POST', '/api/media/probe-dir', { dir: 'rel/dir' });
    assert.equal(r.status, 400);
  });

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}

// ================================================================
// B/C/D/E. 扩展侧：dirPaths 持久化 + .pathApply + 下载优先级
// ================================================================
function fakeEl(extra = {}) {
  return Object.assign({
    dataset: {}, style: {}, disabled: false, value: '',
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(...c) { c.forEach((x) => this._s.delete(x)); }, toggle() {}, contains(c) { return this._s.has(c); } },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {},
    setAttribute() {}, getAttribute() { return null; }, remove() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    _tc: '',
    set onclick(f) { this._onclick = f; }, get onclick() { return this._onclick; },
    set textContent(v) { this._tc = v; }, get textContent() { return this._tc; },
    set innerHTML(v) {}, get innerHTML() { return ''; },
  }, extra);
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
      tx.objectStore = function () {
        return {
          put(v, k) { store.set(k, v); const r = {}; setImmediate(() => { if (r.onsuccess) r.onsuccess({ target: { result: undefined } }); if (tx.oncomplete) tx.oncomplete(); }); return r; },
          get(k) { const r = { result: store.has(k) ? store.get(k) : null }; setImmediate(() => r.onsuccess && r.onsuccess({ target: { result: r.result } })); return r; },
          // ★与真实 IndexedDB 一致：delete 既触发 request.onsuccess 也触发 tx.oncomplete，
          // 否则 deleteTypeDirHandle（await tx.oncomplete）会永久挂起导致 HARD TIMEOUT。
          delete(k) { store.delete(k); const r = {}; setImmediate(() => { if (r.onsuccess) r.onsuccess({ target: { result: undefined } }); if (tx.oncomplete) tx.oncomplete(); }); return r; },
        };
      };
      return tx;
    },
        },
      };
      setImmediate(() => { req.onupgradeneeded && req.onupgradeneeded({ target: { result: req.result } }); req.onsuccess && req.onsuccess({ target: { result: req.result } }); });
      return req;
    },
  };
}

const PATH_TYPES = ['image', 'video', 'audio', 'model', 'archive', 'netdisk'];
const SUBS = { image: 'images', video: 'videos', audio: 'audio', model: 'models', archive: 'archives', netdisk: 'netdisk' };

function buildSandbox() {
  const idb = makeFakeIDB();
  const storageMap = new Map();
  const pathApplyButtons = PATH_TYPES.map((t) => fakeEl({ dataset: { type: t } }));
  const pathPickButtons = PATH_TYPES.map((t) => fakeEl({ dataset: { type: t } }));
  const pathClearButtons = PATH_TYPES.map((t) => fakeEl({ dataset: { type: t } }));
  const pathTestButtons = PATH_TYPES.map((t) => fakeEl({ dataset: { type: t } }));
  const pathInputs = {};
  PATH_TYPES.forEach((t) => { pathInputs[t] = fakeEl({ dataset: { type: t }, value: '' }); });
  const pathTexts = {};
  PATH_TYPES.forEach((t) => { pathTexts[t] = fakeEl({ textContent: `未设置 · 默认 Ddayup/${SUBS[t]}/` }); });

  const elById = {};
  const documentStub = {
    addEventListener() {}, removeEventListener() {},
    body: fakeEl(),
    getElementById(id) { if (!elById[id]) elById[id] = fakeEl(); return elById[id]; },
    createElement() { return fakeEl(); },
    querySelectorAll(sel) {
      if (sel === '.pathPick') return pathPickButtons;
      if (sel === '.pathClear') return pathClearButtons;
      if (sel === '.pathTest') return pathTestButtons;
      if (sel === '.pathApply') return pathApplyButtons;
      if (sel === '.pathInput') return PATH_TYPES.map((t) => pathInputs[t]);
      return [];
    },
    querySelector(sel) {
      let m = sel && sel.match(/^\.pathText\[data-type="(.+)"\]$/);
      if (m) return pathTexts[m[1]] || null;
      m = sel && sel.match(/^\.pathInput\[data-type="(.+)"\]$/);
      if (m) return pathInputs[m[1]] || null;
      return null;
    },
  };

  const ctrl = {
    _downloads: [],
    downloads: {
      download: async (o) => { ctrl._downloads.push(o); return ctrl._downloads.length; },
      onChanged: { addListener() {}, removeListener() {} },
      onDeterminingFilename: { addListener() {} },
    },
    storage: {
      local: {
        get: (keys, cb) => {
          const out = {};
          const list = Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : Object.keys(keys || {}));
          for (const k of list) if (storageMap.has(k)) out[k] = storageMap.get(k);
          if (typeof cb === 'function') cb(out);
        },
        set: (obj, cb) => { for (const k of Object.keys(obj || {})) storageMap.set(k, obj[k]); if (typeof cb === 'function') cb(); },
        remove: (k, cb) => { storageMap.delete(k); if (typeof cb === 'function') cb(); },
      },
      _map: storageMap,
    },
    tabs: { query: async () => [{}] },
    scripting: { executeScript: async () => [{}] },
    runtime: { sendMessage: async () => ({ ok: false }), lastError: null, onMessage: { addListener() {}, removeListener() {} }, onInstalled: { addListener() {} } },
  };

  const fetchCalls = [];
  let fetchImpl = async () => ({ ok: false, status: 0, json: async () => ({}) });

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

  const target = {
    console,
    setTimeout, clearTimeout, setImmediate, queueMicrotask,
    URL: globalThis.URL, Blob: globalThis.Blob, Promise, atob: globalThis.atob, btoa: globalThis.btoa,
    addEventListener() {}, removeEventListener() {}, postMessage() {}, dispatchEvent() { return false; },
    location: { href: 'sidepanel.html', hostname: 'localhost' },
    document: documentStub,
    indexedDB: idb,
    chrome: chromeStub,
    fetch: (url, opts) => { fetchCalls.push({ url, opts }); return fetchImpl(url, opts); },
    deriveFilename: (a) => (a && a.name) || (a && a.url ? a.url.split('/').pop() : 'file.bin'),
    deriveMediaReferer: (u, r) => r || '',
    sourceOrigin: () => '',
    apiBaseUrl: () => 'http://127.0.0.1:3000',
    getCloudApiBase: async () => 'http://127.0.0.1:3000',
    ensureBackendRunningNative: async () => ({ ok: false, nativeUnavailable: true }),
    startBackendViaNative: async () => ({ ok: false }),
    setStatus: (t) => { target.__lastStatus = String(t); },
    warnStatus: (t) => { target.__lastStatus = String(t); },
    pulseDownloadProgress: () => {},
    finishDownloadProgress: () => {},
    updateDownloadProgress: () => {},
    b64ToBytes: (s) => Uint8Array.from(Buffer.from(String(s || ''), 'base64')),
    HmdaoProgress: { registerTask: () => 1, bindDownloadId() {}, fail() {}, cancel() {}, complete() {} },
    typeLabel: (t) => t,
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
  proxy.__state = { pathApplyButtons, pathInputs, pathPickButtons, pathTexts, ctrl, storageMap, fetchCalls, elById, setFetch: (f) => { fetchImpl = f; } };
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
    'window.__api = { dlViaChrome, trySaveViaBackendDir, hasBackendDirFor, tryWriteUserDirFromUrl, dirPaths, saveDirPath, deleteDirPath, restoreDirPaths, refreshPathTexts };';
  vm.runInContext(src, ctx);
  return sandbox;
}

async function runExtensionTests() {
  await check('B1 saveDirPath 持久化到 chrome.storage.local 的 dirPath:<type>', async () => {
    const s = loadAll();
    await s.__api.saveDirPath('image', 'D:\\素材\\图片');
    assert.equal(s.__api.dirPaths.image, 'D:\\素材\\图片', '内存 dirPaths 应更新');
    assert.equal(s.__state.storageMap.get('dirPath:image'), 'D:\\素材\\图片', 'storage 应写入 dirPath:image');
  });

  await check('B2 restoreDirPaths 从 storage 恢复并刷新 UI 文案「✅ 已设置：<路径>」', async () => {
    const s = loadAll();
    s.__state.storageMap.set('dirPath:video', 'E:\\videos');
    await s.__api.restoreDirPaths();
    s.__api.refreshPathTexts();
    assert.equal(s.__api.dirPaths.video, 'E:\\videos');
    const txt = String(s.__state.pathTexts.video.textContent);
    assert.ok(txt.includes('已设置') && txt.includes('E:\\videos'), 'UI 应显示已设置路径，实际=' + txt);
  });

  await check('B3 deleteDirPath 清内存与 storage', async () => {
    const s = loadAll();
    await s.__api.saveDirPath('audio', 'F:\\a');
    await s.__api.deleteDirPath('audio');
    assert.equal(s.__api.dirPaths.audio, null);
    assert.ok(!s.__state.storageMap.has('dirPath:audio'));
  });

  await check('C0 sidepanel.html / bulk-actions.js 已移除手动「绝对路径输入框 / 应用」（pathInput/pathApply）', async () => {
    // ★2026-09-13 行为变更：用户诉求「去掉绝对路径手动输入填写功能，保留用户分类选择路径」。
    const html = read('sidepanel.html');
    assert.ok(!html.includes('pathInput'), 'HTML 不应再含 pathInput');
    assert.ok(!html.includes('pathApply'), 'HTML 不应再含 pathApply');
    const js = read('bulk-actions.js');
    assert.ok(!js.includes('.pathApply'), 'bulk-actions.js 不应再绑定 .pathApply');
    assert.ok(!js.includes('.pathInput'), 'bulk-actions.js 不应再引用 .pathInput');
    assert.ok(js.includes('/api/settings/assets/pick-directory'), '选择目录应改调后端原生目录选择器');
  });

  await check('C1 .pathPick 后端原生选择器返回绝对路径 → 保存 dirPath:<type> + 显示「✅ 已设置：<路径>」', async () => {
    const s = loadAll();
    await new Promise((r) => setImmediate(r));
    s.__state.setFetch(async (url) => {
      assert.ok(String(url).includes('/api/settings/assets/pick-directory'), '应调用后端原生目录选择器，实际=' + url);
      return { ok: true, status: 200, json: async () => ({ success: true, canceled: false, path: 'D:\\素材\\图片' }) };
    });
    const btn = s.__state.pathPickButtons.find((b) => b.dataset.type === 'image');
    await btn.onclick();
    assert.equal(s.__api.dirPaths.image, 'D:\\素材\\图片', '应保存后端返回的绝对路径');
    assert.equal(s.__state.storageMap.get('dirPath:image'), 'D:\\素材\\图片', 'storage 应写入 dirPath:image');
    const txt = String(s.__state.pathTexts.image.textContent);
    assert.ok(txt.includes('已设置') && txt.includes('D:\\素材\\图片'), 'UI 应显示已设置路径，实际=' + txt);
  });

  await check('C2 .pathPick 用户取消（canceled）→ 不写 storage，UI 回到默认基线', async () => {
    const s = loadAll();
    await new Promise((r) => setImmediate(r));
    s.__state.setFetch(async () => ({ ok: true, status: 200, json: async () => ({ success: true, canceled: true, path: '' }) }));
    const btn = s.__state.pathPickButtons.find((b) => b.dataset.type === 'video');
    await btn.onclick();
    assert.equal(s.__api.dirPaths.video, null, '取消不得保存路径');
    assert.ok(!s.__state.storageMap.has('dirPath:video'), '取消不得写 storage');
    const txt = String(s.__state.pathTexts.video.textContent);
    assert.ok(txt.includes('默认 Ddayup/videos/'), '取消后应回到默认基线，实际=' + txt);
  });

  await check('D1 设绝对路径 → dlViaChrome 走后端 save-to-dir（return -1，不发 chrome.downloads）', async () => {
    const s = loadAll();
    await new Promise((r) => setImmediate(r)); // 等 __dirRestorePromise
    s.__api.dirPaths.image = 'D:\\素材\\图片';
    s.__state.setFetch(async (url) => {
      assert.ok(String(url).includes('/api/media/save-to-dir'), '应调用后端 save-to-dir，实际=' + url);
      return { ok: true, status: 200, json: async () => ({ success: true, savedPath: 'D:\\素材\\图片\\a.jpg', bytes: 4 }) };
    });
    const asset = { type: 'image', url: 'https://x.test/p/a.jpg', name: 'a.jpg' };
    const res = await s.__api.dlViaChrome({ url: asset.url, filename: 'Ddayup/images/a.jpg', asset, saveAs: false, conflictAction: 'uniquify' });
    assert.equal(res, -1, '后端写入成功应返回 -1（跳过默认下载）');
    assert.equal(s.__state.ctrl._downloads.length, 0, '不得再发起 chrome.downloads');
  });

  await check('D2 后端不可用 → 明确提示「本地服务未启动」并回退默认下载（不静默）', async () => {
    const s = loadAll();
    await new Promise((r) => setImmediate(r));
    s.__api.dirPaths.video = 'D:\\素材\\视频';
    s.__state.setFetch(async () => { throw new Error('Failed to fetch'); });
    const asset = { type: 'video', url: 'https://x.test/p/v.mp4', name: 'v.mp4' };
    const res = await s.__api.dlViaChrome({ url: asset.url, filename: 'Ddayup/videos/v.mp4', asset, saveAs: false, conflictAction: 'uniquify' });
    assert.notEqual(res, -1, '后端失败不得返回 -1');
    assert.equal(s.__state.ctrl._downloads.length, 1, '应回退发起 chrome.downloads（不阻塞）');
    const st = String((s.__state.elById.status && s.__state.elById.status.textContent) || '');
    assert.ok(st.includes('未存入') && st.includes('本地服务未启动'),
      '状态应明确提示本地服务未启动，实际=' + st);
  });

  await check('D3 未设绝对路径且无句柄 → 走默认下载（filename 不变）', async () => {
    const s = loadAll();
    await new Promise((r) => setImmediate(r));
    s.__api.dirPaths.image = null;
    const asset = { type: 'image', url: 'https://x.test/p/b.jpg', name: 'b.jpg' };
    await s.__api.dlViaChrome({ url: asset.url, filename: 'Ddayup/images/b.jpg', asset, saveAs: false, conflictAction: 'uniquify' });
    assert.equal(s.__state.ctrl._downloads.length, 1);
    assert.equal(s.__state.ctrl._downloads[0].filename, 'Ddayup/images/b.jpg');
  });
}

console.log('\n==== phase18-userdir-backend-path 总结 ====');
await runBackendTests();
await runExtensionTests();
console.log('\n通过 ' + pass + ' / 失败 ' + fail);
if (failures.length) { console.log('失败项：\n - ' + failures.join('\n - ')); process.exit(1); }
console.log('✅ 全部通过');
process.exit(0);
