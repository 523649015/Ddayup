import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

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

function fileExtensionToOutputType(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'jpeg';
  if (ext === '.webp') return 'webp';
  if (ext === '.bmp') return 'bmp';
  if (ext === '.tif' || ext === '.tiff') return 'tiff';
  return 'png';
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
        reject(new Error(`oiiotool exited with code ${code}: ${stderrText || stdoutText || 'unknown-error'}`));
        return;
      }
      resolve({ stdout: stdoutText, stderr: stderrText });
    });
  });
}

const request = await readJsonStdin();
const runtimePath = path.resolve(String(request.runtimePath || process.env.HMDAO_POST_OIIO_PATH || '').trim());
if (!runtimePath) {
  throw new Error('oiio-runtime-not-configured');
}

const inputPath = path.resolve(String(request.inputPath || ''));
const outputPath = path.resolve(String(request.outputPath || ''));
const lutPath = String(request.lutPath || '').trim();
const requestConfigPath = String(
  request.ocioConfigPath
  || request.defaultOcioConfigPath
  || process.env.HMDAO_POST_OIIO_OCIO_CONFIG
  || process.env.HMDAO_POST_OCIO_CONFIG
  || process.env.OCIO
  || '',
).trim();
if (!requestConfigPath) {
  throw new Error('oiio-ocio-config-missing');
}
const ocioConfigPath = path.resolve(requestConfigPath);
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const color = request.colorConfig && typeof request.colorConfig === 'object' ? request.colorConfig : {};
const inputSpace = mapColorSpace(color.colorSpaceIn || 'sRGB', ocioConfigPath);
const outputSpace = mapColorSpace(color.colorSpaceOut || 'Rec.709', ocioConfigPath);

const args = [
  inputPath,
  '--attrib',
  'oiio:ColorConfig',
  ocioConfigPath,
];
if (inputSpace && outputSpace && inputSpace !== outputSpace) {
  args.push('--colorconvert', inputSpace, outputSpace);
}
if (lutPath) {
  args.push('--ociofiletransform', path.resolve(lutPath));
}
args.push('-o', outputPath);

await runCommand(runtimePath, args, path.dirname(runtimePath), {
  OCIO: ocioConfigPath,
});

process.stdout.write(JSON.stringify({
  outputPath,
  engine: 'OpenImageIO oiiotool',
  meta: {
    ocioConfigPath,
    inputSpace,
    outputSpace,
    lutApplied: Boolean(lutPath),
  },
  warnings: [
    String(color.ocioDisplay || '').trim() && String(color.ocioDisplay || '').trim() !== 'rec709-monitor'
      ? '当前 OIIO 严格链路以色彩空间转换和 LUT 变换为主，显示视图细节仍以现有 OCIO / FFmpeg 面板参数为准。'
      : '',
  ].filter(Boolean),
}));
