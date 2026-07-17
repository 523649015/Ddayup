/**
 * 问题 3：自动翻译性能 测试（translateCore）
 *
 * 复现并验证的性能瓶颈：翻译 50 个词需一两分钟。
 * 根因：translateWith 未设置 max_new_tokens，NLLB 解码器一路生成到默认上限（~256 token），
 *       长提示在 WASM CPU 上逐 token 解码极慢。
 *
 * 覆盖：
 *   ✅ translateWith 为每个 chunk 传入紧凑的 max_new_tokens（关键性能修复）
 *   ✅ max_new_tokens 随输入长度自适应，且恒定落在 [40, 256] 区间
 *   ✅ 短文本使用下限 40（避免过度解码）
 *   ✅ 传入正确的 src_lang / tgt_lang（zh↔en 双向）
 *   ✅ createTranslator 启用多线程 wasm（numThreads = min(4, 硬件并发)）以加速解码
 *   ✅ chunkText 长文本分块（≤400 字符/段），降低单次推理长度
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 拦截 @xenova/transformers，env 用可变共享对象以便断言 numThreads
const transformersLib = vi.hoisted(() => ({
  pipeline: vi.fn(),
  env: {} as any,
}));
vi.mock('@xenova/transformers', () => ({
  pipeline: transformersLib.pipeline,
  env: transformersLib.env,
}));

import { translateWith, createTranslator, chunkText, LANG_MAP } from '@/services/translateCore';

/** 期望的自适应上限公式（与实现保持一致），用于断言 */
function expectedMaxNewTokens(len: number): number {
  return Math.min(256, Math.max(40, Math.round(len / 2) + 16));
}

beforeEach(() => {
  transformersLib.pipeline.mockReset();
  // 重置 env（createTranslator 会写入 backends）
  for (const k of Object.keys(transformersLib.env)) delete transformersLib.env[k];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('问题3：翻译性能 — translateWith 解码上限', () => {
  it('为翻译调用传入 max_new_tokens（关键性能修复，避免解码到默认 256）', async () => {
    const calls: any[] = [];
    const translator = vi.fn(async (chunk: string, opts: any) => {
      calls.push({ chunk, opts });
      return [{ translation_text: `T:${chunk}` }];
    });

    const text = '一只猫坐在窗台上晒太阳';
    const result = await translateWith(translator, text, 'zh');

    expect(result).toBe(`T:${text}`);
    expect(calls).toHaveLength(1);
    expect(calls[0].opts).toBeDefined();
    // 必须显式设置 max_new_tokens（这是修复的核心）
    expect(typeof calls[0].opts.max_new_tokens).toBe('number');
    expect(calls[0].opts.max_new_tokens).toBe(expectedMaxNewTokens(text.length));
  });

  it('max_new_tokens 恒定落在 [40, 256] 区间，且随输入自适应', async () => {
    const seen: number[] = [];
    const translator = vi.fn(async (chunk: string, opts: any) => {
      seen.push(opts.max_new_tokens);
      return [{ translation_text: chunk }];
    });

    // 覆盖：极短、正常、超长（超长会被 chunkText 切分，逐段验证）
    await translateWith(translator, '猫', 'zh');
    await translateWith(translator, '一只橘猫慵懒地趴在洒满阳光的木质窗台上', 'zh');
    await translateWith(translator, 'A'.repeat(1200), 'en');

    for (const n of seen) {
      expect(n).toBeGreaterThanOrEqual(40);
      expect(n).toBeLessThanOrEqual(256);
    }
  });

  it('短文本使用下限 40（不做冗长解码）', async () => {
    let captured = 0;
    const translator = vi.fn(async (chunk: string, opts: any) => {
      captured = opts.max_new_tokens;
      return [{ translation_text: chunk }];
    });

    await translateWith(translator, '猫', 'zh'); // 长度极短 → 命中下限
    expect(captured).toBe(40);
  });

  it('超长文本按 400 上限分块，各段独立设置 max_new_tokens', async () => {
    const perCall: number[] = [];
    const translator = vi.fn(async (chunk: string, opts: any) => {
      expect(chunk.length).toBeLessThanOrEqual(400);
      perCall.push(opts.max_new_tokens);
      return [{ translation_text: chunk }];
    });

    const longText = ('这是一段用于测试分块的中文提示词。').repeat(60); // 远超 400 字符
    await translateWith(translator, longText, 'zh');

    expect(perCall.length).toBeGreaterThan(1); // 确实分了多块
    for (const n of perCall) {
      expect(n).toBeGreaterThanOrEqual(40);
      expect(n).toBeLessThanOrEqual(256);
    }
  });

  it('传入正确的 src_lang / tgt_lang（中→英 与 英→中）', async () => {
    const translator = vi.fn(async (chunk: string, opts: any) => {
      return [{ translation_text: chunk, __opts: opts }];
    });

    await translateWith(translator, '你好', 'zh');
    expect(translator).toHaveBeenLastCalledWith(
      '你好',
      expect.objectContaining({ src_lang: LANG_MAP.zh.src, tgt_lang: LANG_MAP.zh.tgt }),
    );

    await translateWith(translator, 'hello', 'en');
    expect(translator).toHaveBeenLastCalledWith(
      'hello',
      expect.objectContaining({ src_lang: LANG_MAP.en.src, tgt_lang: LANG_MAP.en.tgt }),
    );
  });
});

describe('问题3：翻译性能 — createTranslator 多线程 wasm', () => {
  it('启用多线程 wasm，numThreads = min(4, 硬件并发)（加速解码）', async () => {
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      value: 16,
      configurable: true,
    });

    transformersLib.pipeline.mockResolvedValue(async (t: string) => [{ translation_text: t }]);

    await createTranslator();

    const wasm = transformersLib.env?.backends?.onnx?.wasm;
    expect(wasm).toBeDefined();
    expect(typeof wasm.numThreads).toBe('number');
    // 16 核 → 上限封顶为 4
    expect(wasm.numThreads).toBe(4);
    expect(wasm.numThreads).toBeGreaterThanOrEqual(1);
  });

  it('numThreads 始终 ≥ 1（低核数环境安全回退）', async () => {
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      value: 1,
      configurable: true,
    });
    transformersLib.pipeline.mockResolvedValue(async (t: string) => [{ translation_text: t }]);

    await createTranslator();
    expect(transformersLib.env.backends.onnx.wasm.numThreads).toBe(1);
  });
});

describe('问题3：翻译性能 — chunkText 分块', () => {
  it('短文本不分块', () => {
    const chunks = chunkText('一只猫');
    expect(chunks).toEqual(['一只猫']);
  });

  it('超长文本分块，每段 ≤ 400 字符', () => {
    const longText = ('赛博朋克城市夜景，霓虹灯闪烁，电子屏广告，雨后天桥，电影感光线。').repeat(40);
    const chunks = chunkText(longText);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(400);
    }
  });

  it('空文本安全返回', () => {
    expect(chunkText('')).toEqual(['']);
  });
});
