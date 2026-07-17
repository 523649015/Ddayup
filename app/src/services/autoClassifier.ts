/**
 * HMDao 智能自动分类与标签系统
 * - 关键词规则匹配 (层1)
 * - AI 分析结果映射 (层2)
 * - 搜索关键词继承 (层3, 网络素材)
 * - 文件名语义解析 (层4)
 */
import type { AssetItem, AssetImageAnalysis } from '@/types/assets';

/* ===== 扩展分类规则 ===== */

export interface CategoryRule {
  keywords: string[];
  category: string;
  parent?: string;
}

export const ENHANCED_CATEGORY_RULES: CategoryRule[] = [
  // 自然风光
  { keywords: ['landscape', 'mountain', 'forest', 'ocean', 'nature', '风景', '自然', '山水', '森林', '海洋', '沙漠', 'desert', '天空', 'sky', '花卉', 'flower', '季节', 'sunset', '日出', '日落'], category: '自然风光' },
  // 城市建筑
  { keywords: ['city', 'building', 'architecture', 'interior', '城市', '建筑', '室内', '夜景', 'night', '街拍', 'street', '现代建筑', '古建筑', 'skyscraper', '摩天'], category: '城市建筑' },
  // 人物肖像
  { keywords: ['portrait', 'person', 'model', 'people', '人像', '人物', '模特', '单人', '群像', '商务人像', 'fashion model', 'portrait photography'], category: '人物肖像' },
  // 产品商业
  { keywords: ['product', 'commerce', 'electric', 'phone', '产品', '电商', '静物', '电子产品', '美妆', 'beauty product', '食品', 'food product', '珠宝', 'jewelry', '家居', 'home', '展示'], category: '产品商业' },
  // 艺术设计
  { keywords: ['art', 'creative', 'design', '插画', 'illustration', 'UI设计', 'UI design', 'logo', '海报', 'poster', '3D渲染', '3d render', '抽象', 'abstract', '设计', 'graphic design'], category: '艺术设计' },
  // 科技数码
  { keywords: ['tech', 'technology', 'digital', '科技', 'AI生成', 'AI generated', '芯片', 'chip', '数据可视化', 'data visualization', '未来感', 'futuristic', 'cyberpunk', '赛博'], category: '科技数码' },
  // 动物宠物
  { keywords: ['animal', 'pet', 'wildlife', '动物', '宠物', '野生动物', '猫', '狗', 'cat', 'dog', '鸟类', 'bird', '海洋生物', 'marine'], category: '动物宠物' },
  // 美食饮品
  { keywords: ['food', 'drink', 'cafe', 'coffee', '美食', '饮品', '中餐', '西餐', '甜点', 'dessert', '食材', 'ingredient', '餐厅', 'restaurant', '烹饪'], category: '美食饮品' },
  // 运动健身
  { keywords: ['sport', 'fitness', 'game', '运动', '健身', '球类', 'basketball', 'football', '跑步', 'running', '瑜伽', 'yoga', '极限运动', 'extreme'], category: '运动健身' },
  // 抽象纹理
  { keywords: ['texture', 'gradient', 'particle', '纹理', '渐变', '粒子', '几何', 'geometric', '笔刷', 'brush', 'pattern', '图案'], category: '抽象纹理' },
  // 影视动画 (视频)
  { keywords: ['cinema', 'film', 'movie', '电影感', 'cinematic', '动画', 'animation', '特效', 'VFX', '转场', 'transition', 'storyboard', '分镜'], category: '影视动画' },
  // 航拍延时 (视频)
  { keywords: ['aerial', 'drone', 'timelapse', '航拍', '无人机', '延时', '慢动作', 'slow motion', 'hyperlapse'], category: '航拍延时' },
  // 音乐音频
  { keywords: ['music', 'audio', 'BGM', 'sound', '音乐', '音频', '配乐', '音效', 'sound effect', '旁白', 'voiceover'], category: '音乐音频' },
  // 时尚穿搭
  { keywords: ['fashion', 'style', 'clothing', 'beauty', '时尚', '穿搭', '美妆', 'makeup', '服饰', 'accessory'], category: '时尚穿搭' },
  // 教育学术
  { keywords: ['education', 'school', 'learning', 'book', '教育', '学术', '书籍', '知识', 'science', '科学'], category: '教育学术' },
];

/* ===== 从 AI 分析结果提取分类 ===== */

export function classifyFromAnalysis(analysis: AssetImageAnalysis): string[] {
  const searchText = [
    analysis.subject,
    analysis.scene,
    analysis.style,
    analysis.lighting,
    analysis.composition,
    analysis.camera,
    analysis.mood,
    ...(analysis.keywords || []),
  ].join(' ').toLowerCase();

  const matched = ENHANCED_CATEGORY_RULES
    .filter((rule) =>
      rule.keywords.some((kw) => searchText.includes(kw.toLowerCase())),
    )
    .map((rule) => rule.category);

  return [...new Set(matched)].slice(0, 5);
}

/* ===== 从搜索关键词继承分类（网络素材专用） ===== */

export function classifyFromSearchKeywords(searchQuery: string): string[] {
  const q = searchQuery.toLowerCase();
  const matched = ENHANCED_CATEGORY_RULES
    .filter((rule) =>
      rule.keywords.some((kw) => q.includes(kw.toLowerCase())),
    )
    .map((rule) => rule.category);

  return matched.length > 0 ? [...new Set(matched)].slice(0, 4) : ['素材', '网络采集'];
}

/* ===== 文件名语义解析 ===== */

export function parseFileNameSemantics(fileName: string): { tags: string[]; category: string } {
  const name = fileName.replace(/\.[^.]+$/, '');
  const tokens = name
    .split(/[-_\s]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);

  const allText = tokens.join(' ').toLowerCase();
  const matched = ENHANCED_CATEGORY_RULES
    .filter((rule) =>
      rule.keywords.some((kw) => allText.includes(kw.toLowerCase())),
    )
    .map((rule) => rule.category);

  return {
    tags: tokens.slice(0, 5),
    category: matched[0] || '未分类',
  };
}

/* ===== 多层分类流水线 ===== */

export interface AutoClassifyResult {
  categories: string[];
  tags: string[];
  confidence: 'high' | 'medium' | 'low';
  source: 'keyword' | 'ai-analysis' | 'search-inherit' | 'filename' | 'fallback';
}

export function autoClassifyAsset(
  item: AssetItem,
  options?: {
    searchQuery?: string;        // 联网搜索关键词
    aiAnalysis?: AssetImageAnalysis; // AI 分析结果
  },
): AutoClassifyResult {
  const allCategories: string[] = [];
  const allTags: string[] = [...(item.tags || [])];
  let confidence: AutoClassifyResult['confidence'] = 'medium';
  let source: AutoClassifyResult['source'] = 'keyword';

  // 层1: 关键词规则匹配（从现有名称/标签/URL）
  const textForMatch = [item.name, ...(item.tags || []), item.sourceUrl || '', item.url || ''].join(' ');
  const keywordCategories = ENHANCED_CATEGORY_RULES
    .filter((rule) =>
      rule.keywords.some((kw) => textForMatch.toLowerCase().includes(kw.toLowerCase())),
    )
    .map((rule) => rule.category);
  allCategories.push(...keywordCategories);

  // 层2: AI 分析结果分类
  if (options?.aiAnalysis) {
    const aiCategories = classifyFromAnalysis(options.aiAnalysis);
    allCategories.push(...aiCategories);
    allTags.push(...(options.aiAnalysis.keywords || []));
    confidence = 'high';
    source = 'ai-analysis';
  }

  // 层3: 搜索关键词继承（网络素材）
  if (options?.searchQuery && item.source === 'web') {
    const searchCategories = classifyFromSearchKeywords(options.searchQuery);
    allCategories.push(...searchCategories);
    // 搜索关键词本身作为标签
    allTags.push(
      ...options.searchQuery
        .split(/\s+/)
        .filter((w) => w.length >= 2)
        .slice(0, 3),
    );
    if (searchCategories.length > 0) {
      confidence = 'high';
      source = 'search-inherit';
    }
  }

  // 层4: 文件名语义
  const fileNameResult = parseFileNameSemantics(item.name);
  if (fileNameResult.category !== '未分类') {
    allCategories.push(fileNameResult.category);
  }

  // 如果没有匹配到任何分类
  if (allCategories.length === 0) {
    if (item.type === 'image') allCategories.push('素材');
    else if (item.type === 'video') allCategories.push('视频素材');
    else if (item.type === 'audio') allCategories.push('音频');
    else allCategories.push('文档');
    confidence = 'low';
    source = 'fallback';
  }

  // 类型标签
  const typeTag = item.type === 'image' ? '图片' : item.type === 'video' ? '视频' : item.type === 'audio' ? '音频' : '文档';
  if (!allTags.includes(typeTag)) allTags.push(typeTag);

  return {
    categories: [...new Set(allCategories)].slice(0, 6),
    tags: [...new Set(allTags)].slice(0, 12),
    confidence,
    source,
  };
}

/* ===== 批量自动分类 ===== */

export function batchAutoClassify(
  items: AssetItem[],
  options?: {
    searchQuery?: string;
    aiAnalysisMap?: Map<string, AssetImageAnalysis>;
  },
): Map<string, AutoClassifyResult> {
  const results = new Map<string, AutoClassifyResult>();

  for (const item of items) {
    results.set(
      item.id,
      autoClassifyAsset(item, {
        searchQuery: options?.searchQuery,
        aiAnalysis: options?.aiAnalysisMap?.get(item.id),
      }),
    );
  }

  return results;
}
