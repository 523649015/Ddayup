import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// 模拟 loadEnv 逻辑
function loadEnvFile(name) {
  const file = path.join(process.cwd(), name);
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    v = v.replace(/\\n/g, '\n');
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
loadEnvFile('.env.alipay');

const priv = process.env.ALIPAY_PRIVATE_KEY;
const pub = process.env.ALIPAY_PUBLIC_KEY;

// 自签自验
const msg = 'app_id=2021006192653226&method=alipay.trade.page.pay&out_trade_no=DD123';
const signer = crypto.createSign('RSA-SHA256').update(msg, 'utf8');
const sig = signer.sign(crypto.createPrivateKey(priv), 'base64');
const ok = crypto.createVerify('RSA-SHA256').update(msg, 'utf8').verify(crypto.createPublicKey(pub), sig, 'base64');
console.log('private key valid:', !!crypto.createPrivateKey(priv));
console.log('public key valid:', !!crypto.createPublicKey(pub));
console.log('self sign+verify (simulates notify verify):', ok);
