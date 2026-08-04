// 轻量相关性打分（单一职责：无外部依赖的近似语义召回）。
// 通过分词 + 词频重叠打分，足以在本地记忆集合内做 top-k 检索。

function tokenize(text) {
  const lower = String(text || '').toLowerCase();
  const tokens = [];
  // 拉丁字母/数字词整体保留（词级匹配）。
  const latin = lower.match(/[\p{L}\p{N}_]+/gu) || [];
  for (const w of latin) {
    if (w.length > 1) tokens.push(w);
  }
  // CJK 无空格分隔，按单字切分以保证召回（中文检索常见做法）。
  const cjk = lower.match(/[\u3400-\u4dbf\u4e00-\u9fff]/gu) || [];
  for (const c of cjk) tokens.push(c);
  return tokens.filter(Boolean);
}

// 返回 0~1 之间的相关性分数：命中词数 / 查询词数。
export function scoreRelevance(query, text) {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return 0;
  const tTokens = tokenize(text);
  if (tTokens.length === 0) return 0;
  const tFreq = new Map();
  for (const t of tTokens) tFreq.set(t, (tFreq.get(t) || 0) + 1);
  let hits = 0;
  for (const q of qTokens) {
    if (tFreq.has(q)) hits += tFreq.get(q);
  }
  return Math.min(1, hits / qTokens.length);
}
