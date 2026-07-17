import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function readJsonStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

export async function runHmdaoAudioRuntime({
  backendName,
  backendLabel,
  runtimePath,
  request,
}) {
  if (!runtimePath) {
    throw new Error(`${backendName}-runtime-not-configured`);
  }
  const resolvedRuntimePath = path.resolve(String(runtimePath));
  const stat = await fs.stat(resolvedRuntimePath).catch(() => null);
  if (!stat) {
    throw new Error(`${backendName}-runtime-missing:${resolvedRuntimePath}`);
  }

  const outputDir = path.resolve(String(request.outputDir || process.cwd()));
  await fs.mkdir(outputDir, { recursive: true });
  const requestId = String(request.requestId || crypto.randomUUID());
  const requestPath = path.join(outputDir, `${requestId}-${backendName}-request.json`);
  const outputPath = path.join(outputDir, `${requestId}-${backendName}-output.json`);
  await fs.writeFile(requestPath, JSON.stringify({
    ...request,
    backendName,
    backendLabel,
  }, null, 2), 'utf8');

  const { command, args } = buildRuntimeInvocation(resolvedRuntimePath, requestPath, outputPath);
  const { stdout, stderr } = await runCommand(command, args, path.dirname(resolvedRuntimePath));
  const outputRaw = await fs.readFile(outputPath, 'utf8').catch(() => '');

  await Promise.all([
    fs.rm(requestPath, { force: true }).catch(() => {}),
    fs.rm(outputPath, { force: true }).catch(() => {}),
  ]);

  if (!outputRaw.trim()) {
    const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join(' | ');
    throw new Error(`${backendName}-runtime-empty-output${detail ? `:${detail}` : ''}`);
  }
  return JSON.parse(outputRaw);
}

function buildRuntimeInvocation(runtimePath, requestPath, outputPath) {
  const ext = path.extname(runtimePath).toLowerCase();
  if (ext === '.py') {
    return {
      command: 'python',
      args: [runtimePath, '--hmdao-request', requestPath, '--hmdao-output', outputPath],
    };
  }
  if (ext === '.ps1') {
    return {
      command: 'powershell',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runtimePath, '--hmdao-request', requestPath, '--hmdao-output', outputPath],
    };
  }
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    return {
      command: 'node',
      args: [runtimePath, '--hmdao-request', requestPath, '--hmdao-output', outputPath],
    };
  }
  return {
    command: runtimePath,
    args: ['--hmdao-request', requestPath, '--hmdao-output', outputPath],
  };
}

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error([
          `${command} exited with code ${code}`,
          Buffer.concat(stderr).toString('utf8').trim(),
          Buffer.concat(stdout).toString('utf8').trim(),
        ].filter(Boolean).join(' | ')));
        return;
      }
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}
