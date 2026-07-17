import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ENTRY = path.resolve(APP_DIR, 'server', 'hmdao-api.mjs');
const ARTIFACT_ROOT = path.resolve(APP_DIR, 'server', 'artifacts');
const PUBLIC_VERIFY_DIR = path.resolve(APP_DIR, 'public', 'verification');
const PUBLIC_SUMMARY_PATH = path.resolve(PUBLIC_VERIFY_DIR, 'local-image-analysis-smoke-summary.json');
const VERIFY_PORT = Number(process.env.HMDAO_IMAGE_ANALYSIS_SMOKE_PORT || 8794);
const VERIFY_URL = `http://127.0.0.1:${VERIFY_PORT}`;
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-');
const ARTIFACT_DIR = path.resolve(ARTIFACT_ROOT, `image-analysis-smoke-${TIMESTAMP}`);

function log(...args) {
  console.log('[image-analysis-smoke]', ...args);
}

function assert(condition, message, details = null) {
  if (condition) return;
  const error = new Error(message);
  error.details = details;
  throw error;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHttp(url, timeoutMs = 30000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`Unexpected status ${response.status} for ${url}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(350);
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

async function writePublicSummary(summary) {
  await fs.mkdir(PUBLIC_VERIFY_DIR, { recursive: true });
  await fs.writeFile(PUBLIC_SUMMARY_PATH, JSON.stringify(summary, null, 2), 'utf8');
}

async function terminateChild(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
        stdio: 'ignore',
        shell: false,
        windowsHide: true,
      });
      killer.on('error', () => resolve());
      killer.on('exit', () => resolve());
    });
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // noop
  }
}

async function writeSmokeRuntimeScripts() {
  await fs.mkdir(ARTIFACT_DIR, { recursive: true });
  const florencePath = path.join(ARTIFACT_DIR, 'smoke_florence2_runtime.py');
  const qwenPath = path.join(ARTIFACT_DIR, 'smoke_qwen_runtime.py');
  const florenceScript = String.raw`
import argparse, json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--hmdao-request", required=True)
parser.add_argument("--hmdao-output", required=True)
args = parser.parse_args()
request = json.loads(Path(args.hmdao_request).read_text(encoding="utf-8-sig"))
payload = {
  "engine": "Florence-2 Smoke Runtime",
  "summary": "Florence 烟雾测试总结，主体稳定，场景完整。",
  "subject": "Florence 烟雾测试主体",
  "scene": "Florence 烟雾测试场景",
  "style": "Florence 结构化描述风格",
  "lighting": "Florence 柔和商业光影",
  "composition": "横向构图，主体位置稳定",
  "camera": "Florence 中近景镜头",
  "mood": "Florence 冷静商业感",
  "keywords": ["Florence烟雾测试", "主体稳定", "商业构图"],
  "palette": ["蓝色", "橙色"],
  "promptZh": "Florence 烟雾测试中文提示词：保持主体不变，强化商业海报感。",
  "promptEn": "Florence smoke prompt with stable subject and commercial poster feeling.",
  "warnings": ["florence-smoke-invoked"],
  "metadata": {"smoke": True, "requestEngine": request.get("engine", "")},
}
Path(args.hmdao_output).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
`;
  const qwenScript = String.raw`
import argparse, json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--hmdao-request", required=True)
parser.add_argument("--hmdao-output", required=True)
args = parser.parse_args()
request = json.loads(Path(args.hmdao_request).read_text(encoding="utf-8-sig"))
payload = {
  "engine": "Qwen Vision Smoke Runtime",
  "summary": "Qwen 烟雾测试总结，强调中文镜头语义和风格组织。",
  "subject": "Qwen 烟雾测试主体",
  "scene": "Qwen 烟雾测试城市场景",
  "style": "Qwen 中文镜头整理风格",
  "lighting": "Qwen 戏剧轮廓光",
  "composition": "横向构图，保留主体位置与景深层次",
  "camera": "Qwen 电影感跟拍镜头",
  "mood": "Qwen 高级氛围感",
  "keywords": ["Qwen烟雾测试", "中文镜头语义", "风格组织"],
  "palette": ["蓝色", "洋红"],
  "promptZh": "Qwen 烟雾测试中文提示词：保持主体和构图，强化镜头语言、风格和光影氛围。",
  "promptEn": "Qwen smoke prompt keeping subject and framing while enhancing style and cinematic lighting.",
  "warnings": ["qwen-smoke-invoked"],
  "metadata": {"smoke": True, "requestEngine": request.get("engine", "")},
}
Path(args.hmdao_output).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
`;
  await fs.writeFile(florencePath, florenceScript.trimStart(), 'utf8');
  await fs.writeFile(qwenPath, qwenScript.trimStart(), 'utf8');
  return { florencePath, qwenPath };
}

async function writeSampleImage() {
  const imagePath = path.join(ARTIFACT_DIR, 'smoke-input.png');
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAoCAYAAABOzvzpAAAACXBIWXMAAAsSAAALEgHS3X78AAAAxUlEQVR4nO3YQQqDQBRA0Y7o/lduR2iTQwM2dAuNEqXtbTzupCSvJzpuG1HsfrN7OYMCAgICAgICAgICAv4w6rMUiP+6JGZveCe8NjEcNWef39/C4R2tQeM+c/37yBfybp/BK+f5dyFwchAuC8W9j9HgOAEm97X3gSdz8PgRP/6IDdnh3oX1N1CAVccawJgN9zeps2sonMSKcwkxyjCQkBQUFBQUFBQUGh8A2B204MSmc5QwAAAABJRU5ErkJggg==';
  await fs.writeFile(imagePath, Buffer.from(pngBase64, 'base64'));
  return imagePath;
}

async function startSmokeApi(envOverrides) {
  const child = spawn('node', [SERVER_ENTRY], {
    cwd: APP_DIR,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HMDAO_API_PORT: String(VERIFY_PORT),
      HMDAO_CLIP_INTERROGATOR_COMMAND: '',
      HMDAO_CLIP_INTERROGATOR_PATH: '',
      HMDAO_IMAGE_ANALYSIS_COMMAND: '',
      HMDAO_IMAGE_ANALYSIS_API_COMMAND: '',
      HMDAO_IMAGE_ANALYSIS_API_PATH: '',
      ...envOverrides,
    },
  });
  const stdoutLog = path.join(ARTIFACT_DIR, 'smoke-api.out.log');
  const stderrLog = path.join(ARTIFACT_DIR, 'smoke-api.err.log');
  child.stdout.on('data', (chunk) => fs.appendFile(stdoutLog, chunk).catch(() => {}));
  child.stderr.on('data', (chunk) => fs.appendFile(stderrLog, chunk).catch(() => {}));
  await waitForHttp(`${VERIFY_URL}/api/health`, 30000);
  return child;
}

async function analyzeImage({ imagePath, engine }) {
  const form = new FormData();
  const imageBuffer = await fs.readFile(imagePath);
  form.append('file', new Blob([imageBuffer], { type: 'image/png' }), path.basename(imagePath));
  form.append('name', path.basename(imagePath));
  form.append('width', '64');
  form.append('height', '40');
  form.append('engine', engine);
  form.append('tags', JSON.stringify(['smoke', engine]));
  form.append('smartCategories', JSON.stringify(['验证', '提示词反推']));
  const response = await fetch(`${VERIFY_URL}/api/local-image/analyze`, {
    method: 'POST',
    body: form,
  });
  const data = await response.json().catch(() => ({}));
  assert(response.ok && data?.success && data?.analysis, `Image analysis request failed for ${engine}`, { status: response.status, data });
  return data.analysis;
}

function summarizeAnalysis(analysis) {
  return {
    engine: String(analysis?.engine || ''),
    subject: String(analysis?.subject || ''),
    style: String(analysis?.style || ''),
    promptZh: String(analysis?.promptZh || ''),
    warnings: Array.isArray(analysis?.warnings) ? analysis.warnings : [],
    runtime: analysis?.runtime || {},
    metadata: analysis?.metadata || {},
  };
}

async function main() {
  const keepApi = process.argv.includes('--keep-api');
  await fs.mkdir(ARTIFACT_DIR, { recursive: true });
  const { florencePath, qwenPath } = await writeSmokeRuntimeScripts();
  const imagePath = await writeSampleImage();
  let apiChild = null;
  try {
    apiChild = await startSmokeApi({
      HMDAO_FLORENCE2_PATH: florencePath,
      HMDAO_QWEN35_VL_PATH: qwenPath,
      HMDAO_QWEN25_VL_PATH: '',
      HMDAO_FLORENCE2_COMMAND: '',
      HMDAO_QWEN35_VL_COMMAND: '',
      HMDAO_QWEN25_VL_COMMAND: '',
    });

    const florence = await analyzeImage({ imagePath, engine: 'florence2' });
    const qwen = await analyzeImage({ imagePath, engine: 'qwen35-vl' });
    const fusion = await analyzeImage({ imagePath, engine: 'prompt-fusion' });

    assert(florence.warnings?.includes('florence-smoke-invoked'), 'Florence smoke runtime was not invoked.', summarizeAnalysis(florence));
    assert(qwen.warnings?.includes('qwen-smoke-invoked'), 'Qwen smoke runtime was not invoked.', summarizeAnalysis(qwen));
    assert(
      Array.isArray(fusion?.warnings) && fusion.warnings.includes('florence-smoke-invoked') && fusion.warnings.includes('qwen-smoke-invoked'),
      'Prompt fusion did not include both Florence and Qwen smoke runtime traces.',
      summarizeAnalysis(fusion),
    );
    assert(
      String(fusion?.runtime?.resolvedEngine || '').includes('prompt-fusion') || String(fusion?.engine || '').includes('prompt-fusion'),
      'Prompt fusion did not report a prompt-fusion engine.',
      summarizeAnalysis(fusion),
    );

    const summary = {
      success: true,
      apiUrl: VERIFY_URL,
      artifactDir: ARTIFACT_DIR,
      publicSummaryPath: PUBLIC_SUMMARY_PATH,
      checkedAt: new Date().toISOString(),
      runtimes: {
        florencePath,
        qwenPath,
      },
      analyses: {
        florence: summarizeAnalysis(florence),
        qwen: summarizeAnalysis(qwen),
        fusion: summarizeAnalysis(fusion),
      },
    };
    const summaryPath = path.join(ARTIFACT_DIR, 'summary.json');
    await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
    await writePublicSummary(summary);
    log('Smoke verification completed.', summary);
  } catch (error) {
    const failure = {
      success: false,
      apiUrl: VERIFY_URL,
      artifactDir: ARTIFACT_DIR,
      publicSummaryPath: PUBLIC_SUMMARY_PATH,
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      details: error?.details || null,
    };
    await fs.writeFile(path.join(ARTIFACT_DIR, 'summary.json'), JSON.stringify(failure, null, 2), 'utf8');
    await writePublicSummary(failure);
    console.error('[image-analysis-smoke] failed:', failure);
    process.exitCode = 1;
  } finally {
    if (apiChild && !keepApi) {
      await terminateChild(apiChild);
    }
  }
}

await main();
