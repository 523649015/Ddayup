import { spawn } from 'node:child_process';
import http from 'node:http';

const api = spawn('node', ['server/hmdao-api.mjs'], { cwd: process.cwd(), stdio: 'ignore' });

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({
      hostname: '127.0.0.1',
      port: 8792,
      path,
      method,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
      },
    }, (res) => {
      let out = '';
      res.on('data', (chunk) => { out += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(out || '{}') });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function run() {
  await new Promise((resolve) => setTimeout(resolve, 800));
  const email = `terminal-${Date.now()}@hmdao.local`;
  const checks = [
    ['health', () => request('GET', '/api/health')],
    ['register', () => request('POST', '/api/auth/register', { email, password: 'Aa123456' })],
    ['login', () => request('POST', '/api/auth/login', { email, password: 'Aa123456' })],
    ['image-key', () => request('POST', '/api/byok/validate', {
      provider: 'siliconflow',
      apiKey: 'image-key-123456',
      mode: 'image',
      model: 'black-forest-labs/FLUX.1-schnell',
    })],
    ['video-key', () => request('POST', '/api/byok/validate', {
      provider: 'kling',
      apiKey: 'video-key-123456',
      mode: 'video',
      model: 'kling-v1-5',
    })],
    ['image-generate', () => request('POST', '/api/proxy/siliconflow', {
      endpoint: '/images/generations',
      method: 'POST',
      body: { model: 'black-forest-labs/FLUX.1-schnell', prompt: '终端验证图片' },
      apiKey: 'image-key-123456',
    })],
    ['video-generate', () => request('POST', '/api/proxy/kling', {
      endpoint: '/videos/generations',
      method: 'POST',
      body: { model: 'kling-v1-5', prompt: '终端验证视频' },
      apiKey: 'video-key-123456',
    })],
  ];

  const summary = [];
  for (const [name, fn] of checks) {
    const result = await fn();
    summary.push({
      name,
      status: result.status,
      success: Boolean(result.body.success),
      mode: result.body.mode,
      assetType: result.body.asset?.type,
    });
  }
  console.table(summary);
  if (summary.some((item) => item.status < 200 || item.status >= 300 || !item.success)) {
    throw new Error('Terminal verification failed');
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  api.kill();
});
