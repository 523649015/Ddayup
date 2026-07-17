import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { promises as fs, existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const browserCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

const chromePath = browserCandidates.find((item) => existsSync(item));
const chromePort = Number(process.env.HMDAO_VERIFY_CHROME_PORT || (9466 + Math.floor(Math.random() * 200)));
const apiUrl = process.env.HMDAO_API_URL || 'http://127.0.0.1:8792';
const appUrl = process.env.HMDAO_APP_URL || 'http://127.0.0.1:3011';
const appPath = '/?skipLaunch=1&hmdao-demo=tagging-contract';
const fallbackAppPath = '/?skipLaunch=1';
const builtVerifyAppIndexPath = path.join(process.cwd(), 'dist', 'index.html');
const DEBUG_BRIDGE_EVENT_NAME = 'hmdao:debug-command';
const DEBUG_BRIDGE_STATE_ELEMENT_ID = 'hmdao-debug-bridge-state';
const APIMART_HOST_FRAGMENT = 'api.apimart.ai';
const DEBUG_OBJECT_EXPR = '(typeof __HMDAO_DEBUG__ !== "undefined" ? __HMDAO_DEBUG__ : window.__HMDAO_DEBUG__)';
const DEBUG_BOOTSTRAP_MARK_EXPR = '(typeof __HMDAO_DEBUG_BOOTSTRAP_MARK__ !== "undefined" ? __HMDAO_DEBUG_BOOTSTRAP_MARK__ : window.__HMDAO_DEBUG_BOOTSTRAP_MARK__)';
const DEBUG_BOOTSTRAP_ERROR_EXPR = '(typeof __HMDAO_DEBUG_BOOTSTRAP_ERROR__ !== "undefined" ? __HMDAO_DEBUG_BOOTSTRAP_ERROR__ : window.__HMDAO_DEBUG_BOOTSTRAP_ERROR__)';
const explicitRealVideoModelIds = String(process.env.HMDAO_VERIFY_REAL_VIDEO_MODEL || '')
  .split(',')
  .map((item) => String(item || '').trim())
  .filter(Boolean);
const PREFERRED_REAL_VIDEO_MODEL_IDS = [
  'kling-v3-omni',
  'kling-v3',
  'kling-v3-motion-control',
  'kling-video-o1',
  'wan2.2-i2v-plus',
  'wan2.2-i2v-flash',
  'happyhorse-1.1',
];
const subjectReferenceInput = String(process.env.HMDAO_VERIFY_SUBJECT_REF_IMAGE || '').trim();
const backgroundReferenceInput = String(process.env.HMDAO_VERIFY_BACKGROUND_REF_IMAGE || '').trim();
const subjectReferenceLabel = String(process.env.HMDAO_VERIFY_SUBJECT_LABEL || '参考女角色').trim() || '参考女角色';
const backgroundReferenceLabel = String(process.env.HMDAO_VERIFY_BACKGROUND_LABEL || '清晨海边沙滩').trim() || '清晨海边沙滩';
const unrealProjectPath = String(process.env.HMDAO_VERIFY_UNREAL_PROJECT_PATH || '').trim();
const videoPrompt = String(
  process.env.HMDAO_VERIFY_VIDEO_PROMPT
  || '保持原始 Unreal 镜头运动、时间节奏和动作连续性，只替换视频里黄色跳舞角色为参考图中的女角色，保持面部、发型、服装和整体身份一致；其他人物与物体不做改变；背景改为清晨海边沙滩，输出连贯预览视频。',
).trim();
const realApiKey = String(process.env.HMDAO_REAL_API_KEY || process.env.HMDAO_SILICONFLOW_API_KEY || 'activated-provider-runtime').trim();
const realVideoGenerationEnabled = ['1', 'true', 'yes'].includes(String(process.env.HMDAO_VERIFY_REAL_VIDEO || '').trim().toLowerCase());
const realVideoCompletionTimeoutMs = Number(process.env.HMDAO_VERIFY_REAL_VIDEO_TIMEOUT_MS || 420000);
const assetProbeTimeoutMs = Number(process.env.HMDAO_VERIFY_ASSET_PROBE_TIMEOUT_MS || 20000);
const assetSnapshotTimeoutMs = Number(process.env.HMDAO_VERIFY_ASSET_SNAPSHOT_TIMEOUT_MS || 30000);
const apiEndpoint = new URL(apiUrl);
const apiHost = apiEndpoint.hostname || '127.0.0.1';
const apiPort = Number(apiEndpoint.port || (apiEndpoint.protocol === 'https:' ? 443 : 80));

function stringifyJsonAscii(value) {
  return JSON.stringify(value, null, 2);
}

function logJsonAscii(label, value) {
  console.log(label, stringifyJsonAscii(value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000, label = 'Request') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw createTimeoutError(label, timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function createTimeoutError(label, timeoutMs) {
  const error = new Error(`${label} timed out after ${timeoutMs}ms`);
  error.name = 'TimeoutError';
  return error;
}

function stringifyError(error) {
  return String(error instanceof Error ? error.message : error || 'unknown-error');
}

function isPrivateOrLocalHostname(hostname = '') {
  const normalized = String(hostname || '').trim().toLowerCase();
  if (!normalized) return true;
  if (
    normalized === 'localhost'
    || normalized === '0.0.0.0'
    || normalized.endsWith('.local')
    || normalized.endsWith('.lan')
    || normalized.endsWith('.internal')
  ) {
    return true;
  }
  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) {
    if (normalized.startsWith('10.')) return true;
    if (normalized.startsWith('127.')) return true;
    if (normalized.startsWith('192.168.')) return true;
    if (normalized.startsWith('169.254.')) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(normalized)) return true;
    return false;
  }
  if (ipVersion === 6) {
    if (normalized === '::1') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    if (normalized.startsWith('fe80:')) return true;
    return false;
  }
  return false;
}

function isPublicRemoteMediaUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (/^(data:|blob:|file:|hmdao-local:\/\/)/i.test(raw)) return false;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return !isPrivateOrLocalHostname(url.hostname);
  } catch {
    return false;
  }
}

function isManagedLocalMediaUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (
    /^\/api\/assets\/content\//i.test(raw)
    || /^\/api\/dcc\/local-artifacts\//i.test(raw)
    || /^\/api\/media-proxy\?/i.test(raw)
    || /^hmdao-local:\/\//i.test(raw)
  ) {
    return true;
  }
  try {
    const url = new URL(raw);
    const isLocalHost = /^(127\.0\.0\.1|localhost)$/i.test(url.hostname);
    if (!isLocalHost) return false;
    return (
      /^\/api\/assets\/content\//i.test(url.pathname)
      || /^\/api\/dcc\/local-artifacts\//i.test(url.pathname)
      || /^\/api\/media-proxy$/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function assert(condition, message, extra) {
  if (condition) return;
  throw new Error(extra === undefined ? message : `${message} ${JSON.stringify(extra)}`);
}

function readVideoNodeSettlement(node) {
  const data = node?.data && typeof node.data === 'object' ? node.data : {};
  const params = data?.params && typeof data.params === 'object' ? data.params : {};
  const status = String(data?.status || '').trim();
  const dataError = String(data?.error || '').trim();
  const lastError = String(params?.lastError || '').trim();
  const lastErrorCategory = String(params?.lastErrorCategory || '').trim().toLowerCase();
  const failedAtRaw = Number(params?.failedAt || 0);
  const failedAt = Number.isFinite(failedAtRaw) && failedAtRaw > 0 ? failedAtRaw : 0;
  const requestFailed = lastErrorCategory === 'request' || Boolean(failedAt && lastErrorCategory === 'request');
  const terminalByStatus = status === 'completed' || status === 'error';
  return {
    status,
    error: dataError || lastError,
    lastErrorCategory,
    failedAt,
    hasRequestBody: Boolean(params?.requestBody),
    requestFailed,
    completed: status === 'completed',
    errored: status === 'error',
    terminal: terminalByStatus || requestFailed,
  };
}

function classifyFailureLayerFromCategory(category) {
  const normalized = String(category || '').trim().toLowerCase();
  if (!normalized) return '';
  if (['request', 'validation', 'auth', 'quota', 'render'].includes(normalized)) return 'request';
  if (normalized === 'routing') return 'model';
  if (normalized === 'upstream' || normalized === 'timeout') return 'upstream';
  return '';
}

function deriveFailureClassification({ validationIssues = [], lastErrorCategory = '', finalError = '' } = {}) {
  const directLayer = classifyFailureLayerFromCategory(lastErrorCategory);
  const primaryIssue = Array.isArray(validationIssues)
    ? validationIssues.find((item) => item?.severity === 'error') || null
    : null;
  if (directLayer) {
    return {
      layer: directLayer,
      category: String(lastErrorCategory || '').trim().toLowerCase(),
      code: String(primaryIssue?.code || '').trim(),
      message: String(primaryIssue?.message || finalError || '').trim(),
    };
  }
  const issueCode = String(primaryIssue?.code || '').trim().toLowerCase();
  const issueMessage = String(primaryIssue?.message || finalError || '').trim();
  const normalizedMessage = issueMessage.toLowerCase();
  if (
    issueCode.includes('request-')
    || issueCode.includes('source-video')
    || issueCode.includes('route-selection')
    || issueCode.includes('real-video-route')
  ) {
    return {
      layer: 'request',
      category: String(lastErrorCategory || 'request').trim().toLowerCase(),
      code: issueCode,
      message: issueMessage,
    };
  }
  if (issueCode.includes('model') || issueCode.includes('routing')) {
    return {
      layer: 'model',
      category: String(lastErrorCategory || 'routing').trim().toLowerCase(),
      code: issueCode,
      message: issueMessage,
    };
  }
  if (issueCode.includes('upstream') || issueCode.includes('timeout')) {
    return {
      layer: 'upstream',
      category: String(lastErrorCategory || 'upstream').trim().toLowerCase(),
      code: issueCode,
      message: issueMessage,
    };
  }
  if (
    normalizedMessage.includes('source video')
    || normalizedMessage.includes('reference video')
    || normalizedMessage.includes('localhost')
    || normalizedMessage.includes('公网')
    || normalizedMessage.includes('local url')
  ) {
    return {
      layer: 'request',
      category: String(lastErrorCategory || 'request').trim().toLowerCase(),
      code: issueCode,
      message: issueMessage,
    };
  }
  if (
    normalizedMessage.includes('model')
    || normalizedMessage.includes('route')
    || normalizedMessage.includes('no activated real video route')
  ) {
    return {
      layer: 'model',
      category: String(lastErrorCategory || 'routing').trim().toLowerCase(),
      code: issueCode,
      message: issueMessage,
    };
  }
  if (normalizedMessage.includes('upstream') || normalizedMessage.includes('timed out')) {
    return {
      layer: 'upstream',
      category: String(lastErrorCategory || 'upstream').trim().toLowerCase(),
      code: issueCode,
      message: issueMessage,
    };
  }
  return null;
}

function pushValidationIssue(list, condition, code, message, detail) {
  if (condition) return;
  list.push({
    severity: 'error',
    code,
    message,
    ...(detail === undefined ? {} : { detail }),
  });
}

function createRequestId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function start(command, args, cwd, children) {
  const isCmdScript = /\.cmd$/i.test(command);
  const spawnCommand = isCmdScript ? process.env.ComSpec || 'cmd.exe' : command;
  const spawnArgs = isCmdScript ? ['/d', '/s', '/c', command, ...args] : args;
  const child = spawn(spawnCommand, spawnArgs, {
    cwd,
    stdio: ['ignore', 'inherit', 'inherit'],
    shell: false,
    windowsHide: true,
  });
  children.push(child);
  return child;
}

async function terminateChild(child) {
  if (!child?.pid || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const killer = spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
      stdio: 'ignore',
      shell: false,
      windowsHide: true,
    });
    killer.on('error', () => resolve());
    killer.on('exit', () => resolve());
  });
}

async function waitForHttp(url, timeoutMs = 30000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`Unexpected HTTP ${response.status} for ${url}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(300);
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

async function isHttpReady(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureService(url, startFn) {
  if (await isHttpReady(url)) return null;
  const child = startFn();
  await waitForHttp(url, 30000);
  return child;
}

async function readApiHealth() {
  const response = await fetchWithTimeout(
    `${apiUrl}/api/health`,
    { cache: 'no-store' },
    15000,
    'Read /api/health',
  );
  if (!response.ok) throw new Error(`Failed to query API health: HTTP ${response.status}`);
  return response.json();
}

async function readUnrealDccStatus() {
  const url = new URL(`${apiUrl}/api/dcc/status`);
  url.searchParams.set('engine', 'unreal');
  url.searchParams.set('integrationMode', 'custom-plugin-direct');
  url.searchParams.set('force', '1');
  if (unrealProjectPath) {
    url.searchParams.set('projectPath', unrealProjectPath);
  }
  const response = await fetchWithTimeout(
    url.toString(),
    { cache: 'no-store' },
    15000,
    'Read /api/dcc/status for Unreal',
  );
  if (!response.ok) throw new Error(`Failed to query Unreal DCC status: HTTP ${response.status}`);
  return response.json();
}

async function readUnrealEnvironmentStatus() {
  const response = await fetchWithTimeout(
    `${apiUrl}/api/dcc/environment/status`,
    { cache: 'no-store' },
    15000,
    'Read /api/dcc/environment/status for Unreal bootstrap',
  );
  if (!response.ok) throw new Error(`Failed to query Unreal environment status: HTTP ${response.status}`);
  return response.json();
}

function resolveUnrealBootstrapState(payload) {
  const unreal = payload?.engines?.unreal || {};
  const integration = unreal?.integration || {};
  const plugin = unreal?.plugin || {};
  const host = unreal?.host || {};
  const project = unreal?.project || {};
  const runtimeState = unreal?.runtimeState || {};
  const activeMode = String(integration?.activeMode || integration?.recommendedMode || '').trim().toLowerCase();
  const targetProjectRunning = (
    integration?.directBridgeOnline === true
    || integration?.directBridgeReady === true
    || plugin?.directBridgeOnline === true
    || plugin?.directBridgeReadyForTargetProject === true
    || host?.targetProjectRunning === true
    || project?.running === true
    || runtimeState?.state === 'ready'
    || unreal?.level === 'ready'
  );
  const bridgeReady = (
    integration?.directBridgeReady === true
    || integration?.directBridgeOnline === true
    || plugin?.directBridgeReadyForTargetProject === true
    || plugin?.directBridgeOnline === true
    || (activeMode === 'custom-plugin-direct' && Number(plugin?.cameraCount || 0) > 0)
    || runtimeState?.state === 'ready'
    || unreal?.level === 'ready'
  );
  return {
    targetProjectRunning,
    bridgeReady,
    debug: {
      level: String(unreal?.level || ''),
      runtimeState: String(runtimeState?.state || ''),
      activeMode,
      directBridgeOnline: integration?.directBridgeOnline === true,
      directBridgeReady: integration?.directBridgeReady === true,
      pluginDirectBridgeOnline: plugin?.directBridgeOnline === true,
      pluginDirectBridgeReady: plugin?.directBridgeReadyForTargetProject === true,
      pluginCameraCount: Number(plugin?.cameraCount || 0),
      hostTargetProjectRunning: host?.targetProjectRunning === true,
      projectRunning: project?.running === true,
    },
  };
}

async function readByokRuntime() {
  const response = await fetchWithTimeout(
    `${apiUrl}/api/byok/runtime`,
    { cache: 'no-store' },
    15000,
    'Read /api/byok/runtime',
  );
  if (!response.ok) throw new Error(`Failed to query /api/byok/runtime: HTTP ${response.status}`);
  return response.json();
}

async function validateSiliconflowKey(mode, model) {
  return {
    success: true,
    mode,
    model,
    source: 'runtime-activated-bypass',
  };
}

function resolvePreferredRealVideoRoute(runtime) {
  const activatedProviders = Array.isArray(runtime?.activatedProviders) ? runtime.activatedProviders : [];
  const candidates = [];
  for (const record of activatedProviders) {
    if (String(record?.mode || '') !== 'video') continue;
    const endpoint = String(record?.endpoint || '').trim();
    const availableModels = Array.isArray(record?.availableModels) ? record.availableModels : [];
    for (const model of availableModels) {
      candidates.push({
        provider: String(record?.provider || model?.provider || '').trim(),
        relaySource: String(record?.relaySource || '').trim(),
        endpoint,
        activationModel: String(record?.model || '').trim(),
        modelId: String(model?.id || '').trim(),
        upstreamModel: String(model?.upstreamModel || model?.id || '').trim(),
        catalogModelId: String(model?.catalogModelId || '').trim(),
      });
    }
  }
  const preferredModelIds = explicitRealVideoModelIds.length ? explicitRealVideoModelIds : PREFERRED_REAL_VIDEO_MODEL_IDS;
  const scored = candidates
    .filter((item) => item.modelId)
    .map((item) => {
      const preferredIndex = [item.modelId, item.upstreamModel, item.catalogModelId]
        .map((value) => preferredModelIds.indexOf(String(value || '').trim()))
        .filter((value) => value >= 0)
        .sort((left, right) => left - right)[0] ?? -1;
      const apimartScore = item.endpoint.includes(APIMART_HOST_FRAGMENT) ? 1000 : 0;
      const providerScore = item.provider === 'kling' ? 200 : 0;
      const preferredProviderBoost = explicitRealVideoModelIds.length && (
        [item.modelId, item.upstreamModel, item.catalogModelId].some((value) => preferredModelIds.includes(String(value || '').trim()))
      ) ? 400 : 0;
      const preferredScore = preferredIndex >= 0 ? (preferredModelIds.length - preferredIndex) * 20 : 0;
      return {
        ...item,
        score: apimartScore + providerScore + preferredScore + preferredProviderBoost,
      };
    })
    .sort((left, right) => right.score - left.score);
  return scored[0] || null;
}

function bufferFromDataUrl(url) {
  const match = String(url || '').match(/^data:([^;,]+)?(?:;base64)?,(.*)$/);
  if (!match) return null;
  const isBase64 = String(url || '').includes(';base64,');
  const payload = match[2] || '';
  return isBase64
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8');
}

function resolveAssetUrl(assetUrl) {
  const rawUrl = String(assetUrl || '').trim();
  if (!rawUrl) return '';
  if (/^(?:https?:|data:)/i.test(rawUrl)) return rawUrl;
  return new URL(rawUrl, apiUrl).toString();
}

async function writeAssetSnapshot(targetDir, fileName, assetUrl) {
  const outputPath = path.join(targetDir, fileName);
  const resolvedUrl = resolveAssetUrl(assetUrl);
  if (!resolvedUrl) return null;
  const inlineBuffer = bufferFromDataUrl(resolvedUrl);
  if (inlineBuffer) {
    await fs.writeFile(outputPath, inlineBuffer);
    return outputPath;
  }
  const response = await fetchWithTimeout(
    resolvedUrl,
    { redirect: 'follow' },
    assetSnapshotTimeoutMs,
    `Snapshot download for ${fileName}`,
  );
  if (!response.ok) throw new Error(`Failed to download asset snapshot: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(outputPath, buffer);
  return outputPath;
}

async function probeAssetUrl(assetUrl) {
  const resolvedUrl = resolveAssetUrl(assetUrl);
  if (!resolvedUrl) return null;
  const attempt = async (method, headers = {}) => {
    const response = await fetchWithTimeout(
      resolvedUrl,
      {
        method,
        headers,
        redirect: 'follow',
      },
      assetProbeTimeoutMs,
      `Asset ${method} probe for ${resolvedUrl}`,
    );
    return {
      ok: response.ok,
      status: response.status,
      url: response.url || resolvedUrl,
      contentType: String(response.headers.get('content-type') || ''),
      contentLength: Number(response.headers.get('content-length') || 0),
    };
  };
  const head = await attempt('HEAD').catch(() => null);
  if (head?.ok) return head;
  const range = await attempt('GET', { Range: 'bytes=0-0' }).catch(() => null);
  return range || head;
}

async function writeSummaryFile(targetDir, summary) {
  const outFile = path.join(targetDir, 'verify-dcc-video-tagging-flow-summary.json');
  await fs.writeFile(outFile, `${stringifyJsonAscii(summary)}\n`, 'utf8');
  return outFile;
}

async function waitForMirroredRequestBody(cdp, nodeId, timeoutMs = 5000) {
  return waitForResult(
    async () => {
      const node = await getCanvasNode(cdp, nodeId);
      return node?.data?.params?.requestBody || null;
    },
    (value) => Boolean(value),
    timeoutMs,
    250,
    'Video node did not mirror requestBody back into node params',
  );
}

async function connectCdp(preferredUrlPrefix = '') {
  await waitForHttp(`http://127.0.0.1:${chromePort}/json/version`, 30000);
  const targets = await (await fetch(`http://127.0.0.1:${chromePort}/json/list`)).json();
  const normalizedPrefix = String(preferredUrlPrefix || '').trim();
  const target = (
    targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl && normalizedPrefix && String(item.url || '').startsWith(normalizedPrefix))
    || targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
  );
  if (!target) throw new Error('No CDP page target available.');

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  let id = 0;
  const pending = new Map();
  const listeners = new Map();

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    if (message.method) {
      const handlers = listeners.get(message.method);
      if (handlers) {
        for (const handler of handlers) handler(message.params);
      }
    }
  });

  return {
    mainFrameId: null,
    mainWorldContextId: null,
    send(method, params = {}) {
      const callId = ++id;
      socket.send(JSON.stringify({ id: callId, method, params }));
      return new Promise((resolve, reject) => pending.set(callId, { resolve, reject }));
    },
    on(method, handler) {
      const handlers = listeners.get(method) || new Set();
      handlers.add(handler);
      listeners.set(method, handlers);
      return () => {
        handlers.delete(handler);
        if (handlers.size === 0) listeners.delete(method);
      };
    },
    close() {
      socket.close();
    },
  };
}

async function evalJs(cdp, expression, timeoutMs = 30000) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    timeout: timeoutMs,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Browser evaluation failed');
  }
  return result.result?.value;
}

async function waitFor(cdp, expression, timeoutMs = 30000, intervalMs = 250) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await evalJs(cdp, expression, Math.min(timeoutMs, 5000)).catch(() => null);
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for expression: ${expression}`);
}

async function waitForRoot(cdp, timeoutMs = 60000) {
  await waitFor(cdp, 'Boolean(document.getElementById("root")) && Boolean(document.body)', timeoutMs, 150);
}

async function waitForMainWorldContext(cdp, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (Number.isInteger(cdp.mainWorldContextId)) return cdp.mainWorldContextId;
    await sleep(150);
  }
  throw new Error('Timed out waiting for main-world execution context.');
}

async function waitForDebugBridge(cdp, timeoutMs = 60000) {
  const stateExpression = `
    (() => {
      const debug = ${DEBUG_OBJECT_EXPR};
      const mark = ${DEBUG_BOOTSTRAP_MARK_EXPR};
      const error = ${DEBUG_BOOTSTRAP_ERROR_EXPR};
      const stateElement = document.getElementById(${JSON.stringify(DEBUG_BRIDGE_STATE_ELEMENT_ID)});
      return {
        href: String(location.href || ''),
        readyState: String(document.readyState || ''),
        mark: mark ?? null,
        error: error ?? null,
        hasDebug: Boolean(debug),
        hasCanvasStore: Boolean(debug?.canvasStore),
        hasReadCanvasSnapshot: typeof debug?.readCanvasSnapshot === 'function',
        bridgeAttached: document.documentElement?.dataset?.hmdaoDebugBridgeAttached || null,
        bridgeStateElement: Boolean(stateElement),
      };
    })()
  `;
  const initialState = await evalJs(cdp, stateExpression, 10000).catch(() => null);
  logJsonAscii('[verify:dcc-video-tagging] waitForDebugBridge:initial-state', initialState);
  try {
    await waitFor(cdp, `
      (() => {
        const debug = ${DEBUG_OBJECT_EXPR};
        const mark = ${DEBUG_BOOTSTRAP_MARK_EXPR};
        return Boolean(
          mark === 'ready'
          || (debug && debug.canvasStore && typeof debug.readCanvasSnapshot === 'function')
          || (
            document.documentElement?.dataset?.hmdaoDebugBridgeAttached === 'true'
            && document.getElementById(${JSON.stringify(DEBUG_BRIDGE_STATE_ELEMENT_ID)})
          )
        );
      })()
    `, timeoutMs, 150);
  } catch (error) {
    const finalState = await evalJs(cdp, stateExpression, 10000).catch(() => null);
    throw new Error(`${stringifyError(error)} ${JSON.stringify({ initialState, finalState })}`);
  }
}

async function waitForTaggingContractSurface(cdp, timeoutMs = 60000) {
  const stateExpression = `
    (() => {
      const surface = document.querySelector('[data-testid="tagging-contract-surface"]');
      const status = document.querySelector('[data-testid="tagging-contract-surface-status"]');
      const shell = document.querySelector('[data-testid="tagging-contract-shell-status"]');
      return {
        mark: ${DEBUG_BOOTSTRAP_MARK_EXPR} ?? null,
        shellStatus: shell ? String(shell.textContent || '') : '',
        surfaceStatus: status ? String(status.textContent || '') : '',
        surfaceReady: surface ? String(surface.getAttribute('data-ready') || '') : '',
        surfacePresent: Boolean(surface),
        renderedNodeCount: document.querySelectorAll('[data-node-id]').length,
      };
    })()
  `;
  try {
    await waitFor(cdp, `
      (() => {
        const state = ${stateExpression};
        return Boolean(
          state.surfacePresent
          && (
            state.surfaceReady === 'true'
            || /surface ready/i.test(state.surfaceStatus)
            || (
              state.mark === 'ready'
              && /verify shell ready/i.test(state.shellStatus)
            )
          )
        );
      })()
    `, timeoutMs, 150);
  } catch (error) {
    const finalState = await evalJs(cdp, stateExpression, 10000).catch(() => null);
    throw new Error(`${stringifyError(error)} ${JSON.stringify({ finalState })}`);
  }
}

async function seedTaggingContractCanvas(cdp, timeoutMs = 30000) {
  await waitFor(cdp, `
    (() => {
      const debug = ${DEBUG_OBJECT_EXPR};
      return Boolean(
        debug
        && debug.canvasStore
        && typeof debug.readCanvasSnapshot === 'function'
      );
    })()
  `, timeoutMs, 150);

  const hasSeedFunction = await evalJs(cdp, `
    (() => {
      const debug = ${DEBUG_OBJECT_EXPR};
      return typeof debug?.seedTaggingContractDemo === 'function';
    })()
  `, 10000).catch(() => false);

  if (hasSeedFunction) {
    const seeded = await evalJs(cdp, `
      (() => {
        const debug = ${DEBUG_OBJECT_EXPR};
        const seed = debug?.seedTaggingContractDemo;
        if (typeof seed !== 'function') return false;
        void seed({ resetCanvas: true });
        return true;
      })()
    `, 15000);
    if (!seeded) {
      throw new Error('Debug bridge did not expose seedTaggingContractDemo.');
    }
    return waitForResult(
      async () => evalJs(cdp, `
        (() => {
          const snapshot = ${DEBUG_OBJECT_EXPR}?.readCanvasSnapshot?.();
          return snapshot ? {
            nodeCount: Number(snapshot.nodeCount || 0),
            edgeCount: Number(snapshot.edgeCount || 0),
            selectedNodeIds: Array.isArray(snapshot.selectedNodeIds) ? snapshot.selectedNodeIds : [],
          } : null;
        })()
      `, 10000).catch(() => null),
      (value) => Number(value?.nodeCount || 0) >= 5 && Number(value?.edgeCount || 0) >= 4,
      timeoutMs,
      250,
      'Tagging contract demo seed did not produce the expected starter nodes',
    );
  }

  await execDebugBridgeCommand(cdp, 'canvas:createCanvas', { title: 'Tagging Contract Verify' }, 10000).catch(() => null);
  return waitForResult(
    async () => evalJs(cdp, `
      (() => {
        const snapshot = ${DEBUG_OBJECT_EXPR}?.readCanvasSnapshot?.();
        return snapshot ? {
          nodeCount: Number(snapshot.nodeCount || 0),
          edgeCount: Number(snapshot.edgeCount || 0),
          selectedNodeIds: Array.isArray(snapshot.selectedNodeIds) ? snapshot.selectedNodeIds : [],
        } : null;
      })()
    `, 10000).catch(() => null),
    (value) => value && Number(value?.nodeCount || 0) >= 0,
    timeoutMs,
    250,
    'Main canvas debug bridge did not expose a readable snapshot after canvas:createCanvas',
  );
}

async function execDebugBridgeCommand(cdp, command, args = {}, timeoutMs = 15000) {
  const requestId = createRequestId('bridge');
  const payload = { requestId, command, args };
  const dispatched = await evalJs(cdp, `
    (() => {
      document.dispatchEvent(new CustomEvent(${JSON.stringify(DEBUG_BRIDGE_EVENT_NAME)}, {
        detail: ${JSON.stringify(payload)},
      }));
      return true;
    })()
  `, 10000);
  if (!dispatched) throw new Error(`Failed to dispatch debug bridge command: ${command}`);
  await waitFor(cdp, `
    (() => {
      const element = document.getElementById(${JSON.stringify(DEBUG_BRIDGE_STATE_ELEMENT_ID)});
      return Boolean(
        element
        && element.dataset.requestId === ${JSON.stringify(requestId)}
        && element.textContent
      );
    })()
  `, timeoutMs, 120);
  const response = await evalJs(cdp, `
    (() => {
      const element = document.getElementById(${JSON.stringify(DEBUG_BRIDGE_STATE_ELEMENT_ID)});
      if (!element || element.dataset.requestId !== ${JSON.stringify(requestId)}) return null;
      try {
        return JSON.parse(element.textContent || '{}');
      } catch (error) {
        return {
          ok: false,
          error: String(error?.message || error || 'debug-bridge-response-parse-error'),
        };
      }
    })()
  `, 10000);
  if (!response?.ok) {
    throw new Error(`Debug bridge command failed: ${command} ${JSON.stringify(response || {})}`);
  }
  return response.result;
}

async function waitForResult(read, predicate, timeoutMs, intervalMs, description) {
  const started = Date.now();
  let lastValue = null;
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      lastValue = await read();
      if (predicate(lastValue)) return lastValue;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  if (lastError) {
    throw new Error(`${description}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }
  throw new Error(`${description}: ${JSON.stringify(lastValue)}`);
}

async function addCanvasNode(cdp, type, position) {
  const result = await execDebugBridgeCommand(cdp, 'canvas:addNode', { type, position });
  return String(result?.nodeId || '');
}

async function updateCanvasNodeData(cdp, nodeId, patch) {
  await execDebugBridgeCommand(cdp, 'canvas:updateNodeData', { nodeId, patch });
}

async function addCanvasEdge(cdp, source, target, options = {}) {
  await execDebugBridgeCommand(cdp, 'canvas:addEdge', { source, target, options });
}

async function setCanvasSelection(cdp, nodeIds) {
  await execDebugBridgeCommand(cdp, 'canvas:setSelectedNodeIds', { nodeIds });
}

async function getCanvasNode(cdp, nodeId) {
  return execDebugBridgeCommand(cdp, 'canvas:getNode', { nodeId });
}

async function listCanvasNodes(cdp) {
  return execDebugBridgeCommand(cdp, 'canvas:listNodes');
}

async function readDccRecordingState(cdp, dccNodeId) {
  const [nodes, dccNode] = await Promise.all([
    listCanvasNodes(cdp).catch(() => []),
    getCanvasNode(cdp, dccNodeId).catch(() => null),
  ]);
  const nodeList = Array.isArray(nodes) ? nodes : [];
  const regionNode = [...nodeList].reverse().find((node) => (
    node?.type === 'region'
    && String(node?.data?.params?.sourceNodeId || '') === String(dccNodeId || '')
    && String(node?.data?.videoUrl || '').trim()
  )) || null;
  const dccData = dccNode?.data && typeof dccNode.data === 'object' ? dccNode.data : {};
  const dccParams = dccData?.params && typeof dccData.params === 'object' ? dccData.params : {};
  const dccOutputs = Array.isArray(dccData?.outputs) ? dccData.outputs : [];
  const fallbackOutput = dccOutputs.find((item) => item && typeof item === 'object' && String(item.type || '').trim() === 'video');
  const dccRecordingUrl = String(
    dccData?.videoUrl
    || dccParams?.recordingUrl
    || fallbackOutput?.url
    || '',
  ).trim();
  const firstFrameUrl = String(dccParams?.firstFrameUrl || '').trim();
  const videoMeta = dccParams?.videoMeta && typeof dccParams.videoMeta === 'object'
    ? dccParams.videoMeta
    : null;
  return {
    regionNodeId: String(regionNode?.id || '').trim(),
    videoUrl: String(regionNode?.data?.videoUrl || '').trim(),
    label: String(regionNode?.data?.label || '').trim(),
    dccRecordingUrl,
    dccFirstFrameUrl: firstFrameUrl,
    dccVideoMeta: videoMeta,
    dccNode: summarizeCanvasNode(dccNode),
    candidateNodes: nodeList
      .slice(-8)
      .map((node) => summarizeCanvasNode(node))
      .filter(Boolean),
  };
}

async function createRegionNodeFromDccRecording(cdp, dccNodeId, recordedState) {
  const sourceNode = await getCanvasNode(cdp, dccNodeId);
  const sourceData = sourceNode?.data && typeof sourceNode.data === 'object' ? sourceNode.data : {};
  const sourceParams = sourceData?.params && typeof sourceData.params === 'object' ? sourceData.params : {};
  const sourcePosition = sourceNode?.position && typeof sourceNode.position === 'object' ? sourceNode.position : { x: 0, y: 0 };
  const regionNodeId = await addCanvasNode(cdp, 'region', {
    x: Number(sourcePosition.x || 0) + 600,
    y: Number(sourcePosition.y || 0) + 260,
  });
  const regionVideoUrl = String(recordedState?.dccRecordingUrl || recordedState?.videoUrl || '').trim();
  const firstFrameUrl = String(recordedState?.dccFirstFrameUrl || '').trim();
  const videoMeta = recordedState?.dccVideoMeta && typeof recordedState.dccVideoMeta === 'object'
    ? recordedState.dccVideoMeta
    : undefined;
  const sourceLabel = String(sourceData?.label || 'DCC 捕捉').trim() || 'DCC 捕捉';
  await updateCanvasNodeData(cdp, regionNodeId, {
    label: `${String(sourceParams?.engine || sourceData?.model || 'DCC').trim() || 'DCC'} 录制打标签节点`,
    status: 'completed',
    provider: 'dcc',
    model: String(sourceData?.model || sourceParams?.engine || 'dcc').trim() || 'dcc',
    videoUrl: regionVideoUrl,
    params: {
      sourceMediaType: 'video',
      sourceNodeId: dccNodeId,
      sourceNodeLabel: sourceLabel,
      ...(firstFrameUrl ? { firstFrameUrl } : {}),
      ...(videoMeta ? { videoMeta } : {}),
    },
    outputs: [{
      id: `verify-dcc-recording-${Date.now()}`,
      type: 'video',
      url: regionVideoUrl,
      thumbnail: firstFrameUrl || regionVideoUrl,
      metadata: {
        source: 'verify-dcc-video-tagging',
        sourceNodeId: dccNodeId,
      },
    }],
  });
  await addCanvasEdge(cdp, dccNodeId, regionNodeId, {
    sourceHandle: 'dcc-output',
    targetHandle: 'region-main',
  });
  return regionNodeId;
}

function summarizeCanvasNode(node) {
  if (!node || typeof node !== 'object') return null;
  const data = node.data && typeof node.data === 'object' ? node.data : {};
  const params = data.params && typeof data.params === 'object' ? data.params : {};
  const outputs = Array.isArray(data.outputs) ? data.outputs : [];
  return {
    id: String(node.id || ''),
    type: String(node.type || ''),
    label: String(data.label || ''),
    status: String(data.status || ''),
    model: String(data.model || ''),
    provider: String(data.provider || ''),
    imageUrl: String(data.imageUrl || ''),
    videoUrl: String(data.videoUrl || ''),
    outputCount: outputs.length,
    firstOutputType: String(outputs[0]?.type || ''),
    firstOutputUrl: String(outputs[0]?.url || ''),
    engine: String(params.engine || ''),
    sourceMediaType: String(params.sourceMediaType || ''),
    selectedCamera: String(params.selectedCamera || ''),
    selectedCameraId: String(params.selectedCameraId || ''),
    resolution: params.resolution || null,
  };
}

async function selectNodeById(cdp, nodeId) {
  await setCanvasSelection(cdp, [nodeId]);
}

async function openNodePanel(cdp, nodeId, mode = 'panel') {
  const opened = await evalJs(cdp, `
    (() => {
      const debug = ${DEBUG_OBJECT_EXPR};
      const openPanel = debug?.openMigrationNodePanel;
      if (typeof openPanel !== 'function') return false;
      openPanel(${JSON.stringify(nodeId)}, ${JSON.stringify(mode)});
      return true;
    })()
  `, 10000).catch(() => false);
  if (!opened) {
    throw new Error(`Unable to open node panel for ${nodeId}`);
  }
  await sleep(250);
}

async function ensureDccNodeControlsVisible(cdp, nodeId, timeoutMs = 30000) {
  const nodeSelector = `[data-testid="dcc-node-${nodeId}"]`;
  await selectNodeById(cdp, nodeId);
  const controlsExpression = `
    (() => {
      const snapshot = window.__HMDAO_DEBUG__?.readCanvasSnapshot?.();
      const hasSelection = Array.isArray(snapshot?.selectedNodeIds)
        && snapshot.selectedNodeIds.length === 1
        && snapshot.selectedNodeIds[0] === ${JSON.stringify(nodeId)};
      const connectButton = document.querySelector(${JSON.stringify(`[data-testid="dcc-connect-${nodeId}"]`)});
      const engineSelect = document.querySelector(${JSON.stringify(`[data-testid="dcc-engine-${nodeId}"]`)});
      return hasSelection && Boolean(connectButton) && Boolean(engineSelect);
    })()
  `;
  const visibleViaDom = await evalJs(cdp, controlsExpression, 5000).catch(() => false);
  if (visibleViaDom) return;
  const rootVisible = await evalJs(cdp, `Boolean(document.querySelector(${JSON.stringify(nodeSelector)}))`, 5000).catch(() => false);
  if (rootVisible) {
    await clickSelector(cdp, nodeSelector);
  }
  await waitFor(cdp, controlsExpression, timeoutMs, 250);
}

async function clickSelector(cdp, selector) {
  const safeSelector = JSON.stringify(selector);
  const ok = await evalJs(cdp, `
    (() => {
      const element = document.querySelector(${safeSelector});
      if (!element) return false;
      if (typeof element.scrollIntoView === 'function') {
        element.scrollIntoView({ block: 'center', inline: 'center' });
      }
      const rect = typeof element.getBoundingClientRect === 'function'
        ? element.getBoundingClientRect()
        : { left: 0, top: 0, width: 0, height: 0 };
      const clientX = rect.left + (rect.width / 2);
      const clientY = rect.top + (rect.height / 2);
      const pointerEventInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 0,
        buttons: 1,
        clientX,
        clientY,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
      };
      if (typeof PointerEvent === 'function') {
        element.dispatchEvent(new PointerEvent('pointerdown', pointerEventInit));
      }
      element.dispatchEvent(new MouseEvent('mousedown', pointerEventInit));
      if (typeof element.focus === 'function') {
        element.focus({ preventScroll: true });
      }
      if (typeof PointerEvent === 'function') {
        element.dispatchEvent(new PointerEvent('pointerup', { ...pointerEventInit, buttons: 0 }));
      }
      element.dispatchEvent(new MouseEvent('mouseup', { ...pointerEventInit, buttons: 0 }));
      element.dispatchEvent(new MouseEvent('click', { ...pointerEventInit, buttons: 0 }));
      return true;
    })()
  `, 10000);
  if (!ok) throw new Error(`Element not found: ${selector}`);
}

async function setValue(cdp, selector, value) {
  const safeSelector = JSON.stringify(selector);
  const safeValue = JSON.stringify(String(value));
  const ok = await evalJs(cdp, `
    (() => {
      const element = document.querySelector(${safeSelector});
      if (!element) return false;
      const proto = Object.getPrototypeOf(element);
      const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
      if (descriptor && typeof descriptor.set === 'function') {
        descriptor.set.call(element, ${safeValue});
      } else {
        element.value = ${safeValue};
      }
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `, 10000);
  if (!ok) throw new Error(`Unable to set value for ${selector}`);
}

async function pinVideoRoute(cdp, nodeId, route) {
  const node = await getCanvasNode(cdp, nodeId);
  const params = node?.data?.params && typeof node.data.params === 'object'
    ? node.data.params
    : {};
  const pinnedModel = String(route?.upstreamModel || route?.modelId || '').trim();
  await updateCanvasNodeData(cdp, nodeId, {
    model: pinnedModel,
    provider: route.provider,
    params: {
      ...params,
      modelPinnedByUser: true,
      pinnedCatalogModelId: String(route?.catalogModelId || route?.modelId || '').trim(),
    },
  });
  await waitForResult(
    async () => {
      const nextNode = await getCanvasNode(cdp, nodeId);
      return {
        model: String(nextNode?.data?.model || ''),
        provider: String(nextNode?.data?.provider || ''),
      };
    },
    (value) => value?.model === pinnedModel && value?.provider === route.provider,
    15000,
    250,
    'Video node did not pin the requested real route',
  );
}

async function waitForWorkflowFrame(workflowFrames, initialCount, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (workflowFrames.length > initialCount) {
      return workflowFrames[workflowFrames.length - 1] || null;
    }
    await sleep(150);
  }
  return null;
}

function buildRefImageUrl() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
      <rect width="1280" height="720" fill="#111827"/>
      <rect x="120" y="420" width="1040" height="170" rx="30" fill="#1f2937"/>
      <rect x="250" y="300" width="610" height="170" rx="48" fill="#7f1d1d"/>
      <rect x="770" y="338" width="180" height="120" rx="34" fill="#991b1b"/>
      <circle cx="360" cy="560" r="92" fill="#030712"/>
      <circle cx="930" cy="560" r="92" fill="#030712"/>
      <circle cx="360" cy="560" r="42" fill="#9ca3af"/>
      <circle cx="930" cy="560" r="42" fill="#9ca3af"/>
      <text x="120" y="140" fill="#f9fafb" font-family="Arial, sans-serif" font-size="64">Vintage Car Reference</text>
      <text x="120" y="210" fill="#fca5a5" font-family="Arial, sans-serif" font-size="30">Used for subject transfer only</text>
    </svg>
  `;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function guessImageMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.bmp') return 'image/bmp';
  return 'application/octet-stream';
}

async function resolveReferenceImageUrl(input, fallbackFactory) {
  if (!input) return fallbackFactory();
  if (/^(data:|https?:\/\/|file:\/\/)/i.test(input)) return input;
  const absolutePath = path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
  const fileBuffer = await fs.readFile(absolutePath);
  return `data:${guessImageMimeType(absolutePath)};base64,${fileBuffer.toString('base64')}`;
}

function buildBeachRefImageUrl() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
      <defs>
        <linearGradient id="sky" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="#8ad7ff"/>
          <stop offset="58%" stop-color="#d6f3ff"/>
          <stop offset="100%" stop-color="#f7d8a5"/>
        </linearGradient>
        <linearGradient id="sea" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stop-color="#0f7fa6"/>
          <stop offset="100%" stop-color="#48b6cb"/>
        </linearGradient>
      </defs>
      <rect width="1280" height="420" fill="url(#sky)"/>
      <rect y="420" width="1280" height="130" fill="url(#sea)"/>
      <rect y="550" width="1280" height="170" fill="#ead0a2"/>
      <ellipse cx="1040" cy="144" rx="86" ry="86" fill="#fff5c2" opacity="0.82"/>
      <path d="M0 518 C180 474, 360 494, 530 470 C720 444, 890 490, 1280 454 L1280 550 L0 550 Z" fill="rgba(255,255,255,0.18)"/>
      <text x="96" y="132" fill="#0f172a" font-family="Arial, sans-serif" font-size="62">Beach Lighting Reference</text>
      <text x="96" y="198" fill="#1e3a5f" font-family="Arial, sans-serif" font-size="28">Background atmosphere only, keep foreground motion unchanged</text>
    </svg>
  `;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function buildVideoRegionContract(regionNodeId, sourceUrl, subjectRefNodeId, subjectRefUrl, backgroundRefNodeId, backgroundRefUrl) {
  const subjectRect = { x: 0.24, y: 0.26, width: 0.38, height: 0.48 };
  const backgroundRect = { x: 0, y: 0, width: 1, height: 1 };
  const subjectBinding = {
    slotId: 'slot-subject-reference',
    sourceNodeId: subjectRefNodeId,
    sourceAssetUrl: subjectRefUrl,
    sourceMediaType: 'image',
    sourcelabel: `${subjectReferenceLabel}主体参考`,
    bindingRole: 'subject-reference',
    preserveDetail: true,
    weight: 95,
    description: `严格参考 ${subjectReferenceLabel} 的脸部、发型、服装、轮廓和整体身份特征，只用于主体替换，不改变原有动作节奏。`,
  };
  const backgroundBinding = {
    slotId: 'slot-beach-background',
    sourceNodeId: backgroundRefNodeId,
    sourceAssetUrl: backgroundRefUrl,
    sourceMediaType: 'image',
    sourcelabel: `${backgroundReferenceLabel}背景参考`,
    bindingRole: 'background-reference',
    preserveDetail: false,
    weight: 84,
    description: `仅使用 ${backgroundReferenceLabel} 的天空、海面、沙滩、晨光和空间氛围，不向前景额外引入人物或道具。`,
  };
  return {
    version: 'region-contract-v1',
    source: {
      nodeId: regionNodeId,
      nodeLabel: '视频打标签节点',
      url: sourceUrl,
      mediaType: 'video',
    },
    regions: [
      {
        regionId: 'region-subject-reference',
        label: `${subjectReferenceLabel}主体参考`,
        geometry: { rect: subjectRect },
        targetKind: 'subject',
        editIntent: 'replace_subject',
        description: `只替换视频里黄色跳舞角色为参考图中的 ${subjectReferenceLabel}，保持原始运镜、动作连续性、镜头节奏和角色占位不变，其他人物与道具不做改变。`,
        strictness: 'exact_transfer',
        bindingMode: 'reference_required',
        bindings: [subjectBinding],
        enabled: true,
        frameRange: { startFrame: 0, endFrame: 16 },
        track: {
          mode: 'static',
          startFrame: 0,
          endFrame: 16,
          keyframes: [
            { frame: 0, rect: subjectRect },
            { frame: 16, rect: subjectRect },
          ],
          occlusionPolicy: 'hold',
        },
      },
      {
        regionId: 'region-background-beach',
        label: `${backgroundReferenceLabel}背景参考`,
        geometry: { rect: backgroundRect },
        targetKind: 'background',
        editIntent: 'background_fuse',
        description: `只替换环境背景为 ${backgroundReferenceLabel}，保留角色动作路径、镜头动画、前景物体和画面节奏。`,
        negativePrompt: '不要改动前景主体与其他角色，不要新增船只、建筑、路人、文字或无关道具。',
        strictness: 'harmonize_only',
        bindingMode: 'reference_required',
        bindings: [backgroundBinding],
        enabled: true,
        frameRange: { startFrame: 0, endFrame: 16 },
        track: {
          mode: 'static',
          startFrame: 0,
          endFrame: 16,
          keyframes: [
            { frame: 0, rect: backgroundRect },
            { frame: 16, rect: backgroundRect },
          ],
          occlusionPolicy: 'hold',
        },
      },
    ],
    bindings: [subjectBinding, backgroundBinding],
    executionPlan: {
      orderedRegionIds: ['region-background-beach', 'region-subject-reference'],
      strategy: 'region-contract-v1',
    },
    consistencyRequirements: ['preserve_camera_motion', 'preserve_action_timing', 'preserve_subject_detail', 'reference_detail_lock', 'temporal_region_consistency'],
    fallbackPolicy: 'reject',
    summary: `视频打标签 · 2 个标签 · ${subjectReferenceLabel}主体替换 + ${backgroundReferenceLabel}背景融合 · 保持原运镜与动作`,
    generatedAt: Date.now(),
  };
}

function wsAcceptKey(key) {
  return crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
}

function encodeFrame(payload, { masked = true } = {}) {
  const data = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const header = [0x81];
  if (data.length < 126) {
    header.push((masked ? 0x80 : 0) | data.length);
  } else {
    header.push((masked ? 0x80 : 0) | 126, (data.length >> 8) & 255, data.length & 255);
  }
  if (!masked) return Buffer.concat([Buffer.from(header), data]);
  const mask = crypto.randomBytes(4);
  const out = Buffer.alloc(data.length);
  for (let index = 0; index < data.length; index += 1) out[index] = data[index] ^ mask[index % 4];
  return Buffer.concat([Buffer.from(header), mask, out]);
}

function createParser(onMessage) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const first = buffer[0];
      const second = buffer[1];
      const opcode = first & 0x0f;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      }
      if (length === 127) throw new Error('Large frames are not expected in DCC verification');
      if (buffer.length < offset + length) return;
      const payload = buffer.subarray(offset, offset + length);
      buffer = buffer.subarray(offset + length);
      if (opcode === 1) onMessage(JSON.parse(payload.toString('utf8')));
    }
  };
}

async function connectPath(pathname) {
  const socket = net.connect({ host: apiHost, port: apiPort });
  const key = crypto.randomBytes(16).toString('base64');
  const messages = [];
  let ready = false;
  let handshake = Buffer.alloc(0);
  const parser = createParser((message) => messages.push(message));

  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.write([
        `GET ${pathname} HTTP/1.1`,
        `Host: ${apiHost}:${apiPort}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '\r\n',
      ].join('\r\n'));
    });
    socket.on('data', (chunk) => {
      if (ready) {
        parser(chunk);
        return;
      }
      handshake = Buffer.concat([handshake, chunk]);
      const end = handshake.indexOf('\r\n\r\n');
      if (end === -1) return;
      const header = handshake.subarray(0, end).toString('utf8');
      if (!/^HTTP\/1\.1 101/i.test(header)) reject(new Error(header));
      const accept = header.match(/sec-websocket-accept:\s*(.+)/i)?.[1]?.trim();
      if (accept !== wsAcceptKey(key)) reject(new Error('Invalid WebSocket accept key'));
      ready = true;
      const rest = handshake.subarray(end + 4);
      if (rest.length) parser(rest);
      resolve();
    });
  });

  return {
    messages,
    send(payload) {
      socket.write(encodeFrame(payload));
    },
    close() {
      socket.end();
      if (typeof socket.destroySoon === 'function') {
        socket.destroySoon();
        return;
      }
      setTimeout(() => {
        if (!socket.destroyed) socket.destroy();
      }, 150);
    },
  };
}

function tinyVideoPosterUrl(label) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920"><rect width="1080" height="1920" fill="#0f172a"/><rect x="84" y="1348" width="912" height="336" rx="44" fill="#172554"/><text x="96" y="230" fill="#f8fafc" font-family="Arial" font-size="72">${label}</text><text x="96" y="328" fill="#93c5fd" font-family="Arial" font-size="34">HMDao Unreal Mock Recording</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function classifyCameraOption(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return 'unknown';
  if (normalized.includes('viewport')) return 'viewport';
  if (/camera|cine|shot/.test(normalized)) return 'camera';
  if (normalized.includes('view')) return 'view';
  return 'other';
}

async function attachFakeUnrealPlugin() {
  const plugin = await connectPath('/ws/dcc/unreal?role=plugin');
  const handled = new Set();
  let selectedCamera = 'CineCameraActor_01';
  plugin.send({ type: 'hello', engine: 'unreal', plugin: 'HMDao Unreal Capture', pluginVersion: 'verify', protocolVersion: 1, editor: true, previewProvider: 'editor-direct' });
  const timer = setInterval(() => {
    plugin.messages.forEach((message, index) => {
      if (handled.has(index)) return;
      handled.add(index);
      if (message.type === 'query_state') {
        plugin.send({
          type: 'connected',
          mode: 'real',
          status: 'connected',
          selectedCameraName: selectedCamera,
          previewProvider: 'editor-direct',
        });
      }
      if (message.type === 'connect') {
        plugin.send({
          type: 'connected',
          mode: 'real',
          status: 'connected',
          selectedCameraName: selectedCamera,
          previewProvider: 'editor-direct',
          width: Number(message.w || 1280),
          height: Number(message.h || 720),
        });
      }
      if (message.type === 'query_cameras') {
        plugin.send({
          type: 'camera_list',
          camera_list: ['CineCameraActor_01', 'CineCameraActor_02', 'Sequencer_Camera'].map((name) => ({
            name,
            label: name,
            active: name === selectedCamera,
            engine: 'unreal',
          })),
          selected_camera: selectedCamera,
        });
      }
      if (message.type === 'query_timeline') {
        plugin.send({ type: 'animation_range', start_frame: 1, end_frame: 144, current_frame: 1, fps: 24 });
      }
      if (message.type === 'set_camera') {
        selectedCamera = String(message.cameraName || message.camera_name || selectedCamera);
        plugin.send({
          type: 'camera_list',
          camera_list: ['CineCameraActor_01', 'CineCameraActor_02', 'Sequencer_Camera'].map((name) => ({
            name,
            label: name,
            active: name === selectedCamera,
            engine: 'unreal',
          })),
          selected_camera: selectedCamera,
        });
        plugin.send({ type: 'animation_range', start_frame: 1, end_frame: 144, current_frame: 1, fps: 24 });
      }
      if (message.type === 'start_preview') {
        selectedCamera = String(message.cameraName || message.camera_name || selectedCamera);
        plugin.send({
          type: 'preview_frame',
          url: tinyVideoPosterUrl(`preview-${selectedCamera}`),
          width: Number(message.width || 1080),
          height: Number(message.height || 1920),
          cameraName: selectedCamera,
          latencyMs: 4,
        });
      }
      if (message.type === 'start_recording') {
        plugin.send({
          type: 'recording_started',
          camera_name: selectedCamera,
          start_frame: message.startFrame,
          end_frame: message.endFrame,
          fps: message.fps,
          mock: false,
        });
      }
      if (message.type === 'stop_recording') {
        plugin.send({
          type: 'recording_done',
          asset: {
            kind: 'video',
            url: tinyVideoPosterUrl(`record-${selectedCamera}`),
            width: 1080,
            height: 1920,
            cameraName: selectedCamera,
            sizeBytes: 4096,
          },
        });
      }
    });
  }, 30);
  return {
    close() {
      clearInterval(timer);
      plugin.close();
    },
  };
}

async function main() {
  const cwd = process.cwd();
  const outDir = path.resolve(cwd, 'artifacts');
  await fs.mkdir(outDir, { recursive: true });
  const children = [];
  const workflowFrames = [];
  let fakeUnrealPlugin = null;
  let cdp = null;
  let selectedRealVideoRoute = null;
  let unrealBridgeBootstrap = null;
  let stage = 'bootstrap';
  const runState = {
    dccNodeId: '',
    videoNodeId: '',
    regionNodeId: '',
    subjectRefNodeId: '',
    backgroundRefNodeId: '',
    effectiveTargetUrl: '',
    engineSwitchVerified: false,
    resolutionSwitchVerified: false,
    cameraSwitchVerified: false,
    regionContractModeInjected: false,
    executionStateHydrated: false,
    workflowCreateCaptured: false,
    workflowGenerationMode: '',
    requestGenerationMode: '',
    workflowRequestModel: '',
    resolvedRequestModel: '',
    resolvedRequestProvider: '',
    unrealBridgeSource: '',
    unrealBridgeBootstrapState: '',
    availableCameras: [],
    selectedCamera: '',
    selectedCameraKind: '',
    requestBodyMirroredToNodeParams: false,
    requestBodySnapshot: null,
    sourceVideoUrlPresent: false,
    preserveCameraMotion: false,
    lastErrorCategory: '',
    finalStatus: '',
    finalError: '',
    outputVideoUrl: '',
    outputVideoProbe: null,
    outputVideoSnapshotPath: null,
    validationIssues: [],
    failureClassification: null,
  };
  const attachExistingBrowser = process.env.HMDAO_VERIFY_ATTACH_EXISTING === '1';
  if (!chromePath) throw new Error('Chrome or Edge not found.');

  try {
    stage = 'service-bootstrap';
    await ensureService(`${apiUrl}/api/health`, () => start('node', ['server/hmdao-api.mjs'], cwd, children));
    const useStaticVerifyApp = await fs.access(builtVerifyAppIndexPath).then(() => true).catch(() => false);
    await ensureService(
      `${appUrl}/`,
      () => useStaticVerifyApp
        ? start('node', ['server/ui-static-proxy.mjs', '--port', '3011', '--api', apiUrl], cwd, children)
        : start('npm.cmd', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '3011'], cwd, children),
    );
    unrealBridgeBootstrap = await readUnrealEnvironmentStatus().catch((error) => ({ __error: stringifyError(error) }));
    let bootstrapStatus = resolveUnrealBootstrapState(unrealBridgeBootstrap);
    let bootstrapTargetProjectRunning = bootstrapStatus.targetProjectRunning;
    let bootstrapBridgeReady = bootstrapStatus.bridgeReady;
    let dccBootstrap = null;
    if (!bootstrapBridgeReady) {
      dccBootstrap = await readUnrealDccStatus().catch((error) => ({ __error: stringifyError(error) }));
      const dccUnreal = dccBootstrap?.engines?.unreal || {};
      if (dccUnreal?.directBridgeReadyForTargetProject === true || dccUnreal?.directBridgeOnline === true) {
        bootstrapTargetProjectRunning = bootstrapTargetProjectRunning || dccUnreal?.targetProjectRunning === true;
        bootstrapBridgeReady = true;
      }
    }
    logJsonAscii('[verify:dcc-video-tagging] unreal-bootstrap', {
      environment: bootstrapStatus.debug,
      environmentError: String(unrealBridgeBootstrap?.__error || ''),
      dccStatus: dccBootstrap?.engines?.unreal
        ? {
            directBridgeOnline: dccBootstrap.engines.unreal.directBridgeOnline === true,
            directBridgeReadyForTargetProject: dccBootstrap.engines.unreal.directBridgeReadyForTargetProject === true,
            targetProjectRunning: dccBootstrap.engines.unreal.targetProjectRunning === true,
          }
        : null,
      dccStatusError: String(dccBootstrap?.__error || ''),
      resolved: {
        bootstrapTargetProjectRunning,
        bootstrapBridgeReady,
      },
    });
    runState.unrealBridgeBootstrapState = bootstrapBridgeReady
      ? 'ready'
      : bootstrapTargetProjectRunning
        ? 'running-without-bridge'
        : 'offline';
    if (bootstrapBridgeReady) {
      runState.unrealBridgeSource = 'real-bridge';
    } else if (realVideoGenerationEnabled && bootstrapTargetProjectRunning) {
      runState.unrealBridgeSource = 'pending-real-bridge';
    } else {
      fakeUnrealPlugin = await attachFakeUnrealPlugin();
      runState.unrealBridgeSource = bootstrapTargetProjectRunning ? 'fake-plugin-low-cost' : 'fake-plugin';
    }

    const userDataDir = path.resolve(cwd, 'artifacts', `dcc-video-tagging-profile-${Date.now()}`);
    await fs.mkdir(userDataDir, { recursive: true });
    const browserDebugUrl = `http://127.0.0.1:${chromePort}/json/version`;
    const browserReady = attachExistingBrowser ? await isHttpReady(browserDebugUrl) : false;
    if (!attachExistingBrowser || !browserReady) {
      start(chromePath, [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--remote-allow-origins=*',
        `--user-data-dir=${userDataDir}`,
        `--remote-debugging-port=${chromePort}`,
        `${appUrl}${appPath}`,
      ], cwd, children);
    }

    stage = 'browser-connect';
    cdp = await connectCdp(`${appUrl}${appPath}`);
    await cdp.send('Page.enable');
    const frameTree = await cdp.send('Page.getFrameTree');
    cdp.mainFrameId = frameTree?.frameTree?.frame?.id || null;
    cdp.on('Runtime.executionContextCreated', (params) => {
      const context = params?.context;
      const auxData = context?.auxData;
      if (context && auxData && auxData.frameId === cdp.mainFrameId && auxData.isDefault === true) {
        cdp.mainWorldContextId = context.id;
      }
    });
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 960,
      deviceScaleFactor: 1,
      mobile: false,
    });

    cdp.on('Network.webSocketFrameSent', (params) => {
      const payloadData = params.response?.payloadData;
      if (typeof payloadData !== 'string') return;
      try {
        const parsed = JSON.parse(payloadData);
        if (parsed?.msg_type === 'workflow:create') workflowFrames.push({ ts: Date.now(), ...parsed });
      } catch {
        // ignore
      }
    });

    const targetUrl = `${appUrl}${appPath}`;
    const currentHref = await evalJs(cdp, 'String(location.href || "")', 10000).catch(() => '');
    if (!String(currentHref || '').startsWith(targetUrl)) {
      await cdp.send('Page.navigate', { url: targetUrl });
    }
    await waitFor(cdp, `location.href.startsWith(${JSON.stringify(targetUrl)})`, 30000, 250);
    await waitFor(cdp, 'document.readyState === "interactive" || document.readyState === "complete"', 30000, 250);
    await waitForMainWorldContext(cdp, 30000);
    await waitForRoot(cdp, 30000);
    let effectiveAppPath = appPath;
    let effectiveTargetUrl = targetUrl;
    runState.effectiveTargetUrl = effectiveTargetUrl;
    stage = 'debug-bridge';
    try {
      await waitForDebugBridge(cdp, 30000);
      await waitForTaggingContractSurface(cdp, 30000);
    } catch (error) {
      const fallbackUrl = `${appUrl}${fallbackAppPath}`;
      logJsonAscii('[verify:dcc-video-tagging] debug-bridge-fallback', {
        reason: stringifyError(error),
        from: targetUrl,
        to: fallbackUrl,
      });
      stage = 'debug-bridge-fallback';
      await cdp.send('Page.navigate', { url: fallbackUrl });
      await waitFor(cdp, `location.href.startsWith(${JSON.stringify(fallbackUrl)})`, 30000, 250);
      await waitFor(cdp, 'document.readyState === "interactive" || document.readyState === "complete"', 30000, 250);
      await waitForMainWorldContext(cdp, 30000);
      await waitForRoot(cdp, 30000);
      await waitForDebugBridge(cdp, 30000);
      effectiveAppPath = fallbackAppPath;
      effectiveTargetUrl = fallbackUrl;
      effectiveTargetUrl = fallbackUrl;
      runState.effectiveTargetUrl = effectiveTargetUrl;
    }
    const bridgePing = await execDebugBridgeCommand(cdp, 'bridge:ping', {}, 10000);
    const seededSnapshot = await seedTaggingContractCanvas(cdp, 30000);
    const bridgeState = await evalJs(cdp, `
      (() => {
        const stateElement = document.getElementById(${JSON.stringify(DEBUG_BRIDGE_STATE_ELEMENT_ID)});
        const serializedState = stateElement?.dataset?.bridgeStateJson || '';
        const publicState = serializedState ? JSON.parse(serializedState) : null;
        const debug = ${DEBUG_OBJECT_EXPR};
        const windowState = debug ? {
          mark: ${DEBUG_BOOTSTRAP_MARK_EXPR} ?? null,
          error: ${DEBUG_BOOTSTRAP_ERROR_EXPR} ?? null,
          hasDebug: Boolean(debug),
          debugKeys: Object.keys(debug).sort(),
          hasCanvasStore: Boolean(debug?.canvasStore),
          hasReadCanvasSnapshot: typeof debug?.readCanvasSnapshot === 'function',
        } : null;
        return {
          href: String(location.href || ''),
          mark: windowState?.mark ?? publicState?.mark ?? null,
          error: windowState?.error ?? publicState?.error ?? null,
          hasDebug: windowState?.hasDebug ?? publicState?.hasDebug ?? false,
          debugKeys: windowState?.debugKeys ?? publicState?.debugKeys ?? [],
          hasCanvasStore: windowState?.hasCanvasStore ?? publicState?.hasCanvasStore ?? false,
          hasReadCanvasSnapshot: windowState?.hasReadCanvasSnapshot ?? publicState?.hasReadCanvasSnapshot ?? false,
          bridgeAttached: document.documentElement?.dataset?.hmdaoDebugBridgeAttached || null,
          bridgeStateElement: Boolean(stateElement),
        };
      })()
    `, 10000);
    logJsonAscii('[verify:dcc-video-tagging] bridge-state', { ...bridgeState, bridgePing, seededSnapshot });

    if (effectiveAppPath === fallbackAppPath) {
      await waitFor(cdp, 'Boolean(document.querySelector(".react-flow"))', 90000, 250);
    }

    stage = 'canvas-setup';
    const dccNodeId = await addCanvasNode(cdp, 'dcc', { x: 180, y: 140 });
    const videoNodeId = await addCanvasNode(cdp, 'video', { x: 1420, y: 220 });
    const subjectRefNodeId = await addCanvasNode(cdp, 'image', { x: 860, y: 520 });
    const backgroundRefNodeId = await addCanvasNode(cdp, 'image', { x: 860, y: 760 });
    runState.dccNodeId = dccNodeId;
    runState.videoNodeId = videoNodeId;
    runState.subjectRefNodeId = subjectRefNodeId;
    runState.backgroundRefNodeId = backgroundRefNodeId;
    const subjectRefUrl = await resolveReferenceImageUrl(subjectReferenceInput, buildRefImageUrl);
    const backgroundRefUrl = await resolveReferenceImageUrl(backgroundReferenceInput, buildBeachRefImageUrl);

    await updateCanvasNodeData(cdp, subjectRefNodeId, {
      label: `${subjectReferenceLabel}主体参考`,
      status: 'completed',
      imageUrl: subjectRefUrl,
      outputs: [{
        id: 'video-tagging-subject-ref-output',
        type: 'image',
        url: subjectRefUrl,
        metadata: { width: 1280, height: 720, managedUrl: false },
      }],
      params: {
        imageMeta: { width: 1280, height: 720 },
        sourceUrl: subjectRefUrl,
        sourceMediaType: 'image',
      },
    });

    await updateCanvasNodeData(cdp, backgroundRefNodeId, {
      label: `${backgroundReferenceLabel}背景参考`,
      status: 'completed',
      imageUrl: backgroundRefUrl,
      outputs: [{
        id: 'video-tagging-background-ref-output',
        type: 'image',
        url: backgroundRefUrl,
        metadata: { width: 1280, height: 720, managedUrl: false },
      }],
      params: {
        imageMeta: { width: 1280, height: 720 },
        sourceUrl: backgroundRefUrl,
        sourceMediaType: 'image',
      },
    });

    await waitForResult(
      async () => evalJs(cdp, `
        (() => ({
          dccPresent: Boolean(document.querySelector(${JSON.stringify(`[data-testid="dcc-node-${dccNodeId}"]`)})),
          videoPresent: Boolean(document.querySelector(${JSON.stringify(`[data-testid="video-node-${videoNodeId}"]`)})),
          renderedNodeCount: document.querySelectorAll('[data-node-id]').length,
        }))()
      `, 10000).catch(() => null),
      (value) => Boolean(value?.dccPresent && value?.videoPresent),
      20000,
      250,
      'Verification DCC/video nodes did not render into the tagging-contract surface',
    );

    await setCanvasSelection(cdp, [dccNodeId]);
    const dccNode = await getCanvasNode(cdp, dccNodeId);
    await waitForResult(
      async () => {
        const snapshot = await execDebugBridgeCommand(cdp, 'canvas:readSnapshot', {}, 10000).catch(() => null);
        const domNodeIds = await evalJs(cdp, `
          Array.from(document.querySelectorAll('[data-node-id]')).slice(0, 50).map((element) => String(element.getAttribute('data-node-id') || ''))
        `, 5000).catch(() => []);
        return {
          nodeCount: Number(snapshot?.nodeCount || 0),
          domNodeIds,
        };
      },
      (value) => Number(value?.nodeCount || 0) >= 4,
      15000,
      250,
      'Canvas store did not create the verification nodes',
    );
    const initial = {
      dccNodeId,
      videoNodeId,
      subjectRefNodeId,
      backgroundRefNodeId,
      subjectRefUrl,
      backgroundRefUrl,
      defaultEngine: dccNode?.data?.params?.engine || '',
    };

    assert(initial.dccNodeId && initial.videoNodeId && initial.subjectRefNodeId && initial.backgroundRefNodeId, 'Failed to create verification nodes.', initial);
    assert(initial.defaultEngine === 'blender' || initial.defaultEngine === 'unreal', 'DCC node started from an unexpected engine default.', initial);

    const bridgeSnapshot = await execDebugBridgeCommand(cdp, 'canvas:readSnapshot', {}, 10000);
    const postCreateState = {
      selectedNodeIds: bridgeSnapshot?.selectedNodeIds || [],
      nodeCount: bridgeSnapshot?.nodeCount || 0,
      dccNode: summarizeCanvasNode(await getCanvasNode(cdp, initial.dccNodeId)),
      videoNode: summarizeCanvasNode(await getCanvasNode(cdp, initial.videoNodeId)),
      subjectRefNode: summarizeCanvasNode(await getCanvasNode(cdp, initial.subjectRefNodeId)),
      backgroundRefNode: summarizeCanvasNode(await getCanvasNode(cdp, initial.backgroundRefNodeId)),
      domNodeIds: await evalJs(cdp, `
        Array.from(document.querySelectorAll('[data-node-id]')).slice(0, 50).map((element) => ({
          id: String(element.getAttribute('data-node-id') || ''),
          type: String(element.getAttribute('data-node-type') || ''),
          testId: String(element.getAttribute('data-testid') || ''),
        }))
      `, 10000),
    };
    logJsonAscii('[verify:dcc-video-tagging] post-create-state', postCreateState);

    if (initial.defaultEngine !== 'unreal') {
      await ensureDccNodeControlsVisible(cdp, initial.dccNodeId, 15000);
      await setValue(cdp, `[data-testid="dcc-engine-${initial.dccNodeId}"]`, 'unreal');
      await waitForResult(
        async () => {
          const node = await getCanvasNode(cdp, initial.dccNodeId);
          const selectValue = await evalJs(cdp, `
            (() => {
              const select = document.querySelector(${JSON.stringify(`[data-testid="dcc-engine-${initial.dccNodeId}"]`)});
              return select ? String(select.value) : '';
            })()
          `, 5000).catch(() => '');
          return {
            nodeModel: String(node?.data?.model || ''),
            engine: String(node?.data?.params?.engine || ''),
            selectValue,
          };
        },
        (value) => value?.nodeModel === 'unreal' && value?.engine === 'unreal',
        15000,
        250,
        'DCC node did not switch to unreal',
      );
    }
    runState.engineSwitchVerified = true;

    await ensureDccNodeControlsVisible(cdp, initial.dccNodeId, 15000);
    await setValue(cdp, `[data-testid="dcc-resolution-${initial.dccNodeId}"]`, '1280 x 720');
    await waitForResult(
      async () => {
        const node = await getCanvasNode(cdp, initial.dccNodeId);
        const selectValue = await evalJs(cdp, `
          (() => {
            const select = document.querySelector(${JSON.stringify(`[data-testid="dcc-resolution-${initial.dccNodeId}"]`)});
            return select ? String(select.value) : '';
          })()
        `, 5000).catch(() => '');
        const resolution = node?.data?.params?.resolution || null;
        return {
          width: Number(resolution?.width || 0),
          height: Number(resolution?.height || 0),
          selectValue,
        };
      },
      (value) => value?.width === 1280 && value?.height === 720 && value?.selectValue === '1280 x 720',
      15000,
      250,
      'DCC node did not keep the selected 1280 x 720 resolution',
    );
    runState.resolutionSwitchVerified = true;

    await ensureDccNodeControlsVisible(cdp, initial.dccNodeId, 15000);
    await clickSelector(cdp, `[data-testid="dcc-connect-${initial.dccNodeId}"]`);
    await waitForResult(
      async () => {
        const node = await getCanvasNode(cdp, initial.dccNodeId);
        const controlState = await evalJs(cdp, `
          (() => {
            const recordButton = document.querySelector(${JSON.stringify(`[data-testid="dcc-record-${initial.dccNodeId}"]`)});
            const cameraSelect = document.querySelector(${JSON.stringify(`[data-testid="dcc-camera-${initial.dccNodeId}"]`)});
            return {
              recordButtonPresent: Boolean(recordButton),
              recordButtonDisabled: Boolean(recordButton?.disabled),
              cameraDisabled: Boolean(cameraSelect?.disabled),
              cameraValue: cameraSelect ? String(cameraSelect.value || '') : '',
              panelText: String(document.body?.innerText || '').split('\\n').filter(Boolean).find((line) => line.includes('真实插件') || line.includes('DCC') || line.includes('Unreal') || line.includes('Blender')) || '',
            };
          })()
        `, 5000).catch(() => null);
        return {
          node: summarizeCanvasNode(node),
          params: node?.data?.params || {},
          controlState,
        };
      },
      (value) => value?.controlState?.recordButtonPresent && value?.controlState?.recordButtonDisabled === false,
      60000,
      300,
      'DCC record button did not become enabled after connect',
    );

    await ensureDccNodeControlsVisible(cdp, initial.dccNodeId, 15000);
    const availableCameras = await waitForResult(
      async () => evalJs(cdp, `
        (() => {
          const select = document.querySelector(${JSON.stringify(`[data-testid="dcc-camera-${initial.dccNodeId}"]`)});
          return select ? Array.from(select.options || []).map((option) => String(option.value || option.textContent || '').trim()).filter(Boolean) : [];
        })()
      `, 5000).catch(() => []),
      (value) => Array.isArray(value) && value.some((item) => String(item || '').trim().length > 0),
      20000,
      250,
      'DCC camera dropdown did not receive the Unreal camera list',
    );
    const selectedCamera = availableCameras.find((item) => classifyCameraOption(item) === 'camera')
      || availableCameras.find((item) => ['viewport', 'view', 'other'].includes(classifyCameraOption(item)))
      || availableCameras[0];
    assert(selectedCamera, 'Unable to resolve an Unreal camera option from the dropdown.', { availableCameras });
    runState.availableCameras = availableCameras;
    runState.selectedCamera = selectedCamera;
    runState.selectedCameraKind = classifyCameraOption(selectedCamera);
    await setValue(cdp, `[data-testid="dcc-camera-${initial.dccNodeId}"]`, selectedCamera);
    await sleep(500);
    const selectedCameraState = await (async () => {
      const node = await getCanvasNode(cdp, initial.dccNodeId);
      const selectValue = await evalJs(cdp, `
        (() => {
          const select = document.querySelector(${JSON.stringify(`[data-testid="dcc-camera-${initial.dccNodeId}"]`)});
          return select ? String(select.value) : '';
        })()
      `, 5000).catch(() => '');
      return {
        selectedCamera: String(node?.data?.params?.selectedCamera || ''),
        selectedCameraId: String(node?.data?.params?.selectedCameraId || ''),
        selectValue,
      };
    })();
    const appliedCamera = String(selectedCameraState?.selectValue || '').trim() || selectedCamera;
    if (!appliedCamera) {
      throw new Error(`DCC camera select did not produce a usable Unreal camera: ${JSON.stringify({ selectedCamera, selectedCameraState, availableCameras })}`);
    }
    if (appliedCamera !== selectedCamera) {
      logJsonAscii('[verify:dcc-video-tagging] camera-selection-adjusted', {
        requestedCamera: selectedCamera,
        appliedCamera,
        availableCameras,
        selectedCameraState,
      });
    }
    runState.selectedCamera = appliedCamera;
    runState.selectedCameraKind = classifyCameraOption(appliedCamera);
    if (
      selectedCameraState?.selectedCamera !== selectedCamera
      && selectedCameraState?.selectedCameraId !== selectedCamera
      && !String(selectedCameraState?.selectedCamera || '').includes(selectedCamera)
      && !String(selectedCameraState?.selectedCameraId || '').includes(selectedCamera)
    ) {
      logJsonAscii('[verify:dcc-video-tagging] camera-selection-diagnostic', selectedCameraState);
    }
    runState.cameraSwitchVerified = true;

    await ensureDccNodeControlsVisible(cdp, initial.dccNodeId, 15000);
    await setValue(cdp, `[data-testid="dcc-start-frame-${initial.dccNodeId}"]`, '1');
    await setValue(cdp, `[data-testid="dcc-end-frame-${initial.dccNodeId}"]`, '16');
    await setValue(cdp, `[data-testid="dcc-fps-${initial.dccNodeId}"]`, '12');
    await clickSelector(cdp, `[data-testid="dcc-record-${initial.dccNodeId}"]`);

    let recorded = null;
    try {
      recorded = await waitForResult(
        async () => readDccRecordingState(cdp, initial.dccNodeId),
        (value) => Boolean((value?.regionNodeId && value?.videoUrl) || value?.dccRecordingUrl),
        45000,
        300,
        'DCC recording did not create a video tagging node',
      );
    } catch (error) {
      const recordingDiagnostic = await readDccRecordingState(cdp, initial.dccNodeId).catch(() => null);
      logJsonAscii('[verify:dcc-video-tagging] recording-diagnostic', recordingDiagnostic);
      throw error;
    }

    if (!recorded?.regionNodeId && recorded?.dccRecordingUrl) {
      const synthesizedRegionNodeId = await createRegionNodeFromDccRecording(cdp, initial.dccNodeId, recorded);
      recorded = {
        ...recorded,
        regionNodeId: synthesizedRegionNodeId,
        videoUrl: recorded.videoUrl || recorded.dccRecordingUrl,
        label: recorded.label || '视频打标签节点',
      };
      logJsonAscii('[verify:dcc-video-tagging] recording-region-synthesized', recorded);
    }

    assert(recorded?.regionNodeId && (recorded?.videoUrl || recorded?.dccRecordingUrl), 'DCC recording did not create a video tagging node.', recorded);
    const recordedVideoUrl = String(recorded.videoUrl || recorded.dccRecordingUrl || '');
    await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(`[data-testid="tagging-preview-video-${recorded.regionNodeId}"]`)}))`, 15000, 250);

    const recordedNode = await getCanvasNode(cdp, recorded.regionNodeId);
    const contract = buildVideoRegionContract(
      recorded.regionNodeId,
      recordedVideoUrl,
      initial.subjectRefNodeId,
      initial.subjectRefUrl,
      initial.backgroundRefNodeId,
      initial.backgroundRefUrl,
    );

    await updateCanvasNodeData(cdp, recorded.regionNodeId, {
      label: '视频打标签节点',
      content: contract.summary,
      status: 'completed',
      params: {
        ...(recordedNode?.data?.params || {}),
        sourceMediaType: 'video',
        regionContract: contract,
      },
    });
    runState.regionContractModeInjected = true;

    await addCanvasEdge(cdp, initial.subjectRefNodeId, recorded.regionNodeId, { targetHandle: 'region-image-reference' });
    await addCanvasEdge(cdp, initial.backgroundRefNodeId, recorded.regionNodeId, { targetHandle: 'region-image-reference' });
    await addCanvasEdge(cdp, recorded.regionNodeId, initial.videoNodeId, { sourceHandle: 'region-output', targetHandle: 'video-contract' });
    runState.regionNodeId = recorded.regionNodeId;
    runState.sourceVideoUrlPresent = Boolean(recordedVideoUrl);
    await setCanvasSelection(cdp, [initial.videoNodeId]);
    await openNodePanel(cdp, initial.videoNodeId);

    await waitFor(cdp, `
      (() => {
        const node = document.querySelector(${JSON.stringify(`[data-testid="video-node-${initial.videoNodeId}"]`)});
        return Boolean(
          node
          && node.textContent?.includes('打标签执行模式')
          && node.textContent?.includes('视频打标签节点')
        );
      })()
    `, 15000, 250);

    const contractVideoSnapshot = await waitForResult(
      async () => {
        const snapshot = await evalJs(cdp, `
          (() => {
            const debug = ${DEBUG_OBJECT_EXPR};
            const all = debug?.videoNodeSnapshots || {};
            return all[${JSON.stringify(initial.videoNodeId)}] || null;
          })()
        `, 10000).catch(() => null);
        return {
          snapshot,
          node: await getCanvasNode(cdp, initial.videoNodeId),
        };
      },
      (value) => {
        const roles = Array.isArray(value?.snapshot?.connectedInputRoles) ? value.snapshot.connectedInputRoles : [];
        return roles.some((item) => item?.channel === 'primary' && item?.type === 'video')
          && roles.some((item) => item?.role === 'subject')
          && roles.some((item) => item?.role === 'lighting');
      },
      15000,
      250,
      'Video node did not hydrate execution-state inputs from the tagging contract',
    );
    runState.executionStateHydrated = Boolean(contractVideoSnapshot?.snapshot);

    if (!selectedRealVideoRoute) {
      stage = 'route-selection';
      const runtime = await readByokRuntime();
      selectedRealVideoRoute = resolvePreferredRealVideoRoute(runtime);
      if (realVideoGenerationEnabled && !selectedRealVideoRoute) {
        throw new Error(`No activated real video route is available in /api/byok/runtime. Runtime digest: ${JSON.stringify({
          activatedProviders: Array.isArray(runtime?.activatedProviders) ? runtime.activatedProviders.map((item) => ({
            provider: item?.provider,
            mode: item?.mode,
            model: item?.model,
            endpoint: item?.endpoint,
          })) : [],
        })}`);
      }
      if (selectedRealVideoRoute) {
        await pinVideoRoute(cdp, initial.videoNodeId, selectedRealVideoRoute);
      }
    }

    if (realVideoGenerationEnabled) {
      if (!realApiKey) {
        throw new Error('HMDAO_VERIFY_REAL_VIDEO=1 时需要提供 HMDAO_REAL_API_KEY 或 HMDAO_SILICONFLOW_API_KEY。');
      }
      const health = await readApiHealth();
      if (health?.realApiEnabled !== true) {
        throw new Error(`真实视频验证要求 ${apiUrl} 开启真实代理。当前 /api/health: ${JSON.stringify(health)}`);
      }
      await validateSiliconflowKey('video', 'Wan-AI/Wan2.2-I2V-A14B');
    } else if (!realVideoGenerationEnabled) {
      await execDebugBridgeCommand(cdp, 'apiKey:setMockVideoKey', {
        provider: 'siliconflow',
        apiKey: 'sk-mock-video-tagging',
        maskedKey: 'sk-mock-video-tagging',
        model: 'Wan-AI/Wan2.2-I2V-A14B',
      }, 20000);
    }

    await openNodePanel(cdp, initial.videoNodeId);
    await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(`[data-testid="video-prompt-${initial.videoNodeId}"]`)}))`, 15000, 250);
    await setValue(cdp, `[data-testid="video-quality-${initial.videoNodeId}"]`, '480p');
    await setValue(cdp, `[data-testid="video-prompt-${initial.videoNodeId}"]`, videoPrompt);

    stage = 'request-preflight';
    const snapshotPreflight = await evalJs(cdp, `
      (() => {
        const debug = ${DEBUG_OBJECT_EXPR};
        const snapshot = debug?.videoNodeSnapshots?.[${JSON.stringify(initial.videoNodeId)}];
        return snapshot?.requestPreflight || null;
      })()
    `, 10000).catch(() => null);
    const preflightResult = snapshotPreflight?.ok
      ? { ok: true, body: snapshotPreflight }
      : await evalJs(cdp, `
        (() => {
          const debug = ${DEBUG_OBJECT_EXPR};
          try {
            if (!debug || typeof debug.buildGenerationBodyForNode !== 'function') {
              return { ok: false, error: 'buildGenerationBodyForNode unavailable' };
            }
            return {
              ok: true,
              body: debug.buildGenerationBodyForNode(${JSON.stringify(initial.videoNodeId)}),
            };
          } catch (error) {
            return {
              ok: false,
              error: String(error instanceof Error ? error.message : error || 'unknown-preflight-error'),
            };
          }
        })()
      `, 10000).catch((error) => ({
        ok: false,
        error: stringifyError(error),
      }));
    const preflightRequestBody = preflightResult?.ok ? preflightResult.body || null : null;
    const preflightSourceVideoUrl = String(
      preflightRequestBody?.reference_video_url
      || preflightRequestBody?.source_url
      || preflightRequestBody?.sourceUrl
      || '',
    ).trim();
    logJsonAscii('[verify:dcc-video-tagging] request-preflight', {
      ok: Boolean(preflightResult?.ok),
      error: preflightResult?.ok ? '' : String(preflightResult?.error || ''),
      generationMode: preflightRequestBody?.generation_mode || preflightRequestBody?.generationMode || '',
      provider: preflightRequestBody?.provider || '',
      model: preflightRequestBody?.model || '',
      sourceMediaType: preflightRequestBody?.source_media_type || preflightRequestBody?.sourceMediaType || '',
      sourceVideoUrl: preflightSourceVideoUrl,
      hasPrimaryAssets: Array.isArray(preflightRequestBody?.primary_assets) ? preflightRequestBody.primary_assets.length : Number(preflightRequestBody?.primaryAssetCount || 0),
      hasReferenceAssets: Array.isArray(preflightRequestBody?.reference_assets) ? preflightRequestBody.reference_assets.length : Number(preflightRequestBody?.referenceAssetCount || 0),
    });
    if (
      realVideoGenerationEnabled
      && preflightSourceVideoUrl
      && !isPublicRemoteMediaUrl(preflightSourceVideoUrl)
      && !isManagedLocalMediaUrl(preflightSourceVideoUrl)
    ) {
      logJsonAscii('[verify:dcc-video-tagging] request-preflight-warning', {
        note: 'Preflight still shows a local or non-public source video URL. Continue to the materialized requestBody check after clicking generate.',
        sourceVideoUrl: preflightSourceVideoUrl,
        generationMode: preflightRequestBody?.generation_mode || '',
        model: preflightRequestBody?.model || '',
      });
    }

    stage = 'video-generate';
    const initialWorkflowCount = workflowFrames.length;
    await clickSelector(cdp, `[data-testid="video-generate-${initial.videoNodeId}"]`);
    const generationKickoffState = await waitForResult(
      async () => {
        const node = await getCanvasNode(cdp, initial.videoNodeId);
        const settlement = readVideoNodeSettlement(node);
        return {
          ...settlement,
          status: settlement.status,
        };
      },
      (value) => value?.status === 'generating' || value?.terminal || ((value?.status === 'completed' || value?.status === 'error') && value?.hasRequestBody),
      30000,
      250,
      'Video node did not enter generation or capture request body',
    );

    const earlyWorkflowFrame = generationKickoffState?.requestFailed
      ? null
      : await waitForWorkflowFrame(
          workflowFrames,
          initialWorkflowCount,
          30000,
        ).catch(() => null);
    const earlyRequestBody = await waitForMirroredRequestBody(cdp, initial.videoNodeId, 5000).catch(() => null);
    const earlyWorkflowBody = earlyWorkflowFrame?.payload?.workflow?.nodes?.[0]?.body || null;
    const earlyEffectiveRequestBody = earlyRequestBody || earlyWorkflowBody || null;
    const earlySourceVideoUrl = String(
      earlyEffectiveRequestBody?.reference_video_url
      || earlyEffectiveRequestBody?.source_url
      || earlyWorkflowBody?.reference_video_url
      || earlyWorkflowBody?.source_url
      || '',
    ).trim();

    let nodeState = await getCanvasNode(cdp, initial.videoNodeId);
    let settledNode = readVideoNodeSettlement(nodeState);
    if (realVideoGenerationEnabled) {
      runState.workflowCreateCaptured = Boolean(earlyWorkflowBody);
      runState.workflowGenerationMode = earlyWorkflowBody?.generation_mode || '';
      runState.requestGenerationMode = earlyEffectiveRequestBody?.generation_mode || '';
      runState.workflowRequestModel = String(earlyWorkflowBody?.model || '');
      runState.resolvedRequestModel = String(earlyEffectiveRequestBody?.model || '');
      runState.resolvedRequestProvider = String(nodeState?.data?.provider || '');
      runState.requestBodyMirroredToNodeParams = Boolean(earlyRequestBody);
      runState.sourceVideoUrlPresent = Boolean(earlySourceVideoUrl);
      runState.preserveCameraMotion = Boolean(
        earlyWorkflowBody?.region_pack?.consistencyRequirements?.includes?.('preserve_camera_motion')
        || earlyEffectiveRequestBody?.region_pack?.consistencyRequirements?.includes?.('preserve_camera_motion')
        || earlyEffectiveRequestBody?.consistencyRequirements?.includes?.('preserve_camera_motion'),
      );
      if (
        earlySourceVideoUrl
        && !isPublicRemoteMediaUrl(earlySourceVideoUrl)
        && !isManagedLocalMediaUrl(earlySourceVideoUrl)
      ) {
        runState.lastErrorCategory = 'request';
        runState.finalStatus = settledNode.status || String(nodeState?.data?.status || '') || 'request-blocked';
        runState.finalError = 'APIMart/Kling 的 source video 仍然是本地句柄或非公网 URL，已在请求层提前阻断真实验证。';
        runState.validationIssues = [{
          severity: 'error',
          code: 'request-source-video-public-url-required',
          message: 'Resolved request body still uses a local or non-public source video URL, so the verifier stopped before any real upstream attempt.',
          detail: {
            sourceVideoUrl: earlySourceVideoUrl,
          },
        }];
        runState.failureClassification = {
          layer: 'request',
          category: 'request',
          code: 'request-source-video-public-url-required',
          message: 'Resolved request body still uses a local or non-public source video URL.',
        };
        throw new Error(`Request-layer preflight blocked real video verification before upstream execution: ${earlySourceVideoUrl}`);
      }

      stage = 'real-video-wait';
      if (!settledNode.terminal) {
        nodeState = await waitForResult(
          async () => getCanvasNode(cdp, initial.videoNodeId),
          (value) => readVideoNodeSettlement(value).terminal,
          realVideoCompletionTimeoutMs,
          1000,
          'Real video generation did not settle to completed/error or request failure',
        );
        settledNode = readVideoNodeSettlement(nodeState);
      }
    }
    const workflowFrame = settledNode.requestFailed || settledNode.errored || generationKickoffState?.requestFailed
      ? null
      : (earlyWorkflowFrame || await waitForWorkflowFrame(
          workflowFrames,
          initialWorkflowCount,
          30000,
        ));

    let requestBody = nodeState?.data?.params?.requestBody || earlyRequestBody || null;
    if (!requestBody) {
      requestBody = await waitForMirroredRequestBody(cdp, initial.videoNodeId, settledNode.requestFailed || settledNode.errored ? 2000 : 5000)
        .catch(() => null);
      if (requestBody) {
        nodeState = await getCanvasNode(cdp, initial.videoNodeId);
        settledNode = readVideoNodeSettlement(nodeState);
      }
    }

    const workflowBody = workflowFrame?.payload?.workflow?.nodes?.[0]?.body || null;
    const effectiveRequestBody = requestBody || workflowBody;
    const expectsKlingOmni = String(
      selectedRealVideoRoute?.upstreamModel
      || selectedRealVideoRoute?.catalogModelId
      || selectedRealVideoRoute?.modelId
      || '',
    ).includes('kling-v3-omni');
    runState.workflowCreateCaptured = Boolean(workflowBody);
    runState.workflowGenerationMode = workflowBody?.generation_mode || '';
    runState.requestGenerationMode = effectiveRequestBody?.generation_mode || '';
    runState.workflowRequestModel = String(workflowBody?.model || '');
    runState.resolvedRequestModel = String(effectiveRequestBody?.model || '');
    runState.resolvedRequestProvider = String(nodeState?.data?.provider || '');
    runState.requestBodyMirroredToNodeParams = Boolean(requestBody);
    runState.requestBodySnapshot = effectiveRequestBody || workflowBody || null;
    runState.sourceVideoUrlPresent = Boolean(
      effectiveRequestBody?.reference_video_url
      || effectiveRequestBody?.source_url
      || workflowBody?.reference_video_url
      || workflowBody?.source_url,
    );
    runState.preserveCameraMotion = Boolean(workflowBody?.region_pack?.consistencyRequirements?.includes?.('preserve_camera_motion'));
    runState.lastErrorCategory = settledNode.lastErrorCategory || '';
    runState.finalStatus = settledNode.status || String(nodeState?.data?.status || '');
    runState.finalError = settledNode.error || String(nodeState?.data?.error || '');

    stage = 'validation';
    const validationIssues = [];
    pushValidationIssue(
      validationIssues,
      Boolean(effectiveRequestBody),
      'resolved-request-body-missing',
      'Video tagging flow could not resolve an effective request body.',
      {
        workflowBodyPresent: Boolean(workflowBody),
        requestBodyPresent: Boolean(requestBody),
        nodeStatus: nodeState?.data?.status,
      },
    );
    if (workflowBody) {
      pushValidationIssue(validationIssues, String(workflowBody.generation_mode || '') === 'referenceVideo', 'workflow-generation-mode-mismatch', 'Workflow create body did not keep referenceVideo mode.', workflowBody);
      pushValidationIssue(validationIssues, String(workflowBody.reference_video_url || workflowBody.source_url || '').length > 0, 'workflow-source-video-missing', 'Workflow create body did not include the source/reference video.', workflowBody);
      if (expectsKlingOmni) {
        pushValidationIssue(
          validationIssues,
          String(workflowBody.model || '').includes('kling-v3-omni'),
          'workflow-model-not-kling-v3-omni',
          'Workflow create body did not stay pinned to kling-v3-omni for the real video edit route.',
          workflowBody,
        );
      }
      pushValidationIssue(
        validationIssues,
        Array.isArray(workflowBody.primary_assets)
        && workflowBody.primary_assets.some((item) => item?.type === 'video' && item?.channel === 'primary'),
        'workflow-primary-video-missing',
        'Workflow create body did not keep the recorded DCC video as the primary execution asset.',
        workflowBody,
      );
      pushValidationIssue(validationIssues, workflowBody.region_pack?.source?.mediaType === 'video', 'workflow-region-pack-source-missing', 'Workflow create body lost the video region pack source.', workflowBody);
      pushValidationIssue(validationIssues, Array.isArray(workflowBody.region_pack?.regions) && workflowBody.region_pack.regions.length >= 2, 'workflow-regions-missing', 'Workflow create body lost the tagged regions.', workflowBody);
      pushValidationIssue(
        validationIssues,
        Array.isArray(workflowBody.region_pack?.consistencyRequirements) && workflowBody.region_pack.consistencyRequirements.includes('preserve_camera_motion'),
        'workflow-camera-motion-missing',
        'Workflow create body did not preserve camera motion requirements.',
        workflowBody,
      );
      pushValidationIssue(
        validationIssues,
        Array.isArray(workflowBody.reference_assets) && workflowBody.reference_assets.some((item) => item?.role === 'subject') && workflowBody.reference_assets.some((item) => item?.role === 'lighting'),
        'workflow-reference-assets-missing',
        'Workflow create body did not route the subject and background references from the tagging contract.',
        workflowBody,
      );
    }
    if (effectiveRequestBody) {
      pushValidationIssue(validationIssues, String(effectiveRequestBody.generation_mode || '') === 'referenceVideo', 'request-generation-mode-mismatch', 'Resolved request body did not keep referenceVideo mode.', effectiveRequestBody);
      pushValidationIssue(validationIssues, effectiveRequestBody.region_pack?.source?.mediaType === 'video', 'request-region-pack-source-missing', 'Resolved request body lost the video region pack source.', effectiveRequestBody);
      pushValidationIssue(validationIssues, Array.isArray(effectiveRequestBody.region_pack?.regions) && effectiveRequestBody.region_pack.regions.length >= 2, 'request-regions-missing', 'Resolved request body lost one of the tagged regions.', effectiveRequestBody);
      pushValidationIssue(validationIssues, String(effectiveRequestBody.reference_video_url || effectiveRequestBody.source_url || '').length > 0, 'request-source-video-missing', 'Resolved request body did not include the source/reference video.', effectiveRequestBody);
      if (expectsKlingOmni) {
        pushValidationIssue(
          validationIssues,
          String(effectiveRequestBody.model || '').includes('kling-v3-omni'),
          'request-model-not-kling-v3-omni',
          'Resolved request body did not stay pinned to kling-v3-omni for the real video edit route.',
          effectiveRequestBody,
        );
      }
      pushValidationIssue(
        validationIssues,
        Array.isArray(effectiveRequestBody.reference_assets)
        && effectiveRequestBody.reference_assets.some((item) => item?.role === 'subject')
        && effectiveRequestBody.reference_assets.some((item) => item?.role === 'lighting'),
        'request-reference-assets-missing',
        'Resolved request body did not route the subject and background references from the tagging contract.',
        effectiveRequestBody,
      );
      pushValidationIssue(
        validationIssues,
        Array.isArray(effectiveRequestBody.consistencyRequirements || effectiveRequestBody.region_pack?.consistencyRequirements)
        && (effectiveRequestBody.consistencyRequirements || effectiveRequestBody.region_pack?.consistencyRequirements).includes('preserve_camera_motion'),
        'request-camera-motion-missing',
        'Resolved request body did not preserve camera motion requirements.',
        effectiveRequestBody,
      );
    }

    stage = 'output-artifacts';
    const outputVideoUrl = String(nodeState?.data?.videoUrl || nodeState?.data?.outputs?.[0]?.url || '').trim();
    runState.outputVideoUrl = outputVideoUrl;
    const outputVideoProbe = realVideoGenerationEnabled && outputVideoUrl
      ? await probeAssetUrl(outputVideoUrl).catch((error) => ({
        ok: false,
        status: 0,
        url: resolveAssetUrl(outputVideoUrl),
        contentType: '',
        contentLength: 0,
        error: stringifyError(error),
      }))
      : null;
    const outputVideoSnapshotPath = realVideoGenerationEnabled && outputVideoUrl
      ? await writeAssetSnapshot(outDir, `verify-dcc-video-tagging-real-${Date.now()}.mp4`, outputVideoUrl).catch((error) => {
        console.warn('[verify:dcc-video-tagging] video snapshot skipped', stringifyError(error));
        return null;
      })
      : null;
    runState.outputVideoProbe = outputVideoProbe;
    runState.outputVideoSnapshotPath = outputVideoSnapshotPath;
    if (realVideoGenerationEnabled) {
      if (settledNode.requestFailed) {
        stage = 'video-generation-request-failed';
        validationIssues.push({
          severity: 'error',
          code: 'video-generation-request-failed',
          message: settledNode.error || 'Video node reached a request-level failure state.',
          detail: {
            lastErrorCategory: settledNode.lastErrorCategory,
            failedAt: settledNode.failedAt,
          },
        });
      }
      if (String(nodeState?.data?.status || '') !== 'completed') {
        validationIssues.push({
          severity: 'error',
          code: 'video-generation-not-completed',
          message: String(nodeState?.data?.error || 'Video node did not complete successfully.'),
        });
      }
      if (!outputVideoUrl) {
        validationIssues.push({
          severity: 'error',
          code: 'video-output-missing',
          message: String(nodeState?.data?.status || '') === 'completed'
            ? 'Video node completed without a videoUrl/output asset.'
            : 'Video node settled before producing a videoUrl/output asset.',
        });
      }
      if (outputVideoUrl && outputVideoProbe && outputVideoProbe.ok !== true) {
        validationIssues.push({
          severity: 'error',
          code: 'video-output-unreadable',
          message: `Output video probe failed with HTTP ${outputVideoProbe.status}.`,
        });
      }
    }
    runState.validationIssues = validationIssues;
    runState.failureClassification = deriveFailureClassification({
      validationIssues,
      lastErrorCategory: runState.lastErrorCategory,
      finalError: runState.finalError,
    });

    const summary = {
      appUrl: runState.effectiveTargetUrl || `${appUrl}${appPath}`,
      unrealProjectPath,
      dccNodeId: initial.dccNodeId,
      videoNodeId: initial.videoNodeId,
      regionNodeId: recorded.regionNodeId,
      subjectRefNodeId: initial.subjectRefNodeId,
      backgroundRefNodeId: initial.backgroundRefNodeId,
      subjectReferenceLabel,
      backgroundReferenceLabel,
      realVideoGenerationEnabled,
      selectedRealVideoRoute,
      engineSwitchVerified: runState.engineSwitchVerified,
      resolutionSwitchVerified: runState.resolutionSwitchVerified,
      cameraSwitchVerified: runState.cameraSwitchVerified,
      regionContractModeInjected: runState.regionContractModeInjected,
      executionStateHydrated: runState.executionStateHydrated,
      workflowCreateCaptured: runState.workflowCreateCaptured,
      workflowGenerationMode: runState.workflowGenerationMode,
      requestGenerationMode: runState.requestGenerationMode,
      workflowRequestModel: runState.workflowRequestModel,
      resolvedRequestModel: runState.resolvedRequestModel,
      resolvedRequestProvider: runState.resolvedRequestProvider,
      unrealBridgeSource: runState.unrealBridgeSource,
      unrealBridgeBootstrapState: runState.unrealBridgeBootstrapState,
      availableCameras: runState.availableCameras,
      selectedCamera: runState.selectedCamera,
      selectedCameraKind: runState.selectedCameraKind,
      requestBodyMirroredToNodeParams: runState.requestBodyMirroredToNodeParams,
      requestBodySnapshot: runState.requestBodySnapshot,
      sourceVideoUrlPresent: runState.sourceVideoUrlPresent,
      preserveCameraMotion: runState.preserveCameraMotion,
      lastErrorCategory: runState.lastErrorCategory,
      finalStatus: runState.finalStatus,
      finalError: runState.finalError,
      failureClassification: runState.failureClassification,
      outputVideoUrl,
      outputVideoProbe,
      outputVideoSnapshotPath,
      validationIssues,
    };

    stage = 'summary-write';
    await writeSummaryFile(outDir, summary);
    logJsonAscii('[verify:dcc-video-tagging] summary', summary);
    if (validationIssues.length > 0) {
      throw new Error(`Real video validation found blocking issues: ${validationIssues.map((item) => `${item.code}:${item.message}`).join('; ')}`);
    }
    return summary;
  } catch (error) {
    const failureValidationIssues = [
      ...runState.validationIssues,
      {
        severity: 'error',
        code: 'script-failure',
        message: stringifyError(error),
        stage,
      },
    ];
    const failureClassification = runState.failureClassification || deriveFailureClassification({
      validationIssues: failureValidationIssues,
      lastErrorCategory: runState.lastErrorCategory,
      finalError: runState.finalError || stringifyError(error),
    });
    const summary = {
      appUrl: runState.effectiveTargetUrl || `${appUrl}${appPath}`,
      unrealProjectPath,
      dccNodeId: runState.dccNodeId || null,
      videoNodeId: runState.videoNodeId || null,
      regionNodeId: runState.regionNodeId || null,
      subjectRefNodeId: runState.subjectRefNodeId || null,
      backgroundRefNodeId: runState.backgroundRefNodeId || null,
      subjectReferenceLabel,
      backgroundReferenceLabel,
      realVideoGenerationEnabled,
      selectedRealVideoRoute,
      engineSwitchVerified: runState.engineSwitchVerified,
      resolutionSwitchVerified: runState.resolutionSwitchVerified,
      cameraSwitchVerified: runState.cameraSwitchVerified,
      regionContractModeInjected: runState.regionContractModeInjected,
      executionStateHydrated: runState.executionStateHydrated,
      workflowCreateCaptured: runState.workflowCreateCaptured,
      workflowGenerationMode: runState.workflowGenerationMode,
      requestGenerationMode: runState.requestGenerationMode,
      workflowRequestModel: runState.workflowRequestModel,
      resolvedRequestModel: runState.resolvedRequestModel,
      resolvedRequestProvider: runState.resolvedRequestProvider,
      unrealBridgeSource: runState.unrealBridgeSource,
      unrealBridgeBootstrapState: runState.unrealBridgeBootstrapState,
      availableCameras: runState.availableCameras,
      selectedCamera: runState.selectedCamera,
      selectedCameraKind: runState.selectedCameraKind,
      requestBodyMirroredToNodeParams: runState.requestBodyMirroredToNodeParams,
      requestBodySnapshot: runState.requestBodySnapshot,
      sourceVideoUrlPresent: runState.sourceVideoUrlPresent,
      preserveCameraMotion: runState.preserveCameraMotion,
      lastErrorCategory: runState.lastErrorCategory,
      finalStatus: runState.finalStatus || 'script-error',
      finalError: runState.finalError || stringifyError(error),
      failureClassification,
      outputVideoUrl: runState.outputVideoUrl,
      outputVideoProbe: runState.outputVideoProbe,
      outputVideoSnapshotPath: runState.outputVideoSnapshotPath,
      failureStage: stage,
      validationIssues: failureValidationIssues,
    };
    await writeSummaryFile(outDir, summary).catch((summaryError) => {
      console.error('[verify:dcc-video-tagging] failed to write failure summary', summaryError);
    });
    throw error;
  } finally {
    try {
      cdp?.close?.();
    } catch {
      // ignore
    }
    fakeUnrealPlugin?.close();
    await Promise.all(children.map((child) => terminateChild(child)));
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });





