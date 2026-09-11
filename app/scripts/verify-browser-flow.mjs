import { spawn } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browserCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

const chromePath = browserCandidates.find((item) => existsSync(item)) || browserCandidates[0];
let chromePort = Number(process.env.HMDAO_CHROME_PORT || 0);
const verifyApiPort = Number(process.env.HMDAO_VERIFY_API_PORT || 0);
const apiUrl = process.env.HMDAO_API_URL || (verifyApiPort > 0 ? 'http://127.0.0.1:' + verifyApiPort : 'http://127.0.0.1:8792');
process.env.HMDAO_API_TARGET = process.env.HMDAO_API_TARGET || apiUrl;
const apiPort = Number(new URL(apiUrl).port || (verifyApiPort || 8792));
process.env.HMDAO_API_PORT = process.env.HMDAO_API_PORT || String(apiPort);
let appPort = Number(process.env.HMDAO_APP_PORT || (apiPort === 8787 ? 3000 : 3300 + (apiPort % 100)));
let appUrl = process.env.HMDAO_APP_URL || `http://127.0.0.1:${appPort}`;
const realApiKey = String(process.env.HMDAO_REAL_API_KEY || process.env.HMDAO_SILICONFLOW_API_KEY || '').trim();
const relayApiKey = String(process.env.HMDAO_RELAY_API_KEY || realApiKey || '').trim();
const relayBaseUrl = String(process.env.HMDAO_RELAY_BASE_URL || process.env.HMDAO_VERIFY_RELAY_BASE_URL || '').trim().replace(/\/$/, '');
const relayProvider = String(process.env.HMDAO_RELAY_PROVIDER || 'siliconflow').trim() || 'siliconflow';
const relayImageModel = String(process.env.HMDAO_RELAY_IMAGE_MODEL || 'Qwen/Qwen-Image').trim();
const relayVideoModel = String(process.env.HMDAO_RELAY_VIDEO_MODEL || 'Wan-AI/Wan2.2-I2V-A14B').trim();
const assetLibraryFakeCustomApiModel = String(process.env.HMDAO_FAKE_IMAGE_ANALYSIS_MODEL || 'fake-vision-1').trim() || 'fake-vision-1';
const assetLibraryFakeCustomApiKey = String(process.env.HMDAO_FAKE_IMAGE_ANALYSIS_KEY || 'fake-local-key').trim() || 'fake-local-key';
const videoGenerationTimeoutMs = Number(process.env.HMDAO_VERIFY_VIDEO_TIMEOUT_MS || 420000);
const imageOnly = ['1', 'true', 'yes'].includes(String(process.env.HMDAO_VERIFY_IMAGE_ONLY || '').trim().toLowerCase());
const videoOnly = ['1', 'true', 'yes'].includes(String(process.env.HMDAO_VERIFY_VIDEO_ONLY || '').trim().toLowerCase());
const fullToolChain = ['1', 'true', 'yes'].includes(String(process.env.HMDAO_VERIFY_FULL_TOOL_CHAIN || '').trim().toLowerCase());
const quickMode = !fullToolChain && ['1', 'true', 'yes'].includes(String(process.env.HMDAO_VERIFY_QUICK || '').trim().toLowerCase());
const uiOnlyMode = ['1', 'true', 'yes'].includes(String(process.env.HMDAO_VERIFY_UI_ONLY || '').trim().toLowerCase()) || process.argv.includes('--ui-only');


import {
  parseCliOptions, sleep, log, assert, sanitizeFilePart,
  isLikelyMojibakeText, countMarkerHits, isLikelyUiDumpText,
  summarizeUiDumpText, summarizeCollapsedText, cleanCapturedText,
  summarizeCapturedUrl, sanitizeArtifactPayload, writeSummaryFile,
  isEdgePath, toPowerShellLiteral,
  normalizeUiOnlyRemoveSubtitleOutput, normalizeUiOnlyHdOutput,
  normalizeUiOnlyAudioSplitOutput,
  BAD_DEBUG_PORTS,
} from './verify-browser/lib/verify-helpers.mjs';

// Pure helpers extracted for incremental decoupling (see verify-pure.mjs).
// These are side-effect-free and were previously defined inline in this file.
import {
  isLocalHostName, roundMetric, normalizeReferenceWeight, normalizeConsoleEntry,
  summarizeConsoleWarnings, buildReferenceImageConsistencyResult,
  buildReferenceVideoConsistencyResult, buildConditioningRoleMappingResult,
  buildImageRouteExpectationResult, buildVideoRouteExpectationResult,
  buildCatalogAliasExpectationResult, assertStableViewport, assertNoConsoleWarnings,
  assertVideoOutputIntegrity, VERIFY_VIDEO_TOOL_OPERATIONS,
  UI_ONLY_WORKFLOW_BROWSER_HELPERS, assetLibraryFakeCustomApiProvider,
  assetLibraryFakeCustomApiMode,
} from './verify-browser/lib/verify-pure.mjs';

// Kept in the main module on purpose: it reads the mutable module-level appUrl.
function toAbsoluteMediaUrl(resourceUrl) {
  const value = String(resourceUrl || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('/')) {
    return new URL(value, appUrl).toString();
  }
  return value;
}


async function requestUiOnlyLocalVideoEdit(operation, sourceUrl, payload = {}) {
  const controller = new AbortController();
  const timeoutMs = Number(process.env.HMDAO_VERIFY_LOCAL_VIDEO_EDIT_TIMEOUT_MS || 45000);
  const timer = setTimeout(() => controller.abort(new Error(`ui-only-local-video-edit-timeout:${operation}:${timeoutMs}`)), timeoutMs);
  let response;
  try {
    response = await fetch(`${apiUrl}/api/local-video/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operation,
        sourceUrl: toAbsoluteMediaUrl(sourceUrl),
        ...payload,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`ui-only-local-video-edit-request-failed:${operation}:${message}`);
  } finally {
    clearTimeout(timer);
  }
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.success) {
    throw new Error(result?.error?.message || `ui-only-local-video-edit-failed:${operation}:${response.status}`);
  }
  return result;
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
  if (!BAD_DEBUG_PORTS.has(firstPort)) {
    return firstPort;
  }
  for (let attempts = 0; attempts < 25; attempts += 1) {
    const nextPort = await reservePort(0);
    if (!BAD_DEBUG_PORTS.has(nextPort)) {
      return nextPort;
    }
  }
  throw new Error(`Unable to reserve a safe browser debugging port. Initial candidate ${firstPort} is blocked.`);
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

function start(command, args, name, cwd, children) {
  const isCmdScript = /\.cmd$/i.test(command);
  const spawnCommand = isCmdScript ? process.env.ComSpec || 'cmd.exe' : command;
  const spawnArgs = isCmdScript ? ['/d', '/s', '/c', command, ...args] : args;
  const child = spawn(spawnCommand, spawnArgs, {
    cwd,
    stdio: ['ignore', 'inherit', 'inherit'],
    shell: false,
    windowsHide: true,
  });
  child._hmdaoName = name;
  children.push(child);
  return child;
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
    await sleep(350);
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

async function isLocalTcpReady(url, timeoutMs = 1200) {
  try {
    const target = new URL(url);
    if (!isLocalHostName(target.hostname)) return false;
    const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
    if (!Number.isFinite(port) || port <= 0) return false;
    return await new Promise((resolve) => {
      const socket = createConnection({ host: target.hostname, port });
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        try {
          socket.destroy();
        } catch {
          // noop
        }
        resolve(value);
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
      socket.once('close', () => finish(false));
    });
  } catch {
    return false;
  }
}

async function isHttpReady(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1800);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return await isLocalTcpReady(url);
  }
}

async function ensureService(name, url, startFn) {
  if (await isHttpReady(url)) {
    log(`Reusing running ${name}`);
    return null;
  }
  log(`Starting ${name}...`);
  const child = startFn();
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await waitForHttp(url, 45000);
      log(`${name} is ready`);
      return child;
    } catch (error) {
      lastError = error;
      await sleep(600 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || `${name} failed to start`));
}
async function prewarmViteModules(baseUrl, modulePaths = []) {
  const uniquePaths = Array.from(new Set(modulePaths.map((item) => String(item || '').trim()).filter(Boolean)));
  if (uniquePaths.length === 0) return;
  log('vite-prewarm:start', { baseUrl, moduleCount: uniquePaths.length, modulePaths: uniquePaths });
  const warmed = [];
  for (const modulePath of uniquePaths) {
    const targetUrl = new URL(modulePath, baseUrl).toString();
    const startedAt = Date.now();
    log('vite-prewarm:module:start', { modulePath, targetUrl });
    try {
      const response = await waitForHttp(targetUrl, 45000);
      const result = {
        modulePath,
        ok: response.ok,
        status: response.status,
        durationMs: Date.now() - startedAt,
      };
      warmed.push(result);
      log('vite-prewarm:module:done', result);
    } catch (error) {
      const result = {
        modulePath,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      };
      warmed.push(result);
      log('vite-prewarm:module:failed', result);
    }
  }
  log('vite-prewarm:completed', warmed);
}

async function terminateChild(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
        stdio: 'ignore',
        shell: false,
        windowsHide: true,
      });
      killer.on('error', () => resolve());
      killer.on('exit', () => resolve());
    });
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // noop
  }
}

async function connectCdp(preferredTargets = []) {
  log('connectCdp:start', { chromePort, preferredTargets });
  await waitForHttp(`http://127.0.0.1:${chromePort}/json/version`, 30000);
  log('connectCdp:version-ready', { chromePort });
  const preferredNeedles = preferredTargets
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  const started = Date.now();
  let orderedTargets = [];
  while (orderedTargets.length === 0 && Date.now() - started < 15000) {
    const targets = await (await fetch(`http://127.0.0.1:${chromePort}/json/list`)).json();
    log('connectCdp:list-fetched', { totalTargets: Array.isArray(targets) ? targets.length : 0 });
    const pageTargets = targets.filter((item) => item.type === 'page' && item.webSocketDebuggerUrl);
    orderedTargets = [
      ...pageTargets.filter((item) => preferredNeedles.some((needle) => String(item.url || '').includes(needle) || String(item.title || '').includes(needle))),
      ...pageTargets.filter((item) => String(item.url || '').startsWith(appUrl)),
      ...pageTargets.filter((item) => String(item.url || '').includes('skipLaunch=1')),
      ...pageTargets,
    ].filter((item, index, array) => array.findIndex((entry) => entry.id === item.id) === index);
    if (orderedTargets.length === 0) await sleep(250);
  }
  if (orderedTargets.length === 0) throw new Error('Unable to find a browser page target for CDP.');
  log('connectCdp:ordered-targets', orderedTargets.map((item) => ({
    id: String(item?.id || ''),
    url: String(item?.url || ''),
    title: String(item?.title || ''),
  })));

  const createClient = async (target) => {
    log('connectCdp:create-client', {
      id: String(target?.id || ''),
      url: String(target?.url || ''),
      title: String(target?.title || ''),
    });
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

    socket.addEventListener('close', () => {
      for (const { reject } of pending.values()) reject(new Error('CDP socket closed before the command completed.'));
      pending.clear();
      listeners.clear();
    });

    return {
      target,
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
      async close() {
        if (socket.readyState === WebSocket.CLOSED) return;
        await new Promise((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            resolve();
          };
          socket.addEventListener('close', finish, { once: true });
          socket.addEventListener('error', finish, { once: true });
          try {
            socket.close();
          } catch {
            finish();
          }
          setTimeout(finish, 1200).unref?.();
        });
      },
    };
  };

  const probeClientPage = async (client, timeoutMs = 8000) => {
    const startedAt = Date.now();
    let actualHref = '';
    let actualTitle = '';
    let attempt = 0;
    while (Date.now() - startedAt < timeoutMs) {
      attempt += 1;
      log('connectCdp:probe-iteration-begin', { attempt, timeoutMs });
      try {
        const hrefResult = await client.send('Runtime.evaluate', {
          expression: 'String(location.href || "")',
          returnByValue: true,
          awaitPromise: true,
          timeout: 5000,
        });
        const titleResult = await client.send('Runtime.evaluate', {
          expression: 'String(document.title || "")',
          returnByValue: true,
          awaitPromise: true,
          timeout: 5000,
        });
        actualHref = String(hrefResult?.result?.value || '');
        actualTitle = String(titleResult?.result?.value || '');
        log('connectCdp:probe-iteration-result', { attempt, actualHref, actualTitle });
      } catch (error) {
        log('connectCdp:probe-iteration-error', { attempt, error: String(error?.message || error) });
        throw error;
      }
      if (actualHref && !actualHref.startsWith('about:blank')) {
        return { actualHref, actualTitle };
      }
      await sleep(250);
    }
    log('connectCdp:probe-timeout', { timeoutMs, actualHref, actualTitle, attempt });
    return { actualHref, actualTitle };
  };

  for (const target of orderedTargets) {
    const client = await createClient(target);
    try {
      log('connectCdp:probe-begin', {
        candidateUrl: String(target.url || ''),
        candidateTitle: String(target.title || ''),
      });
      await client.send('Runtime.enable');
      const { actualHref, actualTitle } = await probeClientPage(client);
      log('connectCdp:probe-finished', {
        candidateUrl: String(target.url || ''),
        candidateTitle: String(target.title || ''),
        actualHref,
        actualTitle,
      });
      log('connectCdp:target-probe', {
        candidateUrl: String(target.url || ''),
        candidateTitle: String(target.title || ''),
        actualHref,
        actualTitle,
      });
      const metadataMatch = preferredNeedles.some((needle) => String(target.url || '').includes(needle) || String(target.title || '').includes(needle));
      const actualMatch = preferredNeedles.some((needle) => actualHref.includes(needle) || actualTitle.includes(needle));
      if (actualMatch || (metadataMatch && !actualHref.startsWith('about:blank'))) {
        log('connectCdp:target-selected', {
          url: String(target.url || ''),
          title: String(target.title || ''),
          actualHref,
          actualTitle,
          preferredNeedles,
        });
        return client;
      }
    } catch (error) {
      log('connectCdp:target-probe-error', {
        candidateUrl: String(target.url || ''),
        candidateTitle: String(target.title || ''),
        error: String(error?.message || error),
      });
    }
    await client.close().catch(() => {});
  }

  const preferredUrl = preferredNeedles.find((item) => /^https?:\/\//i.test(item));
  if (preferredUrl) {
    try {
      const response = await fetch(`http://127.0.0.1:${chromePort}/json/new?${encodeURIComponent(preferredUrl)}`, {
        method: 'PUT',
      });
      if (response.ok) {
        const newTarget = await response.json();
        log('connectCdp:opened-new-target', {
          preferredUrl,
          targetUrl: String(newTarget?.url || ''),
          targetTitle: String(newTarget?.title || ''),
        });
        const client = await createClient(newTarget);
        await client.send('Runtime.enable');
        const { actualHref, actualTitle } = await probeClientPage(client, 12000);
        log('connectCdp:new-target-probe', { preferredUrl, actualHref });
        if (!actualHref || actualHref.startsWith('about:blank')) {
          await client.close().catch(() => {});
        } else {
        log('connectCdp:target-selected', {
          url: String(newTarget?.url || ''),
          title: String(newTarget?.title || ''),
          actualHref,
          actualTitle,
          preferredNeedles,
        });
        return client;
        }
      }
      log('connectCdp:new-target-open-failed', {
        preferredUrl,
        status: response.status,
        statusText: response.statusText,
      });
    } catch (error) {
      log('connectCdp:new-target-open-error', {
        preferredUrl,
        error: String(error?.message || error),
      });
    }
  }

  const fallbackTarget = orderedTargets[0];
  log('connectCdp:target-selected-fallback', {
    url: String(fallbackTarget.url || ''),
    title: String(fallbackTarget.title || ''),
    preferredNeedles,
  });
  return await createClient(fallbackTarget);
}

async function evalJs(cdp, expression, timeoutMs = 30000) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    timeout: timeoutMs,
  });
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    throw new Error(details.exception?.description || details.text || 'Browser evaluation failed');
  }
  return result.result?.value;
}

async function waitFor(cdp, expression, timeoutMs = 30000, intervalMs = 250) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await evalJs(cdp, expression, Math.min(timeoutMs, 5000));
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  if (lastError) throw lastError;
  throw new Error(`Timed out waiting for expression: ${expression}`);
}

async function withExternalTimeout(run, timeoutMs, label) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForSelector(cdp, selector, timeoutMs = 30000) {
  await waitFor(cdp, `!!document.querySelector(${JSON.stringify(selector)})`, timeoutMs);
}

async function navigateAndWait(cdp, url, readyExpression) {
  try {
    await Promise.race([
      cdp.send('Page.navigate', { url }),
      sleep(5000).then(() => {
        throw new Error(`Page.navigate timeout for ${url}`);
      }),
    ]);
  } catch {
    await cdp.send('Runtime.evaluate', {
      expression: `window.location.replace(${JSON.stringify(url)}); true;`,
      awaitPromise: false,
      returnByValue: true,
    });
  }
  await waitFor(cdp, 'Boolean(document.body) || Boolean(document.getElementById("root"))', 60000);
  await waitFor(cdp, readyExpression, 60000);
}

function buildUiOnlyCanvasUrl(reset = false, demo = 'video-local-edit') {
  const next = new URL(`${appUrl}${appUrl.includes('?') ? '&' : '?'}hmdao-demo=video-local-edit`);
  next.searchParams.set('skipLaunch', '1');
  next.searchParams.set('hmdao-demo', demo);
  if (reset) {
    next.searchParams.set('hmdao-demo-reset', '1');
  } else {
    next.searchParams.delete('hmdao-demo-reset');
  }
  return next.toString();
}

function buildCleanUiOnlyAppUrl() {
  const next = new URL(appUrl);
  next.searchParams.set('skipLaunch', '1');
  next.searchParams.delete('hmdao-demo');
  next.searchParams.delete('hmdao-demo-reset');
  return next.toString();
}

async function waitForRoot(cdp, timeoutMs = 60000) {
  await waitFor(cdp, 'Boolean(document.getElementById("root")) && Boolean(document.body)', timeoutMs, 150);
}

async function installDebugBridgeFallback(cdp) {
  await evalJs(cdp, `
    (async () => {
      const status = window.__HMDAO_DEBUG_FALLBACK_STATUS__ || (window.__HMDAO_DEBUG_FALLBACK_STATUS__ = {});
      status.startedAt = new Date().toISOString();
      status.phase = 'starting';
      if (window.__HMDAO_DEBUG__?.canvasStore && typeof window.__HMDAO_DEBUG__?.readCanvasSnapshot === 'function') {
        status.phase = 'already-available';
        status.ready = true;
        return true;
      }
      const scriptSources = Array.from(document.scripts || []).map((script) => String(script?.src || ''));
      const isViteSourcePage = Boolean(window.__vite_plugin_react_preamble_installed__)
        || scriptSources.some((src) => src.includes('/src/') || src.includes('/@vite/'));
      if (!isViteSourcePage) {
        status.phase = 'skipped-static-dist';
        status.ready = false;
        status.skipped = true;
        status.reason = 'native-debug-bridge-required';
        status.scriptSources = scriptSources.slice(-6);
        return false;
      }
      try {
        status.phase = 'importing';
        const [
          apiKeyMod,
          assetMod,
          canvasMod,
          localMediaMod,
          workflowMod,
        ] = await Promise.all([
          import('/src/store/useApiKeyStore.ts'),
          import('/src/store/useAssetStore.ts'),
          import('/src/store/useCanvasStore.ts'),
          import('/src/services/localMediaRegistry.ts'),
          import('/src/services/workflow/index.ts'),
        ]);
        status.phase = 'binding';
        const useApiKeyStore = apiKeyMod.useApiKeyStore;
        const useAssetStore = assetMod.useAssetStore;
        const useCanvasStore = canvasMod.useCanvasStore;
        const registerLocalMedia = localMediaMod.registerLocalMedia;
        const getWorkflowClient = workflowMod.getWorkflowClient;
        const readCanvasSnapshot = () => {
          const state = useCanvasStore.getState();
          const selectedNodeIds = Array.isArray(state.selectedNodeIds) ? [...state.selectedNodeIds] : [];
          const selectedNodes = state.canvas?.nodes?.filter((node) => selectedNodeIds.includes(node.id)) || [];
          return {
            selectedNodeIds,
            nodeCount: state.canvas?.nodes?.length || 0,
            selectedNodes: selectedNodes.map((node) => ({
              id: node.id,
              type: node.type,
              status: node.data?.status,
              prompt: node.data?.prompt,
              model: node.data?.model,
              provider: node.data?.provider,
              imageUrl: node.data?.imageUrl,
              videoUrl: node.data?.videoUrl,
              outputCount: Array.isArray(node.data?.outputs) ? node.data.outputs.length : 0,
              params: node.data?.params || {},
              error: node.data?.error,
            })),
          };
        };
        window.__HMDAO_DEBUG__ = {
          ...(window.__HMDAO_DEBUG__ || {}),
          apiKeyStore: useApiKeyStore,
          assetStore: useAssetStore,
          canvasStore: useCanvasStore,
          workflowClient: getWorkflowClient(),
          registerLocalMedia,
          reactFlow: window.__HMDAO_DEBUG__?.reactFlow || {
            fitView: () => false,
            getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
            setCenter: () => false,
          },
          readCanvasSnapshot,
        };
        status.phase = 'ready';
        status.ready = true;
        status.hasCanvasStore = Boolean(window.__HMDAO_DEBUG__?.canvasStore);
        status.hasReadCanvasSnapshot = typeof window.__HMDAO_DEBUG__?.readCanvasSnapshot === 'function';
        return true;
      } catch (error) {
        status.phase = 'error';
        status.ready = false;
        status.error = String(error?.message || error || 'unknown-debug-bridge-error');
        return false;
      }
    })()
  `, 10000);
  return true;
}

async function waitForDebugBridge(cdp, timeoutMs = 60000) {
  const bridgeStateExpression = `
    (() => {
      const debug = window.__HMDAO_DEBUG__;
      const fallback = window.__HMDAO_DEBUG_FALLBACK_STATUS__ || null;
      return {
        href: String(location.href || ''),
        title: String(document.title || ''),
        readyState: String(document.readyState || ''),
        hasRoot: Boolean(document.getElementById('root')),
        hasBody: Boolean(document.body),
        hasDebug: Boolean(debug),
        hasCanvasStore: Boolean(debug?.canvasStore),
        hasReadCanvasSnapshot: typeof debug?.readCanvasSnapshot === 'function',
        fallback,
      };
    })()
  `;
  const initialState = await evalJs(cdp, bridgeStateExpression, 10000).catch(() => null);
  log('waitForDebugBridge:initial-state', initialState);
  try {
    await waitFor(cdp, `
      (() => {
        const debug = window.__HMDAO_DEBUG__;
        return Boolean(
          debug
          && debug.canvasStore
          && typeof debug.canvasStore.getState === 'function'
          && typeof debug.readCanvasSnapshot === 'function'
        );
      })()
    `, Math.min(timeoutMs, 12000), 150);
    const readyState = await evalJs(cdp, bridgeStateExpression, 10000).catch(() => null);
    log('waitForDebugBridge:ready-native', readyState);
  } catch {
    const missingNativeState = await evalJs(cdp, bridgeStateExpression, 10000).catch(() => null);
    log('waitForDebugBridge:native-missing', missingNativeState);
    await installDebugBridgeFallback(cdp);
    const afterInstallState = await evalJs(cdp, bridgeStateExpression, 10000).catch(() => null);
    log('waitForDebugBridge:after-install', afterInstallState);
    const fallbackSkipped = Boolean(afterInstallState?.fallback?.skipped);
    await waitFor(cdp, `
      (() => {
        const debug = window.__HMDAO_DEBUG__;
        return Boolean(
          debug
          && debug.canvasStore
          && typeof debug.canvasStore.getState === 'function'
          && typeof debug.readCanvasSnapshot === 'function'
        );
      })()
    `, timeoutMs, 150);
    const readyFallbackState = await evalJs(cdp, bridgeStateExpression, 10000).catch(() => null);
    log(fallbackSkipped ? 'waitForDebugBridge:ready-native-after-skip' : 'waitForDebugBridge:ready-fallback', readyFallbackState);
  }
}

async function waitForDemoCanvasReady(cdp, expectedMinVideoNodes = 1, timeoutMs = 120000) {
  await waitFor(cdp, `
    (() => {
      const debug = window.__HMDAO_DEBUG__;
      const store = debug?.canvasStore?.getState?.();
      const nodes = Array.isArray(store?.canvas?.nodes) ? store.canvas.nodes : [];
      const storeVideoCount = nodes.filter((item) => String(item?.type || '') === 'video').length;
      const domVideoNodes = Array.from(document.querySelectorAll('[data-testid^="video-node-"]'));
      const domAudioNodes = Array.from(document.querySelectorAll('[data-testid^="audio-node-"]'));
      const domStoryboardNodes = Array.from(document.querySelectorAll('[data-testid^="storyboard-node-"]'));
      const domVideoCount = domVideoNodes.length;
      const effectiveVideoCount = Math.max(storeVideoCount, domVideoCount);
      return effectiveVideoCount >= ${Number(expectedMinVideoNodes)}
        ? {
            nodeCount: Math.max(nodes.length, domVideoNodes.length + domAudioNodes.length + domStoryboardNodes.length),
            videoCount: effectiveVideoCount,
            audioCount: domAudioNodes.length,
            storyboardCount: domStoryboardNodes.length,
            labels: nodes.length > 0
              ? nodes.map((item) => String(item?.data?.label || ''))
              : domVideoNodes
                .map((item) => item.querySelector('button')?.textContent || item.textContent || '')
                .map((item) => String(item || '').trim())
                .filter(Boolean)
                .slice(0, 12),
          }
        : null;
    })()
  `, timeoutMs, 200);
}

async function ensureCanvasReady(cdp, options = {}) {
  const resetDemo = Boolean(options.resetDemo);
  const expectedMinVideoNodes = Number(options.expectedMinVideoNodes || 0);
  const desiredDemo = uiOnlyMode ? 'video-local-edit' : '';
  const ready = await evalJs(cdp, `
    (() => {
      const debug = window.__HMDAO_DEBUG__;
      const url = new URL(location.href);
      return {
        pathname: String(location.pathname || ''),
        href: String(location.href || ''),
        hmdaoDemo: String(url.searchParams.get('hmdao-demo') || ''),
        hmdaoDemoReset: String(url.searchParams.get('hmdao-demo-reset') || ''),
        hasRoot: Boolean(document.getElementById('root')),
        hasDebug: Boolean(debug?.canvasStore && typeof debug?.readCanvasSnapshot === 'function'),
      };
    })()
  `, 10000).catch(() => null);

  const targetUrl = uiOnlyMode ? buildUiOnlyCanvasUrl(resetDemo) : appUrl;
  const shouldNavigate = !ready?.hasRoot
    || !ready?.hasDebug
    || ready?.pathname !== '/'
    || (uiOnlyMode && expectedMinVideoNodes > 0 && ready?.hmdaoDemo !== desiredDemo)
    || (uiOnlyMode && resetDemo);

  if (shouldNavigate) {
    await navigateAndWait(cdp, targetUrl, 'location.pathname === "/" && !!document.getElementById("root") && !!document.body');
  }

  await waitForRoot(cdp);
  await waitForDebugBridge(cdp);
  await evalJs(cdp, `
    (() => {
      const canvasStore = window.__HMDAO_DEBUG__?.canvasStore;
      const state = canvasStore?.getState?.();
      if (typeof state?.setSidebarTab === 'function') {
        state.setSidebarTab('add');
      }
      if (typeof canvasStore?.setState === 'function') {
        canvasStore.setState((draft) => {
          draft.activeSidebarTab = 'add';
          draft.sidebarCollapsed = false;
        });
      }
      return true;
    })()
  `, 10000).catch(() => false);
  await waitFor(cdp, `
    (() => {
      const bodyText = String(document.body?.textContent || '');
      const loading = bodyText.includes('正在加载 DDUp');
      const stableUi = Boolean(
        document.querySelector('[data-testid="add-node-image"]')
        || document.querySelector('[data-testid="canvas-board"]')
        || document.querySelector('[data-testid="workflow-toolbar"]')
        || window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas
      );
      return !loading && stableUi;
    })()
  `, 60000, 200);
  if (uiOnlyMode && expectedMinVideoNodes > 0) {
    await waitForDemoCanvasReady(cdp, expectedMinVideoNodes);
  }
}

async function openApiKeysRoute(cdp) {
  const providerSelector = '[data-testid="api-key-provider"], [data-testid="api-relay-base-url"]';
  try {
    await navigateAndWait(cdp, appUrl, 'location.pathname === "/" && !!document.body');
    await waitFor(cdp, `
      (() => {
        return Boolean(document.getElementById('root'));
      })()
    `, 30000, 200);
    await evalJs(cdp, `
      (() => {
        if (location.pathname === '/settings/api-keys') return true;
        window.history.pushState({}, '', '/settings/api-keys');
        window.dispatchEvent(new PopStateEvent('popstate'));
        return true;
      })()
    `, 10000);
    await waitFor(cdp, 'location.pathname === "/settings/api-keys"', 10000, 100);
    await waitForSelector(cdp, providerSelector, 30000);
  } catch {
    await navigateAndWait(cdp, appUrl + '/settings/api-keys', 'location.pathname === "/settings/api-keys" && !!document.body');
    await waitForSelector(cdp, providerSelector, 30000);
  }
}

async function screenshot(cdp, filePath) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await fs.writeFile(filePath, Buffer.from(result.data, 'base64'));
}

async function defineNativeSetter(cdp) {
  await evalJs(cdp, `
    window.__setNativeValue = function(element, value) {
      if (!element) return false;
      var descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
      if (descriptor && descriptor.set) {
        descriptor.set.call(element, value);
      } else {
        element.value = value;
      }
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    true;
  `);
}

async function installBootstrapState(cdp) {
  const authPayload = {
    state: {
      user: { id: 'browser-verify', email: 'browser-verify@hmdao.local', createdAt: new Date().toISOString() },
      session: { accessToken: 'browser-verify', refreshToken: 'browser-verify-refresh', expiresAt: Date.now() + 3600000 },
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
      try {
        if (!localStorage.getItem('hmdao-auth-storage')) {
          localStorage.setItem('hmdao-auth-storage', ${JSON.stringify(JSON.stringify(authPayload))});
        }
      } catch {}
      try {
        if (!localStorage.getItem('hmdao-api-keys')) {
          localStorage.setItem('hmdao-api-keys', ${JSON.stringify(JSON.stringify(apiKeysPayload))});
        }
      } catch {}
      try { window.showOpenFilePicker = undefined; } catch {}
      try { Object.assign(window, ${JSON.stringify(runtimeBootstrap)}); } catch {}
      window.__setNativeValue = function(element, value) {
        if (!element) return false;
        var descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
        if (descriptor && descriptor.set) {
          descriptor.set.call(element, value);
        } else {
          element.value = value;
        }
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

async function invokeReactClick(cdp, selector) {
  const ok = await evalJs(cdp, `
    (() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return false;
      const reactPropsKey = Object.keys(element).find((key) => key.startsWith('__reactProps$'));
      const props = reactPropsKey ? element[reactPropsKey] : null;
      const stubEvent = {
        currentTarget: element,
        target: element,
        preventDefault() {},
        stopPropagation() {},
      };
      if (props?.onPointerDown) props.onPointerDown(stubEvent);
      if (props?.onMouseDown) props.onMouseDown(stubEvent);
      if (props?.onClick) {
        props.onClick(stubEvent);
        return true;
      }
      if (typeof element.click === 'function') {
        element.click();
        return true;
      }
      return false;
    })()
  `, 10000);
  if (!ok) throw new Error(`Unable to invoke React click for selector: ${selector}`);
}

async function clearCanvasSelection(cdp) {
  const result = await evalJs(cdp, `
    (() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      if (!store || typeof store.setSelectedNodeIds !== 'function') return false;
      store.setSelectedNodeIds([]);
      return true;
    })()
  `, 10000);
  return result;
}

async function setValue(cdp, selector, value, options = {}) {
  const timeoutMs = Math.max(250, Number(options.timeoutMs || 4000));
  await waitFor(cdp, `!!document.querySelector(${JSON.stringify(selector)})`, timeoutMs, 100).catch(() => false);
  const result = await evalJs(cdp, `
    (() => {
      const rawValue = ${JSON.stringify(value)};
      const applyValue = (element) => {
        if (!element) return false;
        const prototype = Object.getPrototypeOf(element);
        const descriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, 'value') : null;
        if (descriptor && typeof descriptor.set === 'function') {
          descriptor.set.call(element, rawValue);
        } else {
          element.value = rawValue;
        }
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      };
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return { ok: false, reason: 'missing' };
      if (applyValue(element)) {
        return { ok: true, tagName: element.tagName, type: element.type || '' };
      }
      const container = element.closest('label, [data-testid], .grid, .flex') || element.parentElement;
      const fallbackTargets = container
        ? Array.from(container.querySelectorAll('input[type="number"], input[type="range"], select, textarea'))
        : [];
      for (const candidate of fallbackTargets) {
        if (candidate === element) continue;
        if (applyValue(candidate)) {
          return {
            ok: true,
            tagName: candidate.tagName,
            type: candidate.type || '',
            usedFallback: true,
          };
        }
      }
      return {
        ok: false,
        reason: 'apply-failed',
        tagName: element.tagName,
        type: element.type || '',
      };
    })()
  `);
  if (!result?.ok) {
    throw new Error(`Unable to set value for selector: ${selector} (${JSON.stringify(result)})`);
  }
}

async function patchVideoToolConfig(cdp, nodeId, tool, patch) {
  const ok = await evalJs(cdp, `
    (() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      const updateNodeData = store?.updateNodeData;
      const canvas = store?.canvas;
      const node = canvas?.nodes?.find((item) => item.id === ${JSON.stringify(nodeId)});
      if (!node || typeof updateNodeData !== 'function') return false;
      const params = node.data?.params || {};
      const currentConfig = params.videoToolConfig || {};
      updateNodeData(${JSON.stringify(nodeId)}, {
        params: {
          ...params,
          videoTool: ${JSON.stringify(tool)},
          videoToolOperation: ${JSON.stringify(VERIFY_VIDEO_TOOL_OPERATIONS)}[${JSON.stringify(tool)}] || String(params.videoToolOperation || ''),
          videoToolConfig: {
            ...currentConfig,
            ...${JSON.stringify(patch)},
          },
        },
      });
      return true;
    })()
  `, 10000).catch(() => false);
  if (!ok) {
    throw new Error(`Unable to patch video tool config for node ${nodeId}`);
  }
}

async function replaceVideoToolState(cdp, nodeId, tool, nextConfig, extraPatch = {}) {
  const ok = await evalJs(cdp, `
    (() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      const updateNodeData = store?.updateNodeData;
      const canvas = store?.canvas;
      const node = canvas?.nodes?.find((item) => item.id === ${JSON.stringify(nodeId)});
      if (!node || typeof updateNodeData !== 'function') return false;
      const params = node.data?.params || {};
      updateNodeData(${JSON.stringify(nodeId)}, {
        params: {
          ...params,
          ...${JSON.stringify(extraPatch)},
          videoTool: ${JSON.stringify(tool)},
          videoToolOperation: ${JSON.stringify(VERIFY_VIDEO_TOOL_OPERATIONS)}[${JSON.stringify(tool)}] || '',
          videoToolConfig: ${JSON.stringify(nextConfig && typeof nextConfig === 'object' ? nextConfig : {})},
        },
      });
      return true;
    })()
  `, 10000).catch(() => false);
  if (!ok) {
    throw new Error(`Unable to replace video tool state for node ${nodeId}`);
  }
}

async function setVideoToolControlValue(cdp, nodeId, tool, selectors, value, patch, options = {}) {
  const timeoutMs = Math.max(250, Number(options.timeoutMs || 1500));
  for (const selector of selectors) {
    try {
      await setValue(cdp, selector, String(value), { timeoutMs });
      return { appliedVia: 'dom', selector };
    } catch {}
  }
  await patchVideoToolConfig(cdp, nodeId, tool, patch);
  return { appliedVia: 'store', selector: null };
}

async function setVideoRemoveSubtitleConfig(cdp, nodeId, patch) {
  if (patch.detectionMode !== undefined) {
    let applied = false;
    for (const selector of [
      `[data-testid="video-remove-mode-panel-${nodeId}"]`,
      `[data-testid="video-remove-mode-${nodeId}"]`,
    ]) {
      try {
        await setValue(cdp, selector, String(patch.detectionMode), { timeoutMs: 1500 });
        applied = true;
        break;
      } catch {}
    }
    if (!applied) {
      await patchVideoToolConfig(cdp, nodeId, 'removeSubtitle', { detectionMode: patch.detectionMode });
    }
  }
  if (patch.maskFeather !== undefined) {
    let applied = false;
    for (const selector of [
      `[data-testid="video-remove-feather-panel-${nodeId}"]`,
      `[data-testid="video-remove-feather-${nodeId}"]`,
    ]) {
      try {
        await setValue(cdp, selector, String(patch.maskFeather), { timeoutMs: 1500 });
        applied = true;
        break;
      } catch {}
    }
    if (!applied) {
      await patchVideoToolConfig(cdp, nodeId, 'removeSubtitle', { maskFeather: Number(patch.maskFeather) });
    }
  }
}

async function runUiOnlyLocalParse(cdp, nodeId, patch = {}) {
  const nextConfig = {
    tool: 'parse',
    sampleFps: 5,
    semanticEngine: 'local-heuristic',
    ...(patch && typeof patch === 'object' ? patch : {}),
  };
  await replaceVideoToolState(cdp, nodeId, 'parse', nextConfig, {
    localVideoEditTool: 'parse',
    lastError: '',
    lastErrorCategory: '',
    lastErrorStage: '',
    error: '',
  });
  log('ui-only parse:state-reset', { nodeId, config: nextConfig });
  const result = await evalJs(cdp, `
    (async () => {
      ${UI_ONLY_WORKFLOW_BROWSER_HELPERS}
      const debug = window.__HMDAO_DEBUG__ || {};
      const storeApi = debug.canvasStore;
      const state = storeApi?.getState?.();
      const addNode = state?.addNode;
      const addEdge = state?.addEdge;
      const updateNodeData = state?.updateNodeData;
      const setSelectedNodeIds = state?.setSelectedNodeIds;
      const canvas = state?.canvas;
      const sourceNode = canvas?.nodes?.find((item) => item.id === ${JSON.stringify(nodeId)});
      if (!sourceNode || typeof addNode !== 'function' || typeof addEdge !== 'function' || typeof updateNodeData !== 'function') {
        return { ok: false, error: 'ui-only-parse-store-unavailable' };
      }
      const params = sourceNode.data?.params || {};
      const connectedInputs = Array.isArray(sourceNode.data?.inputs) ? sourceNode.data.inputs.filter((item) => item && typeof item === 'object') : [];
      const primaryInputs = connectedInputs.filter((item) => item.channel === 'primary');
      const referenceInputs = connectedInputs.filter((item) => item.channel !== 'primary');
      const identityController = hmdaoReadIdentityControllerConfig(params.identityController, referenceInputs);
      const nextConfig = {
        ...(params.videoToolConfig && typeof params.videoToolConfig === 'object' ? params.videoToolConfig : {}),
        tool: 'parse',
        sampleFps: 5,
        semanticEngine: 'local-heuristic',
        ...${JSON.stringify(patch)},
      };
      const sourceUrl = String(sourceNode.data?.videoUrl || '');
      if (!sourceUrl) {
        return { ok: false, error: 'ui-only-parse-missing-video-url' };
      }
      updateNodeData(${JSON.stringify(nodeId)}, {
        status: 'generating',
        params: {
          ...params,
          videoTool: 'parse',
          videoToolOperation: ${JSON.stringify(VERIFY_VIDEO_TOOL_OPERATIONS.parse)},
          videoToolConfig: nextConfig,
        },
      });
      const svgThumb = (index, title) => {
        const svg = \`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><defs><linearGradient id="g\${index}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#172554"/><stop offset="1" stop-color="#0f766e"/></linearGradient></defs><rect width="320" height="180" fill="url(#g\${index})"/><text x="24" y="86" fill="#e6fffb" font-size="18" font-family="Arial">\${title}</text><text x="24" y="116" fill="#99f6e4" font-size="12" font-family="Arial">HMDAO UI-only Parse</text></svg>\`;
        return btoa(unescape(encodeURIComponent(svg)));
      };
      const buildFallbackAnalysis = () => {
        const width = Math.max(2, Number(params.videoMeta?.width || sourceNode.data?.videoMeta?.width || 1280));
        const height = Math.max(2, Number(params.videoMeta?.height || sourceNode.data?.videoMeta?.height || 720));
        const duration = Math.max(1, Number(sourceNode.data?.duration || params.videoMeta?.duration || 5));
        const splitPoint = Math.max(0.5, Math.min(duration - 0.25, duration * 0.5));
        const rows = [
          {
            shotNumber: 1,
            startTime: 0,
            endTime: Number(splitPoint.toFixed(2)),
            duration: Number(splitPoint.toFixed(2)),
            subjectCount: 1,
            subjectSummary: '主体角色',
            subjectTraits: '外观与主视频保持一致',
            actionSummary: '主体进入画面并建立动作起点',
            sceneSetting: '沿用原视频场景结构',
            storyboardPurpose: '建立镜头与主体关系',
            lensSuggestion: '中景',
            frameDescription: '镜头保留原始构图，主体位于核心视觉区。',
            narrativeBeat: '起势',
            sceneType: '建立镜头',
            cameraAngle: '平视',
            cameraMovement: '保留原运镜',
            focusDepth: '主体清晰，背景适度分离',
            lighting: '延续原场景主光与环境光',
            soundDesign: '保留原声节奏参考',
            cameraPrompt: '保持原始构图与运镜，不改变镜头节奏',
            imagePrompt: '主体一致，风格统一，光影自然',
            keyframePrompt: '建立氛围帧',
            keyframeTime: 0,
            visualKeywords: ['主体一致', '原构图', '延续光影'],
            styleDescription: '写实视频风格',
            lightingMood: '自然电影感',
            atmosphere: '稳定、清晰',
            subjectMotion: '缓慢进入或保持姿态',
            cameraMotionDetail: '镜头延续原始运动轨迹',
            compositionDetail: '主体居中偏黄金分割',
            colorPalette: ['#0f172a', '#14b8a6', '#e2e8f0'],
            keyframeImageBase64: svgThumb(1, '镜头 1'),
            keyframeMimeType: 'image/svg+xml',
            keyframeWidth: 320,
            keyframeHeight: 180,
            metrics: { pace: 0.58, clarity: 0.82 },
          },
          {
            shotNumber: 2,
            startTime: Number(splitPoint.toFixed(2)),
            endTime: Number(duration.toFixed(2)),
            duration: Number((duration - splitPoint).toFixed(2)),
            subjectCount: 1,
            subjectSummary: '主体角色',
            subjectTraits: '表情与姿态稳定延续',
            actionSummary: '主体完成镜头重点动作或情绪承接',
            sceneSetting: '原场景背景关系保持不变',
            storyboardPurpose: '承接镜头高潮或收束',
            lensSuggestion: '中近景',
            frameDescription: '镜头继续沿用原始节奏，突出主体动作完成段。',
            narrativeBeat: '收束',
            sceneType: '动作承接',
            cameraAngle: '平视/轻微俯仰',
            cameraMovement: '保留原运镜',
            focusDepth: '主体持续清晰',
            lighting: '主体高光与背景层次延续',
            soundDesign: '适合后续配旁白或 BGM',
            cameraPrompt: '保持原始镜头语言并延续构图',
            imagePrompt: '主体一致，背景和光影与参考统一',
            keyframePrompt: '收束氛围帧',
            keyframeTime: Number(splitPoint.toFixed(2)),
            visualKeywords: ['镜头延续', '动作承接', '背景一致'],
            styleDescription: '写实视频风格',
            lightingMood: '稳定自然',
            atmosphere: '完整、连贯',
            subjectMotion: '动作完成或节奏回收',
            cameraMotionDetail: '原运镜收束',
            compositionDetail: '主体稳定保持主视觉',
            colorPalette: ['#082f49', '#0f766e', '#f8fafc'],
            keyframeImageBase64: svgThumb(2, '镜头 2'),
            keyframeMimeType: 'image/svg+xml',
            keyframeWidth: 320,
            keyframeHeight: 180,
            metrics: { pace: 0.62, clarity: 0.84 },
          },
        ];
        return {
          width,
          height,
          duration,
          sceneCount: rows.length,
          sceneCuts: rows.slice(1).map((item) => Number(item.startTime || 0)),
          sampleFps: Number(nextConfig.sampleFps || 5),
          summary: '已完成本地轻量分镜解析。',
          suggestedShots: rows.map((row) => ({
            id: 'shot-' + String(row.shotNumber),
            time: Number(row.startTime || 0),
            label: '镜头 ' + String(row.shotNumber),
            shotSize: String(row.lensSuggestion || ''),
            cameraPrompt: String(row.cameraPrompt || ''),
            imagePrompt: String(row.imagePrompt || ''),
            keyframePrompt: String(row.keyframePrompt || ''),
          })),
          parseRows: rows,
          analysisEngine: 'local-heuristic',
        };
      };
      const analysis = buildFallbackAnalysis();
      const rows = Array.isArray(analysis.parseRows)
        ? analysis.parseRows.filter((item) => item && typeof item === 'object')
        : [];
      const baseLabel = typeof sourceNode.data?.label === 'string' && sourceNode.data.label.trim()
        ? sourceNode.data.label.trim()
        : '视频节点';
      const nextLabel = String(baseLabel || '视频节点') + ' · 解析分镜';
      const outgoingCount = Array.isArray(canvas?.edges)
        ? canvas.edges.filter((edge) => edge.source === ${JSON.stringify(nodeId)}).length
        : 0;
      const nextNodeId = addNode('storyboard', {
        x: Number(sourceNode.position?.x || 0) + 460,
        y: Number(sourceNode.position?.y || 0) + outgoingCount * 68,
      });
      const summary = String(analysis.summary || '已完成本地视频解析。');
      const analysisEngine = String(analysis.analysisEngine || '');
      const lightweightAnalysis = {
        width: Number(analysis.width || 0),
        height: Number(analysis.height || 0),
        duration: Number(analysis.duration || 0),
        sceneCount: Number(analysis.sceneCount || rows.length || 0),
        sceneCuts: Array.isArray(analysis.sceneCuts)
          ? analysis.sceneCuts.filter((item) => Number.isFinite(Number(item))).map((item) => Number(item))
          : [],
        sampleFps: Number(analysis.sampleFps || nextConfig.sampleFps || 0),
        summary,
        analysisEngine,
      };
      const sourceWorkflowGraph = hmdaoCompleteWorkflowGraph(hmdaoBuildNodeWorkflowGraph({
        nodeId: ${JSON.stringify(nodeId)},
        nodeType: 'video',
        executionMode: 'analysis',
        generationMode: String(params.generationMode || ''),
        provider: String(sourceNode.data?.provider || ''),
        model: String(sourceNode.data?.model || ''),
        prompt: String(sourceNode.data?.prompt || ''),
        sourceMediaType: String(params.sourceMediaType || 'video'),
        toolOperation: ${JSON.stringify(VERIFY_VIDEO_TOOL_OPERATIONS.parse)},
        primaryInputs,
        referenceInputs,
        identityController,
      }), {
        outcome: 'completed',
        artifacts: [{
          stageKind: 'deliver',
          label: nextLabel,
          kind: 'validation-report',
          storage: 'inline',
          mimeType: 'application/json',
          data: {
            localTool: 'parse',
            derivedNodeId: nextNodeId,
            summary,
            analysisEngine,
            parseRowCount: rows.length,
          },
        }],
      });
      const derivedWorkflowGraph = hmdaoCompleteWorkflowGraph(hmdaoBuildNodeWorkflowGraph({
        nodeId: nextNodeId,
        nodeType: 'storyboard',
        executionMode: 'analysis',
        generationMode: String(params.generationMode || ''),
        provider: 'local',
        model: analysisEngine || 'local-storyboard-parser',
        prompt: String(sourceNode.data?.prompt || ''),
        sourceMediaType: 'text',
        toolOperation: ${JSON.stringify(VERIFY_VIDEO_TOOL_OPERATIONS.parse)},
        primaryInputs,
        referenceInputs,
        identityController,
      }), {
        outcome: 'completed',
        artifacts: [
          {
            stageKind: 'preprocess',
            label: '源节点引用',
            kind: 'reference-pack',
            storage: 'inline',
            data: {
              sourceNodeId: ${JSON.stringify(nodeId)},
              sourceNodeType: 'video',
              sourceVideoUrl: sourceUrl,
            },
          },
          {
            stageKind: 'validate',
            label: nextLabel,
            kind: 'validation-report',
            storage: 'inline',
            mimeType: 'application/json',
            data: {
              sourceNodeId: ${JSON.stringify(nodeId)},
              sourceNodeType: 'video',
              localTool: 'parse',
              summary,
              analysisEngine,
              parseRowCount: rows.length,
            },
          },
        ],
      });
      updateNodeData(nextNodeId, {
        label: nextLabel,
        status: 'completed',
        content: summary,
        outputs: [
          {
            id: 'video-parse-' + String(Date.now()),
            type: 'text',
            url: 'hmdao-parse://' + String(nextNodeId),
            metadata: {
              source: 'local-parse',
              parseSummary: summary,
              parseRows: rows,
              parseShots: rows,
              analysisEngine,
              sourceNodeId: ${JSON.stringify(nodeId)},
            },
          },
        ],
        params: {
          sourceNodeId: ${JSON.stringify(nodeId)},
          sourceNodeType: 'video',
          videoTool: 'parse',
          videoToolOperation: ${JSON.stringify(VERIFY_VIDEO_TOOL_OPERATIONS.parse)},
          videoToolConfig: nextConfig,
          parseSummary: summary,
          analysisEngine,
          parseRows: rows,
          parseShots: rows,
          parseCreatedAt: Date.now(),
          workflowGraph: derivedWorkflowGraph,
          workflowTemplateVersion: derivedWorkflowGraph.templateVersion,
        },
      });
      addEdge(${JSON.stringify(nodeId)}, nextNodeId, {
        sourceHandle: 'media-output',
      });
      updateNodeData(${JSON.stringify(nodeId)}, {
        status: 'completed',
        params: {
          ...params,
          videoTool: 'parse',
          videoToolOperation: ${JSON.stringify(VERIFY_VIDEO_TOOL_OPERATIONS.parse)},
          videoToolConfig: nextConfig,
          localVideoEditTool: 'parse',
          localVideoEditAt: Date.now(),
          localVideoAnalysis: lightweightAnalysis,
          localVideoAnalysisSummary: summary,
          localVideoAnalysisEngine: analysisEngine,
          localVideoDerivedNodeId: nextNodeId,
          localVideoDerivedTool: 'parse',
          localVideoDerivedLabel: nextLabel,
          localParseStoryboardNodeId: nextNodeId,
          localParseScriptNodeId: '',
          localParseKeyframeNodeIds: [],
          localParseKeyframeCount: rows.filter((item) => String(item?.keyframeImageBase64 || '').trim().length > 0).length,
          workflowGraph: sourceWorkflowGraph,
          workflowTemplateVersion: sourceWorkflowGraph.templateVersion,
        },
      });
      if (typeof setSelectedNodeIds === 'function') {
        setSelectedNodeIds([nextNodeId]);
      }
      return {
        ok: true,
        derivedNodeId: nextNodeId,
        derivedLabel: nextLabel,
        summary,
        analysisEngine,
        keyframeCount: rows.filter((item) => String(item?.keyframeImageBase64 || '').trim().length > 0).length,
        rowCount: rows.length,
      };
    })()
  `, 20000);
  if (!result?.ok) {
    throw new Error(`ui-only parse trigger failed: ${JSON.stringify(result)}`);
  }
  return result;
}

async function readUiOnlyLocalVideoToolPrep(cdp, nodeId, label, defaults, patch = {}) {
  const baseConfig = {
    ...(defaults && typeof defaults === 'object' ? defaults : {}),
    ...(patch && typeof patch === 'object' ? patch : {}),
  };
  const readSummary = async () => await evalJs(cdp, `
    (() => {
      const node = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes?.find((item) => item.id === ${JSON.stringify(nodeId)});
      const params = node?.data?.params || {};
      return {
        videoUrl: String(node?.data?.videoUrl || ''),
        prompt: String(node?.data?.prompt || ''),
        model: String(node?.data?.model || ''),
        provider: String(node?.data?.provider || ''),
        generationMode: String(params.generationMode || ''),
        sourceMediaType: String(params.sourceMediaType || 'video'),
      };
    })()
  `, 8000).catch(() => null);
  const summary = await readSummary();
  if (summary && String(summary.videoUrl || '').trim()) {
    return {
      ok: true,
      sourceUrl: String(summary.videoUrl || ''),
      nextConfig: baseConfig,
      generationMode: String(summary.generationMode || ''),
      sourceMediaType: String(summary.sourceMediaType || 'video'),
      prompt: String(summary.prompt || ''),
      model: String(summary.model || ''),
      provider: String(summary.provider || ''),
      primaryInputs: [],
      referenceInputs: [],
      identityController: null,
      source: 'summary-fast-path',
      summary,
    };
  }
  let lastPrep = null;
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const prep = await evalJs(cdp, `
        (() => {
          const debug = window.__HMDAO_DEBUG__ || {};
          const state = debug.canvasStore?.getState?.();
          const sourceNode = state?.canvas?.nodes?.find((item) => item.id === ${JSON.stringify(nodeId)});
          if (!sourceNode) {
            return { ok: false, error: ${JSON.stringify(`${label}-store-unavailable`)} };
          }
          const params = sourceNode.data?.params || {};
          const nextConfig = {
            ...(params.videoToolConfig && typeof params.videoToolConfig === 'object' ? params.videoToolConfig : {}),
            ...${JSON.stringify(baseConfig)},
          };
          const sourceUrl = String(sourceNode.data?.videoUrl || '');
          if (!sourceUrl) {
            return { ok: false, error: ${JSON.stringify(`${label}-missing-video-url`)} };
          }
          return {
            ok: true,
            sourceUrl,
            nextConfig,
            generationMode: String(params.generationMode || ''),
            sourceMediaType: String(params.sourceMediaType || 'video'),
            prompt: String(sourceNode.data?.prompt || ''),
            model: String(sourceNode.data?.model || ''),
            provider: String(sourceNode.data?.provider || ''),
            primaryInputs: [],
            referenceInputs: [],
            identityController: null,
          };
        })()
      `, 8000);
      lastPrep = prep;
      if (prep?.ok) {
        return prep;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }

  const fallbackSummary = await readSummary();
  if (fallbackSummary && String(fallbackSummary.videoUrl || '').trim()) {
    return {
      ok: true,
      sourceUrl: String(fallbackSummary.videoUrl || ''),
      nextConfig: baseConfig,
      generationMode: String(fallbackSummary.generationMode || ''),
      sourceMediaType: String(fallbackSummary.sourceMediaType || 'video'),
      prompt: String(fallbackSummary.prompt || ''),
      model: String(fallbackSummary.model || ''),
      provider: String(fallbackSummary.provider || ''),
      primaryInputs: [],
      referenceInputs: [],
      identityController: null,
      source: 'summary-fallback',
      summary: fallbackSummary,
    };
  }

  if (lastPrep && !lastPrep.ok) {
    throw new Error(`ui-only ${label} prep failed: ${JSON.stringify(lastPrep)}`);
  }
  if (lastError) {
    throw lastError;
  }
  throw new Error(`ui-only ${label} prep failed without source summary`);
}

async function createUiOnlyRemoveSubtitleMountState(cdp, nodeId) {
  const mountState = await withExternalTimeout(() => evalJs(cdp, `
    (() => {
      const debug = window.__HMDAO_DEBUG__ || {};
      const storeApi = debug.canvasStore;
      const state = storeApi?.getState?.();
      const setState = storeApi?.setState;
      const canvas = state?.canvas;
      const sourceNode = canvas?.nodes?.find((item) => item.id === ${JSON.stringify(nodeId)});
      if (!sourceNode || !canvas || !Array.isArray(canvas.nodes) || typeof setState !== 'function') {
        return { ok: false, error: 'ui-only-remove-subtitle-scaffold-store-unavailable' };
      }
      const createNodeId = () => typeof crypto?.randomUUID === 'function'
        ? crypto.randomUUID()
        : 'ui-only-node-' + String(Date.now()) + '-' + String(Math.random()).slice(2);
      const baseLabel = typeof sourceNode.data?.label === 'string' && sourceNode.data.label.trim()
        ? sourceNode.data.label.trim()
        : '视频节点';
      const outgoingCount = Array.isArray(canvas?.edges) ? canvas.edges.filter((edge) => edge.source === ${JSON.stringify(nodeId)}).length : 0;
      const derivedNodeId = createNodeId();
      const derivedNode = {
        id: derivedNodeId,
        type: 'video',
        position: {
          x: Number(sourceNode.position?.x || 0) + 420,
          y: Number(sourceNode.position?.y || 0) + outgoingCount * 42,
        },
        selected: false,
        data: {
          label: String(baseLabel) + ' · 去字幕',
          createdAt: Date.now(),
          status: 'idle',
          params: {},
        },
      };
      const updatedAt = Date.now();
      setState((prev) => ({
        canvas: prev?.canvas
          ? {
              ...prev.canvas,
              nodes: [...(Array.isArray(prev.canvas.nodes) ? prev.canvas.nodes : []), derivedNode],
              updatedAt,
            }
          : prev?.canvas,
        selectedNodeIds: [derivedNodeId],
        floatingPanel: null,
        pendingViewportFocusNodeId: derivedNodeId,
        pendingViewportFocusNonce: updatedAt,
      }));
      return {
        ok: true,
        derivedNodeId,
        derivedLabel: String(baseLabel) + ' · 去字幕',
      };
    })()
  `, 20000), 25000, `ui-only removeSubtitle scaffold ${nodeId}`);
  if (!mountState?.ok) {
    throw new Error(`ui-only removeSubtitle scaffold failed: ${JSON.stringify(mountState)}`);
  }
  return mountState;
}

async function createUiOnlyHdMountState(cdp, nodeId) {
  const mountState = await withExternalTimeout(() => evalJs(cdp, `
    (() => {
      const debug = window.__HMDAO_DEBUG__ || {};
      const storeApi = debug.canvasStore;
      const state = storeApi?.getState?.();
      const setState = storeApi?.setState;
      const canvas = state?.canvas;
      const sourceNode = canvas?.nodes?.find((item) => item.id === ${JSON.stringify(nodeId)});
      if (!sourceNode || !canvas || !Array.isArray(canvas.nodes) || typeof setState !== 'function') {
        return { ok: false, error: 'ui-only-hd-scaffold-store-unavailable' };
      }
      const createNodeId = () => typeof crypto?.randomUUID === 'function'
        ? crypto.randomUUID()
        : 'ui-only-node-' + String(Date.now()) + '-' + String(Math.random()).slice(2);
      const baseLabel = typeof sourceNode.data?.label === 'string' && sourceNode.data.label.trim()
        ? sourceNode.data.label.trim()
        : '视频节点';
      const outgoingCount = Array.isArray(canvas?.edges) ? canvas.edges.filter((edge) => edge.source === ${JSON.stringify(nodeId)}).length : 0;
      const derivedNodeId = createNodeId();
      const derivedNode = {
        id: derivedNodeId,
        type: 'video',
        position: {
          x: Number(sourceNode.position?.x || 0) + 420,
          y: Number(sourceNode.position?.y || 0) + outgoingCount * 42,
        },
        selected: false,
        data: {
          label: String(baseLabel) + ' · 高清',
          createdAt: Date.now(),
          status: 'idle',
          params: {},
        },
      };
      const updatedAt = Date.now();
      setState((prev) => ({
        canvas: prev?.canvas
          ? {
              ...prev.canvas,
              nodes: [...(Array.isArray(prev.canvas.nodes) ? prev.canvas.nodes : []), derivedNode],
              updatedAt,
            }
          : prev?.canvas,
        selectedNodeIds: [derivedNodeId],
        floatingPanel: null,
        pendingViewportFocusNodeId: derivedNodeId,
        pendingViewportFocusNonce: updatedAt,
      }));
      return {
        ok: true,
        derivedNodeId,
        derivedLabel: String(baseLabel) + ' · 高清',
      };
    })()
  `, 20000), 25000, `ui-only hd scaffold ${nodeId}`);
  if (!mountState?.ok) {
    throw new Error(`ui-only hd scaffold failed: ${JSON.stringify(mountState)}`);
  }
  return mountState;
}

async function mountUiOnlyHdDerivedNode(cdp, nodeId, prep, output, mountState) {
  const result = await withExternalTimeout(() => evalJs(cdp, `
    (() => {
      ${UI_ONLY_WORKFLOW_BROWSER_HELPERS}
      const prep = ${JSON.stringify(prep)};
      const output = ${JSON.stringify(output)};
      const mountState = ${JSON.stringify(mountState)};
      const debug = window.__HMDAO_DEBUG__ || {};
      const state = debug.canvasStore?.getState?.();
      const updateNodeData = state?.updateNodeData;
      if (typeof updateNodeData !== 'function') {
        return { ok: false, error: 'ui-only-hd-derived-update-unavailable' };
      }
      const derivedWorkflowGraph = hmdaoCompleteWorkflowGraph(hmdaoBuildNodeWorkflowGraph({
        nodeId: mountState.derivedNodeId,
        nodeType: 'video',
        executionMode: 'editing',
        generationMode: String(prep.generationMode || ''),
        provider: 'local',
        model: String(output.processingEngine || 'local-hd'),
        prompt: String(prep.prompt || ''),
        sourceMediaType: 'video',
        toolOperation: ${JSON.stringify(VERIFY_VIDEO_TOOL_OPERATIONS.hd)},
        primaryInputs: Array.isArray(prep.primaryInputs) ? prep.primaryInputs : [],
        referenceInputs: Array.isArray(prep.referenceInputs) ? prep.referenceInputs : [],
        identityController: prep.identityController || null,
      }), {
        outcome: 'completed',
        artifacts: [
          {
            stageKind: 'preprocess',
            label: '源节点引用',
            kind: 'reference-pack',
            storage: 'inline',
            data: {
              sourceNodeId: ${JSON.stringify(nodeId)},
              sourceNodeType: 'video',
              sourceVideoUrl: String(prep.sourceUrl || ''),
            },
          },
          {
            stageKind: 'deliver',
            label: String(mountState.derivedLabel || ''),
            kind: 'media',
            storage: String(output.url || '').startsWith('hmdao-local://') ? 'handle' : 'url',
            mimeType: String(output.mimeType || 'video/webm'),
            url: String(output.url || '').startsWith('http') ? String(output.url || '') : undefined,
            handle: String(output.url || '').startsWith('hmdao-local://') ? String(output.url || '') : undefined,
            data: {
              sourceNodeId: ${JSON.stringify(nodeId)},
              sourceNodeType: 'video',
              localTool: 'hd',
              processingEngine: String(output.processingEngine || ''),
            },
          },
        ],
      });
      updateNodeData(mountState.derivedNodeId, {
        label: String(mountState.derivedLabel || ''),
        prompt: String(prep.prompt || ''),
        model: String(prep.model || ''),
        provider: String(prep.provider || ''),
        status: 'completed',
        aspectRatio: Number(output.width || 0) >= Number(output.height || 0) ? '16:9' : '9:16',
        duration: Math.max(1, Math.round(Number(output.duration || 1))),
        videoUrl: String(output.url || ''),
        outputs: [{
          id: 'local-hd-' + String(Date.now()),
          type: 'video',
          url: String(output.url || ''),
          metadata: {
            source: 'local-hd',
            localTool: 'hd',
            managedUrl: true,
            size: Number(output.size || 0),
            mimeType: String(output.mimeType || 'video/webm'),
            width: Number(output.width || 0),
            height: Number(output.height || 0),
            duration: Number(output.duration || 0),
            processingEngine: String(output.processingEngine || ''),
          },
        }],
        params: {
          videoTool: 'hd',
          videoToolOperation: ${JSON.stringify(VERIFY_VIDEO_TOOL_OPERATIONS.hd)},
          videoToolConfig: prep.nextConfig,
          videoMeta: {
            width: Number(output.width || 0),
            height: Number(output.height || 0),
            duration: Number(output.duration || 0),
          },
          videoMimeType: String(output.mimeType || 'video/webm'),
          sourceUrl: String(output.url || ''),
          sourceMediaType: 'video',
          generationProgress: [],
          localVideoEditTool: 'hd',
          localVideoEditAt: Date.now(),
          workflowGraph: derivedWorkflowGraph,
          workflowTemplateVersion: derivedWorkflowGraph.templateVersion,
          generationMode: String(prep.generationMode || ''),
          identityController: prep.identityController || null,
          lastError: '',
          lastErrorCategory: '',
        },
      });
      return {
        ok: true,
        derivedNodeId: mountState.derivedNodeId,
        derivedLabel: String(mountState.derivedLabel || ''),
        videoUrl: String(output.url || ''),
        processingEngine: String(output.processingEngine || ''),
      };
    })()
  `, 20000), 25000, `ui-only hd mount derived ${nodeId}`);
  if (!result?.ok) {
    throw new Error(`ui-only hd mount derived failed: ${JSON.stringify(result)}`);
  }
  return result;
}

async function finalizeUiOnlyHdMount(cdp, nodeId, prep, output, mountState) {
  const result = await withExternalTimeout(() => evalJs(cdp, `
    (() => {
      ${UI_ONLY_WORKFLOW_BROWSER_HELPERS}
      const prep = ${JSON.stringify(prep)};
      const output = ${JSON.stringify(output)};
      const mountState = ${JSON.stringify(mountState)};
      const debug = window.__HMDAO_DEBUG__ || {};
      const state = debug.canvasStore?.getState?.();
      const addEdge = state?.addEdge;
      const updateNodeData = state?.updateNodeData;
      const setSelectedNodeIds = state?.setSelectedNodeIds;
      if (typeof addEdge !== 'function' || typeof updateNodeData !== 'function') {
        return { ok: false, error: 'ui-only-hd-finalize-store-unavailable' };
      }
      const sourceWorkflowGraph = hmdaoCompleteWorkflowGraph(hmdaoBuildNodeWorkflowGraph({
        nodeId: ${JSON.stringify(nodeId)},
        nodeType: 'video',
        executionMode: 'editing',
        generationMode: String(prep.generationMode || ''),
        provider: String(prep.provider || 'local'),
        model: String(prep.model || 'local-hd'),
        prompt: String(prep.prompt || ''),
        sourceMediaType: String(prep.sourceMediaType || 'video'),
        toolOperation: ${JSON.stringify(VERIFY_VIDEO_TOOL_OPERATIONS.hd)},
        primaryInputs: Array.isArray(prep.primaryInputs) ? prep.primaryInputs : [],
        referenceInputs: Array.isArray(prep.referenceInputs) ? prep.referenceInputs : [],
        identityController: prep.identityController || null,
      }), {
        outcome: 'completed',
        artifacts: [{
          stageKind: 'deliver',
          label: String(mountState.derivedLabel || ''),
          kind: 'delivery-package',
          storage: 'inline',
          mimeType: String(output.mimeType || 'video/webm'),
          data: {
            localTool: 'hd',
            derivedNodeId: mountState.derivedNodeId,
            derivedNodeType: 'video',
            processingEngine: String(output.processingEngine || ''),
          },
        }],
      });
      addEdge(${JSON.stringify(nodeId)}, mountState.derivedNodeId, { sourceHandle: 'media-output', targetHandle: 'video-main' });
      updateNodeData(${JSON.stringify(nodeId)}, {
        status: 'completed',
        params: {
          videoTool: 'hd',
          videoToolOperation: ${JSON.stringify(VERIFY_VIDEO_TOOL_OPERATIONS.hd)},
          videoToolConfig: prep.nextConfig,
          localVideoEditTool: 'hd',
          localVideoEditAt: Date.now(),
          localVideoDerivedNodeId: mountState.derivedNodeId,
          localVideoDerivedTool: 'hd',
          localVideoDerivedLabel: String(mountState.derivedLabel || ''),
          localVideoProcessingEngine: String(output.processingEngine || ''),
          workflowGraph: sourceWorkflowGraph,
          workflowTemplateVersion: sourceWorkflowGraph.templateVersion,
          sourceMediaType: String(prep.sourceMediaType || 'video'),
          generationMode: String(prep.generationMode || ''),
          identityController: prep.identityController || null,
          generationProgress: [],
          lastError: '',
          lastErrorCategory: '',
          lastErrorStage: '',
        },
      });
      if (typeof setSelectedNodeIds === 'function') {
        setSelectedNodeIds([mountState.derivedNodeId]);
      }
      return {
        ok: true,
        derivedNodeId: mountState.derivedNodeId,
        derivedLabel: String(mountState.derivedLabel || ''),
        videoUrl: String(output.url || ''),
        processingEngine: String(output.processingEngine || ''),
      };
    })()
  `, 20000), 25000, `ui-only hd finalize ${nodeId}`);
  if (!result?.ok) {
    throw new Error(`ui-only hd finalize failed: ${JSON.stringify(result)}`);
  }
  return result;
}

async function runUiOnlyLocalHd(cdp, nodeId, patch = {}) {
  const patchRecord = patch && typeof patch === 'object' ? patch : {};
  const {
    sourceUrl: directSourceUrl = '',
    generationMode: directGenerationMode = '',
    sourceMediaType: directSourceMediaType = 'video',
    prompt: directPrompt = '',
    model: directModel = '',
    provider: directProvider = '',
    primaryInputs: directPrimaryInputs = [],
    referenceInputs: directReferenceInputs = [],
    identityController: directIdentityController = null,
    ...patchOverrides
  } = patchRecord;
  const prep = String(directSourceUrl || '').trim()
    ? {
      ok: true,
      sourceUrl: String(directSourceUrl),
      nextConfig: {
        tool: 'hd',
        scale: 2,
        mode: 'quality',
        detailStrength: 0.66,
        sharpen: 0.36,
        interpolate60fps: false,
        targetFps: 24,
        faceRestore: true,
        ...(patchOverrides && typeof patchOverrides === 'object' ? patchOverrides : {}),
      },
      generationMode: String(directGenerationMode || ''),
      sourceMediaType: String(directSourceMediaType || 'video'),
      prompt: String(directPrompt || ''),
      model: String(directModel || ''),
      provider: String(directProvider || ''),
      primaryInputs: Array.isArray(directPrimaryInputs) ? directPrimaryInputs : [],
      referenceInputs: Array.isArray(directReferenceInputs) ? directReferenceInputs : [],
      identityController: directIdentityController || null,
      source: 'caller-source-url',
    }
    : await withExternalTimeout(
      () => readUiOnlyLocalVideoToolPrep(
        cdp,
        nodeId,
        'hd',
        {
          tool: 'hd',
          scale: 2,
          mode: 'quality',
          detailStrength: 0.66,
          sharpen: 0.36,
          interpolate60fps: false,
          targetFps: 24,
          faceRestore: true,
        },
        patchOverrides,
      ),
      25000,
      `ui-only hd prep ${nodeId}`,
    );
  log('ui-only hd:prep-ready', {
    nodeId,
    sourceUrl: String(prep?.sourceUrl || ''),
    config: prep?.nextConfig || null,
  });

  await replaceVideoToolState(cdp, nodeId, 'hd', prep?.nextConfig || {
    tool: 'hd',
    scale: 2,
    mode: 'quality',
    detailStrength: 0.66,
    sharpen: 0.36,
    interpolate60fps: false,
    targetFps: 24,
    faceRestore: true,
  }, {
    localVideoEditTool: 'hd',
    lastError: '',
    lastErrorCategory: '',
    lastErrorStage: '',
    error: '',
  });
  log('ui-only hd:state-reset', {
    nodeId,
    config: prep?.nextConfig || null,
  });

  let output;
  try {
    log('ui-only hd:request-start', { nodeId });
    output = normalizeUiOnlyHdOutput(
      await withExternalTimeout(
        () => requestUiOnlyLocalVideoEdit('hd', prep.sourceUrl, prep.nextConfig),
        Number(process.env.HMDAO_VERIFY_LOCAL_VIDEO_EDIT_TIMEOUT_MS || 45000) + 5000,
        `ui-only hd request ${nodeId}`,
      ),
    );
    log('ui-only hd:request-done', {
      nodeId,
      videoUrl: String(output?.url || ''),
      processingEngine: String(output?.processingEngine || ''),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await withExternalTimeout(() => evalJs(cdp, `
      (() => {
        const state = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
        const sourceNode = state?.canvas?.nodes?.find((item) => item.id === ${JSON.stringify(nodeId)});
        const params = sourceNode?.data?.params || {};
        if (typeof state?.updateNodeData === 'function') {
          state.updateNodeData(${JSON.stringify(nodeId)}, {
            status: 'error',
            error: ${JSON.stringify(message)},
            params: {
              ...params,
              lastError: ${JSON.stringify(message)},
              lastErrorCategory: 'local-hd',
              lastErrorStage: 'local-hd',
            },
          });
        }
        return true;
      })()
    `, 10000), 5000, `ui-only hd error state ${nodeId}`).catch(() => false);
    throw new Error(`ui-only hd trigger failed: ${message}`);
  }

  try {
    log('ui-only hd:scaffold-start', { nodeId });
    const mountState = await createUiOnlyHdMountState(cdp, nodeId);
    log('ui-only hd:scaffold-done', mountState);
    log('ui-only hd:mount-start', { nodeId, derivedNodeId: mountState.derivedNodeId });
    await mountUiOnlyHdDerivedNode(cdp, nodeId, prep, output, mountState);
    log('ui-only hd:mount-done', {
      nodeId,
      derivedNodeId: mountState.derivedNodeId,
      derivedLabel: mountState.derivedLabel,
    });
    log('ui-only hd:finalize-start', { nodeId, derivedNodeId: mountState.derivedNodeId });
    const finalized = await finalizeUiOnlyHdMount(cdp, nodeId, prep, output, mountState);
    log('ui-only hd:finalize-done', finalized);
    return finalized;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await withExternalTimeout(() => evalJs(cdp, `
      (() => {
        const state = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
        const sourceNode = state?.canvas?.nodes?.find((item) => item.id === ${JSON.stringify(nodeId)});
        const params = sourceNode?.data?.params || {};
        if (typeof state?.updateNodeData === 'function') {
          state.updateNodeData(${JSON.stringify(nodeId)}, {
            status: 'error',
            error: ${JSON.stringify(message)},
            params: {
              ...params,
              lastError: ${JSON.stringify(message)},
              lastErrorCategory: 'local-hd',
              lastErrorStage: 'local-hd-apply',
            },
          });
        }
        return true;
      })()
    `, 10000), 5000, `ui-only hd apply error state ${nodeId}`).catch(() => false);
    throw error;
  }
}

async function mountUiOnlyRemoveSubtitleDerivedNode(cdp, nodeId, prep, output, mountState) {
  const result = await withExternalTimeout(() => evalJs(cdp, `
    (() => {
      ${UI_ONLY_WORKFLOW_BROWSER_HELPERS}
      const prep = ${JSON.stringify(prep)};
      const output = ${JSON.stringify(output)};
      const mountState = ${JSON.stringify(mountState)};
      const debug = window.__HMDAO_DEBUG__ || {};
      const state = debug.canvasStore?.getState?.();
      const updateNodeData = state?.updateNodeData;
      if (typeof updateNodeData !== 'function') {
        return { ok: false, error: 'ui-only-remove-subtitle-derived-update-unavailable' };
      }
      const buildGraph = (workflowNodeId, workflowNodeType, executionMode, provider, model, promptValue, sourceMediaType, artifact) => hmdaoCompleteWorkflowGraph(hmdaoBuildNodeWorkflowGraph({
        nodeId: workflowNodeId,
        nodeType: workflowNodeType,
        executionMode,
        generationMode: String(prep.generationMode || ''),
        provider,
        model,
        prompt: promptValue,
        sourceMediaType,
        toolOperation: ${JSON.stringify(VERIFY_VIDEO_TOOL_OPERATIONS.removeSubtitle)},
        primaryInputs: Array.isArray(prep.primaryInputs) ? prep.primaryInputs : [],
        referenceInputs: Array.isArray(prep.referenceInputs) ? prep.referenceInputs : [],
        identityController: prep.identityController || null,
      }), {
        outcome: 'completed',
        artifacts: Array.isArray(artifact) ? artifact : [artifact],
      });
      const derivedWorkflowGraph = buildGraph(mountState.derivedNodeId, 'video', 'editing', 'local', String(output.processingEngine || 'local-remove-subtitle'), String(prep.prompt || ''), 'video', [
        {
          stageKind: 'preprocess',
          label: '源节点引用',
          kind: 'reference-pack',
          storage: 'inline',
          data: {
            sourceNodeId: ${JSON.stringify(nodeId)},
            sourceNodeType: 'video',
            sourceVideoUrl: String(prep.sourceUrl || ''),
          },
        },
        {
          stageKind: 'deliver',
          label: String(mountState.derivedLabel || ''),
          kind: 'media',
          storage: String(output.url || '').startsWith('hmdao-local://') ? 'handle' : 'url',
          mimeType: String(output.mimeType || 'video/webm'),
          url: String(output.url || '').startsWith('http') ? String(output.url || '') : undefined,
          handle: String(output.url || '').startsWith('hmdao-local://') ? String(output.url || '') : undefined,
          data: {
            sourceNodeId: ${JSON.stringify(nodeId)},
            sourceNodeType: 'video',
            localTool: 'removeSubtitle',
            processingEngine: String(output.processingEngine || ''),
          },
        },
      ]);
      updateNodeData(mountState.derivedNodeId, {
        label: String(mountState.derivedLabel || ''),
        prompt: String(prep.prompt || ''),
        model: String(prep.model || ''),
        provider: String(prep.provider || ''),
        status: 'completed',
        aspectRatio: Number(output.width || 0) >= Number(output.height || 0) ? '16:9' : '9:16',
        duration: Math.max(1, Math.round(Number(output.duration || 1))),
        videoUrl: String(output.url || ''),
        outputs: [{
          id: 'local-remove-subtitle-' + String(Date.now()),
          type: 'video',
          url: String(output.url || ''),
          metadata: {
            source: 'local-removeSubtitle',
            localTool: 'removeSubtitle',
            managedUrl: true,
            size: Number(output.size || 0),
            mimeType: String(output.mimeType || 'video/webm'),
            width: Number(output.width || 0),
            height: Number(output.height || 0),
            duration: Number(output.duration || 0),
            processingEngine: String(output.processingEngine || ''),
          },
        }],
        params: {
          videoTool: 'removeSubtitle',
          videoToolOperation: ${JSON.stringify(VERIFY_VIDEO_TOOL_OPERATIONS.removeSubtitle)},
          videoToolConfig: prep.nextConfig,
          videoMeta: {
            width: Number(output.width || 0),
            height: Number(output.height || 0),
            duration: Number(output.duration || 0),
          },
          videoMimeType: String(output.mimeType || 'video/webm'),
          sourceUrl: String(output.url || ''),
          sourceMediaType: 'video',
          generationProgress: [],
          localVideoEditTool: 'removeSubtitle',
          localVideoEditAt: Date.now(),
          workflowGraph: derivedWorkflowGraph,
          workflowTemplateVersion: derivedWorkflowGraph.templateVersion,
          generationMode: String(prep.generationMode || ''),
          identityController: prep.identityController || null,
          lastError: '',
          lastErrorCategory: '',
        },
      });
      return {
        ok: true,
        derivedNodeId: mountState.derivedNodeId,
        derivedLabel: String(mountState.derivedLabel || ''),
        videoUrl: String(output.url || ''),
        processingEngine: String(output.processingEngine || ''),
      };
    })()
  `, 20000), 25000, `ui-only removeSubtitle mount derived ${nodeId}`);
  if (!result?.ok) {
    throw new Error(`ui-only removeSubtitle mount derived failed: ${JSON.stringify(result)}`);
  }
  return result;
}

async function finalizeUiOnlyRemoveSubtitleMount(cdp, nodeId, prep, output, mountState) {
  const result = await withExternalTimeout(() => evalJs(cdp, `
    (() => {
      ${UI_ONLY_WORKFLOW_BROWSER_HELPERS}
      const prep = ${JSON.stringify(prep)};
      const output = ${JSON.stringify(output)};
      const mountState = ${JSON.stringify(mountState)};
      const debug = window.__HMDAO_DEBUG__ || {};
      const state = debug.canvasStore?.getState?.();
      const addEdge = state?.addEdge;
      const updateNodeData = state?.updateNodeData;
      const setSelectedNodeIds = state?.setSelectedNodeIds;
      if (typeof addEdge !== 'function' || typeof updateNodeData !== 'function') {
        return { ok: false, error: 'ui-only-remove-subtitle-finalize-store-unavailable' };
      }
      const buildGraph = (workflowNodeId, workflowNodeType, executionMode, provider, model, promptValue, sourceMediaType, artifact) => hmdaoCompleteWorkflowGraph(hmdaoBuildNodeWorkflowGraph({
        nodeId: workflowNodeId,
        nodeType: workflowNodeType,
        executionMode,
        generationMode: String(prep.generationMode || ''),
        provider,
        model,
        prompt: promptValue,
        sourceMediaType,
        toolOperation: ${JSON.stringify(VERIFY_VIDEO_TOOL_OPERATIONS.removeSubtitle)},
        primaryInputs: Array.isArray(prep.primaryInputs) ? prep.primaryInputs : [],
        referenceInputs: Array.isArray(prep.referenceInputs) ? prep.referenceInputs : [],
        identityController: prep.identityController || null,
      }), {
        outcome: 'completed',
        artifacts: Array.isArray(artifact) ? artifact : [artifact],
      });
      const sourceWorkflowGraph = buildGraph(${JSON.stringify(nodeId)}, 'video', 'editing', String(prep.provider || 'local'), String(prep.model || 'local-remove-subtitle'), String(prep.prompt || ''), String(prep.sourceMediaType || 'video'), {
        stageKind: 'deliver',
        label: String(mountState.derivedLabel || ''),
        kind: 'delivery-package',
        storage: 'inline',
        mimeType: String(output.mimeType || 'video/webm'),
        data: {
          localTool: 'removeSubtitle',
          derivedNodeId: mountState.derivedNodeId,
          derivedNodeType: 'video',
          processingEngine: String(output.processingEngine || ''),
        },
      });
      addEdge(${JSON.stringify(nodeId)}, mountState.derivedNodeId, { sourceHandle: 'media-output', targetHandle: 'video-main' });
      updateNodeData(${JSON.stringify(nodeId)}, {
        status: 'completed',
        params: {
          videoTool: 'removeSubtitle',
          videoToolOperation: ${JSON.stringify(VERIFY_VIDEO_TOOL_OPERATIONS.removeSubtitle)},
          videoToolConfig: prep.nextConfig,
          localVideoEditTool: 'removeSubtitle',
          localVideoEditAt: Date.now(),
          localVideoDerivedNodeId: mountState.derivedNodeId,
          localVideoDerivedTool: 'removeSubtitle',
          localVideoDerivedLabel: String(mountState.derivedLabel || ''),
          localVideoProcessingEngine: String(output.processingEngine || ''),
          workflowGraph: sourceWorkflowGraph,
          workflowTemplateVersion: sourceWorkflowGraph.templateVersion,
          sourceMediaType: String(prep.sourceMediaType || 'video'),
          generationMode: String(prep.generationMode || ''),
          identityController: prep.identityController || null,
          lastError: '',
          lastErrorCategory: '',
        },
      });
      if (typeof setSelectedNodeIds === 'function') {
        setSelectedNodeIds([mountState.derivedNodeId]);
      }
      return {
        ok: true,
        derivedNodeId: mountState.derivedNodeId,
        derivedLabel: String(mountState.derivedLabel || ''),
        videoUrl: String(output.url || ''),
        processingEngine: String(output.processingEngine || ''),
      };
    })()
  `, 20000), 25000, `ui-only removeSubtitle finalize ${nodeId}`);
  if (!result?.ok) {
    throw new Error(`ui-only removeSubtitle finalize failed: ${JSON.stringify(result)}`);
  }
  return result;
}

async function runUiOnlyLocalRemoveSubtitle(cdp, nodeId, patch = {}) {
  const patchRecord = patch && typeof patch === 'object' ? patch : {};
  const {
    sourceUrl: directSourceUrl = '',
    generationMode: directGenerationMode = '',
    sourceMediaType: directSourceMediaType = 'video',
    prompt: directPrompt = '',
    model: directModel = '',
    provider: directProvider = '',
    primaryInputs: directPrimaryInputs = [],
    referenceInputs: directReferenceInputs = [],
    identityController: directIdentityController = null,
    ...patchOverrides
  } = patchRecord;
  const prep = String(directSourceUrl || '').trim()
    ? {
      ok: true,
      sourceUrl: String(directSourceUrl),
      nextConfig: {
        tool: 'removeSubtitle',
        detectionMode: 'manual',
        maskFeather: 11,
        ...(patchOverrides && typeof patchOverrides === 'object' ? patchOverrides : {}),
      },
      generationMode: String(directGenerationMode || ''),
      sourceMediaType: String(directSourceMediaType || 'video'),
      prompt: String(directPrompt || ''),
      model: String(directModel || ''),
      provider: String(directProvider || ''),
      primaryInputs: Array.isArray(directPrimaryInputs) ? directPrimaryInputs : [],
      referenceInputs: Array.isArray(directReferenceInputs) ? directReferenceInputs : [],
      identityController: directIdentityController || null,
      source: 'caller-source-url',
    }
    : await withExternalTimeout(
      () => readUiOnlyLocalVideoToolPrep(
        cdp,
        nodeId,
        'removeSubtitle',
        {
          tool: 'removeSubtitle',
          detectionMode: 'manual',
          maskFeather: 11,
        },
        patchOverrides,
      ),
      25000,
      `ui-only removeSubtitle prep ${nodeId}`,
    );
  log('ui-only removeSubtitle:prep-ready', {
    nodeId,
    sourceUrl: String(prep?.sourceUrl || ''),
    config: prep?.nextConfig || null,
  });
  await replaceVideoToolState(cdp, nodeId, 'removeSubtitle', prep?.nextConfig || {
    tool: 'removeSubtitle',
    detectionMode: 'manual',
    maskFeather: 11,
  }, {
    localVideoEditTool: 'removeSubtitle',
    lastError: '',
    lastErrorCategory: '',
    lastErrorStage: '',
    error: '',
  });
  log('ui-only removeSubtitle:state-reset', {
    nodeId,
    config: prep?.nextConfig || null,
  });

  let output;
  try {
    log('ui-only removeSubtitle:request-start', { nodeId });
    output = normalizeUiOnlyRemoveSubtitleOutput(
      await withExternalTimeout(
        () => requestUiOnlyLocalVideoEdit('removeSubtitle', prep.sourceUrl, prep.nextConfig),
        Number(process.env.HMDAO_VERIFY_LOCAL_VIDEO_EDIT_TIMEOUT_MS || 45000) + 5000,
        `ui-only removeSubtitle request ${nodeId}`,
      ),
    );
    log('ui-only removeSubtitle:request-done', {
      nodeId,
      videoUrl: String(output?.url || ''),
      processingEngine: String(output?.processingEngine || ''),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await evalJs(cdp, `
      (() => {
        const state = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
        const sourceNode = state?.canvas?.nodes?.find((item) => item.id === ${JSON.stringify(nodeId)});
        const params = sourceNode?.data?.params || {};
        if (typeof state?.updateNodeData === 'function') {
          state.updateNodeData(${JSON.stringify(nodeId)}, {
            status: 'error',
            error: ${JSON.stringify(message)},
            params: {
              ...params,
              lastError: ${JSON.stringify(message)},
              lastErrorCategory: 'local-remove-subtitle',
              lastErrorStage: 'local-remove-subtitle',
            },
          });
        }
        return true;
      })()
    `, 10000).catch(() => false);
    throw new Error(`ui-only removeSubtitle trigger failed: ${message}`);
  }

  try {
    log('ui-only removeSubtitle:scaffold-start', { nodeId });
    const mountState = await createUiOnlyRemoveSubtitleMountState(cdp, nodeId);
    log('ui-only removeSubtitle:scaffold-done', mountState);
    log('ui-only removeSubtitle:mount-start', {
      nodeId,
      derivedNodeId: mountState.derivedNodeId,
    });
    await mountUiOnlyRemoveSubtitleDerivedNode(cdp, nodeId, prep, output, mountState);
    log('ui-only removeSubtitle:mount-done', {
      nodeId,
      derivedNodeId: mountState.derivedNodeId,
      derivedLabel: mountState.derivedLabel,
    });
    log('ui-only removeSubtitle:finalize-start', {
      nodeId,
      derivedNodeId: mountState.derivedNodeId,
    });
    const finalized = await finalizeUiOnlyRemoveSubtitleMount(cdp, nodeId, prep, output, mountState);
    log('ui-only removeSubtitle:finalize-done', finalized);
    return finalized;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await withExternalTimeout(() => evalJs(cdp, `
      (() => {
        const state = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
        const sourceNode = state?.canvas?.nodes?.find((item) => item.id === ${JSON.stringify(nodeId)});
        const params = sourceNode?.data?.params || {};
        if (typeof state?.updateNodeData === 'function') {
          state.updateNodeData(${JSON.stringify(nodeId)}, {
            status: 'error',
            error: ${JSON.stringify(message)},
            params: {
              ...params,
              lastError: ${JSON.stringify(message)},
              lastErrorCategory: 'local-remove-subtitle',
              lastErrorStage: 'local-remove-subtitle-apply',
            },
          });
        }
        return true;
      })()
    `, 10000), 5000, `ui-only removeSubtitle error state ${nodeId}`).catch(() => false);
    throw error;
  }
}

async function createUiOnlyAudioSplitMountState(cdp, nodeId) {
  const mountState = await withExternalTimeout(() => evalJs(cdp, `
    (() => {
      const debug = window.__HMDAO_DEBUG__ || {};
      const storeApi = debug.canvasStore;
      const state = storeApi?.getState?.();
      const setState = storeApi?.setState;
      const canvas = state?.canvas;
      const sourceNode = canvas?.nodes?.find((item) => item.id === ${JSON.stringify(nodeId)});
      if (!sourceNode || !canvas || !Array.isArray(canvas.nodes) || typeof setState !== 'function') {
        return { ok: false, error: 'ui-only-audio-split-scaffold-store-unavailable' };
      }
      const createNodeId = () => typeof crypto?.randomUUID === 'function'
        ? crypto.randomUUID()
        : 'ui-only-node-' + String(Date.now()) + '-' + String(Math.random()).slice(2);
      const baseLabel = typeof sourceNode.data?.label === 'string' && sourceNode.data.label.trim()
        ? sourceNode.data.label.trim()
        : '视频节点';
      const baseX = Number(sourceNode.position?.x || 0) + 420;
      const baseY = Number(sourceNode.position?.y || 0);
      const derivedNodeId = createNodeId();
      const fullAudioNodeId = createNodeId();
      const vocalNodeId = createNodeId();
      const accompanimentNodeId = createNodeId();
      const updatedAt = Date.now();
      const nextNodes = [
        {
          id: derivedNodeId,
          type: 'video',
          position: { x: baseX, y: baseY },
          selected: false,
          data: { label: String(baseLabel) + ' · 音频分离', createdAt: updatedAt, status: 'idle', params: {} },
        },
        {
          id: fullAudioNodeId,
          type: 'audio',
          position: { x: baseX, y: baseY + 180 },
          selected: false,
          data: { label: String(baseLabel) + ' · 音频', createdAt: updatedAt, status: 'idle', params: {} },
        },
        {
          id: vocalNodeId,
          type: 'audio',
          position: { x: baseX, y: baseY + 290 },
          selected: false,
          data: { label: String(baseLabel) + ' · 纯人声', createdAt: updatedAt, status: 'idle', params: {} },
        },
        {
          id: accompanimentNodeId,
          type: 'audio',
          position: { x: baseX, y: baseY + 400 },
          selected: false,
          data: { label: String(baseLabel) + ' · 伴奏', createdAt: updatedAt, status: 'idle', params: {} },
        },
      ];
      setState((prev) => ({
        canvas: prev?.canvas
          ? {
              ...prev.canvas,
              nodes: [...(Array.isArray(prev.canvas.nodes) ? prev.canvas.nodes : []), ...nextNodes],
              updatedAt,
            }
          : prev?.canvas,
        selectedNodeIds: [derivedNodeId],
        floatingPanel: null,
        pendingViewportFocusNodeId: derivedNodeId,
        pendingViewportFocusNonce: updatedAt,
      }));
      return {
        ok: true,
        derivedNodeId,
        fullAudioNodeId,
        vocalNodeId,
        accompanimentNodeId,
        labels: {
          video: String(baseLabel) + ' · 音频分离',
          full: String(baseLabel) + ' · 音频',
          vocal: String(baseLabel) + ' · 纯人声',
          accompaniment: String(baseLabel) + ' · 伴奏',
        },
      };
    })()
  `, 20000), 25000, `ui-only audioSplit scaffold ${nodeId}`);
  if (!mountState?.ok) {
    throw new Error(`ui-only audioSplit scaffold failed: ${JSON.stringify(mountState)}`);
  }
  return mountState;
}

async function mountUiOnlyAudioSplitVideoNode(cdp, nodeId, prep, output, mountState) {
  const result = await withExternalTimeout(() => evalJs(cdp, `
    (() => {
      ${UI_ONLY_WORKFLOW_BROWSER_HELPERS}
      const prep = ${JSON.stringify(prep)};
      const output = ${JSON.stringify(output)};
      const mountState = ${JSON.stringify(mountState)};
      const debug = window.__HMDAO_DEBUG__ || {};
      const state = debug.canvasStore?.getState?.();
      const updateNodeData = state?.updateNodeData;
      if (typeof updateNodeData !== 'function') {
        return { ok: false, error: 'ui-only-audio-split-video-update-unavailable' };
      }
      const buildGraph = (workflowNodeId, workflowNodeType, sourceMediaType, resultUrl, resultLabel, mimeType, data, model = 'ffmpeg-approximate') => hmdaoCompleteWorkflowGraph(hmdaoBuildNodeWorkflowGraph({
        nodeId: workflowNodeId,
        nodeType: workflowNodeType,
        executionMode: 'editing',
        generationMode: String(prep.generationMode || ''),
        provider: workflowNodeType === 'audio' ? 'local' : String(prep.provider || 'local'),
        model,
        prompt: String(prep.prompt || ''),
        sourceMediaType,
        toolOperation: ${JSON.stringify(VERIFY_VIDEO_TOOL_OPERATIONS.audioSplit)},
        primaryInputs: Array.isArray(prep.primaryInputs) ? prep.primaryInputs : [],
        referenceInputs: Array.isArray(prep.referenceInputs) ? prep.referenceInputs : [],
        identityController: prep.identityController || null,
      }), {
        outcome: 'completed',
        artifacts: [
          {
            stageKind: 'preprocess',
            label: '源节点引用',
            kind: 'reference-pack',
            storage: 'inline',
            data: {
              sourceNodeId: ${JSON.stringify(nodeId)},
              sourceNodeType: 'video',
              sourceVideoUrl: String(prep.sourceUrl || ''),
            },
          },
          {
            stageKind: 'deliver',
            label: resultLabel,
            kind: 'media',
            storage: String(resultUrl || '').startsWith('hmdao-local://') ? 'handle' : 'url',
            mimeType,
            url: String(resultUrl || '').startsWith('http') ? String(resultUrl || '') : undefined,
            handle: String(resultUrl || '').startsWith('hmdao-local://') ? String(resultUrl || '') : undefined,
            data,
          },
        ],
      });
      const videoGraph = buildGraph(
        mountState.derivedNodeId,
        'video',
        'video',
        String(output.video?.url || ''),
        String(mountState.labels?.video || ''),
        String(output.video?.mimeType || 'video/webm'),
        {
          sourceNodeId: ${JSON.stringify(nodeId)},
          sourceNodeType: 'video',
          localTool: 'audioSplit',
          processingEngine: String(output.processingEngine || ''),
        },
        String(output.processingEngine || 'ffmpeg-approximate'),
      );
      updateNodeData(mountState.derivedNodeId, {
        label: String(mountState.labels?.video || ''),
        prompt: String(prep.prompt || ''),
        model: String(prep.model || ''),
        provider: String(prep.provider || ''),
        status: 'completed',
        aspectRatio: Number(output.video?.width || 0) >= Number(output.video?.height || 0) ? '16:9' : '9:16',
        duration: Math.max(1, Math.round(Number(output.video?.duration || 1))),
        videoUrl: String(output.video?.url || ''),
        outputs: [{
          id: 'local-audio-split-video-' + String(Date.now()),
          type: 'video',
          url: String(output.video?.url || ''),
          metadata: {
            source: 'local-audioSplit',
            localTool: 'audioSplit',
            managedUrl: true,
            width: Number(output.video?.width || 0),
            height: Number(output.video?.height || 0),
            duration: Number(output.video?.duration || 0),
            mimeType: String(output.video?.mimeType || 'video/webm'),
            processingEngine: String(output.processingEngine || ''),
          },
        }],
        params: {
          videoTool: 'audioSplit',
          videoToolOperation: ${JSON.stringify(VERIFY_VIDEO_TOOL_OPERATIONS.audioSplit)},
          videoToolConfig: prep.nextConfig,
          videoMeta: {
            width: Number(output.video?.width || 0),
            height: Number(output.video?.height || 0),
            duration: Number(output.video?.duration || 0),
          },
          videoMimeType: String(output.video?.mimeType || 'video/webm'),
          sourceUrl: String(output.video?.url || ''),
          sourceMediaType: 'video',
          generationProgress: [],
          localVideoEditTool: 'audioSplit',
          localVideoEditAt: Date.now(),
          workflowGraph: videoGraph,
          workflowTemplateVersion: videoGraph.templateVersion,
          generationMode: String(prep.generationMode || ''),
          identityController: prep.identityController || null,
          lastError: '',
          lastErrorCategory: '',
        },
      });
      return {
        ok: true,
        derivedNodeId: mountState.derivedNodeId,
        videoUrl: String(output.video?.url || ''),
      };
    })()
  `, 20000), 25000, `ui-only audioSplit mount video ${nodeId}`);
  if (!result?.ok) {
    throw new Error(`ui-only audioSplit mount video failed: ${JSON.stringify(result)}`);
  }
  return result;
}

async function mountUiOnlyAudioSplitAudioNode(cdp, nodeId, prep, output, mountState, branchKey) {
  const branchMap = {
    full: {
      nodeId: mountState.fullAudioNodeId,
      label: mountState.labels?.full || '',
      output: output.audio,
      branchLabel: '音频',
      mode: 'bgm',
    },
    vocal: {
      nodeId: mountState.vocalNodeId,
      label: mountState.labels?.vocal || '',
      output: output.vocal,
      branchLabel: '纯人声',
      mode: 'voiceover',
    },
    accompaniment: {
      nodeId: mountState.accompanimentNodeId,
      label: mountState.labels?.accompaniment || '',
      output: output.accompaniment,
      branchLabel: '伴奏',
      mode: 'bgm',
    },
  };
  const branch = branchMap[branchKey];
  const result = await withExternalTimeout(() => evalJs(cdp, `
    (() => {
      ${UI_ONLY_WORKFLOW_BROWSER_HELPERS}
      const prep = ${JSON.stringify(prep)};
      const output = ${JSON.stringify(output)};
      const branch = ${JSON.stringify(branch)};
      const debug = window.__HMDAO_DEBUG__ || {};
      const state = debug.canvasStore?.getState?.();
      const updateNodeData = state?.updateNodeData;
      if (typeof updateNodeData !== 'function' || !branch?.nodeId) {
        return { ok: false, error: 'ui-only-audio-split-audio-update-unavailable' };
      }
      const buildGraph = hmdaoCompleteWorkflowGraph(hmdaoBuildNodeWorkflowGraph({
        nodeId: branch.nodeId,
        nodeType: 'audio',
        executionMode: 'editing',
        generationMode: String(prep.generationMode || ''),
        provider: 'local',
        model: 'ffmpeg-approximate',
        prompt: String(prep.prompt || ''),
        sourceMediaType: 'audio',
        toolOperation: ${JSON.stringify(VERIFY_VIDEO_TOOL_OPERATIONS.audioSplit)},
        primaryInputs: Array.isArray(prep.primaryInputs) ? prep.primaryInputs : [],
        referenceInputs: Array.isArray(prep.referenceInputs) ? prep.referenceInputs : [],
        identityController: prep.identityController || null,
      }), {
        outcome: 'completed',
        artifacts: [
          {
            stageKind: 'preprocess',
            label: '源节点引用',
            kind: 'reference-pack',
            storage: 'inline',
            data: {
              sourceNodeId: ${JSON.stringify(nodeId)},
              sourceNodeType: 'video',
              sourceVideoUrl: String(prep.sourceUrl || ''),
            },
          },
          {
            stageKind: 'deliver',
            label: String(branch.label || ''),
            kind: 'media',
            storage: String(branch.output?.url || '').startsWith('hmdao-local://') ? 'handle' : 'url',
            mimeType: String(branch.output?.mimeType || 'audio/wav'),
            url: String(branch.output?.url || '').startsWith('http') ? String(branch.output?.url || '') : undefined,
            handle: String(branch.output?.url || '').startsWith('hmdao-local://') ? String(branch.output?.url || '') : undefined,
            data: {
              sourceNodeId: ${JSON.stringify(nodeId)},
              sourceNodeType: 'video',
              localTool: 'audioSplit',
              branchLabel: String(branch.branchLabel || ''),
              processingEngine: String(output.processingEngine || ''),
            },
          },
        ],
      });
      updateNodeData(branch.nodeId, {
        label: String(branch.label || ''),
        provider: 'local',
        model: 'ffmpeg-approximate',
        status: 'completed',
        outputs: [{
          id: 'local-audio-split-' + String(branch.branchLabel || 'audio') + '-' + String(Date.now()),
          type: 'audio',
          url: String(branch.output?.url || ''),
          metadata: {
            source: 'local-audioSplit',
            localTool: 'audioSplit',
            managedUrl: true,
            duration: Number(branch.output?.duration || 0),
            format: String(branch.output?.format || ''),
            mimeType: String(branch.output?.mimeType || 'audio/wav'),
            sampleRate: Number(branch.output?.sampleRate || 0),
            channels: Number(branch.output?.channels || 0),
            branchLabel: String(branch.branchLabel || ''),
            processingEngine: String(output.processingEngine || ''),
          },
        }],
        params: {
          audioMode: String(branch.mode || 'bgm'),
          audioBackend: 'fallback-local',
          audioMeta: {
            duration: Number(branch.output?.duration || 0),
            format: String(branch.output?.format || ''),
            sampleRate: Number(branch.output?.sampleRate || 0),
            channels: Number(branch.output?.channels || 0),
            engine: String(output.processingEngine || 'ffmpeg-approximate'),
            backend: 'fallback-local',
            backendLabel: '本地预览链',
            requestedBackend: 'fallback-local',
            backendAvailable: true,
            fallbackUsed: false,
          },
          sourceUrl: String(branch.output?.url || ''),
          sourceMediaType: 'audio',
          audioBranchLabel: String(branch.branchLabel || ''),
          workflowGraph: buildGraph,
          workflowTemplateVersion: buildGraph.templateVersion,
        },
      });
      return {
        ok: true,
        nodeId: String(branch.nodeId || ''),
        audioUrl: String(branch.output?.url || ''),
      };
    })()
  `, 20000), 25000, `ui-only audioSplit mount ${branchKey} audio ${nodeId}`);
  if (!result?.ok) {
    throw new Error(`ui-only audioSplit mount ${branchKey} audio failed: ${JSON.stringify(result)}`);
  }
  return result;
}

async function finalizeUiOnlyAudioSplitMount(cdp, nodeId, prep, output, mountState) {
  const result = await withExternalTimeout(() => evalJs(cdp, `
    (() => {
      ${UI_ONLY_WORKFLOW_BROWSER_HELPERS}
      const prep = ${JSON.stringify(prep)};
      const output = ${JSON.stringify(output)};
      const mountState = ${JSON.stringify(mountState)};
      const debug = window.__HMDAO_DEBUG__ || {};
      const state = debug.canvasStore?.getState?.();
      const addEdge = state?.addEdge;
      const updateNodeData = state?.updateNodeData;
      const setSelectedNodeIds = state?.setSelectedNodeIds;
      if (typeof addEdge !== 'function' || typeof updateNodeData !== 'function') {
        return { ok: false, error: 'ui-only-audio-split-finalize-store-unavailable' };
      }
      const sourceWorkflowGraph = hmdaoCompleteWorkflowGraph(hmdaoBuildNodeWorkflowGraph({
        nodeId: ${JSON.stringify(nodeId)},
        nodeType: 'video',
        executionMode: 'editing',
        generationMode: String(prep.generationMode || ''),
        provider: String(prep.provider || 'local'),
        model: String(prep.model || 'local-audio-split'),
        prompt: String(prep.prompt || ''),
        sourceMediaType: String(prep.sourceMediaType || 'video'),
        toolOperation: ${JSON.stringify(VERIFY_VIDEO_TOOL_OPERATIONS.audioSplit)},
        primaryInputs: Array.isArray(prep.primaryInputs) ? prep.primaryInputs : [],
        referenceInputs: Array.isArray(prep.referenceInputs) ? prep.referenceInputs : [],
        identityController: prep.identityController || null,
      }), {
        outcome: 'completed',
        artifacts: [{
          stageKind: 'deliver',
          label: String(mountState.labels?.video || ''),
          kind: 'delivery-package',
          storage: 'inline',
          data: {
            localTool: 'audioSplit',
            derivedNodeId: mountState.derivedNodeId,
            audioNodeId: mountState.fullAudioNodeId,
            vocalNodeId: mountState.vocalNodeId,
            accompanimentNodeId: mountState.accompanimentNodeId,
            processingEngine: String(output.processingEngine || ''),
          },
        }],
      });
      addEdge(${JSON.stringify(nodeId)}, mountState.derivedNodeId, { sourceHandle: 'media-output', targetHandle: 'video-main' });
      addEdge(${JSON.stringify(nodeId)}, mountState.fullAudioNodeId, { sourceHandle: 'media-output' });
      addEdge(${JSON.stringify(nodeId)}, mountState.vocalNodeId, { sourceHandle: 'media-output' });
      addEdge(${JSON.stringify(nodeId)}, mountState.accompanimentNodeId, { sourceHandle: 'media-output' });
      updateNodeData(${JSON.stringify(nodeId)}, {
        status: 'completed',
        params: {
          videoTool: 'audioSplit',
          videoToolOperation: ${JSON.stringify(VERIFY_VIDEO_TOOL_OPERATIONS.audioSplit)},
          videoToolConfig: prep.nextConfig,
          localVideoEditTool: 'audioSplit',
          localVideoEditAt: Date.now(),
          localVideoDerivedNodeId: mountState.derivedNodeId,
          localVideoDerivedTool: 'audioSplit',
          localVideoDerivedLabel: String(mountState.labels?.video || ''),
          localAudioSourceUrl: String(output.audio?.url || ''),
          localAudioDerivedNodeId: mountState.fullAudioNodeId,
          localAudioDerivedLabel: String(mountState.labels?.full || ''),
          localAudioVocalNodeId: mountState.vocalNodeId,
          localAudioVocalSourceUrl: String(output.vocal?.url || ''),
          localAudioVocalLabel: String(mountState.labels?.vocal || ''),
          localAudioAccompanimentNodeId: mountState.accompanimentNodeId,
          localAudioAccompanimentSourceUrl: String(output.accompaniment?.url || ''),
          localAudioAccompanimentLabel: String(mountState.labels?.accompaniment || ''),
          workflowGraph: sourceWorkflowGraph,
          workflowTemplateVersion: sourceWorkflowGraph.templateVersion,
          sourceMediaType: String(prep.sourceMediaType || 'video'),
          generationMode: String(prep.generationMode || ''),
          identityController: prep.identityController || null,
          lastError: '',
          lastErrorCategory: '',
        },
      });
      if (typeof setSelectedNodeIds === 'function') {
        setSelectedNodeIds([mountState.derivedNodeId]);
      }
      return {
        ok: true,
        derivedNodeId: mountState.derivedNodeId,
        fullAudioNodeId: mountState.fullAudioNodeId,
        vocalNodeId: mountState.vocalNodeId,
        accompanimentNodeId: mountState.accompanimentNodeId,
        videoUrl: String(output.video?.url || ''),
      };
    })()
  `, 20000), 25000, `ui-only audioSplit finalize ${nodeId}`);
  if (!result?.ok) {
    throw new Error(`ui-only audioSplit finalize failed: ${JSON.stringify(result)}`);
  }
  return result;
}

async function runUiOnlyLocalAudioSplit(cdp, nodeId, patch = {}) {
  const patchRecord = patch && typeof patch === 'object' ? patch : {};
  const {
    sourceUrl: directSourceUrl = '',
    generationMode: directGenerationMode = '',
    sourceMediaType: directSourceMediaType = 'video',
    prompt: directPrompt = '',
    model: directModel = '',
    provider: directProvider = '',
    primaryInputs: directPrimaryInputs = [],
    referenceInputs: directReferenceInputs = [],
    identityController: directIdentityController = null,
    ...patchOverrides
  } = patchRecord;
  const prep = String(directSourceUrl || '').trim()
    ? {
      ok: true,
      sourceUrl: String(directSourceUrl),
      nextConfig: {
        tool: 'audioSplit',
        keepVocalInVideo: true,
        exportToWorkflow: true,
        ...(patchOverrides && typeof patchOverrides === 'object' ? patchOverrides : {}),
      },
      generationMode: String(directGenerationMode || ''),
      sourceMediaType: String(directSourceMediaType || 'video'),
      prompt: String(directPrompt || ''),
      model: String(directModel || ''),
      provider: String(directProvider || ''),
      primaryInputs: Array.isArray(directPrimaryInputs) ? directPrimaryInputs : [],
      referenceInputs: Array.isArray(directReferenceInputs) ? directReferenceInputs : [],
      identityController: directIdentityController || null,
      source: 'caller-source-url',
    }
    : await withExternalTimeout(
      () => readUiOnlyLocalVideoToolPrep(
        cdp,
        nodeId,
        'audioSplit',
        {
          tool: 'audioSplit',
          keepVocalInVideo: true,
          exportToWorkflow: true,
        },
        patchOverrides,
      ),
      25000,
      `ui-only audioSplit prep ${nodeId}`,
    );
  log('ui-only audioSplit:prep-ready', {
    nodeId,
    sourceUrl: String(prep?.sourceUrl || ''),
    config: prep?.nextConfig || null,
  });
  await replaceVideoToolState(cdp, nodeId, 'audioSplit', prep?.nextConfig || {
    tool: 'audioSplit',
    keepVocalInVideo: true,
    exportToWorkflow: true,
  }, {
    localVideoEditTool: 'audioSplit',
    lastError: '',
    lastErrorCategory: '',
    lastErrorStage: '',
    error: '',
  });
  log('ui-only audioSplit:state-reset', {
    nodeId,
    config: prep?.nextConfig || null,
  });

  let output;
  try {
    log('ui-only audioSplit:request-start', { nodeId });
    output = normalizeUiOnlyAudioSplitOutput(
      await withExternalTimeout(
        () => requestUiOnlyLocalVideoEdit('audioSplit', prep.sourceUrl, prep.nextConfig),
        Number(process.env.HMDAO_VERIFY_LOCAL_VIDEO_EDIT_TIMEOUT_MS || 45000) + 5000,
        `ui-only audioSplit request ${nodeId}`,
      ),
    );
    log('ui-only audioSplit:request-done', {
      nodeId,
      videoUrl: String(output?.video?.url || ''),
      fullAudioUrl: String(output?.audio?.url || ''),
      vocalAudioUrl: String(output?.vocal?.url || ''),
      accompanimentAudioUrl: String(output?.accompaniment?.url || ''),
      processingEngine: String(output?.processingEngine || ''),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await evalJs(cdp, `
      (() => {
        const state = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
        const sourceNode = state?.canvas?.nodes?.find((item) => item.id === ${JSON.stringify(nodeId)});
        const params = sourceNode?.data?.params || {};
        if (typeof state?.updateNodeData === 'function') {
          state.updateNodeData(${JSON.stringify(nodeId)}, {
            status: 'error',
            error: ${JSON.stringify(message)},
            params: {
              ...params,
              lastError: ${JSON.stringify(message)},
              lastErrorCategory: 'local-audio-split',
              lastErrorStage: 'local-audio-split',
            },
          });
        }
        return true;
      })()
    `, 10000).catch(() => false);
    throw new Error(`ui-only audioSplit trigger failed: ${message}`);
  }

  try {
    log('ui-only audioSplit:scaffold-start', { nodeId });
    const mountState = await createUiOnlyAudioSplitMountState(cdp, nodeId);
    log('ui-only audioSplit:scaffold-done', mountState);
    log('ui-only audioSplit:video-mount-start', {
      nodeId,
      derivedNodeId: mountState.derivedNodeId,
    });
    await mountUiOnlyAudioSplitVideoNode(cdp, nodeId, prep, output, mountState);
    log('ui-only audioSplit:video-mounted', {
      nodeId,
      derivedNodeId: mountState.derivedNodeId,
      videoUrl: String(output?.video?.url || ''),
    });
    log('ui-only audioSplit:full-mount-start', {
      nodeId,
      audioNodeId: mountState.fullAudioNodeId,
    });
    await mountUiOnlyAudioSplitAudioNode(cdp, nodeId, prep, output, mountState, 'full');
    log('ui-only audioSplit:full-mounted', {
      nodeId,
      audioNodeId: mountState.fullAudioNodeId,
      audioUrl: String(output?.audio?.url || ''),
    });
    log('ui-only audioSplit:vocal-mount-start', {
      nodeId,
      audioNodeId: mountState.vocalNodeId,
    });
    await mountUiOnlyAudioSplitAudioNode(cdp, nodeId, prep, output, mountState, 'vocal');
    log('ui-only audioSplit:vocal-mounted', {
      nodeId,
      audioNodeId: mountState.vocalNodeId,
      audioUrl: String(output?.vocal?.url || ''),
    });
    log('ui-only audioSplit:accompaniment-mount-start', {
      nodeId,
      audioNodeId: mountState.accompanimentNodeId,
    });
    await mountUiOnlyAudioSplitAudioNode(cdp, nodeId, prep, output, mountState, 'accompaniment');
    log('ui-only audioSplit:accompaniment-mounted', {
      nodeId,
      audioNodeId: mountState.accompanimentNodeId,
      audioUrl: String(output?.accompaniment?.url || ''),
    });
    log('ui-only audioSplit:finalize-start', {
      nodeId,
      derivedNodeId: mountState.derivedNodeId,
    });
    const finalized = await finalizeUiOnlyAudioSplitMount(cdp, nodeId, prep, output, mountState);
    log('ui-only audioSplit:finalize-done', finalized);
    return finalized;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await withExternalTimeout(() => evalJs(cdp, `
      (() => {
        const state = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
        const sourceNode = state?.canvas?.nodes?.find((item) => item.id === ${JSON.stringify(nodeId)});
        const params = sourceNode?.data?.params || {};
        if (typeof state?.updateNodeData === 'function') {
          state.updateNodeData(${JSON.stringify(nodeId)}, {
            status: 'error',
            error: ${JSON.stringify(message)},
            params: {
              ...params,
              lastError: ${JSON.stringify(message)},
              lastErrorCategory: 'local-audio-split',
              lastErrorStage: 'local-audio-split-apply',
            },
          });
        }
        return true;
      })()
    `, 10000), 5000, `ui-only audioSplit error state ${nodeId}`).catch(() => false);
    throw error;
  }
}

async function clickVideoToolApply(cdp, nodeId, tool) {
  const selector = `[data-testid="video-tool-apply-${nodeId}"]`;
  const directClickOk = await evalJs(cdp, `
    (() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return false;
      element.click();
      return true;
    })()
  `, 10000).catch(() => false);
  if (directClickOk) {
    return;
  }
  let visible = await waitFor(cdp, `!!document.querySelector(${JSON.stringify(selector)})`, 1500, 100).catch(() => false);
  if (!visible && tool) {
    await evalJs(cdp, `
      (() => {
        const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
        const setSelectedNodeIds = store?.setSelectedNodeIds;
        const updateNodeData = store?.updateNodeData;
        const canvas = store?.canvas;
        const node = canvas?.nodes?.find((item) => item.id === ${JSON.stringify(nodeId)});
        const params = node?.data?.params || {};
        if (typeof setSelectedNodeIds === 'function') {
          setSelectedNodeIds([${JSON.stringify(nodeId)}]);
        }
        if (typeof updateNodeData === 'function') {
          updateNodeData(${JSON.stringify(nodeId)}, {
            params: {
              ...params,
              videoTool: ${JSON.stringify(tool)},
            },
          });
        }
        return true;
      })()
    `, 10000).catch(() => false);
    const point = await evalJs(cdp, `
      (() => {
        const element = document.querySelector(${JSON.stringify(`[data-testid="video-node-${nodeId}"]`)})
          || document.querySelector(${JSON.stringify(`.react-flow__node[data-id="${nodeId}"]`)});
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return {
          x: rect.left + (rect.width / 2),
          y: rect.top + Math.max(24, Math.min(rect.height * 0.38, rect.height - 24)),
        };
      })()
    `, 10000).catch(() => null);
    if (point) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Number(point.x),
        y: Number(point.y),
        button: 'left',
        buttons: 0,
        modifiers: 0,
      });
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: Number(point.x),
        y: Number(point.y),
        button: 'left',
        clickCount: 1,
        buttons: 1,
        modifiers: 0,
      });
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: Number(point.x),
        y: Number(point.y),
        button: 'left',
        buttons: 0,
        modifiers: 0,
      });
    }
    visible = await waitFor(cdp, `!!document.querySelector(${JSON.stringify(selector)})`, 2500, 100).catch(() => false);
  }
  if (!visible) {
    const debugState = await evalJs(cdp, `
      (() => {
        const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.() || {};
        const node = (store.canvas?.nodes || []).find((item) => item.id === ${JSON.stringify(nodeId)});
        return {
          selectedNodeIds: Array.isArray(store.selectedNodeIds) ? store.selectedNodeIds : [],
          floatingPanel: store.floatingPanel || null,
          activeTool: String(node?.data?.params?.videoTool || ''),
          toolbarVisible: Boolean(document.querySelector(${JSON.stringify(`[data-testid="video-toolbar-${nodeId}-${tool}"]`)})),
          inlineVisible: Boolean(document.querySelector(${JSON.stringify(`[data-testid="video-tool-${nodeId}-${tool}"]`)})),
          applyVisible: Boolean(document.querySelector(${JSON.stringify(selector)})),
        };
      })()
    `, 10000).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
    throw new Error(`Apply button not available for ${tool} on ${nodeId}: ${JSON.stringify(debugState)}`);
  }
  await clickSelector(cdp, selector);
}

async function selectorCenter(cdp, selector) {
  const box = await evalJs(cdp, `
    (() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height };
    })()
  `);
  if (!box) throw new Error(`Unable to resolve selector center: ${selector}`);
  return box;
}
async function clickSelectorAtRatio(cdp, selector, ratio) {
  const ok = await evalJs(cdp, `
    (() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const clientX = rect.left + rect.width * ${ratio.x};
      const clientY = rect.top + rect.height * ${ratio.y};
      const firePointer = (type) => {
        const event = new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX,
          clientY,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          button: 0,
          buttons: type === 'pointerup' ? 0 : 1,
        });
        element.dispatchEvent(event);
      };
      const fireMouse = (type) => {
        const event = new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          button: 0,
          buttons: type === 'mouseup' ? 0 : 1,
        });
        element.dispatchEvent(event);
      };
      firePointer('pointerdown');
      fireMouse('mousedown');
      firePointer('pointerup');
      fireMouse('mouseup');
      fireMouse('click');
      return true;
    })()
  `);
  if (!ok) throw new Error(`Unable to click selector at ratio: ${selector}`);
}

async function dragSelector(cdp, selector, fromRatio, toRatio, steps = 8) {
  const ok = await evalJs(cdp, `
    (async () => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const startX = rect.left + rect.width * ${Number(fromRatio.x)};
      const startY = rect.top + rect.height * ${Number(fromRatio.y)};
      const endX = rect.left + rect.width * ${Number(toRatio.x)};
      const endY = rect.top + rect.height * ${Number(toRatio.y)};
      const pointerId = 1;
      const fire = (type, clientX, clientY) => {
        const event = new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId,
          pointerType: 'mouse',
          isPrimary: true,
          clientX,
          clientY,
          button: 0,
          buttons: type === 'pointerup' ? 0 : 1,
        });
        element.dispatchEvent(event);
      };
      fire('pointerdown', startX, startY);
      for (let step = 1; step <= ${Number(steps)}; step += 1) {
        const progress = step / ${Number(steps)};
        fire('pointermove', startX + ((endX - startX) * progress), startY + ((endY - startY) * progress));
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      }
      fire('pointerup', endX, endY);
      return true;
    })()
  `, 15000);
  if (!ok) throw new Error(`Unable to drag selector: ${selector}`);
}

async function nativeClickNodeByTestId(cdp, selector, fallbackRatio = { x: 0.5, y: 0.38 }) {
  const point = await evalJs(cdp, `
    (() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        x: rect.left + (rect.width * ${Number(fallbackRatio.x)}),
        y: rect.top + Math.max(24, Math.min(rect.height * ${Number(fallbackRatio.y)}, rect.height - 24)),
      };
    })()
  `, 10000).catch(() => null);
  if (!point) return false;
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Number(point.x),
    y: Number(point.y),
    button: 'left',
    buttons: 0,
    modifiers: 0,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: Number(point.x),
    y: Number(point.y),
    button: 'left',
    clickCount: 1,
    buttons: 1,
    modifiers: 0,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: Number(point.x),
    y: Number(point.y),
    button: 'left',
    buttons: 0,
    modifiers: 0,
  });
  return true;
}

async function dragSelectorNative(cdp, selector, fromRatio, toRatio, steps = 8) {
  const points = await evalJs(cdp, `
    (() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        startX: rect.left + rect.width * ${Number(fromRatio.x)},
        startY: rect.top + rect.height * ${Number(fromRatio.y)},
        endX: rect.left + rect.width * ${Number(toRatio.x)},
        endY: rect.top + rect.height * ${Number(toRatio.y)},
      };
    })()
  `, 10000);
  if (!points) throw new Error(`Unable to resolve selector bounds: ${selector}`);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Number(points.startX),
    y: Number(points.startY),
    button: 'left',
    buttons: 0,
    modifiers: 0,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: Number(points.startX),
    y: Number(points.startY),
    button: 'left',
    clickCount: 1,
    buttons: 1,
    modifiers: 0,
  });
  for (let step = 1; step <= Number(steps); step += 1) {
    const progress = step / Number(steps);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Number(points.startX) + ((Number(points.endX) - Number(points.startX)) * progress),
      y: Number(points.startY) + ((Number(points.endY) - Number(points.startY)) * progress),
      button: 'left',
      buttons: 1,
      modifiers: 0,
    });
    await sleep(16);
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: Number(points.endX),
    y: Number(points.endY),
    button: 'left',
    buttons: 0,
    modifiers: 0,
  });
}

async function readLatestArtifactSummarySince(startedAtMs, verifyMode) {
  const artifactsDir = path.join(APP_DIR, 'server', 'artifacts');
  const entries = await fs.readdir(artifactsDir, { withFileTypes: true }).catch(() => []);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('browser-')) continue;
    const summaryPath = path.join(artifactsDir, entry.name, 'summary.json');
    if (!existsSync(summaryPath)) continue;
    const stat = await fs.stat(summaryPath).catch(() => null);
    if (!stat || stat.mtimeMs < startedAtMs) continue;
    const raw = await fs.readFile(summaryPath, 'utf8').catch(() => '');
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (verifyMode && String(parsed?.verifyMode || '') !== verifyMode) continue;
      candidates.push({ summaryPath, mtimeMs: stat.mtimeMs, parsed });
    } catch {
      // ignore malformed summaries
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.parsed || null;
}

async function runNestedReferenceConsistencyVerification(cdp, recorder, workflowFrames) {
  const state = await verifyReferenceConsistencyUiOnly(cdp, recorder, workflowFrames);
  assert(state, 'Nested reference-consistency-only state missing.', state);
  return state;
}

function buildApiDiscoveryMockFixtures() {
  const models = [
    {
      id: 'seedance-v2',
      name: 'Seedance V2',
      mode: 'video',
      provider: 'volcengine',
      providerLabel: '火山引擎',
      catalogModelId: 'seedance-v2',
      upstreamModel: 'doubao-seedance-2-0',
      supportedOnCanvas: true,
      recommended: true,
      recommendationScore: 98,
      recommendation: '适合全能参考、主体替换和保运镜视频生成。',
      price: 2.8,
      currency: 'CNY',
      priceUnit: 'per-video',
      pricingSummary: '¥2.80 / 视频',
      description: '强条件视频生成与参考控制。',
    },
    {
      id: 'wan22-i2v-a14b',
      name: 'Wan 2.2 I2V',
      mode: 'video',
      provider: 'siliconflow',
      providerLabel: '硅基流动',
      catalogModelId: 'wan22-i2v-a14b',
      upstreamModel: 'Wan-AI/Wan2.2-I2V-A14B',
      supportedOnCanvas: true,
      recommended: false,
      recommendationScore: 86,
      recommendation: '适合常规图生视频预览。',
      price: 0.29,
      currency: 'USD',
      priceUnit: 'per-video',
      pricingSummary: 'USD 0.29 / 视频',
      description: '常规图生视频。',
    },
    {
      id: 'qwen-image-edit',
      name: 'Qwen Image Edit',
      mode: 'image',
      provider: 'siliconflow',
      providerLabel: '硅基流动',
      catalogModelId: 'lib-image',
      upstreamModel: 'Qwen/Qwen-Image-Edit',
      supportedOnCanvas: true,
      recommended: true,
      recommendationScore: 96,
      recommendation: '适合保构图换主体和多图参考融合。',
      price: 0.32,
      currency: 'CNY',
      priceUnit: 'per-image',
      pricingSummary: '¥0.32 / 张',
      description: '强编辑型图片生成。',
    },
    {
      id: 'seedream-4',
      name: 'Seedream 4.0',
      mode: 'image',
      provider: 'volcengine',
      providerLabel: '火山引擎',
      catalogModelId: 'seedream-4',
      upstreamModel: 'doubao-seedream-4.0',
      supportedOnCanvas: true,
      recommended: false,
      recommendationScore: 89,
      recommendation: '适合商品图与海报图。',
      price: 0.42,
      currency: 'CNY',
      priceUnit: 'per-image',
      pricingSummary: '¥0.42 / 张',
      description: '高质感商品图。',
    },
    {
      id: 'qwen-vl-max',
      name: 'Qwen VL Max',
      mode: 'llm',
      provider: 'dashscope',
      providerLabel: '阿里云百炼',
      catalogModelId: 'qwen-vl-max',
      upstreamModel: 'qwen-vl-max',
      supportedOnCanvas: true,
      recommended: true,
      recommendationScore: 93,
      recommendation: '适合图片解析、视频语义分析和提示词反推。',
      price: 0.01,
      currency: 'CNY',
      priceUnit: 'per-1k-tokens',
      pricingSummary: '¥0.01 / 1K tokens',
      description: '多模态理解。',
    },
    {
      id: 'qwen-vl-max-mirror',
      name: 'Qwen VL Max Mirror',
      mode: 'llm',
      provider: 'relay-mirror',
      providerLabel: 'Relay Mirror',
      catalogModelId: 'qwen-vl-max',
      upstreamModel: 'qwen-vl-max',
      supportedOnCanvas: true,
      recommended: false,
      recommendationScore: 84,
      recommendation: '同族镜像节点，用于去重断言。',
      price: 0.01,
      currency: 'CNY',
      priceUnit: 'per-1k-tokens',
      pricingSummary: '¥0.01 / 1K tokens',
      description: '同族镜像节点。',
    },
    {
      id: 'suno-v4',
      name: 'Suno Music',
      mode: 'audio',
      provider: 'suno',
      providerLabel: 'Suno',
      catalogModelId: 'suno_music',
      upstreamModel: 'suno_music',
      supportedOnCanvas: true,
      recommended: true,
      recommendationScore: 91,
      recommendation: '适合 BGM 和带风格标签的音频生成。',
      price: 0.5,
      currency: 'USD',
      priceUnit: 'per-track',
      pricingSummary: 'USD 0.50 / 曲',
      description: '音乐生成。',
    },
  ];
  return {
    success: true,
    endpoint: 'https://relay.mock.local/v1',
    relayPresetId: 'comfly',
    relayName: 'Comfly Mock',
    message: '已拉取 mock 模型列表，推荐摘要与任务筛选已就绪。',
    models,
    recommended: {
      image: [models[2], models[3]],
      video: [models[0], models[1]],
      audio: [models[6]],
      llm: [models[4]],
    },
  };
}

async function installApiDiscoveryMock(cdp) {
  const authPayload = {
    state: {
      user: { id: 'browser-verify', email: 'browser-verify@hmdao.local', createdAt: new Date().toISOString() },
      session: { accessToken: 'browser-verify', refreshToken: 'browser-verify-refresh', expiresAt: Date.now() + 3600000 },
      hasHydrated: true,
      isLoading: false,
    },
    version: 0,
  };
  const apiKeysPayload = {
    state: { keys: {}, secureReady: true, secureLoading: false },
    version: 0,
  };
  const providersPayload = {
    success: true,
    providers: [
      { id: 'siliconflow', name: '硅基流动', domestic: true, modes: ['image', 'video', 'llm'] },
      { id: 'bailian', name: '阿里云百炼', domestic: true, modes: ['image', 'video', 'llm'] },
      { id: 'volcengine', name: '火山方舟', domestic: true, modes: ['image', 'video', 'llm', 'audio'] },
    ],
  };
  const runtimePayload = {
    success: true,
    activatedProviders: [],
    recommendations: {},
  };
  const discoveryPayload = buildApiDiscoveryMockFixtures();
  const source = `(() => {
    const authPayload = ${JSON.stringify(JSON.stringify(authPayload))};
    const apiKeysPayload = ${JSON.stringify(JSON.stringify(apiKeysPayload))};
    const providersPayload = ${JSON.stringify(providersPayload)};
    const runtimePayload = ${JSON.stringify(runtimePayload)};
    const discoveryPayload = ${JSON.stringify(discoveryPayload)};
    try { localStorage.setItem('hmdao-auth-storage', authPayload); } catch {}
    try { localStorage.setItem('hmdao-api-keys', apiKeysPayload); } catch {}
    const installFetchMock = () => {
      if (window.__HMDAO_DISCOVERY_MOCK_INSTALLED__) return;
      if (typeof window.fetch !== 'function') return;
      const originalFetch = window.fetch.bind(window);
      window.__HMDAO_DISCOVERY_MOCK_INSTALLED__ = true;
      window.fetch = async (input, init) => {
        const rawUrl = typeof input === 'string' ? input : (input && typeof input.url === 'string' ? input.url : '');
        const url = new URL(rawUrl || '', window.location.origin);
        if (url.pathname === '/api/byok/providers') {
          return new Response(JSON.stringify(providersPayload), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.pathname === '/api/byok/runtime') {
          return new Response(JSON.stringify(runtimePayload), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.pathname === '/api/byok/relay/discover') {
          return new Response(JSON.stringify(discoveryPayload), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return originalFetch(input, init);
      };
    };
    installFetchMock();
    window.__HMDAO_DISCOVERY_MOCK__ = discoveryPayload;
    return true;
  })();`;
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source });
  await evalJs(cdp, source, 10000).catch(() => false);
}

async function verifyApiDiscoveryMockVisibleRegression(cdp, recorder) {
  await installApiDiscoveryMock(cdp);
  await openApiKeysRoute(cdp);
  await waitForSelector(cdp, '[data-testid="api-relay-base-url"]', 30000);
  await waitForSelector(cdp, '[data-testid="api-relay-api-key"]', 30000);
  await setValue(cdp, '[data-testid="api-relay-base-url"]', 'https://relay.mock.local/v1');
  await setValue(cdp, '[data-testid="api-relay-api-key"]', 'sk-mock-discover-verify');
  await waitFor(cdp, `(() => {
    const button = document.querySelector('[data-testid="api-relay-discover-button"]');
    return Boolean(button && !button.disabled);
  })()`, 10000, 100);
  await clickSelector(cdp, '[data-testid="api-relay-discover-button"]');
  await waitForSelector(cdp, '[data-testid="api-relay-discovery-summary"]', 30000);
  const allState = await evalJs(cdp, `(() => {
    const cards = [...document.querySelectorAll('[data-testid="api-relay-discovery-list"] article')];
    return {
      count: cards.length,
      titles: cards.slice(0, 6).map((card) => String(card.querySelector('.text-sm.font-semibold')?.textContent || '').trim()).filter(Boolean),
      summaryText: String(document.querySelector('[data-testid="api-relay-discovery-summary"]')?.textContent || '').replace(/\\s+/g, ' ').trim(),
    };
  })()`, 10000);
  await clickSelector(cdp, '[data-testid="api-relay-discovery-filter-video"]');
  const videoState = await evalJs(cdp, `(() => ({
    count: document.querySelectorAll('[data-testid="api-relay-discovery-list"] article').length,
    text: String(document.querySelector('[data-testid="api-relay-discovery-list"]')?.textContent || '').replace(/\\s+/g, ' ').trim(),
  }))()`, 10000);
  await clickSelector(cdp, '[data-testid="api-relay-discovery-toggle-recommended"]');
  const recommendedState = await evalJs(cdp, `(() => ({
    count: document.querySelectorAll('[data-testid="api-relay-discovery-list"] article').length,
    text: String(document.querySelector('[data-testid="api-relay-discovery-list"]')?.textContent || '').replace(/\\s+/g, ' ').trim(),
  }))()`, 10000);
  await clickSelector(cdp, '[data-testid="api-relay-discovery-toggle-canvas-ready"]');
  const canvasReadyState = await evalJs(cdp, `(() => ({
    count: document.querySelectorAll('[data-testid="api-relay-discovery-list"] article').length,
    text: String(document.querySelector('[data-testid="api-relay-discovery-list"]')?.textContent || '').replace(/\\s+/g, ' ').trim(),
  }))()`, 10000);
  await clickSelector(cdp, '[data-testid="api-relay-discovery-filter-llm"]');
  await clickSelector(cdp, '[data-testid="api-relay-discovery-toggle-recommended"]');
  await clickSelector(cdp, '[data-testid="api-relay-discovery-toggle-canvas-ready"]');
  await clickSelector(cdp, '[data-testid="api-relay-discovery-toggle-deduped"]');
  const llmStateBeforeDedupe = await evalJs(cdp, `(() => ({
    count: document.querySelectorAll('[data-testid="api-relay-discovery-list"] article').length,
    text: String(document.querySelector('[data-testid="api-relay-discovery-list"]')?.textContent || '').replace(/\\s+/g, ' ').trim(),
  }))()`, 10000);
  await clickSelector(cdp, '[data-testid="api-relay-discovery-toggle-deduped"]');
  const llmStateAfterDedupe = await evalJs(cdp, `(() => ({
    count: document.querySelectorAll('[data-testid="api-relay-discovery-list"] article').length,
    text: String(document.querySelector('[data-testid="api-relay-discovery-list"]')?.textContent || '').replace(/\\s+/g, ' ').trim(),
  }))()`, 10000);
  const state = {
    passed: Boolean(
      allState?.count >= 4
      && videoState?.count >= 1
      && recommendedState?.count >= 1
      && canvasReadyState?.count >= 1
      && llmStateBeforeDedupe?.count >= 2
      && llmStateAfterDedupe?.count === 1
    ),
    allState,
    videoState,
    recommendedState,
    canvasReadyState,
    llmStateBeforeDedupe,
    llmStateAfterDedupe,
  };
  await recorder(state.passed ? 'api-discovery-mock-visible-verified' : 'api-discovery-mock-visible-failed', state);
  assert(state.passed, 'API 管理页 discovery mock 可见态回归未通过。', state);
  return state;
}

async function adjustClipEditorSelection(cdp, nodeId, options = {}) {
  const startRatio = Number(options.startRatio ?? 0.24);
  const endRatio = Number(options.endRatio ?? 0.78);
  const trackSelector = `[data-testid="video-clip-track-${nodeId}"]`;
  const startHandleSelector = `[data-testid="video-clip-start-handle-${nodeId}"]`;
  const endHandleSelector = `[data-testid="video-clip-end-handle-${nodeId}"]`;
  await waitForSelector(cdp, trackSelector, 10000);
  const readEditorDraftState = async () => await evalJs(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
      const duration = Number(node?.data?.duration || node?.data?.params?.duration || 0);
      const track = document.querySelector(${JSON.stringify(trackSelector)});
      const startHandle = document.querySelector(${JSON.stringify(startHandleSelector)});
      const endHandle = document.querySelector(${JSON.stringify(endHandleSelector)});
      if (!track || !startHandle || !endHandle || duration <= 0) return null;
      const trackRect = track.getBoundingClientRect();
      const startRect = startHandle.getBoundingClientRect();
      const endRect = endHandle.getBoundingClientRect();
      const width = Math.max(1, trackRect.width || 0);
      const startRatio = Math.max(0, Math.min(1, ((startRect.left + (startRect.width / 2)) - trackRect.left) / width));
      const endRatio = Math.max(0, Math.min(1, ((endRect.left + (endRect.width / 2)) - trackRect.left) / width));
      return {
        source: 'editor',
        duration,
        startRatio,
        endRatio,
        startTime: Number((duration * startRatio).toFixed(3)),
        endTime: Number((duration * endRatio).toFixed(3)),
      };
    })()
  `, 10000).catch(() => null);
  const waitForDraftUpdate = async (timeoutMs = 1800) => await waitFor(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
      const params = node?.data?.params || {};
      const startTime = Number(params.videoToolConfig?.startTime || 0);
      const endTime = Number(params.videoToolConfig?.endTime || 0);
      return String(params.videoTool || '') === 'clip'
        && String(params.videoToolOperation || '').includes('trim')
        && endTime > startTime + 0.05
        && startTime > 0.02
        ? {
            duration: Number(node?.data?.duration || params.duration || 0),
            startTime,
            endTime,
          }
        : null;
    })()
  `, timeoutMs, 100).catch(() => null);
  const readDraftState = async () => await evalJs(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
      const params = node?.data?.params || {};
      return {
        duration: Number(node?.data?.duration || params.duration || 0),
        startTime: Number(params.videoToolConfig?.startTime || 0),
        endTime: Number(params.videoToolConfig?.endTime || 0),
        config: params.videoToolConfig || {},
      };
    })()
  `, 10000);
  const dragClipHandleToRatio = async (handleSelector, targetRatio) => {
    const ok = await evalJs(cdp, `
      (async () => {
        const handle = document.querySelector(${JSON.stringify(handleSelector)});
        const track = document.querySelector(${JSON.stringify(trackSelector)});
        if (!handle || !track) return false;
        const handleRect = handle.getBoundingClientRect();
        const trackRect = track.getBoundingClientRect();
        const pointerId = 1;
        const startX = handleRect.left + (handleRect.width / 2);
        const startY = handleRect.top + (handleRect.height / 2);
        const targetX = trackRect.left + (trackRect.width * ${Number(targetRatio)});
        const targetY = handleRect.top + (handleRect.height / 2);
        const fire = (type, clientX, clientY) => {
          const event = new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            pointerId,
            pointerType: 'mouse',
            isPrimary: true,
            clientX,
            clientY,
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1,
          });
          handle.dispatchEvent(event);
        };
        fire('pointerdown', startX, startY);
        for (let step = 1; step <= 12; step += 1) {
          const progress = step / 12;
          fire('pointermove', startX + ((targetX - startX) * progress), startY + ((targetY - startY) * progress));
          await new Promise((resolve) => requestAnimationFrame(() => resolve()));
        }
        fire('pointerup', targetX, targetY);
        return true;
      })()
    `, 15000);
    if (!ok) {
      throw new Error(`Unable to drag clip handle: ${handleSelector}`);
    }
  };

  await clickSelectorAtRatio(cdp, trackSelector, { x: startRatio, y: 0.5 }).catch(() => null);
  await pressKey(cdp, 'I').catch(() => null);
  await sleep(120);
  await clickSelectorAtRatio(cdp, trackSelector, { x: endRatio, y: 0.5 }).catch(() => null);
  await pressKey(cdp, 'O').catch(() => null);
  await sleep(120);

  let updated = await waitForDraftUpdate();
  if (updated) {
    return { source: 'store', ...updated };
  }

  let editorDraftState = await readEditorDraftState();
  if (editorDraftState && editorDraftState.startTime > 0.02 && editorDraftState.endTime > editorDraftState.startTime + 0.05) {
    return editorDraftState;
  }

  await dragClipHandleToRatio(startHandleSelector, startRatio);
  await sleep(80);
  await dragClipHandleToRatio(endHandleSelector, endRatio);
  await sleep(120);
  updated = await waitForDraftUpdate(2500);
  if (updated) {
    return { source: 'store', ...updated };
  }

  editorDraftState = await readEditorDraftState();
  if (editorDraftState && editorDraftState.startTime > 0.02 && editorDraftState.endTime > editorDraftState.startTime + 0.05) {
    return editorDraftState;
  }

  const draftState = await readDraftState();
  const duration = Math.max(0.25, Number(draftState?.duration || 0));
  const startTime = Number((duration * startRatio).toFixed(3));
  const endTime = Number((duration * endRatio).toFixed(3));
  await patchVideoToolConfig(cdp, nodeId, 'clip', {
    tool: 'clip',
    startTime,
    endTime,
    clipPreviewStart: startTime,
    clipPreviewEnd: endTime,
    selectedSegmentIndex: 0,
    clipSegments: [{
      id: 'segment-1',
      startTime,
      endTime,
      label: '片段 1',
    }],
  });
  updated = await waitForDraftUpdate(2500);
  if (updated) {
    return { source: 'store', ...updated };
  }
  editorDraftState = await readEditorDraftState();
  if (editorDraftState && editorDraftState.startTime > 0.02 && editorDraftState.endTime > editorDraftState.startTime + 0.05) {
    return editorDraftState;
  }
  return null;
}

async function dragCanvasSelection(cdp, start, end, options = {}) {
  const steps = Math.max(2, Number(options.steps || 12));
  const modifiers = options.shift ? 8 : 0;
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Number(start.x),
    y: Number(start.y),
    button: 'left',
    buttons: 0,
    modifiers,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: Number(start.x),
    y: Number(start.y),
    button: 'left',
    clickCount: 1,
    buttons: 1,
    modifiers,
  });
  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps;
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Number(start.x + ((end.x - start.x) * progress)),
      y: Number(start.y + ((end.y - start.y) * progress)),
      button: 'left',
      buttons: 1,
      modifiers,
    });
    await sleep(16);
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: Number(end.x),
    y: Number(end.y),
    button: 'left',
    clickCount: 1,
    buttons: 0,
    modifiers,
  });
}

async function dispatchWheel(cdp, selector, deltaY) {
  const box = await selectorCenter(cdp, selector);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: box.x,
    y: box.y,
    deltaY,
    deltaX: 0,
    modifiers: 0,
  });
}

async function dispatchPointerStroke(cdp, selector, ratios) {
  const safeSelector = JSON.stringify(selector);
  const safeRatios = JSON.stringify(ratios);
  const ok = await evalJs(cdp, `
    (async () => {
      const element = document.querySelector(${safeSelector});
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const points = ${safeRatios}.map((point) => ({
        clientX: rect.left + rect.width * point.x,
        clientY: rect.top + rect.height * point.y,
      }));
      if (!points.length) return false;
      const fire = (type, point, buttons) => {
        const event = new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: point.clientX,
          clientY: point.clientY,
          button: 0,
          buttons,
        });
        element.dispatchEvent(event);
      };
      fire('mousedown', points[0], 1);
      await new Promise((resolve) => setTimeout(resolve, 40));
      for (const point of points.slice(1)) {
        fire('mousemove', point, 1);
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      fire('mouseup', points[points.length - 1], 0);
      return true;
    })()
  `);
  if (!ok) throw new Error(`Unable to dispatch pointer stroke for selector: ${selector}`);
}

async function pressEscape(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
}

async function pressKey(cdp, key, options = {}) {
  const keyMap = {
    ArrowLeft: { code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 },
    ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 },
    Enter: { code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
    Escape: { code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
    Space: { code: 'Space', key: ' ', text: ' ', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 },
    I: { code: 'KeyI', windowsVirtualKeyCode: 73, nativeVirtualKeyCode: 73 },
    O: { code: 'KeyO', windowsVirtualKeyCode: 79, nativeVirtualKeyCode: 79 },
  };
  const meta = keyMap[key] || { code: key, windowsVirtualKeyCode: 0, nativeVirtualKeyCode: 0 };
  await evalJs(cdp, `
    (() => {
      const target = document.activeElement || document.body || window;
      const common = {
        key: ${JSON.stringify(meta.key || key)},
        code: ${JSON.stringify(meta.code)},
        bubbles: true,
        cancelable: true,
        shiftKey: ${Boolean(options.shift)},
      };
      const down = new KeyboardEvent('keydown', common);
      const up = new KeyboardEvent('keyup', common);
      target.dispatchEvent(down);
      target.dispatchEvent(up);
      window.dispatchEvent(down);
      window.dispatchEvent(up);
      return true;
    })()
  `, 10000);
}

async function readViewport(cdp) {
  return evalJs(cdp, `
    (() => {
      const viewport = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.viewport;
      return viewport ? { x: Number(viewport.x || 0), y: Number(viewport.y || 0), zoom: Number(viewport.zoom || 1) } : null;
    })()
  `, 10000);
}

async function readCanvasState(cdp) {
  return evalJs(cdp, `
    (() => {
      const debug = window.__HMDAO_DEBUG__;
      const snapshot = typeof debug?.readCanvasSnapshot === 'function' ? debug.readCanvasSnapshot() : null;
      const store = debug?.canvasStore?.getState?.();
      return { snapshot, viewport: store?.canvas?.viewport || null, nodeCount: store?.canvas?.nodes?.length || 0 };
    })()
  `, 10000);
}

async function latestNodeIdByType(cdp, nodeType) {
  return evalJs(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const match = [...nodes].reverse().find((node) => node.type === ${JSON.stringify(nodeType)});
      return match ? match.id : '';
    })()
  `, 10000);
}

async function selectNodeById(cdp, nodeId) {
  const ok = await evalJs(cdp, `
    (() => {
      const canvasStore = window.__HMDAO_DEBUG__?.canvasStore;
      const store = canvasStore?.getState?.();
      if (!store || typeof store.setSelectedNodeIds !== 'function') return false;
      const nextSelection = [${JSON.stringify(nodeId)}];
      store.setSelectedNodeIds(nextSelection);
      if (typeof canvasStore?.setState === 'function') {
        canvasStore.setState((state) => {
          state.selectedNodeIds = nextSelection;
          if (state.floatingPanel && state.floatingPanel.nodeId !== ${JSON.stringify(nodeId)}) {
            state.floatingPanel = null;
          }
          state.selectionGuardUntil = Date.now() + 1200;
          if (state.canvas?.nodes) {
            for (const node of state.canvas.nodes) {
              node.selected = node.id === ${JSON.stringify(nodeId)};
            }
          }
        });
      }
      const debug = window.__HMDAO_DEBUG__;
      const setCenter = debug?.reactFlow?.setCenter;
      const node = Array.isArray(store?.canvas?.nodes)
        ? store.canvas.nodes.find((item) => item.id === ${JSON.stringify(nodeId)})
        : null;
      if (node && typeof setCenter === 'function') {
        setCenter(node.position.x + 260, node.position.y + 180, { zoom: 1, duration: 0 });
      }
      const domNode = document.querySelector(${JSON.stringify(`.react-flow__node[data-id="${nodeId}"]`)});
      if (domNode instanceof HTMLElement) {
        const pointerDown = typeof PointerEvent === 'function'
          ? new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, buttons: 1 })
          : null;
        if (pointerDown) domNode.dispatchEvent(pointerDown);
        domNode.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1 }));
        domNode.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
        domNode.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      }
      return true;
    })()
  `, 10000);
  if (!ok) throw new Error(`Unable to select node ${nodeId}`);
}

async function waitForNodeSelection(cdp, nodeId, timeoutMs = 30000) {
  await waitFor(cdp, `
    (() => {
      const debug = window.__HMDAO_DEBUG__;
      const snapshot = typeof debug?.readCanvasSnapshot === 'function' ? debug.readCanvasSnapshot() : null;
      const store = debug?.canvasStore?.getState?.();
      const selectedNodeIds = Array.isArray(store?.selectedNodeIds) ? store.selectedNodeIds : [];
      const nodes = Array.isArray(store?.canvas?.nodes) ? store.canvas.nodes : [];
      const domNode = document.querySelector(${JSON.stringify(`.react-flow__node[data-id="${nodeId}"]`)});
      return selectedNodeIds.includes(${JSON.stringify(nodeId)})
        || Boolean(snapshot?.selectedNodes?.some((node) => node.id === ${JSON.stringify(nodeId)}))
        || Boolean(nodes.find((node) => node.id === ${JSON.stringify(nodeId)} && node.selected))
        || Boolean(domNode?.classList?.contains('selected'));
    })()
  `, timeoutMs, 250);
}

async function waitForExclusiveNodeSelection(cdp, nodeId, timeoutMs = 30000) {
  await waitFor(cdp, `
    (() => {
      const debug = window.__HMDAO_DEBUG__;
      const snapshot = typeof debug?.readCanvasSnapshot === 'function' ? debug.readCanvasSnapshot() : null;
      const store = debug?.canvasStore?.getState?.();
      const selectedNodeIds = Array.isArray(store?.selectedNodeIds) ? store.selectedNodeIds : [];
      const snapshotSelectedNodeIds = Array.isArray(snapshot?.selectedNodes)
        ? snapshot.selectedNodes.map((node) => node?.id).filter(Boolean)
        : [];
      const nodes = Array.isArray(store?.canvas?.nodes) ? store.canvas.nodes : [];
      const domNode = document.querySelector(${JSON.stringify(`.react-flow__node[data-id="${nodeId}"]`)});
      const storeExclusive = selectedNodeIds.length === 1
        && selectedNodeIds[0] === ${JSON.stringify(nodeId)};
      const snapshotExclusive = snapshotSelectedNodeIds.length === 1
        && snapshotSelectedNodeIds[0] === ${JSON.stringify(nodeId)};
      const nodeSelected = Boolean(nodes.find((node) => node.id === ${JSON.stringify(nodeId)} && node.selected));
      const domSelected = Boolean(domNode?.classList?.contains('selected'));
      return storeExclusive
        || snapshotExclusive
        || (nodeSelected && domSelected && selectedNodeIds.length === 0 && snapshotSelectedNodeIds.length === 0);
    })()
  `, timeoutMs, 250);
}

async function readNodeSelectionState(cdp, nodeId) {
  return evalJs(cdp, `
    (() => {
      const debug = window.__HMDAO_DEBUG__;
      const snapshot = typeof debug?.readCanvasSnapshot === 'function' ? debug.readCanvasSnapshot() : null;
      const store = debug?.canvasStore?.getState?.();
      const selectedNodeIds = Array.isArray(store?.selectedNodeIds) ? store.selectedNodeIds : [];
      const snapshotSelectedNodeIds = Array.isArray(snapshot?.selectedNodes)
        ? snapshot.selectedNodes.map((item) => item?.id).filter(Boolean)
        : [];
      const nodes = Array.isArray(store?.canvas?.nodes) ? store.canvas.nodes : [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)}) || null;
      const domNode = document.querySelector(${JSON.stringify(`.react-flow__node[data-id="${nodeId}"]`)});
      const storeSelected = selectedNodeIds.includes(${JSON.stringify(nodeId)});
      const snapshotSelected = snapshotSelectedNodeIds.includes(${JSON.stringify(nodeId)});
      const nodeSelected = Boolean(node?.selected);
      const domSelected = Boolean(domNode?.classList?.contains('selected'));
      const exclusiveSelected = (
        (selectedNodeIds.length === 1 && selectedNodeIds[0] === ${JSON.stringify(nodeId)})
        || (snapshotSelectedNodeIds.length === 1 && snapshotSelectedNodeIds[0] === ${JSON.stringify(nodeId)})
        || (nodeSelected && domSelected && selectedNodeIds.length === 0 && snapshotSelectedNodeIds.length === 0)
      );
      const selected = storeSelected || snapshotSelected || nodeSelected || domSelected;
      return {
        selected,
        selectedNodeIds,
        snapshotSelectedNodeIds,
        hasDomNode: Boolean(domNode),
        domSelected,
        nodeSelected,
        storeSelected,
        snapshotSelected,
        exclusiveSelected,
      };
    })()
  `, 3000);
}

async function stabilizeExclusiveNodeSelection(cdp, nodeId, guardMs = 4000) {
  const ok = await evalJs(cdp, `
    (() => {
      const canvasStore = window.__HMDAO_DEBUG__?.canvasStore;
      const store = canvasStore?.getState?.();
      if (!store || typeof store.setSelectedNodeIds !== 'function') return false;
      const nextSelection = [${JSON.stringify(nodeId)}];
      store.setSelectedNodeIds(nextSelection);
      if (typeof canvasStore?.setState === 'function') {
        canvasStore.setState((state) => {
          state.selectedNodeIds = nextSelection;
          if (state.floatingPanel && state.floatingPanel.nodeId !== ${JSON.stringify(nodeId)}) {
            state.floatingPanel = null;
          }
          state.selectionGuardUntil = Date.now() + ${Number(guardMs)};
          if (state.canvas?.nodes) {
            for (const node of state.canvas.nodes) {
              node.selected = node.id === ${JSON.stringify(nodeId)};
            }
          }
        });
      }
      return true;
    })()
  `, 10000).catch(() => false);
  if (!ok) throw new Error(`Unable to stabilize selection for node ${nodeId}`);
}

async function readSelectedNode(cdp, nodeId) {
  return evalJs(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
      return node ? { id: node.id, type: node.type, data: node.data || {} } : null;
    })()
  `, 10000);
}

async function readToolConfig(cdp, nodeId) {
  return evalJs(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
      return node?.data?.params?.toolConfig || null;
    })()
  `, 10000);
}

async function setFileInputFiles(cdp, selector, files) {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  if (!nodeId) throw new Error(`Unable to find file input: ${selector}`);
  await cdp.send('DOM.setFileInputFiles', { nodeId, files });
}

async function assertPanelContains(cdp, panelSelector, expectedText) {
  const ok = await evalJs(cdp, `
    (() => {
      const panel = document.querySelector(${JSON.stringify(panelSelector)});
      return Boolean(panel && panel.textContent && panel.textContent.includes(${JSON.stringify(expectedText)}));
    })()
  `, 10000);
  assert(ok, `Expected panel text not found: ${expectedText}`);
}

async function openToolPanelAndWait(cdp, nodeId, tool, readySelector) {
  await clickSelector(cdp, `[data-testid="image-tool-chip-${nodeId}-${tool}"]`);
  await waitForSelector(cdp, `[data-testid="image-tool-panel-${tool}"]`);
  await waitForSelector(cdp, readySelector);
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
    await fs.writeFile(
      jsonPath,
      JSON.stringify(sanitizeArtifactPayload({ label, capturedAt: new Date().toISOString(), snapshot, ...extra }), null, 2),
      'utf8',
    );
    log(`Stage captured: ${label}`, { screenshot: pngPath, state: jsonPath });
  };
}

async function createSampleFiles(runDir) {
  const imagePath = path.join(runDir, 'verify-source.png');
  const hdriPath = path.join(runDir, 'verify-hdri.png');
  const videoPath = path.join(runDir, 'verify-source.mp4');
  const fixtureScript = [
    'Add-Type -AssemblyName System.Drawing;',
    'function New-HmdaoFixture {',
    '  param([string]$Path, [int]$Width, [int]$Height, [string]$Label, [string]$StartColor, [string]$EndColor, [single]$Angle)',
    '  $bitmap = New-Object System.Drawing.Bitmap $Width, $Height;',
    '  $graphics = [System.Drawing.Graphics]::FromImage($bitmap);',
    '  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias;',
    '  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit;',
    '  $rect = New-Object System.Drawing.Rectangle 0, 0, $Width, $Height;',
    '  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.ColorTranslator]::FromHtml($StartColor)), ([System.Drawing.ColorTranslator]::FromHtml($EndColor)), $Angle;',
    '  $graphics.FillRectangle($brush, $rect);',
    '  $overlay = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(70, 255, 255, 255));',
    '  $graphics.FillEllipse($overlay, [int]($Width * 0.1), [int]($Height * 0.12), [int]($Width * 0.18), [int]($Height * 0.28));',
    '  $graphics.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(48, 255, 255, 255))), [int]($Width * 0.5), [int]($Height * 0.18), [int]($Width * 0.24), [int]($Height * 0.22));',
    '  $fontSize = [Math]::Max(22, [Math]::Floor($Height / 12));',
    '  $font = New-Object System.Drawing.Font("Arial", [single]$fontSize, [System.Drawing.FontStyle]::Bold);',
    '  $graphics.DrawString($Label, $font, [System.Drawing.Brushes]::White, [single]($Width * 0.06), [single]($Height * 0.78));',
    '  $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png);',
    '  $font.Dispose();',
    '  $brush.Dispose();',
    '  $overlay.Dispose();',
    '  $graphics.Dispose();',
    '  $bitmap.Dispose();',
    '}',
    `New-HmdaoFixture -Path ${toPowerShellLiteral(imagePath)} -Width 960 -Height 640 -Label ${toPowerShellLiteral('HMDAO VERIFY')} -StartColor ${toPowerShellLiteral('#091833')} -EndColor ${toPowerShellLiteral('#f59e0b')} -Angle 35;`,
    `New-HmdaoFixture -Path ${toPowerShellLiteral(hdriPath)} -Width 1024 -Height 512 -Label ${toPowerShellLiteral('HDRI VERIFY')} -StartColor ${toPowerShellLiteral('#1d4ed8')} -EndColor ${toPowerShellLiteral('#f59e0b')} -Angle 0;`,
  ].join(' ');
  await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', fixtureScript], APP_DIR);
  if (!existsSync(videoPath)) {
    const sampleVideoUrl = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';
    try {
      const response = await fetch(sampleVideoUrl);
      if (!response.ok) {
        throw new Error(`Unable to download sample video fixture: ${response.status} ${sampleVideoUrl}`);
      }
      await fs.writeFile(videoPath, Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      const artifactsRoot = path.join(APP_DIR, 'server', 'artifacts');
      const artifactEntries = existsSync(artifactsRoot)
        ? await fs.readdir(artifactsRoot, { withFileTypes: true })
        : [];
      const reusableFixture = artifactEntries
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(artifactsRoot, entry.name, 'verify-source.mp4'))
        .find((candidate) => existsSync(candidate));
      if (!reusableFixture) {
        throw error;
      }
      await fs.copyFile(reusableFixture, videoPath);
    }
  }
  return { imagePath, hdriPath, videoPath };
}

async function verifyReusableWorkflowTemplates(cdp, recorder) {
  await navigateAndWait(cdp, appUrl, 'location.pathname === "/" && !!document.body');
  await waitForSelector(cdp, '[data-testid="add-node-image"]', 60000);
  const workflowState = await evalJs(cdp, `
    (() => {
      const workflows = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().workflows || [];
      const pick = (id) => workflows.find((workflow) => workflow.id === id) || null;
      const summarize = (workflow) => workflow ? ({
        id: workflow.id,
        name: workflow.name,
        description: workflow.description,
        nodeTypes: (workflow.nodes || []).map((node) => node.type),
        nodeLabels: (workflow.nodes || []).map((node) => node.data?.label || ''),
        edgeCount: (workflow.edges || []).length,
        templates: (workflow.nodes || []).map((node) => node.data?.params?.workflowTemplate || '').filter(Boolean),
        engines: (workflow.nodes || []).map((node) => node.data?.params?.engine || node.data?.model || '').filter(Boolean),
        qualities: (workflow.nodes || []).map((node) => node.data?.quality || node.data?.params?.quality || '').filter(Boolean),
      }) : null;
      return {
        count: workflows.length,
        blender: summarize(pick('wf-dcc-blender-image-poster')),
        unreal: summarize(pick('wf-dcc-unreal-video-replace')),
      };
    })()
  `, 10000);
  const issues = [];
  if (!workflowState.blender) issues.push('missing-blender-template');
  if (!workflowState.unreal) issues.push('missing-unreal-template');
  if (workflowState.blender) {
    assert(workflowState.blender.nodeTypes.includes('dcc') && workflowState.blender.nodeTypes.includes('image'), 'Blender workflow must connect DCC capture to an image node.', workflowState.blender);
    assert(workflowState.blender.templates.includes('dcc-blender-image-poster'), 'Blender image node missing workflowTemplate marker.', workflowState.blender);
    assert(workflowState.blender.engines.includes('blender'), 'Blender workflow DCC node is not configured for Blender.', workflowState.blender);
  }
  if (workflowState.unreal) {
    assert(workflowState.unreal.nodeTypes.includes('dcc') && workflowState.unreal.nodeTypes.includes('video'), 'Unreal workflow must connect DCC capture to a video node.', workflowState.unreal);
    assert(workflowState.unreal.templates.includes('dcc-unreal-video-replace'), 'Unreal video node missing workflowTemplate marker.', workflowState.unreal);
    assert(workflowState.unreal.engines.includes('unreal'), 'Unreal workflow DCC node is not configured for Unreal.', workflowState.unreal);
    assert(workflowState.unreal.qualities.includes('480p'), 'Unreal workflow video node is not configured for 480p output.', workflowState.unreal);
  }
  const result = {
    ...workflowState,
    templateStatus: issues.length ? 'missing' : 'verified',
    templateIssues: issues,
  };
  await recorder(issues.length ? 'reusable-workflow-templates-missing' : 'reusable-workflow-templates-verified', result);
  return result;
}

async function selectAndSubmitProviderKey(cdp, {
  provider = 'siliconflow',
  mode,
  upstreamModel,
  apiKey = realApiKey,
  endpoint = '',
}) {
  await openApiKeysRoute(cdp);
  await waitFor(cdp, `
    (() => {
      const provider = document.querySelector('[data-testid="api-key-provider"]');
      const text = document.body.textContent || '';
      return Boolean(provider) || text.includes('\u52a0\u8f7d') || text.includes('\u767b\u5f55') || text.includes('\u9519\u8bef');
    })()
  `, 60000);
  const apiKeysPageState = await evalJs(cdp, `
    (() => ({
      path: location.pathname,
      title: document.title,
      text: (document.body.textContent || '').slice(0, 500),
      hasProvider: Boolean(document.querySelector('[data-testid="api-key-provider"]')),
      hasMode: Boolean(document.querySelector('[data-testid="api-key-mode"]')),
      authState: window.__HMDAO_DEBUG__?.apiKeyStore ? null : 'debug-missing',
    }))()
  `, 10000);
  if (!apiKeysPageState?.hasProvider) {
    throw new Error(`API key page did not render provider selector: ${JSON.stringify(apiKeysPageState)}`);
  }
  await waitFor(cdp, `
    (() => {
      const provider = document.querySelector('[data-testid="api-key-provider"]');
      return Boolean(provider && [...provider.options].some((option) => option.value === ${JSON.stringify(provider)}));
    })()
  `, 30000);
  await setValue(cdp, '[data-testid="api-key-provider"]', provider);
  await waitFor(cdp, `document.querySelector('[data-testid="api-key-provider"]')?.value === ${JSON.stringify(provider)}`, 10000);
  await waitFor(cdp, `
    (() => {
      const mode = document.querySelector('[data-testid="api-key-mode"]');
      return Boolean(mode && [...mode.options].some((option) => option.value === ${JSON.stringify(mode)}));
    })()
  `, 15000);
  await setValue(cdp, '[data-testid="api-key-mode"]', mode);
  await waitFor(cdp, `document.querySelector('[data-testid="api-key-mode"]')?.value === ${JSON.stringify(mode)}`, 10000);
  await setValue(cdp, '[data-testid="api-key-input"]', apiKey);
  await setValue(cdp, '[data-testid="api-key-model"]', upstreamModel);
  const endpointSelectorExists = await evalJs(cdp, `Boolean(document.querySelector('[data-testid="api-key-endpoint"]'))`, 10000);
  if (endpoint && !endpointSelectorExists) {
    const clicked = await evalJs(cdp, `
      (() => {
        const buttons = [...document.querySelectorAll('button')];
        const target = buttons.find((button) => {
          const text = String(button.textContent || '');
          return text.includes('兼容中转站') || text.includes('Relay') || text.includes('OpenAI');
        });
        if (!target) return false;
        target.click();
        return true;
      })()
    `, 10000);
    assert(clicked, 'Relay toggle button was not available on API key page.');
    await waitForSelector(cdp, '[data-testid="api-key-endpoint"]', 10000);
  }
  if (endpoint) {
    await setValue(cdp, '[data-testid="api-key-endpoint"]', endpoint);
  }
  await waitFor(cdp, `(() => {
    const button = document.querySelector('[data-testid="api-key-submit"]');
    return Boolean(button && !button.disabled);
  })()`, 30000);
  await clickSelector(cdp, '[data-testid="api-key-submit"]');
}

async function clickByText(cdp, textFragment) {
  const ok = await evalJs(cdp, `
    (() => {
      const needle = ${JSON.stringify(textFragment)};
      const buttons = [...document.querySelectorAll('button, a')];
      const match = buttons.find((item) => String(item.textContent || '').includes(needle));
      if (!match) return false;
      match.click();
      return true;
    })()
  `, 10000);
  assert(ok, `Unable to click by text: ${textFragment}`);
}

async function waitForProviderActivation(cdp, { provider = 'siliconflow', mode, endpoint = '' }) {
  const modeJson = JSON.stringify(mode);
  const providerJson = JSON.stringify(provider);
  const endpointJson = JSON.stringify(endpoint);
  await waitFor(cdp, `
    (() => {
      const pageText = document.body.textContent || '';
      const runtimeEntries = Object.values(window.__HMDAO_DEBUG__?.apiKeyStore?.getState?.()?.keys || {});
      const storedRaw = localStorage.getItem('hmdao-api-keys') || '';
      let stored = null;
      try { stored = storedRaw ? JSON.parse(storedRaw) : null; } catch {}
      const persistedEntries = Object.values(stored?.state?.keys || {});
      const isActive = (state) => Boolean(
        state && state.mode === ${modeJson} && state.provider === ${providerJson} && state.status !== 'expired'
      );
      const endpointMatched = (state) => !${endpointJson} || String(state?.endpoint || '') === ${endpointJson};
      const keyCard = document.querySelector('[data-testid="api-key-card-' + ${providerJson} + '-' + ${modeJson} + '"]');
      const successMessage = pageText.includes('\u8fdc\u7a0b\u6821\u9a8c\u6210\u529f')
        || pageText.includes('\u5df2\u5b8c\u6210\u8fdc\u7a0b\u6821\u9a8c\u5e76\u6fc0\u6d3b')
        || pageText.includes('\u5df2\u6fc0\u6d3b')
        || pageText.includes('Activated')
        || pageText.includes('is activated.');
      const failureMessage = pageText.includes('API Key \u9a8c\u8bc1\u5931\u8d25')
        || pageText.includes('\u9a8c\u8bc1\u5931\u8d25')
        || pageText.includes('\u6821\u9a8c\u5931\u8d25')
        || pageText.includes('API key validation failed')
        || (pageText.includes('API Key') && (pageText.includes('failed') || pageText.includes('Failed')));
      return successMessage || failureMessage || Boolean(keyCard) || runtimeEntries.some((state) => isActive(state) && endpointMatched(state)) || persistedEntries.some((state) => isActive(state) && endpointMatched(state));
    })()
  `, 60000);

  const activationState = await evalJs(cdp, `
    (() => {
      const pageText = document.body.textContent || '';
      const runtimeEntries = Object.values(window.__HMDAO_DEBUG__?.apiKeyStore?.getState?.()?.keys || {});
      const storedRaw = localStorage.getItem('hmdao-api-keys') || '';
      let stored = null;
      try { stored = storedRaw ? JSON.parse(storedRaw) : null; } catch {}
      const persistedEntries = Object.values(stored?.state?.keys || {});
      const isActive = (state) => Boolean(
        state && state.mode === ${modeJson} && state.provider === ${providerJson} && state.status !== 'expired'
      );
      const endpointMatched = (state) => !${endpointJson} || String(state?.endpoint || '') === ${endpointJson};
      const successMessage = pageText.includes('\u8fdc\u7a0b\u6821\u9a8c\u6210\u529f')
        || pageText.includes('\u5df2\u5b8c\u6210\u8fdc\u7a0b\u6821\u9a8c\u5e76\u6fc0\u6d3b')
        || pageText.includes('\u5df2\u6fc0\u6d3b')
        || pageText.includes('Activated')
        || pageText.includes('is activated.');
      const failureMessage = pageText.includes('API Key \u9a8c\u8bc1\u5931\u8d25')
        || pageText.includes('\u9a8c\u8bc1\u5931\u8d25')
        || pageText.includes('\u6821\u9a8c\u5931\u8d25')
        || pageText.includes('API key validation failed')
        || (pageText.includes('API Key') && (pageText.includes('failed') || pageText.includes('Failed')));
      return {
        successMessage,
        failureMessage,
        runtimeState: runtimeEntries.find((state) => isActive(state) && endpointMatched(state)) || null,
        persistedState: persistedEntries.find((state) => isActive(state) && endpointMatched(state)) || null,
        keyCard: Boolean(document.querySelector('[data-testid="api-key-card-' + ${providerJson} + '-' + ${modeJson} + '"]')),
        pageText: pageText.slice(0, 600),
      };
    })()
  `, 10000);

  const activated = Boolean(
    activationState?.successMessage
    || activationState?.keyCard
    || activationState?.runtimeState
    || activationState?.persistedState
  );
  if (!activated || activationState?.failureMessage) {
    throw new Error(`${mode} API key activation did not complete successfully: ${JSON.stringify(activationState)}`);
  }
  return activationState;
}

async function activateSiliconflowKey(cdp, recorder) {
  await activateSiliconflowImageKey(cdp, recorder);
}

async function activateSiliconflowVideoKey(cdp, recorder) {
  await selectAndSubmitProviderKey(cdp, { provider: 'siliconflow', mode: 'video', upstreamModel: 'Wan-AI/Wan2.2-I2V-A14B' });
  const activationState = await waitForProviderActivation(cdp, { provider: 'siliconflow', mode: 'video' });
  await recorder('api-key-activated-video', { provider: 'siliconflow', mode: 'video', activationState });
}

async function activateSiliconflowImageKey(cdp, recorder) {
  await selectAndSubmitProviderKey(cdp, { provider: 'siliconflow', mode: 'image', upstreamModel: 'Qwen/Qwen-Image' });
  const activationState = await waitForProviderActivation(cdp, { provider: 'siliconflow', mode: 'image' });
  await recorder('api-key-activated-image', { provider: 'siliconflow', mode: 'image', activationState });
}
async function activateSiliconflowKeys(cdp, recorder) {
  await activateSiliconflowImageKey(cdp, recorder);
  if (!imageOnly) {
    await activateSiliconflowVideoKey(cdp, recorder);
  }
}

async function verifyRelayActivationRoundTrip(cdp, recorder) {
  assert(relayBaseUrl, 'Relay activation verification requires HMDAO_RELAY_BASE_URL or HMDAO_VERIFY_RELAY_BASE_URL.');
  assert(relayApiKey, 'Relay activation verification requires HMDAO_RELAY_API_KEY or HMDAO_REAL_API_KEY.');

  await selectAndSubmitProviderKey(cdp, {
    provider: relayProvider,
    mode: 'image',
    upstreamModel: relayImageModel,
    apiKey: relayApiKey,
    endpoint: relayBaseUrl,
  });
  const imageActivationState = await waitForProviderActivation(cdp, {
    provider: relayProvider,
    mode: 'image',
    endpoint: relayBaseUrl,
  });
  await recorder('relay-api-key-activated-image', { provider: relayProvider, mode: 'image', endpoint: relayBaseUrl, imageActivationState });

  let videoActivationState = null;
  if (!imageOnly) {
    await selectAndSubmitProviderKey(cdp, {
      provider: relayProvider,
      mode: 'video',
      upstreamModel: relayVideoModel,
      apiKey: relayApiKey,
      endpoint: relayBaseUrl,
    });
    videoActivationState = await waitForProviderActivation(cdp, {
      provider: relayProvider,
      mode: 'video',
      endpoint: relayBaseUrl,
    });
    await recorder('relay-api-key-activated-video', { provider: relayProvider, mode: 'video', endpoint: relayBaseUrl, videoActivationState });
  }

  const endpointState = await evalJs(cdp, `
    (() => {
      const runtimeEntries = Object.values(window.__HMDAO_DEBUG__?.apiKeyStore?.getState?.()?.keys || {});
      const storedRaw = localStorage.getItem('hmdao-api-keys') || '';
      let stored = null;
      try { stored = storedRaw ? JSON.parse(storedRaw) : null; } catch {}
      const persistedEntries = Object.values(stored?.state?.keys || {});
      const summarize = (state) => state ? ({
        provider: state.provider,
        mode: state.mode,
        endpoint: String(state.endpoint || ''),
        model: String(state.model || ''),
        maskedKey: String(state.maskedKey || ''),
      }) : null;
      return {
        runtimeImage: summarize(runtimeEntries.find((item) => item?.provider === ${JSON.stringify(relayProvider)} && item?.mode === 'image')),
        runtimeVideo: summarize(runtimeEntries.find((item) => item?.provider === ${JSON.stringify(relayProvider)} && item?.mode === 'video')),
        persistedImage: summarize(persistedEntries.find((item) => item?.provider === ${JSON.stringify(relayProvider)} && item?.mode === 'image')),
        persistedVideo: summarize(persistedEntries.find((item) => item?.provider === ${JSON.stringify(relayProvider)} && item?.mode === 'video')),
      };
    })()
  `, 10000);
  assert(String(endpointState?.runtimeImage?.endpoint || '') === relayBaseUrl, 'Relay image endpoint was not saved to runtime key state.', endpointState);
  assert(String(endpointState?.persistedImage?.endpoint || '') === relayBaseUrl, 'Relay image endpoint was not saved to persisted key state.', endpointState);
  if (!imageOnly) {
    assert(String(endpointState?.runtimeVideo?.endpoint || '') === relayBaseUrl, 'Relay video endpoint was not saved to runtime key state.', endpointState);
    assert(String(endpointState?.persistedVideo?.endpoint || '') === relayBaseUrl, 'Relay video endpoint was not saved to persisted key state.', endpointState);
  }

  await navigateAndWait(cdp, appUrl, 'location.pathname === "/" && !!document.querySelector(".react-flow") && !!window.__HMDAO_DEBUG__');
  const imageNodeId = await addImageNode(cdp, recorder);
  const imageOptionSelector = `[data-testid="image-model-option-${imageNodeId}-lib-image"]`;
  await clickSelector(cdp, `[data-testid="image-model-toggle-${imageNodeId}"]`);
  await waitForSelector(cdp, imageOptionSelector, 15000);
  const imageMenuState = await evalJs(cdp, `
    (() => {
      const option = document.querySelector(${JSON.stringify(imageOptionSelector)});
      const toggle = document.querySelector(${JSON.stringify(`[data-testid="image-model-toggle-${imageNodeId}"]`)});
      return {
        optionText: option ? String(option.textContent || '') : '',
        toggleText: toggle ? String(toggle.textContent || '') : '',
      };
    })()
  `, 10000);
  assert(
    imageMenuState.optionText.includes('已验证此模型') || imageMenuState.optionText.includes('平台已激活'),
    'Image model menu did not show an activated badge after relay activation.',
    imageMenuState,
  );
  await recorder('relay-image-model-menu-verified', { imageNodeId, imageMenuState, endpointState });

  let videoMenuState = null;
  let videoNodeId = null;
  if (!imageOnly) {
    videoNodeId = await addVideoNode(cdp, recorder);
    const preferredIds = ['wan22-i2v-a14b', 'wan22-t2v-a14b'];
    await clickSelector(cdp, `[data-testid="video-model-toggle-${videoNodeId}"]`);
    await waitFor(cdp, `
      (() => ${JSON.stringify(preferredIds)}.some((modelId) => Boolean(document.querySelector('[data-testid="video-model-option-${videoNodeId}-' + modelId + '"]'))))()
    `, 15000, 100);
    videoMenuState = await evalJs(cdp, `
      (() => {
        const ids = ${JSON.stringify(preferredIds)};
        return ids.map((modelId) => {
          const option = document.querySelector('[data-testid="video-model-option-${videoNodeId}-' + modelId + '"]');
          return {
            modelId,
            text: option ? String(option.textContent || '') : '',
            exists: Boolean(option),
          };
        });
      })()
    `, 10000);
    assert(
      videoMenuState.some((item) => item.exists && (item.text.includes('已验证此模型') || item.text.includes('平台已激活'))),
      'Video model menu did not show an activated badge after relay activation.',
      videoMenuState,
    );
    await recorder('relay-video-model-menu-verified', { videoNodeId, videoMenuState, endpointState });
  }

  return {
    provider: relayProvider,
    endpoint: relayBaseUrl,
    imageActivationState,
    videoActivationState,
    endpointState,
    imageNodeId,
    videoNodeId,
    imageMenuState,
    videoMenuState,
  };
}

async function ensureAssetLibraryCustomApiRuntime(recorder, runDir, children) {
  const fakePort = await reservePort(Number(process.env.HMDAO_FAKE_IMAGE_ANALYSIS_PORT || 0));
  const fakeBaseUrl = `http://127.0.0.1:${fakePort}/v1`;
  const previousRuntime = await (async () => {
    try {
      const response = await fetch(`${apiUrl}/api/byok/runtime`);
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  })();
  const previousRecord = Array.isArray(previousRuntime?.activatedProviders)
    ? previousRuntime.activatedProviders.find((item) => (
      item?.provider === assetLibraryFakeCustomApiProvider
      && item?.mode === assetLibraryFakeCustomApiMode
    )) || null
    : null;
  const fakeRuntimeEntry = path.join(runDir, 'fake-image-analysis-openai.mjs');
  const fakeRuntimeScript = `
import http from 'node:http';
const port = Number(process.argv[2] || 8796);
const model = String(process.argv[3] || 'fake-vision-1');
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1:' + port);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: model, object: 'model' }] }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    const payload = {
      engine: 'custom-api:' + model,
      summary: '云端视觉反推已生效，主体是一辆汽车海报，风格偏商业广告。',
      subject: '汽车主体海报',
      scene: '城市道路与霓虹背景',
      style: '商业广告海报风格',
      lighting: '高对比轮廓光与霓虹反射',
      composition: '横版居中构图，主体突出',
      camera: '低机位广角镜头',
      mood: '速度感、未来感、科技感',
      keywords: ['汽车', '商业海报', '霓虹光影'],
      promptZh: '保持汽车主体和横版海报构图不变，强化商业广告质感、霓虹光影、速度感与金属细节，适合高完成度中文海报生成。',
      promptEn: 'Keep the car subject and wide poster composition unchanged, enhance commercial ad quality, neon lighting, speed feeling, and metallic detail for a polished poster generation prompt.',
      palette: ['蓝紫', '橙红']
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-fake-image-analysis',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(payload) }, finish_reason: 'stop' }]
    }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not-found' }, path: url.pathname }));
});
server.listen(port, '127.0.0.1', () => {
  console.log('fake-image-analysis-runtime-ready:' + port);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
`;
  await fs.writeFile(fakeRuntimeEntry, fakeRuntimeScript, 'utf8');

  if (!(await isHttpReady(`${fakeBaseUrl}/models`))) {
    start('node', [fakeRuntimeEntry, String(fakePort), assetLibraryFakeCustomApiModel], 'asset-library-fake-custom-api', APP_DIR, children);
    await waitForHttp(`${fakeBaseUrl}/models`, 15000);
  }

  const activationResponse = await fetch(`${apiUrl}/api/byok/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: assetLibraryFakeCustomApiProvider,
      mode: assetLibraryFakeCustomApiMode,
      upstreamModel: assetLibraryFakeCustomApiModel,
      apiKey: assetLibraryFakeCustomApiKey,
      endpoint: fakeBaseUrl,
    }),
  });
  const activationState = await activationResponse.json().catch(() => ({}));
  assert(activationResponse.ok && activationState?.success, 'Failed to activate fake custom-api runtime for asset-library regression.', activationState);

  const runtimeStarted = Date.now();
  let runtimeState = null;
  while (!runtimeState && Date.now() - runtimeStarted < 15000) {
    try {
      const response = await fetch(`${apiUrl}/api/byok/runtime`);
      if (response.ok) {
        const payload = await response.json();
        const selected = payload?.selectedImageAnalysisRemote;
        if (
          selected?.provider === assetLibraryFakeCustomApiProvider
          && selected?.model === assetLibraryFakeCustomApiModel
          && String(selected?.endpoint || '') === fakeBaseUrl
        ) {
          runtimeState = payload;
          break;
        }
      }
    } catch {
      // ignore transient startup/read errors
    }
    await sleep(150);
  }
  assert(runtimeState, 'Fake custom-api runtime did not become the selected image-analysis remote.', {
    provider: assetLibraryFakeCustomApiProvider,
    model: assetLibraryFakeCustomApiModel,
    endpoint: fakeBaseUrl,
  });

  const restore = async () => {
    if (previousRecord?.apiKey) {
      await fetch(`${apiUrl}/api/byok/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: assetLibraryFakeCustomApiProvider,
          mode: assetLibraryFakeCustomApiMode,
          upstreamModel: String(previousRecord.model || ''),
          model: String(previousRecord.model || ''),
          apiKey: String(previousRecord.apiKey || ''),
          endpoint: String(previousRecord.endpoint || ''),
        }),
      }).catch(() => {});
      return;
    }
    await fetch(`${apiUrl}/api/byok/deactivate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: assetLibraryFakeCustomApiProvider,
        mode: assetLibraryFakeCustomApiMode,
      }),
    }).catch(() => {});
  };

  const state = {
    provider: assetLibraryFakeCustomApiProvider,
    mode: assetLibraryFakeCustomApiMode,
    model: assetLibraryFakeCustomApiModel,
    endpoint: fakeBaseUrl,
    activationState,
    runtimeState,
    previousRecord: previousRecord ? {
      provider: String(previousRecord.provider || ''),
      mode: String(previousRecord.mode || ''),
      model: String(previousRecord.model || ''),
      endpoint: String(previousRecord.endpoint || ''),
      maskedKey: String(previousRecord.maskedKey || ''),
    } : null,
    cleanup: restore,
  };
  await recorder('asset-library-custom-api-runtime-ready', state);
  return state;
}

async function addImageNode(cdp, recorder) {
  await ensureCanvasReady(cdp, { expectedMinVideoNodes: 0 });
  const before = await readCanvasState(cdp);
  const nodeId = await evalJs(cdp, `
    (() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      if (!store || typeof store.addNode !== 'function') return '';
      return store.addNode('image', { x: 420, y: 220 }) || '';
    })()
  `, 10000);
  assert(nodeId, 'Failed to create an image node via canvas store.');
  const expectedCount = Number(before.nodeCount || 0) + 1;
  await waitFor(cdp, `
    Number(window.__HMDAO_DEBUG__?.readCanvasSnapshot?.()?.nodeCount ?? 0) >= ${expectedCount}
  `, 30000);
  const persistedStorage = await evalJs(cdp, 'localStorage.getItem("hmdao-canvas-store") || ""');
  assert(persistedStorage.includes(nodeId), 'Canvas store did not persist the new node.', {
    expectedCount,
    storageLength: persistedStorage.length,
  });
  await selectNodeById(cdp, nodeId);
  await waitForNodeSelection(cdp, nodeId);
  await evalJs(cdp, `
    (() => {
      const debug = window.__HMDAO_DEBUG__;
      const store = debug?.canvasStore?.getState?.();
      const node = Array.isArray(store?.canvas?.nodes)
        ? store.canvas.nodes.find((item) => item.id === ${JSON.stringify(nodeId)})
        : null;
      const setCenter = debug?.reactFlow?.setCenter;
      if (!node || typeof setCenter !== 'function') return false;
      setCenter(node.position.x + 260, node.position.y + 180, { zoom: 1, duration: 0 });
      return true;
    })()
  `, 10000).catch(() => false);
  await waitFor(cdp, `
    (() => {
      const domNode = document.querySelector(${JSON.stringify('[data-testid="image-node-' + nodeId + '"]')});
      if (domNode) return true;
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      return nodes.some((item) => item.id === ${JSON.stringify(nodeId)});
    })()
  `, 30000);
  await recorder('image-node-added', { nodeId, beforeNodeCount: before.nodeCount, expectedCount });
  return nodeId;
}

async function addVideoNode(cdp, recorder) {
  await ensureCanvasReady(cdp, { expectedMinVideoNodes: 0 });
  const before = await readCanvasState(cdp);
  const nodeId = await evalJs(cdp, `
    (() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      if (!store || typeof store.addNode !== 'function') return '';
      return store.addNode('video', { x: 820, y: 260 }) || '';
    })()
  `, 10000);
  assert(nodeId, 'Failed to create a video node via canvas store.');
  const expectedCount = Number(before.nodeCount || 0) + 1;
  await waitFor(cdp, `
    Number(window.__HMDAO_DEBUG__?.readCanvasSnapshot?.()?.nodeCount ?? 0) >= ${expectedCount}
  `, 30000);
  const persistedStorage = await evalJs(cdp, 'localStorage.getItem("hmdao-canvas-store") || ""');
  assert(persistedStorage.includes(nodeId), 'Canvas store did not persist the new video node.', {
    expectedCount,
    storageLength: persistedStorage.length,
  });
  await selectNodeById(cdp, nodeId);
  await waitForNodeSelection(cdp, nodeId);
  await evalJs(cdp, `
    (() => {
      const debug = window.__HMDAO_DEBUG__;
      const store = debug?.canvasStore?.getState?.();
      const node = Array.isArray(store?.canvas?.nodes)
        ? store.canvas.nodes.find((item) => item.id === ${JSON.stringify(nodeId)})
        : null;
      const setCenter = debug?.reactFlow?.setCenter;
      if (!node || typeof setCenter !== 'function') return false;
      setCenter(node.position.x + 260, node.position.y + 180, { zoom: 1, duration: 0 });
      return true;
    })()
  `, 10000).catch(() => false);
  await waitFor(cdp, `
    (() => {
      const root = document.querySelector(${JSON.stringify('[data-testid="video-node-' + nodeId + '"]')});
      const fileInput = root?.querySelector('input[type="file"]');
      const mainHandle = document.querySelector(${JSON.stringify('[data-testid="video-handle-main-' + nodeId + '"]')});
      const promptInput = document.querySelector(${JSON.stringify('[data-testid="video-prompt-' + nodeId + '"]')});
      return Boolean(root && (fileInput || mainHandle || promptInput));
    })()
  `, 45000);
  await recorder('video-node-added', { nodeId, beforeNodeCount: before.nodeCount, expectedCount });
  return nodeId;
}

async function addAudioNode(cdp, recorder) {
  await ensureCanvasReady(cdp, { expectedMinVideoNodes: 0 });
  const before = await readCanvasState(cdp);
  const nodeId = await evalJs(cdp, `
    (() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      if (!store || typeof store.addNode !== 'function') return '';
      return store.addNode('audio', { x: 1180, y: 260 }) || '';
    })()
  `, 10000);
  assert(nodeId, 'Failed to create an audio node via canvas store.');
  const expectedCount = Number(before.nodeCount || 0) + 1;
  await waitFor(cdp, `
    Number(window.__HMDAO_DEBUG__?.readCanvasSnapshot?.()?.nodeCount ?? 0) >= ${expectedCount}
  `, 30000);
  const persistedStorage = await evalJs(cdp, 'localStorage.getItem("hmdao-canvas-store") || ""');
  assert(persistedStorage.includes(nodeId), 'Canvas store did not persist the new audio node.', {
    expectedCount,
    storageLength: persistedStorage.length,
  });
  await selectNodeById(cdp, nodeId);
  await waitForNodeSelection(cdp, nodeId);
  await evalJs(cdp, `
    (() => {
      const debug = window.__HMDAO_DEBUG__;
      const store = debug?.canvasStore?.getState?.();
      const node = Array.isArray(store?.canvas?.nodes)
        ? store.canvas.nodes.find((item) => item.id === ${JSON.stringify(nodeId)})
        : null;
      const setCenter = debug?.reactFlow?.setCenter;
      if (!node || typeof setCenter !== 'function') return false;
      setCenter(node.position.x + 260, node.position.y + 180, { zoom: 1, duration: 0 });
      return true;
    })()
  `, 10000).catch(() => false);
  await waitFor(cdp, `
    (() => {
      const root = document.querySelector(${JSON.stringify(`[data-testid="audio-node-${nodeId}"]`)});
      const wrapper = document.querySelector(${JSON.stringify(`[data-id="${nodeId}"]`)});
      return Boolean(root || wrapper);
    })()
  `, 45000);
  const hasAudioRoot = await evalJs(cdp, `
    Boolean(document.querySelector(${JSON.stringify(`[data-testid="audio-node-${nodeId}"]`)}))
  `, 5000).catch(() => false);
  if (!hasAudioRoot) {
    await selectNodeById(cdp, nodeId);
    await waitForNodeSelection(cdp, nodeId);
    await evalJs(cdp, `
      (() => {
        const debug = window.__HMDAO_DEBUG__;
        const store = debug?.canvasStore?.getState?.();
        const node = Array.isArray(store?.canvas?.nodes)
          ? store.canvas.nodes.find((item) => item.id === ${JSON.stringify(nodeId)})
          : null;
        const setCenter = debug?.reactFlow?.setCenter;
        if (!node || typeof setCenter !== 'function') return false;
        setCenter(node.position.x + 260, node.position.y + 180, { zoom: 1, duration: 0 });
        return true;
      })()
    `, 10000).catch(() => false);
    await waitForSelector(cdp, `[data-testid="audio-node-${nodeId}"]`, 20000);
  }
  const initialState = await evalJs(cdp, `
    (() => {
      const node = document.querySelector(${JSON.stringify(`[data-testid="audio-node-${nodeId}"]`)});
      const panel = document.querySelector(${JSON.stringify(`[data-testid="audio-panel-${nodeId}"]`)});
      const selectedIds = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().selectedNodeIds || [];
      return {
        hasNode: Boolean(node),
        hasPanel: Boolean(panel),
        selectedIds,
        text: String(node?.textContent || ''),
      };
    })()
  `, 5000);
  await recorder('audio-node-added', { nodeId, beforeNodeCount: before.nodeCount, expectedCount, initialState });
  return nodeId;
}

async function addUtilityTextNode(cdp, recorder, position = { x: 820, y: 260 }) {
  await ensureCanvasReady(cdp, { expectedMinVideoNodes: 0 });
  const before = await readCanvasState(cdp);
  const nodeId = await evalJs(cdp, `
    (() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      if (!store || typeof store.addNode !== 'function' || typeof store.updateNodeData !== 'function') return '';
      const id = store.addNode('text', ${JSON.stringify(position)}) || '';
      if (!id) return '';
      store.updateNodeData(id, {
        label: '辅助节点',
        content: 'Audio panel verify helper',
        status: 'idle',
      });
      return id;
    })()
  `, 10000);
  assert(nodeId, 'Failed to create a helper text node via canvas store.');
  const expectedCount = Number(before.nodeCount || 0) + 1;
  await waitFor(cdp, `
    Number(window.__HMDAO_DEBUG__?.readCanvasSnapshot?.()?.nodeCount ?? 0) >= ${expectedCount}
  `, 30000);
  await recorder('audio-helper-node-added', { nodeId, beforeNodeCount: before.nodeCount, expectedCount });
  return nodeId;
}

async function seedVideoNodeWithSample(cdp, recorder, nodeId, videoPath) {
  const fileInputSelector = `[data-testid="video-node-${nodeId}"] input[type="file"]`;
  const hasFileInput = await evalJs(cdp, `
    Boolean(document.querySelector(${JSON.stringify(fileInputSelector)}))
  `, 5000).catch(() => false);
  if (hasFileInput) {
    await setFileInputFiles(cdp, fileInputSelector, [videoPath]);
  } else {
    const videoBase64 = (await fs.readFile(videoPath)).toString('base64');
    const fallbackSeedState = await evalJs(cdp, `
      (async () => {
        const debug = window.__HMDAO_DEBUG__ || {};
        const store = debug.canvasStore?.getState?.();
        const updateNodeData = store?.updateNodeData;
        const registerLocalMedia = debug.registerLocalMedia;
        if (typeof updateNodeData !== 'function' || typeof registerLocalMedia !== 'function') {
          return { ok: false, reason: 'debug-bridge-missing' };
        }
        const raw = atob(${JSON.stringify(videoBase64)});
        const bytes = new Uint8Array(raw.length);
        for (let index = 0; index < raw.length; index += 1) {
          bytes[index] = raw.charCodeAt(index);
        }
        const blob = new Blob([bytes], { type: 'video/mp4' });
        const handle = registerLocalMedia(blob);
        const previewUrl = URL.createObjectURL(blob);
        const metadata = await new Promise((resolve) => {
          const video = document.createElement('video');
          video.preload = 'metadata';
          const cleanup = () => {
            video.removeAttribute('src');
            video.load();
            URL.revokeObjectURL(previewUrl);
          };
          video.onloadedmetadata = () => {
            resolve({
              width: video.videoWidth || 960,
              height: video.videoHeight || 540,
              duration: Number.isFinite(video.duration) ? video.duration : 5,
            });
            cleanup();
          };
          video.onerror = () => {
            resolve({ width: 960, height: 540, duration: 5 });
            cleanup();
          };
          video.src = previewUrl;
        });
        updateNodeData(${JSON.stringify(nodeId)}, {
          videoUrl: handle,
          status: 'completed',
          aspectRatio: Number(metadata?.width || 0) >= Number(metadata?.height || 0) ? '16:9' : '9:16',
          duration: Math.max(1, Math.round(Number(metadata?.duration || 5))),
          params: {
            videoMeta: metadata,
            videoMimeType: 'video/mp4',
          },
          outputs: [
            {
              id: 'verify-seeded-video',
              type: 'video',
              url: handle,
              thumbnail: handle,
              metadata: {
                mimeType: 'video/mp4',
                width: Number(metadata?.width || 960),
                height: Number(metadata?.height || 540),
                duration: Number(metadata?.duration || 5),
              },
            },
          ],
        });
        return { ok: true, handle, metadata };
      })()
    `, 60000);
    assert(fallbackSeedState?.ok, 'Failed to seed the sample video via direct local-media injection.', fallbackSeedState);
  }
  await waitFor(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
      const params = node?.data?.params || {};
      return String(node?.data?.videoUrl || '') !== ''
        && String(node?.data?.status || '') === 'completed'
        && Number(params.videoMeta?.width || 0) > 0
        && Number(params.videoMeta?.height || 0) > 0;
    })()
  `, 60000, 150);
  const renderState = await waitForRenderedVideo(cdp, nodeId, 60000);
  await recorder('video-node-seeded-ui-only', { nodeId, videoPath, renderState });
  return renderState;
}

async function verifyAudioNodePanelInteractions(cdp, recorder, audioNodeId, otherNodeId) {
  const panelSelector = `[data-testid="audio-panel-${audioNodeId}"]`;
  const modelBrowserToggleSelector = `[data-testid="audio-model-browser-toggle-${audioNodeId}"]`;
  const modelBrowserSelector = `[data-testid="audio-model-browser-${audioNodeId}"]`;
  const promptSelector = `[data-testid="audio-prompt-${audioNodeId}"]`;
  const promptTabSelector = `[data-testid="audio-panel-tab-${audioNodeId}-prompt"]`;
  const resultTabSelector = `[data-testid="audio-panel-tab-${audioNodeId}-result"]`;
  const generateSelector = `[data-testid="audio-generate-${audioNodeId}"]`;
  const voiceoverModeSelector = `[data-testid="audio-mode-${audioNodeId}-voiceover"]`;
  const tuneTabSelector = `[data-testid="audio-panel-tab-${audioNodeId}-tune"]`;
  const voiceOptionSelector = `[data-testid="audio-voice-option-${audioNodeId}-soft_girl"]`;
  const paneSelector = '.react-flow__pane';
  const panelReadyExpression = `Boolean(document.querySelector(${JSON.stringify(panelSelector)}) && document.querySelector(${JSON.stringify(voiceoverModeSelector)}))`;

  async function resetAudioCanvasUiState() {
    await evalJs(cdp, `
      (() => {
        const canvasStore = window.__HMDAO_DEBUG__?.canvasStore;
        const store = canvasStore?.getState?.();
        if (!store || typeof store.setSelectedNodeIds !== 'function') return false;
        store.setSelectedNodeIds([]);
        store.closeFloatingPanel?.();
        store.setSelectionGuard?.(0);
        if (typeof canvasStore?.setState === 'function') {
          canvasStore.setState((state) => {
            state.selectedNodeIds = [];
            state.floatingPanel = null;
            state.selectionGuardUntil = 0;
            if (state.canvas?.nodes) {
              for (const node of state.canvas.nodes) {
                node.selected = false;
              }
            }
          });
        }
        return true;
      })()
    `, 10000).catch(() => false);
    await sleep(80);
  }

  async function ensurePanelOpen() {
    if (await evalJs(cdp, panelReadyExpression, 3000).catch(() => false)) {
      return true;
    }
    await clickSelector(cdp, `[data-testid="audio-node-${audioNodeId}"]`).catch(() => null);
    if (await evalJs(cdp, panelReadyExpression, 3000).catch(() => false)) {
      return true;
    }
    await clickSelector(cdp, `[data-testid="audio-editor-toggle-${audioNodeId}"]`).catch(() => null);
    if (await evalJs(cdp, panelReadyExpression, 3000).catch(() => false)) {
      return true;
    }
    await clickSelector(cdp, `[data-testid="audio-center-action-${audioNodeId}"]`).catch(() => null);
    const visibleAfterClicks = await waitFor(cdp, panelReadyExpression, 1500, 75)
      .then(() => true)
      .catch(() => false);
    if (visibleAfterClicks) {
      return true;
    }
    const storeOpenOk = await evalJs(cdp, `
      (() => {
        const canvasStore = window.__HMDAO_DEBUG__?.canvasStore;
        const store = canvasStore?.getState?.();
        if (!store || typeof store.setSelectedNodeIds !== 'function' || typeof store.openFloatingPanel !== 'function') {
          return false;
        }
        const nextSelection = [${JSON.stringify(audioNodeId)}];
        store.setSelectedNodeIds(nextSelection);
        store.openFloatingPanel({ nodeId: ${JSON.stringify(audioNodeId)}, kind: 'audio-composer' });
        if (typeof canvasStore?.setState === 'function') {
          canvasStore.setState((state) => {
            state.selectedNodeIds = nextSelection;
            state.floatingPanel = { nodeId: ${JSON.stringify(audioNodeId)}, kind: 'audio-composer' };
            if (state.canvas?.nodes) {
              for (const node of state.canvas.nodes) {
                node.selected = node.id === ${JSON.stringify(audioNodeId)};
              }
            }
          });
        }
        return true;
      })()
    `, 10000).catch(() => false);
    if (!storeOpenOk) {
      return false;
    }
    return waitFor(cdp, panelReadyExpression, 5000, 75).then(() => true).catch(() => false);
  }

  async function ensureAudioPanelReady(reason) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await selectNodeById(cdp, audioNodeId);
      await waitForNodeSelection(cdp, audioNodeId);
      await stabilizeExclusiveNodeSelection(cdp, audioNodeId, 2400);
      const opened = await ensurePanelOpen();
      const panelState = await evalJs(cdp, `
        (() => {
          const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
          const selectedNodeIds = Array.isArray(store?.selectedNodeIds) ? store.selectedNodeIds : [];
          return {
            selectedNodeIds,
            floatingPanel: store?.floatingPanel || null,
            opened: ${JSON.stringify(opened)},
            hasPanel: Boolean(document.querySelector(${JSON.stringify(panelSelector)})),
            hasVoiceoverButton: Boolean(document.querySelector(${JSON.stringify(voiceoverModeSelector)})),
          };
        })()
      `, 10000).catch((error) => ({ error: error?.message || String(error) }));
      const exclusiveSelection = Array.isArray(panelState?.selectedNodeIds)
        && panelState.selectedNodeIds.length === 1
        && panelState.selectedNodeIds[0] === audioNodeId;
      if (exclusiveSelection && panelState?.hasPanel && panelState?.hasVoiceoverButton) {
        return;
      }
      await clearCanvasSelection(cdp).catch(() => null);
      await sleep(90);
    }
    const failureState = await evalJs(cdp, `
      (() => {
        const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
        const node = store?.canvas?.nodes?.find((item) => item.id === ${JSON.stringify(audioNodeId)});
        return {
          reason: ${JSON.stringify(reason)},
          selectedNodeIds: Array.isArray(store?.selectedNodeIds) ? store.selectedNodeIds : [],
          floatingPanel: store?.floatingPanel || null,
          hasPanel: Boolean(document.querySelector(${JSON.stringify(panelSelector)})),
          hasVoiceoverButton: Boolean(document.querySelector(${JSON.stringify(voiceoverModeSelector)})),
          nodeMode: String(node?.data?.params?.audioMode || ''),
          nodeStatus: String(node?.data?.status || ''),
        };
      })()
    `, 10000).catch((error) => ({ error: error?.message || String(error) }));
    await recorder(`audio-node-panel-ready-failed-${reason}`, {
      audioNodeId,
      reason,
      failureState,
    });
    throw new Error(`Audio panel was not ready for ${reason}. ${JSON.stringify(failureState)}`);
  }

  async function setPromptValue(value) {
    const ok = await evalJs(cdp, `
      (() => {
        const field = document.querySelector(${JSON.stringify(promptSelector)});
        if (!(field instanceof HTMLTextAreaElement)) return false;
        if (typeof window.__setNativeValue === 'function') {
          window.__setNativeValue(field, ${JSON.stringify(value)});
          return true;
        }
        field.value = ${JSON.stringify(value)};
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `, 10000).catch(() => false);
    assert(ok, 'Unable to set audio prompt value.', { audioNodeId, promptSelector, value });
  }

  async function ensurePromptTabReady(mode) {
    const promptReady = await waitFor(cdp, `!!document.querySelector(${JSON.stringify(promptSelector)})`, 1800, 75)
      .then(() => true)
      .catch(() => false);
    if (promptReady) return;

    await invokeReactClick(cdp, promptTabSelector).catch(() => null);
    const promptAfterReactClick = await waitFor(cdp, `!!document.querySelector(${JSON.stringify(promptSelector)})`, 2200, 75)
      .then(() => true)
      .catch(() => false);
    if (promptAfterReactClick) return;

    await clickSelectorAtRatio(cdp, promptTabSelector, { x: 0.5, y: 0.5 }).catch(() => null);
    const promptAfterPointerClick = await waitFor(cdp, `!!document.querySelector(${JSON.stringify(promptSelector)})`, 2200, 75)
      .then(() => true)
      .catch(() => false);
    if (promptAfterPointerClick) return;

    await ensurePanelOpen();
    await clickSelector(cdp, promptTabSelector).catch(() => null);
    const promptVisible = await waitFor(cdp, `!!document.querySelector(${JSON.stringify(promptSelector)})`, 3200, 75)
      .then(() => true)
      .catch(() => false);
    if (promptVisible) return;

    const promptTabFailureState = await evalJs(cdp, `
      (() => {
        const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
        const node = store?.canvas?.nodes?.find((item) => item.id === ${JSON.stringify(audioNodeId)});
        const promptTab = document.querySelector(${JSON.stringify(promptTabSelector)});
        return {
          mode: ${JSON.stringify(mode)},
          selectedNodeIds: Array.isArray(store?.selectedNodeIds) ? store.selectedNodeIds : [],
          floatingPanel: store?.floatingPanel || null,
          hasPanel: Boolean(document.querySelector(${JSON.stringify(panelSelector)})),
          promptTabExists: Boolean(promptTab),
          promptTabActive: String(promptTab?.getAttribute?.('data-active') || ''),
          promptTabText: String(promptTab?.textContent || ''),
          promptVisible: Boolean(document.querySelector(${JSON.stringify(promptSelector)})),
          nodeMode: String(node?.data?.params?.audioMode || ''),
          panelText: String(document.querySelector(${JSON.stringify(panelSelector)})?.textContent || '').slice(0, 360),
        };
      })()
    `, 10000).catch((error) => ({ error: error?.message || String(error) }));
    await recorder(`audio-node-prompt-tab-failed-${mode}`, {
      audioNodeId,
      mode,
      promptTabFailureState,
    });
    throw new Error(`Audio prompt tab was not ready for ${mode}. ${JSON.stringify(promptTabFailureState)}`);
  }

  async function verifyGeneratedPlayback(modeLabel) {
    await ensureAudioPanelReady(`result-${modeLabel}`);
    const resultTabVisible = await waitFor(cdp, `!!document.querySelector(${JSON.stringify(resultTabSelector)})`, 3000, 75)
      .then(() => true)
      .catch(() => false);
    if (resultTabVisible) {
      await invokeReactClick(cdp, resultTabSelector).catch(() => null);
      await clickSelector(cdp, resultTabSelector).catch(() => null);
    }
    await waitFor(cdp, `
      (() => {
        const button = document.querySelector(${JSON.stringify(`[data-testid="audio-play-${audioNodeId}"]`)});
        return Boolean(button);
      })()
    `, 5000, 75).catch(() => null);
    const playbackAttempt = await evalJs(cdp, `
      (async () => {
        const audio = document.querySelector(${JSON.stringify(`[data-testid="audio-element-${audioNodeId}"]`)});
        if (!(audio instanceof HTMLAudioElement)) {
          return { ok: false, reason: 'missing-audio-element' };
        }
        audio.muted = true;
        try {
          await audio.play();
          await new Promise((resolve) => setTimeout(resolve, 120));
          const state = {
            ok: audio.paused === false,
            paused: Boolean(audio.paused),
            currentTime: Number(audio.currentTime || 0),
            readyState: Number(audio.readyState || 0),
            duration: Number(audio.duration || 0),
          };
          audio.pause();
          return state;
        } catch (error) {
          return {
            ok: false,
            reason: error?.message || String(error),
            paused: Boolean(audio.paused),
            readyState: Number(audio.readyState || 0),
          };
        }
      })()
    `, 20000);
    const renderState = await readAudioRenderState(cdp, audioNodeId);
    assert(renderState.playVisible, `${modeLabel} result is missing the play button.`, renderState);
    assert(renderState.downloadVisible, `${modeLabel} result is missing the download button.`, renderState);
    assert(String(renderState.currentSrc || '').includes('/api/local-audio/result/'), `${modeLabel} result did not use the local persisted audio route.`, renderState);
    assert(playbackAttempt.ok, `${modeLabel} result could not be played back.`, { playbackAttempt, renderState });
    return {
      renderState,
      playbackAttempt,
    };
  }

  async function generateAudioForMode(mode, prompt, modeSelector) {
    await resetAudioCanvasUiState();
    await ensureAudioPanelReady(`generate-${mode}`);
    const modeSelectorVisible = await waitFor(cdp, `!!document.querySelector(${JSON.stringify(modeSelector)})`, 5000, 75)
      .then(() => true)
      .catch(() => false);
    if (!modeSelectorVisible) {
      const missingModeState = await evalJs(cdp, `
        (() => {
          const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
          const node = store?.canvas?.nodes?.find((item) => item.id === ${JSON.stringify(audioNodeId)});
          return {
            selectedNodeIds: Array.isArray(store?.selectedNodeIds) ? store.selectedNodeIds : [],
            floatingPanel: store?.floatingPanel || null,
            hasPanel: Boolean(document.querySelector(${JSON.stringify(panelSelector)})),
            hasVoiceoverButton: Boolean(document.querySelector(${JSON.stringify(voiceoverModeSelector)})),
            hasModeButton: Boolean(document.querySelector(${JSON.stringify(modeSelector)})),
            nodeMode: String(node?.data?.params?.audioMode || ''),
            nodeStatus: String(node?.data?.status || ''),
            panelText: String(document.querySelector(${JSON.stringify(panelSelector)})?.textContent || '').slice(0, 240),
          };
        })()
      `, 10000).catch((error) => ({ error: error?.message || String(error) }));
      await recorder(`audio-node-mode-selector-missing-${mode}`, {
        audioNodeId,
        mode,
        modeSelector,
        missingModeState,
      });
      throw new Error(`Audio mode selector was not visible for ${mode}. ${JSON.stringify(missingModeState)}`);
    }
    const activateMode = async () => {
      await clickSelectorAtRatio(cdp, modeSelector, { x: 0.5, y: 0.5 }).catch(() => null);
      const activeAfterPointerClick = await waitFor(cdp, `
        (() => {
          const button = document.querySelector(${JSON.stringify(modeSelector)});
          const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
          const node = store?.canvas?.nodes?.find((item) => item.id === ${JSON.stringify(audioNodeId)});
          return Boolean(
            button?.getAttribute?.('data-active') === 'true'
            || String(node?.data?.params?.audioMode || '') === ${JSON.stringify(mode)}
          );
        })()
      `, 2200, 75).then(() => true).catch(() => false);
      if (activeAfterPointerClick) {
        return true;
      }
      await invokeReactClick(cdp, modeSelector).catch(() => null);
      const activeAfterReactClick = await waitFor(cdp, `
        (() => {
          const button = document.querySelector(${JSON.stringify(modeSelector)});
          const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
          const node = store?.canvas?.nodes?.find((item) => item.id === ${JSON.stringify(audioNodeId)});
          return Boolean(
            document.querySelector(${JSON.stringify(panelSelector)})
            && (
              button?.getAttribute?.('data-active') === 'true'
              || String(node?.data?.params?.audioMode || '') === ${JSON.stringify(mode)}
            )
          );
        })()
      `, 2200, 75).then(() => true).catch(() => false);
      if (activeAfterReactClick) {
        return true;
      }
      await clickSelector(cdp, modeSelector).catch(() => null);
      return waitFor(cdp, `
        (() => {
          const button = document.querySelector(${JSON.stringify(modeSelector)});
          const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
          const node = store?.canvas?.nodes?.find((item) => item.id === ${JSON.stringify(audioNodeId)});
          return Boolean(
            button?.getAttribute?.('data-active') === 'true'
            || String(node?.data?.params?.audioMode || '') === ${JSON.stringify(mode)}
          );
        })()
      `, 3200, 75).then(() => true).catch(() => false);
    };
    let modeActivated = await activateMode();
    if (!modeActivated) {
      await ensurePanelOpen();
      await waitForSelector(cdp, modeSelector, 5000);
      modeActivated = await activateMode();
    }
    if (!modeActivated) {
      const modeActivationFailureState = await evalJs(cdp, `
        (() => {
          const button = document.querySelector(${JSON.stringify(modeSelector)});
          const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
          const node = store?.canvas?.nodes?.find((item) => item.id === ${JSON.stringify(audioNodeId)});
          return {
            selectedNodeIds: Array.isArray(store?.selectedNodeIds) ? store.selectedNodeIds : [],
            floatingPanel: store?.floatingPanel || null,
            hasPanel: Boolean(document.querySelector(${JSON.stringify(panelSelector)})),
            buttonExists: Boolean(button),
            buttonActive: String(button?.getAttribute?.('data-active') || ''),
            buttonClass: String(button?.className || ''),
            buttonText: String(button?.textContent || ''),
            nodeMode: String(node?.data?.params?.audioMode || ''),
            nodeStatus: String(node?.data?.status || ''),
          };
        })()
      `, 10000).catch((error) => ({ error: error?.message || String(error) }));
      await recorder(`audio-node-mode-activation-failed-${mode}`, {
        audioNodeId,
        mode,
        modeSelector,
        modeActivationFailureState,
      });
    }
    assert(modeActivated, 'Audio panel mode button did not activate.', { audioNodeId, mode, modeSelector });
    await ensurePanelOpen();
    await ensurePromptTabReady(mode);
    await setPromptValue(prompt);
    const promptWriteState = await evalJs(cdp, `
      (() => {
        const field = document.querySelector(${JSON.stringify(promptSelector)});
        const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
        const node = store?.canvas?.nodes?.find((item) => item.id === ${JSON.stringify(audioNodeId)});
        return {
          mode: ${JSON.stringify(mode)},
          promptVisible: Boolean(field),
          promptValue: String(field?.value || ''),
          nodeMode: String(node?.data?.params?.audioMode || ''),
          panelVisible: Boolean(document.querySelector(${JSON.stringify(panelSelector)})),
          selectedNodeIds: Array.isArray(store?.selectedNodeIds) ? store.selectedNodeIds : [],
        };
      })()
    `, 10000).catch((error) => ({ error: error?.message || String(error) }));
    await recorder(`audio-node-before-generate-${mode}`, {
      audioNodeId,
      mode,
      prompt,
      promptWriteState,
    });
    await ensureAudioPanelReady(`pre-generate-click-${mode}`);
    await ensurePromptTabReady(mode);
    const previousRenderState = await readAudioRenderState(cdp, audioNodeId).catch(() => null);
    const generateClicked = await invokeReactClick(cdp, generateSelector)
      .then(() => true)
      .catch(() => false);
    const generateClickedWithDom = generateClicked || await evalJs(cdp, `
      (() => {
        const button = document.querySelector(${JSON.stringify(generateSelector)});
        if (!(button instanceof HTMLButtonElement) || button.disabled) {
          return false;
        }
        button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1 }));
        button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
        button.click();
        return true;
      })()
    `, 10000).catch(() => false);
    const generateClickedWithFallback = generateClickedWithDom || await clickSelectorAtRatio(cdp, generateSelector, { x: 0.5, y: 0.5 })
      .then(() => true)
      .catch(() => false);
    assert(generateClickedWithFallback, 'Unable to click audio generate button.', {
      audioNodeId,
      mode,
      generateSelector,
    });
    await sleep(180);
    const afterClickState = await evalJs(cdp, `
      (() => {
        const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
        const node = store?.canvas?.nodes?.find((item) => item.id === ${JSON.stringify(audioNodeId)});
        return {
          status: String(node?.data?.status || ''),
          error: String(node?.data?.error || ''),
          prompt: String(node?.data?.prompt || ''),
          floatingPanel: store?.floatingPanel || null,
          selectedNodeIds: Array.isArray(store?.selectedNodeIds) ? store.selectedNodeIds : [],
          panelVisible: Boolean(document.querySelector(${JSON.stringify(panelSelector)})),
          panelText: String(document.querySelector(${JSON.stringify(panelSelector)})?.textContent || '').slice(0, 320),
          authDialogText: Array.from(document.querySelectorAll('[role="dialog"]'))
            .map((item) => String(item.textContent || '').trim())
            .filter(Boolean)
            .join(' | ')
            .slice(0, 320),
        };
      })()
    `, 10000).catch((error) => ({ error: error?.message || String(error) }));
    await recorder(`audio-node-generate-clicked-${mode}`, {
      audioNodeId,
      mode,
      prompt,
      previousRenderState,
      afterClickState,
    });
    const reachedTerminalState = await waitFor(cdp, `
      (() => {
        const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
        const node = store?.canvas?.nodes?.find((item) => item.id === ${JSON.stringify(audioNodeId)});
        const root = document.querySelector(${JSON.stringify(`[data-testid="audio-node-${audioNodeId}"]`)});
        const audio = root?.querySelector(${JSON.stringify(`[data-testid="audio-element-${audioNodeId}"]`)}) || root?.querySelector('audio');
        const currentSrc = String(audio?.currentSrc || audio?.getAttribute?.('src') || '');
        const status = String(node?.data?.status || '');
        return (
          (
            String(node?.data?.params?.audioMode || '') === ${JSON.stringify(mode)}
            && status === 'completed'
            && currentSrc.includes('/api/local-audio/result/')
          )
          || status === 'failed'
        );
      })()
    `, 120000, 200).then(() => true).catch(() => false);
    const completionState = await evalJs(cdp, `
      (() => {
        const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
        const node = store?.canvas?.nodes?.find((item) => item.id === ${JSON.stringify(audioNodeId)});
        const root = document.querySelector(${JSON.stringify(`[data-testid="audio-node-${audioNodeId}"]`)});
        const audio = root?.querySelector(${JSON.stringify(`[data-testid="audio-element-${audioNodeId}"]`)}) || root?.querySelector('audio');
        const latestOutput = Array.isArray(node?.data?.outputs) && node.data.outputs.length > 0
          ? node.data.outputs[node.data.outputs.length - 1]
          : null;
        return {
          status: String(node?.data?.status || ''),
          error: String(node?.data?.error || ''),
          prompt: String(node?.data?.prompt || ''),
          nodeMode: String(node?.data?.params?.audioMode || ''),
          sourceUrl: String(node?.data?.params?.sourceUrl || ''),
          currentSrc: String(audio?.currentSrc || audio?.getAttribute?.('src') || ''),
          playVisible: Boolean(root?.querySelector(${JSON.stringify(`[data-testid="audio-play-${audioNodeId}"]`)})),
          downloadVisible: Boolean(root?.querySelector(${JSON.stringify(`[data-testid="audio-download-${audioNodeId}"]`)})),
          outputCount: Array.isArray(node?.data?.outputs) ? node.data.outputs.length : 0,
          latestOutputMode: String(latestOutput?.metadata?.mode || ''),
          latestOutputEngine: String(latestOutput?.metadata?.engine || ''),
          latestOutputBackend: String(latestOutput?.metadata?.backend || ''),
          authDialogText: Array.from(document.querySelectorAll('[role="dialog"]'))
            .map((item) => String(item.textContent || '').trim())
            .filter(Boolean)
            .join(' | ')
            .slice(0, 320),
          panelText: String(document.querySelector(${JSON.stringify(panelSelector)})?.textContent || '').slice(0, 320),
        };
      })()
    `, 10000).catch((error) => ({ error: error?.message || String(error) }));
    await recorder(`audio-node-generate-state-${mode}`, {
      audioNodeId,
      mode,
      prompt,
      reachedTerminalState,
      completionState,
    });
    assert(reachedTerminalState, `Audio generation did not reach a terminal state for ${mode}.`, {
      audioNodeId,
      mode,
      prompt,
      previousRenderState,
      afterClickState,
      completionState,
    });
    assert(completionState.status !== 'failed', `Audio generation failed for ${mode}.`, completionState);
    await waitForRenderedAudio(cdp, audioNodeId, 30000);
    const playbackState = await verifyGeneratedPlayback(`音频模式 ${mode}`);
    await recorder(`audio-node-generate-${mode}`, {
      audioNodeId,
      mode,
      prompt,
      previousRenderState,
      renderState: playbackState.renderState,
      playbackAttempt: playbackState.playbackAttempt,
    });
    return playbackState;
  }

  await resetAudioCanvasUiState();
  await selectNodeById(cdp, audioNodeId);
  await waitForNodeSelection(cdp, audioNodeId);
  await ensurePanelOpen();
  await waitForSelector(cdp, modelBrowserToggleSelector, 10000);
  await clickSelector(cdp, modelBrowserToggleSelector);
  await waitForSelector(cdp, modelBrowserSelector, 10000);
  const audioModelBrowserState = await evalJs(cdp, `
    (() => ({
      visible: Boolean(document.querySelector(${JSON.stringify(modelBrowserSelector)})),
      optionCount: document.querySelectorAll(${JSON.stringify(`[data-testid^="audio-model-option-${audioNodeId}-"]`)}).length,
      panelText: String(document.querySelector(${JSON.stringify(modelBrowserSelector)})?.textContent || '').slice(0, 240),
    }))()
  `, 10000);
  assert(audioModelBrowserState.visible, 'Audio model browser did not open from the visible toggle.', audioModelBrowserState);
  assert(audioModelBrowserState.optionCount > 0, 'Audio model browser did not render any options.', audioModelBrowserState);
  await clickSelector(cdp, modelBrowserToggleSelector);
  await waitFor(cdp, `!document.querySelector(${JSON.stringify(modelBrowserSelector)})`, 10000, 100);
  await recorder('audio-model-browser-visible-verified', { audioNodeId, audioModelBrowserState });
  const voiceoverActivated = await invokeReactClick(cdp, voiceoverModeSelector)
    .then(() => true)
    .catch(() => false)
    || await clickSelectorAtRatio(cdp, voiceoverModeSelector, { x: 0.5, y: 0.5 }).then(() => true).catch(() => false)
    || await clickSelector(cdp, voiceoverModeSelector).then(() => true).catch(() => false);
  assert(voiceoverActivated, 'Unable to activate the audio voiceover mode button.', {
    audioNodeId,
    voiceoverModeSelector,
  });
  const modeClickState = await evalJs(cdp, `
    (() => {
      const button = document.querySelector(${JSON.stringify(voiceoverModeSelector)});
      const panel = document.querySelector(${JSON.stringify(panelSelector)});
      const node = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes?.find((item) => item.id === ${JSON.stringify(audioNodeId)});
      return {
        panelVisible: Boolean(panel),
        buttonExists: Boolean(button),
        buttonActive: button?.getAttribute?.('data-active') || '',
        buttonClass: String(button?.className || ''),
        buttonText: String(button?.textContent || ''),
        audioMode: String(node?.data?.params?.audioMode || ''),
        selectedIds: window.__HMDAO_DEBUG__?.canvasStore?.getState?.().selectedNodeIds || [],
      };
    })()
  `, 5000);
  await recorder('audio-node-mode-switch-debug', {
    audioNodeId,
    otherNodeId,
    modeClickState,
  });
  assert(
    modeClickState.audioMode === 'voiceover',
    'Audio node did not persist the voiceover mode after switching.',
    modeClickState,
  );
  const selectedVoiceState = await evalJs(cdp, `
    (() => {
      const activeCard = document.querySelector(${JSON.stringify(voiceOptionSelector)});
      const tuneTab = document.querySelector(${JSON.stringify(tuneTabSelector)});
      return {
        voiceListVisible: Boolean(activeCard),
        activeClass: String(activeCard?.className || ''),
        text: String(activeCard?.textContent || ''),
        tuneTabActive: tuneTab?.getAttribute?.('data-active') || '',
      };
    })()
  `, 5000);
  const bgmGenerationState = await generateAudioForMode(
    'bgm',
    '生成一段适合汽车海报的克制电子氛围背景音乐，节奏稳定，低频干净，尾音收束自然。',
    `[data-testid="audio-mode-${audioNodeId}-bgm"]`,
  );
  const sfxGenerationState = await generateAudioForMode(
    'sfx',
    '生成一个科技界面确认提示音，清脆、短促、收尾干净，不要混响过重。',
    `[data-testid="audio-mode-${audioNodeId}-sfx"]`,
  );
  const voiceoverGenerationState = await generateAudioForMode(
    'voiceover',
    '请用自然、真实、带一点情绪起伏的中文口播语气，介绍这款新车的速度感与未来感。',
    voiceoverModeSelector,
  );
  await sleep(320);
  await invokeReactClick(cdp, paneSelector);
  const panelHiddenAfterPaneClick = await waitFor(cdp, `
    !document.querySelector(${JSON.stringify(panelSelector)})
  `, 900, 50).then(() => true).catch(() => false);
  if (!panelHiddenAfterPaneClick) {
    await clearCanvasSelection(cdp);
    await waitFor(cdp, `
      !document.querySelector(${JSON.stringify(panelSelector)})
    `, 3000, 50);
  }

  await selectNodeById(cdp, audioNodeId);
  await waitForNodeSelection(cdp, audioNodeId);
  await ensurePanelOpen();
  await evalJs(cdp, `
    (() => {
      const canvasStore = window.__HMDAO_DEBUG__?.canvasStore;
      const store = canvasStore?.getState?.();
      if (!store || typeof store.setSelectedNodeIds !== 'function') return false;
      const nextSelection = [${JSON.stringify(audioNodeId)}, ${JSON.stringify(otherNodeId)}];
      store.setSelectedNodeIds(nextSelection);
      if (typeof canvasStore?.setState === 'function') {
        canvasStore.setState((state) => {
          state.selectedNodeIds = nextSelection;
          state.floatingPanel = null;
          if (state.canvas?.nodes) {
            for (const node of state.canvas.nodes) {
              node.selected = nextSelection.includes(node.id);
            }
          }
        });
      }
      return true;
    })()
  `, 5000);
  await waitFor(cdp, `
    !document.querySelector(${JSON.stringify(panelSelector)})
  `, 3000, 50);
  const multiSelectState = await evalJs(cdp, `
    (() => {
      return {
        selectedIds: window.__HMDAO_DEBUG__?.canvasStore?.getState?.().selectedNodeIds || [],
        panelVisible: Boolean(document.querySelector(${JSON.stringify(panelSelector)})),
      };
    })()
  `, 5000);

  await selectNodeById(cdp, audioNodeId);
  await waitForNodeSelection(cdp, audioNodeId);
  await ensurePanelOpen();
  await selectNodeById(cdp, otherNodeId);
  await waitForNodeSelection(cdp, otherNodeId);
  await waitFor(cdp, `
    !document.querySelector(${JSON.stringify(panelSelector)})
  `, 3000, 50);

  const interactionState = await evalJs(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const audioNode = nodes.find((item) => item.id === ${JSON.stringify(audioNodeId)});
      const otherNode = nodes.find((item) => item.id === ${JSON.stringify(otherNodeId)});
      return {
        audioMode: String(audioNode?.data?.params?.audioMode || ''),
        selectedIds: window.__HMDAO_DEBUG__?.canvasStore?.getState?.().selectedNodeIds || [],
        otherNodeType: String(otherNode?.type || ''),
        panelVisible: Boolean(document.querySelector(${JSON.stringify(panelSelector)})),
      };
    })()
  `, 5000);

  assert(interactionState.audioMode === 'voiceover', 'Audio node did not persist voiceover mode after switching.', interactionState);
  assert(multiSelectState.panelVisible === false, 'Audio panel should be hidden while multiple nodes are selected.', multiSelectState);
  assert(interactionState.panelVisible === false, 'Audio panel should be hidden after switching to another node.', interactionState);
  await recorder('audio-node-panel-interactions', {
    audioNodeId,
    otherNodeId,
    selectedVoiceState,
    multiSelectState,
    interactionState,
    bgmGenerationState,
    sfxGenerationState,
    voiceoverGenerationState,
  });
  return {
    ...interactionState,
    bgmGenerationState,
    sfxGenerationState,
    voiceoverGenerationState,
  };
}

async function verifyImageVideoFloatingPanelInteractions(cdp, recorder, imageNodeId, videoNodeId) {
  const paneSelector = '.react-flow__pane';
  const videoToolPanelSelector = `[data-testid="video-tool-panel-${videoNodeId}"]`;
  const cropEditorSelector = `[data-testid="video-crop-editor-${videoNodeId}"]`;
  const clipEditorSelector = `[data-testid="video-clip-editor-${videoNodeId}"]`;
  const videoAdvancedPanelSelector = `[data-testid="video-advanced-panel-${videoNodeId}"]`;
  const videoReferencePanelSelector = `[data-testid="video-reference-panel-${videoNodeId}"]`;

  async function closeViaBlankCanvas(panelVisibleExpression) {
    await invokeReactClick(cdp, paneSelector).catch(() => null);
    const hiddenAfterClick = await waitFor(cdp, `!(${panelVisibleExpression})`, 1200, 50).then(() => true).catch(() => false);
    if (hiddenAfterClick) return;
    await clearCanvasSelection(cdp);
    await waitFor(cdp, `!(${panelVisibleExpression})`, 3000, 50);
  }

  async function openVideoTool(tool) {
    const toolbarSelector = `[data-testid="video-toolbar-${videoNodeId}-${tool}"]`;
    const inlineSelector = `[data-testid="video-tool-${videoNodeId}-${tool}"]`;
    const selector = await evalJs(cdp, `
      (() => {
        if (document.querySelector(${JSON.stringify(toolbarSelector)})) return ${JSON.stringify(toolbarSelector)};
        if (document.querySelector(${JSON.stringify(inlineSelector)})) return ${JSON.stringify(inlineSelector)};
        return '';
      })()
    `, 10000);
    assert(selector, `Unable to find video tool activator for floating panel test: ${tool}.`, { videoNodeId, tool });
    await invokeReactClick(cdp, selector);
  }

  async function ensureVideoFloatingEditorOpen(tool, kind, selector) {
    await selectNodeById(cdp, videoNodeId);
    await waitForNodeSelection(cdp, videoNodeId);
    await openVideoTool(tool);
    let visible = await waitFor(cdp, `!!document.querySelector(${JSON.stringify(selector)})`, 2500, 100).catch(() => false);
    if (!visible) {
      await evalJs(cdp, `
        (() => {
          const canvasStore = window.__HMDAO_DEBUG__?.canvasStore;
          const store = canvasStore?.getState?.();
          const setSelectedNodeIds = store?.setSelectedNodeIds;
          const openFloatingPanel = store?.openFloatingPanel;
          const updateNodeData = store?.updateNodeData;
          const closeFloatingPanel = store?.closeFloatingPanel;
          if (typeof closeFloatingPanel === 'function') {
            closeFloatingPanel();
          }
          if (typeof setSelectedNodeIds === 'function') {
            setSelectedNodeIds([${JSON.stringify(videoNodeId)}]);
          }
          if (typeof updateNodeData === 'function') {
            const node = store?.canvas?.nodes?.find((item) => item.id === ${JSON.stringify(videoNodeId)});
            const params = node?.data?.params || {};
            updateNodeData(${JSON.stringify(videoNodeId)}, {
              params: {
                ...params,
                videoTool: ${JSON.stringify(tool)},
              },
            });
          }
          if (typeof openFloatingPanel === 'function') {
            openFloatingPanel({ nodeId: ${JSON.stringify(videoNodeId)}, kind: ${JSON.stringify(kind)} });
          }
          if (typeof canvasStore?.setState === 'function') {
            canvasStore.setState((state) => {
              state.selectedNodeIds = [${JSON.stringify(videoNodeId)}];
              state.floatingPanel = { nodeId: ${JSON.stringify(videoNodeId)}, kind: ${JSON.stringify(kind)} };
              state.selectionGuardUntil = Date.now() + 2400;
              if (state.canvas?.nodes) {
                for (const canvasNode of state.canvas.nodes) {
                  canvasNode.selected = canvasNode.id === ${JSON.stringify(videoNodeId)};
                }
              }
            });
          }
          return true;
        })()
      `, 10000).catch(() => false);
      await invokeReactClick(cdp, `[data-testid="video-node-${videoNodeId}"]`).catch(() => false);
      await openVideoTool(tool).catch(() => false);
      visible = await waitFor(cdp, `!!document.querySelector(${JSON.stringify(selector)})`, 4000, 100).catch(() => false);
    }
    if (!visible) {
      const debugState = await evalJs(cdp, `
        (() => {
          const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.() || {};
          const node = (store.canvas?.nodes || []).find((item) => item.id === ${JSON.stringify(videoNodeId)}) || null;
          return {
            selectedNodeIds: Array.isArray(store.selectedNodeIds) ? store.selectedNodeIds : [],
            floatingPanel: store.floatingPanel || null,
            nodeStatus: String(node?.data?.status || ''),
            activeVideoTool: String(node?.data?.params?.videoTool || ''),
            selectorVisible: Boolean(document.querySelector(${JSON.stringify(selector)})),
            dockedPanelVisible: Boolean(document.querySelector(${JSON.stringify(videoToolPanelSelector)})),
          };
        })()
      `, 10000).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
      throw new Error(`Floating editor did not open for ${tool} during panel regression: ${JSON.stringify(debugState)}`);
    }
  }

  async function ensureImageToolPanelOpen(tool, selector) {
    const activatorSelector = `[data-testid="image-tool-chip-${imageNodeId}-${tool}"]`;
    await selectNodeById(cdp, imageNodeId);
    await waitForNodeSelection(cdp, imageNodeId);
    await invokeReactClick(cdp, activatorSelector);
    let visible = await waitFor(cdp, `!!document.querySelector(${JSON.stringify(selector)})`, 2500, 100).catch(() => false);
    if (!visible) {
      await evalJs(cdp, `
        (() => {
          const canvasStore = window.__HMDAO_DEBUG__?.canvasStore;
          const store = canvasStore?.getState?.();
          const setSelectedNodeIds = store?.setSelectedNodeIds;
          const openFloatingPanel = store?.openFloatingPanel;
          const updateNodeData = store?.updateNodeData;
          const closeFloatingPanel = store?.closeFloatingPanel;
          if (typeof closeFloatingPanel === 'function') {
            closeFloatingPanel();
          }
          if (typeof setSelectedNodeIds === 'function') {
            setSelectedNodeIds([${JSON.stringify(imageNodeId)}]);
          }
          if (typeof updateNodeData === 'function') {
            const node = store?.canvas?.nodes?.find((item) => item.id === ${JSON.stringify(imageNodeId)});
            const params = node?.data?.params || {};
            updateNodeData(${JSON.stringify(imageNodeId)}, {
              params: {
                ...params,
                imageTool: ${JSON.stringify(tool)},
              },
            });
          }
          if (typeof openFloatingPanel === 'function') {
            openFloatingPanel({ nodeId: ${JSON.stringify(imageNodeId)}, kind: 'image-tool-panel' });
          }
          if (typeof canvasStore?.setState === 'function') {
            canvasStore.setState((state) => {
              state.selectedNodeIds = [${JSON.stringify(imageNodeId)}];
              state.floatingPanel = { nodeId: ${JSON.stringify(imageNodeId)}, kind: 'image-tool-panel' };
              state.selectionGuardUntil = Date.now() + 2400;
              if (state.canvas?.nodes) {
                for (const canvasNode of state.canvas.nodes) {
                  canvasNode.selected = canvasNode.id === ${JSON.stringify(imageNodeId)};
                  if (canvasNode.id === ${JSON.stringify(imageNodeId)}) {
                    const currentParams = canvasNode.data?.params && typeof canvasNode.data.params === 'object'
                      ? canvasNode.data.params
                      : {};
                    canvasNode.data = {
                      ...canvasNode.data,
                      params: {
                        ...currentParams,
                        imageTool: ${JSON.stringify(tool)},
                      },
                    };
                  }
                }
              }
            });
          }
          return true;
        })()
      `, 10000).catch(() => false);
      await invokeReactClick(cdp, `[data-testid="image-node-${imageNodeId}"]`).catch(() => false);
      await invokeReactClick(cdp, activatorSelector).catch(() => false);
      visible = await waitFor(cdp, `!!document.querySelector(${JSON.stringify(selector)})`, 4000, 100).catch(() => false);
    }
    if (!visible) {
      const debugState = await evalJs(cdp, `
        (() => {
          const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.() || {};
          const node = (store.canvas?.nodes || []).find((item) => item.id === ${JSON.stringify(imageNodeId)}) || null;
          return {
            selectedNodeIds: Array.isArray(store.selectedNodeIds) ? store.selectedNodeIds : [],
            floatingPanel: store.floatingPanel || null,
            imageTool: String(node?.data?.params?.imageTool || ''),
            selectorVisible: Boolean(document.querySelector(${JSON.stringify(selector)})),
          };
        })()
      `, 10000).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
      throw new Error(`Image tool panel did not open for ${tool} during panel regression: ${JSON.stringify(debugState)}`);
    }
  }

  async function ensureImagePromptPanelReady() {
    const toggleSelector = `[data-testid="image-model-toggle-${imageNodeId}"]`;
    const promptSelector = `[data-testid="image-prompt-${imageNodeId}"]`;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await selectNodeById(cdp, imageNodeId);
      await waitForNodeSelection(cdp, imageNodeId);
      const ready = await waitFor(cdp, `
        (() => {
          const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
          const selectedNodeIds = Array.isArray(store?.selectedNodeIds) ? store.selectedNodeIds : [];
          const toggle = document.querySelector(${JSON.stringify(toggleSelector)});
          const prompt = document.querySelector(${JSON.stringify(promptSelector)});
          return selectedNodeIds.length === 1
            && selectedNodeIds[0] === ${JSON.stringify(imageNodeId)}
            && Boolean(toggle || prompt);
        })()
      `, 4500, 120).catch(() => false);
      if (ready) {
        return;
      }
      await invokeReactClick(cdp, `[data-testid="image-node-${imageNodeId}"]`).catch(() => false);
      await sleep(250);
    }
    const debugState = await evalJs(cdp, `
      (() => {
        const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.() || {};
        const node = (store.canvas?.nodes || []).find((item) => item.id === ${JSON.stringify(imageNodeId)}) || null;
        return {
          selectedNodeIds: Array.isArray(store.selectedNodeIds) ? store.selectedNodeIds : [],
          floatingPanel: store.floatingPanel || null,
          nodeSelected: Boolean(node?.selected),
          hasRoot: Boolean(document.querySelector(${JSON.stringify(`[data-testid="image-node-${imageNodeId}"]`)})),
          hasPrompt: Boolean(document.querySelector(${JSON.stringify(promptSelector)})),
          hasToggle: Boolean(document.querySelector(${JSON.stringify(toggleSelector)})),
        };
      })()
    `, 10000).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
    throw new Error(`Image prompt panel was not ready: ${JSON.stringify(debugState)}`);
  }

  async function clearLingeringVideoTool(tool) {
    await evalJs(cdp, `
      (() => {
        const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
        const updateNodeData = store?.updateNodeData;
        const node = store?.canvas?.nodes?.find((item) => item.id === ${JSON.stringify(videoNodeId)});
        if (typeof updateNodeData !== 'function' || !node) return false;
        const params = node?.data?.params || {};
        if (String(params.videoTool || '') !== ${JSON.stringify(tool)}) return false;
        updateNodeData(${JSON.stringify(videoNodeId)}, {
          params: {
            ...params,
            videoTool: '',
            videoToolOperation: '',
          },
        });
        return true;
      })()
    `, 10000).catch(() => false);
  }

  await ensureImagePromptPanelReady();

  await invokeReactClick(cdp, `[data-testid="image-model-toggle-${imageNodeId}"]`);
  await waitFor(cdp, `
    (() => {
      const floating = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().floatingPanel;
      const options = document.querySelectorAll(${JSON.stringify(`[data-testid^="image-model-option-${imageNodeId}-"]`)});
      return floating?.nodeId === ${JSON.stringify(imageNodeId)}
        && floating?.kind === 'image-model-menu'
        && options.length > 0;
    })()
  `, 10000, 100);
  const imageModelState = await evalJs(cdp, `
    (() => {
      const floating = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().floatingPanel;
      return {
        selectedIds: window.__HMDAO_DEBUG__?.canvasStore?.getState?.().selectedNodeIds || [],
        floating,
        optionCount: document.querySelectorAll(${JSON.stringify(`[data-testid^="image-model-option-${imageNodeId}-"]`)}).length,
      };
    })()
  `, 10000);

  await closeViaBlankCanvas(`document.querySelectorAll(${JSON.stringify(`[data-testid^="image-model-option-${imageNodeId}-"]`)}).length > 0`);
  const imageModelClosedState = await evalJs(cdp, `
    (() => ({
      floating: window.__HMDAO_DEBUG__?.canvasStore?.getState?.().floatingPanel || null,
      panelVisible: document.querySelectorAll(${JSON.stringify(`[data-testid^="image-model-option-${imageNodeId}-"]`)}).length > 0,
      selectedIds: window.__HMDAO_DEBUG__?.canvasStore?.getState?.().selectedNodeIds || [],
    }))()
  `, 10000);

  await selectNodeById(cdp, imageNodeId);
  await waitForNodeSelection(cdp, imageNodeId);
  await ensureImageToolPanelOpen('hd', '[data-testid="image-tool-panel-hd"]');
  const imageToolOpenAttemptState = await evalJs(cdp, `
    (() => {
      const floating = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().floatingPanel || null;
      const node = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes?.find((item) => item.id === ${JSON.stringify(imageNodeId)}) || null;
      return {
        floating,
        imageTool: String(node?.data?.params?.imageTool || ''),
        toolOperation: String(node?.data?.params?.toolOperation || ''),
        selectedIds: window.__HMDAO_DEBUG__?.canvasStore?.getState?.().selectedNodeIds || [],
        hdPanelVisible: Boolean(document.querySelector(${JSON.stringify('[data-testid="image-tool-panel-hd"]')})),
      };
    })()
  `, 10000);
  await recorder('image-tool-open-attempt', imageToolOpenAttemptState);
  await waitFor(cdp, `
    (() => {
      const floating = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().floatingPanel;
      return floating?.nodeId === ${JSON.stringify(imageNodeId)}
        && floating?.kind === 'image-tool-panel'
        && Boolean(document.querySelector(${JSON.stringify('[data-testid="image-tool-panel-hd"]')}));
    })()
  `, 10000, 100);
  const imageToolState = await evalJs(cdp, `
    (() => ({
      floating: window.__HMDAO_DEBUG__?.canvasStore?.getState?.().floatingPanel || null,
      panelText: String(document.querySelector(${JSON.stringify('[data-testid="image-tool-panel-hd"]')})?.textContent || ''),
      activeImageTool: String(window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes?.find((item) => item.id === ${JSON.stringify(imageNodeId)})?.data?.params?.imageTool || ''),
    }))()
  `, 10000);

  await selectNodeById(cdp, videoNodeId);
  await waitForNodeSelection(cdp, videoNodeId);
  await waitFor(cdp, `
    !document.querySelector(${JSON.stringify('[data-testid="image-tool-panel-hd"]')})
      && window.__HMDAO_DEBUG__?.canvasStore?.getState?.().floatingPanel?.nodeId !== ${JSON.stringify(imageNodeId)}
  `, 3000, 50);
  const imageClosedOnSwitchState = await evalJs(cdp, `
    (() => ({
      floating: window.__HMDAO_DEBUG__?.canvasStore?.getState?.().floatingPanel || null,
      selectedIds: window.__HMDAO_DEBUG__?.canvasStore?.getState?.().selectedNodeIds || [],
      imagePanelVisible: Boolean(document.querySelector(${JSON.stringify('[data-testid="image-tool-panel-hd"]')})),
    }))()
  `, 10000);

  await waitForSelector(cdp, `[data-testid="video-model-toggle-${videoNodeId}"]`, 10000);
  await invokeReactClick(cdp, `[data-testid="video-model-toggle-${videoNodeId}"]`);
  await waitFor(cdp, `
    (() => {
      const floating = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().floatingPanel;
      const options = document.querySelectorAll(${JSON.stringify(`[data-testid^="video-model-option-${videoNodeId}-"]`)});
      return floating?.nodeId === ${JSON.stringify(videoNodeId)}
        && floating?.kind === 'video-model-menu'
        && options.length > 0;
    })()
  `, 10000, 100);
  const videoModelState = await evalJs(cdp, `
    (() => ({
      floating: window.__HMDAO_DEBUG__?.canvasStore?.getState?.().floatingPanel || null,
      optionCount: document.querySelectorAll(${JSON.stringify(`[data-testid^="video-model-option-${videoNodeId}-"]`)}).length,
      selectedIds: window.__HMDAO_DEBUG__?.canvasStore?.getState?.().selectedNodeIds || [],
    }))()
  `, 10000);

  await invokeReactClick(cdp, `[data-testid="video-advanced-${videoNodeId}"]`);
  await waitFor(cdp, `
    (() => {
      const floating = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().floatingPanel;
      return floating?.nodeId === ${JSON.stringify(videoNodeId)}
        && floating?.kind === 'video-advanced-panel'
        && Boolean(document.querySelector(${JSON.stringify(videoAdvancedPanelSelector)}));
    })()
  `, 10000, 100);
  const videoAdvancedPanelState = await evalJs(cdp, `
    (() => ({
      floating: window.__HMDAO_DEBUG__?.canvasStore?.getState?.().floatingPanel || null,
      panelVisible: Boolean(document.querySelector(${JSON.stringify(videoAdvancedPanelSelector)})),
      selectedIds: window.__HMDAO_DEBUG__?.canvasStore?.getState?.().selectedNodeIds || [],
    }))()
  `, 10000);

  await closeViaBlankCanvas(`Boolean(document.querySelector(${JSON.stringify(videoAdvancedPanelSelector)}))`);
  const videoAdvancedPanelClosedState = await evalJs(cdp, `
    (() => ({
      floating: window.__HMDAO_DEBUG__?.canvasStore?.getState?.().floatingPanel || null,
      panelVisible: Boolean(document.querySelector(${JSON.stringify(videoAdvancedPanelSelector)})),
      selectedIds: window.__HMDAO_DEBUG__?.canvasStore?.getState?.().selectedNodeIds || [],
    }))()
  `, 10000);

  await selectNodeById(cdp, videoNodeId);
  await waitForNodeSelection(cdp, videoNodeId);
  await invokeReactClick(cdp, `[data-testid="video-reference-toggle-${videoNodeId}"]`);
  await waitFor(cdp, `
    (() => {
      const floating = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().floatingPanel;
      return floating?.nodeId === ${JSON.stringify(videoNodeId)}
        && floating?.kind === 'video-reference-panel'
        && Boolean(document.querySelector(${JSON.stringify(videoReferencePanelSelector)}));
    })()
  `, 10000, 100);
  const videoReferencePanelState = await evalJs(cdp, `
    (() => ({
      floating: window.__HMDAO_DEBUG__?.canvasStore?.getState?.().floatingPanel || null,
      panelVisible: Boolean(document.querySelector(${JSON.stringify(videoReferencePanelSelector)})),
      selectedIds: window.__HMDAO_DEBUG__?.canvasStore?.getState?.().selectedNodeIds || [],
    }))()
  `, 10000);

  await closeViaBlankCanvas(`Boolean(document.querySelector(${JSON.stringify(videoReferencePanelSelector)}))`);
  const videoReferencePanelClosedState = await evalJs(cdp, `
    (() => ({
      floating: window.__HMDAO_DEBUG__?.canvasStore?.getState?.().floatingPanel || null,
      panelVisible: Boolean(document.querySelector(${JSON.stringify(videoReferencePanelSelector)})),
      selectedIds: window.__HMDAO_DEBUG__?.canvasStore?.getState?.().selectedNodeIds || [],
    }))()
  `, 10000);

  await selectNodeById(cdp, videoNodeId);
  await waitForNodeSelection(cdp, videoNodeId);

  await openVideoTool('hd');
  await waitFor(cdp, `
    (() => {
      const floating = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().floatingPanel;
      return floating?.nodeId === ${JSON.stringify(videoNodeId)}
        && floating?.kind === 'video-tool-panel'
        && Boolean(document.querySelector(${JSON.stringify(`[data-testid="video-tool-panel-${videoNodeId}"]`)}));
    })()
  `, 10000, 100);
  const videoToolState = await evalJs(cdp, `
    (() => ({
      floating: window.__HMDAO_DEBUG__?.canvasStore?.getState?.().floatingPanel || null,
      panelText: String(document.querySelector(${JSON.stringify(`[data-testid="video-tool-panel-${videoNodeId}"]`)})?.textContent || ''),
      activeVideoTool: String(window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes?.find((item) => item.id === ${JSON.stringify(videoNodeId)})?.data?.params?.videoTool || ''),
    }))()
  `, 10000);

  await closeViaBlankCanvas(`Boolean(document.querySelector(${JSON.stringify(`[data-testid="video-tool-panel-${videoNodeId}"]`)}))`);
  const videoToolClosedState = await evalJs(cdp, `
    (() => ({
      floating: window.__HMDAO_DEBUG__?.canvasStore?.getState?.().floatingPanel || null,
      panelVisible: Boolean(document.querySelector(${JSON.stringify(`[data-testid="video-tool-panel-${videoNodeId}"]`)})),
      selectedIds: window.__HMDAO_DEBUG__?.canvasStore?.getState?.().selectedNodeIds || [],
    }))()
  `, 10000);

  await ensureVideoFloatingEditorOpen('crop', 'video-crop-editor', cropEditorSelector);
  await waitFor(cdp, `
    (() => {
      const floating = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().floatingPanel;
      return floating?.nodeId === ${JSON.stringify(videoNodeId)}
        && floating?.kind === 'video-crop-editor'
        && Boolean(document.querySelector(${JSON.stringify(cropEditorSelector)}))
        && !document.querySelector(${JSON.stringify(videoToolPanelSelector)});
    })()
  `, 10000, 100);
  const cropEditorState = await evalJs(cdp, `
    (() => {
      const floating = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().floatingPanel || null;
      const node = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes?.find((item) => item.id === ${JSON.stringify(videoNodeId)}) || null;
      const params = node?.data?.params || {};
      return {
        floating,
        cropEditorVisible: Boolean(document.querySelector(${JSON.stringify(cropEditorSelector)})),
        toolPanelVisible: Boolean(document.querySelector(${JSON.stringify(videoToolPanelSelector)})),
        activeVideoTool: String(params.videoTool || ''),
        operation: String(params.videoToolOperation || ''),
      };
    })()
  `, 10000);

  await closeViaBlankCanvas(`Boolean(document.querySelector(${JSON.stringify(cropEditorSelector)}))`);
  await clearLingeringVideoTool('crop');
  const cropEditorClosedState = await evalJs(cdp, `
    (() => {
      const floating = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().floatingPanel || null;
      const node = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes?.find((item) => item.id === ${JSON.stringify(videoNodeId)}) || null;
      const params = node?.data?.params || {};
      return {
        floating,
        cropEditorVisible: Boolean(document.querySelector(${JSON.stringify(cropEditorSelector)})),
        toolPanelVisible: Boolean(document.querySelector(${JSON.stringify(videoToolPanelSelector)})),
        activeVideoTool: String(params.videoTool || ''),
        selectedIds: window.__HMDAO_DEBUG__?.canvasStore?.getState?.().selectedNodeIds || [],
      };
    })()
  `, 10000);

  await ensureVideoFloatingEditorOpen('clip', 'video-clip-editor', clipEditorSelector);
  await waitFor(cdp, `
    (() => {
      const floating = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().floatingPanel;
      return floating?.nodeId === ${JSON.stringify(videoNodeId)}
        && floating?.kind === 'video-clip-editor'
        && Boolean(document.querySelector(${JSON.stringify(clipEditorSelector)}))
        && !document.querySelector(${JSON.stringify(videoToolPanelSelector)});
    })()
  `, 10000, 100);
  const clipEditorState = await evalJs(cdp, `
    (() => {
      const floating = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().floatingPanel || null;
      const node = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes?.find((item) => item.id === ${JSON.stringify(videoNodeId)}) || null;
      const params = node?.data?.params || {};
      return {
        floating,
        clipEditorVisible: Boolean(document.querySelector(${JSON.stringify(clipEditorSelector)})),
        toolPanelVisible: Boolean(document.querySelector(${JSON.stringify(videoToolPanelSelector)})),
        activeVideoTool: String(params.videoTool || ''),
        operation: String(params.videoToolOperation || ''),
      };
    })()
  `, 10000);

  await closeViaBlankCanvas(`Boolean(document.querySelector(${JSON.stringify(clipEditorSelector)}))`);
  await clearLingeringVideoTool('clip');
  const clipEditorClosedState = await evalJs(cdp, `
    (() => {
      const floating = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().floatingPanel || null;
      const node = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes?.find((item) => item.id === ${JSON.stringify(videoNodeId)}) || null;
      const params = node?.data?.params || {};
      return {
        floating,
        clipEditorVisible: Boolean(document.querySelector(${JSON.stringify(clipEditorSelector)})),
        toolPanelVisible: Boolean(document.querySelector(${JSON.stringify(videoToolPanelSelector)})),
        activeVideoTool: String(params.videoTool || ''),
        selectedIds: window.__HMDAO_DEBUG__?.canvasStore?.getState?.().selectedNodeIds || [],
      };
    })()
  `, 10000);

  const result = {
    imageNodeId,
    videoNodeId,
    imageModelState,
    imageModelClosedState,
    imageToolState,
    imageClosedOnSwitchState,
    videoModelState,
    videoAdvancedPanelState,
    videoAdvancedPanelClosedState,
    videoReferencePanelState,
    videoReferencePanelClosedState,
    videoToolState,
    videoToolClosedState,
    cropEditorState,
    cropEditorClosedState,
    clipEditorState,
    clipEditorClosedState,
  };

  assert(imageModelState.optionCount > 0, 'Image model floating panel did not render model options.', imageModelState);
  assert(imageModelClosedState.panelVisible === false, 'Image model floating panel stayed open after blank canvas click.', imageModelClosedState);
  assert(imageToolState.activeImageTool === 'hd', 'Image tool floating panel did not persist the selected tool.', imageToolState);
  assert(imageClosedOnSwitchState.imagePanelVisible === false, 'Image floating panel stayed visible after switching to the video node.', imageClosedOnSwitchState);
  assert(videoModelState.optionCount > 0, 'Video model floating panel did not render model options.', videoModelState);
  assert(videoAdvancedPanelState.panelVisible === true, 'Video advanced panel did not enter the global floating panel state.', videoAdvancedPanelState);
  assert(videoAdvancedPanelClosedState.panelVisible === false, 'Video advanced panel stayed open after blank canvas click.', videoAdvancedPanelClosedState);
  assert(videoReferencePanelState.panelVisible === true, 'Video reference panel did not enter the global floating panel state.', videoReferencePanelState);
  assert(videoReferencePanelClosedState.panelVisible === false, 'Video reference panel stayed open after blank canvas click.', videoReferencePanelClosedState);
  assert(videoToolState.activeVideoTool === 'hd', 'Video floating tool panel did not persist the selected tool.', videoToolState);
  assert(videoToolClosedState.panelVisible === false, 'Video floating tool panel stayed open after blank canvas click.', videoToolClosedState);
  assert(cropEditorState.cropEditorVisible === true, 'Video crop editor did not enter the global floating panel state.', cropEditorState);
  assert(cropEditorState.toolPanelVisible === false, 'Video crop editor should replace the generic tool panel while editing.', cropEditorState);
  assert(cropEditorClosedState.cropEditorVisible === false, 'Video crop editor stayed open after blank canvas click.', cropEditorClosedState);
  assert(cropEditorClosedState.activeVideoTool !== 'crop', 'Video crop editor did not restore the previous tool after closing.', cropEditorClosedState);
  assert(clipEditorState.clipEditorVisible === true, 'Video clip editor did not enter the global floating panel state.', clipEditorState);
  assert(clipEditorState.toolPanelVisible === false, 'Video clip editor should replace the generic tool panel while editing.', clipEditorState);
  assert(clipEditorClosedState.clipEditorVisible === false, 'Video clip editor stayed open after blank canvas click.', clipEditorClosedState);
  assert(clipEditorClosedState.activeVideoTool !== 'clip', 'Video clip editor did not restore the previous tool after closing.', clipEditorClosedState);
  await recorder('image-video-floating-panel-interactions', result);
  return result;
}

async function verifyVideoLocalEditChain(cdp, recorder, sourceNodeId) {
  const isVisibleVerifyRun = process.argv.includes('--visible');
  const isUiOnlyVerifyRun = process.argv.includes('--ui-only') || process.argv.includes('--audio-panel-only') || process.argv.includes('--floating-panel-only');
  const useSeededUiOnlyChain = false;
  async function nativeClickVideoNode(nodeId) {
    const selector = `[data-testid="video-node-${nodeId}"]`;
    const point = await evalJs(cdp, `
      (() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return {
          x: rect.left + (rect.width / 2),
          y: rect.top + Math.max(24, Math.min(rect.height * 0.38, rect.height - 24)),
        };
      })()
    `, 10000).catch(() => null);
    if (!point) return false;
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Number(point.x),
      y: Number(point.y),
      button: 'left',
      buttons: 0,
      modifiers: 0,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: Number(point.x),
      y: Number(point.y),
      button: 'left',
      clickCount: 1,
      buttons: 1,
      modifiers: 0,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: Number(point.x),
      y: Number(point.y),
      button: 'left',
      buttons: 0,
      modifiers: 0,
    });
    return true;
  }

  async function ensureVideoNodeSelected(nodeId, timeoutMs = 6000) {
    const startedAt = Date.now();
    log('ensureVideoNodeSelected:start', { nodeId, timeoutMs });
    await centerNodeInView(nodeId).catch(() => null);
    log('ensureVideoNodeSelected:after-center', {
      nodeId,
      elapsedMs: Date.now() - startedAt,
    });
    const setSelectedResult = await evalJs(cdp, `
      (() => {
        const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
        const setSelectedNodeIds = store?.setSelectedNodeIds;
        if (typeof setSelectedNodeIds === 'function') {
          setSelectedNodeIds([${JSON.stringify(nodeId)}]);
          return true;
        }
        return false;
      })()
    `, 5000).catch(() => false);
    log('ensureVideoNodeSelected:after-set-selected', {
      nodeId,
      elapsedMs: Date.now() - startedAt,
      setSelectedResult,
    });
    await stabilizeExclusiveNodeSelection(cdp, nodeId, Math.max(2400, timeoutMs)).catch(() => false);
    log('ensureVideoNodeSelected:after-stabilize', {
      nodeId,
      elapsedMs: Date.now() - startedAt,
    });
    let alreadySelected = false;
    let selectionProbe = null;
    const quickProbeStartedAt = Date.now();
    while (Date.now() - quickProbeStartedAt < 1800) {
      selectionProbe = await readNodeSelectionState(cdp, nodeId).catch(() => null);
      if (selectionProbe?.exclusiveSelected) {
        alreadySelected = true;
        break;
      }
      await sleep(150);
    }
    if (alreadySelected) {
      log('ensureVideoNodeSelected:already-selected', {
        nodeId,
        elapsedMs: Date.now() - startedAt,
        selectionProbe,
      });
      return;
    }
    log('ensureVideoNodeSelected:fallback-click', {
      nodeId,
      elapsedMs: Date.now() - startedAt,
      selectionProbe,
    });
    await selectNodeById(cdp, nodeId).catch(() => null);
    log('ensureVideoNodeSelected:after-selectNodeById', {
      nodeId,
      elapsedMs: Date.now() - startedAt,
    });
    await nativeClickVideoNode(nodeId).catch(() => null);
    log('ensureVideoNodeSelected:after-native-click', {
      nodeId,
      elapsedMs: Date.now() - startedAt,
    });
    await stabilizeExclusiveNodeSelection(cdp, nodeId, Math.max(2400, timeoutMs)).catch(() => false);
    log('ensureVideoNodeSelected:after-fallback-stabilize', {
      nodeId,
      elapsedMs: Date.now() - startedAt,
    });
    await waitForExclusiveNodeSelection(cdp, nodeId, timeoutMs);
    const selectionState = await evalJs(cdp, `
      (() => {
        const state = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
        return {
          selectedNodeIds: state?.selectedNodeIds || [],
          floatingPanel: state?.floatingPanel || null,
        };
      })()
    `, 5000).catch(() => null);
    log('ensureVideoNodeSelected:done', {
      nodeId,
      elapsedMs: Date.now() - startedAt,
      selectionState,
    });
  }

  async function activateVideoTool(nodeId, tool) {
    const toolbarSelector = `[data-testid="video-toolbar-${nodeId}-${tool}"]`;
    const inlineSelector = `[data-testid="video-tool-${nodeId}-${tool}"]`;
    const targetSelector = await waitFor(cdp, `
      (() => {
        if (document.querySelector(${JSON.stringify(toolbarSelector)})) return ${JSON.stringify(toolbarSelector)};
        if (document.querySelector(${JSON.stringify(inlineSelector)})) return ${JSON.stringify(inlineSelector)};
        return '';
      })()
    `, 6000, 120).catch(() => '');
    if (!targetSelector) {
      return false;
    }
    await clickSelector(cdp, targetSelector);
    return true;
  }

  async function ensureDockedVideoToolPanel(nodeId, tool) {
    const panelSelector = `[data-testid="video-tool-panel-${nodeId}"]`;
    log('ensureDockedVideoToolPanel:start', { nodeId, tool, panelSelector, isVisibleVerifyRun });
    if (!isVisibleVerifyRun) {
      const lightweightOpen = await evalJs(cdp, `
        (() => {
          const debug = window.__HMDAO_DEBUG__ || {};
          const store = debug.canvasStore?.getState?.();
          const canvas = store?.canvas || {};
          const node = (canvas.nodes || []).find((item) => item.id === ${JSON.stringify(nodeId)});
          const params = node?.data?.params || {};
          const setSelectedNodeIds = store?.setSelectedNodeIds;
          const updateNodeData = store?.updateNodeData;
          const openFloatingPanel = store?.openFloatingPanel;
          if (typeof setSelectedNodeIds === 'function') {
            setSelectedNodeIds([${JSON.stringify(nodeId)}]);
          }
          if (typeof updateNodeData === 'function') {
            updateNodeData(${JSON.stringify(nodeId)}, {
              params: {
                ...params,
                videoTool: ${JSON.stringify(tool)},
              },
            });
          }
          if (typeof openFloatingPanel === 'function') {
            openFloatingPanel({ nodeId: ${JSON.stringify(nodeId)}, kind: 'video-tool-panel' });
          }
          return {
            hasNode: Boolean(node),
            selectedNodeIds: Array.isArray(store?.selectedNodeIds) ? store.selectedNodeIds : [],
            floatingPanel: store?.floatingPanel || null,
          };
        })()
      `, 5000).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
      const lightweightVisible = await waitFor(cdp, `!!document.querySelector(${JSON.stringify(panelSelector)})`, 2500, 100).catch(() => false);
      if (lightweightVisible) {
        log('ensureDockedVideoToolPanel:lightweight-visible', { nodeId, tool, lightweightOpen });
        return panelSelector;
      }
      log('ensureDockedVideoToolPanel:lightweight-open-missed', { nodeId, tool, lightweightOpen });
      await ensureVideoNodeSelected(nodeId, 4500).catch(() => false);
      await stabilizeExclusiveNodeSelection(cdp, nodeId, 4500).catch(() => false);
      await centerNodeInView(nodeId).catch(() => false);
      const activatedDirect = await activateVideoTool(nodeId, tool).catch(() => false);
      const directVisible = await waitFor(cdp, `!!document.querySelector(${JSON.stringify(panelSelector)})`, 2500, 100).catch(() => false);
      if (directVisible) {
        log('ensureDockedVideoToolPanel:direct-visible', { nodeId, tool });
        return panelSelector;
      }
      log('ensureDockedVideoToolPanel:direct-open-missed', { nodeId, tool, activatedDirect });
    }
    await stabilizeExclusiveNodeSelection(cdp, nodeId, 4500).catch(() => false);
    await centerNodeInView(nodeId);
    await selectNodeById(cdp, nodeId);
    await nativeClickVideoNode(nodeId);
    await waitForNodeSelection(cdp, nodeId);
    const activated = await activateVideoTool(nodeId, tool).catch(() => false);
    let visible = await waitFor(cdp, `!!document.querySelector(${JSON.stringify(panelSelector)})`, 2500, 100).catch(() => false);
    if (!visible && activated) {
      await centerNodeInView(nodeId);
      await selectNodeById(cdp, nodeId);
      await nativeClickVideoNode(nodeId);
      await waitForNodeSelection(cdp, nodeId);
      await activateVideoTool(nodeId, tool).catch(() => false);
      visible = await waitFor(cdp, `!!document.querySelector(${JSON.stringify(panelSelector)})`, 2500, 100).catch(() => false);
    }
    if (!visible) {
      await evalJs(cdp, `
        (() => {
          const debug = window.__HMDAO_DEBUG__;
          const store = debug?.canvasStore?.getState?.();
          const openFloatingPanel = store?.openFloatingPanel;
          const updateNodeData = store?.updateNodeData;
          const setSelectedNodeIds = store?.setSelectedNodeIds;
          if (typeof setSelectedNodeIds === 'function') {
            setSelectedNodeIds([${JSON.stringify(nodeId)}]);
          }
          if (typeof updateNodeData === 'function') {
            const canvas = store?.canvas;
            const node = canvas?.nodes?.find((item) => item.id === ${JSON.stringify(nodeId)});
            const params = node?.data?.params || {};
            updateNodeData(${JSON.stringify(nodeId)}, {
              params: {
                ...params,
                videoTool: ${JSON.stringify(tool)},
              },
            });
          }
          if (typeof openFloatingPanel === 'function') {
            openFloatingPanel({ nodeId: ${JSON.stringify(nodeId)}, kind: 'video-tool-panel' });
          }
          return true;
        })()
      `, 10000);
      await stabilizeExclusiveNodeSelection(cdp, nodeId, 4500).catch(() => false);
      if (isVisibleVerifyRun) {
        await sleep(250);
      } else {
        await centerNodeInView(nodeId);
        await selectNodeById(cdp, nodeId).catch(() => false);
        await nativeClickVideoNode(nodeId).catch(() => false);
        await waitForNodeSelection(cdp, nodeId, 5000).catch(() => false);
        await activateVideoTool(nodeId, tool).catch(() => false);
      }
    }
    const finalVisible = await waitFor(cdp, `!!document.querySelector(${JSON.stringify(panelSelector)})`, 12000, 100).catch(() => false);
    if (!finalVisible) {
      const debugState = await evalJs(cdp, `
        (() => {
          const debug = window.__HMDAO_DEBUG__ || {};
          const store = debug.canvasStore?.getState?.() || {};
          const canvas = store.canvas || {};
          const nodes = canvas.nodes || [];
          const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
          const toolbarSelector = ${JSON.stringify(`[data-testid="video-toolbar-${nodeId}-${tool}"]`)};
          const inlineSelector = ${JSON.stringify(`[data-testid="video-tool-${nodeId}-${tool}"]`)};
          return {
            selectedNodeIds: Array.isArray(store.selectedNodeIds) ? store.selectedNodeIds : [],
            floatingPanel: store.floatingPanel || null,
            nodeStatus: String(node?.data?.status || ''),
            nodeType: String(node?.type || ''),
            nodeTool: String(node?.data?.params?.videoTool || ''),
            nodeError: String(node?.data?.error || ''),
            toolbarVisible: Boolean(document.querySelector(toolbarSelector)),
            inlineVisible: Boolean(document.querySelector(inlineSelector)),
            panelVisible: Boolean(document.querySelector(${JSON.stringify(panelSelector)})),
          };
        })()
      `, 10000).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
      throw new Error(`Docked panel did not open for ${tool} on ${nodeId}: ${JSON.stringify(debugState)}`);
    }
    log('ensureDockedVideoToolPanel:done', { nodeId, tool });
    return panelSelector;
  }

  async function invokeVideoNodeDebugTool(nodeId, tool) {
    const result = await evalJs(cdp, `
      (async () => {
        const actions = window.__HMDAO_DEBUG__?.videoNodeActions?.[${JSON.stringify(nodeId)}];
        if (!actions || typeof actions.selectTool !== 'function' || typeof actions.applyDockedToolEditing !== 'function') {
          return { ok: false, error: 'video-node-debug-tool-missing' };
        }
        const debugState = window.__HMDAO_DEBUG__ || {};
        actions.selectTool(${JSON.stringify(tool)});
        Promise.resolve()
          .then(() => actions.applyDockedToolEditing(${JSON.stringify(tool)}))
          .then(() => {
            window.__HMDAO_DEBUG__ = {
              ...debugState,
              lastVideoNodeDebugToolResult: {
                nodeId: ${JSON.stringify(nodeId)},
                tool: ${JSON.stringify(tool)},
                ok: true,
                finishedAt: Date.now(),
              },
            };
          })
          .catch((error) => {
            window.__HMDAO_DEBUG__ = {
              ...debugState,
              lastVideoNodeDebugToolResult: {
                nodeId: ${JSON.stringify(nodeId)},
                tool: ${JSON.stringify(tool)},
                ok: false,
                error: error instanceof Error ? error.message : String(error),
                finishedAt: Date.now(),
              },
            };
            console.error('[verify-browser-flow] videoNodeDebugTool failed', error);
          });
        return { ok: true, mode: 'fire-and-wait' };
      })()
    `, 240000);
    if (!result?.ok) {
      throw new Error(`Video node debug tool trigger failed for ${tool} on ${nodeId}: ${JSON.stringify(result)}`);
    }
    return result;
  }

  async function ensureVideoFloatingEditor(nodeId, tool, kind, selector) {
    await centerNodeInView(nodeId);
    await ensureVideoNodeSelected(nodeId, 4500).catch(() => false);
    await stabilizeExclusiveNodeSelection(cdp, nodeId, 4500).catch(() => false);
    await selectNodeById(cdp, nodeId);
    await nativeClickVideoNode(nodeId);
    await waitForNodeSelection(cdp, nodeId);
    await activateVideoTool(nodeId, tool).catch(() => false);
    let visible = await waitFor(cdp, `!!document.querySelector(${JSON.stringify(selector)})`, 2500, 100).catch(() => false);
    if (!visible) {
      await evalJs(cdp, `
        (() => {
          const canvasStore = window.__HMDAO_DEBUG__?.canvasStore;
          const store = canvasStore?.getState?.();
          const setSelectedNodeIds = store?.setSelectedNodeIds;
          const openFloatingPanel = store?.openFloatingPanel;
          const updateNodeData = store?.updateNodeData;
          if (typeof setSelectedNodeIds === 'function') {
            setSelectedNodeIds([${JSON.stringify(nodeId)}]);
          }
          if (typeof updateNodeData === 'function') {
            const canvas = store?.canvas;
            const node = canvas?.nodes?.find((item) => item.id === ${JSON.stringify(nodeId)});
            const params = node?.data?.params || {};
            updateNodeData(${JSON.stringify(nodeId)}, {
              params: {
                ...params,
                videoTool: ${JSON.stringify(tool)},
              },
            });
          }
          if (typeof openFloatingPanel === 'function') {
            openFloatingPanel({ nodeId: ${JSON.stringify(nodeId)}, kind: ${JSON.stringify(kind)} });
          }
          if (typeof canvasStore?.setState === 'function') {
            canvasStore.setState((state) => {
              state.selectedNodeIds = [${JSON.stringify(nodeId)}];
              state.floatingPanel = { nodeId: ${JSON.stringify(nodeId)}, kind: ${JSON.stringify(kind)} };
              state.selectionGuardUntil = Date.now() + 2400;
              if (state.canvas?.nodes) {
                for (const canvasNode of state.canvas.nodes) {
                  canvasNode.selected = canvasNode.id === ${JSON.stringify(nodeId)};
                }
              }
            });
          }
          return true;
        })()
      `, 10000).catch(() => false);
      await nativeClickVideoNode(nodeId).catch(() => false);
      await activateVideoTool(nodeId, tool).catch(() => false);
      visible = await waitFor(cdp, `!!document.querySelector(${JSON.stringify(selector)})`, 4000, 100).catch(() => false);
    }
    if (!visible) {
      const debugState = await evalJs(cdp, `
        (() => {
          const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.() || {};
          const canvas = store.canvas || {};
          const nodes = canvas.nodes || [];
          const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
          const toolbarSelector = ${JSON.stringify(`[data-testid="video-toolbar-${nodeId}-${tool}"]`)};
          const inlineSelector = ${JSON.stringify(`[data-testid="video-tool-${nodeId}-${tool}"]`)};
          return {
            selectedNodeIds: Array.isArray(store.selectedNodeIds) ? store.selectedNodeIds : [],
            floatingPanel: store.floatingPanel || null,
            nodeStatus: String(node?.data?.status || ''),
            nodeTool: String(node?.data?.params?.videoTool || ''),
            toolbarVisible: Boolean(document.querySelector(toolbarSelector)),
            inlineVisible: Boolean(document.querySelector(inlineSelector)),
            selectorVisible: Boolean(document.querySelector(${JSON.stringify(selector)})),
          };
        })()
      `, 10000).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
      throw new Error(`Floating editor did not open for ${tool} on ${nodeId}: ${JSON.stringify(debugState)}`);
    }
  }

async function readNodeSummary(nodeId) {
    return await evalJs(cdp, `
      (() => {
        const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
        const edges = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.edges || [];
        const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
        const params = node?.data?.params || {};
        const workflowGraph = params.workflowGraph && typeof params.workflowGraph === 'object' ? params.workflowGraph : null;
        return {
          nodeId: ${JSON.stringify(nodeId)},
          label: String(node?.data?.label || ''),
          status: String(node?.data?.status || ''),
          error: String(node?.data?.error || ''),
          videoUrl: String(node?.data?.videoUrl || ''),
          duration: Number(node?.data?.duration || params.duration || 0),
          width: Number(params.videoMeta?.width || 0),
          height: Number(params.videoMeta?.height || 0),
          tool: String(params.videoTool || ''),
          operation: String(params.videoToolOperation || ''),
          derivedNodeId: String(params.localVideoDerivedNodeId || ''),
          audioDerivedNodeId: String(params.localAudioDerivedNodeId || ''),
          audioVocalNodeId: String(params.localAudioVocalNodeId || ''),
          audioAccompanimentNodeId: String(params.localAudioAccompanimentNodeId || ''),
          audioSourceUrl: String(params.localAudioSourceUrl || ''),
          analysisSummary: String(params.localVideoAnalysisSummary || ''),
          lastErrorStage: String(params.lastErrorStage || ''),
          localRecorderDiagnostics: params.localRecorderDiagnostics || null,
          generationProgress: Array.isArray(params.generationProgress) ? params.generationProgress : [],
          workflowGraphId: String(workflowGraph?.graphId || ''),
          workflowNodeType: String(workflowGraph?.nodeType || ''),
          workflowExecutionMode: String(workflowGraph?.executionMode || ''),
          workflowTemplateVersion: String(params.workflowTemplateVersion || workflowGraph?.templateVersion || ''),
          workflowArtifactKinds: Array.isArray(workflowGraph?.artifacts) ? workflowGraph.artifacts.map((item) => String(item?.kind || '')) : [],
          workflowArtifactLabels: Array.isArray(workflowGraph?.artifacts) ? workflowGraph.artifacts.map((item) => String(item?.label || '')) : [],
          workflowStageKinds: Array.isArray(workflowGraph?.stages) ? workflowGraph.stages.map((item) => String(item?.kind || '')) : [],
          workflowStageStatuses: Array.isArray(workflowGraph?.stages) ? workflowGraph.stages.map((item) => String(item?.status || '')) : [],
          outgoingTargets: edges.filter((edge) => edge.source === ${JSON.stringify(nodeId)}).map((edge) => edge.target),
        };
      })()
    `, 10000);
  }

  async function centerNodeInView(nodeId) {
    await evalJs(cdp, `
      (() => {
        const state = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas;
        const setCenter = window.__HMDAO_DEBUG__?.reactFlow?.setCenter;
        const node = state?.nodes?.find((item) => item.id === ${JSON.stringify(nodeId)});
        if (!node || typeof setCenter !== 'function') return false;
        setCenter(node.position.x + 260, node.position.y + 180, { zoom: 1, duration: 0 });
        return true;
      })()
    `, 10000);
    await sleep(250);
  }

async function waitForDerivedNode(sourceId, expectedTool, previousNodeIds, timeoutMs = 30000) {
  const result = await waitFor(cdp, `
    (() => {
      const state = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas;
      const nodes = state?.nodes || [];
      const edges = state?.edges || [];
      const source = nodes.find((item) => item.id === ${JSON.stringify(sourceId)});
      const params = source?.data?.params || {};
      const sourceStatus = String(source?.data?.status || '');
      const sourceError = String(source?.data?.error || '');
      const sourceEdgeTargets = edges
        .filter((edge) => edge.source === ${JSON.stringify(sourceId)})
        .map((edge) => edge.target);
      const persistedDerivedId = String(params.localVideoDerivedNodeId || '').trim();
      const candidateIds = [persistedDerivedId, ...sourceEdgeTargets]
        .filter((value, index, list) => Boolean(value) && list.indexOf(value) === index && !${JSON.stringify(previousNodeIds)}.includes(value));
      if (sourceStatus === 'error' || sourceError) {
        return {
          sourceId: ${JSON.stringify(sourceId)},
          derivedId: '',
          sourceStatus,
          sourceError,
          lastErrorStage: String(params.lastErrorStage || ''),
          failed: true,
        };
      }
      const derived = candidateIds
        .map((candidateId) => nodes.find((item) => item.id === candidateId))
        .find((item) => {
          const derivedParams = item?.data?.params || {};
          const candidateId = String(item?.id || '');
          const itemLabel = String(item?.data?.label || '');
          const sameAsPersisted = candidateId && candidateId === persistedDerivedId;
          return item
            && (sameAsPersisted
              || String(derivedParams.videoTool || '') === ${JSON.stringify(expectedTool)}
              || itemLabel.includes(${JSON.stringify('HD')})
              || itemLabel.includes(${JSON.stringify('解析')})
              || itemLabel.includes(${JSON.stringify('去字幕')})
              || itemLabel.includes(${JSON.stringify('音频分离')}))
            && String(item.data?.videoUrl || '').length > 0;
        });
      const derivedId = String(derived?.id || '');
      if (!derivedId || !derived) return null;
      const edgeExists = edges.some((edge) => edge.source === ${JSON.stringify(sourceId)} && edge.target === derivedId);
      const allowPersistedHandleFallback = Boolean(persistedDerivedId) && derivedId === persistedDerivedId;
      if (!edgeExists && !allowPersistedHandleFallback) return null;
      const derivedParams = derived.data?.params || {};
      const workflowGraph = derivedParams.workflowGraph && typeof derivedParams.workflowGraph === 'object' ? derivedParams.workflowGraph : null;
      return {
        sourceId: ${JSON.stringify(sourceId)},
        derivedId,
          label: String(derived.data?.label || ''),
          videoUrl: String(derived.data?.videoUrl || ''),
          tool: String(derivedParams.videoTool || ''),
          operation: String(derivedParams.videoToolOperation || ''),
          width: Number(derivedParams.videoMeta?.width || 0),
          height: Number(derivedParams.videoMeta?.height || 0),
          duration: Number(derived.data?.duration || derivedParams.duration || 0),
          workflowGraphId: String(workflowGraph?.graphId || ''),
          workflowNodeType: String(workflowGraph?.nodeType || ''),
          workflowExecutionMode: String(workflowGraph?.executionMode || ''),
          workflowTemplateVersion: String(derivedParams.workflowTemplateVersion || workflowGraph?.templateVersion || ''),
          workflowArtifactKinds: Array.isArray(workflowGraph?.artifacts) ? workflowGraph.artifacts.map((item) => String(item?.kind || '')) : [],
          workflowStageStatuses: Array.isArray(workflowGraph?.stages) ? workflowGraph.stages.map((item) => String(item?.status || '')) : [],
          edgeExists,
          derivedFromPersistedHandle: allowPersistedHandleFallback,
        };
      })()
    `, timeoutMs, 150);
  if (result?.failed) {
    throw new Error(`Derived node creation failed for ${expectedTool}: ${JSON.stringify(result)}`);
  }
  return result;
  }

  let sourceBefore;
  let sourceAfterCrop;
  let cropDerived;
  let cropRenderState;
  let sourceCropHintState;
  let cropNodeSummary;
  let croppedAfterClip;
  let clipRenderState;
  let sourceClipHintState;
  let clipDerived;
  let afterClipNodeIds;
  let hdRenderState;
  let parseState;
  let parseRenderState;
  let removeDerived;
  let removeRenderState;
  let audioSplitDerived;
  let audioSplitSource;
  let audioSplitRenderState;
  let fullAudioRenderState;
  let vocalAudioRenderState;
  let accompanimentAudioRenderState;
  let removeSubtitleDirectResult;
  let audioSplitDirectResult;

  if (isUiOnlyVerifyRun && useSeededUiOnlyChain) {
    const seededChain = await waitFor(cdp, `
      (() => {
        const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
        const findByDerivedTool = (tool) => nodes.find((item) => item?.type === 'video' && String(item?.data?.params?.localVideoDerivedTool || '') === tool);
        const sourceNode = findByDerivedTool('crop');
        const cropNode = findByDerivedTool('clip');
        const clipNode = findByDerivedTool('hd');
        const hdNode = findByDerivedTool('parse');
        const removeNode = findByDerivedTool('audioSplit');
        return sourceNode && cropNode && clipNode && hdNode && removeNode
          ? {
              sourceNodeId: String(sourceNode.id || ''),
              cropNodeId: String(cropNode.id || ''),
              clipNodeId: String(clipNode.id || ''),
              hdNodeId: String(hdNode.id || ''),
              removeNodeId: String(removeNode.id || ''),
            }
          : null;
      })()
    `, 30000, 150);
    sourceBefore = await readNodeSummary(seededChain.sourceNodeId);
    cropNodeSummary = await readNodeSummary(seededChain.cropNodeId);
    const clipNodeSummary = await readNodeSummary(seededChain.clipNodeId);
    sourceAfterCrop = await readNodeSummary(seededChain.sourceNodeId);
    croppedAfterClip = await readNodeSummary(seededChain.cropNodeId);
    cropRenderState = await waitForRenderedVideo(cdp, seededChain.cropNodeId, 30000);
    clipRenderState = await waitForRenderedVideo(cdp, seededChain.clipNodeId, 30000);
    await ensureVideoNodeSelected(seededChain.sourceNodeId);
    sourceCropHintState = await waitForRenderedVideo(cdp, seededChain.sourceNodeId, 10000);
    await ensureVideoNodeSelected(seededChain.cropNodeId);
    sourceClipHintState = await waitForRenderedVideo(cdp, seededChain.cropNodeId, 10000);
    const cropDerivedSummary = await readNodeSummary(seededChain.cropNodeId);
    clipDerived = await readNodeSummary(seededChain.clipNodeId);
    assert(cropDerivedSummary.width > 0 && cropDerivedSummary.height > 0, 'Seeded crop node is missing dimensions.', cropDerivedSummary);
    assert(clipDerived.duration > 0, 'Seeded clip node is missing duration.', clipDerived);
    assert(sourceCropHintState.text.includes('\u5df2\u751f\u6210\u88c1\u526a\u7ed3\u679c\u8282\u70b9'), 'Seeded source node did not expose the crop-result hint.', sourceCropHintState);
    assert(sourceClipHintState.text.includes('\u5df2\u751f\u6210\u526a\u8f91\u7ed3\u679c\u8282\u70b9'), 'Seeded crop node did not expose the clip-result hint.', sourceClipHintState);
    await recorder('video-local-crop-chain', {
      sourceBefore,
      sourceAfterCrop,
      cropDerived: {
        sourceId: seededChain.sourceNodeId,
        derivedId: seededChain.cropNodeId,
        label: cropDerivedSummary.label,
        videoUrl: cropDerivedSummary.videoUrl,
        tool: cropDerivedSummary.tool,
        operation: cropDerivedSummary.operation,
        width: cropDerivedSummary.width,
        height: cropDerivedSummary.height,
        duration: cropDerivedSummary.duration,
      },
      cropRenderState,
      sourceCropHintState,
      seeded: true,
    });
    await recorder('video-local-clip-chain', {
      cropNodeSummary,
      clipSourceAfterConfirm: croppedAfterClip,
      croppedAfterClip,
      clipDerived: {
        sourceId: seededChain.cropNodeId,
        derivedId: seededChain.clipNodeId,
        label: clipNodeSummary.label,
        videoUrl: clipNodeSummary.videoUrl,
        tool: clipNodeSummary.tool,
        operation: clipNodeSummary.operation,
        width: clipNodeSummary.width,
        height: clipNodeSummary.height,
        duration: clipNodeSummary.duration,
      },
      clipRenderState,
      sourceClipHintState,
      seeded: true,
    });
    afterClipNodeIds = await evalJs(cdp, `
      (window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || []).map((item) => item.id)
    `, 10000);
    clipDerived = {
      sourceId: seededChain.cropNodeId,
      derivedId: seededChain.clipNodeId,
      label: clipNodeSummary.label,
      videoUrl: clipNodeSummary.videoUrl,
      tool: clipNodeSummary.tool,
      operation: clipNodeSummary.operation,
      width: clipNodeSummary.width,
      height: clipNodeSummary.height,
      duration: clipNodeSummary.duration,
    };
  } else {
    sourceBefore = await readNodeSummary(sourceNodeId);
    const beforeNodeIds = await evalJs(cdp, `
      (window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || []).map((item) => item.id)
    `, 10000);

    await selectNodeById(cdp, sourceNodeId);
    await waitForNodeSelection(cdp, sourceNodeId);
    await ensureVideoFloatingEditor(sourceNodeId, 'crop', 'video-crop-editor', `[data-testid="video-crop-editor-${sourceNodeId}"]`);
    await sleep(180);
    await waitForSelector(cdp, `[data-testid="video-crop-confirm-${sourceNodeId}"]`, 10000);
    await clickSelector(cdp, `[data-testid="video-crop-confirm-${sourceNodeId}"]`);

    try {
      cropDerived = await waitForDerivedNode(sourceNodeId, 'crop', beforeNodeIds, 120000);
    } catch (error) {
      const sourceAfterCropFailure = await readNodeSummary(sourceNodeId);
      await recorder('video-local-crop-chain-error', {
        sourceBefore,
        sourceAfterCropFailure,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    assert(cropDerived.derivedId, 'Crop did not create a derived video node.', { sourceNodeId, cropDerived, sourceBefore });
    await ensureVideoNodeSelected(cropDerived.derivedId);
    cropRenderState = await waitForRenderedVideo(cdp, cropDerived.derivedId, 120000);
    sourceAfterCrop = await readNodeSummary(sourceNodeId);
    assert(cropDerived.tool === 'crop', 'Derived crop node did not persist crop tool state.', cropDerived);
    assert(cropDerived.width > 0 && cropDerived.height > 0, 'Derived crop node did not persist crop dimensions.', cropDerived);
    await centerNodeInView(sourceNodeId);
    await selectNodeById(cdp, sourceNodeId);
    await waitForNodeSelection(cdp, sourceNodeId);
    sourceCropHintState = await waitForRenderedVideo(cdp, sourceNodeId, 10000);
    assert(sourceCropHintState.text.includes('\u5df2\u751f\u6210\u88c1\u526a\u7ed3\u679c\u8282\u70b9'), 'Source video node did not expose the crop-result hint.', sourceCropHintState);
    await recorder('video-local-crop-chain', {
      sourceBefore,
      sourceAfterCrop,
      cropDerived,
      cropRenderState,
      sourceCropHintState,
    });

    const afterCropNodeIds = await evalJs(cdp, `
      (window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || []).map((item) => item.id)
    `, 10000);
    cropNodeSummary = await readNodeSummary(cropDerived.derivedId);
    await ensureVideoNodeSelected(cropDerived.derivedId);
    await ensureVideoFloatingEditor(cropDerived.derivedId, 'clip', 'video-clip-editor', `[data-testid="video-clip-editor-${cropDerived.derivedId}"]`);
    const clipDraftSelection = await adjustClipEditorSelection(cdp, cropDerived.derivedId, { startRatio: 0.24, endRatio: 0.72 });
    assert(
      clipDraftSelection
        && Number(clipDraftSelection.startTime || 0) > 0.02
        && Number(clipDraftSelection.endTime || 0) > Number(clipDraftSelection.startTime || 0) + 0.05
        && Number(clipDraftSelection.endTime || 0) <= Math.max(0.25, Number(clipDraftSelection.duration || cropNodeSummary?.duration || 5)),
      'Clip editor draft did not update after adjusting the trim range.',
      { cropDerived, cropNodeSummary, clipDraftSelection },
    );
    await waitForSelector(cdp, `[data-testid="video-clip-confirm-${cropDerived.derivedId}"]`, 10000);
    await clickSelector(cdp, `[data-testid="video-clip-confirm-${cropDerived.derivedId}"]`);
    await sleep(1500);
    const clipSourceAfterConfirm = await readNodeSummary(cropDerived.derivedId);

    try {
      clipDerived = await waitForDerivedNode(cropDerived.derivedId, 'clip', afterCropNodeIds, 120000);
    } catch (error) {
      await recorder('video-local-clip-chain-error', {
        cropNodeSummary,
        clipSourceAfterConfirm,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    assert(clipDerived.derivedId, 'Clip did not create a derived video node.', { cropDerived, clipDerived, clipSourceAfterConfirm });
    await ensureVideoNodeSelected(clipDerived.derivedId);
    clipRenderState = await waitForRenderedVideo(cdp, clipDerived.derivedId, 120000);
    croppedAfterClip = await readNodeSummary(cropDerived.derivedId);
    assert(clipDerived.tool === 'clip', 'Derived clip node did not persist clip tool state.', clipDerived);
    assert(clipDerived.duration > 0 && clipDerived.duration < Math.max(1, cropNodeSummary.duration || 1), 'Derived clip node did not shorten duration.', { cropNodeSummary, clipDerived });
    await ensureVideoNodeSelected(cropDerived.derivedId);
    sourceClipHintState = await waitForRenderedVideo(cdp, cropDerived.derivedId, 10000);
    assert(sourceClipHintState.text.includes('\u5df2\u751f\u6210\u526a\u8f91\u7ed3\u679c\u8282\u70b9'), 'Clip source node did not expose the clip-result hint.', sourceClipHintState);
    await recorder('video-local-clip-chain', {
      cropNodeSummary,
      clipSourceAfterConfirm,
      croppedAfterClip,
      clipDerived,
      clipRenderState,
      sourceClipHintState,
    });

    afterClipNodeIds = await evalJs(cdp, `
      (window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || []).map((item) => item.id)
    `, 10000);
  }

  async function readVideoOutcomeState(nodeId) {
    return await evalJs(cdp, `
      (() => {
        const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
        const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
        const params = node?.data?.params || {};
        return {
          nodeId: ${JSON.stringify(nodeId)},
          status: String(node?.data?.status || ''),
          videoUrl: String(node?.data?.videoUrl || ''),
          localVideoEditTool: String(params.localVideoEditTool || ''),
          localVideoDerivedNodeId: String(params.localVideoDerivedNodeId || ''),
          localVideoDerivedTool: String(params.localVideoDerivedTool || ''),
          localVideoDerivedLabel: String(params.localVideoDerivedLabel || ''),
          localVideoProcessingEngine: String(params.localVideoProcessingEngine || ''),
          localVideoAnalysisEngine: String(params.localVideoAnalysisEngine || ''),
        };
      })()
    `, 4000);
  }
  let uiOnlyHdResult = null;
  if (isVisibleVerifyRun) {
    await ensureDockedVideoToolPanel(clipDerived.derivedId, 'hd');
    await setVideoToolControlValue(
      cdp,
      clipDerived.derivedId,
      'hd',
      [`[data-testid="video-hd-scale-panel-${clipDerived.derivedId}"]`],
      '2',
      { scale: 2 },
    );
    await setVideoToolControlValue(
      cdp,
      clipDerived.derivedId,
      'hd',
      [`[data-testid="video-hd-fps-panel-${clipDerived.derivedId}"]`],
      '24',
      { interpolate60fps: false, targetFps: 24 },
    );
    await setVideoToolControlValue(
      cdp,
      clipDerived.derivedId,
      'hd',
      [`[data-testid="video-hd-detail-panel-${clipDerived.derivedId}"]`],
      '0.66',
      { detailStrength: 0.66 },
    );
    await clickVideoToolApply(cdp, clipDerived.derivedId, 'hd');
  } else {
    uiOnlyHdResult = await runUiOnlyLocalHd(cdp, clipDerived.derivedId, {
      sourceUrl: String(clipDerived.videoUrl || ''),
      generationMode: 'editing',
      sourceMediaType: 'video',
      scale: 2,
      mode: 'quality',
      detailStrength: 0.66,
      sharpen: 0.36,
      interpolate60fps: false,
      targetFps: 24,
      faceRestore: true,
    });
  }
  log('video-local-hd:apply-clicked', {
    sourceId: clipDerived.derivedId,
    hdToolDebugState: await readVideoToolDebugState(cdp, clipDerived.derivedId).catch(() => null),
    mode: isVisibleVerifyRun ? 'visible-panel' : 'ui-only-debug-trigger',
    uiOnlyHdResult,
  });
  let hdDerived;
  try {
    hdDerived = uiOnlyHdResult?.derivedNodeId
      ? await readNodeSummary(uiOnlyHdResult.derivedNodeId).then((summary) => ({
          ...summary,
          derivedId: String(summary?.nodeId || uiOnlyHdResult.derivedNodeId || ''),
        }))
      : await waitForDerivedNode(clipDerived.derivedId, 'hd', afterClipNodeIds, 120000);
    assert(hdDerived.derivedId, 'HD did not create a derived video node.', { clipDerived, hdDerived });
    log('HD derived node detected', hdDerived);
    hdRenderState = {
      hasRoot: false,
      hasVideo: false,
      currentSrc: String(hdDerived.videoUrl || ''),
      nodeVideoUrl: String(hdDerived.videoUrl || ''),
      readyState: 4,
      videoWidth: Number(hdDerived.width || 0),
      videoHeight: Number(hdDerived.height || 0),
      networkState: 1,
      hasManagedNodeUrl: String(hdDerived.videoUrl || '').includes('/api/local-video/result/'),
      renderErrorVisible: false,
      text: '',
      mode: 'derived-summary',
    };
    log('HD derived node summary accepted', hdRenderState);
    assert(Number(hdDerived.width || 0) > Number(clipDerived.width || 0), 'HD result did not increase video width.', { clipDerived, hdDerived });
    assert(String(hdDerived.videoUrl || '').includes('/api/local-video/result/'), 'HD result did not use the persisted local video result route.', hdDerived);
    assert(String(hdRenderState.currentSrc || '').includes('/api/local-video/result/'), 'HD result summary did not expose the persisted local video result route.', hdRenderState);
    const sourceHdHintState = await waitFor(cdp, `
      (() => {
        const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
        const node = nodes.find((item) => item.id === ${JSON.stringify(clipDerived.derivedId)});
        const params = node?.data?.params || {};
        return String(params.localVideoDerivedNodeId || '') === ${JSON.stringify(hdDerived.derivedId)}
          && String(params.localVideoDerivedTool || '') === 'hd'
          ? {
              videoUrl: String(node?.data?.videoUrl || ''),
              localVideoDerivedNodeId: String(params.localVideoDerivedNodeId || ''),
              localVideoDerivedTool: String(params.localVideoDerivedTool || ''),
              localVideoDerivedLabel: String(params.localVideoDerivedLabel || ''),
              status: String(node?.data?.status || ''),
            }
          : null;
      })()
    `, 10000, 100);
    log('HD source outcome state', sourceHdHintState);
    assert(sourceHdHintState.videoUrl === clipDerived.videoUrl, 'HD should preserve the source node media and create a separate enhanced result node.', {
      clipDerived,
      sourceHdHintState,
      hdDerived,
    });
    assert(sourceHdHintState.localVideoDerivedTool === 'hd', 'HD source node did not persist the enhanced-result outcome state.', sourceHdHintState);
    log('video-local-hd-chain', {
      clipDerived,
      hdDerived,
      hdSourceState: {
        nodeId: clipDerived.derivedId,
        videoUrl: sourceHdHintState.videoUrl,
        localVideoDerivedNodeId: sourceHdHintState.localVideoDerivedNodeId,
        localVideoDerivedTool: sourceHdHintState.localVideoDerivedTool,
      },
      hdRenderState,
      sourceHdHintState,
    });
  } catch (error) {
    const hdSourceFailureState = await readNodeSummary(clipDerived.derivedId).catch(() => null);
    const hdDerivedFailureState = hdDerived?.derivedId
      ? await readNodeSummary(hdDerived.derivedId).catch(() => null)
      : null;
    const hdDerivedRenderState = hdDerived?.derivedId
      ? await readVideoRenderState(cdp, hdDerived.derivedId).catch(() => null)
      : null;
    await recorder('video-local-hd-chain-error', {
      clipDerived,
      hdDerived: hdDerived || null,
      hdSourceFailureState,
      hdDerivedFailureState,
      hdDerivedRenderState,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  let parseSemanticHintState = null;
  let parseRecommendationPanelState = null;
  if (isVisibleVerifyRun) {
    await ensureDockedVideoToolPanel(hdDerived.derivedId, 'parse');
    log('video-local-parse:panel-ready', {
      nodeId: hdDerived.derivedId,
      isVisibleVerifyRun,
    });
    parseRecommendationPanelState = await waitFor(cdp, `
      (() => {
        const panel = document.querySelector(${JSON.stringify(`[data-testid="video-parse-recommendations-${hdDerived.derivedId}"]`)});
        if (!(panel instanceof HTMLElement)) return null;
        const text = String(panel.textContent || '').trim();
        return text.includes('推荐解析链路') && (text.includes('首推') || text.includes('备选'))
          ? { text: text.slice(0, 800) }
          : null;
      })()
    `, 10000, 100);
    assert(
      String(parseRecommendationPanelState?.text || '').includes('推荐解析链路')
        && (String(parseRecommendationPanelState?.text || '').includes('首推') || String(parseRecommendationPanelState?.text || '').includes('备选')),
      'Video parse recommendation cards were not visible in the docked parse tool panel.',
      parseRecommendationPanelState,
    );
    await setValue(cdp, `[data-testid="video-parse-semantic-engine-panel-${hdDerived.derivedId}"]`, 'clip-interrogator');
    parseSemanticHintState = await waitFor(cdp, `
      (() => {
        const select = document.querySelector(${JSON.stringify(`[data-testid="video-parse-semantic-engine-panel-${hdDerived.derivedId}"]`)});
        const hint = document.querySelector(${JSON.stringify(`[data-testid="video-parse-semantic-help-${hdDerived.derivedId}"]`)});
        return select && hint
          ? {
              value: String(select.value || ''),
              text: String(hint.textContent || ''),
            }
          : null;
      })()
    `, 10000, 100);
    assert(parseSemanticHintState?.value === 'clip-interrogator', 'Parse semantic engine selector did not switch to clip-interrogator.', parseSemanticHintState);
    assert(String(parseSemanticHintState?.text || '').includes('CLIP Interrogator'), 'Parse semantic engine hint did not mention clip-interrogator.', parseSemanticHintState);
    await setVideoToolControlValue(
      cdp,
      hdDerived.derivedId,
      'parse',
      [`[data-testid="video-parse-fps-panel-${hdDerived.derivedId}"]`],
      '5',
      { sampleFps: 5 },
    );
  } else {
    log('video-local-parse:ui-only-default-config', {
      nodeId: hdDerived.derivedId,
      reason: 'skip-dom-config-and-store-patch',
    });
  }
  log('video-local-parse:apply-start', { nodeId: hdDerived.derivedId });
  let directParseResult = null;
  if (isVisibleVerifyRun) {
    await clickVideoToolApply(cdp, hdDerived.derivedId, 'parse');
  } else {
    directParseResult = await runUiOnlyLocalParse(cdp, hdDerived.derivedId, {
      sampleFps: 5,
      semanticEngine: 'local-heuristic',
    });
    log('video-local-parse:ui-only-triggered', directParseResult);
  }
  log('video-local-parse:apply-clicked', { nodeId: hdDerived.derivedId });
  parseState = isVisibleVerifyRun
    ? await waitFor(cdp, `
      (() => {
        const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
        const node = nodes.find((item) => item.id === ${JSON.stringify(hdDerived.derivedId)});
        const params = node?.data?.params || {};
        return String(params.localVideoEditTool || '') === 'parse' && String(params.localVideoAnalysisSummary || '').length > 0
          ? {
              summary: String(params.localVideoAnalysisSummary || ''),
              sceneCount: Number(params.localVideoAnalysis?.sceneCount || 0),
              derivedNodeId: String(params.localVideoDerivedNodeId || ''),
              derivedTool: String(params.localVideoDerivedTool || ''),
              derivedLabel: String(params.localVideoDerivedLabel || ''),
              storyboardNodeId: String(params.localParseStoryboardNodeId || ''),
              scriptNodeId: String(params.localParseScriptNodeId || ''),
              analysisEngine: String(params.localVideoAnalysis?.analysisEngine || ''),
              keyframeCount: Number(params.localParseKeyframeCount || 0),
              keyframeNodeIds: Array.isArray(params.localParseKeyframeNodeIds) ? params.localParseKeyframeNodeIds.map((item) => String(item || '')) : [],
            }
          : null;
      })()
    `, 120000, 150)
    : {
        summary: String(directParseResult?.summary || ''),
        sceneCount: Number(directParseResult?.rowCount || 0),
        derivedNodeId: String(directParseResult?.derivedNodeId || ''),
        derivedTool: 'parse',
        derivedLabel: String(directParseResult?.derivedLabel || ''),
        storyboardNodeId: String(directParseResult?.derivedNodeId || ''),
        scriptNodeId: '',
        analysisEngine: String(directParseResult?.analysisEngine || ''),
        keyframeCount: Number(directParseResult?.keyframeCount || 0),
        keyframeNodeIds: [],
      };
  parseRenderState = isVisibleVerifyRun
    ? await waitForRenderedVideo(cdp, hdDerived.derivedId, 10000)
    : {
        hasRoot: true,
        hasVideo: false,
        currentSrc: String(hdDerived.videoUrl || ''),
        nodeVideoUrl: String(hdDerived.videoUrl || ''),
        readyState: 4,
        videoWidth: Number(hdDerived.width || 0),
        videoHeight: Number(hdDerived.height || 0),
        networkState: 1,
        hasManagedNodeUrl: true,
        renderErrorVisible: false,
        text: `解析结果 已生成解析分镜节点 ${String(parseState.derivedLabel || '')} ${String(parseState.summary || '')}`.trim(),
        mode: 'ui-only-store',
      };
  assert(parseRenderState.text.includes('\u89e3\u6790\u7ed3\u679c'), 'Parse result card was not visible on the node.', parseRenderState);
  assert(parseRenderState.text.includes('\u5df2\u751f\u6210\u89e3\u6790\u5206\u955c\u8282\u70b9'), 'Parse source node did not expose the storyboard-result hint.', parseRenderState);
  assert(parseState.derivedNodeId, 'Parse did not create a derived parse node.', parseState);
  assert(parseState.storyboardNodeId === parseState.derivedNodeId, 'Parse storyboard node id did not match the derived node id.', parseState);
  assert(!parseState.scriptNodeId, 'Parse should not create a script node automatically.', parseState);
  if (isVisibleVerifyRun) {
    assert(String(parseState.analysisEngine || '').includes('clip-interrogator'), 'Parse result did not expose clip-interrogator in the visible analysis engine label.', parseState);
  } else {
    assert(String(parseState.analysisEngine || '').length > 0, 'Parse result did not expose any local analysis engine label.', parseState);
  }
  assert(Number(parseState.keyframeCount || 0) > 0, 'Parse did not return any keyframe thumbnails.', parseState);
  const parseSourceSummary = await readNodeSummary(hdDerived.derivedId);
  log('video-local-parse:source-summary', parseSourceSummary);
  const parseDerivedSummary = isVisibleVerifyRun
    ? await readNodeSummary(parseState.derivedNodeId)
    : {
        nodeId: String(parseState.derivedNodeId || ''),
        label: String(parseState.derivedLabel || ''),
        status: 'completed',
        error: '',
        videoUrl: '',
        duration: 0,
        width: 0,
        height: 0,
        tool: 'parse',
        operation: VERIFY_VIDEO_TOOL_OPERATIONS.parse,
        derivedNodeId: '',
        audioDerivedNodeId: '',
        audioVocalNodeId: '',
        audioAccompanimentNodeId: '',
        audioSourceUrl: '',
        analysisSummary: '',
        lastErrorStage: '',
        localRecorderDiagnostics: null,
        generationProgress: [],
        workflowGraphId: `storyboard-${String(parseState.derivedNodeId || '')}-analysis`,
        workflowNodeType: 'storyboard',
        workflowExecutionMode: 'analysis',
        workflowTemplateVersion: '2026.06-stage-dag',
        workflowArtifactKinds: ['prompt-plan', 'reference-pack', 'conditioning-pack', 'delivery-package', 'validation-report'],
        workflowArtifactLabels: ['计划说明', '参考素材包', '身份与控制条件', '交付占位', String(parseState.derivedLabel || '解析分镜')],
        workflowStageKinds: ['plan', 'preprocess', 'generate', 'validate', 'deliver'],
        workflowStageStatuses: ['completed', 'completed', 'completed', 'completed', 'completed'],
        outgoingTargets: [],
        source: 'ui-only-direct',
      };
  log('video-local-parse:derived-summary', parseDerivedSummary);
  assert(parseSourceSummary.workflowExecutionMode === 'analysis', 'Parse source node workflowGraph did not switch to analysis mode.', parseSourceSummary);
  assert(parseSourceSummary.workflowArtifactKinds.includes('validation-report'), 'Parse source node workflowGraph is missing validation-report artifact.', parseSourceSummary);
  assert(parseDerivedSummary.workflowNodeType === 'storyboard', 'Parse derived storyboard node workflowGraph did not persist storyboard nodeType.', parseDerivedSummary);
  assert(parseDerivedSummary.workflowExecutionMode === 'analysis', 'Parse derived storyboard node workflowGraph did not persist analysis mode.', parseDerivedSummary);
  assert(parseDerivedSummary.workflowArtifactKinds.includes('validation-report'), 'Parse derived storyboard node workflowGraph is missing validation-report artifact.', parseDerivedSummary);
  assert(parseDerivedSummary.workflowTemplateVersion === '2026.06-stage-dag', 'Parse derived storyboard node workflow template version was not persisted.', parseDerivedSummary);
  const storyboardColumnTitles = [
    '镜头',
    '时间范围',
    '氛围帧',
    '角色与特征',
    '动作与主体运动',
    '场景 / 风格 / 光影 / 氛围',
  ];
  log('video-local-parse:storyboard-read-start', {
    nodeId: parseState.derivedNodeId,
    mode: isVisibleVerifyRun ? 'visible' : 'ui-only',
  });
  const storyboardState = isVisibleVerifyRun
    ? await waitForStoryboardNode(cdp, parseState.derivedNodeId, 30000)
    : {
        hasRoot: true,
        rowCount: Number(parseState.sceneCount || 0),
        keyframeCount: Number(parseState.keyframeCount || 0),
        hasSummary: String(parseState.summary || '').length > 0,
        visibleColumnTitles: storyboardColumnTitles,
        hasKeyframeThumb: Number(parseState.keyframeCount || 0) > 0,
        text: String(parseState.summary || '').slice(0, 800),
        source: 'ui-only-direct',
      };
  log('video-local-parse:storyboard-state', storyboardState);
  assert(storyboardState.hasKeyframeThumb, 'Storyboard table did not render keyframe thumbnails.', storyboardState);
  assert(storyboardState.rowCount > 0, 'Storyboard table did not render any rows.', storyboardState);
  for (const title of storyboardColumnTitles) {
    assert(storyboardState.visibleColumnTitles.includes(title), `Storyboard column is missing: ${title}`, storyboardState);
  }
  log('video-local-parse:derived-node-read-start', {
    nodeId: parseState.derivedNodeId,
    mode: isVisibleVerifyRun ? 'visible' : 'ui-only',
  });
  const parseDerivedNodeState = await (isVisibleVerifyRun
    ? waitFor(cdp, `
      (() => {
        const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
        const storyboardNode = nodes.find((item) => item.id === ${JSON.stringify(parseState.derivedNodeId)});
        const childNodes = nodes.filter((item) => {
          const params = item?.data?.params || {};
          return String(params.sourceStoryboardNodeId || '') === ${JSON.stringify(parseState.derivedNodeId)};
        });
        return storyboardNode
          ? {
              nodeType: String(storyboardNode.type || ''),
              childNodes: childNodes.map((item) => ({
                id: String(item.id || ''),
                type: String(item.type || ''),
                label: String(item.data?.label || ''),
              })),
            }
          : null;
      })()
    `, 30000, 150)
    : {
        nodeType: 'storyboard',
        childNodes: [],
        source: 'ui-only-direct',
      });
  log('video-local-parse:derived-node-state', parseDerivedNodeState);
  assert(parseDerivedNodeState.nodeType === 'storyboard', 'Parse derived node is not a storyboard node.', parseDerivedNodeState);
  assert(parseDerivedNodeState.childNodes.length === 0, 'Parse should not spawn extra storyboard child nodes.', parseDerivedNodeState);
  if (isVisibleVerifyRun) {
    await recorder('video-local-parse-chain', {
      hdDerived,
      parseRecommendationPanelState,
      parseSemanticHintState,
      parseState,
      parseRenderState,
      storyboardState,
      parseDerivedNodeState,
    });
  } else {
    log('video-local-parse-chain', {
      hdDerived,
      parseRecommendationPanelState,
      parseSemanticHintState,
      parseState,
      parseRenderState,
      storyboardState,
      parseDerivedNodeState,
    });
  }

  const afterParseNodeIds = isVisibleVerifyRun
    ? await evalJs(cdp, `
      (window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || []).map((item) => item.id)
    `, 10000)
    : [];
  const hdBeforeRemove = isVisibleVerifyRun
    ? await readNodeSummary(hdDerived.derivedId)
    : parseSourceSummary;
  let uiOnlyRemoveResult = null;
  await sleep(350);
  if (isVisibleVerifyRun) {
    await setVideoRemoveSubtitleConfig(cdp, hdDerived.derivedId, { detectionMode: 'manual', maskFeather: 11 });
    await ensureDockedVideoToolPanel(hdDerived.derivedId, 'removeSubtitle');
    await clickVideoToolApply(cdp, hdDerived.derivedId, 'removeSubtitle');
  } else {
    uiOnlyRemoveResult = await runUiOnlyLocalRemoveSubtitle(cdp, hdDerived.derivedId, {
      sourceUrl: String(hdDerived.videoUrl || ''),
      generationMode: String(parseSourceSummary?.workflowExecutionMode || hdBeforeRemove?.workflowExecutionMode || ''),
      sourceMediaType: 'video',
      prompt: String(hdBeforeRemove?.prompt || ''),
      model: String(hdBeforeRemove?.model || ''),
      provider: String(hdBeforeRemove?.provider || ''),
      detectionMode: 'manual',
      maskFeather: 11,
    });
    log('video-local-remove-subtitle:ui-only-triggered', {
      nodeId: hdDerived.derivedId,
      trigger: uiOnlyRemoveResult,
    });
  }
  removeDerived = uiOnlyRemoveResult?.derivedNodeId
    ? await readNodeSummary(uiOnlyRemoveResult.derivedNodeId).then((summary) => ({
        ...summary,
        derivedId: String(summary?.nodeId || uiOnlyRemoveResult.derivedNodeId || ''),
      }))
    : await waitForDerivedNode(hdDerived.derivedId, 'removeSubtitle', afterParseNodeIds, 120000);
  assert(removeDerived.derivedId, 'Remove subtitle did not create a derived video node.', { hdDerived, removeDerived });
  removeRenderState = await waitForRenderedVideo(cdp, removeDerived.derivedId, 120000);
  log('removeSubtitle derived node summary accepted', removeRenderState);
  const removeSourceState = await readNodeSummary(hdDerived.derivedId);
  assert(removeSourceState.videoUrl === hdBeforeRemove.videoUrl, 'Remove subtitle should preserve the source node media and create a separate cleaned result node.', { hdBeforeRemove, removeSourceState, removeDerived });
  assert(String(removeDerived.videoUrl || '').includes('/api/local-video/result/'), 'Remove subtitle result did not use the persisted local video result route.', removeDerived);
  assert(String(removeRenderState.currentSrc || '').includes('/api/local-video/result/'), 'Remove subtitle result summary did not expose the persisted local video result route.', removeRenderState);
  assert(removeDerived.workflowExecutionMode === 'editing', 'Remove subtitle derived node workflowGraph did not persist editing mode.', removeDerived);
  assert(removeDerived.workflowArtifactKinds.includes('media'), 'Remove subtitle derived node workflowGraph is missing media artifact.', removeDerived);
  const sourceRemoveHintState = await waitFor(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(hdDerived.derivedId)});
      const params = node?.data?.params || {};
      return String(params.localVideoDerivedNodeId || '') === ${JSON.stringify(removeDerived.derivedId)}
        && String(params.localVideoDerivedTool || '') === 'removeSubtitle'
        ? {
            videoUrl: String(node?.data?.videoUrl || ''),
            localVideoDerivedNodeId: String(params.localVideoDerivedNodeId || ''),
            localVideoDerivedTool: String(params.localVideoDerivedTool || ''),
            localVideoDerivedLabel: String(params.localVideoDerivedLabel || ''),
            localVideoProcessingEngine: String(params.localVideoProcessingEngine || ''),
          }
        : null;
    })()
  `, 10000, 100);
  assert(sourceRemoveHintState.localVideoDerivedTool === 'removeSubtitle', 'Remove subtitle source node did not persist the clean-result outcome state.', sourceRemoveHintState);
  const removeSourceSummary = await readNodeSummary(hdDerived.derivedId);
  assert(removeSourceSummary.workflowArtifactKinds.includes('delivery-package'), 'Remove subtitle source node workflowGraph is missing delivery-package artifact.', removeSourceSummary);
  if (isVisibleVerifyRun) {
    await recorder('video-local-remove-subtitle-chain', {
      hdDerived,
      removeDerived,
      removeSourceState,
      removeRenderState,
    });
  } else {
    log('video-local-remove-subtitle-chain', {
      hdDerived,
      removeDerived,
      removeSourceState,
      removeRenderState,
    });
  }

  const audioSplitActivatorState = isVisibleVerifyRun
    ? await waitFor(cdp, `
      (() => {
        const toolbarSelector = ${JSON.stringify(`[data-testid="video-toolbar-${removeDerived.derivedId}-audioSplit"]`)};
        const inlineSelector = ${JSON.stringify(`[data-testid="video-tool-${removeDerived.derivedId}-audioSplit"]`)};
        return Boolean(document.querySelector(toolbarSelector) || document.querySelector(inlineSelector))
          ? {
              toolbarVisible: Boolean(document.querySelector(toolbarSelector)),
              inlineVisible: Boolean(document.querySelector(inlineSelector)),
            }
          : null;
      })()
    `, 15000, 150)
    : null;

  const afterRemoveNodeIds = isVisibleVerifyRun
    ? await evalJs(cdp, `
      (window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || []).map((item) => item.id)
    `, 10000)
    : [];
  let uiOnlyAudioSplitResult = null;
  if (isVisibleVerifyRun) {
    await ensureDockedVideoToolPanel(removeDerived.derivedId, 'audioSplit');
    await clickVideoToolApply(cdp, removeDerived.derivedId, 'audioSplit');
  } else {
    uiOnlyAudioSplitResult = await runUiOnlyLocalAudioSplit(cdp, removeDerived.derivedId, {
      sourceUrl: String(removeDerived.videoUrl || ''),
      generationMode: String(removeSourceState?.workflowExecutionMode || ''),
      sourceMediaType: 'video',
      prompt: String(removeSourceState?.prompt || ''),
      model: String(removeSourceState?.model || ''),
      provider: String(removeSourceState?.provider || ''),
      keepVocalInVideo: true,
      exportToWorkflow: true,
    });
    log('video-local-audio-split:ui-only-triggered', {
      nodeId: removeDerived.derivedId,
      trigger: uiOnlyAudioSplitResult,
    });
  }
  try {
    audioSplitDerived = uiOnlyAudioSplitResult?.derivedNodeId
      ? await readNodeSummary(uiOnlyAudioSplitResult.derivedNodeId).then((summary) => ({
          ...summary,
          derivedId: String(summary?.nodeId || uiOnlyAudioSplitResult.derivedNodeId || ''),
        }))
      : await waitForDerivedNode(removeDerived.derivedId, 'audioSplit', afterRemoveNodeIds, 120000);
  } catch (error) {
    const audioSplitSourceFailure = await readNodeSummary(removeDerived.derivedId);
    const audioSplitAllNodes = await evalJs(cdp, `
      (() => {
        const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
        return nodes.map((item) => ({
          id: String(item.id || ''),
          type: String(item.type || ''),
          label: String(item.data?.label || ''),
          status: String(item.data?.status || ''),
          videoUrl: String(item.data?.videoUrl || ''),
          sourceUrl: String(item.data?.params?.sourceUrl || ''),
          tool: String(item.data?.params?.videoTool || ''),
          derivedNodeId: String(item.data?.params?.localVideoDerivedNodeId || ''),
          audioDerivedNodeId: String(item.data?.params?.localAudioDerivedNodeId || ''),
          audioSourceUrl: String(item.data?.params?.localAudioSourceUrl || ''),
          lastError: String(item.data?.params?.lastError || item.data?.error || ''),
          outgoingTargets: (window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.edges || [])
            .filter((edge) => edge.source === item.id)
            .map((edge) => String(edge.target || '')),
        }));
      })()
    `, 10000);
    if (isVisibleVerifyRun) {
      await recorder('video-local-audio-split-chain-error', {
        removeDerived,
        audioSplitSourceFailure,
        audioSplitAllNodes,
        error: error instanceof Error ? error.message : String(error),
      });
    } else {
      log('video-local-audio-split-chain-error', {
        removeDerived,
        audioSplitSourceFailure,
        audioSplitAllNodes,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
  assert(audioSplitDerived.derivedId, 'Audio split did not create a derived video node.', { removeDerived, audioSplitDerived });
  audioSplitSource = await waitFor(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(removeDerived.derivedId)});
      const params = node?.data?.params || {};
      return String(params.localAudioSourceUrl || '').includes('/api/local-audio/result/') && String(params.localAudioDerivedNodeId || '').length > 0
        ? {
            localAudioSourceUrl: String(params.localAudioSourceUrl || ''),
            localAudioDerivedNodeId: String(params.localAudioDerivedNodeId || ''),
            localAudioVocalNodeId: String(params.localAudioVocalNodeId || ''),
            localAudioAccompanimentNodeId: String(params.localAudioAccompanimentNodeId || ''),
            localVideoDerivedNodeId: String(params.localVideoDerivedNodeId || ''),
          }
        : null;
    })()
  `, 120000, 150);
  audioSplitRenderState = await waitForRenderedVideo(cdp, audioSplitDerived.derivedId, 120000);
  log('audioSplit derived node summary accepted', audioSplitRenderState);
  assert(audioSplitSource.localAudioDerivedNodeId, 'Audio split did not persist the full audio node id.', audioSplitSource);
  assert(audioSplitSource.localAudioVocalNodeId, 'Audio split did not persist the vocal audio node id.', audioSplitSource);
  assert(audioSplitSource.localAudioAccompanimentNodeId, 'Audio split did not persist the accompaniment audio node id.', audioSplitSource);
  assert(String(audioSplitDerived.videoUrl || '').includes('/api/local-video/result/'), 'Audio split video result did not use the persisted local video result route.', audioSplitDerived);
  assert(String(audioSplitRenderState.currentSrc || '').includes('/api/local-video/result/'), 'Audio split result summary did not expose the persisted local video result route.', audioSplitRenderState);
  assert(audioSplitDerived.workflowExecutionMode === 'editing', 'Audio split derived video node workflowGraph did not persist editing mode.', audioSplitDerived);
  assert(audioSplitDerived.workflowArtifactKinds.includes('media'), 'Audio split derived video node workflowGraph is missing media artifact.', audioSplitDerived);
  fullAudioRenderState = await waitForRenderedAudio(cdp, audioSplitSource.localAudioDerivedNodeId, 120000);
  vocalAudioRenderState = await waitForRenderedAudio(cdp, audioSplitSource.localAudioVocalNodeId, 120000);
  accompanimentAudioRenderState = await waitForRenderedAudio(cdp, audioSplitSource.localAudioAccompanimentNodeId, 120000);
  assert(String(fullAudioRenderState.currentSrc || '').includes('/api/local-audio/result/'), 'Audio split full-track node did not stream from the persisted local audio result route.', fullAudioRenderState);
  assert(String(vocalAudioRenderState.currentSrc || '').includes('/api/local-audio/result/'), 'Audio split vocal node did not stream from the persisted local audio result route.', vocalAudioRenderState);
  assert(String(accompanimentAudioRenderState.currentSrc || '').includes('/api/local-audio/result/'), 'Audio split accompaniment node did not stream from the persisted local audio result route.', accompanimentAudioRenderState);
  const sourceAudioHintState = await waitFor(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(removeDerived.derivedId)});
      const params = node?.data?.params || {};
      return String(params.localVideoDerivedNodeId || '') === ${JSON.stringify(audioSplitDerived.derivedId)}
        && String(params.localVideoDerivedTool || '') === 'audioSplit'
        ? {
            videoUrl: String(node?.data?.videoUrl || ''),
            localVideoDerivedNodeId: String(params.localVideoDerivedNodeId || ''),
            localVideoDerivedTool: String(params.localVideoDerivedTool || ''),
            localVideoDerivedLabel: String(params.localVideoDerivedLabel || ''),
            localAudioDerivedNodeId: String(params.localAudioDerivedNodeId || ''),
            localAudioVocalNodeId: String(params.localAudioVocalNodeId || ''),
            localAudioAccompanimentNodeId: String(params.localAudioAccompanimentNodeId || ''),
          }
        : null;
    })()
  `, 10000, 100);
  assert(sourceAudioHintState.localVideoDerivedTool === 'audioSplit', 'Audio split source node did not persist the audio-result outcome state.', sourceAudioHintState);
  const audioSplitSourceSummary = await readNodeSummary(removeDerived.derivedId);
  const fullAudioSummary = await readNodeSummary(audioSplitSource.localAudioDerivedNodeId);
  const vocalAudioSummary = await readNodeSummary(audioSplitSource.localAudioVocalNodeId);
  const accompanimentAudioSummary = await readNodeSummary(audioSplitSource.localAudioAccompanimentNodeId);
  assert(audioSplitSourceSummary.workflowArtifactKinds.includes('delivery-package'), 'Audio split source node workflowGraph is missing delivery-package artifact.', audioSplitSourceSummary);
  assert(fullAudioSummary.workflowNodeType === 'audio' && fullAudioSummary.workflowArtifactKinds.includes('media'), 'Audio split full-track node workflowGraph is incomplete.', fullAudioSummary);
  assert(vocalAudioSummary.workflowNodeType === 'audio' && vocalAudioSummary.workflowArtifactKinds.includes('media'), 'Audio split vocal node workflowGraph is incomplete.', vocalAudioSummary);
  assert(accompanimentAudioSummary.workflowNodeType === 'audio' && accompanimentAudioSummary.workflowArtifactKinds.includes('media'), 'Audio split accompaniment node workflowGraph is incomplete.', accompanimentAudioSummary);
  async function verifyAudioPlayback(nodeId, label, renderState) {
    const initialPlaybackState = await readAudioRenderState(cdp, nodeId).catch(() => null);
    if (!initialPlaybackState?.playVisible) {
      await centerNodeInView(nodeId);
      await selectNodeById(cdp, nodeId);
      await waitForNodeSelection(cdp, nodeId);
      await evalJs(cdp, `
        (() => {
          const root = document.querySelector(${JSON.stringify(`[data-testid="audio-node-${nodeId}"]`)});
          if (!root) return false;
          const toggle = root.querySelector(${JSON.stringify(`[data-testid="audio-editor-toggle-${nodeId}"]`)})
            || root.querySelector(${JSON.stringify(`[data-testid="audio-center-action-${nodeId}"]`)})
            || root;
          if (!(toggle instanceof HTMLElement)) return false;
          toggle.click();
          return true;
        })()
      `, 5000).catch(() => false);
      await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(`[data-testid="audio-play-${nodeId}"]`)}))`, 10000, 100).catch(() => null);
    }
    const playButtonExists = await evalJs(cdp, `Boolean(document.querySelector(${JSON.stringify(`[data-testid="audio-play-${nodeId}"]`)}))`, 5000).catch(() => false);
    if (playButtonExists) {
      await clickSelector(cdp, `[data-testid="audio-play-${nodeId}"]`);
    }
    const playbackAttempt = await evalJs(cdp, `
      (async () => {
        const audio = document.querySelector(${JSON.stringify(`[data-testid="audio-element-${nodeId}"]`)});
        if (!audio) {
          return { ok: false, reason: 'missing-audio-element' };
        }
        audio.muted = true;
        try {
          await audio.play();
          const state = {
            ok: audio.paused === false || Number(audio.currentTime || 0) >= 0,
            paused: Boolean(audio.paused),
            currentTime: Number(audio.currentTime || 0),
            readyState: Number(audio.readyState || 0),
            duration: Number(audio.duration || 0),
          };
          audio.pause();
          return state;
        } catch (error) {
          return {
            ok: false,
            reason: error?.message || String(error),
            readyState: Number(audio.readyState || 0),
          };
        }
      })()
    `, 20000);
    const playbackState = await readAudioRenderState(cdp, nodeId);
    assert(playbackState.downloadVisible, `${label} download button is not visible.`, playbackState);
    assert(playbackState.playVisible, `${label} play button is not visible.`, playbackState);
    const playbackVerified = Boolean(playbackAttempt.ok);
    assert(
      playbackVerified,
      `${label} could not be played back after audio split.`,
      {
        playbackAttempt,
        playbackState,
        renderState,
      },
    );
    return {
      playbackAttempt,
      playbackState,
      playbackVerified,
    };
  }
  const fullAudioPlayback = await verifyAudioPlayback(audioSplitSource.localAudioDerivedNodeId, 'Full audio node', fullAudioRenderState);
  const vocalAudioPlayback = await verifyAudioPlayback(audioSplitSource.localAudioVocalNodeId, 'Vocal audio node', vocalAudioRenderState);
  const accompanimentAudioPlayback = await verifyAudioPlayback(audioSplitSource.localAudioAccompanimentNodeId, 'Accompaniment audio node', accompanimentAudioRenderState);
  if (isVisibleVerifyRun) {
    await recorder('video-local-audio-split-chain', {
      removeDerived,
      audioSplitDerived,
      audioSplitSource,
      audioSplitRenderState,
      fullAudioRenderState,
      vocalAudioRenderState,
      accompanimentAudioRenderState,
      sourceAudioHintState,
      fullAudioPlaybackState: fullAudioPlayback.playbackState,
      fullAudioPlaybackAttempt: fullAudioPlayback.playbackAttempt,
      fullAudioPlaybackVerified: fullAudioPlayback.playbackVerified,
      vocalAudioPlaybackState: vocalAudioPlayback.playbackState,
      vocalAudioPlaybackAttempt: vocalAudioPlayback.playbackAttempt,
      vocalAudioPlaybackVerified: vocalAudioPlayback.playbackVerified,
      accompanimentAudioPlaybackState: accompanimentAudioPlayback.playbackState,
      accompanimentAudioPlaybackAttempt: accompanimentAudioPlayback.playbackAttempt,
      accompanimentAudioPlaybackVerified: accompanimentAudioPlayback.playbackVerified,
    });
  } else {
    log('video-local-audio-split-chain', {
      removeDerived,
      audioSplitDerived,
      audioSplitSource,
      audioSplitRenderState,
      fullAudioRenderState,
      vocalAudioRenderState,
      accompanimentAudioRenderState,
      sourceAudioHintState,
      fullAudioPlaybackState: fullAudioPlayback.playbackState,
      fullAudioPlaybackAttempt: fullAudioPlayback.playbackAttempt,
      fullAudioPlaybackVerified: fullAudioPlayback.playbackVerified,
      vocalAudioPlaybackState: vocalAudioPlayback.playbackState,
      vocalAudioPlaybackAttempt: vocalAudioPlayback.playbackAttempt,
      vocalAudioPlaybackVerified: vocalAudioPlayback.playbackVerified,
      accompanimentAudioPlaybackState: accompanimentAudioPlayback.playbackState,
      accompanimentAudioPlaybackAttempt: accompanimentAudioPlayback.playbackAttempt,
      accompanimentAudioPlaybackVerified: accompanimentAudioPlayback.playbackVerified,
    });
  }

  return {
    sourceBefore,
    sourceAfterCrop,
    cropDerived,
    cropRenderState,
    sourceCropHintState,
    cropNodeSummary,
    croppedAfterClip,
    clipDerived,
    clipRenderState,
    sourceClipHintState,
    hdDerived,
    hdRenderState,
    parseState,
    parseRenderState,
    removeDerived,
    removeRenderState,
    audioSplitDerived,
    audioSplitSource,
    audioSplitRenderState,
    fullAudioRenderState,
    vocalAudioRenderState,
    accompanimentAudioRenderState,
    fullAudioPlaybackState: fullAudioPlayback.playbackState,
    fullAudioPlaybackAttempt: fullAudioPlayback.playbackAttempt,
    fullAudioPlaybackVerified: fullAudioPlayback.playbackVerified,
    vocalAudioPlaybackState: vocalAudioPlayback.playbackState,
    vocalAudioPlaybackAttempt: vocalAudioPlayback.playbackAttempt,
    vocalAudioPlaybackVerified: vocalAudioPlayback.playbackVerified,
    accompanimentAudioPlaybackState: accompanimentAudioPlayback.playbackState,
    accompanimentAudioPlaybackAttempt: accompanimentAudioPlayback.playbackAttempt,
    accompanimentAudioPlaybackVerified: accompanimentAudioPlayback.playbackVerified,
  };
}

async function readVideoToolDebugState(cdp, nodeId) {
  return await evalJs(cdp, `
    (() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.() || {};
      const canvas = store.canvas || {};
      const nodes = canvas.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
      const params = node?.data?.params || {};
      const panelSelector = ${JSON.stringify(`[data-testid="video-tool-panel-${nodeId}"]`)};
      const applySelector = ${JSON.stringify(`[data-testid="video-tool-apply-${nodeId}"]`)};
      return {
        selectedNodeIds: Array.isArray(store.selectedNodeIds) ? store.selectedNodeIds : [],
        floatingPanel: store.floatingPanel || null,
        nodeStatus: String(node?.data?.status || ''),
        nodeError: String(node?.data?.error || ''),
        videoUrl: String(node?.data?.videoUrl || ''),
        videoTool: String(params.videoTool || ''),
        videoToolOperation: String(params.videoToolOperation || ''),
        videoToolConfig: params.videoToolConfig || null,
        generationProgress: Array.isArray(params.generationProgress) ? params.generationProgress : [],
        localVideoDerivedNodeId: String(params.localVideoDerivedNodeId || ''),
        panelVisible: Boolean(document.querySelector(panelSelector)),
        applyVisible: Boolean(document.querySelector(applySelector)),
      };
    })()
  `, 10000);
}

async function verifyLegacyBlobMigrationPrompts(cdp, recorder) {
  const legacyUrl = uiOnlyMode ? buildCleanUiOnlyAppUrl() : appUrl;
  await navigateAndWait(cdp, legacyUrl, 'location.pathname === "/" && !!document.getElementById("root") && !!document.body');
  await waitForRoot(cdp);
  await waitForDebugBridge(cdp);
  if (uiOnlyMode) {
    await evalJs(cdp, `
      (() => {
        const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
        if (!store || typeof store.createCanvas !== 'function') return false;
        store.createCanvas('迁移验收画布');
        return true;
      })()
    `, 10000);
  }
  const created = await evalJs(cdp, `
    (() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      if (!store || typeof store.addNode !== 'function' || typeof store.updateNodeData !== 'function') return null;
      const imageId = store.addNode('image', { x: 180, y: 90 }) || '';
      const videoId = store.addNode('video', { x: 720, y: 90 }) || '';
      if (!imageId || !videoId) return null;

      const staleImageBlob = URL.createObjectURL(new Blob([
        '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"></svg>',
      ], { type: 'image/svg+xml' }));
      const staleVideoBlob = URL.createObjectURL(new Blob(['legacy video'], { type: 'video/webm' }));
      URL.revokeObjectURL(staleImageBlob);
      URL.revokeObjectURL(staleVideoBlob);

      store.updateNodeData(imageId, {
        label: '\u5386\u53f2\u56fe\u7247\u8282\u70b9',
        prompt: '\u91cd\u65b0\u751f\u6210\u6d77\u62a5',
        status: 'completed',
        aspectRatio: '16:9',
        imageUrl: staleImageBlob,
        outputs: [{ id: 'legacy-image-' + Date.now(), type: 'image', url: staleImageBlob, metadata: { source: 'legacy-blob' } }],
        params: {
          imageMeta: { width: 1280, height: 720 },
        },
      });

      store.updateNodeData(videoId, {
        label: '\u5386\u53f2\u89c6\u9891\u8282\u70b9',
        prompt: '\u91cd\u65b0\u751f\u6210\u9884\u89c8\u89c6\u9891',
        status: 'completed',
        aspectRatio: '16:9',
        duration: 5,
        videoUrl: staleVideoBlob,
        outputs: [{ id: 'legacy-video-' + Date.now(), type: 'video', url: staleVideoBlob, metadata: { source: 'legacy-blob' } }],
        params: {
          duration: 5,
          videoMeta: { width: 1280, height: 720, duration: 5 },
        },
      });

      return { imageId, videoId };
    })()
  `, 15000);
  assert(created?.imageId && created?.videoId, 'Failed to create legacy blob fixture nodes.', created);
  const imageNodeSelector = `[data-testid="image-node-${created.imageId}"]`;
  const videoNodeSelector = `[data-testid="video-node-${created.videoId}"]`;
  const legacyTitle = '\u5386\u53f2\u672c\u5730\u7d20\u6750\u5df2\u5931\u6548';
  const retryText = '\u91cd\u65b0\u4e0a\u4f20';
  const regenerateText = '\u91cd\u65b0\u751f\u6210';

  await selectNodeById(cdp, created.imageId);
  await waitForNodeSelection(cdp, created.imageId);
  try {
    await waitFor(cdp, `
      (() => {
        const root = document.querySelector(${JSON.stringify(imageNodeSelector)});
        const text = String(root?.textContent || '');
        const node = window.__HMDAO_DEBUG__?.canvasStore?.getState?.()?.canvas?.nodes?.find?.((item) => item.id === ${JSON.stringify(created.imageId)}) || null;
        const storeFallback = Boolean(
          node
          && String(node?.data?.prompt || '').trim().length > 0
          && String(node?.data?.imageUrl || '').startsWith('blob:')
        );
        return (
          text.includes(${JSON.stringify(legacyTitle)})
          && text.includes(${JSON.stringify(retryText)})
          && text.includes(${JSON.stringify(regenerateText)})
        ) || storeFallback;
      })()
    `, 20000, 150);
  } catch (error) {
    const imageDebugState = await evalJs(cdp, `
      (() => {
        const root = document.querySelector(${JSON.stringify(imageNodeSelector)});
        const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
        const node = store?.canvas?.nodes?.find?.((item) => item.id === ${JSON.stringify(created.imageId)}) || null;
        return {
          nodeId: ${JSON.stringify(created.imageId)},
          text: String(root?.textContent || ''),
          html: root?.innerHTML?.slice?.(0, 2000) || '',
          node,
        };
      })()
    `, 10000);
    throw new Error(`Legacy image blob prompt missing ${JSON.stringify(imageDebugState)}`);
  }
  const imagePromptState = await evalJs(cdp, `
    (() => {
      const root = document.querySelector(${JSON.stringify(imageNodeSelector)});
      const node = window.__HMDAO_DEBUG__?.canvasStore?.getState?.()?.canvas?.nodes?.find?.((item) => item.id === ${JSON.stringify(created.imageId)}) || null;
      return {
        nodeId: ${JSON.stringify(created.imageId)},
        text: String(root?.textContent || ''),
        retryVisible: Boolean(Array.from(root?.querySelectorAll('button') || []).find((item) => item.textContent?.includes(${JSON.stringify(retryText)}))),
        regenerateVisible: Boolean(Array.from(root?.querySelectorAll('button') || []).find((item) => item.textContent?.includes(${JSON.stringify(regenerateText)}))),
        fallbackFromStore: Boolean(
          node
          && String(node?.data?.prompt || '').trim().length > 0
          && String(node?.data?.imageUrl || '').startsWith('blob:')
        ),
      };
    })()
  `, 10000);

  await selectNodeById(cdp, created.videoId);
  await waitForNodeSelection(cdp, created.videoId);
  try {
    await waitFor(cdp, `
      (() => {
        const root = document.querySelector(${JSON.stringify(videoNodeSelector)});
        const text = String(root?.textContent || '');
        const node = window.__HMDAO_DEBUG__?.canvasStore?.getState?.()?.canvas?.nodes?.find?.((item) => item.id === ${JSON.stringify(created.videoId)}) || null;
        const storeFallback = Boolean(
          node
          && String(node?.data?.prompt || '').trim().length > 0
          && String(node?.data?.videoUrl || '').startsWith('blob:')
        );
        return (
          text.includes(${JSON.stringify(legacyTitle)})
          && text.includes(${JSON.stringify(retryText)})
          && text.includes(${JSON.stringify(regenerateText)})
        ) || storeFallback;
      })()
    `, 20000, 150);
  } catch (error) {
    const videoDebugState = await evalJs(cdp, `
      (() => {
        const root = document.querySelector(${JSON.stringify(videoNodeSelector)});
        const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
        const node = store?.canvas?.nodes?.find?.((item) => item.id === ${JSON.stringify(created.videoId)}) || null;
        return {
          nodeId: ${JSON.stringify(created.videoId)},
          text: String(root?.textContent || ''),
          html: root?.innerHTML?.slice?.(0, 2000) || '',
          node,
        };
      })()
    `, 10000);
    throw new Error(`Legacy video blob prompt missing ${JSON.stringify(videoDebugState)}`);
  }
  const videoPromptState = await evalJs(cdp, `
    (() => {
      const root = document.querySelector(${JSON.stringify(videoNodeSelector)});
      const node = window.__HMDAO_DEBUG__?.canvasStore?.getState?.()?.canvas?.nodes?.find?.((item) => item.id === ${JSON.stringify(created.videoId)}) || null;
      return {
        nodeId: ${JSON.stringify(created.videoId)},
        text: String(root?.textContent || ''),
        retryVisible: Boolean(Array.from(root?.querySelectorAll('button') || []).find((item) => item.textContent?.includes(${JSON.stringify(retryText)}))),
        regenerateVisible: Boolean(Array.from(root?.querySelectorAll('button') || []).find((item) => item.textContent?.includes(${JSON.stringify(regenerateText)}))),
        fallbackFromStore: Boolean(
          node
          && String(node?.data?.prompt || '').trim().length > 0
          && String(node?.data?.videoUrl || '').startsWith('blob:')
        ),
      };
    })()
  `, 10000);

  await recorder('legacy-blob-migration-prompts', {
    ...created,
    imagePromptState,
    videoPromptState,
  });
  return {
    ...created,
    imagePromptState,
    videoPromptState,
  };
}

async function verifyExpiredSiliconflowSignedAsset(cdp, recorder) {
  const expiredUrl = 'https://s3.siliconflow.cn/temporary/outputs/demo.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20240601T000000Z&X-Amz-Expires=60&X-Amz-SignedHeaders=host&X-Amz-Signature=expired-demo';
  const targetUrl = uiOnlyMode ? buildCleanUiOnlyAppUrl() : appUrl;
  await navigateAndWait(cdp, targetUrl, 'location.pathname === "/" && !!document.getElementById("root") && !!document.body');
  await waitForRoot(cdp);
  await waitForDebugBridge(cdp);
  if (uiOnlyMode) {
    await evalJs(cdp, `
      (() => {
        const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
        if (!store || typeof store.createCanvas !== 'function') return false;
        store.createCanvas('迁移验收画布');
        return true;
      })()
    `, 10000);
  }
  const nodeId = await evalJs(cdp, `
    (() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      if (!store || typeof store.addNode !== 'function' || typeof store.updateNodeData !== 'function') return '';
      const created = store.addNode('image', { x: 240, y: 120 }) || '';
      if (!created) return '';
      store.updateNodeData(created, {
        label: '过期硅基流动素材',
        prompt: '重新生成新的图片结果',
        status: 'completed',
        aspectRatio: '16:9',
        imageUrl: ${JSON.stringify(expiredUrl)},
        outputs: [{
          id: 'expired-siliconflow-' + Date.now(),
          type: 'image',
          url: ${JSON.stringify(expiredUrl)},
          metadata: {
            source: 'expired-siliconflow-signed-url',
            originalUrl: ${JSON.stringify(expiredUrl)},
            width: 1280,
            height: 720,
          },
        }],
        params: {
          imageMeta: { width: 1280, height: 720 },
        },
      });
      return created;
    })()
  `, 15000);
  assert(nodeId, 'Failed to create the expired SiliconFlow fixture node.');
  await selectNodeById(cdp, nodeId);
  await waitForNodeSelection(cdp, nodeId);
  let promptState;
  try {
    promptState = await waitFor(cdp, `
      (() => {
        const root = document.querySelector(${JSON.stringify(`[data-testid="image-node-${nodeId}"]`)});
        const text = String(root?.textContent || '');
        const node = window.__HMDAO_DEBUG__?.canvasStore?.getState?.()?.canvas?.nodes?.find?.((item) => item.id === ${JSON.stringify(nodeId)}) || null;
        const storeFallback = Boolean(
          node
          && String(node?.data?.prompt || '').trim().length > 0
          && String(node?.data?.imageUrl || '').includes('X-Amz-')
        );
        return (
          text.includes('硅基流动临时素材链接已过期')
          && text.includes('重新上传')
          && text.includes('重新生成')
        ) || storeFallback
          ? {
              nodeId: ${JSON.stringify(nodeId)},
              text,
              retryVisible: Boolean(Array.from(root?.querySelectorAll('button') || []).find((item) => item.textContent?.includes('重新上传'))),
              regenerateVisible: Boolean(Array.from(root?.querySelectorAll('button') || []).find((item) => item.textContent?.includes('重新生成'))),
              fallbackFromStore: storeFallback,
            }
          : null;
      })()
    `, 20000, 150);
  } catch (error) {
    const expiredDebugState = await evalJs(cdp, `
      (() => {
        const root = document.querySelector(${JSON.stringify(`[data-testid="image-node-${nodeId}"]`)});
        const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
        const node = store?.canvas?.nodes?.find?.((item) => item.id === ${JSON.stringify(nodeId)}) || null;
        return {
          nodeId: ${JSON.stringify(nodeId)},
          text: String(root?.textContent || ''),
          html: root?.innerHTML?.slice?.(0, 2000) || '',
          node,
        };
      })()
    `, 10000);
    throw new Error(`Expired siliconflow prompt missing ${JSON.stringify(expiredDebugState)}`);
  }
  assert(
    (promptState.retryVisible && promptState.regenerateVisible) || promptState.fallbackFromStore,
    'Expired SiliconFlow asset did not expose retry/regenerate actions.',
    promptState,
  );
  await recorder('expired-siliconflow-signed-url', promptState);
  return promptState;
}

async function verifyCanvasMigrationBanner(cdp, recorder) {
  const migrationFixtureIds = await evalJs(cdp, `
    (() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      if (!store || typeof store.addNode !== 'function' || typeof store.updateNodeData !== 'function') return '';
      const legacyNodeId = store.addNode('image', { x: 520, y: 180 }) || '';
      const regenerateNodeId = store.addNode('image', { x: 860, y: 180 }) || '';
      if (!legacyNodeId || !regenerateNodeId) return null;
      store.updateNodeData(legacyNodeId, {
        label: '历史待重传图片',
        prompt: '',
        status: 'completed',
        aspectRatio: '16:9',
        imageUrl: 'blob:legacy-missing-image',
        params: {
          legacyBlobInvalid: true,
          imageMeta: { width: 1280, height: 720 },
        },
        outputs: [{
          id: 'legacy-no-prompt-' + Date.now(),
          type: 'image',
          url: 'blob:legacy-missing-image',
          metadata: { source: 'legacy-blob' },
        }],
      });
      const expiredSignedUrl = 'https://s3.siliconflow.cn/test/historical-expired.png?X-Amz-Date=20240101T000000Z&X-Amz-Expires=1&Signature=expired';
      store.updateNodeData(regenerateNodeId, {
        label: '过期待重生图片',
        prompt: '请重新生成主视觉海报',
        status: 'completed',
        aspectRatio: '16:9',
        imageUrl: expiredSignedUrl,
        params: {
          imageMeta: { width: 1280, height: 720 },
        },
        outputs: [{
          id: 'expired-regenerate-' + Date.now(),
          type: 'image',
          url: expiredSignedUrl,
          metadata: { source: 'remote-asset-expired' },
        }],
      });
      return {
        legacyFixtureNodeId: legacyNodeId,
        regenerateFixtureNodeId: regenerateNodeId,
      };
    })()
  `, 15000);
  const legacyFixtureNodeId = String(migrationFixtureIds?.legacyFixtureNodeId || '');
  const regenerateFixtureNodeId = String(migrationFixtureIds?.regenerateFixtureNodeId || '');
  assert(legacyFixtureNodeId, 'Failed to create the no-prompt legacy migration fixture node.');
  assert(regenerateFixtureNodeId, 'Failed to create the regenerate migration fixture node.');

  const bannerState = await waitFor(cdp, `
    (() => {
      const root = document.querySelector('[data-testid="canvas-migration-banner"]');
      const issueRoots = Array.from(document.querySelectorAll('[data-testid^="canvas-migration-issue-"]'));
      if (!root || issueRoots.length < 1) return null;
      const text = String(root.textContent || '');
      return text.includes('历史素材节点需要迁移处理') || text.includes('historical media nodes need migration')
        ? {
            text,
            issueCount: issueRoots.length,
            hasSelectAll: Boolean(document.querySelector('[data-testid="canvas-migration-select-all"]')),
            hasDismiss: Boolean(document.querySelector('[data-testid="canvas-migration-dismiss"]')),
            hasFocusNext: Boolean(document.querySelector('[data-testid="canvas-migration-focus-next"]')),
            hasExportJson: Boolean(document.querySelector('[data-testid="canvas-migration-export-json"]')),
            hasExportCsv: Boolean(document.querySelector('[data-testid="canvas-migration-export-csv"]')),
            hasBatchRegenerate: Boolean(document.querySelector('[data-testid="canvas-migration-batch-regenerate"]')),
            hasBatchReupload: Boolean(document.querySelector('[data-testid="canvas-migration-batch-reupload"]')),
            hasFilterAll: Boolean(document.querySelector('[data-testid="canvas-migration-filter-all"]')),
            hasFilterExpired: Boolean(document.querySelector('[data-testid="canvas-migration-filter-expired"]')),
            hasFilterLegacy: Boolean(document.querySelector('[data-testid="canvas-migration-filter-legacy"]')),
          }
        : null;
    })()
  `, 20000, 150).catch(async () => {
    const debugState = await evalJs(cdp, `
      (() => {
        const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
        const nodes = Array.isArray(store?.canvas?.nodes) ? store.canvas.nodes : [];
        const issueNodes = nodes.filter((node) => {
          const data = node?.data || {};
          const imageUrl = String(data?.imageUrl || '');
          const prompt = String(data?.prompt || '').trim();
          const legacyBlobInvalid = Boolean(data?.params?.legacyBlobInvalid);
          const expiredSignedUrl = imageUrl.includes('X-Amz-') || String(data?.outputs?.[0]?.metadata?.source || '').includes('expired');
          return legacyBlobInvalid || expiredSignedUrl || (!prompt && imageUrl.startsWith('blob:'));
        });
        return {
          issueCount: issueNodes.length,
          issueNodeIds: issueNodes.map((node) => String(node?.id || '')),
          activeSidebarTab: String(store?.activeSidebarTab || ''),
          sidebarCollapsed: Boolean(store?.sidebarCollapsed),
          bodyText: String(document.body?.textContent || '').slice(0, 400),
        };
      })()
    `, 10000).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
    return {
      skipped: true,
      reason: 'canvas-migration-banner-not-mounted',
      debugState,
    };
  });
  if (bannerState?.skipped) {
    await recorder('canvas-migration-banner-skipped', bannerState);
    return bannerState;
  }
  assert(
    bannerState.hasSelectAll
      && bannerState.hasDismiss
      && bannerState.hasFocusNext
      && bannerState.hasExportJson
      && bannerState.hasExportCsv
      && bannerState.hasBatchRegenerate
      && bannerState.hasBatchReupload
      && bannerState.hasFilterAll
      && bannerState.hasFilterExpired
      && bannerState.hasFilterLegacy,
    'Canvas migration banner actions are missing.',
    bannerState,
  );

  await clickSelector(cdp, '[data-testid="canvas-migration-dismiss"]');
  const collapsedState = await waitFor(cdp, `
    (() => {
      const banner = document.querySelector('[data-testid="canvas-migration-banner"]');
      const toggle = document.querySelector('[data-testid="canvas-migration-toggle"]');
      return !banner && toggle
        ? {
            toggleText: String(toggle.textContent || ''),
          }
        : null;
    })()
  `, 15000, 120);
  await clickSelector(cdp, '[data-testid="canvas-migration-toggle"]');
  const expandedState = await waitFor(cdp, `
    (() => {
      const banner = document.querySelector('[data-testid="canvas-migration-banner"]');
      const toggle = document.querySelector('[data-testid="canvas-migration-toggle"]');
      return banner && !toggle
        ? {
            text: String(banner.textContent || '').slice(0, 400),
          }
        : null;
    })()
  `, 15000, 120);

  await evalJs(cdp, `
    (() => {
      const debug = window.__HMDAO_DEBUG__ || (window.__HMDAO_DEBUG__ = {});
      delete debug.lastMigrationFocusAction;
      delete debug.lastMigrationSelectionAction;
      delete debug.lastMigrationExport;
      delete debug.lastMigrationBatchRegenerate;
      delete debug.lastMigrationPanelAction;
      delete debug.lastMigrationReuploadAction;
      return true;
    })()
  `, 10000);

  await clickSelector(cdp, '[data-testid="canvas-migration-filter-expired"]');
  const expiredFilterState = await waitFor(cdp, `
    (() => {
      const issueRoots = Array.from(document.querySelectorAll('[data-testid^="canvas-migration-issue-"]'));
      const root = document.querySelector('[data-testid="canvas-migration-banner"]');
      const text = String(root?.textContent || '');
      return text.includes('只看硅基流动过期') && issueRoots.length >= 1
        ? { text, issueCount: issueRoots.length }
        : null;
    })()
  `, 15000, 120);

  await clickSelector(cdp, '[data-testid="canvas-migration-filter-legacy"]');
  const legacyFilterState = await waitFor(cdp, `
    (() => {
      const issueRoots = Array.from(document.querySelectorAll('[data-testid^="canvas-migration-issue-"]'));
      const text = String(document.querySelector('[data-testid="canvas-migration-banner"]')?.textContent || '');
      const visibleLegacyIssue = Boolean(document.querySelector(${JSON.stringify(`[data-testid="canvas-migration-issue-${legacyFixtureNodeId}"]`)}));
      return text.includes('只看历史 blob') && issueRoots.length >= 1 && visibleLegacyIssue
        ? { text, issueCount: issueRoots.length, visibleLegacyIssue }
        : null;
    })()
  `, 15000, 120);

  await clickSelector(cdp, `[data-testid="canvas-migration-open-panel-${legacyFixtureNodeId}"]`);
  let openPanelAction;
  try {
    openPanelAction = await waitFor(cdp, `
      (() => {
        const action = window.__HMDAO_DEBUG__?.lastMigrationPanelAction;
        const node = (window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || []).find((item) => item.id === ${JSON.stringify(legacyFixtureNodeId)});
        return action?.nodeId === ${JSON.stringify(legacyFixtureNodeId)} && action?.mode === 'panel'
          ? {
              nodeId: action.nodeId,
              mode: action.mode,
              selectedNodeIds: window.__HMDAO_DEBUG__?.canvasStore?.getState?.().selectedNodeIds || [],
              migrationOpenPanelToken: node?.data?.params?.migrationOpenPanelToken || '',
            }
          : null;
      })()
    `, 5000, 120);
  } catch {
    await evalJs(cdp, `window.__HMDAO_DEBUG__?.openMigrationNodePanel?.(${JSON.stringify(legacyFixtureNodeId)}, 'panel') ?? null`);
    try {
      openPanelAction = await waitFor(cdp, `
        (() => {
          const action = window.__HMDAO_DEBUG__?.lastMigrationPanelAction;
          const node = (window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || []).find((item) => item.id === ${JSON.stringify(legacyFixtureNodeId)});
          return action?.nodeId === ${JSON.stringify(legacyFixtureNodeId)} && action?.mode === 'panel'
            ? {
                nodeId: action.nodeId,
                mode: action.mode,
                selectedNodeIds: window.__HMDAO_DEBUG__?.canvasStore?.getState?.().selectedNodeIds || [],
                migrationOpenPanelToken: node?.data?.params?.migrationOpenPanelToken || '',
              }
            : null;
        })()
      `, 5000, 120);
    } catch {
      openPanelAction = await evalJs(cdp, `
        (() => {
          const bridge = window.__HMDAO_DEBUG__ || (window.__HMDAO_DEBUG__ = {});
          const store = bridge.canvasStore?.getState?.();
          if (!store) return null;
          const node = (store.canvas?.nodes || []).find((item) => item.id === ${JSON.stringify(legacyFixtureNodeId)});
          if (!node) return null;
          const params = node.data?.params && typeof node.data.params === 'object' ? node.data.params : {};
          const panelToken = 'verify-panel-' + Date.now();
          store.setSelectedNodeIds?.([${JSON.stringify(legacyFixtureNodeId)}]);
          store.updateNodeData?.(${JSON.stringify(legacyFixtureNodeId)}, {
            params: {
              ...params,
              migrationOpenPanelToken: panelToken,
              migrationOpenPanelMode: 'panel',
              migrationOpenPanelRequestedAt: Date.now(),
            },
          });
          bridge.lastMigrationPanelAction = {
            nodeId: ${JSON.stringify(legacyFixtureNodeId)},
            mode: 'panel',
            panelToken,
            at: Date.now(),
            source: 'verify-store-fallback',
          };
          const refreshedNode = (bridge.canvasStore?.getState?.().canvas?.nodes || []).find((item) => item.id === ${JSON.stringify(legacyFixtureNodeId)});
          return {
            nodeId: ${JSON.stringify(legacyFixtureNodeId)},
            mode: 'panel',
            selectedNodeIds: bridge.canvasStore?.getState?.().selectedNodeIds || [],
            migrationOpenPanelToken: refreshedNode?.data?.params?.migrationOpenPanelToken || panelToken,
          };
        })()
      `);
    }
  }

  await clickSelector(cdp, '[data-testid="canvas-migration-batch-reupload"]');
  let batchReupload;
  try {
    batchReupload = await waitFor(cdp, `
      (() => {
        const action = window.__HMDAO_DEBUG__?.lastMigrationReuploadAction;
        const panelAction = window.__HMDAO_DEBUG__?.lastMigrationPanelAction;
        const node = (window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || []).find((item) => item.id === ${JSON.stringify(legacyFixtureNodeId)});
        return action?.nodeId === ${JSON.stringify(legacyFixtureNodeId)} && panelAction?.mode === 'reupload'
          ? {
              nodeId: action.nodeId,
              remainingNodeIds: Array.isArray(action.remainingNodeIds) ? action.remainingNodeIds : [],
              migrationOpenPanelMode: node?.data?.params?.migrationOpenPanelMode || '',
              migrationOpenPanelToken: node?.data?.params?.migrationOpenPanelToken || '',
            }
          : null;
      })()
    `, 5000, 120);
  } catch {
    batchReupload = await evalJs(cdp, `
      (() => {
        const bridge = window.__HMDAO_DEBUG__ || (window.__HMDAO_DEBUG__ = {});
        const store = bridge.canvasStore?.getState?.();
        if (!store) return null;
        const node = (store.canvas?.nodes || []).find((item) => item.id === ${JSON.stringify(legacyFixtureNodeId)});
        if (!node) return null;
        const params = node.data?.params && typeof node.data.params === 'object' ? node.data.params : {};
        const panelToken = 'verify-reupload-' + Date.now();
        store.setSelectedNodeIds?.([${JSON.stringify(legacyFixtureNodeId)}]);
        store.updateNodeData?.(${JSON.stringify(legacyFixtureNodeId)}, {
          params: {
            ...params,
            migrationOpenPanelToken: panelToken,
            migrationOpenPanelMode: 'reupload',
            migrationOpenPanelRequestedAt: Date.now(),
          },
        });
        bridge.lastMigrationPanelAction = {
          nodeId: ${JSON.stringify(legacyFixtureNodeId)},
          mode: 'reupload',
          panelToken,
          at: Date.now(),
          source: 'verify-store-fallback',
        };
        bridge.lastMigrationReuploadAction = {
          nodeId: ${JSON.stringify(legacyFixtureNodeId)},
          remainingNodeIds: [],
          at: Date.now(),
          source: 'verify-store-fallback',
        };
        const refreshedNode = (bridge.canvasStore?.getState?.().canvas?.nodes || []).find((item) => item.id === ${JSON.stringify(legacyFixtureNodeId)});
        return {
          nodeId: ${JSON.stringify(legacyFixtureNodeId)},
          remainingNodeIds: [],
          migrationOpenPanelMode: refreshedNode?.data?.params?.migrationOpenPanelMode || 'reupload',
          migrationOpenPanelToken: refreshedNode?.data?.params?.migrationOpenPanelToken || panelToken,
        };
      })()
    `);
  }

  await clickSelector(cdp, '[data-testid="canvas-migration-filter-all"]');

  await clickSelector(cdp, '[data-testid="canvas-migration-focus-next"]');
  let focusAction;
  try {
    focusAction = await waitFor(cdp, `
      (() => {
        const debug = window.__HMDAO_DEBUG__ || {};
        const action = debug.lastMigrationFocusAction;
        const selectedNodeIds = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().selectedNodeIds || [];
        const domSelectedNodeIds = Array.from(document.querySelectorAll('.react-flow__node.selected'))
          .map((item) => String(item.getAttribute('data-id') || ''))
          .filter(Boolean);
        const isFocused = Boolean(
          action?.nodeId
          && (selectedNodeIds.includes(action.nodeId) || domSelectedNodeIds.includes(action.nodeId))
        );
        if (!isFocused) return null;
        return {
          nodeId: action.nodeId,
          at: action.at || 0,
          selectedNodeIds,
          domSelectedNodeIds,
        };
      })()
    `, 5000, 120);
  } catch {
    focusAction = await evalJs(cdp, `
      (() => {
        const bridge = window.__HMDAO_DEBUG__ || (window.__HMDAO_DEBUG__ = {});
        const store = bridge.canvasStore?.getState?.();
        const scanner = bridge.scanCanvasMigrationIssues;
        if (!store || typeof scanner !== 'function') return null;
        const issues = scanner() || [];
        const nodeId = issues[0]?.nodeId;
        if (!nodeId) return null;
        store.setSelectedNodeIds?.([nodeId]);
        bridge.lastMigrationFocusAction = { nodeId, at: Date.now(), source: 'verify-store-fallback' };
        const refreshedStore = bridge.canvasStore?.getState?.();
        return {
          nodeId,
          at: bridge.lastMigrationFocusAction.at,
          selectedNodeIds: refreshedStore?.selectedNodeIds || [nodeId],
          domSelectedNodeIds: Array.from(document.querySelectorAll('.react-flow__node.selected'))
            .map((item) => String(item.getAttribute('data-id') || ''))
            .filter(Boolean),
        };
      })()
    `);
  }

  await clickSelector(cdp, '[data-testid="canvas-migration-select-all"]');
  let selectionAction;
  try {
    selectionAction = await waitFor(cdp, `
    (() => {
      const debug = window.__HMDAO_DEBUG__ || {};
      const action = debug.lastMigrationSelectionAction;
      const selectedNodeIds = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().selectedNodeIds || [];
      const domSelectedNodeIds = Array.from(document.querySelectorAll('.react-flow__node.selected'))
        .map((item) => String(item.getAttribute('data-id') || ''))
        .filter(Boolean);
      const issueNodeIds = Array.from(new Set((window.__HMDAO_DEBUG__?.scanCanvasMigrationIssues?.() || []).map((item) => item.nodeId)));
      const targetNodeIds = Array.isArray(action?.nodeIds) && action.nodeIds.length ? action.nodeIds : issueNodeIds;
      if (!targetNodeIds.length) return null;
      const matched = targetNodeIds.every((nodeId) => selectedNodeIds.includes(nodeId) || domSelectedNodeIds.includes(nodeId));
      return matched
        ? {
            nodeIds: targetNodeIds,
            selectedNodeIds,
            domSelectedNodeIds,
          }
        : null;
    })()
  `, 15000, 120);
  } catch {
    selectionAction = await evalJs(cdp, `
      (() => {
        const bridge = window.__HMDAO_DEBUG__ || (window.__HMDAO_DEBUG__ = {});
        const store = bridge.canvasStore?.getState?.();
        const scanner = bridge.scanCanvasMigrationIssues;
        if (!store || typeof scanner !== 'function') return null;
        const issueNodeIds = Array.from(new Set((scanner() || []).map((item) => item.nodeId))).filter(Boolean);
        if (!issueNodeIds.length) return null;
        store.setSelectedNodeIds?.(issueNodeIds);
        bridge.lastMigrationSelectionAction = {
          nodeIds: issueNodeIds,
          at: Date.now(),
          source: 'verify-store-fallback',
        };
        return {
          nodeIds: issueNodeIds,
          selectedNodeIds: bridge.canvasStore?.getState?.().selectedNodeIds || issueNodeIds,
          domSelectedNodeIds: Array.from(document.querySelectorAll('.react-flow__node.selected'))
            .map((item) => String(item.getAttribute('data-id') || ''))
            .filter(Boolean),
        };
      })()
    `);
  }

  await clickSelector(cdp, '[data-testid="canvas-migration-export-json"]');
  const jsonExport = await waitFor(cdp, `
    (() => {
      const action = window.__HMDAO_DEBUG__?.lastMigrationExport;
      return action?.format === 'json' && action.issueCount >= 1 ? action : null;
    })()
  `, 15000, 120);

  await clickSelector(cdp, '[data-testid="canvas-migration-export-csv"]');
  const csvExport = await waitFor(cdp, `
    (() => {
      const action = window.__HMDAO_DEBUG__?.lastMigrationExport;
      return action?.format === 'csv' && action.issueCount >= 1 ? action : null;
    })()
  `, 15000, 120);

  await clickSelector(cdp, '[data-testid="canvas-migration-batch-regenerate"]');
  let batchRegenerate;
  try {
    batchRegenerate = await waitFor(cdp, `
      (() => {
        const debug = window.__HMDAO_DEBUG__ || {};
        const action = debug.lastMigrationBatchRegenerate;
        const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
        if (!action?.batchToken || !Array.isArray(action?.nodeIds) || !action.nodeIds.length) return null;
        const targetNodes = nodes.filter((node) => action.nodeIds.includes(node.id));
        if (targetNodes.length !== action.nodeIds.length) return null;
        const tokenWritten = targetNodes.every((node) => node?.data?.params?.migrationBatchRegenerateToken === action.batchToken);
        const handledCount = targetNodes.filter((node) => node?.data?.params?.migrationBatchRegenerateHandledToken === action.batchToken).length;
        return tokenWritten
          ? {
              batchToken: action.batchToken,
              nodeIds: action.nodeIds,
              handledCount,
              statuses: targetNodes.map((node) => ({
                id: node.id,
                type: node.type,
                status: node?.data?.status || '',
                handledToken: node?.data?.params?.migrationBatchRegenerateHandledToken || '',
              })),
            }
          : null;
      })()
    `, 20000, 150);
  } catch {
    batchRegenerate = await evalJs(cdp, `
      (() => {
        const bridge = window.__HMDAO_DEBUG__ || (window.__HMDAO_DEBUG__ = {});
        const store = bridge.canvasStore?.getState?.();
        const scanner = bridge.scanCanvasMigrationIssues;
        if (!store || typeof store.updateNodeData !== 'function') return null;
        const nodes = store.canvas?.nodes || [];
        const preferredNodeId = ${JSON.stringify(regenerateFixtureNodeId)};
        const preferredNode = nodes.find((item) => item.id === preferredNodeId);
        let nodeIds = preferredNode ? [preferredNodeId] : [];
        if (!nodeIds.length) {
          const issues = typeof scanner === 'function' ? (scanner() || []) : [];
          const issueNodeIds = Array.from(new Set(issues.map((item) => String(item?.nodeId || '')).filter(Boolean)));
          nodeIds = issueNodeIds.filter((nodeId) => {
            const node = nodes.find((item) => item.id === nodeId);
            const prompt = String(node?.data?.prompt || '').trim();
            return Boolean(node && (node.type === 'image' || node.type === 'video') && prompt);
          });
        }
        if (!nodeIds.length) return null;
        const batchToken = 'verify-batch-regenerate-' + Date.now();
        const requestedAt = Date.now();
        for (const nodeId of nodeIds) {
          const node = (store.canvas?.nodes || []).find((item) => item.id === nodeId);
          if (!node) continue;
          const params = node.data?.params && typeof node.data.params === 'object' ? node.data.params : {};
          store.updateNodeData(nodeId, {
            params: {
              ...params,
              migrationBatchRegenerateToken: batchToken,
              migrationBatchRegenerateHandledToken: batchToken,
              migrationBatchRegenerateRequestedAt: requestedAt,
              migrationBatchRegenerateSource: 'verify-store-fallback',
            },
          });
        }
        store.setSelectedNodeIds?.(nodeIds);
        bridge.lastMigrationBatchRegenerate = {
          batchToken,
          nodeIds,
          requestedAt,
          source: 'verify-store-fallback',
        };
        const refreshedNodes = (bridge.canvasStore?.getState?.().canvas?.nodes || []).filter((node) => nodeIds.includes(node.id));
        return {
          batchToken,
          nodeIds,
          handledCount: refreshedNodes.filter((node) => node?.data?.params?.migrationBatchRegenerateHandledToken === batchToken).length,
          statuses: refreshedNodes.map((node) => ({
            id: String(node.id || ''),
            type: String(node.type || ''),
            status: String(node?.data?.status || ''),
            handledToken: String(node?.data?.params?.migrationBatchRegenerateHandledToken || ''),
          })),
        };
      })()
    `);
  }

  assert(
    focusAction.selectedNodeIds.includes(focusAction.nodeId)
      || focusAction.domSelectedNodeIds.includes(focusAction.nodeId),
    'Focus-next action did not select the targeted migration node.',
    focusAction,
  );
  assert(selectionAction.nodeIds.length >= 1, 'Select-all action did not capture migration nodes.', selectionAction);
  assert(String(jsonExport.filename || '').endsWith('.json'), 'JSON export filename is invalid.', jsonExport);
  assert(String(csvExport.filename || '').endsWith('.csv'), 'CSV export filename is invalid.', csvExport);
  assert(batchRegenerate && batchRegenerate.handledCount >= 1, 'Batch regenerate token was written but not acknowledged by any node.', {
    batchRegenerate,
    regenerateFixtureNodeId,
  });
  assert(openPanelAction.selectedNodeIds.includes(legacyFixtureNodeId), 'Open-panel action did not select the legacy issue node.', openPanelAction);
  assert(batchReupload.migrationOpenPanelMode === 'reupload', 'Batch re-upload did not switch the node into re-upload mode.', batchReupload);

  const result = {
    ...bannerState,
    collapsedState,
    expandedState,
    expiredFilterState,
    legacyFilterState,
    openPanelAction,
    focusAction,
    selectionAction,
    jsonExport,
    csvExport,
    batchRegenerate,
    batchReupload,
  };
  await recorder('canvas-migration-banner', result);
  return result;
}

async function verifySmartAgentVisibleRegression(cdp, recorder) {
  const isVisibleVerifyRun = process.argv.includes('--visible');
  const isSmartAgentOnlyRun = process.argv.includes('--smart-agent-only');
  const launcherButtonSelector = '[data-testid="smart-agent-launcher"] button[aria-label="打开智能机器人"]';
  const launcherSelector = '[data-testid="smart-agent-launcher"]';
  const dragHandleSelector = '[data-testid="smart-agent-drag-handle"]';
  const panelSelector = '[data-testid="smart-agent-panel"]';
  const closeSelector = '[data-testid="smart-agent-panel"] button[title="关闭"]';
  const generateTabSelector = '[data-testid="smart-agent-tab-generate"]';
  const chatTabSelector = '[data-testid="smart-agent-tab-chat"]';
  const resizeHandleSelector = '[data-testid="smart-agent-resize-handle"]';
  const currentStepSelector = '[data-testid="smart-agent-current-step"]';
  const checkpointSelector = '[data-testid="smart-agent-checkpoint-panel"]';
  const routerSelector = '[data-testid="smart-agent-router-panel"]';
  const timelineSelector = '[data-testid="smart-agent-execution-timeline"]';
  const artifactsSelector = '[data-testid="smart-agent-artifact-cards"]';
  const traceSelector = '[data-testid="smart-agent-trace-panel"]';
  const memorySelector = '[data-testid="smart-agent-memory-panel"]';
  const requestInputSelector = 'textarea[aria-label="输入工作流需求"]';
  const sendSelector = '[data-testid="smart-agent-panel"] button[title="发送"]';
  const approveSelector = '[data-testid="smart-agent-checkpoint-approve"]';
  const routeSpeedSelector = '[data-testid="smart-agent-route-speed"]';
  const memorySuggestionsSelector = '[data-testid="smart-agent-memory-suggestions"]';
  const memoryApplySelector = '[data-testid^="smart-agent-memory-apply-"]';
  const replaySelector = '[data-testid^="smart-agent-replay-"]';
  const toolbarJoinAgentTitleSelector = 'button[title="加入 Agent"]';
  const launcherEntryWaitExpression = `
    (() => {
      const launcherRoot = document.querySelector(${JSON.stringify(launcherSelector)});
      const launcherButton = document.querySelector(${JSON.stringify(launcherButtonSelector)});
      const panel = document.querySelector(${JSON.stringify(panelSelector)});
      const toolbarButton = Array.from(document.querySelectorAll('button')).find((item) => {
        const text = String(item.textContent || '').trim();
        const title = String(item.getAttribute('title') || '').trim();
        const label = String(item.getAttribute('aria-label') || '').trim();
        return (
          text.includes('加入 Agent')
          || title.includes('加入 Agent')
          || label.includes('加入 Agent')
          || label.includes('打开智能机器人')
          || title.includes('打开智能机器人')
        );
      });
      return launcherRoot || launcherButton || toolbarButton || panel
        ? {
            launcherRootVisible: Boolean(launcherRoot),
            launcherButtonVisible: Boolean(launcherButton),
            toolbarButtonVisible: Boolean(toolbarButton),
            panelVisible: Boolean(panel),
          }
        : null;
    })()
  `;
  const collectSmartAgentDebugState = async () => await evalJs(cdp, `
    (() => {
      const launcherRoot = document.querySelector(${JSON.stringify(launcherSelector)});
      const launcherButton = document.querySelector(${JSON.stringify(launcherButtonSelector)});
      const panel = document.querySelector(${JSON.stringify(panelSelector)});
      const checkpointPanel = document.querySelector(${JSON.stringify(checkpointSelector)});
      const currentStep = document.querySelector(${JSON.stringify(currentStepSelector)});
      const toolbarButton = document.querySelector(${JSON.stringify(toolbarJoinAgentTitleSelector)})
        || Array.from(document.querySelectorAll('button')).find((item) => {
          const text = String(item.textContent || '').trim();
          const title = String(item.getAttribute('title') || '').trim();
          const label = String(item.getAttribute('aria-label') || '').trim();
          return (
            text.includes('加入 Agent')
            || title.includes('加入 Agent')
            || label.includes('加入 Agent')
            || label.includes('打开智能机器人')
            || title.includes('打开智能机器人')
          );
        });
      return {
        href: location.href,
        title: document.title,
        readyState: document.readyState,
        launcherRootVisible: Boolean(launcherRoot),
        launcherButtonVisible: Boolean(launcherButton),
        toolbarButtonVisible: Boolean(toolbarButton),
        panelVisible: Boolean(panel),
        checkpointText: String(checkpointPanel?.textContent || '').trim().slice(0, 240),
        currentStepText: String(currentStep?.textContent || '').trim().slice(0, 200),
      };
    })()
  `, 10000).catch(() => null);

  const openSmartAgentPanel = async () => {
    const directClickOk = await evalJs(cdp, `
      (() => {
        const panel = document.querySelector(${JSON.stringify(panelSelector)});
        if (panel) return true;
        const launcherButton = document.querySelector(${JSON.stringify(launcherButtonSelector)});
        const toolbarButton = document.querySelector(${JSON.stringify(toolbarJoinAgentTitleSelector)})
          || Array.from(document.querySelectorAll('button')).find((item) => {
            const text = String(item.textContent || '').trim();
            const title = String(item.getAttribute('title') || '').trim();
            const label = String(item.getAttribute('aria-label') || '').trim();
            return (
              text.includes('加入 Agent')
              || title.includes('加入 Agent')
              || label.includes('加入 Agent')
              || label.includes('打开智能机器人')
              || title.includes('打开智能机器人')
            );
          });
        const launcherFallbackButton = document.querySelector(${JSON.stringify(`${launcherSelector} button:not([data-testid="smart-agent-drag-handle"])`)});
        const target = launcherButton || toolbarButton || launcherFallbackButton;
        if (!(target instanceof HTMLElement)) return false;
        target.click();
        return true;
      })()
    `, 10000).catch(() => false);
    if (!directClickOk) {
      const fallbackClickOk = await evalJs(cdp, `
        (() => {
          const toolbarButton = document.querySelector(${JSON.stringify(toolbarJoinAgentTitleSelector)});
          const launcherFallbackButton = document.querySelector(${JSON.stringify(`${launcherSelector} button:not([data-testid="smart-agent-drag-handle"])`)});
          const target = toolbarButton || launcherFallbackButton;
          if (!(target instanceof HTMLElement)) return false;
          target.click();
          return true;
        })()
      `, 10000).catch(() => false);
      if (!fallbackClickOk) {
        await clickSelectorAtRatio(cdp, launcherButtonSelector, { x: 0.5, y: 0.5 }).catch(() => clickSelector(cdp, launcherButtonSelector));
      }
    }
    await waitForSelector(cdp, panelSelector, 15000);
  };

  try {
  await waitForRoot(cdp, 30000);
  await waitForDebugBridge(cdp, 30000);

  await waitFor(cdp, launcherEntryWaitExpression, 20000, 120);

  const initialOpenState = await evalJs(cdp, `
    (() => ({
      launcherVisible: Boolean(
        document.querySelector(${JSON.stringify(launcherButtonSelector)})
        || document.querySelector(${JSON.stringify(launcherSelector)})
      ),
      toolbarVisible: Boolean(
        document.querySelector(${JSON.stringify(toolbarJoinAgentTitleSelector)})
        || Array.from(document.querySelectorAll('button')).find((item) => {
          const text = String(item.textContent || '').trim();
          const title = String(item.getAttribute('title') || '').trim();
          const label = String(item.getAttribute('aria-label') || '').trim();
          return (
            text.includes('加入 Agent')
            || title.includes('加入 Agent')
            || label.includes('加入 Agent')
            || label.includes('打开智能机器人')
            || title.includes('打开智能机器人')
          );
        })
      ),
      panelVisible: Boolean(document.querySelector(${JSON.stringify(panelSelector)})),
      closeVisible: Boolean(document.querySelector(${JSON.stringify(closeSelector)})),
    }))()
  `, 10000);
  if (initialOpenState.panelVisible && !initialOpenState.launcherVisible) {
    await clickSelector(cdp, closeSelector).catch(() => clickSelectorAtRatio(cdp, closeSelector, { x: 0.5, y: 0.5 }));
    await waitFor(cdp, launcherEntryWaitExpression, 15000, 120);
  } else {
    await waitFor(cdp, launcherEntryWaitExpression, 15000, 120);
  }

  const readLauncherRect = async () => await evalJs(cdp, `
    (() => {
      const element = document.querySelector(${JSON.stringify(launcherSelector)});
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    })()
  `, 10000);

  const readPanelRect = async () => await evalJs(cdp, `
    (() => {
      const element = document.querySelector(${JSON.stringify(panelSelector)});
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    })()
  `, 10000);

  const launcherBeforeDrag = await readLauncherRect();

  await openSmartAgentPanel();
  await waitForSelector(cdp, currentStepSelector, 10000);
  await waitForSelector(cdp, checkpointSelector, 10000);
  await waitForSelector(cdp, routerSelector, 10000);
  await waitForSelector(cdp, timelineSelector, 10000);
  await waitForSelector(cdp, artifactsSelector, 10000);
  await waitForSelector(cdp, traceSelector, 10000);
  await waitForSelector(cdp, memorySelector, 10000);

  await clickSelector(cdp, generateTabSelector).catch(() => clickSelectorAtRatio(cdp, generateTabSelector, { x: 0.5, y: 0.5 }));
  const generateState = await waitFor(cdp, `
    (() => {
      const panel = document.querySelector(${JSON.stringify(panelSelector)});
      const text = panel ? String(panel.textContent || '') : '';
      return panel && (
        text.includes('智能机器人')
        || text.includes('节点生成')
        || text.includes('工作流需求')
      )
        ? {
            generateVisible: true,
            text: text.slice(0, 320),
          }
        : null;
    })()
  `, 10000, 120);

  await clickSelector(cdp, chatTabSelector).catch(() => clickSelectorAtRatio(cdp, chatTabSelector, { x: 0.5, y: 0.5 }));
  const executionState = await waitFor(cdp, `
    (() => {
      const currentStep = document.querySelector(${JSON.stringify(currentStepSelector)});
      const checkpoint = document.querySelector(${JSON.stringify(checkpointSelector)});
      const router = document.querySelector(${JSON.stringify(routerSelector)});
      const timeline = document.querySelector(${JSON.stringify(timelineSelector)});
      const artifacts = document.querySelector(${JSON.stringify(artifactsSelector)});
      const trace = document.querySelector(${JSON.stringify(traceSelector)});
      const memory = document.querySelector(${JSON.stringify(memorySelector)});
      return currentStep && checkpoint && router && timeline && artifacts && trace && memory
        ? {
            currentStepText: String(currentStep.textContent || '').trim(),
            checkpointText: String(checkpoint.textContent || '').trim().slice(0, 220),
            routerText: String(router.textContent || '').trim().slice(0, 240),
            timelineText: String(timeline.textContent || '').trim().slice(0, 240),
            artifactsText: String(artifacts.textContent || '').trim().slice(0, 240),
            traceText: String(trace.textContent || '').trim().slice(0, 220),
            memoryText: String(memory.textContent || '').trim().slice(0, 220),
          }
        : null;
    })()
  `, 10000, 120);

  const checkpointPrompt = '做一张品牌海报，并在计划、执行、交付三个 checkpoint 停下来。';
  await setValue(cdp, requestInputSelector, checkpointPrompt);
  await waitFor(cdp, `
    (() => {
      const input = document.querySelector(${JSON.stringify(requestInputSelector)});
      const sendButton = document.querySelector(${JSON.stringify(sendSelector)});
      const inputValue = input && 'value' in input ? String(input.value || '') : '';
      return inputValue.includes(${JSON.stringify('品牌海报')}) && sendButton instanceof HTMLButtonElement && !sendButton.disabled
        ? {
            inputValue,
            sendDisabled: sendButton.disabled,
          }
        : null;
    })()
  `, 10000, 120);
  await clickSelector(cdp, sendSelector).catch(() => clickSelectorAtRatio(cdp, sendSelector, { x: 0.5, y: 0.5 }));
  await waitFor(cdp, `
    (() => {
      const approveButton = document.querySelector(${JSON.stringify(approveSelector)});
      const checkpointPanel = document.querySelector(${JSON.stringify(checkpointSelector)});
      const text = String(checkpointPanel?.textContent || '').trim();
      return approveButton || text.includes('计划确认') || text.includes('当前等待')
        ? {
            approveVisible: Boolean(approveButton),
            checkpointText: text.slice(0, 240),
          }
        : null;
    })()
  `, 30000, 120);
  await clickSelector(cdp, routeSpeedSelector).catch(() => clickSelectorAtRatio(cdp, routeSpeedSelector, { x: 0.5, y: 0.5 }));

  const workflowCheckpointState = await waitFor(cdp, `
    (() => {
      const currentStep = document.querySelector(${JSON.stringify(currentStepSelector)});
      const checkpoint = document.querySelector(${JSON.stringify(checkpointSelector)});
      const router = document.querySelector(${JSON.stringify(routeSpeedSelector)});
      return currentStep && checkpoint
        ? {
            currentStepText: String(currentStep.textContent || '').trim(),
            checkpointText: String(checkpoint.textContent || '').trim(),
            speedRouteVisible: Boolean(router),
          }
        : null;
    })()
  `, 10000, 120);

  await clickSelector(cdp, approveSelector).catch(() => clickSelectorAtRatio(cdp, approveSelector, { x: 0.5, y: 0.5 }));
  await waitFor(cdp, `
    (() => String(document.querySelector(${JSON.stringify(checkpointSelector)})?.textContent || '').includes('执行确认'))()
  `, 10000, 120);
  await clickSelector(cdp, approveSelector).catch(() => clickSelectorAtRatio(cdp, approveSelector, { x: 0.5, y: 0.5 }));
  await waitFor(cdp, `
    (() => String(document.querySelector(${JSON.stringify(checkpointSelector)})?.textContent || '').includes('交付确认'))()
  `, 15000, 120);
  await clickSelector(cdp, approveSelector).catch(() => clickSelectorAtRatio(cdp, approveSelector, { x: 0.5, y: 0.5 }));

  const completedWorkflowState = await waitFor(cdp, `
    (() => {
      const currentStep = document.querySelector(${JSON.stringify(currentStepSelector)});
      const checkpoint = document.querySelector(${JSON.stringify(checkpointSelector)});
      const memory = document.querySelector(${JSON.stringify(memorySelector)});
      const trace = document.querySelector(${JSON.stringify(traceSelector)});
      const currentStepText = String(currentStep?.textContent || '').trim();
      const checkpointText = String(checkpoint?.textContent || '').trim();
      return currentStepText && !checkpointText.includes('当前等待')
        ? {
            currentStepText,
            checkpointText,
            memoryText: String(memory?.textContent || '').trim().slice(0, 420),
            traceText: String(trace?.textContent || '').trim().slice(0, 320),
          }
        : null;
    })()
  `, 15000, 120);

  await clickSelector(cdp, generateTabSelector).catch(() => clickSelectorAtRatio(cdp, generateTabSelector, { x: 0.5, y: 0.5 }));
  await waitForSelector(cdp, memorySuggestionsSelector, 10000);
  const memorySuggestionState = await evalJs(cdp, `
    (() => {
      const container = document.querySelector(${JSON.stringify(memorySuggestionsSelector)});
      const prompt = document.querySelector('[data-testid="smart-agent-prompt"]');
      return {
        visible: Boolean(container),
        text: String(container?.textContent || '').trim().slice(0, 420),
        promptBeforeApply: prompt && 'value' in prompt ? String(prompt.value || '') : '',
      };
    })()
  `, 10000);
  await clickSelector(cdp, memoryApplySelector).catch(() => clickSelectorAtRatio(cdp, memoryApplySelector, { x: 0.5, y: 0.5 }));
  const memoryAppliedState = await waitFor(cdp, `
    (() => {
      const prompt = document.querySelector('[data-testid="smart-agent-prompt"]');
      const appliedButton = document.querySelector(${JSON.stringify(memoryApplySelector)});
      const promptValue = prompt && 'value' in prompt ? String(prompt.value || '') : '';
      return promptValue.includes('[')
        ? {
            promptAfterApply: promptValue.slice(0, 320),
            applyText: String(appliedButton?.textContent || '').trim(),
          }
        : null;
    })()
  `, 10000, 120);
  const memoryExecutionState = await evalJs(cdp, `
    (async () => {
      const selectedNodeIds = window.__HMDAO_DEBUG__?.canvasStore?.getState?.()?.selectedNodeIds || [];
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.()?.canvas?.nodes || [];
      const node = nodes.find((item) => item.id === selectedNodeIds[0]) || null;
      if (!node) {
        return { __error: 'missing-selected-node-after-memory-apply', selectedNodeIds };
      }
      const body = typeof window.__HMDAO_DEBUG__?.buildGenerationBodyForNode === 'function'
        ? window.__HMDAO_DEBUG__.buildGenerationBodyForNode(node.id)
        : null;
      if (!body) {
        return { __error: 'missing-buildGenerationBodyForNode-debug-bridge' };
      }
      return {
        nodeId: node.id,
        nodeType: node.type,
        sharedMemoryIds: Array.isArray(body?.shared_memory_ids) ? body.shared_memory_ids : [],
        sharedMemoryLayers: Array.isArray(body?.shared_memory_layers) ? body.shared_memory_layers : [],
        sharedMemoryContext: Array.isArray(body?.shared_memory_context) ? body.shared_memory_context : [],
        sharedMemoryRefs: Array.isArray(body?.shared_memory_refs) ? body.shared_memory_refs : [],
        workflowGraphSharedMemories: Array.isArray(body?.workflow_graph?.sharedMemories) ? body.workflow_graph.sharedMemories : [],
        workflowGraphArtifacts: Array.isArray(body?.workflow_graph?.artifacts) ? body.workflow_graph.artifacts : [],
      };
    })()
  `, 20000);

  await clickSelector(cdp, chatTabSelector).catch(() => clickSelectorAtRatio(cdp, chatTabSelector, { x: 0.5, y: 0.5 }));
  await waitForSelector(cdp, replaySelector, 10000);
  await clickSelector(cdp, replaySelector).catch(() => clickSelectorAtRatio(cdp, replaySelector, { x: 0.5, y: 0.5 }));
  const replayState = await waitFor(cdp, `
    (() => {
      const currentStep = document.querySelector(${JSON.stringify(currentStepSelector)});
      const checkpoint = document.querySelector(${JSON.stringify(checkpointSelector)});
      const trace = document.querySelector(${JSON.stringify(traceSelector)});
      const checkpointText = String(checkpoint?.textContent || '').trim();
      return checkpointText.includes('计划确认')
        ? {
            currentStepText: String(currentStep?.textContent || '').trim(),
            checkpointText,
            traceText: String(trace?.textContent || '').trim().slice(0, 320),
          }
        : null;
    })()
  `, 10000, 120);

  const panelBeforeResize = await readPanelRect();
  let panelAfterResize = panelBeforeResize;
  if (isVisibleVerifyRun && !isSmartAgentOnlyRun) {
    await dragSelectorNative(cdp, resizeHandleSelector, { x: 0.5, y: 0.5 }, { x: -3.6, y: -3.2 }, 10);
    panelAfterResize = await waitFor(cdp, `
      (() => {
        const element = document.querySelector(${JSON.stringify(panelSelector)});
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        const width = Math.round(rect.width);
        const height = Math.round(rect.height);
        return (
          Math.abs(width - ${Number(panelBeforeResize?.width || 0)}) >= 24
          || Math.abs(height - ${Number(panelBeforeResize?.height || 0)}) >= 24
        )
          ? {
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              width,
              height,
            }
          : null;
      })()
    `, 10000, 120);
  }

  let launcherAfterDrag = launcherBeforeDrag;
  let reopenedState = await evalJs(cdp, `
    (() => ({
      panelVisible: Boolean(document.querySelector(${JSON.stringify(panelSelector)})),
      currentStepVisible: Boolean(document.querySelector(${JSON.stringify(currentStepSelector)})),
      checkpointVisible: Boolean(document.querySelector(${JSON.stringify(checkpointSelector)})),
      routerVisible: Boolean(document.querySelector(${JSON.stringify(routerSelector)})),
      timelineVisible: Boolean(document.querySelector(${JSON.stringify(timelineSelector)})),
      artifactsVisible: Boolean(document.querySelector(${JSON.stringify(artifactsSelector)})),
      traceVisible: Boolean(document.querySelector(${JSON.stringify(traceSelector)})),
      memoryVisible: Boolean(document.querySelector(${JSON.stringify(memorySelector)})),
    }))()
  `, 10000);
  if (!isSmartAgentOnlyRun) {
    await clickSelector(cdp, closeSelector).catch(() => clickSelectorAtRatio(cdp, closeSelector, { x: 0.5, y: 0.5 }));
    await waitFor(cdp, `!document.querySelector(${JSON.stringify(panelSelector)})`, 10000, 120);
    await waitForSelector(cdp, dragHandleSelector, 10000);

    if (isVisibleVerifyRun) {
      await dragSelectorNative(cdp, dragHandleSelector, { x: 0.5, y: 0.5 }, { x: -6, y: -6 }, 12);
      launcherAfterDrag = await waitFor(cdp, `
        (() => {
          const element = document.querySelector(${JSON.stringify(launcherSelector)});
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          const x = Math.round(rect.left);
          const y = Math.round(rect.top);
          return (
            Math.abs(x - ${Number(launcherBeforeDrag?.x || 0)}) >= 20
            || Math.abs(y - ${Number(launcherBeforeDrag?.y || 0)}) >= 20
          )
            ? {
                x,
                y,
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              }
            : null;
        })()
      `, 10000, 120);
    }

    await openSmartAgentPanel();

    reopenedState = await evalJs(cdp, `
      (() => ({
        panelVisible: Boolean(document.querySelector(${JSON.stringify(panelSelector)})),
        currentStepVisible: Boolean(document.querySelector(${JSON.stringify(currentStepSelector)})),
        checkpointVisible: Boolean(document.querySelector(${JSON.stringify(checkpointSelector)})),
        routerVisible: Boolean(document.querySelector(${JSON.stringify(routerSelector)})),
        timelineVisible: Boolean(document.querySelector(${JSON.stringify(timelineSelector)})),
        artifactsVisible: Boolean(document.querySelector(${JSON.stringify(artifactsSelector)})),
        traceVisible: Boolean(document.querySelector(${JSON.stringify(traceSelector)})),
        memoryVisible: Boolean(document.querySelector(${JSON.stringify(memorySelector)})),
      }))()
    `, 10000);
  }

  assert(generateState?.generateVisible, 'SmartAgent generate tab did not render the embedded node generate panel.', generateState);
  assert(Boolean(executionState?.currentStepText), 'SmartAgent current-step view did not render.', executionState);
  assert(
    workflowCheckpointState?.checkpointText?.includes('计划确认'),
    'SmartAgent workflow checkpoint did not stop at the plan confirmation stage.',
    workflowCheckpointState,
  );
  assert(
    completedWorkflowState?.currentStepText && !completedWorkflowState?.checkpointText?.includes('当前等待'),
    'SmartAgent workflow did not complete the full checkpoint chain.',
    completedWorkflowState,
  );
  assert(memorySuggestionState?.visible, 'SmartAgent generate panel did not render shared memory suggestions.', memorySuggestionState);
  assert(
    memoryAppliedState?.promptAfterApply?.includes('[') && memoryAppliedState?.applyText?.includes('已应用'),
    'SmartAgent shared memory did not write back into the prompt area.',
    memoryAppliedState,
  );
  assert(!memoryExecutionState?.__error, 'SmartAgent memory execution verification could not build a node request body.', memoryExecutionState);
  assert(
    Array.isArray(memoryExecutionState?.sharedMemoryIds) && memoryExecutionState.sharedMemoryIds.length > 0,
    'Selected shared memory was not propagated into the node request body.',
    memoryExecutionState,
  );
  assert(
    Array.isArray(memoryExecutionState?.sharedMemoryRefs) && memoryExecutionState.sharedMemoryRefs.length > 0,
    'Selected shared memory was not serialized into shared_memory_refs.',
    memoryExecutionState,
  );
  assert(
    Array.isArray(memoryExecutionState?.workflowGraphSharedMemories) && memoryExecutionState.workflowGraphSharedMemories.length > 0,
    'Selected shared memory was not written into workflow_graph.sharedMemories.',
    memoryExecutionState,
  );
  assert(
    Array.isArray(memoryExecutionState?.workflowGraphArtifacts)
      && memoryExecutionState.workflowGraphArtifacts.some((artifact) => String(artifact?.kind || '') === 'memory-pack'),
    'workflow_graph did not include the memory-pack artifact after applying shared memory.',
    memoryExecutionState,
  );
  assert(
    replayState?.checkpointText?.includes('计划确认'),
    'SmartAgent trace replay did not rebuild the original checkpoint flow.',
    replayState,
  );
  if (isVisibleVerifyRun && !isSmartAgentOnlyRun) {
    assert(panelBeforeResize && panelAfterResize, 'SmartAgent panel resize verification did not complete.', { panelBeforeResize, panelAfterResize });
    assert(
      Math.abs(Number(panelAfterResize.width || 0) - Number(panelBeforeResize.width || 0)) >= 24
        || Math.abs(Number(panelAfterResize.height || 0) - Number(panelBeforeResize.height || 0)) >= 24,
      'SmartAgent resize handle did not change the panel size.',
      { panelBeforeResize, panelAfterResize },
    );
    assert(launcherBeforeDrag && launcherAfterDrag, 'SmartAgent drag verification did not produce launcher geometry.', { launcherBeforeDrag, launcherAfterDrag });
    assert(
      Math.abs(Number(launcherAfterDrag.x || 0) - Number(launcherBeforeDrag.x || 0)) >= 20
        || Math.abs(Number(launcherAfterDrag.y || 0) - Number(launcherBeforeDrag.y || 0)) >= 20,
      'SmartAgent drag handle did not move the launcher.',
      { launcherBeforeDrag, launcherAfterDrag },
    );
  }
  assert(
    reopenedState.panelVisible
      && reopenedState.currentStepVisible
      && reopenedState.checkpointVisible
      && reopenedState.routerVisible
      && reopenedState.timelineVisible
      && reopenedState.artifactsVisible
      && reopenedState.traceVisible
      && reopenedState.memoryVisible,
    'SmartAgent did not reopen into the expected execution view.',
    reopenedState,
  );

  const result = {
    launcherBeforeDrag,
    launcherAfterDrag,
    panelBeforeResize,
    panelAfterResize,
    generateState,
    executionState,
    workflowCheckpointState,
    completedWorkflowState,
    memorySuggestionState,
    memoryAppliedState,
    memoryExecutionState,
    replayState,
    reopenedState,
  };
  await recorder('smart-agent-visible-regression', result);
  return result;
  } catch (error) {
    const failureState = await collectSmartAgentDebugState();
    const skippedState = {
      skipped: true,
      reason: 'smart-agent-regression-skipped',
      error: error instanceof Error ? error.message : String(error),
      debugState: failureState,
    };
    await recorder(isSmartAgentOnlyRun ? 'smart-agent-visible-regression-failed' : 'smart-agent-visible-regression-skipped', skippedState);
    if (isSmartAgentOnlyRun) {
      throw error;
    }
    return skippedState;
  }
}

async function verifyCanvasGroupingRegression(cdp, recorder) {
  const targetUrl = buildUiOnlyCanvasUrl(true, 'canvas-migration');
  await navigateAndWait(cdp, targetUrl, 'location.pathname === "/" && !!document.getElementById("root") && !!document.body');
  await waitForRoot(cdp);
  await waitForDebugBridge(cdp);
  await waitForSelector(cdp, '[data-testid="canvas-migration-banner"]', 30000);
  await waitFor(cdp, `
    (() => {
      const ids = Array.from(document.querySelectorAll('.react-flow__node')).map((item) => item.getAttribute('data-id')).filter(Boolean);
      return ids.length >= 2 ? ids : null;
    })()
  `, 30000, 150);

  const singleNodeState = await evalJs(cdp, `
    (() => {
      const firstNode = document.querySelector('.react-flow__node');
      if (!firstNode) return null;
      firstNode.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      return {
        selectedCount: document.querySelectorAll('.react-flow__node.selected').length,
        selectionLabel: String(document.querySelector('[data-testid="group-toolbar-selection-label"]')?.textContent || ''),
        groupButtonVisible: Boolean(document.querySelector('[data-testid="group-toolbar-group-button"]')),
      };
    })()
  `, 15000);
  assert(singleNodeState && singleNodeState.groupButtonVisible === false, 'Single-select still exposed the group button.', singleNodeState);

  const selectionBox = await evalJs(cdp, `
    (() => {
      const nodes = Array.from(document.querySelectorAll('.react-flow__node')).slice(0, 2);
      if (nodes.length < 2) return null;
      const rects = nodes.map((node) => node.getBoundingClientRect());
      const left = Math.min(...rects.map((rect) => rect.left));
      const top = Math.min(...rects.map((rect) => rect.top));
      const right = Math.max(...rects.map((rect) => rect.right));
      const bottom = Math.max(...rects.map((rect) => rect.bottom));
      return {
        start: { x: Math.max(24, left - 24), y: Math.max(24, top - 24) },
        end: { x: right + 24, y: bottom + 24 },
      };
    })()
  `, 15000);
  assert(selectionBox?.start && selectionBox?.end, 'Unable to resolve grouping selection box.', selectionBox);
  await dragCanvasSelection(cdp, selectionBox.start, selectionBox.end, { shift: true, steps: 14 });

  const shiftDragState = await waitFor(cdp, `
    (() => {
      const active = document.activeElement;
      const tag = String(active?.tagName || '');
      const isEditable = Boolean(active && ((active.isContentEditable) || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'));
      const selectedCount = document.querySelectorAll('.react-flow__node.selected').length;
      const selectionLabel = String(document.querySelector('[data-testid="group-toolbar-selection-label"]')?.textContent || '');
      const groupButtonVisible = Boolean(document.querySelector('[data-testid="group-toolbar-group-button"]'));
      const renameInputCount = document.querySelectorAll('[data-testid^="canvas-group-name-input-"]').length;
      return selectedCount >= 2 && groupButtonVisible
        ? {
            selectedCount,
            selectionLabel,
            groupButtonVisible,
            renameInputCount,
            activeTag: tag,
            activeIsEditable: isEditable,
          }
        : null;
    })()
  `, 30000, 150);
  assert(shiftDragState.renameInputCount === 0, 'Shift-drag selection should not open rename mode before grouping.', shiftDragState);
  assert(shiftDragState.activeIsEditable === false, 'Shift-drag selection left focus in an editable element.', shiftDragState);

  await clickSelector(cdp, '[data-testid="group-toolbar-group-button"]');
  const renameState = await waitFor(cdp, `
    (() => {
      const input = document.querySelector('[data-testid^="canvas-group-name-input-"]');
      if (!input) return null;
      return {
        testId: String(input.getAttribute('data-testid') || ''),
        value: String(input.value || ''),
        activeTag: String(document.activeElement?.tagName || ''),
        autoFocused: document.activeElement === input,
      };
    })()
  `, 15000, 120);
  assert(renameState.autoFocused, 'Grouping did not auto-focus the rename input.', renameState);

  const renamedLabel = `回归分组 ${Date.now().toString().slice(-4)}`;
  await setValue(cdp, `[data-testid="${renameState.testId}"]`, renamedLabel);
  await pressKey(cdp, 'Enter');
  const renamedState = await waitFor(cdp, `
    (() => {
      const chips = Array.from(document.querySelectorAll('[data-testid^="canvas-group-chip-"]'));
      const matched = chips.find((item) => String(item.textContent || '').trim() === ${JSON.stringify(renamedLabel)});
      return matched
        ? {
            renamedLabel: String(matched.textContent || '').trim(),
            chipTestId: String(matched.getAttribute('data-testid') || ''),
            renameInputCount: document.querySelectorAll('[data-testid^="canvas-group-name-input-"]').length,
          }
        : null;
    })()
  `, 15000, 120);
  assert(renamedState.renameInputCount === 0, 'Rename input did not close after confirming group name.', renamedState);

  const result = {
    targetUrl,
    singleNodeState,
    shiftDragState,
    renameState,
    renamedState,
  };
  await recorder('canvas-grouping-regression', result);
  return result;
}

async function addFixtureMediaNode(cdp, type, label, position, media = {}) {
  const nodeId = await evalJs(cdp, `
    (async () => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      if (!store || typeof store.addNode !== 'function' || typeof store.updateNodeData !== 'function') return '';
      const id = store.addNode(${JSON.stringify(type)}, ${JSON.stringify(position)}) || '';
      if (!id) return '';
      const svg = ${JSON.stringify(`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640" viewBox="0 0 960 640"><rect width="960" height="640" fill="#0f766e"/><text x="80" y="360" fill="#ffffff" font-size="72" font-family="Arial, sans-serif">${label}</text></svg>`)};
      const imageUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      const videoUrl = ${JSON.stringify(media.videoUrl || 'https://example.com/reference.mp4')};
      const payload = ${JSON.stringify({
        label,
        status: 'completed',
        aspectRatio: '16:9',
        duration: 5,
        params: {},
      })};
      if (${JSON.stringify(type)} === 'image') {
        store.updateNodeData(id, {
          ...payload,
          imageUrl,
          outputs: [{ id: 'fixture-image-' + Date.now(), type: 'image', url: imageUrl, metadata: { source: 'verify-fixture', label: ${JSON.stringify(label)} } }],
        });
      } else {
        store.updateNodeData(id, {
          ...payload,
          videoUrl,
          outputs: [{ id: 'fixture-video-' + Date.now(), type: 'video', url: videoUrl, metadata: { source: 'verify-fixture', label: ${JSON.stringify(label)} } }],
        });
      }
      return id;
    })()
  `, 15000);
  assert(nodeId, `Failed to create ${type} fixture node.`);
  return nodeId;
}

async function addStoreNode(cdp, type, position) {
  const nodeId = await evalJs(cdp, `
    (() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      if (!store || typeof store.addNode !== 'function') return '';
      return store.addNode(${JSON.stringify(type)}, ${JSON.stringify(position)}) || '';
    })()
  `, 10000);
  assert(nodeId, `Failed to create ${type} node via canvas store.`);
  return nodeId;
}

async function patchNodeData(cdp, nodeId, patch) {
  const ok = await evalJs(cdp, `
    (() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      if (!store || typeof store.updateNodeData !== 'function') return false;
      store.updateNodeData(${JSON.stringify(nodeId)}, ${JSON.stringify(patch)});
      return true;
    })()
  `, 10000);
  assert(ok, `Failed to patch node data for ${nodeId}.`, patch);
}

async function connectNodes(cdp, sourceId, targetId, targetHandle, sourceHandle = 'media-output') {
  const ok = await evalJs(cdp, `
    (() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      if (!store || typeof store.addEdge !== 'function') return false;
      store.addEdge(${JSON.stringify(sourceId)}, ${JSON.stringify(targetId)}, {
        sourceHandle: ${JSON.stringify(sourceHandle)},
        targetHandle: ${JSON.stringify(targetHandle)},
      });
      return true;
    })()
  `, 10000);
  assert(ok, `Failed to connect ${sourceId} -> ${targetId} (${targetHandle}).`);
}

async function countSelector(cdp, selector) {
  return await evalJs(cdp, `document.querySelectorAll(${JSON.stringify(selector)}).length`, 10000);
}

async function countNodeTargetHandles(cdp, nodeId, handlePrefix) {
  return await countSelector(
    cdp,
    `.react-flow__node[data-id="${nodeId}"] .react-flow__handle.target[data-handleid^="${handlePrefix}"]`,
  );
}

async function findCanvasEdgeId(cdp, sourceId, targetId, targetHandle) {
  return await evalJs(cdp, `
    (() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      const edges = Array.isArray(store?.canvas?.edges) ? store.canvas.edges : [];
      const match = edges.find((edge) =>
        edge?.source === ${JSON.stringify(sourceId)}
        && edge?.target === ${JSON.stringify(targetId)}
        && String(edge?.targetHandle || '') === ${JSON.stringify(targetHandle)}
      );
      return String(match?.id || '');
    })()
  `, 10000);
}

async function removeCanvasEdge(cdp, edgeId) {
  const ok = await evalJs(cdp, `
    (() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      if (!store || typeof store.removeEdge !== 'function') return false;
      store.removeEdge(${JSON.stringify(edgeId)});
      return true;
    })()
  `, 10000);
  assert(ok, `Failed to remove edge ${edgeId}.`);
}

async function verifyDynamicReferencePorts(cdp, recorder, imageNodeId, videoNodeId) {
  const imageInitialSubject = await countNodeTargetHandles(cdp, imageNodeId, 'image-subject-reference-');
  const imageInitialLighting = await countNodeTargetHandles(cdp, imageNodeId, 'image-lighting-reference-');
  const videoImageInitial = await countSelector(cdp, `[data-testid^="video-handle-image-reference-${videoNodeId}-"]`);
  const videoVideoInitial = await countSelector(cdp, `[data-testid^="video-handle-video-reference-${videoNodeId}-"]`);

  const imagePrimaryId = await addFixtureMediaNode(cdp, 'image', 'Image Main', { x: 120, y: 120 });
  const imageSubjectId = await addFixtureMediaNode(cdp, 'image', 'Image Subject Ref', { x: 120, y: 260 });
  const imageLightingId = await addFixtureMediaNode(cdp, 'image', 'Image Lighting Ref', { x: 120, y: 400 });
  const videoPrimaryId = await addFixtureMediaNode(cdp, 'image', 'Video Main', { x: 520, y: 120 });
  const videoRefImageId = await addFixtureMediaNode(cdp, 'image', 'Video Ref Image', { x: 520, y: 260 });
  const videoRefVideoId = await addFixtureMediaNode(cdp, 'video', 'Video Ref Motion', { x: 520, y: 400 }, { videoUrl: 'https://example.com/reference.mp4' });

  await connectNodes(cdp, imagePrimaryId, imageNodeId, 'image-main');
  await connectNodes(cdp, imageSubjectId, imageNodeId, 'image-subject-reference-0');
  await waitFor(cdp, `
    document.querySelectorAll(${JSON.stringify(`.react-flow__node[data-id="${imageNodeId}"] .react-flow__handle.target[data-handleid^="image-subject-reference-"]`)}).length >= ${imageInitialSubject + 1}
  `, 10000);
  await connectNodes(cdp, imageLightingId, imageNodeId, 'image-lighting-reference-0');
  await waitFor(cdp, `
    document.querySelectorAll(${JSON.stringify(`.react-flow__node[data-id="${imageNodeId}"] .react-flow__handle.target[data-handleid^="image-lighting-reference-"]`)}).length >= ${imageInitialLighting + 1}
  `, 10000);

  await connectNodes(cdp, videoPrimaryId, videoNodeId, 'video-main');
  await connectNodes(cdp, videoRefImageId, videoNodeId, 'video-image-reference-0');
  await waitFor(cdp, `document.querySelectorAll(${JSON.stringify(`[data-testid^="video-handle-image-reference-${videoNodeId}-"]`)}).length >= ${videoImageInitial + 1}`, 10000);
  await connectNodes(cdp, videoRefVideoId, videoNodeId, 'video-video-reference-0');
  await waitFor(cdp, `document.querySelectorAll(${JSON.stringify(`[data-testid^="video-handle-video-reference-${videoNodeId}-"]`)}).length >= ${videoVideoInitial + 1}`, 10000);

  const imageSubjectEdgeId = await findCanvasEdgeId(cdp, imageSubjectId, imageNodeId, 'image-subject-reference-0');
  const imageLightingEdgeId = await findCanvasEdgeId(cdp, imageLightingId, imageNodeId, 'image-lighting-reference-0');
  assert(imageSubjectEdgeId, 'Failed to locate image subject edge for lifecycle verification.', { imageNodeId, imageSubjectId });
  assert(imageLightingEdgeId, 'Failed to locate image lighting edge for lifecycle verification.', { imageNodeId, imageLightingId });

  await removeCanvasEdge(cdp, imageSubjectEdgeId);
  await waitFor(cdp, `
    document.querySelectorAll(${JSON.stringify(`.react-flow__node[data-id="${imageNodeId}"] .react-flow__handle.target[data-handleid^="image-subject-reference-"]`)}).length === ${imageInitialSubject}
  `, 10000);
  await removeCanvasEdge(cdp, imageLightingEdgeId);
  await waitFor(cdp, `
    document.querySelectorAll(${JSON.stringify(`.react-flow__node[data-id="${imageNodeId}"] .react-flow__handle.target[data-handleid^="image-lighting-reference-"]`)}).length === ${imageInitialLighting}
  `, 10000);

  const imageLifecycleState = await evalJs(cdp, `
    (() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      const node = (store?.canvas?.nodes || []).find((item) => item.id === ${JSON.stringify(imageNodeId)}) || null;
      const nodeRoot = document.querySelector(${JSON.stringify(`.react-flow__node[data-id="${imageNodeId}"]`)});
      const subjectHandles = Array.from(nodeRoot?.querySelectorAll('.react-flow__handle.target[data-handleid^="image-subject-reference-"]') || [])
        .map((item) => item.getAttribute('data-handleid'));
      const lightingHandles = Array.from(nodeRoot?.querySelectorAll('.react-flow__handle.target[data-handleid^="image-lighting-reference-"]') || [])
        .map((item) => item.getAttribute('data-handleid'));
      const inputs = Array.isArray(node?.data?.inputs) ? node.data.inputs : [];
      const referenceSettings = node?.data?.params?.referenceSettings && typeof node.data.params.referenceSettings === 'object'
        ? node.data.params.referenceSettings
        : {};
      return {
        subjectHandles,
        lightingHandles,
        inputs,
        referenceSettingsKeys: Object.keys(referenceSettings || {}),
      };
    })()
  `, 10000);
  assert(
    Array.isArray(imageLifecycleState?.subjectHandles) && imageLifecycleState.subjectHandles.length === imageInitialSubject,
    'Image subject handles did not collapse back after disconnect.',
    imageLifecycleState,
  );
  assert(
    Array.isArray(imageLifecycleState?.lightingHandles) && imageLifecycleState.lightingHandles.length === imageInitialLighting,
    'Image lighting handles did not collapse back after disconnect.',
    imageLifecycleState,
  );
  assert(
    Array.isArray(imageLifecycleState?.inputs) && imageLifecycleState.inputs.length <= 1,
    'Image node retained stale reference inputs after disconnect.',
    imageLifecycleState,
  );

  await recorder('dynamic-reference-ports-verified', {
    imageNodeId,
    videoNodeId,
    imageInitialSubject,
    imageInitialLighting,
    videoImageInitial,
    videoVideoInitial,
    imageSubjectAfter: await countNodeTargetHandles(cdp, imageNodeId, 'image-subject-reference-'),
    imageLightingAfter: await countNodeTargetHandles(cdp, imageNodeId, 'image-lighting-reference-'),
    videoImageAfter: await countSelector(cdp, `[data-testid^="video-handle-image-reference-${videoNodeId}-"]`),
    videoVideoAfter: await countSelector(cdp, `[data-testid^="video-handle-video-reference-${videoNodeId}-"]`),
    imageLifecycleState,
  });
}

async function configureReferencePanel(cdp, recorder, nodeId, target, settings) {
  await selectNodeById(cdp, nodeId);
  await waitForNodeSelection(cdp, nodeId);
  const toggleSelector = `[data-testid="${target}-reference-toggle-${nodeId}"]`;
  const panelSelector = `[data-testid="${target}-reference-panel-${nodeId}"]`;
  const toggleExists = await evalJs(cdp, `Boolean(document.querySelector(${JSON.stringify(toggleSelector)}))`, 10000);
  if (toggleExists) {
    const panelOpen = await evalJs(cdp, `Boolean(document.querySelector(${JSON.stringify(panelSelector)}))`, 10000);
    if (!panelOpen) {
      await clickSelector(cdp, toggleSelector);
      await waitForSelector(cdp, panelSelector, 10000);
    }
  }
  for (const setting of settings) {
    if (setting.role) await setValue(cdp, `[data-testid="reference-role-${nodeId}-${setting.index}"]`, setting.role);
    if (setting.weight !== undefined) await setValue(cdp, `[data-testid="reference-weight-${nodeId}-${setting.index}"]`, String(setting.weight));
  }
  const summary = await evalJs(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
      return {
        inputs: node?.data?.inputs || [],
        params: node?.data?.params || {},
      };
    })()
  `, 10000);
  await recorder(`${target}-reference-panel-configured`, { nodeId, summary, settings });
  return summary;
}

async function verifyNodeModelEconomicsVisible(cdp, recorder, nodeId, nodeType) {
  await selectNodeById(cdp, nodeId);
  await waitForNodeSelection(cdp, nodeId);
  const state = await evalJs(cdp, `
    (() => {
      const nodeRoot = document.querySelector(${JSON.stringify(`[data-testid="${nodeType}-node-${nodeId}"]`)});
      const panelRoot = nodeRoot?.parentElement || nodeRoot;
      const text = String(panelRoot?.textContent || '');
      const hasProvider = text.includes('\u9009\u62e9\u5e73\u53f0');
      const hasUpstream = text.includes('\u5b9e\u9645\u4e0a\u6e38');
      const hasEta = text.includes('\u9884\u4f30\u8017\u65f6') || text.includes('\u8017\u65f6');
      const hasCost = text.includes('\u9884\u4f30\u8d39\u7528') || text.includes('\u5355\u6b21');
      return { nodeId: ${JSON.stringify(nodeId)}, nodeType: ${JSON.stringify(nodeType)}, text, hasProvider, hasUpstream, hasEta, hasCost };
    })()
  `, 10000);
  assert(state.hasProvider, `${nodeType} node did not expose selected provider text.`, state);
  assert(state.hasUpstream, `${nodeType} node did not expose upstream model text.`, state);
  assert(state.hasEta, `${nodeType} node did not expose ETA text.`, state);
  assert(state.hasCost, `${nodeType} node did not expose estimated cost text.`, state);
  await recorder(`${nodeType}-model-economics-visible`, state);
  return state;
}

async function verifyActivatedVideoModel(cdp, recorder, nodeId) {
  const toggleSelector = `[data-testid="video-model-toggle-${nodeId}"]`;
  const preferredIds = ['wan22-i2v-a14b', 'wan22-t2v-a14b', 'bailian-wan22-i2v-plus', 'bailian-wan22-t2v-plus'];
  const isActiveText = "text.includes('\\u5df2\\u6fc0\\u6d3b') || text.includes('\\u5df2\\u9a8c\\u8bc1\\u6b64\\u6a21\\u578b') || text.includes('\\u5e73\\u53f0\\u5df2\\u6fc0\\u6d3b') || text.includes('Activated')";
  await clickSelector(cdp, toggleSelector);
  await waitFor(cdp, `
    (() => {
      const ids = ${JSON.stringify(preferredIds)};
      return ids.some((modelId) => {
        const option = document.querySelector(${JSON.stringify(`[data-testid="video-model-option-${nodeId}-`)} + modelId + ${JSON.stringify(`"]`)});
        const text = option ? String(option.textContent || '') : '';
        return Boolean(option && (${isActiveText}));
      });
    })()
  `, 20000, 200);
  const menuState = await evalJs(cdp, `
    (() => {
      const ids = ${JSON.stringify(preferredIds)};
      return ids.map((modelId) => {
        const option = document.querySelector(${JSON.stringify(`[data-testid="video-model-option-${nodeId}-`)} + modelId + ${JSON.stringify(`"]`)});
        const text = option ? String(option.textContent || '') : '';
        return {
          modelId,
          exists: Boolean(option),
          text,
          activated: Boolean(option && (${isActiveText})),
        };
      });
    })()
  `, 10000);
  const preferredModelId = menuState.find((item) => item.activated && item.modelId.startsWith('wan22-'))?.modelId
    || menuState.find((item) => item.activated)?.modelId
    || preferredIds.find((modelId) => menuState.some((item) => item.modelId === modelId && item.exists))
    || preferredIds[0];
  await clickSelector(cdp, `[data-testid="video-model-option-${nodeId}-${preferredModelId}"]`);
  await waitFor(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
      const provider = String(node?.data?.provider || '');
      return String(node?.data?.model || '') === ${JSON.stringify(preferredModelId)}
        && (provider === 'siliconflow' || provider === 'bailian');
    })()
  `, 15000, 150);
  await recorder('video-model-activated-verified', { nodeId, preferredModelId, menuState });
  return preferredModelId;
}
async function verifyVideoPanelLegacy(cdp, recorder, nodeId, imagePath) {
  const modelToggleSelector = `[data-testid="video-model-toggle-${nodeId}"]`;
  const optionSelectorPrefix = `[data-testid^="video-model-option-${nodeId}-"]`;
  const nodeSelector = `[data-testid="video-node-${nodeId}"]`;
  const promptSelector = `[data-testid="video-prompt-${nodeId}"]`;
  const translateSelector = `[data-testid="video-translate-${nodeId}"]`;
  const optimizeSelector = `[data-testid="video-optimize-${nodeId}"]`;
  const fileInputSelector = `[data-testid="video-node-${nodeId}"] input[type="file"]`;
  const countSelector = `[data-testid="video-count-${nodeId}"]`;

  async function activateVideoTool(tool) {
    const toolbarSelector = `[data-testid="video-toolbar-${nodeId}-${tool}"]`;
    const inlineSelector = `[data-testid="video-tool-${nodeId}-${tool}"]`;
    const targetSelector = await evalJs(cdp, `
      (() => {
        if (document.querySelector(${JSON.stringify(toolbarSelector)})) return ${JSON.stringify(toolbarSelector)};
        if (document.querySelector(${JSON.stringify(inlineSelector)})) return ${JSON.stringify(inlineSelector)};
        return '';
      })()
    `, 10000);
    assert(targetSelector, `No video tool activator found for ${tool}.`, { nodeId, toolbarSelector, inlineSelector });
    await clickSelector(cdp, targetSelector);
  }

  await clickSelector(cdp, modelToggleSelector);
  await waitFor(cdp, `(() => document.querySelectorAll(${JSON.stringify(optionSelectorPrefix)}).length > 0)()`, 15000);
  const selectedVideoModelId = await evalJs(cdp, `
    (() => {
      const preferred = ['wan22-i2v-a14b', 'wan22-t2v-a14b'];
      const activationLabels = ['???', '??????', '?????', 'Activated'];
      const currentModel = (() => {
        const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
        const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
        return String(node?.data?.model || '');
      })();
      if (preferred.includes(currentModel)) return currentModel;
      const options = [...document.querySelectorAll(${JSON.stringify(optionSelectorPrefix)})]
        .map((item) => ({
          id: (item.getAttribute('data-testid') || '').replace(${JSON.stringify(`video-model-option-${nodeId}-`)}, ''),
          text: item.textContent || '',
        }))
        .filter((item) => item.id);
      const activatedPreferred = preferred.find((modelId) => options.some((item) => item.id === modelId && activationLabels.some((label) => item.text.includes(label))));
      if (activatedPreferred) return activatedPreferred;
      const availablePreferred = preferred.find((modelId) => options.some((item) => item.id === modelId));
      if (availablePreferred) return availablePreferred;
      return options[0]?.id || '';
    })()
  `, 10000);
  assert(selectedVideoModelId, 'No usable video model option was rendered.', { nodeId });
  await clickSelector(cdp, `[data-testid="video-model-option-${nodeId}-${selectedVideoModelId}"]`);
  await waitFor(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
      return String(node?.data?.model || '') === ${JSON.stringify(selectedVideoModelId)};
    })()
  `, 10000, 100);

  await setValue(cdp, promptSelector, 'video panel verification prompt');
  await setValue(cdp, countSelector, '3');
  await clickSelector(cdp, `[data-testid="video-mode-${nodeId}-imageToVideo"]`);
  await clickSelector(cdp, `[data-testid="video-source-upload-${nodeId}"]`);
  await setFileInputFiles(cdp, fileInputSelector, [imagePath]);
  await waitFor(cdp, `(() => {
    const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
    const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
    const params = node?.data?.params || {};
    return String(params.generationMode || '') === 'imageToVideo' && String(params.sourceUrl || '') !== '';
  })()`, 15000, 100);

  await clickSelector(cdp, `[data-testid="video-mode-${nodeId}-firstLastFrame"]`);
  await clickSelector(cdp, `[data-testid="video-first-frame-upload-${nodeId}"]`);
  await setFileInputFiles(cdp, fileInputSelector, [imagePath]);
  await clickSelector(cdp, `[data-testid="video-last-frame-upload-${nodeId}"]`);
  await setFileInputFiles(cdp, fileInputSelector, [imagePath]);
  await waitFor(cdp, `(() => {
    const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
    const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
    const params = node?.data?.params || {};
    return String(params.generationMode || '') === 'firstLastFrame'
      && String(params.firstFrameUrl || '') !== ''
      && String(params.lastFrameUrl || '') !== '';
  })()`, 15000, 100);

  await clickSelector(cdp, `[data-testid="video-mode-${nodeId}-referenceVideo"]`);
  await clickSelector(cdp, `[data-testid="video-reference-image-upload-${nodeId}"]`);
  await setFileInputFiles(cdp, fileInputSelector, [imagePath]);
  await waitFor(cdp, `(() => {
    const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
    const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
    const params = node?.data?.params || {};
    return String(params.generationMode || '') === 'referenceVideo' && String(params.referenceImageUrl || '') !== '';
  })()`, 15000, 100);

  await clickSelector(cdp, `[data-testid="video-mode-${nodeId}-firstLastFrame"]`);
  await setValue(cdp, `[data-testid="video-aspect-${nodeId}"]`, '9:16');
  await setValue(cdp, `[data-testid="video-quality-${nodeId}"]`, '480p');
  await setValue(cdp, `[data-testid="video-duration-${nodeId}"]`, '5');
  await setValue(cdp, `[data-testid="video-motion-${nodeId}"]`, 'orbit-up');

  const toolMatrix = [
    {
      tool: 'clip',
      panelTitle: '\u526a\u8f91\u5de5\u5177\u9762\u677f',
      operationIncludes: 'trim',
      apply: async () => {
        await activateVideoTool('clip');
        await assertPanelContains(cdp, `[data-testid="video-tool-panel-${nodeId}"]`, '\u526a\u8f91\u5de5\u5177\u9762\u677f');
        await setValue(cdp, `[data-testid="video-clip-start-panel-${nodeId}"]`, '0.8');
        await setValue(cdp, `[data-testid="video-clip-end-panel-${nodeId}"]`, '3.6');
      },
      assertState: async () => waitFor(cdp, `
        (() => {
          const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
          const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
          const params = node?.data?.params || {};
          return String(params.videoTool || '') === 'clip'
            && String(params.videoToolOperation || '').includes('trim')
            && Number(params.videoToolConfig?.startTime || 0) >= 0.79
            && Number(params.videoToolConfig?.endTime || 0) >= 3.59;
        })()
      `, 10000, 100),
    },
    {
      tool: 'crop',
      panelTitle: '\u88c1\u526a\u5de5\u5177\u9762\u677f',
      operationIncludes: 'crop',
      apply: async () => {
        await activateVideoTool('crop');
        await assertPanelContains(cdp, `[data-testid="video-tool-panel-${nodeId}"]`, '\u88c1\u526a\u5de5\u5177\u9762\u677f');
        await setValue(cdp, `[data-testid="video-crop-x-panel-${nodeId}"]`, '12');
        await setValue(cdp, `[data-testid="video-crop-y-panel-${nodeId}"]`, '9');
        await setValue(cdp, `[data-testid="video-crop-width-panel-${nodeId}"]`, '74');
        await setValue(cdp, `[data-testid="video-crop-height-panel-${nodeId}"]`, '68');
      },
      assertState: async () => waitFor(cdp, `
        (() => {
          const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
          const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
          const params = node?.data?.params || {};
          return String(params.videoTool || '') === 'crop'
            && String(params.videoToolOperation || '').includes('crop')
            && Number(params.videoToolConfig?.x || 0) === 12
            && Number(params.videoToolConfig?.y || 0) === 9
            && Number(params.videoToolConfig?.widthPercent || 0) === 74
            && Number(params.videoToolConfig?.heightPercent || 0) === 68;
        })()
      `, 10000, 100),
    },
    {
      tool: 'parse',
      panelTitle: '\u89e3\u6790\u5de5\u5177\u9762\u677f',
      operationIncludes: 'parse',
      apply: async () => {
        await activateVideoTool('parse');
        await assertPanelContains(cdp, `[data-testid="video-tool-panel-${nodeId}"]`, '\u89e3\u6790\u5de5\u5177\u9762\u677f');
        await clickSelector(cdp, `[data-testid="video-tool-panel-${nodeId}"] input[type="checkbox"]`);
        await setValue(cdp, `[data-testid="video-parse-fps-panel-${nodeId}"]`, '5');
      },
      assertState: async () => waitFor(cdp, `
        (() => {
          const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
          const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
          const params = node?.data?.params || {};
          return String(params.videoTool || '') === 'parse'
            && String(params.videoToolOperation || '').includes('parse')
            && params.videoToolConfig?.sceneDetect === false
            && Number(params.videoToolConfig?.sampleFps || 0) === 5;
        })()
      `, 10000, 100),
    },
    {
      tool: 'removeSubtitle',
      panelTitle: '\u53bb\u5b57\u5e55\u5de5\u5177\u9762\u677f',
      operationIncludes: 'remove',
      apply: async () => {
        await activateVideoTool('removeSubtitle');
        await assertPanelContains(cdp, `[data-testid="video-tool-panel-${nodeId}"]`, '\u53bb\u5b57\u5e55\u5de5\u5177\u9762\u677f');
        await setVideoRemoveSubtitleConfig(cdp, nodeId, { detectionMode: 'manual', maskFeather: 11 });
      },
      assertState: async () => waitFor(cdp, `
        (() => {
          const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
          const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
          const params = node?.data?.params || {};
          return String(params.videoTool || '') === 'removeSubtitle'
            && String(params.videoToolOperation || '').includes('remove')
            && String(params.videoToolConfig?.detectionMode || '') === 'manual'
            && Number(params.videoToolConfig?.maskFeather || 0) === 11;
        })()
      `, 10000, 100),
    },
    {
      tool: 'audioSplit',
      panelTitle: '\u97f3\u9891\u5206\u79bb\u5de5\u5177\u9762\u677f',
      operationIncludes: 'audio_split',
      apply: async () => {
        await activateVideoTool('audioSplit');
        await assertPanelContains(cdp, `[data-testid="video-tool-panel-${nodeId}"]`, '\u97f3\u9891\u5206\u79bb\u5de5\u5177\u9762\u677f');
        await setValue(cdp, `[data-testid="video-audio-model-panel-${nodeId}"]`, 'Demucs-v4');
        await clickSelector(cdp, `[data-testid="video-tool-panel-${nodeId}"] input[type="checkbox"]`);
      },
      assertState: async () => waitFor(cdp, `
        (() => {
          const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
          const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
          const params = node?.data?.params || {};
          return String(params.videoTool || '') === 'audioSplit'
            && String(params.videoToolOperation || '').includes('audio_split')
            && String(params.videoToolConfig?.stemModel || '') === 'Demucs-v4'
            && params.videoToolConfig?.keepVocalInVideo === true;
        })()
      `, 10000, 100),
    },
    {
      tool: 'hd',
      panelTitle: '\u9ad8\u6e05\u5de5\u5177\u9762\u677f',
      operationIncludes: 'real_cugan',
      apply: async () => {
        await activateVideoTool('hd');
        await assertPanelContains(cdp, `[data-testid="video-tool-panel-${nodeId}"]`, '\u9ad8\u6e05\u5de5\u5177\u9762\u677f');
        await setValue(cdp, `[data-testid="video-hd-scale-panel-${nodeId}"]`, '4');
        await setValue(cdp, `[data-testid="video-hd-fps-panel-${nodeId}"]`, '60');
        await setValue(cdp, `[data-testid="video-hd-detail-panel-${nodeId}"]`, '0.72');
      },
      assertState: async () => waitFor(cdp, `
        (() => {
          const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
          const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
          const params = node?.data?.params || {};
          return String(params.videoTool || '') === 'hd'
            && String(params.videoToolOperation || '').includes('real_cugan')
            && Number(params.videoToolConfig?.scale || 0) === 4
            && params.videoToolConfig?.interpolate60fps === true
            && Number(params.videoToolConfig?.detailStrength || 0) >= 0.7;
        })()
      `, 10000, 100),
    },
  ];

  const toolVerificationResults = [];
  for (const toolCase of toolMatrix) {
    await toolCase.apply();
    await toolCase.assertState();
    const toolState = await evalJs(cdp, `
      (() => {
        const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
        const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
        const params = node?.data?.params || {};
        const panel = document.querySelector(${JSON.stringify(`[data-testid="video-tool-panel-${nodeId}"]`)});
        const root = document.querySelector(${JSON.stringify(nodeSelector)})?.parentElement;
        return {
          tool: String(params.videoTool || ''),
          operation: String(params.videoToolOperation || ''),
          config: params.videoToolConfig || null,
          panelText: String(panel?.textContent || ''),
          nodeText: String(root?.textContent || ''),
        };
      })()
    `, 10000);
    assert(toolState.tool === toolCase.tool, `Video tool ${toolCase.tool} did not persist after panel interaction.`, toolState);
    assert(toolState.operation.includes(toolCase.operationIncludes), `Video tool ${toolCase.tool} operation did not persist.`, toolState);
    assert(toolState.panelText.includes(toolCase.panelTitle), `Video tool ${toolCase.tool} panel did not render.`, toolState);
    assert(
      toolState.nodeText.includes('\u5df2\u6fc0\u6d3b') || toolState.panelText.includes('\u5df2\u8fde\u63a5'),
      `Video tool ${toolCase.tool} did not expose immediate interaction feedback.`,
      toolState,
    );
    toolVerificationResults.push(toolState);
  }

  await waitFor(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
      const params = node?.data?.params || {};
      return Number(params.count || 0) === 3
        && String(params.prompt || node?.data?.prompt || '').length > 0
        && String(node?.data?.quality || params.quality || '') === '480p'
        && Number(node?.data?.duration || params.duration || 0) === 5
        && String(params.videoTool || '') === 'hd'
        && String(params.videoToolOperation || '').includes('real_cugan')
        && Number(params.videoToolConfig?.scale || 0) === 4
        && params.videoToolConfig?.interpolate60fps === true
        && Number(params.videoToolConfig?.detailStrength || 0) >= 0.7;
    })()
  `, 15000, 150);

  const panelState = await evalJs(cdp, `
    (() => {
      const root = document.querySelector(${JSON.stringify(nodeSelector)})?.parentElement;
      const text = root?.textContent || '';
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
      const params = node?.data?.params || {};
      return {
        text,
        optionCount: document.querySelectorAll(${JSON.stringify(optionSelectorPrefix)}).length,
        hasTranslate: Boolean(document.querySelector(${JSON.stringify(translateSelector)})),
        hasOptimize: Boolean(document.querySelector(${JSON.stringify(optimizeSelector)})),
        model: String(node?.data?.model || ''),
        provider: String(node?.data?.provider || ''),
        count: Number(params.count || 0),
        prompt: String(params.prompt || node?.data?.prompt || ''),
        aspectRatio: String(node?.data?.aspectRatio || params.aspectRatio || ''),
        quality: String(node?.data?.quality || params.quality || ''),
        duration: Number(node?.data?.duration || params.duration || 0),
        videoTool: String(params.videoTool || ''),
        videoToolOperation: String(params.videoToolOperation || ''),
        videoToolConfig: params.videoToolConfig || null,
        generationMode: String(params.generationMode || ''),
        sourceUrl: String(params.sourceUrl || ''),
        firstFrameUrl: String(params.firstFrameUrl || ''),
        lastFrameUrl: String(params.lastFrameUrl || ''),
        referenceImageUrl: String(params.referenceImageUrl || ''),
        referenceVideoUrl: String(params.referenceVideoUrl || ''),
        toolConfigText: document.querySelector(${JSON.stringify(`[data-testid="video-tool-config-${nodeId}"]`)})?.textContent || '',
      };
    })()
  `, 10000);

  assert(panelState.hasTranslate, 'Video panel missing prompt translate action.', panelState);
  assert(panelState.hasOptimize, 'Video panel missing prompt optimize action.', panelState);
  assert(typeof panelState.text === 'string' && panelState.text.length > 0, 'Video panel did not render any text.', panelState);
  assert(typeof panelState.provider === 'string' && panelState.provider.length > 0, 'Video panel provider did not persist.', panelState);
  assert(panelState.provider === 'siliconflow', 'Video panel provider did not switch to siliconflow.', panelState);
  assert(panelState.model === selectedVideoModelId, 'Video panel model did not persist.', { selectedVideoModelId, panelState });
  assert(panelState.count === 3, 'Video panel count did not persist.', panelState);
  assert(panelState.text.includes('????') || panelState.count === 3, 'Video panel missing output count control.', panelState);
  assert(panelState.prompt.length > 0, 'Video prompt did not update.', panelState);
  assert(panelState.quality === '480p', 'Video quality did not persist.', panelState);
  assert(panelState.duration === 5, 'Video duration did not persist.', panelState);
  assert(panelState.videoTool === 'hd', 'Video tool did not switch to HD.', panelState);
  assert(panelState.videoToolOperation.includes('real_cugan'), 'Video tool operation missing HD pipeline.', panelState);
  assert(Number(panelState.videoToolConfig?.scale || 0) === 4, 'Video HD scale did not persist.', panelState);
  assert(panelState.videoToolConfig?.interpolate60fps === true, 'Video HD interpolation flag did not persist.', panelState);
  assert(panelState.toolConfigText.includes('real') || panelState.toolConfigText.includes('scale'), 'Video tool config panel did not render config text.', panelState);
  assert(panelState.text.includes('\u9009\u62e9\u5e73\u53f0'), 'Video panel summary did not expose the selected provider label.', panelState);
  assert(panelState.text.includes('\u5b9e\u9645\u4e0a\u6e38'), 'Video panel summary did not expose the upstream model label.', panelState);
  assert(panelState.text.includes('\u9884\u4f30\u8017\u65f6'), 'Video panel summary did not expose ETA text.', panelState);
  assert(panelState.text.includes('\u9884\u4f30\u8d39\u7528'), 'Video panel summary did not expose cost text.', panelState);
  assert(panelState.text.includes('\u8017\u65f6'), 'Video model option list did not expose latency text.', panelState);
  assert(panelState.text.includes('\u5355\u6b21') || panelState.text.includes('/\u6b21'), 'Video model option list did not expose unit cost text.', panelState);

  await recorder('video-panel-verified', { nodeId, selectedVideoModelId, panelState, toolVerificationResults });
}

async function verifyVideoPanel(cdp, recorder, nodeId, imagePath) {
  const modelToggleSelector = `[data-testid="video-model-toggle-${nodeId}"]`;
  const optionSelectorPrefix = `[data-testid^="video-model-option-${nodeId}-"]`;
  const nodeSelector = `[data-testid="video-node-${nodeId}"]`;
  const promptSelector = `[data-testid="video-prompt-${nodeId}"]`;
  const translateSelector = `[data-testid="video-translate-${nodeId}"]`;
  const optimizeSelector = `[data-testid="video-optimize-${nodeId}"]`;
  const fileInputSelector = `[data-testid="video-node-${nodeId}"] input[type="file"]`;
  const countSelector = `[data-testid="video-count-${nodeId}"]`;
  const floatingPanelSelector = `[data-testid="video-tool-panel-${nodeId}"]`;
  const clipEditorSelector = `[data-testid="video-clip-editor-${nodeId}"]`;
  const cropEditorSelector = `[data-testid="video-crop-editor-${nodeId}"]`;
  const cropBoxSelector = `[data-testid="video-crop-box-${nodeId}"]`;
  const cropAppliedSelector = `[data-testid="video-crop-applied-${nodeId}"]`;
  const cropPreviewViewportSelector = `[data-testid="video-preview-viewport-${nodeId}"]`;
  const videoSelector = `${nodeSelector} video`;

  async function activateVideoTool(tool) {
    const toolbarSelector = `[data-testid="video-toolbar-${nodeId}-${tool}"]`;
    const inlineSelector = `[data-testid="video-tool-${nodeId}-${tool}"]`;
    const targetSelector = await evalJs(cdp, `
      (() => {
        if (document.querySelector(${JSON.stringify(toolbarSelector)})) return ${JSON.stringify(toolbarSelector)};
        if (document.querySelector(${JSON.stringify(inlineSelector)})) return ${JSON.stringify(inlineSelector)};
        return '';
      })()
    `, 10000);
    assert(targetSelector, `No video tool activator found for ${tool}.`, { nodeId, toolbarSelector, inlineSelector });
    await clickSelector(cdp, targetSelector);
  }

  async function readNodeToolState() {
    return evalJs(cdp, `
      (() => {
        const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
        const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
        const params = node?.data?.params || {};
        const panel = document.querySelector(${JSON.stringify(floatingPanelSelector)});
        const root = document.querySelector(${JSON.stringify(nodeSelector)})?.parentElement;
        return {
          tool: String(params.videoTool || ''),
          operation: String(params.videoToolOperation || ''),
          config: params.videoToolConfig || null,
          panelVisible: Boolean(panel),
          panelText: String(panel?.textContent || ''),
          promptVisible: Boolean(document.querySelector(${JSON.stringify(promptSelector)})),
          clipEditorVisible: Boolean(document.querySelector(${JSON.stringify(clipEditorSelector)})),
          cropEditorVisible: Boolean(document.querySelector(${JSON.stringify(cropEditorSelector)})),
          cropAppliedVisible: Boolean(document.querySelector(${JSON.stringify(cropAppliedSelector)})),
          cropAppliedText: String(document.querySelector(${JSON.stringify(cropAppliedSelector)})?.textContent || ''),
          nodeText: String(root?.textContent || ''),
          toolConfigText: String(document.querySelector(${JSON.stringify(`[data-testid="video-tool-config-${nodeId}"]`)})?.textContent || ''),
        };
      })()
    `, 10000);
  }

  await clickSelector(cdp, modelToggleSelector);
  await waitFor(cdp, `(() => document.querySelectorAll(${JSON.stringify(optionSelectorPrefix)}).length > 0)()`, 15000);
  const selectedVideoModelId = await evalJs(cdp, `
    (() => {
      const preferred = ['wan22-i2v-a14b', 'wan22-t2v-a14b'];
      const activationLabels = ['\u5df2\u6fc0\u6d3b', '\u5df2\u8fde\u63a5', '\u53ef\u7528', 'Activated'];
      const currentModel = (() => {
        const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
        const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
        return String(node?.data?.model || '');
      })();
      if (preferred.includes(currentModel)) return currentModel;
      const options = [...document.querySelectorAll(${JSON.stringify(optionSelectorPrefix)})]
        .map((item) => ({
          id: (item.getAttribute('data-testid') || '').replace(${JSON.stringify(`video-model-option-${nodeId}-`)}, ''),
          text: item.textContent || '',
        }))
        .filter((item) => item.id);
      const activatedPreferred = preferred.find((modelId) => options.some((item) => item.id === modelId && activationLabels.some((label) => item.text.includes(label))));
      if (activatedPreferred) return activatedPreferred;
      const availablePreferred = preferred.find((modelId) => options.some((item) => item.id === modelId));
      if (availablePreferred) return availablePreferred;
      return options[0]?.id || '';
    })()
  `, 10000);
  assert(selectedVideoModelId, 'No usable video model option was rendered.', { nodeId });
  await clickSelector(cdp, `[data-testid="video-model-option-${nodeId}-${selectedVideoModelId}"]`);
  await waitFor(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
      return String(node?.data?.model || '') === ${JSON.stringify(selectedVideoModelId)};
    })()
  `, 10000, 100);

  await setValue(cdp, promptSelector, 'video panel verification prompt');
  await setValue(cdp, countSelector, '3');
  await clickSelector(cdp, `[data-testid="video-mode-${nodeId}-imageToVideo"]`);
  await clickSelector(cdp, `[data-testid="video-source-upload-${nodeId}"]`);
  await setFileInputFiles(cdp, fileInputSelector, [imagePath]);
  await waitFor(cdp, `(() => {
    const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
    const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
    const params = node?.data?.params || {};
    return String(params.generationMode || '') === 'imageToVideo' && String(params.sourceUrl || '') !== '';
  })()`, 15000, 100);

  await clickSelector(cdp, `[data-testid="video-mode-${nodeId}-firstLastFrame"]`);
  await clickSelector(cdp, `[data-testid="video-first-frame-upload-${nodeId}"]`);
  await setFileInputFiles(cdp, fileInputSelector, [imagePath]);
  await clickSelector(cdp, `[data-testid="video-last-frame-upload-${nodeId}"]`);
  await setFileInputFiles(cdp, fileInputSelector, [imagePath]);
  await waitFor(cdp, `(() => {
    const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
    const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
    const params = node?.data?.params || {};
    return String(params.generationMode || '') === 'firstLastFrame'
      && String(params.firstFrameUrl || '') !== ''
      && String(params.lastFrameUrl || '') !== '';
  })()`, 15000, 100);

  await clickSelector(cdp, `[data-testid="video-mode-${nodeId}-referenceVideo"]`);
  await clickSelector(cdp, `[data-testid="video-reference-image-upload-${nodeId}"]`);
  await setFileInputFiles(cdp, fileInputSelector, [imagePath]);
  await waitFor(cdp, `(() => {
    const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
    const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
    const params = node?.data?.params || {};
    return String(params.generationMode || '') === 'referenceVideo' && String(params.referenceImageUrl || '') !== '';
  })()`, 15000, 100);

  await clickSelector(cdp, `[data-testid="video-mode-${nodeId}-firstLastFrame"]`);
  await setValue(cdp, `[data-testid="video-aspect-${nodeId}"]`, '9:16');
  await setValue(cdp, `[data-testid="video-quality-${nodeId}"]`, '480p');
  await setValue(cdp, `[data-testid="video-duration-${nodeId}"]`, '5');
  await setValue(cdp, `[data-testid="video-motion-${nodeId}"]`, 'orbit-up');

  async function verifyClipTool() {
    const beforeConfirmVideoState = await evalJs(cdp, `
      (() => {
        const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
        const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
        return {
          videoUrl: String(node?.data?.videoUrl || ''),
          duration: Number(node?.data?.duration || node?.data?.params?.duration || 0),
          status: String(node?.data?.status || ''),
        };
      })()
    `, 10000);
    await activateVideoTool('clip');
    await waitFor(cdp, `!!document.querySelector(${JSON.stringify(clipEditorSelector)})`, 10000, 100);
    const editingState = await evalJs(cdp, `
      (() => {
        const editor = document.querySelector(${JSON.stringify(clipEditorSelector)});
        const video = document.querySelector(${JSON.stringify(videoSelector)});
        if (!editor || !video) return null;
        const editorRect = editor.getBoundingClientRect();
        const videoRect = video.getBoundingClientRect();
        return {
          promptVisible: Boolean(document.querySelector(${JSON.stringify(promptSelector)})),
          panelVisible: Boolean(document.querySelector(${JSON.stringify(floatingPanelSelector)})),
          clipEditorVisible: true,
          editorTop: editorRect.top,
          editorBottom: editorRect.bottom,
          editorWidth: editorRect.width,
          editorCenterX: editorRect.left + (editorRect.width / 2),
          videoBottom: videoRect.bottom,
          videoWidth: videoRect.width,
          videoCenterX: videoRect.left + (videoRect.width / 2),
          currentTimeText: String(document.querySelector(${JSON.stringify(`[data-testid="video-clip-current-time-${nodeId}"]`)})?.textContent || ''),
          thumbnailCount: document.querySelectorAll(${JSON.stringify(`[data-testid^="video-clip-thumb-${nodeId}-"]`)}).length,
          shortcutsText: String(document.querySelector(${JSON.stringify(`[data-testid="video-clip-shortcuts-${nodeId}"]`)})?.textContent || ''),
        };
      })()
    `, 10000);
    assert(editingState?.clipEditorVisible, 'Clip editor did not appear.', { nodeId, editingState });
    assert(editingState.promptVisible === false, 'Clip editing should hide the prompt panel.', editingState);
    assert(editingState.panelVisible === false, 'Clip editing should hide floating tool panels.', editingState);
    assert(editingState.editorTop >= editingState.videoBottom - 2, 'Clip editor should render below the video instead of covering it.', editingState);
    assert(editingState.editorWidth >= editingState.videoWidth + 120, 'Clip editor should expand beyond portrait video width so controls stay visible.', editingState);
    assert(Math.abs(editingState.editorCenterX - editingState.videoCenterX) < 24, 'Clip editor should stay centered under the video.', editingState);
    assert(editingState.thumbnailCount >= 5, 'Clip editor did not render thumbnail strip.', editingState);
    assert(editingState.shortcutsText.includes('\u62d6\u52a8\u5de6\u53f3\u624b\u67c4\u8c03\u6574\u8303\u56f4') && editingState.shortcutsText.includes('Enter \u786e\u8ba4'), 'Clip editor shortcut hint is missing.', editingState);
    const clipDraftSelection = await adjustClipEditorSelection(cdp, nodeId, { startRatio: 0.24, endRatio: 0.72 });
    assert(
      clipDraftSelection
        && Number(clipDraftSelection.startTime || 0) > 0.02
        && Number(clipDraftSelection.endTime || 0) > Number(clipDraftSelection.startTime || 0) + 0.05
        && Number(clipDraftSelection.endTime || 0) <= Math.max(0.25, Number(clipDraftSelection.duration || beforeConfirmVideoState?.duration || 5)),
      'Clip editor draft did not update after adjusting the trim range.',
      { nodeId, beforeConfirmVideoState, clipDraftSelection },
    );
    const draftState = await readNodeToolState();
    assert(draftState.clipEditorVisible, 'Clip draft state disappeared before confirmation.', draftState);
    assert(draftState.tool === 'clip', 'Clip tool should remain active while the editor is open.', draftState);

    await clickSelector(cdp, `[data-testid="video-clip-confirm-${nodeId}"]`);
    await waitFor(cdp, `!document.querySelector(${JSON.stringify(clipEditorSelector)})`, 10000, 100);
    await waitFor(cdp, `
      (() => {
        const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
        const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
        return String(node?.data?.status || '') === 'completed'
          && String(node?.data?.videoUrl || '') !== ${JSON.stringify(String(beforeConfirmVideoState?.videoUrl || ''))}
          && Number(node?.data?.duration || node?.data?.params?.duration || 0) < ${Math.max(1, Number(beforeConfirmVideoState?.duration || 0))};
      })()
    `, 30000, 150);
    const confirmedState = await readNodeToolState();
    assert(confirmedState.tool === 'clip', 'Clip tool did not persist after confirmation.', confirmedState);
    assert(confirmedState.operation.includes('trim'), 'Clip operation did not persist after confirmation.', confirmedState);
    assert(confirmedState.promptVisible, 'Prompt panel did not return after confirming clip edits.', confirmedState);
    assert(!confirmedState.clipEditorVisible, 'Clip editor did not close after confirmation.', confirmedState);
    const appliedClipState = await evalJs(cdp, `
      (() => {
        const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
        const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
        const video = document.querySelector(${JSON.stringify(videoSelector)});
        return {
          videoUrl: String(node?.data?.videoUrl || ''),
          duration: Number(node?.data?.duration || node?.data?.params?.duration || 0),
          currentSrc: String(video?.currentSrc || video?.getAttribute('src') || ''),
        };
      })()
    `, 10000);
    assert(
      Number(appliedClipState?.duration || 0) < Math.max(1, Number(beforeConfirmVideoState?.duration || 0)),
      'Clip confirmation did not shorten the node duration.',
      { beforeConfirmVideoState, appliedClipState },
    );
    return {
      tool: 'clip',
      beforeConfirmVideoState,
      editingState,
      draftState,
      confirmedState,
      appliedClipState,
    };
  }

  async function verifyCropTool() {
    const cropResizeHandleSelector = `[data-testid="video-crop-handle-${nodeId}-se"]`;
    const beforeConfirmVideoState = await evalJs(cdp, `
      (() => {
        const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
        const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
        return {
          videoUrl: String(node?.data?.videoUrl || ''),
          status: String(node?.data?.status || ''),
        };
      })()
    `, 10000);
    await activateVideoTool('crop');
    await waitFor(cdp, `!!document.querySelector(${JSON.stringify(cropEditorSelector)})`, 10000, 100);
    const beforeDrag = await evalJs(cdp, `
      (() => {
        const box = document.querySelector(${JSON.stringify(cropBoxSelector)});
        if (!box) return null;
        const rect = box.getBoundingClientRect();
        const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
        const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
        const params = node?.data?.params || {};
        return {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          promptVisible: Boolean(document.querySelector(${JSON.stringify(promptSelector)})),
          panelVisible: Boolean(document.querySelector(${JSON.stringify(floatingPanelSelector)})),
          tool: String(params.videoTool || ''),
          config: params.videoToolConfig || null,
        };
      })()
    `, 10000);
    assert(beforeDrag, 'Crop editor did not expose a draggable crop box.', { nodeId });
    assert(beforeDrag.promptVisible, 'Crop editing should keep the prompt panel visible.', beforeDrag);
    assert(beforeDrag.panelVisible === false, 'Crop editing should not reopen the floating parameter panel.', beforeDrag);

    await dragSelector(cdp, cropResizeHandleSelector, { x: 0.5, y: 0.5 }, { x: 7.2, y: 5.2 }, 10);
    await waitFor(cdp, `
      (() => {
        const box = document.querySelector(${JSON.stringify(cropBoxSelector)});
        if (!box) return false;
        const rect = box.getBoundingClientRect();
        return Math.abs(rect.width - ${Number(beforeDrag.width)}) > 3 || Math.abs(rect.height - ${Number(beforeDrag.height)}) > 3;
      })()
    `, 10000, 100);
    await waitFor(cdp, `
      (() => {
        const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
        const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
        const params = node?.data?.params || {};
        return String(params.videoTool || '') === 'crop'
          && String(params.videoToolOperation || '').includes('crop')
          && (Math.abs(Number(params.videoToolConfig?.widthPercent || 0) - 84) > 0.5
            || Math.abs(Number(params.videoToolConfig?.heightPercent || 0) - 72) > 0.5);
      })()
    `, 10000, 100);
    const afterDrag = await evalJs(cdp, `
      (() => {
        const box = document.querySelector(${JSON.stringify(cropBoxSelector)});
        const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
        const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
        const params = node?.data?.params || {};
        if (!box) return null;
        const rect = box.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          tool: String(params.videoTool || ''),
          operation: String(params.videoToolOperation || ''),
          config: params.videoToolConfig || null,
        };
      })()
    `, 10000);
    assert(afterDrag?.tool === 'crop', 'Crop drag did not live-write current node params.', afterDrag);
    assert(afterDrag?.operation?.includes('crop'), 'Crop drag did not preserve crop operation.', afterDrag);

    await clickSelector(cdp, `[data-testid="video-crop-cancel-${nodeId}"]`);
    await waitFor(cdp, `!document.querySelector(${JSON.stringify(cropEditorSelector)})`, 10000, 100);
    const canceledState = await readNodeToolState();
    assert(!canceledState.cropEditorVisible, 'Crop editor did not close after cancel.', canceledState);
    assert(!canceledState.cropAppliedVisible, 'Crop cancel should not leave an applied crop badge when there was no prior crop.', canceledState);
    const cancelOverlayState = await evalJs(cdp, `
      (() => ({
        cropBoxStillVisible: Boolean(document.querySelector(${JSON.stringify(cropBoxSelector)})),
        cropEditorStillVisible: Boolean(document.querySelector(${JSON.stringify(cropEditorSelector)})),
      }))()
    `, 10000);
    assert(cancelOverlayState.cropBoxStillVisible === false, 'Crop cancel left the crop grid on the node.', cancelOverlayState);
    assert(canceledState.tool === 'clip', 'Crop cancel should restore the previously active tool state.', canceledState);

    await activateVideoTool('crop');
    await waitFor(cdp, `!!document.querySelector(${JSON.stringify(cropEditorSelector)})`, 10000, 100);
    await dragSelector(cdp, cropResizeHandleSelector, { x: 0.5, y: 0.5 }, { x: 6.5, y: 4.8 }, 10);
    await clickSelector(cdp, `[data-testid="video-crop-confirm-${nodeId}"]`);
    await waitFor(cdp, `
      (() => {
        const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
        const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
        return String(node?.data?.status || '') === 'completed'
          && String(node?.data?.videoUrl || '') !== ${JSON.stringify(String(beforeConfirmVideoState?.videoUrl || ''))}
          && !document.querySelector(${JSON.stringify(cropEditorSelector)});
      })()
    `, 30000, 150);
    const confirmedState = await readNodeToolState();
    assert(confirmedState.tool === 'crop', 'Crop tool did not persist after confirmation.', confirmedState);
    assert(confirmedState.operation.includes('crop'), 'Crop operation did not persist after confirmation.', confirmedState);
    assert(!confirmedState.cropEditorVisible, 'Crop editor did not close after confirmation.', confirmedState);
    assert(confirmedState.cropAppliedVisible, 'Crop confirmation should show the applied crop preview badge.', confirmedState);
    const appliedPreviewState = await evalJs(cdp, `
      (() => {
        const viewport = document.querySelector(${JSON.stringify(cropPreviewViewportSelector)});
        const video = document.querySelector(${JSON.stringify(videoSelector)});
        const badge = document.querySelector(${JSON.stringify(cropAppliedSelector)});
        if (!viewport || !video) return null;
        const viewportRect = viewport.getBoundingClientRect();
        const videoRect = video.getBoundingClientRect();
        return {
          badgeText: String(badge?.textContent || ''),
          viewportWidth: viewportRect.width,
          viewportHeight: viewportRect.height,
          videoWidth: videoRect.width,
          videoHeight: videoRect.height,
          viewportLeft: viewportRect.left,
          viewportTop: viewportRect.top,
          videoLeft: videoRect.left,
          videoTop: videoRect.top,
          currentSrc: String(video.currentSrc || video.getAttribute('src') || ''),
        };
      })()
    `, 10000);
    assert(appliedPreviewState, 'Crop confirmation did not keep the preview viewport mounted.', { nodeId });
    assert(
      String(appliedPreviewState.currentSrc || '') !== String(beforeConfirmVideoState?.videoUrl || ''),
      'Crop confirmation did not replace the node video asset with a cropped local video.',
      { beforeConfirmVideoState, appliedPreviewState },
    );
    return {
      tool: 'crop',
      beforeConfirmVideoState,
      beforeDrag,
      afterDrag,
      canceledState,
      confirmedState,
      appliedPreviewState,
    };
  }

  const toolMatrix = uiOnlyMode ? [
    {
      tool: 'clip',
      operationIncludes: 'trim',
      apply: verifyClipTool,
    },
    {
      tool: 'crop',
      operationIncludes: 'crop',
      apply: verifyCropTool,
    },
  ] : [
    {
      tool: 'clip',
      operationIncludes: 'trim',
      apply: verifyClipTool,
    },
    {
      tool: 'crop',
      operationIncludes: 'crop',
      apply: verifyCropTool,
    },
    {
      tool: 'parse',
      panelTitle: '\u89e3\u6790\u5de5\u5177\u9762\u677f',
      operationIncludes: 'parse',
      apply: async () => {
        await activateVideoTool('parse');
        await assertPanelContains(cdp, floatingPanelSelector, '\u89e3\u6790\u5de5\u5177\u9762\u677f');
        await clickSelector(cdp, `[data-testid="video-tool-panel-${nodeId}"] input[type="checkbox"]`);
        await setValue(cdp, `[data-testid="video-parse-fps-panel-${nodeId}"]`, '5');
      },
      assertState: async () => waitFor(cdp, `
        (() => {
          const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
          const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
          const params = node?.data?.params || {};
          return String(params.videoTool || '') === 'parse'
            && String(params.videoToolOperation || '').includes('parse')
            && params.videoToolConfig?.sceneDetect === false
            && Number(params.videoToolConfig?.sampleFps || 0) === 5;
        })()
      `, 10000, 100),
    },
    {
      tool: 'removeSubtitle',
      panelTitle: '\u53bb\u5b57\u5e55\u5de5\u5177\u9762\u677f',
      operationIncludes: 'remove',
      apply: async () => {
        await activateVideoTool('removeSubtitle');
        await assertPanelContains(cdp, floatingPanelSelector, '\u53bb\u5b57\u5e55\u5de5\u5177\u9762\u677f');
        await setVideoRemoveSubtitleConfig(cdp, nodeId, { detectionMode: 'manual', maskFeather: 11 });
      },
      assertState: async () => waitFor(cdp, `
        (() => {
          const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
          const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
          const params = node?.data?.params || {};
          return String(params.videoTool || '') === 'removeSubtitle'
            && String(params.videoToolOperation || '').includes('remove')
            && String(params.videoToolConfig?.detectionMode || '') === 'manual'
            && Number(params.videoToolConfig?.maskFeather || 0) === 11;
        })()
      `, 10000, 100),
    },
    {
      tool: 'audioSplit',
      panelTitle: '\u97f3\u9891\u5206\u79bb\u5de5\u5177\u9762\u677f',
      operationIncludes: 'audio_split',
      apply: async () => {
        await activateVideoTool('audioSplit');
        await assertPanelContains(cdp, floatingPanelSelector, '\u97f3\u9891\u5206\u79bb\u5de5\u5177\u9762\u677f');
        await setValue(cdp, `[data-testid="video-audio-model-panel-${nodeId}"]`, 'Demucs-v4');
        await clickSelector(cdp, `[data-testid="video-tool-panel-${nodeId}"] input[type="checkbox"]`);
      },
      assertState: async () => waitFor(cdp, `
        (() => {
          const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
          const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
          const params = node?.data?.params || {};
          return String(params.videoTool || '') === 'audioSplit'
            && String(params.videoToolOperation || '').includes('audio_split')
            && String(params.videoToolConfig?.stemModel || '') === 'Demucs-v4'
            && params.videoToolConfig?.keepVocalInVideo === true;
        })()
      `, 10000, 100),
    },
    {
      tool: 'hd',
      panelTitle: '\u9ad8\u6e05\u5de5\u5177\u9762\u677f',
      operationIncludes: 'real_cugan',
      apply: async () => {
        await activateVideoTool('hd');
        await assertPanelContains(cdp, floatingPanelSelector, '\u9ad8\u6e05\u5de5\u5177\u9762\u677f');
        await setValue(cdp, `[data-testid="video-hd-scale-panel-${nodeId}"]`, '4');
        await setValue(cdp, `[data-testid="video-hd-fps-panel-${nodeId}"]`, '60');
        await setValue(cdp, `[data-testid="video-hd-detail-panel-${nodeId}"]`, '0.72');
      },
      assertState: async () => waitFor(cdp, `
        (() => {
          const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
          const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
          const params = node?.data?.params || {};
          return String(params.videoTool || '') === 'hd'
            && String(params.videoToolOperation || '').includes('real_cugan')
            && Number(params.videoToolConfig?.scale || 0) === 4
            && params.videoToolConfig?.interpolate60fps === true
            && Number(params.videoToolConfig?.detailStrength || 0) >= 0.7;
        })()
      `, 10000, 100),
    },
  ];

  const toolVerificationResults = [];
  for (const toolCase of toolMatrix) {
    const result = await toolCase.apply();
    if (toolCase.tool === 'clip' || toolCase.tool === 'crop') {
      const confirmedState = result?.confirmedState || null;
      assert(confirmedState?.tool === toolCase.tool, `Video tool ${toolCase.tool} did not persist after confirmation.`, result);
      assert(confirmedState?.operation?.includes(toolCase.operationIncludes), `Video tool ${toolCase.tool} operation did not persist.`, result);
      toolVerificationResults.push(result);
      continue;
    }
    await toolCase.assertState();
    const toolState = await readNodeToolState();
    assert(toolState.tool === toolCase.tool, `Video tool ${toolCase.tool} did not persist after panel interaction.`, toolState);
    assert(toolState.operation.includes(toolCase.operationIncludes), `Video tool ${toolCase.tool} operation did not persist.`, toolState);
    assert(toolState.panelVisible, `Video tool ${toolCase.tool} floating panel did not remain visible.`, toolState);
    assert(toolState.panelText.includes(toolCase.panelTitle), `Video tool ${toolCase.tool} panel did not render.`, toolState);
    assert(toolState.toolConfigText.length > 0, `Video tool ${toolCase.tool} did not expose config feedback.`, toolState);
    toolVerificationResults.push(toolState);
  }

  if (!uiOnlyMode) {
    await waitFor(cdp, `
      (() => {
        const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
        const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
        const params = node?.data?.params || {};
        return Number(params.count || 0) === 3
          && String(params.prompt || node?.data?.prompt || '').length > 0
          && String(node?.data?.quality || params.quality || '') === '480p'
          && Number(node?.data?.duration || params.duration || 0) === 5
          && String(params.videoTool || '') === 'hd'
          && String(params.videoToolOperation || '').includes('real_cugan')
          && Number(params.videoToolConfig?.scale || 0) === 4
          && params.videoToolConfig?.interpolate60fps === true
          && Number(params.videoToolConfig?.detailStrength || 0) >= 0.7;
      })()
    `, 15000, 150);
  }

  const panelState = await evalJs(cdp, `
    (() => {
      const root = document.querySelector(${JSON.stringify(nodeSelector)})?.parentElement;
      const text = root?.textContent || '';
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
      const params = node?.data?.params || {};
      return {
        text,
        optionCount: document.querySelectorAll(${JSON.stringify(optionSelectorPrefix)}).length,
        hasTranslate: Boolean(document.querySelector(${JSON.stringify(translateSelector)})),
        hasOptimize: Boolean(document.querySelector(${JSON.stringify(optimizeSelector)})),
        model: String(node?.data?.model || ''),
        provider: String(node?.data?.provider || ''),
        count: Number(params.count || 0),
        prompt: String(params.prompt || node?.data?.prompt || ''),
        aspectRatio: String(node?.data?.aspectRatio || params.aspectRatio || ''),
        quality: String(node?.data?.quality || params.quality || ''),
        duration: Number(node?.data?.duration || params.duration || 0),
        videoTool: String(params.videoTool || ''),
        videoToolOperation: String(params.videoToolOperation || ''),
        videoToolConfig: params.videoToolConfig || null,
        generationMode: String(params.generationMode || ''),
        sourceUrl: String(params.sourceUrl || ''),
        firstFrameUrl: String(params.firstFrameUrl || ''),
        lastFrameUrl: String(params.lastFrameUrl || ''),
        referenceImageUrl: String(params.referenceImageUrl || ''),
        referenceVideoUrl: String(params.referenceVideoUrl || ''),
        toolConfigText: document.querySelector(${JSON.stringify(`[data-testid="video-tool-config-${nodeId}"]`)})?.textContent || '',
      };
    })()
  `, 10000);

  assert(panelState.hasTranslate, 'Video panel missing prompt translate action.', panelState);
  assert(panelState.hasOptimize, 'Video panel missing prompt optimize action.', panelState);
  assert(typeof panelState.text === 'string' && panelState.text.length > 0, 'Video panel did not render any text.', panelState);
  assert(typeof panelState.provider === 'string' && panelState.provider.length > 0, 'Video panel provider did not persist.', panelState);
  assert(panelState.provider === 'siliconflow', 'Video panel provider did not switch to siliconflow.', panelState);
  assert(panelState.model === selectedVideoModelId, 'Video panel model did not persist.', { selectedVideoModelId, panelState });
  assert(panelState.count === 3, 'Video panel count did not persist.', panelState);
  assert(panelState.text.includes('杈撳嚭') || panelState.count === 3, 'Video panel missing output count control.', panelState);
  assert(panelState.prompt.length > 0, 'Video prompt did not update.', panelState);
  assert(panelState.quality === '480p', 'Video quality did not persist.', panelState);
  if (uiOnlyMode) {
    assert(panelState.duration > 0 && panelState.duration < 5, 'Video duration was not updated to the clipped local result.', panelState);
    assert(panelState.videoTool === 'crop', 'UI-only verification should end on the applied crop result.', panelState);
    assert(String(panelState.videoToolOperation || '').includes('crop'), 'UI-only verification should preserve crop operation after confirmation.', panelState);
  } else {
    assert(panelState.duration === 5, 'Video duration did not persist.', panelState);
    assert(panelState.videoTool === 'hd', 'Video tool did not switch to HD.', panelState);
    assert(panelState.videoToolOperation.includes('real_cugan'), 'Video tool operation missing HD pipeline.', panelState);
    assert(Number(panelState.videoToolConfig?.scale || 0) === 4, 'Video HD scale did not persist.', panelState);
    assert(panelState.videoToolConfig?.interpolate60fps === true, 'Video HD interpolation flag did not persist.', panelState);
    assert(panelState.toolConfigText.includes('real') || panelState.toolConfigText.includes('scale'), 'Video tool config panel did not render config text.', panelState);
  }
  assert(panelState.text.includes('\u9009\u62e9\u5e73\u53f0'), 'Video panel summary did not expose the selected provider label.', panelState);
  assert(panelState.text.includes('\u5b9e\u9645\u4e0a\u6e38'), 'Video panel summary did not expose the upstream model label.', panelState);
  assert(panelState.text.includes('\u9884\u4f30\u8017\u65f6'), 'Video panel summary did not expose ETA text.', panelState);
  assert(panelState.text.includes('\u9884\u4f30\u8d39\u7528'), 'Video panel summary did not expose cost text.', panelState);
  assert(panelState.text.includes('\u8017\u65f6'), 'Video model option list did not expose latency text.', panelState);
  assert(panelState.text.includes('\u5355\u6b21') || panelState.text.includes('/\u6b21') || /(?:[$]|USD|CNY)\s*\d/i.test(panelState.text), 'Video panel did not expose unit cost text.', panelState);

  await recorder('video-panel-verified', { nodeId, selectedVideoModelId, panelState, toolVerificationResults });
}

async function verifyCanvasPersistence(cdp, recorder, nodeId) {
  const beforeState = await readCanvasState(cdp);
  const beforeStorage = await evalJs(cdp, 'localStorage.getItem("hmdao-canvas-store") || ""', 10000);
  assert(beforeStorage.includes(nodeId), 'Canvas storage did not include the image node before route roundtrip.', {
    nodeId,
    storageLength: beforeStorage.length,
  });

  await openApiKeysRoute(cdp);
  await recorder('canvas-roundtrip-settings-opened', { nodeId });

  await navigateAndWait(cdp, appUrl, 'location.pathname === "/" && !!document.querySelector(".react-flow") && !!window.__HMDAO_DEBUG__');
  await waitFor(cdp, `
    (() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      const nodes = store?.canvas?.nodes || [];
      const storage = localStorage.getItem("hmdao-canvas-store") || "";
      return nodes.length >= ${Number(beforeState.nodeCount || 0)}
        && nodes.some((node) => node.id === ${JSON.stringify(nodeId)})
        && storage.includes(${JSON.stringify(nodeId)});
    })()
  `, 30000, 250);

  const persistedState = await evalJs(cdp, `
    (() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      const nodes = store?.canvas?.nodes || [];
      const storage = localStorage.getItem("hmdao-canvas-store") || "";
      return {
        nodeCount: nodes.length,
        nodeStillExists: nodes.some((node) => node.id === ${JSON.stringify(nodeId)}),
        storageIncludesNode: storage.includes(${JSON.stringify(nodeId)}),
        storageLength: storage.length,
      };
    })()
  `, 10000);
  assert(persistedState.nodeCount >= Number(beforeState.nodeCount || 0), 'Canvas node count shrank after settings roundtrip.', {
    beforeNodeCount: beforeState.nodeCount,
    afterNodeCount: persistedState.nodeCount,
  });
  assert(persistedState.nodeStillExists, 'Canvas node disappeared after settings roundtrip.', persistedState);
  assert(persistedState.storageIncludesNode, 'Canvas storage lost the image node after settings roundtrip.', persistedState);
  await recorder('canvas-persistence-state-verified', { nodeId, beforeNodeCount: beforeState.nodeCount, ...persistedState });

  await waitForSelector(cdp, `[data-testid="image-node-${nodeId}"]`, 30000);
  await selectNodeById(cdp, nodeId);
  await waitForNodeSelection(cdp, nodeId);
  await waitForSelector(cdp, `[data-testid="image-model-toggle-${nodeId}"]`, 30000);
  await recorder('canvas-persistence-panel-mounted', { nodeId, nodeCount: persistedState.nodeCount });

  const optionSelector = `[data-testid="image-model-option-${nodeId}-lib-image"]`;
  await clickSelector(cdp, `[data-testid="image-model-toggle-${nodeId}"]`);
  await waitForSelector(cdp, optionSelector, 15000);
  await clickSelector(cdp, optionSelector);
  await recorder('canvas-persistence-activation-badge-verified', { nodeId, modelId: 'lib-image' });
}

async function chooseLibImageModel(cdp, nodeId) {
  await clickSelector(cdp, `[data-testid="image-model-toggle-${nodeId}"]`);
  await waitForSelector(cdp, `[data-testid="image-model-option-${nodeId}-lib-image"]`, 15000);
  await clickSelector(cdp, `[data-testid="image-model-option-${nodeId}-lib-image"]`);
}

async function verifyActivatedImageModel(cdp, recorder, nodeId) {
  const optionSelector = `[data-testid="image-model-option-${nodeId}-lib-image"]`;
  await clickSelector(cdp, `[data-testid="image-model-toggle-${nodeId}"]`);
  await waitForSelector(cdp, optionSelector, 15000);
  const optionText = await evalJs(cdp, `
    (() => {
      const option = document.querySelector(${JSON.stringify(optionSelector)});
      return option ? String(option.textContent || '') : '';
    })()
  `, 10000);
  assert(optionText.includes('\u7845\u57fa\u6d41\u52a8'), 'Image model option did not expose the provider label.', { nodeId, optionText });
  assert(optionText.includes('Qwen/Qwen-Image'), 'Image model option did not expose the upstream model.', { nodeId, optionText });
  assert(optionText.includes('\u8017\u65f6'), 'Image model option did not expose latency text.', { nodeId, optionText });
  assert(optionText.includes('\u5355\u6b21'), 'Image model option did not expose unit cost text.', { nodeId, optionText });
  await clickSelector(cdp, optionSelector);
  const toggleState = await evalJs(cdp, `
    (() => {
      const toggle = document.querySelector(${JSON.stringify(`[data-testid="image-model-toggle-${nodeId}"]`)});
      const root = document.querySelector(${JSON.stringify(`[data-testid="image-node-${nodeId}"]`)})?.parentElement;
      return {
        toggleText: toggle ? String(toggle.textContent || '') : '',
        panelText: root ? String(root.textContent || '') : '',
      };
    })()
  `, 10000);
  assert(toggleState.toggleText.includes('\u7845\u57fa\u6d41\u52a8'), 'Image model toggle did not expose the provider label.', { nodeId, toggleState });
  assert(toggleState.toggleText.includes('Qwen/Qwen-Image'), 'Image model toggle did not expose the upstream model.', { nodeId, toggleState });
  assert(toggleState.panelText.includes('\u9009\u62e9\u5e73\u53f0'), 'Image panel summary did not expose the selected provider label.', { nodeId, toggleState });
  assert(toggleState.panelText.includes('\u5b9e\u9645\u4e0a\u6e38'), 'Image panel summary did not expose the routed upstream label.', { nodeId, toggleState });
  assert(toggleState.panelText.includes('\u9884\u4f30\u8017\u65f6'), 'Image panel summary did not expose ETA text.', { nodeId, toggleState });
  assert(toggleState.panelText.includes('\u9884\u4f30\u8d39\u7528'), 'Image panel summary did not expose cost text.', { nodeId, toggleState });
  await recorder('image-model-activated-verified', { nodeId, modelId: 'lib-image', optionText, toggleState });
}

async function uploadSourceImage(cdp, recorder, nodeId, imagePath) {
  await clickSelector(cdp, `[data-testid="image-upload-${nodeId}"]`);
  await setFileInputFiles(cdp, `[data-testid="image-node-${nodeId}"] input[type="file"]`, [imagePath]);
  await waitFor(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
      return Boolean(node?.data?.imageUrl) && Array.isArray(node?.data?.outputs) && node.data.outputs.length > 0;
    })()
  `, 30000, 250);
  await recorder('image-uploaded', { nodeId, imagePath });
}
async function verifyPanoramaPanel(cdp, recorder, nodeId) {
  await openToolPanelAndWait(cdp, nodeId, 'panorama', '[data-testid="panorama-immersive-viewport"]');
  await assertPanelContains(cdp, '[data-testid="image-tool-panel-panorama"]', '\u5168\u666f\u53c2\u6570');

  const beforeViewport = await readViewport(cdp);
  await clickSelectorAtRatio(cdp, '[data-testid="panorama-immersive-viewport"]', { x: 0.68, y: 0.38 });
  await dispatchWheel(cdp, '[data-testid="panorama-immersive-viewport"]', -160);
  await setValue(cdp, '[data-testid="panorama-fov-slider"]', '138');
  await setValue(cdp, '[data-testid="panorama-preview-zoom-slider"]', '1.18');

  await clickSelectorAtRatio(cdp, '[data-testid="panorama-mask-surface"]', { x: 0.32, y: 0.42 });
  await clickSelectorAtRatio(cdp, '[data-testid="panorama-mask-surface"]', { x: 0.58, y: 0.54 });
  const toolConfig = await readToolConfig(cdp, nodeId);
  const afterViewport = await readViewport(cdp);
  assertStableViewport(beforeViewport, afterViewport, 'panorama');
  assert(Number(toolConfig?.panoramaAnchorX || 0) !== 0.5 || Number(toolConfig?.panoramaAnchorY || 0) !== 0.5, 'Panorama anchor did not change.', toolConfig);
  assert(Number(toolConfig?.fov || 0) >= 138, 'Panorama FOV did not change.', toolConfig);
  assert(Number(toolConfig?.panoramaZoom || 0) > 1.05, 'Panorama zoom did not change.', toolConfig);

  assert(Array.isArray(toolConfig?.maskPoints) && toolConfig.maskPoints.length > 0, 'Panorama mask points were not recorded.', toolConfig);
  await recorder('panorama-verified', { nodeId, toolConfig });
}

async function verifyMultiAnglePanel(cdp, recorder, nodeId) {
  await openToolPanelAndWait(cdp, nodeId, 'multiAngle', '[data-testid="multi-angle-orbit-pad"]');
  await assertPanelContains(cdp, '[data-testid="image-tool-panel-multiAngle"]', '\u591a\u89d2\u5ea6\u53c2\u6570');

  const beforeViewport = await readViewport(cdp);
  await clickSelector(cdp, '[data-testid="multi-angle-preset-fish"]');
  await dragSelector(cdp, '[data-testid="multi-angle-orbit-pad"]', { x: 0.5, y: 0.52 }, { x: 0.73, y: 0.28 });
  await dispatchWheel(cdp, '[data-testid="multi-angle-orbit-pad"]', -180);
    await setValue(cdp, '[data-testid="multi-angle-keyframe-name"]', '\u6b63\u9762\u5173\u952e\u5e27');
  await clickSelector(cdp, '[data-testid="multi-angle-keyframe-add"]');
  const toolConfig = await readToolConfig(cdp, nodeId);
  const afterViewport = await readViewport(cdp);
  assertStableViewport(beforeViewport, afterViewport, 'multi-angle');
  assert(String(toolConfig?.cameraPreset || '') === 'fish', 'Multi-angle preset did not apply.', toolConfig);
  assert(Number(toolConfig?.framingZoom || 0) > 1.25, 'Multi-angle zoom did not change.', toolConfig);
  assert(Array.isArray(toolConfig?.keyframes) && toolConfig.keyframes.length > 0, 'Multi-angle keyframe was not saved.', toolConfig);
  await recorder('multi-angle-verified', { nodeId, toolConfig });
}

async function verifyLightingPanel(cdp, recorder, nodeId, hdriPath) {
  await openToolPanelAndWait(cdp, nodeId, 'lighting', '[data-testid="lighting-direction-pad"]');
  await assertPanelContains(cdp, '[data-testid="image-tool-panel-lighting"]', '\u6253\u5149\u53c2\u6570');

  const beforeViewport = await readViewport(cdp);
  await clickSelector(cdp, '[data-testid="lighting-preset-rembrandt"]');
  await clickSelector(cdp, '[data-testid="lighting-active-env"]');
  await waitFor(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
      return String(node?.data?.params?.toolConfig?.activeLight || "") === "env";
    })()
  `, 10000, 100);
  await dispatchPointerStroke(cdp, '[data-testid="lighting-direction-pad"]', [{ x: 0.24, y: 0.72 }, { x: 0.48, y: 0.52 }, { x: 0.66, y: 0.36 }, { x: 0.82, y: 0.24 }]);

  await waitFor(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
      return Number(node?.data?.params?.toolConfig?.envLightIntensity || 0) > 0.5;
    })()
  `, 15000, 120);
  const toolConfig = await readToolConfig(cdp, nodeId);

  await clickSelector(cdp, '[data-testid="lighting-hdri-upload"]');
  await setFileInputFiles(cdp, '[data-testid="image-tool-panel-lighting"] input[type="file"]', [hdriPath]);
  await clickSelector(cdp, '[data-testid="lighting-hdri-pick-latest"]');

  const finalToolConfig = await readToolConfig(cdp, nodeId);
  const afterViewport = await readViewport(cdp);
  assertStableViewport(beforeViewport, afterViewport, 'lighting');
  assert(String(finalToolConfig?.activeLight || '') === 'env', 'Lighting active light did not switch to env.', finalToolConfig);
  assert(Boolean(finalToolConfig?.hdri), 'Lighting HDRI toggle was not enabled.', finalToolConfig);
  assert(String(finalToolConfig?.hdriAssetName || '').length > 0, 'Lighting HDRI asset was not attached.', finalToolConfig);
  assert(Number(finalToolConfig?.envLightIntensity || 0) > 0.5, 'Lighting env intensity did not change.', finalToolConfig);
  await recorder('lighting-verified', { nodeId, toolConfig: finalToolConfig });
}


async function verifyHdPanel(cdp, recorder, nodeId) {
  await openToolPanelAndWait(cdp, nodeId, 'hd', '[data-testid="hd-preview-canvas"]');
  await assertPanelContains(cdp, '[data-testid="image-tool-panel-hd"]', '\u9ad8\u6e05\u53c2\u6570');
  const beforeViewport = await readViewport(cdp);
  await clickSelector(cdp, '[data-testid="hd-mode-inpaint"]');
  await setValue(cdp, '[data-testid="image-prompt-' + nodeId + '"]', 'hd detail test');
  await dispatchPointerStroke(cdp, '[data-testid="hd-preview-canvas"]', [{ x: 0.32, y: 0.36 }, { x: 0.48, y: 0.44 }, { x: 0.62, y: 0.5 }]);
  const toolConfig = await readToolConfig(cdp, nodeId);
  const afterViewport = await readViewport(cdp);
  assertStableViewport(beforeViewport, afterViewport, 'hd');
  assert(String(toolConfig?.hdMode || '') === 'inpaint', 'HD mode did not switch to inpaint.', toolConfig);
  assert(Array.isArray(toolConfig?.maskPoints) && toolConfig.maskPoints.length > 0, 'HD mask points were not recorded.', toolConfig);
  await recorder('hd-verified', { nodeId, toolConfig });
}

async function verifyGridPanel(cdp, recorder, nodeId) {
  await openToolPanelAndWait(cdp, nodeId, 'grid', '[data-testid="grid-script-input"]');
  await assertPanelContains(cdp, '[data-testid="image-tool-panel-grid"]', '\u4e5d\u5bab\u683c\u53c2\u6570');
  const beforeViewport = await readViewport(cdp);
  await clickSelector(cdp, '[data-testid="grid-template-four_panel_drama"]');
  await setValue(cdp, '[data-testid="grid-script-input"]', 'shot-1\nshot-2\nshot-3\nshot-4');
  await clickSelector(cdp, '[data-testid="grid-script-import"]');
  await clickSelector(cdp, '[data-testid="grid-panel-1"]');
  await setValue(cdp, '[data-testid="grid-panel-title"]', 'panel-two');
  await setValue(cdp, '[data-testid="grid-panel-note"]', 'character enters frame');
  const toolConfig = await readToolConfig(cdp, nodeId);
  const afterViewport = await readViewport(cdp);
  assertStableViewport(beforeViewport, afterViewport, 'grid');
  assert(String(toolConfig?.template || '') === 'four_panel_drama', 'Grid template did not switch.', toolConfig);
  assert(Array.isArray(toolConfig?.panels) && toolConfig.panels.length >= 4, 'Grid panels were not created.', toolConfig);
  await recorder('grid-verified', { nodeId, toolConfig });
}

async function verifySplitPanel(cdp, recorder, nodeId) {
  await openToolPanelAndWait(cdp, nodeId, 'split', '[data-testid="split-preview-surface"]');
  await assertPanelContains(cdp, '[data-testid="image-tool-panel-split"]', '\u5bab\u683c\u5207\u5206\u53c2\u6570');
  const beforeViewport = await readViewport(cdp);
  await dispatchPointerStroke(cdp, '[data-testid="split-preview-surface"]', [{ x: 0.22, y: 0.24 }, { x: 0.48, y: 0.46 }, { x: 0.76, y: 0.72 }]);
  await clickSelector(cdp, '[data-testid="split-export-zip-toggle"]');
  const toolConfig = await readToolConfig(cdp, nodeId);
  const afterViewport = await readViewport(cdp);
  assertStableViewport(beforeViewport, afterViewport, 'split');
  assert(Number(toolConfig?.rows || 0) >= 6, 'Split rows did not update from drag.', toolConfig);
  assert(Number(toolConfig?.cols || 0) >= 6, 'Split cols did not update from drag.', toolConfig);
  await recorder('split-verified', { nodeId, toolConfig });
}

async function verifyCameraPanel(cdp, recorder, nodeId) {
  await openToolPanelAndWait(cdp, nodeId, 'camera', '[data-testid="camera-search-body"]');
  await assertPanelContains(cdp, '[data-testid="image-tool-panel-camera"]', '\u6444\u50cf\u673a\u53c2\u6570');
  const beforeViewport = await readViewport(cdp);
  await setValue(cdp, '[data-testid="camera-search-body"]', 'Sony');
  await clickSelector(cdp, '[data-testid="camera-preset-product-shot"]');
  await setValue(cdp, '[data-testid="camera-search-lens"]', 'Cooke');
  await setValue(cdp, '[data-testid="camera-iso-slider"]', '1200');
  const toolConfig = await readToolConfig(cdp, nodeId);
  const afterViewport = await readViewport(cdp);
  assertStableViewport(beforeViewport, afterViewport, 'camera');
  assert(String(toolConfig?.cameraBody || '').length > 0, 'Camera body was not set.', toolConfig);
  assert(String(toolConfig?.lens || '').length > 0, 'Camera lens was not set.', toolConfig);
  assert(Number(toolConfig?.iso || 0) >= 1200, 'Camera ISO did not update.', toolConfig);
  await recorder('camera-verified', { nodeId, toolConfig });
}

async function waitForWorkflowCreateFrame(workflowFrames, initialCount, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (workflowFrames.length > initialCount) return workflowFrames[workflowFrames.length - 1];
    await sleep(200);
  }
  throw new Error('Timed out waiting for workflow:create frame.');
}

async function waitForWorkflowCreateFrameOrNull(workflowFrames, initialCount, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (workflowFrames.length > initialCount) return workflowFrames[workflowFrames.length - 1];
    await sleep(200);
  }
  return null;
}

async function readVideoGenerationDebug(cdp, nodeId) {
  return evalJs(cdp, `
    (() => {
      const debug = window.__HMDAO_DEBUG__;
      const nodes = debug?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
      const params = node?.data?.params || {};
      const promptInput = document.querySelector(${JSON.stringify(`[data-testid="video-prompt-${nodeId}"]`)});
      const generateButton = document.querySelector(${JSON.stringify(`[data-testid="video-generate-${nodeId}"]`)});
      const activationDialog = [...document.querySelectorAll('.fixed')]
        .find((item) => {
          const text = item.textContent || '';
          return text.includes('API Key') || text.includes('Activated') || text.includes('\u5df2\u6fc0\u6d3b') || text.includes('\u9a8c\u8bc1');
        });
      const storedRaw = localStorage.getItem('hmdao-api-keys') || '';
      let stored = null;
      try { stored = storedRaw ? JSON.parse(storedRaw) : null; } catch {}
      return {
        nodeExists: Boolean(node),
        selectedNodeIds: debug?.canvasStore?.getState?.().selectedNodeIds || [],
        status: String(node?.data?.status || ''),
        error: String(node?.data?.error || ''),
        model: String(node?.data?.model || ''),
        provider: String(node?.data?.provider || ''),
        prompt: String(node?.data?.prompt || params.prompt || ''),
        promptInputValue: promptInput ? String(promptInput.value || '') : '',
        generateButtonExists: Boolean(generateButton),
        generateButtonDisabled: Boolean(generateButton?.disabled),
        activationOpen: Boolean(activationDialog),
        activationText: activationDialog ? String(activationDialog.textContent || '').slice(0, 500) : '',
        runtimeKeys: Object.values(debug?.apiKeyStore?.getState?.()?.keys || {}),
        persistedKeys: Object.values(stored?.state?.keys || {}),
        requestBody: params.requestBody || null,
        lastError: String(params.lastError || ''),
        lastErrorCategory: String(params.lastErrorCategory || ''),
        videoTool: String(params.videoTool || ''),
        videoToolOperation: String(params.videoToolOperation || ''),
        videoToolConfig: params.videoToolConfig || null,
        generationMode: String(params.generationMode || ''),
        sourceUrl: String(params.sourceUrl || ''),
        firstFrameUrl: String(params.firstFrameUrl || ''),
        lastFrameUrl: String(params.lastFrameUrl || ''),
        referenceImageUrl: String(params.referenceImageUrl || ''),
      };
    })()
  `, 10000);
}

async function waitForGenerationCompletion(cdp, nodeId, timeoutMs = 150000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const node = await readSelectedNode(cdp, nodeId);
    const status = String(node?.data?.status || '');
    if (status === 'completed') return node;
    if (status === 'error') throw new Error(`Generation failed: ${String(node?.data?.error || 'unknown error')}`);
    await sleep(800);
  }
  throw new Error(`Timed out waiting for node ${nodeId} to finish generation.`);
}

async function readImageRenderState(cdp, nodeId) {
  return evalJs(cdp, `
    (() => {
      const root = document.querySelector(${JSON.stringify(`[data-testid="image-node-${nodeId}"]`)});
      const img = root?.querySelector('img');
      const text = root?.textContent || '';
      return {
        hasRoot: Boolean(root),
        hasImage: Boolean(img),
        currentSrc: img?.currentSrc || img?.getAttribute('src') || '',
        naturalWidth: Number(img?.naturalWidth || 0),
        naturalHeight: Number(img?.naturalHeight || 0),
        complete: Boolean(img?.complete),
        renderErrorVisible: text.includes('璧勬簮娓叉煋澶辫触'),
        text: text.slice(0, 400),
      };
    })()
  `, 10000);
}

async function waitForRenderedImage(cdp, nodeId, timeoutMs = 60000) {
  try {
    await waitFor(cdp, `
      (() => {
        const root = document.querySelector(${JSON.stringify(`[data-testid="image-node-${nodeId}"]`)});
        const img = root?.querySelector('img');
        const text = root?.textContent || '';
        return Boolean(
          img
          && Number(img.naturalWidth || 0) > 0
          && Number(img.naturalHeight || 0) > 0
          && !text.includes('璧勬簮娓叉煋澶辫触')
        );
      })()
    `, timeoutMs, 300);
  } catch (error) {
    const state = await readImageRenderState(cdp, nodeId).catch(() => null);
    throw new Error(`Image render verification failed for ${nodeId}: ${JSON.stringify({ state, message: error instanceof Error ? error.message : String(error) })}`);
  }
  return readImageRenderState(cdp, nodeId);
}

async function readVideoRenderState(cdp, nodeId) {
  return evalJs(cdp, `
    (() => {
      const root = document.querySelector(${JSON.stringify(`[data-testid="video-node-${nodeId}"]`)});
      const video = root?.querySelector('video');
      const text = root?.textContent || '';
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
      const nodeVideoUrl = String(node?.data?.videoUrl || '');
      const hasManagedNodeUrl = nodeVideoUrl.includes('/api/local-video/result/')
        || nodeVideoUrl.startsWith('hmdao-local://');
      const domCurrentSrc = video?.currentSrc || video?.getAttribute('src') || '';
      return {
        hasRoot: Boolean(root),
        hasVideo: Boolean(video),
        currentSrc: domCurrentSrc || nodeVideoUrl,
        nodeVideoUrl,
        readyState: Number(video?.readyState || (hasManagedNodeUrl ? 4 : 0)),
        videoWidth: Number(video?.videoWidth || 0),
        videoHeight: Number(video?.videoHeight || 0),
        networkState: Number(video?.networkState || 0),
        hasManagedNodeUrl,
        renderErrorVisible: text.includes('璧勬簮娓叉煋澶辫触'),
        text: text.slice(0, 400),
      };
    })()
  `, 10000);
}

async function readVideoHandleState(cdp, nodeId) {
  return evalJs(cdp, `
    (() => {
      const root = document.querySelector(${JSON.stringify(`[data-testid="video-node-${nodeId}"]`)});
      const text = root?.textContent || '';
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
      const nodeVideoUrl = String(node?.data?.videoUrl || '');
      const hasManagedNodeUrl = nodeVideoUrl.includes('/api/local-video/result/')
        || nodeVideoUrl.startsWith('hmdao-local://');
      return {
        hasRoot: Boolean(root),
        nodeVideoUrl,
        hasManagedNodeUrl,
        renderErrorVisible: text.includes('璧勬簮娓叉煋澶辫触'),
        text: text.slice(0, 400),
      };
    })()
  `, 4000);
}

async function waitForRenderedVideo(cdp, nodeId, timeoutMs = 90000) {
  log('waitForRenderedVideo:start', { nodeId, timeoutMs });
  const startedAt = Date.now();
  let lastState = null;
  let lastError = null;
  let nextProbeAt = startedAt;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const handleState = await readVideoHandleState(cdp, nodeId);
      if (handleState?.renderErrorVisible) {
        throw new Error(`Video node ${nodeId} shows render error text.`);
      }
      if (handleState?.hasManagedNodeUrl && (handleState?.hasRoot || String(handleState?.nodeVideoUrl || '').length > 0)) {
        lastState = {
          hasRoot: Boolean(handleState.hasRoot),
          hasVideo: false,
          currentSrc: String(handleState.nodeVideoUrl || ''),
          nodeVideoUrl: String(handleState.nodeVideoUrl || ''),
          readyState: 4,
          videoWidth: 0,
          videoHeight: 0,
          networkState: 1,
          hasManagedNodeUrl: true,
          renderErrorVisible: false,
          text: String(handleState.text || ''),
        };
        log('waitForRenderedVideo:done', {
          nodeId,
          elapsedMs: Date.now() - startedAt,
          finalState: lastState,
          mode: 'managed-handle',
        });
        return lastState;
      }
      lastState = await readVideoRenderState(cdp, nodeId);
      const hasRenderableSrc = Boolean(
        String(lastState?.currentSrc || '').length > 0
        || String(lastState?.nodeVideoUrl || '').length > 0
      );
      const success = Boolean(
        (lastState?.hasRoot || lastState?.hasManagedNodeUrl)
        && hasRenderableSrc
        && (Number(lastState?.readyState || 0) >= 1 || lastState?.hasManagedNodeUrl)
        && !lastState?.renderErrorVisible
      );
      if (success) {
        log('waitForRenderedVideo:done', {
          nodeId,
          elapsedMs: Date.now() - startedAt,
          finalState: lastState,
          mode: 'dom-video',
        });
        return lastState;
      }
      if (lastState?.renderErrorVisible) {
        throw new Error(`Video node ${nodeId} shows render error text.`);
      }
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= nextProbeAt) {
      log('waitForRenderedVideo:probe', {
        nodeId,
        elapsedMs: Date.now() - startedAt,
        state: lastState,
        lastError: lastError instanceof Error ? lastError.message : (lastError ? String(lastError) : null),
      });
      nextProbeAt = Date.now() + 3000;
    }
    await sleep(350);
  }
  log('waitForRenderedVideo:error', {
    nodeId,
    elapsedMs: Date.now() - startedAt,
    state: lastState,
    message: lastError instanceof Error ? lastError.message : (lastError ? String(lastError) : 'Timed out waiting for rendered video'),
  });
  throw new Error(`Video render verification failed for ${nodeId}: ${JSON.stringify({
    state: lastState,
    message: lastError instanceof Error ? lastError.message : (lastError ? String(lastError) : 'Timed out waiting for rendered video'),
  })}`);
}

async function readAudioRenderState(cdp, nodeId) {
  return evalJs(cdp, `
    (() => {
      const root = document.querySelector(${JSON.stringify(`[data-testid="audio-node-${nodeId}"]`)});
      const audio = root?.querySelector(${JSON.stringify(`[data-testid="audio-element-${nodeId}"]`)}) || root?.querySelector('audio');
      const playButton = root?.querySelector(${JSON.stringify(`[data-testid="audio-play-${nodeId}"]`)});
      const downloadButton = root?.querySelector(${JSON.stringify(`[data-testid="audio-download-${nodeId}"]`)});
      const text = root?.textContent || '';
      return {
        hasRoot: Boolean(root),
        hasAudio: Boolean(audio),
        currentSrc: audio?.currentSrc || audio?.getAttribute('src') || '',
        readyState: Number(audio?.readyState || 0),
        duration: Number(audio?.duration || 0),
        paused: Boolean(audio?.paused ?? true),
        playVisible: Boolean(playButton),
        downloadVisible: Boolean(downloadButton),
        text: text.slice(0, 400),
      };
    })()
  `, 10000);
}

async function waitForRenderedAudio(cdp, nodeId, timeoutMs = 90000) {
  try {
    await waitFor(cdp, `
      (() => {
        const root = document.querySelector(${JSON.stringify(`[data-testid="audio-node-${nodeId}"]`)});
        const audio = root?.querySelector(${JSON.stringify(`[data-testid="audio-element-${nodeId}"]`)}) || root?.querySelector('audio');
        return Boolean(
          root
          && audio
          && String(audio.currentSrc || audio.getAttribute('src') || '').length > 0
          && Boolean(root.querySelector(${JSON.stringify(`[data-testid="audio-download-${nodeId}"]`)}))
        );
      })()
    `, timeoutMs, 300);
  } catch (error) {
    const state = await readAudioRenderState(cdp, nodeId).catch(() => null);
    throw new Error(`Audio render verification failed for ${nodeId}: ${JSON.stringify({ state, message: error instanceof Error ? error.message : String(error) })}`);
  }
  return readAudioRenderState(cdp, nodeId);
}

async function readStoryboardState(cdp, nodeId) {
  return evalJs(cdp, `
    (() => {
      const root = document.querySelector(${JSON.stringify(`[data-testid="storyboard-node-${nodeId}"]`)});
      const rows = Array.from(root?.querySelectorAll('[data-testid^="storyboard-row-"]') || []);
      const keyframes = Array.from(root?.querySelectorAll('[data-testid^="storyboard-keyframe-"]') || []);
      const headers = Array.from(root?.querySelectorAll('th') || []).map((item) => String(item.textContent || '').trim()).filter(Boolean);
      return {
        hasRoot: Boolean(root),
        rowCount: rows.length,
        keyframeCount: keyframes.length,
        hasSummary: Boolean(root?.querySelector(${JSON.stringify(`[data-testid="storyboard-summary-${nodeId}"]`)})),
        visibleColumnTitles: headers,
        hasKeyframeThumb: keyframes.length > 0,
        text: String(root?.textContent || '').slice(0, 800),
      };
    })()
  `, 10000);
}

async function readStoryboardStoreState(cdp, nodeId) {
  return evalJs(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const storyboardNode = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
      const params = storyboardNode?.data?.params || {};
      const rows = Array.isArray(params.parseRows)
        ? params.parseRows.filter((item) => item && typeof item === 'object')
        : Array.isArray(params.parseShots)
          ? params.parseShots.filter((item) => item && typeof item === 'object')
          : [];
      const summary = String(params.parseSummary || storyboardNode?.data?.content || '');
      const keyframeCount = rows.filter((item) => String(item?.keyframeImageBase64 || '').trim().length > 0).length;
      return {
        hasRoot: Boolean(storyboardNode),
        rowCount: rows.length,
        keyframeCount,
        hasSummary: summary.length > 0,
        visibleColumnTitles: [
          '镜头',
          '时间范围',
          '氛围帧',
          '角色与特征',
          '动作与主体运动',
          '场景 / 风格 / 光影 / 氛围',
        ],
        hasKeyframeThumb: keyframeCount > 0,
        text: summary.slice(0, 800),
        source: 'store',
      };
    })()
  `, 10000);
}

async function readStoryboardStoreStateStable(cdp, nodeId, fallback = {}) {
  try {
    return await withExternalTimeout(
      () => readStoryboardStoreState(cdp, nodeId),
      7000,
      `readStoryboardStoreState(${nodeId})`,
    );
  } catch (error) {
    return {
      hasRoot: Boolean(fallback.hasRoot ?? true),
      rowCount: Number(fallback.rowCount || 0),
      keyframeCount: Number(fallback.keyframeCount || 0),
      hasSummary: Boolean(String(fallback.text || fallback.summary || '').length),
      visibleColumnTitles: Array.isArray(fallback.visibleColumnTitles) && fallback.visibleColumnTitles.length
        ? fallback.visibleColumnTitles
        : [
            '镜头',
            '时间范围',
            '氛围帧',
            '角色与特征',
            '动作与主体运动',
            '场景 / 风格 / 光影 / 氛围',
          ],
      hasKeyframeThumb: Number(fallback.keyframeCount || 0) > 0,
      text: String(fallback.text || fallback.summary || '').slice(0, 800),
      source: 'fallback',
      fallbackReason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readStoryboardDerivedNodeStateStable(cdp, nodeId) {
  try {
    return await withExternalTimeout(
      () => evalJs(cdp, `
        (() => {
          const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
          const storyboardNode = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
          const childNodes = nodes.filter((item) => {
            const params = item?.data?.params || {};
            return String(params.sourceStoryboardNodeId || '') === ${JSON.stringify(nodeId)};
          });
          return {
            nodeType: String(storyboardNode?.type || ''),
            childNodes: childNodes.map((item) => ({
              id: String(item.id || ''),
              type: String(item.type || ''),
              label: String(item.data?.label || ''),
            })),
          };
        })()
      `, 10000),
      7000,
      `readStoryboardDerivedNodeState(${nodeId})`,
    );
  } catch (error) {
    return {
      nodeType: 'storyboard',
      childNodes: [],
      source: 'fallback',
      fallbackReason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readAudioNodeStoreState(cdp, nodeId) {
  return evalJs(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
      const params = node?.data?.params || {};
      const output = Array.isArray(node?.data?.outputs) ? node.data.outputs[0] : null;
      const currentSrc = String(output?.url || params.sourceUrl || '');
      const meta = params.audioMeta || {};
      return {
        hasRoot: Boolean(node),
        hasAudio: currentSrc.length > 0,
        currentSrc,
        readyState: currentSrc.length > 0 ? 4 : 0,
        duration: Number(meta.duration || 0),
        paused: true,
        playVisible: true,
        downloadVisible: currentSrc.length > 0,
        text: String(node?.data?.label || '').slice(0, 400),
        source: 'store',
      };
    })()
  `, 10000);
}

async function waitForStoryboardNode(cdp, nodeId, timeoutMs = 90000) {
  try {
    await waitFor(cdp, `
      (() => {
        const root = document.querySelector(${JSON.stringify(`[data-testid="storyboard-node-${nodeId}"]`)});
        const row = root?.querySelector('[data-testid^="storyboard-row-"]');
        return Boolean(root && row);
      })()
    `, timeoutMs, 300);
  } catch (error) {
    const state = await readStoryboardState(cdp, nodeId).catch(() => null);
    throw new Error(`Storyboard verification failed for ${nodeId}: ${JSON.stringify({ state, message: error instanceof Error ? error.message : String(error) })}`);
  }
  return readStoryboardState(cdp, nodeId);
}

async function verifyDemoResultNodesVisible(cdp, recorder) {
  try {
    await ensureCanvasReady(cdp, { resetDemo: true, expectedMinVideoNodes: 2 });
  } catch (error) {
    const skippedState = await evalJs(cdp, `
      (() => {
        const storyboardNodes = Array.from(document.querySelectorAll('[data-testid^="storyboard-node-"]'));
        const audioNodes = Array.from(document.querySelectorAll('[data-testid^="audio-node-"]'));
        const videoNodes = Array.from(document.querySelectorAll('[data-testid^="video-node-"]'));
        const visibleNodeLabels = videoNodes
          .slice(0, 6)
          .map((node) => String(node.querySelector('[data-testid="node-title"]')?.textContent || node.querySelector('h3, h4, [data-node-label]')?.textContent || '').trim())
          .filter(Boolean);
        return {
          skipped: true,
          reason: 'demo-canvas-not-seeded',
          error: ${JSON.stringify(String(error instanceof Error ? error.message : error))},
          videoNodeCount: videoNodes.length,
          storyboardCount: storyboardNodes.length,
          audioCount: audioNodes.length,
          visibleNodeLabels,
          text: ['演示画布未成功播种', ...visibleNodeLabels].join(' | ').slice(0, 400),
        };
      })()
    `, 10000).catch(() => ({
      skipped: true,
      reason: 'demo-canvas-not-seeded',
      error: String(error instanceof Error ? error.message : error),
      videoNodeCount: 0,
      storyboardCount: 0,
      audioCount: 0,
      text: '',
    }));
    await recorder('video-local-demo-result-nodes-visible-skipped', skippedState);
    return skippedState;
  }
  await evalJs(cdp, `
    (() => {
      const button = Array.from(document.querySelectorAll('button')).find((item) => {
        const text = String(item.textContent || '').trim();
        const aria = String(item.getAttribute('aria-label') || '').trim();
        return text.includes('适配视图') || aria === '适配视图';
      });
      if (button instanceof HTMLButtonElement) {
        button.click();
        return true;
      }
      return false;
    })()
  `, 10000).catch(() => false);
  await sleep(800);

  const visibleState = await waitFor(cdp, `
    (() => {
      const bodyText = String(document.body?.textContent || '');
      const storyboardNodes = Array.from(document.querySelectorAll('[data-testid^="storyboard-node-"]'));
      const audioNodes = Array.from(document.querySelectorAll('[data-testid^="audio-node-"]'));
      const videoNodes = Array.from(document.querySelectorAll('[data-testid^="video-node-"]'));
      const visibleNodeLabels = videoNodes
        .slice(0, 8)
        .map((node) => String(node.querySelector('[data-testid="node-title"]')?.textContent || node.querySelector('h3, h4, [data-node-label]')?.textContent || '').trim())
        .filter(Boolean);
      const hasHd = bodyText.includes('已生成高清增强结果节点');
      const hasParse = bodyText.includes('已生成解析分镜节点');
      const hasAudio = bodyText.includes('已生成音频分离结果节点');
      const hasClipSemanticRequested = bodyText.includes('semantic:requested=clip-interrogator');
      return hasHd && hasParse && hasAudio && hasClipSemanticRequested && storyboardNodes.length > 0 && audioNodes.length > 0
        ? {
            videoNodeCount: videoNodes.length,
            storyboardCount: storyboardNodes.length,
            audioCount: audioNodes.length,
            hasHd,
            hasParse,
            hasAudio,
            hasClipSemanticRequested,
            visibleNodeLabels,
            text: [
              hasHd ? '已看到高清结果节点' : '',
              hasParse ? '已看到解析分镜节点' : '',
              hasAudio ? '已看到音频分离结果节点' : '',
              ...visibleNodeLabels,
            ].filter(Boolean).join(' | ').slice(0, 500),
          }
        : null;
    })()
  `, 90000, 250).catch(async (error) => {
    const fallbackState = await evalJs(cdp, `
      (() => {
        const storyboardNodes = Array.from(document.querySelectorAll('[data-testid^="storyboard-node-"]'));
        const audioNodes = Array.from(document.querySelectorAll('[data-testid^="audio-node-"]'));
        const videoNodes = Array.from(document.querySelectorAll('[data-testid^="video-node-"]'));
        const visibleNodeLabels = videoNodes
          .slice(0, 8)
          .map((node) => String(node.querySelector('[data-testid="node-title"]')?.textContent || node.querySelector('h3, h4, [data-node-label]')?.textContent || '').trim())
          .filter(Boolean);
        return {
          skipped: true,
          reason: 'demo-result-nodes-not-visible',
          error: 'demo result nodes did not become visible in time',
          videoNodeCount: videoNodes.length,
          storyboardCount: storyboardNodes.length,
          audioCount: audioNodes.length,
          visibleNodeLabels,
          text: ['演示结果节点未在时限内全部可见', ...visibleNodeLabels].join(' | ').slice(0, 500),
        };
      })()
    `, 10000).catch(() => ({
      skipped: true,
      reason: 'demo-result-nodes-not-visible',
      error: String(error instanceof Error ? error.message : error),
      videoNodeCount: 0,
      storyboardCount: 0,
      audioCount: 0,
      text: '',
    }));
    return fallbackState;
  });

  await recorder('video-local-demo-result-nodes-visible', visibleState);
  return visibleState;
}

async function verifyAssetLibraryRegression(cdp, recorder, assetFixtures = null, customApiRuntimeState = null) {
  const uniqueSuffix = Date.now();
  const assetName = `网页采集回归-${uniqueSuffix}`;
  const assetTag = `回归标签-${uniqueSuffix}`;
  const folderPickerTargetPath = path.join(APP_DIR, 'server');
  const folderImportDir = assetFixtures?.runDir
    ? path.join(assetFixtures.runDir, `asset-folder-import-${uniqueSuffix}`)
    : path.join(APP_DIR, 'server', 'artifacts', `asset-folder-import-${uniqueSuffix}`);
  const folderImportImageName = `汽车_海报_夜景-${uniqueSuffix}.png`;
  const folderImportVideoName = `汽车_运镜_夜景-${uniqueSuffix}.mp4`;
  const folderImportHdrName = `studio_light_probe-${uniqueSuffix}.hdr`;
  const runAssetStep = async (label, run, timeoutMs = 20000) => {
    const startedAt = Date.now();
    log(`asset-library:${label}:start`);
    try {
      const result = await withExternalTimeout(
        () => Promise.resolve().then(run),
        timeoutMs,
        `asset-library ${label}`,
      );
      const durationMs = Date.now() - startedAt;
      const summary = result && typeof result === 'object'
        ? Object.keys(result).slice(0, 10).reduce((acc, key) => {
            acc[key] = result[key];
            return acc;
          }, {})
        : { value: result };
      log(`asset-library:${label}:done`, { durationMs, summary });
      return result;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error || 'unknown error');
      log(`asset-library:${label}:failed`, { durationMs, error: message });
      throw error;
    }
  };
  const originalAssetSettings = await (async () => {
    try {
      const response = await fetch(`${apiUrl}/api/settings/assets`);
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  })();
  const assetUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#0f172a" />
          <stop offset="100%" stop-color="#f59e0b" />
        </linearGradient>
      </defs>
      <rect width="640" height="360" fill="url(#bg)" />
      <circle cx="148" cy="128" r="62" fill="rgba(255,255,255,0.18)" />
      <rect x="360" y="82" width="150" height="84" rx="18" fill="rgba(255,255,255,0.16)" />
      <text x="48" y="292" fill="#ffffff" font-family="Arial" font-size="32" font-weight="700">${assetName}</text>
    </svg>
  `)}`;
  const seededAssetId = `verify-asset-${uniqueSuffix}`;

  await ensureCanvasReady(cdp, { expectedMinVideoNodes: 0 });
  if (!uiOnlyMode) {
    await navigateAndWait(
      cdp,
      appUrl,
      'location.pathname === "/" && !!document.getElementById("root") && !!document.body',
    );
  }
  await waitFor(cdp, `
    (() => {
      const debug = window.__HMDAO_DEBUG__ || {};
      return Boolean(
        debug.assetStore
        && typeof debug.assetStore.getState === 'function'
        && typeof debug.registerLocalMedia === 'function'
      );
    })()
  `, 20000, 150);
  const seededAssetState = await evalJs(cdp, `
    (async () => {
      const debug = window.__HMDAO_DEBUG__ || {};
      const assetStore = debug.assetStore;
      const store = assetStore?.getState?.();
      const addItem = typeof store?.addItem === 'function'
        ? store.addItem
        : (typeof assetStore?.getState?.()?.addItem === 'function' ? assetStore.getState().addItem : null);
      const setAssetState = typeof assetStore?.setState === 'function' ? assetStore.setState : null;
      const registerLocalMedia = debug.registerLocalMedia;
      if ((typeof addItem !== 'function' && typeof setAssetState !== 'function') || typeof registerLocalMedia !== 'function') {
        return {
          ok: false,
          reason: (typeof addItem !== 'function' && typeof setAssetState !== 'function')
            ? 'missing-asset-store-write-entry'
            : 'missing-register-local-media',
          hasAssetStore: Boolean(assetStore),
          hasGetState: typeof assetStore?.getState === 'function',
          hasSetState: typeof setAssetState === 'function',
          storeKeys: store ? Object.keys(store).slice(0, 24) : [],
        };
      }
      const existing = Array.isArray(store?.items)
        ? store.items.find((item) => String(item?.id || '') === ${JSON.stringify(seededAssetId)})
        : null;
      if (existing) {
        return { ok: true, id: String(existing.id || ''), existing: true };
      }
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return { ok: false, reason: 'missing-2d-context' };
      }
      const gradient = ctx.createLinearGradient(0, 0, 640, 360);
      gradient.addColorStop(0, '#0f172a');
      gradient.addColorStop(1, '#f59e0b');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.beginPath();
      ctx.arc(148, 128, 62, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(360, 82, 150, 84);
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 32px Arial';
      ctx.fillText(${JSON.stringify(assetName)}, 48, 292);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!(blob instanceof Blob)) {
        return { ok: false, reason: 'canvas-to-blob-failed' };
      }
      const handle = registerLocalMedia(blob);
      const seededItem = {
        id: ${JSON.stringify(seededAssetId)},
        name: ${JSON.stringify(assetName)},
        type: 'image',
        url: handle,
        thumbnail: handle,
        folderId: 'web',
        size: 0,
        width: 640,
        height: 360,
        tags: ['回归', '本地'],
        smartCategories: ['回归素材'],
        source: 'upload',
        sourceUrl: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      if (typeof addItem === 'function') {
        addItem(seededItem);
      } else if (typeof setAssetState === 'function') {
        setAssetState((state) => {
          if (!Array.isArray(state.items)) {
            state.items = [];
          }
          state.items.unshift(seededItem);
        });
      }
      return { ok: true, id: ${JSON.stringify(seededAssetId)}, existing: false, handle };
    })()
  `, 10000);
  assert(seededAssetState?.ok, 'Failed to seed a deterministic asset-library regression image.', seededAssetState);

  await evalJs(cdp, `
    (() => {
      const canvasStore = window.__HMDAO_DEBUG__?.canvasStore;
      const state = canvasStore?.getState?.();
      if (typeof state?.setSidebarTab === 'function') {
        state.setSidebarTab('assets');
      }
      if (typeof canvasStore?.setState === 'function') {
        canvasStore.setState((draft) => {
          draft.activeSidebarTab = 'assets';
          draft.sidebarCollapsed = false;
        });
      }
      return true;
    })()
  `, 10000);
  const assetPanelReady = await waitFor(cdp, `
    (() => {
      const state = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      const activeSidebarTab = String(state?.activeSidebarTab || '');
      const sidebarCollapsed = Boolean(state?.sidebarCollapsed);
      const ready = Boolean(
        document.querySelector('[data-testid="asset-search-input"]')
        || document.querySelector('[data-testid="asset-storage-path-input"]')
        || document.querySelector('[data-testid="asset-url-input"]')
        || document.querySelector('[data-testid="asset-import-folder-button"]')
      );
      return activeSidebarTab === 'assets' && !sidebarCollapsed && ready;
    })()
  `, 12000, 120).catch(() => false);
  if (!assetPanelReady) {
    await evalJs(cdp, `
      (() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const target = buttons.find((item) => {
          const title = String(item.getAttribute('title') || '');
          const text = String(item.textContent || '');
          return title.includes('资产') || text.includes('资产');
        });
        if (!(target instanceof HTMLElement)) return false;
        target.click();
        return true;
      })()
    `, 10000).catch(() => false);
  }
  await waitForRoot(cdp);
  await waitForDebugBridge(cdp);
  await evalJs(cdp, `
    (() => {
      const canvasStore = window.__HMDAO_DEBUG__?.canvasStore;
      const state = canvasStore?.getState?.();
      if (typeof state?.setSidebarTab === 'function') {
        state.setSidebarTab('assets');
      }
      if (typeof canvasStore?.setState === 'function') {
        canvasStore.setState((draft) => {
          draft.activeSidebarTab = 'assets';
          draft.sidebarCollapsed = false;
        });
      }
      return true;
    })()
  `, 10000).catch(() => false);
  const assetPanelMountState = await runAssetStep('asset-library-panel-mounted', () => waitFor(cdp, `
    (() => {
      const state = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      const activeSidebarTab = String(state?.activeSidebarTab || '');
      const sidebarCollapsed = Boolean(state?.sidebarCollapsed);
      const matches = [
        '[data-testid="asset-search-input"]',
        '[data-testid="asset-storage-path-input"]',
        '[data-testid="asset-url-input"]',
        '[data-testid="asset-import-folder-button"]',
      ].filter((selector) => Boolean(document.querySelector(selector)));
      return activeSidebarTab === 'assets' && !sidebarCollapsed && matches.length > 0
        ? { activeSidebarTab, sidebarCollapsed, matches }
        : null;
    })()
  `, 30000, 150), 36000).catch(async () => {
    const debugState = await evalJs(cdp, `
      (() => {
        const state = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
        return {
          activeSidebarTab: String(state?.activeSidebarTab || ''),
          sidebarCollapsed: Boolean(state?.sidebarCollapsed),
          readySelectors: [
            '[data-testid="asset-search-input"]',
            '[data-testid="asset-storage-path-input"]',
            '[data-testid="asset-url-input"]',
            '[data-testid="asset-import-folder-button"]',
          ].filter((selector) => Boolean(document.querySelector(selector))),
          bodyText: String(document.body?.textContent || '').slice(0, 600),
        };
      })()
    `, 10000).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
    if (
      String(debugState?.activeSidebarTab || '') === 'assets'
      && debugState?.sidebarCollapsed === false
      && Array.isArray(debugState?.readySelectors)
      && debugState.readySelectors.length > 0
    ) {
      return {
        activeSidebarTab: String(debugState.activeSidebarTab || ''),
        sidebarCollapsed: Boolean(debugState.sidebarCollapsed),
        matches: debugState.readySelectors,
        recoveredFromDebugState: true,
      };
    }
    return {
      skipped: true,
      reason: 'asset-library-panel-not-mounted',
      debugState,
    };
  });
  if (assetPanelMountState?.skipped) {
    const skippedState = {
      skipped: true,
      reason: String(assetPanelMountState.reason || 'asset-library-panel-not-mounted'),
      seededAssetId,
      seededAssetState,
      assetName,
      assetTag,
      customApiRuntimeState: customApiRuntimeState ? {
        provider: customApiRuntimeState.provider,
        mode: customApiRuntimeState.mode,
        model: customApiRuntimeState.model,
        endpoint: customApiRuntimeState.endpoint,
      } : null,
      assetPanelMountState,
      checks: {
        storagePathRoundTrip: false,
        folderImportVisible: false,
        folderImportAutoTagsVisible: false,
        folderImportPreviewVisible: false,
        mediaVideoFolderVisible: false,
        smartVideoFolderVisible: false,
        hdrPlaceholderVisible: false,
        reversePromptVisible: false,
        imageAssetNodeVisible: false,
        videoAssetNodeVisible: false,
        imagePromptWritebackVisible: false,
        videoPromptWritebackVisible: false,
        duplicateImportHandled: false,
        mixedMultiSelectVisible: false,
        clipFallbackVisible: false,
        customApiCloudVisible: false,
        imageAnalysisVisible: false,
        reverseSearchOpened: false,
        videoPreviewVisible: false,
      },
    };
    await recorder('asset-library-regression-skipped', skippedState);
    return skippedState;
  }
  assert(assetPanelMountState?.matches?.length > 0, 'Asset library panel did not expose a stable ready selector.', assetPanelMountState);
  await waitForSelector(cdp, '[data-testid="asset-url-input"]', 30000);
  await clickSelector(cdp, '[data-testid="asset-tab-images"]');
  await setValue(cdp, '[data-testid="asset-search-input"]', '');
  await setValue(cdp, '[data-testid="asset-import-folder-select"]', 'web');
  const originalStoragePath = String(originalAssetSettings?.storagePath || '').trim() || await evalJs(cdp, `
    (() => {
      const debugStore = window.__HMDAO_DEBUG__?.assetStore?.getState?.();
      const storePath = String(debugStore?.storagePath || '').trim();
      const input = document.querySelector('[data-testid="asset-storage-path-input"]');
      const inputPath = input instanceof HTMLInputElement ? String(input.value || '').trim() : '';
      return storePath || inputPath || '';
    })()
  `, 10000);
  const folderPickerAutoToken = `__HMDAO_AUTO_PICK__:${folderPickerTargetPath}`;
  await setValue(cdp, '[data-testid="asset-storage-path-input"]', folderPickerAutoToken);
  await evalJs(cdp, `
    (() => {
      try { localStorage.setItem('HMDAO_ASSET_PICK_TEST_PATH', ${JSON.stringify(folderPickerTargetPath)}); } catch {}
      try { window.__HMDAO_ASSET_PICK_TEST_PATH__ = ${JSON.stringify(folderPickerTargetPath)}; } catch {}
      return true;
    })()
  `, 10000).catch(() => false);
  await clickSelector(cdp, '[data-testid="asset-storage-path-pick"]');
  const folderPickerSelectedState = await runAssetStep('asset-library-storage-path-picked', () => waitFor(cdp, `
    (() => {
      const input = document.querySelector('[data-testid="asset-storage-path-input"]');
      const status = document.querySelector('[data-testid="asset-storage-path-status"]');
      if (!(input instanceof HTMLInputElement)) return null;
      const value = String(input.value || '').trim();
      const statusText = status instanceof HTMLElement ? String(status.textContent || '').trim() : '';
      return (
        value === ${JSON.stringify(folderPickerTargetPath)}
        || statusText.includes('已选择本地目录')
      )
        ? { value, statusText }
        : null;
    })()
  `, 12000, 120), 15000);
  if (String(folderPickerSelectedState?.value || '') !== folderPickerTargetPath) {
    await setValue(cdp, '[data-testid="asset-storage-path-input"]', folderPickerTargetPath);
  }
  assert(
    String((await evalJs(cdp, `(() => {
      const input = document.querySelector('[data-testid="asset-storage-path-input"]');
      return input instanceof HTMLInputElement ? String(input.value || '').trim() : '';
    })()`, 10000)).trim() || '') === folderPickerTargetPath,
    'Asset library folder picker did not fill the selected local directory back into the input.',
    folderPickerSelectedState,
  );
  await clickSelector(cdp, '[data-testid="asset-storage-path-save"]');
  const folderPickerSavedState = await runAssetStep('asset-library-storage-path-saved', () => waitFor(cdp, `
    (() => {
      const input = document.querySelector('[data-testid="asset-storage-path-input"]');
      const status = document.querySelector('[data-testid="asset-storage-path-status"]');
      const currentPath = document.querySelector('[data-testid="asset-storage-current-path"]');
      if (!(input instanceof HTMLInputElement)) return null;
      const value = String(input.value || '').trim();
      const statusText = status instanceof HTMLElement ? String(status.textContent || '').trim() : '';
      const currentPathText = currentPath instanceof HTMLElement ? String(currentPath.textContent || '').trim() : '';
      return value === ${JSON.stringify(folderPickerTargetPath)}
        && (
          currentPathText.includes(${JSON.stringify(folderPickerTargetPath)})
          || statusText.includes('资产库存储路径已保存')
          || statusText.includes('当前已经是这个存储路径')
        )
        ? { value, statusText, currentPathText }
        : null;
    })()
  `, 12000, 120), 15000);
  assert(
    String(folderPickerSavedState?.currentPathText || '').includes(folderPickerTargetPath)
      || String(folderPickerSavedState?.statusText || '').includes('资产库存储路径已保存')
      || String(folderPickerSavedState?.statusText || '').includes('当前已经是这个存储路径'),
    'Asset library folder picker save step did not persist the selected directory.',
    folderPickerSavedState,
  );

  let folderImportState = null;
  if (assetFixtures?.imagePath && assetFixtures?.videoPath) {
    await fs.mkdir(folderImportDir, { recursive: true });
    const folderImportImagePath = path.join(folderImportDir, folderImportImageName);
    const folderImportVideoPath = path.join(folderImportDir, folderImportVideoName);
    const folderImportHdrPath = path.join(folderImportDir, folderImportHdrName);
    await fs.copyFile(assetFixtures.imagePath, folderImportImagePath);
    await fs.copyFile(assetFixtures.videoPath, folderImportVideoPath);
    await fs.writeFile(folderImportHdrPath, '#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n\x00\x00\x00\x00');
    const folderImportCountsBefore = await evalJs(cdp, `
      (() => ({
        imageCount: document.querySelectorAll('[data-testid="asset-card"][data-asset-type="image"]').length,
        videoCount: document.querySelectorAll('[data-testid="asset-card"][data-asset-type="video"]').length,
      }))()
    `, 10000);
    await evalJs(cdp, `
      (() => {
        try {
          localStorage.setItem('HMDAO_ASSET_PICK_TEST_PATH', ${JSON.stringify(folderImportDir)});
        } catch {}
        try {
          window.__HMDAO_ASSET_PICK_TEST_PATH__ = ${JSON.stringify(folderImportDir)};
        } catch {}
        return true;
      })()
    `, 10000);
    log('asset-library:import-folder:trigger:start', { folderImportDir, folderImportCountsBefore });
    await runAssetStep('asset-library-import-folder-triggered', async () => {
      await clickSelector(cdp, '[data-testid="asset-import-folder-button"]');
      return await evalJs(cdp, `
        (() => {
          const status = document.querySelector('[data-testid="asset-import-status"]');
          const items = window.__HMDAO_DEBUG__?.assetStore?.getState?.()?.items || [];
          return {
            hasStatus: status instanceof HTMLElement,
            statusText: status instanceof HTMLElement ? String(status.textContent || '').trim() : '',
            currentMatchingCount: items.filter((item) => [${JSON.stringify(folderImportImageName)}, ${JSON.stringify(folderImportVideoName)}, ${JSON.stringify(folderImportHdrName)}].includes(String(item?.name || ''))).length,
          };
        })()
      `, 10000);
    }, 12000);
    let folderImportStatusState = null;
    try {
      folderImportStatusState = await runAssetStep('asset-library-import-folder-status', () => waitFor(cdp, `
        (() => {
          const status = document.querySelector('[data-testid="asset-import-status"]');
          const items = window.__HMDAO_DEBUG__?.assetStore?.getState?.()?.items || [];
          if (!(status instanceof HTMLElement)) return null;
          const text = String(status.textContent || '').trim();
          const imported = items.filter((item) =>
            [${JSON.stringify(folderImportImageName)}, ${JSON.stringify(folderImportVideoName)}, ${JSON.stringify(folderImportHdrName)}].includes(String(item?.name || ''))
          );
          return text.length > 0 && imported.length >= 3
            ? {
                text,
                imported: imported.map((item) => ({
                  id: String(item?.id || ''),
                  filePath: String(item?.filePath || ''),
                  name: String(item?.name || ''),
                  storageLabel: String(item?.storageLabel || ''),
                  tags: Array.isArray(item?.tags) ? item.tags : [],
                  smartCategories: Array.isArray(item?.smartCategories) ? item.smartCategories : [],
                })),
              }
            : null;
        })()
      `, 20000, 150), 52000);
    } catch {
      await sleep(1200);
      folderImportStatusState = await evalJs(cdp, `
        (() => {
          const input = document.querySelector('[data-testid="asset-directory-input"]');
          const status = document.querySelector('[data-testid="asset-import-status"]');
          const items = window.__HMDAO_DEBUG__?.assetStore?.getState?.()?.items || [];
          const imported = items.filter((item) =>
            [${JSON.stringify(folderImportImageName)}, ${JSON.stringify(folderImportVideoName)}, ${JSON.stringify(folderImportHdrName)}].includes(String(item?.name || ''))
          );
          return {
            text: status instanceof HTMLElement ? String(status.textContent || '').trim() : '',
            hasStatus: status instanceof HTMLElement,
            input: input instanceof HTMLInputElement ? {
              fileCount: Number(input.files?.length || 0),
              multiple: Boolean(input.multiple),
              accept: String(input.accept || ''),
              hasDirectoryAttr: input.hasAttribute('directory'),
              hasWebkitDirectoryAttr: input.hasAttribute('webkitdirectory'),
            } : null,
            imported: imported.map((item) => ({
              id: String(item?.id || ''),
              filePath: String(item?.filePath || ''),
              name: String(item?.name || ''),
              storageLabel: String(item?.storageLabel || ''),
              tags: Array.isArray(item?.tags) ? item.tags : [],
              smartCategories: Array.isArray(item?.smartCategories) ? item.smartCategories : [],
            })),
            recentNames: items.slice(-12).map((item) => String(item?.name || '')),
          };
        })()
      `, 10000);
    }
    const folderImportCountsAfter = await evalJs(cdp, `
      (() => ({
        imageCount: document.querySelectorAll('[data-testid="asset-card"][data-asset-type="image"]').length,
        videoCount: document.querySelectorAll('[data-testid="asset-card"][data-asset-type="video"]').length,
      }))()
    `, 10000);
    assert(
      Array.isArray(folderImportStatusState?.imported)
        && folderImportStatusState.imported.every((item) => String(item?.storageLabel || '') === 'reference')
        && folderImportStatusState.imported.every((item) => String(item?.filePath || '').startsWith(folderImportDir)),
      'Folder import did not keep imported assets as original-file references.',
      folderImportStatusState,
    );
    assert(
      Number(folderImportStatusState?.imported?.length || 0) >= 3
        && String(folderImportStatusState?.text || '').trim().length > 0
        && Number(folderImportCountsAfter?.imageCount || 0) >= Number(folderImportCountsBefore?.imageCount || 0) + 1
        && Array.isArray(folderImportStatusState?.imported)
        && folderImportStatusState.imported.some((item) => String(item?.name || '') === folderImportVideoName)
        && folderImportStatusState.imported.some((item) => String(item?.name || '') === folderImportHdrName),
      'Folder import did not add image, video, and HDR placeholder assets into the asset library.',
      { folderImportCountsBefore, folderImportCountsAfter, folderImportStatusState },
    );
    const folderImportAutoTagState = {
      imageImported: folderImportStatusState.imported.find((item) => String(item?.name || '') === folderImportImageName) || null,
      videoImported: folderImportStatusState.imported.find((item) => String(item?.name || '') === folderImportVideoName) || null,
      hdrImported: folderImportStatusState.imported.find((item) => String(item?.name || '') === folderImportHdrName) || null,
    };
    assert(
      Array.isArray(folderImportAutoTagState.imageImported?.tags)
        && folderImportAutoTagState.imageImported.tags.some((tag) => String(tag).includes('汽车'))
        && folderImportAutoTagState.imageImported.tags.some((tag) => String(tag).includes('夜景'))
        && Array.isArray(folderImportAutoTagState.videoImported?.tags)
        && folderImportAutoTagState.videoImported.tags.some((tag) => String(tag).includes('运镜'))
        && Array.isArray(folderImportAutoTagState.imageImported?.smartCategories)
        && folderImportAutoTagState.imageImported.smartCategories.some((tag) => String(tag).includes('汽车')),
      'Folder import did not expose expected auto-tagging or auto-classification labels.',
      folderImportAutoTagState,
    );
    await evalJs(cdp, `
      (() => {
        const cards = Array.from(document.querySelectorAll('[data-testid="asset-card"]'));
        const target = cards.find((item) => String(item.textContent || '').includes(${JSON.stringify(folderImportImageName)}));
        if (!(target instanceof HTMLElement)) return false;
        target.click();
        return true;
      })()
    `, 10000);
    const folderImportPreviewState = await waitFor(cdp, `
      (() => {
        const panel = document.querySelector('[data-testid="asset-preview-panel"]');
        if (!(panel instanceof HTMLElement)) return null;
        const text = String(panel.textContent || '').trim();
      return text.includes(${JSON.stringify(folderImportImageName)})
          && text.includes('汽车')
          && text.includes('夜景')
          ? {
              text: text.slice(0, 400),
              hasAutoTag: text.includes('汽车') || text.includes('夜景'),
              hasReferenceBadge: Boolean(document.querySelector(${JSON.stringify('[data-testid^="asset-card-storage-"]')})),
              storageModeText: String(document.querySelector('[data-testid="asset-preview-storage-mode"]')?.textContent || '').trim(),
              sourcePathText: String(document.querySelector('[data-testid="asset-preview-source-path"]')?.textContent || '').trim(),
            }
          : null;
      })()
    `, 15000, 150);
    assert(
      Boolean(folderImportPreviewState?.hasAutoTag)
        && String(folderImportPreviewState?.text || '').includes(folderImportImageName)
        && String(folderImportPreviewState?.text || '').includes('风景')
        && String(folderImportPreviewState?.text || '').includes('夜景')
        && String(folderImportPreviewState?.storageModeText || '').includes('原文件引用')
        && String(folderImportPreviewState?.sourcePathText || '').includes(folderImportDir),
      'Folder import preview did not expose the imported card with visible auto tags, reference mode, and source path.',
      folderImportPreviewState,
    );
    const importedAssetIds = await evalJs(cdp, `
      (() => {
        const items = window.__HMDAO_DEBUG__?.assetStore?.getState?.()?.items || [];
        return items
          .filter((item) => [${JSON.stringify(folderImportImageName)}, ${JSON.stringify(folderImportVideoName)}, ${JSON.stringify(folderImportHdrName)}].includes(String(item?.name || '')))
          .map((item) => ({
            id: String(item.id || ''),
            backendAssetId: String(item.backendAssetId || item.id || ''),
            filePath: String(item.filePath || ''),
            name: String(item.name || ''),
            storageLabel: String(item.storageLabel || ''),
            tags: Array.isArray(item.tags) ? item.tags : [],
            smartCategories: Array.isArray(item.smartCategories) ? item.smartCategories : [],
          }));
      })()
    `, 10000);
    folderImportState = {
      folderImportDir,
      folderImportImagePath,
      folderImportVideoPath,
      folderImportHdrPath,
      folderImportCountsBefore,
      folderImportCountsAfter,
      folderImportStatusState,
      folderImportAutoTagState,
      folderImportPreviewState,
      importedAssetIds,
    };
    await recorder('asset-library-folder-import-complete', {
      folderImportDir,
      folderImportStatusState,
      folderImportAutoTagState,
      folderImportPreviewState,
      folderImportReferenceMode: {
        allReferenced: folderImportStatusState.imported.every((item) => String(item?.storageLabel || '') === 'reference'),
        sourcePaths: folderImportStatusState.imported.map((item) => String(item?.filePath || '')),
      },
      folderImportCountsBefore,
      folderImportCountsAfter,
    });
    const mediaVideoFolderState = await waitFor(cdp, `
      (() => {
        const button = document.querySelector('[data-testid="asset-media-folder-media:video"]');
        if (!(button instanceof HTMLElement)) return null;
        button.click();
        const cards = Array.from(document.querySelectorAll('[data-testid="asset-card"]'));
        if (cards.length === 0) return null;
        const allVideo = cards.every((card) => String(card.getAttribute('data-asset-type') || '') === 'video');
        const header = String(document.body?.textContent || '');
        return allVideo ? { count: cards.length, header } : null;
      })()
    `, 15000, 150);
    assert(
      Number(mediaVideoFolderState?.count || 0) > 0
        && String(mediaVideoFolderState?.header || '').includes('视频素材'),
      'Asset library media video column did not filter to video cards.',
      mediaVideoFolderState,
    );
    const smartVideoFolderState = await waitFor(cdp, `
      (() => {
        const candidateLabels = ${JSON.stringify([
          '视频',
          ...(Array.isArray(folderImportAutoTagState?.videoImported?.smartCategories) ? folderImportAutoTagState.videoImported.smartCategories : []),
          ...(Array.isArray(folderImportAutoTagState?.videoImported?.tags) ? folderImportAutoTagState.videoImported.tags : []),
        ])};
        const buttons = Array.from(document.querySelectorAll('[data-testid^="asset-smart-folder-"]'));
        const button = buttons.find((item) => candidateLabels.some((label) => String(item.textContent || '').includes(String(label || ''))));
        if (!(button instanceof HTMLElement)) return null;
        button.click();
        const cards = Array.from(document.querySelectorAll('[data-testid="asset-card"]'));
        if (cards.length === 0) return null;
        const cardTexts = cards.map((card) => String(card.textContent || '').trim());
        const header = String(document.body?.textContent || '');
        return cardTexts.some((text) => text.includes(${JSON.stringify(folderImportVideoName)}))
          ? {
              count: cards.length,
              header,
              buttonText: String(button.textContent || '').trim(),
              cardTexts: cardTexts.slice(0, 12),
            }
          : null;
      })()
    `, 15000, 150);
    assert(
      Number(smartVideoFolderState?.count || 0) > 0
        && String(smartVideoFolderState?.header || '').includes('智能分类')
        && String(smartVideoFolderState?.buttonText || '').length > 0
        && Array.isArray(smartVideoFolderState?.cardTexts)
        && smartVideoFolderState.cardTexts.some((text) => String(text || '').includes(folderImportVideoName)),
      'Asset library smart video folder did not filter to video cards.',
      smartVideoFolderState,
    );
    await evalJs(cdp, `
      (() => {
        const rootButton = Array.from(document.querySelectorAll('button, [role="button"]'))
          .find((item) => String(item.textContent || '').replace(/\\s+/g, '').includes('全部素材'));
        if (!(rootButton instanceof HTMLElement)) return false;
        rootButton.click();
        return true;
      })()
    `, 10000);
    await clickSelector(cdp, '[data-testid="asset-tab-images"]').catch(() => false);
    await evalJs(cdp, `
      (() => {
        const cards = Array.from(document.querySelectorAll('[data-testid="asset-card"]'));
        const target = cards.find((item) => String(item.textContent || '').includes(${JSON.stringify(folderImportHdrName)}));
        if (!(target instanceof HTMLElement)) return false;
        target.click();
        return true;
      })()
    `, 10000);
    const hdrPreviewState = await waitFor(cdp, `
      (() => {
        const storeItems = window.__HMDAO_DEBUG__?.assetStore?.getState?.()?.items || [];
        const item = storeItems.find((entry) => String(entry?.name || '') === ${JSON.stringify(folderImportHdrName)});
        if (!item) return null;
        const cards = Array.from(document.querySelectorAll('[data-testid="asset-card"]'));
        const target = cards.find((entry) => String(entry.textContent || '').includes(${JSON.stringify(folderImportHdrName)}));
        const panel = document.querySelector('[data-testid="asset-preview-panel"]');
        const cardText = target instanceof HTMLElement ? String(target.textContent || '').trim() : '';
        const panelText = panel instanceof HTMLElement ? String(panel.textContent || '').trim() : '';
        return {
          name: String(item?.name || ''),
          filePath: String(item?.filePath || ''),
          storageLabel: String(item?.storageLabel || ''),
          backendAssetId: String(item?.backendAssetId || item?.id || ''),
          assetType: String(item?.type || item?.assetType || ''),
          cardVisible: target instanceof HTMLElement,
          cardText,
          panelText: panelText.slice(0, 700),
          hdrBadgeVisible: cardText.includes('HDR'),
        };
      })()
    `, 15000, 150);
    assert(
      String(hdrPreviewState?.name || '') === folderImportHdrName
        && String(hdrPreviewState?.storageLabel || '') === 'reference'
        && String(hdrPreviewState?.filePath || '') === folderImportHdrPath,
      'Asset library HDR reference asset did not persist with the expected source-path metadata.',
      hdrPreviewState,
    );
    await clickSelector(cdp, '[data-testid="asset-tab-videos"]').catch(() => false);
    await evalJs(cdp, `
      (() => {
        const cards = Array.from(document.querySelectorAll('[data-testid="asset-card"]'));
        const target = cards.find((item) => String(item.textContent || '').includes(${JSON.stringify(folderImportVideoName)}));
        if (!(target instanceof HTMLElement)) return false;
        target.click();
        return true;
      })()
    `, 10000);
    await evalJs(cdp, `
      (() => {
        const buttons = Array.from(document.querySelectorAll('[data-testid="asset-preview-panel"] button'));
        const target = buttons.find((item) => String(item.textContent || '').includes('反推提示词'));
        if (!(target instanceof HTMLElement)) return false;
        target.click();
        return true;
      })()
    `, 10000);
    const reversePromptState = await waitFor(cdp, `
      (() => {
        const panel = document.querySelector('[data-testid="asset-preview-panel"]');
        if (!(panel instanceof HTMLElement)) return null;
        const text = String(panel.textContent || '').trim();
        return text.includes('保持原视频的运镜')
          ? { text: text.slice(0, 500) }
          : null;
      })()
    `, 15000, 150);
    assert(
      String(reversePromptState?.text || '').includes('保持原视频的运镜'),
      'Asset reverse prompt did not produce the clean video prompt text.',
      reversePromptState,
    );
    await recorder('asset-library-video-reverse-prompt-ready', reversePromptState);
    const videoAssetPromptState = await waitFor(cdp, `
      (() => {
        const items = window.__HMDAO_DEBUG__?.assetStore?.getState?.()?.items || [];
        const item = items.find((entry) => String(entry?.name || '') === ${JSON.stringify(folderImportVideoName)});
        const prompt = String(item?.prompt || '').trim();
        return prompt ? { prompt } : null;
      })()
    `, 15000, 150);
    const canvasNodeCountBeforeAssets = await evalJs(cdp, `
      (() => Number(window.__HMDAO_DEBUG__?.canvasStore?.getState?.()?.canvas?.nodes?.length || 0))()
    `, 10000);
    await clickSelector(cdp, '[data-testid="asset-preview-add"]');
    const videoNodeFromAssetState = await waitFor(cdp, `
      (() => {
        const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.()?.canvas?.nodes || [];
        const node = [...nodes].reverse().find((item) => item?.type === 'video' && String(item?.data?.params?.sourceAssetName || '') === ${JSON.stringify(folderImportVideoName)});
        return node ? {
          id: String(node.id || ''),
          type: String(node.type || ''),
          nodeCount: nodes.length,
          sourceAssetId: String(node?.data?.params?.sourceAssetId || ''),
          sourceAssetName: String(node?.data?.params?.sourceAssetName || ''),
          videoUrl: String(node?.data?.videoUrl || ''),
          prompt: String(node?.data?.prompt || '').trim(),
          sourceAssetPrompt: String(node?.data?.params?.sourceAssetPrompt || '').trim(),
        } : null;
      })()
    `, 15000, 150);
    assert(
      Number(videoNodeFromAssetState?.nodeCount || 0) >= Number(canvasNodeCountBeforeAssets || 0) + 1
        && String(videoNodeFromAssetState?.sourceAssetName || '') === folderImportVideoName
        && String(videoNodeFromAssetState?.videoUrl || '').includes('/api/assets/content/'),
      'Adding a video asset from the library did not create a populated video node on the canvas.',
      { canvasNodeCountBeforeAssets, videoNodeFromAssetState },
    );
    await recorder('asset-library-video-node-created', {
      canvasNodeCountBeforeAssets,
      videoNodeFromAssetState,
    });
    await evalJs(cdp, `
      (() => {
        const setCenter = window.__HMDAO_DEBUG__?.reactFlow?.setCenter;
        const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.()?.canvas?.nodes || [];
        const node = nodes.find((entry) => String(entry?.id || '') === ${JSON.stringify(String(videoNodeFromAssetState.id || ''))});
        if (!node || typeof setCenter !== 'function') return false;
        setCenter(node.position.x + 260, node.position.y + 180, { zoom: 1, duration: 0 });
        return true;
      })()
    `, 10000).catch(() => false);
    await selectNodeById(cdp, videoNodeFromAssetState.id);
    await waitForNodeSelection(cdp, videoNodeFromAssetState.id, 15000);
    await clickSelector(cdp, `[data-testid="video-node-${videoNodeFromAssetState.id}"]`).catch(() => false);
    const videoPromptWritebackState = await waitFor(cdp, `
      (() => {
        const input = document.querySelector(${JSON.stringify(`[data-testid="video-prompt-${String(videoNodeFromAssetState.id || '')}"]`)});
        const nodeRoot = document.querySelector(${JSON.stringify(`[data-testid="video-node-${String(videoNodeFromAssetState.id || '')}"]`)});
        const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.()?.canvas?.nodes || [];
        const node = nodes.find((entry) => String(entry?.id || '') === ${JSON.stringify(String(videoNodeFromAssetState.id || ''))});
        const expected = ${JSON.stringify(String(videoAssetPromptState?.prompt || '').trim())};
        const nodePrompt = String(node?.data?.prompt || '').trim();
        const sourceAssetPrompt = String(node?.data?.params?.sourceAssetPrompt || '').trim();
        const hasInput = input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement;
        const inputValue = hasInput
          ? String(input.value || '').trim()
          : '';
        return expected && nodePrompt === expected && sourceAssetPrompt === expected && (!hasInput || inputValue === expected)
          ? { expected, nodePrompt, sourceAssetPrompt, inputValue, hasInput, hasNodeDom: Boolean(nodeRoot) }
          : null;
      })()
    `, 15000, 150);
    assert(
      String(videoPromptWritebackState?.expected || '').length > 0,
      'Asset reverse prompt did not write back into the video node prompt area.',
      { videoAssetPromptState, videoNodeFromAssetState, videoPromptWritebackState },
    );
    await recorder('asset-library-video-prompt-writeback-ready', {
      videoAssetPromptState,
      videoNodeFromAssetState,
      videoPromptWritebackState,
    });
    await clickSelector(cdp, '[data-testid="asset-tab-images"]').catch(() => false);
    await evalJs(cdp, `
      (() => {
        const cards = Array.from(document.querySelectorAll('[data-testid="asset-card"]'));
        const target = cards.find((item) => String(item.textContent || '').includes(${JSON.stringify(folderImportImageName)}));
        if (!(target instanceof HTMLElement)) return false;
        target.click();
        return true;
      })()
    `, 10000);
    await recorder('asset-library-image-card-selected', await evalJs(cdp, `
      (() => {
        const panel = document.querySelector('[data-testid="asset-preview-panel"]');
        const name = document.querySelector('[data-testid="asset-preview-name"]');
        return {
          panelVisible: panel instanceof HTMLElement,
          currentName: name instanceof HTMLElement ? String(name.textContent || '').trim() : '',
        };
      })()
    `, 10000));
    await setValue(cdp, '[data-testid="asset-preview-analysis-engine"]', 'prompt-fusion');
    await clickSelector(cdp, '[data-testid="asset-preview-analyze-image"]');
    const folderImportImageAnalysisState = await runAssetStep('asset-library-image-analysis-complete', () => waitFor(cdp, `
      (() => {
        const panel = document.querySelector('[data-testid="asset-preview-analysis"]');
        const items = window.__HMDAO_DEBUG__?.assetStore?.getState?.()?.items || [];
        const item = items.find((entry) => String(entry?.name || '') === ${JSON.stringify(folderImportImageName)});
        const analysis = item?.analysis || null;
        const panelText = panel instanceof HTMLElement ? String(panel.textContent || '').trim() : '';
        const fallbackText = analysis
          ? [
              String(analysis.summary || ''),
              String(analysis.subject || ''),
              String(analysis.style || ''),
              String(analysis.lighting || ''),
              String(analysis.composition || ''),
              String(analysis.camera || ''),
            ].filter(Boolean).join(' ')
          : '';
        const mergedText = panelText || fallbackText;
        return mergedText.length > 20
          ? {
              text: mergedText.slice(0, 500),
              source: panelText.length > 20 ? 'panel' : 'asset-store',
              hasAnalysis: Boolean(analysis),
            }
          : null;
      })()
    `, 20000, 150), 24000);
    await recorder('asset-library-image-analysis-complete', folderImportImageAnalysisState);
    await recorder('asset-library-image-analysis-passed', folderImportImageAnalysisState);
    const folderImportImageAssetPromptState = await runAssetStep('asset-library-image-prompt-ready', () => waitFor(cdp, `
      (() => {
        const items = window.__HMDAO_DEBUG__?.assetStore?.getState?.()?.items || [];
        const item = items.find((entry) => String(entry?.name || '') === ${JSON.stringify(folderImportImageName)});
        const prompt = String(item?.prompt || '').trim();
        return prompt ? { prompt } : null;
      })()
    `, 15000, 150), 18000);
    const imageNodeCountBeforeAssetAdd = await evalJs(cdp, `
      (() => Number(window.__HMDAO_DEBUG__?.canvasStore?.getState?.()?.canvas?.nodes?.length || 0))()
    `, 10000);
    log('asset-library:image-add:before-recorder', {
      imageNodeCountBeforeAssetAdd,
      promptLength: String(folderImportImageAssetPromptState?.prompt || '').length,
    });
    await recorder('asset-library-image-node-before-add', {
      imageNodeCountBeforeAssetAdd,
      folderImportImageAssetPromptState,
    });
    log('asset-library:image-add:trigger:start', {
      imageNodeCountBeforeAssetAdd,
      promptLength: String(folderImportImageAssetPromptState?.prompt || '').length,
    });
    await runAssetStep('asset-library-image-add-triggered', async () => {
      await clickSelector(cdp, '[data-testid="asset-preview-add"]');
      return await evalJs(cdp, `
        (() => {
          const button = document.querySelector('[data-testid="asset-preview-add"]');
          const selectedNodeIds = window.__HMDAO_DEBUG__?.canvasStore?.getState?.()?.canvas?.selectedNodeIds || [];
          const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.()?.canvas?.nodes || [];
          return {
            buttonVisible: button instanceof HTMLElement,
            selectedNodeIds: Array.isArray(selectedNodeIds) ? selectedNodeIds.map((value) => String(value || '')) : [],
            nodeCount: Number(nodes.length || 0),
          };
        })()
      `, 10000);
    }, 12000);
    const imageNodeFromAssetState = await runAssetStep('asset-library-image-node-created', () => waitFor(cdp, `
      (() => {
        const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.()?.canvas?.nodes || [];
        const node = [...nodes].reverse().find((item) => item?.type === 'image' && String(item?.data?.params?.sourceAssetName || '') === ${JSON.stringify(folderImportImageName)});
        return node ? {
          id: String(node.id || ''),
          type: String(node.type || ''),
          nodeCount: nodes.length,
          sourceAssetId: String(node?.data?.params?.sourceAssetId || ''),
          sourceAssetName: String(node?.data?.params?.sourceAssetName || ''),
          imageUrl: String(node?.data?.imageUrl || ''),
          prompt: String(node?.data?.prompt || '').trim(),
          sourceAssetPrompt: String(node?.data?.params?.sourceAssetPrompt || '').trim(),
        } : null;
      })()
    `, 15000, 150), 18000);
    assert(
      Number(imageNodeFromAssetState?.nodeCount || 0) >= Number(imageNodeCountBeforeAssetAdd || 0) + 1
        && String(imageNodeFromAssetState?.sourceAssetName || '') === folderImportImageName
        && String(imageNodeFromAssetState?.imageUrl || '').includes('/api/assets/content/'),
      'Adding an image asset from the library did not create a populated image node on the canvas.',
      { imageNodeCountBeforeAssetAdd, imageNodeFromAssetState },
    );
    await recorder('asset-library-image-node-created', {
      imageNodeCountBeforeAssetAdd,
      imageNodeFromAssetState,
    });
    await evalJs(cdp, `
      (() => {
        const setCenter = window.__HMDAO_DEBUG__?.reactFlow?.setCenter;
        const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.()?.canvas?.nodes || [];
        const node = nodes.find((entry) => String(entry?.id || '') === ${JSON.stringify(String(imageNodeFromAssetState.id || ''))});
        if (!node || typeof setCenter !== 'function') return false;
        setCenter(node.position.x + 260, node.position.y + 180, { zoom: 1, duration: 0 });
        return true;
      })()
    `, 10000).catch(() => false);
    await selectNodeById(cdp, imageNodeFromAssetState.id);
    await waitForNodeSelection(cdp, imageNodeFromAssetState.id, 15000);
    await clickSelector(cdp, `[data-testid="image-node-${imageNodeFromAssetState.id}"]`).catch(() => false);
    const imagePromptWritebackState = await runAssetStep('asset-library-image-prompt-writeback', () => waitFor(cdp, `
      (() => {
        const input = document.querySelector(${JSON.stringify(`[data-testid="image-prompt-${String(imageNodeFromAssetState.id || '')}"]`)});
        const nodeRoot = document.querySelector(${JSON.stringify(`[data-testid="image-node-${String(imageNodeFromAssetState.id || '')}"]`)});
        const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.()?.canvas?.nodes || [];
        const node = nodes.find((entry) => String(entry?.id || '') === ${JSON.stringify(String(imageNodeFromAssetState.id || ''))});
        const expected = ${JSON.stringify(String(folderImportImageAssetPromptState?.prompt || '').trim())};
        const nodePrompt = String(node?.data?.prompt || '').trim();
        const sourceAssetPrompt = String(node?.data?.params?.sourceAssetPrompt || '').trim();
        const hasInput = input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement;
        const inputValue = hasInput ? String(input.value || '').trim() : '';
        return expected && nodePrompt === expected && sourceAssetPrompt === expected && (!hasInput || inputValue === expected)
          ? { expected, nodePrompt, sourceAssetPrompt, inputValue, hasInput, hasNodeDom: Boolean(nodeRoot) }
          : null;
      })()
    `, 15000, 150), 18000);
    assert(
      String(imagePromptWritebackState?.expected || '').length > 0,
      'Asset image analysis prompt did not write back into the image node prompt area.',
      { folderImportImageAssetPromptState, imageNodeFromAssetState, imagePromptWritebackState },
    );
    await recorder('asset-library-image-prompt-writeback-ready', {
      folderImportImageAssetPromptState,
      imageNodeFromAssetState,
      imagePromptWritebackState,
    });
    await evalJs(cdp, `
      (() => {
        try {
          localStorage.setItem('HMDAO_ASSET_PICK_TEST_PATH', ${JSON.stringify(folderImportDir)});
        } catch {}
        try {
          window.__HMDAO_ASSET_PICK_TEST_PATH__ = ${JSON.stringify(folderImportDir)};
        } catch {}
        return true;
      })()
    `, 10000);
    const duplicateCountsBefore = await evalJs(cdp, `
      (() => {
        const items = window.__HMDAO_DEBUG__?.assetStore?.getState?.()?.items || [];
        return items.filter((item) => [${JSON.stringify(folderImportImageName)}, ${JSON.stringify(folderImportVideoName)}, ${JSON.stringify(folderImportHdrName)}].includes(String(item?.name || ''))).length;
      })()
    `, 10000);
    await clickSelector(cdp, '[data-testid="asset-import-folder-button"]');
    const duplicateImportState = await runAssetStep('asset-library-duplicate-import-status', () => waitFor(cdp, `
      (() => {
        const status = document.querySelector('[data-testid="asset-import-status"]');
        const items = window.__HMDAO_DEBUG__?.assetStore?.getState?.()?.items || [];
        const matching = items.filter((item) => [${JSON.stringify(folderImportImageName)}, ${JSON.stringify(folderImportVideoName)}, ${JSON.stringify(folderImportHdrName)}].includes(String(item?.name || '')));
        const text = status instanceof HTMLElement ? String(status.textContent || '').trim() : '';
        return (text.includes('重复素材') || matching.length === Number(${JSON.stringify(duplicateCountsBefore)}))
          ? { text, matchingCount: matching.length, duplicateNoticeVisible: text.includes('重复素材') }
          : null;
      })()
    `, 15000, 150), 18000);
    assert(
      Number(duplicateImportState?.matchingCount || 0) === Number(duplicateCountsBefore || 0),
      'Re-importing the same directory created duplicate asset cards or missed the duplicate notice.',
      { duplicateCountsBefore, duplicateImportState },
    );
    await recorder('asset-library-duplicate-import-ready', {
      duplicateCountsBefore,
      duplicateImportState,
    });
    folderImportState = {
      ...folderImportState,
      mediaVideoFolderState,
      smartVideoFolderState,
      hdrPreviewState,
      reversePromptState,
      videoAssetPromptState,
      videoNodeFromAssetState,
      videoPromptWritebackState,
      folderImportImageAssetPromptState,
      imageNodeFromAssetState,
      imagePromptWritebackState,
      duplicateImportState,
    };
    await evalJs(cdp, `
      (() => {
        try { localStorage.removeItem('HMDAO_ASSET_PICK_TEST_PATH'); } catch {}
        try { delete window.__HMDAO_ASSET_PICK_TEST_PATH__; } catch {}
        return true;
      })()
    `, 10000).catch(() => false);
  }

  await evalJs(cdp, `
    (() => {
      const candidates = Array.from(document.querySelectorAll('button, [role="button"]'));
      const target = candidates.find((item) => String(item.textContent || '').replace(/\\s+/g, '').includes('全部素材'));
      if (!(target instanceof HTMLElement)) return false;
      target.click();
      return true;
    })()
  `, 10000).catch(() => false);

  const imageCardsBefore = await countSelector(cdp, '[data-testid="asset-card"][data-asset-type="image"]');
  assert(imageCardsBefore > 0, 'Asset library regression expected at least one image asset card.', { imageCardsBefore });
  const analysisTargetImageName = folderImportState?.folderImportStatusState?.imported?.some((item) => String(item?.name || '') === folderImportImageName)
    ? folderImportImageName
    : assetName;
  await waitFor(cdp, `
    (() => Array.from(document.querySelectorAll('[data-testid="asset-card"]'))
      .some((item) => String(item.textContent || '').includes(${JSON.stringify(assetName)})))
  `, 15000, 100);
  await evalJs(cdp, `
    (() => {
      const cards = Array.from(document.querySelectorAll('[data-testid="asset-card"][data-asset-type="image"]'));
      const target = cards.find((item) => String(item.textContent || '').includes(${JSON.stringify(analysisTargetImageName)}))
        || cards.find((item) => !String(item.textContent || '').includes(${JSON.stringify(assetName)}))
        || cards[0];
      if (!(target instanceof HTMLElement)) return false;
      target.click();
      return true;
    })()
  `, 10000);
  await waitForSelector(cdp, '[data-testid="asset-preview-panel"]', 10000);

  await clickSelector(cdp, '[data-testid="asset-tab-all"]').catch(() => false);
  await clickSelector(cdp, '[data-testid="asset-multi-select-toggle"]');
  await evalJs(cdp, `
    (() => {
      const store = window.__HMDAO_DEBUG__?.assetStore?.getState?.();
      if (!store || typeof store.selectItem !== 'function') return false;
      const items = Array.isArray(store.items) ? store.items : [];
      const imageItem = items.find((item) => String(item?.type || '') === 'image');
      const videoItem = items.find((item) => String(item?.type || '') === 'video');
      if (!imageItem || !videoItem) return false;
      if (typeof store.clearSelection === 'function') {
        store.clearSelection();
      }
      store.selectItem(String(imageItem.id || ''), true);
      store.selectItem(String(videoItem.id || ''), true);
      if (typeof store.selectPreviewItem === 'function') {
        store.selectPreviewItem(String(videoItem.id || ''));
      }
      return {
        imageId: String(imageItem.id || ''),
        videoId: String(videoItem.id || ''),
      };
    })()
  `, 10000);
  const multiSelectState = await waitFor(cdp, `
    (() => {
      const toggle = document.querySelector('[data-testid="asset-multi-select-toggle"]');
      if (!(toggle instanceof HTMLElement)) return null;
      const store = window.__HMDAO_DEBUG__?.assetStore?.getState?.();
      const selectedIds = Array.isArray(store?.selectedItemIds) ? store.selectedItemIds.map((item) => String(item || '')) : [];
      const items = Array.isArray(store?.items) ? store.items : [];
      const selectedCards = selectedIds
        .map((id) => items.find((item) => String(item?.id || '') === id))
        .filter(Boolean)
        .map((item) => ({
          id: String(item?.id || ''),
          type: String(item?.type || ''),
          text: String(item?.name || '').trim(),
        }));
      const selectedCountText = String(document.body?.textContent || '');
      return selectedIds.length >= 2
        ? {
            toggleText: String(toggle.textContent || '').trim(),
            selectedCards,
            selectedCountText: selectedCountText.includes('已选')
              ? selectedCountText.slice(selectedCountText.indexOf('已选'), selectedCountText.indexOf('已选') + 60)
              : '',
            selectedIds,
          }
        : null;
    })()
  `, 10000, 150);
  assert(
    String(multiSelectState?.toggleText || '').includes('多选模式已开')
      && Array.isArray(multiSelectState?.selectedCards)
      && multiSelectState.selectedCards.some((item) => item?.type === 'image')
      && multiSelectState.selectedCards.some((item) => item?.type === 'video'),
    'Asset library multi-select mode did not allow mixed image/video selection.',
    multiSelectState,
  );
  await recorder('asset-library-multi-select-verified', multiSelectState);

  await clickSelector(cdp, '[data-testid="asset-tab-images"]').catch(() => false);
  await evalJs(cdp, `
    (() => {
      const cards = Array.from(document.querySelectorAll('[data-testid="asset-card"][data-asset-type="image"]'));
      const target = cards.find((item) => String(item.textContent || '').includes(${JSON.stringify(analysisTargetImageName)}))
        || cards[0];
      if (!(target instanceof HTMLElement)) return false;
      target.click();
      return true;
    })()
  `, 10000);
  await waitForSelector(cdp, '[data-testid="asset-preview-panel"]', 10000);

  await setValue(cdp, '[data-testid="asset-preview-analysis-engine"]', 'clip-interrogator');
  await clickSelector(cdp, '[data-testid="asset-preview-reverse-prompt"]');
  const clipFallbackState = await waitFor(cdp, `
    (() => {
      const status = document.querySelector('[data-testid="asset-preview-analysis-status"]');
      const runtime = document.querySelector('[data-testid="asset-preview-analysis-runtime"]');
      if (!(status instanceof HTMLElement)) return null;
      const statusText = String(status.textContent || '').trim();
      return statusText.includes('CLIP Interrogator') && statusText.includes('回退到本地轻量解析')
        ? {
            statusText,
            runtimeText: runtime instanceof HTMLElement ? String(runtime.textContent || '').trim() : '',
          }
        : null;
    })()
  `, 20000, 150);
  assert(
    String(clipFallbackState?.statusText || '').includes('CLIP Interrogator')
      && String(clipFallbackState?.statusText || '').includes('回退到本地轻量解析'),
    'Asset library CLIP fallback hint did not become visible after reverse prompt.',
    clipFallbackState,
  );
  await recorder('asset-library-clip-fallback-verified', clipFallbackState);

  let customApiAnalysisState = null;
  if (customApiRuntimeState) {
    await evalJs(cdp, `
      (() => {
        const debug = window.__HMDAO_DEBUG__ || (window.__HMDAO_DEBUG__ = {});
        if (!debug.__assetAnalyzeFetchProbeInstalled) {
          const originalFetch = window.fetch.bind(window);
          debug.__assetAnalyzeFetchProbeInstalled = true;
          debug.assetAnalyzeFetchLog = [];
          window.fetch = async (...args) => {
            const [input, init] = args;
            const url = typeof input === 'string'
              ? input
              : input instanceof Request
                ? String(input.url || '')
                : String(input || '');
            const shouldTrack = url.includes('/api/local-image/analyze');
            const requestEntry = shouldTrack
              ? {
                  url,
                  method: String(init?.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase(),
                  startedAt: Date.now(),
                  requestEngine: '',
                }
              : null;
            if (requestEntry) {
              const body = init?.body;
              if (body instanceof FormData) {
                requestEntry.requestEngine = String(body.get('engine') || '').trim();
              } else if (typeof body === 'string') {
                try {
                  const parsed = JSON.parse(body);
                  requestEntry.requestEngine = String(parsed?.engine || '').trim();
                } catch {
                  requestEntry.requestEngine = '';
                }
              }
            }
            try {
              const response = await originalFetch(...args);
              if (requestEntry) {
                requestEntry.status = Number(response.status || 0);
                requestEntry.ok = Boolean(response.ok);
                requestEntry.completedAt = Date.now();
                try {
                  const cloned = response.clone();
                  const payload = await cloned.json().catch(async () => ({ rawText: String(await cloned.text().catch(() => '') || '').slice(0, 400) }));
                  requestEntry.responseSuccess = Boolean(payload?.success);
                  requestEntry.responseRuntime = payload?.analysis?.runtime || null;
                  requestEntry.responseEngine = String(payload?.analysis?.engine || '').trim();
                } catch {
                  requestEntry.responseSuccess = false;
                }
                debug.assetAnalyzeFetchLog.push(requestEntry);
                debug.assetAnalyzeFetchLog = debug.assetAnalyzeFetchLog.slice(-12);
              }
              return response;
            } catch (error) {
              if (requestEntry) {
                requestEntry.completedAt = Date.now();
                requestEntry.ok = false;
                requestEntry.error = error instanceof Error ? error.message : String(error || 'fetch-error');
                debug.assetAnalyzeFetchLog.push(requestEntry);
                debug.assetAnalyzeFetchLog = debug.assetAnalyzeFetchLog.slice(-12);
              }
              throw error;
            }
          };
        }
        debug.assetAnalyzeFetchLog = [];
        return true;
      })()
    `, 10000).catch(() => false);
    await setValue(cdp, '[data-testid="asset-preview-analysis-engine"]', 'custom-api');
    const customApiButtonReadyState = await waitFor(cdp, `
      (() => {
        const button = document.querySelector('[data-testid="asset-preview-reverse-prompt"]');
        const items = window.__HMDAO_DEBUG__?.assetStore?.getState?.()?.items || [];
        const item = items.find((entry) => String(entry?.name || '') === ${JSON.stringify(analysisTargetImageName)});
        return button instanceof HTMLButtonElement && !button.disabled
          ? {
              buttonText: String(button.textContent || '').trim(),
              buttonDisabled: button.disabled,
              existingAnalysisEngine: String(item?.analysis?.engine || ''),
              existingRuntime: item?.analysis?.runtime || null,
            }
          : null;
      })()
    `, 12000, 100);
    await recorder('asset-library-custom-api-button-ready', customApiButtonReadyState);
    const customApiTriggerState = await evalJs(cdp, `
      (() => {
        const status = document.querySelector('[data-testid="asset-preview-analysis-status"]');
        const runtime = document.querySelector('[data-testid="asset-preview-analysis-runtime"]');
        const button = document.querySelector('[data-testid="asset-preview-reverse-prompt"]');
        const items = window.__HMDAO_DEBUG__?.assetStore?.getState?.()?.items || [];
        const item = items.find((entry) => String(entry?.name || '') === ${JSON.stringify(analysisTargetImageName)});
        return {
          buttonVisible: button instanceof HTMLElement,
          buttonDisabled: button instanceof HTMLButtonElement ? button.disabled : null,
          statusText: status instanceof HTMLElement ? String(status.textContent || '').trim() : '',
          runtimeText: runtime instanceof HTMLElement ? String(runtime.textContent || '').trim() : '',
          analysisEngine: String(document.querySelector('[data-testid="asset-preview-analysis-engine"]')?.value || ''),
          itemId: String(item?.id || ''),
          itemName: String(item?.name || ''),
          hasAnalysisBeforeClick: Boolean(item?.analysis),
          analyzedAtBeforeClick: Number(item?.analysis?.analyzedAt || 0),
          analysisRuntimeBeforeClick: item?.analysis?.runtime || null,
          analysisEngineBeforeClick: String(item?.analysis?.engine || ''),
        };
      })()
    `, 10000);
    await recorder('asset-library-custom-api-trigger-state', {
      runtime: customApiRuntimeState,
      customApiTriggerState,
    });
    const customApiItemId = String(customApiTriggerState?.itemId || '').trim();
    assert(customApiItemId.length > 0, 'Asset library custom-api regression could not resolve a stable itemId before click.', customApiTriggerState);
    await clickSelector(cdp, '[data-testid="asset-preview-reverse-prompt"]');
    const customApiRequestState = await waitFor(cdp, `
      (() => {
        const logs = window.__HMDAO_DEBUG__?.assetAnalyzeFetchLog || [];
        const last = logs[logs.length - 1] || null;
        return last && String(last.url || '').includes('/api/local-image/analyze')
          ? last
          : null;
      })()
    `, 15000, 100);
    await recorder('asset-library-custom-api-request-fired', {
      runtime: customApiRuntimeState,
      customApiRequestState,
    });
    const customApiPostClickState = await evalJs(cdp, `
      (() => {
        const status = document.querySelector('[data-testid="asset-preview-analysis-status"]');
        const runtime = document.querySelector('[data-testid="asset-preview-analysis-runtime"]');
        const items = window.__HMDAO_DEBUG__?.assetStore?.getState?.()?.items || [];
        const item = items.find((entry) => String(entry?.id || '') === ${JSON.stringify(String(customApiTriggerState?.itemId || ''))});
        return {
          statusText: status instanceof HTMLElement ? String(status.textContent || '').trim() : '',
          runtimeText: runtime instanceof HTMLElement ? String(runtime.textContent || '').trim() : '',
          hasAnalysisAfterClick: Boolean(item?.analysis),
          analyzedAtAfterClick: Number(item?.analysis?.analyzedAt || 0),
          analysisRuntimeAfterClick: item?.analysis?.runtime || null,
          analysisEngineAfterClick: String(item?.analysis?.engine || ''),
          promptAfterClick: String(item?.prompt || '').trim().slice(0, 200),
        };
      })()
    `, 10000).catch(() => null);
    await recorder('asset-library-custom-api-post-click', {
      runtime: customApiRuntimeState,
      customApiPostClickState,
    });
    const customApiWritebackState = await waitFor(cdp, `
      (() => {
        const items = window.__HMDAO_DEBUG__?.assetStore?.getState?.()?.items || [];
        const item = items.find((entry) => String(entry?.id || '') === ${JSON.stringify(String(customApiTriggerState?.itemId || ''))});
        const analysis = item?.analysis || null;
        if (!analysis) return null;
        const analyzedAt = Number(analysis?.analyzedAt || 0);
        const provider = String(analysis?.runtime?.provider || '').trim();
        const model = String(analysis?.runtime?.model || '').trim();
        const resolvedEngine = String(analysis?.runtime?.resolvedEngine || '').trim();
        const engine = String(analysis?.engine || '').trim();
        const changed = analyzedAt > Number(${JSON.stringify(Number(customApiTriggerState?.analyzedAtBeforeClick || 0))})
          || provider.length > 0
          || model.length > 0
          || resolvedEngine === 'custom-api'
          || engine.includes('custom-api');
        return changed
          ? {
              analyzedAt,
              engine,
              provider,
              model,
              resolvedEngine,
              endpoint: String(analysis?.runtime?.endpoint || '').trim(),
              hasSummary: String(analysis?.summary || '').trim().length > 0,
              hasPromptZh: String(analysis?.promptZh || '').trim().length > 0,
            }
          : null;
      })()
    `, 20000, 120);
    await recorder('asset-library-custom-api-writeback-state', {
      runtime: customApiRuntimeState,
      customApiWritebackState,
    });
    customApiAnalysisState = await waitFor(cdp, `
      (() => {
        const status = document.querySelector('[data-testid="asset-preview-analysis-status"]');
        const runtime = document.querySelector('[data-testid="asset-preview-analysis-runtime"]');
        const analysisPanel = document.querySelector('[data-testid="asset-preview-analysis"]');
        const items = window.__HMDAO_DEBUG__?.assetStore?.getState?.()?.items || [];
        const item = items.find((entry) => String(entry?.id || '') === ${JSON.stringify(String(customApiTriggerState?.itemId || ''))});
        const analysis = item?.analysis || null;
        if (!(status instanceof HTMLElement) || !(runtime instanceof HTMLElement)) return null;
        const statusText = String(status.textContent || '').trim();
        const runtimeText = String(runtime.textContent || '').trim();
        const summaryText = String(analysis?.summary || '').trim();
        const subjectText = String(analysis?.subject || '').trim();
        const styleText = String(analysis?.style || '').trim();
        const lightingText = String(analysis?.lighting || '').trim();
        const compositionText = String(analysis?.composition || '').trim();
        const cameraText = String(analysis?.camera || '').trim();
        const structuredWriteback = [summaryText, subjectText, styleText, lightingText, compositionText, cameraText].some((value) => value.length > 0);
        const panelVisible = analysisPanel instanceof HTMLElement;
        const providerText = ${JSON.stringify(String(customApiRuntimeState.provider || ''))};
        const modelText = ${JSON.stringify(String(customApiRuntimeState.model || ''))};
        const runtimeMatched = runtimeText.includes(providerText) && runtimeText.includes(modelText);
        const storeMatched = String(analysis?.runtime?.provider || '').includes(providerText)
          && String(analysis?.runtime?.model || '').includes(modelText);
        return (runtimeMatched || storeMatched)
          && (structuredWriteback || panelVisible)
          ? {
              statusText,
              runtimeText,
              runtimeMatched,
              storeMatched,
              panelVisible,
              summaryText: summaryText.slice(0, 400),
              hasSummary: summaryText.length > 0,
              hasSubjectField: subjectText.length > 0,
              hasStyleField: styleText.length > 0,
              hasLightingField: lightingText.length > 0,
              hasCompositionField: compositionText.length > 0,
              hasCameraField: cameraText.length > 0,
              source: structuredWriteback ? 'asset-store' : 'panel',
            }
          : null;
      })()
    `, 25000, 150);
    assert(
      (Boolean(customApiAnalysisState?.runtimeMatched) || Boolean(customApiAnalysisState?.storeMatched))
        && (
          String(customApiAnalysisState?.statusText || '').includes('完成反推')
          || customApiAnalysisState?.hasSummary
          || customApiAnalysisState?.hasSubjectField
          || customApiAnalysisState?.hasStyleField
          || customApiAnalysisState?.hasLightingField
          || customApiAnalysisState?.hasCompositionField
          || customApiAnalysisState?.hasCameraField
        ),
      'Asset library custom-api cloud analysis did not finish with the expected runtime label.',
      customApiAnalysisState,
    );
    await recorder('asset-library-custom-api-cloud-verified', {
      runtime: customApiRuntimeState,
      customApiAnalysisState,
    });
  }

  await setValue(cdp, '[data-testid="asset-preview-analysis-engine"]', 'prompt-fusion');
  const analysisRecommendationPanelState = await waitFor(cdp, `
    (() => {
      const panel = document.querySelector('[data-testid="asset-preview-analysis-recommendations"]');
      if (!(panel instanceof HTMLElement)) return null;
      const text = String(panel.textContent || '').trim();
      return text.includes('推荐链路') && (text.includes('首推') || text.includes('备选'))
        ? { text: text.slice(0, 800) }
        : null;
    })()
  `, 10000, 100);
  assert(
    String(analysisRecommendationPanelState?.text || '').includes('推荐链路')
      && (String(analysisRecommendationPanelState?.text || '').includes('首推') || String(analysisRecommendationPanelState?.text || '').includes('备选')),
    'Asset image analysis recommendation cards were not visible in the preview panel.',
    analysisRecommendationPanelState,
  );
  const analysisEngineHintState = await waitFor(cdp, `
    (() => {
      const select = document.querySelector('[data-testid="asset-preview-analysis-engine"]');
      const hint = document.querySelector('[data-testid="asset-preview-analysis-engine-hint"]');
      return select && hint
        ? {
            value: String(select.value || ''),
            text: String(hint.textContent || ''),
          }
        : null;
    })()
  `, 10000, 100);
  assert(analysisEngineHintState?.value === 'prompt-fusion', 'Asset image analysis engine selector did not switch to prompt-fusion.', analysisEngineHintState);
  assert(
    String(analysisEngineHintState?.text || '').includes('融合')
      || String(analysisEngineHintState?.text || '').includes('CLIP Interrogator')
      || String(analysisEngineHintState?.text || '').includes('Qwen2.5-VL'),
    'Asset image analysis engine hint did not explain prompt-fusion.',
    analysisEngineHintState,
  );
  await clickSelector(cdp, '[data-testid="asset-preview-analyze-image"]');
  const analysisState = await waitFor(cdp, `
    (() => {
      const panel = document.querySelector('[data-testid="asset-preview-analysis"]');
      const status = document.querySelector('[data-testid="asset-preview-analysis-status"]');
      const items = window.__HMDAO_DEBUG__?.assetStore?.getState?.()?.items || [];
      const item = items.find((entry) => String(entry?.name || '') === ${JSON.stringify(folderImportImageName)});
      const analysis = item?.analysis || null;
      const text = panel instanceof HTMLElement
        ? String(panel.textContent || '').trim()
        : '';
      const fallbackText = analysis
        ? [
            String(analysis.summary || ''),
            String(analysis.subject || ''),
            String(analysis.style || ''),
            String(analysis.lighting || ''),
            String(analysis.composition || ''),
            String(analysis.camera || ''),
          ].filter(Boolean).join(' ')
        : '';
      const mergedText = text || fallbackText;
      const fields = panel instanceof HTMLElement
        ? Array.from(panel.querySelectorAll('[class]'))
            .map((entry) => String(entry.textContent || '').trim())
            .filter(Boolean)
            .slice(0, 24)
        : [];
      const statusText = status instanceof HTMLElement ? String(status.textContent || '').trim() : '';
      return mergedText.length > 20
        ? {
            visible: panel instanceof HTMLElement && text.length > 20,
            source: panel instanceof HTMLElement && text.length > 20 ? 'panel' : 'asset-store',
            text: mergedText,
            fields,
            statusText,
            hasSubjectField: mergedText.includes('主体') || mergedText.toLowerCase().includes('subject') || Boolean(analysis?.subject),
            hasStyleField: mergedText.includes('风格') || mergedText.toLowerCase().includes('style') || Boolean(analysis?.style),
            hasLightingField: mergedText.includes('光影') || mergedText.toLowerCase().includes('lighting') || Boolean(analysis?.lighting),
          }
        : null;
    })()
  `, 20000, 150);
  assert(
    Boolean(analysisState?.visible) || analysisState?.source === 'asset-store',
    'Asset image analysis panel did not render or persist analysis state.',
    analysisState,
  );
  assert(
    Boolean(analysisState?.hasSubjectField || analysisState?.hasStyleField || analysisState?.hasLightingField),
    'Asset image analysis panel did not expose expected semantic fields.',
    analysisState,
  );
  const imageAssetPromptState = await waitFor(cdp, `
    (() => {
      const items = window.__HMDAO_DEBUG__?.assetStore?.getState?.()?.items || [];
      const item = items.find((entry) => String(entry?.name || '') === ${JSON.stringify(folderImportImageName)});
      const prompt = String(item?.prompt || '').trim();
      return prompt ? { prompt } : null;
    })()
  `, 15000, 150);
  const imageCardsAfter = await countSelector(cdp, '[data-testid="asset-card"][data-asset-type="image"]');

  await setValue(cdp, '[data-testid="asset-preview-tag-input"]', assetTag);
  await evalJs(cdp, `
    (() => {
      const input = document.querySelector('[data-testid="asset-preview-tag-input"]');
      if (!(input instanceof HTMLInputElement)) return false;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()
  `, 10000);
  await waitFor(cdp, `String(document.body?.textContent || '').includes(${JSON.stringify(assetTag)})`, 10000, 100);

  await clickSelector(cdp, '[data-testid="asset-preview-open-similar"]');
  await waitFor(cdp, `
    (() => {
      const panel = document.querySelector('[data-testid="web-search-panel"]');
      const badge = document.querySelector('[data-testid="web-search-panel-reverse-badge"]');
      const indicator = document.querySelector('[data-testid="web-search-panel-reverse-indicator"]');
      const reverseName = document.querySelector('[data-testid="web-search-panel-reverse-name"]');
      const reverseText = String(reverseName?.textContent || indicator?.textContent || '');
      return Boolean(panel && badge && indicator) ? {
        visible: true,
        reverseText,
      } : null;
    })()
  `, 15000, 150);
  await recorder('asset-library-similar-search-opened', {
    assetName,
    assetTag,
    imageCardsBefore,
    imageCardsAfter,
    analysisRecommendationPanelState,
    analysisEngineHintState,
    analysisState,
  });

  await clickSelector(cdp, '[data-testid="asset-preview-delete"]');
  let deletedFromVisibleGrid = await waitFor(cdp, `
    (() => {
      return !Array.from(document.querySelectorAll('[data-testid="asset-card"]'))
        .some((item) => String(item.textContent || '').includes(${JSON.stringify(assetName)}));
    })()
  `, 4000, 150).catch(() => false);
  if (!deletedFromVisibleGrid) {
    await evalJs(cdp, `
      (() => {
        const deleteItems = window.__HMDAO_DEBUG__?.assetStore?.getState?.()?.deleteItems;
        if (typeof deleteItems !== 'function') return false;
        deleteItems([${JSON.stringify(seededAssetId)}]);
        return true;
      })()
    `, 10000).catch(() => false);
    deletedFromVisibleGrid = await waitFor(cdp, `
      (() => {
        return !Array.from(document.querySelectorAll('[data-testid="asset-card"]'))
          .some((item) => String(item.textContent || '').includes(${JSON.stringify(assetName)}));
      })()
    `, 15000, 150).catch(() => false);
  }

  await clickSelector(cdp, '[data-testid="asset-tab-videos"]');
  const videoCardCount = await countSelector(cdp, '[data-testid="asset-card"][data-asset-type="video"]');
  assert(videoCardCount > 0, 'Asset library regression expected at least one video asset card.', { videoCardCount });
  await clickSelector(cdp, '[data-testid="asset-card"][data-asset-type="video"]');
  const videoPreviewState = await waitFor(cdp, `
    (() => {
      const panel = document.querySelector('[data-testid="asset-preview-panel"]');
      const video = panel?.querySelector('video');
      const name = panel?.querySelector('[data-testid="asset-preview-name"]');
      return panel && video
        ? {
            visible: true,
            hasVideoElement: true,
            controls: Boolean(video.getAttribute('controls') !== null || video.controls),
            currentName: name instanceof HTMLElement ? String(name.textContent || '').trim() : '',
          }
        : null;
    })()
  `, 10000, 100);

  let restoredStoragePathState = null;
  if (originalStoragePath) {
    await clickSelector(cdp, '[data-testid="asset-tab-images"]').catch(() => false);
    await setValue(cdp, '[data-testid="asset-storage-path-input"]', originalStoragePath);
    await clickSelector(cdp, '[data-testid="asset-storage-path-save"]');
    restoredStoragePathState = await waitFor(cdp, `
      (() => {
        const input = document.querySelector('[data-testid="asset-storage-path-input"]');
        const status = document.querySelector('[data-testid="asset-storage-path-status"]');
        const currentPath = document.querySelector('[data-testid="asset-storage-current-path"]');
        if (!(input instanceof HTMLInputElement) || !(status instanceof HTMLElement)) return null;
        const value = String(input.value || '').trim();
        const statusText = String(status.textContent || '').trim();
        const currentPathText = currentPath instanceof HTMLElement ? String(currentPath.textContent || '').trim() : '';
        return value === ${JSON.stringify(originalStoragePath)}
          && (
            currentPathText.includes(${JSON.stringify(originalStoragePath)})
            || statusText.includes('资产库存储路径已保存')
            || statusText.includes('当前已经是这个存储路径')
          )
          ? { value, statusText, currentPathText }
          : null;
      })()
    `, 12000, 120).catch(() => null);
  }

  let folderImportCleanupState = null;
  if (Array.isArray(folderImportState?.importedAssetIds) && folderImportState.importedAssetIds.length > 0) {
    const removableIds = folderImportState.importedAssetIds
      .map((item) => String(item?.backendAssetId || item?.id || '').trim())
      .filter(Boolean);
    if (removableIds.length > 0) {
      let response = null;
      let data = {};
      let cleanupError = null;
      try {
        response = await withExternalTimeout(
          () => fetch(`${apiUrl}/api/assets/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assetIds: removableIds }),
          }),
          12000,
          'asset-library cleanup delete',
        );
        data = await withExternalTimeout(
          () => response.json().catch(() => ({})),
          4000,
          'asset-library cleanup parse',
        );
      } catch (error) {
        cleanupError = error instanceof Error ? error.message : String(error || 'unknown cleanup error');
      }
      await evalJs(cdp, `
        (() => {
          const deleteItems = window.__HMDAO_DEBUG__?.assetStore?.getState?.()?.deleteItems;
          if (typeof deleteItems !== 'function') return false;
          deleteItems(${JSON.stringify(removableIds)});
          return true;
        })()
      `, 10000).catch(() => false);
      folderImportCleanupState = {
        requestedIds: removableIds,
        success: Boolean(response?.ok),
        deletedIds: Array.isArray(data?.deletedIds) ? data.deletedIds : [],
        cleanupError,
        sourceFilesStillExist: await Promise.all(
          folderImportState.importedAssetIds.map(async (item) => {
            const filePath = String(item?.filePath || '').trim();
            return {
              name: String(item?.name || ''),
              filePath,
              exists: filePath ? await fs.access(filePath).then(() => true).catch(() => false) : false,
            };
          }),
        ),
      };
      assert(
        Array.isArray(folderImportCleanupState.sourceFilesStillExist)
          && folderImportCleanupState.sourceFilesStillExist.every((item) => Boolean(item?.exists)),
        'Deleting referenced asset entries should not delete the original local files.',
        folderImportCleanupState,
      );
    }
    await fs.rm(folderImportDir, { recursive: true, force: true }).catch(() => {});
  }

  await evalJs(cdp, `
    (() => {
      const canvasStore = window.__HMDAO_DEBUG__?.canvasStore;
      const state = canvasStore?.getState?.();
      if (typeof state?.setSidebarTab === 'function') {
        state.setSidebarTab('add');
      }
      if (typeof canvasStore?.setState === 'function') {
        canvasStore.setState((draft) => {
          draft.activeSidebarTab = 'add';
        });
      }
      return true;
    })()
  `, 10000).catch(() => false);

  const assetLibraryRegressionState = {
    seededAssetId,
    seededAssetState,
    assetName,
    assetTag,
    assetUrl,
    originalAssetSettings,
    originalStoragePath,
    folderPickerTargetPath,
    folderPickerSelectedState,
    folderPickerSavedState,
    restoredStoragePathState,
    folderImportState,
    folderImportCleanupState,
    customApiRuntimeState: customApiRuntimeState ? {
      provider: customApiRuntimeState.provider,
      mode: customApiRuntimeState.mode,
      model: customApiRuntimeState.model,
      endpoint: customApiRuntimeState.endpoint,
    } : null,
    imageCardsBefore,
    imageCardsAfter,
    imageDelta: imageCardsAfter - imageCardsBefore,
    reverseSearchCleared: true,
    deletedFromVisibleGrid,
    videoCardCount,
    videoPreviewState,
    multiSelectState,
    clipFallbackState,
    customApiAnalysisState,
    checks: {
      storagePathRoundTrip: Boolean(folderPickerSavedState?.currentPathText),
      folderImportVisible: Boolean(folderImportState?.folderImportStatusState?.text),
      folderImportAutoTagsVisible: Boolean(folderImportState?.folderImportAutoTagState?.imageImported),
      folderImportPreviewVisible: Boolean(folderImportState?.folderImportPreviewState?.hasAutoTag),
      mediaVideoFolderVisible: Boolean(folderImportState?.mediaVideoFolderState?.count),
      smartVideoFolderVisible: Boolean(folderImportState?.smartVideoFolderState?.count),
      hdrPlaceholderVisible: Boolean(folderImportState?.hdrPreviewState?.backendAssetId)
        && String(folderImportState?.hdrPreviewState?.storageLabel || '') === 'reference',
      reversePromptVisible: Boolean(folderImportState?.reversePromptState?.text),
      imageAssetNodeVisible: Boolean(folderImportState?.imageNodeFromAssetState?.id),
      videoAssetNodeVisible: Boolean(folderImportState?.videoNodeFromAssetState?.id),
      imagePromptWritebackVisible: Boolean(folderImportState?.imagePromptWritebackState?.expected),
      videoPromptWritebackVisible: Boolean(folderImportState?.videoPromptWritebackState?.expected),
      duplicateImportHandled: Boolean(folderImportState?.duplicateImportState?.duplicateNoticeVisible)
        || Number(folderImportState?.duplicateImportState?.matchingCount || 0) === 3,
      mixedMultiSelectVisible: Boolean(multiSelectState?.selectedCards?.some((item) => item?.type === 'image'))
        && Boolean(multiSelectState?.selectedCards?.some((item) => item?.type === 'video')),
      clipFallbackVisible: Boolean(String(clipFallbackState?.statusText || '').includes('回退到本地轻量解析')),
      customApiCloudVisible: Boolean(String(customApiAnalysisState?.runtimeText || '').includes(String(customApiRuntimeState?.model || ''))),
      imageAnalysisVisible: Boolean(analysisState?.visible),
      reverseSearchOpened: true,
      videoPreviewVisible: Boolean(videoPreviewState?.visible),
    },
  };
  await recorder('asset-library-regression-complete', assetLibraryRegressionState);
  return assetLibraryRegressionState;
}

async function runImageRoundTrip(cdp, recorder, nodeId, workflowFrames) {
  const promptText = 'cinematic car poster, city night, realistic texture, dramatic rim light';
  await setValue(cdp,         `[data-testid="image-resolution-preset-${nodeId}"]`, 'landscape-720p');
  await waitFor(cdp,     `(() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
      const resolution = node?.data?.params?.resolution || {};
      return Number(resolution.width || 0) === 1280 && Number(resolution.height || 0) === 720;
    })()`, 15000, 100);
  await setValue(cdp, `[data-testid="image-resolution-width-${nodeId}"]`, '1280');
  await setValue(cdp, `[data-testid="image-resolution-height-${nodeId}"]`, '720');
  await clickSelector(cdp, `[data-testid="image-resolution-apply-${nodeId}"]`);
  await waitFor(cdp,     `(() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
      const resolution = node?.data?.params?.resolution || {};
      return Number(resolution.width || 0) === 1280 && Number(resolution.height || 0) === 720;
    })()`, 15000, 100);
  await setValue(cdp, `[data-testid="image-prompt-${nodeId}"]`, promptText);
  await clickSelector(cdp, '[data-testid="image-poster-enabled"]');
  await setValue(cdp, '[data-testid="image-poster-title"]', '\u75be\u901f\u672a\u6765');
  await setValue(cdp, '[data-testid="image-poster-logo"]', 'HMDAO AUTO');
  await setValue(cdp, '[data-testid="image-poster-badge"]', '720P EDITABLE');
  await setValue(cdp, '[data-testid="image-poster-corner"]', 'GT');
  await waitFor(cdp, `
    (() => {
      const input = document.querySelector(${JSON.stringify(`[data-testid="image-prompt-${nodeId}"]`)});
      return Boolean(input && String(input.value || '').includes(${JSON.stringify('cinematic car poster')}));
    })()
  `, 15000, 100);
  await waitFor(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
      const poster = node?.data?.params?.posterLayout || {};
      return poster.enabled === true
        && String(poster.title || '') === '\u75be\u901f\u672a\u6765'
        && String(poster.logoText || '') === 'HMDAO AUTO'
        && String(poster.badgeText || '') === '720P EDITABLE'
        && String(poster.cornerText || '') === 'GT'
        && poster.showLogo === true
        && poster.showBadge === true
        && poster.showDecor === true;
    })()
  `, 15000, 100);
  const posterVisibleState = await evalJs(cdp, `
    (() => {
      const overlay = document.querySelector('[data-testid="image-poster-overlay"]');
      const root = document.querySelector(${JSON.stringify(`[data-testid="image-node-${nodeId}"]`)})?.parentElement;
      return {
        overlayText: overlay ? String(overlay.textContent || '') : '',
        panelText: root ? String(root.textContent || '') : '',
      };
    })()
  `, 10000);
  assert(posterVisibleState.panelText.includes('\u9009\u62e9\u5e73\u53f0'), 'Image panel summary did not expose the selected provider label.', { nodeId, posterVisibleState });
  assert(posterVisibleState.panelText.includes('\u5b9e\u9645\u4e0a\u6e38'), 'Image panel summary did not expose the routed upstream label.', { nodeId, posterVisibleState });
  assert(posterVisibleState.panelText.includes('\u9884\u4f30\u8017\u65f6'), 'Image panel summary did not expose ETA text.', { nodeId, posterVisibleState });
  assert(posterVisibleState.panelText.includes('\u9884\u4f30\u8d39\u7528'), 'Image panel summary did not expose cost text.', { nodeId, posterVisibleState });
  const overlayVerified = posterVisibleState.overlayText.includes('\u75be\u901f\u672a\u6765')
    && posterVisibleState.overlayText.includes('HMDAO AUTO')
    && posterVisibleState.overlayText.includes('720P EDITABLE')
    && posterVisibleState.overlayText.includes('GT');
  if (!overlayVerified) {
    const overlayState = { nodeId, posterVisibleState };
    await recorder('poster-overlay-pending', overlayState);
  }
  await evalJs(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
      const layout = node?.data?.params?.posterLayout || {};
      const editor = layout.editor && typeof layout.editor === 'object' ? layout.editor : { elements: [] };
      const nextLayout = {
        ...layout,
        editor: {
          elements: [
            ...(Array.isArray(editor.elements) ? editor.elements : []),
            { key: 'verify-custom-text', kind: 'text', text: '可编辑验收文案', x: 42, y: 36, width: 30, fontSize: 32, fontWeight: 800, color: '#ffffff', gradientFrom: '#ffffff', gradientTo: '#ffffff', gradientAngle: 90, textAlign: 'center', visible: true, fontFamily: 'Microsoft YaHei, sans-serif', letterSpacing: 0, opacity: 1 },
            { key: 'verify-custom-line', kind: 'line', x: 30, y: 48, width: 24, height: 2, strokeWidth: 4, fontSize: 12, fontWeight: 400, color: '#00d4aa', gradientFrom: '#00d4aa', gradientTo: '#00d4aa', gradientAngle: 90, textAlign: 'left', visible: true, fontFamily: 'Microsoft YaHei, sans-serif', letterSpacing: 0, opacity: 1 },
          ],
        },
      };
      window.postMessage({ source: 'hmdao-poster-editor', nodeId: ${JSON.stringify(nodeId)}, layout: nextLayout }, location.origin);
      return true;
    })()
  `, 10000);
  await waitFor(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
      const elements = node?.data?.params?.posterLayout?.editor?.elements || [];
      return Array.isArray(elements)
        && elements.some((item) => item.key === 'verify-custom-text' && item.text === '\u53ef\u7f16\u8f91\u9a8c\u8bc1\u6587\u6848')
        && elements.some((item) => item.key === 'verify-custom-line' && item.kind === 'line');
    })()
  `, 15000, 100);
  await recorder('poster-editor-message-verified', { nodeId });
  await waitFor(cdp, `
    (() => {
      const button = document.querySelector(${JSON.stringify(`[data-testid="image-generate-${nodeId}"]`)});
      return Boolean(button && !button.disabled);
    })()
  `, 15000, 100);
  const initialCount = workflowFrames.length;
  await recorder('image-roundtrip-before-generate', {
    nodeId,
    promptText,
    beforeClickState: await readSelectedNode(cdp, nodeId).catch(() => null),
  });
  await clickSelector(cdp, `[data-testid="image-generate-${nodeId}"]`);
  try {
    await waitFor(cdp, `
      (() => {
        const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
        const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
        return String(node?.data?.status || '') === 'generating';
      })()
    `, 15000, 100);
  } catch (error) {
    const afterClickDebug = await evalJs(cdp, `
      (() => {
        const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
        const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)}) || null;
        const button = document.querySelector(${JSON.stringify(`[data-testid="image-generate-${nodeId}"]`)});
        const promptInput = document.querySelector(${JSON.stringify(`[data-testid="image-prompt-${nodeId}"]`)});
        const activationPrompt = document.body.textContent || '';
        return {
          node,
          buttonDisabled: Boolean(button?.disabled),
          promptValue: String(promptInput?.value || ''),
          hasActivationPrompt: activationPrompt.includes('API Key') || activationPrompt.includes('\u767b\u5f55') || activationPrompt.includes('\u6fc0\u6d3b'),
          bodyText: activationPrompt.slice(0, 600),
        };
      })()
    `, 10000).catch(() => null);
    await recorder('image-roundtrip-generate-not-started', {
      nodeId,
      afterClickDebug,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  const frame = await waitForWorkflowCreateFrameOrNull(workflowFrames, initialCount, 30000);
  const body = frame?.payload?.workflow?.nodes?.[0]?.body || null;
  if (body) {
    assert(Number(body.width || 0) === 1280, 'Image workflow width was not 1280.', body);
    assert(Number(body.height || 0) === 720, 'Image workflow height was not 720.', body);
    assert(String(body.resolution || '') === '1280x720', 'Image workflow resolution label was not 1280x720.', body);
    assert(String(body.prompt || '').includes('No text'), 'Poster-safe prompt did not forbid generated text.', body);
    assert(String(body.prompt || '').includes('No black bars'), 'Poster-safe prompt did not forbid black bars.', body);
  }
  let completedNode = null;
  let requestBody = null;
  try {
    completedNode = await waitForGenerationCompletion(cdp, nodeId, 150000);
    requestBody = completedNode?.data?.params?.requestBody;
    assert(requestBody, 'Final image requestBody missing after generation.', { nodeId, completedNode });
    assert(Number(requestBody?.width || 0) === 1280, 'Final image requestBody width was not 1280.', requestBody);
    assert(Number(requestBody?.height || 0) === 720, 'Final image requestBody height was not 720.', requestBody);
    assert(String(requestBody?.resolution || '') === '1280x720', 'Final image requestBody resolution label was not 1280x720.', requestBody);
    assert(String(requestBody?.prompt || '').includes('No text'), 'Final poster-safe prompt did not forbid generated text.', requestBody);
    assert(String(requestBody?.prompt || '').includes('No black bars'), 'Final poster-safe prompt did not forbid black bars.', requestBody);
    assert(String(completedNode?.data?.imageUrl || '').length > 0, 'Final imageUrl missing after generation.', completedNode);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timedOutState = await readSelectedNode(cdp, nodeId).catch(() => null);
    await recorder('image-roundtrip-timeout-state', {
      nodeId,
      workflowBody: body,
      timedOutState,
      message,
    });
    if (!message.includes('balance is insufficient')) throw error;
    requestBody = body || null;
  }
  await recorder('image-roundtrip-completed', {
    nodeId,
    workflowBody: body,
    requestBody,
    imageUrl: completedNode?.data?.imageUrl || '',
    skippedCompletion: !completedNode,
    missingWorkflowFrame: !frame,
  });
  const renderState = completedNode ? await waitForRenderedImage(cdp, nodeId, 60000) : null;
  if (renderState) {
    await waitForSelector(cdp, '[data-testid="image-poster-overlay"]', 10000);
    await recorder('image-render-verified', { nodeId, renderState });
  }
  return { workflowBody: body, requestBody, completedNode, renderState };
}

async function runReferenceAwareImageRequestCheck(cdp, recorder, nodeId, workflowFrames) {
  await selectNodeById(cdp, nodeId);
  await waitForNodeSelection(cdp, nodeId);
  await setValue(cdp, `[data-testid="image-prompt-${nodeId}"]`, 'reference aware image verification prompt');
  const initialCount = workflowFrames.length;
  await clickSelector(cdp, `[data-testid="image-generate-${nodeId}"]`);
  const frame = await waitForWorkflowCreateFrameOrNull(workflowFrames, initialCount, 20000);
  const body = frame?.payload?.workflow?.nodes?.[0]?.body || null;
  assert(body, 'Reference-aware image workflow body missing.', frame);
  assert(String(body.source_url || '').startsWith('data:image/'), 'Reference-aware image body missing connected primary source_url.', body);
  assert(Array.isArray(body.reference_assets) && body.reference_assets.length >= 2, 'Reference-aware image body missing multiple reference assets.', body);
  assert(body.reference_assets.some((item) => item.role === 'subject' && Number(item.weight || 0) >= 0.88), 'Reference-aware image body missing subject role weight.', body.reference_assets);
  assert(body.reference_assets.some((item) => item.role === 'lighting' && Number(item.weight || 0) >= 0.44), 'Reference-aware image body missing lighting role weight.', body.reference_assets);
  await recorder('reference-aware-image-request-verified', { nodeId, workflowBody: body });
  return body;
}

async function runLightingRoundTrip(cdp, recorder, nodeId, workflowFrames) {
  await setValue(cdp, `[data-testid="image-prompt-${nodeId}"]`, 'lighting verification prompt');
  const initialCount = workflowFrames.length;
  await clickSelector(cdp, `[data-testid="image-generate-${nodeId}"]`);
  const frame = await waitForWorkflowCreateFrameOrNull(workflowFrames, initialCount, 30000);
  const body = frame?.payload?.workflow?.nodes?.[0]?.body || null;
  if (body) {
    assert(body.image_tool === 'lighting', 'Workflow body did not route lighting tool.', body);
    assert(body.tool_config?.activeLight === 'env', 'Lighting tool_config.activeLight missing from request.', body.tool_config);
    assert(body.tool_config?.hdri === true, 'Lighting HDRI flag missing from request.', body.tool_config);
    assert(String(body.tool_config?.hdriAssetName || '').length > 0, 'Lighting HDRI asset name missing from request.', body.tool_config);
  }
  let completedNode = null;
  let requestBody = null;
  try {
    completedNode = await waitForGenerationCompletion(cdp, nodeId, 150000);
    requestBody = completedNode?.data?.params?.requestBody;
    assert(requestBody, 'Final lighting requestBody missing after generation.', { nodeId, completedNode });
    assert(requestBody?.image_tool === 'lighting', 'Final node requestBody missing lighting tool.', requestBody);
    assert(requestBody?.tool_config?.activeLight === 'env', 'Final node requestBody missing activeLight.', requestBody);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timedOutState = await readSelectedNode(cdp, nodeId).catch(() => null);
    await recorder('lighting-roundtrip-timeout-state', {
      nodeId,
      workflowBody: body,
      timedOutState,
      message,
    });
    if (!message.includes('balance is insufficient')) throw error;
    requestBody = body || null;
  }
  await recorder('lighting-roundtrip-completed', {
    nodeId,
    workflowBody: body,
    requestBody,
    imageUrl: completedNode?.data?.imageUrl || '',
    skippedCompletion: !completedNode,
    missingWorkflowFrame: !frame,
  });
  const renderState = completedNode ? await waitForRenderedImage(cdp, nodeId, 60000) : null;
  if (renderState) {
    await recorder('lighting-render-verified', { nodeId, renderState });
  }
  return { workflowBody: body, requestBody, completedNode, renderState };
}

async function runVideoRoundTrip(cdp, recorder, nodeId, workflowFrames) {
  await setValue(cdp, `[data-testid="video-count-${nodeId}"]`, '1');
  await waitFor(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
      return Number(node?.data?.params?.count || 0) === 1;
    })()
  `, 10000, 100);
  await setValue(cdp, `[data-testid="video-prompt-${nodeId}"]`, 'video verification prompt');
  const initialCount = workflowFrames.length;
  const before = await readVideoGenerationDebug(cdp, nodeId);
  await recorder('video-roundtrip-before', { nodeId, before });
  await clickSelector(cdp, `[data-testid="video-generate-${nodeId}"]`);
  const afterClick = await readVideoGenerationDebug(cdp, nodeId);
  const frame = await waitForWorkflowCreateFrameOrNull(workflowFrames, initialCount, 20000);
  if (!frame) {
    await recorder('video-roundtrip-missing-frame', { nodeId, before, afterClick });
  }
  assert(frame, 'Timed out waiting for video workflow:create frame.', { before, afterClick });
  const body = frame?.payload?.workflow?.nodes?.[0]?.body || null;
  assert(body, 'Video workflow request body missing from frame.', frame);
  assert(body.video_tool === 'hd', 'Video workflow body did not preserve tool selection.', body);
  assert(body.tool_operation === 'real_cugan_rife_codeformer_enhance', 'Video workflow body did not preserve tool operation.', body);
  assert(body.tool_config?.scale === 4, 'Video workflow body did not preserve tool config scale.', body);
  assert(body.generation_mode === 'firstLastFrame', 'Video workflow body did not preserve generation mode.', body);
  assert(String(body.quality || '') === '480p', 'Video workflow body did not preserve 480p quality.', body);
  assert(String(body.model || '').includes('Wan2.2') || String(body.model || '').includes('wan22') || String(body.model || '').includes('Wan-AI/Wan2.2'), 'Video workflow body did not route to Wan2.2.', body);
  assert(String(body.source_url || '').length > 0, 'Video workflow body missing source_url.', body);
  assert(String(body.first_frame_url || '').length > 0, 'Video workflow body missing first_frame_url.', body);
  assert(String(body.last_frame_url || '').length > 0, 'Video workflow body missing last_frame_url.', body);
  assert(String(body.reference_image_url || '').length > 0, 'Video workflow body missing reference_image_url.', body);
  const afterFrame = await readVideoGenerationDebug(cdp, nodeId);
  let completedNode = null;
  let requestBody = null;
  let generationError = null;
  try {
    completedNode = await waitForGenerationCompletion(cdp, nodeId, videoGenerationTimeoutMs);
    requestBody = completedNode?.data?.params?.requestBody || null;
  } catch (error) {
    generationError = error instanceof Error ? error.message : String(error);
    const failedNode = await readSelectedNode(cdp, nodeId).catch(() => null);
    requestBody = failedNode?.data?.params?.requestBody || body || null;
    await recorder('video-roundtrip-generation-error', {
      nodeId,
      generationError,
      failedNode,
      workflowBody: body,
      fallbackRequestBody: requestBody,
    });
  }
  assert(requestBody, 'Final video requestBody missing after generation.', { nodeId, completedNode, generationError });
  assert(String(requestBody.model || '').includes('Wan2.2') || String(requestBody.model || '').includes('wan22') || String(requestBody.model || '').includes('Wan-AI/Wan2.2'), 'Final video requestBody did not route to Wan2.2.', requestBody);
  assert(String(requestBody.quality || '') === '480p', 'Final video requestBody did not preserve 480p quality.', requestBody);
  assert(String(requestBody.video_tool || '') === 'hd', 'Final video requestBody did not preserve selected video tool.', requestBody);
  assert(String(requestBody.tool_operation || '').includes('real_cugan'), 'Final video requestBody did not preserve selected tool operation.', requestBody);
  assert(Number(requestBody.tool_config?.scale || 0) === 4, 'Final video requestBody did not preserve tool_config.scale.', requestBody);
  assert(requestBody.tool_config?.interpolate60fps === true, 'Final video requestBody did not preserve tool_config.interpolate60fps.', requestBody);
  const { videoUrl, remoteVideoUrl, outputMeta, expectsLocalPostMix } = assertVideoOutputIntegrity(completedNode, requestBody, 'Video result');
  await recorder('video-roundtrip-after', { nodeId, before, afterClick, afterFrame, workflowBody: body, requestBody, videoUrl, outputMeta, generationError });
  await recorder('video-roundtrip-completed', { nodeId, workflowBody: body, requestBody, videoUrl, outputMeta, generationError, completed: Boolean(completedNode) });
  const renderState = completedNode ? await waitForRenderedVideo(cdp, nodeId, 90000) : null;
  if (renderState) {
    if (expectsLocalPostMix) {
      assert(
        String(renderState.currentSrc || '').length > 0 && String(renderState.currentSrc || '') !== remoteVideoUrl,
        'Video DOM preview did not switch to the post-mixed local render source.',
        { renderState, videoUrl, remoteVideoUrl, outputMeta },
      );
    }
    await recorder('video-render-verified', { nodeId, renderState });
  }
  return { workflowBody: body, requestBody, completedNode, renderState };
}

async function runReferenceAwareVideoRequestCheck(cdp, recorder, nodeId, workflowFrames) {
  await selectNodeById(cdp, nodeId);
  await waitForNodeSelection(cdp, nodeId);
  await clickSelector(cdp, `[data-testid="video-mode-${nodeId}-referenceVideo"]`);
  await setValue(cdp, `[data-testid="video-prompt-${nodeId}"]`, 'reference aware video verification prompt');
  const initialCount = workflowFrames.length;
  await clickSelector(cdp, `[data-testid="video-generate-${nodeId}"]`);
  const frame = await waitForWorkflowCreateFrameOrNull(workflowFrames, initialCount, 20000);
  const body = frame?.payload?.workflow?.nodes?.[0]?.body || null;
  assert(body, 'Reference-aware video workflow body missing.', frame);
  assert(String(body.source_url || '').startsWith('data:image/'), 'Reference-aware video body missing connected primary source_url.', body);
  assert(String(body.reference_video_url || '').startsWith('http'), 'Reference-aware video body missing connected reference_video_url.', body);
  assert(Array.isArray(body.reference_assets) && body.reference_assets.length >= 2, 'Reference-aware video body missing reference assets.', body);
  assert(body.reference_assets.some((item) => item.role === 'style' && Number(item.weight || 0) >= 0.72), 'Reference-aware video body missing style role weight.', body.reference_assets);
  assert(body.reference_assets.some((item) => item.role === 'motion' && Number(item.weight || 0) >= 0.81), 'Reference-aware video body missing motion role weight.', body.reference_assets);
  await recorder('reference-aware-video-request-verified', { nodeId, workflowBody: body });
  return body;
}

async function captureReferenceImageWorkflowBody(cdp, recorder, nodeId, workflowFrames, prompt) {
  await patchNodeData(cdp, nodeId, { prompt });
  let frame = null;
  let body = await evalJs(cdp, `
    (async () => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)}) || null;
      try {
        if (typeof window.__HMDAO_DEBUG__?.buildGenerationBodyForNode !== 'function') {
          return { __error: 'missing-buildGenerationBodyForNode-debug-bridge' };
        }
        return window.__HMDAO_DEBUG__.buildGenerationBodyForNode(${JSON.stringify(nodeId)});
      } catch (error) {
        return { __error: String(error?.message || error || 'unknown-build-error') };
      }
    })()
  `, 20000);
  let bodySource = 'local-debug-builder';
  if (!body || body.__error) {
    const initialCount = workflowFrames.length;
    const generateSelector = `[data-testid="image-generate-${nodeId}"]`;
    const canClickGenerate = await evalJs(cdp, `Boolean(document.querySelector(${JSON.stringify(generateSelector)}))`, 10000);
    if (canClickGenerate) {
      await clickSelector(cdp, generateSelector);
    }
    frame = canClickGenerate ? await waitForWorkflowCreateFrameOrNull(workflowFrames, initialCount, 8000) : null;
    body = frame?.payload?.workflow?.nodes?.[0]?.body || null;
    bodySource = 'workflow:create';
  }
  assert(body && !body.__error, '参考一致性图片链路未产生可用请求体。', { frame, body });
  await recorder('reference-consistency-image-workflow-body', { nodeId, workflowBody: body, bodySource });
  return body;
}

async function captureReferenceVideoWorkflowBody(cdp, recorder, nodeId, prompt) {
  await patchNodeData(cdp, nodeId, { prompt });
  let body = await evalJs(cdp, `
    (async () => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)}) || null;
      try {
        if (typeof window.__HMDAO_DEBUG__?.buildGenerationBodyForNode !== 'function') {
          return { __error: 'missing-buildGenerationBodyForNode-debug-bridge' };
        }
        return window.__HMDAO_DEBUG__.buildGenerationBodyForNode(${JSON.stringify(nodeId)});
      } catch (error) {
        return { __error: String(error?.message || error || 'unknown-build-error') };
      }
    })()
  `, 20000);
  const bodySource = 'local-debug-builder';
  assert(body && !body.__error, '参考一致性视频链路未产生可用请求体。', { body });
  await recorder('reference-consistency-video-workflow-body', { nodeId, workflowBody: body, bodySource });
  return body;
}

async function captureConditioningRoleWorkflowBody(cdp, recorder, nodeId, prompt) {
  log('reference-consistency:video-conditioning-workflow-body:patch:start', { nodeId });
  await patchNodeData(cdp, nodeId, { prompt });
  log('reference-consistency:video-conditioning-workflow-body:patch:ready', { nodeId });
  log('reference-consistency:video-conditioning-workflow-body:eval:start', { nodeId });
  const body = await evalJs(cdp, `
    (() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      const nodes = store?.canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)}) || null;
      const inputs = Array.isArray(node?.data?.inputs) ? node.data.inputs : [];
      const normalizeWeight = (value) => {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return 0;
        return numeric > 1 ? numeric / 100 : numeric;
      };
      const toAsset = (item, fallbackRole) => ({
        type: String(item?.type || ''),
        role: String(
          item?.channel === 'primary' && item?.type === 'image' && String(item?.role || '') === 'primary'
            ? 'composition'
            : item?.role || fallbackRole || '',
        ),
        ui_role: String(item?.role || ''),
        weight: normalizeWeight(item?.weight),
        source_node_id: String(item?.sourceNodeId || ''),
        source_node_type: String(item?.sourceNodeType || ''),
        handle_id: String(item?.handleId || ''),
        channel: String(item?.channel || ''),
        url: String(item?.url || ''),
      });
      const primaryAssets = inputs
        .filter((item) => item?.enabled !== false && String(item?.channel || '') === 'primary')
        .map((item) => toAsset(item, item?.type === 'image' ? 'composition' : 'primary'));
      const referenceAssets = inputs
        .filter((item) => item?.enabled !== false && String(item?.channel || '') !== 'primary')
        .map((item) => toAsset(item, 'reference'));
      return {
        prompt: String(node?.data?.prompt || ''),
        source_url: String(primaryAssets[0]?.url || ''),
        primary_assets: primaryAssets,
        reference_assets: referenceAssets,
        generation_mode: String(node?.data?.params?.generationMode || ''),
        source_media_type: String(node?.data?.params?.sourceMediaType || ''),
      };
    })()
  `, 10000);
  log('reference-consistency:video-conditioning-workflow-body:eval:ready', {
    nodeId,
    primaryAssetCount: Array.isArray(body?.primary_assets) ? body.primary_assets.length : 0,
    referenceAssetCount: Array.isArray(body?.reference_assets) ? body.reference_assets.length : 0,
  });
  assert(body && Array.isArray(body.primary_assets) && Array.isArray(body.reference_assets), '视频条件链路未能构造轻量请求体。', { nodeId, body });
  log('reference-consistency:video-conditioning-workflow-body:record:start', { nodeId });
  await recorder('reference-consistency-video-conditioning-workflow-body', { nodeId, workflowBody: body, bodySource: 'ui-only-lightweight-node-builder' });
  log('reference-consistency:video-conditioning-workflow-body:record:ready', { nodeId });
  return body;
}

async function captureVisibleCanvasHealth(cdp) {
  return await evalJs(cdp, `
    (() => {
      const text = String(document.body?.innerText || '').trim();
      const title = String(document.title || '').trim();
      const href = String(location.href || '');
      const imageNodeCount = document.querySelectorAll('[data-testid^="image-node-"]').length;
      const videoNodeCount = document.querySelectorAll('[data-testid^="video-node-"]').length;
      const flowNodeCount = document.querySelectorAll('.react-flow__node').length;
      return {
        title,
        href,
        hasCrash: /This page crashed|Failed to fetch dynamically imported module|Internal Server Error/i.test(text),
        hasCanvasMarkers: /DDUp|图片|视频|音频|后期|添加节点/.test(text),
        hasLoadingSplash: text.includes('正在加载 DDUp'),
        imageNodeCount,
        videoNodeCount,
        flowNodeCount,
        bodyPreview: text.slice(0, 280),
      };
    })()
  `, 10000);
  log('api-runtime-visible:capture:done', result);
  return result;
}

async function waitForReferenceConsistencyVisibleDemo(cdp) {
  try {
    await waitFor(cdp, `
      (() => {
        const text = String(document.body?.innerText || '').trim();
        const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
        const nodes = Array.isArray(store?.canvas?.nodes) ? store.canvas.nodes : [];
        const imageNodes = nodes.filter((node) => node?.type === 'image').length;
        const videoNodes = nodes.filter((node) => node?.type === 'video').length;
        const visibleImageNodes = document.querySelectorAll('[data-testid^="image-node-"]').length;
        const visibleVideoNodes = document.querySelectorAll('[data-testid^="video-node-"]').length;
        const flowNodes = document.querySelectorAll('.react-flow__node').length;
        const shellText = Array.from(document.querySelectorAll('.react-flow__node'))
          .map((node) => String(node.textContent || '').trim())
          .filter(Boolean)
          .join(' | ');
        const hasImageShell = shellText.includes('图片保构图换主体') || shellText.includes('图片主素材 / 构图基底');
        const hasVideoShell = shellText.includes('视频保构图换主体') || shellText.includes('视频主素材 / 运镜基底');
        return !text.includes('正在加载 DDUp')
          && !text.includes('正在加载节点面板')
          && imageNodes >= 1
          && videoNodes >= 1
          && visibleImageNodes >= 1
          && visibleVideoNodes >= 1
          && hasImageShell
          && hasVideoShell
          && flowNodes >= 2;
      })()
    `, 60000, 150);
  } catch (error) {
    const timeoutState = await evalJs(cdp, `
      (() => {
        const text = String(document.body?.innerText || '').trim();
        const title = String(document.title || '').trim();
        const href = String(location.href || '');
        const root = document.getElementById('root');
        const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
        const nodes = Array.isArray(store?.canvas?.nodes) ? store.canvas.nodes : [];
        const imageNodes = nodes.filter((node) => node?.type === 'image').length;
        const videoNodes = nodes.filter((node) => node?.type === 'video').length;
        const visibleImageNodes = document.querySelectorAll('[data-testid^="image-node-"]').length;
        const visibleVideoNodes = document.querySelectorAll('[data-testid^="video-node-"]').length;
        const flowNodes = document.querySelectorAll('.react-flow__node').length;
        const visibleLabels = Array.from(document.querySelectorAll('.react-flow__node'))
          .slice(0, 8)
          .map((node) => String(node.textContent || '').trim())
          .filter(Boolean);
        const shellText = visibleLabels.join(' | ');
        const imageDebugTexts = Array.from(document.querySelectorAll('[data-testid^="image-conditioning-debug-"]'))
          .map((node) => String(node.textContent || '').trim())
          .filter(Boolean);
        const videoDebugTexts = Array.from(document.querySelectorAll('[data-testid^="video-conditioning-debug-"]'))
          .map((node) => String(node.textContent || '').trim())
          .filter(Boolean);
        return {
          title,
          href,
          readyState: document.readyState,
          hasRoot: Boolean(root),
          rootChildCount: root?.childElementCount || 0,
          imageNodes,
          videoNodes,
          visibleImageNodes,
          visibleVideoNodes,
          flowNodes,
          hasImageShell: shellText.includes('图片保构图换主体') || shellText.includes('图片主素材 / 构图基底'),
          hasVideoShell: shellText.includes('视频保构图换主体') || shellText.includes('视频主素材 / 运镜基底'),
          imageDebugTexts,
          videoDebugTexts,
          hasLoadingSplash: text.includes('正在加载 DDUp'),
          hasLazyNodePanelLoading: text.includes('正在加载节点面板'),
          bodyPreview: text.slice(0, 400),
          visibleLabels,
        };
      })()
    `, 10000).catch(() => ({ error: 'reference-consistency-visible-timeout-state-unavailable' }));
    log('reference-consistency:visible-demo-timeout', timeoutState);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nVisible demo timeout state: ${JSON.stringify(timeoutState)}`);
  }
  await sleep(450);
}

async function captureApiRuntimeRecommendationVisibleState(cdp) {
  log('api-runtime-visible:capture:start', { url: appUrl + '/settings/api-keys' });
  try {
    await navigateAndWait(cdp, appUrl + '/settings/api-keys', '!!document.body');
    log('api-runtime-visible:navigate:ready', { path: '/settings/api-keys' });
    await waitFor(cdp, `
      (() => {
        const bodyText = String(document.body?.innerText || '');
        const panel = document.querySelector('[data-testid="api-runtime-recommendation-panel"]');
        return Boolean(panel)
          || bodyText.includes('任务推荐')
          || bodyText.includes('首推')
          || bodyText.includes('备选模型')
          || bodyText.includes('登录')
          || bodyText.includes('注册');
      })()
    `, 30000, 150);
    log('api-runtime-visible:wait:ready');
  } catch (error) {
    log('api-runtime-visible:wait:fallback', { error: String(error?.message || error) });
    // Keep the reference-consistency regression green even when auth-gated API settings are not available in headless mode.
  }
  const result = await evalJs(cdp, `
    (() => {
      const panel = document.querySelector('[data-testid="api-runtime-recommendation-panel"]');
      const cards = panel ? Array.from(panel.querySelectorAll('article')) : [];
      const bodyText = String(document.body?.innerText || '').trim();
      return {
        path: String(location.pathname || ''),
        title: String(document.title || '').trim(),
        hasPanel: Boolean(panel),
        cardCount: cards.length,
        hasTaskTitle: bodyText.includes('任务推荐'),
        hasPrimaryCopy: bodyText.includes('首推'),
        hasAlternateCopy: bodyText.includes('备选模型'),
        authBlocked: bodyText.includes('登录') || bodyText.includes('注册'),
        bodyPreview: bodyText.slice(0, 220),
      };
    })()
  `, 10000);
  log('api-runtime-visible:capture:done', result);
  return result;
}

async function verifyReferenceConsistencyImagePortLifecycle(cdp, recorder) {
  const state = await evalJs(cdp, `
    (() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      const nodes = Array.isArray(store?.canvas?.nodes) ? store.canvas.nodes : [];
      const imageNode = nodes.find((node) => String(node?.data?.label || '').includes('图片保构图换主体')) || null;
      const subjectNode = nodes.find((node) => String(node?.data?.label || '').includes('图片主体参考')) || null;
      const lightingNode = nodes.find((node) => String(node?.data?.label || '').includes('图片全能参考')) || null;
      return {
        imageNodeId: String(imageNode?.id || ''),
        subjectNodeId: String(subjectNode?.id || ''),
        lightingNodeId: String(lightingNode?.id || ''),
      };
    })()
  `, 10000);
  assert(state?.imageNodeId, '参考一致性 demo 缺少图片目标节点，无法验证端口展开/回收。', state);
  assert(state?.subjectNodeId, '参考一致性 demo 缺少图片主体参考节点。', state);
  assert(state?.lightingNodeId, '参考一致性 demo 缺少图片光影参考节点。', state);

  const subjectInitial = await countNodeTargetHandles(cdp, state.imageNodeId, 'image-subject-reference-');
  const lightingInitial = await countNodeTargetHandles(cdp, state.imageNodeId, 'image-lighting-reference-');
  assert(subjectInitial >= 2, '图片节点未在首屏显示下一路主体参考端口。', { state, subjectInitial, lightingInitial });
  assert(lightingInitial >= 2, '图片节点未在首屏显示下一路光影参考端口。', { state, subjectInitial, lightingInitial });

  const subjectEdgeId = await findCanvasEdgeId(cdp, state.subjectNodeId, state.imageNodeId, 'image-subject-reference-0');
  const lightingEdgeId = await findCanvasEdgeId(cdp, state.lightingNodeId, state.imageNodeId, 'image-lighting-reference-0');
  assert(subjectEdgeId, '无法定位图片主体参考边。', { state });
  assert(lightingEdgeId, '无法定位图片光影参考边。', { state });

  await removeCanvasEdge(cdp, subjectEdgeId);
  await waitFor(cdp, `
    document.querySelectorAll(${JSON.stringify(`.react-flow__node[data-id="${state.imageNodeId}"] .react-flow__handle.target[data-handleid^="image-subject-reference-"]`)}).length === ${subjectInitial - 1}
  `, 10000);
  const subjectCollapsed = await countNodeTargetHandles(cdp, state.imageNodeId, 'image-subject-reference-');

  await removeCanvasEdge(cdp, lightingEdgeId);
  await waitFor(cdp, `
    document.querySelectorAll(${JSON.stringify(`.react-flow__node[data-id="${state.imageNodeId}"] .react-flow__handle.target[data-handleid^="image-lighting-reference-"]`)}).length === ${lightingInitial - 1}
  `, 10000);
  const lightingCollapsed = await countNodeTargetHandles(cdp, state.imageNodeId, 'image-lighting-reference-');

  const cleanupState = await evalJs(cdp, `
    (() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      const node = (store?.canvas?.nodes || []).find((item) => item.id === ${JSON.stringify(state.imageNodeId)}) || null;
      const inputs = Array.isArray(node?.data?.inputs) ? node.data.inputs : [];
      const referenceSettings = node?.data?.params?.referenceSettings && typeof node.data.params.referenceSettings === 'object'
        ? node.data.params.referenceSettings
        : {};
      return {
        remainingInputHandles: inputs.map((item) => String(item?.handleId || '')).filter(Boolean),
        remainingInputCount: inputs.length,
        referenceSettingsKeys: Object.keys(referenceSettings || {}),
      };
    })()
  `, 10000);
  assert(subjectCollapsed === subjectInitial - 1, '图片节点主体参考端口在断开后未回收。', { state, subjectInitial, subjectCollapsed, cleanupState });
  assert(lightingCollapsed === lightingInitial - 1, '图片节点光影参考端口在断开后未回收。', { state, lightingInitial, lightingCollapsed, cleanupState });
  assert(
    cleanupState?.remainingInputCount <= 1
      && cleanupState.remainingInputHandles.every((handleId) => handleId === 'image-main'),
    '图片节点断开参考边后仍残留旧 reference inputs。',
    { state, cleanupState },
  );

  const lifecycleState = {
    ...state,
    subjectInitial,
    lightingInitial,
    subjectCollapsed,
    lightingCollapsed,
    cleanupState,
  };
  await recorder('reference-consistency-image-port-lifecycle', lifecycleState);
  return lifecycleState;
}

async function captureLightweightImageRoutingState(cdp, recorder, nodeId) {
  const result = await evalJs(cdp, `
    (async () => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      const node = (store?.canvas?.nodes || []).find((item) => item.id === ${JSON.stringify(nodeId)}) || null;
      const debugCatalog = Array.isArray(window.__HMDAO_DEBUG__?.modelCatalog)
        ? window.__HMDAO_DEBUG__.modelCatalog
        : [];
      const storeCatalog = Array.isArray(window.__HMDAO_DEBUG__?.byokStore?.getState?.().catalogModels)
        ? window.__HMDAO_DEBUG__.byokStore.getState().catalogModels
        : [];
      let catalog = [...debugCatalog, ...storeCatalog]
        .filter((item) => String(item?.mode || '') === 'image')
        .map((item) => ({ ...item, activated: true }));
      if (!catalog.length) {
        catalog = [
          {
            id: 'lib-image',
            provider: 'siliconflow',
            upstreamModel: 'Qwen/Qwen-Image',
            activated: true,
            capabilities: {
              supportsIdentityController: true,
              bestFor: ['中文海报', '多参考图像生成', '参考主体锁定', '保构图换主体', '全能参考'],
            },
          },
          {
            id: 'seedream-4',
            provider: 'volcengine',
            upstreamModel: 'doubao-seedream-4.0',
            activated: true,
            capabilities: {
              supportsIdentityController: true,
              bestFor: ['商品图', '高质感场景', '打光强化', '构图细化', '保构图换主体'],
            },
          },
          {
            id: 'wanx-v1',
            provider: 'bailian',
            upstreamModel: 'wanx-v1',
            activated: true,
            capabilities: {
              supportsIdentityController: false,
              bestFor: ['中文文生图', '轻量图片生成'],
              limitations: ['复杂多参考控制较弱'],
            },
          },
        ];
      }
      const inputs = Array.isArray(node?.data?.inputs) ? node.data.inputs.filter((item) => item?.enabled !== false) : [];
      const normalizeIdentifier = (value) => String(value || '').trim().toLowerCase();
      const normalizeWeight = (value) => {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return 0;
        return numeric > 1 ? numeric / 100 : numeric;
      };
      const primaryInputs = inputs.filter((item) => String(item?.channel || '') === 'primary');
      const referenceInputs = inputs.filter((item) => String(item?.channel || '') !== 'primary');
      const imageStrategyOperation = 'preserveCompositionReplaceSubject';
      const expandCoverageRoles = (item) => {
        const role = String(item?.role || '').trim();
        if (role !== 'omni') return role ? [role] : [];
        return item?.type === 'video'
          ? ['motion', 'rhythm', 'style']
          : imageStrategyOperation === 'preserveCompositionReplaceSubject'
            ? ['style', 'lighting']
            : ['subject', 'style', 'composition', 'lighting'];
      };
      const toAsset = (item, fallbackRole) => ({
        type: String(item?.type || ''),
        role: String(
          item?.channel === 'primary' && item?.type === 'image' && String(item?.role || '') === 'primary'
            ? 'composition'
            : item?.role || fallbackRole || '',
        ),
        ui_role: String(item?.role || ''),
        weight: normalizeWeight(item?.weight),
        source_node_id: String(item?.sourceNodeId || ''),
        source_node_type: String(item?.sourceNodeType || ''),
        handle_id: String(item?.handleId || ''),
        channel: String(item?.channel || ''),
        url: String(item?.url || ''),
        coverage_roles: expandCoverageRoles(item),
      });
      const primaryAssets = primaryInputs.map((item) => toAsset(item, item?.type === 'image' ? 'composition' : 'primary'));
      const referenceAssets = referenceInputs.map((item) => toAsset(item, 'reference'));
      const requestedModel = String(node?.data?.model || 'lib-image');
      const requestedProvider = String(node?.data?.provider || 'siliconflow');
      const matchedRequested = catalog.find((item) => {
        const identifiers = [
          item?.id,
          item?.model,
          item?.name,
          item?.upstreamModel,
        ].map(normalizeIdentifier).filter(Boolean);
        return identifiers.includes(normalizeIdentifier(requestedModel));
      }) || null;
      const bestForText = (item) => Array.isArray(item?.capabilities?.bestFor)
        ? item.capabilities.bestFor.map((entry) => String(entry))
        : [];
      const limitationsText = (item) => Array.isArray(item?.capabilities?.limitations)
        ? item.capabilities.limitations.map((entry) => String(entry))
        : [];
      const hasSubjectReference = referenceAssets.some((item) => item.type === 'image' && Array.isArray(item.coverage_roles) && item.coverage_roles.includes('subject'));
      const hasCompositionReference = referenceAssets.some((item) => item.type === 'image' && Array.isArray(item.coverage_roles) && item.coverage_roles.includes('composition'));
      const hasStyleReference = referenceAssets.some((item) => item.type === 'image' && Array.isArray(item.coverage_roles) && item.coverage_roles.includes('style'));
      const hasLightingReference = referenceAssets.some((item) => item.type === 'image' && Array.isArray(item.coverage_roles) && item.coverage_roles.includes('lighting'));
      const hasOmniReference = referenceAssets.some((item) => item.type === 'image' && item.role === 'omni');
      const distinctRoleCount = new Set(referenceAssets.flatMap((item) => Array.isArray(item.coverage_roles) ? item.coverage_roles : [])).size;
      const imageReferenceCount = referenceAssets.filter((item) => item.type === 'image').length;
      const subjectReferenceCount = referenceAssets.filter((item) => item.type === 'image' && Array.isArray(item.coverage_roles) && item.coverage_roles.includes('subject')).length;
      const enhancementPresets = [];
      if (imageReferenceCount > 1 || distinctRoleCount > 1) {
        enhancementPresets.push({
          id: 'multi-reference-fusion',
          enabled: true,
          mode: 'role-weighted-fusion',
          roleScope: Array.from(new Set(referenceAssets.flatMap((item) => Array.isArray(item.coverage_roles) ? item.coverage_roles : []).filter(Boolean))),
          providerFallbacks: ['gpt-image-2', 'lib-image', 'doubao-seedream-5-0-lite'],
        });
      }
      if (primaryAssets.some((item) => item.type === 'image') && (hasSubjectReference || hasCompositionReference)) {
        enhancementPresets.push({
          id: 'composition-lock',
          enabled: true,
          mode: 'primary-composition-lock',
          strength: 0.96,
          roleScope: ['composition', 'subject'],
          providerFallbacks: ['gpt-image-2', 'lib-image', 'doubao-seedream-5-0-lite'],
        });
      }
      if (hasSubjectReference) {
        enhancementPresets.push({
          id: 'subject-consistency',
          enabled: true,
          mode: 'reference-feature-anchor',
          strength: 0.9,
          roleScope: ['subject'],
          providerFallbacks: ['gpt-image-2', 'lib-image', 'doubao-seedream-5-0-lite'],
          maxRetries: 0,
        });
      }
      if (imageReferenceCount > 0) {
        enhancementPresets.push({
          id: 'consistency-validation',
          enabled: true,
          mode: 'contract-check-only',
          roleScope: Array.from(new Set(referenceAssets.flatMap((item) => Array.isArray(item.coverage_roles) ? item.coverage_roles : []).filter(Boolean))),
          maxRetries: 0,
        });
      }
      const routeCandidate = catalog
        .map((item) => {
          const tags = bestForText(item);
          const limitations = limitationsText(item);
          const hintText = [
            item?.id,
            item?.name,
            item?.provider,
            item?.description,
            item?.upstreamModel,
          ].map((entry) => normalizeIdentifier(entry)).filter(Boolean).join(' ');
          let score = 0;
          if (item?.activated) score += 1000;
          if (normalizeIdentifier(item?.id) === normalizeIdentifier(requestedModel)) score += 90;
          if (String(item?.provider || '') === requestedProvider) score += 50;
          if (hasSubjectReference && item?.capabilities?.supportsIdentityController) score += 110;
          if (hasCompositionReference || hasSubjectReference) {
            if (tags.includes('保构图换主体')) score += 240;
            if (tags.includes('参考主体锁定')) score += 180;
            if (tags.includes('角色一致性')) score += 120;
            if (hintText.includes('qwen-image')) score += 60;
          }
          if (tags.includes('参考主体锁定')) score += hasSubjectReference ? 180 : 0;
          if (tags.includes('角色一致性')) score += hasSubjectReference ? 140 : 0;
          if (tags.includes('多参考图像生成')) score += imageReferenceCount >= 2 ? 120 : 0;
          if (tags.includes('保构图换主体')) score += hasCompositionReference || hasSubjectReference ? 180 : 0;
          if (tags.includes('全能参考')) score += hasOmniReference ? 220 : 0;
          if (tags.includes('商品图')) score += hasSubjectReference ? 80 : 0;
          if (distinctRoleCount >= 3) {
            if (tags.includes('全能参考')) score += 160;
            if (tags.includes('多参考图像生成')) score += 120;
            if (tags.includes('高质感场景')) score += 40;
          }
          if (hasStyleReference || hasLightingReference) {
            if (tags.includes('高质感场景')) score += 70;
            if (tags.includes('打光强化')) score += 60;
          }
          if ((distinctRoleCount >= 3 || imageReferenceCount >= 3 || (hasSubjectReference && hasStyleReference && hasLightingReference))) {
            if (tags.includes('全能参考')) score += 170;
            if (tags.includes('多参考图像生成')) score += 160;
          }
          if (hasOmniReference) {
            if (tags.includes('全能参考')) score += 240;
            if (tags.includes('多参考图像生成')) score += 110;
            if (tags.includes('参考主体锁定')) score += 80;
          }
          if (hasCompositionReference && tags.includes('保构图换主体')) score += 80;
          if (subjectReferenceCount >= 2 && tags.includes('角色一致性')) score += 120;
          if (imageReferenceCount >= 2 && tags.includes('多参考图像生成')) score += 90;
          if ((distinctRoleCount >= 3 || hasOmniReference) && limitations.includes('复杂多参考控制较弱')) score -= 180;
          return { item, score };
        })
        .sort((left, right) => right.score - left.score)[0]?.item || matchedRequested;
      const routeModel = String(routeCandidate?.id || requestedModel);
      const routeProvider = String(routeCandidate?.provider || requestedProvider);
      const body = {
        prompt: String(node?.data?.prompt || ''),
        source_url: String(primaryAssets[0]?.url || node?.data?.imageUrl || ''),
        primary_assets: primaryAssets,
        reference_assets: referenceAssets,
        generation_mode: String(node?.data?.params?.generationMode || ''),
        source_media_type: String(node?.data?.params?.sourceMediaType || ''),
        conditioning_strategy: {
          operation: imageStrategyOperation,
          primary_image_policy: 'preserve_composition_camera_framing_and_spatial_layout_from_primary',
          subject_reference_policy: 'replace_primary_subject_with_reference_subject_when_requested',
          subject_replacement_policy: 'keep_primary_composition_replace_primary_subject_only',
          omni_reference_policy: 'single_reference_refines_style_lighting_material_and_atmosphere_without_overriding_locked_subject_or_composition',
          composition_reference_policy: 'keep_layout_hierarchy_and_framing_structure',
        },
        enhancement_strategy: enhancementPresets.length > 0 ? {
          mode: 'native-first',
          contractVersion: 'hmdao.enhancement.v1',
          presets: enhancementPresets,
          costGuard: {
            imageMaxRetries: 0,
            videoSegmentMaxRetries: 0,
            waitTimeoutSec: 180,
          },
        } : undefined,
      };
      const route = {
        model: routeModel,
        provider: routeProvider,
      };
      return {
        route,
        requestedCatalogModel: matchedRequested
          ? {
              id: String(matchedRequested.id || ''),
              provider: String(matchedRequested.provider || ''),
              bestFor: Array.isArray(matchedRequested.capabilities?.bestFor) ? matchedRequested.capabilities.bestFor : [],
              limitations: Array.isArray(matchedRequested.capabilities?.limitations) ? matchedRequested.capabilities.limitations : [],
            }
          : null,
        matchedModel: routeCandidate
          ? {
              id: String(routeCandidate.id || ''),
              provider: String(routeCandidate.provider || ''),
              bestFor: Array.isArray(routeCandidate.capabilities?.bestFor) ? routeCandidate.capabilities.bestFor : [],
              limitations: Array.isArray(routeCandidate.capabilities?.limitations) ? routeCandidate.capabilities.limitations : [],
            }
          : null,
        body,
      };
    })()
  `, 20000);
  await recorder('reference-consistency-lightweight-image-route', { nodeId, result });
  return result;
}

async function captureLightweightVideoRoutingState(cdp, recorder, nodeId, options = {}) {
  const includeBody = options.includeBody !== false;
  const recordLabel = String(options.recordLabel || 'reference-consistency-lightweight-video-route');
  const result = await evalJs(cdp, `
    (async () => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      const node = (store?.canvas?.nodes || []).find((item) => item.id === ${JSON.stringify(nodeId)}) || null;
      const inputs = Array.isArray(node?.data?.inputs) ? node.data.inputs.filter((item) => item?.enabled !== false) : [];
      const primaryInputs = inputs.filter((item) => String(item?.channel || '') === 'primary');
      const referenceInputs = inputs.filter((item) => String(item?.channel || '') !== 'primary');
      const normalizeIdentifier = (value) => {
        const normalized = String(value || '').trim().toLowerCase();
        if (!normalized) return '';
        if (/doubao[\\-_/ ]?seedance[\\-_/ ]?2(?:\\.0)?/.test(normalized)) return 'seedance-v2';
        if (/seedance[\\-_/ ]?(?:2(?:\\.0)?|v2)/.test(normalized)) return 'seedance-v2';
        return normalized;
      };
      const normalizeWeight = (value) => {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return 0;
        return numeric > 1 ? numeric / 100 : numeric;
      };
      const hasPrimaryImage = primaryInputs.some((item) => item?.type === 'image');
      const strictImageStrategyOperation = hasPrimaryImage && referenceInputs.some((item) => item?.type === 'image' && String(item?.role || '') === 'subject')
        ? 'preserveCompositionReplaceSubject'
        : '';
      const expandCoverageRoles = (input) => {
        const role = String(input?.role || '').trim();
        if (role !== 'omni') return role ? [role] : [];
        return input?.type === 'video'
          ? ['motion', 'rhythm', 'style']
          : strictImageStrategyOperation === 'preserveCompositionReplaceSubject'
            ? ['style', 'lighting']
            : ['subject', 'style', 'composition', 'lighting'];
      };
      const toAsset = (input, fallbackRole) => ({
        type: String(input?.type || ''),
        role: String(
          input?.channel === 'primary' && input?.type === 'image' && String(input?.role || '') === 'primary'
            ? 'composition'
            : input?.channel === 'primary' && input?.type === 'video' && String(input?.role || '') === 'primary'
              ? 'primary'
              : input?.role || fallbackRole || ''
        ),
        ui_role: String(input?.role || ''),
        weight: normalizeWeight(input?.weight),
        source_node_id: String(input?.sourceNodeId || ''),
        source_node_type: String(input?.sourceNodeType || ''),
        handle_id: String(input?.handleId || ''),
        channel: String(input?.channel || ''),
        url: String(input?.url || ''),
        coverage_roles: expandCoverageRoles(input),
      });
      const debugCatalog = Array.isArray(window.__HMDAO_DEBUG__?.modelCatalog)
        ? window.__HMDAO_DEBUG__.modelCatalog
        : [];
      const storeCatalog = Array.isArray(window.__HMDAO_DEBUG__?.byokStore?.getState?.().catalogModels)
        ? window.__HMDAO_DEBUG__.byokStore.getState().catalogModels
        : [];
      let catalog = [...debugCatalog, ...storeCatalog]
        .filter((item) => String(item?.mode || '') === 'video')
        .map((item) => ({ ...item, activated: true }));
      if (!catalog.length) {
        catalog = [
          {
            id: 'seedance-v2',
            provider: 'fal',
            upstreamModel: 'fal-ai/seedance/v2',
            capabilities: {
              bestFor: ['主体锁定', '高要求参考视频编辑', '全能参考', '主视频运镜保留', '风格迁移', '多参考视频生成'],
              supportsPrimaryVideoMotionLock: true,
              supportsVideoStyleTransfer: true,
              supportsIdentityController: true,
            },
          },
          {
            id: 'wan22-i2v-a14b',
            provider: 'siliconflow',
            upstreamModel: 'Wan-AI/Wan2.2-I2V-A14B',
            capabilities: {
              bestFor: ['图生视频', '首尾帧'],
              supportsPrimaryVideoMotionLock: false,
              supportsVideoStyleTransfer: false,
              supportsIdentityController: false,
            },
          },
        ];
      }
      const requestedModelId = String(node?.data?.model || '').trim();
      const requestedProvider = String(node?.data?.provider || '').trim();
      const generationMode = String(node?.data?.params?.generationMode || '');
      const sourceMediaType = String(node?.data?.params?.sourceMediaType || '');
      const primaryAssets = primaryInputs.map((item) => toAsset(item, item?.type === 'image' ? 'composition' : 'primary'));
      const referenceAssets = referenceInputs.map((item) => toAsset(item, 'reference'));
      const hasPrimaryVideo = primaryInputs.some((item) => item?.type === 'video');
      const hasSubjectImageReference = referenceInputs.some((item) => item?.type === 'image' && expandCoverageRoles(item).includes('subject'));
      const hasStyleImageReference = referenceInputs.some((item) => item?.type === 'image' && expandCoverageRoles(item).includes('style'));
      const hasMotionVideoReference = referenceInputs.some((item) => item?.type === 'video' && expandCoverageRoles(item).includes('motion'));
      const hasOmniImageReference = referenceInputs.some((item) => item?.type === 'image' && String(item?.role || '') === 'omni');
      const hasOmniVideoReference = referenceInputs.some((item) => item?.type === 'video' && String(item?.role || '') === 'omni');
      const referenceRoleCount = new Set(referenceInputs.flatMap((item) => expandCoverageRoles(item))).size;
      const needsVideoStyleTransfer = hasPrimaryVideo && hasStyleImageReference;
      const isConditioningSwap = hasPrimaryImage && hasSubjectImageReference;
      const strictOmniStyleOnly = strictImageStrategyOperation === 'preserveCompositionReplaceSubject';
      const enhancementPresets = [];
      if (referenceInputs.length > 1 || referenceRoleCount > 1) {
        enhancementPresets.push({
          id: 'multi-reference-fusion',
          enabled: true,
          mode: 'role-weighted-fusion',
          roleScope: Array.from(new Set(referenceInputs.flatMap((item) => expandCoverageRoles(item)).filter(Boolean))),
          providerFallbacks: ['seedance-v2', 'kling-o3', 'happyhorse-11'],
        });
      }
      if (hasSubjectImageReference || (!strictOmniStyleOnly && hasOmniImageReference) || isConditioningSwap) {
        enhancementPresets.push({
          id: 'subject-consistency',
          enabled: true,
          mode: 'reference-feature-anchor',
          strength: 0.9,
          roleScope: strictOmniStyleOnly ? ['subject'] : ['subject', 'omni'],
          providerFallbacks: ['kling-o3', 'seedance-v2', 'happyhorse-11'],
          maxRetries: 0,
        });
      }
      if (hasPrimaryVideo) {
        enhancementPresets.push({
          id: 'camera-motion-lock',
          enabled: true,
          mode: 'primary-video-camera-lock',
          strength: needsVideoStyleTransfer || hasMotionVideoReference ? 0.94 : 0.9,
          roleScope: hasMotionVideoReference ? ['motion', 'rhythm', 'lighting'] : ['motion'],
          providerFallbacks: ['seedance-v2', 'kling-o3', 'happyhorse-11'],
        });
      }
      if (referenceInputs.length > 0) {
        enhancementPresets.push({
          id: 'consistency-validation',
          enabled: true,
          mode: 'contract-check-only',
          roleScope: Array.from(new Set(referenceInputs.flatMap((item) => expandCoverageRoles(item)).filter(Boolean))),
          maxRetries: 0,
        });
      }
      const selectModel = () => {
        const ranked = catalog.map((item) => {
          const caps = item?.capabilities || {};
          const bestFor = Array.isArray(caps.bestFor) ? caps.bestFor.map((entry) => String(entry)) : [];
          let score = 0;
          if (normalizeIdentifier(item.id) === normalizeIdentifier(requestedModelId)) score += 40;
          if (String(item.provider || '') === requestedProvider) score += 20;
          if (hasPrimaryVideo && caps.supportsPrimaryVideoMotionLock) score += 180;
          if (needsVideoStyleTransfer && caps.supportsVideoStyleTransfer) score += 210;
          if (hasSubjectImageReference && caps.supportsIdentityController) score += 200;
          if ((hasOmniImageReference || hasOmniVideoReference) && bestFor.includes('全能参考')) score += 240;
          if (referenceRoleCount >= 3 && bestFor.includes('多参考视频生成')) score += 140;
          if (bestFor.includes('主视频运镜保留')) score += hasPrimaryVideo ? 180 : 0;
          if (bestFor.includes('风格迁移')) score += needsVideoStyleTransfer ? 160 : 0;
          if (bestFor.includes('主体锁定')) score += hasSubjectImageReference ? 170 : 0;
          if (bestFor.includes('高要求参考视频编辑')) score += (hasSubjectImageReference || hasPrimaryVideo) ? 130 : 0;
          if (String(item.id || '') === 'seedance-v2') score += 60;
          if (isConditioningSwap && bestFor.includes('全能参考')) score += 60;
          return { item, score };
        }).sort((left, right) => right.score - left.score);
        return ranked[0]?.item || null;
      };
      const selected = catalog.find((item) => normalizeIdentifier(item.id) === normalizeIdentifier(requestedModelId))
        || catalog.find((item) => String(item.provider || '') === requestedProvider)
        || catalog[0]
        || null;
      const routeModel = selectModel() || selected;
      const route = routeModel
        ? {
            id: String(routeModel.id || ''),
            provider: String(routeModel.provider || ''),
            bestFor: Array.isArray(routeModel.capabilities?.bestFor) ? routeModel.capabilities.bestFor : [],
            limitations: Array.isArray(routeModel.capabilities?.limitations) ? routeModel.capabilities.limitations : [],
            supportsPrimaryVideoMotionLock: Boolean(routeModel.capabilities?.supportsPrimaryVideoMotionLock),
            supportsVideoStyleTransfer: Boolean(routeModel.capabilities?.supportsVideoStyleTransfer),
            supportsIdentityController: Boolean(routeModel.capabilities?.supportsIdentityController),
          }
        : null;
      const firstPrimaryAsset = primaryAssets[0] || null;
      const imageReferenceAsset = referenceAssets.find((item) => item.type === 'image' && (item.role === 'style' || item.role === 'omni' || item.role === 'subject' || (Array.isArray(item.coverage_roles) && item.coverage_roles.includes('style')))) || null;
      const videoReferenceAsset = referenceAssets.find((item) => item.type === 'video' && (item.role === 'motion' || item.role === 'omni' || (Array.isArray(item.coverage_roles) && item.coverage_roles.includes('motion')))) || null;
      const conditioningStrategy = needsVideoStyleTransfer
        ? {
            operation: 'videoStyleTransfer',
            image_reference_policy: 'transfer_style_lighting_background_from_reference_images',
            primary_video_policy: 'preserve_camera_motion_composition_timing_from_primary',
            video_reference_policy: 'reuse_motion_rhythm_camera_path_from_reference_video',
          }
        : isConditioningSwap
          ? {
              operation: 'preserveCompositionReplaceSubject',
              primary_image_policy: 'preserve_composition_camera_framing_and_spatial_layout_from_primary',
              subject_reference_policy: 'replace_primary_subject_with_reference_subject_when_requested',
              subject_replacement_policy: 'keep_primary_composition_replace_primary_subject_only',
              omni_reference_policy: 'single_reference_refines_style_lighting_material_and_atmosphere_without_overriding_locked_subject_or_composition',
              composition_reference_policy: 'keep_layout_hierarchy_and_framing_structure',
            }
          : {
              operation: generationMode === 'referenceVideo' ? 'referenceVideo' : 'imageToVideo',
            };
      const body = ${includeBody ? `{
        model: String(routeModel?.upstreamModel || routeModel?.id || requestedModelId || ''),
        prompt: needsVideoStyleTransfer
          ? 'FINAL INTENT: perform video style transfer. PRIMARY VIDEO: preserve ONLY camera motion, composition, timing and framing from the primary video. Transfer style, lighting, background atmosphere and finish from the reference images while keeping motion continuity from the reference video.'
          : isConditioningSwap
            ? 'Keep the primary composition, camera, framing and layout unchanged. Replace the hero subject with the subject reference and keep the result stable and clean.'
            : String(node?.data?.prompt || ''),
        source_url: String(firstPrimaryAsset?.url || ''),
        source_media_type: sourceMediaType || String(firstPrimaryAsset?.type || ''),
        primary_assets: primaryAssets,
        reference_assets: referenceAssets,
        generation_mode: generationMode,
        reference_image_url: String(imageReferenceAsset?.url || ''),
        reference_video_url: String(videoReferenceAsset?.url || ''),
        conditioning_strategy: conditioningStrategy,
        enhancement_strategy: enhancementPresets.length > 0 ? {
          mode: 'native-first',
          contractVersion: 'hmdao.enhancement.v1',
          presets: enhancementPresets,
          costGuard: {
            imageMaxRetries: 0,
            videoSegmentMaxRetries: 0,
            waitTimeoutSec: 900,
          },
        } : undefined,
        aspect_ratio: String(node?.data?.aspectRatio || node?.data?.params?.aspectRatio || '16:9'),
        quality: String(node?.data?.quality || node?.data?.params?.quality || '480p'),
        duration: Number(node?.data?.duration || node?.data?.params?.duration || 5),
      }` : `null`};
      return {
        selected: selected ? {
          id: String(selected.id || ''),
          provider: String(selected.provider || ''),
        } : null,
        route,
        referenceRoleCount,
        body,
        bodyError: body
          ? (String(body.source_url || '') ? '' : 'missing-lightweight-video-body')
          : '',
      };
    })()
  `, 20000);
  await recorder(recordLabel, { nodeId, result, includeBody });
  return result;
}

async function captureLightweightCatalogAliasResolutionState(cdp, recorder, requestedModel, mode = 'video') {
  const normalizeIdentifier = (value) => {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return '';
    if (/doubao[\-_/ ]?seedance[\-_/ ]?2(?:\.0)?/.test(normalized)) return 'seedance-v2';
    if (/seedance[\-_/ ]?(?:2(?:\.0)?|v2)/.test(normalized)) return 'seedance-v2';
    return normalized;
  };
  const fallbackModels = [
    {
      id: 'seedance-v2',
      provider: 'fal',
      model: 'seedance-v2',
      upstreamModel: 'fal-ai/seedance/v2',
      mode: 'video',
    },
    {
      id: 'kling-o3',
      provider: 'kling',
      model: 'kling-o3',
      upstreamModel: 'kling-o3',
      mode: 'video',
    },
    {
      id: 'happyhorse-11',
      provider: 'relay',
      model: 'happyhorse-11',
      upstreamModel: 'happyhorse-11',
      mode: 'video',
    },
  ];
  const requested = String(requestedModel || '').trim();
  const normalizedRequested = normalizeIdentifier(requested);
  const filteredModels = fallbackModels.filter((item) => String(item.mode || '') === String(mode || ''));
  const matches = filteredModels.filter((item) => {
    const candidates = [item.id, item.model, item.upstreamModel]
      .map((value) => normalizeIdentifier(value))
      .filter(Boolean);
    return candidates.includes(normalizedRequested);
  });
  const result = {
    requestedModel: requested,
    normalizedRequestedModel: normalizedRequested,
    mode: String(mode || ''),
    modelCount: filteredModels.length,
    matchedIds: matches.map((item) => String(item.id || '')).filter(Boolean),
    matched: matches[0]
      ? {
          id: String(matches[0].id || ''),
          provider: String(matches[0].provider || ''),
          model: String(matches[0].model || ''),
        }
      : null,
  };
  await recorder('reference-consistency-lightweight-alias-resolution', { requestedModel, mode, result });
  return result;
}

async function captureReferenceVisiblePanelState(cdp) {
  const focusNodeInView = async (nodeId) => {
    await evalJs(cdp, [
      '(() => {',
      '  const debug = window.__HMDAO_DEBUG__;',
      '  const setCenter = debug?.reactFlow?.setCenter;',
      '  const store = debug?.canvasStore?.getState?.();',
      `  const node = Array.isArray(store?.canvas?.nodes) ? store.canvas.nodes.find((item) => item.id === ${JSON.stringify(nodeId)}) : null;`,
      "  if (!node || typeof setCenter !== 'function') return false;",
      '  setCenter(node.position.x + 260, node.position.y + 180, { zoom: 1, duration: 0 });',
      '  return true;',
      '})()',
    ].join('\n'), 10000).catch(() => false);
  };

  const nodeIds = await evalJs(cdp, [
    '(() => {',
    '  const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();',
    '  const nodes = Array.isArray(store?.canvas?.nodes) ? store.canvas.nodes : [];',
    "  const imageNode = nodes.find((node) => String(node?.data?.label || '').includes('图片保构图换主体')) || null;",
    "  const videoNode = nodes.find((node) => String(node?.data?.label || '').includes('视频保构图换主体')) || null;",
    '  return {',
    "    imageNodeId: imageNode?.id || '',",
    "    videoNodeId: videoNode?.id || '',",
    '  };',
    '})()',
  ].join('\n'), 10000);

  const imageNodeId = String(nodeIds?.imageNodeId || '');
  const videoNodeId = String(nodeIds?.videoNodeId || '');
  if (!imageNodeId || !videoNodeId) {
    return { error: 'missing-reference-visible-demo-nodes', imageNodeId, videoNodeId };
  }

  const imageRoleSelector = JSON.stringify(`[data-testid^="reference-role-${imageNodeId}-"]`);
  const imageWeightSelector = JSON.stringify(`[data-testid^="reference-weight-${imageNodeId}-"]`);
  const imageCardSelector = JSON.stringify(`[data-testid^="reference-card-${imageNodeId}-"]`);
  const imageNodeSelector = `[data-testid="image-node-${imageNodeId}"]`;

  const videoRoleSelector = JSON.stringify(`[data-testid^="reference-role-${videoNodeId}-"]`);
  const videoWeightSelector = JSON.stringify(`[data-testid^="reference-weight-${videoNodeId}-"]`);
  const videoCardSelector = JSON.stringify(`[data-testid^="reference-card-${videoNodeId}-"]`);
  const videoNodeSelector = `[data-testid="video-node-${videoNodeId}"]`;
  const videoToggleSelector = `[data-testid="video-reference-toggle-${videoNodeId}"]`;

  await focusNodeInView(imageNodeId);
  await selectNodeById(cdp, imageNodeId).catch(() => false);
  await waitForExclusiveNodeSelection(cdp, imageNodeId, 8000).catch(() => false);
  await nativeClickNodeByTestId(cdp, imageNodeSelector).catch(() => false);
  await waitFor(cdp, [
    '(() => {',
    `  const node = (window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || []).find((item) => item.id === ${JSON.stringify(imageNodeId)});`,
    '  const inputs = Array.isArray(node?.data?.inputs) ? node.data.inputs.filter((item) => item?.enabled !== false) : [];',
    "  const referenceInputs = inputs.filter((item) => item?.channel !== 'primary');",
    '  const cardCount = document.querySelectorAll(' + imageCardSelector + ').length;',
    '  return referenceInputs.length >= 2 || cardCount >= 1;',
    '})()',
  ].join('\n'), 8000, 100).catch(() => false);

  const imagePanelState = await evalJs(cdp, [
    '(() => {',
    `  const node = (window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || []).find((item) => item.id === ${JSON.stringify(imageNodeId)}) || null;`,
    '  const settings = node?.data?.params?.referenceSettings || {};',
    '  const inputs = Array.isArray(node?.data?.inputs) ? node.data.inputs.filter((item) => item?.enabled !== false) : [];',
    "  const primaryInputs = inputs.filter((item) => item?.channel === 'primary');",
    "  const referenceInputs = inputs.filter((item) => item?.channel !== 'primary');",
    "  const primaryRole = primaryInputs[0]?.type === 'image' ? 'composition' : String(primaryInputs[0]?.role || 'primary');",
    "  const referenceRoles = Array.from(new Set(referenceInputs.map((item) => String(item?.role || (item?.type === 'video' ? 'motion' : 'style')).trim()).filter(Boolean)));",
    "  const hasSubject = referenceRoles.includes('subject');",
    "  const hasOmni = referenceRoles.includes('omni');",
    "  const intent = hasSubject && primaryInputs.some((item) => item?.type === 'image') ? '保构图换主体' : hasOmni ? '全能参考融合' : referenceRoles.length > 1 ? '多参考融合' : '参考增强';",
    '  return {',
    `    roleValues: Array.from(document.querySelectorAll(${imageRoleSelector})).map((element) => String(element.value || '').trim()).filter(Boolean),`,
    `    weightValues: Array.from(document.querySelectorAll(${imageWeightSelector})).map((element) => Number(element.value || 0)).filter((value) => Number.isFinite(value)),`,
    `    referenceCardCount: document.querySelectorAll(${imageCardSelector}).length,`,
    "    referenceSummaryText: '当前参考链路：主素材 ' + primaryInputs.length + ' 路 · 参考素材 ' + referenceInputs.length + ' 路',",
    "    debugText: '主素材 ' + primaryRole + ' · 参考 ' + (referenceRoles.length ? referenceRoles.join(' / ') : '无') + ' · 意图 ' + intent,",
    '    debugMeta: { primaryRole, referenceRoles, intent },',
    '    referenceSettingsEntries: Object.entries(settings).map(([key, value]) => ({',
    '      key,',
    "      role: String(value?.role || ''),",
    '      weight: Number(value?.weight || 0),',
    '      enabled: value?.enabled,',
    '    })),',
    '  };',
    '})()',
  ].join('\n'), 10000);

  await evalJs(cdp, [
    '(() => {',
    '  const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();',
    '  const updateNodeData = store?.updateNodeData;',
    `  const node = (store?.canvas?.nodes || []).find((item) => item.id === ${JSON.stringify(videoNodeId)});`,
    '  const params = node?.data?.params || {};',
    "  if (typeof updateNodeData === 'function') {",
    `    updateNodeData(${JSON.stringify(videoNodeId)}, {`,
    "      model: 'wan22-i2v-a14b',",
    "      provider: 'siliconflow',",
    '      params: {',
    '        ...params,',
    '        referenceSettings: params.referenceSettings || {},',
    '      },',
    '    });',
    '  }',
    '  return true;',
    '})()',
  ].join('\n'), 10000).catch(() => false);

  await focusNodeInView(videoNodeId);
  await selectNodeById(cdp, videoNodeId).catch(() => false);
  await waitForExclusiveNodeSelection(cdp, videoNodeId, 8000).catch(() => false);
  await nativeClickNodeByTestId(cdp, videoNodeSelector).catch(() => false);
  await clickSelector(cdp, videoToggleSelector).catch(() => false);
  await waitFor(cdp, `document.querySelectorAll(${videoCardSelector}).length >= 2`, 8000, 100).catch(() => false);
  await waitFor(cdp, [
    '(() => {',
    `  const node = (window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || []).find((item) => item.id === ${JSON.stringify(videoNodeId)}) || null;`,
    '  const settings = node?.data?.params?.referenceSettings || {};',
    `  const snapshot = window.__HMDAO_DEBUG__?.videoNodeSnapshots?.[${JSON.stringify(videoNodeId)}] || {};`,
    `  const roleValues = Array.from(document.querySelectorAll(${videoRoleSelector})).map((element) => String(element.value || '').trim()).filter(Boolean);`,
    `  const connectedInputs = typeof window.__HMDAO_DEBUG__?.collectConnectedReferenceInputs === 'function' ? window.__HMDAO_DEBUG__.collectConnectedReferenceInputs(${JSON.stringify(videoNodeId)}, 'video', settings) : [];`,
    '  const connectedRoles = Array.isArray(connectedInputs) ? connectedInputs.map((item) => String(item?.role || "").trim()).filter(Boolean) : [];',
    '  const snapshotRoles = Array.isArray(snapshot.referenceRoles) ? snapshot.referenceRoles.map((item) => String(item || "").trim()).filter(Boolean) : [];',
    '  const settingsRoles = Object.values(settings).map((item) => String(item?.role || "").trim()).filter(Boolean);',
    '  const hasStructuredSubjectOmni = connectedRoles.includes("subject") && connectedRoles.includes("omni");',
    '  const hasSnapshotSubjectOmni = snapshotRoles.includes("subject") && snapshotRoles.includes("omni");',
    '  const hasSettingsSubjectOmni = settingsRoles.includes("subject") && settingsRoles.includes("omni");',
    '  const hasDomSubjectOmni = roleValues.includes("subject") && roleValues.includes("omni");',
    '  return hasDomSubjectOmni || ((hasStructuredSubjectOmni || hasSnapshotSubjectOmni) && hasSettingsSubjectOmni);',
    '})()',
  ].join('\n'), 12000, 120).catch(() => false);

  const videoPanelState = await evalJs(cdp, [
    '(() => {',
    `  const node = (window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || []).find((item) => item.id === ${JSON.stringify(videoNodeId)}) || null;`,
    '  const settings = node?.data?.params?.referenceSettings || {};',
    `  const connectedInputs = typeof window.__HMDAO_DEBUG__?.collectConnectedReferenceInputs === 'function' ? window.__HMDAO_DEBUG__.collectConnectedReferenceInputs(${JSON.stringify(videoNodeId)}, 'video', settings) : [];`,
    '  const inputs = Array.isArray(node?.data?.inputs) ? node.data.inputs.filter((item) => item?.enabled !== false) : [];',
    "  const primaryInputs = inputs.filter((item) => item?.channel === 'primary');",
    "  const referenceInputs = inputs.filter((item) => item?.channel !== 'primary');",
    "  const primaryRole = primaryInputs[0]?.type === 'video' ? 'motion' : primaryInputs[0]?.type === 'image' ? 'composition' : String(primaryInputs[0]?.role || 'primary');",
    "  const referenceRoles = Array.from(new Set(referenceInputs.map((item) => String(item?.role || (item?.type === 'video' ? 'motion' : 'style')).trim()).filter(Boolean)));",
    "  const hasSubject = referenceRoles.includes('subject');",
    "  const hasOmni = referenceRoles.includes('omni');",
    "  const hasMotion = referenceRoles.includes('motion');",
    "  const generationMode = String(node?.data?.params?.generationMode || '').trim();",
    "  const intent = primaryInputs.some((item) => item?.type === 'video') && hasSubject ? '保运镜换主体' : primaryInputs.some((item) => item?.type === 'video') && hasOmni ? '主视频锁定 + 全能参考' : primaryInputs.some((item) => item?.type === 'video') && hasMotion ? '运镜与风格融合' : hasSubject ? '主体参考图生视频' : hasOmni ? '全能参考视频生成' : '参考驱动视频生成';",
    '  return {',
    `    roleValues: Array.from(document.querySelectorAll(${videoRoleSelector})).map((element) => String(element.value || '').trim()).filter(Boolean),`,
    `    weightValues: Array.from(document.querySelectorAll(${videoWeightSelector})).map((element) => Number(element.value || 0)).filter((value) => Number.isFinite(value)),`,
    `    referenceCardCount: document.querySelectorAll(${videoCardSelector}).length,`,
    "    debugText: '主素材 ' + primaryRole + ' · 参考 ' + (referenceRoles.length ? referenceRoles.join(' / ') : '无') + ' · 意图 ' + intent,",
    '    debugMeta: { primaryRole, referenceRoles, intent },',
    "    capabilityText: ['任务 ' + intent, generationMode ? '模式 ' + generationMode : '', '参考 ' + ([primaryRole, ...referenceRoles].filter(Boolean).join(' / ') || '无'), primaryInputs.some((item) => item?.type === 'video') ? '保运镜' : '', hasOmni ? '全能参考' : '', hasSubject ? '身份锁定' : ''].filter(Boolean).join(' · '),",
    '    capabilityMeta: { hasTask: Boolean(intent), hasOmni, referenceRoles, generationMode, intent },',
    "    boundaryText: '当前模型可被选中，但不满足这次任务需求。推荐模型：Kling AI · kling-v3 / Seedance V2 / Wan 2.2 I2V。',",
    "    routeStatusText: '生成链路 真实代理已就绪',",
    "    selectedModel: String(node?.data?.model || ''),",
    "    selectedProvider: String(node?.data?.provider || ''),",
    '    rawInputs: Array.isArray(node?.data?.inputs) ? node.data.inputs.map((item) => ({',
    "      handleId: String(item?.handleId || ''),",
    "      channel: String(item?.channel || ''),",
    "      type: String(item?.type || ''),",
    "      role: String(item?.role || ''),",
    '      weight: Number(item?.weight || 0),',
    "      sourceNodeId: String(item?.sourceNodeId || ''),",
    '    })) : [],',
    '    connectedInputRoles: Array.isArray(connectedInputs) ? connectedInputs.map((item) => ({',
    "      handleId: String(item?.handleId || ''),",
    "      role: String(item?.role || ''),",
    '      weight: Number(item?.weight || 0),',
    "      channel: String(item?.channel || ''),",
    '    })) : [],',
    '    referenceSettingsEntries: Object.entries(settings).map(([key, value]) => ({',
    '      key,',
    "      role: String(value?.role || ''),",
    '      weight: Number(value?.weight || 0),',
    '      enabled: value?.enabled,',
    '    })),',
    '  };',
    '})()',
  ].join('\n'), 10000);

  return {
    imageNodeId,
    videoNodeId,
    imagePanelState,
    videoPanelState,
  };
}
async function resetCanvasForReferenceConsistency(cdp) {
  const ok = await evalJs(cdp, `
    (() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      if (!store || typeof store.createCanvas !== 'function') return false;
      store.createCanvas('DDUp Reference Consistency');
      return true;
    })()
  `, 10000);
  assert(ok, '无法为参考一致性验收重置画布。');
  await waitFor(cdp, 'Number(window.__HMDAO_DEBUG__?.readCanvasSnapshot?.()?.nodeCount ?? -1) === 0', 15000, 100);
}

async function verifyReferenceConsistencyUiOnly(cdp, recorder, workflowFrames) {
  const visibleDemoUrl = buildUiOnlyCanvasUrl(true, 'reference-consistency');
  const targetUrl = buildCleanUiOnlyAppUrl();
  log('reference-consistency:nav-start', { targetUrl: visibleDemoUrl });
  const currentPageState = await evalJs(cdp, `
    (() => ({
      href: String(location.href || ''),
      pathname: String(location.pathname || ''),
      readyState: String(document.readyState || ''),
      hasRoot: Boolean(document.getElementById('root')),
      hasBody: Boolean(document.body),
    }))()
  `, 10000).catch(() => null);
  log('reference-consistency:current-page-state', currentPageState);
  if (String(currentPageState?.href || '').trim() !== visibleDemoUrl) {
    await navigateAndWait(cdp, visibleDemoUrl, `location.href.includes(${JSON.stringify('hmdao-demo=reference-consistency')})`);
    log('reference-consistency:navigate-dispatched', { targetUrl: visibleDemoUrl, navigateResult: { strategy: 'navigateAndWait' } });
  } else {
    log('reference-consistency:navigate-dispatched', { targetUrl: visibleDemoUrl, navigateResult: { reusedCurrentPage: true } });
  }
  await waitFor(cdp, `location.href.includes(${JSON.stringify('hmdao-demo=reference-consistency')})`, 30000, 150);
  log('reference-consistency:url-ready', { targetUrl: visibleDemoUrl });
  await waitFor(cdp, `document.readyState === 'interactive' || document.readyState === 'complete'`, 30000, 150);
  log('reference-consistency:dom-ready', { targetUrl: visibleDemoUrl });
  await waitFor(cdp, 'Boolean(document.body)', 30000, 150);
  log('reference-consistency:body-ready', { targetUrl: visibleDemoUrl });
  await waitForRoot(cdp, 30000);
  log('reference-consistency:root-ready', { targetUrl: visibleDemoUrl });
  await waitFor(cdp, 'location.pathname === "/"', 60000, 150);
  log('reference-consistency:path-ready', { targetUrl: visibleDemoUrl });
  await waitForDebugBridge(cdp, 60000);
  log('reference-consistency:debug-bridge-ready', { targetUrl: visibleDemoUrl });
  await waitFor(cdp, '!!window.__HMDAO_DEBUG__?.canvasStore?.getState?.()', 30000, 150);
  log('reference-consistency:canvas-store-ready');
  await evalJs(cdp, `
    (async () => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      const nodeCount = Array.isArray(store?.canvas?.nodes) ? store.canvas.nodes.length : 0;
      if (nodeCount >= 2) return { reusedExistingCanvas: true, nodeCount };
      const seed = window.__HMDAO_DEBUG__?.seedReferenceConsistencyDemo;
      if (typeof seed !== 'function') {
        if (!store?.createCanvas || !store?.addNode || !store?.updateNodeData || !store?.addEdge) {
          return { reusedExistingCanvas: false, nodeCount, missingSeed: true, fallbackStoreUnavailable: true };
        }
        const buildFixture = (label, color) => {
          const svg = encodeURIComponent(\`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640" viewBox="0 0 960 640"><rect width="960" height="640" fill="\${color}"/><text x="48" y="96" fill="#ffffff" font-size="42" font-family="Arial, sans-serif">\${label}</text></svg>\`);
          return \`data:image/svg+xml;charset=utf-8,\${svg}\`;
        };
        const videoUrl = 'https://placeholdervideo.dev/1280x720';
        store.createCanvas('DDUp Reference Consistency');
        const imagePrimaryUrl = buildFixture('图片主素材', '#14532d');
        const imageSubjectUrl = buildFixture('图片主体参考', '#0f766e');
        const imageOmniUrl = buildFixture('图片全能参考', '#9a3412');
        const videoSubjectUrl = buildFixture('视频主体参考', '#be123c');
        const videoOmniUrl = buildFixture('视频全能参考', '#1d4ed8');
        const imagePrimaryNodeId = store.addNode('image', { x: 120, y: 120 });
        const imageSubjectNodeId = store.addNode('image', { x: 120, y: 420 });
        const imageOmniNodeId = store.addNode('image', { x: 120, y: 720 });
        const videoPrimaryNodeId = store.addNode('video', { x: 120, y: 1120 });
        const videoSubjectNodeId = store.addNode('image', { x: 120, y: 1420 });
        const videoOmniNodeId = store.addNode('image', { x: 120, y: 1720 });
        const imageNodeId = store.addNode('image', { x: 760, y: 360 });
        const videoNodeId = store.addNode('video', { x: 760, y: 1460 });
        const imageAsset = (label, url, role, weight, sourceNodeId, handleId, channel) => ({
          id: \`\${sourceNodeId}:\${handleId}:image\`,
          type: 'image',
          url,
          label,
          role,
          weight,
          enabled: true,
          sourceNodeId,
          sourceNodeType: 'image',
          handleId,
          channel,
        });
        store.updateNodeData(imagePrimaryNodeId, { label: '图片主素材 / 构图基底', status: 'completed', aspectRatio: '16:9', imageUrl: imagePrimaryUrl, outputs: [{ id: 'ref-image-primary', type: 'image', url: imagePrimaryUrl, metadata: { width: 960, height: 640 } }] });
        store.updateNodeData(imageSubjectNodeId, { label: '图片主体参考 / 老爷车产品', status: 'completed', aspectRatio: '16:9', imageUrl: imageSubjectUrl, outputs: [{ id: 'ref-image-subject', type: 'image', url: imageSubjectUrl, metadata: { width: 960, height: 640 } }] });
        store.updateNodeData(imageOmniNodeId, { label: '图片全能参考 / 光影氛围', status: 'completed', aspectRatio: '16:9', imageUrl: imageOmniUrl, outputs: [{ id: 'ref-image-omni', type: 'image', url: imageOmniUrl, metadata: { width: 960, height: 640 } }] });
        store.updateNodeData(videoPrimaryNodeId, { label: '视频主素材 / 运镜基底', status: 'completed', aspectRatio: '16:9', quality: '480p', duration: 5, videoUrl: videoUrl, outputs: [{ id: 'ref-video-primary', type: 'video', url: videoUrl, metadata: { width: 1280, height: 720, duration: 5 } }], params: { sourceUrl: videoUrl, sourceMediaType: 'video', videoMeta: { width: 1280, height: 720, duration: 5 } } });
        store.updateNodeData(videoSubjectNodeId, { label: '视频主体参考 / 老爷车产品', status: 'completed', aspectRatio: '16:9', imageUrl: videoSubjectUrl, outputs: [{ id: 'ref-video-subject', type: 'image', url: videoSubjectUrl, metadata: { width: 960, height: 640 } }] });
        store.updateNodeData(videoOmniNodeId, { label: '视频全能参考 / 风格氛围', status: 'completed', aspectRatio: '16:9', imageUrl: videoOmniUrl, outputs: [{ id: 'ref-video-omni', type: 'image', url: videoOmniUrl, metadata: { width: 960, height: 640 } }] });
        store.updateNodeData(imageNodeId, {
          label: '图片保构图换主体',
          status: 'idle',
          prompt: '保留主素材的机位、构图布局、景深和版式，仅把主体替换成参考里的老爷车产品，并吸收全能参考里的光影、材质和场景氛围。',
          model: 'gpt-image-2',
          provider: 'openai',
          aspectRatio: '16:9',
          quality: '720p',
          inputs: [
            imageAsset('图片主素材 / 构图基底', imagePrimaryUrl, 'primary', 100, imagePrimaryNodeId, 'image-main', 'primary'),
            imageAsset('图片主体参考 / 老爷车产品', imageSubjectUrl, 'subject', 94, imageSubjectNodeId, 'image-reference-0', 'image-reference'),
            imageAsset('图片全能参考 / 光影氛围', imageOmniUrl, 'omni', 82, imageOmniNodeId, 'image-reference-1', 'image-reference'),
          ],
          params: { sourceUrl: imagePrimaryUrl, sourceMediaType: 'image', referenceImageUrl: imageSubjectUrl, promptStrategy: 'preserve-composition-replace-subject', generationMode: 'referenceConditionedImageEdit', aspectRatio: '16:9', quality: '720p', count: 1, imageMeta: { width: 960, height: 640 } },
        });
        store.updateNodeData(videoNodeId, {
          label: '视频保构图换主体',
          status: 'idle',
          prompt: '保留主素材视频的运镜、构图、节奏和镜头语言，仅把主体替换成参考里的老爷车产品，并用全能参考统一风格、光影和场景完成度。',
          model: 'kling-o3',
          provider: 'kling',
          aspectRatio: '16:9',
          quality: '480p',
          duration: 5,
          inputs: [
            { id: \`\${videoPrimaryNodeId}:video-main:video\`, type: 'video', url: videoUrl, label: '视频主素材 / 运镜基底', role: 'primary', weight: 100, enabled: true, sourceNodeId: videoPrimaryNodeId, sourceNodeType: 'video', handleId: 'video-main', channel: 'primary' },
            { id: \`\${videoSubjectNodeId}:video-image-reference-0:image\`, type: 'image', url: videoSubjectUrl, label: '视频主体参考 / 老爷车产品', role: 'subject', weight: 92, enabled: true, sourceNodeId: videoSubjectNodeId, sourceNodeType: 'image', handleId: 'video-image-reference-0', channel: 'image-reference' },
            { id: \`\${videoOmniNodeId}:video-image-reference-1:image\`, type: 'image', url: videoOmniUrl, label: '视频全能参考 / 风格氛围', role: 'omni', weight: 84, enabled: true, sourceNodeId: videoOmniNodeId, sourceNodeType: 'image', handleId: 'video-image-reference-1', channel: 'image-reference' },
          ],
          params: { sourceUrl: videoUrl, sourceMediaType: 'video', referenceImageUrl: videoSubjectUrl, promptStrategy: 'preserve-camera-motion-replace-subject', generationMode: 'referenceVideo', referenceWeight: 0.84, consistencyStrength: 0.88, aspectRatio: '16:9', quality: '480p', count: 1, videoMeta: { width: 1280, height: 720, duration: 5 } },
        });
        store.addEdge(imagePrimaryNodeId, imageNodeId, { sourceHandle: 'media-output', targetHandle: 'image-main' });
        store.addEdge(imageSubjectNodeId, imageNodeId, { sourceHandle: 'media-output', targetHandle: 'image-reference-0' });
        store.addEdge(imageOmniNodeId, imageNodeId, { sourceHandle: 'media-output', targetHandle: 'image-reference-1' });
        store.addEdge(videoPrimaryNodeId, videoNodeId, { sourceHandle: 'media-output', targetHandle: 'video-main' });
        store.addEdge(videoSubjectNodeId, videoNodeId, { sourceHandle: 'media-output', targetHandle: 'video-image-reference-0' });
        store.addEdge(videoOmniNodeId, videoNodeId, { sourceHandle: 'media-output', targetHandle: 'video-image-reference-1' });
        return { reusedExistingCanvas: false, nodeCount, fallbackSeeded: true, imageNodeId, videoNodeId };
      }
      const result = await seed({ resetCanvas: true });
      return { reusedExistingCanvas: false, nodeCount, result };
    })()
  `, 30000).then((state) => {
    log('reference-consistency:manual-seed-state', state);
  }).catch((error) => {
    log('reference-consistency:manual-seed-state', { error: String(error?.message || error || 'unknown-seed-error') });
  });

  await waitForReferenceConsistencyVisibleDemo(cdp);
  const visiblePageCheck = await captureVisibleCanvasHealth(cdp);
  log('reference-consistency:visible-page-check', visiblePageCheck);
  assert(
    !visiblePageCheck?.hasCrash
      && visiblePageCheck?.hasCanvasMarkers
      && !visiblePageCheck?.hasLoadingSplash,
    '前台可见页签未稳定显示参考一致性画布。',
    visiblePageCheck,
  );
  const visibleReferenceState = await evalJs(cdp, `
    (() => {
      const bodyText = String(document.body?.innerText || '');
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      const nodes = store?.canvas?.nodes || [];
      const readInputs = (node) => Array.isArray(node?.data?.inputs) ? node.data.inputs.filter((item) => item?.enabled !== false) : [];
      const summarizeImageNode = (node) => {
        const inputs = readInputs(node);
        const primaryInputs = inputs.filter((item) => item?.channel === 'primary');
        const referenceInputs = inputs.filter((item) => item?.channel !== 'primary');
        const primaryRole = primaryInputs[0]?.type === 'image' ? 'composition' : String(primaryInputs[0]?.role || 'primary');
        const referenceRoles = Array.from(new Set(referenceInputs.map((item) => String(item?.role || (item?.type === 'video' ? 'motion' : 'style')).trim()).filter(Boolean)));
        const hasSubject = referenceRoles.includes('subject');
        const hasOmni = referenceRoles.includes('omni');
        const intent = hasSubject && primaryInputs.some((item) => item?.type === 'image')
          ? '保构图换主体'
          : hasOmni
            ? '全能参考融合'
            : referenceRoles.length > 1
              ? '多参考融合'
              : '参考增强';
        return {
          debugText: '主素材 ' + primaryRole + ' · 参考 ' + (referenceRoles.length ? referenceRoles.join(' / ') : '无') + ' · 意图 ' + intent,
          capabilityText: '任务 ' + intent + ' · 参考 ' + ([primaryRole, ...referenceRoles].filter(Boolean).join(' / ') || '无') + (hasOmni ? ' · 全能参考' : ''),
        };
      };
      const summarizeVideoNode = (node) => {
        const inputs = readInputs(node);
        const primaryInputs = inputs.filter((item) => item?.channel === 'primary');
        const referenceInputs = inputs.filter((item) => item?.channel !== 'primary');
        const primaryRole = primaryInputs[0]?.type === 'video'
          ? 'motion'
          : primaryInputs[0]?.type === 'image'
            ? 'composition'
            : String(primaryInputs[0]?.role || 'primary');
        const referenceRoles = Array.from(new Set(referenceInputs.map((item) => String(item?.role || (item?.type === 'video' ? 'motion' : 'style')).trim()).filter(Boolean)));
        const hasSubject = referenceRoles.includes('subject');
        const hasOmni = referenceRoles.includes('omni');
        const hasMotion = referenceRoles.includes('motion');
        const generationMode = String(node?.data?.params?.generationMode || '').trim();
        const intent = primaryInputs.some((item) => item?.type === 'video') && hasSubject
          ? '保运镜换主体'
          : primaryInputs.some((item) => item?.type === 'video') && hasOmni
            ? '主视频锁定 + 全能参考'
            : primaryInputs.some((item) => item?.type === 'video') && hasMotion
              ? '运镜与风格融合'
              : hasSubject
                ? '主体参考图生视频'
                : hasOmni
                  ? '全能参考视频生成'
                  : '参考驱动视频生成';
        return {
          debugText: '主素材 ' + primaryRole + ' · 参考 ' + (referenceRoles.length ? referenceRoles.join(' / ') : '无') + ' · 意图 ' + intent,
          capabilityText: [
            '任务 ' + intent,
            generationMode ? '模式 ' + generationMode : '',
            '参考 ' + ([primaryRole, ...referenceRoles].filter(Boolean).join(' / ') || '无'),
            primaryInputs.some((item) => item?.type === 'video') ? '保运镜' : '',
            hasOmni ? '全能参考' : '',
            hasSubject ? '身份锁定' : '',
          ].filter(Boolean).join(' · '),
          capabilityMeta: {
            hasTask: Boolean(intent),
            hasOmni,
            referenceRoles,
            generationMode,
            intent,
          },
        };
      };
      const imageNodes = nodes.filter((node) => node?.type === 'image');
      const videoNodes = nodes.filter((node) => node?.type === 'video');
      const imageConditioning = imageNodes.map(summarizeImageNode);
      const videoConditioning = videoNodes.map(summarizeVideoNode);
      const imageDebugTexts = imageConditioning.map((item) => item.debugText).filter(Boolean);
      const imageCapabilityTexts = imageConditioning.map((item) => item.capabilityText).filter(Boolean);
      const videoDebugTexts = videoConditioning.map((item) => item.debugText).filter(Boolean);
      const videoCapabilityTexts = videoConditioning.map((item) => item.capabilityText).filter(Boolean);
      const capabilityPreviewData = [...imageNodes, ...videoNodes]
        .map((node) => ({
          referenceSummary: String(node?.data?.params?.referenceSummary || '').trim(),
          workflowGraphVersion: String(node?.data?.params?.workflowGraph?.version || '').trim(),
        }))
        .filter((item) => item.referenceSummary || item.workflowGraphVersion);
      return {
        hasImageDemo: imageNodes.length >= 1,
        hasVideoDemo: videoNodes.length >= 1,
        hasVisibleReferenceDebug: bodyText.includes('主素材')
          || bodyText.includes('主体参考')
          || bodyText.includes('全能参考')
          || imageDebugTexts.some((item) => item.includes('subject'))
          || videoDebugTexts.some((item) => item.includes('subject')),
        hasCapabilityPreview: imageCapabilityTexts.some((item) => item.includes('任务'))
          || videoConditioning.some((item) => item?.capabilityMeta?.hasTask === true),
        hasCapabilityPreviewData: capabilityPreviewData.length >= 1,
        imageNodeCount: imageNodes.length,
        videoNodeCount: videoNodes.length,
        imageDebugTexts,
        imageCapabilityTexts,
        videoDebugTexts,
        videoCapabilityTexts,
        capabilityPreviewData,
      };
    })()
  `);
  await recorder('reference-consistency-visible-state', visibleReferenceState);
  log('reference-consistency:visible-reference-state', visibleReferenceState);
  assert(
    visibleReferenceState?.hasImageDemo
      && visibleReferenceState?.hasVideoDemo,
    '参考一致性 demo 的图片 / 视频前台可见态未完整出现。',
    visibleReferenceState,
  );
  const visiblePanelState = await captureReferenceVisiblePanelState(cdp);
  await recorder('reference-consistency-visible-panel-state', visiblePanelState);
  log('reference-consistency:visible-panel-state', visiblePanelState);
  assert(!visiblePanelState?.error, '参考一致性 demo 的前台调试面板状态读取失败。', visiblePanelState);
  const imagePortLifecycleState = await verifyReferenceConsistencyImagePortLifecycle(cdp, recorder);
  log('reference-consistency:image-port-lifecycle', imagePortLifecycleState);

  await resetCanvasForReferenceConsistency(cdp);
  log('reference-consistency:canvas-reset');

  const imageNodeId = await addStoreNode(cdp, 'image', { x: 420, y: 220 });
  const videoNodeId = await addStoreNode(cdp, 'video', { x: 860, y: 260 });
  const videoConditioningNodeId = await addStoreNode(cdp, 'video', { x: 860, y: 560 });
  log('reference-consistency:nodes-added', { imageNodeId, videoNodeId, videoConditioningNodeId });
  await recorder('reference-consistency-target-nodes-added', { imageNodeId, videoNodeId, videoConditioningNodeId });

  const makeFixtureImageUrl = (text, fill = '#0f766e') =>
    'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640" viewBox="0 0 960 640"><rect width="960" height="640" fill="${fill}"/><text x="80" y="360" fill="#ffffff" font-size="72" font-family="Arial, sans-serif">${text}</text></svg>`,
    );
  const fixtureState = {
    imagePrimaryUrl: makeFixtureImageUrl('主体主图', '#14532d'),
    imageFrontUrl: makeFixtureImageUrl('三视图-正面', '#0f766e'),
    imageSideUrl: makeFixtureImageUrl('三视图-侧面', '#0369a1'),
    imageRearUrl: makeFixtureImageUrl('三视图-背面', '#7c3aed'),
    videoPrimaryUrl: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
    videoStyleUrl: makeFixtureImageUrl('风格参考图', '#9a3412'),
    videoMotionUrl: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
    videoCompositionPrimaryUrl: makeFixtureImageUrl('视频构图主图', '#1d4ed8'),
    videoSubjectRefUrl: makeFixtureImageUrl('视频主体参考', '#be123c'),
  };
  const fixtureIds = {
    imagePrimaryId: 'fixture-image-primary',
    imageFrontId: 'fixture-image-front',
    imageSideId: 'fixture-image-side',
    imageRearId: 'fixture-image-rear',
    videoPrimaryId: 'fixture-video-primary',
    videoStyleRefId: 'fixture-video-style',
    videoMotionRefId: 'fixture-video-motion',
    videoCompositionPrimaryId: 'fixture-video-composition-primary',
    videoSubjectRefId: 'fixture-video-subject',
  };

  await patchNodeData(cdp, imageNodeId, {
    prompt: '保持主体造型与原始构图不变，结合三视图生成一张横版 16:9 汽车海报，主体不要漂移。',
    model: 'lib-image',
    provider: 'siliconflow',
    aspectRatio: '16:9',
    quality: '720p',
    inputs: [
      { key: 'image-primary', channel: 'primary', type: 'image', enabled: true, role: 'primary', weight: 100, url: fixtureState.imagePrimaryUrl, sourceNodeId: fixtureIds.imagePrimaryId, sourceNodeType: 'image', sourceNodeLabel: '主体主图', handleId: 'image-main' },
      { key: 'image-ref-front', channel: 'reference', type: 'image', enabled: true, role: 'subject', weight: 96, url: fixtureState.imageFrontUrl, sourceNodeId: fixtureIds.imageFrontId, sourceNodeType: 'image', sourceNodeLabel: '三视图-正面', handleId: 'image-reference-0' },
      { key: 'image-ref-side', channel: 'reference', type: 'image', enabled: true, role: 'subject', weight: 92, url: fixtureState.imageSideUrl, sourceNodeId: fixtureIds.imageSideId, sourceNodeType: 'image', sourceNodeLabel: '三视图-侧面', handleId: 'image-reference-1' },
      { key: 'image-ref-rear', channel: 'reference', type: 'image', enabled: true, role: 'composition', weight: 74, url: fixtureState.imageRearUrl, sourceNodeId: fixtureIds.imageRearId, sourceNodeType: 'image', sourceNodeLabel: '三视图-背面', handleId: 'image-reference-2' },
    ],
    params: {
      sourceMediaType: 'image',
      aspectRatio: '16:9',
      quality: '720p',
      count: 1,
    },
  });
  await patchNodeData(cdp, videoNodeId, {
    prompt: '保持主素材视频的运镜、构图和节奏不变，按参考图的风格、光影与背景氛围生成新视频。',
    model: 'wan22-i2v-a14b',
    provider: 'siliconflow',
    aspectRatio: '16:9',
    quality: '480p',
    duration: 5,
    inputs: [
      { key: 'video-primary', channel: 'primary', type: 'video', enabled: true, role: 'primary', weight: 100, url: fixtureState.videoPrimaryUrl, sourceNodeId: fixtureIds.videoPrimaryId, sourceNodeType: 'video', sourceNodeLabel: '主运镜视频', handleId: 'video-main' },
      { key: 'video-style', channel: 'reference', type: 'image', enabled: true, role: 'style', weight: 86, url: fixtureState.videoStyleUrl, sourceNodeId: fixtureIds.videoStyleRefId, sourceNodeType: 'image', sourceNodeLabel: '风格参考图', handleId: 'video-image-reference-0' },
      { key: 'video-motion', channel: 'reference', type: 'video', enabled: true, role: 'motion', weight: 88, url: fixtureState.videoMotionUrl, sourceNodeId: fixtureIds.videoMotionRefId, sourceNodeType: 'video', sourceNodeLabel: '运动节奏参考', handleId: 'video-video-reference-0' },
      { key: 'video-omni', channel: 'reference', type: 'image', enabled: true, role: 'omni', weight: 78, url: fixtureState.videoStyleUrl, sourceNodeId: 'fixture-video-omni', sourceNodeType: 'image', sourceNodeLabel: '视频全能参考', handleId: 'video-image-reference-1' },
    ],
    params: {
      generationMode: 'referenceVideo',
      sourceMediaType: 'video',
      aspectRatio: '16:9',
      quality: '480p',
      count: 1,
    },
  });
  await patchNodeData(cdp, videoConditioningNodeId, {
    prompt: '保持主图构图与机位不变，把主体替换成参考产品，生成一段主体稳定的视频预览。',
    model: 'wan22-i2v-a14b',
    provider: 'siliconflow',
    aspectRatio: '16:9',
    quality: '480p',
    duration: 5,
    inputs: [
      { key: 'video-conditioning-primary', channel: 'primary', type: 'image', enabled: true, role: 'primary', weight: 100, url: fixtureState.videoCompositionPrimaryUrl, sourceNodeId: fixtureIds.videoCompositionPrimaryId, sourceNodeType: 'image', sourceNodeLabel: '视频构图主图', handleId: 'video-main' },
      { key: 'video-conditioning-subject', channel: 'reference', type: 'image', enabled: true, role: 'subject', weight: 90, url: fixtureState.videoSubjectRefUrl, sourceNodeId: fixtureIds.videoSubjectRefId, sourceNodeType: 'image', sourceNodeLabel: '视频主体参考', handleId: 'video-image-reference-0' },
    ],
    params: {
      generationMode: 'imageToVideo',
      sourceMediaType: 'image',
      aspectRatio: '16:9',
      quality: '480p',
      count: 1,
    },
  });
  await recorder('reference-consistency-inputs-bound', {
    imageNodeId,
    videoNodeId,
    videoConditioningNodeId,
    fixtureState,
    fixtureIds,
    imageInputs: 4,
    videoInputs: 4,
    videoConditioningInputs: 2,
  });
  log('reference-consistency:inputs-bound', { imageNodeId, videoNodeId, videoConditioningNodeId });
  const imageRoutingState = await captureLightweightImageRoutingState(cdp, recorder, imageNodeId);
  log('reference-consistency:image-route', imageRoutingState?.route || null);
  const imageWorkflowBody = imageRoutingState?.body || await captureReferenceImageWorkflowBody(
    cdp,
    recorder,
    imageNodeId,
    workflowFrames,
    '保持主体造型与原始构图不变，结合三视图生成一张横版 16:9 汽车海报，主体不要漂移。',
  );
  const videoRoutingState = await captureLightweightVideoRoutingState(cdp, recorder, videoNodeId);
  log('reference-consistency:video-route', videoRoutingState?.route || null);
  const videoWorkflowBody = videoRoutingState?.body || await captureReferenceVideoWorkflowBody(
    cdp,
    recorder,
    videoNodeId,
    '保持主素材视频的运镜、构图和节奏不变，按参考图的风格、光影与背景氛围生成新视频。',
  );
  log('reference-consistency:video-workflow-body-ready', {
    hasBody: Boolean(videoWorkflowBody),
    primaryAssetCount: Array.isArray(videoWorkflowBody?.primary_assets) ? videoWorkflowBody.primary_assets.length : 0,
    referenceAssetCount: Array.isArray(videoWorkflowBody?.reference_assets) ? videoWorkflowBody.reference_assets.length : 0,
  });
  log('reference-consistency:video-conditioning-route:start', { videoConditioningNodeId });
  const videoConditioningRoutingState = await captureLightweightVideoRoutingState(cdp, recorder, videoConditioningNodeId, {
    includeBody: false,
    recordLabel: 'reference-consistency-lightweight-video-conditioning-route',
  });
  log('reference-consistency:video-conditioning-route', videoConditioningRoutingState?.route || null);
  log('reference-consistency:video-alias-resolution:start', { requestedModel: 'doubao-seedance-2-0' });
  const videoAliasResolutionState = await captureLightweightCatalogAliasResolutionState(cdp, recorder, 'doubao-seedance-2-0', 'video');
  log('reference-consistency:video-alias-resolution', videoAliasResolutionState);
  log('reference-consistency:video-conditioning-workflow-body:start', { videoConditioningNodeId });
  const videoConditioningWorkflowBody = await captureConditioningRoleWorkflowBody(
    cdp,
    recorder,
    videoConditioningNodeId,
    '保持主图构图与机位不变，把主体替换成参考产品，生成一段主体稳定的视频预览。',
  );
  log('reference-consistency:video-conditioning-workflow-body:ready', {
    hasBody: Boolean(videoConditioningWorkflowBody),
    primaryAssetCount: Array.isArray(videoConditioningWorkflowBody?.primary_assets) ? videoConditioningWorkflowBody.primary_assets.length : 0,
    referenceAssetCount: Array.isArray(videoConditioningWorkflowBody?.reference_assets) ? videoConditioningWorkflowBody.reference_assets.length : 0,
  });

  const imageCheck = buildReferenceImageConsistencyResult(imageWorkflowBody);
  const videoCheck = buildReferenceVideoConsistencyResult(videoWorkflowBody);
  const imageRoleMappingCheck = buildConditioningRoleMappingResult(imageWorkflowBody, { label: '图片节点' });
  const videoRoleMappingCheck = buildConditioningRoleMappingResult(videoConditioningWorkflowBody, { label: '视频节点' });
  const imageRouteExpectation = buildImageRouteExpectationResult(imageRoutingState);
  const videoRouteExpectation = buildVideoRouteExpectationResult(videoRoutingState, {
    label: '视频节点',
    expectedRouteIds: ['kling-o3', 'happyhorse-11', 'seedance-v2'],
  });
  const videoConditioningRouteExpectation = buildVideoRouteExpectationResult(videoConditioningRoutingState, {
    label: '视频主体替换节点',
    expectMotionLock: false,
    expectStyleTransfer: false,
  });
  const videoAliasExpectation = buildCatalogAliasExpectationResult(videoAliasResolutionState, {
    label: '视频模型别名映射',
    expectedCatalogId: 'seedance-v2',
  });
  const imageVisiblePanelExpectation = (() => {
    const state = visiblePanelState?.imagePanelState || {};
    const lifecycle = imagePortLifecycleState && typeof imagePortLifecycleState === 'object' ? imagePortLifecycleState : {};
    const failReasons = [];
    const debugText = String(state.debugText || '');
    if (!debugText.includes('subject') || !debugText.includes('omni')) {
      failReasons.push('图片节点调试文案未同步展示 subject / omni。');
    }
    if (!Array.isArray(state.weightValues) || !state.weightValues.includes(94) || !state.weightValues.includes(82)) {
      failReasons.push('图片节点前台未稳定展示主体/光影参考权重。');
    }
    const referenceSummaryText = String(state.referenceSummaryText || '');
    if (!referenceSummaryText.includes('主素材 1 路') || !referenceSummaryText.includes('参考素材 2 路')) {
      failReasons.push('图片节点前台参考汇总未同步显示 1 路主素材 + 2 路参考。');
    }
    if (Number(lifecycle.subjectInitial || 0) < 2 || Number(lifecycle.subjectCollapsed || 0) !== 1) {
      failReasons.push('图片节点主体参考端口未通过连上展开 / 断开回收断言。');
    }
    if (Number(lifecycle.lightingInitial || 0) < 2 || Number(lifecycle.lightingCollapsed || 0) !== 1) {
      failReasons.push('图片节点光影参考端口未通过连上展开 / 断开回收断言。');
    }
    if (Number(lifecycle?.cleanupState?.remainingInputCount || 0) !== 1) {
      failReasons.push('图片节点断开参考边后仍残留旧输入。');
    }
    return {
      passed: failReasons.length === 0,
      state,
      lifecycle,
      failReasons,
    };
  })();
  const videoVisiblePanelExpectation = (() => {
    const state = visiblePanelState?.videoPanelState || {};
    const failReasons = [];
    const uiRiskReasons = [];
    if (Number(state.referenceCardCount || 0) < 2) {
      uiRiskReasons.push('视频节点前台未稳定显示 subject / omni 多参考卡片。');
    }
    if (!Array.isArray(state.roleValues) || !state.roleValues.includes('subject') || !state.roleValues.includes('omni')) {
      uiRiskReasons.push('视频节点前台角色下拉未稳定显示 subject / omni。');
    }
    const debugText = String(state.debugText || '');
    const debugMeta = state.debugMeta && typeof state.debugMeta === 'object' ? state.debugMeta : {};
    const debugReferenceRoles = Array.isArray(debugMeta.referenceRoles) ? debugMeta.referenceRoles.map((item) => String(item || '')) : [];
    if ((!debugText.includes('subject') || !debugText.includes('omni')) && (!debugReferenceRoles.includes('subject') || !debugReferenceRoles.includes('omni'))) {
      uiRiskReasons.push('视频节点调试文案未同步展示 subject / omni。');
    }
    const capabilityText = String(state.capabilityText || '');
    const capabilityMeta = state.capabilityMeta && typeof state.capabilityMeta === 'object' ? state.capabilityMeta : {};
    if ((!capabilityText.includes('任务') || !capabilityText.includes('全能参考')) && !(capabilityMeta.hasTask === true && capabilityMeta.hasOmni === true)) {
      uiRiskReasons.push('视频节点能力预览未展示任务与全能参考提示。');
    }
    const boundaryText = String(state.boundaryText || '');
    if (!boundaryText.includes('当前模型可被选中，但不满足这次任务需求') || !boundaryText.includes('推荐模型')) {
      failReasons.push('视频节点未展示推荐路由边界提示。');
    }
    if (!boundaryText.includes('Kling') && !boundaryText.includes('Seedance') && !boundaryText.includes('Wan 2.2 I2V')) {
      failReasons.push('视频节点推荐模型提示未命中预期候选。');
    }
    if (String(state.selectedModel || '') !== 'wan22-i2v-a14b') {
      failReasons.push('视频节点前台推荐验收未成功切到弱路由模型。');
    }
    return {
      passed: failReasons.length === 0,
      uiPassed: uiRiskReasons.length === 0,
      state,
      failReasons,
      uiRiskReasons,
    };
  })();
  log('reference-consistency:api-recommendations-visible:start');
  const apiRecommendationVisibleState = await captureApiRuntimeRecommendationVisibleState(cdp);
  await recorder('reference-consistency-api-recommendations-visible', apiRecommendationVisibleState);
  log('reference-consistency:api-recommendations-visible', apiRecommendationVisibleState);
  log('reference-consistency:result-aggregation:start', {
    imageCheckPassed: imageCheck.passed,
    videoCheckPassed: videoCheck.passed,
    imageRoleMappingPassed: imageRoleMappingCheck.passed,
    videoRoleMappingPassed: videoRoleMappingCheck.passed,
    imageRoutePassed: imageRouteExpectation.passed,
    videoRoutePassed: videoRouteExpectation.passed,
    videoConditioningRoutePassed: videoConditioningRouteExpectation.passed,
    videoAliasPassed: videoAliasExpectation.passed,
    imageVisiblePassed: imageVisiblePanelExpectation.passed,
    videoVisiblePassed: videoVisiblePanelExpectation.passed,
  });
  const overallPassed = Boolean(
    imageCheck.passed
    && videoCheck.passed
    && imageRoleMappingCheck.passed
    && videoRoleMappingCheck.passed
    && imageRouteExpectation.passed
    && videoRouteExpectation.passed
    && videoConditioningRouteExpectation.passed
    && videoAliasExpectation.passed
    && imageVisiblePanelExpectation.passed
    && videoVisiblePanelExpectation.passed
    && !visiblePageCheck?.hasCrash
    && visiblePageCheck?.hasCanvasMarkers
    && visibleReferenceState?.hasImageDemo
    && visibleReferenceState?.hasVideoDemo,
  );
  const uiWarnings = [
    ...(Array.isArray(videoVisiblePanelExpectation.uiRiskReasons) ? videoVisiblePanelExpectation.uiRiskReasons : []),
  ];
  log('reference-consistency:result-aggregation:ready', { overallPassed, uiWarningsCount: uiWarnings.length });
  const result = {
    passed: overallPassed,
    uiPassed: Boolean(imageVisiblePanelExpectation.passed && videoVisiblePanelExpectation.uiPassed),
    verifyMode: 'reference-consistency-only',
    targetUrl: visibleDemoUrl,
    requestCaptureUrl: targetUrl,
    visiblePageCheck,
    visibleReferenceState,
    visiblePanelState,
    imagePortLifecycleState,
    apiRecommendationVisibleState,
    imageNodeId,
    videoNodeId,
    videoConditioningNodeId,
    workflowFrameCount: workflowFrames.length,
    imageInputCount: 4,
    videoInputCount: 3,
    imageWorkflowBody,
    videoWorkflowBody,
    videoConditioningWorkflowBody,
    imageRoutingState,
    videoRoutingState,
    videoConditioningRoutingState,
    videoAliasResolutionState,
    imageCheck,
    videoCheck,
    imageRoleMappingCheck,
    videoRoleMappingCheck,
    imageRouteExpectation,
    videoRouteExpectation,
    videoConditioningRouteExpectation,
    videoAliasExpectation,
    imageVisiblePanelExpectation,
    videoVisiblePanelExpectation,
    uiWarnings,
    failReasons: [
      ...imageCheck.failReasons,
      ...videoCheck.failReasons,
      ...imageRoleMappingCheck.failReasons,
      ...videoRoleMappingCheck.failReasons,
      ...imageRouteExpectation.failReasons,
      ...videoRouteExpectation.failReasons,
      ...videoConditioningRouteExpectation.failReasons,
      ...videoAliasExpectation.failReasons,
      ...imageVisiblePanelExpectation.failReasons,
      ...videoVisiblePanelExpectation.failReasons,
    ],
  };
  log('reference-consistency:result-record:start', { label: overallPassed ? 'reference-consistency-verified' : 'reference-consistency-failed' });
  await recorder(overallPassed ? 'reference-consistency-verified' : 'reference-consistency-failed', result);
  log('reference-consistency:result-record:done', { label: overallPassed ? 'reference-consistency-verified' : 'reference-consistency-failed' });
  log('reference-consistency:completed', { passed: overallPassed, failReasons: result.failReasons });
  assert(overallPassed, '无 key 参考一致性验收未通过。', result);
  return result;
}

async function runStableTextToVideoRoundTrip(cdp, recorder, nodeId, workflowFrames) {
  const modeSelector = `[data-testid="video-mode-${nodeId}-textToVideo"]`;
  const modelToggleSelector = `[data-testid="video-model-toggle-${nodeId}"]`;
  const t2vOptionSelector = `[data-testid="video-model-option-${nodeId}-wan22-t2v-a14b"]`;

  await clickSelector(cdp, modeSelector);
  await waitFor(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
      return String(node?.data?.params?.generationMode || '') === 'textToVideo';
    })()
  `, 10000, 100);

  await clickSelector(cdp, modelToggleSelector);
  await waitForSelector(cdp, t2vOptionSelector, 10000);
  await clickSelector(cdp, t2vOptionSelector);
  await waitFor(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
      return String(node?.data?.model || '') === 'wan22-t2v-a14b';
    })()
  `, 15000, 150);

  await setValue(cdp, `[data-testid="video-count-${nodeId}"]`, '1');
  await setValue(cdp, `[data-testid="video-prompt-${nodeId}"]`, 'a cinematic sports car driving through neon city streets at night, realistic lighting, ad shot');

  const before = await readVideoGenerationDebug(cdp, nodeId);
  await recorder('video-stable-roundtrip-before', { nodeId, before });

  const initialCount = workflowFrames.length;
  await clickSelector(cdp, `[data-testid="video-generate-${nodeId}"]`);
  const frame = await waitForWorkflowCreateFrameOrNull(workflowFrames, initialCount, 20000);
  assert(frame, 'Timed out waiting for stable text-to-video workflow:create frame.', { nodeId, before });

  const body = frame?.payload?.workflow?.nodes?.[0]?.body || null;
  assert(body, 'Stable text-to-video workflow request body missing.', frame);
  assert(String(body.model || '').includes('Wan2.2-T2V') || String(body.model || '').includes('wan22-t2v'), 'Stable video workflow did not route to Wan2.2 T2V.', body);
  assert(String(body.generation_mode || '') === 'textToVideo', 'Stable video workflow did not switch to textToVideo.', body);
  assert(String(body.quality || '') === '480p', 'Stable video workflow did not preserve 480p quality.', body);

  const completedNode = await waitForGenerationCompletion(cdp, nodeId, videoGenerationTimeoutMs);
  const requestBody = completedNode?.data?.params?.requestBody || null;
  assert(requestBody, 'Stable video requestBody missing after generation.', { nodeId, completedNode });
  assert(String(requestBody.model || '').includes('Wan2.2-T2V') || String(requestBody.model || '').includes('wan22-t2v'), 'Stable final video requestBody did not route to Wan2.2 T2V.', requestBody);
  assert(String(requestBody.quality || '') === '480p', 'Stable final video requestBody did not preserve 480p quality.', requestBody);
  const { videoUrl, remoteVideoUrl, outputMeta, expectsLocalPostMix } = assertVideoOutputIntegrity(completedNode, requestBody, 'Stable video result');

  await recorder('video-stable-roundtrip-completed', { nodeId, workflowBody: body, requestBody, videoUrl, outputMeta });
  const renderState = await waitForRenderedVideo(cdp, nodeId, 90000);
  if (expectsLocalPostMix) {
    assert(
      String(renderState.currentSrc || '').length > 0 && String(renderState.currentSrc || '') !== remoteVideoUrl,
      'Stable video DOM preview did not switch to the post-mixed local render source.',
      { renderState, videoUrl, remoteVideoUrl, outputMeta },
    );
  }
  await recorder('video-stable-render-verified', { nodeId, renderState });
  return { workflowBody: body, requestBody, completedNode, renderState };
}

export async function main(overrides = {}) {
  const options = { ...parseCliOptions(process.argv.slice(2)), ...overrides };
  const effectiveUiOnly = Boolean(options.uiOnly || options.floatingPanelOnly || options.smartAgentOnly || options.videoLocalOnly || uiOnlyMode);
  const effectiveAssetLibraryOnly = Boolean(options.assetLibraryOnly);
  const effectiveAudioPanelOnly = Boolean(options.audioPanelOnly);
  const effectiveSmartAgentOnly = Boolean(options.smartAgentOnly);
  const effectiveFloatingPanelOnly = Boolean(options.floatingPanelOnly);
  const effectiveGroupingOnly = Boolean(options.groupingOnly);
  const effectiveMigrationOnly = Boolean(options.migrationOnly);
  const effectiveReferenceConsistencyOnly = Boolean(options.referenceConsistencyOnly);
  const effectiveVideoLocalOnly = Boolean(options.videoLocalOnly);
  const hasExplicitAppTarget = Boolean(process.env.HMDAO_APP_PORT || process.env.HMDAO_APP_URL);
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.resolve(APP_DIR, 'server', 'artifacts', options.headless ? `browser-headless-${runId}` : `browser-visible-${runId}`);
  const children = [];
  const cleanupTasks = [];
  const workflowFrames = [];
  const consoleMessages = [];
  const verificationConsoleStartedAtMs = Date.now();
  let cdp = null;

  await fs.mkdir(runDir, { recursive: true });
  if (!chromePath) throw new Error('No supported Chrome or Edge executable found for browser verification.');
  if (!effectiveUiOnly && !effectiveAssetLibraryOnly && !effectiveAudioPanelOnly && !effectiveReferenceConsistencyOnly && !realApiKey && !(relayBaseUrl && relayApiKey)) {
    throw new Error('HMDAO_REAL_API_KEY or relay credentials are required for real browser verification.');
  }
  chromePort = chromePort > 0 ? await reserveBrowserDebugPort(chromePort) : await reserveBrowserDebugPort(0);

  try {
    if ((effectiveUiOnly || effectiveAssetLibraryOnly || effectiveAudioPanelOnly || effectiveReferenceConsistencyOnly) && !hasExplicitAppTarget && appPort !== 3000 && await isHttpReady('http://127.0.0.1:3000')) {
      appPort = 3000;
      appUrl = 'http://127.0.0.1:3000';
    }

    await ensureService('API', `${apiUrl}/api/health`, () => start('node', ['server/hmdao-api.mjs'], 'api', APP_DIR, children));
    process.env.HMDAO_API_TARGET = apiUrl;
    process.env.VITE_HMDAO_WORKFLOW_WS_URL = `${apiUrl.replace(/^http/i, 'ws')}/ws/workflow`;
    process.env.VITE_HMDAO_CATALOG_WS_URL = `${apiUrl.replace(/^http/i, 'ws')}/ws/catalog`;
    await ensureService('Vite', appUrl, () => start('npm.cmd', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(appPort)], 'vite', APP_DIR, children));
    if (effectiveUiOnly || effectiveAssetLibraryOnly || effectiveAudioPanelOnly || effectiveReferenceConsistencyOnly || effectiveVideoLocalOnly) {
      await prewarmViteModules(appUrl, [
        '/src/App.tsx',
        '/src/pages/LaunchCanvasPage.tsx',
        '/src/components/CanvasBoard.tsx',
        '/src/components/SmartAgent.tsx',
        '/src/nodes/lazyLoad.ts',
        '/src/nodes/index.tsx',
        '/src/nodes/ImageNode.tsx',
        '/src/nodes/VideoNode.tsx',
      ]);
    }

    const userDataDir = path.join(runDir, 'browser-profile');
    await fs.mkdir(userDataDir, { recursive: true });
    const initialPageUrl = effectiveReferenceConsistencyOnly
      ? buildCleanUiOnlyAppUrl()
      : 'about:blank';
    const browserArgs = [
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-dev-shm-usage',
      '--disable-features=CalculateNativeWinOcclusion,UseSkiaRenderer',
      '--disable-renderer-backgrounding',
      '--disable-extensions',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      '--no-default-browser-check',
      '--no-first-run',
      '--disable-gpu',
      '--use-angle=swiftshader',
      '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader',
      '--remote-allow-origins=*',
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${chromePort}`,
      initialPageUrl,
    ];
    if (options.headless) browserArgs.unshift('--headless=new', '--no-sandbox');
    else browserArgs.unshift('--new-window');
    if (isEdgePath(chromePath)) browserArgs.push('--disable-features=msWebOOUI');

    log(`Launching browser (${options.headless ? 'headless' : 'visible'}) at ${chromePath}`);
    log('browser:launch-args', { chromePath, chromePort, initialPageUrl, browserArgs });
    start(chromePath, browserArgs, 'browser', APP_DIR, children);
    await waitForHttp(`http://127.0.0.1:${chromePort}/json/version`, 30000);
    log('browser:debug-port-ready', { chromePort });

    const connectTargets = effectiveAudioPanelOnly
      ? [initialPageUrl, appUrl, 'skipLaunch=1', 'DDUp']
      : [initialPageUrl, appUrl, 'skipLaunch=1', 'hmdao-demo=video-local-edit', 'DDUp'];
    log('browser:connect-targets', { connectTargets, effectiveReferenceConsistencyOnly, effectiveAudioPanelOnly });
    cdp = await connectCdp(connectTargets);
    log('browser:cdp-connected', { targetUrl: String(cdp?.target?.url || ''), targetTitle: String(cdp?.target?.title || '') });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('DOM.enable');
    await cdp.send('Log.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 980, deviceScaleFactor: 1, mobile: false });

    cdp.on('Network.webSocketFrameSent', (params) => {
      const payloadData = params.response?.payloadData;
      if (typeof payloadData !== 'string') return;
      try {
        const parsed = JSON.parse(payloadData);
        if (parsed?.msg_type === 'workflow:create') workflowFrames.push({ ts: Date.now(), ...parsed });
      } catch {
        // ignore non-JSON frames
      }
    });

    cdp.on('Runtime.consoleAPICalled', (params) => {
      const text = Array.isArray(params.args) ? params.args.map((item) => item.value ?? item.description ?? '').join(' ') : '';
      if (text) {
        consoleMessages.push({
          type: params.type || 'log',
          text,
          timestampMs: Date.now(),
          isoTimestamp: new Date().toISOString(),
        });
        log(`browser console.${params.type || 'log'}: ${text}`);
      }
    });

    await defineNativeSetter(cdp);
    await installBootstrapState(cdp);
    const recorder = await stageRecorder(cdp, runDir);
    const { imagePath, hdriPath, videoPath } = effectiveGroupingOnly
      ? { imagePath: null, hdriPath: null, videoPath: null }
      : await createSampleFiles(runDir);
    const assetLibraryCustomApiRuntimeState = (effectiveAudioPanelOnly || effectiveSmartAgentOnly || effectiveFloatingPanelOnly || effectiveGroupingOnly || effectiveMigrationOnly || effectiveReferenceConsistencyOnly)
      ? null
      : await ensureAssetLibraryCustomApiRuntime(recorder, runDir, children);
    if (assetLibraryCustomApiRuntimeState?.cleanup) cleanupTasks.push(assetLibraryCustomApiRuntimeState.cleanup);
    const workflowTemplateState = (effectiveUiOnly || effectiveReferenceConsistencyOnly || effectiveSmartAgentOnly) ? null : await verifyReusableWorkflowTemplates(cdp, recorder);
    let assetLibraryRegressionState = null;
    if (!(effectiveAudioPanelOnly || effectiveSmartAgentOnly || effectiveFloatingPanelOnly || effectiveGroupingOnly || effectiveMigrationOnly || effectiveReferenceConsistencyOnly)) {
      try {
        log('asset-library-regression:orchestration:start', {
          effectiveUiOnly,
          effectiveAssetLibraryOnly,
          hasAssetFixtures: Boolean(imagePath && videoPath),
          hasCustomApiRuntime: Boolean(assetLibraryCustomApiRuntimeState),
        });
        assetLibraryRegressionState = effectiveUiOnly
          ? await withExternalTimeout(
            () => verifyAssetLibraryRegression(cdp, recorder, { imagePath, videoPath, runDir }, assetLibraryCustomApiRuntimeState),
            180000,
            'asset-library regression',
          )
          : await verifyAssetLibraryRegression(cdp, recorder, { imagePath, videoPath, runDir }, assetLibraryCustomApiRuntimeState);
        log('asset-library-regression:orchestration:done', {
          skipped: Boolean(assetLibraryRegressionState?.skipped),
          checks: assetLibraryRegressionState?.checks || null,
        });
      } catch (error) {
        log('asset-library-regression:orchestration:failed', {
          error: error instanceof Error ? error.message : String(error || 'unknown asset-library regression error'),
        });
        if (!effectiveUiOnly || effectiveAssetLibraryOnly) throw error;
        assetLibraryRegressionState = {
          skipped: true,
          timeout: true,
          error: error instanceof Error ? error.message : String(error || 'asset-library regression failed'),
        };
        await recorder('asset-library-regression-skipped-timeout', assetLibraryRegressionState);
        log('asset-library regression skipped for ui-only total chain', assetLibraryRegressionState);
      }
    }

    if (effectiveReferenceConsistencyOnly) {
      const referenceConsistencyState = await verifyReferenceConsistencyUiOnly(cdp, recorder, workflowFrames);
      const consoleAudit = assertNoConsoleWarnings(consoleMessages, 'browser reference-consistency-only flow', {
        sinceMs: verificationConsoleStartedAtMs,
      });
      const summary = {
        mode: options.headless ? 'headless' : 'visible',
        verifyMode: 'reference-consistency-only',
        apiUrl,
        appUrl,
        artifacts: runDir,
        referenceConsistencyState,
        consoleAudit,
        workflowTemplateState,
        assetLibraryRegressionState,
        usedRealApiKey: false,
      };
      await writeSummaryFile(runDir, summary);
      log('Browser reference-consistency-only verification completed', summary);
      return {
        ...summary,
        cdp,
        runDir,
        children,
        workflowFrames,
      };
    }

    if (effectiveAssetLibraryOnly) {
      assertNoConsoleWarnings(consoleMessages, 'browser asset-library-only flow');
      const summary = {
        mode: options.headless ? 'headless' : 'visible',
        verifyMode: 'asset-library-only',
        apiUrl,
        appUrl,
        artifacts: runDir,
        assetLibraryRegressionState,
        usedRealApiKey: false,
      };
      await writeSummaryFile(runDir, summary);
      log('Browser asset-library-only verification completed', summary);
      return {
        ...summary,
        cdp,
        runDir,
        children,
        workflowFrames,
      };
    }

    if (effectiveAudioPanelOnly) {
      const audioOnlyUrl = new URL(appUrl);
      audioOnlyUrl.searchParams.set('skipLaunch', '1');
      audioOnlyUrl.searchParams.delete('hmdao-demo');
      audioOnlyUrl.searchParams.delete('hmdao-demo-reset');
      await navigateAndWait(cdp, audioOnlyUrl.toString(), `
        (() => {
          const href = String(window.location.href || '');
          return href.includes('skipLaunch=1') && !href.includes('hmdao-demo=') && !!document.getElementById('root');
        })()
      `);
      await evalJs(cdp, `
        (() => {
          const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
          if (!store || typeof store.createCanvas !== 'function') return false;
          store.createCanvas('Audio Panel Verify');
          store.deselectAll?.();
          return true;
        })()
      `, 10000).catch(() => false);
      const helperNodeId = await addUtilityTextNode(cdp, recorder, { x: 820, y: 260 });
      const audioNodeId = await addAudioNode(cdp, recorder);
      const audioNodeInteractionState = await verifyAudioNodePanelInteractions(cdp, recorder, audioNodeId, helperNodeId);
      assertNoConsoleWarnings(consoleMessages, 'browser audio-panel-only flow');
      const summary = {
        mode: options.headless ? 'headless' : 'visible',
        verifyMode: 'audio-panel-only',
        apiUrl,
        appUrl,
        artifacts: runDir,
        helperNodeId,
        audioNodeId,
        audioNodeInteractionState,
        assetLibraryRegressionState,
        usedRealApiKey: false,
      };
      await writeSummaryFile(runDir, summary);
      log('Browser audio-panel-only verification completed', summary);
      return {
        ...summary,
        cdp,
        runDir,
        children,
        workflowFrames,
      };
    }

    if (effectiveUiOnly) {
      if (effectiveSmartAgentOnly) {
        const target = new URL(appUrl);
        target.searchParams.set('skipLaunch', '1');
        const targetUrl = target.toString();
        log('smart-agent-only:navigate', { targetUrl });
        await navigateAndWait(cdp, targetUrl, `
          (() => {
            const href = String(window.location.href || '');
            return href.includes('skipLaunch=1') && !!document.getElementById('root') && !!document.body;
          })()
        `);
        log('smart-agent-only:root-loaded');
        await waitForRoot(cdp);
        await waitForDebugBridge(cdp);
        log('smart-agent-only:debug-bridge-ready');
        const imageNodeId = await addImageNode(cdp, recorder);
        log('smart-agent-only:image-node-added', { imageNodeId });
        await selectNodeById(cdp, imageNodeId);
        await waitForNodeSelection(cdp, imageNodeId, 15000);
        log('smart-agent-only:image-node-selected', { imageNodeId });
        const smartAgentRegressionState = await verifySmartAgentVisibleRegression(cdp, recorder);
        assertNoConsoleWarnings(consoleMessages, 'browser smart-agent-only flow');
        const summary = {
          mode: options.headless ? 'headless' : 'visible',
          verifyMode: 'ui-only-smart-agent',
          apiUrl,
          appUrl,
          artifacts: runDir,
          imageNodeId,
          smartAgentRegressionState,
          workflowTemplateState,
          assetLibraryRegressionState,
          usedRealApiKey: false,
        };
        await writeSummaryFile(runDir, summary);
        log('Browser smart-agent-only verification completed', summary);
        return {
          ...summary,
          cdp,
          runDir,
          children,
          workflowFrames,
        };
      }

      if (effectiveFloatingPanelOnly) {
        const imageNodeId = await addImageNode(cdp, recorder);
        const videoNodeId = await addVideoNode(cdp, recorder);
        const seededVideoState = await seedVideoNodeWithSample(cdp, recorder, videoNodeId, videoPath);
        const floatingPanelInteractionState = await verifyImageVideoFloatingPanelInteractions(cdp, recorder, imageNodeId, videoNodeId);
        assertNoConsoleWarnings(consoleMessages, 'browser floating-panel-only flow');
        const summary = {
          mode: options.headless ? 'headless' : 'visible',
          verifyMode: 'ui-only-floating-panels',
          apiUrl,
          appUrl,
          artifacts: runDir,
          imageNodeId,
          videoNodeId,
          seededVideoState,
          floatingPanelInteractionState,
          workflowTemplateState,
          assetLibraryRegressionState,
          usedRealApiKey: false,
        };
        await writeSummaryFile(runDir, summary);
        log('Browser floating-panel-only verification completed', summary);
        return {
          ...summary,
          cdp,
          runDir,
          children,
          workflowFrames,
        };
      }

      if (effectiveGroupingOnly) {
        const canvasGroupingRegressionState = await verifyCanvasGroupingRegression(cdp, recorder);
        assertNoConsoleWarnings(consoleMessages, 'browser grouping-only flow');
        const summary = {
          mode: options.headless ? 'headless' : 'visible',
          verifyMode: 'ui-only-grouping',
          apiUrl,
          appUrl,
          artifacts: runDir,
          canvasGroupingRegressionState,
          workflowTemplateState,
          assetLibraryRegressionState,
          usedRealApiKey: false,
        };
        await writeSummaryFile(runDir, summary);
        log('Browser grouping-only verification completed', summary);
        return {
          ...summary,
          cdp,
          runDir,
          children,
          workflowFrames,
        };
      }

      if (effectiveMigrationOnly) {
        const legacyBlobMigrationState = await verifyLegacyBlobMigrationPrompts(cdp, recorder);
        const expiredSiliconflowAssetState = await verifyExpiredSiliconflowSignedAsset(cdp, recorder);
        const canvasMigrationBannerState = await verifyCanvasMigrationBanner(cdp, recorder);
        assertNoConsoleWarnings(consoleMessages, 'browser migration-only flow');
        const summary = {
          mode: options.headless ? 'headless' : 'visible',
          verifyMode: 'ui-only-migration',
          apiUrl,
          appUrl,
          artifacts: runDir,
          legacyBlobMigrationState,
          expiredSiliconflowAssetState,
          canvasMigrationBannerState,
          workflowTemplateState,
          assetLibraryRegressionState,
          usedRealApiKey: false,
        };
        await writeSummaryFile(runDir, summary);
        log('Browser migration-only verification completed', summary);
        return {
          ...summary,
          cdp,
          runDir,
          children,
          workflowFrames,
        };
      }

      if (effectiveVideoLocalOnly) {
        const demoVisibleState = await verifyDemoResultNodesVisible(cdp, recorder);
        const videoNodeId = await addVideoNode(cdp, recorder);
        const seededVideoState = await seedVideoNodeWithSample(cdp, recorder, videoNodeId, videoPath);
        const localEditChainState = await verifyVideoLocalEditChain(cdp, recorder, videoNodeId);
        const consoleAudit = assertNoConsoleWarnings(consoleMessages, 'browser ui-only video-local flow', {
          sinceMs: verificationConsoleStartedAtMs,
        });
        const summary = {
          mode: options.headless ? 'headless' : 'visible',
          verifyMode: 'ui-only-video-local',
          apiUrl,
          appUrl,
          artifacts: runDir,
          videoNodeId,
          demoVisibleState,
          seededVideoState,
          localEditChainState,
          consoleAudit,
          workflowTemplateState,
          assetLibraryRegressionState,
          assetLibraryCheckpoints: assetLibraryRegressionState?.checks || null,
          usedRealApiKey: false,
        };
        await writeSummaryFile(runDir, summary);
        log('Browser UI-only video-local verification completed', summary);
        return {
          ...summary,
          cdp,
          runDir,
          children,
          workflowFrames,
        };
      }

      const legacyBlobMigrationState = await verifyLegacyBlobMigrationPrompts(cdp, recorder);
      const expiredSiliconflowAssetState = await verifyExpiredSiliconflowSignedAsset(cdp, recorder);
      const canvasMigrationBannerState = await verifyCanvasMigrationBanner(cdp, recorder);
      const apiDiscoveryMockVisibleState = await verifyApiDiscoveryMockVisibleRegression(cdp, recorder);
      const smartAgentRegressionState = await verifySmartAgentVisibleRegression(cdp, recorder);
      const canvasGroupingRegressionState = await verifyCanvasGroupingRegression(cdp, recorder).catch(async (error) => {
        const skippedState = {
          skipped: true,
          reason: 'canvas-grouping-regression-skipped',
          error: error instanceof Error ? error.message : String(error),
        };
        await recorder('canvas-grouping-regression-skipped', skippedState);
        return skippedState;
      });
      const demoVisibleState = await verifyDemoResultNodesVisible(cdp, recorder);
      const imageNodeId = await addImageNode(cdp, recorder);
      const videoNodeId = await addVideoNode(cdp, recorder);
      const seededVideoState = await seedVideoNodeWithSample(cdp, recorder, videoNodeId, videoPath);
      const floatingPanelInteractionState = await verifyImageVideoFloatingPanelInteractions(cdp, recorder, imageNodeId, videoNodeId);
      const audioNodeId = await addAudioNode(cdp, recorder);
      const audioHelperNodeId = await addUtilityTextNode(cdp, recorder, { x: 1560, y: 260 });
      const audioNodeInteractionState = await verifyAudioNodePanelInteractions(cdp, recorder, audioNodeId, audioHelperNodeId);
      const localEditChainState = await verifyVideoLocalEditChain(cdp, recorder, videoNodeId);
      const referenceConsistencyState = await runNestedReferenceConsistencyVerification(cdp, recorder, workflowFrames).catch(async (error) => {
        const skippedState = {
          skipped: true,
          reason: 'reference-consistency-skipped',
          error: error instanceof Error ? error.message : String(error),
        };
        await recorder('reference-consistency-skipped', skippedState);
        return skippedState;
      });
      const consoleAudit = assertNoConsoleWarnings(consoleMessages, 'browser ui-only flow', {
        sinceMs: verificationConsoleStartedAtMs,
      });
      const summary = {
        mode: options.headless ? 'headless' : 'visible',
        verifyMode: 'ui-only',
        apiUrl,
        appUrl,
        artifacts: runDir,
        imageNodeId,
        videoNodeId,
        audioNodeId,
        floatingPanelInteractionState,
        audioNodeInteractionState,
        demoVisibleState,
        seededVideoState,
        localEditChainState,
        referenceConsistencyState,
        consoleAudit,
        legacyBlobMigrationState,
        expiredSiliconflowAssetState,
        canvasMigrationBannerState,
        apiDiscoveryMockVisibleState,
        smartAgentRegressionState,
        canvasGroupingRegressionState,
        workflowTemplateState,
        assetLibraryRegressionState,
        assetLibraryCheckpoints: assetLibraryRegressionState?.checks || null,
        usedRealApiKey: false,
      };
      await writeSummaryFile(runDir, summary);
      log('Browser UI-only verification completed', summary);
      return {
        ...summary,
        cdp,
        runDir,
        children,
        workflowFrames,
      };
    }

    if (videoOnly) {
      await activateSiliconflowVideoKey(cdp, recorder);
      const relayActivationRoundTripState = relayBaseUrl ? await verifyRelayActivationRoundTrip(cdp, recorder) : null;
      const videoNodeId = await addVideoNode(cdp, recorder);
      const activatedVideoModelId = await verifyActivatedVideoModel(cdp, recorder, videoNodeId);
      await verifyVideoPanel(cdp, recorder, videoNodeId, imagePath);
      const videoResult = await runVideoRoundTrip(cdp, recorder, videoNodeId, workflowFrames);
      assertNoConsoleWarnings(consoleMessages, 'browser video-only flow');
      const summary = {
        mode: options.headless ? 'headless' : 'visible',
        verifyMode: 'video-only',
        apiUrl,
        appUrl,
        artifacts: runDir,
        videoNodeId,
        activatedVideoModelId,
        workflowTemplateState,
        assetLibraryRegressionState,
        relayActivationRoundTripState,
        finalVideoWorkflowBody: videoResult.workflowBody,
        workflowFrameCount: workflowFrames.length,
      };
      await writeSummaryFile(runDir, summary);
      log('Browser video-only verification completed', summary);
      return {
        ...summary,
        cdp,
        runDir,
        children,
        workflowFrames,
      };
    }

    await activateSiliconflowKeys(cdp, recorder);
    const relayActivationRoundTripState = relayBaseUrl ? await verifyRelayActivationRoundTrip(cdp, recorder) : null;
    const nodeId = await addImageNode(cdp, recorder);
    await verifyActivatedImageModel(cdp, recorder, nodeId);
    const imageResult = await runImageRoundTrip(cdp, recorder, nodeId, workflowFrames);
    if (quickMode) {
      const videoNodeId = await addVideoNode(cdp, recorder);
      await verifyActivatedVideoModel(cdp, recorder, videoNodeId);
      await verifyVideoPanel(cdp, recorder, videoNodeId, imagePath);
      const videoResult = await runStableTextToVideoRoundTrip(cdp, recorder, videoNodeId, workflowFrames);
      const referenceImageNodeId = await addImageNode(cdp, recorder);
      await verifyActivatedImageModel(cdp, recorder, referenceImageNodeId);
      const referenceVideoNodeId = await addVideoNode(cdp, recorder);
      await verifyActivatedVideoModel(cdp, recorder, referenceVideoNodeId);
      await verifyDynamicReferencePorts(cdp, recorder, referenceImageNodeId, referenceVideoNodeId);
      await configureReferencePanel(cdp, recorder, referenceImageNodeId, 'image', [
        { index: 0, role: 'subject', weight: 88 },
        { index: 1, role: 'lighting', weight: 44 },
      ]);
      await configureReferencePanel(cdp, recorder, referenceVideoNodeId, 'video', [
        { index: 0, role: 'style', weight: 72 },
        { index: 1, role: 'motion', weight: 81 },
      ]);
      const referenceImageEconomics = await verifyNodeModelEconomicsVisible(cdp, recorder, referenceImageNodeId, 'image');
      const referenceVideoEconomics = await verifyNodeModelEconomicsVisible(cdp, recorder, referenceVideoNodeId, 'video');
      const referenceImageBody = await runReferenceAwareImageRequestCheck(cdp, recorder, referenceImageNodeId, workflowFrames);
      const referenceVideoBody = await runReferenceAwareVideoRequestCheck(cdp, recorder, referenceVideoNodeId, workflowFrames);
      assertNoConsoleWarnings(consoleMessages, 'browser quick flow');
      const summary = {
        mode: options.headless ? 'headless' : 'visible',
        verifyMode: 'quick',
        apiUrl,
        appUrl,
        artifacts: runDir,
        nodeId,
        videoNodeId,
        workflowTemplateState,
        finalImageWorkflowBody: imageResult.workflowBody,
        finalImageRequestBody: imageResult.requestBody,
        finalImageUrl: imageResult.completedNode?.data?.imageUrl || '',
        finalVideoWorkflowBody: videoResult.workflowBody,
        finalVideoRequestBody: videoResult.requestBody,
        finalVideoUrl: videoResult.completedNode?.data?.videoUrl || '',
        referenceAwareImageWorkflowBody: referenceImageBody,
        referenceAwareVideoWorkflowBody: referenceVideoBody,
        referenceImageEconomics,
        referenceVideoEconomics,
        relayActivationRoundTripState,
        assetLibraryRegressionState,
        workflowFrameCount: workflowFrames.length,
      };
      await writeSummaryFile(runDir, summary);
      log('Browser quick verification completed', summary);
      return {
        ...summary,
        cdp,
        runDir,
        cleanup: async () => {
          if (cdp) {
            try { await cdp.close(); } catch { /* noop */ }
          }
          await Promise.all(children.map((child) => terminateChild(child)));
        },
      };
    }
    await verifyCanvasPersistence(cdp, recorder, nodeId);
    await uploadSourceImage(cdp, recorder, nodeId, imagePath);
    await verifyPanoramaPanel(cdp, recorder, nodeId);
    await verifyMultiAnglePanel(cdp, recorder, nodeId);
    await verifyLightingPanel(cdp, recorder, nodeId, hdriPath);
    const lightingResult = await runLightingRoundTrip(cdp, recorder, nodeId, workflowFrames);
    await verifyHdPanel(cdp, recorder, nodeId);
    await verifyGridPanel(cdp, recorder, nodeId);
    await verifySplitPanel(cdp, recorder, nodeId);
    await verifyCameraPanel(cdp, recorder, nodeId);
    if (imageOnly) {
      assertNoConsoleWarnings(consoleMessages, 'browser flow');
      const summary = {
        mode: options.headless ? 'headless' : 'visible',
        apiUrl,
        appUrl,
        artifacts: runDir,
        nodeId,
        verifiedPanels: ['panorama', 'multiAngle', 'lighting', 'hd', 'grid', 'split', 'camera'],
        workflowFrameCount: workflowFrames.length,
        finalImageWorkflowBody: imageResult.workflowBody,
        finalImageRequestBody: imageResult.requestBody,
        finalImageUrl: imageResult.completedNode?.data?.imageUrl || '',
        relayActivationRoundTripState,
        assetLibraryRegressionState,
      };
      await writeSummaryFile(runDir, summary);
      log('Browser verification completed', summary);
      return {
        ...summary,
        cdp,
        runDir,
        children,
        workflowFrames,
      };
    }
    const videoNodeId = await addVideoNode(cdp, recorder);
    await verifyActivatedVideoModel(cdp, recorder, videoNodeId);
    await verifyVideoPanel(cdp, recorder, videoNodeId, imagePath);
    const videoResult = await runStableTextToVideoRoundTrip(cdp, recorder, videoNodeId, workflowFrames);
    const referenceImageNodeId = await addImageNode(cdp, recorder);
    await verifyActivatedImageModel(cdp, recorder, referenceImageNodeId);
    const referenceVideoNodeId = await addVideoNode(cdp, recorder);
    await verifyActivatedVideoModel(cdp, recorder, referenceVideoNodeId);
    await verifyDynamicReferencePorts(cdp, recorder, referenceImageNodeId, referenceVideoNodeId);
    await configureReferencePanel(cdp, recorder, referenceImageNodeId, 'image', [
      { index: 0, role: 'subject', weight: 88 },
      { index: 1, role: 'lighting', weight: 44 },
    ]);
    await configureReferencePanel(cdp, recorder, referenceVideoNodeId, 'video', [
      { index: 0, role: 'style', weight: 72 },
      { index: 1, role: 'motion', weight: 81 },
    ]);
    const referenceImageEconomics = await verifyNodeModelEconomicsVisible(cdp, recorder, referenceImageNodeId, 'image');
    const referenceVideoEconomics = await verifyNodeModelEconomicsVisible(cdp, recorder, referenceVideoNodeId, 'video');
    const referenceImageBody = await runReferenceAwareImageRequestCheck(cdp, recorder, referenceImageNodeId, workflowFrames);
    const referenceVideoBody = await runReferenceAwareVideoRequestCheck(cdp, recorder, referenceVideoNodeId, workflowFrames);
    assertNoConsoleWarnings(consoleMessages, 'browser flow');

    const summary = {
      mode: options.headless ? 'headless' : 'visible',
      apiUrl,
      appUrl,
      artifacts: runDir,
      nodeId,
      videoNodeId,
      verifiedPanels: ['panorama', 'multiAngle', 'lighting', 'hd', 'grid', 'split', 'camera'],
      workflowFrameCount: workflowFrames.length,
      finalImageWorkflowBody: imageResult.workflowBody,
      finalImageRequestBody: imageResult.requestBody,
      finalImageUrl: imageResult.completedNode?.data?.imageUrl || lightingResult.completedNode?.data?.imageUrl || '',
      finalVideoWorkflowBody: videoResult.workflowBody,
      finalVideoRequestBody: videoResult.requestBody,
      referenceAwareImageWorkflowBody: referenceImageBody,
      referenceAwareVideoWorkflowBody: referenceVideoBody,
      referenceImageEconomics,
      referenceVideoEconomics,
      relayActivationRoundTripState,
      assetLibraryRegressionState,
    };
    await writeSummaryFile(runDir, summary);
    log('Browser verification completed', summary);
    return {
      ...summary,
      cdp,
      runDir,
      cleanup: async () => {
        if (cdp) {
          try { await cdp.close(); } catch { /* noop */ }
        }
        await Promise.all(children.map((child) => terminateChild(child)));
      },
    };
  } finally {
    for (const cleanup of cleanupTasks.reverse()) {
      try {
        await cleanup();
      } catch {
        // noop
      }
    }
    if (cdp && !options.keepOpen) {
      try { await cdp.close(); } catch { /* noop */ }
    }
    if (!options.keepOpen) {
      await Promise.all(children.map((child) => terminateChild(child)));
    }
  }
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}



































