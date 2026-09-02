#!/usr/bin/env node
// Ddayup 原生主机（方案 A · Native Messaging）
// 职责：与 Edge/Chrome 扩展通过 stdio 通信，管理本机 yt-dlp 生命周期并执行下载。
// 边界：本程序只处理扩展发来的 ytdlp.* 消息，绝不拦截浏览器导航/媒体/任何页面内容。
// 部署：需由安装器写入 NativeMessagingHosts 注册表/manifest，指向本文件（或打包后的 exe）。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const HOST_NAME = 'com.ddayup.host';
const YTDLP_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), '.config'),
  'Ddayup', 'local-post-runtimes', 'ytdlp', 'current'
);
const YTDLP_EXE = path.join(YTDLP_DIR, 'yt-dlp.exe');
const FFMPEG_EXE = path.join(YTDLP_DIR, 'ffmpeg.exe');
const NODE_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), '.config'),
  'Ddayup', 'local-post-runtimes', 'node', 'current'
);
const NODE_EXE = path.join(NODE_DIR, 'node.exe');

// ---------- Ddayup Web 后端路径 ----------
// 仓库根 = extension/native-host 的祖父目录（即 f:/Work/HMDAODAO）。
// ★ 关键坑：pkg 打包后 __dirname 是虚拟路径（如 C:\snapshot\...），不能用它推导真实仓库位置。
// 但 process.execPath 在 pkg 下始终是【真实 exe 绝对路径】，故优先用它（exe 位于 extension/native-host/）。
// 也允许通过环境变量 DDAYUP_REPO_ROOT 强制覆盖（安装器或用户可设）。
function resolveRepoRoot() {
  // 优先级 0：运行时环境变量（安装器/用户可覆盖，最高优先）
  if (process.env.DDAYUP_REPO_ROOT && fs.existsSync(process.env.DDAYUP_REPO_ROOT)) {
    return path.resolve(process.env.DDAYUP_REPO_ROOT);
  }
  // 优先级 1：构建时由 build-host-exe.ps1 注入的真实仓库根（pkg 下 __dirname/process.execPath
  // 均为虚拟路径 C:\snapshot\...，无法反推真实位置，故必须构建期固化）。未注入时保留占位符。
  const BUILT_REPO_ROOT = '{{REPO_ROOT}}';
  if (BUILT_REPO_ROOT && BUILT_REPO_ROOT !== '{{REPO_ROOT_MARKER}}' && fs.existsSync(BUILT_REPO_ROOT)) {
    return path.resolve(BUILT_REPO_ROOT);
  }
  // 优先级 2：开发模式（node 直接跑 ddayup-host.js，__dirname 即 extension/native-host）
  const fromDir = path.resolve(__dirname, '..', '..');
  if (fs.existsSync(path.join(fromDir, 'app', 'server', 'hmdao-api.mjs'))) return fromDir;
  // 兜底
  return fromDir;
}
const REPO_ROOT = resolveRepoRoot();
const API_SCRIPT = path.join(REPO_ROOT, 'app', 'server', 'hmdao-api.mjs');
const UI_SCRIPT = path.join(REPO_ROOT, 'app', 'server', 'ui-static-proxy.mjs');
const API_PORT = Number(process.env.HMDAO_API_PORT || 8792);
const APP_PORT = Number(process.env.HMDAO_APP_PORT || 3000);

// 已启动的后端子进程句柄（避免重复启动）
const backendProcs = new Map(); // name -> ChildProcess
// ★2026-08-18 精准修复「点击视频弹 YT-DLP-EXE 黑窗口」：
//   原先下载的是 PyInstaller onefile 版 yt-dlp.exe —— 每次运行先自解压到临时目录，
//   该阶段弹出的黑控制台窗口 Node 的 windowsHide:true 无法抑制（后端 hmdao-api.mjs:6497 注释已说明此坑）。
//   改为下载「onedir」版 yt-dlp_win.zip（与后端托管运行时一致），解压后 yt-dlp.exe 直接运行，
//   不再自解压 → 彻底消除黑窗口。解压后用 YTDLP_EXE / FFMPEG_EXE 指向 onedir 内的同名文件。
// 与后端 local-post-constants 一致的静态兜底直链（GitHub 官方，支持 Range 断点续传）
const YTDLP_LATEST = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_win.zip';
// 多源回退：GitHub 官方优先；国内网不可达时依次尝试 ghproxy 镜像代理（均为 GitHub release 资产前缀代理）。
// 注意：第三方代理可能偶发失效，仅作为回退，绝不替代官方源；任一源成功即止。
const YTDLP_SOURCES = [
  YTDLP_LATEST,
  'https://mirror.ghproxy.com/https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_win.zip',
  'https://ghproxy.net/https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_win.zip',
  'https://ghproxy.com/https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_win.zip',
];

// ---------- Native Messaging 协议（Chrome/Edge 规范：4 字节长度前缀 + JSON） ----------
let buf = Buffer.alloc(0);
function send(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(payload.length, 0);
  if (process.stdout.isTTY) process.stdout.write('\n');
  process.stdout.write(Buffer.concat([len, payload]));
}
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const msgBuf = buf.slice(4, 4 + len);
    buf = buf.slice(4 + len);
    let msg;
    try { msg = JSON.parse(msgBuf.toString('utf8')); } catch { continue; }
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));

// ---------- 消息处理 ----------
function handle(msg) {
  const id = msg.id || null;
  const type = msg.type;
  if (type === 'ping') {
    return send({ id, type: 'pong', ok: true, host: HOST_NAME });
  }
  if (type === 'ytdlp.status') {
    return send({ id, type: 'ytdlp.status', ...probeYtDlp() });
  }
  if (type === 'ytdlp.ensure') {
    ensureYtDlp().then((r) => send({ id, type: 'ytdlp.ensure', ...r }))
      .catch((e) => send({ id, type: 'ytdlp.ensure', ok: false, error: String(e && e.message || e) }));
    return;
  }
  if (type === 'ytdlp.download') {
    return runDownload(msg, id);
  }
  if (type === 'backend.status') {
    return checkBackendStatus().then((status) => send({ id, type: 'backend.status', ...status }));
  }
  if (type === 'backend.start') {
    return startBackend().then((r) => send({ id, type: 'backend.start', ...r }))
      .catch((e) => send({ id, type: 'backend.start', ok: false, error: String(e && e.message || e) }));
  }
  if (type === 'backend.stop') {
    return stopBackend().then((r) => send({ id, type: 'backend.stop', ...r }));
  }
  send({ id, type: 'error', ok: false, error: 'unknown_type:' + type });
}

// ---------- yt-dlp 探测 / 安装 ----------
function probeYtDlp() {
  if (fs.existsSync(YTDLP_EXE)) {
    return { ok: true, installed: true, path: YTDLP_EXE, version: 'present' };
  }
  return { ok: true, installed: false, path: null, version: null };
}

// 带断点续传 + 多源回退的下载。
// - 优先复用已存在的部分文件（.part），向服务端发 Range 请求；支持 206 续传 / 200 重头 / 416 回退。
// - 任一源成功即止；全部失败返回最后一个错误。
async function downloadYtDlpWithResume(targetPath, onProgress) {
  let lastErr = null;
  for (const url of YTDLP_SOURCES) {
    try {
      const partPath = targetPath + '.part';
      let resumeFrom = 0;
      if (fs.existsSync(partPath)) {
        const st = fs.statSync(partPath);
        if (st.size > 0) resumeFrom = st.size;
      }
      const headers = { 'User-Agent': 'Ddayup Native Host' };
      if (resumeFrom > 0) headers['Range'] = `bytes=${resumeFrom}-`;
      const res = await fetch(url, { headers });
      if (res.status === 416) {
        // 范围不满足（部分文件损坏）→ 删掉从头下
        fs.rmSync(partPath, { force: true });
        resumeFrom = 0;
        const res2 = await fetch(url, { headers: { 'User-Agent': 'Ddayup Native Host' } });
        if (!res2.ok) throw new Error(`source ${res2.status}`);
        await pumpToFile(res2, partPath, 0, onProgress);
      } else if (res.status === 206 || (resumeFrom > 0 && res.ok)) {
        await pumpToFile(res, partPath, resumeFrom, onProgress);
      } else if (res.ok) {
        await pumpToFile(res, partPath, 0, onProgress);
      } else {
        throw new Error(`source ${res.status}`);
      }
      fs.renameSync(partPath, targetPath);
      return { ok: true };
    } catch (e) {
      lastErr = e;
      // 尝试下一源（保留 .part 供续传）
    }
  }
  return { ok: false, error: String(lastErr && lastErr.message || lastErr) };
}

// 把响应体边读边写（append 模式续传），按接收字节回调进度
async function pumpToFile(res, filePath, startOffset, onProgress) {
  const file = fs.openSync(filePath, startOffset > 0 && fs.existsSync(filePath) ? 'a' : 'w');
  try {
    const reader = res.body.getReader();
    let received = startOffset;
    const total = startOffset + (Number(res.headers.get('content-length')) || 0);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      fs.writeSync(file, Buffer.from(value));
      onProgress?.({
        receivedBytes: received,
        totalBytes: total || received,
        percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0,
      });
    }
  } finally {
    fs.closeSync(file);
  }
}

async function ensureYtDlp() {
  if (fs.existsSync(YTDLP_EXE)) return { ok: true, installed: true, path: YTDLP_EXE };
  try {
    fs.mkdirSync(YTDLP_DIR, { recursive: true });
    const zipPath = path.join(YTDLP_DIR, 'yt-dlp_win.zip');
    const r = await downloadYtDlpWithResume(zipPath, (p) => {
      // 进度回传（sidepanel 可选消费），不影响终态
      try { send({ type: 'ytdlp.progress', receivedBytes: p.receivedBytes, totalBytes: p.totalBytes, percent: p.percent }); } catch (_) {}
    });
    if (!r.ok) throw new Error(r.error || 'download failed');
    // onedir zip 解压到 YTDLP_DIR（内含 yt-dlp.exe / ffmpeg.exe / _internal 等），覆盖式解压。
    await extractZip(zipPath, YTDLP_DIR);
    fs.rmSync(zipPath, { force: true });
    if (!fs.existsSync(YTDLP_EXE)) throw new Error('yt-dlp.exe not found after extraction');
    return { ok: true, installed: true, path: YTDLP_EXE };
  } catch (e) {
    return { ok: false, installed: false, error: String(e && e.message || e) };
  }
}

// 解压 onedir zip（Windows：用系统 Expand-Archive，无需额外依赖；非 Windows 退回提示）。
async function extractZip(zipPath, destDir) {
  if (process.platform === 'win32') {
    await new Promise((resolve, reject) => {
      const ps = spawn('powershell', ['-NoProfile', '-Command',
        `Expand-Archive -Force -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}'`],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      ps.stderr.on('data', (d) => { err += d.toString(); });
      ps.on('close', (code) => code === 0 ? resolve() : reject(new Error(err || ('Expand-Archive exit ' + code))));
      ps.on('error', (e) => reject(e));
    });
  } else {
    // 非 Windows（开发/其他平台）：提示需手动解压或用 unzip 工具
    throw new Error('非 Windows 平台请手动解压 yt-dlp_win.zip 到 ' + destDir);
  }
}

// ---------- 下载 ----------
function runDownload(msg, id) {
  const url = msg.url;
  const outDir = msg.outDir || os.tmpdir();
  if (!url || !/^https?:\/\//.test(url)) {
    return send({ id, type: 'ytdlp.download', ok: false, error: 'invalid_url' });
  }
  // ★2026-08-24 修复（用户诉求「选分辨率下载」）：支持 msg.formatId（单档格式 ID 如 best/22/bestvideo+bestaudio）
  //   或 msg.format（yt-dlp -S 排序选项，如 "res:1080" / "ext:mp4"）。两者都没传时退到默认 best（兼容旧调用）。
  //   这才是「选分辨率下载抖音」的唯一稳定路径：原 chrome.downloads/Referer 链路对抖音签名 CDN 必 403。
  const formatSpec = msg.formatId || msg.format || 'best';
  const args = ['-f', formatSpec, '--no-playlist', '-o', path.join(outDir, '%(title)s.%(ext)s'), url];
  // 可选：合并音视频为单一 mp4（若用户选的是 bv+ba 分轨）
  if (msg.mergeToMp4) args.splice(3, 0, '--merge-output-format', 'mp4');
  let child;
  try {
    // ★windowsHide: true —— Windows 下不弹出 yt-dlp.exe 的黑控制台窗口（避免干扰用户体验）。
    //   后端 media.mjs 的 yt-dlp 调用已统一带此参数，原生主机这条下载路径此前漏了。
    child = spawn(YTDLP_EXE, args, { cwd: outDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return send({ id, type: 'ytdlp.download', ok: false, error: String(e && e.message || e) });
  }
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); send({ id, type: 'ytdlp.progress', chunk: d.toString() }); });
  child.on('close', (code) => {
    send({ id, type: 'ytdlp.download', ok: code === 0, code, stderr: stderr.slice(-2000) });
  });
  child.on('error', (e) => send({ id, type: 'ytdlp.download', ok: false, error: String(e && e.message || e) }));
}

// ---------- 后端（Ddayup Web App + API）启动/状态 ----------

// 轻量探测端口是否已有服务
function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const net = require('net');
    const s = net.createConnection({ port, host }, () => { s.end(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(1200, () => { s.destroy(); resolve(false); });
  });
}

// 向后端 /api/health 发一次 GET，验证真的可达
async function backendReachable(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch (_) { return false; }
}

async function checkBackendStatus() {
  const apiOpen = await portOpen(API_PORT);
  const appOpen = await portOpen(APP_PORT);
  const apiHealthy = apiOpen ? await backendReachable(API_PORT) : false;
  const appHealthy = appOpen ? await backendReachable(APP_PORT) : false;
  return {
    ok: apiHealthy && appHealthy,
    api: { port: API_PORT, open: apiOpen, healthy: apiHealthy },
    app: { port: APP_PORT, open: appOpen, healthy: appHealthy },
    pids: Object.fromEntries([...backendProcs.entries()].map(([k, v]) => [k, v.pid])),
  };
}

// ---------- Node 可执行文件解析（源码模式 / 系统 Node / 自动下载） ----------
function isNodeLikeExecutable(exePath) {
  return /node(?:\.exe)?$/i.test(path.basename(exePath));
}

function findSystemNode() {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, 'node.exe');
    if (fs.existsSync(candidate)) return candidate;
    const noExt = path.join(dir, 'node');
    if (fs.existsSync(noExt)) return noExt;
  }
  return null;
}

async function downloadNodeExe(targetPath) {
  const version = process.versions.node || '18.20.4';
  const sources = [
    `https://nodejs.org/dist/v${version}/win-x64/node.exe`,
    `https://registry.npmmirror.com/-/binary/node/v${version}/win-x64/node.exe`,
    `https://mirrors.ustc.edu.cn/node/v${version}/win-x64/node.exe`,
  ];
  const partPath = targetPath + '.part';
  let lastErr = null;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const { pipeline } = require('stream/promises');
  const { Readable } = require('stream');
  for (const url of sources) {
    try {
      if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
      const res = await fetch(url, { headers: { 'User-Agent': 'Ddayup Native Host' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(partPath));
      fs.renameSync(partPath, targetPath);
      return targetPath;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`node.exe 下载失败：${lastErr ? lastErr.message : 'unknown'}`);
}

async function resolveNodeExe() {
  // 1. 当前进程本身就是 Node（源码/开发模式）
  if (isNodeLikeExecutable(process.execPath)) return process.execPath;
  // 2. 已缓存的 node.exe
  if (fs.existsSync(NODE_EXE)) return NODE_EXE;
  // 3. 系统 PATH 中的 node
  const sys = findSystemNode();
  if (sys) return sys;
  // 4. 自动下载 node.exe（用户无感，约 80MB）
  return await downloadNodeExe(NODE_EXE);
}

async function startDetachedNode(scriptPath, name, extraEnv = {}) {
  const nodeExe = await resolveNodeExe();
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...extraEnv };
    const child = spawn(nodeExe, [scriptPath], {
      cwd: REPO_ROOT,
      env,
      detached: true,
      windowsHide: true, // Windows 下不闪控制台窗口
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    backendProcs.set(name, child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => reject(e));

    // 等待进程成功 spawn 并端口被监听（最多 20 秒）
    const start = Date.now();
    const port = name === 'api' ? API_PORT : APP_PORT;
    const timer = setInterval(async () => {
      if (await portOpen(port)) {
        clearInterval(timer);
        resolve({ pid: child.pid, port, stdout: stdout.slice(-500), stderr: stderr.slice(-500) });
      } else if (Date.now() - start > 20000) {
        clearInterval(timer);
        // 端口仍未打开，视为启动失败
        try { child.kill(); backendProcs.delete(name); } catch (_) {}
        reject(new Error(`启动 ${name} 超时（20s）。stdout: ${stdout.slice(-500)}; stderr: ${stderr.slice(-500)}`));
      }
    }, 400);
  });
}

async function startBackend() {
  // 若脚本文件不存在（源码未完整部署），直接失败并提示
  if (!fs.existsSync(API_SCRIPT)) throw new Error(`未找到后端脚本：${API_SCRIPT}。请确认 Ddayup 源码已完整部署。`);
  if (!fs.existsSync(UI_SCRIPT)) throw new Error(`未找到后端脚本：${UI_SCRIPT}。请确认 Ddayup 源码已完整部署。`);

  const status = await checkBackendStatus();
  if (status.ok) return { ok: true, already: true, ...status };

  const results = [];
  if (!status.api.healthy) {
    results.push(await startDetachedNode(API_SCRIPT, 'api'));
  }
  // UI 代理依赖 API 先起来，等 API 健康再启 UI
  if (!status.app.healthy) {
    await new Promise((r) => setTimeout(r, 600));
    results.push(await startDetachedNode(UI_SCRIPT, 'app'));
  }

  // 最终确认
  const final = await checkBackendStatus();
  if (!final.ok) throw new Error(`后端进程已启动但健康检查未通过。api=${JSON.stringify(final.api)}, app=${JSON.stringify(final.app)}`);
  return { ok: true, started: results.map((r) => ({ pid: r.pid, port: r.port })), status: final };
}

async function stopBackend() {
  const killed = [];
  for (const [name, child] of backendProcs.entries()) {
    try {
      process.kill(-child.pid, 'SIGTERM');
      killed.push(name);
    } catch (e) {
      killed.push(`${name}: ${String(e && e.message || e)}`);
    }
    backendProcs.delete(name);
  }
  return { ok: true, killed };
}

// ---------- 启动自检 ----------
send({ type: 'host.ready', ok: true, host: HOST_NAME, ytdlp: probeYtDlp() });
