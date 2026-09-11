import fs from 'node:fs';
import crypto from 'node:crypto';

const env = fs.readFileSync('.env', 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

// 找 HMDAO_ALI_PUBLIC_KEY 起始位置
const idx = env.indexOf('HMDAO_ALI_PUBLIC_KEY=');
console.log('起始位置:', idx);

// 从起始位置开始取
const after = env.slice(idx);
// 找到下一个 = 开头的变量或文件结尾
let endIdx = after.search(/\n[A-Z_][A-Z0-9_]*\s*=/);
if (endIdx === -1) endIdx = after.length;
let raw = after.slice(0, endIdx).trim();
console.log('原始内容 (长度=' + raw.length + '):');
console.log('前 150:', JSON.stringify(raw.slice(0, 150)));
console.log('后 150:', JSON.stringify(raw.slice(-150)));
console.log();

// 提取值
let v = raw.replace(/^HMDAO_ALI_PUBLIC_KEY=/, '');
// 去掉首尾引号
if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
// 转义
v = v.replace(/\\n/g, '\n').replace(/\\"/g, '"');

console.log('处理后值 (长度=' + v.length + '):');
console.log('前 100:', JSON.stringify(v.slice(0, 100)));
console.log('后 100:', JSON.stringify(v.slice(-100)));
console.log();

console.log('尝试 1: 原样解析');
try { crypto.createPublicKey(v); console.log('  ✅ 成功'); }
catch (e) { console.log('  ❌', e.message); }

console.log('尝试 2: 标准化空白');
try {
  const v2 = v.replace(/\n{2,}/g, '\n').trim();
  crypto.createPublicKey(v2);
  console.log('  ✅ 成功, 长度=' + v2.length);
} catch (e) { console.log('  ❌', e.message); }

console.log('尝试 3: 直接读取 .env.alipay 看公钥');
const env2 = fs.readFileSync('.env.alipay', 'utf8');
const m2 = env2.match(/ALIPAY_PUBLIC_KEY=([\s\S]+?)(?:\n[A-Z_]|\s*$)/);
if (m2) {
  let v2 = m2[1].trim().replace(/^"|"$/g, '').replace(/\\n/g, '\n');
  console.log('  长度:', v2.length);
  console.log('  前 100:', JSON.stringify(v2.slice(0, 100)));
  try { crypto.createPublicKey(v2); console.log('  ✅ 成功'); }
  catch (e) { console.log('  ❌', e.message); }
}
