import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const children = [];
const apiPort = process.env.HMDAO_API_PORT || '8792';
const apiTarget = process.env.HMDAO_API_TARGET || `http://127.0.0.1:${apiPort}`;
const realApiRequested = process.env.HMDAO_REAL_API === '1' || process.argv.includes('--real-api');
const realApiMode = realApiRequested ? 'enabled' : 'disabled';
const nodeExe = process.execPath;
const viteCli = path.resolve(process.cwd(), 'node_modules', 'vite', 'bin', 'vite.js');

function start(command, args, name) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: false,
    windowsHide: false,
  });
  children.push(child);
  child.on('exit', (code) => {
    if (code && code !== 0) {
      console.error(`[${name}] exited with code ${code}; other services will keep running.`);
      // Keep the remaining services alive so a single process can be restarted independently.
    }
  });
}

async function stopChildTree(child) {
  if (!child || child.killed || !child.pid) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
      });
      killer.on('exit', resolve);
      killer.on('error', resolve);
    });
    return;
  }
  child.kill('SIGTERM');
}

async function shutdown(code = 0) {
  for (const child of children) {
    await stopChildTree(child);
  }
  process.exit(code);
}

process.on('SIGINT', () => { void shutdown(0); });
process.on('SIGTERM', () => { void shutdown(0); });

process.env.HMDAO_API_PORT = apiPort;
process.env.HMDAO_API_TARGET = apiTarget;
process.env.HMDAO_REAL_API = realApiRequested ? '1' : '0';

console.log(`[dev-full] api=${apiTarget} realApi=${realApiMode}`);

start(nodeExe, ['server/hmdao-api.mjs'], 'api');
start(nodeExe, [viteCli, '--host', '127.0.0.1', '--port', '3000'], 'vite');
