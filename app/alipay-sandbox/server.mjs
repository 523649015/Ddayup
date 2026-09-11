// 支付后端 · 双通道（支付宝电脑网站支付 + 微信 NATIVE 扫码）· 零依赖原生 Node
// 运行：cd app && node alipay-sandbox/server.mjs
// 环境：复制 .env.example 为 .env，ALIPAY_ENV=sandbox（默认，本地联调）| prod（生产）
// 端点：
//   POST /api/orders            { channel:'alipay'|'wechat', plan, amount, subject }
//                                 -> alipay: 返回支付宝 form(html)；wechat: 返回 { qrCode }
//   POST /api/alipay/notify     支付宝异步通知（RSA2 验签）
//   POST /api/wechat/notify     微信异步通知（沙箱模拟，直接标记 PAID）
//   GET  /api/orders/:id        查询订单状态
//   POST /api/orders/:id/simulate 沙箱模拟支付成功（无真实通道时测试用）
import http from 'node:http';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

// ===== 读取 .env（零依赖解析器，支持多文件）=====
function loadEnvFile(name) {
  const file = path.join(process.cwd(), name);
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    v = v.replace(/\\n/g, '\n'); // 还原 PEM 多行
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
// 先读项目 .env（Ddayup 后端用），再读 .env.alipay（支付宝专用，不污染原文件）
loadEnvFile('.env');
loadEnvFile('.env.alipay');

// 密钥优先从 .pem 文件读取（避免 .env 多行转义问题），回退到 .env 变量
const PEM_DIR = path.join(process.cwd(), 'alipay-sandbox');
function readPem(name, envKey) {
  const p = path.join(PEM_DIR, name);
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  return process.env[envKey] || '';
}
const PRIV_KEY = readPem('app_private_key.pem', 'ALIPAY_PRIVATE_KEY');
const PUB_KEY = readPem('alipay_public_key.pem', 'ALIPAY_PUBLIC_KEY');

const ENV = process.env.ALIPAY_ENV === 'prod' ? 'prod' : 'sandbox';
const isProd = ENV === 'prod';

// ===== 支付宝配置 =====
const ALI = {
  env: ENV,
  gateway: isProd ? 'https://openapi.alipay.com/gateway.do' : 'https://openapi.alipaydev.com/gateway.do',
  appId: process.env.ALIPAY_APP_ID || '你的沙箱APPID',
  returnUrl: isProd
    ? (process.env.ALIPAY_RETURN_URL || 'https://www.mingmingchuangyi.cn/subscribe?paid=1')
    : 'http://127.0.0.1:4100/subscribe',
  notifyUrl: isProd
    ? (process.env.ALIPAY_NOTIFY_URL || 'https://www.mingmingchuangyi.cn/api/alipay/notify')
    : 'http://127.0.0.1:8793/api/alipay/notify',
  privateKey: PRIV_KEY,
  alipayPublicKey: PUB_KEY,
  pid: process.env.ALIPAY_PID || '',
  charset: 'utf-8',
  signType: 'RSA2',
  format: 'JSON',
};

// ===== 微信配置（沙箱模拟；生产填 WX_* 后启用真实 NATIVE）=====
const WX = {
  mchId: process.env.WX_MCH_ID || '',
  apiV3Key: process.env.WX_API_V3_KEY || '',
  serialNo: process.env.WX_SERIAL_NO || '',
  privateKeyPem: process.env.WX_PRIVATE_KEY || '',
  notifyUrl: isProd ? 'https://www.mingmingchuangyi.cn/api/wechat/notify' : 'http://127.0.0.1:8793/api/wechat/notify',
  gateway: 'https://api.mch.weixin.qq.com/v3/pay/transactions/native',
};

const orders = new Map();

// ---------- 支付宝签名 ----------
function aliSign(params, privateKey) {
  const sorted = Object.keys(params)
    .filter((k) => params[k] !== '' && params[k] !== undefined && params[k] !== null)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  const key = crypto.createPrivateKey(privateKey); // 兼容 PKCS1 / PKCS8
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(sorted, 'utf8');
  return signer.sign(key, 'base64');
}
function aliVerify(params) {
  const sign0 = params.sign;
  const map = { ...params };
  delete map.sign;
  delete map.sign_type;
  const sorted = Object.keys(map).sort().map((k) => `${k}=${map[k]}`).join('&');
  const key = crypto.createPublicKey(ALI.alipayPublicKey); // 兼容 PKCS8 公钥
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(sorted, 'utf8');
  return verifier.verify(key, sign0, 'base64');
}
function aliForm(biz) {
  // 严格按 yyyy-MM-dd HH:mm:ss 构造（避免不同 Node 版本 locale 差异）
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const timestamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const params = {
    app_id: ALI.appId, method: 'alipay.trade.page.pay', format: ALI.format,
    charset: ALI.charset, sign_type: ALI.signType,
    timestamp, version: '1.0',
    notify_url: ALI.notifyUrl, return_url: ALI.returnUrl, biz_content: JSON.stringify(biz),
  };
  // sign 必须用【未编码】的原始值计算（alipay 签名规范）
  params.sign = aliSign(params, ALI.privateKey);
  // 返回原始参数（已签名），由前端用 fetch + URLSearchParams POST 到支付宝网关
  // 这样保证前端提交的字节级 body 和 Node 端到端测试完全一致
  return { action: ALI.gateway, params };
}

// ---------- 微信 NATIVE（沙箱模拟 qr_code）----------
// 真实生产：POST gateway + JSON Body + Authorization 签名头，解析 res.code_url
function wxNativeQr(subject, outTradeNo, amount) {
  // 沙箱：本地拼一个可识别的二维码字符串，前端渲染成图即可联调
  // 生产：此处替换为真实 API 调用，返回微信的 code_url
  const fake = `weixin://wxpay/bizpayurl?pr=mmchuangyi_${outTradeNo}_${amount}`;
  return fake;
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, {
    'Content-Type': `${type}; charset=utf-8`,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // 健康检查（前端启动时会探测，避免 404 告警）
  if (u.pathname === '/api/health' && req.method === 'GET') {
    return send(res, 200, { ok: true, service: 'pay-api', env: ENV, time: new Date().toISOString() });
  }

  // 下单
  if (req.method === 'POST' && u.pathname === '/api/orders') {
    const { channel = 'alipay', plan, amount, subject, outTradeNo: clientNo } = await readBody(req);
    const outTradeNo = clientNo || 'DD' + Date.now();
    orders.set(outTradeNo, { outTradeNo, channel, plan, amount, subject, status: 'WAIT_BUYER_PAY' });
    if (channel === 'wechat') {
      const qrCode = wxNativeQr(subject || '鸣鸣创意服务包', outTradeNo, amount || 0.01);
      return send(res, 200, { outTradeNo, qrCode, channel: 'wechat' });
    }
    const { action, params } = aliForm({
      out_trade_no: outTradeNo, product_code: 'FAST_INSTANT_TRADE_PAY',
      total_amount: String(amount || 0.01), subject: subject || '鸣鸣创意服务包', body: plan || '',
    });
    // 后端跟随支付宝重定向，拿到最终收银台 HTML，原样返回给前端
    // 前端把这个 HTML 写到新标签页即可（这是支付宝官方 SDK 用的标准方案）
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const aliRes = await fetch(action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: new URLSearchParams(params).toString(),
      redirect: 'follow',
    });
    // 支付宝收银台页是 gb2312 编码，必须用 gbk/gb18030 解码成 UTF-8 字符串再发回前端
    const buf = Buffer.from(await aliRes.arrayBuffer());
    const aliHtml = new TextDecoder('gb18030').decode(buf);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'X-Out-Trade-No': outTradeNo,
    });
    res.end(aliHtml);
    return;
  }

  // 支付宝异步通知
  if (u.pathname === '/api/alipay/notify' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const params = Object.fromEntries(new URLSearchParams(raw));
      if (!aliVerify(params)) return send(res, 200, 'failure', 'text/plain');
      const o = orders.get(params.out_trade_no);
      if (o) o.status = params.trade_status === 'TRADE_SUCCESS' ? 'PAID' : params.trade_status;
      send(res, 200, 'success', 'text/plain');
    });
    return;
  }

  // 微信异步通知（沙箱模拟）
  if (u.pathname === '/api/wechat/notify' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      // 真实生产：解密 req.body（AES-GCM + apiV3Key）取 out_trade_no + trade_state
      const params = Object.fromEntries(new URLSearchParams(raw));
      const o = orders.get(params.out_trade_no);
      if (o) o.status = 'PAID';
      send(res, 200, { code: 'SUCCESS', message: '成功' });
    });
    return;
  }

  // 查询订单
  if (u.pathname.startsWith('/api/orders/') && req.method === 'GET' && !u.pathname.endsWith('/simulate')) {
    const id = u.pathname.split('/').pop();
    return send(res, 200, orders.get(id) || { error: 'not found' });
  }

  // 沙箱模拟支付成功（无真实通道时测试前端轮询）
  if (u.pathname.endsWith('/simulate') && req.method === 'POST') {
    const id = u.pathname.split('/')[3];
    const o = orders.get(id);
    if (o) o.status = 'PAID';
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: 'not found' });
});

server.listen(8793, () => console.log('Payment sandbox (alipay+wechat) on http://127.0.0.1:8793'));
