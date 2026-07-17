export interface AssetFolder {
  id: string;
  name: string;
  parentId: string | null;
  children: string[];
  createdAt: number;
}

export interface AssetImageAnalysis {
  engine: string;
  summary: string;
  subject: string;
  scene: string;
  style: string;
  lighting: string;
  composition: string;
  camera: string;
  mood: string;
  keywords: string[];
  promptZh: string;
  promptEn: string;
  palette?: string[];
  warnings?: string[];
  runtime?: {
    wrapperConfigured?: boolean;
    wrapperCommand?: string;
    recommendedModels?: string[];
    requestedEngine?: string;
    resolvedEngine?: string;
    provider?: string;
    model?: string;
    endpoint?: string;
    fusionEngines?: string[];
  };
  metadata?: Record<string, unknown>;
  analyzedAt: number;
}

export interface AssetItem {
  id: string;
  name: string;
  type: 'image' | 'video' | 'audio' | 'text';
  url: string;
  thumbnail: string;
  folderId: string;
  size: number;
  width?: number;
  height?: number;
  duration?: number;
  tags: string[];
  smartCategories: string[];
  prompt?: string;
  analysis?: AssetImageAnalysis;
  sourceUrl?: string;
  backendAssetId?: string;
  filePath?: string;
  persisted?: boolean;
  storageLabel?: string;
  duplicateOf?: string;
  contentHash?: string;
  source: 'upload' | 'web' | 'crawl' | 'generate';
  createdAt: number;
  updatedAt: number;
}

export interface AssetLibrary {
  folders: AssetFolder[];
  items: AssetItem[];
  selectedFolderId: string | null;
  importTargetFolderId: string;
  selectedItemIds: string[];
  previewItemId: string | null;
  viewMode: 'grid' | 'list';
  sortBy: 'name' | 'date' | 'size';
  searchQuery: string;
  isUploading: boolean;
  isProcessing: boolean;
  storagePath: string;
}

export interface SmartCategory {
  name: string;
  count: number;
  type: 'scene' | 'composition' | 'lighting' | 'model' | 'subject' | 'style' | 'tag';
}

export type SearchPlatform =
  | 'unsplash'
  | 'pexels'
  | 'pixabay'
  | 'huaban'
  | 'youtube'
  | 'pinterest'
  | 'deviantart';

export interface SearchPlatformMeta {
  id: SearchPlatform;
  name: string;
  icon?: string;
  supports: Array<'image' | 'video'>;
  description: string;
  searchUrl?: string;
  isCustom?: boolean;
  color?: string;
}

export type MatchMode = 'similarity' | 'relevance' | 'diversity';
export type TimeRange = 'any' | 'day' | 'week' | 'month' | 'six-months' | 'year';
export type SortOrder = 'relevance' | 'popularity' | 'newest' | 'oldest';
export type SearchMode = 'keyword' | 'reverse-image';

export interface SearchFilters {
  platforms: SearchPlatform[];
  timeRange: TimeRange;
  sortOrder: SortOrder;
  matchMode: MatchMode;
  safeSearch: boolean;
  minWidth?: number;
  minHeight?: number;
  color?: string;
}

export interface WebSearchResult {
  id: string;
  url: string;
  thumb: string;
  previewUrl?: string;
  title: string;
  description?: string;
  source: SearchPlatform;
  sourceName: string;
  type: 'image' | 'video';
  width?: number;
  height?: number;
  duration?: string;
  author?: string;
  license?: string;
  tags: string[];
  uploadDate?: string;
  similarityScore?: number;
}

export interface WebSearchRequest {
  query: string;
  mode: SearchMode;
  imageUrl?: string;
  filters: SearchFilters;
  page?: number;
  perPage?: number;
}

export interface WebSearchResponse {
  results: WebSearchResult[];
  total: number;
  page: number;
  hasMore: boolean;
  query: string;
}

export interface CollectedItem {
  id: string;
  url: string;
  title: string;
  type: 'image' | 'video';
  sourcePlatform: string;
  width?: number;
  height?: number;
  tags: string[];
  collectedAt: number;
}

export const SEARCH_PLATFORMS: SearchPlatformMeta[] = [
  {
    id: 'unsplash',
    name: 'Unsplash',
    supports: ['image'],
    description: '高质量免费摄影图库',
    searchUrl: 'https://unsplash.com/s/photos/{query}',
  },
  {
    id: 'pexels',
    name: 'Pexels',
    supports: ['image', 'video'],
    description: '免费图片与视频素材平台',
    searchUrl: 'https://www.pexels.com/search/{query}/',
  },
  {
    id: 'pixabay',
    name: 'Pixabay',
    supports: ['image', 'video'],
    description: '海量免版权图片与视频',
    searchUrl: 'https://pixabay.com/images/search/{query}/',
  },
  {
    id: 'huaban',
    name: '花瓣',
    supports: ['image'],
    description: '国内灵感采集平台',
    searchUrl: 'https://huaban.com/search/?q={query}',
  },
  {
    id: 'youtube',
    name: 'YouTube',
    supports: ['video'],
    description: '全球视频内容平台',
    searchUrl: 'https://www.youtube.com/results?search_query={query}',
  },
  {
    id: 'pinterest',
    name: 'Pinterest',
    supports: ['image'],
    description: '全球灵感图片平台',
    searchUrl: 'https://www.pinterest.com/search/pins/?q={query}',
  },
  {
    id: 'deviantart',
    name: 'DeviantArt',
    supports: ['image'],
    description: '艺术家社区与视觉参考平台',
    searchUrl: 'https://www.deviantart.com/search?q={query}',
  },
];

export const TIME_RANGE_OPTIONS: Array<{ value: TimeRange; label: string }> = [
  { value: 'any', label: '不限时间' },
  { value: 'day', label: '24 小时内' },
  { value: 'week', label: '一周内' },
  { value: 'month', label: '一个月内' },
  { value: 'six-months', label: '半年内' },
  { value: 'year', label: '一年内' },
];

export const SORT_OPTIONS: Array<{ value: SortOrder; label: string }> = [
  { value: 'relevance', label: '相关度' },
  { value: 'popularity', label: '热度' },
  { value: 'newest', label: '最新' },
  { value: 'oldest', label: '最早' },
];

export const MATCH_MODE_OPTIONS: Array<{ value: MatchMode; label: string; desc: string }> = [
  { value: 'similarity', label: '相似度优先', desc: '优先返回视觉风格更接近的素材' },
  { value: 'relevance', label: '综合匹配', desc: '综合关键词、主题和视觉特征' },
  { value: 'diversity', label: '多样性优先', desc: '优先返回来源和风格更丰富的结果' },
];

export const DEFAULT_SEARCH_FILTERS: SearchFilters = {
  platforms: ['unsplash', 'pexels', 'pixabay'],
  timeRange: 'any',
  sortOrder: 'relevance',
  matchMode: 'relevance',
  safeSearch: true,
};

export function buildPlatformSearchUrl(platform: SearchPlatformMeta, query: string): string {
  if (platform.searchUrl) {
    return platform.searchUrl.replace('{query}', encodeURIComponent(query));
  }
  return `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(query)}+site:${platform.name.toLowerCase()}.com`;
}

export function generateCollectedId(): string {
  return `collected_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/* ===== 增强搜索类型 ===== */

export interface ParsedSearchQuery {
  keywords: string[];
  tags: string[];
  categories: string[];
  types: AssetItemType[];
  exactPhrases: string[];
  excludeTerms: string[];
  operators: ('AND' | 'OR')[];
}

export type AssetItemType = 'image' | 'video' | 'audio' | 'text';

/* ===== 本地相似搜索 ===== */

export interface LocalSimilarResult {
  item: AssetItem;
  score: number;
  matchDetails: {
    tagOverlap: number;
    categoryOverlap: number;
    nameSimilarity: number;
    /** 内容/语义相似度（基于 AI 深度分析的结构化特征：主体/风格/关键词/色调/提示词等），无分析时为 undefined */
    contentSimilarity?: number;
    /** 兼容旧字段：等同 contentSimilarity */
    visualSimilarity?: number;
  };
  /** 该结果主要由哪类特征命中（用于 UI 标记） */
  matchedBy?: 'content' | 'tags' | 'name' | 'mixed';
}

/* ===== AI 深度分析 ===== */

export interface AIDeepAnalysis {
  engine: string;
  provider: string;
  model: string;
  /** 综合描述提示词（可直接用于生成） */
  compositePrompt: string;
  /** 中文提示词 */
  promptZh: string;
  /** 英文提示词 */
  promptEn: string;
  /** 主体描述 */
  subject: string;
  /** 场景 */
  scene: string;
  /** 风格 */
  style: string;
  /** 光影 */
  lighting: string;
  /** 构图 */
  composition: string;
  /** 运镜/视角 */
  camera: string;
  /** 氛围/情绪 */
  mood: string;
  /** 色彩调色板 */
  palette: string[];
  /** 关键词 */
  keywords: string[];
  /** 建议的负面提示词 */
  negativePrompt?: string;
  /** 建议的生成参数 */
  suggestedParams?: {
    aspectRatio?: string;
    quality?: string;
    stylePreset?: string;
  };
  analyzedAt: number;
}

/* ===== AI 推荐模型 ===== */

export interface RecommendedVLMModel {
  id: string;
  name: string;
  provider: string;
  providerName: string;
  description: string;
  strengths: string[];
  free: boolean;
  freeQuota: string;
  setupGuide: string;
  priority: number; // 1=best
}

/* ===== 采集任务 ===== */

export interface CollectionTask {
  id: string;
  sourceUrl: string;
  sourcePlatform: string;
  targetFolderId: string;
  name: string;
  type: 'image' | 'video';
  status: 'pending' | 'downloading' | 'importing' | 'done' | 'failed';
  progress: number;
  tags: string[];
  categories: string[];
  error?: string;
}

/* ===== 免费搜索平台 ===== */

export interface FreeSearchPlatform {
  id: string;
  name: string;
  supports: Array<'image' | 'video'>;
  description: string;
  requiresKey: boolean;
  freeQuota: string;
  baseUrl: string;
  searchUrl?: string;
  color: string;
  enabled: boolean;
}

export const FREE_SEARCH_PLATFORMS: FreeSearchPlatform[] = [
  {
    id: 'unsplash',
    name: 'Unsplash',
    supports: ['image'],
    description: '高质量免费摄影图库，无需注册即可使用',
    requiresKey: false,
    freeQuota: '50次/小时（Demo）',
    baseUrl: 'https://api.unsplash.com',
    searchUrl: 'https://unsplash.com/s/photos/{query}',
    color: '#000000',
    enabled: true,
  },
  {
    id: 'pexels',
    name: 'Pexels',
    supports: ['image', 'video'],
    description: '免费图片与视频素材，注册即用',
    requiresKey: true,
    freeQuota: '200次/小时',
    baseUrl: 'https://api.pexels.com',
    searchUrl: 'https://www.pexels.com/search/{query}/',
    color: '#05a081',
    enabled: true,
  },
  {
    id: 'pixabay',
    name: 'Pixabay',
    supports: ['image', 'video'],
    description: '海量免版权素材，注册即用',
    requiresKey: true,
    freeQuota: '100次/分钟',
    baseUrl: 'https://pixabay.com/api',
    searchUrl: 'https://pixabay.com/images/search/{query}/',
    color: '#2ec66d',
    enabled: true,
  },
  {
    id: 'flickr',
    name: 'Flickr',
    supports: ['image'],
    description: '全球摄影师社区，免费API',
    requiresKey: true,
    freeQuota: '3600次/小时',
    baseUrl: 'https://api.flickr.com/services/rest',
    searchUrl: 'https://www.flickr.com/search/?text={query}&license=cc0',
    color: '#ff0084',
    enabled: false,
  },
  {
    id: 'openverse',
    name: 'Openverse',
    supports: ['image'],
    description: '开源免版权媒体库，完全免费',
    requiresKey: false,
    freeQuota: '无限制',
    baseUrl: 'https://api.openverse.org/v1',
    searchUrl: 'https://openverse.org/search/image?q={query}&license=cc0',
    color: '#ffe033',
    enabled: true,
  },
];

/* ===== AI 分析推荐模型 ===== */

// 深度分析推荐：5 个主流视觉大模型，按实用性与覆盖面排序
export const RECOMMENDED_VLM_MODELS: RecommendedVLMModel[] = [
  {
    id: 'Qwen/Qwen2.5-VL-72B-Instruct',
    name: 'Qwen2.5-VL-72B',
    provider: 'siliconflow',
    providerName: '硅基流动',
    description: '开源最强视觉模型之一，中文理解精准，光影/构图/风格分析全面，硅基流动平台直连',
    strengths: ['中文提示词精度高', '光影构图分析细致', '硅基流动免费额度'],
    free: true,
    freeQuota: '注册即享免费额度',
    setupGuide: '在硅基流动平台获取API Key → 在API管理面板激活',
    priority: 1,
  },
  {
    id: 'qwen3.7-plus',
    name: 'Qwen3.7-Plus',
    provider: 'bailian',
    providerName: '阿里云百炼',
    description: '百炼最新旗舰多模态模型，图片/视频深度分析能力行业领先，中文提示词反推精度最高，新用户免费',
    strengths: ['中文提示词精度最高', '多模态深度分析', '新用户免费额度'],
    free: true,
    freeQuota: '新用户100万Token/月免费额度',
    setupGuide: '在阿里云百炼获取API Key → API管理面板激活百炼LLM（选择Qwen3.7-Plus）',
    priority: 2,
  },
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    provider: 'openai',
    providerName: 'OpenAI',
    description: '综合理解能力最强的多模态模型，英文提示词反推质量最高，风格/氛围描述出色',
    strengths: ['综合理解最全面', '风格/氛围描述出色', '英/中文提示词均衡'],
    free: false,
    freeQuota: '按量付费，通过APIMart等Relay平台可能有免费额度',
    setupGuide: '在OpenAI获取API Key → API管理面板激活OpenAI',
    priority: 3,
  },
  {
    id: 'glm-4v-plus',
    name: 'GLM-4V-Plus',
    provider: 'zhipu',
    providerName: '智谱AI',
    description: '智谱旗舰视觉模型，中文多模态理解能力出色，适合国产替代方案',
    strengths: ['中文理解力强', '国产自主', '价格适中'],
    free: true,
    freeQuota: '新用户赠送免费额度',
    setupGuide: '在智谱开放平台获取API Key → API管理面板激活智谱',
    priority: 4,
  },
  {
    id: 'deepseek-vl2',
    name: 'DeepSeek-VL2',
    provider: 'deepseek',
    providerName: 'DeepSeek',
    description: '性价比极高的开源视觉模型，推理能力强，适合低成本高精度分析',
    strengths: ['推理能力强', '性价比高', '开源可控'],
    free: true,
    freeQuota: '极低按量付费，几乎免费',
    setupGuide: '在DeepSeek平台获取API Key → API管理面板激活DeepSeek',
    priority: 5,
  },
];
