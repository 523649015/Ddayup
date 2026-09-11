// 一次性校验脚本：验证 Infinite-Canvas workflows 下的 ComfyUI JSON 能否被 HMDao 的
// parseComfyUIWorkflow 准确识别（API 格式），并确认输入/输出端、连接完整性、参数映射，
// 最后尝试向运行中的网关真实提交一个最小工作流以验证可运行性。
//
// 用法：node scripts/validate-comfy-workflows.mjs [workflows目录]
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const WORKFLOWS_DIR =
  process.argv[2] || 'F:/Work/Infinite-Canvas-main/workflows';

// ===== 移植自 app/src/services/workflowEngine.ts 的解析逻辑（保持算法一致） =====
function isComfyApiFormat(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const entries = Object.entries(obj);
  if (entries.length === 0) return false;
  if (Array.isArray(obj.nodes)) return false; // UI 格式优先
  return entries.slice(0, 5).every(([, v]) => !!v && typeof v === 'object' && typeof v.class_type === 'string');
}

function analyzeApi(graph) {
  const ids = Object.keys(graph);
  const idToIndex = new Map();
  ids.forEach((id, i) => idToIndex.set(id, i));

  const incoming = new Map();
  const referencedAsSource = new Set();
  const dangling = [];

  for (const id of ids) {
    const inputs = graph[id].inputs || {};
    for (const k of Object.keys(inputs)) {
      const v = inputs[k];
      if (Array.isArray(v) && typeof v[0] === 'string') {
        if (idToIndex.has(v[0])) {
          if (!incoming.has(id)) incoming.set(id, new Set());
          incoming.get(id).add(v[0]);
          referencedAsSource.add(v[0]);
        } else {
          dangling.push({ from: v[0], to: id, key: k });
        }
      }
    }
  }

  const inputNodes = ids.filter((id) => !incoming.has(id) || incoming.get(id).size === 0);
  const outputNodes = ids.filter((id) => !referencedAsSource.has(id));
  const connections = [];
  for (const id of ids) {
    const ins = incoming.get(id);
    if (!ins) continue;
    for (const src of ins) connections.push({ from: idToIndex.get(src), to: idToIndex.get(id) });
  }

  // 每个节点的字面量参数（非连接），用于确认接口参数映射是否完整
  const paramSample = {};
  for (const id of ids) {
    const inputs = graph[id].inputs || {};
    const literal = {};
    for (const k of Object.keys(inputs)) {
      const v = inputs[k];
      if (!Array.isArray(v)) literal[k] = v;
    }
    paramSample[id] = { class_type: graph[id].class_type, literal };
  }

  return { ids, inputNodes, outputNodes, connections, dangling, paramSample };
}

function analyzeUi(raw) {
  const idToIndex = new Map();
  raw.nodes.forEach((n, i) => idToIndex.set(n.id, i));
  const referencedAsSource = new Set();
  for (const link of raw.links || []) {
    referencedAsSource.add(link[1]);
  }
  const inputNodes = raw.nodes.filter((n) => (n.inputs || []).every((i) => i.link == null)).map((n) => String(n.id));
  const outputNodes = raw.nodes.filter((n) => !(n.outputs || []).some((o) => (o.links || []).length)).map((n) => String(n.id));
  return { ids: raw.nodes.map((n) => String(n.id)), inputNodes, outputNodes, connections: (raw.links || []).map((l) => ({ from: idToIndex.get(l[1]), to: idToIndex.get(l[3]) })), dangling: [] };
}

// ===== 主流程 =====
const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.json'));
console.log(`\n=== 校验目录: ${WORKFLOWS_DIR} ===`);
console.log(`发现 ${files.length} 个 JSON 文件\n`);

const report = [];
for (const file of files) {
  const full = join(WORKFLOWS_DIR, file);
  let raw;
  try {
    raw = JSON.parse(readFileSync(full, 'utf-8'));
  } catch (e) {
    console.log(`✗ ${file}: JSON 解析失败 - ${e.message}`);
    continue;
  }

  const graph = raw.prompt && typeof raw.prompt === 'object' ? raw.prompt : raw;
  let fmt, info;
  if (isComfyApiFormat(graph)) {
    fmt = 'API(prompt图)';
    info = analyzeApi(graph);
  } else if (Array.isArray(raw.nodes)) {
    fmt = 'UI(nodes/links)';
    info = analyzeUi(raw);
  } else {
    fmt = '未知';
    console.log(`✗ ${file}: 无法识别的 ComfyUI 格式`);
    continue;
  }

  const classTypes = [...new Set(info.ids.map((id) => (graph[id] ? graph[id].class_type : (raw.nodes?.find((n) => String(n.id) === id)?.type))))];
  console.log(`✓ ${file}`);
  console.log(`    格式: ${fmt}`);
  console.log(`    节点数: ${info.ids.length}`);
  console.log(`    输入源(${info.inputNodes.length}): ${info.inputNodes.join(', ')}`);
  console.log(`    输出端(${info.outputNodes.length}): ${info.outputNodes.join(', ')}`);
  console.log(`    连接数: ${info.connections.length}，悬空连接: ${info.dangling.length}`);
  if (info.dangling.length) console.log(`    ⚠ 悬空连接: ${JSON.stringify(info.dangling)}`);
  console.log(`    节点类型: ${classTypes.join(', ')}`);
  report.push({ file, fmt, ...info });
}

// ===== 网关可运行性探测 =====
async function checkGateway() {
  for (const base of ['http://127.0.0.1:3000', 'http://127.0.0.1:8792']) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(`${base}/api/comfyui/health`, { signal: ctrl.signal });
      clearTimeout(t);
      const txt = await r.text();
      console.log(`\n[网关] ${base}/api/comfyui/health -> HTTP ${r.status}`);
      console.log(`    ${txt.slice(0, 400)}`);
      return base;
    } catch (e) {
      console.log(`\n[网关] ${base}/api/comfyui/health -> 不可达 (${e.message})`);
    }
  }
  return null;
}

async function submitWorkflow(base, file) {
  const full = join(WORKFLOWS_DIR, file);
  const raw = JSON.parse(readFileSync(full, 'utf-8'));
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(`${base}/api/comfyui/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: raw }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const txt = await r.text();
    console.log(`\n[提交] ${file} -> HTTP ${r.status}`);
    console.log(`    ${txt.slice(0, 800)}`);
  } catch (e) {
    console.log(`\n[提交] ${file} -> 失败: ${e.message}`);
  }
}

const base = await checkGateway();
if (base) {
  // 选最小的两个工作流做真实提交验证（upscale 最小，其次 2511 较小）
  const candidates = ['upscale.json', '2511.json'].filter((f) => files.includes(f));
  for (const c of candidates) {
    await submitWorkflow(base, c);
  }
} else {
  console.log('\n⚠ 未探测到运行中的 ComfyUI 网关，跳过真实提交验证（解析/结构验证已完成）。');
}

console.log('\n=== 校验完成 ===');
