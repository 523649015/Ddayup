// 纯字符串/Shell 工具函数（从主文件 hmdao-api.mjs 抽离，行为零变更）。
// 这些函数无模块级状态依赖，被主文件与 services/* 经 deps 注入复用，
// 集中为单一来源，避免 byokService/assetLibrary 与主文件各自重复定义导致漂移。

/**
 * 从嵌套结构（字符串 / 数组 / 对象）中提取第一个非空字符串。
 * - 字符串：trim 后非空即返回。
 * - 数组：递归首个命中。
 * - 对象：按 content/text/output_text/url/b64_json/message.content 顺序取。
 * @param {*} value
 * @returns {string}
 */
export function extractFirstString(value) {
  if (typeof value === 'string' && value.trim()) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = extractFirstString(item);
      if (nested) return nested;
    }
    return '';
  }
  if (value && typeof value === 'object') {
    return extractFirstString(
      value.content ||
        value.text ||
        value.output_text ||
        value.url ||
        value.b64_json ||
        value.message?.content,
    );
  }
  return '';
}

/**
 * 从文本中按正则提取首个捕获组；无匹配返回空串。
 * 从 dcc/adapters/shared.mjs 单源化（原 extractFirstMatch），行为零变更。
 * @param {string} text
 * @param {RegExp} regex
 * @returns {string}
 */
export function extractFirstMatch(text, regex) {
  const match = String(text || '').match(regex);
  return match?.[1] || '';
}

/**
 * 去重并清洗字符串数组：每项转字符串、trim、过滤空值、保持顺序。
 * @param {Array<*>} values
 * @returns {string[]}
 */
export function uniqueStrings(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)));
}

/**
 * PowerShell 单引号字符串转义：单引号翻倍（''）。
 * @param {*} value
 * @returns {string}
 */
export function escapePowerShellSingleQuoted(value) {
  return String(value || '').replace(/'/g, "''");
}

/**
 * XML 文本转义：& < > " ' 转义为对应实体，防止注入到 SVG/XML 片段时破坏结构。
 * 从主文件 hmdao-api.mjs 单源化（原 dccFrameDataUrl 使用的 escapeXml），行为零变更。
 * @param {*} value
 * @returns {string}
 */
export function escapeXml(value) {
  return String(value || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  }[c]));
}

/**
 * 从文本中提取首个可解析的 JSON 对象：
 * 先尝试整段 / 去 ```json 围栏，再退化为截取首个 { 到末个 } 的子串。
 * 从主文件 hmdao-api.mjs 单源化（原 extractJsonObjectFromText），行为零变更。
 * 常用于解析 LLM 输出的 JSON 片段。
 * @param {string} value
 * @returns {object|null}
 */
export function extractJsonObjectFromText(value = '') {
  const text = String(value || '').trim();
  if (!text) return null;
  const stripped = text.startsWith('```json') ? text.slice(7) : (text.startsWith('```') ? text.slice(3) : text);
  const normalizedStripped = stripped.endsWith('```') ? stripped.slice(0, -3).trim() : stripped.trim();
  const directCandidates = [text, normalizedStripped];
  for (const candidate of directCandidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // try next
    }
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 关键词分类：遍历 [label, tokens[]] 映射，命中任一 token（小写包含）即返回该 label。
 * 从主文件 hmdao-api.mjs 单源化（原 classifyAssetKeyword），行为零变更。
 * @param {string} text
 * @param {Array<[string, string[]]>} map
 * @param {*} fallback
 * @returns {*}
 */
export function classifyAssetKeyword(text, map, fallback) {
  const lowered = String(text || '').toLowerCase();
  for (const [label, tokens] of map) {
    if (tokens.some((token) => lowered.includes(token))) {
      return label;
    }
  }
  return fallback;
}

export default {
  extractFirstString,
  extractFirstMatch,
  uniqueStrings,
  escapePowerShellSingleQuoted,
  escapeXml,
  extractJsonObjectFromText,
  classifyAssetKeyword,
};
