import { defineConfig, devices } from '@playwright/test';

/**
 * HMDao Playwright 配置。
 *
 * - 真机（Chrome/Edge）自带 WebGPU，因此 e2e 直接跑开发服务器（DEV 构建会注入测试桩 window.HMDAO_TEST）。
 * - 端口固定 3000（与发布产物 serve:3000 一致），方便在真机验证「构建产物进 3000」。
 * - headless CI 无 WebGPU 时，真实 GPU 出片用例会自动 skip，仅跑面板归集等 GPU 无关断言。
 */

const PORT = 3000;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [['html', { outputFolder: 'playwright-report' }]]
    : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev -- --port 3000 --host 127.0.0.1',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
