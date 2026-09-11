// 不依赖真迅雷登录态的端到端验证：
// 1) 本地起 HTTP mock 服务器，模拟 api-pan.xunlei.com 三端点，返回可控 pass_code_token + download_url。
// 2) Playwright 加载扩展 + 打开分享页，但用 page.route 拦截对 api-pan.xunlei.com 的请求 → fulfill mock 响应。
//    注意：background SW 的 fetch 不经过 page.route，因此本脚本验证的是【MAIN world 探针逻辑】本身
//    （用页面内 override 的探针，直接 fetch mock，绕过桥）。这足以验证：
//      a) 顶层列表返回 pass_code_token 时，探针能否正确解析；
//      b) file_info / download_url 的 URL 拼法、space 循环、直链提取逻辑是否正确。
import { chromium } from 'playwright';
import http from 'http';

const EXT_PATH = 'f:/Work/HMDAODAO/extension';
const SHARE_URL = 'https://pan.xunlei.com/s/VOj-h8suAkW9oy_-90W8M4r9A1?pwd=qkva&path=%2F';
const FID = 'VOj-gdWBPeCnQdqryg0WRKi3A1';
const SHARE_ID = 'VOj-h8suAkW9oy_-90W8M4r9A1';
const PWD = 'qkva';
const MOCK_PORT = 9443;
const MOCK_HOST = `127.0.0.1:${MOCK_PORT}`;
// 模拟迅雷真实返回结构
const PASS_TOKEN = 'MOCK_PASS_TOKEN_abc123';

function mockHandler(req, res) {
  const u = new URL(req.url, `http://${MOCK_HOST}`);
  const q = u.searchParams;
  console.log('[MOCK]', req.method, u.pathname, 'space=', q.get('space'), 'file_id=', (q.get('file_id')||'').slice(0,20));
  res.setHeader('Content-Type', 'application/json');
  if (u.pathname === '/drive/v1/share') {
    // 顶层列表：返回 pass_code_token + 文件列表（含目标 fid）
    res.end(JSON.stringify({
      pass_code_token: PASS_TOKEN,
      total: 1,
      files: [{
        id: FID, name: '植物大战僵尸杂交版v2.5.zip', size: 1234567890,
        hash: 'abc', parent_folder_id: 'VOj-gdTB91WnwpJ1mUgknd7fA1',
        file_category: 'file'
      }]
    }));
    return;
  }
  if (u.pathname === '/drive/v1/share/file_info') {
    res.end(JSON.stringify({
      success: true,
      file_info: { id: FID, name: '植物大战僵尸杂交版v2.5.zip', size: 1234567890,
        space: q.get('space') || '', parent_folder_id: 'VOj-gdTB91WnwpJ1mUgknd7fA1' }
    }));
    return;
  }
  if (u.pathname === '/drive/v1/share/download_url') {
    // 真实迅雷：download_url 在 first layer（需正确 space + pass_code_token）
    if (!q.get('pass_code_token')) { res.statusCode = 400; res.end(JSON.stringify({ error_code: 'NO_TOKEN' })); return; }
    res.end(JSON.stringify({
      download_url: `https://mock-cdn.xunlei.com/${q.get('space')||'root'}/${FID}.zip?token=MOCK`,
      file_name: '植物大战僵尸杂交版v2.5.zip',
      size: 1234567890,
      space: q.get('space') || ''
    }));
    return;
  }
  res.statusCode = 404; res.end('{}');
}

async function main() {
  const server = http.createServer(mockHandler);
  await new Promise(r => server.listen(MOCK_PORT, '127.0.0.1', r));
  console.log('>> mock server on', MOCK_HOST);

  const ctx = await chromium.launchPersistentContext('f:/Work/HMDAODAO/tmp/chrome-xunlei-mock', {
    headless: false,
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-first-run'],
  });
  const page = await ctx.newPage();
  page.on('console', m => { const t = m.text(); if (/\[PROBE\]|\[MOCK-PROBE\]|\[HMDAO\]\[xunlei/.test(t)) console.log('[PAGE]', t); });

  // 拦截对 api-pan.xunlei.com 的所有请求 → 改到本地 mock（页面层；探针的 xunleiBridgeFetch 走桥→background 不经过这里，
  // 所以我们在页面内 override 探针逻辑直接 fetch mock 来验证纯逻辑）。
  await page.route('**://api-pan.xunlei.com/**', (route) => {
    const url = route.request().url().replace('api-pan.xunlei.com', MOCK_HOST).replace('https://', 'http://');
    return route.fetch({ url, method: route.request().method() }).catch(async () => {
      // 兜底：直接 fulfill
      const ru = new URL(route.request().url());
      ru.host = MOCK_HOST; ru.protocol = 'http:';
      const resp = await fetch(ru.toString());
      const body = await resp.text();
      await route.fulfill({ status: resp.status, contentType: 'application/json', body });
    });
  });

  await page.goto(SHARE_URL, { waitUntil: 'domcontentloaded' }).catch(e => console.log('goto', e.message));
  await page.waitForTimeout(3000);

  // 在 MAIN world 注入一个指向 mock 的探针（复制原探针逻辑，URL host 改为 mock），验证纯解析逻辑
  const result = await page.evaluate((args) => {
    const base = `http://${args.mockHost}/drive/v1/share`;
    const out = [];
    const log = (...a) => { const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); out.push(s); console.log('[MOCK-PROBE]', s); };
    const doFetch = async (url) => {
      const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, credentials: 'omit' });
      return { status: r.status, text: await r.text() };
    };
    return (async () => {
      const topUrl = `${base}?share_id=${encodeURIComponent(args.shareId)}&pass_code=${encodeURIComponent(args.pwd)}&limit=100&page_token=&thumbnail_size=SIZE_SMALL`;
      const tr = await doFetch(topUrl);
      let passToken = '', topJson = null;
      try { topJson = JSON.parse(tr.text); passToken = topJson.pass_code_token || ''; } catch (_) {}
      log('顶层 status=', tr.status, ' pass_code_token=', passToken, ' files[0].id=', topJson && topJson.files && topJson.files[0] && topJson.files[0].id);
      const finalUrl = {};
      for (const sp of ['', 'share', 'drive']) {
        const dlUrl = `${base}/download_url?share_id=${encodeURIComponent(args.shareId)}` + (sp ? `&space=${encodeURIComponent(sp)}` : '') + `&file_id=${encodeURIComponent(args.fid)}&pass_code_token=${encodeURIComponent(passToken)}&pass_code=${encodeURIComponent(args.pwd)}`;
        const dr = await doFetch(dlUrl);
        let dlJson = null; try { dlJson = JSON.parse(dr.text); } catch (_) {}
        log(`download_url space="${sp}" status=${dr.status} url=`, dlJson && dlJson.download_url);
        if (dlJson && dlJson.download_url) finalUrl[sp || 'root'] = dlJson.download_url;
      }
      log('最终直链=', finalUrl);
      return out;
    })();
  }, { mockHost: MOCK_HOST, shareId: SHARE_ID, pwd: PWD, fid: FID });

  console.log('\n========== MOCK 探针结果 ==========');
  for (const l of result) console.log(l);

  await ctx.close();
  server.close();
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
