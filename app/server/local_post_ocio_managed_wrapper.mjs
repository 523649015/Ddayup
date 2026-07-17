import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function readJsonStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function isOfficialAcesConfig(configPath) {
  const name = path.basename(String(configPath || '')).toLowerCase();
  return name.includes('cg-config') || name.includes('aces') || name.includes('ocio-v2.5');
}

function mapColorSpace(value, configPath = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return '';
  if (isOfficialAcesConfig(configPath)) {
    if (normalized === 'srgb') return 'sRGB Encoded Rec.709 (sRGB)';
    if (normalized === 'rec.709' || normalized === 'rec709') return 'Gamma 2.2 Encoded Rec.709';
    if (normalized === 'acescg') return 'ACEScg';
    if (normalized === 'dci-p3' || normalized === 'display-p3') return 'sRGB Encoded P3-D65';
  }
  if (normalized === 'srgb') return 'sRGB';
  if (normalized === 'rec.709' || normalized === 'rec709') return 'Rec.709';
  if (normalized === 'acescg') return 'ACEScg';
  if (normalized === 'dci-p3' || normalized === 'display-p3') return 'DCI-P3';
  return String(value || '').trim();
}

async function runCommand(command, args, cwd, extraEnv = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...extraEnv,
      },
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
        reject(new Error(`ocio-managed-wrapper exited with code ${code}: ${stderrText || stdoutText || 'unknown-error'}`));
        return;
      }
      resolve({ stdout: stdoutText, stderr: stderrText });
    });
  });
}

function detectManagedOiioPath() {
  const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  return path.join(appDir, '.hmdao-data', 'local-post-runtimes', 'oiio', 'current', 'OpenImageIO', 'bin', 'oiiotool.exe');
}

const request = await readJsonStdin();
const runtimePath = path.resolve(String(request.runtimePath || process.env.HMDAO_POST_OCIO_PATH || '').trim());
if (!runtimePath) {
  throw new Error('ocio-runtime-not-configured');
}

const inputPath = path.resolve(String(request.inputPath || ''));
const outputPath = path.resolve(String(request.outputPath || ''));
const requestConfigPath = String(
  request.ocioConfigPath
  || request.defaultOcioConfigPath
  || process.env.HMDAO_POST_OIIO_OCIO_CONFIG
  || process.env.HMDAO_POST_OCIO_CONFIG
  || process.env.OCIO
  || '',
).trim();
if (!requestConfigPath) {
  throw new Error('ocio-config-not-configured');
}
const ocioConfigPath = path.resolve(requestConfigPath);
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const color = request.colorConfig && typeof request.colorConfig === 'object' ? request.colorConfig : {};
const inputSpace = mapColorSpace(color.colorSpaceIn || 'sRGB', ocioConfigPath);
const outputSpace = mapColorSpace(color.colorSpaceOut || 'Rec.709', ocioConfigPath);
if (!inputSpace || !outputSpace) {
  throw new Error('ocio-colorspace-not-resolved');
}

const oiioRuntimePath = path.resolve(String(
  request.oiioRuntimePath
  || process.env.HMDAO_POST_OIIO_PATH
  || detectManagedOiioPath()
  || '',
).trim());
if (!oiioRuntimePath) {
  throw new Error('ocio-managed-oiio-runtime-not-configured');
}

const warnings = [];
if (String(request.mediaKind || 'image').trim() !== 'image') {
  throw new Error('ocio-managed-image-only');
}
if (request.lutPath) {
  warnings.push('当前 OpenColorIO managed wrapper 先执行颜色空间转换；LUT 仍优先交给 OIIO 严格链路处理。');
}

await runCommand(oiioRuntimePath, [
  inputPath,
  '--attrib',
  'oiio:ColorConfig',
  ocioConfigPath,
  '--colorconvert',
  inputSpace,
  outputSpace,
  '-o',
  outputPath,
], path.dirname(oiioRuntimePath), {
  OCIO: ocioConfigPath,
});

process.stdout.write(JSON.stringify({
  outputPath,
  engine: 'OpenColorIO Runtime (via OIIO)',
  meta: {
    ocioConfigPath,
    inputSpace,
    outputSpace,
    runtimePath,
    oiioRuntimePath,
  },
  warnings,
}));
