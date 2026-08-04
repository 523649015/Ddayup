// app/server/providers/ark.mjs
// 火山方舟（Volcengine Ark）推理接入点管理：从 hmdao-api.mjs 抽离出的独立模块。
//
// 对应架构审查结论的改造点：
//  1. 缓存（arkEndpointCache）私有化，仅暴露最小入口：
//     resolveArkModel / getArkEndpointInfo / getAllArkEndpoints /
//     syncArkEndpoints / invalidateArkEndpoint / rebuildSingleArkEndpoint。
//     不再允许任意层直接 `arkEndpointCache.get/set`（此前 16 处 volcengine 特判的来源）。
//  2. 去除 syncArkEndpoints 的死参数 apiKey（签名只用 AK/SK，apiKey 从未被使用）。
//  3. 落盘走 core/json-store 原子写，避免并发 lost update 与中途被杀的 JSON 截断。
//  4. 每个建点/探活加 15s 超时（AbortController），防止激活接口被上游慢响应挂死
//     （原串行 for + 无超时，上游一慢，/api/byok/activate 直接卡死）。
//  5. 提供 invalidate + 单点重建入口，支撑「生成请求命中 endpoint 不存在 → 失效 → 懒重建」
//     的运行期自愈（executor 层接线为后续步骤，本模块先交付可测的原子能力）。
//  6. 解除对全局 MODEL_CATALOG 的隐藏依赖：syncArkEndpoints 的模型清单由调用方注入。
import crypto from 'node:crypto';
import path from 'node:path';
import { readJsonFile, writeJsonFileAtomic } from '../core/json-store.mjs';

const DATA_DIR = path.join(process.cwd(), '.hmdao-data');
const ARK_ENDPOINT_CACHE_FILE = path.join(DATA_DIR, 'ark-endpoints.json');

const ARK_OPEN_HOST = 'open.volcengineapi.com';
const ARK_OPEN_REGION = 'cn-beijing';
const ARK_OPEN_SERVICE = 'ark';
const ARK_OP_TIMEOUT_MS = 15000;

// 模块私有缓存：catalogModelId -> { endpointId, modelVersion, status }
const arkEndpointCache = new Map();

function loadArkEndpointCache() {
  const obj = readJsonFile(ARK_ENDPOINT_CACHE_FILE, {});
  for (const [k, v] of Object.entries(obj || {})) arkEndpointCache.set(k, v);
}
function saveArkEndpointCache() {
  try {
    writeJsonFileAtomic(ARK_ENDPOINT_CACHE_FILE, Object.fromEntries(arkEndpointCache.entries()));
  } catch (e) {
    console.error('[ark] save endpoint cache failed:', e.message);
  }
}
loadArkEndpointCache();

// 火山 V4 签名。修复三处签名 bug（此前对任何 Action 都返回 401 SignatureDoesNotMatch）：
//  1) canonicalRequest 必须以 HTTP 方法行开头（POST）；
//  2) query 不能硬编码 CreateEndpoint，须与实际请求一致；
//  3) 火山 V4 签名 key 直接用 secretKey，不加 AWS 的 'AWS4' 前缀。
function arkV4Authorization({ bodyStr, accessKeyId, secretKey, xDate, queryString }) {
  const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
  const sha256Hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const payloadHash = sha256Hex(bodyStr);
  const canonicalHeaders = `content-type:application/json\nhost:${ARK_OPEN_HOST}\nx-content-sha256:${payloadHash}\nx-date:${xDate}\n`;
  const signedHeaders = 'content-type;host;x-content-sha256;x-date';
  const canonicalRequest = `POST\n/\n${queryString}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const shortDate = xDate.slice(0, 8);
  const credentialScope = `${shortDate}/${ARK_OPEN_REGION}/${ARK_OPEN_SERVICE}/request`;
  const stringToSign = `HMAC-SHA256\n${xDate}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`;
  const signingKey = hmac(hmac(hmac(hmac(secretKey, shortDate), ARK_OPEN_REGION), ARK_OPEN_SERVICE), 'request');
  const signature = hmac(signingKey, stringToSign).toString('hex');
  return `HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

// 通用 Ark OpenAPI 调用（V4 签名）。signal 用于上游超时中止。
async function arkControlRequest(action, version, bodyObj, creds, signal) {
  const bodyStr = JSON.stringify(bodyObj || {});
  const queryString = `Action=${action}&Version=${version}`;
  const xDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const auth = arkV4Authorization({ bodyStr, accessKeyId: creds.accessKeyId, secretKey: creds.secretKey, xDate, queryString });
  const url = `https://${ARK_OPEN_HOST}/?${queryString}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Host: ARK_OPEN_HOST,
      'Content-Type': 'application/json',
      'X-Date': xDate,
      'X-Content-Sha256': crypto.createHash('sha256').update(bodyStr).digest('hex'),
      Authorization: auth,
    },
    body: bodyStr,
    signal,
  });
  const text = await resp.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  return { ok: resp.ok, status: resp.status, json, text };
}

async function arkCreateEndpoint(modelVersion, name, creds, signal) {
  const res = await arkControlRequest('CreateEndpoint', '2024-01-01', {
    Name: name,
    Model: { ModelId: modelVersion },
    ResourcePool: { Type: 'Flexible' },
  }, creds, signal);
  if (!res.ok) return { error: `CreateEndpoint HTTP ${res.status}: ${String(res.text || '').slice(0, 300)}` };
  const result = res.json?.Result || res.json?.result || {};
  return { endpointId: result.Id || result.id || null, status: result.Status || result.status || 'Running' };
}

async function arkGetEndpoint(endpointId, creds, signal) {
  const res = await arkControlRequest('GetEndpoint', '2024-01-01', { EndpointId: endpointId }, creds, signal);
  if (!res.ok) return null;
  return res.json?.Result || res.json || null;
}

// 解析火山方舟模型最终 model 字段：优先缓存的接入点 ID，回退目录 upstreamModel。
function resolveArkModel(catalogModelId, fallbackModel) {
  const cached = catalogModelId ? arkEndpointCache.get(catalogModelId) : null;
  return cached?.endpointId || fallbackModel;
}

// 只读访问单个缓存接入点（供模型目录构建读取 endpointId/status）。
function getArkEndpointInfo(catalogModelId) {
  return catalogModelId ? (arkEndpointCache.get(catalogModelId) || null) : null;
}

// 只读访问全部缓存接入点（供目录对账遍历）。
function getAllArkEndpoints() {
  return Array.from(arkEndpointCache.entries());
}

// 给 Ark 控制类请求套 15s 超时：AbortController 中止底层 fetch，异常归一为 null。
function arkOpWithTimeout(fn, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return Promise.resolve(fn(controller.signal)).catch(() => null).finally(() => clearTimeout(timer));
}

// 重建单个模型接入点（运行期自愈用）。成功写缓存并返回 entry；失败返回 { error }，不污染缓存。
async function rebuildSingleArkEndpoint(model, creds) {
  if (!creds?.accessKeyId || !creds?.secretKey) return { error: 'missing-ak-sk' };
  const modelVersion = model?.upstreamModel || model?.id;
  if (!modelVersion) return { error: 'missing-modelVersion' };
  const created = await arkOpWithTimeout(
    (signal) => arkCreateEndpoint(modelVersion, `ddup-${model.id}`, creds, signal).catch((e) => ({ error: e.message })),
    ARK_OP_TIMEOUT_MS
  );
  if (created?.endpointId) {
    const entry = { endpointId: created.endpointId, status: created.status || 'Running', modelVersion };
    arkEndpointCache.set(model.id, entry);
    saveArkEndpointCache();
    return entry;
  }
  return { error: created?.error || 'create_failed' };
}

// 失效单个缓存接入点（运行期自愈：生成请求命中 endpoint 不存在类错误时调用）。
function invalidateArkEndpoint(catalogModelId) {
  if (catalogModelId && arkEndpointCache.delete(catalogModelId)) {
    saveArkEndpointCache();
    return true;
  }
  return false;
}

// 激活 Ark 后自动建点并缓存（需 AK/SK）。
// 入参：
//   models = 火山方舟模型清单（来自 MODEL_CATALOG.filter(provider==='volcengine')，由调用方注入，
//           解除本模块对全局 MODEL_CATALOG 的隐藏依赖）；
//   creds  = { accessKeyId, secretKey }（apiKey 为死参数，已移除）。
// 返回 { catalogModelId: { endpointId, status, modelVersion } }。
//   已存活的接入点直接复用；缺失的自动创建并缓存；创建失败项 status='create_failed' 且不进缓存。
async function syncArkEndpoints(models, creds) {
  if (!creds?.accessKeyId || !creds?.secretKey) return { skipped: true, reason: 'missing-ak-sk' };
  const results = {};
  for (const m of Array.isArray(models) ? models : []) {
    const modelVersion = m.upstreamModel;
    const cached = arkEndpointCache.get(m.id);
    if (cached?.endpointId) {
      const live = await arkOpWithTimeout(
        (signal) => arkGetEndpoint(cached.endpointId, creds, signal),
        ARK_OP_TIMEOUT_MS
      );
      if (live && String(live.Status || live.status || '').toLowerCase().includes('run')) {
        results[m.id] = { endpointId: cached.endpointId, status: live.Status || live.status, modelVersion };
        continue;
      }
    }
    const created = await arkOpWithTimeout(
      (signal) => arkCreateEndpoint(modelVersion, `ddup-${m.id}`, creds, signal).catch((e) => ({ error: e.message })),
      ARK_OP_TIMEOUT_MS
    );
    if (created?.endpointId) {
      results[m.id] = { endpointId: created.endpointId, status: created.status || 'Running', modelVersion };
      arkEndpointCache.set(m.id, results[m.id]);
    } else {
      results[m.id] = { endpointId: null, status: 'create_failed', modelVersion, error: created?.error };
    }
  }
  saveArkEndpointCache();
  return results;
}

export {
  resolveArkModel,
  getArkEndpointInfo,
  getAllArkEndpoints,
  syncArkEndpoints,
  invalidateArkEndpoint,
  rebuildSingleArkEndpoint,
};
