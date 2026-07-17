import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs, existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import util from 'node:util';

const browserCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

const chromePath = browserCandidates.find((item) => existsSync(item)) || browserCandidates[0];
let chromePort = Number(process.env.HMDAO_DCC_CHROME_PORT || 0);
const requestedAppUrl = process.env.HMDAO_APP_URL || 'http://127.0.0.1:3000';
let appUrl = requestedAppUrl;
const apiUrl = process.env.HMDAO_API_URL || 'http://127.0.0.1:8792';
const allowedVideoQualities = ['480p', '720p', '1080p', '1440p'];
const recordStartFrame = Number(process.env.HMDAO_DCC_RECORD_START_FRAME || 1);
const recordEndFrame = Number(process.env.HMDAO_DCC_RECORD_END_FRAME || 24);
const recordFps = Number(process.env.HMDAO_DCC_RECORD_FPS || 12);
const recordSettleMs = Number(process.env.HMDAO_DCC_RECORD_SETTLE_MS || 4200);
const recordOutputTimeoutMs = Number(process.env.HMDAO_DCC_RECORD_OUTPUT_TIMEOUT_MS || 120000);
const recordMotionSamples = Number(process.env.HMDAO_DCC_RECORD_MOTION_SAMPLES || 7);
const recordMotionIntervalMs = Number(process.env.HMDAO_DCC_RECORD_MOTION_INTERVAL_MS || 320);
const requestedVideoQuality = allowedVideoQualities.includes(String(process.env.HMDAO_DCC_VIDEO_QUALITY || '').trim().toLowerCase())
  ? String(process.env.HMDAO_DCC_VIDEO_QUALITY || '').trim().toLowerCase()
  : '480p';
const requestedEngine = String(process.env.HMDAO_DCC_ENGINE || 'unreal').trim().toLowerCase() === 'blender' ? 'blender' : 'unreal';
const requestedEngineLabel = requestedEngine === 'blender' ? 'Blender' : 'Unreal';
const skipUnreal = ['1', 'true', 'yes'].includes(String(process.env.HMDAO_DCC_SKIP_UNREAL || '').trim().toLowerCase());
const previewOnly = ['1', 'true', 'yes'].includes(String(process.env.HMDAO_DCC_PREVIEW_ONLY || '').trim().toLowerCase());
const forceSoftwareRenderer = ['1', 'true', 'yes'].includes(String(process.env.HMDAO_DCC_FORCE_SOFTWARE_RENDERER || '').trim().toLowerCase());
const realApiKey = String(process.env.HMDAO_REAL_API_KEY || process.env.HMDAO_SILICONFLOW_API_KEY || '').trim();
const realGenerationEnabled = !['0', 'false', 'no'].includes(String(process.env.HMDAO_DCC_REAL_GENERATION || '1').trim().toLowerCase());
const imageGenerationTimeoutMs = Number(process.env.HMDAO_DCC_IMAGE_TIMEOUT_MS || 180000);
const videoGenerationTimeoutMs = Number(process.env.HMDAO_DCC_VIDEO_TIMEOUT_MS || 420000);
const dccImagePrompt = `Keep the original ${requestedEngineLabel} camera composition. Replace the subject with a futuristic electric sports car and generate a 1280x720 editable poster base with cinematic lighting and premium advertising quality.`;
const dccVideoPrompt = `Keep the original ${requestedEngineLabel} camera motion, pacing, lens path, framing, and spatial continuity. Replace the subject with a futuristic electric sports car and generate a coherent ${requestedVideoQuality} preview ad clip from the reference video.`;

const UTF8_BOM = '\uFEFF';
let artifactLogPath = '';
let artifactLogInitialized = false;
let artifactLogWriteChain = Promise.resolve();

function parseCliOptions(argv) {
  const args = new Set(argv);
  return {
    headless: args.has('--headless') ? true : args.has('--visible') ? false : false,
    keepOpen: args.has('--keep-open'),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function formatLogExtra(extra) {
  if (extra === undefined) return '';
  if (typeof extra === 'string') return extra;
  try {
    return JSON.stringify(extra, null, 2);
  } catch {
    return util.inspect(extra, { depth: 6, breakLength: 120, compact: false });
  }
}

function queueArtifactLogWrite(text) {
  if (!artifactLogPath) return;
  const payload = `${artifactLogInitialized ? '' : UTF8_BOM}${text}\n`;
  artifactLogInitialized = true;
  artifactLogWriteChain = artifactLogWriteChain
    .catch(() => {})
    .then(() => fs.appendFile(artifactLogPath, payload, 'utf8'))
    .catch(() => {});
}

async function writeReadableArtifact(filePath, text) {
  await fs.writeFile(filePath, `${UTF8_BOM}${String(text || '')}`, 'utf8');
}

function log(message, extra) {
  const prefix = `[dcc-verify ${new Date().toISOString()}]`;
  const line = `${prefix} ${message}`;
  if (extra === undefined) {
    console.log(line);
    queueArtifactLogWrite(line);
    return;
  }
  console.log(line, extra);
  queueArtifactLogWrite(`${line}\n${formatLogExtra(extra)}`);
}

function assert(condition, message, extra) {
  if (condition) return;
  throw new Error(extra === undefined ? message : `${message} ${JSON.stringify(extra)}`);
}

function isEdgePath(targetPath) {
  return /msedge\.exe$/i.test(targetPath || '');
}

function sanitizeFilePart(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '') || 'stage';
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
  await waitForHttp(url);
  log(`${name} is ready`);
  return child;
}

async function inspectHmdaoApp(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return {
        ready: false,
        hmdao: false,
        status: response.status,
        title: '',
        detail: `Unexpected status ${response.status}`,
      };
    }
    const html = await response.text();
    const titleMatch = html.match(/<title>(.*?)<\/title>/i);
    const title = String(titleMatch?.[1] || '').trim();
    const hmdao = /<title>\s*DDUp\s*<\/title>/i.test(html)
      || /data-testid=["']launch-screen["']/i.test(html)
      || /\/src\/main\.tsx/i.test(html)
      || /\/assets\/index-[^"' ]+\.(?:js|css)/i.test(html);
    return {
      ready: true,
      hmdao,
      status: response.status,
      title,
      detail: hmdao ? 'hmdao-shell-detected' : 'different-app-detected',
    };
  } catch (error) {
    return {
      ready: false,
      hmdao: false,
      status: 0,
      title: '',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function ensureHmdaoAppService(cwd, children) {
  const reuseProbe = await inspectHmdaoApp(appUrl);
  if (reuseProbe.ready && reuseProbe.hmdao) {
    log('Reusing running HMDao app shell', { appUrl, title: reuseProbe.title || 'DDUp' });
    return null;
  }

  if (reuseProbe.ready && !reuseProbe.hmdao && process.env.HMDAO_APP_URL) {
    throw new Error(`HMDAO_APP_URL is serving a different page instead of DDUp: ${JSON.stringify({ appUrl, title: reuseProbe.title, detail: reuseProbe.detail })}`);
  }

  if (reuseProbe.ready && !reuseProbe.hmdao) {
    log('Configured app URL is occupied by a different page; starting HMDao app on a dedicated port instead.', {
      appUrl,
      title: reuseProbe.title,
      detail: reuseProbe.detail,
    });
  }

  const targetPort = appUrl === requestedAppUrl ? await pickFreePort() : new URL(appUrl).port || '3000';
  appUrl = `http://127.0.0.1:${targetPort}`;
  await ensureService('Vite', appUrl, () => start('npm.cmd', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(targetPort)], 'vite', cwd, children));

  const verifyProbe = await inspectHmdaoApp(appUrl);
  if (!verifyProbe.ready || !verifyProbe.hmdao) {
    throw new Error(`HMDao app shell did not become available at ${appUrl}: ${JSON.stringify(verifyProbe)}`);
  }
  log('HMDao app shell is ready', { appUrl, title: verifyProbe.title || 'DDUp' });
  return null;
}

async function connectCdp() {
  await waitForHttp(`http://127.0.0.1:${chromePort}/json/version`, 30000);
  let target;
  const started = Date.now();
  while (!target && Date.now() - started < 15000) {
    const targets = await (await fetch(`http://127.0.0.1:${chromePort}/json/list`)).json();
    target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
    if (!target) await sleep(250);
  }
  if (!target) throw new Error('Unable to find a browser page target for CDP.');

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

async function readPageDiagnostics(cdp) {
  try {
    return await evalJs(cdp, `
      (() => {
        const root = document.getElementById('root');
        const authStorage = window.localStorage.getItem('hmdao-auth-storage');
        return {
          href: window.location.href,
          pathname: window.location.pathname,
          title: document.title,
          readyState: document.readyState,
          rootChildCount: root?.childElementCount || 0,
          reactFlowMounted: Boolean(document.querySelector('.react-flow')),
          debugBridgeState: document.documentElement.dataset.hmdaoDebugBridgeState || '',
          authStoragePreview: typeof authStorage === 'string' ? authStorage.slice(0, 240) : '',
          bodyTextPreview: String(document.body?.innerText || '').trim().slice(0, 400),
        };
      })()
    `, 5000);
  } catch (error) {
    return {
      diagnosticsError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function navigateAndWait(cdp, url, readyExpression, timeoutMs = 30000) {
  await cdp.send('Page.navigate', { url });
  // Some dev-server sessions keep secondary resources pending even after the app shell is usable.
  await waitFor(cdp, 'document.readyState === "interactive" || document.readyState === "complete"', timeoutMs);
  try {
    await waitFor(cdp, readyExpression, timeoutMs);
  } catch (error) {
    const diagnostics = await readPageDiagnostics(cdp);
    throw new Error(`${error instanceof Error ? error.message : String(error)} | page=${JSON.stringify(diagnostics)}`);
  }
}

async function screenshot(cdp, filePath) {
  const result = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
  });
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

async function clickSelector(cdp, selector) {
  const safeSelector = JSON.stringify(selector);
  const ok = await evalJs(cdp, `
    (() => {
      const element = document.querySelector(${safeSelector});
      if (!element) return false;
      element.click();
      return true;
    })()
  `);
  if (!ok) throw new Error(`Element not found for selector: ${selector}`);
}

async function setValue(cdp, selector, value) {
  const safeSelector = JSON.stringify(selector);
  const safeValue = JSON.stringify(value);
  await waitFor(cdp, `Boolean(document.querySelector(${safeSelector}))`, 10000, 120);
  const ok = await evalJs(cdp, `
    (() => {
      const element = document.querySelector(${safeSelector});
      if (!element) return false;
      const proto = Object.getPrototypeOf(element);
      const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
      if (descriptor && typeof descriptor.set === "function") {
        descriptor.set.call(element, ${safeValue});
      } else {
        element.value = ${safeValue};
      }
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
  if (!ok) throw new Error(`Unable to set value for selector: ${selector}`);
}

async function readCanvasSnapshot(cdp) {
  return evalJs(cdp, `
    (() => {
      const debug = window.__HMDAO_DEBUG__;
      return typeof debug?.readCanvasSnapshot === 'function' ? debug.readCanvasSnapshot() : null;
    })()
  `, 10000);
}

async function readDccPreviewSignature(cdp, nodeId) {
  const selector = `[data-testid="dcc-node-${nodeId}"]`;
  return evalJs(cdp, `
    (() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return null;
      const canvas = node.querySelector('canvas');
      if (!canvas || canvas.width < 8 || canvas.height < 8) return null;
      const sampleWidth = 24;
      const sampleHeight = 14;
      const buffer = document.createElement('canvas');
      buffer.width = sampleWidth;
      buffer.height = sampleHeight;
      const bufferCtx = buffer.getContext('2d', { willReadFrequently: true });
      if (!bufferCtx) return null;
      bufferCtx.drawImage(canvas, 0, 0, sampleWidth, sampleHeight);
      const image = bufferCtx.getImageData(0, 0, sampleWidth, sampleHeight).data;
      const values = [];
      let brightnessSum = 0;
      for (let index = 0; index < image.length; index += 4) {
        const r = image[index] ?? 0;
        const g = image[index + 1] ?? 0;
        const b = image[index + 2] ?? 0;
        const luminance = Math.round((r * 3 + g * 4 + b) / 8);
        brightnessSum += luminance;
        values.push(String(Math.round(luminance / 8)));
      }
      return {
        width: canvas.width,
        height: canvas.height,
        sampledWidth: sampleWidth,
        sampledHeight: sampleHeight,
        averageBrightness: Math.round(brightnessSum / Math.max(1, values.length)),
        signature: values.join('|'),
      };
    })()
  `, 10000);
}

async function waitForDccPreviewFrame(cdp, nodeId, timeoutMs = 45000) {
  return waitFor(cdp, `
    (() => {
      const node = document.querySelector(${JSON.stringify(`[data-testid="dcc-node-${nodeId}"]`)});
      if (!node) return false;
      const canvas = node.querySelector('canvas');
      if (!canvas || canvas.width < 8 || canvas.height < 8) return false;
      const nodeText = String(node.textContent || '');
      const fpsMatch = nodeText.match(/(\\d+)\\s*fps/i);
      const fpsValue = fpsMatch ? Number(fpsMatch[1] || 0) : 0;
      const buffer = document.createElement('canvas');
      const sampleWidth = 24;
      const sampleHeight = 14;
      buffer.width = sampleWidth;
      buffer.height = sampleHeight;
      const ctx = buffer.getContext('2d', { willReadFrequently: true });
      if (!ctx) return false;
      ctx.drawImage(canvas, 0, 0, sampleWidth, sampleHeight);
      const pixels = ctx.getImageData(0, 0, sampleWidth, sampleHeight).data;
      let avg = 0;
      let max = 0;
      let nonZero = 0;
      const buckets = new Set();
      for (let index = 0; index < pixels.length; index += 4) {
        const r = pixels[index] ?? 0;
        const g = pixels[index + 1] ?? 0;
        const b = pixels[index + 2] ?? 0;
        const luminance = Math.round((r * 3 + g * 4 + b) / 8);
        avg += luminance;
        max = Math.max(max, luminance);
        if (luminance > 1) nonZero += 1;
        buckets.add(Math.round(luminance / 6));
      }
      avg = avg / Math.max(1, sampleWidth * sampleHeight);
      return fpsValue > 0 || (nonZero >= 12 && (max >= 16 || avg >= 4 || buckets.size >= 3));
    })()
  `, timeoutMs, 400);
}

async function sampleDccPreviewMotion(cdp, nodeId, sampleCount = 6, intervalMs = 350) {
  const samples = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = await readDccPreviewSignature(cdp, nodeId);
    samples.push({ index, at: new Date().toISOString(), ...sample });
    if (index < sampleCount - 1) await sleep(intervalMs);
  }
  const distinctSignatures = Array.from(new Set(samples.map((sample) => sample?.signature).filter(Boolean)));
  const brightnessValues = samples.map((sample) => Number(sample?.averageBrightness || 0));
  const brightnessRange = brightnessValues.length ? Math.max(...brightnessValues) - Math.min(...brightnessValues) : 0;
  return {
    samples,
    distinctSignatures,
    distinctCount: distinctSignatures.length,
    brightnessRange,
    motionDetected: distinctSignatures.length >= 2 || brightnessRange >= 2,
  };
}

function summarizeDccWsFrameMotion(wsEvents, startIndex = 0) {
  const frameHashes = wsEvents
    .slice(Math.max(0, Number(startIndex) || 0))
    .filter((event) => event?.frameType === 'frame' && typeof event?.frameHash === 'string' && event.frameHash)
    .map((event) => event.frameHash);
  const distinctFrameHashes = Array.from(new Set(frameHashes));
  return {
    frameCount: frameHashes.length,
    distinctFrameHashes,
    distinctFrameCount: distinctFrameHashes.length,
    motionDetected: distinctFrameHashes.length >= 2,
  };
}

async function verifyCameraSwitchDiff(cdp, recorder, nodeId) {
  await ensureDccNodeControlsVisible(cdp, nodeId);
  const cameras = await evalJs(cdp, `
    (() => {
      const select = document.querySelector(${JSON.stringify(`[data-testid="dcc-camera-${nodeId}"]`)});
      if (!select) return [];
      return Array.from(select.options || []).map((option) => ({ value: option.value, label: option.label }));
    })()
  `, 10000);
  await recorder('dcc-camera-options-read', { nodeId, cameras });
  if (!Array.isArray(cameras) || cameras.length < 2) {
    await recorder('dcc-camera-switch-skipped', { nodeId, reason: 'less-than-two-cameras', cameras });
    return { skipped: true, reason: 'less-than-two-cameras', cameras };
  }
  const first = cameras[0];
  const second = cameras[1];
  await setValue(cdp, `[data-testid="dcc-camera-${nodeId}"]`, String(first.value));
  await sleep(800);
  const firstSignature = await readDccPreviewSignature(cdp, nodeId);
  const firstMotion = await sampleDccPreviewMotion(cdp, nodeId, 3, 220);
  await recorder('dcc-camera-first-preview', { nodeId, camera: first, preview: firstSignature });
  await setValue(cdp, `[data-testid="dcc-camera-${nodeId}"]`, String(second.value));
  await sleep(1200);
  const secondSignature = await readDccPreviewSignature(cdp, nodeId);
  const secondMotion = await sampleDccPreviewMotion(cdp, nodeId, 3, 220);
  await recorder('dcc-camera-second-preview', { nodeId, camera: second, preview: secondSignature });
  const changed = Boolean(firstSignature?.signature) && Boolean(secondSignature?.signature) && firstSignature.signature !== secondSignature.signature;
  if (!changed) {
    throw new Error(`Camera switch preview signature did not change for node ${nodeId}.`);
  }
  await recorder('dcc-camera-switch-diff-verified', {
    nodeId,
    first,
    second,
    firstSignature,
    secondSignature,
    firstMotion,
    secondMotion,
    changed,
  });
  return { skipped: false, changed, first, second, firstSignature, secondSignature, firstMotion, secondMotion };
}

async function verifyPreviewAutoPaused(cdp, recorder, nodeId) {
  await selectNodeById(cdp, nodeId);
  await waitFor(cdp, `
    (() => {
      const snapshot = window.__HMDAO_DEBUG__?.readCanvasSnapshot?.();
      return Array.isArray(snapshot?.selectedNodeIds) && snapshot.selectedNodeIds.includes(${JSON.stringify(nodeId)});
    })()
  `, 15000, 250);
  const pauseState = await evalJs(cdp, `
    (() => {
      const pauseButton = document.querySelector(${JSON.stringify(`[data-testid="dcc-pause-${nodeId}"]`)});
      const stopButton = document.querySelector(${JSON.stringify(`[data-testid="dcc-stop-${nodeId}"]`)});
      return {
        hasPauseButton: Boolean(pauseButton),
        pauseTitle: pauseButton ? pauseButton.getAttribute('title') : '',
        pauseButtonVisible: Boolean(pauseButton),
        stopButtonVisible: Boolean(stopButton),
      };
    })()
  `, 10000);
  const pauseMotion = await sampleDccPreviewMotion(cdp, nodeId, 3, 260);
  await recorder('dcc-preview-auto-paused', { nodeId, pauseState, pauseMotion });
  const isPausedByMotion = pauseMotion?.distinctCount <= 1 && !pauseMotion?.motionDetected;
  const showsResumeState = /鎭㈠|resume/i.test(String(pauseState?.pauseTitle || ''));
  const showsResumeStateNormalized = /(恢复|resume)/i.test(String(pauseState?.pauseTitle || ''));
  if (!pauseState?.pauseButtonVisible || !(showsResumeState || showsResumeStateNormalized) || !isPausedByMotion) {
    throw new Error(`Preview did not enter paused state automatically after recording for node ${nodeId}.`);
  }
  return { pauseState, pauseMotion };
}

async function verifyPreviewPostRecordingState(cdp, recorder, nodeId) {
  if (requestedEngine === 'blender') {
    const previewMotion = await sampleDccPreviewMotion(cdp, nodeId, 3, 260);
    await recorder('dcc-preview-post-recording-state', {
      nodeId,
      engine: requestedEngine,
      mode: 'live-preview',
      previewMotion,
    });
    return { skippedAutoPause: true, previewMotion };
  }
  return verifyPreviewAutoPaused(cdp, recorder, nodeId);
}


async function readDccStatus() {
  const response = await fetch(`${apiUrl}/api/dcc/status?force=1`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Failed to query DCC status: HTTP ${response.status}`);
  return response.json();
}

async function waitForDccStatus(description, predicate, timeoutMs = 45000, intervalMs = 1000) {
  const started = Date.now();
  let lastStatus = null;
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      lastStatus = await readDccStatus();
      if (predicate(lastStatus)) {
        return lastStatus;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }

  const detail = lastStatus
    ? JSON.stringify(lastStatus?.engines || lastStatus)
    : (lastError instanceof Error ? lastError.message : String(lastError || 'unknown'));
  throw new Error(`Timed out waiting for DCC status: ${description}. Last observed status: ${detail}`);
}

async function readApiHealth() {
  const response = await fetch(`${apiUrl}/api/health`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Failed to query API health: HTTP ${response.status}`);
  return response.json();
}

async function ensureRealApiReady() {
  if (!realGenerationEnabled) return null;
  if (!realApiKey) {
    throw new Error('HMDAO_REAL_API_KEY or HMDAO_SILICONFLOW_API_KEY is required for DCC real upstream verification.');
  }
  const health = await readApiHealth();
  if (health?.realApiEnabled !== true) {
    throw new Error(`DCC real upstream verification requires HMDAO_REAL_API=1 on ${apiUrl}. Current /api/health: ${JSON.stringify(health)}`);
  }
  return health;
}

async function validateSiliconflowKey(mode, model) {
  const response = await fetch(`${apiUrl}/api/byok/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'siliconflow', apiKey: realApiKey, mode, model }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.success) {
    throw new Error(`Failed to activate SiliconFlow ${mode} key via backend: ${JSON.stringify(data)}`);
  }
  return data;
}

async function syncSiliconflowKeysToBrowser(cdp, validationResults) {
  const now = Date.now();
  const expiresAt = now + 30 * 24 * 60 * 60 * 1000;
  const entries = Object.fromEntries(validationResults.map((result) => {
    const mode = String(result.mode || '');
    return [`siliconflow::${mode}`, {
      provider: 'siliconflow',
      apiKey: realApiKey,
      maskedKey: result.maskedKey || '****',
      mode,
      model: result.model || '',
      activatedAt: now,
      expiresAt,
      refreshAfter: expiresAt - 24 * 60 * 60 * 1000,
      lastValidatedAt: now,
      source: 'byok',
      status: 'active',
      metadataOnly: false,
    }];
  }));
  const persisted = {
    state: {
      keys: Object.fromEntries(Object.entries(entries).map(([key, value]) => [
        key,
        { ...value, apiKey: undefined },
      ])),
      secureReady: true,
      secureLoading: false,
    },
    version: 0,
  };

  const state = await evalJs(cdp, `
    (async () => {
      const entries = ${JSON.stringify(entries)};
      localStorage.setItem('hmdao-api-keys', ${JSON.stringify(JSON.stringify(persisted))});
      const store = window.__HMDAO_DEBUG__?.apiKeyStore?.getState?.();
      if (store?.initSecureStore) {
        try { await store.initSecureStore('dcc-browser-real-refresh'); } catch {}
      }
      if (store?.setKey) {
        for (const item of Object.values(entries)) {
          await store.setKey(item);
        }
      }
      const runtimeEntries = Object.values(window.__HMDAO_DEBUG__?.apiKeyStore?.getState?.()?.keys || {});
      return {
        runtimeEntries: runtimeEntries.map((item) => ({
          provider: item.provider,
          mode: item.mode,
          model: item.model || '',
          status: item.status,
          hasApiKey: Boolean(item.apiKey),
          metadataOnly: Boolean(item.metadataOnly),
        })),
        persistedLength: localStorage.getItem('hmdao-api-keys')?.length || 0,
      };
    })()
  `, 20000);

  for (const mode of validationResults.map((result) => String(result.mode || ''))) {
    assert(
      state.runtimeEntries.some((item) => item.provider === 'siliconflow' && item.mode === mode && item.status !== 'expired' && item.hasApiKey),
      `Browser runtime key state did not activate SiliconFlow ${mode}.`,
      state,
    );
  }
  return state;
}

async function activateRealSiliconflow(cdp, recorder) {
  if (!realGenerationEnabled) {
    await recorder('dcc-real-upstream-skipped', { reason: 'HMDAO_DCC_REAL_GENERATION=0' });
    return null;
  }
  const image = await validateSiliconflowKey('image', 'Qwen/Qwen-Image');
  const video = await validateSiliconflowKey('video', 'Wan-AI/Wan2.2-I2V-A14B');
  const browserState = await syncSiliconflowKeysToBrowser(cdp, [image, video]);
  await recorder('dcc-real-siliconflow-activated', {
    image: { ...image, apiKey: undefined },
    video: { ...video, apiKey: undefined },
    browserState,
  });
  return { image, video, browserState };
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
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      if (!store || typeof store.setSelectedNodeIds !== 'function') return false;
      store.setSelectedNodeIds([${JSON.stringify(nodeId)}]);
      return true;
    })()
  `, 10000);
  if (!ok) throw new Error(`Unable to select node ${nodeId}`);
}

async function readNode(cdp, nodeId) {
  return evalJs(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
      return node ? { id: node.id, type: node.type, data: node.data || {} } : null;
    })()
  `, 10000);
}

async function waitForState(label, readState, predicate, timeoutMs = 30000, intervalMs = 500) {
  const started = Date.now();
  let lastState = null;
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      lastState = await readState();
      if (predicate(lastState)) return lastState;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  if (lastError) {
    throw new Error(`${label} failed while polling: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(lastState)}`);
}

async function readDccCapturePersistenceState(cdp, nodeId) {
  return evalJs(cdp, `
    (async () => {
      const debug = window.__HMDAO_DEBUG__ || {};
      const canvasStore = debug.canvasStore?.getState?.();
      const assetStore = debug.assetStore?.getState?.();
      const nodes = canvasStore?.canvas?.nodes || [];
      const dccNode = nodes.find((node) => node.id === ${JSON.stringify(nodeId)}) || null;
      const dccData = dccNode?.data || {};
      const dccParams = dccData?.params || {};
      const imageUrl = String(dccData?.imageUrl || '');
      const captureAssetId = String(dccParams?.captureAssetId || '');
      const materializedImage = [...nodes].reverse().find((node) => (
        node.type === 'image'
        && node.data?.params?.source === 'dcc-output'
        && node.data?.params?.sourceNodeId === ${JSON.stringify(nodeId)}
      )) || null;
      const derivedRegion = [...nodes].reverse().find((node) => (
        node.type === 'region'
        && node.data?.params?.sourceNodeId === ${JSON.stringify(nodeId)}
        && node.data?.params?.sourceMediaType === 'image'
      )) || null;
      const summarizeNode = (node) => node ? {
        id: node.id || '',
        type: node.type || '',
        label: node.data?.label || '',
        imageUrl: node.data?.imageUrl || '',
        sourceUrl: node.data?.params?.sourceUrl || '',
        outputUrl: node.data?.outputs?.[0]?.url || '',
        outputThumbnail: node.data?.outputs?.[0]?.thumbnail || '',
        sourceMediaType: node.data?.params?.sourceMediaType || '',
      } : null;
      const summarizeItem = (item) => ({
        id: item?.id || '',
        name: item?.name || '',
        type: item?.type || '',
        url: item?.url || '',
        thumbnail: item?.thumbnail || '',
        folderId: item?.folderId || '',
        tags: Array.isArray(item?.tags) ? item.tags : [],
        smartCategories: Array.isArray(item?.smartCategories) ? item.smartCategories : [],
      });
      const matchesCaptureItem = (item) => {
        if (!item || String(item.folderId || '') !== 'dcc' || String(item.type || '') !== 'image') return false;
        const tags = Array.isArray(item.tags) ? item.tags.map((value) => String(value)) : [];
        const smartCategories = Array.isArray(item.smartCategories) ? item.smartCategories.map((value) => String(value)) : [];
        const url = String(item.url || '');
        const thumbnail = String(item.thumbnail || '');
        return (
          tags.includes('DCC')
          && tags.includes('\u622a\u56fe')
          && smartCategories.includes('DCC\u622a\u56fe')
          && (
            (captureAssetId && String(item.id || '') === captureAssetId)
            || (imageUrl && (url === imageUrl || thumbnail === imageUrl))
          )
        );
      };

      const storeItems = Array.isArray(assetStore?.items) ? assetStore.items : [];
      let catalogItems = [];
      let catalogError = '';
      try {
        const response = await fetch('/api/assets/library', { credentials: 'include', cache: 'no-store' });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          catalogError = payload?.error?.message || 'asset-library-http-' + response.status;
        } else {
          catalogItems = Array.isArray(payload?.items) ? payload.items : [];
        }
      } catch (error) {
        catalogError = error instanceof Error ? error.message : String(error);
      }

      const storeCaptureMatches = storeItems.filter(matchesCaptureItem).map(summarizeItem);
      const catalogCaptureMatches = catalogItems.filter(matchesCaptureItem).map(summarizeItem);
      const ready = Boolean(
        imageUrl
        && derivedRegion?.data?.imageUrl === imageUrl
        && storeCaptureMatches.length > 0
        && catalogCaptureMatches.length > 0
        && !catalogError
      );
      return {
        ready,
        catalogError,
        dccNode: {
          id: dccNode?.id || '',
          imageUrl,
          captureAssetId,
          captureSourceUrl: String(dccParams?.captureSourceUrl || ''),
          captureOriginalUrl: String(dccParams?.captureOriginalUrl || ''),
          outputUrl: String(dccData?.outputs?.[0]?.url || ''),
        },
        materializedImage: summarizeNode(materializedImage),
        derivedRegion: summarizeNode(derivedRegion),
        storeCaptureMatches,
        catalogCaptureMatches,
        storeDccItemCount: storeItems.filter((item) => String(item?.folderId || '') === 'dcc').length,
        catalogDccItemCount: catalogItems.filter((item) => String(item?.folderId || '') === 'dcc').length,
      };
    })()
  `, 15000);
}

async function readDccRecordingPersistenceState(cdp, nodeId) {
  return evalJs(cdp, `
    (async () => {
      const debug = window.__HMDAO_DEBUG__ || {};
      const canvasStore = debug.canvasStore?.getState?.();
      const assetStore = debug.assetStore?.getState?.();
      const nodes = canvasStore?.canvas?.nodes || [];
      const dccNode = nodes.find((node) => node.id === ${JSON.stringify(nodeId)}) || null;
      const dccData = dccNode?.data || {};
      const dccParams = dccData?.params || {};
      const videoUrl = String(dccData?.videoUrl || '');
      const recordingAssetId = String(dccParams?.recordingAssetId || '');
      const firstFrameUrl = String(dccParams?.firstFrameUrl || '');
      const materializedVideo = [...nodes].reverse().find((node) => (
        node.type === 'video'
        && node.data?.params?.source === 'dcc-output'
        && node.data?.params?.sourceNodeId === ${JSON.stringify(nodeId)}
      )) || null;
      const derivedRegion = [...nodes].reverse().find((node) => (
        node.type === 'region'
        && node.data?.params?.sourceNodeId === ${JSON.stringify(nodeId)}
        && node.data?.params?.sourceMediaType === 'video'
      )) || null;
      const summarizeNode = (node) => node ? {
        id: node.id || '',
        type: node.type || '',
        label: node.data?.label || '',
        videoUrl: node.data?.videoUrl || '',
        imageUrl: node.data?.imageUrl || '',
        firstFrameUrl: node.data?.params?.firstFrameUrl || '',
        sourceUrl: node.data?.params?.sourceUrl || '',
        outputUrl: node.data?.outputs?.[0]?.url || '',
        outputThumbnail: node.data?.outputs?.[0]?.thumbnail || '',
        sourceMediaType: node.data?.params?.sourceMediaType || '',
      } : null;
      const summarizeItem = (item) => ({
        id: item?.id || '',
        name: item?.name || '',
        type: item?.type || '',
        url: item?.url || '',
        thumbnail: item?.thumbnail || '',
        folderId: item?.folderId || '',
        tags: Array.isArray(item?.tags) ? item.tags : [],
        smartCategories: Array.isArray(item?.smartCategories) ? item.smartCategories : [],
      });
      const matchesRecordingItem = (item) => {
        if (!item || String(item.folderId || '') !== 'dcc' || String(item.type || '') !== 'video') return false;
        const tags = Array.isArray(item.tags) ? item.tags.map((value) => String(value)) : [];
        const smartCategories = Array.isArray(item.smartCategories) ? item.smartCategories.map((value) => String(value)) : [];
        const url = String(item.url || '');
        const thumbnail = String(item.thumbnail || '');
        return (
          tags.includes('DCC')
          && tags.includes('\u5f55\u5236')
          && smartCategories.includes('DCC\u5f55\u5236')
          && (
            (recordingAssetId && String(item.id || '') === recordingAssetId)
            || (videoUrl && (url === videoUrl || thumbnail === videoUrl))
          )
        );
      };
      const matchesThumbnailItem = (item) => {
        if (!item || String(item.folderId || '') !== 'dcc' || String(item.type || '') !== 'image') return false;
        const tags = Array.isArray(item.tags) ? item.tags.map((value) => String(value)) : [];
        const smartCategories = Array.isArray(item.smartCategories) ? item.smartCategories.map((value) => String(value)) : [];
        const url = String(item.url || '');
        const thumbnail = String(item.thumbnail || '');
        return (
          tags.includes('DCC')
          && tags.includes('\u9996\u5e27')
          && smartCategories.includes('DCC\u9996\u5e27')
          && firstFrameUrl
          && (url === firstFrameUrl || thumbnail === firstFrameUrl)
        );
      };

      const storeItems = Array.isArray(assetStore?.items) ? assetStore.items : [];
      let catalogItems = [];
      let catalogError = '';
      try {
        const response = await fetch('/api/assets/library', { credentials: 'include', cache: 'no-store' });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          catalogError = payload?.error?.message || 'asset-library-http-' + response.status;
        } else {
          catalogItems = Array.isArray(payload?.items) ? payload.items : [];
        }
      } catch (error) {
        catalogError = error instanceof Error ? error.message : String(error);
      }

      const storeRecordingMatches = storeItems.filter(matchesRecordingItem).map(summarizeItem);
      const catalogRecordingMatches = catalogItems.filter(matchesRecordingItem).map(summarizeItem);
      const storeThumbnailMatches = storeItems.filter(matchesThumbnailItem).map(summarizeItem);
      const catalogThumbnailMatches = catalogItems.filter(matchesThumbnailItem).map(summarizeItem);
      const ready = Boolean(
        videoUrl
        && firstFrameUrl
        && derivedRegion?.data?.videoUrl === videoUrl
        && storeRecordingMatches.length > 0
        && catalogRecordingMatches.length > 0
        && storeThumbnailMatches.length > 0
        && catalogThumbnailMatches.length > 0
        && !catalogError
      );
      return {
        ready,
        catalogError,
        dccNode: {
          id: dccNode?.id || '',
          videoUrl,
          recordingAssetId,
          recordingSourceUrl: String(dccParams?.recordingSourceUrl || ''),
          recordingOriginalUrl: String(dccParams?.recordingOriginalUrl || ''),
          firstFrameUrl,
          outputUrl: String(dccData?.outputs?.[0]?.url || ''),
        },
        materializedVideo: summarizeNode(materializedVideo),
        derivedRegion: summarizeNode(derivedRegion),
        storeRecordingMatches,
        catalogRecordingMatches,
        storeThumbnailMatches,
        catalogThumbnailMatches,
        storeDccItemCount: storeItems.filter((item) => String(item?.folderId || '') === 'dcc').length,
        catalogDccItemCount: catalogItems.filter((item) => String(item?.folderId || '') === 'dcc').length,
      };
    })()
  `, 15000);
}

async function verifyDccCapturePersistence(cdp, recorder, nodeId, derivedState, timeoutMs = 45000) {
  const state = await waitForState(
    'DCC capture persistence verification',
    () => readDccCapturePersistenceState(cdp, nodeId),
    (value) => Boolean(value?.ready),
    timeoutMs,
    500,
  );
  assert(state.dccNode.imageUrl, 'DCC capture node did not retain an imageUrl after persistence.', state);
  assert(state.derivedRegion?.imageUrl === state.dccNode.imageUrl, 'DCC capture region node did not read back the persisted image URL.', state);
  assert(state.catalogCaptureMatches?.length > 0, 'DCC capture asset did not persist into the asset catalog.', state);
  const renderState = await waitForRenderedRegionImageSafe(cdp, state.derivedRegion.id, 60000);
  assert(renderState.hasImage && renderState.currentSrc, 'DCC capture tagging node did not render the persisted image on canvas.', renderState);
  await recorder('dcc-capture-asset-library-verified', { nodeId, derivedState, persistence: state, renderState });
  return { ...state, renderState };
}

async function verifyDccRecordingPersistence(cdp, recorder, nodeId, derivedState, timeoutMs = 60000) {
  const state = await waitForState(
    'DCC recording persistence verification',
    () => readDccRecordingPersistenceState(cdp, nodeId),
    (value) => Boolean(value?.ready),
    timeoutMs,
    500,
  );
  assert(state.dccNode.videoUrl, 'DCC recording node did not retain a videoUrl after persistence.', state);
  assert(state.dccNode.firstFrameUrl, 'DCC recording node did not retain a persisted first-frame URL.', state);
  assert(state.derivedRegion?.videoUrl === state.dccNode.videoUrl, 'DCC recording region node did not read back the persisted recording URL.', state);
  assert(state.catalogRecordingMatches?.length > 0, 'DCC recording asset did not persist into the asset catalog.', state);
  assert(state.catalogThumbnailMatches?.length > 0, 'DCC recording first-frame thumbnail did not persist into the asset catalog.', state);
  const renderState = await waitForRenderedRegionVideoSafe(cdp, state.derivedRegion.id, 90000);
  assert(renderState.hasVideo && renderState.currentSrc, 'DCC recording tagging node did not render the persisted video on canvas.', renderState);
  await recorder('dcc-recording-asset-library-verified', { nodeId, derivedState, persistence: state, renderState });
  await recorder('dcc-recording-canvas-writeback-verified', {
    nodeId,
    videoUrl: state.dccNode.videoUrl,
    firstFrameUrl: state.dccNode.firstFrameUrl,
    materializedVideo: state.materializedVideo,
    derivedRegion: state.derivedRegion,
    renderState,
  });
  return { ...state, renderState };
}

async function waitForNodeMounted(cdp, nodeType, nodeId, timeoutMs = 30000) {
  await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(`[data-testid="${nodeType}-node-${nodeId}"]`)}))`, timeoutMs, 250);
}

async function focusDerivedNodeNearDcc(cdp, nodeId, nodeType) {
  const state = await evalJs(cdp, `
    (async () => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      const nodes = store?.canvas?.nodes || [];
      const target = nodes.find((node) => node.id === ${JSON.stringify(nodeId)});
      const dcc = [...nodes].reverse().find((node) => node.type === 'dcc');
      if (!store || !target || !dcc) return { ok: false, reason: 'missing-store-target-or-dcc', nodeCount: nodes.length };
      const nextPosition = {
        x: Number(dcc.position?.x || 0) + (${JSON.stringify(nodeType)} === 'image' ? 680 : 760),
        y: Number(dcc.position?.y || 0) + (${JSON.stringify(nodeType)} === 'image' ? 0 : 360),
      };
      if (typeof store.moveNode === 'function') store.moveNode(${JSON.stringify(nodeId)}, nextPosition);
      if (typeof store.setSelectedNodeIds === 'function') store.setSelectedNodeIds([${JSON.stringify(nodeId)}]);
      const flow = window.__HMDAO_DEBUG__?.reactFlow;
      const center = {
        x: nextPosition.x + (${JSON.stringify(nodeType)} === 'image' ? 300 : 340),
        y: nextPosition.y + (${JSON.stringify(nodeType)} === 'image' ? 220 : 260),
      };
      if (typeof flow?.setCenter === 'function') {
        await flow.setCenter(center.x, center.y, { zoom: 0.55, duration: 0 });
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const selector = ${JSON.stringify(nodeType)} === 'image'
        ? ${JSON.stringify(`[data-testid="image-node-${nodeId}"]`)}
        : ${JSON.stringify(`[data-testid="video-node-${nodeId}"]`)};
      return {
        ok: true,
        nodeId: ${JSON.stringify(nodeId)},
        nodeType: ${JSON.stringify(nodeType)},
        nextPosition,
        center,
        dccPosition: dcc.position,
        flowBridge: Boolean(flow?.setCenter),
        domMounted: Boolean(document.querySelector(selector)),
        viewport: typeof flow?.getViewport === 'function' ? flow.getViewport() : null,
      };
    })()
  `, 10000);
  assert(state?.ok, `Unable to focus ${nodeType} derived node near DCC node.`, state);
  await sleep(250);
  return state;
}

async function waitForWorkflowCreateFrameOrNull(workflowFrames, initialCount, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (workflowFrames.length > initialCount) return workflowFrames[workflowFrames.length - 1];
    await sleep(200);
  }
  return null;
}

async function waitForGenerationCompletion(cdp, nodeId, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const node = await readNode(cdp, nodeId);
    const status = String(node?.data?.status || '');
    if (status === 'completed') return node;
    if (status === 'error') throw new Error(`Generation failed for ${nodeId}: ${String(node?.data?.error || 'unknown error')}`);
    await sleep(1000);
  }
  const node = await readNode(cdp, nodeId).catch(() => null);
  throw new Error(`Timed out waiting for node ${nodeId} to finish generation: ${JSON.stringify(node)}`);
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
        renderErrorVisible: text.includes('鐠у嫭绨〒鍙夌厠婢惰精瑙?),
        posterOverlayVisible: Boolean(root?.querySelector('[data-testid="image-poster-overlay"]')),
        text: text.slice(0, 500),
      };
    })()
  `, 10000);
}

async function waitForRenderedImage(cdp, nodeId, timeoutMs = 60000) {
  await waitFor(cdp, `
    (() => {
      const root = document.querySelector(${JSON.stringify(`[data-testid="image-node-${nodeId}"]`)});
      const img = root?.querySelector('img');
      const text = root?.textContent || '';
      return Boolean(
        img
        && Number(img.naturalWidth || 0) > 0
        && Number(img.naturalHeight || 0) > 0
        && !text.includes('鐠у嫭绨〒鍙夌厠婢惰精瑙?)
      );
    })()
  `, timeoutMs, 350);
  return readImageRenderState(cdp, nodeId);
}

async function readVideoRenderState(cdp, nodeId) {
  return evalJs(cdp, `
    (() => {
      const root = document.querySelector(${JSON.stringify(`[data-testid="video-node-${nodeId}"]`)});
      const video = root?.querySelector('video');
      const text = root?.textContent || '';
      return {
        hasRoot: Boolean(root),
        hasVideo: Boolean(video),
        currentSrc: video?.currentSrc || video?.getAttribute('src') || '',
        readyState: Number(video?.readyState || 0),
        videoWidth: Number(video?.videoWidth || 0),
        videoHeight: Number(video?.videoHeight || 0),
        networkState: Number(video?.networkState || 0),
        renderErrorVisible: text.includes('鐠у嫭绨〒鍙夌厠婢惰精瑙?),
        text: text.slice(0, 500),
      };
    })()
  `, 10000);
}

async function waitForRenderedVideo(cdp, nodeId, timeoutMs = 90000) {
  await waitFor(cdp, `
    (() => {
      const root = document.querySelector(${JSON.stringify(`[data-testid="video-node-${nodeId}"]`)});
      const video = root?.querySelector('video');
      const text = root?.textContent || '';
      return Boolean(
        video
        && String(video.currentSrc || video.getAttribute('src') || '').length > 0
        && Number(video.readyState || 0) >= 1
        && !text.includes('鐠у嫭绨〒鍙夌厠婢惰精瑙?)
      );
    })()
  `, timeoutMs, 500);
  return readVideoRenderState(cdp, nodeId);
}

async function readImageRenderStateSafe(cdp, nodeId) {
  return evalJs(cdp, `
    (() => {
      const root = document.querySelector(${JSON.stringify(`[data-testid="image-node-${nodeId}"]`)});
      const img = root?.querySelector('img');
      const text = root?.textContent || '';
      const renderErrorVisible = /(?:render|load)\\s+failed|error|\\u52a0\\u8f7d\\u5931\\u8d25|\\u6e32\\u67d3\\u5931\\u8d25/i.test(text);
      return {
        hasRoot: Boolean(root),
        hasImage: Boolean(img),
        currentSrc: img?.currentSrc || img?.getAttribute('src') || '',
        naturalWidth: Number(img?.naturalWidth || 0),
        naturalHeight: Number(img?.naturalHeight || 0),
        complete: Boolean(img?.complete),
        renderErrorVisible,
        posterOverlayVisible: Boolean(root?.querySelector('[data-testid="image-poster-overlay"]')),
        text: text.slice(0, 500),
      };
    })()
  `, 10000);
}

async function waitForRenderedImageSafe(cdp, nodeId, timeoutMs = 60000) {
  await waitFor(cdp, `
    (() => {
      const root = document.querySelector(${JSON.stringify(`[data-testid="image-node-${nodeId}"]`)});
      const img = root?.querySelector('img');
      const text = root?.textContent || '';
      const renderErrorVisible = /(?:render|load)\\s+failed|error|\\u52a0\\u8f7d\\u5931\\u8d25|\\u6e32\\u67d3\\u5931\\u8d25/i.test(text);
      return Boolean(
        img
        && Number(img.naturalWidth || 0) > 0
        && Number(img.naturalHeight || 0) > 0
        && !renderErrorVisible
      );
    })()
  `, timeoutMs, 350);
  return readImageRenderStateSafe(cdp, nodeId);
}

async function readRegionImageRenderStateSafe(cdp, nodeId) {
  return evalJs(cdp, `
    (() => {
      const root = document.querySelector(${JSON.stringify(`[data-testid="tagging-node-${nodeId}"]`)});
      const image = root?.querySelector(${JSON.stringify(`[data-testid="tagging-preview-image-${nodeId}"]`)});
      const text = root?.textContent || '';
      const renderErrorVisible = /(?:render|load)\\s+failed|error|\\u52a0\\u8f7d\\u5931\\u8d25|\\u6e32\\u67d3\\u5931\\u8d25/i.test(text);
      return {
        hasRoot: Boolean(root),
        hasImage: Boolean(image),
        currentSrc: image?.currentSrc || image?.getAttribute('src') || '',
        naturalWidth: Number(image?.naturalWidth || 0),
        naturalHeight: Number(image?.naturalHeight || 0),
        renderErrorVisible,
        text: text.slice(0, 500),
      };
    })()
  `, 10000);
}

async function waitForRenderedRegionImageSafe(cdp, nodeId, timeoutMs = 60000) {
  await waitFor(cdp, `
    (() => {
      const root = document.querySelector(${JSON.stringify(`[data-testid="tagging-node-${nodeId}"]`)});
      const image = root?.querySelector(${JSON.stringify(`[data-testid="tagging-preview-image-${nodeId}"]`)});
      const text = root?.textContent || '';
      const renderErrorVisible = /(?:render|load)\\s+failed|error|\\u52a0\\u8f7d\\u5931\\u8d25|\\u6e32\\u67d3\\u5931\\u8d25/i.test(text);
      return Boolean(
        image
        && Number(image.naturalWidth || 0) > 0
        && Number(image.naturalHeight || 0) > 0
        && !renderErrorVisible
      );
    })()
  `, timeoutMs, 350);
  return readRegionImageRenderStateSafe(cdp, nodeId);
}

async function readVideoRenderStateSafe(cdp, nodeId) {
  return evalJs(cdp, `
    (() => {
      const root = document.querySelector(${JSON.stringify(`[data-testid="video-node-${nodeId}"]`)});
      const video = root?.querySelector('video');
      const text = root?.textContent || '';
      const renderErrorVisible = /(?:render|load)\\s+failed|error|\\u52a0\\u8f7d\\u5931\\u8d25|\\u6e32\\u67d3\\u5931\\u8d25/i.test(text);
      return {
        hasRoot: Boolean(root),
        hasVideo: Boolean(video),
        currentSrc: video?.currentSrc || video?.getAttribute('src') || '',
        readyState: Number(video?.readyState || 0),
        videoWidth: Number(video?.videoWidth || 0),
        videoHeight: Number(video?.videoHeight || 0),
        networkState: Number(video?.networkState || 0),
        renderErrorVisible,
        text: text.slice(0, 500),
      };
    })()
  `, 10000);
}

async function waitForRenderedVideoSafe(cdp, nodeId, timeoutMs = 90000) {
  await waitFor(cdp, `
    (() => {
      const root = document.querySelector(${JSON.stringify(`[data-testid="video-node-${nodeId}"]`)});
      const video = root?.querySelector('video');
      const text = root?.textContent || '';
      const renderErrorVisible = /(?:render|load)\\s+failed|error|\\u52a0\\u8f7d\\u5931\\u8d25|\\u6e32\\u67d3\\u5931\\u8d25/i.test(text);
      return Boolean(
        video
        && String(video.currentSrc || video.getAttribute('src') || '').length > 0
        && Number(video.readyState || 0) >= 1
        && !renderErrorVisible
      );
    })()
  `, timeoutMs, 500);
  return readVideoRenderStateSafe(cdp, nodeId);
}

async function readRegionVideoRenderStateSafe(cdp, nodeId) {
  return evalJs(cdp, `
    (() => {
      const root = document.querySelector(${JSON.stringify(`[data-testid="tagging-node-${nodeId}"]`)});
      const video = root?.querySelector(${JSON.stringify(`[data-testid="tagging-preview-video-${nodeId}"]`)});
      const text = root?.textContent || '';
      const renderErrorVisible = /(?:render|load)\\s+failed|error|\\u52a0\\u8f7d\\u5931\\u8d25|\\u6e32\\u67d3\\u5931\\u8d25/i.test(text);
      return {
        hasRoot: Boolean(root),
        hasVideo: Boolean(video),
        currentSrc: video?.currentSrc || video?.getAttribute('src') || '',
        readyState: Number(video?.readyState || 0),
        videoWidth: Number(video?.videoWidth || 0),
        videoHeight: Number(video?.videoHeight || 0),
        networkState: Number(video?.networkState || 0),
        renderErrorVisible,
        text: text.slice(0, 500),
      };
    })()
  `, 10000);
}

async function waitForRenderedRegionVideoSafe(cdp, nodeId, timeoutMs = 90000) {
  await waitFor(cdp, `
    (() => {
      const root = document.querySelector(${JSON.stringify(`[data-testid="tagging-node-${nodeId}"]`)});
      const video = root?.querySelector(${JSON.stringify(`[data-testid="tagging-preview-video-${nodeId}"]`)});
      const text = root?.textContent || '';
      const renderErrorVisible = /(?:render|load)\\s+failed|error|\\u52a0\\u8f7d\\u5931\\u8d25|\\u6e32\\u67d3\\u5931\\u8d25/i.test(text);
      return Boolean(
        video
        && String(video.currentSrc || video.getAttribute('src') || '').length > 0
        && Number(video.readyState || 0) >= 1
        && !renderErrorVisible
      );
    })()
  `, timeoutMs, 500);
  return readRegionVideoRenderStateSafe(cdp, nodeId);
}

function readOutputMeta(node) {
  return node?.data?.outputs?.[0]?.metadata || {};
}

function isRemoteAssetUrl(value) {
  return /^https?:\/\//i.test(String(value || ''));
}

function isProceduralFallbackMeta(outputMeta) {
  const haystack = [
    outputMeta?.workflowFallbackReason,
    outputMeta?.fallbackReason,
    outputMeta?.reason,
    outputMeta?.fallbackType,
    outputMeta?.outputMode,
    outputMeta?.sourceKind,
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase())
    .join(' ');
  return /procedural|mock|placeholder|local|offline/.test(haystack);
}

function isRealUpstreamProxyFallback(outputMeta) {
  if (!outputMeta?.workflowFallback) return false;
  if (!isRemoteAssetUrl(outputMeta.originalUrl)) return false;
  if (isProceduralFallbackMeta(outputMeta)) return false;
  if (!String(outputMeta.provider || '').length) return false;
  if (!String(outputMeta.model || '').length) return false;
  return true;
}

function assertNoFallbackOutput(node, label) {
  const outputMeta = readOutputMeta(node);
  if (outputMeta.workflowFallback || outputMeta.workflowFallbackReason) {
    assert(
      isRealUpstreamProxyFallback(outputMeta),
      `${label} returned a local or procedural fallback result.`,
      outputMeta,
    );
  }
  return outputMeta;
}

async function ensureDccNodeControlsVisible(cdp, nodeId) {
  await selectNodeById(cdp, nodeId);
  await waitFor(cdp, `
    (() => {
      const snapshot = window.__HMDAO_DEBUG__?.readCanvasSnapshot?.();
      const hasSelection = Array.isArray(snapshot?.selectedNodeIds)
        && snapshot.selectedNodeIds.length === 1
        && snapshot.selectedNodeIds[0] === ${JSON.stringify(nodeId)};
      const connectButton = document.querySelector(${JSON.stringify(`[data-testid="dcc-connect-${nodeId}"]`)});
      const engineSelect = document.querySelector(${JSON.stringify(`[data-testid="dcc-engine-${nodeId}"]`)});
      return hasSelection && Boolean(connectButton) && Boolean(engineSelect);
    })()
  `, 30000, 250);
}

async function applyAndVerifyDccResolution(cdp, recorder, nodeId, width, height, label) {
  await ensureDccNodeControlsVisible(cdp, nodeId);
  await setValue(cdp, `[data-testid="dcc-resolution-width-${nodeId}"]`, String(width));
  await setValue(cdp, `[data-testid="dcc-resolution-height-${nodeId}"]`, String(height));
  await clickSelector(cdp, `[data-testid="dcc-resolution-apply-${nodeId}"]`);
  const state = await waitFor(cdp, `
    (() => {
      const node = (window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || []).find((item) => item.id === ${JSON.stringify(nodeId)});
      const resolution = node?.data?.params?.resolution || {};
      const root = document.querySelector(${JSON.stringify(`[data-testid="dcc-node-${nodeId}"]`)});
      const shell = root?.querySelector('canvas')?.parentElement?.parentElement;
      const frame = root?.querySelector('canvas')?.parentElement;
      const shellRect = shell?.getBoundingClientRect?.();
      const frameRect = frame?.getBoundingClientRect?.();
      const ok = Number(resolution.width || 0) === ${Number(width)} && Number(resolution.height || 0) === ${Number(height)};
      return ok ? {
        resolution,
        shellRect: shellRect ? { width: Math.round(shellRect.width), height: Math.round(shellRect.height) } : null,
        frameRect: frameRect ? { width: Math.round(frameRect.width), height: Math.round(frameRect.height) } : null,
        portrait: Number(resolution.height || 0) > Number(resolution.width || 0),
      } : false;
    })()
  `, 15000, 150);
  if (height > width) {
    assert(state?.frameRect?.height > state?.frameRect?.width, 'DCC portrait resolution did not render as a portrait preview frame.', state);
  } else {
    assert(state?.frameRect?.width > state?.frameRect?.height, 'DCC landscape resolution did not render as a landscape preview frame.', state);
  }
  await recorder(`dcc-custom-resolution-${label}`, { nodeId, requested: { width, height }, state });
  return state;
}

async function stageRecorder(cdp, baseDir, wsEvents) {
  let counter = 0;
  return async (label, extra = {}) => {
    counter += 1;
    const prefix = `${String(counter).padStart(2, '0')}-${sanitizeFilePart(label)}`;
    const pngPath = path.join(baseDir, `${prefix}.png`);
    const jsonPath = path.join(baseDir, `${prefix}.json`);
    const snapshot = await readCanvasSnapshot(cdp);
    const dccStatus = await readDccStatus().catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
    const stageState = {
      label,
      capturedAt: new Date().toISOString(),
      wsEventCount: wsEvents.length,
      wsEvents: wsEvents.slice(-12),
      dccStatus,
      snapshot,
      ...extra,
    };
    await screenshot(cdp, pngPath);
    await fs.writeFile(jsonPath, JSON.stringify(stageState, null, 2), 'utf8');
    log(`Stage captured: ${label}`, { screenshot: pngPath, state: jsonPath });
    return { pngPath, jsonPath, state: stageState };
  };
}

async function ensureAuthenticated(cdp) {
  const readyUrl = new URL(appUrl);
  readyUrl.searchParams.set('skipLaunch', '1');
  await navigateAndWait(cdp, readyUrl.toString(), 'document.body != null');
  await evalJs(cdp, `
    localStorage.setItem('hmdao-auth-storage', JSON.stringify({
      state: {
        user: { id: 'dcc-browser', email: 'dcc-browser@hmdao.local', createdAt: new Date().toISOString() },
        session: { accessToken: 'dcc', refreshToken: 'dcc', expiresAt: Date.now() + 3600000 },
        hasHydrated: true,
        isLoading: false,
      },
      version: 0,
    }));
    sessionStorage.setItem('ddup-launch-complete', '1');
    true;
  `);
  // Initial Vite module compilation can take noticeably longer than the HTTP health check.
  await navigateAndWait(cdp, readyUrl.toString(), 'location.pathname === "/" && !!document.querySelector(".react-flow")', 90000);
}

async function addDccNode(cdp, recorder) {
  await clickSelector(cdp, '[data-testid="add-node-dcc"]');
  await waitFor(cdp, 'window.__HMDAO_DEBUG__?.readCanvasSnapshot?.()?.nodeCount >= 1', 30000);
  const nodeId = await latestNodeIdByType(cdp, 'dcc');
  if (!nodeId) throw new Error('Failed to create a DCC node on the canvas.');
  await ensureDccNodeControlsVisible(cdp, nodeId);
  await recorder('dcc-node-added', { nodeId });
  return nodeId;
}

async function connectUnreal(cdp, recorder, nodeId) {
  const status = await readDccStatus();
  const unrealStatus = status?.engines?.unreal || null;
  if (!unrealStatus?.hostProcessRunning || !unrealStatus?.targetProjectRunning) {
    throw new Error(`Unreal host-first retest requires the editor window and target project to be running before Connect. Current status: ${JSON.stringify(unrealStatus)}`);
  }
  const bridgeWasAlreadyOnline = Boolean(unrealStatus?.directBridgeOnline && unrealStatus?.directBridgePlugin);
  await ensureDccNodeControlsVisible(cdp, nodeId);
  await setValue(cdp, `[data-testid="dcc-engine-${nodeId}"]`, "unreal");
  await recorder('dcc-engine-unreal-selected', {
    nodeId,
    directBridgePlugin: unrealStatus?.directBridgePlugin || null,
    hostProcessRunning: unrealStatus?.hostProcessRunning || false,
    targetProjectRunning: unrealStatus?.targetProjectRunning || false,
    bridgeWasAlreadyOnline,
  });
  await ensureDccNodeControlsVisible(cdp, nodeId);
  await clickSelector(cdp, `[data-testid="dcc-connect-${nodeId}"]`);
  await recorder('dcc-connect-triggered', { nodeId, bridgeWasAlreadyOnline });

  const confirmedStatus = await waitForDccStatus(
    bridgeWasAlreadyOnline
      ? 'Unreal direct bridge to remain online after clicking Connect'
      : 'Unreal direct bridge to come online after clicking Connect',
    (nextStatus) => Boolean(
      nextStatus?.engines?.unreal?.directBridgeOnline
      && nextStatus?.engines?.unreal?.directBridgePlugin
    ),
    90000,
    1000,
  );
  await waitForDccPreviewFrame(cdp, nodeId, 45000);
  if (!confirmedStatus?.engines?.unreal?.directBridgeOnline || !confirmedStatus?.engines?.unreal?.directBridgePlugin) {
    throw new Error(`Unreal preview became visible but the real direct bridge is not confirmed: ${JSON.stringify(confirmedStatus?.engines?.unreal || null)}`);
  }
  await recorder('dcc-preview-live', {
    nodeId,
    bridgeWasAlreadyOnline,
    directBridgePlugin: confirmedStatus.engines.unreal.directBridgePlugin,
    directBridgeReadyForTargetProject: confirmedStatus.engines.unreal.directBridgeReadyForTargetProject || false,
    cameraCount: confirmedStatus.engines.unreal.cameraCount || 0,
  });
  await verifyCameraSwitchDiff(cdp, recorder, nodeId);
}

async function connectBlender(cdp, recorder, nodeId) {
  const status = await readDccStatus();
  const blenderStatus = status?.engines?.blender || null;
  const serviceWasAlreadyOnline = Boolean(blenderStatus?.reachable);
  await ensureDccNodeControlsVisible(cdp, nodeId);
  await setValue(cdp, `[data-testid="dcc-engine-${nodeId}"]`, "blender");
  await recorder('dcc-engine-blender-selected', { nodeId, serviceWasAlreadyOnline });
  await ensureDccNodeControlsVisible(cdp, nodeId);
  await clickSelector(cdp, `[data-testid="dcc-connect-${nodeId}"]`);
  await recorder('dcc-connect-triggered', { nodeId, serviceWasAlreadyOnline });

  await waitForDccStatus(
    serviceWasAlreadyOnline
      ? 'Blender capture service on 127.0.0.1:8766 to remain online after clicking Connect'
      : 'Blender capture service on 127.0.0.1:8766 to come online after clicking Connect',
    (nextStatus) => Boolean(nextStatus?.engines?.blender?.reachable),
    90000,
    1000,
  );
  await waitForDccPreviewFrame(cdp, nodeId, 45000);
  await recorder('dcc-preview-live', { nodeId, serviceWasAlreadyOnline });
}

async function captureImageNode(cdp, recorder, nodeId) {
  await ensureDccNodeControlsVisible(cdp, nodeId);
  const beforeCount = await evalJs(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      return nodes.filter((node) => (
        node.type === 'region'
        && node.data?.params?.sourceNodeId === ${JSON.stringify(nodeId)}
        && node.data?.params?.sourceMediaType === 'image'
      )).length;
    })()
  `, 10000);
  await clickSelector(cdp, `[data-testid="dcc-capture-${nodeId}"]`);
  await recorder('dcc-capture-triggered', { nodeId, beforeCount });
  await waitFor(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const regionCount = nodes.filter((node) => (
        node.type === 'region'
        && node.data?.params?.sourceNodeId === ${JSON.stringify(nodeId)}
        && node.data?.params?.sourceMediaType === 'image'
      )).length;
      const dccNode = nodes.find((node) => node.id === ${JSON.stringify(nodeId)});
      return regionCount > ${Number(beforeCount)} && Boolean(dccNode?.data?.imageUrl);
    })()
  `, 45000, 400);
  const derivedState = await evalJs(cdp, `
    (() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      const nodes = store?.canvas?.nodes || [];
      const edges = store?.canvas?.edges || [];
      const derived = [...nodes].reverse().find((node) => (
        node.type === 'region'
        && node.data?.params?.sourceNodeId === ${JSON.stringify(nodeId)}
        && node.data?.params?.sourceMediaType === 'image'
      )) || null;
      const params = derived?.data?.params || {};
      return {
        derivedId: derived?.id || '',
        sourceMediaType: params.sourceMediaType || '',
        label: derived?.data?.label || '',
        imageUrl: derived?.data?.imageUrl || '',
        edgeLinked: edges.some((edge) => edge.source === ${JSON.stringify(nodeId)} && edge.target === derived?.id),
      };
    })()
  `, 10000);
  if (!derivedState.derivedId || derivedState.sourceMediaType !== 'image' || !derivedState.imageUrl || !derivedState.edgeLinked) {
    throw new Error(`DCC image region node was not created correctly: ${JSON.stringify(derivedState)}`);
  }
  await recorder('dcc-capture-region-node-created', { nodeId, derivedState });
  return derivedState;
}

async function recordVideoNode(cdp, recorder, wsEvents, nodeId, options = {}) {
  const startFrameValue = Number.isFinite(Number(options.startFrame)) ? Number(options.startFrame) : 1;
  const endFrameValue = Number.isFinite(Number(options.endFrame)) ? Number(options.endFrame) : 24;
  const fpsValue = Number.isFinite(Number(options.fps)) ? Number(options.fps) : 12;
  const settleMs = Number.isFinite(Number(options.settleMs)) ? Number(options.settleMs) : 4200;
  const outputTimeoutMs = Number.isFinite(Number(options.outputTimeoutMs)) ? Number(options.outputTimeoutMs) : recordOutputTimeoutMs;
  const motionSamples = Number.isFinite(Number(options.motionSamples)) ? Number(options.motionSamples) : 7;
  const motionIntervalMs = Number.isFinite(Number(options.motionIntervalMs)) ? Number(options.motionIntervalMs) : 320;
  await ensureDccNodeControlsVisible(cdp, nodeId);
  await setValue(cdp, `[data-testid="dcc-video-quality-${nodeId}"]`, requestedVideoQuality);
  await setValue(cdp, `[data-testid="dcc-start-frame-${nodeId}"]`, String(startFrameValue));
  await setValue(cdp, `[data-testid="dcc-end-frame-${nodeId}"]`, String(endFrameValue));
  await setValue(cdp, `[data-testid="dcc-fps-${nodeId}"]`, String(fpsValue));
  await recorder('dcc-recording-params-set', { nodeId, startFrame: startFrameValue, endFrame: endFrameValue, fps: fpsValue, settleMs, outputTimeoutMs });

  const recordButtonState = await evalJs(cdp, `
    (() => {
      const element = document.querySelector(${JSON.stringify(`[data-testid="dcc-record-${nodeId}"]`)});
      return {
        exists: Boolean(element),
        disabled: Boolean(element?.disabled),
        ariaDisabled: element?.getAttribute?.('aria-disabled') || '',
        title: element?.getAttribute?.('title') || '',
      };
    })()
  `, 10000);
  const dccNodeRuntimeState = await evalJs(cdp, `
    (() => {
      const runtimeState = window.__HMDAO_DEBUG__?.dccNodeRuntimeState || {};
      return runtimeState[${JSON.stringify(nodeId)}] || null;
    })()
  `, 10000).catch(() => null);
  const beforeCount = await evalJs(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      return nodes.filter((node) => (
        node.type === 'region'
        && node.data?.params?.sourceNodeId === ${JSON.stringify(nodeId)}
        && node.data?.params?.sourceMediaType === 'video'
      )).length;
    })()
  `, 10000);
  await clickSelector(cdp, `[data-testid="dcc-record-${nodeId}"]`);
  const wsEventStart = wsEvents.length;
  const stopSelector = `[data-testid="dcc-stop-${nodeId}"]`;
  let stopVisibleQuickly = false;
  try {
    await waitFor(cdp, `!!document.querySelector(${JSON.stringify(stopSelector)})`, 4000, 120);
    stopVisibleQuickly = true;
  } catch {
    stopVisibleQuickly = false;
  }
  await recorder('dcc-record-triggered', { nodeId, beforeCount, wsEventStart, stopVisibleQuickly, recordButtonState, dccNodeRuntimeState });

  const wsRecordingStarted = wsEvents.slice(wsEventStart).some((event) => event.frameType === 'recording_started');
  const wsRecordingTerminalSeen = wsEvents.slice(wsEventStart).some((event) => (
    event.frameType === 'recording_done'
    || event.frameType === 'recording_stopped'
    || event.frameType === 'record_done'
  ));
  if (!stopVisibleQuickly && !wsRecordingStarted && !wsRecordingTerminalSeen) {
    await recorder('dcc-recording-start-deferred', {
      nodeId,
      note: 'No immediate stop control or recording_started event was observed. Continue to downstream output verification because Unreal direct recording can finish with a terminal event only.',
      wsEventStart,
      recentWsEvents: wsEvents.slice(Math.max(0, wsEventStart - 2)),
    });
  }
  const motion = await sampleDccPreviewMotion(cdp, nodeId, motionSamples, motionIntervalMs);
  const wsMotion = summarizeDccWsFrameMotion(wsEvents, wsEventStart);
  await recorder('dcc-recording-live', {
    nodeId,
    motion,
    wsMotion,
    motionSamples,
    motionIntervalMs,
    stopVisibleQuickly,
    wsRecordingStarted,
    wsRecordingTerminalSeen,
  });
  if (!motion.motionDetected && !wsMotion.motionDetected) {
    await recorder('dcc-recording-motion-deferred', {
      nodeId,
      note: 'No motion was visible in the initial sampling window. Continue to downstream recording output verification before failing this run.',
      motion,
      wsMotion,
    });
  }
  await sleep(settleMs);
  await waitFor(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const regionCount = nodes.filter((node) => (
        node.type === 'region'
        && node.data?.params?.sourceNodeId === ${JSON.stringify(nodeId)}
        && node.data?.params?.sourceMediaType === 'video'
      )).length;
      const dccNode = nodes.find((node) => node.id === ${JSON.stringify(nodeId)});
      return regionCount > ${Number(beforeCount)} && Boolean(dccNode?.data?.videoUrl);
    })()
  `, outputTimeoutMs, 500);
  const derivedState = await evalJs(cdp, `
    (() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      const nodes = store?.canvas?.nodes || [];
      const edges = store?.canvas?.edges || [];
      const derived = [...nodes].reverse().find((node) => (
        node.type === 'region'
        && node.data?.params?.sourceNodeId === ${JSON.stringify(nodeId)}
        && node.data?.params?.sourceMediaType === 'video'
      )) || null;
      const params = derived?.data?.params || {};
      return {
        derivedId: derived?.id || '',
        sourceMediaType: params.sourceMediaType || '',
        label: derived?.data?.label || '',
        videoUrl: derived?.data?.videoUrl || '',
        edgeLinked: edges.some((edge) => edge.source === ${JSON.stringify(nodeId)} && edge.target === derived?.id),
      };
    })()
  `, 10000);
  if (!derivedState.derivedId || derivedState.sourceMediaType !== 'video' || !derivedState.videoUrl || !derivedState.edgeLinked) {
    throw new Error(`DCC video region node was not created correctly: ${JSON.stringify(derivedState)}`);
  }
  await recorder('dcc-recording-region-node-created', { nodeId, derivedState });
  await verifyPreviewPostRecordingState(cdp, recorder, nodeId);
  return derivedState;
}

async function generateDccDerivedImage(cdp, recorder, derivedState, workflowFrames) {
  const nodeId = derivedState?.derivedId;
  assert(nodeId, 'DCC derived image node id is missing.', derivedState);
  await focusDerivedNodeNearDcc(cdp, nodeId, 'image');
  await selectNodeById(cdp, nodeId);
  await waitForNodeMounted(cdp, 'image', nodeId);
  await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(`[data-testid="image-generate-${nodeId}"]`)}))`, 30000, 250);
  await setValue(cdp, `[data-testid="image-prompt-${nodeId}"]`, dccImagePrompt);
  const initialCount = workflowFrames.length;
  await recorder('dcc-derived-image-before-generate', {
    nodeId,
    derivedState,
    beforeNode: await readNode(cdp, nodeId),
  });
  await clickSelector(cdp, `[data-testid="image-generate-${nodeId}"]`);
  await waitFor(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
      return String(node?.data?.status || '') === 'generating';
    })()
  `, 20000, 150);

  const frame = await waitForWorkflowCreateFrameOrNull(workflowFrames, initialCount, 30000);
  const workflowBody = frame?.payload?.workflow?.nodes?.[0]?.body || null;
  if (workflowBody) {
    assert(Number(workflowBody.width || 0) === 1280, 'DCC image workflow width was not 1280.', workflowBody);
    assert(Number(workflowBody.height || 0) === 720, 'DCC image workflow height was not 720.', workflowBody);
    assert(String(workflowBody.resolution || '') === '1280x720', 'DCC image workflow resolution label was not 1280x720.', workflowBody);
    assert(String(workflowBody.source_url || '').length > 0, 'DCC image workflow missing source_url.', workflowBody);
  }

  const completedNode = await waitForGenerationCompletion(cdp, nodeId, imageGenerationTimeoutMs);
  const requestBody = completedNode?.data?.params?.requestBody || null;
  const imageUrl = String(completedNode?.data?.imageUrl || completedNode?.data?.outputs?.[0]?.url || '');
  const outputMeta = assertNoFallbackOutput(completedNode, 'DCC image generation');
  assert(requestBody, 'DCC image requestBody missing after generation.', completedNode);
  assert(Number(requestBody.width || 0) === 1280, 'DCC image requestBody width was not 1280.', requestBody);
  assert(Number(requestBody.height || 0) === 720, 'DCC image requestBody height was not 720.', requestBody);
  assert(String(requestBody.source_url || '').length > 0, 'DCC image requestBody missing source_url.', requestBody);
  assert(imageUrl.length > 0, 'DCC image generation did not expose imageUrl.', completedNode);

  const renderState = await waitForRenderedImageSafe(cdp, nodeId, 90000);
  assert(renderState.naturalWidth > 0 && renderState.naturalHeight > 0, 'DCC image did not render with dimensions.', renderState);
  assert(renderState.posterOverlayVisible, 'DCC image poster overlay did not render.', renderState);
  await recorder('dcc-derived-image-real-rendered', {
    nodeId,
    workflowBody,
    requestBody,
    imageUrl,
    outputMeta,
    renderState,
  });
  return { nodeId, workflowBody, requestBody, imageUrl, outputMeta, renderState };
}

async function generateDccDerivedVideo(cdp, recorder, derivedState, workflowFrames) {
  const nodeId = derivedState?.derivedId;
  assert(nodeId, 'DCC derived video node id is missing.', derivedState);
  await focusDerivedNodeNearDcc(cdp, nodeId, 'video');
  await selectNodeById(cdp, nodeId);
  await waitForNodeMounted(cdp, 'video', nodeId);
  await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(`[data-testid="video-generate-${nodeId}"]`)}))`, 30000, 250);
  await recorder('dcc-derived-video-panel-ready', {
    nodeId,
    derivedState,
    panelState: await evalJs(cdp, `
      (() => ({
        hasPrompt: Boolean(document.querySelector(${JSON.stringify(`[data-testid="video-prompt-${nodeId}"]`)})),
        hasQuality: Boolean(document.querySelector(${JSON.stringify(`[data-testid="video-quality-${nodeId}"]`)})),
        hasGenerate: Boolean(document.querySelector(${JSON.stringify(`[data-testid="video-generate-${nodeId}"]`)})),
      }))()
    `, 10000),
  });
  await setValue(cdp, `[data-testid="video-quality-${nodeId}"]`, requestedVideoQuality);
  await setValue(cdp, `[data-testid="video-prompt-${nodeId}"]`, dccVideoPrompt);

  const initialCount = workflowFrames.length;
  await recorder('dcc-derived-video-before-generate', {
    nodeId,
    derivedState,
    beforeNode: await readNode(cdp, nodeId),
  });
  await clickSelector(cdp, `[data-testid="video-generate-${nodeId}"]`);
  await waitFor(cdp, `
    (() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const node = nodes.find((item) => item.id === ${JSON.stringify(nodeId)});
      const status = String(node?.data?.status || '');
      return status === 'generating' || ((status === 'completed' || status === 'processing') && Boolean(node?.data?.params?.requestBody));
    })()
  `, 20000, 150);

  const frame = await waitForWorkflowCreateFrameOrNull(workflowFrames, initialCount, 30000);
  const workflowBody = frame?.payload?.workflow?.nodes?.[0]?.body || null;
  assert(workflowBody, 'Timed out waiting for DCC video workflow:create frame.', { nodeId });
  assert(String(workflowBody.quality || '') === requestedVideoQuality, `DCC video workflow did not preserve ${requestedVideoQuality} quality.`, workflowBody);
  assert(String(workflowBody.generation_mode || '') === 'referenceVideo', 'DCC video workflow did not preserve referenceVideo mode.', workflowBody);
  assert(String(workflowBody.first_frame_url || '').startsWith('data:image/'), 'DCC video workflow missing first_frame_url image conditioning.', workflowBody);
  assert(String(workflowBody.reference_video_url || '').length > 0 || String(workflowBody.source_url || '').length > 0, 'DCC video workflow missing reference/source video URL.', workflowBody);
  assert(String(workflowBody.model || '').includes('Wan2.2') || String(workflowBody.model || '').includes('wan22') || String(workflowBody.model || '').includes('Wan-AI/Wan2.2'), 'DCC video workflow did not route to Wan2.2.', workflowBody);

  const completedNode = await waitForGenerationCompletion(cdp, nodeId, videoGenerationTimeoutMs);
  const requestBody = completedNode?.data?.params?.requestBody || null;
  const videoUrl = String(completedNode?.data?.videoUrl || completedNode?.data?.outputs?.[0]?.url || '');
  const outputMeta = assertNoFallbackOutput(completedNode, 'DCC video generation');
  const remoteVideoUrl = String(outputMeta.originalUrl || videoUrl || '');
  assert(requestBody, 'DCC video requestBody missing after generation.', completedNode);
  assert(String(requestBody.quality || '') === requestedVideoQuality, `DCC video requestBody did not preserve ${requestedVideoQuality} quality.`, requestBody);
  assert(String(requestBody.generation_mode || '') === 'referenceVideo', 'DCC video requestBody did not preserve referenceVideo mode.', requestBody);
  assert(String(requestBody.first_frame_url || '').startsWith('data:image/'), 'DCC video requestBody missing first_frame_url image conditioning.', requestBody);
  assert(/^https?:\/\//i.test(remoteVideoUrl), 'DCC video result did not preserve a remote upstream asset URL.', { videoUrl, remoteVideoUrl, outputMeta });
  assert(videoUrl.startsWith('/api/media-proxy?') || /^https?:\/\//i.test(videoUrl), 'DCC video result did not expose a renderable URL.', { videoUrl, remoteVideoUrl, outputMeta });

  const renderState = await waitForRenderedVideoSafe(cdp, nodeId, 120000);
  assert(renderState.hasVideo && renderState.currentSrc, 'DCC video did not render in the video node.', renderState);
  await recorder('dcc-derived-video-real-rendered', {
    nodeId,
    workflowBody,
    requestBody,
    videoUrl,
    outputMeta,
    renderState,
  });
  return { nodeId, workflowBody, requestBody, videoUrl, outputMeta, renderState };
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

export async function main(overrides = {}) {
  const cwd = process.cwd();
  const options = { ...parseCliOptions(process.argv.slice(2)), ...overrides };
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.resolve(cwd, 'artifacts', options.headless ? `dcc-browser-headless-${runId}` : `dcc-browser-visible-${runId}`);
  const children = [];
  const wsEvents = [];
  const workflowFrames = [];
  let realApiHealth = null;
  let realActivation = null;
  let captureRegionResult = null;
  let recordingRegionResult = null;
  let capturePersistenceResult = null;
  let recordingPersistenceResult = null;
  let imageResult = null;
  let videoResult = null;
  let cdp = null;

  await fs.mkdir(runDir, { recursive: true });
  artifactLogPath = path.join(runDir, 'run.log');
  artifactLogInitialized = false;
  artifactLogWriteChain = Promise.resolve();
  if (!chromePath) throw new Error('No supported Chrome or Edge executable found for DCC browser verification.');

  try {
    await ensureService('API', `${apiUrl}/api/health`, () => start('node', ['server/hmdao-api.mjs'], 'api', cwd, children));
    realApiHealth = await ensureRealApiReady();
    await ensureHmdaoAppService(cwd, children);
    if (!Number.isFinite(chromePort) || chromePort <= 0) {
      chromePort = await pickFreePort();
    }

    const userDataDir = path.join(os.tmpdir(), 'hmdao-dcc-browser-profiles', runId);
    await fs.mkdir(userDataDir, { recursive: true });
    const browserArgs = [
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-dev-shm-usage',
      '--disable-features=CalculateNativeWinOcclusion,UseSkiaRenderer',
      '--disable-renderer-backgrounding',
      '--disable-extensions',
      '--mute-audio',
      '--no-default-browser-check',
      '--no-first-run',
      '--remote-allow-origins=*',
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${chromePort}`,
      'about:blank',
    ];

    if (forceSoftwareRenderer) {
      browserArgs.push(
        '--disable-gpu',
        '--use-angle=swiftshader',
        '--use-gl=swiftshader',
        '--enable-unsafe-swiftshader',
      );
    }

    if (options.headless) {
      browserArgs.unshift('--headless=new', '--no-sandbox');
    } else {
      browserArgs.unshift('--new-window');
    }
    if (isEdgePath(chromePath)) browserArgs.push('--disable-features=msWebOOUI');

    log(`Launching browser (${options.headless ? 'headless' : 'visible'}) at ${chromePath}`, {
      forceSoftwareRenderer,
      chromePort,
    });
    start(chromePath, browserArgs, 'browser', cwd, children);

    cdp = await connectCdp();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Log.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 960,
      deviceScaleFactor: 1,
      mobile: false,
    });

    cdp.on('Network.webSocketCreated', (params) => {
      wsEvents.push({ ts: Date.now(), type: 'created', url: params.url });
    });
    cdp.on('Network.webSocketFrameReceived', (params) => {
      const payloadData = params.response?.payloadData;
      let frameType = '';
      let frameHash = '';
      if (typeof payloadData === 'string') {
        try {
          const parsed = JSON.parse(payloadData);
          frameType = typeof parsed?.type === 'string' ? parsed.type : '';
          if (frameType === 'frame') {
            const frameUrl = typeof parsed?.url === 'string' && parsed.url
              ? parsed.url
              : typeof parsed?.payload === 'string'
                ? parsed.payload
                : '';
            if (frameUrl) {
              frameHash = createHash('sha1').update(frameUrl).digest('hex').slice(0, 12);
            }
          }
        } catch {
          // ignore non-JSON frames
        }
      }
      wsEvents.push({
        ts: Date.now(),
        type: 'frame-received',
        requestId: params.requestId,
        frameType,
        frameHash,
        preview: typeof payloadData === 'string' ? payloadData.slice(0, 180) : '',
      });
    });
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
      const text = Array.isArray(params.args)
        ? params.args.map((item) => item.value ?? item.description ?? '').join(' ')
        : '';
      log(`browser console.${params.type || 'log'}: ${text}`);
    });

    await defineNativeSetter(cdp);
    const recorder = await stageRecorder(cdp, runDir, wsEvents);

    await ensureAuthenticated(cdp);
    realActivation = await activateRealSiliconflow(cdp, recorder);
    const nodeId = await addDccNode(cdp, recorder);
    await applyAndVerifyDccResolution(cdp, recorder, nodeId, 720, 1280, 'portrait');
    await applyAndVerifyDccResolution(cdp, recorder, nodeId, 1280, 720, 'landscape');
    if (requestedEngine === 'blender' || !skipUnreal) {
      if (requestedEngine === 'blender') {
        await connectBlender(cdp, recorder, nodeId);
      } else {
        await connectUnreal(cdp, recorder, nodeId);
      }
      if (previewOnly) {
        await recorder('dcc-preview-only', {
          nodeId,
          reason: 'HMDAO_DCC_PREVIEW_ONLY',
        });
      } else {
        captureRegionResult = await captureImageNode(cdp, recorder, nodeId);
        capturePersistenceResult = await verifyDccCapturePersistence(cdp, recorder, nodeId, captureRegionResult);
        recordingRegionResult = await recordVideoNode(cdp, recorder, wsEvents, nodeId, { startFrame: recordStartFrame, endFrame: recordEndFrame, fps: recordFps, settleMs: recordSettleMs, motionSamples: recordMotionSamples, motionIntervalMs: recordMotionIntervalMs });
        recordingPersistenceResult = await verifyDccRecordingPersistence(cdp, recorder, nodeId, recordingRegionResult);
        if (realGenerationEnabled) {
          await recorder('dcc-real-generation-skipped', {
            nodeId,
            reason: 'DCC capture now routes into region contract nodes; browser verification currently validates capture/record routing and preview only.',
          });
        }
      }
    } else {
      await recorder('dcc-unreal-skipped', { nodeId, reason: 'HMDAO_DCC_SKIP_UNREAL' });
    }

    const summary = {
      mode: options.headless ? 'headless' : 'visible',
      apiUrl,
      appUrl,
      artifacts: runDir,
      runLogPath: artifactLogPath,
      summaryTextPath: path.join(runDir, 'summary.txt'),
      nodeId,
      skipUnreal,
      previewOnly,
      requestedEngine,
      wsEventCount: wsEvents.length,
      workflowFrameCount: workflowFrames.length,
      requestedVideoQuality,
      realApiEnabled: Boolean(realApiHealth?.realApiEnabled),
      realActivation: realActivation ? {
        image: { provider: realActivation.image.provider, mode: realActivation.image.mode, model: realActivation.image.model },
        video: { provider: realActivation.video.provider, mode: realActivation.video.mode, model: realActivation.video.model },
      } : null,
      captureRegionResult,
      recordingRegionResult,
      capturePersistenceResult,
      recordingPersistenceResult,
      imageResult: imageResult ? {
        nodeId: imageResult.nodeId,
        imageUrl: imageResult.imageUrl,
        renderState: imageResult.renderState,
        requestBody: imageResult.requestBody,
      } : null,
      videoResult: videoResult ? {
        nodeId: videoResult.nodeId,
        videoUrl: videoResult.videoUrl,
        renderState: videoResult.renderState,
        requestBody: videoResult.requestBody,
      } : null,
    };
    await fs.writeFile(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
    await writeReadableArtifact(summary.summaryTextPath, `${JSON.stringify(summary, null, 2)}\n`);
    log('DCC browser verification completed', summary);
    await artifactLogWriteChain;
    return {
      ...summary,
      cdp,
      runDir,
      cleanup: async () => {
        if (cdp) {
          try { cdp.close(); } catch { /* noop */ }
        }
        await Promise.all(children.map((child) => terminateChild(child)));
      },
    };
  } finally {
    await artifactLogWriteChain.catch(() => {});
    artifactLogPath = '';
    artifactLogInitialized = false;
    if (cdp && !options.keepOpen) {
      try { cdp.close(); } catch { /* noop */ }
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




