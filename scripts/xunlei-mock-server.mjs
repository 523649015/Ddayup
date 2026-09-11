// 本地 HTTPS mock 服务器（自签证书），模拟 api-pan.xunlei.com 三端点。
// 配合 hosts 重定向：把 api-pan.xunlei.com 指向 127.0.0.1，让扩展 background SW fetch 真正打到本 mock。
// 用法：node scripts/xunlei-mock-server.mjs  （会打印证书指纹，需手动信任或忽略证书错误）
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import fs from 'fs';

const PORT = 9443;
const PASS_TOKEN = 'MOCK_PASS_TOKEN_abc123';
const FID = 'VOj-gdWBPeCnQdqryg0WRKi3A1';
const SHARE_ID = 'VOj-h8suAkW9oy_-90W8M4r9A1';

// 生成自签证书
function genCert() {
  const attrs = [{ name: 'commonName', value: 'api-pan.xunlei.com' }];
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const cert = crypto.createSign('SHA256').update('').end();
  // 用更简单的自签：用 forge 替代太重，这里用 Node 原生 X509 不成，改手工构造。
  // 简化：用 crypto 的 Certificate 对象（Node 15+）
  const { Certificate } = crypto;
  const csr = crypto.createSign('SHA256');
  const certObj = new Certificate();
  certObj.serialNumber = '01';
  certObj.validity.notBefore = new Date();
  certObj.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  certObj.subject = { CN: 'api-pan.xunlei.com' };
  certObj.issuer = { CN: 'hmdao-mock-ca' };
  certObj.setPublicKey(publicKey);
  certObj.sign(privateKey, 'sha256');
  return { key: privateKey.export({ type: 'pkcs1', format: 'pem' }), cert: certObj.toString('pem') };
}

let cert;
try { cert = genCert(); } catch (e) {
  console.error('生成证书失败，回退到内嵌静态自签证书。错误:', e.message);
  // 静态回退（若上面的原生 API 不可用）
  cert = { key: '', cert: '' };
}

function handler(req, res) {
  const u = new URL(req.url, 'https://api-pan.xunlei.com');
  const q = u.searchParams;
  console.log('[MOCK]', req.method, u.pathname, 'space=', q.get('space'), 'hasToken=', !!q.get('pass_code_token'));
  res.setHeader('Content-Type', 'application/json');
  if (u.pathname === '/drive/v1/share') {
    res.end(JSON.stringify({
      pass_code_token: PASS_TOKEN,
      total: 1,
      files: [{ id: FID, name: '植物大战僵尸杂交版v2.5.zip', size: 1234567890, file_category: 'file', parent_folder_id: 'VOj-gdTB91WnwpJ1mUgknd7fA1' }]
    }));
    return;
  }
  if (u.pathname === '/drive/v1/share/file_info') {
    res.end(JSON.stringify({ success: true, file_info: { id: FID, name: 'x.zip', size: 123, space: q.get('space') || '' } }));
    return;
  }
  if (u.pathname === '/drive/v1/share/download_url') {
    if (!q.get('pass_code_token')) { res.statusCode = 400; res.end(JSON.stringify({ error_code: 'NO_TOKEN' })); return; }
    res.end(JSON.stringify({ download_url: `https://mock-cdn.xunlei.com/${q.get('space')||'root'}/${FID}.zip?token=MOCK`, file_name: 'x.zip', size: 123 }));
    return;
  }
  res.statusCode = 404; res.end('{}');
}

if (!cert.key) { console.error('无可用证书，退出'); process.exit(2); }
const server = https.createServer({ key: cert.key, cert: cert.cert }, handler);
server.listen(PORT, '127.0.0.1', () => {
  console.log(`>> mock HTTPS on https://api-pan.xunlei.com (本地 127.0.0.1:${PORT})`);
  console.log('>> 请在 hosts 加: 127.0.0.1 api-pan.xunlei.com');
  console.log('>> 并在 Chrome 访问一次忽略证书警告，或启动 Chrome 加 --ignore-certificate-errors');
});
