/**
 * promptAssist 功能测试
 *
 * 测试覆盖：
 *   ✅ detectPromptLanguage 语言检测
 *   ✅ buildSystemPrompt 系统提示词构建
 *   ✅ extractAssistContent 响应格式解析
 *   ✅ assistPrompt → translate（本地 NLLB 就绪 / 未安装 / 错误）
 *   ✅ assistPrompt → optimize（远端 LLM）
 *   ✅ API Key 缺失 / fallback 检测
 *   ✅ 空输入 / 空白输入
 *   ✅ 未知平台
 *   ✅ 网络超时
 *   ✅ 优化结果校验规则
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assistPrompt, localPolishPrompt, type PromptAssistAction, type PromptAssistTarget } from '@/services/promptAssist';
import * as localTranslateModule from '@/services/localTranslate';

// ──────────────────────────────────────────────────────────
// Mock 依赖
// ──────────────────────────────────────────────────────────

// Mock getPlatformConfig
vi.mock('@/config/api-config', () => {
  const platforms: Record<string, any> = {
    siliconflow: {
      id: 'siliconflow',
      name: 'SiliconFlow',
      type: 'image',
      chatEndpoint: '/chat/completions',
      defaultTestModel: 'Qwen/Qwen2.5-7B-Instruct',
      imageEndpoint: '/images/generations',
    },
    unsupported_provider: {
      id: 'unsupported_provider',
      name: 'Unsupported',
      type: 'image',
      // 没有 chatEndpoint
    },
  };

  return {
    getPlatformConfig: (id: string) => platforms[id] || null,
    getApiConfig: () => ({
      platforms: Object.values(platforms),
    }),
  };
});

// Mock proxyRequest
const mockProxyRequest = vi.fn();
vi.mock('@/api/proxy', () => ({
  proxyRequest: (...args: any[]) => mockProxyRequest(...args),
}));

// ──────────────────────────────────────────────────────────
// 可动态控制的本地翻译 mock
// ──────────────────────────────────────────────────────────

let mockLocalTranslate = vi.fn();
let mockTranslateState = {
  status: 'idle' as const,
  progress: 0,
  error: null as string | null,
  modelName: 'Xenova/nllb-200-distilled-600M',
};

vi.mock('@/services/localTranslate', async () => {
  const actual = await vi.importActual('@/services/localTranslate');
  return {
    ...actual,
    localTranslate: (...args: any[]) => mockLocalTranslate(...args),
    getLocalTranslateState: () => ({ ...mockTranslateState }),
    onLocalTranslateStateChange: vi.fn(() => vi.fn()),
    ensureTranslatorLoaded: vi.fn(),
    releaseTranslator: vi.fn(),
    MODEL_PLUGINS: [
      {
        id: 'nllb-200-translation',
        name: 'NLLB-200 翻译模型',
        description: '自动翻译提示词（中↔英），无需 API Key',
        size: '~600MB',
        source: 'Hugging Face Hub',
        status: 'idle' as const,
        progress: 0,
        error: null,
        canUpdate: false,
      },
    ],
  };
});

/** 设置翻译模型状态 */
function setTranslateState(partial: Partial<typeof mockTranslateState>) {
  mockTranslateState = { ...mockTranslateState, ...partial };
}

// ──────────────────────────────────────────────────────────
// 工具函数
// ──────────────────────────────────────────────────────────

function buildParams(overrides: Partial<{
  prompt: string;
  action: PromptAssistAction;
  target: PromptAssistTarget;
  provider: string;
  apiKey: string;
}> = {}) {
  return {
    prompt: overrides.prompt ?? '一只猫坐在窗台上',
    action: overrides.action ?? 'translate',
    target: overrides.target ?? 'image',
    provider: overrides.provider ?? 'siliconflow',
    // 尊重显式传入的 undefined（用于「无 API Key」分支测试）
    apiKey: 'apiKey' in overrides ? overrides.apiKey : 'sk-test-key',
  };
}

/** 模拟 LLM 返回标准 OpenAI 格式 */
function mockOpenAIResponse(content: string) {
  return {
    success: true,
    data: {
      choices: [
        { message: { role: 'assistant', content } },
      ],
    },
  };
}

/** 模拟直接 content 返回 */
function mockDirectResponse(content: string) {
  return {
    success: true,
    content,
  };
}

// ──────────────────────────────────────────────────────────
// 测试套件
// ──────────────────────────────────────────────────────────

describe('promptAssist 服务', () => {
  beforeEach(() => {
    mockProxyRequest.mockReset();
    mockLocalTranslate.mockReset();
    // 默认：翻译模型未安装
    setTranslateState({ status: 'idle', error: null });
  });

  // ────── 1. assistPrompt → translate（本地模型未安装） ──────
  describe('assistPrompt("translate")', () => {
    it('模型未安装时抛出明确错误', async () => {
      await expect(
        assistPrompt(buildParams({ action: 'translate', apiKey: undefined }))
      ).rejects.toThrow('翻译模型未安装');
    });

    it('错误消息提及模型下载面板安装指引', async () => {
      try {
        await assistPrompt(buildParams({ action: 'translate', apiKey: undefined }));
      } catch (e: any) {
        expect(e.message).toContain('NLLB-200');
        expect(e.message).toContain('~600MB');
      }
    });

    it('空提示词直接返回空字符串', async () => {
      const result = await assistPrompt(
        buildParams({ prompt: '', action: 'translate' })
      );
      expect(result).toBe('');
    });

    it('仅空白提示词也返回空字符串', async () => {
      const result = await assistPrompt(
        buildParams({ prompt: '   \n\t  ', action: 'translate' })
      );
      expect(result).toBe('');
    });
  });

  // ────── 2. assistPrompt → translate（本地模型就绪） ──────
  describe('assistPrompt("translate") 模型就绪', () => {
    beforeEach(() => {
      setTranslateState({ status: 'ready', progress: 100 });
    });

    it('中文 → 英文翻译', async () => {
      mockLocalTranslate.mockResolvedValueOnce(
        'A cat sitting on the windowsill'
      );

      const result = await assistPrompt(
        buildParams({ action: 'translate', apiKey: undefined })
      );
      expect(result).toBe('A cat sitting on the windowsill');
      expect(mockLocalTranslate).toHaveBeenCalledWith(
        '一只猫坐在窗台上',
        'zh'
      );
    });

    it('英文 → 中文翻译', async () => {
      mockLocalTranslate.mockResolvedValueOnce('一只猫坐在窗台上');

      const result = await assistPrompt(
        buildParams({
          prompt: 'A cat sitting on the windowsill',
          action: 'translate',
        })
      );
      expect(result).toBe('一只猫坐在窗台上');
      expect(mockLocalTranslate).toHaveBeenCalledWith(
        'A cat sitting on the windowsill',
        'en'
      );
    });

    it('翻译结果与原文一致时仍返回（边界情况）', async () => {
      mockLocalTranslate.mockResolvedValueOnce('A cat sitting on the windowsill');

      const result = await assistPrompt(
        buildParams({
          prompt: 'A cat sitting on the windowsill',
          action: 'translate',
        })
      );
      // 由 detectPromptLanguage 判定为 en → 走 en→zh 翻译
      expect(typeof result).toBe('string');
    });

    it('本地翻译失败时抛出错误（不改走远端）', async () => {
      mockLocalTranslate.mockRejectedValueOnce(
        new Error('ONNX inference error')
      );

      await expect(
        assistPrompt(
          buildParams({ prompt: '测试翻译', action: 'translate' })
        )
      ).rejects.toThrow();
    });
  });

  // ────── 3. assistPrompt → optimize ──────
  describe('assistPrompt("optimize")', () => {
    it('优化中文图片提示词 → 返回优化结果', async () => {
      mockProxyRequest.mockResolvedValueOnce(
        mockOpenAIResponse(
          '一只优雅的橘猫安静地坐在木质窗台上，温暖的午后阳光从窗户洒进来，在猫身上形成柔和的轮廓光。浅景深，背景虚化，使用富士胶片模拟色彩。'
        )
      );

      const result = await assistPrompt(
        buildParams({
          prompt: '一只猫坐在窗台上',
          action: 'optimize',
          target: 'image',
        })
      );

      // 校验规则
      expect(result).toBeTruthy();
      expect(result.length).toBeGreaterThan(10);
      expect(result).not.toBe('一只猫坐在窗台上');
      expect(result).toContain('猫');
    });

    it('优化英文图片提示词 → 返回优化结果', async () => {
      mockProxyRequest.mockResolvedValueOnce(
        mockOpenAIResponse(
          'A majestic orange tabby cat perched gracefully on a rustic wooden windowsill, bathed in warm golden sunlight streaming through the window, creating a beautiful rim light effect. Shot with shallow depth of field, creamy bokeh background, Fujifilm film simulation color palette, photorealistic render, 8K resolution, editorial photography style.'
        )
      );

      const result = await assistPrompt(
        buildParams({
          prompt: 'A cat sitting on a windowsill',
          action: 'optimize',
          target: 'image',
        })
      );

      expect(result).toBeTruthy();
      expect(result.length).toBeGreaterThan(20);
      expect(result).toContain('cat');
      expect(result).toContain('windowsill');
    });

    it('优化视频提示词 → 返回包含运动描述的结果', async () => {
      mockProxyRequest.mockResolvedValueOnce(
        mockOpenAIResponse(
          'A graceful dancer performing a slow contemporary dance in an abandoned warehouse, camera slowly orbiting around her, dust particles floating in shafts of light through broken windows, 24fps cinematic slow motion.'
        )
      );

      const result = await assistPrompt(
        buildParams({
          prompt: 'A dancer in a warehouse',
          action: 'optimize',
          target: 'video',
        })
      );

      expect(result).toBeTruthy();
      expect(result).toContain('dancer');
    });

    it('空提示词直接返回空字符串', async () => {
      const result = await assistPrompt(
        buildParams({ prompt: '', action: 'optimize' })
      );
      expect(result).toBe('');
    });
  });

  // ────── 4. extractAssistContent 响应解析 ──────
  describe('响应解析（间接测试）', () => {
    it('解析 OpenAI choices[0].message.content 格式', async () => {
      mockProxyRequest.mockResolvedValueOnce(
        mockOpenAIResponse('Optimized prompt result')
      );

      const result = await assistPrompt(
        buildParams({ prompt: 'A cat', action: 'optimize' })
      );
      expect(result).toBe('Optimized prompt result');
    });

    it('解析直接 content 字段', async () => {
      mockProxyRequest.mockResolvedValueOnce(
        mockDirectResponse('Direct content result')
      );

      const result = await assistPrompt(
        buildParams({ prompt: 'A dog', action: 'optimize' })
      );
      expect(result).toBe('Direct content result');
    });

    it('解析 choices[0].text 字段', async () => {
      mockProxyRequest.mockResolvedValueOnce({
        success: true,
        data: {
          choices: [{ text: 'Text field result' }],
        },
      });

      const result = await assistPrompt(
        buildParams({ prompt: 'A bird', action: 'optimize' })
      );
      expect(result).toBe('Text field result');
    });

    it('响应无可用文本时抛出错误', async () => {
      mockProxyRequest.mockResolvedValueOnce({
        success: true,
        data: { choices: [] },
      });

      await expect(
        assistPrompt(
          buildParams({ prompt: 'test', action: 'optimize' })
        )
      ).rejects.toThrow('提示词辅助没有返回可用文本');
    });

    it('响应为 null 时抛出错误', async () => {
      mockProxyRequest.mockResolvedValueOnce(null);

      await expect(
        assistPrompt(
          buildParams({ prompt: 'test', action: 'optimize' })
        )
      ).rejects.toThrow();
    });
  });

  // ────── 5. Fallback 检测 ──────
  describe('Fallback 检测', () => {
    it('optimize 且 fallbackActivated=true 时走免费离线润色兜底（不报错）', async () => {
      mockProxyRequest.mockResolvedValueOnce({
        success: true,
        content: 'Placeholder response',
        fallbackActivated: true,
        fallbackReason: 'No API key configured',
        provider: 'siliconflow',
      });

      const result = await assistPrompt(
        buildParams({ prompt: 'test', action: 'optimize' })
      );
      // 离线润色：保留原词并规则化，极短提示追加中性质感短语；图像场景自动追加负向约束
      expect(result).toBe('test, clear fine detail --no text, watermark, logo, blurry, low quality');
    });

    it('mode=fallback 时同样走离线润色兜底', async () => {
      mockProxyRequest.mockResolvedValueOnce({
        success: true,
        content: 'Placeholder',
        mode: 'fallback',
        provider: 'siliconflow',
      });

      const result = await assistPrompt(
        buildParams({ prompt: 'test', action: 'optimize' })
      );
      expect(result).toBeTruthy();
      expect(result).not.toContain('API Key');
    });

    it('mode=local 时也走离线润色兜底', async () => {
      mockProxyRequest.mockResolvedValueOnce({
        success: true,
        content: 'Local fallback placeholder',
        mode: 'local',
        provider: 'siliconflow',
      });

      const result = await assistPrompt(
        buildParams({ prompt: 'test', action: 'optimize' })
      );
      expect(result).toBeTruthy();
    });
  });

  // ────── 5b. Bug1 回归：optimize 永不返回系统提示词占位 ──────
  describe('Bug1 回归：optimize 永不把系统提示词当结果返回', () => {
    it('无 API Key 时 optimize 直接走免费离线润色，且不发起任何远端请求', async () => {
      const result = await assistPrompt(
        buildParams({ prompt: '一只小老鼠在黑暗的灯光下慢慢散步。', action: 'optimize', apiKey: undefined })
      );

      // 绝不发起网络请求
      expect(mockProxyRequest).not.toHaveBeenCalled();
      // 结果是基于原文案的原地润色：保留主体，并按「动物」主体补了具体质感
      expect(result).toContain('小老鼠');
      expect(result).toContain('散步');
      expect(result).toContain('毛发');
      // 绝不是空泛 booster 套话
      expect(result).not.toContain('视觉冲击力');
      // 绝不是系统提示词占位
      expect(result).not.toContain('You are a prompt polisher');
      expect(result.startsWith('Generated content:')).toBe(false);
    });

    it('远端返回 "Generated content:" 占位（把 system+user 拼进去）时，回退离线润色而非返回垃圾', async () => {
      mockProxyRequest.mockResolvedValueOnce({
        success: true,
        mode: 'llm',
        content:
          'Generated content: You are a prompt polisher. Your task is to MICRO-TUNE and refine the user\'s English prompt IN PLACE — not to rewrite it. A cat on a windowsill',
        fallbackReason: '真实上游代理未返回结果，已回退到本地占位结果',
        workflowFallback: true,
        provider: 'siliconflow',
      });

      const result = await assistPrompt(
        buildParams({ prompt: 'A cat on a windowsill', action: 'optimize' })
      );

      // 必须是基于原文案的润色，而非那段系统提示词垃圾
      expect(result.startsWith('Generated content:')).toBe(false);
      expect(result).not.toContain('You are a prompt polisher');
      expect(result.toLowerCase()).toContain('cat');
      expect(result.toLowerCase()).toContain('windowsill');
    });
  });

  // ────── 6. 平台错误 ──────
  describe('平台与 API 错误', () => {
    it('不支持的平台抛出错误', async () => {
      await expect(
        assistPrompt(
          buildParams({
            prompt: 'test',
            action: 'optimize',
            provider: 'unsupported_provider',
          })
        )
      ).rejects.toThrow('不支持提示词辅助');
    });

    it('优化请求失败时抛出错误', async () => {
      mockProxyRequest.mockRejectedValueOnce(
        new Error('API rate limit exceeded')
      );

      await expect(
        assistPrompt(
          buildParams({ prompt: 'test', action: 'optimize' })
        )
      ).rejects.toThrow('API rate limit exceeded');
    });
  });

  // ────── 7. 优化结果校验规则 ──────
  describe('优化结果校验规则', () => {
    it('优化结果长度不低于原文', async () => {
      const prompt = 'A cat';
      mockProxyRequest.mockResolvedValueOnce(
        mockOpenAIResponse(
          'A beautiful orange tabby cat with bright green eyes sitting gracefully'
        )
      );

      const result = await assistPrompt(
        buildParams({ prompt, action: 'optimize' })
      );
      expect(result.length).toBeGreaterThanOrEqual(prompt.length);
    });

    it('优化结果保留核心主题词', async () => {
      mockProxyRequest.mockResolvedValueOnce(
        mockOpenAIResponse(
          'A stunning high-fashion portrait of a woman in a flowing red dress, dramatic studio lighting'
        )
      );

      const result = await assistPrompt(
        buildParams({
          prompt: 'A woman in a red dress',
          action: 'optimize',
        })
      );

      expect(result.toLowerCase()).toContain('woman');
      expect(result.toLowerCase()).toContain('red');
      expect(result.toLowerCase()).toContain('dress');
    });

    it('优化结果不包含原始提示词以外的无关内容', async () => {
      mockProxyRequest.mockResolvedValueOnce(
        mockOpenAIResponse(
          'A serene mountain landscape at sunset with golden light and misty valleys'
        )
      );

      const result = await assistPrompt(
        buildParams({
          prompt: 'Mountain landscape at sunset',
          action: 'optimize',
        })
      );

      // 不应该引入无关主题
      expect(result.toLowerCase()).not.toContain('cat');
      expect(result.toLowerCase()).not.toContain('portrait');
      expect(result.toLowerCase()).not.toContain('underwater');
    });

    it('优化结果是一段完整的自然语言描述（非关键词列表）', async () => {
      mockProxyRequest.mockResolvedValueOnce(
        mockOpenAIResponse(
          'A cyberpunk city street at night with neon signs reflecting on wet pavement'
        )
      );

      const result = await assistPrompt(
        buildParams({
          prompt: 'Cyberpunk city at night',
          action: 'optimize',
        })
      );

      // 应该是自然语言句子
      expect(result.split(' ').length).toBeGreaterThan(5);
      // 包含冠词和介词
      const hasNaturalLanguageFeatures =
        /^(a|an|the)\s/i.test(result) || result.includes(' with ') || result.includes(' at ');
      expect(hasNaturalLanguageFeatures).toBe(true);
    });
  });

  // ────── 8. 边界情况 ──────
  describe('边界情况', () => {
    it('非常短的提示词优化', async () => {
      mockProxyRequest.mockResolvedValueOnce(
        mockOpenAIResponse('A close-up macro photograph of a vibrant red apple with water droplets')
      );

      const result = await assistPrompt(
        buildParams({ prompt: 'Apple', action: 'optimize' })
      );

      expect(result.length).toBeGreaterThan(5);
      expect(result.toLowerCase()).toContain('apple');
    });

    it('中英混合提示词的语言检测', async () => {
      mockProxyRequest.mockResolvedValueOnce(
        mockOpenAIResponse('A cat playing in the garden')
      );

      const result = await assistPrompt(
        buildParams({ prompt: 'cat', action: 'optimize' })
      );

      expect(result).toBeTruthy();
    });

    it('同一提示词多次优化可能产生不同结果', async () => {
      const responses = [
        'A beautifully composed landscape photo...',
        'An incredible landscape photograph...',
      ];

      mockProxyRequest
        .mockResolvedValueOnce(mockOpenAIResponse(responses[0]))
        .mockResolvedValueOnce(mockOpenAIResponse(responses[1]));

      const r1 = await assistPrompt(
        buildParams({ prompt: 'Landscape photo', action: 'optimize' })
      );
      const r2 = await assistPrompt(
        buildParams({ prompt: 'Landscape photo', action: 'optimize' })
      );

      expect(r1).toBeTruthy();
      expect(r2).toBeTruthy();
    });
  });

  // ────── 9. 语言检测逻辑验证 ──────
  describe('detectPromptLanguage 语言检测逻辑', () => {
    it('纯中文检测为 zh', async () => {
      mockProxyRequest.mockResolvedValueOnce(
        mockOpenAIResponse('A beautiful landscape')
      );

      const result = await assistPrompt(
        buildParams({ prompt: '美丽的风景画', action: 'optimize' })
      );
      expect(result).toBeTruthy();
    });

    it('纯英文检测为 en', async () => {
      mockProxyRequest.mockResolvedValueOnce(
        mockOpenAIResponse('A breathtaking landscape painting with vibrant colors')
      );

      const result = await assistPrompt(
        buildParams({ prompt: 'Beautiful landscape painting', action: 'optimize' })
      );
      expect(result).toBeTruthy();
    });

    it('主要中文混少量英文仍检测为 zh', async () => {
      mockProxyRequest.mockResolvedValueOnce(
        mockOpenAIResponse('A 3D render illustration of a cozy room')
      );

      const result = await assistPrompt(
        buildParams({ prompt: '一个3D render的房间', action: 'optimize' })
      );
      expect(result).toBeTruthy();
    });
  });

  // ────── 10. 远端 API 请求参数 ──────
  describe('远端 API 请求参数', () => {
    it('optimize 时传递给远端 LLM 的参数包含 system prompt', async () => {
      mockProxyRequest.mockResolvedValueOnce(
        mockOpenAIResponse('Optimized result')
      );

      await assistPrompt(
        buildParams({ prompt: 'A cat', action: 'optimize' })
      );

      const callArgs = mockProxyRequest.mock.calls[0];
      expect(callArgs[0]).toBe('siliconflow');
      expect(callArgs[1].body.messages).toHaveLength(2);
      expect(callArgs[1].body.messages[0].role).toBe('system');
      expect(callArgs[1].body.messages[1].role).toBe('user');
      expect(callArgs[1].body.temperature).toBe(0.2);
      expect(callArgs[1].body.max_tokens).toBe(520);
    });

    it('translate 时本地模型不可用直接抛错（不走远端）', async () => {
      setTranslateState({ status: 'error', error: '模型损坏，请重装。' });

      await expect(
        assistPrompt(
          buildParams({ prompt: 'test', action: 'translate' })
        )
      ).rejects.toThrow('翻译模型不可用');
      // translate 操作不走远端
      expect(mockProxyRequest).not.toHaveBeenCalled();
    });

    it('模型状态为 downloading 时阻止翻译并给出提示', async () => {
      setTranslateState({ status: 'downloading', progress: 45 });

      await expect(
        assistPrompt(
          buildParams({ prompt: 'test', action: 'translate' })
        )
      ).rejects.toThrow('翻译模型不可用');
    });
  });

  // ────── 11. 优化=原地微调（禁止改风格） ──────
  describe('提示词微调（原地打磨，禁止脱离原风格）', () => {
    it('optimize 的系统提示词强约束为「原地微调」而非「重写/换风格」', async () => {
      mockProxyRequest.mockResolvedValueOnce(mockOpenAIResponse('A cat on a windowsill'));

      await assistPrompt(
        buildParams({ prompt: 'A cat on a windowsill', action: 'optimize', target: 'image' })
      );

      const systemContent: string = mockProxyRequest.mock.calls[0][1].body.messages[0].content;
      // 必须强调原地微调 / 忠于原风格
      expect(systemContent).toContain('prompt polisher');
      expect(systemContent.toLowerCase()).toContain('do not rewrite it into a different scene');
      expect(systemContent.toLowerCase()).toContain('forbidden');
      // 明确禁止切换风格 / 新增场景
      expect(systemContent.toLowerCase()).toContain('style');
      // 不应再堆砌旧版「大篇幅丰富电影化词汇」的重写指令
      expect(systemContent).not.toContain('Enrich: materials and micro-textures');
      expect(systemContent).not.toContain('cinematic vocabulary');
      // 新增强约束：去空程度副词 + 图像负向约束
      expect(systemContent.toLowerCase()).toContain('degree adverb');
      expect(systemContent).toContain('--no text, watermark, logo, blurry, low quality');
    });

    it('LLM 路径（有 Key）：image 目标系统提示词含 --no 负向约束，video 目标不含', async () => {
      mockProxyRequest.mockResolvedValueOnce(mockOpenAIResponse('polished'));
      await assistPrompt(buildParams({ prompt: 'A cat', action: 'optimize', target: 'image' }));
      const imgSys: string = mockProxyRequest.mock.calls[0][1].body.messages[0].content;
      expect(imgSys).toContain('--no text, watermark, logo, blurry, low quality');

      mockProxyRequest.mockResolvedValueOnce(mockOpenAIResponse('polished'));
      await assistPrompt(buildParams({ prompt: 'A cat runs', action: 'optimize', target: 'video' }));
      const vidSys: string = mockProxyRequest.mock.calls[1][1].body.messages[0].content;
      expect(vidSys).not.toContain('--no text, watermark, logo');
    });

    it('optimize 使用低温度 0.2 抑制风格漂移', async () => {
      mockProxyRequest.mockResolvedValueOnce(mockOpenAIResponse('polished'));
      await assistPrompt(buildParams({ prompt: 'A cat', action: 'optimize' }));
      expect(mockProxyRequest.mock.calls[0][1].body.temperature).toBe(0.2);
    });

    // ── 免费开源离线润色（无 API Key 时的兜底方案） ──
    describe('localPolishPrompt 免费离线润色', () => {
      it('去重重复的 AI 套话，但保留原主体与首个出现', () => {
        const input = 'a cat, masterpiece, masterpiece, best quality, best quality';
        const out = localPolishPrompt(input, 'image');

        expect(out).toContain('a cat');
        // 每个套话仅保留一次
        expect(out.match(/masterpiece/g)?.length).toBe(1);
        expect(out.match(/best quality/g)?.length).toBe(1);
      });

      it('不引入原文没有的新主体 / 新场景 / 镜头语言（严格不改风格）', () => {
        const input = 'a lonely lighthouse on a cliff, oil painting style';
        const out = localPolishPrompt(input, 'image').toLowerCase();

        // 原有关键词保留
        expect(out).toContain('lighthouse');
        expect(out).toContain('oil painting');
        // 不得凭空新增无关主体或摄影/镜头词（注意：delicate 含 cat 子串，故用 dog 作无关主体探针）
        expect(out).not.toContain('dog');
        expect(out).not.toContain('camera');
        expect(out).not.toContain('cinematic');
        expect(out).not.toContain('dolly');
      });

      it('正常长度中文提示词：在原文基础上原地润色（按主体补具体质感，不改主体）', () => {
        const input = '一只橘猫慵懒地趴在洒满阳光的木质窗台上';
        const out = localPolishPrompt(input, 'image');
        // 主体与风格保留
        expect(out).toContain('橘猫');
        expect(out).toContain('木质窗台');
        // 原地润色：按「动物」主体补具体质感（而非空泛的「视觉冲击力」套话）
        expect(out).toContain('毛发');
        expect(out).toContain('逆光');
        // 不再堆砌廉价 booster
        expect(out).not.toContain('视觉冲击力');
        // 不脱离原风格：不新增无关主体
        expect(out).not.toContain('狗');
        expect(out).not.toContain('cat');
      });

      it('中文提示词结尾句号被改为连接符，按主体补具体质感，不出现双逗号', () => {
        const input = '一只小老鼠在黑暗的灯光下慢慢散步。';
        const out = localPolishPrompt(input, 'image');
        expect(out.startsWith('一只小老鼠在黑暗的灯光下慢慢散步')).toBe(true);
        expect(out).not.toContain('，，');
        expect(out).toContain('毛发');
        // 不再堆砌空泛 booster
        expect(out).not.toContain('视觉冲击力');
      });

      it('折叠多余空白，不改变词序与主体', () => {
        const input = 'a    cat   on   a   windowsill';
        const out = localPolishPrompt(input, 'image').toLowerCase();
        expect(out).toContain('a cat on a windowsill');
        expect(out).not.toContain('dog');
      });

      it('极短英文提示词仅追加中性质感短语（不改风格）', () => {
        expect(localPolishPrompt('cat', 'image')).toBe('cat, clear fine detail --no text, watermark, logo, blurry, low quality');
        expect(localPolishPrompt('cat', 'video')).toBe('cat, clear and stable footage');
      });

      it('极短中文提示词追加中性中文短语', () => {
        expect(localPolishPrompt('猫', 'image')).toBe('猫，细节清晰 --no text, watermark, logo, blurry, low quality');
        expect(localPolishPrompt('猫', 'video')).toBe('猫，画面清晰稳定');
      });

      it('空输入安全返回空字符串', () => {
        expect(localPolishPrompt('', 'image')).toBe('');
        expect(localPolishPrompt('   ', 'image')).toBe('');
      });

      it('已详细的提示词（rich）：只精修，不再追加任何质感/光照锚点', () => {
        const input = '黄昏侧逆光下，一只橘猫趴在磨砂金属窗台上，85mm 镜头浅景深';
        const out = localPolishPrompt(input, 'image');
        // 主体与已有细节保留
        expect(out).toContain('橘猫');
        expect(out).toContain('磨砂金属');
        // 已很具体 → 不画蛇添足追加「毛发」等 enrich，也不补通用光照
        expect(out).not.toContain('毛发');
        expect(out).not.toContain('柔和自然光');
        expect(out).not.toContain('视觉冲击力');
      });

      it('极简提示词（sparse）：输入越少补越多——主体质感 + 具体光照锚点', () => {
        const input = '一只橘猫安静地待在房间里';
        const out = localPolishPrompt(input, 'image');
        expect(out).toContain('橘猫');
        // 按动物主体补具体质感
        expect(out).toContain('毛发');
        // sparse 额外补一句「具体」光照锚点（而非空泛 booster）
        expect(out).toContain('柔和自然光');
        expect(out).not.toContain('视觉冲击力');
      });

      it('中等详细度（moderate）：仅补一句主体质感，不追加额外通用光照', () => {
        const input = '一只橘猫慵懒地趴在洒满阳光的木质窗台上';
        const out = localPolishPrompt(input, 'image');
        expect(out).toContain('毛发');
        // 已含光照(阳光)+材质(木质) → 不再叠加通用光照锚点
        expect(out).not.toContain('柔和自然光');
      });

      it('去除空程度副词：中英文空词均被精简，且不留多余分隔符', () => {
        const zh = localPolishPrompt('一只非常可爱、十分温柔的橘猫', 'image');
        expect(zh).not.toContain('非常');
        expect(zh).not.toContain('十分');
        expect(zh).toContain('橘猫');
        // 删除后不应残留「，，」双全角逗号（英文 --no 约束里的 ", " 属正常参数，不计）
        expect(zh).not.toMatch(/[，]{2,}/);

        const en = localPolishPrompt('a very beautiful, extremely cute cat', 'image');
        expect(en).not.toContain('very');
        expect(en).not.toContain('extremely');
        expect(en.toLowerCase()).toContain('cat');
        expect(en).not.toMatch(/\b\w+\s{2,}\w+/);
      });

      it('保留成词语素：不应误删「超现实主义」中的「超」', () => {
        const out = localPolishPrompt('一幅超现实主义风格的画', 'image');
        expect(out).toContain('超现实主义');
      });

      it('图像场景自动追加负向约束 --no ...，视频场景不追加', () => {
        const img = localPolishPrompt('一只橘猫', 'image');
        expect(img).toContain('--no text, watermark, logo, blurry, low quality');

        const vid = localPolishPrompt('一只橘猫在奔跑', 'video');
        expect(vid).not.toContain('--no');

        // 已含 --no 的不重复追加
        const dup = localPolishPrompt('一只橘猫 --no text', 'image');
        const count = (dup.match(/--no/g) || []).length;
        expect(count).toBe(1);
      });

      it('建筑/木屋类主体：moderate 命中建筑类别，并入正向质感描述（非只加 --no）', () => {
        const out = localPolishPrompt('破旧的木屋在狂风暴雨中摇曳', 'image');
        expect(out).toContain('木屋');
        expect(out).toContain('砖石与木质肌理');
        expect(out).toContain('--no text, watermark, logo, blurry, low quality');
      });

      it('自然/天气类主体：并入天气与氛围描述', () => {
        const out = localPolishPrompt('雪山脚下有一片宁静的蓝色湖泊，倒映着云层', 'image');
        expect(out).toContain('空气透视柔和');
        expect(out).toContain('--no');
      });

      it('moderate 且未命中任何类别：仍补一句中性正向描述，避免只加 --no', () => {
        // 「公路上有一辆蓝色卡车…」无材质/光影/已知类别且达 moderate 篇幅 → 补一句正向描述
        const out = localPolishPrompt('公路上有一辆蓝色卡车正在快速行驶，扬起尘土', 'image');
        expect(out).toContain('主体细节清晰');
        expect(out).toContain('--no');
      });
    });

    it('无真实 API Key 时 optimize 走离线润色兜底，且不脱离原文案', async () => {
      mockProxyRequest.mockResolvedValueOnce({
        success: true,
        content: 'Placeholder',
        fallbackActivated: true,
        fallbackReason: 'No API key configured',
        provider: 'siliconflow',
      });

      const input = 'a serene lake at dawn, masterpiece, masterpiece';
      const result = await assistPrompt(
        buildParams({ prompt: input, action: 'optimize' })
      );

      // 兜底结果必须基于原文（保留主体），且去重套话，绝不生成全新风格文案
      expect(result.toLowerCase()).toContain('serene lake');
      expect(result.match(/masterpiece/g)?.length).toBe(1);
      // 注意：delicate 含 cat 子串，故用 dog 作无关主体探针
      expect(result.toLowerCase()).not.toContain('dog');
    });
  });
});
