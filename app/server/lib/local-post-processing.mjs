// P1-10 抽取：local-post 处理/运行时检测纯函数簇（自 hmdao-api.mjs 原样搬移）。
// 常量经 lib/local-post-constants.mjs / lib/server-paths.mjs 单点导入，ESM 单例语义与原文件一致。
import path from 'node:path';
import { existsSync, mkdirSync, promises as fs, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { EXECUTABLE_DETECTION_CACHE, LOCAL_POST_BACKEND_WRAPPERS, LOCAL_POST_MANAGED_RUNTIME_DIR, LOCAL_POST_MANAGED_RUNTIME_MANIFEST_FILE, LOCAL_POST_RUNTIME_GUIDES, LOCAL_POST_RUNTIME_INSTALL_JOBS, LOCAL_POST_RUNTIME_INSTALL_JOBS_BY_KEY, LOCAL_POST_RUNTIME_INSTALL_MAX_HISTORY } from './local-post-constants.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { APP_DIR } from './server-paths.mjs';
import { buildManagedRuntimePaths, pruneOldBakBackups } from '../runtime-rollback.mjs';
import { buildPlatformInfo, platformExecutableCandidates } from '../platform-utils.mjs';
import { unzipSync } from 'fflate';

export async function runCommand(command, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = stderr.trim().split(/\r?\n/).slice(-8).join(' | ');
      reject(new Error(`${command} exited ${code}: ${detail || 'unknown-error'}`));
    });
  });
}

export function clampNumber(value, min, max, fallback) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(min, Math.min(max, next));
}

export async function detectSceneCuts(filePath, threshold = 0.24, maxCount = 10) {
  try {
    const { stderr } = await runCommand('ffmpeg', [
      '-hide_banner',
      '-i',
      filePath,
      '-filter:v',
      `select='gt(scene,${threshold})',showinfo`,
      '-vsync',
      'vfr',
      '-f',
      'null',
      '-',
    ]);
    const matches = [...String(stderr || '').matchAll(/pts_time:([0-9.]+)/g)];
    const values = matches
      .map((match) => Number(match[1]))
      .filter((value) => Number.isFinite(value) && value >= 0);
    return [...new Set(values.map((value) => Number(value.toFixed(3))))].slice(0, maxCount);
  } catch {
    return [];
  }
}

export function buildParseSummary(sceneCuts, meta, sampleFps) {
  const sceneCount = sceneCuts.length + 1;
  const summaryParts = [
    `分辨率${meta.width}x${meta.height}`,
    `时长 ${meta.duration.toFixed(2)}s`,
    `抽样 ${sampleFps}fps`,
    sceneCuts.length > 0 ? 'Detected ' + sceneCuts.length + ' cut point(s)' : 'No obvious cut points detected',
  ];
  const breakpoints = [0, ...sceneCuts.filter((item) => item > 0 && item < meta.duration), meta.duration]
    .sort((left, right) => left - right)
    .filter((item, index, list) => index === 0 || Math.abs(item - list[index - 1]) > 0.02);
  const shotSizePool = ['特写', '近景', '中景', '全景', '大全景'];
  const anglePool = ['平视', '低机位', '俯视', '三分之二侧面', '肩后视角'];
  const movementPool = ['固定镜头', '缓慢推近', '轻微横移', '环绕主体', '跟随推进'];
  const focusPool = ['浅景深', '中景深', '深景深'];
  const lightingPool = ['柔和主光 + 辅光补面', '高对比侧光塑造', '冷暖混合氛围光', '轮廓逆光强化主体', '均匀漫反射商业布光'];
  const beatPool = ['建立主体与空间关系', '承接上一镜并推进动作', '强化情绪与视觉节奏', '突出关键信息与主体变化', '完成段落收束与记忆点'];
  const soundPool = ['环境底噪 + 氛围音乐铺垫', '动作节奏+ 轻微环境音', '空间混响 + 情绪音乐推进', '镜头转场音效 + 主体 Foley', '收束音效 + 背景音乐尾音'];
  const parseRows = [];
  for (let index = 0; index < Math.max(1, breakpoints.length - 1); index += 1) {
    const startTime = Number(breakpoints[index].toFixed(3));
    const endTime = Number(Math.max(startTime + 0.08, breakpoints[index + 1] ?? meta.duration).toFixed(3));
    const duration = Number(Math.max(0.08, endTime - startTime).toFixed(3));
    const shotSize = shotSizePool[index % shotSizePool.length];
    const cameraAngle = anglePool[index % anglePool.length];
    const cameraMovement = movementPool[index % movementPool.length];
    const focusDepth = focusPool[index % focusPool.length];
    const lighting = lightingPool[index % lightingPool.length];
    const narrativeBeat = beatPool[index % beatPool.length];
    const soundDesign = soundPool[index % soundPool.length];
    const keyframeTime = Number((startTime + duration * 0.5).toFixed(3));
    const frameDescription = 'Shot ' + (index + 1) + ': keep the current subject and composition relationship stable while carrying the action and spatial perspective forward.';
    const cameraPrompt = cameraMovement + ', ' + cameraAngle + ', ' + shotSize + ', keep the subject motion direction and original framing stable.';
    const imagePrompt = 'Keep the original composition stable, ' + shotSize + ', ' + cameraAngle + ', ' + focusDepth + ', ' + lighting + ', with clear background depth.';
    const keyframePrompt = 'Keyframe ' + (index + 1) + ': preserve pose and center of interest, strengthen ' + lighting + ' and ' + cameraMovement + ' cues for downstream generation.';
    parseRows.push({
      id: `shot-${index + 1}`,
      shotNumber: index + 1,
      startTime,
      endTime,
      duration,
      frameDescription,
      narrativeBeat,
      sceneType: shotSize,
      cameraAngle,
      cameraMovement,
      focusDepth,
      lighting,
      soundDesign,
      cameraPrompt,
      imagePrompt,
      keyframePrompt,
      keyframeTime,
      visualKeywords: [shotSize, cameraAngle, cameraMovement, focusDepth, lighting],
    });
  }
  return {
    sceneCount,
    sceneCuts,
    sampleFps,
    summary: summaryParts.join(' | '),
    suggestedShots: parseRows.map((row) => ({
      id: row.id,
      time: row.keyframeTime,
      label: `镜头 ${row.shotNumber}`,
      shotSize: row.sceneType,
      cameraPrompt: row.cameraPrompt,
      imagePrompt: row.imagePrompt,
      keyframePrompt: row.keyframePrompt,
    })),
    parseRows,
  };
}

export function postTempPath(baseDir, requestId, stepIndex, mediaKind) {
  return path.join(baseDir, `${requestId}-step-${stepIndex}.${mediaKind === 'video' ? 'webm' : 'png'}`);
}

export function escapeFfmpegFilterPath(filePath) {
  return String(filePath || '')
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'");
}

export function isSupportedLutFile(filePath) {
  return /\.(cube|3dl)$/i.test(String(filePath || '').trim());
}

export function isSupportedOcioConfigFile(filePath) {
  return /\.(ocio|yaml|yml|json|cfg|txt)$/i.test(String(filePath || '').trim());
}

export async function inspectOcioConfigFile(filePath) {
  const normalizedPath = String(filePath || '').trim();
  if (!normalizedPath) {
    return {
      structurallyValid: false,
      executable: false,
      profileVersion: '',
      detectedSections: [],
      formatLabel: 'OCIO Config',
      message: '未提供可读的 OCIO Config 路径',
    };
  }
  const ext = path.extname(normalizedPath).toLowerCase();
  const formatLabel = ext === '.json'
    ? 'JSON Config'
    : ext === '.yaml' || ext === '.yml'
      ? 'YAML Config'
      : ext === '.cfg' || ext === '.txt'
        ? '文本 Config'
        : 'OCIO Config';
  let text = '';
  try {
    text = await fs.readFile(normalizedPath, 'utf8');
  } catch (error) {
    return {
      structurallyValid: false,
      executable: false,
      profileVersion: '',
      detectedSections: [],
      formatLabel,
      message: `读取 OCIO Config 失败{error instanceof Error ? error.message : 'unknown-read-error'}`,
    };
  }
  if (!text.trim()) {
    return {
      structurallyValid: false,
      executable: false,
      profileVersion: '',
      detectedSections: [],
      formatLabel,
      message: '当前 OCIO Config 文件为空',
    };
  }

  const sectionLabels = ['roles', 'displays', 'views', 'looks', 'colorspaces'];
  let profileVersion = '';
  let detectedSections = [];
  if (ext === '.json') {
    try {
      const parsed = JSON.parse(text);
      const readField = (value) => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
      profileVersion = readField(parsed?.ocio_profile_version ?? parsed?.ocioProfileVersion);
      detectedSections = sectionLabels.filter((key) => {
        const value = parsed?.[key];
        if (Array.isArray(value)) return value.length > 0;
        if (value && typeof value === 'object') return Object.keys(value).length > 0;
        return false;
      });
    } catch (error) {
      return {
        structurallyValid: false,
        executable: false,
        profileVersion: '',
        detectedSections: [],
        formatLabel,
        message: `JSON 结构解析失败{error instanceof Error ? error.message : 'json-parse-failed'}`,
      };
    }
  } else {
    const sectionRegex = {
      roles: /^\s*roles\s*:/im,
      displays: /^\s*displays\s*:/im,
      views: /^\s*views\s*:/im,
      looks: /^\s*looks\s*:/im,
      colorspaces: /^\s*colorspaces\s*:/im,
    };
    const versionMatch = text.match(/^\s*ocio_profile_version\s*:\s*("?)([0-9A-Za-z._-]+)\1/im);
    profileVersion = versionMatch?.[2] || '';
    detectedSections = sectionLabels.filter((key) => sectionRegex[key].test(text));
  }

  const structurallyValid = Boolean(profileVersion) && detectedSections.includes('colorspaces');
  const executable = structurallyValid && detectedSections.some((item) => item === 'roles' || item === 'displays' || item === 'views');
  let message = 'Current OCIO config structure is complete and ready for execution.';
  if (!structurallyValid) {
    message = !profileVersion
      ? 'ocio_profile_version was not detected.'
      : 'colorspaces were not detected, so color-space mapping cannot be established.';
  } else if (!executable) {
    message = 'Base color spaces were detected, but one of roles / displays / views is still missing.';
  }
  return {
    structurallyValid,
    executable,
    profileVersion,
    detectedSections,
    formatLabel,
    message,
  };
}

export function isSupportedBokehFile(filePath) {
  return /\.(png|webp)$/i.test(String(filePath || '').trim());
}

export function hexToRgbUnit(value, fallback = { r: 0.5, g: 0.5, b: 0.5 }) {
  const normalized = String(value || '').trim();
  const match = /^#?([0-9a-f]{6})$/i.exec(normalized);
  if (!match) return fallback;
  const hex = match[1];
  return {
    r: parseInt(hex.slice(0, 2), 16) / 255,
    g: parseInt(hex.slice(2, 4), 16) / 255,
    b: parseInt(hex.slice(4, 6), 16) / 255,
  };
}

export function normalizeCurvePointList(points, fallbackPreset = 'linear', channel = 'master') {
  if (!Array.isArray(points) || points.length < 2) {
    return null;
  }
  const normalized = points
    .map((point, index, list) => ({
      x: clampNumber(Number(point?.x), 0, 1, index === 0 ? 0 : index === list.length - 1 ? 1 : 0.5),
      y: clampNumber(Number(point?.y), 0, 1, index === 0 ? 0 : index === list.length - 1 ? 1 : 0.5),
    }))
    .sort((left, right) => left.x - right.x);
  normalized[0] = { x: 0, y: 0 };
  normalized[normalized.length - 1] = { x: 1, y: 1 };
  for (let index = 1; index < normalized.length - 1; index += 1) {
    const prev = normalized[index - 1];
    const next = normalized[index + 1];
    normalized[index].x = clampNumber(normalized[index].x, prev.x + 0.02, next.x - 0.02, normalized[index].x);
  }
  if (normalized.length < 2) {
    return normalizeCurvePointList(null, fallbackPreset, channel);
  }
  return normalized;
}

export function curvePointsToFfmpeg(points) {
  return points.map((point) => `${point.x.toFixed(3)}/${point.y.toFixed(3)}`).join(' ');
}

export function buildCurvePoints(preset, channel = 'master', points = null) {
  const normalizedPoints = normalizeCurvePointList(points, preset, channel);
  if (normalizedPoints) {
    return curvePointsToFfmpeg(normalizedPoints);
  }
  const normalized = String(preset || 'linear').trim();
  if (normalized === 'soft-contrast') return '0/0 0.20/0.14 0.76/0.88 1/1';
  if (normalized === 'film-s') return '0/0 0.18/0.10 0.40/0.44 0.74/0.88 1/1';
  if (normalized === 'lifted-matte') return '0/0.06 0.22/0.20 0.78/0.84 1/0.97';
  if (normalized === 'film-warm') return channel === 'red' ? '0/0.01 0.45/0.48 0.82/0.90 1/1' : '0/0 1/1';
  if (normalized === 'teal-shadows') return channel === 'blue' ? '0/0.07 0.30/0.34 1/1' : channel === 'red' ? '0/0 0.28/0.22 1/1' : '0/0 1/1';
  if (normalized === 'crisp-highlights') return '0/0 0.60/0.62 0.86/0.92 1/1';
  if (normalized === 'film-balance') return channel === 'green' ? '0/0 0.22/0.20 0.70/0.74 1/1' : '0/0 1/1';
  if (normalized === 'lift-shadows') return '0/0.05 0.16/0.18 1/1';
  if (normalized === 'cool-highlights') return channel === 'blue' ? '0/0 0.66/0.72 1/1' : '0/0 1/1';
  return '0/0 1/1';
}

export function buildColorWheelFilter(config = {}) {
  const lift = hexToRgbUnit(config.liftColor, { r: 0.5, g: 0.5, b: 0.5 });
  const gamma = hexToRgbUnit(config.gammaColor, { r: 0.5, g: 0.5, b: 0.5 });
  const gain = hexToRgbUnit(config.gainColor, { r: 0.5, g: 0.5, b: 0.5 });
  const liftPower = clampNumber(Math.abs(config.lift) * clampNumber(config.liftAmount, 0, 1, 0.18), 0, 1, 0);
  const gammaPower = clampNumber(Math.abs(config.gamma - 1) * clampNumber(config.gammaAmount, 0, 1, 0.14), 0, 1, 0);
  const gainPower = clampNumber(Math.abs(config.gain - 1) * clampNumber(config.gainAmount, 0, 1, 0.16), 0, 1, 0);
  return `colorbalance=rs=${((lift.r - 0.5) * liftPower).toFixed(3)}:gs=${((lift.g - 0.5) * liftPower).toFixed(3)}:bs=${((lift.b - 0.5) * liftPower).toFixed(3)}:rm=${((gamma.r - 0.5) * gammaPower).toFixed(3)}:gm=${((gamma.g - 0.5) * gammaPower).toFixed(3)}:bm=${((gamma.b - 0.5) * gammaPower).toFixed(3)}:rh=${((gain.r - 0.5) * gainPower).toFixed(3)}:gh=${((gain.g - 0.5) * gainPower).toFixed(3)}:bh=${((gain.b - 0.5) * gainPower).toFixed(3)}`;
}

export function buildCurveFilter(config = {}) {
  return `curves=all='${buildCurvePoints(config.masterCurve, 'master', config.masterCurvePoints)}':r='${buildCurvePoints(config.redCurve, 'red', config.redCurvePoints)}':g='${buildCurvePoints(config.greenCurve, 'green', config.greenCurvePoints)}':b='${buildCurvePoints(config.blueCurve, 'blue', config.blueCurvePoints)}'`;
}

export function buildOcioLikeFilter(config = {}) {
  const inputSpace = String(config.colorSpaceIn || 'sRGB').trim();
  const outputSpace = String(config.colorSpaceOut || 'Rec.709').trim();
  const ocioConfig = String(config.ocioConfig || 'builtin').trim();
  const ocioDisplay = String(config.ocioDisplay || 'rec709-monitor').trim();
  const ocioStrength = clampNumber(config.ocioLookStrength, 0, 1, 0.72);
  const filters = [];
  if (ocioConfig === 'aces-1.3' || inputSpace !== 'sRGB' || outputSpace !== 'Rec.709' || ocioDisplay !== 'rec709-monitor') {
    const ocioContrast = 1 + ocioStrength * 0.06;
    const ocioOutMin = clampNumber(0.5 - ocioContrast * 0.5, 0, 0.05, 0);
    const ocioOutMax = clampNumber(0.5 + ocioContrast * 0.5, 0.95, 1, 1);
    filters.push(`colorlevels=romin=${ocioOutMin.toFixed(3)}:gomin=${ocioOutMin.toFixed(3)}:bomin=${ocioOutMin.toFixed(3)}:romax=${ocioOutMax.toFixed(3)}:gomax=${ocioOutMax.toFixed(3)}:bomax=${ocioOutMax.toFixed(3)}`);
    filters.push(`hue=s=${(1 + ocioStrength * 0.04).toFixed(3)}`);
    if (inputSpace === 'ACEScg' || ocioConfig === 'aces-1.3') {
      filters.push(`curves=all='0/0 0.18/0.12 0.70/0.82 1/1'`);
    }
    if (outputSpace === 'DCI-P3' || ocioDisplay === 'p3-cinema') {
      const p3Mid = clampNumber(0.5 + ocioStrength * 0.012, 0.48, 0.56, 0.5);
      filters.push(`hue=s=${(1 + ocioStrength * 0.05).toFixed(3)}`);
      filters.push(`curves=all='0/0 0.50/${p3Mid.toFixed(3)} 1/1'`);
    } else if (ocioDisplay === 'web-srgb') {
      const webGamma = 1 + ocioStrength * 0.03;
      const webMid = clampNumber(Math.pow(0.5, 1 / webGamma), 0.46, 0.56, 0.5);
      filters.push(`curves=all='0/0 0.50/${webMid.toFixed(3)} 1/1'`);
    }
  }
  return filters;
}

export function resolvePostUpscaleRoute(config = {}) {
  const routePolicy = String(config.routePolicy || 'auto').trim();
  const model = String(config.model || 'realesrgan-balanced').trim();
  if (routePolicy !== 'auto') return routePolicy;
  if (model === 'supir-detail') return 'supir';
  if (model === 'fsr-fast') return 'fsr-preview';
  if (model === 'realbasicvsr-video') return 'realbasicvsr';
  return 'realbasicvsr';
}

export function resolveLocalPostWrapperCommand({ envCommand = '', envPath = '', wrapperKey = '' } = {}) {
  let commandLine = envCommand ? String(process.env[envCommand] || '').trim() : '';
  const detectedPath = envPath ? String(process.env[envPath] || '').trim() : '';
  const wrapperScript = wrapperKey ? LOCAL_POST_BACKEND_WRAPPERS[wrapperKey] : '';
  if (!commandLine && detectedPath && wrapperScript) {
    commandLine = `node "${wrapperScript}"`;
  }
  return {
    commandLine,
    detectedPath,
  };
}

export function detectExecutablePath(cacheKey, names = [], preferredPaths = []) {
  if (EXECUTABLE_DETECTION_CACHE.has(cacheKey)) {
    return EXECUTABLE_DETECTION_CACHE.get(cacheKey) || '';
  }
  const normalizedPreferred = preferredPaths
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  const preferredHit = normalizedPreferred.find((item) => existsSync(item));
  if (preferredHit) {
    EXECUTABLE_DETECTION_CACHE.set(cacheKey, preferredHit);
    return preferredHit;
  }

  const lookupCommand = process.platform === 'win32' ? 'where' : 'which';
  for (const name of names.map((item) => String(item || '').trim()).filter(Boolean)) {
    const lookup = spawnSync(lookupCommand, [name], {
      cwd: APP_DIR,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (lookup.status === 0) {
      const hit = String(lookup.stdout || '')
        .split(/\r?\n/)
        .map((item) => item.trim())
        .find(Boolean);
      if (hit) {
        EXECUTABLE_DETECTION_CACHE.set(cacheKey, hit);
        return hit;
      }
    }
  }
  EXECUTABLE_DETECTION_CACHE.set(cacheKey, '');
  return '';
}

export function isPathInsideDir(baseDir, targetPath) {
  const relative = path.relative(path.resolve(baseDir), path.resolve(targetPath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function readManagedRuntimeManifest() {
  try {
    if (!existsSync(LOCAL_POST_MANAGED_RUNTIME_MANIFEST_FILE)) return {};
    const parsed = JSON.parse(readFileSync(LOCAL_POST_MANAGED_RUNTIME_MANIFEST_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function writeManagedRuntimeManifestSync(manifest) {
  mkdirSync(LOCAL_POST_MANAGED_RUNTIME_DIR, { recursive: true });
  writeFileSync(LOCAL_POST_MANAGED_RUNTIME_MANIFEST_FILE, JSON.stringify(manifest, null, 2), 'utf8');
}

export function getManagedRuntimeManifestEntry(runtimeKey) {
  const manifest = readManagedRuntimeManifest();
  const entry = manifest?.[runtimeKey];
  return entry && typeof entry === 'object' ? entry : null;
}

export function readManagedRuntimeFile(runtimeKey, field) {
  const entry = getManagedRuntimeManifestEntry(runtimeKey);
  const value = String(entry?.[field] || '').trim();
  if (!value) return '';
  const resolved = path.resolve(value);
  return existsSync(resolved) ? resolved : '';
}

export function findFileRecursively(rootDir, fileName, maxDepth = 6) {
  const normalizedRoot = path.resolve(rootDir);
  if (!existsSync(normalizedRoot)) return '';
  // 支持传入单个文件名或候选名数组（跨平台可执行名 gmic / gmic.exe）
  const wanted = (Array.isArray(fileName) ? fileName : [fileName])
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean);
  if (wanted.length === 0) return '';
  const queue = [{ dir: normalizedRoot, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    let entries = [];
    try {
      entries = readdirSync(current.dir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const entryPath = path.join(current.dir, entry.name);
      if (entry.isFile() && wanted.includes(entry.name.toLowerCase())) {
        return entryPath;
      }
      if (entry.isDirectory() && current.depth < maxDepth) {
        queue.push({ dir: entryPath, depth: current.depth + 1 });
      }
    }
  }
  return '';
}

export function detectManagedLocalPostGmicPath() {
  return readManagedRuntimeFile('gmic', 'executablePath')
    || findFileRecursively(buildManagedRuntimePaths('gmic').currentDir, platformExecutableCandidates('gmic'));
}

export function detectManagedLocalPostOiioPath() {
  return readManagedRuntimeFile('oiio', 'executablePath')
    || findFileRecursively(buildManagedRuntimePaths('oiio').currentDir, platformExecutableCandidates('oiiotool'));
}

export function detectManagedLocalPostOcioPath() {
  return readManagedRuntimeFile('ocio', 'runtimePath')
    || findFileRecursively(buildManagedRuntimePaths('ocio').currentDir, platformExecutableCandidates('ocioconvert'));
}

export function detectManagedLocalPostOcioConfigPath() {
  return readManagedRuntimeFile('ocio', 'configPath');
}

export function detectManagedLocalPostYtDlpPath() {
  return readManagedRuntimeFile('ytdlp', 'executablePath')
    || findFileRecursively(buildManagedRuntimePaths('ytdlp').currentDir, platformExecutableCandidates('yt-dlp'));
}

export function detectManagedLocalPostAria2Path() {
  return readManagedRuntimeFile('aria2', 'executablePath')
    || findFileRecursively(buildManagedRuntimePaths('aria2').currentDir, platformExecutableCandidates('aria2c'));
}

export function detectManagedLocalPostFfmpegPath() {
  return readManagedRuntimeFile('ffmpeg', 'executablePath')
    || findFileRecursively(buildManagedRuntimePaths('ffmpeg').currentDir, platformExecutableCandidates('ffmpeg'));
}

export function resolveLocalPostYtDlpBackend() {
  const detectedPath = detectManagedLocalPostYtDlpPath();
  return {
    configured: Boolean(detectedPath),
    detectedPath,
  };
}

export function resolveLocalPostAria2Backend() {
  const detectedPath = detectManagedLocalPostAria2Path();
  return {
    configured: Boolean(detectedPath),
    detectedPath,
  };
}

export function resolveLocalPostFfmpegBackend() {
  const detectedPath = detectManagedLocalPostFfmpegPath();
  return {
    configured: Boolean(detectedPath),
    detectedPath,
  };
}

export function applyManagedFlorence2Env() {
  let scriptPath = '';
  let pythonPath = '';
  let hfHome = '';
  let modelDir = '';
  const entry = getManagedRuntimeManifestEntry('florence2');
  if (entry && entry.runtimePath) {
    scriptPath = normalizeFlorence2ScriptPath(entry.runtimePath);
    pythonPath = entry.pythonPath || '';
    hfHome = entry.hfHome || '';
    modelDir = entry.hfHome || '';
  } else {
    // 托管清单缺失时（如未运行「一键安装」写清单），直接从安装目录自动探测 .py 与 venv python，
    // 保证 Florence-2 路径在每次解析时都能注入 process.env，而非因清单缺失而整条分析失败。
    // 修复：buildManagedRuntimePaths 只返回 rootDir/currentDir/stagingDir/downloadDir，
    // 此前误用 paths.backendParent / paths.baseDir / paths.modelDir（均为 undefined），
    // 导致清单缺失时 path.join(undefined) 抛 TypeError，整条图像分析链 500。
    // 目录布局与 installFlorence2Runtime 一致：rootDir/{backend,model,venv}。
    const paths = buildManagedRuntimePaths('florence2');
    const backendDir = path.join(paths.rootDir, 'backend');
    const managedModelDir = path.join(paths.rootDir, 'model');
    scriptPath = detectManagedLocalPostFlorence2Path() || path.join(backendDir, 'local_image_example_florence2.py');
    const venvPy = path.join(paths.rootDir, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    if (existsSync(venvPy)) pythonPath = venvPy;
    hfHome = existsSync(managedModelDir) ? managedModelDir : '';
    modelDir = hfHome;
  }
  if (scriptPath && existsSync(scriptPath) && !process.env.HMDAO_FLORENCE2_PATH) {
    process.env.HMDAO_FLORENCE2_PATH = scriptPath;
  }
  if (!process.env.HMDAO_FLORENCE2_PYTHON && pythonPath) process.env.HMDAO_FLORENCE2_PYTHON = String(pythonPath);
  if (!process.env.HMDAO_FLORENCE2_HF_HOME && hfHome) process.env.HMDAO_FLORENCE2_HF_HOME = String(hfHome);
  if (!process.env.HMDAO_FLORENCE2_MODEL && modelDir) process.env.HMDAO_FLORENCE2_MODEL = String(modelDir);
}

export function normalizeFlorence2ScriptPath(rawPath) {
  const raw = String(rawPath || '').trim();
  if (!raw) return '';
  const resolved = path.resolve(raw);
  try {
    if (path.extname(resolved).toLowerCase() === '.py' && existsSync(resolved)) {
      return resolved;
    }
    if (existsSync(resolved) && statSync(resolved).isDirectory()) {
      const inside = path.join(resolved, 'local_image_example_florence2.py');
      if (existsSync(inside)) return inside;
    }
  } catch {
    /* 忽略 stat 异常，走兜底 */
  }
  const repoScript = path.resolve(APP_DIR, 'server', 'local_image_example_florence2.py');
  if (existsSync(repoScript)) return repoScript;
  return '';
}

export function detectManagedLocalPostFlorence2Path() {
  return normalizeFlorence2ScriptPath(readManagedRuntimeFile('florence2', 'runtimePath'))
    || findFileRecursively(buildManagedRuntimePaths('florence2').currentDir, ['local_image_example_florence2.py', 'florence2.py']);
}

export function detectManagedLocalPostFlorence2Python() {
  return readManagedRuntimeFile('florence2', 'pythonPath')
    || findFileRecursively(buildManagedRuntimePaths('florence2').rootDir, ['venv/Scripts/python.exe', 'venv/bin/python', 'venv/bin/python3']);
}

export function resolveLocalPostFlorence2Backend() {
  const detectedPath = detectManagedLocalPostFlorence2Path();
  const pythonPath = detectManagedLocalPostFlorence2Python();
  return {
    configured: Boolean(detectedPath),
    detectedPath,
    pythonPath,
  };
}

export function unixBinCandidates(execName) {
  const info = buildPlatformInfo();
  if (info.isWindows) return [];
  return info.extraBinDirs.map((dir) => path.join(dir, execName));
}

export function detectLocalPostOcioRuntimePath() {
  const configuredPath = String(process.env.HMDAO_POST_OCIO_PATH || '').trim();
  if (configuredPath) return configuredPath;
  const candidates = [
    detectManagedLocalPostOcioPath(),
    process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'OpenColorIO', 'bin', 'ocioconvert.exe') : '',
    process.platform === 'win32' ? path.join(process.env.LocalAppData || '', 'Programs', 'OpenColorIO', 'bin', 'ocioconvert.exe') : '',
    ...unixBinCandidates('ocioconvert'),
  ].filter(Boolean);
  return detectExecutablePath('post:ocio', ['ocioconvert', 'ocioconvert.exe'], candidates);
}

export function detectLocalPostGmicPath() {
  const configuredPath = String(process.env.HMDAO_POST_GMIC_PATH || '').trim();
  if (configuredPath) return configuredPath;
  const candidates = [
    detectManagedLocalPostGmicPath(),
    process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'GMIC', 'gmic.exe') : '',
    process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'G-MIC', 'gmic.exe') : '',
    process.platform === 'win32' ? path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'GMIC', 'gmic.exe') : '',
    process.platform === 'win32' ? path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'G-MIC', 'gmic.exe') : '',
    process.platform === 'win32' ? path.join(process.env.LocalAppData || '', 'Programs', 'GMIC', 'gmic.exe') : '',
    ...unixBinCandidates('gmic'),
  ].filter(Boolean);
  return detectExecutablePath('post:gmic', ['gmic', 'gmic.exe'], candidates);
}

export function detectLocalPostOiioPath() {
  const configuredPath = String(process.env.HMDAO_POST_OIIO_PATH || '').trim();
  if (configuredPath) return configuredPath;
  const candidates = [
    detectManagedLocalPostOiioPath(),
    process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'OpenImageIO', 'bin', 'oiiotool.exe') : '',
    process.platform === 'win32' ? path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'OpenImageIO', 'bin', 'oiiotool.exe') : '',
    process.platform === 'win32' ? path.join(process.env.LocalAppData || '', 'Programs', 'OpenImageIO', 'bin', 'oiiotool.exe') : '',
    ...unixBinCandidates('oiiotool'),
  ].filter(Boolean);
  return detectExecutablePath('post:oiio', ['oiiotool', 'oiiotool.exe'], candidates);
}

export function detectLocalPostOiioConfigPath() {
  const configured = String(process.env.HMDAO_POST_OIIO_OCIO_CONFIG || process.env.HMDAO_POST_OCIO_CONFIG || process.env.OCIO || '').trim();
  if (configured && existsSync(configured)) return configured;
  return detectManagedLocalPostOcioConfigPath();
}

export function clearLocalPostRuntimeDetectionCache() {
  EXECUTABLE_DETECTION_CACHE.clear();
}

export function trimRuntimeInstallJobs() {
  const jobs = Array.from(LOCAL_POST_RUNTIME_INSTALL_JOBS.values())
    .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
  for (const job of jobs.slice(LOCAL_POST_RUNTIME_INSTALL_MAX_HISTORY)) {
    LOCAL_POST_RUNTIME_INSTALL_JOBS.delete(job.id);
    const linked = LOCAL_POST_RUNTIME_INSTALL_JOBS_BY_KEY.get(job.runtimeKey);
    if (linked === job.id) {
      LOCAL_POST_RUNTIME_INSTALL_JOBS_BY_KEY.delete(job.runtimeKey);
    }
  }
}

export function toRuntimeInstallJobResponse(job) {
  if (!job) return null;
  return {
    id: job.id,
    runtimeKey: job.runtimeKey,
    runtimeName: job.runtimeName,
    requestedAction: job.requestedAction,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    message: job.message,
    error: job.error,
    targetVersion: job.targetVersion,
    installedVersion: job.installedVersion,
    sourceLabel: job.sourceLabel,
    downloadUrl: job.downloadUrl,
    releaseUrl: job.releaseUrl,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    verified: Boolean(job.verified),
    doctor: job.doctor || null,
    freeSpaceBytes: typeof job.freeSpaceBytes === 'number' ? job.freeSpaceBytes : null,
    requiredSpaceBytes: typeof job.requiredSpaceBytes === 'number' ? job.requiredSpaceBytes : null,
  };
}

export function updateRuntimeInstallJob(job, patch = {}) {
  Object.assign(job, patch, { updatedAt: Date.now() });
  LOCAL_POST_RUNTIME_INSTALL_JOBS.set(job.id, job);
  LOCAL_POST_RUNTIME_INSTALL_JOBS_BY_KEY.set(job.runtimeKey, job.id);
  trimRuntimeInstallJobs();
  return job;
}

export function getRuntimeInstallJob(jobId) {
  return LOCAL_POST_RUNTIME_INSTALL_JOBS.get(jobId) || null;
}

export function getLatestRuntimeInstallJob(runtimeKey) {
  const jobId = LOCAL_POST_RUNTIME_INSTALL_JOBS_BY_KEY.get(runtimeKey);
  return jobId ? getRuntimeInstallJob(jobId) : null;
}

export async function extractZipArchiveToDirectory(archivePath, targetDir) {
  const resolvedTargetDir = path.resolve(targetDir);
  await fs.mkdir(resolvedTargetDir, { recursive: true });
  const archiveBuffer = await fs.readFile(archivePath);
  const extracted = unzipSync(new Uint8Array(archiveBuffer));
  for (const [entryName, entryBytes] of Object.entries(extracted)) {
    const normalizedEntry = String(entryName || '').replace(/\\/g, '/');
    if (!normalizedEntry || normalizedEntry.endsWith('/')) continue;
    const safeSegments = normalizedEntry.split('/').filter(Boolean);
    if (!safeSegments.length || safeSegments.some((segment) => segment === '.' || segment === '..')) continue;
    const outputPath = path.resolve(resolvedTargetDir, ...safeSegments);
    if (!isPathInsideDir(resolvedTargetDir, outputPath)) {
      throw new Error(`archive-path-outside-target:${normalizedEntry}`);
    }
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, Buffer.from(entryBytes));
  }
}

export async function replaceDirectoryContents(targetDir, stagingDir) {
  const resolvedTargetDir = path.resolve(targetDir);
  const resolvedStagingDir = path.resolve(stagingDir);
  const rootDir = path.dirname(resolvedTargetDir);
  if (!isPathInsideDir(rootDir, resolvedTargetDir) || !isPathInsideDir(rootDir, resolvedStagingDir)) {
    throw new Error('managed-runtime-path-outside-root');
  }
  // Windows 上 rename 目录常因杀软实时扫描 / 索引句柄残留返回 EPERM / EBUSY / ENOTEMPTY，
  // 这类错误通常是【瞬时】的（扫描在数百毫秒内完成）。统一加重试退避，覆盖最终 rename 与新目录生成。
  const renameWithRetry = async (from, to) => {
    let lastErr = null;
    for (let attempt = 0; attempt < 15; attempt++) {
      try {
        await fs.rename(from, to);
        return;
      } catch (err) {
        lastErr = err;
        const code = (err && err.code) || '';
        if (code === 'EPERM' || code === 'EBUSY' || code === 'ENOTEMPTY') {
          await new Promise((res) => setTimeout(res, 500));
          continue;
        }
        throw err;
      }
    }
    throw lastErr || new Error('rename-failed:' + String(from) + ' -> ' + String(to));
  };
  // P3-2: 先把旧目录重命名为带时间戳的备份（move 在 Windows 上比 rm 更可靠，且能绕过 rm 后的句柄残留）。
  // 该备份作为「保留 1 个 .bak 回滚点」供后续回滚（P3-9）使用，不再立即删除。
  let backupDir = '';
  if (existsSync(resolvedTargetDir)) {
    backupDir = `${resolvedTargetDir}.bak-${Date.now()}`;
    try {
      await renameWithRetry(resolvedTargetDir, backupDir);
      // 仅保留最新 1 个 .bak，清理此前累积的历史备份，防止多次安装后 .bak 无限增长占满磁盘。
      await pruneOldBakBackups(resolvedTargetDir, backupDir);
    } catch (_) {
      // 极端情况下旧目录无法改名（顽固锁文件）：退而求其次，把暂存内容合并复制进旧目录，再清掉暂存。
      await fs.cp(resolvedStagingDir, resolvedTargetDir, { recursive: true }).catch(() => {});
      await fs.rm(resolvedStagingDir, { recursive: true, force: true }).catch(() => {});
      return;
    }
  }
  // staging → target 原子切换（成功后原 staging 目录被消费为 target，等价于清理 staging）。
  // 若切换失败，把刚备份的旧版本恢复回 target，保证运行时目录始终存在（中断安全）。
  try {
    await renameWithRetry(resolvedStagingDir, resolvedTargetDir);
  } catch (err) {
    if (backupDir && existsSync(backupDir)) {
      await renameWithRetry(backupDir, resolvedTargetDir).catch(() => {});
    }
    throw err;
  }
}

export async function persistManagedRuntimeManifestEntry(runtimeKey, nextEntry) {
  const manifest = readManagedRuntimeManifest();
  manifest[runtimeKey] = nextEntry;
  writeManagedRuntimeManifestSync(manifest);
}

export async function removeManagedRuntimeManifestEntry(runtimeKey) {
  const manifest = readManagedRuntimeManifest();
  if (manifest && Object.prototype.hasOwnProperty.call(manifest, runtimeKey)) {
    delete manifest[runtimeKey];
    writeManagedRuntimeManifestSync(manifest);
  }
}

// ---- 本地后处理后端能力解析/状态构建（P2 续：自 hmdao-api.mjs 原样搬移）----
// 纯函数：仅读取 process.env 与已由本模块导出的检测/路由函数，不触碰主文件可变状态。

export function buildLocalPostBackendStatus(key, resolvedBackend, exampleRuntimePath = '') {
  const guide = LOCAL_POST_RUNTIME_GUIDES[key] || {};
  return {
    configured: Boolean(resolvedBackend?.configured),
    commandConfigured: Boolean(resolvedBackend?.commandLine),
    detectedPath: String(resolvedBackend?.detectedPath || '').trim(),
    wrapperScript: LOCAL_POST_BACKEND_WRAPPERS[key] || '',
    exampleRuntimePath,
    runtimeName: String(guide.runtimeName || '').trim(),
    envPath: String(guide.envPath || '').trim(),
    envCommand: String(guide.envCommand || '').trim(),
    docsUrl: String(guide.docsUrl || '').trim(),
    downloadUrl: String(guide.downloadUrl || '').trim(),
    installHint: String(guide.installHint || '').trim(),
    successHint: String(guide.successHint || '').trim(),
    commonInstallPaths: Array.isArray(guide.commonInstallPaths) ? guide.commonInstallPaths.map((item) => String(item || '').trim()).filter(Boolean) : [],
    supportsImage: guide.supportsImage !== false,
    supportsVideo: Boolean(guide.supportsVideo),
    detectedConfigPath: String(resolvedBackend?.detectedConfigPath || '').trim(),
  };
}

export function resolveLocalPostUpscaleBackend(config = {}, mediaKind = 'image') {
  const resolvedRoute = resolvePostUpscaleRoute(config);
  const executionMode = String(config.executionMode || 'auto').trim();
  const commandMap = {
    'fsr-preview': { envCommand: 'HMDAO_POST_FSR_COMMAND', envPath: 'HMDAO_POST_FSR_PATH', label: 'FSR' },
    realbasicvsr: { envCommand: 'HMDAO_POST_REALBASICVSR_COMMAND', envPath: 'HMDAO_POST_REALBASICVSR_PATH', label: 'RealBasicVSR' },
    supir: { envCommand: 'HMDAO_POST_SUPIR_COMMAND', envPath: 'HMDAO_POST_SUPIR_PATH', label: 'SUPIR' },
  };
  const routeMeta = commandMap[resolvedRoute] || null;
  const { commandLine, detectedPath } = routeMeta
    ? resolveLocalPostWrapperCommand({
      envCommand: routeMeta.envCommand,
      envPath: routeMeta.envPath,
      wrapperKey: resolvedRoute,
    })
    : { commandLine: '', detectedPath: '' };
  return {
    resolvedRoute,
    label: routeMeta?.label || resolvedRoute,
    commandLine,
    detectedPath,
    wrapperAllowed: executionMode !== 'fallback-only',
    fallbackAllowed: executionMode !== 'wrapper-only',
    mediaKind,
    configured: Boolean(commandLine),
  };
}

export function resolveLocalPostOcioBackend(config = {}) {
  const executionMode = String(config.ocioExecutionMode || 'auto').trim();
  const envCommand = String(process.env.HMDAO_POST_OCIO_COMMAND || '').trim();
  const envPath = String(process.env.HMDAO_POST_OCIO_PATH || '').trim();
  const managedRuntimePath = detectManagedLocalPostOcioPath();
  const wrapperScript = LOCAL_POST_BACKEND_WRAPPERS.ocio;
  const managedWrapperScript = LOCAL_POST_BACKEND_WRAPPERS['ocio-managed'];
  const commandLine = envCommand
    || (envPath && wrapperScript ? `node "${wrapperScript}"` : '')
    || (managedRuntimePath && managedWrapperScript ? `node "${managedWrapperScript}"` : '');
  const detectedPath = envPath || managedRuntimePath || '';
  return {
    label: 'OCIO',
    commandLine,
    detectedPath,
    detectedConfigPath: detectLocalPostOiioConfigPath(),
    managedRuntime: Boolean(!envCommand && !envPath && managedRuntimePath),
    wrapperAllowed: executionMode !== 'fallback-only',
    fallbackAllowed: executionMode !== 'wrapper-only',
    configured: Boolean(commandLine),
  };
}

export function resolveLocalPostOiioBackend(config = {}, mediaKind = 'image', ocioConfigPath = '') {
  const executionMode = String(config.ocioExecutionMode || 'auto').trim();
  const commandLineFromEnv = String(process.env.HMDAO_POST_OIIO_COMMAND || '').trim();
  const detectedPath = detectLocalPostOiioPath();
  const detectedConfigPath = String(ocioConfigPath || detectLocalPostOiioConfigPath()).trim();
  const commandLine = commandLineFromEnv || (detectedPath ? `node "${LOCAL_POST_BACKEND_WRAPPERS.oiio}"` : '');
  return {
    label: 'OIIO + OCIO',
    commandLine,
    detectedPath,
    detectedConfigPath,
    wrapperAllowed: mediaKind === 'image' && executionMode !== 'fallback-only',
    fallbackAllowed: executionMode !== 'wrapper-only',
    configured: Boolean(commandLine && detectedConfigPath),
    runtimeConfigured: Boolean(commandLine),
    mediaKind,
  };
}

export function resolveLocalPostGmicBackend() {
  const commandLineFromEnv = String(process.env.HMDAO_POST_GMIC_COMMAND || '').trim();
  const detectedPath = detectLocalPostGmicPath();
  const wrapperScript = LOCAL_POST_BACKEND_WRAPPERS.gmic;
  const commandLine = commandLineFromEnv || (detectedPath && wrapperScript ? `node "${wrapperScript}"` : '');
  return {
    label: 'G\'MIC',
    commandLine,
    detectedPath,
    wrapperAllowed: true,
    fallbackAllowed: true,
    configured: Boolean(commandLine),
  };
}
