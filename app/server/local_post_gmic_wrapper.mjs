import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

async function readJsonStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function clampNumber(value, min, max, fallback) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(min, Math.min(max, next));
}

function fileExtensionToFormat(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'jpg';
  if (ext === '.webp') return 'webp';
  if (ext === '.bmp') return 'bmp';
  if (ext === '.tif' || ext === '.tiff') return 'tiff';
  return 'png';
}

function resolveNoiseKind(distribution) {
  if (distribution === 'poisson') return 'poisson';
  if (distribution === 'lognormal') return 'uniform';
  return 'gaussian';
}

function buildDetailArgs(detailConfig = {}) {
  if (!detailConfig.enabled) return [];
  const args = [];
  const denoise = clampNumber(detailConfig.denoise, 0, 1, 0);
  const sharpen = clampNumber(detailConfig.sharpen, 0, 1, 0);
  const mode = String(detailConfig.mode || 'balanced').trim();
  if (denoise > 0.01) {
    const spatial = (2 + denoise * 5.5).toFixed(3);
    const range = (12 + denoise * 36).toFixed(3);
    args.push('bilateral', `${spatial},${range}`);
  }
  if (sharpen > 0.01 || mode === 'detail') {
    const amplitude = (35 + sharpen * 120 + (mode === 'detail' ? 24 : 0)).toFixed(3);
    args.push('sharpen', amplitude);
  }
  return args;
}

function buildBloomArgs(bloomConfig = {}) {
  if (!bloomConfig.enabled) return [];
  const threshold = clampNumber(bloomConfig.threshold, 0.1, 1, 0.76);
  const intensity = clampNumber(bloomConfig.intensity, 0, 1.4, 0.34);
  const radius = clampNumber(bloomConfig.radius, 1, 64, 16);
  const amplitude = Math.max(0.5, intensity * 120 + radius * 0.3 + threshold * 10).toFixed(3);
  return ['glow', amplitude];
}

function buildGrainArgs(grainConfig = {}) {
  if (!grainConfig.enabled) return [];
  const amount = clampNumber(grainConfig.amount, 0, 1, 0.24);
  const size = clampNumber(grainConfig.size, 0.5, 4, 1.2);
  const chroma = clampNumber(grainConfig.chroma, 0, 1, 0.18);
  const shadowBoost = clampNumber(grainConfig.shadowBoost, 0, 1, 0.16);
  const noiseKind = resolveNoiseKind(String(grainConfig.distribution || 'gaussian').trim());
  const noiseType = noiseKind === 'poisson' ? '3' : noiseKind === 'uniform' ? '1' : '0';
  const sigma = (4 + amount * 36 + chroma * 8 + shadowBoost * 6 + size * 2).toFixed(3);
  return ['noise', `${sigma},${noiseType}`];
}

function buildGmicCommands(request) {
  const commands = [
    ...buildDetailArgs(request.detailConfig || {}),
    ...buildBloomArgs(request.bloomConfig || {}),
    ...buildGrainArgs(request.grainConfig || {}),
  ];
  commands.push('cut', '0,255');
  return {
    stagesApplied: [
      request.detailConfig?.enabled ? 'detail-pass' : '',
      request.bloomConfig?.enabled ? 'bloom' : '',
      request.grainConfig?.enabled ? 'grain' : '',
    ].filter(Boolean),
    commands,
  };
}

async function runCommand(command, args, cwd) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      const stdoutText = Buffer.concat(stdout).toString('utf8');
      const stderrText = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        reject(new Error(`gmic exited with code ${code}: ${stderrText || stdoutText || 'unknown-error'}`));
        return;
      }
      resolve({ stdout: stdoutText, stderr: stderrText });
    });
  });
}

const request = await readJsonStdin();
const runtimePath = String(request.runtimePath || process.env.HMDAO_POST_GMIC_PATH || '').trim();
if (!runtimePath) {
  throw new Error('gmic-runtime-not-configured');
}

const inputPath = path.resolve(String(request.inputPath || ''));
const outputPath = path.resolve(String(request.outputPath || ''));
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const { commands, stagesApplied } = buildGmicCommands(request);
if (!commands.length) {
  await fs.copyFile(inputPath, outputPath);
  process.stdout.write(JSON.stringify({
    outputPath,
    engine: 'G\'MIC CLI',
    meta: {
      stagesApplied: [],
      passthrough: true,
    },
  }));
  process.exit(0);
}

const outputFormat = fileExtensionToFormat(outputPath);
const args = [
  inputPath,
  ...commands,
  'output[0]',
  `${outputPath},${outputFormat}`,
];
await runCommand(runtimePath, args, path.dirname(runtimePath));

process.stdout.write(JSON.stringify({
  outputPath,
  engine: 'G\'MIC CLI',
  meta: {
    stagesApplied,
    commandCount: commands.length,
    runtimePath,
  },
}));
