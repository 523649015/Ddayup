/**
 * NLLB-200 下载 + 图片翻译按钮 + 下载不刷新 集成测试
 *
 * 覆盖三项验收：
 *   1️⃣ 从「模型下载」面板点「安装」能成功下载 NLLB-200（状态 idle → downloading → ready）
 *   2️⃣ 图片节点的「自动翻译」按钮（assistPrompt action=translate）在模型就绪时正常翻译，
 *      未安装时给出友好的 NLLB 安装提示而非崩溃
 *   3️⃣ 下载/导入阶段若 CDN 导入失败，vite:preloadError 处理器【不刷新页面】，
 *      且 loadTransformersModule 对 import() 返回 undefined 做了防御性报错（修复前的崩溃根因）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { LocalModelPanel } from '@/components/LocalModelPanel';
import { assistPrompt } from '@/services/promptAssist';
import {
  ensureTranslatorLoaded,
  releaseTranslator,
  MODEL_PLUGINS,
  getLocalTranslateState,
} from '@/services/localTranslate';
import {
  createPreloadErrorHandler,
  shouldSkipPreloadRecovery,
} from '@/utils/preloadRecovery';

// 远端代理请求不应在本地翻译路径被调用
vi.mock('@/api/proxy', () => ({
  proxyRequest: vi.fn(),
}));

// ─────────────────────────────────────────────────────────
// 用 vi.hoisted 共享可变状态，mock @xenova/transformers 的默认导出
// （vitest 中 vi.stubGlobal('import') 无法拦截裸模块说明符的动态 import，
//  而 vi.mock 能拦截 Vite 的模块解析，避免真实包拉起 sharp 原生模块）
// ─────────────────────────────────────────────────────────
const h = vi.hoisted(() => {
  const state = {
    translations: {} as Record<string, string>,
    broken: false, // 模拟 CDN 返回非模块内容（import() 解析为 undefined）
  };
  const pipeline = vi.fn(async (_task: string, _model: string, opts?: any) => {
    if (opts?.progress_callback) {
      for (let p = 0; p <= 100; p += 20) {
        opts.progress_callback(p);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    return async (text: string) => {
      if (state.translations[text]) return [{ translation_text: state.translations[text] }];
      return [{ translation_text: `[en] ${text}` }];
    };
  });
  return { state, pipeline };
});

// 用 getter 让 mod.pipeline / mod.env 在【每次访问时】按 h.state.broken 动态返回：
// 同一测试文件内前面的用例已缓存该模块，factory 不会重跑，
// 因此必须用 getter 才能在后续用例里切换成「CDN 返回非模块（undefined）」的状态。
vi.mock('@xenova/transformers', () => ({
  get pipeline() {
    return h.state.broken ? undefined : h.pipeline;
  },
  get env() {
    return h.state.broken ? undefined : {};
  },
}));

async function resetService() {
  h.state.broken = false;
  h.state.translations = {};
  await releaseTranslator();
  MODEL_PLUGINS[0].canUpdate = false;
  try {
    window.sessionStorage.clear();
  } catch {
    // ignore
  }
}

beforeEach(async () => {
  await resetService();
});

afterEach(async () => {
  await resetService();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────
// 1️⃣ 从模型下载面板安装 NLLB-200
// ─────────────────────────────────────────────────────────
describe('模型下载面板：NLLB-200 安装', () => {
  it('点击「安装」后面板状态变为「已安装」', async () => {
    render(<LocalModelPanel />);

    // 初始：未安装，渲染「安装」按钮
    const installBtn = screen.getByRole('button', { name: '安装' });
    expect(installBtn).toBeTruthy();

    fireEvent.click(installBtn);

    // 等待状态推进到 ready（已安装）
    await waitFor(
      () => {
        expect(screen.getByText('已安装')).toBeTruthy();
      },
      { timeout: 5000 },
    );

    expect(getLocalTranslateState().status).toBe('ready');
    expect(MODEL_PLUGINS[0].status).toBe('ready');
    expect(MODEL_PLUGINS[0].progress).toBe(100);
  });

  it('下载过程中显示「下载中」而非页面刷新/跳转', async () => {
    render(<LocalModelPanel />);

    const installBtn = screen.getByRole('button', { name: '安装' });
    fireEvent.click(installBtn);

    // 在 downloading 阶段不应出现任何导航
    await waitFor(() => {
      const state = getLocalTranslateState();
      expect(['downloading', 'ready']).toContain(state.status);
    });

    // 直到 ready
    await waitFor(() => expect(getLocalTranslateState().status).toBe('ready'), {
      timeout: 5000,
    });
  });
});

// ─────────────────────────────────────────────────────────
// 2️⃣ 图片「自动翻译」按钮（assistPrompt action=translate）
// ─────────────────────────────────────────────────────────
describe('图片自动翻译按钮', () => {
  it('模型就绪时，翻译走本地 NLLB 并返回译文', async () => {
    h.state.translations = { '一只猫在睡觉': 'A cat is sleeping' };
    await ensureTranslatorLoaded();
    expect(getLocalTranslateState().status).toBe('ready');

    const result = await assistPrompt({
      prompt: '一只猫在睡觉',
      action: 'translate',
      target: 'image',
      provider: 'siliconflow',
    });

    expect(result).toBe('A cat is sleeping');

    // 本地翻译不应触发远端 API 请求
    const { proxyRequest } = await import('@/api/proxy');
    expect(proxyRequest).not.toHaveBeenCalled();
  });

  it('模型未安装时，给出清晰的 NLLB 安装引导而不是崩溃', async () => {
    await resetService(); // 回到 idle

    await expect(
      assistPrompt({
        prompt: '你好世界',
        action: 'translate',
        target: 'image',
        provider: 'siliconflow',
      }),
    ).rejects.toThrow(/NLLB-200/);
  });

  it('英文提示词经本地模型翻译为中文', async () => {
    h.state.translations = { 'A cyberpunk city at night': '赛博朋克风格的夜晚城市' };
    await ensureTranslatorLoaded();
    const result = await assistPrompt({
      prompt: 'A cyberpunk city at night',
      action: 'translate',
      target: 'image',
      provider: 'siliconflow',
    });
    expect(result).toBe('赛博朋克风格的夜晚城市');
  });
});

// ─────────────────────────────────────────────────────────
// 3️⃣ 下载/导入阶段页面不刷新（vite:preloadError 处理器）
// ─────────────────────────────────────────────────────────
describe('下载阶段页面不刷新', () => {
  it('shouldSkipPreloadRecovery 命中 CDN / @xenova / cloudflare 等失败', () => {
    expect(
      shouldSkipPreloadRecovery(
        'Failed to fetch dynamically imported module: https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/src/transformers.js',
      ),
    ).toBe(true);
    expect(
      shouldSkipPreloadRecovery(
        'Failed to fetch dynamically imported module: https://cdnjs.cloudflare.net/.../ort-wasm-simd-threaded.wasm',
      ),
    ).toBe(true);
    expect(shouldSkipPreloadRecovery('@xenova/transformers load error')).toBe(true);
    // 同源 chunk 失败（新部署 hash 变更）仍应刷新
    expect(shouldSkipPreloadRecovery('Failed to fetch assets/index-abc.js')).toBe(false);
  });

  it('CDN 导入失败时，处理器不 preventDefault、不刷新页面', () => {
    const navigate = vi.fn();
    const handler = createPreloadErrorHandler({ navigate });
    const preventDefault = vi.fn();
    const event = {
      payload: new Error(
        'Failed to fetch dynamically imported module: https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/src/transformers.js',
      ),
      preventDefault,
    };

    handler(event);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('Vite chunk 自身加载失败时仍走一次性自动刷新恢复', () => {
    const navigate = vi.fn();
    const handler = createPreloadErrorHandler({ navigate });
    const preventDefault = vi.fn();
    const sameOriginUrl = `${window.location.origin}/assets/index-abc123.js`;
    const event = {
      payload: new Error(
        `Failed to fetch dynamically imported module: ${sameOriginUrl}`,
      ),
      preventDefault,
    };

    handler(event);

    expect(preventDefault).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('同源 chunk 失败：首次刷新一次，重复调用同一路径不再刷新（防无限循环）', () => {
    const navigate = vi.fn();
    const handler = createPreloadErrorHandler({ navigate });
    const sameOriginUrl = `${window.location.origin}/assets/index-abc123.js`;
    const makeEvent = () => ({
      payload: new Error(
        `Failed to fetch dynamically imported module: ${sameOriginUrl}`,
      ),
      preventDefault: vi.fn(),
    });

    handler(makeEvent());
    expect(navigate).toHaveBeenCalledTimes(1);

    // 同一路径再次失败：守卫应拦截，避免无限刷新
    handler(makeEvent());
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('import() 返回 undefined 时，loadTransformersModule 抛出清晰错误而非解构崩溃', async () => {
    // 模拟修复前的故障根因：CDN 返回非模块内容，import() 被 resolve 为 undefined
    h.state.broken = true;

    const ok = await ensureTranslatorLoaded();
    expect(ok).toBe(false);

    const state = getLocalTranslateState();
    expect(state.status).toBe('error');
    expect(state.error).toContain('pipeline');
  });
});
