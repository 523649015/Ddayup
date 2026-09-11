#!/usr/bin/env node
/**
 * 迁移端点真实性探针：对本轮外移的全部路由组逐个发起真实 HTTP 请求，
 * 断言「响应为业务语义」而非 404 未接线 / 500 ReferenceError（断点）。
 *
 * 判定规则：
 * - 404 且 body 含 "No route for" => 断点（路由未接线）
 * - 500 且 body 含 "is not defined" => 断点（deps 注入缺失）
 * - 其余状态码（200/400/401/403/502 等）均视为已接线并返回业务语义
 */
const BASE = process.env.HMDAO_API_BASE || 'http://127.0.0.1:8792';

const CASES = [
  // media 组
  { m: 'GET', p: '/api/curator/preview-proxy', group: 'media' },
  { m: 'GET', p: '/api/media-proxy', group: 'media' },
  { m: 'GET', p: '/api/youtube/extract', group: 'media' },
  { m: 'GET', p: '/api/youtube/formats', group: 'media' },
  { m: 'GET', p: '/api/platform/ytdlp', group: 'media' },
  { m: 'GET', p: '/api/transformers/__probe__.js', group: 'media' },
  { m: 'GET', p: '/api/local-model/__probe__', group: 'media' },
  { m: 'GET', p: '/api/hf-proxy/__probe__', group: 'media' },
  // cobuild 组
  { m: 'GET', p: '/api/cobuild', group: 'cobuild', expectOk: true },
  { m: 'POST', p: '/api/cobuild', group: 'cobuild', body: {} },
  { m: 'POST', p: '/api/cobuild/__id__/like', group: 'cobuild', body: {} },
  { m: 'POST', p: '/api/cobuild/__id__/comment', group: 'cobuild', body: {} },
  // search 组
  { m: 'POST', p: '/api/search/scrape-url', group: 'search', body: {} },
  { m: 'POST', p: '/api/search/free-images', group: 'search', body: { query: '' } },
  // local-ai 组
  { m: 'GET', p: '/api/dcc/local-artifacts/__probe__', group: 'local-ai' },
  { m: 'POST', p: '/api/local-image/analyze', group: 'local-ai', body: {} },
  { m: 'POST', p: '/api/local-video/edit', group: 'local-ai', body: {} },
  { m: 'GET', p: '/api/local-video/result/__probe__', group: 'local-ai' },
  { m: 'POST', p: '/api/local-audio/generate', group: 'local-ai', body: {} },
  { m: 'POST', p: '/api/audio/generate', group: 'local-ai', body: {} },
  { m: 'GET', p: '/api/local-audio/result/__probe__', group: 'local-ai' },
  { m: 'POST', p: '/api/local-post/process', group: 'local-ai', body: {} },
  { m: 'GET', p: '/api/local-post/result/__probe__', group: 'local-ai' },
  { m: 'POST', p: '/api/proxy-preview/__probe__', group: 'local-ai', body: {} },
  { m: 'POST', p: '/api/proxy/__probe__', group: 'local-ai', body: {} },
  // agent 组
  { m: 'POST', p: '/api/extension-ai', group: 'agent', body: {} },
  { m: 'GET', p: '/api/agent/memory', group: 'agent', expectOk: true },
  { m: 'POST', p: '/api/agent/memory', group: 'agent', body: {} },
  { m: 'DELETE', p: '/api/agent/memory', group: 'agent', body: {} },
  { m: 'POST', p: '/api/extension-agent-upload', group: 'agent', body: {} },
  { m: 'GET', p: '/api/extensions/free-search-pack', group: 'agent', expectOk: true },
  // 既有组回归
  { m: 'GET', p: '/api/health', group: 'health', expectOk: true },
  { m: 'GET', p: '/api/dcc/status', group: 'dcc', expectOk: true },
  { m: 'GET', p: '/api/models/catalog', group: 'models', expectOk: true },
  { m: 'GET', p: '/api/assets/library', group: 'assets', expectOk: true },
  { m: 'GET', p: '/api/byok/providers', group: 'byok', expectOk: true },
  { m: 'GET', p: '/api/byok/runtime', group: 'byok', expectOk: true },
  // 未注册路径必须 404
  { m: 'GET', p: '/api/__definitely_not_a_route__', group: '404', expect404: true },
];

async function run() {
  let pass = 0;
  let fail = 0;
  const rows = [];
  for (const c of CASES) {
    const init = { method: c.m, signal: AbortSignal.timeout(20000) };
    if (c.body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(c.body);
    }
    let status = 0;
    let text = '';
    let err = '';
    try {
      const r = await fetch(BASE + c.p, init);
      status = r.status;
      text = (await r.text()).slice(0, 300);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }

    let verdict;
    if (err) verdict = `FAIL 网络错误 ${err}`;
    else if (c.expect404) verdict = status === 404 && text.includes('No route for') ? 'PASS 正确 404' : `FAIL 期望 404 未命中，实际 ${status}`;
    else if (status === 404 && text.includes('No route for')) verdict = 'FAIL 断点：路由未接线';
    else if (status === 500 && /is not defined|ReferenceError/.test(text)) verdict = 'FAIL 断点：deps 注入缺失';
    else if (c.expectOk && status !== 200) verdict = `FAIL 期望 200 实际 ${status}`;
    else verdict = `PASS ${status}`;

    if (verdict.startsWith('PASS')) pass++;
    else fail++;
    rows.push(`${verdict.startsWith('PASS') ? '✓' : '✗'} [${c.group}] ${c.m} ${c.p} -> ${verdict}`);
  }
  console.log(rows.join('\n'));
  console.log(`\n迁移端点探针: PASS=${pass} FAIL=${fail} TOTAL=${CASES.length}`);
  process.exit(fail ? 1 : 0);
}

run();
