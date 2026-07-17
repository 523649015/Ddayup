import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
  cacheDir: path.resolve(__dirname, '.vite-cache-root-diagnostic'),
  optimizeDeps: {
    noDiscovery: true,
    include: [],
  },
  server: {
    host: '127.0.0.1',
    port: 3032,
    strictPort: true,
    watch: {
      ignored: [
        '**/.hmdao-data/**',
        '**/.vite-cache/**',
        '**/.vite-cache-root-diagnostic/**',
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
