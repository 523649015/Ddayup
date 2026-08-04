// 资产库服务模块（从 hmdao-api.mjs 迁移，1621..2403）
// 工厂模式：外部项目级依赖经 deps 注入；Node 内置模块与 import 来源本地引入；
// 集群内部函数互相引用保持闭包。音频探测复用主文件经 deps 注入的 probeAudioFile。
import { promises as fs, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import process from 'node:process';
import { buildPlatformInfo } from '../platform-utils.mjs';

export function createAssetLibraryService(deps = {}) {
  const {
    runCommand,
    computeAssetContentHash,
    probeVideoFile,
    probeImageFile,
    probeAudioFile,
    mediaMimeTypeFromExtension,
    processAssetLibraryImportRequest,
    DATA_DIR,
    ASSET_LIBRARY_CATALOG_FILE,
    DEFAULT_ASSET_LIBRARY_STORAGE_DIR,
    uniqueStrings,
    escapePowerShellSingleQuoted,
  } = deps;

function sanitizeAssetFileBaseName(value = 'asset') {
  return String(value || 'asset')
    .replace(/\.[^.]+$/, '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .slice(0, 80)
    .trim() || 'asset';
}

function inferAssetTypeFromMime(mimeType = '', fallback = 'image') {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.startsWith('video/')) return 'video';
  if (normalized.startsWith('audio/')) return 'audio';
  if (normalized.startsWith('model/')) return 'model';
  if (normalized.startsWith('text/') || normalized.includes('json') || normalized.includes('csv') || normalized.includes('pdf')) return 'text';
  if (normalized.startsWith('image/')) return 'image';
  return fallback;
}

function inferAssetTypeFromPath(filePath = '', fallback = 'image') {
  const mimeType = mediaMimeTypeFromExtension(filePath, '');
  return inferAssetTypeFromMime(mimeType, fallback);
}

const ASSET_IMPORT_CATEGORY_RULES = [
  { keywords: ['landscape', 'mountain', 'forest', 'ocean', 'nature', '风景', '自然', '风光', '山水'], category: '风景' },
  { keywords: ['portrait', 'person', 'model', 'people', '人像', '人物', '模特'], category: '人物' },
  { keywords: ['city', 'building', 'architecture', 'interior', '城市', '建筑', '室内'], category: '建筑' },
  { keywords: ['night', 'nightscape', 'neon', '夜景', '霓虹'], category: '夜景' },
  { keywords: ['car', 'vehicle', 'auto', 'automobile', '汽车', '车辆'], category: '汽车' },
  { keywords: ['product', 'commerce', 'electric', 'watch', 'phone', '产品', '电商', '静物'], category: '产品' },
  { keywords: ['tech', 'technology', 'digital', '芯片', '科技'], category: '科技' },
  { keywords: ['fashion', 'beauty', 'clothes', '时尚', '美妆'], category: '时尚' },
  { keywords: ['food', 'drink', 'cafe', 'coffee', '美食', '饮品'], category: '美食' },
  { keywords: ['audio', 'bgm', 'voice', 'music', '音频', '音乐', '旁白'], category: '音频' },
  { keywords: ['video', 'film', 'cinema', '镜头', '视频'], category: '视频' },
];

function inferSupportedImportAssetType(filePath = '', mimeType = '') {
  const type = inferAssetTypeFromMime(mimeType, inferAssetTypeFromPath(filePath, ''));
  return ['image', 'video', 'audio', 'text'].includes(String(type || '')) ? type : null;
}

function normalizeAssetImportToken(value = '') {
  return String(value || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyAssetImportText(text = '') {
  const normalized = String(text || '').toLowerCase();
  return uniqueStrings(
    ASSET_IMPORT_CATEGORY_RULES
      .filter((rule) => rule.keywords.some((keyword) => normalized.includes(String(keyword).toLowerCase())))
      .map((rule) => rule.category),
  ).slice(0, 6);
}

function inferAssetImportFolderSegments(relativePath = '') {
  return uniqueStrings(
    String(relativePath || '')
      .split(/[\\/]+/)
      .slice(0, -1)
      .map((segment) => normalizeAssetImportToken(segment))
      .filter((segment) => segment.length >= 2),
  ).slice(-4);
}

function inferAssetImportHints(filePath = '', type = 'image', rootPath = '') {
  const relativePath = rootPath ? path.relative(rootPath, filePath) : path.basename(filePath);
  const folderSegments = inferAssetImportFolderSegments(relativePath);
  const semanticCategories = classifyAssetImportText([path.basename(filePath), relativePath].join(' '));
  const smartCategories = uniqueStrings([
    ...semanticCategories,
    ...folderSegments.slice(0, 2),
  ]).slice(0, 6);
  const nameParts = sanitizeAssetFileBaseName(path.basename(filePath))
    .split(/[\s_.-]+/)
    .map((part) => String(part || '').trim())
    .filter((part) => part.length >= 2)
    .slice(0, 3);
  const typeLabel = type === 'video' ? '视频' : type === 'audio' ? '音频' : type === 'text' ? '文档' : '图片';
  const tags = uniqueStrings([
    ...folderSegments,
    ...smartCategories,
    ...nameParts,
    typeLabel,
  ]).slice(0, 8);
  return {
    relativePath,
    smartCategories,
    tags,
  };
}

function buildAssetLibraryContentUrl(assetId) {
  return `/api/assets/content/${encodeURIComponent(String(assetId || ''))}`;
}

function normalizeAssetLibraryItem(source = {}) {
  const assetId = String(source.id || source.backendAssetId || crypto.randomUUID());
  const type = ['image', 'video', 'audio', 'text'].includes(String(source.type || ''))
    ? String(source.type)
    : inferAssetTypeFromPath(String(source.filePath || ''), 'image');
  const createdAt = Number(source.createdAt || Date.now());
  const updatedAt = Number(source.updatedAt || createdAt || Date.now());
  const tags = Array.isArray(source.tags) ? source.tags.map((item) => String(item || '').trim()).filter(Boolean) : [];
  const smartCategories = Array.isArray(source.smartCategories) ? source.smartCategories.map((item) => String(item || '').trim()).filter(Boolean) : [];
  const filePath = path.resolve(String(source.filePath || ''));
  const contentUrl = buildAssetLibraryContentUrl(assetId);
  const storageLabel = String(source.storageLabel || '').trim().toLowerCase() === 'reference'
    ? 'reference'
    : 'disk';
  return {
    id: assetId,
    backendAssetId: assetId,
    name: String(source.name || `${assetId}`),
    type,
    url: contentUrl,
    thumbnail: type === 'audio' ? '' : String(source.thumbnail || contentUrl),
    folderId: String(source.folderId || 'root'),
    size: Math.max(0, Number(source.size || 0)),
    width: Number(source.width || 0) || undefined,
    height: Number(source.height || 0) || undefined,
    duration: Number(source.duration || 0) || undefined,
    tags,
    smartCategories,
    prompt: typeof source.prompt === 'string' ? source.prompt : undefined,
    sourceUrl: String(source.sourceUrl || ''),
    filePath,
    persisted: true,
    storageLabel,
    duplicateOf: typeof source.duplicateOf === 'string' ? String(source.duplicateOf).trim() : undefined,
    contentHash: typeof source.contentHash === 'string' ? String(source.contentHash).trim() : undefined,
    source: ['upload', 'web', 'crawl', 'generate'].includes(String(source.source || '')) ? String(source.source) : 'upload',
    createdAt,
    updatedAt,
  };
}

function normalizeAssetDuplicateValue(value = '') {
  const normalized = String(value || '').trim().replace(/\//g, '\\');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function buildAssetDuplicateFingerprint({
  type = 'image',
  filePath = '',
  sourceUrl = '',
  name = '',
  size = 0,
  width = 0,
  height = 0,
  duration = 0,
  storageLabel = '',
  source = '',
  contentHash = '',
}) {
  const normalizedContentHash = String(contentHash || '').trim();
  if (normalizedContentHash) {
    return `content:${type}:${normalizedContentHash}`;
  }
  const normalizedStorageLabel = String(storageLabel || '').trim().toLowerCase();
  const normalizedFilePath = normalizeAssetDuplicateValue(filePath);
  const normalizedSourceUrl = normalizeAssetDuplicateValue(sourceUrl);
  const normalizedSource = String(source || '').trim().toLowerCase();
  if (normalizedStorageLabel === 'reference' && normalizedFilePath) {
    return `reference:${type}:${normalizedFilePath}`;
  }
  if (
    normalizedSourceUrl
    && ['crawl', 'web', 'generate'].includes(normalizedSource)
  ) {
    return `source:${type}:${normalizedSourceUrl}:${Math.max(0, Number(size || 0))}`;
  }
  return [
    'content',
    type,
    normalizeAssetDuplicateValue(name),
    Math.max(0, Number(size || 0)),
    Math.max(0, Number(width || 0)),
    Math.max(0, Number(height || 0)),
    Math.max(0, Number(duration || 0)),
  ].join(':');
}

function findDuplicateAssetLibraryItem(items = [], candidate = {}) {
  const fingerprint = buildAssetDuplicateFingerprint(candidate);
  if (!fingerprint) return null;
  return items.find((item) => buildAssetDuplicateFingerprint(item) === fingerprint) || null;
}

function mergeUniqueStringList(...lists) {
  return Array.from(
    new Set(
      lists
        .flatMap((list) => Array.isArray(list) ? list : [])
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    ),
  );
}

function mergeDuplicateAssetCandidate(existingItem, candidate = {}) {
  const updatedAt = Date.now();
  return normalizeAssetLibraryItem({
    ...existingItem,
    folderId: String(candidate.folderId || existingItem.folderId || 'root').trim() || 'root',
    width: Number(existingItem.width || 0) || Number(candidate.width || 0) || undefined,
    height: Number(existingItem.height || 0) || Number(candidate.height || 0) || undefined,
    duration: Number(existingItem.duration || 0) || Number(candidate.duration || 0) || undefined,
    prompt: typeof existingItem.prompt === 'string' && existingItem.prompt.trim()
      ? existingItem.prompt
      : (typeof candidate.prompt === 'string' ? candidate.prompt.trim() : undefined),
    sourceUrl: String(existingItem.sourceUrl || candidate.sourceUrl || '').trim(),
    tags: mergeUniqueStringList(existingItem.tags, candidate.tags),
    smartCategories: mergeUniqueStringList(existingItem.smartCategories, candidate.smartCategories),
    updatedAt,
  });
}

async function readAssetLibrarySettings() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(ASSET_LIBRARY_SETTINGS_FILE, 'utf8');
    const normalized = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = JSON.parse(normalized);
    const storagePath = String(parsed?.storagePath || '').trim();
    return {
      storagePath: storagePath ? path.resolve(storagePath) : DEFAULT_ASSET_LIBRARY_STORAGE_DIR,
    };
  } catch {
    return {
      storagePath: DEFAULT_ASSET_LIBRARY_STORAGE_DIR,
    };
  }
}

async function writeAssetLibrarySettings(storagePath) {
  const resolvedPath = path.resolve(String(storagePath || DEFAULT_ASSET_LIBRARY_STORAGE_DIR));
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(resolvedPath, { recursive: true });
  await fs.writeFile(ASSET_LIBRARY_SETTINGS_FILE, JSON.stringify({
    storagePath: resolvedPath,
    updatedAt: Date.now(),
  }, null, 2), 'utf8');
  return {
    storagePath: resolvedPath,
  };
}

// P1-2: Windows 原生 FolderBrowserDialog 目录选择
async function pickLocalDirectoryWindows(preferredPath = '') {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$utf8NoBom = New-Object System.Text.UTF8Encoding($false)',
    '[Console]::InputEncoding = $utf8NoBom',
    '[Console]::OutputEncoding = $utf8NoBom',
    '$OutputEncoding = $utf8NoBom',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    '$dialog.Description = "选择资产库存储目录',
    '$dialog.ShowNewFolderButton = $true',
    `$initialPath = '${escapePowerShellSingleQuoted(preferredPath)}'`,
    'if ($initialPath -and (Test-Path -LiteralPath $initialPath -PathType Container)) {',
    '  $resolved = (Resolve-Path -LiteralPath $initialPath | Select-Object -First 1).Path',
    '  if ($resolved) { $dialog.SelectedPath = $resolved }',
    '}',
    '$result = $dialog.ShowDialog()',
    '$payload = if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) {',
    '  @{ success = $true; canceled = $false; path = $dialog.SelectedPath }',
    '} else {',
    '  @{ success = $true; canceled = $true; path = "" }',
    '}',
    '$dialog.Dispose()',
    '$payload | ConvertTo-Json -Compress',
  ].join('; ');

  const { stdout } = await runCommand('powershell', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script]);
  const parsed = JSON.parse(String(stdout || '{}').trim() || '{}');
  return {
    canceled: Boolean(parsed?.canceled),
    path: parsed?.path ? path.resolve(String(parsed.path)) : '',
  };
}

// P1-2: macOS 原生目录选择（osascript choose folder）
async function pickLocalDirectoryMac(preferredPath = '') {
  const lines = ['on run', 'try'];
  const trimmed = String(preferredPath || '').trim();
  if (trimmed && existsSync(trimmed)) {
    // 用 AppleScript 字符串字面量转义（\ 与 "）指定默认目录
    const escaped = trimmed.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    lines.push(`set chosen to POSIX path of (choose folder with prompt "选择资产库存储目录" default location (POSIX file "${escaped}"))`);
  } else {
    lines.push('set chosen to POSIX path of (choose folder with prompt "选择资产库存储目录")');
  }
  lines.push('return "OK:" & chosen', 'on error errMsg number errNum', 'return "CANCELED:" & errNum', 'end try', 'end run');
  const script = lines.join('\n');
  try {
    const { stdout } = await runCommand('osascript', ['-e', script]);
    const out = String(stdout || '').trim();
    if (out.startsWith('OK:')) {
      const picked = out.slice(3).trim();
      return { canceled: !picked, path: picked ? path.resolve(picked) : '' };
    }
    // CANCELED:* 或空输出都视为取消
    return { canceled: true, path: '' };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error || '');
    // osascript 用户取消返回 -128；其它错误同样降级为取消，避免打断前端
    if (message.includes('-128') || /user\s*cancel/i.test(message)) {
      return { canceled: true, path: '' };
    }
    return { canceled: true, path: '' };
  }
}

// P1-2: Linux 目录选择（优先 zenity，其次 kdialog，均无则提示手动输入路径）
async function pickLocalDirectoryLinux(preferredPath = '') {
  const trimmed = String(preferredPath || '').trim();
  // zenity
  try {
    const args = ['--file-selection', '--directory', '--title=选择资产库存储目录'];
    if (trimmed && existsSync(trimmed)) args.push(`--filename=${trimmed.replace(/\/?$/, '/')}`);
    const { stdout } = await runCommand('zenity', args);
    const picked = String(stdout || '').trim();
    return { canceled: !picked, path: picked ? path.resolve(picked) : '' };
  } catch (error) {
    const msg = String(error instanceof Error ? error.message : error || '');
    // zenity 取消退出码为 1（无 stderr 详情）；若确为取消则返回 canceled
    if (/exited 1:/.test(msg) && !/not found|ENOENT/i.test(msg)) {
      return { canceled: true, path: '' };
    }
  }
  // kdialog 兜底
  try {
    const args = ['--getexistingdirectory', trimmed && existsSync(trimmed) ? trimmed : os.homedir()];
    const { stdout } = await runCommand('kdialog', args);
    const picked = String(stdout || '').trim();
    return { canceled: !picked, path: picked ? path.resolve(picked) : '' };
  } catch {
    /* 无图形选择器可用 */
  }
  throw new Error('No native directory picker available on this Linux desktop. Please type the target path manually.');
}

async function pickLocalDirectory(initialPath = '', autoSelectPath = '') {
  const platformInfo = buildPlatformInfo();
  // 自动化/内联路径在所有平台通用（提前处理，修复此前非 Windows 无法自动选路径的问题）
  const automationPath = String(autoSelectPath || '').trim();
  if (automationPath) {
    return {
      canceled: false,
      path: path.resolve(automationPath),
    };
  }
  const preferredPath = String(initialPath || '').trim();
  const inlineAutomationMatch = preferredPath.match(/^__HMDAO_AUTO_PICK__:(.+)$/);
  if (inlineAutomationMatch?.[1]) {
    return {
      canceled: false,
      path: path.resolve(String(inlineAutomationMatch[1]).trim()),
    };
  }

  if (platformInfo.isWindows) {
    return await pickLocalDirectoryWindows(preferredPath);
  }
  if (platformInfo.isMac) {
    return await pickLocalDirectoryMac(preferredPath);
  }
  return await pickLocalDirectoryLinux(preferredPath);
}

async function readAssetLibraryCatalog() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(ASSET_LIBRARY_CATALOG_FILE, 'utf8');
    const normalized = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = JSON.parse(normalized);
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    return items.map((item) => normalizeAssetLibraryItem(item));
  } catch {
    return [];
  }
}

async function writeAssetLibraryCatalog(items) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(ASSET_LIBRARY_CATALOG_FILE, JSON.stringify({
    version: 1,
    updatedAt: Date.now(),
    items,
  }, null, 2), 'utf8');
  return items;
}

async function upsertAssetLibraryItem(item) {
  const nextItem = normalizeAssetLibraryItem(item);
  const items = await readAssetLibraryCatalog();
  const nextItems = [...items.filter((entry) => entry.id !== nextItem.id), nextItem]
    .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
  await writeAssetLibraryCatalog(nextItems);
  return nextItem;
}

// 资产回收站：删除时把物理文件移入 trash 目录（而非直接销毁），
// 供撤销时通过 /api/assets/restore 找回，实现「云端文件找回」。
const ASSET_LIBRARY_TRASH_DIR = path.join(DATA_DIR, 'asset-trash');
// 去重结果持久化缓存文件：服务端去重分组在此落盘，供去重看板常驻视图读取。
const ASSET_LIBRARY_DUPLICATES_FILE = path.join(DATA_DIR, 'asset-duplicates.json');

// 将去重分组写入缓存文件（覆盖式）。分组结构：{ canonicalId, type, name, contentHash, duplicateIds }。
async function writeAssetLibraryDuplicates(groups = []) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(
    ASSET_LIBRARY_DUPLICATES_FILE,
    JSON.stringify({ version: 1, updatedAt: Date.now(), groups: Array.isArray(groups) ? groups : [] }, null, 2),
    'utf8',
  );
}

async function readAssetLibraryDuplicates() {
  try {
    const text = await fs.readFile(ASSET_LIBRARY_DUPLICATES_FILE, 'utf8');
    const parsed = JSON.parse(text);
    return Array.isArray(parsed?.groups) ? parsed.groups : [];
  } catch {
    return [];
  }
}

// 探测素材媒体是否可被解码：文件缺失/损坏返回对应状态，正常返回可转码标记。
function resolveFfprobePath() {
  const base = String(process.env.HMDAO_FFMPEG_PATH || 'ffmpeg').trim() || 'ffmpeg';
  if (base.endsWith('ffmpeg')) return `${base.slice(0, -'ffmpeg'.length)}ffprobe`;
  return 'ffprobe';
}

async function probeAssetMedia(filePath) {
  const source = String(filePath || '');
  if (!source) return { ok: false, state: 'missing' };
  try {
    await fs.access(source, fs.constants.F_OK);
  } catch {
    return { ok: false, state: 'missing' };
  }
  const ffprobe = resolveFfprobePath();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const child = spawn(ffprobe, [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name',
      '-of', 'json',
      source,
    ]);
    child.stderr.on('data', () => {});
    child.on('error', () => finish({ ok: false, state: 'corrupted', detail: 'probe-spawn-failed' }));
    child.on('close', (code) => {
      if (code !== 0) return finish({ ok: false, state: 'corrupted', detail: `ffprobe-exit-${code}` });
      finish({ ok: true, state: 'ok', canTranscode: true });
    });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish({ ok: false, state: 'corrupted', detail: 'probe-timeout' });
    }, 20000);
    if (timer.unref) timer.unref();
  });
}

// 修复（转码）：把不可在浏览器直接预览、但可被解码的素材转成标准格式
// （视频→H.264/AAC 的 mp4，图片→png），原地替换文件并更新目录元数据。
async function repairAssetLibraryItem(item) {
  const filePath = String(item.filePath || '');
  if (!filePath) throw new Error('asset-has-no-file');
  const type = String(item.type || '');
  const dir = path.dirname(filePath);
  const ext = type === 'video' ? 'mp4' : 'png';
  const outPath = path.join(dir, `${item.backendAssetId || item.id}-repaired.${ext}`);
  const ffmpegPath = String(process.env.HMDAO_FFMPEG_PATH || 'ffmpeg').trim() || 'ffmpeg';
  const args = type === 'video'
    ? ['-y', '-i', filePath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-c:a', 'aac', '-movflags', '+faststart', outPath]
    : ['-y', '-i', filePath, outPath];
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (!settled) {
        settled = true;
        if (error) reject(error);
        else resolve();
      }
    };
    const child = spawn(ffmpegPath, args);
    child.stderr.on('data', () => {});
    child.on('error', () => finish(new Error('ffmpeg-spawn-failed')));
    child.on('close', (code) => finish(code === 0 ? null : new Error(`ffmpeg-exit-${code}`)));
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish(new Error('ffmpeg-timeout'));
    }, 120000);
    if (timer.unref) timer.unref();
  });
  const probe = await probeAssetMedia(outPath);
  if (!probe.ok) throw new Error('repaired-file-invalid');
  // 仅在转码产物验证通过后，用新文件覆盖原文件（先 copy 成功再替换，避免原文件丢失）
  try {
    await fs.rename(outPath, filePath);
  } catch {
    await fs.copyFile(outPath, filePath);
    await fs.rm(outPath, { force: true }).catch(() => {});
  }
  const stat = await fs.stat(filePath).catch(() => null);
  const size = stat ? stat.size : Number(item.size || 0);
  const contentHash = await computeAssetContentHash(filePath, {
    type,
    duration: Number(item.duration || 0) || 0,
  });
  return { filePath, size, contentHash };
}

async function moveFileToTrash(filePath, assetId) {
  const source = String(filePath || '');
  if (!source) return;
  const base = path.basename(source);
  const trashDir = path.join(ASSET_LIBRARY_TRASH_DIR, String(assetId || ''));
  await fs.mkdir(trashDir, { recursive: true });
  const target = path.join(trashDir, base);
  try {
    await fs.rename(source, target);
  } catch {
    // 跨盘/占用时回退 copy + unlink
    await fs.copyFile(source, target).catch(() => {});
    await fs.rm(source, { force: true }).catch(() => {});
  }
}

async function deleteAssetLibraryItems(assetIds = []) {
  const ids = new Set(assetIds.map((item) => String(item || '').trim()).filter(Boolean));
  if (!ids.size) return [];
  const items = await readAssetLibraryCatalog();
  const deletedItems = items.filter((item) => ids.has(String(item.id || '')));
  await fs.mkdir(ASSET_LIBRARY_TRASH_DIR, { recursive: true }).catch(() => {});
  await Promise.all(
    deletedItems.map(async (item) => {
      // 引用型素材未复制原文件，删除时不动物理文件
      if (String(item.storageLabel || '').trim().toLowerCase() === 'reference') {
        return;
      }
      const filePath = String(item.filePath || '');
      if (!filePath) return;
      try {
        await moveFileToTrash(filePath, String(item.id || ''));
      } catch {
        // 软删除失败时回退硬删除，保证删除语义不被破坏
        await fs.rm(filePath, { force: true }).catch(() => {});
      }
    }),
  );
  const nextItems = items.filter((item) => !ids.has(String(item.id || '')));
  await writeAssetLibraryCatalog(nextItems);
  return deletedItems.map((item) => String(item.id || ''));
}

// 清理陈旧的素材引用：catalog 中存在、但本地文件已不存在的 disk 型条目（文件被删除/移动）
// 会导致 /api/assets/content/<id> 返回 404。此函数扫描并移除这些死引用，避免前端反复请求 404。
async function pruneMissingAssetLibraryItems() {
  const items = await readAssetLibraryCatalog();
  const removed = [];
  const kept = [];
  for (const item of items) {
    const isReference = String(item.storageLabel || '').trim().toLowerCase() === 'reference';
    const filePath = String(item.filePath || '');
    if (isReference) {
      kept.push(item);
      continue;
    }
    // 引用型或仅 URL 的条目不按本地文件存在性判定
    if (!filePath || /^https?:\/\//i.test(filePath)) {
      kept.push(item);
      continue;
    }
    const exists = await fs.access(filePath).then(() => true).catch(() => false);
    if (exists) kept.push(item);
    else removed.push(item);
  }
  if (removed.length) {
    await writeAssetLibraryCatalog(kept);
  }
  return {
    removedCount: removed.length,
    removedIds: removed.map((item) => String(item.id || '')),
    keptCount: kept.length,
  };
}

// 撤销找回：把回收站里的文件移回原路径，并将目录项写回 catalog。
async function restoreAssetLibraryItems(inputItems = []) {
  const list = Array.isArray(inputItems) ? inputItems : [];
  if (!list.length) return [];
  const catalog = await readAssetLibraryCatalog();
  const byId = new Map(catalog.map((item) => [String(item.id || ''), item]));
  const restored = [];
  for (const raw of list) {
    const id = String(raw?.id || '').trim();
    if (!id) continue;
    const label = String(raw?.storageLabel || '').trim().toLowerCase();
    const filePath = String(raw?.filePath || '');
    if (label !== 'reference' && filePath) {
      const base = path.basename(filePath);
      const trashPath = path.join(ASSET_LIBRARY_TRASH_DIR, id, base);
      try {
        await fs.access(trashPath);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        try {
          await fs.rename(trashPath, filePath);
        } catch {
          await fs.copyFile(trashPath, filePath).catch(() => {});
          await fs.rm(trashPath, { force: true }).catch(() => {});
        }
        await fs.rm(path.join(ASSET_LIBRARY_TRASH_DIR, id), { recursive: true, force: true }).catch(() => {});
      } catch {
        // 回收站中无对应文件（可能已被清理），仅恢复目录项
      }
    }
    try {
      byId.set(id, normalizeAssetLibraryItem(raw));
      restored.push(id);
    } catch {
      // 跳过无法规范化的条目
    }
  }
  const nextItems = Array.from(byId.values()).sort(
    (left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0),
  );
  await writeAssetLibraryCatalog(nextItems);
  return restored;
}

async function findAssetLibraryItem(assetId) {
  const items = await readAssetLibraryCatalog();
  return items.find((item) => String(item.id || '') === String(assetId || '')) || null;
}

async function collectLocalAssetImportFiles(directoryPath) {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const fullPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...await collectLocalAssetImportFiles(fullPath));
      continue;
    }
    if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

async function probeAssetImportMeta(filePath, type) {
  try {
    if (type === 'video') return await probeVideoFile(filePath);
    if (type === 'image') return await probeImageFile(filePath);
    if (type === 'audio') {
      const audioMeta = await probeAudioFile(filePath);
      return {
        width: 0,
        height: 0,
        duration: Number(audioMeta.duration || 0) || 0,
      };
    }
  } catch {
    // Ignore probe failures and fall back to a metadata-light import.
  }
  return {
    width: 0,
    height: 0,
    duration: 0,
  };
}

async function processAssetLibraryImportDirectory(options = {}) {
  const folderId = String(options.folderId || 'root').trim() || 'root';
  const initialPath = String(options.initialPath || '').trim();
  const autoSelectPath = String(options.autoSelectPath || '').trim();
  const settings = await readAssetLibrarySettings();
  const picked = await pickLocalDirectory(initialPath || settings.storagePath || DEFAULT_ASSET_LIBRARY_STORAGE_DIR, autoSelectPath);
  if (picked.canceled || !picked.path) {
    return {
      canceled: true,
      path: '',
      items: [],
      report: {
        importedCount: 0,
        failedCount: 0,
        skippedCount: 0,
        duplicateCount: 0,
        folderImport: true,
        imageCount: 0,
        videoCount: 0,
        audioCount: 0,
        textCount: 0,
        autoTaggedCount: 0,
        autoClassifiedCount: 0,
      },
    };
  }

  const importFiles = await collectLocalAssetImportFiles(picked.path);
  const items = [];
  const report = {
    importedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    duplicateCount: 0,
    folderImport: true,
    imageCount: 0,
    videoCount: 0,
    audioCount: 0,
    textCount: 0,
    autoTaggedCount: 0,
    autoClassifiedCount: 0,
  };

  for (const filePath of importFiles) {
    const type = inferSupportedImportAssetType(filePath, mediaMimeTypeFromExtension(filePath, ''));
    if (!type) {
      report.skippedCount += 1;
      continue;
    }
    try {
      const hints = inferAssetImportHints(filePath, type, picked.path);
      const meta = await probeAssetImportMeta(filePath, type);
      const result = await processAssetLibraryImportRequest({
        name: path.basename(filePath),
        originalName: path.basename(filePath),
        folderId,
        type,
        tags: hints.tags,
        smartCategories: hints.smartCategories,
        sourceUrl: hints.relativePath || path.basename(filePath),
        inputPath: filePath,
        inputMimeType: mediaMimeTypeFromExtension(filePath, 'application/octet-stream'),
        width: Number(meta.width || 0) || 0,
        height: Number(meta.height || 0) || 0,
        duration: Number(meta.duration || 0) || 0,
        referenceSourceFile: true,
      });
      items.push(result.item);
      if (result.duplicate) {
        report.duplicateCount += 1;
      } else {
        report.importedCount += 1;
      }
      report.autoTaggedCount += hints.tags.length > 0 ? 1 : 0;
      report.autoClassifiedCount += hints.smartCategories.length > 0 ? 1 : 0;
      if (type === 'image') report.imageCount += 1;
      if (type === 'video') report.videoCount += 1;
      if (type === 'audio') report.audioCount += 1;
      if (type === 'text') report.textCount += 1;
    } catch {
      report.failedCount += 1;
    }
  }

  return {
    canceled: false,
    path: picked.path,
    items,
    report,
  };
}
  return {
    sanitizeAssetFileBaseName,
    inferAssetTypeFromMime,
    inferAssetTypeFromPath,
    inferSupportedImportAssetType,
    normalizeAssetImportToken,
    classifyAssetImportText,
    inferAssetImportFolderSegments,
    inferAssetImportHints,
    buildAssetLibraryContentUrl,
    normalizeAssetLibraryItem,
    normalizeAssetDuplicateValue,
    buildAssetDuplicateFingerprint,
    findDuplicateAssetLibraryItem,
    mergeUniqueStringList,
    mergeDuplicateAssetCandidate,
    readAssetLibrarySettings,
    writeAssetLibrarySettings,
    pickLocalDirectoryWindows,
    pickLocalDirectoryMac,
    pickLocalDirectoryLinux,
    pickLocalDirectory,
    readAssetLibraryCatalog,
    writeAssetLibraryCatalog,
    upsertAssetLibraryItem,
    writeAssetLibraryDuplicates,
    readAssetLibraryDuplicates,
    resolveFfprobePath,
    probeAssetMedia,
    repairAssetLibraryItem,
    moveFileToTrash,
    deleteAssetLibraryItems,
    pruneMissingAssetLibraryItems,
    restoreAssetLibraryItems,
    findAssetLibraryItem,
    collectLocalAssetImportFiles,
    probeAssetImportMeta,
    processAssetLibraryImportDirectory,
    ASSET_IMPORT_CATEGORY_RULES,
    ASSET_LIBRARY_TRASH_DIR,
    ASSET_LIBRARY_DUPLICATES_FILE,
  };
}
