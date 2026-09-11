import fs from 'node:fs';
import path from 'node:path';

const file = path.join(process.cwd(), '.env');
let ok = 0;
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (!(m[1] in process.env)) process.env[m[1]] = v;
  ok++;
}
console.log('parsed keys:', ok);
console.log('APPID =', process.env.ALIPAY_APP_ID);
console.log('private key length =', (process.env.ALIPAY_PRIVATE_KEY || '').length);
console.log('public key length =', (process.env.ALIPAY_PUBLIC_KEY || '').length);
console.log('ENV =', process.env.ALIPAY_ENV || 'sandbox(default)');
