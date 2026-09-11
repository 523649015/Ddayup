// 自动化排查工具核心库（debug-agent 的纯逻辑层，便于单测/复用）。
// 提供：模块搜索 / 执行流追踪 / 预期-实际差异对比 / 报告与学习要点生成。
// 设计原则：所有分析自动完成，不依赖用户手动验证（动态验证为可选的 --dynamic 增强）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..'); // scripts/_lib -> 仓库根

// 待扫描的代码根（可按需扩展）
const SCAN_ROOTS = [
  path.join(ROOT, 'extension'),
  path.join(ROOT, 'app'),
  path.join(ROOT, 'scripts'),
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'tmp', 'tmp-store', '_archive']);

// ---------- 1. 模块搜索 ----------
// 多策略：字面片段 / 符号（函数/常量/消息常量）/ 注释 / 文件名
export function searchModules(query, opts = {}) {
  const q = query.trim();
  const kwList = q.split(/\s+/).filter(Boolean);
  const hits = []; // {file, lines:[{n,text,kind}], score}
  const fileIndex = buildFileIndex();
  for (const f of fileIndex) {
    const text = safeRead(f);
    if (!text) continue;
    const lines = text.split('\n');
    const lineHits = [];
    let score = 0;
    lines.forEach((ln, i) => {
      const n = i + 1;
      // 消息常量命中（优先级最高）
      if (/(HMDAO_[A-Z_]+|chrome\.runtime\.sendMessage|type:\s*'[\w-]+')/.test(ln) && ln.toLowerCase().includes(q.toLowerCase())) {
        lineHits.push({ n, text: ln.trim(), kind: 'msg' }); score += 5;
      } else if (new RegExp('\\b(function|const|let|var|class|async\\s+function)\\s+[\\w$]*' + escapeRe(q), 'i').test(ln)) {
        lineHits.push({ n, text: ln.trim(), kind: 'def' }); score += 4;
      } else if (ln.includes(q) || kwList.some((k) => ln.toLowerCase().includes(k.toLowerCase()))) {
        lineHits.push({ n, text: ln.trim(), kind: 'hit' }); score += 2;
      }
      // 注释里的线索
      if (/^\s*(\/\/|#|\*)/.test(ln) && ln.toLowerCase().includes(q.toLowerCase())) score += 1;
    });
    // 文件名命中
    const base = path.basename(f);
    if (base.toLowerCase().includes(q.toLowerCase())) score += 6;
    if (score > 0) hits.push({ file: f, score, lines: lineHits.slice(0, 12) });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, opts.maxFiles || 15);
}

function buildFileIndex() {
  const out = [];
  for (const root of SCAN_ROOTS) walk(root, out);
  return out;
}
function walk(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, out); }
    else if (/\.(js|mjs|cjs|ts|tsx|json)$/.test(e.name)) out.push(p);
  }
}
function safeRead(f) { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ---------- 2. 执行流追踪 ----------
// 给定一个入口符号（函数/消息常量），找出它的定义 + 调用点 + 被谁调用。
export function traceExecution(entrySymbol) {
  const result = { definition: null, calls: [], calledBy: [], relatedMsgs: [] };
  const fileIndex = buildFileIndex();
  const sym = entrySymbol.trim();
  for (const f of fileIndex) {
    const text = safeRead(f);
    if (!text) continue;
    const lines = text.split('\n');
    lines.forEach((ln, i) => {
      const n = i + 1;
      // 定义
      if (new RegExp('\\b(function\\s+' + escapeRe(sym) + '\\b|const\\s+' + escapeRe(sym) + '\\s*=|async\\s+function\\s+' + escapeRe(sym) + '\\b|class\\s+' + escapeRe(sym) + '\\b)', 'i').test(ln)) {
        if (!result.definition) result.definition = { file: f, n, text: ln.trim() };
      }
      // 调用点
      if (new RegExp('\\b' + escapeRe(sym) + '\\s*\\(').test(ln) && !new RegExp('function\\s+' + escapeRe(sym) + '\\s*\\(').test(ln)) {
        result.calls.push({ file: f, n, text: ln.trim() });
      }
      // 消息常量（type: 'XXX'）
      const m = ln.match(/type:\s*'([A-Z0-9_-]+)'/);
      if (m) result.relatedMsgs.push({ file: f, n, type: m[1] });
    });
  }
  // calledBy: 在其它文件里搜索对该 symbol 的引用
  const callers = [];
  for (const f of fileIndex) {
    if (result.definition && f === result.definition.file) continue;
    const text = safeRead(f);
    if (text && new RegExp('\\b' + escapeRe(sym) + '\\b').test(text)) {
      const lines = text.split('\n');
      lines.forEach((ln, i) => { if (new RegExp('\\b' + escapeRe(sym) + '\\b').test(ln)) callers.push({ file: f, n: i + 1, text: ln.trim() }); });
    }
  }
  result.calledBy = callers.slice(0, 20);
  return result;
}

// ---------- 3. 预期/实际差异对比 ----------
// 基于一组"探针"：每条探针是一个 {expect, actual(file,re), desc}。
// 工具自动读取文件验证 actual 是否命中，给出 PASS/FAIL。
export function compareExpectActual(probes) {
  return probes.map((p) => {
    let actualHit = false;
    let actualSnippet = '';
    if (p.file && p.re) {
      const text = safeRead(p.file);
      const re = new RegExp(p.re);
      for (const ln of text.split('\n')) { if (re.test(ln)) { actualHit = true; actualSnippet = ln.trim(); break; } }
    }
    const ok = p.invert ? !actualHit : actualHit;
    // 展示用文字：实际状态是"缺失(❌ 未命中)"还是"存在(✅ 命中)"
    const actualDisplay = actualHit ? '✅ 命中: ' + (actualSnippet.slice(0, 40) || 'true') : '❌ 未命中（能力缺失）';
    return {
      desc: p.desc,
      expect: p.expect,
      actualHit,
      actualSnippet,
      match: ok,
      actualDisplay,
      // gap 仅在"不符合预期"时出现：
      //  - 普通探针：未命中 → 期望的能力没实现
      //  - invert 探针：命中 → 不该存在的东西存在了
      gap: ok ? '' : (p.invert
        ? `期望「${p.expect}」，但代码里仍存在该片段：${actualSnippet.slice(0, 50)}`
        : `期望「${p.expect}」，但代码里未观察到对应实现（${p.file ? path.basename(p.file) : ''}）。`),
    };
  });
}

// ---------- 4. 报告生成 ----------
export function generateReport({ title, problem, modules, trace, probes, gaps, strategy, learnings }) {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const L = [];
  L.push(`# 自动排查报告：${title}`);
  L.push('');
  L.push(`> 生成时间：${now}  |  工具：debug-agent（自动静态分析，无需人工验证）`);
  L.push('');
  L.push('## 一、问题描述');
  L.push('');
  L.push(problem || '(未提供)');
  L.push('');
  L.push('## 二、相关代码模块（自动搜索）');
  L.push('');
  if (modules.length) {
    L.push('| 文件 | 相关度 | 命中行示例 |');
    L.push('| --- | --- | --- |');
    for (const m of modules.slice(0, 10)) {
      const ex = m.lines.slice(0, 2).map((l) => `${l.n}:${l.text.slice(0, 60)}`).join(' / ');
      L.push(`| \`${path.relative(ROOT, m.file)}\` | ${m.score} | ${ex} |`);
    }
  } else L.push('（未搜索到明显相关模块）');
  L.push('');
  L.push('## 三、执行流追踪');
  L.push('');
  if (trace) {
    if (trace.definition) L.push(`- **入口定义**：${path.relative(ROOT, trace.definition.file)}:${trace.definition.n} — \`${trace.definition.text.slice(0, 90)}\``);
    if (trace.calls.length) {
      L.push('- **该入口内部调用的关键符号**：');
      for (const c of trace.calls.slice(0, 12)) L.push(`  - ${path.relative(ROOT, c.file)}:${c.n} — \`${c.text.trim().slice(0, 90)}\``);
    }
    if (trace.calledBy.length) {
      L.push('- **调用该入口的位置**：');
      for (const c of trace.calledBy.slice(0, 12)) L.push(`  - ${path.relative(ROOT, c.file)}:${c.n}`);
    }
  } else L.push('（未指定追踪入口）');
  L.push('');
  L.push('## 四、预期 vs 实际差异');
  L.push('');
  if (probes.length) {
    L.push('| 检查项 | 期望 | 实际命中 | 差异 |');
    L.push('| --- | --- | --- | --- |');
    for (const p of probes) {
      L.push(`| ${p.desc} | ${p.expect} | ${p.actualDisplay} | ${p.gap || '一致'} |`);
    }
  } else L.push('（无探针）');
  L.push('');
  L.push('## 五、根因 / 优化点（自动归纳）');
  L.push('');
  if (gaps && gaps.length) for (const g of gaps) L.push(`- ${g}`);
  else L.push('（未归纳出明确差异）');
  L.push('');
  L.push('## 六、改进方案');
  L.push('');
  L.push(strategy || '（见差异分析，按需给出具体代码改动）');
  L.push('');
  L.push('## 七、可复用解决策略');
  L.push('');
  L.push('- 把"扫描识别"与"解析下载"解耦：识别靠 DOM/URL 正则，解析靠登录态 API 或被动捕获。');
  L.push('- 网盘类功能按"分享态 vs 自己网盘"双路径实现，二者 API 与鉴权完全不同，不可混用。');
  L.push('- 凡是平台侧已关闭的主动请求接口（如 file_info 400/download_url 404），立即转为被动捕获或引导用户网页端操作，不要在死接口上重试。');
  L.push('- 排查"点了没反应"类问题，优先检查：①是否卡在长超时等待；②是否所有分支都返回空；③语法/括号不平衡导致整个文件不加载。');
  L.push('');
  L.push('## 八、学习要点记录');
  L.push('');
  if (learnings && learnings.length) for (const l of learnings) L.push(`- ${l}`);
  else L.push('（本次未新增）');
  L.push('');
  L.push('---');
  L.push('_本报告中所有"实际"结论均由工具静态读码自动得出，未要求用户手动验证。_');
  return L.join('\n');
}

// 追加学习要点到统一文件（去重）
export function appendLearnings(learnings) {
  if (!learnings || !learnings.length) return;
  const f = path.join(ROOT, 'analysis', 'debug-reports', 'learnings.md');
  let existing = '';
  try { existing = fs.readFileSync(f, 'utf8'); } catch {}
  const lines = existing ? existing.split('\n') : ['# 排查学习要点（自动累积）', ''];
  for (const l of learnings) {
    const item = `- ${l}`;
    if (!lines.some((x) => x.trim() === item.trim())) lines.push(item);
  }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, lines.join('\n'));
}

export { ROOT, path, fs };
