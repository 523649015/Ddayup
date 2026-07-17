/**
 * HMDao 本地相似素材检索服务
 *
 * 相似度由两部分构成：
 *  1) 文本特征：标签 / 智能分类 / 文件名（原有逻辑，保证未做 AI 分析的素材仍可检索）
 *  2) 内容特征：基于 AI 深度分析（P1-1）的结构化字段——主体 / 风格 / 场景 /
 *     关键词 / 色调 / 提示词等，把"看文件名"升级为"看内容"。
 *
 * 当素材做过 AI 深度分析时，内容特征权重提升；两者皆无时回退到纯文本匹配。
 */

import type { AssetItem, AssetImageAnalysis, LocalSimilarResult } from '@/types/assets';

/** 计算两个字符串数组的 Jaccard 重叠度（0~1） */
function overlapRatio(a: string[], b: string[]): number {
  const setA = new Set((a || []).map((x) => String(x).toLowerCase().trim()).filter(Boolean));
  const setB = new Set((b || []).map((x) => String(x).toLowerCase().trim()).filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const v of setA) {
    if (setB.has(v)) inter += 1;
  }
  if (inter === 0) return 0;
  const union = setA.size + setB.size - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * 把一段文本拆成可比较的 token 集合：
 *  - 拉丁词（英文/数字）按词拆分
 *  - 中日韩字符按单字拆分（解决中文无空格问题）
 * 用于 Jaccard 比较主体/风格/场景/提示词等中英文混合字段。
 */
function textTokenSet(text: string): Set<string> {
  const s = String(text || '').toLowerCase();
  const tokens = new Set<string>();
  for (const m of s.match(/[a-z0-9]+/g) || []) tokens.add(m);
  for (const m of s.match(/[㐀-鿿]/g) || []) tokens.add(`cjk:${m}`);
  return tokens;
}

/** 两段文本的 Jaccard 相似度（中英文混合安全） */
function textJaccard(a: string, b: string): number {
  const sa = textTokenSet(a);
  const sb = textTokenSet(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  if (inter === 0) return 0;
  const union = sa.size + sb.size - inter;
  return union > 0 ? inter / union : 0;
}

/** 计算两个名称的字符级相似度（0~1），基于编辑距离 */
function nameSimilarity(a: string, b: string): number {
  const s1 = String(a || '').toLowerCase().trim();
  const s2 = String(b || '').toLowerCase().trim();
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  const m = s1.length;
  const n = s2.length;
  const dp: number[] = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + (s1[i - 1] === s2[j - 1] ? 0 : 1),
      );
      prev = tmp;
    }
  }
  const dist = dp[n];
  const maxLen = Math.max(m, n);
  return maxLen > 0 ? Math.max(0, 1 - dist / maxLen) : 0;
}

/** 基于 AI 深度分析的结构化特征计算内容/语义相似度（0~1） */
function analysisSimilarity(a?: AssetImageAnalysis, b?: AssetImageAnalysis): number | undefined {
  if (!a && !b) return undefined;

  // 任意一方做过分析即可参与比较；未分析字段按空处理（不计入分母）
  const subjectSim = textJaccard(a?.subject || '', b?.subject || '');
  const sceneSim = textJaccard(a?.scene || '', b?.scene || '');
  const styleSim = textJaccard(a?.style || '', b?.style || '');
  const lightingSim = textJaccard(a?.lighting || '', b?.lighting || '');
  const compositionSim = textJaccard(a?.composition || '', b?.composition || '');
  const moodSim = textJaccard(a?.mood || '', b?.mood || '');
  const keywordSim = overlapRatio(a?.keywords || [], b?.keywords || []);
  const paletteSim = overlapRatio(a?.palette || [], b?.palette || []);
  const promptSim = textJaccard(
    a?.promptZh || a?.promptEn || '',
    b?.promptZh || b?.promptEn || '',
  );

  // 权重：主体与关键词最具判别力，其次风格/色调/场景，再次构图/情绪/提示词
  const contentScore =
    subjectSim * 0.26 +
    keywordSim * 0.22 +
    styleSim * 0.15 +
    paletteSim * 0.12 +
    sceneSim * 0.08 +
    lightingSim * 0.06 +
    compositionSim * 0.04 +
    moodSim * 0.04 +
    promptSim * 0.03;

  return Math.min(1, Math.max(0, contentScore));
}

/**
 * 在本地素材库 items 中查找与 targetItem 相似的素材，按分数降序返回最多 maxResults 条。
 */
export function findSimilarAssetsInLibrary(
  targetItem: AssetItem,
  items: AssetItem[],
  maxResults = 8,
): LocalSimilarResult[] {
  if (!targetItem || !Array.isArray(items)) return [];

  const results: LocalSimilarResult[] = [];
  const targetAnalysis = targetItem.analysis;

  for (const item of items) {
    if (!item || item.id === targetItem.id) continue;
    // 只对同类型素材进行相似度匹配
    if (item.type && targetItem.type && item.type !== targetItem.type) continue;

    const tagOverlap = overlapRatio(targetItem.tags, item.tags);
    const categoryOverlap = overlapRatio(targetItem.smartCategories, item.smartCategories);
    const nameSim = nameSimilarity(targetItem.name, item.name);

    // 文本特征分（原有逻辑）
    const textScore = tagOverlap * 0.5 + categoryOverlap * 0.3 + nameSim * 0.2;

    // 内容特征分（P1-2 新增：依赖 AI 深度分析）
    const contentScore = analysisSimilarity(targetAnalysis, item.analysis);
    const hasContent = contentScore !== undefined;

    let score: number;
    let matchedBy: LocalSimilarResult['matchedBy'];
    if (hasContent) {
      // 做过分析的素材：内容特征为主（0.6），文本特征为辅（0.4）
      score = textScore * 0.4 + contentScore * 0.6;
      if (contentScore >= 0.15 && textScore < 0.15) matchedBy = 'content';
      else if (textScore >= 0.15 && contentScore < 0.15) matchedBy = 'tags';
      else if (textScore >= 0.15 && contentScore >= 0.15) matchedBy = 'mixed';
      else matchedBy = contentScore >= textScore ? 'content' : 'tags';
    } else {
      score = textScore;
      if (tagOverlap >= 0.15 || categoryOverlap >= 0.15) matchedBy = 'tags';
      else if (nameSim >= 0.15) matchedBy = 'name';
      else matchedBy = 'tags';
    }

    if (score <= 0) continue;

    results.push({
      item,
      score,
      matchedBy,
      matchDetails: {
        tagOverlap,
        categoryOverlap,
        nameSimilarity: nameSim,
        contentSimilarity: contentScore ?? undefined,
        visualSimilarity: contentScore ?? undefined,
      },
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, Math.max(0, maxResults));
}
