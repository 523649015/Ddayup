// ComfyUI 中转网关服务模块（代理/上传/临时素材/安装检测），从 hmdao-api.mjs 迁移（原 14687..15258 行）
// 工厂模式：外部项目级依赖经 deps 注入；import 来源符号本地 re-import；内部互引保持闭包。
import { promises as fs, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import process from 'node:process';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { statSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { readdirSync } from 'node:fs';

export function createComfyService(deps = {}) {
  const {
    Busboy,
    extensionFromMimeType,
    sanitizeMultipartFieldName,
    send,
    getRequestOrigin,
    COMFYUI_TEMP_DIR,
    COMFYUI_TEMP_TTL_MS,
    providers,
    https,
  } = deps;

// ---- ComfyUI 中转网关接入（Phase 1：代理骨架 + 临时素材托管 + 定时清理） ----
function getComfyuiGatewayUrl() {
  const raw = String(process.env.HMDAO_COMFYUI_GATEWAY_URL || '').trim();
  if (!raw) return '';
  return raw.replace(/\/+$/, '');
}

function readComfyUiJsonBody(req, limitBytes = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limitBytes) {
        done = true;
        reject(new Error('comfyui-request-body-too-large'));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('comfyui-invalid-json-body'));
      }
    });
    req.on('error', (e) => {
      if (done) return;
      done = true;
      reject(e);
    });
  });
}

async function handleComfyUiUpload(req, res, url) {
  await fs.mkdir(COMFYUI_TEMP_DIR, { recursive: true });
  const uploadId = crypto.randomUUID();
  const uploadedFiles = new Map();
  const busboy = Busboy({
    headers: req.headers,
    limits: { files: 12, fields: 32, fileSize: Number(process.env.HMDAO_COMFYUI_MAX_BYTES || 1024 * 1024 * 1024) },
  });
  const pending = [];
  await new Promise((resolve, reject) => {
    busboy.on('field', (name, value) => {
      void name; void value;
    });
    busboy.on('file', (name, file, info = {}) => {
      const fieldName = String(name || '').trim() || 'file';
      const ext = extensionFromMimeType(info.mimeType || 'application/octet-stream');
      const safeFieldName = sanitizeMultipartFieldName(fieldName);
      const filePath = path.join(COMFYUI_TEMP_DIR, `${uploadId}-${safeFieldName}.${ext}`);
      const p = pipeline(file, createWriteStream(filePath))
        .then(() => uploadedFiles.set(fieldName, {
          filePath,
          filename: String(info.filename || ''),
          mimeType: String(info.mimeType || 'application/octet-stream'),
        }))
        .catch(() => {});
      pending.push(p);
    });
    busboy.once('error', reject);
    busboy.once('finish', () => Promise.all(pending).then(() => resolve(), () => resolve()));
    req.once('aborted', () => reject(new Error('comfyui-upload-aborted')));
  });

  const first = Array.from(uploadedFiles.values())[0];
  if (!first) {
    return send(res, 400, { success: false, error: 'no-file' });
  }
  const fileName = path.basename(first.filePath);
  const origin = getRequestOrigin(req);
  return send(res, 200, {
    success: true,
    url: `${origin}/api/comfyui/tmp/${encodeURIComponent(fileName)}`,
    ttlSeconds: Math.round(COMFYUI_TEMP_TTL_MS / 1000),
    fileName,
    mimeType: first.mimeType,
  });
}

async function handleComfyUiApi(req, res, url) {
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/api/comfyui/health') {
    const gateway = getComfyuiGatewayUrl();
    if (!gateway) {
      return send(res, 200, {
        success: true,
        configured: false,
        reachable: false,
        gatewayUrl: null,
        detail: 'gateway not configured (HMDAO_COMFYUI_GATEWAY_URL)',
        instances: [],
        guidance: null,
      });
    }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2500);
      const r = await fetch(`${gateway}/health`, { signal: ctrl.signal });
      clearTimeout(timer);
      const data = await r.json().catch(() => ({}));
      // 转发网关返回：实例可达性 + 安装指引，供前端判断是否已安装 ComfyUI。
      const instances = Array.isArray(data?.instances) ? data.instances : [];
      const reachable = Boolean(data?.reachable) || instances.some((i) => i?.reachable);
      return send(res, 200, {
        success: true,
        configured: Boolean(data?.configured ?? true),
        reachable,
        gatewayUrl: gateway,
        detail: data?.detail || `gateway responded HTTP ${r.status}`,
        instances,
        guidance: data?.guidance || null,
      });
    } catch (e) {
      return send(res, 200, {
        success: true,
        configured: true,
        reachable: false,
        gatewayUrl: gateway,
        detail: `gateway unreachable: ${String(e?.message || e)}`,
        instances: [],
        guidance: null,
      });
    }
  }

  if (req.method === 'GET' && pathname === '/api/comfyui/plugins') {
    const gateway = getComfyuiGatewayUrl();
    if (!gateway) {
      return send(res, 200, { success: true, configured: false, plugins: [] });
    }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(`${gateway}/plugins`, { signal: ctrl.signal });
      clearTimeout(timer);
      const data = await r.json().catch(() => ({}));
      return send(res, r.ok ? 200 : 502, { success: r.ok, configured: true, plugins: data?.plugins || data?.nodes || [] });
    } catch (e) {
      return send(res, 200, { success: false, configured: true, reachable: false, plugins: [], error: String(e?.message || e) });
    }
  }

  if (req.method === 'POST' && pathname === '/api/comfyui/upload') {
    try {
      return await handleComfyUiUpload(req, res, url);
    } catch (e) {
      return send(res, 500, { success: false, error: String(e?.message || e) });
    }
  }

  if (req.method === 'GET' && pathname.startsWith('/api/comfyui/tmp/')) {
    const fileName = path.basename(decodeURIComponent(pathname.slice('/api/comfyui/tmp/'.length)));
    const filePath = path.join(COMFYUI_TEMP_DIR, fileName);
    if (!filePath.startsWith(COMFYUI_TEMP_DIR) || !existsSync(filePath)) {
      return send(res, 404, { success: false, error: 'not-found' });
    }
    const stat = statSync(filePath);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=300',
    });
    createReadStream(filePath).pipe(res);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/comfyui/prompt') {
    const gateway = getComfyuiGatewayUrl();
    if (!gateway) {
      return send(res, 503, {
        success: false,
        error: 'comfyui-gateway-not-configured',
        hint: '设置环境变量 HMDAO_COMFYUI_GATEWAY_URL 指向 daydayupAPI 网关',
      });
    }
    try {
      const body = await readComfyUiJsonBody(req);
      const headers = { 'Content-Type': 'application/json' };
      const gwKey = String(process.env.HMDAO_COMFYUI_GATEWAY_KEY || '').trim();
      if (gwKey) headers['x-hmdao-gateway-key'] = gwKey;
      // 透传用户标识，用于网关配额（缺失时网关按 anonymous 计）。
      const incomingUserId = req.headers['x-hmdao-user-id'];
      if (incomingUserId) headers['x-hmdao-user-id'] = incomingUserId;
      // 透传前端的 per-user 密钥覆盖（camelCase）为网关注入所需的 snake_case。
      const forward = {
        prompt: body && body.prompt,
        provider_keys:
          body && typeof body.providerKeys === 'object' && body.providerKeys ? body.providerKeys : {},
        provider_base_urls:
          body && typeof body.providerBaseUrls === 'object' && body.providerBaseUrls
            ? body.providerBaseUrls
            : {},
        client_id: body && typeof body.clientId === 'string' ? body.clientId : undefined,
        extra_data: body && typeof body.extraData === 'object' && body.extraData ? body.extraData : {},
        // 透传前端指定的 ComfyUI 实例地址（URL 或索引）；为空则网关默认轮询。
        instance: body && typeof body.instance === 'string' && body.instance.trim() ? body.instance : undefined,
      };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5 * 60 * 1000);
      const r = await fetch(`${gateway}/prompt`, {
        method: 'POST',
        headers,
        body: JSON.stringify(forward),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
      return send(res, r.ok ? 200 : (r.status || 502), { success: r.ok, ...(typeof data === 'object' && data ? data : { raw: text }) });
    } catch (e) {
      return send(res, 502, { success: false, error: String(e?.message || e) });
    }
  }

  if (req.method === 'POST' && pathname === '/api/comfyui/validate') {
    const gateway = getComfyuiGatewayUrl();
    if (!gateway) {
      return send(res, 503, {
        success: false,
        error: 'comfyui-gateway-not-configured',
        hint: '设置环境变量 HMDAO_COMFYUI_GATEWAY_URL 指向 daydayupAPI 网关',
      });
    }
    try {
      const body = await readComfyUiJsonBody(req);
      const headers = { 'Content-Type': 'application/json' };
      const gwKey = String(process.env.HMDAO_COMFYUI_GATEWAY_KEY || '').trim();
      if (gwKey) headers['x-hmdao-gateway-key'] = gwKey;
      const forward = {
        prompt: body && body.prompt,
        instance: body && typeof body.instance === 'string' && body.instance.trim() ? body.instance : undefined,
      };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      const r = await fetch(`${gateway}/validate`, {
        method: 'POST',
        headers,
        body: JSON.stringify(forward),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
      return send(res, r.ok ? 200 : (r.status || 502), {
        success: r.ok,
        ...(typeof data === 'object' && data ? data : { raw: text }),
      });
    } catch (e) {
      return send(res, 502, { success: false, error: String(e?.message || e) });
    }
  }

  if (req.method === 'GET' && /^\/api\/comfyui\/tasks\/[^/]+$/.test(pathname)) {
    const gateway = getComfyuiGatewayUrl();
    if (!gateway) {
      return send(res, 503, {
        success: false,
        error: 'comfyui-gateway-not-configured',
        hint: '设置环境变量 HMDAO_COMFYUI_GATEWAY_URL 指向 daydayupAPI 网关',
      });
    }
    const promptId = decodeURIComponent(pathname.slice('/api/comfyui/tasks/'.length));
    try {
      const headers = {};
      const gwKey = String(process.env.HMDAO_COMFYUI_GATEWAY_KEY || '').trim();
      if (gwKey) headers['x-hmdao-gateway-key'] = gwKey;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(`${gateway}/tasks/${encodeURIComponent(promptId)}`, {
        method: 'GET',
        headers,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
      return send(res, r.ok ? 200 : (r.status || 404), {
        success: r.ok,
        ...(typeof data === 'object' && data ? data : { raw: text }),
      });
    } catch (e) {
      return send(res, 502, { success: false, error: String(e?.message || e) });
    }
  }

  // 配置下发（ALLOW_CLIENT_KEYS / MARKERS 等），供前端暴露可配置项。
  if (req.method === 'GET' && pathname === '/api/comfyui/config') {
    const gateway = getComfyuiGatewayUrl();
    if (!gateway) {
      return send(res, 200, {
        success: true,
        configured: false,
        allowClientKeys: false,
        markers: [],
        providers: [],
      });
    }
    try {
      const headers = {};
      const gwKey = String(process.env.HMDAO_COMFYUI_GATEWAY_KEY || '').trim();
      if (gwKey) headers['x-hmdao-gateway-key'] = gwKey;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(`${gateway}/config`, { method: 'GET', headers, signal: ctrl.signal });
      clearTimeout(timer);
      const data = await r.json().catch(() => ({}));
      return send(res, r.ok ? 200 : 502, {
        success: r.ok,
        configured: true,
        ...(typeof data === 'object' && data ? data : {}),
      });
    } catch (e) {
      return send(res, 502, { success: false, error: String(e?.message || e) });
    }
  }

  // 成片取回：代理转发到网关 /view/{index}，再由网关转发到对应 ComfyUI 实例。
  // 关键：让前端 <img src={output.url}> 能经 /api/comfyui/view 拿到图
  // （生成成片时网关侧需把 GATEWAY_PUBLIC_URL 指向本代理的 /api/comfyui 基址）。
  if (req.method === 'GET' && /^\/api\/comfyui\/view\/.+/.test(pathname)) {
    const gateway = getComfyuiGatewayUrl();
    if (!gateway) {
      return send(res, 503, { success: false, error: 'comfyui-gateway-not-configured' });
    }
    const idx = pathname.slice('/api/comfyui/view/'.length);
    const qs = url.search;
    try {
      const headers = {};
      const gwKey = String(process.env.HMDAO_COMFYUI_GATEWAY_KEY || '').trim();
      if (gwKey) headers['x-hmdao-gateway-key'] = gwKey;
      const r = await fetch(`${gateway}/view/${idx}${qs}`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(60000),
      });
      if (!r.ok) {
        return send(res, r.status || 502, { success: false, error: 'comfy-view-failed', status: r.status });
      }
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, {
        'Content-Type': r.headers.get('content-type') || 'application/octet-stream',
        'Cache-Control': 'public, max-age=3600',
        'Content-Length': buf.length,
      });
      return res.end(buf);
    } catch (e) {
      return send(res, 502, { success: false, error: String(e?.message || e) });
    }
  }

  // /api/comfyui/restart —— 重启本机 ComfyUI
  if (req.method === 'POST' && pathname === '/api/comfyui/restart') {
    const gw = getComfyuiGatewayUrl();
    if (!gw) return send(res, 503, { success: false, error: 'gateway-unavailable' });
    try {
      const r = await fetch(`${gw}/restart`, {
        method: 'POST',
        headers: { 'x-hmdao-gateway-key': String(process.env.HMDAO_COMFYUI_GATEWAY_KEY || '') },
      });
      const j = await r.json().catch(() => ({}));
      return send(res, r.status, j);
    } catch (e) {
      return send(res, 502, { success: false, error: String(e?.message || e) });
    }
  }

  // /api/comfyui/checkpoint —— 将模型 URL 直接落盘到 ComfyUI models/<subdir>
  if (req.method === 'POST' && pathname === '/api/comfyui/checkpoint') {
    const gw = getComfyuiGatewayUrl();
    if (!gw) return send(res, 503, { success: false, error: 'gateway-unavailable' });
    try {
      const ckptBody = await readComfyUiJsonBody(req);
      const r = await fetch(`${gw}/checkpoint`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-hmdao-gateway-key': String(process.env.HMDAO_COMFYUI_GATEWAY_KEY || ''),
        },
        body: JSON.stringify(ckptBody || {}),
      });
      const j = await r.json().catch(() => ({}));
      return send(res, r.status, j);
    } catch (e) {
      return send(res, 502, { success: false, error: String(e?.message || e) });
    }
  }

  // /api/comfyui/start —— 启动本机 ComfyUI（若已运行则直接返回 running）
  if (req.method === 'POST' && pathname === '/api/comfyui/start') {
    const gw = getComfyuiGatewayUrl();
    if (!gw) return send(res, 503, { success: false, error: 'gateway-unavailable' });
    try {
      const probe = await fetch(`${gw}/system_stats`, { method: 'GET' }).catch(() => null);
      if (probe && probe.ok) {
        return send(res, 200, { success: true, running: true, alreadyRunning: true });
      }
      const comfyDir = await detectComfyuiInstallDir();
      if (!comfyDir) {
        return send(res, 200, {
          success: false,
          running: false,
          needsInstall: true,
          installUrl: 'https://github.com/comfyanonymous/ComfyUI',
          managerUrl: 'https://github.com/ltdrdata/ComfyUI-Manager',
          hint: '未检测到 ComfyUI 安装目录。请先 clone 并安装 ComfyUI，或通过环境变量 COMFYUI_PATH 指定其根目录（含 main.py）。',
        });
      }
      const child = spawn(process.platform === 'win32' ? 'python' : 'python3', ['-u', 'main.py', '--listen', '127.0.0.1', '--port', '8188'], {
        cwd: comfyDir,
        detached: true,
        stdio: 'ignore',
        env: process.env,
      });
      child.on('error', (err) => {
        console.error('[api] ComfyUI spawn error', err?.message || err);
      });
      child.unref();
      return send(res, 200, { success: true, running: false, launched: true, dir: comfyDir });
    } catch (e) {
      return send(res, 502, { success: false, error: String(e?.message || e) });
    }
  }

  // /api/comfyui/install-manager —— 把 ComfyUI-Manager 克隆进「正在运行的」ComfyUI 的
  // custom_nodes（未安装时网页里看不到 Manager 按钮）。优先走网关（网关能反查出真实实例目录），
  // 网关不可达时回退到自带 ComfyUI。
  if (req.method === 'POST' && pathname === '/api/comfyui/install-manager') {
    const gateway = getComfyuiGatewayUrl();
    if (gateway) {
      try {
        const gwKey = String(process.env.HMDAO_COMFYUI_GATEWAY_KEY || '').trim();
        const headers = gwKey ? { 'x-hmdao-gateway-key': gwKey } : {};
        const r = await fetch(`${gateway}/install-manager`, { method: 'POST', headers });
        return send(res, r.ok ? 200 : 502, await r.json().catch(() => ({ success: false, error: 'bad-response' })));
      } catch {
        // 网关不可达：回退到本地克隆（指向自带 ComfyUI）
      }
    }
    const comfyDir = await detectComfyuiInstallDir();
    if (!comfyDir) {
      return send(res, 200, {
        success: false,
        needsInstall: true,
        installUrl: 'https://github.com/comfyanonymous/ComfyUI',
        managerUrl: 'https://github.com/ltdrdata/ComfyUI-Manager',
        hint: '未检测到 ComfyUI 安装目录，无法自动安装 Manager。请先安装 ComfyUI，或设置环境变量 COMFYUI_PATH 指向其根目录。',
      });
    }
    try {
      const r = await cloneComfyUiManager(comfyDir);
      return send(res, 200, r);
    } catch (e) {
      return send(res, 502, { success: false, error: String(e?.message || e) });
    }
  }

  return send(res, 404, { success: false, error: 'comfyui-route-not-found', path: pathname });
}

// 将 ComfyUI-Manager 克隆到 <comfyDir>/custom_nodes/ComfyUI-Manager
async function cloneComfyUiManager(comfyDir) {
  const customNodes = path.join(comfyDir, 'custom_nodes');
  const target = path.join(customNodes, 'ComfyUI-Manager');
  try {
    await fs.mkdir(customNodes, { recursive: true });
  } catch {}
  if (existsSync(target)) {
    return { success: true, alreadyInstalled: true, path: target, hint: 'ComfyUI-Manager 已存在，重启 ComfyUI 后网页顶部菜单即出现 Manager 按钮。' };
  }
  const gitAvailable = await new Promise((resolve) => {
    const p = spawn(process.platform === 'win32' ? 'where' : 'which', ['git']);
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
  if (!gitAvailable) {
    return {
      success: false,
      noGit: true,
      manualSteps: [
        `cd "${customNodes}"`,
        'git clone https://github.com/ltdrdata/ComfyUI-Manager.git',
        '重启 ComfyUI，网页顶部菜单即出现 Manager 按钮',
      ],
      manualUrl: 'https://github.com/ltdrdata/ComfyUI-Manager',
      hint: '未检测到 git 命令，请手动执行上述命令安装 ComfyUI-Manager。',
    };
  }
  return new Promise((resolve) => {
    const p = spawn('git', ['clone', 'https://github.com/ltdrdata/ComfyUI-Manager.git', target], {
      cwd: customNodes,
      env: process.env,
    });
    let stderr = '';
    p.stderr?.on('data', (d) => (stderr += String(d)));
    p.on('error', (err) => resolve({ success: false, error: String(err?.message || err), manualUrl: 'https://github.com/ltdrdata/ComfyUI-Manager' }));
    p.on('close', (code) => {
      if (code === 0) {
        resolve({
          success: true,
          cloned: true,
          path: target,
          hint: 'ComfyUI-Manager 已克隆。请重启 ComfyUI（本面板点「重启 ComfyUI」），重启后网页顶部菜单即出现 Manager 按钮。',
        });
      } else {
        resolve({ success: false, error: `git clone 失败(${code}): ${stderr.slice(0, 300)}`, manualUrl: 'https://github.com/ltdrdata/ComfyUI-Manager' });
      }
    });
  });
}

// 探测本机 ComfyUI 安装目录（含 main.py）。可经环境变量 COMFYUI_PATH 指定。
async function detectComfyuiInstallDir() {
  const candidates = [];
  if (process.env.COMFYUI_PATH) candidates.push(process.env.COMFYUI_PATH);
  candidates.push(path.resolve(APP_DIR, 'comfyui'));
  candidates.push(path.resolve(APP_DIR, '..', 'comfyui'));
  candidates.push(path.resolve(APP_DIR, 'ComfyUI'));
  candidates.push(path.resolve(APP_DIR, '..', 'ComfyUI'));
  // 项目自带的 ComfyUI（comfy-gateway 目录下），启动/安装 Manager 时应优先命中它
  candidates.push(path.resolve(APP_DIR, '..', 'comfy-gateway', 'ComfyUI'));
  const home = process.env.USERPROFILE || process.env.HOME;
  if (home) {
    candidates.push(path.join(home, 'ComfyUI'));
    candidates.push(path.join(home, 'Documents', 'ComfyUI'));
  }
  for (const c of candidates) {
    try {
      if (existsSync(path.join(c, 'main.py'))) return c;
    } catch {}
  }
  return null;
}

// 定时清理 ComfyUI 临时素材（落实"临时文件定时自动清理磁盘缓存"）
setInterval(() => {
  try {
    if (!existsSync(COMFYUI_TEMP_DIR)) return;
    const now = Date.now();
    for (const f of readdirSync(COMFYUI_TEMP_DIR)) {
      const fp = path.join(COMFYUI_TEMP_DIR, f);
      try {
        const st = statSync(fp);
        if (now - st.mtimeMs > COMFYUI_TEMP_TTL_MS) fs.unlink(fp).catch(() => {});
      } catch {}
    }
  } catch {}
}, 5 * 60 * 1000);

/**
 * 网络资产采集预览图代理（handleCuratorPreviewProxy）
 * ---------------------------------------------------
 * 背景：花瓣/Pixabay/Pexels/ArtStation 等外网缩略图绝大多数开启防盗链
 *       （校验 Referer/UA），浏览器直接 <img src=...> 会返回 403 或 fail to fetch，
 *       故前端看到一排"占位文字"。
 * 方案：前端把远端 URL 包成 /api/curator/preview-proxy?url=...，由服务端 fetch
 *       并按 host 注入合理 Referer/UA，再流式回写到前端。同一域名同 8792，
 *       不存在跨域问题。同时阻挡 SSRF（不允许内网）。
 */
  return {
    getComfyuiGatewayUrl,
    readComfyUiJsonBody,
    handleComfyUiUpload,
    handleComfyUiApi,
    cloneComfyUiManager,
    detectComfyuiInstallDir,
  };
}
