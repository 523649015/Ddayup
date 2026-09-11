// phase13-imini-cover-regression.test.mjs
// QA（严过关）2026-09-11 独立回归：imini 视频卡「悬停不抽帧 + 绿底红禁占位图」修复。
// ★本文件【不复刻】逻辑，而是把 4 个改动文件里的【真实源码片段】抽出来在最小 DOM 桩上跑，
//   以证明"代码真的能工作"，而不是"代码看起来存在"。
// 运行：node tests/phase13-imini-cover-regression.test.mjs
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

// ---------------------------------------------------------------- 源码抽取工具
// 按函数名抽取完整函数源码（大括号配平；配平结果用 vm.Script 编译校验）
function extractFn(src, name) {
  const head = 'function ' + name + '(';
  let idx = src.indexOf(head);
  if (idx < 0) throw new Error('未找到函数: ' + name);
  if (/async\s+$/.test(src.slice(Math.max(0, idx - 8), idx))) idx -= 6; // 保留 async 前缀
  let i = src.indexOf('{', idx);
  let depth = 0, j = i;
  for (; j < src.length; j++) {
    const ch = src[j];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) break; }
  }
  const out = src.slice(idx, j + 1);
  try { new vm.Script('(function(){' + out + '})'); } catch (e) { throw new Error('抽取 ' + name + ' 括号不配平: ' + e.message); }
  return out;
}
// 编译一段源码到带桩的 vm 上下文，返回上下文里的导出对象
function runInSandbox(code, sandbox, exportExpr) {
  const ctx = vm.createContext({ ...sandbox });
  vm.runInContext(code, ctx);
  return vm.runInContext(exportExpr, ctx);
}

const mediaFetchSrc = read('media-fetch.js');
const scanSrc = read('scan.js');
const sidepanelSrc = read('sidepanel.js');
const cardRenderSrc = read('card-render.js');

const noopConsole = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
const bytesOf = (n, fill = 7) => new Uint8Array(n).fill(fill);
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

// 把真实 media-fetch.js 整体加载进一个 vm 上下文（与浏览器端同为「经典脚本 + 全局作用域」）
function makeMediaFetchCtx(opts = {}) {
  const sent = [];
  let n = 0;
  const FakeURL = function U(u, b) { return new globalThis.URL(u, b); };
  FakeURL.createObjectURL = () => 'blob:fake/' + (++n);
  FakeURL.revokeObjectURL = () => {};
  const sandbox = {
    console: noopConsole,
    URL: FakeURL,
    Blob: globalThis.Blob,
    b64ToBytes: (s) => Uint8Array.from(Buffer.from(String(s || ''), 'base64')),
    window: { __sourcePageUrl: 'https://imini.ai/zh/video', __hmdao_sourceTabId: 7 },
    chrome: {
      runtime: {
        sendMessage: async (msg) => {
          sent.push(msg);
          if (typeof opts.respond === 'function') return opts.respond(msg);
          return { ok: false, status: 0 };
        },
      },
    },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(
    mediaFetchSrc
    + '\n;globalThis.__api = { hmdaoCoverHash, hmdaoNoteCoverBytes, isPlaceholderCover,'
    + ' fetchMediaViaBackground, loadImageViaRelay, sniffBytesKind, __thumbCache,'
    + ' PLACEHOLDER_SET, PLACEHOLDER_HASH_URLS, PLACEHOLDER_MIN_URLS, PLACEHOLDER_HASH_CAP,'
    + ' PAGE_FETCH_PAIRS, PAGE_FETCH_BREAKER, PAGE_FETCH_BREAKER_MS };',
    ctx,
  );
  const api = ctx.__api;
  api.sent = sent;
  api.window = sandbox.window;
  return api;
}

// ================================================================
section('A. media-fetch.js 占位图自学习（真实源码）');
{
  const api = makeMediaFetchCtx();
  await check('A0 真实源码导出 hmdaoNoteCoverBytes / isPlaceholderCover，且挂到 window', () => {
    assert.equal(typeof api.hmdaoNoteCoverBytes, 'function');
    assert.equal(typeof api.isPlaceholderCover, 'function');
    assert.equal(typeof api.window.__hmdaoIsPlaceholderCover, 'function', 'card-render 依赖该钩子');
    assert.equal(api.PLACEHOLDER_MIN_URLS, 3);
    assert.equal(api.PLACEHOLDER_HASH_CAP, 300);
  });

  await check('A1 同一字节内容喂 3 个不同 URL → 第 3 个起判为占位图', () => {
    const ph = bytesOf(9000, 0x41); // 9KB：> 旧 6KB 阈值（旧逻辑必然漏判）
    assert.equal(api.hmdaoNoteCoverBytes('https://static.iminicdn.com/c/1.jpg', ph), false, '第1个不应判死');
    assert.equal(api.hmdaoNoteCoverBytes('https://static.iminicdn.com/c/2.jpg', ph), false, '第2个不应判死');
    assert.equal(api.hmdaoNoteCoverBytes('https://static.iminicdn.com/c/3.jpg', ph), true, '第3个必须判死');
    assert.equal(api.isPlaceholderCover('https://static.iminicdn.com/c/3.jpg'), true);
  });

  await check('A1b 达阈值后【追溯】把此前已放行的同款 URL 一起判死', () => {
    assert.equal(api.isPlaceholderCover('https://static.iminicdn.com/c/1.jpg'), true, '第1个应被追溯判死');
    assert.equal(api.isPlaceholderCover('https://static.iminicdn.com/c/2.jpg'), true, '第2个应被追溯判死');
  });

  await check('A2 不同字节（真实不同图）不误杀', () => {
    const api2 = makeMediaFetchCtx();
    for (let i = 0; i < 6; i++) {
      const img = new Uint8Array(5000 + i);
      for (let k = 0; k < img.length; k++) img[k] = (k * (i + 3)) & 0xff;
      assert.equal(api2.hmdaoNoteCoverBytes('https://static.iminicdn.com/real/' + i + '.jpg', img), false, '第' + (i + 1) + '张真图被误判');
    }
    for (let i = 0; i < 6; i++) {
      assert.equal(api2.isPlaceholderCover('https://static.iminicdn.com/real/' + i + '.jpg'), false);
    }
    assert.equal(api2.PLACEHOLDER_SET.size, 0);
  });

  await check('A3 判死后【新 URL】命中同 hash 立即返回 true（不必再凑 3 个）', () => {
    const api3 = makeMediaFetchCtx();
    const ph = bytesOf(9000, 0x41);
    api3.hmdaoNoteCoverBytes('https://x/1.jpg', ph);
    api3.hmdaoNoteCoverBytes('https://x/2.jpg', ph);
    api3.hmdaoNoteCoverBytes('https://x/3.jpg', ph);
    assert.equal(api3.isPlaceholderCover('https://x/99.jpg'), false, '未登记过的新 URL 不应是占位图');
    assert.equal(api3.hmdaoNoteCoverBytes('https://x/99.jpg', ph), true, '同 hash 新 URL 应被立即判死');
    assert.equal(api3.isPlaceholderCover('https://x/99.jpg'), true);
  });

  await check('A4 容量上限 300 不崩、不无限增长', () => {
    const api4 = makeMediaFetchCtx();
    for (let n = 1; n <= 320; n++) {
      assert.doesNotThrow(() => api4.hmdaoNoteCoverBytes('https://x/same.jpg', bytesOf(n, 0x5a)));
    }
    assert.equal(api4.PLACEHOLDER_HASH_URLS.size, 300, '登记表应被封顶在 300');
    assert.equal(api4.hmdaoNoteCoverBytes('https://x/same.jpg', bytesOf(999, 0x5a)), false, '超限后不再登记（不崩、返回 false）');
  });

  await check('A5 空参数 / 异常输入安全（不抛、不误判）', () => {
    const api5 = makeMediaFetchCtx();
    assert.equal(api5.hmdaoNoteCoverBytes('', bytesOf(10)), false);
    assert.equal(api5.hmdaoNoteCoverBytes('https://x/a.jpg', null), false);
    assert.equal(api5.hmdaoNoteCoverBytes('https://x/a.jpg', new Uint8Array(0)), false);
    assert.equal(api5.isPlaceholderCover(''), false);
    assert.equal(api5.isPlaceholderCover(undefined), false);
    assert.equal(api5.hmdaoCoverHash(null), '');
  });

  await check('A6 hmdaoCoverHash：同内容稳定 / 异内容不同 / 长度并入 key', () => {
    const api6 = makeMediaFetchCtx();
    const a = bytesOf(100, 1), b = bytesOf(100, 1), c = bytesOf(100, 2);
    assert.equal(api6.hmdaoCoverHash(a), api6.hmdaoCoverHash(b));
    assert.notEqual(api6.hmdaoCoverHash(a), api6.hmdaoCoverHash(c));
    assert.notEqual(api6.hmdaoCoverHash(bytesOf(100, 1)), api6.hmdaoCoverHash(bytesOf(101, 1)), '长度必须并进 key');
    assert.match(api6.hmdaoCoverHash(a), /^f[0-9a-z]+n100$/);
  });

  await check('A7 （已知边界，非回归）>64KB 且等长的两图只会碰撞 —— 设计取舍记录', () => {
    const api7 = makeMediaFetchCtx();
    const a = new Uint8Array(70000).fill(1);   // 只取前 64KB 参与哈希
    const b = new Uint8Array(70000).fill(1);
    b[69999] = 2;                              // 差异落在 64KB 之后
    assert.equal(api7.hmdaoCoverHash(a), api7.hmdaoCoverHash(b), '记录：64KB 之后才有差异的等长两图会被判为同一张');
  });
}

  // ★2026-09-11 工程师返工（QA P1）：登记键已改为 origin+pathname 归一化，
  //   本例由「缺陷留证」改为「修复断言」——同一张真封面换 N 次签名都不得判死。
  await check('A8 ★[P1 已修] 同一张真封面被带不同签名 query 反复取 4 次 → 永不判死', () => {
    const api8 = makeMediaFetchCtx();
    const real = bytesOf(20000, 0x7e);
    const u = (sig) => 'https://p3-sign.douyinpic.com/tos-cn-i-abc/cover.jpeg?x-expires=1790000000&x-signature=' + sig;
    assert.equal(api8.hmdaoNoteCoverBytes(u('sig1'), real), false);
    assert.equal(api8.hmdaoNoteCoverBytes(u('sig2'), real), false);
    assert.equal(api8.hmdaoNoteCoverBytes(u('sig3'), real), false, '★换签名只记 1 个归一化键 → 永不达阈值');
    assert.equal(api8.hmdaoNoteCoverBytes(u('sig4'), real), false, '★新签名同样不得判死');
    assert.equal(api8.PLACEHOLDER_SET.size, 0, '真封面一个都没进黑名单');
    assert.equal(api8.isPlaceholderCover(u('sig9')), false);
  });

  await check('A8b ★[P1 修复不得削弱 imini] 不同 pathname 仍能凑满阈值', () => {
    const api8b = makeMediaFetchCtx();
    const ph = bytesOf(9000, 0x41);
    // 同一张占位图被 3 个【不同 pathname】的 URL 返回（带不同 query 也不影响）→ 仍应判死
    const im = (n) => 'https://file.iminicdn.com/file/2026/06/04/p' + n + '.jpg?token=' + n;
    assert.equal(api8b.hmdaoNoteCoverBytes(im(1), ph), false);
    assert.equal(api8b.hmdaoNoteCoverBytes(im(2), ph), false);
    assert.equal(api8b.hmdaoNoteCoverBytes(im(3), ph), true, '★不同 pathname 仍凑满阈值（imini 场景不受影响）');
    assert.equal(api8b.isPlaceholderCover(im(1)), true, '追溯判死');
    // 且判死后换签名仍认得出来
    assert.equal(api8b.isPlaceholderCover('https://file.iminicdn.com/file/2026/06/04/p3.jpg?token=zzz'), true);
  });

  await check('A9 ★[缺陷 P1] 期望：登记键应按 origin+pathname 归一化（去掉 query），真封面不应被误判', () => {
    const api9 = makeMediaFetchCtx();
    const real = bytesOf(20000, 0x7e);
    const u = (sig) => 'https://p3-sign.douyinpic.com/tos-cn-i-abc/cover.jpeg?x-expires=1790000000&x-signature=' + sig;
    api9.hmdaoNoteCoverBytes(u('sig1'), real);
    api9.hmdaoNoteCoverBytes(u('sig2'), real);
    api9.hmdaoNoteCoverBytes(u('sig3'), real);
    assert.equal(api9.PLACEHOLDER_SET.size, 0, '★修复建议：登记键去掉 query（与 coverCacheKey 一致）后应永不达阈值');
  });

// ================================================================
section('B. media-fetch.js fetchMediaViaBackground 三参透传（真实源码）');
{
  const api = makeMediaFetchCtx({ respond: () => ({ ok: true, b64: b64(bytesOf(1234, 3)), mime: 'image/jpeg' }) });

  await api.fetchMediaViaBackground('https://file.iminicdn.com/v/1.mp4', 'https://imini.ai/', { maxBytes: 2 * 1024 * 1024 });
  await check('B1 三参（带 maxBytes）正常透传', () => {
    assert.equal(api.sent[0].type, 'HMDAO_FETCH_MEDIA');
    assert.equal(api.sent[0].maxBytes, 2 * 1024 * 1024, 'maxBytes 必须透传');
    assert.equal(api.sent[0].referer, 'https://imini.ai/');
  });

  await api.fetchMediaViaBackground('https://file.iminicdn.com/v/2.mp4', 'https://imini.ai/');
  await check('B2 两参旧调用行为不变（不传 maxBytes）', () => {
    const m = api.sent[1];
    assert.equal(m.maxBytes, undefined, '两参调用不得出现 maxBytes 字段');
    assert.deepEqual(Object.keys(m).sort(), ['credentials', 'referer', 'type', 'url'], 'payload 字段集合应与旧版一致');
  });

  api.sent.length = 0;
  await api.fetchMediaViaBackground('https://x/a.mp4', 'r', { maxBytes: 0 });
  await api.fetchMediaViaBackground('https://x/a.mp4', 'r', { maxBytes: -5 });
  await api.fetchMediaViaBackground('https://x/a.mp4', 'r', { maxBytes: 'abc' });
  await api.fetchMediaViaBackground('https://x/a.mp4', 'r', null);
  await api.fetchMediaViaBackground('https://x/a.mp4', 'r');
  await check('B3 非法 / 非正整数 maxBytes 一律不透传', () => {
    assert.equal(api.sent.length, 5, '应发出 5 次请求');
    for (const m of api.sent) assert.equal(m.maxBytes, undefined, '非法 maxBytes 不得透传，实际=' + m.maxBytes);
  });

  const r4 = await api.fetchMediaViaBackground('doubao-ws-audio://ts/1', 'r');
  await check('B4 伪协议（doubao-ws-audio://）不进 fetch、不报错', () => {
    // 跨 realm 对象不能用 deepEqual（原型不同），逐字段比
    assert.equal(r4 && r4.ok, false);
    assert.equal(r4 && r4.error, 'unsupported-scheme');
    assert.ok(!api.sent.some((m) => String(m.url).startsWith('doubao-ws-audio')), '伪协议不得进入 sendMessage');
  });

  api.sent.length = 0;
  await api.fetchMediaViaBackground('https://v3.douyinvod.com/x.mp4', 'r');
  await api.fetchMediaViaBackground('https://cdn.bilivideo.com/x.m4s', 'r');
  await check('B5 字节系 omit / B站不传（既有行为未被破坏）', () => {
    assert.equal(api.sent[0].credentials, 'omit', '抖音系应 omit');
    assert.equal(api.sent[1].credentials, undefined, 'B站应保持不传（沿用 include）');
  });
}

// ================================================================
section('C. loadImageViaRelay：写缓存【之前】的拦截（真实源码）');
{
  const PH = bytesOf(9000, 0x41); // 统一占位图（9KB）
  const api = makeMediaFetchCtx({ respond: () => ({ ok: true, b64: b64(PH), mime: 'image/jpeg', status: 200 }) });

  const u1 = await api.loadImageViaRelay('https://static.iminicdn.com/c/1.jpg', 'https://imini.ai/zh/video');
  const u2 = await api.loadImageViaRelay('https://static.iminicdn.com/c/2.jpg', 'https://imini.ai/zh/video');
  const u3 = await api.loadImageViaRelay('https://static.iminicdn.com/c/3.jpg', 'https://imini.ai/zh/video');
  await check('C1 第 3 次同图 → 返回 null，且【追溯撤销】已缓存 blob（不写双缓存）', () => {
    assert.ok(u1 && u1.startsWith('blob:'), '第1次应返回 blob');
    assert.ok(u2 && u2.startsWith('blob:'), '第2次应返回 blob');
    assert.equal(u3, null, '第3次识别为占位图 → 必须返回 null');
    assert.equal(api.__thumbCache.has('https://static.iminicdn.com/c/3.jpg'), false, '占位图不得写 __thumbCache');
    assert.equal(api.__thumbCache.has('https://static.iminicdn.com/c/1.jpg'), false, '★已缓存的旧占位图必须被追溯撤销');
    assert.equal(api.__thumbCache.has('https://static.iminicdn.com/c/2.jpg'), false, '★已缓存的旧占位图必须被追溯撤销');
    assert.equal(api.__thumbCache.size, 0);
  });

  api.sent.length = 0;
  const u4 = await api.loadImageViaRelay('https://static.iminicdn.com/c/1.jpg', 'https://imini.ai/');
  await check('C2 已判死的 URL 不再发任何网络请求（零 SW 占用）', () => {
    assert.equal(u4, null);
    assert.equal(api.sent.length, 0, '判死后不得再发 sendMessage，实际发出 ' + api.sent.length + ' 次');
  });

  const api2 = makeMediaFetchCtx({
    respond: (m) => {
      // ★注意：三张真图的 URL 必须【长度不同】，否则桩数据会生成同一份字节（那就真的是同图了）
      const n = 5000 + String(m.url).length * 37;
      const b = new Uint8Array(n);
      for (let i = 0; i < n; i++) b[i] = (i * 7 + String(m.url).length) & 0xff;
      return { ok: true, b64: b64(b), mime: 'image/jpeg', status: 200 };
    },
  });
  const g1 = await api2.loadImageViaRelay('https://static.iminicdn.com/real/a.jpg', 'https://imini.ai/');
  const g2 = await api2.loadImageViaRelay('https://static.iminicdn.com/real/bbbb.jpg', 'https://imini.ai/');
  const g3 = await api2.loadImageViaRelay('https://static.iminicdn.com/real/cc.jpg?x=1', 'https://imini.ai/');
  await check('C3 真实不同的封面图不被拦截，且正常写入 __thumbCache', () => {
    assert.ok(g1 && g1.startsWith('blob:'));
    assert.ok(g2 && g2.startsWith('blob:'));
    assert.ok(g3 && g3.startsWith('blob:'), '3 张不同的真图不得被误判为占位图');
    assert.equal(api2.__thumbCache.size, 3);
    assert.equal(api2.PLACEHOLDER_SET.size, 0);
  });

  api2.sent.length = 0;
  const g1b = await api2.loadImageViaRelay('https://static.iminicdn.com/real/a.jpg', 'https://imini.ai/');
  await check('C4 命中缓存时不再重复 fetch（既有去重未被破坏）', () => {
    assert.equal(g1b, g1);
    assert.equal(api2.sent.length, 0, '缓存命中不应再发请求');
  });

  const api3 = makeMediaFetchCtx({ respond: () => ({ ok: true, b64: b64(PH), mime: 'image/jpeg', status: 200 }) });
  await api3.loadImageViaRelay('https://static.iminicdn.com/p/1.jpg', 'https://imini.ai/zh/video');
  await api3.loadImageViaRelay('https://static.iminicdn.com/p/2.jpg', 'https://imini.ai/zh/video');
  api3.sent.length = 0;
  await api3.loadImageViaRelay('https://static.iminicdn.com/p/3.jpg', 'https://imini.ai/zh/video');
  // ★2026-09-11 工程师返工（QA P2 二选一 · 选"改实现"）：命中占位图后改为【只置位不 return】，
  //   让流程走到 needCookieRetry 的并集条件③，源页会话 Cookie 重试真正发生。
  await check('C5 ★[P2 已修] 占位图命中后仍会尝试第二层源页 Cookie 重试', () => {
    const inTab = api3.sent.filter((m) => m.type === 'HMDAO_FETCH_MEDIA_IN_TAB');
    assert.equal(inTab.length, 1, '★修复后：占位图命中不再直接 return，第二层源页 Cookie 重试确实发生 1 次');
    assert.equal(inTab[0].usePageCookie, true, '第二层必须带 usePageCookie');
  });
}

// ================================================================
section('D. scan.js extractVideoCovers：pairs 抽取（真实源码）');
{
  const extractSrc = extractFn(scanSrc, 'extractVideoCovers');

  function runCovers({ scripts = [], videos = [], imgs = [], href = 'https://imini.ai/zh/video' }) {
    return runInSandbox(
      extractSrc + '\n;globalThis.__r = extractVideoCovers;',
      {
        console: noopConsole,
        window: {},
        location: { href, hostname: new URL(href).hostname },
        getComputedStyle: () => ({ backgroundImage: '' }),
        URL: globalThis.URL,
        document: {
          querySelectorAll(sel) {
            if (sel === 'video') return videos;
            if (sel === 'img') return imgs;
            if (sel === 'script:not([src])' || sel === 'script') return scripts;
            return [];
          },
          querySelector() { return null; },
        },
      },
      'globalThis.__r()',
    );
  }
  const script = (t) => ({ textContent: t });
  const video = (o) => ({
    getAttribute: (n) => (n === 'poster' ? (o.poster || null) : null),
    poster: o.poster || '',
    dataset: o.dataset || {},
    currentSrc: o.currentSrc || '',
    src: o.src || '',
  });

  await check('D0 抽取到的确实是 scan.js 里的真实函数体（含 4.5 段）', () => {
    assert.ok(/4\.5\) ★2026-09-11/.test(extractSrc), '必须包含本次新增的 4.5) 段');
    assert.ok(/COVER_FIELD_RE/.test(extractSrc));
    assert.ok(/const pairs = \{\}/.test(extractSrc));
  });

  await check('D1 ① 内联严格 JSON（__NEXT_DATA__ 风格）：mp4 与 cover 同对象成对 → 命中', () => {
    const data = {
      props: {
        pageProps: {
          list: [
            { videoUrl: 'https://file.iminicdn.com/v/1.mp4', coverUrl: 'https://static.iminicdn.com/c/1.jpg' },
            { videoUrl: 'https://file.iminicdn.com/v/2.mp4', coverUrl: 'https://static.iminicdn.com/c/2.jpg' },
          ],
        },
      },
    };
    const r = runCovers({ scripts: [script(JSON.stringify(data))] });
    assert.equal(r.pairs['https://file.iminicdn.com/v/1.mp4'], 'https://static.iminicdn.com/c/1.jpg');
    assert.equal(r.pairs['https://file.iminicdn.com/v/2.mp4'], 'https://static.iminicdn.com/c/2.jpg');
    assert.equal(Object.keys(r.pairs).length, 2, '不得串号');
  });

  await check('D2 ② RSC 转义串（\\" + \\/）：还原后命中真封面', () => {
    const rsc = 'self.__next_f.push([1,"{\\"videoUrl\\":\\"https:\\/\\/file.iminicdn.com\\/v\\/r1.mp4\\",\\"cover\\":\\"https:\\/\\/static.iminicdn.com\\/c\\/r1.jpg\\"}"])';
    assert.ok(rsc.includes('\\"') && rsc.includes('\\/'), '桩数据必须真的含转义');
    const r = runCovers({ scripts: [script(rsc)] });
    assert.equal(r.pairs['https://file.iminicdn.com/v/r1.mp4'], 'https://static.iminicdn.com/c/r1.jpg');
  });

  await check('D2b ② RSC 另一种转义（\\\\/）：同样还原命中', () => {
    const rsc2 = 'self.__next_f.push([1,"{\\"videoUrl\\":\\"https:\\\\/\\\\/file.iminicdn.com\\\\/v\\\\/r2.mp4\\",\\"cover\\":\\"https:\\\\/\\\\/static.iminicdn.com\\\\/c\\\\/r2.jpg\\"}"])';
    const r = runCovers({ scripts: [script(rsc2)] });
    assert.equal(r.pairs['https://file.iminicdn.com/v/r2.mp4'], 'https://static.iminicdn.com/c/r2.jpg');
  });

  await check('D3 ② 非严格 JSON 的 ±800 邻近窗口也能命中', () => {
    const pad = 'x'.repeat(300);
    const txt = 'var boot = ' + pad + '{"videoUrl":"https://file.iminicdn.com/v/n1.mp4","cover":"https://static.iminicdn.com/c/n1.jpg"}' + pad;
    const r = runCovers({ scripts: [script(txt)] });
    assert.equal(r.pairs['https://file.iminicdn.com/v/n1.mp4'], 'https://static.iminicdn.com/c/n1.jpg');
  });

  await check('D4 ① <video poster>：与 src / currentSrc 成对 → 命中', () => {
    const r = runCovers({
      videos: [video({ poster: 'https://static.iminicdn.com/c/p1.jpg', currentSrc: 'https://file.iminicdn.com/v/p1.mp4', src: 'https://file.iminicdn.com/v/p1.mp4' })],
    });
    assert.equal(r.pairs['https://file.iminicdn.com/v/p1.mp4'], 'https://static.iminicdn.com/c/p1.jpg');
  });

  await check('D5 ★[缺陷] 半截串 "https:" 必须被丢弃（不得写进 pairs）', () => {
    const txt = 'boot({"videoUrl":"https://file.iminicdn.com/v/t1.mp4","cover":"https:"}';
    const r = runCovers({ scripts: [script(txt)] });
    assert.equal(Object.keys(r.pairs).length, 0, '★半截 URL 必须丢弃，实际 pairs=' + JSON.stringify(r.pairs));
  });

  await check('D5b pairs 里只允许绝对 http(s) 地址（非相对路径原样）', () => {
    const txt = 'boot({"videoUrl":"https://file.iminicdn.com/v/t2.mp4","cover":"/img/a.jpg"}';
    const r = runCovers({ scripts: [script(txt)] });
    const v = r.pairs['https://file.iminicdn.com/v/t2.mp4'];
    assert.ok(!v || v.startsWith('http'), 'pairs 里只允许绝对地址，实际=' + v);
  });

  await check('D6 非真视频直链（无视频后缀）→ 不成对', () => {
    const r = runCovers({
      scripts: [script(JSON.stringify({ list: [{ videoUrl: 'https://file.iminicdn.com/v/notvideo', cover: 'https://static.iminicdn.com/c/x.jpg' }] }))],
    });
    assert.equal(Object.keys(r.pairs).length, 0, '非视频直链不得进 pairs，实际=' + JSON.stringify(r.pairs));
  });

  await check('D7 推广图 / 埋点信标被 isPromo / isBeacon 排除', () => {
    const r = runCovers({
      scripts: [script(JSON.stringify({ list: [
        { videoUrl: 'https://file.iminicdn.com/v/a.mp4', cover: 'https://static.iminicdn.com/logo/brand.png' },
        { videoUrl: 'https://file.iminicdn.com/v/b.mp4', cover: 'https://static.iminicdn.com/mssdk/beacon.png' },
      ] }))],
    });
    assert.equal(Object.keys(r.pairs).length, 0, '推广图/信标图不得进 pairs，实际=' + JSON.stringify(r.pairs));
  });

  await check('D8 返回值结构未变：byKey / defaultCover / pageCovers（+ 新增 pairs）', () => {
    const r = runCovers({ scripts: [], videos: [video({ poster: 'https://static.iminicdn.com/c/z.jpg', src: 'https://file.iminicdn.com/v/z.mp4' })] });
    assert.deepEqual(Object.keys(r).sort(), ['byKey', 'defaultCover', 'pageCovers', 'pairs']);
    assert.ok(r.pageCovers.some((c) => c.kind === 'poster'), '既有 <video poster> → pageCovers 行为不得被破坏');
  });

  await check('D9 空页面 / 无脚本不抛异常（静默降级）', () => {
    const r = runCovers({ scripts: [], videos: [], imgs: [] });
    assert.equal(Object.keys(r.pairs).length, 0);
    assert.equal(r.defaultCover, '');
    assert.equal(Object.keys(r.byKey).length, 0);
  });
}

// ================================================================
section('E. scan.js COVER_FIELD_RE 修复复核（工程师自查抓到的坑）');
{
  const m = scanSrc.match(/const COVER_FIELD_RE = (\/.*?\/gi);/);
  await check('E0 能从源码里取出 COVER_FIELD_RE 字面量', () => {
    assert.ok(m && m[1], '未找到 COVER_FIELD_RE 定义');
    assert.ok(/\\\\\?"\?/.test(m[1]), '必须是修复后的 \\\\?"? 写法');
  });
  const RE = new Function('return ' + m[1])();
  await check('E1 ★普通 JSON（无反斜杠）必须能命中（原 \\\\"? 写法必然命中不到）', () => {
    const r = RE.exec('{"cover":"https://static.iminicdn.com/c/a.jpg"}');
    assert.ok(r, '普通 JSON 必须命中');
    assert.equal(r[1], 'https://static.iminicdn.com/c/a.jpg');
  });
  await check('E2 各封面字段名在纯 JSON 上均命中（cover/poster/thumbnail/image/picUrl/imgUrl/frameUrl…）', () => {
    for (const f of ['cover', 'coverUrl', 'cover_url', 'coverImage', 'cover_image', 'coverImg', 'poster', 'posterUrl', 'thumbnail', 'thumbnailUrl', 'thumb', 'thumbUrl', 'image', 'imgUrl', 'img_url', 'imageUrl', 'picUrl', 'pic_url', 'pic', 'frameUrl', 'frame_url', 'frame', 'firstFrame', 'first_frame', 'snapshot', 'preview', 'previewUrl', 'videoCover', 'video_cover']) {
      RE.lastIndex = 0;
      const r = RE.exec('{"' + f + '":"https://cdn.example.com/c/x.jpg"}');
      assert.ok(r && r[1] === 'https://cdn.example.com/c/x.jpg', '字段 ' + f + ' 在普通 JSON 上未命中');
    }
  });
  await check('E3 转义串（\\"）同样命中（兼容 RSC 未还原的情况）', () => {
    RE.lastIndex = 0;
    const r = RE.exec('{\\"cover\\":\\"https://static.iminicdn.com/c/e.jpg\\"}');
    assert.ok(r, '转义写法必须命中');
    assert.equal(r[1], 'https://static.iminicdn.com/c/e.jpg');
  });
  await check('E4 单个反斜杠前缀（\\cover）也命中（原写法本意仍在）', () => {
    RE.lastIndex = 0;
    const r = RE.exec('{\\cover\\":\\"https://cdn.example.com/c/f.jpg\\"}');
    assert.ok(r, '单反斜杠写法应命中');
  });
}

// ================================================================
section('F. scan.js scanTab 2.5) 封面优先级派发（真实源码片段）');
{
  const start = scanSrc.indexOf('const coverPairs = (coverMap && coverMap.pairs) || {};');
  const endMark = 'if (Array.isArray(pageAssets)) pageAssets.forEach(assignTrueCover);';
  const end = scanSrc.indexOf(endMark);
  await check('F0 能定位并抽取 scanTab 2.5) 真实片段', () => {
    assert.ok(start > 0 && end > start, '未定位到 2.5) 片段');
  });
  const block = scanSrc.slice(start, end + endMark.length);
  const fn = runInSandbox(
    'function __assign(pageVideoAssets, pageAssets, coverMap) {\n' + block + '\n}\n;globalThis.__f = __assign;',
    { console: noopConsole, URL: globalThis.URL },
    'globalThis.__f',
  );
  const u = 'https://file.iminicdn.com/v/1.mp4?token=abc';
  const coverOf = (a) => a[0].cover;

  await check('F1 ① 命中 pairs（原式）→ 直接用真封面', () => {
    const A = [{ type: 'video', url: u }];
    fn(A, [], { pairs: { [u]: 'https://static.iminicdn.com/c/1.jpg' }, pageCovers: [] });
    assert.equal(coverOf(A), 'https://static.iminicdn.com/c/1.jpg');
  });

  await check('F2 ① 命中 pairs 去查询串（直链带 ?token）', () => {
    const A = [{ type: 'video', url: u }];
    fn(A, [], { pairs: { 'https://file.iminicdn.com/v/1.mp4': 'https://static.iminicdn.com/c/1b.jpg' }, pageCovers: [] });
    assert.equal(coverOf(A), 'https://static.iminicdn.com/c/1b.jpg');
  });

  await check('F3 ③a 同 basename 图已在 pageCovers 里 → 直接用（零风险）', () => {
    const A = [{ type: 'video', url: 'https://file.iminicdn.com/v/9.mp4' }];
    fn(A, [], { pairs: {}, pageCovers: [
      { kind: 'page-img', url: 'https://file.iminicdn.com/other/x.jpg' },
      { kind: 'page-img', url: 'https://file.iminicdn.com/v/9.webp' },
    ] });
    assert.equal(coverOf(A), 'https://file.iminicdn.com/v/9.webp');
  });

  await check('F4 ③b 通用文件型 CDN → 才猜同 basename .jpg', () => {
    const A = [{ type: 'video', url: 'https://cdn.example.com/v/7.mp4' }];
    fn(A, [], { pairs: {}, pageCovers: [] });
    assert.equal(coverOf(A), 'https://cdn.example.com/v/7.jpg');
  });

  await check('F5 ★平台防盗链 CDN 一律【不猜】', () => {
    const urls = [
      'https://upos-sz-mirrorcos.bilivideo.com/upgcx/1.mp4',
      'https://p3-sign.douyinpic.com/tos/1.mp4',
      'https://p3-flow-imagex-sign.byteimg.com/x/1.mp4',
      'https://v16-webapp.tiktokcdn.com/1.mp4',
      'https://sns-video-hw.xhscdn.com/1.mp4',
      'https://video.alicdn.com/1.mp4',
      'https://findermp.video.qq.com/1.mp4',
      'https://v3.douyinvod.com/1.mp4',
      'https://rr3---sn-abc.googlevideo.com/1.mp4',
      'https://p3-pc.douyinstatic.com/1.mp4',
    ];
    for (const url of urls) {
      const A = [{ type: 'video', url }];
      fn(A, [], { pairs: {}, pageCovers: [] });
      assert.ok(!A[0].cover, '★该 CDN 绝不能猜同 basename: ' + url + '，实际 cover=' + A[0].cover);
    }
  });

  await check('F6 已有 cover 的资产不被覆盖（幂等）', () => {
    const A = [{ type: 'video', url: u, cover: 'https://static.iminicdn.com/c/keep.jpg' }];
    fn(A, [], { pairs: { [u]: 'https://static.iminicdn.com/c/new.jpg' }, pageCovers: [] });
    assert.equal(coverOf(A), 'https://static.iminicdn.com/c/keep.jpg');
  });

  await check('F7 非视频资产 / 相对 URL 不动', () => {
    const A = [{ type: 'image', url: u }, { type: 'video', url: '/rel/1.mp4' }];
    fn(A, [], { pairs: { [u]: 'https://static.iminicdn.com/c/1.jpg' }, pageCovers: [] });
    assert.equal(A[0].cover, undefined);
    assert.equal(A[1].cover, undefined);
  });

  await check('F8 pageAssets（scanPage 内联 JSON 直链）同样被派封面', () => {
    const P = [{ type: 'video', url: u }];
    fn([], P, { pairs: { [u]: 'https://static.iminicdn.com/c/pa.jpg' }, pageCovers: [] });
    assert.equal(P[0].cover, 'https://static.iminicdn.com/c/pa.jpg');
  });

  await check('F9 异常输入（coverMap undefined / pageAssets null）不抛', () => {
    // 注：真实 scanTab 里整段被 try{}catch(_){} 包裹；此处抽出的裸片段只对"安全输入"断言
    assert.doesNotThrow(() => fn([{ type: 'video', url: u }], null, undefined));
    assert.doesNotThrow(() => fn([{ type: 'video', url: u }], [], {}));
    assert.doesNotThrow(() => fn([], [], { pairs: null, pageCovers: null }));
  });
}

// ================================================================
section('G. sidepanel.js deriveMediaReferer（真实源码）');
{
  const fnSrc = extractFn(sidepanelSrc, 'deriveMediaReferer');
  const ref = runInSandbox(fnSrc + '\n;globalThis.__f = deriveMediaReferer;', { console: noopConsole, URL: globalThis.URL }, 'globalThis.__f');

  await check('G1 ★新增：iminicdn / imini → 干净站根 https://imini.ai/', () => {
    assert.equal(ref('https://file.iminicdn.com/v/1.mp4', 'https://imini.ai/zh/video?a=1&b=2'), 'https://imini.ai/');
    assert.equal(ref('https://static.iminicdn.com/c/1.jpg', 'https://imini.ai/zh/video?a=1'), 'https://imini.ai/');
    assert.equal(ref('https://imini.ai/x/y.mp4', 'https://imini.ai/zh/video'), 'https://imini.ai/');
  });

  await check('G2 既有判定未变：抖音 / TikTok / B站 / 微信QQ / 小红书 / 豆包', () => {
    assert.equal(ref('https://p3-sign.douyinpic.com/a.jpg', 'https://www.douyin.com/x'), 'https://www.douyin.com/');
    assert.equal(ref('https://v3.douyinvod.com/a.mp4', 'https://www.douyin.com/x'), 'https://www.douyin.com/');
    assert.equal(ref('https://www.tiktokcdn.com/a.mp4', 'https://x'), 'https://www.tiktok.com/');
    assert.equal(ref('https://upos.bilivideo.com/a.m4s', 'https://www.bilibili.com/x'), 'https://www.bilibili.com/');
    assert.equal(ref('https://sns-img.xhscdn.com/a.jpg', 'https://www.xiaohongshu.com/x'), 'https://www.xiaohongshu.com/');
    assert.equal(ref('https://p3-flow-imagex-sign.byteimg.com/a.jpg', 'https://www.doubao.com/x'), 'https://www.doubao.com/');
    assert.equal(ref('https://finder.video.qq.com/a.mp4', 'https://x'), 'https://finder.video.qq.com/');
  });

  await check('G3 通用 byteimg 分支按源页决定（即梦 / 剪映不被写成 douyin）', () => {
    assert.equal(ref('https://p3-other.byteimg.com/a.jpg', 'https://www.douyin.com/x'), 'https://www.douyin.com/');
    assert.equal(ref('https://p3-other.byteimg.com/a.jpg', 'https://jimeng.jianying.com/ai-tool/video/generate?a=1'), 'https://jimeng.jianying.com/');
    assert.equal(ref('https://p3-other.byteimg.com/a.jpg', 'https://www.doubao.com/chat/1'), 'https://www.doubao.com/');
    assert.equal(ref('https://p3-other.byteimg.com/a.jpg', 'https://www.tiktok.com/@a'), 'https://www.tiktok.com/');
  });

  await check('G4 未知域名回落源页（通用站点行为不变）+ 异常输入安全', () => {
    assert.equal(ref('https://cdn.unknown-site.com/a.jpg', 'https://example.com/p?q=1'), 'https://example.com/p?q=1');
    assert.equal(ref('not-a-url', 'https://example.com/'), 'https://example.com/');
    assert.doesNotThrow(() => ref(undefined, undefined));
  });
}

// ================================================================
section('H. sidepanel.js hmdaoCardNeedsHoverFrame 悬停闸门（真实源码）');
{
  const fnSrc = extractFn(sidepanelSrc, 'hmdaoCardNeedsHoverFrame');
  function makeCtx(nVideoCards, phList = [], cardsOverride = null) {
    const cards = cardsOverride || [];
    for (let i = 0; i < nVideoCards; i++) {
      cards.push({
        getBoundingClientRect: () => ({ top: 10 + i * 60, bottom: 60 + i * 60 }),
        querySelector: (sel) => (sel === '.url-row' ? {} : null),
      });
    }
    return runInSandbox(
      fnSrc + '\n;globalThis.__f = hmdaoCardNeedsHoverFrame;',
      {
        console: noopConsole,
        document: { querySelectorAll: (sel) => (sel === '#list .card' ? cards : []) },
        window: { innerHeight: 800, __hmdaoIsPlaceholderCover: (u) => phList.includes(u) },
        URL: globalThis.URL,
      },
      'globalThis.__f',
    );
  }
  const cardWith = (state) => ({ querySelector: (sel) => (sel === '.tag' ? { dataset: { coverState: state } } : null) });

  await check('H1 无封面 + 视口内视频卡 12 → 允许抽帧（旧 >20 硬闸已换掉）', () => {
    const f = makeCtx(12);
    assert.equal(f({ type: 'video', url: 'https://file.iminicdn.com/v/1.mp4' }, cardWith('none')), true);
  });

  await check('H2 无封面 + 视口内视频卡 13 → 拒绝抽帧（边界）', () => {
    const f = makeCtx(13);
    assert.equal(f({ type: 'video', url: 'https://file.iminicdn.com/v/1.mp4' }, cardWith('none')), false);
  });

  await check('H3 有有效封面（coverState = pending / ok）→ 不触发', () => {
    const f = makeCtx(3);
    assert.equal(f({ type: 'video', url: 'u', cover: 'https://static.iminicdn.com/c/1.jpg' }, cardWith('pending')), false);
    assert.equal(f({ type: 'video', url: 'u', cover: 'https://static.iminicdn.com/c/1.jpg' }, cardWith('ok')), false);
  });

  await check('H4 coverState ∈ error / empty / none → 触发', () => {
    const f = makeCtx(3);
    for (const st of ['error', 'empty', 'none']) {
      assert.equal(f({ type: 'video', url: 'u', cover: 'https://static.iminicdn.com/c/1.jpg' }, cardWith(st)), true, 'coverState=' + st + ' 应触发');
    }
  });

  await check('H5 封面被判为统一占位图 → 触发（即使 coverState=ok）', () => {
    const f = makeCtx(1, ['https://static.iminicdn.com/c/ph.jpg']);
    assert.equal(f({ type: 'video', url: 'u', cover: 'https://static.iminicdn.com/c/ph.jpg' }, cardWith('ok')), true, '占位图必须触发抽帧');
  });

  await check('H6 已抽过帧（a.__hoverCoverBlob）→ 不再抽', () => {
    const f = makeCtx(3);
    assert.equal(f({ type: 'video', url: 'u', __hoverCoverBlob: 'blob:x' }, cardWith('none')), false);
  });

  await check('H7 图片卡（无 .url-row）不计入视口阈值', () => {
    const cards = [];
    for (let i = 0; i < 30; i++) cards.push({ getBoundingClientRect: () => ({ top: 10 + i * 20, bottom: 50 + i * 20 }), querySelector: () => null });
    const f = makeCtx(0, [], cards);
    assert.equal(f({ type: 'video', url: 'u' }, cardWith('none')), true, '30 张图片卡不应触发 12 阈值');
  });

  await check('H8 异常输入（card 为 null / 无 querySelector）不抛', () => {
    const f = makeCtx(3);
    assert.equal(f(null, null), false);
    assert.equal(f({ type: 'video', url: 'u' }, null), false);
    assert.equal(f({}, {}), true, 'card 无 .tag 时仍能走到视口判定');
  });
}

// ================================================================
section('I. 悬停序号 / maxBytes / 500ms 延迟（源码静态断言）');
{
  await check('I1 sidepanel.js 旧硬闸 assets.length > 20 已被移除（注释除外）', () => {
    const code = sidepanelSrc.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.ok(!/assets\.length\s*>\s*20/.test(code), '旧 >20 硬闸仍作为【代码】存在');
    assert.ok(/hmdaoCardNeedsHoverFrame/.test(code), '新闸门必须存在');
  });
  await check('I2 hoverVideoFrame 传了 maxBytes 且用序号快照丢弃在途结果', () => {
    const hf = extractFn(sidepanelSrc, 'hoverVideoFrame');
    assert.ok(/maxBytes:\s*HOVER_FRAME_MAX_BYTES/.test(hf), '必须传 maxBytes');
    assert.ok(/const mySeq = \+\+hoverVideoSeq/.test(hf), '必须有序号快照');
    assert.ok(/if \(mySeq !== hoverVideoSeq\) return/.test(hf), '必须在 await 后比对序号');
  });
  await check('I3 HOVER_FRAME_MAX_BYTES = 2MB', () => {
    assert.ok(/const HOVER_FRAME_MAX_BYTES = 2 \* 1024 \* 1024/.test(sidepanelSrc));
  });
  await check('I4 paintHoverFrame 上屏前二次校验序号 + 写回封面缓存', () => {
    const pf = extractFn(sidepanelSrc, 'paintHoverFrame');
    assert.ok(/if \(typeof seq === 'number' && seq !== hoverVideoSeq\) return/.test(pf));
    assert.ok(/hmdaoCacheHoverCover/.test(pf), '成功后必须写回封面缓存');
  });
  await check('I5 stopHoverVideoFrame 进入即自增序号（在 return 之前）', () => {
    const sf = extractFn(sidepanelSrc, 'stopHoverVideoFrame');
    assert.ok(/hoverVideoSeq\+\+/.test(sf));
    const idxSeq = sf.indexOf('hoverVideoSeq++');
    const idxIf = sf.indexOf('if (hoverVideoEl');
    assert.ok(idxSeq > 0 && idxSeq < idxIf, '★自增必须在 hoverVideoEl 判断之前（进入即失效）');
  });
  await check('I6 card-render.js mouseenter = 500ms 延迟；mouseleave = 立即 clearTimeout + stop', () => {
    const i = cardRenderSrc.indexOf("card.addEventListener('mouseenter'");
    assert.ok(i > 0, '未找到 mouseenter 监听');
    const seg = cardRenderSrc.slice(i, i + 1400);
    assert.ok(/hoverVideoFrame\(a, card\)/.test(seg), 'mouseenter 必须调 hoverVideoFrame');
    assert.ok(/\}, 500\)/.test(seg), '必须是 500ms 延迟');
    const j = cardRenderSrc.indexOf("card.addEventListener('mouseleave'");
    assert.ok(j > i, '未找到 mouseleave 监听');
    const seg2 = cardRenderSrc.slice(j, j + 400);
    assert.ok(/clearTimeout\(hoverFrameTimer\)/.test(seg2), 'mouseleave 必须 clearTimeout');
    assert.ok(/stopHoverVideoFrame\(card\)/.test(seg2), 'mouseleave 必须 stopHoverVideoFrame');
  });
  await check('I7 hoverVideoFrame 调用挂了 .catch（无未捕获 rejection）', () => {
    const i = cardRenderSrc.indexOf('const p = hoverVideoFrame(a, card)');
    assert.ok(i > 0);
    assert.ok(/p\.catch\(\(\) => \{\}\)/.test(cardRenderSrc.slice(i, i + 200)));
  });
  await check('I8 mouseenter 内 setTimeout 回调整体被 try/catch 包裹', () => {
    const i = cardRenderSrc.indexOf("card.addEventListener('mouseenter'");
    const seg = cardRenderSrc.slice(i, i + 500);
    assert.ok(/try \{[\s\S]*if \(hoverFrameTimer\) clearTimeout[\s\S]*\} catch \(_\) \{\}/.test(seg));
  });
}

// ================================================================
section('J. card-render.js 占位图判死 + 空态（源码断言 + 行为）');
{
  await check('J1 coverFetch：判死 URL 直接 resolve("")（不再走 relay）', () => {
    const cf = extractFn(cardRenderSrc, 'coverFetch');
    assert.ok(/if \(coverIsPlaceholder\(url\)\) return Promise\.resolve\(''\);/.test(cf));
  });
  await check('J2 渲染入口：占位图封面被清空 → 走无封面（🎬 + 抽帧）', () => {
    assert.ok(/if \(a\.cover && coverIsPlaceholder\(coverUrlOf\(a\)\)\) a\.cover = '';/.test(cardRenderSrc));
  });
  await check('J3 onerror 分支：判死即置 🎬 并跳过 4×300ms 重试', () => {
    assert.ok(/if \(coverIsPlaceholder\(coverUrlOf\(a\)\)\) \{\s*\n\s*tag\.textContent = '🎬';\s*\n\s*return;\s*\n\s*\}/.test(cardRenderSrc));
  });
  await check('J4 empty 分支：判死即置 🎬（不回落 🪫 重试）', () => {
    assert.ok(/if \(coverIsPlaceholder\(coverUrl\)\) \{ tag\.textContent = '🎬'; return; \}/.test(cardRenderSrc));
  });
  await check('J5 无封面视频卡先复用 HMDAO_HOVER_COVER（避免重复拉字节）', () => {
    assert.ok(/const cachedHover = a\.url \? HMDAO_HOVER_COVER\.get\(a\.url\) : '';/.test(cardRenderSrc));
    assert.ok(/if \(cachedHover\) \{\s*\n\s*applyHoverFrameToTag\(a, tag, cachedHover\);/.test(cardRenderSrc));
  });
  await check('J6 hmdaoCacheHoverCover 同时写回 HMDAO_COVER_CACHE + __thumbCache + HMDAO_HOVER_COVER', () => {
    const fn = extractFn(cardRenderSrc, 'hmdaoCacheHoverCover');
    assert.ok(/HMDAO_COVER_CACHE\.set\(coverCacheKey\(c\), blobUrl\)/.test(fn));
    assert.ok(/__thumbCache\.set\(c, blobUrl\)/.test(fn));
    assert.ok(/HMDAO_HOVER_COVER\.set\(a\.url, blobUrl\)/.test(fn));
  });
  await check('J7 空态：1.5s 内曾有资产 → 显示「正在扫描…」', () => {
    assert.ok(/let __lastAssetsAt = 0;/.test(cardRenderSrc));
    assert.ok(/__hadAssetsRecently = __lastAssetsAt > 0 && \(Date\.now\(\) - __lastAssetsAt\) < 1500;/.test(cardRenderSrc));
    assert.ok(/__hadAssetsRecently \? '正在扫描…' : '未发现可采集素材，请确认页面已加载'/.test(cardRenderSrc));
  });

  const cuSrc = extractFn(cardRenderSrc, 'coverUrlOf');
  await check('J8 coverUrlOf：a.cover 为数组时取首元素', () => {
    const f = runInSandbox(cuSrc + ';globalThis.__f = coverUrlOf;', { console: noopConsole }, 'globalThis.__f');
    assert.equal(f({ cover: ['https://a/1.jpg', 'https://a/2.jpg'] }), 'https://a/1.jpg');
    assert.equal(f({ cover: 'https://a/1.jpg' }), 'https://a/1.jpg');
    assert.equal(f({}), '');
    assert.equal(f(null), '');
  });

  const cpSrc = extractFn(cardRenderSrc, 'coverIsPlaceholder');
  await check('J9 coverIsPlaceholder：优先 window 钩子，缺失时安全回落 false', () => {
    const f = runInSandbox(cpSrc + ';globalThis.__f = coverIsPlaceholder;', {
      console: noopConsole,
      window: { __hmdaoIsPlaceholderCover: (u) => u === 'https://x/ph.jpg' },
    }, 'globalThis.__f');
    assert.equal(f('https://x/ph.jpg'), true);
    assert.equal(f('https://x/ok.jpg'), false);
    assert.equal(f(''), false);
    const g = runInSandbox(cpSrc + ';globalThis.__f = coverIsPlaceholder;', { console: noopConsole, window: {} }, 'globalThis.__f');
    assert.equal(g('https://x/ph.jpg'), false, '无钩子时安全返回 false');
  });
}

// ================================================================
section('K. 回归护栏：既有行为不得被破坏');
{
  await check('K1 scan.js 「内容图优先 + DOM 顺序 + 上限 30」仍完整', () => {
    assert.ok(/const contentImgs = candidates\.filter\(\(c\) => c\.isContent\)\.sort\(\(a, b\) => a\.idx - b\.idx\);/.test(scanSrc));
    assert.ok(/const staticImgs = candidates\.filter\(\(c\) => !c\.isContent\)\.sort\(\(a, b\) => a\.idx - b\.idx\);/.test(scanSrc));
    assert.ok(/\[\.\.\.contentImgs, \.\.\.staticImgs\]\.slice\(0, 30\)/.test(scanSrc));
  });
  await check('K2 scan.js 多视频页不再全员塞 defaultCover（≤1 才发）', () => {
    assert.ok(/if \(pageVideoAssets\.length <= 1\) \{/.test(scanSrc));
  });
  await check('K3 持真实视频流的卡不参与 page-img 兜底分配', () => {
    assert.ok(/const hasRealStream = /.test(scanSrc));
    assert.ok(/if \(hasRealStream\(d\)\) return;/.test(scanSrc));
  });
  await check('K4 media-fetch.js SUSPICIOUS_TINY 保留为并集（未被替换）', () => {
    assert.ok(/const SUSPICIOUS_TINY = 6 \* 1024;/.test(mediaFetchSrc));
    assert.ok(/\|\| \(swOk && swSize > 0 && swSize < SUSPICIOUS_TINY\)/.test(mediaFetchSrc));
    assert.ok(/\|\| swPlaceholder;/.test(mediaFetchSrc));
  });
  await check('K5 平台族登记表显式成对、无通配（只 1 对）', () => {
    assert.ok(/\[\/imini\\\.ai\$\/i, \/iminicdn\\\.com\$\/i\]/.test(mediaFetchSrc));
    const decl = (mediaFetchSrc.match(/const PAGE_FETCH_PAIRS = \[[\s\S]*?\];/) || [''])[0];
    assert.equal((decl.match(/\[\/.*?\/i, \/.*?\/i\]/g) || []).length, 1, '登记表只应有 1 对（严禁通配）');
  });
  await check('K6 熔断 5 分钟（tabId + 图床粒度），且不做 CSP 探针', () => {
    assert.ok(/const PAGE_FETCH_BREAKER_MS = 5 \* 60 \* 1000;/.test(mediaFetchSrc));
    assert.ok(/const breakerKey = String\(tabId\) \+ '\|' \+ assetHost;/.test(mediaFetchSrc));
    assert.ok(!/PROBE|CSP_PROBE/i.test(mediaFetchSrc), '不得出现任何 CSP 探针');
  });
  await check('K7 既有兜底 emoji 全部仍在（🎬 / ⛔ / 🚫 / 🪫）', () => {
    for (const t of ['🎬', '⛔', '🚫', '🪫']) assert.ok(cardRenderSrc.includes(t), '缺少兜底 ' + t);
  });
  await check('K8 加载顺序未变：sidepanel.js → media-fetch.js → card-render.js', () => {
    const html = read('sidepanel.html');
    // 容忍脚本 src 上的 ?v= 缓存版本号（如 card-render.js?v=20260911c），只校验基础文件名与顺序
    const idxOf = (name) => {
      const m = new RegExp('src="' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\?[^"]*)?"').exec(html);
      return m ? m.index : -1;
    };
    const i1 = idxOf('sidepanel.js');
    const i2 = idxOf('media-fetch.js');
    const i3 = idxOf('card-render.js');
    assert.ok(i1 > 0 && i2 > i1 && i3 > i2, '脚本顺序被改变 (i1=' + i1 + ' i2=' + i2 + ' i3=' + i3 + ')');
  });
}

// ================================================================
// L. K-1 / K-2 返工护栏（工程师补：锁住第 2 轮 QA 发现的两个 Known Issue）
section('L. K-1 源页 Cookie 救回的真封面必须可复用 / K-2 相对路径封面不得被误弃');
{
  const phBytes = bytesOf(9000, 0x41);
  const realBytes = (seed) => {
    const b = new Uint8Array(9000 + seed);
    for (let i = 0; i < b.length; i++) b[i] = (i * 7 + seed * 13) & 0xff;
    return b;
  };
  // 第一层（SW）永远回占位图；第二层（源页带 Cookie）回真图
  const api = makeMediaFetchCtx({
    respond: (msg) => (msg.type === 'HMDAO_FETCH_MEDIA_IN_TAB'
      ? { ok: true, b64: b64(realBytes(1)), mime: 'image/jpeg' }
      : { ok: true, b64: b64(phBytes), mime: 'image/jpeg' }),
  });
  const u = (n) => 'https://file.iminicdn.com/file/2026/06/04/k1-' + n + '.jpg?token=' + n;
  const REF = 'https://imini.ai/zh/video';

  await check('L1 ★[K-1 已修] 源页 Cookie 救回的真封面可复用（第二次调用仍返回 blob）', async () => {
    // 连续喂 3 个都回占位图的 URL：前 2 个被放行缓存，第 3 个达阈值 → 走第二层源页重试救回
    await api.loadImageViaRelay(u(1), REF);
    await api.loadImageViaRelay(u(2), REF);
    const r3 = await api.loadImageViaRelay(u(3), REF);
    assert.equal(typeof r3, 'string', '第 3 个应被源页 Cookie 救回并返回 blob');
    assert.equal(api.isPlaceholderCover(u(3)), false, '★救回后不得仍被判为占位图');
    const r3b = await api.loadImageViaRelay(u(3), REF);
    assert.equal(typeof r3b, 'string', '★第二次调用必须仍能取回真封面（修复前为 null，只能闪一次）');
  });

  await check('L1b ★[K-1] 救回的 URL 不会被后续「追溯判死」再打回去', async () => {
    await api.loadImageViaRelay(u(4), REF);
    await api.loadImageViaRelay(u(5), REF);
    assert.equal(api.isPlaceholderCover(u(3)), false, '★后续占位图达阈值时，已救回的 u(3) 不得被追溯判死');
    assert.equal(typeof (await api.loadImageViaRelay(u(3), REF)), 'string');
  });

  await check('L1c [K-1 边界] 源页仍回同一张占位图 → 保持判死（不得误赦）', async () => {
    const api2 = makeMediaFetchCtx({ respond: () => ({ ok: true, b64: b64(phBytes), mime: 'image/jpeg' }) });
    const v = (n) => 'https://file.iminicdn.com/file/2026/06/04/k2-' + n + '.jpg';
    await api2.loadImageViaRelay(v(1), REF);
    await api2.loadImageViaRelay(v(2), REF);
    const r = await api2.loadImageViaRelay(v(3), REF);
    assert.equal(r, null, '源页也回占位图 → 仍是 null');
    assert.equal(api2.isPlaceholderCover(v(3)), true, '且保持判死');
  });
}

{
  const extractSrc = extractFn(scanSrc, 'extractVideoCovers');
  function runCovers(scripts, href = 'https://imini.ai/zh/video') {
    return runInSandbox(
      extractSrc + '\n;globalThis.__r = extractVideoCovers;',
      {
        console: noopConsole,
        window: {},
        location: { href, hostname: new URL(href).hostname },
        getComputedStyle: () => ({ backgroundImage: '' }),
        URL: globalThis.URL,
        document: {
          querySelectorAll(sel) { return (sel === 'script:not([src])' || sel === 'script') ? scripts : []; },
          querySelector() { return null; },
        },
      },
      'globalThis.__r()',
    );
  }
  const script = (t) => ({ textContent: t });

  await check('L2 ★[K-2 已修] 相对路径封面（/img/a.jpg）应被接受并解析成绝对地址', () => {
    const r = runCovers([script('boot({"videoUrl":"https://file.iminicdn.com/v/t9.mp4","cover":"/img/a.jpg"}')]);
    assert.equal(r.pairs['https://file.iminicdn.com/v/t9.mp4'], 'https://imini.ai/img/a.jpg', '相对路径应被 toAbs 解析');
  });
  await check('L2b [K-2 边界] 半截串（"https:" / "https"）仍必须被丢弃', () => {
    const r1 = runCovers([script('boot({"videoUrl":"https://file.iminicdn.com/v/t8.mp4","cover":"https:"}')]);
    // ★注意：extractVideoCovers 在 vm 沙箱里执行，返回的 pairs 是【沙箱 realm 的对象】，
    //   不能用 assert.deepEqual 与测试 realm 的 {} 比较（assert/strict 会因跨 realm 原型不同报错
    //   "Values have same structure but are not reference-equal"）。改用与 D5 一致的"键数为 0"判定。
    assert.equal(Object.keys(r1.pairs).length, 0, '"https:" 必须丢弃');
    const r2 = runCovers([script('boot({"videoUrl":"https://file.iminicdn.com/v/t7.mp4","cover":"https"}')]);
    assert.equal(Object.keys(r2.pairs).length, 0, '"https" 必须丢弃');
  });
}

console.log(`\n=== phase13-imini-cover-regression 总结 ===\n通过 ${pass} / 失败 ${fail}`);
if (failures.length) { console.log('\n失败明细:'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
