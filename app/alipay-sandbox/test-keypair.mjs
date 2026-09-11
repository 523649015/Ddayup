// 密钥诊断：验证本地密钥文件有效性 + 配对关系是否正确
// 运行：cd app && node alipay-sandbox/test-keypair.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(process.cwd(), 'alipay-sandbox');
const priv = fs.readFileSync(path.join(dir, 'app_private_key.pem'), 'utf8').trim();
const platformPub = fs.readFileSync(path.join(dir, 'alipay_public_key.pem'), 'utf8').trim();
let appPub = '';
const appPubPath = path.join(dir, 'app_public_key_new.pem');
if (fs.existsSync(appPubPath)) appPub = fs.readFileSync(appPubPath, 'utf8').trim();

function norm(pem) {
  // 兼容：无 PEM 头的裸 base64 → 自动补头
  if (pem.includes('-----BEGIN')) return pem;
  const b64 = pem.replace(/\s+/g, '');
  return `-----BEGIN PUBLIC KEY-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----`;
}

console.log('=== 1. 密钥文件解析 ===');
let privKey, pubKey, appPubKey;
try {
  privKey = crypto.createPrivateKey(priv);
  console.log('✅ 应用私钥     解析成功 |', privKey.asymmetricKeyType, privKey.asymmetricKeyDetails?.modulusLength, 'bit');
} catch (e) {
  console.log('❌ 应用私钥     解析失败:', e.message);
}
try {
  pubKey = crypto.createPublicKey(norm(platformPub));
  console.log('✅ 支付宝公钥   解析成功 |', pubKey.asymmetricKeyType, pubKey.asymmetricKeyDetails?.modulusLength, 'bit');
} catch (e) {
  console.log('❌ 支付宝公钥   解析失败:', e.message);
}
if (appPub) {
  try {
    appPubKey = crypto.createPublicKey(norm(appPub));
    console.log('✅ 应用公钥     解析成功 |', appPubKey.asymmetricKeyType, appPubKey.asymmetricKeyDetails?.modulusLength, 'bit');
  } catch (e) {
    console.log('❌ 应用公钥     解析失败:', e.message);
  }
}

console.log('\n=== 2. 配对关系（关键）===');
const msg = 'app_id=2021006192653226&method=alipay.trade.page.pay&out_trade_no=DD123';
if (privKey && appPubKey) {
  const sig = crypto.createSign('RSA-SHA256').update(msg, 'utf8').sign(privKey, 'base64');
  const ok = crypto.createVerify('RSA-SHA256').update(msg, 'utf8').verify(appPubKey, sig, 'base64');
  console.log(ok ? '✅ 应用私钥 ↔ 应用公钥 配对正确（你签名，支付宝用应用公钥验）'
                 : '❌ 应用私钥 ↔ 应用公钥 不配对！需重新生成并上传');
}
if (privKey && pubKey) {
  const sig = crypto.createSign('RSA-SHA256').update(msg, 'utf8').sign(privKey, 'base64');
  const ok = crypto.createVerify('RSA-SHA256').update(msg, 'utf8').verify(pubKey, sig, 'base64');
  console.log(ok ? '✅ 应用私钥 ↔ 支付宝公钥 也能验（异常，但无害）'
                 : 'ℹ️ 应用私钥 ↔ 支付宝公钥 不配对（正常：支付宝公钥只用于验支付宝的签名，不是给你签名的）');
}

console.log('\n=== 3. 模拟支付宝回调验签 ===');
// 用一把"模拟支付宝私钥"签名，再用支付宝公钥验——若支付宝公钥文件正确，
// 这一步无法本地自造（因为支付宝私钥在平台），故仅验证验签函数本身可用。
if (pubKey) {
  const { privateKey: fakeAli, publicKey: fakeAliPub } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const params = { out_trade_no: 'DD123', trade_status: 'TRADE_SUCCESS', total_amount: '99.00' };
  const sorted = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  const sig = crypto.createSign('RSA-SHA256').update(sorted, 'utf8').sign(fakeAli, 'base64');
  const okWithWrong = crypto.createVerify('RSA-SHA256').update(sorted, 'utf8').verify(pubKey, sig, 'base64');
  console.log(okWithWrong ? '⚠️ 假签名被验过（异常）' : '✅ 验签函数工作正常（假签名被正确拒绝）');
}

console.log('\n=== 结论 ===');
console.log('若「应用私钥 ↔ 应用公钥」显示 ✅，则你的密钥配置完全正确。');
console.log('支付宝回调验签必须用支付宝真实发来的通知测试，本地无法自造（支付宝私钥在平台侧）。');
