// Aria2 RPC manager for Ddayup backend.
// Spawns a single aria2c --enable-rpc instance on a fixed local port and
// forwards download tasks (netdisk direct links, large media) from the
// browser extension to it. The process is started lazily on first add-uri
// and kept alive for the backend session.

import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { detectManagedLocalPostAria2Path } from './local-post-processing.mjs';
import { LOCAL_POST_MANAGED_RUNTIME_DIR } from './local-post-constants.mjs';

const ARIA2_RPC_PORT = 16800;
const ARIA2_RPC_SECRET = ''; // local-only, no secret needed
const ARIA2_RPC_URL = `http://127.0.0.1:${ARIA2_RPC_PORT}/jsonrpc`;

let aria2Process = null;
let startingPromise = null;
let nextGid = 1;
let stopAria2Intentional = false;
let restartTimer = null;

function downloadsDir() {
  const dir = path.join(LOCAL_POST_MANAGED_RUNTIME_DIR, 'downloads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rpcCall(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 'ddayup-' + (nextGid++),
      method,
      params: ARIA2_RPC_SECRET ? [`token:${ARIA2_RPC_SECRET}`, ...params] : params,
    });
    const bodyBuffer = Buffer.from(body, 'utf8');
    const req = http.request(
      ARIA2_RPC_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(bodyBuffer.length),
        },
        timeout: 8000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) return reject(new Error(parsed.error.message || 'aria2 rpc error'));
            resolve(parsed.result);
          } catch (e) {
            reject(new Error('aria2 rpc parse failed: ' + e.message));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('aria2 rpc timeout')));
    req.on('error', (e) => reject(e));
    req.write(bodyBuffer);
    req.end();
  });
}

export function isAria2Running() {
  return aria2Process !== null && !aria2Process.killed;
}

export function getAria2Status() {
  const detectedPath = detectManagedLocalPostAria2Path();
  return {
    installed: Boolean(detectedPath),
    detectedPath,
    running: isAria2Running(),
    rpcPort: ARIA2_RPC_PORT,
  };
}

export async function ensureAria2Running() {
  if (isAria2Running()) return true;
  if (startingPromise) return startingPromise;

  startingPromise = (async () => {
    const exe = detectManagedLocalPostAria2Path();
    if (!exe) {
      startingPromise = null;
      throw new Error('aria2-not-installed');
    }
    const dir = downloadsDir();
    aria2Process = spawn(exe, [
      '--enable-rpc',
      `--rpc-listen-port=${ARIA2_RPC_PORT}`,
      '--rpc-listen-all=false',
      `--dir=${dir}`,
      '--continue=true',
      '--max-connection-per-server=8',
      '--split=8',
      '--daemon=false',
      '--auto-save-interval=30',
      '--save-session-interval=30',
      '--enable-color=false',
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

    aria2Process.stdout.on('data', () => {});
    aria2Process.stderr.on('data', (d) => {
      console.error('[aria2]', d.toString().trim());
    });
    // Step 4: crash watchdog. If the process dies unexpectedly (non-zero, and
    // we didn't ask it to stop), auto-respawn so in-flight netdisk downloads
    // survive transient aria2c crashes without manual intervention.
    aria2Process.on('exit', (code) => {
      const wasRunning = aria2Process !== null;
      aria2Process = null;
      if (code && code !== 0) console.error('[aria2] exited with code', code);
      if (wasRunning && !stopAria2Intentional && code) {
        console.warn('[aria2] unexpected exit, scheduling auto-restart');
        scheduleAria2Restart();
      }
    });

    // wait until rpc responds
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        await rpcCall('aria2.getVersion', []);
        return true;
      } catch {
        if (!isAria2Running()) throw new Error('aria2-process-died');
      }
    }
    throw new Error('aria2-rpc-timeout');
  })();

  try {
    return await startingPromise;
  } finally {
    startingPromise = null;
  }
}

export async function aria2AddUri(uris, options = {}) {
  await ensureAria2Running();
  const params = Object.assign(
    { dir: downloadsDir(), continue: 'true', 'max-connection-per-server': '8', split: '8' },
    options
  );
  const gid = await rpcCall('aria2.addUri', [[].concat(uris), params]);
  return gid;
}

export async function aria2TellStatus(gid) {
  await ensureAria2Running();
  return rpcCall('aria2.tellStatus', [gid, ['gid', 'status', 'totalLength', 'completedLength', 'downloadSpeed', 'files', 'errorMessage']]);
}

export async function aria2TellActive() {
  await ensureAria2Running();
  return rpcCall('aria2.tellActive', [['gid', 'status', 'totalLength', 'completedLength', 'files']]);
}

export async function aria2Remove(gid) {
  if (!isAria2Running()) return false;
  await rpcCall('aria2.remove', [gid]);
  return true;
}

// Step 3: verify a completed download's integrity against an expected hash.
// hash format: "sha1:...." / "md5:...." / "sha256:...." (case-insensitive, optional colon separators).
export async function aria2VerifyHash(gid, expectedHash) {
  if (!expectedHash) return { ok: false, error: 'missing expected hash' };
  const st = await aria2TellStatus(gid);
  if (st.status !== 'complete') {
    return { ok: false, error: 'download-not-complete', status: st.status, completedLength: st.completedLength };
  }
  const file = st.files && st.files[0] && st.files[0].path;
  if (!file || !fs.existsSync(file)) return { ok: false, error: 'file-not-found', path: file };
  const m = String(expectedHash).match(/^(sha1|md5|sha256)[:\s-]*(.+)$/i);
  if (!m) return { ok: false, error: 'unsupported-hash-format', expected: expectedHash };
  const algo = m[1].toLowerCase().replace('sha1', 'sha1');
  const expected = m[2].trim().toLowerCase();
  const h = crypto.createHash(algo);
  const fd = fs.createReadStream(file);
  await new Promise((resolve, reject) => {
    fd.on('data', (c) => h.update(c));
    fd.on('end', resolve);
    fd.on('error', reject);
  });
  const actual = h.digest('hex');
  return { ok: actual === expected, algo, expected, actual, path: file, verifiedAt: new Date().toISOString() };
}

// Step 4: auto-restart after an unexpected crash (backoff-bounded).
function scheduleAria2Restart() {
  if (restartTimer) return; // already scheduled
  restartTimer = setTimeout(async () => {
    restartTimer = null;
    if (isAria2Running()) return;
    try {
      console.warn('[aria2] auto-restarting…');
      await ensureAria2Running();
      console.warn('[aria2] auto-restart ok');
    } catch (e) {
      console.error('[aria2] auto-restart failed:', e.message);
      // try once more after a longer delay
      scheduleAria2RestartDelayed();
    }
  }, 1500);
}

function scheduleAria2RestartDelayed() {
  if (restartTimer) return;
  restartTimer = setTimeout(async () => {
    restartTimer = null;
    if (isAria2Running()) return;
    try {
      await ensureAria2Running();
      console.warn('[aria2] auto-restart (retry) ok');
    } catch (e) {
      console.error('[aria2] auto-restart (retry) failed:', e.message);
    }
  }, 8000);
}

export function stopAria2() {
  stopAria2Intentional = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (aria2Process && !aria2Process.killed) {
    aria2Process.kill('SIGTERM');
    aria2Process = null;
  }
}

// Ensure the spawned aria2c is reaped when the backend process exits.
function cleanupAria2OnExit() {
  stopAria2Intentional = true;
  if (aria2Process && !aria2Process.killed) {
    try { aria2Process.kill('SIGKILL'); } catch { /* ignore */ }
  }
}
process.once('exit', cleanupAria2OnExit);
process.once('SIGINT', cleanupAria2OnExit);
process.once('SIGTERM', cleanupAria2OnExit);
