/**
 * HMDao 模型/Provider 映射 — 按节点类型返回可用模型列表
 *
 * 与 api-config.ts 中的平台配置对应，
 * 通过 proxy.ts 统一代理转发所有第三方 API 请求。
 */

import type { NodeType } from '@/types';

export interface ProviderModel {
  provider: { id: string; name: string };
  models: Array<{
    id: string;
    name: string;
    cost: number;
    currency: 'CNY' | 'USD';
  }>;
}

// ===== 模型映射表 =====

const LLM_MODELS: ProviderModel[] = [
  {
    provider: { id: 'deepseek', name: 'DeepSeek' },
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek-V3', cost: 0.001, currency: 'CNY' },
      { id: 'deepseek-reasoner', name: 'DeepSeek-R1', cost: 0.004, currency: 'CNY' },
    ],
  },
  {
    provider: { id: 'siliconflow', name: '硅基流动' },
    models: [
      { id: 'Qwen/Qwen2.5-7B-Instruct', name: 'Qwen2.5-7B', cost: 0.0005, currency: 'CNY' },
      { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen2.5-72B', cost: 0.004, currency: 'CNY' },
      { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek-V3', cost: 0.001, currency: 'CNY' },
    ],
  },
  {
    provider: { id: 'zhipu', name: '智谱AI' },
    models: [
      { id: 'glm-4-plus', name: 'GLM-4-Plus', cost: 0.05, currency: 'CNY' },
      { id: 'glm-4-flash', name: 'GLM-4-Flash', cost: 0.001, currency: 'CNY' },
    ],
  },
  {
    provider: { id: 'bailian', name: '阿里云百炼' },
    models: [
      { id: 'qwen3.7-plus', name: 'Qwen3.7-Plus（多模态）', cost: 0.008, currency: 'CNY' },
      { id: 'qwen-max', name: 'Qwen-Max', cost: 0.02, currency: 'CNY' },
      { id: 'qwen-plus', name: 'Qwen-Plus', cost: 0.002, currency: 'CNY' },
      { id: 'qwen-turbo', name: 'Qwen-Turbo', cost: 0.0008, currency: 'CNY' },
    ],
  },
  {
    provider: { id: 'minimax', name: 'MiniMax' },
    models: [
      { id: 'abab6.5s-chat', name: 'abab6.5s', cost: 0.005, currency: 'CNY' },
    ],
  },
  {
    provider: { id: 'openai', name: 'OpenAI' },
    models: [
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', cost: 0.00015, currency: 'USD' },
      { id: 'gpt-4o', name: 'GPT-4o', cost: 0.0025, currency: 'USD' },
    ],
  },
];

const IMAGE_MODELS: ProviderModel[] = [
  {
    provider: { id: 'siliconflow', name: '硅基流动' },
    models: [
      { id: 'stabilityai/stable-diffusion-3-5-large', name: 'SD 3.5 Large', cost: 0.08, currency: 'CNY' },
      { id: 'black-forest-labs/FLUX.1-schnell', name: 'FLUX Schnell', cost: 0.04, currency: 'CNY' },
    ],
  },
  {
    provider: { id: 'zhipu', name: '智谱AI' },
    models: [
      { id: 'cogview-3-plus', name: 'CogView-3-Plus', cost: 0.1, currency: 'CNY' },
    ],
  },
  {
    provider: { id: 'bailian', name: '阿里云百炼' },
    models: [
      { id: 'wanx-v1', name: '通义万相', cost: 0.08, currency: 'CNY' },
    ],
  },
  {
    provider: { id: 'volcengine', name: '火山引擎' },
    models: [
      { id: 'doubao-seedream-5.0-pro', name: 'Seedream 5.0 Pro', cost: 0.6, currency: 'CNY' },
      { id: 'doubao-seedream-5.0-lite', name: 'Seedream 5.0 Lite', cost: 0.36, currency: 'CNY' },
      { id: 'doubao-seedream-4.0', name: 'Seedream 4.0', cost: 0.12, currency: 'CNY' },
      { id: 'doubao-seedance-2.0', name: '豆包 Seedance 2.0', cost: 2.8, currency: 'CNY' },
      { id: 'doubao-audio-1.0', name: '豆包 音频生成 1.0', cost: 0.12, currency: 'CNY' },
    ],
  },
  {
    provider: { id: 'fal', name: 'fal.ai' },
    models: [
      { id: 'fal-ai/flux-pro/v1', name: 'FLUX Pro', cost: 0.05, currency: 'USD' },
      { id: 'fal-ai/flux/dev', name: 'FLUX Dev', cost: 0.025, currency: 'USD' },
    ],
  },
  {
    provider: { id: 'replicate', name: 'Replicate' },
    models: [
      { id: 'black-forest-labs/flux-schnell', name: 'FLUX Schnell', cost: 0.003, currency: 'USD' },
    ],
  },
];

const VIDEO_MODELS: ProviderModel[] = [
  {
    provider: { id: 'bailian', name: '阿里云百炼' },
    models: [
      { id: 'happyhorse-11', name: 'HappyHorse 1.1', cost: 1.6, currency: 'CNY' },
      { id: 'bailian-wan22-t2v-plus', name: '百炼 Wan 2.2 文生视频', cost: 1.4, currency: 'CNY' },
      { id: 'bailian-wan22-i2v-plus', name: '百炼 Wan 2.2 图生视频', cost: 1.8, currency: 'CNY' },
    ],
  },
  {
    provider: { id: 'kling', name: '可灵AI' },
    models: [
      { id: 'kling-v1-5', name: 'Kling 1.5', cost: 0.5, currency: 'CNY' },
      { id: 'kling-v1-6', name: 'Kling 1.6', cost: 0.6, currency: 'CNY' },
    ],
  },
  {
    provider: { id: 'fal', name: 'fal.ai' },
    models: [
      { id: 'fal-ai/seedance-v2', name: 'Seedance 2.0', cost: 0.5, currency: 'USD' },
    ],
  },
];

const AUDIO_MODELS: ProviderModel[] = [
  {
    provider: { id: 'minimax', name: 'MiniMax' },
    models: [
      { id: 'speech-2.8-turbo', name: 'Speech 2.8 Turbo', cost: 0.015, currency: 'CNY' },
    ],
  },
];

// ===== 节点类型 → 模型列表映射 =====

const NODE_TYPE_MODEL_MAP: Record<NodeType, ProviderModel[]> = {
  text: LLM_MODELS,
  image: IMAGE_MODELS,
  video: VIDEO_MODELS,
  audio: AUDIO_MODELS,
  post: IMAGE_MODELS,
  storyboard: LLM_MODELS,
  aiapp: LLM_MODELS,
  script: LLM_MODELS,
  threed: IMAGE_MODELS,
  dcc: IMAGE_MODELS,
  region: LLM_MODELS,
};

/** 根据节点类型获取可用模型列表 */
export function getModelsForNodeType(nodeType: NodeType): ProviderModel[] {
  return NODE_TYPE_MODEL_MAP[nodeType] ?? LLM_MODELS;
}

/** 获取所有 LLM 模型 */
export function getLLMModels(): ProviderModel[] {
  return LLM_MODELS;
}

/** 获取所有图像模型 */
export function getImageModels(): ProviderModel[] {
  return IMAGE_MODELS;
}

/** 获取所有视频模型 */
export function getVideoModels(): ProviderModel[] {
  return VIDEO_MODELS;
}

/** 获取所有音频模型 */
export function getAudioModels(): ProviderModel[] {
  return AUDIO_MODELS;
}
