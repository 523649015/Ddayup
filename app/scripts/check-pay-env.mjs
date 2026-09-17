#!/usr/bin/env node
/**
 * scripts/check-pay-env.mjs
 * 一键自检：检查所有支付环境变量是否齐全 + 支付宝密钥是否配对
 *
 * 微信支付（订阅场景）走 v2 NATIVE，实际代码（extension-license.mjs）认的是
 * HMDAO_WX_APP_ID / HMDAO_WX_MCH_ID / HMDAO_WX_API_KEY 这一组（v2 名），
 * 与 .env 实际填写的变量一致。本脚本只校验这一组，避免误报“微信密钥不全→mock”。
 * （docs 里出现的 WX_API_V3_KEY / WX_SERIAL_NO / WX_PRIVATE_KEY 是 v3 方案，
 *  当前订阅下单流程未使用，无需填写。）
 *
 * 使用方法：
 *   node scripts/check-pay-env.mjs
 *   node scripts/check-pay-env.mjs --debug    打印解析过程中的原始值
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
const DEBUG = process.argv.includes('--debug');

// 颜色
const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  yellow: '\x1b[33m', gray: '\x1b[90m', bold: '\x1b[1m', cyan: '\x1b[36m',
};
const ok   = (m) => console.log(`${c.green}✅ ${m}${c.reset}`);
const fail = (m) => console.log(`${c.red}❌ ${m}${c.reset}`);
const warn = (m) => console.log(`${c.yellow}⚠️  ${m}${c.reset}`);
const info = (m) => console.log(`${c.cyan}ℹ️  ${m}${c.reset}`);
const gray = (m) => console.log(`${c.gray}  ${m}${c.reset}`);

console.log(`\n${c.bold}🔍 支付环境自检${c.reset}  ·  ${c.gray}${new Date().toLocaleString()}${c.reset}\n`);

// ---------- 解析 .env（支持多行引号值） ----------
function parseEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    fail(`.env 不存在: ${filePath}`);
    return {};
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const env = {};
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) { i++; continue; }
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) { i++; continue; }
    const key = m[1];
    let value = m[2];
    if (value.startsWith('"') && !value.endsWith('"')) {
      const parts = [value.slice(1)];
      i++;
      while (i < lines.length) {
        const next = lines[i];
        if (next.endsWith('"')) { parts.push(next.slice(0, -1)); value = parts.join('\n'); break; }
        parts.push(next); i++;
      }
    } else if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    env[key] = value;
    i++;
  }
  return env;
}

const env = parseEnv(ENV_FILE);

if (DEBUG) {
  console.log(`${c.gray}[debug] 解析到的变量: ${Object.keys(env).join(', ')}${c.reset}\n`);
}

const display = (v) => {
  if (!v) return '(空)';
  if (v.length > 60) return v.slice(0, 40) + `…(${v.length})`;
  return v;
};

const pemBody = (s) => {
  const m = s && s.match(/-----BEGIN [^-]+-----([\s\S]+?)-----END [^-]+-----/);
  return m ? m[1].replace(/\s+/g, '') : '';
};

const isProd = env.ALIPAY_ENV === 'prod';

// ---------- 检查项 ----------
const checks = [
  {
    section: '基础',
    name: 'ALIPAY_ENV',
    label: '支付环境 (sandbox/prod)',
    val: env.ALIPAY_ENV,
    required: false,
    run: (v) => {
      if (!v) return { pass: true, warn: '未填 → 默认 sandbox（沙箱）；上线必须设为 prod' };
      if (v !== 'sandbox' && v !== 'prod') return { pass: false, msg: '应为 sandbox 或 prod' };
      return { pass: true, warn: v === 'prod' ? '生产模式：请确保 notify/return 为公网 https 域名' : '沙箱模式' };
    },
  },
  {
    section: '基础',
    name: 'ALIPAY_NOTIFY_URL',
    label: '支付宝异步回调地址',
    val: env.ALIPAY_NOTIFY_URL,
    required: false,
    run: (v) => {
      if (!v) return { pass: true, warn: '未填 → 自动用 <公网>/api/alipay/notify' };
      if (v.includes('127.0.0.1') || v.includes('localhost')) return { pass: false, msg: '本地地址，上线前必须改为 https 公网域名' };
      if (!v.startsWith('https://')) return { pass: true, warn: '非 https，支付宝将拒绝回调' };
      return { pass: true };
    },
  },
  {
    section: '基础',
    name: 'ALIPAY_RETURN_URL',
    label: '支付宝同步返回地址',
    val: env.ALIPAY_RETURN_URL,
    required: false,
    run: (v) => {
      if (!v) return { pass: true, warn: '未填 → 自动用 <公网>/subscribe?paid=1' };
      if (v.includes('127.0.0.1') || v.includes('localhost')) return { pass: true, warn: '本地地址；上线前改为公网' };
      return { pass: true };
    },
  },
  {
    section: '微信',
    name: 'HMDAO_WX_APP_ID',
    label: '微信 AppID（公众号/小程序，须绑定商户号）',
    val: env.HMDAO_WX_APP_ID,
    run: (v) => {
      if (!v) return { pass: false, msg: '未填写 → 后端 /api/orders(wechat) 走 mock，不会真实收款' };
      if (!/^wx[0-9a-f]{16}$/i.test(v)) return { pass: true, warn: '格式不像标准微信 AppID（wx + 16 位十六进制）' };
      return { pass: true };
    },
  },
  {
    section: '微信',
    name: 'HMDAO_WX_MCH_ID',
    label: '微信商户号',
    val: env.HMDAO_WX_MCH_ID,
    run: (v) => {
      if (!v) return { pass: false, msg: '未填写 → 后端始终进入 mock 模式（不会真实收款）' };
      if (!/^\d{8,12}$/.test(v)) return { pass: true, warn: '通常为 8-12 位纯数字' };
      return { pass: true };
    },
  },
  {
    section: '微信',
    name: 'HMDAO_WX_API_KEY',
    label: '微信 APIv2 密钥（32 位，商户平台「API 密钥」）',
    val: env.HMDAO_WX_API_KEY,
    run: (v) => {
      if (!v) return { pass: false, msg: '未填写 → NATIVE 下单 MD5 签名失败' };
      if (v.length !== 32) return { pass: true, warn: `长度 ${v.length}，应为 32 位` };
      return { pass: true };
    },
  },
  {
    section: '支付宝',
    name: 'ALIPAY_APP_ID',
    label: '支付宝 AppID',
    val: env.ALIPAY_APP_ID,
    run: (v) => {
      if (!v) return { pass: false, msg: '未填写' };
      if (!/^2021\d{12}$/.test(v)) return { pass: true, warn: '格式不像标准支付宝 AppID（16 位数字）' };
      return { pass: true };
    },
  },
  {
    section: '支付宝',
    name: 'ALIPAY_PRIVATE_KEY',
    label: '支付宝应用私钥（ALIPAY_PRIVATE_KEY）',
    val: env.ALIPAY_PRIVATE_KEY,
    run: (v) => {
      if (!v) return { pass: false, msg: '未填写' };
      if (!v.includes('BEGIN PRIVATE KEY')) return { pass: false, msg: '不是 PEM 格式' };
      try {
        const k = crypto.createPrivateKey(v);
        const pubPem = crypto.createPublicKey(k).export({ type: 'spki', format: 'pem' });
        return { pass: true, derived: pubPem };
      } catch (e) { return { pass: false, msg: `无法解析: ${e.message}` }; }
    },
  },
  {
    section: '支付宝',
    name: 'ALIPAY_PUBLIC_KEY',
    label: '支付宝平台公钥（ALIPAY_PUBLIC_KEY）',
    val: env.ALIPAY_PUBLIC_KEY,
    run: (v) => {
      if (!v) return { pass: false, msg: '未填写 → 回调验签将失败' };
      if (!v.includes('BEGIN PUBLIC KEY')) return { pass: false, msg: '不是 PEM 格式' };
      try { crypto.createPublicKey(v); return { pass: true }; }
      catch (e) { return { pass: false, msg: `无法解析: ${e.message}` }; }
    },
  },
];

// ---------- 渲染 ----------
const results = {};
let allPass = true;
for (const ck of checks) {
  const result = ck.run(ck.val);
  results[ck.name] = { ...result, raw: ck.val, display: display(ck.val), label: ck.label };
  if (!result.pass && ck.required !== false) allPass = false;
}

function printRow(r) {
  if (!r) return;
  if (r.pass) ok(`${r.label}: ${r.display}`);
  else fail(`${r.label}: ${r.msg}`);
  if (r.warn) warn(r.warn);
}

const sections = ['基础', '微信', '支付宝'];
for (const sec of sections) {
  console.log(`${c.bold}━━━ ${sec} ━━━${c.reset}`);
  for (const k of Object.keys(results)) {
    if (checks.find((c) => c.name === k).section === sec) printRow(results[k]);
  }
  console.log();
}

// ---------- 支付宝密钥配对检查 ----------
console.log(`${c.bold}━━━ 支付宝密钥配对检查 ━━━${c.reset}`);
const priv = results.ALIPAY_PRIVATE_KEY;
const pub = results.ALIPAY_PUBLIC_KEY;

if (priv && priv.pass && priv.derived && pub && pub.pass) {
  const derived = pemBody(priv.derived);
  const inEnv = pemBody(pub.raw);
  if (derived && inEnv && derived !== inEnv) {
    ok('私钥导出的“应用公钥” ≠ .env 的“平台公钥”（预期行为，平台公钥是支付宝的）');
  } else if (derived === inEnv) {
    fail('.env 的“平台公钥”和你私钥导出的是同一把 → 你可能把“应用公钥”复制到 ALIPAY_PUBLIC_KEY 了');
    gray('正确做法：ALIPAY_PUBLIC_KEY 必须是开放平台“接口加签方式”展示的“支付宝公钥”（平台下载），不是你上传的“应用公钥”');
  }

  const localPub = path.join(ROOT, 'alipay-sandbox', 'alipay_public_key.pem');
  if (fs.existsSync(localPub)) {
    const localContent = fs.readFileSync(localPub, 'utf8');
    if (pemBody(localContent) === inEnv) ok('.env 平台公钥 ↔ alipay-sandbox/alipay_public_key.pem 一致');
    else warn('.env 平台公钥 ≠ alipay-sandbox/alipay_public_key.pem（以开放平台“支付宝公钥”为准）');
  }

  console.log();
  info('私钥导出的“应用公钥”——必须上传到 开放平台 → 接口加签方式：');
  console.log(c.gray + '  ' + priv.derived.trim().replace(/\n/g, '\n  ') + c.reset);
} else {
  warn('支付宝私钥/平台公钥未同时就绪，跳过配对检查');
}

console.log(`\n${c.bold}━━━ 微信支付说明 ━━━${c.reset}`);
if (env.HMDAO_WX_APP_ID && env.HMDAO_WX_MCH_ID && env.HMDAO_WX_API_KEY) {
  ok('微信三项密钥齐全（v2 NATIVE）→ 后端将使用真实下单');
  gray('另需：① 小程序后台将 AppID 与商户号绑定（审核中）② 公网回调 /api/extension/webhook/wechat 可达');
} else {
  warn('微信密钥不全 → 后端 /api/orders(wechat) 仅返回 mock 二维码，不会真实收款');
  gray('获取步骤见 docs/wechat-pay-setup.md');
}

console.log(`\n${c.bold}━━━ 总结 ━━━${c.reset}`);
if (allPass) ok('所有必填项已通过 → 真实支付链路就绪');
else fail('存在未填写或无效的配置项，真实支付将无法启动');

console.log(`\n${c.gray}提示：本脚本仅检查 .env 本地配置。平台侧操作（小程序认证 / 当面付签约 / NATIVE 开通 / AppID 绑定）需人工完成。${c.reset}\n`);

process.exit(allPass ? 0 : 1);
