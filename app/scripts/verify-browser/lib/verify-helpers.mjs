// Auto-extracted shared helpers from verify-browser-flow.mjs.
// Zero behavior change. Pure/leaf helpers + their const tables live here.
import { promises as fs } from 'node:fs';
import path from 'node:path';

function parseCliOptions(argv) {
  const args = new Set(argv);
  const headlessEnv = process.env.HMDAO_BROWSER_HEADLESS;
  const headless = args.has('--visible')
    ? false
    : args.has('--headful')
      ? false
      : args.has('--headless')
        ? true
        : headlessEnv
          ? !['0', 'false', 'no'].includes(headlessEnv.toLowerCase())
          : true;

  return {
    headless,
    keepOpen: args.has('--keep-open'),
    uiOnly: args.has('--ui-only'),
    smartAgentOnly: args.has('--smart-agent-only') || ['1', 'true', 'yes'].includes(String(process.env.HMDAO_VERIFY_SMART_AGENT_ONLY || '').trim().toLowerCase()),
    referenceConsistencyOnly: args.has('--reference-consistency-only') || ['1', 'true', 'yes'].includes(String(process.env.HMDAO_VERIFY_REFERENCE_CONSISTENCY_ONLY || '').trim().toLowerCase()),
    assetLibraryOnly: args.has('--asset-library-only') || ['1', 'true', 'yes'].includes(String(process.env.HMDAO_VERIFY_ASSET_LIBRARY_ONLY || '').trim().toLowerCase()),
    audioPanelOnly: args.has('--audio-panel-only') || ['1', 'true', 'yes'].includes(String(process.env.HMDAO_VERIFY_AUDIO_PANEL_ONLY || '').trim().toLowerCase()),
    floatingPanelOnly: args.has('--floating-panel-only') || ['1', 'true', 'yes'].includes(String(process.env.HMDAO_VERIFY_FLOATING_PANEL_ONLY || '').trim().toLowerCase()),
    groupingOnly: args.has('--grouping-only') || ['1', 'true', 'yes'].includes(String(process.env.HMDAO_VERIFY_GROUPING_ONLY || '').trim().toLowerCase()),
    migrationOnly: args.has('--migration-only') || ['1', 'true', 'yes'].includes(String(process.env.HMDAO_VERIFY_MIGRATION_ONLY || '').trim().toLowerCase()),
    videoLocalOnly: args.has('--video-local-only') || ['1', 'true', 'yes'].includes(String(process.env.HMDAO_VERIFY_VIDEO_LOCAL_ONLY || '').trim().toLowerCase()),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message, extra) {
  const prefix = `[verify ${new Date().toISOString()}]`;
  if (extra === undefined) {
    console.log(`${prefix} ${message}`);
    return;
  }
  console.log(`${prefix} ${message}`, extra);
}

function assert(condition, message, extra) {
  if (condition) return;
  throw new Error(extra === undefined ? message : `${message} ${JSON.stringify(extra)}`);
}

function sanitizeFilePart(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '') || 'stage';
}

const MOJIBAKE_MARKERS = [
  '鍙', '鎺', '瑙', '妫', '绾', '閫', '缁', '璇', '鐢', '鎷', '瀵', '鑱', '鍥', '楂', '鍓',
  '闇', '姹', '鏃', '闊', '璁', '閾', '澶', '鎴', '寮', '寰', '澧', '鏂', '璧', '鍔', '鍒',
  '鍚', '鍛', '鍦', '鍧', '鍝', '鍏', '濇', '浼', '闀', '闈', '锛', '銆', '鈥', '€', '�',
];

const TEXTUAL_KEY_HINTS = [
  'text',
  'textcontent',
  'summary',
  'detail',
  'message',
  'content',
  'label',
  'title',
  'reason',
  'description',
  'prompt',
  'header',
  'button',
  'card',
  'panel',
  'runtime',
  'status',
  'hint',
  'note',
  'tooltip',
  'bodypreview',
  'bodytext',
  'pagetext',
  'visibletext',
  'capturedtext',
];

const LONG_TEXT_KEY_HINTS = [
  'text',
  'textcontent',
  'panel',
  'card',
  'button',
  'body',
  'bodytext',
  'content',
  'prompt',
  'preview',
  'pagetext',
  'visibletext',
  'capturedtext',
  'workflowbody',
  'requestbody',
  'bodypreview',
];

const LOW_VALUE_CAPTURE_PATTERNS = [
  /Press enter or space to select a node\.[\s\S]*?escape to cancel\./gi,
  /Press enter or space to select an edge\.[\s\S]*?escape to cancel\./gi,
  /本服务已接入完成备案的 AI 模型[\s\S]*?(服务条款|隐私政策)\S*/g,
];

const UI_DUMP_MARKERS = [
  'DDUp',
  '删除选中',
  '导出 JSON',
  '导入 JSON',
  '音频分离',
  '视频修复',
  '加入 Agent',
  '全部素材',
  '图片素材',
  '视频素材',
  '音频素材',
  '提示词库',
  '联网搜索',
  '素材预览',
  '当前工具：',
  '生成链路',
  '平台 ',
  '上游 ',
  '主图视+',
  '收起++',
  '工作流助理',
  '共享记忆检索',
  '批量重生成',
  '批量重上传',
  '文生视频',
  '图生视频',
  '首尾帧参考生成',
  '上传素材',
  '高级设置',
  '当前模型可被选中',
  '推荐模型：',
  '真实模型出视频',
  '当前结果来自真实生成链路',
];

function isLikelyMojibakeText(value) {
  const text = String(value || '');
  if (!text) return false;
  let markerCount = 0;
  for (const marker of MOJIBAKE_MARKERS) {
    let cursor = 0;
    while (cursor < text.length) {
      const next = text.indexOf(marker, cursor);
      if (next === -1) break;
      markerCount += 1;
      cursor = next + marker.length;
      if (markerCount >= 4) return true;
    }
  }
  return (text.length >= 16 && markerCount >= 2)
    || (text.length >= 80 && markerCount >= 1);
}

function countMarkerHits(text, markers) {
  let hits = 0;
  for (const marker of markers) {
    if (text.includes(marker)) {
      hits += 1;
    }
  }
  return hits;
}

function isLikelyUiDumpText(value, keyHint = '') {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const lowerKey = String(keyHint || '').toLowerCase();
  if (!text || text.length < 120) return false;
  const hits = countMarkerHits(text, UI_DUMP_MARKERS);
  const analysisFieldHits = countMarkerHits(text, ['运行链路：', '主体', '场景', '风格', '光影', '构图', '镜头']);
  if (lowerKey.includes('header') && hits >= 3) return true;
  if (lowerKey.includes('bodypreview') && hits >= 2) return true;
  if (lowerKey.includes('paneltext') && hits >= 2) return true;
  if (lowerKey.includes('analysisstate.text') && analysisFieldHits >= 5) return true;
  if (lowerKey.includes('previewstate.text') && hits >= 1) return true;
  if (lowerKey.includes('reversepromptstate.text') && hits >= 1) return true;
  if (lowerKey.includes('renderstate.text') && hits >= 2) return true;
  if ((lowerKey === 'text' || lowerKey.endsWith('.text')) && hits >= 2) return true;
  if (lowerKey.endsWith('.text') && hits >= 4) return true;
  if (text.includes('素材预览点击预览图可联网搜索相似素材')) return true;
  if (text.includes('工作流助理节点生成节点生成助手')) return true;
  return false;
}

function summarizeUiDumpText(value, keyHint = '') {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const lowerKey = String(keyHint || '').toLowerCase();
  if (!text) return text;
  if (lowerKey.includes('header')) {
    return '[Collapsed UI header. Use screenshots and structured fields.]';
  }
  if (lowerKey.includes('analysisstate.text')) {
    return '[Collapsed analysis text. Use structured fields such as fields and statusText.]';
  }
  if (lowerKey.includes('paneltext')) {
    return '[Collapsed panel text. Use screenshots and structured fields.]';
  }
  if (lowerKey.includes('previewstate.text') || lowerKey.includes('reversepromptstate.text')) {
    return '[Collapsed preview text. Use screenshots and structured fields.]';
  }
  const maxLength = lowerKey.includes('bodypreview') ? 120 : 140;
  return `${text.slice(0, maxLength).trim()}… [Collapsed UI text. Use screenshots and structured fields.]`;
}

function summarizeCollapsedText(keyHint = '') {
  const lowerKey = String(keyHint || '').toLowerCase();
  if (lowerKey.includes('analysisstate.text')) {
    return '[Collapsed analysis text. Use structured fields and screenshots.]';
  }
  if (lowerKey.includes('reversepromptstate.text')) {
    return '[Collapsed reverse-prompt text. Use structured fields and screenshots.]';
  }
  if (lowerKey.includes('previewstate.text')) {
    return '[Collapsed preview text. Use structured fields and screenshots.]';
  }
  if (lowerKey.includes('renderstate.text')) {
    return '[Collapsed render-state text. Use structured fields and screenshots.]';
  }
  if (lowerKey.includes('bodypreview') || lowerKey.includes('bodytext') || lowerKey.includes('pagetext')) {
    return '[Collapsed page text. Use screenshots and structured fields.]';
  }
  if (lowerKey.includes('visibletext') || lowerKey.includes('capturedtext') || lowerKey.includes('paneltext') || lowerKey.includes('debugtext') || lowerKey.includes('capabilitytext') || lowerKey.includes('summarytext')) {
    return '[Collapsed UI text. Use screenshots and structured fields.]';
  }
  return '[Collapsed long text. Use screenshots and structured fields.]';
}

function cleanCapturedText(value, keyHint = '') {
  let text = String(value || '');
  for (const pattern of LOW_VALUE_CAPTURE_PATTERNS) {
    text = text.replace(pattern, ' ');
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return text;
  const lowerKey = String(keyHint || '').toLowerCase();
  const hasAnyMojibakeMarker = MOJIBAKE_MARKERS.some((marker) => text.includes(marker));
  const shouldAlwaysCollapse = [
    'bodypreview',
    'bodytext',
    'pagetext',
    'visibletext',
    'capturedtext',
    'paneltext',
  ].some((token) => lowerKey.includes(token));
  const shouldCollapseStructuredSummary = [
    'debugtext',
    'capabilitytext',
    'summarytext',
    'referencesummarytext',
    'boundarytext',
    'routestatustext',
  ].some((token) => lowerKey.includes(token));
  if (shouldCollapseStructuredSummary) {
    return summarizeCollapsedText(lowerKey);
  }
  if (hasAnyMojibakeMarker && (lowerKey.includes('label') || lowerKey.includes('title'))) {
    return '[Cleaned mojibake label]';
  }
  if (isLikelyMojibakeText(text)) {
    if (lowerKey.includes('label') || lowerKey.includes('title')) {
      return '[Cleaned mojibake label]';
    }
    if (lowerKey.includes('prompt')) {
      return '[Cleaned mojibake prompt. Use UI params and structured fields.]';
    }
    if (
      lowerKey.includes('panel')
      || lowerKey.endsWith('.text')
      || lowerKey.includes('renderstate.text')
      || lowerKey.includes('visibletext')
      || lowerKey.includes('capturedtext')
    ) {
      return '[Cleaned mojibake UI text. Use UI copy and structured fields.]';
    }
    return '[Cleaned mojibake summary. Use UI copy and structured fields.]';
  }
  if (shouldAlwaysCollapse && text.length > 80) {
    return summarizeCollapsedText(lowerKey);
  }
  if (isLikelyUiDumpText(text, lowerKey)) {
    return summarizeUiDumpText(text, lowerKey);
  }
  if (lowerKey.includes('prompt') && text.length > 180) {
    return `${text.slice(0, 140).trim()}… [Collapsed prompt text. Use structured request data.]`;
  }
  const longTextThreshold = lowerKey.includes('bodypreview') ? 120 : 220;
  if (LONG_TEXT_KEY_HINTS.some((token) => lowerKey.includes(token)) && text.length > longTextThreshold) {
    if (shouldAlwaysCollapse) {
      return summarizeCollapsedText(lowerKey);
    }
    const maxLength = lowerKey.includes('header')
        ? 120
        : lowerKey.includes('panel')
          ? 160
          : 220;
    text = `${text.slice(0, maxLength).trim()}… [Collapsed long text. Use screenshots and structured fields.]`;
  }
  return text;
}

function summarizeCapturedUrl(value, keyHint = '') {
  const text = String(value || '').trim();
  if (!text) return text;
  const lowerKey = String(keyHint || '').toLowerCase();
  if (text.startsWith('data:')) {
    const mediaType = text.slice(5, text.indexOf(',') > 5 ? text.indexOf(',') : undefined).split(';')[0] || 'inline';
    return `[内联${mediaType}已截断，共 ${text.length} 字符]`;
  }
  if ((lowerKey.includes('url') || lowerKey.includes('src')) && text.length > 240) {
    return `${text.slice(0, 240).trim()}… [链接已截断]`;
  }
  return text;
}

function sanitizeArtifactPayload(value, keyHint = '') {
  if (typeof value === 'string') {
    const lowerKey = String(keyHint || '').toLowerCase();
    if (lowerKey.includes('url') || lowerKey.includes('src')) {
      return summarizeCapturedUrl(value, lowerKey);
    }
    const shouldCleanText = TEXTUAL_KEY_HINTS.some((token) => lowerKey.includes(token));
    const shouldCleanSuspiciousValue = shouldCleanText || isLikelyMojibakeText(value);
    return shouldCleanSuspiciousValue ? cleanCapturedText(value, lowerKey) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeArtifactPayload(item, `${keyHint}[${index}]`));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        sanitizeArtifactPayload(entry, keyHint ? `${keyHint}.${key}` : key),
      ]),
    );
  }
  return value;
}

async function writeSummaryFile(runDir, summary) {
  await fs.writeFile(
    path.join(runDir, 'summary.json'),
    JSON.stringify(sanitizeArtifactPayload(summary), null, 2),
    'utf8',
  );
}

function isEdgePath(targetPath) {
  return /msedge\.exe$/i.test(targetPath || '');
}

// Fetch/CDP will reject a subset of browser "bad ports", so the visible verifier
// must avoid picking one of them for remote debugging.
const BAD_DEBUG_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]);

function toPowerShellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function normalizeUiOnlyRemoveSubtitleOutput(result) {
  return {
    url: String(result?.outputUrl || ''),
    mimeType: String(result?.mimeType || 'video/webm'),
    width: Number(result?.width || 0),
    height: Number(result?.height || 0),
    duration: Number(result?.duration || 0),
    size: Number(result?.size || 0),
    processingEngine: String(result?.processingEngine || ''),
  };
}

function normalizeUiOnlyHdOutput(result) {
  return {
    url: String(result?.outputUrl || ''),
    mimeType: String(result?.mimeType || 'video/webm'),
    width: Number(result?.width || 0),
    height: Number(result?.height || 0),
    duration: Number(result?.duration || 0),
    size: Number(result?.size || 0),
    processingEngine: String(result?.processingEngine || ''),
  };
}

function normalizeUiOnlyAudioSplitOutput(result) {
  const makeAudio = (prefix = '') => ({
    url: String(result?.[`${prefix}OutputUrl`] || ''),
    mimeType: String(result?.[`${prefix}MimeType`] || 'audio/wav'),
    format: String(result?.[`${prefix}Format`] || 'wav'),
    duration: Number(result?.[`${prefix}Duration`] || 0),
    size: Number(result?.[`${prefix}Size`] || 0),
    sampleRate: Number(result?.[`${prefix}SampleRate`] || 0),
    channels: Number(result?.[`${prefix}Channels`] || 0),
  });
  return {
    processingEngine: String(result?.processingEngine || ''),
    video: {
      url: String(result?.outputUrl || ''),
      mimeType: String(result?.mimeType || 'video/webm'),
      width: Number(result?.width || 0),
      height: Number(result?.height || 0),
      duration: Number(result?.duration || 0),
      size: Number(result?.size || 0),
    },
    audio: makeAudio('audio'),
    vocal: makeAudio('vocal'),
    accompaniment: makeAudio('accompaniment'),
  };
}

export {
  parseCliOptions,
  sleep,
  log,
  assert,
  sanitizeFilePart,
  isLikelyMojibakeText,
  countMarkerHits,
  isLikelyUiDumpText,
  summarizeUiDumpText,
  summarizeCollapsedText,
  cleanCapturedText,
  summarizeCapturedUrl,
  sanitizeArtifactPayload,
  writeSummaryFile,
  isEdgePath,
  toPowerShellLiteral,
  normalizeUiOnlyRemoveSubtitleOutput,
  normalizeUiOnlyHdOutput,
  normalizeUiOnlyAudioSplitOutput,
  BAD_DEBUG_PORTS,
};

export default {
  parseCliOptions,
  sleep,
  log,
  assert,
  sanitizeFilePart,
  isLikelyMojibakeText,
  countMarkerHits,
  isLikelyUiDumpText,
  summarizeUiDumpText,
  summarizeCollapsedText,
  cleanCapturedText,
  summarizeCapturedUrl,
  sanitizeArtifactPayload,
  writeSummaryFile,
  isEdgePath,
  toPowerShellLiteral,
  normalizeUiOnlyRemoveSubtitleOutput,
  normalizeUiOnlyHdOutput,
  normalizeUiOnlyAudioSplitOutput
};
