/**
 * 运行时写操作闸门单测（2026-09-16 收紧「匿名可触发安装」）。
 *
 * 覆盖三层：
 *  1. lib/client-ip.mjs 的取值与回环判定（含 **反代场景不得误判为本机** 这条安全断言）；
 *  2. requireRuntimeWrite 的三类放行（运维 Key / 真回环 / 已授权设备）与两类拒绝（401 NO_DEVICE、402 LICENSE_REQUIRED）；
 *  3. 静态守卫：安装等 5 个端点确实挂在闸门上，且旧的匿名放行实现（requireApiKey）已不存在。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { clientIp, isLoopbackAddress, isTrustedLoopbackRequest } from '../lib/client-ip.mjs';
import { requireRuntimeWrite } from '../routes/health.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAY = 86400000;
const now = Date.now();

// ---------- 1. client-ip ----------
describe('clientIp 取值优先级（正常/边界/异常）', () => {
  it('正常：多级 XFF 取首跳（真实客户端），而非末跳代理', () => {
    const req = { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1, 127.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } };
    expect(clientIp(req)).toBe('203.0.113.9');
  });

  it('正常：无 XFF 时回退 X-Real-IP', () => {
    const req = { headers: { 'x-real-ip': '198.51.100.7' }, socket: { remoteAddress: '127.0.0.1' } };
    expect(clientIp(req)).toBe('198.51.100.7');
  });

  it('边界：完全无代理头时回退 socket（本机直连场景）', () => {
    expect(clientIp({ headers: {}, socket: { remoteAddress: '192.168.1.20' } })).toBe('192.168.1.20');
  });

  it('异常：headers/socket 全缺失时返回 unknown 而非抛错', () => {
    expect(clientIp(null)).toBe('unknown');
    expect(clientIp({})).toBe('unknown');
    expect(clientIp({ headers: {}, socket: {} })).toBe('unknown');
  });

  it('边界：空字符串 XFF 视为无值（不得返回空串）', () => {
    expect(clientIp({ headers: { 'x-forwarded-for': '   ' }, socket: { remoteAddress: '::1' } })).toBe('::1');
  });
});

describe('isTrustedLoopbackRequest 回环判定', () => {
  it('正常：XFF 首跳为 127.0.0.1 → 视为本机', () => {
    expect(isTrustedLoopbackRequest({ headers: { 'x-forwarded-for': '127.0.0.1' } })).toBe(true);
  });

  it('★安全：反代场景（socket=127.0.0.1 但真实客户端是公网 IP）必须判定为【非本机】', () => {
    const req = { headers: { 'x-forwarded-for': '203.0.113.9' }, socket: { remoteAddress: '127.0.0.1' } };
    expect(isTrustedLoopbackRequest(req)).toBe(false);
  });

  it('边界：127.0.0.0/8 其它地址与 IPv6 映射写法也算回环', () => {
    for (const ip of ['127.0.0.2', '::1', '::ffff:127.0.0.1', '127.1.2.3']) {
      expect(isLoopbackAddress(ip)).toBe(true);
    }
  });

  it('异常：非回环/空值一律 false', () => {
    for (const ip of ['203.0.113.9', '192.168.1.1', '', null, undefined, 'unknown']) {
      expect(isLoopbackAddress(ip)).toBe(false);
    }
  });
});

// ---------- 2. requireRuntimeWrite ----------
describe('requireRuntimeWrite 闸门分支', () => {
  let DATA_DIR;
  const savedKey = process.env.HMDAO_API_KEY;

  beforeAll(async () => {
    DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'ddayup-gate-'));
    await fs.writeFile(path.join(DATA_DIR, 'extension-licenses.json'), JSON.stringify({
      devices: {
        trialDev: { deviceId: 'trialDev', trialStart: now - 1 * DAY },
        paidDev: { deviceId: 'paidDev', licenseKey: 'K', licensePlan: 'monthly', licenseActivatedAt: now - 1 * DAY },
        expiredDev: { deviceId: 'expiredDev', trialStart: now - 30 * DAY },
        noneDev: { deviceId: 'noneDev' },
      },
    }));
  });

  afterAll(async () => {
    if (DATA_DIR) await fs.rm(DATA_DIR, { recursive: true, force: true });
    if (savedKey === undefined) delete process.env.HMDAO_API_KEY;
    else process.env.HMDAO_API_KEY = savedKey;
  });

  beforeEach(() => { delete process.env.HMDAO_API_KEY; });

  const PUBLIC_REQ = { headers: { 'x-forwarded-for': '203.0.113.9' }, socket: { remoteAddress: '127.0.0.1' }, url: '/api/health/local-post/runtime/install' };
  const LOCAL_REQ = { headers: {}, socket: { remoteAddress: '127.0.0.1' }, url: '/api/health/local-post/runtime/install' };

  function makeRes() {
    return { statusCode: 0, body: null };
  }
  function makeDeps(res, dataDir = DATA_DIR) {
    return { send: (r, status, payload) => { r.statusCode = status; r.body = payload; }, DATA_DIR: dataDir };
  }

  it('正常：本机回环放行（本机开发与本地 Web 面板「一键安装」不受影响）', async () => {
    const res = makeRes();
    await expect(requireRuntimeWrite(makeDeps(res), LOCAL_REQ, res, {})).resolves.toBe(true);
    expect(res.statusCode).toBe(0);
  });

  it('正常：trial 设备放行', async () => {
    const res = makeRes();
    await expect(requireRuntimeWrite(makeDeps(res), PUBLIC_REQ, res, { deviceId: 'trialDev' })).resolves.toBe(true);
  });

  it('正常：paid 设备放行', async () => {
    const res = makeRes();
    await expect(requireRuntimeWrite(makeDeps(res), PUBLIC_REQ, res, { deviceId: 'paidDev' })).resolves.toBe(true);
  });

  it('正常：deviceId 走 query（GET 任务查询场景）同样放行', async () => {
    const res = makeRes();
    const req = { ...PUBLIC_REQ, url: '/api/health/local-post/runtime/install/job-1?deviceId=paidDev' };
    await expect(requireRuntimeWrite(makeDeps(res), req, res, {})).resolves.toBe(true);
  });

  it('正常：配置了运维 Key 且匹配时放行（无需 deviceId，供脚本/运维使用）', async () => {
    process.env.HMDAO_API_KEY = 'secret-key';
    const res = makeRes();
    const req = { ...PUBLIC_REQ, headers: { 'x-forwarded-for': '203.0.113.9', authorization: 'Bearer secret-key' } };
    await expect(requireRuntimeWrite(makeDeps(res), req, res, {})).resolves.toBe(true);
  });

  it('边界：运维 Key 也支持 ?apiKey= 形式', async () => {
    process.env.HMDAO_API_KEY = 'secret-key';
    const res = makeRes();
    const req = { ...PUBLIC_REQ, url: '/api/health/local-post/runtime/install?apiKey=secret-key' };
    await expect(requireRuntimeWrite(makeDeps(res), req, res, {})).resolves.toBe(true);
  });

  it('异常：匿名（无 deviceId、非回环）→ 401 NO_DEVICE', async () => {
    const res = makeRes();
    await expect(requireRuntimeWrite(makeDeps(res), PUBLIC_REQ, res, { runtimeKey: 'ytdlp' })).resolves.toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('NO_DEVICE');
  });

  it('★回归：即使配置了 HMDAO_API_KEY，Key 不匹配且无 deviceId 也必须拒绝（旧实现配了 Key 就放行匿名）', async () => {
    process.env.HMDAO_API_KEY = 'secret-key';
    const res = makeRes();
    const req = { ...PUBLIC_REQ, headers: { 'x-forwarded-for': '203.0.113.9', authorization: 'Bearer wrong-key' } };
    await expect(requireRuntimeWrite(makeDeps(res), req, res, {})).resolves.toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('异常：deviceId 从未试用/未付费（none）→ 402 LICENSE_REQUIRED', async () => {
    const res = makeRes();
    await expect(requireRuntimeWrite(makeDeps(res), PUBLIC_REQ, res, { deviceId: 'noneDev' })).resolves.toBe(false);
    expect(res.statusCode).toBe(402);
    expect(res.body.error.code).toBe('LICENSE_REQUIRED');
    expect(res.body.mode).toBe('none');
    expect(res.body.error.message).toContain('试用');
  });

  it('异常：试用已过期 → 402 且提示订阅', async () => {
    const res = makeRes();
    await expect(requireRuntimeWrite(makeDeps(res), PUBLIC_REQ, res, { deviceId: 'expiredDev' })).resolves.toBe(false);
    expect(res.statusCode).toBe(402);
    expect(res.body.mode).toBe('expired');
    expect(res.body.error.message).toContain('订阅');
  });

  it('异常：未知 deviceId → 402（不得因为"查不到"而放行）', async () => {
    const res = makeRes();
    await expect(requireRuntimeWrite(makeDeps(res), PUBLIC_REQ, res, { deviceId: 'ghost-device' })).resolves.toBe(false);
    expect(res.statusCode).toBe(402);
  });

  it('异常：deps 缺少 DATA_DIR → 500 GATE_MISCONFIGURED（配置错误要显式暴露，避免静默放行）', async () => {
    const res = makeRes();
    // 注意：必须显式传 null（传 undefined 会触发 makeDeps 的默认参数，测不到该分支）
    await expect(requireRuntimeWrite(makeDeps(res, null), PUBLIC_REQ, res, { deviceId: 'paidDev' })).resolves.toBe(false);
    expect(res.statusCode).toBe(500);
    expect(res.body.error.code).toBe('GATE_MISCONFIGURED');
  });
});

// ---------- 3. 静态守卫 ----------
describe('端点接线守卫（防止未来被改回匿名放行）', () => {
  const src = readFileSync(join(__dirname, '..', 'routes', 'health.mjs'), 'utf8');

  it('5 个运行时写/查询端点全部挂在新闸门上', () => {
    const wired = src.match(/await requireRuntimeWrite\(deps, req, res/g) || [];
    expect(wired.length).toBe(5);
  });

  it('旧的匿名放行实现已彻底移除（requireApiKey 不应再出现在代码里）', () => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(code).not.toContain('requireApiKey');
  });

  it('回环判定来自共享模块（不得再用 socket.remoteAddress 单判）', () => {
    expect(src).toContain("from '../lib/client-ip.mjs'");
    expect(src).not.toMatch(/socket\.remoteAddress\s*===/);
  });
});
