// Ddayup 素材采集扩展 · 登录 / 7 天免费试用 / 付费许可闸门
// 架构参考 Bayoneapi：服务端强制（trialStart 由服务器记录，绝不信任客户端时间）、
// 账号 + 令牌模型、许可码（license key）激活。扩展端只做展示与拦截，授权判定一律在后端。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const TRIAL_DAYS = 7;
const PLAN_DAYS = { monthly: 30, yearly: 365, lifetime: 9999 };

export function registerExtensionLicenseRoutes(router, deps) {
  const { send, readJson, DATA_DIR, readUsers, writeUsers, hashPassword, verifyPassword } = deps;
  if (!send || !DATA_DIR) {
    throw new Error('registerExtensionLicenseRoutes: missing required deps (send, DATA_DIR)');
  }

  const LICENSES_FILE = path.join(DATA_DIR, 'extension-licenses.json');

  async function readLicenses() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    try {
      const raw = await fs.readFile(LICENSES_FILE, 'utf8');
      const normalized = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      const data = JSON.parse(normalized);
      data.devices = data.devices || {};
      data.licenseKeys = data.licenseKeys || {};
      return data;
    } catch {
      return { devices: {}, licenseKeys: {} };
    }
  }

  async function writeLicenses(data) {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(LICENSES_FILE, JSON.stringify(data, null, 2), 'utf8');
  }

  function normalizeKey(k) {
    return (k || '').trim().toUpperCase().replace(/\s+/g, '');
  }

  // 纯函数：根据设备记录推导当前授权状态（服务端单一事实来源）
  function computeStatus(device) {
    const now = Date.now();
    if (device.licenseKey && device.licensePlan) {
      const days = PLAN_DAYS[device.licensePlan] ?? 0;
      const paidUntil = (device.licenseActivatedAt || now) + days * 86400000;
      if (device.licensePlan === 'lifetime' || paidUntil > now) {
        return {
          mode: 'paid',
          plan: device.licensePlan,
          paidUntil,
          email: device.activatedEmail || null,
        };
      }
    }
    if (device.trialStart) {
      const trialEndsAt = device.trialStart + TRIAL_DAYS * 86400000;
      if (trialEndsAt > now) {
        return {
          mode: 'trial',
          trialEndsAt,
          trialDaysLeft: Math.max(0, Math.ceil((trialEndsAt - now) / 86400000)),
          email: device.activatedEmail || null,
        };
      }
      return { mode: 'expired', trialEndsAt, email: device.activatedEmail || null };
    }
    return { mode: 'none' };
  }

  // 轻量令牌表（进程内存；重启需重新登录，符合 Bayoneapi 的会话/令牌思路）
  const extTokens = new Map(); // token -> { userId, deviceId }

  // 查授权状态
  router.register('POST', '/api/extension/license/status', async (req, res) => {
    const body = await readJson(req).catch(() => ({}));
    const deviceId = (body.deviceId || '').trim();
    if (!deviceId) return send(res, 400, { success: false, error: { code: 'BAD_DEVICE', message: '缺少 deviceId' } });
    const data = await readLicenses();
    const device = data.devices[deviceId] || { deviceId };
    const status = computeStatus(device);
    send(res, 200, { success: true, trialDays: TRIAL_DAYS, ...status });
  });

  // 启动试用（服务端计时，幂等：已存在则不重置）
  router.register('POST', '/api/extension/trial/start', async (req, res) => {
    const body = await readJson(req).catch(() => ({}));
    const deviceId = (body.deviceId || '').trim();
    if (!deviceId) return send(res, 400, { success: false, error: { code: 'BAD_DEVICE' } });
    const data = await readLicenses();
    if (!data.devices[deviceId]) {
      data.devices[deviceId] = { deviceId, trialStart: Date.now(), createdAt: new Date().toISOString() };
    }
    await writeLicenses(data);
    send(res, 200, { success: true, trialDays: TRIAL_DAYS, ...computeStatus(data.devices[deviceId]) });
  });

  // 账号登录（复用 users.json；登录即启动试用，trialStart 由服务器记录）
  router.register('POST', '/api/extension/account/login', async (req, res) => {
    const body = await readJson(req).catch(() => ({}));
    const email = (body.email || '').trim().toLowerCase();
    const password = body.password || '';
    const deviceId = (body.deviceId || '').trim();
    if (!email || !password || !deviceId) {
      return send(res, 400, { success: false, error: { code: 'BAD_INPUT', message: '邮箱 / 密码 / 设备 ID 必填' } });
    }
    const users = await readUsers();
    const user = users.find((u) => (u.email || '').toLowerCase() === email);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return send(res, 401, { success: false, error: { code: 'INVALID_CRED', message: '邮箱或密码错误' } });
    }
    const data = await readLicenses();
    if (!data.devices[deviceId]) data.devices[deviceId] = { deviceId };
    if (!data.devices[deviceId].trialStart) data.devices[deviceId].trialStart = Date.now();
    data.devices[deviceId].activatedEmail = email;
    await writeLicenses(data);
    const token = crypto.randomUUID();
    extTokens.set(token, { userId: user.id, deviceId });
    send(res, 200, {
      success: true,
      token,
      email,
      trialDays: TRIAL_DAYS,
      ...computeStatus(data.devices[deviceId]),
    });
  });

  // 激活付费许可码
  router.register('POST', '/api/extension/license/activate', async (req, res) => {
    const body = await readJson(req).catch(() => ({}));
    const deviceId = (body.deviceId || '').trim();
    const key = normalizeKey(body.key);
    if (!deviceId || !key) return send(res, 400, { success: false, error: { code: 'BAD_INPUT' } });
    const data = await readLicenses();
    const entry = data.licenseKeys[key];
    if (!entry) return send(res, 400, { success: false, error: { code: 'INVALID_KEY', message: '激活码无效' } });
    if (entry.redeemedBy && entry.redeemedBy !== deviceId) {
      return send(res, 400, { success: false, error: { code: 'KEY_USED', message: '该激活码已被其他设备使用' } });
    }
    if (!data.devices[deviceId]) data.devices[deviceId] = { deviceId };
    data.devices[deviceId].licenseKey = key;
    data.devices[deviceId].licensePlan = entry.plan;
    data.devices[deviceId].licenseActivatedAt = Date.now();
    if (body.email) data.devices[deviceId].activatedEmail = body.email;
    entry.redeemedBy = deviceId;
    entry.redeemedAt = new Date().toISOString();
    if (body.email) entry.email = body.email;
    await writeLicenses(data);
    send(res, 200, { success: true, trialDays: TRIAL_DAYS, ...computeStatus(data.devices[deviceId]) });
  });

  // 管理端：签发激活码（需 adminKey；后续可接入 Bayoneapi 控制面 / 支付回调自动签发）
  router.register('POST', '/api/extension/license/issue', async (req, res) => {
    const body = await readJson(req).catch(() => ({}));
    const adminKey = body.adminKey || '';
    const expect = process.env.HMDAO_LICENSE_ADMIN_KEY || 'hmdao-admin-2026';
    if (adminKey !== expect) return send(res, 403, { success: false, error: { code: 'FORBIDDEN' } });
    const plan = ['monthly', 'yearly', 'lifetime'].includes(body.plan) ? body.plan : 'monthly';
    const key = 'DDAYUP-' + crypto.randomBytes(8).toString('hex').toUpperCase();
    const data = await readLicenses();
    data.licenseKeys[normalizeKey(key)] = {
      key,
      plan,
      createdAt: new Date().toISOString(),
      redeemedBy: null,
      redeemedAt: null,
      notes: body.notes || '',
    };
    await writeLicenses(data);
    send(res, 200, { success: true, key, plan });
  });

  // 原生主机握手：供 Edge 扩展（方案 A）查询本机 yt-dlp 状态。
  // 仅新增只读接口，不改动既有授权逻辑；原生主机由用户单独安装，本接口只做状态探测。
  let detectYtDlpStatus = null;
  if (typeof deps.detectYtDlpStatus === 'function') {
    detectYtDlpStatus = deps.detectYtDlpStatus;
  }
  router.register('GET', '/api/extension/native/status', async (_req, res) => {
    if (!detectYtDlpStatus) {
      return send(res, 200, {
        success: true,
        nativeHost: false,
        ytdlp: { installed: false, version: null, path: null, note: 'detectYtDlpStatus 未注入' },
      });
    }
    try {
      const info = await detectYtDlpStatus();
      send(res, 200, { success: true, nativeHost: true, ytdlp: info });
    } catch (err) {
      send(res, 200, {
        success: true,
        nativeHost: true,
        ytdlp: { installed: false, version: null, path: null, note: String(err && err.message || err) },
      });
    }
  });
}
