import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: './tmp/vite-smoke',
  optimizeDeps: {
    noDiscovery: true,
    include: [],
  },
  server: {
    host: '127.0.0.1',
    port: 3025,
    strictPort: true,
    fs: {
      strict: true,
      allow: [path.resolve(__dirname, './tmp/vite-smoke')],
    },
    watch: {
      ignored: [
        '**/.hmdao-data/**',
        '**/artifacts/**',
        '**/dist/**',
        '**/dist-*/**',
        '**/tmp/**',
        '**/tmp-*/**',
      ],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
