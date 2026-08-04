// P1-11 抽取：自 hmdao-api.mjs 原样搬移（零转写），仅追加 export 前缀。
// 依赖常量/工具经既有模块单点导入，ESM 单例语义与原文件一致。
import path from 'node:path';
import { APP_DIR } from './server-paths.mjs';
import { LOCAL_IMAGE_ANALYSIS_BACKEND_WRAPPERS } from './local-post-constants.mjs';
import { applyManagedFlorence2Env, readManagedRuntimeFile, runCommand } from './local-post-processing.mjs';
import { classifyAssetKeyword, uniqueStrings } from './str-utils.mjs';
import { parseStringArrayField } from './parse-utils.mjs';
import { promises as fs } from 'node:fs';

export async function probeAnalyzeImageFile(filePath) {
  const { stdout } = await runCommand('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-of',
    'json',
    filePath,
  ]);
  const parsed = JSON.parse(stdout || '{}');
  return {
    width: Math.max(0, Number(parsed?.streams?.[0]?.width || 0)),
    height: Math.max(0, Number(parsed?.streams?.[0]?.height || 0)),
  };
}

export function inferImageAnalysisFallback(payload) {
  const width = Math.max(0, Number(payload?.width || 0));
  const height = Math.max(0, Number(payload?.height || 0));
  const orientation = width > 0 && height > 0
    ? width > height
      ? 'landscape'
      : width < height
        ? 'portrait'
        : 'square'
    : 'unlabeled';
  const text = [
    String(payload?.name || ''),
    String(payload?.sourceUrl || ''),
    ...parseStringArrayField(payload?.tags),
    ...parseStringArrayField(payload?.smartCategories),
  ].join(' ').toLowerCase();

  const subject = classifyAssetKeyword(text, [
    ['人物主体', ['portrait', 'person', 'people', 'face', 'woman', 'man', '人物', '人像', '模特']],
    ['产品主体', ['product', 'watch', 'phone', 'laptop', 'bag', 'product-shot', '产品', '静物']],
    ['建筑场景', ['building', 'architecture', 'city', 'interior', '建筑', '城市', '室内']],
    ['自然风景', ['landscape', 'mountain', 'forest', 'ocean', 'nature', '风景', '风光', '山水', '自然']],
    ['车辆主体', ['car', 'vehicle', 'auto', '汽车', '车辆']],
  ], '主体待确认');

  const scene = classifyAssetKeyword(text, [
    ['户外真实场景', ['outdoor', 'street', 'travel', 'mountain', 'forest', '风光', '山水', '自然', '户外']],
    ['室内棚拍场景', ['studio', 'indoor', 'interior', 'room', '棚拍', '室内']],
    ['商业产品展示场景', ['product', 'commerce', 'ecommerce', '广告', '海报', '展示']],
    ['城市叙事场景', ['city', 'urban', 'building', 'street', '城市', '街道']],
  ], '场景信息有限');

  const style = classifyAssetKeyword(text, [
    ['电影感写实', ['cinematic', 'film', 'moody', '电影', '叙事']],
    ['商业广告风', ['poster', 'ad', 'campaign', 'commercial', '广告', '海报']],
    ['极简产品风', ['minimal', 'clean', 'product', '极简', '产品']],
    ['写实摄影风', ['photo', 'photography', 'realistic', '写实', '摄影']],
    ['插画概念风', ['illustration', 'concept', 'art', '插画', '概念']],
  ], '写实参考风格');

  const lighting = classifyAssetKeyword(text, [
    ['柔和自然光', ['soft light', 'window', 'daylight', 'natural light', '柔光', '自然光']],
    ['高反差戏剧光', ['dramatic', 'hard light', 'contrast', 'rim', '戏剧', '高反差']],
    ['棚拍商业布光', ['studio', 'beauty light', 'commercial light', '棚拍', '商业布光']],
    ['氛围霓虹光', ['neon', 'cyberpunk', 'night', '霓虹', '夜景']],
  ], '光影信息有限');

  const composition = `${orientation}${width > 0 && height > 0 ? `，分辨率为${width} × ${height}` : ''}`;
  const camera = classifyAssetKeyword(text, [
    ['中近景镜头', ['close', 'portrait', 'mid-shot', '特写', '近景', '人像']],
    ['广角环境镜头', ['wide', 'landscape', 'environment', '全景', '广角', '风景']],
    ['产品特写镜头', ['macro', 'detail', 'product', '特写', '细节', '产品']],
  ], '镜头语言待补充');
  const mood = classifyAssetKeyword(text, [
    ['高级商业风', ['luxury', 'premium', 'commercial', '高级', '商业']],
    ['安静自然风', ['nature', 'soft', 'daylight', '安静', '自然']],
    ['戏剧张力感', ['dramatic', 'contrast', 'night', '张力', '戏剧']],
  ], '氛围信息有限');

  const keywords = uniqueStrings([
    subject,
    scene,
    style,
    lighting,
    camera,
    mood,
    ...parseStringArrayField(payload?.tags),
    ...parseStringArrayField(payload?.smartCategories),
  ]).slice(0, 12);

  return {
    engine: 'local-heuristic-fallback',
    summary: subject + ', ' + scene + ', ' + style + ', ' + lighting + ', ' + camera + '.',
    subject,
    scene,
    style,
    lighting,
    composition,
    camera,
    mood,
    keywords,
    promptZh: 'Keep ' + subject + ' in a ' + composition + ' layout, place it in ' + scene + ', render it with ' + style + ', ' + lighting + ', ' + camera + ', and a ' + mood + ' mood.',
    promptEn: 'Keep the original ' + orientation + ' framing, emphasize ' + subject + ', place it in ' + scene + ', render it in a ' + style + ' look with ' + lighting + ', use ' + camera + ', and preserve a ' + mood + ' mood with clean details for poster-ready image generation.',
    warnings: [
      '当前未接入本地多模态模型，结果由本地启发式链路生成',
      '如需更强解析，建议优先配置 CLIP Interrogator、Florence-2 或 Qwen 视觉的 wrapper',
    ],
    runtime: {
      wrapperConfigured: Boolean(String(process.env.HMDAO_IMAGE_ANALYSIS_COMMAND || '').trim()),
      wrapperCommand: String(process.env.HMDAO_IMAGE_ANALYSIS_COMMAND || '').trim() ? 'custom' : '',
      recommendedModels: ['CLIP Interrogator', 'Florence-2', 'Qwen Vision'],
    },
    metadata: {
      width,
      height,
      orientation,
      sourceKind: payload?.inputPath ? 'upload' : /^https?:\/\//i.test(String(payload?.sourceUrl || '')) ? 'remote-url' : 'unknown',
    },
    analyzedAt: Date.now(),
  };
}

export function normalizeImageAnalysisResult(raw, fallback) {
  // 细粒度字段（颜色/细节/动作/表情/特效）在本地 Florence-2 输出中常缺省，
  // 强制置空避免 String(undefined) 变成 "undefined" 字符串污染前端。
  const NORMALIZE_FINE_FIELDS = ['subjectColors', 'subjectDetails', 'action', 'expression', 'vfx'];
  if (fallback && typeof fallback === 'object') {
    for (const k of NORMALIZE_FINE_FIELDS) {
      if (fallback[k] === undefined) fallback[k] = '';
    }
  }
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    ...fallback,
    engine: String(source.engine || fallback.engine),
    summary: String(source.summary || fallback.summary),
    subject: String(source.subject || fallback.subject),
    subjectColors: String(source.subjectColors || fallback.subjectColors),
    subjectDetails: String(source.subjectDetails || fallback.subjectDetails),
    action: String(source.action || fallback.action),
    expression: String(source.expression || fallback.expression),
    scene: String(source.scene || fallback.scene),
    style: String(source.style || fallback.style),
    lighting: String(source.lighting || fallback.lighting),
    composition: String(source.composition || fallback.composition),
    camera: String(source.camera || fallback.camera),
    vfx: String(source.vfx || fallback.vfx),
    mood: String(source.mood || fallback.mood),
    keywords: uniqueStrings(Array.isArray(source.keywords) ? source.keywords : fallback.keywords).slice(0, 16),
    promptZh: String(source.promptZh || source.prompt_zh || fallback.promptZh),
    promptEn: String(source.promptEn || source.prompt_en || fallback.promptEn),
    palette: uniqueStrings(Array.isArray(source.palette) ? source.palette : fallback.palette || []).slice(0, 8),
    warnings: uniqueStrings(Array.isArray(source.warnings) ? source.warnings : fallback.warnings || []).slice(0, 8),
    rawCaption: String(source.rawCaption || fallback.rawCaption || ''),
    runtime: {
      ...(fallback.runtime || {}),
      ...(source.runtime && typeof source.runtime === 'object' && !Array.isArray(source.runtime) ? source.runtime : {}),
    },
    metadata: {
      ...(fallback.metadata || {}),
      ...(source.metadata && typeof source.metadata === 'object' && !Array.isArray(source.metadata) ? source.metadata : {}),
    },
    analyzedAt: Date.now(),
  };
}

export function getConfiguredImageAnalysisCommands() {
  applyManagedFlorence2Env();
  const genericCommand = String(process.env.HMDAO_IMAGE_ANALYSIS_COMMAND || '').trim();
  return {
    genericCommand,
    clipInterrogator: resolveLocalImageWrapperCommand({
      envCommand: 'HMDAO_CLIP_INTERROGATOR_COMMAND',
      envPath: 'HMDAO_CLIP_INTERROGATOR_PATH',
    }).commandLine || genericCommand,
    florence2: resolveLocalImageWrapperCommand({
      envCommand: 'HMDAO_FLORENCE2_COMMAND',
      envPath: 'HMDAO_FLORENCE2_PATH',
      wrapperKey: 'florence2',
      managedKey: 'florence2',
    }).commandLine || genericCommand,
    qwen35vl: resolveLocalImageWrapperCommand({
      envCommand: 'HMDAO_QWEN35_VL_COMMAND',
      envPath: 'HMDAO_QWEN35_VL_PATH',
      wrapperKey: 'qwen35-vl',
    }).commandLine,
    qwen25vl: resolveLocalImageWrapperCommand({
      envCommand: 'HMDAO_QWEN25_VL_COMMAND',
      envPath: 'HMDAO_QWEN25_VL_PATH',
    }).commandLine,
    customApi: resolveLocalImageWrapperCommand({
      envCommand: 'HMDAO_IMAGE_ANALYSIS_API_COMMAND',
      envPath: 'HMDAO_IMAGE_ANALYSIS_API_PATH',
    }).commandLine,
  };
}

export function buildDirectImageAnalysisCommandFromPath(runtimePath = '') {
  const normalized = String(runtimePath || '').trim();
  if (!normalized) return '';
  const resolvedPath = path.resolve(normalized);
  const shellSafePath = resolvedPath.replace(/\\/g, '/');
  const ext = path.extname(resolvedPath).toLowerCase();
  if (ext === '.py') return 'py -3 "' + shellSafePath + '" --payload {{payloadPath}}';
  if (ext === '.ps1') return 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + shellSafePath + '" --payload {{payloadPath}}';
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'node "' + shellSafePath + '" --payload {{payloadPath}}';
  return '"' + shellSafePath + '" --payload {{payloadPath}}';
}

export function resolveLocalImageWrapperCommand({ envCommand = '', envPath = '', wrapperKey = '', managedKey = '' } = {}) {
  let commandLine = envCommand ? String(process.env[envCommand] || '').trim() : '';
  const detectedPath = (envPath ? String(process.env[envPath] || '').trim() : '')
    || (managedKey ? String(readManagedRuntimeFile(managedKey, 'runtimePath') || '').trim() : '');
  const wrapperScript = wrapperKey ? LOCAL_IMAGE_ANALYSIS_BACKEND_WRAPPERS[wrapperKey] : '';
  if (!commandLine && detectedPath && wrapperScript) {
    const relativeWrapperScript = path.relative(APP_DIR, wrapperScript).replace(/\\/g, '/');
    commandLine = 'node ./' + relativeWrapperScript;
  }
  if (!commandLine && detectedPath && !wrapperScript) {
    commandLine = buildDirectImageAnalysisCommandFromPath(detectedPath);
  }
  return {
    commandLine,
    detectedPath,
  };
}

export function getConfiguredImageAnalysisRuntimes() {
  const commands = getConfiguredImageAnalysisCommands();
  const preferredQwenCommand = String(commands.qwen35vl || commands.qwen25vl || commands.genericCommand || '').trim();
  const configured = [
    { id: 'clip-interrogator', commandLine: commands.clipInterrogator || commands.genericCommand, priority: 10 },
    { id: 'florence2', commandLine: commands.florence2 || commands.genericCommand, priority: 20 },
    { id: 'qwen35-vl', commandLine: preferredQwenCommand, priority: 30 },
    { id: 'custom-api', commandLine: commands.customApi, priority: 40 },
  ]
    .filter((item) => String(item.commandLine || '').trim())
    .sort((left, right) => left.priority - right.priority);
  return configured.filter((item, index, list) => list.findIndex((entry) => entry.id === item.id) === index);
}

// 把分析结果 runtime 转成面向用户的中文标注（"本次分析用了哪个模型"），便于前端展示
export function modelLabelForRuntime(runtime) {
  const r = runtime || {};
  const provider = String(r.provider || '').trim();
  const model = String(r.model || '').trim();
  const resolved = String(r.resolvedEngine || '').trim();
  if (r.mode === 'remote' || (provider && model)) {
    return `云端视觉模型 · ${provider || 'remote'}/${model || resolved || 'remote'}`;
  }
  if (resolved === 'prompt-fusion') {
    const chain = Array.isArray(r.fusionEngines) && r.fusionEngines.length
      ? r.fusionEngines.join('+')
      : 'Florence-2/CLIP';
    return `本地多引擎融合（${chain}）`;
  }
  if (resolved === 'florence2' || /florence/i.test(model || r.wrapperCommand || '')) {
    return '本地 Florence-2 看图（免费）';
  }
  if (resolved === 'local-heuristic' || r.mode === 'fallback') {
    return '本地启发式兜底（无视觉模型）';
  }
  if (resolved) {
    return `本地模型 · ${resolved}`;
  }
  return '本地链路（免费）';
}

export function buildImageAnalysisRemotePrompt(payload = {}) {
  const tags = parseStringArrayField(payload?.tags).slice(0, 12);
  const smartCategories = parseStringArrayField(payload?.smartCategories).slice(0, 12);
  const sizeHint = [
    Number(payload?.width || 0) > 0 ? 'width ' + Number(payload.width) + ' px' : '',
    Number(payload?.height || 0) > 0 ? 'height ' + Number(payload.height) + ' px' : '',
  ].filter(Boolean).join(' x ');
  const nameHint = String(payload?.name || '').trim();
  const isVideoAnalysis = /video[-_]?shot/i.test(nameHint) || tags.some((tag) => /^(shot-\d+|duration:|time:|camera:|shotSize:|angle:|motion:)/i.test(tag));

  if (isVideoAnalysis) {
    const videoLines = [
      'You are analyzing a keyframe from a video shot. Describe the VISUAL CONTENT of this frame with respect to video language.',
      'Return JSON only with these fields: engine, summary, subject, subjectColors, subjectDetails, action, expression, scene, style, lighting, composition, camera, vfx, mood, keywords, promptZh, promptEn, palette.',
      'subject: describe the main subject(s), their appearance, pose, and count.',
      'subjectColors: dominant and accent colors of the main subject(s) — specific hues (e.g. "酒红色丝绒", "哑光黑金属"), not just generic red/black.',
      'subjectDetails: fine-grained visual details — material/texture, clothing, hair, props, markings, pattern, distinguishing features.',
      'action: what the subject is doing — pose, gesture, motion in this frame; write "static/无动作" if at rest.',
      'expression: facial expression and emotional read (smile, gaze, tension, neutral); write "none" when no face/character present.',
      'scene: describe the spatial setting and depth — indoor/outdoor, close/open, focused/wide.',
      'style: the visual style — cinematic/realistic/commercial/flat/abstract, saturation, contrast feel.',
      'lighting: lighting setup — key direction, brightness level, color temperature, contrast profile.',
      'composition: framing and balance — rule of thirds, symmetry, foreground/background relationship.',
      'camera: the likely shot size, camera angle and movement during this shot (use the provided camera/movement hints when present).',
      'vfx: post-production / visual effects in this shot (glow, particles, depth of field, motion blur, composited elements, stylized filters). Write "none" if absent.',
      'mood: emotional tone and atmosphere of this video moment.',
      'promptZh: a concise Chinese generation prompt that preserves subject identity and scene continuity for AI video generation; you may append a recommended model and aspect ratio (e.g. "SDXL, 16:9").',
      'promptEn: English version of promptZh.',
      'keywords and palette must be string arrays.',
      tags.length ? 'Video context hints: ' + tags.join(', ') + '.' : '',
      sizeHint ? 'Frame resolution: ' + sizeHint + '.' : '',
    ].filter(Boolean).join('\n');
    return videoLines;
  }

    return [
    'Analyze this image into structured prompt fields for image or video generation, and return JSON only.',
    'Required JSON fields: engine, summary, subject, subjectColors, subjectDetails, action, expression, scene, style, lighting, composition, camera, vfx, mood, keywords, promptZh, promptEn, palette.',
    'keywords and palette must be string arrays.',
    'subject: main subject(s), count, and their on-screen proportion/position (describe the subject shot first).',
    'subjectColors: dominant and accent colors of the main subject(s) and key objects — name specific hues (e.g. "酒红色丝绒", "哑光黑金属"), not just generic "red/black".',
    'subjectDetails: fine-grained visual details of the subject — material/texture, surface finish, clothing/accessories, hair, props, markings, wear, pattern, and any distinguishing features.',
    'action: what the subject is doing — pose, gesture, motion, interaction with objects or environment; write "static/无动作" if the subject is at rest.',
    'expression: facial expression and emotional read of any person/character (smile, gaze direction, tension, neutral, etc.); write "none" when no face/character is present.',
    'scene: spatial setting and depth — indoor/outdoor, close/open, focused/wide.',
    'style: visual style — cinematic/realistic/commercial/flat/abstract, saturation, contrast feel.',
    'lighting: lighting setup — key direction, brightness level, color temperature, contrast profile.',
    'composition: framing and balance — rule of thirds, symmetry, foreground/background relationship.',
    'camera: shot size (close-up/medium/wide/establishing), lens language (subject shot/over-the-shoulder), camera angle and movement.',
    'vfx: post-production / visual effects (glow, particles, depth of field, motion blur, composited or stylized elements). Write "none" if absent.',
    'mood: emotional tone and atmosphere of the image.',
    'promptZh should be a concise generation prompt that preserves subject identity, subjectColors, subjectDetails, action, expression, style, lighting, composition, camera language, and vfx; you may append a recommended model and aspect ratio (e.g. "SDXL, 16:9" or "混元图像, 3:4").',
    'promptEn should be the English version suitable for image and video generation models.',
    tags.length ? 'Known tags: ' + tags.join(', ') + '.' : '',
    smartCategories.length ? 'Known categories: ' + smartCategories.join(', ') + '.' : '',
    sizeHint ? 'Size reference: ' + sizeHint + '.' : '',
  ].filter(Boolean).join('\n');
}

export async function buildImageDataUrl(inputPath = '', mimeType = 'image/jpeg') {
  const bytes = await fs.readFile(inputPath);
  return `data:${String(mimeType || 'image/jpeg').trim() || 'image/jpeg'};base64,${bytes.toString('base64')}`;
}

export function isMeaningfulImageAnalysisText(value = '') {
  const normalized = String(value || '').trim();
  if (!normalized) return false;
  const lowered = normalized.toLowerCase();
  const placeholders = [
    'main subject',
    'scene context',
    'visual style',
    'lighting mood',
    'composition layout',
    'camera language',
    'overall atmosphere',
    '主体待确认',
    '场景信息有限',
    '写实参考风格',
    '光影信息有限',
    '镜头语言待补充',
    '氛围信息有限',
  ];
  return !placeholders.includes(lowered) && !placeholders.includes(normalized);
}

export function pickPreferredImageAnalysisField(...values) {
  for (const value of values) {
    if (isMeaningfulImageAnalysisText(value)) return String(value).trim();
  }
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized) return normalized;
  }
  return '';
}

export function buildMergedImagePromptZh(fields = {}, fallback = {}) {
  const subject = pickPreferredImageAnalysisField(fields.subject, fallback.subject, '主体');
  const scene = pickPreferredImageAnalysisField(fields.scene, fallback.scene, '场景');
  const style = pickPreferredImageAnalysisField(fields.style, fallback.style, '风格');
  const lighting = pickPreferredImageAnalysisField(fields.lighting, fallback.lighting, '光影');
  const composition = pickPreferredImageAnalysisField(fields.composition, fallback.composition, '原始构图');
  const camera = pickPreferredImageAnalysisField(fields.camera, fallback.camera, '镜头语言');
  const mood = pickPreferredImageAnalysisField(fields.mood, fallback.mood, '整体氛围');
  return 'Preserve ' + composition + ', keep the subject placement centered on ' + subject + ', place it in ' + scene + ', render it with ' + style + ', shape the scene with ' + lighting + ', emphasize ' + camera + ', and maintain a ' + mood + ' atmosphere with stronger detail.';
}

export function buildMergedImagePromptEn(fields = {}, fallback = {}) {
  const subject = pickPreferredImageAnalysisField(fields.subject, fallback.subject, 'main subject');
  const scene = pickPreferredImageAnalysisField(fields.scene, fallback.scene, 'scene');
  const style = pickPreferredImageAnalysisField(fields.style, fallback.style, 'visual style');
  const lighting = pickPreferredImageAnalysisField(fields.lighting, fallback.lighting, 'lighting');
  const composition = pickPreferredImageAnalysisField(fields.composition, fallback.composition, 'original composition');
  const camera = pickPreferredImageAnalysisField(fields.camera, fallback.camera, 'camera language');
  const mood = pickPreferredImageAnalysisField(fields.mood, fallback.mood, 'overall mood');
  return `Preserve the ${composition}, keep the subject placement and framing locked, center the image around ${subject}, place it in ${scene}, render it with ${style}, shape the scene with ${lighting}, emphasize ${camera}, and maintain a ${mood} atmosphere with stronger texture, material, and color detail.`;
}

export function mergeImageAnalysisResults(fallback, results = [], runtime = null) {
  const validResults = results.filter((item) => item && typeof item === 'object');
  if (!validResults.length) return fallback;
  const preferredOrder = ['qwen35-vl', 'qwen2.5-omni', 'qwen25-vl', 'qwen2.5-vl', 'florence2', 'clip-interrogator'];
  const sorted = [...validResults].sort((left, right) => {
    const leftEngine = String(left?.metadata?.resolvedEngine || left?.engine || '').toLowerCase();
    const rightEngine = String(right?.metadata?.resolvedEngine || right?.engine || '').toLowerCase();
    const leftIndex = preferredOrder.findIndex((item) => leftEngine.includes(item));
    const rightIndex = preferredOrder.findIndex((item) => rightEngine.includes(item));
    return (leftIndex === -1 ? 99 : leftIndex) - (rightIndex === -1 ? 99 : rightIndex);
  });
  const detailFirst = sorted[0] || fallback;
  const styleFirst = sorted.find((item) => String(item?.engine || '').toLowerCase().includes('clip-interrogator')) || detailFirst;
  const merged = {
    ...fallback,
    engine: runtime?.resolved === 'prompt-fusion'
      ? `prompt-fusion:${(runtime?.chain || []).join('+') || 'local'}`
      : String(detailFirst.engine || fallback.engine),
    summary: pickPreferredImageAnalysisField(detailFirst.summary, styleFirst.summary, fallback.summary),
    subject: pickPreferredImageAnalysisField(detailFirst.subject, styleFirst.subject, fallback.subject),
    scene: pickPreferredImageAnalysisField(detailFirst.scene, styleFirst.scene, fallback.scene),
    style: pickPreferredImageAnalysisField(styleFirst.style, detailFirst.style, fallback.style),
    lighting: pickPreferredImageAnalysisField(styleFirst.lighting, detailFirst.lighting, fallback.lighting),
    composition: pickPreferredImageAnalysisField(detailFirst.composition, styleFirst.composition, fallback.composition),
    camera: pickPreferredImageAnalysisField(detailFirst.camera, styleFirst.camera, fallback.camera),
    mood: pickPreferredImageAnalysisField(styleFirst.mood, detailFirst.mood, fallback.mood),
    keywords: uniqueStrings([
      ...(Array.isArray(detailFirst.keywords) ? detailFirst.keywords : []),
      ...(Array.isArray(styleFirst.keywords) ? styleFirst.keywords : []),
      ...(Array.isArray(fallback.keywords) ? fallback.keywords : []),
    ]).slice(0, 20),
    palette: uniqueStrings([
      ...(Array.isArray(styleFirst.palette) ? styleFirst.palette : []),
      ...(Array.isArray(detailFirst.palette) ? detailFirst.palette : []),
      ...(Array.isArray(fallback.palette) ? fallback.palette : []),
    ]).slice(0, 8),
    warnings: uniqueStrings([
      ...(Array.isArray(fallback.warnings) ? fallback.warnings : []),
      ...validResults.flatMap((item) => Array.isArray(item?.warnings) ? item.warnings : []),
    ]).slice(0, 12),
    runtime: {
      ...(fallback.runtime || {}),
      wrapperConfigured: true,
      wrapperCommand: runtime?.resolved || 'prompt-fusion',
      requestedEngine: runtime?.requested || fallback?.runtime?.requestedEngine || 'auto',
      resolvedEngine: runtime?.resolved || 'prompt-fusion',
      fusionEngines: Array.isArray(runtime?.chain) ? runtime.chain : [],
      recommendedModels: ['CLIP Interrogator', 'Florence-2', 'Qwen Vision'],
    },
    metadata: {
      ...(fallback.metadata || {}),
      fusionEngines: Array.isArray(runtime?.chain) ? runtime.chain : [],
    },
  };
  merged.promptZh = buildMergedImagePromptZh(merged, fallback);
  merged.promptEn = pickPreferredImageAnalysisField(
    validResults.find((item) => isMeaningfulImageAnalysisText(item?.promptEn))?.promptEn,
    buildMergedImagePromptEn(merged, fallback),
    fallback.promptEn,
  );
  return merged;
}
