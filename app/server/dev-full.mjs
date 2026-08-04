import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const children = [];
let shuttingDown = false;
const MAX_RESTARTS = 5;
const RESTART_DELAY = 1500;
const apiPort = process.env.HMDAO_API_PORT || '8792';
const apiTarget = process.env.HMDAO_API_TARGET || `http://127.0.0.1:${apiPort}`;
const realApiRequested = process.env.HMDAO_REAL_API === '1' || process.argv.includes('--real-api');
const realApiMode = realApiRequested ? 'enabled' : 'disabled';
const nodeExe = process.execPath;
const viteCli = path.resolve(process.cwd(), 'node_modules', 'vite', 'bin', 'vite.js');

function start(command, args, name, { restart = true, cwd = process.cwd() } = {}) {
  let restarts = 0;
  const launch = () => {
    if (shuttingDown) return;
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: false,
      windowsHide: false,
      env: process.env,
    });
    children.push(child);
    child.on('exit', (code, signal) => {
      const idx = children.indexOf(child);
      if (idx !== -1) children.splice(idx, 1);
      // code === 0 / null 视为正常退出（如被父进程关闭），不重启
      const unexpected = code !== 0 && code !== null;
      if (!unexpected) {
        console.log(`[${name}] exited cleanly (code=${code}).`);
        return;
      }
      if (!restart || restarts >= MAX_RESTARTS) {
        console.error(`[${name}] crashed (code=${code}, signal=${signal}); not restarting.`);
        return;
      }
      restarts++;
      console.warn(
        `[${name}] crashed (code=${code}); auto-restarting (${restarts}/${MAX_RESTARTS}) in ${RESTART_DELAY}ms…`,
      );
      setTimeout(launch, RESTART_DELAY);
    });
    child.on('error', (err) => {
      console.error(`[${name}] failed to start: ${err.message}`);
    });
  };
  launch();
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
  shuttingDown = true;
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

// 资产采集器后端（FastAPI, 端口 9988）
if (!process.env.HMDAO_SKIP_CURATOR) {
  const curatorDir = path.resolve(__dirname, '..', '..', 'tools', 'asset-curator-exe');
  const hasCurator = fs.existsSync(path.join(curatorDir, 'main.py'));
  if (hasCurator) {
    const py = (() => {
      for (const c of [process.env.HMDAO_CURATOR_PY, 'python', 'python3']) {
        if (!c) continue;
        try {
          execSync(`"${c}" --version`, { stdio: 'ignore' });
          return c;
        } catch {
          /* try next */
        }
      }
      return null;
    })();
    if (py) {
      const portBusy = await new Promise((resolve) => {
        const srv = net.createServer();
        srv.once('error', () => { srv.close(() => resolve(true)); });
        srv.listen(9988, '127.0.0.1', () => { srv.close(() => resolve(false)); });
      });
      if (portBusy) {
        console.log('[dev-full] 9988 端口已被占用（资产采集器可能已在运行），跳过启动。');
      } else {
        start(py, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '9988'],
          'curator', { cwd: curatorDir });
      }
    } else {
      console.warn('[dev-full] 未找到 python，已跳过资产采集器后端（9988）。网络资产采集将不可用。');
    }
  } else {
    console.warn('[dev-full] 未找到 tools/asset-curator-exe/main.py，已跳过资产采集器后端。');
  }
} else {
  console.log('[dev-full] HMDAO_SKIP_CURATOR 已设置，跳过资产采集器后端。');
}
