// Phase A 验证：照参考图生成相似内容 —— 参考图必须真正进入出图请求体。
// 运行：npx vitest run src/services/__tests__/aiDeepAnalysisReference.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 仅 mock generateNodeOutput（避免真实网络/后端），但保留真实的 buildGenerationBody，
// 让 mock 内部用真实函数构造请求体，从而验证「最终出图请求体」确实含参考图字段。
vi.mock('@/services/generation', async (importOriginal) => {
  const mod = (await importOriginal()) as any;
  return {
    ...mod,
    generateNodeOutput: vi.fn(async ({ data, onRequestBody }: any) => {
      // 用真实 body 构造器复现后端实际请求体（与 generateNodeOutput 内部一致）
      const body = mod.buildGenerationBody('image', 'test-model', 'prompt', data);
      if (typeof onRequestBody === 'function') await onRequestBody(body);
      return { imageUrl: 'http://cdn/result.png', nodeId: 'x', nodeType: 'image' };
    }),
  };
});

import {
  generateSimilarImage,
  generateSimilarVariants,
  setDefaultSimilarImageModel,
} from '../aiDeepAnalysisService';
import { generateNodeOutput } from '@/services/generation';

const refSpy = generateNodeOutput as unknown as ReturnType<typeof vi.fn>;

function makeAnalysis(prompt = 'a red cat, cinematic') {
  return { compositePrompt: prompt } as any;
}

beforeEach(() => {
  refSpy.mockClear();
  setDefaultSimilarImageModel({ provider: 'volcengine', model: 'doubao-seedream-5.0-lite' });
});

describe('Phase A：照参考图生成（参考图真正进入请求体）', () => {
  it('单张参考图：出图请求体必须含 reference_image_url=<参考图>，且 reference_assets 含该图', async () => {
    const res = await generateSimilarImage(makeAnalysis(), 'http://ref1.png', { mode: 'similar' });
    expect(res.success).toBe(true);
    expect(refSpy).toHaveBeenCalledTimes(1);

    const body = res.requestBody as any;
    expect(body).toBeTruthy();
    expect(body.reference_image_url).toBe('http://ref1.png');
    expect(Array.isArray(body.reference_assets)).toBe(true);
    expect(body.reference_assets.length).toBe(1);
    expect(body.reference_assets[0].url).toBe('http://ref1.png');
    expect(body.reference_assets[0].type).toBe('image');
  });

  it('多张参考图：reference_assets 含全部参考图（首位为主参考）', async () => {
    const res = await generateSimilarImage(makeAnalysis(), undefined, {
      referenceUrls: ['http://ref1.png', 'http://ref2.png', 'http://ref3.png'],
      mode: 'similar',
    });
    expect(res.success).toBe(true);
    const body = res.requestBody as any;
    expect(body.reference_image_url).toBe('http://ref1.png');
    expect(body.reference_assets.length).toBe(3);
    expect(body.reference_assets.map((a: any) => a.url)).toEqual([
      'http://ref1.png',
      'http://ref2.png',
      'http://ref3.png',
    ]);
    // 首图 role 由 mode 决定，其余为 style
    const data = refSpy.mock.calls[0][0].data;
    const refs = data.inputs.filter((i: any) => i.channel === 'reference');
    expect(refs[0].url).toBe('http://ref1.png');
    expect(refs[0].channel).toBe('reference');
    expect(refs[0].type).toBe('image');
    expect(refs[0].enabled).toBe(true);
    expect(refs[1].url).toBe('http://ref2.png');
  });

  it('换主体模式：首张参考图 role=subject 且 generationMode=preserve_composition', async () => {
    const res = await generateSimilarImage(makeAnalysis(), 'http://ref1.png', { mode: 'subject' });
    const data = refSpy.mock.calls[0][0].data;
    const first = data.inputs.find((i: any) => i.channel === 'reference');
    expect(first.role).toBe('subject');
    expect(data.params.generationMode).toBe('preserve_composition');
    const body = res.requestBody as any;
    expect(body.reference_image_url).toBe('http://ref1.png');
  });

  it('换风格模式：首张参考图 role=style', async () => {
    const res = await generateSimilarImage(makeAnalysis(), 'http://ref1.png', { mode: 'style' });
    const data = refSpy.mock.calls[0][0].data;
    const first = data.inputs.find((i: any) => i.channel === 'reference');
    expect(first.role).toBe('style');
  });

  it('无参考图：直接失败并给出明确错误（不再静默产出无关文生图）', async () => {
    const res = await generateSimilarImage(makeAnalysis());
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/参考图/);
    expect(refSpy).not.toHaveBeenCalled();
  });

  it('无提示词：直接失败', async () => {
    const res = await generateSimilarImage({} as any, 'http://ref1.png');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/提示词/);
  });

  it('详细变体：批量生成各自携带同一组参考图，且全部成功', async () => {
    const res = await generateSimilarVariants(makeAnalysis(), 2, ['http://ref1.png', 'http://ref2.png']);
    expect(res.length).toBe(2);
    expect(res.every((v) => v.success)).toBe(true);
    expect(refSpy).toHaveBeenCalledTimes(2);
    const body = res[0].requestBody as any;
    expect(body.reference_image_url).toBe('http://ref1.png');
    expect(body.reference_assets.length).toBe(2);
  });

  it('向后兼容：第二个位置参数 referenceImageUrl 仍可作为单张参考图', async () => {
    const res = await generateSimilarImage(makeAnalysis(), 'http://legacy.png');
    const data = refSpy.mock.calls[0][0].data;
    expect(data.inputs[0].url).toBe('http://legacy.png');
  });
});
