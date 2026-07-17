import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

const browserCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

const chromePath = browserCandidates.find((item) => existsSync(item)) || browserCandidates[0];
const apiUrl = String(process.env.HMDAO_API_URL || 'http://127.0.0.1:8792').trim();
const appUrlCandidates = [
  process.env.HMDAO_APP_URL,
  'http://127.0.0.1:3001',
  'http://127.0.0.1:3000',
].filter(Boolean);

function parseCliOptions(argv) {
  const args = new Set(argv);
  return {
    headless: args.has('--visible') ? false : true,
    keepOpen: args.has('--keep-open'),
  };
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

async function pickFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function runProcess(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function runPowerShell(script) {
  const result = await runProcess('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
  if (result.code !== 0) {
    throw new Error(`PowerShell failed (${result.code}): ${result.stderr || result.stdout || script}`);
  }
  return result.stdout.trim();
}

async function stopWindowsProcess(name) {
  await runProcess('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `$p = Get-Process -Name '${name}' -ErrorAction SilentlyContinue; if ($p) { $p | Stop-Process -Force -ErrorAction SilentlyContinue }; exit 0`,
  ]).catch(() => {});
}

async function isHttpReady(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
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

async function resolveAppUrl() {
  for (const candidate of appUrlCandidates) {
    if (await isHttpReady(candidate)) return candidate;
  }
  throw new Error(`Unable to reach app URL. Tried: ${appUrlCandidates.join(', ')}`);
}

async function connectCdp(port) {
  await waitForHttp(`http://127.0.0.1:${port}/json/version`, 30000);
  let target;
  const started = Date.now();
  while (!target && Date.now() - started < 15000) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
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
  let lastError;
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

async function navigateAndWait(cdp, url, readyExpression, timeoutMs = 30000) {
  await cdp.send('Page.navigate', { url });
  await waitFor(cdp, 'document.readyState === "interactive" || document.readyState === "complete"', timeoutMs);
  await waitFor(cdp, readyExpression, timeoutMs);
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

async function screenshot(cdp, filePath) {
  const result = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
  });
  await fs.writeFile(filePath, Buffer.from(result.data, 'base64'));
}

async function ensureAuthenticated(cdp, appUrl) {
  const readyUrl = new URL(appUrl);
  readyUrl.searchParams.set('skipLaunch', '1');
  await navigateAndWait(cdp, readyUrl.toString(), 'document.body != null');
  await evalJs(cdp, `
    localStorage.setItem('hmdao-auth-storage', JSON.stringify({
      state: {
        user: { id: 'dcc-panel-verify', email: 'dcc-panel-verify@hmdao.local', createdAt: new Date().toISOString() },
        session: { accessToken: 'dcc', refreshToken: 'dcc', expiresAt: Date.now() + 3600000 },
        hasHydrated: true,
        isLoading: false,
      },
      version: 0,
    }));
    sessionStorage.setItem('ddup-launch-complete', '1');
    true;
  `);
  await navigateAndWait(cdp, readyUrl.toString(), 'location.pathname === "/" && !!document.querySelector(".react-flow")', 90000);
}

async function openDccPanel(cdp) {
  await clickSelector(cdp, '[data-testid="sidebar-tab-dcc"]');
  await waitFor(cdp, 'Boolean(document.querySelector(\'[data-testid="dcc-environment-panel"]\'))', 30000);
}

async function refreshPanel(cdp) {
  await clickSelector(cdp, '[data-testid="dcc-environment-refresh"]');
  await sleep(600);
}

async function selectEngine(cdp, engine) {
  await clickSelector(cdp, `[data-testid="dcc-environment-engine-${engine}"]`);
  await waitFor(cdp, `(() => {
    const el = document.querySelector('[data-testid="dcc-environment-active-engine"]');
    return el && el.dataset.engine === ${JSON.stringify(engine)};
  })()`, 10000, 200);
}

async function readPanelState(cdp) {
  return await evalJs(cdp, `
    (() => {
      const active = document.querySelector('[data-testid="dcc-environment-active-engine"]');
      const summary = document.querySelector('[data-testid="dcc-environment-summary"]');
      const actionMessage = document.querySelector('[data-testid="dcc-environment-action-message"]');
      const errorMessage = document.querySelector('[data-testid="dcc-environment-error-message"]');
      const layerNodes = Array.from(document.querySelectorAll('[data-testid^="dcc-environment-layer-"]'));
      const cardState = (engine) => {
        const el = document.querySelector('[data-testid="dcc-environment-engine-' + engine + '"]');
        return el ? { ...el.dataset, text: String(el.textContent || '').trim() } : null;
      };
      return {
        active: active ? { ...active.dataset, text: String(active.textContent || '').trim() } : null,
        summary: summary ? { ...summary.dataset, text: String(summary.textContent || '').trim() } : null,
        actionMessage: actionMessage ? String(actionMessage.textContent || '').trim() : '',
        errorMessage: errorMessage ? String(errorMessage.textContent || '').trim() : '',
        cards: {
          unreal: cardState('unreal'),
          blender: cardState('blender'),
        },
        layers: layerNodes.map((node) => ({
          ...node.dataset,
          text: String(node.textContent || '').trim(),
        })),
      };
    })()
  `, 10000);
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

let currentStage = 'bootstrap';

function setStage(stage) {
  currentStage = stage;
}

async function fetchJsonWithContext(url, label, { allowNull = false } = {}) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`${label} returned HTTP ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    if (allowNull) return null;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} failed during stage "${currentStage}": ${reason}`);
  }
}

async function readApiState() {
  const status = await fetchJsonWithContext(`${apiUrl}/api/dcc/status`, 'dcc status', { allowNull: true });
  const environment = await fetchJsonWithContext(`${apiUrl}/api/dcc/environment/status?force=1`, 'dcc environment status', { allowNull: true });
  return { status, environment };
}

async function fetchEnvironmentStatus() {
  return await fetchJsonWithContext(`${apiUrl}/api/dcc/environment/status?force=1`, 'dcc environment status');
}

async function fetchEnvironmentJobs() {
  return await fetchJsonWithContext(`${apiUrl}/api/dcc/environment/jobs`, 'dcc environment jobs');
}

async function captureStage(cdp, artifactDir, stage) {
  const safeStage = sanitizeFilePart(stage);
  const panelState = await readPanelState(cdp);
  const apiState = await readApiState();
  await Promise.all([
    screenshot(cdp, path.join(artifactDir, `${safeStage}.png`)),
    writeJson(path.join(artifactDir, `${safeStage}.panel.json`), panelState),
    writeJson(path.join(artifactDir, `${safeStage}.api.json`), apiState),
  ]);
  return { panelState, apiState };
}

async function waitForPanelCondition(cdp, description, expression, timeoutMs, refreshEveryMs = 5000) {
  const started = Date.now();
  let lastRefresh = 0;
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      if (Date.now() - lastRefresh >= refreshEveryMs) {
        await refreshPanel(cdp);
        lastRefresh = Date.now();
      }
      const value = await evalJs(cdp, expression, 5000);
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(450);
  }
  const state = await readPanelState(cdp).catch(() => null);
  throw new Error(`${description} timed out${lastError ? `: ${lastError.message}` : ''}${state ? ` | state=${JSON.stringify(state)}` : ''}`);
}

async function waitForApiCondition(description, predicate, timeoutMs, intervalMs = 1200) {
  const started = Date.now();
  let lastState = null;
  while (Date.now() - started < timeoutMs) {
    lastState = await fetchEnvironmentStatus().catch(() => null);
    if (lastState && predicate(lastState)) return lastState;
    await sleep(intervalMs);
  }
  throw new Error(`${description} timed out${lastState ? ` | state=${JSON.stringify(lastState)}` : ''}`);
}

async function latestJobId(engine, action) {
  const payload = await fetchEnvironmentJobs().catch(() => null);
  const job = Array.isArray(payload?.jobs)
    ? payload.jobs.find((item) => item.engine === engine && item.action === action)
    : null;
  return job?.id || null;
}

async function waitForCompletedJob(engine, action, previousJobId, timeoutMs) {
  const started = Date.now();
  let lastPayload = null;
  while (Date.now() - started < timeoutMs) {
    lastPayload = await fetchEnvironmentJobs().catch(() => null);
    const job = Array.isArray(lastPayload?.jobs)
      ? lastPayload.jobs.find((item) => item.engine === engine && item.action === action && item.id !== previousJobId)
      : null;
    if (job && (job.status === 'completed' || job.status === 'failed')) return job;
    await sleep(1200);
  }
  throw new Error(`Timed out waiting for ${engine} ${action} job completion${lastPayload ? ` | jobs=${JSON.stringify(lastPayload)}` : ''}`);
}

async function runFeatureAction(cdp, engine, action) {
  const selector = `[data-testid="dcc-environment-action-${action}"][data-engine="${engine}"]`;
  const previousJobId = await latestJobId(engine, action);
  await clickSelector(cdp, selector);
  await waitForCompletedJob(engine, action, previousJobId, 180000);
}

async function runPrimaryAction(cdp, engine, action) {
  const selector = `[data-testid="dcc-environment-action-${action}"][data-engine="${engine}"]`;
  const previousJobId = await latestJobId(engine, action);
  await clickSelector(cdp, selector);
  await sleep(300);
  await waitForCompletedJob(engine, action, previousJobId, 360000);
}

async function assertBlenderOffline(cdp) {
  await waitForPanelCondition(
    cdp,
    'Blender offline state',
    `(() => {
      const el = document.querySelector('[data-testid="dcc-environment-active-engine"]');
      return el
        && el.dataset.engine === 'blender'
        && el.dataset.serviceReachable === 'false'
        && el.dataset.readyForLiveCapture === 'false';
    })()`,
    60000,
  );
}

async function assertBlenderReady(cdp) {
  await waitForPanelCondition(
    cdp,
    'Blender ready state',
    `(() => {
      const el = document.querySelector('[data-testid="dcc-environment-active-engine"]');
      return el
        && el.dataset.engine === 'blender'
        && el.dataset.serviceReachable === 'true'
        && el.dataset.readyForLiveCapture === 'true';
    })()`,
    120000,
  );
}

async function assertBlenderHostOpened(cdp) {
  await waitForPanelCondition(
    cdp,
    'Blender host opened state',
    `(() => {
      const el = document.querySelector('[data-testid="dcc-environment-active-engine"]');
      return el
        && el.dataset.engine === 'blender'
        && el.dataset.addonEnabledInRunningHost === 'true';
    })()`,
    120000,
  );
}

async function assertUnrealOffline(cdp) {
  await waitForPanelCondition(
    cdp,
    'Unreal offline state',
    `(() => {
      const el = document.querySelector('[data-testid="dcc-environment-active-engine"]');
      return el
        && el.dataset.engine === 'unreal'
        && el.dataset.directBridgeReady === 'false'
        && el.dataset.directBridgeOnline === 'false'
        && el.dataset.targetProjectRunning === 'false';
    })()`,
    90000,
  );
}

async function assertUnrealReady(cdp) {
  await waitForPanelCondition(
    cdp,
    'Unreal ready state',
    `(() => {
      const el = document.querySelector('[data-testid="dcc-environment-active-engine"]');
      return el
        && el.dataset.engine === 'unreal'
        && el.dataset.directBridgeReady === 'true'
        && el.dataset.directBridgeOnline === 'true'
        && el.dataset.targetProjectRunning === 'true'
        && Number(el.dataset.cameraCount || '0') >= 1;
    })()`,
    300000,
  );
}

async function assertUnrealHostOpened(cdp) {
  await waitForPanelCondition(
    cdp,
    'Unreal host opened state',
    `(() => {
      const el = document.querySelector('[data-testid="dcc-environment-active-engine"]');
      return el
        && el.dataset.engine === 'unreal'
        && el.dataset.hostRunning === 'true'
        && el.dataset.targetProjectRunning === 'true';
    })()`,
    300000,
  );
}

async function assertMessageVisible(cdp, kind) {
  const selector = kind === 'error'
    ? '[data-testid="dcc-environment-error-message"]'
    : '[data-testid="dcc-environment-action-message"]';
  await waitForPanelCondition(
    cdp,
    `${kind} message`,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      return el && String(el.textContent || '').trim().length > 0;
    })()`,
    30000,
    0,
  );
}

function launchVisibleProcess(command, args = [], cwd = undefined) {
  const child = spawn(command, args, {
    cwd,
    detached: false,
    stdio: 'ignore',
    windowsHide: false,
    shell: false,
  });
  child.unref();
  return child;
}

async function launchBlenderVisible() {
  const environment = await fetchEnvironmentStatus();
  const executablePath = environment?.engines?.blender?.host?.installations?.[0]?.executablePath;
  if (!executablePath) {
    throw new Error('Unable to resolve Blender executable path from environment status.');
  }
  launchVisibleProcess(executablePath, []);
  await waitForApiCondition(
    'Blender standalone visible launch',
    (state) => Boolean(state?.engines?.blender?.plugin?.addonEnabledInRunningHost),
    120000,
  );
}

async function launchUnrealVisible() {
  const environment = await fetchEnvironmentStatus();
  const engineRoot = environment?.engines?.unreal?.host?.engineInstalls?.[0]?.engineRoot;
  const projectPath = environment?.engines?.unreal?.project?.path;
  if (!engineRoot || !projectPath) {
    throw new Error(`Unable to resolve Unreal launch paths. engineRoot=${engineRoot || ''} projectPath=${projectPath || ''}`);
  }
  const editorPath = path.join(engineRoot, 'Engine', 'Binaries', 'Win64', 'UnrealEditor.exe');
  launchVisibleProcess(editorPath, [projectPath], path.dirname(projectPath));
  await waitForApiCondition(
    'Unreal standalone visible launch',
    (state) => Boolean(state?.engines?.unreal?.host?.hostProcessRunning) && Boolean(state?.engines?.unreal?.host?.targetProjectRunning),
    300000,
  );
}

async function runVerification(cdp, artifactDir) {
  setStage('cleanup-existing-hosts');
  await stopWindowsProcess('blender').catch(() => {});
  await stopWindowsProcess('UnrealEditor').catch(() => {});
  await stopWindowsProcess('UnrealEditor-Cmd').catch(() => {});

  setStage('open-dcc-panel');
  await openDccPanel(cdp);
  await captureStage(cdp, artifactDir, 'panel-opened');

  setStage('blender-offline-check');
  await selectEngine(cdp, 'blender');
  await refreshPanel(cdp);
  await assertBlenderOffline(cdp);
  await captureStage(cdp, artifactDir, 'blender-offline');

  setStage('blender-repair');
  await runFeatureAction(cdp, 'blender', 'repair');
  await refreshPanel(cdp);
  await captureStage(cdp, artifactDir, 'blender-repair');

  setStage('blender-launch-visible');
  await launchBlenderVisible();
  await assertBlenderHostOpened(cdp);
  await captureStage(cdp, artifactDir, 'blender-host-opened');

  setStage('blender-connect');
  await runPrimaryAction(cdp, 'blender', 'connect');
  await assertBlenderReady(cdp);
  await captureStage(cdp, artifactDir, 'blender-ready');

  setStage('blender-disconnect');
  await stopWindowsProcess('blender');
  await assertBlenderOffline(cdp);
  await captureStage(cdp, artifactDir, 'blender-disconnected');

  setStage('unreal-offline-check');
  await selectEngine(cdp, 'unreal');
  await refreshPanel(cdp);
  await assertUnrealOffline(cdp);
  await captureStage(cdp, artifactDir, 'unreal-offline');

  setStage('unreal-repair');
  await runFeatureAction(cdp, 'unreal', 'repair');
  await refreshPanel(cdp);
  await captureStage(cdp, artifactDir, 'unreal-repair');

  setStage('unreal-launch-visible');
  await launchUnrealVisible();
  await assertUnrealHostOpened(cdp);
  await captureStage(cdp, artifactDir, 'unreal-host-opened');

  setStage('unreal-connect');
  await runPrimaryAction(cdp, 'unreal', 'connect');
  await assertUnrealReady(cdp);
  await captureStage(cdp, artifactDir, 'unreal-ready');

  setStage('unreal-disconnect');
  await stopWindowsProcess('UnrealEditor');
  await stopWindowsProcess('UnrealEditor-Cmd').catch(() => {});
  await assertUnrealOffline(cdp);
  await captureStage(cdp, artifactDir, 'unreal-disconnected');
}

async function main() {
  const options = parseCliOptions(process.argv.slice(2));
  if (!chromePath) {
    throw new Error('Chrome or Edge was not found. Set CHROME_PATH to a valid browser executable.');
  }

  await waitForHttp(`${apiUrl}/api/health`, 30000).catch(async () => {
    await waitForHttp(apiUrl, 30000);
  });
  const appUrl = await resolveAppUrl();
  const chromePort = await pickFreePort();
  const artifactDir = path.join(repoRoot, 'artifacts', `dcc-environment-panel-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hmdao-dcc-panel-'));
  await fs.mkdir(artifactDir, { recursive: true });

  const browserArgs = [
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--window-size=1680,1100',
    'about:blank',
  ];
  if (options.headless) browserArgs.unshift('--headless=new');

  const browser = spawn(chromePath, browserArgs, {
    windowsHide: false,
    detached: false,
    stdio: 'ignore',
    shell: false,
  });

  let cdp;
  try {
    setStage('connect-cdp');
    cdp = await connectCdp(chromePort);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    setStage('ensure-authenticated');
    await ensureAuthenticated(cdp, appUrl);
    setStage('run-verification');
    await runVerification(cdp, artifactDir);
    setStage('capture-final-state');
    const finalState = await captureStage(cdp, artifactDir, 'final-state');
    console.log(JSON.stringify({
      success: true,
      appUrl,
      apiUrl,
      artifactDir,
      finalPanelState: finalState.panelState,
    }, null, 2));
    if (!options.keepOpen) {
      cdp.close();
      browser.kill();
    }
  } catch (error) {
    const failure = {
      success: false,
      appUrl,
      apiUrl,
      artifactDir,
      stage: currentStage,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
    };
    await writeJson(path.join(artifactDir, 'failure.json'), failure).catch(() => {});
    console.error(JSON.stringify(failure, null, 2));
    if (!options.keepOpen) {
      try { cdp?.close(); } catch {}
      try { browser.kill(); } catch {}
    }
    process.exitCode = 1;
  }
}

await main();


