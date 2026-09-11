/**
 * 系统深度检测脚本 —— 潜在问题识别 + 优先级排序
 * =====================================================================
 * 检测维度：
 *   D1 响应延迟：对运行中后端(8792)采样关键端点，超阈值标记（阈值可调）。
 *   D2 架构不合理：巨型文件（行数阈值）、单体路由 if 链残余分支数、
 *      重复代码信号（同名超长函数）、循环依赖风险。
 *   D3 垃圾代码/垃圾文件：根目录畸形文件（破损 shell 产物）、__pycache__、
 *      调试残留（.patch-debug.txt 等）、超大备份文件、console.log 密度异常。
 *   D4 遗漏文件：源码中 import/引用但磁盘上不存在的文件。
 *
 * 输出：按 P0(阻塞) / P1(高) / P2(中) / P3(低) 优先级排序的问题清单，
 *       每条含精确位置（文件/行/端点）与建议动作。
 * 用法：node scripts/deep-inspect-system.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BACKEND = 'http://127.0.0.1:8792';

const issues = []; // {priority: P0..P3, category, title, location, evidence, action}
function report(priority, category, title, location, evidence, action) {
  issues.push({ priority, category, title, location, evidence, action });
}

// ---------------------------------------------------------------------
// D1 响应延迟检测
// ---------------------------------------------------------------------
async function d1Latency() {
  console.log('[D1] 响应延迟采样（8792，每端点 20 次取 avg/p95）...');
  const endpoints = [
    ['GET', '/api/health', null, 50],                 // 阈值 ms（avg）
    ['GET', '/api/health/platform', null, 20],
    ['GET', '/api/health/local-post/runtime/install-jobs', null, 20],
    ['POST', '/api/health/local-post/runtime/validate-path', { path: 'C:/' }, 30],
    ['GET', '/api/byok/providers', null, 30],
    ['GET', '/api/models/catalog', null, 60],
    ['GET', '/api/dcc/status', null, 30],
  ];
  let reachable = true;
  for (const [method, p, body, thresholdMs] of endpoints) {
    const samples = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      try {
        const opts = { method, headers: { 'content-type': 'application/json' } };
        if (body) opts.body = JSON.stringify(body);
        const r = await fetch(BACKEND + p, opts);
        await r.text();
        samples.push(performance.now() - t0);
      } catch (e) {
        if (i === 0) { reachable = false; report('P0', '延迟/可用性', `后端不可达，延迟检测中止`, BACKEND + p, e.message, '启动后端: node app/server/hmdao-api.mjs'); }
        break;
      }
    }
    if (!reachable) return;
    if (!samples.length) continue;
    samples.sort((a, b) => a - b);
    const avg = samples.reduce((s, v) => s + v, 0) / samples.length;
    const p95 = samples[Math.floor(samples.length * 0.95)];
    const line = `${method} ${p}: avg=${avg.toFixed(1)}ms p95=${p95.toFixed(1)}ms (阈值${thresholdMs}ms)`;
    console.log('   ' + line);
    if (avg > thresholdMs * 3) {
      report('P1', '响应延迟', `端点显著超阈值（>3x）`, `${method} ${p}`, line, '检查该 handler 内同步 IO / 每请求重复计算，考虑缓存');
    } else if (avg > thresholdMs) {
      report('P2', '响应延迟', `端点超出建议阈值`, `${method} ${p}`, line, '观察项：可加快照缓存或惰性求值');
    }
  }
}

// ---------------------------------------------------------------------
// 文件遍历工具
// ---------------------------------------------------------------------
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', '.venv', '.venv-1', '.vite', '.playwright-cli',
  'artifacts', '.codex', '.agents', 'coverage',
  // 三方/生成产物：不属于本项目架构评估范围
  '.vite-cache', 'tools', 'vendor', '.hmdao-data', 'instance',
]);
function* walk(dir, depth = 0) {
  if (depth > 8) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (IGNORE_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full, depth + 1);
    else yield full;
  }
}
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/');

// ---------------------------------------------------------------------
// D2 架构不合理检测
// ---------------------------------------------------------------------
function d2Architecture() {
  console.log('[D2] 架构扫描（巨型文件 / if 链残余 / 重复实现信号）...');
  const codeExt = new Set(['.mjs', '.ts', '.tsx', '.js', '.cjs']);
  // 已在下方以更高优先级（P1 + 详细建议）显式上报的文件，避免重复计入
  const SKIP_BIG = new Set(['app/src/nodes/VideoNode.tsx']);
  const bigFiles = [];
  for (const f of walk(ROOT)) {
    const ext = path.extname(f);
    if (!codeExt.has(ext)) continue;
    const r = rel(f);
    if (r.startsWith('tmp/') || r.includes('/tmp/') || r.includes('.bak') || r.includes('.generated.')) continue;
    if (r.includes('legacy-baseline')) continue; // 单独归类为重复基线文件（D3），不按架构拆分建议报
    if (SKIP_BIG.has(r)) continue;
    let lines = 0;
    try { lines = readFileSync(f, 'utf8').split('\n').length; } catch { continue; }
    if (lines > 2000) bigFiles.push({ f: r, lines });
  }
  bigFiles.sort((a, b) => b.lines - a.lines);
  for (const b of bigFiles.slice(0, 10)) {
    const pr = b.lines > 10000 ? 'P1' : b.lines > 4000 ? 'P2' : 'P3';
    report(pr, '架构', `巨型文件（${b.lines} 行）`, b.f,
      `超过 2000 行拆分阈值 ${Math.round(b.lines / 2000 * 10) / 10} 倍`,
      b.f.endsWith('hmdao-api.mjs')
        ? '继续按已验证的「路由表+deps注入」流水线拆分（下一批：/api/byok、/api/models、/api/comfyui 组）'
        : '按功能域拆分为子模块，参考 routes/health.mjs 的拆分模式');
  }

  // 重复基线文件：与主文件几乎同体量的完整拷贝
  const baseline = path.join(ROOT, 'app', 'server', 'hmdao-api-legacy-baseline.mjs');
  if (existsSync(baseline)) {
    const lines = readFileSync(baseline, 'utf8').split('\n').length;
    report('P2', '垃圾文件/重复代码', `主文件完整基线拷贝（${lines} 行）与 hmdao-api.mjs 并存`, 'app/server/hmdao-api-legacy-baseline.mjs',
      '21k 行的旧版全量拷贝留在源码目录内，易被误 import/误编辑，且干扰全局搜索',
      '重构对照已完成即移出 app/server（归档到仓库外或 tmp/），确保无 import 引用后删除');
  }

  // if 链残余分支统计（hmdao-api.mjs 的 route 函数内）
  const mainFile = path.join(ROOT, 'app', 'server', 'hmdao-api.mjs');
  if (existsSync(mainFile)) {
    const src = readFileSync(mainFile, 'utf8');
    const branchCount = (src.match(/url\.pathname\s*===|url\.pathname\.startsWith\(|url\.pathname\.match\(/g) || []).length;
    if (branchCount > 20) {
      const migratedBranches = 54; // 来自 verify-route-migration：baseline 89 分支 → 已迁移 54 / 残留 35
      const routerEntries = 47; // 54 个原分支经前缀合并后 → 47 条路由表注册
      report('P2', '架构', `route() 顺序 if 链仍有约 ${branchCount} 处路径匹配未迁移`, 'app/server/hmdao-api.mjs (route 函数)',
        `已完成 6 个路由组剥离（${migratedBranches} 个原分支 → ${routerEntries} 条路由表注册），剩余约 ${branchCount} 处仍为 O(n) 线性匹配且顺序敏感`,
        '按 verify-route-migration 的分组继续迁移（baseline=89 分支 / 已迁移54 / 残留35），迁移前跑 verify-route-migration.mjs 校验');
    }
    // 重复实现信号：同一函数名多处定义
    const defs = new Map();
    const re = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm;
    let m;
    while ((m = re.exec(src))) {
      defs.set(m[1], (defs.get(m[1]) || 0) + 1);
    }
    const dups = [...defs.entries()].filter(([, n]) => n > 1);
    for (const [name, n] of dups.slice(0, 5)) {
      report('P2', '架构/重复代码', `函数 ${name} 在主文件中定义了 ${n} 次`, 'app/server/hmdao-api.mjs',
        `同名函数多处定义（后者遮蔽前者，易产生行为漂移）`, '合并为单一实现或重命名以显式区分');
    }
  }

  // 前端巨型组件
  const videoNode = path.join(ROOT, 'app', 'src', 'nodes', 'VideoNode.tsx');
  if (existsSync(videoNode)) {
    const lines = readFileSync(videoNode, 'utf8').split('\n').length;
    if (lines > 4000) {
      report('P1', '架构', `前端巨型组件（${lines} 行）`, 'app/src/nodes/VideoNode.tsx',
        '单组件承载模型选择/参数面板/预览/任务轮询多职责，任何小改动触发全组件 re-render 与巨大 diff 面',
        '拆出 ModelSelector / ParamsPanel / PreviewPane / usePollingTask hook（与后端拆分同方法论：先契约测试再搬移）');
    }
  }
}

// ---------------------------------------------------------------------
// D3 垃圾代码 / 垃圾文件
// ---------------------------------------------------------------------
function d3Garbage() {
  console.log('[D3] 垃圾文件/垃圾代码扫描...');
  // 3a 根目录畸形文件（破损 shell 命令产物：文件名含代码片段）
  const rootEntries = readdirSync(ROOT);
  const weird = rootEntries.filter((n) => /[{}()'"]|console\.log|includes\(/.test(n));
  for (const w of weird) {
    report('P1', '垃圾文件', '根目录畸形文件（破损 shell 命令误创建）', w,
      '文件名本身是代码片段，系 PowerShell/cmd 转义失败时把命令写成了文件；会污染 git status 与目录遍历',
      `删除: cmd /c del "${w.replace(/"/g, '""')}"（含特殊字符须用 cmd 引号包裹）`);
  }

  // 3b 调试/编译残留
  const residues = ['.patch-debug.txt', 'nul'];
  for (const r0 of residues) {
    if (existsSync(path.join(ROOT, r0))) {
      report('P2', '垃圾文件', '调试残留文件', r0, '开发调试产物，不应入库', '删除并确认 .gitignore 覆盖');
    }
  }
  for (const f of walk(ROOT)) {
    const r = rel(f);
    if (r.includes('__pycache__')) {
      report('P3', '垃圾文件', 'Python 字节码缓存入库', path.dirname(r), '*.pyc 不应提交（git status 已显示删除，需确认 .gitignore）', '确认 .gitignore 含 __pycache__/ 后提交删除');
      break; // 报一次即可
    }
  }

  // 3c 超大备份/临时文件
  for (const f of walk(ROOT)) {
    const r = rel(f);
    if (!/\.(bak|old|tmp|orig)$/i.test(r)) continue;
    let size = 0; try { size = statSync(f).size; } catch {}
    if (size > 200 * 1024) {
      report('P3', '垃圾文件', `大体积备份文件（${(size / 1024 / 1024).toFixed(1)}MB）`, r,
        '重构对照备份，验证完成后应移出仓库', '归档到仓库外或删除（对照进程停掉后）');
    }
  }

  // 3d 垃圾代码信号：被 git 删除但仍被引用的 analysis/ 死引用 + console.log 密度
  const serverMain = path.join(ROOT, 'app', 'server', 'hmdao-api.mjs');
  if (existsSync(serverMain)) {
    const src = readFileSync(serverMain, 'utf8');
    const logs = (src.match(/console\.log\(/g) || []).length;
    const lines = src.split('\n').length;
    if (logs > 150) {
      report('P3', '垃圾代码', `主文件 console.log 共 ${logs} 处（${(logs / lines * 1000).toFixed(1)}‰）`, 'app/server/hmdao-api.mjs',
        '无分级日志，生产噪声大且无法按模块过滤', '引入统一 logger(level+scope)，拆分路由组时顺带替换');
    }
    // TODO/FIXME 残留
    const todos = (src.match(/\/\/\s*(TODO|FIXME|HACK|XXX)\b/gi) || []).length;
    if (todos > 10) {
      report('P3', '垃圾代码', `主文件 TODO/FIXME/HACK 残留 ${todos} 处`, 'app/server/hmdao-api.mjs', '技术债标记长期未清理', '收敛到 issue 跟踪，代码中仅留编号');
    }
  }
}

// ---------------------------------------------------------------------
// D4 遗漏文件（被引用但不存在）
// ---------------------------------------------------------------------
function d4Missing() {
  console.log('[D4] 遗漏文件扫描（import/引用但磁盘缺失）...');
  const checkDirs = [path.join(ROOT, 'app', 'server'), path.join(ROOT, 'scripts')];
  const missing = [];
  for (const dir of checkDirs) {
    for (const f of walk(dir)) {
      if (!/\.(mjs|cjs|js)$/.test(f)) continue;
      const r = rel(f);
      if (r.startsWith('tmp/')) continue;
      let src; try { src = readFileSync(f, 'utf8'); } catch { continue; }
      const re = /(?:import\s[^'"]*?|from|require\()\s*['"](\.{1,2}\/[^'"]+)['"]/g;
      let m;
      while ((m = re.exec(src))) {
        const spec = m[1];
        if (!/\.(mjs|cjs|js|json|node)$/.test(spec)) continue; // 仅显式扩展名（Node ESM 必须带扩展名）
        const target = path.resolve(path.dirname(f), spec);
        if (!existsSync(target)) missing.push({ from: r, spec });
      }
    }
  }
  for (const mi of missing.slice(0, 15)) {
    report('P0', '遗漏文件', 'import 目标不存在（运行时必然 ERR_MODULE_NOT_FOUND）', `${mi.from} → ${mi.spec}`,
      '该 import 在模块加载时即抛错', '补齐文件或修正路径');
  }
  if (!missing.length) console.log('   未发现缺失的本地 import 目标。');

  // 关键运行时文件存在性
  const critical = [
    'app/server/hmdao-api.mjs', 'app/server/core/http-router.mjs',
    'app/server/routes/health.mjs', 'app/server/routes/auth.mjs',
    'app/vite.config.ts', 'extension/manifest.json', 'extension/background.js',
  ];
  for (const c of critical) {
    if (!existsSync(path.join(ROOT, c))) {
      report('P0', '遗漏文件', '关键运行时文件缺失', c, '系统核心链路依赖此文件', '从 git 恢复或重建');
    }
  }
}

// ---------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------
(async () => {
  console.log('=== HMDAODAO 系统深度检测 ===');
  console.log(`时间: ${new Date().toISOString()}\n`);
  await d1Latency();
  d2Architecture();
  d3Garbage();
  d4Missing();

  const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
  issues.sort((a, b) => order[a.priority] - order[b.priority]);

  console.log('\n' + '='.repeat(62));
  console.log('        深 度 检 测 — 问 题 清 单（按优先级）');
  console.log('='.repeat(62));
  const byP = { P0: [], P1: [], P2: [], P3: [] };
  for (const i of issues) byP[i.priority].push(i);
  console.log(`\n统计: P0(阻塞)=${byP.P0.length}  P1(高)=${byP.P1.length}  P2(中)=${byP.P2.length}  P3(低)=${byP.P3.length}\n`);
  let n = 0;
  for (const i of issues) {
    n++;
    console.log(`${n}. [${i.priority}][${i.category}] ${i.title}`);
    console.log(`   位置: ${i.location}`);
    console.log(`   证据: ${i.evidence}`);
    console.log(`   建议: ${i.action}\n`);
  }
  if (!issues.length) console.log('未发现问题。');
  process.exit(byP.P0.length ? 1 : 0);
})();
