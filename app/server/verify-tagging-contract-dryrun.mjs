import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const browserCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

const chromePath = browserCandidates.find((item) => existsSync(item));
const chromePort = Number(process.env.HMDAO_VERIFY_CHROME_PORT || 9468);
const appUrl = process.env.HMDAO_APP_URL || 'http://127.0.0.1:3036';
const demoUrl = `${appUrl}/?skipLaunch=1&hmdao-demo=tagging-contract&hmdao-demo-reset=1&verifyRun=${Date.now()}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message, extra) {
  if (condition) return;
  throw new Error(extra === undefined ? message : `${message} ${JSON.stringify(extra)}`);
}

async function waitForHttp(url, timeoutMs = 30000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
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

async function connectCdp(port) {
  await waitForHttp(`http://127.0.0.1:${port}/json/version`, 30000);
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
    method: 'PUT',
  })).json();
  assert(target?.webSocketDebuggerUrl, 'No CDP target available.');

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message || 'CDP command failed'));
    else resolve(message.result);
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

async function evalJs(cdp, expression, timeoutMs = 20000) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    timeout: timeoutMs,
  });
  if (result?.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Browser evaluation failed');
  }
  return result?.result?.value;
}

async function waitFor(cdp, expression, timeoutMs = 30000, intervalMs = 250) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await evalJs(cdp, expression, Math.min(timeoutMs, 5000)).catch(() => null);
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for expression: ${expression}`);
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
      windowsHide: true,
      shell: false,
    });
    killer.on('error', () => resolve());
    killer.on('exit', () => resolve());
  });
}

async function main() {
  assert(chromePath, 'Chrome or Edge not found.');
  await waitForHttp(`${appUrl}/`, 15000);

  const cwd = process.cwd();
  const artifactsDir = path.resolve(cwd, 'artifacts');
  await fs.mkdir(artifactsDir, { recursive: true });

  const summaryPath = path.join(artifactsDir, 'verify-tagging-contract-dryrun-summary.json');
  const screenshotPath = path.join(artifactsDir, 'verify-tagging-contract-dryrun.png');
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hmdao-tagging-dryrun-'));

  const chromeArgs = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${chromePort}`,
    'about:blank',
  ];

  const chrome = spawn(chromePath, chromeArgs, {
    cwd,
    stdio: ['ignore', 'ignore', 'ignore'],
    shell: false,
    windowsHide: true,
  });

  let cdp = null;
  try {
    cdp = await connectCdp(chromePort);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1600,
      height: 1200,
      deviceScaleFactor: 1,
      mobile: false,
    });

    await cdp.send('Page.navigate', { url: demoUrl });
    await waitFor(cdp, 'document.readyState === "complete"', 60000, 250);
    await waitFor(cdp, 'Boolean(window.__HMDAO_DEBUG__?.canvasStore && window.__HMDAO_DEBUG__?.seedTaggingContractDemo)', 60000, 250);

    const shellState = await evalJs(cdp, `(() => ({
      mark: document.documentElement.dataset.hmdaoDebugBridgeAttached || '',
      shellText: document.querySelector('[data-testid="tagging-contract-shell-status"]')?.textContent || '',
      bodyText: document.body?.innerText?.slice(0, 400) || '',
      hasBuildBody: typeof window.__HMDAO_DEBUG__?.buildGenerationBodyForNode === 'function',
      hasSeed: typeof window.__HMDAO_DEBUG__?.seedTaggingContractDemo === 'function',
      hasCanvasStore: Boolean(window.__HMDAO_DEBUG__?.canvasStore),
    }))()`, 10000);

    await evalJs(cdp, `window.__HMDAO_DEBUG__?.seedTaggingContractDemo?.({ resetCanvas: true })`, 20000);
    const snapshot = await waitFor(cdp, `(() => {
      const result = window.__HMDAO_DEBUG__?.readCanvasSnapshot?.();
      if (!result || Number(result.nodeCount || 0) < 5 || Number(result.edgeCount || 0) < 4) return null;
      return result;
    })()`, 30000, 250);

    const nodeDiagnostics = await evalJs(cdp, `(() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      const nodes = store?.canvas?.nodes || [];
      const edges = store?.canvas?.edges || [];
      const imageNode = nodes.find((node) => node.type === 'image' && edges.some((edge) => edge.target === node.id && String(edge.targetHandle || '') === 'image-contract'));
      const regionEdge = imageNode ? edges.find((edge) => edge.target === imageNode.id && String(edge.targetHandle || '') === 'image-contract') : null;
      const regionNode = regionEdge ? nodes.find((node) => node.id === regionEdge.source) : null;
      return {
        nodeIds: nodes.map((node) => ({ id: node.id, type: node.type, label: node.data?.label || '' })),
        imageNodeId: imageNode?.id || '',
        imageLabel: imageNode?.data?.label || '',
        regionNodeId: regionNode?.id || '',
        regionLabel: regionNode?.data?.label || '',
        regionSummary: regionNode?.data?.params?.regionContract?.summary || '',
      };
    })()`, 10000);

    assert(nodeDiagnostics?.imageNodeId, 'Failed to locate image-contract target image node.', nodeDiagnostics);

    const generationBody = await waitFor(cdp, `(() => {
      try {
        const imageNodeId = ${JSON.stringify(nodeDiagnostics.imageNodeId)};
        const body = window.__HMDAO_DEBUG__?.buildGenerationBodyForNode?.(imageNodeId);
        return body || null;
      } catch (error) {
        return null;
      }
    })()`, 45000, 500);

    const heuristics = await evalJs(cdp, `(() => {
      const body = window.__HMDAO_DEBUG__?.buildGenerationBodyForNode?.(${JSON.stringify(nodeDiagnostics.imageNodeId)});
      const regionContract = body?.region_pack || body?.regionContract || body?.params?.regionContract || body?.requestBody?.regionContract || null;
      const inputImages = Array.isArray(body?.input?.image_urls)
        ? body.input.image_urls
        : Array.isArray(body?.image_urls)
          ? body.image_urls
          : Array.isArray(body?.inputs)
            ? body.inputs
            : [];
      return {
        hasRegionContract: Boolean(regionContract),
        regionCount: Array.isArray(regionContract?.regions) ? regionContract.regions.length : 0,
        hasSubjectRegion: Boolean(Array.isArray(regionContract?.regions) && regionContract.regions.some((item) => item?.targetKind === 'subject')),
        hasBackgroundRegion: Boolean(Array.isArray(regionContract?.regions) && regionContract.regions.some((item) => item?.targetKind === 'background')),
        subjectBindingCount: Array.isArray(regionContract?.regions)
          ? regionContract.regions.filter((item) => item?.targetKind === 'subject').reduce((count, item) => count + (Array.isArray(item?.bindings) ? item.bindings.length : 0), 0)
          : 0,
        backgroundBindingCount: Array.isArray(regionContract?.regions)
          ? regionContract.regions.filter((item) => item?.targetKind === 'background').reduce((count, item) => count + (Array.isArray(item?.bindings) ? item.bindings.length : 0), 0)
          : 0,
        inputImageCount: Array.isArray(inputImages) ? inputImages.length : 0,
        referenceAssetRoles: Array.isArray(body?.reference_assets) ? body.reference_assets.map((item) => item?.role || '') : [],
        bodyKeys: body && typeof body === 'object' ? Object.keys(body) : [],
      };
    })()`, 10000);

    await screenshot(cdp, screenshotPath);

    const summary = {
      demoUrl,
      appUrl,
      shellState,
      snapshot,
      nodeDiagnostics,
      heuristics,
      generationBody,
      screenshotPath,
      checkedAt: new Date().toISOString(),
    };

    await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    if (cdp) cdp.close();
    await terminateChild(chrome);
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
