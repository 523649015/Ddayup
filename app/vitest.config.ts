import react from '@vitejs/plugin-react'
import path from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    testTimeout: 5000,
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/services/localTranslate.ts', 'src/services/promptAssist.ts', 'src/hooks/useLocalTranslateProgress.ts'],
    },
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    globals: true,
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
