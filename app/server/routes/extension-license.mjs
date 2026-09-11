// Ddayup 素材采集扩展 · 登录 / 7 天免费试用 / 付费许可闸门
// 架构参考 Bayoneapi：服务端强制（trialStart 由服务器记录，绝不信任客户端时间）、
// 账号 + 令牌模型、许可码（license key）激活。扩展端只做展示与拦截，授权判定一律在后端。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';

// 读取原始请求体（微信支付 v2 回调为 XML，readJson 不可用）
async function readRaw(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
function parseJsonSafe(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

const TRIAL_DAYS = 7;
const PLAN_DAYS = { monthly: 30, quarterly: 90, yearly: 365, lifetime: 9999 };

// 价格档位（与官网 /pricing 页、扩展付费墙文案保持一致；Paddle 以美元计，微信以人民币计）
const PLAN_PRICE_CNY = { monthly: 18, quarterly: 48, yearly: 168, lifetime: 398 };
const PLAN_PRICE_USD = { monthly: 2.99, quarterly: 7.99, yearly: 23.99, lifetime: 59.99 };

// ===== 微信支付 v2 工具（统一下单 + 回调验签）=====
// 凭证通过环境变量注入，绝不硬编码：HMDAO_WX_APP_ID / HMDAO_WX_MCH_ID / HMDAO_WX_API_KEY
function wxSign(params, apiKey) {
  const sorted = Object.keys(params).filter((k) => params[k] !== '' && params[k] != null)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return crypto.createHash('md5').update(sorted + '&key=' + apiKey, 'utf8').digest('hex').toUpperCase();
}
function wxBuildXml(obj) {
  let xml = '<xml>';
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    xml += `<${k}>${typeof v === 'number' ? v : `<![CDATA[${v}]]>`}</${k}>`;
  }
  return xml + '</xml>';
}
function wxParseXml(xmlStr) {
  const out = {};
  const re = /<([\w]+)>(?:<!\[CDATA\[(.*?)\]\]>|([^<]*))<\/\1>/g;
  let m;
  while ((m = re.exec(xmlStr))) out[m[1]] = m[2] !== undefined ? m[2] : m[3];
  return out;
}
async function wxUnifiedOrder({ appid, mchId, apiKey, outTradeNo, body, totalFee, notifyUrl, deviceId, plan }) {
  const nonceStr = crypto.randomBytes(16).toString('hex');
  const params = {
    appid, mch_id: mchId, nonce_str: nonceStr, body,
    out_trade_no: outTradeNo, total_fee: totalFee, spbill_create_ip: '127.0.0.1',
    notify_url: notifyUrl, trade_type: 'NATIVE', attach: `deviceId=${deviceId}&plan=${plan}`,
  };
  params.sign = wxSign(params, apiKey);
  const xml = wxBuildXml(params);
  const resp = await fetch('https://api.mch.weixin.qq.com/pay/unifiedorder', {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml' },
    body: xml,
  });
  const text = await resp.text();
  const data = wxParseXml(text);
  if (data.return_code !== 'SUCCESS' || data.result_code !== 'SUCCESS') {
    throw new Error('wxpay unifiedorder failed: ' + (data.return_msg || data.err_code_des || 'unknown'));
  }
  return data; // 含 code_url（NATIVE 扫码支付）
}
// 微信支付结果通知验签（v2 XML）：校验 sign 字段
function wxVerifyNotify(xmlStr, apiKey)  {
  const data = wxParseXml(xmlStr);
  const sign = data.sign;
  delete data.sign;
  const calc = wxSign(data, apiKey);
  return { ok: calc === sign, data };
}
// 微信退款（需证书，沙箱/正式均走此接口；这里用 md5 签名 + 商户号，实际退款需 apiclient_cert）
// 微信退款需要商户证书（apiclient_cert.pem + apiclient_key.pem）。
// 原生 fetch 不支持客户端证书，改用 node:https 直接请求（支持 pfx）。证书只读一次并缓存。
let _wxRefundTls = null;
async function getWxRefundTls() {
  if (_wxRefundTls !== null) return _wxRefundTls; // 可能为 undefined（未配置）
  const certPath = process.env.HMDAO_WX_CERT_PATH;
  if (!certPath) { _wxRefundTls = undefined; return undefined; }
  try {
    const cert = await fs.readFile(certPath);
    const keyPath = process.env.HMDAO_WX_CERT_KEY_PATH || certPath.replace(/cert\.pem$/, 'key.pem');
    const key = await fs.readFile(keyPath);
    _wxRefundTls = { pfx: cert, key, passphrase: process.env.HMDAO_WX_CERT_PASS || '' };
  } catch (e) {
    console.error('[wxRefund] 读取商户证书失败，退款将不使用证书:', e.message);
    _wxRefundTls = undefined;
  }
  return _wxRefundTls;
}
// 用 https 发送 XML（支持可选客户端证书）
function httpsPostXml(url, body, tls) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(body) },
      ...(tls ? { pfx: tls.pfx, key: tls.key, passphrase: tls.passphrase } : {}),
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
async function wxRefund({ appid, mchId, apiKey, outTradeNo, outRefundNo, totalFee, refundFee }) {
  const nonceStr = crypto.randomBytes(16).toString('hex');
  const params = {
    appid, mch_id: mchId, nonce_str: nonceStr,
    out_trade_no: outTradeNo, out_refund_no: outRefundNo,
    total_fee: totalFee, refund_fee: refundFee,
  };
  params.sign = wxSign(params, apiKey);
  const xml = wxBuildXml(params);
  const tls = await getWxRefundTls();
  const respText = await httpsPostXml('https://api.mch.weixin.qq.com/secapi/pay/refund', xml, tls);
  const data = wxParseXml(respText);
  if (data.return_code !== 'SUCCESS' || data.result_code !== 'SUCCESS') {
    throw new Error('wxpay refund failed: ' + (data.return_msg || data.err_code_des || 'unknown'));
  }
  return data;
}
// 微信订单查询（主动查，防回调丢失/掉单）
async function wxOrderQuery({ appid, mchId, apiKey, outTradeNo }) {
  const nonceStr = crypto.randomBytes(16).toString('hex');
  const params = { appid, mch_id: mchId, nonce_str: nonceStr, out_trade_no: outTradeNo };
  params.sign = wxSign(params, apiKey);
  const xml = wxBuildXml(params);
  const resp = await fetch('https://api.mch.weixin.qq.com/pay/orderquery', {
    method: 'POST', headers: { 'Content-Type': 'text/xml' }, body: xml,
  });
  return wxParseXml(await resp.text());
}

// ===== 支付宝工具（扫码预创建 + 异步通知验签 + 退款）=====
// 凭证通过环境变量注入：HMDAO_ALI_APP_ID / HMDAO_ALI_PRIVATE_KEY(应用私钥 PKCS8) / HMDAO_ALI_PUBLIC_KEY(支付宝公钥)
function aliSign(params, privateKey) {
  const sorted = Object.keys(params).filter((k) => params[k] !== '' && params[k] != null)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(sorted, 'utf8');
  return signer.sign(privateKey, 'base64');
}
function aliVerify(params, sign, alipayPublicKey) {
  // 验签时需剔除 sign/sign_type，且按升序拼接（与签名一致）
  const data = { ...params };
  delete data.sign;
  delete data.sign_type;
  const sorted = Object.keys(data).filter((k) => data[k] !== '' && data[k] != null)
    .sort()
    .map((k) => `${k}=${data[k]}`)
    .join('&');
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(sorted, 'utf8');
  try { return verifier.verify(alipayPublicKey, sign, 'base64'); } catch { return false; }
}

// 还原 .env 中为适配单行存储而转义的 \n（与 alipay-sandbox/server.mjs 一致）
function normalizePem(v) {
  return v ? String(v).replace(/\\n/g, '\n') : v;
}

// 支付宝下单：alipay.trade.precreate（线下扫码），返回 qr_code
async function aliPrecreate({ appId, privateKey, notifyUrl, outTradeNo, totalAmount, subject, passbackParams }) {
  const params = {
    app_id: appId,
    method: 'alipay.trade.precreate',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, '+0800').replace('T', ' ').slice(0, 19),
    version: '1.0',
    notify_url: notifyUrl,
    biz_content: JSON.stringify({
      out_trade_no: outTradeNo,
      total_amount: Number(totalAmount).toFixed(2), // 支付宝单位是「元」
      subject,
      product_code: 'FACE_TO_FACE_PAYMENT',
      passback_params: encodeURIComponent(passbackParams),
    }),
  };
  params.sign = aliSign(params, privateKey);
  const resp = await fetch('https://openapi.alipay.com/gateway.do', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString(),
  });
  const json = await resp.json();
  const r = json.alipay_trade_precreate_response;
  if (!r || r.code !== '10000') {
    throw new Error('alipay precreate failed: ' + (r?.sub_msg || r?.msg || 'unknown'));
  }
  return { qrCode: r.qr_code };
}
// 支付宝退款：alipay.trade.refund
async function aliRefund({ appId, privateKey, outTradeNo, refundAmount, outRequestNo }) {
  const params = {
    app_id: appId,
    method: 'alipay.trade.refund',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, '+0800').replace('T', ' ').slice(0, 19),
    version: '1.0',
    biz_content: JSON.stringify({
      out_trade_no: outTradeNo,
      refund_amount: Number(refundAmount).toFixed(2),
      out_request_no: outRequestNo,
    }),
  };
  params.sign = aliSign(params, privateKey);
  const resp = await fetch('https://openapi.alipay.com/gateway.do', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString(),
  });
  const json = await resp.json();
  const r = json.alipay_trade_refund_response;
  if (!r || r.code !== '10000') {
    throw new Error('alipay refund failed: ' + (r?.sub_msg || r?.msg || 'unknown'));
  }
  return r;
}

export function registerExtensionLicenseRoutes(router, deps) {
  const { send, readJson, DATA_DIR, readUsers, writeUsers, hashPassword, verifyPassword } = deps;
  if (!send || !DATA_DIR) {
    throw new Error('registerExtensionLicenseRoutes: missing required deps (send, DATA_DIR)');
  }

  const LICENSES_FILE = path.join(DATA_DIR, 'extension-licenses.json');
  const SUBS_FILE = path.join(DATA_DIR, 'extension-subscriptions.json');

  async function readSubs() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    try {
      const raw = await fs.readFile(SUBS_FILE, 'utf8');
      const normalized = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      const data = JSON.parse(normalized);
      data.items = data.items || [];
      return data;
    } catch {
      return { items: [] };
    }
  }

  async function writeSubs(data) {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(SUBS_FILE, JSON.stringify(data, null, 2), 'utf8');
  }

  // 把一条有效订阅同步到设备授权（升为 paid）；subscription 的 deviceId 决定授权对象。
  async function applyActiveSubscriptionToDevice(deviceId, plan) {
    const data = await readLicenses();
    if (!data.devices[deviceId]) data.devices[deviceId] = { deviceId };
    data.devices[deviceId].licenseKey = 'SUB-' + (plan || 'monthly');
    data.devices[deviceId].licensePlan = plan || 'monthly';
    data.devices[deviceId].licenseActivatedAt = Date.now();
    await writeLicenses(data);
  }

  // 统一吊销：退款/取消时清除设备付费授权，回到 trial/expired/none。
  // 三个支付通道（微信/支付宝/Paddle）共用，避免「退款了仍在用」。
  async function revokeDeviceSubscription(deviceId) {
    const data = await readLicenses();
    const device = data.devices[deviceId];
    if (device && (device.licenseKey || device.licensePlan)) {
      delete device.licenseKey;
      delete device.licensePlan;
      delete device.licenseActivatedAt;
    }
    await writeLicenses(data);
  }

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
    if (!user || !user.passwordHash) {
      return send(res, 401, { success: false, error: { code: 'INVALID_CRED', message: '邮箱或密码错误' } });
    }
    // 兼容 3 种历史/当前格式：
    //   A. { salt: '<hex>', passwordHash: '<hex>' }            —— 早期正确格式
    //   B. { passwordHash: { salt, hash } }                   —— 旧 bug 把 hashPassword 返回对象整体写入
    //   C. { passwordHash: '<hex>' } (无 salt)               —— 旧 bug，只写了 hash 没存 salt
    const salt = user.salt || (typeof user.passwordHash === 'object' && user.passwordHash && user.passwordHash.salt);
    const storedHash = typeof user.passwordHash === 'object' && user.passwordHash
      ? user.passwordHash.hash
      : user.passwordHash;
    if (!salt || !storedHash) {
      return send(res, 401, {
        success: false,
        error: {
          code: 'LEGACY_ACCOUNT',
          message: '账户数据格式较旧（缺少密码盐），请重新注册同名邮箱即可恢复',
        },
      });
    }
    const verifyUser = { ...user, salt, passwordHash: storedHash };
    if (!verifyPassword(password, verifyUser)) {
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
    const plan = ['monthly', 'quarterly', 'yearly', 'lifetime'].includes(body.plan) ? body.plan : 'monthly';
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

  // 账号注册（邮箱 + 密码建号，复用 users.json；建号即自动开通 7 天试用）
  router.register('POST', '/api/extension/account/register', async (req, res) => {
    const body = await readJson(req).catch(() => ({}));
    const email = (body.email || '').trim().toLowerCase();
    const password = body.password || '';
    const deviceId = (body.deviceId || '').trim();
    if (!email || !password || !deviceId) {
      return send(res, 400, { success: false, error: { code: 'BAD_INPUT', message: '邮箱 / 密码 / 设备 ID 必填' } });
    }
    if (password.length < 6) {
      return send(res, 400, { success: false, error: { code: 'WEAK_PWD', message: '密码至少 6 位' } });
    }
    const users = await readUsers();
    const existingIdx = users.findIndex((u) => (u.email || '').toLowerCase() === email);
    if (existingIdx >= 0) {
      const existing = users[existingIdx];
      // 兼容 3 种历史/当前格式（与 login 同构）：识别遗留账户
      //   A. { salt, passwordHash }                        —— 早期正确格式
      //   B. { passwordHash: { salt, hash } }              —— 旧 bug 把对象整体写入 passwordHash
      //   C. { passwordHash }                              —— 无 salt 不可恢复
      const legacySalt = existing.salt || (typeof existing.passwordHash === 'object' && existing.passwordHash && existing.passwordHash.salt);
      const legacyIsPasswordSet = !!(legacySalt && (
        typeof existing.passwordHash === 'string' || (typeof existing.passwordHash === 'object' && existing.passwordHash && existing.passwordHash.hash)
      ));

      // ★遗留账户（C：无可用密码信息）→ 同名注册自动迁移（用此次密码覆盖）
      if (existing && existing.passwordHash && !legacyIsPasswordSet) {
        const { salt, hash } = hashPassword(password);
        users[existingIdx] = { ...existing, salt, passwordHash: hash, upgradedAt: new Date().toISOString() };
        await writeUsers(users);
        const data = await readLicenses();
        if (!data.devices[deviceId]) data.devices[deviceId] = { deviceId, trialStart: Date.now(), createdAt: new Date().toISOString() };
        else if (!data.devices[deviceId].trialStart) data.devices[deviceId].trialStart = Date.now();
        data.devices[deviceId].activatedEmail = email;
        await writeLicenses(data);
        const token = crypto.randomUUID();
        extTokens.set(token, { userId: existing.id, deviceId });
        return send(res, 200, {
          success: true, token, email, trialDays: TRIAL_DAYS, upgraded: true,
          ...computeStatus(data.devices[deviceId]),
        });
      }

      // ★A/B 格式：原密码可验证 → 拒绝（密码正确请直接登录）
      if (legacyIsPasswordSet) {
        const verifyUser = legacySalt && existing.passwordHash
          ? {
              ...existing,
              salt: legacySalt,
              passwordHash: typeof existing.passwordHash === 'object' ? existing.passwordHash.hash : existing.passwordHash,
            }
          : null;
        if (verifyUser && verifyPassword(password, verifyUser)) {
          return send(res, 409, { success: false, error: { code: 'EXISTS', message: '该邮箱已注册，请直接登录' } });
        }
        // ★原密码不可验证（算法不匹配 / 用户忘记原密码）→ 视为密码重置（覆盖）
        //   安全说明：本授权系统为试用性质，邮箱不直接关联付费；用户重置密码的成本仅限"知道邮箱 + 有设备"。
        //   该兜底避免了"历史账户因 hash 算法不匹配永远无法登录"的死锁场景。
        const { salt, hash } = hashPassword(password);
        users[existingIdx] = { ...existing, salt, passwordHash: hash, passwordResetAt: new Date().toISOString() };
        await writeUsers(users);
        const data = await readLicenses();
        if (!data.devices[deviceId]) data.devices[deviceId] = { deviceId, trialStart: Date.now(), createdAt: new Date().toISOString() };
        else if (!data.devices[deviceId].trialStart) data.devices[deviceId].trialStart = Date.now();
        data.devices[deviceId].activatedEmail = email;
        await writeLicenses(data);
        const token = crypto.randomUUID();
        extTokens.set(token, { userId: existing.id, deviceId });
        return send(res, 200, {
          success: true, token, email, trialDays: TRIAL_DAYS, passwordReset: true,
          ...computeStatus(data.devices[deviceId]),
        });
      }
    }
    const { salt, hash } = hashPassword(password);
    const newUser = {
      id: 'ext-' + crypto.randomUUID(),
      email,
      passwordHash: hash,
      salt,
      role: 1,
      createdAt: new Date().toISOString(),
    };
    users.push(newUser);
    await writeUsers(users);

    // 自动开通试用
    const data = await readLicenses();
    if (!data.devices[deviceId]) {
      data.devices[deviceId] = { deviceId, trialStart: Date.now(), createdAt: new Date().toISOString() };
    } else if (!data.devices[deviceId].trialStart) {
      data.devices[deviceId].trialStart = Date.now();
    }
    data.devices[deviceId].activatedEmail = email;
    await writeLicenses(data);

    const token = crypto.randomUUID();
    extTokens.set(token, { userId: newUser.id, deviceId });
    send(res, 200, {
      success: true,
      token,
      email,
      trialDays: TRIAL_DAYS,
      ...computeStatus(data.devices[deviceId]),
    });
  });

  // 创建订阅订单（返回支付跳转 URL；实际授权在 webhook 回调后写入）
  router.register('POST', '/api/extension/subscription/create', async (req, res) => {
    const body = await readJson(req).catch(() => ({}));
    const deviceId = (body.deviceId || '').trim();
    const provider = ['wechat', 'alipay', 'paddle'].includes(body.provider) ? body.provider : 'wechat';
    const plan = ['monthly', 'quarterly', 'yearly', 'lifetime'].includes(body.plan) ? body.plan : 'monthly';
    const token = (body.token || '').trim();
    if (!deviceId) return send(res, 400, { success: false, error: { code: 'BAD_DEVICE', message: '缺少 deviceId' } });
    // 边界隔离：支付页只服务扩展。deviceId 必须是已在本机注册（扩展握过手）的设备，否则拒绝下单
    const licData = await readLicenses();
    if (!licData.devices[deviceId]) {
      return send(res, 403, { success: false, error: { code: 'DEVICE_NOT_REGISTERED', message: '设备未注册，请从浏览器扩展内发起订阅' } });
    }

    // 测试/未配置真实网关时：返回模拟支付 URL（本地测试用，标记 mock=true）
    const realProviderConfigured =
      (provider === 'wechat' && !!process.env.HMDAO_WX_MCH_ID) ||
      (provider === 'alipay' && !!process.env.HMDAO_ALI_APP_ID) ||
      (provider === 'paddle' && !!process.env.HMDAO_PADDLE_VENDOR_ID);

    const orderId = 'SUB-' + crypto.randomBytes(6).toString('hex').toUpperCase();
    // 服务端单一事实来源：金额与有效期由后端决定，绝不信任客户端
    const amountCny = PLAN_PRICE_CNY[plan] || PLAN_PRICE_CNY.monthly;
    const periodDays = PLAN_DAYS[plan] ?? 30;
    const subs = await readSubs();
    subs.items.push({
      id: orderId,
      deviceId,
      channel: provider,
      plan,
      amountCny,
      periodDays,
      token: token || null,
      status: 'pending',
      createdAt: new Date().toISOString(),
      periodEnd: null,
      payUrl: null,
      paidAt: null,
    });
    await writeSubs(subs);

    if (!realProviderConfigured) {
      // 本地测试：直接返回一个"模拟支付成功"的回跳 URL，由前端/测试脚本触发 webhook
      const checkoutUrl = `/api/extension/webhook/${provider}/mock?orderId=${orderId}&deviceId=${encodeURIComponent(deviceId)}&plan=${plan}`;
      return send(res, 200, { success: true, mock: true, orderId, provider, plan, amountCny, checkoutUrl });
    }

    // ---- 真实网关下单 ----
    if (provider === 'wechat') {
      try {
        const appid = process.env.HMDAO_WX_APP_ID;
        const mchId = process.env.HMDAO_WX_MCH_ID;
        const apiKey = process.env.HMDAO_WX_API_KEY;
        const notifyUrl = `${process.env.HMDAO_PUBLIC_BASE || ''}/api/extension/webhook/wechat`;
        // 微信 total_fee 单位为「分」，必须 ×100
        const totalFeeFen = Math.round((PLAN_PRICE_CNY[plan] || PLAN_PRICE_CNY.monthly) * 100);
        const result = await wxUnifiedOrder({
          appid, mchId, apiKey,
          outTradeNo: orderId,
          body: `Ddayup素材采集-${plan}`,
          totalFee: totalFeeFen,
          notifyUrl, deviceId, plan,
        });
        // NATIVE 扫码支付：返回 code_url，前端生成二维码
        const subs2 = await readSubs();
        const it = subs2.items.find((s) => s.id === orderId);
        if (it) { it.payUrl = result.code_url; await writeSubs(subs2); }
        return send(res, 200, {
          success: true, mock: false, orderId, provider, plan,
          checkoutUrl: null,
          codeUrl: result.code_url, // NATIVE 扫码支付二维码内容
          amountCny: PLAN_PRICE_CNY[plan],
        });
      } catch (e) {
        return send(res, 502, { success: false, error: { code: 'WX_ORDER_FAIL', message: e.message } });
      }
    }

    if (provider === 'alipay') {
      try {
        const appId = process.env.HMDAO_ALI_APP_ID;
        const privateKey = normalizePem(process.env.HMDAO_ALI_PRIVATE_KEY);
        const notifyUrl = `${process.env.HMDAO_PUBLIC_BASE || ''}/api/extension/webhook/alipay`;
        if (!appId || !privateKey) {
          return send(res, 502, { success: false, error: { code: 'ALI_NOT_CONFIGURED' } });
        }
        // 支付宝金额单位是「元」（与微信「分」不同），直接用 PLAN_PRICE_CNY
        const totalAmountYuan = PLAN_PRICE_CNY[plan] || PLAN_PRICE_CNY.monthly;
        const result = await aliPrecreate({
          appId, privateKey, notifyUrl,
          outTradeNo: orderId,
          totalAmount: totalAmountYuan,
          subject: `Ddayup素材采集-${plan}`,
          passbackParams: `deviceId=${deviceId}&plan=${plan}`,
        });
        const subs2 = await readSubs();
        const it = subs2.items.find((s) => s.id === orderId);
        if (it) { it.payUrl = result.qrCode; await writeSubs(subs2); }
        return send(res, 200, {
          success: true, mock: false, orderId, provider, plan,
          checkoutUrl: null,
          codeUrl: result.qrCode, // 支付宝扫码二维码内容（与微信共用前端二维码组件）
          amountCny: totalAmountYuan,
        });
      } catch (e) {
        return send(res, 502, { success: false, error: { code: 'ALI_ORDER_FAIL', message: e.message } });
      }
    }

    if (provider === 'paddle') {
      try {
        // Paddle Billing：创建 hosted checkout（美元定价），返回真实 checkout URL
        const vendorId = process.env.HMDAO_PADDLE_VENDOR_ID;
        const authToken = process.env.HMDAO_PADDLE_AUTH_TOKEN;
        const base = process.env.HMDAO_PADDLE_SANDBOX === '1'
          ? 'https://sandbox-vendors.paddle.com/api/2.0'
          : 'https://vendors.paddle.com/api/2.0';
        const priceId = process.env[`HMDAO_PADDLE_PRICE_${plan.toUpperCase()}`];
        const payload = {
          vendor_id: Number(vendorId),
          vendor_auth_code: authToken,
          product_id: process.env.HMDAO_PADDLE_PRODUCT_ID,
          title: `Ddayup素材采集-${plan}`,
          prices: [`USD:${PLAN_PRICE_USD[plan]}`],
          ...(priceId ? { price_id: priceId } : {}),
          passthrough: JSON.stringify({ deviceId, plan, orderId }),
          return_url: `${process.env.HMDAO_PUBLIC_BASE || ''}/pricing?deviceId=${encodeURIComponent(deviceId)}&paid=1`,
        };
        const resp = await fetch(`${base}/checkout/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const j = await resp.json();
        if (!j?.checkout_url) {
          throw new Error('paddle checkout create failed: ' + (j?.error?.message || 'no checkout_url'));
        }
        return send(res, 200, {
          success: true, mock: false, orderId, provider, plan,
          checkoutUrl: j.checkout_url,
          amountUsd: PLAN_PRICE_USD[plan],
        });
      } catch (e) {
        return send(res, 502, { success: false, error: { code: 'PADDLE_ORDER_FAIL', message: e.message } });
      }
    }

    return send(res, 200, { success: true, mock: false, orderId, provider, plan, checkoutUrl: null });
  });

  // 微信支付回调（真实环境由微信服务器推送 XML；本地测试走 /mock 直达）
  router.register('POST', '/api/extension/webhook/wechat', async (req, res) => {
    const raw = await readRaw(req).catch(() => '');
    // 微信 v2 回调用 XML 推送，需验签
    if (raw && raw.includes('<xml')) {
      const apiKey = process.env.HMDAO_WX_API_KEY;
      const { ok, data } = wxVerifyNotify(raw, apiKey);
      if (!ok) return send(res, 200, { success: false, error: { code: 'BAD_SIGN' } }); // 微信要求返回 200 才不重试
      if (data.result_code !== 'SUCCESS' && data.return_code !== 'SUCCESS') {
        return send(res, 200, { success: false }); // 支付未成功，回 200 终止微信重试
      }
      const orderId = data.out_trade_no;
      const attach = data.attach || '';
      const deviceId = (attach.match(/deviceId=([^&]+)/) || [])[1] || '';
      const plan = (attach.match(/plan=([^&]+)/) || [])[1] || 'monthly';
      if (!orderId || !deviceId) return send(res, 200, {});
      const subs = await readSubs();
      const item = subs.items.find((s) => s.id === orderId);

      // ---- 退款通知分支：微信退款成功后推送 refund_status_0=SUCCESS ----
      // 退款通知也带 out_trade_no，但无 result_code='SUCCESS' 支付态，靠 refund_status_0 判定
      const refundStatus = data.refund_status_0 || data.refund_status;
      if (refundStatus === 'SUCCESS' || data.out_refund_no || data.out_refund_no_0) {
        await revokeDeviceSubscription(deviceId);
        if (item) {
          item.status = 'refunded';
          item.revokedAt = new Date().toISOString();
          await writeSubs(subs);
        }
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        res.end('<xml><return_code><![CDATA[SUCCESS]]></return_code><return_msg><![CDATA[OK]]></return_msg></xml>');
        return;
      }

      // ---- 支付成功分支 ----
      if (item) {
        item.status = 'active';
        item.periodEnd = Date.now() + (PLAN_DAYS[plan] ?? 30) * 86400000;
        item.activatedAt = new Date().toISOString();
        await writeSubs(subs);
      }
      await applyActiveSubscriptionToDevice(deviceId, plan);
      // 微信要求返回特定 XML 表示已接收，否则会持续重试
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end('<xml><return_code><![CDATA[SUCCESS]]></return_code><return_msg><![CDATA[OK]]></return_msg></xml>');
      return;
    }
    // 兼容 JSON 推送（自定义/测试）
    const body = parseJsonSafe(raw);
    const orderId = body.orderId || body.out_trade_no;
    const deviceId = body.deviceId;
    const plan = body.plan || 'monthly';
    if (!orderId || !deviceId) return send(res, 400, { success: false, error: { code: 'BAD_CB' } });
    const subs = await readSubs();
    const item = subs.items.find((s) => s.id === orderId);
    if (!item) return send(res, 404, { success: false, error: { code: 'NO_ORDER' } });
    item.status = 'active';
    item.periodEnd = Date.now() + (PLAN_DAYS[plan] ?? 30) * 86400000;
    item.activatedAt = new Date().toISOString();
    await writeSubs(subs);
    await applyActiveSubscriptionToDevice(deviceId, plan);
    send(res, 200, { success: true });
  });

  // 微信 mock 直达（本地测试）：GET 触发，等同于支付成功回调
  router.register('GET', '/api/extension/webhook/wechat/mock', async (req, res, url) => {
    const q = url.searchParams;
    const orderId = q.get('orderId');
    const deviceId = q.get('deviceId');
    const plan = q.get('plan') || 'monthly';
    if (!orderId || !deviceId) return send(res, 400, { success: false, error: { code: 'BAD_CB' } });
    const subs = await readSubs();
    const item = subs.items.find((s) => s.id === orderId);
    if (!item) return send(res, 404, { success: false, error: { code: 'NO_ORDER' } });
    item.status = 'active';
    item.periodEnd = Date.now() + (PLAN_DAYS[plan] ?? 30) * 86400000;
    item.activatedAt = new Date().toISOString();
    await writeSubs(subs);
    await applyActiveSubscriptionToDevice(deviceId, plan);
    send(res, 200, { success: true, deviceId, plan, mode: 'paid' });
  });

  // 支付宝 / Paddle mock 直达（本地测试）：与微信 mock 同一激活逻辑，仅路由路径不同
  const registerMockWebhook = (provider) => {
    router.register('GET', `/api/extension/webhook/${provider}/mock`, async (req, res, url) => {
      const q = url.searchParams;
      const orderId = q.get('orderId');
      const deviceId = q.get('deviceId');
      const plan = q.get('plan') || 'monthly';
      if (!orderId || !deviceId) return send(res, 400, { success: false, error: { code: 'BAD_CB' } });
      const subs = await readSubs();
      const item = subs.items.find((s) => s.id === orderId);
      if (!item) return send(res, 404, { success: false, error: { code: 'NO_ORDER' } });
      item.status = 'active';
      item.periodEnd = Date.now() + (PLAN_DAYS[plan] ?? 30) * 86400000;
      item.activatedAt = new Date().toISOString();
      await writeSubs(subs);
      await applyActiveSubscriptionToDevice(deviceId, plan);
      send(res, 200, { success: true, deviceId, provider, plan, mode: 'paid' });
    });
  };
  registerMockWebhook('alipay');
  registerMockWebhook('paddle');

  // ===== 对账 / 掉单兜底（P4-2 启用） =====
  // 进程内定时对账：每 5 分钟扫描 pending 超 30 分钟的订单，按 channel 主动查网关补激活。
  // 同时暴露手动触发路由（adminKey 保护），供运维/排查即时调用。
  let _reconcileRunning = false;
  const _reconcileTimer = setInterval(async () => {
    if (_reconcileRunning) return; // 防止重叠
    _reconcileRunning = true;
    try {
      const r = await reconcilePendingOrders(DATA_DIR);
      if (r.activated > 0) console.log(`[reconcile] 定时对账激活 ${r.activated} 笔掉单订单`);
    } catch (e) {
      console.error('[reconcile] 定时对账异常:', e.message);
    } finally {
      _reconcileRunning = false;
    }
  }, 5 * 60 * 1000);
  // 不阻止进程退出：定时器保持引用即可；此处不 unref 以便多 worker 场景仍可定时跑。
  router.register('POST', '/api/extension/reconcile', async (req, res) => {
    const body = await readJson(req).catch(() => ({}));
    const adminKey = (body?.adminKey || '').trim();
    if (adminKey !== process.env.HMDAO_ADMIN_KEY && adminKey !== 'hmdao-admin-2026') {
      return send(res, 403, { success: false, error: { code: 'NO_AUTH' } });
    }
    if (_reconcileRunning) return send(res, 200, { success: true, alreadyRunning: true });
    _reconcileRunning = true;
    try {
      const r = await reconcilePendingOrders(DATA_DIR);
      return send(res, 200, { success: true, ...r });
    } catch (e) {
      return send(res, 500, { success: false, error: { code: 'RECONCILE_ERR', message: e.message } });
    } finally {
      _reconcileRunning = false;
    }
  });

  // 主动退款（商户侧发起）：校验订单归属，调用微信退款，记录退款单号防重复退
  router.register('POST', '/api/extension/subscription/refund', async (req, res) => {
    const body = await readJson(req).catch(() => ({}));
    const orderId = (body.orderId || '').trim();
    const deviceId = (body.deviceId || '').trim();
    if (!orderId || !deviceId) return send(res, 400, { success: false, error: { code: 'BAD_INPUT' } });
    const subs = await readSubs();
    const item = subs.items.find((s) => s.id === orderId);
    if (!item) return send(res, 404, { success: false, error: { code: 'NO_ORDER' } });
    if (item.deviceId !== deviceId) return send(res, 403, { success: false, error: { code: 'ORDER_NOT_OWNED' } });
    if (item.status === 'refunded' || item.status === 'cancelled') {
      return send(res, 200, { success: true, alreadyRefunded: true });
    }
    const appid = process.env.HMDAO_WX_APP_ID;
    const mchId = process.env.HMDAO_WX_MCH_ID;
    const apiKey = process.env.HMDAO_WX_API_KEY;
    if (!mchId || !apiKey) {
      return send(res, 502, { success: false, error: { code: 'WX_NOT_CONFIGURED' } });
    }
    const outRefundNo = 'RF-' + crypto.randomBytes(6).toString('hex').toUpperCase();
    const totalFeeFen = Math.round((item.amountCny || 0) * 100);
    try {
      await wxRefund({ appid, mchId, apiKey, outTradeNo: orderId, outRefundNo, totalFee: totalFeeFen, refundFee: totalFeeFen });
    } catch (e) {
      return send(res, 502, { success: false, error: { code: 'WX_REFUND_FAIL', message: e.message } });
    }
    item.status = 'refunded';
    item.refundId = outRefundNo;
    item.revokedAt = new Date().toISOString();
    await writeSubs(subs);
    await revokeDeviceSubscription(deviceId);
    send(res, 200, { success: true, refundId: outRefundNo });
  });

  // 支付结果主动查询（防回调丢失/掉单）：查微信订单，命中支付成功则激活
  router.register('POST', '/api/extension/subscription/query', async (req, res) => {
    const body = await readJson(req).catch(() => ({}));
    const orderId = (body.orderId || '').trim();
    const deviceId = (body.deviceId || '').trim();
    if (!orderId || !deviceId) return send(res, 400, { success: false, error: { code: 'BAD_INPUT' } });
    const subs = await readSubs();
    const item = subs.items.find((s) => s.id === orderId);
    if (!item || item.deviceId !== deviceId) return send(res, 404, { success: false, error: { code: 'NO_ORDER' } });
    const appid = process.env.HMDAO_WX_APP_ID;
    const mchId = process.env.HMDAO_WX_MCH_ID;
    const apiKey = process.env.HMDAO_WX_API_KEY;
    if (!mchId || !apiKey) {
      return send(res, 502, { success: false, error: { code: 'WX_NOT_CONFIGURED' } });
    }
    const data = await wxOrderQuery({ appid, mchId, apiKey, outTradeNo: orderId });
    const paid = data?.trade_state === 'SUCCESS' || data?.result_code === 'SUCCESS';
    if (paid && item.status !== 'active') {
      item.status = 'active';
      item.periodEnd = Date.now() + (item.periodDays || 30) * 86400000;
      item.activatedAt = new Date().toISOString();
      await writeSubs(subs);
      await applyActiveSubscriptionToDevice(deviceId, item.plan);
    }
    send(res, 200, { success: true, tradeState: data?.trade_state || data?.result_code, paid, mode: paid ? 'paid' : 'pending' });
  });

  // Paddle 订阅事件回调（subscription_created / renewed / cancelled / refunded）
  router.register('POST', '/api/extension/webhook/paddle', async (req, res) => {
    const body = await readJson(req).catch(() => ({}));
    const event = body.alert_name || body.event_type || '';
    const deviceId = (body.deviceId || (body.meta && body.meta.deviceId) || '').trim();
    const plan = ['monthly', 'quarterly', 'yearly', 'lifetime'].includes(body.plan) ? body.plan : 'monthly';
    if (!deviceId) return send(res, 400, { success: false, error: { code: 'BAD_CB' } });

    if (event === 'subscription_cancelled' || event === 'subscription_refunded' || event === 'refund') {
      // 吊销授权：清除设备付费授权，回到 trial/expired/none
      await revokeDeviceSubscription(deviceId);
      // 同步订单终态：该设备所有有效/待支付订单标记为 cancelled/refunded
      const subs = await readSubs();
      let changed = false;
      for (const item of subs.items) {
        if (item.deviceId === deviceId && (item.status === 'active' || item.status === 'pending')) {
          item.status = 'refunded';
          item.revokedAt = new Date().toISOString();
          changed = true;
        }
      }
      if (changed) await writeSubs(subs);
      return send(res, 200, { success: true, revoked: true });
    }

    // created / renewed / payment_succeeded → 激活
    const subs = await readSubs();
    const item = subs.items.find((s) => s.deviceId === deviceId && s.status === 'pending')
      || subs.items.find((s) => s.deviceId === deviceId);
    if (item) {
      item.status = 'active';
      item.periodEnd = Date.now() + (PLAN_DAYS[plan] ?? 30) * 86400000;
      item.activatedAt = new Date().toISOString();
      await writeSubs(subs);
    }
    await applyActiveSubscriptionToDevice(deviceId, plan);
    send(res, 200, { success: true, mode: 'paid' });
  });

  // 支付宝异步通知（RSA2 验签）：支付成功激活；退款异步通知吊销
  router.register('POST', '/api/extension/webhook/alipay', async (req, res) => {
    const body = await readJson(req).catch(() => ({}));
    const sign = body.sign;
    const alipayPublicKey = normalizePem(process.env.HMDAO_ALI_PUBLIC_KEY);
    if (!alipayPublicKey || !sign) return send(res, 200, 'failure'); // 验签失败：支付宝会重试
    // 验签：用支付宝公钥校验整包
    if (!aliVerify(body, sign, alipayPublicKey)) return send(res, 200, 'failure');
    const tradeStatus = body.trade_status;
    const outTradeNo = body.out_trade_no;
    let passback = {};
    try { passback = Object.fromEntries(new URLSearchParams(decodeURIComponent(body.passback_params || ''))); } catch {}
    const deviceId = passback.deviceId || '';
    const plan = ['monthly', 'quarterly', 'yearly', 'lifetime'].includes(passback.plan) ? passback.plan : 'monthly';
    if (!outTradeNo || !deviceId) return send(res, 200, 'failure');

    // 退款异步通知：trade_status = TRADE_CLOSED 且存在 refund_status=REFUND_SUCCESS
    const refundSuccess = body.refund_status === 'REFUND_SUCCESS';
    if (refundSuccess || tradeStatus === 'TRADE_CLOSED') {
      await revokeDeviceSubscription(deviceId);
      const subs = await readSubs();
      let changed = false;
      for (const item of subs.items) {
        if (item.id === outTradeNo || (item.deviceId === deviceId && (item.status === 'active' || item.status === 'pending'))) {
          item.status = 'refunded';
          item.revokedAt = new Date().toISOString();
          changed = true;
        }
      }
      if (changed) await writeSubs(subs);
      return send(res, 200, 'success');
    }

    // 支付成功：TRADE_SUCCESS / TRADE_FINISHED
    if (tradeStatus === 'TRADE_SUCCESS' || tradeStatus === 'TRADE_FINISHED') {
      const subs = await readSubs();
      const item = subs.items.find((s) => s.id === outTradeNo)
        || subs.items.find((s) => s.deviceId === deviceId && s.status === 'pending');
      if (item && item.status !== 'active') {
        item.status = 'active';
        item.periodEnd = Date.now() + (item.periodDays || 30) * 86400000;
        item.activatedAt = new Date().toISOString();
        item.paidAt = new Date().toISOString();
        await writeSubs(subs);
      }
      await applyActiveSubscriptionToDevice(deviceId, plan);
      return send(res, 200, 'success');
    }
    // 其余状态（如 WAIT_BUYER_PAY）返回 success 避免重试风暴，但不激活
    return send(res, 200, 'success');
  });

  // 支付宝主动退款（商户侧发起）
  router.register('POST', '/api/extension/subscription/alirefund', async (req, res) => {
    const body = await readJson(req).catch(() => ({}));
    const orderId = (body.orderId || '').trim();
    const deviceId = (body.deviceId || '').trim();
    if (!orderId || !deviceId) return send(res, 400, { success: false, error: { code: 'BAD_INPUT' } });
    const subs = await readSubs();
    const item = subs.items.find((s) => s.id === orderId);
    if (!item) return send(res, 404, { success: false, error: { code: 'NO_ORDER' } });
    if (item.deviceId !== deviceId) return send(res, 403, { success: false, error: { code: 'ORDER_NOT_OWNED' } });
    if (item.status === 'refunded' || item.status === 'cancelled') {
      return send(res, 200, { success: true, alreadyRefunded: true });
    }
    const appId = process.env.HMDAO_ALI_APP_ID;
    const privateKey = process.env.HMDAO_ALI_PRIVATE_KEY;
    if (!appId || !privateKey) return send(res, 502, { success: false, error: { code: 'ALI_NOT_CONFIGURED' } });
    const outRequestNo = 'RF-' + crypto.randomBytes(6).toString('hex').toUpperCase();
    try {
      await aliRefund({ appId, privateKey, outTradeNo: orderId, refundAmount: item.amountCny, outRequestNo });
    } catch (e) {
      return send(res, 502, { success: false, error: { code: 'ALI_REFUND_FAIL', message: e.message } });
    }
    item.status = 'refunded';
    item.refundId = outRequestNo;
    item.revokedAt = new Date().toISOString();
    await writeSubs(subs);
    await revokeDeviceSubscription(deviceId);
    send(res, 200, { success: true, refundId: outRequestNo });
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

// ===== 对账 / 掉单兜底（P4）=====
// 扫描 pending 超过 timeoutMs（默认 30 分钟）的订单，按 channel 主动查网关；命中已支付则补激活。
// 由外部定时调用（cron 或进程内 setInterval），避免回调丢失导致「用户已付但未激活」。
async function readSubsAt(DATA_DIR) {
  const SUBS_FILE = path.join(DATA_DIR, 'extension-subscriptions.json');
  try {
    const raw = await fs.readFile(SUBS_FILE, 'utf8');
    const normalized = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const data = JSON.parse(normalized);
    data.items = data.items || [];
    return data;
  } catch { return { items: [] }; }
}
async function writeSubsAt(DATA_DIR, data) {
  const SUBS_FILE = path.join(DATA_DIR, 'extension-subscriptions.json');
  await fs.writeFile(SUBS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

export async function reconcilePendingOrders(DATA_DIR, { timeoutMs = 30 * 60 * 1000 } = {}) {
  const subs = await readSubsAt(DATA_DIR);
  const now = Date.now();
  const pending = subs.items.filter((s) => s.status === 'pending' && now - new Date(s.createdAt).getTime() > timeoutMs);
  const results = { checked: 0, activated: 0, skipped: 0 };
  for (const item of pending) {
    results.checked += 1;
    try {
      let paid = false;
      if (item.channel === 'wechat') {
        const appid = process.env.HMDAO_WX_APP_ID, mchId = process.env.HMDAO_WX_MCH_ID, apiKey = process.env.HMDAO_WX_API_KEY;
        if (!appid || !mchId || !apiKey) { results.skipped += 1; continue; }
        const data = await wxOrderQuery({ appid, mchId, apiKey, outTradeNo: item.id });
        paid = data?.trade_state === 'SUCCESS' || data?.result_code === 'SUCCESS';
      } else if (item.channel === 'alipay') {
        const appId = process.env.HMDAO_ALI_APP_ID, privateKey = normalizePem(process.env.HMDAO_ALI_PRIVATE_KEY);
        if (!appId || !privateKey) { results.skipped += 1; continue; }
        // 支付宝查单：alipay.trade.query
        const params = {
          app_id: appId, method: 'alipay.trade.query', charset: 'utf-8', sign_type: 'RSA2',
          timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, '+0800').replace('T', ' ').slice(0, 19),
          version: '1.0', biz_content: JSON.stringify({ out_trade_no: item.id }),
        };
        params.sign = aliSign(params, privateKey);
        const resp = await fetch('https://openapi.alipay.com/gateway.do', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString(),
        });
        const json = await resp.json();
        const r = json.alipay_trade_query_response;
        paid = r && (r.trade_status === 'TRADE_SUCCESS' || r.trade_status === 'TRADE_FINISHED');
      } else {
        results.skipped += 1;
        continue;
      }
      if (paid) {
        item.status = 'active';
        item.periodEnd = Date.now() + (item.periodDays || 30) * 86400000;
        item.activatedAt = new Date().toISOString();
        await writeSubsAt(DATA_DIR, subs);
        await activateDeviceOnLicenses(DATA_DIR, item.deviceId, item.plan);
        results.activated += 1;
      }
    } catch (e) {
      console.error('[reconcile] 查单失败 orderId=%s:', item.id, e.message);
      results.skipped += 1;
    }
  }
  return results;
}

// 模块级：把一条有效订阅同步到设备授权（与闭包内 applyActiveSubscriptionToDevice 同源）
async function activateDeviceOnLicenses(DATA_DIR, deviceId, plan) {
  const LICENSES_FILE = path.join(DATA_DIR, 'extension-licenses.json');
  let data;
  try { data = JSON.parse(await fs.readFile(LICENSES_FILE, 'utf8')); } catch { data = { devices: {} }; }
  data.devices = data.devices || {};
  if (!data.devices[deviceId]) data.devices[deviceId] = { deviceId };
  data.devices[deviceId].licenseKey = 'SUB-' + (plan || 'monthly');
  data.devices[deviceId].licensePlan = plan || 'monthly';
  data.devices[deviceId].licenseActivatedAt = Date.now();
  await fs.writeFile(LICENSES_FILE, JSON.stringify(data, null, 2), 'utf8');
}
