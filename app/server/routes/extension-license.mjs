// Ddayup 素材采集扩展 · 登录 / 7 天免费试用 / 付费许可闸门
// 架构参考 Bayoneapi：服务端强制（trialStart 由服务器记录，绝不信任客户端时间）、
// 账号 + 令牌模型、许可码（license key）激活。扩展端只做展示与拦截，授权判定一律在后端。
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import { migrateLicenses } from '../lib/license-schema.mjs';
import { clientIp } from '../lib/client-ip.mjs';
// 支付凭证统一从 pay-credentials.mjs 读取（单一事实来源，便于集中排查与自检）
import {
  getAliCredentials,
  getWxCredentials,
  getPaddleCredentials,
  getPaddlePriceId,
  getPublicBase,
  isProviderConfigured,
} from '../lib/pay-credentials.mjs';

// 设备上限 / 多端冲突判定（纯函数，独立可单测）。
// devices: 全部设备字典；email/deviceId 为当前请求账号与该设备；maxDevices 为上限。
// 返回 null 表示放行；否则返回可直接 send 的错误对象（status/error）。
export function checkDeviceCapLogic(devices, email, deviceId, maxDevices) {
  const owned = Object.values(devices).filter((d) => d.activatedEmail === email);
  const isNewDevice = !devices[deviceId] || devices[deviceId].activatedEmail !== email;
  if (!isNewDevice) return null; // 本设备已在该账号下，放行
  if (owned.length >= maxDevices) {
    return {
      status: 403,
      error: {
        code: 'DEVICE_LIMIT',
        message: `该账号最多绑定 ${maxDevices} 台设备，请先解绑旧设备`,
        maxDevices,
        devices: owned.map((d) => ({ deviceId: d.deviceId, mode: 'unknown' })),
      },
    };
  }
  if (owned.length > 0) {
    return {
      status: 409,
      error: {
        code: 'NEW_DEVICE_CONFLICT',
        message: '该账号已在其他设备登录，是否踢出旧设备继续？',
        maxDevices,
        devices: owned.map((d) => ({ deviceId: d.deviceId, mode: 'unknown' })),
      },
    };
  }
  return null;
}

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

// 读取 application/x-www-form-urlencoded 请求体（支付宝异步通知正是此格式）。
// ★坑点：deps 注入的 readJson 只做 JSON.parse，解析表单会抛错并被 catch 成 {}，
//   导致 body.sign 恒为 undefined、异步通知永远答 failure —— 结果是「用户付款成功却不激活」。
async function readForm(req) {
  const raw = await readRaw(req);
  return raw ? Object.fromEntries(new URLSearchParams(raw)) : {};
}

// 纯文本应答：支付宝/微信要求回调返回纯文本 success，而不是 JSON 字符串。
// deps 的 send() 固定 JSON.stringify + application/json，会把 'success' 变成带引号的 "success"。
function replyText(res, text) {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

// 邮箱格式校验（与官网 /api/auth/register 的 auth-utils.isValidLocalEmail 保持一致，
// 确保扩展端注册与官网注册对邮箱的判定规则统一）。
function isValidLocalEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim().toLowerCase());
}

const TRIAL_DAYS = 7;
const PLAN_DAYS = { monthly: 30, quarterly: 90, yearly: 365, lifetime: 9999 };

// 价格档位（与官网 /pricing 页、扩展付费墙文案保持一致；Paddle 以美元计，微信以人民币计）
// ★单一事实来源：前端 PricingPage / SubscribePage 一律通过 GET /api/extension/plans 读取本表，
//   严禁在前端硬编码价格（此前曾出现前端写死 ¥120/¥500 而后端实收 ¥168/¥398 的计费不一致）。
const PLAN_PRICE_CNY = { monthly: 18, quarterly: 48, yearly: 168, lifetime: 498 };
const PLAN_PRICE_USD = { monthly: 2.99, quarterly: 7.99, yearly: 23.99, lifetime: 59.99 };
const PLAN_NAMES = {
  monthly: { zh: '基础版', en: 'Basic' },
  quarterly: { zh: '季度版', en: 'Quarterly' },
  yearly: { zh: '专业版', en: 'Pro' },
  lifetime: { zh: '豪华版', en: 'Deluxe' },
};
// 档位展示顺序（决定前端卡片排列）
const PLAN_ORDER = ['monthly', 'quarterly', 'yearly', 'lifetime'];

// ===== 可复用的授权状态计算（供 OCR / 其他受限接口做闸口，单一事实来源）=====
// 直接读取与 registerExtensionLicenseRoutes 相同的 extension-licenses.json。
export async function readExtensionLicenses(DATA_DIR) {
  const file = path.join(DATA_DIR, 'extension-licenses.json');
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(file, 'utf8');
    const normalized = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const data = JSON.parse(normalized);
    data.devices = data.devices || {};
    data.licenseKeys = data.licenseKeys || {};
    return data;
  } catch {
    return { devices: {}, licenseKeys: {} };
  }
}

// 订阅订单读取（供「订阅随账号」解析复用，与闭包内 readSubs 同源同结构）
export async function readExtensionSubscriptions(DATA_DIR) {
  const file = path.join(DATA_DIR, 'extension-subscriptions.json');
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(file, 'utf8');
    const normalized = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const data = JSON.parse(normalized);
    data.items = data.items || [];
    return data;
  } catch {
    return { items: [] };
  }
}

// ★账号级订阅解析（2026-09-13）：订阅「随账号」而非「随单台设备」。
// 用户在 A 设备购买后，用同一账号在 B 设备登录，B 同样应获得授权（S5 全链路要求）。
// 仅返回仍处于有效期内的 active 订阅中到期日最远的一条；无有效订阅返回 null。
// devices 仅用于兼容早期订单（下单时未记录 email）：回落到下单设备的绑定邮箱。
export function resolveAccountPaid(subs, email, devices) {
  const target = String(email || '').trim().toLowerCase();
  if (!target) return null;
  let best = null;
  for (const it of (subs && subs.items) || []) {
    if (it.status !== 'active') continue;
    let owner = String(it.email || '').trim().toLowerCase();
    if (!owner && devices && it.deviceId) {
      owner = String((devices[it.deviceId] || {}).activatedEmail || '').trim().toLowerCase();
    }
    if (owner !== target) continue;
    const end = Number(it.periodEnd || 0);
    if (end && end <= Date.now()) continue;
    if (!best || end > Number(best.periodEnd || 0)) best = it;
  }
  if (!best) return null;
  return { mode: 'paid', plan: best.plan, paidUntil: Number(best.periodEnd), email: target, source: 'account' };
}

// 纯函数：根据设备记录推导当前授权状态（mode: none | trial | paid | expired）
export function computeExtensionStatus(device) {
  const now = Date.now();
  if (device.licenseKey && device.licensePlan) {
    const days = PLAN_DAYS[device.licensePlan] ?? 0;
    const paidUntil = (device.licenseActivatedAt || now) + days * 86400000;
    if (device.licensePlan === 'lifetime' || paidUntil > now) {
      return { mode: 'paid', plan: device.licensePlan, paidUntil, email: device.activatedEmail || null };
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

// 服务端授权闸口判定（单一事实来源，供 OCR / 媒体下载代理等受限接口复用）。
// 返回 { entitled, mode, status }：
//   entitled === true  → trial 或 paid，放行
//   entitled === false → none / expired（或缺少设备标识），拒绝
// 与 /api/extension/license/status 完全同源（共用 readExtensionLicenses + computeExtensionStatus）。
export async function checkExtensionEntitlement(DATA_DIR, deviceId) {
  const id = String(deviceId || '').trim();
  if (!id) return { entitled: false, mode: 'none', reason: 'NO_DEVICE', status: { mode: 'none' } };
  const data = await readExtensionLicenses(DATA_DIR);
  const device = data.devices[id] || {};
  let st = computeExtensionStatus(device);
  // 自身无付费授权时，继承同账号下的有效订阅（订阅随账号）
  if (st.mode !== 'paid') {
    const subs = await readExtensionSubscriptions(DATA_DIR);
    const acc = resolveAccountPaid(subs, device.activatedEmail, data.devices);
    if (acc) st = acc;
  }
  const entitled = st.mode === 'trial' || st.mode === 'paid';
  return { entitled, mode: st.mode, status: st };
}

// 续费顺延：返回新的 licenseActivatedAt。
// 规则：当前授权仍有效（paidUntil > now）时，在旧到期日之上叠加新周期，不丢失剩余时长；否则从 now 起算。
// computeExtensionStatus 由 licenseActivatedAt + PLAN_DAYS 推算 paidUntil，故只需把 licenseActivatedAt 设为 base，
// 即可得到「base + 新周期」的到期日（实现「续费不吞剩余天数」）。lifetime(9999天) 恒有效，自然顺延。
export function computeRenewalActivationStart(device, now = Date.now()) {
  const plan = device.licensePlan;
  if (plan && PLAN_DAYS[plan] != null) {
    const start = device.licenseActivatedAt || 0;
    const curUntil = start + PLAN_DAYS[plan] * 86400000;
    if (curUntil > now) return curUntil; // 仍有效 → 在旧到期日上顺延
  }
  // ★试用期内订阅：以「试用到期日」为起点顺延订阅周期，让用户不丢剩余试用天数。
  //   例：试用第 3 天买月付 → paidUntil = 试用第 7 天 + 30 天（而非订阅当天 +30 天）。
  //   （已付费续费走上面的分支，同样不吞剩余天数；lifetime 恒有效，不受影响。）
  if (device.trialStart) {
    const trialEndsAt = device.trialStart + TRIAL_DAYS * 86400000;
    if (trialEndsAt > now) return trialEndsAt;
  }
  return now;
}

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
  // ★微信成功时 return_code/result_code 均为 SUCCESS；业务失败(result_code=FAIL)时
  //   真实错误在 err_code/err_code_des，而 return_msg 恒为 'OK'（通信层描述，不可信）。
  //   此前误用 return_msg 拼错误信息，把真实失败掩盖成 "failed: OK"，无法定位根因。
  if (data.return_code !== 'SUCCESS' || data.result_code !== 'SUCCESS') {
    const err = new Error(
      `wxpay unifiedorder failed: ${data.err_code_des || data.return_msg || 'unknown'}` +
      (data.err_code ? ` (err_code=${data.err_code}, return_code=${data.return_code}, result_code=${data.result_code})` : '')
    );
    err.wxReturnCode = data.return_code;
    err.wxResultCode = data.result_code;
    err.wxErrCode = data.err_code;
    err.wxErrCodeDes = data.err_code_des;
    throw err;
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
  const wx = getWxCredentials();
  const certPath = wx.certPath;
  if (!certPath) { _wxRefundTls = undefined; return undefined; }
  try {
    const cert = await fs.readFile(certPath);
    const keyPath = wx.certKeyPath || certPath.replace(/cert\.pem$/, 'key.pem');
    const key = await fs.readFile(keyPath);
    _wxRefundTls = { pfx: cert, key, passphrase: wx.certPass || '' };
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
  const key = crypto.createPrivateKey(privateKey); // 兼容 PKCS1 / PKCS8（与 alipay-sandbox 实现一致）
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(sorted, 'utf8');
  return signer.sign(key, 'base64');
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

// 支付宝网关：默认走真实网关（生产），仅当 HMDAO_ALI_SANDBOX==='1' 时切沙箱
// （与 Paddle 的 HMDAO_PADDLE_SANDBOX 开关行为一致，用于替换此前散落的硬编码网关）。
export function aliGateway() {
  return getAliCredentials().sandbox
    ? 'https://openapi.alipaydev.com/gateway.do'
    : 'https://openapi.alipay.com/gateway.do';
}

// 支付宝要求 timestamp 为 yyyy-MM-dd HH:mm:ss（本地时间 / 东八区）。
// 此前用 toISOString() 取到的是 UTC，且 '+0800' 又被 slice(0,19) 截掉，
// 实际比北京时间早 8 小时，超过支付宝时间窗校验会被拒单。
// （alipay-sandbox/server.mjs 已明确按本地时间构造并留有注释，此处与之对齐。）
export function aliTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 支付宝下单：alipay.trade.precreate（线下扫码），返回 qr_code
export async function aliPrecreate({ appId, privateKey, notifyUrl, outTradeNo, totalAmount, subject, passbackParams }) {
  const params = {
    app_id: appId,
    method: 'alipay.trade.precreate',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: aliTimestamp(),
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
  const resp = await fetch(aliGateway(), {
    method: 'POST',
    // ★必须显式声明 charset=utf-8：否则支付宝按非 UTF-8 解码 biz_content，
    //   中文(商品标题)失真会导致服务端签名校验不通过，返回 40002（invalid-signature）。
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body: new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString(),
  });
  const json = await resp.json();
  const r = json.alipay_trade_precreate_response;
  if (!r || r.code !== '10000') {
    const err = new Error('alipay precreate failed: ' + (r?.sub_msg || r?.msg || 'unknown'));
    // 结构化透传支付宝错误码/描述：aliCode 为 undefined 表示网络层或解析层失败，而非支付宝业务拒绝
    err.aliCode = r?.code;
    err.aliSubMsg = r?.sub_msg || r?.msg;
    throw err;
  }
  return { qrCode: r.qr_code };
}
// 支付宝下单：alipay.trade.page.pay（电脑网站支付），返回可跳转的完整支付页 GET URL。
// ★为何有两条下单路径：本项目已开通的是「电脑网站支付」，而当面付 precreate 尚未签约，
//   直接调用会返回 40004 ACCESS_FORBIDDEN。故默认走本接口（返回支付页 URL 由前端新窗口打开）；
//   待当面付签约通过后，把 HMDAO_ALI_PAY_METHOD 设为 precreate 即可切回扫码二维码。
// ★注意：page.pay 不接受 product_code（FACE_TO_FACE_PAYMENT 是当面付专属字段，携带会被拒单）。
// ★charset=utf-8 必须作为参数参与签名，GET 查询串同样按 UTF-8 百分号编码。
export async function aliPagePay({ appId, privateKey, notifyUrl, returnUrl, outTradeNo, totalAmount, subject, passbackParams }) {
  const params = {
    app_id: appId,
    method: 'alipay.trade.page.pay',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: aliTimestamp(),
    version: '1.0',
    notify_url: notifyUrl,
    ...(returnUrl ? { return_url: returnUrl } : {}),
    biz_content: JSON.stringify({
      out_trade_no: outTradeNo,
      total_amount: Number(totalAmount).toFixed(2), // 支付宝单位是「元」
      subject,
      // ★电脑网站支付也有自己的销售产品码且为必填：FAST_INSTANT_TRADE_PAY。
      //  （FACE_TO_FACE_PAYMENT 是当面付专属，两者不可混用；缺失会返回 INVALID_PARAMETER 错误页）
      product_code: 'FAST_INSTANT_TRADE_PAY',
      passback_params: encodeURIComponent(passbackParams),
    }),
  };
  params.sign = aliSign(params, privateKey);
  // ★GET 查询串必须逐项 encodeURIComponent：空格要编码成 %20，
  //   而 URLSearchParams 用的是表单规则（空格→'+'），支付宝按 query 解析会得到
  //   '2026-09-15+00:42:11'，与签名原文不一致，最终返回错误页 INVALID_PARAMETER。
  const query = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return { payUrl: `${aliGateway()}?${query}` };
}
// 支付宝查单：alipay.trade.query（下单轮询、兜底查单、对账共用，避免重复实现）。
// 交易不存在（用户尚未付款）属正常状态，返回空对象由调用方按 trade_status 判定为未支付。
export async function aliOrderQuery({ appId, privateKey, outTradeNo }) {
  const params = {
    app_id: appId,
    method: 'alipay.trade.query',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: aliTimestamp(),
    version: '1.0',
    biz_content: JSON.stringify({ out_trade_no: outTradeNo }),
  };
  params.sign = aliSign(params, privateKey);
  const resp = await fetch(aliGateway(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body: new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString(),
  });
  const json = await resp.json();
  return json.alipay_trade_query_response || {};
}

// 支付宝退款：alipay.trade.refund
async function aliRefund({ appId, privateKey, outTradeNo, refundAmount, outRequestNo }) {
  const params = {
    app_id: appId,
    method: 'alipay.trade.refund',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: aliTimestamp(),
    version: '1.0',
    biz_content: JSON.stringify({
      out_trade_no: outTradeNo,
      refund_amount: Number(refundAmount).toFixed(2),
      out_request_no: outRequestNo,
    }),
  };
  params.sign = aliSign(params, privateKey);
  const resp = await fetch(aliGateway(), {
    method: 'POST',
    // ★必须显式声明 charset=utf-8：否则支付宝按非 UTF-8 解码 biz_content，
    //   中文(商品标题)失真会导致服务端签名校验不通过，返回 40002（invalid-signature）。
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
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
  const { send, readJson, DATA_DIR, readUsers, writeUsers, hashPassword, verifyPassword, getUserFromRequest } = deps;
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

  // 订单幂等 / 垃圾回收策略（解决「侧栏待支付订单重复堆积」）：
  //   - PENDING_REUSE_MS ：同设备 + 同档位在该窗口内已有 pending 单则复用，不再新建
  //   - PENDING_EXPIRE_MS：超过该时长仍未支付的 pending 视为垃圾，下单时自动回收
  const PENDING_REUSE_MS = 30 * 60 * 1000;
  const PENDING_EXPIRE_MS = 30 * 60 * 1000;

  // 下单失败回滚：仅删除仍处于 pending 的订单。
  // ★已 active / refunded 的订单绝不能删——那是用户已付款买到的授权，误删等于吞钱。
  async function dropPendingOrder(orderId) {
    try {
      const s = await readSubs();
      const before = s.items.length;
      s.items = s.items.filter((x) => !(x.id === orderId && x.status === 'pending'));
      if (s.items.length !== before) {
        await writeSubs(s);
        console.log('[sub] 下单失败已回滚 pending 订单:', orderId);
      }
    } catch (e) {
      console.error('[sub] 回滚 pending 订单失败:', orderId, e.message);
    }
  }

  // 把一条有效订阅同步到设备授权（升为 paid）；subscription 的 deviceId 决定授权对象。
  // 续费顺延：以当前有效授权的到期日为基点叠加新周期，不丢失剩余时长。
  async function applyActiveSubscriptionToDevice(deviceId, plan) {
    const data = await readLicenses();
    if (!data.devices[deviceId]) data.devices[deviceId] = { deviceId };
    const base = computeRenewalActivationStart(data.devices[deviceId], Date.now());
    data.devices[deviceId].licenseKey = 'SUB-' + (plan || 'monthly');
    data.devices[deviceId].licensePlan = plan || 'monthly';
    data.devices[deviceId].licenseActivatedAt = base;
    await writeLicenses(data);
    recordExtensionEvent('pay_success', { deviceId, plan: plan || 'monthly', email: data.devices[deviceId].activatedEmail });
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
      migrateLicenses(data); // 读取即迁移补齐字段 + 置 schemaVersion
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

  // 单一事实来源：闭包内状态推导直接复用导出的 computeExtensionStatus，
  // 彻底消除「闭包版 / 导出版」两份实现长期漂移导致 OCR 闸门与服务端状态不一致的风险。
  function computeStatus(device) {
    return computeExtensionStatus(device);
  }

  // 吊销某台设备持有的全部令牌（踢下线 / 解绑时调用）
  function revokeTokensFor(deviceId) {
    for (const [tok, info] of extTokens) {
      if (info.deviceId === deviceId) extTokens.delete(tok);
    }
    scheduleTokensFlush(); // 同步落盘，保证重启后不会「复活」已吊销的令牌
  }

  // 设备授权状态（含账号级订阅继承）：自身无付费授权时继承同账号有效订阅，
  // 保证「A 设备购买 → B 设备登录同账号 → B 也是 paid」。
  async function statusFor(data, device) {
    const own = computeExtensionStatus(device);
    if (own.mode === 'paid' || !device || !device.activatedEmail) return own;
    const subs = await readSubs();
    return resolveAccountPaid(subs, device.activatedEmail, data.devices) || own;
  }

  // 设备上限 / 多端冲突判定。
  // force=true：用户已确认「踢出旧设备继续」，先解除同账号其他设备的绑定并吊销其令牌，再放行。
  // 传 force 时允许突破 MAX_DEVICES（属用户显式操作，且被踢设备保留自身已购授权）。
  async function resolveCap(data, email, deviceId, force) {
    const cap = checkDeviceCap(data, email, deviceId);
    if (!cap) return null;
    // 未带 force：保留原契约（409 提示用户确认 / 403 已达上限），不静默踢设备。
    if (!force) return cap;
    // 带 force（用户已确认）：账号名额未满时多设备共存；仅在超限时踢出最早绑定的设备腾位。
    const owned = Object.values(data.devices)
      .filter((d) => d.activatedEmail === email && d.deviceId !== deviceId);
    const room = Math.max(0, MAX_DEVICES - 1); // 本设备自身占用 1 个名额
    const kick = owned.length - room;
    if (kick > 0) {
      owned
        .slice()
        .sort((a, b) => Number(a.trialStart || 0) - Number(b.trialStart || 0))
        .slice(0, kick)
        .forEach((d) => { d.activatedEmail = null; revokeTokensFor(d.deviceId); });
    }
    return null;
  }

  // ===== 扩展令牌表 =====
  // ★2026-09-14：由「纯进程内存」改为「内存缓存 + 落盘」。
  //   原实现下后端一重启（部署/崩溃恢复）所有令牌即失效、全体用户被踢下线，
  //   表现为扩展账号面板提示「未登录或令牌已失效，请重新登录」。
  //   现启动时同步载入磁盘快照，写入/删除后防抖落盘（300ms）；校验仍是纯内存读，不引入 IO 延迟。
  const extTokens = new Map(); // token -> { userId, deviceId }
  const TOKENS_FILE = path.join(DATA_DIR, 'extension-tokens.json');
  let tokensFlushTimer = null;

  // 启动时同步载入（仅在注册路由时执行一次；文件不存在即空表，与旧行为一致）
  try {
    const raw = fsSync.readFileSync(TOKENS_FILE, 'utf8');
    const normalized = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const obj = JSON.parse(normalized);
    for (const [tok, info] of Object.entries(obj || {})) {
      if (info && typeof info === 'object' && info.deviceId) {
        extTokens.set(tok, { userId: info.userId || '', deviceId: info.deviceId });
      }
    }
  } catch { /* 首次启动无快照文件 */ }

  function scheduleTokensFlush() {
    if (tokensFlushTimer) return;
    tokensFlushTimer = setTimeout(() => {
      tokensFlushTimer = null;
      const obj = {};
      for (const [tok, info] of extTokens) obj[tok] = info;
      fsSync.mkdirSync(DATA_DIR, { recursive: true });
      fsSync.writeFileSync(TOKENS_FILE, JSON.stringify(obj, null, 2), 'utf8');
    }, 300);
    tokensFlushTimer.unref?.();
  }

  function rememberToken(token, info) { extTokens.set(token, info); scheduleTokensFlush(); }
  function forgetToken(token) { extTokens.delete(token); scheduleTokensFlush(); }

  // ===== 扩展端登录 / 注册限流（与官网 auth.mjs 同构，但为独立进程内 Map）=====
  // 多实例水平扩展时应改为 Redis 计数器；当前单进程足够。
  const EXT_MAX_FAILS = 5;            // 同邮箱连续失败 5 次锁定
  const EXT_LOCK_MS = 15 * 60 * 1000; // 锁定 15 分钟
  const EXT_LOGIN_PER_MIN = 20;       // 同 IP 每分钟登录尝试上限
  const EXT_REG_PER_HOUR = 5;         // 同 IP 每小时注册尝试上限
  const extLoginFails = new Map();    // email -> { count, lockedUntil }
  const extLoginIp = new Map();       // ip -> { count, resetAt }
  const extRegIp = new Map();         // ip -> { count, resetAt }
  // ★2026-09-16：客户端 IP 取法统一收敛到 lib/client-ip.mjs（原先与 routes/auth.mjs
  //   各写一份等价实现；XFF 首跳语义保持不变，避免反代场景把 127.0.0.1 当成用户 IP）。
  function slidingWindow(map, key, windowMs, now = Date.now()) {
    const st = map.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > st.resetAt) { st.count = 0; st.resetAt = now + windowMs; }
    st.count += 1;
    map.set(key, st);
    return st;
  }

  // 账号级设备上限（可在 hmdao-api 进程通过 HMDAO_MAX_DEVICES 覆盖）
  const MAX_DEVICES = Number(process.env.HMDAO_MAX_DEVICES || 3);

  // 设备概要（用于列表/冲突提示返回，避免泄露敏感字段）
  function deviceSummary(d, subs, devices) {
    let st = computeExtensionStatus(d);
    if (st.mode !== 'paid') {
      const acc = resolveAccountPaid(subs, d && d.activatedEmail, devices);
      if (acc) st = acc;
    }
    return {
      deviceId: d.deviceId,
      mode: st.mode,
      plan: st.plan || null,
      trialEndsAt: st.trialEndsAt || null,
      paidUntil: st.paidUntil || null,
    };
  }

  // 设备上限 / 多端冲突判定（委派给纯函数 checkDeviceCapLogic，再做字段富化）。
  function checkDeviceCap(data, email, deviceId) {
    const decision = checkDeviceCapLogic(data.devices, email, deviceId, MAX_DEVICES);
    if (!decision) return null;
    return {
      status: decision.status,
      error: {
        ...decision.error,
        devices: (decision.error.devices || []).map((x) => deviceSummary(data.devices[x.deviceId] || { deviceId: x.deviceId })),
      },
    };
  }

  // ===== 转化漏斗埋点（轻量 NDJSON 追加写 + 内存缓冲，按阈值落盘，不引入外部分析服务）=====
  const eventsBuffer = [];
  const EVENT_FLUSH = 20;
  const EVENTS_FILE = path.join(DATA_DIR, 'extension-events.json');
  function recordExtensionEvent(type, payload) {
    try {
      eventsBuffer.push(JSON.stringify({ t: Date.now(), type, ...(payload || {}) }));
      if (eventsBuffer.length >= EVENT_FLUSH) flushEvents();
    } catch (_) {}
  }
  function flushEvents() {
    if (!eventsBuffer.length) return;
    try {
      fsSync.appendFileSync(EVENTS_FILE, eventsBuffer.join('\n') + '\n');
      eventsBuffer.length = 0;
    } catch (_) {}
  }
  function readEvents() {
    try {
      const raw = fsSync.readFileSync(EVENTS_FILE, 'utf8').trim();
      if (!raw) return [];
      return raw.split('\n')
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch { return []; }
  }

  // 后台 admin 鉴权（复用既有的 adminKey 机制，未配置即 403）
  function requireAdmin(req, res, url) {
    const params = url.searchParams;
    const akey = params.get('key') || (req.headers && req.headers['x-admin-key']) || '';
    const expected = process.env.HMDAO_LICENSE_ADMIN_KEY || '';
    if (!expected || akey !== expected) { send(res, 403, { success: false, error: { code: 'FORBIDDEN' } }); return false; }
    return true;
  }

  // ===== deviceToken Bearer 中间件 =====
  // 从 Authorization: Bearer <token> 或请求体 token 字段读取令牌，校验 extTokens 表。
  // 匿名接口（login/register/status/activate/plans/trial/start）不调用本函数。
  // 返回 { userId, deviceId } 或 null（已发送 401 响应）。
  function requireToken(req, res, body) {
    const auth = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    const token = m ? m[1].trim() : (body && body.token ? String(body.token).trim() : '');
    if (!token) {
      send(res, 401, { success: false, error: { code: 'NO_TOKEN', message: '缺少访问令牌，请先登录' } });
      return null;
    }
    const info = extTokens.get(token);
    if (!info) {
      send(res, 401, { success: false, error: { code: 'BAD_TOKEN', message: '令牌无效或已过期，请重新登录' } });
      return null;
    }
    return info;
  }

  // 查授权状态
  router.register('POST', '/api/extension/license/status', async (req, res) => {
    const body = await readJson(req).catch(() => ({}));
    const deviceId = (body.deviceId || '').trim();
    if (!deviceId) return send(res, 400, { success: false, error: { code: 'BAD_DEVICE', message: '缺少 deviceId' } });
    const data = await readLicenses();
    const device = data.devices[deviceId] || { deviceId };
    const status = await statusFor(data, device);
    send(res, 200, { success: true, trialDays: TRIAL_DAYS, ...status });
  });

  // 公开：套餐价格单一真源。前端 PricingPage / SubscribePage 必须从此读取，禁止前端硬编码金额。
  router.register('GET', '/api/extension/plans', async (req, res) => {
    const plans = PLAN_ORDER.map((id) => ({
      id,
      name: PLAN_NAMES[id],
      priceCny: PLAN_PRICE_CNY[id],
      priceUsd: PLAN_PRICE_USD[id],
      days: PLAN_DAYS[id],
    }));
    send(res, 200, { success: true, plans });
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
    send(res, 200, { success: true, trialDays: TRIAL_DAYS, ...(await statusFor(data, data.devices[deviceId])) });
  });

  // 账号登录（复用 users.json；登录即启动试用，trialStart 由服务器记录）
  router.register('POST', '/api/extension/account/login', async (req, res) => {
    // ---- 限流 / 失败锁定（与官网 auth.mjs 同构，独立进程内 Map）----
    const loginIp = clientIp(req);
    const lip = slidingWindow(extLoginIp, loginIp, 60_000);
    if (lip.count > EXT_LOGIN_PER_MIN) {
      return send(res, 429, { success: false, error: { code: 'RATE_LIMIT', message: '请求过于频繁，请稍后再试' } });
    }
    const body = await readJson(req).catch(() => ({}));
    const email = (body.email || '').trim().toLowerCase();
    const password = body.password || '';
    const deviceId = (body.deviceId || '').trim();
    if (!email || !password || !deviceId) {
      return send(res, 400, { success: false, error: { code: 'BAD_INPUT', message: '邮箱 / 密码 / 设备 ID 必填' } });
    }
    const users = await readUsers();
    const user = users.find((u) => (u.email || '').toLowerCase() === email);
    // 账户维度失败锁定：仅对真实存在的账户计数，避免对不存在邮箱的暴力枚举放大
    if (user && user.passwordHash) {
      const acct = extLoginFails.get(email) || { count: 0, lockedUntil: 0 };
      if (acct.lockedUntil > Date.now()) {
        const remainMin = Math.ceil((acct.lockedUntil - Date.now()) / 60_000);
        return send(res, 429, { success: false, error: { code: 'ACCOUNT_LOCKED', message: `账户已临时锁定，请 ${remainMin} 分钟后再试` } });
      }
    }
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
      // 失败计数 + 锁定（仅针对存在的账户）
      const acct = extLoginFails.get(email) || { count: 0, lockedUntil: 0 };
      acct.count += 1;
      if (acct.count >= EXT_MAX_FAILS) acct.lockedUntil = Date.now() + EXT_LOCK_MS;
      extLoginFails.set(email, acct);
      const remain = EXT_MAX_FAILS - acct.count;
      return send(res, 401, {
        success: false,
        error: {
          code: 'INVALID_CRED',
          message: remain > 0
            ? `邮箱或密码错误，还可尝试 ${remain} 次`
            : '密码错误次数过多，账户已锁定 15 分钟',
        },
      });
    }
    // 成功：清零失败计数
    extLoginFails.delete(email);
    const data = await readLicenses();
    // 设备上限 / 多端冲突判定（仅对新设备生效，老设备可继续登录）
    // force=true：用户已在 UI 确认「踢出旧设备继续」，先解绑同账号其他设备再放行。
    const cap = await resolveCap(data, email, deviceId, body.force === true || body.force === 'true');
    if (cap) return send(res, cap.status, { success: false, error: cap.error });
    if (!data.devices[deviceId]) data.devices[deviceId] = { deviceId };
    const isNewDevice = !data.devices[deviceId].trialStart && !data.devices[deviceId].licensePlan;
    if (!data.devices[deviceId].trialStart) data.devices[deviceId].trialStart = Date.now();
    data.devices[deviceId].activatedEmail = email;
    await writeLicenses(data);
    recordExtensionEvent('login', { email, deviceId });
    if (isNewDevice) recordExtensionEvent('device_bound', { email, deviceId });
    const token = crypto.randomUUID();
    rememberToken(token, { userId: user.id, deviceId });
    send(res, 200, {
      success: true,
      token,
      email,
      trialDays: TRIAL_DAYS,
      ...(await statusFor(data, data.devices[deviceId])),
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
      const oldDev = data.devices[entry.redeemedBy];
      const stillActive = oldDev && oldDev.licenseKey === key; // 旧设备仍绑定且未解绑
      if (stillActive) {
        // 旧设备仍在线：需先在「我的设备」中解绑，再激活新设备（激活码换绑流程）
        return send(res, 400, {
          success: false,
          error: {
            code: 'NEED_UNBIND',
            message: '该激活码已绑定其他设备，请先在原设备「我的设备」中解绑后再激活',
            oldDeviceId: entry.redeemedBy,
          },
        });
      }
      // 旧设备已解绑 / 不存在 → 允许换绑到本设备
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
    recordExtensionEvent('activation', { deviceId, plan: entry.plan, email: data.devices[deviceId].activatedEmail });
    send(res, 200, { success: true, trialDays: TRIAL_DAYS, ...(await statusFor(data, data.devices[deviceId])) });
  });

  // 管理端：签发激活码（需 adminKey；后续可接入 Bayoneapi 控制面 / 支付回调自动签发）
  router.register('POST', '/api/extension/license/issue', async (req, res) => {
    const body = await readJson(req).catch(() => ({}));
    const adminKey = body.adminKey || '';
    // 必须配置强口令环境变量；未配置时一律拒绝，杜绝默认弱口令后门。
    const expect = process.env.HMDAO_LICENSE_ADMIN_KEY;
    if (!expect || adminKey !== expect) return send(res, 403, { success: false, error: { code: 'FORBIDDEN' } });
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
    // ---- IP 维度限流：同 IP 每小时最多 EXT_REG_PER_HOUR 次注册尝试（防批量注册/爆破）----
    const regIp = clientIp(req);
    const rip = slidingWindow(extRegIp, regIp, 3600_000);
    if (rip.count > EXT_REG_PER_HOUR) {
      return send(res, 429, { success: false, error: { code: 'RATE_LIMIT', message: '注册尝试过于频繁，请稍后再试' } });
    }
    const body = await readJson(req).catch(() => ({}));
    const email = (body.email || '').trim().toLowerCase();
    const password = body.password || '';
    const deviceId = (body.deviceId || '').trim();
    if (!email || !password || !deviceId) {
      return send(res, 400, { success: false, error: { code: 'BAD_INPUT', message: '邮箱 / 密码 / 设备 ID 必填' } });
    }
    if (!isValidLocalEmail(email)) {
      return send(res, 400, { success: false, error: { code: 'INVALID_EMAIL', message: '请输入有效的邮箱地址' } });
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
        const capLeg = await resolveCap(data, email, deviceId, body.force === true || body.force === 'true');
        if (capLeg) return send(res, capLeg.status, { success: false, error: capLeg.error });
        if (!data.devices[deviceId]) data.devices[deviceId] = { deviceId, trialStart: Date.now(), createdAt: new Date().toISOString() };
        else if (!data.devices[deviceId].trialStart) data.devices[deviceId].trialStart = Date.now();
        data.devices[deviceId].activatedEmail = email;
        await writeLicenses(data);
        recordExtensionEvent('register', { email, deviceId, legacyUpgrade: true });
        recordExtensionEvent('trial_start', { email, deviceId });
        recordExtensionEvent('device_bound', { email, deviceId });
        const token = crypto.randomUUID();
        extTokens.set(token, { userId: existing.id, deviceId });
        return send(res, 200, {
          success: true, token, email, trialDays: TRIAL_DAYS, upgraded: true,
          ...(await statusFor(data, data.devices[deviceId])),
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
        // ★安全修复（2026-09-13）：密码不匹配时，绝不再「覆盖同名账号密码」。
        //   原逻辑允许凭"知道邮箱 + 任意密码 + 设备 ID"直接接管已注册账号（含官网账号，
        //   因本端点与 /api/auth 共用同一 users.json），属账户接管漏洞。
        //   现改为直接拒绝，引导用户登录或使用带所有权验证的密码重置流程。
        return send(res, 409, { success: false, error: { code: 'EXISTS', message: '该邮箱已注册，请直接登录或使用密码重置' } });
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
    const capNew = await resolveCap(data, email, deviceId, body.force === true || body.force === 'true');
    if (capNew) return send(res, capNew.status, { success: false, error: capNew.error });
    if (!data.devices[deviceId]) {
      data.devices[deviceId] = { deviceId, trialStart: Date.now(), createdAt: new Date().toISOString() };
    } else if (!data.devices[deviceId].trialStart) {
      data.devices[deviceId].trialStart = Date.now();
    }
    data.devices[deviceId].activatedEmail = email;
    await writeLicenses(data);
    recordExtensionEvent('register', { email, deviceId });
    recordExtensionEvent('trial_start', { email, deviceId });
    recordExtensionEvent('device_bound', { email, deviceId });

    const token = crypto.randomUUID();
    rememberToken(token, { userId: newUser.id, deviceId });
    send(res, 200, {
      success: true,
      token,
      email,
      trialDays: TRIAL_DAYS,
      ...(await statusFor(data, data.devices[deviceId])),
    });
  });

  // ===== 官网 ↔ 扩展 登录打通：一次性绑定码（2026-09-14）=====
  // 背景：官网(/api/auth/login)与扩展(/api/extension/account/login)是两套独立令牌体系，
  //   账号凭据（users.json 的邮箱/密码）共享，但登录态完全不共享 → 用户在官网登录后，
  //   扩展仍显示「未登录或令牌已失效」。
  // 设计：绝不让长令牌经过网页（postMessage / sendMessage 都可能被页面脚本读取），
  //   改为「官网用 session 换一个 6 位短码 → 扩展用 短码 + deviceId 换扩展令牌」。
  const BIND_TTL_MS = 5 * 60 * 1000;
  const extBindCodes = new Map(); // code -> { userId, email, expiresAt, used }
  const extBindIp = new Map();    // ip -> { count, resetAt }（防暴力枚举 6 位码）

  // 官网侧调用（需官网登录态）：签发一次性绑定码
  router.register('POST', '/api/extension/account/bind-code', async (req, res) => {
    const body = await readJson(req).catch(() => ({}));
    // ★不能用 requireToken：它同样读 Authorization: Bearer，会把官网 access_token 误判成扩展令牌
    const userId = typeof getUserFromRequest === 'function' ? getUserFromRequest(req, body) : null;
    if (!userId) {
      return send(res, 401, { success: false, error: { code: 'NO_SESSION', message: '请先在官网登录后再同步' } });
    }
    const users = await readUsers();
    const user = users.find((u) => u.id === userId);
    if (!user) return send(res, 404, { success: false, error: { code: 'NO_USER', message: '用户不存在' } });
    // 同账号复用未过期且未使用的码，避免反复点击产生大量垃圾码
    for (const [code, item] of extBindCodes) {
      if (item.userId === userId && !item.used && item.expiresAt > Date.now()) {
        return send(res, 200, { success: true, code, expiresAt: item.expiresAt });
      }
    }
    const code = String(crypto.randomInt(100000, 999999));
    const expiresAt = Date.now() + BIND_TTL_MS;
    extBindCodes.set(code, { userId, email: user.email, expiresAt, used: false });
    // 顺带清理已过期/已用条目，防止 Map 无界增长
    for (const [k, v] of extBindCodes) {
      if (v.used || v.expiresAt <= Date.now() - BIND_TTL_MS) extBindCodes.delete(k);
    }
    return send(res, 200, { success: true, code, expiresAt });
  });

  // 扩展侧调用（匿名，限流）：用绑定码 + deviceId 换取扩展令牌
  router.register('POST', '/api/extension/account/bind', async (req, res) => {
    const ip = clientIp(req);
    const w = slidingWindow(extBindIp, ip, 60_000);
    if (w.count > 30) {
      return send(res, 429, { success: false, error: { code: 'RATE_LIMIT', message: '尝试过于频繁，请稍后再试' } });
    }
    const body = await readJson(req).catch(() => ({}));
    const code = String(body.code || '').trim();
    const deviceId = (body.deviceId || '').trim();
    if (!code || !deviceId) {
      return send(res, 400, { success: false, error: { code: 'BAD_INPUT', message: '绑定码 / 设备 ID 必填' } });
    }
    const item = extBindCodes.get(code);
    if (!item || item.used || item.expiresAt <= Date.now()) {
      return send(res, 400, { success: false, error: { code: 'BAD_CODE', message: '绑定码无效或已过期，请在官网重新获取' } });
    }
    // 原子消费：先标记已用，防止并发重放
    item.used = true;
    extBindCodes.set(code, item);

    const email = item.email;
    const data = await readLicenses();
    // 用户是在「当前这台设备」上主动点官网的「同步登录到扩展」，属显式授权：
    // 账号名额未满时直接放行（不踢任何设备），仅当已达上限才返回冲突让用户去解绑旧设备。
    const owned = Object.values(data.devices)
      .filter((d) => d.activatedEmail === email && d.deviceId !== deviceId);
    const withinCap = owned.length < MAX_DEVICES;
    const cap = await resolveCap(data, email, deviceId, body.force === true || body.force === 'true' || withinCap);
    if (cap) {
      item.used = false; // 设备冲突时不消耗码，用户解决后可重试
      return send(res, cap.status, { success: false, error: cap.error });
    }
    if (!data.devices[deviceId]) {
      data.devices[deviceId] = { deviceId, trialStart: Date.now(), createdAt: new Date().toISOString() };
    } else if (!data.devices[deviceId].trialStart) {
      data.devices[deviceId].trialStart = Date.now();
    }
    data.devices[deviceId].activatedEmail = email;
    await writeLicenses(data);
    const token = crypto.randomUUID();
    rememberToken(token, { userId: item.userId, deviceId });
    recordExtensionEvent('web_bind', { email, deviceId });
    return send(res, 200, {
      success: true,
      token,
      email,
      trialDays: TRIAL_DAYS,
      ...(await statusFor(data, data.devices[deviceId])),
    });
  });

  // 账号级设备列表（token 鉴权）
  router.register('GET', '/api/extension/devices', async (req, res) => {
    const auth = requireToken(req, res, {});
    if (!auth) return;
    const data = await readLicenses();
    const myDevice = data.devices[auth.deviceId];
    const email = myDevice && myDevice.activatedEmail;
    if (!email) {
      return send(res, 200, { success: true, email: null, maxDevices: MAX_DEVICES, devices: [] });
    }
    const subs = await readSubs();
    const devices = Object.values(data.devices)
      .filter((d) => d.activatedEmail === email)
      .map((d) => ({ ...deviceSummary(d, subs, data.devices), isCurrent: d.deviceId === auth.deviceId }));
    send(res, 200, { success: true, email, maxDevices: MAX_DEVICES, devices });
  });

  // 账号级授权查询（聚合该邮箱下全部设备 + 授权汇总）
  router.register('GET', '/api/extension/account/profile', async (req, res) => {
    const auth = requireToken(req, res, {});
    if (!auth) return;
    const data = await readLicenses();
    const myDevice = data.devices[auth.deviceId];
    const email = myDevice && myDevice.activatedEmail;
    const subs = await readSubs();
    const devices = email
      ? Object.values(data.devices)
        .filter((d) => d.activatedEmail === email)
        .map((d) => ({ ...deviceSummary(d, subs, data.devices), isCurrent: d.deviceId === auth.deviceId }))
      : [];
    const summary = {
      total: devices.length,
      paid: devices.filter((d) => d.mode === 'paid').length,
      trial: devices.filter((d) => d.mode === 'trial').length,
      expired: devices.filter((d) => d.mode === 'expired' || d.mode === 'none').length,
    };
    send(res, 200, { success: true, email, maxDevices: MAX_DEVICES, devices, summary });
  });

  // 我的订单查询（token 鉴权，按当前设备过滤）
  router.register('GET', '/api/extension/orders', async (req, res) => {
    const auth = requireToken(req, res, {});
    if (!auth) return;
    const subs = await readSubs();
    const items = (subs.items || []).filter((s) => s.deviceId === auth.deviceId);
    send(res, 200, {
      success: true,
      orders: items.map((s) => ({
        orderId: s.id, plan: s.plan, provider: s.provider, status: s.status,
        amount: s.amount, periodStart: s.periodStart, periodEnd: s.periodEnd, createdAt: s.createdAt,
      })),
    });
  });

  // 后台：订单列表（adminKey 保护）
  router.register('GET', '/api/extension/admin/orders', async (req, res, url) => {
    if (!requireAdmin(req, res, url)) return;
    const subs = await readSubs();
    send(res, 200, { success: true, count: (subs.items || []).length, orders: subs.items || [] });
  });

  // 后台：设备列表（adminKey 保护）
  router.register('GET', '/api/extension/admin/devices', async (req, res, url) => {
    if (!requireAdmin(req, res, url)) return;
    const data = await readLicenses();
    const devices = Object.values(data.devices).map((d) => ({
      ...deviceSummary(d), activatedEmail: d.activatedEmail || null,
    }));
    send(res, 200, { success: true, count: devices.length, devices });
  });

  // 后台：转化漏斗埋点汇总（adminKey 保护）
  router.register('POST', '/api/extension/admin/funnel', async (req, res, url) => {
    if (!requireAdmin(req, res, url)) return;
    flushEvents(); // 落盘内存缓冲，确保实时聚合
    const events = readEvents();
    const byType = {};
    const byDay = {};
    for (const e of events) {
      byType[e.type] = (byType[e.type] || 0) + 1;
      const day = new Date(e.t).toISOString().slice(0, 10);
      if (!byDay[day]) byDay[day] = {};
      byDay[day][e.type] = (byDay[day][e.type] || 0) + 1;
    }
    send(res, 200, { success: true, total: events.length, byType, byDay });
  });

  // 解绑 / 踢下线设备（token 鉴权，仅限同账号设备）
  router.registerPattern('POST', /^\/api\/extension\/devices\/([^/]+)\/unbind$/, async (req, res) => {
    const auth = requireToken(req, res, {});
    if (!auth) return;
    const targetId = decodeURIComponent(req._routeMatch[1]);
    const data = await readLicenses();
    const myDevice = data.devices[auth.deviceId];
    const email = myDevice && myDevice.activatedEmail;
    const target = data.devices[targetId];
    if (!target) return send(res, 404, { success: false, error: { code: 'NO_DEVICE', message: '设备不存在' } });
    if (email && target.activatedEmail !== email) {
      return send(res, 403, { success: false, error: { code: 'NOT_OWNED', message: '无权操作其他账号的设备' } });
    }
    // 解绑 = 解除账号绑定 + 踢下线 + 释放该设备占用的激活码名额。
    // ★2026-09-13 修复：原实现直接 delete 整个设备条目，会把该设备「已购买的订阅授权」
    //   一并物理删除（SUB-* 授权不在 licenseKeys 中，删除后无法再次激活）→ 用户付费权益永久丢失，
    //   即使重新登录同一账号也拿不回已购时长。
    //   现改为：保留设备记录（试用起点等不丢）、仅解除账号绑定并释放激活码；
    //   已购订阅本身挂在账号订单上（见 resolveAccountPaid），设备重新登录即可恢复，不会永久丢失。
    target.activatedEmail = null;
    if (target.licenseKey && data.licenseKeys[normalizeKey(target.licenseKey)]) {
      const ent = data.licenseKeys[normalizeKey(target.licenseKey)];
      if (ent.redeemedBy === targetId) { ent.redeemedBy = null; ent.redeemedAt = null; }
    }
    delete target.licenseKey;
    delete target.licensePlan;
    delete target.licenseActivatedAt;
    await writeLicenses(data);
    revokeTokensFor(targetId);
    recordExtensionEvent('device_unbound', { deviceId: targetId, email });
    send(res, 200, { success: true, unbound: targetId });
  });

  // 创建订阅订单（返回支付跳转 URL；实际授权在 webhook 回调后写入）
  router.register('POST', '/api/extension/subscription/create', async (req, res) => {
    // 敏感写操作：必须携带有效令牌（Authorization: Bearer 或从 body.token 兼容 Web 付款页）
    const body = await readJson(req).catch(() => ({}));
    const auth = requireToken(req, res, body);
    if (!auth) return;
    const deviceId = (body.deviceId || '').trim();
    const provider = ['wechat', 'alipay', 'paddle'].includes(body.provider) ? body.provider : 'wechat';
    const plan = ['monthly', 'quarterly', 'yearly', 'lifetime'].includes(body.plan) ? body.plan : 'monthly';
    const token = (body.token || '').trim();
    // 令牌归属设备须与下单设备一致，防止 A 的登录态替 B 的设备下单
    if (deviceId && auth.deviceId && deviceId !== auth.deviceId) {
      return send(res, 403, { success: false, error: { code: 'DEVICE_TOKEN_MISMATCH', message: '令牌与设备标识不一致' } });
    }
    if (!deviceId) return send(res, 400, { success: false, error: { code: 'BAD_DEVICE', message: '缺少 deviceId' } });
    // 边界隔离：支付页只服务扩展。deviceId 必须是已在本机注册（扩展握过手）的设备，否则拒绝下单
    const licData = await readLicenses();
    if (!licData.devices[deviceId]) {
      return send(res, 403, { success: false, error: { code: 'DEVICE_NOT_REGISTERED', message: '设备未注册，请从浏览器扩展内发起订阅' } });
    }

    // 测试/未配置真实网关时：返回模拟支付 URL（本地测试用，标记 mock=true）
    const realProviderConfigured = isProviderConfigured(provider);

    let orderId = 'SUB-' + crypto.randomBytes(6).toString('hex').toUpperCase();
    // 服务端单一事实来源：金额与有效期由后端决定，绝不信任客户端
    const amountCny = PLAN_PRICE_CNY[plan] || PLAN_PRICE_CNY.monthly;
    const periodDays = PLAN_DAYS[plan] ?? 30;
    const subs = await readSubs();
    const nowMs = Date.now();
    // ① 回收本设备超过 PENDING_EXPIRE_MS 仍未支付的 pending 单（历史垃圾单的存量清理）
    const beforeLen = subs.items.length;
    subs.items = subs.items.filter((s) => !(
      s.deviceId === deviceId && s.status === 'pending'
      && nowMs - new Date(s.createdAt || 0).getTime() > PENDING_EXPIRE_MS
    ));
    const recycled = beforeLen - subs.items.length;
    if (recycled > 0) console.log('[sub] 回收超期 pending 订单:', deviceId, '共', recycled, '条');
    // ② 幂等：同设备 + 同档位在复用窗口内已有 pending 单则复用，避免重复点击堆积订单
    let reused = false;
    let item = subs.items.find((s) => s.deviceId === deviceId && s.plan === plan
      && s.status === 'pending' && nowMs - new Date(s.createdAt || 0).getTime() < PENDING_REUSE_MS);
    if (item) {
      reused = true;
      orderId = item.id; // 复用同一订单号：前端与支付网关始终看到同一单
      item.channel = provider;
      item.amountCny = amountCny;
      item.periodDays = periodDays;
      item.token = token || item.token || null;
      item.email = (licData.devices[deviceId] && licData.devices[deviceId].activatedEmail) || item.email || null;
      item.createdAt = new Date().toISOString();
      console.log('[sub] 复用未过期 pending 订单:', orderId);
    } else {
      item = {
        id: orderId,
        deviceId,
        // ★订阅归属账号（而非仅归属设备）：跨设备登录时据此判定账号级授权
        //  （见 resolveAccountPaid）。早期订单缺失该字段时会回落到下单设备的绑定邮箱。
        email: (licData.devices[deviceId] && licData.devices[deviceId].activatedEmail) || null,
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
      };
      subs.items.push(item);
    }
    await writeSubs(subs);

    if (!realProviderConfigured) {
      // 本地测试：直接返回一个"模拟支付成功"的回跳 URL，由前端/测试脚本触发 webhook
      const checkoutUrl = `/api/extension/webhook/${provider}/mock?orderId=${orderId}&deviceId=${encodeURIComponent(deviceId)}&plan=${plan}`;
      recordExtensionEvent('pay_start', { deviceId, plan, provider, orderId, mock: true });
      return send(res, 200, { success: true, mock: true, orderId, provider, plan, amountCny, checkoutUrl });
    }

    // ---- 真实网关下单 ----
    recordExtensionEvent('pay_start', { deviceId, plan, provider, orderId, mock: false });
    if (provider === 'wechat') {
      try {
        const { appid, mchId, apiKey, notifyUrl } = getWxCredentials();
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
        if (!reused) await dropPendingOrder(orderId); // 下单失败：回滚本次新建的 pending 订单
        // 透传微信真实错误码，便于定位（最常见：未开通 Native 支付产品 / appid 与 trade_type 不匹配）
        return send(res, 502, {
          success: false,
          error: {
            code: 'WX_ORDER_FAIL',
            message: e.message,
            wxErrCode: e.wxErrCode || null,
            wxErrCodeDes: e.wxErrCodeDes || null,
            wxResultCode: e.wxResultCode || null,
          },
        });
      }
    }

    if (provider === 'alipay') {
      try {
        const { appId, privateKey, notifyUrl, payMethod } = getAliCredentials();
        if (!appId || !privateKey) {
          return send(res, 502, { success: false, error: { code: 'ALI_NOT_CONFIGURED' } });
        }
        // 支付宝金额单位是「元」（与微信「分」不同），直接用 PLAN_PRICE_CNY
        const totalAmountYuan = PLAN_PRICE_CNY[plan] || PLAN_PRICE_CNY.monthly;
        const orderArgs = {
          appId, privateKey, notifyUrl,
          outTradeNo: orderId,
          totalAmount: totalAmountYuan,
          subject: `Ddayup素材采集-${plan}`,
          passbackParams: `deviceId=${deviceId}&plan=${plan}`,
        };
        if (payMethod === 'precreate') {
          // 当面付扫码：需已签约「当面付」，未签约会被网关拒绝（40004 ACCESS_FORBIDDEN）
          const result = await aliPrecreate(orderArgs);
          const subs2 = await readSubs();
          const it = subs2.items.find((s) => s.id === orderId);
          if (it) { it.payUrl = result.qrCode; await writeSubs(subs2); }
          return send(res, 200, {
            success: true, mock: false, orderId, provider, plan,
            checkoutUrl: null,
            codeUrl: result.qrCode, // 支付宝扫码二维码内容（与微信共用前端二维码组件）
            payMethod,
            amountCny: totalAmountYuan,
          });
        }
        // 电脑网站支付（默认，已开通）：返回支付页 URL，由前端新窗口打开收银台，本页继续轮询。
        // return_url 带上 deviceId 与 paid=1：用户在新窗口付完款跳回时，页面能正确读取状态
        // （若不带 deviceId，回跳页会因缺少设备标识而显示异常）。
        const result = await aliPagePay({
          ...orderArgs,
          returnUrl: `${getPublicBase()}/pricing.html?deviceId=${encodeURIComponent(deviceId)}&paid=1`,
        });
        const subs2 = await readSubs();
        const it = subs2.items.find((s) => s.id === orderId);
        if (it) { it.payUrl = result.payUrl; await writeSubs(subs2); }
        return send(res, 200, {
          success: true, mock: false, orderId, provider, plan,
          checkoutUrl: result.payUrl, // 支付宝电脑网站支付页 URL
          codeUrl: null,
          payMethod,
          amountCny: totalAmountYuan,
        });
      } catch (e) {
        if (!reused) await dropPendingOrder(orderId); // 下单失败：回滚本次新建的 pending 订单
        // 结构化透传支付宝错误码/描述（aliCode/aliSubMsg），并落 pay_error 埋点便于排障
        const aliCode = e?.aliCode;
        const aliSubMsg = e?.aliSubMsg;
        recordExtensionEvent('pay_error', {
          provider: 'alipay', plan, orderId, aliCode, aliSubMsg,
          message: e?.message || String(e),
        });
        return send(res, 502, {
          success: false,
          error: { code: 'ALI_ORDER_FAIL', message: e.message, aliCode, aliSubMsg },
        });
      }
    }

    if (provider === 'paddle') {
      try {
        // Paddle Billing：创建 hosted checkout（美元定价），返回真实 checkout URL
        const paddle = getPaddleCredentials();
        const vendorId = paddle.vendorId;
        const authToken = paddle.authToken;
        const base = paddle.sandbox
          ? 'https://sandbox-vendors.paddle.com/api/2.0'
          : 'https://vendors.paddle.com/api/2.0';
        const priceId = getPaddlePriceId(plan);
        const payload = {
          vendor_id: Number(vendorId),
          vendor_auth_code: authToken,
          product_id: paddle.productId,
          title: `Ddayup素材采集-${plan}`,
          prices: [`USD:${PLAN_PRICE_USD[plan]}`],
          ...(priceId ? { price_id: priceId } : {}),
          passthrough: JSON.stringify({ deviceId, plan, orderId }),
          // ★与 extension/license.js 的 goToPricing() 保持一致：必须带 .html，
          //   无后缀 /pricing 会被静态代理回落成 SPA index.html，用户付完款落到空白页。
          return_url: `${getPublicBase()}/pricing.html?deviceId=${encodeURIComponent(deviceId)}&paid=1`,
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
        if (!reused) await dropPendingOrder(orderId); // 下单失败：回滚本次新建的 pending 订单
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
      const { apiKey } = getWxCredentials();
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
      // 安全校验：① 订单必须存在；② 金额必须一致（防篡改 attach.plan / 虚假回调）；
      //         ③ 以服务端订单 plan 为准，不信任回调 attach；④ 幂等（已 active 不再重复激活，避免续费被吞）。
      if (!item) {
        console.warn('[wechat webhook] 订单不存在，拒绝激活:', orderId);
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        res.end('<xml><return_code><![CDATA[SUCCESS]]></return_code><return_msg><![CDATA[OK]]></return_msg></xml>');
        return;
      }
      const expectedFen = Math.round((item.amountCny || 0) * 100);
      const paidFen = Number(data.total_fee) || 0;
      if (expectedFen && paidFen !== expectedFen) {
        console.warn('[wechat webhook] 金额不符，拒绝激活:', orderId, 'expect', expectedFen, 'got', paidFen);
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        res.end('<xml><return_code><![CDATA[SUCCESS]]></return_code><return_msg><![CDATA[OK]]></return_msg></xml>');
        return;
      }
      const realPlan = item.plan || 'monthly';
      if (item.status !== 'active') {
        item.status = 'active';
        item.periodEnd = Date.now() + (PLAN_DAYS[realPlan] ?? 30) * 86400000;
        item.activatedAt = new Date().toISOString();
        await writeSubs(subs);
        // 仅「订单首次转 active」时激活设备，避免微信重试/重复回调把已生效订阅再叠加一个周期（保持幂等）
        await applyActiveSubscriptionToDevice(deviceId, realPlan);
      }
      // 微信要求返回特定 XML 表示已接收，否则会持续重试
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end('<xml><return_code><![CDATA[SUCCESS]]></return_code><return_msg><![CDATA[OK]]></return_msg></xml>');
      return;
    }
    // 兼容 JSON 推送（自定义/测试）：同样要求订单存在、金额一致、幂等
    const body = parseJsonSafe(raw);
    const orderId = body.orderId || body.out_trade_no;
    const deviceId = body.deviceId;
    const plan = body.plan || 'monthly';
    if (!orderId || !deviceId) return send(res, 400, { success: false, error: { code: 'BAD_CB' } });
    const subs = await readSubs();
    const item = subs.items.find((s) => s.id === orderId);
    if (!item) return send(res, 404, { success: false, error: { code: 'NO_ORDER' } });
    const expectedFen = Math.round((item.amountCny || 0) * 100);
    const paidFen = Number(body.total_fee) || 0;
    if (expectedFen && paidFen && paidFen !== expectedFen) {
      return send(res, 400, { success: false, error: { code: 'AMOUNT_MISMATCH' } });
    }
    const realPlan = item.plan || 'monthly';
    if (item.status !== 'active') {
      item.status = 'active';
      item.periodEnd = Date.now() + (PLAN_DAYS[realPlan] ?? 30) * 86400000;
      item.activatedAt = new Date().toISOString();
      await writeSubs(subs);
      // 仅首次转 active 时激活设备，保证重复回调幂等
      await applyActiveSubscriptionToDevice(deviceId, realPlan);
    }
    send(res, 200, { success: true });
  });

  // 本地 mock 支付直达（仅开发/测试环境）：生产环境（NODE_ENV=production 且未显式开启 HMDAO_ENABLE_MOCK_PAY=1）
  // 一律不注册，杜绝「零元激活终身会员」漏洞（攻击者自造 orderId 即可 GET /mock 直接激活）。
  const mockPayEnabled = process.env.NODE_ENV !== 'production' || process.env.HMDAO_ENABLE_MOCK_PAY === '1';
  if (mockPayEnabled) {
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
  }

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
      flushEvents(); // 定时落盘埋点缓冲
      _reconcileRunning = false;
    }
  }, 5 * 60 * 1000);
  // 不阻止进程退出：定时器保持引用即可；此处不 unref 以便多 worker 场景仍可定时跑。
  router.register('POST', '/api/extension/reconcile', async (req, res) => {
    const body = await readJson(req).catch(() => ({}));
    const adminKey = (body?.adminKey || '').trim();
    // 必须配置强口令环境变量；未配置时一律拒绝，杜绝默认弱口令后门。
    const expect = process.env.HMDAO_ADMIN_KEY;
    if (!expect || adminKey !== expect) {
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
    const { appid, mchId, apiKey } = getWxCredentials();
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

  // 支付结果主动查询（防回调丢失/掉单）：按订单所属渠道向网关查单，命中支付成功则激活。
  // ★此前只支持微信——支付宝订单会因缺少微信凭证直接 502，等于支付宝侧没有任何兜底。
  router.register('POST', '/api/extension/subscription/query', async (req, res) => {
    const body = await readJson(req).catch(() => ({}));
    const orderId = (body.orderId || '').trim();
    const deviceId = (body.deviceId || '').trim();
    if (!orderId || !deviceId) return send(res, 400, { success: false, error: { code: 'BAD_INPUT' } });
    const subs = await readSubs();
    const item = subs.items.find((s) => s.id === orderId);
    if (!item || item.deviceId !== deviceId) return send(res, 404, { success: false, error: { code: 'NO_ORDER' } });

    let paid = false;
    let tradeState = '';
    if (item.channel === 'alipay') {
      const { appId, privateKey } = getAliCredentials();
      if (!appId || !privateKey) return send(res, 502, { success: false, error: { code: 'ALI_NOT_CONFIGURED' } });
      try {
        const r = await aliOrderQuery({ appId, privateKey, outTradeNo: orderId });
        tradeState = r.trade_status || '';
        paid = tradeState === 'TRADE_SUCCESS' || tradeState === 'TRADE_FINISHED';
      } catch (e) {
        return send(res, 502, { success: false, error: { code: 'ALI_QUERY_FAIL', message: e.message } });
      }
    } else {
      const { appid, mchId, apiKey } = getWxCredentials();
      if (!mchId || !apiKey) return send(res, 502, { success: false, error: { code: 'WX_NOT_CONFIGURED' } });
      const data = await wxOrderQuery({ appid, mchId, apiKey, outTradeNo: orderId });
      tradeState = data?.trade_state || data?.result_code || '';
      paid = data?.trade_state === 'SUCCESS' || data?.result_code === 'SUCCESS';
    }

    if (paid && item.status !== 'active') {
      item.status = 'active';
      item.periodEnd = Date.now() + (item.periodDays || 30) * 86400000;
      item.activatedAt = new Date().toISOString();
      item.paidAt = item.paidAt || new Date().toISOString();
      await writeSubs(subs);
      await applyActiveSubscriptionToDevice(deviceId, item.plan);
    }
    send(res, 200, { success: true, tradeState, paid, mode: paid ? 'paid' : 'pending' });
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

    // created / renewed / payment_succeeded → 激活（要求订单存在、幂等）
    const subs = await readSubs();
    const item = subs.items.find((s) => s.deviceId === deviceId && s.status === 'pending')
      || subs.items.find((s) => s.deviceId === deviceId);
    if (!item) {
      console.warn('[paddle webhook] 订单不存在，拒绝激活:', deviceId);
      return send(res, 200, { success: true });
    }
    const realPlan = item.plan || plan;
    if (item.status !== 'active') {
      item.status = 'active';
      item.periodEnd = Date.now() + (PLAN_DAYS[realPlan] ?? 30) * 86400000;
      item.activatedAt = new Date().toISOString();
      await writeSubs(subs);
      // 仅首次转 active 时激活设备，保证 Paddle 重试幂等
      await applyActiveSubscriptionToDevice(deviceId, realPlan);
    }
    send(res, 200, { success: true, mode: 'paid' });
  });

  // 支付宝异步通知（RSA2 验签）：支付成功激活；退款异步通知吊销
  router.register('POST', '/api/extension/webhook/alipay', async (req, res) => {
    // 支付宝异步通知为 application/x-www-form-urlencoded，必须用 readForm 而非 readJson
    const body = await readForm(req).catch(() => ({}));
    // 排障用：只记录解析到的字段「键名」，不记录任何值，避免敏感信息落盘。
    // 若这里打印出 sign/trade_status/out_trade_no 等键，说明表单解析已生效。
    console.log('[alipay webhook] 收到通知, 字段:', Object.keys(body).join(',') || '(空)');
    const sign = body.sign;
    const { alipayPublicKey } = getAliCredentials();
    if (!alipayPublicKey || !sign) return replyText(res, 'failure'); // 验签失败：支付宝会重试
    // 验签：用支付宝公钥校验整包
    if (!aliVerify(body, sign, alipayPublicKey)) return replyText(res, 'failure');
    const tradeStatus = body.trade_status;
    const outTradeNo = body.out_trade_no;
    let passback = {};
    try { passback = Object.fromEntries(new URLSearchParams(decodeURIComponent(body.passback_params || ''))); } catch {}
    const deviceId = passback.deviceId || '';
    const plan = ['monthly', 'quarterly', 'yearly', 'lifetime'].includes(passback.plan) ? passback.plan : 'monthly';
    if (!outTradeNo || !deviceId) return replyText(res, 'failure');

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
      return replyText(res, 'success');
    }

    // 支付成功：TRADE_SUCCESS / TRADE_FINISHED
    if (tradeStatus === 'TRADE_SUCCESS' || tradeStatus === 'TRADE_FINISHED') {
      const subs = await readSubs();
      const item = subs.items.find((s) => s.id === outTradeNo)
        || subs.items.find((s) => s.deviceId === deviceId && s.status === 'pending');
      if (!item) {
        console.warn('[alipay webhook] 订单不存在，拒绝激活:', outTradeNo);
        return replyText(res, 'success'); // 返回 success 终止支付宝重试，但不授权
      }
      const expectedYuan = Math.round((item.amountCny || 0) * 100) / 100;
      const paidYuan = Number(body.total_amount) || 0;
      if (expectedYuan && paidYuan && Math.abs(paidYuan - expectedYuan) > 0.001) {
        console.warn('[alipay webhook] 金额不符，拒绝激活:', outTradeNo, 'expect', expectedYuan, 'got', paidYuan);
        return replyText(res, 'success');
      }
      const realPlan = item.plan || plan;
      if (item.status !== 'active') {
        item.status = 'active';
        item.periodEnd = Date.now() + (item.periodDays || 30) * 86400000;
        item.activatedAt = new Date().toISOString();
        item.paidAt = new Date().toISOString();
        await writeSubs(subs);
        // 仅首次转 active 时激活设备，保证支付宝重试幂等
        await applyActiveSubscriptionToDevice(deviceId, realPlan);
      }
      return replyText(res, 'success');
    }
    // 其余状态（如 WAIT_BUYER_PAY）返回 success 避免重试风暴，但不激活
    return replyText(res, 'success');
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
    const { appId, privateKey } = getAliCredentials();
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
        const { appid, mchId, apiKey } = getWxCredentials();
        if (!appid || !mchId || !apiKey) { results.skipped += 1; continue; }
        const data = await wxOrderQuery({ appid, mchId, apiKey, outTradeNo: item.id });
        paid = data?.trade_state === 'SUCCESS' || data?.result_code === 'SUCCESS';
      } else if (item.channel === 'alipay') {
        const { appId, privateKey } = getAliCredentials();
        if (!appId || !privateKey) { results.skipped += 1; continue; }
        const r = await aliOrderQuery({ appId, privateKey, outTradeNo: item.id });
        paid = r.trade_status === 'TRADE_SUCCESS' || r.trade_status === 'TRADE_FINISHED';
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
  const base = computeRenewalActivationStart(data.devices[deviceId], Date.now());
  data.devices[deviceId].licenseKey = 'SUB-' + (plan || 'monthly');
  data.devices[deviceId].licensePlan = plan || 'monthly';
  data.devices[deviceId].licenseActivatedAt = base;
  await fs.writeFile(LICENSES_FILE, JSON.stringify(data, null, 2), 'utf8');
}
