// 统一支付凭证模块（支付凭证的单一事实来源）
//
// 背景：支付凭证此前散落在 extension-license.mjs 各处直接读 process.env.HMDAO_*，
//       既不便于调用，也无法一次性排查「到底缺哪个」。本模块集中定义、集中读取、集中自检。
//
// 约定：
//   1. 纯读取、不缓存：process.env 在启动时由 load-env.mjs 注入后不再变化，
//      缓存反而会让 .env 变更无法及时反映，且自检清单必须反映真实状态。
//   2. auditCredentials() / formatCredentialAudit() 严禁输出任何凭证明文，
//      只暴露「是否配置 / 长度 / 用途」——敏感值一旦进入日志或终端即不可收回。
//   3. 本模块 import 了 load-env.mjs，任何调用方都能确保 app/.env 已被注入
//      （ESM 模块缓存保证只执行一次，不会重复打印）。
import './load-env.mjs';

// 凭证清单：键名 / 归属通道 / 用途 / 是否必填 / 是否需 PEM 归一化
const CREDENTIAL_SPECS = [
  // ---- 支付宝 ----
  { key: 'HMDAO_ALI_APP_ID', group: 'alipay', purpose: '支付宝应用 APPID', required: true },
  { key: 'HMDAO_ALI_PRIVATE_KEY', group: 'alipay', purpose: '支付宝应用私钥(PKCS8)', required: true, pem: true },
  { key: 'HMDAO_ALI_PUBLIC_KEY', group: 'alipay', purpose: '支付宝公钥(异步通知验签)', required: true, pem: true },
  { key: 'HMDAO_ALI_SANDBOX', group: 'alipay', purpose: '支付宝沙箱开关(=1 走沙箱网关)', required: false },
  { key: 'HMDAO_ALI_PAY_METHOD', group: 'alipay', purpose: '支付宝下单方式(pagepay 默认|precreate 需签约)', required: false },
  // ---- 微信支付 ----
  { key: 'HMDAO_WX_APP_ID', group: 'wechat', purpose: '微信应用 APPID', required: true },
  { key: 'HMDAO_WX_MCH_ID', group: 'wechat', purpose: '微信支付商户号', required: true },
  { key: 'HMDAO_WX_API_KEY', group: 'wechat', purpose: '微信支付 API v2 密钥', required: true },
  { key: 'HMDAO_WX_CERT_PATH', group: 'wechat', purpose: '微信退款证书(仅退款需要)', required: false },
  { key: 'HMDAO_WX_CERT_KEY_PATH', group: 'wechat', purpose: '微信退款证书私钥(仅退款需要)', required: false },
  { key: 'HMDAO_WX_CERT_PASS', group: 'wechat', purpose: '微信退款证书密码(仅退款需要)', required: false },
  // ---- Paddle ----
  { key: 'HMDAO_PADDLE_VENDOR_ID', group: 'paddle', purpose: 'Paddle 商户 ID', required: false },
  { key: 'HMDAO_PADDLE_AUTH_TOKEN', group: 'paddle', purpose: 'Paddle API Token', required: false },
  { key: 'HMDAO_PADDLE_PRODUCT_ID', group: 'paddle', purpose: 'Paddle 产品 ID', required: false },
  { key: 'HMDAO_PADDLE_SANDBOX', group: 'paddle', purpose: 'Paddle 沙箱开关(=1)', required: false },
  // ---- 公共 ----
  { key: 'HMDAO_PUBLIC_BASE', group: 'common', purpose: '回调/回跳公网基址', required: true },
];

// 还原 .env 中为适配单行存储而转义的 \n（与 extension-license.mjs 内 normalizePem 行为一致）
export function normalizePem(v) {
  return v ? String(v).replace(/\\n/g, '\n') : v;
}

function rawValue(key) {
  const v = process.env[key];
  return v == null ? '' : String(v);
}

function specValue(key) {
  const spec = CREDENTIAL_SPECS.find((s) => s.key === key);
  const v = rawValue(key);
  return spec && spec.pem ? normalizePem(v) : v;
}

// 回调 / 回跳公网基址（去掉结尾斜杠，便于拼接路径）
export function getPublicBase() {
  return rawValue('HMDAO_PUBLIC_BASE').replace(/\/+$/, '');
}

export function getAliCredentials() {
  const rawMethod = rawValue('HMDAO_ALI_PAY_METHOD').trim().toLowerCase();
  return {
    appId: specValue('HMDAO_ALI_APP_ID'),
    privateKey: specValue('HMDAO_ALI_PRIVATE_KEY'),
    alipayPublicKey: specValue('HMDAO_ALI_PUBLIC_KEY'),
    sandbox: rawValue('HMDAO_ALI_SANDBOX') === '1',
    // 下单方式：pagepay=电脑网站支付（已开通，默认）；precreate=当面付扫码（需签约当面付）。
    // 当面付签约通过后，只需把 HMDAO_ALI_PAY_METHOD 改为 precreate 即可零改码切回二维码形态。
    payMethod: rawMethod === 'precreate' ? 'precreate' : 'pagepay',
    notifyUrl: `${getPublicBase()}/api/extension/webhook/alipay`,
    returnUrl: `${getPublicBase()}/pricing.html`,
  };
}

export function getWxCredentials() {
  return {
    appid: specValue('HMDAO_WX_APP_ID'),
    mchId: specValue('HMDAO_WX_MCH_ID'),
    apiKey: specValue('HMDAO_WX_API_KEY'),
    certPath: specValue('HMDAO_WX_CERT_PATH'),
    certKeyPath: specValue('HMDAO_WX_CERT_KEY_PATH'),
    certPass: specValue('HMDAO_WX_CERT_PASS'),
    notifyUrl: `${getPublicBase()}/api/extension/webhook/wechat`,
  };
}

export function getPaddleCredentials() {
  return {
    vendorId: specValue('HMDAO_PADDLE_VENDOR_ID'),
    authToken: specValue('HMDAO_PADDLE_AUTH_TOKEN'),
    productId: specValue('HMDAO_PADDLE_PRODUCT_ID'),
    sandbox: rawValue('HMDAO_PADDLE_SANDBOX') === '1',
  };
}

// Paddle 按档位区分价格 ID，键名随 plan 动态变化（HMDAO_PADDLE_PRICE_MONTHLY 等）
export function getPaddlePriceId(plan) {
  return rawValue(`HMDAO_PADDLE_PRICE_${String(plan || '').toUpperCase()}`);
}

// 支付通道是否具备下单所需的最小凭证（语义与原 realProviderConfigured 判定保持一致）
export function isProviderConfigured(provider) {
  if (provider === 'wechat') return !!getWxCredentials().mchId;
  if (provider === 'alipay') return !!getAliCredentials().appId;
  if (provider === 'paddle') return !!getPaddleCredentials().vendorId;
  return false;
}

/**
 * 凭证自检清单（零明文）。
 * @returns {{ key:string, group:string, purpose:string, required:boolean, configured:boolean, length:number }[]}
 */
export function auditCredentials() {
  return CREDENTIAL_SPECS.map((s) => {
    const v = rawValue(s.key);
    return {
      key: s.key,
      group: s.group,
      purpose: s.purpose,
      required: !!s.required,
      configured: v !== '',
      length: v.length,
    };
  });
}

// 供终端打印的对齐文本（同样零明文）
export function formatCredentialAudit() {
  const items = auditCredentials();
  const width = Math.max(...items.map((i) => i.key.length));
  const lines = items.map((i) => {
    const flag = i.configured ? ' OK ' : (i.required ? 'MISS' : 'opt ');
    return `  [${flag}] ${i.key.padEnd(width)}  len=${String(i.length).padEnd(5)} ${i.purpose}`;
  });
  const missing = items.filter((i) => i.required && !i.configured);
  if (missing.length) {
    lines.push(`  !! 缺失必填凭证: ${missing.map((i) => i.key).join(', ')}`);
  }
  return lines.join('\n');
}
