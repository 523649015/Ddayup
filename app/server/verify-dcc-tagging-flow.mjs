import { spawn } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';

const browserCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

const chromePath = browserCandidates.find((item) => existsSync(item));
const chromePort = Number(process.env.HMDAO_VERIFY_CHROME_PORT || 9455);
const apiUrl = process.env.HMDAO_API_URL || 'http://127.0.0.1:8792';
const appUrl = process.env.HMDAO_APP_URL || 'http://127.0.0.1:3010';
const appPath = '/?skipLaunch=1&hmdao-demo=reference-consistency&hmdao-demo-reset=1';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function start(command, args, cwd, children) {
  const child = spawn(command, args, {
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

async function ensureService(url, startFn) {
  if (await isHttpReady(url)) return null;
  const child = startFn();
  await waitForHttp(url, 30000);
  return child;
}

async function connectCdp() {
  await waitForHttp(`http://127.0.0.1:${chromePort}/json/version`, 30000);
  const targets = await (await fetch(`http://127.0.0.1:${chromePort}/json/list`)).json();
  const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
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
  const ok = await evalJs(cdp, `
    (() => {
      const element = document.querySelector(${safeSelector});
      if (!element) return false;
      element.click();
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

function buildRegionContract(regionNodeId, sourceUrl, carRef, lightRef) {
  const now = Date.now();
  return {
    version: 'region-contract-v1',
    source: {
      nodeId: regionNodeId,
      nodeLabel: 'Blender 截图打标签节点',
      url: sourceUrl,
      mediaType: 'image',
    },
    regions: [
      {
        regionId: 'region-subject-car',
        label: '标签 1',
        geometry: { rect: { x: 0.28, y: 0.3, width: 0.34, height: 0.34 } },
        targetKind: 'subject',
        editIntent: 'replace_subject',
        description: '把这里替换成参考图里的老爷车主体，保持主体细节，只做自然落位与融合。',
        strictness: 'exact_transfer',
        bindingMode: 'reference_required',
        bindings: [
          {
            slotId: 'slot-car',
            sourceNodeId: carRef.nodeId,
            sourceAssetUrl: carRef.url,
            sourceMediaType: carRef.mediaType,
            sourceLabel: carRef.label,
            bindingRole: 'subject-reference',
            preserveDetail: true,
            weight: 90,
          },
        ],
        enabled: true,
      },
      {
        regionId: 'region-background-light',
        label: '标签 2',
        geometry: { rect: { x: 0.02, y: 0.02, width: 0.96, height: 0.96 } },
        targetKind: 'background',
        editIntent: 'background_fuse',
        description: '背景替换为参考光影图的氛围层，只影响背景和环境光影，和主体自然融合。',
        strictness: 'harmonize_only',
        bindingMode: 'reference_required',
        bindings: [
          {
            slotId: 'slot-light',
            sourceNodeId: lightRef.nodeId,
            sourceAssetUrl: lightRef.url,
            sourceMediaType: lightRef.mediaType,
            sourceLabel: lightRef.label,
            bindingRole: 'background-reference',
            preserveDetail: false,
            weight: 72,
          },
        ],
        enabled: true,
      },
    ],
    bindings: [],
    executionPlan: {
      orderedRegionIds: ['region-subject-car', 'region-background-light'],
      strategy: 'region-contract-v1',
    },
    consistencyRequirements: ['preserve_composition', 'preserve_subject_detail', 'background_depth_consistency'],
    fallbackPolicy: 'reject',
    summary: '图片打标签 · 2 个标签 · 含精确迁移 · 含背景融合 · 标签 1 / 标签 2',
    generatedAt: now,
  };
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

async function main() {
  const cwd = process.cwd();
  const children = [];
  if (!chromePath) throw new Error('Chrome or Edge not found.');

  try {
    await ensureService(`${apiUrl}/api/health`, () => start('node', ['server/hmdao-api.mjs'], cwd, children));
    await ensureService(`${appUrl}/`, () => start('npm.cmd', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '3010'], cwd, children));

    const userDataDir = path.resolve(cwd, 'artifacts', 'dcc-tagging-flow-profile');
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

    const cdp = await connectCdp();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 960,
      deviceScaleFactor: 1,
      mobile: false,
    });

    await cdp.send('Page.navigate', { url: `${appUrl}${appPath}` });
    await waitFor(cdp, 'document.readyState === "complete"', 30000, 250);
    await waitFor(cdp, `Boolean(window.__HMDAO_DEBUG__?.canvasStore && window.__HMDAO_DEBUG__?.readCanvasSnapshot)`, 30000, 250);

    const dccNodeId = await evalJs(cdp, `
      (() => {
        const store = window.__HMDAO_DEBUG__.canvasStore.getState();
        const nodeId = store.addNode('dcc', { x: 1360, y: 120 });
        store.setSelectedNodeIds([nodeId]);
        return nodeId;
      })()
    `, 10000);

    await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(`[data-testid="dcc-connect-${dccNodeId}"]`)}))`, 15000, 250);
    await clickSelector(cdp, `[data-testid="dcc-connect-${dccNodeId}"]`);
    await waitFor(cdp, `(() => { const el = document.querySelector(${JSON.stringify(`[data-testid="dcc-capture-${dccNodeId}"]`)}); return Boolean(el && !el.disabled); })()`, 20000, 300);

    await clickSelector(cdp, `[data-testid="dcc-capture-${dccNodeId}"]`);
    const regionState = await waitFor(cdp, `
      (() => {
        const store = window.__HMDAO_DEBUG__.canvasStore.getState();
        const nodes = store.canvas?.nodes || [];
        const regionNode = [...nodes].reverse().find((node) => node.type === 'region' && node.data?.params?.sourceNodeId === ${JSON.stringify(dccNodeId)});
        if (!regionNode || !regionNode.data?.imageUrl) return null;
        return {
          regionNodeId: regionNode.id,
          previewUrl: regionNode.data.imageUrl,
        };
      })()
    `, 30000, 300);

    await waitFor(cdp, `(() => {
      const preview = document.querySelector(${JSON.stringify(`[data-testid="tagging-preview-image-${regionState.regionNodeId}"]`)});
      return Boolean(preview && preview.getAttribute('src'));
    })()`, 15000, 250);

    const mappedState = await evalJs(cdp, `
      (() => {
        const store = window.__HMDAO_DEBUG__.canvasStore.getState();
        const nodes = store.canvas?.nodes || [];
        const targetImage = nodes.find((node) => String(node.data?.label || '').includes('图片保构图换主体'));
        const carRef = nodes.find((node) => String(node.data?.label || '').includes('图片主体参考 / 老爷车产品'));
        const lightRef = nodes.find((node) => String(node.data?.label || '').includes('图片全能参考 / 光影氛围'));
        const regionNode = nodes.find((node) => node.id === ${JSON.stringify(regionState.regionNodeId)});
        if (!targetImage || !carRef || !lightRef || !regionNode) {
          return { ok: false, reason: 'missing-required-nodes' };
        }
        const contract = ${JSON.stringify(buildRegionContract('__REGION__', '__SOURCE__', { nodeId: '__CAR__', url: '__CAR_URL__', mediaType: 'image', label: '__CAR_LABEL__' }, { nodeId: '__LIGHT__', url: '__LIGHT_URL__', mediaType: 'image', label: '__LIGHT_LABEL__' }))}
        contract.source.nodeId = regionNode.id;
        contract.source.url = String(regionNode.data?.imageUrl || '');
        contract.bindings = contract.regions.flatMap((region) => region.bindings);
        contract.regions[0].bindings[0].sourceNodeId = carRef.id;
        contract.regions[0].bindings[0].sourceAssetUrl = String(carRef.data?.imageUrl || '');
        contract.regions[0].bindings[0].sourceLabel = String(carRef.data?.label || '老爷车主体参考');
        contract.regions[1].bindings[0].sourceNodeId = lightRef.id;
        contract.regions[1].bindings[0].sourceAssetUrl = String(lightRef.data?.imageUrl || '');
        contract.regions[1].bindings[0].sourceLabel = String(lightRef.data?.label || '光影背景参考');
        store.updateNodeData(regionNode.id, {
          params: {
            ...(regionNode.data?.params || {}),
            sourceMediaType: 'image',
            regionContract: contract,
          },
          content: contract.summary,
          status: 'completed',
        });
        store.addEdge(regionNode.id, targetImage.id, { sourceHandle: 'region-output', targetHandle: 'image-contract' });
        store.setSelectedNodeIds([targetImage.id]);
        return {
          ok: true,
          regionNodeId: regionNode.id,
          targetImageNodeId: targetImage.id,
          carRefId: carRef.id,
          lightRefId: lightRef.id,
        };
      })()
    `.replaceAll('"__REGION__"', JSON.stringify(regionState.regionNodeId))
      .replaceAll('"__SOURCE__"', JSON.stringify(regionState.previewUrl))
      .replaceAll('"__CAR__"', JSON.stringify(''))
      .replaceAll('"__CAR_URL__"', JSON.stringify(''))
      .replaceAll('"__CAR_LABEL__"', JSON.stringify(''))
      .replaceAll('"__LIGHT__"', JSON.stringify(''))
      .replaceAll('"__LIGHT_URL__"', JSON.stringify(''))
      .replaceAll('"__LIGHT_LABEL__"', JSON.stringify('')), 10000);

    if (!mappedState?.ok) {
      throw new Error(`Failed to map region contract: ${JSON.stringify(mappedState)}`);
    }

    await waitFor(cdp, `(() => {
      const node = document.querySelector(${JSON.stringify(`[data-testid="image-node-${mappedState.targetImageNodeId}"]`)});
      return Boolean(node && node.textContent && node.textContent.includes('打标签执行模式'));
    })()`, 15000, 250);

    const contractSummary = await evalJs(cdp, `
      (() => {
        const node = document.querySelector(${JSON.stringify(`[data-testid="image-node-${mappedState.targetImageNodeId}"]`)});
        return node ? node.textContent : '';
      })()
    `, 10000);

    const imageKeyReady = await evalJs(cdp, `
      (() => {
        const store = window.__HMDAO_DEBUG__?.apiKeyStore?.getState?.();
        const keys = Object.values(store?.keys || {});
        return keys.some((entry) => entry && entry.mode === 'image' && entry.status !== 'expired' && (entry.apiKey || entry.metadataOnly));
      })()
    `, 10000).catch(() => false);

    let generationAttempt = { attempted: false, status: 'skipped', reason: 'no-image-key' };
    if (imageKeyReady) {
      await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(`[data-testid="image-prompt-${mappedState.targetImageNodeId}"]`)}))`, 15000, 250);
      await setValue(cdp, `[data-testid="image-prompt-${mappedState.targetImageNodeId}"]`, '保留当前 DCC 构图，让老爷车自然落在主体区域，背景融合参考光影，输出写实广告级新素材。');
      await clickSelector(cdp, `[data-testid="image-generate-${mappedState.targetImageNodeId}"]`);
      const nextStatus = await waitFor(cdp, `
        (() => {
          const store = window.__HMDAO_DEBUG__.canvasStore.getState();
          const node = (store.canvas?.nodes || []).find((item) => item.id === ${JSON.stringify(mappedState.targetImageNodeId)});
          const status = String(node?.data?.status || '');
          if (!status || status === 'idle') return '';
          return status;
        })()
      `, 30000, 300);
      generationAttempt = { attempted: true, status: nextStatus, reason: '' };
    }

    const summary = {
      appUrl: `${appUrl}${appPath}`,
      dccNodeId,
      regionNodeId: regionState.regionNodeId,
      targetImageNodeId: mappedState.targetImageNodeId,
      previewUrlPresent: Boolean(regionState.previewUrl),
      contractModeVisible: contractSummary.includes('打标签执行模式'),
      contractSummaryIncludesCar: contractSummary.includes('标签 1'),
      contractSummaryIncludesBackground: contractSummary.includes('标签 2'),
      generationAttempt,
    };

    const outDir = path.resolve(cwd, 'artifacts');
    await fs.mkdir(outDir, { recursive: true });
    const outFile = path.join(outDir, 'verify-dcc-tagging-flow-summary.json');
    await fs.writeFile(outFile, JSON.stringify(summary, null, 2), 'utf8');
    console.log(JSON.stringify(summary, null, 2));
    cdp.close();
    return summary;
  } finally {
    await Promise.all(children.map((child) => terminateChild(child)));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
