/**
 * HMDao 免费图片/视频搜索服务
 * 统一经后端代理 /api/search/free-images 请求，避免浏览器 CORS 与限流问题。
 * - 免 Key 入口：Openverse、Wikimedia（开箱即用免费）
 * - 需 Key 入口：Unsplash、Pexels、Pixabay（由后端读取环境变量，用户填 Key 后启用）
 * 适配器模式：新增平台只需在后端 /api/search/free-images 增加 case，前端无需改动。
 */
import type { WebSearchRequest, WebSearchResponse, WebSearchResult, SearchFilters } from '@/types/assets';
import type { FreeSearchPlatform } from '@/types/assets';
import { classifyFromSearchKeywords } from './autoClassifier';

/* ===== 平台元数据（仅描述，真正请求走后端代理） ===== */

export const FREE_PLATFORM_META: Record<string, FreeSearchPlatform> = {
  openverse: {
    id: 'openverse', name: 'Openverse', supports: ['image', 'audio'],
    description: '开源免版权媒体库（图/音频），完全免费', requiresKey: false,
    freeQuota: '无限制', baseUrl: 'https://api.openverse.org/v1', color: '#ffe033', enabled: true,
  },
  wikimedia: {
    id: 'wikimedia', name: 'Wikimedia', supports: ['image'],
    description: '维基共享资源，真正开放免 Key', requiresKey: false,
    freeQuota: '无限制', baseUrl: 'https://commons.wikimedia.org', color: '#000000', enabled: true,
  },
  unsplash: {
    id: 'unsplash', name: 'Unsplash', supports: ['image'],
    description: '高质量免费摄影图库', requiresKey: false,
    freeQuota: '需 Access Key', baseUrl: 'https://api.unsplash.com', color: '#000000', enabled: true,
  },
  pexels: {
    id: 'pexels', name: 'Pexels', supports: ['image', 'video'],
    description: '免费图片与视频素材', requiresKey: true,
    freeQuota: '200次/小时', baseUrl: 'https://api.pexels.com', color: '#05a081', enabled: true,
  },
  pixabay: {
    id: 'pixabay', name: 'Pixabay', supports: ['image', 'video'],
    description: '海量免版权素材', requiresKey: true,
    freeQuota: '100次/分钟', baseUrl: 'https://pixabay.com/api', color: '#2ec66d', enabled: true,
  },
  flickr: {
    id: 'flickr', name: 'Flickr', supports: ['image'],
    description: '全球摄影师社区', requiresKey: true,
    freeQuota: '3600次/小时', baseUrl: 'https://api.flickr.com', color: '#ff0084', enabled: false,
  },
  freesound: {
    id: 'freesound', name: 'Freesound', supports: ['audio'],
    description: 'CC0 音效库，需 API Key（环境变量 HMDAO_FREESOUND_API_KEY）', requiresKey: true,
    freeQuota: '需 API Key', baseUrl: 'https://freesound.org/apiv2', color: '#ff8800', enabled: true,
  },
  polyhaven: {
    id: 'polyhaven', name: 'Poly Haven', supports: ['model'],
    description: '免费 3D 模型/HDRI，完全免 Key', requiresKey: false,
    freeQuota: '无限制', baseUrl: 'https://api.polyhaven.com', color: '#a78bfa', enabled: true,
  },
  sketchfab: {
    id: 'sketchfab', name: 'Sketchfab', supports: ['model'],
    description: '3D 模型库，需 API Key（环境变量 HMDAO_SKETCHFAB_API_KEY）', requiresKey: true,
    freeQuota: '需 API Key', baseUrl: 'https://api.sketchfab.com/v3', color: '#1caad9', enabled: true,
  },
};

export const DEFAULT_FREE_PLATFORMS = ['openverse', 'wikimedia', 'unsplash', 'pexels', 'pixabay'];

/* ===== 服务端代理搜索（统一入口，避免 CORS） ===== */

export async function proxyFreeSearch(
  query: string,
  platform: FreeSearchPlatform,
  page = 1,
  perPage = 24,
  mediaType: 'image' | 'video' | 'audio' | 'model' = 'image',
): Promise<{ results: WebSearchResult[]; total: number }> {
  try {
    const resp = await fetch('/api/search/free-images', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        platform: platform.id,
        page,
        perPage,
        type: mediaType,
      }),
    });

    if (!resp.ok) return { results: [], total: 0 };

    const data = await resp.json();
    return {
      results: (data.results || []) as WebSearchResult[],
      total: data.total || 0,
    };
  } catch {
    return { results: [], total: 0 };
  }
}

/* ===== 统一免费搜索入口 ===== */

export async function freeWebSearch(
  request: WebSearchRequest & { freePlatforms?: string[]; mediaType?: 'image' | 'video' | 'audio' | 'model' },
): Promise<WebSearchResponse> {
  const { query, filters, page = 1, perPage = 24, freePlatforms, mediaType = 'image' } = request;
  const platformsToUse = (freePlatforms && freePlatforms.length ? freePlatforms : DEFAULT_FREE_PLATFORMS)
    .filter((id) => FREE_PLATFORM_META[id]);

  const allResults: WebSearchResult[] = [];

  const searchPromises = platformsToUse.map(async (platformId) => {
    const meta = FREE_PLATFORM_META[platformId];
    try {
      const { results } = await proxyFreeSearch(
        query,
        meta,
        page,
        Math.max(1, Math.ceil(perPage / platformsToUse.length)),
        mediaType,
      );
      allResults.push(...results);
    } catch {
      // 单个平台失败不影响其它平台
    }
  });

  await Promise.allSettled(searchPromises);

  // 去重（按 url）
  const seen = new Set<string>();
  const uniqueResults = allResults.filter((r) => {
    if (!r.url) return false;
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });

  return {
    results: uniqueResults,
    total: uniqueResults.length,
    page,
    hasMore: uniqueResults.length >= perPage,
    query,
  };
}

/* ===== 导入辅助：从网络搜索结果准备资产数据（自动分类） ===== */

export async function prepareFreeImport(
  result: WebSearchResult,
  tags: string[] = [],
): Promise<{
  url: string;
  thumbnail: string;
  name: string;
  type: 'image' | 'video' | 'audio' | 'model';
  source: 'web';
  width?: number;
  height?: number;
  tags: string[];
  smartCategories: string[];
}> {
  const allTags = [...new Set([...result.tags, ...tags])];
  const smartCategories = classifyFromSearchKeywords(
    [result.title, result.description || '', ...allTags].join(' '),
  );

  return {
    url: result.downloadUrl || result.url,
    thumbnail: result.thumb || result.previewUrl || result.url,
    name: result.title || `web_${Date.now()}`,
    type: result.type,
    source: 'web',
    width: result.width,
    height: result.height,
    tags: allTags,
    smartCategories: smartCategories.length > 0 ? smartCategories : ['素材', '网络采集'],
  };
}

export async function scrapeUrl(
  url: string,
  mediaType: 'image' | 'video' | 'audio' | 'model' | 'all' = 'all',
): Promise<{ results: WebSearchResult[]; source: string; error?: string }> {
  try {
    const resp = await fetch('/api/search/scrape-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, mediaType }),
    });
    const data = await resp.json().catch(() => ({} as any));
    return {
      results: (data.results || []) as WebSearchResult[],
      source: data.source || '',
      error: data.success === false ? data.error || '抓取失败' : undefined,
    };
  } catch {
    return { results: [], source: '', error: '请求失败' };
  }
}
