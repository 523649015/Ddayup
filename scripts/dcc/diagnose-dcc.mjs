import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BlenderPluginAdapter } from '../../app/server/dcc/adapters/blender-plugin-adapter.mjs';
import { UnrealPluginAdapter } from '../../app/server/dcc/adapters/unreal-plugin-adapter.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');
const backupRoot = path.join(repoRoot, 'artifacts', 'backups');
const GATEWAY_PORT = Number(process.env.HMDAO_DCC_GATEWAY_PORT || 8792);
const hostHelperPath = path.join(repoRoot, 'scripts', 'dcc', 'prepare-dcc-host-startup.ps1');
const unrealPrepPath = path.join(repoRoot, 'scripts', 'dcc', 'prepare-unreal-host-startup.ps1');

function wsAcceptHeader(key) {
  return crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
}

function encodeClientFrame(payload) {
  const data = Buffer.from(JSON.stringify(payload));
  const mask = crypto.randomBytes(4);
  const header = [0x81];
  if (data.length < 126) header.push(0x80 | data.length);
  else if (data.length < 65536) header.push(0x80 | 126, (data.length >> 8) & 255, data.length & 255);
  else throw new Error('Diagnostic payload is too large.');
  const masked = Buffer.alloc(data.length);
  for (let index = 0; index < data.length; index += 1) {
    masked[index] = data[index] ^ mask[index % 4];
  }
  return Buffer.concat([Buffer.from(header), mask, masked]);
}

function parseServerFrame(buffer) {
  if (buffer.length < 2) return null;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if (buffer.length < offset + length) return null;
  return {
    text: buffer.subarray(offset, offset + length).toString('utf8'),
    rest: buffer.subarray(offset + length),
  };
}

function httpJson(paths, timeoutMs = 2500) {
  const pathList = Array.isArray(paths) ? paths : [paths];
  const tryIndex = (index) => new Promise((resolve) => {
    if (index >= pathList.length) {
      resolve({ ok: false, error: 'no-endpoint-succeeded' });
      return;
    }
    const requestPath = pathList[index];
    const req = http.request({ host: '127.0.0.1', port: GATEWAY_PORT, path: requestPath, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', async () => {
        const body = Buffer.concat(chunks).toString('utf8');
        try {
          const data = JSON.parse(body);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true, status: res.statusCode, data, path: requestPath });
            return;
          }
          if (res.statusCode === 404) {
            resolve(await tryIndex(index + 1));
            return;
          }
          resolve({ ok: false, status: res.statusCode, data, path: requestPath });
        } catch {
          resolve({ ok: false, status: res.statusCode, body, path: requestPath });
        }
      });
    });
    req.on('timeout', async () => {
      req.destroy();
      resolve(index + 1 < pathList.length ? await tryIndex(index + 1) : { ok: false, error: 'timeout', path: requestPath });
    });
    req.on('error', async (error) => {
      resolve(index + 1 < pathList.length ? await tryIndex(index + 1) : { ok: false, error: error.message, path: requestPath });
    });
    req.end();
  });
  return tryIndex(0);
}

function probeTcp(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done({ ok: true }));
    socket.once('timeout', () => done({ ok: false, error: 'timeout' }));
    socket.once('error', (error) => done({ ok: false, error: error.message }));
  });
}

function testWs({ port, requestPath, payload }) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const key = crypto.randomBytes(16).toString('base64');
    let buffer = Buffer.alloc(0);
    let handshook = false;
    const done = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(4500);
    socket.once('connect', () => {
      socket.write([
        `GET ${requestPath} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '\r\n',
      ].join('\r\n'));
    });
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshook) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const header = buffer.subarray(0, headerEnd).toString('utf8');
        if (!/^HTTP\/1\.1 101/i.test(header)) {
          done({ ok: false, error: `Unexpected handshake response: ${header.split('\r\n')[0]}` });
          return;
        }
        const accept = header.match(/sec-websocket-accept:\s*(.+)$/im)?.[1]?.trim();
        if (accept !== wsAcceptHeader(key)) {
          done({ ok: false, error: 'Sec-WebSocket-Accept validation failed.' });
          return;
        }
        handshook = true;
        buffer = buffer.subarray(headerEnd + 4);
        if (payload) socket.write(encodeClientFrame(payload));
      }
      const frame = parseServerFrame(buffer);
      if (!frame) return;
      try {
        done({ ok: true, data: JSON.parse(frame.text) });
      } catch {
        done({ ok: false, error: `WebSocket returned non-JSON payload: ${frame.text.slice(0, 160)}` });
      }
    });
    socket.once('timeout', () => done({ ok: false, error: 'timeout' }));
    socket.once('error', (error) => done({ ok: false, error: error.message }));
    socket.once('close', () => {
      if (!handshook) done({ ok: false, error: 'connection-closed-before-handshake' });
    });
  });
}

function printHeader(title) {
  console.log(`\n[${title}]`);
}

function printFact(label, value) {
  console.log(`${label}: ${value}`);
}

async function diagnoseGateway() {
  const health = await httpJson('/api/health', 1800);
  const status = await httpJson(['/api/dcc/environment/status', '/api/dcc/status'], 8000);
  printHeader('Gateway');
  if (!status.ok) {
    if (health.ok) {
      printFact('Status', `online via ${health.path}, but DCC status is slow (${status.error || status.status || 'unknown'})`);
      printFact('Port', String(GATEWAY_PORT));
      return { status: { ...status, ok: true, degraded: true, viaHealth: true } };
    }
    printFact('Status', `offline (${status.error || health.error || status.status || health.status || 'unknown'})`);
    return { status };
  }
  printFact('Status', `online via ${status.path}`);
  printFact('Port', String(GATEWAY_PORT));
  return { status };
}

async function diagnoseBlender(blenderAdapter) {
  printHeader('Blender');
  const status = await blenderAdapter.getStatus();
  const installation = blenderAdapter.pickInstallation(status, '');
  const tcp = await probeTcp(8766);
  const runningHosts = Array.isArray(status.host?.runningHosts) ? status.host.runningHosts : [];
  printFact('Service 8766', tcp.ok ? 'reachable' : `offline (${tcp.error || 'unknown'})`);
  printFact('Summary', status.summary || 'unknown');
  if (runningHosts.length) {
    printFact('Running hosts', `${runningHosts.length} visible Blender process(es) detected`);
  }
  if (status.plugin?.pendingStartRequest) {
    printFact('Pending request', 'HMDao start request is still waiting for the current Blender session to consume it');
  }
  printFact('Preview policy', 'off until explicitly started; warmup throttled to 2 fps for 20 seconds');

  if (!installation) {
    printFact('Host install', 'not detected');
    return;
  }

  printFact('Executable', installation.executablePath);
  const basic = await blenderAdapter.runBasicCliProbe(installation, null);
  printFact('CLI probe', basic.ok ? 'ok' : basic.reason);
  if (!basic.ok) {
    printFact('Host helper', `powershell -ExecutionPolicy Bypass -File "${hostHelperPath}"`);
    return;
  }

  const background = await blenderAdapter.runBackgroundPythonProbe(installation, null);
  printFact('Background Python probe', background.ok ? 'ok' : background.reason);
  if (!background.ok) {
    printFact('Factory-startup fallback', `"${installation.executablePath}" --factory-startup`);
  }
}

async function diagnoseUnreal(unrealAdapter, gatewayStatus) {
  printHeader('Unreal');
  const status = await unrealAdapter.getStatus();
  const projectPath = status.project?.path || status.projects?.[0]?.path || '';
  const official = status.official || {};
  const rcPolicy = official.remoteControlStartupPolicy || {};

  printFact('Summary', status.summary || 'unknown');
  if (status.runtime?.windowState) {
    printFact('Window state', status.runtime.windowState);
  }
  printFact('Recommended mode', status.integration?.recommendedMode || 'unknown');
  printFact('Recommended action', status.recommendedAction || 'unknown');
  printFact('Direct bridge', status.plugin?.directBridgeOnline ? `online (${status.plugin?.cameraCount || 0} cameras)` : 'offline');
  printFact('RC startup policy', rcPolicy.keepsStartupLight
    ? `on-demand (${rcPolicy.configPath || 'DefaultRemoteControl.ini'})`
    : 'auto-start still allowed');
  printFact('Remote Control API', official.remoteControlReachable ? 'reachable' : 'offline');
  printFact('Pixel Streaming', official.livePreviewReady ? 'enabled' : 'disabled by default');

  const interferers = await unrealAdapter.inspectKnownStartupInterferers();
  printFact('Startup interferers', interferers.length
    ? interferers.map((item) => `${item.label} (${item.processName}, PID ${item.pid})`).join(', ')
    : 'none detected');

  const security = await unrealAdapter.inspectWindowsSecurityHardening();
  printFact('Security hardening', security?.available
    ? `VBS=${security.vbsStatus || 0}, KernelCI=${security.kernelCiStatus || 0}, UserCI=${security.userCiStatus || 0}`
    : 'not available');
  if (interferers.length || security?.vbsRunning || security?.kernelCiEnforced || security?.userCiEnforced) {
    printFact('Host helper', `powershell -ExecutionPolicy Bypass -File "${hostHelperPath}"`);
  }

  if (projectPath) {
    printFact('Target project', projectPath);
    printFact('Startup prep', `powershell -ExecutionPolicy Bypass -File "${unrealPrepPath}" -UProject "${projectPath}" -CleanRuntimeResidue`);
    printFact('Clean launch', `powershell -ExecutionPolicy Bypass -File "${unrealPrepPath}" -UProject "${projectPath}" -LaunchEditor -NoLiveCoding`);
  }

  if (gatewayStatus?.ok) {
    const browser = await testWs({
      port: GATEWAY_PORT,
      requestPath: '/ws/dcc/unreal?role=browser',
      payload: { type: 'connect', engine: 'unreal', w: 640, h: 360 },
    });
    printFact('Browser bridge WS', browser.ok ? `ok (mode=${browser.data?.mode || ''})` : `failed (${browser.error})`);
  }
}

async function run() {
  const engineArg = process.argv.find((arg) => arg.startsWith('--engine='))?.split('=')[1];
  const engines = engineArg ? [engineArg === 'unreal' ? 'unreal' : 'blender'] : ['blender', 'unreal'];
  const unrealAdapter = new UnrealPluginAdapter({
    repoRoot,
    backupRoot,
    getBridgeState: () => ({}),
  });
  const blenderAdapter = new BlenderPluginAdapter({
    repoRoot,
    backupRoot,
  });

  console.log('HMDao DCC Diagnostic');
  console.log('='.repeat(48));
  printFact('Workspace', repoRoot);
  printFact('Temp dir', os.tmpdir());

  const { status: gatewayStatus } = await diagnoseGateway();
  if (engines.includes('blender')) await diagnoseBlender(blenderAdapter);
  if (engines.includes('unreal')) await diagnoseUnreal(unrealAdapter, gatewayStatus);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

