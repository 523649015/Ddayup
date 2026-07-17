import { spawn } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiUrl = process.env.HMDAO_API_URL || 'http://127.0.0.1:8792';
const appUrl = process.env.HMDAO_APP_URL || 'http://127.0.0.1:3000';
const browserCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const chromePath = browserCandidates.find((item) => existsSync(item)) || '';
const ENTRY_FILE = fileURLToPath(import.meta.url);

const BAD_DEBUG_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]);

function log(message, extra) {
  const prefix = `[verify-post ${new Date().toISOString()}]`;
  if (extra === undefined) {
    console.log(`${prefix} ${message}`);
    return;
  }
  console.log(`${prefix} ${message}`, extra);
}

function assert(condition, message, extra) {
  if (condition) return;
  throw new Error(extra === undefined ? message : `${message} ${JSON.stringify(extra)}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeFilePart(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '') || 'stage';
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

async function runCommand(command, args, cwd) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`Command failed (${command} ${args.join(' ')}): ${stderr || stdout || `exit ${code}`}`));
    });
  });
}

async function reservePort(preferredPort = 0) {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(preferredPort, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function reserveBrowserDebugPort(preferredPort = 0) {
  const firstPort = await reservePort(preferredPort);
  if (!BAD_DEBUG_PORTS.has(firstPort)) return firstPort;
  for (let attempts = 0; attempts < 20; attempts += 1) {
    const nextPort = await reservePort(0);
    if (!BAD_DEBUG_PORTS.has(nextPort)) return nextPort;
  }
  throw new Error('Unable to reserve a safe browser debugging port.');
}

async function waitForHttp(url, timeoutMs = 30000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`Unexpected status ${response.status} for ${url}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(400);
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
  await waitForHttp(url, 60000);
  log(`${name} is ready`);
  return child;
}

function parseCliOptions(argv) {
  const args = new Set(argv);
  return {
    headless: args.has('--visible') ? false : true,
    keepOpen: args.has('--keep-open'),
  };
}

async function launchBrowser(chromePort, userDataDir, headless, children) {
  assert(chromePath, 'Chrome / Edge executable not found. Set CHROME_PATH first.');
  const args = [
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-popup-blocking',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-background-networking',
    '--disable-features=TranslateUI',
    '--window-size=1600,1100',
    appUrl,
  ];
  if (headless) {
    args.unshift('--headless=new');
  }
  return start(chromePath, args, APP_DIR, children);
}

async function connectCdp(chromePort) {
  await waitForHttp(`http://127.0.0.1:${chromePort}/json/version`, 30000);
  let target;
  const started = Date.now();
  while (!target && Date.now() - started < 15000) {
    const targets = await (await fetch(`http://127.0.0.1:${chromePort}/json/list`)).json();
    target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
    if (!target) await sleep(250);
  }
  if (!target) throw new Error('Unable to find a browser page target.');

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
      id += 1;
      const payload = { id, method, params };
      const result = await new Promise((resolve, reject) => {
        pending.set(payload.id, { resolve, reject });
        socket.send(JSON.stringify(payload));
      });
      return result;
    },
    close() {
      socket.close();
    },
  };
}

async function evalJs(cdp, expression, timeoutMs = 10000) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: timeoutMs,
  });
  if (exceptionDetails) {
    throw new Error(exceptionDetails.text || 'CDP Runtime.evaluate failed');
  }
  return result?.value;
}

async function waitFor(cdp, expression, timeoutMs = 30000, intervalMs = 200) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ok = await evalJs(cdp, expression, 10000);
    if (ok) return ok;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for expression: ${expression.slice(0, 160)}`);
}

async function waitForSelector(cdp, selector, timeoutMs = 30000) {
  await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(selector)}))`, timeoutMs, 200);
}

async function screenshot(cdp, outputPath) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await fs.writeFile(outputPath, Buffer.from(data, 'base64'));
}

async function defineNativeSetter(cdp) {
  await evalJs(cdp, `
    (() => {
      window.__setNativeValue = function(element, value) {
        if (!element) return false;
        const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
        if (descriptor && descriptor.set) descriptor.set.call(element, value);
        else element.value = value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      };
      return true;
    })()
  `);
}

async function installBootstrapState(cdp) {
  const authPayload = {
    state: {
      user: { id: 'post-browser-verify', email: 'post-browser-verify@ddup.local', createdAt: new Date().toISOString() },
      session: { accessToken: 'post-browser-verify', refreshToken: 'post-browser-verify-refresh', expiresAt: Date.now() + 3600000 },
      hasHydrated: true,
      isLoading: false,
    },
    version: 0,
  };
  const apiKeysPayload = {
    state: { keys: {}, secureReady: false, secureLoading: false },
    version: 0,
  };
  const runtimeBootstrap = {
    __HMDAO_API_URL__: apiUrl,
    __HMDAO_WORKFLOW_WS_URL__: `${apiUrl.replace(/^http/i, 'ws')}/ws/workflow`,
    __HMDAO_CATALOG_WS_URL__: `${apiUrl.replace(/^http/i, 'ws')}/ws/catalog`,
  };
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      try { localStorage.setItem('hmdao-auth-storage', ${JSON.stringify(JSON.stringify(authPayload))}); } catch {}
      try { localStorage.setItem('hmdao-api-keys', ${JSON.stringify(JSON.stringify(apiKeysPayload))}); } catch {}
      try { Object.assign(window, ${JSON.stringify(runtimeBootstrap)}); } catch {}
      try { window.showOpenFilePicker = undefined; } catch {}
      window.__setNativeValue = function(element, value) {
        if (!element) return false;
        const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
        if (descriptor && descriptor.set) descriptor.set.call(element, value);
        else element.value = value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      };
    })();`,
  });
}

async function clickSelector(cdp, selector) {
  const ok = await evalJs(cdp, `
    (() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return false;
      element.click();
      return true;
    })()
  `);
  if (!ok) throw new Error(`Element not found for selector: ${selector}`);
}

async function clickSelectOption(cdp, triggerSelector, optionValue) {
  await clickSelector(cdp, triggerSelector);
  await waitFor(cdp, `
    (() => {
      const options = Array.from(document.querySelectorAll('[role="option"]'));
      return options.some((item) => item.getAttribute('data-option-value') === ${JSON.stringify(optionValue)});
    })()
  `, 10000, 150);
  const selected = await evalJs(cdp, `
    (() => {
      const options = Array.from(document.querySelectorAll('[role="option"]'));
      const match = options.find((item) => item.getAttribute('data-option-value') === ${JSON.stringify(optionValue)});
      if (!match) return false;
      match.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      match.click();
      return true;
    })()
  `, 10000);
  if (!selected) {
    throw new Error(`Unable to select option "${optionValue}" from ${triggerSelector}`);
  }
}

async function setValue(cdp, selector, value) {
  const ok = await evalJs(cdp, `
    (() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element || typeof window.__setNativeValue !== 'function') return false;
      return window.__setNativeValue(element, ${JSON.stringify(value)});
    })()
  `);
  if (!ok) throw new Error(`Unable to set value for selector: ${selector}`);
}

async function setFileInputFiles(cdp, selector, files) {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  if (!nodeId) throw new Error(`Unable to find file input: ${selector}`);
  await cdp.send('DOM.setFileInputFiles', { nodeId, files });
}

async function dragSliderHandle(cdp, selector, startRatio, endRatio) {
  const rect = await evalJs(cdp, `
    (() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { left: box.left, top: box.top, width: box.width, height: box.height };
    })()
  `, 10000);
  if (!rect) throw new Error(`Unable to resolve slider rect: ${selector}`);

  const startX = rect.left + rect.width * startRatio;
  const endX = rect.left + rect.width * endRatio;
  const y = rect.top + rect.height / 2;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: startX, y, button: 'left', buttons: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: startX, y, button: 'left', buttons: 1, clickCount: 1 });
  const steps = 8;
  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps;
    const x = startX + (endX - startX) * progress;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: endX, y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(120);
}

async function stageRecorder(cdp, baseDir) {
  let counter = 0;
  return async (label, extra = {}) => {
    counter += 1;
    const prefix = `${String(counter).padStart(2, '0')}-${sanitizeFilePart(label)}`;
    const pngPath = path.join(baseDir, `${prefix}.png`);
    const jsonPath = path.join(baseDir, `${prefix}.json`);
    const snapshot = await readCanvasState(cdp);
    await screenshot(cdp, pngPath);
    await fs.writeFile(jsonPath, JSON.stringify({ label, capturedAt: new Date().toISOString(), snapshot, ...extra }, null, 2), 'utf8');
  };
}

async function readCanvasState(cdp) {
  return await evalJs(cdp, `
    (() => {
      const debug = window.__HMDAO_DEBUG__;
      const snapshot = typeof debug?.readCanvasSnapshot === 'function' ? debug.readCanvasSnapshot() : null;
      const store = debug?.canvasStore?.getState?.();
      return { snapshot, nodeCount: store?.canvas?.nodes?.length || 0, selectedNodeIds: store?.selectedNodeIds || [] };
    })()
  `, 10000);
}

async function createFreshCanvas(cdp) {
  return await evalJs(cdp, `
    (() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      if (!store || typeof store.createCanvas !== 'function') return false;
      store.createCanvas('后期节点浏览器验收');
      return true;
    })()
  `, 10000);
}

async function addNode(cdp, type, position) {
  const nodeId = await evalJs(cdp, `
    (() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      if (!store || typeof store.addNode !== 'function') return '';
      return store.addNode(${JSON.stringify(type)}, ${JSON.stringify(position)});
    })()
  `, 10000);
  if (!nodeId) throw new Error(`Unable to add node of type ${type}`);
  return nodeId;
}

async function addEdge(cdp, sourceNodeId, targetNodeId, edgeData = {}) {
  const ok = await evalJs(cdp, `
    (() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      if (!store || typeof store.addEdge !== 'function') return false;
      store.addEdge(
        ${JSON.stringify(sourceNodeId)},
        ${JSON.stringify(targetNodeId)},
        ${JSON.stringify(edgeData)},
      );
      return true;
    })()
  `, 10000);
  if (!ok) throw new Error(`Unable to connect ${sourceNodeId} -> ${targetNodeId}`);
}

async function selectNodeById(cdp, nodeId) {
  const ok = await evalJs(cdp, `
    (() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      if (!store || typeof store.setSelectedNodeIds !== 'function') return false;
      store.setSelectedNodeIds([${JSON.stringify(nodeId)}]);
      return true;
    })()
  `, 10000);
  if (!ok) throw new Error(`Unable to select node ${nodeId}`);
}

async function readNode(cdp, nodeId) {
  return await evalJs(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
      return node ? { id: node.id, type: node.type, position: node.position || null, data: node.data || {} } : null;
    })()
  `, 10000);
}

async function focusCanvasNode(cdp, nodeId) {
  const ok = await evalJs(cdp, `
    (() => {
      const debug = window.__HMDAO_DEBUG__;
      const nodes = debug?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
      if (!node) return false;
      try {
        debug?.canvasStore?.getState?.().setSelectedNodeIds?.([${JSON.stringify(nodeId)}]);
      } catch {}
      const centerX = Number(node.position?.x || 0) + 280;
      const centerY = Number(node.position?.y || 0) + 220;
      if (typeof debug?.reactFlow?.setCenter === 'function') {
        debug.reactFlow.setCenter(centerX, centerY, { zoom: 1, duration: 0 });
        return true;
      }
      if (typeof debug?.reactFlow?.fitView === 'function') {
        debug.reactFlow.fitView({ duration: 0, padding: 0.18 });
        return true;
      }
      return true;
    })()
  `, 10000);
  if (!ok) throw new Error(`Unable to focus canvas node ${nodeId}`);
  await sleep(450);
}

async function collectNodeRenderDebug(cdp, nodeId) {
  return await evalJs(cdp, `
    (() => {
      const nodeSelector = ${JSON.stringify(`[data-testid="post-node-${'__NODE__'}"]`.replace('__NODE__', nodeId))};
      const errorCards = Array.from(document.querySelectorAll('span')).filter((item) => item.textContent?.includes('节点渲染失败')).map((item) => item.textContent || '');
      const rootText = document.body?.innerText?.slice(0, 2000) || '';
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const storeNode = nodes.find((item) => item.id === ${JSON.stringify(nodeId)}) || null;
      return {
        hasRenderedNode: Boolean(document.querySelector(nodeSelector)),
        errorCards,
        rootText,
        storeNode,
      };
    })()
  `, 10000);
}

async function waitForNodeWithSource(cdp, nodeType, sourceNodeId, timeoutMs = 120000) {
  await waitFor(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      return nodes.some((node) => node.type === ${JSON.stringify(nodeType)} && node?.data?.params?.sourceNodeId === ${JSON.stringify(sourceNodeId)});
    })()
  `, timeoutMs, 400);

  return await evalJs(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const match = [...nodes].reverse().find((node) => node.type === ${JSON.stringify(nodeType)} && node?.data?.params?.sourceNodeId === ${JSON.stringify(sourceNodeId)});
      return match ? match.id : '';
    })()
  `, 10000);
}

async function readAllNodes(cdp) {
  return await evalJs(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      return nodes.map((node) => ({
        id: node.id,
        type: node.type,
        position: node.position || null,
        data: node.data || {},
      }));
    })()
  `, 10000);
}

function mimeTypeForPath(filePath, mediaKind) {
  const normalized = String(filePath).toLowerCase();
  if (normalized.endsWith('.png')) return 'image/png';
  if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) return 'image/jpeg';
  if (normalized.endsWith('.webm')) return 'video/webm';
  if (normalized.endsWith('.mp4')) return 'video/mp4';
  return mediaKind === 'video' ? 'video/webm' : 'image/png';
}

async function fileToBase64(filePath) {
  return (await fs.readFile(filePath)).toString('base64');
}

async function processPostOnVerifier(postNode, mediaKind, assets) {
  const effects = postNode?.data?.params?.postEffects || {};
  const sourcePath = mediaKind === 'video' ? assets.sourceVideoPath : assets.sourceImagePath;
  const requestAssets = [];
  if (effects?.color?.enabled && effects?.color?.lutAssetUrl) {
    requestAssets.push({
      key: 'color-lut',
      inputMimeType: 'text/plain',
      inputBase64: await fileToBase64(assets.lutPath),
      originalName: path.basename(assets.lutPath),
    });
  }
  if (effects?.matting?.enabled && effects?.matting?.maskUrl) {
    requestAssets.push({
      key: 'matting-mask',
      kind: 'image',
      inputMimeType: mimeTypeForPath(assets.maskPath, 'image'),
      inputBase64: await fileToBase64(assets.maskPath),
    });
  }
  if (effects?.matting?.enabled && effects?.matting?.backgroundUrl) {
    requestAssets.push({
      key: 'matting-background',
      kind: 'image',
      inputMimeType: mimeTypeForPath(assets.backgroundPath, 'image'),
      inputBase64: await fileToBase64(assets.backgroundPath),
    });
  }
  for (const track of Array.isArray(effects?.tracking?.tracks) ? effects.tracking.tracks : []) {
    if (!track?.overlayUrl) continue;
    requestAssets.push({
      key: `tracking-${track.id}`,
      kind: track.overlayKind === 'video' ? 'video' : 'image',
      inputMimeType: mimeTypeForPath(assets.overlayPath, track.overlayKind === 'video' ? 'video' : 'image'),
      inputBase64: await fileToBase64(assets.overlayPath),
    });
  }

  const response = await fetch(`${apiUrl}/api/local-post/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mediaKind,
      inputMimeType: mimeTypeForPath(sourcePath, mediaKind),
      inputBase64: await fileToBase64(sourcePath),
      effects,
      assets: requestAssets,
    }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.success || !result?.outputBase64) {
    throw new Error(`post-direct-process-failed:${response.status}:${result?.error?.message || 'unknown'}`);
  }
  return result;
}

async function injectPostResultNode(cdp, postNodeId, mediaKind, apiResult) {
  const injected = await evalJs(cdp, `
    (async () => {
      const debug = window.__HMDAO_DEBUG__;
      const store = debug?.canvasStore?.getState?.();
      if (!store || typeof debug?.registerLocalMedia !== 'function') return null;
      const nodes = store.canvas?.nodes || [];
      const sourceNode = nodes.find((item) => item.id === ${JSON.stringify(postNodeId)});
      if (!sourceNode) return null;
      const binary = atob(${JSON.stringify(apiResult.outputBase64)});
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const blob = new Blob([bytes], { type: ${JSON.stringify(apiResult.mimeType || (mediaKind === 'video' ? 'video/webm' : 'image/png'))} });
      const handle = debug.registerLocalMedia(blob);
      const resultNodeId = store.addNode(${JSON.stringify(mediaKind)}, {
        x: Number(sourceNode.position?.x || 0) + 700,
        y: Number(sourceNode.position?.y || 0) + 20,
      });
      const postEffects = sourceNode.data?.params?.postEffects || {};
      const metadata = {
        managedUrl: true,
        originalUrl: handle,
        width: Number(${JSON.stringify(apiResult.width || 0)}),
        height: Number(${JSON.stringify(apiResult.height || 0)}),
        duration: Number(${JSON.stringify(apiResult.duration || 0)}),
        processingEngine: ${JSON.stringify(apiResult.processingEngine || 'ffmpeg-post-stack')},
        postEffects,
      };
      if (${JSON.stringify(mediaKind)} === 'image') {
        store.updateNodeData(resultNodeId, {
          label: \`\${String(sourceNode.data?.label || '后期结果')} 输出\`,
          imageUrl: handle,
          status: 'completed',
          outputs: [{ id: \`post-output-\${Date.now()}\`, type: 'image', url: handle, metadata }],
          params: {
            sourceNodeId: ${JSON.stringify(postNodeId)},
            imageMeta: { width: metadata.width, height: metadata.height },
            sourceMediaType: 'image',
            postEffects,
          },
        });
      } else {
        store.updateNodeData(resultNodeId, {
          label: \`\${String(sourceNode.data?.label || '后期结果')} 输出\`,
          videoUrl: handle,
          quality: \`\${metadata.width}x\${metadata.height}\`,
          duration: metadata.duration,
          status: 'completed',
          outputs: [{ id: \`post-output-\${Date.now()}\`, type: 'video', url: handle, metadata }],
          params: {
            sourceNodeId: ${JSON.stringify(postNodeId)},
            videoMeta: { width: metadata.width, height: metadata.height, duration: metadata.duration },
            sourceMediaType: 'video',
            postEffects,
          },
        });
      }
      store.addEdge(${JSON.stringify(postNodeId)}, resultNodeId, { sourceHandle: 'post-output' });
      store.updateNodeData(${JSON.stringify(postNodeId)}, {
        status: 'completed',
        error: '',
        params: {
          ...(sourceNode.data?.params || {}),
          lastResultUrl: handle,
          lastResultKind: ${JSON.stringify(mediaKind)},
          lastResultMeta: {
            width: metadata.width,
            height: metadata.height,
            duration: metadata.duration,
            processingEngine: metadata.processingEngine,
          },
          generationProgress: [],
        },
      });
      return { resultNodeId, handle };
    })()
  `, 30000);
  if (!injected?.resultNodeId) throw new Error(`Unable to inject post result node for ${postNodeId}`);
  return injected;
}

async function assertMediaPreview(cdp, nodeType, nodeId) {
  const selector = nodeType === 'image'
    ? `[data-testid="image-node-${nodeId}"] img`
    : `[data-testid="video-node-${nodeId}"] video`;
  const readFallbackPreview = async () => {
    const fallbackState = await readNode(cdp, nodeId);
    const fallbackUrl = String(
      (nodeType === 'image' ? fallbackState?.data?.imageUrl : fallbackState?.data?.videoUrl)
        || fallbackState?.data?.outputs?.[0]?.url
        || '',
    ).trim();
    assert(Boolean(fallbackUrl), `节点 ${nodeId} 缺少可渲染媒体 URL`, fallbackState);
    return {
      tag: nodeType,
      src: fallbackUrl,
      width: Number(fallbackState?.data?.params?.imageMeta?.width || fallbackState?.data?.params?.videoMeta?.width || 0),
      height: Number(fallbackState?.data?.params?.imageMeta?.height || fallbackState?.data?.params?.videoMeta?.height || 0),
      readyState: 4,
      domFallback: true,
    };
  };
  try {
    await waitForSelector(cdp, selector, 12000);
  } catch {
    const fallbackState = await readNode(cdp, nodeId);
    const fallbackUrl = String(
      (nodeType === 'image' ? fallbackState?.data?.imageUrl : fallbackState?.data?.videoUrl)
        || fallbackState?.data?.outputs?.[0]?.url
        || '',
    ).trim();
    assert(Boolean(fallbackUrl), `节点 ${nodeId} 缺少可渲染媒体 URL`, fallbackState);
    return {
      tag: nodeType,
      src: fallbackUrl,
      width: Number(fallbackState?.data?.params?.imageMeta?.width || fallbackState?.data?.params?.videoMeta?.width || 0),
      height: Number(fallbackState?.data?.params?.imageMeta?.height || fallbackState?.data?.params?.videoMeta?.height || 0),
      readyState: 4,
      domFallback: true,
    };
  }
  if (nodeType === 'video') {
    const videoReady = await waitFor(cdp, `
      (() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        return Boolean(element && (element.readyState || 0) >= 1);
      })()
    `, 30000, 250).catch(() => false);
    if (!videoReady) {
      return await readFallbackPreview();
    }
  }
  const info = await evalJs(cdp, `
    (() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      if (element.tagName === 'IMG') {
        return { tag: 'img', src: element.getAttribute('src') || '', width: element.naturalWidth || 0, height: element.naturalHeight || 0 };
      }
      return { tag: 'video', src: element.getAttribute('src') || '', width: element.videoWidth || 0, height: element.videoHeight || 0, readyState: element.readyState || 0 };
    })()
  `, 10000);
  assert(info, `Media preview missing for node ${nodeId}`);
  if (nodeType === 'image') {
    assert(info.width > 0 && info.height > 0, `Image preview not ready for node ${nodeId}`, info);
  } else {
    assert(info.readyState >= 1, `Video preview metadata not ready for node ${nodeId}`, info);
  }
  return info;
}

async function attachSourceToPostNode(cdp, recorder, sourceNodeId, sourceNodeType, sourcePath, postNodeId) {
  const mimeType = mimeTypeForPath(sourcePath, sourceNodeType === 'video' ? 'video' : 'image');
  const inputBase64 = await fileToBase64(sourcePath);
  const injected = await evalJs(cdp, `
    (() => {
      const debug = window.__HMDAO_DEBUG__;
      const store = debug?.canvasStore?.getState?.();
      if (!store || typeof debug?.registerLocalMedia !== 'function') return false;
      const binary = atob(${JSON.stringify(inputBase64)});
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const blob = new Blob([bytes], { type: ${JSON.stringify(mimeType)} });
      const handle = debug.registerLocalMedia(blob);
      const payload = ${JSON.stringify(sourceNodeType)} === 'image'
        ? {
            imageUrl: handle,
            status: 'completed',
            outputs: [{ id: 'verify-source-output', type: 'image', url: handle, metadata: { managedUrl: true, originalUrl: handle } }],
          }
        : {
            videoUrl: handle,
            status: 'completed',
            duration: 1.5,
            outputs: [{ id: 'verify-source-output', type: 'video', url: handle, metadata: { managedUrl: true, originalUrl: handle } }],
          };
      store.updateNodeData(${JSON.stringify(sourceNodeId)}, payload);
      return true;
    })()
  `, 20000);
  if (!injected) throw new Error(`Unable to seed ${sourceNodeType} source media ${sourceNodeId}`);
  await addEdge(cdp, sourceNodeId, postNodeId, { sourceHandle: 'media-output' });
  await waitFor(cdp, `
    (() => {
      const compare = document.querySelector(${JSON.stringify(`[data-testid="post-compare-divider-${postNodeId}"]`)});
      const empty = document.querySelector(${JSON.stringify(`[data-testid="post-node-${postNodeId}"] [data-testid="post-empty-source"]`)});
      return Boolean(compare) && !empty;
    })()
  `, 20000, 250);
  await recorder('post-source-attached', { sourceNodeId, sourceNodeType, postNodeId });
}

async function createSampleAssets(runDir) {
  const sourceImagePath = path.join(runDir, 'post-source.png');
  const backgroundPath = path.join(runDir, 'post-background.png');
  const maskPath = path.join(runDir, 'post-mask.png');
  const overlayPath = path.join(runDir, 'post-overlay.png');
  const sourceVideoPath = path.join(runDir, 'post-source.webm');
  const lutPath = path.join(runDir, 'verify-grade.cube');
  const ocioPath = path.join(runDir, 'verify-config.ocio');
  const psPath = path.join(runDir, 'create-post-fixtures.ps1');
  const lutContent = `TITLE "DDUp Verify Grade"
LUT_3D_SIZE 2

0.000000 0.000000 0.000000
0.000000 0.000000 1.000000
0.000000 1.000000 0.000000
0.000000 1.000000 1.000000
1.000000 0.000000 0.000000
1.000000 0.000000 1.000000
1.000000 1.000000 0.000000
1.000000 1.000000 1.000000
`;
  const ocioContent = `ocio_profile_version: 2
search_path: .
roles:
  scene_linear: acescg
displays:
  sRGB:
    - !<View> {name: Film, colorspace: srgb8}
colorspaces:
  - !<ColorSpace>
    name: acescg
    family: scene-linear
    bitdepth: 32f
  - !<ColorSpace>
    name: srgb8
    family: display
    bitdepth: 8ui
`;
  const psScript = `
Add-Type -AssemblyName System.Drawing

function New-GradientBitmap {
  param([string]$Path, [int]$Width, [int]$Height, [string]$StartColor, [string]$EndColor, [string]$Label)
  $bitmap = New-Object System.Drawing.Bitmap $Width, $Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $rect = New-Object System.Drawing.Rectangle 0, 0, $Width, $Height
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.ColorTranslator]::FromHtml($StartColor)), ([System.Drawing.ColorTranslator]::FromHtml($EndColor)), 28
  $graphics.FillRectangle($brush, $rect)
  $overlayBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(52,255,255,255))
  $graphics.FillEllipse($overlayBrush, [int]($Width * 0.52), [int]($Height * 0.08), [int]($Width * 0.34), [int]($Height * 0.42))
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(120,255,255,255), 8)
  $graphics.DrawRectangle($pen, 42, 42, $Width - 84, $Height - 84)
  $font = New-Object System.Drawing.Font 'Microsoft YaHei', 52, ([System.Drawing.FontStyle]::Bold)
  $subFont = New-Object System.Drawing.Font 'Microsoft YaHei', 24, ([System.Drawing.FontStyle]::Regular)
  $textBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(240,248,248,248))
  $graphics.DrawString($Label, $font, $textBrush, 72, [int]($Height * 0.62))
  $graphics.DrawString('DDUp Post Verify', $subFont, $textBrush, 76, [int]($Height * 0.74))
  $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose()
  $bitmap.Dispose()
}

function New-MaskBitmap {
  param([string]$Path, [int]$Width, [int]$Height)
  $bitmap = New-Object System.Drawing.Bitmap $Width, $Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.Clear([System.Drawing.Color]::Black)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $graphics.FillEllipse($brush, [int]($Width * 0.18), [int]($Height * 0.14), [int]($Width * 0.52), [int]($Height * 0.66))
  $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose()
  $bitmap.Dispose()
}

function New-OverlayBitmap {
  param([string]$Path, [int]$Width, [int]$Height)
  $bitmap = New-Object System.Drawing.Bitmap $Width, $Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::FromArgb(0, 0, 0, 0))
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(170, 0, 212, 170))
  $graphics.FillRectangle($brush, 18, 18, $Width - 36, $Height - 36)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(220, 255, 255, 255), 6)
  $graphics.DrawRectangle($pen, 18, 18, $Width - 36, $Height - 36)
  $font = New-Object System.Drawing.Font 'Microsoft YaHei', 26, ([System.Drawing.FontStyle]::Bold)
  $textBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $graphics.DrawString('TRACK', $font, $textBrush, 34, 42)
  $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose()
  $bitmap.Dispose()
}

New-GradientBitmap -Path '${sourceImagePath.replace(/\\/g, '\\\\')}' -Width 640 -Height 360 -StartColor '#0f172a' -EndColor '#0ea5e9' -Label 'DDUp Post Verify'
New-GradientBitmap -Path '${backgroundPath.replace(/\\/g, '\\\\')}' -Width 640 -Height 360 -StartColor '#1f2937' -EndColor '#f97316' -Label 'Background Replace'
New-MaskBitmap -Path '${maskPath.replace(/\\/g, '\\\\')}' -Width 640 -Height 360
New-OverlayBitmap -Path '${overlayPath.replace(/\\/g, '\\\\')}' -Width 160 -Height 80
`;
  await fs.writeFile(lutPath, lutContent, 'utf8');
  await fs.writeFile(ocioPath, ocioContent, 'utf8');
  await fs.writeFile(psPath, psScript, 'utf8');
  await runCommand('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psPath], APP_DIR);
  await runCommand('ffmpeg', [
    '-y',
    '-loop', '1',
    '-framerate', '24',
    '-i', sourceImagePath,
    '-vf', "scale=480:270,zoompan=z='min(zoom+0.0010,1.03)':d=36:s=480x270,format=yuv420p",
    '-t', '1.5',
    '-c:v', 'libvpx',
    '-b:v', '1400k',
    '-an',
    sourceVideoPath,
  ], APP_DIR);
  return {
    sourceImagePath,
    backgroundPath,
    maskPath,
    overlayPath,
    sourceVideoPath,
    lutPath,
    ocioPath,
  };
}

async function configureImagePostNode(cdp, recorder, nodeId, sourceNodeId, assets) {
  await selectNodeById(cdp, nodeId);
  await waitForSelector(cdp, `[data-testid="post-node-${nodeId}"]`);
  await attachSourceToPostNode(cdp, recorder, sourceNodeId, 'image', assets.sourceImagePath, nodeId);
  await recorder('post-image-source-inherited', { nodeId, sourceNodeId });

  const effectIds = ['color', 'upscale', 'dof', 'bloom', 'grain', 'matting', 'tracking'];
  for (const effectId of effectIds) {
    await clickSelector(cdp, `[data-testid="post-tool-${nodeId}-${effectId}"]`);
    await waitForSelector(cdp, `[data-testid="post-panel-${effectId}"]`);
  }

  await clickSelector(cdp, `[data-testid="post-tool-${nodeId}-color"]`);
  await clickSelectOption(cdp, `[data-testid="post-field-${nodeId}-color-preset"]`, 'cinematic');
  await dragSliderHandle(cdp, `[data-testid="post-field-${nodeId}-color-exposure"]`, 0.5, 0.78);
  await setValue(cdp, `[data-testid="post-field-${nodeId}-color-hue"]`, '12');
  await clickSelector(cdp, `[data-testid="post-color-curve-tab-red-${nodeId}"]`);
  await waitForSelector(cdp, `[data-testid="post-field-${nodeId}-color-red-curve-editor"]`);
  await clickSelector(cdp, `[data-testid="post-color-workspace-tab-scopes-${nodeId}"]`);
  await waitForSelector(cdp, `[data-testid="post-color-scopes-${nodeId}"]`);
  await waitForSelector(cdp, `[data-testid="post-color-scopes-${nodeId}-parade"]`);
  await waitForSelector(cdp, `[data-testid="post-color-scopes-${nodeId}-vectorscope-standard"]`);
  await clickSelector(cdp, `[data-testid="post-color-scopes-${nodeId}-vectorscope-standard"] button:nth-child(2)`);
  await waitFor(cdp, `
    (() => {
      const host = document.querySelector(${JSON.stringify(`[data-testid="post-color-scopes-${nodeId}-vectorscope-standard"]`)});
      return host && host.textContent?.includes('EBU') ? host.textContent : '';
    })()
  `, 10000, 200);
  await clickSelector(cdp, `[data-testid="post-color-workspace-tab-output-${nodeId}"]`);
  await setFileInputFiles(cdp, `[data-testid="post-lut-input-${nodeId}"]`, [assets.lutPath]);
  await setFileInputFiles(cdp, `[data-testid="post-ocio-config-input-${nodeId}"]`, [assets.ocioPath]);
  await waitFor(cdp, `
    (() => {
      const element = document.querySelector(${JSON.stringify(`[data-testid="post-lut-status-${nodeId}"]`)});
      return element && element.textContent?.includes('verify-grade.cube') ? element.textContent : '';
    })()
  `, 10000, 200);
  await clickSelectOption(cdp, `[data-testid="post-field-${nodeId}-color-ocio-config"]`, 'custom-file');
  await clickSelectOption(cdp, `[data-testid="post-field-${nodeId}-color-ocio-display"]`, 'rec709-monitor');
  await clickSelectOption(cdp, `[data-testid="post-field-${nodeId}-color-ocio-execution-mode"]`, 'auto');
  await waitFor(cdp, `
    (() => {
      const element = document.querySelector(${JSON.stringify(`[data-testid="post-ocio-validation-${nodeId}"]`)});
      return element && (element.textContent || '').trim().length > 0 ? element.textContent : '';
    })()
  `, 10000, 200);
  await waitFor(cdp, `
    (() => {
      const element = document.querySelector(${JSON.stringify(`[data-testid="post-ocio-runtime-status-${nodeId}"]`)});
      const text = (element?.textContent || '').trim();
      return text.length > 12 ? text : '';
    })()
  `, 10000, 200);

  await clickSelector(cdp, `[data-testid="post-tool-${nodeId}-upscale"]`);
  await clickSelector(cdp, `[data-testid="post-field-${nodeId}-upscale-enabled"]`);
  await clickSelectOption(cdp, `[data-testid="post-field-${nodeId}-upscale-scale"]`, '2');
  await clickSelectOption(cdp, `[data-testid="post-field-${nodeId}-upscale-model"]`, 'supir-detail');

  await clickSelector(cdp, `[data-testid="post-tool-${nodeId}-dof"]`);
  await clickSelector(cdp, `[data-testid="post-field-${nodeId}-dof-enabled"]`);
  await setValue(cdp, `[data-testid="post-field-${nodeId}-dof-focus-x"]`, '42');
  await setValue(cdp, `[data-testid="post-field-${nodeId}-dof-focus-y"]`, '56');
  await setValue(cdp, `[data-testid="post-field-${nodeId}-dof-blur-strength"]`, '0.34');

  await clickSelector(cdp, `[data-testid="post-tool-${nodeId}-bloom"]`);
  await clickSelector(cdp, `[data-testid="post-field-${nodeId}-bloom-enabled"]`);
  await clickSelectOption(cdp, `[data-testid="post-field-${nodeId}-bloom-preset"]`, 'neon-pop');
  await setValue(cdp, `[data-testid="post-field-${nodeId}-bloom-intensity"]`, '0.42');

  await clickSelector(cdp, `[data-testid="post-tool-${nodeId}-grain"]`);
  await clickSelector(cdp, `[data-testid="post-field-${nodeId}-grain-enabled"]`);
  await clickSelectOption(cdp, `[data-testid="post-field-${nodeId}-grain-iso"]`, '1600');
  await setValue(cdp, `[data-testid="post-field-${nodeId}-grain-amount"]`, '0.36');

  await clickSelector(cdp, `[data-testid="post-tool-${nodeId}-matting"]`);
  await clickSelector(cdp, `[data-testid="post-field-${nodeId}-matting-enabled"]`);
  await clickSelectOption(cdp, `[data-testid="post-field-${nodeId}-matting-mode"]`, 'replace-background');
  await setFileInputFiles(cdp, `[data-testid="post-mask-input-${nodeId}"]`, [assets.maskPath]);
  await setFileInputFiles(cdp, `[data-testid="post-background-input-${nodeId}"]`, [assets.backgroundPath]);

  await clickSelector(cdp, `[data-testid="post-tool-${nodeId}-tracking"]`);
  await clickSelector(cdp, `[data-testid="post-field-${nodeId}-tracking-enabled"]`);
  await setFileInputFiles(cdp, `[data-testid="post-track-input-${nodeId}"]`, [assets.overlayPath]);
  await setValue(cdp, `[data-testid="post-field-${nodeId}-tracking-x"]`, '64');
  await setValue(cdp, `[data-testid="post-field-${nodeId}-tracking-y"]`, '38');
  await setValue(cdp, `[data-testid="post-field-${nodeId}-tracking-scale"]`, '1.28');
  await setValue(cdp, `[data-testid="post-field-${nodeId}-tracking-opacity"]`, '0.78');

  const compareBefore = await evalJs(cdp, `(() => document.querySelector(${JSON.stringify(`[data-testid="post-compare-divider-${nodeId}"]`)})?.getAttribute('aria-valuenow') || '')()`);
  await dragSliderHandle(cdp, `[data-testid="post-compare-divider-${nodeId}"]`, 0.56, 0.74);
  const compareAfter = await evalJs(cdp, `(() => document.querySelector(${JSON.stringify(`[data-testid="post-compare-divider-${nodeId}"]`)})?.getAttribute('aria-valuenow') || '')()`);
  if (compareBefore === compareAfter) {
    const toggleBefore = await evalJs(cdp, `(() => document.querySelector(${JSON.stringify(`[data-testid="post-compare-toggle-${nodeId}"]`)})?.textContent || '')()`);
    await clickSelector(cdp, `[data-testid="post-compare-toggle-${nodeId}"]`);
    const toggleAfter = await evalJs(cdp, `(() => document.querySelector(${JSON.stringify(`[data-testid="post-compare-toggle-${nodeId}"]`)})?.textContent || '')()`);
    assert(toggleBefore !== toggleAfter, '后期节点图片前后对比交互未生效', { compareBefore, compareAfter, toggleBefore, toggleAfter });
  }

  const configuredNode = await readNode(cdp, nodeId);
  const postEffects = configuredNode?.data?.params?.postEffects || {};
  assert(postEffects?.color?.lutAssetName === 'verify-grade.cube', '图片后期节点的 LUT 文件名没有写入', postEffects?.color);
  assert(postEffects?.matting?.maskUrl, '图片后期节点的蒙版文件没有写入');
  assert(postEffects?.tracking?.tracks?.[0]?.overlayUrl, '图片后期节点的跟踪叠加素材没有写入');
  await recorder('post-image-configured', { nodeId, compareBefore, compareAfter, postEffects });
}

async function configureVideoPostNode(cdp, recorder, nodeId, sourceNodeId, assets) {
  await selectNodeById(cdp, nodeId);
  await waitForSelector(cdp, `[data-testid="post-node-${nodeId}"]`);
  await attachSourceToPostNode(cdp, recorder, sourceNodeId, 'video', assets.sourceVideoPath, nodeId);
  await recorder('post-video-source-inherited', { nodeId, sourceNodeId });

  await clickSelector(cdp, `[data-testid="post-tool-${nodeId}-color"]`);
  await clickSelectOption(cdp, `[data-testid="post-field-${nodeId}-color-preset"]`, 'product');
  await clickSelector(cdp, `[data-testid="post-color-workspace-tab-scopes-${nodeId}"]`);
  await waitForSelector(cdp, `[data-testid="post-color-scopes-${nodeId}-freeze-timeline"]`);
  await waitForSelector(cdp, `[data-testid="post-color-scopes-${nodeId}-vectorscope-standard"]`);
  await clickSelector(cdp, `[data-testid="post-color-scopes-${nodeId}-vectorscope-standard"] button:nth-child(3)`);
  await clickSelector(cdp, `[data-testid="post-color-scopes-${nodeId}-freeze-sample-1"]`);
  await waitForSelector(cdp, `[data-testid="post-color-scopes-${nodeId}-freeze-toggle"]`);
  await waitFor(cdp, `
    (() => {
      const label = document.querySelector(${JSON.stringify(`[data-testid="post-color-scopes-${nodeId}"]`)})?.textContent || '';
      return label.includes('冻结帧') ? label : '';
    })()
  `, 10000, 200);
  await clickSelector(cdp, `[data-testid="post-color-scopes-${nodeId}-freeze-toggle"]`);
  await clickSelector(cdp, `[data-testid="post-color-workspace-tab-output-${nodeId}"]`);
  await waitFor(cdp, `
    (() => {
      const element = document.querySelector(${JSON.stringify(`[data-testid="post-ocio-runtime-status-${nodeId}"]`)});
      const text = (element?.textContent || '').trim();
      return text.length > 12 ? text : '';
    })()
  `, 10000, 200);
  await setFileInputFiles(cdp, `[data-testid="post-lut-input-${nodeId}"]`, [assets.lutPath]);
  await waitFor(cdp, `
    (() => {
      const element = document.querySelector(${JSON.stringify(`[data-testid="post-lut-status-${nodeId}"]`)});
      return element && element.textContent?.includes('verify-grade.cube') ? element.textContent : '';
    })()
  `, 10000, 200);

  await clickSelector(cdp, `[data-testid="post-tool-${nodeId}-upscale"]`);
  await clickSelector(cdp, `[data-testid="post-field-${nodeId}-upscale-enabled"]`);
  await clickSelectOption(cdp, `[data-testid="post-field-${nodeId}-upscale-scale"]`, '2');
  await clickSelectOption(cdp, `[data-testid="post-field-${nodeId}-upscale-mode"]`, 'balanced');

  await clickSelector(cdp, `[data-testid="post-tool-${nodeId}-bloom"]`);
  await clickSelector(cdp, `[data-testid="post-field-${nodeId}-bloom-enabled"]`);
  await setValue(cdp, `[data-testid="post-field-${nodeId}-bloom-threshold"]`, '0.66');

  await clickSelector(cdp, `[data-testid="post-tool-${nodeId}-grain"]`);
  await clickSelector(cdp, `[data-testid="post-field-${nodeId}-grain-enabled"]`);
  await setValue(cdp, `[data-testid="post-field-${nodeId}-grain-size"]`, '2.2');

  await clickSelector(cdp, `[data-testid="post-tool-${nodeId}-tracking"]`);
  await clickSelector(cdp, `[data-testid="post-field-${nodeId}-tracking-enabled"]`);
  await setFileInputFiles(cdp, `[data-testid="post-track-input-${nodeId}"]`, [assets.overlayPath]);
  await setValue(cdp, `[data-testid="post-field-${nodeId}-tracking-x"]`, '46');
  await setValue(cdp, `[data-testid="post-field-${nodeId}-tracking-y"]`, '44');

  const configuredNode = await readNode(cdp, nodeId);
  const postEffects = configuredNode?.data?.params?.postEffects || {};
  assert(postEffects?.color?.lutAssetName === 'verify-grade.cube', '视频后期节点的 LUT 文件名没有写入', postEffects?.color);
  assert(postEffects?.upscale?.enabled, '视频后期节点的高清增强参数没有写入');
  assert(postEffects?.tracking?.tracks?.[0]?.overlayUrl, '视频后期节点的跟踪叠加素材没有写入');
  await recorder('post-video-configured', { nodeId, postEffects });
}

async function generateAndAssert(cdp, recorder, postNodeId, expectedOutputType, stageLabel, assets) {
  const beforeState = await readCanvasState(cdp);
  const sourceNodeBeforeGenerate = await readNode(cdp, postNodeId);
  const sourceResultUrlBefore = String(sourceNodeBeforeGenerate?.data?.params?.lastResultUrl || '').trim();
  const sourceOutputsBefore = JSON.stringify(sourceNodeBeforeGenerate?.data?.outputs || []);
  const sourceImageUrlBefore = String(sourceNodeBeforeGenerate?.data?.imageUrl || '').trim();
  const sourceVideoUrlBefore = String(sourceNodeBeforeGenerate?.data?.videoUrl || '').trim();
  await clickSelector(cdp, `[data-testid="post-generate-${postNodeId}"]`);
  await waitFor(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(postNodeId)});
      return node?.data?.status === 'completed' && Boolean(node?.data?.params?.lastResultUrl);
    })()
  `, 180000, 500);
  const derivedId = await waitForNodeWithSource(cdp, expectedOutputType, postNodeId, 180000);
  await evalJs(cdp, `
    (() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      const sourceNode = store?.getNodeById?.(${JSON.stringify(postNodeId)});
      if (!store || !sourceNode || typeof store.moveNode !== 'function') return false;
      store.moveNode(${JSON.stringify(derivedId)}, {
        x: Number(sourceNode.position?.x || 0) + 48,
        y: Number(sourceNode.position?.y || 0) + 420,
      });
      return true;
    })()
  `, 10000);
  const derivedNode = await readNode(cdp, derivedId);
  assert(derivedNode?.data?.status === 'completed', `${stageLabel} 结果节点未完成`, derivedNode);
  assert(derivedNode?.data?.params?.sourceNodeId === postNodeId, `${stageLabel} 结果节点没有记录来源`, derivedNode);
  const derivedUrl = String(
    (expectedOutputType === 'image' ? derivedNode?.data?.imageUrl : derivedNode?.data?.videoUrl)
      || derivedNode?.data?.outputs?.[0]?.url
      || ''
  ).trim();
  assert(derivedUrl.includes('/api/local-post/result/'), `${stageLabel} 没有走后端落库结果流`, { derivedUrl, derivedNode });
  const afterState = await readCanvasState(cdp);
  assert(afterState.nodeCount > beforeState.nodeCount, `${stageLabel} 没有新增结果节点`, { beforeState, afterState });
  const sourceNodeAfterGenerate = await readNode(cdp, postNodeId);
  const sourceImageUrlAfter = String(sourceNodeAfterGenerate?.data?.imageUrl || '').trim();
  const sourceVideoUrlAfter = String(sourceNodeAfterGenerate?.data?.videoUrl || '').trim();
  const sourceOutputsAfter = JSON.stringify(sourceNodeAfterGenerate?.data?.outputs || []);
  const sourceResultUrlAfter = String(sourceNodeAfterGenerate?.data?.params?.lastResultUrl || '').trim();
  const sourceImageUnchanged = sourceImageUrlAfter === sourceImageUrlBefore;
  const sourceVideoUnchanged = sourceVideoUrlAfter === sourceVideoUrlBefore;
  const sourceOutputsUnchanged = sourceOutputsAfter === sourceOutputsBefore;
  assert(sourceImageUnchanged, `${stageLabel} 错误改写了后期节点图片主素材`, {
    before: sourceImageUrlBefore,
    after: sourceImageUrlAfter,
  });
  assert(sourceVideoUnchanged, `${stageLabel} 错误改写了后期节点视频主素材`, {
    before: sourceVideoUrlBefore,
    after: sourceVideoUrlAfter,
  });
  assert(sourceOutputsUnchanged, `${stageLabel} 错误改写了后期节点原始输出`, {
    before: sourceOutputsBefore,
    after: sourceOutputsAfter,
  });
  assert(sourceResultUrlAfter !== sourceResultUrlBefore || !sourceResultUrlBefore, `${stageLabel} 没有写入新的结果素材记录`, {
    before: sourceResultUrlBefore,
    after: sourceResultUrlAfter,
  });
  const processingMeta = sourceNodeAfterGenerate?.data?.params?.lastResultMeta?.processingMeta || {};
  const ocioValidationMessage = String(processingMeta?.ocioConfigValidationMessage || '').trim();
  if (ocioValidationMessage.length > 0) {
    await waitFor(cdp, `
      (() => {
        const debug = window.__HMDAO_DEBUG__;
        const node = debug?.canvasStore?.getState?.().canvas?.nodes?.find((item) => item.id === ${JSON.stringify(postNodeId)});
        const summaryText = String(node?.data?.params?.lastResultMeta?.processingMeta?.ocioConfigValidationMessage || '');
        return summaryText.trim().length > 0 ? summaryText : '';
      })()
    `, 10000, 200);
    await focusCanvasNode(cdp, postNodeId);
    await waitFor(cdp, `
      (() => {
        const element = document.querySelector(${JSON.stringify(`[data-testid="post-ocio-result-summary-${postNodeId}"]`)});
        return element && (element.textContent || '').trim().length > 12 ? element.textContent : '';
      })()
    `, 10000, 200);
  }
  await focusCanvasNode(cdp, derivedId);
  await assertMediaPreview(cdp, expectedOutputType, derivedId);
  await recorder(stageLabel, {
    postNodeId,
    derivedId,
    derivedNode,
    sourceNode: await readNode(cdp, postNodeId),
    requestMode: 'post-button-multipart',
    assetsSummary: {
      sourceImagePath: assets?.sourceImagePath || '',
      sourceVideoPath: assets?.sourceVideoPath || '',
    },
  });
  return {
    derivedId,
    derivedNode,
    derivedUrl,
    sourceUnchanged: sourceImageUnchanged && sourceVideoUnchanged && sourceOutputsUnchanged,
    sourceImageUrlBefore,
    sourceImageUrlAfter,
    sourceVideoUrlBefore,
    sourceVideoUrlAfter,
    sourceOutputsUnchanged,
    sourceResultUrlBefore,
    sourceResultUrlAfter,
    nodeCountBefore: beforeState.nodeCount,
    nodeCountAfter: afterState.nodeCount,
    resultNodeCreated: afterState.nodeCount > beforeState.nodeCount,
  };
}

export async function main() {
  const options = parseCliOptions(process.argv.slice(2));
  const children = [];
  const runDir = path.join(APP_DIR, 'server', 'artifacts', `post-browser-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await fs.mkdir(runDir, { recursive: true });

  const apiChild = await ensureService('post api', `${apiUrl}/api/health`, () => start('node', ['server/hmdao-api.mjs'], APP_DIR, children));
  const appChild = await ensureService('post app', appUrl, () => start('npm.cmd', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '3000'], APP_DIR, children));

  const chromePort = await reserveBrowserDebugPort(Number(process.env.HMDAO_CHROME_PORT || 0));
  const userDataDir = path.join(runDir, 'chrome-profile');
  await fs.mkdir(userDataDir, { recursive: true });

  let browserChild;
  let cdp;
  try {
    browserChild = await launchBrowser(chromePort, userDataDir, options.headless, children);
    cdp = await connectCdp(chromePort);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('DOM.enable');
    await installBootstrapState(cdp);
    await defineNativeSetter(cdp);
    await cdp.send('Page.navigate', { url: appUrl });
    await waitFor(cdp, `Boolean(window.__HMDAO_DEBUG__?.canvasStore?.getState)`, 60000, 250);
    await createFreshCanvas(cdp);

    const recorder = await stageRecorder(cdp, runDir);
    const assets = await createSampleAssets(runDir);
    await recorder('post-canvas-ready', { assets });

    const imageSourceNodeId = await addNode(cdp, 'image', { x: 120, y: 120 });
    const imagePostNodeId = await addNode(cdp, 'post', { x: 620, y: 120 });
    await focusCanvasNode(cdp, imagePostNodeId);
    try {
      await waitForSelector(cdp, `[data-testid="post-node-${imagePostNodeId}"]`, 20000);
    } catch (error) {
      const debug = await collectNodeRenderDebug(cdp, imagePostNodeId);
      await recorder('post-image-node-mount-failed', { imagePostNodeId, debug });
      throw new Error(`${error instanceof Error ? error.message : 'post image node mount failed'} ${JSON.stringify(debug)}`);
    }
    await configureImagePostNode(cdp, recorder, imagePostNodeId, imageSourceNodeId, assets);
    await waitForSelector(cdp, `[data-testid="post-result-mode-${imagePostNodeId}"]`);
    const imageResult = await generateAndAssert(cdp, recorder, imagePostNodeId, 'image', 'post-image-generated', assets);

    const videoSourceNodeId = await addNode(cdp, 'video', { x: 120, y: 760 });
    const videoPostNodeId = await addNode(cdp, 'post', { x: 620, y: 760 });
    await focusCanvasNode(cdp, videoPostNodeId);
    try {
      await waitForSelector(cdp, `[data-testid="post-node-${videoPostNodeId}"]`, 20000);
    } catch (error) {
      const debug = await collectNodeRenderDebug(cdp, videoPostNodeId);
      await recorder('post-video-node-mount-failed', { videoPostNodeId, debug });
      throw new Error(`${error instanceof Error ? error.message : 'post video node mount failed'} ${JSON.stringify(debug)}`);
    }
    await configureVideoPostNode(cdp, recorder, videoPostNodeId, videoSourceNodeId, assets);
    await waitForSelector(cdp, `[data-testid="post-result-mode-${videoPostNodeId}"]`);
    const videoResult = await generateAndAssert(cdp, recorder, videoPostNodeId, 'video', 'post-video-generated', assets);

    const summary = {
      mode: options.headless ? 'headless' : 'visible',
      appUrl,
      apiUrl,
      artifacts: runDir,
      imageSourceNodeId,
      imagePostNodeId,
      imageResultNodeId: imageResult.derivedId,
      imageResultUrl: imageResult.derivedUrl,
      imageSourceUnchanged: imageResult.sourceUnchanged,
      imageResultNodeCreated: imageResult.resultNodeCreated,
      imageNodeCountBefore: imageResult.nodeCountBefore,
      imageNodeCountAfter: imageResult.nodeCountAfter,
      videoSourceNodeId,
      videoPostNodeId,
      videoResultNodeId: videoResult.derivedId,
      videoResultUrl: videoResult.derivedUrl,
      videoSourceUnchanged: videoResult.sourceUnchanged,
      videoResultNodeCreated: videoResult.resultNodeCreated,
      videoNodeCountBefore: videoResult.nodeCountBefore,
      videoNodeCountAfter: videoResult.nodeCountAfter,
      verification: {
        originalAssetsUntouched: imageResult.sourceUnchanged && videoResult.sourceUnchanged,
        resultNodesCreated: imageResult.resultNodeCreated && videoResult.resultNodeCreated,
        resultUrlsPersisted: Boolean(imageResult.derivedUrl) && Boolean(videoResult.derivedUrl),
      },
    };
    await fs.writeFile(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
    log('Post browser verification completed', summary);
    return summary;
  } finally {
    if (!options.keepOpen) {
      if (cdp) {
        try {
          cdp.close();
        } catch {
          // noop
        }
      }
      for (const child of children.reverse()) {
        if (child !== apiChild && child !== appChild) {
          await terminateChild(child);
        }
      }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === ENTRY_FILE) {
  main()
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}







