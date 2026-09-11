import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const dir = path.join(process.cwd(), 'alipay-sandbox');
fs.writeFileSync(path.join(dir, 'app_private_key.pem'), privateKey);
fs.writeFileSync(path.join(dir, 'app_public_key_new.pem'), publicKey);

console.log('===== 应用私钥已保存: alipay-sandbox/app_private_key.pem =====');
console.log('===== 应用公钥(下方复制上传到平台) =====');
console.log(publicKey);
console.log('===== 上传后平台会给「支付宝公钥」，保存到 alipay_public_key.pem =====');
