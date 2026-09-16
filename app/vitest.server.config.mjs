import { defineConfig } from 'vitest/config';

/**
 * 服务端（app/server）单测专用配置。
 *
 * 为什么不并入 vitest.config.ts：
 *   1) 前端配置是 jsdom 环境且 include 仅 `src/**`，服务端纯函数测试应跑在 node 环境；
 *   2) `server/__tests__/license.test.mjs` 会加载 app/.env 并持有句柄，在 vitest 下
 *      collect 之后不退出（实测卡死）→ 若并入 `npm test` 会把前端测试一起拖住。
 *      该文件为既有问题（此前从未被任何 vitest 配置覆盖，等于从未执行），
 *      待单独修复后再从 exclude 中移除。
 *
 * 用法：npm run test:server
 */
export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 10000,
    include: ['server/**/*.test.mjs'],
    exclude: ['**/node_modules/**', '**/dist/**', 'server/__tests__/license.test.mjs'],
  },
});
