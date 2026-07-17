import path from 'path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

function securityHeadersPlugin(): Plugin {
  return {
    name: 'hmdao-security-headers',
    configureServer(server) {
      server.middlewares.use('/api/health', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          success: true,
          status: 'ok',
          message: 'HMDao API dev fallback. Start npm run dev:full for backend features.',
          capabilities: {
            dccGateway: false,
          },
          timestamp: Date.now(),
        }));
      });

      server.middlewares.use((_req, res, next) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        res.setHeader(
          'Content-Security-Policy',
          [
            "default-src 'self'",
            "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline' https://cdn.jsdelivr.net",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob: https:",
            "media-src 'self' blob:",
            "connect-src 'self' http://127.0.0.1:* http://localhost:* https: ws: wss:",
            "frame-src 'self' http://127.0.0.1:* http://localhost:*",
            "worker-src 'self' blob:",
            "font-src 'self' data:",
          ].join('; '),
        );
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        next();
      });
    },
  };
}

const apiTarget = process.env.HMDAO_API_TARGET || 'http://127.0.0.1:8792';
const wsTarget = apiTarget.replace(/^http/i, 'ws');

export default defineConfig({
  base: '/',
  cacheDir: path.resolve(__dirname, '.vite-cache'),
  // 翻译 Worker 内部使用动态 import（@xenova/transformers）需要代码分割，
  // 因此输出为 ES module worker（IIFE 不支持 code-splitting）。
  worker: {
    format: 'es',
  },
  plugins: [
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
    ],
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
