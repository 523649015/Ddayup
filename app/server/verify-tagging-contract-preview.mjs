import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';

const browserCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

const chromePath = browserCandidates.find((item) => existsSync(item));
const chromePort = Number(process.env.HMDAO_VERIFY_CHROME_PORT || 9463);
const apiUrl = process.env.HMDAO_API_URL || 'http://127.0.0.1:8792';
const appUrl = process.env.HMDAO_APP_URL || 'http://127.0.0.1:3000';
const demoUrl = `${appUrl}/?hmdao-demo=tagging-contract&hmdao-demo-reset=1&skipLaunch=1&verifyRun=${Date.now()}`;

const baseImagePath = String(process.env.HMDAO_VERIFY_BASE_IMAGE || '').trim();
const subjectImagePath = String(process.env.HMDAO_VERIFY_SUBJECT_IMAGE || '').trim();
const lightingImagePath = String(process.env.HMDAO_VERIFY_LIGHTING_IMAGE || '').trim();
const requestedPrompt = String(
  process.env.HMDAO_VERIFY_TAGGING_PROMPT
  || '保留当前 DCC 摄像机截图构图和透视，把主体区域替换成参考老爷车，背景区域融合参考光影氛围，输出写实广告级新素材。',
).trim();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message, extra) {
  if (condition) return;
  throw new Error(extra === undefined ? message : `${message} ${JSON.stringify(extra)}`);
}

function log(message, extra) {
  const prefix = `[verify-tagging ${new Date().toISOString()}]`;
  if (extra === undefined) {
    console.log(`${prefix} ${message}`);
    return;
  }
  console.log(`${prefix} ${message}`, extra);
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

async function ensureService(name, url, startFn) {
  if (await isHttpReady(url)) {
    log(`Reusing running ${name}`);
    return null;
  }
  log(`Starting ${name}...`);
  const child = startFn();
  await waitForHttp(url, 30000);
  log(`${name} is ready`);
  return child;
}

async function connectCdp(port) {
  await waitForHttp(`http://127.0.0.1:${port}/json/version`, 30000);
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
    method: 'PUT',
  })).json();
  if (!target) throw new Error('No CDP page target available.');

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  });

  return {
    onMessage(handler) {
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (!message.id) {
          handler(message);
        }
      });
    },
    async send(method, params = {}) {
      const callId = ++id;
      socket.send(JSON.stringify({ id: callId, method, params }));
      return new Promise((resolve, reject) => pending.set(callId, { resolve, reject }));
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

async function clickSelector(cdp, selector) {
  const safeSelector = JSON.stringify(selector);
  const ok = await evalJs(cdp, `(() => {
    const element = document.querySelector(${safeSelector});
    if (!element) return false;
    element.click();
    return true;
  })()`, 10000);
  if (!ok) throw new Error(`Element not found: ${selector}`);
}

async function pointerClickSelector(cdp, selector) {
  const safeSelector = JSON.stringify(selector);
  const rect = await evalJs(cdp, `(() => {
    const element = document.querySelector(${safeSelector});
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return {
      x: box.left + (box.width / 2),
      y: box.top + (box.height / 2),
    };
  })()`, 10000);
  if (!rect) throw new Error(`Element not found: ${selector}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, button: 'none' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
}

function imageNodeSelector(nodeId) {
  const safeId = String(nodeId || '').trim();
  return `[data-testid="image-node-${safeId}"], [data-node-id="${safeId}"][data-node-type="image"]`;
}

async function setValue(cdp, selector, value) {
  const safeSelector = JSON.stringify(selector);
  const safeValue = JSON.stringify(String(value));
  const ok = await evalJs(cdp, `(() => {
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
  })()`, 10000);
  if (!ok) throw new Error(`Unable to set value for ${selector}`);
}

async function screenshot(cdp, filePath) {
  const result = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
  });
  await fs.writeFile(filePath, Buffer.from(result.data, 'base64'));
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

function mimeTypeForPath(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'application/octet-stream';
}

async function fileToBase64(filePath) {
  const buffer = await fs.readFile(filePath);
  return buffer.toString('base64');
}

function buildRegionContract({ baseNodeId, baseUrl, subjectNodeId, subjectUrl, lightingNodeId, lightingUrl }) {
  const now = Date.now();
  return {
    version: 'region-contract-v1',
    source: {
      nodeId: baseNodeId,
      nodeLabel: 'DCC 构图基底 / 主体.png',
      url: baseUrl,
      mediaType: 'image',
      width: 1280,
      height: 720,
    },
    regions: [
      {
        regionId: 'region-subject-veteran-car',
        label: '主体老爷车',
        geometry: {
          rect: { x: 0.28, y: 0.24, width: 0.34, height: 0.5 },
        },
        targetKind: 'subject',
        editIntent: 'replace_subject',
        description: '把这里替换成参考图里的老爷车，保留车身比例、镀铬反射、轮毂和漆面细节，只做落位与边缘融合。',
        strictness: 'exact_transfer',
        bindingMode: 'reference_required',
        bindings: [{
          slotId: 'slot-subject-veteran-car',
          sourceNodeId: subjectNodeId,
          sourceAssetUrl: subjectUrl,
          sourceMediaType: 'image',
          bindingRole: 'subject-reference',
          preserveDetail: true,
          weight: 96,
          sourceLabel: '主体参考 / 老爷车',
          description: '主体替换参考',
        }],
        enabled: true,
      },
      {
        regionId: 'region-background-lighting',
        label: '背景光影',
        geometry: {
          rect: { x: 0.02, y: 0.04, width: 0.96, height: 0.9 },
        },
        targetKind: 'background',
        editIntent: 'background_fuse',
        description: '背景替换为参考光影图的氛围和布光，只影响背景层，保持主体透视、景深和空间关系一致。',
        strictness: 'harmonize_only',
        bindingMode: 'reference_required',
        bindings: [{
          slotId: 'slot-background-lighting',
          sourceNodeId: lightingNodeId,
          sourceAssetUrl: lightingUrl,
          sourceMediaType: 'image',
          bindingRole: 'background-reference',
          preserveDetail: true,
          weight: 88,
          sourceLabel: '背景光影参考',
          description: '背景氛围参考',
        }],
        enabled: true,
      },
    ],
    bindings: [],
    executionPlan: {
      orderedRegionIds: ['region-subject-veteran-car', 'region-background-lighting'],
      strategy: 'region-contract-v1',
    },
    consistencyRequirements: [
      'preserve_composition',
      'preserve_subject_detail',
      'background_depth_consistency',
      'reference_detail_lock',
    ],
    fallbackPolicy: 'reject',
    summary: '图片打标签 · 2 个标签 · 主体老爷车 / 背景光影',
    generatedAt: now,
  };
}

async function ensureImageKeyReady(cdp) {
  let ready = await evalJs(cdp, `(() => {
    const store = window.__HMDAO_DEBUG__?.apiKeyStore?.getState?.();
    const keys = Object.values(store?.keys || {});
    return keys.some((entry) => entry && entry.mode === 'image' && entry.status !== 'expired' && (entry.apiKey || entry.metadataOnly));
  })()`, 10000).catch(() => false);

  if (ready) return { ready: true, injected: false };

  await evalJs(cdp, `(() => {
    const apiKeyStore = window.__HMDAO_DEBUG__?.apiKeyStore?.getState?.();
    if (!apiKeyStore?.setKey) return false;
    void apiKeyStore.setKey({
      provider: 'openai',
      maskedKey: '平台代管',
      mode: 'image',
      model: 'gpt-image-2',
      source: 'platform',
      metadataOnly: true,
    });
    return true;
  })()`, 10000).catch(() => false);

  await sleep(600);
  ready = await evalJs(cdp, `(() => {
    const store = window.__HMDAO_DEBUG__?.apiKeyStore?.getState?.();
    const keys = Object.values(store?.keys || {});
    return keys.some((entry) => entry && entry.mode === 'image' && entry.status !== 'expired' && (entry.apiKey || entry.metadataOnly));
  })()`, 10000).catch(() => false);
  return { ready, injected: ready };
}

async function registerLocalMediaHandle(cdp, filePath) {
  const base64 = await fileToBase64(filePath);
  const mimeType = mimeTypeForPath(filePath);
  return evalJs(cdp, `(() => {
    const debug = window.__HMDAO_DEBUG__;
    if (typeof debug?.registerLocalMedia !== 'function') return '';
    const binary = atob(${JSON.stringify(base64)});
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    const blob = new Blob([bytes], { type: ${JSON.stringify(mimeType)} });
    return debug.registerLocalMedia(blob);
  })()`, 30000);
}

async function injectRealTaggingAssets(cdp, handles) {
  const contract = buildRegionContract(handles);
  return evalJs(cdp, `(() => {
    const debug = window.__HMDAO_DEBUG__;
    const store = debug?.canvasStore?.getState?.();
    if (!store) return { ok: false, reason: 'missing-canvas-store' };

    const nodes = store.canvas?.nodes || [];
    const edges = store.canvas?.edges || [];
    const imageNode = nodes.find((node) => node.type === 'image' && edges.some((edge) => edge.target === node.id && String(edge.targetHandle || '') === 'image-contract'));
    if (!imageNode) return { ok: false, reason: 'missing-target-image-node' };

    const contractEdge = edges.find((edge) => edge.target === imageNode.id && String(edge.targetHandle || '') === 'image-contract');
    const regionNode = contractEdge ? nodes.find((node) => node.id === contractEdge.source && node.type === 'region') : null;
    if (!regionNode) return { ok: false, reason: 'missing-region-node' };

    const baseEdge = edges.find((edge) => edge.target === regionNode.id && String(edge.targetHandle || '') === 'region-main');
    const baseNode = baseEdge ? nodes.find((node) => node.id === edgeSource(baseEdge)) : null;
    const seedContract = regionNode.data?.params?.regionContract;
    const subjectNode = nodes.find((node) => node.id === seedContract?.regions?.[0]?.bindings?.[0]?.sourceNodeId);
    const lightingNode = nodes.find((node) => node.id === seedContract?.regions?.[1]?.bindings?.[0]?.sourceNodeId);

    if (!baseNode || !subjectNode || !lightingNode) {
      return { ok: false, reason: 'missing-seeded-reference-nodes' };
    }

    const updateImageNode = (nodeId, label, url) => {
      store.updateNodeData(nodeId, {
        label,
        status: 'completed',
        imageUrl: url,
        params: {
          ...(((nodes.find((node) => node.id === nodeId)?.data?.params) || {})),
          imageMeta: { width: 1280, height: 720 },
        },
        outputs: [{
          id: 'verify-local-image',
          type: 'image',
          url,
          metadata: {
            source: 'verify-tagging-contract-preview',
            managedUrl: true,
            originalUrl: url,
            width: 1280,
            height: 720,
          },
        }],
      });
    };

    updateImageNode(baseNode.id, 'DCC 构图基底 / 主体.png', ${JSON.stringify(handles.baseUrl)});
    updateImageNode(subjectNode.id, '主体参考 / 老爷车', ${JSON.stringify(handles.subjectUrl)});
    updateImageNode(lightingNode.id, '背景光影参考', ${JSON.stringify(handles.lightingUrl)});

    const contract = ${JSON.stringify(contract)};
    contract.source.nodeId = baseNode.id;
    contract.regions[0].bindings[0].sourceNodeId = subjectNode.id;
    contract.regions[1].bindings[0].sourceNodeId = lightingNode.id;
    contract.bindings = contract.regions.flatMap((region) => Array.isArray(region.bindings) ? region.bindings : []);
    store.updateNodeData(regionNode.id, {
      label: '打标签节点 / 主体老爷车 + 背景光影',
      status: 'completed',
      imageUrl: ${JSON.stringify(handles.baseUrl)},
      content: contract.summary,
      outputs: [{
        id: 'verify-region-pack',
        type: 'text',
        url: 'region-pack://verify-real-assets',
        metadata: {
          regionContract: contract,
        },
      }],
      params: {
        ...((regionNode.data?.params) || {}),
        sourceMediaType: 'image',
        regionContract: contract,
      },
    });

    store.updateNodeData(imageNode.id, {
      label: '图片节点 / 读取打标签合同',
      status: 'idle',
      error: undefined,
      imageUrl: '',
      outputs: [],
      prompt: '',
      model: 'gpt-image-2',
      provider: 'openai',
      params: {
        ...((imageNode.data?.params) || {}),
        contractMode: true,
        regionContract: contract,
        contractSummary: contract.summary,
        regionContractSourceNodeId: regionNode.id,
        lastError: undefined,
        lastErrorStage: undefined,
        lastErrorCategory: undefined,
      },
    });

    if (typeof store.setSelectedNodeIds === 'function') {
      store.setSelectedNodeIds([imageNode.id]);
    }

    return {
      ok: true,
      baseNodeId: baseNode.id,
      subjectNodeId: subjectNode.id,
      lightingNodeId: lightingNode.id,
      regionNodeId: regionNode.id,
      imageNodeId: imageNode.id,
      regionSummary: contract.summary,
      regionLabels: contract.regions.map((item) => item.label),
    };

    function edgeSource(edge) {
      return edge?.source || '';
    }
  })()`, 30000);
}

async function readImageRuntimeState(cdp, imageNodeId) {
  return evalJs(cdp, `(() => {
    const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
    const node = (store?.canvas?.nodes || []).find((item) => item.id === ${JSON.stringify(imageNodeId)});
    const params = node?.data?.params || {};
    const outputs = Array.isArray(node?.data?.outputs) ? node.data.outputs : [];
    return {
      status: String(node?.data?.status || ''),
      error: String(node?.data?.error || ''),
      prompt: String(node?.data?.prompt || ''),
      executionPrompt: typeof params.executionPrompt === 'string' ? params.executionPrompt : '',
      requestPrompt: typeof params.requestPrompt === 'string' ? params.requestPrompt : '',
      provider: String(node?.data?.provider || ''),
      model: String(node?.data?.model || ''),
      imageUrl: String(node?.data?.imageUrl || outputs[0]?.url || ''),
      outputCount: outputs.length,
      contractMode: Boolean(params.contractMode),
      contractSummary: String(params.contractSummary || ''),
      lastError: typeof params.lastError === 'string' ? params.lastError : '',
      lastErrorStage: typeof params.lastErrorStage === 'string' ? params.lastErrorStage : '',
      lastErrorCategory: typeof params.lastErrorCategory === 'string' ? params.lastErrorCategory : '',
      activeRunId: typeof params.activeRunId === 'string' ? params.activeRunId : '',
      requestBody: params.requestBody || null,
      regionContractSourceNodeId: typeof params.regionContractSourceNodeId === 'string' ? params.regionContractSourceNodeId : '',
      routeText: document.querySelector(${JSON.stringify(`[data-testid="image-backend-route-status-${imageNodeId}"]`)})?.textContent || '',
      nodeText: document.querySelector(${JSON.stringify(`[data-testid="image-node-${imageNodeId}"]`)})?.textContent || '',
      hasPrompt: Boolean(document.querySelector(${JSON.stringify(`[data-testid="image-prompt-${imageNodeId}"]`)})),
      hasGenerate: Boolean(document.querySelector(${JSON.stringify(`[data-testid="image-generate-${imageNodeId}"]`)})),
    };
  })()`, 10000);
}

async function main() {
  if (!chromePath) throw new Error('Chrome or Edge not found.');

  const cwd = process.cwd();
  const children = [];
  const artifactsDir = path.resolve(cwd, 'artifacts');
  await fs.mkdir(artifactsDir, { recursive: true });
  const userDataDir = path.join(artifactsDir, `verify-tagging-contract-preview-profile-${Date.now()}`);
  const screenshotPath = path.join(artifactsDir, 'verify-tagging-contract-preview.png');
  const summaryPath = path.join(artifactsDir, 'verify-tagging-contract-preview-summary.json');

  let cdp = null;
  try {
    await ensureService('API', `${apiUrl}/api/health`, () => start('node', ['server/hmdao-api.mjs'], cwd, children));
    await ensureService('UI', `${appUrl}/`, () => start('npm.cmd', ['run', 'serve:3000'], cwd, children));

    await fs.mkdir(userDataDir, { recursive: true });
    start(chromePath, [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--remote-allow-origins=*',
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${chromePort}`,
      'about:blank',
    ], cwd, children);

    cdp = await connectCdp(chromePort);
    const browserConsoleLogs = [];
    const browserExceptions = [];
    const browserNetworkFailures = [];
    const browserRequests = new Map();
    cdp.onMessage((message) => {
      if (message.method === 'Network.requestWillBeSent') {
        browserRequests.set(String(message.params?.requestId || ''), String(message.params?.request?.url || ''));
        if (browserRequests.size > 300) {
          const firstKey = browserRequests.keys().next().value;
          if (firstKey) browserRequests.delete(firstKey);
        }
      }
      if (message.method === 'Runtime.consoleAPICalled') {
        browserConsoleLogs.push({
          type: message.params?.type || '',
          args: Array.isArray(message.params?.args)
            ? message.params.args.map((item) => item?.value ?? item?.description ?? '')
            : [],
          timestamp: Number(message.params?.timestamp || 0),
          stack: message.params?.stackTrace?.callFrames?.slice?.(0, 6) || [],
        });
        if (browserConsoleLogs.length > 120) browserConsoleLogs.shift();
      }
      if (message.method === 'Runtime.exceptionThrown') {
        browserExceptions.push({
          text: message.params?.exceptionDetails?.text || '',
          exception: message.params?.exceptionDetails?.exception?.description || '',
          url: message.params?.exceptionDetails?.url || '',
          lineNumber: Number(message.params?.exceptionDetails?.lineNumber || 0),
          columnNumber: Number(message.params?.exceptionDetails?.columnNumber || 0),
          stack: message.params?.exceptionDetails?.stackTrace?.callFrames?.slice?.(0, 8) || [],
        });
        if (browserExceptions.length > 80) browserExceptions.shift();
      }
      if (message.method === 'Log.entryAdded') {
        browserConsoleLogs.push({
          type: `log:${message.params?.entry?.level || ''}`,
          args: [message.params?.entry?.text || ''],
          url: message.params?.entry?.url || '',
          timestamp: Number(message.params?.entry?.timestamp || 0),
        });
        if (browserConsoleLogs.length > 120) browserConsoleLogs.shift();
      }
      if (message.method === 'Network.loadingFailed') {
        const requestId = String(message.params?.requestId || '');
        browserNetworkFailures.push({
          requestId,
          url: browserRequests.get(requestId) || '',
          blockedReason: message.params?.blockedReason || '',
          errorText: message.params?.errorText || '',
          type: message.params?.type || '',
          canceled: Boolean(message.params?.canceled),
        });
        if (browserNetworkFailures.length > 120) browserNetworkFailures.shift();
      }
    });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1680,
      height: 1200,
      deviceScaleFactor: 1,
      mobile: false,
    });

    await cdp.send('Page.navigate', { url: demoUrl });
    await waitFor(cdp, 'document.readyState === "complete"', 30000, 250);
    await waitFor(cdp, 'Boolean(window.__HMDAO_DEBUG__?.canvasStore)', 30000, 250);
    await evalJs(cdp, `(() => {
      const seed = window.__HMDAO_DEBUG__?.seedTaggingContractDemo;
      if (typeof seed !== 'function') return false;
      void seed({ resetCanvas: true });
      return true;
    })()`, 15000);
    await waitFor(cdp, `(() => {
      const snapshot = window.__HMDAO_DEBUG__?.readCanvasSnapshot?.();
      return Number(snapshot?.nodeCount || 0) >= 5 && Number(snapshot?.edgeCount || 0) >= 4;
    })()`, 30000, 250);

    const keyState = await ensureImageKeyReady(cdp);

    let injectedAssets = null;
    if (baseImagePath && subjectImagePath && lightingImagePath) {
      assert(existsSync(baseImagePath), 'Base image does not exist.', { baseImagePath });
      assert(existsSync(subjectImagePath), 'Subject image does not exist.', { subjectImagePath });
      assert(existsSync(lightingImagePath), 'Lighting image does not exist.', { lightingImagePath });

      const baseHandle = await registerLocalMediaHandle(cdp, baseImagePath);
      const subjectHandle = await registerLocalMediaHandle(cdp, subjectImagePath);
      const lightingHandle = await registerLocalMediaHandle(cdp, lightingImagePath);
      injectedAssets = await injectRealTaggingAssets(cdp, {
        baseNodeId: '',
        baseUrl: baseHandle,
        subjectNodeId: '',
        subjectUrl: subjectHandle,
        lightingNodeId: '',
        lightingUrl: lightingHandle,
      });
      assert(injectedAssets?.ok, 'Failed to inject real local assets into tagging demo.', injectedAssets);
      log('Injected real local assets into tagging demo.', injectedAssets);
    }

    const imageState = await waitFor(cdp, `(() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      const nodes = store?.canvas?.nodes || [];
      const edges = store?.canvas?.edges || [];
      const imageNode = nodes.find((node) => node.type === 'image' && edges.some((edge) => edge.target === node.id && String(edge.targetHandle || '') === 'image-contract'));
      if (!imageNode) return null;
      const contractEdge = edges.find((edge) => edge.target === imageNode.id && String(edge.targetHandle || '') === 'image-contract');
      const regionNode = contractEdge ? nodes.find((node) => node.id === contractEdge.source) : null;
      const contract = regionNode?.data?.params?.regionContract || null;
      return {
        imageNodeId: imageNode.id,
        regionNodeId: regionNode?.id || '',
        regionEdgeConnected: Boolean(contractEdge),
        regionSummary: typeof contract?.summary === 'string' ? contract.summary : '',
        regionLabels: Array.isArray(contract?.regions) ? contract.regions.map((item) => String(item?.label || '')).filter(Boolean) : [],
        regionDescriptions: Array.isArray(contract?.regions) ? contract.regions.map((item) => String(item?.description || '')).filter(Boolean) : [],
      };
    })()`, 30000, 250);

    const imageNodeSelectorText = imageNodeSelector(imageState.imageNodeId);
    const domNodeDiagnostics = await evalJs(cdp, `(() => ({
      renderedNodes: Array.from(document.querySelectorAll('[data-node-type],[data-id]')).slice(0, 80).map((element) => ({
        nodeId: element.getAttribute('data-node-id') || element.getAttribute('data-id') || '',
        nodeType: element.getAttribute('data-node-type') || '',
        testId: element.getAttribute('data-testid') || '',
      })),
      scripts: Array.from(document.querySelectorAll('script[src]')).map((element) => element.getAttribute('src') || ''),
      bodyText: document.body ? document.body.innerText.slice(0, 800) : '',
    }))()`, 15000).catch(() => null);
    log('Rendered DOM node diagnostics before image-node wait.', domNodeDiagnostics);
    try {
      await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(imageNodeSelectorText)}))`, 15000, 250);
      await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(`[data-testid="tagging-preview-image-${imageState.regionNodeId}"]`)}))`, 15000, 250);
    } catch (error) {
      await screenshot(cdp, screenshotPath);
      const failureSummary = {
        appUrl: demoUrl,
        apiUrl,
        localAssetsInjected: Boolean(injectedAssets?.ok),
        localAssetPaths: {
          baseImagePath,
          subjectImagePath,
          lightingImagePath,
        },
        imageKeyReady: keyState.ready,
        injectedMetadataKeys: keyState.injected,
        imageNodeId: imageState.imageNodeId,
        regionNodeId: imageState.regionNodeId,
        regionEdgeConnected: imageState.regionEdgeConnected,
        regionSummary: imageState.regionSummary,
        regionLabels: imageState.regionLabels,
        regionDescriptions: imageState.regionDescriptions,
        requestedPrompt,
        domNodeDiagnostics,
        browserConsoleLogs,
        browserExceptions,
        browserNetworkFailures,
        screenshotPath,
        fatalError: error instanceof Error ? error.message : String(error),
      };
      await fs.writeFile(summaryPath, JSON.stringify(failureSummary, null, 2), 'utf8');
      throw error;
    }

    await pointerClickSelector(cdp, imageNodeSelectorText);
    await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(`[data-testid="image-prompt-${imageState.imageNodeId}"]`)}))`, 15000, 250);
    await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(`[data-testid="image-generate-${imageState.imageNodeId}"]`)}))`, 15000, 250);
    await evalJs(cdp, `(() => {
      const debug = window.__HMDAO_DEBUG__;
      const storeApi = debug?.canvasStore;
      if (!storeApi || typeof storeApi.getState !== 'function' || typeof storeApi.setState !== 'function') return false;
      if (!window.__HMDAO_VERIFY_STORE_HOOK_INSTALLED__) {
        window.__HMDAO_VERIFY_STORE_HOOK_INSTALLED__ = true;
        window.__HMDAO_VERIFY_NODE_UPDATES__ = [];
        const originalSetState = storeApi.setState.bind(storeApi);
        storeApi.setState = (partial, replace, action) => {
          const beforeState = storeApi.getState();
          const beforeNode = (beforeState?.canvas?.nodes || []).find((node) => node.id === ${JSON.stringify(imageState.imageNodeId)});
          const stack = (() => {
            try {
              throw new Error('hmdao-store-setstate-trace');
            } catch (error) {
              return error instanceof Error ? String(error.stack || '') : '';
            }
          })();
          const result = originalSetState(partial, replace, action);
          try {
            const afterState = storeApi.getState();
            const afterNode = (afterState?.canvas?.nodes || []).find((node) => node.id === ${JSON.stringify(imageState.imageNodeId)});
            const beforeParams = beforeNode?.data?.params && typeof beforeNode.data.params === 'object' ? beforeNode.data.params : {};
            const afterParams = afterNode?.data?.params && typeof afterNode.data.params === 'object' ? afterNode.data.params : {};
            const statusChanged = String(beforeNode?.data?.status || '') !== String(afterNode?.data?.status || '');
            const runChanged = String(beforeParams.activeRunId || '') !== String(afterParams.activeRunId || '');
            const promptChanged = String(beforeNode?.data?.prompt || '') !== String(afterNode?.data?.prompt || '');
            if (!statusChanged && !runChanged && !promptChanged) return result;
            window.__HMDAO_VERIFY_NODE_UPDATES__.push({
              nodeId: ${JSON.stringify(imageState.imageNodeId)},
              at: Date.now(),
              beforeStatus: String(beforeNode?.data?.status || ''),
              afterStatus: String(afterNode?.data?.status || ''),
              beforePrompt: String(beforeNode?.data?.prompt || ''),
              afterPrompt: String(afterNode?.data?.prompt || ''),
              beforeRunId: String(beforeParams.activeRunId || ''),
              afterRunId: String(afterParams.activeRunId || ''),
              provider: String(afterNode?.data?.provider || ''),
              model: String(afterNode?.data?.model || ''),
              stack,
            });
            window.__HMDAO_VERIFY_NODE_UPDATES__ = window.__HMDAO_VERIFY_NODE_UPDATES__.slice(-80);
          } catch {}
          return result;
        };
      }
      return true;
    })()`, 15000).catch(() => false);

    const runtimeBeforeGenerate = await readImageRuntimeState(cdp, imageState.imageNodeId);
    const debugGenerationBody = await evalJs(cdp, `window.__HMDAO_DEBUG__?.buildGenerationBodyForNode?.(${JSON.stringify(imageState.imageNodeId)}) || null`, 15000).catch(() => null);
    await evalJs(cdp, `(() => {
      window.__HMDAO_GENERATION_TRACE__ = [];
      window.__HMDAO_IMAGE_SUBMIT_TRACE__ = [];
      window.__HMDAO_AI_PANEL_TRACE__ = [];
      return true;
    })()`, 15000).catch(() => false);
    await evalJs(cdp, `(() => {
      if (window.__HMDAO_VERIFY_ERROR_HOOK_INSTALLED__) return true;
      window.__HMDAO_VERIFY_ERROR_HOOK_INSTALLED__ = true;
      window.__HMDAO_VERIFY_RUNTIME_ERRORS__ = [];
      window.addEventListener('error', (event) => {
        window.__HMDAO_VERIFY_RUNTIME_ERRORS__.push({
          type: 'error',
          message: event?.message || '',
          source: event?.filename || '',
          lineno: Number(event?.lineno || 0),
          colno: Number(event?.colno || 0),
        });
      });
      window.addEventListener('unhandledrejection', (event) => {
        const reason = event?.reason;
        window.__HMDAO_VERIFY_RUNTIME_ERRORS__.push({
          type: 'unhandledrejection',
          message: reason instanceof Error ? reason.message : String(reason || ''),
          name: reason instanceof Error ? reason.name : '',
          stack: reason instanceof Error ? String(reason.stack || '') : '',
        });
      });
      return true;
    })()`, 15000).catch(() => false);
    await evalJs(cdp, `(() => {
      if (window.__HMDAO_VERIFY_FETCH_INSTALLED__) return true;
      window.__HMDAO_VERIFY_FETCH_INSTALLED__ = true;
      window.__HMDAO_VERIFY_FETCH_LOGS__ = [];
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const startedAt = Date.now();
        const target = args[0];
        const url = typeof target === 'string' ? target : (target && typeof target.url === 'string' ? target.url : String(target || ''));
        try {
          const response = await originalFetch(...args);
          window.__HMDAO_VERIFY_FETCH_LOGS__.push({
            url,
            ok: response.ok,
            status: response.status,
            elapsedMs: Date.now() - startedAt,
          });
          return response;
        } catch (error) {
          window.__HMDAO_VERIFY_FETCH_LOGS__.push({
            url,
            ok: false,
            status: 0,
            elapsedMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      };
      return true;
    })()`, 15000);

    await setValue(cdp, `[data-testid="image-prompt-${imageState.imageNodeId}"]`, requestedPrompt);
    await clickSelector(cdp, `[data-testid="image-generate-${imageState.imageNodeId}"]`);

    const enteredGenerating = await waitFor(cdp, `(() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      const node = (store?.canvas?.nodes || []).find((item) => item.id === ${JSON.stringify(imageState.imageNodeId)});
      return String(node?.data?.status || '') === 'generating';
    })()`, 20000, 200).catch(() => false);

    const finalState = await waitFor(cdp, `(() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      const node = (store?.canvas?.nodes || []).find((item) => item.id === ${JSON.stringify(imageState.imageNodeId)});
      if (!node) return null;
      const status = String(node.data?.status || '');
      if (status !== 'completed' && status !== 'error') return null;
      const params = node.data?.params || {};
      const outputs = Array.isArray(node.data?.outputs) ? node.data.outputs : [];
      return {
        status,
        error: String(node.data?.error || ''),
        imageUrl: String(node.data?.imageUrl || outputs[0]?.url || ''),
        outputCount: outputs.length,
        lastError: typeof params.lastError === 'string' ? params.lastError : '',
        lastErrorStage: typeof params.lastErrorStage === 'string' ? params.lastErrorStage : '',
        lastErrorCategory: typeof params.lastErrorCategory === 'string' ? params.lastErrorCategory : '',
        requestBody: params.requestBody || null,
      };
    })()`, 420000, 750).catch(() => null);

    const runtimeAfterGenerate = await readImageRuntimeState(cdp, imageState.imageNodeId);
    const generationTrace = await evalJs(cdp, `window.__HMDAO_GENERATION_TRACE__ || []`, 15000).catch(() => []);
    const imageSubmitTrace = await evalJs(cdp, `window.__HMDAO_IMAGE_SUBMIT_TRACE__ || []`, 15000).catch(() => []);
    const aiPanelTrace = await evalJs(cdp, `window.__HMDAO_AI_PANEL_TRACE__ || []`, 15000).catch(() => []);
    const runtimeErrors = await evalJs(cdp, `window.__HMDAO_VERIFY_RUNTIME_ERRORS__ || []`, 15000).catch(() => []);
    const nodeUpdateLogs = await evalJs(cdp, `window.__HMDAO_VERIFY_NODE_UPDATES__ || []`, 15000).catch(() => []);
    const fetchLogs = await evalJs(cdp, `window.__HMDAO_VERIFY_FETCH_LOGS__ || []`, 15000).catch(() => []);
    await screenshot(cdp, screenshotPath);

    const summary = {
      appUrl: demoUrl,
      apiUrl,
      localAssetsInjected: Boolean(injectedAssets?.ok),
      localAssetPaths: {
        baseImagePath,
        subjectImagePath,
        lightingImagePath,
      },
      imageKeyReady: keyState.ready,
      injectedMetadataKeys: keyState.injected,
      imageNodeId: imageState.imageNodeId,
      regionNodeId: imageState.regionNodeId,
      regionEdgeConnected: imageState.regionEdgeConnected,
      regionSummary: imageState.regionSummary,
      regionLabels: imageState.regionLabels,
      regionDescriptions: imageState.regionDescriptions,
      requestedPrompt,
      runtimeBeforeGenerate,
      debugGenerationBody,
      enteredGenerating,
      finalState,
      runtimeAfterGenerate,
      generationTrace,
      imageSubmitTrace,
      aiPanelTrace,
      runtimeErrors,
      nodeUpdateLogs,
      fetchLogs,
      browserConsoleLogs,
      browserExceptions,
      browserNetworkFailures,
      screenshotPath,
    };

    await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    if (cdp) cdp.close();
    await Promise.all(children.map((child) => terminateChild(child)));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
