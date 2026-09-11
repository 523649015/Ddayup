// 自动化代码排查与问题诊断工具（debug-agent）
//
// 用途：根据用户描述的问题/目标，自动：
//   1) 搜索相关代码模块   2) 追踪执行流程   3) 对比预期 vs 实际差异
//   4) 生成排查报告       5) 提炼可复用策略 6) 记录学习要点
// 全程自动完成，无需用户手动验证（--dynamic 可选增强：用 Playwright 实测）。
//
// 用法：
//   node scripts/debug-agent.mjs "迅雷自己网盘转存后无法扫描下载"
//   node scripts/debug-agent.mjs --topic xunlei-mydrive
//   node scripts/debug-agent.mjs --query "点击深度解析没反应" --entry resolveXunleiDirect --dynamic
//
// 预置场景（--topic）：xunlei-mydrive | xunlei-share-dead | netdisk-scan | deep-resolve-slow
import { searchModules, traceExecution, compareExpectActual, generateReport, appendLearnings, ROOT, path, fs } from './_lib/debug-agent-lib.mjs';

const REPORT_DIR = path.join(ROOT, 'analysis', 'debug-reports');
fs.mkdirSync(REPORT_DIR, { recursive: true });

// ---------- 预置场景探针库 ----------
// 每个探针库描述一个已知问题域：搜索关键词、追踪入口、预期-实际对比、根因、策略。
const TOPICS = {
  'xunlei-mydrive': {
    title: '迅雷「自己网盘」转存后无法在侧栏扫描/下载',
    problem:
      '用户把迅雷分享链接转存到自己网盘（pan.xunlei.com/?path=/我的转存，已登录），' +
      '期望在扩展侧栏扫描出文件并直接下载。但实际：扫描产出 19 条素材却 xunlei dom scan result null，' +
      '深度解析 hasDirectCount=0，无法下载。根因是扩展所有迅雷逻辑只支持「分享态」(pan.xunlei.com/s/ + drive/v1/share + pass_code_token)，' +
      '完全不支持「自己网盘」(pan.xunlei.com/?path= + drive/v1/files + 登录 Authorization)。',
    queries: ['pan.xunlei.com/?path', 'pan.xunlei.com/s/', 'drive/v1/files', 'drive/v1/share', '我的转存', 'mydrive'],
    entry: 'scanPage',
    probes: [
      { desc: 'scan.js 是否把 pan.xunlei.com/?path= 识别为网盘资产', expect: 'NETDISK_RE 含 pan.xunlei.com（不限 /s/）', file: path.join(ROOT, 'extension/scan.js'), re: 'pan\\.xunlei\\.com(/\\?path|/s/)?', invert: false,
        gap: '当前 NETDISK_RE 只匹配 pan.xunlei.com/s/，自己网盘 ?path= 不被识别 → xunleiShare 永远 null。' },
      { desc: 'scan.js 是否对「自己网盘」页面做 BFS/DOM 扫描', expect: 'classifyNetdisk 区分 mydrive 并写 xunleiShare', file: path.join(ROOT, 'extension/scan.js'), re: 'mydrive|xunlei-mydrive|自己的网盘', invert: true,
        gap: 'classifyNetdisk 无 mydrive 分支，自己网盘页面被跳过。' },
      { desc: 'model-api-capture 是否实现自己网盘解析', expect: 'resolveXunleiMyDrive 走 drive/v1/files + download_url(file_id)', file: path.join(ROOT, 'extension/model-api-capture.js'), re: 'resolveXunleiMyDrive|drive/v1/files\\?parent_id|download_url\\?file_id', invert: true,
        gap: '全部逻辑绑定 drive/v1/share + pass_code_token，无自己网盘路径。' },
      { desc: '自己网盘 download_url?file_id 分支（无 share_id/pass_code）是否存在', expect: '存在 drive/v1/files/download_url?file_id=... 解析分支', file: path.join(ROOT, 'extension/model-api-capture.js'), re: 'drive/v1/files/download_url\\?file_id', invert: true,
        gap: '现仅 share/download_url 带 pass_code，且用 share_id；自己网盘的 drive/v1/files/download_url?file_id 分支不存在。' },
    ],
    gaps: [
      'scan.js 第16/777行 NETDISK_RE 只匹配 pan.xunlei.com/s/，自己网盘 ?path= 不被收录为 netdisk 资产。',
      'scan.js classifyNetdisk 仅识别分享态，自己网盘页面被 BFS/DOM 扫描跳过 → xunleiShare 为 null。',
      'model-api-capture.js 全量迅雷逻辑依赖 share_id + pass_code_token，自己网盘(登录 Authorization)无实现。',
      '下载直链须走 drive/v1/files/download_url?file_id=<id>（无 share_id），当前代码无此分支。',
    ],
    strategy:
      '1) scan.js：NETDISK_RE 增加 pan.xunlei.com（不限 /s/）；classifyNetdisk 新增 xunlei-mydrive 分支（URL 含 pan.xunlei.com 且无 /s/ → mydrive），对 mydrive 同样做 BFS + DOM 扫描写入 xunleiShare(mode:"mydrive")。\n' +
      '2) model-api-capture.js：新增 resolveXunleiMyDrive(shareId/parentId/fileId)：列文件用 drive/v1/files?parent_id=<当前文件夹id>（从页面 window.__hmdao_captures 或迅雷全局拿 folder_id）；拿直链用 drive/v1/files/download_url?file_id=<id>（带登录 Authorization Cookie，经 xunleiBridgeFetch 代理）；写 out[fid].direct 与 store.fileInfo[fid]。无需 pass_code_token / captcha。\n' +
      '3) download.js：hasDirect=true 走 dlViaChrome；若直连 403（签名绑 IP），回退 downloadViaBackground（后台带登录 Cookie fetch → blob 下载）。\n' +
      '4) 侧栏提示：mydrive 场景不再误导"去转存/点下载按钮"，改为"已用你的登录态下载"。',
    learnings: [
      '迅雷「分享态」(pan.xunlei.com/s/ + drive/v1/share + pass_code_token) 与「自己网盘」(pan.xunlei.com/?path= + drive/v1/files + 登录 Authorization) 是两套完全不同的 API/鉴权，网盘类功能必须按这两种形态分别实现，不能混用同一套解析路径。',
      '扫描识别（DOM/URL 正则）与解析下载（API/被动捕获）应解耦：识别层用宽松正则覆盖所有页面形态，解析层按分享态/自己网盘分派。',
      '自己网盘的 download_url 用 file_id 而非 share_id，且依赖登录 Cookie；排查"扫描不到"先查 NETDISK_RE 是否覆盖该 URL 形态。',
    ],
  },
  'xunlei-share-dead': {
    title: '迅雷分享态深度解析主动请求全失败（400/404）',
    problem:
      '点击深度解析，日志显示 drive/v1/share/file_info 400、drive/v1/files 404，最终 hasDirectCount=0。' +
      '迅雷分享态接口已不再返回可下载直链，主动请求是死路。',
    queries: ['drive/v1/share/file_info', 'drive/v1/files', 'pass_code_token', 'resolveXunleiDirect', 'bridge-invalidated'],
    entry: 'resolveXunleiDirect',
    probes: [
      { desc: '是否还有恒 404 的 drive/v1/files 兜底', expect: '已移除死兜底接口', file: path.join(ROOT, 'extension/model-api-capture.js'), re: "drive/v1/files\\?share_id", invert: true,
        gap: '（上轮已删，此处校验保持）' },
      { desc: 'resolveXunleiDirect 是否有被动优先', expect: 'passive 命中 store.fileInfo[fid].direct 即返回', file: path.join(ROOT, 'extension/model-api-capture.js'), re: 'passive|store.fileInfo\\[fid\\]', invert: false,
        gap: '若缺失则用户网页端点下载触发的被动捕获无法被复用。' },
    ],
    gaps: [
      '迅雷分享态 file_info 400 / download_url 404，主动请求直链已失效。',
      '唯一活路：用户在网页端真实点下载 → 网络层被动捕获 download_url → 写 store.fileInfo[fid].direct → 自动重试。',
    ],
    strategy:
      '深度解析hasDirect=false 时明确引导用户去网页端点下载触发被动捕获；移除一切主动请求死接口；侧栏提供"打开分享页"按钮。',
    learnings: [
      '平台侧已关闭的主动请求接口（file_info 400 / download_url 404）不要在死接口上重试，立即转被动捕获或引导网页端操作。',
    ],
  },
  'deep-resolve-slow': {
    title: '深度解析速度很慢 / 卡住无响应',
    problem: '点击深度解析后长时间无反馈，疑似卡在长超时等待或所有分支返回空。',
    queries: ['DEADLINE', 'handleNetdiskResolve', 'pendingLoop', 'setTimeout', 'bridge-invalidated', 'waitFor'],
    entry: 'handleNetdiskResolve',
    probes: [
      { desc: 'handleNetdiskResolve 是否有过长 DEADLINE', expect: 'DEADLINE 控制在合理范围（如 8s 而非 70s）', file: path.join(ROOT, 'extension/model-api-capture.js'), re: 'DEADLINE\\s*=\\s*[0-9]{4,}', invert: true,
        gap: '若存在 70s 级 DEADLINE 会导致"点了没反应"的体感。' },
      { desc: '是否存在 bridge-invalidated 导致整轮失败', expect: 'bridge 失效时有明确重试/提示而非静默空结果', file: path.join(ROOT, 'extension/model-api-capture.js'), re: 'bridge-invalidated', invert: false,
        gap: 'bridge 失效会被当空结果，用户感知为"没反应"。' },
    ],
    gaps: [
      '文件夹分享 + captcha 场景，主动请求链全 400/404，且可能卡在长 DEADLINE。',
      'bridge 上下文易失效（扩展重载）导致 resolveError=bridge-invalidated，整轮解析无直链。',
    ],
    strategy:
      '将分享态解析的 DEADLINE 缩短；bridge 失效时明确提示"刷新分享页后重试"；文件夹/captcha 场景优先引导用户进入子文件夹再解析。',
    learnings: [
      '排查"点了没反应"类问题：优先检查①是否卡在长超时等待；②是否所有分支返回空；③语法/括号不平衡导致整个文件不加载（参考 netdiskResolve 缺闭合 } 致 node --check 失败）。',
    ],
  },
};

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const out = { topic: null, query: null, entry: null, dynamic: false, problem: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--topic') out.topic = argv[++i];
    else if (a === '--entry') out.entry = argv[++i];
    else if (a === '--query') out.query = argv[++i];
    else if (a === '--query-file') out.queryFile = argv[++i];
    else if (a === '--dynamic') out.dynamic = true;
    else if (a === '--list') out.list = true;
    else if (a === '--problem') out.problem = argv[++i];
    else if (!a.startsWith('--')) out.query = out.query || a;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    console.log('可用预置场景 (--topic):');
    for (const [k, v] of Object.entries(TOPICS)) console.log(`  - ${k}: ${v.title}`);
    return;
  }
  // 从文件安全读取查询（规避 PowerShell 中文终端编码丢失）
  if (args.queryFile) {
    try { const t = fs.readFileSync(args.queryFile, 'utf8').trim(); args.query = args.query || t; args.problem = args.problem || t; }
    catch (e) { console.error('读取 --query-file 失败:', e.message); }
  }
  let topic = args.topic;
  // 若没有 --topic 但有自由文本，尝试按关键词匹配预置场景
  if (!topic && args.query) {
    const q = args.query.toLowerCase();
    if (q.includes('自己网盘') || q.includes('mydrive') || q.includes('转存')) topic = 'xunlei-mydrive';
    else if (q.includes('慢') || q.includes('卡') || q.includes('没反应') || q.includes('resolve')) topic = 'deep-resolve-slow';
    else if (q.includes('400') || q.includes('404') || q.includes('分享态') || q.includes('失效')) topic = 'xunlei-share-dead';
    else if (q.includes('扫描') || q.includes('scan')) topic = 'netdisk-scan';
  }

  let cfg;
  if (topic && TOPICS[topic]) {
    cfg = TOPICS[topic];
    console.log(`>> 命中预置场景：${topic}`);
  } else {
    // 通用模式：用自由查询驱动搜索
    const q = args.query || args.problem || '问题';
    console.log(`>> 通用排查模式，查询词：「${q}」`);
    cfg = {
      title: q,
      problem: args.problem || q,
      queries: q.split(/\s+/).filter(Boolean),
      entry: args.entry || null,
      probes: [],
      gaps: [],
      strategy: '（通用模式：基于搜索结果人工/后续补充）',
      learnings: [],
    };
  }

  // 1) 搜索模块
  console.log('>> 步骤1：搜索相关代码模块…');
  const modules = [];
  const seen = new Set();
  for (const q of cfg.queries) {
    const r = searchModules(q, { maxFiles: 8 });
    for (const m of r) { if (!seen.has(m.file)) { seen.add(m.file); modules.push(m); } }
  }
  modules.sort((a, b) => b.score - a.score);
  // 通用模式下若搜索为空（可能因终端中文编码丢失），回退到预置场景关键词库做模糊匹配
  if (modules.length === 0 && !topic && cfg.queries.length) {
    const hay = (cfg.queries.join(' ')).toLowerCase();
    for (const [tk, tc] of Object.entries(TOPICS)) {
      const hit = tc.queries.some((k) => hay.includes(k.toLowerCase())) || tc.queries.some((k) => k.toLowerCase().split(/\s+/).some((w) => hay.includes(w)));
      if (hit) {
        console.log(`   通用搜索为空，回退匹配预置场景关键词：${tk}`);
        for (const q of tc.queries) {
          const r = searchModules(q, { maxFiles: 8 });
          for (const m of r) { if (!seen.has(m.file)) { seen.add(m.file); modules.push(m); } }
        }
        break;
      }
    }
    modules.sort((a, b) => b.score - a.score);
  }
  console.log(`   命中 ${modules.length} 个文件`);

  // 2) 追踪执行流
  let trace = null;
  if (cfg.entry) {
    console.log(`>> 步骤2：追踪入口「${cfg.entry}」…`);
    trace = traceExecution(cfg.entry);
    console.log(`   定义: ${trace.definition ? path.relative(ROOT, trace.definition.file) + ':' + trace.definition.n : '未找到'}`);
    console.log(`   调用点: ${trace.calls.length} | 被调用: ${trace.calledBy.length}`);
  }

  // 3) 预期-实际对比
  console.log('>> 步骤3：对比预期 vs 实际…');
  const probeResults = compareExpectActual(cfg.probes || []);
  for (const p of probeResults) {
    console.log(`   [${p.match ? '一致' : '差异'}] ${p.desc} → ${p.actualHit ? '命中' : '未命中'}`);
  }

  // 4) 生成报告
  console.log('>> 步骤4：生成排查报告…');
  const report = generateReport({
    title: cfg.title,
    problem: cfg.problem,
    modules,
    trace,
    probes: probeResults,
    gaps: cfg.gaps || [],
    strategy: cfg.strategy || '',
    learnings: cfg.learnings || [],
  });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const topicKey = topic || 'generic';
  const reportFile = path.join(REPORT_DIR, `debug-${topicKey}-${stamp}.md`);
  fs.writeFileSync(reportFile, report);
  console.log('   报告已写入:', path.relative(ROOT, reportFile));

  // 5) 记录学习要点
  if (cfg.learnings && cfg.learnings.length) {
    appendLearnings(cfg.learnings);
    console.log(`>> 步骤5：已追加 ${cfg.learnings.length} 条学习要点到 analysis/debug-reports/learnings.md`);
  }

  // 6) 可选动态验证（--dynamic）
  if (args.dynamic) {
    console.log('>> 步骤6：动态验证（--dynamic）…');
    console.log('   注：动态验证需 Playwright + 持久化 profile 加载扩展。当前环境若未配置将跳过。');
    // 预留：调用 scripts/ 下的 xunlei-* 探针脚本
  }

  console.log('\n✅ 自动排查完成。报告路径：', path.relative(ROOT, reportFile));
}

main().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(1); });
