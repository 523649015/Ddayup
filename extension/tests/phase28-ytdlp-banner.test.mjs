/**
 * P2/P3 闭环验证：yt-dlp 横幅「一键连接（本地）」的原生主机交互修复（B / C / D）
 *               + 扩展审查（ddayup-extension-reviewer）提出的重要项回归。
 *
 * 覆盖：
 *  A. 语法：sidepanel.js 通过 node --check
 *  B. 静态：关键实现点存在、旧死代码已清除、审查修复点落地
 *  C. 行为：把 sidepanel.js 的 yt-dlp 横幅模块整段取出，在 mock DOM + stubs 沙箱中真实执行：
 *     - 原生主机可用 + missing  → 展示「一键连接（本地）」
 *     - 原生主机不可用 + 云端 missing → 【不展示】一键连接，换成「去模型下载面板安装」+ 云端文案
 *     - 原生主机不可用 + 本机 missing → 引导去模型下载面板
 *     - 点一键连接：超时 / 原生不可用 / 未知错误 / 成功 → 状态复位且文案与按钮不脱节
 *     - 就绪 → 横幅自动隐藏
 *     - 单飞：静默自动安装与用户点击共用同一个在飞请求（只发一次 ytdlp.ensure）
 *  D. 真实 RPC：单独切出 ddNativeRpc 代码段，用假 port 驱动
 *     - 断开必须立刻 reject（修复前要等满 timeout）、超时/成功都必须摘干净监听器
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = join(__dirname, '..');

let pass = 0;
let fail = 0;
const fails = [];
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  PASS: ${msg}`); }
  else { fail++; fails.push(msg); console.log(`  FAIL: ${msg}`); }
}

function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// ---------- A. 语法检查 ----------
console.log('\n=== A. 语法检查 ===');
try {
  execFileSync(process.execPath, ['--check', join(EXT, 'sidepanel.js')], { stdio: 'pipe' });
  ok(true, 'sidepanel.js 语法通过');
} catch (e) {
  ok(false, `sidepanel.js 语法错误: ${String(e.stderr || e.message).slice(0, 300)}`);
}

const sp = readFileSync(join(EXT, 'sidepanel.js'), 'utf8');
const html = readFileSync(join(EXT, 'sidepanel.html'), 'utf8');
const spCode = codeOnly(sp);

// ---------- B. 静态断言 ----------
console.log('\n=== B. 静态断言 ===');
const MARK = '// ===== yt-dlp 横幅交互辅助（2026-09-16 修复 B/C/D）=====';
ok(sp.includes(MARK), 'sidepanel: 含 yt-dlp 横幅交互辅助模块标记');
ok(/switchYtDlpConnectToWeb/.test(sp), 'sidepanel: 存在失败兜底函数 switchYtDlpConnectToWeb');
ok(/function isCloudBackend/.test(sp), 'sidepanel: 存在云端/本机判定 isCloudBackend');
ok(/__ytDlpCloudInstallHint/.test(sp), 'sidepanel: 存在云端安装提示变量（单一文案源）');

// B1～B5：B（超时 + 单飞 + 兜底 + 复位）
ok(/result = await ensureYtDlpOnce\(180000\)/.test(sp), 'B: 一键连接改用单飞 ensureYtDlpOnce(180000)');
ok(/function ensureYtDlpOnce/.test(sp) && /__ytDlpEnsurePromise/.test(sp), 'B: 存在 ytdlp.ensure 单飞实现');
ok(!/port\.postMessage\(\{ id, type: 'ytdlp\.ensure' \}\)/.test(sp), 'B: 已移除无超时的裸 port.postMessage 实现');
ok(/native_unavailable/.test(sp) && /native_timeout/.test(sp) && /native_disconnected/.test(sp), 'B: 区分 unavailable / timeout / disconnected');
ok(/finally \{[\s\S]{0,260}connectBtn\.disabled = false;/.test(sp), 'B: finally 中必定复位按钮（超时/异常也不卡死）');
ok(/__ytDlpLastFailure = '⚠ 本地安装不可用/.test(sp), 'B: 失败原因写入状态统一渲染');

// B6：C（原生不可用不展示一键连接）
ok(/const nativeOk = !backendSt\.nativeUnavailable;/.test(sp), 'C: 以原生主机可用性门控「一键连接（本地）」');
ok(/switchYtDlpConnectToWeb\(cBtn, wBtn\)/.test(sp), 'C: 原生不可用时收口为「去模型下载面板安装」');
const connectBtnTag = (html.match(/<button[^>]*id="ydConnectBtn"[^>]*>/) || [''])[0];
ok(/display:\s*none/.test(connectBtnTag), 'C: sidepanel.html 中 #ydConnectBtn 默认 display:none（不首帧外露）');

// D：死代码清除 + 文案
ok(!/ytDlpNoticeMsg/.test(spCode), 'D: sidepanel.js 代码中已无 .ytDlpNoticeMsg 访问（仅注释保留成因说明）');
ok(!/ytDlpNoticeMsg/.test(html), 'D: sidepanel.html 中不存在 .ytDlpNoticeMsg（印证旧提示永不显示）');
ok(/云端未安装 yt-dlp/.test(sp), 'D: 含「云端未安装」专属文案');
ok(/去模型下载面板安装/.test(sp), 'D: 含「去模型下载面板安装」引导');

// 审查项（ddayup-extension-reviewer）
ok(/port\.onDisconnect\.addListener\(onDisc\)/.test(sp) && /native_disconnected/.test(sp), '审查-重要1: ddNativeRpc 端口断开立即 reject（不再静默等满 180s）');
ok(/__ytDlpLastSource = 'native'/.test(sp) && /__ytDlpLastSource = 'web'/.test(sp), '审查-重要2: 记录 missing 结论来源，文案不再"配置猜云端"');
ok(/await ddNativeRpc\('ytdlp\.status', \{\}, 8000\)/.test(sp), '审查-次要4: checkNativeYtDlp 改用 ddNativeRpc（统一清理监听器）');
ok(/__ytDlpCloudInstallHint \? ' ' \+ __ytDlpCloudInstallHint : ''/.test(sp), '审查-次要3: 云端安装提示只在云端缺失分支拼接');

// 鉴权收紧后的客户端身份（2026-09-16：服务端安装接口仅「已授权设备 / 运维 Key」可调）
ok(/getExtDeviceAuth\(\)/.test(sp), '闸门: 云端自动安装读取扩展设备身份（getExtDeviceAuth）');
ok(/withDeviceAuthBody\(/.test(sp), '闸门: 安装请求体经 withDeviceAuthBody 携带 deviceId/token（单一来源）');
ok(!/apiKey=' \+ encodeURIComponent\(apiKey\)/.test(sp), '闸门: 运维 Key 不再拼进 URL query（避免进入访问日志/Referer）');
ok(/r\.status === 401 \|\| r\.status === 402/.test(sp), '闸门: 401/402 给可执行引导而非静默失败');
ok(!/reason: 'no-api-key'/.test(sp), '闸门: 已移除「无运维 Key 就放弃」的旧分支（改为设备身份优先）');
ok(/AbortSignal\.timeout\(15000\)/.test(sp), '闸门: 安装 POST 带 15s 超时（防 fetch 挂起永久锁死自愈）');
ok(/__ytDlpAutoInstallRunning = true/.test(sp) && /YTDLP_AUTO_INSTALL_COOLDOWN_MS/.test(sp), '闸门: 进入函数即占位 + 时间戳冷却（防再入与永久死状态）');
ok(/markAutoYtDlpInstallAttempt/.test(sp) && /removeItem\('hmdao_ytDlpAutoInstalling'\)/.test(sp), '闸门: 清理无 TTL 的历史布尔键（避免永久不再自动安装）');
ok(/checkYtDlp\(\{ autoInstall: false \}\)/.test(sp), '闸门: 渲染/轮询路径使用只读探测（autoInstall:false）');
// ★审查 重要-2：这两条静态守卫正是"删掉就复发循环"的两处关键代码，必须单独盯住
ok(/if \(autoInstall && isCloud && !autoYtDlpInstallInFlight\(\)\)/.test(sp), '闸门: 真实 checkYtDlp 内部尊重 autoInstall 开关（删掉它=渲染即触发安装）');
{
  const readOnlyCalls = (sp.match(/checkYtDlp\(\{ autoInstall: false \}\)/g) || []).length;
  ok(readOnlyCalls >= 3, `闸门: 只读探测调用点 ≥3（refresh / 就绪轮询 / 自愈轮询），实际 ${readOnlyCalls}`);
}
ok(/YTDLP_AUTO_INSTALL_STALE_MS/.test(sp), '闸门: 占位带失效时间（异常时不会永久禁用自愈）');
ok(/withTimeout\(/.test(sp), '闸门: 身份读取带超时（chrome.storage 挂起不致 finally 不可达）');

// ---------- C. 行为验证（横幅模块）----------
console.log('\n=== C. 行为验证（mock DOM + stubs）===');
const SLICE_END = '// ===== Aria2 下载通道';
// 从「自愈安装再入保护」处开始切：这样才能把 autoInstallYtDlpViaCloud 一并纳入沙箱做行为断言。
// （此前从 __ytDlpPromptShownThisSession 开始切，该函数落在切片之外 → 零行为覆盖，
//   审查实测出的两个请求循环完全没有被拦住：断言通过 ≠ 逻辑正确。）
const sliceStart = sp.indexOf('const YTDLP_AUTO_INSTALL_COOLDOWN_MS');
const sliceEnd = sp.indexOf(SLICE_END, sliceStart);
ok(sliceStart >= 0 && sliceEnd > sliceStart, '可定位并切出 yt-dlp 横幅 + 自愈安装代码段');
const moduleCode = sp.slice(sliceStart, sliceEnd);
// 另切一份「真实 checkYtDlp + 自愈安装」代码段：C 段需要用桩控制横幅状态，故保留上面那份；
// 这里保留**真实** checkYtDlp，用它验证 autoInstall 守卫（审查 重要-2 的测试盲区）。
const REAL_CHECK_START = 'async function checkYtDlp(options = {}) {';
const realCheckStart = sp.indexOf(REAL_CHECK_START);
const realCheckEnd = sp.indexOf(SLICE_END, realCheckStart);
ok(realCheckStart >= 0 && realCheckEnd > realCheckStart, '可切出「真实 checkYtDlp」代码段（防循环行为验证用）');
const realCheckCode = sp.slice(realCheckStart, realCheckEnd);

function makeDoc(ids) {
  const els = new Map();
  for (const id of ids) {
    els.set(id, {
      id,
      style: { display: '', color: '', cssText: '' },
      textContent: '',
      disabled: false,
      _listeners: {},
      addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
      async click() { for (const fn of (this._listeners.click || [])) await fn(); },
    });
  }
  return { _els: els, getElementById: (id) => els.get(id) || null };
}

const IDS = ['ytDlpNotice', 'ydDot', 'ydTitle', 'ydDesc', 'ydStartBackendBtn', 'ydConnectBtn', 'ydWebBtn', 'ydSpinner', 'ydDismiss'];

// 可读写的 localStorage 替身（自愈安装的冷却时间戳需要真实读写才能验证）
function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    _map: map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

function buildSandboxWith(code, over = {}) {
  const doc = makeDoc(IDS);
  const timers = [];
  let timerId = 0;
  const calls = { rpc: [], tabs: [] };

  const base = {
    document: doc,
    chrome: { tabs: { create: (o) => calls.tabs.push(o) } },
    localStorage: makeStorage(),
    window: { DdayupConfig: { getApiKey: async () => '' } },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    panelLog: () => {},
    getExtDeviceAuth: async () => ({ deviceId: '', token: '' }),
    withDeviceAuthBody: (body, auth) => ({ ...body, deviceId: (auth && auth.deviceId) || '', token: (auth && auth.token) || '' }),
    // 供「真实 checkYtDlp」切片使用：决定探测结论（nativeUnavailable=false → 结论来自本机通道）
    checkNativeYtDlp: async () => ({ installed: false, nativeUnavailable: true }),
    ensureBackendRunningNative: async () => ({ ok: false }),
    // 供「横幅状态打桩」切片使用（真实切片里同名函数声明会覆盖本参数，无副作用）
    checkYtDlp: async () => 'missing',
    getBackendStatusViaNative: async () => ({ ok: false, nativeUnavailable: true }),
    getCloudApiBase: async () => 'https://mingmingchuangyi.cn',
    ddNativeRpc: async (type, payload, timeoutMs) => { calls.rpc.push({ type, payload, timeoutMs }); return { ok: true, installed: true }; },
    ddNativeConnect: () => null,
    startBackendViaNative: async () => ({ ok: true }),
    apiBaseUrl: () => 'http://127.0.0.1:3000',
    setTimeout: (fn, ms) => { timerId += 1; timers.push({ id: timerId, fn, ms }); return timerId; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    setInterval: () => 0,
    clearInterval: () => {},
  };
  const stubs = { ...base, ...over };
  const keys = Object.keys(stubs);
  const factory = new Function(...keys, `
${code}
return {
  refreshYtDlpNotice,
  ensureYtDlpPrompt,
  ensureYtDlpOnce,
  autoInstallYtDlpViaCloud,
  checkYtDlp,
  switchYtDlpConnectToWeb,
  __setHint: (v) => { __ytDlpCloudInstallHint = v; },
  __hint: () => __ytDlpCloudInstallHint,
};
`);
  const api = factory(...keys.map((k) => stubs[k]));
  return { api, doc, timers, calls, storage: stubs.localStorage };
}

/** 横幅状态用桩控制（C 段）。 */
function buildSandbox(over = {}) {
  return buildSandboxWith(moduleCode, over);
}

/** 保留真实 checkYtDlp（E 段防循环验证）。 */
function buildRealCheckSandbox(over = {}) {
  return buildSandboxWith(realCheckCode, over);
}

const flush = async (n = 10) => { for (let i = 0; i < n; i += 1) await Promise.resolve(); };
const el = (doc, id) => doc.getElementById(id);

// C1. 原生主机可用 + yt-dlp 缺失 → 展示「一键连接（本地）」
{
  const { api, doc } = buildSandbox({
    checkYtDlp: async () => 'missing',
    getBackendStatusViaNative: async () => ({ ok: true, nativeUnavailable: false }),
    getCloudApiBase: async () => 'http://127.0.0.1:3000',
  });
  api.refreshYtDlpNotice();
  await flush();
  ok(el(doc, 'ydConnectBtn').style.display !== 'none', 'C1 本机可用时展示「一键连接（本地）」');
  ok(el(doc, 'ydConnectBtn').textContent.includes('一键连接'), 'C1 按钮文案为「一键连接 yt-dlp（本地）」');
  ok(el(doc, 'ydConnectBtn').disabled === false, 'C1 空闲时按钮可点');
  ok(el(doc, 'ydDesc').textContent.includes('本机 yt-dlp 未安装'), 'C1 文案明确是【本机】缺失（不再误报云端）');
  ok(el(doc, 'ydWebBtn').textContent.includes('或前往 Web 模型面板'), 'C1 同时保留 Web 面板出口');
}

// C2. 原生主机不可用 + 云端缺失 → 不展示一键连接，文案指向云端
{
  const { api, doc } = buildSandbox({
    checkYtDlp: async () => 'missing',
    getBackendStatusViaNative: async () => ({ ok: false, nativeUnavailable: true }),
    getCloudApiBase: async () => 'https://mingmingchuangyi.cn',
  });
  api.refreshYtDlpNotice();
  await flush();
  ok(el(doc, 'ydConnectBtn').style.display === 'none', 'C2 原生主机不可用时【不展示】「一键连接（本地）」');
  ok(el(doc, 'ydConnectBtn').disabled === true, 'C2 已隐藏的按钮同时置为 disabled');
  ok(el(doc, 'ydWebBtn').textContent.includes('去模型下载面板安装'), 'C2 唯一出口改为「去模型下载面板安装」');
  ok(el(doc, 'ydDesc').textContent.includes('云端未安装 yt-dlp'), 'C2 文案明确「云端未安装」而非笼统「后端未连接」');
}

// C3. 原生主机不可用 + 本机环境 → 引导去模型下载面板（不出现云端字样）
{
  const { api, doc } = buildSandbox({
    checkYtDlp: async () => 'missing',
    getBackendStatusViaNative: async () => ({ ok: false, nativeUnavailable: true }),
    getCloudApiBase: async () => 'http://127.0.0.1:3000',
  });
  api.refreshYtDlpNotice();
  await flush();
  ok(el(doc, 'ydConnectBtn').style.display === 'none', 'C3 本机原生主机不可用时同样不展示一键连接');
  ok(el(doc, 'ydDesc').textContent.includes('模型下载面板'), 'C3 直接引导去模型下载面板');
  ok(!el(doc, 'ydDesc').textContent.includes('云端未安装'), 'C3 本机场景不误用云端文案');
}

// C4. D：无 API Key 的云端提示经单一文案源展示（不再写不存在的元素），且不污染本机文案
{
  const { api, doc } = buildSandbox({
    checkYtDlp: async () => 'missing',
    getBackendStatusViaNative: async () => ({ ok: false, nativeUnavailable: true }),
    getCloudApiBase: async () => 'https://mingmingchuangyi.cn',
  });
  api.__setHint('（未配置运维 API Key：可在扩展「选项」填入后自助安装，或联系站长安装。）');
  api.refreshYtDlpNotice();
  await flush();
  ok(el(doc, 'ydDesc').textContent.includes('未配置运维 API Key'), 'C4 云端安装提示真实出现在 #ydDesc（旧实现永不显示）');
}
{
  const { api, doc } = buildSandbox({
    checkYtDlp: async () => 'missing',
    getBackendStatusViaNative: async () => ({ ok: false, nativeUnavailable: true }),
    getCloudApiBase: async () => 'http://127.0.0.1:3000',
  });
  api.__setHint('（未配置运维 API Key：可在扩展「选项」填入后自助安装，或联系站长安装。）');
  api.refreshYtDlpNotice();
  await flush();
  ok(!el(doc, 'ydDesc').textContent.includes('未配置运维 API Key'), 'C4b 本机场景不拼接云端 API Key 提示（审查 次要-3）');
}

// C5～C7. 失败路径：「给原因 + 状态复位 + 与按钮不脱节」
async function clickConnectFailure(throwMsg, nativeUnavailable = false) {
  const sb = buildSandbox({
    getBackendStatusViaNative: async () => ({ ok: !nativeUnavailable, nativeUnavailable }),
    ddNativeRpc: async () => { throw new Error(throwMsg); },
  });
  sb.api.ensureYtDlpPrompt();
  await flush();
  await el(sb.doc, 'ydConnectBtn').click();
  await flush();
  return {
    desc: el(sb.doc, 'ydDesc').textContent,
    connectDisplay: el(sb.doc, 'ydConnectBtn').style.display,
    connectDisabled: el(sb.doc, 'ydConnectBtn').disabled,
    connectText: el(sb.doc, 'ydConnectBtn').textContent,
    webDisplay: el(sb.doc, 'ydWebBtn').style.display,
    webText: el(sb.doc, 'ydWebBtn').textContent,
    spinnerDisplay: el(sb.doc, 'ydSpinner').style.display,
  };
}

{
  const r = await clickConnectFailure('native_timeout');
  ok(r.desc.includes('180 秒'), 'C5 失败原因进入 #ydDesc（单一文案源）：' + r.desc);
  ok(r.spinnerDisplay === 'none', 'C5 失败后转圈隐藏（不留永久 spinner）');
  ok(r.connectDisplay !== 'none' && r.connectDisabled === false, 'C5 瞬时超时可重试（按钮可见且可点，无永久禁用）');
  ok(r.connectText.includes('一键连接'), 'C5 按钮文案已复位（未串味）');
}

{
  const r = await clickConnectFailure('native_unavailable', true);
  ok(r.desc.includes('未检测到原生主机'), 'C6 文案区分「原生主机不可用」');
  ok(r.connectDisplay === 'none', 'C6 原生不可用时不展示注定失败的按钮');
  ok(r.webDisplay !== 'none' && r.webText.includes('去模型下载面板安装'), 'C6 收口为「去模型下载面板安装」出口');
}

{
  const r = await clickConnectFailure('boom');
  ok(r.desc.includes('boom'), 'C7 透出具体错误信息');
  ok(r.connectDisabled === false, 'C7 未知异常也复位（旧实现漏复位，永久卡死）');
  ok(r.connectDisplay !== 'none', 'C7 给用户留下可重试入口');
}

{
  const r = await clickConnectFailure('native_disconnected', true);
  ok(r.desc.includes('连接中断'), 'C8 区分「原生主机连接中断」这一新增失败类型（审查 重要-1）');
}

// C9. 成功路径
{
  let rpc = null;
  const sb = buildSandbox({
    getBackendStatusViaNative: async () => ({ ok: true, nativeUnavailable: false }),
    ddNativeRpc: async (type, payload, timeoutMs) => { rpc = { type, payload, timeoutMs }; return { ok: true, installed: true }; },
  });
  sb.api.ensureYtDlpPrompt();
  await flush();
  await el(sb.doc, 'ydConnectBtn').click();
  await flush();
  ok(rpc && rpc.type === 'ytdlp.ensure', 'C9 成功路径调用 ytdlp.ensure');
  ok(rpc && rpc.timeoutMs === 180000, 'C9 超时参数为 180000ms');
  ok(el(sb.doc, 'ydConnectBtn').disabled === false, 'C9 成功后按钮状态复位');
  ok(el(sb.doc, 'ytDlpNotice').style.display === 'none', 'C9 成功后自动隐藏横幅');
}

// C10. 单飞：静默自动安装与用户点击只发一次 ytdlp.ensure（审查 重要-4）
{
  const { api, calls } = buildSandbox({
    getBackendStatusViaNative: async () => ({ ok: true, nativeUnavailable: false }),
  });
  const p1 = api.ensureYtDlpOnce();
  const p2 = api.ensureYtDlpOnce();
  ok(p1 === p2, 'C10 并发调用返回同一个在飞 Promise');
  await Promise.all([p1, p2]);
  ok(calls.rpc.length === 1, 'C10 只发出一次 ytdlp.ensure（避免并发写坏 .part）');
  const p3 = api.ensureYtDlpOnce();
  await p3;
  ok(calls.rpc.length === 2, 'C10 完成后允许再次发起（单飞不是一次性锁）');
}

// C11. 就绪 → 按钮全隐藏 + 1.5s 后自动收起横幅 + 清除失败标记
{
  const { api, doc, timers } = buildSandbox({
    checkYtDlp: async () => 'ready',
    getBackendStatusViaNative: async () => ({ ok: true, nativeUnavailable: false }),
  });
  api.ensureYtDlpPrompt();
  await flush();
  ok(el(doc, 'ydConnectBtn').style.display === 'none', 'C11 就绪时隐藏一键连接');
  ok(el(doc, 'ydStartBackendBtn').style.display === 'none', 'C11 就绪时隐藏启动后端按钮');
  ok(el(doc, 'ydTitle').textContent.includes('已就绪'), 'C11 标题显示已就绪');
  const autoHide = timers.find((t) => t.ms === 1500);
  ok(Boolean(autoHide), 'C11 就绪后安排 1.5s 自动收起横幅');
  if (autoHide) autoHide.fn();
  ok(el(doc, 'ytDlpNotice').style.display === 'none', 'C11 定时器触发后横幅确实隐藏');
}

// ---------- D. 真实 ddNativeRpc 行为（假 port 驱动）----------
console.log('\n=== D. 真实 ddNativeRpc（断开/超时/监听器清理）===');
const RPC_START_TAG = "const DD_YTDLP_NATIVE_HOST = 'com.ddayup.host';";
const RPC_END_TAG = '// ★2026-08-11：扩展加载时自动检测并启动 Ddayup Web 后端';
const rpcStart = sp.indexOf(RPC_START_TAG);
const rpcEnd = sp.indexOf(RPC_END_TAG, rpcStart);
ok(rpcStart >= 0 && rpcEnd > rpcStart, '可切出 ddNativeRpc / checkNativeYtDlp 代码段');
const rpcCode = sp.slice(rpcStart, rpcEnd);

function makeFakePort() {
  const msgListeners = [];
  const discListeners = [];
  return {
    _sent: [],
    _msgListeners: msgListeners,
    _discListeners: discListeners,
    onMessage: {
      addListener: (f) => msgListeners.push(f),
      removeListener: (f) => { const i = msgListeners.indexOf(f); if (i >= 0) msgListeners.splice(i, 1); },
    },
    onDisconnect: {
      addListener: (f) => discListeners.push(f),
      removeListener: (f) => { const i = discListeners.indexOf(f); if (i >= 0) discListeners.splice(i, 1); },
    },
    postMessage(m) { this._sent.push(m); },
    reply(m) { for (const f of [...msgListeners]) f(m); },
    disconnect() { for (const f of [...discListeners]) f(); },
  };
}

function buildRpcSandbox(ports) {
  const fakeChrome = {
    runtime: {
      connectNative() {
        const p = ports.shift();
        if (!p) throw new Error('no-port');
        return p;
      },
    },
  };
  const factory = new Function('chrome', 'setTimeout', 'clearTimeout', `
${rpcCode}
return { ddNativeRpc, checkNativeYtDlp };
`);
  return factory(fakeChrome, setTimeout, clearTimeout);
}

{
  const api = buildRpcSandbox([]);
  let err = '';
  try { await api.ddNativeRpc('x', {}, 100); } catch (e) { err = String(e && e.message); }
  ok(err === 'native_unavailable', 'D1 无原生主机时以 native_unavailable 拒绝');
}

{
  const port = makeFakePort();
  const api = buildRpcSandbox([port]);
  const p = api.ddNativeRpc('ytdlp.status', {}, 5000);
  await Promise.resolve();
  port.reply({ id: port._sent[0].id, installed: true });
  const r = await p;
  ok(r && r.installed === true, 'D2 正常应答可解析');
  // 说明：_discListeners 保留 1 个是 ddNativeConnect 自身用于重置连接状态的监听器（设计如此），
  // 这里断言的是「本次 RPC 注册的监听器已摘除」，不是数组为空。
  ok(port._msgListeners.length === 0, 'D2 成功后 onMessage 监听器已摘除（无泄漏）');
  ok(port._discListeners.length <= 1, 'D2 成功后本次 RPC 的 onDisconnect 监听器已摘除');
}

{
  const port = makeFakePort();
  const api = buildRpcSandbox([port]);
  const started = Date.now();
  const p = api.ddNativeRpc('ytdlp.ensure', {}, 60000);
  await Promise.resolve();
  port.disconnect();
  let err = '';
  try { await p; } catch (e) { err = String(e && e.message); }
  const elapsed = Date.now() - started;
  ok(err === 'native_disconnected', 'D3 端口断开以 native_disconnected 拒绝（不再静默 60s）');
  ok(elapsed < 1000, `D3 断开后立即返回（实测 ${elapsed}ms，修复前需等满 60000ms）`);
  ok(port._msgListeners.length === 0, 'D3 断开后监听器已摘除');
}

{
  const port = makeFakePort();
  const api = buildRpcSandbox([port]);
  let err = '';
  try { await api.ddNativeRpc('ytdlp.status', {}, 50); } catch (e) { err = String(e && e.message); }
  ok(err === 'native_timeout', 'D4 超时以 native_timeout 拒绝');
  ok(port._msgListeners.length === 0 && port._discListeners.length <= 1, 'D4 超时后本次 RPC 的监听器已摘除（旧实现遗留 onMessage）');
}

// ---------- E. 云端自愈安装：身份携带 + 防循环（审查 阻断-1/阻断-2 回归）----------
console.log('\n=== E. 云端自愈安装（身份 / 防循环）===');
const CLOUD_BASE = 'https://mingmingchuangyi.cn';

function makeFetchStub({ installStatus = 200, installMode = '' } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const target = String(url);
    const isInstall = target.includes('/api/health/local-post/runtime/install');
    calls.push({
      url: target,
      method: String(init.method || 'GET').toUpperCase(),
      body: init.body ? String(init.body) : '',
    });
    if (isInstall) {
      return {
        ok: installStatus >= 200 && installStatus < 300,
        status: installStatus,
        json: async () => (installMode ? { mode: installMode, error: { code: 'LICENSE_REQUIRED', message: 'x' } } : {}),
      };
    }
    // /api/health 探测：返回 yt-dlp 缺失
    return { ok: true, status: 200, json: async () => ({ capabilities: { localPostBackends: { ytdlp: { detectedPath: '' } } } }) };
  };
  fn._calls = calls;
  fn.installPosts = () => calls.filter((c) => c.url.includes('/local-post/runtime/install') && c.method === 'POST').length;
  return fn;
}

// E1. 无身份（无 deviceId、无运维 Key）→ 不发起安装请求
{
  const fetchStub = makeFetchStub();
  const sb = buildSandbox({ fetch: fetchStub });
  await sb.api.autoInstallYtDlpViaCloud(CLOUD_BASE);
  await flush(30);
  ok(fetchStub.installPosts() === 0, 'E1 无身份时【不发起】安装请求（不再匿名硬试）');
  ok(el(sb.doc, 'ydDesc').textContent.includes('云端未安装'), 'E1 给出「云端未安装」引导');
  ok(el(sb.doc, 'ydDesc').textContent.includes('登录或开启试用'), 'E1 引导明确到「登录 / 开启试用」');
}

// E2. ★防循环回归：用【真实 checkYtDlp】（不打桩）验证「渲染不触发安装、显式调用才触发」
{
  const fetchStub = makeFetchStub({ installStatus: 200 });
  const sb = buildRealCheckSandbox({
    fetch: fetchStub,
    // 关键：让结论来自【云端通道】（本机原生主机不可用 → 回退 probeWeb → /api/health 无 detectedPath）。
    // 自愈安装只挂在云端通道上，这与线上真实场景一致。
    checkNativeYtDlp: async () => ({ installed: false, nativeUnavailable: true }),
    getCloudApiBase: async () => CLOUD_BASE,
    getExtDeviceAuth: async () => ({ deviceId: 'dev-1', token: 'tok-1' }),
  });
  sb.api.refreshYtDlpNotice();
  await flush(40);
  ok(fetchStub.installPosts() === 0, 'E2 真实 checkYtDlp + 仅刷新横幅 → 0 次安装请求（渲染不触发自愈）');
  // 正向对照：证明守卫不是"永远不触发"（否则等于把功能修没了）
  await sb.api.checkYtDlp();
  await flush(20);
  ok(fetchStub.installPosts() === 1, 'E2b 正向对照：显式 checkYtDlp() 触发恰好 1 次自愈安装');
  sb.api.refreshYtDlpNotice();
  await flush(40);
  ok(fetchStub.installPosts() === 1, 'E2c 触发后再渲染仍不新增请求（循环不会复现）');
}

// E3. 显式一次自愈 + 服务端 402(expired) → 恰好 1 次，且刷新后不重试
{
  const fetchStub = makeFetchStub({ installStatus: 402, installMode: 'expired' });
  const sb = buildSandbox({
    fetch: fetchStub,
    getExtDeviceAuth: async () => ({ deviceId: 'dev-1', token: 'tok-1' }),
  });
  await sb.api.autoInstallYtDlpViaCloud(CLOUD_BASE);
  await flush(40);
  ok(fetchStub.installPosts() === 1, 'E3 被拒后只发 1 次安装请求（无热重试）');
  ok(el(sb.doc, 'ydDesc').textContent.includes('订阅'), 'E3 expired 文案引导订阅');
}

// E4. 402 且 mode=none → 文案不得说成「试用已到期」（审查 重要-3）
{
  const fetchStub = makeFetchStub({ installStatus: 402, installMode: 'none' });
  const sb = buildSandbox({
    fetch: fetchStub,
    getExtDeviceAuth: async () => ({ deviceId: 'dev-2', token: '' }),
  });
  await sb.api.autoInstallYtDlpViaCloud(CLOUD_BASE);
  await flush(20);
  const desc = el(sb.doc, 'ydDesc').textContent;
  ok(desc.includes('尚未开通试用'), 'E4 mode=none 使用「尚未开通试用」文案：' + desc.slice(0, 60));
  ok(!desc.includes('试用已到期'), 'E4 未把「从未开通」误写成「已到期」');
}

// E5. 成功路径：请求体携带 deviceId/token，URL 不含运维 Key
{
  const fetchStub = makeFetchStub({ installStatus: 200 });
  const sb = buildSandbox({
    fetch: fetchStub,
    getExtDeviceAuth: async () => ({ deviceId: 'dev-3', token: 'tok-3' }),
  });
  await sb.api.autoInstallYtDlpViaCloud(CLOUD_BASE);
  await flush(10);
  const post = fetchStub._calls.find((c) => c.url.includes('/local-post/runtime/install') && c.method === 'POST');
  ok(Boolean(post), 'E5 成功路径确实发出了安装请求');
  ok(Boolean(post) && post.body.includes('dev-3'), 'E5 请求体携带 deviceId（服务端闸门取用）');
  ok(Boolean(post) && post.body.includes('tok-3'), 'E5 请求体携带 token');
  ok(Boolean(post) && post.body.includes('"runtimeKey":"ytdlp"'), 'E5 请求体含 runtimeKey');
  ok(Boolean(post) && !post.url.includes('apiKey'), 'E5 URL 不含运维 Key');
}

// E6. 网络异常被内部消化（不向调用方抛出），且只发 1 次
{
  let posts = 0;
  const sb = buildSandbox({
    fetch: async () => { posts += 1; throw new Error('network-down'); },
    getExtDeviceAuth: async () => ({ deviceId: 'dev-4', token: '' }),
  });
  let threw = false;
  try { await sb.api.autoInstallYtDlpViaCloud(CLOUD_BASE); } catch (_) { threw = true; }
  ok(!threw, 'E6 网络异常不向外抛（侧栏不崩）');
  ok(posts === 1, 'E6 异常路径只发 1 次请求');
}

// E7. 冷却窗口：短时间内重复自愈只发 1 次（保护服务器）
{
  const fetchStub = makeFetchStub({ installStatus: 200 });
  const sb = buildSandbox({
    fetch: fetchStub,
    getExtDeviceAuth: async () => ({ deviceId: 'dev-5', token: '' }),
  });
  await sb.api.autoInstallYtDlpViaCloud(CLOUD_BASE);
  await sb.api.autoInstallYtDlpViaCloud(CLOUD_BASE);
  await sb.api.autoInstallYtDlpViaCloud(CLOUD_BASE);
  ok(fetchStub.installPosts() === 1, `E7 冷却窗口内重复调用只发 1 次安装请求（实际 ${fetchStub.installPosts()}）`);
  ok(sb.storage.getItem('hmdao_ytDlpAutoInstalling') === null, 'E7 历史布尔键被清理（不再造成永久死状态）');
}

// ---------- 汇总 ----------
console.log(`\n=== 汇总: ${pass} passed, ${fail} failed ===`);
if (fail > 0) {
  console.log('失败项:');
  for (const f of fails) console.log('  - ' + f);
  process.exitCode = 1;
}
