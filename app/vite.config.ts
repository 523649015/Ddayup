import path from 'path';
import fs from 'fs';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

function securityHeadersPlugin(): Plugin {
  return {
    name: 'hmdao-security-headers',
    configureServer(server) {
      // 全量请求记录器：记录浏览器/Worker 对本 dev 服务器的每一个请求，
      // 用于定位 ORT 实际请求的 wasm URL（是否走了 /ort-wasm/ 还是 CDN）。
      server.middlewares.use((req, _res, next) => {
        try {
          const ua = req.headers['user-agent'] || '';
          const isWorker = /Worker|Worklet/i.test(ua);
          fs.appendFileSync(
            path.resolve(__dirname, 'tmp_all_req.log'),
            `${new Date().toISOString()} [${isWorker ? 'WORKER' : 'MAIN'}] ${req.method} ${req.url}\n`,
          );
        } catch {
          /* noop */
        }
        next();
      });

      server.middlewares.use('/api/diag', (req, res) => {
        if (req.method === 'POST') {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            fs.appendFileSync(
              path.resolve(__dirname, 'tmp_diag.log'),
              `${new Date().toISOString()} DIAG ${body}\n`,
            );
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{}');
          });
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
        }
      });

      server.middlewares.use('/api/health', (req, res, next) => {
        // 仅对 GET /api/health 做「优先转发真实后端、后端不可达时回退离线桩」的处理；
        // 其余子路径（doctor / refresh 等 POST）直接放行给 Vite 自带的 /api 代理转发到真实后端，
        // 避免在这里重复读取请求体导致异常。否则 dev 模式下 /api/health 永远返回假数据，
        // 导致模型下载面板的本地运行时状态（如 yt-dlp）永远显示「未安装 / 未识别」。
        const originalUrl = req.originalUrl ?? req.url ?? '';
        const isHealthRoot = req.method === 'GET'
          && (originalUrl === '/api/health' || originalUrl.startsWith('/api/health?'));
        if (!isHealthRoot) return next();
        const write = (status: number, body: string) => {
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(body);
        };
        const fallback = () => write(200, JSON.stringify({
          success: true,
          status: 'ok',
          message: 'HMDao API dev fallback. Start npm run dev:full for backend features.',
          capabilities: { dccGateway: false },
          timestamp: Date.now(),
        }));
        const upstream = new URL(originalUrl, apiTarget);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 2000);
        fetch(upstream, { signal: ctrl.signal })
          .then((r) => r.text().then((text) => { clearTimeout(timer); write(r.status, text); }))
          .catch(() => { clearTimeout(timer); fallback(); });
      });

      // =========================================================
      // 关键：ONNX Runtime Web / WASM 模型旁路中间件
      // ------------------------------------------------------------
      // 根因（已确认，2026-07-17 复现）：
      //   onnxruntime-web 1.27.0 的 ort.bundle.min.mjs 在多线程 / 异步路径下会用
      //   `import("ort-wasm-simd-threaded.jsep.mjs")` 这类动态 import 派生 PThread Worker，
      //   浏览器发起对 `/ort-wasm/ort-wasm-simd-threaded.jsep.mjs?import` 的请求。
      //   Vite 7 的 transformMiddleware 抢在 ortWasmBypass 之前进入 transformRequest 流程，
      //   loadAndTransform 报：
      //     "This file is in /public and will be copied as-is during build,
      //      and therefore should not be imported from source code. It can only
      //      be referenced via HTML tags."
      //
      // 修复分三层（缺一不可）：
      //   ① 下方 ortWasmBypass 中间件：运行时 fetch 兜底，绕过 transform pipeline。
      //   ② 顶层 ortWasmResolvePlugin（enforce:'pre' + resolveId + load）：
      //      在 Vite transformRequest 阶段把 `/ort-wasm/...` 解析为 public 目录
      //      实际文件并返回内容，让 transform 流程拿到合法源代码。
      //   ③ translateCore.ts 强制 env.backends.onnx.wasm.numThreads=1：
      //      让 NLLB 走单线程路径（ort-wasm-simd-threaded.mjs，不带 jsep 后缀），
      //      避免动态 import jsep.mjs，从源头消除该 URL 请求。
      // =========================================================
      const ortWasmBypass = (req: { url?: string }, res: { setHeader: (k: string, v: string) => void; end: (b: Buffer) => void }, next: () => void) => {
        if (!req.url) return next();
        const rawUrl = req.url;
        // ?import 是 Vite 模块图内部用来解析 wasm URL 的请求（resolveId 已返回
        // `export default "/ort-wasm/..."` 形式的 JS 模块）。运行时 fetch 用的是干净
        // 无 query 的 URL，不会带 ?import。所以这里必须让 ?import 透传给 Vite，
        // 否则会破坏 new URL(...) 的模块导入。
        if (/\?[^&]*\bimport\b/.test(rawUrl)) return next();
        const url = rawUrl.split('?')[0];
        // 同时识别两种形式：
        //   /ort-wasm/...                      （浏览器里 import.meta.url / locateFile 解析出的干净路径）
        //   /@fs/<root>/public/ort-wasm/...     （Vite 把 resolveId 返回的 fs 绝对路径当模块 URL 时用的形式）
        let filePath: string | null = null;
        const ortMatch = url.match(/\/ort-wasm(?:-v1)?\/.+\.(mjs|wasm)$/i);
        if (ortMatch) {
          filePath = path.join(__dirname, 'public', ortMatch[0]);
        } else {
          const fsMatch = url.match(/\/public\/ort-wasm(?:-v1)?\/.+\.(mjs|wasm)$/i);
          if (fsMatch) {
            filePath = path.join(__dirname, 'public', fsMatch[0].replace(/^\/public/, ''));
          }
        }
        if (!filePath) return next();
        try {
          const buf = fs.readFileSync(filePath);
          const ext = path.extname(url).toLowerCase();
          // 关键：.wasm 强制 application/wasm 并返回真实二进制；.mjs 当 ESM 处理。
          const ct = ext === '.wasm' ? 'application/wasm' : 'application/javascript';
          fs.appendFileSync(
            path.resolve(__dirname, 'tmp_wasm_req.log'),
            `${new Date().toISOString()} ${(req as { method?: string }).method} ${rawUrl} -> ${ct} (${buf.length} bytes)\n`,
          );
          res.setHeader('Content-Type', ct);
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(buf);
          return;
        } catch {
          fs.appendFileSync(
            path.resolve(__dirname, 'tmp_wasm_req.log'),
            `${new Date().toISOString()} ${(req as { method?: string }).method} ${rawUrl} -> FILE NOT FOUND (${filePath})\n`,
          );
          // 文件不存在：直接返回 404（不要透传给 SPA 回退成 text/html，
          // 否则浏览器拿到 HTML 会报 "Incorrect response MIME type" 且 wasm 初始化失败）。
          (res as { statusCode?: number }).statusCode = 404;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end(Buffer.from(`ort-wasm asset not found: ${url}`));
          return;
        }
      };

      // 必须放在 Vite 的 transform 之前（enforce: 'pre'，configureServer 中早于默认中间件）
      server.middlewares.use(ortWasmBypass);

      // 兜底：对未被上面捕获的 .wasm 仍强制 application/wasm（兼容其他来源）。
      // 注意跳过 ?import：那是 Vite 模块图内部用来解析 wasm URL 的请求，
      // 必须由 ortWasmResolvePlugin 的 load 钩子返回 `export default "/ort-wasm/..."` 形式。
      server.middlewares.use((req, res, next) => {
        if (req.url && /\.wasm/i.test(req.url) && !/\?[^&]*\bimport\b/.test(req.url)) {
          res.setHeader('Content-Type', 'application/wasm');
        }
        next();
      });

      // 注意：此处【不】设置 Cross-Origin-Embedder-Policy / COOP。
      // 本项目本地推理用 numThreads=1（见 translateCore.ts / ortEnv.ts），不需要
      // SharedArrayBuffer / 跨域隔离；而 require-corp 会让所有跨域子资源（图片、
      // CDN 脚本等）必须有 CORP/CORS 头，反而可能阻断正常加载。该安全头此前是死代码
      // （未加入 plugins 数组），现启用旁路中间件时保持与线上一致行为。
    },
  };
}

const apiTarget = process.env.HMDAO_API_TARGET || 'http://127.0.0.1:8792';
const wsTarget = apiTarget.replace(/^http/i, 'ws');

/**
 * 在 Vite transformRequest 阶段处理 `/ort-wasm/...` 引用：
 *   1. `resolveId` 把以 `/ort-wasm/` 开头的 id（带 `?import` / `?worker` / `?url` 等
 *      query 也兼容，去掉 query 再匹配）解析为 public 目录下的绝对文件路径。
 *   2. `load` 钩子读取该文件内容（.mjs 当 JS 文本返回，.wasm 当二进制 buffer 返回）。
 *
 * 用 `enforce: 'pre'` 确保先于 vite 自带的 vite:asset-import-meta-url / 公共文件检查
 * 执行，从源头避免"This file is in /public ... should not be imported"错误。
 *
 * 注意：仅 `apply: 'serve'` —— 生产 build 时 public 目录会被原样拷贝到 dist，
 * 不再需要这个 plugin。
 */
/**
 * 在 Vite transformRequest 阶段处理 `/ort-wasm/...` 引用。
 *
 * 背景（关键修复，2026-07-17）：
 *   onnxruntime-web 1.27.0 的 `ort-wasm-simd-threaded.jsep.mjs` 内部用
 *   `new URL("ort-wasm-simd-threaded.jsep.wasm", import.meta.url)` 计算 wasm 路径。
 *   Vite 的 assetImportMetaUrlPlugin 在转换该表达式时，会把 `/@fs/.../public/ort-wasm/x.wasm`
 *   作为模块依赖登记进图的 `?import` 请求。如果本插件不识别该 `/@fs/` 形式的 id，
 *   Vite 会交给内置的 wasmFallbackPlugin，后者对非 `?init`/`?url` 的 `.wasm` 直接抛
 *   "ESM integration proposal for Wasm is not supported" → 整个 jsep.mjs 模块加载失败 →
 *   wasm 后端初始化失败 → `Cannot read properties of undefined (reading 'registerBackend')`。
 *
 * 因此本插件必须同时识别两种 id 形式：
 *   - `/ort-wasm/...`（浏览器里 import.meta.url 解析出的干净路径）
 *   - `/@fs/.../public/ort-wasm/...`（Vite 把本插件 resolveId 返回的 fs 绝对路径
 *     当作模块 URL 时使用的 `/@fs/` 形式）
 * 两者都归一化为 `public/ort-wasm/...` 下的相对路径后再读文件。
 *
 *   - `.mjs`：返回 utf-8 源码，当 ESM 模块处理。
 *   - `.wasm`：返回 `export default "<ortRel>"`（ortRel 为干净的 /ort-wasm/... 路径）。
 *     该模块只存在于 Vite 模块图（new URL 改写产生的 `?import` 依赖），运行时并不会
 *     import 它；真正的二进制由运行时 `fetch(import.meta.url 解析出的 /ort-wasm/ 或 /@fs/ 路径)`
 *     拉取（已由 ortWasmBypass 中间件 / Vite /@fs 处理程序以 application/wasm 返回）。
 */
function ortWasmResolvePlugin(): Plugin {
  const publicDir = path.resolve(__dirname, 'public');
  // 从任意 id（/ort-wasm/... 或 /@fs/.../public/ort-wasm/...）提取出 /ort-wasm/... 相对路径
  const toOrtRel = (id: string): string | null => {
    const clean = id.split('?')[0].split('#')[0];
    if (!/\.(mjs|wasm)$/i.test(clean)) return null;
    const m = clean.match(/\/ort-wasm(?:-v1)?\//);
    if (!m) return null;
    return clean.slice(m.index);
  };
  return {
    name: 'hmdao-ort-wasm-resolve',
    enforce: 'pre',
    apply: 'serve',
    resolveId(id) {
      const ortRel = toOrtRel(id);
      if (!ortRel) return null;
      const abs = path.join(publicDir, ortRel);
      if (fs.existsSync(abs)) {
        return { id: abs };
      }
      return null;
    },
    load(id) {
      const ortRel = toOrtRel(id);
      if (!ortRel) return null;
      const abs = path.join(publicDir, ortRel);
      try {
        const buf = fs.readFileSync(abs);
        const ext = path.extname(ortRel).toLowerCase();
        if (ext !== '.wasm') {
          // .mjs 文本：返回 utf-8 源码，让 Vite 当 ESM 模块处理
          return buf.toString('utf-8');
        }
        // .wasm：Vite 模块图里由 new URL(...) 改写产生的 `?import` 依赖。
        // 返回一个合法 ESM 模块，其默认导出是干净的 /ort-wasm/... 路径，
        // 避免 wasmFallbackPlugin 抛错导致 jsep.mjs 整体加载失败。
        return `export default ${JSON.stringify(ortRel)};`;
      } catch {
        return null;
      }
    },
  };
}

export default defineConfig({
  base: '/',
  cacheDir: path.resolve(__dirname, '.vite-cache'),
  // 翻译 Worker 内部使用动态 import（@xenova/transformers）需要代码分割，
  // 因此输出为 ES module worker（IIFE 不支持 code-splitting）。
  worker: {
    format: 'es',
  },
  plugins: [
    // 必须放在 react() 之前：enforce:'pre' 不足以保证调用顺序，需要在 plugins 数组里靠前。
    // 作用：把 /ort-wasm/... 引用解析到 public 目录实际文件，避免 Vite transformRequest
    //   阶段报 "This file is in /public ... should not be imported" 错误。
    ortWasmResolvePlugin(),
    // 启用 ORT wasm 旁路中间件（直接以 application/wasm 提供 /ort-wasm/ 下的二进制，
    // 并记录请求日志到 tmp_wasm_req.log，便于定位浏览器实际请求的 wasm URL）。
    securityHeadersPlugin(),
    react(),
  ],
  optimizeDeps: {
    noDiscovery: true,
    holdUntilCrawlEnd: false,
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'react-router',
      'react-router-dom',
      'cookie',
      // Avoid resolving the full lucide barrel on the first canvas load.
      'lucide-react',
      '@xyflow/react',
      'zustand',
      'zustand/traditional',
      'use-sync-external-store/shim/with-selector',
      'use-sync-external-store/shim/with-selector.js',
      // Transformers.js 本地翻译（浏览器端 ONNX Runtime）
      '@xenova/transformers',
      // 二维码生成（CJS→ESM 预打包，否则浏览器端拿不到具名导出）
      'qrcode',
    ],
    // 关键：onnxruntime-web 在 /public/ort-wasm/ 下用 wasmPaths 加载 WASM
    // Vite 不允许从 /public 目录 import；交给浏览器运行时直接拉取
    exclude: ['onnxruntime-web', '@imgly/background-removal'],
  },
  server: {
    host: '127.0.0.1',
    port: 3000,
    strictPort: true,
    // Keep dev startup responsive by serving source modules on demand instead
    // of eagerly pre-transforming the browser's first concurrent requests.
    preTransformRequests: false,
    watch: {
      ignored: [
        '**/.hmdao-data/**',
        '**/.vite-cache/**',
        '**/artifacts/**',
        '**/dist/**',
        '**/dist-*/**',
        '**/tmp/**',
        '**/tmp-*/**',
      ],
    },
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
      '/ws': {
        target: wsTarget,
        ws: true,
        changeOrigin: true,
      },
    },
  },
  resolve: {
    dedupe: [
      'react',
      'react-dom',
      'zustand',
      'use-sync-external-store',
    ],
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('@xyflow/react')) return 'vendor-flow';
          if (id.includes('react-router')) return 'vendor-router';
          if (id.includes('zustand')) return 'vendor-state';
          if (id.includes('zod')) return 'vendor-zod';
          if (id.includes('react-hook-form') || id.includes('@hookform/resolvers')) return 'vendor-forms';
          if (id.includes('pdf-lib')) return 'vendor-pdf';
          if (id.includes('three') || id.includes('@react-three')) return 'vendor-3d';
          if (id.includes('@radix-ui')) return 'vendor-radix';
          if (id.includes('lucide-react')) return 'vendor-icons';
          if (id.includes('recharts')) return 'vendor-charts';
          if (id.includes('@xenova/transformers') || id.includes('onnxruntime')) return undefined; // 动态导入，由 Vite 自动分片
          if (id.includes('@ffmpeg') || id.includes('fflate')) return 'vendor-media';
          if (id.includes('yjs') || id.includes('y-protocols')) return 'vendor-collab';
          return 'vendor-misc';
        },
      },
    },
  },
});
