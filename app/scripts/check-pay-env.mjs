#!/usr/bin/env node
/**
 * scripts/check-pay-env.mjs
 * 一键自检：检查所有支付环境变量是否齐全 + 支付宝密钥是否配对
 *
 * 使用方法：
 *   node scripts/check-pay-env.mjs
 *   node scripts/check-pay-env.mjs --debug    打印解析过程中的原始值
 *
 * 输出：
 *   - 基础配置 / 微信 / 支付宝 三段，每项 ✅ / ❌ / ⚠️ 状态
 *   - 末尾：支付宝应用私钥导出的"应用公钥"（用于粘贴到开放平台）
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
const ok   = (m) => console.log(`${c.green}\u2705 ${m}${c.reset}`);
const fail = (m) => console.log(`${c.red}\u274c ${m}${c.reset}`);
const warn = (m) => console.log(`${c.yellow}\u26a0\ufe0f  ${m}${c.reset}`);
const info = (m) => console.log(`${c.cyan}\u2139\ufe0f  ${m}${c.reset}`);
const gray = (m) => console.log(`${c.gray}  ${m}${c.reset}`);

console.log(`\n${c.bold}\ud83d\udd0d \u652f\u4ed8\u73af\u5883\u81ea\u68c0${c.reset}  \u00b7  ${c.gray}${new Date().toLocaleString()}${c.reset}\n`);

// ---------- 解析 .env（支持多行引号值） ----------
function parseEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    fail(`.env \u4e0d\u5b58\u5728: ${filePath}`);
    return {};
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  // 统一换行符
  const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const env = {};
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 跳过空行和注释行
    if (!line.trim() || line.trim().startsWith('#')) { i++; continue; }
    // 匹配 key = value
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) { i++; continue; }
    const key = m[1];
    let value = m[2];
    // 多行引号值：value 以 " 开头但不以 " 结尾
    if (value.startsWith('"') && !value.endsWith('"')) {
      const parts = [value.slice(1)]; // 去掉开头的 "
      i++;
      while (i < lines.length) {
        const next = lines[i];
        if (next.endsWith('"')) {
          // 末行：去掉末尾的 "
          parts.push(next.slice(0, -1));
          value = parts.join('\n');
          break;
        } else {
          parts.push(next);
          i++;
        }
      }
    } else if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      // 单行引号值
      value = value.slice(1, -1);
    }
    // 处理转义序列
    value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    env[key] = value;
    i++;
  }
  return env;
}

const env = parseEnv(ENV_FILE);

if (DEBUG) {
  console.log(`${c.gray}[debug] \u89e3\u6790\u5230\u7684\u53d8\u91cf: ${Object.keys(env).join(', ')}${c.reset}\n`);
}

const display = (v) => {
  if (!v) return '(空)';
  if (v.length > 60) return v.slice(0, 40) + `\u2026(${v.length})`;
  return v;
};

// 提取 PEM 主体（去掉头尾和空白）
const pemBody = (s) => {
  const m = s && s.match(/-----BEGIN [^-]+-----([\s\S]+?)-----END [^-]+-----/);
  return m ? m[1].replace(/\s+/g, '') : '';
};

// ---------- 检查项 ----------
const checks = [
  {
    section: '基础',
    name: 'HMDAO_PUBLIC_BASE',
    label: '回调公网地址',
    val: env.HMDAO_PUBLIC_BASE,
    run: (v) => {
      if (!v) return { pass: false, msg: '未填写（影响 notify_url / 同步返回）' };
      if (v.includes('127.0.0.1') || v.includes('localhost')) {
        return { pass: true, warn: '当前是本地地址；上线前必须改为 https 公网域名' };
      }
      if (!v.startsWith('https://')) {
        return { pass: true, warn: '非 https 协议，微信/支付宝可能拒绝回调' };
      }
      return { pass: true };
    },
  },
  {
    section: '微信',
    name: 'HMDAO_WX_APP_ID',
    label: '微信 AppID',
    val: env.HMDAO_WX_APP_ID,
    run: (v) => {
      if (!v) return { pass: false, msg: '未填写 \u2192 微信支付真实模式无法激活' };
      if (!/^wx[0-9a-f]{16}$/i.test(v)) {
        return { pass: true, warn: '格式不像标准微信 AppID（wx + 16 位十六进制）' };
      }
      return { pass: true };
    },
  },
  {
    section: '微信',
    name: 'HMDAO_WX_MCH_ID',
    label: '微信商户号',
    val: env.HMDAO_WX_MCH_ID,
    run: (v) => {
      if (!v) return { pass: false, msg: '未填写 \u2192 后端始终进入 mock 模式（不会真实收款）' };
      if (!/^\d{8,12}$/.test(v)) {
        return { pass: true, warn: '通常为 8-12 位纯数字' };
      }
      return { pass: true };
    },
  },
  {
    section: '微信',
    name: 'HMDAO_WX_API_KEY',
    label: '微信 APIv2 密钥',
    val: env.HMDAO_WX_API_KEY,
    run: (v) => {
      if (!v) return { pass: false, msg: '未填写 \u2192 微信签名/回调验签失败' };
      if (v.length !== 32) return { pass: true, warn: `长度 ${v.length}，应为 32 位` };
      return { pass: true };
    },
  },
  {
    section: '微信',
    name: 'HMDAO_WX_CERT_PATH',
    label: '微信退款证书 (apiclient_cert.pem)',
    val: env.HMDAO_WX_CERT_PATH,
    required: false,
    run: (v) => {
      if (!v) return { pass: true, warn: '未配置 \u2192 仅退款不可用，收款不受影响' };
      const abs = path.isAbsolute(v) ? v : path.join(ROOT, v);
      if (!fs.existsSync(abs)) return { pass: false, msg: `文件不存在: ${abs}` };
      return { pass: true };
    },
  },
  {
    section: '支付宝',
    name: 'HMDAO_ALI_APP_ID',
    label: '支付宝 AppID',
    val: env.HMDAO_ALI_APP_ID,
    run: (v) => {
      if (!v) return { pass: false, msg: '未填写' };
      if (!/^2021\d{12}$/.test(v)) {
        return { pass: true, warn: '格式不像标准支付宝 AppID（16 位数字）' };
      }
      return { pass: true };
    },
  },
  {
    section: '支付宝',
    name: 'HMDAO_ALI_PRIVATE_KEY',
    label: '支付宝应用私钥（HMDAO_ALI_PRIVATE_KEY）',
    val: env.HMDAO_ALI_PRIVATE_KEY,
    run: (v) => {
      if (!v) return { pass: false, msg: '未填写' };
      if (!v.includes('BEGIN PRIVATE KEY')) return { pass: false, msg: '不是 PEM 格式' };
      try {
        const k = crypto.createPrivateKey(v);
        const pubPem = crypto.createPublicKey(k).export({ type: 'spki', format: 'pem' });
        return { pass: true, derived: pubPem };
      } catch (e) {
        return { pass: false, msg: `无法解析: ${e.message}` };
      }
    },
  },
  {
    section: '支付宝',
    name: 'HMDAO_ALI_PUBLIC_KEY',
    label: '支付宝平台公钥（HMDAO_ALI_PUBLIC_KEY）',
    val: env.HMDAO_ALI_PUBLIC_KEY,
    run: (v) => {
      if (!v) return { pass: false, msg: '未填写 \u2192 回调验签将失败' };
      if (!v.includes('BEGIN PUBLIC KEY')) return { pass: false, msg: '不是 PEM 格式' };
      if (DEBUG) console.log(`${c.gray}[debug] \u516c\u94a5\u524d 80 \u5b57\u7b26: ${JSON.stringify(v.slice(0, 80))}${c.reset}`);
      if (DEBUG) console.log(`${c.gray}[debug] \u516c\u94a5\u540e 80 \u5b57\u7b26: ${JSON.stringify(v.slice(-80))}${c.reset}`);
      try {
        crypto.createPublicKey(v);
        return { pass: true };
      } catch (e) {
        return { pass: false, msg: `无法解析: ${e.message}` };
      }
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

// ---------- 密钥配对检查 ----------
console.log(`${c.bold}━━━ 密钥配对检查 ━━━${c.reset}`);
const priv = results.HMDAO_ALI_PRIVATE_KEY;
const pub  = results.HMDAO_ALI_PUBLIC_KEY;

if (priv && priv.pass && priv.derived && pub && pub.pass) {
  // .env 私钥导出的公钥 vs .env 中的"平台公钥"（这两把**不应**相等！）
  const derived = pemBody(priv.derived);
  const inEnv   = pemBody(pub.raw);
  if (derived && inEnv && derived !== inEnv) {
    ok('私钥导出的"应用公钥" \u2260 .env 的"平台公钥"（预期行为，平台公钥是支付宝的）');
  } else if (derived === inEnv) {
    fail('.env 的"平台公钥"和你私钥导出的是同一把 \u2192 你可能把"应用公钥"复制到 HMDAO_ALI_PUBLIC_KEY 了');
    gray('正确做法：HMDAO_ALI_PUBLIC_KEY 必须是开放平台"接口加签方式"展示的"支付宝公钥"（平台下载），不是你上传的"应用公钥"');
  }

  // 与本地 sandbox 文件比对
  const localPub = path.join(ROOT, 'alipay-sandbox', 'alipay_public_key.pem');
  if (fs.existsSync(localPub)) {
    const localContent = fs.readFileSync(localPub, 'utf8');
    if (pemBody(localContent) === inEnv) {
      ok('.env 平台公钥 \u2194 alipay-sandbox/alipay_public_key.pem 一致');
    } else {
      warn('.env 平台公钥 \u2260 alipay-sandbox/alipay_public_key.pem');
      gray('以开放平台显示的"支付宝公钥"为准，可重新下载覆盖本地文件');
    }
  }

  // 打印"应用公钥"（需上传到开放平台）
  console.log();
  info('私钥导出的"应用公钥"——必须上传到 开放平台 \u2192 接口加签方式：');
  console.log(c.gray + '  ' + priv.derived.trim().replace(/\n/g, '\n  ') + c.reset);
  console.log(c.gray + '  （也可用于本地存档：alipay-sandbox/app_public_key_new.pem）' + c.reset);
} else {
  warn('私钥/平台公钥未同时就绪，跳过配对检查');
}

// ---------- 总结 ----------
console.log(`\n${c.bold}━━━ 总结 ━━━${c.reset}`);
if (allPass) ok('所有必填项已通过 \u2192 真实支付链路就绪');
else fail('存在未填写或无效的配置项，真实支付将无法启动');

console.log(`\n${c.gray}\u63d0\u793a\uff1a\u672c\u811a\u672c\u4ec5\u68c0\u67e5 .env \u672c\u5730\u914d\u7f6e\u3002\u5e73\u53f0\u4fa7\u52a8\u4f5c\uff08\u5c0f\u7a0b\u5e8f\u8ba4\u8bc1 / \u5f53\u9762\u4ed8\u7b7e\u7ea6 / NATIVE \u5f00\u901a / AppID \u7ed1\u5b9a\uff09\u9700\u4eba\u5de5\u5b8c\u6210\u3002${c.reset}\n`);

process.exit(allPass ? 0 : 1);
