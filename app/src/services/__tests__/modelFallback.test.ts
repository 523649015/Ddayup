import { describe, it, expect } from 'vitest';
import {
  resolveModelForTask,
  executeWithModelFallback,
  withReferenceRequirements,
  defaultRequirementsForTask,
  FREE_FIRST_CHAINS,
} from '@/services/modelFallback';

describe('modelFallback - 免费优先 + 能力不符按优先级切换', () => {
  it('图片纯文生图：免费优先，不回退', () => {
    const r = resolveModelForTask('image', { preferFree: true, requirements: defaultRequirementsForTask('image') });
    expect(r?.isFree).toBe(true);
    expect(r?.autoSwitched).toBe(false);
    expect(r?.modelId).toContain('Qwen/Qwen-Image');
  });

  it('图片带参考图：免费模型支持 imageToImage 仍是免费', () => {
    const req = withReferenceRequirements(defaultRequirementsForTask('image'));
    const r = resolveModelForTask('image', { preferFree: true, requirements: req });
    expect(r?.isFree).toBe(true);
    expect(r?.autoSwitched).toBe(false);
    expect(r?.fallbackChain.some((c) => c.model === r.model && c.capabilities?.generationModes?.includes('imageToImage'))).toBe(true);
  });

  it('图片免费模型都不支持 imageToImage：自动按优先级回退付费', () => {
    const fakeChain = [
      { id: 'fake-free-t2i', provider: 'fake', model: 'fake-free-t2i', isFree: true, capabilities: { generationModes: ['textToImage'] } },
      { id: 'fake-paid-i2i', provider: 'fake', model: 'fake-paid-i2i', isFree: false, capabilities: { generationModes: ['imageToImage'], referenceRoles: ['subject'] } },
    ];
    const req = withReferenceRequirements(defaultRequirementsForTask('image'));
    const r = resolveModelForTask('image', { preferFree: true, requirements: req, chain: fakeChain });
    expect(r?.isFree).toBe(false);
    expect(r?.autoSwitched).toBe(true);
    expect(r?.modelId).toContain('fake-paid-i2i');
  });

  it('文本/视频免费优先', () => {
    expect(resolveModelForTask('text', { preferFree: true })?.modelId).toContain('deepseek-chat');
    expect(resolveModelForTask('video', { preferFree: true })?.modelId).toContain('Wan2.2-I2V');
  });

  it('运行期错误回退：免费模型报错切到下一个', async () => {
    const chain = FREE_FIRST_CHAINS.image;
    const runFn = async (c: { provider: string; model: string; isFree: boolean }) => {
      if (c.isFree) throw new Error(`model ${c.model} quota exhausted (403)`);
      return { imageUrl: 'blob://ok', used: c.model };
    };
    const res = await executeWithModelFallback(runFn, chain, defaultRequirementsForTask('image'));
    expect(res.ok).toBe(true);
    expect(res.modelId).toContain('flux-pro');
    expect(res.attempts.length).toBeGreaterThanOrEqual(3);
  });

  it('所有候选失败：ok=false 且汇总错误', async () => {
    const chain = FREE_FIRST_CHAINS.text;
    const res = await executeWithModelFallback(async () => { throw new Error('fail'); }, chain, defaultRequirementsForTask('text'));
    expect(res.ok).toBe(false);
    expect(res.attempts.length).toBe(chain.length);
  });
});
