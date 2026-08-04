import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function readJsonStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

export async function runHmdaoImageAnalysisRuntime({
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

  const requestId = String(request.requestId || crypto.randomUUID());
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), `hmdao-image-analysis-${backendName}-`));
  const requestPath = path.join(outputDir, `${requestId}-${backendName}-request.json`);
  const resultPath = path.join(outputDir, `${requestId}-${backendName}-result.json`);

  await fs.writeFile(requestPath, JSON.stringify({
    ...request,
    backendName,
    backendLabel,
  }, null, 2), 'utf8');

  const { command, args } = buildRuntimeInvocation(resolvedRuntimePath, requestPath, resultPath);
  const extraEnv = {};
  // Florence-2 一键安装后，模型缓存放到独立目录，需通过 HF_HOME 让 from_pretrained 离线命中；
  // HMDAO_FLORENCE2_MODEL 指向本地目录，使推理脚本直接 from_pretrained(本地路径)，彻底离线。
  if (process.env.HMDAO_FLORENCE2_HF_HOME) extraEnv.HF_HOME = process.env.HMDAO_FLORENCE2_HF_HOME;
  if (process.env.HMDAO_FLORENCE2_MODEL) extraEnv.HMDAO_FLORENCE2_MODEL = process.env.HMDAO_FLORENCE2_MODEL;
  const { stdout, stderr } = await runCommand(command, args, path.dirname(resolvedRuntimePath), extraEnv);
  const outputRaw = await fs.readFile(resultPath, 'utf8').catch(() => '');

  await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});

  if (!outputRaw.trim()) {
    const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join(' | ');
    throw new Error(`${backendName}-runtime-empty-output${detail ? `:${detail}` : ''}`);
  }
  return JSON.parse(outputRaw);
}

function buildRuntimeInvocation(runtimePath, requestPath, outputPath) {
  const ext = path.extname(runtimePath).toLowerCase();
  if (ext === '.py') {
    // 优先使用「一键安装」创建的 venv python，否则回退到系统 py -3
    const managedPython = String(process.env.HMDAO_FLORENCE2_PYTHON || '').trim();
    if (managedPython) {
      return {
        command: managedPython,
        args: [runtimePath, '--hmdao-request', requestPath, '--hmdao-output', outputPath],
      };
    }
    return {
      command: 'py',
      args: ['-3', runtimePath, '--hmdao-request', requestPath, '--hmdao-output', outputPath],
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

function runCommand(command, args, cwd, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv },
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
