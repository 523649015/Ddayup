import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const repoRoot = process.cwd();
const appDir = path.join(repoRoot, 'app');
const infraDir = path.join(repoRoot, 'tools', 'PixelStreamingInfrastructure-UE5.7', 'SignallingWebServer');
const tempDir = process.env.TEMP || process.env.TMP || path.join(repoRoot, '.tmp');
const logDir = path.join(tempDir, 'hmdao-stack-logs');
const nodeExe = process.execPath;
const playerPort = Number(process.env.HMDAO_UNREAL_PLAYER_PORT || 1025);
const streamerPort = Number(process.env.HMDAO_UNREAL_STREAMER_PORT || 8888);
const sfuPort = Number(process.env.HMDAO_UNREAL_SFU_PORT || 8889);
const apiPort = Number(process.env.HMDAO_API_PORT || 8787);

fs.mkdirSync(logDir, { recursive: true });

function cleanedEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^path$/i.test(key)) continue;
    env[key] = value;
  }
  env.Path = [
    'C:\\WINDOWS\\system32',
    'C:\\WINDOWS',
    'C:\\WINDOWS\\System32\\Wbem',
    'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\',
    'C:\\WINDOWS\\System32\\OpenSSH\\',
    'C:\\Program Files\\Git\\cmd',
    'C:\\Program Files\\dotnet\\',
    'C:\\ProgramData\\chocolatey\\bin',
    'C:\\Program Files\\Docker\\Docker\\resources\\bin',
    'C:\\Program Files\\nodejs\\',
    'C:\\FFMPEG\\bin',
    'C:\\Users\\123\\AppData\\Local\\Microsoft\\WindowsApps',
  ].join(';');
  return { ...env, ...extra };
}

const children = new Map();

function launch(name, command, args, cwd, envExtra = {}, logPrefix = name) {
  const stdoutPath = path.join(logDir, `${logPrefix}.log`);
  const stderrPath = path.join(logDir, `${logPrefix}.err.log`);
  const child = spawn(command, args, {
    cwd,
    env: cleanedEnv(envExtra),
    detached: false,
    windowsHide: true,
    stdio: ['ignore', fs.openSync(stdoutPath, 'a'), fs.openSync(stderrPath, 'a')],
  });
  children.set(name, child);
  child.on('error', (error) => {
    console.error(`[HMDao Stack] ${name} spawn error: ${error.message}`);
  });
  child.on('exit', (code, signal) => {
    console.log(`[HMDao Stack] ${name} exited code=${code} signal=${signal || ''}`);
    children.delete(name);
    setTimeout(() => {
      console.log(`[HMDao Stack] restarting ${name}...`);
      launch(name, command, args, cwd, envExtra, logPrefix);
    }, 1500);
  });
  console.log(`[HMDao Stack] ${name} pid=${child.pid}`);
  return child;
}

console.log('[HMDao Stack] starting resident launcher');
console.log(`[HMDao Stack] Repo    : ${repoRoot}`);
console.log(`[HMDao Stack] Node    : ${nodeExe}`);
console.log(`[HMDao Stack] API     : http://127.0.0.1:${apiPort}`);
console.log(`[HMDao Stack] Player  : http://127.0.0.1:${playerPort}/player.html`);
console.log(`[HMDao Stack] Streamer: ws://127.0.0.1:${streamerPort}`);
console.log(`[HMDao Stack] Log dir : ${logDir}`);

launch('hmdao-api', nodeExe, ['server/hmdao-api.mjs'], appDir, { HMDAO_API_PORT: String(apiPort) }, 'hmdao-api');
launch(
  'pixel-streaming',
  nodeExe,
  [
    'dist/index.js',
    '--serve',
    '--player_port', String(playerPort),
    '--streamer_port', String(streamerPort),
    '--sfu_port', String(sfuPort),
    '--http_root', 'www',
    '--homepage', 'player.html',
    '--rest_api',
    '--log_folder', logDir,
    '--log_config',
    '--console_messages', 'basic',
  ],
  infraDir,
  {},
  'hmdao-pixel',
);

setInterval(() => {
  process.stdout.write(`[HMDao Stack] heartbeat children=${Array.from(children.keys()).join(',') || 'none'}\n`);
}, 5000);