// P1-11 抽取：自 hmdao-api.mjs 原样搬移（零转写），仅追加 export 前缀。
// 依赖常量/工具经既有模块单点导入，ESM 单例语义与原文件一致。
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { runCommand } from './local-post-processing.mjs';
import { spawn } from 'node:child_process';

export async function runLocalPython(commandArgs, { scriptPath, args = [], cwd = APP_DIR, timeoutMs = 0 } = {}) {
  const executable = commandArgs[0];
  const prefixArgs = commandArgs.slice(1);
  const finalArgs = scriptPath ? [...prefixArgs, scriptPath, ...args] : [...prefixArgs, ...args];
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, finalArgs, {
      cwd,
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let timedOut = false;
    const timeoutHandle = Number(timeoutMs) > 0
      ? setTimeout(() => {
          timedOut = true;
          try {
            child.kill();
          } catch {
            // noop
          }
        }, Number(timeoutMs))
      : null;
    child.stdout.on('data', (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      if (timedOut) {
        reject(new Error(`${executable} timed out after ${Number(timeoutMs)}ms`));
        return;
      }
      const detail = stderr.trim().split(/\r?\n/).slice(-10).join(' | ');
      reject(new Error(`${executable} exited ${code}: ${detail || 'unknown-error'}`));
    });
  });
}

export async function runPreferredLocalPython({ scriptPath, args = [], cwd = APP_DIR, timeoutMs = 0 } = {}) {
  const candidates = [
    ['py', '-3.13'],
  ];
  let lastError = null;
  for (const candidate of candidates) {
    try {
      return await runLocalPython(candidate, { scriptPath, args, cwd, timeoutMs });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('preferred-local-python-unavailable');
}

export async function runJsonPythonScript(scriptPath, args = []) {
  const { stdout } = await runPreferredLocalPython({ scriptPath, args });
  const text = String(stdout || '').trim();
  if (!text) {
    throw new Error(`python-script-empty-output:${path.basename(scriptPath)}`);
  }
  return JSON.parse(text);
}

export async function probeVideoFile(filePath) {
  const { stdout } = await runCommand('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height:format=duration',
    '-of',
    'json',
    filePath,
  ]);
  const parsed = JSON.parse(stdout || '{}');
  return {
    width: Math.max(2, Number(parsed?.streams?.[0]?.width || 0)),
    height: Math.max(2, Number(parsed?.streams?.[0]?.height || 0)),
    duration: Math.max(0, Number(parsed?.format?.duration || 0)),
  };
}

export async function probeImageFile(filePath) {
  const { stdout } = await runCommand('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-of',
    'json',
    filePath,
  ]);
  const parsed = JSON.parse(stdout || '{}');
  return {
    width: Math.max(2, Number(parsed?.streams?.[0]?.width || 0)),
    height: Math.max(2, Number(parsed?.streams?.[0]?.height || 0)),
    duration: 0,
  };
}

export async function probeMediaStreams(filePath) {
  const { stdout } = await runCommand('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type',
    '-of',
    'json',
    filePath,
  ]);
  const parsed = JSON.parse(stdout || '{}');
  const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
  return {
    hasVideo: streams.some((stream) => String(stream?.codec_type || '').toLowerCase() === 'video'),
    hasAudio: streams.some((stream) => String(stream?.codec_type || '').toLowerCase() === 'audio'),
  };
}

export function normalizeClipSegments(segments, sourceDuration) {
  return (Array.isArray(segments) ? segments : [])
    .map((segment) => {
      const startTime = Math.max(0, Math.min(Number(segment?.startTime || 0), Math.max(0, sourceDuration - 0.05)));
      const endTime = Math.max(startTime + 0.05, Math.min(Number(segment?.endTime || sourceDuration), sourceDuration));
      return {
        startTime: Number(startTime.toFixed(3)),
        endTime: Number(endTime.toFixed(3)),
      };
    })
    .filter((segment) => segment.endTime > segment.startTime + 0.01)
    .sort((left, right) => left.startTime - right.startTime);
}

export function evenSize(value, fallback = 2) {
  const rounded = Math.max(2, Math.round(Number(value) || fallback));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

export async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function buildWebmEncodeArgs(outputPath, { includeAudio = false } = {}) {
  const args = [
    '-c:v',
    'libvpx',
    '-deadline',
    'good',
    '-cpu-used',
    '4',
    '-crf',
    '18',
    '-b:v',
    '0',
    '-pix_fmt',
    'yuv420p',
  ];
  if (includeAudio) {
    args.push('-c:a', 'libopus', '-b:a', '128k');
  } else {
    args.push('-an');
  }
  args.push(outputPath);
  return args;
}

// 高质量 H.264/MP4 编码参数（接近无损，画质远优于 VP9 的 crf18/cpu-used4）。
// 用于裁剪/剪辑这类"不应明显损失画质"的编辑：去掉 scale（避免不必要的缩放）、
// crf 16 + preset slow，配合 yuv420p + faststart 保证预览兼容与清晰度。
export function buildHighQualityMp4Args(outputPath, { includeAudio = true } = {}) {
  const args = ['-map', '0:v:0'];
  if (includeAudio) {
    args.push('-map', '0:a?');
  }
  args.push(
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '16',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
  );
  if (includeAudio) {
    args.push('-c:a', 'aac', '-b:a', '192k');
  } else {
    args.push('-an');
  }
  args.push(outputPath);
  return args;
}

export function buildIntermediateVideoArgs(outputPath) {
  return [
    '-an',
    '-c:v',
    'libvpx',
    '-deadline',
    'good',
    '-cpu-used',
    '4',
    '-crf',
    '18',
    '-b:v',
    '0',
    '-pix_fmt',
    'yuv420p',
    outputPath,
  ];
}

export function buildIntermediateImageArgs(outputPath) {
  return [
    '-frames:v',
    '1',
    '-c:v',
    'png',
    outputPath,
  ];
}

export function bloomBlendMode(value) {
  if (value === 'add') return 'addition';
  if (value === 'softlight') return 'softlight';
  return 'screen';
}

export function audioExtensionFromMimeType(mimeType = 'audio/mpeg') {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.includes('wav')) return 'wav';
  if (normalized.includes('ogg')) return 'ogg';
  if (normalized.includes('flac')) return 'flac';
  return 'mp3';
}

export function clampAudioSample(value) {
  return Math.max(-1, Math.min(1, value));
}

export function hashString(value = '') {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

export function floatSamplesToWavBuffer(channels, sampleRate = 44100) {
  const safeChannels = Array.isArray(channels) ? channels : [];
  const channelCount = Math.max(1, safeChannels.length);
  const frameCount = safeChannels[0]?.length || 0;
  const blockAlign = channelCount * 2;
  const byteRate = sampleRate * blockAlign;
  const dataSize = frameCount * blockAlign;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channelCount, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const sample = clampAudioSample(Number(safeChannels[channel]?.[frame] || 0));
      const pcm = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
      buffer.writeInt16LE(pcm, offset);
      offset += 2;
    }
  }
  return buffer;
}
