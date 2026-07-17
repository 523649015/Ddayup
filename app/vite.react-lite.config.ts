import path from 'path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  cacheDir: path.resolve(__dirname, '.vite-cache-react-lite'),
  plugins: [
    react({
      fastRefresh: false,
    }),
  ],
  optimizeDeps: {
    noDiscovery: true,
    holdUntilCrawlEnd: false,
  },
  server: {
    host: '127.0.0.1',
    port: 3033,
    strictPort: true,
    watch: {
      ignored: [
        '**/.hmdao-data/**',
        '**/.vite-cache/**',
        '**/.vite-cache-react-lite/**',
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
