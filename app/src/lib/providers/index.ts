import type { AIProvider, ProviderId, AIModel } from '@/types';

export const AI_PROVIDERS: AIProvider[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    icon: 'brain',
    supports: ['text', 'image'],
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', cost: 0.01, currency: 'USD', supports: ['text'] },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', cost: 0.002, currency: 'USD', supports: ['text'] },
      { id: 'dall-e-3', name: 'DALL-E 3', cost: 0.04, currency: 'USD', supports: ['image'] },
    ],
  },
  {
    id: 'google',
    name: 'Google',
    icon: 'sparkles',
    supports: ['text', 'image', 'video'],
    models: [
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', cost: 0.005, currency: 'USD', supports: ['text'] },
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', cost: 0.001, currency: 'USD', supports: ['text', 'image'] },
    ],
  },
  {
    id: 'fal',
    name: 'Fal.ai',
    icon: 'zap',
    supports: ['image', 'video', 'audio'],
    models: [
      { id: 'flux-pro', name: '全能图片 G2-官方稳定版', cost: 0.38, currency: 'CNY', supports: ['image'], params: [{ key: 'aspectRatio', label: '比例', type: 'select', default: '1:1', options: [{ label: '1:1', value: '1:1' }, { label: '3:2', value: '3:2' }, { label: '16:9', value: '16:9' }, { label: '9:16', value: '9:16' }] }, { key: 'quality', label: '质量', type: 'select', default: 'standard', options: [{ label: '标准', value: 'standard' }, { label: '高清', value: 'hd' }] }, { key: 'cameraControl', label: '摄影机控制', type: 'toggle', default: false }] },
      { id: 'seedance-v2', name: 'Seedance 2.0', cost: 6, currency: 'CNY', supports: ['video'], params: [{ key: 'aspectRatio', label: '比例', type: 'select', default: '16:9', options: [{ label: '16:9', value: '16:9' }, { label: '9:16', value: '9:16' }, { label: '1:1', value: '1:1' }] }, { key: 'duration', label: '时长', type: 'select', default: '5s', options: [{ label: '5s', value: '5s' }, { label: '10s', value: '10s' }] }, { key: 'quality', label: '分辨率', type: 'select', default: '720p', options: [{ label: '720p', value: '720p' }, { label: '1080p', value: '1080p' }] }] },
    ],
  },
  {
    id: 'replicate',
    name: 'Replicate',
    icon: 'repeat',
    supports: ['image', 'video', 'audio'],
    models: [
      { id: 'flux-schnell', name: 'Flux Schnell', cost: 0.03, currency: 'USD', supports: ['image'] },
      { id: 'wan-2.1', name: 'Wan 2.1', cost: 0.05, currency: 'USD', supports: ['video'] },
    ],
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    icon: 'music',
    supports: ['audio'],
    models: [
      { id: 'speech-2.8-turbo', name: 'MiniMax-Speech-2.8-Turbo', cost: 0.37, currency: 'CNY', supports: ['audio'] },
    ],
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    icon: 'mic',
    supports: ['audio'],
    models: [
      { id: 'eleven-v3', name: 'ElevenLabs v3', cost: 0.02, currency: 'USD', supports: ['audio'] },
    ],
  },
  {
    id: 'volcengine',
    name: '火山方舟',
    icon: 'sparkles',
    supports: ['image', 'video', 'audio'],
    models: [
      { id: 'doubao-seedream-5.0-pro', name: 'Seedream 5.0 Pro', cost: 0.6, currency: 'CNY', supports: ['image'] },
      { id: 'doubao-seedream-5.0-lite', name: 'Seedream 5.0 Lite', cost: 0.36, currency: 'CNY', supports: ['image'] },
      { id: 'doubao-seedance-2.0', name: '豆包 Seedance 2.0', cost: 2.8, currency: 'CNY', supports: ['video'] },
      { id: 'doubao-audio-1.0', name: '豆包 音频生成 1.0', cost: 0.12, currency: 'CNY', supports: ['audio'] },
    ],
  },
];

export function getProviderModels(providerId: ProviderId, supportType?: 'text' | 'image' | 'video' | 'audio'): AIModel[] {
  const provider = AI_PROVIDERS.find((p) => p.id === providerId);
  if (!provider) return [];
  if (!supportType) return provider.models;
  return provider.models.filter((m) => m.supports.includes(supportType));
}

export function getModelsForNodeType(nodeType: string): { provider: AIProvider; models: AIModel[] }[] {
  const typeMap: Record<string, 'text' | 'image' | 'video' | 'audio'> = {
    text: 'text',
    image: 'image',
    video: 'video',
    audio: 'audio',
  };
  const supportType = typeMap[nodeType];
  if (!supportType) return [];

  return AI_PROVIDERS.filter((p) => p.supports.includes(supportType)).map((p) => ({
    provider: p,
    models: p.models.filter((m) => m.supports.includes(supportType)),
  }));
}

export function getDefaultModel(nodeType: string): { provider: ProviderId; model: string } {
  const defaults: Record<string, { provider: ProviderId; model: string }> = {
    text: { provider: 'openai', model: 'gpt-4o' },
    image: { provider: 'fal', model: 'flux-pro' },
    video: { provider: 'fal', model: 'seedance-v2' },
    audio: { provider: 'minimax', model: 'speech-2.8-turbo' },
  };
  return defaults[nodeType] || { provider: 'openai', model: 'gpt-4o' };
}
