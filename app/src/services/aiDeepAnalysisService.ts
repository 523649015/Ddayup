/**
 * HMDao AI 深度分析与提示词反推服务
 * 对接现有 BYOK 视觉大模型，实现：
 * 1. 图片深度分析（光影/风格/主体/构图/运镜）
 * 2. 提示词精准提取
 * 3. 基于提取提示词自动生成相似图片
 */
import type { AIDeepAnalysis, RecommendedVLMModel, RECOMMENDED_VLM_MODELS } from '@/types/assets';
import type { AssetItem } from '@/types/assets';
import { analyzeAssetImage } from './assetImageAnalysis';

/* ===== 获取已激活的视觉模型 ===== */

export async function getActiveVisionModels(): Promise<Array<{
  provider: string;
  model: string;
  available: boolean;
  name: string;
}>> {
  try {
    const resp = await fetch('/api/byok/runtime');
    if (!resp.ok) return [];
    const data = await resp.json();

    const models: Array<{ provider: string; model: string; available: boolean; name: string }> = [];

    // 检查是否有激活的视觉分析模型
    if (data?.selectedImageAnalysisRemote?.provider) {
      models.push({
        provider: data.selectedImageAnalysisRemote.provider,
        model: data.selectedImageAnalysisRemote.model || 'auto',
        available: true,
        name: `${data.selectedImageAnalysisRemote.provider}/${data.selectedImageAnalysisRemote.model || 'vision'}`,
      });
    }

    // 检查 relay 聚合平台
    if (data?.relayStatus?.active) {
      const relay = data.relayStatus;
      models.push({
        provider: relay.provider || 'relay',
        model: relay.visionModel || 'auto',
        available: true,
        name: `${relay.provider || 'Relay'}/${relay.visionModel || 'vision'}`,
      });
    }

    return models;
  } catch {
    return [];
  }
}

/* ===== AI 深度图片分析 ===== */

export async function deepAnalyzeImage(
  item: AssetItem,
  options?: {
    engine?: string;
    provider?: string;
    model?: string;
  },
): Promise<AIDeepAnalysis> {
  // 第一步：使用现有的 analyzeAssetImage 获取基础分析
  // 将用户在面板选择的 provider/model 透传到后端，使"模型选择"真正生效
  const analysis = await analyzeAssetImage({
    item,
    engine: options?.engine || 'auto',
    provider: options?.provider,
    model: options?.model,
  });

  // 第二步：构建深度分析结果
  const deepAnalysis: AIDeepAnalysis = {
    engine: options?.engine || 'auto',
    provider: options?.provider || analysis.runtime?.provider || 'local',
    model: options?.model || analysis.runtime?.resolvedEngine || 'auto',
    compositePrompt: buildCompositePrompt(analysis),
    promptZh: analysis.promptZh || buildChinesePrompt(analysis),
    promptEn: analysis.promptEn || buildEnglishPrompt(analysis),
    subject: analysis.subject || '未识别主体',
    scene: analysis.scene || '未识别场景',
    style: analysis.style || '未识别风格',
    lighting: analysis.lighting || '自然光',
    composition: analysis.composition || '居中构图',
    camera: analysis.camera || '平视视角',
    mood: analysis.mood || '中性氛围',
    palette: analysis.palette || [],
    keywords: analysis.keywords || [],
    suggestedParams: {
      aspectRatio: item.width && item.height
        ? getAspectRatioLabel(item.width, item.height)
        : '16:9',
      quality: 'high',
    },
    analyzedAt: Date.now(),
  };

  return deepAnalysis;
}

/* ===== 构建综合提示词（可直接用于图片生成） ===== */

function buildCompositePrompt(analysis: {
  subject?: string;
  scene?: string;
  style?: string;
  lighting?: string;
  composition?: string;
  camera?: string;
  mood?: string;
  keywords?: string[];
  promptEn?: string;
  promptZh?: string;
}): string {
  const parts: string[] = [];

  // 主体
  if (analysis.subject) parts.push(analysis.subject);
  // 场景
  if (analysis.scene && analysis.scene !== analysis.subject) parts.push(analysis.scene);
  // 风格
  if (analysis.style) parts.push(`${analysis.style} style`);
  // 光影
  if (analysis.lighting) parts.push(`${analysis.lighting} lighting`);
  // 构图
  if (analysis.composition) parts.push(analysis.composition);
  // 运镜
  if (analysis.camera && analysis.camera !== '平视视角') parts.push(`${analysis.camera} view`);
  // 氛围
  if (analysis.mood && analysis.mood !== '中性氛围') parts.push(`${analysis.mood} atmosphere`);
  // 关键词
  if (analysis.keywords?.length) {
    parts.push(analysis.keywords.slice(0, 5).join(', '));
  }

  if (parts.length === 0 && analysis.promptEn) {
    return analysis.promptEn;
  }

  return parts.join(', ');
}

function buildChinesePrompt(analysis: {
  subject?: string;
  scene?: string;
  style?: string;
  lighting?: string;
  composition?: string;
  camera?: string;
  mood?: string;
  keywords?: string[];
  promptZh?: string;
}): string {
  if (analysis.promptZh) return analysis.promptZh;

  const parts: string[] = [];
  if (analysis.subject) parts.push(analysis.subject);
  if (analysis.scene) parts.push(`场景：${analysis.scene}`);
  if (analysis.style) parts.push(`风格：${analysis.style}`);
  if (analysis.lighting) parts.push(`光线：${analysis.lighting}`);
  if (analysis.composition) parts.push(`构图：${analysis.composition}`);
  if (analysis.camera) parts.push(`视角：${analysis.camera}`);
  if (analysis.mood) parts.push(`氛围：${analysis.mood}`);
  if (analysis.keywords?.length) parts.push(analysis.keywords.slice(0, 5).join('、'));

  return parts.length > 0 ? parts.join('，') : '高质量图片';
}

function buildEnglishPrompt(analysis: {
  subject?: string;
  scene?: string;
  style?: string;
  lighting?: string;
  composition?: string;
  camera?: string;
  mood?: string;
  keywords?: string[];
  promptEn?: string;
}): string {
  if (analysis.promptEn) return analysis.promptEn;
  return buildCompositePrompt(analysis);
}

function getAspectRatioLabel(width: number, height: number): string {
  const ratio = width / height;
  if (ratio > 1.7) return '16:9';
  if (ratio > 1.3) return '4:3';
  if (ratio > 0.9) return '1:1';
  if (ratio > 0.6) return '3:4';
  return '9:16';
}

/* ===== 基于分析结果生成相似图片 ===== */

/**
 * 基于分析结果生成相似图片。
 * 采用 Pollinations（开源文生图，免 Key、免 CORS）：直接构造图片 URL 即可出图，
 * 可将反推提示词拼进 URL，seed 不同即产出不同变体。
 * 生成结果可直接作为 <img src> 展示；导入资产库时经后端 /api/assets/import 下载落盘。
 */
const POLLINATIONS_ENDPOINT = 'https://image.pollinations.ai/prompt';

export function buildPollinationsUrl(
  prompt: string,
  options?: { width?: number; height?: number; seed?: number; model?: string },
): string {
  const width = options?.width || 1024;
  const height = options?.height || 1024;
  const seed = options?.seed ?? randomSeed();
  const model = options?.model || 'flux';
  const params = new URLSearchParams({
    width: String(width),
    height: String(height),
    seed: String(seed),
    model,
    nologo: 'true',
    enhance: 'true',
  });
  return `${POLLINATIONS_ENDPOINT}/${encodeURIComponent(prompt)}?${params.toString()}`;
}

/** 使用 crypto 生成加密强度随机种子，避免跨次重生成撞种子 */
export function randomSeed(): number {
  try {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] % 1_000_000;
  } catch {
    return Math.floor(Math.random() * 1_000_000);
  }
}

export async function generateSimilarImage(
  analysis: AIDeepAnalysis,
  _referenceImageUrl?: string,
  options?: {
    provider?: string;
    model?: string;
    width?: number;
    height?: number;
    seed?: number;
  },
): Promise<{ success: boolean; imageUrl?: string; prompt: string; error?: string }> {
  const prompt = analysis.compositePrompt || analysis.promptEn || analysis.promptZh;
  if (!prompt || !prompt.trim()) {
    return { success: false, prompt: prompt || '', error: '缺少可用于生成的提示词' };
  }
  try {
    const imageUrl = buildPollinationsUrl(prompt, {
      width: options?.width || 1024,
      height: options?.height || 1024,
      seed: options?.seed ?? randomSeed(),
    });
    return { success: true, imageUrl, prompt };
  } catch (error) {
    return {
      success: false,
      prompt,
      error: error instanceof Error ? error.message : '生成请求失败',
    };
  }
}

/* ===== 批量生成相似图片变体 ===== */

export async function generateSimilarVariants(
  analysis: AIDeepAnalysis,
  variantCount = 4,
  referenceImageUrl?: string,
): Promise<Array<{ success: boolean; imageUrl?: string; prompt: string; error?: string; seed: number }>> {
  const variants: Array<{ success: boolean; imageUrl?: string; prompt: string; error?: string; seed: number }> = [];

  // 生成多个变体（修改 seed / 微调 prompt）
  const variationPrompts = buildVariationPrompts(analysis, variantCount);

  // 依据分析建议的宽高比推导尺寸，每个变体使用独立随机种子以产出差异化结果
  const { width, height } = resolveVariantSize(analysis);
  const results = await Promise.allSettled(
    variationPrompts.map((variantPrompt) =>
      generateSimilarImage(
        { ...analysis, compositePrompt: variantPrompt },
        referenceImageUrl,
        { width, height, seed: randomSeed() },
      ),
    ),
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      const value = result.value;
      variants.push({ ...value, seed: 0 });
    } else {
      variants.push({
        success: false,
        prompt: '',
        error: result.reason?.message || '生成失败',
        seed: 0,
      });
    }
  }

  return variants;
}

/**
 * 加载单张变体图片：若偶发 503 / 网络错误，自动换种子重试一次（避免空白）。
 * 返回最终可加载的 URL（重试时种子不同）。
 */
export async function loadVariantImageWithRetry(
  imageUrl: string,
  retries = 1,
): Promise<{ ok: boolean; url: string; error?: string }> {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000);
      const response = await fetch(imageUrl, { signal: controller.signal, method: 'GET', cache: 'no-store' });
      clearTimeout(timeoutId);
      if (response.ok) {
        return { ok: true, url: imageUrl };
      }
      // 5xx（含 503）或 429：换种子重试
      if ((response.status >= 500 || response.status === 429) && attempt < retries) {
        imageUrl = imageUrl.replace(/([?&])seed=\d+/, `$1seed=${randomSeed()}`);
        continue;
      }
      return { ok: false, url: imageUrl, error: `HTTP ${response.status}` };
    } catch {
      if (attempt < retries) {
        imageUrl = imageUrl.replace(/([?&])seed=\d+/, `$1seed=${randomSeed()}`);
        continue;
      }
      return { ok: false, url: imageUrl, error: '网络错误' };
    }
  }
  return { ok: false, url: imageUrl, error: '重试后仍失败' };
}

/** 依据分析建议的宽高比推导生成尺寸（长边约 1024） */
function resolveVariantSize(analysis: AIDeepAnalysis): { width: number; height: number } {
  const ratio = analysis.suggestedParams?.aspectRatio || '1:1';
  const map: Record<string, { width: number; height: number }> = {
    '16:9': { width: 1280, height: 720 },
    '4:3': { width: 1024, height: 768 },
    '1:1': { width: 1024, height: 1024 },
    '3:4': { width: 768, height: 1024 },
    '9:16': { width: 720, height: 1280 },
  };
  return map[ratio] || { width: 1024, height: 1024 };
}

function buildVariationPrompts(analysis: AIDeepAnalysis, count: number): string[] {
  const base = analysis.compositePrompt;
  const variations = [
    `${base}, detailed close-up`,
    `${base}, wide angle shot`,
    `${base}, different lighting, dramatic shadows`,
    `${base}, alternative color palette, complementary colors`,
    `${base}, artistic interpretation`,
    `${base}, photorealistic, 8k detailed`,
    `${base}, minimalist composition`,
    `${base}, cinematic depth of field`,
  ];

  return variations.slice(0, count);
}
