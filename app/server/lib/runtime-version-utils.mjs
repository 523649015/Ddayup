// P1-11 抽取：自 hmdao-api.mjs 原样搬移（零转写），仅追加 export 前缀。
// 依赖常量/工具经既有模块单点导入，ESM 单例语义与原文件一致。
import path from 'node:path';
import { getManagedRuntimeManifestEntry } from './local-post-processing.mjs';
import { spawn } from 'node:child_process';
import { APP_DIR } from './server-paths.mjs';
import { LOCAL_POST_SELF_CHECK_TIMEOUT_MS } from './local-post-constants.mjs';

export function trimDiagnosticText(value, maxLength = 220) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength - 1) + '...';
}

export function firstSemverToken(value) {
  const matched = String(value || '').match(/\bv?\d+(?:\.\d+){1,4}(?:[-+._][0-9A-Za-z.-]+)?\b/);
  return matched ? matched[0].replace(/^v/i, '') : '';
}

export function versionParts(value) {
  return String(value || '')
    .replace(/^v/i, '')
    .split(/[^0-9A-Za-z]+/)
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part.toLowerCase()));
}

export function compareVersionStrings(left, right) {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  const maxLength = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < maxLength; index += 1) {
    const a = leftParts[index];
    const b = rightParts[index];
    if (a === undefined && b === undefined) return 0;
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (typeof a === 'number' && typeof b === 'number') {
      if (a > b) return 1;
      if (a < b) return -1;
      continue;
    }
    const nextA = String(a);
    const nextB = String(b);
    if (nextA > nextB) return 1;
    if (nextA < nextB) return -1;
  }
  return 0;
}

export async function runLocalPostDiagnosticCommand(command, args = [], {
  cwd = APP_DIR,
  extraEnv = {},
  timeoutMs = LOCAL_POST_SELF_CHECK_TIMEOUT_MS,
} = {}) {
  return await new Promise((resolve) => {
    const stdout = [];
    const stderr = [];
    let finished = false;
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...extraEnv,
      },
    });
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill('SIGTERM');
      resolve({
        ok: false,
        timedOut: true,
        exitCode: null,
        stdout: trimDiagnosticText(Buffer.concat(stdout).toString('utf8'), 600),
        stderr: trimDiagnosticText(Buffer.concat(stderr).toString('utf8'), 600),
        elapsedMs: Date.now() - startedAt,
      });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        timedOut: false,
        exitCode: null,
        stdout: trimDiagnosticText(Buffer.concat(stdout).toString('utf8'), 600),
        stderr: trimDiagnosticText(error instanceof Error ? error.message : String(error), 600),
        elapsedMs: Date.now() - startedAt,
      });
    });
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        timedOut: false,
        exitCode: code,
        stdout: trimDiagnosticText(Buffer.concat(stdout).toString('utf8'), 600),
        stderr: trimDiagnosticText(Buffer.concat(stderr).toString('utf8'), 600),
        elapsedMs: Date.now() - startedAt,
      });
    });
  });
}

export async function detectInstalledRuntimeVersion(runtimePath, attempts = []) {
  for (const attempt of attempts) {
    const probe = await runLocalPostDiagnosticCommand(runtimePath, attempt.args, {
      cwd: path.dirname(runtimePath),
      extraEnv: attempt.extraEnv || {},
    });
    const combined = `${probe.stdout}\n${probe.stderr}`.trim();
    const version = firstSemverToken(combined);
    if (probe.ok || version) {
      return {
        ok: probe.ok,
        version,
        probe,
        commandArgs: attempt.args,
      };
    }
  }
  return {
    ok: false,
    version: '',
    probe: {
      ok: false,
      timedOut: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      elapsedMs: 0,
    },
    commandArgs: [],
  };
}

export async function detectOcioRuntimeInstallation(runtimePath) {
  const normalizedPath = String(runtimePath || '').trim();
  if (!normalizedPath) {
    return {
      ok: false,
      version: '',
      probe: null,
      commandArgs: [],
    };
  }
  const probe = await runLocalPostDiagnosticCommand(normalizedPath, ['--help'], {
    cwd: path.dirname(normalizedPath),
  });
  const combinedOutput = `${String(probe?.stdout || '')}\n${String(probe?.stderr || '')}`;
  const managedVersion = String(getManagedRuntimeManifestEntry('ocio')?.version || '').trim();
  const version = managedVersion || firstSemverToken(combinedOutput);
  const ok = /ocioconvert -- apply colorspace transform to an image/i.test(combinedOutput);
  return {
    ok,
    version,
    probe: {
      ...probe,
      ok,
    },
    commandArgs: ['--help'],
  };
}
