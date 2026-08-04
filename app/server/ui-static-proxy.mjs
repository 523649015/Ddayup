import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { createReadStream, existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = path.join(APP_DIR, 'dist');

function readCliFlag(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

const appPort = Number(process.env.HMDAO_APP_PORT || readCliFlag('--port', '3000') || 3000);
const apiTarget = new URL(process.env.HMDAO_API_TARGET || process.env.HMDAO_API_URL || readCliFlag('--api', 'http://127.0.0.1:8792'));
const apiProtocol = apiTarget.protocol === 'https:' ? https : http;

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wav': 'audio/wav',
  '.wasm': 'application/wasm',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// 跨域隔离响应头：启用 SharedArrayBuffer，这是 onnxruntime-web 的 WebGPU / 多线程 wasm
// 后端创建会话的硬性前提（否则会抛 "failed to allocate a buffer" 的 SAB 分配失败）。
// 使用 credentialless 而非 require-corp：由 Chrome/Edge 支持，可在不阻断无 CORS 的
// 外部子资源（图片、CDN 权重等）的前提下仍使 crossOriginIsolated === true。
const CROSS_ORIGIN_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

function safeSocketClose(socket) {
  if (!socket || socket.destroyed) return;
  try {
    socket.destroy();
  } catch {
    // noop
  }
}

function sendJson(res, statusCode, body) {
  if (res.destroyed) return;
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function resolveStaticFile(urlPathname) {
  const normalized = decodeURIComponent(String(urlPathname || '/').split('?')[0]).replace(/\\/g, '/');
  const requested = normalized === '/' ? '/index.html' : normalized;
  const candidatePath = path.normalize(path.join(DIST_DIR, requested));
  if (!candidatePath.startsWith(DIST_DIR)) {
    return null;
  }
  return candidatePath;
}

async function serveStatic(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  let targetPath = resolveStaticFile(url.pathname);
  let fallbackToIndex = false;

  if (!targetPath || !existsSync(targetPath)) {
    targetPath = path.join(DIST_DIR, 'index.html');
    fallbackToIndex = true;
  }

  try {
    const stat = await fs.stat(targetPath);
    if (!stat.isFile()) {
      sendJson(res, 404, { success: false, error: 'Not found' });
      return;
    }
    const extension = path.extname(targetPath).toLowerCase();
    const contentTypes = { ...MIME_TYPES, '.wasm': 'application/wasm' }; // 强制wasm MIME
    if (extension === '.wasm') console.log('[proxy] serving .wasm:', targetPath, 'fallback=', fallbackToIndex);
    // 关键：wasm 绝不能用 immutable 缓存。历史上曾因 MIME 错误把 404/index.html
    // 以 immutable 缓存一年，导致修正后浏览器（含 Edge 硬刷新）仍用毒缓存、WebAssembly
    // compileStreaming 报 "Incorrect response MIME type"。改为 no-cache，每次都重新校验。
    const cacheControl =
      // wasm 与 html 入口绝不能 immutable：
      //  - wasm：历史上 MIME 出错会把 404/index.html 以 immutable 缓存一年，导致修正后
      //    浏览器（含 Edge 硬刷新）仍用毒缓存、WebAssembly compileStreaming 报 MIME 错误。
      //  - html 入口（index.html）是非哈希文件名，必须每次重新校验，否则旧入口会持续引用
      //    旧的 JS chunk、进而命中旧的 /ort-wasm/ 毒缓存。
      // 哈希化的 .js/.css 等仍用 immutable（内容寻址，安全）。
      extension === '.wasm' || extension === '.html'
        ? 'no-cache'
        : fallbackToIndex
          ? 'no-cache'
          : 'public, max-age=31536000, immutable';
    // wasm/mjs 在跨域隔离（COOP/COEP）下会被 ComfyUI/ORT 以 Worker 方式加载，
    // 需允许同源嵌入，否则 Worker 脚本拉取被 COEP 拦截导致 wasm 初始化失败。
    const corHeaders =
      extension === '.wasm' || extension === '.mjs'
        ? { 'Cross-Origin-Resource-Policy': 'same-origin' }
        : {};
    res.writeHead(200, {
      'Content-Type': contentTypes[extension] || 'application/octet-stream',
      'Cache-Control': cacheControl,
      'Content-Length': stat.size,
      ...CROSS_ORIGIN_HEADERS,
      ...corHeaders,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(targetPath);
    stream.on('error', (error) => {
      if (!res.headersSent) {
        sendJson(res, 500, {
          success: false,
          error: 'static-stream-failed',
          detail: error instanceof Error ? error.message : String(error),
          targetPath,
        });
        return;
      }
      safeSocketClose(res.socket);
    });
    res.on('close', () => {
      stream.destroy();
    });
    stream.pipe(res);
  } catch (error) {
    sendJson(res, 500, {
      success: false,
      error: 'static-serve-failed',
      detail: error instanceof Error ? error.message : String(error),
      targetPath,
    });
  }
}

function proxyHttp(req, res) {
  const upstreamPath = req.url || '/';
  const proxyReq = apiProtocol.request({
    protocol: apiTarget.protocol,
    hostname: apiTarget.hostname,
    port: apiTarget.port,
    method: req.method,
    path: upstreamPath,
    headers: {
      ...req.headers,
      host: apiTarget.host,
    },
  }, (proxyRes) => {
    proxyRes.on('error', () => {
      safeSocketClose(res.socket);
    });
    res.writeHead(proxyRes.statusCode || 502, { ...proxyRes.headers, ...CROSS_ORIGIN_HEADERS });
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (error) => {
    sendJson(res, 502, {
      success: false,
      error: 'api-proxy-failed',
      detail: error instanceof Error ? error.message : String(error),
      path: upstreamPath,
    });
  });

  req.on('aborted', () => {
    proxyReq.destroy();
  });
  req.on('error', () => {
    proxyReq.destroy();
  });
  res.on('close', () => {
    if (!res.writableEnded) {
      proxyReq.destroy();
    }
  });
  req.pipe(proxyReq);
}

function proxyUpgrade(req, socket, head) {
  const port = Number(apiTarget.port || (apiTarget.protocol === 'https:' ? 443 : 80));
  socket.on('error', () => {
    safeSocketClose(socket);
  });
  const upstreamSocket = net.connect(port, apiTarget.hostname, () => {
    const requestLine = `${req.method || 'GET'} ${req.url || '/'} HTTP/${req.httpVersion}\r\n`;
    const headers = Object.entries(req.headers)
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value ?? ''}\r\n`)
      .join('');
    upstreamSocket.write(`${requestLine}${headers}\r\n`);
    if (head?.length) {
      upstreamSocket.write(head);
    }
    socket.pipe(upstreamSocket);
    upstreamSocket.pipe(socket);
  });

  upstreamSocket.on('error', () => {
    safeSocketClose(upstreamSocket);
    safeSocketClose(socket);
  });

  upstreamSocket.on('close', () => {
    safeSocketClose(socket);
  });

  socket.on('close', () => {
    safeSocketClose(upstreamSocket);
  });
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    sendJson(res, 400, { success: false, error: 'missing-url' });
    return;
  }

  if (req.url.startsWith('/api/') || req.url.startsWith('/ws/')) {
    proxyHttp(req, res);
    return;
  }
  if (req.url.endsWith('.wasm')) console.log('[proxy] wasm:', req.url);
  await serveStatic(req, res);
});

server.on('upgrade', (req, socket, head) => {
  if ((req.url || '').startsWith('/ws/')) {
    proxyUpgrade(req, socket, head);
    return;
  }
  socket.destroy();
});

server.on('clientError', (_error, socket) => {
  if (socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  safeSocketClose(socket);
});

server.on('error', (error) => {
  console.error('[ui-static-proxy] server error', error);
});

server.listen(appPort, '127.0.0.1', () => {
  console.log(`[ui-static-proxy] serving ${DIST_DIR} on http://127.0.0.1:${appPort}`);
  console.log(`[ui-static-proxy] proxying /api and /ws to ${apiTarget.origin}`);
});
