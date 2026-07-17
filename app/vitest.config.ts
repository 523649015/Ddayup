import path from 'path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    // jsdom: 模拟浏览器环境（localStorage, fetch, IndexedDB 等）
    environment: 'jsdom',
    // 全局设置：5 秒超时足够模型加载模拟
    testTimeout: 5000,
    // 允许 vitest 清理 mocks
    clearMocks: true,
    restoreMocks: true,
    // 覆盖率（可选，CI 时启用）
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/services/localTranslate.ts', 'src/services/promptAssist.ts', 'src/hooks/useLocalTranslateProgress.ts'],
    },
    // 测试文件匹配
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // 全局设置
    globals: true,
    // 路径别名 — 与 vite.config.ts 一致
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
