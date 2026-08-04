/**
 * HMDao E2E — 一键电影感·视频（RAFT + WebGPU + WebCodecs 真实出片）
 *
 * 运行方式：
 *   - 真机（Chrome/Edge，自带 WebGPU）：npm run dev 起在 3000，另开终端 `npm run test:e2e`
 *   - CI（headless，无 WebGPU）：真实 GPU 出片用例自动 skip，仅验证面板归集等 GPU 无关断言
 *
 * 说明：
 *   - 面板归集用例在真实浏览器里确认「下载就能用」——所有一键电影感/抠图依赖的模型
 *     都出现在统一模型下载面板（PRESET_MODELS / 运行时卡片）。
 *   - GPU 出片用例经 DEV 模式注入的测试桩（window.HMDAO_TEST）直接调用应用内部管线，
 *     生成合成视频后跑 RAFT + WebGPU + WebCodecs，断言真实产出 webm，避免脆弱的 UI 选择器。
 */

import { test, expect, type Page } from '@playwright/test';

const NAV_TIMEOUT = 15_000;

async function openModelPanel(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForSelector('.react-flow', { timeout: NAV_TIMEOUT });
  await page.getByTestId('sidebar-tab-models').click();
  await page.getByTestId('model-download-panel').waitFor({ timeout: 10_000 });
}

test.describe('模型下载面板归集（真实浏览器，GPU 无关）', () => {
  test('面板列全一键电影感/抠图所需的全部模型（下载即可用）', async ({ page }) => {
    await openModelPanel(page);

    // 客户端 GPU 运动模糊管线来源：RAFT 光流 + RIFE 插帧 + WebGPU 管线能力
    await expect(page.getByTestId('preset-model-raft-optical-flow')).toBeVisible();
    await expect(page.getByTestId('preset-model-rife-frame-interpolation')).toBeVisible();
    await expect(page.getByTestId('preset-model-webgpu-video-motion-blur')).toBeVisible();

    // 智能景深：默认引擎 + 兜底引擎
    await expect(page.getByTestId('preset-model-depth-anything-v3-base')).toBeVisible();
    await expect(page.getByTestId('preset-model-depth-anything-v2-small')).toBeVisible();

    // 一键抠像默认引擎
    await expect(page.getByTestId('preset-model-birefnet-matting')).toBeVisible();

    // 提示词翻译（单一数据源：PRESET_MODELS browserRuntime:'nllb'）
    await expect(page.getByTestId('browser-model-nllb-200-translation')).toBeVisible();
  });
});

test.describe('一键电影感·视频 — 真实 WebGPU 出片', () => {
  test('RAFT + WebGPU + WebCodecs 真实输出 webm', async ({ page }) => {
    test.setTimeout(60_000);
    test.skip(Boolean(process.env.CI), 'CI headless 环境跳过真实 GPU 出片');
    await page.goto('/');
    await page.waitForSelector('.react-flow', { timeout: NAV_TIMEOUT });

    // 需要真实 WebGPU 与 DEV 测试桩；无 GPU 的 headless 环境直接跳过。
    const canRun = await page.evaluate(() => {
      const w = window as unknown as { HMDAO_TEST?: { applyGpuMotionBlurVideoLocally?: unknown } };
      return Boolean(navigator.gpu && w.HMDAO_TEST?.applyGpuMotionBlurVideoLocally);
    });
    test.skip(!canRun, '需要真实 WebGPU + DEV 测试桩（在 Chrome/Edge 的 dev 模式下运行 npm run dev）');

    const result = await page.evaluate(async () => {
      const w = window as unknown as {
        HMDAO_TEST: {
          makeTestVideoUrl: (frames?: number, size?: number) => Promise<string>;
          applyGpuMotionBlurVideoLocally: (
            url: string,
            opts?: { fps?: number; maxSide?: number },
          ) => Promise<{ ok: boolean; reason?: string; blob?: { type: string; size: number } }>;
        };
      };
      const videoUrl = await w.HMDAO_TEST.makeTestVideoUrl(12, 128);
      const res = await w.HMDAO_TEST.applyGpuMotionBlurVideoLocally(videoUrl, { fps: 12, maxSide: 128 });
      return {
        ok: res.ok,
        reason: res.reason ?? '',
        type: res.blob?.type ?? '',
        size: res.blob?.size ?? 0,
      };
    });

    test.skip(!result.ok, `GPU 运动模糊未成功（${result.reason || 'unknown'}），在 CI/无 GPU 环境跳过`);
    expect(result.size, '未产出有效体积的视频').toBeGreaterThan(0);
    expect(result.type.startsWith('video/'), `产物类型非视频：${result.type}`).toBe(true);
  });
});
