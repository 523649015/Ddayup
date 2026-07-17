import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const repoRoot = process.cwd();
const appDir = path.join(repoRoot, 'app');
const infraDir = path.join(repoRoot, 'tools', 'PixelStreamingInfrastructure-UE5.7', 'SignallingWebServer');
const tempDir = process.env.TEMP || process.env.TMP || path.join(repoRoot, '.tmp');
const logDir = path.join(tempDir, 'hmdao-stack-logs');
const pidFile = path.join(logDir, 'hmdao-stack-pids.json');
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

function spawnDetached(name, command, args, cwd, envExtra = {}) {
  const stdoutPath = path.join(logDir, `${name}.log`);
  const stderrPath = path.join(logDir, `${name}.err.log`);
  const child = spawn(command, args, {
    cwd,
    env: cleanedEnv(envExtra),
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fs.openSync(stdoutPath, 'a'), fs.openSync(stderrPath, 'a')],
  });
  child.unref();
  return {
    pid: child.pid,
    stdoutPath,
    stderrPath,
    cwd,
    command,
    args,
  };
}

const launchedAt = new Date().toISOString();
const api = spawnDetached('hmdao-api', nodeExe, ['server/hmdao-api.mjs'], appDir, { HMDAO_API_PORT: String(apiPort) });
const pixel = spawnDetached(
  'hmdao-pixel',
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
);

const payload = {
  launchedAt,
  repoRoot,
  apiPort,
  playerPort,
  streamerPort,
  sfuPort,
  api,
  pixel,
};
fs.writeFileSync(pidFile, JSON.stringify(payload, null, 2), 'utf8');
console.log(JSON.stringify(payload, null, 2));