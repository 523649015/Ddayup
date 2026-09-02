// Ddayup 网页素材采集扩展 · 原生主机客户端（方案 A）
// 边界：仅在用户主动触发 yt-dlp 下载 / 状态查询时使用。
// 原生主机不可用、或连接失败、或返回错误时，调用方必须静默降级到浏览器 fetch 路径，
// 绝不影响扩展既有采集能力。本文件不直接读取/拦截任何页面媒体。

import { NATIVE_HOST_NAME } from './config.js';

let port = null;
let seq = 0;
const pending = new Map();
let available = null; // null=未知, true=已连, false=不可用

function connect() {
  if (port) return port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  } catch {
    available = false;
    port = null;
    return null;
  }
  port.onMessage.addListener((msg) => {
    if (msg && msg.type === 'host.ready') {
      available = true;
      return;
    }
    const id = msg && msg.id;
    if (id && pending.has(id)) {
      const { resolve } = pending.get(id);
      pending.delete(id);
      resolve(msg);
    }
  });
  port.onDisconnect.addListener(() => {
    const lastErr = chrome.runtime.lastError;
    port = null;
    available = false;
    // 拒绝所有挂起请求，交由调用方降级
    for (const [, { reject }] of pending) reject(lastErr || new Error('native disconnected'));
    pending.clear();
  });
  return port;
}

function rpc(type, payload = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const p = connect();
    if (!p) { available = false; return reject(new Error('native_unavailable')); }
    const id = ++seq;
    const timer = setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error('native_timeout')); }
    }, timeoutMs);
    pending.set(id, {
      resolve: (m) => { clearTimeout(timer); resolve(m); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    try {
      p.postMessage({ id, type, ...payload });
    } catch (e) {
      clearTimeout(timer); pending.delete(id); reject(e);
    }
  });
}

// 查询本机 yt-dlp 状态（不触发安装）
export async function getYtDlpStatus() {
  try {
    const r = await rpc('ytdlp.status', {}, 8000);
    return r;
  } catch {
    return { ok: true, installed: false, nativeUnavailable: true };
  }
}

// 查询 Ddayup Web 后端（3000/8792）是否已启动
export async function getBackendStatus() {
  try {
    return await rpc('backend.status', {}, 6000);
  } catch (e) {
    return { ok: false, nativeUnavailable: true, error: String(e && e.message || e) };
  }
}

// 启动 Ddayup Web 后端（API + UI 代理）
export async function startBackend() {
  try {
    return await rpc('backend.start', {}, 60000);
  } catch (e) {
    return { ok: false, nativeUnavailable: true, error: String(e && e.message || e) };
  }
}

// 确保后端在运行：先检查，未运行则启动，并轮询等待就绪
export async function ensureBackendRunning(options = {}) {
  const { pollInterval = 800, pollMax = 30, onStatus } = options;
  let status = await getBackendStatus();
  onStatus?.(status);
  if (status.ok) return { ok: true, status };

  // 尝试启动
  const startRes = await startBackend();
  if (!startRes.ok) return { ok: false, start: startRes, status };

  // 轮询等待健康
  for (let i = 0; i < pollMax; i += 1) {
    await new Promise((r) => setTimeout(r, pollInterval));
    status = await getBackendStatus();
    onStatus?.(status);
    if (status.ok) return { ok: true, status, start: startRes };
  }
  return { ok: false, status, start: startRes, error: '后端启动后健康检查超时' };
}

// 确保 yt-dlp 已安装（首次会从 GitHub latest 拉取）
export async function ensureYtDlp() {
  try {
    return await rpc('ytdlp.ensure', {}, 60000);
  } catch {
    return { ok: false, nativeUnavailable: true };
  }
}

// 经原生 yt-dlp 下载（调用方应准备好浏览器 fetch 降级）
export async function downloadViaYtDlp(url, outDir) {
  return rpc('ytdlp.download', { url, outDir }, 120000);
}

export function isNativeAvailable() { return available; }
