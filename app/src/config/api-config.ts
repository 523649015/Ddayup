/**
 * HMDao API configuration.
 *
 * Domestic platforms:
 * - SiliconFlow: LLM + image + video
 * - Volcengine Ark: image
 * - Kling AI: image + video
 * - Bailian: LLM + image + video
 * - Zhipu AI: LLM + image
 * - MiniMax: LLM + audio
 * - DeepSeek: LLM
 * - ModelScope: LLM + image
 *
 * International platforms:
 * - OpenAI: LLM + image
 * - fal.ai: image + video
 * - Replicate: image + video
 */

import { detectFromBrowser, type GeoInfo } from '@/services/geo-service';

export type PlatformType = 'llm' | 'image' | 'video' | 'audio';

export interface PlatformConfig {
  id: string;
  name: string;
  /**
   * 该平台支持的能力列表（与 generation.ts 的 PROVIDER_MODE_SUPPORT 保持对齐）。
   * 取代旧的单值 `type` 字段：单值会丢失多能力信息（如硅基流动同时支持
   * llm/image/video、火山方舟支持 image/video/audio），导致与 mode 体系出现
   * 平行/重复的维度定义。
   */
  modes: PlatformType[];
  domestic: boolean;
  baseUrl: string;
  chatEndpoint?: string;
  imageEndpoint?: string;
  videoEndpoint?: string;
  audioEndpoint?: string;
  defaultTestModel: string;
  testPrompt: string;
}

export interface ApiConfig {
  siliconFlowKey: string;
  volcengineKey: string;
  klingKey: string;
  bailianKey: string;
  zhipuKey: string;
  minimaxKey: string;
  deepseekKey: string;
  modelscopeKey: string;
  openaiKey: string;
  falAiKey: string;
  replicateKey: string;
  platforms: PlatformConfig[];
  baseUrls: Record<string, string>;
}

const config: ApiConfig = {
  siliconFlowKey: import.meta.env.VITE_SILICON_FLOW_KEY || '',
  volcengineKey: import.meta.env.VITE_VOLCENGINE_KEY || '',
  klingKey: import.meta.env.VITE_KLING_KEY || '',
  bailianKey: import.meta.env.VITE_BAILIAN_KEY || '',
  zhipuKey: import.meta.env.VITE_ZHIPU_KEY || '',
  minimaxKey: import.meta.env.VITE_MINIMAX_KEY || '',
  deepseekKey: import.meta.env.VITE_DEEPSEEK_KEY || '',
  modelscopeKey: import.meta.env.VITE_MODELSCOPE_KEY || '',
  openaiKey: import.meta.env.VITE_OPENAI_KEY || '',
  falAiKey: import.meta.env.VITE_FAL_AI_KEY || '',
  replicateKey: import.meta.env.VITE_REPLICATE_KEY || '',

  platforms: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      modes: ['llm'],
      domestic: true,
      baseUrl: 'https://api.deepseek.com/v1',
      chatEndpoint: '/chat/completions',
      defaultTestModel: 'deepseek-chat',
      testPrompt: '你好',
    },
    {
      id: 'siliconflow',
      name: '硅基流动',
      modes: ['llm', 'image', 'video'],
      domestic: true,
      baseUrl: 'https://api.siliconflow.cn/v1',
      chatEndpoint: '/chat/completions',
      imageEndpoint: '/images/generations',
      defaultTestModel: 'Qwen/Qwen2.5-7B-Instruct',
      testPrompt: '你好',
    },
    {
      id: 'zhipu',
      name: '智谱 AI',
      modes: ['llm', 'image', 'video'],
      domestic: true,
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      chatEndpoint: '/chat/completions',
      imageEndpoint: '/images/generations',
      defaultTestModel: 'glm-4-plus',
      testPrompt: '你好',
    },
    {
      id: 'bailian',
      name: '阿里云百炼',
      modes: ['llm', 'image', 'video'],
      domestic: true,
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      chatEndpoint: '/chat/completions',
      imageEndpoint: '/images/generations',
      defaultTestModel: 'qwen-plus',
      testPrompt: '你好',
    },
    {
      id: 'minimax',
      name: 'MiniMax',
      modes: ['llm', 'audio'],
      domestic: true,
      baseUrl: 'https://api.minimax.chat/v1',
      chatEndpoint: '/chat/completions',
      audioEndpoint: '/tts',
      defaultTestModel: 'abab6.5s-chat',
      testPrompt: '你好',
    },
    {
      id: 'volcengine',
      name: '火山方舟',
      modes: ['image', 'video', 'audio'],
      domestic: true,
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      imageEndpoint: '/images/generations',
      defaultTestModel: 'doubao-seedream-5.0-pro',
      testPrompt: '一只猫',
    },
    {
      id: 'kling',
      name: 'Kling AI',
      modes: ['image', 'video'],
      domestic: true,
      baseUrl: 'https://api.klingai.com/v1',
      imageEndpoint: '/images/generations',
      videoEndpoint: '/videos/generations',
      defaultTestModel: 'kling-v1-5',
      testPrompt: '测试',
    },
    {
      id: 'modelscope',
      name: 'ModelScope',
      modes: ['llm', 'image', 'video'],
      domestic: true,
      baseUrl: 'https://api-inference.modelscope.cn/v1',
      chatEndpoint: '/chat/completions',
      imageEndpoint: '/images/generations',
      defaultTestModel: 'Qwen/Qwen2.5-7B-Instruct',
      testPrompt: '你好',
    },
    {
      id: 'openai',
      name: 'OpenAI',
      modes: ['llm', 'image'],
      domestic: false,
      baseUrl: 'https://api.openai.com/v1',
      chatEndpoint: '/chat/completions',
      imageEndpoint: '/images/generations',
      defaultTestModel: 'gpt-4o-mini',
      testPrompt: 'Say "OK"',
    },
    {
      id: 'fal',
      name: 'fal.ai',
      modes: ['image', 'video'],
      domestic: false,
      baseUrl: 'https://fal.run',
      imageEndpoint: '/fal-ai/flux-pro/v1',
      defaultTestModel: 'fal-ai/flux-pro/v1',
      testPrompt: 'a cat',
    },
    {
      id: 'replicate',
      name: 'Replicate',
      modes: ['image', 'video'],
      domestic: false,
      baseUrl: 'https://api.replicate.com/v1',
      imageEndpoint: '/models/black-forest-labs/flux-schnell/predictions',
      defaultTestModel: 'black-forest-labs/flux-schnell',
      testPrompt: 'a cat',
    },
  ],

  baseUrls: {
    siliconFlow: 'https://api.siliconflow.cn/v1',
    siliconFlowGlobal: 'https://api.siliconflow.com/v1',
    volcengine: 'https://ark.cn-beijing.volces.com/api/v3',
    kling: 'https://api.klingai.com/v1',
    bailian: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    zhipu: 'https://open.bigmodel.cn/api/paas/v4',
    minimax: 'https://api.minimax.chat/v1',
    deepseek: 'https://api.deepseek.com/v1',
    modelscope: 'https://api-inference.modelscope.cn/v1',
    openai: 'https://api.openai.com/v1',
    falAi: 'https://fal.run',
    replicate: 'https://api.replicate.com/v1',
  },
};

export function getApiConfig(): ApiConfig {
  return config;
}

export function getPlatformConfig(platformId: string): PlatformConfig | undefined {
  return config.platforms.find((platform) => platform.id === platformId);
}

export function getDomesticPlatforms(): PlatformConfig[] {
  return config.platforms.filter((platform) => platform.domestic);
}

export function getPlatformsByType(type: PlatformType): PlatformConfig[] {
  return config.platforms.filter((platform) => platform.modes.includes(type));
}

let cachedGeo: GeoInfo | null = null;

export function getGeoInfo(): GeoInfo {
  if (!cachedGeo) {
    cachedGeo = detectFromBrowser();
  }
  return cachedGeo;
}

export function refreshGeoInfo(): GeoInfo {
  cachedGeo = detectFromBrowser();
  return cachedGeo;
}

export function getPlatformsForRegion(): PlatformConfig[] {
  const geo = getGeoInfo();
  if (geo.domestic) {
    return [
      ...config.platforms.filter((platform) => platform.domestic),
      ...config.platforms.filter((platform) => !platform.domestic),
    ];
  }

  return [
    ...config.platforms.filter((platform) => !platform.domestic),
    ...config.platforms.filter((platform) => platform.domestic),
  ];
}
