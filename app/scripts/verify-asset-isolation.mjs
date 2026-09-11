// 资产库硬隔离双账号验证脚本
// 验证点：
//  1) 未登录访问素材库接口 → 401
//  2) 双账号各自注册、各自导入素材
//  3) 账号A的素材库只含A的，不含B的；反之亦然（隔离核心）
//  4) 账号A用B的素材id访问字节流 → 非200（隔离）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BASE = 'http://127.0.0.1:8792';
const TS = Date.now();

function pickToken(session) {
  if (!session) return null;
  return (
    session.access_token ||
    session.token ||
    session.accessToken ||
    session.bearer ||
    null
  );
}

async function req(method, p, { token, body, isJson = true } = {}) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (isJson && body !== undefined) headers['Content-Type'] = 'application/json';
  const init = { method, headers };
  if (body !== undefined) init.body = isJson ? JSON.stringify(body) : body;
  const res = await fetch(BASE + p, init);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, json, text };
}

function listOf(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.items)) return json.items;
  if (Array.isArray(json.data)) return json.data;
  return [];
}

async function main() {
  const results = [];
  const log = (...a) => console.log(...a);

  // 1) 未登录 401
  const anon = await req('GET', '/api/assets/library');
  results.push(['未登录 GET /api/assets/library → 401', anon.status === 401]);
  log('未登录 status =', anon.status);

  // 2) 注册双账号
  const emailA = `iso-a-${TS}@example.com`;
  const emailB = `iso-b-${TS}@example.com`;
  const pw = 'IsoTest123!';
  const regA = await req('POST', '/api/auth/register', { body: { email: emailA, password: pw } });
  const regB = await req('POST', '/api/auth/register', { body: { email: emailB, password: pw } });
  if (!regA.json?.session || !regB.json?.session) {
    log('注册失败:', 'A', regA.status, regA.text?.slice(0, 300), 'B', regB.status, regB.text?.slice(0, 300));
    process.exit(2);
  }
  const tokenA = pickToken(regA.json.session);
  const tokenB = pickToken(regB.json.session);
  const idA = regA.json.user?.id;
  const idB = regB.json.user?.id;
  log('tokenA?', !!tokenA, 'tokenB?', !!tokenB, 'idA=', idA, 'idB=', idB);
  log('sessionA keys:', Object.keys(regA.json.session || {}));
  results.push(['账号A注册且有token', !!tokenA]);
  results.push(['账号B注册且有token', !!tokenB]);

  // 3) 准备临时素材文件
  const tmp = path.join(os.tmpdir(), `hmdao-iso-${TS}`);
  fs.mkdirSync(tmp, { recursive: true });
  const fileA = path.join(tmp, 'asset-a.txt');
  const fileB = path.join(tmp, 'asset-b.txt');
  fs.writeFileSync(fileA, `asset-A-content-${TS}`);
  fs.writeFileSync(fileB, `asset-B-content-${TS}`);

  // 4) 各自导入
  const impA = await req('POST', '/api/assets/import', {
    token: tokenA,
    body: { inputPath: fileA, type: 'text', copySourceFile: true, name: 'assetA' },
  });
  const impB = await req('POST', '/api/assets/import', {
    token: tokenB,
    body: { inputPath: fileB, type: 'text', copySourceFile: true, name: 'assetB' },
  });
  const idItemA = impA.json?.item?.id;
  const idItemB = impB.json?.item?.id;
  log('importA', impA.status, 'itemId=', idItemA, 'importB', impB.status, 'itemId=', idItemB);
  if (impA.status !== 200) log('importA text:', impA.text?.slice(0, 400));
  if (impB.status !== 200) log('importB text:', impB.text?.slice(0, 400));
  results.push(['账号A导入成功', impA.status === 200 && !!idItemA]);
  results.push(['账号B导入成功', impB.status === 200 && !!idItemB]);

  // 5) 列库隔离
  const libA = await req('GET', '/api/assets/library', { token: tokenA });
  const libB = await req('GET', '/api/assets/library', { token: tokenB });
  const itemsA = listOf(libA.json);
  const itemsB = listOf(libB.json);
  const idsA = itemsA.map((i) => i.id);
  const idsB = itemsB.map((i) => i.id);
  log('libA ids =', idsA);
  log('libB ids =', idsB);
  results.push(['A库含A的素材', idsA.includes(idItemA)]);
  results.push(['A库不含B的素材(隔离)', !idsA.includes(idItemB)]);
  results.push(['B库含B的素材', idsB.includes(idItemB)]);
  results.push(['B库不含A的素材(隔离)', !idsB.includes(idItemA)]);

  // 6) 反向读取：A 用 B 的素材id访问字节流 → 应非200
  if (idItemB) {
    const contentBByA = await req('GET', `/api/assets/content/${idItemB}`, { token: tokenA });
    log('A访问B素材content status =', contentBByA.status);
    results.push(['A不能读取B的素材字节(隔离)', contentBByA.status !== 200]);
  }

  log('\n=== 验证结果 ===');
  let allPass = true;
  for (const [name, pass] of results) {
    log(`${pass ? 'PASS ✅' : 'FAIL ❌'}  ${name}`);
    if (!pass) allPass = false;
  }
  log(allPass ? '\n全部通过：资产库按用户硬隔离已生效' : '\n存在失败项');
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(3); });
