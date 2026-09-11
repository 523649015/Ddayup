// 参考图风格分析 → 聊天面板 回归测试
// 运行：npx vitest run src/services/__tests__/referenceStyleAnalysisChat.test.ts
import { describe, it, expect } from 'vitest';
import { wantGenerationFromMedia, buildMediaAwarePlan } from '@/services/agentMediaWorkflow';
import { formatReferenceAnalysisMessage } from '@/services/agentAnalysisChat';

describe('意图识别：分析参考图风格不应被误判为「生成」', () => {
  it('「分析参考图的风格元素」→ 纯分析（不是生成工作流）', () => {
    expect(wantGenerationFromMedia('分析参考图的风格元素', 'image')).toBe(false);
  });

  it('「识别这张图的风格」→ 纯分析', () => {
    expect(wantGenerationFromMedia('识别这张图的风格', 'image')).toBe(false);
  });

  it('「描述一下图像风格与构图」→ 纯分析', () => {
    expect(wantGenerationFromMedia('描述一下图像风格与构图', 'image')).toBe(false);
  });

  it('「把这张图改成赛博朋克风格」→ 生成（含改/风格，无分析动词）', () => {
    expect(wantGenerationFromMedia('把这张图改成赛博朋克风格', 'image')).toBe(true);
  });

  it('「生成一张类似风格的图」→ 生成（强生成动词优先）', () => {
    expect(wantGenerationFromMedia('生成一张类似风格的图', 'image')).toBe(true);
  });
});

describe('buildMediaAwarePlan：分析意图生成「分析工作流」', () => {
  const asset = { id: 'asset-1', url: 'http://x/a.png', name: 'ref.png' };
  const analysisText = '总结：午后街道；主体：行人；风格：胶片；场景：城市；情绪：宁静';

  it('分析意图 → 工作流名「图片分析工作流」、步骤「分析图片」、节点类型 image', () => {
    const plan = buildMediaAwarePlan({ kind: 'image', asset, analysisText, userText: '分析参考图的风格元素' });
    expect(plan.name).toBe('图片分析工作流');
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].label).toBe('分析图片');
    expect(plan.steps[0].type).toBe('image');
  });

  it('生成意图 → 工作流名「图片创作工作流」、步骤「基于图片生成」', () => {
    const plan = buildMediaAwarePlan({ kind: 'image', asset, analysisText, userText: '把这张图改成赛博朋克风格' });
    expect(plan.name).toBe('图片创作工作流');
    expect(plan.steps[0].label).toBe('基于图片生成');
  });

  it('分析结果被合并进节点 prompt（确保风格元素进入上下文）', () => {
    const plan = buildMediaAwarePlan({ kind: 'image', asset, analysisText, userText: '分析参考图的风格元素' });
    expect(plan.steps[0].data.prompt).toContain('胶片');
    expect(plan.steps[0].data.prompt).toContain('分析参考图的风格元素');
  });
});

describe('formatReferenceAnalysisMessage：分析结果返回聊天面板', () => {
  it('图片分析 → 含 Florence-2 标识与风格行', () => {
    const msg = formatReferenceAnalysisMessage({
      kind: 'image',
      analysisText: '总结：X；主体：Y；风格：胶片；场景：城市；情绪：宁静',
      fileName: 'ref.png',
    });
    expect(msg).toContain('Florence-2');
    expect(msg).toContain('ref.png');
    expect(msg).toContain('风格：胶片');
  });

  it('分析文本缺失 → 有兜底文案，不报空', () => {
    const msg = formatReferenceAnalysisMessage({ kind: 'image', analysisText: '', fileName: 'x.png' });
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).toContain('Florence-2');
  });
});
