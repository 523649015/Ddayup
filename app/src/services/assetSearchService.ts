/**
 * HMDao 增强本地搜索引擎
 * - 模糊匹配 (Levenshtein)
 * - 拼音搜索 (中文拼音 ↔ 中文)
 * - 布尔搜索语法 (tag: type: category: -排除 "精确")
 * - 搜索范围扩展 (analysis / AI 分析结果)
 * - 相关性排序
 */
import type { AssetItem, ParsedSearchQuery } from '@/types/assets';

/* ===== 解析搜索语法 ===== */

export function parseSearchQuery(raw: string): ParsedSearchQuery {
  const trimmed = raw.trim();
  const result: ParsedSearchQuery = {
    keywords: [],
    tags: [],
    categories: [],
    types: [],
    exactPhrases: [],
    excludeTerms: [],
    operators: [],
  };

  if (!trimmed) return result;

  // 提取精确匹配 "短语"
  const exactRegex = /"([^"]+)"/g;
  let match: RegExpExecArray | null;
  let remaining = trimmed;
  while ((match = exactRegex.exec(trimmed)) !== null) {
    result.exactPhrases.push(match[1].toLowerCase());
    remaining = remaining.replace(match[0], '');
  }

  // 提取过滤语法 tag:xxx  category:xxx  type:xxx
  remaining = remaining.replace(/(tag|category|type):(\S+)/gi, (_m, prefix, value) => {
    const v = value.toLowerCase();
    if (prefix === 'tag') result.tags.push(v);
    else if (prefix === 'category') result.categories.push(v);
    else if (prefix === 'type') {
      if (['image', 'video', 'audio', 'text'].includes(v)) {
        result.types.push(v as AssetItem['type']);
      }
    }
    return '';
  });

  // 提取排除词 -xxx
  remaining = remaining.replace(/-(\S+)/g, (_m, term) => {
    result.excludeTerms.push(term.toLowerCase());
    return '';
  });

  // 剩余作为关键词
  const words = remaining
    .split(/\s+/)
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
  result.keywords.push(...words);

  return result;
}

/* ===== 模糊匹配 ===== */

function levenshteinDistance(a: string, b: string): number {
  const alen = a.length;
  const blen = b.length;
  const matrix: number[][] = [];

  for (let i = 0; i <= alen; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= blen; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= alen; i++) {
    for (let j = 1; j <= blen; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[alen][blen];
}

function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase().trim();
  const t = target.toLowerCase().trim();
  if (!q || !t) return 0;
  if (t.includes(q)) return 1; // 精确包含 → 最高分
  const dist = levenshteinDistance(q, t);
  const maxLen = Math.max(q.length, t.length);
  return 1 - dist / maxLen;
}

/* ===== 拼音匹配（简化版——支持常见中文拼音） ===== */

// 基础拼音映射（常见字）
const PINYIN_MAP: Record<string, string> = {
  '风': 'feng', '景': 'jing', '山': 'shan', '水': 'shui', '海': 'hai',
  '人': 'ren', '物': 'wu', '像': 'xiang', '模': 'mo', '特': 'te',
  '城': 'cheng', '市': 'shi', '建': 'jian', '筑': 'zhu', '夜': 'ye',
  '车': 'che', '产': 'chan', '品': 'pin', '科': 'ke', '技': 'ji',
  '时': 'shi', '尚': 'shang', '美': 'mei', '食': 'shi', '饮': 'yin',
  '动': 'dong', '音': 'yin', '乐': 'yue', '视': 'shi', '频': 'pin',
  '自': 'zi', '然': 'ran', '艺': 'yi', '术': 'shu', '设': 'she',
  '计': 'ji', '旅': 'lv', '行': 'xing', '教': 'jiao', '育': 'yu',
  '商': 'shang', '业': 'ye', '运': 'yun', '宠': 'chong',
  '森': 'sen', '林': 'lin', '洋': 'yang', '沙': 'sha',
  '漠': 'mo', '花': 'hua', '卉': 'hui', '古': 'gu', '室': 'shi',
  '内': 'nei', '街': 'jie', '单': 'dan', '群': 'qun', '生': 'sheng',
  '活': 'huo', '务': 'wu', '电': 'dian', '珠': 'zhu',
  '宝': 'bao', '插': 'cha', '画': 'hua', '报': 'bao',
  '渲': 'xuan', '染': 'ran', '数': 'shu', '据': 'ju', '鸟': 'niao',
  '西': 'xi', '甜': 'tian', '中': 'zhong', '球': 'qiu', '跑': 'pao',
  '瑜': 'yu', '伽': 'jia', '极': 'ji', '限': 'xian',
  '影': 'ying', '效': 'xiao', '延': 'yan', '航': 'hang',
  '粒': 'li', '几': 'ji', '何': 'he', '纹': 'wen', '理': 'li',
  '渐': 'jian', '变': 'bian', '霓': 'ni', '虹': 'hong',
};

function toPinyin(text: string): string {
  let result = '';
  for (const char of text) {
    result += PINYIN_MAP[char] || char;
  }
  return result;
}

function pinyinMatch(query: string, haystack: string): boolean {
  // 如果 query 看起来像拼音（全是字母），用拼音匹配
  if (/^[a-z]+$/i.test(query)) {
    const pinyinHaystack = toPinyin(haystack);
    return pinyinHaystack.includes(query.toLowerCase());
  }
  // 如果 query 含中文，haystack 的拼音能匹配也行
  return haystack.includes(query);
}

/* ===== 构建搜索索引 ===== */

function buildSearchHaystack(item: AssetItem): string[] {
  const parts: string[] = [
    item.name,
    ...(item.tags || []),
    ...(item.smartCategories || []),
    item.prompt || '',
    item.sourceUrl || '',
    item.type,
    item.source || '',
    item.width && item.height ? `${item.width}x${item.height}` : '',
  ];

  // 添加 AI 分析内容
  if (item.analysis) {
    parts.push(
      item.analysis.subject || '',
      item.analysis.scene || '',
      item.analysis.style || '',
      item.analysis.lighting || '',
      item.analysis.composition || '',
      item.analysis.camera || '',
      item.analysis.mood || '',
      item.analysis.promptZh || '',
      item.analysis.promptEn || '',
      item.analysis.summary || '',
      ...(item.analysis.keywords || []),
    );
  }

  return parts.filter((p) => p.trim().length > 0);
}

/* ===== 主搜索函数 ===== */

export interface AssetSearchResult {
  item: AssetItem;
  score: number;
  matchFields: string[];
}

export function enhancedSearch(
  items: AssetItem[],
  rawQuery: string,
  options?: {
    fuzzyThreshold?: number; // 0-1, default 0.4
    maxResults?: number;
  },
): AssetSearchResult[] {
  const { fuzzyThreshold = 0.4, maxResults = 200 } = options || {};
  const parsed = parseSearchQuery(rawQuery);

  if (!rawQuery.trim()) {
    return items.map((item) => ({ item, score: 1, matchFields: [] }));
  }

  const results: AssetSearchResult[] = [];

  for (const item of items) {
    // 类型过滤
    if (parsed.types.length > 0 && !parsed.types.includes(item.type)) continue;

    // 标签过滤
    if (parsed.tags.length > 0) {
      const itemTags = (item.tags || []).map((t) => t.toLowerCase());
      if (!parsed.tags.every((t) => itemTags.some((it) => it.includes(t)))) continue;
    }

    // 分类过滤
    if (parsed.categories.length > 0) {
      const itemCats = (item.smartCategories || []).map((c) => c.toLowerCase());
      if (!parsed.categories.every((c) => itemCats.some((ic) => ic.includes(c)))) continue;
    }

    const haystack = buildSearchHaystack(item);
    const haystackText = haystack.join(' ').toLowerCase();

    // 排除词检查
    if (parsed.excludeTerms.length > 0) {
      if (parsed.excludeTerms.some((term) => haystackText.includes(term))) continue;
    }

    // 精确匹配（加分最高）
    let score = 0;
    const matchFields: string[] = [];

    for (const phrase of parsed.exactPhrases) {
      if (haystackText.includes(phrase)) {
        score += 2;
        matchFields.push(`精确:"${phrase}"`);
      } else {
        score = -1;
        break;
      }
    }
    if (score === -1) continue; // 精确匹配失败则跳过

    // 关键词匹配（模糊+拼音）
    for (const keyword of parsed.keywords) {
      let bestFieldScore = 0;
      let bestField = '';

      for (const field of haystack) {
        const fieldLower = field.toLowerCase();

        // 精确包含
        if (fieldLower.includes(keyword)) {
          if (1 > bestFieldScore) { bestFieldScore = 1; bestField = field.slice(0, 30); }
          continue;
        }

        // 拼音匹配
        if (pinyinMatch(keyword, field)) {
          if (0.9 > bestFieldScore) { bestFieldScore = 0.9; bestField = `拼音:${field.slice(0, 30)}`; }
          continue;
        }

        // 模糊匹配
        const fuzzy = fuzzyScore(keyword, fieldLower);
        if (fuzzy >= fuzzyThreshold && fuzzy > bestFieldScore) {
          bestFieldScore = fuzzy;
          bestField = `模糊:${field.slice(0, 30)}`;
        }
      }

      if (bestFieldScore > 0) {
        score += bestFieldScore;
        matchFields.push(bestField);
      }
    }

    if (score > 0 || parsed.keywords.length === 0) {
      results.push({ item, score, matchFields });
    }
  }

  // 按分数排序
  results.sort((a, b) => b.score - a.score);

  return results.slice(0, maxResults);
}

/* ===== 搜索建议 ===== */

export interface SearchSuggestion {
  type: 'keyword' | 'tag' | 'category' | 'history';
  text: string;
  count: number;
}

export function getSearchSuggestions(
  items: AssetItem[],
  partialQuery: string,
  searchHistory: string[] = [],
  maxSuggestions = 8,
): SearchSuggestion[] {
  const suggestions: SearchSuggestion[] = [];
  const q = partialQuery.toLowerCase().trim();

  // 从搜索历史
  for (const hist of searchHistory.slice(0, 5)) {
    if (hist.toLowerCase().includes(q)) {
      suggestions.push({ type: 'history', text: hist, count: 0 });
    }
  }

  // 从标签
  const tagCounts = new Map<string, number>();
  for (const item of items) {
    for (const tag of item.tags || []) {
      if (tag.toLowerCase().includes(q)) {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
    }
  }
  for (const [tag, count] of [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    suggestions.push({ type: 'tag', text: tag, count });
  }

  // 从分类
  const catCounts = new Map<string, number>();
  for (const item of items) {
    for (const cat of item.smartCategories || []) {
      if (cat.toLowerCase().includes(q)) {
        catCounts.set(cat, (catCounts.get(cat) || 0) + 1);
      }
    }
  }
  for (const [cat, count] of [...catCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
    suggestions.push({ type: 'category', text: cat, count });
  }

  return suggestions.slice(0, maxSuggestions);
}
